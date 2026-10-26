import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "./engine";
import { createContentPackRegistry } from "./contentPacks";
import { projectPersistentSaveState } from "./saveProjection";
import * as transfer from "./saveTransfer";
import * as decode from "./saveTransferDecode";
import { serializeEnvelope, serializeEnvelopeInWorker } from "./storage";
import type { SaveWorkerRequest, SaveWorkerResponse } from "./saveWorkerProtocol";

class FakeWorker {
  onmessage: ((event: MessageEvent<SaveWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request: SaveWorkerRequest | null = null;
  terminateCount = 0;
  postMessage(request: SaveWorkerRequest) { this.request = structuredClone(request); }
  terminate() { this.terminateCount++; }
  respond(response: SaveWorkerResponse) { this.onmessage?.({ data: response } as MessageEvent<SaveWorkerResponse>); }
}

function install(worker: FakeWorker) {
  vi.stubGlobal("Worker", class { constructor() { return worker; } });
}

const savedAt = 1_800_000_000_000;
function fixture(large = false) {
  const state = createInitialState(19);
  if (large) state.entities = Array.from({ length: 8_000 }, (_, index) => ({ ...state.entities[0], id: `entity-${index}` }));
  const persistent = projectPersistentSaveState(state, createContentPackRegistry());
  const serialized = transfer.serializeSaveEnvelopeToTransfer(persistent, {
    formatVersion: 2, savedAt, kind: "primary", mode: "normal", slot: "main",
  });
  const raw = transfer.decodeVerifiedSaveTransfer(serialized.bytes, serialized);
  if (large && serialized.byteLength < 1024 * 1024) throw new Error("Fixture must exercise the cooperative path");
  return { state, serialized, raw };
}

function receipt(worker: FakeWorker, data: ReturnType<typeof fixture>): SaveWorkerResponse {
  return {
    id: worker.request!.id, ...data.serialized,
    summary: { stateVersion: data.state.version, savedAt, elapsedSeconds: data.state.elapsedSeconds,
      activePlanetId: data.state.activePlanetId, entityCount: data.state.entities.length,
      completedTechCount: 0, structurePoints: 0, uploadedWhiteMatrix: 0,
      stateChecksum: data.serialized.stateChecksum, computedStateChecksum: data.serialized.stateChecksum, integrity: "valid" },
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("background save response decoding", () => {
  it("retains the small payload path and exact save bytes", async () => {
    const data = fixture();
    const worker = new FakeWorker(); install(worker);
    const chunked = vi.spyOn(decode, "decodeVerifiedSaveTransferChunked");
    const pending = serializeEnvelopeInWorker(data.state, savedAt);
    expect(worker.request!.state).toEqual(data.state);
    expect(worker.request!.state).not.toBe(data.state);
    worker.respond(receipt(worker, data));
    expect(await pending).toMatchObject({ raw: data.raw, usedWorker: true });
    expect(chunked).not.toHaveBeenCalled();
    expect(worker.terminateCount).toBe(1);
  });

  it("waits for complete large-payload verification and ignores duplicate responses", async () => {
    const data = fixture(true);
    const worker = new FakeWorker(); install(worker);
    let finishDecode!: (raw: string) => void;
    const chunked = vi.spyOn(decode, "decodeVerifiedSaveTransferChunked")
      .mockImplementation(() => new Promise((resolve) => { finishDecode = resolve; }));
    let finished = false;
    const pending = serializeEnvelopeInWorker(data.state, savedAt).then((result) => { finished = true; return result; });
    const response = receipt(worker, data);
    worker.respond(response); worker.respond(response);
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(chunked).toHaveBeenCalledTimes(1);
    expect(worker.terminateCount).toBe(0);
    finishDecode(data.raw);
    expect(await pending).toMatchObject({ raw: data.raw, usedWorker: true });
    expect(worker.terminateCount).toBe(1);
  });

  it("aborts an unfinished decode on worker failure and retains the original source for fallback", async () => {
    const data = fixture(true);
    const worker = new FakeWorker(); install(worker);
    let finishDecode!: (raw: string) => void;
    const chunked = vi.spyOn(decode, "decodeVerifiedSaveTransferChunked")
      .mockImplementation(() => new Promise((resolve) => { finishDecode = resolve; }));
    const pending = serializeEnvelopeInWorker(data.state, savedAt);
    worker.respond(receipt(worker, data));
    const failure = worker.onerror!;
    failure(); failure();
    expect(await pending).toMatchObject({ raw: data.raw, usedWorker: false });
    expect(chunked.mock.calls[0][2]?.signal?.aborted).toBe(true);
    finishDecode("late response must not win");
    await Promise.resolve();
    expect(worker.terminateCount).toBe(1);
    expect(serializeEnvelope(data.state, savedAt)).toBe(data.raw);
  });

  it("rejects corrupted large bytes and falls back without accepting partial text", async () => {
    const data = fixture(true);
    const worker = new FakeWorker(); install(worker);
    const pending = serializeEnvelopeInWorker(data.state, savedAt);
    const response = receipt(worker, data);
    response.bytes = response.bytes!.slice(0);
    new Uint8Array(response.bytes)[response.bytes.byteLength - 1] ^= 1;
    worker.respond(response);
    expect(await pending).toMatchObject({ raw: data.raw, usedWorker: false });
    expect(worker.terminateCount).toBe(1);
  });

  it("reports a failed fallback instead of leaving the save promise pending", async () => {
    const data = fixture();
    const worker = new FakeWorker(); install(worker);
    const pending = serializeEnvelopeInWorker(data.state, savedAt);
    vi.spyOn(transfer, "serializeSaveEnvelopeToTransfer").mockImplementation(() => { throw new Error("serialization failed"); });
    worker.onmessageerror!();
    await expect(pending).rejects.toThrow("serialization failed");
    expect(worker.terminateCount).toBe(1);
  });

  it("falls back on a malformed message without leaving an unhandled async rejection", async () => {
    const data = fixture();
    const worker = new FakeWorker(); install(worker);
    const pending = serializeEnvelopeInWorker(data.state, savedAt);
    worker.respond(null as unknown as SaveWorkerResponse);
    expect(await pending).toMatchObject({ raw: data.raw, usedWorker: false });
    expect(worker.terminateCount).toBe(1);
  });

  it("keeps source state available when starting a Worker fails", async () => {
    const data = fixture();
    vi.stubGlobal("Worker", class { constructor() { throw new Error("worker unavailable"); } });
    expect(await serializeEnvelopeInWorker(data.state, savedAt)).toMatchObject({ raw: data.raw, usedWorker: false });
  });

  it("retains a verified fallback when posting a source fails", async () => {
    const data = fixture();
    const worker = new FakeWorker(); install(worker);
    worker.postMessage = () => { throw new Error("post failed"); };
    expect(await serializeEnvelopeInWorker(data.state, savedAt)).toMatchObject({ raw: data.raw, usedWorker: false });
    expect(worker.terminateCount).toBe(1);
  });

  it("keeps SHA-256 upload requests on the original binary transport", async () => {
    const data = fixture();
    const worker = new FakeWorker(); install(worker);
    const pending = serializeEnvelopeInWorker(data.state, savedAt, "primary", undefined, "main", true);
    expect(worker.request!.includePayloadSha256).toBe(true);
    const response = { ...receipt(worker, data), payloadSha256: "a".repeat(64) };
    worker.respond(response);
    expect(await pending).toMatchObject({ usedWorker: true, raw: data.raw, payloadSha256: "a".repeat(64) });
  });

  it("rejects mismatched byte lengths and uses the intact source", async () => {
    const data = fixture();
    const worker = new FakeWorker(); install(worker);
    const pending = serializeEnvelopeInWorker(data.state, savedAt);
    worker.respond({ ...receipt(worker, data), byteLength: data.serialized.byteLength + 1 });
    expect(await pending).toMatchObject({ usedWorker: false, raw: data.raw });
  });
});
