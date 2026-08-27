import { getRecipe, ITEMS, MATRIX_ITEM_IDS } from "./content";
import { GALACTIC_EXPORT_DEFINITIONS } from "./endgame";
import {
  advanceConstructionAutomationMacroInPlace,
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createSimulationAdvanceSession,
  getEntityInputCapacity,
  getEntityOutputCapacity,
  hasActiveResearch,
  normalizeConstructionAutomationCursor,
  refreshDysonGenerationSnapshot,
  getResourceReserveSnapshot,
  getVeinConsumptionMultiplier,
  type SimulationAdvanceSession,
} from "./engine";
import type { FactoryEntity, GameState, ItemId } from "./types";
import {
  advanceResearchMacroInPlace,
  captureResearchMacroCalibrationSnapshot,
  createResearchMacroLedger,
  createResearchMacroLedgerFromSnapshots,
  type ResearchMacroLedger,
} from "./researchMacro";
import { FAST_OFFLINE_CALIBRATION_SECONDS } from "./offlineSettlementConstants";

export { FAST_OFFLINE_CALIBRATION_SECONDS } from "./offlineSettlementConstants";

/**
 * This flag is deliberately a device preference.  It is not part of
 * GameState, save envelopes, cloud payloads, or leaderboard inputs.
 */
export const OFFLINE_APPROXIMATION_KEY = "dsp-idle-network.experimental-approximate-offline.v1";
/** 1.0.30 enables the guarded fast path for new devices; users can opt out. */
export const OFFLINE_APPROXIMATION_DEFAULT_ENABLED = true;

export type OfflineApproximationMode = "exact" | "approximate";

export interface OfflineApproximationReport {
  mode: OfflineApproximationMode;
  calibrationWindowSeconds: number;
  approximatedSeconds: number;
  maxEstimatedError: number;
  fellBack: boolean;
  fallbackReason?: string;
  /** Diagnostic-only algorithm identity; never persisted in GameState. */
  algorithmVersion?: string;
  /** Number of non-fatal inventory/capacity corrections applied to the copy. */
  boundaryCorrections?: number;
  /** Fast mode validates leaderboard-facing outcomes separately from ordinary cache drift. */
  validationScope?: "all-state" | "leaderboard-critical";
  /** Diagnostic only; ordinary inventory/cache drift does not reject fast-30s-v1. */
  maxNonCriticalError?: number;
  /** Explicit v2 completion semantics; fallback no longer implies unbounded replay. */
  settlementStatus?: "approximate" | "conservative" | "conservative-preview" | "conservative-skipped" | "bounded-exact" | "invalid-source" | "cancelled" | "failed";
  /** Real Worker computation time, separate from simulated duration. */
  wallClockMs?: number;
  /** True when the real-time calibration budget forced a conservative result. */
  deadlineReached?: boolean;
  researchInvested?: string;
}

export type OfflineApproximationResult =
  | { status: "approximate"; state: GameState; report: OfflineApproximationReport }
  | { status: "conservative"; state: GameState; report: OfflineApproximationReport }
  | { status: "bounded-exact"; state: GameState; report: OfflineApproximationReport }
  | { status: "invalid-source"; report: OfflineApproximationReport }
  | { status: "cancelled"; report: OfflineApproximationReport }
  | { status: "fallback"; report: OfflineApproximationReport }
  | { status: "ineligible"; report: OfflineApproximationReport };

export type TimeWarpComputationMode = "exact" | "approximate";

export interface TimeWarpApproximationReport {
  mode: TimeWarpComputationMode;
  algorithmVersion: string;
  requestedSimulationSeconds: number;
  exactCalibrationSeconds: number;
  approximatedSeconds: number;
  maxCriticalError: number;
  boundaryCorrections: number;
  fallbackReason?: string;
}

export interface TimeWarpApproximationResult {
  state: GameState;
  report: TimeWarpApproximationReport;
}

interface NumericMap {
  [key: string]: number;
}

interface EntityProjection {
  inputs: NumericMap;
  outputs: NumericMap;
  progress: number;
  productionRate: number;
  utilization: number;
  powerFactor?: number;
}

interface BeltProjection {
  progress: number;
  totalTransferred: number;
  lastFlow: number;
  congestion: number;
}

interface MacroProjection {
  elapsedSeconds: number;
  totalProduced: NumericMap;
  entities: Record<string, EntityProjection>;
  belts: Record<string, BeltProjection>;
}

interface MacroRates {
  totalProduced: NumericMap;
  entities: Record<string, EntityProjection>;
  belts: Record<string, BeltProjection>;
}

type AffinePath = Array<string | number>;
type AffineEntry =
  | { kind: "number"; value: number; integer: boolean }
  | { kind: "decimal"; value: bigint }
  | { kind: "struct"; value: string | boolean | null };

interface AffineSnapshot {
  entries: Map<string, AffineEntry>;
  paths: Map<string, AffinePath>;
}

interface AffineDelta {
  path: AffinePath;
  kind: "number" | "decimal";
  delta: number | bigint;
  integer?: boolean;
}

interface AffineContract {
  deltas: AffineDelta[];
  baseline: AffineSnapshot;
  windowSeconds: number;
  validationSeconds: number;
}

const EPSILON = 1e-6;
const STABILITY_TOLERANCE = 0.05;
const MAX_ERROR = 0.20;
// The product owner explicitly accepts up to 100% numerical drift for the
// fast path. Structural validity remains a hard gate; ordinary cache drift is
// diagnostic, while leaderboard-facing Dyson/white-matrix outcomes are tail
// checked against this separate ceiling.
const FAST_CRITICAL_MAX_ERROR = 1;
const MIN_APPROXIMATION_SECONDS = 60;
const MIN_CALIBRATION_SECONDS = 5;
const MAX_CALIBRATION_SECONDS = 10;
const VALIDATION_SECONDS = 5;
/** The fast offline contract deliberately spends exactly thirty simulation seconds on calibration. */
const FAST_OFFLINE_CALIBRATION_SLICE_SECONDS = 10;
const FAST_OFFLINE_VALIDATION_SECONDS = 5;
/** Bounded exact preview used only when no valid calibration candidate exists. */
export const FAST_OFFLINE_CONSERVATIVE_PREFIX_SECONDS = 1;
export const FAST_OFFLINE_ALGORITHM_VERSION = "fast-30s-v3-lite";
export const FAST_OFFLINE_DESKTOP_DEADLINE_MS = 30_000;
export const FAST_OFFLINE_MOBILE_DEADLINE_MS = 60_000;
export const TIME_WARP_APPROXIMATION_ALGORITHM_VERSION = "time-warp-lightweight-v4";
// Realtime slices already repeat continuously. Two independent half-second
// checkpoints retain a real exact tail verifier while halving the per-slice
// endgame cost versus the historical 1s + 1s pair.
export const TIME_WARP_APPROXIMATION_CALIBRATION_SECONDS = 0.5;
export const TIME_WARP_APPROXIMATION_VALIDATION_SECONDS = 0.5;
const TIME_WARP_MAX_CRITICAL_ERROR = 1;
const AFFINE_DECIMAL_KEYS = new Set([
  "cargo", "remainingCargo", "totalDestroyed", "warpers", "warperTarget",
]);
const AFFINE_DECIMAL_CONTAINERS = new Set([
  "inventory", "delivered", "constructionBuffer", "planetTrays", "tray",
]);
const AFFINE_DYNAMIC_MAP_KEYS = new Set([
  "inputs", "outputs", "totalProduced", "inventory", "planetTrays", "tray",
  "uploaded", "downloaded", "progressByTech", "absorptionProgressBySystem",
]);
const AFFINE_IGNORED_KEYS = new Set([
  // These are diagnostics/history snapshots, not simulation inputs. They are
  // regenerated by the normal completion boundary after an exact validation.
  "productionHistory", "metrics", "planetMetrics", "powerGridMetrics", "runtimeFlow",
  "exportWindowStartedAt", "exportWindowAmount", "exportedLastMinute", "historyRecordedAt",
  // These values describe the latest settled step or a cyclic phase. They
  // must remain at the second calibration window's baseline rather than being
  // extrapolated as an unbounded affine counter.
  "progress", "lastFlow", "congestion", "productionRate", "utilization", "powerFactor",
  // Cyclic/runtime diagnostics are refreshed by the exact validation tail;
  // treating them as cumulative rates would amplify a phase offset into a
  // false 20% failure.
  "decayProgress", "stationLastTransfer", "proliferatorPoints", "proliferatorBonusProgress", "fuelGenerationKw", "generationKw",
  "recentFlowSampleSeconds", "recentFlowTransferred",
  "cursor", "routingCursor", "routingCursors", "uploadRoutingCursors", "stationDispatchCursor",
  "phaseIndex", "stepIndex", "dispatchProgress", "absorptionProgress", "activityClockMs",
  // In-flight cargo and the player's held stack are transient ownership
  // records. Extrapolating either value as an unbounded rate can create
  // negative routes or duplicate material when a trip crosses its arrival
  // boundary. Only the exact engine may mutate these fields.
  "cargo", "remainingCargo",
  // Research is a discrete cost/reward ledger. Generic affine deltas must
  // never write progress, levels, queue selection, rewards, or score.
  "research", "infiniteResearch", "activeInfiniteResearchId", "galacticScore",
  // Contract completion and launch-energy diagnostics are discrete subsystem
  // results. Material delivery is guarded separately; these counters are
  // never independently extrapolated from a sampled prefix.
  "completedContracts", "launchEnergySpentMj", "orbitalCargoTotalUploaded",
]);

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pathKey(path: AffinePath): string {
  return JSON.stringify(path);
}

function isIgnoredAffinePath(path: AffinePath): boolean {
  return path.some((part) => typeof part === "string" && AFFINE_IGNORED_KEYS.has(part));
}

function isDecimalAffinePath(path: AffinePath): boolean {
  const last = path.at(-1);
  return (typeof last === "string" && AFFINE_DECIMAL_KEYS.has(last)) ||
    path.some((part) => typeof part === "string" && AFFINE_DECIMAL_CONTAINERS.has(part));
}

function captureAffineSnapshot(value: unknown, path: AffinePath = [], snapshot: AffineSnapshot = {
  entries: new Map(),
  paths: new Map(),
}): AffineSnapshot {
  if (isIgnoredAffinePath(path)) return snapshot;
  const key = pathKey(path);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      snapshot.entries.set(key, { kind: "struct", value: null });
    } else {
      snapshot.entries.set(key, { kind: "number", value, integer: Number.isSafeInteger(value) });
    }
    snapshot.paths.set(key, path);
    return snapshot;
  }
  if (typeof value === "string") {
    if (isDecimalAffinePath(path) && /^\d+$/.test(value)) {
      try {
        snapshot.entries.set(key, { kind: "decimal", value: BigInt(value) });
      } catch {
        snapshot.entries.set(key, { kind: "struct", value });
      }
    } else {
      snapshot.entries.set(key, { kind: "struct", value });
    }
    snapshot.paths.set(key, path);
    return snapshot;
  }
  if (typeof value === "boolean" || value === null || value === undefined) {
    if (value !== undefined) {
      snapshot.entries.set(key, { kind: "struct", value: value === null ? null : value });
      snapshot.paths.set(key, path);
    }
    return snapshot;
  }
  if (Array.isArray(value)) {
    snapshot.entries.set(key, { kind: "struct", value: `array:${value.length}` });
    snapshot.paths.set(key, path);
    value.forEach((child, index) => captureAffineSnapshot(child, [...path, index], snapshot));
    return snapshot;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    const dynamicMap = path.at(-1);
    snapshot.entries.set(key, {
      kind: "struct",
      value: typeof dynamicMap === "string" && AFFINE_DYNAMIC_MAP_KEYS.has(dynamicMap)
        ? "map"
        : `object:${keys.join(",")}`,
    });
    snapshot.paths.set(key, path);
    for (const childKey of keys) captureAffineSnapshot(object[childKey], [...path, childKey], snapshot);
  }
  return snapshot;
}

function affineEntryEqual(left: AffineEntry | undefined, right: AffineEntry | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "number" && right.kind === "number") return left.value === right.value && left.integer === right.integer;
  if (left.kind === "decimal" && right.kind === "decimal") return left.value === right.value;
  return left.kind === "struct" && right.kind === "struct" && left.value === right.value;
}

function affineDeltaStable(first: AffineDelta, second: AffineDelta): boolean {
  if (first.kind !== second.kind || first.integer !== second.integer) return false;
  if (first.kind === "decimal" && second.kind === "decimal") return first.delta === second.delta;
  const left = Number(first.delta);
  const right = Number(second.delta);
  return stableRate(left, right);
}

function createAffineContract(
  start: GameState,
  first: GameState,
  second: GameState,
  windowSeconds: number,
): AffineContract | null {
  const startSnapshot = captureAffineSnapshot(start);
  const firstSnapshot = captureAffineSnapshot(first);
  const secondSnapshot = captureAffineSnapshot(second);
  const deltas: AffineDelta[] = [];
  const reject = (_reason: string, _key: string): AffineContract | null => null;
  const allKeys = new Set([...startSnapshot.entries.keys(), ...firstSnapshot.entries.keys(), ...secondSnapshot.entries.keys()]);
  const resolveEntry = (snapshot: AffineSnapshot, key: string, fallback?: AffineEntry): AffineEntry | undefined => {
    const current = snapshot.entries.get(key);
    if (current) return current;
    const path = startSnapshot.paths.get(key) ?? firstSnapshot.paths.get(key) ?? secondSnapshot.paths.get(key);
    if (!path || !fallback || (fallback.kind !== "number" && fallback.kind !== "decimal")) return undefined;
    if (!path.some((part) => typeof part === "string" && AFFINE_DYNAMIC_MAP_KEYS.has(part))) return undefined;
    return fallback.kind === "number"
      ? { kind: "number", value: 0, integer: fallback.integer }
      : { kind: "decimal", value: 0n };
  };
  for (const key of allKeys) {
    // Dynamic maps can gain or lose item keys during a calibration window.
    // Treat a missing numeric/decimal key as zero, while structural changes
    // still reject the contract instead of silently changing topology.
    const startEntry = resolveEntry(
      startSnapshot,
      key,
      firstSnapshot.entries.get(key) ?? secondSnapshot.entries.get(key),
    );
    const firstEntry = resolveEntry(firstSnapshot, key, startEntry);
    const secondEntry = resolveEntry(secondSnapshot, key, firstEntry ?? startEntry);
    if (!startEntry || !firstEntry || !secondEntry) return reject("missing", key);
    if (!affineEntryEqual(startEntry, firstEntry) && startEntry.kind === "struct") return reject("struct-start", key);
    if (!firstEntry || !secondEntry || startEntry.kind !== firstEntry.kind || firstEntry.kind !== secondEntry.kind) return reject("kind", key);
    if (startEntry.kind === "struct" || firstEntry.kind === "struct") {
      if (!affineEntryEqual(startEntry, firstEntry) || !affineEntryEqual(firstEntry, secondEntry)) return reject("struct", key);
      continue;
    }
    if (startEntry.kind === "number" && firstEntry.kind === "number" && secondEntry.kind === "number") {
      const firstDelta = firstEntry.value - startEntry.value;
      const secondDelta = secondEntry.value - firstEntry.value;
      const path = startSnapshot.paths.get(key) ?? firstSnapshot.paths.get(key) ?? secondSnapshot.paths.get(key);
      if (!path) return reject("missing-path", key);
      const firstRate: AffineDelta = { path, kind: "number", delta: firstDelta, integer: startEntry.integer && firstEntry.integer && secondEntry.integer };
      const secondRate: AffineDelta = { path, kind: "number", delta: secondDelta, integer: firstRate.integer };
      if (!affineDeltaStable(firstRate, secondRate)) return reject("number-rate", key);
      deltas.push(firstRate);
      continue;
    }
    if (startEntry.kind === "decimal" && firstEntry.kind === "decimal" && secondEntry.kind === "decimal") {
      const firstDelta = firstEntry.value - startEntry.value;
      const secondDelta = secondEntry.value - firstEntry.value;
      const path = startSnapshot.paths.get(key) ?? firstSnapshot.paths.get(key) ?? secondSnapshot.paths.get(key);
      if (!path) return reject("missing-path", key);
      const firstRate: AffineDelta = { path, kind: "decimal", delta: firstDelta };
      const secondRate: AffineDelta = { path, kind: "decimal", delta: secondDelta };
      if (!affineDeltaStable(firstRate, secondRate)) return reject("decimal-rate", key);
      deltas.push(firstRate);
    }
  }
  const hasDecimalDelta = deltas.some((entry) => entry.kind === "decimal" && entry.delta !== 0n);
  const validationSeconds = hasDecimalDelta ? windowSeconds : VALIDATION_SECONDS;
  return { deltas, baseline: secondSnapshot, windowSeconds, validationSeconds };
}

function hasNonIntegralIntegerWindow(contract: AffineContract, seconds: number): boolean {
  return contract.deltas.some((delta) => delta.kind === "number" && delta.integer && delta.delta !== 0 &&
    seconds % contract.windowSeconds !== 0);
}

function readAffinePath(root: unknown, path: AffinePath): unknown {
  let value = root as unknown;
  for (const segment of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[segment];
  }
  return value;
}

function writeAffinePath(root: unknown, path: AffinePath, value: unknown): boolean {
  if (path.length === 0) return false;
  let parent = root as unknown;
  for (const segment of path.slice(0, -1)) {
    if (parent === null || typeof parent !== "object") return false;
    parent = (parent as Record<string | number, unknown>)[segment];
  }
  if (parent === null || typeof parent !== "object") return false;
  (parent as Record<string | number, unknown>)[path.at(-1)!] = value;
  return true;
}

function applyAffineContract(state: GameState, contract: AffineContract, seconds: number): boolean {
  if (seconds < 0 || !Number.isFinite(seconds)) return false;
  for (const delta of contract.deltas) {
    const current = readAffinePath(state, delta.path);
    if (delta.kind === "number") {
      if (typeof current !== "number" || !Number.isFinite(current)) return false;
      const next = current + Number(delta.delta) * seconds / contract.windowSeconds;
      if (!Number.isFinite(next) || (delta.integer && !Number.isSafeInteger(Math.floor(next + EPSILON)))) return false;
      if (!writeAffinePath(state, delta.path, delta.integer ? Math.floor(next + EPSILON) : next)) return false;
      continue;
    }
    if (typeof current !== "string" || !/^\d+$/.test(current) || seconds % contract.windowSeconds !== 0) return false;
    try {
      const repeats = BigInt(Math.floor(seconds / contract.windowSeconds));
      const next = BigInt(current) + (delta.delta as bigint) * repeats;
      if (next < 0n || !writeAffinePath(state, delta.path, next.toString())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function validateAffineState(state: GameState): boolean {
  for (const entity of state.entities) {
    const inputCapacity = getEntityInputCapacity(state, entity);
    const outputCapacity = getEntityOutputCapacity(state, entity);
    for (const amount of Object.values(entity.inputs)) {
      if (!Number.isFinite(amount) || amount < -EPSILON || !Number.isSafeInteger(Math.floor(amount + EPSILON))) return false;
      if (inputCapacity > 0 && amount > inputCapacity + 1) return false;
    }
    for (const amount of Object.values(entity.outputs)) {
      if (!Number.isFinite(amount) || amount < -EPSILON || !Number.isSafeInteger(Math.floor(amount + EPSILON))) return false;
      if (outputCapacity > 0 && amount > outputCapacity + 1) return false;
    }
    if (!Number.isFinite(entity.progress) || entity.progress < -EPSILON || entity.progress > 1 + EPSILON) return false;
  }
  for (const belt of state.belts) {
    if (!Number.isFinite(belt.progress) || belt.progress < -EPSILON || !Number.isSafeInteger(Math.floor(finiteNumber(belt.totalTransferred) + EPSILON))) return false;
  }
  for (const amount of Object.values(state.totalProduced)) {
    if (!Number.isFinite(amount) || amount < -EPSILON || !Number.isSafeInteger(Math.floor(amount + EPSILON))) return false;
  }
  return true;
}

function compareAffineSnapshots(actual: GameState, expected: GameState): number {
  const left = captureAffineSnapshot(actual);
  const right = captureAffineSnapshot(expected);
  if (left.entries.size !== right.entries.size) return 1;
  let maxError = 0;
  for (const [key, leftEntry] of left.entries) {
    const rightEntry = right.entries.get(key);
    if (!rightEntry || leftEntry.kind !== rightEntry.kind) return 1;
    if (leftEntry.kind === "struct" && !affineEntryEqual(leftEntry, rightEntry)) return 1;
    if (leftEntry.kind === "number" && rightEntry.kind === "number") {
      maxError = Math.max(maxError, relativeDifference(leftEntry.value, rightEntry.value));
    } else if (leftEntry.kind === "decimal" && rightEntry.kind === "decimal") {
      const difference = leftEntry.value >= rightEntry.value ? leftEntry.value - rightEntry.value : rightEntry.value - leftEntry.value;
      const scale = leftEntry.value > rightEntry.value ? leftEntry.value : rightEntry.value;
      if (scale > 0n) maxError = Math.max(maxError, Number(difference > scale ? 1n : difference) / Number(scale));
    }
  }
  return maxError;
}

function safeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function readPreference(storage: Pick<Storage, "getItem"> | undefined): boolean {
  if (!storage) return OFFLINE_APPROXIMATION_DEFAULT_ENABLED;
  try {
    const value = storage.getItem(OFFLINE_APPROXIMATION_KEY);
    return value === null ? OFFLINE_APPROXIMATION_DEFAULT_ENABLED : value === "true";
  } catch {
    return OFFLINE_APPROXIMATION_DEFAULT_ENABLED;
  }
}

export function readOfflineApproximationEnabled(): boolean {
  return typeof window === "undefined" ? OFFLINE_APPROXIMATION_DEFAULT_ENABLED : readPreference(window.localStorage);
}

export function writeOfflineApproximationEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OFFLINE_APPROXIMATION_KEY, String(enabled));
  } catch {
    // Device-only experiment preferences are best effort.
  }
}

function mapNumbers(source: Partial<Record<string, number>> | undefined): NumericMap {
  const result: NumericMap = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    const number = finiteNumber(value);
    if (Math.abs(number) > EPSILON) result[key] = number;
  }
  return result;
}

function captureProjection(state: GameState): MacroProjection {
  const entities: Record<string, EntityProjection> = {};
  for (const entity of state.entities) {
    entities[entity.id] = {
      inputs: mapNumbers(entity.inputs),
      outputs: mapNumbers(entity.outputs),
      progress: finiteNumber(entity.progress),
      productionRate: finiteNumber(entity.productionRate),
      utilization: finiteNumber(entity.utilization),
      powerFactor: typeof entity.powerFactor === "number" ? finiteNumber(entity.powerFactor) : undefined,
    };
  }
  const belts: Record<string, BeltProjection> = {};
  for (const belt of state.belts) {
    belts[belt.id] = {
      progress: finiteNumber(belt.progress),
      totalTransferred: finiteNumber(belt.totalTransferred),
      lastFlow: finiteNumber(belt.lastFlow),
      congestion: finiteNumber(belt.congestion),
    };
  }
  return {
    elapsedSeconds: finiteNumber(state.elapsedSeconds),
    totalProduced: mapNumbers(state.totalProduced),
    entities,
    belts,
  };
}

