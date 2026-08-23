import { loadContentPackRegistry } from "./contentPacks";
import type { SimulationStateTransfer } from "./simulationRuntimeProtocol";
import type {
  AuthoritativeSaveCatalogSeed,
  AuthoritativeSavePayloadProof,
} from "./authoritativeSavePersistenceProtocol";
import type {
  AuthoritativeSaveExpectedStateIdentity,
  AuthoritativeSaveCheckpointOverlay,
  AuthoritativeSaveEnvelopeTransfer,
  AuthoritativeSaveSerializationRequest,
  AuthoritativeSaveSerializationResponse,
  AuthoritativeSaveSerializationSummary,
} from "./authoritativeSaveSerializationProtocol";
import {
  isWorkerBinaryPayload,
  workerBinaryPayloadByteLength,
  workerBinaryPayloadTransferables,
  type WorkerBinaryPayload,
} from "./workerBinaryPayload";

const SAVE_FORMAT_VERSION = 2;
const AUTHORITATIVE_SERIALIZATION_TIMEOUT_MS = 120_000;

export interface AuthoritativeSerializedSavePayload<Payload extends WorkerBinaryPayload = ArrayBuffer> {
  bytes: Payload;
  sourceStateTransfer: Payload;
  sourceEnvelopeTransfer?: Payload;
  proof: AuthoritativeSavePayloadProof;
  catalogSeed: AuthoritativeSaveCatalogSeed;
  summary: AuthoritativeSaveSerializationSummary;
  durationMs: number;
  compressionDurationMs: number;
}

type AuthoritativeSaveSerializationSource =
  | { kind: "state"; transfer: SimulationStateTransfer }
  | { kind: "envelope"; transfer: AuthoritativeSaveEnvelopeTransfer };

