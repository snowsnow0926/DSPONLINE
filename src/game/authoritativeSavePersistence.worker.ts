/// <reference lib="webworker" />

import {
  localSaveRevisionKey,
  parseLocalSaveRevision,
  parseLocalSaveWriterLease,
  LOCAL_SAVE_LEASE_DURATION_MS,
  LOCAL_SAVE_WRITER_LEASE_KEY,
  type LocalSaveRevision,
  type LocalSaveWriterLease,
} from "./localSaveCoordination";
import {
  localSaveCatalogRecordKey,
  parseLocalSaveCatalog,
  serializeLocalSaveCatalog,
  type LocalSaveCatalog,
  type LocalSaveCatalogKind,
} from "./localSaveCatalog";
import { computeSavePayloadChecksum } from "./saveTransfer";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";
import { sha256Bytes } from "./payloadDigest";
import { inspectCanonicalSaveEnvelope } from "./canonicalSaveEnvelopeInspection";
import { inspectSaveEnvelopeChecksum } from "./saveEnvelopeIntegrity";
import { decodeSavePayloadTransport } from "./savePayloadCompression";
import { canonicalAuthoritativeSaveJson, computeAuthoritativeSaveProofBindingSha256 } from "./authoritativeSaveProof";
import type {
  AuthoritativeSaveCatalogSeed,
  AuthoritativeSavePersistenceFailureReason,
  AuthoritativeSavePersistenceProgress,
  AuthoritativeSavePersistenceProof,
  AuthoritativeSavePersistenceRequest,
  AuthoritativeSavePersistenceResponse,
  AuthoritativeSavePersistenceResult,
  AuthoritativeSavePayloadProof,
  AuthoritativeSaveWriterFence,
} from "./authoritativeSavePersistenceProtocol";
import {
  workerBinaryPayloadByteLength,
  workerBinaryPayloadToArrayBuffer,
  type WorkerBinaryPayload,
} from "./workerBinaryPayload";

const DATABASE_NAME = "dsp-idle-network.local-saves";
const DATABASE_VERSION = 2;
const RECORD_STORE = "records";
const PRIMARY_KEY = "dsp-idle-network.save.v1";
const SPEEDRUN_PRIMARY_KEY = `${PRIMARY_KEY}.speedrun`;
const BACKUP_KEY = `${PRIMARY_KEY}.backup`;
const SPEEDRUN_BACKUP_KEY = `${PRIMARY_KEY}.backup.speedrun`;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STATE_CHECKSUM_PATTERN = /^[0-9a-f]{8}$/;
const SETTINGS_MAX_BYTES = 2 * 1024;

interface StoredRecord {
  key: string;
  value?: unknown;
  updatedAt?: unknown;
  bytes?: unknown;
}

interface BoundPreviousPayload {
  raw: string;
  catalog: LocalSaveCatalog;
  byteLength: number;
}

interface PrimaryCommitExpectation {
  key: string;
  raw: string;
  payloadByteLength: number;
  catalogRaw: string;
  revisionRaw: string;
  revision: number;
  stateChecksum: string;
  fence: AuthoritativeSaveWriterFence;
}

const textEncoder = new TextEncoder();

function stringByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function storedRecord(
  key: string,
  value: string,
  options: { byteLength?: number; updatedAt?: number } = {},
): StoredRecord {
  return {
    key,
    value,
    updatedAt: options.updatedAt ?? Date.now(),
    bytes: options.byteLength ?? stringByteLength(value),
  };
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
    if (!globalThis.indexedDB) {
      reject(new Error("当前环境不支持 IndexedDB"));
      return;
    }
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RECORD_STORE)) request.result.createObjectStore(RECORD_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
  });
}

function expectedModeForKey(key: string): "normal" | "speedrun" | null {
  if (key.includes(".speedrun") || key.includes("slot.speedrun.")) return "speedrun";
  return key === PRIMARY_KEY || key.startsWith(`${PRIMARY_KEY}.`) || key.startsWith("dsp-idle-network.slot.") ||
    key.startsWith("dsp-idle-network.import-cache.") ? "normal" : null;
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

function catalogInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function validSettings(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return stringByteLength(canonicalAuthoritativeSaveJson(value)) <= SETTINGS_MAX_BYTES;
  } catch {
    return false;
  }
}

