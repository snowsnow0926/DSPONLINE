export type ProductionRefreshPreference =
  | "auto"
  | "classic"
  | "high"
  | "balanced"
  | "power-save"
  | "low-spec"
  | "extreme";

export interface ProductionRefreshProfile {
  id: ProductionRefreshPreference;
  label: string;
  intervalMs: number | null;
  summary: string;
}

export interface ProductionRefreshSample {
  fps: number;
  workerLatencyMs: number;
  pendingTaskMs: number;
}

export interface AutomaticRefreshState {
  intervalMs: number;
  mobile: boolean;
  recoveryWindows: number;
  pressureWindows: number;
}

export const PRODUCTION_REFRESH_INTERVALS = [100, 200, 500, 1_000, 1_500, 3_000] as const;

export const PRODUCTION_REFRESH_PROFILES: readonly ProductionRefreshProfile[] = [
  { id: "auto", label: "自动调节", intervalMs: null, summary: "根据帧率、Worker 延迟和任务积压平滑调节" },
  { id: "classic", label: "经典流畅", intervalMs: 100, summary: "每秒 10 次" },
  { id: "high", label: "高流畅", intervalMs: 200, summary: "每秒 5 次" },
  { id: "balanced", label: "均衡", intervalMs: 500, summary: "每秒 2 次" },
  { id: "power-save", label: "省电", intervalMs: 1_000, summary: "每秒 1 次" },
  { id: "low-spec", label: "低配置", intervalMs: 1_500, summary: "每 1.5 秒 1 次" },
  { id: "extreme", label: "极限省电", intervalMs: 3_000, summary: "每 3 秒 1 次" },
] as const;

export function isProductionRefreshPreference(value: unknown): value is ProductionRefreshPreference {
  return PRODUCTION_REFRESH_PROFILES.some((profile) => profile.id === value);
}

export function getProductionRefreshProfile(preference: ProductionRefreshPreference): ProductionRefreshProfile {
  return PRODUCTION_REFRESH_PROFILES.find((profile) => profile.id === preference) ?? PRODUCTION_REFRESH_PROFILES[0];
}

export function createAutomaticRefreshState(mobile: boolean): AutomaticRefreshState {
  return {
    intervalMs: mobile ? 500 : 200,
    mobile,
    recoveryWindows: 0,
    pressureWindows: 0,
  };
}

function adjacentInterval(current: number, direction: -1 | 1, mobile: boolean): number {
  const minimum = mobile ? 200 : 100;
  const eligible = PRODUCTION_REFRESH_INTERVALS.filter((interval) => interval >= minimum);
  const currentIndex = Math.max(0, eligible.findIndex((interval) => interval >= current));
  return eligible[Math.max(0, Math.min(eligible.length - 1, currentIndex + direction))] ?? current;
}

export function updateAutomaticRefreshState(
  current: AutomaticRefreshState,
  sample: ProductionRefreshSample,
): AutomaticRefreshState {
  const fps = Number.isFinite(sample.fps) ? Math.max(0, sample.fps) : 0;
  const workerLatencyMs = Number.isFinite(sample.workerLatencyMs) ? Math.max(0, sample.workerLatencyMs) : Number.POSITIVE_INFINITY;
  const pendingTaskMs = Number.isFinite(sample.pendingTaskMs) ? Math.max(0, sample.pendingTaskMs) : Number.POSITIVE_INFINITY;
  const severePressure = fps < 28 || workerLatencyMs > Math.max(1_000, current.intervalMs * 2.5) || pendingTaskMs > current.intervalMs * 3;
  const pressure = severePressure || fps < 40 || workerLatencyMs > Math.max(500, current.intervalMs * 1.5) || pendingTaskMs > current.intervalMs * 1.5;
  if (pressure) {
    const pressureWindows = current.pressureWindows + 1;
    if (severePressure || pressureWindows >= 2) {
      return {
        ...current,
        intervalMs: adjacentInterval(current.intervalMs, 1, current.mobile),
        pressureWindows: 0,
        recoveryWindows: 0,
      };
    }
    return { ...current, pressureWindows, recoveryWindows: 0 };
  }

  const healthy = fps >= 52 && workerLatencyMs <= Math.max(160, current.intervalMs * 0.75) && pendingTaskMs <= Math.max(100, current.intervalMs * 0.5);
  if (!healthy) return { ...current, pressureWindows: 0, recoveryWindows: 0 };
  const recoveryWindows = current.recoveryWindows + 1;
  if (recoveryWindows < 3) return { ...current, pressureWindows: 0, recoveryWindows };
  return {
    ...current,
    intervalMs: adjacentInterval(current.intervalMs, -1, current.mobile),
    pressureWindows: 0,
    recoveryWindows: 0,
  };
}

