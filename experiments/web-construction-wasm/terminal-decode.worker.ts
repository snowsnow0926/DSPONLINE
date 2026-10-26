/// <reference lib="webworker" />
import { applyContentPackRegistry, type ContentPackRegistry } from "../../src/game/contentPacks";
import { parseTrustedWorkerEnvelope } from "../../src/game/storage";
import { decodeVerifiedSaveTransfer, type SaveTransferVerification } from "../../src/game/saveTransfer";

self.onmessage = async ({ data }: MessageEvent<{
  payload: Blob; verification: SaveTransferVerification; registry: ContentPackRegistry;
}>) => {
  try {
    applyContentPackRegistry(data.registry);
    let start = performance.now();
    const bytes = await data.payload.arrayBuffer();
    const blobReadMs = performance.now() - start;
    start = performance.now();
    const raw = decodeVerifiedSaveTransfer(bytes, data.verification);
    const verifyDecodeMs = performance.now() - start;
    start = performance.now();
    const state = parseTrustedWorkerEnvelope(raw, data.verification, data.registry);
    const parseNormalizeMs = performance.now() - start;
    self.postMessage({ state, workerTimings: { blobReadMs, verifyDecodeMs, parseNormalizeMs } });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally { self.close(); }
};
