import {
  LOCAL_SAVE_BROADCAST_CHANNEL,
  LOCAL_SAVE_CONFLICT_KEY_PREFIX,
  LOCAL_SAVE_COORDINATION_PREFIX,
  LOCAL_SAVE_HEARTBEAT_INTERVAL_MS,
  LOCAL_SAVE_LEASE_DURATION_MS,
  LOCAL_SAVE_REVISION_KEY_PREFIX,
  LOCAL_SAVE_STORAGE_EVENT_KEY,
  LOCAL_SAVE_WRITER_LEASE_KEY,
  LOCAL_SAVE_WRITER_LOCK,
  LOCAL_SAVE_WRITER_CONTINUATION_KEY,
  LOCAL_SAVE_WRITER_SESSION_KEY,
  LocalSaveConflictError,
  LocalSaveReadOnlyError,
  canApplyLocalSaveEmergencyMirror,
  canClaimLocalSaveWriterLease,
  createLocalSaveConflictId,
  createLocalSaveRevision,
  createLocalSaveWriterId,
  createLocalSaveWriterLease,
  inspectLocalSaveIdentity,
  localSaveEmergencyMirrorKeys,
  localSaveConflictKeys,
  localSaveConflictMetadataKey,
  localSaveRevisionKey,
  parseLocalSaveConflictRecord,
  parseLocalSaveEmergencyMirrorMetadata,
  parseLocalSaveRevision,
  parseLocalSaveWriterLease,
  renewOwnedLocalSaveWriterLease,
  type LocalSaveBroadcastMessage,
  type LocalSaveConflictRecord,
  type LocalSaveRevision,
  type LocalSaveWriterLease,
  type LocalSaveWriterStatus,
} from "./localSaveCoordination";
import { inspectSaveEnvelopeChecksum } from "./saveEnvelopeIntegrity";
import {
  LOCAL_SAVE_CATALOG_RECORD_PREFIX,
  localSaveCatalogRecordKey,
  parseLocalSaveCatalog,
  payloadKeyFromLocalSaveCatalogRecord,
  serializeLocalSaveCatalog,
  type LocalSaveCatalog,
} from "./localSaveCatalog";
import { computeSavePayloadTextChecksum } from "./payloadTextChecksum";

const DATABASE_NAME = "dsp-idle-network.local-saves";
const DATABASE_VERSION = 2;
const RECORD_STORE = "records";
const SAVE_KEY = "dsp-idle-network.save.v1";
const SLOT_KEY_PREFIX = "dsp-idle-network.slot.";
const IMPORT_CACHE_KEY_PREFIX = `${SAVE_KEY}.import-cache.`;
export const LOCAL_AUTOMATIC_SNAPSHOT_LIMIT = 2;
const MANAGED_SNAPSHOT_WARNING_COUNT = 8;
const MANAGED_SNAPSHOT_WARNING_BYTES = 64 * 1024 * 1024;

export type LocalSaveMode = "normal" | "speedrun";
export type LocalSaveStorageCategory =
  | "primary"
  | "backup"
  | "slot"
  | "automatic-snapshot"
  | "manual-snapshot"
  | "protected"
  | "import-cache";
export type LocalSavePersistenceStatus = "granted" | "not-granted" | "denied" | "unsupported";
export type LocalSaveStoragePressure = "normal" | "high" | "critical" | "unknown";

interface StoredSaveSummary {
  schemaVersion: 1;
  mode: LocalSaveMode;
  category: LocalSaveStorageCategory;
  savedAt: number;
  slot: "main" | 1 | 2 | 3 | null;
  reason: string | null;
  automatic: boolean;
  protected: boolean;
  checksum: string | null;
}

interface StoredSaveRecord {
  key: string;
  value: string;
  updatedAt: number;
  bytes: number;
  summary?: StoredSaveSummary;
}

export type LocalSaveBackend = "indexeddb" | "local-storage" | "memory";

export interface LocalSaveStorageEntry {
  key: string;
  label: string;
  bytes: number;
  updatedAt: number;
  savedAt: number;
  mode: LocalSaveMode;
  category: LocalSaveStorageCategory;
  slot: "main" | 1 | 2 | 3 | null;
  source: string;
  reason: string | null;
  automatic: boolean;
  protected: boolean;
}

export interface LocalSaveModeStorageUsage {
  mode: LocalSaveMode;
  totalBytes: number;
  primaryBytes: number;
  backupBytes: number;
  slotBytes: number;
  automaticSnapshotBytes: number;
  manualSnapshotBytes: number;
  protectedBytes: number;
  importCacheBytes: number;
  slotCount: number;
  automaticSnapshotCount: number;
  manualSnapshotCount: number;
  protectedCount: number;
  importCacheCount: number;
}

export interface LocalSaveRecoveryPrompt {
  mode: LocalSaveMode;
  key: string;
  occurredAt: number;
  preservedChecksummedMain: boolean;
  message: string;
}

export interface LocalSaveStorageEstimate {
  backend: LocalSaveBackend;
  payloadBytes: number;
  browserUsageBytes: number | null;
  browserQuotaBytes: number | null;
  persistenceStatus: LocalSavePersistenceStatus;
  persistenceRequestSupported: boolean;
  pressure: LocalSaveStoragePressure;
  modes: LocalSaveModeStorageUsage[];
  warnings: string[];
  recoveryPrompt: LocalSaveRecoveryPrompt | null;
  entries: LocalSaveStorageEntry[];
}

export interface LocalSaveConflictSummary {
  conflictId: string;
  saveKey: string;
  createdAt: number;
  candidate: { available: boolean; deleted: boolean; savedAt: number; checksum: string | null };
  persisted: { available: boolean; missing: boolean; savedAt: number; checksum: string | null };
}

export type LocalSaveConflictResolutionFailureCode =
  | "storage-unavailable"
  | "active-writer"
  | "conflict-missing"
  | "candidate-missing"
  | "persisted-missing"
  | "base-changed"
  | "candidate-invalid"
  | "lease-lost"
  | "verification-failed"
  | "storage-error";

export type LocalSaveConflictResolutionResult =
  | {
      ok: true;
      resolution: "candidate" | "persisted";
      elapsedMs: number;
      savedAt: number;
      checksum: string | null;
    }
  | {
      ok: false;
      code: LocalSaveConflictResolutionFailureCode;
      message: string;
      retryable: boolean;
      elapsedMs: number;
      leaseExpiresAt?: number;
    };

class LocalSaveConflictResolutionError extends Error {
  constructor(
    readonly code: LocalSaveConflictResolutionFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly leaseExpiresAt?: number,
  ) {
    super(message);
    this.name = "LocalSaveConflictResolutionError";
  }
}

const cache = new Map<string, string>();
const knownSaveKeys = new Set<string>();
const catalogCache = new Map<string, LocalSaveCatalog>();
const revisionCache = new Map<string, number>();
const storageEntryCache = new Map<string, LocalSaveStorageEntry & { checksum: string | null }>();
let backend: LocalSaveBackend = "memory";
let database: IDBDatabase | null = null;
let initialization: Promise<void> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let pendingWriteError: unknown = null;
let startupConflictId: string | null = null;
let startupConflictCreatedAt = -1;
const LOCAL_SAVE_WRITER_CONTINUATION_MAX_AGE_MS = 120_000;

function validLocalSaveWriterId(value: string | null): value is string {
  return Boolean(value?.startsWith("tab_") && value.length <= 200);
}

function consumeSameTabWriterContinuation(existing: string | null, now = Date.now()): boolean {
  if (!validLocalSaveWriterId(existing)) return false;
  try {
    const raw = window.sessionStorage.getItem(LOCAL_SAVE_WRITER_CONTINUATION_KEY);
    window.sessionStorage.removeItem(LOCAL_SAVE_WRITER_CONTINUATION_KEY);
    if (!raw) return false;
    const marker = JSON.parse(raw) as { writerId?: unknown; createdAt?: unknown };
    return marker.writerId === existing && typeof marker.createdAt === "number" && Number.isFinite(marker.createdAt) &&
      marker.createdAt <= now && now - marker.createdAt <= LOCAL_SAVE_WRITER_CONTINUATION_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function resolveLocalSaveWriterId(): string {
  if (typeof window === "undefined") return createLocalSaveWriterId();
  try {
    const navigationType = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
    const existing = window.sessionStorage.getItem(LOCAL_SAVE_WRITER_SESSION_KEY);
    const continuedByPreviousDocument = consumeSameTabWriterContinuation(existing);
    if (validLocalSaveWriterId(existing) && (navigationType === "reload" || navigationType === "back_forward" || continuedByPreviousDocument)) return existing;
    const created = createLocalSaveWriterId();
    window.sessionStorage.setItem(LOCAL_SAVE_WRITER_SESSION_KEY, created);
    return created;
  } catch {
    return createLocalSaveWriterId();
  }
}

const writerId = resolveLocalSaveWriterId();
let writerStatus: LocalSaveWriterStatus = {
  role: "initializing",
  writerId,
  fencingToken: 0,
  leaseExpiresAt: 0,
  reason: "正在确认本地存档主标签页",
};
let writerHeartbeat: number | null = null;
let broadcastChannel: BroadcastChannel | null = null;
const writerStatusListeners = new Set<(status: LocalSaveWriterStatus) => void>();
const saveChangeListeners = new Set<(message: LocalSaveBroadcastMessage) => void>();
const storageStatusListeners = new Set<() => void>();
let recoveryPrompt: LocalSaveRecoveryPrompt | null = null;
let lastPersistenceStatus: LocalSavePersistenceStatus | null = null;
let legacyCatalogIndexQueue: string[] = [];
let legacyCatalogIndexScheduled = false;
const RAW_CACHE_LIMIT = 2;
let synchronousFallbackInitialized = false;

function markSameTabWriterContinuation(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(LOCAL_SAVE_WRITER_CONTINUATION_KEY, JSON.stringify({ writerId, createdAt: Date.now() }));
  } catch {
    // A reload still falls back to PerformanceNavigationTiming when session
    // storage is unavailable.
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", markSameTabWriterContinuation);
  window.addEventListener("pagehide", (event) => {
    if (!(event as PageTransitionEvent).persisted) markSameTabWriterContinuation();
  });
  window.addEventListener("pageshow", (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    try { window.sessionStorage.removeItem(LOCAL_SAVE_WRITER_CONTINUATION_KEY); } catch { /* optional continuity marker */ }
  });
}

function ensureSynchronousFallback(): void {
  if (initialization || backend !== "memory" || typeof window === "undefined") return;
  initializeFallback();
}

function isSaveKey(key: string): boolean {
  return key === SAVE_KEY || key === `${SAVE_KEY}.backup` || key === `${SAVE_KEY}.backup.speedrun` ||
    key.startsWith(`${SAVE_KEY}.migration-backup.`) ||
    key.startsWith(`${SAVE_KEY}.normal`) || key.startsWith(`${SAVE_KEY}.speedrun`) ||
    key.startsWith(`${SAVE_KEY}.snapshot.`) || key.startsWith(IMPORT_CACHE_KEY_PREFIX) ||
    key.startsWith(LOCAL_SAVE_CONFLICT_KEY_PREFIX) || key.startsWith(SLOT_KEY_PREFIX);
}

function isCatalogedSaveKey(key: string): boolean {
  return isSaveKey(key) && !key.endsWith(".snapshot.sequence") && !key.endsWith(".snapshot.speedrun.sequence");
}

function byteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return value.length;
  }
}

function savedAt(value: string): number {
  return inspectLocalSaveIdentity(value).savedAt;
}

function inspectedEnvelopeMode(inspection: ReturnType<typeof inspectSaveEnvelopeChecksum>): LocalSaveMode | null {
  const envelopeMode = inspection.parsed?.mode;
  const stateMode = inspection.state?.mode;
  if (envelopeMode !== undefined && envelopeMode !== "normal" && envelopeMode !== "speedrun") return null;
  if (stateMode !== undefined && stateMode !== "normal" && stateMode !== "speedrun") return null;
  if (envelopeMode && stateMode && envelopeMode !== stateMode) return null;
  return (envelopeMode ?? stateMode ?? "normal") as LocalSaveMode;
}

