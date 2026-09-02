/// <reference lib="webworker" />

import { applyContentPackRegistry, type ContentPackRegistry } from "./contentPacks";
import { inspectSave, type SaveInspection } from "./storage";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";
import { computeSavePayloadChecksum } from "./saveTransfer";

interface SaveInspectionWorkerRequest {
  id: number;
  /** Legacy cloud/string path. */
  raw?: string;
  /** Transferred local-file bytes; the sender relinquishes ownership. */
  bytes?: ArrayBuffer;
  registry: ContentPackRegistry;
}

interface SaveInspectionWorkerResponse {
  id: number;
  inspection?: SaveInspection;
  payloadChecksum?: string;
  byteLength?: number;
  error?: string;
}

self.onmessage = (event: MessageEvent<SaveInspectionWorkerRequest>) => {
  const request = event.data;
  try {
    applyContentPackRegistry(request.registry);
    let raw: string;
    let payloadChecksum: string;
    let byteLength: number;
    if (request.bytes instanceof ArrayBuffer) {
      // Decode exactly once inside the Worker.  A fatal decoder keeps malformed
      // UTF-8 on the same fail-closed path as compressed local imports and
      // avoids computing a checksum over replacement characters.
      raw = new TextDecoder("utf-8", { fatal: true }).decode(request.bytes);
      payloadChecksum = computeSavePayloadChecksum(request.bytes);
      byteLength = request.bytes.byteLength;
    } else if (typeof request.raw === "string") {
      raw = request.raw;
      const payload = computeSavePayloadTextChecksum(raw);
      payloadChecksum = payload.checksum;
      byteLength = payload.byteLength;
    } else {
      throw new Error("后台存档检查缺少正文");
    }
    const inspection = inspectSave(raw, request.registry);
    self.postMessage({ id: request.id, inspection, payloadChecksum, byteLength } satisfies SaveInspectionWorkerResponse);
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : "后台存档检查失败",
    } satisfies SaveInspectionWorkerResponse);
  }
};

export type { SaveInspectionWorkerRequest, SaveInspectionWorkerResponse };
