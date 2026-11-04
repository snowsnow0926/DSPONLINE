import { describe, expect, it } from "vitest";
import { ITEMS } from "./content";
import {
  advanceSimulation,
  createInitialState,
  getResourceReserveSnapshot,
  placeBuilding,
  setEntityRecipe,
} from "./engine";
import { validatePureIdleResourceAccounting } from "./offlineApproximation";
import { advancePureIdleMacroSession, createPureIdleMacroSession } from "./pureIdleMacro";
import { migrateGame } from "./storage";
import { getPlanetIndustrySummaries } from "./stellarIndustry";

function resourceFactory(level: number) {
  let state = createInitialState();
  const resources = [...new Map(state.entities.filter(e => e.kind === "vein").map(e => [e.resourceId!, e])).values()];
  state.entities = resources.map((entity, i) => ({ ...entity, id: `resource-${entity.resourceId}`, planetId: "home" as const,
    position: { x: i * 10, y: 0 }, minerCount: 1, outputs: {}, progress: 0,
    resourceRemaining: 1000, resourceCapacity: 1000, resourceDepletionRemainder: 0 }));
  state.belts = [];
  state.galaxy.profiles.home.oceanType = "none";
  state.settings.resourceMode = "finite";
  state.settings.productionBufferLimit = 10_000;
  state.endgame.infiniteResearch.vein_utilization.level = level;
  state.construction.wind_turbine = 1000;
  state = placeBuilding(state, "wind_turbine", { x: 0, y: -100 }, 1000);
  return state;
}

