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
  research = 0,
  rockets = 0,
  sails = 0,
}: {
  research?: number;
  rockets?: number;
  sails?: number;
}): PureIdleReplicationTelemetry {
  return {
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
    sample(0, telemetry({ research: 1_000, rockets: 10, sails: 2 })),
    sample(windowSeconds, telemetry({ research: 1_120, rockets: 14, sails: 5 })),
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

  it("leaves physical production totals above the safe-integer boundary untouched", () => {
    const state = replicationState();
    const huge = 19_600_000_000_000_000;
    state.totalProduced.universe_matrix = huge;
    const beforeProgress = BigInt(state.endgame.infiniteResearch.matrix_compression.progress);
    const session = createPureIdleMacroSession(state, "replication");
    advancePureIdleMacroSession(session, 60);
    expect(state.totalProduced.universe_matrix).toBe(huge);
    expect(state.quantumLogisticsNetwork.inventory.universe_matrix).toBeUndefined();
    expect(BigInt(state.endgame.infiniteResearch.matrix_compression.progress)).toBeGreaterThan(beforeProgress);
  });

  it("captures white-matrix research monotonically without material-production telemetry", () => {
    const state = createInitialState(undefined, false);
    state.totalProduced.universe_matrix = 19_600_000_000_000_000;
    state.research.progressByTech.electromagnetism = { electromagnetic_matrix: 4 };
    state.endgame.infiniteResearch.matrix_compression.progress = "4";
    const before = capturePureIdleReplicationTelemetry(state)!;
    expect(before.researchInvestmentByItem.electromagnetic_matrix).toBeUndefined();
    expect(before.researchInvestmentByItem.universe_matrix).toBe("4");

    state.research.progressByTech.electromagnetism = {};
    state.research.completedTechIds.push("electromagnetism");
    state.endgame.infiniteResearch.matrix_compression.progress = "8";
    const after = capturePureIdleReplicationTelemetry(state)!;
    expect(BigInt(after.researchInvestmentByItem.universe_matrix ?? "0")).toBeGreaterThanOrEqual(
      BigInt(before.researchInvestmentByItem.universe_matrix ?? "0"),
    );
  });

  it("settles research, rockets and sails directly while preserving every player inventory", () => {
    const state = replicationState();
    state.tray.iron_ore = 77;
    state.planetTrays.home = { ...state.planetTrays.home, universe_matrix: 9, small_carrier_rocket: 8, solar_sail: 7 };
    state.quantumLogisticsNetwork.enabled = false;
    state.quantumLogisticsNetwork.inventory = {
      universe_matrix: "11",
      small_carrier_rocket: "22",
      solar_sail: "33",
      iron_ingot: "44",
    };
    state.constructionAutomation.quantumMaterialBuffer = {
      untouched: { universe_matrix: 5, small_carrier_rocket: 4, solar_sail: 3 },
    };
    const trayBefore = structuredClone(state.tray);
    const planetTraysBefore = structuredClone(state.planetTrays);
    const quantumBefore = structuredClone(state.quantumLogisticsNetwork);
    const constructionBuffersBefore = structuredClone(state.constructionAutomation.quantumMaterialBuffer);
    const entitiesBefore = structuredClone(state.entities);
    const producedBefore = structuredClone(state.totalProduced);
    const beforeProgress = BigInt(state.endgame.infiniteResearch.matrix_compression.progress);
    const session = createPureIdleMacroSession(state, "replication");
    expect(session.settledWallSeconds).toBe(0);
    const summary = advancePureIdleMacroSession(session, 60);
    expect(summary.algorithmVersion).toBe(PURE_IDLE_REPLICATION_ALGORITHM_VERSION);
    expect(summary.minimumEfficiency).toBe(1);
    expect(state.tray).toEqual(trayBefore);
    expect(state.planetTrays).toEqual(planetTraysBefore);
    expect(state.quantumLogisticsNetwork).toEqual(quantumBefore);
    expect(state.constructionAutomation.quantumMaterialBuffer).toEqual(constructionBuffersBefore);
    expect(state.entities).toEqual(entitiesBefore);
    expect(state.totalProduced).toEqual(producedBefore);
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

    // The locked sample uploaded 120 white matrices into research in 60
    // simulation seconds, so one real minute at 15x directly uploads 1,800.
    expect(BigInt(state.quantumLogisticsNetwork.inventory.iron_ingot ?? "0")).toBe(0n);
    expect(BigInt(state.quantumLogisticsNetwork.inventory.universe_matrix ?? "0")).toBe(0n);
    expect(state.totalProduced.universe_matrix).toBe(30);
    expect(summary.actualMultiplier).toBe(15);
    expect(summary.settledSimulationSeconds).toBe(900);
    expect(summary.current.whiteMatrixProduced - summary.baseline.whiteMatrixProduced).toBe(1_800);
    expect(summary.current.rocketsLaunched - summary.baseline.rocketsLaunched).toBe(60);
  });

  it("discards white-matrix settlement when no research sink exists instead of banking it", () => {
    const state = replicationState();
    state.endgame.activeInfiniteResearchId = null;
    state.research.selectedTechId = null;
    const quantumBefore = structuredClone(state.quantumLogisticsNetwork);
    const session = createPureIdleMacroSession(state, "replication");
    const initialSummary = advancePureIdleMacroSession(session, 0);
    expect(initialSummary.ratePerSimulationSecond.whiteMatrixProduced).toBe(0);
    expect(initialSummary.limitingReason).toContain("未结算且未入库");
    const summary = advancePureIdleMacroSession(session, 60);

    expect(summary.current.whiteMatrixProduced).toBe(summary.baseline.whiteMatrixProduced);
    expect(summary.ratePerSimulationSecond.whiteMatrixProduced).toBe(0);
    expect(summary.minimumEfficiency).toBe(0);
    expect(summary.limitingReason).toContain("未结算且未入库");
    expect(state.quantumLogisticsNetwork).toEqual(quantumBefore);
    expect(state.dysonPlans.helios.structurePoints).toBeGreaterThan(14);
    expect(state.dysonPlans.helios.shellSails).toBeGreaterThan(5);
  });

  it("does not become ready from physical item production without a terminal event", () => {
    const state = replicationState();
    state.totalProduced.universe_matrix = (state.totalProduced.universe_matrix ?? 0) + 1_000_000;
    state.totalProduced.small_carrier_rocket = 1_000_000;
    state.totalProduced.solar_sail = 1_000_000;
    state.productionHistory = [sample(0, telemetry({})), sample(60, telemetry({}))];
    const readiness = getPureIdleReplicationReadiness(state.productionHistory);
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.reason).toContain("没有记录到可复制的正向产出");
  });

  it("keeps the construction megastructure recursively manufacturing from real stock", () => {
    const state = replicationState();
    state.research.completedTechIds.push("construction_automation");
    state.construction.arc_smelter = 0;
    state.constructionAutomation.enabled = true;
    state.constructionAutomation.targetStock.arc_smelter = 2;
    state.tray.iron_ingot = 8;
    state.tray.stone_brick = 4;
    state.tray.circuit_board = 8;
    state.tray.magnetic_coil = 4;
    state.entities.push({
      id: "replication-construction-center",
      kind: "machine",
      planetId: "home",
      position: { x: 160, y: 0 },
      interactionLocked: false,
      buildingId: "construction_center",
      powerGridId: "grid-a",
      machineCount: 100,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 1,
      productionRate: 0,
      powerInputKw: 1_200_000,
      powerFactor: 1,
    });

    const session = createPureIdleMacroSession(state, "replication");
    expect(session.constructionPowerCertificate).toBeDefined();
    advancePureIdleMacroSession(session, 1);

    expect(state.construction.arc_smelter).toBe(2);
    expect(state.constructionAutomation.totalCrafted).toBe(2);
    expect(state.tray.iron_ingot).toBe(0);
    expect(session.lastValidationReason).toContain("建筑制造递归完成 2 件");
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
    state.constructionAutomation.enabled = true;
    state.constructionAutomation.targetStock.arc_smelter = 2;
    state.construction.arc_smelter = 2;
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
