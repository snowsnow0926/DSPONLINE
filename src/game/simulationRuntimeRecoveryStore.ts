import type { SimulationRuntimeRecoveryBaseIdentity } from "./simulationRuntimeRecovery";
import {
  SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES,
  SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_STAGED_INTENT_BYTES,
  SIMULATION_RUNTIME_DURABLE_RECOVERY_GZIP_BYTES_PER_HOUR,
  SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_PRIMARY_REBASE_CADENCE_EVENTS,
  SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_TRANSFER_CADENCE_EVENTS,
  SIMULATION_RUNTIME_DURABLE_RECOVERY_MIN_TRANSFER_INTERVAL_MS,
  SIMULATION_RUNTIME_DURABLE_RECOVERY_RAW_BYTES_PER_HOUR,
  SIMULATION_RUNTIME_DURABLE_RECOVERY_TRANSFER_WINDOW_MS,
  advanceSimulationRuntimeDurableCheckpointCadence,
  computeSimulationRuntimeDurableBytesSha256,
  computeSimulationRuntimeDurableIntentSha256,
  finalizeSimulationRuntimeDurableRecoveryIntent,
  getSimulationRuntimeDurableJournalStats,
  validateSimulationRuntimeDurableCheckpointCadence,
  validateSimulationRuntimeDurableJournalEntryDigests,
  validateSimulationRuntimeDurableOperationIntent,
  validateSimulationRuntimeDurableRecoveryRecord,
  type SimulationRuntimeDurableCheckpoint,
  type SimulationRuntimeDurableCheckpointCadence,
  type SimulationRuntimeDurableJournalEntry,
  type SimulationRuntimeDurableOperationIntent,
  type SimulationRuntimeDurablePrimaryCheckpoint,
  type SimulationRuntimeDurableRecoveryReadRecord,
  type SimulationRuntimeDurableRecoveryRecord,
} from "./simulationRuntimeDurableRecovery";
import {
  LOCAL_SAVE_LEASE_DURATION_MS,
  LOCAL_SAVE_WRITER_LEASE_KEY,
  localSaveRevisionKey,
  parseLocalSaveRevision,
  parseLocalSaveWriterLease,
  type LocalSaveWriterLease,
} from "./localSaveCoordination";
import { localSaveCatalogRecordKey, parseLocalSaveCatalog } from "./localSaveCatalog";
import type { SaveMode } from "./types";

const DATABASE_NAME = "dsp-idle-network.local-saves";
const DATABASE_VERSION = 2;
const RECORD_STORE = "records";

export const SIMULATION_RUNTIME_RECOVERY_RECORD_PREFIX = "dsp-idle-network.runtime-recovery.v1";
export const SIMULATION_RUNTIME_RECOVERY_MAX_RETAINED_GENERATIONS_PER_MODE = 3;

const CHECKPOINT_RECORD_PREFIX = `${SIMULATION_RUNTIME_RECOVERY_RECORD_PREFIX}.checkpoint.`;
const JOURNAL_RECORD_PREFIX = `${SIMULATION_RUNTIME_RECOVERY_RECORD_PREFIX}.journal.`;
const PENDING_INTENT_RECORD_PREFIX = `${SIMULATION_RUNTIME_RECOVERY_RECORD_PREFIX}.pending-intent.`;
const BACKOFF_STORAGE_MS = 5_000;
const BACKOFF_QUOTA_MS = 30_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SimulationRuntimeRecoveryWriterFence {
  ownerId: string;
  fencingToken: number;
}

export interface SimulationRuntimeRecoveryAbsorbedIntent {
  intent: SimulationRuntimeDurableOperationIntent;
  resultStateRevision: number;
}

export interface SimulationRuntimeRecoveryDurableProof {
  schemaVersion: 1;
  sessionId: string;
  generation: number;
  sequence: number;
  stateRevision: number;
  checkpointSource: "primary" | "transfer";
  primaryStateChecksum?: string;
  primaryRevision?: number;
  transferEncoding?: "raw" | "gzip";
  storedSha256?: string;
  storedByteLength?: number;
  originalSha256?: string;
  originalByteLength?: number;
  journalSha256: string;
  journalByteLength: number;
  pending: boolean;
  finalized: boolean;
  intentSha256?: string;
  resultStateRevision?: number;
  requiresCheckpointBarrier?: boolean;
  recoveredFromPrevious?: true;
  quarantinedCorruptRecovery?: true;
}

export interface SimulationRuntimeRecoveryPreparedIntent {
  schemaVersion: 1;
  intent: SimulationRuntimeDurableOperationIntent;
  encoding: "json" | "raw" | "gzip";
  value?: string;
  buffer?: ArrayBuffer;
  storedByteLength: number;
  originalByteLength: number;
  storedSha256: string;
  originalSha256: string;
}

export type SimulationRuntimeRecoveryFailureReason =
  | "storage-unavailable"
  | "lease-lost"
  | "cas-mismatch"
  | "quota"
  | "transaction-aborted"
  | "readback-failed"
  | "corrupt"
  | "journal-too-large"
  | "intent-too-large"
  | "pending-intent"
  | "checkpoint-rate-limited"
  | "operation-conflict"
  | "invalid"
  | "backoff";

export interface SimulationRuntimeRecoveryFailure {
  ok: false;
  reason: SimulationRuntimeRecoveryFailureReason;
  message: string;
  retryable: boolean;
  degraded: boolean;
  retryAfterMs?: number;
  durableProof?: SimulationRuntimeRecoveryDurableProof;
}

export interface SimulationRuntimeRecoveryMutationSuccess {
  ok: true;
  proof: SimulationRuntimeRecoveryDurableProof;
  idempotent: boolean;
}

export type SimulationRuntimeRecoveryMutationResult =
  | SimulationRuntimeRecoveryMutationSuccess
  | SimulationRuntimeRecoveryFailure;

export type SimulationRuntimeRecoveryReadResult =
  | {
      ok: true;
      recovery: SimulationRuntimeDurableRecoveryReadRecord | null;
      proof: SimulationRuntimeRecoveryDurableProof | null;
      diagnostic?: "corrupt-recovery-quarantined";
    }
  | SimulationRuntimeRecoveryFailure;

export type SimulationRuntimeRecoveryClearTarget =
  | SimulationRuntimeRecoveryBaseIdentity
  | { mode: SaveMode; sessionId: string };

export type SimulationRuntimeRecoveryClearResult =
  | {
      ok: true;
      cleared: boolean;
      proof: SimulationRuntimeRecoveryDurableProof | null;
      diagnostic?: "corrupt-recovery-quarantined";
    }
  | SimulationRuntimeRecoveryFailure;

interface StoredStringRecord {
  key: string;
  value: string;
  updatedAt: number;
  bytes: number;
}

interface AbsorbedIntentProof {
  sequence: number;
  intentSha256: string;
  resultRevision: number;
}

interface StoredCheckpointRecord {
  key: string;
  recordType: "simulation-runtime-recovery-checkpoint";
  schemaVersion: 1;
  checkpoint: SimulationRuntimeDurableCheckpoint;
  absorbedIntent: AbsorbedIntentProof | null;
  writerId: string;
  fencingToken: number;
  updatedAt: number;
}

interface StoredJournalPayload {
  schemaVersion: 1;
  recordType: "simulation-runtime-recovery-journal";
  sessionId: string;
  generation: number;
  checkpointIdentity: string;
  revision: number;
  entries: SimulationRuntimeDurableJournalEntry[];
  writerId: string;
  fencingToken: number;
  updatedAt: number;
}

interface StoredPendingIntentRecord {
  key: string;
  recordType: "simulation-runtime-recovery-pending-intent";
  schemaVersion: 1;
  mode: SaveMode;
  sessionId: string;
  generation: number;
  sequence: number;
  baseStateRevision: number;
  intentSha256: string;
  encoding: "json" | "raw" | "gzip";
  value?: string;
  buffer?: ArrayBuffer;
  storedByteLength: number;
  originalByteLength: number;
  storedSha256: string;
  originalSha256: string;
  writerId: string;
  fencingToken: number;
  updatedAt: number;
}

interface LoadedPendingIntent {
  record: StoredPendingIntentRecord;
  intent: SimulationRuntimeDurableOperationIntent;
}

interface StoredGenerationReference {
  sessionId: string;
  generation: number;
  baseIdentity: SimulationRuntimeRecoveryBaseIdentity;
  checkpointKey: string;
  journalKey: string;
  sequence: number;
  stateRevision: number;
  checkpointSource: "primary" | "transfer";
  primaryStateChecksum: string | null;
  primaryRevision: number | null;
  transferEncoding: "raw" | "gzip" | null;
  storedSha256: string | null;
  storedByteLength: number;
  originalSha256: string | null;
  originalByteLength: number;
  journalSha256: string;
  journalByteLength: number;
  journalRevision: number;
  absorbedIntent: AbsorbedIntentProof | null;
}

interface StoredRecoveryHead {
  schemaVersion: 1;
  recordType: "simulation-runtime-recovery-head";
  mode: SaveMode;
  revision: number;
  active: StoredGenerationReference;
  previous: StoredGenerationReference | null;
  cadence: SimulationRuntimeDurableCheckpointCadence;
  writerId: string;
  fencingToken: number;
  updatedAt: number;
}

interface PreparedCheckpoint {
  checkpointRecord: StoredCheckpointRecord;
  journalRecord: StoredStringRecord;
  journalPayload: StoredJournalPayload;
  reference: StoredGenerationReference;
}

interface LoadedGeneration {
  record: SimulationRuntimeDurableRecoveryRecord;
  reference: StoredGenerationReference;
  checkpointRecord: StoredCheckpointRecord;
  journalRecord: StoredStringRecord;
  journalPayload: StoredJournalPayload;
  proof: SimulationRuntimeRecoveryDurableProof;
}

type LoadedGenerationMetadata = Omit<LoadedGeneration, "record" | "checkpointRecord">;

interface HeadSnapshot {
  raw: string | null;
  head: StoredRecoveryHead | null;
}

interface CorruptHeadRecordFingerprint {
  recordKeys: string[];
  keyShape: string;
  valueShape: string;
  updatedAtShape: string;
  bytesShape: string;
}

type HeadRecordInspection =
  | { kind: "absent" }
  | { kind: "valid"; raw: string; head: StoredRecoveryHead }
  | { kind: "corrupt"; fingerprint: CorruptHeadRecordFingerprint };

class RecoveryStoreError extends Error {
  constructor(
    readonly reason: SimulationRuntimeRecoveryFailureReason,
    message: string,
    readonly retryable = false,
    readonly durableProof?: SimulationRuntimeRecoveryDurableProof,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RecoveryStoreError";
  }
}

let databasePromise: Promise<IDBDatabase> | null = null;
let backoffUntil = 0;
let backoffReason: SimulationRuntimeRecoveryFailureReason | null = null;

const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const value of bytes) result += value.toString(16).padStart(2, "0");
  return result;
}

async function sha256Text(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new RecoveryStoreError("storage-unavailable", "当前环境不支持恢复日志 SHA-256 校验");
  return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", textEncoder.encode(value))));
}

function headKey(mode: SaveMode): string {
  return `${SIMULATION_RUNTIME_RECOVERY_RECORD_PREFIX}.head.${mode}`;
}

function generationKeyPrefix(kind: "checkpoint" | "journal", mode: SaveMode): string {
  return `${SIMULATION_RUNTIME_RECOVERY_RECORD_PREFIX}.${kind}.${mode}.`;
}

function checkpointKey(mode: SaveMode, sessionId: string, generation: number): string {
  return `${generationKeyPrefix("checkpoint", mode)}${encodeURIComponent(sessionId)}.${generation}`;
}

function journalKey(mode: SaveMode, sessionId: string, generation: number): string {
  return `${generationKeyPrefix("journal", mode)}${encodeURIComponent(sessionId)}.${generation}`;
}

export function isSimulationRuntimeRecoveryRecordKey(key: string): boolean {
  return key.startsWith(`${SIMULATION_RUNTIME_RECOVERY_RECORD_PREFIX}.`);
}

function validFence(fence: SimulationRuntimeRecoveryWriterFence): boolean {
  return typeof fence.ownerId === "string" && fence.ownerId.length > 0 && fence.ownerId.length <= 200 &&
    Number.isSafeInteger(fence.fencingToken) && fence.fencingToken >= 1;
}

function validBaseIdentity(value: unknown): value is SimulationRuntimeRecoveryBaseIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<SimulationRuntimeRecoveryBaseIdentity>;
  return (identity.mode === "normal" || identity.mode === "speedrun") &&
    typeof identity.savedAt === "number" && Number.isFinite(identity.savedAt) && identity.savedAt >= 0 &&
    typeof identity.checksum === "string" && identity.checksum.length > 0 && identity.checksum.length <= 256 &&
    Number.isSafeInteger(identity.revision) && identity.revision! >= 0;
}

function sameBaseIdentity(left: SimulationRuntimeRecoveryBaseIdentity, right: SimulationRuntimeRecoveryBaseIdentity): boolean {
  return left.mode === right.mode && left.savedAt === right.savedAt && left.checksum === right.checksum &&
    left.revision === right.revision;
}

function primarySaveKey(mode: SaveMode): string {
  return mode === "speedrun" ? "dsp-idle-network.save.v1.speedrun" : "dsp-idle-network.save.v1";
}

async function durablePrimaryMatchesBase(
  store: IDBObjectStore,
  baseIdentity: SimulationRuntimeRecoveryBaseIdentity,
): Promise<boolean> {
  const current = await readDurablePrimaryIdentity(store, baseIdentity.mode);
  return Boolean(current && sameBaseIdentity(current, baseIdentity));
}

