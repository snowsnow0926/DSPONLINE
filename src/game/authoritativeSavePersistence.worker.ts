/// <reference lib="webworker" />

import {
  localSaveRevisionKey,
  parseLocalSaveRevision,
  parseLocalSaveWriterLease,
  LOCAL_SAVE_LEASE_DURATION_MS,
  LOCAL_SAVE_WRITER_LEASE_KEY,
} from "./localSaveCoordination";
import {
  localSaveCatalogRecordKey,
  parseLocalSaveCatalog,
  serializeLocalSaveCatalog,
  type LocalSaveCatalog,
  type LocalSaveCatalogKind,
} from "./localSaveCatalog";
import { computeSavePayloadChecksum } from "./saveTransfer";
import { sha256Bytes } from "./payloadDigest";
import type {
  AuthoritativeSaveCatalogSeed,
  AuthoritativeSavePersistenceProgress,
  AuthoritativeSavePersistenceRequest,
  AuthoritativeSavePersistenceResponse,
  AuthoritativeSavePersistenceResult,
  AuthoritativeSavePayloadProof,
} from "./authoritativeSavePersistenceProtocol";

const DATABASE_NAME = "dsp-idle-network.local-saves";
const DATABASE_VERSION = 2;
const RECORD_STORE = "records";
const PRIMARY_KEY = "dsp-idle-network.save.v1";
const SPEEDRUN_PRIMARY_KEY = `${PRIMARY_KEY}.speedrun`;
const BACKUP_KEY = `${PRIMARY_KEY}.backup`;
const SPEEDRUN_BACKUP_KEY = `${PRIMARY_KEY}.backup.speedrun`;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface StoredRecord {
  key: string;
  value?: unknown;
  updatedAt?: unknown;
  bytes?: unknown;
}

const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function storedRecord(key: string, value: string, bytes = byteLength(value), now = Date.now()): StoredRecord {
  return { key, value, updatedAt: now, bytes };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new DOMException("IndexedDB transaction aborted", "AbortError"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = globalThis.indexedDB;
    if (!factory) {
      reject(new Error("当前环境不支持 IndexedDB"));
      return;
    }
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RECORD_STORE)) request.result.createObjectStore(RECORD_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
  });
}

function expectedModeForKey(key: string): "normal" | "speedrun" | null {
  return key.includes(".speedrun") || key.includes("slot.speedrun.") ? "speedrun" : key === PRIMARY_KEY ||
    key.startsWith(`${PRIMARY_KEY}.`) || key.startsWith("dsp-idle-network.slot.") || key.startsWith("dsp-idle-network.import-cache.")
    ? "normal" : null;
}

function expectedKindForKey(key: string): LocalSaveCatalogKind | null {
  if (key.includes(".import-cache.")) return "import-cache";
  if (key.includes(".migration-backup.") || key.includes(".conflict.")) return "protected";
  if (key === BACKUP_KEY || key === SPEEDRUN_BACKUP_KEY) return "backup";
  if (key.startsWith("dsp-idle-network.slot.")) return "slot";
  if (key.includes(".snapshot.")) return "snapshot";
  if (key === PRIMARY_KEY || key === SPEEDRUN_PRIMARY_KEY) return "primary";
  return null;
}

