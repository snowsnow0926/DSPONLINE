import { ITEMS } from "./content";
import type { FactoryEntity, GameState, ItemId } from "./types";
import type {
  OfflineComplexityReport,
  OfflineDeviceCapability,
  OfflineDeviceClass,
  OfflineRecommendedStrategy,
  OfflineSaveProfile,
} from "./offlineComplexityTypes";

export type {
  OfflineComplexityReport,
  OfflineDeviceCapability,
  OfflineDeviceClass,
  OfflineRecommendedStrategy,
  OfflineSaveProfile,
} from "./offlineComplexityTypes";

const MIB = 1024 * 1024;

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function hasAmount(entity: FactoryEntity, itemId: ItemId): boolean {
  return finiteNonNegative(entity.inputs[itemId]) > 0 || finiteNonNegative(entity.outputs[itemId]) > 0;
}

function deviceMemory(): number | null {
  if (typeof navigator === "undefined") return null;
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function readOfflineDeviceCapability(): OfflineDeviceCapability {
  const memory = deviceMemory();
  const cores = typeof navigator !== "undefined" && Number.isFinite(navigator.hardwareConcurrency)
    ? Math.max(1, Math.floor(navigator.hardwareConcurrency))
    : null;
  const coarsePointer = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const lowMemory = memory !== null && memory <= 2;
  const constrained = lowMemory || (memory !== null && memory <= 4) || (cores !== null && cores <= 4) || coarsePointer;
  return {
    deviceClass: lowMemory || (cores !== null && cores <= 2) ? "low-memory" : constrained ? "constrained" : "standard",
    deviceMemoryGb: memory,
    hardwareConcurrency: cores,
    coarsePointer,
    workerSupported: typeof Worker !== "undefined",
  };
}

function normalizedDevice(device?: Partial<OfflineDeviceCapability>): OfflineDeviceCapability {
  const detected = readOfflineDeviceCapability();
  const memory = typeof device?.deviceMemoryGb === "number" && Number.isFinite(device.deviceMemoryGb)
    ? Math.max(0.25, device.deviceMemoryGb)
    : device?.deviceMemoryGb === null ? null : detected.deviceMemoryGb;
  const cores = typeof device?.hardwareConcurrency === "number" && Number.isFinite(device.hardwareConcurrency)
    ? Math.max(1, Math.floor(device.hardwareConcurrency))
    : device?.hardwareConcurrency === null ? null : detected.hardwareConcurrency;
  const coarsePointer = device?.coarsePointer ?? detected.coarsePointer;
  const inferredClass: OfflineDeviceClass = memory !== null && memory <= 2 || cores !== null && cores <= 2
    ? "low-memory"
    : memory !== null && memory <= 4 || cores !== null && cores <= 4 || coarsePointer
      ? "constrained"
      : "standard";
  return {
    deviceClass: device?.deviceClass ?? inferredClass,
    deviceMemoryGb: memory,
    hardwareConcurrency: cores,
    coarsePointer,
    workerSupported: device?.workerSupported ?? detected.workerSupported,
  };
}

function estimateSerializedBytes(state: GameState): number {
  const entityMaps = state.entities.reduce((sum, entity) => sum +
    Object.keys(entity.inputs).length + Object.keys(entity.outputs).length +
    (entity.stationSlots?.length ?? 0) * 3 + (entity.stationRoutes?.length ?? 0) * 6, 0);
  const blueprintNodes = state.blueprints.reduce((sum, blueprint) => sum + blueprint.entities.length + blueprint.belts.length, 0);
  const queueNodes = state.constructionQueue.reduce((sum, entry) => sum + Object.keys(entry.reservedConstruction ?? {}).length, 0);
  return Math.max(64 * 1024, Math.floor(
    state.entities.length * 760 + state.belts.length * 330 + entityMaps * 72 +
    blueprintNodes * 210 + queueNodes * 80 + state.productionHistory.length * 160 + 96 * 1024,
  ));
}

export function classifyOfflineWorkload(
  state: GameState,
  seconds: number,
  options: {
    device?: Partial<OfflineDeviceCapability>;
    serializedBytes?: number;
  } = {},
): OfflineComplexityReport {
  const device = normalizedDevice(options.device);
  const stationCount = state.entities.filter((entity) => entity.kind === "station").length;
  const quantumStationCount = state.entities.filter((entity) => entity.quantumMode === "quantum" || Boolean(entity.quantumTransition)).length;
  const routeCount = state.entities.reduce((sum, entity) => sum + (entity.stationRoutes?.length ?? 0), 0);
  const activeConstructionJobs = Object.keys(state.constructionAutomation.jobs ?? {}).length + state.constructionQueue.length + state.handcraftQueue.length;
  const fluidIds = new Set<ItemId>(Object.values(ITEMS).filter((item) => item.kind === "fluid").map((item) => item.id));
  let fluidOrGasConnections = state.belts.filter((belt) => fluidIds.has(belt.itemId)).length;
  let nearCacheBoundaryCount = 0;
  let finiteResourceBoundaryCount = 0;
  for (const entity of state.entities) {
    for (const itemId of fluidIds) if (hasAmount(entity, itemId)) fluidOrGasConnections += 1;
    const values = [...Object.values(entity.inputs), ...Object.values(entity.outputs)]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const cacheLimit = entity.kind === "station" || entity.kind === "storage" || entity.kind === "splitter"
      ? state.settings.logisticsBufferLimit
      : state.settings.productionBufferLimit;
    if (values.some((value) => value <= 1 || value >= cacheLimit * 0.9)) nearCacheBoundaryCount += 1;
    if (entity.kind === "vein" && entity.resourceRemaining !== undefined && entity.resourceRemaining >= 0 && entity.resourceRemaining <= Math.max(10, entity.minerCount * 60)) {
      finiteResourceBoundaryCount += 1;
    }
  }
  const activeDysonSystems = Object.values(state.dysonPlans).filter((plan) => plan.layers.some((layer) =>
    layer.nodes.some((node) => finiteNonNegative(node.completedStructurePoints) > 0 || finiteNonNegative(node.requiredStructurePoints) > 0) ||
    layer.frames.length > 0 || layer.shells.length > 0,
  )).length + (state.dysonSwarm.sailsInOrbit > 0 || state.dysonSphere.totalRocketsLaunched > 0 ? 1 : 0);
  const estimatedSerializedBytes = Math.max(0, Math.floor(options.serializedBytes ?? estimateSerializedBytes(state)));
  // fast-30s-v3-lite retains the immutable source, one mutable simulation
  // candidate and compact material/research projections. It no longer keeps
  // four generic full-state calibration/validation clones. This remains a
  // conservative warning estimate, never an allocator or gameplay limit.
  const estimatedPeakBytes = Math.max(estimatedSerializedBytes * 3, Math.floor(
    state.entities.length * 14_000 + state.belts.length * 6_500 + routeCount * 8_000 + estimatedSerializedBytes * 2,
  ));

  let score = 0;
  score += Math.min(35, state.entities.length / 350);
  score += Math.min(35, state.belts.length / 700);
  score += Math.min(12, stationCount / 40);
  score += Math.min(10, routeCount / 80);
  score += Math.min(12, fluidOrGasConnections / 100);
  score += Math.min(12, nearCacheBoundaryCount / 60);
  score += Math.min(15, activeConstructionJobs * 3);
  score += Math.min(10, activeDysonSystems * 2);
  score += Math.min(8, finiteResourceBoundaryCount * 2);
  score += Math.min(8, quantumStationCount / 40);
  score = Math.round(score * 100) / 100;

  const volatile = routeCount > 0 || quantumStationCount > 0 || nearCacheBoundaryCount > Math.max(5, state.entities.length * 0.04);
  const complexBoundary = activeConstructionJobs > 0 || fluidOrGasConnections > 30 || activeDysonSystems > 1 || finiteResourceBoundaryCount > 0;
  const profile: OfflineSaveProfile = state.entities.length < 500 && state.belts.length < 1_000 && !complexBoundary
    ? "simple"
    : complexBoundary || score >= 75
      ? "complex"
      : volatile ? "volatile-endgame" : "stable-endgame";

  const secondsSafe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  let recommendedStrategy: OfflineRecommendedStrategy = secondsSafe <= 30 || state.speedrun?.enabled ? "exact" : "fast";
  const memoryLimitBytes = device.deviceMemoryGb === null ? null : device.deviceMemoryGb * 1024 * MIB;
  const memoryRisk = memoryLimitBytes !== null && estimatedPeakBytes > memoryLimitBytes * 0.72;
  // Truly exceptional saves still need a conservative decision even with the
  // single-candidate algorithm. Low-memory devices additionally avoid large
  // payloads whose source + candidate can consume most of a 2 GiB process.
  const absoluteMemoryRisk = estimatedSerializedBytes >= 128 * MIB || estimatedPeakBytes >= 4 * 1024 * MIB;
  if (recommendedStrategy === "fast" && (
    absoluteMemoryRisk ||
    device.deviceClass === "low-memory" &&
      (profile === "complex" || memoryRisk || estimatedSerializedBytes >= 32 * MIB)
  )) {
    recommendedStrategy = "conservative";
  }
  const recommendedDeadlineMs = recommendedStrategy === "exact"
    ? 0
    : recommendedStrategy === "conservative"
      // v5-lite deliberately observes three exact ten-second windows. Large
      // saves can need more than the historical 30-second real-time budget,
      // even though the resulting settlement is still constant-time.
      ? device.deviceClass === "standard" ? 90_000
        : device.deviceClass === "constrained" ? 120_000 : 180_000
      : profile === "complex" || estimatedSerializedBytes >= 20 * MIB
        ? device.deviceClass === "standard" ? 90_000
          : device.deviceClass === "constrained" ? 120_000 : 180_000
        : device.deviceClass === "standard" ? 30_000
          : device.deviceClass === "constrained" ? 60_000 : 75_000;
  const reasons: string[] = [];
  if (state.entities.length >= 3_000) reasons.push(`实体 ${state.entities.length.toLocaleString("zh-CN")}`);
  if (state.belts.length >= 6_000) reasons.push(`线路 ${state.belts.length.toLocaleString("zh-CN")}`);
  if (routeCount > 0) reasons.push(`在途物流 ${routeCount}`);
  if (quantumStationCount > 0) reasons.push(`量子节点 ${quantumStationCount}`);
  if (activeConstructionJobs > 0) reasons.push(`递归/施工任务 ${activeConstructionJobs}`);
  if (fluidOrGasConnections > 0) reasons.push(`流体链 ${fluidOrGasConnections}`);
  if (activeDysonSystems > 0) reasons.push(`戴森活动 ${activeDysonSystems}`);
  if (nearCacheBoundaryCount > 0) reasons.push(`缓存边界 ${nearCacheBoundaryCount}`);
  let warning: string | undefined;
  if (!device.workerSupported) warning = "当前环境不支持 Worker，长时间离线不会在主线程静默执行";
  else if (memoryRisk || absoluteMemoryRisk || estimatedSerializedBytes >= 20 * MIB) {
    warning = recommendedStrategy === "conservative"
      ? device.deviceClass === "low-memory"
        ? "该终局存档在当前低内存设备上存在内存风险，将优先使用可取消的保守宏观路径；原存档在提交前保持不变"
        : "该超大型终局存档的精确校准存在内存风险，将优先使用可取消的保守宏观路径；原存档在提交前保持不变"
      : "该终局存档预计占用较高内存；结算会保持在 Worker 中并支持取消，不能承诺所有设备 30 秒完成";
  }
  return {
    profile,
    recommendedStrategy,
    score,
    entityCount: state.entities.length,
    beltCount: state.belts.length,
    stationCount,
    quantumStationCount,
    routeCount,
    activeConstructionJobs,
    fluidOrGasConnections,
    nearCacheBoundaryCount,
    activeDysonSystems,
    finiteResourceBoundaryCount,
    estimatedSerializedBytes,
    estimatedPeakBytes,
    device,
    recommendedDeadlineMs,
    reasons,
    ...(warning ? { warning } : {}),
  };
}
