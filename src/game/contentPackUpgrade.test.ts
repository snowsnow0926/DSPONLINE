/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSTRUCTION, getRecipe, TECHNOLOGIES } from "./content";
import { applyContentPackRegistry, commitContentPackRegistry, createContentPackRegistry, getContentPackUpdateReport, getContentPackValidationContext, getMissingContentPackRequirements, loadContentPackRegistry, registerContentPack, saveContentPackRegistry } from "./contentPacks";
import { advanceSimulation, canHandcraftRecipe, canQueueHandcraftRecipe, createInitialState, getRecursiveHandcraftPlan, handcraftRecipe, isHandcraftableRecipe, placeBuilding, queueHandcraftRecipe, setEntityRecipe } from "./engine";
import { validateContentPack, type ContentPackManifest } from "./mods";
import { exportGame, inspectSave } from "./storage";
import type { ItemId, TechnologyDefinition } from "./types";
import documentedRules from "../../docs/examples/example-rules-v3.content-pack.json";

function manifest(version = "1.0.0"): ContentPackManifest {
  return { formatVersion: 3, id: "upgrade_pack", name: "升级测试包", version,
    items: [{ id: "upgrade_plate", name: "升级合金" }],
    recipes: [{ id: "upgrade_recipe", name: "升级合金", buildingId: "assembling_machine_mk1", duration: 2, inputs: [{ itemId: "iron_ingot", amount: 1 }], outputs: [{ itemId: "upgrade_plate", amount: 1 }] }],
    technologies: [{ id: "upgrade_research", name: "合金研究", costs: [{ itemId: "electromagnetic_matrix", amount: 1 }] }],
  };
}

afterEach(() => { vi.restoreAllMocks(); applyContentPackRegistry(createContentPackRegistry()); localStorage.clear(); });

describe("content-pack recipe and technology rules", () => {
  it("validates and activates the documented v3 authoring example", () => {
    const validation = validateContentPack(documentedRules);
    expect(validation.issues).toEqual([]);
    const registry = registerContentPack(createContentPackRegistry(), validation).registry;
    const before = JSON.stringify(registry);
    expect(commitContentPackRegistry(registry, createContentPackRegistry()).persisted).toBe(true);
    expect(JSON.stringify(registry)).toBe(before);
    expect(isHandcraftableRecipe("example_machine_alloy_recipe" as never)).toBe(false);
  });
  it("enforces manual restrictions in direct crafting, recursive crafting, queues, and live production", () => {
    const pack = manifest();
    pack.recipes![0].handcraftable = false;
    const registry = registerContentPack(createContentPackRegistry(), validateContentPack(pack)).registry;
    expect(applyContentPackRegistry(registry).catalogValid).toBe(true);
    let state = createInitialState();
    state.tray.iron_ingot = 5;
    const recipeId = "upgrade_recipe" as never;
    expect(isHandcraftableRecipe(recipeId)).toBe(false);
    expect(canHandcraftRecipe(state, recipeId)).toBe(false);
    expect(canQueueHandcraftRecipe(state, recipeId)).toBe(false);
    expect(getRecursiveHandcraftPlan(state, recipeId).possible).toBe(false);
    expect(handcraftRecipe(state, recipeId)).toBe(state);
    expect(queueHandcraftRecipe(state, recipeId)).toBe(state);
    state.construction.assembling_machine_mk1 = 1;
    state.construction.wind_turbine = 10;
    state = placeBuilding(state, "wind_turbine", { x: -200, y: 0 }, 10);
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const machine = state.entities.find((entry) => entry.buildingId === "assembling_machine_mk1")!;
    state = setEntityRecipe(state, machine.id, recipeId);
    state.entities.find((entry) => entry.id === machine.id)!.inputs.iron_ingot = 1;
    expect(advanceSimulation(state, 5).entities.find((entry) => entry.id === machine.id)!.outputs["upgrade_plate" as ItemId]).toBe(1);
  });

  it("finishes a paid queue batch after an update without charging or starting another forbidden batch", () => {
    const pack = manifest();
    let registry = registerContentPack(createContentPackRegistry(), validateContentPack(pack)).registry;
    applyContentPackRegistry(registry);
    let state = createInitialState();
    state.tray.iron_ingot = 10;
    state = queueHandcraftRecipe(state, "upgrade_recipe" as never, 2);
    state = advanceSimulation(state, 1);
    expect(state.tray.iron_ingot).toBe(9);
    pack.version = "1.1.0";
    pack.recipes![0].handcraftable = false;
    registry = registerContentPack(registry, validateContentPack(pack)).registry;
    applyContentPackRegistry(registry);
    const result = advanceSimulation(state, 10);
    expect(result.tray.iron_ingot).toBe(9);
    expect(result.tray["upgrade_plate" as ItemId]).toBe(1);
    expect(result.handcraftQueue[0].batchesRemaining).toBe(1);
  });

  it("applies core recipe, construction and research overrides, then restores the exact core", () => {
    const original = structuredClone({ recipe: getRecipe("gear"), technology: TECHNOLOGIES.basic_logistics, construction: CONSTRUCTION.find((entry) => entry.buildingId === "storage_mk1") });
    const pack = manifest();
    pack.recipeOverrides = [{ id: "gear", requiredTechId: "upgrade_research", handcraftable: false, duration: 3 }];
    pack.constructionOverrides = [{ id: "storage_mk1", requiredTechId: "upgrade_research" }];
    pack.technologyOverrides = [{ id: "basic_logistics", prerequisites: ["upgrade_research"], costs: [{ itemId: "energy_matrix", amount: 7 }] }];
    expect(applyContentPackRegistry(registerContentPack(createContentPackRegistry(), validateContentPack(pack)).registry).catalogValid).toBe(true);
    expect(getRecipe("gear")).toMatchObject({ handcraftable: false, requiredTechId: "upgrade_research", duration: 3 });
    expect(TECHNOLOGIES.basic_logistics.prerequisites).toEqual(["upgrade_research"]);
    expect((TECHNOLOGIES as unknown as Record<string, TechnologyDefinition>).upgrade_research.unlocks).toEqual(expect.arrayContaining(["齿轮", "小型储物仓"]));
    expect(CONSTRUCTION.find((entry) => entry.buildingId === "storage_mk1")?.requiredTechId).toBe("upgrade_research");
    applyContentPackRegistry(createContentPackRegistry());
    expect({ recipe: getRecipe("gear"), technology: TECHNOLOGIES.basic_logistics, construction: CONSTRUCTION.find((entry) => entry.buildingId === "storage_mk1") }).toEqual(original);
  });

  it("rejects invalid booleans, missing construction technologies, unusable research costs and mixed core/custom cycles", () => {
    const pack = manifest();
    pack.recipes![0].handcraftable = "false" as never;
    pack.buildings = [{ id: "upgrade_building", name: "坏建筑", requiredTechId: "missing_tech", costs: [{ itemId: "missing_item", amount: 1 }] }];
    pack.technologies![0].prerequisites = ["basic_logistics"];
    pack.technologies![0].costs = [{ itemId: "iron_ingot", amount: 1 }];
    pack.technologyOverrides = [{ id: "basic_logistics", prerequisites: ["upgrade_research"] }];
    const result = validateContentPack(pack);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["recipe-handcraftable", "building-tech", "building-cost", "technology-cost-item", "technology-cycle"]));
  });
});

