import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceSimulation, createInitialState, getEntityInputCapacity, getEntityItemInputCapacity,
  getStationSlotCapacity, getStationSlots } from "./engine";
import type { FactoryEntity, GameState, ItemId, StationSlot } from "./types";

function slot(itemId: ItemId | undefined = "iron_ore", remoteMode: StationSlot["remoteMode"] = "supply"): StationSlot {
  return { itemId, localMode: "storage", remoteMode, minimumLoad: 1, minStock: 0,
    maxStock: 10000, priority: 1, routePolicy: "direct", warperBudget: 2 };
}

function station(): FactoryEntity {
  return { id: "tower", kind: "station", planetId: "home", buildingId: "interstellar_logistics_station",
    position: { x: 0, y: 0 }, interactionLocked: false, inputs: {}, outputs: {}, machineCount: 1, minerCount: 0,
    progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, stationTier: 2,
    stationSlots: [slot(), slot("copper_ore"), slot("stone"), slot("coal"), slot("water")] };
}

function capacityFromPublicSnapshot(state: GameState, entity: FactoryEntity, itemId: ItemId) {
  if (entity.buildingId !== "orbital_collector") {
    const found = getStationSlots(entity).find((candidate) => candidate.itemId === itemId);
    if (found) return getStationSlotCapacity(state, entity, found);
  }
  return getEntityInputCapacity(state, entity);
}

describe("single-item station reads", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(["canonical", "duplicate", "partial", "legacy", "missing", "extra", "null-slot", "sparse", "collector"])(
    "matches the complete public snapshot for %s", (name) => {
      const state = createInitialState(20_261_029, false);
      const entity = station();
      if (name === "duplicate") entity.stationSlots = [
        { ...slot(), remoteMode: "demand", maxStock: 5 }, { ...slot(), minStock: 10 },
        slot("stone"), slot("coal"), slot("water"),
      ];
      if (name === "partial") entity.stationSlots = [{ itemId: "iron_ore", maxStock: 19 } as StationSlot];
      if (name === "legacy" || name === "missing") {
        entity.stationSlots = name === "legacy" ? [] : undefined;
        entity.storedItemId = "iron_ore";
        entity.stationMode = "demand";
      }
      if (name === "extra") entity.stationSlots!.push(slot("copper_ingot"));
      if (name === "null-slot") entity.stationSlots![0] = null as unknown as StationSlot;
      if (name === "sparse") delete entity.stationSlots![0];
      if (name === "collector") entity.buildingId = "orbital_collector";
      for (const itemId of ["iron_ore", "stone", "copper_ingot", undefined, "missing_extension_item"] as ItemId[]) {
        const before = structuredClone(entity);
        let expected: number;
        try { expected = capacityFromPublicSnapshot(state, entity, itemId); }
        catch (error) {
          expect(() => getEntityItemInputCapacity(state, entity, itemId)).toThrow((error as Error).constructor as typeof Error);
          continue;
        }
        expect(Object.is(getEntityItemInputCapacity(state, entity, itemId), expected)).toBe(true);
        expect(entity).toStrictEqual(before);
      }
    });

  it("observes in-place field edits and preserves normalization and duplicate order", () => {
    const state = createInitialState(20_261_029, false);
    const entity = station();
    entity.stationSlots![1] = { ...slot(), maxStock: 61 };
    for (const maximum of [0, 7, -1, 3.75, 1e20, NaN, Infinity]) {
      entity.stationSlots![0].maxStock = maximum;
      expect(Object.is(getEntityItemInputCapacity(state, entity, "iron_ore"),
        capacityFromPublicSnapshot(state, entity, "iron_ore"))).toBe(true);
      entity.stationSlots!.reverse();
      expect(Object.is(getEntityItemInputCapacity(state, entity, "iron_ore"),
        capacityFromPublicSnapshot(state, entity, "iron_ore"))).toBe(true);
    }
  });

  it("retains errors from non-JSON numeric fields in an unselected slot", () => {
    const state = createInitialState(20_261_029, false);
    const entity = station();
    entity.stationSlots![4].maxStock = 1n as unknown as number;
    expect(() => capacityFromPublicSnapshot(state, entity, "iron_ore")).toThrow(TypeError);
    expect(() => getEntityItemInputCapacity(state, entity, "iron_ore")).toThrow(TypeError);
  });

  it("keeps the public array and slot objects as independent editable snapshots", () => {
    const entity = station();
    const before = structuredClone(entity);
    const a = getStationSlots(entity), b = getStationSlots(entity);
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    a[0].maxStock = 1;
    a.reverse();
    expect(entity).toStrictEqual(before);
    expect(b[0].maxStock).toBe(10000);
  });

  it.each([
    ["demand-before-supply", "demand", 5, 0, 10, "95", 5],
    ["first-supply", "supply", 25, 20, 50, "80", 20],
    ["first-zero-reserve", "supply", 25, 0, 50, "100", 0],
  ] as const)("preserves duplicate quantum supply selection for %s", (_name, firstMode, firstMaximum, firstReserve, secondReserve, inventory, local) => {
    const state = createInitialState(20_261_029, false);
    state.paused = false;
    state.quantumLogisticsNetwork.enabled = true;
    state.quantumLogisticsNetwork.inventory.iron_ore = "0";
    state.quantumLogisticsNetwork.itemCapacities.iron_ore = "1000000";
    const tower = station();
    tower.quantumMode = "quantum";
    tower.stationSlots![0] = { ...slot("iron_ore", firstMode), maxStock: firstMaximum, minStock: firstReserve };
    tower.stationSlots![1] = { ...slot(), minStock: secondReserve };
    const source: FactoryEntity = { ...station(), id: "source", kind: "storage", buildingId: "storage_mk1",
      storedItemId: "iron_ore", stationSlots: undefined, outputs: { iron_ore: 100 } };
    state.entities = [source, tower];
    state.belts = [{ id: "belt", planetId: "home", source: source.id, target: tower.id, itemId: "iron_ore",
      lanes: 1, tier: 1, sorterTier: 1, progress: 100, priority: 1, lastFlow: 0 }];
    const result = advanceSimulation(state, 1);
    expect(result.quantumLogisticsNetwork.inventory.iron_ore).toBe(inventory);
    const target = result.entities.find((value) => value.id === tower.id)!;
    expect((target.inputs.iron_ore ?? 0) + (target.outputs.iron_ore ?? 0)).toBe(local);
    expect(result.entities.find((value) => value.id === source.id)?.outputs.iron_ore).toBe(0);
  });
});