function diffMap(start: NumericMap, end: NumericMap, seconds: number): NumericMap {
  const keys = new Set([...Object.keys(start), ...Object.keys(end)]);
  const result: NumericMap = {};
  for (const key of keys) result[key] = (finiteNumber(end[key]) - finiteNumber(start[key])) / seconds;
  return result;
}

function diffProjection(start: MacroProjection, end: MacroProjection, seconds: number): MacroRates {
  const entities: Record<string, EntityProjection> = {};
  for (const id of new Set([...Object.keys(start.entities), ...Object.keys(end.entities)])) {
    const left = start.entities[id] ?? { inputs: {}, outputs: {}, progress: 0, productionRate: 0, utilization: 0 };
    const right = end.entities[id] ?? left;
    entities[id] = {
      inputs: diffMap(left.inputs, right.inputs, seconds),
      outputs: diffMap(left.outputs, right.outputs, seconds),
      progress: (right.progress - left.progress) / seconds,
      productionRate: right.productionRate,
      utilization: right.utilization,
      powerFactor: right.powerFactor,
    };
  }
  const belts: Record<string, BeltProjection> = {};
  for (const id of new Set([...Object.keys(start.belts), ...Object.keys(end.belts)])) {
    const left = start.belts[id] ?? { progress: 0, totalTransferred: 0, lastFlow: 0, congestion: 0 };
    const right = end.belts[id] ?? left;
    belts[id] = {
      progress: (right.progress - left.progress) / seconds,
      totalTransferred: (right.totalTransferred - left.totalTransferred) / seconds,
      lastFlow: right.lastFlow,
      congestion: right.congestion,
    };
  }
  return {
    totalProduced: diffMap(start.totalProduced, end.totalProduced, seconds),
    entities,
    belts,
  };
}

function relativeDifference(actual: number, expected: number): number {
  const scale = Math.max(1, Math.abs(expected), Math.abs(actual));
  return Math.abs(actual - expected) / scale;
}

function stableRate(first: number, second: number): boolean {
  const scale = Math.max(1, Math.abs(first), Math.abs(second));
  return Math.abs(first - second) / scale <= STABILITY_TOLERANCE;
}

function hasFluidRecipe(entity: FactoryEntity): boolean {
  const recipe = getRecipe(entity.recipeId);
  return Boolean(recipe?.inputs.some((item) => ITEMS[item.itemId]?.kind === "fluid") ||
    recipe?.outputs.some((item) => ITEMS[item.itemId]?.kind === "fluid"));
}

/**
 * The contract is intentionally conservative.  It is a performance
 * experiment for steady solid production, not a second simulation engine.
 * Dynamic logistics, finite extractors, fluid cycles and end-game systems
 * must continue through the exact engine.
 */
export function getOfflineApproximationBlocker(state: GameState, seconds: number): string | null {
  if (state.paused) return "存档已暂停";
  if (!Number.isFinite(seconds) || seconds < MIN_APPROXIMATION_SECONDS) return "离线时长不足校准阈值";
  if (state.handcraftQueue.length > 0 || state.constructionQueue.length > 0 || Object.keys(state.constructionAutomation.jobs).length > 0 ||
    (state.constructionAutomation.enabled && Object.keys(state.constructionAutomation.targetStock).length > 0)) return "存在建造或递归制造任务";
  if (state.exploration.missions.length > 0) return "存在探索任务边界";
  if (state.endgame.constructionActivity.activityId) return "存在活动时间边界";
  // Research completion is a discrete event with rewards and queue changes;
  // never extrapolate progressByTech without executing that event.
  if (hasActiveResearch(state)) return "存在进行中的科研，近似路径回退精确结算";
  if (state.endgame.activeInfiniteResearchId || Object.values(state.endgame.exportProjects).some((project) => project.enabled)) return "存在终局科研或出口任务";
  if (state.entities.some((entity) => (entity.kind === "station" || (entity.stationRoutes?.length ?? 0) > 0) &&
    !(entity.quantumMode === "quantum" || entity.quantumTransition))) return "存在传统物流站或在途航线";
  if (state.entities.some((entity) => entity.kind === "vein" && entity.minerCount > 0 && state.settings.resourceMode !== "infinite" &&
    (state.endgame.infiniteResearch.vein_utilization?.level ?? 0) < 10)) return "存在可能枯竭的有限矿脉";
  if (state.belts.some((belt) => belt.lanes <= 0 || !Number.isSafeInteger(belt.lanes))) return "传送带结构不满足安全整数条件";
  const dynamicBuildings = new Set([
    "orbital_collector", "ray_receiver", "artificial_star", "em_rail_ejector", "vertical_launching_silo",
    "construction_center", "galactic_material_exporter", "micro_black_hole_connector", "space_station_construction_launcher",
    "orbital_cargo_terminal",
    "thermal_power_plant", "mini_fusion_power_plant", "energy_exchanger", "accumulator",
  ]);
  if (state.entities.some((entity) => entity.buildingId && dynamicBuildings.has(entity.buildingId))) return "存在戴森、物流或巨构边界";
  if (state.entities.some((entity) => entity.recipeId === "matrix_research" || hasFluidRecipe(entity) || entity.sprayCoaterInstalled || entity.proliferatorMode)) return "存在科研、流体或增产剂链";
  if ((state.dysonEngineering.launchEnabled && state.entities.some((entity) => entity.recipeId === "solar_sail_launch" || entity.recipeId === "carrier_rocket_launch")) ||
    state.dysonSwarm.totalLaunched > 0 || state.dysonSphere.totalRocketsLaunched > 0) return "戴森工程仍在变化";
  if (state.timeWarp.pendingSimulationSeconds > EPSILON || state.timeWarp.pendingWallSeconds > EPSILON) return "存在未提交时间扭曲预算";
  return null;
}

function cacheIsAwayFromBoundary(state: GameState): string | null {
  for (const entity of state.entities) {
    const inputCapacity = getEntityInputCapacity(state, entity);
    const outputCapacity = getEntityOutputCapacity(state, entity);
    for (const amount of Object.values(entity.inputs)) {
      const value = finiteNumber(amount);
      if (inputCapacity > 0 && (value < inputCapacity * 0.05 || value > inputCapacity * 0.95)) return `${entity.id} 输入缓存接近边界`;
    }
    for (const amount of Object.values(entity.outputs)) {
      const value = finiteNumber(amount);
      if (outputCapacity > 0 && (value < outputCapacity * 0.05 || value > outputCapacity * 0.95)) return `${entity.id} 输出缓存接近边界`;
    }
  }
  return null;
}

function runExact(source: GameState, seconds: number, wallSeconds = seconds): GameState {
  // Callers provide an isolated clone. Mutating it avoids a second full-state
  // copy during each calibration/validation window while keeping the original
  // authoritative state untouched.
  // The ordinary engine intentionally caps one session at 30 days. A high
  // time-warp multiplier can exceed that simulation span inside a shorter
  // wall-clock interval, so cover the whole requested range with proportional
  // bounded sessions instead of silently accepting a truncated replay.
  const maximumChunkSeconds = 30 * 24 * 60 * 60;
  let remainingSeconds = Math.max(0, seconds);
  let remainingWallSeconds = Math.max(0, wallSeconds);
  let state = source;
  while (remainingSeconds > EPSILON || remainingWallSeconds > EPSILON) {
    const simulationFraction = remainingSeconds > maximumChunkSeconds
      ? maximumChunkSeconds / remainingSeconds
      : 1;
    const wallFraction = remainingWallSeconds > maximumChunkSeconds
      ? maximumChunkSeconds / remainingWallSeconds
      : 1;
    const fraction = Math.min(1, simulationFraction, wallFraction);
    const chunkSeconds = remainingSeconds * fraction;
    const chunkWallSeconds = remainingWallSeconds * fraction;
    const session = createSimulationAdvanceSession(state, chunkSeconds, { mutateState: true, wallSeconds: chunkWallSeconds });
    while (session.remainingSeconds > EPSILON || session.remainingWallSeconds > EPSILON) {
      advanceSimulationSession(session, 256);
    }
    state = completeSimulationAdvanceSession(session);
    remainingSeconds = Math.max(0, remainingSeconds - chunkSeconds);
    remainingWallSeconds = Math.max(0, remainingWallSeconds - chunkWallSeconds);
  }
  return state;
}

/**
 * Advance a Worker-owned state through a short exact window. Pure-idle keeps
 * this bounded to its 30-second calibration prefix, so crossing a cache or
 * finite-resource boundary does not turn a multi-day settlement into a
 * multi-day replay.
 */
export function advanceExactSimulationWindow(
  source: GameState,
  seconds: number,
  wallSeconds = seconds,
): GameState {
  return runExact(source, seconds, wallSeconds);
}

function applyRates(state: GameState, rates: MacroRates, seconds: number): boolean {
  const totalProduced = { ...state.totalProduced } as Record<string, number | undefined>;
  for (const [itemId, rate] of Object.entries(rates.totalProduced)) {
    const current = finiteNumber(totalProduced[itemId]);
    const next = Math.floor(current + rate * seconds + EPSILON);
    if (!safeInteger(next)) return false;
    totalProduced[itemId] = next;
  }
  state.totalProduced = totalProduced;
  for (const entity of state.entities) {
    const rate = rates.entities[entity.id];
    if (!rate) continue;
    const inputs = entity.inputs as Record<string, number | undefined>;
    const outputs = entity.outputs as Record<string, number | undefined>;
    for (const [itemId, value] of Object.entries(rate.inputs)) {
      const next = Math.floor(finiteNumber(inputs[itemId]) + value * seconds + EPSILON);
      if (!safeInteger(next)) return false;
      inputs[itemId] = next;
    }
    for (const [itemId, value] of Object.entries(rate.outputs)) {
      const next = Math.floor(finiteNumber(outputs[itemId]) + value * seconds + EPSILON);
      if (!safeInteger(next)) return false;
      outputs[itemId] = next;
    }
    const progress = finiteNumber(entity.progress) + rate.progress * seconds;
    entity.progress = ((progress % 1) + 1) % 1;
    entity.productionRate = finiteNumber(rate.productionRate);
    entity.utilization = finiteNumber(rate.utilization);
    if (rate.powerFactor !== undefined) entity.powerFactor = finiteNumber(rate.powerFactor);
  }
  for (const belt of state.belts) {
    const rate = rates.belts[belt.id];
    if (!rate) continue;
    const progress = finiteNumber(belt.progress) + rate.progress * seconds;
    belt.progress = ((progress % 1) + 1) % 1;
    const transferred = Math.floor(finiteNumber(belt.totalTransferred) + rate.totalTransferred * seconds + EPSILON);
    if (!safeInteger(transferred)) return false;
    belt.totalTransferred = transferred;
    belt.lastFlow = finiteNumber(rate.lastFlow);
    belt.congestion = Math.max(0, Math.min(1, finiteNumber(rate.congestion)));
  }
  state.elapsedSeconds = finiteNumber(state.elapsedSeconds) + seconds;
  return Number.isSafeInteger(Math.floor(state.elapsedSeconds));
}

function validateProjectedState(state: GameState, baseline: MacroProjection): boolean {
  for (const entity of state.entities) {
    const projection = baseline.entities[entity.id];
    const inputCapacity = getEntityInputCapacity(state, entity);
    const outputCapacity = getEntityOutputCapacity(state, entity);
    for (const [itemId, value] of Object.entries(entity.inputs)) {
      const numeric = finiteNumber(value);
      const original = finiteNumber(projection?.inputs[itemId]);
      if (!safeInteger(Math.floor(numeric)) || numeric < -EPSILON || (inputCapacity > 0 && numeric > Math.max(inputCapacity, original) + 1)) return false;
    }
    for (const [itemId, value] of Object.entries(entity.outputs)) {
      const numeric = finiteNumber(value);
      const original = finiteNumber(projection?.outputs[itemId]);
      if (!safeInteger(Math.floor(numeric)) || numeric < -EPSILON || (outputCapacity > 0 && numeric > Math.max(outputCapacity, original) + 1)) return false;
    }
    if (projection && (!Number.isFinite(entity.progress) || entity.progress < -EPSILON || entity.progress > 1 + EPSILON)) return false;
  }
  for (const belt of state.belts) if (!safeInteger(Math.floor(finiteNumber(belt.totalTransferred)))) return false;
  for (const amount of Object.values(state.totalProduced)) if (!safeInteger(Math.floor(finiteNumber(amount)))) return false;
  return true;
}

function compareProjection(actual: MacroProjection, expected: MacroProjection): number {
  let maxError = 0;
  for (const itemId of new Set([...Object.keys(actual.totalProduced), ...Object.keys(expected.totalProduced)])) {
    maxError = Math.max(maxError, relativeDifference(finiteNumber(actual.totalProduced[itemId]), finiteNumber(expected.totalProduced[itemId])));
  }
  for (const id of new Set([...Object.keys(actual.entities), ...Object.keys(expected.entities)])) {
    const left = actual.entities[id];
    const right = expected.entities[id];
    if (!left || !right) return 1;
    for (const itemId of new Set([...Object.keys(left.inputs), ...Object.keys(right.inputs)])) maxError = Math.max(maxError, relativeDifference(finiteNumber(left.inputs[itemId]), finiteNumber(right.inputs[itemId])));
    for (const itemId of new Set([...Object.keys(left.outputs), ...Object.keys(right.outputs)])) maxError = Math.max(maxError, relativeDifference(finiteNumber(left.outputs[itemId]), finiteNumber(right.outputs[itemId])));
  }
  return maxError;
}

function ratesStable(first: MacroRates, second: MacroRates): boolean {
  for (const itemId of new Set([...Object.keys(first.totalProduced), ...Object.keys(second.totalProduced)])) {
    if (!stableRate(finiteNumber(first.totalProduced[itemId]), finiteNumber(second.totalProduced[itemId]))) return false;
  }
  for (const id of new Set([...Object.keys(first.entities), ...Object.keys(second.entities)])) {
    const left = first.entities[id];
    const right = second.entities[id];
    if (!left || !right || !stableRate(left.productionRate, right.productionRate) || !stableRate(left.utilization, right.utilization)) return false;
    for (const itemId of new Set([...Object.keys(left.inputs), ...Object.keys(right.inputs)])) if (!stableRate(finiteNumber(left.inputs[itemId]), finiteNumber(right.inputs[itemId]))) return false;
    for (const itemId of new Set([...Object.keys(left.outputs), ...Object.keys(right.outputs)])) if (!stableRate(finiteNumber(left.outputs[itemId]), finiteNumber(right.outputs[itemId]))) return false;
  }
  return true;
}

function exactReport(
  windowSeconds: number,
  reason: string,
  fellBack = true,
  algorithmVersion?: string,
): OfflineApproximationReport {
  return {
    mode: "exact",
    calibrationWindowSeconds: windowSeconds,
    approximatedSeconds: 0,
    maxEstimatedError: 0,
    fellBack,
    fallbackReason: reason,
    ...(algorithmVersion ? { algorithmVersion } : {}),
  };
}

function hasAffineFlow(state: GameState): boolean {
  return state.entities.some((entity) => entity.quantumMode === "quantum" || Boolean(entity.quantumTransition)) ||
    Boolean(state.quantumLogisticsNetwork?.enabled && Object.keys(state.quantumLogisticsNetwork.inventory).length > 0) ||
    state.entities.some((entity) => (entity.stationRoutes?.length ?? 0) > 0 && entity.quantumMode === "quantum");
}

function runAffineApproximation(state: GameState, seconds: number, wallSeconds = seconds): OfflineApproximationResult {
  const windowSeconds = Math.min(MAX_CALIBRATION_SECONDS, Math.max(MIN_CALIBRATION_SECONDS, Math.floor(seconds / 12)));
  const wallWindowSeconds = seconds > EPSILON ? wallSeconds * windowSeconds / seconds : windowSeconds;
  const first = runExact(structuredClone(state), windowSeconds, wallWindowSeconds);
  const second = runExact(structuredClone(first), windowSeconds, wallWindowSeconds);
  const contract = createAffineContract(state, first, second, windowSeconds);
  if (!contract) return { status: "fallback", report: exactReport(windowSeconds, "复杂物流状态在连续校准窗口中不是稳定增量") };
  const macroSeconds = seconds - windowSeconds * 2 - contract.validationSeconds;
  if (macroSeconds < 1 || contract.deltas.some((delta) => delta.kind === "decimal" && macroSeconds % contract.windowSeconds !== 0) ||
    hasNonIntegralIntegerWindow(contract, macroSeconds)) {
    return { status: "fallback", report: exactReport(windowSeconds, "复杂物流状态需要在整数边界校准") };
  }
  const macro = structuredClone(second);
  if (!applyAffineContract(macro, contract, macroSeconds) || !validateAffineState(macro)) {
    return { status: "fallback", report: exactReport(windowSeconds, "复杂物流宏观预测越过缓存、线路或安全整数边界") };
  }
  const expected = structuredClone(macro);
  if (!applyAffineContract(expected, contract, contract.validationSeconds) || !validateAffineState(expected)) {
    return { status: "fallback", report: exactReport(windowSeconds, "复杂物流验证预测越过安全边界") };
  }
  const wallValidationSeconds = seconds > EPSILON ? wallSeconds * contract.validationSeconds / seconds : contract.validationSeconds;
  const actual = runExact(structuredClone(macro), contract.validationSeconds, wallValidationSeconds);
  const maxEstimatedError = compareAffineSnapshots(actual, expected);
  if (!Number.isFinite(maxEstimatedError) || maxEstimatedError > MAX_ERROR) {
    return {
      status: "fallback",
      report: { ...exactReport(windowSeconds, `复杂物流精确验证误差 ${(maxEstimatedError * 100).toFixed(2)}% 超过 20%`), maxEstimatedError },
    };
  }
  return {
    status: "approximate",
    state: actual,
    report: {
      mode: "approximate",
      calibrationWindowSeconds: windowSeconds,
      approximatedSeconds: macroSeconds,
      maxEstimatedError,
      fellBack: false,
    },
  };
}

/**
 * Try the contract path on an isolated state.  A non-approximate result never
 * contains a partially advanced state, so callers can safely run the normal
 * exact worker path from the original input.
 */
export function runOfflineApproximation(state: GameState, seconds: number, wallSeconds = seconds): OfflineApproximationResult {
  const blocker = getOfflineApproximationBlocker(state, seconds);
  if (blocker) return { status: "ineligible", report: exactReport(0, blocker) };
  if (hasAffineFlow(state)) return runAffineApproximation(state, seconds, wallSeconds);
  const initialBoundary = cacheIsAwayFromBoundary(state);
  if (initialBoundary) return { status: "ineligible", report: exactReport(0, initialBoundary) };

  const windowSeconds = Math.min(MAX_CALIBRATION_SECONDS, Math.max(MIN_CALIBRATION_SECONDS, Math.floor(seconds / 12)));
  const wallWindowSeconds = seconds > EPSILON ? wallSeconds * windowSeconds / seconds : windowSeconds;
  const first = runExact(structuredClone(state), windowSeconds, wallWindowSeconds);
  const second = runExact(structuredClone(first), windowSeconds, wallWindowSeconds);
  const firstProjection = captureProjection(first);
  const secondProjection = captureProjection(second);
  const firstRates = diffProjection(captureProjection(structuredClone(state)), firstProjection, windowSeconds);
  const secondRates = diffProjection(firstProjection, secondProjection, windowSeconds);
  if (!ratesStable(firstRates, secondRates)) return { status: "fallback", report: exactReport(windowSeconds, "连续精确校准窗口速率变化超过 5%") };
  const boundary = cacheIsAwayFromBoundary(second);
  if (boundary) return { status: "fallback", report: exactReport(windowSeconds, boundary) };
  const macroSeconds = seconds - windowSeconds * 2 - VALIDATION_SECONDS;
  if (macroSeconds < 1) return { status: "fallback", report: exactReport(windowSeconds, "校准窗口后没有足够的宏观时间") };

  const macro = structuredClone(second);
  if (!applyRates(macro, secondRates, macroSeconds) || !validateProjectedState(macro, secondProjection)) {
    return { status: "fallback", report: exactReport(windowSeconds, "宏观预测超出安全整数或缓存边界") };
  }
  const expected = structuredClone(macro);
  if (!applyRates(expected, secondRates, VALIDATION_SECONDS) || !validateProjectedState(expected, captureProjection(macro))) {
    return { status: "fallback", report: exactReport(windowSeconds, "验证预测超出安全整数或缓存边界") };
  }
  const wallValidationSeconds = seconds > EPSILON ? wallSeconds * VALIDATION_SECONDS / seconds : VALIDATION_SECONDS;
  const actual = runExact(structuredClone(macro), VALIDATION_SECONDS, wallValidationSeconds);
  const maxEstimatedError = compareProjection(captureProjection(actual), captureProjection(expected));
  if (!Number.isFinite(maxEstimatedError) || maxEstimatedError > MAX_ERROR) {
    return {
      status: "fallback",
      report: { ...exactReport(windowSeconds, `精确验证误差 ${(maxEstimatedError * 100).toFixed(2)}% 超过 20%`), maxEstimatedError },
    };
  }
  return {
    status: "approximate",
    state: actual,
    report: {
      mode: "approximate",
      calibrationWindowSeconds: windowSeconds,
      approximatedSeconds: macroSeconds,
      maxEstimatedError,
      fellBack: false,
    },
  };
}

export interface PureIdleAffineContract {
  deltas: AffineDelta[];
  calibrationSeconds: number;
  calibrationWallSeconds: number;
  /**
   * Optional conservative credit horizon measured from the calibrated state.
   * The pure-idle controller advances wall/game time after this boundary but
   * must not keep copying production measured before an input/output boundary.
   */
  maximumSimulationSeconds?: number;
  /** Per-item credit horizons for the low-memory 30-second estimator. */
  maximumSimulationSecondsByItem?: Record<string, number>;
}

/** Legacy worker-call shape retained while conservative sampled tails are disabled. */
export interface PureIdleConservativeContractOptions {
  /** Retained for worker source compatibility; no sampled tail is applied. */
  rateFactor?: number;
  /** Retained for worker source compatibility; production remains frozen. */
  includeProduction?: boolean;
}

function sameStableIds<T extends { id: string }>(before: T[] | undefined, after: T[] | undefined): boolean {
  if (!before || !after || before.length !== after.length) return false;
  return before.every((entry, index) => entry.id === after[index]?.id);
}

