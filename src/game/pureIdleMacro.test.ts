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
import {
  advanceExactSimulationWindow,
  applyPureIdleAffineContract,
  applyPureIdleLightweightContractInPlace,
  reconcilePureIdleLightweightMaterialDeltas,
  runFastOfflineSettlement,
  validatePureIdleTerminalMaterialConservation,
  type PureIdleAffineContract,
} from "./offlineApproximation";
import { inspectSave, serializeEnvelope } from "./storage";
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

function addInfiniteIronSupply(state: GameState): void {
  state.settings.resourceMode = "infinite";
  state.entities.push({
    id: "pure-idle-infinite-iron",
    kind: "vein",
    planetId: "home",
    position: { x: -200, y: 0 },
    interactionLocked: false,
    resourceId: "iron_ore",
    extractorBuildingId: "mining_machine",
    powerGridId: "grid-a",
    powerPriority: 2,
    machineCount: 0,
    minerCount: 1_000,
    inputs: {},
    outputs: { iron_ore: 1_000 },
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
  state.belts.push({
    id: "pure-idle-infinite-iron-feed",
    planetId: "home",
    source: "pure-idle-infinite-iron",
    target: "pure-idle-smelter",
    itemId: "iron_ore",
    lanes: 1,
    tier: 3,
    sorterTier: 3,
    progress: 0,
    priority: 1,
    totalTransferred: 0,
    lastFlow: 0,
  });
}

function addRecursiveConstructionCenter(state: GameState, target = 100): void {
  addWindGeneration(state, 50_000_000);
  if (!state.research.completedTechIds.includes("construction_automation")) {
    state.research.completedTechIds.push("construction_automation");
  }
  state.constructionAutomation.enabled = true;
  state.constructionAutomation.targetStock.arc_smelter = target;
  state.construction.arc_smelter = 0;
  state.tray = { iron_ore: target * 20, copper_ore: target * 10, stone: target * 10 };
  state.planetTrays.home = state.tray;
  state.entities.push({
    id: "pure-idle-construction-center",
    kind: "machine",
    planetId: "home",
    position: { x: 0, y: 0 },
    interactionLocked: false,
    buildingId: "construction_center",
    machineCount: 1_000,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
}

function addSlowProductiveAssembler(state: GameState): void {
  addWindGeneration(state, 50_000_000);
  if (!state.research.completedTechIds.includes("antimatter")) state.research.completedTechIds.push("antimatter");
  state.entities.push({
    id: "pure-idle-slow-assembler",
    kind: "machine",
    planetId: "home",
    position: { x: 100, y: 100 },
    interactionLocked: false,
    buildingId: "assembling_machine_mk1",
    recipeId: "annihilation_constraint_sphere",
    machineCount: 1,
    minerCount: 0,
    inputs: { particle_container: 10_000, processor: 10_000 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
}

function addRocketConservationFixture(state: GameState, prefilledRockets = 1_000_000): void {
  addWindGeneration(state, 1_000_000_000_000_000);
  if (!state.research.completedTechIds.includes("vertical_launching_silo")) {
    state.research.completedTechIds.push("vertical_launching_silo");
  }
  state.dysonEngineering.launchEnabled = true;
  state.dysonEngineering.launchMode = "sphere";
  state.dysonEngineering.launchThrottle = 1;
  state.entities.push({
    id: "slow-rocket-producer",
    kind: "machine",
    planetId: "home",
    position: { x: 100, y: 0 },
    interactionLocked: false,
    buildingId: "assembling_machine_mk1",
    recipeId: "small_carrier_rocket",
    machineCount: 6,
    minerCount: 0,
    inputs: { dyson_sphere_component: 10_000, deuteron_fuel_rod: 20_000, quantum_chip: 10_000 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  }, {
    id: "prefilled-rocket-silo",
    kind: "machine",
    planetId: "home",
    position: { x: 200, y: 0 },
    interactionLocked: false,
    buildingId: "vertical_launching_silo",
    recipeId: "carrier_rocket_launch",
    machineCount: 1_000_000,
    minerCount: 0,
    inputs: { small_carrier_rocket: prefilledRockets },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
  state.belts.push({
    id: "slow-rocket-feed",
    planetId: "home",
    source: "slow-rocket-producer",
    target: "prefilled-rocket-silo",
    itemId: "small_carrier_rocket",
    lanes: 1,
    tier: 1,
    sorterTier: 1,
    progress: 0,
    priority: 1,
    totalTransferred: 0,
    lastFlow: 0,
  });
}

function addSecondRocketSystemFixture(state: GameState, prefilledRockets = 1_000_000): void {
  const wind = state.entities.find((entity) => entity.id.startsWith("pure-idle-wind-"));
  const producer = state.entities.find((entity) => entity.id === "slow-rocket-producer");
  const silo = state.entities.find((entity) => entity.id === "prefilled-rocket-silo");
  const feed = state.belts.find((belt) => belt.id === "slow-rocket-feed");
  if (!wind || !producer || !silo || !feed) throw new Error("primary rocket fixture is incomplete");
  producer.machineCount = 600;
  producer.inputs = {
    dyson_sphere_component: 1_000_000_000,
    deuteron_fuel_rod: 2_000_000_000,
    quantum_chip: 1_000_000_000,
  };
  state.entities.push({
    ...structuredClone(wind),
    id: "borealis-rocket-wind",
    planetId: "frost",
  }, {
    ...structuredClone(producer),
    id: "borealis-rocket-producer",
    planetId: "frost",
  }, {
    ...structuredClone(silo),
    id: "borealis-rocket-silo",
    planetId: "frost",
    inputs: { small_carrier_rocket: prefilledRockets },
  });
  state.belts.push({
    ...structuredClone(feed),
    id: "borealis-rocket-feed",
    planetId: "frost",
    source: "borealis-rocket-producer",
    target: "borealis-rocket-silo",
  });
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

  it("applies the closed lightweight contract without cloning the full state", () => {
    const source = pureIdleState();
    source.entities[0].inputs.iron_ore = 100;
    const contract = {
      calibrationSeconds: 10,
      calibrationWallSeconds: 10,
      deltas: [
        { path: ["entities", 0, "inputs", "iron_ore"], kind: "number", delta: -10, integer: true },
        { path: ["totalProduced", "iron_ingot"], kind: "number", delta: 10, integer: true },
      ],
    } as PureIdleAffineContract;
    const expected = structuredClone(source);
    const actual = structuredClone(source);

    expect(applyPureIdleAffineContract(expected, contract, 10, 10)).toMatchObject({ ok: true });
    expect(applyPureIdleLightweightContractInPlace(actual, contract, 10, 10)).toMatchObject({ ok: true });
    expect(hashGameState(actual)).toBe(hashGameState(expected));
  });

  it("rolls back every primitive and remainder when an in-place bucket overflows", () => {
    const state = pureIdleState();
    state.entities[0].inputs.iron_ore = 100;
    state.totalProduced.iron_ingot = Number.MAX_SAFE_INTEGER - 5;
    const before = hashGameState(state);
    const integerRemainders = { retained: 0.25 };
    const contract = {
      calibrationSeconds: 10,
      calibrationWallSeconds: 10,
      deltas: [
        { path: ["entities", 0, "inputs", "iron_ore"], kind: "number", delta: -10, integer: true },
        { path: ["totalProduced", "iron_ingot"], kind: "number", delta: 10, integer: true },
      ],
    } as PureIdleAffineContract;

    const result = applyPureIdleLightweightContractInPlace(state, contract, 10, 10, { integerRemainders });

    expect(result).toMatchObject({ ok: false });
    expect(result.failure).toContain("超过安全整数");
    expect(hashGameState(state)).toBe(before);
    expect(integerRemainders).toEqual({ retained: 0.25 });
  });

  it("turns an unmatched sampled replenishment into balanced transfer and finite consumption", () => {
    const state = pureIdleState();
    state.tray.coal = 100;
    state.entities[0].inputs.coal = 100;
    const contract = reconcilePureIdleLightweightMaterialDeltas({
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [
        { path: ["tray", "coal"], kind: "number", delta: 100, integer: true },
        { path: ["entities", 0, "inputs", "coal"], kind: "number", delta: -40, integer: true },
      ],
    });

    const result = applyPureIdleAffineContract(state, contract, 1, 1, { allowExactFallback: false });

    expect(result).toMatchObject({ ok: true });
    expect(state.tray.coal).toBe(140);
    expect(state.entities[0].inputs.coal).toBe(60);
    expect((state.tray.coal ?? 0) + (state.entities[0].inputs.coal ?? 0)).toBe(200);
  });

  it("keeps the 30-second lightweight calibration isolated until wall time reaches its checkpoint", () => {
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
    expect(session.candidate.elapsedSeconds).toBe(source.elapsedSeconds);
    expect(session.calibrationCheckpoint!.candidate.elapsedSeconds - source.elapsedSeconds).toBeCloseTo(
      PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS,
      6,
    );
    expect(session.lastValidationReason).toContain("已精确结算 30 秒");

    const summary = advancePureIdleMacroSession(session, 30 * 24 * 60 * 60);
    const finalized = finalizePureIdleMacroSession(session, 30 * 24 * 60 * 60, createContentPackRegistry());

    expect(summary).toMatchObject({
      phase: "conservative",
      conservativeOnly: true,
      calibrationWindowsCompleted: 3,
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

  it("uses the 30-second lightweight sample to extrapolate ordinary production", () => {
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

    const prefixProduced = session.calibrationCheckpoint!.candidate.totalProduced.iron_ingot ?? 0;
    expect(session.contractVersion).toBe(1);
    expect(session.calibrationWindowsCompleted).toBe(3);
    expect(session.contract.deltas.length).toBeGreaterThan(0);
    expect(prefixProduced).toBeGreaterThan(baselineProduced);

    const summary = advancePureIdleMacroSession(session, 60);
    const finalized = finalizePureIdleMacroSession(session, 60, createContentPackRegistry());
    expect(summary.phase).toBe("conservative");
    expect(summary.actualMultiplier).toBe(9);
    expect(finalized.state.elapsedSeconds - source.elapsedSeconds).toBe(9 * 60);
    expect(finalized.state.totalProduced.iron_ingot ?? 0).toBeGreaterThan(prefixProduced);
    expect(finalized.state.entities.find((entity) => entity.id === "pure-idle-smelter")!.inputs.iron_ore).toBeGreaterThanOrEqual(0);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("detects a slow production cycle that a one-second probe reports as zero", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addSlowProductiveAssembler(source);
    const oneSecond = advanceExactSimulationWindow(structuredClone(source), 1, 1 / 8);
    expect(oneSecond.totalProduced.annihilation_constraint_sphere ?? 0).toBe(0);

    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "large-save memory guard",
    );
    const calibrated = session.calibrationCheckpoint!.candidate.totalProduced.annihilation_constraint_sphere ?? 0;
    expect(calibrated).toBeGreaterThan(0);

    advancePureIdleMacroSession(session, 60);

    expect(session.candidate.totalProduced.annihilation_constraint_sphere ?? 0).toBeGreaterThan(calibrated);
  });

  it("does not reuse a finite cached ingredient after the 30-second sample", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addSlowProductiveAssembler(source);
    const assembler = source.entities.find((entity) => entity.id === "pure-idle-slow-assembler")!;
    assembler.inputs.particle_container = 2;
    assembler.inputs.processor = 2;

    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "large-save memory guard",
    );
    advancePureIdleMacroSession(session, 60);

    expect(session.candidate.totalProduced.annihilation_constraint_sphere ?? 0).toBe(2);
    expect(session.candidate.entities.find((entity) => entity.id === assembler.id)!.inputs)
      .toMatchObject({ particle_container: 0, processor: 0 });
  });

  it("keeps an infinite closed supply chain productive after its transient caches would have expired", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addProductiveSmelter(source, 100);
    addInfiniteIronSupply(source);
    advanceExactSimulationWindow(source, 60, 4);
    const sourceHash = hashGameState(source);
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "steady-flow certificate regression",
    );
    const segmented = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "steady-flow certificate segmented regression",
    );
    const prefixProduced = session.calibrationCheckpoint!.candidate.totalProduced.iron_ingot ?? 0;

    const summary = advancePureIdleMacroSession(session, 24 * 60 * 60);
    advancePureIdleMacroSession(segmented, 102);
    advancePureIdleMacroSession(segmented, 10 * 60);
    advancePureIdleMacroSession(segmented, 24 * 60 * 60);

    expect(session.contract.steadyStateFactorsByItem?.iron_ingot).toBeGreaterThan(0);
    expect(session.contract.maximumSimulationSecondsByItem?.iron_ingot).toBeUndefined();
    expect(session.candidate.totalProduced.iron_ingot ?? 0).toBeGreaterThan(prefixProduced);
    expect(summary.minimumEfficiency === null || summary.minimumEfficiency > 0).toBe(true);
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(session.candidate));
    expect(validatePureIdleTerminalMaterialConservation(source, session.candidate)).toBeNull();
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
    expect(incremental.conservativeDecimalRemainders).toEqual(single.conservativeDecimalRemainders);
    expect(incremental.conservativeRemainingSimulationSecondsByItem)
      .toEqual(single.conservativeRemainingSimulationSecondsByItem);
    expect(incremental.researchRemainder).toBe(single.researchRemainder);
  });

  it("settles recursive construction from real inventory after the isolated large-save calibration", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addRecursiveConstructionCenter(source, 100);
    const sourceHash = hashGameState(source);

    const single = createConservativePureIdleMacroSession(structuredClone(source), "stable", "large-save memory guard");
    expect(single.calibrationCheckpoint!.candidate.construction.arc_smelter).toBe(0);
    advancePureIdleMacroSession(single, 60);

    const segmented = createConservativePureIdleMacroSession(structuredClone(source), "stable", "large-save memory guard");
    advancePureIdleMacroSession(segmented, 15);
    advancePureIdleMacroSession(segmented, 30);
    advancePureIdleMacroSession(segmented, 60);

    expect(single.candidate.construction.arc_smelter).toBe(100);
    expect(single.candidate.constructionAutomation.jobs).toEqual({});
    expect(single.candidate.constructionAutomation.totalCrafted).toBe(100);
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(Object.values(single.candidate.tray).every((amount) => (amount ?? 0) >= 0)).toBe(true);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("consumes a Worker-owned calibration graph without changing the 60-second result", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addProductiveSmelter(source, 1_000);
    addRecursiveConstructionCenter(source, 100);
    const sourceHash = hashGameState(source);

    const retained = createPureIdleMacroSession(structuredClone(source), "stable", {
      forceConservativeReason: "retained checkpoint reference",
    });
    const consumed = createPureIdleMacroSession(structuredClone(source), "stable", {
      forceConservativeReason: "Worker-owned checkpoint",
      consumeCalibrationState: true,
    });

    expect(consumed.calibrationCheckpoint).toBeUndefined();
    expect(consumed.settledSimulationSeconds).toBe(PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS);
    expect(consumed.settledWallSeconds).toBeCloseTo(PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS / 8, 9);
    expect(consumed.pendingConstructionSimulationSeconds).toBe(PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS);
    expect(hashGameState(consumed.candidate)).toBe(hashGameState(retained.calibrationCheckpoint!.candidate));

    advancePureIdleMacroSession(retained, 60);
    advancePureIdleMacroSession(consumed, 60);

    expect(hashGameState(consumed.candidate)).toBe(hashGameState(retained.candidate));
    expect(consumed.pendingConstructionSimulationSeconds).toBe(0);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("does not duplicate prefilled silo launches when low-rate production cannot fund a conservative tail", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addRocketConservationFixture(source);
    const producer = source.entities.find((entity) => entity.id === "slow-rocket-producer")!;
    producer.machineCount = 0;
    producer.inputs = {};
    const sourceHash = hashGameState(source);
    const initialRockets = source.entities.find((entity) => entity.id === "prefilled-rocket-silo")!.inputs.small_carrier_rocket ?? 0;
    const session = createConservativePureIdleMacroSession(structuredClone(source), "stable", "forced conservative regression");
    const exactPrefixLaunches = session.calibrationCheckpoint!.candidate.dysonSphere.totalRocketsLaunched -
      source.dysonSphere.totalRocketsLaunched;

    advancePureIdleMacroSession(session, 30);
    const finalized = finalizePureIdleMacroSession(session, 30, createContentPackRegistry()).state;
    const launches = finalized.dysonSphere.totalRocketsLaunched - source.dysonSphere.totalRocketsLaunched;
    const produced = (finalized.totalProduced.small_carrier_rocket ?? 0) - (source.totalProduced.small_carrier_rocket ?? 0);
    const endingRockets = finalized.entities.find((entity) => entity.id === "prefilled-rocket-silo")!.inputs.small_carrier_rocket ?? 0;

    expect(session.actualMultiplier).toBe(15);
    expect(exactPrefixLaunches).toBeGreaterThan(0);
    expect(launches).toBe(exactPrefixLaunches);
    expect(launches).toBeLessThanOrEqual(produced + initialRockets - endingRockets);
    expect(validatePureIdleTerminalMaterialConservation(source, finalized)).toBeNull();
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("continues a stable single-system rocket line only when sampled manufacture funds every launch", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addRocketConservationFixture(source, 0);
    const sourceHash = hashGameState(source);
    const single = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "closed rocket event-domain regression",
    );
    const segmented = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "closed rocket event-domain regression",
    );
    const exactPrefixLaunches = single.calibrationCheckpoint!.candidate.dysonSphere.totalRocketsLaunched -
      source.dysonSphere.totalRocketsLaunched;

    expect(single.rocketLedger).toBeDefined();
    advancePureIdleMacroSession(single, 60);
    advancePureIdleMacroSession(segmented, 19);
    advancePureIdleMacroSession(segmented, 60);

    const launches = single.candidate.dysonSphere.totalRocketsLaunched - source.dysonSphere.totalRocketsLaunched;
    const produced = (single.candidate.totalProduced.small_carrier_rocket ?? 0) -
      (source.totalProduced.small_carrier_rocket ?? 0);
    expect(launches).toBeGreaterThan(exactPrefixLaunches);
    expect(produced).toBeGreaterThanOrEqual(launches);
    expect(validatePureIdleTerminalMaterialConservation(source, single.candidate)).toBeNull();
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps a stable multi-system rocket ledger deterministic across segmented macro buckets", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addRocketConservationFixture(source, 0);
    addSecondRocketSystemFixture(source, 0);
    advanceExactSimulationWindow(source, 30, 2);
    const sourceHash = hashGameState(source);
    const single = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "multi-system closed rocket event-domain regression",
    );
    const segmented = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "multi-system closed rocket event-domain regression",
    );

    expect(single.rocketLedger, single.degradedReason).toBeDefined();
    expect(Object.keys(single.rocketLedger?.launchesBySystemPerWindow ?? {}).sort())
      .toEqual(["borealis", "helios"]);
    const prefix = single.calibrationCheckpoint!.candidate;
    const prefixHelios = prefix.dysonPlans.helios.structurePoints - source.dysonPlans.helios.structurePoints;
    const prefixBorealis = prefix.dysonPlans.borealis.structurePoints - source.dysonPlans.borealis.structurePoints;

    advancePureIdleMacroSession(single, 60);
    advancePureIdleMacroSession(segmented, 7);
    advancePureIdleMacroSession(segmented, 19);
    advancePureIdleMacroSession(segmented, 60);

    expect(single.candidate.dysonPlans.helios.structurePoints - source.dysonPlans.helios.structurePoints)
      .toBeGreaterThan(prefixHelios);
    expect(single.candidate.dysonPlans.borealis.structurePoints - source.dysonPlans.borealis.structurePoints)
      .toBeGreaterThan(prefixBorealis);
    expect(validatePureIdleTerminalMaterialConservation(source, single.candidate)).toBeNull();
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("uses the same closed multi-system rocket ledger during fast offline settlement", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.enabled = false;
    source.timeWarp.requestedMultiplier = 1;
    addRocketConservationFixture(source, 0);
    addSecondRocketSystemFixture(source, 0);
    advanceExactSimulationWindow(source, 30, 30);
    const sourceHash = hashGameState(source);

    const result = runFastOfflineSettlement(source, 10 * 60);

    expect(result.status).toBe("approximate");
    if (result.status !== "approximate") return;
    expect(result.state.dysonSphere.totalRocketsLaunched - source.dysonSphere.totalRocketsLaunched)
      .toBeGreaterThan(200);
    expect(result.state.dysonPlans.helios.structurePoints - source.dysonPlans.helios.structurePoints)
      .toBeGreaterThan(0);
    expect(result.state.dysonPlans.borealis.structurePoints - source.dysonPlans.borealis.structurePoints)
      .toBeGreaterThan(0);
    expect(validatePureIdleTerminalMaterialConservation(source, result.state)).toBeNull();
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps the terminal material ledger closed after serialization, inspectSave and reload", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addRocketConservationFixture(source);
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "forced conservative reload regression",
    );
    const finalized = finalizePureIdleMacroSession(session, 10 * 60, createContentPackRegistry()).state;
    const raw = serializeEnvelope(finalized, 1_788_000_000_000);
    const inspection = inspectSave(raw);

    expect(inspection).toMatchObject({ valid: true, checksum: "valid", stateVersion: 47 });
    expect(inspection.state).toBeDefined();
    expect(validatePureIdleTerminalMaterialConservation(source, inspection.state!)).toBeNull();
  });

  it.each([8, 12, 15, 16] as const)(
    "keeps %ix conservative settlement deterministic for one long call and segmented calls in finite/infinite modes",
    (multiplier) => {
      for (const resourceMode of ["finite", "infinite"] as const) {
        const source = pureIdleState();
        source.settings.simulationSpeed = 4;
        source.settings.resourceMode = resourceMode;
        source.timeWarp.requestedMultiplier = multiplier;
        addRocketConservationFixture(source, 250_000);

        const segmented = createConservativePureIdleMacroSession(structuredClone(source), "stable", "forced conservative regression");
        advancePureIdleMacroSession(segmented, 7);
        advancePureIdleMacroSession(segmented, 19);
        advancePureIdleMacroSession(segmented, 60);

        const single = createConservativePureIdleMacroSession(structuredClone(source), "stable", "forced conservative regression");
        advancePureIdleMacroSession(single, 60);

        expect(segmented.actualMultiplier).toBe(multiplier);
        expect(single.actualMultiplier).toBe(multiplier);
        expect(hashGameState(segmented.candidate), `${multiplier}x ${resourceMode}`).toBe(hashGameState(single.candidate));
        expect(validatePureIdleTerminalMaterialConservation(source, single.candidate)).toBeNull();
      }
    },
  );

  it("closes multi-system rocket, sail, absorption and orbit counters before accepting a candidate", () => {
    const before = pureIdleState();
    const after = structuredClone(before);
    before.tray.small_carrier_rocket = 4;
    before.tray.solar_sail = 5;
    after.tray.small_carrier_rocket = 0;
    after.tray.solar_sail = 0;
    const systems = Object.keys(after.dysonPlans);
    const targetSystem = (systems[1] ?? systems[0]) as keyof GameState["dysonPlans"];
    const orbit = after.dysonEngineering.orbitsBySystem[targetSystem]?.[0];
    expect(orbit).toBeDefined();

    after.dysonSphere.totalRocketsLaunched += 4;
    after.dysonSphere.structurePoints += 4;
    after.dysonPlans[targetSystem].structurePoints += 4;
    after.dysonSwarm.totalLaunched += 5;
    after.dysonSwarm.sailsInOrbit += 3;
    after.dysonSphere.totalSailsAbsorbed += 2;
    after.dysonSphere.shellSails += 2;
    after.dysonPlans[targetSystem].shellSails += 2;
    orbit!.totalLaunched += 5;
    orbit!.sailsInOrbit += 3;

    expect(validatePureIdleTerminalMaterialConservation(before, after)).toBeNull();
    after.dysonPlans[targetSystem].structurePoints += 1;
    expect(validatePureIdleTerminalMaterialConservation(before, after)).toContain("各恒星系结构增量");
  });

  it("rejects a candidate that copies rocket and structure counters without consuming their material", () => {
    const before = pureIdleState();
    const after = structuredClone(before);
    before.tray.small_carrier_rocket = 1;
    after.tray.small_carrier_rocket = 0;
    after.dysonSphere.totalRocketsLaunched += 100;
    after.dysonSphere.structurePoints += 100;
    after.dysonPlans.helios.structurePoints += 100;

    expect(validatePureIdleTerminalMaterialConservation(before, after)).toContain("超过生产与库存来源");
  });

  it("discards an unfunded affine terminal candidate without changing the source hash", () => {
    const state = pureIdleState();
    const sourceHash = hashGameState(state);
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [
        { path: ["dysonSphere", "totalRocketsLaunched"], kind: "number", delta: 10, integer: true },
        { path: ["dysonSphere", "structurePoints"], kind: "number", delta: 10, integer: true },
        { path: ["dysonPlans", "helios", "structurePoints"], kind: "number", delta: 10, integer: true },
      ],
    } as PureIdleAffineContract;

    const result = applyPureIdleAffineContract(state, contract, 1, 1, { allowExactFallback: false });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("终端物资守恒失败");
    expect(hashGameState(state)).toBe(sourceHash);
  });

  it("rejects unfunded galactic delivery counters even when inventory itself does not grow", () => {
    const state = pureIdleState();
    const sourceHash = hashGameState(state);
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [
        { path: ["endgame", "exportProjects", "universe_archive", "totalDelivered"], kind: "number", delta: 10, integer: true },
        { path: ["endgame", "totalExported"], kind: "number", delta: 10, integer: true },
      ],
    } as PureIdleAffineContract;

    const result = applyPureIdleAffineContract(state, contract, 1, 1, { allowExactFallback: false });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("出口/销毁/交付");
    expect(hashGameState(state)).toBe(sourceHash);
  });

  it.each(["inventory-exhausted", "output-blocked", "no-power", "production-stopped"])(
    "freezes the conservative tail at the last exact checkpoint for %s",
    (condition) => {
      const source = pureIdleState();
      source.settings.simulationSpeed = 4;
      source.timeWarp.requestedMultiplier = 8;
      addProductiveSmelter(source, 1_000);
      const smelter = source.entities.find((entity) => entity.id === "pure-idle-smelter")!;
      if (condition === "inventory-exhausted") smelter.inputs.iron_ore = 1;
      if (condition === "output-blocked") smelter.outputs.iron_ingot = source.settings.productionBufferLimit;
      if (condition === "production-stopped") smelter.inputs.iron_ore = 0;
      if (condition === "no-power") source.entities = source.entities.filter((entity) => entity.kind !== "power");
      const session = createConservativePureIdleMacroSession(structuredClone(source), "stable", "forced conservative boundary");
      const prefixProduced = session.calibrationCheckpoint!.candidate.totalProduced.iron_ingot ?? 0;
      advancePureIdleMacroSession(session, 60 * 60);
      expect(session.candidate.totalProduced.iron_ingot ?? 0).toBe(prefixProduced);
      expect(validatePureIdleTerminalMaterialConservation(source, session.candidate)).toBeNull();
    },
  );

  it("keeps low-power production productive at the measured 30-second rate", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addProductiveSmelter(source, 1_000);
    const wind = source.entities.find((entity) => entity.kind === "power");
    if (wind) wind.machineCount = 1;
    const session = createConservativePureIdleMacroSession(structuredClone(source), "stable", "forced conservative low-power");
    const prefixProduced = session.calibrationCheckpoint!.candidate.totalProduced.iron_ingot ?? 0;

    advancePureIdleMacroSession(session, 60);

    expect(session.candidate.totalProduced.iron_ingot ?? 0).toBeGreaterThan(prefixProduced);
    expect(validatePureIdleTerminalMaterialConservation(source, session.candidate)).toBeNull();
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
