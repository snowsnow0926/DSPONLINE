import { afterEach, describe, expect, it } from "vitest";
import { createExampleContentPack } from "../components/ContentPackAuthor";
import { getBeltSpeed, ITEMS } from "./content";
import { addContentPackResources } from "./contentRules";
import { applyContentPackRegistry, createContentPackRegistry, registerContentPack } from "./contentPacks";
import { advanceSimulation, createInitialState, placeBuilding } from "./engine";
import { validateContentPack } from "./mods";
import { migrateGame } from "./storage";
import { getVanillaSaveConversionPreview, prepareVanillaSaveConversion } from "./vanillaSaveConversion";
import type { BlueprintDefinition, BuildingId, ItemId, RecipeId, TechId } from "./types";

afterEach(() => applyContentPackRegistry(createContentPackRegistry()));
const ore = "crystal_ore" as ItemId;
const plate = "crystal_plate" as ItemId;
const recipeId = "crystal_plate_recipe" as RecipeId;
const techId = "crystal_efficiency" as TechId;

function fixture() {
  const manifest = createExampleContentPack();
  manifest.recipes![0].inputs.push({ itemId: "iron_ingot", amount: 2 });
  manifest.resources![0].extractorBuildingId = "mining_machine";
  manifest.buildings!.push({ id: "crystal_station", name: "晶体物流站", kind: "station", inputCapacity: 1000, outputCapacity: 1000, costs: [{ itemId: "iron_ingot", amount: 1 }] });
  manifest.belts = [{ id: "crystal_belt", name: "晶体带", tier: 4, speed: 90, costs: [{ itemId: "iron_ingot", amount: 1 }] }];
  manifest.itemOverrides = [{ id: "iron_ore", name: "重写铁矿" }];
  manifest.beltOverrides = [{ id: "conveyor_belt_mk1", speed: 17 }];
  const checked = validateContentPack(manifest);
  expect(checked.issues).toEqual([]);
  const registry = registerContentPack(createContentPackRegistry(), checked).registry;
  expect(applyContentPackRegistry(registry).catalogValid).toBe(true);
  let state = addContentPackResources(createInitialState());
  for (const buildingId of ["crystal_furnace", "arc_smelter", "storage_mk1"] as BuildingId[]) {
    state.construction[buildingId] = 1;
    state = placeBuilding(state, buildingId, { x: 180 + state.entities.length * 50, y: 300 });
  }
  state.paused = true;
  state.tray.iron_ingot = 17;
  state.tray[ore] = 9;
  state.construction.crystal_belt = 6;
  state.research.completedTechIds.push(techId);
  state.research.progressByTech[techId] = { electromagnetic_matrix: 3 };
  return { state, registry };
}