describe("non-destructive content-pack updates", () => {
  it("updates an in-use pack and reloads older saves with all original inventory and research", () => {
    const first = manifest();
    const old = registerContentPack(createContentPackRegistry(), validateContentPack(first)).registry;
    expect(commitContentPackRegistry(old, createContentPackRegistry()).persisted).toBe(true);
    const state = createInitialState();
    state.tray["upgrade_plate" as ItemId] = 57;
    state.research.completedTechIds.push("upgrade_research" as never);
    const oldSave = exportGame(state);
    const next = manifest("1.1.0");
    next.items!.push({ id: "upgrade_extra", name: "新增合金" });
    next.recipes![0].handcraftable = false;
    const parsed = validateContentPack(next, getContentPackValidationContext(old, next.id));
    expect(parsed.valid).toBe(true); // Own active IDs must not look like core overrides.
    const updated = registerContentPack(old, parsed).registry;
    expect(commitContentPackRegistry(updated, old).persisted).toBe(true);
    const reloaded = loadContentPackRegistry();
    expect(getMissingContentPackRequirements([{ id: first.id, version: first.version }], reloaded)).toEqual([]);
    const restored = inspectSave(oldSave);
    expect(restored.valid).toBe(true);
    expect(restored.state!.tray["upgrade_plate" as ItemId]).toBe(57);
    expect(restored.state!.research.completedTechIds).toContain("upgrade_research");
    expect(reloaded.packs[first.id].previousManifests?.[0].version).toBe("1.0.0");
    expect(state.tray["upgrade_plate" as ItemId]).toBe(57);
    expect(getMissingContentPackRequirements([{ id: first.id, version: "0.0.1" }], reloaded)).not.toEqual([]);
  });

  it.each(["delete", "rename", "recipe-materials", "item-kind", "same-version"])("rejects %s updates without replacing the old registry", (change) => {
    const first = manifest();
    const registry = registerContentPack(createContentPackRegistry(), validateContentPack(first)).registry;
    const next = manifest("1.1.0");
    if (change === "delete") next.items = [];
    if (change === "rename") next.items![0].id = "renamed_plate";
    if (change === "recipe-materials") next.recipes![0].inputs[0].amount = 8;
    if (change === "item-kind") next.items![0].kind = "fluid";
    if (change === "same-version") { next.version = first.version; next.name = "偷偷改名"; }
    expect(getContentPackUpdateReport(first, next).compatible).toBe(false);
    expect(registerContentPack(registry, { ...validateContentPack(first), manifest: next }).registry).toBe(registry);
  });

  it("rolls back runtime activation when persistent storage rejects an update", () => {
    const old = registerContentPack(createContentPackRegistry(), validateContentPack(manifest())).registry;
    commitContentPackRegistry(old, createContentPackRegistry());
    const next = manifest("1.1.0");
    next.recipes![0].handcraftable = false;
    const updated = registerContentPack(old, validateContentPack(next)).registry;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    expect(commitContentPackRegistry(updated, old).persisted).toBe(false);
    expect(isHandcraftableRecipe("upgrade_recipe" as never)).toBe(true);
    expect(loadContentPackRegistry().packs.upgrade_pack.manifest.version).toBe("1.0.0");
  });

  it("protects enabled dependents from an incompatible version bump", () => {
    let registry = registerContentPack(createContentPackRegistry(), validateContentPack(manifest())).registry;
    registry = registerContentPack(registry, validateContentPack({ formatVersion: 3, id: "dependent_pack", name: "依赖包", version: "1.0.0", dependencies: ["upgrade_pack@~1.0.0"] })).registry;
    expect(registerContentPack(registry, validateContentPack(manifest("1.1.0"))).registry).toBe(registry);
  });

  it("refuses lower core buffer limits in a compatible update", () => {
    const first = manifest();
    first.buildingOverrides = [{ id: "arc_smelter", inputCapacity: 1000 }];
    const next = manifest("1.1.0");
    next.buildingOverrides = [{ id: "arc_smelter", inputCapacity: 10 }];
    expect(getContentPackUpdateReport(first, next).compatible).toBe(false);
  });
});
