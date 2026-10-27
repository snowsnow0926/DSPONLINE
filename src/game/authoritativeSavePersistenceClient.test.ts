import { afterEach, describe, expect, it, vi } from "vitest";
import { computeAuthoritativeSaveProofBindingSha256 } from "./authoritativeSaveProof";
import {
  AuthoritativeSavePersistenceClient,
  AuthoritativeSavePersistenceClientError,
  type AuthoritativeSavePayloadCommitInput,
} from "./authoritativeSavePersistenceClient";
import type {
  AuthoritativeSavePersistenceRequest,
  AuthoritativeSavePersistenceResponse,
} from "./authoritativeSavePersistenceProtocol";

const seed = {
  mode: "normal" as const,
  kind: "primary" as const,
  slot: "main" as const,
  savedAt: 1,
  stateVersion: 46,
  entityCount: 1,
  beltCount: 1,
  elapsedSeconds: 2,
  completedTechCount: 3,
  activePlanetId: "home",
  structurePoints: 4,
  stateChecksum: "1234abcd",
  modeExplicit: true as const,
  reason: null,
  settings: null,
};

async function input(bytes = [1, 2, 3]): Promise<AuthoritativeSavePayloadCommitInput> {
  const buffer = Uint8Array.from(bytes).buffer;
  const proofWithoutBinding = {
    integrity: "valid" as const,
    payloadChecksum: "01020304",
    payloadSha256: "a".repeat(64),
    byteLength: buffer.byteLength,
    stateChecksum: seed.stateChecksum,
    transportEncoding: "raw" as const,
    storedByteLength: buffer.byteLength,
    storedSha256: "a".repeat(64),
  };
  return {
    key: "dsp-idle-network.save.v1",
    bytes: buffer,
    proof: {
      ...proofWithoutBinding,
      bindingSha256: await computeAuthoritativeSaveProofBindingSha256(proofWithoutBinding, seed),
    },
    seed,
    expectedRevision: 0,
    fence: { ownerId: "tab_test", fencingToken: 7 },
  };
}

