import type { SimulationRuntimeRecoveryBaseIdentity } from "./simulationRuntimeRecovery";
import type {
  SimulationRuntimeDurableCheckpoint,
  SimulationRuntimeDurablePrimaryCheckpoint,
} from "./simulationRuntimeDurableRecovery";
import type {
  SimulationRuntimeRecoveryAbsorbedIntent,
  SimulationRuntimeRecoveryClearResult,
  SimulationRuntimeRecoveryClearTarget,
  SimulationRuntimeRecoveryMutationResult,
  SimulationRuntimeRecoveryReadResult,
  SimulationRuntimeRecoveryWriterFence,
} from "./simulationRuntimeRecoveryStore";
import type {
  SimulationRuntimeRecoveryPersistenceProgress,
  SimulationRuntimeRecoveryPersistenceRequest,
  SimulationRuntimeRecoveryPersistenceResponse,
  SimulationRuntimeRecoveryUnsignedIntent,
} from "./simulationRuntimeRecoveryPersistenceProtocol";
import type {
  SimulationRuntimeRecoveryCheckpointCompressionMetrics,
  SimulationRuntimeRecoveryRawTransferCheckpoint,
} from "./simulationRuntimeRecoveryCheckpointCompression";

const SMALL_OPERATION_TIMEOUT_MS = 30_000;
const TRANSFER_CHECKPOINT_TIMEOUT_MS = 120_000;

export type SimulationRuntimeRecoveryProgressListener =
  (progress: SimulationRuntimeRecoveryPersistenceProgress) => void;

export type SimulationRuntimeRecoveryPersistenceClientFailureCode =
  | "unsupported"
  | "post-message"
  | "worker-operation"
  | "worker-crash"
  | "timeout"
  | "terminated"
  | "protocol";

export class SimulationRuntimeRecoveryPersistenceClientError extends Error {
  constructor(
    public readonly code: SimulationRuntimeRecoveryPersistenceClientFailureCode,
    message: string,
    public readonly ownershipLost: boolean,
    public readonly operation?: SimulationRuntimeRecoveryPersistenceRequest["type"],
  ) {
    super(message);
    this.name = "SimulationRuntimeRecoveryPersistenceClientError";
  }
}

export interface SimulationRuntimeRecoveryCheckpointPersistenceResult {
  result: SimulationRuntimeRecoveryMutationResult;
  /** Same zero-copy buffer returned by the Worker; the checkpoint is restored to this buffer too. */
  sourceCheckpointTransfer?: ArrayBuffer;
  checkpointMetrics?: SimulationRuntimeRecoveryCheckpointCompressionMetrics;
}

interface PendingRequest {
  operation: SimulationRuntimeRecoveryPersistenceRequest["type"];
  body: PersistenceRequestBody;
  transfer: Transferable[];
  timeoutMs: number;
  timer?: ReturnType<typeof setTimeout>;
  transferredCheckpoint: boolean;
  dispatched: boolean;
  restoreCheckpoint?: (buffer: ArrayBuffer) => void;
  resolve: (response: SimulationRuntimeRecoveryPersistenceResponse) => void;
  reject: (error: Error) => void;
  onProgress?: SimulationRuntimeRecoveryProgressListener;
}

type PersistenceRequestBody = SimulationRuntimeRecoveryPersistenceRequest extends infer Request
  ? Request extends { id: number } ? Omit<Request, "id"> : never
  : never;

export interface SimulationRuntimeRecoveryPersistenceClientOptions {
  /** Test seam; production uses the module Worker. */
  workerFactory?: () => Worker;
  /** Test seam; production remains bounded to 30 seconds for small operations. */
  smallOperationTimeoutMs?: number;
  /** Test seam; production remains bounded to 120 seconds for transfer checkpoints. */
  transferCheckpointTimeoutMs?: number;
}

