import { describe, expect, it } from "vitest";
import { ITEMS, RECIPES, TECHNOLOGIES } from "./content";
import { hashGameState } from "./benchmark";
import { advanceSimulationSession, completeSimulationAdvanceSession, createInitialState, createSimulationAdvanceSession, placeBuilding } from "./engine";
import type { GameState, TechId } from "./types";

function fixture(): GameState {
  let state = createInitialState(20261026, false);
  state.paused = false;
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as TechId[];
  state.construction.wind_turbine = 10_000;
  state = placeBuilding(state, "wind_turbine", { x: -200, y: 0 }, 10_000);
  state.construction.construction_center = 50;
  state = placeBuilding(state, "construction_center", { x: 0, y: 0 }, 50);
  state.constructionAutomation.enabled = true;
  state.constructionAutomation.cursor = -13;
  state.constructionAutomation.targetStock = { arc_smelter: 2, plane_smelter: 30, logistics_drone: 9 };
  state.construction.arc_smelter = 0;
  state.construction.plane_smelter = 0;
  state.portableFleet.logistics_drone = 0;
  state.tray = Object.fromEntries(Object.keys(ITEMS).map((id) => [id, 1_000_000]));
  state.planetTrays.home = state.tray;
  return state;
}

function advance(state: GameState, seconds: number, batched: boolean): GameState {
  const session = createSimulationAdvanceSession(state, seconds, { batchConstructionAutomation: batched });
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  return completeSimulationAdvanceSession(session);
}

describe("construction scheduling catalog snapshot", () => {
  it("keeps the live quota and pending-job order as targets finish", () => {
    let fast = fixture();
    let reference = structuredClone(fast);
    for (const seconds of [0.3, 0.7, 1, 3]) {
      fast = advance(fast, seconds, true);
      reference = advance(reference, seconds, false);
      expect(hashGameState(fast)).toBe(hashGameState(reference));
    }
    expect(fast.construction.arc_smelter).toBe(2);
    expect(fast.constructionAutomation.totalCrafted).toBeGreaterThan(2);
  });

  it("rebuilds eligibility when technology unlocks between phases", () => {
    let fast = fixture();
    const technology = RECIPES.logistics_drone.requiredTechId!;
    fast.research.completedTechIds = fast.research.completedTechIds.filter((id) => id !== technology);
    fast.constructionAutomation.targetStock = { logistics_drone: 9 };
    let reference = structuredClone(fast);
    fast = advance(fast, 1, true);
    reference = advance(reference, 1, false);
    expect(fast.portableFleet.logistics_drone).toBe(0);
    expect(hashGameState(fast)).toBe(hashGameState(reference));
    fast.research.completedTechIds.push(technology);
    reference.research.completedTechIds.push(technology);
    fast = advance(fast, 5, true);
    reference = advance(reference, 5, false);
    expect(fast.portableFleet.logistics_drone).toBeGreaterThan(0);
    expect(hashGameState(fast)).toBe(hashGameState(reference));
  });
});
