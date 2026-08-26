import { describe, expect, it } from "vitest";
import { createContentPackRegistry } from "./contentPacks";
import { createInitialState } from "./engine";
import { hashGameState } from "./benchmark";
import {
  applyPureIdleMacroFinalState,
  advancePureIdleMacroSession,
  createConservativePureIdleMacroSession,
  createPureIdleMacroSession,
  PURE_IDLE_MACRO_ALGORITHM_VERSION,
  PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS,
  PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS,
} from "./pureIdleMacro";
import { finalizePureIdleMacroSession } from "./pureIdleMacroValidation";
import { applyPureIdleAffineContract, type PureIdleAffineContract } from "./offlineApproximation";
import type { GameState } from "./types";

function pureIdleState(): GameState {
  const state = createInitialState(undefined, false);
  state.entities = [{
    id: "pure-idle-controller",
    kind: "machine",
    planetId: "home",
    position: { x: 0, y: 0 },
    interactionLocked: false,
    buildingId: "time_warp_device",
    machineCount: 1,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  }];
  state.belts = [];
  state.constructionAutomation.enabled = false;
  state.paused = false;
  state.timeWarp.controllerEntityId = "pure-idle-controller";
  state.timeWarp.enabled = true;
  state.timeWarp.effectiveMultiplier = state.settings.simulationSpeed;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  return state;
}

