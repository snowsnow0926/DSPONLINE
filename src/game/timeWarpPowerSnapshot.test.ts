import { describe, expect, it } from "vitest";
import { createPlayerInitialState, createSimulationLookupContext, refreshTimeWarpPowerSnapshot, refreshTimeWarpPowerSnapshotChunked, refreshTimeWarpPowerSnapshotInPlace } from "./engine";
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
  it.each(["other-planet", "other-grid"])("does not prepare unrelated production buffers: %s", (location) => {
    const state = poweredState();
    state.entities.push({
      ...structuredClone(state.entities[1]),
      id: "foreign-smelter",
      planetId: location === "other-planet" ? "ashen" : "home",
      powerGridId: location === "other-grid" ? "grid-b" : "grid-a",
      buildingId: "arc_smelter",
      recipeId: "iron_ingot",
      inputs: { iron_ore: 1 },
      outputs: {},
    });
    Object.defineProperty(state.settings, "productionBufferLimit", {
      get: () => { throw new Error("Power refresh prepared unrelated production buffers"); },
    });
    refreshTimeWarpPowerSnapshotInPlace(state);
    expect(state.timeWarp.effectiveMultiplier).toBe(8);
    expect(state.entities[2].inputs).toEqual({ iron_ore: 1 });
    expect(state.entities[2].outputs).toEqual({});
  });

  it("retains complete production runtimes in the ordinary simulation lookup", () => {
    const state = poweredState();
    state.entities.push({ ...structuredClone(state.entities[1]), id: "smelter", planetId: "ashen",
      buildingId: "arc_smelter", recipeId: "iron_ingot", inputs: { iron_ore: 1 }, outputs: {} });
    const lookup = createSimulationLookupContext(state);
    expect(lookup.machineRuntimeById.get("smelter")?.recipe.id).toBe("iron_ingot");
    expect(lookup.machineRuntimesByPlanet.get("ashen")?.map((runtime) => runtime.entity.id)).toContain("smelter");
  });

  it("does not prepare unrelated logistics buffers", () => {
    const state = poweredState();
    const warehouse: FactoryEntity = {
      ...structuredClone(state.entities[1]),
      id: "foreign-warehouse",
      kind: "storage",
      buildingId: "storage_mk1",
      planetId: "ashen",
    };
    Object.defineProperty(warehouse, "storedItemId", {
      get: () => { throw new Error("Power refresh prepared an unrelated logistics buffer"); },
    });
    state.entities.push(warehouse);
    refreshTimeWarpPowerSnapshotInPlace(state);
    expect(state.timeWarp.effectiveMultiplier).toBe(8);
  });

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
    "preserves full-copy default normalization for legacy data: %s", async (kind) => {
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
      const chunked = await refreshTimeWarpPowerSnapshotChunked(state, { yieldControl: async () => {}, batchSize: 1 });
      expect(chunked).toEqual(refreshed);
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

  it.each(["powered", "disabled", "missing-controller", "no-power"] as const)(
    "keeps every field equal through chunked private copying: %s", async (kind) => {
      const state = poweredState();
      if (kind === "disabled") state.timeWarp.enabled = false;
      if (kind === "missing-controller") state.timeWarp.controllerEntityId = "absent";
      if (kind === "no-power") state.entities[0].machineCount = 0;
      state.belts = Array.from({ length: 13 }, (_, index) => ({ id: `power-copy-${index}`, planetId: "home",
        source: "power", target: "clock", itemId: "iron_ore", tier: 1, sorterTier: 1,
        lanes: 1, priority: 1, progress: index / 4, lastFlow: index, totalTransferred: index * 9 }));
      const original = structuredClone(state);
      freeze(state);
      let yields = 0;
      const chunked = await refreshTimeWarpPowerSnapshotChunked(state, { batchSize: 2,
        yieldControl: async () => { yields++; expect(state).toEqual(original); } });
      expect(yields).toBeGreaterThan(2);
      expect(chunked).toEqual(refreshTimeWarpPowerSnapshot(state));
      expect(chunked.entities).not.toBe(state.entities);
      expect(chunked.belts).not.toBe(state.belts);
      expect(chunked.belts.every((belt, index) => belt !== state.belts[index])).toBe(true);
      expect(state).toEqual(original);
    });

  it("rejects an already aborted copy before reading the record arrays", async () => {
    const state = poweredState();
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(state, "entities", { get() { throw new Error("cancelled copy read entities"); } });
    await expect(refreshTimeWarpPowerSnapshotChunked(state, { signal: controller.signal,
      yieldControl: async () => {} })).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["signal", "lease"] as const)("abandons a partial private copy on %s cancellation", async (kind) => {
    const state = poweredState();
    const original = structuredClone(state);
    const controller = new AbortController();
    let current = true;
    let yields = 0;
    await expect(refreshTimeWarpPowerSnapshotChunked(state, { batchSize: 1, signal: controller.signal,
      isCurrent: () => current, yieldControl: async () => {
        yields++;
        if (kind === "signal") controller.abort(); else current = false;
      } })).rejects.toMatchObject({ name: "AbortError" });
    expect(yields).toBe(1);
    expect(state).toEqual(original);
  });

  it("does not overwrite a newer topology published during a yield", async () => {
    const state = poweredState();
    const replacement = [...state.entities];
    await expect(refreshTimeWarpPowerSnapshotChunked(state, { batchSize: 1,
      yieldControl: async () => { state.entities = replacement; } })).rejects.toMatchObject({ name: "AbortError" });
    expect(state.entities).toBe(replacement);
  });

  it("leaves a failed copy retryable without touching its source", async () => {
    const state = poweredState();
    const original = structuredClone(state);
    await expect(refreshTimeWarpPowerSnapshotChunked(state, { batchSize: 1,
      yieldControl: async () => { throw new Error("injected scheduler failure"); } })).rejects.toThrow("injected scheduler failure");
    expect(state).toEqual(original);
    const retried = await refreshTimeWarpPowerSnapshotChunked(state, { yieldControl: async () => {} });
    expect(retried).toEqual(refreshTimeWarpPowerSnapshot(state));
  });
});
