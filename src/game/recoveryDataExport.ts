import { exportBinaryFile } from "./fileExport";
import type { PureIdleRecoveryRecord } from "./pureIdleRecovery";
import type { GameState, SaveMode } from "./types";

const SAVE_DATABASE = "dsp-idle-network.local-saves";
const IDLE_DATABASE = "dsp-idle-network.pure-idle-recovery";
const RECOVERY_PREFIX = "dsp-idle-network.runtime-recovery.v1";
const MAX_DIAGNOSTIC_BYTES = 512 * 1024 * 1024;
const READ_TIMEOUT_MS = 5_000;

export interface RecoveryDataExportInput {
  checkpointState: GameState;
  recovery: PureIdleRecoveryRecord | null;
  recoveryStatus: string;
}

export interface RecoveryExportStoreSnapshot {
  status: "read" | "missing" | "unavailable";
  records: Array<{ key: string; record: unknown }>;
}

export interface RecoveryExportStorageSnapshot {
  primary: RecoveryExportStoreSnapshot;
  pureIdle: RecoveryExportStoreSnapshot;
  localStoragePrimary: { status: "read" | "unavailable"; key: string; raw: string | null };
}

function primaryKey(mode: SaveMode): string {
  return mode === "speedrun" ? "dsp-idle-network.save.v1.speedrun" : "dsp-idle-network.save.v1";
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function headReferences(value: unknown, mode: SaveMode): string[] {
  const raw = object(value)?.value;
  if (typeof raw !== "string") return [];
  try {
    const head = object(JSON.parse(raw));
    const keys: string[] = [];
    for (const name of ["active", "previous"]) {
      const reference = object(head?.[name]);
      for (const kind of ["checkpoint", "journal"]) {
        const key = reference?.[`${kind}Key`];
        // A damaged head must never broaden this export to account records,
        // unrelated saves or the other game mode.
        if (typeof key === "string" && key.length <= 512 &&
          key.startsWith(`${RECOVERY_PREFIX}.${kind}.${mode}.`)) keys.push(key);
      }
    }
    return [...new Set(keys)];
  } catch { return []; }
}

/** No upgrade, lease, repair, checkpoint publication or journal cleanup. */
function readExistingStore(
  factory: IDBFactory | undefined,
  databaseName: string,
  keys: readonly string[],
  referencedHead?: { key: string; mode: SaveMode },
): Promise<RecoveryExportStoreSnapshot> {
  if (!factory) return Promise.resolve({ status: "unavailable", records: [] });
  return new Promise((resolve) => {
    let settled = false;
    let missing = false;
    let database: IDBDatabase | null = null;
    let transaction: IDBTransaction | null = null;
    const records: RecoveryExportStoreSnapshot["records"] = [];
    const finish = (status: RecoveryExportStoreSnapshot["status"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      database?.close();
      resolve({ status, records: status === "read" ? records : [] });
    };
    const timer = setTimeout(() => {
      try { transaction?.abort(); } catch { /* readonly request already ended */ }
      finish("unavailable");
    }, READ_TIMEOUT_MS);
    try {
      const request = factory.open(databaseName);
      request.onupgradeneeded = () => {
        missing = true;
        request.transaction?.abort();
      };
      request.onerror = () => finish(missing ? "missing" : "unavailable");
      request.onblocked = () => finish("unavailable");
      request.onsuccess = () => {
        database = request.result;
        if (settled) { database.close(); return; }
        try {
          if (!database.objectStoreNames.contains("records")) { finish("missing"); return; }
          transaction = database.transaction("records", "readonly");
          transaction.oncomplete = () => finish("read");
          transaction.onerror = () => finish("unavailable");
          transaction.onabort = () => finish("unavailable");
          const store = transaction.objectStore("records");
          const requested = new Set<string>();
          const read = (key: string) => {
            if (requested.has(key)) return;
            requested.add(key);
            const row = store.get(key);
            row.onsuccess = () => {
              if (row.result !== undefined) records.push({ key, record: row.result });
              if (referencedHead?.key === key) {
                for (const referenced of headReferences(row.result, referencedHead.mode)) read(referenced);
              }
            };
          };
          for (const key of keys) read(key);
        } catch { finish("unavailable"); }
      };
    } catch { finish("unavailable"); }
  });
}

export async function readRecoveryExportStorage(
  mode: SaveMode,
  environment: { indexedDB?: IDBFactory; localStorage?: Pick<Storage, "getItem"> } = {
    get indexedDB() { try { return window.indexedDB; } catch { return undefined; } },
    get localStorage() { try { return window.localStorage; } catch { return undefined; } },
  },
): Promise<RecoveryExportStorageSnapshot> {
  const key = primaryKey(mode);
  let localStoragePrimary: RecoveryExportStorageSnapshot["localStoragePrimary"];
  try {
    const storage = environment.localStorage;
    localStoragePrimary = storage
      ? { status: "read", key, raw: storage.getItem(key) }
      : { status: "unavailable", key, raw: null };
  } catch { localStoragePrimary = { status: "unavailable", key, raw: null }; }
  const headKey = `${RECOVERY_PREFIX}.head.${mode}`;
  const [primary, pureIdle] = await Promise.all([
    readExistingStore(environment.indexedDB, SAVE_DATABASE, [key, headKey, `${RECOVERY_PREFIX}.pending-intent.${mode}`], { key: headKey, mode }),
    readExistingStore(environment.indexedDB, IDLE_DATABASE, ["checkpoint", "heartbeat"]),
  ]);
  return { primary, pureIdle, localStoragePrimary };
}

function binaryJsonValue(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return { diagnosticNumber: String(value) };
  if (typeof value === "bigint") return { diagnosticBigInt: value.toString() };
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  if (!bytes) return value;
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return { diagnosticEncoding: "base64", byteLength: bytes.byteLength, data: btoa(binary) };
}

/** Diagnostic format only: deliberately has no save-envelope state/checksum. */
export function createRecoveryDiagnosticBlob(
  input: RecoveryDataExportInput,
  storage: RecoveryExportStorageSnapshot,
  createdAtMs: number,
): Blob {
  const persistedCheckpoint = storage.pureIdle.records.find((row) => row.key === "checkpoint")?.record;
  const matchingCheckpoint = object(persistedCheckpoint)?.sessionId === input.recovery?.sessionId &&
    object(persistedCheckpoint)?.state !== undefined;
  const { state: _state, ...recoveryMetadata } = input.recovery ?? {};
  const metadata = {
    format: "dsp-idle-recovery-diagnostic",
    schemaVersion: 1,
    createdAtMs,
    appVersion: typeof __APP_VERSION__ === "undefined" ? "unknown" : __APP_VERSION__,
    buildId: typeof __BUILD_ID__ === "undefined" ? "unknown" : __BUILD_ID__,
    settlementCompleted: false,
    warning: "诊断包保留原存档与未结算恢复信息，不是已结算终态，不能直接作为正常存档导入。仅由玩家本地保存或主动分享。",
    warningEnglish: "This diagnostic preserves original save and recovery data. It is not a completed settlement or an importable game save. Only save it locally or share it deliberately.",
    capture: "read-only observations; separate stores may reflect different concurrent revisions",
    mode: input.checkpointState.mode,
    recoveryStatus: input.recoveryStatus,
    recoveryMetadata: input.recovery ? recoveryMetadata : null,
    checkpointSource: matchingCheckpoint ? "pureIdle.records.checkpoint" : "fallbackCheckpointState",
  };
  const parts: BlobPart[] = [JSON.stringify(metadata).slice(0, -1)];
  // Separate parts avoid constructing a second complete archive string.
  for (const [key, value] of Object.entries({
    originalSaveAndRuntimeRecovery: storage.primary,
    originalLocalStoragePrimary: storage.localStoragePrimary,
    pureIdleRecovery: storage.pureIdle,
    ...(matchingCheckpoint ? {} : { fallbackCheckpointState: input.checkpointState }),
  })) parts.push(`,${JSON.stringify(key)}:`, JSON.stringify(value, binaryJsonValue));
  parts.push("}");
  const blob = new Blob(parts, { type: "application/json" });
  if (blob.size > MAX_DIAGNOSTIC_BYTES) throw new Error("恢复数据超过本地诊断包安全上限");
  return blob;
}

export async function exportRecoveryData(
  input: RecoveryDataExportInput,
  dependencies: {
    read?: typeof readRecoveryExportStorage;
    save?: typeof exportBinaryFile;
    now?: () => number;
  } = {},
): Promise<{ destination: "native" | "browser"; partial: boolean }> {
  const createdAtMs = (dependencies.now ?? Date.now)();
  const mode = input.checkpointState.mode === "speedrun" ? "speedrun" : "normal";
  const storage = await (dependencies.read ?? readRecoveryExportStorage)(mode);
  let contents = createRecoveryDiagnosticBlob(input, storage, createdAtMs);
  let compressed = false;
  if (typeof CompressionStream !== "undefined" && typeof contents.stream === "function") {
    try {
      contents = await new Response(contents.stream().pipeThrough(new CompressionStream("gzip"))).blob();
      compressed = true;
    } catch { /* retain the complete uncompressed diagnostic for supported exporters */ }
  }
  const destination = await (dependencies.save ?? exportBinaryFile)({
    contents,
    fileName: `dsp-recovery-diagnostic-${mode}-${Math.max(0, Math.floor(createdAtMs))}.json${compressed ? ".gz" : ""}`,
    mimeType: compressed ? "application/gzip" : "application/json",
    title: "保存恢复诊断数据（不是已结算存档）",
  });
  return {
    destination,
    partial: storage.primary.status === "unavailable" || storage.pureIdle.status === "unavailable",
  };
}
