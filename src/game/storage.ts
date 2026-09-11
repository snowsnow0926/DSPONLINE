import {
  DYSON_SHELL_CAPACITY_PER_STRUCTURE,
  DYSON_SHELL_SAIL_POWER_KW,
  DYSON_STRUCTURE_POWER_KW,
  DEFAULT_STATION_WARPER_TARGET,
  DEFAULT_PLANET_TRAY_ITEM_LIMIT,
  MAX_PLANET_TRAY_ITEM_LIMIT,
  MAX_BUILDING_BUFFER_LIMIT,
  MAX_BUILDING_STACK_COUNT,
  MAX_BELT_LANES,
  MAX_CONSTRUCTION_AUTOMATION_TARGET,
  MIN_PLANET_TRAY_ITEM_LIMIT,
  SOLAR_SAIL_POWER_KW,
  STATION_SLOT_COUNT,
  STATION_WARPER_CAPACITY_PER_BUILDING,
  advanceSimulation,
  createInitialState,
  getDysonPowerMultiplier,
  settleCompletedResearchBoundaries,
} from "./engine";
import { BUILDINGS, ITEMS, PLANET_LIST, STAR_SYSTEMS, getBeltConstructionId, getBuilding, getExtractorBuildingId, getPlanet, getRecipe, getTechnology, isRegisteredBeltTier } from "./content";
import { normalizeCampaignState, syncCampaignProgress } from "./campaign";
import { isDifficultyMode } from "./difficulty";
import { isAchievementId } from "./progression";
import { DEFAULT_GALAXY_SEED, GUARANTEED_CRUDE_OIL_PLANETS, createVeinReserve, getPlanetOrbitalYields, getStarLuminosity, isInfiniteResource, normalizeGalaxyState } from "./galaxy";
import { createEndgameState, getOfflineSimulationLimitSeconds } from "./endgame";
import { getInfiniteResearchCostBigInt, getInfiniteResearchMaximumLevel } from "./infiniteResearch";
import { normalizeDecimalIntegerString } from "./quantityFormat";
import { ACTIVITY_MATERIAL_IDS } from "./activity";
import { computeSaveStateChecksum, inspectSaveEnvelopeChecksum } from "./saveEnvelopeIntegrity";
import {
  computeSavePayloadTextChecksum,
  decodeVerifiedSaveTransfer,
  serializeSaveEnvelopeToTransfer,
  type SaveTransferVerification,
} from "./saveTransfer";
import { createEmptyGalacticHubNetwork, createEmptySystemSpaceStations } from "./systemSpaceStation";
import { normalizeHubInteger, SYSTEM_HUB_MAX_DIGITS } from "./systemHubLogistics";
import { createEmptyQuantumLogisticsNetworkState, normalizeQuantumInteger, normalizeQuantumLogisticsNetworkState, QUANTUM_MAX_INTEGER_DIGITS } from "./quantumLogisticsNetwork";
import { evaluateSpeedrunMilestones, normalizeSpeedrunState } from "./speedrun";
import { normalizeIdleSettlementState } from "./idleSettlement";
import { getMissingContentPackRequirements, loadContentPackRegistry, type ContentPackRegistry } from "./contentPacks";
import { projectPersistentSaveState } from "./saveProjection";
import {
  clearPrimarySaveEmergencyMirror,
  flushLocalSaveWrites,
  getLocalSaveStorageEstimate,
  getLocalSaveValue,
  hasLocalSaveCapacity,
  listLocalSaveKeys,
  readPersistedLocalSaveValue,
  reloadLocalSaveCache,
  removeLocalSaveValue,
  setLocalSaveValue,
  writePrimarySaveEmergencyMirror,
  type LocalSaveStorageEstimate,
} from "./localSaveStore";
import type { ActivityMaterialId, BeltConnection, BeltRouteMode, BeltTier, BlueprintDefinition, BlueprintMirror, BlueprintRotation, BuildingId, CanvasRegion, CargoStackSize, ConstructionAutomationTargetId, ConstructionId, DysonEngineeringState, DysonLayerState, DysonLaunchMode, DysonLaunchThrottle, DysonSpherePlanState, DysonSwarmOrbitState, EnergyMode, EndgameState, FactoryEntity, GalacticDispatchThrottle, GalacticExportProjectId, GameState, InfiniteResearchId, InterstellarRoutePolicy, ItemId, LogisticsPriority, MaterialDeliverySlot, PlanetId, PortableFleetItemId, PowerGridId, PowerPriority, ProliferatorMode, ProliferatorTier, RecipeId, SaveMode, SorterTier, StarSystemId, StationLogisticsMode, StationMinimumLoad, StationRoute, StationSlot, TechId, SystemSpaceStationState, GalacticHubNetworkState } from "./types";
import type { OfflineApproximationReport } from "./offlineApproximation";
import type { OfflineComplexityReport } from "./offlineComplexity";
import type { OfflineSettlementFailureKind } from "./offlineSettlementStrategy";
import type { CloudSaveSummary } from "./cloud";

export const SAVE_KEY = "dsp-idle-network.save.v1";
const SAVE_SLOT_KEY_PREFIX = "dsp-idle-network.slot";
const SAVE_BACKUP_KEY = `${SAVE_KEY}.backup`;
const SAVE_MODE_MIGRATION_BACKUP_KEY = `${SAVE_KEY}.migration-backup.v46`;
const SAVE_SNAPSHOT_KEY_PREFIX = `${SAVE_KEY}.snapshot`;
export const AUTOMATIC_SAVE_SNAPSHOT_LIMIT = 2;
const SAVE_FORMAT_VERSION = 2;
const AUTO_SNAPSHOT_MIN_SECONDS = 5 * 60;
const RETURNING_REWARD_KEY_PREFIX = "dsp-idle-network.returning-reward";
const RETURNING_REWARD_MIN_SECONDS = 72 * 60 * 60;

type CachedSaveSummary = {
  raw: string;
  summary: SaveSlotSummary | SaveSnapshotSummary;
};

const saveSummaryCache = new Map<string, CachedSaveSummary>();

export type SaveSlotId = 1 | 2 | 3;
export const SAVE_MODES: readonly SaveMode[] = ["normal", "speedrun"];

export function normalizeSaveMode(value: unknown): SaveMode {
  return value === "speedrun" ? "speedrun" : "normal";
}

function normalizeSaveSlot(value: unknown): SaveSlotId | "main" {
  return value === 1 || value === 2 || value === 3 ? value : "main";
}

export function saveModeForState(state: Pick<GameState, "mode">): SaveMode {
  return normalizeSaveMode(state.mode);
}

function primarySaveKey(mode: SaveMode): string {
  return mode === "normal" ? SAVE_KEY : `${SAVE_KEY}.${mode}`;
}

function backupSaveKey(mode: SaveMode): string {
  return mode === "normal" ? SAVE_BACKUP_KEY : `${SAVE_BACKUP_KEY}.${mode}`;
}

function emergencySaveKey(mode: SaveMode): string {
  return mode === "normal" ? SAVE_KEY : `${SAVE_KEY}.${mode}.emergency`;
}

function envelopeSavedAt(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { savedAt?: unknown };
    return typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt) ? Math.max(0, parsed.savedAt) : 0;
  } catch {
    return 0;
  }
}

function readPrimaryOrEmergency(mode: SaveMode): string | null {
  const primaryKey = primarySaveKey(mode);
  const primary = getLocalSaveValue(primaryKey);
  if (emergencySaveKey(mode) === primaryKey) return primary;
  const emergency = getLocalSaveValue(emergencySaveKey(mode));
  return emergency && (!primary || envelopeSavedAt(emergency) > envelopeSavedAt(primary)) ? emergency : primary;
}

function slotSaveKey(slotId: SaveSlotId, mode: SaveMode): string {
  return mode === "normal" ? `${SAVE_SLOT_KEY_PREFIX}.${slotId}` : `${SAVE_SLOT_KEY_PREFIX}.${mode}.${slotId}`;
}

function snapshotSavePrefix(mode: SaveMode): string {
  return mode === "normal" ? SAVE_SNAPSHOT_KEY_PREFIX : `${SAVE_SNAPSHOT_KEY_PREFIX}.${mode}`;
}

function snapshotSequenceKey(mode: SaveMode): string {
  return `${snapshotSavePrefix(mode)}.sequence`;
}

function isLegacyNormalKey(key: string, base: string): boolean {
  return key === base;
}

function isLegacySaveWithoutMode(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; state?: { mode?: unknown } };
    return parsed.mode === undefined && parsed.state?.mode === undefined &&
      !("state" in parsed && parsed.state === undefined);
  } catch {
    return false;
  }
}

function preserveLegacyModeMigrationBackupSync(previous: string | null, mode: SaveMode): boolean {
  if (mode !== "normal" || !previous || !isLegacySaveWithoutMode(previous)) return true;
  if (getLocalSaveValue(SAVE_MODE_MIGRATION_BACKUP_KEY) !== null) return true;
  try {
    setLocalSaveValue(SAVE_MODE_MIGRATION_BACKUP_KEY, previous);
    return getLocalSaveValue(SAVE_MODE_MIGRATION_BACKUP_KEY) === previous;
  } catch {
    return false;
  }
}

async function preserveLegacyModeMigrationBackup(previous: string | null, mode: SaveMode): Promise<boolean> {
  if (mode !== "normal" || !previous || !isLegacySaveWithoutMode(previous)) return true;
  if (getLocalSaveValue(SAVE_MODE_MIGRATION_BACKUP_KEY) !== null) return true;
  const capacity = await hasLocalSaveCapacity(SAVE_MODE_MIGRATION_BACKUP_KEY, previous);
  if (!capacity.ok) return false;
  try {
    setLocalSaveValue(SAVE_MODE_MIGRATION_BACKUP_KEY, previous);
    await flushLocalSaveWrites();
    return await readPersistedLocalSaveValue(SAVE_MODE_MIGRATION_BACKUP_KEY) === previous;
  } catch {
    return false;
  }
}

export type SaveIntegrityStatus = "valid" | "legacy" | "repaired" | "corrupt";

interface SaveEnvelope {
  formatVersion?: number;
  kind?: "primary" | "slot" | "snapshot";
  reason?: string;
  mode?: SaveMode;
  slot?: SaveSlotId | "main";
  savedAt: number;
  state: GameState | Record<string, unknown>;
  checksum?: string;
}

export interface LoadedGame {
  state: GameState;
  offlineSeconds: number;
  offlineReport: OfflineReport | null;
  recovery?: SaveRecovery;
}

export interface DeferredLoadedGame extends LoadedGame {
  savedAt: number;
}

export interface SaveRecovery {
  source: "primary" | "backup" | "snapshot" | "fresh";
  issues: string[];
}

export interface OfflineReport {
  seconds: number;
  settlement?: OfflineSettlementReceipt;
  produced: Array<{ itemId: ItemId; amount: number }>;
  completedTechIds: TechId[];
  structurePointsAdded: number;
  shellSailsAdded: number;
  infiniteResearchLevels?: Array<{ id: InfiniteResearchId; level: number }>;
  exported?: Array<{ projectId: GalacticExportProjectId; amount: number }>;
  galacticCreditsAdded?: number;
  returningReward?: Array<{ itemId: ItemId; amount: number }>;
  approximation?: OfflineApproximationReport;
  /** Runtime-only diagnosis for the just-completed calculation. */
  complexity?: OfflineComplexityReport;
}

export interface OfflineSettlementReceipt {
  status: "exact" | "approximate" | "conservative-skipped";
  committed: boolean;
  rewardsSubmitted: boolean;
  originalSeconds: number;
  submittedSeconds: number;
  failureKind?: OfflineSettlementFailureKind;
  failureReason?: string;
}

export interface SaveSlotSummary {
  slotId: SaveSlotId;
  mode: SaveMode;
  savedAt: number;
  elapsedSeconds: number;
  completedTechCount: number;
  structurePoints: number;
  activePlanetId: PlanetId;
  integrity: SaveIntegrityStatus;
  valid: boolean;
  issues: string[];
}

export interface SaveSnapshotSummary {
  id: string;
  mode: SaveMode;
  savedAt: number;
  elapsedSeconds: number;
  completedTechCount: number;
  structurePoints: number;
  activePlanetId: PlanetId;
  reason: string;
  integrity: SaveIntegrityStatus;
  valid: boolean;
  issues: string[];
}

export type SaveGameFailureCode = "quota" | "verification" | "unavailable";

export interface SaveGameResult {
  success: boolean;
  message: string;
  code?: SaveGameFailureCode;
  savedAt?: number;
  bytes?: number;
  removedAutomaticSnapshots?: number;
  backupSaved?: boolean;
  /** True when the requested state is already the last verified primary save. */
  skippedUnchanged?: boolean;
  timings?: SaveStageTimings;
}

export interface SaveStageTimings {
  totalMs: number;
  serializeMs: number;
  snapshotScanMs: number;
  capacityMs: number;
  primaryWriteMs: number;
  backupMs: number;
  automaticSnapshotMs: number;
}

export interface LocalSaveSummaryMetrics {
  slotCount: number;
  snapshotCount: number;
  totalBytes: number;
  scanMs: number;
}

export class MissingContentPacksError extends Error {
  constructor(readonly requirements: string[]) {
    super(`无法加载存档：${requirements.join("；")}`);
    this.name = "MissingContentPacksError";
  }
}

export type { LocalSaveStorageEstimate };
export { getLocalSaveStorageEstimate };

export interface SaveInspection {
  valid: boolean;
  repairable: boolean;
  integrity: SaveIntegrityStatus;
  formatVersion: number | null;
  stateVersion: number | null;
  savedAt: number | null;
  mode: SaveMode;
  slot: SaveSlotId | "main";
  checksum: "valid" | "missing" | "invalid";
  recordedChecksum: string | null;
  computedChecksum: string | null;
  issues: string[];
  state: GameState | null;
  summary: Omit<SaveSlotSummary, "slotId" | "integrity" | "valid" | "issues"> | null;
}

export interface ContinueSaveInspection {
  source: SaveRecovery["source"];
  inspection: SaveInspection;
}

function pruneSaveSummaryCache(keys: Iterable<string>, scope: "slots" | "snapshots" | "all" = "all"): void {
  const retained = new Set(keys);
  for (const key of saveSummaryCache.keys()) {
    const inScope = scope === "all" ||
      scope === "slots" && key.startsWith(`${SAVE_SLOT_KEY_PREFIX}.`) ||
      scope === "snapshots" && key.startsWith(`${SAVE_SNAPSHOT_KEY_PREFIX}.`);
    if (inScope && !retained.has(key)) saveSummaryCache.delete(key);
  }
}

function invalidateSaveSummaryCache(key: string): void {
  saveSummaryCache.delete(key);
}

function integerRecord(value: unknown): Partial<Record<ItemId, number>> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([key, amount]) => [
    key,
    Math.max(0, Math.floor(typeof amount === "number" ? amount : 0)),
  ])) as Partial<Record<ItemId, number>>;
}

function nonNegativeInteger(value: unknown): number {
  return Math.max(0, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : 0));
}

class UnsafePersistedQuantityError extends Error {
  constructor(readonly field: string, readonly value: unknown, readonly reason: "unsafe" | "invalid" = "unsafe") {
    super(reason === "unsafe" ? `${field} 超出 JavaScript 安全整数范围` : `${field} 不是合法的非负安全整数`);
    this.name = "UnsafePersistedQuantityError";
  }
}

function persistedNonNegativeInteger(value: unknown, field: string, allowLegacyFraction = false): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new UnsafePersistedQuantityError(field, value);
  }
  if (value < 0) throw new UnsafePersistedQuantityError(field, value, "invalid");
  if (!Number.isSafeInteger(value)) {
    if (allowLegacyFraction) return Math.floor(value);
    throw new UnsafePersistedQuantityError(field, value, "invalid");
  }
  return value;
}

function persistedPositiveInteger(value: unknown, field: string): number {
  const normalized = persistedNonNegativeInteger(value, field);
  if (normalized < 1) throw new UnsafePersistedQuantityError(field, value, "invalid");
  return normalized;
}

function buildingBufferRecord(value: unknown, allowLegacyFraction = false): Partial<Record<ItemId, number>> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, amount]) =>
    key in ITEMS ? [[key, persistedNonNegativeInteger(amount, `建筑缓存.${key}`, allowLegacyFraction)]] : [])) as Partial<Record<ItemId, number>>;
}

function constructionAutomationInventoryRecord(value: unknown): Partial<Record<ItemId, number>> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, amount]) =>
    key in ITEMS ? [[key, Math.min(Number.MAX_SAFE_INTEGER, nonNegativeInteger(amount))]] : [])) as Partial<Record<ItemId, number>>;
}

function nonNegativeNumber(value: unknown): number {
  return Math.max(0, typeof value === "number" && Number.isFinite(value) ? value : 0);
}

function fractionalRecord(value: unknown): Partial<Record<ItemId, number>> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([key, amount]) => [
    key,
    nonNegativeNumber(amount) % 1,
  ])) as Partial<Record<ItemId, number>>;
}

function nonNegativeRecord(value: unknown): Partial<Record<ItemId, number>> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, amount]) =>
    key in ITEMS ? [[key, nonNegativeNumber(amount)]] : [])) as Partial<Record<ItemId, number>>;
}

/**
 * A small synchronous checksum keeps save validation available in workers,
 * tests, and older browsers where Web Crypto may not be available yet.
 * It is an integrity check, not a security boundary.
 */
function legacyChecksumFor(formatVersion: number, state: unknown): string {
  let projected = state;
  // Achievement ids are an extensible registry. Ignore ids unknown to this
  // client so a newer export can still be imported and migrated safely.
  if (isRecord(state)) {
    const cloned = JSON.parse(JSON.stringify(state)) as Record<string, any>;
    projected = cloned;
    if (isRecord(cloned.achievements) && Array.isArray(cloned.achievements.unlockedIds)) {
      cloned.achievements.unlockedIds = cloned.achievements.unlockedIds.filter(isAchievementId);
    }
  }
  return computeSaveStateChecksum(formatVersion, projected);
}

function serializeEnvelopeProjection(
  state: GameState,
  savedAt = Date.now(),
  kind: SaveEnvelope["kind"] = "primary",
  reason?: string,
  contentPackRegistry: ContentPackRegistry = loadContentPackRegistry(),
  slot: SaveSlotId | "main" = "main",
): { raw: string; verification: SaveTransferVerification } {
  const persistent = prepareSaveStateForBackground(state, contentPackRegistry);
  const serialized = serializeSaveEnvelopeToTransfer(persistent, {
    formatVersion: SAVE_FORMAT_VERSION,
    kind,
    ...(reason ? { reason } : {}),
    savedAt,
    mode: saveModeForState(state),
    slot,
  });
  const verification: SaveTransferVerification = {
    integrity: serialized.integrity,
    stateChecksum: serialized.stateChecksum,
    payloadChecksum: serialized.payloadChecksum,
    byteLength: serialized.byteLength,
  };
  return { raw: decodeVerifiedSaveTransfer(serialized.bytes, verification), verification };
}

export function serializeEnvelope(
  state: GameState,
  savedAt = Date.now(),
  kind: SaveEnvelope["kind"] = "primary",
  reason?: string,
  contentPackRegistry: ContentPackRegistry = loadContentPackRegistry(),
  slot: SaveSlotId | "main" = "main",
): string {
  return serializeEnvelopeProjection(state, savedAt, kind, reason, contentPackRegistry, slot).raw;
}

export interface BackgroundSaveResult {
  raw: string;
  durationMs: number;
  usedWorker: boolean;
  summary?: CloudSaveSummary;
  verification: SaveTransferVerification;
}

let backgroundSaveRequestId = 0;

/**
 * Send one structured-cloned source snapshot to a short-lived Worker. Sparse
 * projection, checksum, serialization and byte verification all stay off the
 * UI thread; the synchronous serializer remains the compatibility fallback.
 */
export function serializeEnvelopeInWorker(
  state: GameState,
  savedAt = Date.now(),
  kind: SaveEnvelope["kind"] = "primary",
  reason?: string,
  slot: SaveSlotId | "main" = "main",
): Promise<BackgroundSaveResult> {
  if (typeof Worker === "undefined") {
    const startedAt = monotonicNow();
    const serialized = serializeEnvelopeProjection(state, savedAt, kind, reason, loadContentPackRegistry(), slot);
    return Promise.resolve({ ...serialized, durationMs: Math.max(0, monotonicNow() - startedAt), usedWorker: false });
  }
  const contentPackRegistry = loadContentPackRegistry();
  const id = ++backgroundSaveRequestId;
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./save.worker.ts", import.meta.url), { type: "module", name: "save-serialization" });
    } catch {
      const startedAt = monotonicNow();
      const serialized = serializeEnvelopeProjection(state, savedAt, kind, reason, loadContentPackRegistry(), slot);
      resolve({ ...serialized, durationMs: Math.max(0, monotonicNow() - startedAt), usedWorker: false });
      return;
    }
    let settled = false;
    const finish = (result: BackgroundSaveResult) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(result);
    };
    const fallback = () => {
      const startedAt = monotonicNow();
      const serialized = serializeEnvelopeProjection(state, savedAt, kind, reason, loadContentPackRegistry(), slot);
      finish({ ...serialized, durationMs: Math.max(0, monotonicNow() - startedAt), usedWorker: false });
    };
    worker.onerror = fallback;
    worker.onmessage = (event: MessageEvent<{ id: number; bytes?: ArrayBuffer; payloadChecksum?: string; byteLength?: number; durationMs?: number; summary?: CloudSaveSummary; error?: string }>) => {
      const { bytes, payloadChecksum, byteLength, summary } = event.data;
      if (event.data.id !== id || !(bytes instanceof ArrayBuffer) || !payloadChecksum || !summary?.stateChecksum ||
        summary.integrity !== "valid" || byteLength !== bytes.byteLength || event.data.error) {
        fallback();
        return;
      }
      const verification: SaveTransferVerification = {
        integrity: "valid",
        stateChecksum: summary.stateChecksum,
        payloadChecksum,
        byteLength,
      };
      let raw: string;
      try {
        raw = decodeVerifiedSaveTransfer(bytes, verification);
      } catch {
        fallback();
        return;
      }
      finish({ raw, verification, durationMs: Math.max(0, event.data.durationMs ?? 0), usedWorker: true, summary });
    };
    try {
      worker.postMessage({
        id,
        formatVersion: SAVE_FORMAT_VERSION,
        savedAt,
        kind,
        slot,
        ...(reason ? { reason } : {}),
        state,
        contentPackRegistry,
      });
    } catch {
      fallback();
    }
  });
}

function summaryForState(state: GameState): Omit<SaveSlotSummary, "slotId" | "integrity" | "valid" | "issues"> {
  return {
    mode: saveModeForState(state),
    savedAt: 0,
    elapsedSeconds: state.elapsedSeconds,
    completedTechCount: state.research.completedTechIds.length,
    structurePoints: state.dysonSphere.structurePoints,
    activePlanetId: state.activePlanetId,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const STARTER_TOTALS: Partial<Record<ConstructionId, number>> = {
  wind_turbine: 3,
  mining_machine: 2,
  arc_smelter: 3,
  assembling_machine_mk1: 3,
  matrix_lab: 2,
  conveyor_belt_mk1: 10,
};

function researchProgress(value: unknown): GameState["research"]["progressByTech"] {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([techId, progress]) => {
    if (typeof progress === "number") {
      return [techId, { electromagnetic_matrix: Math.max(0, Math.floor(progress)) }];
    }
    return [techId, integerRecord(progress)];
  })) as GameState["research"]["progressByTech"];
}

function deployedCount(entities: FactoryEntity[], buildingId: BuildingId): number {
  if (buildingId === "mining_machine" || buildingId === "oil_extractor" || buildingId === "water_pump") {
    return entities.reduce((sum, entity) => {
      if (entity.kind !== "vein" || entity.minerCount < 1) return sum;
      const extractorId = entity.extractorBuildingId ?? getExtractorBuildingId(entity.resourceId!);
      return sum + (extractorId === buildingId ? entity.minerCount : 0);
    }, 0);
  }
  return entities.reduce((sum, entity) =>
    sum + (entity.buildingId === buildingId ? entity.machineCount : 0), 0);
}

function validPlanetId(value: unknown): value is PlanetId {
  return typeof value === "string" && PLANET_LIST.some((planet) => planet.id === value);
}

function validStarSystemId(value: unknown): value is StarSystemId {
  return typeof value === "string" && value in STAR_SYSTEMS;
}

function validStationMinimumLoad(value: unknown): value is StationMinimumLoad {
  return value === 0.1 || value === 0.25 || value === 0.5 || value === 1;
}

function validStationMode(value: unknown): value is StationLogisticsMode {
  return value === "supply" || value === "demand" || value === "storage";
}