class FakeWorker {
  onmessage: ((event: MessageEvent<AuthoritativeSavePersistenceResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  requests: AuthoritativeSavePersistenceRequest[] = [];
  terminateCount = 0;

  postMessage(message: AuthoritativeSavePersistenceRequest, transfer: Transferable[] = []): void {
    this.requests.push(structuredClone(message, { transfer }) as AuthoritativeSavePersistenceRequest);
  }

  respond(response: AuthoritativeSavePersistenceResponse, transfer: Transferable[] = []): void {
    this.onmessage?.({ data: structuredClone(response, { transfer }) } as MessageEvent<AuthoritativeSavePersistenceResponse>);
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

class BlobFakeWorker {
  onmessage: ((event: MessageEvent<AuthoritativeSavePersistenceResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  request: AuthoritativeSavePersistenceRequest<Blob> | null = null;
  terminateCount = 0;

  postMessage(message: AuthoritativeSavePersistenceRequest<Blob>, transfer: Transferable[] = []): void {
    expect(transfer).toEqual([]);
    this.request = structuredClone(message) as AuthoritativeSavePersistenceRequest<Blob>;
  }

  respond(response: AuthoritativeSavePersistenceResponse): void {
    this.onmessage?.({ data: structuredClone(response) } as MessageEvent<AuthoritativeSavePersistenceResponse>);
  }

  terminate(): void { this.terminateCount += 1; }
}

function complete(worker: FakeWorker, ok = true): void {
  const request = worker.requests.at(-1)!;
  const payload = request.payload;
  worker.respond({ id: request.id, type: "result", result: ok ? {
    ok: true, proof: {
      key: request.key, revision: request.expectedRevision + 1, savedAt: request.seed.savedAt,
      byteLength: request.proof.byteLength, payloadChecksum: request.proof.payloadChecksum,
      payloadSha256: request.proof.payloadSha256, stateChecksum: request.seed.stateChecksum,
      transportEncoding: request.proof.transportEncoding, storedByteLength: request.proof.storedByteLength,
      backupKey: null, backupRevision: null, backupSaved: false,
      workerDecodeMs: 0, idbWriteMs: 0, backupVerifyMs: 0, totalBytesWritten: request.proof.byteLength,
    },
  } : { ok: false, reason: "quota", message: "quota", retryable: true, degraded: true },
  sourcePayloadTransfer: payload }, [payload]);
}

afterEach(() => vi.useRealTimers());

describe("AuthoritativeSavePersistenceClient", () => {
  it("retires a large immutable Blob after a controlled failure without losing the caller payload", async () => {
    vi.useFakeTimers();
    const worker = new BlobFakeWorker();
    const client = new AuthoritativeSavePersistenceClient({ workerFactory: () => worker as unknown as Worker, largePayloadThresholdBytes: 2 });
    const source = await input([3, 2, 1]);
    const blob = new Blob([source.bytes]);
    const pending = client.commit({ ...source, bytes: blob });
    worker.respond({ id: worker.request!.id, type: "result", result: {
      ok: false, reason: "quota", message: "quota", retryable: true, degraded: true,
    } });
    await expect(pending).resolves.toMatchObject({ result: { ok: false, reason: "quota" } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(worker.terminateCount).toBe(1);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([3, 2, 1]);
    client.terminate();
  });

  it("retires a drained large-payload generation and preserves a fresh commit from stale callbacks", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const client = new AuthoritativeSavePersistenceClient({ largePayloadThresholdBytes: 2,
      workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; } });
    const first = await input([1, 2, 3]);
    const pending = client.commit(first);
    const staleMessage = workers[0].onmessage, staleError = workers[0].onerror;
    complete(workers[0]);
    await expect(pending).resolves.toMatchObject({ result: { ok: true } });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(workers[0].terminateCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].terminateCount).toBe(1);
    expect([...new Uint8Array(first.bytes)]).toEqual([1, 2, 3]);
    const second = { ...await input([4, 5, 6]), expectedRevision: 7, preserveBackup: false };
    const next = client.commit(second);
    expect(workers).toHaveLength(2);
    expect(workers[1].requests[0]).toMatchObject({ expectedRevision: 7, preserveBackup: false, fence: second.fence });
    staleMessage?.({ data: { id: workers[1].requests[0].id, type: "error", message: "late" } } as MessageEvent<AuthoritativeSavePersistenceResponse>);
    staleError?.({ message: "late", preventDefault: () => undefined } as ErrorEvent);
    complete(workers[1]);
    await expect(next).resolves.toMatchObject({ result: { ok: true, proof: { revision: 8 } } });
    expect([...new Uint8Array(second.bytes)]).toEqual([4, 5, 6]);
    client.terminate();
  });

  it("waits for inflight and queued commits including a small final request", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new AuthoritativeSavePersistenceClient({ workerFactory: () => worker as unknown as Worker, largePayloadThresholdBytes: 2 });
    const large = await input([1, 2, 3]), small = await input([4]);
    const first = client.commit(large), second = client.commit(small);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.terminateCount).toBe(0);
    expect(small.bytes.byteLength).toBe(1);
    complete(worker); await first;
    expect(worker.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.terminateCount).toBe(0);
    complete(worker); await second;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(worker.terminateCount).toBe(1);
    expect([...new Uint8Array(small.bytes)]).toEqual([4]);
    client.terminate();
  });

  it("cancels an old idle deadline when a new commit reuses the generation", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new AuthoritativeSavePersistenceClient({ workerFactory: () => worker as unknown as Worker, largePayloadThresholdBytes: 2 });
    const first = await input(), second = await input([4, 5, 6]);
    const one = client.commit(first); complete(worker); await one;
    await vi.advanceTimersByTimeAsync(1_900);
    const two = client.commit(second);
    await vi.advanceTimersByTimeAsync(500);
    expect(worker.terminateCount).toBe(0);
    complete(worker); await two;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(worker.terminateCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.terminateCount).toBe(1);
    client.terminate();
  });

  it("returns a controlled failure payload before retiring and retries its exact bytes", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const client = new AuthoritativeSavePersistenceClient({ largePayloadThresholdBytes: 2,
      workerFactory: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; } });
    const source = await input([9, 8, 7]);
    const first = client.commit(source); complete(workers[0], false);
    await expect(first).resolves.toMatchObject({ result: { ok: false, reason: "quota" } });
    await vi.advanceTimersByTimeAsync(2_000);
    const retry = client.commit(source);
    expect([...new Uint8Array(workers[1].requests[0].payload)]).toEqual([9, 8, 7]);
    complete(workers[1]); await expect(retry).resolves.toMatchObject({ result: { ok: true } });
    client.terminate();
  });

  it("keeps small-save generations warm and never schedules their idle retirement", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new AuthoritativeSavePersistenceClient({ workerFactory: () => worker as unknown as Worker });
    const source = await input(); const pending = client.commit(source); complete(worker); await pending;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(worker.terminateCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    client.terminate();
  });

  it("pagehide clears an idle retirement and pageshow restarts without reviving the old generation", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const client = new AuthoritativeSavePersistenceClient({ largePayloadThresholdBytes: 2,
      workerFactory: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as Worker; } });
    const source = await input(); const pending = client.commit(source); complete(workers[0]); await pending;
    client.terminate();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(workers[0].terminateCount).toBe(1);
    await expect(client.commit(source)).rejects.toMatchObject({ code: "terminated", ownershipLost: false });
    client.resumeAfterPageshow();
    const next = client.commit(source); complete(workers[1]); await next;
    client.terminate();
  });

  it("returns payload ownership on success and typed controlled failure", async () => {
    const worker = new FakeWorker();
    const client = new AuthoritativeSavePersistenceClient({ workerFactory: () => worker as unknown as Worker });
    const commit = await input([4, 5, 6]);
    const pending = client.commit(commit);
    expect(commit.bytes.byteLength).toBe(0);
    const request = worker.requests[0];
    const returned = request.payload;
    worker.respond({ id: request.id, type: "result", result: {
      ok: true,
      proof: {
        key: commit.key, revision: 1, savedAt: 1, byteLength: 3,
        payloadChecksum: commit.proof.payloadChecksum, payloadSha256: commit.proof.payloadSha256,
        stateChecksum: seed.stateChecksum, transportEncoding: "raw", storedByteLength: 3,
        backupKey: null, backupRevision: null, backupSaved: false,
        workerDecodeMs: 1, idbWriteMs: 2, backupVerifyMs: 0, totalBytesWritten: 3,
      },
    }, sourcePayloadTransfer: returned }, [returned]);
    const result = await pending;
    expect(result.result.ok).toBe(true);
    expect([...new Uint8Array(commit.bytes)]).toEqual([4, 5, 6]);

    const retry = client.commit(commit);
    const retryRequest = worker.requests[1];
    const retryBuffer = retryRequest.payload;
    worker.respond({ id: retryRequest.id, type: "result", result: {
      ok: false, reason: "quota", message: "quota", retryable: true, degraded: true,
    }, sourcePayloadTransfer: retryBuffer }, [retryBuffer]);
    expect((await retry).result).toMatchObject({ ok: false, reason: "quota" });
    expect([...new Uint8Array(commit.bytes)]).toEqual([4, 5, 6]);
  });

  it("commits an immutable Blob carrier without detaching it or requiring an ownership return", async () => {
    const worker = new BlobFakeWorker();
    const client = new AuthoritativeSavePersistenceClient({ workerFactory: () => worker as unknown as Worker });
    const arrayInput = await input([11, 12, 13]);
    const blobInput: AuthoritativeSavePayloadCommitInput<Blob> = {
      ...arrayInput,
      bytes: new Blob([arrayInput.bytes], { type: "application/json" }),
    };
    const pending = client.commit(blobInput);
    expect(blobInput.bytes.size).toBe(3);
    const request = worker.request!;
    expect(request.payload).toBeInstanceOf(Blob);
    expect(request.payload.size).toBe(3);
    worker.respond({
      id: request.id,
      type: "result",
      result: {
        ok: true,
        proof: {
          key: blobInput.key,
          revision: 1,
          savedAt: 1,
          byteLength: 3,
          payloadChecksum: blobInput.proof.payloadChecksum,
          payloadSha256: blobInput.proof.payloadSha256,
          stateChecksum: seed.stateChecksum,
          transportEncoding: "raw",
          storedByteLength: 3,
          backupKey: null,
          backupRevision: null,
          backupSaved: false,
          workerDecodeMs: 1,
          idbWriteMs: 2,
          backupVerifyMs: 0,
          totalBytesWritten: 3,
        },
      },
    });
    const result = await pending;
    expect(result.result.ok).toBe(true);
    expect(result.sourcePayloadTransfer).toBeUndefined();
    expect(blobInput.bytes.size).toBe(3);
  });

  it("pagehide termination rejects inflight ownership-lost and queued payloads remain attached", async () => {
    const worker = new FakeWorker();
    const client = new AuthoritativeSavePersistenceClient({ workerFactory: () => worker as unknown as Worker });
    const first = await input([7]);
    const second = await input([8]);
    const firstPromise = client.commit(first);
    const secondPromise = client.commit(second);
    expect(first.bytes.byteLength).toBe(0);
    expect(second.bytes.byteLength).toBe(1);
    const firstError = expect(firstPromise).rejects.toMatchObject({ code: "terminated", ownershipLost: true } satisfies Partial<AuthoritativeSavePersistenceClientError>);
    const secondError = expect(secondPromise).rejects.toMatchObject({ code: "terminated", ownershipLost: false } satisfies Partial<AuthoritativeSavePersistenceClientError>);
    client.terminate();
    await Promise.all([firstError, secondError]);
    expect(second.bytes.byteLength).toBe(1);
    expect(worker.terminateCount).toBe(1);
    await expect(client.commit(second)).rejects.toMatchObject({ code: "terminated", ownershipLost: false });
  });

  it("allows a BFCache pageshow to create a fresh Worker generation", async () => {
    const workers: FakeWorker[] = [];
    const client = new AuthoritativeSavePersistenceClient({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    });
    const first = await input([18]);
    const pending = client.commit(first);
    const request = workers[0].requests[0];
    const returned = request.payload;
    client.terminate();
    await expect(pending).rejects.toMatchObject({ code: "terminated" });
    client.resumeAfterPageshow();
    const second = await input([19]);
    const secondPending = client.commit(second);
    const secondRequest = workers[1].requests[0];
    const secondReturned = secondRequest.payload;
    workers[1].respond({ id: secondRequest.id, type: "result", result: {
      ok: true,
      proof: {
        key: second.key, revision: 1, savedAt: 1, byteLength: 3,
        payloadChecksum: second.proof.payloadChecksum, payloadSha256: second.proof.payloadSha256,
        stateChecksum: seed.stateChecksum, transportEncoding: "raw", storedByteLength: 3,
        backupKey: null, backupRevision: null, backupSaved: false,
        workerDecodeMs: 0, idbWriteMs: 0, backupVerifyMs: 0, totalBytesWritten: 3,
      },
    }, sourcePayloadTransfer: secondReturned }, [secondReturned]);
    await expect(secondPending).resolves.toMatchObject({ result: { ok: true } });
    expect(returned.byteLength).toBe(1);
  });

  it("does not let an old Worker crash terminate a replacement Worker", async () => {
    const workers: FakeWorker[] = [];
    const client = new AuthoritativeSavePersistenceClient({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      timeoutMs: 10,
    });
    vi.useFakeTimers();
    const first = await input([9]);
    const firstPromise = client.commit(first);
    const firstExpectation = expect(firstPromise).rejects.toMatchObject({ code: "timeout", ownershipLost: true });
    const staleError = workers[0].onerror;
    await vi.advanceTimersByTimeAsync(11);
    await firstExpectation;
    const second = await input([10]);
    const secondPromise = client.commit(second);
    staleError?.({ message: "late", preventDefault: () => undefined } as ErrorEvent);
    expect(workers[1].terminateCount).toBe(0);
    const request = workers[1].requests[0];
    const returned = request.payload;
    workers[1].respond({ id: request.id, type: "result", result: {
      ok: true,
      proof: {
        key: second.key, revision: 1, savedAt: 1, byteLength: 3,
        payloadChecksum: second.proof.payloadChecksum, payloadSha256: second.proof.payloadSha256,
        stateChecksum: seed.stateChecksum, transportEncoding: "raw", storedByteLength: 3,
        backupKey: null, backupRevision: null, backupSaved: false,
        workerDecodeMs: 0, idbWriteMs: 0, backupVerifyMs: 0, totalBytesWritten: 3,
      },
    }, sourcePayloadTransfer: returned }, [returned]);
    await expect(secondPromise).resolves.toMatchObject({ result: { ok: true } });
  });
});
