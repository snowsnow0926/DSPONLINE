import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import {
  PURE_IDLE_MACRO_OPERATION_DEADLINE_MS,
  type PureIdleMacroMode,
  type PureIdleMacroSummary,
} from "./pureIdleMacro";
import type { PureIdleMacroWorkerRequest, PureIdleMacroWorkerResponse } from "./pureIdleMacro.worker";
import type { GameState } from "./types";
import { decodeVerifiedSaveTransfer, type SaveTransferVerification } from "./saveTransfer";
import { parseTrustedWorkerEnvelope } from "./storage";

export interface PureIdleMacroFinalResult {
  state: GameState;
  summary: PureIdleMacroSummary;
  rawBytes: number;
  durationMs: number;
}

export type PureIdleMacroProgress = Extract<PureIdleMacroWorkerResponse, { type: "progress" }>;
export type PureIdleMacroClientFailureCode = "deadline" | "worker-crash" | "operation" | "closed";

export class PureIdleMacroClientError extends Error {
  constructor(public readonly code: PureIdleMacroClientFailureCode, message: string) {
    super(message);
    this.name = "PureIdleMacroClientError";
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

export class PureIdleMacroClient {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private closed = false;
  private readonly onProgress?: (progress: PureIdleMacroProgress) => void;
  private readonly operationDeadlineMs: number;

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
        request.reject(new PureIdleMacroClientError("operation", event.data.message));
        return;
      }
      request.resolve(event.data);
    };
    this.worker.onerror = () => this.failAll(
      new PureIdleMacroClientError("worker-crash", "纯挂机 Worker 崩溃，恢复日志仍保持有效"),
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
    options: { signal?: AbortSignal; deadlineMs?: number; forceConservativeReason?: string } = {},
  ): Promise<PureIdleMacroSummary> {
    const response = await this.request({
      type: "initialize",
      state,
      mode,
      registry,
      forceConservativeReason: options.forceConservativeReason,
    }, options);
    if (response.type !== "ready") throw new PureIdleMacroClientError("operation", "纯挂机 Worker 没有返回校准结果");
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

  async finalize(
    targetWallSeconds: number,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<PureIdleMacroFinalResult> {
    const response = await this.request({ type: "finalize", targetWallSeconds }, options);
    if (response.type !== "finalized") throw new PureIdleMacroClientError("operation", "纯挂机 Worker 没有返回最终存档");
    const verification: SaveTransferVerification = {
      integrity: "valid",
      stateChecksum: response.stateChecksum,
      payloadChecksum: response.payloadChecksum,
      byteLength: response.byteLength,
    };
    const raw = decodeVerifiedSaveTransfer(response.payloadBytes, verification);
    const state = parseTrustedWorkerEnvelope(raw, verification, undefined, { persistentProjection: false });
    if (state.version !== response.stateVersion || state.mode !== response.mode || state.entities.length !== response.entityCount) {
      throw new PureIdleMacroClientError("operation", "纯挂机 Worker 结果摘要与重载状态不一致");
    }
    return {
      state,
      summary: response.summary,
      rawBytes: response.rawBytes,
      durationMs: response.durationMs,
    };
  }

  cancel(message = "纯挂机计算已取消"): void {
    this.failAll(new DOMException(`${message}，原存档保持不变`, "AbortError"), true);
  }

  close(): void {
    this.failAll(new PureIdleMacroClientError("closed", "纯挂机 Worker 已终止"));
  }
}