async function readDurablePrimaryIdentity(
  store: IDBObjectStore,
  mode: SaveMode,
): Promise<SimulationRuntimeRecoveryBaseIdentity | null> {
  const saveKey = primarySaveKey(mode);
  const [catalogRecord, revisionRecord] = await Promise.all([
    requestResult(store.get(localSaveCatalogRecordKey(saveKey)) as IDBRequest<StoredStringRecord | undefined>),
    requestResult(store.get(localSaveRevisionKey(saveKey)) as IDBRequest<StoredStringRecord | undefined>),
  ]);
  const catalog = parseLocalSaveCatalog(catalogRecord?.value, saveKey);
  const revision = parseLocalSaveRevision(revisionRecord?.value);
  if (!catalog || catalog.mode !== mode || catalog.kind !== "primary" || catalog.integrity !== "valid" ||
    !catalog.stateChecksum || (revision ? revision.saveKey !== saveKey || revision.deleted ||
      revision.revision !== catalog.revision || revision.savedAt !== catalog.savedAt ||
      revision.checksum !== catalog.stateChecksum : catalog.revision !== 0)) return null;
  return { mode, savedAt: catalog.savedAt, checksum: catalog.stateChecksum, revision: catalog.revision };
}

async function durablePrimaryMatchesBaseInDatabase(
  db: IDBDatabase,
  baseIdentity: SimulationRuntimeRecoveryBaseIdentity,
): Promise<boolean> {
  const transaction = db.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const matches = await durablePrimaryMatchesBase(transaction.objectStore(RECORD_STORE), baseIdentity);
  await done;
  return matches;
}

function validAbsorbedIntent(value: unknown): value is AbsorbedIntentProof | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<AbsorbedIntentProof>;
  return Number.isSafeInteger(proof.sequence) && proof.sequence! >= 1 && SHA256_PATTERN.test(proof.intentSha256 ?? "") &&
    Number.isSafeInteger(proof.resultRevision) && proof.resultRevision! >= 0;
}

function validCadence(value: unknown): value is SimulationRuntimeDurableCheckpointCadence {
  if (!value || typeof value !== "object") return false;
  const cadence = value as Partial<SimulationRuntimeDurableCheckpointCadence>;
  if (!(typeof cadence.windowStartedAtMs === "number" && Number.isFinite(cadence.windowStartedAtMs) &&
    typeof cadence.lastTransferAtMs === "number" && Number.isFinite(cadence.lastTransferAtMs) &&
    Array.isArray(cadence.transferEvents) &&
    cadence.transferEvents.length <= SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_TRANSFER_CADENCE_EVENTS &&
    cadence.transferEvents.every((event) => event &&
      typeof event.committedAtMs === "number" && Number.isFinite(event.committedAtMs) &&
      (event.encoding === "raw" || event.encoding === "gzip") && Number.isSafeInteger(event.bytes) && event.bytes >= 0) &&
    Array.isArray(cadence.primaryRebaseEventsMs) &&
    cadence.primaryRebaseEventsMs.length <= SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_PRIMARY_REBASE_CADENCE_EVENTS &&
    cadence.primaryRebaseEventsMs.every((time) => typeof time === "number" && Number.isFinite(time)) &&
    Number.isSafeInteger(cadence.transferCountInWindow) && cadence.transferCountInWindow! >= 0 &&
    Number.isSafeInteger(cadence.primaryRebaseCountInWindow) && cadence.primaryRebaseCountInWindow! >= 0 &&
    Number.isSafeInteger(cadence.gzipBytesInWindow) && cadence.gzipBytesInWindow! >= 0 &&
    Number.isSafeInteger(cadence.rawBytesInWindow) && cadence.rawBytesInWindow! >= 0 &&
    (cadence.lastCheckpointSource === null || cadence.lastCheckpointSource === "primary" || cadence.lastCheckpointSource === "transfer") &&
    (cadence.lastTransferEncoding === null || cadence.lastTransferEncoding === "raw" || cadence.lastTransferEncoding === "gzip"))) return false;
  const transferEvents = cadence.transferEvents!;
  const primaryEvents = cadence.primaryRebaseEventsMs!;
  return transferEvents.length === cadence.transferCountInWindow && primaryEvents.length === cadence.primaryRebaseCountInWindow &&
    transferEvents.reduce((bytes, event) => bytes + (event.encoding === "gzip" ? event.bytes : 0), 0) === cadence.gzipBytesInWindow &&
    transferEvents.reduce((bytes, event) => bytes + (event.encoding === "raw" ? event.bytes : 0), 0) === cadence.rawBytesInWindow &&
    (transferEvents.length === 0 || cadence.lastTransferAtMs! >= transferEvents.at(-1)!.committedAtMs);
}

function validGenerationReference(value: unknown, mode: SaveMode): value is StoredGenerationReference {
  if (!value || typeof value !== "object") return false;
  const reference = value as Partial<StoredGenerationReference>;
  if (!(typeof reference.sessionId === "string" && SESSION_ID_PATTERN.test(reference.sessionId) &&
    Number.isSafeInteger(reference.generation) && reference.generation! >= 1 && validBaseIdentity(reference.baseIdentity) &&
    reference.baseIdentity.mode === mode &&
    reference.checkpointKey === checkpointKey(mode, reference.sessionId, reference.generation!) &&
    reference.journalKey === journalKey(mode, reference.sessionId, reference.generation!) &&
    Number.isSafeInteger(reference.sequence) && reference.sequence! >= 0 &&
    Number.isSafeInteger(reference.stateRevision) && reference.stateRevision! >= 0 &&
    (reference.checkpointSource === "primary" || reference.checkpointSource === "transfer") &&
    (reference.primaryStateChecksum === null || typeof reference.primaryStateChecksum === "string") &&
    (reference.primaryRevision === null || Number.isSafeInteger(reference.primaryRevision) && reference.primaryRevision! >= 0) &&
    (reference.transferEncoding === null || reference.transferEncoding === "raw" || reference.transferEncoding === "gzip") &&
    (reference.storedSha256 === null || SHA256_PATTERN.test(reference.storedSha256 ?? "")) &&
    Number.isSafeInteger(reference.storedByteLength) && reference.storedByteLength! >= 0 &&
    (reference.originalSha256 === null || SHA256_PATTERN.test(reference.originalSha256 ?? "")) &&
    Number.isSafeInteger(reference.originalByteLength) && reference.originalByteLength! >= 0 &&
    SHA256_PATTERN.test(reference.journalSha256 ?? "") && Number.isSafeInteger(reference.journalByteLength) && reference.journalByteLength! > 0 &&
    reference.journalByteLength! <= SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES &&
    Number.isSafeInteger(reference.journalRevision) && reference.journalRevision! >= 0 &&
    validAbsorbedIntent(reference.absorbedIntent))) return false;
  return reference.checkpointSource === "primary"
    ? reference.primaryStateChecksum === reference.baseIdentity!.checksum &&
      reference.primaryRevision === reference.baseIdentity!.revision && reference.transferEncoding === null &&
      reference.storedSha256 === null && reference.storedByteLength === 0 && reference.originalSha256 === null &&
      reference.originalByteLength === 0
    : reference.primaryStateChecksum === null && reference.primaryRevision === null &&
      (reference.transferEncoding === "raw" || reference.transferEncoding === "gzip") &&
      SHA256_PATTERN.test(reference.storedSha256 ?? "") && reference.storedByteLength! > 0 &&
      SHA256_PATTERN.test(reference.originalSha256 ?? "") && reference.originalByteLength! > 0;
}

function parseHead(raw: string | null, mode: SaveMode): StoredRecoveryHead | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredRecoveryHead>;
    if (value.schemaVersion !== 1 || value.recordType !== "simulation-runtime-recovery-head" || value.mode !== mode ||
      !Number.isSafeInteger(value.revision) || value.revision! < 1 || !validGenerationReference(value.active, mode) ||
      !(value.previous === null || validGenerationReference(value.previous, mode)) ||
      value.previous && value.previous.sessionId !== value.active.sessionId ||
      !validCadence(value.cadence) ||
      typeof value.writerId !== "string" || value.writerId.length === 0 || !Number.isSafeInteger(value.fencingToken) ||
      value.fencingToken! < 1 || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
    return value as StoredRecoveryHead;
  } catch {
    return null;
  }
}

