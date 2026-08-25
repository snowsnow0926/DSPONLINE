import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLUEPRINT_DIR = path.join(ROOT, "blueprints");
const DELIVERY_TEMPLATE = path.join(BLUEPRINT_DIR, "全物品-量子下载-配送枢纽-1万堆叠.json");
const QUANTUM_TEMPLATE = path.join(BLUEPRINT_DIR, "全物品-量子下载-量子上传-1万堆叠.json");
const OUTPUTS = {
  delivery: path.join(BLUEPRINT_DIR, "射线接收站四材料-量子下载-配送枢纽-极限产能.json"),
  quantum: path.join(BLUEPRINT_DIR, "射线接收站四材料-量子下载-量子上传-极限产能.json"),
};

const CHECK_ONLY = process.argv.includes("--check");
const EXPORTED_AT = "2026-08-26T12:00:00.000+08:00";
const RECEIVER_KITS_PER_SECOND = 24_990_000;
const THEORETICAL_RECEIVER_KITS_PER_SECOND = 25_000_000;
const QUANTUM_ITEM_CAPACITY = 10_000_000_000;
const QUANTUM_BOUNDARY_SECONDS = 5;
const QUANTUM_SLOT_STEADY_RATE = QUANTUM_ITEM_CAPACITY / QUANTUM_BOUNDARY_SECONDS;
const QUANTUM_SLOT_MAX_STOCK = 100_000_000;
const QUANTUM_SLOT_RATE = QUANTUM_SLOT_MAX_STOCK / QUANTUM_BOUNDARY_SECONDS;
const QUANTUM_TOWER_STACK = 1_000_000;
const DELIVERY_HUB_STACK = 100_000_000;
const EPSILON = 1e-6;

const TARGET_OUTPUTS = {
  steel: 20 * RECEIVER_KITS_PER_SECOND,
  high_purity_silicon: 20 * RECEIVER_KITS_PER_SECOND,
  photon_combiner: 10 * RECEIVER_KITS_PER_SECOND,
  processor: 5 * RECEIVER_KITS_PER_SECOND,
};

const PRIMARY_RECIPE_BY_ITEM = new Map([
  ["iron_ingot", "iron_ingot"],
  ["copper_ingot", "copper_ingot"],
  ["steel", "steel"],
  ["high_purity_silicon", "high_purity_silicon"],
  ["circuit_board", "circuit_board"],
  ["microcrystalline_component", "microcrystalline_component"],
  ["processor", "processor"],
  ["photon_combiner", "photon_combiner_from_grating"],
]);

const CAPACITY_ORDER = [
  "processor",
  "photon_combiner",
  "microcrystalline_component",
  "circuit_board",
  "steel",
  "high_purity_silicon",
  "copper_ingot",
  "iron_ingot",
];

