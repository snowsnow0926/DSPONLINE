import {
  CONSTRUCTION,
  FUEL_ENERGY_MJ,
  getBuilding,
  getFuelEfficiency,
  getRecipe,
  getTechnology,
  ITEMS,
  MATRIX_ITEM_IDS,
} from "./content";
import { CAMPAIGN_TASKS } from "./campaign";
import { GALACTIC_EXPORT_DEFINITIONS } from "./endgame";
import {
  ACCUMULATOR_ENERGY_MJ,
  advanceConstructionAutomationMacroInPlace,
  advanceDysonRocketMacroInPlace,
  advanceSimulationBudget,
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createSimulationAdvanceSession,
  getEntityInputCapacity,
  getEntityOutputCapacity,
  getEntityProliferatorItemId,
  getStationSlots,
  getTechnologyConstructionRewards,
  hasActiveResearch,
  normalizeConstructionAutomationCursor,
  refreshDysonGenerationSnapshot,
  refreshTimeWarpPowerSnapshotInPlace,
  getResourceReserveSnapshot,
  getVeinConsumptionMultiplier,
  PORTABLE_FLEET_ITEM_IDS,
  type SimulationPowerAuditSample,
  type SimulationAdvanceSession,
  type SimulationProfiler,
} from "./engine";
import { getDifficultyDefinition } from "./difficulty";
import type { FactoryEntity, GameState, ItemId, PlanetId, PowerGridId } from "./types";
import { getQuantumBandwidthSummary, QUANTUM_SETTLEMENT_SECONDS } from "./quantumLogisticsNetwork";
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
  /** True when a previously exact-validated rolling certificate was reused. */
  certificateReused?: boolean;
  /** Wall-clock age since the last exact certificate refresh. */
  certificateAgeWallSeconds?: number;
}

export interface TimeWarpApproximationResult {
  state: GameState;
  report: TimeWarpApproximationReport;
}

interface TimeWarpRollingCertificate {
  contract: PureIdleAffineContract;
  researchLedger: ResearchMacroLedger;
  researchRemainder: bigint;
  researchInflowRemainders: Parameters<typeof advanceResearchMacroInPlace>[4];
  integerRemainders: Record<string, number>;
  decimalRemainders: Record<string, bigint>;
  remainingSimulationSecondsByItem: Record<string, number>;
  ageWallSeconds: number;
  lastCriticalError: number;
  entityArray: GameState["entities"];
  beltArray: GameState["belts"];
  mode: GameState["mode"];
  version: number;
  controllerEntityId?: string;
  requestedMultiplier: number;
  /** Exact-proven power dispatch plus its finite, physically debited fuel bank. */
  powerTail: PureIdlePowerTailCertificate;
}

const TIME_WARP_ROLLING_CERTIFICATE_VALIDATION_WALL_SECONDS = 10;
const timeWarpRollingCertificates = new WeakMap<GameState, TimeWarpRollingCertificate>();