function validSlot(value: unknown): value is "main" | 1 | 2 | 3 | null {
  return value === null || value === "main" || value === 1 || value === 2 || value === 3;
}

function validWriterFence(value: unknown): value is AuthoritativeSaveWriterFence {
  if (!value || typeof value !== "object") return false;
  const fence = value as Partial<AuthoritativeSaveWriterFence>;
  const token = fence.fencingToken;
  return typeof fence.ownerId === "string" && fence.ownerId.length > 0 && fence.ownerId.length <= 200 &&
    fence.ownerId.trim() === fence.ownerId && typeof token === "number" && Number.isSafeInteger(token) && token >= 1;
}

function validSeed(seed: AuthoritativeSaveCatalogSeed, key: string, proof: AuthoritativeSavePayloadProof): boolean {
  const expectedKind = expectedKindForKey(key);
  const expectedMode = expectedModeForKey(key);
  const expectedSlot = expectedSlotForKey(key);
  return Boolean(expectedKind && expectedMode && seed.kind === expectedKind && seed.mode === expectedMode &&
    validSlot(seed.slot) &&
    (!(expectedKind === "primary" || expectedKind === "slot") || seed.slot === expectedSlot) &&
    Number.isSafeInteger(seed.savedAt) && seed.savedAt >= 0 && validNonNegativeInteger(seed.stateVersion) &&
    validNonNegativeInteger(seed.entityCount) && validNonNegativeInteger(seed.beltCount) &&
    validNonNegativeInteger(seed.elapsedSeconds) && validNonNegativeInteger(seed.completedTechCount) &&
    validNonNegativeInteger(seed.structurePoints) && typeof seed.activePlanetId === "string" &&
    seed.activePlanetId.length <= 128 && (seed.reason === null || typeof seed.reason === "string" && seed.reason.length <= 256) &&
    seed.modeExplicit === true && validSettings(seed.settings) && STATE_CHECKSUM_PATTERN.test(seed.stateChecksum) && proof.stateChecksum === seed.stateChecksum &&
    proof.integrity === "valid" && SHA256_PATTERN.test(proof.payloadSha256) && SHA256_PATTERN.test(proof.bindingSha256) &&
    SHA256_PATTERN.test(proof.storedSha256) && (proof.transportEncoding === "raw" || proof.transportEncoding === "gzip") &&
    /^[0-9a-f]{8}$/.test(proof.payloadChecksum) && validNonNegativeInteger(proof.byteLength) &&
    validNonNegativeInteger(proof.storedByteLength) && proof.storedByteLength > 0 &&
    (proof.transportEncoding !== "raw" || proof.storedByteLength === proof.byteLength && proof.storedSha256 === proof.payloadSha256));
}

/** Re-parse and bind the new envelope in the persistence Worker.  The save
 * Worker proof is necessary but not trusted by itself: a tampered payload and
 * an independently supplied catalog seed must never be committed together. */
function newEnvelopeMismatch(
  raw: string,
  request: AuthoritativeSavePersistenceRequest<WorkerBinaryPayload>,
): string | null {
  const inspection = inspectCanonicalSaveEnvelope(raw);
  if (!inspection) return "integrity";
  if (inspection.recordedChecksum !== request.seed.stateChecksum) return "recordedChecksum";
  if (inspection.computedChecksum !== request.seed.stateChecksum) return "computedChecksum";
  const envelope = inspection;
  const state = inspection.state;
  if (envelope.formatVersion !== 2) return "formatVersion";
  if (envelope.kind !== request.seed.kind) return "kind";
  if (envelope.mode !== request.seed.mode) return "envelope.mode";
  if (envelope.slot !== request.seed.slot) return "slot";
  if (envelope.savedAt !== request.seed.savedAt) return "savedAt";
  if (state.mode !== request.seed.mode) return "state.mode";
  if (state.version !== request.seed.stateVersion) return "state.version";
  if (state.activePlanetId !== request.seed.activePlanetId) return "activePlanetId";
  if (state.entityCount !== request.seed.entityCount) return "entityCount";
  if (state.beltCount !== request.seed.beltCount) return "beltCount";
  if (state.elapsedSeconds !== request.seed.elapsedSeconds) return "elapsedSeconds";
  if (state.completedTechCount !== request.seed.completedTechCount) return "completedTechCount";
  if (state.structurePoints !== request.seed.structurePoints) return "structurePoints";
  return null;
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
    modeExplicit: true,
    reason: seed.reason,
    settings: seed.settings,
  };
}