const RAW_INPUT_ITEMS = ["iron_ore", "silicon_ore", "copper_ore", "optical_grating_crystal"];
const TARGET_ITEM_ORDER = ["steel", "high_purity_silicon", "photon_combiner", "processor"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ceilWithTolerance(value) {
  return Math.ceil(value - 1e-9);
}

function recipeGroupKey(recipeId, groupId) {
  return `${recipeId}:${groupId}`;
}

function createRecipeGroupPlans(recipePlans) {
  const requiredGroups = new Map([
    ["iron_ingot", [
      { groupId: "steel", requiredOutputRate: TARGET_OUTPUTS.steel * 3 },
      { groupId: "processor", requiredOutputRate: TARGET_OUTPUTS.processor * 2 },
      { groupId: "photon", requiredOutputRate: TARGET_OUTPUTS.photon_combiner },
    ]],
    ["copper_ingot", [
      { groupId: "processor", requiredOutputRate: TARGET_OUTPUTS.processor },
      { groupId: "photon", requiredOutputRate: TARGET_OUTPUTS.photon_combiner / 2 },
      { groupId: "micro", requiredOutputRate: TARGET_OUTPUTS.processor * 2 },
    ]],
    ["high_purity_silicon", [
      { groupId: "micro", requiredOutputRate: TARGET_OUTPUTS.processor * 4 },
      { groupId: "target", requiredOutputRate: TARGET_OUTPUTS.high_purity_silicon },
    ]],
    ["circuit_board", [
      { groupId: "processor", requiredOutputRate: TARGET_OUTPUTS.processor * 2 },
      { groupId: "photon", requiredOutputRate: TARGET_OUTPUTS.photon_combiner },
    ]],
    ["microcrystalline_component", [
      { groupId: "processor", requiredOutputRate: TARGET_OUTPUTS.processor * 2 },
    ]],
    ["steel", [{ groupId: "target", requiredOutputRate: TARGET_OUTPUTS.steel }]],
    ["processor", [{ groupId: "target", requiredOutputRate: TARGET_OUTPUTS.processor }]],
    ["photon_combiner_from_grating", [{ groupId: "target", requiredOutputRate: TARGET_OUTPUTS.photon_combiner }]],
  ]);
  const result = new Map();
  for (const [recipeId, groups] of requiredGroups) {
    const recipePlan = recipePlans.get(recipeId);
    assert(recipePlan, `缺少 ${recipeId} 的容量规划`);
    for (const group of groups) {
      const totalMachineCount = ceilWithTolerance(group.requiredOutputRate / recipePlan.outputPerSecondPerMachine);
      const actualOutputRate = totalMachineCount * recipePlan.outputPerSecondPerMachine;
      const key = recipeGroupKey(recipeId, group.groupId);
      result.set(key, {
        ...group,
        key,
        recipeId,
        recipePlan,
        totalMachineCount,
        actualOutputRate,
      });
    }
  }
  return result;
}

function createRawFlowPlans(recipeGroupPlans) {
  const result = [];
  for (const group of recipeGroupPlans.values()) {
    const cyclesPerSecond = group.totalMachineCount * group.recipePlan.cyclesPerSecondPerMachine;
    for (const input of group.recipePlan.recipe.inputs) {
      if (!RAW_INPUT_ITEMS.includes(input.itemId)) continue;
      result.push({
        key: `${input.itemId}->${group.key}`,
        itemId: input.itemId,
        targetGroupKey: group.key,
        rate: cyclesPerSecond * input.amount,
      });
    }
  }
  return result;
}

async function loadModules() {
  const vite = await createServer({
    root: ROOT,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const [content, exchange, engine] = await Promise.all([
      vite.ssrLoadModule("/src/game/content.ts"),
      vite.ssrLoadModule("/src/game/blueprintExchange.ts"),
      vite.ssrLoadModule("/src/game/engine.ts"),
    ]);
    return { vite, content, exchange, engine };
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

function createCapacityPlan(modules, template) {
  const { content, engine } = modules;
  const fullTechState = engine.createInitialState(20_260_826);
  fullTechState.research.completedTechIds = Object.keys(content.TECHNOLOGIES);
  const recipeTemplateById = new Map(template.entities
    .filter((entity) => entity.recipeId)
    .map((entity) => [entity.recipeId, entity]));
  const requiredOutputByItem = new Map(Object.entries(TARGET_OUTPUTS));
  const recipePlans = new Map();
  const inputRateByRecipeItem = new Map();

  for (const primaryItemId of CAPACITY_ORDER) {
    const recipeId = PRIMARY_RECIPE_BY_ITEM.get(primaryItemId);
    const recipe = content.RECIPES[recipeId];
    const templateEntity = recipeTemplateById.get(recipeId);
    assert(recipe && templateEntity, `模板缺少配方 ${recipeId}`);
    const building = content.BUILDINGS[templateEntity.buildingId];
    const primaryOutput = recipe.outputs.find((output) => output.itemId === primaryItemId);
    assert(building && primaryOutput, `${recipeId} 缺少建筑或主产物定义`);
    const cyclesPerSecondPerMachine = building.speed * engine.getRecipeSpeedMultiplier(fullTechState, recipeId) / recipe.duration;
    const outputPerSecondPerMachine = cyclesPerSecondPerMachine * primaryOutput.amount;
    const requiredOutputRate = requiredOutputByItem.get(primaryItemId) ?? 0;
    const totalMachineCount = ceilWithTolerance(requiredOutputRate / outputPerSecondPerMachine);
    const actualCyclesPerSecond = totalMachineCount * cyclesPerSecondPerMachine;
    const actualOutputRate = actualCyclesPerSecond * primaryOutput.amount;
    assert(totalMachineCount > 0 && totalMachineCount <= Number.MAX_SAFE_INTEGER, `${recipeId} 的总堆叠无效`);

    recipePlans.set(recipeId, {
      recipe,
      primaryItemId,
      templateEntity,
      cyclesPerSecondPerMachine,
      outputPerSecondPerMachine,
      requiredOutputRate,
      actualOutputRate,
      totalMachineCount,
    });

    for (const input of recipe.inputs) {
      const inputRate = actualCyclesPerSecond * input.amount;
      inputRateByRecipeItem.set(`${recipeId}:${input.itemId}`, inputRate);
      requiredOutputByItem.set(input.itemId, (requiredOutputByItem.get(input.itemId) ?? 0) + inputRate);
    }
  }

  const recipeGroupPlans = createRecipeGroupPlans(recipePlans);
  const rawFlowPlans = createRawFlowPlans(recipeGroupPlans);
  const rawDemandRates = Object.fromEntries(RAW_INPUT_ITEMS.map((itemId) => [
    itemId,
    rawFlowPlans.filter((flow) => flow.itemId === itemId).reduce((sum, flow) => sum + flow.rate, 0),
  ]));
  const rawSlotCounts = Object.fromEntries(RAW_INPUT_ITEMS.map((itemId) => [
    itemId,
    rawFlowPlans.filter((flow) => flow.itemId === itemId)
      .reduce((sum, flow) => sum + Math.ceil((flow.rate - EPSILON) / QUANTUM_SLOT_RATE), 0),
  ]));
  const quantumTowerCount = Math.max(...Object.values(rawSlotCounts));
  const rawDemandTotal = Object.values(rawDemandRates).reduce((sum, rate) => sum + rate, 0);
  const quantumBandwidthPerSecond = quantumTowerCount * QUANTUM_TOWER_STACK * 5_000 / 60;

  assert(TARGET_OUTPUTS.steel / 20 === RECEIVER_KITS_PER_SECOND, "钢材目标配比无效");
  assert(TARGET_OUTPUTS.high_purity_silicon / 20 === RECEIVER_KITS_PER_SECOND, "高纯硅块目标配比无效");
  assert(TARGET_OUTPUTS.photon_combiner / 10 === RECEIVER_KITS_PER_SECOND, "光子合并器目标配比无效");
  assert(TARGET_OUTPUTS.processor / 5 === RECEIVER_KITS_PER_SECOND, "处理器目标配比无效");
  assert(rawDemandRates.iron_ore <= QUANTUM_SLOT_STEADY_RATE, "铁矿需求超过单物品量子仓库五秒结算上限");
  assert(rawDemandRates.silicon_ore <= QUANTUM_SLOT_STEADY_RATE, "硅矿需求超过单物品量子仓库五秒结算上限");
  assert(THEORETICAL_RECEIVER_KITS_PER_SECOND === QUANTUM_SLOT_STEADY_RATE / 80,
    "射线接收站材料链的理论量子上限推导失效");
  assert(quantumBandwidthPerSecond > rawDemandTotal, "量子塔总下载带宽缺少余量");

  return {
    recipePlans,
    recipeGroupPlans,
    rawFlowPlans,
    inputRateByRecipeItem,
    rawDemandRates,
    rawSlotCounts,
    rawDemandTotal,
    quantumTowerCount,
    quantumBandwidthPerSecond,
  };
}

function splitMachineCount(totalMachineCount, maximumStack) {
  const result = [];
  let remaining = totalMachineCount;
  while (remaining > 0) {
    const count = Math.min(maximumStack, remaining);
    result.push(count);
    remaining -= count;
  }
  return result;
}

function stationSlot(itemId, remoteMode, priority) {
  return {
    itemId,
    localMode: "storage",
    remoteMode,
    minimumLoad: 1,
    minStock: 0,
    maxStock: QUANTUM_SLOT_MAX_STOCK,
    priority,
    routePolicy: "relay-preferred",
    warperBudget: 2,
  };
}

function createStationRecords(count) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    slots: [],
    itemIds: new Set(),
  }));
}

