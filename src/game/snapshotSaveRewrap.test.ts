import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeSavePayloadTextChecksum,
  decodeVerifiedSaveTransfer,
  rewrapVerifiedPrimarySaveAsSnapshot,
  serializeSaveEnvelopeToTransfer,
  type SaveTransferVerification,
} from "./saveTransfer";
import { rewrapVerifiedPrimarySaveAsSnapshotInWorker, type SnapshotSaveRewrapRequest, type SnapshotSaveRewrapResponse } from "./snapshotSaveRewrap";

function fixture() {
  const source = { formatVersion: 2, mode: "normal" as const, savedAt: 1800000000000 };
  const state = { version: 47, mode: "normal", name: "磁石🚀\ud800工厂", nested: { value: 123 } };
  const primary = serializeSaveEnvelopeToTransfer(state, { ...source, kind: "primary", slot: "main" });
  const { integrity, stateChecksum, payloadChecksum, byteLength } = primary;
  return { source, raw: decodeVerifiedSaveTransfer(primary.bytes, primary), verification: { integrity, stateChecksum, payloadChecksum, byteLength }, savedAt: source.savedAt + 1000, reason: "自动快照" };
}

function responseFor(request: SnapshotSaveRewrapRequest): Extract<SnapshotSaveRewrapResponse, { bytes: unknown }> {
  const result = rewrapVerifiedPrimarySaveAsSnapshot(request.raw, request.verification, request.source, request.savedAt, request.reason)!;
  return { id: request.id, bytes: new TextEncoder().encode(result.raw).buffer, verification: result.verification };
}

