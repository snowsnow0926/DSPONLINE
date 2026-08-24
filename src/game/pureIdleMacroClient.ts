import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import {
  PURE_IDLE_MACRO_OPERATION_DEADLINE_MS,
  type PureIdleMacroFinalStateOptions,
  type PureIdleMacroMode,
  type PureIdleMacroSummary,
} from "./pureIdleMacro";
import type {
  PureIdleMacroFinalEnvelopeTransfer,
  PureIdleMacroFinalizedIdentity,
  PureIdleMacroWorkerRequest,
  PureIdleMacroWorkerResponse,
} from "./pureIdleMacroProtocol";
import type { GameState, IdleSettlementState, ItemId } from "./types";
import { decodeVerifiedSaveTransfer } from "./saveTransfer";
import { parseTrustedWorkerEnvelope } from "./storage";
import {
  isWorkerBinaryPayload,
  workerBinaryPayloadByteLength,
  workerBinaryPayloadToArrayBuffer,
} from "./workerBinaryPayload";
import type { WorkerBinaryPayload } from "./workerBinaryPayload";

export interface PureIdleMacroFinalResult {
  state: GameState;
  finalEnvelope: PureIdleMacroFinalEnvelopeTransfer<WorkerBinaryPayload>;
  summary: PureIdleMacroSummary;
  rawBytes: number;
  durationMs: number;
}

export interface PureIdleMacroFinalEnvelopeResult {
  summary: PureIdleMacroSummary;
  finalEnvelope: PureIdleMacroFinalEnvelopeTransfer<WorkerBinaryPayload>;
  rawBytes: number;
  durationMs: number;
}

export type { PureIdleMacroFinalEnvelopeTransfer, PureIdleMacroFinalizedIdentity } from "./pureIdleMacroProtocol";

export type PureIdleMacroProgress = Extract<PureIdleMacroWorkerResponse, { type: "progress" }>;
export type PureIdleMacroClientFailureCode = "deadline" | "worker-crash" | "operation" | "closed";

export class PureIdleMacroClientError extends Error {
  public readonly recoverable: boolean;
  public readonly finalEnvelope?: PureIdleMacroFinalEnvelopeTransfer<WorkerBinaryPayload>;

  constructor(
    public readonly code: PureIdleMacroClientFailureCode,
    message: string,
    options: { recoverable?: boolean; finalEnvelope?: PureIdleMacroFinalEnvelopeTransfer<WorkerBinaryPayload> } = {},
  ) {
    super(message);
    this.name = "PureIdleMacroClientError";
    this.recoverable = options.recoverable ?? false;
    this.finalEnvelope = options.finalEnvelope;
  }
}

interface PendingRequest {
  operation: WorkRequest["type"];
  timer: number;
  abortCleanup?: () => void;
  resolve: (response: PureIdleMacroWorkerResponse) => void;
  reject: (error: Error) => void;
}

type WorkRequest = Exclude<PureIdleMacroWorkerRequest, { type: "cancel" }>;
type PureIdleMacroWorkerRequestInput = WorkRequest extends infer Request
  ? Request extends { id: number } ? Omit<Request, "id"> : never
  : never;

export interface PureIdleMacroClientOptions {
  onProgress?: (progress: PureIdleMacroProgress) => void;
  operationDeadlineMs?: number;
}

export interface PureIdleMacroFinalizeOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  terminal?: boolean;
  binaryTransport?: "array-buffer" | "blob";
}

export interface PureIdleMacroInitializeOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  forceConservativeReason?: string;
  startedPaused?: boolean;
  baselineIdleSettlement?: IdleSettlementState;
  baselineTotalProduced?: Partial<Record<ItemId, number>>;
  /** Internal convenience shape; the wire request remains three flat fields. */
  terminalState?: PureIdleMacroFinalStateOptions;
}

export class PureIdleMacroClient {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private closed = false;
  private readonly onProgress?: (progress: PureIdleMacroProgress) => void;
  private readonly operationDeadlineMs: number;
  private initializedRegistryFingerprint: string | null = null;