function assignStationSlots(records, itemId, count, remoteMode, priority) {
  assert(count <= records.length, `${itemId} 需要 ${count} 个量子槽，超过塔数量 ${records.length}`);
  const candidates = [...records]
    .filter((record) => !record.itemIds.has(itemId))
    .sort((left, right) => left.slots.length - right.slots.length || left.index - right.index)
    .slice(0, count);
  assert(candidates.length === count, `${itemId} 无法分配足够的独立量子槽`);
  for (const record of candidates) {
    assert(record.slots.length < 5, `量子塔 ${record.index + 1} 超过五槽上限`);
    record.slots.push(stationSlot(itemId, remoteMode, priority));
    record.itemIds.add(itemId);
  }
  return candidates;
}

function distributeRate(rate, records, maximumRatePerRecord) {
  const result = [];
  let remaining = rate;
  for (const record of records) {
    if (remaining <= EPSILON) break;
    const assignedRate = Math.min(maximumRatePerRecord, remaining);
    result.push({ record, rate: assignedRate });
    remaining -= assignedRate;
  }
  assert(remaining <= EPSILON, `仍有 ${remaining}/s 无法分配到物流槽`);
  return result;
}

function positionForStation(index) {
  return {
    x: -7_200 + (index % 10) * 360,
    y: -2_400 + Math.floor(index / 10) * 300,
  };
}