/**
 * Conservative pure-idle deliberately has no affine production tail.
 *
 * Before 1.2.0 this function copied cumulative production, launch, export and
 * Dyson counters measured during a one-second probe while freezing the stores
 * that supplied those results. Repeating the counter deltas therefore created
 * terminal output without consuming material. A haircut cannot make an open
 * ledger safe, so callers now keep only their bounded exact prefix and freeze
 * every material-affecting subsystem for the uncertain tail.
 *
 * The signature remains available for source compatibility with workers built
 * during the 1.1.8/1.1.9 transition. A future productive conservative mode
 * must replace this with a closed per-item flow ledger, not sampled counters.
 */
export function createPureIdleConservativeContract(
  before: GameState,
  after: GameState,
  calibrationSeconds: number,
  calibrationWallSeconds: number,
  options: PureIdleConservativeContractOptions = {},
): PureIdleAffineContract | null {
  if (!Number.isFinite(calibrationSeconds) || calibrationSeconds <= 0 ||
    !Number.isFinite(calibrationWallSeconds) || calibrationWallSeconds <= 0 ||
    before.mode !== after.mode || before.version !== after.version ||
    !sameStableIds(before.entities, after.entities) || !sameStableIds(before.belts, after.belts)) return null;
  void options;
  return null;
}

function pathHasString(path: AffinePath, values: ReadonlySet<string>): boolean {
  return path.some((part) => typeof part === "string" && values.has(part));
}

const FAST_SENSITIVE_KEYS = new Set([
  "elapsedSeconds", "elapsedActiveSeconds", "totalProduced", "totalConsumed", "inputs", "outputs",
  "inventory", "planetTrays", "tray", "construction", "constructionBuffer", "delivered",
  "productionRate", "utilization", "powerFactor", "storedEnergyMj", "fuelReserveSeconds",
  "totalLaunched", "totalRocketsLaunched", "shellSails", "totalSailsAbsorbed", "structurePoints",
  "research", "progressByTech", "infiniteResearch", "exportProjects", "constructionAutomation",
]);
const FAST_TAIL_RATE_KEYS = new Set([
  "totalTransferred", "structurePoints", "shellSails", "totalRocketsLaunched", "totalLaunched", "totalSailsAbsorbed", "sailsInOrbit",
]);
const FAST_ERROR_IGNORED_KEYS = new Set([
  "fuelRemainingMj", "proliferatorBonusProgress", "stationCongestion", "sailsInOrbit", "generationKw",
  // Per-entity power readings are derived diagnostics refreshed by the exact
  // validation tail, not cumulative resources that can be extrapolated.
  "powerOutputKw", "powerInputKw", "powerDemandKw", "powerGenerationKw", "totalDestroyed", "stationProgress",
]);
const FAST_FINITE_FLOAT_KEYS = new Set([
  // Power is a derived continuous measurement. At extreme Dyson scale it can
  // legitimately exceed MAX_SAFE_INTEGER without becoming an item counter.
  "generationKw", "powerOutputKw", "powerInputKw", "powerDemandKw", "powerGenerationKw",
  "demandKw", "fuelGenerationKw", "storedEnergyMj",
]);
// A calibration delta for a periodic transport or visual field has no useful
// long-term meaning.  These values must remain at the last exact checkpoint;
// the macro ledger only models aggregate stores and cumulative outcomes.
const PURE_IDLE_TRANSIENT_KEYS = new Set([
  "cargo", "remainingCargo", "progress", "stationProgress", "routingCursor", "stationDispatchCursor",
  "lastFlow", "congestion", "utilization", "productionRate", "powerFactor",
  "powerOutputKw", "powerInputKw", "powerDemandKw", "powerGenerationKw",
  "fuelRemainingMj", "storedEnergyMj", "pendingSimulationSeconds", "pendingWallSeconds",
  "effectiveMultiplier", "requiredPowerKw", "allocatedPowerKw",
]);

function isFastFiniteFloatPath(path: AffinePath): boolean {
  return path.some((part) => typeof part === "string" &&
    (FAST_FINITE_FLOAT_KEYS.has(part) || part.endsWith("Kw")));
}

function isFastSensitivePath(path: AffinePath): boolean {
  return pathHasString(path, FAST_SENSITIVE_KEYS);
}

function isPureIdleTransientPath(path: AffinePath): boolean {
  return pathHasString(path, PURE_IDLE_TRANSIENT_KEYS);
}

function isDynamicMapEntryPath(path: AffinePath): boolean {
  return typeof path.at(-2) === "string" && AFFINE_DYNAMIC_MAP_KEYS.has(path.at(-2) as string);
}

const PURE_IDLE_LIGHTWEIGHT_FROZEN_ITEMS = new Set<ItemId>([
  // Launching these items changes separate Dyson terminal ledgers. The quick
  // 30-second estimator deliberately leaves both manufacture and consumption
  // at the exact checkpoint until the terminal subsystem has its own closed
  // sampled ledger.
  "small_carrier_rocket",
  "solar_sail",
]);

function appendPureIdleLightweightEntry(
  snapshot: AffineSnapshot,
  path: AffinePath,
  raw: unknown,
): void {
  const itemId = typeof path.at(-1) === "string" ? path.at(-1) as ItemId : undefined;
  if (itemId && PURE_IDLE_LIGHTWEIGHT_FROZEN_ITEMS.has(itemId)) return;
  const key = pathKey(path);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    snapshot.entries.set(key, { kind: "number", value: raw, integer: Number.isSafeInteger(raw) });
  } else if (typeof raw === "string" && /^\d+$/.test(raw) && isDecimalAffinePath(path)) {
    try {
      snapshot.entries.set(key, { kind: "decimal", value: BigInt(raw) });
    } catch {
      return;
    }
  } else {
    return;
  }
  if (!snapshot.paths.has(key)) snapshot.paths.set(key, path);
}

function appendPureIdleLightweightMap(
  snapshot: AffineSnapshot,
  prefix: AffinePath,
  values: Record<string, unknown> | undefined,
): void {
  if (!values) return;
  for (const [key, value] of Object.entries(values)) {
    appendPureIdleLightweightEntry(snapshot, [...prefix, key], value);
  }
}

/**
 * Capture only persistent material stores and their matching monotonic
 * production counters. Unlike the historical generic affine
 * snapshot this does not retain paths for positions, UI state, topology,
 * diagnostics or cyclic machine phases.
 */
function capturePureIdleLightweightSnapshot(
  state: GameState,
  sharedPaths: Map<string, AffinePath>,
): AffineSnapshot {
  const snapshot: AffineSnapshot = { entries: new Map(), paths: sharedPaths };
  appendPureIdleLightweightMap(snapshot, ["totalProduced"], state.totalProduced as Record<string, unknown>);
  appendPureIdleLightweightMap(snapshot, ["tray"], state.tray as Record<string, unknown>);
  for (const [planetId, tray] of Object.entries(state.planetTrays)) {
    // `tray` is the authoritative active-planet ownership location. Avoid
    // extrapolating the serialized duplicate as a second material store.
    if (planetId === state.activePlanetId) continue;
    appendPureIdleLightweightMap(snapshot, ["planetTrays", planetId], tray as Record<string, unknown>);
  }
  appendPureIdleLightweightMap(
    snapshot,
    ["quantumLogisticsNetwork", "inventory"],
    state.quantumLogisticsNetwork.inventory as Record<string, unknown>,
  );
  for (let index = 0; index < state.entities.length; index += 1) {
    const entity = state.entities[index];
    appendPureIdleLightweightMap(snapshot, ["entities", index, "inputs"], entity.inputs as Record<string, unknown>);
    appendPureIdleLightweightMap(snapshot, ["entities", index, "outputs"], entity.outputs as Record<string, unknown>);
  }
  return snapshot;
}

function predictPureIdleLightweightSnapshot(
  baseline: AffineSnapshot,
  contract: PureIdleAffineContract,
  simulationSeconds: number,
  wallSeconds: number,
  simulationSecondsByItem?: Record<string, number>,
): AffineSnapshot | null {
  const predicted: AffineSnapshot = {
    entries: new Map(baseline.entries),
    paths: baseline.paths,
  };
  for (const delta of contract.deltas) {
    const key = pathKey(delta.path);
    const current = predicted.entries.get(key);
    const itemId = pureIdleLightweightContractItemId(delta.path);
    const creditedSeconds = itemId && simulationSecondsByItem?.[itemId] !== undefined
      ? Math.max(0, Math.min(simulationSeconds, finiteNumber(simulationSecondsByItem[itemId])))
      : simulationSeconds;
    const creditedWallSeconds = simulationSeconds > EPSILON
      ? wallSeconds * creditedSeconds / simulationSeconds
      : 0;
    const scaledSeconds = scaleFastSeconds(delta.path, creditedSeconds, creditedWallSeconds);
    const denominator = pathHasString(delta.path, new Set(["elapsedActiveSeconds"]))
      ? contract.calibrationWallSeconds
      : contract.calibrationSeconds;
    if (!Number.isFinite(denominator) || denominator <= 0) return null;
    if (delta.kind === "number") {
      const base = current?.kind === "number"
        ? current.value
        : current === undefined && isDynamicMapEntryPath(delta.path) ? 0 : null;
      if (base === null) return null;
      const nextRaw = base + Number(delta.delta) * scaledSeconds / denominator;
      const next = delta.integer ? Math.floor(nextRaw + EPSILON) : nextRaw;
      if (!Number.isFinite(next) || delta.integer && !Number.isSafeInteger(next)) return null;
      predicted.entries.set(key, { kind: "number", value: next, integer: Boolean(delta.integer) });
    } else {
      const base = current?.kind === "decimal"
        ? current.value
        : current === undefined && isDynamicMapEntryPath(delta.path) ? 0n : null;
      if (base === null) return null;
      try {
        const scaled = BigInt(Math.max(0, Math.floor(scaledSeconds))) * (delta.delta as bigint) /
          BigInt(Math.max(1, Math.floor(denominator)));
        const next = base + scaled;
        if (next < 0n) return null;
        predicted.entries.set(key, { kind: "decimal", value: next });
      } catch {
        return null;
      }
    }
  }
  return predicted;
}

function comparePureIdleLightweightSnapshots(
  baseline: AffineSnapshot,
  expected: AffineSnapshot,
  actual: AffineSnapshot,
): FastSnapshotComparison {
  let maxError = 0;
  let maxPath: AffinePath | undefined;
  let maxActual: number | bigint | undefined;
  let maxExpected: number | bigint | undefined;
  const keys = new Set([...expected.entries.keys(), ...actual.entries.keys()]);
  for (const key of keys) {
    const path = expected.paths.get(key) ?? actual.paths.get(key);
    if (path && pathHasString(path, FAST_ERROR_IGNORED_KEYS)) continue;
    const before = baseline.entries.get(key);
    const expectedEntry = expected.entries.get(key);
    const actualEntry = actual.entries.get(key);
    if (!expectedEntry || !actualEntry || expectedEntry.kind !== actualEntry.kind) continue;
    let error = 0;
    let expectedValue: number | bigint | undefined;
    let actualValue: number | bigint | undefined;
    if (expectedEntry.kind === "number" && actualEntry.kind === "number") {
      const origin = before?.kind === "number" ? before.value : 0;
      expectedValue = expectedEntry.value - origin;
      actualValue = actualEntry.value - origin;
      if (Math.abs(Number(expectedValue) - Number(actualValue)) > 1) {
        error = relativeDifference(Number(expectedValue), Number(actualValue));
      }
    } else if (expectedEntry.kind === "decimal" && actualEntry.kind === "decimal") {
      const origin = before?.kind === "decimal" ? before.value : 0n;
      expectedValue = expectedEntry.value - origin;
      actualValue = actualEntry.value - origin;
      const difference = expectedValue >= actualValue ? expectedValue - actualValue : actualValue - expectedValue;
      const scale = expectedValue >= 0n && expectedValue > actualValue ? expectedValue : actualValue >= 0n ? actualValue : 0n;
      if (difference > 1n) error = scale > 0n ? Number(difference) / Math.max(1, Number(scale)) : 1;
    }
    if (Number.isFinite(error) && error > maxError) {
      maxError = error;
      maxPath = path;
      maxActual = actualValue;
      maxExpected = expectedValue;
    }
  }
  return { maxError, path: maxPath, actual: maxActual, expected: maxExpected };
}

function hasActiveFinitePureIdleResource(state: GameState): boolean {
  return state.entities.some((entity) => {
    if (entity.kind !== "vein" || entity.minerCount < 1 || !entity.resourceId) return false;
    return getResourceReserveSnapshot(state, entity)?.infinite === false;
  });
}

function isPureIdleLightweightStorePath(path: AffinePath): boolean {
  return (path[0] === "entities" && (path[2] === "inputs" || path[2] === "outputs")) ||
    path[0] === "tray" || path[0] === "planetTrays" ||
    (path[0] === "quantumLogisticsNetwork" && path[1] === "inventory");
}

function pureIdleLightweightStoreItemId(path: AffinePath): string | null {
  if (path[0] === "entities" && (path[2] === "inputs" || path[2] === "outputs") && typeof path[3] === "string") {
    return path[3];
  }
  if (path[0] === "tray" && typeof path[1] === "string") return path[1];
  if (path[0] === "planetTrays" && typeof path[2] === "string") return path[2];
  if (path[0] === "quantumLogisticsNetwork" && path[1] === "inventory" && typeof path[2] === "string") return path[2];
  return null;
}

function pureIdleLightweightContractItemId(path: AffinePath): string | null {
  if (path[0] === "totalProduced" && typeof path[1] === "string") return path[1];
  return pureIdleLightweightStoreItemId(path);
}

const PURE_IDLE_DELTA_MICROS_PER_ITEM = 1_000_000n;

function pureIdleDeltaMicros(delta: AffineDelta): bigint {
  return delta.kind === "decimal"
    ? (delta.delta as bigint) * PURE_IDLE_DELTA_MICROS_PER_ITEM
    : BigInt(Math.round(Number(delta.delta) * Number(PURE_IDLE_DELTA_MICROS_PER_ITEM)));
}

/**
 * Close every sampled item ledger before it can become a long-window
 * contract. Busy endgame logistics can make one individual store look stable
 * while the matching cumulative-production counter crosses a cache boundary
 * and is sampled at an unstable rate. Copying the store delta without that
 * counter creates material and correctly trips the aggregate guard later,
 * but it also collapses the whole pure-idle session to clock-only mode.
 *
 * Preserve all sampled consumption (negative store deltas) and scale only
 * positive store deltas so aggregate stock growth never exceeds the stable
 * production credit for that item. This keeps internal transfers balanced,
 * converts omitted replenishment into a finite inventory horizon, and always
 * underpays rather than inventing material.
 */
export function reconcilePureIdleLightweightMaterialDeltas(
  contract: PureIdleAffineContract,
): PureIdleAffineContract {
  const byItem = new Map<string, {
    produced: bigint;
    positiveStores: Array<{ index: number; micros: bigint }>;
    negativeStores: bigint;
  }>();
  const itemBucket = (itemId: string) => {
    let bucket = byItem.get(itemId);
    if (!bucket) {
      bucket = { produced: 0n, positiveStores: [], negativeStores: 0n };
      byItem.set(itemId, bucket);
    }
    return bucket;
  };
  contract.deltas.forEach((delta, index) => {
    if (delta.path[0] === "totalProduced" && typeof delta.path[1] === "string") {
      const micros = pureIdleDeltaMicros(delta);
      if (micros > 0n) itemBucket(delta.path[1]).produced += micros;
      return;
    }
    if (!isPureIdleLightweightStorePath(delta.path)) return;
    const itemId = pureIdleLightweightStoreItemId(delta.path);
    if (!itemId) return;
    const micros = pureIdleDeltaMicros(delta);
    const bucket = itemBucket(itemId);
    if (micros > 0n) bucket.positiveStores.push({ index, micros });
    else bucket.negativeStores += micros;
  });

  const replacements = new Map<number, AffineDelta | null>();
  for (const bucket of byItem.values()) {
    const positiveTotal = bucket.positiveStores.reduce((total, entry) => total + entry.micros, 0n);
    if (positiveTotal <= 0n) continue;
    const allowedPositive = bucket.produced - bucket.negativeStores;
    if (positiveTotal <= allowedPositive) continue;
    const boundedPositive = allowedPositive > 0n ? allowedPositive : 0n;
    for (const entry of bucket.positiveStores) {
      const original = contract.deltas[entry.index];
      const adjustedMicros = entry.micros * boundedPositive / positiveTotal;
      if (adjustedMicros <= 0n) {
        replacements.set(entry.index, null);
      } else if (original.kind === "decimal") {
        const adjustedUnits = adjustedMicros / PURE_IDLE_DELTA_MICROS_PER_ITEM;
        replacements.set(entry.index, adjustedUnits > 0n ? { ...original, delta: adjustedUnits } : null);
      } else {
        replacements.set(entry.index, {
          ...original,
          delta: Number(adjustedMicros) / Number(PURE_IDLE_DELTA_MICROS_PER_ITEM),
        });
      }
    }
  }
  if (replacements.size === 0) return contract;
  return {
    ...contract,
    deltas: contract.deltas.flatMap((delta, index) => {
      const replacement = replacements.get(index);
      return replacement === undefined ? [delta] : replacement ? [replacement] : [];
    }),
  };
}

function freezePureIdleLightweightStoreReplenishment(
  contract: PureIdleAffineContract,
): PureIdleAffineContract {
  return {
    ...contract,
    // Endgame station buffers are cyclic and individual paths can cross a
    // refill boundary immediately after calibration. Persisting their sampled
    // distribution is neither required for cumulative production/research nor
    // safe over a multi-day window. Never copy sampled replenishment into a
    // store. Retain only depletion so finite cached ingredients still stop
    // their dependent production through the item-level horizons calculated
    // before this filter. Outputs that are not retained in inventory are
    // conservatively treated as consumed inside the closed factory flow.
    deltas: contract.deltas.filter((delta) =>
      !isPureIdleLightweightStorePath(delta.path) || pureIdleDeltaMicros(delta) < 0n),
  };
}

