import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulationRuntimeDurableTransferCheckpoint } from "./simulationRuntimeDurableRecovery";
import {
  SimulationRuntimeRecoveryPersistenceClient,
  SimulationRuntimeRecoveryPersistenceClientError,
} from "./simulationRuntimeRecoveryPersistenceClient";
import type {
  SimulationRuntimeRecoveryPersistenceRequest,
  SimulationRuntimeRecoveryPersistenceResponse,
} from "./simulationRuntimeRecoveryPersistenceProtocol";

const fence = { ownerId: "test-owner", fencingToken: 7 };

function transferCheckpoint(bytes = [1, 2, 3, 4]): SimulationRuntimeDurableTransferCheckpoint {
  const buffer = Uint8Array.from(bytes).buffer;
  return {
    schemaVersion: 1,
    sessionId: "session-client",
    generation: 1,
    lastSequence: 0,
    stateRevision: 0,
    registryFingerprint: "registry",
    registry: {} as never,
    committedAtMs: 1,
    baseIdentity: { mode: "normal", savedAt: 1, checksum: "checksum", revision: 1 },
    source: "transfer",
    transfer: {
      protocolVersion: 1,
      encoding: "raw",
      buffer,
      storedByteLength: buffer.byteLength,
      originalByteLength: buffer.byteLength,
      storedSha256: "a".repeat(64),
      originalSha256: "a".repeat(64),
    },
  };
}

const successResult = {
  ok: true as const,
  proof: {} as never,
  idempotent: false,
};