interface AuthoritativeSaveSerializationOptions {
  savedAt?: number;
  kind?: "primary" | "slot" | "snapshot";
  slot?: "main" | 1 | 2 | 3;
  reason?: string;
  signal?: AbortSignal;
  onProgress?: (progress: AuthoritativeSaveSerializationProgress) => void;
  timeoutMs?: number;
  expectedStateIdentity?: AuthoritativeSaveExpectedStateIdentity;
  checkpointOverlay?: AuthoritativeSaveCheckpointOverlay;
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

function serializeAuthoritativeSaveSourceInWorker(
  source: AuthoritativeSaveSerializationSource,
  options: AuthoritativeSaveSerializationOptions = {},
): Promise<AuthoritativeSerializedSavePayload<WorkerBinaryPayload>> {
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
    const ownershipLost = () => source.transfer.buffer instanceof ArrayBuffer && source.transfer.buffer.byteLength === 0;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      operation();
    };
    const abort = () => finish(() => reject(new AuthoritativeSaveSerializationClientError(
      "aborted", "authoritative save serialization 已取消", ownershipLost(),
    )));
    const timer = globalThis.setTimeout(() => finish(() => {
      options.onProgress?.({ stage: "failed", savedAt, reason: "timeout" });
      reject(new AuthoritativeSaveSerializationClientError("timeout", `save Worker 超过 ${timeoutMs}ms 上限`, ownershipLost()));
    }), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => finish(() => {
      options.onProgress?.({ stage: "failed", savedAt, reason: "worker-crash" });
      reject(new AuthoritativeSaveSerializationClientError("worker-crash", event.message || "authoritative save serialization Worker 崩溃", ownershipLost()));
    });
    worker.onmessageerror = () => finish(() => {
      options.onProgress?.({ stage: "failed", savedAt, reason: "message-error" });
      reject(new AuthoritativeSaveSerializationClientError("protocol", "save Worker 返回了无法反序列化的响应", ownershipLost()));
    });
    worker.onmessage = (event: MessageEvent<AuthoritativeSaveSerializationResponse>) => {
      if (event.data.id !== id) return;
      const { bytes, proof, catalogSeed, summary, sourceStateTransfer, sourceEnvelopeTransfer } = event.data;
      if (source.kind === "state" && sourceStateTransfer instanceof ArrayBuffer) source.transfer.buffer = sourceStateTransfer;
      if (source.kind === "envelope" && sourceEnvelopeTransfer) source.transfer.buffer = sourceEnvelopeTransfer;
      if (event.data.error) {
        finish(() => reject(new AuthoritativeSaveSerializationClientError("worker-operation", event.data.error!, ownershipLost())));
        return;
      }
      if (!isWorkerBinaryPayload(bytes) || !proof || !catalogSeed || !summary ||
        !isWorkerBinaryPayload(sourceStateTransfer) ||
        (source.kind === "envelope" && !isWorkerBinaryPayload(sourceEnvelopeTransfer)) ||
        proof.integrity !== "valid" || proof.storedByteLength !== workerBinaryPayloadByteLength(bytes) ||
        (proof.transportEncoding !== "raw" && proof.transportEncoding !== "gzip") ||
        !/^[a-f0-9]{64}$/.test(proof.storedSha256) ||
        (proof.transportEncoding === "raw" && (
          proof.storedByteLength !== proof.byteLength || proof.storedSha256 !== proof.payloadSha256
        )) ||
        proof.stateChecksum !== catalogSeed.stateChecksum || summary.stateChecksum !== catalogSeed.stateChecksum) {
        finish(() => reject(new AuthoritativeSaveSerializationClientError("protocol", "save Worker authoritative proof 响应不完整", ownershipLost())));
        return;
      }
      finish(() => {
        const durationMs = Math.max(0, event.data.durationMs ?? 0);
        options.onProgress?.({ stage: "serialized", savedAt, bytes: workerBinaryPayloadByteLength(bytes), durationMs });
        resolve({
          bytes,
          sourceStateTransfer,
          ...(sourceEnvelopeTransfer ? { sourceEnvelopeTransfer } : {}),
          proof,
          catalogSeed,
          summary,
          durationMs,
          compressionDurationMs: Math.max(0, event.data.compressionDurationMs ?? 0),
        });
      });
    };
    const request: AuthoritativeSaveSerializationRequest = {
      id,
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt,
      kind,
      slot,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(source.kind === "state"
        ? { stateTransfer: source.transfer }
        : { envelopeTransfer: source.transfer }),
      contentPackRegistry: loadContentPackRegistry(),
      includePayloadSha256: true,
      includeAuthoritativeProof: true,
      ...(options.expectedStateIdentity ? { expectedStateIdentity: options.expectedStateIdentity } : {}),
      ...(options.checkpointOverlay ? { checkpointOverlay: options.checkpointOverlay } : {}),
    };
    try {
      worker.postMessage(request, workerBinaryPayloadTransferables(source.transfer.buffer));
    } catch (error) {
      finish(() => reject(new AuthoritativeSaveSerializationClientError(
        "worker-operation", error instanceof Error ? error.message : "无法发送save Worker请求", ownershipLost(),
      )));
    }
  });
}

export function serializeAuthoritativeSaveStateTransferInWorker(
  stateTransfer: SimulationStateTransfer,
  options: AuthoritativeSaveSerializationOptions = {},
): Promise<AuthoritativeSerializedSavePayload<ArrayBuffer>> {
  return serializeAuthoritativeSaveSourceInWorker(
    { kind: "state", transfer: stateTransfer },
    options,
  ) as Promise<AuthoritativeSerializedSavePayload<ArrayBuffer>>;
}

export function serializeAuthoritativeSaveEnvelopeTransferInWorker(
  envelopeTransfer: AuthoritativeSaveEnvelopeTransfer,
  options: AuthoritativeSaveSerializationOptions = {},
): Promise<AuthoritativeSerializedSavePayload<WorkerBinaryPayload>> {
  return serializeAuthoritativeSaveSourceInWorker({ kind: "envelope", transfer: envelopeTransfer }, options);
}

/** Backward-compatible name; authoritative path always accepts a transferable state. */
export const serializeAuthoritativeSavePayloadInWorker = serializeAuthoritativeSaveStateTransferInWorker;
