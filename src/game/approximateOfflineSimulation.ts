import { getItem, getRecipe } from "./content";
import {
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createSimulationAdvanceSession,
  getEntityInputCapacity,
  getEntityOutputCapacity,
  getPlanetTrayItemLimit,
} from "./engine";
import { getNextOfflineCriticalEvent } from "./offlineCriticalEvents";
import type { OfflineSettlementDiagnostics, OfflineSettlementPhase, OfflineSettlementProgress } from "./offlineExperiment";
import type { BeltConnection, FactoryEntity, GameState, ItemId, PlanetId } from "./types";

const DEFAULT_CALIBRATION_WINDOW_SECONDS = 5;
const MINIMUM_APPROXIMATE_INTERVAL_SECONDS = 10;
const RATE_STABILITY_LIMIT = 0.05;
const ESTIMATED_ERROR_LIMIT = 0.1;
const HARD_ESTIMATED_ERROR_LIMIT = 0.2;
const FIXED_POINT_SCALE = 1_000_000_000n;
const DURATION_SCALE = 1_000_000n;

type LedgerKind =
  | "elapsed"
  | "manual-mined"
  | "total-produced"
  | "planet-tray"
  | "entity-input"
  | "entity-output"
  | "entity-progress"
  | "entity-utilization"
  | "entity-production-rate"
  | "entity-power-factor"
  | "entity-power-input"
  | "entity-power-output"
  | "belt-progress"
  | "belt-total-transferred"
  | "belt-congestion"
  | "belt-last-flow";

interface LedgerEntry {
  key: string;
  kind: LedgerKind;
  value: number;
  ownerId?: string;
  itemId?: ItemId;
  planetId?: PlanetId;
  extrapolate: boolean;
  integer: boolean;
  minimum?: number;
  maximum?: number;
}

interface LedgerSnapshot {
  entries: Map<string, LedgerEntry>;
}

interface LedgerDelta {
  key: string;
  entry: LedgerEntry;
  amount: number;
}

interface StabilityResult {
  stable: boolean;
  maximumVariation: number;
  reason?: string;
}

export interface ApproximateOfflineEligibility {
  eligible: boolean;
  reasons: string[];
}

export interface ApproximateOfflineSettlementResult {
  state: GameState;
  diagnostics: OfflineSettlementDiagnostics;
}

export interface ApproximateOfflineSettlementOptions {
  calibrationWindowSeconds?: number;
  softTimeoutMs?: number;
  shouldCancel?: () => boolean;
  onProgress?: (progress: OfflineSettlementProgress) => void;
  yieldControl?: () => Promise<void>;
}

interface ExactAdvanceOptions {
  phase: OfflineSettlementPhase;
  totalSeconds: number;
  completedBefore: number;
  approximateSeconds: number;
  estimatedError: number;
  complete: boolean;
  shouldCancel: () => boolean;
  onProgress?: (progress: OfflineSettlementProgress) => void;
  yieldControl: () => Promise<void>;
  onMessage: () => void;
}

interface MacroApplyResult {
  state?: GameState;
  conservationVerified: boolean;
  reason?: string;
}

const HIGH_RISK_BUILDINGS = new Set([
  "oil_refinery",
  "chemical_plant",
  "quantum_chemical_plant",
  "fractionator",
  "em_rail_ejector",
  "ray_receiver",
  "vertical_launching_silo",
  "orbital_collector",
  "construction_center",
]);

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("离线计算已取消", "AbortError");
  const error = new Error("离线计算已取消");
  error.name = "AbortError";
  return error;
}