export class SimulationRuntimeRecoveryPersistenceClient {
  private worker: Worker | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly dispatchQueue: number[] = [];
  private inflightId: number | null = null;
  private readonly workerFactory: () => Worker;
  private readonly smallOperationTimeoutMs: number;
  private readonly transferCheckpointTimeoutMs: number;

  constructor(options: SimulationRuntimeRecoveryPersistenceClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? (() => new Worker(
      new URL("./simulationRuntimeRecoveryPersistence.worker.ts", import.meta.url),
      { type: "module", name: "runtime-recovery-persistence" },
    ));
    this.smallOperationTimeoutMs = options.smallOperationTimeoutMs ?? SMALL_OPERATION_TIMEOUT_MS;
    this.transferCheckpointTimeoutMs = options.transferCheckpointTimeoutMs ?? TRANSFER_CHECKPOINT_TIMEOUT_MS;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined" && !this.workerFactory) {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "unsupported",
        "当前环境不支持 runtime recovery persistence Worker",
        false,
      );
    }
    let active: Worker;
    try {
      active = this.workerFactory();
    } catch (error) {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "unsupported",
        error instanceof Error ? error.message : "无法创建 runtime recovery persistence Worker",
        false,
      );
    }
    active.onmessage = (event: MessageEvent<SimulationRuntimeRecoveryPersistenceResponse>) => {
      if (this.worker !== active) return;
      const request = this.pending.get(event.data.id);
      if (!request || this.inflightId !== event.data.id) return;
      if (event.data.type === "progress") {
        try { request.onProgress?.(event.data.progress); } catch { /* observers cannot break durability */ }
        return;
      }
      if ("sourceCheckpointTransfer" in event.data && event.data.sourceCheckpointTransfer) {
        request.restoreCheckpoint?.(event.data.sourceCheckpointTransfer);
      }
      this.clearPending(event.data.id, request);
      request.resolve(event.data);
      this.dispatchNext();
    };
    active.onerror = (event) => {
      if (this.worker !== active) return;
      event.preventDefault?.();
      this.failAll("worker-crash", event.message || "runtime recovery persistence Worker 崩溃");
    };
    active.onmessageerror = () => {
      if (this.worker !== active) return;
      this.failAll("worker-crash", "runtime recovery persistence Worker 响应无法反序列化");
    };
    this.worker = active;
    return active;
  }

  private clearPending(id: number, request: PendingRequest): void {
    this.pending.delete(id);
    if (request.timer !== undefined) globalThis.clearTimeout(request.timer);
    if (this.inflightId === id) this.inflightId = null;
  }

  private failAll(
    code: "worker-crash" | "timeout" | "terminated",
    message: string,
    timedOutRequestId?: number,
  ): void {
    const active = this.worker;
    this.worker = null;
    if (active) {
      active.onmessage = null;
      active.onerror = null;
      active.onmessageerror = null;
      active.terminate();
    }
    for (const [id, request] of this.pending) {
      this.clearPending(id, request);
      const requestCode = timedOutRequestId !== undefined && id !== timedOutRequestId ? "worker-crash" : code;
      request.reject(new SimulationRuntimeRecoveryPersistenceClientError(
        requestCode,
        requestCode === "worker-crash" && timedOutRequestId !== undefined
          ? "另一个 persistence 请求超时，Worker 已终止"
          : message,
        request.dispatched && request.transferredCheckpoint,
        request.operation,
      ));
    }
    this.dispatchQueue.length = 0;
  }

  private dispatchNext(): void {
    if (this.inflightId !== null) return;
    const id = this.dispatchQueue.shift();
    if (id === undefined) return;
    const request = this.pending.get(id);
    if (!request) {
      this.dispatchNext();
      return;
    }
    let active: Worker;
    try {
      active = this.ensureWorker();
    } catch (error) {
      this.clearPending(id, request);
      request.reject(error instanceof Error ? error : new SimulationRuntimeRecoveryPersistenceClientError(
        "unsupported", "无法创建 runtime recovery persistence Worker", false, request.operation,
      ));
      this.dispatchNext();
      return;
    }
    this.inflightId = id;
    request.dispatched = true;
    request.timer = globalThis.setTimeout(() => {
      this.failAll(
        "timeout",
        `runtime recovery persistence ${request.operation} 超过 ${request.timeoutMs}ms 上限，Worker 已终止`,
        id,
      );
    }, request.timeoutMs);
    try {
      active.postMessage(
        { ...request.body, id } as SimulationRuntimeRecoveryPersistenceRequest,
        request.transfer,
      );
    } catch (error) {
      this.clearPending(id, request);
      request.reject(new SimulationRuntimeRecoveryPersistenceClientError(
        "post-message",
        error instanceof Error ? error.message : "runtime recovery persistence 请求发送失败",
        false,
        request.operation,
      ));
      this.dispatchNext();
    }
  }

  private request(
    body: PersistenceRequestBody,
    options: {
      transfer?: Transferable[];
      transferredCheckpoint?: boolean;
      restoreCheckpoint?: (buffer: ArrayBuffer) => void;
      timeoutMs?: number;
      onProgress?: SimulationRuntimeRecoveryProgressListener;
    } = {},
  ): Promise<SimulationRuntimeRecoveryPersistenceResponse> {
    const id = ++this.nextRequestId;
    const timeoutMs = options.timeoutMs ?? this.smallOperationTimeoutMs;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        operation: body.type,
        body,
        transfer: options.transfer ?? [],
        timeoutMs,
        transferredCheckpoint: options.transferredCheckpoint ?? false,
        dispatched: false,
        ...(options.restoreCheckpoint ? { restoreCheckpoint: options.restoreCheckpoint } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        resolve,
        reject,
      });
      this.dispatchQueue.push(id);
      this.dispatchNext();
    });
  }

  private workerOperationError(
    response: Extract<SimulationRuntimeRecoveryPersistenceResponse, { type: "error" }>,
    ownershipLost: boolean,
  ): SimulationRuntimeRecoveryPersistenceClientError {
    return new SimulationRuntimeRecoveryPersistenceClientError(
      "worker-operation",
      response.message,
      ownershipLost,
      response.operation,
    );
  }

  async stageUnsignedIntent(
    unsigned: SimulationRuntimeRecoveryUnsignedIntent,
    fence: SimulationRuntimeRecoveryWriterFence,
    onProgress?: SimulationRuntimeRecoveryProgressListener,
  ): Promise<{ result: SimulationRuntimeRecoveryMutationResult; intentSha256: string }> {
    const response = await this.request({ type: "stage-unsigned", unsigned, fence }, { onProgress });
    if (response.type === "error") throw this.workerOperationError(response, false);
    if (response.type !== "result" || response.operation !== "stage-unsigned") {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "protocol", "runtime recovery stage Worker 响应类型不匹配", false, "stage-unsigned",
      );
    }
    return { result: response.result, intentSha256: response.intentSha256 };
  }

  async initialize(
    checkpoint: SimulationRuntimeDurableCheckpoint,
    fence: SimulationRuntimeRecoveryWriterFence,
    onProgress?: SimulationRuntimeRecoveryProgressListener,
  ): Promise<SimulationRuntimeRecoveryCheckpointPersistenceResult> {
    return this.checkpointRequest({ type: "initialize", checkpoint, fence }, checkpoint, onProgress);
  }

  async initializeRawPreferredGzip(
    checkpoint: SimulationRuntimeRecoveryRawTransferCheckpoint,
    fence: SimulationRuntimeRecoveryWriterFence,
    onProgress?: SimulationRuntimeRecoveryProgressListener,
  ): Promise<SimulationRuntimeRecoveryCheckpointPersistenceResult & {
    checkpointMetrics: SimulationRuntimeRecoveryCheckpointCompressionMetrics;
  }> {
    const result = await this.checkpointRequest(
      { type: "initialize", checkpoint, preferGzip: true, fence }, checkpoint, onProgress,
    );
    if (!result.checkpointMetrics) {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "protocol", "prefer-gzip initialize 未返回压缩指标", false, "initialize",
      );
    }
    return { ...result, checkpointMetrics: result.checkpointMetrics };
  }

  async finalizeIntent(
    sessionId: string,
    generation: number,
    sequence: number,
    intentSha256: string,
    resultStateRevision: number,
    fence: SimulationRuntimeRecoveryWriterFence,
    onProgress?: SimulationRuntimeRecoveryProgressListener,
  ): Promise<SimulationRuntimeRecoveryMutationResult> {
    const response = await this.request({
      type: "finalize",
      sessionId,
      generation,
      sequence,
      intentSha256,
      resultStateRevision,
      fence,
    }, { onProgress });
    if (response.type === "error") throw this.workerOperationError(response, false);
    if (response.type !== "result" || response.operation !== "finalize") {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "protocol", "runtime recovery finalize Worker 响应类型不匹配", false, "finalize",
      );
    }
    return response.result;
  }

  async commitCheckpoint(
    checkpoint: SimulationRuntimeDurableCheckpoint,
    expectedGeneration: number,
    fence: SimulationRuntimeRecoveryWriterFence,
    absorbedIntent?: SimulationRuntimeRecoveryAbsorbedIntent,
    onProgress?: SimulationRuntimeRecoveryProgressListener,
  ): Promise<SimulationRuntimeRecoveryCheckpointPersistenceResult> {
    return this.checkpointRequest({
      type: "commit-checkpoint",
      checkpoint,
      expectedGeneration,
      ...(absorbedIntent ? { absorbedIntent } : {}),
      fence,
    }, checkpoint, onProgress);
  }

  async commitRawPreferredGzip(
    checkpoint: SimulationRuntimeRecoveryRawTransferCheckpoint,
    expectedGeneration: number,
    fence: SimulationRuntimeRecoveryWriterFence,
    absorbedIntent?: SimulationRuntimeRecoveryAbsorbedIntent,
    onProgress?: SimulationRuntimeRecoveryProgressListener,
  ): Promise<SimulationRuntimeRecoveryCheckpointPersistenceResult & {
    checkpointMetrics: SimulationRuntimeRecoveryCheckpointCompressionMetrics;
  }> {
    const result = await this.checkpointRequest({
      type: "commit-checkpoint",
      checkpoint,
      expectedGeneration,
      ...(absorbedIntent ? { absorbedIntent } : {}),
      preferGzip: true,
      fence,
    }, checkpoint, onProgress);
    if (!result.checkpointMetrics) {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "protocol", "prefer-gzip commit 未返回压缩指标", false, "commit-checkpoint",
      );
    }
    return { ...result, checkpointMetrics: result.checkpointMetrics };
  }

  private async checkpointRequest(
    body: Extract<PersistenceRequestBody, { type: "initialize" | "commit-checkpoint" }>,
    checkpoint: SimulationRuntimeDurableCheckpoint,
    onProgress?: SimulationRuntimeRecoveryProgressListener,
  ): Promise<SimulationRuntimeRecoveryCheckpointPersistenceResult> {
    const hasTransfer = checkpoint.source === "transfer";
    const response = await this.request(body, {
      ...(hasTransfer ? {
        transfer: [checkpoint.transfer.buffer],
        transferredCheckpoint: true,
        restoreCheckpoint: (buffer: ArrayBuffer) => { checkpoint.transfer.buffer = buffer; },
        timeoutMs: this.transferCheckpointTimeoutMs,
      } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
    const returned = response.type !== "progress" && "sourceCheckpointTransfer" in response
      ? response.sourceCheckpointTransfer
      : undefined;
    if (response.type === "error") throw this.workerOperationError(response, hasTransfer && !returned);
    if (response.type !== "result" || response.operation !== body.type) {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "protocol",
        `runtime recovery ${body.type} Worker 响应类型不匹配`,
        hasTransfer && !returned,
        body.type,
      );
    }
    if (hasTransfer && !returned) {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "protocol", "persistence Worker 未返还 checkpoint buffer ownership", true, body.type,
      );
    }
    return {
      result: response.result,
      ...(returned ? { sourceCheckpointTransfer: returned } : {}),
      ...(response.checkpointMetrics ? { checkpointMetrics: response.checkpointMetrics } : {}),
    };
  }

  async rebasePrimary(
    checkpoint: SimulationRuntimeDurablePrimaryCheckpoint,
    expectedGeneration: number,
    fence: SimulationRuntimeRecoveryWriterFence,
    onProgress?: SimulationRuntimeRecoveryProgressListener,
  ): Promise<SimulationRuntimeRecoveryMutationResult> {
    const response = await this.request(
      { type: "rebase-primary", checkpoint, expectedGeneration, fence },
      { onProgress },
    );
    if (response.type === "error") throw this.workerOperationError(response, false);
    if (response.type !== "result" || response.operation !== "rebase-primary") {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "protocol", "runtime recovery primary rebase Worker 响应类型不匹配", false, "rebase-primary",
      );
    }
    return response.result;
  }

  async read(
    baseIdentity: SimulationRuntimeRecoveryBaseIdentity,
    fence: SimulationRuntimeRecoveryWriterFence,
    onProgress?: SimulationRuntimeRecoveryProgressListener,
  ): Promise<SimulationRuntimeRecoveryReadResult> {
    const response = await this.request(
      { type: "read", baseIdentity, fence },
      { onProgress, timeoutMs: this.transferCheckpointTimeoutMs },
    );
    if (response.type === "error") throw this.workerOperationError(response, false);
    if (response.type !== "result" || response.operation !== "read") {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "protocol", "runtime recovery read Worker 响应类型不匹配", false, "read",
      );
    }
    return response.result;
  }

  async clear(
    target: SimulationRuntimeRecoveryClearTarget,
    fence: SimulationRuntimeRecoveryWriterFence,
    onProgress?: SimulationRuntimeRecoveryProgressListener,
  ): Promise<SimulationRuntimeRecoveryClearResult> {
    const response = await this.request({ type: "clear", target, fence }, { onProgress });
    if (response.type === "error") throw this.workerOperationError(response, false);
    if (response.type !== "result" || response.operation !== "clear") {
      throw new SimulationRuntimeRecoveryPersistenceClientError(
        "protocol", "runtime recovery clear Worker 响应类型不匹配", false, "clear",
      );
    }
    return response.result;
  }

  terminate(): void {
    this.failAll("terminated", "runtime recovery persistence Worker 已终止");
  }
}

