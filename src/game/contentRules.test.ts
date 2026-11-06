import { afterEach, describe, expect, it } from "vitest";
import { createExampleContentPack } from "../components/ContentPackAuthor";
import { applyContentPackRegistry, createContentPackRegistry, getContentPackUpdateReport, getContentPackUsage, getContentPackValidationContext, registerContentPack } from "./contentPacks";
import { getContentRules, getRecipeMissingTechnology } from "./contentRules";
import { migrateContentPackIds } from "./contentIdMigration";
import { BUILDINGS, FUEL_ENERGY_MJ, RECIPES, getFuelItemIdsForBuilding, getRecipesForBuilding } from "./content";
import { placeBuilding as addBuilding, advanceSimulation, createInitialState, getEntityInputCapacity, getMiningSpeedMultiplier, getRecipeSpeedMultiplier, installMiner, setEntityRecipe, setFuelItem } from "./engine";
import { validateContentPack } from "./mods";
import { migrateGame } from "./storage";
import { createContentPackRuntimeSnapshot } from "./contentPacks";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import type { BuildingId, ItemId, RecipeId, TechId } from "./types";
const CRYSTAL_ORE = "crystal_ore" as ItemId;
const CRYSTAL_RAW = "crystal_raw" as ItemId;
const CRYSTAL_PLATE = "crystal_plate" as ItemId;
const CRYSTAL_FURNACE = "crystal_furnace" as BuildingId;
const CRYSTAL_GENERATOR = "crystal_generator" as BuildingId;
const CRYSTAL_DRILL = "crystal_drill" as BuildingId;
const CRYSTAL_EFFICIENCY = "crystal_efficiency" as TechId;
const CRYSTAL_PLATE_RECIPE = "crystal_plate_recipe" as RecipeId;

afterEach(() => applyContentPackRegistry(createContentPackRegistry()));
function activate() {
  const manifest = createExampleContentPack();
  const validation = validateContentPack(manifest);
  expect(validation.issues).toEqual([]);
  const registry = registerContentPack(createContentPackRegistry(), validation).registry;
  expect(applyContentPackRegistry(registry).catalogValid).toBe(true);
  return { manifest, registry };
}

