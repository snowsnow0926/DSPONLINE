import type { PureIdleMacroMode, PureIdleMacroPhase, PureIdleMacroSummary } from "./pureIdleMacro";
import type { GameState } from "./types";

const DATABASE_NAME = "dsp-idle-network.pure-idle-recovery";
const DATABASE_VERSION = 1;
const STORE_NAME = "records";
const CHECKPOINT_KEY = "checkpoint";
const HEARTBEAT_KEY = "heartbeat";
const OWNER_SESSION_KEY = "dsp-idle-network.pure-idle-owner.v1";
const RECOVERY_SCHEMA_VERSION = 2;
const LEASE_DURATION_MS = 15_000;

export const PURE_IDLE_BACKGROUND_GRACE_SECONDS = 5 * 60;

interface PureIdleCheckpointRecord {
  key: typeof CHECKPOINT_KEY;
  schemaVersion: 1 | typeof RECOVERY_SCHEMA_VERSION;
  sessionId: string;
  createdAtMs: number;
  startedAtMs: number;
  /** UI/runtime state only; never changes the persisted GameState schema. */
  startedPaused?: boolean;
  mode: PureIdleMacroMode;
  state: GameState;
}

interface PureIdleHeartbeatRecord {
  key: typeof HEARTBEAT_KEY;
  schemaVersion: 1 | typeof RECOVERY_SCHEMA_VERSION;
  sessionId: string;
  ownerToken: string;
  heartbeatAtMs: number;
  leaseExpiresAtMs: number;
  settledWallSeconds: number;
  phase: PureIdleMacroPhase;
  backgroundStartedAtMs?: number;
  summary?: PureIdleMacroSummary;
  lastError?: string;
  /** Session-only Worker supervision state; never enters GameState. */
  workerRestartCount?: number;
  /** Diagnostics only. No save body or player content is stored here. */
  settlementId?: string;
  checkpointHash?: string;
  stopReason?: PureIdleStopReason;
  stopRequestedAtMs?: number;
  targetWallSeconds?: number;
  finalizedAtMs?: number;
  committedAtMs?: number;
  abandonedWallSeconds?: number;
  committed?: boolean;
  lastTransitionAtMs?: number;
}

export type PureIdleStopReason =
  | "user-stop-requested"
  | "background-grace-expired"
  | "worker-timeout"
  | "worker-crash"
  | "worker-error"
  | "save-finalized"
  | "user-cancelled";

export interface PureIdleRecoveryRecord {
  sessionId: string;
  createdAtMs: number;
  startedAtMs: number;
  startedPaused: boolean;
  mode: PureIdleMacroMode;
  state: GameState;
  ownerToken: string;
  heartbeatAtMs: number;
  leaseExpiresAtMs: number;
  settledWallSeconds: number;
  phase: PureIdleMacroPhase;
  backgroundStartedAtMs?: number;
  summary?: PureIdleMacroSummary;
  lastError?: string;
  workerRestartCount: number;
  settlementId: string;
  checkpointHash: string;
  stopReason?: PureIdleStopReason;
  stopRequestedAtMs?: number;
  targetWallSeconds?: number;
  finalizedAtMs?: number;
  committedAtMs?: number;
  abandonedWallSeconds?: number;
  committed: boolean;
  lastTransitionAtMs: number;
}

export interface PureIdleRecoveryTransition {
  stopReason: PureIdleStopReason;
  phase?: PureIdleMacroPhase;
  stopRequestedAtMs?: number;
  targetWallSeconds?: number;
  finalizedAtMs?: number;
  committedAtMs?: number;
  abandonedWallSeconds?: number;
  committed?: boolean;
  lastError?: string;
}

export interface PureIdleBackgroundPlan {
  backgrounded: boolean;
  totalWallSeconds: number;
  highWallSeconds: number;
  normalOfflineSeconds: number;
  graceExpired: boolean;
}

export const PURE_IDLE_WORKER_RESTART_LIMIT = 2;

export function getPureIdleForceConservativeReason(
  record: Pick<PureIdleRecoveryRecord, "workerRestartCount" | "summary">,
  observedRestartCount = record.workerRestartCount,
): string | undefined {
  if (record.summary?.conservativeOnly) {
    return record.summary.degradedReason ?? "恢复记录已处于保守宏观模式";
  }
  const restartCount = Math.max(record.workerRestartCount, Math.max(0, Math.floor(observedRestartCount)));
  return restartCount >= PURE_IDLE_WORKER_RESTART_LIMIT
    ? `连续 ${PURE_IDLE_WORKER_RESTART_LIMIT} 次 Worker 失败，已停止精确重建`
    : undefined;
}