describe("all-resource vein utilization", () => {
  it.each([0, 1, 5, 9, 10, 15])("applies Lv.%i depletion to every catalog resource, including fluids", level => {
    const initial = resourceFactory(level);
    const output = advanceSimulation(initial, 20);
    const veins = output.entities.filter(e => e.kind === "vein");
    expect(veins.map(e => e.resourceId)).toEqual(expect.arrayContaining(["water", "sulfuric_acid", "crude_oil", "iron_ore"]));
    for (const vein of veins) {
      const produced = output.totalProduced[vein.resourceId!] ?? 0;
      expect(produced, vein.resourceId).toBeGreaterThan(0);
      expect((1000 - vein.resourceRemaining!) * 10 + (vein.resourceDepletionRemainder ?? 0), vein.resourceId)
        .toBe(produced * Math.max(0, 10 - level));
      expect(getResourceReserveSnapshot(output, vein)?.infinite, vein.resourceId).toBe(level >= 10);
    }
    expect(validatePureIdleResourceAccounting(initial, output)).toBeNull();
    let chunked = initial;
    for (let second = 0; second < 20; second++) chunked = advanceSimulation(chunked, 1);
    expect(chunked.entities.filter(e => e.kind === "vein")).toEqual(veins);
    expect(chunked.totalProduced).toEqual(output.totalProduced);
  });

  it("keeps fluid fractional depletion through repeated old-save loads", () => {
    const state = resourceFactory(3);
    for (const vein of state.entities.filter(e => e.kind === "vein" && ITEMS[e.resourceId!].kind === "fluid")) {
      delete vein.resourceDepletionRemainder;
    }
    const loaded = migrateGame(JSON.parse(JSON.stringify(state)))!;
    for (const vein of loaded.entities.filter(e => e.kind === "vein" && ITEMS[e.resourceId!].kind === "fluid")) {
      expect(vein.resourceDepletionRemainder).toBe(0);
      vein.resourceDepletionRemainder = 7;
    }
    const reloaded = migrateGame(JSON.parse(JSON.stringify(loaded)))!;
    for (const vein of reloaded.entities.filter(e => e.kind === "vein" && ITEMS[e.resourceId!].kind === "fluid")) {
      expect(vein.resourceDepletionRemainder).toBe(7);
    }
    expect(reloaded.version).toBe(state.version);
  });

  it("preserves fluid depletion remainders across save/resume simulation", () => {
    const initial = migrateGame(JSON.parse(JSON.stringify(resourceFactory(1))))!;
    const direct = advanceSimulation(initial, 20);
    const partial = advanceSimulation(initial, 1);
    const resumed = advanceSimulation(migrateGame(JSON.parse(JSON.stringify(partial)))!, 19);
    // Migration expands defaults on legacy inactive deposits. Compare both
    // sides at the same persisted normalization boundary, including all fields.
    const normalize = (state: typeof initial) => migrateGame(JSON.parse(JSON.stringify(state)))!.entities.filter(e => e.kind === "vein");
    expect(normalize(resumed)).toEqual(normalize(direct));
    expect(resumed.totalProduced).toEqual(direct.totalProduced);
  });

  it("protects finite fluid boundaries and allows exhausted deposits to produce at Lv.10", () => {
    const state = resourceFactory(9);
    for (const vein of state.entities.filter(e => e.kind === "vein")) {
      vein.resourceRemaining = 1; vein.resourceDepletionRemainder = 9;
    }
    const limited = advanceSimulation(state, 20);
    for (const vein of limited.entities.filter(e => e.kind === "vein")) {
      expect(vein.outputs[vein.resourceId!]).toBe(1);
      expect(vein.resourceRemaining).toBe(0);
      expect(getResourceReserveSnapshot(limited, vein)?.exhausted).toBe(true);
    }
    limited.endgame.infiniteResearch.vein_utilization.level = 10;
    const infinite = advanceSimulation(limited, 20);
    for (const vein of infinite.entities.filter(e => e.kind === "vein")) {
      expect(vein.outputs[vein.resourceId!]).toBeGreaterThan(1);
      expect(vein.resourceRemaining).toBe(0);
      expect(getResourceReserveSnapshot(infinite, vein)).toMatchObject({ infinite: true, exhausted: false });
    }
  });

  it.each([1, 9, 10])("keeps offline macro fluid accounting consistent at Lv.%i", level => {
    const state = resourceFactory(level);
    state.paused = false;
    state.timeWarp.enabled = true;
    state.timeWarp.requestedMultiplier = 1;
    state.timeWarp.effectiveMultiplier = 1;
    state.timeWarp.controllerEntityId = "resource-time-warp";
    state.entities.find(e => e.kind === "power")!.machineCount = 100_000_000_000;
    state.entities.push({ id: "resource-time-warp", kind: "machine", planetId: "home", position: { x: 100, y: 0 },
      interactionLocked: false, buildingId: "time_warp_device", machineCount: 1, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 });
    const session = createPureIdleMacroSession(state, "extreme", { forceConservativeReason: "resource depletion regression" });
    advancePureIdleMacroSession(session, 300);
    // Macro production follows its certified sample/boundary rules. Every
    // successfully awarded raw item must still pay the same reserve fraction.
    for (const vein of session.candidate.entities.filter(e => e.kind === "vein")) {
      const produced = session.candidate.totalProduced[vein.resourceId!] ?? 0;
      expect(produced, vein.resourceId).toBeGreaterThan(0);
      expect((1000 - vein.resourceRemaining!) * 10 + (vein.resourceDepletionRemainder ?? 0), vein.resourceId)
        .toBe(produced * Math.max(0, 10 - level));
    }
    expect(validatePureIdleResourceAccounting(state, session.candidate)).toBeNull();
  });

  it("shows reduced liquid depletion in planet reserve estimates", () => {
    const state = resourceFactory(5);
    state.entities = state.entities.filter(e => e.resourceId === "crude_oil");
    state.entities[0].productionRate = 60;
    expect(getPlanetIndustrySummaries(state).find(p => p.planetId === "home")?.depletionSeconds).toBeCloseTo(2000, 6);
    state.endgame.infiniteResearch.vein_utilization.level = 10;
    expect(getPlanetIndustrySummaries(state).find(p => p.planetId === "home")?.depletionSeconds).toBeNull();
  });

  it("continues consuming actual recipe inputs at Lv.10", () => {
    let state = resourceFactory(10);
    state.entities = state.entities.filter(e => e.kind === "power");
    state.construction.assembling_machine_mk1 = 1;
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const machine = state.entities.find(e => e.buildingId === "assembling_machine_mk1")!;
    state = setEntityRecipe(state, machine.id, "gear");
    state.entities.find(e => e.id === machine.id)!.inputs.iron_ingot = 20;
    const result = advanceSimulation(state, 10).entities.find(e => e.id === machine.id)!;
    expect(result.outputs.gear).toBeGreaterThan(0);
    expect(result.inputs.iron_ingot).toBe(20 - result.outputs.gear!);
  });
});
