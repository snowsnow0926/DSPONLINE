import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthoritativeSaveSerializationClientError,
  serializeAuthoritativeSaveStateInWorker,
  serializeAuthoritativeSaveStateTransferInWorker,
} from "./authoritativeSaveSerializationClient";
import { createInitialState } from "./engine";
import type {
  AuthoritativeSaveSerializationRequest,
  AuthoritativeSaveSerializationResponse,
} from "./authoritativeSaveSerializationProtocol";
import type { SimulationStateTransfer } from "./simulationRuntimeProtocol";

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
  it("retains the caller state when a cloned-state Worker crashes, then permits a fresh retry", async () => {
    const state = createInitialState(44_127);
    state.entities[0].inputs.iron_ore = 137;
    const original = structuredClone(state);
    for (const failure of ["crash", "abort"] as const) {
      const worker = new FakeWorker();
      installWorker(worker);
      const controller = new AbortController();
      const pending = serializeAuthoritativeSaveStateInWorker(state, { signal: controller.signal });
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
