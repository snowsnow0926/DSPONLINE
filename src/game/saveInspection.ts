import { loadContentPackRegistry, type ContentPackRegistry } from "./contentPacks";
import { inspectSave, type SaveInspection } from "./storage";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";
import { computeSavePayloadChecksum } from "./saveTransfer";
import { decodeSaveFileBytes } from "./saveFileCodec";

let saveInspectionRequestId = 0;

export interface SaveInspectionWorkerResult {
  inspection: SaveInspection;
  payloadChecksum: string;
  byteLength: number;
  worker: boolean;
}

type SaveInspectionFallback = () => string | Promise<string>;

function rawInspectionResult(raw: string, contentPackRegistry: ContentPackRegistry): SaveInspectionWorkerResult {
  const payload = computeSavePayloadTextChecksum(raw);
  return {
    inspection: inspectSave(raw, contentPackRegistry),
    payloadChecksum: payload.checksum,
    byteLength: payload.byteLength,
    worker: false,
  };
}

function bytesInspectionResult(bytes: ArrayBuffer, contentPackRegistry: ContentPackRegistry): SaveInspectionWorkerResult {
  const raw = decodeSaveFileBytes(bytes, true);
  return {
    inspection: inspectSave(raw, contentPackRegistry),
    payloadChecksum: computeSavePayloadChecksum(bytes),
    byteLength: bytes.byteLength,
    worker: false,
  };
}

interface SaveInspectionWorkerResponse {
  id: number;
  inspection?: SaveInspection;
  payloadChecksum?: string;
  byteLength?: number;
  error?: string;
}

/**
 * Keep file/cloud import parsing, checksum validation, and migration off the
 * UI thread. This orchestration deliberately lives outside storage.ts so the
 * worker may import the pure inspection implementation without forming a
 * worker-entry cycle during production bundling.
 */
export function inspectSavePayloadInWorker(
  raw: string,
  contentPackRegistry: ContentPackRegistry = loadContentPackRegistry(),
): Promise<SaveInspectionWorkerResult> {
  const fallback = () => rawInspectionResult(raw, contentPackRegistry);
  if (typeof Worker === "undefined") return Promise.resolve(fallback());
  const id = ++saveInspectionRequestId;
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./saveInspection.worker.ts", import.meta.url), { type: "module", name: "save-inspection" });
    } catch {
      resolve(fallback());
      return;
    }
    let settled = false;
    const finish = (result?: { inspection: SaveInspection; payloadChecksum: string; byteLength: number }) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(result ? { ...result, worker: true } : fallback());
    };
    worker.onerror = () => finish();
    worker.onmessageerror = () => finish();
    worker.onmessage = (event: MessageEvent<SaveInspectionWorkerResponse>) => {
      if (event.data.id !== id || event.data.error || !event.data.inspection || !event.data.payloadChecksum || typeof event.data.byteLength !== "number") {
        finish();
        return;
      }
      finish({ inspection: event.data.inspection, payloadChecksum: event.data.payloadChecksum, byteLength: event.data.byteLength });
    };
    try {
      worker.postMessage({ id, raw, registry: contentPackRegistry });
    } catch {
      finish();
    }
  });
}

/**
 * Inspect a local file payload while transferring its bytes to the Worker.
 * The ArrayBuffer is detached from the UI thread immediately after dispatch;
 * unlike the legacy string protocol this does not retain a second full UTF-16
 * copy while JSON.parse and migration run in the Worker.  `fallbackRaw` is
 * intentionally lazy so normal successful imports never allocate a fallback
 * string at all (the Start Menu rereads the file only for a rescue flow).
 */
export function inspectSavePayloadBytesInWorker(
  bytes: ArrayBuffer,
  contentPackRegistry: ContentPackRegistry = loadContentPackRegistry(),
  fallbackRaw?: SaveInspectionFallback,
): Promise<SaveInspectionWorkerResult> {
  // Capture these before postMessage() detaches `bytes` from the renderer.
  const expectedByteLength = bytes.byteLength;
  const expectedPayloadChecksum = computeSavePayloadChecksum(bytes);
  // Keep a binary fallback only when the caller did not provide a reread
  // callback.  It is one bounded byte copy, still substantially cheaper than
  // cloning a multi-megabyte UTF-16 string and a parsed state graph.
  const fallbackBytes = fallbackRaw ? null : bytes.slice(0);
  const fallback = async (): Promise<SaveInspectionWorkerResult> => {
    const raw = fallbackRaw
      ? await fallbackRaw()
      : decodeSaveFileBytes(fallbackBytes!, true);
    return {
      ...rawInspectionResult(raw, contentPackRegistry),
      // Keep the exact byte identity from the original File even when the
      // fallback had to reread text (for example after a Worker constructor
      // failure). This also keeps BOM/non-ASCII payloads consistent.
      payloadChecksum: expectedPayloadChecksum,
      byteLength: expectedByteLength,
    };
  };
  if (typeof Worker === "undefined") {
    return fallbackRaw
      ? fallback().then((result) => result)
      : Promise.resolve(bytesInspectionResult(bytes, contentPackRegistry));
  }
  const id = ++saveInspectionRequestId;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./saveInspection.worker.ts", import.meta.url), { type: "module", name: "save-inspection" });
    } catch {
      fallback().then(resolve, reject);
      return;
    }
    let settled = false;
    const finish = (result?: { inspection: SaveInspection; payloadChecksum: string; byteLength: number }) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      if (result) {
        resolve({ ...result, worker: true });
      } else {
        fallback().then(resolve, reject);
      }
    };
    worker.onerror = () => finish();
    worker.onmessageerror = () => finish();
    worker.onmessage = (event: MessageEvent<SaveInspectionWorkerResponse>) => {
      if (event.data.id !== id || event.data.error || !event.data.inspection ||
          !event.data.payloadChecksum || !/^[0-9a-f]{8}$/.test(event.data.payloadChecksum) ||
          event.data.byteLength !== expectedByteLength) {
        finish();
        return;
      }
      finish({
        inspection: event.data.inspection,
        payloadChecksum: event.data.payloadChecksum,
        byteLength: event.data.byteLength,
      });
    };
    try {
      worker.postMessage({ id, bytes, registry: contentPackRegistry }, [bytes]);
    } catch {
      finish();
    }
  });
}

export async function inspectSaveInWorker(raw: string, contentPackRegistry: ContentPackRegistry = loadContentPackRegistry()): Promise<SaveInspection> {
  return (await inspectSavePayloadInWorker(raw, contentPackRegistry)).inspection;
}
