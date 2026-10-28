import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TECHNOLOGIES } from "./content";
import {
  advancePersistentSimulationRuntime, advanceSimulationSession, completeSimulationAdvanceSession,
  createInitialState, createPersistentSimulationRuntime, createSimulationAdvanceSession,
  placeBuilding, removeEntity, replacePersistentSimulationRuntimeState,
} from "./engine";
import type { SimulationAdvanceOptions, SimulationLookupContext } from "./engine";
import type { FactoryEntity, GameState, PlanetId } from "./types";

const scenarios = ["no-centers", "one-center", "several-centers", "disabled", "reference", "production-hook"] as const;
type Scenario = typeof scenarios[number];
const hash = (state: GameState) => createHash("sha256").update(JSON.stringify(state)).digest("hex");
// Actual full-list filter visits per one-second step on 8da5681f.
const scanBaseline: Record<Scenario, number> = {
  "no-centers": 66, "one-center": 67, "several-centers": 69,
  disabled: 67, reference: 67, "production-hook": 66,
};

function fixture(name: Scenario): GameState {
  const state = createInitialState(20_261_029, false);
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as GameState["research"]["completedTechIds"];
  state.exploration.colonizedPlanetIds = ["home", "ashen"];
  state.tray = { iron_ingot: 1_000_000, gear: 1_000_000, magnetic_coil: 1_000_000,
    stone_brick: 1_000_000, circuit_board: 1_000_000 };
  state.planetTrays.home = state.tray;
  state.planetTrays.ashen = { ...state.tray };
  state.construction.wind_turbine = state.construction.arc_smelter = 0;
  state.constructionAutomation = { enabled: name !== "disabled", targetStock: { wind_turbine: 1000, arc_smelter: 1000 },
    jobs: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {} };
  const entity = (id: string, planetId: PlanetId): FactoryEntity => ({ id, planetId, kind: "machine",
    buildingId: "arc_smelter", recipeId: "iron_ingot", position: { x: 0, y: 0 }, interactionLocked: false,
    inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 0, minerCount: 0 });
  state.entities = [];
  for (let index = 0; index < 32; index++) for (const planetId of ["home", "ashen"] as const) {
    state.entities.push(entity(`background-${planetId}-${index}`, planetId));
  }
  for (const planetId of ["home", "ashen"] as const) state.entities.push({
    ...entity(`power-${planetId}`, planetId), kind: "power", buildingId: "wind_turbine", recipeId: undefined, machineCount: 100_000,
  });
  if (name !== "no-centers" && name !== "production-hook") state.entities.splice(9, 0, {
    ...entity("center-home", "home"), buildingId: "construction_center", recipeId: undefined, machineCount: 20,
  });
  if (name === "several-centers") {
    state.entities.splice(3, 0, { ...entity("center-ashen", "ashen"), buildingId: "construction_center", recipeId: undefined, machineCount: 30 });
    state.entities.push({ ...entity("center-home-later", "home"), buildingId: "construction_center", recipeId: undefined, machineCount: 10 });
  }
  state.belts = [];
  return state;
}

function observeFilters(lookup: SimulationLookupContext) {
  const visits = { planet: 0, centers: 0 };
  const restores: Array<() => void> = [];
  for (const [kind, groups] of [["planet", lookup.entitiesByPlanet], ["centers", lookup.constructionCentersByPlanet]] as const) {
    for (const list of groups.values()) {
      const original = list.filter;
      const spy = vi.spyOn(list, "filter");
      spy.mockImplementation((predicate, thisArg) => original.call(list, (entity, index, values) => {
        visits[kind]++;
        return predicate.call(thisArg, entity, index, values);
      }));
      restores.push(() => spy.mockRestore());
    }
  }
  return { visits, restore: () => restores.forEach((restore) => restore()) };
}

function step(source: GameState, options: SimulationAdvanceOptions = {}, observe = false) {
  const original = JSON.stringify(source);
  const session = createSimulationAdvanceSession(source, 1, options);
  const trace = observe ? observeFilters(session.lookup!) : undefined;
  try {
    advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
    return { state: completeSimulationAdvanceSession(session), visits: trace?.visits };
  } finally {
    trace?.restore();
    expect(JSON.stringify(source)).toBe(original);
  }
}

describe("construction center lookup selection", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(scenarios)("matches the full-list reference and preserves input for %s", (name) => {
    let state = fixture(name);
    const hashes: string[] = [];
    const scans: Array<{ planet: number; centers: number }> = [];
    for (let second = 0; second < 3; second++) {
      const options: SimulationAdvanceOptions = name === "reference" ? { batchConstructionAutomation: false } : {};
      if (name === "production-hook") options.contractExperiment = { afterPlanetProduction: (current, planetId) => {
        if (planetId !== "home") return;
        const converted = current.entities.find((entity) => entity.id === "background-home-0")!;
        converted.buildingId = "construction_center";
        converted.recipeId = undefined;
        converted.machineCount = 20;
      } };
      const actual = step(state, options, true);
      const reference = step(state, { ...options, batchConstructionAutomation: false });
      expect(actual.state).toStrictEqual(reference.state);
      expect(JSON.stringify(actual.state)).toBe(JSON.stringify(reference.state));
      state = actual.state;
      hashes.push(hash(state));
      scans.push(actual.visits!);
    }
    for (const scan of scans) {
      const visits = scan.planet + scan.centers;
      if (name === "reference" || name === "production-hook") expect(visits).toBe(scanBaseline[name]);
      else expect(visits).toBeLessThan(scanBaseline[name]);
    }
    expect(state.constructionAutomation.totalCrafted > 0).toBe(name !== "no-centers" && name !== "disabled");
    if (process.env.DSP_CENTER_LOOKUP_DIAGNOSTICS === "1") console.info(JSON.stringify({ scenario: name, hashes, scans }));
  });

  it("refreshes the indexed center list after public placement and removal", () => {
    const runtime = createPersistentSimulationRuntime(fixture("no-centers"));
    let placedId = "";
    for (const action of ["none", "place", "remove"] as const) {
      if (action === "place") {
        runtime.state.construction.construction_center = 1;
        const placed = placeBuilding(runtime.state, "construction_center", { x: 120, y: 0 });
        placedId = placed.entities.find((entity) => entity.buildingId === "construction_center")!.id;
        replacePersistentSimulationRuntimeState(runtime, placed);
      } else if (action === "remove") {
        replacePersistentSimulationRuntimeState(runtime, removeEntity(runtime.state, placedId));
      }
      // Compare equal ownership modes: the ordinary copying API normalizes
      // optional properties, whereas this runtime owns and mutates its state.
      const referenceRuntime = createPersistentSimulationRuntime(structuredClone(runtime.state));
      const referenceSession = createSimulationAdvanceSession(referenceRuntime.state, 1, {
        mutateState: true, lookup: referenceRuntime.lookup, batchConstructionAutomation: false,
      });
      advanceSimulationSession(referenceSession, Number.MAX_SAFE_INTEGER);
      const reference = completeSimulationAdvanceSession(referenceSession);
      advancePersistentSimulationRuntime(runtime, 1, 1);
      expect(runtime.state).toStrictEqual(reference);
      expect(runtime.lookup!.constructionCentersByPlanet.get("home")?.map((entity) => entity.id) ?? [])
        .toEqual(action === "place" ? [placedId] : []);
      if (action === "remove") expect(runtime.records.entityById.has(placedId)).toBe(false);
    }
  });
});
