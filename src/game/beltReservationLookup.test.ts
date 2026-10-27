import { describe, expect, it } from "vitest";
import { advancePersistentSimulationRuntime, advanceSimulationSession, completeSimulationAdvanceSession,
  createInitialState, createPersistentSimulationRuntime, createSimulationAdvanceSession,
  getEntityItemInputCapacity, refreshSimulationLookupAfterInventoryMutation } from "./engine";
import type { FactoryEntity, GameState, StationRoute } from "./types";

function reservationRoute(): StationRoute {
  return { id: "reserved-cargo", slotIndex: 0, peerId: "belt-reservation-source", itemId: "iron_ore",
    scope: "local", cargo: 30, vehicleCount: 1, progress: 0, duration: 100, requiresWarp: false,
    vehicleStationId: "reservation-carrier", waypointStationIds: [] };
}

function fixture(reserved: boolean, blocked: boolean): GameState {
  const state = createInitialState(1943);
  const common = { planetId: "home" as const, position: { x: 0, y: 0 }, interactionLocked: false,
    inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
    routingCursor: 0, machineCount: 1, minerCount: 0 };
  const source: FactoryEntity = { ...common, id: "belt-reservation-source", kind: "station",
    buildingId: "planetary_logistics_station", stationDrones: 0, stationRoutes: [],
    stationSlots: [{ itemId: "iron_ore", localMode: "supply", remoteMode: "storage", minimumLoad: 0.1,
      minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 0 }],
    outputs: { iron_ore: 40 } };
  const target: FactoryEntity = { ...common, id: "belt-reservation-sink", kind: "storage",
    buildingId: "storage_mk1", storedItemId: "iron_ore", inputs: {}, outputs: {} };
  const carrier: FactoryEntity = { ...common, id: "reservation-carrier", kind: "station",
    buildingId: "planetary_logistics_station", inputs: {}, outputs: {}, stationDrones: 0,
    stationSlots: [], stationRoutes: reserved ? [reservationRoute()] : [] };
  state.entities.push(source, target, carrier);
  if (blocked) {
    const capacity = getEntityItemInputCapacity(state, target, "iron_ore");
    target.inputs.iron_ore = capacity;
    target.outputs.iron_ore = capacity;
  }
  state.belts = [{ id: "reserved-belt", planetId: "home", source: source.id, target: target.id,
    itemId: "iron_ore", tier: 1, sorterTier: 1, lanes: 1, priority: 1, progress: 0, lastFlow: 0 }];
  return state;
}

function unindexed(state: GameState, seconds: number): GameState {
  const session = createSimulationAdvanceSession(state, seconds, { indexedLogistics: false, wallSeconds: seconds });
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  return completeSimulationAdvanceSession(session);
}

describe("belt source reservations", () => {
  for (const reserved of [false, true]) for (const blocked of [false, true]) for (const seconds of [1, 8]) {
    it(`preserves full state with reserved=${reserved}, blocked=${blocked}, seconds=${seconds}`, () => {
      const initial = fixture(reserved, blocked);
      const untouched = structuredClone(initial);
      const runtime = createPersistentSimulationRuntime(structuredClone(initial));
      advancePersistentSimulationRuntime(runtime, seconds, seconds);
      expect(runtime.state).toEqual(unindexed(initial, seconds));
      expect(initial).toEqual(untouched);
      const source = runtime.state.entities.find((entity) => entity.id === "belt-reservation-source")!;
      if (reserved) expect(source.outputs.iron_ore).toBeGreaterThanOrEqual(30);
      if (!blocked) expect(runtime.state.belts[0].totalTransferred).toBeGreaterThan(0);
      else expect(runtime.state.belts[0].totalTransferred ?? 0).toBe(0);
    });
  }

  it("honors empty, newly reserved and empty-again ledgers on a reused runtime", () => {
    const runtime = createPersistentSimulationRuntime(fixture(false, false));
    for (const reserved of [false, true, false]) {
      const source = runtime.state.entities.find((entity) => entity.id === "belt-reservation-source")!;
      const carrier = runtime.state.entities.find((entity) => entity.id === "reservation-carrier")!;
      source.outputs.iron_ore = 40;
      carrier.stationRoutes = reserved ? [reservationRoute()] : [];
      refreshSimulationLookupAfterInventoryMutation(runtime.state, runtime.lookup!);
      const expected = unindexed(structuredClone(runtime.state), 1);
      advancePersistentSimulationRuntime(runtime, 1, 1);
      expect(runtime.state).toEqual(expected);
      if (reserved) expect(source.outputs.iron_ore).toBeGreaterThanOrEqual(30);
    }
  });
});