describe("content pack v4 gameplay rules", () => {
  it("installs the complete author example and exports the same rules to native", () => {
    const { registry } = activate();
    expect(FUEL_ENERGY_MJ[CRYSTAL_ORE]).toBe(12);
    expect(getFuelItemIdsForBuilding(CRYSTAL_GENERATOR)).toEqual([CRYSTAL_ORE]);
    expect(getRecipesForBuilding(CRYSTAL_FURNACE).map((recipe) => recipe.id)).toEqual([CRYSTAL_PLATE_RECIPE]);
    const native = createNativeCoreCatalog(createContentPackRuntimeSnapshot(registry));
    expect(native.contentRules).toEqual(getContentRules());
    expect(native.buildings.find((building) => building.id === CRYSTAL_GENERATOR)?.fuelEfficiency).toBe(0.8);
  });
  it("applies all researched multipliers and gates recipe groups in actual commands", () => {
    activate();
    let state = createInitialState();
    state.construction[CRYSTAL_FURNACE] = 1;
    state = addBuilding(state, CRYSTAL_FURNACE, { x: 100, y: 100 });
    const entity = state.entities.find((entry) => entry.buildingId === CRYSTAL_FURNACE)!;
    expect(entity.recipeId).toBeUndefined();
    expect(setEntityRecipe(state, entity.id, CRYSTAL_PLATE_RECIPE)).toBe(state);
    const mining = getMiningSpeedMultiplier(state);
    const speed = getRecipeSpeedMultiplier(state, CRYSTAL_PLATE_RECIPE);
    const capacity = getEntityInputCapacity(state, entity);
    state.research.completedTechIds.push(CRYSTAL_EFFICIENCY);
    expect(getMiningSpeedMultiplier(state)).toBe(mining * 2);
    expect(getRecipeSpeedMultiplier(state, CRYSTAL_PLATE_RECIPE)).toBe(speed * 2);
    expect(getEntityInputCapacity(state, entity)).toBe(capacity * 2);
    expect(setEntityRecipe(state, entity.id, CRYSTAL_PLATE_RECIPE).entities.find((entry) => entry.id === entity.id)?.recipeId).toBe(CRYSTAL_PLATE_RECIPE);
    expect(getRecipeMissingTechnology(RECIPES[CRYSTAL_PLATE_RECIPE], new Set())).toBe(CRYSTAL_EFFICIENCY);
  });
  it("creates persistent custom veins once and extracts integer resources with a custom miner", () => {
    const { registry } = activate();
    let state = createInitialState();
    const vein = state.entities.find((entry) => entry.resourceId === CRYSTAL_ORE)!;
    expect(vein.resourceRemaining).toBe(100000);
    state.construction[CRYSTAL_DRILL] = 1;
    state.construction[CRYSTAL_GENERATOR] = 1;
    state = installMiner(state, vein.id);
    state = addBuilding(state, CRYSTAL_GENERATOR, { ...vein.position, x: vein.position.x + 100 });
    const generator = state.entities.find((entry) => entry.buildingId === CRYSTAL_GENERATOR)!;
    state = setFuelItem(state, generator.id, CRYSTAL_ORE);
    state.entities.find((entry) => entry.id === generator.id)!.inputs[CRYSTAL_ORE] = 50;
    state.settings.resourceMode = "finite";
    state = advanceSimulation(state, 10);
    const mined = state.entities.find((entry) => entry.id === vein.id)!;
    expect(mined.outputs[CRYSTAL_ORE]).toBeGreaterThan(0);
    expect(Number.isInteger(mined.outputs[CRYSTAL_ORE])).toBe(true);
    expect(mined.resourceRemaining).toBeLessThan(100000);
    expect(state.entities.find((entry) => entry.id === generator.id)!.inputs[CRYSTAL_ORE]).toBeLessThan(50);
    const loaded = migrateGame(state, registry)!;
    expect(loaded.entities.filter((entry) => entry.resourceId === CRYSTAL_ORE)).toHaveLength(1);
    expect(loaded.entities.find((entry) => entry.id === vein.id)?.resourceRemaining).toBe(mined.resourceRemaining);
  });
  it("preserves existing material and queues through a declared ID rename", () => {
    const { manifest, registry } = activate();
    const next = structuredClone(manifest);
    next.version = "1.1.0";
    next.idMigrations = [{ kind: "items", from: CRYSTAL_ORE, to: CRYSTAL_RAW }];
    next.items![0].id = CRYSTAL_RAW;
    next.recipes![0].inputs[0].itemId = CRYSTAL_RAW;
    next.fuels![0].itemId = CRYSTAL_RAW;
    next.generators![0].fuelItemIds = [CRYSTAL_RAW];
    next.resources![0].itemId = CRYSTAL_RAW;
    expect(getContentPackUpdateReport(manifest, next).compatible).toBe(true);
    const state = createInitialState();
    state.tray[CRYSTAL_ORE] = 17;
    state.entities.find((entry) => entry.resourceId === CRYSTAL_ORE)!.outputs[CRYSTAL_ORE] = 23;
    const updatedRegistry = registerContentPack(registry, validateContentPack(next)).registry;
    expect(applyContentPackRegistry(updatedRegistry).catalogValid).toBe(true);
    state.contentPacks = [{ id: manifest.id, version: manifest.version }];
    const portable = updatedRegistry.packs[manifest.id].manifest;
    const freshRegistry = registerContentPack(createContentPackRegistry(), validateContentPack(portable)).registry;
    const loaded = migrateGame(state, freshRegistry)!;
    expect(loaded.tray[CRYSTAL_RAW]).toBe(17);
    expect(loaded.entities.find((entry) => entry.resourceId === CRYSTAL_RAW)?.outputs[CRYSTAL_RAW]).toBe(23);
    expect(loaded.entities.filter((entry) => entry.resourceId === CRYSTAL_RAW)).toHaveLength(1);
    expect(state.tray[CRYSTAL_ORE]).toBe(17);
    expect(getContentPackUpdateReport(portable, validateContentPack(next).manifest!).issues).toEqual([]);
  });
  it("merges material using exact decimal arithmetic and leaves entity identities alone", () => {
    const original = { entities: [{ id: "old_item", itemId: "old_item", inputs: { old_item: 12, new_item: 5 } }], inventory: { old_item: "999999999999999999999", new_item: "1" }, research: { completedTechIds: ["old_tech", "new_tech"], progressByTech: { old_tech: { new_item: 8 }, new_tech: { new_item: 5 } } } };
    const result = migrateContentPackIds(original, [{ kind: "items", from: "old_item", to: "new_item" }, { kind: "technologies", from: "old_tech", to: "new_tech" }]);
    expect(result.entities[0].id).toBe("old_item");
    expect(result.entities[0].inputs).toEqual({ new_item: 17 });
    expect(result.inventory).toEqual({ new_item: "1000000000000000000000" });
    expect(result.research.completedTechIds).toEqual(["new_tech"]);
    expect(result.research.progressByTech).toEqual({ new_tech: { new_item: 8 } });
  });
  it("migrates current and planned output item references", () => {
    const state = { currentItemId: "old_item", tasks: [{ outputItemId: "old_item" }] };
    expect(migrateContentPackIds(state, [{ kind: "items", from: "old_item", to: "new_item" }])).toEqual({ currentItemId: "new_item", tasks: [{ outputItemId: "new_item" }] });
  });
  it("merges fractional progress in native map order regardless of JSON insertion order", () => {
    const migrations = ["old_a", "old_b", "old_c"].map((from) => ({ kind: "items" as const, from, to: "new_item" }));
    const result = migrateContentPackIds({ proliferatorBonusProgress: { old_c: 0.3, old_b: 0.2, old_a: 0.1 } }, migrations);
    expect(result.proliferatorBonusProgress).toEqual({ new_item: 0.1 + 0.2 + 0.3 });
  });
  it("counts rule-only updates in the compatibility preview", () => {
    const previous = createExampleContentPack();
    const next = structuredClone(previous);
    next.version = "1.1.0";
    next.technologyEffects![0].productionSpeed = 3;
    expect(getContentPackUpdateReport(previous, next)).toMatchObject({ compatible: true, added: 0, changed: 1 });
  });
  it("checks every old definition when multiple IDs merge into one target", () => {
    const previous = { ...createExampleContentPack(), buildings: [], recipes: [], resources: [], fuels: [], generators: [], recipePolicies: [], recipeGroups: [], items: [{ id: "old_liquid", name: "液体", kind: "fluid" as const }, { id: "old_solid", name: "固体", kind: "solid" as const }] };
    const next = { ...previous, version: "1.1.0", items: [{ id: "new_item", name: "新物品", kind: "solid" as const }], idMigrations: [{ kind: "items" as const, from: "old_liquid", to: "new_item" }, { kind: "items" as const, from: "old_solid", to: "new_item" }] };
    expect(getContentPackUpdateReport(previous, next).issues).toContain("new_item 的 kind 与旧存档不兼容，请使用新的内容 ID");
  });
  it("keeps all old names readable through a second rename", () => {
    const first = { ...createExampleContentPack(), idMigrations: [{ kind: "items" as const, from: "older_ore", to: "crystal_ore" }] };
    const second = structuredClone(first);
    second.version = "2.0.0";
    second.items![0].id = "newer_ore";
    second.recipes![0].inputs[0].itemId = "newer_ore";
    second.fuels![0].itemId = "newer_ore";
    second.generators![0].fuelItemIds = ["newer_ore"];
    second.resources![0].itemId = "newer_ore";
    second.idMigrations = [{ kind: "items", from: "older_ore", to: "newer_ore" }, { kind: "items", from: "crystal_ore", to: "newer_ore" }];
    expect(validateContentPack(second).valid).toBe(true);
    expect(getContentPackUpdateReport(first, second).issues).toEqual([]);
    expect(migrateContentPackIds({ tray: { older_ore: 7, crystal_ore: 11 } }, second.idMigrations)).toEqual({ tray: { newer_ore: 18 } });
  });
  it("protects a resource pack even before its first ore is mined", () => {
    const { manifest } = activate();
    expect(getContentPackUsage(createInitialState(), manifest).total).toBeGreaterThan(0);
  });
  it("refuses to turn already installed miners into a different extractor during an update", () => {
    const { manifest } = activate();
    const next = structuredClone(manifest);
    next.version = "1.1.0";
    next.resources![0].extractorBuildingId = "mining_machine";
    expect(getContentPackUpdateReport(manifest, next).compatible).toBe(false);
  });
  it("resolves a dependency's declared fuel before that pack is applied", () => {
    const source = validateContentPack({ formatVersion: 4, id: "fuel_library", name: "燃料库", version: "1.0.0", items: [{ id: "library_fuel", name: "燃料" }], buildings: [{ id: "library_generator", name: "电站", kind: "power", powerGenerationKw: 1000 }], fuels: [{ itemId: "library_fuel", energyMj: 12 }] });
    const registry = registerContentPack(createContentPackRegistry(), source).registry;
    const consumer = validateContentPack({ formatVersion: 4, id: "fuel_consumer", name: "发电", version: "1.0.0", dependencies: ["fuel_library"], generators: [{ buildingId: "library_generator", fuelItemIds: ["library_fuel"], efficiency: 0.8 }] }, getContentPackValidationContext(registry));
    expect(consumer.issues).toEqual([]);
    expect(consumer.valid).toBe(true);
  });
  it("uses the default machine kind when validating a recipe policy", () => {
    expect(validateContentPack({ formatVersion: 4, id: "default_policy", name: "默认设备", version: "1.0.0", buildings: [{ id: "generic_machine", name: "制造机" }], recipePolicies: [{ buildingId: "generic_machine", recipeIds: ["gear"] }] }).valid).toBe(true);
  });
  it.each([
    { technologyEffects: [{ technologyId: "electromagnetism", productionSpeed: -1 }] },
    { recipePolicies: [{ buildingId: "missing", recipeIds: [] }] },
    { resources: [{ itemId: "iron_ore", extractorBuildingId: "mining_machine", planetIds: ["home"], reserve: 5 }] },
    { items: [{ id: "new_item", name: "unsafe", icon: "https://example.test/icon.png" }] },
    { idMigrations: [{ kind: "items", from: "iron_ore", to: "new_item" }] },
  ])("rejects malformed or unsafe rules %j", (rules) => {
    expect(validateContentPack({ ...createExampleContentPack(), ...rules }).valid).toBe(false);
  });
  it("does not keep overrides after disabling the pack", () => {
    activate();
    applyContentPackRegistry(createContentPackRegistry());
    expect(getContentRules().technologyEffects).toEqual([]);
    expect(BUILDINGS[CRYSTAL_FURNACE]).toBeUndefined();
    expect(FUEL_ENERGY_MJ[CRYSTAL_ORE]).toBeUndefined();
  });
});
