import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import {
  FACTORY_READ_MODEL_LIMITS,
  FACTORY_READ_MODEL_SCHEMA,
} from "./factoryReadModels";
import type {
  BeltConnection,
  BuildingId,
  ConstructionAutomationJob,
  ConstructionId,
  FactoryEntity,
  ItemId,
  RecipeId,
} from "./types";
import { createWebFactoryReadModels } from "./webFactoryReadModelAdapter";

const asItemId = (id: string) => id as ItemId;
const asBuildingId = (id: string) => id as BuildingId;
const asRecipeId = (id: string) => id as RecipeId;
const asConstructionId = (id: string) => id as ConstructionId;

function visitObjects(value: unknown, visit: (object: object) => void, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  visit(value);
  for (const child of Object.values(value)) visitObjects(child, visit, seen);
}

function makeEntity(base: FactoryEntity, id: string): FactoryEntity {
  return {
    ...base,
    id,
    kind: "machine",
    buildingId: "assembling_machine_mk1",
    resourceId: undefined,
    recipeId: "iron_ingot",
    storedItemId: undefined,
    position: { ...base.position },
    inputs: {},
    outputs: {},
  };
}

function makeBelt(id: string, source: string, target: string): BeltConnection {
  return {
    id,
    planetId: "home",
    source,
    target,
    itemId: "iron_ingot",
    lanes: 1,
    tier: 1,
    sorterTier: 1,
    progress: 0,
    priority: 1,
    lastFlow: 0,
  };
}

