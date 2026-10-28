import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TECHNOLOGIES } from "./content";
import { advanceSimulationSession, completeSimulationAdvanceSession, createInitialState,
  createSimulationAdvanceSession, createSimulationPowerAudit, POWER_GRID_IDS,
  type SimulationAdvanceSession, type SimulationPowerAuditSample } from "./engine";
import type { FactoryEntity, GameState, PlanetId } from "./types";

const scenarios = ["no-fuel", "thermal", "mixed", "depleted", "residual", "zero-stack", "machine-kind",
  "production-hook", "power-tap", "reference", "floating", "storage-charge", "storage-discharge"] as const;
type Scenario = typeof scenarios[number];
const hash = (state: GameState) => createHash("sha256").update(JSON.stringify(state)).digest("hex");
// Iterator yields over the shared planet views, measured on ec606106.
const visitBaseline: Record<Scenario, number> = {
  "no-fuel": 260, thermal: 260, mixed: 260, depleted: 260, residual: 260,
  "zero-stack": 260, "machine-kind": 260, "production-hook": 312,
  "power-tap": 384, reference: 312, floating: 350,
  "storage-charge": 350, "storage-discharge": 320,
};
const fuels = [
  { buildingId: "thermal_power_plant", fuelItemId: "coal" },
  { buildingId: "mini_fusion_power_plant", fuelItemId: "deuteron_fuel_rod" },
  { buildingId: "artificial_star", fuelItemId: "antimatter_fuel_rod" },
] as const;

const entity = (id: string, planetId: PlanetId): FactoryEntity => ({ id, planetId, kind: "machine",
  buildingId: "arc_smelter", recipeId: "iron_ingot", position: { x: 0, y: 0 }, interactionLocked: false,
  inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 0, minerCount: 0 });

function fixture(name: Scenario): GameState {
  const state = createInitialState(20_261_031, false);
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as GameState["research"]["completedTechIds"];
  state.exploration.colonizedPlanetIds = ["home", "ashen"];
  state.constructionAutomation.enabled = false;
  const planets: readonly PlanetId[] = ["home", "ashen"];
  state.entities = [];
  for (let index = 0; index < 20; index++) for (const planetId of planets) state.entities.push(entity(`background-${planetId}-${index}`, planetId));
  for (const planetId of planets) for (const [gridIndex, powerGridId] of POWER_GRID_IDS.entries()) {
    const specs = name === "floating" ? [fuels[2], fuels[0], fuels[1], fuels[0]]
      : [name === "mixed" ? fuels[gridIndex] : fuels[0]];
    for (const [index, spec] of specs.entries()) state.entities.push({
      ...entity(`fuel-${planetId}-${powerGridId}-${index}`, planetId), powerGridId,
      kind: name === "machine-kind" ? "machine" : "power",
      buildingId: name === "no-fuel" ? "wind_turbine" : spec.buildingId, recipeId: undefined,
      fuelItemId: spec.fuelItemId,
      inputs: { [spec.fuelItemId]: name === "depleted" || name === "residual" || name === "storage-discharge" ? 0 : name === "floating" && index === 0 ? 1_000_000_000 : 100 },
      fuelRemainingMj: name === "residual" ? 20.123456 : name === "floating" ? (index + 1) / 1_000_000 : 0,
      machineCount: name === "zero-stack" ? 0 : name === "no-fuel" ? 1000 : 1,
    });
    state.entities.push({ ...entity(`load-${planetId}-${powerGridId}`, planetId), powerGridId,
      machineCount: 10, inputs: { iron_ore: 100_000 } });
    if (name.startsWith("storage-") || name === "power-tap") {
      state.entities.push({ ...entity(`battery-${planetId}-${powerGridId}`, planetId), powerGridId,
        kind: "power", buildingId: "accumulator", recipeId: undefined, machineCount: 3, storedEnergyMj: 30.123456 });
      state.entities.push({ ...entity(`exchanger-${planetId}-${powerGridId}`, planetId), powerGridId,
        kind: "power", buildingId: "energy_exchanger", recipeId: undefined, machineCount: 1,
        energyMode: name === "storage-discharge" ? "discharge" : "charge", storedEnergyMj: 0.125,
        inputs: name === "storage-discharge" ? { charged_accumulator: 10 } : { accumulator: 10 } });
    }
    if (name === "storage-charge") state.entities.push({ ...entity(`wind-${planetId}-${powerGridId}`, planetId),
      powerGridId, kind: "power", buildingId: "wind_turbine", recipeId: undefined, machineCount: 1000 });
  }
  state.belts = [];
  return state;
}

