import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import { advanceSimulation, createInitialState } from "./engine";
import {
  PRODUCTION_REFRESH_PROFILES,
  createAutomaticRefreshState,
  getWorkDisplayProgress,
  interpolateProductionProgress,
  reconcileWorkDisplaySnapshot,
  resolveProductionRefreshInterval,
  updateAutomaticRefreshState,
} from "./productionRefresh";

describe("production refresh policy", () => {
  it("starts desktop at 200 ms and mobile at 500 ms", () => {
    expect(createAutomaticRefreshState(false).intervalMs).toBe(200);
    expect(createAutomaticRefreshState(true).intervalMs).toBe(500);
  });

  it("degrades and recovers one tier at a time with hysteresis", () => {
    let state = createAutomaticRefreshState(false);
    state = updateAutomaticRefreshState(state, { fps: 20, workerLatencyMs: 1_200, pendingTaskMs: 900 });
    expect(state.intervalMs).toBe(500);
    for (let index = 0; index < 2; index += 1) {
      state = updateAutomaticRefreshState(state, { fps: 60, workerLatencyMs: 80, pendingTaskMs: 20 });
      expect(state.intervalMs).toBe(500);
    }
    state = updateAutomaticRefreshState(state, { fps: 60, workerLatencyMs: 80, pendingTaskMs: 20 });
    expect(state.intervalMs).toBe(200);
  });

  it("never lets the automatic state override a fixed preference", () => {
    const automatic = { ...createAutomaticRefreshState(false), intervalMs: 3_000 };
    expect(resolveProductionRefreshInterval("classic", automatic)).toBe(100);
    expect(resolveProductionRefreshInterval("balanced", automatic)).toBe(500);
    expect(resolveProductionRefreshInterval("extreme", automatic)).toBe(3_000);
  });

  it("interpolates visual progress without changing a snapshot value", () => {
    const input = { snapshotProgress: 0.25, elapsedMs: 500, cyclesPerSecond: 0.5, active: true };
    expect(interpolateProductionProgress(input)).toBeCloseTo(0.5);
    expect(input.snapshotProgress).toBe(0.25);
    expect(interpolateProductionProgress({ ...input, active: false })).toBe(0.25);
    expect(interpolateProductionProgress({ snapshotProgress: 0.9, elapsedMs: 400, cyclesPerSecond: 0.5, active: true })).toBeCloseTo(0.1);
  });

  it("uses one display progress value for cycle, step, level and paused semantics", () => {
    const base = { semanticKey: "machine:recipe", snapshotProgress: 0.25, publishedAtMs: 1_000, cyclesPerSecond: 0.5, effectiveSimulationMultiplier: 4, active: true };
    expect(getWorkDisplayProgress({ ...base, mode: "cycle" }, 1_250)).toBeCloseTo(0.75);
    expect(getWorkDisplayProgress({ ...base, mode: "step" }, 1_500)).toBeCloseTo(0.25);
    expect(getWorkDisplayProgress({ ...base, mode: "level" }, 9_000)).toBe(0.25);
    expect(getWorkDisplayProgress({ ...base, mode: "cycle", active: false }, 9_000)).toBe(0.25);
    expect(getWorkDisplayProgress({ ...base, mode: "indeterminate" }, 9_000)).toBe(0.25);
  });

  it("keeps an active cycle visually continuous across a sparse snapshot", () => {
    const previous = {
      mode: "cycle" as const,
      semanticKey: "machine:magnet",
      snapshotProgress: 0.67,
      publishedAtMs: 1_000,
      cyclesPerSecond: 2 / 3,
      effectiveSimulationMultiplier: 1,
      active: true,
    };
    const reconciled = reconcileWorkDisplaySnapshot(previous, { ...previous, snapshotProgress: 0.22 }, 1_100);
    expect(reconciled).toBe(previous);
    expect(getWorkDisplayProgress(reconciled, 1_100)).toBeGreaterThan(0.67);
    const paused = reconcileWorkDisplaySnapshot(previous, { ...previous, snapshotProgress: 0.22, active: false }, 1_100);
    expect(paused.snapshotProgress).toBe(0.22);
  });

  it("does not rebase an active cycle to a delayed snapshot after the visual clock wraps", () => {
    const previous = {
      mode: "cycle" as const,
      semanticKey: "machine:magnet",
      snapshotProgress: 0.9,
      publishedAtMs: 1_000,
      cyclesPerSecond: 2 / 3,
      effectiveSimulationMultiplier: 1,
      active: true,
    };
    expect(getWorkDisplayProgress(previous, 1_100)).toBeCloseTo(0.966666, 5);
    expect(getWorkDisplayProgress(previous, 1_200)).toBeCloseTo(0.033333, 5);

    const afterNaturalWrap = reconcileWorkDisplaySnapshot(previous, { ...previous, snapshotProgress: 0.55 }, 1_200);
    expect(afterNaturalWrap).toBe(previous);
    expect(getWorkDisplayProgress(afterNaturalWrap, 1_200)).toBeCloseTo(0.033333, 5);

    const beforeNaturalWrap = reconcileWorkDisplaySnapshot(previous, { ...previous, snapshotProgress: 0.55 }, 1_100);
    expect(beforeNaturalWrap).toBe(previous);
  });

  it("keeps the delayed-publication regression on the monotonic phase", () => {
    const previous = {
      mode: "cycle" as const,
      semanticKey: "machine:magnet",
      snapshotProgress: 0.96387,
      publishedAtMs: 1_000,
      cyclesPerSecond: 2 / 3,
      effectiveSimulationMultiplier: 1,
      active: true,
    };
    const publishedAtMs = 1_145.9;
    const reconciled = reconcileWorkDisplaySnapshot(
      previous,
      { ...previous, snapshotProgress: 0.88607 },
      publishedAtMs,
    );

    expect(reconciled).toBe(previous);
    expect(getWorkDisplayProgress(reconciled, publishedAtMs)).toBeCloseTo(0.061136, 5);
  });

  it("keeps the one-hour simulation hash identical for every visual refresh profile", () => {
    const initial = createInitialState(9_090_909);
    const expectedHash = hashGameState(advanceSimulation(initial, 60 * 60));
    for (const profile of PRODUCTION_REFRESH_PROFILES) {
      // Refresh profiles are intentionally not passed into the simulation.
      expect({ profile: profile.id, hash: hashGameState(advanceSimulation(initial, 60 * 60)) }).toEqual({
        profile: profile.id,
        hash: expectedHash,
      });
    }
  }, 15_000);
});