function modeFromKey(key: string, valuePrefix = ""): LocalSaveMode {
  if (key === `${SAVE_KEY}.speedrun` || key === `${SAVE_KEY}.backup.speedrun` ||
    key.startsWith(`${SAVE_KEY}.speedrun.`) || key.startsWith(`${SAVE_KEY}.snapshot.speedrun.`) ||
    key.startsWith(`${SLOT_KEY_PREFIX}speedrun.`) || key.startsWith(`${IMPORT_CACHE_KEY_PREFIX}speedrun.`)) return "speedrun";
  // Save keys own mode isolation. Only conflict copies lack a mode namespace,
  // so their already-preserved payload header is used for display grouping.
  return key.startsWith(LOCAL_SAVE_CONFLICT_KEY_PREFIX) && /"mode"\s*:\s*"speedrun"/.test(valuePrefix) ? "speedrun" : "normal";
}

function snapshotReasonFromPrefix(valuePrefix: string): string | null {
  const match = /"reason"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(valuePrefix);
  if (!match) return null;
  try {
    const decoded = JSON.parse(match[1]) as unknown;
    return typeof decoded === "string" && decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function isProtectedSnapshotReason(reason: string | null): boolean {
  if (!reason) return false;
  return /(?:前|迁移|恢复|回滚|救援|扩容|云存档|外部存档|新工厂|槽位)/u.test(reason) && reason !== "手动快照";
}

function slotFromKey(key: string): "main" | 1 | 2 | 3 | null {
  if (key === SAVE_KEY || key.startsWith(`${SAVE_KEY}.normal`) || key.startsWith(`${SAVE_KEY}.speedrun`)) return "main";
  const slotMatch = /^dsp-idle-network\.slot\.(?:speedrun\.)?([123])$/.exec(key);
  return slotMatch ? Number(slotMatch[1]) as 1 | 2 | 3 : null;
}

function classifySaveRecord(key: string, value: string): StoredSaveSummary {
  const prefix = value.slice(0, Math.min(value.length, 4_096));
  const mode = modeFromKey(key, prefix);
  const snapshot = key.includes(".snapshot.");
  const reason = snapshot ? snapshotReasonFromPrefix(prefix) : null;
  const recognizableSnapshot = /"kind"\s*:\s*"snapshot"/.test(prefix);
  const automatic = snapshot && reason === "自动快照";
  const protectedSnapshot = snapshot && !automatic && (reason === null || !recognizableSnapshot || isProtectedSnapshotReason(reason));
  let category: LocalSaveStorageCategory;
  if (key.startsWith(IMPORT_CACHE_KEY_PREFIX)) category = "import-cache";
  else if (key.startsWith(`${SAVE_KEY}.migration-backup.`) || key.startsWith(LOCAL_SAVE_CONFLICT_KEY_PREFIX) || protectedSnapshot) category = "protected";
  else if (key === `${SAVE_KEY}.backup` || key === `${SAVE_KEY}.backup.speedrun`) category = "backup";
  else if (key.startsWith(SLOT_KEY_PREFIX)) category = "slot";
  else if (key.includes(".snapshot.")) category = automatic ? "automatic-snapshot" : "manual-snapshot";
  else category = "primary";
  const identity = inspectLocalSaveIdentity(value);
  return {
    schemaVersion: 1,
    mode,
    category,
    savedAt: identity.savedAt,
    slot: slotFromKey(key),
    reason,
    automatic,
    protected: category === "protected",
    checksum: identity.checksum,
  };
}

function validStoredSummary(value: unknown): value is StoredSaveSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredSaveSummary>;
  return candidate.schemaVersion === 1 && (candidate.mode === "normal" || candidate.mode === "speedrun") &&
    ["primary", "backup", "slot", "automatic-snapshot", "manual-snapshot", "protected", "import-cache"].includes(candidate.category ?? "") &&
    typeof candidate.savedAt === "number" && Number.isFinite(candidate.savedAt) &&
    (candidate.slot === null || candidate.slot === "main" || candidate.slot === 1 || candidate.slot === 2 || candidate.slot === 3) &&
    (candidate.reason === null || typeof candidate.reason === "string") && typeof candidate.automatic === "boolean" &&
    typeof candidate.protected === "boolean" && (candidate.checksum === null || typeof candidate.checksum === "string");
}

function entrySource(summary: StoredSaveSummary): string {
  if (summary.category === "primary") return "主存档";
  if (summary.category === "backup") return "上一版本备份";
  if (summary.category === "slot") return `手动槽位 ${summary.slot ?? "--"}`;
  if (summary.category === "automatic-snapshot") return "自动快照";
  if (summary.category === "manual-snapshot") return "手动快照";
  if (summary.category === "import-cache") return "导入缓存";
  return "保护副本";
}

function updateStorageEntry(record: StoredSaveRecord): void {
  if (!isSaveKey(record.key) || record.key.endsWith(".snapshot.sequence") || record.key.endsWith(".snapshot.speedrun.sequence")) return;
  const identity = inspectLocalSaveIdentity(record.value);
  const derived = classifySaveRecord(record.key, record.value);
  const summary = validStoredSummary(record.summary) && record.summary.savedAt === identity.savedAt && record.summary.checksum === identity.checksum &&
    record.summary.mode === derived.mode && record.summary.category === derived.category && record.summary.slot === derived.slot &&
    record.summary.reason === derived.reason && record.summary.automatic === derived.automatic && record.summary.protected === derived.protected
    ? record.summary
    : derived;
  storageEntryCache.set(record.key, {
    key: record.key,
    label: entryLabel(record.key, summary),
    bytes: Number.isFinite(record.bytes) && record.bytes >= 0 ? record.bytes : byteLength(record.value),
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : summary.savedAt,
    savedAt: summary.savedAt,
    mode: summary.mode,
    category: summary.category,
    slot: summary.slot,
    source: entrySource(summary),
    reason: summary.reason,
    automatic: summary.automatic,
    protected: summary.protected,
    checksum: summary.checksum,
  });
}

function updateStorageEntryFromCatalog(catalog: LocalSaveCatalog, updatedAt = catalog.savedAt): void {
  const classified = classifySaveRecord(catalog.key, JSON.stringify({
    kind: catalog.kind === "snapshot" ? "snapshot" : catalog.kind === "slot" ? "slot" : "primary",
    reason: catalog.reason,
    savedAt: catalog.savedAt,
    mode: catalog.mode,
    slot: catalog.slot,
    checksum: catalog.stateChecksum,
  }));
  const summary: StoredSaveSummary = {
    ...classified,
    savedAt: catalog.savedAt,
    mode: catalog.mode,
    slot: catalog.slot,
    reason: catalog.reason,
    checksum: catalog.stateChecksum,
  };
  storageEntryCache.set(catalog.key, {
    key: catalog.key,
    label: entryLabel(catalog.key, summary),
    bytes: catalog.byteLength,
    updatedAt,
    savedAt: catalog.savedAt,
    mode: catalog.mode,
    category: summary.category,
    slot: catalog.slot,
    source: entrySource(summary),
    reason: catalog.reason,
    automatic: summary.automatic,
    protected: summary.protected,
    checksum: catalog.stateChecksum,
  });
}

function notifyStorageStatus(): void {
  storageStatusListeners.forEach((listener) => listener());
}

function removeStorageEntry(key: string): void {
  if (storageEntryCache.delete(key)) notifyStorageStatus();
}

function trimRawCache(): void {
  while ([...cache.keys()].filter(isCatalogedSaveKey).length > RAW_CACHE_LIMIT) {
    const oldest = [...cache.keys()].find(isCatalogedSaveKey);
    if (!oldest) return;
    cache.delete(oldest);
  }
}

function buildFallbackCatalog(key: string, value: string): LocalSaveCatalog {
  let parsed: Record<string, any> | null = null;
  try { parsed = JSON.parse(value) as Record<string, any>; } catch { /* invalid fallback payload */ }
  const state = parsed?.state && typeof parsed.state === "object" ? parsed.state as Record<string, any> : null;
  const parsedSlot = parsed?.slot;
  const summary = classifySaveRecord(key, value);
  const payloadIdentity = computeSavePayloadTextChecksum(value);
  return {
    schemaVersion: 1,
    key,
    mode: state?.mode === "normal" || state?.mode === "speedrun" ? state.mode :
      parsed?.mode === "normal" || parsed?.mode === "speedrun" ? parsed.mode : summary.mode,
    kind: summary.category === "backup" ? "backup" : summary.category === "slot" ? "slot" :
      summary.category.includes("snapshot") ? "snapshot" : summary.category === "primary" ? "primary" :
        summary.category === "import-cache" ? "import-cache" : "protected",
    slot: parsedSlot === "main" || [1, 2, 3].includes(parsedSlot) ? parsedSlot : summary.slot,
    savedAt: typeof parsed?.savedAt === "number" ? Math.max(0, Math.floor(parsed.savedAt)) : 0,
    byteLength: payloadIdentity.byteLength, payloadChecksum: payloadIdentity.checksum, revision: revisionCache.get(key) ?? 0,
    stateVersion: typeof state?.version === "number" ? Math.max(0, Math.floor(state.version)) : 0,
    entityCount: Array.isArray(state?.entities) ? state.entities.length : 0,
    beltCount: Array.isArray(state?.belts) ? state.belts.length : 0,
    elapsedSeconds: typeof state?.elapsedSeconds === "number" ? Math.max(0, Math.floor(state.elapsedSeconds)) : 0,
    completedTechCount: Array.isArray(state?.research?.completedTechIds) ? state.research.completedTechIds.length : 0,
    activePlanetId: typeof state?.activePlanetId === "string" ? state.activePlanetId : "home",
    structurePoints: typeof state?.dysonSphere?.structurePoints === "number" ? Math.max(0, Math.floor(state.dysonSphere.structurePoints)) : 0,
    integrity: parsed ? "missing" : "invalid", stateChecksum: typeof parsed?.checksum === "string" ? parsed.checksum : null,
    reason: typeof parsed?.reason === "string" ? parsed.reason : null,
    settings: state?.settings && typeof state.settings === "object" ? state.settings : null,
  };
}

function putCacheValue(key: string, value: string, now = Date.now()): void {
  cache.delete(key);
  cache.set(key, value);
  knownSaveKeys.add(key);
  if (backend === "indexeddb") trimRawCache();
  if (isCatalogedSaveKey(key) && backend !== "indexeddb") {
    const catalog = buildFallbackCatalog(key, value);
    catalogCache.set(key, catalog);
    updateStorageEntryFromCatalog(catalog, now);
  } else if (!isCatalogedSaveKey(key)) {
    updateStorageEntry({ key, value, updatedAt: now, bytes: byteLength(value), summary: classifySaveRecord(key, value) });
  }
  notifyStorageStatus();
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "QuotaExceededError" || candidate.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    candidate.code === 22 || candidate.code === 1014;
}

function primaryKeyForMode(mode: LocalSaveMode): string {
  return mode === "speedrun" ? `${SAVE_KEY}.speedrun` : SAVE_KEY;
}

/** Cached monotonic local-write revision for diagnostics only. */
export function getPrimaryLocalSaveRevision(mode: LocalSaveMode = "normal"): number {
  ensureSynchronousFallback();
  return revisionCache.get(primaryKeyForMode(mode)) ?? 0;
}

function recordQuotaRecoveryPrompt(key: string): void {
  const mode = modeFromKey(key, cache.get(key)?.slice(0, 4_096) ?? "");
  const main = storageEntryCache.get(primaryKeyForMode(mode));
  const preservedChecksummedMain = Boolean(main?.checksum && main.category === "primary");
  recoveryPrompt = {
    mode,
    key,
    occurredAt: Date.now(),
    preservedChecksummedMain,
    message: preservedChecksummedMain
      ? `空间不足，本次${entrySource(classifySaveRecord(key, cache.get(key) ?? ""))}未写入；上一次带校验值的${mode === "speedrun" ? "速通" : "普通"}主存档仍原样保留。请管理快照或立即导出当前进度。`
      : `空间不足且未确认到可校验的${mode === "speedrun" ? "速通" : "普通"}主存档。请不要关闭页面，立即导出当前进度。`,
  };
  notifyStorageStatus();
}

function clearRecoveredQuotaPrompt(key: string): void {
  if (!recoveryPrompt || key !== primaryKeyForMode(recoveryPrompt.mode)) return;
  recoveryPrompt = null;
  notifyStorageStatus();
}

function automaticSnapshotOverflow(mode: LocalSaveMode): Array<LocalSaveStorageEntry & { checksum: string | null }> {
  return [...storageEntryCache.values()]
    .filter((entry) => entry.mode === mode && entry.category === "automatic-snapshot")
    .sort((left, right) => right.savedAt - left.savedAt || right.key.localeCompare(left.key))
    .slice(LOCAL_AUTOMATIC_SNAPSHOT_LIMIT);
}

function enforceAutomaticSnapshotLimit(mode: LocalSaveMode): void {
  for (const entry of automaticSnapshotOverflow(mode)) {
    try {
      removeLocalSaveValue(entry.key);
    } catch {
      // The new recovery point is already committed. Cleanup remains best
      // effort and is retried by the existing storage-layer snapshot trim.
    }
  }
}

function restoreCachedValueAfterFailedCommit(
  key: string,
  baseValue: string | null,
  baseKnown: boolean,
  baseCatalog: LocalSaveCatalog | null,
  expectedRevision: number,
): void {
  revisionCache.set(key, expectedRevision);
  if (!baseKnown) {
    cache.delete(key);
    knownSaveKeys.delete(key);
    catalogCache.delete(key);
    removeStorageEntry(key);
    return;
  }
  knownSaveKeys.add(key);
  if (baseValue !== null) cache.set(key, baseValue);
  if (baseCatalog) {
    catalogCache.set(key, baseCatalog);
    updateStorageEntryFromCatalog(baseCatalog);
  }
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
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const next = request.result;
      if (!next.objectStoreNames.contains(RECORD_STORE)) next.createObjectStore(RECORD_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        if (database === request.result) database = null;
        publishWriterStatus({ role: "unavailable", writerId, fencingToken: writerStatus.fencingToken, leaseExpiresAt: 0, reason: "另一个页面已升级本地存储，请刷新本页后继续" });
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
  });
}