export function invalidateTimeWarpApproximationCertificate(state: GameState): void {
  timeWarpRollingCertificates.delete(state);
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
export const FAST_OFFLINE_ALGORITHM_VERSION = "fast-30s-v6-final-conservation-gate";
export const FAST_OFFLINE_DESKTOP_DEADLINE_MS = 30_000;
export const FAST_OFFLINE_MOBILE_DEADLINE_MS = 60_000;
export const TIME_WARP_APPROXIMATION_ALGORITHM_VERSION = "time-warp-rolling-v6-final-conservation-gate";
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

interface ExactSimulationWindowOptions {
  isolateConstructionAutomation?: boolean;
}

function runExact(
  source: GameState,
  seconds: number,
  wallSeconds = seconds,
  options: ExactSimulationWindowOptions = {},
): GameState {
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
    const session = createSimulationAdvanceSession(state, chunkSeconds, {
      mutateState: true,
      wallSeconds: chunkWallSeconds,
      ...(options.isolateConstructionAutomation ? {
        contractExperiment: { isolateConstructionAutomation: true },
      } : {}),
    });
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
 * Run consecutive exact calibration windows while retaining the authoritative
 * completion boundary after every window.  A completion can replace only the
 * top-level GameState object (campaign/speedrun synchronization), while the
 * entity and belt arrays remain authoritative and keep the existing lookup
 * valid.  Reuse that lookup in the next window; rebuild it only when a real
 * topology transition replaces either array.
 *
 * This deliberately does not collapse the three ten-second samples into one
 * thirty-second session.  Production history, completed research, campaign
 * progress and speedrun milestones must still settle at exactly the same
 * boundaries as the historical implementation.
 */
function runExactCalibrationWindows(
  source: GameState,
  windowSeconds: number,
  windowWallSeconds: number,
  windowCount: number,
  onWindowCompleted: (state: GameState, windowIndex: number) => void,
  onPowerPlan?: (sample: SimulationPowerAuditSample) => void,
  isolateConstructionAutomation = false,
): GameState {
  let state = source;
  let lookup: SimulationAdvanceSession["lookup"];
  for (let index = 0; index < windowCount; index += 1) {
    const entitiesBefore = state.entities;
    const beltsBefore = state.belts;
    const session = createSimulationAdvanceSession(state, windowSeconds, {
      mutateState: true,
      wallSeconds: windowWallSeconds,
      lookup,
      ...(onPowerPlan || isolateConstructionAutomation ? {
        contractExperiment: {
          ...(onPowerPlan ? { onPowerPlan } : {}),
          ...(isolateConstructionAutomation ? { isolateConstructionAutomation: true } : {}),
        },
      } : {}),
    });
    while (session.remainingSeconds > EPSILON || session.remainingWallSeconds > EPSILON) {
      advanceSimulationSession(session, 256);
    }
    state = completeSimulationAdvanceSession(session);
    lookup = state.entities === entitiesBefore && state.belts === beltsBefore
      ? session.lookup
      : undefined;
    onWindowCompleted(state, index);
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
  options: ExactSimulationWindowOptions = {},
): GameState {
  return runExact(source, seconds, wallSeconds, options);
}

interface StagedExactConstructionWindow {
  state: GameState;
  receipt: ConstructionRecipeReceipt;
  authority: PureIdleCombinedConservationCheckpointAuthority;
}

function stageExactSimulationWindowWithConstructionReceipt(
  source: GameState,
  seconds: number,
  wallSeconds: number,
  checkpoint: PureIdleCombinedConservationCheckpoint,
): StagedExactConstructionWindow {
  const authority = requirePureIdleCombinedCheckpoint(checkpoint);
  // Exact simulation may move construction ingredients through any ordinary
  // ownership store (for example station output -> quantum warehouse ->
  // construction buffer) inside the same window. Audit the complete aggregate
  // domain so a legal transfer-and-consume path is neither missed nor counted
  // as free construction credit.
  const stageBefore = captureConstructionRecipeStageSnapshot(source, "aggregate");
  const state = runExact(source, seconds, wallSeconds);
  const receipt = createConstructionRecipeReceipt(stageBefore, state);
  if (typeof receipt === "string") throw new Error(`精确施工阶段最终物资守恒失败：${receipt}`);
  return { state, receipt, authority };
}

function commitStagedExactConstructionReceipt(staged: StagedExactConstructionWindow): void {
  mergeConstructionRecipeReceipt(staged.authority.constructionRecipeReceipt, staged.receipt);
  staged.authority.constructionPowerReceipt.exactAuthorizedCrafted += staged.receipt.crafted;
}

/**
 * Exact-engine compatibility path for the stateful quantum-construction
 * boundary. The receipt can only be issued around this internal exact call;
 * callers cannot turn an arbitrary before/after pair into construction credit.
 */
export function advanceExactSimulationWindowWithConstructionReceipt(
  source: GameState,
  seconds: number,
  wallSeconds: number,
  checkpoint: PureIdleCombinedConservationCheckpoint,
): GameState {
  const staged = stageExactSimulationWindowWithConstructionReceipt(
    source,
    seconds,
    wallSeconds,
    checkpoint,
  );
  commitStagedExactConstructionReceipt(staged);
  return staged.state;
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
  /**
   * Conservative, closed-flow production factors proven from all three exact
   * calibration windows. A positive factor means the item's sampled
   * manufacture is funded by repeatable upstream production instead of a
   * one-shot station/cache drawdown. These entries deliberately carry no
   * inventory delta: production and its observed internal consumption cancel
   * inside the certified steady-state domain.
   */
  steadyStateFactorsByItem?: Record<string, number>;
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

function sameStableIdValues<T extends { id: string }>(beforeIds: readonly string[], after: T[] | undefined): boolean {
  if (!after || beforeIds.length !== after.length) return false;
  return beforeIds.every((id, index) => id === after[index]?.id);
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
  // Realtime time-warp certificates deliberately use a half-second exact
  // probe. Rounding that duration up to one second doubles every depletion
  // horizon and can let a research inflow replay more material than the
  // source stores own. Keep the duration in integer microseconds instead.
  const calibrationMicros = BigInt(Math.max(
    1,
    Math.floor(contract.calibrationSeconds * Number(PURE_IDLE_DELTA_MICROS_PER_ITEM)),
  ));
  const maximumSafeMicros = BigInt(Number.MAX_SAFE_INTEGER) * PURE_IDLE_DELTA_MICROS_PER_ITEM;
  for (const [itemId, deltaMicros] of deltasByItem) {
    if (deltaMicros >= 0n) continue;
    const available = captured.totals.get(itemId) ?? 0n;
    const horizonMicros = available * calibrationMicros * microsPerUnit / -deltaMicros;
    if (horizonMicros <= maximumSafeMicros) {
      maximumByItem[itemId] = Math.max(
        0,
        Number(horizonMicros) / Number(PURE_IDLE_DELTA_MICROS_PER_ITEM),
      );
    }
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
      // Rockets now have a separate closed terminal event ledger. Propagate
      // their ingredient boundary even though their stores remain excluded
      // from the ordinary affine contract. Solar sails remain frozen.
      .filter((output) => output.itemId === "small_carrier_rocket" ||
        !PURE_IDLE_LIGHTWEIGHT_FROZEN_ITEMS.has(output.itemId))
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
  return removeResearchInputDeltasAtIndexes(contract, new Set(state.entities
    .map((entity, index) => entity.recipeId === "matrix_research" ? index : -1)
    .filter((index) => index >= 0)));
}

function removeResearchInputDeltasAtIndexes(
  contract: PureIdleAffineContract,
  researchIndexes: ReadonlySet<number>,
): PureIdleAffineContract {
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
  /** False only when storage or an invalid power sample cannot prove any safe tail. */
  powerTailCertified: boolean;
  powerTailRejectionReason?: string;
  /** Non-persisted certificate used to debit finite generator fuel during macro buckets. */
  powerTail: PureIdlePowerTailCertificate;
  /** Opaque per-grid renewable headroom proof for isolated construction work. */
  constructionPowerCertificate: PureIdleConstructionPowerCertificate;
  /** Optional first closed terminal event domain; absent means freeze. */
  rocketLedger?: PureIdleRocketMacroLedger;
  /** Player-facing explanation when the terminal rocket domain must freeze. */
  rocketLedgerRejectionReason?: string;
  /** Temporary shadow result used only to derive diagnostics, then released. */
  calibratedState: GameState;
  calibrationSeconds: number;
  calibrationWallSeconds: number;
}

export interface PureIdlePowerFuelDebit {
  entityId: string;
  fuelItemId: ItemId;
  /** Thermal MJ consumed by this generator per credited simulation second. */
  thermalMjPerSimulationSecond: number;
  /** A three-window material-flow proof pays this burn without draining old stock. */
  sustainable: boolean;
}

export interface PureIdlePowerTailCertificate {
  /** Exact-proven productive simulation seconds per wall second. */
  productiveMultiplier: number;
  fuelDebits: PureIdlePowerFuelDebit[];
  /** Null means renewable/Dyson or closed replenishment can sustain the tail. */
  maximumSimulationSeconds: number | null;
  /** Storage discharge is frozen until a closed charge/discharge ledger exists. */
  storageDispatchDetected: boolean;
  rejectionReason?: string;
}

const PURE_IDLE_CONSTRUCTION_POWER_CERTIFICATE_BRAND = Symbol("pure-idle-construction-power-certificate");

/**
 * Non-persisted authority. Its usable contents live only in the issuing
 * module's WeakMap, so save data or a caller-created object cannot grant
 * construction electricity.
 */
export interface PureIdleConstructionPowerCertificate {
  readonly [PURE_IDLE_CONSTRUCTION_POWER_CERTIFICATE_BRAND]: true;
}

interface PureIdleConstructionPowerGridGrant {
  planetId: PlanetId;
  gridId: PowerGridId;
  minimumRenewableHeadroomKw: number;
  centerDemandKwById: Map<string, number>;
  centerPriorityById: Map<string, 1 | 2 | 3>;
  minimumPowerFactorByCenterId: Map<string, number>;
}

interface PureIdleConstructionPowerCertificateAuthority {
  contract: PureIdleAffineContract;
  difficulty: GameState["settings"]["difficulty"];
  controllerEntityId?: string;
  requestedMultiplier: number;
  researchFingerprint: string;
  entityArrays: Set<GameState["entities"]>;
  beltArrays: Set<GameState["belts"]>;
  grids: Map<string, PureIdleConstructionPowerGridGrant>;
  quantumGrant?: PureIdleConstructionQuantumGrant;
}

interface PureIdleConstructionQuantumGrant {
  fingerprint: string;
  downloadPerBoundary: number;
}

const PURE_IDLE_CONSTRUCTION_QUANTUM_REPLAY_SECONDS = 30;

const PURE_IDLE_CONSTRUCTION_POWER_CERTIFICATES = new WeakMap<
  PureIdleConstructionPowerCertificate,
  PureIdleConstructionPowerCertificateAuthority
>();

function constructionPowerResearchFingerprint(state: GameState): string {
  const completed = [...state.research.completedTechIds].sort().join(",");
  const infinite = Object.entries(state.endgame.infiniteResearch)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, progress]) => `${id}:${Math.max(0, Math.floor(progress.level))}`)
    .join(",");
  return `${completed}|${infinite}`;
}

interface ConstructionPowerGridAudit {
  observedSimulationSeconds: number;
  maximumStepSeconds: number;
  minimumRenewableHeadroomKw: number;
  maximumFiniteGenerationKw: number;
  maximumStorageDischargeKw: number;
  minimumPowerFactorByCenterId: Map<string, number>;
  invalid: boolean;
}

interface ConstructionPowerAuditAccumulator {
  grids: Map<string, ConstructionPowerGridAudit>;
  onPowerPlan: (sample: SimulationPowerAuditSample) => void;
}

function constructionPowerGridKey(planetId: PlanetId, gridId: PowerGridId): string {
  return `${planetId}|${gridId}`;
}

function createConstructionPowerAuditAccumulator(): ConstructionPowerAuditAccumulator {
  const grids = new Map<string, ConstructionPowerGridAudit>();
  return {
    grids,
    onPowerPlan: (sample) => {
      const finiteGenerationKw = sample.thermalGenerationKw + sample.fusionGenerationKw +
        sample.artificialStarGenerationKw;
      const renewableGenerationKw = sample.windGenerationKw + sample.solarGenerationKw +
        sample.geothermalGenerationKw + sample.rayGenerationKw;
      const values = [
        sample.simulationSeconds,
        sample.demandKw,
        sample.constructionDemandKw,
        renewableGenerationKw,
        finiteGenerationKw,
        sample.storageDischargeKw,
        sample.storageChargeKw,
      ];
      const key = constructionPowerGridKey(sample.planetId, sample.gridId);
      const current = grids.get(key) ?? {
        observedSimulationSeconds: 0,
        maximumStepSeconds: 0,
        minimumRenewableHeadroomKw: Number.POSITIVE_INFINITY,
        maximumFiniteGenerationKw: 0,
        maximumStorageDischargeKw: 0,
        minimumPowerFactorByCenterId: new Map<string, number>(),
        invalid: false,
      };
      if (values.some((value) => !Number.isFinite(value) || value < -EPSILON) ||
        sample.simulationSeconds <= EPSILON) {
        current.invalid = true;
      } else {
        // Construction remains in the real priority allocation, but its work
        // is isolated. Remove only its connected rated demand to derive the
        // renewable budget that may later be issued back to that domain.
        const ordinaryDemandKw = Math.max(0, sample.demandKw - sample.constructionDemandKw);
        const renewableHeadroomKw = renewableGenerationKw - ordinaryDemandKw - sample.storageChargeKw;
        current.observedSimulationSeconds += sample.simulationSeconds;
        current.maximumStepSeconds = Math.max(current.maximumStepSeconds, sample.simulationSeconds);
        current.minimumRenewableHeadroomKw = Math.min(
          current.minimumRenewableHeadroomKw,
          Math.max(0, renewableHeadroomKw),
        );
        current.maximumFiniteGenerationKw = Math.max(current.maximumFiniteGenerationKw, finiteGenerationKw);
        current.maximumStorageDischargeKw = Math.max(
          current.maximumStorageDischargeKw,
          sample.storageDischargeKw,
        );
        for (const [centerId, rawFactor] of Object.entries(sample.constructionPowerFactorByCenterId)) {
          const factor = Number(rawFactor);
          if (!Number.isFinite(factor) || factor < -EPSILON || factor > 1 + EPSILON) {
            current.invalid = true;
            continue;
          }
          current.minimumPowerFactorByCenterId.set(
            centerId,
            Math.min(current.minimumPowerFactorByCenterId.get(centerId) ?? 1, Math.max(0, Math.min(1, factor))),
          );
        }
      }
      grids.set(key, current);
    },
  };
}

/**
 * A bounded quantum-construction replay may use the shared per-boundary
 * download budget only when the thirty-second isolated sample proves that no
 * ordinary demand tower competes for it. This intentionally recognizes a
 * narrow, common case instead of guessing future demand from transient stock.
 */
function constructionQuantumMacroFingerprint(state: GameState): string | null {
  if (!state.constructionAutomation.enabled ||
    state.constructionAutomation.quantumSourceEnabled !== true ||
    !state.quantumLogisticsNetwork?.enabled) return null;
  const centers = state.entities
    .filter((entity) => entity.buildingId === "construction_center")
    .map((center) => ({
      id: center.id,
      planetId: center.planetId,
      machineCount: Math.max(0, Math.floor(center.machineCount)),
      gridId: center.powerGridId ?? "grid-a",
      priority: center.powerPriority ?? 2,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (centers.length === 0) return null;

  const activeTargets = Object.entries(state.constructionAutomation.targetStock)
    .filter(([targetId, rawTarget]) => {
      const target = Math.max(0, Math.floor(rawTarget ?? 0));
      const current = Object.prototype.hasOwnProperty.call(state.portableFleet, targetId)
        ? Math.max(0, Math.floor(state.portableFleet[targetId as keyof typeof state.portableFleet] ?? 0))
        : Math.max(0, Math.floor(state.construction[targetId as keyof typeof state.construction] ?? 0));
      return target > current;
    })
    .map(([id, rawTarget]) => [id, Math.max(0, Math.floor(rawTarget ?? 0))] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  // One active recursive recipe keeps the bounded construction-only replay
  // stable. Multiple targets keep the normal fair scheduler and therefore do
  // not receive a shared-network replay grant.
  if (activeTargets.length !== 1) return null;
  const activeTargetId = activeTargets[0]![0];
  if (Object.values(state.constructionAutomation.jobs).some((job) =>
    job.constructionId !== activeTargetId)) return null;

  const quantumTowers = state.entities
    .filter((entity) => entity.kind === "station" &&
      entity.buildingId === "interstellar_logistics_station" && entity.quantumMode === "quantum")
    .map((tower) => ({
      id: tower.id,
      machineCount: Math.max(0, Math.floor(tower.machineCount)),
      slots: getStationSlots(tower)
        .filter((slot) => slot.itemId)
        .map((slot) => ({
          itemId: slot.itemId,
          remoteMode: slot.remoteMode,
          priority: slot.priority ?? 1,
        })),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (quantumTowers.length === 0 || quantumTowers.some((tower) =>
    tower.slots.some((slot) => slot.remoteMode === "demand"))) return null;
  return JSON.stringify({
    centers,
    activeTargets,
    quantumTowers,
    targetStock: Object.entries(state.constructionAutomation.targetStock)
      .map(([id, amount]) => [id, Math.max(0, Math.floor(amount ?? 0))])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  });
}

function createPureIdleConstructionQuantumGrant(
  state: GameState,
  acceptedStates: readonly GameState[],
): PureIdleConstructionQuantumGrant | undefined {
  const fingerprint = constructionQuantumMacroFingerprint(state);
  if (!fingerprint || acceptedStates.some((candidate) =>
    constructionQuantumMacroFingerprint(candidate) !== fingerprint)) return undefined;
  const level = state.endgame.infiniteResearch.galactic_logistics?.level ?? 0;
  const bandwidth = getQuantumBandwidthSummary(state.entities, level);
  const downloadPerBoundary = Math.max(0, Math.floor(
    bandwidth.globalDownloadPerMinute * QUANTUM_SETTLEMENT_SECONDS / 60,
  ));
  if (!Number.isSafeInteger(downloadPerBoundary) || downloadPerBoundary < 1) return undefined;
  return { fingerprint, downloadPerBoundary };
}

function issuePureIdleConstructionPowerCertificate(
  state: GameState,
  contract: PureIdleAffineContract,
  audit: ConstructionPowerAuditAccumulator,
  expectedSimulationSeconds: number,
  acceptedStates: readonly GameState[] = [state],
): PureIdleConstructionPowerCertificate {
  const certificate = Object.freeze({
    [PURE_IDLE_CONSTRUCTION_POWER_CERTIFICATE_BRAND]: true as const,
  });
  const grids = new Map<string, PureIdleConstructionPowerGridGrant>();
  const centersByGrid = new Map<string, FactoryEntity[]>();
  for (const center of state.entities) {
    if (center.buildingId !== "construction_center") continue;
    const gridId = center.powerGridId ?? "grid-a";
    const key = constructionPowerGridKey(center.planetId, gridId);
    const centers = centersByGrid.get(key) ?? [];
    centers.push(center);
    centersByGrid.set(key, centers);
  }
  const difficultyPowerMultiplier = getDifficultyDefinition(state.settings.difficulty).powerDemandMultiplier;
  for (const [key, centers] of centersByGrid) {
    const sample = audit.grids.get(key);
    if (!sample || sample.invalid ||
      sample.observedSimulationSeconds + EPSILON < expectedSimulationSeconds ||
      sample.maximumStepSeconds > 1 + EPSILON ||
      sample.maximumFiniteGenerationKw > EPSILON ||
      sample.maximumStorageDischargeKw > EPSILON ||
      !Number.isFinite(sample.minimumRenewableHeadroomKw) ||
      sample.minimumRenewableHeadroomKw <= EPSILON) continue;
    const [planetId, gridId] = key.split("|") as [PlanetId, PowerGridId];
    grids.set(key, {
      planetId,
      gridId,
      minimumRenewableHeadroomKw: sample.minimumRenewableHeadroomKw,
      centerDemandKwById: new Map(centers.map((center) => [
        center.id,
        Math.max(0, getBuilding("construction_center").powerDemandKw ?? 0) *
          Math.max(0, center.machineCount) * difficultyPowerMultiplier,
      ])),
      centerPriorityById: new Map(centers.map((center) => [center.id, center.powerPriority ?? 2])),
      minimumPowerFactorByCenterId: new Map(centers.map((center) => [
        center.id,
        sample.minimumPowerFactorByCenterId.get(center.id) ?? 0,
      ])),
    });
  }
  const quantumGrant = createPureIdleConstructionQuantumGrant(state, acceptedStates);
  PURE_IDLE_CONSTRUCTION_POWER_CERTIFICATES.set(certificate, {
    contract,
    difficulty: state.settings.difficulty,
    ...(state.timeWarp.controllerEntityId ? { controllerEntityId: state.timeWarp.controllerEntityId } : {}),
    requestedMultiplier: state.timeWarp.requestedMultiplier,
    researchFingerprint: constructionPowerResearchFingerprint(state),
    entityArrays: new Set(acceptedStates.map((candidate) => candidate.entities)),
    beltArrays: new Set(acceptedStates.map((candidate) => candidate.belts)),
    grids,
    ...(quantumGrant ? { quantumGrant } : {}),
  });
  return certificate;
}

function rebindPureIdleConstructionPowerCertificateAfterValidatedTransaction(
  certificate: PureIdleConstructionPowerCertificate | undefined,
  contract: PureIdleAffineContract,
  baseline: GameState,
  candidate: GameState,
): void {
  if (!certificate) return;
  const authority = PURE_IDLE_CONSTRUCTION_POWER_CERTIFICATES.get(certificate);
  if (!authority || authority.contract !== contract ||
    !authority.entityArrays.has(baseline.entities) ||
    !authority.beltArrays.has(baseline.belts)) return;
  // normalizeFastSettlementState plus the material/terminal gates have already
  // rejected topology drift. Extending only the two array identities lets a
  // transactional structuredClone remain authorized without storing another
  // O(entity+line) topology snapshot in the certificate.
  authority.entityArrays.add(candidate.entities);
  authority.beltArrays.add(candidate.belts);
}

export interface PureIdleRocketMacroLedger {
  calibrationSeconds: number;
  /** Credited manufacture. This is required to fund every tail launch. */
  producedPerWindow: number;
  launchedPerWindow: number;
  /** Per-system launch weights; their integer sum equals launchedPerWindow. */
  launchesBySystemPerWindow: Record<string, number>;
}

export interface PureIdleRocketMacroPlan {
  launched: number;
  launchesBySystem: Record<string, number>;
  remaindersBySystem: Record<string, number>;
  failure?: string;
}

export interface PureIdleLightweightCalibrationOptions {
  /**
   * Measure ordinary production without construction-center consumption.
   * Unmetered domain-only construction must remain frozen after this probe;
   * only receipt-aware exact windows may advance it until ordinary and
   * construction demand share one closed per-grid energy certificate.
   */
  isolateConstructionAutomation?: boolean;
  /**
   * Consume an already isolated Worker-owned state instead of cloning a
   * second 40-80 MiB object graph.  A caller enabling this must retain the
   * authoritative checkpoint outside the Worker and must not expose the
   * candidate until the real calibration wall time has elapsed.
   */
  consumeState?: boolean;
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
  /** Receipt authority for an exact fallback that may advance construction. */
  constructionCheckpoint?: PureIdleCombinedConservationCheckpoint;
  /** Rebind an opaque construction-power grant only across this validated transaction. */
  constructionPowerCertificate?: PureIdleConstructionPowerCertificate;
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

export interface AggregateConservationBaseline {
  totals: Map<string, bigint>;
  totalProduced: Map<string, bigint>;
  knownConsumed: Map<string, bigint>;
  knownGranted: Map<string, bigint>;
  constructionOutputs: Map<string, bigint>;
  constructionCrafted: bigint;
  failure?: string;
}

const CAMPAIGN_TASK_BY_ID = new Map(CAMPAIGN_TASKS.map((task) => [task.id, task]));

/**
 * Cumulative, replay-safe inventory grants that are intentionally not factory
 * production. Campaign rewards and technology unlock gifts can cross an exact
 * calibration boundary, so conservation must credit their audited ledgers
 * instead of misclassifying a legitimate building/item reward as duplication.
 */
function captureKnownMaterialGrants(state: GameState): { totals: Map<string, bigint>; failure?: string } {
  const totals = new Map<string, bigint>();
  let failure: string | undefined;
  const addGrant = (itemId: string, raw: unknown, label: string): void => {
    const amount = aggregateItemAmount(raw);
    if (amount === null) failure ??= `${label} 不是非负安全整数`;
    else addAggregateAmount(totals, itemId, amount);
  };
  for (const taskId of state.campaign.rewardedTaskIds) {
    const task = CAMPAIGN_TASK_BY_ID.get(taskId);
    if (!task) continue;
    for (const reward of task.rewards ?? []) {
      const itemId = reward.constructionId ?? reward.itemId;
      if (itemId) addGrant(itemId, Math.max(0, Math.floor(reward.amount)), `campaign.${taskId}.rewards.${itemId}`);
    }
  }
  for (const techId of state.research.completedTechIds) {
    for (const constructionId of getTechnologyConstructionRewards(techId)) {
      addGrant(constructionId, 2, `research.${techId}.construction.${constructionId}`);
    }
    // This one-off unlock is part of completeTechnology but is intentionally
    // excluded from the ordinary two-building reward list because it is a
    // megastructure. Crediting the cumulative completed-tech ledger keeps the
    // before/after delta exact for the completion boundary.
    if (techId === "universe_matrix") {
      addGrant("galactic_material_exporter", 1, `research.${techId}.construction.galactic_material_exporter`);
    }
  }
  return { totals, ...(failure ? { failure } : {}) };
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

function captureConstructionOutputStores(state: GameState): { totals: Map<string, bigint>; failure?: string } {
  const totals = new Map<string, bigint>();
  let failure: string | undefined;
  for (const [itemId, raw] of [
    ...Object.entries(state.construction),
    ...Object.entries(state.portableFleet),
  ]) {
    const amount = aggregateItemAmount(raw);
    if (amount === null) failure ??= `constructionOutputs.${itemId} 不是非负安全整数`;
    else addAggregateAmount(totals, itemId, amount);
  }
  return { totals, ...(failure ? { failure } : {}) };
}

export function captureAggregateConservationBaseline(state: GameState): AggregateConservationBaseline {
  const totalProduced = new Map<string, bigint>();
  for (const [itemId, raw] of Object.entries(state.totalProduced)) {
    if (Number.isSafeInteger(raw) && raw >= 0) totalProduced.set(itemId, BigInt(raw));
  }
  const captured = captureAggregateItemStores(state);
  const consumed = captureKnownMaterialConsumption(state);
  const granted = captureKnownMaterialGrants(state);
  const constructionOutputs = captureConstructionOutputStores(state);
  const constructionCrafted = aggregateItemAmount(state.constructionAutomation.totalCrafted);
  const failure = captured.failure ?? consumed.failure ?? granted.failure ?? constructionOutputs.failure ??
    (constructionCrafted === null ? "constructionAutomation.totalCrafted 不是非负安全整数" : undefined);
  return {
    totals: captured.totals,
    totalProduced,
    knownConsumed: consumed.totals,
    knownGranted: granted.totals,
    constructionOutputs: constructionOutputs.totals,
    constructionCrafted: constructionCrafted ?? 0n,
    ...(failure ? { failure } : {}),
  };
}

function constructionCatalogInteger(value: number, label: string): bigint | string {
  if (!Number.isSafeInteger(value) || value < 1) return `${label} 不是正安全整数`;
  return BigInt(value);
}

function addConstructionRecipeCost(
  required: Map<string, bigint>,
  itemId: string,
  unitCost: number,
  batches: bigint,
  label: string,
): string | null {
  const cost = constructionCatalogInteger(unitCost, label);
  if (typeof cost === "string") return cost;
  required.set(itemId, (required.get(itemId) ?? 0n) + cost * batches);
  return null;
}

function floorBigIntRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("positive denominator required");
  if (numerator >= 0n) return numerator / denominator;
  return -((-numerator + denominator - 1n) / denominator);
}

function ceilBigIntRatio(numerator: bigint, denominator: bigint): bigint {
  return -floorBigIntRatio(-numerator, denominator);
}

/**
 * Prove that every unexplained construction output is paired with the exact
 * catalog cost vector for that construction. `totalCrafted` is only a
 * monotonic cross-check; it is never itself a material source.
 *
 * `availableInputs` is item-specific and already subtracts aggregate owned
 * stock plus audited export/destroy/delivery. Recursive construction output in
 * `totalProduced` may therefore pay a later building step once, while WIP,
 * tray and quantum transfers contribute zero and unrelated item depletion can
 * never pay another recipe's cost.
 */
const CONSTRUCTION_RECIPE_RECEIPT_BRAND = Symbol("construction-recipe-receipt");

interface ConstructionRecipeReceipt {
  readonly [CONSTRUCTION_RECIPE_RECEIPT_BRAND]: true;
  outputs: Map<string, bigint>;
  crafted: bigint;
}

interface ConstructionPowerReceipt {
  /** Conservative allocated energy; actual work may stop earlier. */
  allocatedEnergyKwsByGrid: Map<string, number>;
  authorizedEnergyKwsByGrid: Map<string, number>;
  meteredCrafted: bigint;
  exactAuthorizedCrafted: bigint;
  failure?: string;
}

function validateConstructionPowerReceipt(
  receipt: ConstructionPowerReceipt,
  recipeReceipt: ConstructionRecipeReceipt,
): string | null {
  if (receipt.failure) return `施工电力守恒失败：${receipt.failure}`;
  if (receipt.meteredCrafted < 0n || receipt.exactAuthorizedCrafted < 0n ||
    receipt.meteredCrafted + receipt.exactAuthorizedCrafted !== recipeReceipt.crafted) {
    return `施工电力守恒失败：施工完成量 ${recipeReceipt.crafted.toString()} 与计量宏观/精确授权 ` +
      `${receipt.meteredCrafted.toString()}+${receipt.exactAuthorizedCrafted.toString()} 不一致`;
  }
  const keys = new Set([
    ...receipt.allocatedEnergyKwsByGrid.keys(),
    ...receipt.authorizedEnergyKwsByGrid.keys(),
  ]);
  for (const key of keys) {
    const used = receipt.allocatedEnergyKwsByGrid.get(key) ?? 0;
    const authorized = receipt.authorizedEnergyKwsByGrid.get(key) ?? 0;
    if (!Number.isFinite(used) || used < -EPSILON ||
      !Number.isFinite(authorized) || authorized < -EPSILON) {
      return `施工电力守恒失败：${key} 的能量收据不是有限非负数`;
    }
    const tolerance = Math.max(EPSILON, Math.abs(authorized) * 1e-12);
    if (used > authorized + tolerance) {
      return `施工电力守恒失败：${key} 使用 ${used} kW·s，证书仅授权 ${authorized} kW·s`;
    }
  }
  return null;
}

function validateConstructionRecipeConversion(
  transformations: ReadonlyMap<string, bigint>,
  availableInputs: ReadonlyMap<string, bigint>,
  producedDeltas: ReadonlyMap<string, bigint>,
  constructionCraftedDelta: bigint,
  receipt?: ConstructionRecipeReceipt,
  isolatedConstructionStage = false,
  fleetWipConsumed: ReadonlyMap<string, bigint> = new Map(),
): string | null {
  const definitions = new Map(CONSTRUCTION.map((definition) => [definition.buildingId, definition]));
  const requiredInputs = new Map<string, bigint>();
  let buildingOutputTotal = 0n;

  for (const [constructionId, outputDelta] of transformations) {
    if (outputDelta < 1n) continue;
    const definition = definitions.get(constructionId as Parameters<typeof definitions.get>[0]);
    if (!definition) {
      return `物资守恒失败：建筑制造配方投入无法证明未知建筑 ${constructionId} 的增量 ${outputDelta.toString()}`;
    }
    const outputAmount = constructionCatalogInteger(
      definition.outputAmount,
      `CONSTRUCTION.${constructionId}.outputAmount`,
    );
    if (typeof outputAmount === "string") return `物资守恒失败：建筑制造配方投入无效：${outputAmount}`;
    if (outputDelta % outputAmount !== 0n) {
      return `物资守恒失败：${constructionId} 增量 ${outputDelta.toString()} 不是配方产出 ${outputAmount.toString()} 的整数倍`;
    }
    const batches = outputDelta / outputAmount;
    buildingOutputTotal += outputDelta;
    for (const cost of definition.costs) {
      const failure = addConstructionRecipeCost(
        requiredInputs,
        cost.itemId,
        cost.amount,
        batches,
        `CONSTRUCTION.${constructionId}.costs.${cost.itemId}`,
      );
      if (failure) return `物资守恒失败：建筑制造配方投入无效：${failure}`;
    }
  }

  if (buildingOutputTotal > constructionCraftedDelta) {
    return `物资守恒失败：建筑制造配方产出 ${buildingOutputTotal.toString()} 超过建筑制造完成量 ${constructionCraftedDelta.toString()}`;
  }

  if (!isolatedConstructionStage) {
    if (buildingOutputTotal > 0n || constructionCraftedDelta > 0n) {
      if (!receipt || receipt[CONSTRUCTION_RECIPE_RECEIPT_BRAND] !== true) {
        return "物资守恒失败：建筑制造配方投入缺少隔离施工阶段收据，totalCrafted 不能自证";
      }
      if (receipt.crafted !== constructionCraftedDelta) {
        return `物资守恒失败：建筑制造完成量 ${constructionCraftedDelta.toString()} 与施工阶段收据 ${receipt.crafted.toString()} 不一致`;
      }
      for (const constructionId of new Set([...transformations.keys(), ...receipt.outputs.keys()])) {
        const observed = transformations.get(constructionId) ?? 0n;
        const receipted = receipt.outputs.get(constructionId) ?? 0n;
        if (observed !== receipted) {
          return `物资守恒失败：${constructionId} 建筑增量 ${observed.toString()} 与施工阶段收据 ${receipted.toString()} 不一致`;
        }
      }
    }
    // The branded receipt was issued only after the isolated construction
    // stage paid this exact catalog vector. Do not let unrelated ordinary
    // consumption in the larger settlement window pay it a second time.
    return null;
  }

  // Portable-fleet completion consumes the material step's output and returns
  // the same item into portableFleet, so it has no aggregate transformation.
  // Its completion counter must instead be backed by that item's production
  // delta and by one of the two exact catalog recipe cost vectors.
  const fleetCrafted = constructionCraftedDelta - buildingOutputTotal;
  const carriedFleetWip = PORTABLE_FLEET_ITEM_IDS.reduce(
    (total, itemId) => total + (fleetWipConsumed.get(itemId) ?? 0n),
    0n,
  );
  // A material step can finish in one bucket and its fleet-install step in a
  // later bucket. The already-owned job inventory paid its recipe previously;
  // only the residual completion count needs a same-window production/cost
  // proof. Using the actual WIP decrease prevents untouched stock from
  // certifying a forged totalCrafted increment.
  const newlyProducedFleetCrafted = fleetCrafted > carriedFleetWip
    ? fleetCrafted - carriedFleetWip
    : 0n;
  const fleetProofs = PORTABLE_FLEET_ITEM_IDS.map((itemId) => {
    const recipe = getRecipe(itemId);
    const output = recipe?.outputs.find((candidate) => candidate.itemId === itemId);
    const outputAmount = output ? constructionCatalogInteger(output.amount, `RECIPES.${itemId}.outputs.${itemId}`) : "缺少产出";
    return { itemId, recipe, outputAmount, capacity: producedDeltas.get(itemId) ?? 0n };
  });
  if (newlyProducedFleetCrafted > 0n) {
    if (fleetProofs.some(({ recipe, outputAmount }) => !recipe || typeof outputAmount === "string" || outputAmount !== 1n)) {
      return "物资守恒失败：建筑制造配方投入无法证明物流舰队完成量";
    }
    const [first, second] = fleetProofs;
    if (!first || !second || newlyProducedFleetCrafted > first.capacity + second.capacity) {
      return `物资守恒失败：建筑制造完成量中的新制舰队 ${newlyProducedFleetCrafted.toString()} 没有对应累计生产或既有 WIP`;
    }
    let lower = newlyProducedFleetCrafted > second.capacity
      ? newlyProducedFleetCrafted - second.capacity
      : 0n;
    let upper = newlyProducedFleetCrafted < first.capacity
      ? newlyProducedFleetCrafted
      : first.capacity;
    const costItems = new Set([
      ...first.recipe!.inputs.map((cost) => cost.itemId),
      ...second.recipe!.inputs.map((cost) => cost.itemId),
    ]);
    for (const itemId of costItems) {
      const firstCostRaw = first.recipe!.inputs.find((cost) => cost.itemId === itemId)?.amount ?? 0;
      const secondCostRaw = second.recipe!.inputs.find((cost) => cost.itemId === itemId)?.amount ?? 0;
      const firstCost = firstCostRaw === 0 ? 0n : constructionCatalogInteger(firstCostRaw, `RECIPES.${first.itemId}.inputs.${itemId}`);
      const secondCost = secondCostRaw === 0 ? 0n : constructionCatalogInteger(secondCostRaw, `RECIPES.${second.itemId}.inputs.${itemId}`);
      if (typeof firstCost === "string" || typeof secondCost === "string") {
        return `物资守恒失败：建筑制造配方投入无效：${typeof firstCost === "string" ? firstCost : secondCost}`;
      }
      const alreadyRequired = requiredInputs.get(itemId) ?? 0n;
      const available = (availableInputs.get(itemId) ?? 0n) - alreadyRequired;
      const difference = firstCost - secondCost;
      const right = available - secondCost * newlyProducedFleetCrafted;
      if (difference > 0n) upper = upper < floorBigIntRatio(right, difference) ? upper : floorBigIntRatio(right, difference);
      else if (difference < 0n) lower = lower > ceilBigIntRatio(-right, -difference) ? lower : ceilBigIntRatio(-right, -difference);
      else if (right < 0n) lower = upper + 1n;
    }
    if (lower > upper) {
      return `物资守恒失败：建筑制造配方投入不足以支持 ${newlyProducedFleetCrafted.toString()} 个同窗新制物流舰队单位`;
    }
    const firstCount = lower;
    const secondCount = newlyProducedFleetCrafted - firstCount;
    for (const [proof, count] of [[first, firstCount], [second, secondCount]] as const) {
      for (const cost of proof.recipe!.inputs) {
        const failure = addConstructionRecipeCost(
          requiredInputs,
          cost.itemId,
          cost.amount,
          count,
          `RECIPES.${proof.itemId}.inputs.${cost.itemId}`,
        );
        if (failure) return `物资守恒失败：建筑制造配方投入无效：${failure}`;
      }
    }
  }

  for (const [itemId, required] of requiredInputs) {
    const available = availableInputs.get(itemId) ?? 0n;
    if (available < required) {
      return `物资守恒失败：建筑制造配方投入 ${itemId} 需要 ${required.toString()}，可证明消耗仅 ${available.toString()}`;
    }
  }
  return null;
}

interface ConstructionRecipeStageSnapshot {
  scope: "construction" | "aggregate";
  owned: Map<string, bigint>;
  produced: Map<string, bigint>;
  destroyed: Map<string, bigint>;
  granted: Map<string, bigint>;
  fleetWip: Map<string, bigint>;
  portableFleet: Map<string, bigint>;
  outputs: Map<string, bigint>;
  crafted: bigint;
  failure?: string;
}

function captureConstructionRecipeStageSnapshot(
  state: GameState,
  scope: "construction" | "aggregate" = "construction",
): ConstructionRecipeStageSnapshot {
  const aggregateOwned = scope === "aggregate" ? captureAggregateItemStores(state) : undefined;
  const owned = aggregateOwned?.totals ?? new Map<string, bigint>();
  const produced = new Map<string, bigint>();
  const destroyed = new Map<string, bigint>();
  const fleetWip = new Map<string, bigint>();
  const portableFleet = new Map<string, bigint>();
  const outputs = new Map<string, bigint>();
  const seen = new Set<object>();
  const grants = captureKnownMaterialGrants(state);
  let failure: string | undefined = aggregateOwned?.failure ?? grants.failure;
  const addOwned = (store: ItemStore | undefined, label: string): void => {
    failure ??= addAggregateStore(owned, store, seen, label) ?? undefined;
  };
  if (scope === "construction") {
    addOwned(state.tray, "constructionStage.tray");
    for (const [planetId, tray] of Object.entries(state.planetTrays)) {
      if (planetId !== state.activePlanetId) addOwned(tray, `constructionStage.planetTrays.${planetId}`);
    }
    addOwned(state.construction as ItemStore, "constructionStage.construction");
    addOwned(state.portableFleet, "constructionStage.portableFleet");
    addOwned(state.quantumLogisticsNetwork.inventory, "constructionStage.quantumLogisticsNetwork.inventory");
  }
  for (const itemId of PORTABLE_FLEET_ITEM_IDS) {
    const amount = aggregateItemAmount(state.portableFleet[itemId]);
    if (amount === null) failure ??= `constructionStage.portableFleet.${itemId} 不是非负安全整数`;
    else portableFleet.set(itemId, amount);
  }
  for (const [jobId, job] of Object.entries(state.constructionAutomation.jobs)) {
    if (scope === "construction") addOwned(job.inventory, `constructionStage.jobs.${jobId}.inventory`);
    for (const itemId of PORTABLE_FLEET_ITEM_IDS) {
      const raw = job.inventory[itemId];
      if (raw === undefined) continue;
      const amount = aggregateItemAmount(raw);
      if (amount === null) failure ??= `constructionStage.jobs.${jobId}.inventory.${itemId} 不是非负安全整数`;
      else addAggregateAmount(fleetWip, itemId, amount);
    }
  }
  if (scope === "construction") {
    for (const [entityId, inventory] of Object.entries(state.constructionAutomation.quantumMaterialBuffer ?? {})) {
      addOwned(inventory, `constructionStage.quantumMaterialBuffer.${entityId}`);
    }
  }
  for (const [itemId, raw] of Object.entries(state.totalProduced)) {
    const amount = aggregateItemAmount(raw);
    if (amount === null) failure ??= `constructionStage.totalProduced.${itemId} 不是非负安全整数`;
    else produced.set(itemId, amount);
  }
  for (const [itemId, raw] of Object.entries(state.constructionAutomation.destroyedByproducts)) {
    const amount = aggregateItemAmount(raw);
    if (amount === null) failure ??= `constructionStage.destroyedByproducts.${itemId} 不是非负安全整数`;
    else destroyed.set(itemId, amount);
  }
  for (const definition of CONSTRUCTION) {
    const amount = aggregateItemAmount(state.construction[definition.buildingId]);
    if (amount === null) failure ??= `constructionStage.outputs.${definition.buildingId} 不是非负安全整数`;
    else outputs.set(definition.buildingId, amount);
  }
  const crafted = aggregateItemAmount(state.constructionAutomation.totalCrafted);
  if (crafted === null) failure ??= "constructionStage.totalCrafted 不是非负安全整数";
  return {
    scope,
    owned,
    produced,
    destroyed,
    granted: grants.totals,
    fleetWip,
    portableFleet,
    outputs,
    crafted: crafted ?? 0n,
    ...(failure ? { failure } : {}),
  };
}

function createConstructionRecipeReceipt(
  before: ConstructionRecipeStageSnapshot,
  after: GameState,
): ConstructionRecipeReceipt | string {
  if (before.failure) return `施工阶段基线无效：${before.failure}`;
  const capturedAfter = captureConstructionRecipeStageSnapshot(after, before.scope);
  if (capturedAfter.failure) return `施工阶段候选无效：${capturedAfter.failure}`;
  const crafted = capturedAfter.crafted - before.crafted;
  if (crafted < 0n) return "施工阶段建筑制造完成量发生回退";
  const outputs = new Map<string, bigint>();
  for (const constructionId of new Set([...before.outputs.keys(), ...capturedAfter.outputs.keys()])) {
    const rawDelta = (capturedAfter.outputs.get(constructionId) ?? 0n) - (before.outputs.get(constructionId) ?? 0n);
    const grantDelta = (capturedAfter.granted.get(constructionId) ?? 0n) - (before.granted.get(constructionId) ?? 0n);
    if (rawDelta < 0n) return `施工阶段 ${constructionId} 建筑库存发生回退`;
    if (grantDelta < 0n) return `施工阶段 ${constructionId} 建筑奖励账本发生回退`;
    const manufacturedDelta = rawDelta - grantDelta;
    if (manufacturedDelta < 0n) {
      return `施工阶段 ${constructionId} 建筑奖励增量 ${grantDelta.toString()} 超过库存增量 ${rawDelta.toString()}`;
    }
    if (manufacturedDelta > 0n) outputs.set(constructionId, manufacturedDelta);
  }
  const availableInputs = new Map<string, bigint>();
  const producedDeltas = new Map<string, bigint>();
  const fleetWipConsumed = new Map<string, bigint>();
  for (const itemId of PORTABLE_FLEET_ITEM_IDS) {
    const consumed = (before.fleetWip.get(itemId) ?? 0n) - (capturedAfter.fleetWip.get(itemId) ?? 0n);
    const portableIncrease = (capturedAfter.portableFleet.get(itemId) ?? 0n) -
      (before.portableFleet.get(itemId) ?? 0n);
    const receiptedTransfer = consumed < portableIncrease ? consumed : portableIncrease;
    if (receiptedTransfer > 0n) fleetWipConsumed.set(itemId, receiptedTransfer);
  }
  const itemIds = new Set([
    ...before.owned.keys(), ...capturedAfter.owned.keys(),
    ...before.produced.keys(), ...capturedAfter.produced.keys(),
    ...before.destroyed.keys(), ...capturedAfter.destroyed.keys(),
  ]);
  for (const itemId of itemIds) {
    const stockDelta = (capturedAfter.owned.get(itemId) ?? 0n) - (before.owned.get(itemId) ?? 0n);
    const producedDelta = (capturedAfter.produced.get(itemId) ?? 0n) - (before.produced.get(itemId) ?? 0n);
    const destroyedDelta = (capturedAfter.destroyed.get(itemId) ?? 0n) - (before.destroyed.get(itemId) ?? 0n);
    if (producedDelta < 0n) return `施工阶段 ${itemId} 累计生产发生回退`;
    if (destroyedDelta < 0n) return `施工阶段 ${itemId} 副产物销毁发生回退`;
    producedDeltas.set(itemId, producedDelta);
    const available = producedDelta - stockDelta - destroyedDelta;
    if (available > 0n) availableInputs.set(itemId, available);
  }
  const failure = validateConstructionRecipeConversion(
    outputs,
    availableInputs,
    producedDeltas,
    crafted,
    undefined,
    true,
    fleetWipConsumed,
  );
  if (failure) return failure;
  return {
    [CONSTRUCTION_RECIPE_RECEIPT_BRAND]: true,
    outputs,
    crafted,
  };
}

function mergeConstructionRecipeReceipt(target: ConstructionRecipeReceipt, source: ConstructionRecipeReceipt): void {
  for (const [constructionId, amount] of source.outputs) {
    target.outputs.set(constructionId, (target.outputs.get(constructionId) ?? 0n) + amount);
  }
  target.crafted += source.crafted;
}

export function validateAggregateConservation(
  before: AggregateConservationBaseline,
  after: GameState,
  constructionReceipt?: ConstructionRecipeReceipt,
): string | null {
  if (before.failure) return `物资守恒基线无效：${before.failure}`;
  const capturedAfter = captureAggregateItemStores(after);
  if (capturedAfter.failure) return `物资守恒候选无效：${capturedAfter.failure}`;
  const consumedAfter = captureKnownMaterialConsumption(after);
  if (consumedAfter.failure) return `物资守恒候选无效：${consumedAfter.failure}`;
  const grantedAfter = captureKnownMaterialGrants(after);
  if (grantedAfter.failure) return `物资守恒候选无效：${grantedAfter.failure}`;
  const constructionOutputsAfter = captureConstructionOutputStores(after);
  if (constructionOutputsAfter.failure) return `物资守恒候选无效：${constructionOutputsAfter.failure}`;
  const constructionCraftedAfter = aggregateItemAmount(after.constructionAutomation.totalCrafted);
  if (constructionCraftedAfter === null) return "物资守恒候选无效：constructionAutomation.totalCrafted 不是非负安全整数";
  const constructionCraftedDelta = constructionCraftedAfter - before.constructionCrafted;
  if (constructionCraftedDelta < 0n) return "物资守恒失败：建筑制造累计完成量发生回退";
  const constructionItemIds = new Set([
    ...before.constructionOutputs.keys(),
    ...constructionOutputsAfter.totals.keys(),
  ]);
  let constructionTransformationTotal = 0n;
  const constructionTransformations = new Map<string, bigint>();
  const availableConstructionInputs = new Map<string, bigint>();
  const producedDeltas = new Map<string, bigint>();
  const afterTotals = capturedAfter.totals;
  const itemIds = new Set([
    ...before.totals.keys(), ...afterTotals.keys(), ...before.totalProduced.keys(), ...Object.keys(after.totalProduced),
    ...before.knownConsumed.keys(), ...consumedAfter.totals.keys(),
    ...before.knownGranted.keys(), ...grantedAfter.totals.keys(),
  ]);
  for (const itemId of itemIds) {
    const stockDelta = (afterTotals.get(itemId) ?? 0n) - (before.totals.get(itemId) ?? 0n);
    const producedDelta = BigInt(Math.max(0, Math.floor(finiteNumber(after.totalProduced[itemId as ItemId])))) -
      (before.totalProduced.get(itemId) ?? 0n);
    const consumedDelta = (consumedAfter.totals.get(itemId) ?? 0n) - (before.knownConsumed.get(itemId) ?? 0n);
    const grantedDelta = (grantedAfter.totals.get(itemId) ?? 0n) - (before.knownGranted.get(itemId) ?? 0n);
    if (producedDelta < 0n) return `物资守恒失败：${itemId} 的累计生产发生回退`;
    if (consumedDelta < 0n) return `物资守恒失败：${itemId} 的累计出口/销毁/交付发生回退`;
    if (grantedDelta < 0n) return `物资守恒失败：${itemId} 的任务/科技奖励账本发生回退`;
    producedDeltas.set(itemId, producedDelta);
    const baseSources = producedDelta + grantedDelta;
    const accountedDelta = stockDelta + consumedDelta;
    if (baseSources > accountedDelta) availableConstructionInputs.set(itemId, baseSources - accountedDelta);
    // Construction output stores are also ordinary ownership locations. A
    // refund or WIP transfer can raise `construction`/`portableFleet` while an
    // equal amount leaves another owned store, so their raw local delta is not
    // a manufacturing event. Credit only the residual aggregate deficit after
    // production and audited grants have been applied, and bind that credit to
    // an item that is actually represented by the construction/fleet domain.
    const constructionTransformation = constructionItemIds.has(itemId) && accountedDelta > baseSources
      ? accountedDelta - baseSources
      : 0n;
    if (constructionTransformation > 0n) constructionTransformations.set(itemId, constructionTransformation);
    constructionTransformationTotal += constructionTransformation;
    if (constructionTransformationTotal > constructionCraftedDelta) {
      return `物资守恒失败：建筑/舰队物资转换 ${constructionTransformationTotal.toString()} 超过建筑制造完成量 ${constructionCraftedDelta.toString()}`;
    }
    const sourcedDelta = baseSources + constructionTransformation;
    if (stockDelta > sourcedDelta) {
      return `物资守恒失败：${itemId} 库存净增 ${stockDelta.toString()} 超过生产与奖励增量 ${sourcedDelta.toString()}`;
    }
    if (consumedDelta > sourcedDelta - stockDelta) {
      return `物资守恒失败：${itemId} 出口/销毁/交付 ${consumedDelta.toString()} 超过生产、奖励与库存来源 ${(sourcedDelta - stockDelta).toString()}`;
    }
  }
  return validateConstructionRecipeConversion(
    constructionTransformations,
    availableConstructionInputs,
    producedDeltas,
    constructionCraftedDelta,
    constructionReceipt,
  );
}

export interface ExactSimulationConservationDiagnostic {
  state: GameState;
  conservationFailure: string | null;
  /** Exact engine call only; excludes the two baseline/receipt scans. */
  exactAdvanceDurationMs: number;
}

/**
 * Run the ordinary exact simulation and validate its aggregate material flow
 * with an internally issued construction receipt. This is a diagnostic
 * comparator, not a settlement commit API: callers can provide only the
 * source and duration, never an arbitrary candidate or a forged receipt.
 *
 * Keeping the receipt inside this module is important. `totalCrafted` remains
 * a cross-check and cannot certify itself merely because unrelated inventory
 * happened to fall during the same simulation window.
 */
export function advanceExactSimulationForConservationDiagnostic(
  source: GameState,
  simulationSeconds: number,
  wallSeconds: number,
  profiler?: SimulationProfiler,
): ExactSimulationConservationDiagnostic {
  const aggregateBefore = captureAggregateConservationBaseline(source);
  const constructionBefore = captureConstructionRecipeStageSnapshot(source, "aggregate");
  const exactAdvanceStartedAt = globalThis.performance.now();
  const state = advanceSimulationBudget(source, simulationSeconds, wallSeconds, profiler);
  const exactAdvanceDurationMs = globalThis.performance.now() - exactAdvanceStartedAt;
  const receipt = createConstructionRecipeReceipt(constructionBefore, state);
  return {
    state,
    exactAdvanceDurationMs,
    conservationFailure: typeof receipt === "string"
      ? `精确施工阶段最终物资守恒失败：${receipt}`
      : validateAggregateConservation(aggregateBefore, state, receipt),
  };
}

interface PureIdleFlowSnapshot {
  stores: Map<string, bigint>;
  produced: Map<string, bigint>;
  grants: Map<string, bigint>;
  failure?: string;
}

interface PureIdleSteadyStateResult {
  contract: PureIdleAffineContract;
  researchLedger: ResearchMacroLedger;
}

const PURE_IDLE_FLOW_FACTOR_SCALE = 1_000_000n;
const PURE_IDLE_MATERIAL_POWER_BUILDINGS = new Set([
  "thermal_power_plant",
  "mini_fusion_power_plant",
  "artificial_star",
]);

function capturePureIdleFlowSnapshot(state: GameState): PureIdleFlowSnapshot {
  const stores = captureAggregateItemStores(state);
  const grants = captureKnownMaterialGrants(state);
  const produced = new Map<string, bigint>();
  let failure = stores.failure ?? grants.failure;
  for (const [itemId, raw] of Object.entries(state.totalProduced)) {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      failure ??= `totalProduced.${itemId} 不是非负安全整数`;
      continue;
    }
    produced.set(itemId, BigInt(raw));
  }
  return {
    stores: stores.totals,
    grants: grants.totals,
    produced,
    ...(failure ? { failure } : {}),
  };
}

function pureIdleFlowRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return numerator > 0n ? 1 : 0;
  if (numerator <= 0n) return 0;
  const scaled = numerator * PURE_IDLE_FLOW_FACTOR_SCALE / denominator;
  return Math.max(0, Math.min(1, Number(scaled) / Number(PURE_IDLE_FLOW_FACTOR_SCALE)));
}

function activePureIdleRecipeDependencies(states: readonly GameState[]): Map<string, Set<string>> {
  const dependencies = new Map<string, Set<string>>();
  const add = (outputItemId: string, inputItemId: string): void => {
    let inputs = dependencies.get(outputItemId);
    if (!inputs) dependencies.set(outputItemId, inputs = new Set());
    inputs.add(inputItemId);
  };
  for (const state of states) {
    for (const entity of state.entities) {
      if (entity.machineCount < 1 || entity.productionRate <= EPSILON) continue;
      const recipe = getRecipe(entity.recipeId);
      if (!recipe || recipe.outputs.length < 1) continue;
      const inputIds = recipe.inputs.map((input) => input.itemId);
      const proliferatorItemId = entity.sprayCoaterInstalled
        ? getEntityProliferatorItemId(entity)
        : undefined;
      for (const output of recipe.outputs) {
        for (const inputItemId of inputIds) add(output.itemId, inputItemId);
        // Spray is optional for exact simulation, but the measured boosted
        // rate is not. Treat its sampled supply as a hard dependency so the
        // steady-state certificate can only under-credit when spray runs out.
        if (proliferatorItemId) add(output.itemId, proliferatorItemId);
      }
    }
  }

  // Generator fuel is settled by the separate power-tail ledger below. Do not
  // also inject it as an input of every recipe: a finite debit is already
  // bounded and physically removed from the generator, while a sustainable
  // debit must prove that the conservative fuel-production rate covers the
  // measured burn. Charging the same fuel here as well squares its coverage
  // factor at every recalibration and can turn a healthy 38x fuel surplus into
  // an artificial production collapse.
  return dependencies;
}

function scalePureIdleResearchLedger(
  ledger: ResearchMacroLedger,
  factors: Readonly<Record<string, number>>,
  researchStates: readonly GameState[] = [],
): ResearchMacroLedger {
  const activeItems = Object.entries(ledger.inflowPerWindow)
    .filter(([, amount]) => (amount ?? 0n) > 0n)
    .map(([itemId]) => itemId);
  const requiredItems = new Set<string>(activeItems);
  for (const state of researchStates) {
    const pendingTechIds = [state.research.selectedTechId, ...state.research.queuedTechIds]
      .filter((techId): techId is NonNullable<typeof techId> => Boolean(techId));
    for (const techId of pendingTechIds) {
      for (const cost of getTechnology(techId)?.costs ?? []) requiredItems.add(cost.itemId);
    }
    if (state.endgame.activeInfiniteResearchId) requiredItems.add("universe_matrix");
  }
  // A research probe can consume a prefilled lab cache without observing any
  // sustainable upstream matrix flow. In that case inflowPerWindow is empty;
  // retaining the sampled investment ledger would replay the same finite
  // cache forever. Likewise, one missing matrix certificate invalidates the
  // whole synchronized research cycle. Keep the exact calibration prefix,
  // but freeze the unproven tail by scaling its ledger to zero.
  const hasObservedResearch = ledger.unitsPerWindow > 0n || ledger.observedUnits > 0n;
  const certifiedInputs = [...requiredItems];
  const hasCompleteCertificate = certifiedInputs.length > 0 &&
    certifiedInputs.every((itemId) => factors[itemId] !== undefined);
  const factor = hasObservedResearch && !hasCompleteCertificate
    ? 0
    : certifiedInputs.length > 0
      ? Math.min(...certifiedInputs.map((itemId) => factors[itemId] ?? 0))
      : 1;
  const scaled = BigInt(Math.max(0, Math.min(Number(PURE_IDLE_FLOW_FACTOR_SCALE),
    Math.floor(factor * Number(PURE_IDLE_FLOW_FACTOR_SCALE)))));
  if (scaled >= PURE_IDLE_FLOW_FACTOR_SCALE) return ledger;
  const scale = (value: bigint): bigint => value * scaled / PURE_IDLE_FLOW_FACTOR_SCALE;
  return {
    ...ledger,
    unitsPerWindow: scale(ledger.unitsPerWindow),
    observedUnits: scale(ledger.observedUnits),
    inflowPerWindow: Object.fromEntries(Object.entries(ledger.inflowPerWindow).map(([itemId, amount]) => [
      itemId,
      scale(amount ?? 0n),
    ])),
  };
}

/**
 * Replace cache-depletion extrapolation with a closed steady-flow certificate
 * wherever all three exact windows prove repeatable upstream supply.
 *
 * Items that cannot be proven retain the historical depletion-only contract
 * and finite horizon. Certified items retain only conservative monotonic
 * production counters; their sampled store transfers cancel inside the
 * closed domain and therefore are never copied into persistent inventory.
 */
function createPureIdleSteadyStateContract(
  source: GameState,
  calibrated: GameState,
  sampledContract: PureIdleAffineContract,
  flowSnapshots: readonly PureIdleFlowSnapshot[],
  researchLedger: ResearchMacroLedger,
): PureIdleSteadyStateResult {
  const bounded = freezePureIdleLightweightStoreReplenishment(sampledContract);
  const boundedByItem = calculatePureIdleLightweightBoundaries(calibrated, sampledContract);
  const boundedContract = boundedByItem ? { ...bounded, maximumSimulationSecondsByItem: boundedByItem } : bounded;
  if (flowSnapshots.length < 2 || flowSnapshots.some((snapshot) => snapshot.failure)) {
    return {
      contract: boundedContract,
      researchLedger: scalePureIdleResearchLedger(researchLedger, {}, [source, calibrated]),
    };
  }

  const itemIds = new Set<string>();
  for (const snapshot of flowSnapshots) {
    for (const itemId of snapshot.stores.keys()) itemIds.add(itemId);
    for (const itemId of snapshot.produced.keys()) itemIds.add(itemId);
    for (const itemId of snapshot.grants.keys()) itemIds.add(itemId);
  }
  const dependencies = activePureIdleRecipeDependencies([source, calibrated]);
  for (const [outputItemId, inputs] of dependencies) {
    itemIds.add(outputItemId);
    for (const inputItemId of inputs) itemIds.add(inputItemId);
  }

  const minimumProducedByWindow = new Map<string, bigint>();
  const totalProducedByCalibration = new Map<string, bigint>();
  const totalConsumedByCalibration = new Map<string, bigint>();
  const invalidItems = new Set<string>();
  for (const itemId of itemIds) {
    let minimumProduced: bigint | undefined;
    let totalProduced = 0n;
    let totalConsumed = 0n;
    for (let index = 1; index < flowSnapshots.length; index += 1) {
      const before = flowSnapshots[index - 1];
      const after = flowSnapshots[index];
      const produced = (after.produced.get(itemId) ?? 0n) - (before.produced.get(itemId) ?? 0n);
      const granted = (after.grants.get(itemId) ?? 0n) - (before.grants.get(itemId) ?? 0n);
      const stockDelta = (after.stores.get(itemId) ?? 0n) - (before.stores.get(itemId) ?? 0n);
      const consumed = produced + granted - stockDelta;
      if (produced < 0n || granted < 0n || consumed < 0n) {
        invalidItems.add(itemId);
        break;
      }
      minimumProduced = minimumProduced === undefined || produced < minimumProduced ? produced : minimumProduced;
      totalProduced += produced;
      totalConsumed += consumed;
    }
    minimumProducedByWindow.set(itemId, invalidItems.has(itemId) ? 0n : minimumProduced ?? 0n);
    totalProducedByCalibration.set(itemId, invalidItems.has(itemId) ? 0n : totalProduced);
    totalConsumedByCalibration.set(itemId, invalidItems.has(itemId) ? 0n : totalConsumed);
  }

  const factors = new Map<string, number>();
  for (const itemId of itemIds) factors.set(itemId, (minimumProducedByWindow.get(itemId) ?? 0n) > 0n ? 1 : 0);
  const coverage = (itemId: string): number => {
    // Store routing phases can move a large cache during one ten-second
    // checkpoint and reverse it in the next. Use the complete thirty-second
    // material identity for coverage, while the credited production rate
    // below still uses the slowest individual window.
    const produced = totalProducedByCalibration.get(itemId) ?? 0n;
    const consumed = totalConsumedByCalibration.get(itemId) ?? 0n;
    const factor = factors.get(itemId) ?? 0;
    return consumed > 0n
      ? Math.min(factor, pureIdleFlowRatio(produced, consumed) * factor)
      : produced > 0n ? factor : 0;
  };
  const passLimit = Math.max(1, Object.keys(ITEMS).length * 2);
  for (let pass = 0; pass < passLimit; pass += 1) {
    let changed = false;
    for (const [outputItemId, inputs] of dependencies) {
      let next = factors.get(outputItemId) ?? 0;
      for (const inputItemId of inputs) next = Math.min(next, coverage(inputItemId));
      const previous = factors.get(outputItemId) ?? 0;
      if (next + 1e-9 < previous) {
        factors.set(outputItemId, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const existingProducedDeltas = new Map<string, AffineDelta>();
  for (const delta of sampledContract.deltas) {
    if (delta.path[0] === "totalProduced" && typeof delta.path[1] === "string" &&
      delta.kind === "number" && Number(delta.delta) > EPSILON) {
      existingProducedDeltas.set(delta.path[1], delta);
    }
  }
  const windowCount = BigInt(flowSnapshots.length - 1);
  const certifiedFactors: Record<string, number> = {};
  const steadyProducedDeltas: AffineDelta[] = [];
  for (const itemId of [...itemIds].sort()) {
    const factor = Math.max(0, Math.min(1, factors.get(itemId) ?? 0));
    const producedPerWindow = minimumProducedByWindow.get(itemId) ?? 0n;
    const scaledFactor = BigInt(Math.floor(factor * Number(PURE_IDLE_FLOW_FACTOR_SCALE)));
    let certifiedDelta = producedPerWindow * windowCount * scaledFactor / PURE_IDLE_FLOW_FACTOR_SCALE;
    const existing = existingProducedDeltas.get(itemId);
    if (existing && existing.kind === "number") {
      certifiedDelta = certifiedDelta < BigInt(Math.max(0, Math.floor(Number(existing.delta))))
        ? certifiedDelta
        : BigInt(Math.max(0, Math.floor(Number(existing.delta))));
    }
    if (certifiedDelta <= 0n || certifiedDelta > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    certifiedFactors[itemId] = factor;
    if (!PURE_IDLE_LIGHTWEIGHT_FROZEN_ITEMS.has(itemId as ItemId)) {
      steadyProducedDeltas.push({
        path: ["totalProduced", itemId],
        kind: "number",
        delta: Number(certifiedDelta),
        integer: true,
      });
    }
  }
  const certifiedItems = new Set(Object.keys(certifiedFactors));
  if (certifiedItems.size < 1) {
    return {
      contract: boundedContract,
      researchLedger: scalePureIdleResearchLedger(researchLedger, {}, [source, calibrated]),
    };
  }

  const deltas = bounded.deltas.filter((delta) => {
    const itemId = pureIdleLightweightContractItemId(delta.path);
    if (!itemId || !certifiedItems.has(itemId)) return true;
    return false;
  });
  deltas.push(...steadyProducedDeltas);
  const remainingBoundaries = Object.fromEntries(Object.entries(boundedByItem ?? {})
    .filter(([itemId]) => !certifiedItems.has(itemId)));
  const contract: PureIdleAffineContract = {
    ...bounded,
    deltas,
    steadyStateFactorsByItem: certifiedFactors,
    ...(Object.keys(remainingBoundaries).length > 0
      ? { maximumSimulationSecondsByItem: remainingBoundaries }
      : {}),
  };
  return {
    contract,
    researchLedger: scalePureIdleResearchLedger(researchLedger, certifiedFactors, [source, calibrated]),
  };
}

const PURE_IDLE_TERMINAL_MATERIALS = ["small_carrier_rocket", "solar_sail"] as const;
export type PureIdleTerminalMaterialId = typeof PURE_IDLE_TERMINAL_MATERIALS[number];

interface PureIdleRocketCalibrationSnapshot {
  produced: number;
  launched: number;
  structurePoints: number;
  structurePointsBySystem: Record<string, number>;
}

function capturePureIdleRocketCalibrationSnapshot(state: GameState): PureIdleRocketCalibrationSnapshot {
  return {
    produced: Math.max(0, Math.floor(finiteNumber(state.totalProduced.small_carrier_rocket))),
    launched: Math.max(0, Math.floor(finiteNumber(state.dysonSphere.totalRocketsLaunched))),
    structurePoints: Math.max(0, Math.floor(finiteNumber(state.dysonSphere.structurePoints))),
    structurePointsBySystem: Object.fromEntries(Object.entries(state.dysonPlans).map(([systemId, plan]) => [
      systemId,
      Math.max(0, Math.floor(finiteNumber(plan.structurePoints))),
    ])),
  };
}

function stableNonNegativeWindowDelta(values: readonly number[]): number | null {
  if (values.length < 2 || values.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
  const deltas = values.slice(1).map((value, index) => value - values[index]);
  if (deltas.some((delta) => !Number.isSafeInteger(delta) || delta < 0)) return null;
  const tail = deltas.at(-1) ?? 0;
  const stableIntegerRate = (left: number, right: number) => Math.abs(left - right) <= 1 || stableRate(left, right);
  if (deltas.length >= 2 && !stableIntegerRate(deltas.at(-2) ?? tail, tail)) return null;
  const selected = deltas.length >= 2 && !stableIntegerRate(deltas[0] ?? tail, tail)
    ? tail * deltas.length
    : values.at(-1)! - values[0];
  return Number.isSafeInteger(selected) && selected >= 0 ? selected : null;
}

interface PureIdleRocketMacroLedgerCalibration {
  ledger?: PureIdleRocketMacroLedger;
  rejectionReason?: string;
}

function createPureIdleRocketMacroLedger(
  snapshots: readonly PureIdleRocketCalibrationSnapshot[],
  calibrationSeconds: number,
): PureIdleRocketMacroLedgerCalibration {
  const produced = stableNonNegativeWindowDelta(snapshots.map((snapshot) => snapshot.produced));
  const launched = stableNonNegativeWindowDelta(snapshots.map((snapshot) => snapshot.launched));
  const structure = stableNonNegativeWindowDelta(snapshots.map((snapshot) => snapshot.structurePoints));
  if (produced === null) return { rejectionReason: "火箭制造没有形成稳定的 3 × 10 秒窗口" };
  if (launched === null) return { rejectionReason: "火箭发射没有形成稳定的 3 × 10 秒窗口" };
  if (structure === null) return { rejectionReason: "戴森结构没有形成稳定的 3 × 10 秒窗口" };
  if (launched < 1) return { rejectionReason: "校准窗口内没有实际火箭发射" };
  if (structure !== launched) return { rejectionReason: "结构点增量与火箭发射账本不一致" };
  if (produced < launched) return { rejectionReason: "校准期火箭制造不足以覆盖发射，不能外推预填库存" };
  const systemIds = new Set(snapshots.flatMap((snapshot) => Object.keys(snapshot.structurePointsBySystem)));
  const launchesBySystemPerWindow: Record<string, number> = {};
  let planned = 0;
  for (const systemId of [...systemIds].sort()) {
    const delta = stableNonNegativeWindowDelta(snapshots.map((snapshot) =>
      snapshot.structurePointsBySystem[systemId] ?? 0));
    if (delta === null) return { rejectionReason: `恒星系 ${systemId} 的火箭分配没有形成稳定窗口` };
    if (delta > 0) launchesBySystemPerWindow[systemId] = delta;
    planned += delta;
    if (!Number.isSafeInteger(planned)) return { rejectionReason: "多恒星系火箭分配超过安全整数" };
  }
  const activeSystems = Object.values(launchesBySystemPerWindow).filter((amount) => amount > 0).length;
  if (planned !== launched) return { rejectionReason: "各恒星系结构增量无法闭合到全局火箭发射账本" };
  if (activeSystems < 1) return { rejectionReason: "火箭发射没有合法的目标恒星系" };
  return {
    ledger: {
      calibrationSeconds,
      producedPerWindow: produced,
      launchedPerWindow: launched,
      launchesBySystemPerWindow,
    },
  };
}

function scalePureIdleRocketCalibrationForSteadyState(
  calibration: PureIdleRocketMacroLedgerCalibration,
  contract: PureIdleAffineContract,
): PureIdleRocketMacroLedgerCalibration {
  const ledger = calibration.ledger;
  const factor = contract.steadyStateFactorsByItem?.small_carrier_rocket;
  if (!ledger || factor === undefined || factor <= 0) return calibration;
  if (factor >= 1 - 1e-9) return calibration;
  const scaledFactor = BigInt(Math.max(0, Math.min(Number(PURE_IDLE_FLOW_FACTOR_SCALE),
    Math.floor(factor * Number(PURE_IDLE_FLOW_FACTOR_SCALE)))));
  const launchesBySystemPerWindow: Record<string, number> = {};
  let launchedPerWindow = 0;
  for (const [systemId, amount] of Object.entries(ledger.launchesBySystemPerWindow).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0)) {
    const scaled = Number(BigInt(amount) * scaledFactor / PURE_IDLE_FLOW_FACTOR_SCALE);
    if (scaled > 0) launchesBySystemPerWindow[systemId] = scaled;
    launchedPerWindow += scaled;
  }
  const producedPerWindow = Number(BigInt(ledger.producedPerWindow) * scaledFactor / PURE_IDLE_FLOW_FACTOR_SCALE);
  if (launchedPerWindow < 1 || producedPerWindow < launchedPerWindow) {
    return { rejectionReason: "火箭稳态供给因子低于一个可验证发射事件，尾段已冻结" };
  }
  return {
    ledger: {
      ...ledger,
      producedPerWindow,
      launchedPerWindow,
      launchesBySystemPerWindow,
    },
  };
}

/**
 * Scale a closed per-system rocket ledger without depending on bucket shape.
 * Every destination carries its own fractional remainder, so one long call
 * and any ordered segmentation of the same duration produce the same integer
 * launch vector. The plan is pure and can be inspected before mutation.
 */
export function planPureIdleRocketMacroLedger(
  ledger: PureIdleRocketMacroLedger,
  simulationSeconds: number,
  previousRemainders: Readonly<Record<string, number>> = {},
): PureIdleRocketMacroPlan {
  if (!Number.isFinite(simulationSeconds) || simulationSeconds < 0 ||
    !Number.isFinite(ledger.calibrationSeconds) || ledger.calibrationSeconds <= 0 ||
    !Number.isSafeInteger(ledger.producedPerWindow) || !Number.isSafeInteger(ledger.launchedPerWindow) ||
    ledger.producedPerWindow < ledger.launchedPerWindow || ledger.launchedPerWindow < 1) {
    return { launched: 0, launchesBySystem: {}, remaindersBySystem: {}, failure: "火箭事件账本参数无效" };
  }
  const entries = Object.entries(ledger.launchesBySystemPerWindow)
    .filter(([, amount]) => amount > 0)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (entries.length < 1) {
    return { launched: 0, launchesBySystem: {}, remaindersBySystem: {}, failure: "火箭事件账本缺少目标恒星系" };
  }
  let plannedPerWindow = 0;
  let launched = 0;
  const launchesBySystem: Record<string, number> = {};
  const remaindersBySystem: Record<string, number> = {};
  for (const [systemId, amount] of entries) {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      return { launched: 0, launchesBySystem: {}, remaindersBySystem: {}, failure: "恒星系火箭权重不是正安全整数" };
    }
    plannedPerWindow += amount;
    if (!Number.isSafeInteger(plannedPerWindow)) {
      return { launched: 0, launchesBySystem: {}, remaindersBySystem: {}, failure: "多恒星系火箭权重超过安全整数" };
    }
    const carry = previousRemainders[systemId] ?? 0;
    if (!Number.isFinite(carry) || carry < 0 || carry >= 1) {
      return { launched: 0, launchesBySystem: {}, remaindersBySystem: {}, failure: "恒星系火箭小数余量无效" };
    }
    const raw = amount * simulationSeconds / ledger.calibrationSeconds + carry;
    const integer = Math.max(0, Math.floor(raw + 1e-9));
    const remainder = raw - integer;
    if (!Number.isSafeInteger(integer) || !Number.isFinite(remainder) || remainder < -1e-9 || remainder >= 1) {
      return { launched: 0, launchesBySystem: {}, remaindersBySystem: {}, failure: "火箭事件账本缩放超过安全整数" };
    }
    if (integer > 0) launchesBySystem[systemId] = integer;
    if (remainder > 1e-12) remaindersBySystem[systemId] = Math.max(0, remainder);
    launched += integer;
    if (!Number.isSafeInteger(launched)) {
      return { launched: 0, launchesBySystem: {}, remaindersBySystem: {}, failure: "火箭发射总量超过安全整数" };
    }
  }
  if (plannedPerWindow !== ledger.launchedPerWindow) {
    return { launched: 0, launchesBySystem: {}, remaindersBySystem: {}, failure: "多恒星系火箭权重与全局账本不闭合" };
  }
  return { launched, launchesBySystem, remaindersBySystem };
}

/** Commit an already funded closed rocket event domain atomically. */
export function advancePureIdleRocketMacroLedgerInPlace(
  state: GameState,
  ledger: PureIdleRocketMacroLedger,
  simulationSeconds: number,
  previousRemainders: Readonly<Record<string, number>> = {},
): PureIdleRocketMacroPlan {
  const plan = planPureIdleRocketMacroLedger(ledger, simulationSeconds, previousRemainders);
  if (plan.failure || plan.launched < 1) return plan;
  const producedBefore = Math.max(0, Math.floor(state.totalProduced.small_carrier_rocket ?? 0));
  if (!Number.isSafeInteger(producedBefore + plan.launched)) {
    return { ...plan, failure: "火箭累计生产接近安全整数上限，终端尾段已冻结" };
  }
  const committed = advanceDysonRocketMacroInPlace(state, plan.launchesBySystem);
  if (committed !== plan.launched) return { ...plan, failure: "戴森火箭事件边界拒绝提交" };
  // The compact ordinary contract excludes rocket manufacture and inventory.
  // Credit exactly the amount immediately consumed by these launches; sampled
  // surplus and its unknown stock location remain conservatively frozen.
  state.totalProduced.small_carrier_rocket = producedBefore + plan.launched;
  return plan;
}

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

export interface PureIdleTerminalMaterialBaseline {
  stocks: Map<string, bigint>;
  totalProduced: Map<PureIdleTerminalMaterialId, bigint>;
  knownConsumed: Map<PureIdleTerminalMaterialId, bigint>;
  rocketsLaunched: bigint;
  structurePoints: bigint;
  sailsLaunched: bigint;
  sailsExpired: bigint;
  sailsAbsorbed: bigint;
  shellSails: bigint;
  sailsInOrbit: bigint;
  planStructurePoints: bigint;
  planShellSails: bigint;
  orbitSailsInOrbit: bigint;
  orbitTotalLaunched: bigint;
  orbitTotalExpired: bigint;
  failure?: string;
}

export function capturePureIdleTerminalMaterialBaseline(
  state: GameState,
): PureIdleTerminalMaterialBaseline {
  const empty = (): PureIdleTerminalMaterialBaseline => ({
    stocks: new Map(),
    totalProduced: new Map(),
    knownConsumed: new Map(),
    rocketsLaunched: 0n,
    structurePoints: 0n,
    sailsLaunched: 0n,
    sailsExpired: 0n,
    sailsAbsorbed: 0n,
    shellSails: 0n,
    sailsInOrbit: 0n,
    planStructurePoints: 0n,
    planShellSails: 0n,
    orbitSailsInOrbit: 0n,
    orbitTotalLaunched: 0n,
    orbitTotalExpired: 0n,
  });
  try {
    const stocks = captureAggregateItemStores(state);
    if (stocks.failure) return { ...empty(), failure: stocks.failure };
    return {
      stocks: stocks.totals,
      totalProduced: new Map(PURE_IDLE_TERMINAL_MATERIALS.map((itemId) => [
        itemId,
        ledgerCounter(state.totalProduced[itemId] ?? 0, `totalProduced.${itemId}`),
      ])),
      knownConsumed: new Map(PURE_IDLE_TERMINAL_MATERIALS.map((itemId) => [
        itemId,
        knownTerminalConsumption(state, itemId),
      ])),
      rocketsLaunched: ledgerCounter(state.dysonSphere.totalRocketsLaunched, "dysonSphere.totalRocketsLaunched"),
      structurePoints: ledgerCounter(state.dysonSphere.structurePoints, "dysonSphere.structurePoints"),
      sailsLaunched: ledgerCounter(state.dysonSwarm.totalLaunched, "dysonSwarm.totalLaunched"),
      sailsExpired: ledgerCounter(state.dysonSwarm.totalExpired, "dysonSwarm.totalExpired"),
      sailsAbsorbed: ledgerCounter(state.dysonSphere.totalSailsAbsorbed, "dysonSphere.totalSailsAbsorbed"),
      shellSails: ledgerCounter(state.dysonSphere.shellSails, "dysonSphere.shellSails"),
      sailsInOrbit: ledgerCounter(state.dysonSwarm.sailsInOrbit, "dysonSwarm.sailsInOrbit"),
      planStructurePoints: sumDysonPlans(state, "structurePoints"),
      planShellSails: sumDysonPlans(state, "shellSails"),
      orbitSailsInOrbit: sumDysonOrbits(state, "sailsInOrbit"),
      orbitTotalLaunched: sumDysonOrbits(state, "totalLaunched"),
      orbitTotalExpired: sumDysonOrbits(state, "totalExpired"),
    };
  } catch (error) {
    return {
      ...empty(),
      failure: error instanceof Error ? error.message : "计数器无法读取",
    };
  }
}

/**
 * Closed material ledger for leaderboard-facing pure-idle terminal results.
 * A failure means the whole affine candidate must be discarded; callers may
 * replay exactly or freeze from their last acknowledged checkpoint.
 */
export function validatePureIdleTerminalMaterialConservationFromBaseline(
  before: PureIdleTerminalMaterialBaseline,
  after: GameState,
): string | null {
  try {
    if (before.failure) return `终端物资守恒基线无效：${before.failure}`;
    const afterSnapshot = capturePureIdleTerminalMaterialBaseline(after);
    if (afterSnapshot.failure) return `终端物资守恒候选无效：${afterSnapshot.failure}`;

    const rocketLaunchDelta = afterSnapshot.rocketsLaunched - before.rocketsLaunched;
    const structureDelta = afterSnapshot.structurePoints - before.structurePoints;
    const sailLaunchDelta = afterSnapshot.sailsLaunched - before.sailsLaunched;
    const sailExpiredDelta = afterSnapshot.sailsExpired - before.sailsExpired;
    const sailAbsorbedDelta = afterSnapshot.sailsAbsorbed - before.sailsAbsorbed;
    const shellDelta = afterSnapshot.shellSails - before.shellSails;
    const orbitStockDelta = afterSnapshot.sailsInOrbit - before.sailsInOrbit;

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

    const planStructureDelta = afterSnapshot.planStructurePoints - before.planStructurePoints;
    const planShellDelta = afterSnapshot.planShellSails - before.planShellSails;
    if (planStructureDelta !== structureDelta) {
      return `终端物资守恒失败：各恒星系结构增量 ${planStructureDelta} 与全局增量 ${structureDelta} 不一致`;
    }
    if (planShellDelta !== shellDelta) {
      return `终端物资守恒失败：各恒星系壳面增量 ${planShellDelta} 与全局增量 ${shellDelta} 不一致`;
    }
    for (const [field, beforeSystem, afterSystem, beforeGlobal, afterGlobal] of [
      ["sailsInOrbit", before.orbitSailsInOrbit, afterSnapshot.orbitSailsInOrbit, before.sailsInOrbit, afterSnapshot.sailsInOrbit],
      ["totalLaunched", before.orbitTotalLaunched, afterSnapshot.orbitTotalLaunched, before.sailsLaunched, afterSnapshot.sailsLaunched],
      ["totalExpired", before.orbitTotalExpired, afterSnapshot.orbitTotalExpired, before.sailsExpired, afterSnapshot.sailsExpired],
    ] as const) {
      const systemDelta = afterSystem - beforeSystem;
      const globalDelta = afterGlobal - beforeGlobal;
      if (systemDelta !== globalDelta) {
        return `终端物资守恒失败：各恒星系太阳帆 ${field} 增量 ${systemDelta} 与全局增量 ${globalDelta} 不一致`;
      }
    }

    const launchedByItem: Record<PureIdleTerminalMaterialId, bigint> = {
      small_carrier_rocket: rocketLaunchDelta,
      solar_sail: sailLaunchDelta,
    };
    for (const itemId of PURE_IDLE_TERMINAL_MATERIALS) {
      const producedDelta = (afterSnapshot.totalProduced.get(itemId) ?? 0n) -
        (before.totalProduced.get(itemId) ?? 0n);
      const consumedDelta = (afterSnapshot.knownConsumed.get(itemId) ?? 0n) -
        (before.knownConsumed.get(itemId) ?? 0n);
      if (producedDelta < 0n || consumedDelta < 0n) {
        return `终端物资守恒失败：${itemId} 的累计生产或已知消耗发生回退`;
      }
      const available = producedDelta + (before.stocks.get(itemId) ?? 0n) -
        (afterSnapshot.stocks.get(itemId) ?? 0n);
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

export function validatePureIdleTerminalMaterialConservation(before: GameState, after: GameState): string | null {
  return validatePureIdleTerminalMaterialConservationFromBaseline(
    capturePureIdleTerminalMaterialBaseline(before),
    after,
  );
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
export interface PureIdleFiniteResourceBaselineEntry {
  id: string;
  itemId: ItemId;
  remaining: number;
  depletionRemainder: number;
}

export interface PureIdleResourceAccountingBaseline {
  finiteVeins: PureIdleFiniteResourceBaselineEntry[];
  totalProducedByItem: Map<ItemId, number>;
  consumptionTenthsByItem: Map<ItemId, number>;
  alternativeProducerItems: Set<ItemId>;
}

export function capturePureIdleResourceAccountingBaseline(
  state: GameState,
): PureIdleResourceAccountingBaseline {
  const finiteVeins: PureIdleFiniteResourceBaselineEntry[] = [];
  const finiteItemIds = new Set<ItemId>();
  for (const entity of state.entities) {
    if (entity.kind !== "vein" || !entity.resourceId) continue;
    const reserve = getResourceReserveSnapshot(state, entity);
    if (!reserve || reserve.infinite) continue;
    finiteItemIds.add(entity.resourceId);
    finiteVeins.push({
      id: entity.id,
      itemId: entity.resourceId,
      remaining: Math.max(0, Math.floor(entity.resourceRemaining ?? 0)),
      depletionRemainder: Math.max(0, Math.min(9, Math.floor(entity.resourceDepletionRemainder ?? 0))),
    });
  }
  return {
    finiteVeins,
    totalProducedByItem: new Map([...finiteItemIds].map((itemId) => [
      itemId,
      Math.max(0, Math.floor(state.totalProduced[itemId] ?? 0)),
    ])),
    consumptionTenthsByItem: new Map([...finiteItemIds].map((itemId) => [
      itemId,
      veinConsumptionTenths(state, itemId),
    ])),
    alternativeProducerItems: new Set([...finiteItemIds].filter((itemId) =>
      hasAlternativeResourceProducer(state, itemId))),
  };
}

export function validatePureIdleResourceAccountingFromBaseline(
  before: PureIdleResourceAccountingBaseline,
  after: GameState,
): string | null {
  const depletedTenthsByItem = new Map<ItemId, number>();
  const finiteItemIds = new Set(before.finiteVeins.map((entry) => entry.itemId));
  const afterEntities = new Map(after.entities.map((entity) => [entity.id, entity]));
  for (const beforeEntity of before.finiteVeins) {
    const afterEntity = afterEntities.get(beforeEntity.id);
    if (!afterEntity || afterEntity.kind !== "vein" || afterEntity.resourceId !== beforeEntity.itemId) {
      return `矿脉实体 ${beforeEntity.id} 在纯挂机结算中丢失`;
    }
    const afterRemaining = Math.max(0, Math.floor(afterEntity.resourceRemaining ?? 0));
    const afterRemainder = Math.max(0, Math.min(9, Math.floor(afterEntity.resourceDepletionRemainder ?? 0)));
    const depletionTenths = beforeEntity.remaining * 10 - beforeEntity.depletionRemainder -
      (afterRemaining * 10 - afterRemainder);
    if (depletionTenths < 0) return `矿脉 ${beforeEntity.id} 储量出现回退`;
    if (depletionTenths > 0) {
      depletedTenthsByItem.set(beforeEntity.itemId, (depletedTenthsByItem.get(beforeEntity.itemId) ?? 0) + depletionTenths);
    }
  }

  for (const itemId of finiteItemIds) {
    const depletedTenths = depletedTenthsByItem.get(itemId) ?? 0;
    const beforeProduced = before.totalProducedByItem.get(itemId) ?? 0;
    const afterProduced = Math.max(0, Math.floor(after.totalProduced[itemId] ?? 0));
    const producedDelta = afterProduced - beforeProduced;
    if (producedDelta < 0) return `累计产量 ${itemId} 在纯挂机结算中回退`;
    const beforeConsumptionTenths = before.consumptionTenthsByItem.get(itemId) ?? 10;
    const consumptionTenths = veinConsumptionTenths(after, itemId);
    // The exact consumption multiplier is represented in the reserve
    // remainder; derive the allowed bound from the observed finite reserve
    // rather than assuming the default 1:1 rule.  A finite resource mode with
    // zero effective depletion is treated as unlimited by the engine.
    const effectiveConsumptionTenths = Math.max(1, beforeConsumptionTenths, consumptionTenths);
    if (beforeConsumptionTenths === consumptionTenths &&
      !before.alternativeProducerItems.has(itemId) && !hasAlternativeResourceProducer(after, itemId) &&
      depletedTenths !== producedDelta * effectiveConsumptionTenths) {
      return `矿脉 ${itemId} 减少 ${depletedTenths} 个十分之一，但可归属累计产量为 ${producedDelta}`;
    }
    if (depletedTenths > producedDelta * effectiveConsumptionTenths) {
      return `矿脉 ${itemId} 减少 ${depletedTenths} 个十分之一，但累计产量仅增加 ${producedDelta}`;
    }
  }
  return null;
}

export function validatePureIdleResourceAccounting(before: GameState, after: GameState): string | null {
  return validatePureIdleResourceAccountingFromBaseline(
    capturePureIdleResourceAccountingBaseline(before),
    after,
  );
}

/**
 * Opaque handle for the compact final settlement gate. The module-private
 * authority deliberately retains only aggregate ledgers, finite vein counters,
 * terminal counters and construction receipts, so a large Worker does not
 * need a second full GameState clone and callers cannot mutate proof material.
 */
const PURE_IDLE_COMBINED_CHECKPOINT_BRAND = Symbol("pure-idle-combined-checkpoint");

export interface PureIdleCombinedConservationCheckpoint {
  readonly [PURE_IDLE_COMBINED_CHECKPOINT_BRAND]: true;
}

interface PureIdleCombinedConservationCheckpointState {
  aggregate: AggregateConservationBaseline;
  resources: PureIdleResourceAccountingBaseline;
  terminals: PureIdleTerminalMaterialBaseline;
}

interface PureIdleCombinedConservationCheckpointAuthority extends PureIdleCombinedConservationCheckpointState {
  constructionRecipeReceipt: ConstructionRecipeReceipt;
  constructionPowerReceipt: ConstructionPowerReceipt;
  /**
   * Non-persisted replay budget. The initial session receives one thirty-
   * second window; only an actually consumed isolated recalibration may add
   * another one. Reissuing a certificate alone never resets this budget.
   */
  constructionQuantumReplayRemainingSeconds: number;
}

const PURE_IDLE_COMBINED_CHECKPOINTS = new WeakMap<
  PureIdleCombinedConservationCheckpoint,
  PureIdleCombinedConservationCheckpointAuthority
>();

function requirePureIdleCombinedCheckpoint(
  checkpoint: PureIdleCombinedConservationCheckpoint,
): PureIdleCombinedConservationCheckpointAuthority {
  const authority = PURE_IDLE_COMBINED_CHECKPOINTS.get(checkpoint);
  if (!authority) throw new Error("纯挂机组合物资守恒检查点不是当前模块签发的不透明令牌");
  return authority;
}

export function capturePureIdleCombinedConservationCheckpoint(
  state: GameState,
): PureIdleCombinedConservationCheckpoint {
  const checkpoint = Object.freeze({
    [PURE_IDLE_COMBINED_CHECKPOINT_BRAND]: true as const,
  });
  PURE_IDLE_COMBINED_CHECKPOINTS.set(checkpoint, {
    aggregate: captureAggregateConservationBaseline(state),
    resources: capturePureIdleResourceAccountingBaseline(state),
    terminals: capturePureIdleTerminalMaterialBaseline(state),
    constructionRecipeReceipt: {
      [CONSTRUCTION_RECIPE_RECEIPT_BRAND]: true,
      outputs: new Map(),
      crafted: 0n,
    },
    constructionPowerReceipt: {
      allocatedEnergyKwsByGrid: new Map(),
      authorizedEnergyKwsByGrid: new Map(),
      meteredCrafted: 0n,
      exactAuthorizedCrafted: 0n,
    },
    constructionQuantumReplayRemainingSeconds: PURE_IDLE_CONSTRUCTION_QUANTUM_REPLAY_SECONDS,
  });
  return checkpoint;
}

/** Credit an isolated construction interval that an exact calibration
 * deliberately skipped. The opaque checkpoint keeps this cumulative across
 * segmented pure-idle calls without adding a GameState field. */
export function creditPureIdleConstructionQuantumReplay(
  checkpoint: PureIdleCombinedConservationCheckpoint,
  simulationSeconds: number,
): void {
  const authority = requirePureIdleCombinedCheckpoint(checkpoint);
  if (!Number.isFinite(simulationSeconds) || simulationSeconds <= EPSILON) return;
  authority.constructionQuantumReplayRemainingSeconds = Math.min(
    Number.MAX_SAFE_INTEGER,
    authority.constructionQuantumReplayRemainingSeconds + simulationSeconds,
  );
}

interface ConstructionPowerAllocation {
  powerFactorByCenterId: Map<string, number>;
  allocatedEnergyKwsByGrid: Map<string, number>;
  authorizedEnergyKwsByGrid: Map<string, number>;
  quantumDownloadPerBoundary?: number;
  quantumTimelineStartSeconds?: number;
}

function createConstructionPowerAllocation(
  state: GameState,
  simulationSeconds: number,
  certificate: PureIdleConstructionPowerCertificate | undefined,
  contract: PureIdleAffineContract | undefined,
): ConstructionPowerAllocation {
  const centers = state.entities.filter((entity) => entity.buildingId === "construction_center");
  const powerFactorByCenterId = new Map(centers.map((center) => [center.id, 0]));
  const allocatedEnergyKwsByGrid = new Map<string, number>();
  const authorizedEnergyKwsByGrid = new Map<string, number>();
  const certificateAuthority = certificate
    ? PURE_IDLE_CONSTRUCTION_POWER_CERTIFICATES.get(certificate)
    : undefined;
  if (!certificateAuthority || !contract || certificateAuthority.contract !== contract ||
    certificateAuthority.difficulty !== state.settings.difficulty ||
    (certificateAuthority.controllerEntityId ?? null) !== (state.timeWarp.controllerEntityId ?? null) ||
    certificateAuthority.requestedMultiplier !== state.timeWarp.requestedMultiplier ||
    certificateAuthority.researchFingerprint !== constructionPowerResearchFingerprint(state) ||
    !certificateAuthority.entityArrays.has(state.entities) ||
    !certificateAuthority.beltArrays.has(state.belts) ||
    !Number.isFinite(simulationSeconds) || simulationSeconds <= EPSILON) {
    return { powerFactorByCenterId, allocatedEnergyKwsByGrid, authorizedEnergyKwsByGrid };
  }

  const centersByGrid = new Map<string, FactoryEntity[]>();
  for (const center of centers) {
    const key = constructionPowerGridKey(center.planetId, center.powerGridId ?? "grid-a");
    const entries = centersByGrid.get(key) ?? [];
    entries.push(center);
    centersByGrid.set(key, entries);
  }
  const difficultyPowerMultiplier = getDifficultyDefinition(state.settings.difficulty).powerDemandMultiplier;
  for (const [key, gridCenters] of centersByGrid) {
    const grant = certificateAuthority.grids.get(key);
    if (!grant || grant.centerDemandKwById.size !== gridCenters.length) continue;
    let configurationMatches = true;
    const demandById = new Map<string, number>();
    for (const center of gridCenters) {
      const demandKw = Math.max(0, getBuilding("construction_center").powerDemandKw ?? 0) *
        Math.max(0, center.machineCount) * difficultyPowerMultiplier;
      demandById.set(center.id, demandKw);
      if (!Number.isFinite(demandKw) || grant.centerDemandKwById.get(center.id) !== demandKw ||
        grant.centerPriorityById.get(center.id) !== (center.powerPriority ?? 2)) {
        configurationMatches = false;
      }
    }
    if (!configurationMatches) continue;

    let remainingKw = Math.max(0, grant.minimumRenewableHeadroomKw);
    let usedKw = 0;
    for (const priority of [3, 2, 1] as const) {
      const group = gridCenters.filter((center) => (center.powerPriority ?? 2) === priority);
      const demandKw = group.reduce((sum, center) => sum + (demandById.get(center.id) ?? 0), 0);
      const availableFactor = demandKw <= EPSILON ? 1 : Math.min(1, remainingKw / demandKw);
      let suppliedKw = 0;
      for (const center of group) {
        const factor = Math.min(
          availableFactor,
          Math.max(0, grant.minimumPowerFactorByCenterId.get(center.id) ?? 0),
        );
        powerFactorByCenterId.set(center.id, factor);
        suppliedKw += (demandById.get(center.id) ?? 0) * factor;
      }
      usedKw += suppliedKw;
      remainingKw = Math.max(0, remainingKw - suppliedKw);
    }
    const usedEnergyKws = usedKw * simulationSeconds;
    const authorizedEnergyKws = grant.minimumRenewableHeadroomKw * simulationSeconds;
    if (!Number.isFinite(usedEnergyKws) || !Number.isFinite(authorizedEnergyKws)) continue;
    allocatedEnergyKwsByGrid.set(key, usedEnergyKws);
    authorizedEnergyKwsByGrid.set(key, authorizedEnergyKws);
  }
  const quantumGrant = certificateAuthority.quantumGrant;
  const quantumFingerprint = quantumGrant ? constructionQuantumMacroFingerprint(state) : null;
  return {
    powerFactorByCenterId,
    allocatedEnergyKwsByGrid,
    authorizedEnergyKwsByGrid,
    ...(quantumGrant && quantumFingerprint === quantumGrant.fingerprint ? {
      quantumDownloadPerBoundary: quantumGrant.downloadPerBoundary,
      quantumTimelineStartSeconds: state.elapsedSeconds - simulationSeconds,
    } : {}),
  };
}

function mergeConstructionPowerReceipt(
  target: ConstructionPowerReceipt,
  allocation: ConstructionPowerAllocation,
): void {
  for (const [key, used] of allocation.allocatedEnergyKwsByGrid) {
    target.allocatedEnergyKwsByGrid.set(key, (target.allocatedEnergyKwsByGrid.get(key) ?? 0) + used);
  }
  for (const [key, authorized] of allocation.authorizedEnergyKwsByGrid) {
    target.authorizedEnergyKwsByGrid.set(
      key,
      (target.authorizedEnergyKwsByGrid.get(key) ?? 0) + authorized,
    );
  }
}

export interface ConstructionAutomationMacroReceiptOptions {
  allowUnmeteredPowerForTest?: boolean;
  powerCertificate?: PureIdleConstructionPowerCertificate;
  contract?: PureIdleAffineContract;
}

export function advanceConstructionAutomationMacroWithReceiptInPlace(
  state: GameState,
  simulationSeconds: number,
  checkpoint: PureIdleCombinedConservationCheckpoint,
  options: ConstructionAutomationMacroReceiptOptions = {},
): ReturnType<typeof advanceConstructionAutomationMacroInPlace> {
  const authority = requirePureIdleCombinedCheckpoint(checkpoint);
  const centers = state.entities.filter((entity) => entity.buildingId === "construction_center");
  const allocation = options.allowUnmeteredPowerForTest
    ? undefined
    : createConstructionPowerAllocation(
      state,
      simulationSeconds,
      options.powerCertificate,
      options.contract,
    );
  if (allocation && ![...allocation.powerFactorByCenterId.values()].some((factor) => factor > EPSILON)) {
    // Missing, stale or non-positive grants freeze only construction. Exact
    // engine windows remain authoritative and all other macro domains keep
    // their existing settlement behavior.
    for (const center of centers) {
      center.powerInputKw = 0;
      center.powerFactor = 0;
      center.utilization = 0;
      center.productionRate = 0;
    }
    return { completed: 0, centersVisited: centers.length };
  }
  let quantumReplaySeconds: number | undefined;
  if (allocation?.quantumDownloadPerBoundary !== undefined && options.powerCertificate) {
    quantumReplaySeconds = Math.min(
      Math.max(0, simulationSeconds),
      Math.max(0, authority.constructionQuantumReplayRemainingSeconds),
    );
  }
  const stageBefore = captureConstructionRecipeStageSnapshot(state);
  const result = advanceConstructionAutomationMacroInPlace(
    state,
    simulationSeconds,
    allocation ? {
      powerFactorByCenterId: allocation.powerFactorByCenterId,
      ...(allocation.quantumDownloadPerBoundary !== undefined ? {
        quantumDownloadPerBoundary: allocation.quantumDownloadPerBoundary,
        quantumTimelineStartSeconds: allocation.quantumTimelineStartSeconds ?? state.elapsedSeconds - simulationSeconds,
        quantumReplaySeconds: quantumReplaySeconds ?? 0,
      } : {}),
    } : {},
  );
  const receipt = createConstructionRecipeReceipt(stageBefore, state);
  if (typeof receipt === "string") throw new Error(`建筑制造隔离阶段最终物资守恒失败：${receipt}`);
  if (quantumReplaySeconds !== undefined) {
    authority.constructionQuantumReplayRemainingSeconds = Math.max(
      0,
      authority.constructionQuantumReplayRemainingSeconds - quantumReplaySeconds,
    );
  }
  mergeConstructionRecipeReceipt(authority.constructionRecipeReceipt, receipt);
  if (allocation) {
    mergeConstructionPowerReceipt(authority.constructionPowerReceipt, allocation);
    authority.constructionPowerReceipt.meteredCrafted += receipt.crafted;
  }
  return result;
}

export function validatePureIdleCombinedSettlementConservation(
  before: PureIdleCombinedConservationCheckpoint,
  after: GameState,
): string | null {
  const authority = PURE_IDLE_COMBINED_CHECKPOINTS.get(before);
  if (!authority) return "纯挂机组合物资守恒检查点不是当前模块签发的不透明令牌";
  return validateConstructionPowerReceipt(
    authority.constructionPowerReceipt,
    authority.constructionRecipeReceipt,
  ) ??
    validateAggregateConservation(
    authority.aggregate,
    after,
    authority.constructionRecipeReceipt,
  ) ??
    validatePureIdleResourceAccountingFromBaseline(authority.resources, after) ??
    validatePureIdleTerminalMaterialConservationFromBaseline(authority.terminals, after);
}

function validatePureIdleCombinedSettlementFromStates(before: GameState, after: GameState): string | null {
  return validatePureIdleCombinedSettlementConservation(
    capturePureIdleCombinedConservationCheckpoint(before),
    after,
  );
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
  const flowSnapshots = [capturePureIdleFlowSnapshot(state)];
  const researchSnapshots = [captureResearchMacroCalibrationSnapshot(state)];
  const powerResourceSnapshots = [captureTimeWarpExhaustiblePowerResources(state)];
  const constructionPowerAudit = createConstructionPowerAuditAccumulator();
  const windowCount = FAST_OFFLINE_CALIBRATION_SECONDS / FAST_OFFLINE_CALIBRATION_SLICE_SECONDS;
  let shadow = structuredClone(state);
  shadow = runExactCalibrationWindows(
    shadow,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
    calibrationWallSeconds / windowCount,
    windowCount,
    (candidate) => {
      powerResourceSnapshots.push(captureTimeWarpExhaustiblePowerResources(candidate));
      snapshots.push(captureAffineSnapshot(candidate));
      flowSnapshots.push(capturePureIdleFlowSnapshot(candidate));
      researchSnapshots.push(captureResearchMacroCalibrationSnapshot(candidate));
    },
    constructionPowerAudit.onPowerPlan,
    true,
  );
  const sampledContract = createFastAffineContractFromSnapshots(
    snapshots,
    FAST_OFFLINE_CALIBRATION_SECONDS,
    calibrationWallSeconds,
    true,
  );
  snapshots.length = 0;
  let researchLedger = createResearchMacroLedgerFromSnapshots(
    researchSnapshots,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
  );
  if (!sampledContract || !researchLedger) return null;
  let powerTail = createPureIdlePowerTailCertificate(
    shadow,
    powerResourceSnapshots,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
    flowSnapshots,
  );
  let contract = stripPowerFuelInputDeltas(
    shadow,
    reconcilePureIdleLightweightMaterialDeltas(removeResearchInputDeltas(sampledContract, state)),
    powerTail,
  );
  const steadyStateProbe = createPureIdleSteadyStateContract(
    state,
    shadow,
    contract,
    flowSnapshots,
    researchLedger,
  );
  // The generic affine path retains its exact finite-store/depletion model.
  // Replacing that complete contract with the lightweight steady-state result
  // would freeze legitimate finite miners after the 30-second prefix. Reuse
  // the closed-flow proof only for generator fuel: this removes the historical
  // forced factor=1 while preserving every existing finite material boundary.
  const fuelItemIds = new Set(powerTail.fuelDebits.map((debit) => debit.fuelItemId));
  const certifiedFuelFactors = Object.fromEntries(Object.entries(
    steadyStateProbe.contract.steadyStateFactorsByItem ?? {},
  ).filter(([itemId, factor]) => fuelItemIds.has(itemId as ItemId) && factor > EPSILON));
  if (Object.keys(certifiedFuelFactors).length > 0) {
    contract = {
      ...contract,
      steadyStateFactorsByItem: {
        ...(contract.steadyStateFactorsByItem ?? {}),
        ...certifiedFuelFactors,
      },
    };
  }
  powerTail = bindPowerTailToMaterialContract(shadow, powerTail, contract);
  let powerTailCertified = powerTail.maximumSimulationSeconds === null || powerTail.maximumSimulationSeconds > EPSILON;
  contract = constrainContractToPowerTail(contract, powerTail);
  if (!powerTailCertified) {
    contract = { ...contract, deltas: [], maximumSimulationSeconds: 0 };
    researchLedger = scalePureIdleResearchLedger(researchLedger, {}, [state, shadow]);
  }
  const constructionPowerCertificate = issuePureIdleConstructionPowerCertificate(
    shadow,
    contract,
    constructionPowerAudit,
    FAST_OFFLINE_CALIBRATION_SECONDS,
    [state, shadow],
  );
  return {
    contract,
    // The generic affine path has no complete steady-state research
    // certificate. A finite prefilling of a lab must not become an unbounded
    // macro research source merely because the power tail is sustainable.
    researchLedger: powerTailCertified
      ? scalePureIdleResearchLedger(researchLedger, {}, [state, shadow])
      : researchLedger,
    powerTailCertified,
    powerTail,
    constructionPowerCertificate,
    ...(!powerTailCertified
      ? { powerTailRejectionReason: powerTail.rejectionReason ?? "30 秒校准后的供电余量已耗尽" }
      : {}),
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
  const flowSnapshots = [capturePureIdleFlowSnapshot(state)];
  const researchSnapshots = [captureResearchMacroCalibrationSnapshot(state)];
  const rocketSnapshots = [capturePureIdleRocketCalibrationSnapshot(state)];
  const powerResourceSnapshots = [captureTimeWarpExhaustiblePowerResources(state)];
  const constructionPowerAudit = createConstructionPowerAuditAccumulator();
  const entityIds = state.entities.map((entity) => entity.id);
  const beltIds = state.belts.map((belt) => belt.id);
  const researchIndexes = new Set(state.entities
    .map((entity, index) => entity.recipeId === "matrix_research" ? index : -1)
    .filter((index) => index >= 0));
  const activeFiniteResource = hasActiveFinitePureIdleResource(state);
  let shadow = options.consumeState ? state : structuredClone(state);
  let topologyStable = true;
  const windowCount = FAST_OFFLINE_CALIBRATION_SECONDS / FAST_OFFLINE_CALIBRATION_SLICE_SECONDS;
  shadow = runExactCalibrationWindows(
    shadow,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
    calibrationWallSeconds / windowCount,
    windowCount,
    (candidate) => {
      powerResourceSnapshots.push(captureTimeWarpExhaustiblePowerResources(candidate));
      topologyStable &&= sameStableIdValues(entityIds, candidate.entities) && sameStableIdValues(beltIds, candidate.belts);
      snapshots.push(capturePureIdleLightweightSnapshot(candidate, sharedPaths));
      flowSnapshots.push(capturePureIdleFlowSnapshot(candidate));
      researchSnapshots.push(captureResearchMacroCalibrationSnapshot(candidate));
      rocketSnapshots.push(capturePureIdleRocketCalibrationSnapshot(candidate));
    },
    constructionPowerAudit.onPowerPlan,
    options.isolateConstructionAutomation === true,
  );
  const sampled = topologyStable
    ? createFastAffineContractFromSnapshots(
      snapshots,
      FAST_OFFLINE_CALIBRATION_SECONDS,
      calibrationWallSeconds,
      true,
    )
    : null;
  snapshots.length = 0;
  let researchLedger = createResearchMacroLedgerFromSnapshots(
    researchSnapshots,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
  );
  if (!researchLedger) return null;

  const unboundSampledContract: PureIdleAffineContract = sampled
    ? reconcilePureIdleLightweightMaterialDeltas(removeResearchInputDeltasAtIndexes({
      ...sampled,
      deltas: sampled.deltas.filter((delta) => delta.kind === "number" ? Math.abs(Number(delta.delta)) > EPSILON : delta.delta !== 0n),
    }, researchIndexes))
    : {
      deltas: [],
      calibrationSeconds: FAST_OFFLINE_CALIBRATION_SECONDS,
      calibrationWallSeconds,
    };
  let powerTail = createPureIdlePowerTailCertificate(
    shadow,
    powerResourceSnapshots,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
    flowSnapshots,
  );
  let powerTailCertified = powerTail.maximumSimulationSeconds === null || powerTail.maximumSimulationSeconds > EPSILON;
  const sampledContract = stripPowerFuelInputDeltas(shadow, unboundSampledContract, powerTail);
  let contract = freezePureIdleLightweightStoreReplenishment(sampledContract);

  // Finite vein reserves are not represented by the lightweight store sample.
  // Keep the exact prefix but do not copy its mined output past the checkpoint.
  if (activeFiniteResource || !topologyStable || !powerTailCertified) {
    contract = { ...contract, deltas: [], maximumSimulationSeconds: 0 };
    researchLedger = scalePureIdleResearchLedger(researchLedger, {}, [state, shadow]);
  } else {
    const steadyState = createPureIdleSteadyStateContract(
      state,
      shadow,
      sampledContract,
      flowSnapshots,
      researchLedger,
    );
    contract = steadyState.contract;
    researchLedger = steadyState.researchLedger;
  }
  powerTail = bindPowerTailToMaterialContract(shadow, powerTail, contract);
  powerTailCertified = powerTail.maximumSimulationSeconds === null || powerTail.maximumSimulationSeconds > EPSILON;
  contract = constrainContractToPowerTail(contract, powerTail);
  let rocketCalibration: PureIdleRocketMacroLedgerCalibration = activeFiniteResource
    ? { rejectionReason: "存在正在开采的有限矿脉，火箭尾段不能安全外推" }
    : !powerTailCertified
      ? { rejectionReason: "30 秒校准实际消耗了燃料或储能，火箭尾段已冻结" }
    : !topologyStable
      ? { rejectionReason: "校准期间工厂拓扑发生变化，火箭尾段已冻结" }
      : contract.deltas.length < 1
        ? { rejectionReason: "普通生产样本未形成闭合合同，火箭尾段已冻结" }
        : createPureIdleRocketMacroLedger(rocketSnapshots, FAST_OFFLINE_CALIBRATION_SECONDS);
  rocketCalibration = scalePureIdleRocketCalibrationForSteadyState(rocketCalibration, contract);
  const constructionPowerCertificate = issuePureIdleConstructionPowerCertificate(
    shadow,
    contract,
    constructionPowerAudit,
    FAST_OFFLINE_CALIBRATION_SECONDS,
    [state, shadow],
  );
  return {
    contract,
    researchLedger,
    powerTailCertified,
    powerTail,
    constructionPowerCertificate,
    ...(!powerTailCertified
      ? { powerTailRejectionReason: powerTail.rejectionReason ?? "30 秒校准后的供电余量已耗尽" }
      : {}),
    ...(rocketCalibration.ledger ? { rocketLedger: rocketCalibration.ledger } : {}),
    ...(rocketCalibration.rejectionReason
      ? { rocketLedgerRejectionReason: rocketCalibration.rejectionReason }
      : {}),
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
  const flowSnapshots = [capturePureIdleFlowSnapshot(state)];
  const researchSnapshots = [captureResearchMacroCalibrationSnapshot(state)];
  const rocketSnapshots = [capturePureIdleRocketCalibrationSnapshot(state)];
  const powerResourceSnapshots = [captureTimeWarpExhaustiblePowerResources(state)];
  const constructionPowerAudit = createConstructionPowerAuditAccumulator();
  let shadow = structuredClone(state);
  let topologyStable = true;
  const windowCount = FAST_OFFLINE_CALIBRATION_SECONDS / FAST_OFFLINE_CALIBRATION_SLICE_SECONDS;
  shadow = await runExactCalibrationWindowsAsync(
    shadow,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
    calibrationWallSeconds / windowCount,
    windowCount,
    asyncOptions,
    (candidate, index) => {
      powerResourceSnapshots.push(captureTimeWarpExhaustiblePowerResources(candidate));
      topologyStable &&= sameStableIds(state.entities, candidate.entities) && sameStableIds(state.belts, candidate.belts);
      snapshots.push(capturePureIdleLightweightSnapshot(candidate, sharedPaths));
      flowSnapshots.push(capturePureIdleFlowSnapshot(candidate));
      researchSnapshots.push(captureResearchMacroCalibrationSnapshot(candidate));
      rocketSnapshots.push(capturePureIdleRocketCalibrationSnapshot(candidate));
      asyncOptions.onProgress?.((index + 1) * FAST_OFFLINE_CALIBRATION_SLICE_SECONDS, FAST_OFFLINE_CALIBRATION_SECONDS);
    },
    constructionPowerAudit.onPowerPlan,
    options.isolateConstructionAutomation === true,
  );
  const sampled = topologyStable
    ? createFastAffineContractFromSnapshots(
      snapshots,
      FAST_OFFLINE_CALIBRATION_SECONDS,
      calibrationWallSeconds,
      true,
    )
    : null;
  snapshots.length = 0;
  let researchLedger = createResearchMacroLedgerFromSnapshots(
    researchSnapshots,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
  );
  if (!researchLedger) return null;
  const unboundSampledContract: PureIdleAffineContract = sampled
    ? reconcilePureIdleLightweightMaterialDeltas(removeResearchInputDeltas({
      ...sampled,
      deltas: sampled.deltas.filter((delta) => delta.kind === "number" ? Math.abs(Number(delta.delta)) > EPSILON : delta.delta !== 0n),
    }, state))
    : {
      deltas: [],
      calibrationSeconds: FAST_OFFLINE_CALIBRATION_SECONDS,
      calibrationWallSeconds,
    };
  let powerTail = createPureIdlePowerTailCertificate(
    shadow,
    powerResourceSnapshots,
    FAST_OFFLINE_CALIBRATION_SLICE_SECONDS,
    flowSnapshots,
  );
  let powerTailCertified = powerTail.maximumSimulationSeconds === null || powerTail.maximumSimulationSeconds > EPSILON;
  const sampledContract = stripPowerFuelInputDeltas(shadow, unboundSampledContract, powerTail);
  let contract = freezePureIdleLightweightStoreReplenishment(sampledContract);
  const activeFiniteResource = hasActiveFinitePureIdleResource(state);
  if (activeFiniteResource || !topologyStable || !powerTailCertified) {
    contract = { ...contract, deltas: [], maximumSimulationSeconds: 0 };
    researchLedger = scalePureIdleResearchLedger(researchLedger, {}, [state, shadow]);
  } else {
    const steadyState = createPureIdleSteadyStateContract(
      state,
      shadow,
      sampledContract,
      flowSnapshots,
      researchLedger,
    );
    contract = steadyState.contract;
    researchLedger = steadyState.researchLedger;
  }
  powerTail = bindPowerTailToMaterialContract(shadow, powerTail, contract);
  powerTailCertified = powerTail.maximumSimulationSeconds === null || powerTail.maximumSimulationSeconds > EPSILON;
  contract = constrainContractToPowerTail(contract, powerTail);
  let rocketCalibration: PureIdleRocketMacroLedgerCalibration = activeFiniteResource
    ? { rejectionReason: "存在正在开采的有限矿脉，火箭尾段不能安全外推" }
    : !powerTailCertified
      ? { rejectionReason: "30 秒校准实际消耗了燃料或储能，火箭尾段已冻结" }
    : !topologyStable
      ? { rejectionReason: "校准期间工厂拓扑发生变化，火箭尾段已冻结" }
      : contract.deltas.length < 1
        ? { rejectionReason: "普通生产样本未形成闭合合同，火箭尾段已冻结" }
        : createPureIdleRocketMacroLedger(rocketSnapshots, FAST_OFFLINE_CALIBRATION_SECONDS);
  rocketCalibration = scalePureIdleRocketCalibrationForSteadyState(rocketCalibration, contract);
  const constructionPowerCertificate = issuePureIdleConstructionPowerCertificate(
    shadow,
    contract,
    constructionPowerAudit,
    FAST_OFFLINE_CALIBRATION_SECONDS,
    [state, shadow],
  );
  return {
    contract,
    researchLedger,
    powerTailCertified,
    powerTail,
    constructionPowerCertificate,
    ...(!powerTailCertified
      ? { powerTailRejectionReason: powerTail.rejectionReason ?? "30 秒校准后的供电余量已耗尽" }
      : {}),
    ...(rocketCalibration.ledger ? { rocketLedger: rocketCalibration.ledger } : {}),
    ...(rocketCalibration.rejectionReason
      ? { rocketLedgerRejectionReason: rocketCalibration.rejectionReason }
      : {}),
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
    const stagedExactConstruction = options.constructionCheckpoint
      ? stageExactSimulationWindowWithConstructionReceipt(
        structuredClone(baseline),
        simulationSeconds,
        wallSeconds,
        options.constructionCheckpoint,
      )
      : undefined;
    const exact = stagedExactConstruction?.state ??
      runExact(structuredClone(baseline), simulationSeconds, wallSeconds);
    const exactNormalized = normalizeFastSettlementState(exact, baseline);
    if (!exactNormalized.ok) {
      return {
        ok: false,
        boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections + exactNormalized.corrections,
        failure: exactNormalized.failure ?? reconciliationFailure,
      };
    }
    const exactResourceFailure = validatePureIdleResourceAccounting(baseline, exact);
    const exactConservationFailure = validateAggregateConservation(
      before,
      exact,
      stagedExactConstruction?.receipt,
    );
    const exactTerminalFailure = validatePureIdleTerminalMaterialConservation(baseline, exact);
    if (exactResourceFailure || exactConservationFailure || exactTerminalFailure) {
      return {
        ok: false,
        boundaryCorrections: (applied.corrections ?? 0) + normalized.corrections + exactNormalized.corrections,
        failure: exactResourceFailure ?? exactConservationFailure ?? exactTerminalFailure ?? reconciliationFailure,
      };
    }
    refreshDysonGenerationSnapshot(exact);
    if (stagedExactConstruction) commitStagedExactConstructionReceipt(stagedExactConstruction);
    Object.assign(candidate, exact);
    rebindPureIdleConstructionPowerCertificateAfterValidatedTransaction(
      options.constructionPowerCertificate,
      contract,
      baseline,
      candidate,
    );
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
  rebindPureIdleConstructionPowerCertificateAfterValidatedTransaction(
    options.constructionPowerCertificate,
    contract,
    baseline,
    candidate,
  );
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

interface AffinePrimitiveJournalEntry {
  path: AffinePath;
  existed: boolean;
  value: unknown;
}

function captureAffinePrimitive(root: unknown, path: AffinePath): AffinePrimitiveJournalEntry | null {
  if (path.length === 0) return null;
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string | number, unknown>)[path[index]];
  }
  if (typeof current !== "object" || current === null) return null;
  const key = path.at(-1)!;
  return {
    path,
    existed: Object.prototype.hasOwnProperty.call(current, key),
    value: (current as Record<string | number, unknown>)[key],
  };
}

function restoreAffinePrimitive(root: unknown, entry: AffinePrimitiveJournalEntry): boolean {
  let current = root;
  for (let index = 0; index < entry.path.length - 1; index += 1) {
    if (typeof current !== "object" || current === null) return false;
    current = (current as Record<string | number, unknown>)[entry.path[index]];
  }
  if (typeof current !== "object" || current === null) return false;
  const record = current as Record<string | number, unknown>;
  const key = entry.path.at(-1)!;
  if (entry.existed) record[key] = entry.value;
  else delete record[key];
  return true;
}

function isClosedPureIdleLightweightDelta(delta: AffineDelta): boolean {
  const itemId = pureIdleLightweightContractItemId(delta.path);
  if (!itemId || PURE_IDLE_LIGHTWEIGHT_FROZEN_ITEMS.has(itemId as ItemId)) return false;
  const micros = pureIdleDeltaMicros(delta);
  if (delta.path[0] === "totalProduced") return micros >= 0n;
  return isPureIdleLightweightStorePath(delta.path) && micros <= 0n;
}

function normalizeClosedPureIdleLightweightValue(
  state: GameState,
  entry: AffinePrimitiveJournalEntry,
): { failure?: string; corrections: number } {
  const value = readAffinePath(state, entry.path);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { failure: `轻量宏观字段不是有限数值 ${JSON.stringify(entry.path)}=${String(value)}`, corrections: 0 };
    }
    if (entry.path[0] === "totalProduced") {
      if (!Number.isSafeInteger(value) || value < 0 || typeof entry.value === "number" && value < entry.value) {
        return { failure: `轻量宏观累计产量无效或发生回退 ${JSON.stringify(entry.path)}`, corrections: 0 };
      }
      return { corrections: 0 };
    }
    // Store deltas are depletion-only. An individual cyclic cache can empty
    // before the aggregate item horizon even while another cache still owns
    // the same material. Match the historical normalizer by clamping only
    // that touched store to zero; this under-consumes and is rechecked by the
    // aggregate conservation gate below.
    const normalized = Math.max(0, Math.floor(value + EPSILON));
    if (!Number.isSafeInteger(normalized)) {
      return { failure: `轻量宏观库存超过安全整数 ${JSON.stringify(entry.path)}`, corrections: 0 };
    }
    if (normalized !== value && !writeAffinePath(state, entry.path, normalized)) {
      return { failure: `轻量宏观库存无法修正 ${JSON.stringify(entry.path)}`, corrections: 0 };
    }
    return { corrections: normalized === value ? 0 : 1 };
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return { corrections: 0 };
  return { failure: `轻量宏观字段类型无效 ${JSON.stringify(entry.path)}`, corrections: 0 };
}

function replaceRecord<T>(target: Record<string, T> | undefined, source: Record<string, T> | undefined): void {
  if (!target) return;
  for (const key of Object.keys(target)) delete target[key];
  if (source) Object.assign(target, source);
}

/**
 * Transactional low-memory application for the compact pure-idle contract.
 *
 * The generic affine path clones the complete GameState because it may touch
 * arbitrary fields and normalization can repair the whole graph.  The
 * lightweight contract has a much smaller, formally closed write set:
 * monotonic totalProduced counters and depletion-only material stores. Keep a
 * primitive undo journal for those paths, run the same aggregate conservation
 * gate, and roll back every value/remainder on failure. This removes the last
 * full-state clone from an endgame macro bucket without weakening the
 * transaction boundary.
 */
export function applyPureIdleLightweightContractInPlace(
  state: GameState,
  contract: PureIdleAffineContract,
  simulationSeconds: number,
  wallSeconds: number,
  options: Pick<PureIdleAffineApplicationOptions,
    "skipUnsafeIntegerPaths" | "integerRemainders" | "decimalRemainders" | "simulationSecondsByItem"> = {},
): PureIdleAffineApplication {
  if (!contract.deltas.every(isClosedPureIdleLightweightDelta)) {
    return { ok: false, boundaryCorrections: 0, failure: "轻量宏观合同包含闭合账本之外的字段" };
  }
  const journal = contract.deltas.map((delta) => captureAffinePrimitive(state, delta.path));
  if (journal.some((entry) => entry === null)) {
    return { ok: false, boundaryCorrections: 0, failure: "轻量宏观合同路径无法建立撤销日志" };
  }
  const entries = journal as AffinePrimitiveJournalEntry[];
  const before = captureAggregateConservationBaseline(state);
  const integerRemainders = options.integerRemainders ? { ...options.integerRemainders } : undefined;
  const decimalRemainders = options.decimalRemainders ? { ...options.decimalRemainders } : undefined;
  const rollback = (failure: string, corrections = 0): PureIdleAffineApplication => {
    for (let index = entries.length - 1; index >= 0; index -= 1) restoreAffinePrimitive(state, entries[index]);
    replaceRecord(options.integerRemainders, integerRemainders);
    replaceRecord(options.decimalRemainders, decimalRemainders);
    return { ok: false, boundaryCorrections: corrections, failure };
  };
  const applied = applyFastAffineContract(
    state,
    contract,
    simulationSeconds,
    wallSeconds,
    true,
    options.skipUnsafeIntegerPaths ?? false,
    options.integerRemainders,
    options.decimalRemainders,
    options.simulationSecondsByItem,
  );
  if (!applied.ok) return rollback(applied.failure ?? "轻量宏观合同应用失败", applied.corrections ?? 0);
  let corrections = applied.corrections ?? 0;
  for (const entry of entries) {
    const normalized = normalizeClosedPureIdleLightweightValue(state, entry);
    corrections += normalized.corrections;
    if (normalized.failure) return rollback(normalized.failure, corrections);
  }
  const conservationFailure = validateAggregateConservation(before, state);
  if (conservationFailure) return rollback(conservationFailure, corrections);
  return { ok: true, boundaryCorrections: corrections };
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
  const combinedFailure = validatePureIdleCombinedSettlementFromStates(source, safeCandidate);
  if (combinedFailure) {
    // Never publish a partially applied candidate. A clock-only clone of the
    // source is the final safe boundary when even the bounded prefix fails.
    safeCandidate = structuredClone(source);
    provenSimulationSeconds = 0;
    reason = `${reason}；已丢弃未通过守恒门禁的候选：${combinedFailure}`;
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

/**
 * Bind a short time-warp research probe to material that the same compact
 * contract can account for. A matrix arriving at a research lab is safe to
 * replay only when the probe also observed either matching manufacture or a
 * matching depletion from an owned store. Unmatched route/cache inflow is
 * frozen; already-present lab inputs remain usable because the research macro
 * can consume those physical pools only once.
 */
function createTimeWarpMaterialBoundResearchLedger(
  state: GameState,
  sampledContract: PureIdleAffineContract,
  ledger: ResearchMacroLedger,
): ResearchMacroLedger {
  const producedMicrosByItem = new Map<string, bigint>();
  const storeDeltaMicrosByItem = new Map<string, bigint>();
  for (const delta of sampledContract.deltas) {
    const itemId = pureIdleLightweightContractItemId(delta.path);
    if (!itemId) continue;
    const micros = pureIdleDeltaMicros(delta);
    if (delta.path[0] === "totalProduced" && micros > 0n) {
      producedMicrosByItem.set(itemId, (producedMicrosByItem.get(itemId) ?? 0n) + micros);
    } else if (isPureIdleLightweightStorePath(delta.path)) {
      storeDeltaMicrosByItem.set(itemId, (storeDeltaMicrosByItem.get(itemId) ?? 0n) + micros);
    }
  }
  const inflowPerWindow: ResearchMacroLedger["inflowPerWindow"] = {};
  for (const [itemId, requested] of Object.entries(ledger.inflowPerWindow)) {
    // Sum stores before taking the depletion credit. A transfer from one
    // ordinary cache to another has zero net funding and must not be reused as
    // research input. If another active recipe also consumes this matrix, its
    // share cannot be separated by the half-second probe, so only matching
    // manufacture is safe and the ambiguous stock depletion is withheld.
    const hasCompetingRecipe = state.entities.some((entity) => {
      if (entity.recipeId === "matrix_research" || entity.machineCount < 1) return false;
      return getRecipe(entity.recipeId)?.inputs.some((input) => input.itemId === itemId) ?? false;
    });
    const storeDelta = storeDeltaMicrosByItem.get(itemId) ?? 0n;
    const depletionFunding = !hasCompetingRecipe && storeDelta < 0n ? -storeDelta : 0n;
    const available = ((producedMicrosByItem.get(itemId) ?? 0n) + depletionFunding) /
      PURE_IDLE_DELTA_MICROS_PER_ITEM;
    const credited = requested && requested > 0n
      ? requested < available ? requested : available
      : 0n;
    if (credited > 0n) inflowPerWindow[itemId as ItemId] = credited;
  }
  return { ...ledger, inflowPerWindow };
}

interface TimeWarpExhaustiblePowerResourceEntry {
  kind: "fuel" | "storage";
  buildingId?: FactoryEntity["buildingId"];
  fuelItemId?: ItemId;
  fuelEnergyMj: number;
  fuelEfficiency: number;
  fuelThermalBankMj: number;
  storageBankMj: number;
  powerOutputKw: number;
}

type TimeWarpExhaustiblePowerResourceSnapshot = Map<string, TimeWarpExhaustiblePowerResourceEntry>;

const TIME_WARP_STORAGE_POWER_BUILDINGS = new Set(["accumulator", "energy_exchanger"]);

function captureTimeWarpExhaustiblePowerResources(
  state: GameState,
): TimeWarpExhaustiblePowerResourceSnapshot {
  const resources: TimeWarpExhaustiblePowerResourceSnapshot = new Map();
  for (const entity of state.entities) {
    const isFuel = Boolean(entity.buildingId && PURE_IDLE_MATERIAL_POWER_BUILDINGS.has(entity.buildingId));
    const isStorage = Boolean(entity.buildingId && TIME_WARP_STORAGE_POWER_BUILDINGS.has(entity.buildingId));
    if (!isFuel && !isStorage) continue;
    const fuelEnergyMj = entity.fuelItemId ? Math.max(0, FUEL_ENERGY_MJ[entity.fuelItemId] ?? 0) : 0;
    const selectedFuelInput = entity.fuelItemId
      ? Math.floor(Math.max(0, finiteNumber(entity.inputs[entity.fuelItemId])) + EPSILON)
      : 0;
    resources.set(entity.id, {
      kind: isFuel ? "fuel" : "storage",
      ...(entity.buildingId ? { buildingId: entity.buildingId } : {}),
      ...(entity.fuelItemId ? { fuelItemId: entity.fuelItemId } : {}),
      fuelEnergyMj,
      fuelEfficiency: entity.buildingId ? getFuelEfficiency(entity.buildingId) : 1,
      fuelThermalBankMj: Math.max(0, finiteNumber(entity.fuelRemainingMj)) + selectedFuelInput * fuelEnergyMj,
      storageBankMj: Math.max(0, finiteNumber(entity.storedEnergyMj)) +
        (entity.buildingId === "energy_exchanger"
          ? Math.floor(Math.max(0, finiteNumber(entity.inputs.charged_accumulator)) + EPSILON) *
            ACCUMULATOR_ENERGY_MJ
          : 0),
      powerOutputKw: Math.max(0, finiteNumber(entity.powerOutputKw)),
    });
  }
  return resources;
}

function minimumProducedPerWindow(
  flowSnapshots: readonly PureIdleFlowSnapshot[] | undefined,
  itemId: ItemId,
): { produced: number; consumed: number } | null {
  if (!flowSnapshots || flowSnapshots.length < 2 || flowSnapshots.some((snapshot) => snapshot.failure)) return null;
  let minimumProduced = Number.POSITIVE_INFINITY;
  let minimumConsumed = Number.POSITIVE_INFINITY;
  for (let index = 1; index < flowSnapshots.length; index += 1) {
    const before = flowSnapshots[index - 1];
    const after = flowSnapshots[index];
    const produced = (after.produced.get(itemId) ?? 0n) - (before.produced.get(itemId) ?? 0n);
    const grants = (after.grants.get(itemId) ?? 0n) - (before.grants.get(itemId) ?? 0n);
    const stockDelta = (after.stores.get(itemId) ?? 0n) - (before.stores.get(itemId) ?? 0n);
    const consumed = produced + grants - stockDelta;
    if (produced < 0n || grants < 0n || consumed < 0n) return null;
    minimumProduced = Math.min(minimumProduced, Number(produced));
    minimumConsumed = Math.min(minimumConsumed, Number(consumed));
  }
  if (!Number.isFinite(minimumProduced) || !Number.isFinite(minimumConsumed)) return null;
  return { produced: minimumProduced, consumed: minimumConsumed };
}

function hasLocallyProvenFuelSupply(
  state: GameState,
  generatorEntityId: string,
  itemId: ItemId,
  requiredUnitsPerSimulationSecond: number,
): boolean {
  const incomingByTarget = new Map<string, string[]>();
  for (const belt of state.belts) {
    if (belt.itemId !== itemId) continue;
    const incoming = incomingByTarget.get(belt.target) ?? [];
    incoming.push(belt.source);
    incomingByTarget.set(belt.target, incoming);
  }
  const entities = new Map(state.entities.map((entity) => [entity.id, entity]));
  const visited = new Set<string>([generatorEntityId]);
  const creditedSources = new Set<string>();
  const queue = [generatorEntityId];
  let provenUnitsPerSecond = 0;
  while (queue.length > 0) {
    const targetId = queue.shift()!;
    for (const sourceId of incomingByTarget.get(targetId) ?? []) {
      if (visited.has(sourceId)) continue;
      visited.add(sourceId);
      const source = entities.get(sourceId);
      if (!source) continue;
      const intrinsicallySustainableVein = state.settings.resourceMode === "infinite" &&
        source.kind === "vein" && source.resourceId === itemId;
      const connectedRecipeProducer = source.kind === "machine" &&
        getRecipe(source.recipeId)?.outputs.some((output) => output.itemId === itemId) === true;
      const connectedQuantumDemand = source.kind === "station" &&
        source.buildingId === "interstellar_logistics_station" &&
        source.quantumMode === "quantum" && state.quantumLogisticsNetwork?.enabled === true &&
        getStationSlots(source).some((slot) => slot.itemId === itemId && slot.remoteMode === "demand");
      // Recipe producers are accepted only as topology evidence here. The
      // three-window material identity and the final conservative contract
      // still have to fund the complete measured generator burn before this
      // path becomes unbounded, so a prefilled or disconnected producer cannot
      // certify itself merely by retaining a stale productionRate.
      // A quantum demand station is likewise only a bound delivery endpoint;
      // its observed throughput is not material credit. The global fuel rate
      // remains the sole source and is checked once against all generators.
      if ((intrinsicallySustainableVein || connectedRecipeProducer || connectedQuantumDemand) &&
        source.productionRate > EPSILON &&
        !creditedSources.has(source.id)) {
        creditedSources.add(source.id);
        provenUnitsPerSecond += source.productionRate / 60;
      }
      queue.push(sourceId);
    }
  }
  return provenUnitsPerSecond + EPSILON >= requiredUnitsPerSimulationSecond;
}

function createPureIdlePowerTailCertificate(
  state: GameState,
  snapshots: readonly TimeWarpExhaustiblePowerResourceSnapshot[],
  windowSeconds: number,
  flowSnapshots?: readonly PureIdleFlowSnapshot[],
): PureIdlePowerTailCertificate {
  const productiveMultiplier = Math.max(
    state.settings.simulationSpeed,
    Math.floor(finiteNumber(state.timeWarp.effectiveMultiplier)),
  );
  if (snapshots.length < 2 || !Number.isFinite(windowSeconds) || windowSeconds <= EPSILON) {
    return {
      productiveMultiplier,
      fuelDebits: [],
      maximumSimulationSeconds: 0,
      storageDispatchDetected: false,
      rejectionReason: "供电校准窗口不完整",
    };
  }

  let storageDispatchDetected = false;
  let invalidFuelSample = false;
  const ratesByEntity = new Map<string, PureIdlePowerFuelDebit>();
  for (let index = 1; index < snapshots.length; index += 1) {
    const before = snapshots[index - 1];
    const after = snapshots[index];
    for (const entityId of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(entityId);
      const current = after.get(entityId);
      if (!previous || !current || previous.kind !== current.kind) {
        invalidFuelSample = true;
        continue;
      }
      if (current.kind === "storage") {
        if (current.powerOutputKw > EPSILON || current.storageBankMj + EPSILON < previous.storageBankMj) {
          storageDispatchDetected = true;
        }
        continue;
      }
      const bankDepletionRate = Math.max(0, previous.fuelThermalBankMj - current.fuelThermalBankMj) /
        windowSeconds;
      const outputBurnRate = current.fuelEfficiency > EPSILON
        ? current.powerOutputKw / (1000 * current.fuelEfficiency)
        : 0;
      const thermalMjPerSimulationSecond = Math.max(bankDepletionRate, outputBurnRate);
      if (thermalMjPerSimulationSecond <= EPSILON) continue;
      if (!current.fuelItemId || current.fuelEnergyMj <= EPSILON ||
        current.fuelItemId !== previous.fuelItemId || current.buildingId !== previous.buildingId) {
        invalidFuelSample = true;
        continue;
      }
      const existing = ratesByEntity.get(entityId);
      ratesByEntity.set(entityId, {
        entityId,
        fuelItemId: current.fuelItemId,
        thermalMjPerSimulationSecond: Math.max(
          thermalMjPerSimulationSecond,
          existing?.thermalMjPerSimulationSecond ?? 0,
        ),
        sustainable: false,
      });
    }
  }

  const requiredFuelUnitsPerWindow = new Map<ItemId, number>();
  for (const debit of ratesByEntity.values()) {
    const energyPerItem = FUEL_ENERGY_MJ[debit.fuelItemId] ?? 0;
    if (energyPerItem <= EPSILON) {
      invalidFuelSample = true;
      continue;
    }
    requiredFuelUnitsPerWindow.set(
      debit.fuelItemId,
      (requiredFuelUnitsPerWindow.get(debit.fuelItemId) ?? 0) +
        debit.thermalMjPerSimulationSecond * windowSeconds / energyPerItem,
    );
  }
  const sustainableFuelItems = new Set<ItemId>();
  for (const [itemId, required] of requiredFuelUnitsPerWindow) {
    const flow = minimumProducedPerWindow(flowSnapshots, itemId);
    const fuelEntityIds = [...ratesByEntity.values()]
      .filter((debit) => debit.fuelItemId === itemId)
      .map((debit) => debit.entityId);
    const remainedDispatched = snapshots.slice(1).every((snapshot) =>
      fuelEntityIds.every((entityId) => (snapshot.get(entityId)?.powerOutputKw ?? 0) > EPSILON));
    const localBankStayedInPhase = fuelEntityIds.every((entityId) => {
      for (let index = 1; index < snapshots.length; index += 1) {
        const previous = snapshots[index - 1].get(entityId);
        const current = snapshots[index].get(entityId);
        const previousBank = previous?.fuelThermalBankMj ?? 0;
        const currentBank = current?.fuelThermalBankMj ?? 0;
        // Fuel loading and burning are integer-item / fractional-heat phases.
        // A boundary may therefore be lower by less than one complete item even
        // while the connected line has a large positive flow. Larger decreases
        // remain a real finite-bank signal.
        const phaseTolerance = Math.max(
          1e-6,
          current?.fuelEnergyMj ?? 0,
          Math.abs(previousBank) * Number.EPSILON * 16,
        );
        if (currentBank + phaseTolerance < previousBank) return false;
      }
      return true;
    });
    const localSupplyProven = fuelEntityIds.every((entityId) => {
      const debit = ratesByEntity.get(entityId);
      if (!debit) return false;
      const energyPerItem = FUEL_ENERGY_MJ[itemId] ?? 0;
      return energyPerItem > EPSILON && hasLocallyProvenFuelSupply(
        state,
        entityId,
        itemId,
        debit.thermalMjPerSimulationSecond / energyPerItem,
      );
    });
    // Production alone is not enough: stock must show that the same amount was
    // actually consumed during every exact window. This prevents a disconnected
    // fuel factory elsewhere from certifying a draining generator cache. The
    // generator-local thermal bank must also be non-decreasing at every exact
    // boundary; a whole fuel-item phase tolerance would let a prefilled rod be
    // mistaken for an indefinitely replenished source.
    // `flow.consumed` counts whole fuel items while each generator retains a
    // fractional thermal remainder. Across an arbitrary ten-second boundary
    // that can be short by strictly less than one item per generator even
    // though the matching heat was already paid. The local-bank phase proof
    // above bounds exactly that remainder; no larger material tolerance is
    // allowed.
    const fuelPhaseToleranceItems = fuelEntityIds.length;
    if (flow && remainedDispatched && localBankStayedInPhase && localSupplyProven &&
      flow.produced + EPSILON >= required &&
      flow.consumed + fuelPhaseToleranceItems + EPSILON >= required) {
      sustainableFuelItems.add(itemId);
    }
  }

  const fuelDebits = [...ratesByEntity.values()]
    .sort((left, right) => left.entityId.localeCompare(right.entityId))
    .map((debit) => ({ ...debit, sustainable: sustainableFuelItems.has(debit.fuelItemId) }));
  let maximumSimulationSeconds: number | null = null;
  const current = snapshots.at(-1)!;
  for (const debit of fuelDebits) {
    if (debit.sustainable) continue;
    const remaining = current.get(debit.entityId)?.fuelThermalBankMj ?? 0;
    const horizon = debit.thermalMjPerSimulationSecond > EPSILON
      ? Math.max(0, remaining / debit.thermalMjPerSimulationSecond)
      : 0;
    maximumSimulationSeconds = maximumSimulationSeconds === null
      ? horizon
      : Math.min(maximumSimulationSeconds, horizon);
  }
  if (storageDispatchDetected || invalidFuelSample) maximumSimulationSeconds = 0;
  return {
    productiveMultiplier,
    fuelDebits,
    maximumSimulationSeconds,
    storageDispatchDetected,
    ...(storageDispatchDetected
      ? { rejectionReason: "校准窗口使用了未建立闭合充放电账本的储能" }
      : invalidFuelSample
        ? { rejectionReason: "校准窗口中的燃料发电实体或燃料类型发生变化" }
        : {}),
  };
}

function stripPowerFuelInputDeltas(
  state: GameState,
  contract: PureIdleAffineContract,
  powerTail: PureIdlePowerTailCertificate,
): PureIdleAffineContract {
  if (powerTail.fuelDebits.length < 1) return contract;
  const fuelByEntityIndex = new Map<number, ItemId>();
  const debitByEntity = new Map(powerTail.fuelDebits.map((debit) => [debit.entityId, debit]));
  state.entities.forEach((entity, index) => {
    const debit = debitByEntity.get(entity.id);
    if (debit) fuelByEntityIndex.set(index, debit.fuelItemId);
  });
  return {
    ...contract,
    deltas: contract.deltas.filter((delta) => {
      if (delta.path[0] !== "entities" || typeof delta.path[1] !== "number" ||
        !fuelByEntityIndex.has(delta.path[1])) return true;
      // The power ledger owns both halves of the generator bank. Retaining
      // either sampled delta would double-debit finite fuel or slowly drift a
      // proven steady producer away from its exact calibration phase.
      if (delta.path[2] === "fuelRemainingMj") return false;
      return !(delta.path[2] === "inputs" && delta.path[3] === fuelByEntityIndex.get(delta.path[1]));
    }),
  };
}

function constrainContractToPowerTail(
  contract: PureIdleAffineContract,
  powerTail: PureIdlePowerTailCertificate,
): PureIdleAffineContract {
  if (powerTail.maximumSimulationSeconds === null) return contract;
  const maximumSimulationSeconds = contract.maximumSimulationSeconds === undefined
    ? powerTail.maximumSimulationSeconds
    : Math.min(contract.maximumSimulationSeconds, powerTail.maximumSimulationSeconds);
  return { ...contract, maximumSimulationSeconds };
}

function bindPowerTailToMaterialContract(
  state: GameState,
  powerTail: PureIdlePowerTailCertificate,
  contract: PureIdleAffineContract,
): PureIdlePowerTailCertificate {
  const producedPerSimulationSecond = new Map<ItemId, number>();
  for (const delta of contract.deltas) {
    if (delta.path[0] !== "totalProduced" || typeof delta.path[1] !== "string" ||
      delta.kind !== "number" || !Number.isFinite(Number(delta.delta)) || Number(delta.delta) <= EPSILON) continue;
    producedPerSimulationSecond.set(
      delta.path[1] as ItemId,
      (producedPerSimulationSecond.get(delta.path[1] as ItemId) ?? 0) +
        Number(delta.delta) / Math.max(EPSILON, contract.calibrationSeconds),
    );
  }
  const requiredPerSimulationSecond = new Map<ItemId, number>();
  for (const debit of powerTail.fuelDebits) {
    const energyPerItem = FUEL_ENERGY_MJ[debit.fuelItemId] ?? 0;
    const required = energyPerItem > EPSILON
      ? debit.thermalMjPerSimulationSecond / energyPerItem
      : Number.POSITIVE_INFINITY;
    requiredPerSimulationSecond.set(
      debit.fuelItemId,
      (requiredPerSimulationSecond.get(debit.fuelItemId) ?? 0) + required,
    );
  }
  const fundedFuelItems = new Set<ItemId>();
  for (const [itemId, required] of requiredPerSimulationSecond) {
    const everyLocalPathProven = powerTail.fuelDebits
      .filter((debit) => debit.fuelItemId === itemId)
      .every((debit) => debit.sustainable);
    const steadyFactor = contract.steadyStateFactorsByItem?.[itemId];
    const unboundedFuelFlow = steadyFactor !== undefined && steadyFactor > EPSILON &&
      contract.maximumSimulationSecondsByItem?.[itemId] === undefined;
    if (everyLocalPathProven && unboundedFuelFlow && Number.isFinite(required) &&
      (producedPerSimulationSecond.get(itemId) ?? 0) + EPSILON >= required) {
      fundedFuelItems.add(itemId);
    }
  }
  const fuelDebits = powerTail.fuelDebits.map((debit) => ({
    ...debit,
    sustainable: fundedFuelItems.has(debit.fuelItemId),
  }));
  const rebound: PureIdlePowerTailCertificate = {
    ...powerTail,
    fuelDebits,
    maximumSimulationSeconds: powerTail.storageDispatchDetected || powerTail.rejectionReason ? 0 : null,
  };
  return {
    ...rebound,
    maximumSimulationSeconds: availablePureIdlePowerTailSeconds(state, rebound),
  };
}

function availablePureIdlePowerTailSeconds(
  state: GameState,
  powerTail: PureIdlePowerTailCertificate,
): number | null {
  if (powerTail.storageDispatchDetected || powerTail.rejectionReason) return 0;
  let maximum: number | null = null;
  const entities = new Map(state.entities.map((entity) => [entity.id, entity]));
  for (const debit of powerTail.fuelDebits) {
    if (debit.sustainable) continue;
    const entity = entities.get(debit.entityId);
    const energyPerItem = FUEL_ENERGY_MJ[debit.fuelItemId] ?? 0;
    if (!entity || entity.fuelItemId !== debit.fuelItemId || energyPerItem <= EPSILON ||
      debit.thermalMjPerSimulationSecond <= EPSILON) return 0;
    const available = Math.max(0, finiteNumber(entity.fuelRemainingMj)) +
      Math.floor(Math.max(0, finiteNumber(entity.inputs[debit.fuelItemId])) + EPSILON) * energyPerItem;
    const horizon = available / debit.thermalMjPerSimulationSecond;
    maximum = maximum === null ? horizon : Math.min(maximum, horizon);
  }
  return maximum;
}

function mergeTimeWarpPowerTailCertificates(
  state: GameState,
  calibration: PureIdlePowerTailCertificate,
  validation: PureIdlePowerTailCertificate,
): PureIdlePowerTailCertificate {
  const fuelDebits = new Map<string, PureIdlePowerFuelDebit>();
  for (const debit of [...calibration.fuelDebits, ...validation.fuelDebits]) {
    const previous = fuelDebits.get(debit.entityId);
    fuelDebits.set(debit.entityId, {
      ...debit,
      thermalMjPerSimulationSecond: Math.max(
        debit.thermalMjPerSimulationSecond,
        previous?.thermalMjPerSimulationSecond ?? 0,
      ),
      // The short time-warp certificate has no three-window material-flow
      // proof. A source seen in only one half of the probe therefore remains
      // an exhaustible debit, never an implicitly sustainable generator.
      sustainable: Boolean(previous?.sustainable && debit.sustainable),
    });
  }
  const rejectionReason = calibration.rejectionReason ?? validation.rejectionReason;
  const merged: PureIdlePowerTailCertificate = {
    productiveMultiplier: validation.productiveMultiplier,
    fuelDebits: [...fuelDebits.values()].sort((left, right) => left.entityId.localeCompare(right.entityId)),
    maximumSimulationSeconds: 0,
    storageDispatchDetected: calibration.storageDispatchDetected || validation.storageDispatchDetected,
    ...(rejectionReason ? { rejectionReason } : {}),
  };
  return {
    ...merged,
    maximumSimulationSeconds: availablePureIdlePowerTailSeconds(state, merged),
  };
}

/** Debit the physical generator bank exactly once for a credited macro tail. */
export function applyPureIdlePowerTailFuelDebitInPlace(
  state: GameState,
  powerTail: PureIdlePowerTailCertificate,
  simulationSeconds: number,
): string | null {
  if (!Number.isFinite(simulationSeconds) || simulationSeconds < 0) return "供电燃料扣账时间无效";
  if (simulationSeconds <= EPSILON) return null;
  const available = availablePureIdlePowerTailSeconds(state, powerTail);
  if (available !== null && simulationSeconds > available + 1e-6) {
    return `供电燃料仅支持 ${Math.max(0, available).toFixed(6)} 个模拟秒`;
  }
  const entities = new Map(state.entities.map((entity) => [entity.id, entity]));
  for (const debit of powerTail.fuelDebits) {
    if (debit.sustainable) continue;
    const entity = entities.get(debit.entityId);
    const energyPerItem = FUEL_ENERGY_MJ[debit.fuelItemId] ?? 0;
    if (!entity || entity.fuelItemId !== debit.fuelItemId || energyPerItem <= EPSILON) {
      return `供电燃料实体 ${debit.entityId} 已变化`;
    }
    const initialHeatMj = Math.max(0, finiteNumber(entity.fuelRemainingMj));
    const queuedFuel = Math.floor(Math.max(0, finiteNumber(entity.inputs[debit.fuelItemId])) + EPSILON);
    const requiredHeatMj = Math.max(0, debit.thermalMjPerSimulationSecond * simulationSeconds);
    const totalAvailableHeatMj = initialHeatMj + queuedFuel * energyPerItem;
    const floatingToleranceMj = Math.max(1e-6, Math.abs(totalAvailableHeatMj) * Number.EPSILON * 8);
    if (requiredHeatMj > totalAvailableHeatMj + floatingToleranceMj) {
      return `供电燃料实体 ${debit.entityId} 的 ${debit.fuelItemId} 已耗尽`;
    }
    const heatNeededAfterCurrent = Math.max(0, requiredHeatMj - initialHeatMj);
    const rawRequestedItems = heatNeededAfterCurrent > EPSILON
      ? Math.ceil(Math.max(0, heatNeededAfterCurrent - EPSILON) / energyPerItem)
      : 0;
    const requestedItems = Math.min(queuedFuel, rawRequestedItems);
    const availableHeatMj = initialHeatMj + requestedItems * energyPerItem;
    if (requiredHeatMj > availableHeatMj + floatingToleranceMj) return `供电燃料实体 ${debit.entityId} 热量不足`;
    if (requestedItems > 0) entity.inputs[debit.fuelItemId] = queuedFuel - requestedItems;
    entity.fuelRemainingMj = Math.round(Math.max(0, availableHeatMj - requiredHeatMj) * 1_000_000) / 1_000_000;
  }
  return null;
}

function downshiftExhaustedTimeWarpPower(state: GameState, powerTail: PureIdlePowerTailCertificate): void {
  if (availablePureIdlePowerTailSeconds(state, powerTail) !== 0) return;
  // A certificate spans every dispatched grid, while the time-warp multiplier
  // belongs only to the controller's own grid. One remote planet exhausting a
  // local star must not force the entire save to base speed; recalculate the
  // controller allocation from current physical power instead.
  refreshTimeWarpPowerSnapshotInPlace(state);
}

function timeWarpCertificateMatches(state: GameState, certificate: TimeWarpRollingCertificate): boolean {
  return certificate.entityArray === state.entities && certificate.beltArray === state.belts &&
    certificate.mode === state.mode && certificate.version === state.version &&
    certificate.controllerEntityId === state.timeWarp.controllerEntityId &&
    certificate.requestedMultiplier === state.timeWarp.requestedMultiplier &&
    certificate.powerTail.productiveMultiplier === Math.max(
      state.settings.simulationSpeed,
      Math.floor(finiteNumber(state.timeWarp.effectiveMultiplier)),
    ) &&
    state.timeWarp.enabled && !state.paused;
}

function storeTimeWarpRollingCertificate(
  state: GameState,
  sampledContract: PureIdleAffineContract,
  researchLedger: ResearchMacroLedger,
  lastCriticalError: number,
  powerTail: PureIdlePowerTailCertificate,
): void {
  const availablePowerSeconds = availablePureIdlePowerTailSeconds(state, powerTail);
  if (powerTail.rejectionReason || availablePowerSeconds === 0 ||
    powerTail.productiveMultiplier <= state.settings.simulationSpeed) return;
  const closed = stripPowerFuelInputDeltas(
    state,
    freezePureIdleLightweightStoreReplenishment(sampledContract),
    powerTail,
  );
  if (closed.deltas.length === 0 || !closed.deltas.every(isClosedPureIdleLightweightDelta)) return;
  const maximumSimulationSecondsByItem = calculatePureIdleLightweightBoundaries(state, sampledContract);
  const contract = maximumSimulationSecondsByItem
    ? { ...closed, maximumSimulationSecondsByItem }
    : closed;
  timeWarpRollingCertificates.set(state, {
    contract,
    researchLedger,
    researchRemainder: 0n,
    researchInflowRemainders: {},
    integerRemainders: {},
    decimalRemainders: {},
    remainingSimulationSecondsByItem: { ...(maximumSimulationSecondsByItem ?? {}) },
    ageWallSeconds: 0,
    lastCriticalError,
    entityArray: state.entities,
    beltArray: state.belts,
    mode: state.mode,
    version: state.version,
    ...(state.timeWarp.controllerEntityId ? { controllerEntityId: state.timeWarp.controllerEntityId } : {}),
    requestedMultiplier: state.timeWarp.requestedMultiplier,
    powerTail,
  });
}

function runTimeWarpRollingCertificateInPlace(
  state: GameState,
  simulationSeconds: number,
  wallSeconds: number,
): TimeWarpApproximationResult | null {
  const certificate = timeWarpRollingCertificates.get(state);
  if (!certificate || !timeWarpCertificateMatches(state, certificate) ||
    certificate.ageWallSeconds + wallSeconds >= TIME_WARP_ROLLING_CERTIFICATE_VALIDATION_WALL_SECONDS) {
    if (certificate) timeWarpRollingCertificates.delete(state);
    return null;
  }
  const desiredSpeedrunElapsed = state.speedrun?.enabled
    ? Math.round((state.speedrun.elapsedActiveSeconds + Math.min(wallSeconds, 30 * 24 * 60 * 60)) * 1_000_000) / 1_000_000
    : undefined;
  if (desiredSpeedrunElapsed !== undefined &&
    (!Number.isFinite(desiredSpeedrunElapsed) || desiredSpeedrunElapsed < state.speedrun!.elapsedActiveSeconds)) {
    timeWarpRollingCertificates.delete(state);
    return null;
  }
  const combinedBefore = capturePureIdleCombinedConservationCheckpoint(state);
  const availablePowerSeconds = availablePureIdlePowerTailSeconds(state, certificate.powerTail);
  const powerProductiveSeconds = Math.min(
    simulationSeconds,
    Math.max(0, certificate.powerTail.productiveMultiplier * wallSeconds),
    availablePowerSeconds === null ? simulationSeconds : Math.max(0, availablePowerSeconds),
  );
  const creditedSecondsByItem = Object.fromEntries(Object.entries(certificate.remainingSimulationSecondsByItem).map(
    ([itemId, remaining]) => [itemId, Math.min(powerProductiveSeconds, Math.max(0, remaining))],
  ));
  const applied = applyPureIdleLightweightContractInPlace(
    state,
    certificate.contract,
    powerProductiveSeconds,
    simulationSeconds > EPSILON ? wallSeconds * powerProductiveSeconds / simulationSeconds : 0,
    {
      skipUnsafeIntegerPaths: true,
      integerRemainders: certificate.integerRemainders,
      decimalRemainders: certificate.decimalRemainders,
      simulationSecondsByItem: creditedSecondsByItem,
    },
  );
  if (!applied.ok) {
    timeWarpRollingCertificates.delete(state);
    return null;
  }
  const fuelDebitFailure = applyPureIdlePowerTailFuelDebitInPlace(
    state,
    certificate.powerTail,
    powerProductiveSeconds,
  );
  if (fuelDebitFailure) {
    timeWarpRollingCertificates.delete(state);
    throw new Error(`滚动证书供电燃料扣账失败：${fuelDebitFailure}`);
  }
  const researchSeconds = MATRIX_ITEM_IDS.reduce((maximum, itemId) => {
    const itemSeconds = creditedSecondsByItem[itemId];
    return itemSeconds === undefined ? maximum : Math.min(maximum, itemSeconds);
  }, powerProductiveSeconds);
  const research = advanceResearchMacroInPlace(
    state,
    certificate.researchLedger,
    researchSeconds,
    certificate.researchRemainder,
    certificate.researchInflowRemainders,
  );
  certificate.researchRemainder = research.remainder;
  certificate.researchInflowRemainders = research.inflowRemainders;
  for (const [itemId, credited] of Object.entries(creditedSecondsByItem)) {
    certificate.remainingSimulationSecondsByItem[itemId] = Math.max(
      0,
      (certificate.remainingSimulationSecondsByItem[itemId] ?? 0) - credited,
    );
  }
  const construction = advanceConstructionAutomationMacroWithReceiptInPlace(
    state,
    powerProductiveSeconds,
    combinedBefore,
  );
  state.elapsedSeconds += simulationSeconds;
  if (desiredSpeedrunElapsed !== undefined && state.speedrun?.enabled) {
    state.speedrun.elapsedActiveSeconds = desiredSpeedrunElapsed;
  }
  refreshDysonGenerationSnapshot(state);
  refreshTimeWarpPowerSnapshotInPlace(state);
  downshiftExhaustedTimeWarpPower(state, certificate.powerTail);
  const combinedFailure = validatePureIdleCombinedSettlementConservation(combinedBefore, state);
  if (combinedFailure) {
    timeWarpRollingCertificates.delete(state);
    // This bucket is deliberately in-place and construction/research mutate a
    // wider graph than the primitive ordinary-production journal. Throwing is
    // the transaction abort signal: simulation.worker discards this entire
    // isolated authority and requests a rebuild from the durable checkpoint.
    throw new Error(`滚动证书最终物资守恒门禁失败：${combinedFailure}`);
  }
  certificate.ageWallSeconds += wallSeconds;
  if (research.completedFiniteTechIds.length > 0 || research.completedInfiniteLevels.length > 0) {
    // A completed technology can change recipe/power multipliers. Force the
    // next slice through exact calibration instead of trusting the old rate.
    certificate.ageWallSeconds = TIME_WARP_ROLLING_CERTIFICATE_VALIDATION_WALL_SECONDS;
  }
  return {
    state,
    report: {
      mode: "approximate",
      algorithmVersion: TIME_WARP_APPROXIMATION_ALGORITHM_VERSION,
      requestedSimulationSeconds: simulationSeconds,
      exactCalibrationSeconds: 0,
      approximatedSeconds: simulationSeconds,
      maxCriticalError: certificate.lastCriticalError,
      boundaryCorrections: applied.boundaryCorrections,
      certificateReused: true,
      certificateAgeWallSeconds: certificate.ageWallSeconds,
      ...(powerProductiveSeconds + EPSILON < simulationSeconds
        ? { fallbackReason: `供电证书仅支持 ${powerProductiveSeconds.toFixed(3)} 个模拟秒，其余尾段已冻结` }
        : construction.completed > 0
        ? { fallbackReason: `滚动证书有效；建筑制造巨构按真实库存递归完成 ${construction.completed.toLocaleString("zh-CN")} 件` }
        : {}),
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
  const calibrationPowerResources = [captureTimeWarpExhaustiblePowerResources(state)];
  const combinedBefore = capturePureIdleCombinedConservationCheckpoint(state);
  const calibrated = structuredClone(state);
  const constructionEnabled = calibrated.constructionAutomation.enabled;
  calibrated.constructionAutomation.enabled = false;
  runExact(calibrated, calibrationSeconds, calibrationWallSeconds);
  calibrated.constructionAutomation.enabled = constructionEnabled;
  calibrationPowerResources.push(captureTimeWarpExhaustiblePowerResources(calibrated));
  const calibrationPowerTail = createPureIdlePowerTailCertificate(
    calibrated,
    calibrationPowerResources,
    calibrationSeconds,
  );
  const calibratedSnapshot = capturePureIdleLightweightSnapshot(calibrated, sharedPaths);
  const sampledResearchLedger = createResearchMacroLedgerFromSnapshots(
    [sourceResearch, captureResearchMacroCalibrationSnapshot(calibrated)],
    calibrationSeconds,
  );
  const sampled = createFastAffineContractFromSnapshots(
    [sourceSnapshot, calibratedSnapshot],
    calibrationSeconds,
    calibrationWallSeconds,
    true,
  );
  let sampledContract: PureIdleAffineContract = sampled
    ? reconcilePureIdleLightweightMaterialDeltas(removeResearchInputDeltas(sampled, state))
    : { deltas: [], calibrationSeconds, calibrationWallSeconds };
  let contract = stripPowerFuelInputDeltas(
    calibrated,
    freezePureIdleLightweightStoreReplenishment(sampledContract),
    calibrationPowerTail,
  );
  const maximumSimulationSecondsByItem = calculatePureIdleLightweightBoundaries(calibrated, sampledContract);
  if (maximumSimulationSecondsByItem) contract = { ...contract, maximumSimulationSecondsByItem };
  const researchLedger = sampledResearchLedger
    ? createTimeWarpMaterialBoundResearchLedger(state, sampledContract, sampledResearchLedger)
    : null;
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
  const availablePowerSeconds = availablePureIdlePowerTailSeconds(calibrated, calibrationPowerTail);
  const totalPowerBudget = Math.min(
    simulationSeconds,
    Math.max(0, calibrationPowerTail.productiveMultiplier * wallSeconds),
  );
  // The validation suffix is exact and must retain enough fuel to prove the
  // same dispatch after the macro debit. A one-second bank therefore funds the
  // 0.5s prefix + 0.5s verifier, never the copied 15s tail.
  const powerCreditedMacroSeconds = Math.max(0, Math.min(
    macroSeconds,
    totalPowerBudget - calibrationSeconds - validationSeconds,
    availablePowerSeconds === null
      ? macroSeconds
      : Math.max(0, availablePowerSeconds - validationSeconds),
  ));
  const creditedMacroSeconds = Math.min(
    macroSeconds,
    powerCreditedMacroSeconds,
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
  const fuelDebitFailure = applyPureIdlePowerTailFuelDebitInPlace(
    calibrated,
    calibrationPowerTail,
    creditedMacroSeconds,
  );
  if (fuelDebitFailure) {
    return conservativeTimeWarpResult(
      state,
      structuredClone(state),
      simulationSeconds,
      wallSeconds,
      0,
      `供电燃料宏观扣账失败：${fuelDebitFailure}`,
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
  const validationPowerResources = [captureTimeWarpExhaustiblePowerResources(calibrated)];
  calibrated.constructionAutomation.enabled = false;
  runExact(calibrated, validationSeconds, validationWallSeconds);
  calibrated.constructionAutomation.enabled = constructionEnabled;
  validationPowerResources.push(captureTimeWarpExhaustiblePowerResources(calibrated));
  const validationPowerTail = createPureIdlePowerTailCertificate(
    calibrated,
    validationPowerResources,
    validationSeconds,
  );
  if (validationPowerTail.productiveMultiplier !== calibrationPowerTail.productiveMultiplier ||
    (!calibrationPowerTail.storageDispatchDetected && validationPowerTail.storageDispatchDetected) ||
    calibrationPowerTail.fuelDebits.length === 0 && validationPowerTail.fuelDebits.length > 0) {
    return conservativeTimeWarpResult(
      state,
      structuredClone(state),
      simulationSeconds,
      wallSeconds,
      0,
      "独立尾验没有复现相同的供电倍率与能源来源",
    );
  }
  const rollingPowerTail = mergeTimeWarpPowerTailCertificates(
    calibrated,
    calibrationPowerTail,
    validationPowerTail,
  );
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
  const combinedFailure = normalizedActual.ok
    ? validatePureIdleCombinedSettlementConservation(combinedBefore, calibrated)
    : undefined;
  if (!normalizedActual.ok || combinedFailure ||
    !Number.isFinite(maxCriticalError) || maxCriticalError > TIME_WARP_MAX_CRITICAL_ERROR) {
    return conservativeTimeWarpResult(
      state,
      structuredClone(state),
      simulationSeconds,
      wallSeconds,
      0,
      normalizedActual.failure ?? combinedFailure ??
        `白糖或戴森关键指标尾验误差 ${(maxCriticalError * 100).toFixed(2)}% 超过 100%`,
    );
  }
  const productiveSimulationSeconds = calibrationSeconds + validationSeconds + creditedMacroSeconds;
  let construction: ReturnType<typeof advanceConstructionAutomationMacroInPlace>;
  try {
    construction = advanceConstructionAutomationMacroWithReceiptInPlace(
      calibrated,
      productiveSimulationSeconds,
      combinedBefore,
    );
  } catch (error) {
    return conservativeTimeWarpResult(
      state,
      structuredClone(state),
      simulationSeconds,
      wallSeconds,
      0,
      `最终物资守恒门禁拒绝含建筑制造的时间扭曲候选：${error instanceof Error ? error.message : "施工阶段收据无效"}`,
    );
  }
  calibrated.elapsedSeconds = state.elapsedSeconds + simulationSeconds;
  const speedrunCorrection = normalizeFastSpeedrunClock(calibrated, state, wallSeconds);
  refreshTimeWarpPowerSnapshotInPlace(calibrated);
  downshiftExhaustedTimeWarpPower(calibrated, rollingPowerTail);
  refreshDysonGenerationSnapshot(calibrated);
  const finalCombinedFailure = validatePureIdleCombinedSettlementConservation(combinedBefore, calibrated);
  if (finalCombinedFailure) {
    return conservativeTimeWarpResult(
      state,
      structuredClone(state),
      simulationSeconds,
      wallSeconds,
      0,
      `最终物资守恒门禁拒绝含建筑制造的时间扭曲候选：${finalCombinedFailure}`,
    );
  }
  storeTimeWarpRollingCertificate(
    calibrated,
    sampledContract,
    researchLedger,
    maxCriticalError,
    rollingPowerTail,
  );
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
      ...(calibrationPowerTail.storageDispatchDetected
        ? { fallbackReason: "储能只结算有界精确前缀；未建立闭合充放电账本的尾段已冻结" }
        : productiveSimulationSeconds + EPSILON < simulationSeconds
          ? { fallbackReason: `供电证书仅支持 ${productiveSimulationSeconds.toFixed(3)} 个模拟秒，其余尾段已冻结` }
          : comparison.maxError > TIME_WARP_MAX_CRITICAL_ERROR
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

/**
 * Worker-owned realtime entry. The first slice uses the full exact
 * calibration/tail verifier; subsequent slices may consume the rolling
 * certificate in place for up to ten wall seconds. UI/tests keep using the
 * immutable wrapper above.
 */
export function runTimeWarpApproximateSettlementInPlace(
  state: GameState,
  simulationSeconds: number,
  wallSeconds: number,
): TimeWarpApproximationResult {
  if (state.timeWarp.pendingSimulationSeconds > EPSILON || state.timeWarp.pendingWallSeconds > EPSILON) {
    throw new Error("时间扭曲状态仍包含未提交预算，已拒绝宏观切片");
  }
  if (!Number.isFinite(simulationSeconds) || simulationSeconds <= 0 ||
    !Number.isFinite(wallSeconds) || wallSeconds < 0 ||
    !Number.isSafeInteger(Math.floor(state.elapsedSeconds + simulationSeconds))) {
    invalidateTimeWarpApproximationCertificate(state);
    return runTimeWarpApproximateSettlement(state, simulationSeconds, wallSeconds);
  }
  try {
    const rolling = runTimeWarpRollingCertificateInPlace(state, simulationSeconds, wallSeconds);
    if (rolling) return rolling;
  } catch (error) {
    // A rolling bucket is intentionally in-place. If an unexpected exception
    // happens after its primitive transaction commits, the isolated Worker
    // authority must be discarded and rebuilt from the durable caller state;
    // replaying exact work on the possibly advanced object could double-pay.
    invalidateTimeWarpApproximationCertificate(state);
    const detail = error instanceof Error && error.message ? `：${error.message.slice(0, 160)}` : "";
    throw new Error(`滚动证书异常，必须从持久检查点重建${detail}`, { cause: error });
  }
  try {
    return runTimeWarpApproximateSettlementUnsafe(state, simulationSeconds, wallSeconds);
  } catch (error) {
    invalidateTimeWarpApproximationCertificate(state);
    const detail = error instanceof Error && error.message ? `：${error.message.slice(0, 160)}` : "";
    return exactTimeWarpResult(state, simulationSeconds, wallSeconds, `首次校准异常，已使用精确切片${detail}`);
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
  const combinedCheckpoint = capturePureIdleCombinedConservationCheckpoint(source);
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
      candidate = advanceExactSimulationWindowWithConstructionReceipt(
        structuredClone(source),
        prefixSeconds,
        prefixWallSeconds,
        combinedCheckpoint,
      );
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
  const combinedConservationFailure = validatePureIdleCombinedSettlementConservation(combinedCheckpoint, candidate);
  if (combinedConservationFailure) {
    // The calibrated/research candidate is isolated. Reject it as a whole and
    // preserve the durable source checkpoint; a clock-only conservative result
    // is preferable to committing even one unsupported material mutation.
    if (calibratedState && effectiveCalibrationSeconds <= EPSILON && !researchLedger) {
      return {
        status: "invalid-source",
        report: {
          ...fastExactReport(0, `原始检查点无法建立物资守恒基线：${combinedConservationFailure}`),
          settlementStatus: "invalid-source",
        },
      };
    }
    return runConservativeOfflineSettlement(
      source,
      seconds,
      wallSeconds,
      `${reason}；最终物资守恒门禁拒绝候选：${combinedConservationFailure}`,
      structuredClone(source),
      0,
      undefined,
      deadlineReached,
    );
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
  constructionPowerCertificate: PureIdleConstructionPowerCertificate;
  researchInvested: bigint;
  macroSeconds: number;
  creditedMacroSeconds: number;
  productiveSimulationSeconds: number;
  validationWallSeconds: number;
  validationSimulationSecondsByItem?: Record<string, number>;
  validationBaseline: AffineSnapshot;
  expectedValidation: AffineSnapshot;
  criticalBaseline: TimeWarpCriticalSnapshot;
  expectedCritical: TimeWarpCriticalSnapshot;
  rocketValidationPlan?: PureIdleRocketMacroPlan;
  sharedPaths: Map<string, AffinePath>;
  boundaryCorrections: number;
}

function isFastLightweightQuiescent(state: GameState): boolean {
  const onlyInertResourceAnchors = state.entities.every((entity) =>
    entity.kind === "vein" && Number.isFinite(entity.minerCount) && entity.minerCount <= 0,
  );
  return state.belts.length === 0 && onlyInertResourceAnchors &&
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
  rocketPlan?: PureIdleRocketMacroPlan,
): TimeWarpCriticalSnapshot {
  const entry = predicted.entries.get(pathKey(["totalProduced", "universe_matrix"]));
  const planStructurePoints = { ...baseline.planStructurePoints };
  for (const [systemId, amount] of Object.entries(rocketPlan?.launchesBySystem ?? {})) {
    planStructurePoints[systemId] = finiteNumber(planStructurePoints[systemId]) + amount;
  }
  return {
    ...baseline,
    rocketsLaunched: baseline.rocketsLaunched + (rocketPlan?.launched ?? 0),
    structurePoints: baseline.structurePoints + (rocketPlan?.launched ?? 0),
    planStructurePoints,
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
  const availablePowerSeconds = availablePureIdlePowerTailSeconds(
    calibrated.calibratedState,
    calibrated.powerTail,
  );
  if (availablePowerSeconds !== null && availablePowerSeconds + EPSILON < FAST_OFFLINE_VALIDATION_SECONDS) {
    return { failure: "30 秒校准后的供电余量不足以完成独立尾验" };
  }
  const powerMacroSeconds = availablePowerSeconds === null
    ? macroSeconds
    : Math.max(0, availablePowerSeconds - FAST_OFFLINE_VALIDATION_SECONDS);
  const creditedMacroSeconds = Math.min(
    macroSeconds,
    powerMacroSeconds,
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
  const fuelDebitFailure = applyPureIdlePowerTailFuelDebitInPlace(
    calibrated.calibratedState,
    calibrated.powerTail,
    creditedMacroSeconds,
  );
  if (fuelDebitFailure) return { failure: `快速离线供电燃料扣账失败：${fuelDebitFailure}` };
  let rocketMacroPlan: PureIdleRocketMacroPlan | undefined;
  if (calibrated.rocketLedger) {
    const rocketMacroSeconds = Math.min(
      creditedMacroSeconds,
      Math.max(0, creditedMacroSecondsByItem?.small_carrier_rocket ?? creditedMacroSeconds),
    );
    rocketMacroPlan = advancePureIdleRocketMacroLedgerInPlace(
      calibrated.calibratedState,
      calibrated.rocketLedger,
      rocketMacroSeconds,
    );
    if (rocketMacroPlan.failure) return { failure: rocketMacroPlan.failure };
    const terminalFailure = validatePureIdleTerminalMaterialConservation(source, calibrated.calibratedState);
    if (terminalFailure) return { failure: terminalFailure };
  }
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
  const rocketValidationSeconds = calibrated.rocketLedger
    ? Math.min(
      FAST_OFFLINE_VALIDATION_SECONDS,
      Math.max(0, validationSimulationSecondsByItem?.small_carrier_rocket ?? FAST_OFFLINE_VALIDATION_SECONDS),
    )
    : 0;
  const rocketValidationPlan = calibrated.rocketLedger
    ? planPureIdleRocketMacroLedger(
      calibrated.rocketLedger,
      rocketValidationSeconds,
      rocketMacroPlan?.remaindersBySystem,
    )
    : undefined;
  if (rocketValidationPlan?.failure) return { failure: rocketValidationPlan.failure };
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
    constructionPowerCertificate: calibrated.constructionPowerCertificate,
    researchInvested: research.consumed,
    macroSeconds,
    creditedMacroSeconds,
    productiveSimulationSeconds: FAST_OFFLINE_CALIBRATION_SECONDS +
      creditedMacroSeconds + FAST_OFFLINE_VALIDATION_SECONDS,
    validationWallSeconds,
    validationSimulationSecondsByItem,
    validationBaseline,
    expectedValidation,
    criticalBaseline,
    expectedCritical: criticalSnapshotWithPredictedWhiteMatrix(
      criticalBaseline,
      expectedValidation,
      rocketValidationPlan,
    ),
    ...(rocketValidationPlan ? { rocketValidationPlan } : {}),
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
  const actualCritical = captureTimeWarpCriticalSnapshot(actual);
  const expectedCritical = prepared.rocketValidationPlan?.launched
    ? { ...prepared.expectedCritical, dysonGenerationKw: actualCritical.dysonGenerationKw }
    : prepared.expectedCritical;
  const maxEstimatedError = compareTimeWarpCriticalSnapshots(
    prepared.criticalBaseline,
    expectedCritical,
    actualCritical,
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
  const finalCheckpoint = capturePureIdleCombinedConservationCheckpoint(source);
  const construction = advanceConstructionAutomationMacroWithReceiptInPlace(
    actual,
    prepared.productiveSimulationSeconds,
    finalCheckpoint,
    {
      powerCertificate: prepared.constructionPowerCertificate,
      contract: prepared.contract,
    },
  );
  actual.elapsedSeconds = source.elapsedSeconds + seconds;
  const speedrunCorrection = normalizeFastSpeedrunClock(actual, source, wallSeconds);
  const normalizedFinal = normalizeFastSettlementState(actual, source);
  const combinedConservationFailure = normalizedFinal.ok
    ? validatePureIdleCombinedSettlementConservation(finalCheckpoint, actual)
    : undefined;
  if (!normalizedFinal.ok || combinedConservationFailure || !validateFastNumbers(actual)) {
    return runConservativeOfflineSettlement(
      source,
      seconds,
      wallSeconds,
      `建筑制造巨构尾段未通过最终存档与物资守恒校验${normalizedFinal.failure || combinedConservationFailure
        ? `：${normalizedFinal.failure ?? combinedConservationFailure}`
        : ""}`,
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
  const result = await runExactAsyncSession(source, seconds, options, wallSeconds);
  return result.state;
}

async function runExactAsyncSession(
  source: GameState,
  seconds: number,
  options: OfflineApproximationAsyncOptions,
  wallSeconds: number,
  lookup?: SimulationAdvanceSession["lookup"],
  onPowerPlan?: (sample: SimulationPowerAuditSample) => void,
  isolateConstructionAutomation = false,
): Promise<{ state: GameState; lookup?: SimulationAdvanceSession["lookup"] }> {
  const entitiesBefore = source.entities;
  const beltsBefore = source.belts;
  const session = createSimulationAdvanceSession(source, seconds, {
    mutateState: true,
    wallSeconds,
    lookup,
    ...(onPowerPlan || isolateConstructionAutomation ? {
      contractExperiment: {
        ...(onPowerPlan ? { onPowerPlan } : {}),
        ...(isolateConstructionAutomation ? { isolateConstructionAutomation: true } : {}),
      },
    } : {}),
  });
  const yieldAfterMs = Math.max(8, options.yieldAfterMs ?? 40);
  let sliceStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  while (session.remainingSeconds > EPSILON || session.remainingWallSeconds > EPSILON) {
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
  const state = completeSimulationAdvanceSession(session);
  return {
    state,
    lookup: state.entities === entitiesBefore && state.belts === beltsBefore
      ? session.lookup
      : undefined,
  };
}

async function runExactCalibrationWindowsAsync(
  source: GameState,
  windowSeconds: number,
  windowWallSeconds: number,
  windowCount: number,
  options: OfflineApproximationAsyncOptions,
  onWindowCompleted: (state: GameState, windowIndex: number) => void,
  onPowerPlan?: (sample: SimulationPowerAuditSample) => void,
  isolateConstructionAutomation = false,
): Promise<GameState> {
  let state = source;
  let lookup: SimulationAdvanceSession["lookup"];
  for (let index = 0; index < windowCount; index += 1) {
    const result = await runExactAsyncSession(
      state,
      windowSeconds,
      options,
      windowWallSeconds,
      lookup,
      onPowerPlan,
      isolateConstructionAutomation,
    );
    state = result.state;
    lookup = result.lookup;
    onWindowCompleted(state, index);
  }
  return state;
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