function validPriority(value: unknown): value is LogisticsPriority {
  return value === 0 || value === 1 || value === 2;
}

function validRoutePolicy(value: unknown): value is InterstellarRoutePolicy {
  return value === "direct" || value === "relay-preferred" || value === "relay-required";
}

function validCargoStackSize(value: unknown): value is CargoStackSize {
  return value === 1 || value === 2 || value === 4;
}

function validBeltRouteMode(value: unknown): value is BeltRouteMode {
  return value === "bezier" || value === "auto" || value === "upper" || value === "lower" || value === "manual";
}

function routeOffset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(-600, Math.min(600, Math.round(value)))
    : undefined;
}

function validBlueprintRotation(value: unknown): value is BlueprintRotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

function validBlueprintMirror(value: unknown): value is BlueprintMirror {
  return value === "none" || value === "horizontal";
}

function normalizeStationSlots(entity: FactoryEntity): StationSlot[] | undefined {
  if (entity.kind !== "station" || entity.buildingId === "orbital_collector") return undefined;
  const slots: StationSlot[] = Array.isArray(entity.stationSlots)
    ? entity.stationSlots.slice(0, STATION_SLOT_COUNT).map((slot) => ({
      itemId: slot?.itemId && ITEMS[slot.itemId] ? slot.itemId : undefined,
      localMode: validStationMode(slot?.localMode) ? slot.localMode : "storage",
      remoteMode: validStationMode(slot?.remoteMode) ? slot.remoteMode : "storage",
      minimumLoad: validStationMinimumLoad(slot?.minimumLoad) ? slot.minimumLoad : 1,
      minStock: Math.min(100_000_000, nonNegativeInteger(slot?.minStock)),
      maxStock: Math.min(100_000_000, nonNegativeInteger(slot?.maxStock)),
      priority: validPriority(slot?.priority) ? slot.priority : 1,
      routePolicy: validRoutePolicy(slot?.routePolicy) ? slot.routePolicy : "relay-preferred",
      warperBudget: Math.max(1, Math.min(4, nonNegativeInteger(slot?.warperBudget) || 2)),
    }))
    : [];
  if (slots.length === 0 && entity.storedItemId && ITEMS[entity.storedItemId]) {
    const legacyMode: StationLogisticsMode = entity.stationMode === "demand" ? "demand" : "supply";
    slots.push({
      itemId: entity.storedItemId,
      localMode: entity.buildingId === "planetary_logistics_station" ? legacyMode : "storage",
      remoteMode: entity.buildingId === "interstellar_logistics_station" ? legacyMode : "storage",
      minimumLoad: validStationMinimumLoad(entity.stationMinimumLoad) ? entity.stationMinimumLoad : 1,
      minStock: 0,
      maxStock: 0,
      priority: 1,
      routePolicy: "relay-preferred",
      warperBudget: 2,
    });
  }
  while (slots.length < STATION_SLOT_COUNT) {
    slots.push({ localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "relay-preferred", warperBudget: 2 });
  }
  const seen = new Set<ItemId>();
  return slots.map((slot) => {
    if (!slot.itemId || seen.has(slot.itemId)) return { ...slot, itemId: undefined };
    seen.add(slot.itemId);
    return slot;
  });
}

function normalizeStationRoutes(entity: FactoryEntity): StationRoute[] | undefined {
  if (entity.kind !== "station" || entity.buildingId === "orbital_collector") return undefined;
  if (!Array.isArray(entity.stationRoutes)) return [];
  return entity.stationRoutes.flatMap((route) => {
    if (!route || typeof route.id !== "string" || !ITEMS[route.itemId] ||
      (route.scope !== "local" && route.scope !== "remote") || typeof route.peerId !== "string") return [];
    return [{
      id: route.id,
      slotIndex: Math.min(STATION_SLOT_COUNT - 1, nonNegativeInteger(route.slotIndex)),
      peerId: route.peerId,
      itemId: route.itemId,
      scope: route.scope,
      cargo: persistedNonNegativeInteger(route.cargo, `物流航线 ${route.id ?? "未知"}.cargo`),
      vehicleCount: Math.max(1, nonNegativeInteger(route.vehicleCount)),
      progress: Math.min(1, nonNegativeNumber(route.progress)),
      duration: Math.max(1, nonNegativeNumber(route.duration)),
      requiresWarp: Boolean(route.requiresWarp),
      waypointStationIds: Array.isArray(route.waypointStationIds)
        ? route.waypointStationIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 3)
        : [],
      distanceLy: nonNegativeNumber(route.distanceLy),
      warpersPerVessel: Math.max(route.requiresWarp ? 1 : 0, nonNegativeInteger(route.warpersPerVessel)),
      vehicleStationId: typeof route.vehicleStationId === "string" && route.vehicleStationId.length > 0
        ? route.vehicleStationId
        : undefined,
    } satisfies StationRoute];
  });
}

function validBeltTier(value: unknown): value is BeltTier {
  return isRegisteredBeltTier(value);
}

function validProliferatorTier(value: unknown): value is ProliferatorTier {
  return value === 1 || value === 2 || value === 3;
}

function validProliferatorMode(value: unknown): value is ProliferatorMode {
  return value === "normal" || value === "extra" || value === "speed";
}

function validEnergyMode(value: unknown): value is EnergyMode {
  return value === "auto" || value === "charge" || value === "discharge";
}

function validPowerGridId(value: unknown): value is PowerGridId {
  return value === "grid-a" || value === "grid-b" || value === "grid-c";
}

function validPowerPriority(value: unknown): value is PowerPriority {
  return value === 1 || value === 2 || value === 3;
}

function validDysonLaunchMode(value: unknown): value is DysonLaunchMode {
  return value === "balanced" || value === "swarm" || value === "sphere";
}

function validDysonLaunchThrottle(value: unknown): value is DysonLaunchThrottle {
  return value === 0.25 || value === 0.5 || value === 0.75 || value === 1;
}

function validInfiniteResearchId(value: unknown): value is InfiniteResearchId {
  return value === "matrix_compression" || value === "vein_utilization" || value === "galactic_logistics" ||
    value === "stellar_harnessing" || value === "continuum_simulation";
}

function validGalacticExportProjectId(value: unknown): value is GalacticExportProjectId {
  return value === "universe_archive" || value === "solar_sail_array" || value === "carrier_rocket_fleet" || value === "antimatter_exchange";
}

function validDispatchThrottle(value: unknown): value is GalacticDispatchThrottle {
  return value === 0.25 || value === 0.5 || value === 1;
}

function migrateEndgame(saved: Record<string, any>): EndgameState {
  const defaults = createEndgameState();
  const raw = saved.endgame && typeof saved.endgame === "object" ? saved.endgame : {};
  const infiniteResearch = { ...defaults.infiniteResearch } as EndgameState["infiniteResearch"];
  let migrationScore = 0;
  for (const researchId of Object.keys(defaults.infiniteResearch) as InfiniteResearchId[]) {
    const source = raw.infiniteResearch?.[researchId];
    const originalLevel = nonNegativeInteger(source?.level);
    const originalHistoricalLevel = nonNegativeInteger(source?.historicalLevel);
    const maximumLevel = getInfiniteResearchMaximumLevel(researchId);
    let level = Math.min(maximumLevel, originalLevel);
    let progress = normalizeDecimalIntegerString(source?.progress, "0", 64);
    if (saved.version < 33) {
      let remaining = BigInt(progress);
      let guard = 0;
      while (level < maximumLevel && guard++ < maximumLevel) {
        const cost = getInfiniteResearchCostBigInt(researchId, level);
        if (remaining < cost) break;
        remaining -= cost;
        level += 1;
        migrationScore += 1_000 + level * 250;
      }
      progress = remaining.toString();
    }
    infiniteResearch[researchId] = {
      level,
      progress,
      ...(Math.max(originalLevel, originalHistoricalLevel) > level
        ? { historicalLevel: Math.max(originalLevel, originalHistoricalLevel) }
        : {}),
    };
  }
  const exportProjects = { ...defaults.exportProjects } as EndgameState["exportProjects"];
  for (const projectId of Object.keys(defaults.exportProjects) as GalacticExportProjectId[]) {
    const source = raw.exportProjects?.[projectId];
    const priority = validPriority(source?.priority) ? source.priority : 1;
    exportProjects[projectId] = {
      ...defaults.exportProjects[projectId],
      id: projectId,
      enabled: typeof source?.enabled === "boolean" ? source.enabled : false,
      priority,
      level: nonNegativeInteger(source?.level),
      delivered: nonNegativeInteger(source?.delivered),
      totalDelivered: nonNegativeInteger(source?.totalDelivered),
      dispatchProgress: Math.min(2_000_000_000, nonNegativeNumber(source?.dispatchProgress)),
    };
  }
  const activityMaterialIds: readonly ActivityMaterialId[] = ACTIVITY_MATERIAL_IDS;
  const normalizeActivityAmounts = (value: unknown) => Object.fromEntries(activityMaterialIds.map((itemId) => [
    itemId,
    nonNegativeInteger(value && typeof value === "object" ? (value as Record<string, unknown>)[itemId] : 0),
  ])) as Record<ActivityMaterialId, number>;
  const rawActivity = raw.constructionActivity && typeof raw.constructionActivity === "object" ? raw.constructionActivity : {};
  const pendingBatches: EndgameState["constructionActivity"]["pendingBatches"] = {};
  for (const itemId of activityMaterialIds) {
    const batch = rawActivity.pendingBatches?.[itemId];
    if (!batch || typeof batch !== "object" || typeof batch.id !== "string") continue;
    pendingBatches[itemId] = {
      id: batch.id.slice(0, 180),
      itemId,
      amount: nonNegativeInteger(batch.amount),
      sequence: nonNegativeInteger(batch.sequence),
      firstDeliveredAtMs: nonNegativeNumber(batch.firstDeliveredAtMs),
      lastDeliveredAtMs: nonNegativeNumber(batch.lastDeliveredAtMs),
    };
  }
  const serverTimeAnchorMs = nonNegativeNumber(rawActivity.serverTimeAnchorMs);
  const savedActivityClockMs = nonNegativeNumber(rawActivity.activityClockMs);
  const activity = {
    ...defaults.constructionActivity,
    activityId: typeof rawActivity.activityId === "string" ? rawActivity.activityId.slice(0, 120) : null,
    participantId: typeof rawActivity.participantId === "string" ? rawActivity.participantId.slice(0, 120) : null,
    configRevision: typeof rawActivity.configRevision === "string" ? rawActivity.configRevision.slice(0, 120) : null,
    startsAtMs: nonNegativeNumber(rawActivity.startsAtMs),
    endsAtMs: saved.version < 40 && typeof rawActivity.activityId === "string" && rawActivity.activityId
      ? Number.MAX_SAFE_INTEGER
      : nonNegativeNumber(rawActivity.endsAtMs),
    serverTimeAnchorMs,
    activityClockMs: saved.version < 34 && serverTimeAnchorMs > 0
      ? serverTimeAnchorMs
      : Math.max(serverTimeAnchorMs, savedActivityClockMs),
    personalTargets: normalizeActivityAmounts(rawActivity.personalTargets),
    globalTargets: normalizeActivityAmounts(rawActivity.globalTargets),
    personalDelivered: normalizeActivityAmounts(rawActivity.personalDelivered),
    pendingBatches,
    nextBatchSequence: nonNegativeInteger(rawActivity.nextBatchSequence),
  } satisfies EndgameState["constructionActivity"];
  const requestedInfiniteResearchId: InfiniteResearchId | null = validInfiniteResearchId(raw.activeInfiniteResearchId)
    ? raw.activeInfiniteResearchId as InfiniteResearchId
    : null;
  const activeInfiniteResearchId = requestedInfiniteResearchId &&
      (saved.research?.completedTechIds ?? []).includes("universe_matrix") &&
      infiniteResearch[requestedInfiniteResearchId].level < getInfiniteResearchMaximumLevel(requestedInfiniteResearchId)
      ? requestedInfiniteResearchId
      : null;
  return {
    ...defaults,
    activeInfiniteResearchId,
    autoResearch: typeof raw.autoResearch === "boolean" ? raw.autoResearch : true,
    autoDispatch: typeof raw.autoDispatch === "boolean" ? raw.autoDispatch : true,
    dispatchThrottle: validDispatchThrottle(raw.dispatchThrottle) ? raw.dispatchThrottle : 1,
    exportProjects,
    galacticCredits: nonNegativeInteger(raw.galacticCredits),
    galacticScore: nonNegativeInteger(raw.galacticScore) + migrationScore,
    totalExported: nonNegativeInteger(raw.totalExported),
    exportedLastMinute: nonNegativeNumber(raw.exportedLastMinute),
    exportWindowAmount: nonNegativeInteger(raw.exportWindowAmount),
    exportWindowStartedAt: nonNegativeNumber(raw.exportWindowStartedAt),
    infiniteResearch,
    exportInputMode: raw.exportInputMode === "legacy-network"
      ? "legacy-network"
      : raw.exportInputMode === "building" || saved.version >= 33 ? "building" : "legacy-network",
    constructionActivity: activity,
  };
}

function defaultDysonOrbit(systemId: StarSystemId, index = 0): DysonSwarmOrbitState {
  return {
    id: `dyson_orbit_${systemId}_${index + 1}`,
    name: `太阳帆轨道 ${String.fromCharCode(65 + index)}`,
    radius: 12_000 + index * 6_000,
    inclination: index * 12,
    longitude: index * 45,
    sailsInOrbit: 0,
    totalLaunched: 0,
    totalExpired: 0,
    decayProgress: 0,
    generationKw: 0,
  };
}

function validSimulationSpeed(value: unknown): value is GameState["settings"]["simulationSpeed"] {
  return value === 1 || value === 2 || value === 4;
}

function validFontScale(value: unknown): value is GameState["settings"]["fontScale"] {
  return value === 0.8 || value === 1 || value === 1.25 || value === 1.5 || value === 2;
}

function validAutosaveInterval(value: unknown): value is GameState["settings"]["autosaveIntervalSeconds"] {
  return value === 0 || value === 30 || value === 60 || value === 120 || value === 600 || value === 1800;
}

function validDefaultBeltRouteMode(value: unknown): value is GameState["settings"]["defaultBeltRouteMode"] {
  return value === "auto" || value === "bezier" || value === "upper" || value === "lower";
}

function normalizedBuildingBufferLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1_000_000;
  return Math.max(1_000, Math.min(100_000_000, Math.floor(value)));
}

function normalizedProliferatorBufferLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 600;
  return Math.max(1, Math.min(100_000, Math.floor(value)));
}

function inferLegacyPlanet(entity: FactoryEntity): PlanetId {
  if (entity.id.startsWith("ashen_")) return "ashen";
  if (entity.resourceId === "silicon_ore" || entity.resourceId === "titanium_ore") return "ashen";
  if (entity.kind !== "vein" && entity.position?.x < -650) return "ashen";
  return "home";
}

function normalizeMaterialDeliverySlots(entity: FactoryEntity, savedVersion: number): MaterialDeliverySlot[] {
  const legacyItems = [...new Set((Array.isArray(entity.deliveryItemIds) ? entity.deliveryItemIds : [])
    .filter((itemId): itemId is ItemId => typeof itemId === "string" && itemId in ITEMS))].slice(0, 3);
  return Array.from({ length: 3 }, (_, index): MaterialDeliverySlot => {
    const raw = savedVersion >= 39 && Array.isArray(entity.deliverySlots) ? entity.deliverySlots[index] : undefined;
    if (raw?.mode === "disabled") return { itemId: null, mode: "disabled" };
    if (raw?.mode === "manual" && raw.itemId && raw.itemId in ITEMS) return { itemId: raw.itemId, mode: "manual" };
    if (raw?.mode === "auto") return { itemId: raw.itemId && raw.itemId in ITEMS ? raw.itemId : null, mode: "auto" };
    return { itemId: legacyItems[index] ?? null, mode: "auto" };
  });
}

function normalizeHubIntegerRecord(value: unknown): Partial<Record<ItemId, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([itemId, amount]) => {
    if (!(itemId in ITEMS)) return [];
    const normalized = normalizeHubInteger(amount);
    return normalized.length <= SYSTEM_HUB_MAX_DIGITS ? [[itemId, normalized]] : [];
  })) as Partial<Record<ItemId, string>>;
}

function normalizeSystemSpaceStations(saved: Record<string, any>): Partial<Record<StarSystemId, SystemSpaceStationState>> {
  const defaults = createEmptySystemSpaceStations();
  const rawStations = saved.version >= 43 && saved.systemSpaceStations && typeof saved.systemSpaceStations === "object"
    ? saved.systemSpaceStations
    : {};
  for (const systemId of Object.keys(defaults) as StarSystemId[]) {
    const fallback = defaults[systemId]!;
    const raw = rawStations[systemId];
    if (!raw || typeof raw !== "object") continue;
    const policies = raw.itemPolicies && typeof raw.itemPolicies === "object" && !Array.isArray(raw.itemPolicies)
      ? Object.fromEntries(Object.entries(raw.itemPolicies).flatMap(([itemId, policy]) => {
        if (!(itemId in ITEMS) || !policy || typeof policy !== "object") return [];
        return [[itemId, {
          interstellarEnabled: Boolean((policy as any).interstellarEnabled),
          reserve: normalizeHubInteger((policy as any).reserve),
          target: normalizeHubInteger((policy as any).target),
        }]];
      }))
      : {};
    const modules = raw.modules && typeof raw.modules === "object" ? raw.modules : {};
    const viewport = raw.viewport && typeof raw.viewport === "object" ? raw.viewport : {};
    defaults[systemId] = {
      ...fallback,
      status: raw.status === "building" || raw.status === "operational" ? raw.status : "not-started",
      costRevision: Number.isSafeInteger(raw.costRevision) ? Math.max(0, raw.costRevision) : 0,
      costMultiplierBasisPoints: raw.costMultiplierBasisPoints === 8_000 || raw.costMultiplierBasisPoints === 9_000 ? raw.costMultiplierBasisPoints : 10_000,
      phaseIndex: Number.isSafeInteger(raw.phaseIndex) ? Math.max(0, Math.min(16, raw.phaseIndex)) : 0,
      delivered: normalizeHubIntegerRecord(raw.delivered),
      constructionBuffer: normalizeHubIntegerRecord(raw.constructionBuffer),
      inventory: normalizeHubIntegerRecord(raw.inventory),
      itemPolicies: policies,
      modules: {
        backbone: Number.isSafeInteger(modules.backbone) ? Math.max(0, Math.min(1_000_000, modules.backbone)) : 0,
        energy: Number.isSafeInteger(modules.energy) ? Math.max(0, Math.min(1_000_000, modules.energy)) : 0,
        interstellar: Number.isSafeInteger(modules.interstellar) ? Math.max(0, Math.min(1_000_000, modules.interstellar)) : 0,
      },
      routingCursors: raw.routingCursors && typeof raw.routingCursors === "object"
        ? Object.fromEntries(Object.entries(raw.routingCursors).flatMap(([key, value]) => typeof value === "number" && Number.isSafeInteger(value) ? [[key.slice(0, 160), Math.max(0, value)]] : []))
        : {},
      viewport: {
        x: Number.isFinite(viewport.x) ? viewport.x : fallback.viewport.x,
        y: Number.isFinite(viewport.y) ? viewport.y : fallback.viewport.y,
        zoom: Number.isFinite(viewport.zoom) ? Math.max(0.1, Math.min(4, viewport.zoom)) : fallback.viewport.zoom,
      },
      decorations: Array.isArray(raw.decorations) ? raw.decorations.slice(0, 256).flatMap((decoration: any, index: number) =>
        decoration && typeof decoration === "object" && (decoration.kind === "marker" || decoration.kind === "label") &&
        Number.isFinite(decoration.position?.x) && Number.isFinite(decoration.position?.y)
          ? [{ id: typeof decoration.id === "string" && decoration.id ? decoration.id.slice(0, 160) : `station_decoration_${index}`, kind: decoration.kind, position: { x: decoration.position.x, y: decoration.position.y }, ...(typeof decoration.text === "string" ? { text: decoration.text.slice(0, 120) } : {}) }]
          : []) : [],
    };
  }
  return defaults;
}

function normalizeGalacticHubNetwork(saved: Record<string, any>): GalacticHubNetworkState {
  const fallback = createEmptyGalacticHubNetwork();
  const raw = saved.version >= 43 && saved.galacticHubNetwork && typeof saved.galacticHubNetwork === "object" ? saved.galacticHubNetwork : {};
  const fleetReturns = Array.isArray(raw.fleetReturns) ? raw.fleetReturns.slice(0, 4096).flatMap((bucket: any) =>
    bucket && typeof bucket.routeKey === "string" && bucket.routeKey.length <= 160 && Number.isSafeInteger(bucket.returnAtSecond) &&
    Number.isSafeInteger(bucket.vesselCount) && bucket.returnAtSecond >= 0 && bucket.vesselCount > 0
      ? [{ routeKey: bucket.routeKey, returnAtSecond: bucket.returnAtSecond, vesselCount: bucket.vesselCount }] : []) : [];
  return {
    fleetInstalled: Number.isSafeInteger(raw.fleetInstalled) ? Math.max(0, Math.min(1_000_000_000, raw.fleetInstalled)) : fallback.fleetInstalled,
    fleetBusy: Number.isSafeInteger(raw.fleetBusy) ? Math.max(0, Math.min(1_000_000_000, raw.fleetBusy)) : fallback.fleetBusy,
    fleetReturns,
    warpers: normalizeHubInteger(raw.warpers),
    warperTarget: normalizeHubInteger(raw.warperTarget),
    routingCursors: raw.routingCursors && typeof raw.routingCursors === "object"
      ? Object.fromEntries(Object.entries(raw.routingCursors).flatMap(([key, value]) => typeof value === "number" && Number.isSafeInteger(value) ? [[key.slice(0, 160), Math.max(0, value)]] : []))
      : fallback.routingCursors,
  };
}