class FakeWorker {
  onmessage: ((event: MessageEvent<SimulationRuntimeRecoveryPersistenceResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  requests: SimulationRuntimeRecoveryPersistenceRequest[] = [];
  terminateCount = 0;

  postMessage(message: SimulationRuntimeRecoveryPersistenceRequest, transfer: Transferable[] = []): void {
    this.requests.push(structuredClone(message, { transfer }) as SimulationRuntimeRecoveryPersistenceRequest);
  }

  respond(response: SimulationRuntimeRecoveryPersistenceResponse, transfer: Transferable[] = []): void {
    const cloned = structuredClone(response, { transfer }) as SimulationRuntimeRecoveryPersistenceResponse;
    this.onmessage?.({ data: cloned } as MessageEvent<SimulationRuntimeRecoveryPersistenceResponse>);
  }

  crash(message = "fake crash"): void {
    this.onerror?.({ message, preventDefault: () => undefined } as ErrorEvent);
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SimulationRuntimeRecoveryPersistenceClient", () => {
  it("returns transfer checkpoint ownership on success and restores the caller checkpoint", async () => {
    const fake = new FakeWorker();
    const client = new SimulationRuntimeRecoveryPersistenceClient({ workerFactory: () => fake as unknown as Worker });
    const checkpoint = transferCheckpoint();
    const pending = client.initialize(checkpoint, fence);
    expect(checkpoint.transfer.buffer.byteLength).toBe(0);
    const request = fake.requests[0];
    expect(request.type).toBe("initialize");
    if (request.type !== "initialize" || request.checkpoint.source !== "transfer") throw new Error("bad request");
    const returned = request.checkpoint.transfer.buffer;
    fake.respond({
      id: request.id,
      type: "result",
      operation: "initialize",
      result: successResult,
      sourceCheckpointTransfer: returned,
    }, [returned]);
    const response = await pending;
    expect(response.result.ok).toBe(true);
    expect(response.sourceCheckpointTransfer).toBe(checkpoint.transfer.buffer);
    expect([...new Uint8Array(checkpoint.transfer.buffer)]).toEqual([1, 2, 3, 4]);
  });

  it("returns ownership on durable failure and permits an exact second transfer", async () => {
    const fake = new FakeWorker();
    const client = new SimulationRuntimeRecoveryPersistenceClient({ workerFactory: () => fake as unknown as Worker });
    const checkpoint = transferCheckpoint([5, 6, 7]);
    const first = client.initialize(checkpoint, fence);
    const firstRequest = fake.requests[0];
    if (firstRequest.type !== "initialize" || firstRequest.checkpoint.source !== "transfer") throw new Error("bad request");
    const firstBuffer = firstRequest.checkpoint.transfer.buffer;
    fake.respond({
      id: firstRequest.id,
      type: "result",
      operation: "initialize",
      result: { ok: false, reason: "quota", message: "quota", retryable: true, degraded: true },
      sourceCheckpointTransfer: firstBuffer,
    }, [firstBuffer]);
    expect((await first).result).toMatchObject({ ok: false, reason: "quota" });
    expect([...new Uint8Array(checkpoint.transfer.buffer)]).toEqual([5, 6, 7]);

    const retry = client.initialize(checkpoint, fence);
    expect(checkpoint.transfer.buffer.byteLength).toBe(0);
    const retryRequest = fake.requests[1];
    if (retryRequest.type !== "initialize" || retryRequest.checkpoint.source !== "transfer") throw new Error("bad retry");
    const retryBuffer = retryRequest.checkpoint.transfer.buffer;
    fake.respond({
      id: retryRequest.id,
      type: "result",
      operation: "initialize",
      result: successResult,
      sourceCheckpointTransfer: retryBuffer,
    }, [retryBuffer]);
    expect((await retry).result.ok).toBe(true);
    expect([...new Uint8Array(checkpoint.transfer.buffer)]).toEqual([5, 6, 7]);
  });

  it("restores ownership before surfacing a Worker operation error", async () => {
    const fake = new FakeWorker();
    const client = new SimulationRuntimeRecoveryPersistenceClient({ workerFactory: () => fake as unknown as Worker });
    const checkpoint = transferCheckpoint([8, 9]);
    const pending = client.initialize(checkpoint, fence);
    const request = fake.requests[0];
    if (request.type !== "initialize" || request.checkpoint.source !== "transfer") throw new Error("bad request");
    const returned = request.checkpoint.transfer.buffer;
    fake.respond({
      id: request.id,
      type: "error",
      operation: "initialize",
      message: "operation failed",
      sourceCheckpointTransfer: returned,
    }, [returned]);
    await expect(pending).rejects.toMatchObject({
      code: "worker-operation",
      ownershipLost: false,
      operation: "initialize",
    } satisfies Partial<SimulationRuntimeRecoveryPersistenceClientError>);
    expect([...new Uint8Array(checkpoint.transfer.buffer)]).toEqual([8, 9]);
  });

  it("terminates a hung Worker, rejects all pending work, and marks only transferred ownership lost", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const client = new SimulationRuntimeRecoveryPersistenceClient({
      workerFactory: () => {
        const fake = new FakeWorker();
        workers.push(fake);
        return fake as unknown as Worker;
      },
      smallOperationTimeoutMs: 20,
      transferCheckpointTimeoutMs: 20,
    });
    const checkpoint = transferCheckpoint([10]);
    const transferPromise = client.initialize(checkpoint, fence);
    const readPromise = client.read(checkpoint.baseIdentity, fence);
    const transferExpectation = expect(transferPromise).rejects.toMatchObject({
      code: "timeout",
      ownershipLost: true,
      operation: "initialize",
    } satisfies Partial<SimulationRuntimeRecoveryPersistenceClientError>);
    const readExpectation = expect(readPromise).rejects.toMatchObject({
      code: "worker-crash",
      ownershipLost: false,
      operation: "read",
    } satisfies Partial<SimulationRuntimeRecoveryPersistenceClientError>);
    await vi.advanceTimersByTimeAsync(21);
    await Promise.all([transferExpectation, readExpectation]);
    expect(checkpoint.transfer.buffer.byteLength).toBe(0);
    expect(workers[0].terminateCount).toBe(1);

    // A late response from the terminated Worker is ignored, and the next
    // request uses a fresh Worker instead of reviving stale pending state.
    const staleRequest = workers[0].requests[0];
    workers[0].respond({
      id: staleRequest.id,
      type: "error",
      operation: "initialize",
      message: "late",
    });
    const next = client.read(checkpoint.baseIdentity, fence);
    expect(workers).toHaveLength(2);
    const nextRequest = workers[1].requests[0];
    workers[1].respond({
      id: nextRequest.id,
      type: "result",
      operation: "read",
      result: { ok: true, recovery: null, proof: null },
    });
    await expect(next).resolves.toMatchObject({ ok: true, recovery: null });
  });

  it("starts timeouts only after FIFO dispatch so a queued small request cannot kill a long transfer", async () => {
    vi.useFakeTimers();
    const fake = new FakeWorker();
    const client = new SimulationRuntimeRecoveryPersistenceClient({
      workerFactory: () => fake as unknown as Worker,
      smallOperationTimeoutMs: 20,
      transferCheckpointTimeoutMs: 100,
    });
    const checkpoint = transferCheckpoint([13, 14]);
    const transferPromise = client.initialize(checkpoint, fence);
    const readPromise = client.read(checkpoint.baseIdentity, fence);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].type).toBe("initialize");

    await vi.advanceTimersByTimeAsync(50);
    expect(fake.terminateCount).toBe(0);
    expect(fake.requests).toHaveLength(1);
    const transferRequest = fake.requests[0];
    if (transferRequest.type !== "initialize" || transferRequest.checkpoint.source !== "transfer") throw new Error("bad request");
    const returned = transferRequest.checkpoint.transfer.buffer;
    fake.respond({
      id: transferRequest.id,
      type: "result",
      operation: "initialize",
      result: successResult,
      sourceCheckpointTransfer: returned,
    }, [returned]);
    await expect(transferPromise).resolves.toMatchObject({ result: { ok: true } });

    expect(fake.requests).toHaveLength(2);
    const readRequest = fake.requests[1];
    expect(readRequest.type).toBe("read");
    await vi.advanceTimersByTimeAsync(19);
    expect(fake.terminateCount).toBe(0);
    fake.respond({
      id: readRequest.id,
      type: "result",
      operation: "read",
      result: { ok: true, recovery: null, proof: null },
    });
    await expect(readPromise).resolves.toMatchObject({ ok: true, recovery: null });
  });

