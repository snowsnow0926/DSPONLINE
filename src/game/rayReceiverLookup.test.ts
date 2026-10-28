import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECIPES, TECHNOLOGIES } from "./content";
import {
  advanceSimulationSession, completeSimulationAdvanceSession, createInitialState,
  createSimulationAdvanceSession, getEntityOutputCapacity,
} from "./engine";
import type { SimulationAdvanceOptions, SimulationLookupContext } from "./engine";
import type { FactoryEntity, GameState, PlanetId } from "./types";

const scenarios = ["none", "power", "photon", "blocked", "locked", "dense", "reference", "hook", "cross-system"] as const;
type Scenario = typeof scenarios[number];
const hash = (state: GameState) => createHash("sha256").update(JSON.stringify(state)).digest("hex");
// Measured iterator yields on these two view families before the engine change.
const visitBaseline: Record<Scenario, number> = {
  none: 204, power: 216, photon: 216, blocked: 216, locked: 216,
  dense: 114, reference: 216, hook: 204, "cross-system": 216,
};

function fixture(name: Scenario): GameState {
  const state = createInitialState(20_261_030, false);
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as GameState["research"]["completedTechIds"];
  const remote: PlanetId = name === "cross-system" ? "frost" : "ashen";
  const planets: readonly PlanetId[] = ["home", remote];
  state.exploration.colonizedPlanetIds = ["home", remote];
  state.exploration.unlockedSystemIds = ["helios", "borealis"];
  state.constructionAutomation.enabled = false;
  state.dysonSwarm.sailsInOrbit = state.dysonSwarm.totalLaunched = 1_000_000;
  const entity = (id: string, planetId: PlanetId): FactoryEntity => ({ id, planetId, kind: "machine",
    buildingId: "arc_smelter", recipeId: "iron_ingot", position: { x: 0, y: 0 }, interactionLocked: false,
    inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 0, minerCount: 0 });
  state.entities = [];
  if (name !== "dense") for (let index = 0; index < 16; index++) for (const planetId of planets) {
    state.entities.push(entity(`background-${planetId}-${index}`, planetId));
  }
  for (const planetId of planets) state.entities.push({
    ...entity(`power-${planetId}`, planetId), kind: "power", buildingId: "wind_turbine", recipeId: undefined, machineCount: 100_000,
  });
  if (name !== "none" && name !== "hook") for (const planetId of planets) {
    const receiver: FactoryEntity = { ...entity(`ray-${planetId}`, planetId), buildingId: "ray_receiver",
      recipeId: name === "power" || name === "dense" ? "ray_power" : "critical_photon", machineCount: 60, progress: 0.625 };
    if (name === "blocked") receiver.outputs.critical_photon = getEntityOutputCapacity(state, receiver);
    state.entities.push(receiver);
  }
  if (name === "locked") {
    state.research.completedTechIds = state.research.completedTechIds.filter((id) => id !== RECIPES.critical_photon.requiredTechId);
    state.entities.find((entity) => entity.id === "ray-home")!.recipeId = undefined;
  }
  if (name === "dense") for (let index = 0; index < 15; index++) state.entities.push({
    ...entity(`dense-ray-${index}`, remote), buildingId: "ray_receiver", recipeId: "ray_power", machineCount: 1,
  });
  state.belts = [];
  return state;
}

function observeIterations(lookup: SimulationLookupContext) {
  const visits = { planet: 0, rays: 0 };
  const restores: Array<() => void> = [];
  const groups = [...lookup.entitiesByPlanet.values()].map((list) => ({ list, kind: "planet" as const }));
  const observe = (list: FactoryEntity[], kind: "planet" | "rays") => {
    const original = list[Symbol.iterator];
    const spy = vi.spyOn(list, Symbol.iterator);
    spy.mockImplementation(() => {
      const iterator = original.call(list);
      const next = iterator.next.bind(iterator);
      iterator.next = (...args) => {
        const value = next(...args);
        if (!value.done) visits[kind]++;
        return value;
      };
      return iterator;
    });
    restores.push(() => spy.mockRestore());
  };
  for (const group of groups) observe(group.list, group.kind);
  observe(lookup.rayReceivers, "rays");
  return { visits, restore: () => restores.forEach((restore) => restore()) };
}

function step(source: GameState, options: SimulationAdvanceOptions, observe = false) {
  const original = JSON.stringify(source);
  const session = createSimulationAdvanceSession(source, 1, options);
  const trace = observe ? observeIterations(session.lookup!) : undefined;
  try {
    advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
    return { state: completeSimulationAdvanceSession(session), visits: trace?.visits };
  } finally {
    trace?.restore();
    expect(JSON.stringify(source)).toBe(original);
  }
}

describe("ray receiver candidate views", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(scenarios)("keeps complete state, integer output and input for %s", (name) => {
    let state = fixture(name);
    const hashes: string[] = [];
    const scans: Array<{ planet: number; rays: number }> = [];
    for (let second = 0; second < 3; second++) {
      const options: SimulationAdvanceOptions = name === "reference" ? { batchPowerStorage: false } : {};
      if (name === "hook") options.contractExperiment = { afterPlanetProduction: (current, planetId) => {
        if (planetId !== "home") return;
        const converted = current.entities.find((entity) => entity.id === "background-home-0")!;
        converted.buildingId = "ray_receiver";
        converted.recipeId = undefined;
        converted.machineCount = 1;
        converted.progress = 0.75;
        converted.productionRate = 9;
      } };
      const actual = step(state, options, true);
      const reference = step(state, { ...options, batchPowerStorage: false, batchConstructionAutomation: false });
      expect(actual.state).toStrictEqual(reference.state);
      expect(JSON.stringify(actual.state)).toBe(JSON.stringify(reference.state));
      state = actual.state;
      hashes.push(hash(state));
      scans.push(actual.visits!);
    }
    for (const receiver of state.entities.filter((entity) => entity.buildingId === "ray_receiver")) {
      expect(Number.isSafeInteger(receiver.outputs.critical_photon ?? 0)).toBe(true);
    }
    if (name === "photon" || name === "reference" || name === "cross-system") expect(state.totalProduced.critical_photon).toBeGreaterThan(0);
    if (name === "locked") expect(state.entities.find((entity) => entity.id === "ray-home")!.progress).toBe(0);
    if (name === "hook") expect(state.entities.find((entity) => entity.id === "background-home-0")!.productionRate).toBe(0);
    if (name === "cross-system") expect(state.entities.find((entity) => entity.id === "ray-frost")!.outputs.critical_photon ?? 0).toBe(0);
    for (const scan of scans) {
      const visits = scan.planet + scan.rays;
      if (name === "dense" || name === "reference" || name === "hook") expect(visits).toBe(visitBaseline[name]);
      else expect(visits).toBeLessThan(visitBaseline[name]);
    }
    if (process.env.DSP_RAY_LOOKUP_DIAGNOSTICS === "1") console.info(JSON.stringify({ scenario: name, hashes, scans }));
  });
});