describe("conversion to vanilla gameplay", () => {
  it("removes occupied pack content, returns core resources and miners, and keeps a playable original factory", () => {
    const { state, registry } = fixture();
    const custom = state.entities.find(entity => entity.buildingId === "crystal_furnace" as BuildingId)!;
    const smelter = state.entities.find(entity => entity.buildingId === "arc_smelter")!;
    const store = state.entities.find(entity => entity.buildingId === "storage_mk1")!;
    smelter.id = "crystal_furnace";
    state.constructionAutomation.jobs[smelter.id] = { constructionId: "wind_turbine", steps: [], stepIndex: 0, elapsedSeconds: 0, inventory: { iron_ingot: 3 } };
    custom.inputs = { iron_ingot: 7, [ore]: 5 };
    custom.outputs = { copper_ingot: 4, [plate]: 3 };
    custom.sprayCoaterInstalled = true;
    smelter.recipeId = recipeId;
    smelter.inputs = { iron_ingot: 5, [ore]: 4 };
    smelter.progress = 0.7;
    store.storedItemId = ore;
    store.outputs = { [ore]: 12, iron_ingot: 2 };
    const vein = state.entities.find(entity => entity.resourceId === ore)!;
    vein.minerCount = 3;
    vein.resourceRemaining = 59;
    delete vein.extractorBuildingId;
    state.belts = [
      { id: "core_line", source: custom.id, target: store.id, itemId: "iron_ingot", planetId: "home", tier: 1, sorterTier: 1, lanes: 2, progress: 0.4, priority: 2, lastFlow: 0 },
      { id: "custom_line", source: smelter.id, target: store.id, itemId: "iron_ingot", planetId: "home", tier: 4, sorterTier: 1, lanes: 3, progress: 0.4, priority: 2, lastFlow: 0 },
    ];
    const miningBefore = state.construction.mining_machine ?? 0;
    const beltsBefore = state.construction.conveyor_belt_mk1 ?? 0;
    const original = JSON.stringify(state);
    const originalRegistry = JSON.stringify(registry);
    const plan = prepareVanillaSaveConversion(state, registry);
    expect(plan.issues).toEqual([]);
    expect(JSON.stringify(state)).toBe(original);
    expect(JSON.stringify(registry)).toBe(originalRegistry);
    expect(plan.state.entities.some(entity => entity.id === custom.id || entity.id === vein.id)).toBe(false);
    expect(plan.state.entities.find(entity => entity.id === smelter.id)).toMatchObject({ progress: 0, inputs: { iron_ingot: 5 } });
    expect(plan.state.entities.find(entity => entity.id === smelter.id)?.recipeId).toBeUndefined();
    expect(plan.state.entities.find(entity => entity.id === store.id)?.outputs).toEqual({ iron_ingot: 2 });
    expect(plan.state.tray.iron_ingot).toBe(24);
    expect(plan.state.tray.copper_ingot).toBe((state.tray.copper_ingot ?? 0) + 4);
    expect(plan.state.tray[ore]).toBeUndefined();
    expect(plan.state.construction.mining_machine).toBe(miningBefore + 3);
    expect(plan.state.construction.conveyor_belt_mk1).toBe(beltsBefore + 2);
    expect(plan.state.construction.crystal_belt).toBeUndefined();
    expect(plan.state.belts).toEqual([]);
    expect(plan.state.research.completedTechIds).toEqual(state.research.completedTechIds.filter(id => id !== techId));
    expect(plan.state.contentPacks).toEqual([]);
    expect(plan.state.constructionAutomation.jobs.crystal_furnace.inventory).toEqual({ iron_ingot: 3 });
    expect(plan.registry.packs.crystal_industry.enabled).toBe(false);
    expect(plan.registry.packs.crystal_industry.manifest).toEqual(registry.packs.crystal_industry.manifest);
    expect(applyContentPackRegistry(plan.registry).catalogValid).toBe(true);
    expect(ITEMS.iron_ore.name).not.toBe("重写铁矿");
    expect(getBeltSpeed(1)).toBe(6);
    const loaded = migrateGame(plan.state, plan.registry);
    expect(loaded?.tray.iron_ingot).toBe(24);
    const continued = advanceSimulation({ ...loaded!, paused: false }, 2);
    expect(continued.elapsedSeconds).toBeGreaterThan(loaded!.elapsedSeconds);
  });

  it("preserves core blueprint parts and returns funded reservations and the one paid handcraft batch", () => {
    const { state, registry } = fixture();
    const blueprint: BlueprintDefinition = {
      id: "mixed", name: "混合蓝图", revision: 1,
      entities: [{ key: "core", buildingId: "wind_turbine", offset: { x: 0, y: 0 }, machineCount: 1 }, { key: "mod", buildingId: "crystal_furnace" as BuildingId, offset: { x: 100, y: 0 }, machineCount: 1 }],
      resourceAnchors: [{ key: "ore", resourceId: ore, extractorBuildingId: "mining_machine", minerCount: 2, offset: { x: 0, y: 90 } }],
      belts: [{ key: "b", sourceKey: "mod", targetKey: "core", itemId: "iron_ingot", tier: 1, sorterTier: 1, lanes: 1, priority: 2 }],
      externalPorts: [{ key: "p", entityKey: "mod", direction: "output", itemId: "iron_ingot", offset: { x: 0, y: 0 } }],
    };
    state.blueprints = [blueprint];
    state.blueprintVersions = [{ id: "mixed_v1", blueprintId: "mixed", revision: 1, definition: structuredClone(blueprint) }];
    state.constructionQueue = [{ id: "queued", blueprintId: "mixed", blueprintVersionId: "mixed_v1", blueprintName: "混合蓝图", planetId: "home", position: { x: 10, y: 20 }, rotation: 0, mirror: "none", queuedAt: 0, reservedConstruction: { wind_turbine: 2, crystal_furnace: 3 }, reservedFleet: { logistics_vessel: 4 } }];
    state.handcraftQueue = [{ id: "craft", recipeId, planetId: "home", batchesTotal: 5, batchesRemaining: 5, progress: 0.5, queuedAt: 0 }];
    state.constructionAutomation.jobs.center = { constructionId: "crystal_furnace", steps: [], stepIndex: 0, elapsedSeconds: 0, inventory: { iron_ingot: 3, [ore]: 7 } };
    const windBefore = state.construction.wind_turbine ?? 0;
    const fleetBefore = state.portableFleet.logistics_vessel;
    const plan = prepareVanillaSaveConversion(state, registry);
    expect(plan.issues).toEqual([]);
    expect(plan.preview).toMatchObject({ blueprints: 1, constructionOrders: 1, handcraftOrders: 1 });
    expect(plan.state.tray.iron_ingot).toBe(22);
    expect(plan.state.construction.wind_turbine).toBe(windBefore + 2);
    expect(plan.state.portableFleet.logistics_vessel).toBe(fleetBefore + 4);
    expect(plan.state.constructionQueue).toEqual([]);
    expect(plan.state.handcraftQueue).toEqual([]);
    expect(plan.state.constructionAutomation.jobs).toEqual({});
    expect(plan.state.blueprints[0]).toMatchObject({ id: "mixed", name: "混合蓝图", entities: [{ key: "core" }], resourceAnchors: [], belts: [], externalPorts: [] });
    expect(plan.state.blueprintVersions[0].definition).toEqual(plan.state.blueprints[0]);
  });

  it("leaves a cancelled station cargo reservation in its source inventory and refunds warpers once", () => {
    const { state, registry } = fixture();
    const supply = state.entities.find(entity => entity.buildingId === "arc_smelter")!;
    const removed = state.entities.find(entity => entity.buildingId === "crystal_furnace" as BuildingId)!;
    supply.outputs = { iron_ingot: 100 };
    removed.stationRoutes = [{ id: "route", peerId: supply.id, itemId: "iron_ingot", scope: "remote", slotIndex: 0, cargo: 20, vehicleCount: 2, progress: 0.2, duration: 10, requiresWarp: true }];
    const warpers = state.tray.space_warper ?? 0;
    const plan = prepareVanillaSaveConversion(state, registry);
    expect(plan.issues).toEqual([]);
    expect(plan.state.entities.find(entity => entity.id === supply.id)?.outputs.iron_ingot).toBe(100);
    expect(plan.state.tray.iron_ingot).toBe(17);
    expect(plan.state.tray.space_warper).toBe(warpers + 2);
  });

  it("refunds mixed stock to its original planet and retains decimal shared stock exactly", () => {
    const { state, registry } = fixture();
    const entity = state.entities.find(candidate => candidate.buildingId === "crystal_furnace" as BuildingId)!;
    entity.planetId = "ashen";
    entity.outputs = { iron_ingot: 11, [ore]: 2 };
    state.quantumLogisticsNetwork.inventory.iron_ingot = "900719925474099312345";
    state.quantumLogisticsNetwork.inventory[ore] = "900719925474099399999";
    const before = state.planetTrays.ashen?.iron_ingot ?? 0;
    const plan = prepareVanillaSaveConversion(state, registry);
    expect(plan.issues).toEqual([]);
    expect(plan.state.tray.iron_ingot).toBe(17);
    expect(plan.state.planetTrays.ashen.iron_ingot).toBe(before + 11);
    expect(plan.state.quantumLogisticsNetwork.inventory).toEqual({ iron_ingot: "900719925474099312345" });
  });

  it("removes bridge mirrors without duplicating their station's reserved core cargo", () => {
    const fixtureState = fixture();
    let state = fixtureState.state;
    state.construction.crystal_station = 1;
    state = placeBuilding(state, "crystal_station" as BuildingId, { x: 500, y: 200 });
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 700, y: 200 });
    const supply = state.entities.find(entity => entity.buildingId === "crystal_station" as BuildingId)!;
    const demand = state.entities.find(entity => entity.buildingId === "interstellar_logistics_station")!;
    supply.outputs = { iron_ingot: 100 };
    demand.stationRoutes = [{ id: "bridged", peerId: supply.id, itemId: "iron_ingot", scope: "remote", slotIndex: 0, cargo: 20, vehicleCount: 1, progress: 0.2, duration: 10, requiresWarp: false }];
    demand.quantumTransition = { targetMode: "quantum", startedAtSecond: 0, boundarySecond: 5, bridges: [{ id: "bridge", itemId: "iron_ingot", sourceStationId: supply.id, targetStationId: demand.id, cargo: "20", remainingCargo: "20", arriveAtSecond: 10 }] };
    state.quantumLogisticsNetwork.inventory.iron_ingot = "11";
    const plan = prepareVanillaSaveConversion(state, fixtureState.registry);
    expect(plan.issues).toEqual([]);
    expect(plan.state.tray.iron_ingot).toBe(117);
    expect(plan.state.quantumLogisticsNetwork.inventory.iron_ingot).toBe("11");
    expect(plan.state.entities.find(entity => entity.id === demand.id)?.stationRoutes).toEqual([]);
    expect(plan.state.entities.find(entity => entity.id === demand.id)?.quantumTransition?.bridges).toEqual([]);
  });

  it("keeps the entire source when a core refund cannot be represented safely", () => {
    const { state, registry } = fixture();
    state.tray.iron_ingot = Number.MAX_SAFE_INTEGER;
    state.entities.find(entity => entity.buildingId === "crystal_furnace" as BuildingId)!.inputs = { iron_ingot: 1 };
    const before = JSON.stringify(state);
    const plan = prepareVanillaSaveConversion(state, registry);
    expect(plan.issues.join(" ")).toContain("安全库存上限");
    expect(plan.state).toBe(state);
    expect(plan.registry).toBe(registry);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("respects separate ID namespaces and keeps entity IDs and labels that match pack IDs", () => {
    const manifest = { formatVersion: 5, id: "namespaces", name: "同名测试", version: "1.0.0", items: [{ id: "wind_turbine", name: "自定义同名物品" }], recipes: [{ id: "iron_ore", name: "自定义同名配方", buildingId: "arc_smelter", duration: 1, inputs: [{ itemId: "iron_ingot", amount: 1 }], outputs: [{ itemId: "copper_ingot", amount: 1 }] }] };
    const checked = validateContentPack(manifest);
    expect(checked.valid).toBe(true);
    const registry = registerContentPack(createContentPackRegistry(), checked).registry;
    applyContentPackRegistry(registry);
    let state = createInitialState();
    state.tray.iron_ore = 8;
    state.tray["wind_turbine" as ItemId] = 6;
    state.construction.wind_turbine = 10;
    state = placeBuilding(state, "wind_turbine", { x: 300, y: 300 });
    const wind = state.entities.find(entity => entity.buildingId === "wind_turbine")!;
    expect(wind).toBeDefined();
    wind.id = "wind_turbine";
    const plan = prepareVanillaSaveConversion(state, registry);
    expect(plan.issues).toEqual([]);
    expect(plan.state.tray.iron_ore).toBe(8);
    expect(plan.state.tray["wind_turbine" as ItemId]).toBeUndefined();
    expect(plan.state.construction.wind_turbine).toBe(9);
    expect(plan.state.entities.some(entity => entity.id === wind.id)).toBe(true);
  });

  it("provides an immutable preview and remains stable on a second conversion", () => {
    const { state, registry } = fixture();
    const before = JSON.stringify(state);
    const preview = getVanillaSaveConversionPreview(state, registry);
    expect(preview.packs).toBe(1);
    expect(JSON.stringify(state)).toBe(before);
    const first = prepareVanillaSaveConversion(state, registry);
    const second = prepareVanillaSaveConversion(first.state, first.registry);
    expect(first.issues).toEqual([]);
    expect(second.issues).toEqual([]);
    expect(second.state).toEqual(first.state);
  });
});
