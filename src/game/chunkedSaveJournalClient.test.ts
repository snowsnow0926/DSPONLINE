/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkedSaveJournalCommit, PersistChunkedSaveResult } from "./chunkedSaveJournal";
import {
  persistChunkedSaveJournalFromTransfer,
  resetChunkedSaveJournalWorkerForTest,
} from "./chunkedSaveJournalClient";
import type { ChunkedSaveJournalWorkerRequest, ChunkedSaveJournalWorkerResponse } from "./chunkedSaveJournal.worker";
import type { SimulationStateTransfer } from "./simulationRuntimeProtocol";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<ChunkedSaveJournalWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  requests: ChunkedSaveJournalWorkerRequest[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(request: ChunkedSaveJournalWorkerRequest): void {
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(result: PersistChunkedSaveResult): void {
    const request = this.requests.at(-1);
    if (!request) throw new Error("missing request");
    const commit: ChunkedSaveJournalCommit = {
      context: {
        mode: request.options.mode,
        basePrimaryChecksum: request.options.basePrimaryChecksum,
        previousChunkRootChecksum: request.context.previous?.chunkRootChecksum ?? null,
      },
      writes: [{
        key: `dsp-idle-network.internal.v1.chunked.v1.${request.options.mode}.manifest`,
        value: JSON.stringify(result.manifest),
      }],
      result,
    };
    this.onmessage?.({ data: { id: request.id, commit } } as unknown as MessageEvent<ChunkedSaveJournalWorkerResponse>);
  }
}

function transfer(): SimulationStateTransfer {
  return { protocolVersion: 1, byteLength: 8, buffer: new ArrayBuffer(8) };
}

function result(savedAt: number): PersistChunkedSaveResult {
  return {
    success: true,
    changedChunks: 1,
    changedBytes: 8,
    totalBytes: 8,
    chunkCount: 1,
    savedAt,
    manifest: {
      formatVersion: 1,
      envelopeFormatVersion: 2,
      mode: "normal",
      slot: "main",
      stateVersion: 47,
      savedAt,
      basePrimaryChecksum: "00000000",
      chunkRootChecksum: "00000000",
      totalBytes: 8,
      entityCount: 0,
      beltCount: 0,
      chunks: [],
    },
  };
}

const registry = { fingerprint: "test", definitions: [] } as never;
const options = { mode: "normal", basePrimaryChecksum: "00000000" } as const;

async function getWorker(requestCount = 1): Promise<FakeWorker> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (FakeWorker.instances[0]?.requests.length === requestCount) return FakeWorker.instances[0];
    await Promise.resolve();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error("worker was not created");
}

describe("chunked save journal worker client", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    resetChunkedSaveJournalWorkerForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reuses one Worker across sequential large autosaves", async () => {
    const firstPromise = persistChunkedSaveJournalFromTransfer(transfer(), undefined, registry, options);
    const worker = await getWorker();
    worker.respond(result(1));
    await expect(firstPromise).resolves.toMatchObject({ savedAt: 1 });

    const secondPromise = persistChunkedSaveJournalFromTransfer(transfer(), undefined, registry, options);
    expect(await getWorker(2)).toBe(worker);
    worker.respond(result(2));
    await expect(secondPromise).resolves.toMatchObject({ savedAt: 2 });
    expect(FakeWorker.instances[0]!.terminated).toBe(false);
  });

  it("rejects overlap instead of retaining a second full checkpoint", async () => {
    const active = persistChunkedSaveJournalFromTransfer(transfer(), undefined, registry, options);
    await expect(persistChunkedSaveJournalFromTransfer(transfer(), undefined, registry, options))
      .rejects.toThrow("已有分块增量存档任务正在运行");
    (await getWorker()).respond(result(1));
    await expect(active).resolves.toMatchObject({ success: true });
  });

  it("terminates the reused Worker after five idle minutes", async () => {
    vi.useFakeTimers();
    const pending = persistChunkedSaveJournalFromTransfer(transfer(), undefined, registry, options);
    (await getWorker()).respond(result(1));
    await pending;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });
});