function positiveNumber(value: unknown): boolean {
  if (typeof value === "string") return /^\d+$/.test(value) && BigInt(value) > 0n;
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function recordHasPositiveValue(record: Record<string, unknown> | undefined): boolean {
  return Boolean(record && Object.values(record).some(positiveNumber));
}

function entityUsesFluidRecipe(entity: FactoryEntity): boolean {
  if (!entity.recipeId) return false;
  const recipe = getRecipe(entity.recipeId);
  if (!recipe) return true;
  return [...recipe.inputs, ...recipe.outputs].some(({ itemId }) => getItem(itemId).kind === "fluid");
}

/**
 * This first prototype is intentionally conservative. It only admits local,
 * non-depleting production whose mutable state can be represented by the
 * measured integer ledger below. Every rejected subsystem stays on the exact
 * engine path.
 */
export function inspectApproximateOfflineEligibility(state: GameState): ApproximateOfflineEligibility {
  const reasons: string[] = [];
  const add = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (state.paused) add("存档处于暂停状态");
  if (state.contentPacks.length > 0) add("内容包运行时定义不属于首版近似白名单");
  if (state.cargo) add("玩家光标仍携带物资");
  if (state.research.selectedTechId || state.research.queuedTechIds.length > 0 ||
    Object.values(state.research.progressByTech).some((progress) => recordHasPositiveValue(progress as Record<string, unknown>))) {
    add("科研队列或科研进度正在变化");
  }
  if (state.exploration.missions.length > 0) add("存在进行中的星系探索任务");
  if (state.handcraftQueue.length > 0) add("存在手搓制造任务");
  if (state.constructionQueue.length > 0) add("存在蓝图施工订单");
  if (state.constructionAutomation.enabled || Object.keys(state.constructionAutomation.jobs).length > 0) {
    add("建筑制造中心递归制造可能变化");
  }
  if (state.timeWarp.enabled || state.timeWarp.pendingSimulationSeconds > 0 || state.timeWarp.pendingWallSeconds > 0) {
    add("时间扭曲状态正在变化");
  }
  if (state.endgame.activeInfiniteResearchId || state.endgame.autoResearch) add("无限科研正在运行");
  if (state.endgame.autoDispatch || state.endgame.exportWindowAmount > 0 || Object.values(state.endgame.exportProjects).some((project) => project.enabled)) {
    add("银河出口正在运行");
  }
  if (state.endgame.constructionActivity.activityId ||
    Object.keys(state.endgame.constructionActivity.pendingBatches).length > 0) {
    add("全服建造活动存在待结算物资");
  }
  if (state.dysonSwarm.sailsInOrbit > 0 || state.dysonSwarm.totalLaunched > 0 ||
    state.dysonSphere.structurePoints > 0 || state.dysonSphere.shellSails > 0 ||
    state.dysonEngineering.launchEnabled) {
    add("戴森结构、太阳帆或发射系统必须精确结算");
  }
  if (state.galacticHubNetwork.fleetBusy > 0 || state.galacticHubNetwork.fleetReturns.length > 0 ||
    positiveNumber(state.galacticHubNetwork.warpers)) {
    add("银河物流 Hub 存在载具或翘曲器状态");
  }
  if (state.quantumLogisticsNetwork.enabled ||
    recordHasPositiveValue(state.quantumLogisticsNetwork.inventory as Record<string, unknown>) ||
    recordHasPositiveValue(state.quantumLogisticsNetwork.runtimeFlow?.uploaded as Record<string, unknown> | undefined) ||
    recordHasPositiveValue(state.quantumLogisticsNetwork.runtimeFlow?.downloaded as Record<string, unknown> | undefined)) {
    add("量子共享库存或量子吞吐必须精确结算");
  }
  if (Object.values(state.systemSpaceStations).some((station) => station && (
    station.status !== "not-started" ||
    recordHasPositiveValue(station.delivered as Record<string, unknown>) ||
    recordHasPositiveValue(station.constructionBuffer as Record<string, unknown>) ||
    recordHasPositiveValue(station.inventory as Record<string, unknown>)
  ))) add("恒星系空间站状态不属于首版近似白名单");

  for (const entity of state.entities) {
    if (entity.kind === "station" || (entity.stationRoutes?.length ?? 0) > 0 || entity.quantumMode === "quantum" || entity.quantumTransition) {
      add("物流塔、量子塔或在途物流必须精确结算");
    }
    if (entity.buildingId && HIGH_RISK_BUILDINGS.has(entity.buildingId)) add("液体、戴森或递归制造建筑必须精确结算");
    if (entityUsesFluidRecipe(entity)) add("液体或气体循环必须精确结算");
    if (entity.sprayCoaterInstalled || (entity.proliferatorPoints ?? 0) > 0 || recordHasPositiveValue(entity.proliferatorBonusProgress as Record<string, unknown>)) {
      add("增产剂状态必须精确结算");
    }
    if (entity.kind === "vein" && entity.minerCount > 0 && state.settings.resourceMode === "finite") {
      add("有限矿脉可能在离线期间枯竭");
    }
    if (entity.fuelItemId || (entity.fuelRemainingMj ?? 0) > 0 || (entity.storedEnergyMj ?? 0) > 0) {
      add("燃料或储能状态可能跨越边界");
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

function key(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function addEntry(snapshot: LedgerSnapshot, entry: Omit<LedgerEntry, "key">, parts: readonly string[]): void {
  if (!Number.isFinite(entry.value)) return;
  const entryKey = key(parts);
  snapshot.entries.set(entryKey, { ...entry, key: entryKey });
}

function itemKeys(...records: Array<Partial<Record<ItemId, number>> | undefined>): ItemId[] {
  return [...new Set(records.flatMap((record) => Object.keys(record ?? {})))].sort() as ItemId[];
}

function createLedgerSnapshot(state: GameState): LedgerSnapshot {
  const snapshot: LedgerSnapshot = { entries: new Map() };
  addEntry(snapshot, {
    kind: "elapsed", value: state.elapsedSeconds, extrapolate: true, integer: false, minimum: 0,
  }, ["elapsed"]);
  addEntry(snapshot, {
    kind: "manual-mined", value: state.manualMined, extrapolate: true, integer: true, minimum: 0,
  }, ["manual-mined"]);
  for (const itemId of itemKeys(state.totalProduced)) {
    addEntry(snapshot, {
      kind: "total-produced", itemId, value: state.totalProduced[itemId] ?? 0,
      extrapolate: true, integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
    }, ["total-produced", itemId]);
  }
  for (const planetId of Object.keys(state.planetTrays).sort() as PlanetId[]) {
    const tray = planetId === state.activePlanetId ? state.tray : state.planetTrays[planetId] ?? {};
    for (const itemId of itemKeys(tray)) {
      addEntry(snapshot, {
        kind: "planet-tray", planetId, itemId, value: tray[itemId] ?? 0,
        extrapolate: true, integer: true, minimum: 0, maximum: getPlanetTrayItemLimit(state, planetId),
      }, ["planet-tray", planetId, itemId]);
    }
  }
  for (const entity of state.entities) {
    for (const itemId of itemKeys(entity.inputs)) {
      addEntry(snapshot, {
        kind: "entity-input", ownerId: entity.id, itemId, value: entity.inputs[itemId] ?? 0,
        extrapolate: true, integer: true, minimum: 0, maximum: getEntityInputCapacity(state, entity),
      }, ["entity-input", entity.id, itemId]);
    }
    for (const itemId of itemKeys(entity.outputs)) {
      addEntry(snapshot, {
        kind: "entity-output", ownerId: entity.id, itemId, value: entity.outputs[itemId] ?? 0,
        extrapolate: true, integer: true, minimum: 0, maximum: getEntityOutputCapacity(state, entity),
      }, ["entity-output", entity.id, itemId]);
    }
    addEntry(snapshot, {
      kind: "entity-progress", ownerId: entity.id, value: entity.progress,
      extrapolate: true, integer: false, minimum: 0, maximum: 1,
    }, ["entity-progress", entity.id]);
    addEntry(snapshot, {
      kind: "entity-utilization", ownerId: entity.id, value: entity.utilization,
      extrapolate: false, integer: false,
    }, ["entity-utilization", entity.id]);
    addEntry(snapshot, {
      kind: "entity-production-rate", ownerId: entity.id, value: entity.productionRate,
      extrapolate: false, integer: false,
    }, ["entity-production-rate", entity.id]);
    addEntry(snapshot, {
      kind: "entity-power-factor", ownerId: entity.id, value: entity.powerFactor ?? 0,
      extrapolate: false, integer: false,
    }, ["entity-power-factor", entity.id]);
    addEntry(snapshot, {
      kind: "entity-power-input", ownerId: entity.id, value: entity.powerInputKw ?? 0,
      extrapolate: false, integer: false,
    }, ["entity-power-input", entity.id]);
    addEntry(snapshot, {
      kind: "entity-power-output", ownerId: entity.id, value: entity.powerOutputKw ?? 0,
      extrapolate: false, integer: false,
    }, ["entity-power-output", entity.id]);
  }
  for (const belt of state.belts) {
    addEntry(snapshot, {
      kind: "belt-progress", ownerId: belt.id, value: belt.progress,
      extrapolate: true, integer: false, minimum: 0, maximum: state.settings.beltBufferLimit,
    }, ["belt-progress", belt.id]);
    addEntry(snapshot, {
      kind: "belt-total-transferred", ownerId: belt.id, value: belt.totalTransferred ?? 0,
      extrapolate: true, integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
    }, ["belt-total-transferred", belt.id]);
    addEntry(snapshot, {
      kind: "belt-congestion", ownerId: belt.id, value: belt.congestion ?? 0,
      extrapolate: false, integer: false,
    }, ["belt-congestion", belt.id]);
    addEntry(snapshot, {
      kind: "belt-last-flow", ownerId: belt.id, value: belt.lastFlow,
      extrapolate: false, integer: false,
    }, ["belt-last-flow", belt.id]);
  }
  return snapshot;
}

function unionLedgerKeys(...snapshots: LedgerSnapshot[]): string[] {
  return [...new Set(snapshots.flatMap((snapshot) => [...snapshot.entries.keys()]))].sort();
}

function entryValue(snapshot: LedgerSnapshot, entryKey: string): number {
  return snapshot.entries.get(entryKey)?.value ?? 0;
}

function createLedgerDelta(before: LedgerSnapshot, after: LedgerSnapshot): Map<string, LedgerDelta> {
  const result = new Map<string, LedgerDelta>();
  for (const entryKey of unionLedgerKeys(before, after)) {
    const entry = after.entries.get(entryKey) ?? before.entries.get(entryKey);
    if (!entry) continue;
    result.set(entryKey, { key: entryKey, entry, amount: entryValue(after, entryKey) - entryValue(before, entryKey) });
  }
  return result;
}

function relativeVariation(left: number, right: number): number {
  const difference = Math.abs(left - right);
  if (difference <= 1e-9) return 0;
  const magnitude = Math.max(Math.abs(left), Math.abs(right));
  if (magnitude < 20) return difference / 20;
  return difference / magnitude;
}

function compareWindows(
  firstBefore: LedgerSnapshot,
  firstAfter: LedgerSnapshot,
  secondAfter: LedgerSnapshot,
): StabilityResult {
  const first = createLedgerDelta(firstBefore, firstAfter);
  const second = createLedgerDelta(firstAfter, secondAfter);
  let maximumVariation = 0;
  for (const entryKey of [...new Set([...first.keys(), ...second.keys()])].sort()) {
    const firstDelta = first.get(entryKey);
    const secondDelta = second.get(entryKey);
    const entry = secondDelta?.entry ?? firstDelta?.entry;
    if (!entry) continue;
    const variation = entry.extrapolate
      ? relativeVariation(firstDelta?.amount ?? 0, secondDelta?.amount ?? 0)
      : relativeVariation(entryValue(firstAfter, entryKey), entryValue(secondAfter, entryKey));
    maximumVariation = Math.max(maximumVariation, variation);
    if (variation > RATE_STABILITY_LIMIT + 1e-12) {
      return {
        stable: false,
        maximumVariation,
        reason: `连续校准窗口变化 ${(variation * 100).toFixed(2)}%，超过 5% 安全阈值`,
      };
    }
  }
  return { stable: true, maximumVariation };
}

function compareExpectedWindow(expected: Map<string, LedgerDelta>, before: LedgerSnapshot, after: LedgerSnapshot): StabilityResult {
  const actual = createLedgerDelta(before, after);
  let maximumVariation = 0;
  for (const entryKey of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    const expectedDelta = expected.get(entryKey);
    const actualDelta = actual.get(entryKey);
    const entry = actualDelta?.entry ?? expectedDelta?.entry;
    if (!entry) continue;
    const variation = entry.extrapolate
      ? relativeVariation(expectedDelta?.amount ?? 0, actualDelta?.amount ?? 0)
      : relativeVariation(expectedDelta?.entry.value ?? 0, actualDelta?.entry.value ?? 0);
    maximumVariation = Math.max(maximumVariation, variation);
    if (variation > RATE_STABILITY_LIMIT + 1e-12) {
      return {
        stable: false,
        maximumVariation,
        reason: `宏观窗口后的实测速率偏移 ${(variation * 100).toFixed(2)}%`,
      };
    }
  }
  return { stable: true, maximumVariation };
}

function ignoredGuardPath(path: readonly string[]): boolean {
  if (path.length === 0) return false;
  if (["elapsedSeconds", "manualMined", "totalProduced", "tray", "planetTrays", "metrics", "planetMetrics", "powerGridMetrics", "productionHistory", "historyRecordedAt", "achievements", "campaign"].includes(path[0])) {
    return true;
  }
  if (path[0] === "entities" && path.length >= 3) {
    return ["inputs", "outputs", "progress", "utilization", "productionRate", "powerFactor", "powerInputKw", "powerOutputKw", "proliferatorBonusProgress"].includes(path[2]);
  }
  if (path[0] === "belts" && path.length >= 3) {
    return ["progress", "totalTransferred", "congestion", "lastFlow", "recentFlowSampleSeconds", "recentFlowTransferred", "recentFlowSampling"].includes(path[2]);
  }
  if (path[0] === "endgame" && ["exportedLastMinute", "exportWindowAmount", "exportWindowStartedAt"].includes(path[1] ?? "")) {
    return true;
  }
  return false;
}

function guardFingerprint(value: unknown): string {
  let hash = 0x811c9dc5;
  const append = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  const visit = (current: unknown, path: string[]) => {
    if (ignoredGuardPath(path)) {
      append("ignored");
      return;
    }
    if (current === null || typeof current !== "object") {
      append(`${typeof current}:${String(current)}`);
      return;
    }
    if (Array.isArray(current)) {
      append(`[${current.length}`);
      current.forEach((entry, index) => visit(entry, [...path, String(index)]));
      append("]");
      return;
    }
    const record = current as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    append(`{${keys.length}`);
    for (const childKey of keys) {
      append(childKey);
      visit(record[childKey], [...path, childKey]);
    }
    append("}");
  };
  visit(value, []);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function firstGuardDifference(left: unknown, right: unknown, path: string[] = []): string | null {
  if (ignoredGuardPath(path)) return null;
  if (Object.is(left, right)) return null;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return path.join(".") || "state";
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return path.join(".") || "state";
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstGuardDifference(left[index], right[index], [...path, String(index)]);
      if (difference) return difference;
    }
    return null;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const childKey of keys) {
    const difference = firstGuardDifference(leftRecord[childKey], rightRecord[childKey], [...path, childKey]);
    if (difference) return difference;
  }
  return null;
}

function validateMovingBufferMargins(snapshot: LedgerSnapshot, delta: Map<string, LedgerDelta>): string | null {
  for (const { key: entryKey, entry, amount } of delta.values()) {
    const boundedBuffer = entry.kind === "planet-tray" || entry.kind === "entity-input" || entry.kind === "entity-output" ||
      entry.kind === "entity-progress" || entry.kind === "belt-progress";
    const unchangedThreshold = entry.integer ? 1e-9 : 1e-6;
    if (!boundedBuffer || !entry.extrapolate || Math.abs(amount) <= unchangedThreshold || entry.minimum === undefined || entry.maximum === undefined || !Number.isFinite(entry.maximum)) continue;
    const value = entryValue(snapshot, entryKey);
    const span = Math.max(1, entry.maximum - entry.minimum);
    const margin = Math.max(entry.integer ? 1 : 1e-6, span * 0.01);
    if (value <= entry.minimum + margin || value >= entry.maximum - margin) {
      return `活动缓存已接近满仓或空仓边界：${entryKey} value=${value} delta=${amount}`;
    }
  }
  return null;
}

function maximumSafeMacroSeconds(snapshot: LedgerSnapshot, delta: Map<string, LedgerDelta>, windowSeconds: number): number {
  let maximum = Number.MAX_SAFE_INTEGER;
  for (const { key: entryKey, entry, amount } of delta.values()) {
    const unchangedThreshold = entry.integer ? 1e-9 : 1e-6;
    if (!entry.extrapolate || Math.abs(amount) <= unchangedThreshold || entry.minimum === undefined || entry.maximum === undefined) continue;
    const value = entryValue(snapshot, entryKey);
    const span = Math.max(1, entry.maximum - entry.minimum);
    const margin = Math.max(entry.integer ? 1 : 1e-6, span * 0.001);
    const rate = amount / windowSeconds;
    const seconds = rate > 0
      ? (entry.maximum - margin - value) / rate
      : (value - entry.minimum - margin) / -rate;
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    maximum = Math.min(maximum, Math.floor(seconds));
  }
  return Math.max(0, maximum);
}

function setLedgerValue(
  state: GameState,
  entry: LedgerEntry,
  value: number,
  entityById: Map<string, FactoryEntity>,
  beltById: Map<string, BeltConnection>,
): boolean {
  if (!Number.isFinite(value) || value < (entry.minimum ?? -Number.MAX_VALUE) - 1e-6 || value > (entry.maximum ?? Number.MAX_VALUE) + 1e-6) return false;
  if (entry.integer && (!Number.isSafeInteger(value) || value < 0)) return false;
  if (entry.kind === "elapsed") state.elapsedSeconds = value;
  else if (entry.kind === "manual-mined") state.manualMined = value;
  else if (entry.kind === "total-produced" && entry.itemId) state.totalProduced[entry.itemId] = value;
  else if (entry.kind === "planet-tray" && entry.planetId && entry.itemId) {
    const tray = entry.planetId === state.activePlanetId ? state.tray : (state.planetTrays[entry.planetId] ??= {});
    tray[entry.itemId] = value;
    if (entry.planetId === state.activePlanetId) state.planetTrays[entry.planetId] = { ...state.tray };
  } else if ((entry.kind === "entity-input" || entry.kind === "entity-output") && entry.ownerId && entry.itemId) {
    const entity = entityById.get(entry.ownerId);
    if (!entity) return false;
    (entry.kind === "entity-input" ? entity.inputs : entity.outputs)[entry.itemId] = value;
  } else if (entry.ownerId && entry.kind.startsWith("entity-")) {
    const entity = entityById.get(entry.ownerId);
    if (!entity) return false;
    if (entry.kind === "entity-progress") entity.progress = value;
    else if (entry.kind === "entity-utilization") entity.utilization = value;
    else if (entry.kind === "entity-production-rate") entity.productionRate = value;
    else if (entry.kind === "entity-power-factor") entity.powerFactor = value;
    else if (entry.kind === "entity-power-input") entity.powerInputKw = value;
    else if (entry.kind === "entity-power-output") entity.powerOutputKw = value;
  } else if (entry.ownerId && entry.kind.startsWith("belt-")) {
    const belt = beltById.get(entry.ownerId);
    if (!belt) return false;
    if (entry.kind === "belt-progress") belt.progress = value;
    else if (entry.kind === "belt-total-transferred") belt.totalTransferred = value;
    else if (entry.kind === "belt-congestion") belt.congestion = value;
    else if (entry.kind === "belt-last-flow") belt.lastFlow = value;
  }
  return true;
}

function inventoryTotals(state: GameState): Map<ItemId, number> {
  const totals = new Map<ItemId, number>();
  const add = (record: Partial<Record<ItemId, number>>) => {
    for (const [itemId, value] of Object.entries(record)) {
      totals.set(itemId as ItemId, (totals.get(itemId as ItemId) ?? 0) + Math.floor(value ?? 0));
    }
  };
  add(state.tray);
  for (const [planetId, tray] of Object.entries(state.planetTrays)) {
    if (planetId !== state.activePlanetId) add(tray);
  }
  for (const entity of state.entities) {
    add(entity.inputs);
    add(entity.outputs);
  }
  return totals;
}

function applyMacroWindow(
  source: GameState,
  reference: GameState,
  delta: Map<string, LedgerDelta>,
  seconds: number,
  windowSeconds: number,
  remainders: Map<string, bigint>,
): MacroApplyResult {
  const state = structuredClone(source);
  const sourceLedger = createLedgerSnapshot(source);
  const beforeInventory = inventoryTotals(source);
  const expectedInventoryDelta = new Map<ItemId, number>();
  const entityById = new Map(state.entities.map((entity) => [entity.id, entity]));
  const beltById = new Map(state.belts.map((belt) => [belt.id, belt]));
  const durationUnits = BigInt(Math.round(seconds * Number(DURATION_SCALE)));
  const windowUnits = BigInt(Math.round(windowSeconds * Number(DURATION_SCALE)));
  if (durationUnits <= 0n || windowUnits <= 0n) return { conservationVerified: false, reason: "宏观窗口长度无效" };

  for (const entryKey of [...delta.keys()].sort()) {
    const change = delta.get(entryKey)!;
    const current = entryValue(sourceLedger, entryKey);
    if (!change.entry.extrapolate) {
      if (!setLedgerValue(state, change.entry, change.entry.value, entityById, beltById)) {
        return { conservationVerified: false, reason: "无法恢复宏观窗口诊断字段" };
      }
      continue;
    }
    const scale = change.entry.integer ? 1n : FIXED_POINT_SCALE;
    const deltaScaled = BigInt(Math.round(change.amount * Number(scale)));
    const numerator = deltaScaled * durationUnits + (remainders.get(entryKey) ?? 0n);
    const appliedScaled = numerator / windowUnits;
    remainders.set(entryKey, numerator % windowUnits);
    const next = current + Number(appliedScaled) / Number(scale);
    if (!setLedgerValue(state, change.entry, next, entityById, beltById)) {
      return { conservationVerified: false, reason: "宏观窗口将库存推过安全整数或缓存边界" };
    }
    if ((change.entry.kind === "planet-tray" || change.entry.kind === "entity-input" || change.entry.kind === "entity-output") && change.entry.itemId) {
      expectedInventoryDelta.set(
        change.entry.itemId,
        (expectedInventoryDelta.get(change.entry.itemId) ?? 0) + next - current,
      );
    }
  }
  state.metrics = structuredClone(reference.metrics);
  state.planetMetrics = structuredClone(reference.planetMetrics);
  state.powerGridMetrics = structuredClone(reference.powerGridMetrics);

  const afterInventory = inventoryTotals(state);
  for (const itemId of [...new Set([...beforeInventory.keys(), ...afterInventory.keys()])]) {
    const before = beforeInventory.get(itemId) ?? 0;
    const after = afterInventory.get(itemId) ?? 0;
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || before < 0 || after < 0) {
      return { conservationVerified: false, reason: "物资守恒检查发现负数或非安全整数" };
    }
    if (after - before !== (expectedInventoryDelta.get(itemId) ?? 0)) {
      return { conservationVerified: false, reason: `物资守恒检查发现 ${itemId} 的宏观账本不一致` };
    }
  }
  return { state, conservationVerified: true };
}

function validateStateQuantities(state: GameState): string | null {
  const check = (label: string, record: Partial<Record<ItemId, number>>) => {
    for (const [itemId, value] of Object.entries(record)) {
      if (!Number.isSafeInteger(value) || (value ?? 0) < 0) return `${label}.${itemId} 不是非负安全整数`;
    }
    return null;
  };
  let issue = check("tray", state.tray) ?? check("totalProduced", state.totalProduced);
  if (issue) return issue;
  for (const [planetId, tray] of Object.entries(state.planetTrays)) {
    issue = check(`planetTrays.${planetId}`, tray);
    if (issue) return issue;
  }
  for (const entity of state.entities) {
    issue = check(`entities.${entity.id}.inputs`, entity.inputs) ?? check(`entities.${entity.id}.outputs`, entity.outputs);
    if (issue) return issue;
  }
  for (const belt of state.belts) {
    if (belt.totalTransferred !== undefined && (!Number.isSafeInteger(belt.totalTransferred) || belt.totalTransferred < 0)) {
      return `belts.${belt.id}.totalTransferred 不是非负安全整数`;
    }
  }
  return null;
}

function projectInactiveExportWindowStart(state: GameState, seconds: number): number {
  const stepSize = seconds >= 24 * 60 * 60 ? 30 : seconds > 8 * 60 * 60 ? 10 : 1;
  let elapsed = state.elapsedSeconds;
  let startedAt = state.endgame.exportWindowStartedAt;
  let remaining = seconds;
  while (remaining > 1e-9) {
    const step = Math.min(stepSize, remaining);
    elapsed = Math.round((elapsed + step) * 10_000) / 10_000;
    if (startedAt <= 0) startedAt = elapsed;
    if (elapsed - startedAt >= 10 - 0.0001) startedAt = elapsed;
    remaining = Math.max(0, remaining - step);
  }
  return startedAt;
}

async function advanceExactState(state: GameState, seconds: number, options: ExactAdvanceOptions): Promise<GameState> {
  const session = createSimulationAdvanceSession(state, seconds);
  while (session.remainingSeconds > 1e-9 || session.remainingWallSeconds > 1e-9) {
    if (options.shouldCancel()) throw abortError();
    const chunkStartedAt = now();
    do {
      const event = getNextOfflineCriticalEvent(session.state, session.remainingSeconds, 256);
      advanceSimulationSession(session, event?.seconds ?? 256);
      if (options.shouldCancel()) throw abortError();
    } while ((session.remainingSeconds > 1e-9 || session.remainingWallSeconds > 1e-9) && now() - chunkStartedAt < 50);
    const localCompleted = session.totalSeconds - session.remainingSeconds;
    options.onMessage();
    options.onProgress?.({
      phase: options.phase,
      completedSeconds: Math.min(options.totalSeconds, options.completedBefore + localCompleted),
      totalSeconds: options.totalSeconds,
      progress: options.totalSeconds > 0 ? Math.min(1, (options.completedBefore + localCompleted) / options.totalSeconds) : 1,
      approximateSeconds: options.approximateSeconds,
      estimatedError: options.estimatedError,
    });
    await options.yieldControl();
  }
  if (options.shouldCancel()) throw abortError();
  return options.complete ? completeSimulationAdvanceSession(session) : session.state;
}

function createDiagnostics(
  calculationMs: number,
  overrides: Partial<OfflineSettlementDiagnostics>,
): OfflineSettlementDiagnostics {
  return {
    mode: "exact",
    calibrationWindowSeconds: 0,
    approximateSeconds: 0,
    attemptedApproximateSeconds: 0,
    exactSeconds: 0,
    maximumEstimatedError: 0,
    fellBack: false,
    calculationMs,
    incomplete: false,
    conservationVerified: true,
    softTimeoutExceeded: false,
    workerMessageCount: 0,
    ...overrides,
  };
}

export async function runExactOfflineSettlement(
  state: GameState,
  seconds: number,
  options: ApproximateOfflineSettlementOptions = {},
): Promise<ApproximateOfflineSettlementResult> {
  const startedAt = now();
  const duration = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const shouldCancel = options.shouldCancel ?? (() => false);
  const yieldControl = options.yieldControl ?? (() => Promise.resolve());
  let workerMessageCount = 0;
  const result = await advanceExactState(state, duration, {
    phase: "exact",
    totalSeconds: duration,
    completedBefore: 0,
    approximateSeconds: 0,
    estimatedError: 0,
    complete: true,
    shouldCancel,
    onProgress: options.onProgress,
    yieldControl,
    onMessage: () => { workerMessageCount += 1; },
  });
  const calculationMs = Math.max(0, now() - startedAt);
  return {
    state: result,
    diagnostics: createDiagnostics(calculationMs, {
      exactSeconds: duration,
      workerMessageCount,
      softTimeoutExceeded: calculationMs > (options.softTimeoutMs ?? 30_000),
    }),
  };
}

export async function runApproximateOfflineSettlement(
  state: GameState,
  seconds: number,
  options: ApproximateOfflineSettlementOptions = {},
): Promise<ApproximateOfflineSettlementResult> {
  const startedAt = now();
  const duration = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const calibrationWindowSeconds = Math.max(5, Math.min(10, Math.floor(options.calibrationWindowSeconds ?? DEFAULT_CALIBRATION_WINDOW_SECONDS)));
  const shouldCancel = options.shouldCancel ?? (() => false);
  const yieldControl = options.yieldControl ?? (() => Promise.resolve());
  const softTimeoutMs = options.softTimeoutMs ?? 30_000;
  let workerMessageCount = 0;
  let exactSeconds = 0;
  let approximateSeconds = 0;
  let attemptedApproximateSeconds = 0;
  let maximumEstimatedError = 0;
  let conservationVerified = true;
  const onMessage = () => { workerMessageCount += 1; };
  const emit = (phase: OfflineSettlementPhase, completedSeconds: number) => {
    workerMessageCount += 1;
    options.onProgress?.({
      phase,
      completedSeconds: Math.min(duration, completedSeconds),
      totalSeconds: duration,
      progress: duration > 0 ? Math.min(1, completedSeconds / duration) : 1,
      approximateSeconds,
      estimatedError: maximumEstimatedError,
    });
  };
  const exactFallback = async (reason: string): Promise<ApproximateOfflineSettlementResult> => {
    emit("fallback-exact", 0);
    const fallback = await advanceExactState(state, duration, {
      phase: "fallback-exact",
      totalSeconds: duration,
      completedBefore: 0,
      approximateSeconds: 0,
      estimatedError: maximumEstimatedError,
      complete: true,
      shouldCancel,
      onProgress: options.onProgress,
      yieldControl,
      onMessage,
    });
    const fallbackQuantityIssue = validateStateQuantities(fallback);
    if (fallbackQuantityIssue) throw new Error(`精确回退结果未通过数量检查：${fallbackQuantityIssue}`);
    const calculationMs = Math.max(0, now() - startedAt);
    return {
      state: fallback,
      diagnostics: createDiagnostics(calculationMs, {
        calibrationWindowSeconds,
        attemptedApproximateSeconds,
        exactSeconds: duration + exactSeconds,
        maximumEstimatedError,
        fellBack: true,
        fallbackReason: reason,
        conservationVerified: true,
        softTimeoutExceeded: calculationMs > softTimeoutMs,
        workerMessageCount,
      }),
    };
  };

  if (shouldCancel()) throw abortError();
  emit("preflight", 0);
  const eligibility = inspectApproximateOfflineEligibility(state);
  if (!eligibility.eligible) return exactFallback(eligibility.reasons[0] ?? "未通过近似结算安全检查");
  if (duration < Math.max(MINIMUM_APPROXIMATE_INTERVAL_SECONDS, calibrationWindowSeconds * 3)) {
    return exactFallback("离线时长过短，精确结算更快且无近似误差");
  }

  // createSimulationAdvanceSession already isolates its working state. Keeping
  // another full clone here would add one terminal-save-sized allocation.
  const state0 = state;
  const state1 = await advanceExactState(state0, calibrationWindowSeconds, {
    phase: "calibration",
    totalSeconds: duration,
    completedBefore: 0,
    approximateSeconds,
    estimatedError: 0,
    complete: false,
    shouldCancel,
    onProgress: options.onProgress,
    yieldControl,
    onMessage,
  });
  exactSeconds += calibrationWindowSeconds;
  const state2 = await advanceExactState(state1, calibrationWindowSeconds, {
    phase: "calibration",
    totalSeconds: duration,
    completedBefore: calibrationWindowSeconds,
    approximateSeconds,
    estimatedError: 0,
    complete: false,
    shouldCancel,
    onProgress: options.onProgress,
    yieldControl,
    onMessage,
  });
  exactSeconds += calibrationWindowSeconds;
  const fingerprint1 = guardFingerprint(state1);
  const fingerprint2 = guardFingerprint(state2);
  if (fingerprint1 !== fingerprint2) {
    const changedPath = firstGuardDifference(state1, state2);
    return exactFallback(`校准期间出现非白名单状态变化${changedPath ? `：${changedPath}` : ""}`);
  }

  let previousLedger = createLedgerSnapshot(state0);
  let currentLedger = createLedgerSnapshot(state1);
  let nextLedger = createLedgerSnapshot(state2);
  let stability = compareWindows(previousLedger, currentLedger, nextLedger);
  maximumEstimatedError = Math.max(maximumEstimatedError, stability.maximumVariation);
  if (!stability.stable) return exactFallback(stability.reason ?? "连续校准窗口不稳定");
  let rate = createLedgerDelta(currentLedger, nextLedger);
  const bufferIssue = validateMovingBufferMargins(nextLedger, rate);
  if (bufferIssue) return exactFallback(bufferIssue);
  if (maximumEstimatedError > HARD_ESTIMATED_ERROR_LIMIT) return exactFallback("估计误差超过 20% 强制上限");

  let current = state2;
  let completedSeconds = calibrationWindowSeconds * 2;
  const remainders = new Map<string, bigint>();
  while (completedSeconds < duration - 1e-9) {
    if (shouldCancel()) throw abortError();
    const remaining = duration - completedSeconds;
    if (remaining <= calibrationWindowSeconds + 1e-9) {
      current = await advanceExactState(current, remaining, {
        phase: "verification",
        totalSeconds: duration,
        completedBefore: completedSeconds,
        approximateSeconds,
        estimatedError: maximumEstimatedError,
        complete: true,
        shouldCancel,
        onProgress: options.onProgress,
        yieldControl,
        onMessage,
      });
      exactSeconds += remaining;
      completedSeconds = duration;
      break;
    }

    const safeSeconds = maximumSafeMacroSeconds(nextLedger, rate, calibrationWindowSeconds);
    const macroSeconds = Math.floor(Math.min(remaining - calibrationWindowSeconds, safeSeconds));
    if (macroSeconds < MINIMUM_APPROXIMATE_INTERVAL_SECONDS) {
      current = await advanceExactState(current, remaining, {
        phase: "exact",
        totalSeconds: duration,
        completedBefore: completedSeconds,
        approximateSeconds,
        estimatedError: maximumEstimatedError,
        complete: true,
        shouldCancel,
        onProgress: options.onProgress,
        yieldControl,
        onMessage,
      });
      exactSeconds += remaining;
      completedSeconds = duration;
      break;
    }

    attemptedApproximateSeconds += macroSeconds;
    const macro = applyMacroWindow(current, current, rate, macroSeconds, calibrationWindowSeconds, remainders);
    conservationVerified = conservationVerified && macro.conservationVerified;
    if (!macro.state || !macro.conservationVerified) return exactFallback(macro.reason ?? "宏观账本未通过物资守恒检查");
    current = macro.state;
    approximateSeconds += macroSeconds;
    completedSeconds += macroSeconds;
    emit("macro", completedSeconds);
    await yieldControl();

    const beforeVerification = current;
    const beforeVerificationFingerprint = guardFingerprint(beforeVerification);
    const verificationSeconds = Math.min(calibrationWindowSeconds, duration - completedSeconds);
    const finishes = completedSeconds + verificationSeconds >= duration - 1e-9;
    const verified = await advanceExactState(beforeVerification, verificationSeconds, {
      phase: "verification",
      totalSeconds: duration,
      completedBefore: completedSeconds,
      approximateSeconds,
      estimatedError: maximumEstimatedError,
      complete: finishes,
      shouldCancel,
      onProgress: options.onProgress,
      yieldControl,
      onMessage,
    });
    exactSeconds += verificationSeconds;
    completedSeconds += verificationSeconds;
    const verifiedLedger = createLedgerSnapshot(verified);
    if (!finishes && beforeVerificationFingerprint !== guardFingerprint(verified)) {
      const changedPath = firstGuardDifference(beforeVerification, verified);
      return exactFallback(`宏观窗口后的精确复核发现非白名单状态变化${changedPath ? `：${changedPath}` : ""}`);
    }
    stability = compareExpectedWindow(rate, createLedgerSnapshot(beforeVerification), verifiedLedger);
    maximumEstimatedError = Math.max(maximumEstimatedError, stability.maximumVariation);
    if (!stability.stable || maximumEstimatedError > ESTIMATED_ERROR_LIMIT) {
      return exactFallback(stability.reason ?? "最大估计误差超过 10% 正常目标");
    }
    const quantityIssue = validateStateQuantities(verified);
    if (quantityIssue) {
      conservationVerified = false;
      return exactFallback(quantityIssue);
    }
    current = verified;
    if (finishes) break;
    previousLedger = nextLedger;
    currentLedger = createLedgerSnapshot(beforeVerification);
    nextLedger = verifiedLedger;
    rate = createLedgerDelta(currentLedger, nextLedger);
    const nextBufferIssue = validateMovingBufferMargins(nextLedger, rate);
    if (nextBufferIssue) return exactFallback(nextBufferIssue);
  }

  const finalIssue = validateStateQuantities(current);
  if (finalIssue) {
    conservationVerified = false;
    return exactFallback(finalIssue);
  }
  current.endgame.exportWindowStartedAt = projectInactiveExportWindowStart(state, duration);
  current.endgame.exportWindowAmount = 0;
  current.endgame.exportedLastMinute = 0;
  const calculationMs = Math.max(0, now() - startedAt);
  return {
    state: current,
    diagnostics: createDiagnostics(calculationMs, {
      mode: approximateSeconds > 0 ? "approximate" : "exact",
      calibrationWindowSeconds,
      approximateSeconds,
      attemptedApproximateSeconds,
      exactSeconds,
      maximumEstimatedError,
      conservationVerified,
      softTimeoutExceeded: calculationMs > softTimeoutMs,
      workerMessageCount,
    }),
  };
}