const defaultClient = new SimulationRuntimeRecoveryPersistenceClient();

export function stageUnsignedSimulationRuntimeRecoveryIntentInPersistenceWorker(
  unsigned: SimulationRuntimeRecoveryUnsignedIntent,
  fence: SimulationRuntimeRecoveryWriterFence,
  onProgress?: SimulationRuntimeRecoveryProgressListener,
): Promise<{ result: SimulationRuntimeRecoveryMutationResult; intentSha256: string }> {
  return defaultClient.stageUnsignedIntent(unsigned, fence, onProgress);
}

export function initializeSimulationRuntimeRecoveryInPersistenceWorker(
  checkpoint: SimulationRuntimeDurableCheckpoint,
  fence: SimulationRuntimeRecoveryWriterFence,
  onProgress?: SimulationRuntimeRecoveryProgressListener,
): Promise<SimulationRuntimeRecoveryCheckpointPersistenceResult> {
  return defaultClient.initialize(checkpoint, fence, onProgress);
}

export function initializeRawSimulationRuntimeRecoveryCheckpointInPersistenceWorker(
  checkpoint: SimulationRuntimeRecoveryRawTransferCheckpoint,
  fence: SimulationRuntimeRecoveryWriterFence,
  onProgress?: SimulationRuntimeRecoveryProgressListener,
): Promise<SimulationRuntimeRecoveryCheckpointPersistenceResult & {
  checkpointMetrics: SimulationRuntimeRecoveryCheckpointCompressionMetrics;
}> {
  return defaultClient.initializeRawPreferredGzip(checkpoint, fence, onProgress);
}