function failure(reason: AuthoritativeSavePersistenceFailureReason, message: string): AuthoritativeSavePersistenceResult {
  return {
    ok: false,
    reason,
    message,
    retryable: reason !== "invalid" && reason !== "backup-unavailable",
    degraded: reason !== "invalid" && reason !== "cas-mismatch",
  };
}

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "QuotaExceededError" || candidate.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    candidate.code === 22 || candidate.code === 1014;
}

function failureReasonForError(error: unknown): AuthoritativeSavePersistenceFailureReason {
  if (isQuotaError(error)) return "quota";
  return error instanceof DOMException && error.name === "AbortError" ? "transaction-aborted" : "storage-unavailable";
}

function leaseMatches(lease: LocalSaveWriterLease | null, fence: AuthoritativeSaveWriterFence, now: number): boolean {
  return Boolean(lease && lease.ownerId === fence.ownerId && lease.fencingToken === fence.fencingToken && lease.expiresAt > now);
}

function renewedLease(lease: LocalSaveWriterLease, now: number): LocalSaveWriterLease {
  return { ...lease, heartbeatAt: now, expiresAt: now + LOCAL_SAVE_LEASE_DURATION_MS };
}

function revisionRaw(
  key: string,
  revision: number,
  savedAt: number,
  checksum: string | null,
  fence: AuthoritativeSaveWriterFence,
  now: number,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    saveKey: key,
    revision,
    savedAt,
    checksum,
    deleted: false,
    writerId: fence.ownerId,
    fencingToken: fence.fencingToken,
    updatedAt: now,
  } satisfies LocalSaveRevision);
}

function revisionMatchesExpected(
  revision: LocalSaveRevision | null,
  key: string,
  expectedRevision: number,
  persisted: string | null,
  lease: LocalSaveWriterLease,
): boolean {
  if (persisted === null) {
    if (expectedRevision === 0) return revision === null;
    return Boolean(revision && revision.saveKey === key && revision.revision === expectedRevision && revision.deleted &&
      revision.fencingToken <= lease.fencingToken);
  }
  return Boolean(revision && revision.saveKey === key && revision.revision === expectedRevision && !revision.deleted &&
    revision.fencingToken <= lease.fencingToken);
}

function payloadMatchesCatalogAndRevision(
  raw: string,
  record: StoredRecord,
  catalog: LocalSaveCatalog | null,
  revision: LocalSaveRevision | null,
  expectedRevision: number,
): catalog is LocalSaveCatalog {
  if (!catalog || !revision || catalog.integrity !== "valid" || catalog.revision !== expectedRevision ||
    revision.revision !== expectedRevision || revision.savedAt !== catalog.savedAt || revision.checksum !== catalog.stateChecksum) return false;
  const measured = computeSavePayloadTextChecksum(raw);
  return measured.byteLength === catalog.byteLength && Number(record.bytes) === measured.byteLength &&
    measured.checksum === catalog.payloadChecksum;
}

async function abortTransaction(transaction: IDBTransaction, done: Promise<void>): Promise<void> {
  try { transaction.abort(); } catch { /* already inactive */ }
  await done.catch(() => undefined);
}

