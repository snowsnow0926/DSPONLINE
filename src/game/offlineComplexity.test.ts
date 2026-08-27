import { describe, expect, it } from "vitest";
import { createPlayerInitialState } from "./engine";
import { classifyOfflineWorkload } from "./offlineComplexity";

describe("offline workload classification", () => {
  it("keeps a short ordinary factory on the exact path", () => {
    const state = createPlayerInitialState();
    const report = classifyOfflineWorkload(state, 10, {
      device: { deviceMemoryGb: 8, hardwareConcurrency: 8, coarsePointer: false, workerSupported: true },
    });
    expect(report.profile).toBe("simple");
    expect(report.recommendedStrategy).toBe("exact");
    expect(report.recommendedDeadlineMs).toBe(0);
  });

  it("routes a large complex save conservatively only on a low-memory device", () => {
    const state = createPlayerInitialState();
    const template = state.entities[0];
    state.entities = Array.from({ length: 4_000 }, (_, index) => ({
      ...structuredClone(template),
      id: `complex_entity_${index}`,
      inputs: { hydrogen: index % 2 },
      outputs: { deuterium: index % 3 },
    }));
    state.belts = Array.from({ length: 9_000 }, (_, index) => ({
      id: `complex_belt_${index}`,
      planetId: "home" as const,
      source: `complex_entity_${index % 4_000}`,
      target: `complex_entity_${(index + 1) % 4_000}`,
      itemId: "hydrogen" as const,
      lanes: 1,
      tier: 1,
      sorterTier: 1 as const,
      progress: 0,
      priority: 1 as const,
      lastFlow: 0,
    }));
    const low = classifyOfflineWorkload(state, 30 * 24 * 60 * 60, {
      serializedBytes: 20 * 1024 * 1024,
      device: { deviceMemoryGb: 2, hardwareConcurrency: 2, coarsePointer: true, workerSupported: true },
    });
    const desktop = classifyOfflineWorkload(state, 30 * 24 * 60 * 60, {
      serializedBytes: 20 * 1024 * 1024,
      device: { deviceMemoryGb: 16, hardwareConcurrency: 12, coarsePointer: false, workerSupported: true },
    });
    expect(low.profile).toBe("complex");
    expect(low.recommendedStrategy).toBe("conservative");
    expect(low.warning).toContain("低内存");
    expect(desktop.recommendedStrategy).toBe("fast");
    expect(desktop.recommendedDeadlineMs).toBe(90_000);
  });

  it("uses the single-candidate fast path for a large save on a standard desktop", () => {
    const state = createPlayerInitialState();
    const report = classifyOfflineWorkload(state, 30 * 24 * 60 * 60, {
      serializedBytes: 80 * 1024 * 1024,
      device: { deviceMemoryGb: 16, hardwareConcurrency: 12, coarsePointer: false, workerSupported: true },
    });
    expect(report.recommendedStrategy).toBe("fast");
    expect(report.recommendedDeadlineMs).toBe(90_000);
    expect(report.warning).toContain("内存");
  });

  it("gives large fast calibration enough time while retaining the low-memory conservative boundary", () => {
    const state = createPlayerInitialState();
    const constrained = classifyOfflineWorkload(state, 30 * 24 * 60 * 60, {
      serializedBytes: 80 * 1024 * 1024,
      device: { deviceMemoryGb: 6, hardwareConcurrency: 4, coarsePointer: false, workerSupported: true },
    });
    const lowMemory = classifyOfflineWorkload(state, 30 * 24 * 60 * 60, {
      serializedBytes: 80 * 1024 * 1024,
      device: { deviceMemoryGb: 2, hardwareConcurrency: 2, coarsePointer: true, workerSupported: true },
    });
    expect(constrained.recommendedStrategy).toBe("fast");
    expect(constrained.recommendedDeadlineMs).toBe(120_000);
    expect(lowMemory.recommendedStrategy).toBe("conservative");
    expect(lowMemory.recommendedDeadlineMs).toBe(180_000);
  });

  it("never changes the input state and keeps speedrun work exact", () => {
    const state = createPlayerInitialState();
    const before = JSON.stringify(state);
    state.speedrun = {
      enabled: true,
      mode: "speedrun",
      rulesetVersion: "speedrun-v1",
      seasonId: "season_01",
      startedAt: 1,
      elapsedActiveSeconds: 1,
      baseline: { completedTechIds: [], rocketsLaunched: 0, whiteMatrixProduced: 0 },
      milestones: {
        all_technologies: { completed: false },
        dyson_rockets_10000: { completed: false },
        white_matrix_1m: { completed: false },
      },
      eligible: true,
      factoryId: "speedrun_complexity_test",
    };
    const speedrunBefore = JSON.stringify(state);
    const report = classifyOfflineWorkload(state, 30 * 24 * 60 * 60, {
      device: { deviceMemoryGb: 1, hardwareConcurrency: 1, coarsePointer: true, workerSupported: true },
    });
    expect(report.recommendedStrategy).toBe("exact");
    expect(JSON.stringify(state)).toBe(speedrunBefore);
    expect(before).not.toBe(speedrunBefore);
  });
});