function calculatePureIdleLightweightBoundaries(
  state: GameState,
  contract: PureIdleAffineContract,
): Record<string, number> | undefined {
  const captured = captureAggregateItemStores(state);
  if (captured.failure) return undefined;
  const microsPerUnit = 1_000_000n;
  const deltasByItem = new Map<string, bigint>();
  for (const delta of contract.deltas) {
    if (!isPureIdleLightweightStorePath(delta.path)) continue;
    const itemId = pureIdleLightweightStoreItemId(delta.path);
    if (!itemId) continue;
    const deltaMicros = delta.kind === "decimal"
      ? (delta.delta as bigint) * microsPerUnit
      : BigInt(Math.round(Number(delta.delta) * Number(microsPerUnit)));
    deltasByItem.set(itemId, (deltasByItem.get(itemId) ?? 0n) + deltaMicros);
  }
  const maximumByItem: Record<string, number> = {};
  const calibrationSeconds = BigInt(Math.max(1, Math.floor(contract.calibrationSeconds)));
  for (const [itemId, deltaMicros] of deltasByItem) {
    if (deltaMicros >= 0n) continue;
    const available = captured.totals.get(itemId) ?? 0n;
    const seconds = available * calibrationSeconds * microsPerUnit / -deltaMicros;
    if (seconds <= BigInt(Number.MAX_SAFE_INTEGER)) maximumByItem[itemId] = Math.max(0, Number(seconds));
  }
  // A product cannot keep receiving cumulative-production credit after one
  // of the sampled ingredients that funds it has reached its boundary. This
  // deliberately chooses the shortest active-producer path when several
  // recipes make the same item: under-crediting is acceptable in the compact
  // fallback, reusing a finite cache to manufacture indefinitely is not.
  const activeRecipeEdges = state.entities.flatMap((entity) => {
    if (entity.productionRate <= EPSILON) return [];
    const recipe = getRecipe(entity.recipeId);
    if (!recipe || recipe.outputs.length === 0) return [];
    return recipe.outputs
      .filter((output) => !PURE_IDLE_LIGHTWEIGHT_FROZEN_ITEMS.has(output.itemId))
      .map((output) => ({
        outputItemId: output.itemId,
        inputItemIds: recipe.inputs.map((input) => input.itemId),
      }));
  });
  for (let pass = 0; pass < Object.keys(ITEMS).length; pass += 1) {
    let changed = false;
    for (const edge of activeRecipeEdges) {
      const finiteInputs = edge.inputItemIds
        .map((itemId) => maximumByItem[itemId])
        .filter((seconds): seconds is number => seconds !== undefined);
      if (finiteInputs.length === 0) continue;
      const inherited = Math.min(...finiteInputs);
      const current = maximumByItem[edge.outputItemId];
      if (current === undefined || inherited < current) {
        maximumByItem[edge.outputItemId] = inherited;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return Object.keys(maximumByItem).length > 0 ? maximumByItem : undefined;
}

function createFastAffineContractFromSnapshots(
  snapshots: AffineSnapshot[],
  calibrationSeconds: number,
  calibrationWallSeconds: number,
  excludePureIdleTransientPaths = false,
): PureIdleAffineContract | null {
  if (snapshots.length < 2 || calibrationSeconds <= 0 || calibrationWallSeconds <= 0) return null;
  const keys = new Set<string>(snapshots.flatMap((snapshot) => [...snapshot.entries.keys()]));
  const pathFor = (key: string): AffinePath | undefined =>
    snapshots.find((snapshot) => snapshot.paths.has(key))?.paths.get(key);
  const resolveEntry = (snapshot: AffineSnapshot, key: string, fallback?: AffineEntry): AffineEntry | undefined => {
    const current = snapshot.entries.get(key);
    if (current) return current;
    const path = pathFor(key);
    if (!path || !fallback || (fallback.kind !== "number" && fallback.kind !== "decimal") ||
      !path.some((part) => typeof part === "string" && AFFINE_DYNAMIC_MAP_KEYS.has(part))) return undefined;
    return fallback.kind === "number"
      ? { kind: "number", value: 0, integer: fallback.integer }
      : { kind: "decimal", value: 0n };
  };
  const deltas: AffineDelta[] = [];
  const intervalSeconds = calibrationSeconds / (snapshots.length - 1);
  for (const key of keys) {
    const fallback = snapshots.map((snapshot) => snapshot.entries.get(key)).find((entry) =>
      entry?.kind === "number" || entry?.kind === "decimal");
    const entries = snapshots.map((snapshot) => resolveEntry(snapshot, key, fallback));
    if (entries.some((entry) => !entry || (entry.kind !== "number" && entry.kind !== "decimal"))) continue;
    const first = entries[0]!;
    const path = pathFor(key);
    if (!path) continue;
    if (excludePureIdleTransientPaths && isPureIdleTransientPath(path)) continue;
    if (first.kind === "number" && entries.every((entry) => entry?.kind === "number")) {
      const numericEntries = entries as Array<Extract<AffineEntry, { kind: "number" }>>;
      const intervalRates = numericEntries.slice(1).map((entry, index) => (entry.value - numericEntries[index].value) / intervalSeconds);
      const tailRate = intervalRates.at(-1) ?? 0;
      const tailStable = intervalRates.length < 2 || stableRate(intervalRates.at(-2) ?? tailRate, tailRate);
      const unstable = intervalRates.some((rate) => !Number.isFinite(rate)) || !tailStable;
      const useTailRate = pathHasString(path, FAST_TAIL_RATE_KEYS) && Number.isFinite(tailRate);
      if (unstable) {
        // A busy factory may cross a cache boundary during calibration. Use
        // the most recent measured rate for cumulative counters and let the
        // five-second exact verifier reject it if the error is unsafe. Stable
        // structural/position fields are simply left at the calibration copy.
        if (Number.isFinite(tailRate) && (useTailRate || isFastSensitivePath(path))) {
          deltas.push({ path, kind: "number", delta: tailRate * calibrationSeconds, integer: numericEntries.every((entry) => entry.integer) });
        }
        continue;
      }
      // The first ten seconds can contain a belt/cache warm-up. Once the last
      // two windows agree, extrapolate the measured steady tail rate from the
      // thirty-second calibration baseline instead of replaying warm-up noise.
      const delta = tailStable && intervalRates.length >= 2 && !stableRate(intervalRates[0] ?? tailRate, tailRate)
        ? tailRate * calibrationSeconds
        : numericEntries.at(-1)!.value - numericEntries[0].value;
      deltas.push({
        path,
        kind: "number",
        delta,
        integer: numericEntries.every((entry) => entry.integer),
      });
      continue;
    }
    if (first.kind === "decimal" && entries.every((entry) => entry?.kind === "decimal")) {
      const decimalEntries = entries as Array<Extract<AffineEntry, { kind: "decimal" }>>;
      const intervalRates = decimalEntries.slice(1).map((entry, index) => entry.value - decimalEntries[index].value);
      if (intervalRates.some((rate) => rate !== intervalRates[0])) {
        if (isFastSensitivePath(path)) {
          const tailRate = intervalRates.at(-1) ?? 0n;
          deltas.push({ path, kind: "decimal", delta: tailRate * BigInt(snapshots.length - 1) });
        }
        continue;
      }
      deltas.push({ path, kind: "decimal", delta: decimalEntries.at(-1)!.value - decimalEntries[0].value });
    }
  }
  if (deltas.length === 0) return null;
  return { deltas, calibrationSeconds, calibrationWallSeconds };
}

function createFastAffineContract(
  states: GameState[],
  calibrationSeconds: number,
  calibrationWallSeconds: number,
): PureIdleAffineContract | null {
  const contract = createFastAffineContractFromSnapshots(
    states.map((state) => captureAffineSnapshot(state)),
    calibrationSeconds,
    calibrationWallSeconds,
  );
  return contract ? removeResearchInputDeltas(contract, states[0]) : null;
}

function removeResearchInputDeltas(
  contract: PureIdleAffineContract,
  state: GameState,
): PureIdleAffineContract {
  const researchIndexes = new Set(state.entities
    .map((entity, index) => entity.recipeId === "matrix_research" ? index : -1)
    .filter((index) => index >= 0));
  if (researchIndexes.size === 0) return contract;
  return {
    ...contract,
    deltas: contract.deltas.filter((delta) => !(
      delta.path[0] === "entities" &&
      typeof delta.path[1] === "number" &&
      researchIndexes.has(delta.path[1]) &&
      delta.path[2] === "inputs"
    )),
  };
}

function divideBigIntTowardZero(value: bigint, divisor: bigint): bigint {
  if (divisor === 0n) throw new Error("zero divisor");
  return value / divisor;
}

function scaleFastSeconds(path: AffinePath, simulationSeconds: number, wallSeconds: number): number {
  // Speedrun clocks are wall-time clocks. Time-warp may increase simulation
  // seconds but must never multiply the persisted speedrun timer.
  return pathHasString(path, new Set(["elapsedActiveSeconds"])) ? wallSeconds : simulationSeconds;
}

interface FastContractApplicationResult {
  ok: boolean;
  failure?: string;
  corrections?: number;
}

function applyFastAffineContract(
  state: GameState,
  contract: PureIdleAffineContract,
  simulationSeconds: number,
  wallSeconds: number,
  rejectPureIdleTransientPaths = false,
  skipUnsafeIntegerPaths = false,
  integerRemainders?: Record<string, number>,
  decimalRemainders?: Record<string, bigint>,
  simulationSecondsByItem?: Record<string, number>,
): FastContractApplicationResult {
  if (!Number.isFinite(simulationSeconds) || simulationSeconds < 0 || !Number.isFinite(wallSeconds) || wallSeconds < 0) {
    return { ok: false, failure: "时间参数非法" };
  }
  let corrections = 0;
  for (const delta of contract.deltas) {
    if (rejectPureIdleTransientPaths && isPureIdleTransientPath(delta.path)) {
      return { ok: false, failure: `宏观合同包含不允许外推的瞬时字段 ${JSON.stringify(delta.path)}` };
    }
    const current = readAffinePath(state, delta.path);
    const itemId = pureIdleLightweightContractItemId(delta.path);
    const sampledSeconds = itemId && simulationSecondsByItem?.[itemId] !== undefined
      ? Math.max(0, Math.min(simulationSeconds, finiteNumber(simulationSecondsByItem[itemId])))
      : simulationSeconds;
    const sampledWallSeconds = simulationSeconds > EPSILON
      ? wallSeconds * sampledSeconds / simulationSeconds
      : 0;
    const scaledSeconds = scaleFastSeconds(delta.path, sampledSeconds, sampledWallSeconds);
    const denominator = pathHasString(delta.path, new Set(["elapsedActiveSeconds"]))
      ? contract.calibrationWallSeconds
      : contract.calibrationSeconds;
    const pathLabel = JSON.stringify(delta.path);
    if (delta.kind === "number") {
      const base = current === undefined && isDynamicMapEntryPath(delta.path) ? 0 : current;
      if (typeof base !== "number" || !Number.isFinite(base)) {
        return { ok: false, failure: `数值字段不可用 ${pathLabel}` };
      }
      const next = base + Number(delta.delta) * scaledSeconds / denominator;
      if (!Number.isFinite(next)) return { ok: false, failure: `预测结果非有限数值 ${pathLabel}` };
      const carried = delta.integer ? finiteNumber(integerRemainders?.[pathLabel]) : 0;
      const carriedNext = next + carried;
      if (!Number.isFinite(carriedNext)) return { ok: false, failure: `预测结果非有限数值 ${pathLabel}` };
      const requiresSafeInteger = Boolean(delta.integer) && !isFastFiniteFloatPath(delta.path);
      const normalized = requiresSafeInteger ? Math.floor(carriedNext + EPSILON) : carriedNext;
      if (requiresSafeInteger && !Number.isSafeInteger(normalized)) {
        if (skipUnsafeIntegerPaths) {
          // A single saturated cumulative counter must not freeze every other
          // safe output in a large-save conservative tail.  Leave this field
          // at its last exact checkpoint and account for the bounded loss as a
          // correction; the next exact save can still preserve its value.
          corrections += 1;
          if (integerRemainders) delete integerRemainders[pathLabel];
          continue;
        }
        return { ok: false, failure: `预测结果超过安全整数 ${pathLabel}=${String(normalized)}` };
      }
      if (!writeAffinePath(state, delta.path, normalized)) return { ok: false, failure: `无法写入字段 ${pathLabel}` };
      if (integerRemainders && requiresSafeInteger) {
        const remainder = carriedNext - normalized;
        if (remainder > EPSILON && remainder < 1) integerRemainders[pathLabel] = remainder;
        else delete integerRemainders[pathLabel];
      }
      continue;
    }
    const base = current === undefined && isDynamicMapEntryPath(delta.path) ? "0" : current;
    if (typeof base !== "string" || !/^\d+$/.test(base)) {
      return { ok: false, failure: `十进制字段不可用 ${pathLabel}` };
    }
    try {
      const decimalDenominator = BigInt(Math.max(1, Math.floor(denominator)));
      const numerator = BigInt(Math.max(0, Math.floor(scaledSeconds))) * (delta.delta as bigint) +
        (decimalRemainders?.[pathLabel] ?? 0n);
      const scaled = divideBigIntTowardZero(numerator, decimalDenominator);
      const next = BigInt(base) + scaled;
      if (next < 0n) {
        // Decimal inventory fields are non-negative stores.  A linear tail
        // can overshoot after the store is exhausted; stop at zero and let
        // the exact validation window decide whether the approximation is
        // still within the allowed error budget.
        if (isDecimalAffinePath(delta.path)) {
          if (!writeAffinePath(state, delta.path, "0")) return { ok: false, failure: `无法写入十进制字段 ${pathLabel}` };
          if (decimalRemainders) delete decimalRemainders[pathLabel];
          corrections += 1;
          continue;
        }
        return { ok: false, failure: `十进制字段变为负数 ${pathLabel}` };
      }
      if (!writeAffinePath(state, delta.path, next.toString())) return { ok: false, failure: `无法写入十进制字段 ${pathLabel}` };
      if (decimalRemainders) {
        const remainder = numerator - scaled * decimalDenominator;
        if (remainder !== 0n) decimalRemainders[pathLabel] = remainder;
        else delete decimalRemainders[pathLabel];
      }
    } catch {
      return { ok: false, failure: `十进制字段计算失败 ${pathLabel}` };
    }
  }
  return { ok: true, corrections };
}

export interface PureIdleAffineCalibration {
  contract: PureIdleAffineContract;
  researchLedger: ResearchMacroLedger;
  /** Temporary shadow result used only to derive diagnostics, then released. */
  calibratedState: GameState;
  calibrationSeconds: number;
  calibrationWallSeconds: number;
}

export interface PureIdleLightweightCalibrationOptions {
  /**
   * Measure ordinary production without construction-center consumption.
   * Callers that enable this must advance construction separately through
   * advanceConstructionAutomationMacroInPlace so building outputs and their
   * recursive material costs remain one authoritative transaction.
   */
  isolateConstructionAutomation?: boolean;
}

export interface PureIdleAffineApplication {
  ok: boolean;
  boundaryCorrections: number;
  failure?: string;
  /** Simulation time already advanced by the ordinary exact engine. */
  exactSimulationSeconds?: number;
}

export interface PureIdleAffineApplicationOptions {
  /**
   * Permit the historical exact replay when a finite-resource or capacity
   * invariant rejects the affine candidate.  Conservative large-save callers
   * must set this to false so a one-second probe can never expand into a
   * multi-day replay.
   */
  allowExactFallback?: boolean;
  /** Skip only saturated integer counters while retaining other safe deltas. */
  skipUnsafeIntegerPaths?: boolean;
  /** Worker-only fractional carry for repeated integer counter buckets. */
  integerRemainders?: Record<string, number>;
  /** Worker-only exact carry for repeated decimal inventory buckets. */
  decimalRemainders?: Record<string, bigint>;
  /** Optional per-item credited duration for the lightweight contract. */
  simulationSecondsByItem?: Record<string, number>;
}

type ItemStore = Partial<Record<string, number | string>>;

interface AggregateItemStoreCapture {
  totals: Map<string, bigint>;
  failure?: string;
}

function aggregateItemAmount(raw: unknown): bigint | null {
  try {
    if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null;
    return typeof raw === "string" && /^(0|[1-9]\d*)$/.test(raw) ? BigInt(raw) : null;
  } catch {
    return null;
  }
}

function addAggregateAmount(totals: Map<string, bigint>, itemId: string, amount: bigint): void {
  totals.set(itemId, (totals.get(itemId) ?? 0n) + amount);
}

function addAggregateStore(
  totals: Map<string, bigint>,
  store: ItemStore | undefined,
  seen: Set<object>,
  label: string,
): string | null {
  if (!store || typeof store !== "object" || seen.has(store)) return null;
  seen.add(store);
  for (const [itemId, raw] of Object.entries(store)) {
    const amount = aggregateItemAmount(raw);
    if (amount === null) return `${label}.${itemId} 不是非负安全整数`;
    addAggregateAmount(totals, itemId, amount);
  }
  return null;
}

/**
 * Aggregate every persisted item ownership location once. This is a safety
 * invariant, not a production estimator: transfers between locations cancel
 * out, while a net increase must be backed by a production counter delta.
 * Belt progress is transport credit rather than cargo. Legacy StationRoute
 * cargo is reserved in the source output until arrival, so the source reserve
 * is replaced by (not added to) the explicit in-flight route amount.
 */
function captureAggregateItemStores(state: GameState): AggregateItemStoreCapture {
  const totals = new Map<string, bigint>();
  const seen = new Set<object>();
  let failure: string | undefined;
  const addStore = (store: ItemStore | undefined, label: string): void => {
    failure ??= addAggregateStore(totals, store, seen, label) ?? undefined;
  };

  // `tray` is the authoritative active-planet view. Serialized JSON cannot
  // preserve its runtime alias to planetTrays, so skip the active duplicate.
  addStore(state.tray, "tray");
  for (const [planetId, tray] of Object.entries(state.planetTrays)) {
    if (planetId !== state.activePlanetId) addStore(tray, `planetTrays.${planetId}`);
  }

  const entityById = new Map(state.entities.map((entity) => [entity.id, entity]));
  const routeReservations = new Map<string, Map<string, bigint>>();
  const seenRouteIds = new Set<string>();
  for (const entity of state.entities) {
    addStore(entity.inputs, `entities.${entity.id}.inputs`);
    addStore(entity.outputs, `entities.${entity.id}.outputs`);
    if (Number.isSafeInteger(entity.stationWarpers) && (entity.stationWarpers ?? 0) >= 0) {
      addAggregateAmount(totals, "space_warper", BigInt(entity.stationWarpers ?? 0));
    }
    if (Number.isSafeInteger(entity.stationDrones) && (entity.stationDrones ?? 0) >= 0) {
      addAggregateAmount(totals, "logistics_drone", BigInt(entity.stationDrones ?? 0));
    }
    if (Number.isSafeInteger(entity.stationVessels) && (entity.stationVessels ?? 0) >= 0) {
      addAggregateAmount(totals, "logistics_vessel", BigInt(entity.stationVessels ?? 0));
    }
    for (const route of entity.stationRoutes ?? []) {
      if (seenRouteIds.has(route.id)) continue;
      seenRouteIds.add(route.id);
      const cargo = aggregateItemAmount(route.cargo);
      if (cargo === null) {
        failure ??= `stationRoutes.${route.id}.cargo 不是非负安全整数`;
        continue;
      }
      addAggregateAmount(totals, route.itemId, cargo);
      let byItem = routeReservations.get(route.peerId);
      if (!byItem) routeReservations.set(route.peerId, byItem = new Map());
      byItem.set(route.itemId, (byItem.get(route.itemId) ?? 0n) + cargo);
    }
  }

  // A route's cargo remains reserved in its supply endpoint output. Replace
  // the reserved part with the route ledger so it is represented exactly once.
  for (const [sourceId, byItem] of routeReservations) {
    const source = entityById.get(sourceId);
    for (const [itemId, reserved] of byItem) {
      const sourceAmount = aggregateItemAmount(source?.outputs?.[itemId as ItemId]) ?? 0n;
      addAggregateAmount(totals, itemId, -(reserved < sourceAmount ? reserved : sourceAmount));
    }
  }

  addStore(state.construction as ItemStore, "construction");
  for (const [jobId, job] of Object.entries(state.constructionAutomation.jobs)) addStore(job.inventory, `constructionAutomation.jobs.${jobId}.inventory`);
  for (const [entityId, inventory] of Object.entries(state.constructionAutomation.quantumMaterialBuffer ?? {})) {
    addStore(inventory, `constructionAutomation.quantumMaterialBuffer.${entityId}`);
  }
  for (const entry of state.constructionQueue) {
    addStore(entry.reservedConstruction as ItemStore | undefined, `constructionQueue.${entry.id}.reservedConstruction`);
    addStore(entry.reservedFleet as ItemStore | undefined, `constructionQueue.${entry.id}.reservedFleet`);
  }
  addStore(state.portableFleet, "portableFleet");
  if (state.cargo && Number.isSafeInteger(state.cargo.amount) && state.cargo.amount >= 0) {
    addAggregateAmount(totals, state.cargo.itemId, BigInt(state.cargo.amount));
  }
  addStore(state.quantumLogisticsNetwork.inventory, "quantumLogisticsNetwork.inventory");
  for (const [systemId, station] of Object.entries(state.systemSpaceStations)) {
    if (!station) continue;
    addStore(station.inventory, `systemSpaceStations.${systemId}.inventory`);
    addStore(station.constructionBuffer, `systemSpaceStations.${systemId}.constructionBuffer`);
  }
  const hubWarpers = aggregateItemAmount(state.galacticHubNetwork.warpers);
  if (hubWarpers === null) failure ??= "galacticHubNetwork.warpers 不是非负整数";
  else addAggregateAmount(totals, "space_warper", hubWarpers);
  for (const batch of Object.values(state.endgame.constructionActivity.pendingBatches)) {
    if (batch && Number.isSafeInteger(batch.amount) && batch.amount >= 0) {
      addAggregateAmount(totals, batch.itemId, BigInt(batch.amount));
    } else if (batch) {
      failure ??= `constructionActivity.pendingBatches.${batch.id}.amount 不是非负安全整数`;
    }
  }
  return { totals, ...(failure ? { failure } : {}) };
}

interface AggregateConservationBaseline {
  totals: Map<string, bigint>;
  totalProduced: Map<string, bigint>;
  knownConsumed: Map<string, bigint>;
  failure?: string;
}

function captureKnownMaterialConsumption(state: GameState): { totals: Map<string, bigint>; failure?: string } {
  const totals = new Map<string, bigint>();
  let failure: string | undefined;
  const addCounter = (itemId: string, raw: unknown, label: string): void => {
    const amount = aggregateItemAmount(raw ?? 0);
    if (amount === null) failure ??= `${label} 不是非负安全整数`;
    else addAggregateAmount(totals, itemId, amount);
  };
  for (const definition of GALACTIC_EXPORT_DEFINITIONS) {
    addCounter(definition.itemId, state.endgame.exportProjects[definition.id]?.totalDelivered,
      `endgame.exportProjects.${definition.id}.totalDelivered`);
  }
  for (const [itemId, amount] of Object.entries(state.orbitalStation?.totals?.exportedByItem ?? {})) {
    addCounter(itemId, amount, `orbitalStation.totals.exportedByItem.${itemId}`);
  }
  for (const stage of state.orbitalStation?.construction?.stageRequirements ?? []) {
    for (const [itemId, amount] of Object.entries(stage.delivered)) {
      addCounter(itemId, amount, `orbitalStation.construction.${stage.stageId}.delivered.${itemId}`);
    }
  }
  for (const [itemId, amount] of Object.entries(state.endgame.constructionActivity.personalDelivered)) {
    addCounter(itemId, amount, `endgame.constructionActivity.personalDelivered.${itemId}`);
  }
  for (const [itemId, amount] of Object.entries(state.constructionAutomation.destroyedByproducts)) {
    addCounter(itemId, amount, `constructionAutomation.destroyedByproducts.${itemId}`);
  }
  for (const [systemId, station] of Object.entries(state.systemSpaceStations)) {
    if (!station) continue;
    for (const [itemId, amount] of Object.entries(station.delivered)) {
      addCounter(itemId, amount, `systemSpaceStations.${systemId}.delivered.${itemId}`);
    }
  }
  for (const entity of state.entities) {
    for (const port of entity.blackHolePorts ?? []) {
      if (port.currentItemId) addCounter(port.currentItemId, port.totalDestroyed,
        `entities.${entity.id}.blackHolePorts.${port.index}.totalDestroyed`);
    }
  }
  return { totals, ...(failure ? { failure } : {}) };
}

function captureAggregateConservationBaseline(state: GameState): AggregateConservationBaseline {
  const totalProduced = new Map<string, bigint>();
  for (const [itemId, raw] of Object.entries(state.totalProduced)) {
    if (Number.isSafeInteger(raw) && raw >= 0) totalProduced.set(itemId, BigInt(raw));
  }
  const captured = captureAggregateItemStores(state);
  const consumed = captureKnownMaterialConsumption(state);
  const failure = captured.failure ?? consumed.failure;
  return {
    totals: captured.totals,
    totalProduced,
    knownConsumed: consumed.totals,
    ...(failure ? { failure } : {}),
  };
}

function validateAggregateConservation(before: AggregateConservationBaseline, after: GameState): string | null {
  if (before.failure) return `物资守恒基线无效：${before.failure}`;
  const capturedAfter = captureAggregateItemStores(after);
  if (capturedAfter.failure) return `物资守恒候选无效：${capturedAfter.failure}`;
  const consumedAfter = captureKnownMaterialConsumption(after);
  if (consumedAfter.failure) return `物资守恒候选无效：${consumedAfter.failure}`;
  const afterTotals = capturedAfter.totals;
  const itemIds = new Set([
    ...before.totals.keys(), ...afterTotals.keys(), ...before.totalProduced.keys(), ...Object.keys(after.totalProduced),
    ...before.knownConsumed.keys(), ...consumedAfter.totals.keys(),
  ]);
  for (const itemId of itemIds) {
    const stockDelta = (afterTotals.get(itemId) ?? 0n) - (before.totals.get(itemId) ?? 0n);
    const producedDelta = BigInt(Math.max(0, Math.floor(finiteNumber(after.totalProduced[itemId as ItemId])))) -
      (before.totalProduced.get(itemId) ?? 0n);
    const consumedDelta = (consumedAfter.totals.get(itemId) ?? 0n) - (before.knownConsumed.get(itemId) ?? 0n);
    if (producedDelta < 0n) return `物资守恒失败：${itemId} 的累计生产发生回退`;
    if (consumedDelta < 0n) return `物资守恒失败：${itemId} 的累计出口/销毁/交付发生回退`;
    if (stockDelta > producedDelta) {
      return `物资守恒失败：${itemId} 库存净增 ${stockDelta.toString()} 超过累计生产增量 ${producedDelta.toString()}`;
    }
    if (consumedDelta > producedDelta - stockDelta) {
      return `物资守恒失败：${itemId} 出口/销毁/交付 ${consumedDelta.toString()} 超过生产与库存来源 ${(producedDelta - stockDelta).toString()}`;
    }
  }
  return null;
}

const PURE_IDLE_TERMINAL_MATERIALS = ["small_carrier_rocket", "solar_sail"] as const;
type PureIdleTerminalMaterialId = typeof PURE_IDLE_TERMINAL_MATERIALS[number];

function ledgerCounter(value: unknown, label: string): bigint {
  const parsed = aggregateItemAmount(value);
  if (parsed === null) throw new Error(`${label} 不是非负安全整数`);
  return parsed;
}

function knownTerminalConsumption(state: GameState, itemId: PureIdleTerminalMaterialId): bigint {
  let total = 0n;
  for (const definition of GALACTIC_EXPORT_DEFINITIONS) {
    if (definition.itemId !== itemId) continue;
    total += ledgerCounter(state.endgame.exportProjects[definition.id]?.totalDelivered ?? 0,
      `endgame.exportProjects.${definition.id}.totalDelivered`);
  }
  total += ledgerCounter(state.orbitalStation?.totals?.exportedByItem?.[itemId] ?? "0",
    `orbitalStation.totals.exportedByItem.${itemId}`);
  for (const stage of state.orbitalStation?.construction?.stageRequirements ?? []) {
    total += ledgerCounter(stage.delivered[itemId] ?? "0",
      `orbitalStation.construction.${stage.stageId}.delivered.${itemId}`);
  }
  total += ledgerCounter(state.endgame.constructionActivity.personalDelivered[itemId] ?? 0,
    `endgame.constructionActivity.personalDelivered.${itemId}`);
  total += ledgerCounter(state.constructionAutomation.destroyedByproducts[itemId] ?? 0,
    `constructionAutomation.destroyedByproducts.${itemId}`);
  for (const entity of state.entities) {
    for (const port of entity.blackHolePorts ?? []) {
      if (port.currentItemId === itemId) {
        total += ledgerCounter(port.totalDestroyed, `entities.${entity.id}.blackHolePorts.${port.index}.totalDestroyed`);
      }
    }
  }
  for (const [systemId, station] of Object.entries(state.systemSpaceStations)) {
    if (station) total += ledgerCounter(station.delivered[itemId] ?? "0", `systemSpaceStations.${systemId}.delivered.${itemId}`);
  }
  return total;
}

function sumDysonPlans(state: GameState, field: "structurePoints" | "shellSails"): bigint {
  return Object.entries(state.dysonPlans).reduce((sum, [systemId, plan]) =>
    sum + ledgerCounter(plan[field], `dysonPlans.${systemId}.${field}`), 0n);
}

function sumDysonOrbits(state: GameState, field: "sailsInOrbit" | "totalLaunched" | "totalExpired"): bigint {
  let total = 0n;
  for (const [systemId, orbits] of Object.entries(state.dysonEngineering.orbitsBySystem)) {
    for (const orbit of orbits ?? []) total += ledgerCounter(orbit[field], `dysonEngineering.orbitsBySystem.${systemId}.${orbit.id}.${field}`);
  }
  return total;
}

/**
 * Closed material ledger for leaderboard-facing pure-idle terminal results.
 * A failure means the whole affine candidate must be discarded; callers may
 * replay exactly or freeze from their last acknowledged checkpoint.
 */
export function validatePureIdleTerminalMaterialConservation(before: GameState, after: GameState): string | null {
  try {
    const beforeStocks = captureAggregateItemStores(before);
    const afterStocks = captureAggregateItemStores(after);
    if (beforeStocks.failure) return `终端物资守恒基线无效：${beforeStocks.failure}`;
    if (afterStocks.failure) return `终端物资守恒候选无效：${afterStocks.failure}`;

    const rocketLaunchDelta = ledgerCounter(after.dysonSphere.totalRocketsLaunched, "dysonSphere.totalRocketsLaunched") -
      ledgerCounter(before.dysonSphere.totalRocketsLaunched, "dysonSphere.totalRocketsLaunched");
    const structureDelta = ledgerCounter(after.dysonSphere.structurePoints, "dysonSphere.structurePoints") -
      ledgerCounter(before.dysonSphere.structurePoints, "dysonSphere.structurePoints");
    const sailLaunchDelta = ledgerCounter(after.dysonSwarm.totalLaunched, "dysonSwarm.totalLaunched") -
      ledgerCounter(before.dysonSwarm.totalLaunched, "dysonSwarm.totalLaunched");
    const sailExpiredDelta = ledgerCounter(after.dysonSwarm.totalExpired, "dysonSwarm.totalExpired") -
      ledgerCounter(before.dysonSwarm.totalExpired, "dysonSwarm.totalExpired");
    const sailAbsorbedDelta = ledgerCounter(after.dysonSphere.totalSailsAbsorbed, "dysonSphere.totalSailsAbsorbed") -
      ledgerCounter(before.dysonSphere.totalSailsAbsorbed, "dysonSphere.totalSailsAbsorbed");
    const shellDelta = ledgerCounter(after.dysonSphere.shellSails, "dysonSphere.shellSails") -
      ledgerCounter(before.dysonSphere.shellSails, "dysonSphere.shellSails");
    const orbitStockDelta = ledgerCounter(after.dysonSwarm.sailsInOrbit, "dysonSwarm.sailsInOrbit") -
      ledgerCounter(before.dysonSwarm.sailsInOrbit, "dysonSwarm.sailsInOrbit");

    for (const [label, delta] of [
      ["火箭发射", rocketLaunchDelta], ["结构点", structureDelta], ["太阳帆发射", sailLaunchDelta],
      ["太阳帆过期", sailExpiredDelta], ["太阳帆吸附", sailAbsorbedDelta], ["壳面帆", shellDelta],
    ] as const) {
      if (delta < 0n) return `终端物资守恒失败：${label}累计值发生回退`;
    }

    if (structureDelta !== rocketLaunchDelta) {
      return `终端物资守恒失败：结构点增量 ${structureDelta} 与合法火箭发射增量 ${rocketLaunchDelta} 不一致`;
    }
    if (shellDelta !== sailAbsorbedDelta) {
      return `终端物资守恒失败：壳面帆增量 ${shellDelta} 与太阳帆吸附增量 ${sailAbsorbedDelta} 不一致`;
    }
    if (sailLaunchDelta !== orbitStockDelta + sailExpiredDelta + sailAbsorbedDelta) {
      return `终端物资守恒失败：太阳帆发射 ${sailLaunchDelta} 无法闭合在轨、过期和吸附流量`;
    }

    const planStructureDelta = sumDysonPlans(after, "structurePoints") - sumDysonPlans(before, "structurePoints");
    const planShellDelta = sumDysonPlans(after, "shellSails") - sumDysonPlans(before, "shellSails");
    if (planStructureDelta !== structureDelta) {
      return `终端物资守恒失败：各恒星系结构增量 ${planStructureDelta} 与全局增量 ${structureDelta} 不一致`;
    }
    if (planShellDelta !== shellDelta) {
      return `终端物资守恒失败：各恒星系壳面增量 ${planShellDelta} 与全局增量 ${shellDelta} 不一致`;
    }
    for (const field of ["sailsInOrbit", "totalLaunched", "totalExpired"] as const) {
      const systemDelta = sumDysonOrbits(after, field) - sumDysonOrbits(before, field);
      const globalDelta = ledgerCounter(after.dysonSwarm[field], `dysonSwarm.${field}`) -
        ledgerCounter(before.dysonSwarm[field], `dysonSwarm.${field}`);
      if (systemDelta !== globalDelta) {
        return `终端物资守恒失败：各恒星系太阳帆 ${field} 增量 ${systemDelta} 与全局增量 ${globalDelta} 不一致`;
      }
    }

    const launchedByItem: Record<PureIdleTerminalMaterialId, bigint> = {
      small_carrier_rocket: rocketLaunchDelta,
      solar_sail: sailLaunchDelta,
    };
    for (const itemId of PURE_IDLE_TERMINAL_MATERIALS) {
      const producedDelta = ledgerCounter(after.totalProduced[itemId] ?? 0, `totalProduced.${itemId}`) -
        ledgerCounter(before.totalProduced[itemId] ?? 0, `totalProduced.${itemId}`);
      const consumedDelta = knownTerminalConsumption(after, itemId) - knownTerminalConsumption(before, itemId);
      if (producedDelta < 0n || consumedDelta < 0n) {
        return `终端物资守恒失败：${itemId} 的累计生产或已知消耗发生回退`;
      }
      const available = producedDelta + (beforeStocks.totals.get(itemId) ?? 0n) - (afterStocks.totals.get(itemId) ?? 0n);
      const used = launchedByItem[itemId] + consumedDelta;
      if (used > available) {
        return `终端物资守恒失败：${itemId} 发射/出口/销毁 ${used} 超过生产与库存来源 ${available}`;
      }
    }
    return null;
  } catch (error) {
    return `终端物资守恒失败：${error instanceof Error ? error.message : "计数器无法读取"}`;
  }
}

function veinConsumptionTenths(state: GameState, itemId: ItemId): number {
  return ITEMS[itemId]?.kind === "solid"
    ? Math.max(0, Math.round(getVeinConsumptionMultiplier(state) * 10))
    : 10;
}

function hasAlternativeResourceProducer(state: GameState, itemId: ItemId): boolean {
  return state.entities.some((entity) => {
    if (entity.kind === "vein" && entity.resourceId === itemId && entity.minerCount > 0) {
      return getResourceReserveSnapshot(state, entity)?.infinite === true;
    }
    if (entity.buildingId === "orbital_collector" && entity.storedItemId === itemId && entity.machineCount > 0) return true;
    const recipe = entity.recipeId ? getRecipe(entity.recipeId) : undefined;
    return entity.machineCount > 0 && Boolean(recipe?.outputs.some((output) => output.itemId === itemId));
  });
}

/**
 * Couple each finite miner to material that the affine candidate can still
 * trace at its output or across one of its outgoing belts. A capacity boundary
 * can clamp a cache while a cumulative counter keeps growing; that interval is
 * unsafe for extrapolation and must be replayed by the ordinary exact engine.
 */
function reconcilePureIdleFiniteResources(before: GameState, candidate: GameState): string | null {
  const beforeBelts = new Map(before.belts.map((belt) => [belt.id, belt]));
  const tracedByItem = new Map<ItemId, number>();
  const finiteItems = new Set<ItemId>();
  const itemsWithOutgoingBelts = new Set<ItemId>();

  for (const beforeEntity of before.entities) {
    if (beforeEntity.kind !== "vein" || !beforeEntity.resourceId || beforeEntity.minerCount < 1) continue;
    const reserve = getResourceReserveSnapshot(before, beforeEntity);
    if (!reserve || reserve.infinite) continue;
    const afterEntity = candidate.entities.find((entity) => entity.id === beforeEntity.id);
    if (!afterEntity || afterEntity.kind !== "vein" || afterEntity.resourceId !== beforeEntity.resourceId) {
      return `矿脉实体 ${beforeEntity.id} 在纯挂机结算中丢失`;
    }
    const itemId = beforeEntity.resourceId;
    const beforeConsumption = veinConsumptionTenths(before, itemId);
    const afterConsumption = veinConsumptionTenths(candidate, itemId);
    if (beforeConsumption !== afterConsumption) return `矿脉 ${beforeEntity.id} 的采集消耗倍率跨越了结算边界`;
    if (beforeConsumption <= 0) continue;

    const beforeOutput = Math.floor(beforeEntity.outputs[itemId] ?? 0);
    const outputDelta = Math.floor(afterEntity.outputs[itemId] ?? 0) - beforeOutput;
    let transferredDelta = 0;
    for (const afterBelt of candidate.belts) {
      if (afterBelt.source !== beforeEntity.id || afterBelt.itemId !== itemId) continue;
      const beforeBelt = beforeBelts.get(afterBelt.id);
      if (!beforeBelt || beforeBelt.source !== afterBelt.source || beforeBelt.itemId !== afterBelt.itemId) {
        return `矿脉 ${beforeEntity.id} 的输出传送带结构发生变化`;
      }
      itemsWithOutgoingBelts.add(itemId);
      const delta = Math.floor(afterBelt.totalTransferred ?? 0) - Math.floor(beforeBelt.totalTransferred ?? 0);
      if (delta < 0) return `矿脉 ${beforeEntity.id} 的传送带累计量发生回退`;
      transferredDelta += delta;
    }
    let tracedProduction = Math.max(0, outputDelta + transferredDelta);
    const beforeRemaining = Math.max(0, Math.floor(beforeEntity.resourceRemaining ?? 0));
    const beforeRemainder = Math.max(0, Math.min(9, Math.floor(beforeEntity.resourceDepletionRemainder ?? 0)));
    const availableTenths = Math.max(0, beforeRemaining * 10 - beforeRemainder);
    if (tracedProduction * beforeConsumption > availableTenths) {
      if (itemsWithOutgoingBelts.has(itemId)) return `矿脉 ${beforeEntity.id} 的宏观产量越过有限储量边界`;
      tracedProduction = Math.floor(availableTenths / beforeConsumption);
      afterEntity.outputs[itemId] = beforeOutput + tracedProduction;
    }
    const remainingTenths = availableTenths - tracedProduction * beforeConsumption;
    const remaining = Math.ceil(remainingTenths / 10);
    afterEntity.resourceRemaining = remaining;
    afterEntity.resourceDepletionRemainder = remaining * 10 - remainingTenths;
    finiteItems.add(itemId);
    tracedByItem.set(itemId, (tracedByItem.get(itemId) ?? 0) + tracedProduction);
  }

  for (const itemId of finiteItems) {
    if (hasAlternativeResourceProducer(before, itemId) || hasAlternativeResourceProducer(candidate, itemId)) continue;
    const producedDelta = Math.floor(candidate.totalProduced[itemId] ?? 0) - Math.floor(before.totalProduced[itemId] ?? 0);
    const tracedProduction = tracedByItem.get(itemId) ?? 0;
    if (producedDelta !== tracedProduction) {
      if (!itemsWithOutgoingBelts.has(itemId)) {
        candidate.totalProduced[itemId] = Math.floor(before.totalProduced[itemId] ?? 0) + tracedProduction;
        continue;
      }
      return `矿脉 ${itemId} 累计产量 ${producedDelta} 与可追踪产物 ${tracedProduction} 不一致`;
    }
  }
  return null;
}

/**
 * A miner reserve is an input to production, never an independent source of
 * loss.  The affine pure-idle path can extrapolate persisted numeric fields,
 * so keep a second invariant specifically for finite veins: every tenth of a
 * reserve unit removed must be backed by a successfully recorded production
 * delta.  This is intentionally aggregate by item because several miners can
 * share the same item counter.
 */
export function validatePureIdleResourceAccounting(before: GameState, after: GameState): string | null {
  const depletedTenthsByItem = new Map<ItemId, number>();
  const finiteItemIds = new Set<ItemId>();
  for (const beforeEntity of before.entities) {
    if (beforeEntity.kind !== "vein" || !beforeEntity.resourceId) continue;
    const reserve = getResourceReserveSnapshot(before, beforeEntity);
    if (!reserve || reserve.infinite) continue;
    const afterEntity = after.entities.find((entity) => entity.id === beforeEntity.id);
    if (!afterEntity || afterEntity.kind !== "vein" || afterEntity.resourceId !== beforeEntity.resourceId) {
      return `矿脉实体 ${beforeEntity.id} 在纯挂机结算中丢失`;
    }
    const beforeRemaining = Math.max(0, Math.floor(beforeEntity.resourceRemaining ?? 0));
    const afterRemaining = Math.max(0, Math.floor(afterEntity.resourceRemaining ?? 0));
    const beforeRemainder = Math.max(0, Math.min(9, Math.floor(beforeEntity.resourceDepletionRemainder ?? 0)));
    const afterRemainder = Math.max(0, Math.min(9, Math.floor(afterEntity.resourceDepletionRemainder ?? 0)));
    const depletionTenths = beforeRemaining * 10 - beforeRemainder - (afterRemaining * 10 - afterRemainder);
    finiteItemIds.add(beforeEntity.resourceId);
    if (depletionTenths < 0) return `矿脉 ${beforeEntity.id} 储量出现回退`;
    if (depletionTenths > 0) {
      depletedTenthsByItem.set(beforeEntity.resourceId, (depletedTenthsByItem.get(beforeEntity.resourceId) ?? 0) + depletionTenths);
    }
  }

  for (const itemId of finiteItemIds) {
    const depletedTenths = depletedTenthsByItem.get(itemId) ?? 0;
    const beforeProduced = Math.max(0, Math.floor(before.totalProduced[itemId] ?? 0));
    const afterProduced = Math.max(0, Math.floor(after.totalProduced[itemId] ?? 0));
    const producedDelta = afterProduced - beforeProduced;
    if (producedDelta < 0) return `累计产量 ${itemId} 在纯挂机结算中回退`;
    const beforeConsumptionTenths = veinConsumptionTenths(before, itemId);
    const consumptionTenths = veinConsumptionTenths(after, itemId);
    // The exact consumption multiplier is represented in the reserve
    // remainder; derive the allowed bound from the observed finite reserve
    // rather than assuming the default 1:1 rule.  A finite resource mode with
    // zero effective depletion is treated as unlimited by the engine.
    const effectiveConsumptionTenths = Math.max(1, beforeConsumptionTenths, consumptionTenths);
    if (beforeConsumptionTenths === consumptionTenths &&
      !hasAlternativeResourceProducer(before, itemId) && !hasAlternativeResourceProducer(after, itemId) &&
      depletedTenths !== producedDelta * effectiveConsumptionTenths) {
      return `矿脉 ${itemId} 减少 ${depletedTenths} 个十分之一，但可归属累计产量为 ${producedDelta}`;
    }
    if (depletedTenths > producedDelta * effectiveConsumptionTenths) {
      return `矿脉 ${itemId} 减少 ${depletedTenths} 个十分之一，但累计产量仅增加 ${producedDelta}`;
    }
  }
  return null;
}

/**
 * Build the pure-idle contract from exactly three ten-second exact windows.
 * The supplied state remains untouched. Only one full shadow state is kept;
 * calibration checkpoints are reduced to compact affine snapshots.
 */
export function createPureIdleAffineCalibration(
  state: GameState,
  calibrationWallSeconds: number,
): PureIdleAffineCalibration | null {
  if (!Number.isFinite(calibrationWallSeconds) || calibrationWallSeconds <= 0 || !validateFastNumbers(state)) return null;
  const snapshots = [captureAffineSnapshot(state)];
  const researchSnapshots = [captureResearchMacroCalibrationSnapshot(state)];
  let shadow = structuredClone(state);
  for (let index = 0; index < FAST_OFFLINE_CALIBRATION_SECONDS / FAST_OFFLINE_CALIBRATION_SLICE_SECONDS; index += 1) {
    shadow = runExact(shadow, FAST_OFFLINE_CALIBRATION_SLICE_SECONDS, calibrationWallSeconds / 3);
    snapshots.push(captureAffineSnapshot(shadow));
    researchSnapshots.push(captureResearchMacroCalibrationSnapshot(shadow));
  }
  const contract = createFastAffineContractFromSnapshots(
    snapshots,
    FAST_OFFLINE_CALIBRATION_SECONDS,
    calibrationWallSeconds,
    true,
  );
  snapshots.length = 0;
  const researchLedger = createResearchMacroLedgerFromSnapshots(
    researchSnapshots,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
  );
  if (!contract || !researchLedger) return null;
  return {
    contract: removeResearchInputDeltas(contract, state),
    researchLedger,
    calibratedState: shadow,
    calibrationSeconds: FAST_OFFLINE_CALIBRATION_SECONDS,
    calibrationWallSeconds,
  };
}

/**
 * Low-memory calibration used by complex saves that would exceed the generic
 * affine snapshot budget. It still observes three exact ten-second windows,
 * but retains only material stores and total production counters.
 * Terminal rocket/sail outcomes remain frozen after the exact prefix.
 */
export function createPureIdleLightweightCalibration(
  state: GameState,
  calibrationWallSeconds: number,
  options: PureIdleLightweightCalibrationOptions = {},
): PureIdleAffineCalibration | null {
  if (!Number.isFinite(calibrationWallSeconds) || calibrationWallSeconds <= 0 || !validateFastNumbers(state)) return null;
  const sharedPaths = new Map<string, AffinePath>();
  const snapshots = [capturePureIdleLightweightSnapshot(state, sharedPaths)];
  const researchSnapshots = [captureResearchMacroCalibrationSnapshot(state)];
  let shadow = structuredClone(state);
  const constructionAutomationEnabled = shadow.constructionAutomation.enabled;
  if (options.isolateConstructionAutomation) shadow.constructionAutomation.enabled = false;
  let topologyStable = true;
  try {
    for (let index = 0; index < FAST_OFFLINE_CALIBRATION_SECONDS / FAST_OFFLINE_CALIBRATION_SLICE_SECONDS; index += 1) {
      shadow = runExact(shadow, FAST_OFFLINE_CALIBRATION_SLICE_SECONDS, calibrationWallSeconds / 3);
      topologyStable &&= sameStableIds(state.entities, shadow.entities) && sameStableIds(state.belts, shadow.belts);
      snapshots.push(capturePureIdleLightweightSnapshot(shadow, sharedPaths));
      researchSnapshots.push(captureResearchMacroCalibrationSnapshot(shadow));
    }
  } finally {
    if (options.isolateConstructionAutomation) shadow.constructionAutomation.enabled = constructionAutomationEnabled;
  }
  const sampled = topologyStable
    ? createFastAffineContractFromSnapshots(
      snapshots,
      FAST_OFFLINE_CALIBRATION_SECONDS,
      calibrationWallSeconds,
      true,
    )
    : null;
  snapshots.length = 0;
  const researchLedger = createResearchMacroLedgerFromSnapshots(
    researchSnapshots,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
  );
  if (!researchLedger) return null;

  const sampledContract: PureIdleAffineContract = sampled
    ? reconcilePureIdleLightweightMaterialDeltas(removeResearchInputDeltas({
      ...sampled,
      deltas: sampled.deltas.filter((delta) => delta.kind === "number" ? Math.abs(Number(delta.delta)) > EPSILON : delta.delta !== 0n),
    }, state))
    : {
      deltas: [],
      calibrationSeconds: FAST_OFFLINE_CALIBRATION_SECONDS,
      calibrationWallSeconds,
    };
  let contract = freezePureIdleLightweightStoreReplenishment(sampledContract);

  // Finite vein reserves are not represented by the lightweight store sample.
  // Keep the exact prefix but do not copy its mined output past the checkpoint.
  if (hasActiveFinitePureIdleResource(state) || !topologyStable) {
    contract = { ...contract, deltas: [], maximumSimulationSeconds: 0 };
  } else {
    const maximumSimulationSecondsByItem = calculatePureIdleLightweightBoundaries(shadow, sampledContract);
    if (maximumSimulationSecondsByItem !== undefined) contract = { ...contract, maximumSimulationSecondsByItem };
  }
  return {
    contract,
    researchLedger,
    calibratedState: shadow,
    calibrationSeconds: FAST_OFFLINE_CALIBRATION_SECONDS,
    calibrationWallSeconds,
  };
}

async function createPureIdleLightweightCalibrationAsync(
  state: GameState,
  calibrationWallSeconds: number,
  asyncOptions: OfflineApproximationAsyncOptions,
  options: PureIdleLightweightCalibrationOptions = {},
): Promise<PureIdleAffineCalibration | null> {
  if (!Number.isFinite(calibrationWallSeconds) || calibrationWallSeconds <= 0 || !validateFastNumbers(state)) return null;
  const sharedPaths = new Map<string, AffinePath>();
  const snapshots = [capturePureIdleLightweightSnapshot(state, sharedPaths)];
  const researchSnapshots = [captureResearchMacroCalibrationSnapshot(state)];
  let shadow = structuredClone(state);
  const constructionAutomationEnabled = shadow.constructionAutomation.enabled;
  if (options.isolateConstructionAutomation) shadow.constructionAutomation.enabled = false;
  let topologyStable = true;
  try {
    for (let index = 0; index < FAST_OFFLINE_CALIBRATION_SECONDS / FAST_OFFLINE_CALIBRATION_SLICE_SECONDS; index += 1) {
      shadow = await runExactAsync(
        shadow,
        FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
        asyncOptions,
        calibrationWallSeconds / 3,
      );
      topologyStable &&= sameStableIds(state.entities, shadow.entities) && sameStableIds(state.belts, shadow.belts);
      snapshots.push(capturePureIdleLightweightSnapshot(shadow, sharedPaths));
      researchSnapshots.push(captureResearchMacroCalibrationSnapshot(shadow));
      asyncOptions.onProgress?.((index + 1) * FAST_OFFLINE_CALIBRATION_SLICE_SECONDS, FAST_OFFLINE_CALIBRATION_SECONDS);
    }
  } finally {
    if (options.isolateConstructionAutomation) shadow.constructionAutomation.enabled = constructionAutomationEnabled;
  }
  const sampled = topologyStable
    ? createFastAffineContractFromSnapshots(
      snapshots,
      FAST_OFFLINE_CALIBRATION_SECONDS,
      calibrationWallSeconds,
      true,
    )
    : null;
  snapshots.length = 0;
  const researchLedger = createResearchMacroLedgerFromSnapshots(
    researchSnapshots,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
  );
  if (!researchLedger) return null;
  const sampledContract: PureIdleAffineContract = sampled
    ? reconcilePureIdleLightweightMaterialDeltas(removeResearchInputDeltas({
      ...sampled,
      deltas: sampled.deltas.filter((delta) => delta.kind === "number" ? Math.abs(Number(delta.delta)) > EPSILON : delta.delta !== 0n),
    }, state))
    : {
      deltas: [],
      calibrationSeconds: FAST_OFFLINE_CALIBRATION_SECONDS,
      calibrationWallSeconds,
    };
  let contract = freezePureIdleLightweightStoreReplenishment(sampledContract);
  if (hasActiveFinitePureIdleResource(state) || !topologyStable) {
    contract = { ...contract, deltas: [], maximumSimulationSeconds: 0 };
  } else {
    const maximumSimulationSecondsByItem = calculatePureIdleLightweightBoundaries(shadow, sampledContract);
    if (maximumSimulationSecondsByItem !== undefined) contract = { ...contract, maximumSimulationSecondsByItem };
  }
  return {
    contract,
    researchLedger,
    calibratedState: shadow,
    calibrationSeconds: FAST_OFFLINE_CALIBRATION_SECONDS,
    calibrationWallSeconds,
  };
}

/**
 * Applies a compact contract directly to an isolated candidate while using a
 * separate authoritative baseline for every conservation check. The caller
 * must discard the candidate when this returns false.
 */
export function applyPureIdleAffineContractToCandidate(
  baseline: GameState,
  candidate: GameState,
  contract: PureIdleAffineContract,
  simulationSeconds: number,
  wallSeconds: number,
  options: PureIdleAffineApplicationOptions = {},
): PureIdleAffineApplication {
  const allowExactFallback = options.allowExactFallback ?? true;
  const before = captureAggregateConservationBaseline(baseline);
  const integerRemainders = options.integerRemainders ? { ...options.integerRemainders } : undefined;
  const decimalRemainders = options.decimalRemainders ? { ...options.decimalRemainders } : undefined;
  const commitIntegerRemainders = (next: Record<string, number> | undefined): void => {
    if (!options.integerRemainders) return;
    for (const key of Object.keys(options.integerRemainders)) delete options.integerRemainders[key];
    if (next) Object.assign(options.integerRemainders, next);
  };
  const commitDecimalRemainders = (next: Record<string, bigint> | undefined): void => {
    if (!options.decimalRemainders) return;
    for (const key of Object.keys(options.decimalRemainders)) delete options.decimalRemainders[key];
    if (next) Object.assign(options.decimalRemainders, next);
  };
  const applied = applyFastAffineContract(
    candidate,
    contract,
    simulationSeconds,
    wallSeconds,
    true,
    options.skipUnsafeIntegerPaths ?? false,
    integerRemainders,
    decimalRemainders,
    options.simulationSecondsByItem,
  );
  if (!applied.ok) return { ok: false, boundaryCorrections: 0, failure: applied.failure };
  const normalized = normalizeFastSettlementState(candidate, baseline);
  if (!normalized.ok) {
    return {
      ok: false,
      boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections,
      failure: normalized.failure ?? "宏观候选状态规范化失败",
    };
  }
  const reconciliationFailure = reconcilePureIdleFiniteResources(baseline, candidate);
  if (reconciliationFailure) {
    // Capacity, transport and depletion boundaries are deterministic gameplay
    // events. Reuse the ordinary simulation for this interval instead of
    // dropping production or accepting an untraceable affine counter.
    if (!allowExactFallback) {
      return {
        ok: false,
        boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections,
        failure: reconciliationFailure,
      };
    }
    const exact = runExact(structuredClone(baseline), simulationSeconds, wallSeconds);
    const exactNormalized = normalizeFastSettlementState(exact, baseline);
    if (!exactNormalized.ok) {
      return {
        ok: false,
        boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections + exactNormalized.corrections,
        failure: exactNormalized.failure ?? reconciliationFailure,
      };
    }
    const exactResourceFailure = validatePureIdleResourceAccounting(baseline, exact);
    const exactConservationFailure = validateAggregateConservation(before, exact);
    const exactTerminalFailure = validatePureIdleTerminalMaterialConservation(baseline, exact);
    if (exactResourceFailure || exactConservationFailure || exactTerminalFailure) {
      return {
        ok: false,
        boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections + exactNormalized.corrections,
        failure: exactResourceFailure ?? exactConservationFailure ?? exactTerminalFailure ?? reconciliationFailure,
      };
    }
    refreshDysonGenerationSnapshot(exact);
    Object.assign(candidate, exact);
    commitIntegerRemainders(undefined);
    commitDecimalRemainders(undefined);
    return {
      ok: true,
      boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections + exactNormalized.corrections + 1,
      exactSimulationSeconds: simulationSeconds,
    };
  }
  const resourceFailure = validatePureIdleResourceAccounting(baseline, candidate);
  if (resourceFailure) {
    return {
      ok: false,
      boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections,
      failure: resourceFailure,
    };
  }
  const conservationFailure = validateAggregateConservation(before, candidate);
  if (conservationFailure) {
    return {
      ok: false,
      boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections,
      failure: conservationFailure,
    };
  }
  const terminalFailure = validatePureIdleTerminalMaterialConservation(baseline, candidate);
  if (terminalFailure) {
    return {
      ok: false,
      boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections,
      failure: terminalFailure,
    };
  }
  // Power is derived only after structure and sail ledgers are accepted. It is
  // never trusted as independent evidence for a candidate's legitimacy.
  refreshDysonGenerationSnapshot(candidate);
  commitIntegerRemainders(integerRemainders);
  commitDecimalRemainders(decimalRemainders);
  return {
    ok: true,
    boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections,
  };
}

/** Transactional public wrapper. The input state changes only after success. */
export function applyPureIdleAffineContract(
  state: GameState,
  contract: PureIdleAffineContract,
  simulationSeconds: number,
  wallSeconds: number,
  options: PureIdleAffineApplicationOptions = {},
): PureIdleAffineApplication {
  const candidate = structuredClone(state);
  const result = applyPureIdleAffineContractToCandidate(
    state,
    candidate,
    contract,
    simulationSeconds,
    wallSeconds,
    options,
  );
  if (result.ok) Object.assign(state, candidate);
  return result;
}

function normalizeFastNumberMap(
  record: Record<string, number>,
  limit?: number,
  protectedValues?: Record<string, number>,
): { ok: boolean; corrections: number } {
  let corrections = 0;
  for (const [key, raw] of Object.entries(record)) {
    if (!Number.isFinite(raw)) return { ok: false, corrections };
    let value = Math.floor(raw + EPSILON);
    if (value < 0) { value = 0; corrections += 1; }
    const protectedValue = Math.max(0, Math.floor(protectedValues?.[key] ?? 0));
    const effectiveLimit = limit !== undefined && limit > 0 ? Math.max(Math.floor(limit), protectedValue) : undefined;
    if (effectiveLimit !== undefined && value > effectiveLimit) { value = effectiveLimit; corrections += 1; }
    if (!Number.isSafeInteger(value)) return { ok: false, corrections };
    record[key] = value;
  }
  return { ok: true, corrections };
}

function clampDecimalMap(
  record: Partial<Record<string, string>>,
  capacities?: Partial<Record<string, string>>,
  protectedValues?: Partial<Record<string, string>>,
): { ok: boolean; corrections: number } {
  let corrections = 0;
  for (const [key, raw] of Object.entries(record)) {
    if (!/^\d+$/.test(raw ?? "")) return { ok: false, corrections };
    try {
      let value = BigInt(raw!);
      const capacity = capacities?.[key];
      if (capacity !== undefined && /^\d+$/.test(capacity)) {
        const protectedValue = protectedValues?.[key];
        const protectedMax = protectedValue !== undefined && /^\d+$/.test(protectedValue)
          ? BigInt(protectedValue)
          : 0n;
        const configuredMax = BigInt(capacity);
        const max = configuredMax > protectedMax ? configuredMax : protectedMax;
        if (value > max) { value = max; corrections += 1; }
      }
      record[key] = value.toString();
    } catch {
      return { ok: false, corrections };
    }
  }
  return { ok: true, corrections };
}

function findInvalidFastNumber(value: unknown, path: AffinePath = [], seen = new Set<object>()): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `${JSON.stringify(path)}=${String(value)} 不是有限数值`;
    if (path.at(-1) === "cargo" && pathHasString(path, new Set(["stationRoutes"])) &&
      (!Number.isSafeInteger(value) || value < 0)) {
      return `${JSON.stringify(path)}=${String(value)} 不是合法非负航线货物`;
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value) && !isFastFiniteFloatPath(path)) {
      return `${JSON.stringify(path)}=${String(value)} 超过安全整数`;
    }
    return null;
  }
  if (typeof value === "string" && (isDecimalAffinePath(path) || pathHasString(path, new Set(["warpers", "totalDestroyed", "remainingCargo"])))) {
    return /^\d+$/.test(value) ? null : `${JSON.stringify(path)} 不是合法非负十进制整数`;
  }
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const failure = findInvalidFastNumber(value[index], [...path, index], seen);
      if (failure) return failure;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const failure = findInvalidFastNumber(child, [...path, key], seen);
    if (failure) return failure;
  }
  return null;
}