function corruptRecordValueShape(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${String(value)}`;
  }
  if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "undefined") {
    return `${typeof value}:${String(value)}`;
  }
  if (Array.isArray(value)) return `array:${value.length}:${Object.keys(value).sort().join(",")}`;
  if (value instanceof ArrayBuffer) return `array-buffer:${value.byteLength}`;
  if (ArrayBuffer.isView(value)) return `array-buffer-view:${value.constructor.name}:${value.byteLength}`;
  if (typeof value === "object") {
    const tag = Object.prototype.toString.call(value);
    return `object:${tag}:${Object.keys(value as object).sort().join(",")}`;
  }
  return typeof value;
}

function inspectHeadRecord(record: unknown, mode: SaveMode): HeadRecordInspection {
  if (record === undefined) return { kind: "absent" };
  const candidate = record && typeof record === "object" ? record as Record<string, unknown> : null;
  if (candidate && typeof candidate.value === "string") {
    const head = parseHead(candidate.value, mode);
    if (head) return { kind: "valid", raw: candidate.value, head };
  }
  return {
    kind: "corrupt",
    fingerprint: {
      recordKeys: candidate ? Object.keys(candidate).sort() : [],
      keyShape: corruptRecordValueShape(candidate?.key),
      valueShape: corruptRecordValueShape(candidate?.value),
      updatedAtShape: corruptRecordValueShape(candidate?.updatedAt),
      bytesShape: corruptRecordValueShape(candidate?.bytes),
    },
  };
}

function sameCorruptHeadFingerprint(
  left: CorruptHeadRecordFingerprint,
  right: CorruptHeadRecordFingerprint,
): boolean {
  return left.keyShape === right.keyShape && left.valueShape === right.valueShape &&
    left.updatedAtShape === right.updatedAtShape && left.bytesShape === right.bytesShape &&
    left.recordKeys.length === right.recordKeys.length &&
    left.recordKeys.every((key, index) => key === right.recordKeys[index]);
}

function serializeHead(head: StoredRecoveryHead): string {
  return JSON.stringify(head);
}

function serializeJournal(payload: StoredJournalPayload): string {
  return JSON.stringify(payload);
}

function proofFromReference(reference: StoredGenerationReference, options: {
  pending?: boolean;
  finalized?: boolean;
  intentSha256?: string;
  resultStateRevision?: number;
  recoveredFromPrevious?: boolean;
} = {}): SimulationRuntimeRecoveryDurableProof {
  return {
    schemaVersion: 1,
    sessionId: reference.sessionId,
    generation: reference.generation,
    sequence: reference.sequence,
    stateRevision: reference.stateRevision,
    checkpointSource: reference.checkpointSource,
    ...(reference.primaryStateChecksum ? { primaryStateChecksum: reference.primaryStateChecksum } : {}),
    ...(reference.primaryRevision !== null ? { primaryRevision: reference.primaryRevision } : {}),
    ...(reference.transferEncoding ? { transferEncoding: reference.transferEncoding } : {}),
    ...(reference.storedSha256 ? { storedSha256: reference.storedSha256 } : {}),
    ...(reference.storedByteLength > 0 ? { storedByteLength: reference.storedByteLength } : {}),
    ...(reference.originalSha256 ? { originalSha256: reference.originalSha256 } : {}),
    ...(reference.originalByteLength > 0 ? { originalByteLength: reference.originalByteLength } : {}),
    journalSha256: reference.journalSha256,
    journalByteLength: reference.journalByteLength,
    pending: options.pending ?? false,
    finalized: options.finalized ?? true,
    ...(options.intentSha256 ? { intentSha256: options.intentSha256 } : {}),
    ...(options.resultStateRevision !== undefined ? { resultStateRevision: options.resultStateRevision } : {}),
    ...(options.recoveredFromPrevious ? { recoveredFromPrevious: true as const } : {}),
  };
}

function failureFromError(error: unknown): SimulationRuntimeRecoveryFailure {
  if (error instanceof RecoveryStoreError) {
    const retryAfterMs = error.retryAfterMs ??
      (error.reason === "quota" ? BACKOFF_QUOTA_MS : error.retryable ? BACKOFF_STORAGE_MS : undefined);
    const appliesGlobalBackoff = ["quota", "transaction-aborted", "readback-failed", "corrupt", "storage-unavailable"]
      .includes(error.reason);
    if (retryAfterMs && appliesGlobalBackoff) {
      backoffUntil = Date.now() + retryAfterMs;
      backoffReason = error.reason;
    }
    return {
      ok: false,
      reason: error.reason,
      message: error.message,
      retryable: error.retryable,
      degraded: ["quota", "transaction-aborted", "readback-failed", "corrupt", "storage-unavailable"].includes(error.reason),
      ...(retryAfterMs ? { retryAfterMs } : {}),
      ...(error.durableProof ? { durableProof: error.durableProof } : {}),
    };
  }
  const reason: SimulationRuntimeRecoveryFailureReason = isQuotaError(error)
    ? "quota"
    : error instanceof DOMException && error.name === "AbortError"
      ? "transaction-aborted"
      : "storage-unavailable";
  return failureFromError(new RecoveryStoreError(reason, error instanceof Error ? error.message : "恢复存储不可用", true));
}

function backoffFailure(): SimulationRuntimeRecoveryFailure | null {
  const remaining = Math.max(0, backoffUntil - Date.now());
  if (remaining <= 0) {
    backoffUntil = 0;
    backoffReason = null;
    return null;
  }
  return {
    ok: false,
    reason: "backoff",
    message: `恢复存储暂时退避（${backoffReason ?? "storage-unavailable"}）`,
    retryable: true,
    degraded: true,
    retryAfterMs: remaining,
  };
}

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "QuotaExceededError" || candidate.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    candidate.code === 22 || candidate.code === 1014;
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

function openRecoveryDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const factory = globalThis.indexedDB;
    if (!factory) {
      reject(new RecoveryStoreError("storage-unavailable", "当前环境不支持 IndexedDB"));
      return;
    }
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORD_STORE)) db.createObjectStore(RECORD_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (databasePromise) databasePromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new RecoveryStoreError("storage-unavailable", "IndexedDB 打开失败"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new RecoveryStoreError("storage-unavailable", "IndexedDB 打开被旧页面阻塞", true));
    };
  });
  return databasePromise;
}

function storedStringRecord(key: string, value: string, now = Date.now()): StoredStringRecord {
  return { key, value, updatedAt: now, bytes: byteLength(value) };
}

/**
 * Keep the caller-owned transfer buffer by reference. IndexedDB performs the
 * one required structured clone at put/get boundaries; slicing here would
 * multiply a 35-59 MiB checkpoint at every validation phase.
 */
function checkpointView(checkpoint: SimulationRuntimeDurableCheckpoint): SimulationRuntimeDurableCheckpoint {
  return {
    ...checkpoint,
    baseIdentity: { ...checkpoint.baseIdentity },
    registry: checkpoint.registry,
    ...(checkpoint.source === "transfer" ? {
      transfer: { ...checkpoint.transfer, buffer: checkpoint.transfer.buffer },
    } : {}),
  } as SimulationRuntimeDurableCheckpoint;
}

function recoveryRecordView(
  record: SimulationRuntimeDurableRecoveryRecord,
  pendingIntent: SimulationRuntimeDurableOperationIntent | null,
): SimulationRuntimeDurableRecoveryReadRecord {
  return {
    checkpoint: checkpointView(record.checkpoint),
    entries: structuredClone(record.entries),
    pendingIntent: pendingIntent ? structuredClone(pendingIntent) : null,
  };
}

function arrayBuffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

function checkpointMetadataMatches(
  left: SimulationRuntimeDurableCheckpoint,
  right: SimulationRuntimeDurableCheckpoint,
): boolean {
  if (left.schemaVersion !== right.schemaVersion || left.sessionId !== right.sessionId || left.source !== right.source ||
    left.generation !== right.generation || left.lastSequence !== right.lastSequence ||
    left.stateRevision !== right.stateRevision || left.registryFingerprint !== right.registryFingerprint ||
    left.committedAtMs !== right.committedAtMs || !sameBaseIdentity(left.baseIdentity, right.baseIdentity) ||
    JSON.stringify(left.registry) !== JSON.stringify(right.registry)) return false;
  if (left.source === "primary" && right.source === "primary") {
    return left.primaryStateChecksum === right.primaryStateChecksum && left.primaryRevision === right.primaryRevision;
  }
  if (left.source === "transfer" && right.source === "transfer") {
    return left.transfer.protocolVersion === right.transfer.protocolVersion && left.transfer.encoding === right.transfer.encoding &&
      left.transfer.storedByteLength === right.transfer.storedByteLength &&
      left.transfer.originalByteLength === right.transfer.originalByteLength &&
      left.transfer.storedSha256 === right.transfer.storedSha256 && left.transfer.originalSha256 === right.transfer.originalSha256;
  }
  return false;
}

function checkpointRecordMatches(left: StoredCheckpointRecord | undefined, right: StoredCheckpointRecord): boolean {
  return checkpointRecordMetadataMatches(left, right) && (left!.checkpoint.source === "primary" ||
    right.checkpoint.source === "primary" || arrayBuffersEqual(left!.checkpoint.transfer.buffer, right.checkpoint.transfer.buffer));
}

function checkpointRecordMetadataMatches(left: StoredCheckpointRecord | undefined, right: StoredCheckpointRecord): boolean {
  return Boolean(left && left.key === right.key && left.recordType === right.recordType && left.schemaVersion === 1 &&
    checkpointMetadataMatches(left.checkpoint, right.checkpoint) &&
    (left.checkpoint.source === "primary" && right.checkpoint.source === "primary" ||
      left.checkpoint.source === "transfer" && right.checkpoint.source === "transfer" &&
      left.checkpoint.transfer.buffer.byteLength === right.checkpoint.transfer.buffer.byteLength) &&
    JSON.stringify(left.absorbedIntent) === JSON.stringify(right.absorbedIntent));
}

function validCheckpointRecord(value: unknown, expectedKey: string): value is StoredCheckpointRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredCheckpointRecord>;
  return record.key === expectedKey && record.recordType === "simulation-runtime-recovery-checkpoint" && record.schemaVersion === 1 &&
    Boolean(record.checkpoint) && validAbsorbedIntent(record.absorbedIntent) &&
    typeof record.writerId === "string" && record.writerId.length > 0 &&
    Number.isSafeInteger(record.fencingToken) && record.fencingToken! >= 1 &&
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt);
}

function parseJournal(raw: string | undefined, reference: StoredGenerationReference): StoredJournalPayload | null {
  if (!raw) return null;
  try {
    const journal = JSON.parse(raw) as Partial<StoredJournalPayload>;
    return journal.schemaVersion === 1 && journal.recordType === "simulation-runtime-recovery-journal" &&
      journal.sessionId === reference.sessionId && journal.generation === reference.generation &&
      journal.checkpointIdentity === checkpointIdentityFromReference(reference) && Number.isSafeInteger(journal.revision) && journal.revision! >= 0 &&
      Array.isArray(journal.entries) && typeof journal.writerId === "string" && journal.writerId.length > 0 &&
      Number.isSafeInteger(journal.fencingToken) && journal.fencingToken! >= 1 &&
      typeof journal.updatedAt === "number" && Number.isFinite(journal.updatedAt)
      ? journal as StoredJournalPayload
      : null;
  } catch {
    return null;
  }
}

function leaseMatchesFence(lease: LocalSaveWriterLease | null, fence: SimulationRuntimeRecoveryWriterFence, now: number): boolean {
  return Boolean(lease && lease.ownerId === fence.ownerId && lease.fencingToken === fence.fencingToken && lease.expiresAt > now);
}

async function readLeaseAndHead(
  db: IDBDatabase,
  mode: SaveMode,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<HeadSnapshot> {
  const transaction = db.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const [leaseRecord, headRecord] = await Promise.all([
    requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredStringRecord | undefined>),
    requestResult(store.get(headKey(mode)) as IDBRequest<unknown>),
  ]);
  await done;
  const lease = parseLocalSaveWriterLease(leaseRecord?.value);
  if (!leaseMatchesFence(lease, fence, Date.now())) {
    throw new RecoveryStoreError("lease-lost", "本地存档 writer lease 已失效或被其他页面接管");
  }
  const inspection = inspectHeadRecord(headRecord, mode);
  if (inspection.kind === "corrupt") throw new RecoveryStoreError("corrupt", "模拟恢复 head 已损坏", true);
  return inspection.kind === "absent"
    ? { raw: null, head: null }
    : { raw: inspection.raw, head: inspection.head };
}

async function quarantineCorruptRecoveryHead(
  db: IDBDatabase,
  mode: SaveMode,
  expectedFingerprint: CorruptHeadRecordFingerprint,
  fence: SimulationRuntimeRecoveryWriterFence,
  expectedBase?: SimulationRuntimeRecoveryBaseIdentity,
): Promise<boolean> {
  const transaction = db.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const now = Date.now();
  if (!await renewLeaseInStore(store, fence, now)) {
    await done;
    throw new RecoveryStoreError("lease-lost", "隔离损坏 recovery head 前 writer lease 已失效");
  }
  const [currentHead, primaryIdentity, keys] = await Promise.all([
    requestResult(store.get(headKey(mode)) as IDBRequest<unknown>),
    readDurablePrimaryIdentity(store, mode),
    requestResult(store.getAllKeys() as IDBRequest<IDBValidKey[]>),
  ]);
  const currentInspection = inspectHeadRecord(currentHead, mode);
  if (currentInspection.kind !== "corrupt" ||
    !sameCorruptHeadFingerprint(currentInspection.fingerprint, expectedFingerprint)) {
    await done;
    return false;
  }
  if (!primaryIdentity || expectedBase && !sameBaseIdentity(primaryIdentity, expectedBase)) {
    await done;
    throw new RecoveryStoreError("cas-mismatch", "损坏 recovery head 与当前有效 primary BaseIdentity 无法绑定");
  }
  store.delete(headKey(mode));
  store.delete(pendingIntentKey(mode));
  for (const key of keys) {
    if (typeof key === "string" && isGenerationRecordForMode(key, mode)) store.delete(key);
  }
  const [headReadback, pendingReadback, keysReadback] = await Promise.all([
    requestResult(store.get(headKey(mode)) as IDBRequest<StoredStringRecord | undefined>),
    requestResult(store.get(pendingIntentKey(mode)) as IDBRequest<StoredPendingIntentRecord | undefined>),
    requestResult(store.getAllKeys() as IDBRequest<IDBValidKey[]>),
  ]);
  if (headReadback !== undefined || pendingReadback !== undefined || keysReadback.some((key) =>
    typeof key === "string" && isGenerationRecordForMode(key, mode))) {
    transaction.abort();
    void done.catch(() => undefined);
    throw new RecoveryStoreError("readback-failed", "损坏 recovery 记录隔离事务内回读失败", true);
  }
  await done;
  if (await readHeadRecord(db, mode) !== undefined) {
    throw new RecoveryStoreError("readback-failed", "损坏 recovery head 隔离提交后回读失败", true);
  }
  return true;
}

async function readLeaseAndRecoverableHead(
  db: IDBDatabase,
  mode: SaveMode,
  fence: SimulationRuntimeRecoveryWriterFence,
  expectedBase?: SimulationRuntimeRecoveryBaseIdentity,
): Promise<HeadSnapshot & { quarantined: boolean }> {
  try {
    return { ...await readLeaseAndHead(db, mode, fence), quarantined: false };
  } catch (error) {
    if (!(error instanceof RecoveryStoreError) || error.reason !== "corrupt") throw error;
    const inspection = inspectHeadRecord(await readHeadRecord(db, mode), mode);
    if (inspection.kind === "absent") return { raw: null, head: null, quarantined: false };
    if (inspection.kind === "valid") return { ...await readLeaseAndHead(db, mode, fence), quarantined: false };
    const quarantined = await quarantineCorruptRecoveryHead(db, mode, inspection.fingerprint, fence, expectedBase);
    if (!quarantined) return { ...await readLeaseAndHead(db, mode, fence), quarantined: false };
    return { raw: null, head: null, quarantined: true };
  }
}

async function readLeaseAndSessionHead(
  db: IDBDatabase,
  sessionId: string,
  generation: number,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<HeadSnapshot & { head: StoredRecoveryHead }> {
  const transaction = db.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const [leaseRecord, normalRecord, speedrunRecord] = await Promise.all([
    requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredStringRecord | undefined>),
    requestResult(store.get(headKey("normal")) as IDBRequest<StoredStringRecord | undefined>),
    requestResult(store.get(headKey("speedrun")) as IDBRequest<StoredStringRecord | undefined>),
  ]);
  await done;
  const lease = parseLocalSaveWriterLease(leaseRecord?.value);
  if (!leaseMatchesFence(lease, fence, Date.now())) {
    throw new RecoveryStoreError("lease-lost", "本地存档 writer lease 已失效或被其他页面接管");
  }
  const candidates = ([
    ["normal", normalRecord],
    ["speedrun", speedrunRecord],
  ] as const).flatMap(([mode, record]) => {
    if (typeof record?.value !== "string") return [];
    const head = parseHead(record.value, mode);
    return head?.active.sessionId === sessionId && head.active.generation === generation
      ? [{ raw: record.value, head }]
      : [];
  });
  if (candidates.length !== 1) throw new RecoveryStoreError("cas-mismatch", "恢复 head session/generation 不唯一或不存在");
  return candidates[0];
}

async function renewLeaseInStore(
  store: IDBObjectStore,
  fence: SimulationRuntimeRecoveryWriterFence,
  now: number,
): Promise<LocalSaveWriterLease | null> {
  const record = await requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredStringRecord | undefined>);
  const lease = parseLocalSaveWriterLease(record?.value);
  if (!leaseMatchesFence(lease, fence, now)) return null;
  const renewed: LocalSaveWriterLease = {
    ...lease!,
    heartbeatAt: now,
    expiresAt: now + LOCAL_SAVE_LEASE_DURATION_MS,
  };
  const value = JSON.stringify(renewed);
  store.put(storedStringRecord(LOCAL_SAVE_WRITER_LEASE_KEY, value, now));
  return renewed;
}

function withoutIntentDigest(
  intent: SimulationRuntimeDurableOperationIntent,
): Omit<SimulationRuntimeDurableOperationIntent, "intentSha256"> {
  const { intentSha256: _intentSha256, ...unsigned } = intent;
  return unsigned;
}

async function validateIntentDigest(intent: SimulationRuntimeDurableOperationIntent): Promise<boolean> {
  if (validateSimulationRuntimeDurableOperationIntent(intent) !== null) return false;
  return await computeSimulationRuntimeDurableIntentSha256(withoutIntentDigest(intent)) === intent.intentSha256;
}

async function validateCheckpointTransferBytes(checkpoint: SimulationRuntimeDurableCheckpoint): Promise<boolean> {
  if (checkpoint.source === "primary") return true;
  const transfer = checkpoint.transfer;
  if (await computeSimulationRuntimeDurableBytesSha256(transfer.buffer) !== transfer.storedSha256) return false;
  if (transfer.encoding === "raw") return transfer.storedByteLength === transfer.originalByteLength &&
    transfer.storedSha256 === transfer.originalSha256;
  if (typeof DecompressionStream === "undefined") return false;
  try {
    const original = await new Response(
      new Blob([transfer.buffer]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
    return original.byteLength === transfer.originalByteLength &&
      await computeSimulationRuntimeDurableBytesSha256(original) === transfer.originalSha256;
  } catch {
    return false;
  }
}

function checkpointIdentity(checkpoint: SimulationRuntimeDurableCheckpoint): string {
  return checkpoint.source === "primary"
    ? `primary:${checkpoint.primaryStateChecksum}:${checkpoint.primaryRevision}`
    : `transfer:${checkpoint.transfer.encoding}:${checkpoint.transfer.storedSha256}:${checkpoint.transfer.storedByteLength}:${checkpoint.transfer.originalSha256}:${checkpoint.transfer.originalByteLength}`;
}

function checkpointIdentityFromReference(reference: StoredGenerationReference): string {
  return reference.checkpointSource === "primary"
    ? `primary:${reference.primaryStateChecksum}:${reference.primaryRevision}`
    : `transfer:${reference.transferEncoding}:${reference.storedSha256}:${reference.storedByteLength}:${reference.originalSha256}:${reference.originalByteLength}`;
}

async function prepareCheckpoint(
  checkpointInput: SimulationRuntimeDurableCheckpoint,
  fence: SimulationRuntimeRecoveryWriterFence,
  absorbed: SimulationRuntimeRecoveryAbsorbedIntent | undefined,
): Promise<PreparedCheckpoint> {
  const checkpoint = checkpointView(checkpointInput);
  if (!SESSION_ID_PATTERN.test(checkpoint.sessionId) || !validBaseIdentity(checkpoint.baseIdentity) ||
    checkpoint.registryFingerprint !== checkpoint.registry?.fingerprint ||
    validateSimulationRuntimeDurableRecoveryRecord({ checkpoint, entries: [] }, checkpoint.baseIdentity) !== null) {
    throw new RecoveryStoreError("invalid", "模拟恢复检查点元数据无效");
  }
  if (!await validateCheckpointTransferBytes(checkpoint)) {
    throw new RecoveryStoreError("invalid", "模拟恢复 transfer stored/original SHA-256 不匹配");
  }
  let absorbedProof: AbsorbedIntentProof | null = null;
  if (absorbed) {
    if (!await validateIntentDigest(absorbed.intent) || !Number.isSafeInteger(absorbed.resultStateRevision) ||
      absorbed.resultStateRevision < absorbed.intent.baseStateRevision) {
      throw new RecoveryStoreError("invalid", "模拟恢复 absorbed intent 摘要或结果无效");
    }
    absorbedProof = {
      sequence: absorbed.intent.sequence,
      intentSha256: absorbed.intent.intentSha256,
      resultRevision: absorbed.resultStateRevision,
    };
  }
  const now = Date.now();
  const checkpointRecord: StoredCheckpointRecord = {
    key: checkpointKey(checkpoint.baseIdentity.mode, checkpoint.sessionId, checkpoint.generation),
    recordType: "simulation-runtime-recovery-checkpoint",
    schemaVersion: 1,
    checkpoint,
    absorbedIntent: absorbedProof,
    writerId: fence.ownerId,
    fencingToken: fence.fencingToken,
    updatedAt: now,
  };
  const journalPayload: StoredJournalPayload = {
    schemaVersion: 1,
    recordType: "simulation-runtime-recovery-journal",
    sessionId: checkpoint.sessionId,
    generation: checkpoint.generation,
    checkpointIdentity: checkpointIdentity(checkpoint),
    revision: 0,
    entries: [],
    writerId: fence.ownerId,
    fencingToken: fence.fencingToken,
    updatedAt: now,
  };
  const journalValue = serializeJournal(journalPayload);
  const journalRecord = storedStringRecord(
    journalKey(checkpoint.baseIdentity.mode, checkpoint.sessionId, checkpoint.generation),
    journalValue,
    now,
  );
  if (journalRecord.bytes > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES) {
    throw new RecoveryStoreError("journal-too-large", "模拟恢复空日志超过存储上限");
  }
  const reference: StoredGenerationReference = {
    sessionId: checkpoint.sessionId,
    generation: checkpoint.generation,
    baseIdentity: { ...checkpoint.baseIdentity },
    checkpointKey: checkpointRecord.key,
    journalKey: journalRecord.key,
    sequence: checkpoint.lastSequence,
    stateRevision: checkpoint.stateRevision,
    checkpointSource: checkpoint.source,
    primaryStateChecksum: checkpoint.source === "primary" ? checkpoint.primaryStateChecksum : null,
    primaryRevision: checkpoint.source === "primary" ? checkpoint.primaryRevision : null,
    transferEncoding: checkpoint.source === "transfer" ? checkpoint.transfer.encoding : null,
    storedSha256: checkpoint.source === "transfer" ? checkpoint.transfer.storedSha256 : null,
    storedByteLength: checkpoint.source === "transfer" ? checkpoint.transfer.storedByteLength : 0,
    originalSha256: checkpoint.source === "transfer" ? checkpoint.transfer.originalSha256 : null,
    originalByteLength: checkpoint.source === "transfer" ? checkpoint.transfer.originalByteLength : 0,
    journalSha256: await sha256Text(journalValue),
    journalByteLength: journalRecord.bytes,
    journalRevision: 0,
    absorbedIntent: absorbedProof,
  };
  return { checkpointRecord, journalRecord, journalPayload, reference };
}

async function readGenerationRecords(
  db: IDBDatabase,
  reference: StoredGenerationReference,
): Promise<{ checkpointRecord?: StoredCheckpointRecord; journalRecord?: StoredStringRecord }> {
  const transaction = db.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const [checkpointRecord, journalRecord] = await Promise.all([
    requestResult(store.get(reference.checkpointKey) as IDBRequest<StoredCheckpointRecord | undefined>),
    requestResult(store.get(reference.journalKey) as IDBRequest<StoredStringRecord | undefined>),
  ]);
  await done;
  return { checkpointRecord, journalRecord };
}

async function loadGeneration(
  db: IDBDatabase,
  reference: StoredGenerationReference,
  expectedBase: SimulationRuntimeRecoveryBaseIdentity | undefined,
  materialize: false,
): Promise<LoadedGenerationMetadata | null>;
async function loadGeneration(
  db: IDBDatabase,
  reference: StoredGenerationReference,
  expectedBase?: SimulationRuntimeRecoveryBaseIdentity,
  materialize?: true,
): Promise<LoadedGeneration | null>;
async function loadGeneration(
  db: IDBDatabase,
  reference: StoredGenerationReference,
  expectedBase?: SimulationRuntimeRecoveryBaseIdentity,
  materialize = true,
): Promise<LoadedGeneration | LoadedGenerationMetadata | null> {
  const { checkpointRecord, journalRecord } = await readGenerationRecords(db, reference);
  if (!validCheckpointRecord(checkpointRecord, reference.checkpointKey) || typeof journalRecord?.value !== "string" ||
    journalRecord.key !== reference.journalKey) return null;
  const checkpoint = checkpointRecord.checkpoint;
  if (checkpoint.sessionId !== reference.sessionId ||
    checkpoint.generation !== reference.generation || checkpoint.lastSequence > reference.sequence ||
    checkpoint.stateRevision > reference.stateRevision || !sameBaseIdentity(checkpoint.baseIdentity, reference.baseIdentity) ||
    checkpoint.registryFingerprint !== checkpoint.registry?.fingerprint ||
    checkpointIdentity(checkpoint) !== checkpointIdentityFromReference(reference) ||
    checkpointRecord.absorbedIntent?.intentSha256 !== reference.absorbedIntent?.intentSha256 ||
    checkpointRecord.absorbedIntent?.sequence !== reference.absorbedIntent?.sequence ||
    checkpointRecord.absorbedIntent?.resultRevision !== reference.absorbedIntent?.resultRevision) return null;
  if (expectedBase && !sameBaseIdentity(checkpoint.baseIdentity, expectedBase)) return null;
  if (!await validateCheckpointTransferBytes(checkpoint)) return null;
  if (byteLength(journalRecord.value) !== reference.journalByteLength ||
    await sha256Text(journalRecord.value) !== reference.journalSha256) return null;
  const journalPayload = parseJournal(journalRecord.value, reference);
  if (!journalPayload || journalPayload.revision !== reference.journalRevision) return null;
  if (await validateSimulationRuntimeDurableJournalEntryDigests(journalPayload.entries) !== null) return null;
  const recordForValidation: SimulationRuntimeDurableRecoveryRecord = {
    checkpoint,
    entries: journalPayload.entries,
  };
  if (validateSimulationRuntimeDurableRecoveryRecord(recordForValidation, expectedBase ?? reference.baseIdentity) !== null) return null;
  const stats = getSimulationRuntimeDurableJournalStats(checkpoint, journalPayload.entries);
  if (stats.lastSequence !== reference.sequence || stats.lastStateRevision !== reference.stateRevision) return null;
  const metadata: LoadedGenerationMetadata = {
    reference,
    journalRecord,
    journalPayload,
    proof: proofFromReference(reference),
  };
  if (!materialize) return metadata;
  return {
    ...metadata,
    record: {
      checkpoint: checkpointView(checkpoint),
      entries: structuredClone(journalPayload.entries),
    },
    checkpointRecord,
  };
}

function referencedGenerationKeys(head: StoredRecoveryHead | null, candidate?: PreparedCheckpoint): Set<string> {
  const keys = new Set<string>();
  if (head) {
    keys.add(head.active.checkpointKey);
    keys.add(head.active.journalKey);
    if (head.previous) {
      keys.add(head.previous.checkpointKey);
      keys.add(head.previous.journalKey);
    }
  }
  if (candidate) {
    keys.add(candidate.reference.checkpointKey);
    keys.add(candidate.reference.journalKey);
  }
  return keys;
}

function isGenerationRecordForMode(key: string, mode: SaveMode): boolean {
  return key.startsWith(generationKeyPrefix("checkpoint", mode)) || key.startsWith(generationKeyPrefix("journal", mode));
}

async function stageCheckpoint(
  db: IDBDatabase,
  mode: SaveMode,
  expectedHeadRaw: string | null,
  expectedHead: StoredRecoveryHead | null,
  prepared: PreparedCheckpoint,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<void> {
  const transaction = db.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  try {
    const store = transaction.objectStore(RECORD_STORE);
    const now = Date.now();
    if (!await renewLeaseInStore(store, fence, now)) {
      await done;
      throw new RecoveryStoreError("lease-lost", "写入恢复检查点前 writer lease 已失效");
    }
    const currentHeadRecord = await requestResult(store.get(headKey(mode)) as IDBRequest<StoredStringRecord | undefined>);
    if ((currentHeadRecord?.value ?? null) !== expectedHeadRaw) {
      await done;
      throw new RecoveryStoreError("cas-mismatch", "模拟恢复 head 已被并发更新");
    }
    if (!await durablePrimaryMatchesBase(store, prepared.reference.baseIdentity)) {
      await done;
      throw new RecoveryStoreError("cas-mismatch", "恢复 checkpoint 与当前 checksum-bound primary catalog 不匹配");
    }
    const [existingCheckpoint, existingJournal, keys] = await Promise.all([
      requestResult(store.get(prepared.checkpointRecord.key) as IDBRequest<StoredCheckpointRecord | undefined>),
      requestResult(store.get(prepared.journalRecord.key) as IDBRequest<StoredStringRecord | undefined>),
      requestResult(store.getAllKeys() as IDBRequest<IDBValidKey[]>),
    ]);
    if (existingCheckpoint && !checkpointRecordMatches(existingCheckpoint, prepared.checkpointRecord) ||
      existingJournal && existingJournal.value !== prepared.journalRecord.value) {
      await done;
      throw new RecoveryStoreError("cas-mismatch", "同一恢复 generation 已存在不同内容");
    }
    const protectedKeys = referencedGenerationKeys(expectedHead, prepared);
    for (const key of keys) {
      if (typeof key === "string" && isGenerationRecordForMode(key, mode) && !protectedKeys.has(key)) store.delete(key);
    }
    store.put(prepared.checkpointRecord);
    store.put(prepared.journalRecord);
    const [readCheckpoint, readJournal] = await Promise.all([
      requestResult(store.get(prepared.checkpointRecord.key) as IDBRequest<StoredCheckpointRecord | undefined>),
      requestResult(store.get(prepared.journalRecord.key) as IDBRequest<StoredStringRecord | undefined>),
    ]);
    if (!checkpointRecordMetadataMatches(readCheckpoint, prepared.checkpointRecord) || readJournal?.value !== prepared.journalRecord.value) {
      transaction.abort();
      void done.catch(() => undefined);
      throw new RecoveryStoreError("readback-failed", "恢复检查点事务内回读失败", true);
    }
    await done;
  } catch (error) {
    if (isQuotaError(error)) throw new RecoveryStoreError("quota", "空间不足，恢复检查点未安装；旧检查点保持不变", true);
    throw error;
  }
}

async function verifyPreparedCheckpoint(
  db: IDBDatabase,
  prepared: PreparedCheckpoint,
): Promise<LoadedGeneration> {
  const loaded = await loadGeneration(db, prepared.reference, prepared.reference.baseIdentity);
  if (!loaded || !checkpointRecordMatches(loaded.checkpointRecord, prepared.checkpointRecord) ||
    loaded.journalRecord.value !== prepared.journalRecord.value) {
    throw new RecoveryStoreError("readback-failed", "恢复检查点提交后精确回读失败", true);
  }
  return loaded;
}

async function readRawHead(db: IDBDatabase, mode: SaveMode): Promise<string | null> {
  const record = await readHeadRecord(db, mode);
  return record && typeof (record as { value?: unknown }).value === "string"
    ? (record as { value: string }).value
    : null;
}

async function readHeadRecord(db: IDBDatabase, mode: SaveMode): Promise<unknown> {
  const transaction = db.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const record = await requestResult(transaction.objectStore(RECORD_STORE).get(headKey(mode)) as IDBRequest<unknown>);
  await done;
  return record;
}

async function rollbackPublishedHead(
  db: IDBDatabase,
  mode: SaveMode,
  publishedHeadRaw: string,
  previousHeadRaw: string | null,
  prepared: PreparedCheckpoint,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<void> {
  try {
    const transaction = db.transaction(RECORD_STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(RECORD_STORE);
    if (!await renewLeaseInStore(store, fence, Date.now())) {
      await done;
      return;
    }
    const current = await requestResult(store.get(headKey(mode)) as IDBRequest<StoredStringRecord | undefined>);
    if (current?.value !== publishedHeadRaw) {
      await done;
      return;
    }
    if (previousHeadRaw === null) store.delete(headKey(mode));
    else store.put(storedStringRecord(headKey(mode), previousHeadRaw));
    store.delete(prepared.reference.checkpointKey);
    store.delete(prepared.reference.journalKey);
    await done;
  } catch {
    // The published head still contains a verified previous reference. A later
    // read may recover it if rollback itself loses the writer lease.
  }
}

async function garbageCollectVerifiedPrevious(
  db: IDBDatabase,
  mode: SaveMode,
  expectedHeadRaw: string,
  head: StoredRecoveryHead,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<void> {
  try {
    const transaction = db.transaction(RECORD_STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(RECORD_STORE);
    const now = Date.now();
    if (!await renewLeaseInStore(store, fence, now)) {
      await done;
      return;
    }
    const current = await requestResult(store.get(headKey(mode)) as IDBRequest<StoredStringRecord | undefined>);
    if (current?.value !== expectedHeadRaw) {
      await done;
      return;
    }
    const keys = await requestResult(store.getAllKeys() as IDBRequest<IDBValidKey[]>);
    const nextHead: StoredRecoveryHead = {
      ...head,
      previous: null,
      revision: head.revision + 1,
      writerId: fence.ownerId,
      fencingToken: fence.fencingToken,
      updatedAt: now,
    };
    const activeKeys = new Set([head.active.checkpointKey, head.active.journalKey]);
    for (const key of keys) {
      if (typeof key === "string" && isGenerationRecordForMode(key, mode) && !activeKeys.has(key)) store.delete(key);
    }
    const nextRaw = serializeHead(nextHead);
    store.put(storedStringRecord(headKey(mode), nextRaw, now));
    await done;
    if (await readRawHead(db, mode) !== nextRaw) throw new Error("head GC readback failed");
  } catch {
    // Best effort only. Keeping the previous generation is safer than
    // deleting it without an exact head CAS/readback.
  }
}

async function publishCheckpoint(
  db: IDBDatabase,
  mode: SaveMode,
  expectedHead: HeadSnapshot,
  prepared: PreparedCheckpoint,
  fence: SimulationRuntimeRecoveryWriterFence,
  preservePrevious = true,
  pendingRequirement: "empty" | "any" | StoredPendingIntentRecord = "empty",
): Promise<SimulationRuntimeRecoveryMutationSuccess> {
  const transaction = db.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const now = Date.now();
  if (!await renewLeaseInStore(store, fence, now)) {
    await done;
    throw new RecoveryStoreError("lease-lost", "发布恢复检查点前 writer lease 已失效");
  }
  const [currentHeadRecord, checkpointRecord, journalRecord, pendingRecord] = await Promise.all([
    requestResult(store.get(headKey(mode)) as IDBRequest<StoredStringRecord | undefined>),
    requestResult(store.get(prepared.reference.checkpointKey) as IDBRequest<StoredCheckpointRecord | undefined>),
    requestResult(store.get(prepared.reference.journalKey) as IDBRequest<StoredStringRecord | undefined>),
    requestResult(store.get(pendingIntentKey(mode)) as IDBRequest<StoredPendingIntentRecord | undefined>),
  ]);
  if ((currentHeadRecord?.value ?? null) !== expectedHead.raw) {
    await done;
    throw new RecoveryStoreError("cas-mismatch", "发布恢复检查点时 head CAS 失败");
  }
  if (!await durablePrimaryMatchesBase(store, prepared.reference.baseIdentity)) {
    await done;
    throw new RecoveryStoreError("cas-mismatch", "发布前 primary BaseIdentity 已变化");
  }
  if (!checkpointRecordMetadataMatches(checkpointRecord, prepared.checkpointRecord) || journalRecord?.value !== prepared.journalRecord.value) {
    await done;
    throw new RecoveryStoreError("readback-failed", "发布前 staged generation 不再精确匹配", true);
  }
  if (pendingRequirement === "empty" && pendingRecord !== undefined ||
    pendingRequirement !== "empty" && pendingRequirement !== "any" &&
      !pendingRecordMatches(pendingRecord, pendingRequirement)) {
    await done;
    throw new RecoveryStoreError("pending-intent", "发布恢复 checkpoint 时 pending intent CAS 失败", false);
  }
  const cadenceError = validateSimulationRuntimeDurableCheckpointCadence(
    expectedHead.head?.cadence ?? null,
    prepared.checkpointRecord.checkpoint,
    now,
  );
  if (cadenceError) {
    await done;
    throw new RecoveryStoreError(
      "checkpoint-rate-limited",
      `恢复 transfer checkpoint cadence 拒绝：${cadenceError}`,
      true,
      undefined,
      checkpointCadenceRetryAfterMs(expectedHead.head?.cadence ?? null, prepared.checkpointRecord.checkpoint, now),
    );
  }
  const head: StoredRecoveryHead = {
    schemaVersion: 1,
    recordType: "simulation-runtime-recovery-head",
    mode,
    revision: (expectedHead.head?.revision ?? 0) + 1,
    active: prepared.reference,
    previous: preservePrevious ? expectedHead.head?.active ?? null : null,
    cadence: advanceSimulationRuntimeDurableCheckpointCadence(
      expectedHead.head?.cadence ?? null,
      prepared.checkpointRecord.checkpoint,
      now,
    ),
    writerId: fence.ownerId,
    fencingToken: fence.fencingToken,
    updatedAt: now,
  };
  const publishedRaw = serializeHead(head);
  store.put(storedStringRecord(headKey(mode), publishedRaw, now));
  const readback = await requestResult(store.get(headKey(mode)) as IDBRequest<StoredStringRecord | undefined>);
  if (readback?.value !== publishedRaw) {
    transaction.abort();
    void done.catch(() => undefined);
    throw new RecoveryStoreError("readback-failed", "恢复 head 事务内回读失败", true);
  }
  await done;
  if (await readRawHead(db, mode) !== publishedRaw) {
    await rollbackPublishedHead(db, mode, publishedRaw, expectedHead.raw, prepared, fence);
    throw new RecoveryStoreError("readback-failed", "恢复 head 提交后回读失败", true);
  }
  const active = await loadGeneration(db, head.active, head.active.baseIdentity, false);
  if (!active) {
    await rollbackPublishedHead(db, mode, publishedRaw, expectedHead.raw, prepared, fence);
    throw new RecoveryStoreError("readback-failed", "新恢复 generation 校验失败，已保留旧 generation", true);
  }
  await garbageCollectVerifiedPrevious(db, mode, publishedRaw, head, fence);
  return { ok: true, proof: active.proof, idempotent: false };
}

function generationMatchesPrepared(reference: StoredGenerationReference, prepared: PreparedCheckpoint): boolean {
  return reference.sessionId === prepared.reference.sessionId && reference.generation === prepared.reference.generation &&
    reference.sequence === prepared.reference.sequence && reference.stateRevision === prepared.reference.stateRevision &&
    checkpointIdentityFromReference(reference) === checkpointIdentityFromReference(prepared.reference) &&
    sameBaseIdentity(reference.baseIdentity, prepared.reference.baseIdentity) &&
    reference.absorbedIntent?.sequence === prepared.reference.absorbedIntent?.sequence &&
    reference.absorbedIntent?.intentSha256 === prepared.reference.absorbedIntent?.intentSha256 &&
    reference.absorbedIntent?.resultRevision === prepared.reference.absorbedIntent?.resultRevision;
}

function pendingIntentKey(mode: SaveMode): string {
  return `${PENDING_INTENT_RECORD_PREFIX}${mode}`;
}

/**
 * Persistence-Worker primitive. Do not call this with a large command on the
 * UI thread: canonical JSON, UTF-8 encoding, and both digests are intentionally
 * completed before the fenced IDB stage transaction.
 */
export async function prepareSimulationRuntimeRecoveryIntent(
  intent: SimulationRuntimeDurableOperationIntent,
): Promise<SimulationRuntimeRecoveryPreparedIntent> {
  if (!await validateIntentDigest(intent)) throw new RecoveryStoreError("invalid", "durable intent identity/digest 无效");
  const value = JSON.stringify(intent);
  const originalByteLength = byteLength(value);
  if (originalByteLength > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_STAGED_INTENT_BYTES) {
    throw new RecoveryStoreError("intent-too-large", "durable intent 超过 64 MiB staged 上限");
  }
  const bytes = textEncoder.encode(value);
  const sha256 = await computeSimulationRuntimeDurableBytesSha256(bytes.buffer);
  return originalByteLength <= SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES
    ? {
        schemaVersion: 1,
        intent,
        encoding: "json",
        value,
        storedByteLength: originalByteLength,
        originalByteLength,
        storedSha256: sha256,
        originalSha256: sha256,
      }
    : {
        schemaVersion: 1,
        intent,
        encoding: "raw",
        buffer: bytes.buffer,
        storedByteLength: bytes.byteLength,
        originalByteLength: bytes.byteLength,
        storedSha256: sha256,
        originalSha256: sha256,
      };
}

function pendingRecordFromPrepared(
  mode: SaveMode,
  prepared: SimulationRuntimeRecoveryPreparedIntent,
  fence: SimulationRuntimeRecoveryWriterFence,
  now = Date.now(),
): StoredPendingIntentRecord {
  const intent = prepared.intent;
  return {
    key: pendingIntentKey(mode),
    recordType: "simulation-runtime-recovery-pending-intent",
    schemaVersion: 1,
    mode,
    sessionId: intent.sessionId,
    generation: intent.generation,
    sequence: intent.sequence,
    baseStateRevision: intent.baseStateRevision,
    intentSha256: intent.intentSha256,
    encoding: prepared.encoding,
    ...(prepared.value !== undefined ? { value: prepared.value } : {}),
    ...(prepared.buffer ? { buffer: prepared.buffer } : {}),
    storedByteLength: prepared.storedByteLength,
    originalByteLength: prepared.originalByteLength,
    storedSha256: prepared.storedSha256,
    originalSha256: prepared.originalSha256,
    writerId: fence.ownerId,
    fencingToken: fence.fencingToken,
    updatedAt: now,
  };
}

async function decodePendingIntent(record: StoredPendingIntentRecord): Promise<SimulationRuntimeDurableOperationIntent | null> {
  let value: string;
  if (record.encoding === "json") {
    if (typeof record.value !== "string" || byteLength(record.value) !== record.storedByteLength) return null;
    const bytes = textEncoder.encode(record.value);
    if (await computeSimulationRuntimeDurableBytesSha256(bytes.buffer) !== record.storedSha256) return null;
    value = record.value;
  } else {
    if (!(record.buffer instanceof ArrayBuffer) || record.buffer.byteLength !== record.storedByteLength ||
      await computeSimulationRuntimeDurableBytesSha256(record.buffer) !== record.storedSha256) return null;
    let buffer = record.buffer;
    if (record.encoding === "gzip") {
      if (typeof DecompressionStream === "undefined") return null;
      buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    }
    if (buffer.byteLength !== record.originalByteLength ||
      await computeSimulationRuntimeDurableBytesSha256(buffer) !== record.originalSha256) return null;
    value = new TextDecoder().decode(buffer);
  }
  try {
    const intent = JSON.parse(value) as SimulationRuntimeDurableOperationIntent;
    return intent.sessionId === record.sessionId && intent.generation === record.generation &&
      intent.sequence === record.sequence && intent.baseStateRevision === record.baseStateRevision &&
      intent.intentSha256 === record.intentSha256 && await validateIntentDigest(intent) ? intent : null;
  } catch {
    return null;
  }
}

async function readPendingIntent(db: IDBDatabase, mode: SaveMode): Promise<LoadedPendingIntent | null | undefined> {
  const transaction = db.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const record = await requestResult(transaction.objectStore(RECORD_STORE).get(pendingIntentKey(mode)) as IDBRequest<StoredPendingIntentRecord | undefined>);
  await done;
  if (!record) return undefined;
  if (record.recordType !== "simulation-runtime-recovery-pending-intent" || record.mode !== mode) return null;
  const intent = await decodePendingIntent(record);
  return intent ? { record, intent } : null;
}

async function clearPendingIntentForPublishedCheckpoint(
  db: IDBDatabase,
  mode: SaveMode,
  expectedActive: StoredGenerationReference,
  expectedPending: StoredPendingIntentRecord | "any",
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<void> {
  const snapshot = await readLeaseAndHead(db, mode, fence);
  if (!snapshot.head || JSON.stringify(snapshot.head.active) !== JSON.stringify(expectedActive)) {
    throw new RecoveryStoreError("cas-mismatch", "清理 staged intent 前 active checkpoint 已变化");
  }
  const transaction = db.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const now = Date.now();
  if (!await renewLeaseInStore(store, fence, now)) {
    await done;
    throw new RecoveryStoreError("lease-lost", "清理 staged intent 前 writer lease 已失效");
  }
  const [headRecord, pendingRecord] = await Promise.all([
    requestResult(store.get(headKey(mode)) as IDBRequest<StoredStringRecord | undefined>),
    requestResult(store.get(pendingIntentKey(mode)) as IDBRequest<StoredPendingIntentRecord | undefined>),
  ]);
  if (headRecord?.value !== snapshot.raw) {
    await done;
    throw new RecoveryStoreError("cas-mismatch", "清理 staged intent 时 head CAS 失败");
  }
  if (expectedPending !== "any" && pendingRecord && !pendingRecordMatches(pendingRecord, expectedPending)) {
    await done;
    throw new RecoveryStoreError("operation-conflict", "active checkpoint 与另一 staged intent 冲突");
  }
  if (!pendingRecord) {
    await done;
    return;
  }
  store.delete(pendingIntentKey(mode));
  const readback = await requestResult(store.get(pendingIntentKey(mode)) as IDBRequest<StoredPendingIntentRecord | undefined>);
  if (readback !== undefined) {
    transaction.abort();
    void done.catch(() => undefined);
    throw new RecoveryStoreError("readback-failed", "staged intent 事务内清理回读失败", true);
  }
  await done;
  const verifyTransaction = db.transaction(RECORD_STORE, "readonly");
  const verifyDone = transactionDone(verifyTransaction);
  const committed = await requestResult(
    verifyTransaction.objectStore(RECORD_STORE).get(pendingIntentKey(mode)) as IDBRequest<StoredPendingIntentRecord | undefined>,
  );
  await verifyDone;
  if (committed !== undefined) throw new RecoveryStoreError("readback-failed", "staged intent 提交后清理回读失败", true);
}

function findFinalizedIntent(
  loaded: LoadedGeneration,
  sequence: number,
): { intentSha256: string; resultStateRevision: number } | null {
  for (const entry of loaded.record.entries) {
    if (entry.kind === "atomic" && entry.intent.sequence === sequence) {
      return { intentSha256: entry.intent.intentSha256, resultStateRevision: entry.resultStateRevision };
    }
    if (entry.kind === "passive-segment" && entry.lastSequence === sequence) {
      return { intentSha256: entry.tailIntentSha256, resultStateRevision: entry.nextStateRevision };
    }
  }
  const absorbed = loaded.reference.absorbedIntent;
  return absorbed?.sequence === sequence
    ? { intentSha256: absorbed.intentSha256, resultStateRevision: absorbed.resultRevision }
    : null;
}

function pendingMatchesAbsorbedReference(
  pending: LoadedPendingIntent,
  reference: StoredGenerationReference,
): boolean {
  const absorbed = reference.absorbedIntent;
  return Boolean(absorbed && pending.intent.sessionId === reference.sessionId &&
    pending.intent.generation + 1 === reference.generation && pending.intent.sequence === absorbed.sequence &&
    pending.intent.intentSha256 === absorbed.intentSha256 && reference.sequence === absorbed.sequence &&
    reference.stateRevision === absorbed.resultRevision);
}

function pendingRecordMatches(left: StoredPendingIntentRecord | undefined, right: StoredPendingIntentRecord): boolean {
  if (!left || left.key !== right.key || left.intentSha256 !== right.intentSha256 || left.sequence !== right.sequence ||
    left.sessionId !== right.sessionId || left.generation !== right.generation || left.encoding !== right.encoding ||
    left.storedByteLength !== right.storedByteLength || left.originalByteLength !== right.originalByteLength ||
    left.storedSha256 !== right.storedSha256 || left.originalSha256 !== right.originalSha256) return false;
  if (right.encoding === "json") return left.value === right.value;
  return left.buffer instanceof ArrayBuffer && right.buffer instanceof ArrayBuffer && arrayBuffersEqual(left.buffer, right.buffer);
}

function pendingProof(
  loaded: LoadedGeneration,
  intent: SimulationRuntimeDurableOperationIntent,
  requiresCheckpointBarrier: boolean,
): SimulationRuntimeRecoveryDurableProof {
  return {
    ...loaded.proof,
    sequence: intent.sequence,
    stateRevision: intent.baseStateRevision,
    pending: true,
    finalized: false,
    intentSha256: intent.intentSha256,
    requiresCheckpointBarrier,
  };
}

function clearBackoff(): void {
  backoffUntil = 0;
  backoffReason = null;
}

function validatePublicInputs(
  fence: SimulationRuntimeRecoveryWriterFence,
  baseIdentity?: SimulationRuntimeRecoveryBaseIdentity,
): void {
  if (!validFence(fence)) throw new RecoveryStoreError("invalid", "模拟恢复 writer fence 无效");
  if (baseIdentity && !validBaseIdentity(baseIdentity)) throw new RecoveryStoreError("invalid", "模拟恢复 base identity 无效");
}

function preflightCheckpointCadence(
  head: StoredRecoveryHead | null,
  checkpoint: SimulationRuntimeDurableCheckpoint,
): void {
  const now = Date.now();
  const cadence = head?.cadence ?? null;
  const cadenceError = validateSimulationRuntimeDurableCheckpointCadence(cadence, checkpoint, now);
  if (cadenceError) {
    throw new RecoveryStoreError(
      "checkpoint-rate-limited",
      `恢复 transfer checkpoint cadence 拒绝：${cadenceError}`,
      true,
      undefined,
      checkpointCadenceRetryAfterMs(cadence, checkpoint, now),
    );
  }
}

function checkpointCadenceRetryAfterMs(
  cadence: SimulationRuntimeDurableCheckpointCadence | null,
  checkpoint: SimulationRuntimeDurableCheckpoint,
  now: number,
): number {
  if (checkpoint.source === "primary") return 0;
  const budget = checkpoint.transfer.encoding === "gzip"
    ? SIMULATION_RUNTIME_DURABLE_RECOVERY_GZIP_BYTES_PER_HOUR
    : SIMULATION_RUNTIME_DURABLE_RECOVERY_RAW_BYTES_PER_HOUR;
  const proportionalInterval = Math.ceil(
    SIMULATION_RUNTIME_DURABLE_RECOVERY_TRANSFER_WINDOW_MS * checkpoint.transfer.storedByteLength / budget,
  );
  const minimumInterval = Math.max(SIMULATION_RUNTIME_DURABLE_RECOVERY_MIN_TRANSFER_INTERVAL_MS, proportionalInterval);
  let retryAt = cadence?.lastTransferAtMs ? cadence.lastTransferAtMs + minimumInterval : now;
  const relevantEvents = (cadence?.transferEvents ?? [])
    .filter((event) => event.encoding === checkpoint.transfer.encoding && event.committedAtMs > now -
      SIMULATION_RUNTIME_DURABLE_RECOVERY_TRANSFER_WINDOW_MS)
    .sort((left, right) => left.committedAtMs - right.committedAtMs);
  let bytes = relevantEvents.reduce((total, event) => total + event.bytes, 0) + checkpoint.transfer.storedByteLength;
  for (const event of relevantEvents) {
    if (bytes <= budget) break;
    bytes -= event.bytes;
    retryAt = Math.max(retryAt, event.committedAtMs + SIMULATION_RUNTIME_DURABLE_RECOVERY_TRANSFER_WINDOW_MS + 1);
  }
  return Math.max(1, retryAt - now);
}

/**
 * Load only the binary authoritative checkpoint plus its bounded journal. A
 * mismatched primary identity is an expected cache miss, not permission to
 * parse or replace the current primary save.
 */
export async function readSimulationRuntimeRecovery(
  baseIdentity: SimulationRuntimeRecoveryBaseIdentity,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<SimulationRuntimeRecoveryReadResult> {
  try {
    validatePublicInputs(fence, baseIdentity);
    const db = await openRecoveryDatabase();
    const snapshot = await readLeaseAndRecoverableHead(db, baseIdentity.mode, fence, baseIdentity);
    if (snapshot.quarantined) {
      clearBackoff();
      return { ok: true, recovery: null, proof: null, diagnostic: "corrupt-recovery-quarantined" };
    }
    if (!await durablePrimaryMatchesBaseInDatabase(db, baseIdentity) || !snapshot.head ||
      !sameBaseIdentity(snapshot.head.active.baseIdentity, baseIdentity)) {
      return { ok: true, recovery: null, proof: null };
    }
    let pending = await readPendingIntent(db, baseIdentity.mode);
    if (pending === null) throw new RecoveryStoreError("corrupt", "durable pending intent 校验失败", true);
    const active = await loadGeneration(db, snapshot.head.active, baseIdentity);
    if (active) {
      if (pending && pendingMatchesAbsorbedReference(pending, active.reference)) {
        await clearPendingIntentForPublishedCheckpoint(db, baseIdentity.mode, active.reference, pending.record, fence);
        pending = undefined;
      } else if (pending && (pending.intent.sessionId !== active.reference.sessionId ||
        pending.intent.generation !== active.reference.generation)) {
        // A primary-identity replacement may crash after publishing its new
        // head but before deleting the old session's single pending sidecar.
        await clearPendingIntentForPublishedCheckpoint(db, baseIdentity.mode, active.reference, "any", fence);
        pending = undefined;
      } else if (pending && (pending.intent.sequence !== active.proof.sequence + 1 ||
        pending.intent.baseStateRevision !== active.proof.stateRevision)) {
        throw new RecoveryStoreError("corrupt", "durable pending intent 与 finalized journal tail 不连续", true, active.proof);
      }
      clearBackoff();
      await garbageCollectVerifiedPrevious(db, baseIdentity.mode, snapshot.raw!, snapshot.head, fence);
      return {
        ok: true,
        recovery: recoveryRecordView(active.record, pending?.intent ?? null),
        proof: pending ? pendingProof(active, pending.intent, pending.record.originalByteLength > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES) : active.proof,
      };
    }
    const previous = snapshot.head.previous;
    if (previous && previous.sessionId === snapshot.head.active.sessionId && sameBaseIdentity(previous.baseIdentity, baseIdentity)) {
      const fallback = await loadGeneration(db, previous, baseIdentity);
      if (fallback && (!pending || pending.intent.sessionId === fallback.reference.sessionId &&
        pending.intent.generation === fallback.reference.generation &&
        pending.intent.sequence === fallback.proof.sequence + 1 &&
        pending.intent.baseStateRevision === fallback.proof.stateRevision)) {
        clearBackoff();
        return {
          ok: true,
          recovery: recoveryRecordView(fallback.record, pending?.intent ?? null),
          proof: pending
            ? { ...pendingProof(fallback, pending.intent,
                pending.record.originalByteLength > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES), recoveredFromPrevious: true }
            : { ...fallback.proof, recoveredFromPrevious: true },
        };
      }
    }
    throw new RecoveryStoreError("corrupt", "当前恢复 generation 校验失败且没有可用的同源 previous", true);
  } catch (error) {
    return failureFromError(error);
  }
}

/** Install generation 1 without overwriting an existing, different head. */
export async function initializeSimulationRuntimeRecovery(
  checkpoint: SimulationRuntimeDurableCheckpoint,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<SimulationRuntimeRecoveryMutationResult> {
  const delayed = backoffFailure();
  if (delayed) return delayed;
  try {
    validatePublicInputs(fence, checkpoint.baseIdentity);
    if (checkpoint.generation !== 1) throw new RecoveryStoreError("invalid", "initialize 只接受 generation 1");
    const db = await openRecoveryDatabase();
    const snapshot = await readLeaseAndRecoverableHead(db, checkpoint.baseIdentity.mode, fence, checkpoint.baseIdentity);
    const prepared = await prepareCheckpoint(checkpoint, fence, undefined);
    let replacingStaleBase = false;
    if (snapshot.head) {
      if (generationMatchesPrepared(snapshot.head.active, prepared)) {
        const existing = await loadGeneration(db, snapshot.head.active, checkpoint.baseIdentity);
        if (existing && checkpointMetadataMatches(existing.record.checkpoint, prepared.checkpointRecord.checkpoint)) {
          const pending = await readPendingIntent(db, checkpoint.baseIdentity.mode);
          if (pending === null) throw new RecoveryStoreError("corrupt", "initialize retry发现损坏的 pending intent", true, existing.proof);
          if (pending && pending.intent.sessionId === existing.reference.sessionId &&
            pending.intent.generation === existing.reference.generation) {
            throw new RecoveryStoreError("pending-intent", "initialize retry不能覆盖当前session的 pending intent", false,
              pendingProof(existing, pending.intent,
                pending.record.originalByteLength > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES));
          }
          if (pending) {
            await clearPendingIntentForPublishedCheckpoint(
              db,
              checkpoint.baseIdentity.mode,
              existing.reference,
              "any",
              fence,
            );
          }
          clearBackoff();
          return { ok: true, proof: existing.proof, idempotent: true };
        }
      }
      if (sameBaseIdentity(snapshot.head.active.baseIdentity, checkpoint.baseIdentity)) {
        throw new RecoveryStoreError("cas-mismatch", "同一 BaseIdentity 已有不同恢复 head，initialize 不会误覆盖", false,
          proofFromReference(snapshot.head.active));
      }
      replacingStaleBase = true;
    }
    preflightCheckpointCadence(snapshot.head, checkpoint);
    await stageCheckpoint(db, checkpoint.baseIdentity.mode, snapshot.raw, snapshot.head, prepared, fence);
    await verifyPreparedCheckpoint(db, prepared);
    const result = await publishCheckpoint(
      db,
      checkpoint.baseIdentity.mode,
      snapshot,
      prepared,
      fence,
      !replacingStaleBase,
      "any",
    );
    await clearPendingIntentForPublishedCheckpoint(db, checkpoint.baseIdentity.mode, prepared.reference, "any", fence);
    if (snapshot.quarantined) result.proof.quarantinedCorruptRecovery = true;
    clearBackoff();
    return result;
  } catch (error) {
    return failureFromError(error);
  }
}

/** Persist one intent before posting it to the authoritative simulation Worker. */
export async function stageSimulationRuntimeRecoveryIntent(
  prepared: SimulationRuntimeRecoveryPreparedIntent,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<SimulationRuntimeRecoveryMutationResult> {
  const delayed = backoffFailure();
  if (delayed) return delayed;
  try {
    validatePublicInputs(fence);
    const intent = prepared.intent;
    if (prepared.schemaVersion !== 1 || validateSimulationRuntimeDurableOperationIntent(intent) !== null ||
      prepared.storedByteLength < 1 || prepared.originalByteLength < 1 ||
      prepared.originalByteLength > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_STAGED_INTENT_BYTES) {
      throw new RecoveryStoreError("invalid", "durable intent prepared proof 无效");
    }
    const db = await openRecoveryDatabase();
    const snapshot = await readLeaseAndSessionHead(db, intent.sessionId, intent.generation, fence);
    const loaded = await loadGeneration(db, snapshot.head.active, snapshot.head.active.baseIdentity);
    if (!loaded) throw new RecoveryStoreError("corrupt", "stage intent 前恢复 generation 校验失败", true);
    const alreadyFinalized = findFinalizedIntent(loaded, intent.sequence);
    if (alreadyFinalized) {
      if (alreadyFinalized.intentSha256 !== intent.intentSha256) {
        throw new RecoveryStoreError("operation-conflict", "durable sequence 已finalize为另一 intent", false, loaded.proof);
      }
      return {
        ok: true,
        proof: {
          ...loaded.proof,
          pending: false,
          finalized: true,
          intentSha256: intent.intentSha256,
          resultStateRevision: alreadyFinalized.resultStateRevision,
        },
        idempotent: true,
      };
    }
    if (intent.sequence !== loaded.proof.sequence + 1 || intent.baseStateRevision !== loaded.proof.stateRevision) {
      throw new RecoveryStoreError("cas-mismatch", "durable intent 不是 finalized tail+1", false, loaded.proof);
    }
    const existingPending = await readPendingIntent(db, snapshot.head.mode);
    if (existingPending === null) throw new RecoveryStoreError("corrupt", "已有 pending intent 损坏", true, loaded.proof);
    if (existingPending) {
      if (existingPending.intent.sequence === intent.sequence && existingPending.intent.intentSha256 === intent.intentSha256) {
        return {
          ok: true,
          proof: pendingProof(loaded, existingPending.intent,
            existingPending.record.originalByteLength > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES),
          idempotent: true,
        };
      }
      throw new RecoveryStoreError("operation-conflict", "已有不同 pending intent，必须先恢复或finalize", false,
        pendingProof(loaded, existingPending.intent,
          existingPending.record.originalByteLength > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES));
    }
    const now = Date.now();
    const pendingRecord = pendingRecordFromPrepared(snapshot.head.mode, prepared, fence, now);
    const decodedPrepared = await decodePendingIntent(pendingRecord);
    if (!decodedPrepared || decodedPrepared.intentSha256 !== intent.intentSha256) {
      throw new RecoveryStoreError("invalid", "durable intent prepared payload/readback proof 不匹配");
    }
    let requiresCheckpointBarrier = prepared.originalByteLength > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES;
    if (!requiresCheckpointBarrier) {
      try {
        const entries = await finalizeSimulationRuntimeDurableRecoveryIntent(loaded.record.entries, intent, intent.baseStateRevision);
        requiresCheckpointBarrier = validateSimulationRuntimeDurableRecoveryRecord({ checkpoint: loaded.record.checkpoint, entries },
          loaded.reference.baseIdentity) !== null;
      } catch {
        requiresCheckpointBarrier = true;
      }
    }
    const transaction = db.transaction(RECORD_STORE, "readwrite");
    const done = transactionDone(transaction);
    const objectStore = transaction.objectStore(RECORD_STORE);
    if (!await renewLeaseInStore(objectStore, fence, now)) {
      await done;
      throw new RecoveryStoreError("lease-lost", "stage intent 前 writer lease 已失效", false, loaded.proof);
    }
    const [headRecord, journalRecord, pendingBefore] = await Promise.all([
      requestResult(objectStore.get(headKey(snapshot.head.mode)) as IDBRequest<StoredStringRecord | undefined>),
      requestResult(objectStore.get(loaded.reference.journalKey) as IDBRequest<StoredStringRecord | undefined>),
      requestResult(objectStore.get(pendingIntentKey(snapshot.head.mode)) as IDBRequest<StoredPendingIntentRecord | undefined>),
    ]);
    if (headRecord?.value !== snapshot.raw || journalRecord?.value !== loaded.journalRecord.value || pendingBefore) {
      await done;
      throw new RecoveryStoreError("cas-mismatch", "stage intent CAS 失败", false, loaded.proof);
    }
    if (!await durablePrimaryMatchesBase(objectStore, loaded.reference.baseIdentity)) {
      await done;
      throw new RecoveryStoreError("cas-mismatch", "stage intent 前 primary BaseIdentity 已变化", false, loaded.proof);
    }
    objectStore.put(pendingRecord);
    const readback = await requestResult(objectStore.get(pendingRecord.key) as IDBRequest<StoredPendingIntentRecord | undefined>);
    if (!pendingRecordMatches(readback, pendingRecord)) {
      transaction.abort();
      void done.catch(() => undefined);
      throw new RecoveryStoreError("readback-failed", "pending intent 事务内回读失败", true, loaded.proof);
    }
    await done;
    const committed = await readPendingIntent(db, snapshot.head.mode);
    if (!committed || committed.intent.intentSha256 !== intent.intentSha256) {
      throw new RecoveryStoreError("readback-failed", "pending intent 提交后回读失败", true, loaded.proof);
    }
    clearBackoff();
    return { ok: true, proof: pendingProof(loaded, intent, requiresCheckpointBarrier), idempotent: false };
  } catch (error) {
    return failureFromError(error);
  }
}

/** Merge the already-durable pending intent into the finalized journal. */
export async function finalizeSimulationRuntimeRecoveryIntent(
  sessionId: string,
  generation: number,
  sequence: number,
  intentSha256: string,
  resultStateRevision: number,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<SimulationRuntimeRecoveryMutationResult> {
  const delayed = backoffFailure();
  if (delayed) return delayed;
  try {
    validatePublicInputs(fence);
    const db = await openRecoveryDatabase();
    const snapshot = await readLeaseAndSessionHead(db, sessionId, generation, fence);
    const loaded = await loadGeneration(db, snapshot.head.active, snapshot.head.active.baseIdentity);
    if (!loaded) throw new RecoveryStoreError("corrupt", "finalize 前恢复 generation 校验失败", true);
    const pending = await readPendingIntent(db, snapshot.head.mode);
    if (pending === null) throw new RecoveryStoreError("corrupt", "pending intent 损坏", true, loaded.proof);
    if (!pending) {
      const finalized = findFinalizedIntent(loaded, sequence);
      if (finalized && finalized.intentSha256 === intentSha256 && finalized.resultStateRevision === resultStateRevision) {
        return {
          ok: true,
          proof: { ...loaded.proof, pending: false, finalized: true, intentSha256, resultStateRevision },
          idempotent: true,
        };
      }
      if (finalized) throw new RecoveryStoreError("operation-conflict", "finalized sequence 已绑定不同intent/result", false, loaded.proof);
      throw new RecoveryStoreError("cas-mismatch", "pending intent 不存在，无法finalize", false, loaded.proof);
    }
    const intent = pending.intent;
    if (intent.sessionId !== sessionId || intent.generation !== generation || intent.sequence !== sequence ||
      intent.intentSha256 !== intentSha256) {
      throw new RecoveryStoreError("operation-conflict", "finalize intent identity 与pending不一致", false,
        pendingProof(loaded, intent, pending.record.originalByteLength > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES));
    }
    const entries = await finalizeSimulationRuntimeDurableRecoveryIntent(loaded.record.entries, intent, resultStateRevision);
    const candidateRecord: SimulationRuntimeDurableRecoveryRecord = { checkpoint: loaded.record.checkpoint, entries };
    if (validateSimulationRuntimeDurableRecoveryRecord(candidateRecord, loaded.reference.baseIdentity) !== null) {
      throw new RecoveryStoreError("journal-too-large", "pending intent 必须由post-operation checkpoint吸收", false,
        pendingProof(loaded, intent, true));
    }
    const now = Date.now();
    const journalPayload: StoredJournalPayload = {
      ...loaded.journalPayload,
      revision: loaded.journalPayload.revision + 1,
      entries,
      writerId: fence.ownerId,
      fencingToken: fence.fencingToken,
      updatedAt: now,
    };
    const journalRaw = serializeJournal(journalPayload);
    if (byteLength(journalRaw) > SIMULATION_RUNTIME_DURABLE_RECOVERY_MAX_JOURNAL_BYTES) {
      throw new RecoveryStoreError("journal-too-large", "pending intent finalize超过1MiB journal hard limit", false,
        pendingProof(loaded, intent, true));
    }
    const stats = getSimulationRuntimeDurableJournalStats(loaded.record.checkpoint, entries);
    const nextReference: StoredGenerationReference = {
      ...loaded.reference,
      sequence: stats.lastSequence,
      stateRevision: stats.lastStateRevision,
      journalSha256: await sha256Text(journalRaw),
      journalByteLength: byteLength(journalRaw),
      journalRevision: journalPayload.revision,
    };
    const nextHead: StoredRecoveryHead = {
      ...snapshot.head,
      revision: snapshot.head.revision + 1,
      active: nextReference,
      writerId: fence.ownerId,
      fencingToken: fence.fencingToken,
      updatedAt: now,
    };
    const nextHeadRaw = serializeHead(nextHead);
    const transaction = db.transaction(RECORD_STORE, "readwrite");
    const done = transactionDone(transaction);
    const objectStore = transaction.objectStore(RECORD_STORE);
    if (!await renewLeaseInStore(objectStore, fence, now)) {
      await done;
      throw new RecoveryStoreError("lease-lost", "finalize intent 前 writer lease 已失效", false, loaded.proof);
    }
    const [headBefore, journalBefore, pendingBefore] = await Promise.all([
      requestResult(objectStore.get(headKey(snapshot.head.mode)) as IDBRequest<StoredStringRecord | undefined>),
      requestResult(objectStore.get(loaded.reference.journalKey) as IDBRequest<StoredStringRecord | undefined>),
      requestResult(objectStore.get(pendingIntentKey(snapshot.head.mode)) as IDBRequest<StoredPendingIntentRecord | undefined>),
    ]);
    if (headBefore?.value !== snapshot.raw || journalBefore?.value !== loaded.journalRecord.value ||
      !pendingRecordMatches(pendingBefore, pending.record)) {
      await done;
      throw new RecoveryStoreError("cas-mismatch", "finalize intent CAS 失败", false, loaded.proof);
    }
    objectStore.put(storedStringRecord(loaded.reference.journalKey, journalRaw, now));
    objectStore.put(storedStringRecord(headKey(snapshot.head.mode), nextHeadRaw, now));
    objectStore.delete(pendingIntentKey(snapshot.head.mode));
    const [headReadback, journalReadback, pendingReadback] = await Promise.all([
      requestResult(objectStore.get(headKey(snapshot.head.mode)) as IDBRequest<StoredStringRecord | undefined>),
      requestResult(objectStore.get(loaded.reference.journalKey) as IDBRequest<StoredStringRecord | undefined>),
      requestResult(objectStore.get(pendingIntentKey(snapshot.head.mode)) as IDBRequest<StoredPendingIntentRecord | undefined>),
    ]);
    if (headReadback?.value !== nextHeadRaw || journalReadback?.value !== journalRaw || pendingReadback) {
      transaction.abort();
      void done.catch(() => undefined);
      throw new RecoveryStoreError("readback-failed", "finalize intent 事务内回读失败", true, loaded.proof);
    }
    await done;
    const verified = await loadGeneration(db, nextReference, nextReference.baseIdentity, false);
    if (await readRawHead(db, snapshot.head.mode) !== nextHeadRaw || !verified || await readPendingIntent(db, snapshot.head.mode) !== undefined) {
      throw new RecoveryStoreError("readback-failed", "finalize intent 提交后回读失败", true, loaded.proof);
    }
    clearBackoff();
    return {
      ok: true,
      proof: { ...verified.proof, pending: false, finalized: true, intentSha256, resultStateRevision },
      idempotent: false,
    };
  } catch (error) {
    return failureFromError(error);
  }
}

/**
 * Roll to the next exact checkpoint. `absorbedIntent` is legal only for the
 * already-staged durable tail+1 operation. Without it, sequence/revision must
 * equal the finalized journal tail and there must be no pending intent.
 */
export async function commitSimulationRuntimeRecoveryCheckpoint(
  nextCheckpoint: SimulationRuntimeDurableCheckpoint,
  expectedGeneration: number,
  fence: SimulationRuntimeRecoveryWriterFence,
  absorbedIntent?: SimulationRuntimeRecoveryAbsorbedIntent,
): Promise<SimulationRuntimeRecoveryMutationResult> {
  const delayed = backoffFailure();
  if (delayed) return delayed;
  try {
    validatePublicInputs(fence, nextCheckpoint.baseIdentity);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1 ||
      nextCheckpoint.generation !== expectedGeneration + 1) {
      throw new RecoveryStoreError("invalid", "下一恢复 generation 必须精确递增 1");
    }
    const db = await openRecoveryDatabase();
    const snapshot = await readLeaseAndRecoverableHead(db, nextCheckpoint.baseIdentity.mode, fence, nextCheckpoint.baseIdentity);
    if (!snapshot.head) throw new RecoveryStoreError(
      "cas-mismatch",
      snapshot.quarantined ? "损坏 recovery 已隔离且主存档未改动；请从primary重新初始化恢复会话" : "滚动恢复 checkpoint 时 head 不存在",
    );
    const prepared = await prepareCheckpoint(nextCheckpoint, fence, absorbedIntent);

    // A transaction may have committed before the Worker received its result.
    // Re-validate the active generation and return the same proof instead of
    // replaying an absorbed command.
    if (snapshot.head.active.generation === expectedGeneration + 1) {
      if (snapshot.head.active.sessionId === nextCheckpoint.sessionId && generationMatchesPrepared(snapshot.head.active, prepared)) {
        const existing = await loadGeneration(db, snapshot.head.active, nextCheckpoint.baseIdentity);
        if (existing && checkpointMetadataMatches(existing.record.checkpoint, prepared.checkpointRecord.checkpoint)) {
          const staged = await readPendingIntent(db, nextCheckpoint.baseIdentity.mode);
          if (staged === null) throw new RecoveryStoreError("corrupt", "已发布 checkpoint 的 staged intent 损坏", true, existing.proof);
          if (absorbedIntent) {
            if (snapshot.head.active.absorbedIntent?.sequence !== absorbedIntent.intent.sequence ||
              snapshot.head.active.absorbedIntent.intentSha256 !== absorbedIntent.intent.intentSha256 ||
              snapshot.head.active.absorbedIntent.resultRevision !== absorbedIntent.resultStateRevision) {
              throw new RecoveryStoreError("operation-conflict", "已发布 checkpoint 的 absorbed intent proof 冲突", false,
                existing.proof);
            }
            if (staged) {
              if (staged.intent.sessionId !== absorbedIntent.intent.sessionId ||
                staged.intent.generation !== absorbedIntent.intent.generation ||
                staged.intent.sequence !== absorbedIntent.intent.sequence ||
                staged.intent.intentSha256 !== absorbedIntent.intent.intentSha256) {
                throw new RecoveryStoreError("operation-conflict", "已发布 checkpoint 后存在另一 staged intent", false,
                  existing.proof);
              }
              await clearPendingIntentForPublishedCheckpoint(
                db,
                nextCheckpoint.baseIdentity.mode,
                prepared.reference,
                staged.record,
                fence,
              );
            }
          } else if (staged) {
            throw new RecoveryStoreError("pending-intent", "checkpoint 已发布但仍有 staged intent", false,
              pendingProof(existing, staged.intent, true));
          }
          clearBackoff();
          return {
            ok: true,
            proof: {
              ...existing.proof,
              ...(absorbedIntent ? {
                intentSha256: absorbedIntent.intent.intentSha256,
                resultStateRevision: absorbedIntent.resultStateRevision,
                pending: false,
                finalized: true,
              } : {}),
            },
            idempotent: true,
          };
        }
      }
      if (absorbedIntent && snapshot.head.active.absorbedIntent?.sequence === absorbedIntent.intent.sequence &&
        snapshot.head.active.absorbedIntent.intentSha256 !== absorbedIntent.intent.intentSha256) {
        throw new RecoveryStoreError("operation-conflict", "absorbed sequence 已绑定另一 intent，必须重新同步", false,
          proofFromReference(snapshot.head.active));
      }
      throw new RecoveryStoreError("cas-mismatch", "恢复 checkpoint 已滚动到不同 generation 内容", false,
        proofFromReference(snapshot.head.active));
    }
    if (snapshot.head.active.generation !== expectedGeneration || snapshot.head.active.sessionId !== nextCheckpoint.sessionId) {
      throw new RecoveryStoreError("cas-mismatch", "滚动恢复 checkpoint 的 session/generation 已变化", false,
        proofFromReference(snapshot.head.active));
    }
    const loaded = await loadGeneration(db, snapshot.head.active, snapshot.head.active.baseIdentity);
    if (!loaded) throw new RecoveryStoreError("corrupt", "滚动前当前恢复 generation 校验失败", true);
    if (nextCheckpoint.baseIdentity.mode !== loaded.reference.baseIdentity.mode) {
      throw new RecoveryStoreError("invalid", "恢复 checkpoint 不能跨 mode 滚动");
    }
    const pending = await readPendingIntent(db, nextCheckpoint.baseIdentity.mode);
    if (pending === null) throw new RecoveryStoreError("corrupt", "checkpoint rollover 前 pending intent 损坏", true, loaded.proof);
    if (absorbedIntent) {
      const intent = absorbedIntent.intent;
      if (!pending || intent.sessionId !== loaded.reference.sessionId || intent.generation !== expectedGeneration ||
        intent.sequence !== loaded.proof.sequence + 1 || intent.baseStateRevision !== loaded.proof.stateRevision ||
        pending.intent.intentSha256 !== intent.intentSha256 || pending.intent.sequence !== intent.sequence ||
        !await validateIntentDigest(intent) || !Number.isSafeInteger(absorbedIntent.resultStateRevision) ||
        absorbedIntent.resultStateRevision < intent.baseStateRevision ||
        nextCheckpoint.lastSequence !== intent.sequence || nextCheckpoint.stateRevision !== absorbedIntent.resultStateRevision) {
        throw new RecoveryStoreError("cas-mismatch", "absorbed intent 不是当前已stage的 durable tail+1", false,
          pending ? pendingProof(loaded, pending.intent, true) : loaded.proof);
      }
    } else if (pending) {
      throw new RecoveryStoreError("pending-intent", "存在未finalize intent，checkpoint rollover 必须等待或显式吸收", false,
        pendingProof(loaded, pending.intent, true));
    } else if (nextCheckpoint.lastSequence !== loaded.proof.sequence || nextCheckpoint.stateRevision !== loaded.proof.stateRevision) {
      throw new RecoveryStoreError("cas-mismatch", "checkpoint 不能跳过 durable journal sequence/revision", false, loaded.proof);
    }
    preflightCheckpointCadence(snapshot.head, nextCheckpoint);
    await stageCheckpoint(db, nextCheckpoint.baseIdentity.mode, snapshot.raw, snapshot.head, prepared, fence);
    await verifyPreparedCheckpoint(db, prepared);
    const result = await publishCheckpoint(
      db,
      nextCheckpoint.baseIdentity.mode,
      snapshot,
      prepared,
      fence,
      true,
      absorbedIntent ? pending!.record : "empty",
    );
    if (absorbedIntent) {
      await clearPendingIntentForPublishedCheckpoint(
        db,
        nextCheckpoint.baseIdentity.mode,
        prepared.reference,
        pending!.record,
        fence,
      );
      result.proof.intentSha256 = absorbedIntent.intent.intentSha256;
      result.proof.resultStateRevision = absorbedIntent.resultStateRevision;
      result.proof.pending = false;
      result.proof.finalized = true;
    }
    clearBackoff();
    return result;
  } catch (error) {
    return failureFromError(error);
  }
}

/** Small primary-backed rollover: no authoritative binary is copied or parsed. */
export async function rebaseSimulationRuntimeRecoveryToPrimary(
  nextCheckpoint: SimulationRuntimeDurablePrimaryCheckpoint,
  expectedGeneration: number,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<SimulationRuntimeRecoveryMutationResult> {
  return commitSimulationRuntimeRecoveryCheckpoint(nextCheckpoint, expectedGeneration, fence);
}

/** Clear only the exact current base identity or session after primary save verification. */
export async function clearSimulationRuntimeRecovery(
  target: SimulationRuntimeRecoveryClearTarget,
  fence: SimulationRuntimeRecoveryWriterFence,
): Promise<SimulationRuntimeRecoveryClearResult> {
  try {
    validatePublicInputs(fence, "sessionId" in target ? undefined : target);
    if ("sessionId" in target && !SESSION_ID_PATTERN.test(target.sessionId)) {
      throw new RecoveryStoreError("invalid", "clear session identity 无效");
    }
    const db = await openRecoveryDatabase();
    const snapshot = await readLeaseAndRecoverableHead(
      db,
      target.mode,
      fence,
      "sessionId" in target ? undefined : target,
    );
    if (!snapshot.head) {
      const transaction = db.transaction(RECORD_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(RECORD_STORE);
      if (!await renewLeaseInStore(store, fence, Date.now())) {
        await done;
        throw new RecoveryStoreError("lease-lost", "清理 orphan recovery 前 writer lease 已失效");
      }
      const [headRecord, pendingRecord, keys] = await Promise.all([
        requestResult(store.get(headKey(target.mode)) as IDBRequest<StoredStringRecord | undefined>),
        requestResult(store.get(pendingIntentKey(target.mode)) as IDBRequest<StoredPendingIntentRecord | undefined>),
        requestResult(store.getAllKeys() as IDBRequest<IDBValidKey[]>),
      ]);
      if (headRecord !== undefined) {
        await done;
        throw new RecoveryStoreError("cas-mismatch", "清理 orphan recovery 时 head 已出现");
      }
      let cleared = pendingRecord !== undefined;
      store.delete(pendingIntentKey(target.mode));
      for (const key of keys) {
        if (typeof key === "string" && isGenerationRecordForMode(key, target.mode)) {
          store.delete(key);
          cleared = true;
        }
      }
      const [headReadback, pendingReadback] = await Promise.all([
        requestResult(store.get(headKey(target.mode)) as IDBRequest<StoredStringRecord | undefined>),
        requestResult(store.get(pendingIntentKey(target.mode)) as IDBRequest<StoredPendingIntentRecord | undefined>),
      ]);
      if (headReadback !== undefined || pendingReadback !== undefined) {
        transaction.abort();
        void done.catch(() => undefined);
        throw new RecoveryStoreError("readback-failed", "orphan recovery 清理事务内回读失败", true);
      }
      await done;
      clearBackoff();
      return {
        ok: true,
        cleared: cleared || snapshot.quarantined,
        proof: null,
        ...(snapshot.quarantined ? { diagnostic: "corrupt-recovery-quarantined" as const } : {}),
      };
    }
    const matches = "sessionId" in target
      ? snapshot.head.active.sessionId === target.sessionId
      : sameBaseIdentity(snapshot.head.active.baseIdentity, target);
    if (!matches) throw new RecoveryStoreError("cas-mismatch", "clear target 与当前恢复 head 不匹配", false,
      proofFromReference(snapshot.head.active));
    const previousProof = proofFromReference(snapshot.head.active);
    const transaction = db.transaction(RECORD_STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(RECORD_STORE);
    if (!await renewLeaseInStore(store, fence, Date.now())) {
      await done;
      throw new RecoveryStoreError("lease-lost", "清理恢复记录前 writer lease 已失效", false, previousProof);
    }
    const currentHead = await requestResult(store.get(headKey(target.mode)) as IDBRequest<StoredStringRecord | undefined>);
    if (currentHead?.value !== snapshot.raw) {
      await done;
      throw new RecoveryStoreError("cas-mismatch", "清理恢复记录时 head 已变化", false, previousProof);
    }
    const keys = await requestResult(store.getAllKeys() as IDBRequest<IDBValidKey[]>);
    for (const key of keys) {
      if (typeof key === "string" && isGenerationRecordForMode(key, target.mode)) store.delete(key);
    }
    store.delete(pendingIntentKey(target.mode));
    store.delete(headKey(target.mode));
    const [readback, pendingReadback] = await Promise.all([
      requestResult(store.get(headKey(target.mode)) as IDBRequest<StoredStringRecord | undefined>),
      requestResult(store.get(pendingIntentKey(target.mode)) as IDBRequest<StoredPendingIntentRecord | undefined>),
    ]);
    if (readback !== undefined || pendingReadback !== undefined) {
      transaction.abort();
      void done.catch(() => undefined);
      throw new RecoveryStoreError("readback-failed", "恢复 clear 事务内回读失败", true, previousProof);
    }
    await done;
    if (await readRawHead(db, target.mode) !== null || await readPendingIntent(db, target.mode) !== undefined) {
      throw new RecoveryStoreError("readback-failed", "恢复 clear 提交后回读失败", true, previousProof);
    }
    clearBackoff();
    return { ok: true, cleared: true, proof: previousProof };
  } catch (error) {
    return failureFromError(error);
  }
}