export type PureIdleRecoveryClaim =
  | { ok: true; record: PureIdleRecoveryRecord }
  | { ok: false; reason: "unavailable" | "missing" | "owned" | "invalid"; message: string };

export type PureIdleRecoveryInspection =
  | { status: "valid"; record: PureIdleRecoveryRecord; message: string }
  | { status: "committed"; record: PureIdleRecoveryRecord; message: string }
  | { status: "missing" | "invalid" | "unavailable"; record: null; message: string };

let databasePromise: Promise<IDBDatabase> | null = null;
let heldBrowserLease: { ownerToken: string; release: () => void } | null = null;

/**
 * IndexedDB remains the durable source of truth. Web Locks adds a process
 * lifetime guard where available, including duplicated tabs that can inherit
 * the same sessionStorage token before the 15-second durable lease expires.
 */
async function acquireBrowserLease(ownerToken: string): Promise<boolean> {
  if (heldBrowserLease?.ownerToken === ownerToken) return true;
  if (heldBrowserLease) return false;
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return true;
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    void locks.request("dsp-idle-network.pure-idle.v1", { mode: "exclusive", ifAvailable: true }, (lock) => {
      if (!lock) {
        resolved = true;
        resolve(false);
        return;
      }
      let release!: () => void;
      const lifetime = new Promise<void>((finish) => { release = finish; });
      heldBrowserLease = {
        ownerToken,
        release: () => {
          if (heldBrowserLease?.ownerToken === ownerToken) heldBrowserLease = null;
          release();
        },
      };
      resolved = true;
      resolve(true);
      return lifetime;
    }).catch(() => {
      // Browser lock support is optional. The durable IndexedDB lease still
      // provides cross-tab protection when a platform rejects Web Locks.
      if (!resolved) resolve(true);
    });
  });
}

function releaseBrowserLease(ownerToken: string): void {
  if (heldBrowserLease?.ownerToken === ownerToken) heldBrowserLease.release();
}

function randomToken(prefix: string): string {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  }
}