function positionForRecipe(index) {
  return {
    x: -2_900 + (index % 8) * 360,
    y: -2_300 + Math.floor(index / 8) * 320,
  };
}

function buildEntities(kind, modules, templates, capacityPlan) {
  const { engine } = modules;
  const sourceTemplate = templates.delivery;
  const downloadTemplate = sourceTemplate.entities.find((entity) => entity.key === "quantum_download_01");
  const hubTemplate = sourceTemplate.entities.find((entity) => entity.key === "delivery_hub_01");
  const blackHoleTemplate = sourceTemplate.entities.find((entity) => entity.key === "black_hole_overflow_01");
  assert(downloadTemplate && hubTemplate && blackHoleTemplate, "基础蓝图缺少物流或黑洞模板节点");

  const stationRecords = createStationRecords(capacityPlan.quantumTowerCount);
  const rawSlotRecords = new Map();
  for (const flow of capacityPlan.rawFlowPlans) {
    const slotCount = Math.ceil((flow.rate - EPSILON) / QUANTUM_SLOT_RATE);
    rawSlotRecords.set(flow.key, assignStationSlots(stationRecords, flow.itemId, slotCount, "demand", 2));
  }

  const outputSlotRecords = new Map();
  if (kind === "quantum") {
    for (const itemId of TARGET_ITEM_ORDER) {
      const slotCount = Math.ceil((TARGET_OUTPUTS[itemId] - EPSILON) / QUANTUM_SLOT_RATE);
      outputSlotRecords.set(itemId, assignStationSlots(stationRecords, itemId, slotCount, "supply", 1));
    }
  }

  const stationEntities = stationRecords.map((record) => ({
    ...structuredClone(downloadTemplate),
    key: kind === "delivery"
      ? `quantum_download_${String(record.index + 1).padStart(3, "0")}`
      : `quantum_io_${String(record.index + 1).padStart(3, "0")}`,
    offset: positionForStation(record.index),
    machineCount: QUANTUM_TOWER_STACK,
    stationSlots: record.slots,
  }));
  const stationEntityByRecord = new Map(stationRecords.map((record, index) => [record, stationEntities[index]]));

  const recipeEntities = [];
  const recipeEntityPools = new Map();
  let recipePositionIndex = 0;
  for (const primaryItemId of [...CAPACITY_ORDER].reverse()) {
    const recipeId = PRIMARY_RECIPE_BY_ITEM.get(primaryItemId);
    const groups = [...capacityPlan.recipeGroupPlans.values()].filter((group) => group.recipeId === recipeId);
    for (const group of groups) {
      const stacks = splitMachineCount(group.totalMachineCount, engine.MAX_BUILDING_STACK_COUNT);
      const entities = stacks.map((machineCount, index) => ({
        ...structuredClone(group.recipePlan.templateEntity),
        key: `recipe_${recipeId}_${group.groupId}_${String(index + 1).padStart(2, "0")}`,
        offset: positionForRecipe(recipePositionIndex++),
        machineCount,
      }));
      recipeEntities.push(...entities);
      recipeEntityPools.set(group.key, entities.map((entity) => ({
        entity,
        rate: entity.machineCount * group.recipePlan.outputPerSecondPerMachine,
      })));
    }
  }

  const sinkEntities = [];
  if (kind === "delivery") {
    sinkEntities.push({
      ...structuredClone(hubTemplate),
      key: "delivery_hub_01",
      offset: { x: 900, y: -450 },
      machineCount: DELIVERY_HUB_STACK,
    }, {
      ...structuredClone(hubTemplate),
      key: "delivery_hub_02",
      offset: { x: 900, y: 100 },
      machineCount: DELIVERY_HUB_STACK,
    });
  }
  sinkEntities.push({
    ...structuredClone(blackHoleTemplate),
    key: "black_hole_overflow_01",
    offset: { x: 1_450, y: -450 },
    machineCount: 1,
    operationEnabledOnDeploy: true,
  }, {
    ...structuredClone(blackHoleTemplate),
    key: "black_hole_overflow_02",
    offset: { x: 1_450, y: 100 },
    machineCount: 1,
    operationEnabledOnDeploy: true,
  });

  const rawPools = new Map(capacityPlan.rawFlowPlans.map((flow) => {
    const distributed = distributeRate(flow.rate, rawSlotRecords.get(flow.key), QUANTUM_SLOT_RATE);
    return [flow.key, distributed.map(({ record, rate }) => ({ entity: stationEntityByRecord.get(record), rate }))];
  }));
  const uploadPools = new Map(kind === "quantum" ? TARGET_ITEM_ORDER.map((itemId) => {
    const distributed = distributeRate(TARGET_OUTPUTS[itemId], outputSlotRecords.get(itemId), QUANTUM_SLOT_RATE);
    return [itemId, distributed.map(({ record, rate }) => ({ entity: stationEntityByRecord.get(record), rate }))];
  }) : []);

  return {
    entities: [...stationEntities, ...recipeEntities, ...sinkEntities],
    stationEntities,
    recipeEntities,
    recipeEntityPools,
    rawPools,
    uploadPools,
  };
}