export function migrateGame(value: unknown, contentPackRegistry: ContentPackRegistry = loadContentPackRegistry()): GameState | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Record<string, any>;
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46].includes(saved.version) || !Array.isArray(saved.entities)) return null;
  // v43 was an unpublished space-station/elevator experiment. Never merge
  // its station inventory or fleet into the quantum pool. A v43 envelope that
  // actually contains those fields is rejected; a clean v43 fixture can still
  // be normalized to the quantum version without carrying the old state.
  if (saved.version === 43) {
    const stationMap = saved.systemSpaceStations && typeof saved.systemSpaceStations === "object" ? Object.values(saved.systemSpaceStations) : [];
    const hasActiveStation = stationMap.some((station: any) => station && station.status && station.status !== "not-started");
    const hub = saved.galacticHubNetwork && typeof saved.galacticHubNetwork === "object" ? saved.galacticHubNetwork : {};
    const hasHubAssets = Number(hub.fleetInstalled ?? 0) > 0 || Number(hub.fleetBusy ?? 0) > 0 || normalizeQuantumInteger(hub.warpers) !== "0";
    const hasElevatorEntity = saved.entities.some((entity: any) => entity?.stationTier === 2 || entity?.stationOperationMode === "elevator" || entity?.stationModeTransition);
    if (hasActiveStation || hasHubAssets || hasElevatorEntity) return null;
  }
  const requiredPacks = saved.version >= 40 && Array.isArray(saved.contentPacks)
    ? saved.contentPacks.filter((entry: unknown) => entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" && typeof (entry as { version?: unknown }).version === "string") as Array<{ id: string; version: string }>
    : [];
  const missingPacks = getMissingContentPackRequirements(requiredPacks, contentPackRegistry);
  if (missingPacks.length > 0) throw new MissingContentPacksError(missingPacks);
  const savedSeed = saved.version >= 20 && typeof saved.galaxy?.seed === "number" && Number.isFinite(saved.galaxy.seed)
    ? saved.galaxy.seed
    : DEFAULT_GALAXY_SEED;
  const initial = createInitialState(savedSeed, saved.version < 20);
  const galaxy = normalizeGalaxyState(saved.version >= 20 ? saved.galaxy : { seed: initial.galaxy.seed }, saved.version < 20);
  const entities = saved.entities.map((entity: FactoryEntity) => {
    // `quantumTarget` was briefly written to every building by an older
    // client. Keep it only for interstellar stations; ordinary buildings
    // must not carry the extension back into the next cloud save.
    const { quantumTarget: _legacyQuantumTarget, ...entityWithoutLegacyQuantumTarget } = entity;
    const currentResource = saved.version < 13
      ? initial.entities.find((candidate) => candidate.kind === "vein" && candidate.id === entity.id)
      : undefined;
    const legacyRelocation = currentResource
      ? { planetId: currentResource.planetId, position: currentResource.position }
      : undefined;
    const planetId = legacyRelocation?.planetId ?? (validPlanetId(entity.planetId) ? entity.planetId : inferLegacyPlanet(entity));
    const position = {
      x: typeof entity.position?.x === "number" && Number.isFinite(entity.position.x) ? entity.position.x : 0,
      y: typeof entity.position?.y === "number" && Number.isFinite(entity.position.y) ? entity.position.y : 0,
    };
    if (legacyRelocation) Object.assign(position, legacyRelocation.position);
    const sprayCoaterInstalled = Boolean(entity.sprayCoaterInstalled);
    const planetaryStation = entity.buildingId === "planetary_logistics_station";
    const interstellarStation = entity.buildingId === "interstellar_logistics_station";
    const orbitalCollector = entity.buildingId === "orbital_collector";
    const accumulator = entity.buildingId === "accumulator";
    const energyExchanger = entity.buildingId === "energy_exchanger";
    const materialDeliveryHub = entity.buildingId === "material_delivery_hub";
    const deliverySlots = materialDeliveryHub ? normalizeMaterialDeliverySlots(entity, saved.version) : undefined;
    const blackHoleConnector = entity.buildingId === "micro_black_hole_connector";
    const machineCount = persistedNonNegativeInteger(entity.machineCount, `实体 ${entity.id ?? "未知"}.machineCount`);
    const minerCount = persistedNonNegativeInteger(entity.minerCount, `实体 ${entity.id ?? "未知"}.minerCount`);
    const storedEnergyCapacity = accumulator || energyExchanger
      ? (getBuilding(entity.buildingId!).energyCapacityMj ?? 0) * machineCount
      : 0;
    const resourceId = entity.kind === "vein" && entity.resourceId && ITEMS[entity.resourceId] ? entity.resourceId : undefined;
    const generatedReserve = resourceId ? createVeinReserve(galaxy, planetId, resourceId, entity.id) : undefined;
    if (saved.version < 4 && position.x < -650 && (planetId === "ashen" || entity.resourceId === "water")) {
      position.x += 640;
    }
    return {
      ...entityWithoutLegacyQuantumTarget,
      planetId,
      position,
      interactionLocked: saved.version >= 35 && entity.interactionLocked === true,
      inputs: buildingBufferRecord(entity.inputs, saved.version <= 1),
      outputs: buildingBufferRecord(entity.outputs, saved.version <= 1),
      machineCount,
      minerCount,
      progress: typeof entity.progress === "number" ? Math.max(0, entity.progress) : 0,
      fuelRemainingMj: typeof entity.fuelRemainingMj === "number" ? Math.max(0, entity.fuelRemainingMj) : 0,
      powerOutputKw: typeof entity.powerOutputKw === "number" ? Math.max(0, entity.powerOutputKw) : 0,
      powerInputKw: typeof entity.powerInputKw === "number" ? Math.max(0, entity.powerInputKw) : 0,
      powerFactor: typeof entity.powerFactor === "number" && Number.isFinite(entity.powerFactor)
        ? Math.max(0, Math.min(1, entity.powerFactor))
        : undefined,
      storedEnergyMj: accumulator || energyExchanger ? Math.min(storedEnergyCapacity, nonNegativeNumber(entity.storedEnergyMj)) : undefined,
      energyMode: accumulator ? "auto" : energyExchanger
        ? validEnergyMode(entity.energyMode) && entity.energyMode !== "auto" ? entity.energyMode : "charge"
        : undefined,
      powerGridId: validPowerGridId(entity.powerGridId) ? entity.powerGridId : "grid-a",
      powerPriority: validPowerPriority(entity.powerPriority) ? entity.powerPriority : 2,
      generationPriority: validPowerPriority(entity.generationPriority) ? entity.generationPriority : undefined,
      resourceCapacity: resourceId && !isInfiniteResource(resourceId, planetId, saved.version >= 20 && saved.settings?.resourceMode === "finite" ? "finite" : "infinite", galaxy)
        ? Math.max(1, nonNegativeInteger(entity.resourceCapacity) || generatedReserve || 1)
        : undefined,
      resourceRemaining: resourceId && !isInfiniteResource(resourceId, planetId, saved.version >= 20 && saved.settings?.resourceMode === "finite" ? "finite" : "infinite", galaxy)
        ? Math.min(
          Math.max(1, nonNegativeInteger(entity.resourceCapacity) || generatedReserve || 1),
          typeof entity.resourceRemaining === "number" && Number.isFinite(entity.resourceRemaining) && entity.resourceRemaining >= 0
            ? nonNegativeInteger(entity.resourceRemaining)
            : generatedReserve || 1,
        )
        : undefined,
      resourceDepletionRemainder: resourceId && ITEMS[resourceId].kind === "solid"
        ? saved.version >= 37 ? Math.min(9, nonNegativeInteger(entity.resourceDepletionRemainder)) : 0
        : undefined,
      recipeId: energyExchanger
        ? entity.energyMode === "discharge" ? "accumulator_discharge" : "accumulator_charge"
        : entity.recipeId,
      targetDysonOrbitId: entity.buildingId === "em_rail_ejector" && saved.version >= 41 &&
        typeof entity.targetDysonOrbitId === "string" && entity.targetDysonOrbitId.length > 0 && entity.targetDysonOrbitId.length <= 160
        ? entity.targetDysonOrbitId
        : undefined,
      routingCursor: Math.max(0, Math.floor(entity.routingCursor ?? 0)),
      distributionMode: entity.kind === "splitter" ? entity.distributionMode ?? "balanced" : entity.distributionMode,
      storedItemId: orbitalCollector
        ? entity.storedItemId && (getPlanetOrbitalYields({ galaxy }, planetId)[entity.storedItemId] ?? 0) > 0 ? entity.storedItemId : "hydrogen"
        : entity.storedItemId,
      deliveryItemIds: materialDeliveryHub
        ? [...new Set(deliverySlots!.flatMap((slot) => slot.itemId ? [slot.itemId] : []))]
        : undefined,
      deliverySlots,
      stationMode: entity.kind === "station" ? orbitalCollector ? "supply" : entity.stationMode ?? "supply" : entity.stationMode,
      stationTier: interstellarStation ? saved.version >= 43 && entity.stationTier === 2 ? 2 : 1 : undefined,
      stationOperationMode: interstellarStation && saved.version >= 43 && entity.stationTier === 2 && entity.stationOperationMode === "elevator" ? "elevator" : interstellarStation ? "legacy" : undefined,
      stationModeTransition: interstellarStation
        ? saved.version >= 43 && (entity.stationModeTransition === "to-elevator" || entity.stationModeTransition === "to-legacy") ? entity.stationModeTransition : null
        : undefined,
      quantumMode: (interstellarStation && saved.version >= 44 || orbitalCollector && saved.version >= 45) &&
        (entity.quantumMode === "legacy" || entity.quantumMode === "transitioning" || entity.quantumMode === "quantum")
        ? entity.quantumMode
        : interstellarStation || orbitalCollector ? "legacy" : undefined,
      quantumTransition: (interstellarStation && saved.version >= 44 || orbitalCollector && saved.version >= 45) && entity.quantumTransition && typeof entity.quantumTransition === "object"
        ? {
          targetMode: entity.quantumTransition.targetMode === "legacy" ? "legacy" : "quantum",
          startedAtSecond: nonNegativeNumber(entity.quantumTransition.startedAtSecond),
          boundarySecond: Math.max(0, nonNegativeNumber(entity.quantumTransition.boundarySecond)),
          bridges: Array.isArray(entity.quantumTransition.bridges)
            ? entity.quantumTransition.bridges.slice(0, 256).flatMap((bridge: any) => {
              if (!bridge || typeof bridge.id !== "string" || typeof bridge.itemId !== "string" || !(bridge.itemId as ItemId in ITEMS)) return [];
              return [{
                id: bridge.id.slice(0, 160),
                itemId: bridge.itemId as ItemId,
                sourceStationId: typeof bridge.sourceStationId === "string" ? bridge.sourceStationId.slice(0, 160) : "",
                targetStationId: typeof bridge.targetStationId === "string" ? bridge.targetStationId.slice(0, 160) : "",
                cargo: normalizeQuantumInteger(bridge.cargo),
                remainingCargo: normalizeQuantumInteger(bridge.remainingCargo),
                arriveAtSecond: nonNegativeNumber(bridge.arriveAtSecond),
              }];
            })
            : [],
        }
        : null,
      ...(interstellarStation ? { quantumTarget: entity.quantumTarget === true } : {}),
      elevatorOutputItems: interstellarStation && saved.version >= 43 && Array.isArray(entity.elevatorOutputItems)
        ? Array.from({ length: 5 }, (_, index) => {
          const itemId = (entity.elevatorOutputItems as unknown[])[index];
          return typeof itemId === "string" && itemId in ITEMS ? itemId as ItemId : null;
        })
        : interstellarStation ? [null, null, null, null, null] : undefined,
      stationProgress: entity.kind === "station" ? Math.max(0, entity.stationProgress ?? 0) : entity.stationProgress,
      stationTrips: entity.kind === "station" ? Math.max(0, Math.floor(entity.stationTrips ?? 0)) : entity.stationTrips,
      stationLastTransfer: entity.kind === "station" ? Math.max(0, Math.floor(entity.stationLastTransfer ?? 0)) : entity.stationLastTransfer,
      stationDrones: planetaryStation || interstellarStation ? nonNegativeInteger(entity.stationDrones) : undefined,
      stationVessels: interstellarStation
        ? saved.version < 5 ? 1 : Math.max(0, Math.floor(entity.stationVessels ?? 0))
        : undefined,
      stationWarpers: interstellarStation ? nonNegativeInteger(entity.stationWarpers) : undefined,
      stationWarpEnabled: interstellarStation ? entity.stationWarpEnabled !== false : undefined,
      stationWarperAutoRefill: interstellarStation ? saved.version >= 30 && Boolean(entity.stationWarperAutoRefill) : undefined,
      stationWarperTarget: interstellarStation
        ? Math.max(1, Math.min(
          STATION_WARPER_CAPACITY_PER_BUILDING * Math.max(1, nonNegativeInteger(entity.machineCount)),
          saved.version >= 30 ? nonNegativeInteger(entity.stationWarperTarget) || DEFAULT_STATION_WARPER_TARGET : DEFAULT_STATION_WARPER_TARGET,
        ))
        : undefined,
      stationHubEnabled: interstellarStation ? Boolean(entity.stationHubEnabled) : undefined,
      stationHubPriority: interstellarStation && validPriority(entity.stationHubPriority) ? entity.stationHubPriority : interstellarStation ? 1 : undefined,
      stationMinimumLoad: entity.kind === "station"
        ? validStationMinimumLoad(entity.stationMinimumLoad) ? entity.stationMinimumLoad : 1
        : entity.stationMinimumLoad,
      stationSlots: normalizeStationSlots(entity),
      stationRoutes: normalizeStationRoutes(entity),
      stationDispatchCursor: entity.kind === "station" ? nonNegativeInteger(entity.stationDispatchCursor) : undefined,
      stationLastSupplyPeerBySlot: entity.kind === "station" && entity.stationLastSupplyPeerBySlot && typeof entity.stationLastSupplyPeerBySlot === "object"
        ? Object.fromEntries(Object.entries(entity.stationLastSupplyPeerBySlot).flatMap(([key, peerId]) =>
          /^(local|remote):[0-4]$/.test(key) && typeof peerId === "string" && peerId.length <= 160 ? [[key, peerId]] : []))
        : undefined,
      stationCongestion: entity.kind === "station" ? Math.min(1, nonNegativeNumber(entity.stationCongestion)) : undefined,
      sprayCoaterInstalled,
      proliferatorTier: sprayCoaterInstalled
        ? validProliferatorTier(entity.proliferatorTier) ? entity.proliferatorTier : 1
        : undefined,
      proliferatorMode: sprayCoaterInstalled
        ? validProliferatorMode(entity.proliferatorMode) ? entity.proliferatorMode : "normal"
        : undefined,
      proliferatorPoints: sprayCoaterInstalled ? nonNegativeInteger(entity.proliferatorPoints) : 0,
      proliferatorBonusProgress: sprayCoaterInstalled ? fractionalRecord(entity.proliferatorBonusProgress) : {},
      galacticExporterPaused: entity.buildingId === "galactic_material_exporter" ? entity.galacticExporterPaused !== false : undefined,
      blackHolePaused: blackHoleConnector ? entity.blackHolePaused !== false : undefined,
      blackHoleActivationConfirmed: blackHoleConnector ? Boolean(entity.blackHoleActivationConfirmed) : undefined,
      blackHolePorts: blackHoleConnector ? ([0, 1, 2] as const).map((index) => {
        const rawPort = Array.isArray(entity.blackHolePorts)
          ? entity.blackHolePorts.find((port) => port && port.index === index)
          : undefined;
        return {
          index,
          ...(rawPort?.currentItemId && rawPort.currentItemId in ITEMS ? { currentItemId: rawPort.currentItemId } : {}),
          totalDestroyed: normalizeDecimalIntegerString(rawPort?.totalDestroyed, "0", 256),
        };
      }) : undefined,
      extractorBuildingId: entity.kind === "vein" && entity.minerCount > 0
        ? entity.extractorBuildingId ?? getExtractorBuildingId(entity.resourceId!)
        : entity.extractorBuildingId,
    };
  }) as FactoryEntity[];

  for (const resource of initial.entities.filter((entity) => entity.kind === "vein")) {
    // A v20+ save already owns an immutable galaxy resource catalogue. Rebuilding
    // the baseline with the same seed can legitimately produce a different
    // generated catalogue (notably for the legacy default seed), so only restore
    // stable resource entities that the persisted planet profile still declares.
    // This prevents load/import/cloud restore from silently adding a rare vein.
    const declaredBySavedGalaxy = resource.resourceId !== undefined &&
      galaxy.profiles[resource.planetId]?.resourceIds.includes(resource.resourceId);
    if (saved.version >= 20 && !declaredBySavedGalaxy) continue;
    const equivalentGuaranteedOil = resource.resourceId === "crude_oil" &&
      GUARANTEED_CRUDE_OIL_PLANETS.includes(resource.planetId as typeof GUARANTEED_CRUDE_OIL_PLANETS[number]) &&
      entities.some((entity) => entity.kind === "vein" && entity.planetId === resource.planetId && entity.resourceId === "crude_oil");
    if (!equivalentGuaranteedOil && !entities.some((entity) => entity.id === resource.id)) {
      entities.push({ ...resource, position: { ...resource.position }, inputs: {}, outputs: { ...resource.outputs } });
    }
  }

  const construction = Object.fromEntries(Object.keys(initial.construction).map((buildingId) => {
    const amount = saved.construction?.[buildingId];
    return [buildingId, Math.max(0, Math.floor(typeof amount === "number" ? amount : 0))];
  })) as GameState["construction"];
  if (saved.version < 31) {
    const legacySorterRefunds = [
      ["sorter_mk1", "conveyor_belt_mk1"],
      ["sorter_mk2", "conveyor_belt_mk2"],
      ["sorter_mk3", "conveyor_belt_mk3"],
    ] as const;
    for (const [sorterId, beltId] of legacySorterRefunds) {
      construction[beltId] = nonNegativeInteger(construction[beltId]) + nonNegativeInteger(saved.construction?.[sorterId]);
      construction[sorterId] = 0;
    }
  }
  const migratedBelts: BeltConnection[] = Array.isArray(saved.belts) ? saved.belts.map((belt: Record<string, any>) => {
    const source = entities.find((entity) => entity.id === belt.source);
    const tier = saved.version >= 8 && validBeltTier(belt.tier) ? belt.tier : 1;
    const rawLanes = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, nonNegativeInteger(belt.lanes) || 1));
    const lanes = Math.min(MAX_BELT_LANES, rawLanes);
    if (rawLanes > lanes) {
      const constructionId = getBeltConstructionId(tier);
      construction[constructionId] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor((construction[constructionId] ?? 0) + rawLanes - lanes));
    }
    return {
      ...belt,
      planetId: validPlanetId(belt.planetId) ? belt.planetId : source?.planetId ?? "home",
      lanes,
      tier,
      sorterTier: Math.min(3, tier) as SorterTier,
      progress: typeof belt.progress === "number" && Number.isFinite(belt.progress)
        ? Math.min(100_000_000, Math.max(0, belt.progress))
        : 0,
      priority: validPriority(belt.priority) ? belt.priority : 0,
      stackSize: validCargoStackSize(belt.stackSize) ? belt.stackSize : 1,
      monitorEnabled: Boolean(belt.monitorEnabled),
      routeMode: validBeltRouteMode(belt.routeMode) ? belt.routeMode : "auto",
      routeOffsetY: routeOffset(belt.routeOffsetY),
      elevatorOutputIndex: saved.version >= 43 && Number.isInteger(belt.elevatorOutputIndex) && belt.elevatorOutputIndex >= 0 && belt.elevatorOutputIndex < 5
        ? belt.elevatorOutputIndex
        : undefined,
      totalTransferred: nonNegativeInteger(belt.totalTransferred),
      congestion: Math.min(1, nonNegativeNumber(belt.congestion)),
      lastFlow: typeof belt.lastFlow === "number" ? belt.lastFlow : 0,
      targetPortIndex: saved.version >= 34 &&
        (belt.targetPortIndex === 0 || belt.targetPortIndex === 1 || belt.targetPortIndex === 2) &&
        (entities.find((entity) => entity.id === belt.target)?.buildingId === "micro_black_hole_connector" ||
          saved.version >= 39 && entities.find((entity) => entity.id === belt.target)?.buildingId === "material_delivery_hub")
        ? belt.targetPortIndex
        : undefined,
    } as BeltConnection;
  }) : [];
  for (const belt of migratedBelts) {
    const target = entities.find((entity) => entity.id === belt.target && entity.buildingId === "material_delivery_hub");
    if (!target) continue;
    const slots = target.deliverySlots ?? normalizeMaterialDeliverySlots(target, saved.version);
    const requested = belt.targetPortIndex;
    const requestedSlot = requested === 0 || requested === 1 || requested === 2 ? slots[requested] : undefined;
    let resolved: number = requested !== undefined && requestedSlot && requestedSlot.mode !== "disabled" && (!requestedSlot.itemId || requestedSlot.itemId === belt.itemId)
      ? requested
      : slots.findIndex((slot) => slot.mode !== "disabled" && slot.itemId === belt.itemId);
    if (resolved < 0) resolved = slots.findIndex((slot) => slot.mode === "auto" && !slot.itemId);
    if (resolved < 0) {
      belt.targetPortIndex = undefined;
      continue;
    }
    belt.targetPortIndex = resolved as 0 | 1 | 2;
    if (slots[resolved].mode === "auto" && !slots[resolved].itemId) slots[resolved] = { itemId: belt.itemId, mode: "auto" };
    target.deliverySlots = slots;
    target.deliveryItemIds = [...new Set(slots.flatMap((slot) => slot.itemId ? [slot.itemId] : []))];
  }
  const occupiedBlackHolePorts = new Set<string>();
  const belts = migratedBelts.filter((belt) => {
    const source = entities.find((entity) => entity.id === belt.source);
    const target = entities.find((entity) => entity.id === belt.target);
    if (!source || !target || source.planetId !== target.planetId || belt.planetId !== source.planetId) return false;
    // Ordinary machine lines are intentionally preserved even when a loaded
    // recipe currently does not accept their item. They may be a player-owned
    // temporarily disconnected route and have no persisted numbered port to
    // repair. Numbered delivery/black-hole ports below are authoritative and
    // can be validated without guessing player intent.
    if (target.buildingId === "material_delivery_hub") {
      if (belt.targetPortIndex === undefined) return false;
      const slot = target.deliverySlots?.[belt.targetPortIndex];
      return Boolean(slot && slot.mode !== "disabled" && slot.itemId === belt.itemId);
    }
    if (target.buildingId !== "micro_black_hole_connector") return belt.targetPortIndex === undefined;
    if (belt.targetPortIndex === undefined) return false;
    const key = `${target.id}:${belt.targetPortIndex}`;
    if (occupiedBlackHolePorts.has(key)) return false;
    occupiedBlackHolePorts.add(key);
    return true;
  });
  for (const belt of migratedBelts.filter((candidate) => !belts.includes(candidate))) {
    const constructionId = getBeltConstructionId(belt.tier);
    construction[constructionId] = Math.min(Number.MAX_SAFE_INTEGER, (construction[constructionId] ?? 0) + belt.lanes);
  }

  if (saved.version < 8) {
    for (const [buildingId, target] of Object.entries(STARTER_TOTALS) as Array<[ConstructionId, number]>) {
      const deployed = buildingId === "conveyor_belt_mk1"
        ? belts.filter((belt) => belt.tier === 1).reduce((sum, belt) => sum + belt.lanes, 0)
        : deployedCount(entities, buildingId as BuildingId);
      construction[buildingId] = Math.max(construction[buildingId] ?? 0, target - deployed);
    }
  }

  const completedTechIds = Array.isArray(saved.research?.completedTechIds)
    ? [...new Set((saved.research.completedTechIds as TechId[]).filter((techId) => Boolean(getTechnology(techId))))]
    : [];
  const constructionAutomationLimit = completedTechIds.includes("construction_capacity_2")
    ? MAX_CONSTRUCTION_AUTOMATION_TARGET
    : completedTechIds.includes("construction_capacity_1") ? 500 : 100;
  const validConstructionAutomationTargetId = (value: string): value is ConstructionAutomationTargetId =>
    value in initial.construction || value === "logistics_drone" || value === "logistics_vessel";
  const constructionAutomation: GameState["constructionAutomation"] = {
    enabled: saved.version >= 26 ? saved.constructionAutomation?.enabled !== false : true,
    targetStock: Object.fromEntries(Object.entries(saved.version >= 26 ? saved.constructionAutomation?.targetStock ?? {} : {}).flatMap(([constructionId, amount]) =>
      validConstructionAutomationTargetId(constructionId)
        ? [[constructionId, Math.min(constructionAutomationLimit, nonNegativeInteger(amount))]]
        : [])) as GameState["constructionAutomation"]["targetStock"],
    cursor: saved.version >= 26 ? nonNegativeInteger(saved.constructionAutomation?.cursor) % Math.max(1, Object.keys(initial.construction).length + 2) : 0,
    totalCrafted: saved.version >= 26 ? nonNegativeInteger(saved.constructionAutomation?.totalCrafted) : 0,
    lastCraftedId: saved.version >= 26 && typeof saved.constructionAutomation?.lastCraftedId === "string" && validConstructionAutomationTargetId(saved.constructionAutomation.lastCraftedId)
      ? saved.constructionAutomation.lastCraftedId
      : null,
    destroyedByproducts: saved.version >= 38 && saved.constructionAutomation?.destroyedByproducts && typeof saved.constructionAutomation.destroyedByproducts === "object"
      ? Object.fromEntries(Object.entries(saved.constructionAutomation.destroyedByproducts).flatMap(([itemId, amount]) =>
        itemId in ITEMS && typeof amount === "number" && Number.isFinite(amount)
          ? [[itemId, Math.min(Number.MAX_SAFE_INTEGER, nonNegativeInteger(amount))]]
          : [])) as GameState["constructionAutomation"]["destroyedByproducts"]
      : {},
    jobs: {},
  };
  if (saved.version >= 31 && saved.constructionAutomation?.jobs && typeof saved.constructionAutomation.jobs === "object") {
    const centerIds = new Set(entities.filter((entity) => entity.buildingId === "construction_center").map((entity) => entity.id));
    for (const [entityId, rawJob] of Object.entries(saved.constructionAutomation.jobs as Record<string, any>)) {
      if (!centerIds.has(entityId) || !rawJob || typeof rawJob !== "object" ||
        typeof rawJob.constructionId !== "string" || !validConstructionAutomationTargetId(rawJob.constructionId) || !Array.isArray(rawJob.steps)) continue;
      const steps = rawJob.steps.flatMap((step: Record<string, any>) => {
        if (step?.kind === "material" && typeof step.recipeId === "string" && getRecipe(step.recipeId as RecipeId) &&
          typeof step.outputItemId === "string" && step.outputItemId in ITEMS) {
          return [{ kind: "material" as const, recipeId: step.recipeId as RecipeId, batches: Math.max(1, nonNegativeInteger(step.batches)), outputItemId: step.outputItemId as ItemId, outputAmount: Math.max(1, nonNegativeInteger(step.outputAmount)) }];
        }
        if (step?.kind === "building" && typeof step.constructionId === "string" && step.constructionId in initial.construction) {
          return [{ kind: "building" as const, constructionId: step.constructionId as ConstructionId }];
        }
        if (saved.version >= 36 && step?.kind === "fleet" &&
          (step.itemId === "logistics_drone" || step.itemId === "logistics_vessel")) {
          return [{ kind: "fleet" as const, itemId: step.itemId as PortableFleetItemId, amount: Math.max(1, nonNegativeInteger(step.amount)) }];
        }
        return [];
      });
      if (steps.length === 0) continue;
      constructionAutomation.jobs[entityId] = {
        constructionId: rawJob.constructionId as ConstructionAutomationTargetId,
        steps,
        stepIndex: Math.min(steps.length - 1, nonNegativeInteger(rawJob.stepIndex)),
        elapsedSeconds: nonNegativeNumber(rawJob.elapsedSeconds),
        inventory: saved.version >= 33 ? constructionAutomationInventoryRecord(rawJob.inventory) : {},
        recipeDecisions: saved.version >= 36 && Array.isArray(rawJob.recipeDecisions)
          ? rawJob.recipeDecisions.flatMap((decision: Record<string, any>) =>
            typeof decision?.itemId === "string" && decision.itemId in ITEMS && typeof decision.recipeId === "string" && getRecipe(decision.recipeId as RecipeId)
              ? [{
                itemId: decision.itemId as ItemId,
                recipeId: decision.recipeId as RecipeId,
                fallbackReason: typeof decision.fallbackReason === "string" ? decision.fallbackReason.slice(0, 240) : undefined,
              }]
              : [])
          : undefined,
      };
    }
  }
  let selectedTechId = getTechnology(saved.research?.selectedTechId) && !completedTechIds.includes(saved.research.selectedTechId)
    ? saved.research.selectedTechId as TechId
    : null;
  let pausedTechId = saved.version >= 27 && getTechnology(saved.research?.pausedTechId) && !completedTechIds.includes(saved.research.pausedTechId) && saved.research.pausedTechId !== selectedTechId
    ? saved.research.pausedTechId as TechId
    : null;
  const plannedTechIds = new Set<TechId>([...completedTechIds, ...(pausedTechId ? [pausedTechId] : []), ...(selectedTechId ? [selectedTechId] : [])]);
  const queuedTechIds: TechId[] = [];
  if (Array.isArray(saved.research?.queuedTechIds)) {
    for (const techId of saved.research.queuedTechIds as TechId[]) {
      const technology = getTechnology(techId);
      if (!technology || plannedTechIds.has(techId) ||
        !technology.prerequisites.every((prerequisite) => plannedTechIds.has(prerequisite))) continue;
      queuedTechIds.push(techId);
      plannedTechIds.add(techId);
    }
  }
  if (!selectedTechId && !pausedTechId && queuedTechIds.length > 0) selectedTechId = queuedTechIds.shift()!;

  const activePlanetId = validPlanetId(saved.activePlanetId) ? saved.activePlanetId : "home";
  const planetViewports = Object.fromEntries(PLANET_LIST.map((planet) => {
    const viewport = saved.version >= 31 ? saved.planetViewports?.[planet.id] : undefined;
    return [planet.id, {
      x: Number.isFinite(viewport?.x) ? Math.round(viewport.x * 100) / 100 : initial.planetViewports[planet.id].x,
      y: Number.isFinite(viewport?.y) ? Math.round(viewport.y * 100) / 100 : initial.planetViewports[planet.id].y,
      zoom: Number.isFinite(viewport?.zoom)
        ? Math.max(0.25, Math.min(1.8, Math.round(viewport.zoom * 1000) / 1000))
        : initial.planetViewports[planet.id].zoom,
    }];
  })) as GameState["planetViewports"];
  const savedActiveTray = integerRecord(saved.tray);
  const planetTrays = Object.fromEntries(PLANET_LIST.map((planet) => [
    planet.id,
    planet.id === "home" && saved.version < 4 ? savedActiveTray : integerRecord(saved.planetTrays?.[planet.id]),
  ])) as GameState["planetTrays"];
  if (saved.version >= 4 && saved.tray && typeof saved.tray === "object") planetTrays[activePlanetId] = savedActiveTray;
  const planetTrayItemLimits = Object.fromEntries(PLANET_LIST.map((planet) => {
    const value = saved.version >= 28 ? saved.planetTrayItemLimits?.[planet.id] : DEFAULT_PLANET_TRAY_ITEM_LIMIT;
    const limit = Number.isFinite(value)
      ? Math.max(MIN_PLANET_TRAY_ITEM_LIMIT, Math.min(MAX_PLANET_TRAY_ITEM_LIMIT, Math.floor(value)))
      : DEFAULT_PLANET_TRAY_ITEM_LIMIT;
    return [planet.id, limit];
  })) as GameState["planetTrayItemLimits"];
  if (saved.version < 37) {
    for (const entity of entities) {
      if (entity.buildingId !== "artificial_star") continue;
      const ratedCapacity = 30 * Math.max(1, nonNegativeInteger(entity.machineCount));
      const stored = nonNegativeInteger(entity.inputs.antimatter_fuel_rod);
      const excess = Math.max(0, stored - ratedCapacity);
      if (excess < 1) continue;
      const tray = planetTrays[entity.planetId];
      const current = nonNegativeInteger(tray.antimatter_fuel_rod);
      const moved = Math.min(excess, Math.max(0, planetTrayItemLimits[entity.planetId] - current));
      if (moved < 1) continue;
      tray.antimatter_fuel_rod = current + moved;
      entity.inputs.antimatter_fuel_rod = stored - moved;
    }
  }
  const portableFleet: GameState["portableFleet"] = {
    logistics_drone: saved.version >= 24 ? nonNegativeInteger(saved.portableFleet?.logistics_drone) : 0,
    logistics_vessel: saved.version >= 24 ? nonNegativeInteger(saved.portableFleet?.logistics_vessel) : 0,
  };
  if (saved.version < 24) {
    for (const tray of Object.values(planetTrays)) {
      portableFleet.logistics_drone += nonNegativeInteger(tray.logistics_drone);
      portableFleet.logistics_vessel += nonNegativeInteger(tray.logistics_vessel);
      delete tray.logistics_drone;
      delete tray.logistics_vessel;
    }
  }
  const planetMetrics = Object.fromEntries(PLANET_LIST.map((planet) => [
    planet.id,
    {
      ...initial.planetMetrics[planet.id],
      ...(planet.id === "home" && saved.version < 4 ? saved.metrics ?? {} : saved.planetMetrics?.[planet.id] ?? {}),
    },
  ])) as GameState["planetMetrics"];
  const persistedSystems = Array.isArray(saved.exploration?.unlockedSystemIds)
    ? (saved.exploration.unlockedSystemIds as unknown[]).filter(validStarSystemId)
    : [];
  const unlockedSystemIds = [...new Set<StarSystemId>(["helios", ...persistedSystems])];
  if (saved.version < 13 && completedTechIds.includes("rare_resource_utilization")) {
    unlockedSystemIds.push(...(["borealis", "neutron"] as StarSystemId[]).filter((systemId) => !unlockedSystemIds.includes(systemId)));
  }
  const persistedColonies = Array.isArray(saved.exploration?.colonizedPlanetIds)
    ? (saved.exploration.colonizedPlanetIds as unknown[]).filter(validPlanetId)
    : PLANET_LIST.filter((planet) => unlockedSystemIds.includes(planet.systemId)).map((planet) => planet.id);
  const colonizedPlanetIds = [...new Set<PlanetId>(["home", ...persistedColonies])]
    .filter((planetId) => unlockedSystemIds.includes(getPlanet(planetId).systemId));
  if (completedTechIds.includes("interstellar_logistics")) {
    for (const planetId of ["ashen", "giant"] as PlanetId[]) {
      if (!colonizedPlanetIds.includes(planetId)) colonizedPlanetIds.push(planetId);
    }
  }
  const surveyProgressBySystem = Object.fromEntries((Object.keys(STAR_SYSTEMS) as StarSystemId[]).map((systemId) => [
    systemId,
    Math.min(1, nonNegativeNumber(saved.exploration?.surveyProgressBySystem?.[systemId]) || (unlockedSystemIds.includes(systemId) ? 1 : 0)),
  ])) as GameState["exploration"]["surveyProgressBySystem"];
  const missions: GameState["exploration"]["missions"] = Array.isArray(saved.exploration?.missions)
    ? saved.exploration.missions.flatMap((mission: Record<string, any>) => {
      if (!validStarSystemId(mission.systemId) || unlockedSystemIds.includes(mission.systemId)) return [];
      const durationSeconds = Math.max(1, nonNegativeNumber(mission.durationSeconds));
      return [{
        systemId: mission.systemId,
        elapsedSeconds: Math.min(durationSeconds, nonNegativeNumber(mission.elapsedSeconds)),
        durationSeconds,
      }];
    })
    : [];
  const savedBlueprints = saved.version >= 14 && Array.isArray(saved.blueprints) ? saved.blueprints : [];
  const savedBlueprintVersions = saved.version >= 46 && Array.isArray(saved.blueprintVersions)
    ? saved.blueprintVersions.slice(0, 100)
    : [];
  const blueprintSources = [
    ...savedBlueprints.map((blueprint: Record<string, any>, blueprintIndex: number) => ({ kind: "library" as const, blueprint, blueprintIndex })),
    ...savedBlueprintVersions.flatMap((snapshot: Record<string, any>, blueprintIndex: number) =>
      snapshot && typeof snapshot === "object" && snapshot.definition && typeof snapshot.definition === "object"
        ? [{ kind: "snapshot" as const, blueprint: snapshot.definition as Record<string, any>, blueprintIndex, snapshot }]
        : []),
  ];
  const normalizedBlueprintSources = blueprintSources.flatMap((source) => {
      const { blueprint, blueprintIndex } = source;
      if (!Array.isArray(blueprint.entities)) return [];
      const blueprintEntities = blueprint.entities.flatMap((entity: Record<string, any>, entityIndex: number) => {
        if (typeof entity.buildingId !== "string" || !(entity.buildingId in BUILDINGS)) return [];
        const recipeId = typeof entity.recipeId === "string" && getRecipe(entity.recipeId as RecipeId) ? entity.recipeId as RecipeId : undefined;
        const storedItemId = typeof entity.storedItemId === "string" && entity.storedItemId in ITEMS ? entity.storedItemId as ItemId : undefined;
        const fuelItemId = typeof entity.fuelItemId === "string" && entity.fuelItemId in ITEMS ? entity.fuelItemId as ItemId : undefined;
        const deliverySlots = entity.buildingId === "material_delivery_hub"
          ? normalizeMaterialDeliverySlots(entity as FactoryEntity, saved.version)
          : undefined;
        return [{
          key: typeof entity.key === "string" && entity.key ? entity.key : `node_${entityIndex + 1}`,
          buildingId: entity.buildingId as BuildingId,
          offset: {
            x: typeof entity.offset?.x === "number" && Number.isFinite(entity.offset.x) ? entity.offset.x : 0,
            y: typeof entity.offset?.y === "number" && Number.isFinite(entity.offset.y) ? entity.offset.y : 0,
          },
          machineCount: persistedPositiveInteger(entity.machineCount, `蓝图 ${blueprint.name ?? blueprintIndex + 1} 设备 ${entity.key ?? entityIndex + 1}.machineCount`),
          recipeId,
          targetDysonOrbitId: entity.buildingId === "em_rail_ejector" && saved.version >= 41 &&
            typeof entity.targetDysonOrbitId === "string" && entity.targetDysonOrbitId.length > 0 && entity.targetDysonOrbitId.length <= 160
            ? entity.targetDysonOrbitId
            : undefined,
          stationTier: entity.buildingId === "interstellar_logistics_station" && saved.version >= 43 && entity.stationTier === 2 ? 2 :
            entity.buildingId === "interstellar_logistics_station" ? 1 : undefined,
          stationOperationMode: entity.buildingId === "interstellar_logistics_station" && saved.version >= 43 && entity.stationTier === 2 && entity.stationOperationMode === "elevator"
            ? "elevator"
            : entity.buildingId === "interstellar_logistics_station" ? "legacy" : undefined,
          ...(entity.buildingId === "interstellar_logistics_station" ? { quantumTarget: entity.quantumTarget === true } : {}),
          ...(entity.buildingId === "micro_black_hole_connector" && typeof entity.operationEnabledOnDeploy === "boolean"
            ? { operationEnabledOnDeploy: entity.operationEnabledOnDeploy }
            : {}),
          elevatorOutputItems: entity.buildingId === "interstellar_logistics_station" && saved.version >= 43 && Array.isArray(entity.elevatorOutputItems)
            ? Array.from({ length: 5 }, (_, index) => {
              const itemId = entity.elevatorOutputItems[index];
              return typeof itemId === "string" && itemId in ITEMS ? itemId as ItemId : null;
            })
            : entity.buildingId === "interstellar_logistics_station" && entity.stationTier === 2 ? [null, null, null, null, null] : undefined,
          storedItemId,
          deliveryItemIds: entity.buildingId === "material_delivery_hub"
            ? [...new Set(deliverySlots!.flatMap((slot) => slot.itemId ? [slot.itemId] : []))]
            : undefined,
          deliverySlots,
          distributionMode: entity.distributionMode === "priority" ? "priority" as const : entity.distributionMode === "balanced" ? "balanced" as const : undefined,
          fuelItemId,
          energyMode: validEnergyMode(entity.energyMode) ? entity.energyMode : undefined,
          stationMode: entity.stationMode === "demand" ? "demand" as const : entity.stationMode === "supply" ? "supply" as const : undefined,
          stationMinimumLoad: validStationMinimumLoad(entity.stationMinimumLoad) ? entity.stationMinimumLoad : undefined,
          stationWarpEnabled: typeof entity.stationWarpEnabled === "boolean" ? entity.stationWarpEnabled : undefined,
          stationWarperAutoRefill: entity.buildingId === "interstellar_logistics_station" ? Boolean(entity.stationWarperAutoRefill) : undefined,
          stationWarperTarget: entity.buildingId === "interstellar_logistics_station"
            ? Math.max(1, Math.min(
              STATION_WARPER_CAPACITY_PER_BUILDING * Math.max(1, nonNegativeInteger(entity.machineCount)),
              nonNegativeInteger(entity.stationWarperTarget) || DEFAULT_STATION_WARPER_TARGET,
            ))
            : undefined,
          stationDroneTarget: entity.buildingId === "planetary_logistics_station" || entity.buildingId === "interstellar_logistics_station"
            ? nonNegativeInteger(entity.stationDroneTarget)
            : undefined,
          stationVesselTarget: entity.buildingId === "interstellar_logistics_station"
            ? nonNegativeInteger(entity.stationVesselTarget)
            : undefined,
          stationHubEnabled: Boolean(entity.stationHubEnabled),
          stationHubPriority: validPriority(entity.stationHubPriority) ? entity.stationHubPriority : 1,
          stationSlots: getBuilding(entity.buildingId as BuildingId).kind === "station" && entity.buildingId !== "orbital_collector"
            ? normalizeStationSlots({
              kind: "station",
              buildingId: entity.buildingId,
              storedItemId,
              stationMode: entity.stationMode,
              stationMinimumLoad: entity.stationMinimumLoad,
              stationSlots: entity.stationSlots,
            } as FactoryEntity)
            : undefined,
          sprayCoaterInstalled: Boolean(entity.sprayCoaterInstalled),
          proliferatorTier: validProliferatorTier(entity.proliferatorTier) ? entity.proliferatorTier : undefined,
          proliferatorMode: validProliferatorMode(entity.proliferatorMode) ? entity.proliferatorMode : undefined,
        }];
      });
      const resourceAnchors = Array.isArray(blueprint.resourceAnchors) ? blueprint.resourceAnchors.flatMap((anchor: Record<string, any>, anchorIndex: number) => {
        if (typeof anchor.resourceId !== "string" || !(anchor.resourceId in ITEMS)) return [];
        const resourceId = anchor.resourceId as ItemId;
        const extractorBuildingId = getExtractorBuildingId(resourceId);
        if (typeof anchor.extractorBuildingId === "string" && anchor.extractorBuildingId !== extractorBuildingId) return [];
        return [{
          key: typeof anchor.key === "string" && anchor.key ? anchor.key : `resource_${anchorIndex + 1}`,
          resourceId,
          offset: {
            x: typeof anchor.offset?.x === "number" && Number.isFinite(anchor.offset.x) ? anchor.offset.x : 0,
            y: typeof anchor.offset?.y === "number" && Number.isFinite(anchor.offset.y) ? anchor.offset.y : 0,
          },
          extractorBuildingId,
          minerCount: persistedPositiveInteger(anchor.minerCount, `蓝图 ${blueprint.name ?? blueprintIndex + 1} 资源锚点 ${anchor.key ?? anchorIndex + 1}.minerCount`),
        }];
      }) : [];
      if (blueprintEntities.length === 0 && resourceAnchors.length === 0) return [];
      const keys = new Set([...blueprintEntities.map((entity) => entity.key), ...resourceAnchors.map((anchor) => anchor.key)]);
      if (keys.size !== blueprintEntities.length + resourceAnchors.length) return [];
      const blueprintBelts = Array.isArray(blueprint.belts) ? blueprint.belts.flatMap((belt: Record<string, any>, beltIndex: number) => {
        if (!keys.has(belt.sourceKey) || !keys.has(belt.targetKey) || typeof belt.itemId !== "string" || !(belt.itemId in ITEMS)) return [];
        const tier = validBeltTier(belt.tier) ? belt.tier : 1;
        const targetTemplate = blueprintEntities.find((entity) => entity.key === belt.targetKey);
        const targetPortIndex = (belt.targetPortIndex === 0 || belt.targetPortIndex === 1 || belt.targetPortIndex === 2) &&
          (targetTemplate?.buildingId === "micro_black_hole_connector" || targetTemplate?.buildingId === "material_delivery_hub")
          ? belt.targetPortIndex as 0 | 1 | 2
          : undefined;
        const elevatorOutputIndex = (belt.elevatorOutputIndex === 0 || belt.elevatorOutputIndex === 1 || belt.elevatorOutputIndex === 2 || belt.elevatorOutputIndex === 3 || belt.elevatorOutputIndex === 4) &&
          blueprintEntities.some((entity) => entity.key === belt.sourceKey && entity.buildingId === "interstellar_logistics_station" && entity.stationTier === 2)
          ? belt.elevatorOutputIndex as 0 | 1 | 2 | 3 | 4
          : undefined;
        return [{
          key: typeof belt.key === "string" && belt.key ? belt.key : `line_${beltIndex + 1}`,
          sourceKey: belt.sourceKey as string,
          targetKey: belt.targetKey as string,
          itemId: belt.itemId as ItemId,
          lanes: Math.max(1, Math.min(MAX_BELT_LANES, nonNegativeInteger(belt.lanes) || 1)),
          tier,
          sorterTier: tier,
          priority: validPriority(belt.priority) ? belt.priority : 0,
          stackSize: validCargoStackSize(belt.stackSize) ? belt.stackSize : 1,
          monitorEnabled: Boolean(belt.monitorEnabled),
          routeMode: validBeltRouteMode(belt.routeMode) ? belt.routeMode : "auto",
          routeOffsetY: routeOffset(belt.routeOffsetY),
          targetPortIndex,
          elevatorOutputIndex,
        }];
      }) : [];
      const externalPorts = Array.isArray(blueprint.externalPorts) ? blueprint.externalPorts.flatMap((port: Record<string, any>, portIndex: number) => {
        if (!keys.has(port.entityKey) || typeof port.itemId !== "string" || !(port.itemId in ITEMS) ||
          (port.direction !== "input" && port.direction !== "output")) return [];
        return [{
          key: typeof port.key === "string" && port.key ? port.key : `port_${portIndex + 1}`,
          entityKey: port.entityKey as string,
          direction: port.direction as "input" | "output",
          itemId: port.itemId as ItemId,
          offset: {
            x: typeof port.offset?.x === "number" && Number.isFinite(port.offset.x) ? port.offset.x : 0,
            y: typeof port.offset?.y === "number" && Number.isFinite(port.offset.y) ? port.offset.y : 0,
          },
        }];
      }) : [];
      const recipeOverrides = Object.fromEntries(Object.entries(blueprint.recipeOverrides ?? {}).flatMap(([sourceId, targetId]) =>
        getRecipe(sourceId as RecipeId) && typeof targetId === "string" && getRecipe(targetId as RecipeId)
          ? [[sourceId, targetId]]
          : [])) as BlueprintDefinition["recipeOverrides"];
      const definition = {
        id: typeof blueprint.id === "string" && blueprint.id ? blueprint.id : `blueprint_migrated_${blueprintIndex + 1}`,
        name: typeof blueprint.name === "string" && blueprint.name.trim() ? blueprint.name.trim().slice(0, 32) : `蓝图 ${String(blueprintIndex + 1).padStart(2, "0")}`,
        revision: Number.isSafeInteger(blueprint.revision) ? Math.max(1, nonNegativeInteger(blueprint.revision)) : 1,
        entities: blueprintEntities,
        resourceAnchors,
          belts: blueprintBelts,
        externalPorts,
        rotation: validBlueprintRotation(blueprint.rotation) ? blueprint.rotation : 0,
        mirror: validBlueprintMirror(blueprint.mirror) ? blueprint.mirror : "none",
        recipeOverrides,
      } as BlueprintDefinition;
      return [{ ...source, definition }];
    });
  const blueprints = normalizedBlueprintSources
    .filter((source) => source.kind === "library")
    .map((source) => source.definition);
  const blueprintVersions: GameState["blueprintVersions"] = [];
  for (const source of normalizedBlueprintSources) {
    if (source.kind !== "snapshot") continue;
    const revision = Number.isSafeInteger(source.snapshot.revision)
      ? Math.max(1, nonNegativeInteger(source.snapshot.revision))
      : Math.max(1, source.definition.revision ?? 1);
    const blueprintId = typeof source.snapshot.blueprintId === "string" && source.snapshot.blueprintId
      ? source.snapshot.blueprintId.slice(0, 160)
      : source.definition.id;
    const id = typeof source.snapshot.id === "string" && source.snapshot.id
      ? source.snapshot.id.slice(0, 200)
      : `${blueprintId}@${revision}`;
    if (blueprintVersions.some((snapshot) => snapshot.id === id)) continue;
    blueprintVersions.push({ id, blueprintId, revision, definition: source.definition });
  }
  const constructionQueue: GameState["constructionQueue"] = Array.isArray(saved.constructionQueue)
    ? saved.constructionQueue.slice(0, 100).flatMap((entry: Record<string, any>, index: number) => {
      if (!validPlanetId(entry.planetId)) return [];
      let snapshot = typeof entry.blueprintVersionId === "string"
        ? blueprintVersions.find((candidate) => candidate.id === entry.blueprintVersionId)
        : undefined;
      const libraryBlueprint = blueprints.find((candidate) => candidate.id === entry.blueprintId);
      const blueprint = snapshot?.definition ?? libraryBlueprint;
      if (!blueprint) return [];
      if (!snapshot) {
        const revision = Math.max(1, Math.floor(blueprint.revision ?? 1));
        const versionId = `${blueprint.id}@${revision}`;
        snapshot = blueprintVersions.find((candidate) => candidate.id === versionId);
        if (!snapshot) {
          snapshot = {
            id: versionId,
            blueprintId: blueprint.id,
            revision,
            definition: JSON.parse(JSON.stringify(blueprint)) as BlueprintDefinition,
          };
          blueprintVersions.push(snapshot);
        }
      }
      const status = saved.version >= 46 && entry.status === "waiting-fleet" ? "waiting-fleet" as const : "pending-materials" as const;
      const reservedConstruction = status === "pending-materials" && entry.reservedConstruction && typeof entry.reservedConstruction === "object" && !Array.isArray(entry.reservedConstruction)
        ? Object.fromEntries(Object.entries(entry.reservedConstruction).flatMap(([constructionId, amount]) =>
          constructionId in construction && Number.isSafeInteger(amount) && (amount as number) >= 0
            ? [[constructionId, amount]]
            : [])) as GameState["constructionQueue"][number]["reservedConstruction"]
        : {};
      const reservedFleet = status === "pending-materials" && entry.reservedFleet && typeof entry.reservedFleet === "object" && !Array.isArray(entry.reservedFleet)
        ? Object.fromEntries((["logistics_drone", "logistics_vessel"] as const).flatMap((itemId) => {
          const amount = entry.reservedFleet[itemId];
          return Number.isSafeInteger(amount) && amount >= 0 ? [[itemId, amount]] : [];
        })) as GameState["constructionQueue"][number]["reservedFleet"]
        : {};
      const placedEntityIdsByKey = status === "waiting-fleet" && entry.placedEntityIdsByKey && typeof entry.placedEntityIdsByKey === "object" && !Array.isArray(entry.placedEntityIdsByKey)
        ? Object.fromEntries(Object.entries(entry.placedEntityIdsByKey).flatMap(([key, entityId]) =>
          typeof entityId === "string" && entities.some((entity) => entity.id === entityId)
            ? [[key.slice(0, 160), entityId]]
            : []))
        : {};
      return [{
        id: typeof entry.id === "string" && entry.id ? entry.id.slice(0, 160) : `construction_migrated_${index + 1}`,
        blueprintId: snapshot.blueprintId,
        blueprintVersionId: snapshot.id,
        blueprintRevision: snapshot.revision,
        blueprintName: typeof entry.blueprintName === "string" && entry.blueprintName.trim()
          ? entry.blueprintName.trim().slice(0, 32)
          : blueprint.name,
        planetId: entry.planetId,
        position: {
          x: typeof entry.position?.x === "number" && Number.isFinite(entry.position.x) ? entry.position.x : 0,
          y: typeof entry.position?.y === "number" && Number.isFinite(entry.position.y) ? entry.position.y : 0,
        },
        rotation: validBlueprintRotation(entry.rotation) ? entry.rotation : blueprint.rotation ?? 0,
        mirror: validBlueprintMirror(entry.mirror) ? entry.mirror : blueprint.mirror ?? "none",
        queuedAt: nonNegativeNumber(entry.queuedAt),
        status,
        reservedConstruction,
        reservedFleet,
        placedEntityIdsByKey,
        buildingCompletedAt: status === "waiting-fleet" ? nonNegativeNumber(entry.buildingCompletedAt) : undefined,
      }];
    })
    : [];
  const handcraftQueue: GameState["handcraftQueue"] = Array.isArray(saved.handcraftQueue)
    ? saved.handcraftQueue.slice(0, 20).flatMap((entry: Record<string, any>, index: number) => {
      if (!getRecipe(entry.recipeId as RecipeId) || !validPlanetId(entry.planetId)) return [];
      const batchesTotal = Math.max(1, Math.min(100_000, nonNegativeInteger(entry.batchesTotal) || 1));
      const batchesRemaining = Math.max(0, Math.min(batchesTotal, nonNegativeInteger(entry.batchesRemaining) || batchesTotal));
      return batchesRemaining > 0 ? [{
        id: typeof entry.id === "string" && entry.id ? entry.id : `handcraft_migrated_${index + 1}`,
        recipeId: entry.recipeId as RecipeId,
        planetId: entry.planetId,
        batchesTotal,
        batchesRemaining,
        progress: Math.min(0.9999, nonNegativeNumber(entry.progress)),
        queuedAt: nonNegativeNumber(entry.queuedAt),
      }] : [];
    })
    : [];
  const productionPlans: GameState["productionPlans"] = Array.isArray(saved.productionPlans)
    ? saved.productionPlans.flatMap((plan: Record<string, any>, index: number) => {
      if (typeof plan.itemId !== "string" || !(plan.itemId in ITEMS)) return [];
      const recipeSelections = Object.fromEntries(Object.entries(plan.recipeSelections ?? {}).flatMap(([itemId, recipeId]) =>
        itemId in ITEMS && typeof recipeId === "string" && getRecipe(recipeId as RecipeId)
          ? [[itemId, recipeId]]
          : []));
      return [{
        id: typeof plan.id === "string" && plan.id ? plan.id : `plan_migrated_${index + 1}`,
        name: typeof plan.name === "string" && plan.name.trim() ? plan.name.trim().slice(0, 40) : `${ITEMS[plan.itemId as ItemId].name}计划`,
        itemId: plan.itemId as ItemId,
        targetPerMinute: Math.max(0.01, nonNegativeNumber(plan.targetPerMinute)),
        planetId: plan.planetId === "all" || validPlanetId(plan.planetId) ? plan.planetId : "all",
        recipeSelections,
        createdAt: nonNegativeNumber(plan.createdAt),
      }];
    })
    : [];
  const productionHistory: GameState["productionHistory"] = Array.isArray(saved.productionHistory)
    ? saved.productionHistory.slice(-180).flatMap((sample: Record<string, any>) => {
      const elapsedSeconds = nonNegativeNumber(sample.elapsedSeconds);
      if (elapsedSeconds <= 0) return [];
      return [{
        elapsedSeconds,
        sampleDurationSeconds: Math.max(1, Math.min(3_600, nonNegativeNumber(sample.sampleDurationSeconds) || 10)),
        productionPerMinute: nonNegativeRecord(sample.productionPerMinute),
        consumptionPerMinute: nonNegativeRecord(sample.consumptionPerMinute),
        planetProductionPerMinute: isRecord(sample.planetProductionPerMinute)
          ? Object.fromEntries(Object.entries(sample.planetProductionPerMinute).flatMap(([planetId, values]) => validPlanetId(planetId) && isRecord(values) ? [[planetId, nonNegativeRecord(values)]] : [])) as GameState["productionHistory"][number]["planetProductionPerMinute"]
          : undefined,
        planetConsumptionPerMinute: isRecord(sample.planetConsumptionPerMinute)
          ? Object.fromEntries(Object.entries(sample.planetConsumptionPerMinute).flatMap(([planetId, values]) => validPlanetId(planetId) && isRecord(values) ? [[planetId, nonNegativeRecord(values)]] : [])) as GameState["productionHistory"][number]["planetConsumptionPerMinute"]
          : undefined,
        inventory: integerRecord(sample.inventory),
        generationKw: nonNegativeNumber(sample.generationKw),
        demandKw: nonNegativeNumber(sample.demandKw),
        machineEfficiency: Math.min(1, nonNegativeNumber(sample.machineEfficiency)),
        logisticsEfficiency: Math.min(1, nonNegativeNumber(sample.logisticsEfficiency)),
        powerEfficiency: Math.min(1, nonNegativeNumber(sample.powerEfficiency) || (nonNegativeNumber(sample.demandKw) > 0 ? 0 : 1)),
        activeMachines: nonNegativeInteger(sample.activeMachines),
        blockedMachines: nonNegativeInteger(sample.blockedMachines),
      }];
    })
    : [];
  const endgame = migrateEndgame(saved);
  const dysonPowerMultiplier = getDysonPowerMultiplier({ endgame });
  const structurePoints = saved.version >= 7 ? nonNegativeInteger(saved.dysonSphere?.structurePoints) : 0;
  const shellCapacity = structurePoints * DYSON_SHELL_CAPACITY_PER_STRUCTURE;
  const shellSails = saved.version >= 7
    ? Math.min(shellCapacity, nonNegativeInteger(saved.dysonSphere?.shellSails))
    : 0;
  const totalSailsAbsorbed = saved.version >= 7
    ? Math.max(shellSails, nonNegativeInteger(saved.dysonSphere?.totalSailsAbsorbed))
    : 0;
  const dysonSphere: GameState["dysonSphere"] = {
    structurePoints,
    totalRocketsLaunched: saved.version >= 7
      ? Math.max(structurePoints, nonNegativeInteger(saved.dysonSphere?.totalRocketsLaunched))
      : 0,
    shellSails,
    totalSailsAbsorbed,
    absorptionProgress: saved.version >= 7 ? nonNegativeNumber(saved.dysonSphere?.absorptionProgress) % 1 : 0,
    generationKw: structurePoints * DYSON_STRUCTURE_POWER_KW + shellSails * DYSON_SHELL_SAIL_POWER_KW,
  };
  const dysonPlans = Object.fromEntries((Object.keys(STAR_SYSTEMS) as StarSystemId[]).map((systemId) => {
    const savedPlan = saved.version >= 15 ? saved.dysonPlans?.[systemId] : undefined;
    const layers: DysonLayerState[] = Array.isArray(savedPlan?.layers) ? savedPlan.layers.flatMap((layer: Record<string, any>, layerIndex: number) => {
      const nodes = Array.isArray(layer.nodes) ? layer.nodes.flatMap((node: Record<string, any>, nodeIndex: number) => {
        const required = Math.max(1, nonNegativeInteger(node.requiredStructurePoints));
        const rawAngle = typeof node.angle === "number" && Number.isFinite(node.angle) ? node.angle : 0;
        return [{
          id: typeof node.id === "string" && node.id ? node.id : `dyson_node_migrated_${layerIndex}_${nodeIndex}`,
          angle: ((rawAngle % 360) + 360) % 360,
          requiredStructurePoints: required,
          completedStructurePoints: Math.min(required, nonNegativeInteger(node.completedStructurePoints)),
        }];
      }) : [];
      const nodeIds = new Set(nodes.map((node) => node.id));
      const frames = Array.isArray(layer.frames) ? layer.frames.flatMap((frame: Record<string, any>, frameIndex: number) => {
        if (!nodeIds.has(frame.sourceNodeId) || !nodeIds.has(frame.targetNodeId) || frame.sourceNodeId === frame.targetNodeId) return [];
        const required = Math.max(1, nonNegativeInteger(frame.requiredStructurePoints));
        return [{
          id: typeof frame.id === "string" && frame.id ? frame.id : `dyson_frame_migrated_${layerIndex}_${frameIndex}`,
          sourceNodeId: frame.sourceNodeId as string,
          targetNodeId: frame.targetNodeId as string,
          requiredStructurePoints: required,
          completedStructurePoints: Math.min(required, nonNegativeInteger(frame.completedStructurePoints)),
        }];
      }) : [];
      const frameIds = new Set(frames.map((frame) => frame.id));
      const shells = Array.isArray(layer.shells) ? layer.shells.flatMap((shell: Record<string, any>, shellIndex: number) => {
        const boundaryFrameIds = Array.isArray(shell.boundaryFrameIds)
          ? [...new Set((shell.boundaryFrameIds as unknown[]).filter((frameId): frameId is string => typeof frameId === "string" && frameIds.has(frameId)))]
          : [];
        if (!nodeIds.has(shell.sourceNodeId) || !nodeIds.has(shell.targetNodeId) || boundaryFrameIds.length === 0) return [];
        const migratedCapacity = boundaryFrameIds.reduce((sum, frameId) =>
          sum + (frames.find((frame) => frame.id === frameId)?.requiredStructurePoints ?? 0) * DYSON_SHELL_CAPACITY_PER_STRUCTURE, 0);
        const capacity = saved.version < 37
          ? Math.max(1, migratedCapacity)
          : Math.max(1, nonNegativeInteger(shell.sailCapacity));
        return [{
          id: typeof shell.id === "string" && shell.id ? shell.id : `dyson_shell_migrated_${layerIndex}_${shellIndex}`,
          sourceNodeId: shell.sourceNodeId as string,
          targetNodeId: shell.targetNodeId as string,
          boundaryFrameIds,
          sailCapacity: capacity,
          absorbedSails: Math.min(capacity, nonNegativeInteger(shell.absorbedSails)),
        }];
      }) : [];
      const radius = typeof layer.radius === "number" && Number.isFinite(layer.radius) ? layer.radius : 10_000;
      const inclination = typeof layer.inclination === "number" && Number.isFinite(layer.inclination) ? layer.inclination : 0;
      const longitude = typeof layer.longitude === "number" && Number.isFinite(layer.longitude) ? layer.longitude : 0;
      return [{
        id: typeof layer.id === "string" && layer.id ? layer.id : `dyson_layer_migrated_${layerIndex}`,
        name: typeof layer.name === "string" && layer.name.trim() ? layer.name.trim().slice(0, 32) : `壳层 ${layerIndex + 1}`,
        radius: Math.max(5_000, Math.min(50_000, Math.round(radius))),
        inclination: Math.max(-90, Math.min(90, Math.round(inclination))),
        longitude: ((longitude % 360) + 360) % 360,
        nodes,
        frames,
        shells,
        structureAllocationFloor: saved.version >= 34 ? nonNegativeInteger(layer.structureAllocationFloor) : 0,
        shellAllocationFloor: saved.version >= 34 ? nonNegativeInteger(layer.shellAllocationFloor) : 0,
      }];
    }) : [];
    const activeLayerId = typeof savedPlan?.activeLayerId === "string" && layers.some((layer) => layer.id === savedPlan.activeLayerId)
      ? savedPlan.activeLayerId as string
      : layers[0]?.id ?? null;
    return [systemId, {
      systemId,
      activeLayerId,
      structurePoints: saved.version >= 15
        ? nonNegativeInteger(savedPlan?.structurePoints)
        : systemId === "helios" ? structurePoints : 0,
      shellSails: saved.version >= 15
        ? nonNegativeInteger(savedPlan?.shellSails)
        : systemId === "helios" ? shellSails : 0,
      layers,
    } satisfies DysonSpherePlanState];
  })) as GameState["dysonPlans"];
  let plannedStructurePoints = Object.values(dysonPlans).reduce((sum, plan) => sum + plan.structurePoints, 0);
  let plannedShellSails = Object.values(dysonPlans).reduce((sum, plan) => sum + plan.shellSails, 0);
  if (structurePoints > plannedStructurePoints) {
    dysonPlans.helios.structurePoints += structurePoints - plannedStructurePoints;
    plannedStructurePoints = structurePoints;
  }
  if (shellSails > plannedShellSails) {
    dysonPlans.helios.shellSails += shellSails - plannedShellSails;
    plannedShellSails = shellSails;
  }
  dysonSphere.structurePoints = Math.max(dysonSphere.structurePoints, plannedStructurePoints);
  dysonSphere.shellSails = Math.max(dysonSphere.shellSails, plannedShellSails);
  dysonSphere.totalRocketsLaunched = Math.max(dysonSphere.totalRocketsLaunched, dysonSphere.structurePoints);
  dysonSphere.totalSailsAbsorbed = Math.max(dysonSphere.totalSailsAbsorbed, dysonSphere.shellSails);
  dysonSphere.generationKw = Math.floor(Object.values(dysonPlans).reduce((sum, plan) => sum +
    (plan.structurePoints * DYSON_STRUCTURE_POWER_KW + plan.shellSails * DYSON_SHELL_SAIL_POWER_KW) *
    dysonPowerMultiplier * getStarLuminosity({ galaxy }, plan.systemId), 0));
  const sailsInOrbit = saved.version >= 6 ? nonNegativeInteger(saved.dysonSwarm?.sailsInOrbit) : 0;
  const totalExpired = saved.version >= 6 ? nonNegativeInteger(saved.dysonSwarm?.totalExpired) : 0;
  const totalLaunched = saved.version >= 6
    ? Math.max(sailsInOrbit + totalExpired + dysonSphere.totalSailsAbsorbed, nonNegativeInteger(saved.dysonSwarm?.totalLaunched))
    : 0;
  const swarmGenerationKw = sailsInOrbit * SOLAR_SAIL_POWER_KW * dysonPowerMultiplier * getStarLuminosity({ galaxy }, "helios");
  const dysonSwarm: GameState["dysonSwarm"] = {
    sailsInOrbit,
    totalLaunched,
    totalExpired,
    decayProgress: saved.version >= 6 ? nonNegativeNumber(saved.dysonSwarm?.decayProgress) % 1 : 0,
    generationKw: swarmGenerationKw,
    receiverLoadKw: saved.version >= 6
      ? Math.min(swarmGenerationKw + dysonSphere.generationKw, nonNegativeNumber(saved.dysonSwarm?.receiverLoadKw))
      : 0,
  };
  const dysonEngineering: DysonEngineeringState = {
    ...initial.dysonEngineering,
    launchMode: validDysonLaunchMode(saved.dysonEngineering?.launchMode) ? saved.dysonEngineering.launchMode : initial.dysonEngineering.launchMode,
    launchThrottle: validDysonLaunchThrottle(saved.dysonEngineering?.launchThrottle) ? saved.dysonEngineering.launchThrottle : initial.dysonEngineering.launchThrottle,
    launchEnabled: typeof saved.dysonEngineering?.launchEnabled === "boolean" ? saved.dysonEngineering.launchEnabled : true,
    activeOrbitBySystem: { ...initial.dysonEngineering.activeOrbitBySystem },
    orbitsBySystem: { ...initial.dysonEngineering.orbitsBySystem },
    absorptionProgressBySystem: { ...initial.dysonEngineering.absorptionProgressBySystem },
    launchEnergySpentMj: saved.version >= 22 ? nonNegativeNumber(saved.dysonEngineering?.launchEnergySpentMj) : 0,
  };
  const persistedOrbitData = saved.version >= 22 &&
    saved.dysonEngineering?.orbitsBySystem &&
    Object.values(saved.dysonEngineering.orbitsBySystem).some((value) => Array.isArray(value));
  for (const systemId of Object.keys(STAR_SYSTEMS) as StarSystemId[]) {
    const rawOrbits = saved.version >= 22 ? saved.dysonEngineering?.orbitsBySystem?.[systemId] : undefined;
    const parsedOrbits: DysonSwarmOrbitState[] = Array.isArray(rawOrbits) ? rawOrbits.flatMap((orbit: Record<string, any>, index: number) => {
      if (typeof orbit.id !== "string" || !orbit.id) return [];
      return [{
        id: orbit.id,
        name: typeof orbit.name === "string" && orbit.name.trim() ? orbit.name.trim().slice(0, 24) : defaultDysonOrbit(systemId, index).name,
        radius: Math.max(5_000, Math.min(50_000, Math.round(typeof orbit.radius === "number" ? orbit.radius : defaultDysonOrbit(systemId, index).radius))),
        inclination: Math.max(-90, Math.min(90, Math.round(typeof orbit.inclination === "number" ? orbit.inclination : 0))),
        longitude: ((typeof orbit.longitude === "number" ? orbit.longitude : 0) % 360 + 360) % 360,
        sailsInOrbit: nonNegativeInteger(orbit.sailsInOrbit),
        totalLaunched: nonNegativeInteger(orbit.totalLaunched),
        totalExpired: nonNegativeInteger(orbit.totalExpired),
        decayProgress: nonNegativeNumber(orbit.decayProgress) % 1,
        generationKw: nonNegativeNumber(orbit.sailsInOrbit) * SOLAR_SAIL_POWER_KW * dysonPowerMultiplier * getStarLuminosity({ galaxy }, systemId),
      } satisfies DysonSwarmOrbitState];
    }) : [];
    const orbits = parsedOrbits.length > 0 ? parsedOrbits.slice(0, 8) : [defaultDysonOrbit(systemId)];
    dysonEngineering.orbitsBySystem[systemId] = orbits;
    const active = saved.version >= 22 ? saved.dysonEngineering?.activeOrbitBySystem?.[systemId] : undefined;
    dysonEngineering.activeOrbitBySystem[systemId] = typeof active === "string" && orbits.some((orbit) => orbit.id === active)
      ? active
      : orbits[0].id;
    dysonEngineering.absorptionProgressBySystem[systemId] = persistedOrbitData
      ? nonNegativeNumber(saved.dysonEngineering?.absorptionProgressBySystem?.[systemId]) % 1
      : systemId === "helios" ? dysonSphere.absorptionProgress : 0;
  }
  for (const entity of entities) {
    if (entity.buildingId !== "em_rail_ejector" || entity.targetDysonOrbitId) continue;
    const systemId = getPlanet(entity.planetId).systemId;
    entity.targetDysonOrbitId = dysonEngineering.activeOrbitBySystem[systemId] ?? dysonEngineering.orbitsBySystem[systemId]?.[0]?.id;
  }
  if (!persistedOrbitData) {
    const legacyOrbit = dysonEngineering.orbitsBySystem.helios[0];
    legacyOrbit.sailsInOrbit = sailsInOrbit;
    legacyOrbit.totalLaunched = totalLaunched;
    legacyOrbit.totalExpired = totalExpired;
    legacyOrbit.decayProgress = dysonSwarm.decayProgress;
    legacyOrbit.generationKw = swarmGenerationKw;
  }
  const migratedOrbits = Object.values(dysonEngineering.orbitsBySystem).flat();
  dysonSwarm.sailsInOrbit = migratedOrbits.reduce((sum, orbit) => sum + orbit.sailsInOrbit, 0);
  dysonSwarm.totalLaunched = migratedOrbits.reduce((sum, orbit) => sum + orbit.totalLaunched, 0);
  dysonSwarm.totalExpired = migratedOrbits.reduce((sum, orbit) => sum + orbit.totalExpired, 0);
  dysonSwarm.generationKw = Math.floor(migratedOrbits.reduce((sum, orbit) => sum + orbit.generationKw, 0));
  dysonSwarm.receiverLoadKw = Math.min(dysonSwarm.generationKw + dysonSphere.generationKw, dysonSwarm.receiverLoadKw);
  const settings: GameState["settings"] = {
    simulationSpeed: validSimulationSpeed(saved.settings?.simulationSpeed)
      ? saved.settings.simulationSpeed
      : initial.settings.simulationSpeed,
    fontScale: validFontScale(saved.settings?.fontScale)
      ? saved.settings.fontScale
      : initial.settings.fontScale,
    theme: saved.settings?.theme === "light" || saved.settings?.theme === "system"
      ? saved.settings.theme
      : "dark",
    technologyLayout: saved.settings?.technologyLayout === "compact" ? "compact" : "standard",
    performanceMode: typeof saved.settings?.performanceMode === "boolean"
      ? saved.settings.performanceMode
      : initial.settings.performanceMode,
    reducedMotion: typeof saved.settings?.reducedMotion === "boolean"
      ? saved.settings.reducedMotion
      : initial.settings.reducedMotion,
    soundEnabled: typeof saved.settings?.soundEnabled === "boolean"
      ? saved.settings.soundEnabled
      : initial.settings.soundEnabled,
    allowDoubleClickZoom: typeof saved.settings?.allowDoubleClickZoom === "boolean"
      ? saved.settings.allowDoubleClickZoom
      : initial.settings.allowDoubleClickZoom,
    beltHeatmapEnabled: typeof saved.settings?.beltHeatmapEnabled === "boolean"
      ? saved.settings.beltHeatmapEnabled
      : initial.settings.beltHeatmapEnabled,
    defaultBeltStackSize: validCargoStackSize(saved.settings?.defaultBeltStackSize)
      ? saved.settings.defaultBeltStackSize
      : initial.settings.defaultBeltStackSize,
    defaultBeltRouteMode: validDefaultBeltRouteMode(saved.settings?.defaultBeltRouteMode)
      ? saved.settings.defaultBeltRouteMode
      : initial.settings.defaultBeltRouteMode,
    productionBufferLimit: normalizedBuildingBufferLimit(saved.settings?.productionBufferLimit),
    logisticsBufferLimit: normalizedBuildingBufferLimit(saved.settings?.logisticsBufferLimit),
    beltBufferLimit: normalizedBuildingBufferLimit(saved.settings?.beltBufferLimit ?? 100_000_000),
    proliferatorBufferLimit: normalizedProliferatorBufferLimit(saved.settings?.proliferatorBufferLimit),
    autosaveIntervalSeconds: validAutosaveInterval(saved.settings?.autosaveIntervalSeconds)
      ? saved.settings.autosaveIntervalSeconds
      : initial.settings.autosaveIntervalSeconds,
    autoShortageNavigation: typeof saved.settings?.autoShortageNavigation === "boolean"
      ? saved.settings.autoShortageNavigation
      : initial.settings.autoShortageNavigation,
    resourceMode: saved.version >= 20 && saved.settings?.resourceMode === "finite" ? "finite" : "infinite",
    difficulty: isDifficultyMode(saved.settings?.difficulty) ? saved.settings.difficulty : initial.settings.difficulty,
  };

  const recipeFocus: GameState["recipeFocus"] = {
    itemId: typeof saved.recipeFocus?.itemId === "string" && saved.recipeFocus.itemId in ITEMS ? saved.recipeFocus.itemId as ItemId : null,
    mode: saved.recipeFocus?.mode === "full" ? "full" : "two-level",
    position: {
      x: typeof saved.recipeFocus?.position?.x === "number" && Number.isFinite(saved.recipeFocus.position.x) ? Math.max(8, Math.round(saved.recipeFocus.position.x)) : initial.recipeFocus.position.x,
      y: typeof saved.recipeFocus?.position?.y === "number" && Number.isFinite(saved.recipeFocus.position.y) ? Math.max(8, Math.round(saved.recipeFocus.position.y)) : initial.recipeFocus.position.y,
    },
  };

  const canvasBookmarks: GameState["canvasBookmarks"] = Array.isArray(saved.canvasBookmarks)
    ? saved.canvasBookmarks.slice(-24).flatMap((bookmark: Record<string, any>, index: number) => {
      if (!validPlanetId(bookmark.planetId) || typeof bookmark.viewport !== "object" ||
        !Number.isFinite(bookmark.viewport?.x) || !Number.isFinite(bookmark.viewport?.y) ||
        !Number.isFinite(bookmark.viewport?.zoom)) return [];
      return [{
        id: typeof bookmark.id === "string" && bookmark.id ? bookmark.id : `bookmark_migrated_${index + 1}`,
        name: typeof bookmark.name === "string" && bookmark.name.trim()
          ? bookmark.name.trim().slice(0, 28)
          : `${getPlanet(bookmark.planetId).name}视角`,
        planetId: bookmark.planetId,
        viewport: {
          x: Math.round(bookmark.viewport.x),
          y: Math.round(bookmark.viewport.y),
          zoom: Math.max(0.1, Math.min(2.5, Math.round(bookmark.viewport.zoom * 100) / 100)),
        },
        createdAtSeconds: nonNegativeNumber(bookmark.createdAtSeconds),
      }];
    })
    : [];

  const validCanvasColor = (value: unknown, fallback: string): string =>
    typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : fallback;
  const canvasRegions: CanvasRegion[] = saved.version >= 27 && Array.isArray(saved.canvasRegions)
    ? saved.canvasRegions.slice(-48).flatMap((region: Record<string, any>, index: number) => {
      if (!validPlanetId(region.planetId) || !Number.isFinite(region.x) || !Number.isFinite(region.y) ||
        !Number.isFinite(region.width) || !Number.isFinite(region.height)) return [];
      const width = Math.max(40, Math.min(20_000, Math.round(region.width)));
      const height = Math.max(40, Math.min(20_000, Math.round(region.height)));
      return [{
        id: typeof region.id === "string" && region.id ? region.id : `region_migrated_${index + 1}`,
        name: typeof region.name === "string" && region.name.trim() ? region.name.trim().slice(0, 28) : `生产区域 ${index + 1}`,
        planetId: region.planetId,
        x: Math.round(region.x),
        y: Math.round(region.y),
        width,
        height,
        fillColor: validCanvasColor(region.fillColor, "#2C6B66"),
        borderColor: validCanvasColor(region.borderColor, "#67C7B5"),
      } satisfies CanvasRegion];
    })
    : [];

  const powerGridMetrics: GameState["powerGridMetrics"] = Object.fromEntries(PLANET_LIST.map((planet) => [
    planet.id,
    Object.fromEntries(Object.entries(initial.powerGridMetrics[planet.id]).map(([gridId, metrics]) => [
      gridId,
      { ...metrics, ...(saved.powerGridMetrics?.[planet.id]?.[gridId] ?? {}) },
    ])),
  ])) as GameState["powerGridMetrics"];
  const unlockedAchievementIds = Array.isArray(saved.achievements?.unlockedIds)
    ? [...new Set(saved.achievements.unlockedIds.filter(isAchievementId))]
    : [];
  const systemSpaceStations = normalizeSystemSpaceStations(saved);
  const galacticHubNetwork = normalizeGalacticHubNetwork(saved);
  const quantumLogisticsNetwork = saved.version >= 44
    ? normalizeQuantumLogisticsNetworkState(saved.quantumLogisticsNetwork)
    : createEmptyQuantumLogisticsNetworkState();
  const requestedTimeWarpMultiplier = Number.isSafeInteger(saved.timeWarp?.requestedMultiplier)
    ? Math.max(5, saved.timeWarp.requestedMultiplier)
    : 5;
  const controllerEntityId = typeof saved.timeWarp?.controllerEntityId === "string" &&
    entities.some((entity) => entity.id === saved.timeWarp.controllerEntityId && entity.buildingId === "time_warp_device")
    ? saved.timeWarp.controllerEntityId as string
    : null;
  const timeWarp: GameState["timeWarp"] = {
    controllerEntityId,
    enabled: Boolean(controllerEntityId && saved.timeWarp?.enabled),
    requestedMultiplier: requestedTimeWarpMultiplier,
    effectiveMultiplier: validSimulationSpeed(saved.settings?.simulationSpeed) ? saved.settings.simulationSpeed : 1,
    pendingSimulationSeconds: Math.min(30 * 24 * 60 * 60, nonNegativeNumber(saved.timeWarp?.pendingSimulationSeconds)),
    pendingWallSeconds: Math.min(30 * 24 * 60 * 60, nonNegativeNumber(saved.timeWarp?.pendingWallSeconds)),
    requiredPowerKw: 0,
    allocatedPowerKw: 0,
  };
  // Missing mode values are never promoted to ranked play. Legacy saves stay
  // readable, but only an explicit speedrun marker can preserve that mode.
  const mode: SaveMode = saved.mode === "speedrun" ? "speedrun" : "normal";
  const idleSettlement = normalizeIdleSettlementState(saved.idleSettlement);
  const speedrun = mode === "speedrun"
    ? normalizeSpeedrunState(saved.speedrun)
    : saved.speedrun
      ? normalizeSpeedrunState({ ...saved.speedrun, eligible: false, invalidReason: saved.speedrun.invalidReason ?? "缺少明确的速通模式标记" })
      : undefined;
  const hasPlacedGalacticExporter = entities.some((entity) => entity.buildingId === "galactic_material_exporter");
  if (hasPlacedGalacticExporter) endgame.exportInputMode = "building";
  if (saved.version < 33 && completedTechIds.includes("universe_matrix") && !hasPlacedGalacticExporter &&
    Math.floor(construction.galactic_material_exporter ?? 0) < 1) {
    construction.galactic_material_exporter = 1;
  }

  const migrated = {
    ...initial,
    ...saved,
    version: 46,
    mode,
    activePlanetId,
    entities,
    belts,
    cargo: saved.cargo ? { ...saved.cargo, amount: Math.max(1, Math.floor(saved.cargo.amount ?? 1)) } : null,
    tray: { ...planetTrays[activePlanetId] },
    planetTrays,
    planetTrayItemLimits,
    construction,
    constructionAutomation,
    portableFleet,
    totalProduced: integerRecord(saved.totalProduced),
    research: {
      selectedTechId,
      pausedTechId,
      queuedTechIds,
      progressByTech: researchProgress(saved.research?.progressByTech),
      completedTechIds,
    },
    exploration: { unlockedSystemIds, colonizedPlanetIds, missions, surveyProgressBySystem },
    galaxy,
    recipeFocus,
    settings,
    contentPacks: saved.version >= 40 && Array.isArray(saved.contentPacks)
      ? saved.contentPacks.slice(0, 64).flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return [];
        const id = (entry as { id?: unknown }).id;
        const version = (entry as { version?: unknown }).version;
        return typeof id === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(id) && typeof version === "string" && version.length <= 40
          ? [{ id, version }]
          : [];
      })
      : [],
    achievements: { unlockedIds: unlockedAchievementIds },
    campaign: normalizeCampaignState(saved.campaign),
    planetViewports,
    canvasBookmarks,
    canvasRegions,
    blueprints,
    blueprintVersions,
    constructionQueue,
    handcraftQueue,
    productionPlans,
    productionHistory,
    historyRecordedAt: Math.max(
      nonNegativeNumber(saved.historyRecordedAt),
      productionHistory.at(-1)?.elapsedSeconds ?? 0,
    ),
    idleSettlement,
    speedrun,
    metrics: { ...planetMetrics[activePlanetId] },
    planetMetrics,
    powerGridMetrics,
    dysonSwarm,
    dysonSphere,
    dysonEngineering,
    dysonPlans,
    systemSpaceStations,
    galacticHubNetwork,
    quantumLogisticsNetwork,
    timeWarp,
    endgame,
  } as GameState;
  // Repair a v46 save that crossed a finite research boundary without the
  // corresponding engine event.  The helper is idempotent and only clamps
  // already-complete progress to its declared cost before granting the normal
  // technology rewards and queue transition.
  const repairedResearch = settleCompletedResearchBoundaries(migrated);
  // A valid legacy run can contain the cumulative total before its derived
  // speedrun milestone was persisted. Repair only that derived marker from
  // the authoritative counters; ordinary saves and the v46 shape stay intact.
  const repairedSpeedrun = evaluateSpeedrunMilestones(repairedResearch);
  return syncCampaignProgress(repairedSpeedrun, { grantRewards: saved.version >= 18 });
}