  constructor(options: PureIdleMacroClientOptions = {}) {
    this.onProgress = options.onProgress;
    this.operationDeadlineMs = Math.max(1_000, options.operationDeadlineMs ?? PURE_IDLE_MACRO_OPERATION_DEADLINE_MS);
    this.worker = new Worker(new URL("./pureIdleMacro.worker.ts", import.meta.url), {
      type: "module",
      name: "pure-idle-macro",
    });
    this.worker.onmessage = (event: MessageEvent<PureIdleMacroWorkerResponse>) => {
      if (event.data.type === "progress") {
        if (this.pending.has(event.data.id)) this.onProgress?.(event.data);
        return;
      }
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.clearPending(event.data.id, request);
      if (event.data.type === "cancelled") {
        request.reject(new DOMException("纯挂机计算已取消，原存档保持不变", "AbortError"));
        return;
      }
      if (event.data.type === "error") {
        request.reject(new PureIdleMacroClientError("operation", event.data.message, {
          recoverable: event.data.recoverable,
        }));
        return;
      }
      request.resolve(event.data);
    };
    this.worker.onerror = () => this.failAll(
      new PureIdleMacroClientError("worker-crash", "纯挂机 Worker 崩溃，恢复日志仍保持有效", { recoverable: true }),
    );
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  private clearPending(id: number, request: PendingRequest): void {
    this.pending.delete(id);
    window.clearTimeout(request.timer);
    request.abortCleanup?.();
  }

  private failAll(error: Error, sendCancel = false): void {
    if (this.closed) return;
    this.closed = true;
    if (sendCancel) {
      for (const id of this.pending.keys()) {
        try {
          this.worker.postMessage({ type: "cancel", id: ++this.nextId, targetId: id } satisfies PureIdleMacroWorkerRequest);
        } catch {
          // The Worker may already be blocked or terminated.
        }
      }
    }
    this.worker.terminate();
    for (const [id, request] of this.pending) {
      this.clearPending(id, request);
      request.reject(error);
    }
  }

  private request(
    request: PureIdleMacroWorkerRequestInput,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<PureIdleMacroWorkerResponse> {
    if (this.closed) return Promise.reject(new PureIdleMacroClientError("closed", "纯挂机 Worker 已关闭"));
    const id = ++this.nextId;
    const deadlineMs = Math.max(1_000, options.deadlineMs ?? this.operationDeadlineMs);
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel("玩家已取消纯挂机计算");
      if (options.signal?.aborted) {
        reject(new DOMException("纯挂机计算已取消，原存档保持不变", "AbortError"));
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = window.setTimeout(() => {
        this.failAll(new PureIdleMacroClientError(
          "deadline",
          `${request.type === "initialize" ? "启动校准" : request.type === "advance" ? "宏观结算" : "停止校验"}达到现实时间上限`,
          { recoverable: true },
        ), true);
      }, deadlineMs + 250);
      this.pending.set(id, {
        operation: request.type,
        timer,
        ...(options.signal ? { abortCleanup: () => options.signal?.removeEventListener("abort", abort) } : {}),
        resolve,
        reject,
      });
      try {
        this.worker.postMessage({ ...request, id, deadlineMs } as PureIdleMacroWorkerRequest);
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) this.clearPending(id, pending);
        reject(error instanceof Error ? error : new PureIdleMacroClientError("operation", "无法向纯挂机 Worker 发送任务"));
      }
    });
  }

