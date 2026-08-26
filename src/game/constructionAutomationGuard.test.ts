import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import { ITEMS, TECHNOLOGIES } from "./content";
import {
  advancePersistentSimulationRuntime,
  CONSTRUCTION_AUTOMATION_EXTENDED_MAX_ITERATIONS_PER_SIMULATION_SECOND,
  CONSTRUCTION_AUTOMATION_EXTENDED_MAX_PLAN_BUILDS_PER_SIMULATION_SECOND,
  createInitialState,
  createPersistentSimulationRuntime,
  createSimulationProfiler,
  getConstructionAutomationStatus,
  normalizeConstructionAutomationCursor,
  placeBuilding,
  setConstructionAutomationTarget,
  setConstructionAutomationTargetsForBuildings,
} from "./engine";
import type { BuildingId, GameState, ItemId, TechId } from "./types";

const RAW_ITEMS: ItemId[] = [
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
];

function placeStack(state: GameState, buildingId: BuildingId, count: number, x: number): GameState {
  state.construction[buildingId] = count;
  return placeBuilding(state, buildingId, { x, y: 0 }, count);
}

function createProtectedConstructionState(): GameState {
  let state = createInitialState(20_260_805, false);
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as TechId[];
  state.tray = Object.fromEntries(RAW_ITEMS.map((itemId) => [itemId, 100_000_000])) as Partial<Record<ItemId, number>>;
  state.planetTrays.home = state.tray;
  state = placeStack(state, "wind_turbine", 100_000_000, -120);
  state = placeStack(state, "construction_center", 1, 0);
  const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
  center.machineCount = 44_311;
  state = placeStack(state, "arc_smelter", 1, 120);
  const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
  smelter.recipeId = "iron_ingot";
  smelter.inputs.iron_ore = 100;
  const configured = setConstructionAutomationTargetsForBuildings(state, 100_000_000);
  expect(configured.ok).toBe(true);
  expect(configured.affectedCount).toBeGreaterThanOrEqual(30);
  return configured.state;
}