function validateFastNumbers(value: unknown): boolean {
  return findInvalidFastNumber(value) === null;
}

/**
 * Normalize only the mutable counters touched by the fast contract. This is a
 * boundary correction, never a fallback to theoretical building throughput.
 */
interface FastSettlementNormalizationResult {
  ok: boolean;
  corrections: number;
  failure?: string;
}

function normalizeFastSettlementState(
  state: GameState,
  protectedBaseline?: GameState,
): FastSettlementNormalizationResult {
  const initialFailure = findInvalidFastNumber(state);
  if (initialFailure) return { ok: false, corrections: 0, failure: initialFailure };
  let corrections = 0;
  try {
    const normalizeCursor = (raw: number | undefined, length?: number): number | null => {
      if (raw === undefined) return 0;
      if (!Number.isFinite(raw) || !Number.isSafeInteger(Math.trunc(raw))) return null;
      const integer = Math.trunc(raw);
      if (length !== undefined && length > 0) return ((integer % length) + length) % length;
      return Math.max(0, integer);
    };
    const normalizeCursorMap = (record: Record<string, number>): boolean => {
      for (const [key, raw] of Object.entries(record)) {
        const normalized = normalizeCursor(raw);
        if (normalized === null) return false;
        if (normalized !== raw) corrections += 1;
        record[key] = normalized;
      }
      return true;
    };
    if (!Number.isFinite(state.constructionAutomation.cursor) ||
      !Number.isSafeInteger(Math.trunc(state.constructionAutomation.cursor))) return { ok: false, corrections };
    const constructionCursor = normalizeConstructionAutomationCursor(state.constructionAutomation.cursor);
    if (constructionCursor !== state.constructionAutomation.cursor) corrections += 1;
    state.constructionAutomation.cursor = constructionCursor;
    for (let entityIndex = 0; entityIndex < state.entities.length; entityIndex += 1) {
      const entity = state.entities[entityIndex];
      const protectedEntity = protectedBaseline?.entities[entityIndex]?.id === entity.id
        ? protectedBaseline.entities[entityIndex]
        : undefined;
      const routingCursor = normalizeCursor(entity.routingCursor);
      const dispatchCursor = normalizeCursor(entity.stationDispatchCursor, entity.stationRoutes?.length);
      if (routingCursor === null || dispatchCursor === null) return { ok: false, corrections };
      if (routingCursor !== entity.routingCursor) corrections += 1;
      if (entity.stationDispatchCursor !== undefined && dispatchCursor !== entity.stationDispatchCursor) corrections += 1;
      entity.routingCursor = routingCursor;
      if (entity.stationDispatchCursor !== undefined) entity.stationDispatchCursor = dispatchCursor;
      const inputCapacity = getEntityInputCapacity(state, entity);
      const outputCapacity = getEntityOutputCapacity(state, entity);
      const inputs = normalizeFastNumberMap(
        entity.inputs,
        inputCapacity > 0 ? inputCapacity : undefined,
        protectedEntity?.inputs,
      );
      const outputs = normalizeFastNumberMap(
        entity.outputs,
        outputCapacity > 0 ? outputCapacity : undefined,
        protectedEntity?.outputs,
      );
      if (!inputs.ok || !outputs.ok) return { ok: false, corrections };
      corrections += inputs.corrections + outputs.corrections;
      if (!Number.isFinite(entity.progress)) return { ok: false, corrections };
      entity.progress = ((entity.progress % 1) + 1) % 1;
      if (typeof entity.stationProgress === "number") {
        if (!Number.isFinite(entity.stationProgress)) return { ok: false, corrections };
        const normalizedStationProgress = ((entity.stationProgress % 1) + 1) % 1;
        if (Math.abs(normalizedStationProgress - entity.stationProgress) > EPSILON) corrections += 1;
        entity.stationProgress = normalizedStationProgress;
      }
      if (typeof entity.fuelRemainingMj === "number") {
        if (!Number.isFinite(entity.fuelRemainingMj)) return { ok: false, corrections };
        if (entity.fuelRemainingMj < 0) { entity.fuelRemainingMj = 0; corrections += 1; }
        entity.fuelRemainingMj = Math.floor(entity.fuelRemainingMj + EPSILON);
        if (!Number.isSafeInteger(entity.fuelRemainingMj)) return { ok: false, corrections };
      }
      if (typeof entity.resourceRemaining === "number") {
        if (!Number.isFinite(entity.resourceRemaining)) return { ok: false, corrections };
        const capacity = typeof entity.resourceCapacity === "number" && Number.isFinite(entity.resourceCapacity)
          ? Math.max(0, Math.floor(entity.resourceCapacity))
          : undefined;
        const normalizedRemaining = Math.max(0, Math.floor(entity.resourceRemaining + EPSILON));
        const boundedRemaining = capacity === undefined ? normalizedRemaining : Math.min(normalizedRemaining, capacity);
        if (!Number.isSafeInteger(boundedRemaining)) return { ok: false, corrections };
        if (boundedRemaining !== entity.resourceRemaining) corrections += 1;
        entity.resourceRemaining = boundedRemaining;
      }
      if (typeof entity.resourceDepletionRemainder === "number") {
        if (!Number.isFinite(entity.resourceDepletionRemainder)) return { ok: false, corrections };
        const normalizedRemainder = ((Math.floor(entity.resourceDepletionRemainder) % 10) + 10) % 10;
        if (normalizedRemainder !== entity.resourceDepletionRemainder) corrections += 1;
        entity.resourceDepletionRemainder = normalizedRemainder;
      }
      if (entity.proliferatorBonusProgress) {
        for (const [itemId, raw] of Object.entries(entity.proliferatorBonusProgress)) {
          if (!Number.isFinite(raw)) return { ok: false, corrections };
          const normalized = ((raw % 1) + 1) % 1;
          if (Math.abs(normalized - raw) > EPSILON) corrections += 1;
          entity.proliferatorBonusProgress[itemId as keyof typeof entity.proliferatorBonusProgress] = normalized;
        }
      }
      for (const route of entity.stationRoutes ?? []) {
        if (!Number.isFinite(route.cargo) || !Number.isSafeInteger(route.cargo) || route.cargo < 0) {
          return { ok: false, corrections, failure: `航线 ${route.id} 的在途货物不是合法非负安全整数` };
        }
        if (!Number.isFinite(route.progress) || route.progress < 0 || route.progress > 1) {
          return { ok: false, corrections, failure: `航线 ${route.id} 的进度超出 0～1` };
        }
      }
    }
    for (const belt of state.belts) {
      const transferred = finiteNumber(belt.totalTransferred, Number.NaN);
      if (!Number.isFinite(belt.progress) || !Number.isFinite(transferred)) return { ok: false, corrections };
      belt.progress = ((belt.progress % 1) + 1) % 1;
      if (transferred < 0) { belt.totalTransferred = 0; corrections += 1; }
      else belt.totalTransferred = Math.floor(transferred + EPSILON);
      if (!Number.isSafeInteger(belt.totalTransferred)) return { ok: false, corrections };
      belt.lastFlow = Math.max(0, finiteNumber(belt.lastFlow));
      belt.congestion = Math.max(0, Math.min(1, finiteNumber(belt.congestion)));
    }
    const totals = normalizeFastNumberMap(state.totalProduced as Record<string, number>);
    if (!totals.ok) return { ok: false, corrections };
    corrections += totals.corrections;
    for (const tray of Object.values(state.planetTrays)) {
      const normalized = normalizeFastNumberMap(tray as Record<string, number>);
      if (!normalized.ok) return { ok: false, corrections };
      corrections += normalized.corrections;
    }
    const trayLimit = Math.max(0, Math.floor(state.planetTrayItemLimits[state.activePlanetId] ?? 0));
    const currentTray = normalizeFastNumberMap(
      state.tray as Record<string, number>,
      trayLimit > 0 ? trayLimit : undefined,
      protectedBaseline?.tray as Record<string, number> | undefined,
    );
    if (!currentTray.ok) return { ok: false, corrections };
    corrections += currentTray.corrections;
    const construction = normalizeFastNumberMap(state.construction as Record<string, number>);
    const fleet = normalizeFastNumberMap(state.portableFleet as Record<string, number>);
    if (!construction.ok || !fleet.ok) return { ok: false, corrections };
    corrections += construction.corrections + fleet.corrections;
    if (!Number.isFinite(state.elapsedSeconds) || state.elapsedSeconds < 0 || state.elapsedSeconds > Number.MAX_SAFE_INTEGER) {
      return { ok: false, corrections };
    }
    if (state.speedrun && (!Number.isFinite(state.speedrun.elapsedActiveSeconds) || state.speedrun.elapsedActiveSeconds < 0 || !Number.isSafeInteger(Math.floor(state.speedrun.elapsedActiveSeconds)))) return { ok: false, corrections };
    const quantum = state.quantumLogisticsNetwork?.inventory;
    if (quantum) {
      const normalized = clampDecimalMap(
        quantum,
        state.quantumLogisticsNetwork.itemCapacities,
        protectedBaseline?.quantumLogisticsNetwork.inventory,
      );
      if (!normalized.ok) return { ok: false, corrections };
      corrections += normalized.corrections;
    }
    if (!normalizeCursorMap(state.quantumLogisticsNetwork.routingCursors as Record<string, number>) ||
      !normalizeCursorMap(state.quantumLogisticsNetwork.uploadRoutingCursors as Record<string, number>) ||
      !normalizeCursorMap(state.galacticHubNetwork.routingCursors)) return { ok: false, corrections };
    for (const station of Object.values(state.systemSpaceStations)) {
      if (station && !normalizeCursorMap(station.routingCursors)) return { ok: false, corrections };
    }
    const finalFailure = findInvalidFastNumber(state);
    if (finalFailure) return { ok: false, corrections, failure: finalFailure };
    return { ok: true, corrections };
  } catch (error) {
    return { ok: false, corrections, failure: error instanceof Error ? error.message : "未知规范化异常" };
  }
}