function createBeltBuilder(engine) {
  const belts = [];
  const beltCapacity = engine.getBeltCapacity({ tier: 3, lanes: engine.MAX_BELT_LANES, stackSize: 4 });
  assert(beltCapacity === 491_520, `Mk.III 最大线路吞吐预期为 491520/s，实际为 ${beltCapacity}`);
  const capacityPerLane = beltCapacity / engine.MAX_BELT_LANES;
  assert(capacityPerLane === 120, `Mk.III 四层单并联吞吐预期为 120/s，实际为 ${capacityPerLane}`);

  const addBelts = (sourceKey, targetKey, itemId, rate, priority, targetPortIndex) => {
    assert(rate > EPSILON, `${itemId} 线路速率必须为正数`);
    const count = Math.max(1, Math.ceil((rate - EPSILON) / beltCapacity));
    for (let index = 0; index < count; index += 1) {
      const remainingRate = rate - index * beltCapacity;
      const lanes = index === count - 1
        ? Math.max(1, Math.min(engine.MAX_BELT_LANES, Math.ceil((remainingRate - EPSILON) / capacityPerLane)))
        : engine.MAX_BELT_LANES;
      const belt = {
        key: `belt_${String(belts.length + 1).padStart(6, "0")}`,
        sourceKey,
        targetKey,
        itemId,
        lanes,
        tier: 3,
        sorterTier: 3,
        priority,
        stackSize: 4,
        monitorEnabled: false,
        routeMode: "auto",
      };
      if (targetPortIndex !== undefined) belt.targetPortIndex = targetPortIndex;
      belts.push(belt);
    }
    return count;
  };

  return { belts, beltCapacity, addBelts };
}

function mutablePool(entries) {
  return entries.map((entry) => ({ ...entry, remaining: entry.rate }));
}

function targetInputPool(entities, recipePlan, itemId) {
  const input = recipePlan.recipe.inputs.find((candidate) => candidate.itemId === itemId);
  assert(input, `${recipePlan.recipe.id} 不消耗 ${itemId}`);
  return entities.map((entity) => ({
    entity,
    remaining: entity.machineCount * recipePlan.cyclesPerSecondPerMachine * input.amount,
  }));
}

function connectPools(sourcePool, targetPool, itemId, priority, beltBuilder) {
  let sourceIndex = 0;
  for (const target of targetPool) {
    let targetRemaining = target.remaining;
    while (targetRemaining > EPSILON) {
      while (sourceIndex < sourcePool.length && sourcePool[sourceIndex].remaining <= EPSILON) sourceIndex += 1;
      assert(sourceIndex < sourcePool.length, `${itemId} 的上游产能不足，尚缺 ${targetRemaining}/s`);
      const source = sourcePool[sourceIndex];
      const rate = Math.min(source.remaining, targetRemaining);
      beltBuilder.addBelts(source.entity.key, target.entity.key, itemId, rate, priority);
      source.remaining -= rate;
      targetRemaining -= rate;
    }
  }
}

