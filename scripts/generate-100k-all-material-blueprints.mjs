import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "blueprints");
const BASE_STACK_COUNT = 10_000;
const STACK_GRANULARITY = 1_000;
const TARGET_RATE_PER_SECOND = 100_000;
const QUANTUM_BANDWIDTH_MARGIN = 1.25;
const EXPORTED_AT = "2026-08-26T04:00:00.000+08:00";
const CHECK_ONLY = process.argv.includes("--check");

const TEMPLATE_FILES = {
  delivery: path.join(OUTPUT_DIR, "全物品-量子下载-配送枢纽-1万堆叠.json"),
  quantum: path.join(OUTPUT_DIR, "全物品-量子下载-量子上传-1万堆叠.json"),
};

const OUTPUTS = {
  delivery: path.join(OUTPUT_DIR, "全物品-量子下载-配送枢纽-10万每秒.json"),
  quantum: path.join(OUTPUT_DIR, "全物品-量子下载-量子上传-10万每秒.json"),
};

const EXEMPT_ITEM_IDS = new Set([
  "small_carrier_rocket",
  "annihilation_constraint_sphere",
  "antimatter_fuel_rod",
  "deuteron_fuel_rod",
  "accumulator",
  "charged_accumulator",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function roundUp(value, granularity) {
  return Math.max(granularity, Math.ceil((value - 1e-9) / granularity) * granularity);
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
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

async function loadTemplate(filePath, exchange) {
  const parsed = exchange.parseBlueprintExchange(await readFile(filePath, "utf8"));
  assert(parsed.valid && parsed.blueprint, `${path.relative(ROOT, filePath)} 校验失败：${parsed.issues.join("；")}`);
  return parsed.blueprint;
}

function createCatalogPlan(content, recipeGraph, blueprint) {
  const materialItems = Object.values(content.ITEMS).filter((item) => item.kind !== "matrix");
  const rawItemIds = materialItems
    .filter((item) => recipeGraph.RESOURCE_SOURCES[item.id]?.length)
    .map((item) => item.id);
  const rawItems = new Set(rawItemIds);
  const recipeEntityById = new Map(blueprint.entities
    .filter((entity) => entity.recipeId)
    .map((entity) => [entity.recipeId, entity]));
  const selectedRecipes = [...recipeEntityById.keys()].map((recipeId) => content.RECIPES[recipeId]);
  const selectedRecipeByItem = new Map();

  for (const item of materialItems) {
    if (rawItems.has(item.id)) continue;
    const candidates = selectedRecipes.filter((recipe) => recipe.outputs.some((output) => output.itemId === item.id));
    assert(candidates.length === 1, `${item.id} 在模板中应有且仅有一个生产配方，实际为 ${candidates.map((recipe) => recipe.id).join(", ") || "无"}`);
    selectedRecipeByItem.set(item.id, candidates[0]);
  }

  const primaryItemByRecipe = new Map();
  for (const [itemId, recipe] of selectedRecipeByItem) {
    assert(!primaryItemByRecipe.has(recipe.id), `${recipe.id} 同时被多个主产物复用，容量规划需要人工审查`);
    primaryItemByRecipe.set(recipe.id, itemId);
  }

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
  const recipeDepth = new Map(selectedRecipes.map((recipe) => [recipe.id, depthMemo.get(primaryItemByRecipe.get(recipe.id))]));

  assert(materialItems.length === 72, `非矩阵物品数量应为 72，实际为 ${materialItems.length}`);
  assert(rawItemIds.length === 18, `量子原料数量应为 18，实际为 ${rawItemIds.length}`);
  assert(selectedRecipes.length === 54, `生产配方数量应为 54，实际为 ${selectedRecipes.length}`);
  return {
    materialItems,
    rawItemIds,
    rawItems,
    selectedRecipes,
    selectedRecipeByItem,
    primaryItemByRecipe,
    recipeEntityById,
    recipeDepth,
  };
}

function createCapacityPlan(modules, plan) {
  const { content, engine } = modules;
  const fullTechState = engine.createInitialState(20_260_826);
  fullTechState.research.completedTechIds = Object.keys(content.TECHNOLOGIES);
  const requiredOutputByItem = new Map();
  const machineCountByRecipe = new Map();
  const capacityCyclesByRecipe = new Map();
  const plannedOutputRateByItem = new Map();
  const inputRateByRecipeItem = new Map();
  const rawInputRateByItem = new Map(plan.rawItemIds.map((itemId) => [itemId, 0]));

  const orderedRecipes = [...plan.selectedRecipes]
    .sort((left, right) => plan.recipeDepth.get(right.id) - plan.recipeDepth.get(left.id) || left.id.localeCompare(right.id));
  for (const recipe of orderedRecipes) {
    const primaryItemId = plan.primaryItemByRecipe.get(recipe.id);
    const primaryOutput = recipe.outputs.find((output) => output.itemId === primaryItemId);
    const entity = plan.recipeEntityById.get(recipe.id);
    const building = content.BUILDINGS[entity.buildingId];
    assert(primaryOutput && building, `${recipe.id} 缺少主产物或建筑定义`);
    const cyclesPerSecondPerMachine = building.speed * engine.getRecipeSpeedMultiplier(fullTechState, recipe.id) / recipe.duration;
    assert(cyclesPerSecondPerMachine > 0, `${recipe.id} 的单机周期速率无效`);

    const downstreamDemand = requiredOutputByItem.get(primaryItemId) ?? 0;
    const requiredPrimaryRate = EXEMPT_ITEM_IDS.has(primaryItemId)
      ? downstreamDemand
      : Math.max(TARGET_RATE_PER_SECOND, downstreamDemand);
    const machineCount = EXEMPT_ITEM_IDS.has(primaryItemId)
      ? BASE_STACK_COUNT
      : roundUp(requiredPrimaryRate / primaryOutput.amount / cyclesPerSecondPerMachine, STACK_GRANULARITY);
    assert(machineCount <= engine.MAX_BUILDING_STACK_COUNT, `${primaryItemId} 需要 ${machineCount} 堆叠，超过单节点上限`);
    const capacityCycles = cyclesPerSecondPerMachine * machineCount;
    machineCountByRecipe.set(recipe.id, machineCount);
    capacityCyclesByRecipe.set(recipe.id, capacityCycles);
    plannedOutputRateByItem.set(primaryItemId, capacityCycles * primaryOutput.amount);

    for (const input of recipe.inputs) {
      const inputRate = capacityCycles * input.amount;
      inputRateByRecipeItem.set(`${recipe.id}:${input.itemId}`, inputRate);
      if (plan.rawItems.has(input.itemId)) {
        rawInputRateByItem.set(input.itemId, (rawInputRateByItem.get(input.itemId) ?? 0) + inputRate);
      } else {
        requiredOutputByItem.set(input.itemId, (requiredOutputByItem.get(input.itemId) ?? 0) + inputRate);
      }
    }
  }

  for (const itemId of plan.selectedRecipeByItem.keys()) {
    if (EXEMPT_ITEM_IDS.has(itemId)) continue;
    assert((plannedOutputRateByItem.get(itemId) ?? 0) >= TARGET_RATE_PER_SECOND,
      `${itemId} 的规划产率低于 ${TARGET_RATE_PER_SECOND}/s`);
  }

  const rawManufacturingDemand = [...rawInputRateByItem.values()].reduce((sum, value) => sum + value, 0);
  const rawDeliveryHeadroom = plan.rawItemIds.length * TARGET_RATE_PER_SECOND;
  const requiredQuantumDownloadPerSecond = (rawManufacturingDemand + rawDeliveryHeadroom) * QUANTUM_BANDWIDTH_MARGIN;
  const downloadTowerCount = 4;
  const perTowerStack = roundUp(
    requiredQuantumDownloadPerSecond * 60 / 5_000 / downloadTowerCount,
    STACK_GRANULARITY,
  );
  assert(perTowerStack <= engine.MAX_BUILDING_STACK_COUNT, `量子下载塔需要 ${perTowerStack} 堆叠，超过单节点上限`);

  const guaranteedRates = [...plannedOutputRateByItem.entries()]
    .filter(([itemId]) => !EXEMPT_ITEM_IDS.has(itemId))
    .map(([, rate]) => rate);
  return {
    machineCountByRecipe,
    capacityCyclesByRecipe,
    plannedOutputRateByItem,
    inputRateByRecipeItem,
    rawInputRateByItem,
    rawManufacturingDemand,
    requiredQuantumDownloadPerSecond,
    downloadTowerStackCount: perTowerStack,
    minimumGuaranteedRate: Math.min(...guaranteedRates),
    maximumMachineStack: Math.max(...machineCountByRecipe.values()),
  };
}

function beltTemplate(key, sourceKey, targetKey, itemId, engine) {
  return {
    key,
    sourceKey,
    targetKey,
    itemId,
    lanes: engine.MAX_BELT_LANES,
    tier: 3,
    stackSize: 4,
    priority: 2,
    monitorEnabled: false,
    routeMode: "auto",
  };
}

function buildHighThroughputBlueprint(template, kind, modules, plan, capacityPlan) {
  const { engine } = modules;
  const blueprint = structuredClone(template);
  blueprint.id = kind === "delivery" ? "all_materials_delivery_100k" : "all_materials_quantum_upload_100k";
  blueprint.name = kind === "delivery"
    ? "全物品·量子下载→配送枢纽·黑洞溢流·非豁免10万每秒"
    : "全物品·量子下载→量子上传·黑洞溢流·非豁免10万每秒";
  blueprint.revision = 1;
  blueprint.entities = blueprint.entities.map((entity) => {
    if (entity.recipeId) return { ...entity, machineCount: capacityPlan.machineCountByRecipe.get(entity.recipeId) };
    if (entity.key.startsWith("quantum_download_")) return { ...entity, machineCount: capacityPlan.downloadTowerStackCount };
    return entity;
  });

  const beltCapacity = engine.getBeltCapacity({ tier: 3, lanes: engine.MAX_BELT_LANES, stackSize: 4 });
  assert(beltCapacity > 0, "无法取得传送带 Mk.III 最大吞吐");
  const internalBelts = blueprint.belts.filter((belt) => belt.priority === 2 && belt.targetKey.startsWith("recipe_"));
  const parallelBeltRequests = [];
  for (const belt of internalBelts) {
    const recipeId = belt.targetKey.slice("recipe_".length);
    const requiredRate = capacityPlan.inputRateByRecipeItem.get(`${recipeId}:${belt.itemId}`) ?? 0;
    const channelCount = Math.max(1, Math.ceil((requiredRate - 1e-9) / beltCapacity));
    for (let channel = 1; channel < channelCount; channel += 1) {
      parallelBeltRequests.push({ belt, requiredRate, channel, channelCount });
    }
  }

  for (const [index, request] of parallelBeltRequests.entries()) {
    blueprint.belts.push(beltTemplate(
      `belt_100k_${String(index + 1).padStart(4, "0")}`,
      request.belt.sourceKey,
      request.belt.targetKey,
      request.belt.itemId,
      engine,
    ));
  }

  return {
    type: "dsp-idle-blueprint",
    formatVersion: 2,
    exportedAt: EXPORTED_AT,
    blueprint,
    capacity: {
      beltCapacity,
      parallelBeltCount: parallelBeltRequests.length,
      parallelizedInputs: internalBelts.filter((belt) => {
        const recipeId = belt.targetKey.slice("recipe_".length);
        const requiredRate = capacityPlan.inputRateByRecipeItem.get(`${recipeId}:${belt.itemId}`) ?? 0;
        return requiredRate > beltCapacity;
      }).length,
    },
  };
}

function validateExchange(envelope, exchange) {
  const result = exchange.validateBlueprintExchange(envelope);
  assert(result.valid && result.blueprint,
    `蓝图 ${envelope.blueprint.name} 交换校验失败（设备 ${envelope.blueprint.entities.length}，线路 ${envelope.blueprint.belts.length}）：${result.issues.join("；")}`);
  const normalized = { ...envelope, blueprint: result.blueprint };
  delete normalized.capacity;
  const reparsed = exchange.parseBlueprintExchange(JSON.stringify(normalized));
  assert(reparsed.valid && reparsed.blueprint, `蓝图 ${envelope.blueprint.name} JSON 往返失败：${reparsed.issues.join("；")}`);
  return { envelope: normalized, capacity: envelope.capacity };
}

function verifyPlacement(envelope, modules, plan, capacityPlan) {
  const { content, engine } = modules;
  let state = engine.createInitialState(20_260_826);
  state.research.completedTechIds = Object.keys(content.TECHNOLOGIES);
  for (const constructionId of Object.keys(state.construction)) state.construction[constructionId] = 2_000_000_000;
  state.blueprints = [envelope.blueprint];
  const beforeEntityCount = state.entities.length;
  const beforeBeltCount = state.belts.length;
  const preview = engine.getBlueprintPlacementPreview(state, envelope.blueprint.id, { x: 80_000, y: 80_000 });
  assert(preview.canPlace, `${envelope.blueprint.name} 无法真实放置：${preview.blockedReason ?? "施工库存不足"}`);
  const placed = engine.placeBlueprint(state, envelope.blueprint.id, { x: 80_000, y: 80_000 });
  const newEntities = placed.entities.slice(beforeEntityCount);
  const newBelts = placed.belts.slice(beforeBeltCount);
  assert(newEntities.length === envelope.blueprint.entities.length, `${envelope.blueprint.name} 放置后设备数不一致`);
  assert(newBelts.length === envelope.blueprint.belts.length, `${envelope.blueprint.name} 放置后线路数不一致`);

  for (const recipe of plan.selectedRecipes) {
    const entity = newEntities.find((candidate) => candidate.recipeId === recipe.id);
    assert(entity?.machineCount === capacityPlan.machineCountByRecipe.get(recipe.id), `${recipe.id} 放置后堆叠数量不一致`);
  }
  assert(envelope.blueprint.entities.every((entity) => !entity.key.startsWith("throughput_relay_")),
    `${envelope.blueprint.name} 不应再依赖额外吞吐中继`);
  const blackHoles = newEntities.filter((entity) => entity.buildingId === "micro_black_hole_connector");
  assert(blackHoles.length === 19 && blackHoles.every((entity) => entity.blackHolePaused === false && entity.blackHoleActivationConfirmed === true),
    `${envelope.blueprint.name} 黑洞溢流没有完整启用`);
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

function blueprintSummary(filePath, envelope, extra, capacityPlan) {
  const json = `${JSON.stringify(envelope, null, 2)}\n`;
  return {
    json,
    summary: {
      file: path.relative(ROOT, filePath),
      entities: envelope.blueprint.entities.length,
      belts: envelope.blueprint.belts.length,
      recipeNodes: envelope.blueprint.entities.filter((entity) => entity.recipeId).length,
      additionalParallelBelts: extra.parallelBeltCount,
      parallelizedInputs: extra.parallelizedInputs,
      downloadTowerStackCount: capacityPlan.downloadTowerStackCount,
      minimumPlannedNonExemptRate: round(capacityPlan.minimumGuaranteedRate),
      maximumRecipeStack: capacityPlan.maximumMachineStack,
      sha256: sha256(json),
    },
  };
}

async function main() {
  const modules = await loadGameModules();
  try {
    const deliveryTemplate = await loadTemplate(TEMPLATE_FILES.delivery, modules.exchange);
    const quantumTemplate = await loadTemplate(TEMPLATE_FILES.quantum, modules.exchange);
    const deliveryPlan = createCatalogPlan(modules.content, modules.recipeGraph, deliveryTemplate);
    const quantumPlan = createCatalogPlan(modules.content, modules.recipeGraph, quantumTemplate);
    assert(JSON.stringify([...deliveryPlan.selectedRecipeByItem].map(([itemId, recipe]) => [itemId, recipe.id])) ===
      JSON.stringify([...quantumPlan.selectedRecipeByItem].map(([itemId, recipe]) => [itemId, recipe.id])),
    "两张模板的生产配方图不一致");
    const capacityPlan = createCapacityPlan(modules, deliveryPlan);

    const deliveryBuilt = buildHighThroughputBlueprint(deliveryTemplate, "delivery", modules, deliveryPlan, capacityPlan);
    const quantumBuilt = buildHighThroughputBlueprint(quantumTemplate, "quantum", modules, quantumPlan, capacityPlan);
    const deliveryValidated = validateExchange(deliveryBuilt, modules.exchange);
    const quantumValidated = validateExchange(quantumBuilt, modules.exchange);
    verifyPlacement(deliveryValidated.envelope, modules, deliveryPlan, capacityPlan);
    verifyPlacement(quantumValidated.envelope, modules, quantumPlan, capacityPlan);

    const delivery = blueprintSummary(OUTPUTS.delivery, deliveryValidated.envelope, deliveryValidated.capacity, capacityPlan);
    const quantum = blueprintSummary(OUTPUTS.quantum, quantumValidated.envelope, quantumValidated.capacity, capacityPlan);
    await persistOrCheck(OUTPUTS.delivery, delivery.json);
    await persistOrCheck(OUTPUTS.quantum, quantum.json);

    const stackPlan = [...deliveryPlan.selectedRecipes].map((recipe) => {
      const itemId = deliveryPlan.primaryItemByRecipe.get(recipe.id);
      return {
        itemId,
        name: modules.content.ITEMS[itemId].name,
        exempt: EXEMPT_ITEM_IDS.has(itemId),
        recipeId: recipe.id,
        machineCount: capacityPlan.machineCountByRecipe.get(recipe.id),
        plannedCapacityPerSecond: round(capacityPlan.plannedOutputRateByItem.get(itemId)),
      };
    }).sort((left, right) => right.machineCount - left.machineCount || left.itemId.localeCompare(right.itemId));
    process.stdout.write(`${JSON.stringify({
      mode: CHECK_ONLY ? "check" : "write",
      targetRatePerSecond: TARGET_RATE_PER_SECOND,
      exemptItemIds: [...EXEMPT_ITEM_IDS],
      rawManufacturingDemandPerSecond: round(capacityPlan.rawManufacturingDemand),
      quantumDownloadCapacityRequiredPerSecond: round(capacityPlan.requiredQuantumDownloadPerSecond),
      delivery: delivery.summary,
      quantum: quantum.summary,
      stackPlan,
    }, null, 2)}\n`);
  } finally {
    await modules.vite.close();
  }
}

await main();
