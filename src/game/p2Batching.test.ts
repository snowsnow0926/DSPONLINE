import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import { TECHNOLOGIES } from "./content";
import {
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createInitialState,
  createSimulationAdvanceSession,
  createSimulationProfiler,
  placeBuilding,
  setConstructionAutomationTarget,
  type SimulationAdvanceOptions,
  type SimulationProfiler,
} from "./engine";
import type { BuildingId, ConstructionAutomationTargetId, GameState, ItemId, TechId } from "./types";

interface SimulationResult {
  state: GameState;
  profiler: SimulationProfiler;
}

function runSimulation(
  state: GameState,
  seconds: number,
  options: SimulationAdvanceOptions = {},
  stepSize?: number,
): SimulationResult {
  const profiler = createSimulationProfiler();
  const session = createSimulationAdvanceSession(state, seconds, { ...options, profiler });
  if (stepSize !== undefined) session.stepSize = stepSize;
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  return { state: completeSimulationAdvanceSession(session), profiler };
}

function placeStack(state: GameState, buildingId: BuildingId, count: number, x: number): GameState {
  state.construction[buildingId] = count;
  return placeBuilding(state, buildingId, { x, y: 0 }, count);
}

function createConstructionState(options: {
  targetId: ConstructionAutomationTargetId;
  target: number;
  centerMachines: number;
  completedTechIds?: TechId[];
  tray: Partial<Record<ItemId, number>>;
}): GameState {
  let state = createInitialState(20_260_729, false);
  state.research.completedTechIds = [...new Set([
    ...state.research.completedTechIds,
    "construction_automation" as TechId,
    ...(options.completedTechIds ?? []),
  ])];
  state = placeStack(state, "wind_turbine", 1, 0);
  state.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = options.centerMachines * 80;
  state = placeStack(state, "construction_center", 1, 120);
  state.entities.find((entity) => entity.buildingId === "construction_center")!.machineCount = options.centerMachines;
  state.construction[options.targetId as BuildingId] = 0;
  state.tray = { ...options.tray };
  state.planetTrays.home = state.tray;
  return setConstructionAutomationTarget(state, options.targetId, options.target);
}

function recursiveRawTray(amount = 100_000_000): Partial<Record<ItemId, number>> {
  return Object.fromEntries([
    "iron_ore",
    "copper_ore",
    "stone",
    "coal",
    "silicon_ore",
    "titanium_ore",
    "crude_oil",
    "water",
    "hydrogen",
    "refined_oil",
    "sulfuric_acid",
    "organic_crystal",
    "fire_ice",
    "spiniform_stalagmite_crystal",
    "fractal_silicon",
    "optical_grating_crystal",
    "unipolar_magnet",
    "kimberlite_ore",
  ].map((itemId) => [itemId, amount])) as Partial<Record<ItemId, number>>;
}

function createFuelBatchState(): GameState {
  let state = createInitialState(20_260_730, false);
  state.research.completedTechIds.push("construction_automation", "artificial_star");
  state = placeStack(state, "artificial_star", 1, 0);
  state = placeStack(state, "construction_center", 1, 120);
  const generator = state.entities.find((entity) => entity.buildingId === "artificial_star")!;
  generator.machineCount = 100_000;
  generator.fuelItemId = "antimatter_fuel_rod";
  generator.inputs.antimatter_fuel_rod = 2_000;
  generator.fuelRemainingMj = 3_600;
  const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
  center.machineCount = 600_000;
  state.construction.arc_smelter = 0;
  state.tray = {};
  state.planetTrays.home = state.tray;
  return setConstructionAutomationTarget(state, "arc_smelter", 1);
}

function createExchangerState(mode: "charge" | "discharge", machineCount: number, cells: number): GameState {
  let state = createInitialState(mode === "charge" ? 20_260_731 : 20_260_732, false);
  state.settings.productionBufferLimit = 100_000_000;
  state.research.completedTechIds.push("construction_automation", "energy_storage");
  state = placeStack(state, "energy_exchanger", 1, 0);
  const exchanger = state.entities.find((entity) => entity.buildingId === "energy_exchanger")!;
  exchanger.machineCount = machineCount;
  exchanger.energyMode = mode;
  if (mode === "charge") {
    exchanger.inputs.accumulator = cells;
    state = placeStack(state, "wind_turbine", 1, 120);
    state.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = machineCount * 300;
  } else {
    exchanger.inputs.charged_accumulator = cells;
    state = placeStack(state, "construction_center", 1, 120);
    const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
    center.machineCount = Math.floor(machineCount * 3.75);
    state.construction.arc_smelter = 0;
    state.tray = {};
    state.planetTrays.home = state.tray;
    state = setConstructionAutomationTarget(state, "arc_smelter", 1);
  }
  return state;
}