/** Detach runtime-only fields before handing a snapshot to the save Worker. */
export function prepareSaveStateForBackground(
  state: GameState,
  contentPackRegistry: ContentPackRegistry = loadContentPackRegistry(),
): GameState {
  // postMessage performs the one authoritative structured clone synchronously.
  // Avoid creating another full JSON clone on the UI thread before that copy.
  return projectPersistentSaveState(state, contentPackRegistry);
}

function buildOfflineReport(before: GameState, after: GameState, seconds: number): OfflineReport {
  const produced = (Object.keys(ITEMS) as ItemId[]).flatMap((itemId) => {
    const amount = Math.max(0, Math.floor((after.totalProduced[itemId] ?? 0) - (before.totalProduced[itemId] ?? 0)));
    return amount > 0 ? [{ itemId, amount }] : [];
  }).sort((left, right) => right.amount - left.amount);
  const beforeTechIds = new Set(before.research.completedTechIds);
  const infiniteResearchLevels = (Object.keys(after.endgame.infiniteResearch) as InfiniteResearchId[]).flatMap((id) => {
    const beforeLevel = before.endgame.infiniteResearch[id]?.level ?? 0;
    const afterLevel = after.endgame.infiniteResearch[id]?.level ?? 0;
    return afterLevel > beforeLevel ? [{ id, level: afterLevel - beforeLevel }] : [];
  });
  const exported = (Object.keys(after.endgame.exportProjects) as GalacticExportProjectId[]).flatMap((projectId) => {
    const amount = Math.max(0, (after.endgame.exportProjects[projectId]?.totalDelivered ?? 0) -
      (before.endgame.exportProjects[projectId]?.totalDelivered ?? 0));
    return amount > 0 ? [{ projectId, amount }] : [];
  });
  return {
    seconds,
    settlement: {
      status: "exact",
      committed: true,
      rewardsSubmitted: true,
      originalSeconds: seconds,
      submittedSeconds: seconds,
    },
    produced,
    completedTechIds: after.research.completedTechIds.filter((techId) => !beforeTechIds.has(techId)),
    structurePointsAdded: Math.max(0, after.dysonSphere.structurePoints - before.dysonSphere.structurePoints),
    shellSailsAdded: Math.max(0, after.dysonSphere.shellSails - before.dysonSphere.shellSails),
    infiniteResearchLevels,
    exported,
    galacticCreditsAdded: Math.max(0, after.endgame.galacticCredits - before.endgame.galacticCredits),
  };
}

