import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLUEPRINTS = {
  delivery: path.join(ROOT, "blueprints", "射线接收站四材料-量子下载-配送枢纽-极限产能.json"),
  quantum: path.join(ROOT, "blueprints", "射线接收站四材料-量子下载-量子上传-极限产能.json"),
};
const SEED = 20_260_826;
const STEP_SECONDS = 0.1;
const WARMUP_SECONDS = 120;
const SAMPLE_SECONDS = 60;
const SAMPLE_WINDOWS = 4;
const QUANTUM_BOUNDARY_SECONDS = 5;
const QUANTUM_RAW_STOCK = "10000000000";
const POWER_STAR_COUNT = 2;
const POWER_STAR_STACK = 100_000_000;
const CONSTRUCTION_STOCK = 100_000_000_000;
const EPSILON = 1e-7;
const QUICK = process.argv.includes("--quick");

const TARGET_RATES = {
  steel: 499_800_000,
  high_purity_silicon: 499_800_000,
  photon_combiner: 249_900_000,
  processor: 124_950_000,
};
const GROSS_PRODUCTION_RATES = {
  ...TARGET_RATES,
  high_purity_silicon: 999_600_000,
};
const BUILD_COSTS = {
  steel: 20,
  high_purity_silicon: 20,
  photon_combiner: 10,
  processor: 5,
};
const TARGET_ITEM_IDS = Object.keys(TARGET_RATES);
const RAW_ITEM_IDS = ["iron_ore", "silicon_ore", "copper_ore", "optical_grating_crystal"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function snapshotProduced(state) {
  return Object.fromEntries(TARGET_ITEM_IDS.map((itemId) => [itemId, Math.floor(state.totalProduced[itemId] ?? 0)]));
}

function ratesBetween(before, after, seconds) {
  return Object.fromEntries(TARGET_ITEM_IDS.map((itemId) => [
    itemId,
    round(((after[itemId] ?? 0) - (before[itemId] ?? 0)) / seconds),
  ]));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function relativeSpread(values) {
  const maximum = Math.max(...values);
  const minimum = Math.min(...values);
  return maximum <= 0 ? 0 : (maximum - minimum) / maximum;
}

function stableHash(state) {
  return createHash("sha256").update(JSON.stringify({
    elapsedSeconds: state.elapsedSeconds,
    totalProduced: Object.fromEntries(TARGET_ITEM_IDS.map((itemId) => [itemId, state.totalProduced[itemId] ?? 0])),
    quantumInventory: Object.fromEntries([...RAW_ITEM_IDS, ...TARGET_ITEM_IDS]
      .map((itemId) => [itemId, state.quantumLogisticsNetwork.inventory[itemId] ?? "0"])),
    recipeEntities: state.entities.filter((entity) => entity.recipeId).map((entity) => ({
      id: entity.id,
      recipeId: entity.recipeId,
      machineCount: entity.machineCount,
      inputs: entity.inputs,
      outputs: entity.outputs,
      progress: entity.progress,
      powerFactor: entity.powerFactor,
    })),
  })).digest("hex");
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

async function loadBlueprint(filePath, exchange) {
  const parsed = exchange.parseBlueprintExchange(await readFile(filePath, "utf8"));
  assert(parsed.valid && parsed.blueprint, `${path.relative(ROOT, filePath)} 校验失败：${parsed.issues.join("；")}`);
  return parsed.blueprint;
}

function configureScenario(state, content) {
  state.research.completedTechIds = Object.keys(content.TECHNOLOGIES);
  state.settings.resourceMode = "infinite";
  state.settings.productionBufferLimit = 100_000_000;
  state.settings.logisticsBufferLimit = 100_000_000;
  state.settings.beltBufferLimit = 100_000_000;
  state.planetTrayItemLimits.home = 100_000_000;
  for (const constructionId of Object.keys(state.construction)) state.construction[constructionId] = CONSTRUCTION_STOCK;
  return state;
}

function keepRawInventoryFull(state) {
  for (const itemId of RAW_ITEM_IDS) state.quantumLogisticsNetwork.inventory[itemId] = QUANTUM_RAW_STOCK;
}

function addTestPower(state, engine) {
  for (let index = 0; index < POWER_STAR_COUNT; index += 1) {
    state.construction.artificial_star = CONSTRUCTION_STOCK;
    state = engine.placeBuilding(state, "artificial_star", { x: -20_000 - index * 400, y: -20_000 }, POWER_STAR_STACK);
  }
  const stars = state.entities.filter((entity) => entity.buildingId === "artificial_star" && entity.machineCount === POWER_STAR_STACK);
  assert(stars.length === POWER_STAR_COUNT, "测试用人造恒星放置失败");
  for (const star of stars) {
    star.fuelItemId = "antimatter_fuel_rod";
    star.inputs.antimatter_fuel_rod = 100_000_000;
    star.fuelRemainingMj = 0;
  }
  return { state, starIds: stars.map((star) => star.id) };
}

function refillTestPower(state, starIds) {
  for (const starId of starIds) {
    const star = state.entities.find((entity) => entity.id === starId);
    assert(star, `测试电源 ${starId} 丢失`);
    star.inputs.antimatter_fuel_rod = 100_000_000;
  }
}

function createSinkCounter() {
  return Object.fromEntries(TARGET_ITEM_IDS.map((itemId) => [itemId, 0]));
}

function drainNormalDestinations(state, kind, sinkCounter) {
  if (kind === "delivery") {
    const tray = state.tray;
    for (const itemId of TARGET_ITEM_IDS) {
      const amount = tray[itemId] ?? 0;
      sinkCounter[itemId] += amount;
      tray[itemId] = 0;
      if (state.planetTrays.home && state.planetTrays.home !== tray) state.planetTrays.home[itemId] = 0;
    }
    return;
  }
  for (const itemId of TARGET_ITEM_IDS) {
    const amount = Number(BigInt(state.quantumLogisticsNetwork.inventory[itemId] ?? "0"));
    sinkCounter[itemId] += amount;
    state.quantumLogisticsNetwork.inventory[itemId] = "0";
  }
}

function snapshotSinkCounter(counter) {
  return Object.fromEntries(TARGET_ITEM_IDS.map((itemId) => [itemId, counter[itemId]]));
}

function runSegment(session, seconds, context, modules) {
  const targetElapsedSeconds = session.state.elapsedSeconds + seconds;
  while (session.state.elapsedSeconds < targetElapsedSeconds - EPSILON) {
    const advanced = modules.engine.advanceSimulationSession(session, 1);
    assert(advanced === 1, `精确稳态测试在 ${session.state.elapsedSeconds}s 未能推进`);
    drainNormalDestinations(session.state, context.kind, context.sinkCounter);
    while (session.state.elapsedSeconds + EPSILON >= context.nextQuantumRefillAt) {
      keepRawInventoryFull(session.state);
      context.nextQuantumRefillAt += QUANTUM_BOUNDARY_SECONDS;
    }
    while (session.state.elapsedSeconds + EPSILON >= context.nextPowerRefillAt) {
      refillTestPower(session.state, context.starIds);
      context.nextPowerRefillAt += 60;
    }
  }
  assert(Math.abs(session.state.elapsedSeconds - targetElapsedSeconds) <= EPSILON,
    `精确稳态测试越过目标时刻 ${targetElapsedSeconds}，实际 ${session.state.elapsedSeconds}`);
}

function receiverEquivalentRate(rates) {
  return Math.min(...TARGET_ITEM_IDS.map((itemId) => rates[itemId] / BUILD_COSTS[itemId]));
}

function runScenario(kind, blueprint, modules) {
  const { content, engine } = modules;
  let state = configureScenario(engine.createInitialState(SEED), content);
  state.blueprints = [blueprint];
  const entitiesBefore = state.entities.length;
  const beltsBefore = state.belts.length;
  state = engine.placeBlueprint(state, blueprint.id, { x: 50_000, y: 50_000 });
  const blueprintEntities = state.entities.slice(entitiesBefore);
  const blueprintEntityIds = new Set(blueprintEntities.map((entity) => entity.id));
  assert(blueprintEntities.length === blueprint.entities.length, `${kind} 蓝图放置实体数不一致`);
  assert(state.belts.length - beltsBefore === blueprint.belts.length, `${kind} 蓝图放置线路数不一致`);

  const powered = addTestPower(state, engine);
  state = powered.state;
  keepRawInventoryFull(state);
  const sinkCounter = createSinkCounter();
  drainNormalDestinations(state, kind, sinkCounter);

  const totalSeconds = WARMUP_SECONDS + SAMPLE_SECONDS * SAMPLE_WINDOWS;
  const session = engine.createSimulationAdvanceSession(state, totalSeconds, { mutateState: true });
  session.stepSize = STEP_SECONDS;
  const context = {
    kind,
    sinkCounter,
    starIds: powered.starIds,
    nextQuantumRefillAt: QUANTUM_BOUNDARY_SECONDS,
    nextPowerRefillAt: 60,
  };
  runSegment(session, WARMUP_SECONDS, context, modules);
  assert(session.state.quantumLogisticsNetwork.enabled, `${kind} 量子网络未启用`);
  const quantumStations = session.state.entities.filter((entity) => blueprintEntityIds.has(entity.id) && entity.buildingId === "interstellar_logistics_station");
  const expectedQuantumStations = blueprint.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station").length;
  assert(quantumStations.length === expectedQuantumStations && quantumStations.every((entity) => entity.quantumMode === "quantum"),
    `${kind} 存在未完成量子接入的塔`);

  const windows = [];
  for (let index = 0; index < SAMPLE_WINDOWS; index += 1) {
    const beforeProduced = snapshotProduced(session.state);
    const beforeSink = snapshotSinkCounter(sinkCounter);
    runSegment(session, SAMPLE_SECONDS, context, modules);
    const afterProduced = snapshotProduced(session.state);
    const afterSink = snapshotSinkCounter(sinkCounter);
    windows.push({
      produced: ratesBetween(beforeProduced, afterProduced, SAMPLE_SECONDS),
      received: ratesBetween(beforeSink, afterSink, SAMPLE_SECONDS),
    });
  }

  const rates = Object.fromEntries(TARGET_ITEM_IDS.map((itemId) => [
    itemId,
    round(average(windows.map((window) => window.produced[itemId]))),
  ]));
  const receivedRates = Object.fromEntries(TARGET_ITEM_IDS.map((itemId) => [
    itemId,
    round(average(windows.map((window) => window.received[itemId]))),
  ]));
  for (const itemId of TARGET_ITEM_IDS) {
    assert(Math.abs(rates[itemId] - GROSS_PRODUCTION_RATES[itemId]) <= 100,
      `${kind} ${itemId} 毛产量 ${rates[itemId]}/s，与规划 ${GROSS_PRODUCTION_RATES[itemId]}/s 不一致`);
    assert(Math.abs(receivedRates[itemId] - TARGET_RATES[itemId]) <= 100,
      `${kind} ${itemId} 末端实收 ${receivedRates[itemId]}/s，与规划 ${TARGET_RATES[itemId]}/s 不一致`);
  }

  const recipeEntities = session.state.entities.filter((entity) => blueprintEntityIds.has(entity.id) && entity.recipeId);
  const minimumPowerFactor = Math.min(...recipeEntities.map((entity) => engine.getEntityPowerFactor(session.state, entity)));
  assert(minimumPowerFactor === 1, `${kind} 存在未满功率配方节点，最低供电 ${minimumPowerFactor}`);
  const blackHoles = session.state.entities.filter((entity) => blueprintEntityIds.has(entity.id) && entity.buildingId === "micro_black_hole_connector");
  const destroyed = blackHoles.reduce((sum, entity) => sum + (entity.blackHolePorts ?? [])
    .reduce((portSum, port) => portSum + BigInt(port.totalDestroyed), 0n), 0n);
  const maxSpread = Math.max(...TARGET_ITEM_IDS.map((itemId) => relativeSpread(windows.map((window) => window.produced[itemId]))));

  return {
    kind,
    rates,
    receivedRates,
    receiverEquivalentPerSecond: round(receiverEquivalentRate(receivedRates)),
    maxWindowRelativeSpread: round(maxSpread, 12),
    windows,
    finalStateHash: stableHash(session.state),
    diagnostics: {
      elapsedSeconds: session.state.elapsedSeconds,
      blueprintEntities: blueprint.entities.length,
      blueprintBelts: blueprint.belts.length,
      recipeNodes: recipeEntities.length,
      quantumTowers: quantumStations.length,
      activeBlackHoles: blackHoles.filter((entity) => entity.blackHolePaused === false && entity.blackHoleActivationConfirmed === true).length,
      blackHoleDestroyedDuringDemandTest: destroyed.toString(),
      minimumRecipePowerFactor: minimumPowerFactor,
      planetPowerFactor: session.state.planetMetrics.home.powerFactor,
    },
  };
}

function compareRuns(left, right) {
  return Math.max(...TARGET_ITEM_IDS.map((itemId) => Math.abs(left.rates[itemId] - right.rates[itemId])));
}

async function main() {
  const modules = await loadModules();
  try {
    const deliveryBlueprint = await loadBlueprint(BLUEPRINTS.delivery, modules.exchange);
    const quantumBlueprint = await loadBlueprint(BLUEPRINTS.quantum, modules.exchange);
    const delivery = runScenario("delivery", deliveryBlueprint, modules);
    const deliveryRepeat = QUICK ? delivery : runScenario("delivery", deliveryBlueprint, modules);
    const quantum = runScenario("quantum", quantumBlueprint, modules);
    const quantumRepeat = QUICK ? quantum : runScenario("quantum", quantumBlueprint, modules);
    const deliveryDifference = compareRuns(delivery, deliveryRepeat);
    const quantumDifference = compareRuns(quantum, quantumRepeat);
    assert(deliveryDifference === 0 && delivery.finalStateHash === deliveryRepeat.finalStateHash,
      `配送版重复运行不确定：最大产率差 ${deliveryDifference}`);
    assert(quantumDifference === 0 && quantum.finalStateHash === quantumRepeat.finalStateHash,
      `量子版重复运行不确定：最大产率差 ${quantumDifference}`);

    process.stdout.write(`${JSON.stringify({
      conditions: {
        theoreticalReceiverKitsPerSecond: 25_000_000,
        plannedReceiverKitsPerSecond: 24_990_000,
        targetRatesPerSecond: TARGET_RATES,
        grossProductionRatesPerSecond: GROSS_PRODUCTION_RATES,
        warmupSeconds: WARMUP_SECONDS,
        sampleSecondsPerWindow: SAMPLE_SECONDS,
        sampleWindows: SAMPLE_WINDOWS,
        engineStepSeconds: STEP_SECONDS,
        quantumBoundarySeconds: QUANTUM_BOUNDARY_SECONDS,
        quantumRawStockPerItem: QUANTUM_RAW_STOCK,
        destinationPolicy: "normal destinations continuously drained to emulate construction demand",
        productionBufferLimit: 100_000_000,
        logisticsBufferLimit: 100_000_000,
        powerStars: POWER_STAR_COUNT,
        powerStarStack: POWER_STAR_STACK,
        quick: QUICK,
      },
      deterministicRepeat: {
        deliveryMaxRateDifference: deliveryDifference,
        quantumMaxRateDifference: quantumDifference,
      },
      delivery,
      quantum,
    }, null, 2)}\n`);
  } finally {
    await modules.vite.close();
  }
}

await main();
