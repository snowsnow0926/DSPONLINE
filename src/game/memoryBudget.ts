/**
 * Small, browser-safe memory governor used by the simulation scheduler and
 * persistence path.  It deliberately has no React or storage dependencies so
 * that the admission rules can be tested with deterministic snapshots.
 */

export type MemoryPressure = "normal" | "elevated" | "critical";

export interface MemorySnapshot {
  usedHeapBytes: number | null;
  heapLimitBytes: number | null;
  deviceMemoryGiB: number | null;
  sampledAtMs: number;
}

export interface MemoryWorkload {
  serializedBytes: number | null;
  entityCount: number;
  beltCount: number;
  stationCount: number;
}

export interface MemoryGuardInput {
  snapshot?: MemorySnapshot | null;
  workload: MemoryWorkload;
  pendingSimulationSeconds: number;
  workerInFlight: boolean;
  saveInFlight: boolean;
  slowWorkerCount?: number;
  allocationFailure?: boolean;
  policy?: MemoryGuardPolicy;
}

/**
 * Device-only memory protection policy.  It is intentionally not part of
 * GameState: a setting which is safe on one machine may be too aggressive (or
 * too lax) on another, and it must never change deterministic save data.
 *
 * `null` means the browser's heap limit is used (the existing 90% guard).
 * A numeric value adds an earlier absolute JS-heap watermark; the browser
 * 90% guard remains a hard ceiling whenever the browser exposes the metric.
 *
 * `autoPauseEnabled: false` is an explicit advanced/unsafe run mode. It
 * bypasses the heap and simulation-backlog pause gates *and* their queue
 * admission backpressure, so the scheduler never rewinds to an older
 * checkpoint merely because it is behind. It does not bypass an explicit
 * allocation-failure signal; that remains an integrity fail-safe.
 */
export const MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB = [512, 768, 1_024, 1_536, 2_048, 3_072, 4_096] as const;
export type MemoryAutoPauseThresholdMiB = (typeof MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB)[number] | null;

export interface MemoryGuardPolicy {
  autoPauseEnabled?: boolean;
  autoPauseThresholdMiB?: MemoryAutoPauseThresholdMiB;
}

export interface MemoryGuardDecision {
  pressure: MemoryPressure;
  shouldPause: boolean;
  admitSimulation: boolean;
  maxSimulationSliceSeconds: number;
  maxPendingSimulationSeconds: number;
  estimatedRuntimeBytes: number;
  heapRatio: number | null;
  reason: string | null;
}

/** A save this large needs the conservative scheduler settings below. */
export const MEMORY_LARGE_SAVE_BYTES = 64 * 1024 * 1024;
export const MEMORY_LARGE_ENTITY_COUNT = 50_000;
export const MEMORY_LARGE_BELT_COUNT = 100_000;
export const MEMORY_LARGE_STATION_COUNT = 10_000;

export const MEMORY_NORMAL_SLICE_SECONDS = 2;
export const MEMORY_LARGE_SLICE_SECONDS = 1;
export const MEMORY_NORMAL_PENDING_SECONDS = 20;
export const MEMORY_LARGE_PENDING_SECONDS = 8;
export const MEMORY_CRITICAL_PENDING_SECONDS = 24;

export function isMemoryAutoPauseThresholdMiB(value: unknown): value is MemoryAutoPauseThresholdMiB {
  return value === null || (typeof value === "number" && MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB.includes(value as (typeof MEMORY_AUTO_PAUSE_THRESHOLD_PRESETS_MIB)[number]));
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Runtime indexes and transient JSON copies are roughly proportional to the
 * number of entities/belts.  This is intentionally an admission estimate,
 * not a claim about the exact V8 heap layout.
 */
export function estimateSimulationRuntimeBytes(workload: MemoryWorkload): number {
  const serialized = finiteNonNegative(workload.serializedBytes) ?? 0;
  const entities = Math.max(0, Math.floor(workload.entityCount)) * 320;
  const belts = Math.max(0, Math.floor(workload.beltCount)) * 176;
  const stations = Math.max(0, Math.floor(workload.stationCount)) * 512;
  return Math.max(serialized, Math.ceil(serialized * 0.35)) + entities + belts + stations;
}

export function isLargeMemoryWorkload(workload: MemoryWorkload): boolean {
  return (finiteNonNegative(workload.serializedBytes) ?? 0) >= MEMORY_LARGE_SAVE_BYTES ||
    workload.entityCount >= MEMORY_LARGE_ENTITY_COUNT ||
    workload.beltCount >= MEMORY_LARGE_BELT_COUNT ||
    workload.stationCount >= MEMORY_LARGE_STATION_COUNT;
}

export function readBrowserMemorySnapshot(): MemorySnapshot {
  const performanceMemory = typeof performance !== "undefined"
    ? (performance as Performance & {
      memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number };
    }).memory
    : undefined;
  const navigatorMemory = typeof navigator !== "undefined"
    ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    : undefined;
  return {
    usedHeapBytes: finiteNonNegative(performanceMemory?.usedJSHeapSize),
    heapLimitBytes: finiteNonNegative(performanceMemory?.jsHeapSizeLimit),
    deviceMemoryGiB: finiteNonNegative(navigatorMemory),
    sampledAtMs: typeof performance !== "undefined" ? performance.now() : Date.now(),
  };
}

