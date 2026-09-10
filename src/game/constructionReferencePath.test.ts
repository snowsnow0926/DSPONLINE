import { expect, it } from "vitest";
import { TECHNOLOGIES } from "./content";
import {
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createInitialState,
  createSimulationAdvanceSession,
  createSimulationProfiler,
  placeBuilding,
  setConstructionAutomationTarget,
} from "./engine";
import type { ItemId, TechId } from "./types";

it("plans each reference construction job directly without probing batch cycles", () => {
  let state = createInitialState(20_260_729, false);
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as TechId[];
  state.construction.wind_turbine = 1;
  state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 1);
  state.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = 80_000_000;
  state.construction.construction_center = 1;
  state = placeBuilding(state, "construction_center", { x: 120, y: 0 }, 1);
  const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
  center.machineCount = 1_000_000;
  state.construction.plane_smelter = 0;
  state.tray = { titanium_alloy: 1 };
  state.planetTrays.home = state.tray;
  const rawItems: ItemId[] = [
    "iron_ore", "copper_ore", "stone", "coal", "silicon_ore", "titanium_ore", "crude_oil", "water",
    "hydrogen", "refined_oil", "sulfuric_acid", "organic_crystal", "fire_ice", "spiniform_stalagmite_crystal",
    "fractal_silicon", "optical_grating_crystal", "unipolar_magnet", "kimberlite_ore",
  ];
  state.constructionAutomation.quantumSourceEnabled = true;
  state.constructionAutomation.quantumMaterialBuffer = {
    [center.id]: Object.fromEntries(rawItems.map((id) => [id, 100_000_000])),
  };
  state = setConstructionAutomationTarget(state, "plane_smelter", 3);
  const run = (batchConstructionAutomation: boolean) => {
    const profiler = createSimulationProfiler();
    const session = createSimulationAdvanceSession(state, 1, { batchConstructionAutomation, profiler });
    advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
    return { state: completeSimulationAdvanceSession(session), profiler };
  };
  const reference = run(false);
  const batched = run(true);
  expect(reference.state.construction.plane_smelter).toBe(3);
  expect(reference.state).toEqual(batched.state);
  expect(reference.profiler.constructionJobsBatched).toBe(0);
  expect(reference.profiler.constructionGuardHits).toBe(0);
  expect(reference.profiler.constructionPlanBuilds).toBe(3);
});