function expectedSlotForKey(key: string): "main" | 1 | 2 | 3 | null {
  if (key === PRIMARY_KEY || key === SPEEDRUN_PRIMARY_KEY) return "main";
  const match = /^dsp-idle-network\.slot\.(?:speedrun\.)?([123])$/.exec(key);
  return match ? Number(match[1]) as 1 | 2 | 3 : null;
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSeed(seed: AuthoritativeSaveCatalogSeed, key: string, proof: AuthoritativeSavePayloadProof): boolean {
  const expectedKind = expectedKindForKey(key);
  const expectedMode = expectedModeForKey(key);
  if (!expectedKind || !expectedMode || seed.kind !== expectedKind || seed.mode !== expectedMode ||
    seed.slot !== expectedSlotForKey(key) || !Number.isFinite(seed.savedAt) || seed.savedAt < 0 ||
    !validNonNegativeInteger(seed.stateVersion) || !validNonNegativeInteger(seed.entityCount) ||
    !validNonNegativeInteger(seed.beltCount) || !validNonNegativeInteger(seed.elapsedSeconds) ||
    !validNonNegativeInteger(seed.completedTechCount) || !validNonNegativeInteger(seed.structurePoints) ||
    typeof seed.activePlanetId !== "string" || seed.activePlanetId.length > 128 ||
    !(seed.reason === null || typeof seed.reason === "string" && seed.reason.length <= 256) ||
    !(seed.settings === null || typeof seed.settings === "object" && !Array.isArray(seed.settings)) ||
    typeof seed.stateChecksum !== "string" || seed.stateChecksum.length === 0 ||
    proof.stateChecksum !== seed.stateChecksum || proof.integrity !== "valid" ||
    !SHA256_PATTERN.test(proof.payloadSha256) || !/^[0-9a-f]{8}$/.test(proof.payloadChecksum) ||
    !validNonNegativeInteger(proof.byteLength)) return false;
  return true;
}

function catalogFromSeed(
  key: string,
  revision: number,
  proof: AuthoritativeSavePayloadProof,
  seed: AuthoritativeSaveCatalogSeed,
): LocalSaveCatalog {
  return {
    schemaVersion: 1,
    key,
    mode: seed.mode,
    kind: seed.kind,
    slot: seed.slot,
    savedAt: seed.savedAt,
    byteLength: proof.byteLength,
    payloadChecksum: proof.payloadChecksum,
    revision,
    stateVersion: seed.stateVersion,
    entityCount: seed.entityCount,
    beltCount: seed.beltCount,
    elapsedSeconds: seed.elapsedSeconds,
    completedTechCount: seed.completedTechCount,
    activePlanetId: seed.activePlanetId,
    structurePoints: seed.structurePoints,
    integrity: "valid",
    stateChecksum: seed.stateChecksum,
    reason: seed.reason,
    settings: seed.settings,
  };
}

function catalogMatchesSeed(catalog: LocalSaveCatalog | null, expected: LocalSaveCatalog): boolean {
  return Boolean(catalog && JSON.stringify(catalog) === JSON.stringify(expected));
}

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "QuotaExceededError" || candidate.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    candidate.code === 22 || candidate.code === 1014;
}

function failure(reason: AuthoritativeSavePersistenceResult extends infer _T ? any : never, message: string): AuthoritativeSavePersistenceResult {
  return {
    ok: false,
    reason,
    message,
    retryable: reason !== "invalid" && reason !== "backup-unavailable",
    degraded: reason !== "invalid" && reason !== "cas-mismatch",
  };
}

function deriveBackupKey(key: string, mode: "normal" | "speedrun"): string | null {
  if (key !== PRIMARY_KEY && key !== SPEEDRUN_PRIMARY_KEY) return null;
  return mode === "speedrun" ? SPEEDRUN_BACKUP_KEY : BACKUP_KEY;
}

