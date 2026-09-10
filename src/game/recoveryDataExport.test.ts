import { afterEach, describe, expect, it, vi } from "vitest";
import type { BinaryFileExport } from "./fileExport";
import {
  createRecoveryDiagnosticBlob, exportRecoveryData, readRecoveryExportStorage,
  type RecoveryDataExportInput, type RecoveryExportStorageSnapshot,
} from "./recoveryDataExport";

const SAVE = "dsp-idle-network.save.v1";
const RUNTIME = "dsp-idle-network.runtime-recovery.v1";
const CHECKPOINT = `${RUNTIME}.checkpoint.normal.session.1`;
const JOURNAL = `${RUNTIME}.journal.normal.session.1`;

function input(): RecoveryDataExportInput {
  return {
    checkpointState: { version: 47, mode: "normal", elapsedSeconds: 10, totalProduced: { iron_ingot: 7 }, timeWarp: { pendingSimulationSeconds: 99 } } as RecoveryDataExportInput["checkpointState"],
    recovery: null,
    recoveryStatus: "停止失败，尚未提交",
  };
}

function emptyStorage(): RecoveryExportStorageSnapshot {
  return {
    primary: { status: "unavailable", records: [] },
    pureIdle: { status: "unavailable", records: [] },
    localStoragePrimary: { status: "read", key: SAVE, raw: null },
  };
}

