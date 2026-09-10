import {
  decodeVerifiedSaveTransfer,
  matchesSaveEnvelopeFrame,
  rewrapVerifiedPrimarySaveAsSnapshot,
  type SaveTransferOptions,
  type SaveTransferVerification,
} from "./saveTransfer";

export interface SnapshotSaveRewrapRequest {
  id: number;
  raw: string;
  verification: SaveTransferVerification;
  source: Pick<SaveTransferOptions, "formatVersion" | "savedAt" | "mode">;
  savedAt: number;
  reason: string;
}

export type SnapshotSaveRewrapResponse = {
  id: number;
  bytes: ArrayBuffer;
  verification: SaveTransferVerification;
} | { id: number; error: "snapshot-rewrap-failed" };

type SnapshotSaveRewrapResult = NonNullable<ReturnType<typeof rewrapVerifiedPrimarySaveAsSnapshot>>;
let requestSequence = 0;

/** Reframe only a verified primary's text. This protocol never carries GameState. */
export function rewrapVerifiedPrimarySaveAsSnapshotInWorker(
  raw: string,
  verification: SaveTransferVerification,
  source: SnapshotSaveRewrapRequest["source"],
  savedAt: number,
  reason: string,
): Promise<SnapshotSaveRewrapResult | null> {
  if (typeof Worker === "undefined") {
    try {
      return Promise.resolve(rewrapVerifiedPrimarySaveAsSnapshot(raw, verification, source, savedAt, reason));
    } catch {
      return Promise.resolve(null);
    }
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL("./snapshotSaveRewrap.worker.ts", import.meta.url), { type: "module", name: "save-snapshot-rewrap" });
  } catch {
    return Promise.resolve(null);
  }
  const id = ++requestSequence;
  const expectedChecksum = verification.stateChecksum;
  const expectedHeader: SaveTransferOptions = { ...source, savedAt, reason, kind: "snapshot", slot: "main" };
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: SnapshotSaveRewrapResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* the Worker may already have exited */ }
      resolve(result);
    };
    timer = setTimeout(() => finish(null), 30_000);
    worker.onerror = () => finish(null);
    worker.onmessageerror = () => finish(null);
    worker.onmessage = (event: MessageEvent<SnapshotSaveRewrapResponse>) => {
      if (settled || !event.data || event.data.id !== id) return;
      try {
        const message = event.data;
        if (!("bytes" in message) || !(message.bytes instanceof ArrayBuffer) ||
          message.verification?.stateChecksum !== expectedChecksum) {
          finish(null);
          return;
        }
        const snapshotRaw = decodeVerifiedSaveTransfer(message.bytes, message.verification);
        if (!matchesSaveEnvelopeFrame(snapshotRaw, expectedHeader, expectedChecksum)) {
          finish(null);
          return;
        }
        finish({ raw: snapshotRaw, verification: message.verification });
      } catch {
        finish(null);
      }
    };
    try {
      worker.postMessage({ id, raw, verification, source, savedAt, reason } satisfies SnapshotSaveRewrapRequest);
    } catch {
      finish(null);
    }
  });
}