async function commitPayload(request: AuthoritativeSavePersistenceRequest): Promise<AuthoritativeSavePersistenceResult> {
  const decodeStarted = performance.now();
  if (!validNonNegativeInteger(request.expectedRevision) || request.expectedRevision > 0x7fffffff ||
    !request.fence.ownerId || !Number.isSafeInteger(request.fence.fencingToken) || request.fence.fencingToken < 1 ||
    !validSeed(request.seed, request.key, request.proof) || request.payload.byteLength !== request.proof.byteLength) {
    return failure("invalid", "authoritative payload proof 或 key/seed 不合法");
  }
  const payloadChecksum = computeSavePayloadChecksum(request.payload);
  if (payloadChecksum !== request.proof.payloadChecksum || await sha256Bytes(request.payload) !== request.proof.payloadSha256) {
    return failure("invalid", "authoritative payload checksum 与 Worker proof 不匹配");
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(request.payload);
  } catch {
    return failure("invalid", "authoritative payload 不是合法 UTF-8");
  }
  const decodeMs = Math.max(0, performance.now() - decodeStarted);
  const db = await openDatabase();
  const writeStarted = performance.now();
  const transaction = db.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const now = Date.now();
  const [leaseRecord, currentRecord, currentRevisionRecord, currentCatalogRecord] = await Promise.all([
    requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredRecord | undefined>),
    requestResult(store.get(request.key) as IDBRequest<StoredRecord | undefined>),
    requestResult(store.get(localSaveRevisionKey(request.key)) as IDBRequest<StoredRecord | undefined>),
    requestResult(store.get(localSaveCatalogRecordKey(request.key)) as IDBRequest<StoredRecord | undefined>),
  ]);
  const lease = parseLocalSaveWriterLease(typeof leaseRecord?.value === "string" ? leaseRecord.value : null);
  if (!lease || lease.ownerId !== request.fence.ownerId || lease.fencingToken !== request.fence.fencingToken || lease.expiresAt <= now) {
    transaction.abort();
    void done.catch(() => undefined);
    return failure("lease-lost", "authoritative save writer lease 已失效");
  }
  const currentRevision = parseLocalSaveRevision(typeof currentRevisionRecord?.value === "string" ? currentRevisionRecord.value : null);
  const currentCatalog = parseLocalSaveCatalog(typeof currentCatalogRecord?.value === "string" ? currentCatalogRecord.value : null, request.key);
  const persisted = typeof currentRecord?.value === "string" ? currentRecord.value : null;
  if ((currentRevision?.revision ?? 0) !== request.expectedRevision ||
    currentRevision && (currentRevision.saveKey !== request.key || currentRevision.deleted !== (persisted === null))) {
    transaction.abort();
    void done.catch(() => undefined);
    return failure("cas-mismatch", "authoritative save revision 已变化");
  }
  const nextRevision = request.expectedRevision + 1;
  const primaryCatalog = catalogFromSeed(request.key, nextRevision, request.proof, request.seed);
  const renewedLease = { ...lease, heartbeatAt: now, expiresAt: now + LOCAL_SAVE_LEASE_DURATION_MS };
  const backupKey = request.preserveBackup === false ? null : deriveBackupKey(request.key, request.seed.mode);
  let backupSaved = false;
  let backupRevision: number | null = null;
  let backupBytes = 0;
  let previousBackupValue: string | null = null;
  if (backupKey && persisted !== null && currentCatalog && currentCatalog.integrity === "valid" &&
    currentCatalog.payloadChecksum === (currentRecord?.value === persisted ? currentCatalog.payloadChecksum : "")) {
    // The catalog is a proof side-record; the old payload is copied byte-for-
    // byte and never parsed or re-stringified on the UI thread.
    previousBackupValue = persisted;
    const backupRevisionRecord = await requestResult(store.get(localSaveRevisionKey(backupKey)) as IDBRequest<StoredRecord | undefined>);
    const parsedBackupRevision = parseLocalSaveRevision(typeof backupRevisionRecord?.value === "string" ? backupRevisionRecord.value : null);
    backupRevision = (parsedBackupRevision?.revision ?? 0) + 1;
    const backupCatalog: LocalSaveCatalog = {
      ...currentCatalog,
      key: backupKey,
      kind: "backup",
      slot: "main",
      revision: backupRevision,
    };
    store.put(storedRecord(backupKey, persisted, Number(currentRecord?.bytes) || byteLength(persisted), now));
    store.put(storedRecord(localSaveCatalogRecordKey(backupKey), serializeLocalSaveCatalog(backupCatalog), now));
    store.put(storedRecord(localSaveRevisionKey(backupKey), JSON.stringify({
      schemaVersion: 1,
      saveKey: backupKey,
      revision: backupRevision,
      savedAt: currentCatalog.savedAt,
      checksum: currentCatalog.stateChecksum,
      deleted: false,
      writerId: request.fence.ownerId,
      fencingToken: request.fence.fencingToken,
      updatedAt: now,
    }), now));
    backupSaved = true;
    backupBytes = Number(currentRecord?.bytes) || byteLength(persisted);
  }
  store.put(storedRecord(LOCAL_SAVE_WRITER_LEASE_KEY, JSON.stringify(renewedLease), now));
  store.put(storedRecord(request.key, raw, request.proof.byteLength, now));
  store.put(storedRecord(localSaveCatalogRecordKey(request.key), serializeLocalSaveCatalog(primaryCatalog), now));
  store.put(storedRecord(localSaveRevisionKey(request.key), JSON.stringify({
    schemaVersion: 1,
    saveKey: request.key,
    revision: nextRevision,
    savedAt: request.seed.savedAt,
    checksum: request.seed.stateChecksum,
    deleted: false,
    writerId: request.fence.ownerId,
    fencingToken: request.fence.fencingToken,
    updatedAt: now,
  }), now));
  const [storedPrimary, storedPrimaryCatalog, storedPrimaryRevision, storedBackup, storedBackupCatalog, storedBackupRevision] = await Promise.all([
    requestResult(store.get(request.key) as IDBRequest<StoredRecord | undefined>),
    requestResult(store.get(localSaveCatalogRecordKey(request.key)) as IDBRequest<StoredRecord | undefined>),
    requestResult(store.get(localSaveRevisionKey(request.key)) as IDBRequest<StoredRecord | undefined>),
    backupKey ? requestResult(store.get(backupKey) as IDBRequest<StoredRecord | undefined>) : Promise.resolve(undefined),
    backupKey ? requestResult(store.get(localSaveCatalogRecordKey(backupKey)) as IDBRequest<StoredRecord | undefined>) : Promise.resolve(undefined),
    backupKey ? requestResult(store.get(localSaveRevisionKey(backupKey)) as IDBRequest<StoredRecord | undefined>) : Promise.resolve(undefined),
  ]);
  const parsedPrimaryCatalog = parseLocalSaveCatalog(typeof storedPrimaryCatalog?.value === "string" ? storedPrimaryCatalog.value : null, request.key);
  const parsedPrimaryRevision = parseLocalSaveRevision(typeof storedPrimaryRevision?.value === "string" ? storedPrimaryRevision.value : null);
  const readbackOk = storedPrimary?.value === raw && Number(storedPrimary.bytes) === request.proof.byteLength &&
    catalogMatchesSeed(parsedPrimaryCatalog, primaryCatalog) && parsedPrimaryRevision?.revision === nextRevision &&
    parsedPrimaryRevision.saveKey === request.key && parsedPrimaryRevision.checksum === request.seed.stateChecksum &&
    (!backupSaved || storedBackup?.value === previousBackupValue &&
      parseLocalSaveCatalog(typeof storedBackupCatalog?.value === "string" ? storedBackupCatalog.value : null, backupKey!)?.revision === backupRevision &&
      parseLocalSaveRevision(typeof storedBackupRevision?.value === "string" ? storedBackupRevision.value : null)?.revision === backupRevision);
  if (!readbackOk) {
    transaction.abort();
    void done.catch(() => undefined);
    return failure("readback-failed", "authoritative save IDB 精确回读失败");
  }
  await done;
  db.close();
  return {
    ok: true,
    proof: {
      key: request.key,
      revision: nextRevision,
      savedAt: request.seed.savedAt,
      byteLength: request.proof.byteLength,
      payloadChecksum: request.proof.payloadChecksum,
      payloadSha256: request.proof.payloadSha256,
      stateChecksum: request.seed.stateChecksum,
      backupKey,
      backupRevision,
      backupSaved,
      workerDecodeMs: decodeMs,
      idbWriteMs: Math.max(0, performance.now() - writeStarted),
      totalBytesWritten: request.proof.byteLength + backupBytes,
    },
  };
}