async function readAllStoredKeys(db: IDBDatabase): Promise<string[]> {
  const transaction = db.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const keys = await requestResult(store.getAllKeys() as IDBRequest<IDBValidKey[]>);
  await done;
  return keys.filter((key): key is string => typeof key === "string");
}

async function readStoredRecordsByKey(db: IDBDatabase, keys: readonly string[]): Promise<StoredSaveRecord[]> {
  if (keys.length === 0) return [];
  const transaction = db.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const records = await Promise.all(keys.map((key) => requestResult(store.get(key) as IDBRequest<StoredSaveRecord | undefined>)));
  await done;
  return records.filter((record): record is StoredSaveRecord => Boolean(record && typeof record.key === "string" && typeof record.value === "string"));
}

function recordUpdatedAt(records: readonly StoredSaveRecord[], key: string, fallback: number): number {
  const updatedAt = records.find((record) => record.key === key)?.updatedAt;
  return typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : fallback;
}

async function readRecord(db: IDBDatabase, key: string): Promise<StoredSaveRecord | undefined> {
  const transaction = db.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const record = await requestResult(transaction.objectStore(RECORD_STORE).get(key) as IDBRequest<StoredSaveRecord | undefined>);
  await done;
  return record;
}

async function readCoordinationValue(db: IDBDatabase, key: string): Promise<string | null> {
  return (await readRecord(db, key))?.value ?? null;
}

function putStoredValue(store: IDBObjectStore, key: string, value: string, now = Date.now()): void {
  store.put({ key, value, updatedAt: now, bytes: byteLength(value), ...(isSaveKey(key) ? { summary: classifySaveRecord(key, value) } : {}) } satisfies StoredSaveRecord);
}

function putCatalogRecord(store: IDBObjectStore, catalog: LocalSaveCatalog, now = Date.now()): void {
  const value = serializeLocalSaveCatalog(catalog);
  store.put({ key: localSaveCatalogRecordKey(catalog.key), value, updatedAt: now, bytes: byteLength(value) } satisfies StoredSaveRecord);
}

function putSaveValueAndCatalog(
  store: IDBObjectStore,
  key: string,
  value: string,
  revision: number,
  now = Date.now(),
  preparedCatalog?: LocalSaveCatalog,
): LocalSaveCatalog | null {
  putStoredValue(store, key, value, now);
  if (!isCatalogedSaveKey(key)) return null;
  if (!preparedCatalog || preparedCatalog.key !== key) throw new Error("Catalog is required for save payload writes");
  const catalog = { ...preparedCatalog, revision };
  putCatalogRecord(store, catalog, now);
  return catalog;
}

async function writeRecord(db: IDBDatabase, key: string, value: string): Promise<void> {
  const catalog = isCatalogedSaveKey(key)
    ? (await import("./localSaveCatalogBuild")).buildLocalSaveCatalog(key, value, revisionCache.get(key) ?? 0)
    : null;
  const transaction = db.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const now = Date.now();
  const store = transaction.objectStore(RECORD_STORE);
  putStoredValue(store, key, value, now);
  if (catalog) putCatalogRecord(store, catalog, now);
  await done;
  const stored = await readRecord(db, key);
  if (!stored || stored.value !== value) throw new DOMException("IndexedDB read-back verification failed", "DataError");
  if (catalog) {
    knownSaveKeys.add(key);
    catalogCache.set(key, catalog);
    updateStorageEntryFromCatalog(catalog, stored.updatedAt);
  } else updateStorageEntry(stored);
  notifyStorageStatus();
}

function publishWriterStatus(next: LocalSaveWriterStatus): void {
  const changed = writerStatus.role !== next.role || writerStatus.fencingToken !== next.fencingToken ||
    writerStatus.leaseExpiresAt !== next.leaseExpiresAt || writerStatus.reason !== next.reason ||
    writerStatus.conflictId !== next.conflictId;
  writerStatus = next;
  if (next.role === "primary") scheduleLegacyCatalogIndex();
  if (changed) writerStatusListeners.forEach((listener) => listener({ ...writerStatus }));
}

function postCoordinationMessage(message: LocalSaveBroadcastMessage): void {
  try { broadcastChannel?.postMessage(message); } catch { /* storage-event fallback below */ }
  try {
    window.localStorage.setItem(LOCAL_SAVE_STORAGE_EVENT_KEY, JSON.stringify({ ...message, nonce: Math.random() }));
    window.localStorage.removeItem(LOCAL_SAVE_STORAGE_EVENT_KEY);
  } catch {
    // Broadcast and storage events are accelerators; durable revisions remain authoritative.
  }
}

async function withBrowserCoordinationLock<T>(operation: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return { acquired: true, value: await operation() };
  try {
    return await locks.request(LOCAL_SAVE_WRITER_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) =>
      lock ? { acquired: true, value: await operation() } : { acquired: false });
  } catch {
    // IndexedDB's readwrite transaction remains the fallback serialization.
    return { acquired: true, value: await operation() };
  }
}

async function writeLease(db: IDBDatabase, lease: LocalSaveWriterLease): Promise<void> {
  const transaction = db.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const current = parseLocalSaveWriterLease((await requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredSaveRecord | undefined>))?.value);
  if (current && current.ownerId !== writerId && current.expiresAt > lease.heartbeatAt) {
    transaction.abort();
    void done.catch(() => undefined);
    throw new LocalSaveReadOnlyError();
  }
  putStoredValue(store, LOCAL_SAVE_WRITER_LEASE_KEY, JSON.stringify(lease), lease.heartbeatAt);
  await done;
}

async function claimWriterLease(): Promise<boolean> {
  const now = Date.now();
  if (backend !== "indexeddb" || !database) {
    publishWriterStatus({ role: "primary", writerId, fencingToken: 1, leaseExpiresAt: Number.MAX_SAFE_INTEGER, reason: "当前环境使用兼容存储后端" });
    return true;
  }
  const attempt = await withBrowserCoordinationLock(async () => {
    const previous = parseLocalSaveWriterLease(await readCoordinationValue(database!, LOCAL_SAVE_WRITER_LEASE_KEY));
    if (!canClaimLocalSaveWriterLease(previous, writerId, now)) return { ok: false as const, previous };
    const lease = createLocalSaveWriterLease(writerId, previous, now);
    await writeLease(database!, lease);
    return { ok: true as const, previous, lease };
  });
  if (!attempt.acquired) {
    publishWriterStatus({
      role: "secondary",
      writerId,
      fencingToken: writerStatus.fencingToken,
      leaseExpiresAt: now + Math.min(1_000, LOCAL_SAVE_HEARTBEAT_INTERVAL_MS),
      reason: "另一个标签页正在更新本地存档，当前页面暂为只读",
    });
    return false;
  }
  if (!attempt.value?.ok) {
    const previous = attempt.value?.previous ?? parseLocalSaveWriterLease(await readCoordinationValue(database, LOCAL_SAVE_WRITER_LEASE_KEY));
    const current = parseLocalSaveWriterLease(await readCoordinationValue(database, LOCAL_SAVE_WRITER_LEASE_KEY));
    publishWriterStatus({
      role: "secondary",
      writerId,
      fencingToken: current?.fencingToken ?? previous?.fencingToken ?? 0,
      leaseExpiresAt: current?.expiresAt ?? previous?.expiresAt ?? 0,
      reason: "另一个标签页已取得本地存档写入权，当前页面为只读",
    });
    return false;
  }
  const lease = attempt.value.lease;
  await reloadLocalSaveCache();
  publishWriterStatus({ role: "primary", writerId, fencingToken: lease.fencingToken, leaseExpiresAt: lease.expiresAt, reason: "当前标签页负责本地存档" });
  postCoordinationMessage({ schemaVersion: 1, type: "lease", writerId, sentAt: now, fencingToken: lease.fencingToken, leaseExpiresAt: lease.expiresAt });
  return true;
}

async function releaseWriterLeaseForReload(): Promise<void> {
  if (backend !== "indexeddb" || !database) {
    publishWriterStatus({ ...writerStatus, role: "initializing", reason: "正在重新载入最新持久存档" });
    return;
  }
  const now = Date.now();
  const transaction = database.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const current = parseLocalSaveWriterLease((await requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredSaveRecord | undefined>))?.value);
  if (current?.ownerId === writerId && current.fencingToken === writerStatus.fencingToken) {
    putStoredValue(store, LOCAL_SAVE_WRITER_LEASE_KEY, JSON.stringify({ ...current, heartbeatAt: now, expiresAt: now }), now);
    await done;
  } else {
    transaction.abort();
    void done.catch(() => undefined);
  }
  publishWriterStatus({ ...writerStatus, role: "initializing", leaseExpiresAt: now, reason: "正在重新载入最新持久存档" });
}

async function renewWriterLease(): Promise<void> {
  if (writerStatus.role !== "primary" || backend !== "indexeddb" || !database) return;
  const now = Date.now();
  const renewed = await withBrowserCoordinationLock(async () => {
    const transaction = database!.transaction(RECORD_STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(RECORD_STORE);
    const current = parseLocalSaveWriterLease((await requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredSaveRecord | undefined>))?.value);
    if (!current || current.ownerId !== writerId || current.fencingToken !== writerStatus.fencingToken) {
      transaction.abort();
      void done.catch(() => undefined);
      return { ok: false as const, current };
    }
    const next = { ...current, heartbeatAt: now, expiresAt: now + LOCAL_SAVE_LEASE_DURATION_MS } satisfies LocalSaveWriterLease;
    putStoredValue(store, LOCAL_SAVE_WRITER_LEASE_KEY, JSON.stringify(next), now);
    await done;
    return { ok: true as const, current: next };
  });
  if (!renewed.acquired) return;
  if (!renewed.value?.ok) {
    const current = renewed.value?.current;
    publishWriterStatus({ role: "secondary", writerId, fencingToken: current?.fencingToken ?? writerStatus.fencingToken, leaseExpiresAt: current?.expiresAt ?? 0, reason: "本地存档写入权已由另一个标签页接管" });
    return;
  }
  publishWriterStatus({ ...writerStatus, leaseExpiresAt: renewed.value.current.expiresAt });
}

