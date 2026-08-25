import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "blueprints");
const STACK_COUNT = 10_000;
const EXPORTED_AT = "2026-08-26T00:00:00.000+08:00";
const CHECK_ONLY = process.argv.includes("--check");

const OUTPUTS = {
  delivery: path.join(OUTPUT_DIR, "全物品-量子下载-配送枢纽-1万堆叠.json"),
  quantum: path.join(OUTPUT_DIR, "全物品-量子下载-量子上传-1万堆叠.json"),
};

const PREFERRED_RECIPES = {
  graphene: "graphene_from_fire_ice",
  carbon_nanotube: "carbon_nanotube_from_spiniform",
  crystal_silicon: "crystal_silicon_from_fractal",
  particle_container: "particle_container_from_unipolar",
  casimir_crystal: "casimir_crystal_advanced",
  photon_combiner: "photon_combiner_from_grating",
  diamond: "diamond_from_kimberlite",
  space_warper: "space_warper",
};

const ENDGAME_BUILDING = {
  arc_smelter: "plane_smelter",
  assembling_machine_mk1: "assembling_machine_mk3",
  chemical_plant: "quantum_chemical_plant",
};

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function centeredY(index, count, spacing) {
  return Math.round((index - (count - 1) / 2) * spacing);
}

function stableUnique(values) {
  return [...new Set(values)];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createStationSlot(itemId, remoteMode, priority) {
  return {
    itemId,
    localMode: "storage",
    remoteMode,
    minimumLoad: 1,
    minStock: 0,
    maxStock: 100_000_000,
    priority,
    routePolicy: "relay-preferred",
    warperBudget: 2,
  };
}

function createQuantumTower(key, offset, itemIds, remoteMode) {
  return {
    key,
    buildingId: "interstellar_logistics_station",
    offset,
    machineCount: STACK_COUNT,
    stationTier: 2,
    stationOperationMode: "legacy",
    quantumTarget: true,
    stationMinimumLoad: 1,
    stationWarpEnabled: false,
    stationWarperAutoRefill: false,
    stationDroneTarget: 0,
    stationVesselTarget: 0,
    stationSlots: itemIds.map((itemId) => createStationSlot(itemId, remoteMode, remoteMode === "demand" ? 2 : 1)),
  };
}

function normalizeEntityOffsets(entities) {
  const minX = Math.min(...entities.map((entity) => entity.offset.x));
  const maxX = Math.max(...entities.map((entity) => entity.offset.x));
  const minY = Math.min(...entities.map((entity) => entity.offset.y));
  const maxY = Math.max(...entities.map((entity) => entity.offset.y));
  const centerX = Math.round((minX + maxX) / 2);
  const centerY = Math.round((minY + maxY) / 2);
  return entities.map((entity) => ({
    ...entity,
    offset: { x: entity.offset.x - centerX, y: entity.offset.y - centerY },
  }));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadGameModules() {
  const vite = await createServer({
    root: ROOT,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const [content, recipeGraph, exchange, engine] = await Promise.all([
      vite.ssrLoadModule("/src/game/content.ts"),
      vite.ssrLoadModule("/src/game/recipeGraph.ts"),
      vite.ssrLoadModule("/src/game/blueprintExchange.ts"),
      vite.ssrLoadModule("/src/game/engine.ts"),
    ]);
    return { vite, content, recipeGraph, exchange, engine };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

function createCatalogPlan(content, recipeGraph) {
  const { ITEMS, RECIPES } = content;
  const materialItems = Object.values(ITEMS).filter((item) => item.kind !== "matrix");
  const matrixItemIds = new Set(Object.values(ITEMS).filter((item) => item.kind === "matrix").map((item) => item.id));
  const rawItemIds = materialItems.filter((item) => recipeGraph.RESOURCE_SOURCES[item.id]?.length).map((item) => item.id);
  const rawItems = new Set(rawItemIds);
  const selectedRecipeByItem = new Map();

  for (const item of materialItems) {
    if (rawItems.has(item.id)) continue;
    const candidates = Object.values(RECIPES).filter((recipe) => recipe.outputs.some((output) => output.itemId === item.id));
    const recipeId = PREFERRED_RECIPES[item.id] ?? candidates[0]?.id;
    assert(recipeId && RECIPES[recipeId], `非矩阵物品 ${item.id} 没有可用生产配方`);
    assert(RECIPES[recipeId].outputs.some((output) => output.itemId === item.id), `${recipeId} 不生产 ${item.id}`);
    selectedRecipeByItem.set(item.id, RECIPES[recipeId]);
  }

  const selectedRecipes = stableUnique([...selectedRecipeByItem.values()].map((recipe) => recipe.id)).map((id) => RECIPES[id]);
  const matrixInputs = selectedRecipes.flatMap((recipe) => recipe.inputs
    .filter((input) => matrixItemIds.has(input.itemId))
    .map((input) => `${recipe.id}:${input.itemId}`));
  assert(matrixInputs.length === 0, `流水线仍包含矩阵输入：${matrixInputs.join(", ")}`);

  const selectedOutputIds = new Set(selectedRecipes.flatMap((recipe) => recipe.outputs.map((output) => output.itemId)));
  const uploadItemIds = materialItems.filter((item) => selectedOutputIds.has(item.id)).map((item) => item.id);
  const recipeKeyById = new Map(selectedRecipes.map((recipe) => [recipe.id, `recipe_${recipe.id}`]));

  const depthMemo = new Map();
  const itemDepth = (itemId, visiting = new Set()) => {
    if (rawItems.has(itemId)) return 0;
    if (depthMemo.has(itemId)) return depthMemo.get(itemId);
    assert(!visiting.has(itemId), `配方图存在循环：${[...visiting, itemId].join(" -> ")}`);
    const recipe = selectedRecipeByItem.get(itemId);
    assert(recipe, `配方图缺少 ${itemId} 的生产节点`);
    const nextVisiting = new Set(visiting).add(itemId);
    const depth = 1 + Math.max(0, ...recipe.inputs.map((input) => itemDepth(input.itemId, nextVisiting)));
    depthMemo.set(itemId, depth);
    return depth;
  };
  for (const itemId of selectedRecipeByItem.keys()) itemDepth(itemId);

  const recipeDepth = new Map(selectedRecipes.map((recipe) => {
    const producedTargets = [...selectedRecipeByItem.entries()]
      .filter(([, selected]) => selected.id === recipe.id)
      .map(([itemId]) => itemId);
    return [recipe.id, Math.max(...producedTargets.map((itemId) => depthMemo.get(itemId)))];
  }));

  return {
    materialItems,
    matrixItemIds,
    rawItemIds,
    rawItems,
    selectedRecipeByItem,
    selectedRecipes,
    uploadItemIds,
    recipeKeyById,
    recipeDepth,
    maxDepth: Math.max(...recipeDepth.values()),
  };
}

function buildBlueprint(kind, modules, plan) {
  const { content, engine } = modules;
  const {
    materialItems,
    rawItemIds,
    rawItems,
    selectedRecipeByItem,
    selectedRecipes,
    uploadItemIds,
    recipeKeyById,
    recipeDepth,
    maxDepth,
  } = plan;
  const entities = [];
  const belts = [];
  const rawSourceByItem = new Map();
  let beltSequence = 1;

  const addBelt = (sourceKey, targetKey, itemId, priority, targetPortIndex) => {
    belts.push({
      key: `belt_${String(beltSequence).padStart(4, "0")}`,
      sourceKey,
      targetKey,
      itemId,
      lanes: engine.MAX_BELT_LANES,
      tier: 3,
      stackSize: 4,
      priority,
      monitorEnabled: false,
      routeMode: "auto",
      ...(targetPortIndex === undefined ? {} : { targetPortIndex }),
    });
    beltSequence += 1;
  };

  const rawGroups = chunks(rawItemIds, 5);
  rawGroups.forEach((itemIds, index) => {
    const key = `quantum_download_${String(index + 1).padStart(2, "0")}`;
    entities.push(createQuantumTower(key, { x: 0, y: centeredY(index, rawGroups.length, 520) }, itemIds, "demand"));
    for (const itemId of itemIds) rawSourceByItem.set(itemId, key);
  });

  const recipesByDepth = new Map();
  for (const recipe of selectedRecipes) {
    const depth = recipeDepth.get(recipe.id);
    const group = recipesByDepth.get(depth) ?? [];
    group.push(recipe);
    recipesByDepth.set(depth, group);
  }
  for (const [depth, recipes] of [...recipesByDepth.entries()].sort((left, right) => left[0] - right[0])) {
    recipes.forEach((recipe, index) => {
      entities.push({
        key: recipeKeyById.get(recipe.id),
        buildingId: ENDGAME_BUILDING[recipe.buildingId] ?? recipe.buildingId,
        offset: { x: 900 + (depth - 1) * 720, y: centeredY(index, recipes.length, 300) },
        machineCount: STACK_COUNT,
        recipeId: recipe.id,
      });
    });
  }

  const canonicalSource = (itemId) => {
    if (rawItems.has(itemId)) return rawSourceByItem.get(itemId);
    const recipe = selectedRecipeByItem.get(itemId);
    return recipe ? recipeKeyById.get(recipe.id) : undefined;
  };
  for (const recipe of selectedRecipes) {
    const targetKey = recipeKeyById.get(recipe.id);
    for (const input of recipe.inputs) {
      const sourceKey = canonicalSource(input.itemId);
      assert(sourceKey, `${recipe.id} 的输入 ${input.itemId} 没有来源`);
      addBelt(sourceKey, targetKey, input.itemId, 2);
    }
  }

  const selectedProducers = (itemId) => selectedRecipes
    .filter((recipe) => recipe.outputs.some((output) => output.itemId === itemId))
    .map((recipe) => recipeKeyById.get(recipe.id));
  const sinkX = 900 + maxDepth * 720 + 900;

  if (kind === "delivery") {
    const itemGroups = chunks(materialItems.map((item) => item.id), 3);
    itemGroups.forEach((itemIds, index) => {
      const hubKey = `delivery_hub_${String(index + 1).padStart(2, "0")}`;
      entities.push({
        key: hubKey,
        buildingId: "material_delivery_hub",
        offset: { x: sinkX, y: centeredY(index, itemGroups.length, 280) },
        machineCount: STACK_COUNT,
      });
      itemIds.forEach((itemId, portIndex) => {
        const sources = stableUnique([
          ...(rawItems.has(itemId) ? [rawSourceByItem.get(itemId)] : []),
          ...selectedProducers(itemId),
        ].filter(Boolean));
        assert(sources.length > 0, `配送物品 ${itemId} 没有蓝图内来源`);
        for (const sourceKey of sources) addBelt(sourceKey, hubKey, itemId, 0, portIndex);
      });
    });
  } else {
    const uploadGroups = chunks(uploadItemIds, 5);
    uploadGroups.forEach((itemIds, index) => {
      const towerKey = `quantum_upload_${String(index + 1).padStart(2, "0")}`;
      entities.push(createQuantumTower(towerKey, { x: sinkX, y: centeredY(index, uploadGroups.length, 520) }, itemIds, "supply"));
      for (const itemId of itemIds) {
        const sources = stableUnique(selectedProducers(itemId));
        assert(sources.length > 0, `上传物品 ${itemId} 没有生产来源`);
        for (const sourceKey of sources) addBelt(sourceKey, towerKey, itemId, 0);
      }
    });
  }

  const blueprint = {
    id: kind === "delivery" ? "all_materials_delivery_10k" : "all_materials_quantum_upload_10k",
    name: kind === "delivery" ? "全物品·量子下载→配送枢纽·1万堆叠" : "全物品·量子下载→量子上传·1万堆叠",
    revision: 1,
    entities: normalizeEntityOffsets(entities),
    belts,
    rotation: 0,
    mirror: "none",
    recipeOverrides: {},
  };

  return {
    type: "dsp-idle-blueprint",
    formatVersion: 2,
    exportedAt: EXPORTED_AT,
    blueprint,
  };
}

function validateExchange(envelope, exchange) {
  const result = exchange.validateBlueprintExchange(envelope);
  assert(result.valid && result.blueprint, `蓝图 ${envelope.blueprint.name} 交换校验失败：${result.issues.join("；")}`);
  const normalized = { ...envelope, blueprint: result.blueprint };
  const reparsed = exchange.parseBlueprintExchange(JSON.stringify(normalized));
  assert(reparsed.valid && reparsed.blueprint, `蓝图 ${envelope.blueprint.name} JSON 往返失败：${reparsed.issues.join("；")}`);
  return normalized;
}

function verifyPlacement(envelope, modules, plan, kind) {
  const { content, engine } = modules;
  let state = engine.createInitialState(20_260_826);
  state.research.completedTechIds = Object.keys(content.TECHNOLOGIES);
  for (const constructionId of Object.keys(state.construction)) state.construction[constructionId] = 100_000_000;
  state.blueprints = [envelope.blueprint];

  const beforeEntityCount = state.entities.length;
  const beforeBeltCount = state.belts.length;
  const position = { x: 50_000, y: 50_000 };
  const preview = engine.getBlueprintPlacementPreview(state, envelope.blueprint.id, position);
  assert(preview.canPlace, `${envelope.blueprint.name} 无法在匿名全科技存档放置：${preview.blockedReason ?? "施工库存不足"}`);
  const placed = engine.placeBlueprint(state, envelope.blueprint.id, position);
  const newEntities = placed.entities.slice(beforeEntityCount);
  const newBelts = placed.belts.slice(beforeBeltCount);

  assert(newEntities.length === envelope.blueprint.entities.length, `${envelope.blueprint.name} 放置后设备数不一致`);
  assert(newBelts.length === envelope.blueprint.belts.length, `${envelope.blueprint.name} 放置后线路数不一致`);
  assert(newEntities.every((entity) => entity.machineCount === STACK_COUNT), `${envelope.blueprint.name} 存在非 10,000 堆叠设备`);

  const placedRecipeIds = newEntities.flatMap((entity) => entity.recipeId ? [entity.recipeId] : []);
  for (const recipe of plan.selectedRecipes) {
    assert(placedRecipeIds.includes(recipe.id), `${envelope.blueprint.name} 放置时配方 ${recipe.id} 被回退或丢失`);
  }

  const quantumTowers = newEntities.filter((entity) => entity.buildingId === "interstellar_logistics_station");
  assert(quantumTowers.every((tower) => tower.quantumMode === "quantum" || tower.quantumTransition || tower.quantumTarget), `${envelope.blueprint.name} 量子接入意图丢失`);

  if (kind === "delivery") {
    const deliveredItems = new Set(newEntities
      .filter((entity) => entity.buildingId === "material_delivery_hub")
      .flatMap((entity) => engine.getMaterialDeliveryItems(entity)));
    assert(deliveredItems.size === plan.materialItems.length, `${envelope.blueprint.name} 配送枢纽只绑定 ${deliveredItems.size}/${plan.materialItems.length} 种物品`);
  } else {
    const uploadedItems = new Set(quantumTowers.flatMap((tower) => (tower.stationSlots ?? [])
      .filter((slot) => slot.remoteMode === "supply" && slot.itemId)
      .map((slot) => slot.itemId)));
    assert(uploadedItems.size === plan.uploadItemIds.length, `${envelope.blueprint.name} 量子供应槽只绑定 ${uploadedItems.size}/${plan.uploadItemIds.length} 种物品`);
  }
}

async function persistOrCheck(filePath, contents) {
  if (CHECK_ONLY) {
    const existing = await readFile(filePath, "utf8");
    assert(existing === contents, `${path.relative(ROOT, filePath)} 与生成器输出不一致`);
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function main() {
  const modules = await loadGameModules();
  try {
    const plan = createCatalogPlan(modules.content, modules.recipeGraph);
    assert(plan.materialItems.length === 72, `当前非矩阵物品数量变为 ${plan.materialItems.length}，请审查蓝图范围`);
    assert(plan.rawItemIds.length === 18, `当前原料来源数量变为 ${plan.rawItemIds.length}，请审查量子下载槽`);
    assert(plan.selectedRecipes.length === 54, `当前生产节点数量变为 ${plan.selectedRecipes.length}，请审查配方选择`);
    assert(plan.uploadItemIds.length === 55, `当前量子上传物品数量变为 ${plan.uploadItemIds.length}，请审查副产物`);

    const delivery = validateExchange(buildBlueprint("delivery", modules, plan), modules.exchange);
    const quantum = validateExchange(buildBlueprint("quantum", modules, plan), modules.exchange);
    verifyPlacement(delivery, modules, plan, "delivery");
    verifyPlacement(quantum, modules, plan, "quantum");

    const deliveryJson = `${JSON.stringify(delivery, null, 2)}\n`;
    const quantumJson = `${JSON.stringify(quantum, null, 2)}\n`;
    await persistOrCheck(OUTPUTS.delivery, deliveryJson);
    await persistOrCheck(OUTPUTS.quantum, quantumJson);

    const summary = {
      mode: CHECK_ONLY ? "check" : "write",
      stackCount: STACK_COUNT,
      nonMatrixItems: plan.materialItems.length,
      rawDownloadItems: plan.rawItemIds.length,
      productionRecipes: plan.selectedRecipes.length,
      delivery: {
        file: path.relative(ROOT, OUTPUTS.delivery),
        entities: delivery.blueprint.entities.length,
        belts: delivery.blueprint.belts.length,
        deliveryHubs: delivery.blueprint.entities.filter((entity) => entity.buildingId === "material_delivery_hub").length,
        sha256: sha256(deliveryJson),
      },
      quantum: {
        file: path.relative(ROOT, OUTPUTS.quantum),
        entities: quantum.blueprint.entities.length,
        belts: quantum.blueprint.belts.length,
        uploadItems: plan.uploadItemIds.length,
        uploadTowers: quantum.blueprint.entities.filter((entity) => entity.key.startsWith("quantum_upload_")).length,
        sha256: sha256(quantumJson),
      },
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await modules.vite.close();
  }
}

await main();
