import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthoritativeSaveSerializationClientError,
  serializeAuthoritativeSaveStateInWorker,
  serializeAuthoritativePrimarySaveInWorker,
  serializeAuthoritativeSaveStateTransferInWorker,
} from "./authoritativeSaveSerializationClient";
import { createInitialState } from "./engine";
import type {
  AuthoritativeSaveSerializationRequest,
  AuthoritativeSaveSerializationResponse,
} from "./authoritativeSaveSerializationProtocol";
import type { SimulationStateTransfer } from "./simulationRuntimeProtocol";
import { SaveStateChunkAssembler, type SaveStateChunkRequest } from "./saveStateChunkTransfer";

class FakeWorker {
  onmessage: ((event: MessageEvent<AuthoritativeSaveSerializationResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  request: AuthoritativeSaveSerializationRequest | null = null;
  terminateCount = 0;

  constructor(private readonly throwAfterTransfer = false) {}

  postMessage(message: AuthoritativeSaveSerializationRequest, transfer: Transferable[] = []): void {
    this.request = structuredClone(message, { transfer }) as AuthoritativeSaveSerializationRequest;
    if (this.throwAfterTransfer) throw new Error("post failed after transfer");
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

class FakeChunkWorker extends FakeWorker {
  readonly parts: SaveStateChunkRequest[] = [];
  readonly assembler = new SaveStateChunkAssembler();
  hold = false;
  override postMessage(message: AuthoritativeSaveSerializationRequest | SaveStateChunkRequest, transfer: Transferable[] = []): void {
    if (!("type" in message)) return super.postMessage(message, transfer);
    const copy = structuredClone(message);
    this.parts.push(copy);
    if (this.hold) return;
    const received = this.assembler.accept(copy);
    if ("ack" in received) queueMicrotask(() => this.onmessage?.({ data: { id: copy.id, stateChunkAck: received.ack } } as MessageEvent<AuthoritativeSaveSerializationResponse>));
    else this.request = received.request;
  }
}

function stateTransfer(): SimulationStateTransfer {
  const buffer = Uint8Array.from([1, 2, 3]).buffer;
  return { protocolVersion: 1, byteLength: buffer.byteLength, buffer };
}

function installWorker(worker: FakeWorker): void {
  vi.stubGlobal("Worker", class {
    constructor() { return worker; }
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("authoritative save serialization transfer ownership", () => {
  it("assembles the exact canonical snapshot on a fresh chunked retry after Worker failure", async () => {
    const state = createInitialState(44_127);
    state.entities = Array.from({ length: 601 }, (_, index) => ({ ...state.entities[0], id: `canonical-${index}` }));
    const before = JSON.stringify(state);
    for (let retry = 0; retry < 2; retry += 1) {
      const worker = new FakeChunkWorker(); installWorker(worker);
      const pending = serializeAuthoritativePrimarySaveInWorker(state, { frozenStateIsCurrent: () => true });
      await vi.waitFor(() => expect(worker.request?.state).toBeDefined());
      expect(JSON.stringify(worker.request!.state)).toBe(before);
      expect(worker.parts.map((part) => part.type)).toEqual(["state-begin", "state-records", "state-records", "state-complete"]);
      worker.onmessage?.({ data: { id: 1, error: "injected-after-assembly" } } as MessageEvent<AuthoritativeSaveSerializationResponse>);
      await expect(pending).rejects.toMatchObject({ code: "worker-operation", ownershipLost: false });
      expect(JSON.stringify(state)).toBe(before);
      expect(worker.terminateCount).toBe(1);
    }
  });

  it.each(["abort", "crash", "bad-ack", "early-result"] as const)("releases an outstanding chunk on %s", async (failure) => {
    const worker = new FakeChunkWorker(); worker.hold = true; installWorker(worker);
    const state = createInitialState(); const before = JSON.stringify(state);
    const controller = new AbortController();
    const pending = serializeAuthoritativePrimarySaveInWorker(state, { frozenStateIsCurrent: () => true, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ ownershipLost: false,
      code: failure === "abort" ? "aborted" : failure === "crash" ? "worker-crash" : "protocol" });
    if (failure === "abort") controller.abort();
    else if (failure === "crash") worker.onerror?.({ message: "chunk-crash" } as ErrorEvent);
    else worker.onmessage?.({ data: failure === "early-result" ? { id: 1 } : {
      id: 1, stateChunkAck: { type: "state-chunk-ack", id: 2, collection: "begin", nextOffset: 0 },
    } } as MessageEvent<AuthoritativeSaveSerializationResponse>);
    await rejected;
    expect(worker.parts).toHaveLength(1);
    expect(worker.terminateCount).toBe(1);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("times out a held chunk without losing the caller snapshot", async () => {
    vi.useFakeTimers();
    const worker = new FakeChunkWorker(); worker.hold = true; installWorker(worker);
    const pending = serializeAuthoritativePrimarySaveInWorker(createInitialState(), { frozenStateIsCurrent: () => true, timeoutMs: 10 });
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout", ownershipLost: false });
    await vi.advanceTimersByTimeAsync(11); await rejected;
    expect(worker.parts).toHaveLength(1);
    expect(worker.terminateCount).toBe(1);
  });

  it("rejects an expired snapshot before sending any records", async () => {
    const worker = new FakeChunkWorker(); installWorker(worker);
    await expect(serializeAuthoritativePrimarySaveInWorker(createInitialState(), { frozenStateIsCurrent: () => false }))
      .rejects.toMatchObject({ code: "protocol", ownershipLost: false });
    expect(worker.parts).toHaveLength(0);
    expect(worker.terminateCount).toBe(1);
  });

  it("refuses chunked transport for the state-returning API", async () => {
    const worker = new FakeChunkWorker(); installWorker(worker);
    await expect(serializeAuthoritativeSaveStateInWorker(createInitialState(), { frozenStateIsCurrent: () => true }))
      .rejects.toMatchObject({ code: "unsupported", ownershipLost: false });
    expect(worker.parts).toHaveLength(0);
    expect(worker.request).toBeNull();
  });
  for (const serialize of [serializeAuthoritativeSaveStateInWorker, serializeAuthoritativePrimarySaveInWorker]) {
  it(`retains the caller state on ${serialize.name} failure and permits a fresh retry`, async () => {
    const state = createInitialState(44_127);
    state.entities[0].inputs.iron_ore = 137;
    const original = structuredClone(state);
    for (const failure of ["crash", "abort"] as const) {
      const worker = new FakeWorker();
      installWorker(worker);
      const controller = new AbortController();
      const pending = serialize(state, { signal: controller.signal });
      expect(worker.request?.state).toEqual(original);
      expect(worker.request?.state).not.toBe(state);
      worker.request!.state!.entities[0].inputs.iron_ore = 999;
      if (failure === "crash") worker.onerror?.({ message: "controlled crash" } as ErrorEvent);
      else controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: failure === "crash" ? "worker-crash" : "aborted", ownershipLost: false,
      });
      expect(state).toEqual(original);
      expect(worker.terminateCount).toBe(1);
    }
  });
  }

  it("marks a transferred source as lost when the Worker times out", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    installWorker(worker);
    const transfer = stateTransfer();
    const pending = serializeAuthoritativeSaveStateTransferInWorker(transfer, { timeoutMs: 10 });
    expect(transfer.buffer.byteLength).toBe(0);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "timeout",
      ownershipLost: true,
    } satisfies Partial<AuthoritativeSaveSerializationClientError>);
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(worker.terminateCount).toBe(1);
  });

  it("reports abort and message-deserialization failures with detached ownership", async () => {
    const abortWorker = new FakeWorker();
    installWorker(abortWorker);
    const abortController = new AbortController();
    const abortedTransfer = stateTransfer();
    const aborted = serializeAuthoritativeSaveStateTransferInWorker(abortedTransfer, { signal: abortController.signal });
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted", ownershipLost: true });

    const messageWorker = new FakeWorker();
    installWorker(messageWorker);
    const messageTransfer = stateTransfer();
    const messageFailure = serializeAuthoritativeSaveStateTransferInWorker(messageTransfer);
    messageWorker.onmessageerror?.({ data: null } as MessageEvent);
    await expect(messageFailure).rejects.toMatchObject({ code: "protocol", ownershipLost: true });
  });

  it("detects ownership loss when postMessage throws after transferring", async () => {
    const worker = new FakeWorker(true);
    installWorker(worker);
    const transfer = stateTransfer();
    await expect(serializeAuthoritativeSaveStateTransferInWorker(transfer)).rejects.toMatchObject({
      code: "worker-operation",
      ownershipLost: true,
    });
    expect(transfer.buffer.byteLength).toBe(0);
  });

  it("keeps ownership when cancellation happens before dispatch", async () => {
    const worker = new FakeWorker();
    installWorker(worker);
    const controller = new AbortController();
    controller.abort();
    const transfer = stateTransfer();
    await expect(serializeAuthoritativeSaveStateTransferInWorker(transfer, { signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
      ownershipLost: false,
    });
    expect(transfer.buffer.byteLength).toBe(3);
    expect(worker.request).toBeNull();
  });
});