function step(source: GameState, name: Scenario, reference = false) {
  const original = JSON.stringify(source);
  const session = createSimulationAdvanceSession(source, 1, { batchPowerStorage: name !== "reference" });
  if (name === "production-hook") session.contractExperiment = { beforePlanetProduction: (state, planetId) => {
    const generator = state.entities.find((entity) => entity.id === `fuel-${planetId}-grid-b-0`)!;
    if (generator) generator.inputs.coal = (generator.inputs.coal ?? 0) + 5;
  } };
  if (name === "power-tap") session.contractExperiment = { onPowerPlan: (sample) => {
    if (sample.gridId !== "grid-a") return;
    const generator = session.state.entities.find((entity) => entity.id === `fuel-${sample.planetId}-grid-b-0`)!;
    if (generator) generator.inputs.coal = (generator.inputs.coal ?? 0) + 3;
    const battery = session.state.entities.find((entity) => entity.id === `battery-${sample.planetId}-grid-b`);
    if (battery) battery.storedEnergyMj = (battery.storedEnergyMj ?? 0) + 0.375;
  } };
  // A no-op power-plan tap forces the original per-grid reader without
  // changing fuel-burning modes, optional-property normalization or physics.
  if (reference && !session.contractExperiment?.onPowerPlan) session.contractExperiment = {
    ...session.contractExperiment, onPowerPlan: () => undefined,
  };
  let visits = 0;
  const restores: Array<() => void> = [];
  if (!reference) for (const list of session.lookup!.entitiesByPlanet.values()) {
    const originalIterator = list[Symbol.iterator];
    const spy = vi.spyOn(list, Symbol.iterator);
    spy.mockImplementation(() => {
      const iterator = originalIterator.call(list);
      const next = iterator.next.bind(iterator);
      iterator.next = (...args) => {
        const value = next(...args);
        if (!value.done) visits++;
        return value;
      };
      return iterator;
    });
    restores.push(() => spy.mockRestore());
  }
  try {
    advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
    return { state: completeSimulationAdvanceSession(session), get visits() { return visits; } };
  } finally {
    restores.forEach((restore) => restore());
    expect(JSON.stringify(source)).toBe(original);
  }
}

describe("grid fuel reserve snapshots", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(scenarios)("preserves full state and original snapshot timing for %s", (name) => {
    let state = fixture(name);
    const hashes: string[] = [];
    const scans: number[] = [];
    for (let second = 0; second < 3; second++) {
      const actual = step(state, name);
      const reference = step(state, name, true);
      expect(actual.state).toStrictEqual(reference.state);
      expect(JSON.stringify(actual.state)).toBe(JSON.stringify(reference.state));
      state = actual.state;
      hashes.push(hash(state));
      scans.push(actual.visits);
    }
    if (name === "thermal") expect(state.powerGridMetrics.home["grid-a"].fuelReserveSeconds).toBeGreaterThan(state.planetMetrics.home.fuelReserveSeconds);
    if (name === "zero-stack" || name === "depleted") expect(state.planetMetrics.home.fuelReserveSeconds).toBe(0);
    if (name === "machine-kind") expect(state.powerGridMetrics.home["grid-a"].fuelReserveSeconds).toBeGreaterThan(0);
    if (name.startsWith("storage-")) expect(state.planetMetrics.home.storedEnergyMj).not.toBe(
      POWER_GRID_IDS.reduce((sum, gridId) => sum + state.powerGridMetrics.home[gridId].storedEnergyMj, 0));
    for (const visits of scans) {
      if (name === "power-tap" || name === "reference") expect(visits).toBeLessThanOrEqual(visitBaseline[name]);
      else expect(visits).toBeLessThan(visitBaseline[name]);
    }
    for (const entity of state.entities) for (const value of Object.values(entity.inputs)) {
      expect(Number.isSafeInteger(value ?? 0)).toBe(true);
      expect(value ?? 0).toBeGreaterThanOrEqual(0);
    }
    if (process.env.DSP_GRID_FUEL_DIAGNOSTICS === "1") console.info(JSON.stringify({ scenario: name, hashes, scans }));
  });
});

function auditedFixture(name: Scenario): GameState {
  const state = fixture(name);
  const planets = new Set(state.entities.map((value) => value.planetId));
  for (const planetId of planets) {
    state.planetTrays[planetId] = { iron_ingot: 1_000_000, gear: 1_000_000, magnetic_coil: 1_000_000 };
    for (const powerGridId of POWER_GRID_IDS) {
      state.entities.push({ ...entity(`center-${planetId}-${powerGridId}`, planetId), powerGridId,
        kind: "machine", buildingId: "construction_center", recipeId: undefined, machineCount: 2, inputs: {} });
      state.entities.push({ ...entity(`receiver-${planetId}-${powerGridId}`, planetId), powerGridId,
        kind: "machine", buildingId: "ray_receiver", recipeId: undefined, machineCount: 1, inputs: {} });
    }
  }
  state.tray = state.planetTrays.home;
  state.construction.wind_turbine = 0;
  state.constructionAutomation = { enabled: true, targetStock: { wind_turbine: 20 }, jobs: {}, cursor: 0,
    totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {} };
  return state;
}

