import { describe, expect, it } from "vitest";
import { ITEMS } from "./content";
import { createPlayerInitialState } from "./engine";
import { classifyOfflineWorkload } from "./offlineComplexity";
import type { FactoryEntity, ItemId, StationRoute, StationSlot } from "./types";

function factory(inputs: FactoryEntity["inputs"] = {}, outputs: FactoryEntity["outputs"] = {}) {
  const state = createPlayerInitialState();
  const entity: FactoryEntity = {
    ...state.entities[0], id: "classification", kind: "machine", inputs, outputs,
    stationSlots: [], stationRoutes: [], quantumMode: "legacy", quantumTransition: null,
  };
  state.entities = [entity];
  state.belts = [];
  state.blueprints = [];
  state.constructionQueue = [];
  state.productionHistory = [];
  state.settings.productionBufferLimit = 100;
  state.settings.logisticsBufferLimit = 1_000;
  return { state, entity };
}

describe("offline complexity inventory and entity scan boundaries", () => {
  it.each([
    [Number.NaN, 0], [Number.POSITIVE_INFINITY, 0], [Number.NEGATIVE_INFINITY, 0],
    [2, 0], [1, 1], [0, 1], [-5, 1], [89.999, 0], [90, 1],
  ])("counts finite cache boundary value %s as %s", (value, count) => {
    const { state } = factory({ iron_ingot: value });
    expect(classifyOfflineWorkload(state, 60).nearCacheBoundaryCount).toBe(count);
  });

  it.each(["storage", "station", "splitter"] as const)("uses the logistics buffer for %s", (kind) => {
    const { state, entity } = factory({ iron_ingot: 90 });
    entity.kind = kind;
    expect(classifyOfflineWorkload(state, 60).nearCacheBoundaryCount).toBe(0);
    entity.outputs.copper_ingot = 900;
    expect(classifyOfflineWorkload(state, 60).nearCacheBoundaryCount).toBe(1);
  });

  it("counts one entity boundary and one fluid connection per item across both inventories", () => {
    const { state } = factory({ water: 5, iron_ingot: 0 }, { water: 6, crude_oil: 7, copper_ingot: 100 });
    const report = classifyOfflineWorkload(state, 60);
    expect(report.nearCacheBoundaryCount).toBe(1);
    expect(report.fluidOrGasConnections).toBe(2);
  });

  it("keeps inherited and non-enumerable values out of cache and size counts while reading fluid amounts", () => {
    const inputs: FactoryEntity["inputs"] = Object.assign(Object.create({ water: 5, iron_ingot: 0 }), { copper_ingot: 5 });
    Object.defineProperty(inputs, "stone_brick", { value: 0, enumerable: false });
    const { state } = factory(inputs);
    const plain = factory({ copper_ingot: 5 }).state;
    const report = classifyOfflineWorkload(state, 60);
    const reference = classifyOfflineWorkload(plain, 60);
    expect(report.nearCacheBoundaryCount).toBe(0);
    expect(report.fluidOrGasConnections).toBe(1);
    expect(report.estimatedSerializedBytes).toBe(reference.estimatedSerializedBytes);
    const nonEnumerable = factory();
    Object.defineProperty(nonEnumerable.entity.outputs, "water", { value: 5, enumerable: false });
    expect(classifyOfflineWorkload(nonEnumerable.state, 60).fluidOrGasConnections).toBe(1);
  });

  it("ignores non-numeric inventory values without treating zero as empty", () => {
    const { state, entity } = factory({ iron_ingot: "0" as unknown as number }, { copper_ingot: Number.NaN });
    expect(classifyOfflineWorkload(state, 60).nearCacheBoundaryCount).toBe(0);
    entity.outputs.copper_ingot = 0;
    expect(classifyOfflineWorkload(state, 60).nearCacheBoundaryCount).toBe(1);
  });

  it("counts station, quantum transition, route and size contributions once", () => {
    const { state, entity } = factory({ iron_ingot: 5, copper_ingot: 5 }, { gear: 5 });
    const route: StationRoute = { id: "route", slotIndex: 0, peerId: "other", itemId: "iron_ingot", scope: "local",
      cargo: 1, vehicleCount: 1, progress: 0, duration: 1, requiresWarp: false };
    const slot: StationSlot = { itemId: "iron_ingot", localMode: "supply", remoteMode: "storage", minimumLoad: 1,
      minStock: 0, maxStock: 100, priority: 1, routePolicy: "direct", warperBudget: 0 };
    entity.kind = "station";
    entity.quantumMode = "quantum";
    entity.quantumTransition = { targetMode: "quantum", startedAtSecond: 0, boundarySecond: 1, bridges: [] };
    entity.stationRoutes = [route];
    entity.stationSlots = [slot];
    state.entities.push({ ...entity, id: "second", kind: "machine", quantumMode: "legacy", quantumTransition: null,
      inputs: { gear: 5 }, outputs: {}, stationRoutes: [], stationSlots: [] });
    const report = classifyOfflineWorkload(state, 60);
    expect(report).toMatchObject({ stationCount: 1, quantumStationCount: 1, routeCount: 1, estimatedSerializedBytes: 100_760 });
    expect(classifyOfflineWorkload(state, 60, { serializedBytes: 17.9 }).estimatedSerializedBytes).toBe(17);
  });

  it("uses the current catalog for newly registered fluid items", () => {
    const itemId = "classification_test_fluid" as ItemId;
    const previous = ITEMS[itemId];
    const { state } = factory({ [itemId]: 5 });
    try {
      expect(classifyOfflineWorkload(state, 60).fluidOrGasConnections).toBe(0);
      ITEMS[itemId] = { ...ITEMS.water, id: itemId };
      expect(classifyOfflineWorkload(state, 60).fluidOrGasConnections).toBe(1);
    } finally {
      if (previous === undefined) delete ITEMS[itemId]; else ITEMS[itemId] = previous;
    }
  });

  it("rechecks edited fields on the same state and leaves the state unchanged", () => {
    const { state, entity } = factory({ iron_ingot: 5 });
    const before = JSON.stringify(state);
    const first = classifyOfflineWorkload(state, 60);
    expect(JSON.stringify(state)).toBe(before);
    entity.kind = "station";
    entity.inputs.iron_ingot = 0;
    entity.quantumMode = "quantum";
    const edited = JSON.stringify(state);
    const second = classifyOfflineWorkload(state, 60);
    expect(first).toMatchObject({ stationCount: 0, quantumStationCount: 0, nearCacheBoundaryCount: 0 });
    expect(second).toMatchObject({ stationCount: 1, quantumStationCount: 1, nearCacheBoundaryCount: 1 });
    expect(JSON.stringify(state)).toBe(edited);
  });
});