function heapRatio(snapshot: MemorySnapshot | null | undefined): number | null {
  const used = finiteNonNegative(snapshot?.usedHeapBytes);
  const limit = finiteNonNegative(snapshot?.heapLimitBytes);
  if (used === null || limit === null || limit <= 0) return null;
  return Math.min(2, used / limit);
}

/**
 * Decide whether another simulation slice may be admitted.  A missing
 * performance.memory API is treated as unknown rather than as an error; the
 * backlog and worker-timeout guards still protect the page in that case.
 */
export function evaluateMemoryGuard(input: MemoryGuardInput): MemoryGuardDecision {
  const workload = input.workload;
  const large = isLargeMemoryWorkload(workload);
  const ratio = heapRatio(input.snapshot);
  const usedHeapBytes = finiteNonNegative(input.snapshot?.usedHeapBytes);
  const autoPauseEnabled = input.policy?.autoPauseEnabled !== false;
  const autoPauseThresholdMiB = input.policy?.autoPauseThresholdMiB ?? null;
  const pending = Math.max(0, input.pendingSimulationSeconds);
  const slowWorkers = Math.max(0, Math.floor(input.slowWorkerCount ?? 0));
  const maxPending = large ? MEMORY_LARGE_PENDING_SECONDS : MEMORY_NORMAL_PENDING_SECONDS;
  const estimatedRuntimeBytes = estimateSimulationRuntimeBytes(workload);

  const heapThresholdCritical = autoPauseThresholdMiB !== null && usedHeapBytes !== null &&
    usedHeapBytes >= autoPauseThresholdMiB * 1024 * 1024;
  // A fixed watermark can make protection happen earlier, but never weakens
  // the browser-limit guard. If the browser does not expose usedHeapBytes,
  // the ratio remains the best available signal.
  const heapCritical = autoPauseEnabled && (
    heapThresholdCritical || (ratio !== null && ratio >= 0.90)
  );
  const heapElevated = ratio !== null && ratio >= 0.75;
  const backlogCritical = pending >= MEMORY_CRITICAL_PENDING_SECONDS;
  const backlogElevated = pending > maxPending;
  const repeatedSlowWorkers = slowWorkers >= 3;
  // The configured queue limit first acts as backpressure: stop admitting a
  // new slice and let the Worker drain. Only the larger critical boundary
  // pauses the factory, so a temporarily slow large-save Worker does not
  // turn an otherwise healthy running game into a false-positive pause.
  // When the player explicitly disables the guard, do not turn simulation
  // debt into a rollback. This is deliberately different from merely
  // ignoring the heap watermark: the backlog gate and its admission
  // backpressure must be bypassed together, otherwise a delayed Worker would
  // still eventually force the app back to the last confirmed checkpoint.
  const backlogProtectionEnabled = autoPauseEnabled;
  const shouldPause = Boolean(input.allocationFailure || heapCritical || (backlogProtectionEnabled && backlogCritical));
  const pressure: MemoryPressure = shouldPause
    ? "critical"
    : heapElevated || backlogElevated || repeatedSlowWorkers || large
      ? "elevated"
      : "normal";
  const admitSimulation = !shouldPause && (!backlogProtectionEnabled || !backlogElevated) && !input.saveInFlight && !input.workerInFlight;
  const maxSimulationSliceSeconds = pressure === "elevated" || large
    ? MEMORY_LARGE_SLICE_SECONDS
    : MEMORY_NORMAL_SLICE_SECONDS;

  let reason: string | null = null;
  if (input.allocationFailure) reason = "检测到内存分配失败";
  else if (autoPauseEnabled && heapThresholdCritical) reason = `已达到 ${autoPauseThresholdMiB} MiB 内存保护阈值`;
  else if (heapCritical) reason = "浏览器堆内存接近上限";
  else if (backlogProtectionEnabled && backlogCritical) reason = "模拟积压超过安全上限";
  else if (repeatedSlowWorkers) reason = "模拟 Worker 连续超时";
  else if (input.saveInFlight) reason = "存档检查点正在写入";
  else if (large) reason = "大型工厂启用保守切片";
  else if (heapElevated) reason = "堆内存压力升高";
  else if (backlogElevated) reason = "模拟积压正在限流";

  return {
    pressure,
    shouldPause,
    admitSimulation,
    maxSimulationSliceSeconds,
    maxPendingSimulationSeconds: maxPending,
    estimatedRuntimeBytes,
    heapRatio: ratio,
    reason,
  };
}