async function verifyPrimaryAfterCommit(db: IDBDatabase, expected: PrimaryCommitExpectation): Promise<boolean> {
  const transaction = db.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const [payload, catalog, revision, leaseRecord] = await Promise.all([
    requestResult(store.get(expected.key) as IDBRequest<StoredRecord | undefined>),
    requestResult(store.get(localSaveCatalogRecordKey(expected.key)) as IDBRequest<StoredRecord | undefined>),
    requestResult(store.get(localSaveRevisionKey(expected.key)) as IDBRequest<StoredRecord | undefined>),
    requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredRecord | undefined>),
  ]);
  await done;
  const parsedRevision = parseLocalSaveRevision(typeof revision?.value === "string" ? revision.value : null);
  const lease = parseLocalSaveWriterLease(typeof leaseRecord?.value === "string" ? leaseRecord.value : null);
  return payload?.value === expected.raw && Number(payload.bytes) === expected.payloadByteLength &&
    catalog?.value === expected.catalogRaw && revision?.value === expected.revisionRaw &&
    parsedRevision?.revision === expected.revision && parsedRevision.checksum === expected.stateChecksum &&
    Boolean(lease && lease.ownerId === expected.fence.ownerId && lease.fencingToken === expected.fence.fencingToken);
}

function backupKeyForPrimary(key: string, mode: "normal" | "speedrun"): string | null {
  if (key !== PRIMARY_KEY && key !== SPEEDRUN_PRIMARY_KEY) return null;
  return mode === "speedrun" ? SPEEDRUN_BACKUP_KEY : BACKUP_KEY;
}

/** Full envelope verification is intentionally Worker-only and only runs for
 * the old primary copy that may become a backup. The UI never parses it. */
function verifyPreviousEnvelopeForBackup(previous: BoundPreviousPayload, mode: "normal" | "speedrun"): boolean {
  try {
    const inspection = inspectCanonicalSaveEnvelope(previous.raw);
    if (inspection) return Boolean(inspection.recordedChecksum === inspection.computedChecksum &&
      inspection.recordedChecksum === previous.catalog.stateChecksum &&
      inspection.mode === mode && inspection.kind === "primary" &&
      inspection.slot === previous.catalog.slot &&
      inspection.savedAt === previous.catalog.savedAt &&
      inspection.state.mode === mode);
    // Tiny pre-catalog fixtures and old envelopes may omit summary fields.
    // Full parsing is bounded here; large saves deliberately never take this
    // compatibility path and therefore cannot recreate the 1.1.4 OOM peak.
    if (previous.byteLength > 1024 * 1024) return false;
    const legacy = inspectSaveEnvelopeChecksum(previous.raw);
    return legacy.status === "valid" && legacy.recordedChecksum === legacy.computedChecksum &&
      legacy.recordedChecksum === previous.catalog.stateChecksum && legacy.parsed?.mode === mode &&
      legacy.parsed?.kind === "primary" && legacy.parsed?.slot === previous.catalog.slot &&
      legacy.parsed?.savedAt === previous.catalog.savedAt && legacy.state?.mode === mode;
  } catch {
    return false;
  }
}

