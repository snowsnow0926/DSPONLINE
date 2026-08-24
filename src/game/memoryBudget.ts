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
  const pending = Math.max(0, input.pendingSimulationSeconds);
  const slowWorkers = Math.max(0, Math.floor(input.slowWorkerCount ?? 0));
  const maxPending = large ? MEMORY_LARGE_PENDING_SECONDS : MEMORY_NORMAL_PENDING_SECONDS;
  const estimatedRuntimeBytes = estimateSimulationRuntimeBytes(workload);

  const heapCritical = ratio !== null && ratio >= 0.90;
  const heapElevated = ratio !== null && ratio >= 0.75;
  const backlogCritical = pending >= MEMORY_CRITICAL_PENDING_SECONDS;
  const backlogElevated = pending > maxPending;
  const repeatedSlowWorkers = slowWorkers >= 3;
  // The configured queue limit first acts as backpressure: stop admitting a
  // new slice and let the Worker drain. Only the larger critical boundary
  // pauses the factory, so a temporarily slow large-save Worker does not
  // turn an otherwise healthy running game into a false-positive pause.
  const shouldPause = Boolean(input.allocationFailure || heapCritical || backlogCritical);
  const pressure: MemoryPressure = shouldPause
    ? "critical"
    : heapElevated || backlogElevated || repeatedSlowWorkers || large
      ? "elevated"
      : "normal";
  const admitSimulation = !shouldPause && !backlogElevated && !input.saveInFlight && !input.workerInFlight;
  const maxSimulationSliceSeconds = pressure === "elevated" || large
    ? MEMORY_LARGE_SLICE_SECONDS
    : MEMORY_NORMAL_SLICE_SECONDS;

  let reason: string | null = null;
  if (input.allocationFailure) reason = "检测到内存分配失败";
  else if (heapCritical) reason = "浏览器堆内存接近上限";
  else if (backlogCritical) reason = "模拟积压超过安全上限";
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
