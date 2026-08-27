export type TimeWarpThrottleReason =
  | "warming-up"
  | "requested-limit"
  | "power-limit"
  | "compute-limit"
  | "worker-slow"
  | "backlog"
  | "approximation-active"
  | "approximation-fallback"
  | "worker-unavailable";

export type TimeWarpComputeMode = "exact" | "approximate";
export type TimeWarpApproximationStatus = "inactive" | "calibrating" | "active" | "fallback";

export interface TimeWarpComputeGovernorState {
  sampleCount: number;
  stableSampleCount: number;
  throughputEma: number;
  durationEmaMs: number;
  recentWorkerDurationMs: number;
  computeLimitedMultiplier: number;
  sliceSimulationSeconds: number;
  computeMode: TimeWarpComputeMode;
  approximationStatus: TimeWarpApproximationStatus;
  approximationAlgorithmVersion?: string;
  lastApproximatedSeconds: number;
  maxCriticalError: number;
  boundaryCorrections: number;
  fallbackReason?: string;
  reason: TimeWarpThrottleReason;
}

export interface TimeWarpComputeLimits {
  requestedMultiplier: number;
  powerLimitedMultiplier: number;
  computeLimitedMultiplier: number;
  baseMultiplier: number;
  computeMode: TimeWarpComputeMode;
  approximationStatus: TimeWarpApproximationStatus;
  actualMultiplier: number;
  maximumPendingSimulationSeconds: number;
  sliceSimulationSeconds: number;
  reason: TimeWarpThrottleReason;
}

export interface TimeWarpComputeSample {
  simulationSeconds: number;
  durationMs: number;
  pendingSimulationSeconds: number;
  requestedMultiplier: number;
  powerLimitedMultiplier: number;
  baseMultiplier: number;
  approximation?: {
    mode: TimeWarpComputeMode;
    algorithmVersion: string;
    approximatedSeconds: number;
    maxCriticalError: number;
    boundaryCorrections: number;
    fallbackReason?: string;
  };
}

const TARGET_SLICE_DURATION_SECONDS = 0.35;
// Approximate slices have a fixed full-state calibration/copy cost. Give each
// one roughly eight wall seconds of work so large saves do not repeat that
// cost faster than the device can consume it. Stop still terminates an
// uncommitted Worker slice immediately. The watchdog allows one 15-second
// endgame slice because the Worker keeps the UI responsive and the previous
// five-second limit killed verified 40+ MiB candidates before commit.
const APPROXIMATE_SLICE_WALL_SECONDS = 8;
const SLOW_SLICE_DURATION_MS = 700;
export const TIME_WARP_MAX_EXACT_SLICE_SIMULATION_SECONDS = 12;
export const TIME_WARP_MAX_SLICE_SIMULATION_SECONDS = 128;
export const TIME_WARP_WORKER_HARD_TIMEOUT_MS = 15_000;
const MIN_PENDING_SLICES = 2.5;