async function writeBackupBestEffort(
  db: IDBDatabase,
  primary: PrimaryCommitExpectation,
  previous: BoundPreviousPayload,
  backupKey: string,
): Promise<{ saved: boolean; revision: number | null }> {
  try {
    const transaction = db.transaction(RECORD_STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(RECORD_STORE);
    const now = Date.now();
    const [leaseRecord, currentCatalog, currentRevision, existingBackup, backupRevisionRecord] = await Promise.all([
      requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredRecord | undefined>),
      requestResult(store.get(localSaveCatalogRecordKey(primary.key)) as IDBRequest<StoredRecord | undefined>),
      requestResult(store.get(localSaveRevisionKey(primary.key)) as IDBRequest<StoredRecord | undefined>),
      requestResult(store.get(backupKey) as IDBRequest<StoredRecord | undefined>),
      requestResult(store.get(localSaveRevisionKey(backupKey)) as IDBRequest<StoredRecord | undefined>),
    ]);
    const lease = parseLocalSaveWriterLease(typeof leaseRecord?.value === "string" ? leaseRecord.value : null);
    const parsedBackupRevision = parseLocalSaveRevision(typeof backupRevisionRecord?.value === "string" ? backupRevisionRecord.value : null);
    if (!leaseMatches(lease, primary.fence, now) || currentCatalog?.value !== primary.catalogRaw || currentRevision?.value !== primary.revisionRaw ||
      existingBackup !== undefined && parsedBackupRevision === null) {
      await abortTransaction(transaction, done);
      return { saved: false, revision: null };
    }
    const nextRevision = (parsedBackupRevision?.revision ?? 0) + 1;
    const backupCatalog: LocalSaveCatalog = {
      ...previous.catalog,
      key: backupKey,
      kind: "backup",
      slot: "main",
      revision: nextRevision,
    };
    const catalogRaw = serializeLocalSaveCatalog(backupCatalog);
    const nextRevisionRaw = revisionRaw(
      backupKey,
      nextRevision,
      previous.catalog.savedAt,
      previous.catalog.stateChecksum,
      primary.fence,
      now,
    );
    store.put(storedRecord(LOCAL_SAVE_WRITER_LEASE_KEY, JSON.stringify(renewedLease(lease!, now)), { updatedAt: now }));
    store.put(storedRecord(backupKey, previous.raw, { byteLength: previous.byteLength, updatedAt: now }));
    store.put(storedRecord(localSaveCatalogRecordKey(backupKey), catalogRaw, { updatedAt: now }));
    store.put(storedRecord(localSaveRevisionKey(backupKey), nextRevisionRaw, { updatedAt: now }));
    await done;
    const verify = db.transaction(RECORD_STORE, "readonly");
    const verifyDone = transactionDone(verify);
    const verifyStore = verify.objectStore(RECORD_STORE);
    const [payloadCommitted, catalogCommitted, revisionCommitted] = await Promise.all([
      requestResult(verifyStore.get(backupKey) as IDBRequest<StoredRecord | undefined>),
      requestResult(verifyStore.get(localSaveCatalogRecordKey(backupKey)) as IDBRequest<StoredRecord | undefined>),
      requestResult(verifyStore.get(localSaveRevisionKey(backupKey)) as IDBRequest<StoredRecord | undefined>),
    ]);
    await verifyDone;
    return {
      saved: payloadCommitted?.value === previous.raw && Number(payloadCommitted.bytes) === previous.byteLength &&
        catalogCommitted?.value === catalogRaw && revisionCommitted?.value === nextRevisionRaw,
      revision: payloadCommitted?.value === previous.raw && Number(payloadCommitted.bytes) === previous.byteLength &&
        catalogCommitted?.value === catalogRaw && revisionCommitted?.value === nextRevisionRaw ? nextRevision : null,
    };
  } catch {
    return { saved: false, revision: null };
  }
}