export function returningRewardClaimKey(savedAt: number): string {
  return `${RETURNING_REWARD_KEY_PREFIX}.${Math.floor(savedAt)}`;
}

export function hasReturningRewardClaim(savedAt: number): boolean {
  try { return Boolean(window.localStorage.getItem(returningRewardClaimKey(savedAt))); } catch { return false; }
}

export function markReturningRewardClaimed(savedAt: number): void {
  try { window.localStorage.setItem(returningRewardClaimKey(savedAt), String(Date.now())); } catch { /* optional reward receipt */ }
}

/** Pure reward application used by both the foreground loader and upload Worker. */
export function applyReturningRewardToState(
  state: GameState,
  savedAt: number,
  seconds: number,
  alreadyClaimed = false,
): { state: GameState; reward: Array<{ itemId: ItemId; amount: number }> } {
  if (seconds < RETURNING_REWARD_MIN_SECONDS || alreadyClaimed) return { state, reward: [] };
  const amount = Math.min(2_000, Math.max(240, Math.floor(seconds / 3600) * 4));
  const reward = (["iron_ore", "copper_ore", "stone", "coal"] as ItemId[]).map((itemId) => ({ itemId, amount }));
  const rawLimit = state.planetTrayItemLimits?.[state.activePlanetId];
  const limit = Number.isFinite(rawLimit)
    ? Math.max(MIN_PLANET_TRAY_ITEM_LIMIT, Math.min(MAX_PLANET_TRAY_ITEM_LIMIT, Math.floor(rawLimit)))
    : DEFAULT_PLANET_TRAY_ITEM_LIMIT;
  if (reward.some((entry) => Math.floor(state.tray[entry.itemId] ?? 0) + entry.amount > limit)) {
    return { state, reward: [] };
  }
  const tray = { ...state.tray };
  for (const entry of reward) tray[entry.itemId] = Math.floor((tray[entry.itemId] ?? 0) + entry.amount);
  const next = {
    ...state,
    tray,
    planetTrays: { ...state.planetTrays, [state.activePlanetId]: { ...tray } },
  };
  return { state: next, reward };
}

