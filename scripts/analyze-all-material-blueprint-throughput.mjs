import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STACK_COUNT = 10_000;
const CONSTRUCTION_STOCK = 100_000_000;
const QUANTUM_RAW_STOCK = "5000000000";
const DYSON_STRUCTURE_POINTS = 1_000_000;
const WARMUP_SECONDS = 28_800;
const SAMPLE_SECONDS = 7_200;
const SAMPLE_WINDOWS = 4;
const RAW_REFILL_INTERVAL_SECONDS = 60;
const BATCHED_SESSION_SECONDS = 32_400;
const SEED = 20_260_826;

const BLUEPRINTS = {
  delivery: path.join(ROOT, "blueprints", "全物品-量子下载-配送枢纽-1万堆叠.json"),
  quantum: path.join(ROOT, "blueprints", "全物品-量子下载-量子上传-1万堆叠.json"),
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function snapshotProduced(state) {
  return Object.fromEntries(Object.entries(state.totalProduced).map(([itemId, amount]) => [itemId, Math.floor(amount ?? 0)]));
}

function productionRate(before, after, seconds, itemId) {
  return ((after[itemId] ?? 0) - (before[itemId] ?? 0)) / seconds;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function relativeSpread(values) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  return max <= 0 ? 0 : (max - min) / max;
}

function stableStateHash(state) {
  const payload = {
    elapsedSeconds: state.elapsedSeconds,
    totalProduced: state.totalProduced,
    tray: state.tray,
    quantumInventory: state.quantumLogisticsNetwork.inventory,
    entities: state.entities.map((entity) => ({
      id: entity.id,
      buildingId: entity.buildingId,
      recipeId: entity.recipeId,
      inputs: entity.inputs,
      outputs: entity.outputs,
      progress: entity.progress,
      utilization: entity.utilization,
      productionRate: entity.productionRate,
      quantumMode: entity.quantumMode,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function loadModules() {
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

async function loadBlueprint(filePath, exchange) {
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
  const selectedRecipes = blueprint.entities
    .flatMap((entity) => entity.recipeId ? [content.RECIPES[entity.recipeId]] : [])
    .filter(Boolean);
  const recipeById = new Map(selectedRecipes.map((recipe) => [recipe.id, recipe]));
  const selectedRecipeByItem = new Map();

  for (const item of materialItems) {
    if (rawItems.has(item.id)) continue;
    const candidates = selectedRecipes.filter((recipe) => recipe.outputs.some((output) => output.itemId === item.id));
    assert(candidates.length === 1, `${item.id} 在蓝图中应有且仅有一个生产配方，实际为 ${candidates.map((recipe) => recipe.id).join(", ") || "无"}`);
    selectedRecipeByItem.set(item.id, candidates[0]);
  }

  assert(materialItems.length === 72, `非矩阵物品数量应为 72，实际为 ${materialItems.length}`);
  assert(rawItemIds.length === 18, `量子原料数量应为 18，实际为 ${rawItemIds.length}`);
  assert(recipeById.size === 54, `生产配方数量应为 54，实际为 ${recipeById.size}`);
  return { materialItems, rawItemIds, rawItems, selectedRecipes: [...recipeById.values()], selectedRecipeByItem };
}

function configureScenario(state, content) {
  state.research.completedTechIds = Object.keys(content.TECHNOLOGIES);
  state.settings.resourceMode = "infinite";
  state.settings.productionBufferLimit = 100_000_000;
  state.settings.logisticsBufferLimit = 100_000_000;
  state.settings.beltBufferLimit = 100_000_000;
  state.planetTrayItemLimits.home = 100_000_000;
  for (const constructionId of Object.keys(state.construction)) state.construction[constructionId] = CONSTRUCTION_STOCK;
  state.dysonPlans.helios.structurePoints = DYSON_STRUCTURE_POINTS;
  state.dysonSphere.structurePoints = DYSON_STRUCTURE_POINTS;
  state.dysonSphere.totalRocketsLaunched = DYSON_STRUCTURE_POINTS;
  return state;
}

function rawDemandRates(plan, measuredRates) {
  const result = Object.fromEntries(plan.rawItemIds.map((itemId) => [itemId, 0]));
  for (const [itemId, recipe] of plan.selectedRecipeByItem) {
    const primaryOutput = recipe.outputs.find((output) => output.itemId === itemId);
    assert(primaryOutput, `${recipe.id} 缺少主产物 ${itemId}`);
    const cyclesPerSecond = (measuredRates[itemId] ?? 0) / primaryOutput.amount;
    for (const input of recipe.inputs) {
      if (plan.rawItems.has(input.itemId)) result[input.itemId] += cyclesPerSecond * input.amount;
    }
  }
  return Object.fromEntries(Object.entries(result).map(([itemId, value]) => [itemId, round(value)]));
}

function compareWindows(windows, itemIds) {
  const rates = Object.fromEntries(itemIds.map((itemId) => [
    itemId,
    round(average(windows.map((window) => window[itemId] ?? 0))),
  ]));
  const maxSpread = itemIds.reduce((current, itemId) => Math.max(
    current,
    relativeSpread(windows.map((window) => window[itemId] ?? 0)),
  ), 0);
  const widestItems = itemIds.map((itemId) => ({
    itemId,
    spread: round(relativeSpread(windows.map((window) => window[itemId] ?? 0)), 9),
    windows: windows.map((window) => window[itemId] ?? 0),
  })).sort((left, right) => right.spread - left.spread || left.itemId.localeCompare(right.itemId)).slice(0, 8);
  return { rates, maxSpread: round(maxSpread, 9), widestItems };
}

function compareRuns(left, right, itemIds) {
  return itemIds.reduce((maxDifference, itemId) => Math.max(
    maxDifference,
    Math.abs((left.rates[itemId] ?? 0) - (right.rates[itemId] ?? 0)),
  ), 0);
}

function keepRawInputsFull(state, plan) {
  for (const itemId of plan.rawItemIds) state.quantumLogisticsNetwork.inventory[itemId] = QUANTUM_RAW_STOCK;
}

function saturateNormalDestinations(state, kind, plan) {
  if (kind === "delivery") {
    for (const item of plan.materialItems) state.tray[item.id] = state.planetTrayItemLimits.home;
    return;
  }
  for (const item of plan.materialItems) {
    if (!plan.rawItems.has(item.id)) state.quantumLogisticsNetwork.inventory[item.id] = "10000000000";
  }
}

function advanceWithAbundantRawInputs(state, seconds, plan, engine) {
  assert(seconds % RAW_REFILL_INTERVAL_SECONDS === 0, "测试时长必须对齐原料补充周期");
  const session = engine.createSimulationAdvanceSession(state, Math.max(BATCHED_SESSION_SECONDS, seconds));
  assert(session.stepSize === 5, `长时稳态测试应使用量子边界安全的 5 秒步长，实际为 ${session.stepSize}`);
  const targetElapsedSeconds = state.elapsedSeconds + seconds;
  const stepsPerRefill = RAW_REFILL_INTERVAL_SECONDS / session.stepSize;
  while (session.state.elapsedSeconds < targetElapsedSeconds) {
    const advanced = engine.advanceSimulationSession(session, stepsPerRefill);
    assert(advanced === stepsPerRefill, `稳态测试只推进了 ${advanced}/${stepsPerRefill} 个批次`);
    keepRawInputsFull(session.state, plan);
  }
  assert(session.state.elapsedSeconds === targetElapsedSeconds, `稳态测试越过目标时刻 ${targetElapsedSeconds}`);
  return session.state;
}

function runScenario(kind, blueprint, plan, modules) {
  const { content, engine } = modules;
  let state = configureScenario(engine.createInitialState(SEED), content);
  state.blueprints = [blueprint];
  const entitiesBefore = state.entities.length;
  const beltsBefore = state.belts.length;
  state = engine.placeBlueprint(state, blueprint.id, { x: 50_000, y: 50_000 });
  const blueprintEntityIds = new Set(state.entities.slice(entitiesBefore).map((entity) => entity.id));
  assert(blueprintEntityIds.size === blueprint.entities.length, `${kind} 蓝图放置实体数不一致`);
  assert(state.belts.length - beltsBefore === blueprint.belts.length, `${kind} 蓝图放置线路数不一致`);

  state.construction.wind_turbine = CONSTRUCTION_STOCK;
  state = engine.placeBuilding(state, "wind_turbine", { x: -50_000, y: -50_000 }, CONSTRUCTION_STOCK);
  assert(state.entities.some((entity) => entity.buildingId === "wind_turbine" && entity.machineCount === CONSTRUCTION_STOCK), `${kind} 测试电源放置失败`);

  keepRawInputsFull(state, plan);
  saturateNormalDestinations(state, kind, plan);
  state = advanceWithAbundantRawInputs(state, WARMUP_SECONDS, plan, engine);
  assert(state.quantumLogisticsNetwork.enabled, `${kind} 量子网络未在预热期内启用`);
  assert(state.entities.filter((entity) => blueprintEntityIds.has(entity.id) && entity.buildingId === "interstellar_logistics_station")
    .every((entity) => entity.quantumMode === "quantum"), `${kind} 存在未完成量子接入的塔`);

  const sampledItemIds = [...plan.materialItems.map((item) => item.id), "hydrogen"];
  const windows = [];
  for (let index = 0; index < SAMPLE_WINDOWS; index += 1) {
    const before = snapshotProduced(state);
    state = advanceWithAbundantRawInputs(state, SAMPLE_SECONDS, plan, engine);
    const after = snapshotProduced(state);
    windows.push(Object.fromEntries(sampledItemIds.map((itemId) => [
      itemId,
      round(productionRate(before, after, SAMPLE_SECONDS, itemId)),
    ])));
  }

  const manufacturedItemIds = [...plan.selectedRecipeByItem.keys()];
  const measured = compareWindows(windows, manufacturedItemIds);
  const rawByproductRates = Object.fromEntries(plan.rawItemIds.map((itemId) => [
    itemId,
    round(average(windows.map((window) => window[itemId] ?? 0))),
  ]));
  const recipeEntities = state.entities.filter((entity) => blueprintEntityIds.has(entity.id) && entity.recipeId);
  const receiver = recipeEntities.find((entity) => entity.recipeId === "critical_photon");
  const activePowerFactors = recipeEntities
    .filter((entity) => entity.recipeId !== "critical_photon" && (entity.powerFactor ?? 0) > 0)
    .map((entity) => engine.getEntityPowerFactor(state, entity));
  const minActivePowerFactor = activePowerFactors.length ? Math.min(...activePowerFactors) : 0;
  const ratedReceiverPowerKw = receiver ? engine.getRayReceiverCapacityKw(state) * receiver.machineCount : 0;
  const blackHoles = state.entities.filter((entity) => blueprintEntityIds.has(entity.id) && entity.buildingId === "micro_black_hole_connector");
  const totalBlackHoleDestroyed = blackHoles.reduce((sum, entity) => sum + (entity.blackHolePorts ?? [])
    .reduce((portSum, port) => portSum + BigInt(port.totalDestroyed), 0n), 0n);

  return {
    kind,
    rates: measured.rates,
    rawDemandRates: rawDemandRates(plan, measured.rates),
    rawByproductRates,
    maxWindowRelativeSpread: measured.maxSpread,
    widestWindowItems: measured.widestItems,
    finalStateHash: stableStateHash(state),
    diagnostics: {
      elapsedSeconds: state.elapsedSeconds,
      entityCount: state.entities.length,
      beltCount: state.belts.length,
      quantumTowerCount: state.entities.filter((entity) => blueprintEntityIds.has(entity.id) && entity.quantumMode === "quantum").length,
      blackHoleCount: blackHoles.length,
      activeBlackHoleCount: blackHoles.filter((entity) => entity.blackHolePaused === false && entity.blackHoleActivationConfirmed === true).length,
      totalBlackHoleDestroyed: totalBlackHoleDestroyed.toString(),
      powerFactor: state.planetMetrics.home.powerFactor,
      minActivePowerFactor: round(minActivePowerFactor),
      dysonGenerationKw: state.dysonSphere.generationKw,
      dysonReceiverLoadKw: state.dysonSwarm.receiverLoadKw,
      criticalPhotonReceiverAllocationKw: receiver?.powerOutputKw ?? 0,
      criticalPhotonReceiverRatedKw: ratedReceiverPowerKw,
      machineStatuses: Object.fromEntries(recipeEntities.map((entity) => [
        entity.recipeId,
        engine.getEntityOperatingStatus(state, entity).code,
      ])),
      nonRunningMachines: recipeEntities.flatMap((entity) => {
        const status = engine.getEntityOperatingStatus(state, entity);
        return status.code === "running" ? [] : [{
          recipeId: entity.recipeId,
          status: status.code,
          inputs: entity.inputs,
          outputs: entity.outputs,
        }];
      }),
      trayForNonRunningOutputs: Object.fromEntries(recipeEntities.flatMap((entity) => {
        const status = engine.getEntityOperatingStatus(state, entity);
        return status.code === "running" ? [] : Object.keys(entity.outputs).map((itemId) => [itemId, state.tray[itemId] ?? 0]);
      })),
    },
  };
}

async function main() {
  const modules = await loadModules();
  try {
    const deliveryBlueprint = await loadBlueprint(BLUEPRINTS.delivery, modules.exchange);
    const quantumBlueprint = await loadBlueprint(BLUEPRINTS.quantum, modules.exchange);
    const deliveryPlan = createCatalogPlan(modules.content, modules.recipeGraph, deliveryBlueprint);
    const quantumPlan = createCatalogPlan(modules.content, modules.recipeGraph, quantumBlueprint);
    assert(JSON.stringify([...deliveryPlan.selectedRecipeByItem].map(([itemId, recipe]) => [itemId, recipe.id])) ===
      JSON.stringify([...quantumPlan.selectedRecipeByItem].map(([itemId, recipe]) => [itemId, recipe.id])), "两张蓝图的生产配方图不一致");

    const delivery = runScenario("delivery", deliveryBlueprint, deliveryPlan, modules);
    const deliveryRepeat = runScenario("delivery", deliveryBlueprint, deliveryPlan, modules);
    const quantum = runScenario("quantum", quantumBlueprint, quantumPlan, modules);
    const quantumRepeat = runScenario("quantum", quantumBlueprint, quantumPlan, modules);
    const manufacturedItemIds = [...deliveryPlan.selectedRecipeByItem.keys()];
    const deliveryRepeatMaxDifference = compareRuns(delivery, deliveryRepeat, manufacturedItemIds);
    const quantumRepeatMaxDifference = compareRuns(quantum, quantumRepeat, manufacturedItemIds);
    assert(deliveryRepeatMaxDifference === 0 && delivery.finalStateHash === deliveryRepeat.finalStateHash,
      `配送蓝图重复运行不确定：最大产率差 ${deliveryRepeatMaxDifference}`);
    assert(quantumRepeatMaxDifference === 0 && quantum.finalStateHash === quantumRepeat.finalStateHash,
      `量子蓝图重复运行不确定：最大产率差 ${quantumRepeatMaxDifference}`);

    const rows = deliveryPlan.materialItems.map((item) => ({
      itemId: item.id,
      name: item.name,
      category: deliveryPlan.rawItems.has(item.id) ? "raw" : "manufactured",
      deliveryPerSecond: deliveryPlan.rawItems.has(item.id)
        ? delivery.rawByproductRates[item.id] ?? 0
        : delivery.rates[item.id] ?? 0,
      quantumPerSecond: deliveryPlan.rawItems.has(item.id)
        ? quantum.rawByproductRates[item.id] ?? 0
        : quantum.rates[item.id] ?? 0,
      deliveryRawDemandPerSecond: delivery.rawDemandRates[item.id] ?? 0,
      quantumRawDemandPerSecond: quantum.rawDemandRates[item.id] ?? 0,
    }));
    const result = {
      conditions: {
        stackCount: STACK_COUNT,
        warmupSeconds: WARMUP_SECONDS,
        sampleSecondsPerWindow: SAMPLE_SECONDS,
        sampleWindows: SAMPLE_WINDOWS,
        rawRefillIntervalSeconds: RAW_REFILL_INTERVAL_SECONDS,
        engineStepSeconds: 5,
        normalDestinations: "pre-saturated; overflow handled by active black holes",
        quantumRawStockPerItem: QUANTUM_RAW_STOCK,
        constructionStock: CONSTRUCTION_STOCK,
        dysonStructurePoints: DYSON_STRUCTURE_POINTS,
        finiteTechnologiesCompleted: Object.keys(modules.content.TECHNOLOGIES).length,
        resourceMode: "infinite",
        bufferLimitPerItem: 100_000_000,
      },
      deterministicRepeat: {
        deliveryMaxRateDifference: deliveryRepeatMaxDifference,
        quantumMaxRateDifference: quantumRepeatMaxDifference,
      },
      delivery: {
        maxWindowRelativeSpread: delivery.maxWindowRelativeSpread,
        widestWindowItems: delivery.widestWindowItems,
        finalStateHash: delivery.finalStateHash,
        diagnostics: delivery.diagnostics,
      },
      quantum: {
        maxWindowRelativeSpread: quantum.maxWindowRelativeSpread,
        widestWindowItems: quantum.widestWindowItems,
        finalStateHash: quantum.finalStateHash,
        diagnostics: quantum.diagnostics,
      },
      rows,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await modules.vite.close();
  }
}

await main();
