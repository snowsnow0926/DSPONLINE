/// <reference lib="webworker" />

import { applyContentPackRegistry, type ContentPackRegistry } from "./contentPacks";
import { inspectSave, type SaveInspection } from "./storage";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";

interface SaveInspectionWorkerRequest {
  id: number;
  raw: string;
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
    const inspection = inspectSave(request.raw, request.registry);
    const payload = computeSavePayloadTextChecksum(request.raw);
    self.postMessage({ id: request.id, inspection, payloadChecksum: payload.checksum, byteLength: payload.byteLength } satisfies SaveInspectionWorkerResponse);
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : "后台存档检查失败",
    } satisfies SaveInspectionWorkerResponse);
  }
};

export type { SaveInspectionWorkerRequest, SaveInspectionWorkerResponse };