function observedStep(source: GameState, mode: "audit" | "legacy" | "copied-mutation" | "legacy-mutation",
  isolate: boolean, batchPowerStorage = true) {
  const original = JSON.stringify(source);
  const samples: SimulationPowerAuditSample[] = [];
  const observe = (sample: SimulationPowerAuditSample) => { samples.push(structuredClone(sample)); };
  let session: SimulationAdvanceSession;
  const mutate = (sample: SimulationPowerAuditSample) => {
    if (sample.gridId === "grid-a") {
      const generator = session.state.entities.find((value) => value.id === `fuel-${sample.planetId}-grid-b-0`)!;
      if (generator) generator.inputs.coal = (generator.inputs.coal ?? 0) + 3;
      const battery = session.state.entities.find((value) => value.id === `battery-${sample.planetId}-grid-b`);
      if (battery) battery.storedEnergyMj = (battery.storedEnergyMj ?? 0) + 0.375;
    }
    observe(sample);
  };
  const audit = createSimulationPowerAudit(observe, isolate);
  const contractExperiment = mode === "audit" ? audit
    : mode === "copied-mutation" ? { ...audit, onPowerPlan: mutate }
    : { onPowerPlan: mode === "legacy-mutation" ? mutate : observe, isolateConstructionAutomation: isolate };
  session = createSimulationAdvanceSession(source, 1, { contractExperiment, batchPowerStorage });
  let visits = 0;
  const restores: Array<() => void> = [];
  for (const list of session.lookup!.entitiesByPlanet.values()) {
    const originalIterator = list[Symbol.iterator];
    const spy = vi.spyOn(list, Symbol.iterator);
    spy.mockImplementation(() => {
      const iterator = originalIterator.call(list);
      const next = iterator.next.bind(iterator);
      iterator.next = (...args) => {
        const value = next(...args);
        if (!value.done) visits++;
        return value;
      };
      return iterator;
    });
    restores.push(() => spy.mockRestore());
  }
  try {
    advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
    return { state: completeSimulationAdvanceSession(session), samples, visits };
  } finally {
    restores.forEach((restore) => restore());
    expect(JSON.stringify(source)).toBe(original);
  }
}

describe("owned power audits", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  for (const isolate of [false, true]) {
    it.each(["thermal", "floating", "machine-kind", "depleted", "storage-charge", "storage-discharge"] as const)(
      `preserves all state and ordered audit samples for %s, isolated=${isolate}`, (name) => {
        let state = auditedFixture(name);
        for (let second = 0; second < 3; second++) {
          const actual = observedStep(state, "audit", isolate);
          const reference = observedStep(state, "legacy", isolate);
          expect(JSON.stringify(actual.state)).toBe(JSON.stringify(reference.state));
          expect(actual.samples).toStrictEqual(reference.samples);
          expect(actual.visits).toBeLessThan(reference.visits);
          state = actual.state;
        }
        if (isolate) expect(state.constructionAutomation.totalCrafted).toBe(0);
        else if (name === "storage-charge") expect(state.constructionAutomation.totalCrafted).toBeGreaterThan(0);
      });
  }

  it("does not carry audit eligibility into a copied configuration with a mutating tap", () => {
    const state = auditedFixture("power-tap");
    const actual = observedStep(state, "copied-mutation", false);
    const reference = observedStep(state, "legacy-mutation", false);
    expect(JSON.stringify(actual.state)).toBe(JSON.stringify(reference.state));
    expect(actual.samples).toStrictEqual(reference.samples);
    expect(actual.visits).toBe(reference.visits);
  });

  it("keeps the non-batched reference path for a registered audit", () => {
    const state = auditedFixture("floating");
    const actual = observedStep(state, "audit", true, false);
    const reference = observedStep(state, "legacy", true, false);
    expect(JSON.stringify(actual.state)).toBe(JSON.stringify(reference.state));
    expect(actual.samples).toStrictEqual(reference.samples);
    expect(actual.visits).toBe(reference.visits);
  });

  it("prevents adding or replacing hooks on an audit configuration", () => {
    const audit = createSimulationPowerAudit(() => undefined, true);
    expect(Object.isFrozen(audit)).toBe(true);
    expect(Object.getPrototypeOf(audit)).toBeNull();
    expect(Reflect.set(audit, "beforePlanetProduction", () => undefined)).toBe(false);
    expect(Reflect.set(audit, "onPowerPlan", () => undefined)).toBe(false);
    expect(audit.beforePlanetProduction).toBeUndefined();
  });
});