function addWindGeneration(state: GameState, machineCount: number): void {
  state.entities.push({
    id: `pure-idle-wind-${machineCount}`,
    kind: "power",
    planetId: "home",
    position: { x: -100, y: 0 },
    interactionLocked: false,
    buildingId: "wind_turbine",
    machineCount,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
}

function addProductiveSmelter(state: GameState, machineCount = 1_000): void {
  addWindGeneration(state, 50_000_000);
  state.entities.push({
    id: "pure-idle-smelter",
    kind: "machine",
    planetId: "home",
    position: { x: 100, y: 0 },
    interactionLocked: false,
    buildingId: "arc_smelter",
    recipeId: "iron_ingot",
    machineCount,
    minerCount: 0,
    inputs: { iron_ore: machineCount * 100 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
}

function conservativeQuantumConstructionState(options: {
  target?: number;
  centerStack?: number;
  towerStack?: number;
  inventory?: Partial<Record<"iron_ore" | "copper_ore" | "stone", string>>;
} = {}): GameState {
  const state = pureIdleState();
  state.settings.simulationSpeed = 4;
  state.timeWarp.requestedMultiplier = 9;
  state.research.completedTechIds.push("construction_automation", "construction_capacity_2");
  state.constructionAutomation.enabled = true;
  state.constructionAutomation.quantumSourceEnabled = true;
  state.constructionAutomation.targetStock.arc_smelter = options.target ?? 50_000;
  state.construction.arc_smelter = 0;
  state.tray = {};
  state.planetTrays.home = state.tray;
  state.quantumLogisticsNetwork.enabled = true;
  state.quantumLogisticsNetwork.inventory = {
    iron_ore: "1000000",
    copper_ore: "1000000",
    stone: "1000000",
    ...options.inventory,
  };
  addWindGeneration(state, 50_000_000);
  state.entities.push(
    {
      id: "conservative-construction-center",
      kind: "machine",
      planetId: "home",
      position: { x: 100, y: 0 },
      interactionLocked: false,
      buildingId: "construction_center",
      machineCount: options.centerStack ?? 10_000,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    },
    {
      id: "conservative-quantum-tower",
      kind: "station",
      planetId: "home",
      position: { x: 200, y: 0 },
      interactionLocked: false,
      buildingId: "interstellar_logistics_station",
      stationTier: 2,
      quantumMode: "quantum",
      stationSlots: [],
      stationRoutes: [],
      machineCount: options.towerStack ?? 100,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    },
  );
  return state;
}

describe("pure idle macro session", () => {
  it("binds stop settlement, completed research, and the original pause intent before serialization", () => {
    const baseline = pureIdleState();
    baseline.idleSettlement = {
      currentRunStartedAt: 1_000,
      currentRunElapsed: 30,
      lastSettledAt: 30,
      totalIdleTime: 40,
      currentRunProduction: { iron_ore: 2 },
      totalProduction: { iron_ore: 7 },
    };
    baseline.totalProduced.iron_ore = 10;
    const candidate = structuredClone(baseline);
    candidate.totalProduced.iron_ore = 18;
    candidate.research.completedTechIds.push("antimatter");
    candidate.research.selectedTechId = "universe_matrix";
    candidate.research.queuedTechIds = ["micro_black_hole_containment"];
    candidate.research.progressByTech.universe_matrix = {
      electromagnetic_matrix: 100,
      energy_matrix: 100,
      structure_matrix: 100,
      information_matrix: 100,
      gravity_matrix: 100,
    };
    candidate.paused = false;
    candidate.timeWarp.pendingSimulationSeconds = 12;
    candidate.timeWarp.pendingWallSeconds = 3;

    const finalized = applyPureIdleMacroFinalState(candidate, 90, {
      startedPaused: true,
      baselineIdleSettlement: baseline.idleSettlement,
      baselineTotalProduced: baseline.totalProduced,
    });

    expect(finalized).not.toBe(candidate);
    expect(candidate.research.completedTechIds).not.toContain("universe_matrix");
    expect(finalized.research.completedTechIds).toContain("universe_matrix");
    expect(finalized.research.selectedTechId).toBe("micro_black_hole_containment");
    expect(finalized.paused).toBe(true);
    expect(finalized.timeWarp).toMatchObject({ pendingSimulationSeconds: 0, pendingWallSeconds: 0 });
    expect(finalized.idleSettlement).toMatchObject({
      currentRunStartedAt: null,
      currentRunElapsed: 90,
      lastSettledAt: 90,
      totalIdleTime: 100,
      currentRunProduction: { iron_ore: 8 },
      totalProduction: { iron_ore: 13 },
    });
  });

  it("uses three fixed calibration windows and advances only committed wall time", () => {
    const source = pureIdleState();
    const before = hashGameState(source);
    const session = createPureIdleMacroSession(structuredClone(source), "stable");

    const summary = advancePureIdleMacroSession(session, 90);

    expect(summary.algorithmVersion).toBe(PURE_IDLE_MACRO_ALGORITHM_VERSION);
    expect(summary.calibrationWindowsCompleted).toBe(3);
    expect(summary.settledWallSeconds).toBe(90);
    expect(summary.settledSimulationSeconds).toBe(90 * source.settings.simulationSpeed);
    expect(session.candidate.elapsedSeconds - source.elapsedSeconds).toBeCloseTo(summary.settledSimulationSeconds, 6);
    expect(hashGameState(source)).toBe(before);
  });

  it("refreshes a stale stopped multiplier to the requested 9x power allocation", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    source.timeWarp.effectiveMultiplier = 1;
    addWindGeneration(source, 50_000_000);

    const session = createPureIdleMacroSession(structuredClone(source), "extreme");
    const summary = advancePureIdleMacroSession(session, 30);

    expect(summary.requestedMultiplier).toBe(9);
    expect(summary.powerLimitedMultiplier).toBe(9);
    expect(summary.actualMultiplier).toBe(9);
    expect(summary.settledSimulationSeconds).toBe(270);
  });

  it("keeps an interaction-locked controller powered during macro startup", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    source.timeWarp.effectiveMultiplier = 1;
    const controller = source.entities.find((entity) => entity.id === source.timeWarp.controllerEntityId)!;
    controller.interactionLocked = true;
    addWindGeneration(source, 50_000_000);

    const summary = advancePureIdleMacroSession(
      createPureIdleMacroSession(structuredClone(source), "extreme"),
      30,
    );

    expect(summary.powerLimitedMultiplier).toBe(9);
    expect(summary.actualMultiplier).toBe(9);
    expect(summary.settledSimulationSeconds).toBe(270);
  });

  it("uses the highest power-supported 7x multiplier instead of the stale value", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    source.timeWarp.effectiveMultiplier = 1;
    addWindGeneration(source, 1_000_000);

    const summary = advancePureIdleMacroSession(
      createPureIdleMacroSession(structuredClone(source), "extreme"),
      30,
    );

    expect(summary.powerLimitedMultiplier).toBe(7);
    expect(summary.settledSimulationSeconds).toBe(210);
  });

  it("is deterministic across incremental and one-target settlement", () => {
    const source = pureIdleState();
    const incremental = createPureIdleMacroSession(structuredClone(source), "stable");
    advancePureIdleMacroSession(incremental, 30);
    advancePureIdleMacroSession(incremental, 60);
    advancePureIdleMacroSession(incremental, 90);

    const single = createPureIdleMacroSession(structuredClone(source), "stable");
    advancePureIdleMacroSession(single, 90);

    expect(hashGameState(incremental.candidate)).toBe(hashGameState(single.candidate));
    expect(incremental.settledSimulationSeconds).toBe(single.settledSimulationSeconds);
  });

  it("runs fixed shadow validation only in stable mode", () => {
    const source = pureIdleState();
    const stable = createPureIdleMacroSession(structuredClone(source), "stable");
    const extreme = createPureIdleMacroSession(structuredClone(source), "extreme");

    const stableSummary = advancePureIdleMacroSession(stable, PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS);
    const extremeSummary = advancePureIdleMacroSession(extreme, PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS * 2);

    expect(stableSummary.validationCount + stableSummary.validationFailures).toBe(1);
    expect(stableSummary.nextValidationAtWallSeconds).toBe(PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS * 2);
    expect(extremeSummary.validationCount).toBe(0);
    expect(extremeSummary.validationFailures).toBe(0);
    expect(extremeSummary.nextValidationAtWallSeconds).toBeNull();
  });

  it("reports current terminal efficiency against the immutable calibration rate", () => {
    const session = createPureIdleMacroSession(structuredClone(pureIdleState()), "stable");
    session.calibrationRate.whiteMatrixProduced = 10;
    session.currentRate.whiteMatrixProduced = 5;
    const line = (advancePureIdleMacroSession(session, 0).terminalLines).find((entry) => entry.id === "white-matrix");
    expect(line).toMatchObject({ calibrationRatePerMinute: 600, sustainableRatePerMinute: 300, efficiency: 0.5 });
  });

  it("never extrapolates in-flight route cargo or route progress", () => {
    const source = pureIdleState();
    source.entities[0].stationRoutes = [{
      id: "pure-idle-route",
      slotIndex: 0,
      peerId: "remote-station",
      itemId: "iron_ore",
      scope: "remote",
      cargo: 240,
      vehicleCount: 2,
      progress: 0.25,
      duration: 10_000,
      requiresWarp: false,
    }];
    const session = createPureIdleMacroSession(structuredClone(source), "extreme");

    advancePureIdleMacroSession(session, 24 * 60 * 60);

    const route = session.candidate.entities[0].stationRoutes?.[0];
    expect(route?.cargo).toBe(240);
    expect(route?.progress).toBe(0.25);
  });

  it("rejects a forged contract that attempts to mutate transport progress", () => {
    const state = pureIdleState();
    state.entities[0].stationRoutes = [{
      id: "forged-route",
      slotIndex: 0,
      peerId: "remote-station",
      itemId: "iron_ore",
      scope: "remote",
      cargo: 24,
      vehicleCount: 1,
      progress: 0.5,
      duration: 60,
      requiresWarp: false,
    }];
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [{ path: ["entities", 0, "stationRoutes", 0, "cargo"], kind: "number", delta: -24, integer: true }],
    } as PureIdleAffineContract;

    const result = applyPureIdleAffineContract(state, contract, 1, 1);

    expect(result.ok).toBe(false);
    expect(result.failure).toContain("瞬时字段");
    expect(state.entities[0].stationRoutes?.[0]?.cargo).toBe(24);
  });

  it("round-trips the final candidate through the formal save migration gate", () => {
    const source = pureIdleState();
    const session = createPureIdleMacroSession(structuredClone(source), "extreme");

    const result = finalizePureIdleMacroSession(session, 7 * 24 * 60 * 60, createContentPackRegistry());

    expect(result.state.version).toBe(47);
    expect(result.state.timeWarp.enabled).toBe(false);
    expect(result.state.timeWarp.pendingSimulationSeconds).toBe(0);
    expect(result.state.timeWarp.pendingWallSeconds).toBe(0);
    expect(result.rawBytes).toBeGreaterThan(0);
    expect(result.summary.settledWallSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("rejects an already-negative in-flight route instead of clamping it", () => {
    const source = pureIdleState();
    source.entities[0].stationRoutes = [{
      id: "invalid-route",
      slotIndex: 0,
      peerId: "remote-station",
      itemId: "iron_ore",
      scope: "remote",
      cargo: -1,
      vehicleCount: 1,
      progress: 0.5,
      duration: 60,
      requiresWarp: false,
    }];

    expect(() => createPureIdleMacroSession(structuredClone(source), "stable")).toThrow(/校准|合同/);
    expect(source.entities[0].stationRoutes?.[0].cargo).toBe(-1);
  });

  it("starts macro sessions while finite or infinite research is active", () => {
    const finite = pureIdleState();
    finite.research.selectedTechId = "electromagnetic_matrix";
    const finiteSummary = advancePureIdleMacroSession(
      createPureIdleMacroSession(structuredClone(finite), "stable"),
      0,
    );
    expect(finiteSummary.research).toMatchObject({ kind: "finite", id: "electromagnetic_matrix" });

    const infinite = pureIdleState();
    infinite.research.completedTechIds.push("universe_matrix");
    infinite.endgame.activeInfiniteResearchId = "matrix_compression";
    const infiniteSummary = advancePureIdleMacroSession(
      createPureIdleMacroSession(structuredClone(infinite), "stable"),
      0,
    );
    expect(infiniteSummary.research).toMatchObject({ kind: "infinite", id: "matrix_compression", level: 0 });
  });

  it("rejects a macro bucket that creates inventory without matching production", () => {
    const state = pureIdleState();
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [{ path: ["tray", "iron_ore"], kind: "number", delta: 10, integer: true }],
    } as PureIdleAffineContract;

    const result = applyPureIdleAffineContract(state, contract, 1, 1);
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("物资守恒失败");
  });

  it("accepts a macro bucket whose aggregate stock increase matches production", () => {
    const state = pureIdleState();
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [
        { path: ["tray", "iron_ore"], kind: "number", delta: 10, integer: true },
        { path: ["totalProduced", "iron_ore"], kind: "number", delta: 10, integer: true },
      ],
    } as PureIdleAffineContract;

    const result = applyPureIdleAffineContract(state, contract, 1, 1);
    expect(result).toMatchObject({ ok: true });
    expect(state.tray.iron_ore).toBe(110);
    expect(state.totalProduced.iron_ore).toBe(10);
  });

  it("settles a bounded exact prefix before freezing the uncertain conservative tail", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    addWindGeneration(source, 50_000_000);
    const sourceHash = hashGameState(source);
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "injected repeated Worker crash",
    );

    expect(session.calibrationCheckpoint).toBeDefined();
    expect(session.candidate.elapsedSeconds - source.elapsedSeconds).toBeCloseTo(
      PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS,
      6,
    );
    expect(session.lastValidationReason).toContain("已先精确结算");

    const summary = advancePureIdleMacroSession(session, 30 * 24 * 60 * 60);
    const finalized = finalizePureIdleMacroSession(session, 30 * 24 * 60 * 60, createContentPackRegistry());

    expect(summary).toMatchObject({
      phase: "conservative",
      conservativeOnly: true,
      calibrationWindowsCompleted: 0,
      settledWallSeconds: 30 * 24 * 60 * 60,
      settledSimulationSeconds: 9 * 30 * 24 * 60 * 60,
    });
    expect(summary.degradedReason).toContain("injected repeated Worker crash");
    expect(finalized.state.elapsedSeconds - source.elapsedSeconds).toBe(9 * 30 * 24 * 60 * 60);
    expect(finalized.state.tray).toEqual(source.tray);
    expect(finalized.state.entities.find((entity) => entity.id === "pure-idle-controller")).toMatchObject({
      buildingId: "time_warp_device",
      machineCount: 1,
    });
    expect(finalized.state.entities.find((entity) => entity.id === "pure-idle-wind-50000000")).toMatchObject({
      buildingId: "wind_turbine",
      machineCount: 50_000_000,
    });
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps measured cumulative production running in the conservative high-multiplier tail", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    addProductiveSmelter(source);
    const sourceHash = hashGameState(source);
    const baselineProduced = source.totalProduced.iron_ingot ?? 0;
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "large-save memory guard",
    );

    expect(session.contractVersion).toBe(1);
    expect(session.calibrationWindowsCompleted).toBe(1);
    expect(session.contract.deltas.some((delta) =>
      JSON.stringify(delta.path) === JSON.stringify(["totalProduced", "iron_ingot"]),
    )).toBe(true);

    const summary = advancePureIdleMacroSession(session, 24 * 60 * 60);
    const finalized = finalizePureIdleMacroSession(session, 24 * 60 * 60, createContentPackRegistry());
    expect(summary.phase).toBe("conservative");
    expect(summary.actualMultiplier).toBe(9);
    expect(finalized.state.elapsedSeconds - source.elapsedSeconds).toBe(9 * 24 * 60 * 60);
    expect(finalized.state.totalProduced.iron_ingot ?? 0).toBeGreaterThan(baselineProduced);
    expect(finalized.state.tray).toEqual(session.candidate.tray);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps compact conservative counters deterministic across idle boundaries", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    addProductiveSmelter(source, 1_000);
    const incremental = createConservativePureIdleMacroSession(structuredClone(source), "stable", "memory guard");
    advancePureIdleMacroSession(incremental, 60 * 60);
    advancePureIdleMacroSession(incremental, 2 * 60 * 60);

    const single = createConservativePureIdleMacroSession(structuredClone(source), "stable", "memory guard");
    advancePureIdleMacroSession(single, 2 * 60 * 60);

    expect(hashGameState(incremental.candidate)).toBe(hashGameState(single.candidate));
    expect(incremental.conservativeIntegerRemainders).toEqual(single.conservativeIntegerRemainders);
    expect(incremental.researchRemainder).toBe(single.researchRemainder);
  });

  it("keeps quantum-fed construction running through the conservative large-save tail", () => {
    const source = conservativeQuantumConstructionState({
      target: 100_000_000,
      centerStack: 12_200_000,
      towerStack: 1_000_000,
      inventory: { iron_ore: "3000000000", copper_ore: "1000000000", stone: "1000000000" },
    });
    const sourceHash = hashGameState(source);
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "large-save memory guard",
    );

    expect(session.candidate.construction.arc_smelter).toBeLessThan(100_000_000);
    advancePureIdleMacroSession(session, 30);

    expect(session.candidate.construction.arc_smelter).toBe(100_000_000);
    expect(session.candidate.constructionAutomation.totalCrafted).toBe(100_000_000);
    expect(session.candidate.constructionAutomation.jobs).toEqual({});
    expect(session.candidate.constructionAutomation.quantumMaterialBuffer).toBeUndefined();
    expect(Object.keys(session.candidate.tray)).toHaveLength(0);
    expect(Number(session.candidate.quantumLogisticsNetwork.inventory.iron_ore ?? "0")).toBeLessThan(3_000_000_000);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("never invents a missing quantum raw material in the conservative construction tail", () => {
    const source = conservativeQuantumConstructionState({
      target: 10_000,
      inventory: { iron_ore: "1000000", copper_ore: "0", stone: "0" },
    });
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "large-save memory guard",
    );

    advancePureIdleMacroSession(session, 24 * 60 * 60);

    expect(session.candidate.construction.arc_smelter).toBe(0);
    expect(session.candidate.constructionAutomation.totalCrafted).toBe(0);
    expect(session.candidate.quantumLogisticsNetwork.inventory.copper_ore ?? "0").toBe("0");
    expect(session.candidate.quantumLogisticsNetwork.inventory.stone ?? "0").toBe("0");
    for (const inventory of Object.values(session.candidate.constructionAutomation.quantumMaterialBuffer ?? {})) {
      expect(inventory.copper_ore ?? 0).toBe(0);
      expect(inventory.stone ?? 0).toBe(0);
    }
    expect(session.candidate.tray.copper_ore ?? 0).toBe(0);
    expect(session.candidate.tray.stone ?? 0).toBe(0);
  });

  it("settles conservative quantum construction deterministically across macro boundaries", () => {
    const source = conservativeQuantumConstructionState();
    const incremental = createConservativePureIdleMacroSession(structuredClone(source), "stable", "memory guard");
    advancePureIdleMacroSession(incremental, 15);
    advancePureIdleMacroSession(incremental, 30);

    const single = createConservativePureIdleMacroSession(structuredClone(source), "stable", "memory guard");
    advancePureIdleMacroSession(single, 30);

    expect(hashGameState(incremental.candidate)).toBe(hashGameState(single.candidate));
    expect(incremental.candidate.construction.arc_smelter).toBe(50_000);
  });

  it("honours cancellation before mutating a macro boundary", () => {
    const session = createPureIdleMacroSession(structuredClone(pureIdleState()), "extreme");
    const before = hashGameState(session.candidate);

    expect(() => advancePureIdleMacroSession(session, 24 * 60 * 60, {
      shouldCancel: () => true,
    })).toThrowError(/取消/);
    expect(hashGameState(session.candidate)).toBe(before);
    expect(session.settledWallSeconds).toBe(0);
  });

  it("honours an expired deadline before calibration starts", () => {
    expect(() => createPureIdleMacroSession(structuredClone(pureIdleState()), "stable", {
      deadlineAtMs: -1,
    })).toThrowError(/现实时间上限/);
  });
});
