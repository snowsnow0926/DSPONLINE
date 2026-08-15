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

afterEach(() => vi.useRealTimers());

describe("AuthoritativeSavePersistenceClient", () => {
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
        stateChecksum: seed.stateChecksum, backupKey: null, backupRevision: null, backupSaved: false,
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
        stateChecksum: seed.stateChecksum, backupKey: null, backupRevision: null, backupSaved: false,
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
        stateChecksum: seed.stateChecksum, backupKey: null, backupRevision: null, backupSaved: false,
        workerDecodeMs: 0, idbWriteMs: 0, backupVerifyMs: 0, totalBytesWritten: 3,
      },
    }, sourcePayloadTransfer: returned }, [returned]);
    await expect(secondPromise).resolves.toMatchObject({ result: { ok: true } });
  });
});
