import { describe, expect, it, vi } from "vitest";
import { createInitialState, createSimulationLookupContext, prepareSimulationStep, runPlanetSimulationPhase } from "./engine";

function emptyMachinePlanet() {
  const state = createInitialState(12_345, false);
  state.entities = state.entities.filter((entity) => entity.kind === "vein");
  state.belts = [];
  const lookup = createSimulationLookupContext(state);
  const prepared = prepareSimulationStep(state, 1, lookup);
  return { state, lookup, prepared };
}

describe("planet simulation with no machines or construction centers", () => {
  it("uses a known-empty machine index without rescanning every planet's entities", () => {
    const { state, lookup, prepared } = emptyMachinePlanet();
    expect(lookup.machineRuntimesByPlanet.has("home")).toBe(false);
    const beforeEntities = structuredClone(state.entities);
    const beforeProduced = structuredClone(state.totalProduced);
    const scan = vi.spyOn(state.entities, "flatMap");
    try {
      runPlanetSimulationPhase(state, 1, "home", prepared.reception, prepared.beltStepReservation, lookup);
      expect(scan).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
    }
    expect(state.entities).toEqual(beforeEntities);
    expect(state.totalProduced).toEqual(beforeProduced);
  });

  it("does not inspect construction targets when the planet has no center", () => {
    const { state, lookup, prepared } = emptyMachinePlanet();
    const targets = state.constructionAutomation.targetStock;
    const beforeConstruction = structuredClone(state.constructionAutomation);
    const targetRead = vi.fn();
    state.constructionAutomation.targetStock = new Proxy(targets, {
      get(target, key, receiver) {
        targetRead(key);
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      runPlanetSimulationPhase(state, 1, "home", prepared.reception, prepared.beltStepReservation, lookup);
      expect(targetRead).not.toHaveBeenCalled();
    } finally {
      state.constructionAutomation.targetStock = targets;
    }
    expect(state.constructionAutomation).toEqual(beforeConstruction);
  });
});