interface FastSnapshotComparison {
  maxError: number;
  path?: AffinePath;
  actual?: number | bigint;
  expected?: number | bigint;
}

function compareFastNumericSnapshots(actual: GameState, expected: GameState): FastSnapshotComparison {
  const left = captureAffineSnapshot(actual);
  const right = captureAffineSnapshot(expected);
  let maxError = 0;
  let maxPath: AffinePath | undefined;
  let maxActual: number | bigint | undefined;
  let maxExpected: number | bigint | undefined;
  for (const [key, leftEntry] of left.entries) {
    const path = left.paths.get(key);
    if (path && pathHasString(path, FAST_ERROR_IGNORED_KEYS)) continue;
    const rightEntry = right.entries.get(key);
    if (!rightEntry || leftEntry.kind !== rightEntry.kind) continue;
    if (leftEntry.kind === "number" && rightEntry.kind === "number") {
      const error = relativeDifference(leftEntry.value, rightEntry.value);
      if (error > maxError) {
        maxError = error;
        maxPath = path;
        maxActual = leftEntry.value;
        maxExpected = rightEntry.value;
      }
    } else if (leftEntry.kind === "decimal" && rightEntry.kind === "decimal") {
      const scale = leftEntry.value > rightEntry.value ? leftEntry.value : rightEntry.value;
      const difference = leftEntry.value >= rightEntry.value ? leftEntry.value - rightEntry.value : rightEntry.value - leftEntry.value;
      if (scale > 0n) {
        const error = difference * 100n > scale * 20n ? 1 : Number(difference) / Math.max(1, Number(scale));
        if (error > maxError) {
          maxError = error;
          maxPath = path;
          maxActual = leftEntry.value;
          maxExpected = rightEntry.value;
        }
      }
    }
  }
  return { maxError, path: maxPath, actual: maxActual, expected: maxExpected };
}

function normalizeFastSpeedrunClock(actual: GameState, source: GameState, wallSeconds: number): number {
  if (!actual.speedrun?.enabled || !source.speedrun?.enabled || !Number.isFinite(wallSeconds) || wallSeconds <= 0) return 0;
  const desired = Math.round((source.speedrun.elapsedActiveSeconds + Math.min(wallSeconds, 30 * 24 * 60 * 60)) * 1_000_000) / 1_000_000;
  if (Math.abs(actual.speedrun.elapsedActiveSeconds - desired) < 1e-9) return 0;
  actual.speedrun = { ...actual.speedrun, elapsedActiveSeconds: desired };
  return 1;
}

interface TimeWarpCriticalSnapshot {
  whiteMatrixProduced: number;
  rocketsLaunched: number;
  structurePoints: number;
  shellSails: number;
  sailsAbsorbed: number;
  sailsLaunched: number;
  dysonGenerationKw: number;
  planStructurePoints: Record<string, number>;
  planShellSails: Record<string, number>;
}

