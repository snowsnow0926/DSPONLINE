import { describe, expect, it } from "vitest";
import { createPlayerInitialState, refreshTimeWarpPowerSnapshot, refreshTimeWarpPowerSnapshotInPlace } from "./engine";
import type { FactoryEntity, GameState } from "./types";

function poweredState(): GameState {
  const state = createPlayerInitialState();
  const base = { planetId: "home", position: { x: 0, y: 0 }, inputs: {}, outputs: {}, progress: 0,
    utilization: 0, productionRate: 0, machineCount: 1, minerCount: 0, routingCursor: 0, interactionLocked: false,
    stationLastSupplyPeerBySlot: {}, proliferatorBonusProgress: {} };
  state.entities = [
    { ...base, id: "power", kind: "power", buildingId: "wind_turbine", machineCount: 10_000_000_000 },
    { ...base, id: "clock", kind: "machine", buildingId: "time_warp_device" },
  ] as FactoryEntity[];
  state.timeWarp.enabled = true;
  state.timeWarp.controllerEntityId = "clock";
  state.timeWarp.requestedMultiplier = 8;
  return state;
}

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

describe("time-warp power snapshot indexes", () => {
  it("refreshes electrical allocation without reading the production belt graph", () => {
    const state = poweredState();
    Object.defineProperty(state, "belts", { configurable: true, get: () => { throw new Error("Power refresh traversed belts"); } });
    refreshTimeWarpPowerSnapshotInPlace(state);
    expect(state.timeWarp.effectiveMultiplier).toBe(8);
    expect(state.timeWarp.allocatedPowerKw).toBe(state.timeWarp.requiredPowerKw);
    expect(state.entities.find((entity) => entity.id === "clock")?.powerFactor).toBe(1);
  });

  it.each(["disabled", "missing-controller"] as const)("keeps the base-speed fallback independent of belts: %s", (kind) => {
    const state = poweredState();
    state.timeWarp.enabled = kind !== "disabled";
    if (kind === "missing-controller") state.timeWarp.controllerEntityId = "absent";
    Object.defineProperty(state, "belts", { get: () => { throw new Error("Fallback traversed belts"); } });
    refreshTimeWarpPowerSnapshotInPlace(state);
    expect(state.timeWarp.effectiveMultiplier).toBe(state.settings.simulationSpeed);
    expect(state.timeWarp.requiredPowerKw).toBe(0);
    expect(state.timeWarp.allocatedPowerKw).toBe(0);
  });

  it("preserves the public immutable snapshot and its production data", () => {
    const state = poweredState();
    state.belts = Array.from({ length: 32 }, (_, index) => ({
      id: `unused-${index}`, planetId: "home", source: "power", target: "clock", itemId: "iron_ore",
      lanes: 1, tier: 1, sorterTier: 1, stackSize: 1, priority: 1, progress: 0.25, lastFlow: 0,
    }));
    const original = structuredClone(state);
    freeze(state);
    const refreshed = refreshTimeWarpPowerSnapshot(state);
    expect(refreshed).not.toBe(state);
    expect(state).toEqual(original);
    expect(refreshed.timeWarp.effectiveMultiplier).toBe(8);
    expect(refreshed.belts).toEqual(original.belts);
    expect(refreshed.elapsedSeconds).toBe(original.elapsedSeconds);
    expect(refreshed.tray).toEqual(original.tray);
    expect(refreshed.totalProduced).toEqual(original.totalProduced);
  });

  it.each(["maps", "route", "terminal", "legacy-ports"] as const)(
    "preserves full-copy default normalization for legacy data: %s", (kind) => {
      const state = poweredState();
      const entity = state.entities[0];
      if (kind === "maps") {
        delete entity.stationLastSupplyPeerBySlot;
        delete entity.proliferatorBonusProgress;
      } else if (kind === "route") {
        entity.stationRoutes = [{ id: "legacy-route" } as NonNullable<FactoryEntity["stationRoutes"]>[number]];
      } else if (kind === "terminal") {
        entity.buildingId = "orbital_cargo_terminal";
        entity.orbitalCargoPortItems = ["iron_ore"];
      } else {
        entity.orbitalCargoPortItems = [null, null, null, null];
      }
      const original = structuredClone(state);
      freeze(state);
      const refreshed = refreshTimeWarpPowerSnapshot(state);
      expect(refreshed.entities[0]).not.toBe(entity);
      if (kind === "maps") {
        expect(refreshed.entities[0].stationLastSupplyPeerBySlot).toEqual({});
        expect(refreshed.entities[0].proliferatorBonusProgress).toEqual({});
      } else if (kind === "route") {
        expect(refreshed.entities[0].stationRoutes?.[0].waypointStationIds).toEqual([]);
      } else if (kind === "terminal") {
        expect(refreshed.entities[0].orbitalCargoPortItems).toEqual(["iron_ore", null, null, null]);
      } else {
        expect(refreshed.entities[0].orbitalCargoPortItems).toBeUndefined();
      }
      expect(state).toEqual(original);
    });
});