function buildBelts(kind, modules, capacityPlan, builtEntities) {
  const beltBuilder = createBeltBuilder(modules.engine);
  const recipePools = new Map([...builtEntities.recipeEntityPools].map(([groupKey, entries]) => [groupKey, mutablePool(entries)]));
  const rawPools = new Map([...builtEntities.rawPools].map(([flowKey, entries]) => [flowKey, mutablePool(entries)]));

  const groupEntities = (groupKey) => builtEntities.recipeEntityPools.get(groupKey).map((entry) => entry.entity);
  const connectRawFlow = (flow) => {
    const targetGroup = capacityPlan.recipeGroupPlans.get(flow.targetGroupKey);
    connectPools(
      rawPools.get(flow.key),
      targetInputPool(groupEntities(flow.targetGroupKey), targetGroup.recipePlan, flow.itemId),
      flow.itemId,
      2,
      beltBuilder,
    );
  };
  const connectRecipeGroups = (sourceGroupKey, targetGroupKey, itemId) => {
    const targetGroup = capacityPlan.recipeGroupPlans.get(targetGroupKey);
    connectPools(
      recipePools.get(sourceGroupKey),
      targetInputPool(groupEntities(targetGroupKey), targetGroup.recipePlan, itemId),
      itemId,
      2,
      beltBuilder,
    );
  };

  for (const flow of capacityPlan.rawFlowPlans) connectRawFlow(flow);
  connectRecipeGroups(recipeGroupKey("iron_ingot", "steel"), recipeGroupKey("steel", "target"), "iron_ingot");
  connectRecipeGroups(recipeGroupKey("iron_ingot", "processor"), recipeGroupKey("circuit_board", "processor"), "iron_ingot");
  connectRecipeGroups(recipeGroupKey("iron_ingot", "photon"), recipeGroupKey("circuit_board", "photon"), "iron_ingot");
  connectRecipeGroups(recipeGroupKey("copper_ingot", "processor"), recipeGroupKey("circuit_board", "processor"), "copper_ingot");
  connectRecipeGroups(recipeGroupKey("copper_ingot", "photon"), recipeGroupKey("circuit_board", "photon"), "copper_ingot");
  connectRecipeGroups(recipeGroupKey("high_purity_silicon", "micro"), recipeGroupKey("microcrystalline_component", "processor"), "high_purity_silicon");
  connectRecipeGroups(recipeGroupKey("copper_ingot", "micro"), recipeGroupKey("microcrystalline_component", "processor"), "copper_ingot");
  connectRecipeGroups(recipeGroupKey("circuit_board", "processor"), recipeGroupKey("processor", "target"), "circuit_board");
  connectRecipeGroups(recipeGroupKey("microcrystalline_component", "processor"), recipeGroupKey("processor", "target"), "microcrystalline_component");
  connectRecipeGroups(recipeGroupKey("circuit_board", "photon"), recipeGroupKey("photon_combiner_from_grating", "target"), "circuit_board");

  const targetRecipeGroups = {
    steel: recipeGroupKey("steel", "target"),
    high_purity_silicon: recipeGroupKey("high_purity_silicon", "target"),
    photon_combiner: recipeGroupKey("photon_combiner_from_grating", "target"),
    processor: recipeGroupKey("processor", "target"),
  };
  const deliveryTargets = {
    steel: { key: "delivery_hub_01", port: 0 },
    high_purity_silicon: { key: "delivery_hub_01", port: 1 },
    photon_combiner: { key: "delivery_hub_01", port: 2 },
    processor: { key: "delivery_hub_02", port: 0 },
  };
  const blackHoleTargets = {
    steel: { key: "black_hole_overflow_01", port: 0 },
    high_purity_silicon: { key: "black_hole_overflow_01", port: 1 },
    photon_combiner: { key: "black_hole_overflow_01", port: 2 },
    processor: { key: "black_hole_overflow_02", port: 0 },
  };

  for (const itemId of TARGET_ITEM_ORDER) {
    const sourcePool = recipePools.get(targetRecipeGroups[itemId]);
    const expectedRate = TARGET_OUTPUTS[itemId];
    const actualRate = sourcePool.reduce((sum, entry) => sum + entry.remaining, 0);
    assert(Math.abs(actualRate - expectedRate) <= EPSILON,
      `${itemId} 可供末端的产率 ${actualRate}/s 与目标 ${expectedRate}/s 不一致`);
    const overflowSources = sourcePool
      .filter((entry) => entry.remaining > EPSILON)
      .map((entry) => ({ entity: entry.entity, rate: entry.remaining }));

    if (kind === "delivery") {
      const sink = deliveryTargets[itemId];
      for (const source of overflowSources) {
        beltBuilder.addBelts(source.entity.key, sink.key, itemId, source.rate, 1, sink.port);
      }
      for (const source of sourcePool) source.remaining = 0;
    } else {
      const uploadTargets = builtEntities.uploadPools.get(itemId).map((entry) => ({
        entity: entry.entity,
        remaining: entry.rate,
      }));
      connectPools(sourcePool, uploadTargets, itemId, 1, beltBuilder);
    }

    // A micro black hole has three physical ports and each port accepts one
    // belt. Keep one lowest-priority emergency overflow belt per final item;
    // the extreme rated output still requires the normal destination to be
    // drained by the construction workload.
    const overflow = blackHoleTargets[itemId];
    const overflowSource = overflowSources[0];
    beltBuilder.addBelts(
      overflowSource.entity.key,
      overflow.key,
      itemId,
      Math.min(overflowSource.rate, beltBuilder.beltCapacity),
      0,
      overflow.port,
    );
  }

  for (const [groupKey, pool] of recipePools) {
    const remaining = pool.reduce((sum, entry) => sum + Math.max(0, entry.remaining), 0);
    assert(remaining <= 2 + EPSILON, `${groupKey} 仍有 ${remaining}/s 未接入下游`);
  }
  for (const [flowKey, pool] of rawPools) {
    const remaining = pool.reduce((sum, entry) => sum + Math.max(0, entry.remaining), 0);
    assert(remaining <= EPSILON, `${flowKey} 仍有 ${remaining}/s 量子下载能力未分配`);
  }

  return beltBuilder;
}