export function finalizeSimulationRuntimeRecoveryIntentInPersistenceWorker(
  sessionId: string,
  generation: number,
  sequence: number,
  intentSha256: string,
  resultStateRevision: number,
  fence: SimulationRuntimeRecoveryWriterFence,
  onProgress?: SimulationRuntimeRecoveryProgressListener,
): Promise<SimulationRuntimeRecoveryMutationResult> {
  return defaultClient.finalizeIntent(
    sessionId, generation, sequence, intentSha256, resultStateRevision, fence, onProgress,
  );
}

export function commitSimulationRuntimeRecoveryCheckpointInPersistenceWorker(
  checkpoint: SimulationRuntimeDurableCheckpoint,
  expectedGeneration: number,
  fence: SimulationRuntimeRecoveryWriterFence,
  absorbedIntent?: SimulationRuntimeRecoveryAbsorbedIntent,
  onProgress?: SimulationRuntimeRecoveryProgressListener,
): Promise<SimulationRuntimeRecoveryCheckpointPersistenceResult> {
  return defaultClient.commitCheckpoint(checkpoint, expectedGeneration, fence, absorbedIntent, onProgress);
}

export function commitRawSimulationRuntimeRecoveryCheckpointInPersistenceWorker(
  checkpoint: SimulationRuntimeRecoveryRawTransferCheckpoint,
  expectedGeneration: number,
  fence: SimulationRuntimeRecoveryWriterFence,
  absorbedIntent?: SimulationRuntimeRecoveryAbsorbedIntent,
  onProgress?: SimulationRuntimeRecoveryProgressListener,
): Promise<SimulationRuntimeRecoveryCheckpointPersistenceResult & {
  checkpointMetrics: SimulationRuntimeRecoveryCheckpointCompressionMetrics;
}> {
  return defaultClient.commitRawPreferredGzip(checkpoint, expectedGeneration, fence, absorbedIntent, onProgress);
}