function preserveWriteConflict(
  store: IDBObjectStore,
  key: string,
  candidate: string | null,
  persisted: string | null,
  fencingToken: number,
  now: number,
  buildCatalog: (key: string, value: string, revision: number) => LocalSaveCatalog,
): string {
  const conflictId = createLocalSaveConflictId(now, writerId);
  const keys = localSaveConflictKeys(conflictId);
  if (candidate !== null) putSaveValueAndCatalog(store, keys.candidate, candidate, 0, now, buildCatalog(keys.candidate, candidate, 0));
  if (persisted !== null) putSaveValueAndCatalog(store, keys.persisted, persisted, 0, now, buildCatalog(keys.persisted, persisted, 0));
  const metadata = {
    schemaVersion: 1,
    conflictId,
    saveKey: key,
    candidateKey: keys.candidate,
    persistedKey: keys.persisted,
    candidateDeleted: candidate === null,
    persistedMissing: persisted === null,
    writerId,
    fencingToken,
    createdAt: now,
  } satisfies LocalSaveConflictRecord;
  putStoredValue(store, localSaveConflictMetadataKey(conflictId), JSON.stringify(metadata), now);
  return conflictId;
}

async function commitCoordinatedRecord(
  db: IDBDatabase,
  key: string,
  value: string | null,
  baseValue: string | null,
  baseKnown: boolean,
  baseCatalog: LocalSaveCatalog | null,
  expectedRevision: number,
): Promise<LocalSaveRevision> {
  if (writerStatus.role !== "primary") throw new LocalSaveReadOnlyError(writerStatus.reason);
  const { buildLocalSaveCatalog, catalogMatchesPayload } = await import("./localSaveCatalogBuild");
  const now = Date.now();
  const preparedCatalog = value !== null && isCatalogedSaveKey(key)
    ? buildLocalSaveCatalog(key, value, expectedRevision + 1)
    : null;
  const transaction = db.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(RECORD_STORE);
  const leaseRecord = await requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredSaveRecord | undefined>);
  const lease = parseLocalSaveWriterLease(leaseRecord?.value);
  const renewedLease = renewOwnedLocalSaveWriterLease(lease, writerId, writerStatus.fencingToken, now);
  if (renewedLease) putStoredValue(store, LOCAL_SAVE_WRITER_LEASE_KEY, JSON.stringify(renewedLease), now);
  const revisionRecord = await requestResult(store.get(localSaveRevisionKey(key)) as IDBRequest<StoredSaveRecord | undefined>);
  const revision = parseLocalSaveRevision(revisionRecord?.value);
  const currentRecord = await requestResult(store.get(key) as IDBRequest<StoredSaveRecord | undefined>);
  const currentCatalogRecord = isCatalogedSaveKey(key)
    ? await requestResult(store.get(localSaveCatalogRecordKey(key)) as IDBRequest<StoredSaveRecord | undefined>)
    : undefined;
  const persisted = currentRecord?.value ?? null;
  const currentCatalog = parseLocalSaveCatalog(currentCatalogRecord?.value, key);
  const baseIdentity = baseValue !== null
    ? inspectLocalSaveIdentity(baseValue)
    : { savedAt: baseCatalog?.savedAt ?? 0, checksum: baseCatalog?.stateChecksum ?? null };
  const revisionMatches = (revision?.revision ?? 0) === expectedRevision &&
    (!revision || revision.saveKey === key && revision.deleted === !baseKnown &&
      revision.savedAt === baseIdentity.savedAt && revision.checksum === baseIdentity.checksum);
  const leaseMatches = renewedLease !== null;
  const catalogProofMatches = persisted !== null && baseCatalog !== null && currentCatalog !== null &&
    currentCatalog.payloadChecksum === baseCatalog.payloadChecksum && currentCatalog.byteLength === baseCatalog.byteLength &&
    currentCatalog.revision === baseCatalog.revision && catalogMatchesPayload(baseCatalog, persisted);
  const persistedMatches = baseValue !== null ? persisted === baseValue : baseKnown ? catalogProofMatches : persisted === null;
  const legacyBaseMatches = !revision && expectedRevision === 0 && persistedMatches;
  if (!leaseMatches || !persistedMatches || !(revisionMatches && (revision !== null || legacyBaseMatches))) {
    const conflictId = preserveWriteConflict(store, key, value, persisted, writerStatus.fencingToken, now, buildLocalSaveCatalog);
    await done;
    cache.delete(key);
    catalogCache.delete(key);
    removeStorageEntry(key);
    if (persisted !== null) {
      cache.set(key, persisted);
      knownSaveKeys.add(key);
      trimRawCache();
      const restoredCatalog = currentCatalog && currentCatalog.revision === (revision?.revision ?? 0) && catalogMatchesPayload(currentCatalog, persisted)
        ? currentCatalog
        : buildLocalSaveCatalog(key, persisted, revision?.revision ?? 0);
      catalogCache.set(key, restoredCatalog);
      updateStorageEntryFromCatalog(restoredCatalog, currentRecord?.updatedAt ?? now);
    } else knownSaveKeys.delete(key);
    notifyStorageStatus();
    revisionCache.set(key, revision?.revision ?? 0);
    publishWriterStatus({
      role: "conflict",
      writerId,
      fencingToken: lease?.fencingToken ?? writerStatus.fencingToken,
      leaseExpiresAt: lease?.expiresAt ?? 0,
      reason: "检测到另一个标签页已更新存档，已停止覆盖并保留双方版本",
      conflictId,
    });
    postCoordinationMessage({ schemaVersion: 1, type: "conflict", writerId, sentAt: now, key, conflictId, fencingToken: lease?.fencingToken });
    throw new LocalSaveConflictError(conflictId);
  }
  const nextRevision = createLocalSaveRevision({
    saveKey: key,
    previousRevision: expectedRevision,
    value,
    writerId,
    fencingToken: renewedLease!.fencingToken,
    now,
  });
  let committedCatalog: LocalSaveCatalog | null = null;
  if (value === null) {
    store.delete(key);
    if (isCatalogedSaveKey(key)) store.delete(localSaveCatalogRecordKey(key));
  } else committedCatalog = putSaveValueAndCatalog(store, key, value, nextRevision.revision, now, preparedCatalog ?? undefined);
  putStoredValue(store, localSaveRevisionKey(key), JSON.stringify(nextRevision), now);
  await done;
  if (writerStatus.role === "primary" && writerStatus.fencingToken === renewedLease!.fencingToken) {
    publishWriterStatus({ ...writerStatus, leaseExpiresAt: renewedLease!.expiresAt, reason: "当前标签页负责本地存档" });
  }
  const [stored, storedCatalogRecord] = await Promise.all([
    readRecord(db, key),
    isCatalogedSaveKey(key) ? readRecord(db, localSaveCatalogRecordKey(key)) : Promise.resolve(undefined),
  ]);
  if ((stored?.value ?? null) !== value) throw new DOMException("IndexedDB coordinated read-back verification failed", "DataError");
  const storedCatalog = parseLocalSaveCatalog(storedCatalogRecord?.value, key);
  if (value !== null && committedCatalog && (!storedCatalog || storedCatalog.revision !== nextRevision.revision || !catalogMatchesPayload(storedCatalog, value))) {
    throw new DOMException("IndexedDB catalog read-back verification failed", "DataError");
  }
  if (stored && storedCatalog) {
    knownSaveKeys.add(key);
    catalogCache.set(key, storedCatalog);
    updateStorageEntryFromCatalog(storedCatalog, stored.updatedAt);
  } else if (stored && !isCatalogedSaveKey(key)) {
    knownSaveKeys.add(key);
    updateStorageEntry(stored);
  } else {
    knownSaveKeys.delete(key);
    catalogCache.delete(key);
    removeStorageEntry(key);
  }
  notifyStorageStatus();
  revisionCache.set(key, Math.max(revisionCache.get(key) ?? 0, nextRevision.revision));
  postCoordinationMessage({
    schemaVersion: 1,
    type: value === null ? "deleted" : "saved",
    writerId,
    sentAt: now,
    key,
    revision: nextRevision.revision,
    fencingToken: nextRevision.fencingToken,
  });
  return nextRevision;
}

async function refreshAfterRemoteChange(message: LocalSaveBroadcastMessage): Promise<void> {
  if (message.writerId === writerId || backend !== "indexeddb" || !database) return;
  try {
    await reloadLocalSaveCache();
    const lease = parseLocalSaveWriterLease(await readCoordinationValue(database, LOCAL_SAVE_WRITER_LEASE_KEY));
    if (lease && lease.ownerId !== writerId && lease.expiresAt > Date.now() && lease.fencingToken >= writerStatus.fencingToken) {
      publishWriterStatus({ role: "secondary", writerId, fencingToken: lease.fencingToken, leaseExpiresAt: lease.expiresAt, reason: "另一个标签页已更新本地存档，当前页面已切换为只读" });
    }
    if (message.key) {
      const revision = parseLocalSaveRevision(await readCoordinationValue(database, localSaveRevisionKey(message.key)));
      if (revision) revisionCache.set(message.key, revision.revision);
    }
    if (message.type === "conflict" && message.conflictId) {
      const conflict = parseLocalSaveConflictRecord(await readCoordinationValue(database, localSaveConflictMetadataKey(message.conflictId)));
      if (conflict && conflict.resolvedAt === undefined) {
        publishWriterStatus({ role: "conflict", writerId, fencingToken: lease?.fencingToken ?? writerStatus.fencingToken, leaseExpiresAt: lease?.expiresAt ?? writerStatus.leaseExpiresAt, reason: "另一个标签页检测到存档分叉，双方版本均已保留", conflictId: conflict.conflictId });
      }
    }
    saveChangeListeners.forEach((listener) => listener(message));
  } catch {
    // A subsequent read or write performs the durable revision check again.
  }
}

function installCoordinationListeners(): void {
  if (typeof window === "undefined") return;
  if (typeof BroadcastChannel !== "undefined" && !broadcastChannel) {
    try {
      broadcastChannel = new BroadcastChannel(LOCAL_SAVE_BROADCAST_CHANNEL);
      broadcastChannel.onmessage = (event: MessageEvent<LocalSaveBroadcastMessage>) => {
        if (event.data?.schemaVersion === 1) void refreshAfterRemoteChange(event.data);
      };
    } catch { broadcastChannel = null; }
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== LOCAL_SAVE_STORAGE_EVENT_KEY || !event.newValue) return;
    try {
      const message = JSON.parse(event.newValue) as LocalSaveBroadcastMessage;
      if (message.schemaVersion === 1) void refreshAfterRemoteChange(message);
    } catch { /* Ignore unrelated/malformed storage events. */ }
  });
}

function startWriterCoordinationTimers(): void {
  if (typeof window === "undefined") return;
  if (writerHeartbeat === null) writerHeartbeat = window.setInterval(() => void renewWriterLease().catch(() => undefined), LOCAL_SAVE_HEARTBEAT_INTERVAL_MS);
}

function legacyEntries(): Array<[string, string]> {
  try {
    return Object.keys(window.localStorage).filter(isSaveKey).flatMap((key) => {
      const value = window.localStorage.getItem(key);
      return value === null ? [] : [[key, value] as [string, string]];
    });
  } catch {
    return [];
  }
}

function preserveDevelopmentMirror(): boolean {
  return import.meta.env.DEV && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") &&
    new URLSearchParams(window.location.search).get("storageMigration") !== "production";
}

interface EmergencyMirror {
  payload: string;
  metadata: ReturnType<typeof parseLocalSaveEmergencyMirrorMetadata>;
}

function readEmergencyMirror(mode: LocalSaveMode): EmergencyMirror | null {
  try {
    const keys = localSaveEmergencyMirrorKeys(mode);
    const payload = window.localStorage.getItem(keys.payload);
    const metadata = parseLocalSaveEmergencyMirrorMetadata(window.localStorage.getItem(keys.metadata));
    if (payload === null) {
      // Metadata without a payload cannot recover any data. Removing only the
      // orphan metadata is safe and prevents retrying it on every startup.
      if (window.localStorage.getItem(keys.metadata) !== null) window.localStorage.removeItem(keys.metadata);
      return null;
    }
    // Keep a payload even when metadata is missing or malformed. It cannot be
    // applied automatically, but it may be the only copy left after a crash
    // between the two synchronous localStorage writes.
    return { payload, metadata };
  } catch {
    return null;
  }
}