const workers: MockWorker[] = [];
let throwOnPost = false;
class MockWorker {
  onmessage: ((event: MessageEvent<SnapshotSaveRewrapResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((_request: SnapshotSaveRewrapRequest) => {
    if (throwOnPost) throw new Error("synthetic clone failure");
  });
  constructor(readonly url: URL, readonly options: WorkerOptions) { workers.push(this); }
  respond(message: SnapshotSaveRewrapResponse) { this.onmessage?.({ data: message } as MessageEvent<SnapshotSaveRewrapResponse>); }
}

function start() {
  const input = fixture();
  const pending = rewrapVerifiedPrimarySaveAsSnapshotInWorker(input.raw, input.verification, input.source, input.savedAt, input.reason);
  return { input, pending, worker: workers[workers.length - 1] };
}

describe("snapshot text rewrap Worker client", () => {
  beforeEach(() => {
    workers.length = 0;
    throwOnPost = false;
    vi.stubGlobal("Worker", MockWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends only text/proof/header and binds returned bytes to the requested snapshot", async () => {
    const { pending, worker, input } = start();
    expect(worker.options).toEqual({ type: "module", name: "save-snapshot-rewrap" });
    const request = worker.postMessage.mock.calls[0][0];
    expect(Object.keys(request).sort()).toEqual(["id", "raw", "reason", "savedAt", "source", "verification"]);
    expect(request).toMatchObject(input);
    worker.respond(responseFor(request));
    await expect(pending).resolves.toEqual(rewrapVerifiedPrimarySaveAsSnapshot(input.raw, input.verification, input.source, input.savedAt, input.reason));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  for (const fault of ["length", "payload-hash", "state-checksum", "savedAt", "kind", "mode", "reason"] as const) {
    it(`declines a returned ${fault} mismatch for the original serializer fallback`, async () => {
      const { pending, worker } = start();
      const request = worker.postMessage.mock.calls[0][0];
      const response = responseFor(request);
      if (fault === "length") response.verification.byteLength += 1;
      else if (fault === "payload-hash") new Uint8Array(response.bytes)[response.bytes.byteLength - 1] ^= 1;
      else if (fault === "state-checksum") response.verification.stateChecksum = "00000000";
      else {
        const raw = decodeVerifiedSaveTransfer(response.bytes, response.verification);
        const changed = fault === "savedAt" ? raw.replace(`"savedAt":${request.savedAt}`, `"savedAt":${request.savedAt + 1}`)
          : fault === "kind" ? raw.replace('"kind":"snapshot"', '"kind":"primary"')
            : fault === "mode" ? raw.replace('"mode":"normal"', '"mode":"speedrun"')
              : raw.replace('"reason":"自动快照"', '"reason":"另一次快照"');
        const payload = computeSavePayloadTextChecksum(changed);
        response.bytes = new TextEncoder().encode(changed).buffer;
        response.verification = { ...response.verification, payloadChecksum: payload.checksum, byteLength: payload.byteLength };
      }
      worker.respond(response);
      await expect(pending).resolves.toBeNull();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    });
  }

  it("times out after 30 seconds and ignores late or unrelated replies", async () => {
    vi.useFakeTimers();
    const { pending, worker } = start();
    const request = worker.postMessage.mock.calls[0][0];
    worker.respond({ ...responseFor(request), id: request.id + 1 });
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBeNull();
    worker.respond(responseFor(request));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const failure of ["construction", "post", "error", "message-error", "rejection"] as const) {
    it(`returns null on Worker ${failure} failure`, async () => {
      if (failure === "construction") vi.stubGlobal("Worker", class { constructor() { throw new Error("synthetic construction failure"); } });
      if (failure === "post") throwOnPost = true;
      const { pending, worker } = start();
      if (failure === "error") worker.onerror?.();
      if (failure === "message-error") worker.onmessageerror?.();
      if (failure === "rejection") worker.respond({ id: worker.postMessage.mock.calls[0][0].id, error: "snapshot-rewrap-failed" });
      await expect(pending).resolves.toBeNull();
      if (failure !== "construction") expect(worker.terminate).toHaveBeenCalledTimes(1);
    });
  }

  it("retains strict synchronous compatibility only when Worker is unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    const input = fixture();
    await expect(rewrapVerifiedPrimarySaveAsSnapshotInWorker(input.raw, input.verification, input.source, input.savedAt, input.reason))
      .resolves.toEqual(rewrapVerifiedPrimarySaveAsSnapshot(input.raw, input.verification, input.source, input.savedAt, input.reason));
    await expect(rewrapVerifiedPrimarySaveAsSnapshotInWorker(input.raw, { ...input.verification, payloadChecksum: "00000000" }, input.source, input.savedAt, input.reason))
      .resolves.toBeNull();
  });
});

describe("snapshot text rewrap Worker handler", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("transfers verified bytes and rejects corrupt primary text without a state payload", async () => {
    const postMessage = vi.fn();
    const scope = { onmessage: null as ((event: MessageEvent<SnapshotSaveRewrapRequest>) => void) | null, postMessage };
    vi.stubGlobal("self", scope);
    await import("./snapshotSaveRewrap.worker");
    const input = fixture();
    const request = { ...input, id: 7 };
    scope.onmessage!({ data: request } as MessageEvent<SnapshotSaveRewrapRequest>);
    const response = postMessage.mock.calls[0][0] as { bytes: ArrayBuffer; verification: SaveTransferVerification };
    expect(postMessage.mock.calls[0][1]).toEqual([response.bytes]);
    const expected = rewrapVerifiedPrimarySaveAsSnapshot(input.raw, input.verification, input.source, input.savedAt, input.reason)!;
    expect(decodeVerifiedSaveTransfer(response.bytes, response.verification)).toBe(expected.raw);
    expect(request.raw).toBe("");
    scope.onmessage!({ data: { ...input, id: 8, raw: input.raw.replace('"value":123', '"value":124') } } as MessageEvent<SnapshotSaveRewrapRequest>);
    expect(postMessage.mock.calls[1]).toEqual([{ id: 8, error: "snapshot-rewrap-failed" }]);
  });
});
