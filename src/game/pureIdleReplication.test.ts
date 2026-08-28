import { describe, expect, it } from "vitest";
import {
  getPureIdleReplicationResearchLevelTotal,
  isPureIdleReplicationUnlocked,
} from "./endgame";
import { createInitialState } from "./engine";
import {
  advancePureIdleMacroSession,
  createPureIdleMacroSession,
  finalizePureIdleMacroCandidate,
} from "./pureIdleMacro";
import {
  getPureIdleReplicationReadiness,
  PURE_IDLE_REPLICATION_ALGORITHM_VERSION,
} from "./pureIdleReplication";
import { capturePureIdleReplicationTelemetry } from "./pureIdleReplicationTelemetry";
import type {
  GameState,
  ProductionHistorySample,
  PureIdleReplicationTelemetry,
} from "./types";

function unlock(state: GameState, total = 201): void {
  const ids = [
    "matrix_compression",
    "vein_utilization",
    "galactic_logistics",
    "stellar_harnessing",
    "continuum_simulation",
  ] as const;
  ids.forEach((id) => {
    state.endgame.infiniteResearch[id] = { level: 0, progress: "0" };
  });
  state.endgame.infiniteResearch.matrix_compression.level = total;
}

function telemetry({
  iron = 0,
  white = 0,
  rocketItems = 0,
  sailItems = 0,
  research = 0,
  rockets = 0,
  sails = 0,
}: {
  iron?: number;
  white?: number;
  rocketItems?: number;
  sailItems?: number;
  research?: number;
  rockets?: number;
  sails?: number;
}): PureIdleReplicationTelemetry {
  return {
    totalProduced: {
      iron_ingot: String(iron),
      universe_matrix: String(white),
      small_carrier_rocket: String(rocketItems),
      solar_sail: String(sailItems),
    },
    researchInvestmentByItem: { universe_matrix: String(research) },
    structurePointsBySystem: { helios: rockets },
    shellSailsBySystem: { helios: sails },
  };
}

function sample(elapsedSeconds: number, pureIdleReplication: PureIdleReplicationTelemetry): ProductionHistorySample {
  return {
    elapsedSeconds,
    sampleDurationSeconds: 1,
    productionPerMinute: {},
    consumptionPerMinute: {},
    inventory: {},
    generationKw: 0,
    demandKw: 0,
    pureIdleReplication,
  };
}

function replicationState(windowSeconds = 60): GameState {
  const state = createInitialState(undefined, false);
  unlock(state);
  state.paused = false;
  state.timeWarp.enabled = true;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  state.totalProduced.iron_ingot = 160;
  state.totalProduced.universe_matrix = 30;
  state.dysonPlans.helios.structurePoints = 14;
  state.dysonPlans.helios.shellSails = 5;
  state.dysonSphere.totalSailsAbsorbed = 5;
  state.endgame.activeInfiniteResearchId = "matrix_compression";
  state.productionHistory = [
    sample(0, telemetry({ iron: 100, white: 10, rocketItems: 20, sailItems: 40, research: 1_000, rockets: 10, sails: 2 })),
    sample(windowSeconds, telemetry({ iron: 160, white: 30, rocketItems: 26, sailItems: 52, research: 1_120, rockets: 14, sails: 5 })),
  ];
  state.historyRecordedAt = windowSeconds;
  state.elapsedSeconds = windowSeconds;
  return state;
}