  async initialize(
    state: GameState,
    mode: PureIdleMacroMode,
    registry: ContentPackRuntimeSnapshot,
    options: PureIdleMacroInitializeOptions = {},
  ): Promise<PureIdleMacroSummary> {
    this.initializedRegistryFingerprint = null;
    const terminalState = options.terminalState ?? normalizeTerminalStateOptions(options);
    const response = await this.request({
      type: "initialize",
      state,
      mode,
      registry,
      forceConservativeReason: options.forceConservativeReason,
      ...(terminalState ? {
        startedPaused: terminalState.startedPaused,
        baselineIdleSettlement: terminalState.baselineIdleSettlement,
        baselineTotalProduced: terminalState.baselineTotalProduced,
      } : {}),
    }, options);
    if (response.type !== "ready") throw new PureIdleMacroClientError("operation", "纯挂机 Worker 没有返回校准结果");
    this.initializedRegistryFingerprint = registry.fingerprint;
    return response.summary;
  }

  async advance(
    targetWallSeconds: number,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<PureIdleMacroSummary> {
    const response = await this.request({ type: "advance", targetWallSeconds }, options);
    if (response.type !== "advanced") throw new PureIdleMacroClientError("operation", "纯挂机 Worker 没有返回宏观结算摘要");
    return response.summary;
  }

  async finalizeEnvelope(
    targetWallSeconds: number,
    options: PureIdleMacroFinalizeOptions = {},
  ): Promise<PureIdleMacroFinalEnvelopeResult> {
    const response = await this.request({
      type: "finalize",
      targetWallSeconds,
      ...(options.terminal ? { terminal: true } : {}),
      ...(options.binaryTransport ? { binaryTransport: options.binaryTransport } : {}),
    }, options);
    if (response.type !== "finalized") throw new PureIdleMacroClientError("operation", "纯挂机 Worker 没有返回最终存档");
    const finalEnvelope = validatedFinalEnvelopeProtocol(
      response.finalEnvelope,
      response.summary,
      this.initializedRegistryFingerprint,
    );
    return {
      summary: response.summary,
      finalEnvelope,
      rawBytes: finalEnvelope.verification.byteLength,
      durationMs: response.durationMs,
    };
  }

  async finalize(
    targetWallSeconds: number,
    options: PureIdleMacroFinalizeOptions = {},
  ): Promise<PureIdleMacroFinalResult> {
    const result = await this.finalizeEnvelope(targetWallSeconds, options);
    const { finalEnvelope } = result;
    let raw: string;
    try {
      raw = decodeVerifiedSaveTransfer(
        await workerBinaryPayloadToArrayBuffer(finalEnvelope.payloadBytes),
        finalEnvelope.verification,
      );
    } catch (error) {
      throw new PureIdleMacroClientError(
        "operation",
        error instanceof Error ? error.message : "纯挂机 Worker 最终存档字节校验失败",
      );
    }
    try {
      const state = parseTrustedWorkerEnvelope(raw, finalEnvelope.verification);
      const identityMismatch = finalizedIdentityMismatch(state, finalEnvelope.identity);
      if (identityMismatch ||
        result.summary.algorithmVersion !== finalEnvelope.identity.algorithmVersion ||
        result.summary.settledWallSeconds !== finalEnvelope.identity.settledWallSeconds ||
        result.summary.settledSimulationSeconds !== finalEnvelope.identity.settledSimulationSeconds) {
        throw new Error(`纯挂机 Worker 结果摘要与重载状态不一致${identityMismatch ? `（${identityMismatch}）` : ""}`);
      }
      return {
        state,
        ...result,
      };
    } catch (error) {
      throw new PureIdleMacroClientError(
        "operation",
        error instanceof Error ? error.message : "纯挂机 Worker 最终存档无法重载",
        { recoverable: true, finalEnvelope },
      );
    }
  }

  cancel(message = "纯挂机计算已取消"): void {
    this.failAll(new DOMException(`${message}，原存档保持不变`, "AbortError"), true);
  }

  close(): void {
    this.failAll(new PureIdleMacroClientError("closed", "纯挂机 Worker 已终止"));
  }
}

function validChecksum(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}$/.test(value);
}