  it("terminate rejects an inflight transfer as ownership-lost but keeps queued transfer ownership", async () => {
    const fake = new FakeWorker();
    const client = new SimulationRuntimeRecoveryPersistenceClient({ workerFactory: () => fake as unknown as Worker });
    const inflightCheckpoint = transferCheckpoint([15]);
    const queuedCheckpoint = transferCheckpoint([16]);
    const inflight = client.initialize(inflightCheckpoint, fence);
    const queued = client.initialize(queuedCheckpoint, fence);
    expect(inflightCheckpoint.transfer.buffer.byteLength).toBe(0);
    expect(queuedCheckpoint.transfer.buffer.byteLength).toBe(1);
    expect(fake.requests).toHaveLength(1);

    const inflightExpectation = expect(inflight).rejects.toMatchObject({
      code: "terminated",
      ownershipLost: true,
    } satisfies Partial<SimulationRuntimeRecoveryPersistenceClientError>);
    const queuedExpectation = expect(queued).rejects.toMatchObject({
      code: "terminated",
      ownershipLost: false,
    } satisfies Partial<SimulationRuntimeRecoveryPersistenceClientError>);
    client.terminate();
    await Promise.all([inflightExpectation, queuedExpectation]);
    expect(queuedCheckpoint.transfer.buffer.byteLength).toBe(1);
    expect(fake.terminateCount).toBe(1);
  });

  it("marks checkpoint ownership lost on Worker crash", async () => {
    const fake = new FakeWorker();
    const client = new SimulationRuntimeRecoveryPersistenceClient({ workerFactory: () => fake as unknown as Worker });
    const checkpoint = transferCheckpoint([11, 12]);
    const pending = client.initialize(checkpoint, fence);
    const expectation = expect(pending).rejects.toMatchObject({
      code: "worker-crash",
      ownershipLost: true,
      operation: "initialize",
    } satisfies Partial<SimulationRuntimeRecoveryPersistenceClientError>);
    fake.crash();
    await expectation;
    expect(checkpoint.transfer.buffer.byteLength).toBe(0);
    expect(fake.terminateCount).toBe(1);
  });
});