function applyReturningReward(state: GameState, savedAt: number, seconds: number): { state: GameState; reward: Array<{ itemId: ItemId; amount: number }> } {
  const returning = applyReturningRewardToState(state, savedAt, seconds, hasReturningRewardClaim(savedAt));
  if (returning.reward.length > 0) markReturningRewardClaimed(savedAt);
  return returning;
}

/** Inspect an imported or locally stored envelope without advancing time. */
export function inspectSave(raw: string, contentPackRegistry?: ContentPackRegistry): SaveInspection {
  const invalid = (issues: string[], formatVersion: number | null = null, stateVersion: number | null = null): SaveInspection => ({
    valid: false,
    repairable: false,
    integrity: "corrupt",
    formatVersion,
    stateVersion,
    savedAt: null,
    mode: "normal",
    slot: "main",
    checksum: "invalid",
    recordedChecksum: null,
    computedChecksum: null,
    issues,
    state: null,
    summary: null,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid(["无法解析 JSON 文件"]);
  }
  if (!isRecord(parsed)) return invalid(["存档根节点必须是对象"]);

  const hasEnvelope = "state" in parsed;
  const envelope = hasEnvelope ? parsed : { state: parsed, savedAt: Date.now() };
  if (!isRecord(envelope.state)) return invalid(["存档缺少有效的 state 数据"]);
  if (envelope.slot !== undefined && !["main", 1, 2, 3].includes(envelope.slot as never)) return invalid(["存档槽位信息无效"]);
  if (envelope.mode !== undefined && envelope.mode !== "normal" && envelope.mode !== "speedrun") {
    return invalid(["存档模式标记无效"]);
  }
  const rawStateMode = envelope.state.mode;
  if (rawStateMode !== undefined && rawStateMode !== "normal" && rawStateMode !== "speedrun") {
    return invalid(["游戏状态模式标记无效"]);
  }
  if (envelope.mode !== undefined && rawStateMode !== undefined && envelope.mode !== rawStateMode) {
    return invalid(["存档模式标记与状态不一致，已阻止导入"]);
  }
  if (envelope.mode === "speedrun" && rawStateMode !== "speedrun") {
    return invalid(["速通存档缺少一致的状态模式标记，已阻止静默转换"]);
  }
  const envelopeSlot = normalizeSaveSlot(envelope.slot);

  const rawFormatVersion = envelope.formatVersion;
  const formatVersion = typeof rawFormatVersion === "number" && Number.isFinite(rawFormatVersion)
    ? Math.floor(rawFormatVersion)
    : 1;
  const rawStateVersion = envelope.state.version;
  const stateVersion = typeof rawStateVersion === "number" && Number.isFinite(rawStateVersion)
    ? Math.floor(rawStateVersion)
    : null;
  const savedAt = typeof envelope.savedAt === "number" && Number.isFinite(envelope.savedAt)
    ? envelope.savedAt
    : Date.now();
  const issues: string[] = [];
  if (formatVersion < 1) return invalid(["存档格式版本无效"], formatVersion, stateVersion);
  if (formatVersion > SAVE_FORMAT_VERSION) {
    return invalid([`存档格式 v${formatVersion} 高于当前客户端支持的 v${SAVE_FORMAT_VERSION}`], formatVersion, stateVersion);
  }
  const requiredPacks = Array.isArray(envelope.state.contentPacks)
    ? envelope.state.contentPacks.filter((entry: unknown) => entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" && typeof (entry as { version?: unknown }).version === "string") as Array<{ id: string; version: string }>
    : [];
  const missingPacks = getMissingContentPackRequirements(requiredPacks, contentPackRegistry);
  if (missingPacks.length > 0) return invalid([`无法加载存档：${missingPacks.join("；")}`], formatVersion, stateVersion);

  let checksum: SaveInspection["checksum"] = "missing";
  let checksumMatchedAfterMigration = false;
  let recordedChecksum: string | null = null;
  let computedChecksum: string | null = null;
  if (typeof envelope.checksum === "string" && envelope.checksum.length > 0) {
    recordedChecksum = envelope.checksum;
    computedChecksum = computeSaveStateChecksum(formatVersion, envelope.state);
    const legacyExpected = legacyChecksumFor(formatVersion, envelope.state);
    checksum = envelope.checksum === computedChecksum || envelope.checksum === legacyExpected ? "valid" : "invalid";
  } else {
    issues.push("旧版存档没有完整性校验，导入后会自动补写");
  }

  const envelopeMode: SaveMode = envelope.mode === "speedrun" ? "speedrun" : "normal";
  const migrationState = envelope.mode === undefined
    ? envelope.state
    : rawStateMode === undefined ? { ...envelope.state, mode: envelopeMode } : envelope.state;
  let state: GameState | null = null;
  try {
    state = migrateGame(migrationState, contentPackRegistry);
  } catch (error) {
    if (error instanceof UnsafePersistedQuantityError) {
      const reason = error.reason === "unsafe"
        ? "超过 Number.MAX_SAFE_INTEGER，已阻止危险转换。"
        : "不是合法的非负安全整数，已阻止静默截断或补零。";
      return invalid([
        `${error.field}=${String(error.value)} ${reason}`,
        "请保留原始存档并立即导出备份，不要覆盖现有文件；该存档需要受控救援后才能载入。",
      ], formatVersion, stateVersion);
    }
    return invalid(["存档数据结构无法修复"], formatVersion, stateVersion);
  }
  if (!state) return invalid(["游戏状态版本不受支持或缺少实体列表"], formatVersion, stateVersion);
  if (envelope.mode !== undefined && state.mode !== envelopeMode) {
    return invalid(["存档模式标记与状态不一致，已阻止导入"], formatVersion, stateVersion);
  }

  if (checksum === "invalid" && typeof envelope.checksum === "string") {
    // Unknown legacy fields (for example an achievement added by a newer
    // client) are removed by migration. Accept that lossless normalization,
    // but still reject changes to meaningful game state.
    checksumMatchedAfterMigration = envelope.checksum === computeSaveStateChecksum(formatVersion, state) ||
      envelope.checksum === legacyChecksumFor(formatVersion, state);
    if (!checksumMatchedAfterMigration) {
      const summary = { ...summaryForState(state), savedAt };
      return {
        valid: false,
        repairable: true,
        integrity: "corrupt",
        formatVersion,
        stateVersion,
        savedAt,
        mode: state.mode,
        slot: envelopeSlot,
        checksum: "invalid",
        recordedChecksum,
        computedChecksum,
        issues: [`完整性校验失败：记录 ${recordedChecksum ?? "缺失"}，实际 ${computedChecksum ?? "无法计算"}。结构完整，可使用受控救援。`],
        state,
        summary,
      };
    }
    checksum = "valid";
    issues.push("检测到可忽略的旧字段差异，已按当前目录标准化");
  }

  const migrated = stateVersion !== state.version;
  const formatUpgrade = formatVersion < SAVE_FORMAT_VERSION || !hasEnvelope;
  if (migrated) issues.push(`游戏状态已从 v${stateVersion ?? "未知"} 迁移到 v${state.version}`);
  if (!hasEnvelope) issues.push("检测到旧版裸状态格式");
  if (formatUpgrade && !hasEnvelope) issues.push(`导入后会升级到存档格式 v${SAVE_FORMAT_VERSION}`);
  const oversizedEntityStacks = state.entities.filter((entity) =>
    entity.machineCount > MAX_BUILDING_STACK_COUNT || entity.minerCount > MAX_BUILDING_STACK_COUNT).length;
  const oversizedBlueprintStacks = [
    ...state.blueprints,
    ...state.blueprintVersions.map((snapshot) => snapshot.definition),
  ].reduce((sum, blueprint) => sum + blueprint.entities.filter((entity) => entity.machineCount > MAX_BUILDING_STACK_COUNT).length +
    (blueprint.resourceAnchors ?? []).filter((anchor) => anchor.minerCount > MAX_BUILDING_STACK_COUNT).length, 0);
  if (oversizedEntityStacks > 0) {
    issues.push(`检测到 ${oversizedEntityStacks} 个历史建筑堆叠超过 1 亿，数量已原样保留；可以回收但不能继续增加。`);
  }
  if (oversizedBlueprintStacks > 0) {
    issues.push(`检测到 ${oversizedBlueprintStacks} 个历史蓝图堆叠超过 1 亿，数量已原样保留；该蓝图需降至上限内才能部署。`);
  }
  const integrity: SaveIntegrityStatus = migrated || formatUpgrade || checksumMatchedAfterMigration
    ? "repaired"
    : checksum === "missing" ? "legacy" : "valid";
  const summary = {
    ...summaryForState(state),
    savedAt,
  };
  return {
    valid: true,
    repairable: true,
    integrity,
    formatVersion,
    stateVersion,
    savedAt,
    mode: state.mode,
    slot: envelopeSlot,
    checksum,
    recordedChecksum,
    computedChecksum,
    issues,
    state,
    summary,
  };
}

/**
 * Parse a payload that has already passed decodeVerifiedSaveTransfer. The
 * transferable byte hash makes the Worker-produced envelope authoritative, so
 * this path performs one JSON parse plus the normal version migration without
 * recomputing the same 20+ MB state checksum on the UI thread.
 */
export function parseTrustedWorkerEnvelope(
  raw: string,
  verification: SaveTransferVerification,
  contentPackRegistry: ContentPackRegistry = loadContentPackRegistry(),
  options: { persistentProjection?: boolean } = {},
): GameState {
  if (verification.integrity !== "valid" || !verification.stateChecksum) {
    throw new Error("Worker 存档缺少完整性证明");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Worker 存档无法解析");
  }
  if (!isRecord(parsed) || parsed.formatVersion !== SAVE_FORMAT_VERSION ||
    !isRecord(parsed.state) || parsed.checksum !== verification.stateChecksum) {
    throw new Error("Worker 存档信封与完整性证明不一致");
  }
  if (parsed.mode !== "normal" && parsed.mode !== "speedrun") throw new Error("Worker 存档模式无效");
  if (parsed.slot !== "main" && parsed.slot !== 1 && parsed.slot !== 2 && parsed.slot !== 3) {
    throw new Error("Worker 存档槽位无效");
  }
  const requiredPacks = Array.isArray(parsed.state.contentPacks)
    ? parsed.state.contentPacks.filter((entry: unknown) => isRecord(entry) && typeof entry.id === "string" && typeof entry.version === "string") as Array<{ id: string; version: string }>
    : [];
  const missingPacks = getMissingContentPackRequirements(requiredPacks, contentPackRegistry);
  if (missingPacks.length > 0) throw new MissingContentPacksError(missingPacks);
  if (options.persistentProjection === false) {
    const state = parsed.state as unknown as GameState;
    if (state.mode !== parsed.mode || !Number.isFinite(state.version) ||
      !Array.isArray(state.entities) || !Array.isArray(state.belts) ||
      !isRecord(state.research) || !isRecord(state.timeWarp) || !isRecord(state.dysonSphere)) {
      throw new Error("Worker 运行态结构或模式校验失败");
    }
    return state;
  }
  const state = migrateGame(parsed.state, contentPackRegistry);
  if (!state || state.mode !== parsed.mode) throw new Error("Worker 存档迁移或模式校验失败");
  return state;
}

export interface SaveRepairResult {
  success: boolean;
  raw: string | null;
  inspection: SaveInspection;
  message: string;
}

/** Re-sign a structurally valid save after the player has preserved the original file. */
export function repairSave(raw: string): SaveRepairResult {
  const inspection = inspectSave(raw);
  if (inspection.valid) return { success: true, raw, inspection, message: "存档无需救援" };
  if (!inspection.repairable || !inspection.state) {
    return { success: false, raw: null, inspection, message: inspection.issues[0] ?? "存档结构无法救援" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SaveEnvelope>;
    const kind = parsed.kind === "slot" || parsed.kind === "snapshot" ? parsed.kind : "primary";
    const repairedRaw = serializeEnvelope(inspection.state, inspection.savedAt ?? Date.now(), kind, parsed.reason, loadContentPackRegistry(), parsed.slot ?? "main");
    const repairedInspection = inspectSave(repairedRaw);
    if (!repairedInspection.valid || repairedInspection.checksum !== "valid") throw new Error("救援结果复核失败");
    return { success: true, raw: repairedRaw, inspection: repairedInspection, message: "存档已重新校验" };
  } catch (error) {
    return { success: false, raw: null, inspection, message: error instanceof Error ? error.message : "存档救援失败" };
  }
}

function parseEnvelope(raw: string, advanceOffline: boolean): LoadedGame | null {
  const parsed = JSON.parse(raw) as { state?: { contentPacks?: Array<{ id: string; version: string }> } };
  const missingPacks = getMissingContentPackRequirements(parsed.state?.contentPacks ?? []);
  if (missingPacks.length > 0) throw new MissingContentPacksError(missingPacks);
  const inspection = inspectSave(raw);
  if (!inspection.valid || !inspection.state) return null;
  const state = inspection.state;
  const savedAt = inspection.savedAt ?? Date.now();
  const offlineSeconds = advanceOffline && !state.paused
    ? Math.min(getOfflineSimulationLimitSeconds(state), Math.max(0, (Date.now() - savedAt) / 1000))
    : 0;
  const advanced = offlineSeconds >= 1 ? advanceSimulation(state, offlineSeconds) : state;
  const returning = applyReturningReward(advanced, savedAt, offlineSeconds);
  const report = offlineSeconds >= 1 ? buildOfflineReport(state, returning.state, offlineSeconds) : null;
  if (report && returning.reward.length > 0) report.returningReward = returning.reward;
  return {
    state: returning.state,
    offlineSeconds,
    offlineReport: report,
  };
}

function parseDeferredEnvelope(raw: string): DeferredLoadedGame | null {
  const parsed = JSON.parse(raw) as { state?: { contentPacks?: Array<{ id: string; version: string }> } };
  const missingPacks = getMissingContentPackRequirements(parsed.state?.contentPacks ?? []);
  if (missingPacks.length > 0) throw new MissingContentPacksError(missingPacks);
  const inspection = inspectSave(raw);
  if (!inspection.valid || !inspection.state) return null;
  const state = inspection.state;
  const savedAt = inspection.savedAt ?? Date.now();
  const offlineSeconds = !state.paused
    ? Math.min(getOfflineSimulationLimitSeconds(state), Math.max(0, (Date.now() - savedAt) / 1000))
    : 0;
  return { state, savedAt, offlineSeconds, offlineReport: null };
}

export function finalizeDeferredOfflineGame(
  loaded: DeferredLoadedGame,
  advancedState: GameState,
  details: { approximation?: OfflineApproximationReport; complexity?: OfflineComplexityReport } = {},
): LoadedGame {
  if (loaded.offlineSeconds < 1) {
    return { state: loaded.state, offlineSeconds: 0, offlineReport: null, recovery: loaded.recovery };
  }
  const returning = applyReturningReward(advancedState, loaded.savedAt, loaded.offlineSeconds);
  const report = buildOfflineReport(loaded.state, returning.state, loaded.offlineSeconds);
  if (details.approximation) report.approximation = details.approximation;
  if (details.complexity) report.complexity = details.complexity;
  report.settlement = {
    status: details.approximation?.settlementStatus === "approximate" ? "approximate" : "exact",
    committed: true,
    rewardsSubmitted: true,
    originalSeconds: loaded.offlineSeconds,
    submittedSeconds: loaded.offlineSeconds,
  };
  if (returning.reward.length > 0) report.returningReward = returning.reward;
  return { state: returning.state, offlineSeconds: loaded.offlineSeconds, offlineReport: report, recovery: loaded.recovery };
}

export function skipDeferredOfflineGame(
  loaded: DeferredLoadedGame,
  reason: string,
  failureKind: OfflineSettlementFailureKind,
  preview?: OfflineApproximationReport,
  complexity?: OfflineComplexityReport,
): LoadedGame {
  if (loaded.state.mode === "speedrun" || loaded.state.speedrun?.enabled) {
    throw new Error("速通存档必须完成精确离线结算，不能跳过收益并推进计时");
  }
  // Explicitly confirmed skip is the sole clock-only settlement path. It
  // consumes the pending interval while preserving every production,
  // inventory, cache, research and Dyson field byte-for-byte.
  const skippedState = {
    ...loaded.state,
    elapsedSeconds: loaded.state.elapsedSeconds + loaded.offlineSeconds,
  };
  const report = buildOfflineReport(loaded.state, skippedState, loaded.offlineSeconds);
  report.settlement = {
    status: "conservative-skipped",
    committed: true,
    rewardsSubmitted: false,
    originalSeconds: loaded.offlineSeconds,
    submittedSeconds: loaded.offlineSeconds,
    failureKind,
    failureReason: reason,
  };
  if (preview) report.approximation = { ...preview, settlementStatus: "conservative-skipped" };
  if (complexity) report.complexity = complexity;
  return { state: skippedState, offlineSeconds: loaded.offlineSeconds, offlineReport: report, recovery: loaded.recovery };
}

/**
 * Return a transient view of the source state without applying simulation or
 * rewards. Do not persist or enter this result: menu cancellation must discard
 * the loaded copy so savedAt and the pending offline interval remain intact.
 */
export function cancelDeferredOfflineGame(loaded: DeferredLoadedGame): LoadedGame {
  return { state: loaded.state, offlineSeconds: 0, offlineReport: null, recovery: loaded.recovery };
}

export function loadGame(mode: SaveMode = "normal"): LoadedGame {
  try {
    const primaryKey = primarySaveKey(mode);
    const backupKey = backupSaveKey(mode);
    const candidates: Array<{ source: SaveRecovery["source"]; raw: string | null; issues?: string[] }> = [
      { source: "primary", raw: readPrimaryOrEmergency(mode) },
      { source: "backup", raw: getLocalSaveValue(backupKey) ?? (mode === "normal" ? getLocalSaveValue(SAVE_BACKUP_KEY) : null), issues: ["主存档校验失败，已回退到最近一次有效备份"] },
    ];
    for (const key of listSnapshotKeys(mode)) {
      candidates.push({ source: "snapshot", raw: getLocalSaveValue(key), issues: ["主存档不可用，已回退到自动快照"] });
    }
    for (const candidate of candidates) {
      if (!candidate.raw) continue;
      let loaded: LoadedGame | null = null;
      try {
        loaded = parseEnvelope(candidate.raw, true);
      } catch (error) {
        if (error instanceof MissingContentPacksError) throw error;
        continue;
      }
      if (!loaded) continue;
      if (saveModeForState(loaded.state) !== mode) continue;
      if (candidate.source !== "primary") loaded.recovery = { source: candidate.source, issues: candidate.issues ?? [] };
      return loaded;
    }
    return {
      state: createInitialState(),
      offlineSeconds: 0,
      offlineReport: null,
      recovery: { source: "fresh", issues: ["没有找到可恢复的存档，已创建新工厂"] },
    };
  } catch (error) {
    if (error instanceof MissingContentPacksError) throw error;
    return { state: createInitialState(), offlineSeconds: 0, offlineReport: null, recovery: { source: "fresh", issues: ["本地存储不可用，已创建临时工厂"] } };
  }
}

export function loadGameDeferredOffline(mode: SaveMode = "normal"): DeferredLoadedGame {
  try {
    const primaryKey = primarySaveKey(mode);
    const backupKey = backupSaveKey(mode);
    const candidates: Array<{ source: SaveRecovery["source"]; raw: string | null; issues?: string[] }> = [
      { source: "primary", raw: readPrimaryOrEmergency(mode) },
      { source: "backup", raw: getLocalSaveValue(backupKey) ?? (mode === "normal" ? getLocalSaveValue(SAVE_BACKUP_KEY) : null), issues: ["主存档校验失败，已回退到最近一次有效备份"] },
    ];
    for (const key of listSnapshotKeys(mode)) {
      candidates.push({ source: "snapshot", raw: getLocalSaveValue(key), issues: ["主存档不可用，已回退到自动快照"] });
    }
    for (const candidate of candidates) {
      if (!candidate.raw) continue;
      let loaded: DeferredLoadedGame | null = null;
      try {
        loaded = parseDeferredEnvelope(candidate.raw);
      } catch (error) {
        if (error instanceof MissingContentPacksError) throw error;
        continue;
      }
      if (!loaded) continue;
      if (saveModeForState(loaded.state) !== mode) continue;
      if (candidate.source !== "primary") loaded.recovery = { source: candidate.source, issues: candidate.issues ?? [] };
      return loaded;
    }
  } catch (error) {
    if (error instanceof MissingContentPacksError) throw error;
    // Fall through to a temporary fresh state without mutating local storage.
  }
  return {
    state: createInitialState(),
    savedAt: Date.now(),
    offlineSeconds: 0,
    offlineReport: null,
    recovery: { source: "fresh", issues: ["本地存储不可用，已创建临时工厂"] },
  };
}

/** Inspect the save that Continue will load without advancing offline time. */
export function inspectContinueSave(mode: SaveMode = "normal"): ContinueSaveInspection | null {
  try {
    const primaryKey = primarySaveKey(mode);
    const backupKey = backupSaveKey(mode);
    const candidates: Array<{ source: SaveRecovery["source"]; raw: string | null }> = [
      { source: "primary", raw: readPrimaryOrEmergency(mode) },
      { source: "backup", raw: getLocalSaveValue(backupKey) ?? (mode === "normal" ? getLocalSaveValue(SAVE_BACKUP_KEY) : null) },
      ...listSnapshotKeys(mode).map((key) => ({ source: "snapshot" as const, raw: getLocalSaveValue(key) })),
    ];
    for (const candidate of candidates) {
      if (!candidate.raw) continue;
      const inspection = inspectSave(candidate.raw);
      if (inspection.valid && inspection.state && inspection.mode === mode) return { source: candidate.source, inspection };
    }
    return null;
  } catch {
    return null;
  }
}

function utf8ByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return value.length;
  }
}

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "QuotaExceededError" || candidate.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    candidate.code === 22 || candidate.code === 1014;
}