function checkpointFingerprint(state: GameState): string {
  const firstEntity = state.entities[0]?.id ?? "";
  const lastEntity = state.entities.at(-1)?.id ?? "";
  const firstBelt = state.belts[0]?.id ?? "";
  const lastBelt = state.belts.at(-1)?.id ?? "";
  const source = [
    state.version,
    state.elapsedSeconds,
    state.entities.length,
    state.belts.length,
    firstEntity,
    lastEntity,
    firstBelt,
    lastBelt,
    state.dysonSphere.structurePoints,
    state.dysonSphere.totalRocketsLaunched,
    state.totalProduced.universe_matrix ?? 0,
  ].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `checkpoint-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isRecoveryHistorySample(value: unknown): value is GameState["productionHistory"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sample = value as Record<string, unknown>;
  return typeof sample.elapsedSeconds === "number" && Number.isFinite(sample.elapsedSeconds) &&
    sample.elapsedSeconds >= 0 &&
    Boolean(sample.productionPerMinute && typeof sample.productionPerMinute === "object" && !Array.isArray(sample.productionPerMinute)) &&
    Boolean(sample.consumptionPerMinute && typeof sample.consumptionPerMinute === "object" && !Array.isArray(sample.consumptionPerMinute)) &&
    Boolean(sample.inventory && typeof sample.inventory === "object" && !Array.isArray(sample.inventory));
}

/**
 * Production history is normally display telemetry; the opt-in replication
 * mode reads only its small cumulative snapshots. Older runtime journals can
 * contain JSON nulls from sparse array slots, so keep their gameplay checkpoint
 * usable by dropping only invalid telemetry before the macro Worker receives it.
 */
function sanitizePureIdleRecoveryState(state: GameState): GameState {
  const originalHistory = state.productionHistory;
  if (!Array.isArray(originalHistory)) return { ...state, productionHistory: [] };
  const productionHistory = originalHistory.filter(isRecoveryHistorySample);
  return productionHistory.length === originalHistory.length ? state : { ...state, productionHistory };
}

export function matchesPureIdleRecoveryCheckpoint(
  record: Pick<PureIdleRecoveryRecord, "checkpointHash">,
  state: GameState,
): boolean {
  return record.checkpointHash === checkpointFingerprint(state);
}

export function getPureIdleOwnerToken(): string {
  try {
    const existing = window.sessionStorage.getItem(OWNER_SESSION_KEY);
    if (existing) return existing;
    const token = randomToken("owner");
    window.sessionStorage.setItem(OWNER_SESSION_KEY, token);
    return token;
  } catch {
    return randomToken("owner");
  }
}

export function canUsePureIdleRecovery(): boolean {
  return typeof window !== "undefined" && Boolean(window.indexedDB);
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!canUsePureIdleRecovery()) {
      reject(new Error("当前环境不支持 IndexedDB 恢复日志"));
      return;
    }
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开纯挂机恢复日志"));
    request.onblocked = () => reject(new Error("纯挂机恢复日志升级被其他标签页阻塞"));
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise!;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("恢复日志事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("恢复日志事务已中止"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("恢复日志读取失败"));
  });
}

function validCheckpoint(value: unknown): value is PureIdleCheckpointRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PureIdleCheckpointRecord>;
  return record.key === CHECKPOINT_KEY && (record.schemaVersion === 1 || record.schemaVersion === RECOVERY_SCHEMA_VERSION) &&
    typeof record.sessionId === "string" && record.sessionId.length > 0 &&
    typeof record.startedAtMs === "number" && Number.isFinite(record.startedAtMs) &&
    (record.startedPaused === undefined || typeof record.startedPaused === "boolean") &&
    (record.mode === "stable" || record.mode === "extreme" || record.mode === "replication") && Boolean(record.state && typeof record.state === "object");
}

function validHeartbeat(value: unknown): value is PureIdleHeartbeatRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PureIdleHeartbeatRecord>;
  const validOptionalTimestamp = (value: unknown) => value === undefined || typeof value === "number" && Number.isFinite(value);
  const validStopReason = record.stopReason === undefined || [
    "user-stop-requested",
    "background-grace-expired",
    "worker-timeout",
    "worker-crash",
    "worker-error",
    "save-finalized",
    "user-cancelled",
  ].includes(record.stopReason);
  return record.key === HEARTBEAT_KEY && (record.schemaVersion === 1 || record.schemaVersion === RECOVERY_SCHEMA_VERSION) &&
    typeof record.sessionId === "string" && typeof record.ownerToken === "string" &&
    typeof record.heartbeatAtMs === "number" && Number.isFinite(record.heartbeatAtMs) &&
    typeof record.leaseExpiresAtMs === "number" && Number.isFinite(record.leaseExpiresAtMs) &&
    typeof record.settledWallSeconds === "number" && Number.isFinite(record.settledWallSeconds) && record.settledWallSeconds >= 0 &&
    (record.workerRestartCount === undefined || (Number.isSafeInteger(record.workerRestartCount) && record.workerRestartCount >= 0)) &&
    (record.backgroundStartedAtMs === undefined || (typeof record.backgroundStartedAtMs === "number" && Number.isFinite(record.backgroundStartedAtMs))) &&
    (record.settlementId === undefined || typeof record.settlementId === "string" && record.settlementId.length > 0) &&
    (record.checkpointHash === undefined || typeof record.checkpointHash === "string" && /^checkpoint-[0-9a-f]{8}$/.test(record.checkpointHash)) &&
    validStopReason && validOptionalTimestamp(record.stopRequestedAtMs) &&
    (record.targetWallSeconds === undefined || typeof record.targetWallSeconds === "number" && Number.isFinite(record.targetWallSeconds) && record.targetWallSeconds >= 0) &&
    validOptionalTimestamp(record.finalizedAtMs) &&
    validOptionalTimestamp(record.committedAtMs) && validOptionalTimestamp(record.lastTransitionAtMs) &&
    (record.abandonedWallSeconds === undefined || typeof record.abandonedWallSeconds === "number" && Number.isFinite(record.abandonedWallSeconds) && record.abandonedWallSeconds >= 0) &&
    (record.committed === undefined || typeof record.committed === "boolean");
}

function combine(checkpoint: PureIdleCheckpointRecord, heartbeat: PureIdleHeartbeatRecord): PureIdleRecoveryRecord | null {
  if (checkpoint.sessionId !== heartbeat.sessionId) return null;
  const state = sanitizePureIdleRecoveryState(checkpoint.state);
  return {
    sessionId: checkpoint.sessionId,
    createdAtMs: checkpoint.createdAtMs,
    startedAtMs: checkpoint.startedAtMs,
    startedPaused: checkpoint.startedPaused === true,
    mode: checkpoint.mode,
    state,
    ownerToken: heartbeat.ownerToken,
    heartbeatAtMs: heartbeat.heartbeatAtMs,
    leaseExpiresAtMs: heartbeat.leaseExpiresAtMs,
    settledWallSeconds: heartbeat.settledWallSeconds,
    phase: heartbeat.phase,
    ...(heartbeat.backgroundStartedAtMs !== undefined ? { backgroundStartedAtMs: heartbeat.backgroundStartedAtMs } : {}),
    ...(heartbeat.summary ? { summary: heartbeat.summary } : {}),
    ...(heartbeat.lastError ? { lastError: heartbeat.lastError } : {}),
    workerRestartCount: Math.max(0, Math.floor(heartbeat.workerRestartCount ?? 0)),
    settlementId: heartbeat.settlementId ?? checkpoint.sessionId,
    checkpointHash: heartbeat.checkpointHash ?? checkpointFingerprint(state),
    ...(heartbeat.stopReason ? { stopReason: heartbeat.stopReason } : {}),
    ...(heartbeat.stopRequestedAtMs !== undefined ? { stopRequestedAtMs: heartbeat.stopRequestedAtMs } : {}),
    ...(heartbeat.targetWallSeconds !== undefined ? { targetWallSeconds: heartbeat.targetWallSeconds } : {}),
    ...(heartbeat.finalizedAtMs !== undefined ? { finalizedAtMs: heartbeat.finalizedAtMs } : {}),
    ...(heartbeat.committedAtMs !== undefined ? { committedAtMs: heartbeat.committedAtMs } : {}),
    ...(heartbeat.abandonedWallSeconds !== undefined ? { abandonedWallSeconds: heartbeat.abandonedWallSeconds } : {}),
    committed: heartbeat.committed === true,
    lastTransitionAtMs: heartbeat.lastTransitionAtMs ?? heartbeat.heartbeatAtMs,
  };
}

export function getPureIdleBackgroundPlan(
  record: Pick<PureIdleRecoveryRecord, "startedAtMs" | "backgroundStartedAtMs">,
  nowMs = Date.now(),
): PureIdleBackgroundPlan {
  const totalWallSeconds = Math.max(0, (nowMs - record.startedAtMs) / 1_000);
  const backgroundStartedAtMs = record.backgroundStartedAtMs;
  if (backgroundStartedAtMs === undefined || !Number.isFinite(backgroundStartedAtMs)) {
    return {
      backgrounded: false,
      totalWallSeconds,
      highWallSeconds: totalWallSeconds,
      normalOfflineSeconds: 0,
      graceExpired: false,
    };
  }
  const highWallBeforeBackground = Math.max(0, (backgroundStartedAtMs - record.startedAtMs) / 1_000);
  const highWallSeconds = Math.min(
    totalWallSeconds,
    highWallBeforeBackground + PURE_IDLE_BACKGROUND_GRACE_SECONDS,
  );
  const normalOfflineSeconds = Math.max(0, totalWallSeconds - highWallSeconds);
  return {
    backgrounded: true,
    totalWallSeconds,
    highWallSeconds,
    normalOfflineSeconds,
    graceExpired: nowMs - backgroundStartedAtMs >= PURE_IDLE_BACKGROUND_GRACE_SECONDS * 1_000,
  };
}

async function readRawPair(): Promise<{ checkpoint: unknown; heartbeat: unknown }> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const [checkpoint, heartbeat] = await Promise.all([
    requestResult(store.get(CHECKPOINT_KEY)),
    requestResult(store.get(HEARTBEAT_KEY)),
  ]);
  await done;
  return { checkpoint, heartbeat };
}

export async function readPureIdleRecovery(): Promise<PureIdleRecoveryRecord | null> {
  if (!canUsePureIdleRecovery()) return null;
  const { checkpoint, heartbeat } = await readRawPair();
  return validCheckpoint(checkpoint) && validHeartbeat(heartbeat) ? combine(checkpoint, heartbeat) : null;
}

/**
 * Distinguish an absent or malformed recovery journal from a browser/storage
 * failure. The menu uses this before touching pending time-warp debt: a valid
 * uncommitted journal keeps owning its timeline, while an unavailable journal
 * requires an explicit player decision instead of silently discarding it.
 */
export async function inspectPureIdleRecovery(): Promise<PureIdleRecoveryInspection> {
  if (!canUsePureIdleRecovery()) {
    return { status: "unavailable", record: null, message: "当前环境不支持读取纯挂机恢复日志" };
  }
  try {
    const { checkpoint, heartbeat } = await readRawPair();
    if (checkpoint === undefined && heartbeat === undefined) {
      return { status: "missing", record: null, message: "没有仍然有效的纯挂机恢复会话" };
    }
    if (!validCheckpoint(checkpoint) || !validHeartbeat(heartbeat)) {
      return { status: "invalid", record: null, message: "纯挂机恢复日志不完整或格式无效" };
    }
    const record = combine(checkpoint, heartbeat);
    if (!record) return { status: "invalid", record: null, message: "纯挂机检查点与事务日志不属于同一会话" };
    if (record.committed) {
      return { status: "committed", record, message: "纯挂机恢复事务已经提交，不会再次结算" };
    }
    return { status: "valid", record, message: "检测到仍可恢复的纯挂机会话" };
  } catch (error) {
    return {
      status: "unavailable",
      record: null,
      message: error instanceof Error && error.message ? `无法读取纯挂机恢复日志：${error.message}` : "无法读取纯挂机恢复日志",
    };
  }
}

export async function createPureIdleRecovery(
  state: GameState,
  mode: PureIdleMacroMode,
  startedAtMs: number,
  ownerToken: string,
  nowMs = Date.now(),
  startedPaused = false,
): Promise<PureIdleRecoveryClaim> {
  if (!canUsePureIdleRecovery()) {
    return { ok: false, reason: "unavailable", message: "当前环境无法建立 IndexedDB 恢复日志，已阻止纯挂机" };
  }
  if (!await acquireBrowserLease(ownerToken)) {
    return { ok: false, reason: "owned", message: "另一个标签页正在运行纯挂机，请先在原标签页停止" };
  }
  const db = await openDatabase();
  const sessionId = randomToken("idle");
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const existing = await requestResult(store.get(HEARTBEAT_KEY));
  if (validHeartbeat(existing) && existing.committed !== true && existing.ownerToken !== ownerToken && existing.leaseExpiresAtMs > nowMs) {
    transaction.abort();
    releaseBrowserLease(ownerToken);
    return { ok: false, reason: "owned", message: "另一个标签页正在运行纯挂机，请先在原标签页停止" };
  }
  const checkpointState = sanitizePureIdleRecoveryState(state);
  const checkpoint: PureIdleCheckpointRecord = {
    key: CHECKPOINT_KEY,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    sessionId,
    createdAtMs: nowMs,
    startedAtMs,
    startedPaused,
    mode,
    state: checkpointState,
  };
  const heartbeat: PureIdleHeartbeatRecord = {
    key: HEARTBEAT_KEY,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    sessionId,
    ownerToken,
    heartbeatAtMs: nowMs,
    leaseExpiresAtMs: nowMs + LEASE_DURATION_MS,
    settledWallSeconds: 0,
    phase: "calibrating",
    workerRestartCount: 0,
    settlementId: randomToken("settlement"),
    checkpointHash: checkpointFingerprint(checkpointState),
    committed: false,
    lastTransitionAtMs: nowMs,
  };
  store.put(checkpoint);
  store.put(heartbeat);
  await transactionDone(transaction);
  return { ok: true, record: combine(checkpoint, heartbeat)! };
}

export async function claimPureIdleRecovery(
  ownerToken: string,
  nowMs = Date.now(),
): Promise<PureIdleRecoveryClaim> {
  if (!canUsePureIdleRecovery()) {
    return { ok: false, reason: "unavailable", message: "当前环境无法读取 IndexedDB 恢复日志" };
  }
  if (!await acquireBrowserLease(ownerToken)) {
    return { ok: false, reason: "owned", message: "另一个标签页仍持有纯挂机会话" };
  }
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const checkpointValue = await requestResult(store.get(CHECKPOINT_KEY));
  const heartbeatValue = await requestResult(store.get(HEARTBEAT_KEY));
  if (!checkpointValue && !heartbeatValue) {
    transaction.abort();
    releaseBrowserLease(ownerToken);
    return { ok: false, reason: "missing", message: "没有待恢复的纯挂机会话" };
  }
  if (!validCheckpoint(checkpointValue) || !validHeartbeat(heartbeatValue) || checkpointValue.sessionId !== heartbeatValue.sessionId) {
    transaction.abort();
    releaseBrowserLease(ownerToken);
    return { ok: false, reason: "invalid", message: "纯挂机恢复日志不完整，主存档未被修改" };
  }
  if (heartbeatValue.ownerToken !== ownerToken && heartbeatValue.leaseExpiresAtMs > nowMs) {
    transaction.abort();
    releaseBrowserLease(ownerToken);
    return { ok: false, reason: "owned", message: "另一个标签页仍持有纯挂机会话" };
  }
  const heartbeat: PureIdleHeartbeatRecord = {
    ...heartbeatValue,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    settlementId: heartbeatValue.settlementId ?? checkpointValue.sessionId,
    checkpointHash: heartbeatValue.checkpointHash ?? checkpointFingerprint(checkpointValue.state),
    committed: heartbeatValue.committed === true,
    lastTransitionAtMs: heartbeatValue.lastTransitionAtMs ?? heartbeatValue.heartbeatAtMs,
    ownerToken,
    heartbeatAtMs: nowMs,
    leaseExpiresAtMs: nowMs + LEASE_DURATION_MS,
  };
  store.put(heartbeat);
  await transactionDone(transaction);
  return { ok: true, record: combine(checkpointValue, heartbeat)! };
}

export async function heartbeatPureIdleRecovery(
  sessionId: string,
  ownerToken: string,
  settledWallSeconds: number,
  phase: PureIdleMacroPhase,
  summary?: PureIdleMacroSummary,
  lastError?: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const existing = await requestResult(store.get(HEARTBEAT_KEY));
  if (!validHeartbeat(existing) || existing.sessionId !== sessionId || existing.ownerToken !== ownerToken) {
    transaction.abort();
    return false;
  }
  store.put({
    ...existing,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    heartbeatAtMs: nowMs,
    leaseExpiresAtMs: nowMs + LEASE_DURATION_MS,
    settledWallSeconds: Math.max(existing.settledWallSeconds, settledWallSeconds),
    phase,
    ...(summary ? { summary } : {}),
    ...(lastError ? { lastError } : { lastError: undefined }),
  } satisfies PureIdleHeartbeatRecord);
  await transactionDone(transaction);
  return true;
}

export async function recordPureIdleWorkerFailure(
  sessionId: string,
  ownerToken: string,
  lastError: string,
  nowMs = Date.now(),
): Promise<number | null> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const existing = await requestResult(store.get(HEARTBEAT_KEY));
  if (!validHeartbeat(existing) || existing.sessionId !== sessionId || existing.ownerToken !== ownerToken) {
    transaction.abort();
    return null;
  }
  const workerRestartCount = Math.min(1_000, Math.max(0, Math.floor(existing.workerRestartCount ?? 0)) + 1);
  store.put({
    ...existing,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    heartbeatAtMs: nowMs,
    leaseExpiresAtMs: nowMs + LEASE_DURATION_MS,
    phase: "failed",
    lastError,
    workerRestartCount,
  } satisfies PureIdleHeartbeatRecord);
  await transactionDone(transaction);
  return workerRestartCount;
}

export async function resetPureIdleWorkerFailures(
  sessionId: string,
  ownerToken: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const existing = await requestResult(store.get(HEARTBEAT_KEY));
  if (!validHeartbeat(existing) || existing.sessionId !== sessionId || existing.ownerToken !== ownerToken) {
    transaction.abort();
    return false;
  }
  store.put({
    ...existing,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    heartbeatAtMs: nowMs,
    leaseExpiresAtMs: nowMs + LEASE_DURATION_MS,
    workerRestartCount: 0,
    lastError: undefined,
  } satisfies PureIdleHeartbeatRecord);
  await transactionDone(transaction);
  return true;
}

export async function recordPureIdleRecoveryTransition(
  sessionId: string,
  ownerToken: string,
  update: PureIdleRecoveryTransition,
  nowMs = Date.now(),
): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const existing = await requestResult(store.get(HEARTBEAT_KEY));
  if (!validHeartbeat(existing) || existing.sessionId !== sessionId || existing.ownerToken !== ownerToken) {
    transaction.abort();
    return false;
  }
  const committed = existing.committed === true || update.committed === true;
  store.put({
    ...existing,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    heartbeatAtMs: nowMs,
    leaseExpiresAtMs: nowMs + LEASE_DURATION_MS,
    stopReason: update.stopReason,
    ...(update.phase ? { phase: update.phase } : {}),
    ...(update.stopRequestedAtMs !== undefined ? { stopRequestedAtMs: update.stopRequestedAtMs } : {}),
    ...(update.targetWallSeconds !== undefined ? { targetWallSeconds: update.targetWallSeconds } : {}),
    ...(update.finalizedAtMs !== undefined ? { finalizedAtMs: update.finalizedAtMs } : {}),
    ...(update.committedAtMs !== undefined ? { committedAtMs: update.committedAtMs } : {}),
    ...(update.abandonedWallSeconds !== undefined ? { abandonedWallSeconds: update.abandonedWallSeconds } : {}),
    ...(update.lastError !== undefined ? { lastError: update.lastError } : {}),
    committed,
    lastTransitionAtMs: nowMs,
  } satisfies PureIdleHeartbeatRecord);
  await transactionDone(transaction);
  return true;
}

export async function markPureIdleBackground(
  sessionId: string,
  ownerToken: string,
  backgroundStartedAtMs = Date.now(),
): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const heartbeat = await requestResult(store.get(HEARTBEAT_KEY));
  if (!validHeartbeat(heartbeat) || heartbeat.sessionId !== sessionId || heartbeat.ownerToken !== ownerToken) {
    transaction.abort();
    return false;
  }
  store.put({
    ...heartbeat,
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    backgroundStartedAtMs: heartbeat.backgroundStartedAtMs ?? backgroundStartedAtMs,
    heartbeatAtMs: backgroundStartedAtMs,
    leaseExpiresAtMs: backgroundStartedAtMs + LEASE_DURATION_MS,
  } satisfies PureIdleHeartbeatRecord);
  await transactionDone(transaction);
  return true;
}

export async function clearPureIdleBackground(sessionId: string, ownerToken: string): Promise<boolean> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const heartbeat = await requestResult(store.get(HEARTBEAT_KEY));
  if (!validHeartbeat(heartbeat) || heartbeat.sessionId !== sessionId || heartbeat.ownerToken !== ownerToken) {
    transaction.abort();
    return false;
  }
  const { backgroundStartedAtMs: _backgroundStartedAtMs, ...rest } = heartbeat;
  store.put({ ...rest, schemaVersion: RECOVERY_SCHEMA_VERSION } satisfies PureIdleHeartbeatRecord);
  await transactionDone(transaction);
  return true;
}

export async function clearPureIdleRecovery(sessionId: string, ownerToken: string): Promise<boolean> {
  if (!canUsePureIdleRecovery()) return false;
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const heartbeat = await requestResult(store.get(HEARTBEAT_KEY));
  if (!validHeartbeat(heartbeat) || heartbeat.sessionId !== sessionId || heartbeat.ownerToken !== ownerToken) {
    transaction.abort();
    return false;
  }
  store.delete(CHECKPOINT_KEY);
  store.delete(HEARTBEAT_KEY);
  await transactionDone(transaction);
  releaseBrowserLease(ownerToken);
  return true;
}

export async function releasePureIdleRecoveryLease(sessionId: string, ownerToken: string, nowMs = Date.now()): Promise<void> {
  if (!canUsePureIdleRecovery()) return;
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const heartbeat = await requestResult(store.get(HEARTBEAT_KEY));
    if (!validHeartbeat(heartbeat) || heartbeat.sessionId !== sessionId || heartbeat.ownerToken !== ownerToken) {
      transaction.abort();
      return;
    }
    store.put({ ...heartbeat, schemaVersion: RECOVERY_SCHEMA_VERSION, heartbeatAtMs: nowMs, leaseExpiresAtMs: nowMs } satisfies PureIdleHeartbeatRecord);
    await transactionDone(transaction);
  } catch {
    // The checkpoint remains authoritative; a stale lease expires naturally.
  } finally {
    releaseBrowserLease(ownerToken);
  }
}