function captureTimeWarpCriticalSnapshot(state: GameState): TimeWarpCriticalSnapshot {
  const planStructurePoints: Record<string, number> = {};
  const planShellSails: Record<string, number> = {};
  for (const [systemId, plan] of Object.entries(state.dysonPlans)) {
    planStructurePoints[systemId] = finiteNumber(plan.structurePoints);
    planShellSails[systemId] = finiteNumber(plan.shellSails);
  }
  return {
    whiteMatrixProduced: finiteNumber(state.totalProduced.universe_matrix),
    rocketsLaunched: finiteNumber(state.dysonSphere.totalRocketsLaunched),
    structurePoints: finiteNumber(state.dysonSphere.structurePoints),
    shellSails: finiteNumber(state.dysonSphere.shellSails),
    sailsAbsorbed: finiteNumber(state.dysonSphere.totalSailsAbsorbed),
    sailsLaunched: finiteNumber(state.dysonSwarm.totalLaunched),
    dysonGenerationKw: finiteNumber(state.dysonSphere.generationKw) + finiteNumber(state.dysonSwarm.generationKw),
    planStructurePoints,
    planShellSails,
  };
}

function timeWarpCriticalValueMap(snapshot: TimeWarpCriticalSnapshot): Record<string, number> {
  const result: Record<string, number> = {
    whiteMatrixProduced: snapshot.whiteMatrixProduced,
    rocketsLaunched: snapshot.rocketsLaunched,
    structurePoints: snapshot.structurePoints,
    shellSails: snapshot.shellSails,
    sailsAbsorbed: snapshot.sailsAbsorbed,
    sailsLaunched: snapshot.sailsLaunched,
  };
  for (const [systemId, value] of Object.entries(snapshot.planStructurePoints)) result[`plan:${systemId}:structure`] = value;
  for (const [systemId, value] of Object.entries(snapshot.planShellSails)) result[`plan:${systemId}:shell`] = value;
  return result;
}

function compareTimeWarpCriticalSnapshots(
  baseline: TimeWarpCriticalSnapshot,
  expected: TimeWarpCriticalSnapshot,
  actual: TimeWarpCriticalSnapshot,
): number {
  const baselineValues = timeWarpCriticalValueMap(baseline);
  const expectedValues = timeWarpCriticalValueMap(expected);
  const actualValues = timeWarpCriticalValueMap(actual);
  let maximum = relativeDifference(expected.dysonGenerationKw, actual.dysonGenerationKw);
  const keys = new Set([...Object.keys(baselineValues), ...Object.keys(expectedValues), ...Object.keys(actualValues)]);
  for (const key of keys) {
    const predictedDelta = finiteNumber(expectedValues[key]) - finiteNumber(baselineValues[key]);
    const actualDelta = finiteNumber(actualValues[key]) - finiteNumber(baselineValues[key]);
    const absoluteDifference = Math.abs(predictedDelta - actualDelta);
    // One whole item is the unavoidable quantisation error of a one-second
    // verifier and must not turn a low-volume Dyson boundary into 100% noise.
    if (absoluteDifference <= 1) continue;
    maximum = Math.max(maximum, relativeDifference(predictedDelta, actualDelta));
  }
  return maximum;
}

function exactTimeWarpResult(
  source: GameState,
  simulationSeconds: number,
  wallSeconds: number,
  reason: string,
  calibrationSeconds = 0,
): TimeWarpApproximationResult {
  return {
    state: runExact(structuredClone(source), simulationSeconds, wallSeconds),
    report: {
      mode: "exact",
      algorithmVersion: TIME_WARP_APPROXIMATION_ALGORITHM_VERSION,
      requestedSimulationSeconds: simulationSeconds,
      exactCalibrationSeconds: calibrationSeconds,
      approximatedSeconds: 0,
      maxCriticalError: 0,
      boundaryCorrections: 0,
      fallbackReason: reason,
    },
  };
}

/**
 * Material-safe fallback for an approximate realtime time-warp slice.
 *
 * `candidate` must be an isolated state that has only crossed exact or
 * conservation-validated work. The unproven remainder advances the clock but
 * freezes every material-bearing subsystem. This intentionally underpays a
 * player instead of replaying a sampled rocket/sail/export result or falling
 * back to an unbounded exact replay on a very large factory.
 */
function conservativeTimeWarpResult(
  source: GameState,
  candidate: GameState,
  simulationSeconds: number,
  wallSeconds: number,
  provenSimulationSeconds: number,
  reason: string,
  boundaryCorrections = 0,
): TimeWarpApproximationResult {
  let safeCandidate = candidate;
  const aggregateBefore = captureAggregateConservationBaseline(source);
  const resourceFailure = validatePureIdleResourceAccounting(source, safeCandidate);
  const aggregateFailure = validateAggregateConservation(aggregateBefore, safeCandidate);
  const terminalFailure = validatePureIdleTerminalMaterialConservation(source, safeCandidate);
  if (resourceFailure || aggregateFailure || terminalFailure) {
    // Never publish a partially applied candidate. A clock-only clone of the
    // source is the final safe boundary when even the bounded prefix fails.
    safeCandidate = structuredClone(source);
    provenSimulationSeconds = 0;
    reason = `${reason}；已丢弃未通过守恒门禁的候选：${resourceFailure ?? aggregateFailure ?? terminalFailure}`;
  }
  safeCandidate.elapsedSeconds = source.elapsedSeconds + simulationSeconds;
  boundaryCorrections += normalizeFastSpeedrunClock(safeCandidate, source, wallSeconds);
  refreshDysonGenerationSnapshot(safeCandidate);
  return {
    state: safeCandidate,
    report: {
      mode: "approximate",
      algorithmVersion: TIME_WARP_APPROXIMATION_ALGORITHM_VERSION,
      requestedSimulationSeconds: simulationSeconds,
      exactCalibrationSeconds: Math.max(0, Math.min(simulationSeconds, provenSimulationSeconds)),
      approximatedSeconds: Math.max(0, simulationSeconds - provenSimulationSeconds),
      maxCriticalError: 1,
      boundaryCorrections,
      fallbackReason: `${reason}；未证明尾段已冻结，仅推进时间`,
    },
  };
}

function runTimeWarpApproximateSettlementUnsafe(
  state: GameState,
  simulationSeconds: number,
  wallSeconds: number,
): TimeWarpApproximationResult {
  if (!Number.isFinite(simulationSeconds) || simulationSeconds <= 0 || !Number.isFinite(wallSeconds) || wallSeconds < 0) {
    throw new Error("时间扭曲切片时间无效");
  }
  if (state.timeWarp.pendingSimulationSeconds > EPSILON || state.timeWarp.pendingWallSeconds > EPSILON) {
    throw new Error("时间扭曲状态仍包含未提交预算");
  }
  if (!validateFastNumbers(state)) throw new Error("时间扭曲原始状态包含非法数值");
  if (state.paused || !state.timeWarp.enabled ||
    simulationSeconds <= TIME_WARP_APPROXIMATION_CALIBRATION_SECONDS + TIME_WARP_APPROXIMATION_VALIDATION_SECONDS) {
    return exactTimeWarpResult(state, simulationSeconds, wallSeconds, state.paused
      ? "模拟已暂停"
      : !state.timeWarp.enabled
        ? "时间扭曲未开启"
        : "切片较短，直接精确推进");
  }
  const calibrationSeconds = TIME_WARP_APPROXIMATION_CALIBRATION_SECONDS;
  const validationSeconds = TIME_WARP_APPROXIMATION_VALIDATION_SECONDS;
  const wallPerSimulationSecond = simulationSeconds > EPSILON ? wallSeconds / simulationSeconds : 0;
  const calibrationWallSeconds = wallPerSimulationSecond * calibrationSeconds;
  const validationWallSeconds = wallPerSimulationSecond * validationSeconds;
  const sharedPaths = new Map<string, AffinePath>();
  const sourceSnapshot = capturePureIdleLightweightSnapshot(state, sharedPaths);
  const sourceResearch = captureResearchMacroCalibrationSnapshot(state);
  const calibrated = structuredClone(state);
  const constructionEnabled = calibrated.constructionAutomation.enabled;
  calibrated.constructionAutomation.enabled = false;
  runExact(calibrated, calibrationSeconds, calibrationWallSeconds);
  calibrated.constructionAutomation.enabled = constructionEnabled;
  const calibratedSnapshot = capturePureIdleLightweightSnapshot(calibrated, sharedPaths);
  const researchLedger = createResearchMacroLedgerFromSnapshots(
    [sourceResearch, captureResearchMacroCalibrationSnapshot(calibrated)],
    calibrationSeconds,
  );
  const sampled = createFastAffineContractFromSnapshots(
    [sourceSnapshot, calibratedSnapshot],
    calibrationSeconds,
    calibrationWallSeconds,
    true,
  );
  let contract: PureIdleAffineContract = sampled
    ? reconcilePureIdleLightweightMaterialDeltas(removeResearchInputDeltas(sampled, state))
    : { deltas: [], calibrationSeconds, calibrationWallSeconds };
  if (hasActiveFinitePureIdleResource(state)) {
    contract = { ...contract, deltas: [], maximumSimulationSeconds: 0 };
  }
  if (!researchLedger || contract.maximumSimulationSeconds === 0 ||
    contract.deltas.length === 0 && !isFastLightweightQuiescent(state)) {
    return conservativeTimeWarpResult(
      state,
      calibrated,
      simulationSeconds,
      wallSeconds,
      calibrationSeconds,
      "短校准没有形成可用的轻量守恒增量",
    );
  }

  const macroSeconds = simulationSeconds - calibrationSeconds - validationSeconds;
  const macroWallSeconds = Math.max(0, wallSeconds - calibrationWallSeconds - validationWallSeconds);
  const creditedMacroSeconds = Math.min(
    macroSeconds,
    contract.maximumSimulationSeconds === undefined ? macroSeconds : Math.max(0, contract.maximumSimulationSeconds),
  );
  const creditedMacroSecondsByItem = pureIdleCreditedSecondsByItem(contract, creditedMacroSeconds);
  const macroApplication = applyFastAffineContract(
    calibrated,
    contract,
    creditedMacroSeconds,
    macroSeconds > EPSILON ? macroWallSeconds * creditedMacroSeconds / macroSeconds : 0,
    true,
    true,
    undefined,
    undefined,
    creditedMacroSecondsByItem,
  );
  if (!macroApplication.ok) {
    return conservativeTimeWarpResult(
      state,
      structuredClone(state),
      simulationSeconds,
      wallSeconds,
      0,
      `轻量宏观切片未通过物料守恒门禁：${macroApplication.failure ?? "未知字段"}`,
    );
  }
  const researchSeconds = MATRIX_ITEM_IDS.reduce((maximum, itemId) => {
    const itemSeconds = creditedMacroSecondsByItem?.[itemId];
    return itemSeconds === undefined ? maximum : Math.min(maximum, itemSeconds);
  }, creditedMacroSeconds);
  advanceResearchMacroInPlace(calibrated, researchLedger, researchSeconds);
  const validationBaseline = capturePureIdleLightweightSnapshot(calibrated, sharedPaths);
  const remainingValidationByItem = remainingPureIdleValidationSecondsByItem(contract, creditedMacroSecondsByItem);
  const expectedValidation = predictPureIdleLightweightSnapshot(
    validationBaseline,
    contract,
    validationSeconds,
    validationWallSeconds,
    remainingValidationByItem,
  );
  if (!expectedValidation) {
    return conservativeTimeWarpResult(
      state,
      structuredClone(state),
      simulationSeconds,
      wallSeconds,
      0,
      "轻量尾验预测越过安全整数或库存边界",
    );
  }
  const criticalBaseline = captureTimeWarpCriticalSnapshot(calibrated);
  const expectedCritical = criticalSnapshotWithPredictedWhiteMatrix(criticalBaseline, expectedValidation);
  calibrated.constructionAutomation.enabled = false;
  runExact(calibrated, validationSeconds, validationWallSeconds);
  calibrated.constructionAutomation.enabled = constructionEnabled;
  const normalizedActual = normalizeFastSettlementState(calibrated, state);
  const comparison = comparePureIdleLightweightSnapshots(
    validationBaseline,
    expectedValidation,
    capturePureIdleLightweightSnapshot(calibrated, sharedPaths),
  );
  const maxCriticalError = compareTimeWarpCriticalSnapshots(
    criticalBaseline,
    expectedCritical,
    captureTimeWarpCriticalSnapshot(calibrated),
  );
  const aggregateBefore = captureAggregateConservationBaseline(state);
  const resourceFailure = normalizedActual.ok ? validatePureIdleResourceAccounting(state, calibrated) : undefined;
  const aggregateFailure = normalizedActual.ok ? validateAggregateConservation(aggregateBefore, calibrated) : undefined;
  const terminalFailure = normalizedActual.ok ? validatePureIdleTerminalMaterialConservation(state, calibrated) : undefined;
  if (!normalizedActual.ok || resourceFailure || aggregateFailure || terminalFailure ||
    !Number.isFinite(maxCriticalError) || maxCriticalError > TIME_WARP_MAX_CRITICAL_ERROR) {
    return conservativeTimeWarpResult(
      state,
      structuredClone(state),
      simulationSeconds,
      wallSeconds,
      0,
      normalizedActual.failure ?? resourceFailure ?? aggregateFailure ?? terminalFailure ??
        `白糖或戴森关键指标尾验误差 ${(maxCriticalError * 100).toFixed(2)}% 超过 100%`,
    );
  }
  const construction = advanceConstructionAutomationMacroInPlace(calibrated, simulationSeconds);
  calibrated.elapsedSeconds = state.elapsedSeconds + simulationSeconds;
  const speedrunCorrection = normalizeFastSpeedrunClock(calibrated, state, wallSeconds);
  refreshDysonGenerationSnapshot(calibrated);
  return {
    state: calibrated,
    report: {
      mode: "approximate",
      algorithmVersion: TIME_WARP_APPROXIMATION_ALGORITHM_VERSION,
      requestedSimulationSeconds: simulationSeconds,
      exactCalibrationSeconds: calibrationSeconds + validationSeconds,
      approximatedSeconds: macroSeconds,
      maxCriticalError,
      boundaryCorrections: (macroApplication.corrections ?? 0) + normalizedActual.corrections + speedrunCorrection,
      ...(comparison.maxError > TIME_WARP_MAX_CRITICAL_ERROR
        ? { fallbackReason: `普通库存尾验最大误差 ${(comparison.maxError * 100).toFixed(2)}%，关键指标仍在门限内` }
        : construction.completed > 0
          ? { fallbackReason: `建筑制造巨构按真实库存递归完成 ${construction.completed.toLocaleString("zh-CN")} 件` }
          : {}),
    },
  };
}

/**
 * Realtime pure-idle settlement. Unlike offline settlement, wall time is
 * supplied explicitly by the scheduler and no save timestamp is read or
 * written, so a cancelled Worker slice cannot become duplicate offline gain.
 */
export function runTimeWarpApproximateSettlement(
  state: GameState,
  simulationSeconds: number,
  wallSeconds: number,
): TimeWarpApproximationResult {
  if (state.timeWarp.pendingSimulationSeconds > EPSILON || state.timeWarp.pendingWallSeconds > EPSILON) {
    throw new Error("时间扭曲状态仍包含未提交预算，已拒绝宏观切片");
  }
  try {
    return runTimeWarpApproximateSettlementUnsafe(state, simulationSeconds, wallSeconds);
  } catch (error) {
    const detail = error instanceof Error && error.message ? `：${error.message.slice(0, 160)}` : "";
    return exactTimeWarpResult(state, simulationSeconds, wallSeconds, `宏观计算异常，已使用精确切片${detail}`);
  }
}

function fastExactReport(windowSeconds: number, reason: string): OfflineApproximationReport {
  return {
    ...exactReport(windowSeconds, reason, true, FAST_OFFLINE_ALGORITHM_VERSION),
    settlementStatus: "bounded-exact",
  };
}

export function runConservativeOfflineSettlement(
  source: GameState,
  seconds: number,
  wallSeconds = seconds,
  reason = "普通宏观合同不可用，已使用保守宏观结算",
  calibratedState?: GameState,
  calibrationSeconds = 0,
  researchLedger?: ResearchMacroLedger,
  deadlineReached = false,
): OfflineApproximationResult {
  if (!validateFastNumbers(source)) {
    return {
      status: "invalid-source",
      report: {
        ...fastExactReport(0, "原始状态包含非法数值，未修改主存档"),
        settlementStatus: "invalid-source",
      },
    };
  }
  let candidate = calibratedState ?? structuredClone(source);
  let effectiveCalibrationSeconds = Math.max(0, calibrationSeconds);
  let prefixReason: string | undefined;
  if (!calibratedState && seconds > EPSILON) {
    const prefixSeconds = Math.min(FAST_OFFLINE_CONSERVATIVE_PREFIX_SECONDS, Math.max(0, seconds));
    const prefixWallSeconds = wallSeconds * prefixSeconds / Math.max(EPSILON, seconds);
    try {
      // A failed/timeout calibration must not make the whole factory look
      // frozen. Probe one exact second on an isolated copy, then keep the
      // uncertain tail conservative. The source remains transactional.
      candidate = runExact(structuredClone(source), prefixSeconds, prefixWallSeconds);
      effectiveCalibrationSeconds = prefixSeconds;
      prefixReason = `已先精确结算 ${prefixSeconds} 秒，其余不确定产线冻结`;
    } catch (error) {
      prefixReason = `短窗口精确结算失败：${error instanceof Error ? error.message : "未知错误"}`;
      candidate = structuredClone(source);
      effectiveCalibrationSeconds = 0;
    }
  }
  const remainingSeconds = Math.max(0, seconds - effectiveCalibrationSeconds);
  let researchInvested = 0n;
  if (researchLedger && remainingSeconds > 0) {
    researchInvested = advanceResearchMacroInPlace(candidate, researchLedger, remainingSeconds).consumed;
  }
  candidate.elapsedSeconds = source.elapsedSeconds + seconds;
  if (candidate.speedrun?.enabled) {
    candidate.speedrun.elapsedActiveSeconds = Math.max(
      candidate.speedrun.elapsedActiveSeconds,
      source.speedrun!.elapsedActiveSeconds + wallSeconds,
    );
  }
  const normalized = normalizeFastSettlementState(candidate);
  if (!normalized.ok) {
    if (calibratedState) {
      return runConservativeOfflineSettlement(
        source,
        seconds,
        wallSeconds,
        `${reason}；校准候选未通过数值校验，已从原始检查点重新建立有界保守前缀`,
        undefined,
        0,
        undefined,
        deadlineReached,
      );
    }
    return {
      status: "invalid-source",
      report: {
        ...fastExactReport(effectiveCalibrationSeconds, normalized.failure ?? "保守候选未通过数值校验"),
        settlementStatus: "invalid-source",
      },
    };
  }
  return {
    status: "conservative",
    state: candidate,
    report: {
      mode: "approximate",
      calibrationWindowSeconds: effectiveCalibrationSeconds,
      approximatedSeconds: remainingSeconds,
      maxEstimatedError: 1,
      fellBack: true,
      fallbackReason: prefixReason ? `${reason}；${prefixReason}` : reason,
      algorithmVersion: FAST_OFFLINE_ALGORITHM_VERSION,
      boundaryCorrections: normalized.corrections,
      validationScope: "leaderboard-critical",
      maxNonCriticalError: 1,
      settlementStatus: "conservative",
      deadlineReached,
      researchInvested: researchInvested.toString(),
    },
  };
}

interface FastLightweightPreparedSettlement {
  candidate: GameState;
  contract: PureIdleAffineContract;
  researchInvested: bigint;
  macroSeconds: number;
  creditedMacroSeconds: number;
  validationWallSeconds: number;
  validationSimulationSecondsByItem?: Record<string, number>;
  validationBaseline: AffineSnapshot;
  expectedValidation: AffineSnapshot;
  criticalBaseline: TimeWarpCriticalSnapshot;
  expectedCritical: TimeWarpCriticalSnapshot;
  sharedPaths: Map<string, AffinePath>;
  boundaryCorrections: number;
}

function isFastLightweightQuiescent(state: GameState): boolean {
  return state.entities.length === 0 && state.belts.length === 0 &&
    !hasActiveResearch(state) && state.handcraftQueue.length === 0 && state.constructionQueue.length === 0 &&
    Object.keys(state.constructionAutomation.jobs).length === 0 &&
    !Object.values(state.endgame.exportProjects).some((project) => project.enabled) &&
    !state.endgame.constructionActivity.activityId;
}

function pureIdleCreditedSecondsByItem(
  contract: PureIdleAffineContract,
  requestedSeconds: number,
): Record<string, number> | undefined {
  if (!contract.maximumSimulationSecondsByItem) return undefined;
  return Object.fromEntries(Object.entries(contract.maximumSimulationSecondsByItem).map(([itemId, maximum]) => [
    itemId,
    Math.min(requestedSeconds, Math.max(0, finiteNumber(maximum))),
  ]));
}

function remainingPureIdleValidationSecondsByItem(
  contract: PureIdleAffineContract,
  creditedMacroSecondsByItem: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!contract.maximumSimulationSecondsByItem) return undefined;
  return Object.fromEntries(Object.entries(contract.maximumSimulationSecondsByItem).map(([itemId, maximum]) => [
    itemId,
    Math.min(
      FAST_OFFLINE_VALIDATION_SECONDS,
      Math.max(0, finiteNumber(maximum) - finiteNumber(creditedMacroSecondsByItem?.[itemId])),
    ),
  ]));
}

function criticalSnapshotWithPredictedWhiteMatrix(
  baseline: TimeWarpCriticalSnapshot,
  predicted: AffineSnapshot,
): TimeWarpCriticalSnapshot {
  const entry = predicted.entries.get(pathKey(["totalProduced", "universe_matrix"]));
  return {
    ...baseline,
    planStructurePoints: { ...baseline.planStructurePoints },
    planShellSails: { ...baseline.planShellSails },
    whiteMatrixProduced: entry?.kind === "number" ? finiteNumber(entry.value) : baseline.whiteMatrixProduced,
  };
}

