import { describe, expect, it } from "vitest";
import { TECHNOLOGIES } from "./content";
import { hashGameState } from "./benchmark";
import { advanceSimulationSession, completeSimulationAdvanceSession, createInitialState,
  createSimulationAdvanceSession, refreshSimulationLookupAfterInventoryMutation } from "./engine";
import type { FactoryEntity, GameState } from "./types";

function fixture(quantum: boolean): GameState {
  const state = createInitialState(20261026, false);
  state.research.completedTechIds = Object.values(TECHNOLOGIES).map((technology) => technology.id);
  const base = { planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
    inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
    routingCursor: 0, machineCount: 1, minerCount: 0 } as const;
  const source: FactoryEntity = quantum
    ? { ...base, id: "source", kind: "station", buildingId: "interstellar_logistics_station",
      stationTier: 2, quantumMode: "quantum", stationRoutes: [], stationSlots: [{ itemId: "iron_ore",
        localMode: "storage", remoteMode: "demand", minimumLoad: 1, minStock: 0, maxStock: 0,
        priority: 1, routePolicy: "direct", warperBudget: 2 }] }
    : { ...base, id: "source", kind: "storage", buildingId: "storage_mk1", storedItemId: "iron_ore" };
  state.entities = [source,
    { ...base, id: "smelter", kind: "machine", buildingId: "arc_smelter", recipeId: "iron_ingot" },
    { ...base, id: "wind", kind: "power", buildingId: "wind_turbine", machineCount: 1000 }];
  state.belts = [{ id: "belt", source: "source", target: "smelter", itemId: "iron_ore", planetId: "home",
    lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1, totalTransferred: 0, lastFlow: 0 }];
  state.quantumLogisticsNetwork.enabled = quantum;
  state.quantumLogisticsNetwork.inventory = {};
  state.constructionAutomation.enabled = false;
  return state;
}

describe("inventory-only exact lookup reuse", () => {
  it.each([false, true])("matches a fresh index after refilling a sleeping source (quantum=%s)", (quantum) => {
    const warm = createSimulationAdvanceSession(fixture(quantum), 1, { mutateState: true });
    advanceSimulationSession(warm, 100);
    const state = completeSimulationAdvanceSession(warm);
    const lookup = warm.lookup!;
    const routes = lookup.beltRoutes;
    lookup.beltRuntime.activeQueueEnabled = true;
    lookup.beltRuntime.activeGroupKeys.clear();
    if (quantum) state.quantumLogisticsNetwork.inventory.iron_ore = "1000";
    else state.entities[0].outputs.iron_ore = 1000;
    const freshState = structuredClone(state);
    refreshSimulationLookupAfterInventoryMutation(state, lookup);
    const reused = createSimulationAdvanceSession(state, 10, { mutateState: true, lookup });
    const fresh = createSimulationAdvanceSession(freshState, 10, { mutateState: true });
    advanceSimulationSession(reused, 100);
    advanceSimulationSession(fresh, 100);
    expect(hashGameState(completeSimulationAdvanceSession(reused)))
      .toBe(hashGameState(completeSimulationAdvanceSession(fresh)));
    expect(lookup.beltRoutes).toBe(routes);
    expect(reused.state.totalProduced.iron_ingot).toBeGreaterThan(0);
  });
});