describe("pure-idle production replication", () => {
  it("unlocks only when the five infinite technologies total more than 200", () => {
    const state = createInitialState(undefined, false);
    unlock(state, 200);
    expect(getPureIdleReplicationResearchLevelTotal(state)).toBe(200);
    expect(isPureIdleReplicationUnlocked(state)).toBe(false);
    unlock(state, 201);
    expect(getPureIdleReplicationResearchLevelTotal(state)).toBe(201);
    expect(isPureIdleReplicationUnlocked(state)).toBe(true);
  });

  it("reads an existing 60-second window and falls back to 30 without simulating either", () => {
    const preferred = getPureIdleReplicationReadiness(replicationState(60).productionHistory);
    expect(preferred.ok && preferred.contract.windowSeconds).toBe(60);
    const fallback = getPureIdleReplicationReadiness(replicationState(30).productionHistory);
    expect(fallback.ok && fallback.contract.windowSeconds).toBe(30);
    const missing = replicationState(29);
    const unavailable = getPureIdleReplicationReadiness(missing.productionHistory);
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.reason).toContain("至少 30");
  });

  it("keeps endgame totals above the safe-integer boundary usable and monotonic", () => {
    const state = replicationState();
    const huge = 19_600_000_000_000_000;
    state.totalProduced.universe_matrix = huge;
    state.productionHistory = [
      sample(0, {
        ...telemetry({}),
        totalProduced: { universe_matrix: "19599999999999900" },
      }),
      sample(60, {
        ...telemetry({}),
        totalProduced: { universe_matrix: "19600000000000000" },
      }),
    ];
    const session = createPureIdleMacroSession(state, "replication");
    advancePureIdleMacroSession(session, 60);
    expect(state.totalProduced.universe_matrix).toBeGreaterThanOrEqual(huge);
    expect(BigInt(state.quantumLogisticsNetwork.inventory.universe_matrix ?? "0")).toBe(100n);
  });

  it("captures huge runtime counters and finite-tech completion monotonically", () => {
    const state = createInitialState(undefined, false);
    state.totalProduced.universe_matrix = 19_600_000_000_000_000;
    state.research.progressByTech.electromagnetism = { electromagnetic_matrix: 4 };
    const before = capturePureIdleReplicationTelemetry(state)!;
    expect(before.totalProduced.universe_matrix).toBe("19600000000000000");
    expect(before.researchInvestmentByItem.electromagnetic_matrix).toBe("4");

    state.research.progressByTech.electromagnetism = {};
    state.research.completedTechIds.push("electromagnetism");
    const after = capturePureIdleReplicationTelemetry(state)!;
    expect(BigInt(after.researchInvestmentByItem.electromagnetic_matrix ?? "0")).toBeGreaterThanOrEqual(
      BigInt(before.researchInvestmentByItem.electromagnetic_matrix ?? "0"),
    );
  });

  it("copies only terminal materials plus research, rockets and sails without debiting source inventory", () => {
    const state = replicationState();
    state.tray.iron_ore = 77;
    const beforeProgress = BigInt(state.endgame.infiniteResearch.matrix_compression.progress);
    const session = createPureIdleMacroSession(state, "replication");
    expect(session.settledWallSeconds).toBe(0);
    const summary = advancePureIdleMacroSession(session, 60);
    expect(summary.algorithmVersion).toBe(PURE_IDLE_REPLICATION_ALGORITHM_VERSION);
    expect(summary.minimumEfficiency).toBe(1);
    expect(state.tray.iron_ore).toBe(77);
    expect(BigInt(state.quantumLogisticsNetwork.inventory.iron_ingot ?? "0")).toBe(0n);
    expect(BigInt(state.quantumLogisticsNetwork.inventory.universe_matrix ?? "0")).toBeGreaterThan(0n);
    expect(BigInt(state.quantumLogisticsNetwork.inventory.small_carrier_rocket ?? "0")).toBeGreaterThan(0n);
    expect(BigInt(state.quantumLogisticsNetwork.inventory.solar_sail ?? "0")).toBeGreaterThan(0n);
    expect(BigInt(state.endgame.infiniteResearch.matrix_compression.progress)).toBeGreaterThan(beforeProgress);
    expect(state.dysonPlans.helios.structurePoints).toBeGreaterThan(14);
    expect(state.dysonPlans.helios.shellSails).toBeGreaterThan(5);
  });

  it("applies the locked power multiplier to copied output instead of only displaying it", () => {
    const state = replicationState();
    state.timeWarp.controllerEntityId = "locked-time-warp-controller";
    state.timeWarp.requestedMultiplier = 15;
    state.timeWarp.effectiveMultiplier = 15;
    const session = createPureIdleMacroSession(state, "replication");
    expect(session.actualMultiplier).toBe(15);

    const summary = advancePureIdleMacroSession(session, 60);

    // Intermediate iron is deliberately excluded. The locked sample produced
    // 20 white matrices in 60 simulation seconds, so one real minute at 15x
    // copies exactly 300 terminal matrices.
    expect(BigInt(state.quantumLogisticsNetwork.inventory.iron_ingot ?? "0")).toBe(0n);
    expect(BigInt(state.quantumLogisticsNetwork.inventory.universe_matrix ?? "0")).toBe(300n);
    expect(summary.actualMultiplier).toBe(15);
    expect(summary.settledSimulationSeconds).toBe(900);
    expect(summary.current.whiteMatrixProduced - summary.baseline.whiteMatrixProduced).toBe(300);
    expect(summary.current.rocketsLaunched - summary.baseline.rocketsLaunched).toBe(60);
  });

  it("is deterministic across one-shot and segmented wall-clock advances", () => {
    const wholeState = replicationState();
    const segmentedState = structuredClone(wholeState);
    const whole = createPureIdleMacroSession(wholeState, "replication");
    const segmented = createPureIdleMacroSession(segmentedState, "replication");
    advancePureIdleMacroSession(whole, 95.25);
    advancePureIdleMacroSession(segmented, 31.75);
    advancePureIdleMacroSession(segmented, 95.25);
    expect(segmentedState.quantumLogisticsNetwork.inventory).toEqual(wholeState.quantumLogisticsNetwork.inventory);
    expect(segmentedState.totalProduced).toEqual(wholeState.totalProduced);
    expect(segmentedState.endgame.infiniteResearch).toEqual(wholeState.endgame.infiniteResearch);
    expect(segmentedState.dysonPlans).toEqual(wholeState.dysonPlans);
  });

  it("initializes and advances without traversing the entity or belt graph", () => {
    const state = replicationState();
    Object.defineProperty(state, "entities", {
      configurable: true,
      get: () => { throw new Error("replication traversed entities"); },
    });
    Object.defineProperty(state, "belts", {
      configurable: true,
      get: () => { throw new Error("replication traversed belts"); },
    });
    const session = createPureIdleMacroSession(state, "replication");
    const summary = advancePureIdleMacroSession(session, 60);
    expect(summary.settledWallSeconds).toBe(60);
    expect(summary.minimumEfficiency).toBe(1);
  });

  it("finalizes the explicitly non-conserving candidate without the legacy conservation gate", () => {
    const state = replicationState();
    const session = createPureIdleMacroSession(state, "replication");
    state.tray.iron_ore = 999_999;
    const finalized = finalizePureIdleMacroCandidate(session, 60);
    expect(finalized.state.timeWarp.enabled).toBe(false);
    expect(finalized.summary.validationFailures).toBe(0);
    expect(finalized.summary.limitingReason).toContain("不消耗原料");
  });
});