function readonlyFactory(databases: Record<string, Map<string, unknown>>) {
  const operations: string[] = [];
  const factory = {
    open(name: string) {
      operations.push(`open:${name}`);
      const request: Record<string, any> = {};
      queueMicrotask(() => {
        const rows = databases[name];
        if (!rows) {
          request.transaction = { abort: () => { operations.push("abort-upgrade"); queueMicrotask(() => request.onerror?.()); } };
          request.onupgradeneeded?.();
          return;
        }
        request.result = {
          close: () => operations.push(`close:${name}`),
          objectStoreNames: { contains: (store: string) => store === "records" },
          transaction(store: string, mode: string) {
            operations.push(`transaction:${store}:${mode}`);
            expect(mode).toBe("readonly");
            const transaction: Record<string, any> = {};
            let pending = 0;
            transaction.objectStore = () => ({
              get(key: string) {
                operations.push(`get:${key}`);
                pending += 1;
                const read: Record<string, any> = {};
                queueMicrotask(() => {
                  read.result = structuredClone(rows.get(key));
                  read.onsuccess?.();
                  pending -= 1;
                  if (pending === 0) queueMicrotask(() => transaction.oncomplete?.());
                });
                return read;
              },
            });
            return transaction;
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, operations };
}

afterEach(() => vi.unstubAllGlobals());

describe("recovery diagnostic export", () => {
  it("retains exact original text and malformed journal data without claiming a settled save", async () => {
    const source = input();
    const storage = emptyStorage();
    const raw = '{"state":{"name":"中文\\\"😀","elapsedSeconds":1},"checksum":"bad-on-purpose"}';
    storage.primary = { status: "read", records: [{ key: SAVE, record: { key: SAVE, value: raw, revision: 7 } }] };
    storage.pureIdle = { status: "read", records: [{ key: "heartbeat", record: "damaged heartbeat" }] };
    const before = JSON.stringify({ source, storage });
    const diagnostic = JSON.parse(await createRecoveryDiagnosticBlob(source, storage, 123).text());
    expect(diagnostic).toMatchObject({ format: "dsp-idle-recovery-diagnostic", settlementCompleted: false });
    expect(diagnostic).not.toHaveProperty("state");
    expect(diagnostic).not.toHaveProperty("checksum");
    expect(diagnostic.originalSaveAndRuntimeRecovery.records[0].record.value).toBe(raw);
    expect(diagnostic.pureIdleRecovery.records[0].record).toBe("damaged heartbeat");
    expect(diagnostic.fallbackCheckpointState).toEqual(source.checkpointState);
    expect(diagnostic.fallbackCheckpointState.timeWarp.pendingSimulationSeconds).toBe(99);
    expect(JSON.stringify({ source, storage })).toBe(before);
  });

  it("keeps a matching durable idle checkpoint once and retains current failure metadata", async () => {
    const source = input();
    source.recovery = { sessionId: "idle-session", state: source.checkpointState, lastError: "save-failed", committed: false } as RecoveryDataExportInput["recovery"];
    const storage = emptyStorage();
    storage.pureIdle = { status: "read", records: [{ key: "checkpoint", record: { sessionId: "idle-session", state: source.checkpointState } }] };
    const diagnostic = JSON.parse(await createRecoveryDiagnosticBlob(source, storage, 123).text());
    expect(diagnostic).not.toHaveProperty("fallbackCheckpointState");
    expect(diagnostic.recoveryMetadata).not.toHaveProperty("state");
    expect(diagnostic.recoveryMetadata.lastError).toBe("save-failed");
    expect(diagnostic.pureIdleRecovery.records[0].record.state).toEqual(source.checkpointState);
  });

  it("preserves binary durable recovery contents with explicit base64 encoding", async () => {
    const storage = emptyStorage();
    const bytes = new Uint8Array([0, 17, 255, 100]).buffer;
    storage.primary.records.push({ key: CHECKPOINT, record: { buffer: bytes } });
    const diagnostic = JSON.parse(await createRecoveryDiagnosticBlob(input(), storage, 123).text());
    const binary = diagnostic.originalSaveAndRuntimeRecovery.records[0].record.buffer;
    expect(binary).toEqual({ diagnosticEncoding: "base64", byteLength: 4, data: "ABH/ZA==" });
    expect([...new Uint8Array(bytes)]).toEqual([0, 17, 255, 100]);
  });

  it("reads only the selected primary and bounded current-mode recovery references in readonly transactions", async () => {
    const primary = new Map<string, unknown>([
      [SAVE, { value: "original-primary", revision: 3 }],
      [`${RUNTIME}.head.normal`, { value: JSON.stringify({ active: { checkpointKey: CHECKPOINT, journalKey: JOURNAL }, previous: { checkpointKey: "private-account-token", journalKey: `${RUNTIME}.journal.speedrun.other.1` } }) }],
      [CHECKPOINT, { state: "original-checkpoint" }],
      [JOURNAL, { value: "original-journal" }],
      [`${RUNTIME}.pending-intent.normal`, { value: "not-yet-committed" }],
      ["private-account-token", { value: "never-export" }],
    ]);
    const idle = new Map<string, unknown>([["checkpoint", { state: "idle-checkpoint" }], ["heartbeat", { phase: "failed" }]]);
    const before = JSON.stringify([[...primary], [...idle]]);
    const { factory, operations } = readonlyFactory({ "dsp-idle-network.local-saves": primary, "dsp-idle-network.pure-idle-recovery": idle });
    const localStorage = { getItem: vi.fn(() => "emergency-original") };
    const result = await readRecoveryExportStorage("normal", { indexedDB: factory, localStorage });
    expect(result.primary.status).toBe("read");
    expect(result.pureIdle.status).toBe("read");
    expect(result.primary.records.map((row) => row.key).sort()).toEqual([
      SAVE, `${RUNTIME}.head.normal`, `${RUNTIME}.pending-intent.normal`, CHECKPOINT, JOURNAL,
    ].sort());
    expect(operations).not.toContain("get:private-account-token");
    expect(operations).not.toContain(`get:${RUNTIME}.journal.speedrun.other.1`);
    expect(operations.filter((operation) => operation.startsWith("transaction:"))).toEqual(["transaction:records:readonly", "transaction:records:readonly"]);
    expect(localStorage.getItem).toHaveBeenCalledExactlyOnceWith(SAVE);
    expect(JSON.stringify([[...primary], [...idle]])).toBe(before);
  });

  it("aborts absent database creation and can still export the fallback checkpoint", async () => {
    const { factory, operations } = readonlyFactory({});
    const storage = await readRecoveryExportStorage("normal", { indexedDB: factory });
    expect(storage.primary.status).toBe("missing");
    expect(storage.pureIdle.status).toBe("missing");
    expect(operations.filter((operation) => operation === "abort-upgrade")).toHaveLength(2);
    expect(JSON.parse(await createRecoveryDiagnosticBlob(input(), storage, 123).text()).fallbackCheckpointState).toEqual(input().checkpointState);
  });

  it("downloads independently when persistence is unavailable, using the existing binary export boundary", async () => {
    const source = input();
    const before = JSON.stringify(source);
    const save = vi.fn(async (request: BinaryFileExport) => {
      let contents = request.contents as Blob;
      if (request.fileName.endsWith(".gz")) contents = await new Response(contents.stream().pipeThrough(new DecompressionStream("gzip"))).blob();
      const diagnostic = JSON.parse(await contents.text());
      expect(diagnostic.fallbackCheckpointState).toEqual(source.checkpointState);
      expect(diagnostic.settlementCompleted).toBe(false);
      return "native" as const;
    });
    const result = await exportRecoveryData(source, { read: async () => emptyStorage(), save, now: () => 123 });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].fileName).toMatch(/^dsp-recovery-diagnostic-normal-123\.json(?:\.gz)?$/);
    expect(result).toEqual({ destination: "native", partial: true });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps all data when optional compression fails and propagates download failure without mutation", async () => {
    vi.stubGlobal("CompressionStream", class { constructor() { throw new Error("not supported"); } });
    const source = input();
    const before = JSON.stringify(source);
    const save = vi.fn(async (request: BinaryFileExport) => {
      expect(request.fileName).toBe("dsp-recovery-diagnostic-normal-123.json");
      expect(JSON.parse(await (request.contents as Blob).text()).fallbackCheckpointState).toEqual(source.checkpointState);
      throw new Error("export rejected");
    });
    await expect(exportRecoveryData(source, { read: async () => emptyStorage(), save, now: () => 123 })).rejects.toThrow("export rejected");
    expect(JSON.stringify(source)).toBe(before);
  });
});
