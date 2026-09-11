/// <reference lib="webworker" />

import { rewrapVerifiedPrimarySaveAsSnapshot } from "./saveTransfer";
import type { SnapshotSaveRewrapRequest, SnapshotSaveRewrapResponse } from "./snapshotSaveRewrap";

self.onmessage = (event: MessageEvent<SnapshotSaveRewrapRequest>) => {
  const request = event.data;
  try {
    const result = rewrapVerifiedPrimarySaveAsSnapshot(request.raw, request.verification, request.source, request.savedAt, request.reason);
    request.raw = "";
    if (!result) throw new Error("snapshot source rejected");
    const bytes = new TextEncoder().encode(result.raw);
    if (bytes.byteLength !== result.verification.byteLength) throw new Error("snapshot encoding length mismatch");
    self.postMessage({
      id: request.id,
      bytes: bytes.buffer,
      verification: result.verification,
    } satisfies SnapshotSaveRewrapResponse, [bytes.buffer]);
  } catch {
    self.postMessage({ id: request.id, error: "snapshot-rewrap-failed" } satisfies SnapshotSaveRewrapResponse);
  }
};
