import { loadContentPackRegistry } from "./contentPacks";
import type { SimulationStateTransfer } from "./simulationRuntimeProtocol";
import type {
  AuthoritativeSaveCatalogSeed,
  AuthoritativeSavePayloadProof,
} from "./authoritativeSavePersistenceProtocol";
import type {
  AuthoritativeSaveSerializationRequest,
  AuthoritativeSaveSerializationResponse,
  AuthoritativeSaveSerializationSummary,
} from "./authoritativeSaveSerializationProtocol";

const SAVE_FORMAT_VERSION = 2;
const AUTHORITATIVE_SERIALIZATION_TIMEOUT_MS = 120_000;

export interface AuthoritativeSerializedSavePayload {
  bytes: ArrayBuffer;
  sourceStateTransfer: ArrayBuffer;
  proof: AuthoritativeSavePayloadProof;
  catalogSeed: AuthoritativeSaveCatalogSeed;
  summary: AuthoritativeSaveSerializationSummary;
  durationMs: number;
}

export type AuthoritativeSaveSerializationProgress =
  | { stage: "queued"; savedAt: number }
  | { stage: "serialized"; savedAt: number; bytes: number; durationMs: number }
  | { stage: "failed"; savedAt: number; reason: string };

export class AuthoritativeSaveSerializationClientError extends Error {
  constructor(
    public readonly code: "unsupported" | "timeout" | "worker-crash" | "worker-operation" | "aborted" | "protocol",
    message: string,
    public readonly ownershipLost = false,
  ) {
    super(message);
    this.name = "AuthoritativeSaveSerializationClientError";
  }
}

export function serializeAuthoritativeSaveStateTransferInWorker(
  stateTransfer: SimulationStateTransfer,
  options: {
    savedAt?: number;
    kind?: "primary" | "slot" | "snapshot";
    slot?: "main" | 1 | 2 | 3;
    reason?: string;
    signal?: AbortSignal;
    onProgress?: (progress: AuthoritativeSaveSerializationProgress) => void;
    timeoutMs?: number;
  } = {},
): Promise<AuthoritativeSerializedSavePayload> {
  const savedAt = options.savedAt ?? Date.now();
  const kind = options.kind ?? "primary";
  const slot = options.slot ?? "main";
  options.onProgress?.({ stage: "queued", savedAt });
  if (options.signal?.aborted) {
    return Promise.reject(new AuthoritativeSaveSerializationClientError("aborted", "authoritative save serialization 已取消"));
  }
  if (typeof Worker === "undefined") {
    return Promise.reject(new AuthoritativeSaveSerializationClientError(
      "unsupported",
      "当前环境不支持 save Worker；禁止在UI线程回退序列化大存档",
    ));
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./save.worker.ts", import.meta.url), { type: "module", name: "authoritative-save-serialization" });
    } catch (error) {
      reject(new AuthoritativeSaveSerializationClientError(
        "unsupported",
        error instanceof Error ? error.message : "无法创建 authoritative save serialization Worker",
      ));
      return;
    }
    const id = 1;
    let settled = false;
    const timeoutMs = options.timeoutMs ?? AUTHORITATIVE_SERIALIZATION_TIMEOUT_MS;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      operation();
    };
    const abort = () => finish(() => reject(new AuthoritativeSaveSerializationClientError(
      "aborted", "authoritative save serialization 已取消",
    )));
    const timer = globalThis.setTimeout(() => finish(() => {
      options.onProgress?.({ stage: "failed", savedAt, reason: "timeout" });
      reject(new AuthoritativeSaveSerializationClientError("timeout", `save Worker 超过 ${timeoutMs}ms 上限`));
    }), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => finish(() => {
      options.onProgress?.({ stage: "failed", savedAt, reason: "worker-crash" });
      reject(new AuthoritativeSaveSerializationClientError("worker-crash", event.message || "authoritative save serialization Worker 崩溃", stateTransfer.buffer.byteLength === 0));
    });
    worker.onmessage = (event: MessageEvent<AuthoritativeSaveSerializationResponse>) => {
      if (event.data.id !== id) return;
      const { bytes, proof, catalogSeed, summary, sourceStateTransfer } = event.data;
      if (sourceStateTransfer) stateTransfer.buffer = sourceStateTransfer;
      if (event.data.error) {
        finish(() => reject(new AuthoritativeSaveSerializationClientError("worker-operation", event.data.error!, stateTransfer.buffer.byteLength === 0)));
        return;
      }
      if (!(bytes instanceof ArrayBuffer) || !proof || !catalogSeed || !summary ||
        !(sourceStateTransfer instanceof ArrayBuffer) ||
        proof.integrity !== "valid" || proof.byteLength !== bytes.byteLength ||
        proof.stateChecksum !== catalogSeed.stateChecksum || summary.stateChecksum !== catalogSeed.stateChecksum) {
        finish(() => reject(new AuthoritativeSaveSerializationClientError("protocol", "save Worker authoritative proof 响应不完整", stateTransfer.buffer.byteLength === 0)));
        return;
      }
      finish(() => {
        const durationMs = Math.max(0, event.data.durationMs ?? 0);
        options.onProgress?.({ stage: "serialized", savedAt, bytes: bytes.byteLength, durationMs });
        resolve({ bytes, sourceStateTransfer, proof, catalogSeed, summary, durationMs });
      });
    };
    const request: AuthoritativeSaveSerializationRequest = {
      id,
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt,
      kind,
      slot,
      ...(options.reason ? { reason: options.reason } : {}),
      stateTransfer,
      contentPackRegistry: loadContentPackRegistry(),
      includePayloadSha256: true,
      includeAuthoritativeProof: true,
    };
    try {
      worker.postMessage(request, [stateTransfer.buffer]);
    } catch (error) {
      finish(() => reject(new AuthoritativeSaveSerializationClientError(
        "worker-operation", error instanceof Error ? error.message : "无法发送save Worker请求", false,
      )));
    }
  });
}

/** Backward-compatible name; authoritative path always accepts a transferable state. */
export const serializeAuthoritativeSavePayloadInWorker = serializeAuthoritativeSaveStateTransferInWorker;