function buildBlueprint(kind, modules, templates, capacityPlan) {
  const builtEntities = buildEntities(kind, modules, templates, capacityPlan);
  const beltBuilder = buildBelts(kind, modules, capacityPlan, builtEntities);
  const blueprint = {
    id: kind === "delivery" ? "ray_receiver_materials_delivery_max" : "ray_receiver_materials_quantum_max",
    name: kind === "delivery"
      ? "射线接收站四材料·量子原矿→配送·极限配套"
      : "射线接收站四材料·量子原矿→量子上传·极限配套",
    revision: 1,
    entities: builtEntities.entities,
    belts: beltBuilder.belts,
  };
  return {
    envelope: {
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      exportedAt: EXPORTED_AT,
      blueprint,
    },
    capacity: {
      beltCapacity: beltBuilder.beltCapacity,
      quantumTowerCount: builtEntities.stationEntities.length,
      recipeNodeCount: builtEntities.recipeEntities.length,
    },
  };
}

function validateExchange(built, exchange) {
  const result = exchange.validateBlueprintExchange(built.envelope);
  assert(result.valid && result.blueprint,
    `${built.envelope.blueprint.name} 交换校验失败（设备 ${built.envelope.blueprint.entities.length}，线路 ${built.envelope.blueprint.belts.length}）：${result.issues.join("；")}`);
  const normalized = { ...built.envelope, blueprint: result.blueprint };
  const reparsed = exchange.parseBlueprintExchange(JSON.stringify(normalized));
  assert(reparsed.valid && reparsed.blueprint, `${built.envelope.blueprint.name} JSON 往返失败：${reparsed.issues.join("；")}`);
  return { envelope: normalized, capacity: built.capacity };
}

