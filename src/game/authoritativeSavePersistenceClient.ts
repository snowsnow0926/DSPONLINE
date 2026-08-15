import type {
  AuthoritativeSaveCatalogSeed,
  AuthoritativeSavePersistenceProgress,
  AuthoritativeSavePersistenceRequest,
  AuthoritativeSavePersistenceResponse,
  AuthoritativeSavePersistenceResult,
  AuthoritativeSavePayloadProof,
  AuthoritativeSaveWriterFence,
} from "./authoritativeSavePersistenceProtocol";

const AUTHORITATIVE_SAVE_TIMEOUT_MS = 120_000;

export interface AuthoritativeSavePayloadCommitInput {
  key: string;
  bytes: ArrayBuffer;
  proof: AuthoritativeSavePayloadProof;
  seed: AuthoritativeSaveCatalogSeed;
  expectedRevision: number;
  fence: AuthoritativeSaveWriterFence;
  preserveBackup?: boolean;
}

export interface AuthoritativeSavePersistenceCommitResult {
  result: AuthoritativeSavePersistenceResult;
  sourcePayloadTransfer?: ArrayBuffer;
}

export type AuthoritativeSavePersistenceClientFailureCode =
  | "unsupported"
  | "post-message"
  | "worker-operation"
  | "worker-crash"
  | "timeout"
  | "terminated"
  | "protocol";

export class AuthoritativeSavePersistenceClientError extends Error {
  constructor(
    public readonly code: AuthoritativeSavePersistenceClientFailureCode,
    message: string,
    public readonly ownershipLost: boolean,
  ) {
    super(message);
    this.name = "AuthoritativeSavePersistenceClientError";
  }
}

type RequestBody = Omit<AuthoritativeSavePersistenceRequest, "id">;

interface PendingRequest {
  body: RequestBody;
  timer?: ReturnType<typeof setTimeout>;
  dispatched: boolean;
  transferredPayload: boolean;
  restorePayload?: (buffer: ArrayBuffer) => void;
  resolve: (response: AuthoritativeSavePersistenceResponse) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: AuthoritativeSavePersistenceProgress) => void;
}

export interface AuthoritativeSavePersistenceClientOptions {
  workerFactory?: () => Worker;
  timeoutMs?: number;
}

export class AuthoritativeSavePersistenceClient {
  private worker: Worker | null = null;
  private nextId = 0;
  private inflightId: number | null = null;
  private readonly queue: number[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private readonly workerFactory: () => Worker;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(options: AuthoritativeSavePersistenceClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? (() => new Worker(
      new URL("./authoritativeSavePersistence.worker.ts", import.meta.url),
      { type: "module", name: "authoritative-save-persistence" },
    ));
    this.timeoutMs = options.timeoutMs ?? AUTHORITATIVE_SAVE_TIMEOUT_MS;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    let active: Worker;
    try {
      active = this.workerFactory();
    } catch (error) {
      throw new AuthoritativeSavePersistenceClientError(
        "unsupported",
        error instanceof Error ? error.message : "无法创建 authoritative save persistence Worker",
        false,
      );
    }
    active.onmessage = (event: MessageEvent<AuthoritativeSavePersistenceResponse>) => {
      if (this.worker !== active) return;
      const request = this.pending.get(event.data.id);
      if (!request || this.inflightId !== event.data.id) return;
      if (event.data.type === "progress") {
        try { request.onProgress?.(event.data.progress); } catch { /* observer cannot break persistence */ }
        return;
      }
      if ("sourcePayloadTransfer" in event.data && event.data.sourcePayloadTransfer) {
        request.restorePayload?.(event.data.sourcePayloadTransfer);
      }
      this.clearPending(event.data.id, request);
      request.resolve(event.data);
      this.dispatchNext();
    };
    active.onerror = (event) => {
      if (this.worker !== active) return;
      event.preventDefault?.();
      this.failAll("worker-crash", event.message || "authoritative save persistence Worker 崩溃");
    };
    active.onmessageerror = () => {
      if (this.worker !== active) return;
      this.failAll("worker-crash", "authoritative save persistence Worker 响应无法反序列化");
    };
    this.worker = active;
    return active;
  }

  private clearPending(id: number, request: PendingRequest): void {
    this.pending.delete(id);
    if (request.timer !== undefined) globalThis.clearTimeout(request.timer);
    if (this.inflightId === id) this.inflightId = null;
  }

  private failAll(code: "worker-crash" | "timeout" | "terminated", message: string, timedOutId?: number): void {
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
      const requestCode = timedOutId !== undefined && id !== timedOutId ? "worker-crash" : code;
      request.reject(new AuthoritativeSavePersistenceClientError(
        requestCode,
        requestCode === "worker-crash" && timedOutId !== undefined
          ? "另一个 authoritative save 请求超时，Worker 已终止"
          : message,
        request.dispatched && request.transferredPayload,
      ));
    }
    this.queue.length = 0;
  }

