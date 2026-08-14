import { loadContentPackRegistry, type ContentPackRegistry } from "./contentPacks";
import { inspectSave, type SaveInspection } from "./storage";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";

let saveInspectionRequestId = 0;

/**
 * Keep file/cloud import parsing, checksum validation, and migration off the
 * UI thread. This orchestration deliberately lives outside storage.ts so the
 * worker may import the pure inspection implementation without forming a
 * worker-entry cycle during production bundling.
 */
export function inspectSavePayloadInWorker(
  raw: string,
  contentPackRegistry: ContentPackRegistry = loadContentPackRegistry(),
): Promise<{ inspection: SaveInspection; payloadChecksum: string; byteLength: number; worker: boolean }> {
  const fallback = () => {
    const payload = computeSavePayloadTextChecksum(raw);
    return { inspection: inspectSave(raw, contentPackRegistry), payloadChecksum: payload.checksum, byteLength: payload.byteLength, worker: false };
  };
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
    worker.onmessage = (event: MessageEvent<{ id: number; inspection?: SaveInspection; payloadChecksum?: string; byteLength?: number; error?: string }>) => {
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

export async function inspectSaveInWorker(raw: string, contentPackRegistry: ContentPackRegistry = loadContentPackRegistry()): Promise<SaveInspection> {
  return (await inspectSavePayloadInWorker(raw, contentPackRegistry)).inspection;
}