function expectSafeIntegerInventories(state: GameState): void {
  const records: Array<Partial<Record<string, number>>> = [
    state.tray,
    state.construction,
    state.totalProduced,
    state.constructionAutomation.destroyedByproducts,
    ...Object.values(state.constructionAutomation.quantumMaterialBuffer ?? {}),
    ...Object.values(state.constructionAutomation.jobs).map((job) => job.inventory),
  ];
  for (const record of records) {
    for (const amount of Object.values(record)) {
      expect(Number.isSafeInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThanOrEqual(0);
    }
  }
}

describe("construction automation compute protection", () => {
  it("normalizes negative, wrapped and oversized scheduler cursors", () => {
    expect(normalizeConstructionAutomationCursor(-1)).toBeGreaterThanOrEqual(0);
    expect(normalizeConstructionAutomationCursor(Number.MAX_SAFE_INTEGER)).toBeGreaterThanOrEqual(0);
    expect(normalizeConstructionAutomationCursor(Number.POSITIVE_INFINITY)).toBe(0);

    const initial = createProtectedConstructionState();
    initial.constructionAutomation.cursor = -1;
    const runtime = createPersistentSimulationRuntime(structuredClone(initial));
    expect(() => advancePersistentSimulationRuntime(runtime, 1, 1)).not.toThrow();
    expect(runtime.state.constructionAutomation.cursor).toBeGreaterThanOrEqual(0);
  });

  it("keeps a 44,311-stack multi-target center bounded while other production advances", () => {
    const initial = createProtectedConstructionState();
    const runtime = createPersistentSimulationRuntime(structuredClone(initial));
    const profiler = createSimulationProfiler();
    const smelterBefore = runtime.state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    const startedAt = performance.now();
    const result = advancePersistentSimulationRuntime(runtime, 1, 1, profiler);
    const durationMs = performance.now() - startedAt;
    const smelterAfter = result.state.entities.find((entity) => entity.id === smelterBefore.id)!;
    const center = result.state.entities.find((entity) => entity.buildingId === "construction_center")!;

    expect(durationMs).toBeLessThan(500);
    expect(profiler.constructionIterations).toBeLessThanOrEqual(256);
    expect(profiler.constructionPlanBuilds).toBeLessThanOrEqual(24);
    expect(profiler.constructionGuardHits).toBeGreaterThan(0);
    expect(result.state.elapsedSeconds).toBeCloseTo(initial.elapsedSeconds + 1, 6);
    expect((smelterAfter.outputs.iron_ingot ?? 0) + smelterAfter.progress).toBeGreaterThan(0);
    expect(getConstructionAutomationStatus(result.state, center.id)).toMatchObject({ protectionReason: "high-stack" });
    expect(Object.keys(result.state.constructionAutomation.targetStock)).toHaveLength(Object.keys(initial.constructionAutomation.targetStock).length);
    expectSafeIntegerInventories(result.state);
  });

  it("uses the extended deterministic budget only for an ultra-high multi-target stack", () => {
    const initial = createProtectedConstructionState();
    const center = initial.entities.find((entity) => entity.buildingId === "construction_center")!;
    center.machineCount = 8_000_000;
    // Supply every recipe tier so this fixture reaches the scheduler budget
    // instead of stopping early on an unrelated intermediate-material gap.
    initial.tray = Object.fromEntries(Object.keys(ITEMS).map((itemId) => [itemId, 100_000_000])) as Partial<Record<ItemId, number>>;
    initial.planetTrays.home = initial.tray;

    const run = () => {
      const profiler = createSimulationProfiler();
      const runtime = createPersistentSimulationRuntime(structuredClone(initial));
      const beforeCrafted = runtime.state.constructionAutomation.totalCrafted;
      advancePersistentSimulationRuntime(runtime, 1, 1, profiler);
      return {
        hash: hashGameState(runtime.state),
        crafted: runtime.state.constructionAutomation.totalCrafted - beforeCrafted,
        profiler,
        state: runtime.state,
      };
    };

    const first = run();
    const second = run();

    // Instant recursive materials need fewer scheduler iterations than the
    // former timed chain; the extended budget is now evidenced by the plan
    // builds and fair-batch output below, not by forcing unused iterations.
    expect(first.profiler.constructionIterations).toBeGreaterThan(0);
    expect(first.profiler.constructionIterations).toBeLessThanOrEqual(
      CONSTRUCTION_AUTOMATION_EXTENDED_MAX_ITERATIONS_PER_SIMULATION_SECOND,
    );
    expect(first.profiler.constructionPlanBuilds).toBeGreaterThan(24);
    expect(first.profiler.constructionPlanBuilds).toBeLessThanOrEqual(
      CONSTRUCTION_AUTOMATION_EXTENDED_MAX_PLAN_BUILDS_PER_SIMULATION_SECOND,
    );
    // The enlarged fair batch must release more than the former
    // 512 × 4,096-job ceiling while remaining below the hard iteration cap.
    expect(first.profiler.constructionJobsBatched).toBeGreaterThan(
      CONSTRUCTION_AUTOMATION_EXTENDED_MAX_ITERATIONS_PER_SIMULATION_SECOND * 4_096,
    );
    expect(first.profiler.constructionIterations).toBeLessThan(
      CONSTRUCTION_AUTOMATION_EXTENDED_MAX_ITERATIONS_PER_SIMULATION_SECOND,
    );
    expect(first.crafted).toBeGreaterThan(0);
    expect(first.hash).toBe(second.hash);
    expect(first.crafted).toBe(second.crafted);
    expectSafeIntegerInventories(first.state);
  });

  it("shares the guarded budget so a second high-stack center also makes progress", () => {
    const initial = createProtectedConstructionState();
    initial.construction.construction_center = 1;
    const withSecond = placeBuilding(initial, "construction_center", { x: 240, y: 0 });
    const centers = withSecond.entities.filter((entity) => entity.buildingId === "construction_center");
    expect(centers).toHaveLength(2);
    for (const center of centers) center.machineCount = 44_311;

    const profiler = createSimulationProfiler();
    const runtime = createPersistentSimulationRuntime(structuredClone(withSecond));
    const result = advancePersistentSimulationRuntime(runtime, 1, 1, profiler);
    const settledCenters = result.state.entities.filter((entity) => entity.buildingId === "construction_center");

    expect(settledCenters.every((center) => (center.productionRate ?? 0) > 0)).toBe(true);
    expect(settledCenters.every((center) => (center.utilization ?? 0) > 0)).toBe(true);
    expect(profiler.constructionIterations).toBeLessThanOrEqual(256);
    expect(profiler.constructionPlanBuilds).toBeLessThanOrEqual(24);
    expectSafeIntegerInventories(result.state);
  });

  it("continues guarded jobs deterministically across requests without duplicating WIP", () => {
    const initial = createProtectedConstructionState();
    const run = () => {
      const runtime = createPersistentSimulationRuntime(structuredClone(initial));
      const crafted: number[] = [];
      for (let second = 0; second < 10; second += 1) {
        advancePersistentSimulationRuntime(runtime, 1, 1);
        crafted.push(runtime.state.constructionAutomation.totalCrafted);
      }
      return { state: runtime.state, crafted };
    };
    const first = run();
    const second = run();

    expect(first.crafted.every((value, index) => index === 0 || value >= first.crafted[index - 1])).toBe(true);
    expect(first.crafted.at(-1)).toBeGreaterThan(first.crafted[0] ?? 0);
    expect(hashGameState(first.state)).toBe(hashGameState(second.state));
    expect(first.state.constructionAutomation).toEqual(second.state.constructionAutomation);
    expectSafeIntegerInventories(first.state);
  });

  it("reuses a blocked recursive plan across persistent steps and matches a cold-cache path", () => {
    let initial = createInitialState(20_260_806, false);
    initial.research.completedTechIds = [...new Set([
      ...initial.research.completedTechIds,
      "electromagnetism",
      "construction_automation",
      "construction_capacity_2",
    ])] as TechId[];
    // Keep the 44,311-stack center fully powered so this fixture exercises
    // recursive-plan caching rather than the unrelated no-power branch.
    initial = placeStack(initial, "wind_turbine", 100_000_000, -120);
    initial = placeStack(initial, "construction_center", 1, 0);
    initial.entities.find((entity) => entity.buildingId === "construction_center")!.machineCount = 44_311;
    initial.tray = {};
    initial.planetTrays.home = initial.tray;
    initial = setConstructionAutomationTarget(initial, "wind_turbine", 100_000_000);

    const cached = createPersistentSimulationRuntime(structuredClone(initial));
    const cold = createPersistentSimulationRuntime(structuredClone(initial));
    const centerId = cached.state.entities.find((entity) => entity.buildingId === "construction_center")!.id;
    const firstProfiler = createSimulationProfiler();
    const secondProfiler = createSimulationProfiler();
    advancePersistentSimulationRuntime(cached, 1, 1, firstProfiler);
    advancePersistentSimulationRuntime(cached, 1, 1, secondProfiler);
    for (let step = 0; step < 2; step += 1) {
      cold.lookup?.constructionAutomationPlanCache.clear();
      advancePersistentSimulationRuntime(cold, 1, 1);
    }

    expect(firstProfiler.constructionPlanBuilds).toBe(1);
    expect(secondProfiler.constructionPlanBuilds).toBe(0);
    expect(secondProfiler.constructionPlanCacheHits).toBeGreaterThan(0);
    expect(hashGameState(cached.state)).toBe(hashGameState(cold.state));
    expect(cached.state.constructionAutomation.jobs).toEqual(cold.state.constructionAutomation.jobs);
    expect(getConstructionAutomationStatus(cached.state, centerId)).toMatchObject({
      protectionReason: "high-stack",
      blockerReason: "raw-shortage",
    });
  });

  it("invalidates a blocked cached plan when raw materials are added", () => {
    let initial = createInitialState(20_260_807, false);
    initial.research.completedTechIds = [...new Set([
      ...initial.research.completedTechIds,
      "electromagnetism",
      "construction_automation",
      "construction_capacity_2",
    ])] as TechId[];
    initial = placeStack(initial, "wind_turbine", 100_000_000, -120);
    initial = placeStack(initial, "construction_center", 1, 0);
    initial.entities.find((entity) => entity.buildingId === "construction_center")!.machineCount = 44_311;
    initial.tray = {};
    initial.planetTrays.home = initial.tray;
    initial = setConstructionAutomationTarget(initial, "wind_turbine", 100_000_000);
    const runtime = createPersistentSimulationRuntime(structuredClone(initial));
    const blockedProfiler = createSimulationProfiler();
    advancePersistentSimulationRuntime(runtime, 1, 1, blockedProfiler);
    expect(blockedProfiler.constructionPlanBuilds).toBe(1);

    runtime.state.tray.iron_ore = 1_000;
    runtime.state.tray.copper_ore = 1_000;
    const resumedProfiler = createSimulationProfiler();
    advancePersistentSimulationRuntime(runtime, 1, 1, resumedProfiler);

    expect(resumedProfiler.constructionPlanBuilds).toBeGreaterThan(0);
    expect(runtime.state.construction.wind_turbine).toBeGreaterThan(0);
    expectSafeIntegerInventories(runtime.state);
  });
});
