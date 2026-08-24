/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import documentedExample from "../../docs/examples/example-dense-materials.content-pack.json";
import { CONSTRUCTION, ITEMS, getBeltConstructionId, getBeltSpeed, getBuilding, getConstructionCatalogIds, getRecipe, getRecipesForBuilding, isConstructionDeployable, isConstructionInCategory } from "./content";
import {
  applyContentPackRegistry,
  applyContentPackRuntimeSnapshot,
  createContentPackRuntimeSnapshot,
  createContentPackRegistry,
  getContentPackValidationContext,
  getActiveContentPackReferences,
  registerContentPack,
  saveContentPackRegistry,
  setContentPackEnabled,
  validateContentPackRuntimeSnapshot,
} from "./contentPacks";
import { satisfiesContentPackVersion, validateContentPack } from "./mods";
import { advancePersistentSimulationRuntime, advanceSimulation, advanceSimulationSession, canSelectTechnology, completeSimulationAdvanceSession, createInitialState, createPersistentSimulationRuntime, createSimulationAdvanceSession, placeBuilding, selectTechnology, setEntityRecipe } from "./engine";
import { exportGame, inspectSave } from "./storage";

afterEach(() => {
  applyContentPackRegistry(createContentPackRegistry());
  window.localStorage.clear();
});