describe("P2 deterministic batch settlement", () => {
  it("matches the legacy fuel loop with a partial active fuel item", () => {
    const initial = createFuelBatchState();
    const legacy = runSimulation(initial, 1, { batchPowerStorage: false });
    const batched = runSimulation(initial, 1, { batchPowerStorage: true });

    expect(batched.state).toEqual(legacy.state);
    expect(batched.profiler.fuelItemsLoaded).toBe(1_000);
    expect(batched.state.entities.find((entity) => entity.buildingId === "artificial_star")).toMatchObject({
      inputs: { antimatter_fuel_rod: 1_000 },
      fuelRemainingMj: 3_600,
    });
  });

  it("does not create an empty fuel input key when residual heat covers the step", () => {
    const initial = createFuelBatchState();
    const generator = initial.entities.find((entity) => entity.buildingId === "artificial_star")!;
    const center = initial.entities.find((entity) => entity.buildingId === "construction_center")!;
    generator.machineCount = 1;
    generator.fuelRemainingMj = 20;
    delete generator.inputs.antimatter_fuel_rod;
    center.machineCount = 1;
    const legacy = runSimulation(initial, 1, { batchPowerStorage: false });
    const batched = runSimulation(initial, 1, { batchPowerStorage: true });

    expect(batched.state).toEqual(legacy.state);
    expect(batched.profiler.fuelItemsLoaded).toBe(0);
    expect(batched.state.entities.find((entity) => entity.buildingId === "artificial_star")?.inputs)
      .not.toHaveProperty("antimatter_fuel_rod");
  });

  it.each(["charge", "discharge"] as const)("matches the legacy exchanger %s loop", (mode) => {
    const initial = createExchangerState(mode, 50_000, 50_000);
    initial.entities.find((entity) => entity.buildingId === "energy_exchanger")!.storedEnergyMj = 45;
    const legacy = runSimulation(initial, 1, { batchPowerStorage: false });
    const batched = runSimulation(initial, 1, { batchPowerStorage: true });

    expect(batched.state).toEqual(legacy.state);
    expect(batched.profiler.exchangerCellsSettled).toBe(25_000);
    const exchanger = batched.state.entities.find((entity) => entity.buildingId === "energy_exchanger")!;
    expect(exchanger.outputs[mode === "charge" ? "charged_accumulator" : "accumulator"]).toBe(25_000);
    expect(exchanger.storedEnergyMj).toBe(45);
  });

  it("settles five million exchanger cells without a per-cell loop", () => {
    const initial = createExchangerState("charge", 10_000_000, 5_000_000);
    const startedAt = performance.now();
    const result = runSimulation(initial, 1, { batchPowerStorage: true });
    const durationMs = performance.now() - startedAt;

    expect(result.profiler.exchangerCellsSettled).toBe(5_000_000);
    expect(result.state.entities.find((entity) => entity.buildingId === "energy_exchanger")?.outputs.charged_accumulator).toBe(5_000_000);
    expect(durationMs).toBeLessThan(1_000);
  });

  it("uses the player's construction speed upgrades in the batch duration", () => {
    const initial = createConstructionState({
      targetId: "wind_turbine",
      target: 10,
      centerMachines: 10,
      completedTechIds: ["electromagnetism"],
      tray: { iron_ingot: 60, gear: 10, magnetic_coil: 30 },
    });
    const result = runSimulation(initial, 1, { batchConstructionAutomation: true });

    expect(result.profiler.constructionJobsBatched).toBe(2);
    expect(result.state.construction.wind_turbine).toBe(2);
    expect(result.state.tray).toMatchObject({ iron_ingot: 48, gear: 8, magnetic_coil: 24 });
  });

  it("matches 500 legacy construction jobs exactly", () => {
    const initial = createConstructionState({
      targetId: "wind_turbine",
      target: 500,
      centerMachines: 500,
      completedTechIds: ["electromagnetism", "construction_capacity_1", "construction_capacity_2"],
      tray: { iron_ingot: 3_000, gear: 500, magnetic_coil: 1_500 },
    });
    const legacy = runSimulation(initial, 1, { batchConstructionAutomation: false });
    const batched = runSimulation(initial, 1, { batchConstructionAutomation: true });

    expect(batched.state).toEqual(legacy.state);
    expect(hashGameState(batched.state)).toBe(hashGameState(legacy.state));
    expect(batched.profiler.constructionJobsBatched).toBe(500);
    expect(legacy.profiler.constructionJobsBatched).toBe(0);
  });

  it("settles a 50,000-job construction step promptly", () => {
    const initial = createConstructionState({
      targetId: "wind_turbine",
      target: 50_000,
      centerMachines: 50_000,
      completedTechIds: ["electromagnetism", "construction_capacity_1", "construction_capacity_2"],
      tray: { iron_ingot: 300_000, gear: 50_000, magnetic_coil: 150_000 },
    });
    const startedAt = performance.now();
    const result = runSimulation(initial, 1, { batchConstructionAutomation: true });
    const durationMs = performance.now() - startedAt;

    expect(result.profiler.constructionJobsBatched).toBe(50_000);
    expect(result.state.construction.wind_turbine).toBe(50_000);
    expect(result.state.tray).toEqual({ iron_ingot: 0, gear: 0, magnetic_coil: 0 });
    expect(durationMs).toBeLessThan(1_000);
  });

  it("matches legacy settlement while batching a recipe with a byproduct", () => {
    const initial = createConstructionState({
      targetId: "conveyor_belt_mk3",
      target: 6,
      centerMachines: 10,
      completedTechIds: [
        "construction_capacity_1",
        "construction_capacity_2",
        "super_magnetic_logistics",
        "nanomaterials",
        "rare_resource_utilization",
      ],
      tray: { fire_ice: 4, electromagnetic_turbine: 4, super_magnetic_ring: 2 },
    });
    const legacy = runSimulation(initial, 1, { batchConstructionAutomation: false });
    const batched = runSimulation(initial, 1, { batchConstructionAutomation: true });

    expect(batched.state).toEqual(legacy.state);
    expect(batched.profiler.constructionJobsBatched).toBe(2);
    expect(batched.state.construction.conveyor_belt_mk3).toBe(6);
    expect(batched.state.tray.hydrogen).toBe(2);
  });

  it("preserves round-robin targets and stable center order with multiple construction centers", () => {
    let initial = createConstructionState({
      targetId: "wind_turbine",
      target: 100,
      centerMachines: 100,
      completedTechIds: ["electromagnetism", "construction_capacity_1", "construction_capacity_2"],
      tray: { iron_ingot: 2_000, gear: 500, magnetic_coil: 1_000, stone_brick: 500, circuit_board: 1_000 },
    });
    initial.construction.arc_smelter = 0;
    initial.construction.construction_center = 1;
    initial = placeBuilding(initial, "construction_center", { x: 240, y: 0 });
    initial.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = 20_000;
    initial.entities.filter((entity) => entity.buildingId === "construction_center")[1].machineCount = 100;
    initial = setConstructionAutomationTarget(initial, "arc_smelter", 100);

    const legacy = runSimulation(initial, 1, { batchConstructionAutomation: false });
    const batched = runSimulation(initial, 1, { batchConstructionAutomation: true });

    expect(batched.state).toEqual(legacy.state);
    expect(hashGameState(batched.state)).toBe(hashGameState(legacy.state));
    expect(batched.state.construction).toMatchObject({ wind_turbine: 100, arc_smelter: 100 });
    expect(batched.profiler.constructionJobsBatched).toBe(200);
    expect(batched.profiler.constructionPlanBuilds).toBe(2);
    expect(batched.profiler.constructionPlanCacheHits).toBeGreaterThan(0);
  });

  it("matches a complex recursive manufacturing chain with alternate recipes and byproducts", () => {
    const initial = createConstructionState({
      targetId: "assembling_machine_mk3",
      target: 100,
      centerMachines: 5_000,
      completedTechIds: Object.keys(TECHNOLOGIES) as TechId[],
      tray: recursiveRawTray(),
    });
    const legacy = runSimulation(initial, 1, { batchConstructionAutomation: false });
    const batched = runSimulation(initial, 1, { batchConstructionAutomation: true });

    expect(batched.state).toEqual(legacy.state);
    expect(hashGameState(batched.state)).toBe(hashGameState(legacy.state));
    expect(batched.state.construction.assembling_machine_mk3).toBe(100);
    expect(batched.profiler.constructionJobsBatched).toBe(100);
    expect(batched.profiler.constructionPlanBuilds).toBeLessThan(10);
  });

  it("reaches the final-building rate from raw materials because recursive material steps are instant", () => {
    const initial = createConstructionState({
      targetId: "arc_smelter",
      target: 100,
      centerMachines: 100,
      completedTechIds: Object.keys(TECHNOLOGIES) as TechId[],
      tray: recursiveRawTray(),
    });
    const legacy = runSimulation(initial, 1, { batchConstructionAutomation: false });
    const batched = runSimulation(initial, 1, { batchConstructionAutomation: true });

    expect(batched.state).toEqual(legacy.state);
    expect(batched.state.construction.arc_smelter).toBe(100);
    expect(batched.profiler.constructionJobsBatched).toBe(100);
    expect(batched.state.totalProduced.iron_ingot).toBeGreaterThan(0);
  });

  it("settles ten thousand recursive byproduct jobs without a per-step task loop", () => {
    const initial = createConstructionState({
      targetId: "conveyor_belt_mk3",
      target: 30_000,
      centerMachines: 11_000,
      completedTechIds: [
        "construction_capacity_1",
        "construction_capacity_2",
        "super_magnetic_logistics",
        "nanomaterials",
        "rare_resource_utilization",
      ],
      tray: { fire_ice: 20_000, electromagnetic_turbine: 20_000, super_magnetic_ring: 10_000 },
    });
    const startedAt = performance.now();
    const result = runSimulation(initial, 1, { batchConstructionAutomation: true });
    const durationMs = performance.now() - startedAt;

    expect(result.state.construction.conveyor_belt_mk3).toBe(30_000);
    expect(result.state.tray.hydrogen).toBe(10_000);
    expect(result.profiler.constructionJobsBatched).toBe(10_000);
    expect(result.profiler.constructionPlanBuilds).toBe(1);
    expect(result.profiler.constructionMs).toBeLessThan(250);
    expect(durationMs).toBeLessThan(1_000);
  });

  it("batches a high-stack recursive building plan whose unused remainder is safely discarded", () => {
    const initial = createConstructionState({
      targetId: "plane_smelter",
      target: 1_000,
      centerMachines: 1_000_000,
      completedTechIds: Object.keys(TECHNOLOGIES) as TechId[],
      tray: recursiveRawTray(),
    });
    const legacy = runSimulation(initial, 1, { batchConstructionAutomation: false });
    const batched = runSimulation(initial, 1, { batchConstructionAutomation: true });

    expect(hashGameState(batched.state)).toBe(hashGameState(legacy.state));
    expect(batched.state.construction.plane_smelter).toBe(1_000);
    expect(batched.profiler.constructionJobsBatched).toBe(1_000);
    // Four bounded plan probes establish the finite by-product cycle; the
    // initial plan adds one build, and no per-job rebuild is allowed after it.
    expect(batched.profiler.constructionPlanBuilds).toBeLessThanOrEqual(5);
  });

  it.each([1, 2, 3])("keeps a proven recursive byproduct phase exact (starting alloy %i)", (startingAlloy) => {
    const initial = createConstructionState({
      targetId: "plane_smelter",
      target: 1_000,
      centerMachines: 1_000_000,
      completedTechIds: Object.keys(TECHNOLOGIES) as TechId[],
      tray: { ...recursiveRawTray(), titanium_alloy: startingAlloy },
    });
    const legacy = runSimulation(initial, 1, { batchConstructionAutomation: false });
    const batched = runSimulation(initial, 1, { batchConstructionAutomation: true });

    expect(hashGameState(batched.state)).toBe(hashGameState(legacy.state));
    expect(batched.state.construction.plane_smelter).toBe(1_000);
    // A non-zero phase can leave at most the three-job prefix outside the
    // closed cycle; those jobs still use the bounded atomic path and remain
    // hash-identical to the legacy oracle.
    expect(batched.profiler.constructionJobsBatched).toBeGreaterThanOrEqual(997);
    expect(batched.profiler.constructionPlanBuilds).toBeLessThanOrEqual(24);
  });

  it("matches legacy hashes for both one long construction step and segmented steps", () => {
    const initial = createConstructionState({
      targetId: "wind_turbine",
      target: 500,
      centerMachines: 50,
      completedTechIds: ["electromagnetism", "construction_capacity_1", "construction_capacity_2"],
      tray: { iron_ingot: 3_000, gear: 500, magnetic_coil: 1_500 },
    });
    const longLegacy = runSimulation(initial, 10, { batchConstructionAutomation: false }, 10);
    const longBatched = runSimulation(initial, 10, { batchConstructionAutomation: true }, 10);
    const segmentedLegacy = runSimulation(initial, 10, { batchConstructionAutomation: false }, 1);
    const segmentedBatched = runSimulation(initial, 10, { batchConstructionAutomation: true }, 1);

    expect(hashGameState(longBatched.state)).toBe(hashGameState(longLegacy.state));
    expect(hashGameState(segmentedBatched.state)).toBe(hashGameState(segmentedLegacy.state));
    expect({
      construction: longBatched.state.construction,
      automation: longBatched.state.constructionAutomation,
      tray: longBatched.state.tray,
      totalProduced: longBatched.state.totalProduced,
    }).toEqual({
      construction: segmentedBatched.state.construction,
      automation: segmentedBatched.state.constructionAutomation,
      tray: segmentedBatched.state.tray,
      totalProduced: segmentedBatched.state.totalProduced,
    });
  });
});