function failedSave(
  code: SaveGameFailureCode,
  message: string,
  bytes?: number,
  removedAutomaticSnapshots = 0,
): SaveGameResult {
  return { success: false, code, message, bytes, removedAutomaticSnapshots };
}

export function saveGame(state: GameState, options: { emergencyMirror?: boolean } = {}): SaveGameResult {
  const savedAt = Date.now();
  const mode = saveModeForState(state);
  const primaryKey = primarySaveKey(mode);
  const backupKey = backupSaveKey(mode);
  let raw: string;
  try {
    raw = serializeEnvelope(state, savedAt);
  } catch {
    return failedSave("unavailable", "无法生成本地主存档，请立即导出当前进度");
  }

  const bytes = utf8ByteLength(raw);
  let previous: string | null = null;
  let removedAutomaticSnapshots = 0;
  try {
    previous = getLocalSaveValue(primaryKey);
    if (!preserveLegacyModeMigrationBackupSync(previous, mode)) {
      return failedSave("unavailable", "无法保留模式迁移前的原始存档，已取消写入", bytes, removedAutomaticSnapshots);
    }
    removedAutomaticSnapshots += prepareAutomaticSnapshotsForPrimarySave(mode);
  } catch {
    return failedSave("unavailable", "本地存储当前不可用，请立即导出当前进度", bytes, removedAutomaticSnapshots);
  }

  const writeAndVerify = (): boolean => {
    setLocalSaveValue(primaryKey, raw);
    const stored = getLocalSaveValue(primaryKey);
    if (stored !== raw) return false;
    const inspection = inspectSave(stored);
    return inspection.valid && inspection.checksum === "valid";
  };

  let verified = false;
  try {
    verified = writeAndVerify();
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      return failedSave("unavailable", "本地主存档写入失败，请立即导出当前进度", bytes, removedAutomaticSnapshots);
    }
    try {
      removedAutomaticSnapshots += removeAutomaticSnapshotsForQuotaRetry(mode);
      verified = writeAndVerify();
    } catch (retryError) {
      const code: SaveGameFailureCode = isQuotaExceededError(retryError) ? "quota" : "unavailable";
      const message = code === "quota"
        ? "本地存储空间不足，当前进度尚未保存。请立即导出存档。"
        : "本地主存档重试写入失败，请立即导出当前进度";
      return failedSave(code, message, bytes, removedAutomaticSnapshots);
    }
  }

  if (!verified) {
    return failedSave("verification", "本地主存档写入校验失败，当前进度尚未保存。请立即导出存档。", bytes, removedAutomaticSnapshots);
  }

  if (options.emergencyMirror) {
    // Page lifecycle handlers cannot await IndexedDB. A single primary-save
    // mirror is imported and removed after verified IndexedDB startup.
    writePrimarySaveEmergencyMirror(raw);
  }

  let backupSaved = false;
  if (previous && inspectSave(previous).valid) {
    try {
      setLocalSaveValue(backupKey, previous);
      backupSaved = getLocalSaveValue(backupKey) === previous;
    } catch {
      // The verified primary save has priority over its optional previous-version backup.
    }
  }

  // Recovery points are best effort and must never turn a verified primary
  // write into a reported failure.
  maybeSaveAutomaticSnapshot(state, mode);
  return {
    success: true,
    message: "主存档已保存",
    savedAt,
    bytes,
    removedAutomaticSnapshots,
    backupSaved,
  };
}

async function verifyPersistedEnvelope(
  key: string,
  expectedRaw: string,
  workerVerification?: SaveTransferVerification,
): Promise<boolean> {
  await flushLocalSaveWrites();
  const stored = await readPersistedLocalSaveValue(key);
  if (stored !== expectedRaw) return false;
  // The exact string read-back is the same byte sequence that the worker
  // already hashed. Avoid parsing the full 20+ MB state again on the UI thread.
  if (workerVerification?.integrity === "valid") return true;
  const inspection = inspectSave(stored);
  return inspection.valid && inspection.checksum === "valid";
}

function matchesWorkerVerification(
  raw: string,
  summary: CloudSaveSummary | undefined,
  verification: SaveTransferVerification | undefined,
): summary is CloudSaveSummary & { mode: SaveMode; integrity: "valid"; stateChecksum: string } {
  if (!summary || (summary.mode !== "normal" && summary.mode !== "speedrun") || summary.integrity !== "valid" ||
    typeof summary.stateChecksum !== "string" || summary.stateChecksum.length === 0 ||
    !verification || verification.integrity !== "valid" || verification.stateChecksum !== summary.stateChecksum) return false;
  const measured = computeSavePayloadTextChecksum(raw);
  return measured.byteLength === verification.byteLength && measured.checksum === verification.payloadChecksum;
}

/**
 * Commit a payload that was already migrated, simulated and checksum-verified
 * in a Worker. This path deliberately does not parse old snapshots or create a
 * recovery point while the user is waiting for a cloud upload. The exact raw
 * value is still read back from IndexedDB before success is reported.
 */
export async function saveVerifiedPayload(
  raw: string,
  options: {
    verified?: boolean;
    deferBackup?: boolean;
    mode?: SaveMode;
    workerSummary?: CloudSaveSummary;
    workerVerification?: SaveTransferVerification;
  } = {},
): Promise<SaveGameResult> {
  const trustedWorkerPayload = options.verified === true &&
    matchesWorkerVerification(raw, options.workerSummary, options.workerVerification);
  const inspection = trustedWorkerPayload ? null : inspectSave(raw);
  if (!trustedWorkerPayload && (!inspection?.valid || !inspection.state || inspection.checksum !== "valid")) {
    return failedSave("verification", "后台生成的存档完整性校验失败，请重试", utf8ByteLength(raw));
  }
  const payloadMode = trustedWorkerPayload ? options.workerSummary!.mode! : inspection!.mode;
  if (options.mode !== undefined && payloadMode !== options.mode) {
    return failedSave(
      "verification",
      `存档模式不匹配：不能把${payloadMode === "speedrun" ? "速通" : "普通"}存档写入${options.mode === "speedrun" ? "速通" : "普通"}主档`,
      utf8ByteLength(raw),
    );
  }
  const startedAt = monotonicNow();
  const bytes = utf8ByteLength(raw);
  const mode = options.mode ?? payloadMode;
  const primaryKey = primarySaveKey(mode);
  const backupKey = backupSaveKey(mode);
  const previous = getLocalSaveValue(primaryKey);
  const capacity = await hasLocalSaveCapacity(primaryKey, raw);
  if (!capacity.ok) return failedSave("quota", "本地存储空间不足，当前进度尚未保存。请先管理快照或导出存档。", bytes);
  if (!await preserveLegacyModeMigrationBackup(previous, mode)) {
    return failedSave("unavailable", "无法保留模式迁移前的原始存档，已取消写入", bytes);
  }
  try {
    setLocalSaveValue(primaryKey, raw);
    await flushLocalSaveWrites();
    const stored = await readPersistedLocalSaveValue(primaryKey);
    if (stored !== raw) {
      await recoverLocalSaveCache();
      return failedSave("verification", "本地主存档写入校验失败，当前进度尚未保存。请立即导出存档。", bytes);
    }
    let backupSaved = false;
    if (previous !== null && !options.deferBackup) {
      try {
        setLocalSaveValue(backupKey, previous);
        await flushLocalSaveWrites();
        backupSaved = true;
      } catch {
        // The verified primary remains authoritative if its optional backup fails.
      }
    }
    clearPrimarySaveEmergencyMirror(raw);
    return {
      success: true,
      message: "主存档已保存",
    savedAt: trustedWorkerPayload ? options.workerSummary!.savedAt : inspection!.savedAt ?? Date.now(),
      bytes,
      backupSaved,
      timings: {
        totalMs: Math.max(0, monotonicNow() - startedAt),
        serializeMs: 0,
        snapshotScanMs: 0,
        capacityMs: 0,
        primaryWriteMs: 0,
        backupMs: 0,
        automaticSnapshotMs: 0,
      },
    };
  } catch (error) {
    await recoverLocalSaveCache();
    return failedSave(
      isQuotaExceededError(error) ? "quota" : "unavailable",
      isQuotaExceededError(error) ? "本地存储空间不足，当前进度尚未保存。请立即导出存档。" : "本地主存档写入失败，请立即导出当前进度",
      bytes,
    );
  }
}

async function recoverLocalSaveCache(): Promise<void> {
  try {
    await flushLocalSaveWrites();
  } catch {
    // Flush consumes the queued error before the authoritative cache reload.
  }
  try {
    await reloadLocalSaveCache();
  } catch {
    // localStorage and memory fallbacks already read their authoritative value.
  }
}

/**
 * Writes the primary save to the durable backend and only reports success after
 * an exact read-back plus envelope checksum validation. Optional backups and
 * automatic snapshots are deliberately attempted after the primary commit.
 */
async function saveGameVerifiedOnce(state: GameState): Promise<SaveGameResult> {
  const totalStartedAt = monotonicNow();
  const serializeStartedAt = totalStartedAt;
  const savedAt = Date.now();
  const mode = saveModeForState(state);
  const primaryKey = primarySaveKey(mode);
  const backupKey = backupSaveKey(mode);
  let raw: string;
  let workerVerification: SaveTransferVerification | undefined;
  try {
    const serialized = await serializeEnvelopeInWorker(state, savedAt);
    raw = serialized.raw;
    workerVerification = serialized.verification;
  } catch {
    return failedSave("unavailable", "无法生成本地主存档，请立即导出当前进度");
  }
  const serializeMs = Math.max(0, monotonicNow() - serializeStartedAt);

  const bytes = utf8ByteLength(raw);
  const previous = getLocalSaveValue(primaryKey);
  const snapshotScanStartedAt = monotonicNow();
  let removedAutomaticSnapshots = prepareAutomaticSnapshotsForPrimarySave(mode);
  const snapshotScanMs = Math.max(0, monotonicNow() - snapshotScanStartedAt);
  try {
    await flushLocalSaveWrites();
  } catch {
    // Expired snapshot cleanup is best effort. The primary write still gets a
    // chance, and quota recovery below retries after removing all auto points.
  }

  const capacityStartedAt = monotonicNow();
  const capacity = await hasLocalSaveCapacity(primaryKey, raw);
  let capacityMs = Math.max(0, monotonicNow() - capacityStartedAt);
  if (!capacity.ok) {
    removedAutomaticSnapshots += removeAutomaticSnapshotsForQuotaRetry(mode);
    try { await flushLocalSaveWrites(); } catch { /* handled by the primary write */ }
    capacityMs = Math.max(capacityMs, monotonicNow() - capacityStartedAt);
  }
  if (!await preserveLegacyModeMigrationBackup(previous, mode)) {
    return failedSave("unavailable", "无法保留模式迁移前的原始存档，已取消写入", bytes, removedAutomaticSnapshots);
  }

  const commitPrimary = async (): Promise<boolean> => {
    setLocalSaveValue(primaryKey, raw);
    return verifyPersistedEnvelope(primaryKey, raw, workerVerification);
  };

  const primaryWriteStartedAt = monotonicNow();
  let verified = false;
  try {
    verified = await commitPrimary();
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      await recoverLocalSaveCache();
      return failedSave("unavailable", "本地主存档写入失败，请立即导出当前进度", bytes, removedAutomaticSnapshots);
    }
    try {
      removedAutomaticSnapshots += removeAutomaticSnapshotsForQuotaRetry(mode);
      await flushLocalSaveWrites();
      verified = await commitPrimary();
    } catch (retryError) {
      await recoverLocalSaveCache();
      const code: SaveGameFailureCode = isQuotaExceededError(retryError) ? "quota" : "unavailable";
      return failedSave(
        code,
        code === "quota"
          ? "本地存储空间不足，当前进度尚未保存。请立即导出存档。"
          : "本地主存档重试写入失败，请立即导出当前进度",
        bytes,
        removedAutomaticSnapshots,
      );
    }
  }

  if (!verified) {
    await recoverLocalSaveCache();
    return failedSave("verification", "本地主存档写入校验失败，当前进度尚未保存。请立即导出存档。", bytes, removedAutomaticSnapshots);
  }
  const primaryWriteMs = Math.max(0, monotonicNow() - primaryWriteStartedAt);
  clearPrimarySaveEmergencyMirror(raw);

  const backupStartedAt = monotonicNow();
  let backupSaved = false;
  if (previous && inspectSave(previous).valid) {
    try {
      setLocalSaveValue(backupKey, previous);
      backupSaved = await verifyPersistedEnvelope(backupKey, previous);
    } catch {
      // The already verified primary remains authoritative.
    }
  }
  const backupMs = Math.max(0, monotonicNow() - backupStartedAt);

  const automaticSnapshotStartedAt = monotonicNow();
  try {
    await maybeSaveAutomaticSnapshotVerified(state, mode);
  } catch {
    // Recovery points never downgrade a successful primary commit.
  }
  const automaticSnapshotMs = Math.max(0, monotonicNow() - automaticSnapshotStartedAt);
  return {
    success: true,
    message: "主存档已保存",
    savedAt,
    bytes,
    removedAutomaticSnapshots,
    backupSaved,
    timings: {
      totalMs: Math.max(0, monotonicNow() - totalStartedAt),
      serializeMs,
      snapshotScanMs,
      capacityMs,
      primaryWriteMs,
      backupMs,
      automaticSnapshotMs,
    },
  };
}

interface PendingPrimarySave {
  state: GameState;
  waiters: Array<(result: SaveGameResult) => void>;
}

let activePrimarySave: Promise<void> | null = null;
const pendingPrimarySaves = new Map<SaveMode, PendingPrimarySave>();
let lastVerifiedPrimaryState: GameState | null = null;
let lastVerifiedPrimaryResult: SaveGameResult | null = null;

function ensurePrimarySaveProcessor(): void {
  if (activePrimarySave || pendingPrimarySaves.size === 0) return;
  const run = async () => {
    while (pendingPrimarySaves.size > 0) {
      const next = pendingPrimarySaves.entries().next();
      if (next.done) break;
      const [mode, request] = next.value;
      pendingPrimarySaves.delete(mode);
      let result: SaveGameResult;
      try {
        result = await saveGameVerifiedOnce(request.state);
      } catch {
        result = failedSave("unavailable", "本地主存档写入失败，请立即导出当前进度");
      }
      request.waiters.forEach((waiter) => waiter(result));
      if (result.success) {
        lastVerifiedPrimaryState = request.state;
        lastVerifiedPrimaryResult = result;
      } else if (lastVerifiedPrimaryState === request.state) {
        lastVerifiedPrimaryState = null;
        lastVerifiedPrimaryResult = null;
      }
    }
  };
  const inFlight = run();
  activePrimarySave = inFlight;
  void inFlight.finally(() => {
    if (activePrimarySave === inFlight) activePrimarySave = null;
    ensurePrimarySaveProcessor();
  });
}

/**
 * Serialize primary saves and coalesce requests that arrive while IndexedDB
 * is still writing. The newest state wins; every caller still receives the
 * result of the committed request. This prevents autosave, visibility and
 * native lifecycle events from creating a save backlog.
 */