function safeMultiplier(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(fallback, Math.floor(value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createTimeWarpComputeGovernor(baseMultiplier = 1): TimeWarpComputeGovernorState {
  const base = safeMultiplier(baseMultiplier, 1);
  return {
    sampleCount: 0,
    stableSampleCount: 0,
    throughputEma: 0,
    durationEmaMs: 0,
    recentWorkerDurationMs: 0,
    computeLimitedMultiplier: base,
    sliceSimulationSeconds: base,
    computeMode: "exact",
    approximationStatus: "inactive",
    lastApproximatedSeconds: 0,
    maxCriticalError: 0,
    boundaryCorrections: 0,
    reason: "warming-up",
  };
}

export function resolveTimeWarpComputeLimits(
  governor: TimeWarpComputeGovernorState,
  requestedMultiplier: number,
  powerLimitedMultiplier: number,
  baseMultiplier = 1,
): TimeWarpComputeLimits {
  const base = safeMultiplier(baseMultiplier, 1);
  const requested = safeMultiplier(requestedMultiplier, base);
  const power = safeMultiplier(powerLimitedMultiplier, base);
  const compute = safeMultiplier(governor.computeLimitedMultiplier, base);
  // Power is a gameplay limit. Compute capacity is diagnostic only: when the
  // exact Worker cannot sustain this multiplier the governor changes compute
  // mode instead of disguising CPU pressure as a lower gameplay multiplier.
  const actualMultiplier = Math.max(base, Math.min(requested, power));
  const maximumSlice = governor.computeMode === "approximate"
    ? TIME_WARP_MAX_SLICE_SIMULATION_SECONDS
    : TIME_WARP_MAX_EXACT_SLICE_SIMULATION_SECONDS;
  const sliceSimulationSeconds = clamp(
    governor.computeMode === "approximate"
      ? Math.max(governor.sliceSimulationSeconds, actualMultiplier * APPROXIMATE_SLICE_WALL_SECONDS)
      : governor.sliceSimulationSeconds,
    base,
    maximumSlice,
  );
  const maximumPendingSimulationSeconds = Math.max(
    sliceSimulationSeconds * (governor.computeMode === "approximate" ? 3 : MIN_PENDING_SLICES),
    actualMultiplier * (governor.computeMode === "approximate" ? 3 : 2),
  );
  let reason = governor.reason;
  if (power < requested) reason = "power-limit";
  else if (governor.computeMode === "approximate") {
    reason = governor.approximationStatus === "fallback" ? "approximation-fallback" : "approximation-active";
  } else if (governor.sampleCount < 2) reason = "warming-up";
  else if (reason !== "worker-slow" && reason !== "backlog" && reason !== "worker-unavailable") reason = "requested-limit";
  return {
    requestedMultiplier: requested,
    powerLimitedMultiplier: power,
    computeLimitedMultiplier: compute,
    baseMultiplier: base,
    computeMode: governor.computeMode,
    approximationStatus: governor.approximationStatus,
    actualMultiplier,
    maximumPendingSimulationSeconds,
    sliceSimulationSeconds,
    reason,
  };
}

/**
 * Update the device-local governor from one completed Worker round trip. The
 * sample includes clone, queue and commit latency so a fast engine step cannot
 * hide an overloaded browser main thread.
 */
export function recordTimeWarpComputeSample(
  governor: TimeWarpComputeGovernorState,
  sample: TimeWarpComputeSample,
): TimeWarpComputeGovernorState {
  const base = safeMultiplier(sample.baseMultiplier, 1);
  if (!Number.isFinite(sample.simulationSeconds) || sample.simulationSeconds <= 0 ||
    !Number.isFinite(sample.durationMs) || sample.durationMs <= 0) {
    return {
      ...governor,
      computeLimitedMultiplier: base,
      stableSampleCount: 0,
      computeMode: "approximate",
      approximationStatus: "calibrating",
      reason: "worker-slow",
    };
  }
  const observedThroughput = sample.simulationSeconds / (sample.durationMs / 1_000);
  const throughputEma = governor.sampleCount === 0
    ? observedThroughput
    : governor.throughputEma * 0.65 + observedThroughput * 0.35;
  const durationEmaMs = governor.sampleCount === 0
    ? sample.durationMs
    : governor.durationEmaMs * 0.65 + sample.durationMs * 0.35;
  const sustainableMultiplier = Math.max(base, Math.floor(throughputEma * 0.75));
  const previousLimit = safeMultiplier(governor.computeLimitedMultiplier, base);
  const targetSlice = clamp(
    governor.computeMode === "approximate"
      ? Math.max(
        sample.powerLimitedMultiplier * APPROXIMATE_SLICE_WALL_SECONDS,
        throughputEma * TARGET_SLICE_DURATION_SECONDS,
      )
      : throughputEma * TARGET_SLICE_DURATION_SECONDS,
    base,
    governor.computeMode === "approximate"
      ? TIME_WARP_MAX_SLICE_SIMULATION_SECONDS
      : TIME_WARP_MAX_EXACT_SLICE_SIMULATION_SECONDS,
  );
  const approximationStatus: TimeWarpApproximationStatus = sample.approximation
    ? sample.approximation.mode === "approximate" ? "active" : "fallback"
    : governor.computeMode === "approximate" ? "calibrating" : "inactive";
  const provisional = {
    ...governor,
    sampleCount: governor.sampleCount + 1,
    throughputEma,
    durationEmaMs,
    recentWorkerDurationMs: sample.durationMs,
    sliceSimulationSeconds: targetSlice,
    approximationStatus,
    approximationAlgorithmVersion: sample.approximation?.algorithmVersion ?? governor.approximationAlgorithmVersion,
    lastApproximatedSeconds: sample.approximation?.approximatedSeconds ?? 0,
    maxCriticalError: sample.approximation?.maxCriticalError ?? 0,
    boundaryCorrections: sample.approximation?.boundaryCorrections ?? 0,
    fallbackReason: sample.approximation?.fallbackReason,
  };
  const limits = resolveTimeWarpComputeLimits(
    provisional,
    sample.requestedMultiplier,
    sample.powerLimitedMultiplier,
    base,
  );
  const backlogHigh = sample.pendingSimulationSeconds > limits.maximumPendingSimulationSeconds;
  const workerSlow = sample.durationMs >= SLOW_SLICE_DURATION_MS;
  const requiredMultiplier = Math.max(base, Math.min(
    safeMultiplier(sample.requestedMultiplier, base),
    safeMultiplier(sample.powerLimitedMultiplier, base),
  ));
  const computeInsufficient = sustainableMultiplier < requiredMultiplier;
  if (governor.computeMode === "approximate" || sample.approximation || workerSlow || backlogHigh || computeInsufficient) {
    return {
      ...provisional,
      stableSampleCount: 0,
      computeLimitedMultiplier: sustainableMultiplier,
      computeMode: "approximate",
      approximationStatus,
      reason: approximationStatus === "fallback"
        ? "approximation-fallback"
        : sample.approximation?.mode === "approximate"
          ? "approximation-active"
          : workerSlow
            ? "worker-slow"
            : backlogHigh
              ? "backlog"
              : "compute-limit",
    };
  }
  const stableSampleCount = governor.stableSampleCount + 1;
  const mayRaise = stableSampleCount >= 2 && sustainableMultiplier > previousLimit;
  const raisedLimit = mayRaise
    ? Math.min(sustainableMultiplier, Math.max(previousLimit + 1, Math.ceil(previousLimit * 1.5)))
    : previousLimit;
  const requested = safeMultiplier(sample.requestedMultiplier, base);
  const power = safeMultiplier(sample.powerLimitedMultiplier, base);
  const computeLimitedMultiplier = Math.max(base, Math.min(raisedLimit, Math.max(requested, power)));
  return {
    ...provisional,
    stableSampleCount: mayRaise ? 0 : stableSampleCount,
    computeLimitedMultiplier,
    computeMode: "exact",
    approximationStatus: "inactive",
    reason: provisional.sampleCount < 2 ? "warming-up" : "compute-limit",
  };
}

export function forceTimeWarpApproximation(
  governor: TimeWarpComputeGovernorState,
  reason: "backlog" | "worker-slow" | "compute-limit" = "backlog",
): TimeWarpComputeGovernorState {
  return {
    ...governor,
    stableSampleCount: 0,
    computeMode: "approximate",
    approximationStatus: "calibrating",
    reason,
  };
}

export function markTimeWarpWorkerUnavailable(
  governor: TimeWarpComputeGovernorState,
  baseMultiplier = 1,
): TimeWarpComputeGovernorState {
  const base = safeMultiplier(baseMultiplier, 1);
  return {
    ...governor,
    stableSampleCount: 0,
    computeLimitedMultiplier: base,
    computeMode: "exact",
    approximationStatus: "inactive",
    reason: "worker-unavailable",
  };
}

export function shouldAbortTimeWarpWorker(submittedAt: number, now: number, hardTimeoutMs = TIME_WARP_WORKER_HARD_TIMEOUT_MS): boolean {
  return Number.isFinite(submittedAt) && Number.isFinite(now) && now - submittedAt >= Math.max(1_000, hardTimeoutMs);
}