export function rebaseSimulationRuntimeRecoveryToPrimaryInPersistenceWorker(
  checkpoint: SimulationRuntimeDurablePrimaryCheckpoint,
  expectedGeneration: number,
  fence: SimulationRuntimeRecoveryWriterFence,
  onProgress?: SimulationRuntimeRecoveryProgressListener,
): Promise<SimulationRuntimeRecoveryMutationResult> {
  return defaultClient.rebasePrimary(checkpoint, expectedGeneration, fence, onProgress);
}

export function readSimulationRuntimeRecoveryInPersistenceWorker(
  baseIdentity: SimulationRuntimeRecoveryBaseIdentity,
  fence: SimulationRuntimeRecoveryWriterFence,
  onProgress?: SimulationRuntimeRecoveryProgressListener,
): Promise<SimulationRuntimeRecoveryReadResult> {
  return defaultClient.read(baseIdentity, fence, onProgress);
}

export function clearSimulationRuntimeRecoveryInPersistenceWorker(
  target: SimulationRuntimeRecoveryClearTarget,
  fence: SimulationRuntimeRecoveryWriterFence,
  onProgress?: SimulationRuntimeRecoveryProgressListener,
): Promise<SimulationRuntimeRecoveryClearResult> {
  return defaultClient.clear(target, fence, onProgress);
}

export function terminateSimulationRuntimeRecoveryPersistenceWorker(): void {
  defaultClient.terminate();
}