function prepareFastLightweightSettlement(
  source: GameState,
  seconds: number,
  wallSeconds: number,
  calibrated: PureIdleAffineCalibration,
): FastLightweightPreparedSettlement | { failure: string } {
  const macroSeconds = seconds - FAST_OFFLINE_CALIBRATION_SECONDS - FAST_OFFLINE_VALIDATION_SECONDS;
  if (macroSeconds < 1) return { failure: "校准后没有足够的批量外推时间" };
  const { contract, researchLedger } = calibrated;
  if ((contract.deltas.length === 0 && !isFastLightweightQuiescent(source)) || contract.maximumSimulationSeconds === 0) {
    return { failure: "30 秒轻量校准没有形成可持续普通生产合同" };
  }
  const creditedMacroSeconds = Math.min(
    macroSeconds,
    contract.maximumSimulationSeconds === undefined
      ? macroSeconds
      : Math.max(0, finiteNumber(contract.maximumSimulationSeconds)),
  );
  if (creditedMacroSeconds <= EPSILON) return { failure: "普通生产合同的全局安全边界已耗尽" };
  const creditedMacroSecondsByItem = pureIdleCreditedSecondsByItem(contract, creditedMacroSeconds);
  const macroWallSeconds = wallSeconds * creditedMacroSeconds / seconds;
  const application = applyPureIdleAffineContractToCandidate(
    source,
    calibrated.calibratedState,
    contract,
    creditedMacroSeconds,
    macroWallSeconds,
    {
      allowExactFallback: false,
      skipUnsafeIntegerPaths: true,
      simulationSecondsByItem: creditedMacroSecondsByItem,
    },
  );
  if (!application.ok) return { failure: application.failure ?? "轻量普通生产合同未通过守恒门禁" };
  const researchSeconds = MATRIX_ITEM_IDS.reduce((maximum, itemId) => {
    const itemSeconds = creditedMacroSecondsByItem?.[itemId];
    return itemSeconds === undefined ? maximum : Math.min(maximum, itemSeconds);
  }, creditedMacroSeconds);
  const research = advanceResearchMacroInPlace(calibrated.calibratedState, researchLedger, researchSeconds);
  const sharedPaths = new Map<string, AffinePath>();
  const validationBaseline = capturePureIdleLightweightSnapshot(calibrated.calibratedState, sharedPaths);
  const validationSimulationSecondsByItem = remainingPureIdleValidationSecondsByItem(
    contract,
    creditedMacroSecondsByItem,
  );
  const validationWallSeconds = wallSeconds * FAST_OFFLINE_VALIDATION_SECONDS / seconds;
  const expectedValidation = predictPureIdleLightweightSnapshot(
    validationBaseline,
    contract,
    FAST_OFFLINE_VALIDATION_SECONDS,
    validationWallSeconds,
    validationSimulationSecondsByItem,
  );
  if (!expectedValidation) return { failure: "轻量尾验预测越过安全整数或库存边界" };
  const criticalBaseline = captureTimeWarpCriticalSnapshot(calibrated.calibratedState);
  return {
    candidate: calibrated.calibratedState,
    contract,
    researchInvested: research.consumed,
    macroSeconds,
    creditedMacroSeconds,
    validationWallSeconds,
    validationSimulationSecondsByItem,
    validationBaseline,
    expectedValidation,
    criticalBaseline,
    expectedCritical: criticalSnapshotWithPredictedWhiteMatrix(criticalBaseline, expectedValidation),
    sharedPaths,
    boundaryCorrections: application.boundaryCorrections,
  };
}

function finalizeFastLightweightSettlement(
  source: GameState,
  seconds: number,
  wallSeconds: number,
  prepared: FastLightweightPreparedSettlement,
): OfflineApproximationResult {
  const actual = prepared.candidate;
  const normalizedActual = normalizeFastSettlementState(actual, source);
  if (!normalizedActual.ok) {
    return runConservativeOfflineSettlement(
      source,
      seconds,
      wallSeconds,
      `精确尾验未通过结构校验${normalizedActual.failure ? `：${normalizedActual.failure}` : ""}`,
    );
  }
  const actualValidation = capturePureIdleLightweightSnapshot(actual, prepared.sharedPaths);
  const comparison = comparePureIdleLightweightSnapshots(
    prepared.validationBaseline,
    prepared.expectedValidation,
    actualValidation,
  );
  const maxEstimatedError = compareTimeWarpCriticalSnapshots(
    prepared.criticalBaseline,
    prepared.expectedCritical,
    captureTimeWarpCriticalSnapshot(actual),
  );
  if (!Number.isFinite(maxEstimatedError) || maxEstimatedError > FAST_CRITICAL_MAX_ERROR) {
    return runConservativeOfflineSettlement(
      source,
      seconds,
      wallSeconds,
      `白糖或戴森尾验误差 ${(maxEstimatedError * 100).toFixed(2)}%，已使用保守宏观结算`,
    );
  }
  // Construction was deliberately excluded from both exact calibration and
  // validation. Run its authoritative recursive planner once against the
  // credited final inventories, then advance only the remaining clock.
  const construction = advanceConstructionAutomationMacroInPlace(actual, seconds);
  actual.elapsedSeconds = source.elapsedSeconds + seconds;
  const speedrunCorrection = normalizeFastSpeedrunClock(actual, source, wallSeconds);
  const normalizedFinal = normalizeFastSettlementState(actual, source);
  if (!normalizedFinal.ok || !validateFastNumbers(actual)) {
    return runConservativeOfflineSettlement(
      source,
      seconds,
      wallSeconds,
      `建筑制造巨构尾段未通过最终存档校验${normalizedFinal.failure ? `：${normalizedFinal.failure}` : ""}`,
    );
  }
  return {
    status: "approximate",
    state: actual,
    report: {
      mode: "approximate",
      calibrationWindowSeconds: FAST_OFFLINE_CALIBRATION_SECONDS,
      approximatedSeconds: prepared.macroSeconds,
      maxEstimatedError,
      fellBack: false,
      algorithmVersion: FAST_OFFLINE_ALGORITHM_VERSION,
      boundaryCorrections: prepared.boundaryCorrections + normalizedActual.corrections +
        normalizedFinal.corrections + speedrunCorrection,
      validationScope: "leaderboard-critical",
      maxNonCriticalError: comparison.maxError,
      settlementStatus: "approximate",
      researchInvested: prepared.researchInvested.toString(),
      ...(construction.completed > 0
        ? { fallbackReason: `建筑制造巨构按真实库存递归完成 ${construction.completed.toLocaleString("zh-CN")} 件` }
        : {}),
    },
  };
}

/**
 * Fast offline settlement: thirty seconds of the real engine calibrate the
 * current factory, then only the remaining interval is applied as a measured
 * state delta. It is intentionally isolated from the online simulation path.
 */
function runFastOfflineSettlementUnsafe(state: GameState, seconds: number, wallSeconds = seconds): OfflineApproximationResult {
  if (state.paused) return { status: "ineligible", report: fastExactReport(0, "存档已暂停") };
  if (!Number.isFinite(seconds) || seconds <= 0) return { status: "ineligible", report: fastExactReport(0, "离线时长无效") };
  if (state.speedrun?.enabled) {
    return { status: "ineligible", report: fastExactReport(0, "速通工厂必须使用有界精确结算") };
  }
  if (seconds <= FAST_OFFLINE_CALIBRATION_SECONDS) {
    return { status: "fallback", report: fastExactReport(Math.floor(seconds), "离线时长不超过 30 秒，使用精确结算") };
  }
  if (state.timeWarp.pendingSimulationSeconds > EPSILON || state.timeWarp.pendingWallSeconds > EPSILON) {
    return { status: "ineligible", report: fastExactReport(0, "存在未提交时间扭曲预算") };
  }
  if (!validateFastNumbers(state)) return { status: "ineligible", report: fastExactReport(0, "原始状态包含非法数值") };
  const wallCalibration = wallSeconds * FAST_OFFLINE_CALIBRATION_SECONDS / seconds;
  const calibrated = createPureIdleLightweightCalibration(
    state,
    wallCalibration,
    { isolateConstructionAutomation: true },
  );
  if (!calibrated) {
    return runConservativeOfflineSettlement(
      state,
      seconds,
      wallSeconds,
      "30 秒轻量校准没有形成可用样本，已使用保守宏观结算",
    );
  }
  const prepared = prepareFastLightweightSettlement(state, seconds, wallSeconds, calibrated);
  if ("failure" in prepared) {
    return runConservativeOfflineSettlement(state, seconds, wallSeconds, prepared.failure);
  }
  const constructionEnabled = prepared.candidate.constructionAutomation.enabled;
  prepared.candidate.constructionAutomation.enabled = false;
  try {
    runExact(prepared.candidate, FAST_OFFLINE_VALIDATION_SECONDS, prepared.validationWallSeconds);
  } finally {
    prepared.candidate.constructionAutomation.enabled = constructionEnabled;
  }
  return finalizeFastLightweightSettlement(state, seconds, wallSeconds, prepared);
}

function fastSettlementExceptionReport(error: unknown): OfflineApproximationReport {
  const detail = error instanceof Error && error.message
    ? `：${error.message.slice(0, 160)}`
    : "";
  return fastExactReport(
    FAST_OFFLINE_CALIBRATION_SECONDS,
    `快速结算遇到无效循环状态，已从原始存档改用保守宏观结算${detail}`,
  );
}

export function runFastOfflineSettlement(state: GameState, seconds: number, wallSeconds = seconds): OfflineApproximationResult {
  try {
    return runFastOfflineSettlementUnsafe(state, seconds, wallSeconds);
  } catch (error) {
    if (seconds > FAST_OFFLINE_CALIBRATION_SECONDS && !state.speedrun?.enabled) {
      return runConservativeOfflineSettlement(
        state,
        seconds,
        wallSeconds,
        fastSettlementExceptionReport(error).fallbackReason,
      );
    }
    return { status: "fallback", report: fastSettlementExceptionReport(error) };
  }
}

/** Worker counterpart of {@link runFastOfflineSettlement}; yields between each
 * exact calibration slice and the final validation window so cancellation is
 * observable without ever exposing a partially mutated state. */
async function runFastOfflineSettlementAsyncUnsafe(
  state: GameState,
  seconds: number,
  options: OfflineApproximationAsyncOptions = {},
): Promise<OfflineApproximationResult> {
  const wallSeconds = options.wallSeconds ?? seconds;
  if (state.paused) return { status: "ineligible", report: fastExactReport(0, "存档已暂停") };
  if (!Number.isFinite(seconds) || seconds <= 0) return { status: "ineligible", report: fastExactReport(0, "离线时长无效") };
  if (state.speedrun?.enabled) {
    return { status: "ineligible", report: fastExactReport(0, "速通工厂必须使用有界精确结算") };
  }
  if (seconds <= FAST_OFFLINE_CALIBRATION_SECONDS) {
    return { status: "fallback", report: fastExactReport(Math.floor(seconds), "离线时长不超过 30 秒，使用精确结算") };
  }
  if (state.timeWarp.pendingSimulationSeconds > EPSILON || state.timeWarp.pendingWallSeconds > EPSILON) {
    return { status: "ineligible", report: fastExactReport(0, "存在未提交时间扭曲预算") };
  }
  if (!validateFastNumbers(state)) return { status: "ineligible", report: fastExactReport(0, "原始状态包含非法数值") };
  throwIfApproximationCancelled(options);
  throwIfApproximationDeadlineReached(options);
  options.onPhase?.("calibrating");
  const wallCalibration = wallSeconds * FAST_OFFLINE_CALIBRATION_SECONDS / seconds;
  const calibrated = await createPureIdleLightweightCalibrationAsync(
    state,
    wallCalibration,
    options,
    { isolateConstructionAutomation: true },
  );
  if (!calibrated) {
    options.onPhase?.("conservative");
    return runConservativeOfflineSettlement(
      state,
      seconds,
      wallSeconds,
      "30 秒轻量校准没有形成可用样本，已使用保守宏观结算",
    );
  }
  options.onPhase?.("macro");
  throwIfApproximationDeadlineReached(options);
  const prepared = prepareFastLightweightSettlement(state, seconds, wallSeconds, calibrated);
  if ("failure" in prepared) {
    options.onPhase?.("conservative");
    return runConservativeOfflineSettlement(state, seconds, wallSeconds, prepared.failure);
  }
  options.onPhase?.("validating");
  const constructionEnabled = prepared.candidate.constructionAutomation.enabled;
  prepared.candidate.constructionAutomation.enabled = false;
  try {
    await runExactAsync(
      prepared.candidate,
      FAST_OFFLINE_VALIDATION_SECONDS,
      options,
      prepared.validationWallSeconds,
    );
  } finally {
    prepared.candidate.constructionAutomation.enabled = constructionEnabled;
  }
  options.onProgress?.(seconds, seconds);
  return finalizeFastLightweightSettlement(state, seconds, wallSeconds, prepared);
}

export async function runFastOfflineSettlementAsync(
  state: GameState,
  seconds: number,
  options: OfflineApproximationAsyncOptions = {},
): Promise<OfflineApproximationResult> {
  const startedAt = approximationNow();
  try {
    const result = await runFastOfflineSettlementAsyncUnsafe(state, seconds, options);
    result.report.wallClockMs = Math.max(0, approximationNow() - startedAt);
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (seconds > FAST_OFFLINE_CALIBRATION_SECONDS && !state.speedrun?.enabled) {
      const deadlineReached = error instanceof OfflineApproximationDeadlineError;
      const result = runConservativeOfflineSettlement(
        state,
        seconds,
        options.wallSeconds ?? seconds,
        deadlineReached
          ? "精确校准达到现实时间上限，已使用保守宏观结算"
          : fastSettlementExceptionReport(error).fallbackReason,
        // The timed-out calibration is an uncommitted candidate. Do not pay
        // for a second exact prefix after the deadline; freeze from a clean
        // source clone and advance only the clock.
        deadlineReached ? structuredClone(state) : undefined,
        0,
        undefined,
        deadlineReached,
      );
      result.report.wallClockMs = Math.max(0, approximationNow() - startedAt);
      return result;
    }
    return { status: "fallback", report: fastSettlementExceptionReport(error) };
  }
}

export function advanceExactSessionChunk(session: SimulationAdvanceSession, maximumSteps = 256): number {
  return advanceSimulationSession(session, Math.max(1, Math.floor(maximumSteps)));
}

export interface OfflineApproximationAsyncOptions {
  /** Called between exact calibration chunks so a Worker can honour cancel. */
  shouldCancel?: () => boolean;
  /** Optional progress hook for the two calibration/validation windows. */
  onProgress?: (completedSeconds: number, totalSeconds: number) => void;
  /** Maximum uninterrupted engine time before yielding to the Worker event loop. */
  yieldAfterMs?: number;
  /** Wall-clock budget paired with the simulation budget (time-warp aware). */
  wallSeconds?: number;
  /** Absolute performance.now()/Date.now() deadline for all exact work. */
  deadlineAtMs?: number;
  onPhase?: (phase: "calibrating" | "macro" | "conservative" | "validating") => void;
}

class OfflineApproximationDeadlineError extends Error {
  constructor() {
    super("快速离线精确校准达到现实时间上限");
    this.name = "OfflineApproximationDeadlineError";
  }
}

function approximationNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function throwIfApproximationDeadlineReached(options: OfflineApproximationAsyncOptions): void {
  if (options.deadlineAtMs !== undefined && approximationNow() >= options.deadlineAtMs) {
    throw new OfflineApproximationDeadlineError();
  }
}

function throwIfApproximationCancelled(options: OfflineApproximationAsyncOptions): void {
  if (!options.shouldCancel?.()) return;
  const error = new Error("近似离线结算已取消");
  error.name = "AbortError";
  throw error;
}

function yieldToWorker(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Async counterpart for the browser Worker. The synchronous contract above is
 * kept for deterministic unit tests and the realtime fallback; this version
 * only changes scheduling, never the engine steps or the projection formula.
 */
async function runExactAsync(
  source: GameState,
  seconds: number,
  options: OfflineApproximationAsyncOptions,
  wallSeconds = seconds,
): Promise<GameState> {
  const session = createSimulationAdvanceSession(source, seconds, { mutateState: true, wallSeconds });
  const yieldAfterMs = Math.max(8, options.yieldAfterMs ?? 40);
  let sliceStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  while (session.remainingSeconds > EPSILON) {
    throwIfApproximationCancelled(options);
    throwIfApproximationDeadlineReached(options);
    // One authoritative step can already be expensive on an 80k-entity /
    // 155k-belt save. Re-check cancellation and the wall deadline after every
    // step; the yield timer still batches cheap factories without adding a
    // task hop for each step.
    advanceSimulationSession(session, 1);
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - sliceStartedAt >= yieldAfterMs) {
      await yieldToWorker();
      sliceStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    }
  }
  throwIfApproximationCancelled(options);
  throwIfApproximationDeadlineReached(options);
  return completeSimulationAdvanceSession(session);
}

async function runAffineApproximationAsync(
  state: GameState,
  seconds: number,
  options: OfflineApproximationAsyncOptions,
): Promise<OfflineApproximationResult> {
  const windowSeconds = Math.min(MAX_CALIBRATION_SECONDS, Math.max(MIN_CALIBRATION_SECONDS, Math.floor(seconds / 12)));
  const wallSeconds = options.wallSeconds ?? seconds;
  const wallWindowSeconds = seconds > EPSILON ? wallSeconds * windowSeconds / seconds : windowSeconds;
  const first = await runExactAsync(structuredClone(state), windowSeconds, options, wallWindowSeconds);
  options.onProgress?.(windowSeconds, seconds);
  const second = await runExactAsync(structuredClone(first), windowSeconds, options, wallWindowSeconds);
  options.onProgress?.(windowSeconds * 2, seconds);
  const contract = createAffineContract(state, first, second, windowSeconds);
  if (!contract) return { status: "fallback", report: exactReport(windowSeconds, "复杂物流状态在连续校准窗口中不是稳定增量") };
  const macroSeconds = seconds - windowSeconds * 2 - contract.validationSeconds;
  if (macroSeconds < 1 || contract.deltas.some((delta) => delta.kind === "decimal" && macroSeconds % contract.windowSeconds !== 0) ||
    hasNonIntegralIntegerWindow(contract, macroSeconds)) {
    return { status: "fallback", report: exactReport(windowSeconds, "复杂物流状态需要在整数边界校准") };
  }
  throwIfApproximationCancelled(options);
  const macro = structuredClone(second);
  if (!applyAffineContract(macro, contract, macroSeconds) || !validateAffineState(macro)) {
    return { status: "fallback", report: exactReport(windowSeconds, "复杂物流宏观预测越过缓存、线路或安全整数边界") };
  }
  const expected = structuredClone(macro);
  if (!applyAffineContract(expected, contract, contract.validationSeconds) || !validateAffineState(expected)) {
    return { status: "fallback", report: exactReport(windowSeconds, "复杂物流验证预测越过安全边界") };
  }
  const wallValidationSeconds = seconds > EPSILON ? wallSeconds * contract.validationSeconds / seconds : contract.validationSeconds;
  const actual = await runExactAsync(structuredClone(macro), contract.validationSeconds, options, wallValidationSeconds);
  const maxEstimatedError = compareAffineSnapshots(actual, expected);
  options.onProgress?.(seconds, seconds);
  if (!Number.isFinite(maxEstimatedError) || maxEstimatedError > MAX_ERROR) {
    return {
      status: "fallback",
      report: { ...exactReport(windowSeconds, `复杂物流精确验证误差 ${(maxEstimatedError * 100).toFixed(2)}% 超过 20%`), maxEstimatedError },
    };
  }
  return {
    status: "approximate",
    state: actual,
    report: {
      mode: "approximate",
      calibrationWindowSeconds: windowSeconds,
      approximatedSeconds: macroSeconds,
      maxEstimatedError,
      fellBack: false,
    },
  };
}

/**
 * Worker-friendly approximation entry point. It mirrors
 * `runOfflineApproximation` exactly, but yields between engine slices so an
 * AbortSignal can terminate a long calibration without committing a partial
 * state. The original state is never mutated.
 */
export async function runOfflineApproximationAsync(
  state: GameState,
  seconds: number,
  options: OfflineApproximationAsyncOptions = {},
): Promise<OfflineApproximationResult> {
  throwIfApproximationCancelled(options);
  const blocker = getOfflineApproximationBlocker(state, seconds);
  if (blocker) return { status: "ineligible", report: exactReport(0, blocker) };
  if (hasAffineFlow(state)) return runAffineApproximationAsync(state, seconds, options);
  const initialBoundary = cacheIsAwayFromBoundary(state);
  if (initialBoundary) return { status: "ineligible", report: exactReport(0, initialBoundary) };

  const windowSeconds = Math.min(MAX_CALIBRATION_SECONDS, Math.max(MIN_CALIBRATION_SECONDS, Math.floor(seconds / 12)));
  const wallSeconds = options.wallSeconds ?? seconds;
  const wallWindowSeconds = seconds > EPSILON ? wallSeconds * windowSeconds / seconds : windowSeconds;
  const first = await runExactAsync(structuredClone(state), windowSeconds, options, wallWindowSeconds);
  options.onProgress?.(windowSeconds, seconds);
  const second = await runExactAsync(structuredClone(first), windowSeconds, options, wallWindowSeconds);
  options.onProgress?.(windowSeconds * 2, seconds);
  const firstProjection = captureProjection(first);
  const secondProjection = captureProjection(second);
  const firstRates = diffProjection(captureProjection(structuredClone(state)), firstProjection, windowSeconds);
  const secondRates = diffProjection(firstProjection, secondProjection, windowSeconds);
  if (!ratesStable(firstRates, secondRates)) {
    return { status: "fallback", report: exactReport(windowSeconds, "连续精确校准窗口速率变化超过 5%") };
  }
  throwIfApproximationCancelled(options);
  const boundary = cacheIsAwayFromBoundary(second);
  if (boundary) return { status: "fallback", report: exactReport(windowSeconds, boundary) };
  const macroSeconds = seconds - windowSeconds * 2 - VALIDATION_SECONDS;
  if (macroSeconds < 1) return { status: "fallback", report: exactReport(windowSeconds, "校准窗口后没有足够的宏观时间") };

  const macro = structuredClone(second);
  if (!applyRates(macro, secondRates, macroSeconds) || !validateProjectedState(macro, secondProjection)) {
    return { status: "fallback", report: exactReport(windowSeconds, "宏观预测超出安全整数或缓存边界") };
  }
  const expected = structuredClone(macro);
  if (!applyRates(expected, secondRates, VALIDATION_SECONDS) || !validateProjectedState(expected, captureProjection(macro))) {
    return { status: "fallback", report: exactReport(windowSeconds, "验证预测超出安全整数或缓存边界") };
  }
  const wallValidationSeconds = seconds > EPSILON ? wallSeconds * VALIDATION_SECONDS / seconds : VALIDATION_SECONDS;
  const actual = await runExactAsync(structuredClone(macro), VALIDATION_SECONDS, options, wallValidationSeconds);
  const maxEstimatedError = compareProjection(captureProjection(actual), captureProjection(expected));
  options.onProgress?.(seconds, seconds);
  if (!Number.isFinite(maxEstimatedError) || maxEstimatedError > MAX_ERROR) {
    return {
      status: "fallback",
      report: { ...exactReport(windowSeconds, `精确验证误差 ${(maxEstimatedError * 100).toFixed(2)}% 超过 20%`), maxEstimatedError },
    };
  }
  return {
    status: "approximate",
    state: actual,
    report: {
      mode: "approximate",
      calibrationWindowSeconds: windowSeconds,
      approximatedSeconds: macroSeconds,
      maxEstimatedError,
      fellBack: false,
    },
  };
}