function clearEmergencyMirror(mode: LocalSaveMode): void {
  try {
    const keys = localSaveEmergencyMirrorKeys(mode);
    window.localStorage.removeItem(keys.payload);
    window.localStorage.removeItem(keys.metadata);
  } catch {
    // A stale mirror is reconciled on a later startup and never overwrites silently.
  }
}

function scheduleLegacyCatalogIndex(): void {
  if (legacyCatalogIndexScheduled || legacyCatalogIndexQueue.length === 0 || backend !== "indexeddb" || !database) return;
  legacyCatalogIndexScheduled = true;
  const run = () => {
    legacyCatalogIndexScheduled = false;
    const key = legacyCatalogIndexQueue.shift();
    if (!key || backend !== "indexeddb" || !database) return;
    if (writerStatus.role !== "primary") {
      legacyCatalogIndexQueue.unshift(key);
      if (writerStatus.role === "initializing") window.setTimeout(scheduleLegacyCatalogIndex, 250);
      return;
    }
    void (async () => {
      const { indexLegacyLocalSaveCatalog } = await import("./localSaveCatalogIndex");
      const indexed = await indexLegacyLocalSaveCatalog(database!, RECORD_STORE, key, {
        writerId,
        fencingToken: writerStatus.fencingToken,
      });
      if (!indexed) return;
      if (!indexed.worker) performance.mark("local-save-catalog-sync-fallback");
      if (knownSaveKeys.has(key)) {
        catalogCache.set(key, indexed.catalog);
        updateStorageEntryFromCatalog(indexed.catalog, indexed.updatedAt);
        notifyStorageStatus();
      }
    })().catch(() => undefined).finally(() => scheduleLegacyCatalogIndex());
  };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 5_000 });
  else window.setTimeout(run, 1_000);
}