describe("content pack runtime registry", () => {
  it("normalizes, fingerprints, validates, and applies a serializable Worker registry snapshot", () => {
    const validation = validateContentPack({
      formatVersion: 2,
      id: "worker_registry_regression",
      name: "Worker Registry Regression",
      version: "1.0.0",
      recipes: [{
        id: "worker_gravity_matrix_to_warpers",
        name: "Worker 引力矩阵制空间翘曲器",
        buildingId: "assembling_machine_mk1",
        duration: 10,
        inputs: [{ itemId: "gravity_matrix", amount: 1 }],
        outputs: [{ itemId: "space_warper", amount: 8 }],
      }],
    });
    const registry = registerContentPack(createContentPackRegistry(), validation).registry;
    const snapshot = createContentPackRuntimeSnapshot(registry);
    expect(validateContentPackRuntimeSnapshot(structuredClone(snapshot))).toBe(true);
    expect(createContentPackRuntimeSnapshot(structuredClone(registry)).fingerprint).toBe(snapshot.fingerprint);
    expect(() => applyContentPackRuntimeSnapshot({ ...snapshot, fingerprint: "stale" })).toThrow(/指纹/);
    expect(applyContentPackRuntimeSnapshot(structuredClone(snapshot)).catalogValid).toBe(true);
    expect(getRecipe("worker_gravity_matrix_to_warpers" as never)?.outputs).toEqual([{ itemId: "space_warper", amount: 8 }]);
  });

  it("keeps custom recipe results deterministic across main, persistent, and offline-style sessions", () => {
    const validation = validateContentPack({
      formatVersion: 2,
      id: "worker_registry_regression",
      name: "Worker Registry Regression",
      version: "1.0.0",
      recipes: [{
        id: "worker_gravity_matrix_to_warpers",
        name: "Worker 引力矩阵制空间翘曲器",
        buildingId: "assembling_machine_mk1",
        duration: 10,
        inputs: [{ itemId: "gravity_matrix", amount: 1 }],
        outputs: [{ itemId: "space_warper", amount: 8 }],
      }],
    });
    const snapshot = createContentPackRuntimeSnapshot(registerContentPack(createContentPackRegistry(), validation).registry);
    applyContentPackRuntimeSnapshot(snapshot);
    let initial = createInitialState();
    initial.construction.assembling_machine_mk1 = 1;
    initial.construction.wind_turbine = 100;
    initial = placeBuilding(initial, "wind_turbine", { x: -200, y: 0 }, 100);
    initial = placeBuilding(initial, "assembling_machine_mk1", { x: 0, y: 0 });
    const entityId = initial.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;
    initial = setEntityRecipe(initial, entityId, "worker_gravity_matrix_to_warpers" as never);
    initial.entities.find((entity) => entity.id === entityId)!.inputs.gravity_matrix = 1;

    applyContentPackRuntimeSnapshot(snapshot);
    const main = advanceSimulation(structuredClone(initial), 20);
    applyContentPackRuntimeSnapshot(snapshot);
    const persistentRuntime = createPersistentSimulationRuntime(structuredClone(initial));
    const persistent = advancePersistentSimulationRuntime(persistentRuntime, 20, 20).state;
    applyContentPackRuntimeSnapshot(snapshot);
    const offlineSession = createSimulationAdvanceSession(structuredClone(initial), 20);
    advanceSimulationSession(offlineSession, Number.MAX_SAFE_INTEGER);
    const offline = completeSimulationAdvanceSession(offlineSession);

    for (const result of [main, persistent, offline]) {
      const machine = result.entities.find((entity) => entity.id === entityId)!;
      expect(machine.inputs.gravity_matrix ?? 0).toBe(0);
      expect(machine.outputs.space_warper).toBe(8);
    }
    expect(persistent.entities).toEqual(main.entities);
    expect(offline.entities).toEqual(main.entities);
  });
  it("keeps the documented starter pack valid and activatable", () => {
    const validation = validateContentPack(documentedExample);
    expect(validation.valid).toBe(true);

    const registered = registerContentPack(createContentPackRegistry(), validation);
    const report = applyContentPackRegistry(registered.registry);

    expect(registered.enabled).toBe(true);
    expect(report.catalogValid).toBe(true);
    expect(getRecipe("example_dense_plate_recipe" as never)?.requiredTechId).toBe("example_dense_materials");
    expect(getRecipesForBuilding("assembling_machine_mk1").map((recipe) => recipe.id)).toContain("example_dense_plate_recipe");
  });

  it("applies v2 whitelist overrides, researches custom technology, and registers a custom belt tier", () => {
    const validation = validateContentPack({
      formatVersion: 2,
      id: "qa_runtime_v2",
      name: "QA Runtime v2",
      version: "2.0.0",
      items: [{ id: "qa_matrix", name: "QA 矩阵", kind: "matrix" }],
      technologies: [{ id: "qa_research", name: "QA 研究", tier: 0, costs: [{ itemId: "electromagnetic_matrix", amount: 1 }] }],
      buildingOverrides: [{ id: "arc_smelter", speed: 2.5, outputCapacity: 12_345, stackLimit: 99 }],
      belts: [{ id: "qa_belt_mk4", name: "QA 传送带 Mk.4", tier: 4, speed: 60, requiredTechId: "qa_research", costs: [{ itemId: "iron_ingot", amount: 2 }], outputAmount: 5 }],
    });
    expect(validation.valid).toBe(true);
    const registered = registerContentPack(createContentPackRegistry(), validation);
    const report = applyContentPackRegistry(registered.registry);
    expect(report.catalogValid).toBe(true);
    expect(getBuilding("arc_smelter").speed).toBe(2.5);
    expect(getBuilding("arc_smelter").stackLimit).toBe(99);
    expect(getBeltConstructionId(4)).toBe("qa_belt_mk4");
    expect(getBeltSpeed(4)).toBe(60);
    expect(CONSTRUCTION.find((definition) => definition.buildingId === "qa_belt_mk4")?.outputAmount).toBe(5);

    let state = createInitialState();
    expect(state.construction.qa_belt_mk4).toBe(0);
    expect(canSelectTechnology(state, "qa_research" as never)).toBe(true);
    state = selectTechnology(state, "qa_research" as never);
    state.construction.wind_turbine = 1;
    state.construction.matrix_lab = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = placeBuilding(state, "matrix_lab", { x: 200, y: 0 });
    state.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = 10;
    const lab = state.entities.find((entity) => entity.buildingId === "matrix_lab")!;
    state = setEntityRecipe(state, lab.id, "matrix_research");
    state.entities.find((entity) => entity.id === lab.id)!.inputs.electromagnetic_matrix = 1;
    state = advanceSimulation(state, 10);
    expect(state.research.completedTechIds).toContain("qa_research");

    expect(saveContentPackRegistry(registered.registry)).toBe(true);
    const references = getActiveContentPackReferences(registered.registry);
    expect(references).toEqual([{ id: "qa_runtime_v2", version: "2.0.0" }]);
    const exported = exportGame(state);
    expect(JSON.parse(exported).state.contentPacks).toEqual(references);
    expect(inspectSave(exported).valid).toBe(true);
  });

  it("registers an enabled pack into the live item, recipe, building, and technology catalogs", () => {
    const validation = validateContentPack({
      formatVersion: 1,
      id: "qa_factory_pack",
      name: "QA 工厂扩展",
      version: "1.2.0",
      items: [{ id: "qa_alloy", name: "QA 合金", symbol: "QA", kind: "solid" }],
      buildings: [{ id: "qa_fabricator", name: "QA 制造机", costs: [{ itemId: "iron_ingot", amount: 2 }] }],
      recipes: [{ id: "qa_alloy_recipe", name: "QA 合金制造", buildingId: "qa_fabricator", duration: 2, inputs: [{ itemId: "iron_ingot", amount: 1 }], outputs: [{ itemId: "qa_alloy", amount: 1 }] }],
      technologies: [{ id: "qa_factory_theory", name: "QA 工厂理论", tier: 1, costs: [{ itemId: "electromagnetic_matrix", amount: 1 }] }],
    });
    expect(validation.valid).toBe(true);

    const registered = registerContentPack(createContentPackRegistry(), validation);
    expect(registered.enabled).toBe(true);
    const report = applyContentPackRegistry(registered.registry);

    expect(report.catalogValid).toBe(true);
    expect((ITEMS as Record<string, { name: string }>).qa_alloy?.name).toBe("QA 合金");
    expect(getRecipe("qa_alloy_recipe" as never)?.outputs[0].itemId).toBe("qa_alloy");
    expect(getRecipesForBuilding("qa_fabricator" as never).map((recipe) => recipe.id)).toContain("qa_alloy_recipe");
    expect((CONSTRUCTION as Array<{ buildingId: string }>).some((definition) => definition.buildingId === "qa_fabricator")).toBe(true);
  });

  it("exposes runtime custom buildings in the deployment catalog and generic tray category", () => {
    const validation = validateContentPack({
      formatVersion: 1,
      id: "qa_deployable_pack",
      name: "QA 可部署建筑",
      version: "1.0.0",
      buildings: [{
        id: "qa_deployable_splitter",
        name: "QA 可部署分流器",
        kind: "splitter",
        costs: [{ itemId: "iron_ingot", amount: 2 }],
      }],
    });
    expect(validation.valid).toBe(true);
    const registered = registerContentPack(createContentPackRegistry(), validation);
    expect(applyContentPackRegistry(registered.registry).catalogValid).toBe(true);
    expect(getConstructionCatalogIds()).toContain("qa_deployable_splitter");
    expect(isConstructionDeployable("qa_deployable_splitter" as never)).toBe(true);
    expect(isConstructionInCategory("qa_deployable_splitter", "logistics")).toBe(true);
    expect(isConstructionInCategory("qa_deployable_splitter", "production")).toBe(false);
  });

  it("keeps declarative miner entries out of free-coordinate deployment", () => {
    const validation = validateContentPack({
      formatVersion: 1,
      id: "qa_miner_pack",
      name: "QA 采矿扩展",
      version: "1.0.0",
      buildings: [{
        id: "qa_miner",
        name: "QA 采矿器",
        kind: "miner",
        costs: [{ itemId: "iron_ingot", amount: 2 }],
      }],
    });
    expect(validation.valid).toBe(true);
    const registered = registerContentPack(createContentPackRegistry(), validation);
    expect(applyContentPackRegistry(registered.registry).catalogValid).toBe(true);
    expect(getConstructionCatalogIds()).toContain("qa_miner");
    expect(isConstructionDeployable("qa_miner" as never)).toBe(false);
  });

  it("requires installed and enabled version-compatible dependencies before activation", () => {
    const base = validateContentPack({ formatVersion: 1, id: "qa_base", name: "QA 基础", version: "1.4.0" });
    let registry = registerContentPack(createContentPackRegistry(), base).registry;
    const consumer = validateContentPack({
      formatVersion: 1,
      id: "qa_consumer",
      name: "QA 消费端",
      version: "1.0.0",
      dependencies: ["qa_base@^1.2.0"],
    }, getContentPackValidationContext(registry));
    const registered = registerContentPack(registry, consumer);
    expect(registered.enabled).toBe(true);
    registry = registered.registry;

    const disabled = setContentPackEnabled(registry, "qa_base", false);
    expect(disabled.changed).toBe(false);
    expect(disabled.reason).toContain("qa_consumer");
    expect(satisfiesContentPackVersion("1.4.0", "^1.2.0")).toBe(true);
    expect(satisfiesContentPackVersion("2.0.0", "^1.2.0")).toBe(false);
  });
});