describe("Web/PWA factory read-model adapter", () => {
  it("returns detached bounded projections without full GameState, entity, or belt objects", () => {
    const state = createInitialState();
    const source = makeEntity(state.entities[0], "selected-source");
    const target = makeEntity(state.entities[1], "selected-target");
    const belt = makeBelt("selected-belt", source.id, target.id);
    state.entities = [source, target];
    state.belts = [belt];
    const before = JSON.stringify(state);

    const model = createWebFactoryReadModels(state, {
      selectedEntityIds: [source.id],
      selectedBeltIds: [belt.id],
    });

    expect(model.shell.schema).toBe(FACTORY_READ_MODEL_SCHEMA);
    expect(model).not.toHaveProperty("entities");
    expect(model).not.toHaveProperty("belts");
    expect(model.selection.entityRows.rows[0]).not.toHaveProperty("stationRoutes");
    expect(model.selection.beltRows.rows[0]).not.toHaveProperty("routeOffsetY");
    const forbiddenKeys = new Set([
      "entities", "belts", "planetTrays", "totalProduced", "research", "exploration",
      "galaxy", "settings", "dysonSphere", "dysonPlans", "productionHistory",
    ]);
    const sourceObjects = new Set<object>([state, ...state.entities, ...state.belts]);
    visitObjects(model, (object) => {
      expect(sourceObjects.has(object)).toBe(false);
      for (const key of Object.keys(object)) expect(forbiddenKeys.has(key)).toBe(false);
    });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("keeps deterministic ordering, exact large values, and opaque content-pack IDs", () => {
    const state = createInitialState();
    const large = Number.MAX_SAFE_INTEGER - 31;
    const customItemZ = asItemId("mod.acme:item-z");
    const customItemA = asItemId("mod.acme:item-a");
    const customBuilding = asBuildingId("mod.acme:quantum-assembler");
    const customRecipe = asRecipeId("mod.acme:fold-matter");
    const customConstruction = asConstructionId("mod.acme:quantum-assembler");
    const first = {
      ...makeEntity(state.entities[0], "entity-z"),
      buildingId: customBuilding,
      recipeId: customRecipe,
      machineCount: large,
      inputs: { [customItemZ]: large, [customItemA]: large - 1 },
      outputs: { [customItemZ]: large - 2 },
    };
    const second = makeEntity(state.entities[1], "entity-a");
    const beltZ = {
      ...makeBelt("belt-z", first.id, second.id),
      itemId: customItemZ,
      totalTransferred: large,
    };
    const beltA = makeBelt("belt-a", second.id, first.id);
    state.entities = [second, first];
    state.belts = [beltA, beltZ];
    state.elapsedSeconds = large;
    state.constructionQueue = [
      {
        id: "queue-z",
        blueprintId: "mod.acme:factory-blueprint",
        blueprintName: "MOD Factory",
        planetId: "home",
        position: { x: 1, y: 2 },
        rotation: 0,
        mirror: "none",
        queuedAt: 20,
        reservedConstruction: { [customConstruction]: large },
      },
      {
        id: "queue-a",
        blueprintId: "core-blueprint",
        blueprintName: "Core Factory",
        planetId: "home",
        position: { x: 3, y: 4 },
        rotation: 0,
        mirror: "none",
        queuedAt: 10,
      },
    ];
    state.constructionAutomation = {
      ...state.constructionAutomation,
      totalCrafted: large,
      lastCraftedId: customConstruction,
      targetStock: {
        [customConstruction]: large,
        assembling_machine_mk1: 7,
      },
    };

    const model = createWebFactoryReadModels(state, {
      selectedEntityIds: [first.id, second.id],
      selectedBeltIds: [beltZ.id, beltA.id],
    });

    expect(model.shell.elapsedSeconds).toBe(large);
    expect(model.selection.entityRows.rows.map((row) => row.entityId)).toEqual(["entity-z", "entity-a"]);
    expect(model.selection.beltRows.rows.map((row) => row.beltId)).toEqual(["belt-z", "belt-a"]);
    expect(model.selection.entityRows.rows[0]).toMatchObject({
      buildingId: customBuilding,
      recipeId: customRecipe,
      machineCount: large,
    });
    expect(model.selection.entityRows.rows[0].inputItems.rows).toEqual([
      { itemId: customItemA, amount: large - 1 },
      { itemId: customItemZ, amount: large },
    ]);
    expect(model.selection.beltRows.rows[0]).toMatchObject({ itemId: customItemZ, totalTransferred: large });
    expect(model.construction.queue.rows.map((row) => row.queueId)).toEqual(["queue-a", "queue-z"]);
    expect(model.construction.queue.rows[1].reservedConstruction.rows).toEqual([
      { constructionId: customConstruction, amount: large },
    ]);
    expect(model.construction.automation.totalCrafted).toBe(large);
    expect(model.construction.automation.lastCraftedId).toBe(customConstruction);
    expect(model.construction.automation.targets.rows.map((row) => row.targetId)).toEqual([
      "assembling_machine_mk1",
      customConstruction,
    ]);
    expect(model.planetNavigation.planets.rows.slice(0, 3).map((row) => row.planetId)).toEqual([
      "home", "ashen", "giant",
    ]);
  });

  it("enforces every list cap while retaining totals and truncation evidence", () => {
    const state = createInitialState();
    const base = state.entities[0];
    const entityCount = FACTORY_READ_MODEL_LIMITS.selectedEntityRows + 9;
    state.entities = Array.from({ length: entityCount }, (_, index) => {
      const itemEntries = Array.from({ length: FACTORY_READ_MODEL_LIMITS.itemRows + 5 }, (__, itemIndex) => [
        asItemId(`mod.bulk:item-${String(itemIndex).padStart(3, "0")}`),
        itemIndex + 1,
      ]);
      return { ...makeEntity(base, `entity-${index}`), inputs: Object.fromEntries(itemEntries) };
    });
    state.belts = state.entities.map((entity, index) => makeBelt(`belt-${index}`, entity.id, entity.id));
    state.constructionQueue = Array.from(
      { length: FACTORY_READ_MODEL_LIMITS.constructionQueueRows + 7 },
      (_, index) => ({
        id: `queue-${index}`,
        blueprintId: `blueprint-${index}`,
        blueprintName: `Blueprint ${index}`,
        planetId: "home" as const,
        position: { x: index, y: index },
        rotation: 0 as const,
        mirror: "none" as const,
        queuedAt: index,
      }),
    );
    state.constructionAutomation.targetStock = Object.fromEntries(Array.from(
      { length: FACTORY_READ_MODEL_LIMITS.constructionTargetRows + 7 },
      (_, index) => [`mod.bulk:building-${index}`, index],
    ));
    state.constructionAutomation.jobs = Object.fromEntries(Array.from(
      { length: FACTORY_READ_MODEL_LIMITS.constructionJobRows + 7 },
      (_, index) => [`entity-${index}`, {
        constructionId: asConstructionId(`mod.bulk:building-${index}`),
        steps: [],
        stepIndex: 0,
        elapsedSeconds: index,
        inventory: {},
      } satisfies ConstructionAutomationJob],
    ));
    const selectedEntityIds = state.entities.map((entity) => entity.id);
    const selectedBeltIds = state.belts.map((belt) => belt.id);

    const model = createWebFactoryReadModels(state, { selectedEntityIds, selectedBeltIds });

    expect(model.selection.entityRows.rows).toHaveLength(FACTORY_READ_MODEL_LIMITS.selectedEntityRows);
    expect(model.selection.entityRows.truncated).toBe(true);
    expect(model.selection.beltRows.rows).toHaveLength(FACTORY_READ_MODEL_LIMITS.selectedBeltRows);
    expect(model.selection.beltRows.truncated).toBe(true);
    expect(model.selection.entityRows.rows[0].inputItems).toMatchObject({
      totalCount: FACTORY_READ_MODEL_LIMITS.itemRows + 5,
      truncated: true,
    });
    expect(model.construction.queue).toMatchObject({
      totalCount: FACTORY_READ_MODEL_LIMITS.constructionQueueRows + 7,
      truncated: true,
    });
    expect(model.construction.automation.targets).toMatchObject({
      totalCount: FACTORY_READ_MODEL_LIMITS.constructionTargetRows + 7,
      truncated: true,
    });
    expect(model.construction.automation.jobs).toMatchObject({
      totalCount: FACTORY_READ_MODEL_LIMITS.constructionJobRows + 7,
      truncated: true,
    });
  });
});
