import { describe, expect, it } from "vitest";
import {
  getTimeWarpWorkerHardTimeoutMs,
  createTimeWarpComputeGovernor,
  forceTimeWarpApproximation,
  markTimeWarpWorkerUnavailable,
  recordTimeWarpComputeSample,
  resolveTimeWarpComputeLimits,
  shouldAbortTimeWarpWorker,
  TIME_WARP_MAX_EXACT_SLICE_SIMULATION_SECONDS,
  TIME_WARP_MAX_SLICE_SIMULATION_SECONDS,
  TIME_WARP_WORKER_HARD_TIMEOUT_MS,
} from "./timeWarpComputeGovernor";

describe("time-warp compute governor", () => {
  it("keeps requested gameplay speed while measuring exact compute capacity", () => {
    let governor = createTimeWarpComputeGovernor(1);
    expect(resolveTimeWarpComputeLimits(governor, 12, 12, 1).actualMultiplier).toBe(12);
    governor = recordTimeWarpComputeSample(governor, {
      simulationSeconds: 1,
      durationMs: 50,
      pendingSimulationSeconds: 0,
      requestedMultiplier: 12,
      powerLimitedMultiplier: 12,
      baseMultiplier: 1,
    });
    expect(governor.computeLimitedMultiplier).toBe(1);
    governor = recordTimeWarpComputeSample(governor, {
      simulationSeconds: 1,
      durationMs: 50,
      pendingSimulationSeconds: 0,
      requestedMultiplier: 12,
      powerLimitedMultiplier: 12,
      baseMultiplier: 1,
    });
    expect(governor.computeLimitedMultiplier).toBeGreaterThan(1);
    expect(resolveTimeWarpComputeLimits(governor, 12, 5, 1)).toMatchObject({
      actualMultiplier: 5,
      reason: "power-limit",
    });
  });

  it("switches to approximation for a slow worker or excessive backlog without lowering gameplay speed", () => {
    let governor = { ...createTimeWarpComputeGovernor(1), sampleCount: 5, computeLimitedMultiplier: 12, throughputEma: 16, sliceSimulationSeconds: 8 };
    governor = recordTimeWarpComputeSample(governor, {
      simulationSeconds: 12,
      durationMs: 2_500,
      pendingSimulationSeconds: 0,
      requestedMultiplier: 12,
      powerLimitedMultiplier: 12,
      baseMultiplier: 1,
    });
    expect(governor.computeLimitedMultiplier).toBeLessThan(12);
    expect(governor.computeMode).toBe("approximate");
    expect(governor.reason).toBe("worker-slow");
    expect(resolveTimeWarpComputeLimits(governor, 12, 12, 1).actualMultiplier).toBe(12);

    governor = { ...governor, computeLimitedMultiplier: 6, sliceSimulationSeconds: 4 };
    governor = recordTimeWarpComputeSample(governor, {
      simulationSeconds: 12,
      durationMs: 400,
      pendingSimulationSeconds: 100,
      requestedMultiplier: 12,
      powerLimitedMultiplier: 12,
      baseMultiplier: 1,
      approximation: {
        mode: "approximate",
        algorithmVersion: "time-warp-test",
        approximatedSeconds: 9,
        maxCriticalError: 0.04,
        boundaryCorrections: 2,
      },
    });
    expect(governor).toMatchObject({
      reason: "approximation-active",
      computeMode: "approximate",
      approximationStatus: "active",
      lastApproximatedSeconds: 9,
      maxCriticalError: 0.04,
      boundaryCorrections: 2,
    });
  });

  it("bounds pending work to a small number of dynamic slices", () => {
    const governor = { ...createTimeWarpComputeGovernor(1), sampleCount: 4, computeLimitedMultiplier: 8, sliceSimulationSeconds: 1_000 };
    const limits = resolveTimeWarpComputeLimits(governor, 12, 10, 1);
    expect(limits.actualMultiplier).toBe(10);
    expect(limits.sliceSimulationSeconds).toBe(TIME_WARP_MAX_EXACT_SLICE_SIMULATION_SECONDS);
    expect(limits.maximumPendingSimulationSeconds).toBe(TIME_WARP_MAX_EXACT_SLICE_SIMULATION_SECONDS * 2.5);

    const approximate = resolveTimeWarpComputeLimits(forceTimeWarpApproximation(governor), 16, 16, 1);
    expect(approximate.actualMultiplier).toBe(16);
    expect(approximate.sliceSimulationSeconds).toBe(TIME_WARP_MAX_SLICE_SIMULATION_SECONDS);
    expect(approximate.maximumPendingSimulationSeconds).toBe(TIME_WARP_MAX_SLICE_SIMULATION_SECONDS * 3);
  });

  it("amortizes approximate calibration across about eight wall seconds", () => {
    const governor = forceTimeWarpApproximation({
      ...createTimeWarpComputeGovernor(1),
      sliceSimulationSeconds: 2,
    });
    expect(resolveTimeWarpComputeLimits(governor, 8, 8, 1).sliceSimulationSeconds).toBe(64);
    expect(resolveTimeWarpComputeLimits(governor, 12, 12, 1).sliceSimulationSeconds).toBe(96);
    expect(resolveTimeWarpComputeLimits(governor, 16, 16, 1).sliceSimulationSeconds).toBe(128);
  });

  it("marks failures and detects a hard timeout without mutating game state", () => {
    const unavailable = markTimeWarpWorkerUnavailable(createTimeWarpComputeGovernor(2), 2);
    expect(unavailable).toMatchObject({ computeLimitedMultiplier: 2, reason: "worker-unavailable" });
    expect(shouldAbortTimeWarpWorker(1_000, 5_999, 5_000)).toBe(false);
    expect(shouldAbortTimeWarpWorker(1_000, 6_000, 5_000)).toBe(true);
    expect(shouldAbortTimeWarpWorker(1_000, 1_000 + TIME_WARP_WORKER_HARD_TIMEOUT_MS - 1)).toBe(false);
    expect(shouldAbortTimeWarpWorker(1_000, 1_000 + TIME_WARP_WORKER_HARD_TIMEOUT_MS)).toBe(true);
  });

  it("allows bounded endgame calibration without weakening the exact worker watchdog", () => {
    const exact = createTimeWarpComputeGovernor(1);
    const approximate = forceTimeWarpApproximation(exact);
    expect(getTimeWarpWorkerHardTimeoutMs(exact)).toBe(15_000);
    expect(getTimeWarpWorkerHardTimeoutMs(approximate)).toBe(45_000);
    expect(shouldAbortTimeWarpWorker(1_000, 31_000, getTimeWarpWorkerHardTimeoutMs(approximate))).toBe(false);
    expect(shouldAbortTimeWarpWorker(1_000, 46_000, getTimeWarpWorkerHardTimeoutMs(approximate))).toBe(true);
  });
});