async function commitPayload(
  request: AuthoritativeSavePersistenceRequest<WorkerBinaryPayload>,
  storedPayload: ArrayBuffer,
  report: (progress: AuthoritativeSavePersistenceProgress) => void,
): Promise<AuthoritativeSavePersistenceResult> {
  const decodeStarted = performance.now();
  if (!validNonNegativeInteger(request.expectedRevision) || request.expectedRevision > 0x7fffffff ||
    !validWriterFence(request.fence) ||
    !validSeed(request.seed, request.key, request.proof) || storedPayload.byteLength !== request.proof.storedByteLength) {
    return failure("invalid", "authoritative payload proof 或 key/seed 不合法");
  }
  const { bindingSha256, ...proofWithoutBinding } = request.proof;
  if (await computeAuthoritativeSaveProofBindingSha256(proofWithoutBinding, request.seed) !== bindingSha256) {
    return failure("invalid", "authoritative payload proof 与 catalog seed binding 不匹配");
  }
  report({ stage: "decoding-payload", key: request.key, bytes: request.proof.byteLength });
  if (await sha256Bytes(storedPayload) !== request.proof.storedSha256) {
    return failure("invalid", "authoritative 存档传输 SHA-256 与 Worker proof 不匹配");
  }
  const payload = await decodeSavePayloadTransport(storedPayload, request.proof.transportEncoding);
  if (payload.byteLength !== request.proof.byteLength ||
    computeSavePayloadChecksum(payload) !== request.proof.payloadChecksum ||
    await sha256Bytes(payload) !== request.proof.payloadSha256) {
    return failure("invalid", "authoritative 原始存档 checksum 与 Worker proof 不匹配");
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return failure("invalid", "authoritative payload 不是合法 UTF-8");
  }
  // The serializer proof is not sufficient by itself: a caller could pair a
  // valid proof/seed with a different, structurally valid envelope. Reinspect
  // the exact bytes in this Worker and bind the envelope header and state
  // checksum to the same seed that will become the catalog record.
  const envelopeMismatch = newEnvelopeMismatch(raw, request);
  if (envelopeMismatch) {
    return failure("invalid", `authoritative payload envelope header/state 与 catalog seed 不一致（${envelopeMismatch}）`);
  }
  const decodeMs = Math.max(0, performance.now() - decodeStarted);
  const db = await openDatabase();
  try {
    report({ stage: "writing-idb", key: request.key, bytes: payload.byteLength });
    const primaryWriteStarted = performance.now();
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
    if (!leaseMatches(lease, request.fence, now)) {
      await abortTransaction(transaction, done);
      return failure("lease-lost", "authoritative save writer lease 已失效");
    }
    const persisted = typeof currentRecord?.value === "string" ? currentRecord.value : null;
    const currentRevision = parseLocalSaveRevision(typeof currentRevisionRecord?.value === "string" ? currentRevisionRecord.value : null);
    const currentCatalog = parseLocalSaveCatalog(typeof currentCatalogRecord?.value === "string" ? currentCatalogRecord.value : null, request.key);
    if (!revisionMatchesExpected(currentRevision, request.key, request.expectedRevision, persisted, lease!)) {
      await abortTransaction(transaction, done);
      return failure("cas-mismatch", "authoritative save revision metadata 已变化或缺失");
    }
    let previous: BoundPreviousPayload | null = null;
    if (persisted !== null) {
      if (!payloadMatchesCatalogAndRevision(persisted, currentRecord!, currentCatalog, currentRevision, request.expectedRevision)) {
        await abortTransaction(transaction, done);
        return failure("cas-mismatch", "authoritative save 当前 payload/catalog/revision proof 不一致");
      }
      previous = { raw: persisted, catalog: currentCatalog, byteLength: currentCatalog.byteLength };
    } else if (currentCatalogRecord !== undefined) {
      await abortTransaction(transaction, done);
      return failure("cas-mismatch", "authoritative save 缺少 payload 但仍存在 catalog");
    }

    const nextRevision = request.expectedRevision + 1;
    const catalog = catalogFromSeed(request.key, nextRevision, request.proof, request.seed);
    let catalogRaw: string;
    try {
      catalogRaw = serializeLocalSaveCatalog(catalog);
    } catch {
      await abortTransaction(transaction, done);
      return failure("invalid", "authoritative catalog seed 无法序列化到4KiB边界");
    }
    const nextRevisionRaw = revisionRaw(
      request.key,
      nextRevision,
      request.seed.savedAt,
      request.seed.stateChecksum,
      request.fence,
      now,
    );
    const nextLeaseRaw = JSON.stringify(renewedLease(lease!, now));
    store.put(storedRecord(LOCAL_SAVE_WRITER_LEASE_KEY, nextLeaseRaw, { updatedAt: now }));
    store.put(storedRecord(request.key, raw, { byteLength: request.proof.byteLength, updatedAt: now }));
    store.put(storedRecord(localSaveCatalogRecordKey(request.key), catalogRaw, { updatedAt: now }));
    store.put(storedRecord(localSaveRevisionKey(request.key), nextRevisionRaw, { updatedAt: now }));
    const [catalogReadback, revisionReadback] = await Promise.all([
      requestResult(store.get(localSaveCatalogRecordKey(request.key)) as IDBRequest<StoredRecord | undefined>),
      requestResult(store.get(localSaveRevisionKey(request.key)) as IDBRequest<StoredRecord | undefined>),
    ]);
    if (catalogReadback?.value !== catalogRaw || revisionReadback?.value !== nextRevisionRaw) {
      await abortTransaction(transaction, done);
      return failure("readback-failed", "authoritative save 事务内回读失败");
    }
    await done;
    const expectation: PrimaryCommitExpectation = {
      key: request.key,
      raw,
      payloadByteLength: request.proof.byteLength,
      catalogRaw,
      revisionRaw: nextRevisionRaw,
      revision: nextRevision,
      stateChecksum: request.seed.stateChecksum,
      fence: request.fence,
    };
    report({ stage: "readback", key: request.key, bytes: request.proof.byteLength, revision: nextRevision });
    if (!await verifyPrimaryAfterCommit(db, expectation)) {
      return failure("readback-failed", "authoritative save 提交后独立事务回读失败");
    }
    const backupVerifyStarted = performance.now();
    const backupEligible = Boolean(previous && verifyPreviousEnvelopeForBackup(previous, request.seed.mode));
    const backupVerifyMs = Math.max(0, performance.now() - backupVerifyStarted);
    const backupKey = request.preserveBackup === false ? null : backupKeyForPrimary(request.key, request.seed.mode);
    const backup = backupKey && previous && backupEligible
      ? await writeBackupBestEffort(db, expectation, previous, backupKey)
      : { saved: false, revision: null };
    const proof: AuthoritativeSavePersistenceProof = {
      key: request.key,
      revision: nextRevision,
      savedAt: request.seed.savedAt,
      byteLength: request.proof.byteLength,
      payloadChecksum: request.proof.payloadChecksum,
      payloadSha256: request.proof.payloadSha256,
      stateChecksum: request.seed.stateChecksum,
      transportEncoding: request.proof.transportEncoding,
      storedByteLength: request.proof.storedByteLength,
      backupKey,
      backupRevision: backup.revision,
      backupSaved: backup.saved,
      workerDecodeMs: decodeMs,
      idbWriteMs: Math.max(0, performance.now() - primaryWriteStarted),
      backupVerifyMs,
      totalBytesWritten: request.proof.byteLength + (backup.saved && previous ? previous.byteLength : 0),
    };
    return { ok: true, proof };
  } finally {
    db.close();
  }
}