export function resolveProductionRefreshInterval(
  preference: ProductionRefreshPreference,
  automatic: AutomaticRefreshState,
): number {
  return getProductionRefreshProfile(preference).intervalMs ?? automatic.intervalMs;
}

export interface InterpolatedProgressInput {
  snapshotProgress: number;
  elapsedMs: number;
  cyclesPerSecond: number;
  active: boolean;
}

export type WorkProgressMode = "cycle" | "step" | "level" | "route" | "indeterminate";

export interface WorkProgressSnapshot {
  mode: WorkProgressMode;
  semanticKey: string;
  snapshotProgress: number;
  publishedAtMs: number;
  cyclesPerSecond: number;
  effectiveSimulationMultiplier: number;
  active: boolean;
}

/**
 * Sparse Worker publications can arrive after the visual clock has already
 * advanced, or even wrapped, the same repeating cycle. While the semantic
 * work and rate are unchanged, the existing monotonic clock is already the
 * best phase estimate. Rebasing it to a delayed authority snapshot can make
 * the visible progress jump backwards after a natural wrap.
 */
export function reconcileWorkDisplaySnapshot(
  previous: WorkProgressSnapshot,
  next: WorkProgressSnapshot,
  publishedAtMs: number,
): WorkProgressSnapshot {
  const sameCycle = previous.active && next.active &&
    previous.mode === next.mode && previous.semanticKey === next.semanticKey &&
    previous.cyclesPerSecond === next.cyclesPerSecond &&
    previous.effectiveSimulationMultiplier === next.effectiveSimulationMultiplier &&
    previous.mode !== "indeterminate" && previous.mode !== "level";
  if (sameCycle) return previous;
  return { ...next, publishedAtMs };
}

export function getWorkDisplayProgress(snapshot: WorkProgressSnapshot, monotonicTimeMs: number): number {
  const progress = Math.max(0, Math.min(1, Number.isFinite(snapshot.snapshotProgress) ? snapshot.snapshotProgress : 0));
  if (snapshot.mode === "indeterminate" || snapshot.mode === "level" || !snapshot.active) return progress;
  const rate = Number.isFinite(snapshot.cyclesPerSecond) ? Math.max(0, snapshot.cyclesPerSecond) : 0;
  const multiplier = Number.isFinite(snapshot.effectiveSimulationMultiplier)
    ? Math.max(0, snapshot.effectiveSimulationMultiplier)
    : 0;
  const elapsedMs = Number.isFinite(monotonicTimeMs)
    ? Math.max(0, monotonicTimeMs - snapshot.publishedAtMs)
    : 0;
  if (rate <= 0 || multiplier <= 0) return progress;
  const advanced = progress + elapsedMs / 1_000 * rate * multiplier;
  return ((advanced % 1) + 1) % 1;
}

export function interpolateProductionProgress(input: InterpolatedProgressInput): number {
  const snapshot = Math.max(0, Math.min(0.999999, Number.isFinite(input.snapshotProgress) ? input.snapshotProgress : 0));
  if (!input.active || !Number.isFinite(input.cyclesPerSecond) || input.cyclesPerSecond <= 0 || !Number.isFinite(input.elapsedMs)) return snapshot;
  const advanced = snapshot + Math.max(0, input.elapsedMs) / 1_000 * input.cyclesPerSecond;
  return ((advanced % 1) + 1) % 1;
}