function normalizeTerminalStateOptions(
  options: PureIdleMacroInitializeOptions,
): PureIdleMacroFinalStateOptions | undefined {
  const hasTerminalState = options.startedPaused !== undefined ||
    options.baselineIdleSettlement !== undefined || options.baselineTotalProduced !== undefined;
  if (!hasTerminalState) return undefined;
  if (typeof options.startedPaused !== "boolean" || !options.baselineIdleSettlement ||
    !options.baselineTotalProduced) {
    throw new PureIdleMacroClientError("operation", "纯挂机 initialize 终止态基线不完整");
  }
  return {
    startedPaused: options.startedPaused,
    baselineIdleSettlement: options.baselineIdleSettlement,
    baselineTotalProduced: options.baselineTotalProduced,
  };
}

function validatedFinalEnvelopeProtocol(
  finalEnvelope: PureIdleMacroFinalEnvelopeTransfer<WorkerBinaryPayload>,
  summary: PureIdleMacroSummary,
  initializedRegistryFingerprint: string | null,
): PureIdleMacroFinalEnvelopeTransfer<WorkerBinaryPayload> {
  const verification = finalEnvelope?.verification;
  const identity = finalEnvelope?.identity;
  if (!summary || typeof summary.algorithmVersion !== "string" || summary.algorithmVersion.length === 0 ||
    !Number.isFinite(summary.settledWallSeconds) || summary.settledWallSeconds < 0 ||
    !Number.isFinite(summary.settledSimulationSeconds) || summary.settledSimulationSeconds < 0 ||
    !isWorkerBinaryPayload(finalEnvelope?.payloadBytes) || verification?.integrity !== "valid" ||
    !Number.isSafeInteger(verification.byteLength) || verification.byteLength < 0 ||
    verification.byteLength !== workerBinaryPayloadByteLength(finalEnvelope.payloadBytes) ||
    !validChecksum(verification.payloadChecksum) || !validChecksum(verification.stateChecksum) ||
    !identity || identity.stateChecksum !== verification.stateChecksum ||
    !Number.isSafeInteger(identity.stateVersion) || identity.stateVersion <= 0 ||
    (identity.mode !== "normal" && identity.mode !== "speedrun") ||
    typeof identity.activePlanetId !== "string" || identity.activePlanetId.length === 0 ||
    !Number.isSafeInteger(identity.entityCount) || identity.entityCount < 0 ||
    !Number.isSafeInteger(identity.beltCount) || identity.beltCount < 0 ||
    !Number.isFinite(identity.elapsedSeconds) || identity.elapsedSeconds < 0 ||
    typeof identity.algorithmVersion !== "string" || identity.algorithmVersion.length === 0 ||
    !Number.isFinite(identity.settledWallSeconds) || identity.settledWallSeconds < 0 ||
    !Number.isFinite(identity.settledSimulationSeconds) || identity.settledSimulationSeconds < 0 ||
    typeof identity.registryFingerprint !== "string" || identity.registryFingerprint.length === 0 ||
    initializedRegistryFingerprint === null || identity.registryFingerprint !== initializedRegistryFingerprint ||
    summary.algorithmVersion !== identity.algorithmVersion ||
    summary.settledWallSeconds !== identity.settledWallSeconds ||
    summary.settledSimulationSeconds !== identity.settledSimulationSeconds) {
    throw new PureIdleMacroClientError("operation", "纯挂机 Worker 最终 envelope 回执不完整");
  }
  return finalEnvelope;
}

function finalizedIdentityMismatch(state: GameState, identity: PureIdleMacroFinalizedIdentity): string {
  const fields: string[] = [];
  if (state.version !== identity.stateVersion) fields.push("version");
  if (state.mode !== identity.mode) fields.push("mode");
  if (state.activePlanetId !== identity.activePlanetId) fields.push("activePlanetId");
  if (state.entities.length !== identity.entityCount) fields.push("entityCount");
  if (state.belts.length !== identity.beltCount) fields.push("beltCount");
  if (state.elapsedSeconds !== identity.elapsedSeconds) fields.push("elapsedSeconds");
  return fields.join(",");
}