export function saveGameVerified(state: GameState): Promise<SaveGameResult> {
  return new Promise((resolve) => {
    const mode = saveModeForState(state);
    // Lifecycle hooks can request the same immutable state several times while
    // paused. Avoid serializing and writing it again after a verified commit.
    if (lastVerifiedPrimaryState === state && lastVerifiedPrimaryResult?.success && getLocalSaveValue(primarySaveKey(mode)) !== null) {
      resolve({ ...lastVerifiedPrimaryResult, skippedUnchanged: true, message: "主存档未变化，跳过重复保存" });
      return;
    }
    const pending = pendingPrimarySaves.get(mode);
    if (pending) {
      pending.state = state;
      pending.waiters.push(resolve);
    } else {
      pendingPrimarySaves.set(mode, { state, waiters: [resolve] });
    }
    ensurePrimarySaveProcessor();
  });
}

export function exportGame(state: GameState): string {
  return serializeEnvelope(state);
}

export function importGame(raw: string, expectedMode?: SaveMode, expectedSlot?: SaveSlotId | "main"): GameState | null {
  try {
    const loaded = parseEnvelope(raw, false);
    const state = loaded?.state ?? null;
    if (!state || expectedMode !== undefined && saveModeForState(state) !== expectedMode || expectedSlot !== undefined && inspectSave(raw).slot !== expectedSlot) return null;
    return state;
  } catch {
    return null;
  }
}

function saveSlotKey(slotId: SaveSlotId, mode: SaveMode = "normal"): string {
  return slotSaveKey(slotId, mode);
}

export function saveGameSlot(slotId: SaveSlotId, state: GameState): void {
  const mode = saveModeForState(state);
  const key = saveSlotKey(slotId, mode);
  invalidateSaveSummaryCache(key);
  setLocalSaveValue(key, serializeEnvelope(state, Date.now(), "slot", undefined, loadContentPackRegistry(), slotId));
}

export async function saveGameSlotVerified(slotId: SaveSlotId, state: GameState): Promise<SaveGameResult> {
  const savedAt = Date.now();
  const mode = saveModeForState(state);
  const key = saveSlotKey(slotId, mode);
  let raw: string;
  try {
    const serialized = await serializeEnvelopeInWorker(state, savedAt, "slot", undefined, slotId);
    raw = serialized.raw;
    const capacity = await hasLocalSaveCapacity(key, raw);
    if (!capacity.ok) {
      return failedSave("quota", "本地存储空间不足，槽位尚未保存。请先管理快照或导出存档。", utf8ByteLength(raw));
    }
    invalidateSaveSummaryCache(key);
    setLocalSaveValue(key, raw);
    if (!await verifyPersistedEnvelope(key, raw, serialized.verification)) {
      await recoverLocalSaveCache();
      return failedSave("verification", `本地槽位 ${slotId} 写入校验失败`, utf8ByteLength(raw));
    }
    return { success: true, message: `本地槽位 ${slotId} 已保存`, savedAt, bytes: utf8ByteLength(raw) };
  } catch (error) {
    await recoverLocalSaveCache();
    return failedSave(
      isQuotaExceededError(error) ? "quota" : "unavailable",
      isQuotaExceededError(error) ? "本地存储空间不足，槽位尚未保存。" : `本地槽位 ${slotId} 写入失败`,
    );
  }
}

export function loadGameSlot(slotId: SaveSlotId, mode: SaveMode = "normal"): LoadedGame | null {
  try {
    const raw = getLocalSaveValue(saveSlotKey(slotId, mode));
    const loaded = raw ? parseEnvelope(raw, true) : null;
    return loaded && saveModeForState(loaded.state) === mode ? loaded : null;
  } catch {
    return null;
  }
}

export function loadGameSlotDeferredOffline(slotId: SaveSlotId, mode: SaveMode = "normal"): DeferredLoadedGame | null {
  try {
    const raw = getLocalSaveValue(saveSlotKey(slotId, mode));
    const loaded = raw ? parseDeferredEnvelope(raw) : null;
    return loaded && saveModeForState(loaded.state) === mode ? loaded : null;
  } catch {
    return null;
  }
}

/** Export a validated manual slot without applying offline simulation. */
export function exportGameSlot(slotId: SaveSlotId, mode: SaveMode = "normal"): string | null {
  try {
    const raw = getLocalSaveValue(saveSlotKey(slotId, mode));
    if (!raw) return null;
    const inspection = inspectSave(raw);
    const parsed = JSON.parse(raw) as Partial<SaveEnvelope>;
    return inspection.valid && inspection.state && inspection.mode === mode && (parsed.slot === undefined || inspection.slot === slotId)
      ? serializeEnvelope(inspection.state, inspection.savedAt ?? Date.now(), "slot", undefined, loadContentPackRegistry(), slotId)
      : null;
  } catch {
    return null;
  }
}

export function clearGameSlot(slotId: SaveSlotId, mode: SaveMode = "normal"): void {
  removeLocalSaveValue(saveSlotKey(slotId, mode));
}

export async function clearGameSlotVerified(slotId: SaveSlotId, mode: SaveMode = "normal"): Promise<boolean> {
  const key = saveSlotKey(slotId, mode);
  try {
    removeLocalSaveValue(key);
    invalidateSaveSummaryCache(key);
    await flushLocalSaveWrites();
    return await readPersistedLocalSaveValue(key) === null;
  } catch {
    await recoverLocalSaveCache();
    return false;
  }
}

export function getSaveSlotSummaries(mode: SaveMode = "normal"): SaveSlotSummary[] {
  const keys = ([1, 2, 3] as SaveSlotId[]).map((slotId) => saveSlotKey(slotId, mode));
  pruneSaveSummaryCache(keys, "slots");
  return ([1, 2, 3] as SaveSlotId[]).flatMap((slotId) => {
    const key = saveSlotKey(slotId, mode);
    try {
      const raw = getLocalSaveValue(key);
      if (!raw) return [];
      const cached = saveSummaryCache.get(key);
      if (cached?.raw === raw) return [cached.summary as SaveSlotSummary];
      const inspection = inspectSave(raw);
      const parsed = JSON.parse(raw) as Partial<SaveEnvelope>;
      const fallbackSummary = inspection.summary ?? {
        savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
        elapsedSeconds: 0,
        completedTechCount: 0,
        structurePoints: 0,
        activePlanetId: "home" as PlanetId,
      };
      const summary = {
        slotId,
        ...fallbackSummary,
        mode,
        integrity: inspection.integrity,
        valid: inspection.valid && inspection.mode === mode && (parsed.slot === undefined || inspection.slot === slotId),
        issues: inspection.mode !== mode
          ? [...inspection.issues, "存档模式与槽位命名空间不一致"]
          : parsed.slot !== undefined && inspection.slot !== slotId
            ? [...inspection.issues, "存档槽位标记与实际槽位不一致"]
            : inspection.issues,
      } satisfies SaveSlotSummary;
      saveSummaryCache.set(key, { raw, summary });
      return [summary];
    } catch {
      return [];
    }
  });
}

function listSnapshotKeys(mode: SaveMode = "normal"): string[] {
  const prefix = snapshotSavePrefix(mode);
  const sequenceKey = snapshotSequenceKey(mode);
  return listLocalSaveKeys()
    .filter((key) => mode === "speedrun"
      ? key.startsWith(`${prefix}.`) && key !== sequenceKey
      : key.startsWith(`${prefix}.`) && !key.startsWith(`${SAVE_SNAPSHOT_KEY_PREFIX}.speedrun.`) && key !== sequenceKey)
    .sort((left, right) => right.localeCompare(left));
}

interface StoredSnapshotEntry {
  key: string;
  savedAt: number;
  elapsedSeconds: number;
  automatic: boolean;
  hasPersistedProductionHistory: boolean;
}

type CachedSnapshotMetadata = {
  raw: string;
  entry: StoredSnapshotEntry | null;
};

const snapshotMetadataCache = new Map<string, CachedSnapshotMetadata>();

function storedSnapshotEntries(mode: SaveMode = "normal"): StoredSnapshotEntry[] {
  const keys = listSnapshotKeys(mode);
  const retained = new Set(keys);
  for (const key of snapshotMetadataCache.keys()) {
    if (!retained.has(key)) snapshotMetadataCache.delete(key);
  }
  return keys.flatMap((key) => {
    try {
      const raw = getLocalSaveValue(key);
      if (!raw) return [];
      const cached = snapshotMetadataCache.get(key);
      if (cached?.raw === raw) return cached.entry ? [cached.entry] : [];
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        snapshotMetadataCache.set(key, { raw, entry: null });
        return [];
      }
      const reason = typeof parsed.reason === "string" ? parsed.reason : "";
      const state = isRecord(parsed.state) ? parsed.state : parsed;
      const history = isRecord(state) && Array.isArray(state.productionHistory) ? state.productionHistory : [];
      const idTimestamp = Number(key.slice(`${SAVE_SNAPSHOT_KEY_PREFIX}.`.length).split("-")[0]);
      const entry = {
        key,
        savedAt: typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt)
          ? parsed.savedAt
          : Number.isFinite(idTimestamp) ? idTimestamp : 0,
        elapsedSeconds: isRecord(state) && typeof state.elapsedSeconds === "number" && Number.isFinite(state.elapsedSeconds)
          ? Math.max(0, state.elapsedSeconds)
          : 0,
        automatic: reason.length === 0 || reason === "自动快照",
        hasPersistedProductionHistory: history.length > 0,
      } satisfies StoredSnapshotEntry;
      snapshotMetadataCache.set(key, { raw, entry });
      return [entry];
    } catch {
      // Unknown or corrupt snapshots are left untouched. They may be a manual
      // recovery point whose reason can no longer be read safely.
      const raw = getLocalSaveValue(key);
      if (raw) snapshotMetadataCache.set(key, { raw, entry: null });
      return [];
    }
  }).sort((left, right) => right.savedAt - left.savedAt || right.key.localeCompare(left.key));
}

function removeStoredSnapshots(entries: StoredSnapshotEntry[]): number {
  let removed = 0;
  for (const entry of entries) {
    removeLocalSaveValue(entry.key);
    invalidateSaveSummaryCache(entry.key);
    snapshotMetadataCache.delete(entry.key);
    removed += 1;
  }
  return removed;
}

function trimAutomaticSnapshots(limit: number, mode: SaveMode = "normal"): number {
  const automatic = storedSnapshotEntries(mode).filter((entry) => entry.automatic);
  return removeStoredSnapshots(automatic.slice(Math.max(0, limit)).reverse());
}

function prepareAutomaticSnapshotsForPrimarySave(mode: SaveMode = "normal"): number {
  let automatic = storedSnapshotEntries(mode).filter((entry) => entry.automatic);
  let removed = 0;
  if (automatic.some((entry) => entry.hasPersistedProductionHistory) && automatic.length > 1) {
    // On the first emergency save retain only the newest automatic recovery
    // point. Manual snapshots and slots are never part of this cleanup.
    removed += removeStoredSnapshots(automatic.slice(1).reverse());
    automatic = storedSnapshotEntries(mode).filter((entry) => entry.automatic);
  }
  if (automatic.length > AUTOMATIC_SAVE_SNAPSHOT_LIMIT) {
    removed += removeStoredSnapshots(automatic.slice(AUTOMATIC_SAVE_SNAPSHOT_LIMIT).reverse());
  }
  return removed;
}

function removeAutomaticSnapshotsForQuotaRetry(mode: SaveMode = "normal"): number {
  const oldestFirst = storedSnapshotEntries(mode)
    .filter((entry) => entry.automatic)
    .sort((left, right) => left.savedAt - right.savedAt || left.key.localeCompare(right.key));
  return removeStoredSnapshots(oldestFirst);
}

function nextSnapshotSequence(mode: SaveMode = "normal"): number {
  const sequenceKey = snapshotSequenceKey(mode);
  const previous = Number(getLocalSaveValue(sequenceKey) ?? 0);
  const next = Number.isFinite(previous) ? Math.max(0, Math.floor(previous)) + 1 : 1;
  setLocalSaveValue(sequenceKey, String(next));
  return next;
}

function maybeSaveAutomaticSnapshot(state: GameState, mode = saveModeForState(state)): void {
  const latest = latestAutomaticSnapshotSummary(mode);
  if (!latest || state.elapsedSeconds < latest.elapsedSeconds || state.elapsedSeconds - latest.elapsedSeconds >= AUTO_SNAPSHOT_MIN_SECONDS) {
    saveGameSnapshot(state, "自动快照");
  }
}

async function maybeSaveAutomaticSnapshotVerified(state: GameState, mode = saveModeForState(state)): Promise<void> {
  const latest = latestAutomaticSnapshotSummary(mode);
  if (!latest || state.elapsedSeconds < latest.elapsedSeconds || state.elapsedSeconds - latest.elapsedSeconds >= AUTO_SNAPSHOT_MIN_SECONDS) {
    await saveGameSnapshotVerified(state, "自动快照");
  }
}

function getSnapshotSummaryForKey(key: string, raw = getLocalSaveValue(key), mode: SaveMode = "normal"): SaveSnapshotSummary | null {
  if (!raw) return null;
  const cached = saveSummaryCache.get(key);
  if (cached?.raw === raw) return cached.summary as SaveSnapshotSummary;
  const inspection = inspectSave(raw);
  const parsed = JSON.parse(raw) as Partial<SaveEnvelope>;
  const fallbackSummary = inspection.summary ?? {
    savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    elapsedSeconds: 0,
    completedTechCount: 0,
    structurePoints: 0,
    activePlanetId: "home" as PlanetId,
  };
  const summary = {
    id: key.startsWith(`${snapshotSavePrefix(mode)}.`)
      ? key.slice(`${snapshotSavePrefix(mode)}.`.length)
      : key.slice(`${SAVE_SNAPSHOT_KEY_PREFIX}.`.length),
    ...fallbackSummary,
    mode,
    reason: typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "自动快照",
    integrity: inspection.integrity,
    valid: inspection.valid && inspection.mode === mode,
    issues: inspection.mode === mode ? inspection.issues : [...inspection.issues, "快照模式与命名空间不一致"],
  } satisfies SaveSnapshotSummary;
  saveSummaryCache.set(key, { raw, summary });
  return summary;
}

function latestAutomaticSnapshotSummary(mode: SaveMode = "normal"): SaveSnapshotSummary | null {
  const latest = storedSnapshotEntries(mode).find((entry) => entry.automatic);
  if (!latest) return null;
  const summary = getSnapshotSummaryForKey(latest.key, undefined, mode);
  return summary?.valid && summary.reason === "自动快照" ? summary : null;
}

export function saveGameSnapshot(state: GameState, reason = "自动快照"): SaveSnapshotSummary | null {
  try {
    const mode = saveModeForState(state);
    const savedAt = Date.now();
    const sequence = nextSnapshotSequence(mode);
    const id = `${savedAt}-${sequence}`;
    const key = `${snapshotSavePrefix(mode)}.${id}`;
    const raw = serializeEnvelope(state, savedAt, "snapshot", reason);
    invalidateSaveSummaryCache(key);
    snapshotMetadataCache.delete(key);
    setLocalSaveValue(key, raw);
    if (reason === "自动快照") trimAutomaticSnapshots(AUTOMATIC_SAVE_SNAPSHOT_LIMIT, mode);
    return getSnapshotSummaryForKey(key, raw, mode);
  } catch {
    return null;
  }
}

export async function saveGameSnapshotVerified(state: GameState, reason = "自动快照"): Promise<SaveSnapshotSummary | null> {
  const mode = saveModeForState(state);
  const savedAt = Date.now();
  const sequence = nextSnapshotSequence(mode);
  const id = `${savedAt}-${sequence}`;
  const key = `${snapshotSavePrefix(mode)}.${id}`;
  try {
    const serialized = await serializeEnvelopeInWorker(state, savedAt, "snapshot", reason);
    const raw = serialized.raw;
    const capacity = await hasLocalSaveCapacity(key, raw);
    if (!capacity.ok) return null;
    invalidateSaveSummaryCache(key);
    snapshotMetadataCache.delete(key);
    setLocalSaveValue(key, raw);
    if (reason === "自动快照") trimAutomaticSnapshots(AUTOMATIC_SAVE_SNAPSHOT_LIMIT, mode);
    await flushLocalSaveWrites();
    if (!await verifyPersistedEnvelope(key, raw, serialized.verification)) return null;
    if (!serialized.summary) return getSnapshotSummaryForKey(key, raw, mode);
    const summary = {
      id,
      mode,
      savedAt: serialized.summary.savedAt,
      elapsedSeconds: serialized.summary.elapsedSeconds,
      completedTechCount: serialized.summary.completedTechCount,
      structurePoints: serialized.summary.structurePoints,
      activePlanetId: serialized.summary.activePlanetId as PlanetId,
      reason,
      integrity: "valid",
      valid: true,
      issues: [],
    } satisfies SaveSnapshotSummary;
    saveSummaryCache.set(key, { raw, summary });
    return summary;
  } catch {
    await recoverLocalSaveCache();
    return null;
  }
}

export function getSaveSnapshotSummaries(mode: SaveMode = "normal"): SaveSnapshotSummary[] {
  const keys = listSnapshotKeys(mode);
  pruneSaveSummaryCache(keys, "snapshots");
  return keys.flatMap((key) => {
    try {
      const raw = getLocalSaveValue(key);
      if (!raw) return [];
      const summary = getSnapshotSummaryForKey(key, raw, mode);
      return summary ? [summary] : [];
    } catch {
      return [];
    }
  }).sort((left, right) => right.savedAt - left.savedAt);
}

interface SaveSummaryWorkerEntry {
  key: string;
  kind: "slot" | "snapshot";
  slotId?: SaveSlotId;
  raw: string;
}

interface SaveSummaryWorkerResponse {
  id: number;
  summaries: Array<{ key: string; summary: SaveSlotSummary | SaveSnapshotSummary }>;
}

let saveSummaryWorkerRequestId = 0;

/** Validate changed save summaries off the main thread when workers are available. */
export async function getSaveSummariesInWorker(mode: SaveMode = "normal"): Promise<{ slots: SaveSlotSummary[]; snapshots: SaveSnapshotSummary[] }> {
  const slotEntries: SaveSummaryWorkerEntry[] = ([1, 2, 3] as SaveSlotId[]).flatMap((slotId) => {
    const key = saveSlotKey(slotId, mode);
    const raw = getLocalSaveValue(key);
    return raw ? [{ key, kind: "slot", slotId, raw }] : [];
  });
  const snapshotEntries: SaveSummaryWorkerEntry[] = listSnapshotKeys(mode).flatMap((key) => {
    const raw = getLocalSaveValue(key);
    return raw ? [{ key, kind: "snapshot", raw }] : [];
  });
  const entries = [...slotEntries, ...snapshotEntries];
  pruneSaveSummaryCache(entries.map((entry) => entry.key), "all");
  const pending = entries.filter((entry) => saveSummaryCache.get(entry.key)?.raw !== entry.raw);
  if (pending.length === 0 || typeof Worker === "undefined") {
    return { slots: getSaveSlotSummaries(mode), snapshots: getSaveSnapshotSummaries(mode) };
  }

  return new Promise((resolve) => {
    const id = ++saveSummaryWorkerRequestId;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./saveSummary.worker.ts", import.meta.url), { type: "module", name: "save-summary-validation" });
    } catch {
      resolve({ slots: getSaveSlotSummaries(mode), snapshots: getSaveSnapshotSummaries(mode) });
      return;
    }
    const fallback = () => {
      worker.terminate();
       resolve({ slots: getSaveSlotSummaries(mode), snapshots: getSaveSnapshotSummaries(mode) });
    };
    worker.onerror = fallback;
    worker.onmessage = (event: MessageEvent<SaveSummaryWorkerResponse>) => {
      if (event.data?.id !== id) return;
      worker.terminate();
      for (const entry of event.data.summaries ?? []) {
        const source = pending.find((candidate) => candidate.key === entry.key);
        if (source) saveSummaryCache.set(entry.key, { raw: source.raw, summary: entry.summary });
      }
      resolve({ slots: getSaveSlotSummaries(mode), snapshots: getSaveSnapshotSummaries(mode) });
    };
    worker.postMessage({ id, registry: loadContentPackRegistry(), entries: pending });
  });
}

/**
 * Return cheap storage diagnostics without parsing or validating any envelope.
 * The performance panel calls this only while sampling is enabled.
 */
export function getLocalSaveSummaryMetrics(): LocalSaveSummaryMetrics {
  const startedAt = monotonicNow();
  const keys = listLocalSaveKeys().filter((key) =>
    !key.startsWith(`${SAVE_SNAPSHOT_KEY_PREFIX}.`) || !key.endsWith(".sequence"));
  let totalBytes = 0;
  let slotCount = 0;
  let snapshotCount = 0;
  for (const key of keys) {
    const raw = getLocalSaveValue(key);
    if (raw !== null) totalBytes += utf8ByteLength(raw);
    if (key.startsWith(`${SAVE_SLOT_KEY_PREFIX}.`)) slotCount += 1;
    if (key.startsWith(`${SAVE_SNAPSHOT_KEY_PREFIX}.`)) snapshotCount += 1;
  }
  return { slotCount, snapshotCount, totalBytes, scanMs: Math.max(0, monotonicNow() - startedAt) };
}

export function loadSaveSnapshot(id: string, mode: SaveMode = "normal"): GameState | null {
  try {
    const raw = getLocalSaveValue(`${snapshotSavePrefix(mode)}.${id}`) ??
      (mode === "normal" ? getLocalSaveValue(`${SAVE_SNAPSHOT_KEY_PREFIX}.${id}`) : null);
    const state = raw ? parseEnvelope(raw, false)?.state ?? null : null;
    return state && saveModeForState(state) === mode ? state : null;
  } catch {
    return null;
  }
}

export function clearSaveSnapshot(id: string, mode: SaveMode = "normal"): void {
  const key = `${snapshotSavePrefix(mode)}.${id}`;
  invalidateSaveSummaryCache(key);
  snapshotMetadataCache.delete(key);
  removeLocalSaveValue(key);
}

export async function clearSaveSnapshotVerified(id: string, mode: SaveMode = "normal"): Promise<boolean> {
  const key = `${snapshotSavePrefix(mode)}.${id}`;
  try {
    removeLocalSaveValue(key);
    invalidateSaveSummaryCache(key);
    snapshotMetadataCache.delete(key);
    await flushLocalSaveWrites();
    return await readPersistedLocalSaveValue(key) === null;
  } catch {
    await recoverLocalSaveCache();
    return false;
  }
}

export async function clearSaveSnapshotsVerified(ids: string[], mode: SaveMode = "normal"): Promise<{ removed: number; failed: string[] }> {
  const uniqueIds = [...new Set(ids)];
  for (const id of uniqueIds) {
    const key = `${snapshotSavePrefix(mode)}.${id}`;
    invalidateSaveSummaryCache(key);
    snapshotMetadataCache.delete(key);
    removeLocalSaveValue(key);
  }
  try {
    await flushLocalSaveWrites();
  } catch {
    await recoverLocalSaveCache();
  }
  const failed: string[] = [];
  for (const id of uniqueIds) {
    if (await readPersistedLocalSaveValue(`${snapshotSavePrefix(mode)}.${id}`) !== null) failed.push(id);
  }
  return { removed: uniqueIds.length - failed.length, failed };
}

export function clearGame(mode: SaveMode = "normal"): void {
  removeLocalSaveValue(primarySaveKey(mode));
  if (mode === "normal") removeLocalSaveValue(SAVE_KEY);
}

/** Copy a ranked speedrun slot into a fresh ordinary slot without mutating the source. */
export async function copySpeedrunSlotToNormalSlot(sourceSlot: SaveSlotId, targetSlot: SaveSlotId): Promise<SaveGameResult> {
  if (getLocalSaveValue(saveSlotKey(targetSlot, "normal")) !== null) {
    return failedSave("unavailable", `普通模式槽位 ${targetSlot} 已有存档，未执行覆盖`);
  }
  const source = loadGameSlot(sourceSlot, "speedrun");
  if (!source?.state || saveModeForState(source.state) !== "speedrun") {
    return failedSave("unavailable", "找不到可复制的速通存档");
  }
  const copy = structuredClone(source.state);
  copy.mode = "normal";
  copy.speedrun = undefined;
  return saveGameSlotVerified(targetSlot, copy);
}

/** Copy the current ranked primary into an unused ordinary slot. */
export async function copySpeedrunPrimaryToNormalSlot(targetSlot: SaveSlotId): Promise<SaveGameResult> {
  if (getLocalSaveValue(saveSlotKey(targetSlot, "normal")) !== null) {
    return failedSave("unavailable", `普通模式槽位 ${targetSlot} 已有存档，未执行覆盖`);
  }
  const source = loadGame("speedrun");
  if (source.recovery?.source === "fresh" || saveModeForState(source.state) !== "speedrun") {
    return failedSave("unavailable", "找不到可复制的速通主存档");
  }
  const copy = structuredClone(source.state);
  copy.mode = "normal";
  copy.speedrun = undefined;
  return saveGameSlotVerified(targetSlot, copy);
}
