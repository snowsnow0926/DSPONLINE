import { describe, expect, it } from "vitest";
import {
  connectBeltWithResult,
  createBlueprint,
  createInitialState,
  placeBlueprint,
  placeBuilding,
  removeBelt,
  removeEntity,
} from "./engine";
import type { ConstructionId } from "./types";

describe("large-factory copy-on-write edit commands", () => {
  it("places and removes an empty building while sharing unrelated records", () => {
    const state = createInitialState(11_900, false);
    state.construction.storage_mk1 = 10;
    const firstEntity = state.entities[0];
    const belts = state.belts;
    const placed = placeBuilding(state, "storage_mk1", { x: 90_000, y: 90_000 });
    const created = placed.entities.at(-1)!;

    expect(placed.entities[0]).toBe(firstEntity);
    expect(placed.belts).toBe(belts);
    expect(state.construction.storage_mk1).toBe(10);
    expect(placed.construction.storage_mk1).toBe(9);

    const removed = removeEntity(placed, created.id);
    expect(removed.entities[0]).toBe(firstEntity);
    expect(removed.belts).toBe(belts);
    expect(removed.entities.some((entity) => entity.id === created.id)).toBe(false);
    expect(removed.construction.storage_mk1).toBe(10);
  });

  it("removes and reconnects one line without cloning unrelated entity/belt objects", () => {
    let state = createInitialState(11_901, false);
    state.construction.storage_mk1 = 3;
    state.construction.conveyor_belt_mk1 = 10;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 300, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 600, y: 0 });
    const [source, firstTarget, secondTarget] = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    source.storedItemId = "iron_ingot";
    firstTarget.storedItemId = "iron_ingot";
    secondTarget.storedItemId = "iron_ingot";
    state = connectBeltWithResult(state, source.id, firstTarget.id, "iron_ingot").state;
    state = connectBeltWithResult(state, source.id, secondTarget.id, "iron_ingot").state;
    const [belt, unrelatedBelt] = state.belts;
    const unrelatedEntity = state.entities.find((entity) => entity.id !== belt.target && entity.id !== secondTarget.id)!;
    const removed = removeBelt(state, belt.id);
    const constructionId: ConstructionId = belt.tier === 3 ? "conveyor_belt_mk3" : belt.tier === 2 ? "conveyor_belt_mk2" : "conveyor_belt_mk1";
    removed.construction[constructionId] = 1_000;
    const reconnected = connectBeltWithResult(removed, belt.source, belt.target, belt.itemId, belt.tier, belt.targetPortIndex, belt.lanes);

    expect(reconnected.created).toBe(true);
    expect(reconnected.state.entities.find((entity) => entity.id === unrelatedEntity.id)).toBe(unrelatedEntity);
    expect(reconnected.state.belts.find((candidate) => candidate.id === unrelatedBelt.id)).toBe(unrelatedBelt);
  });

  it("creates a blueprint without cloning the live factory graph", () => {
    const state = createInitialState(11_902, false);
    state.construction.storage_mk1 = 1;
    const placed = placeBuilding(state, "storage_mk1", { x: 1_000, y: 1_000 });
    const eligible = placed.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const blueprint = createBlueprint(placed, [eligible.id], "copy-on-write");
    expect(blueprint.entities).toBe(placed.entities);
    expect(blueprint.belts).toBe(placed.belts);
    expect(blueprint.blueprints.length).toBe(placed.blueprints.length + 1);
  });

  it("deploys one blueprint draft while sharing unrelated live records", () => {
    let state = createInitialState(11_909, false);
    state.construction.storage_mk1 = 8;
    state.construction.conveyor_belt_mk1 = 20;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 300, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 600, y: 0 });
    const storage = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    for (const entity of storage) entity.storedItemId = "iron_ingot";
    state = connectBeltWithResult(state, storage[0].id, storage[1].id, "iron_ingot").state;
    state = connectBeltWithResult(state, storage[0].id, storage[2].id, "iron_ingot").state;
    state = createBlueprint(state, [storage[0].id, storage[1].id], "deployment-cow");
    const blueprint = state.blueprints.at(-1)!;
    const unrelatedEntity = state.entities.find((entity) => entity.id === storage[2].id)!;
    const unrelatedBelt = state.belts.find((belt) => belt.target === storage[2].id)!;
    const constructionBefore = state.construction.storage_mk1;

    const deployed = placeBlueprint(state, blueprint.id, { x: 90_000, y: 90_000 });

    expect(deployed).not.toBe(state);
    expect(deployed.entities.find((entity) => entity.id === unrelatedEntity.id)).toBe(unrelatedEntity);
    expect(deployed.belts.find((belt) => belt.id === unrelatedBelt.id)).toBe(unrelatedBelt);
    expect(state.construction.storage_mk1).toBe(constructionBefore);
    expect(deployed.entities.length).toBe(state.entities.length + blueprint.entities.length);
    expect(deployed.belts.length).toBe(state.belts.length + blueprint.belts.length);
  });

  it("keeps inventory and stable references through 1,000 place/remove commands", () => {
    let state = createInitialState(11_906, false);
    state.construction.storage_mk1 = 1_001;
    const originalCount = state.entities.length;
    const stableEntity = state.entities[0];
    const stableBelts = state.belts;

    for (let index = 0; index < 1_000; index += 1) {
      state = placeBuilding(state, "storage_mk1", { x: 100_000 + index, y: 100_000 });
      const created = state.entities.at(-1)!;
      state = removeEntity(state, created.id);
    }

    expect(state.entities).toHaveLength(originalCount);
    expect(state.entities[0]).toBe(stableEntity);
    expect(state.belts).toBe(stableBelts);
    expect(state.construction.storage_mk1).toBe(1_001);
  });

  it("keeps an unrelated line stable through 1,000 remove/reconnect commands", () => {
    let state = createInitialState(11_907, false);
    state.construction.storage_mk1 = 3;
    state.construction.conveyor_belt_mk1 = 2_000;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 300, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 600, y: 0 });
    const storage = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    for (const entity of storage) entity.storedItemId = "iron_ingot";
    state = connectBeltWithResult(state, storage[0].id, storage[1].id, "iron_ingot").state;
    state = connectBeltWithResult(state, storage[0].id, storage[2].id, "iron_ingot").state;
    const unrelatedBelt = state.belts[1];

    for (let index = 0; index < 1_000; index += 1) {
      const edited = state.belts.find((belt) => belt.id !== unrelatedBelt.id)!;
      state = removeBelt(state, edited.id);
      const result = connectBeltWithResult(state, edited.source, edited.target, edited.itemId, edited.tier, edited.targetPortIndex, edited.lanes);
      expect(result.created).toBe(true);
      state = result.state;
    }

    expect(state.belts).toHaveLength(2);
    expect(state.belts.find((belt) => belt.id === unrelatedBelt.id)).toBe(unrelatedBelt);
    expect(state.construction.conveyor_belt_mk1).toBe(1_998);
  });
});