function responseTransferables(response: AuthoritativeSavePersistenceResponse): Transferable[] {
  return response.type !== "progress" && "sourcePayloadTransfer" in response && response.sourcePayloadTransfer
    ? [response.sourcePayloadTransfer]
    : [];
}

function postResponse(response: AuthoritativeSavePersistenceResponse): void {
  self.postMessage(response, { transfer: responseTransferables(response) });
}

async function handle(request: AuthoritativeSavePersistenceRequest<WorkerBinaryPayload>): Promise<void> {
  const sourcePayload = request.payload;
  const sourceBytes = workerBinaryPayloadByteLength(sourcePayload);
  const report = (progress: AuthoritativeSavePersistenceProgress) => {
    self.postMessage({ id: request.id, type: "progress", progress } satisfies AuthoritativeSavePersistenceResponse);
  };
  report({ stage: "queued", key: request.key, bytes: sourceBytes });
  report({ stage: "validating-proof", key: request.key, bytes: sourceBytes });
  let result: AuthoritativeSavePersistenceResult;
  try {
    const payload = await workerBinaryPayloadToArrayBuffer(sourcePayload);
    result = await commitPayload(request, payload, report);
  } catch (error) {
    const reason = failureReasonForError(error);
    result = failure(reason, error instanceof Error ? error.message : "authoritative save persistence Worker 失败");
  }
  if (result.ok) report({ stage: "verified", key: request.key, bytes: sourceBytes, revision: result.proof.revision });
  else report({ stage: "failed", key: request.key, bytes: sourceBytes, reason: result.reason });
  postResponse({
    id: request.id,
    type: "result",
    result,
    ...(sourcePayload instanceof ArrayBuffer ? { sourcePayloadTransfer: sourcePayload } : {}),
  });
}

let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<AuthoritativeSavePersistenceRequest<WorkerBinaryPayload>>) => {
  queue = queue.then(() => handle(event.data), () => handle(event.data));
};

export {};