async function initializeIndexedDb(): Promise<void> {
  const db = await openDatabase();
  database = db;
  backend = "indexeddb";
  cache.clear();
  knownSaveKeys.clear();
  catalogCache.clear();
  revisionCache.clear();
  storageEntryCache.clear();
  const keys = await readAllStoredKeys(db);
  for (const key of keys) if (isSaveKey(key)) knownSaveKeys.add(key);
  const records = await readStoredRecordsByKey(db, keys.filter((key) =>
    !isSaveKey(key) || key.endsWith(".snapshot.sequence") || key.endsWith(".snapshot.speedrun.sequence"),
  ));
  const pendingCatalogs: LocalSaveCatalog[] = [];
  for (const record of records) {
    const catalogPayloadKey = payloadKeyFromLocalSaveCatalogRecord(record.key);
    if (catalogPayloadKey) {
      const catalog = parseLocalSaveCatalog(record.value, catalogPayloadKey);
      if (catalog) pendingCatalogs.push(catalog);
      continue;
    }
    if (record.key.endsWith(".snapshot.sequence") || record.key.endsWith(".snapshot.speedrun.sequence")) cache.set(record.key, record.value);
    if (record.key.startsWith(LOCAL_SAVE_REVISION_KEY_PREFIX)) {
      const revision = parseLocalSaveRevision(record.value);
      if (revision) revisionCache.set(revision.saveKey, revision.revision);
    }
    if (record.key.startsWith(`${LOCAL_SAVE_COORDINATION_PREFIX}.conflict.`)) {
      const conflict = parseLocalSaveConflictRecord(record.value);
      if (conflict && conflict.resolvedAt === undefined && conflict.createdAt >= startupConflictCreatedAt) {
        startupConflictId = conflict.conflictId;
        startupConflictCreatedAt = conflict.createdAt;
      }
    }
  }
  for (const catalog of pendingCatalogs) {
    if (!knownSaveKeys.has(catalog.key) || catalog.revision !== (revisionCache.get(catalog.key) ?? 0)) continue;
    catalogCache.set(catalog.key, catalog);
    updateStorageEntryFromCatalog(catalog, recordUpdatedAt(records, localSaveCatalogRecordKey(catalog.key), catalog.savedAt));
  }
  legacyCatalogIndexQueue = [...knownSaveKeys].filter((key) => isCatalogedSaveKey(key) && !catalogCache.has(key));
  scheduleLegacyCatalogIndex();

  const durableLease = parseLocalSaveWriterLease(await readCoordinationValue(db, LOCAL_SAVE_WRITER_LEASE_KEY));
  for (const mode of ["normal", "speedrun"] as const) {
    const mirror = readEmergencyMirror(mode);
    if (!mirror) continue;
    const key = primaryKeyForMode(mode);
    const existingRecord = knownSaveKeys.has(key) ? await readRecord(db, key) : undefined;
    const existing = existingRecord?.value ?? null;
    const revision = parseLocalSaveRevision(await readCoordinationValue(db, localSaveRevisionKey(key)));
    const payloadIdentity = inspectLocalSaveIdentity(mirror.payload);
    const integrity = inspectSaveEnvelopeChecksum(mirror.payload);
    const payloadMode = inspectedEnvelopeMode(integrity);
    if (mirror.metadata && integrity.status === "valid" && payloadMode === mode && canApplyLocalSaveEmergencyMirror({
      metadata: mirror.metadata,
      expectedWriterId: writerId,
      expectedMode: mode,
      expectedSaveKey: key,
      payloadIdentity,
      durableRevision: revision,
      durableLease,
    })) {
      const now = Date.now();
      const { buildLocalSaveCatalog } = await import("./localSaveCatalogBuild");
      const mirrorCatalog = buildLocalSaveCatalog(key, mirror.payload, (revision?.revision ?? 0) + 1);
      const transaction = db.transaction(RECORD_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(RECORD_STORE);
      const nextRevision = createLocalSaveRevision({
        saveKey: key,
        previousRevision: revision?.revision ?? 0,
        value: mirror.payload,
        writerId,
        fencingToken: mirror.metadata.fencingToken,
        now,
      });
      putSaveValueAndCatalog(store, key, mirror.payload, nextRevision.revision, now, mirrorCatalog);
      putStoredValue(store, localSaveRevisionKey(key), JSON.stringify(nextRevision), now);
      await done;
      revisionCache.set(key, nextRevision.revision);
      putCacheValue(key, mirror.payload, now);
      clearEmergencyMirror(mode);
      // A legacy same-name normal mirror may remain from older code. Remove it
      // only when it is byte-identical to the proven mirror just committed.
      if (mode === "normal") {
        try { if (window.localStorage.getItem(key) === mirror.payload) window.localStorage.removeItem(key); } catch { /* optional cleanup */ }
      }
      continue;
    }
    if (existing !== mirror.payload) {
      const now = Date.now();
      const { buildLocalSaveCatalog } = await import("./localSaveCatalogBuild");
      const transaction = db.transaction(RECORD_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(RECORD_STORE);
      const conflictId = preserveWriteConflict(
        store,
        key,
        mirror.payload,
        existing,
        mirror.metadata?.fencingToken ?? revision?.fencingToken ?? durableLease?.fencingToken ?? 1,
        now,
        buildLocalSaveCatalog,
      );
      await done;
      startupConflictId = conflictId;
      startupConflictCreatedAt = now;
    }
    clearEmergencyMirror(mode);
  }

  const legacy = legacyEntries();
  for (const [key, value] of legacy) {
    const existingRecord = knownSaveKeys.has(key) ? await readRecord(db, key) : undefined;
    const existing = existingRecord?.value ?? null;
    const revision = parseLocalSaveRevision(await readCoordinationValue(db, localSaveRevisionKey(key)));
    let selected: string | null = existing && savedAt(existing) >= savedAt(value) ? existing : value;
    if (revision && existing !== value && preserveDevelopmentMirror()) {
      // localhost development builds keep a compatibility mirror so legacy UI
      // automation can inspect saves. Once a coordinated IDB revision exists,
      // that mirror is never authoritative and may lag an unload-time commit.
      // Production builds do not enter this branch and still preserve any
      // divergent legacy value as an explicit conflict.
      selected = existing;
      try {
        if (existing === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, existing);
      } catch { /* the coordinated IndexedDB copy remains authoritative */ }
    } else if (revision && existing !== value) {
      // Once coordinated revisions exist, a localStorage emergency mirror may
      // have come from a stale pagehide handler. Preserve both copies instead
      // of letting wall-clock savedAt choose a winner.
      const now = Date.now();
      const { buildLocalSaveCatalog } = await import("./localSaveCatalogBuild");
      const transaction = db.transaction(RECORD_STORE, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(RECORD_STORE);
      const conflictId = preserveWriteConflict(store, key, value, existing, revision.fencingToken, now, buildLocalSaveCatalog);
      await done;
      selected = existing;
      startupConflictId = conflictId;
      startupConflictCreatedAt = now;
    } else if (existing !== selected) {
      await writeRecord(db, key, selected);
    }
    if (selected === null) {
      cache.delete(key);
      removeStorageEntry(key);
    } else putCacheValue(key, selected);
    const verified = await readRecord(db, key);
    if (!preserveDevelopmentMirror() && (verified?.value ?? null) === selected) {
      try {
        if (window.localStorage.getItem(key) === value) window.localStorage.removeItem(key);
      } catch {
        // The verified IndexedDB copy remains authoritative.
      }
    }
  }
  // Startup and menu summaries are catalog-backed. Emergency/legacy
  // reconciliation may transiently hydrate raw strings, but none remain idle.
  for (const key of [...cache.keys()]) if (isCatalogedSaveKey(key)) cache.delete(key);
}

function initializeFallback(): void {
  const entries = legacyEntries();
  for (const [key, value] of entries) putCacheValue(key, value);
  try {
    const probe = `${SAVE_KEY}.storage-probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    backend = "local-storage";
  } catch {
    backend = "memory";
  }
  publishWriterStatus({ role: "primary", writerId, fencingToken: 1, leaseExpiresAt: Number.MAX_SAFE_INTEGER, reason: "当前环境使用兼容存储后端" });
  synchronousFallbackInitialized = true;
}

export function initializeLocalSaveStore(): Promise<void> {
  if (initialization) return initialization;
  if (synchronousFallbackInitialized) return Promise.resolve();
  initialization = (async () => {
    if (typeof window === "undefined" || !window.indexedDB) {
      initializeFallback();
      return;
    }
    try {
      await initializeIndexedDb();
    } catch {
      database?.close();
      database = null;
      initializeFallback();
    }
    installCoordinationListeners();
    await claimWriterLease();
    if (startupConflictId) {
      publishWriterStatus({ ...writerStatus, role: "conflict", reason: "检测到旧标签页留下的急救存档，已保留双方版本", conflictId: startupConflictId });
    }
    startWriterCoordinationTimers();
  })();
  return initialization;
}

export function getLocalSaveWriterStatus(): LocalSaveWriterStatus {
  return { ...writerStatus };
}

export function subscribeLocalSaveWriterStatus(listener: (status: LocalSaveWriterStatus) => void): () => void {
  writerStatusListeners.add(listener);
  listener({ ...writerStatus });
  return () => writerStatusListeners.delete(listener);
}

export function subscribeLocalSaveChanges(listener: (message: LocalSaveBroadcastMessage) => void): () => void {
  saveChangeListeners.add(listener);
  return () => saveChangeListeners.delete(listener);
}

export async function takeOverLocalSaveWriter(): Promise<boolean> {
  if (writerStatus.role === "primary") return true;
  if (writerStatus.role === "conflict") return false;
  if (backend === "indexeddb" && database) {
    const durable = parseLocalSaveWriterLease(await readCoordinationValue(database, LOCAL_SAVE_WRITER_LEASE_KEY));
    return !durable || durable.expiresAt <= Date.now();
  }
  return writerStatus.leaseExpiresAt <= Date.now();
}

export function canWriteLocalSaves(): boolean {
  return writerStatus.role === "primary";
}

export async function getLocalSaveConflicts(): Promise<LocalSaveConflictSummary[]> {
  await initializeLocalSaveStore();
  if (backend !== "indexeddb" || !database) return [];
  const keys = await readAllStoredKeys(database);
  const records = await readStoredRecordsByKey(database, keys.filter((key) => key.startsWith(`${LOCAL_SAVE_COORDINATION_PREFIX}.conflict.`)));
  const conflicts = records.flatMap((record) => {
    const conflict = parseLocalSaveConflictRecord(record.value);
    return conflict && conflict.resolvedAt === undefined ? [conflict] : [];
  });
  const catalogRecords = await readStoredRecordsByKey(database, conflicts.flatMap((conflict) => [
    localSaveCatalogRecordKey(conflict.candidateKey),
    localSaveCatalogRecordKey(conflict.persistedKey),
  ]));
  const catalogs = new Map(catalogRecords.flatMap((record) => {
    const payloadKey = payloadKeyFromLocalSaveCatalogRecord(record.key);
    const catalog = payloadKey ? parseLocalSaveCatalog(record.value, payloadKey) : null;
    return payloadKey && catalog ? [[payloadKey, catalog] as const] : [];
  }));
  return conflicts
    .map((conflict) => {
      const candidateCatalog = catalogs.get(conflict.candidateKey) ?? null;
      const persistedCatalog = catalogs.get(conflict.persistedKey) ?? null;
      return [{
        conflictId: conflict.conflictId,
        saveKey: conflict.saveKey,
        createdAt: conflict.createdAt,
        candidate: { available: keys.includes(conflict.candidateKey), deleted: conflict.candidateDeleted, savedAt: candidateCatalog?.savedAt ?? 0, checksum: candidateCatalog?.stateChecksum ?? null },
        persisted: { available: keys.includes(conflict.persistedKey), missing: conflict.persistedMissing, savedAt: persistedCatalog?.savedAt ?? 0, checksum: persistedCatalog?.stateChecksum ?? null },
      } satisfies LocalSaveConflictSummary];
    }).flat()
    .sort((left, right) => right.createdAt - left.createdAt);
}

function conflictResolutionFailure(
  startedAt: number,
  error: unknown,
): LocalSaveConflictResolutionResult {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  if (error instanceof LocalSaveConflictResolutionError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      elapsedMs,
      ...(error.leaseExpiresAt !== undefined ? { leaseExpiresAt: error.leaseExpiresAt } : {}),
    };
  }
  if (error instanceof LocalSaveReadOnlyError) {
    return {
      ok: false,
      code: "active-writer",
      message: "另一个页面仍持有本地存档写入权。请关闭其他同源标签页或 PWA 页面，等待租约到期后重试。",
      retryable: true,
      elapsedMs,
      ...(writerStatus.leaseExpiresAt > 0 ? { leaseExpiresAt: writerStatus.leaseExpiresAt } : {}),
    };
  }
  return {
    ok: false,
    code: error instanceof DOMException && error.name === "DataError" ? "verification-failed" : "storage-error",
    message: error instanceof Error && error.message ? error.message : "本地存档恢复失败，候选副本仍已保留",
    retryable: true,
    elapsedMs,
  };
}

async function requireConflictResolutionLease(startedAt: number): Promise<LocalSaveConflictResolutionResult | null> {
  if (writerStatus.role === "primary") return null;
  if (await claimWriterLease()) return null;
  const durable = database
    ? parseLocalSaveWriterLease(await readCoordinationValue(database, LOCAL_SAVE_WRITER_LEASE_KEY))
    : null;
  const remainingMs = Math.max(0, (durable?.expiresAt ?? writerStatus.leaseExpiresAt) - Date.now());
  return {
    ok: false,
    code: "active-writer",
    message: remainingMs > 0
      ? `另一个页面仍持有本地存档写入权，约 ${Math.max(1, Math.ceil(remainingMs / 1_000))} 秒后可重试。请先关闭其他同源标签页或 PWA 页面。`
      : "暂时无法取得本地存档写入权，请关闭其他同源标签页或 PWA 页面后重试。",
    retryable: true,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ...((durable?.expiresAt ?? 0) > 0 ? { leaseExpiresAt: durable!.expiresAt } : {}),
  };
}

export async function resolveLocalSaveConflictDetailed(
  conflictId: string,
  resolution: "candidate" | "persisted",
): Promise<LocalSaveConflictResolutionResult> {
  const startedAt = Date.now();
  await initializeLocalSaveStore();
  if (backend !== "indexeddb" || !database) {
    return {
      ok: false,
      code: "storage-unavailable",
      message: "当前浏览器的 IndexedDB 不可用，无法安全处理冲突；候选副本保持不变。",
      retryable: false,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
  }
  const leaseFailure = await requireConflictResolutionLease(startedAt);
  if (leaseFailure) return leaseFailure;
  const { buildLocalSaveCatalog } = await import("./localSaveCatalogBuild");

  let transaction: IDBTransaction | null = null;
  let done: Promise<void> | null = null;
  try {
    const now = Date.now();
    transaction = database.transaction(RECORD_STORE, "readwrite");
    done = transactionDone(transaction);
    const store = transaction.objectStore(RECORD_STORE);
    const conflictRecord = await requestResult(store.get(localSaveConflictMetadataKey(conflictId)) as IDBRequest<StoredSaveRecord | undefined>);
    const conflict = parseLocalSaveConflictRecord(conflictRecord?.value);
    if (!conflict || conflict.resolvedAt !== undefined) {
      throw new LocalSaveConflictResolutionError("conflict-missing", "冲突记录不存在或已经处理，请刷新后重新检查。", false);
    }
    const leaseRecord = await requestResult(store.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredSaveRecord | undefined>);
    const lease = parseLocalSaveWriterLease(leaseRecord?.value);
    const renewedLease = renewOwnedLocalSaveWriterLease(lease, writerId, writerStatus.fencingToken, now);
    if (!renewedLease) {
      throw new LocalSaveConflictResolutionError(
        lease?.ownerId && lease.ownerId !== writerId ? "active-writer" : "lease-lost",
        lease?.ownerId && lease.ownerId !== writerId
          ? "另一个页面已取得本地存档写入权。请关闭其他页面或等待租约到期后重试。"
          : "本页写入租约已经失效且无法安全续期，请重新取得写入权后重试。",
        true,
        lease?.expiresAt,
      );
    }
    putStoredValue(store, LOCAL_SAVE_WRITER_LEASE_KEY, JSON.stringify(renewedLease), now);
    const candidateRecord = conflict.candidateDeleted
      ? undefined
      : await requestResult(store.get(conflict.candidateKey) as IDBRequest<StoredSaveRecord | undefined>);
    const persistedRecord = conflict.persistedMissing
      ? undefined
      : await requestResult(store.get(conflict.persistedKey) as IDBRequest<StoredSaveRecord | undefined>);
    const currentRecord = await requestResult(store.get(conflict.saveKey) as IDBRequest<StoredSaveRecord | undefined>);
    const revisionRecord = await requestResult(store.get(localSaveRevisionKey(conflict.saveKey)) as IDBRequest<StoredSaveRecord | undefined>);
    const candidate = conflict.candidateDeleted ? null : candidateRecord?.value ?? null;
    const persistedAtConflict = conflict.persistedMissing ? null : persistedRecord?.value ?? null;
    const current = currentRecord?.value ?? null;
    let revision = parseLocalSaveRevision(revisionRecord?.value);
    if (!conflict.candidateDeleted && candidate === null) {
      throw new LocalSaveConflictResolutionError("candidate-missing", "冲突候选副本缺失，当前存档没有被修改。", false);
    }
    if (!conflict.persistedMissing && persistedAtConflict === null) {
      throw new LocalSaveConflictResolutionError("persisted-missing", "冲突发生时的持久副本缺失，当前存档没有被修改。", false);
    }
    if (resolution === "candidate" && candidate !== null) {
      const candidateIntegrity = inspectSaveEnvelopeChecksum(candidate);
      if (candidateIntegrity.status === "invalid" || inspectedEnvelopeMode(candidateIntegrity) !== modeFromKey(conflict.saveKey)) {
        throw new LocalSaveConflictResolutionError("candidate-invalid", "冲突候选存档完整性或模式校验失败，候选原文已保留。", false);
      }
    }
    const selected = resolution === "candidate" ? candidate : persistedAtConflict;
    const selectedIdentity = inspectLocalSaveIdentity(selected);
    const selectedAlreadyApplied = current === selected && revision?.deleted === (selected === null) &&
      revision.savedAt === selectedIdentity.savedAt && revision.checksum === selectedIdentity.checksum;
    const selectedOwnedByThisLease = selectedAlreadyApplied && revision?.writerId === writerId &&
      revision.fencingToken === renewedLease.fencingToken;
    if (current !== persistedAtConflict && !selectedAlreadyApplied) {
      throw new LocalSaveConflictResolutionError("base-changed", "当前存档在确认期间再次发生变化，双方副本均已保留，请刷新后重新选择。", true);
    }
    if (!selectedOwnedByThisLease) {
      revision = createLocalSaveRevision({
        saveKey: conflict.saveKey,
        previousRevision: revision?.revision ?? 0,
        value: selected,
        writerId,
        fencingToken: renewedLease.fencingToken,
        now,
      });
      if (selected === null) {
        store.delete(conflict.saveKey);
        if (isCatalogedSaveKey(conflict.saveKey)) store.delete(localSaveCatalogRecordKey(conflict.saveKey));
      } else putSaveValueAndCatalog(
        store,
        conflict.saveKey,
        selected,
        revision.revision,
        now,
        buildLocalSaveCatalog(conflict.saveKey, selected, revision.revision),
      );
      putStoredValue(store, localSaveRevisionKey(conflict.saveKey), JSON.stringify(revision), now);
    }
    await done;
    transaction = null;
    done = null;
    publishWriterStatus({ ...writerStatus, leaseExpiresAt: renewedLease.expiresAt, reason: "正在验证所选本地存档" });

    const [verifiedRecord, verifiedRevisionRaw] = await Promise.all([
      readRecord(database, conflict.saveKey),
      readCoordinationValue(database, localSaveRevisionKey(conflict.saveKey)),
    ]);
    const verifiedValue = verifiedRecord?.value ?? null;
    const verifiedRevision = parseLocalSaveRevision(verifiedRevisionRaw);
    if (verifiedValue !== selected || !verifiedRevision || !revision ||
      verifiedRevision.revision !== revision.revision || verifiedRevision.writerId !== writerId ||
      verifiedRevision.fencingToken !== renewedLease.fencingToken || verifiedRevision.deleted !== (selected === null)) {
      throw new LocalSaveConflictResolutionError("verification-failed", "所选版本写入后的逐字读回校验失败；冲突副本未清理，可以安全重试。", true);
    }
    if (resolution === "candidate" && selected !== null) {
      const verifiedIntegrity = inspectSaveEnvelopeChecksum(verifiedValue as string);
      if (verifiedIntegrity.status === "invalid" || inspectedEnvelopeMode(verifiedIntegrity) !== modeFromKey(conflict.saveKey)) {
        throw new LocalSaveConflictResolutionError("verification-failed", "所选版本读回后的 checksum 或模式校验失败；冲突副本未清理。", true);
      }
    }

    const finalizedAt = Date.now();
    transaction = database.transaction(RECORD_STORE, "readwrite");
    done = transactionDone(transaction);
    const cleanupStore = transaction.objectStore(RECORD_STORE);
    const cleanupLeaseRecord = await requestResult(cleanupStore.get(LOCAL_SAVE_WRITER_LEASE_KEY) as IDBRequest<StoredSaveRecord | undefined>);
    const cleanupLease = renewOwnedLocalSaveWriterLease(
      parseLocalSaveWriterLease(cleanupLeaseRecord?.value),
      writerId,
      renewedLease.fencingToken,
      finalizedAt,
    );
    if (!cleanupLease) {
      throw new LocalSaveConflictResolutionError("lease-lost", "读回校验已经通过，但清理冲突副本前写入权发生变化；副本保持不变，请重试。", true);
    }
    putStoredValue(cleanupStore, LOCAL_SAVE_WRITER_LEASE_KEY, JSON.stringify(cleanupLease), finalizedAt);
    const latestConflictRecord = await requestResult(cleanupStore.get(localSaveConflictMetadataKey(conflictId)) as IDBRequest<StoredSaveRecord | undefined>);
    const latestConflict = parseLocalSaveConflictRecord(latestConflictRecord?.value);
    const latestPrimary = await requestResult(cleanupStore.get(conflict.saveKey) as IDBRequest<StoredSaveRecord | undefined>);
    const latestRevisionRecord = await requestResult(cleanupStore.get(localSaveRevisionKey(conflict.saveKey)) as IDBRequest<StoredSaveRecord | undefined>);
    const latestRevision = parseLocalSaveRevision(latestRevisionRecord?.value);
    if (!latestConflict || latestConflict.resolvedAt !== undefined || (latestPrimary?.value ?? null) !== selected ||
      !latestRevision || latestRevision.revision !== verifiedRevision.revision || latestRevision.writerId !== writerId ||
      latestRevision.fencingToken !== cleanupLease.fencingToken) {
      throw new LocalSaveConflictResolutionError("verification-failed", "最终提交检查发现存档状态已经变化；冲突副本保持不变。", true);
    }
    cleanupStore.delete(conflict.candidateKey);
    cleanupStore.delete(conflict.persistedKey);
    cleanupStore.delete(localSaveCatalogRecordKey(conflict.candidateKey));
    cleanupStore.delete(localSaveCatalogRecordKey(conflict.persistedKey));
    putStoredValue(cleanupStore, localSaveConflictMetadataKey(conflictId), JSON.stringify({ ...latestConflict, resolvedAt: finalizedAt, resolution }), finalizedAt);
    await done;
    transaction = null;
    done = null;

    revisionCache.set(conflict.saveKey, verifiedRevision.revision);
    if (selected === null) {
      cache.delete(conflict.saveKey);
      removeStorageEntry(conflict.saveKey);
    } else putCacheValue(conflict.saveKey, selected, verifiedRecord?.updatedAt ?? finalizedAt);
    startupConflictId = null;
    startupConflictCreatedAt = -1;
    await reloadLocalSaveCache();
    publishWriterStatus({
      role: "primary",
      writerId,
      fencingToken: cleanupLease.fencingToken,
      leaseExpiresAt: cleanupLease.expiresAt,
      reason: resolution === "candidate" ? "候选存档已逐字验证并采用" : "当前持久存档已逐字验证并保留",
    });
    postCoordinationMessage({
      schemaVersion: 1,
      type: selected === null ? "deleted" : "saved",
      writerId,
      sentAt: finalizedAt,
      key: conflict.saveKey,
      revision: verifiedRevision.revision,
      fencingToken: verifiedRevision.fencingToken,
    });
    const identity = inspectLocalSaveIdentity(selected);
    await releaseWriterLeaseForReload();
    return {
      ok: true,
      resolution,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      savedAt: identity.savedAt,
      checksum: identity.checksum,
    };
  } catch (error) {
    if (transaction) {
      try { transaction.abort(); } catch { /* transaction may already be complete */ }
    }
    if (done) void done.catch(() => undefined);
    return conflictResolutionFailure(startedAt, error);
  }
}

export async function resolveLocalSaveConflict(
  conflictId: string,
  resolution: "candidate" | "persisted",
): Promise<boolean> {
  return (await resolveLocalSaveConflictDetailed(conflictId, resolution)).ok;
}

export function getLocalSaveBackend(): LocalSaveBackend {
  return backend;
}

export function getLocalSaveValue(key: string): string | null {
  ensureSynchronousFallback();
  if (backend === "local-storage") return window.localStorage.getItem(key);
  return cache.get(key) ?? null;
}

export function listLocalSaveKeys(): string[] {
  ensureSynchronousFallback();
  if (backend === "local-storage") return Object.keys(window.localStorage).filter(isSaveKey);
  return [...new Set([...knownSaveKeys, ...[...cache.keys()].filter(isSaveKey)])];
}

function provisionalCatalog(key: string): LocalSaveCatalog {
  const mode = modeFromKey(key);
  const slot = slotFromKey(key);
  const category = classifySaveRecord(key, JSON.stringify({ savedAt: 0, mode, slot }));
  return {
    schemaVersion: 1,
    key,
    mode,
    kind: category.category === "backup" ? "backup" : category.category === "slot" ? "slot" :
      category.category === "automatic-snapshot" || category.category === "manual-snapshot" ? "snapshot" :
        category.category === "protected" ? "protected" : category.category === "import-cache" ? "import-cache" : "primary",
    slot,
    savedAt: 0,
    byteLength: 0,
    payloadChecksum: "00000000",
    revision: revisionCache.get(key) ?? 0,
    stateVersion: 0,
    entityCount: 0,
    beltCount: 0,
    elapsedSeconds: 0,
    completedTechCount: 0,
    activePlanetId: "home",
    structurePoints: 0,
    integrity: "missing",
    stateChecksum: null,
    reason: null,
    settings: null,
  };
}

/** Small startup-safe metadata; never hydrates the corresponding payload. */
export function getLocalSaveCatalog(key: string): LocalSaveCatalog | null {
  ensureSynchronousFallback();
  if (backend === "local-storage") {
    const value = window.localStorage.getItem(key);
    if (value === null) {
      cache.delete(key);
      knownSaveKeys.delete(key);
      catalogCache.delete(key);
      removeStorageEntry(key);
      return null;
    }
    if (cache.get(key) !== value) putCacheValue(key, value);
  }
  const catalog = catalogCache.get(key);
  if (catalog) return structuredClone(catalog);
  return listLocalSaveKeys().includes(key) && isCatalogedSaveKey(key) ? provisionalCatalog(key) : null;
}

export function listLocalSaveCatalogs(): LocalSaveCatalog[] {
  return listLocalSaveKeys().filter(isCatalogedSaveKey).map((key) => getLocalSaveCatalog(key)!).filter(Boolean);
}

/** Read one selected payload without retaining it in the menu cache. */
export async function readLocalSavePayload(key: string): Promise<string | null> {
  await initializeLocalSaveStore();
  let value: string | null;
  if (backend === "indexeddb" && database) {
    value = (await readRecord(database, key))?.value ?? null;
  }
  else if (backend === "local-storage") value = window.localStorage.getItem(key);
  else value = cache.get(key) ?? null;
  if (value === null) return null;
  const catalog = catalogCache.get(key);
  if (catalog?.integrity === "invalid") return null;
  return value;
}

/** Keep a user-selected payload available to synchronous lifecycle saves. */
export function retainLocalSavePayload(key: string, value: string): boolean {
  cache.delete(key);
  cache.set(key, value);
  knownSaveKeys.add(key);
  if (backend === "indexeddb") trimRawCache();
  return true;
}

export function getLocalSaveRawCacheSize(): number {
  return [...cache.entries()].filter(([key]) => isCatalogedSaveKey(key)).length;
}

function enqueue(operation: () => Promise<void>, key?: string): void {
  writeQueue = writeQueue.catch(() => undefined).then(operation).catch((error) => {
    pendingWriteError ??= error;
    if (key && isQuotaExceededError(error)) recordQuotaRecoveryPrompt(key);
  });
}

export function setLocalSaveValue(key: string, value: string): void {
  if (!isSaveKey(key)) throw new Error(`Unsupported local save key: ${key}`);
  ensureSynchronousFallback();
  if (writerStatus.role !== "primary") throw new LocalSaveReadOnlyError(writerStatus.reason);
  if (backend === "indexeddb" && database) {
    const baseValue = cache.get(key) ?? null;
    const baseKnown = knownSaveKeys.has(key);
    const baseCatalog = catalogCache.get(key) ?? null;
    const expectedRevision = revisionCache.get(key) ?? 0;
    putCacheValue(key, value);
    revisionCache.set(key, expectedRevision + 1);
    enqueue(() => commitCoordinatedRecord(database!, key, value, baseValue, baseKnown, baseCatalog, expectedRevision).then(() => {
      clearRecoveredQuotaPrompt(key);
      const summary = classifySaveRecord(key, value);
      if (summary.category === "automatic-snapshot") enforceAutomaticSnapshotLimit(summary.mode);
    }).catch((error) => {
      if (!(error instanceof LocalSaveConflictError)) restoreCachedValueAfterFailedCommit(key, baseValue, baseKnown, baseCatalog, expectedRevision);
      throw error;
    }), key);
    if (preserveDevelopmentMirror()) {
      try { window.localStorage.setItem(key, value); } catch { /* test-only mirror */ }
    }
    return;
  }
  if (backend === "local-storage") {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      if (isQuotaExceededError(error)) recordQuotaRecoveryPrompt(key);
      throw error;
    }
  }
  putCacheValue(key, value);
  const summary = classifySaveRecord(key, value);
  if (summary.category === "automatic-snapshot") enforceAutomaticSnapshotLimit(summary.mode);
  clearRecoveredQuotaPrompt(key);
}

export function removeLocalSaveValue(key: string): void {
  if (!isSaveKey(key)) return;
  ensureSynchronousFallback();
  if (writerStatus.role !== "primary") throw new LocalSaveReadOnlyError(writerStatus.reason);
  if (backend === "indexeddb" && database) {
    const baseValue = cache.get(key) ?? null;
    const baseKnown = knownSaveKeys.has(key);
    const baseCatalog = catalogCache.get(key) ?? null;
    const expectedRevision = revisionCache.get(key) ?? 0;
    cache.delete(key);
    knownSaveKeys.delete(key);
    catalogCache.delete(key);
    revisionCache.set(key, expectedRevision + 1);
    enqueue(() => commitCoordinatedRecord(database!, key, null, baseValue, baseKnown, baseCatalog, expectedRevision).then(() => undefined).catch((error) => {
      if (!(error instanceof LocalSaveConflictError)) restoreCachedValueAfterFailedCommit(key, baseValue, baseKnown, baseCatalog, expectedRevision);
      throw error;
    }), key);
    if (preserveDevelopmentMirror()) {
      try { window.localStorage.removeItem(key); } catch { /* test-only mirror */ }
    }
    return;
  }
  cache.delete(key);
  knownSaveKeys.delete(key);
  catalogCache.delete(key);
  removeStorageEntry(key);
  if (backend === "local-storage") window.localStorage.removeItem(key);
}

export function writePrimarySaveEmergencyMirror(value: string): boolean {
  ensureSynchronousFallback();
  if (backend !== "indexeddb" || writerStatus.role !== "primary") return false;
  try {
    let mode: LocalSaveMode = "normal";
    try {
      const parsed = JSON.parse(value) as { mode?: unknown; state?: { mode?: unknown } };
      mode = parsed.mode === "speedrun" || parsed.state?.mode === "speedrun" ? "speedrun" : "normal";
    } catch { /* checksum validation happens at commit */ }
    const key = primaryKeyForMode(mode);
    const keys = localSaveEmergencyMirrorKeys(mode);
    const identity = inspectLocalSaveIdentity(value);
    const metadata = {
      schemaVersion: 1,
      mode,
      saveKey: key,
      writerId,
      fencingToken: writerStatus.fencingToken,
      candidateRevision: revisionCache.get(key) ?? 1,
      savedAt: identity.savedAt,
      checksum: identity.checksum,
      createdAt: Date.now(),
    } as const;
    window.localStorage.setItem(keys.payload, value);
    window.localStorage.setItem(keys.metadata, JSON.stringify(metadata));
    return window.localStorage.getItem(keys.payload) === value &&
      parseLocalSaveEmergencyMirrorMetadata(window.localStorage.getItem(keys.metadata)) !== null;
  } catch {
    return false;
  }
}

export function clearPrimarySaveEmergencyMirror(committedValue: string): void {
  ensureSynchronousFallback();
  if (backend !== "indexeddb" || preserveDevelopmentMirror()) return;
  try {
    let mode: LocalSaveMode = "normal";
    try {
      const parsed = JSON.parse(committedValue) as { mode?: unknown; state?: { mode?: unknown } };
      mode = parsed.mode === "speedrun" || parsed.state?.mode === "speedrun" ? "speedrun" : "normal";
    } catch { /* keep normal fallback */ }
    const mirror = readEmergencyMirror(mode);
    if (mirror) {
      const samePayload = mirror.payload === committedValue;
      const sameWriterChain = mirror.metadata?.writerId === writerId &&
        mirror.metadata.fencingToken === writerStatus.fencingToken;
      if (samePayload || sameWriterChain && savedAt(mirror.payload) <= savedAt(committedValue)) {
        clearEmergencyMirror(mode);
      }
    }
    // Remove the pre-1.0.40 speedrun emergency key after its content is known
    // to be no newer than the committed primary. Old readers remain supported.
    if (mode === "speedrun") {
      const legacyKey = `${SAVE_KEY}.speedrun.emergency`;
      const legacy = getLocalSaveValue(legacyKey);
      if (legacy !== null && savedAt(legacy) <= savedAt(committedValue)) removeLocalSaveValue(legacyKey);
    }
  } catch {
    // A stale mirror is harmless and will be reconciled on the next startup.
  }
}

export async function flushLocalSaveWrites(): Promise<void> {
  await writeQueue;
  const error = pendingWriteError;
  pendingWriteError = null;
  if (error) {
    if (isQuotaExceededError(error)) {
      if (!recoveryPrompt) recordQuotaRecoveryPrompt(primaryKeyForMode("normal"));
    }
    throw error;
  }
}

export async function readPersistedLocalSaveValue(key: string): Promise<string | null> {
  await initializeLocalSaveStore();
  if (backend === "indexeddb" && database) return (await readRecord(database, key))?.value ?? null;
  if (backend === "local-storage") return window.localStorage.getItem(key);
  return cache.get(key) ?? null;
}

export async function reloadLocalSaveCache(): Promise<void> {
  if (backend !== "indexeddb" || !database) return;
  cache.clear();
  knownSaveKeys.clear();
  catalogCache.clear();
  revisionCache.clear();
  storageEntryCache.clear();
  const keys = await readAllStoredKeys(database);
  for (const key of keys) if (isSaveKey(key)) knownSaveKeys.add(key);
  const records = await readStoredRecordsByKey(database, keys.filter((key) =>
    !isSaveKey(key) || key.endsWith(".snapshot.sequence") || key.endsWith(".snapshot.speedrun.sequence"),
  ));
  const catalogs: LocalSaveCatalog[] = [];
  for (const record of records) {
    const payloadKey = payloadKeyFromLocalSaveCatalogRecord(record.key);
    if (payloadKey) {
      const catalog = parseLocalSaveCatalog(record.value, payloadKey);
      if (catalog) catalogs.push(catalog);
      continue;
    }
    if (record.key.endsWith(".snapshot.sequence") || record.key.endsWith(".snapshot.speedrun.sequence")) cache.set(record.key, record.value);
    if (record.key.startsWith(LOCAL_SAVE_REVISION_KEY_PREFIX)) {
      const revision = parseLocalSaveRevision(record.value);
      if (revision) revisionCache.set(revision.saveKey, revision.revision);
    }
  }
  for (const catalog of catalogs) {
    if (!knownSaveKeys.has(catalog.key) || catalog.revision !== (revisionCache.get(catalog.key) ?? 0)) continue;
    catalogCache.set(catalog.key, catalog);
    updateStorageEntryFromCatalog(catalog, recordUpdatedAt(records, localSaveCatalogRecordKey(catalog.key), catalog.savedAt));
  }
  legacyCatalogIndexQueue = [...knownSaveKeys].filter((key) => isCatalogedSaveKey(key) && !catalogCache.has(key));
  scheduleLegacyCatalogIndex();
  notifyStorageStatus();
}

function entryLabel(key: string, summary: StoredSaveSummary): string {
  const modeLabel = summary.mode === "speedrun" ? "速通模式" : "普通模式";
  if (key.startsWith(LOCAL_SAVE_CONFLICT_KEY_PREFIX)) return key.endsWith(".candidate") ? `${modeLabel}跨标签冲突：本页候选` : `${modeLabel}跨标签冲突：原持久版本`;
  if (key === SAVE_KEY || key === `${SAVE_KEY}.normal` || key === `${SAVE_KEY}.speedrun`) return `${modeLabel}主存档`;
  if (key === `${SAVE_KEY}.backup` || key === `${SAVE_KEY}.backup.speedrun`) return `${modeLabel}上一版本备份`;
  if (key.startsWith(`${SAVE_KEY}.migration-backup.`)) return "普通模式迁移前原始备份";
  if (key.startsWith(IMPORT_CACHE_KEY_PREFIX)) return `${modeLabel}导入缓存`;
  if (key.startsWith(SLOT_KEY_PREFIX)) {
    return `${modeLabel}手动槽位 ${summary.slot ?? "--"}`;
  }
  if (key.includes(".snapshot.")) {
    if (summary.category === "protected") return `${modeLabel}保护快照：${summary.reason ?? "来源无法识别"}`;
    return `${modeLabel}${summary.automatic ? "自动恢复快照" : `手动快照：${summary.reason ?? "未命名"}`}`;
  }
  return key;
}

function emptyModeUsage(mode: LocalSaveMode): LocalSaveModeStorageUsage {
  return {
    mode,
    totalBytes: 0,
    primaryBytes: 0,
    backupBytes: 0,
    slotBytes: 0,
    automaticSnapshotBytes: 0,
    manualSnapshotBytes: 0,
    protectedBytes: 0,
    importCacheBytes: 0,
    slotCount: 0,
    automaticSnapshotCount: 0,
    manualSnapshotCount: 0,
    protectedCount: 0,
    importCacheCount: 0,
  };
}

function summarizeModes(entries: LocalSaveStorageEntry[]): LocalSaveModeStorageUsage[] {
  const modes = new Map<LocalSaveMode, LocalSaveModeStorageUsage>([
    ["normal", emptyModeUsage("normal")],
    ["speedrun", emptyModeUsage("speedrun")],
  ]);
  for (const entry of entries) {
    const usage = modes.get(entry.mode)!;
    usage.totalBytes += entry.bytes;
    if (entry.category === "primary") usage.primaryBytes += entry.bytes;
    else if (entry.category === "backup") usage.backupBytes += entry.bytes;
    else if (entry.category === "slot") { usage.slotBytes += entry.bytes; usage.slotCount += 1; }
    else if (entry.category === "automatic-snapshot") { usage.automaticSnapshotBytes += entry.bytes; usage.automaticSnapshotCount += 1; }
    else if (entry.category === "manual-snapshot") { usage.manualSnapshotBytes += entry.bytes; usage.manualSnapshotCount += 1; }
    else if (entry.category === "protected") { usage.protectedBytes += entry.bytes; usage.protectedCount += 1; }
    else if (entry.category === "import-cache") { usage.importCacheBytes += entry.bytes; usage.importCacheCount += 1; }
  }
  return [...modes.values()];
}

async function inspectPersistenceStatus(): Promise<{ status: LocalSavePersistenceStatus; requestSupported: boolean }> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage || typeof storage.persisted !== "function") {
    lastPersistenceStatus = "unsupported";
    return { status: "unsupported", requestSupported: false };
  }
  try {
    const granted = await storage.persisted();
    if (granted) lastPersistenceStatus = "granted";
    return {
      status: granted ? "granted" : lastPersistenceStatus === "denied" ? "denied" : "not-granted",
      requestSupported: typeof storage.persist === "function",
    };
  } catch {
    lastPersistenceStatus = "unsupported";
    return { status: "unsupported", requestSupported: false };
  }
}

function pressureFor(usage: number | null, quota: number | null): LocalSaveStoragePressure {
  if (usage === null || quota === null || quota <= 0) return "unknown";
  const ratio = usage / quota;
  return ratio >= 0.95 ? "critical" : ratio >= 0.8 ? "high" : "normal";
}

export function subscribeLocalSaveStorageStatus(listener: () => void): () => void {
  storageStatusListeners.add(listener);
  return () => storageStatusListeners.delete(listener);
}

export async function requestLocalSavePersistentStorage(): Promise<LocalSavePersistenceStatus> {
  await initializeLocalSaveStore();
  if (backend === "memory") {
    lastPersistenceStatus = "unsupported";
    return "unsupported";
  }
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage || typeof storage.persist !== "function") {
    lastPersistenceStatus = "unsupported";
    return "unsupported";
  }
  try {
    const granted = await storage.persist();
    lastPersistenceStatus = granted ? "granted" : "denied";
    notifyStorageStatus();
    return granted ? "granted" : "denied";
  } catch {
    lastPersistenceStatus = "denied";
    notifyStorageStatus();
    return "denied";
  }
}

export function dismissLocalSaveRecoveryPrompt(): void {
  recoveryPrompt = null;
  notifyStorageStatus();
}

export async function deleteLocalSaveManagedEntries(keys: string[]): Promise<{ removed: string[]; failed: string[]; blocked: string[] }> {
  await initializeLocalSaveStore();
  const removed: string[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];
  const uniqueKeys = [...new Set(keys)];
  for (const key of uniqueKeys) {
    const entry = storageEntryCache.get(key);
    const deletable = entry?.category === "manual-snapshot" || entry?.category === "import-cache" ||
      entry?.category === "protected" && entry.key.includes(".snapshot.");
    if (!entry || !deletable) {
      blocked.push(key);
      continue;
    }
    try {
      removeLocalSaveValue(key);
    } catch {
      failed.push(key);
    }
  }
  try {
    await flushLocalSaveWrites();
  } catch {
    // Exact per-key persistence checks below determine the result.
  }
  for (const key of uniqueKeys) {
    if (blocked.includes(key) || failed.includes(key)) continue;
    if (await readPersistedLocalSaveValue(key) === null) removed.push(key);
    else failed.push(key);
  }
  if (failed.length > 0) await reloadLocalSaveCache().catch(() => undefined);
  notifyStorageStatus();
  return { removed, failed, blocked };
}

export async function getLocalSaveStorageEstimate(): Promise<LocalSaveStorageEstimate> {
  await initializeLocalSaveStore();
  let browserUsageBytes: number | null = null;
  let browserQuotaBytes: number | null = null;
  try {
    const estimate = await navigator.storage?.estimate?.();
    browserUsageBytes = typeof estimate?.usage === "number" ? estimate.usage : null;
    browserQuotaBytes = typeof estimate?.quota === "number" ? estimate.quota : null;
  } catch {
    // Some embedded browsers do not expose quota estimates.
  }
  const persistence = backend === "memory"
    ? { status: "unsupported" as const, requestSupported: false }
    : await inspectPersistenceStatus();
  const entries = [...storageEntryCache.values()]
    .map(({ checksum: _checksum, ...entry }) => entry)
    .sort((left, right) => left.mode.localeCompare(right.mode) || Number(right.protected) - Number(left.protected) || right.savedAt - left.savedAt || left.key.localeCompare(right.key));
  const modes = summarizeModes(entries);
  const warnings: string[] = [];
  for (const usage of modes) {
    const managedCount = usage.manualSnapshotCount + usage.protectedCount;
    const managedBytes = usage.manualSnapshotBytes + usage.protectedBytes;
    if (managedCount >= MANAGED_SNAPSHOT_WARNING_COUNT || managedBytes >= MANAGED_SNAPSHOT_WARNING_BYTES) {
      warnings.push(`${usage.mode === "speedrun" ? "速通" : "普通"}模式有 ${managedCount} 份手动/保护快照（${Math.ceil(managedBytes / 1024 / 1024)} MiB），请由玩家选择是否清理；系统不会自动删除。`);
    }
    if (usage.automaticSnapshotCount > LOCAL_AUTOMATIC_SNAPSHOT_LIMIT) {
      warnings.push(`${usage.mode === "speedrun" ? "速通" : "普通"}模式自动快照超过 ${LOCAL_AUTOMATIC_SNAPSHOT_LIMIT} 份，下一次写入会只清理该模式的旧自动快照。`);
    }
  }
  const pressure = pressureFor(browserUsageBytes, browserQuotaBytes);
  if (pressure === "high") warnings.push("浏览器存储占用已超过 80%，建议导出存档并检查快照占用。");
  if (pressure === "critical") warnings.push("浏览器存储占用已超过 95%，请立即导出存档并释放空间。");
  return {
    backend,
    payloadBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    browserUsageBytes,
    browserQuotaBytes,
    persistenceStatus: persistence.status,
    persistenceRequestSupported: persistence.requestSupported,
    pressure,
    modes,
    warnings,
    recoveryPrompt,
    entries,
  };
}

export async function hasLocalSaveCapacity(key: string, nextValue: string): Promise<{ ok: boolean; requiredBytes: number; availableBytes: number | null }> {
  const requiredBytes = Math.max(0, byteLength(nextValue) - (storageEntryCache.get(key)?.bytes ?? 0));
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (typeof estimate?.quota !== "number" || typeof estimate.usage !== "number") return { ok: true, requiredBytes, availableBytes: null };
    const availableBytes = Math.max(0, estimate.quota - estimate.usage);
    return { ok: requiredBytes + 256 * 1024 <= availableBytes, requiredBytes, availableBytes };
  } catch {
    return { ok: true, requiredBytes, availableBytes: null };
  }
}