  private dispatchNext(): void {
    if (this.inflightId !== null) return;
    const id = this.queue.shift();
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
      request.reject(error instanceof Error ? error : new AuthoritativeSavePersistenceClientError(
        "unsupported", "无法创建 authoritative save Worker", false,
      ));
      this.dispatchNext();
      return;
    }
    this.inflightId = id;
    request.dispatched = true;
    request.timer = globalThis.setTimeout(() => {
      this.failAll("timeout", `authoritative save persistence 超过 ${this.timeoutMs}ms 上限`, id);
    }, this.timeoutMs);
    try {
      active.postMessage({ ...request.body, id } satisfies AuthoritativeSavePersistenceRequest, [request.body.payload]);
    } catch (error) {
      this.clearPending(id, request);
      request.reject(new AuthoritativeSavePersistenceClientError(
        "post-message",
        error instanceof Error ? error.message : "authoritative save persistence 请求发送失败",
        false,
      ));
      this.dispatchNext();
    }
  }

  commit(
    input: AuthoritativeSavePayloadCommitInput,
    onProgress?: (progress: AuthoritativeSavePersistenceProgress) => void,
  ): Promise<AuthoritativeSavePersistenceCommitResult> {
    if (this.closed) {
      return Promise.reject(new AuthoritativeSavePersistenceClientError(
        "terminated",
        "page lifecycle 已关闭 authoritative save persistence queue",
        false,
      ));
    }
    const body: RequestBody = {
      type: "commit",
      key: input.key,
      payload: input.bytes,
      proof: input.proof,
      seed: input.seed,
      expectedRevision: input.expectedRevision,
      fence: input.fence,
      ...(input.preserveBackup === false ? { preserveBackup: false } : {}),
    };
    const id = ++this.nextId;
    return new Promise<AuthoritativeSavePersistenceResponse>((resolve, reject) => {
      this.pending.set(id, {
        body,
        dispatched: false,
        transferredPayload: true,
        restorePayload: (buffer) => { input.bytes = buffer; },
        ...(onProgress ? { onProgress } : {}),
        resolve,
        reject,
      });
      this.queue.push(id);
      this.dispatchNext();
    }).then((response) => {
      if (response.type === "error") {
        throw new AuthoritativeSavePersistenceClientError(
          "worker-operation",
          response.message,
          input.bytes.byteLength === 0,
        );
      }
      if (response.type !== "result") {
        throw new AuthoritativeSavePersistenceClientError("protocol", "authoritative save Worker 响应类型不匹配", input.bytes.byteLength === 0);
      }
      if (!response.sourcePayloadTransfer) {
        throw new AuthoritativeSavePersistenceClientError(
          "protocol",
          "authoritative save Worker 未返还 payload buffer ownership",
          true,
        );
      }
      return {
        result: response.result,
        sourcePayloadTransfer: response.sourcePayloadTransfer,
      };
    });
  }

  terminate(): void {
    this.closed = true;
    this.failAll("terminated", "authoritative save persistence Worker 已终止");
  }

  /** BFCache pageshow starts a fresh Worker generation after pagehide closed the old one. */
  resumeAfterPageshow(): void {
    if (this.pending.size > 0 || this.inflightId !== null) {
      throw new AuthoritativeSavePersistenceClientError("protocol", "仍有未清理的 authoritative save 请求", false);
    }
    this.closed = false;
  }
}

const defaultClient = new AuthoritativeSavePersistenceClient();

export function commitAuthoritativeSavePayloadInPersistenceWorker(
  input: AuthoritativeSavePayloadCommitInput,
  onProgress?: (progress: AuthoritativeSavePersistenceProgress) => void,
): Promise<AuthoritativeSavePersistenceCommitResult> {
  return defaultClient.commit(input, onProgress);
}

export function terminateAuthoritativeSavePersistenceWorker(): void {
  defaultClient.terminate();
}

/** Permanently stop accepting page-lifecycle writes; queued buffers stay owned by the caller. */
export function closeAuthoritativeSavePersistenceForPagehide(): void {
  defaultClient.terminate();
}

export function resumeAuthoritativeSavePersistenceAfterPageshow(): void {
  defaultClient.resumeAfterPageshow();
}