function verifyPlacement(kind, validated, modules, capacityPlan) {
  const { content, engine } = modules;
  let state = engine.createInitialState(20_260_826);
  state.research.completedTechIds = Object.keys(content.TECHNOLOGIES);
  for (const constructionId of Object.keys(state.construction)) state.construction[constructionId] = 100_000_000_000;
  state.blueprints = [validated.envelope.blueprint];
  const beforeEntityCount = state.entities.length;
  const beforeBeltCount = state.belts.length;
  const preview = engine.getBlueprintPlacementPreview(state, validated.envelope.blueprint.id, { x: 50_000, y: 50_000 });
  assert(preview.canPlace, `${validated.envelope.blueprint.name} 无法真实放置：${preview.blockedReason ?? "施工库存不足"}`);
  state = engine.placeBlueprint(state, validated.envelope.blueprint.id, { x: 50_000, y: 50_000 });
  const entities = state.entities.slice(beforeEntityCount);
  const belts = state.belts.slice(beforeBeltCount);
  assert(entities.length === validated.envelope.blueprint.entities.length,
    `${kind} 放置后设备数不一致：预期 ${validated.envelope.blueprint.entities.length}，实际 ${entities.length}`);
  assert(belts.length === validated.envelope.blueprint.belts.length,
    `${kind} 放置后线路数不一致：预期 ${validated.envelope.blueprint.belts.length}，实际 ${belts.length}`);
  const quantumStations = entities.filter((entity) => entity.buildingId === "interstellar_logistics_station");
  assert(quantumStations.length === capacityPlan.quantumTowerCount, `${kind} 量子塔数量不一致`);
  assert(quantumStations.every((entity) => entity.machineCount === QUANTUM_TOWER_STACK && (entity.stationTier ?? 1) >= 2 &&
    (entity.quantumTarget === true || entity.quantumTransition || entity.quantumMode === "quantum")),
  `${kind} 存在堆叠或量子接入目标不正确的塔`);
  const blackHoles = entities.filter((entity) => entity.buildingId === "micro_black_hole_connector");
  assert(blackHoles.length === 2 && blackHoles.every((entity) => entity.blackHolePaused === false && entity.blackHoleActivationConfirmed === true),
    `${kind} 黑洞溢流没有完整启用`);
  if (kind === "delivery") {
    assert(entities.filter((entity) => entity.buildingId === "material_delivery_hub").length === 2, "配送版应有两个物资配送枢纽");
  } else {
    for (const itemId of TARGET_ITEM_ORDER) {
      assert(quantumStations.some((entity) => entity.stationSlots.some((slot) => slot.itemId === itemId && slot.remoteMode === "supply")),
        `量子版缺少 ${itemId} 上传槽`);
    }
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

function summaryFor(filePath, validated, capacityPlan) {
  const json = `${JSON.stringify(validated.envelope, null, 2)}\n`;
  const stackPlan = [...capacityPlan.recipePlans.values()].map((plan) => ({
    groups: [...capacityPlan.recipeGroupPlans.values()].filter((group) => group.recipeId === plan.recipe.id),
    recipeId: plan.recipe.id,
    itemId: plan.primaryItemId,
  })).map(({ groups, ...row }) => ({
    ...row,
    totalMachineCount: groups.reduce((sum, group) => sum + group.totalMachineCount, 0),
    nodeCount: groups.reduce((sum, group) => sum + splitMachineCount(group.totalMachineCount, 100_000_000).length, 0),
    actualOutputPerSecond: round(groups.reduce((sum, group) => sum + group.actualOutputRate, 0)),
  }));
  return {
    json,
    summary: {
      file: path.relative(ROOT, filePath),
      entities: validated.envelope.blueprint.entities.length,
      belts: validated.envelope.blueprint.belts.length,
      recipeNodes: validated.capacity.recipeNodeCount,
      quantumTowers: validated.capacity.quantumTowerCount,
      quantumTowerStack: QUANTUM_TOWER_STACK,
      receiverKitsPerSecond: RECEIVER_KITS_PER_SECOND,
      targetOutputsPerSecond: TARGET_OUTPUTS,
      rawDemandPerSecond: Object.fromEntries(Object.entries(capacityPlan.rawDemandRates).map(([itemId, rate]) => [itemId, round(rate)])),
      quantumBandwidthPerSecond: round(capacityPlan.quantumBandwidthPerSecond),
      beltCapacityPerSecond: validated.capacity.beltCapacity,
      stackPlan,
      sha256: sha256(json),
    },
  };
}

async function main() {
  const modules = await loadModules();
  try {
    const templates = {
      delivery: await loadTemplate(DELIVERY_TEMPLATE, modules.exchange),
      quantum: await loadTemplate(QUANTUM_TEMPLATE, modules.exchange),
    };
    const capacityPlan = createCapacityPlan(modules, templates.delivery);
    const delivery = validateExchange(buildBlueprint("delivery", modules, templates, capacityPlan), modules.exchange);
    const quantum = validateExchange(buildBlueprint("quantum", modules, templates, capacityPlan), modules.exchange);
    verifyPlacement("delivery", delivery, modules, capacityPlan);
    verifyPlacement("quantum", quantum, modules, capacityPlan);
    const deliveryOutput = summaryFor(OUTPUTS.delivery, delivery, capacityPlan);
    const quantumOutput = summaryFor(OUTPUTS.quantum, quantum, capacityPlan);
    await persistOrCheck(OUTPUTS.delivery, deliveryOutput.json);
    await persistOrCheck(OUTPUTS.quantum, quantumOutput.json);
    process.stdout.write(`${JSON.stringify({
      mode: CHECK_ONLY ? "check" : "write",
      theoreticalReceiverKitsPerSecond: THEORETICAL_RECEIVER_KITS_PER_SECOND,
      plannedReceiverKitsPerSecond: RECEIVER_KITS_PER_SECOND,
      quantumItemCapacity: QUANTUM_ITEM_CAPACITY,
      quantumBoundarySeconds: QUANTUM_BOUNDARY_SECONDS,
      delivery: deliveryOutput.summary,
      quantum: quantumOutput.summary,
    }, null, 2)}\n`);
  } finally {
    await modules.vite.close();
  }
}

await main();