function responseTransferables(response: AuthoritativeSavePersistenceResponse): Transferable[] {
  return response.type !== "progress" && "sourcePayloadTransfer" in response && response.sourcePayloadTransfer
    ? [response.sourcePayloadTransfer]
    : [];
}

function postResponse(response: AuthoritativeSavePersistenceResponse): void {
  self.postMessage(response, { transfer: responseTransferables(response) });
}

async function handle(request: AuthoritativeSavePersistenceRequest): Promise<void> {
  const payload = request.payload;
  self.postMessage({ id: request.id, type: "progress", progress: { stage: "queued", key: request.key, bytes: payload.byteLength } } satisfies AuthoritativeSavePersistenceResponse);
  try {
    self.postMessage({ id: request.id, type: "progress", progress: { stage: "validating-proof", key: request.key, bytes: payload.byteLength } } satisfies AuthoritativeSavePersistenceResponse);
    const result = await commitPayload(request);
    if (result.ok) {
      self.postMessage({ id: request.id, type: "progress", progress: { stage: "verified", key: request.key, bytes: payload.byteLength, revision: result.proof.revision } } satisfies AuthoritativeSavePersistenceResponse);
    } else {
      self.postMessage({ id: request.id, type: "progress", progress: { stage: "failed", key: request.key, bytes: payload.byteLength, reason: result.reason } } satisfies AuthoritativeSavePersistenceResponse);
    }
    postResponse({ id: request.id, type: "result", result, sourcePayloadTransfer: payload });
  } catch (error) {
    const reason = isQuotaError(error) ? "quota" : error instanceof DOMException && error.name === "AbortError" ? "transaction-aborted" : "storage-unavailable";
    self.postMessage({ id: request.id, type: "progress", progress: { stage: "failed", key: request.key, bytes: payload.byteLength, reason } } satisfies AuthoritativeSavePersistenceResponse);
    postResponse({ id: request.id, type: "error", message: error instanceof Error ? error.message : "authoritative save persistence Worker 失败", sourcePayloadTransfer: payload });
  }
}

let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<AuthoritativeSavePersistenceRequest>) => {
  queue = queue.then(() => handle(event.data));
};

export {};
