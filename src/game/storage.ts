import {
  DYSON_SHELL_CAPACITY_PER_STRUCTURE,
  DYSON_SHELL_SAIL_POWER_KW,
  DYSON_STRUCTURE_POWER_KW,
  DEFAULT_STATION_WARPER_TARGET,
  DEFAULT_PLANET_TRAY_ITEM_LIMIT,
  MAX_PLANET_TRAY_ITEM_LIMIT,
  MIN_PLANET_TRAY_ITEM_LIMIT,
  SOLAR_SAIL_POWER_KW,
  STATION_SLOT_COUNT,
  STATION_WARPER_CAPACITY_PER_BUILDING,
  advanceSimulation,
  createInitialState,
} from "./engine";
import { BUILDINGS, ITEMS, PLANET_LIST, STAR_SYSTEMS, getBeltConstructionId, getBuilding, getExtractorBuildingId, getPlanet, getRecipe, getTechnology } from "./content";
import { normalizeCampaignState, syncCampaignProgress } from "./campaign";
import { isDifficultyMode } from "./difficulty";
import { isAchievementId } from "./progression";
import { DEFAULT_GALAXY_SEED, GUARANTEED_CRUDE_OIL_PLANETS, createVeinReserve, getPlanetOrbitalYields, getStarLuminosity, isInfiniteResource, normalizeGalaxyState } from "./galaxy";
import { createEndgameState, getOfflineSimulationLimitSeconds } from "./endgame";
import type { BeltConnection, BeltRouteMode, BeltTier, BlueprintDefinition, BlueprintMirror, BlueprintRotation, BuildingId, CanvasRegion, CargoStackSize, ConstructionId, DysonEngineeringState, DysonLayerState, DysonLaunchMode, DysonLaunchThrottle, DysonSpherePlanState, DysonSwarmOrbitState, EnergyMode, EndgameState, FactoryEntity, GalacticDispatchThrottle, GalacticExportProjectId, GameState, InfiniteResearchId, InterstellarRoutePolicy, ItemId, LogisticsPriority, PlanetId, PowerGridId, PowerPriority, ProliferatorMode, ProliferatorTier, RecipeId, StarSystemId, StationLogisticsMode, StationMinimumLoad, StationRoute, StationSlot, TechId } from "./types";

export const SAVE_KEY = "dsp-idle-network.save.v1";
const SAVE_SLOT_KEY_PREFIX = "dsp-idle-network.slot";
const SAVE_BACKUP_KEY = `${SAVE_KEY}.backup`;
const SAVE_SNAPSHOT_KEY_PREFIX = `${SAVE_KEY}.snapshot`;
export const AUTOMATIC_SAVE_SNAPSHOT_LIMIT = 2;
const SAVE_FORMAT_VERSION = 2;
const AUTO_SNAPSHOT_MIN_SECONDS = 5 * 60;
const RETURNING_REWARD_KEY_PREFIX = "dsp-idle-network.returning-reward";
const RETURNING_REWARD_MIN_SECONDS = 72 * 60 * 60;

export type SaveSlotId = 1 | 2 | 3;

export type SaveIntegrityStatus = "valid" | "legacy" | "repaired" | "corrupt";

interface SaveEnvelope {
  formatVersion?: number;
  kind?: "primary" | "slot" | "snapshot";
  reason?: string;
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

export interface SaveRecovery {
  source: "primary" | "backup" | "snapshot" | "fresh";
  issues: string[];
}

export interface OfflineReport {
  seconds: number;
  produced: Array<{ itemId: ItemId; amount: number }>;
  completedTechIds: TechId[];
  structurePointsAdded: number;
  shellSailsAdded: number;
  infiniteResearchLevels?: Array<{ id: InfiniteResearchId; level: number }>;
  exported?: Array<{ projectId: GalacticExportProjectId; amount: number }>;
  galacticCreditsAdded?: number;
  returningReward?: Array<{ itemId: ItemId; amount: number }>;
}

export interface SaveSlotSummary {
  slotId: SaveSlotId;
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
}

export interface SaveInspection {
  valid: boolean;
  repairable: boolean;
  integrity: SaveIntegrityStatus;
  formatVersion: number | null;
  stateVersion: number | null;
  savedAt: number | null;
  checksum: "valid" | "missing" | "invalid";
  issues: string[];
  state: GameState | null;
  summary: Omit<SaveSlotSummary, "slotId" | "integrity" | "valid" | "issues"> | null;
}

export interface ContinueSaveInspection {
  source: SaveRecovery["source"];
  inspection: SaveInspection;
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
function checksumFor(formatVersion: number, state: unknown): string {
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
  const payload = JSON.stringify({ formatVersion, state: projected });
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function envelopeFor(state: GameState, savedAt = Date.now(), kind: SaveEnvelope["kind"] = "primary", reason?: string): SaveEnvelope {
  const persistent = persistentState(state);
  const envelope: SaveEnvelope = {
    formatVersion: SAVE_FORMAT_VERSION,
    kind,
    ...(reason ? { reason } : {}),
    savedAt,
    state: persistent,
  };
  envelope.checksum = checksumFor(SAVE_FORMAT_VERSION, persistent);
  return envelope;
}

function summaryForState(state: GameState): Omit<SaveSlotSummary, "slotId" | "integrity" | "valid" | "issues"> {
  return {
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
      minStock: nonNegativeInteger(slot?.minStock),
      maxStock: nonNegativeInteger(slot?.maxStock),
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
      cargo: nonNegativeInteger(route.cargo),
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
  return value === 1 || value === 2 || value === 3;
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
  for (const researchId of Object.keys(defaults.infiniteResearch) as InfiniteResearchId[]) {
    const source = raw.infiniteResearch?.[researchId];
    const level = nonNegativeInteger(source?.level);
    const progress = nonNegativeInteger(source?.progress);
    infiniteResearch[researchId] = { level, progress };
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
  return {
    ...defaults,
    activeInfiniteResearchId: validInfiniteResearchId(raw.activeInfiniteResearchId) &&
      (saved.research?.completedTechIds ?? []).includes("universe_matrix")
      ? raw.activeInfiniteResearchId
      : null,
    autoResearch: typeof raw.autoResearch === "boolean" ? raw.autoResearch : true,
    autoDispatch: typeof raw.autoDispatch === "boolean" ? raw.autoDispatch : true,
    dispatchThrottle: validDispatchThrottle(raw.dispatchThrottle) ? raw.dispatchThrottle : 1,
    exportProjects,
    galacticCredits: nonNegativeInteger(raw.galacticCredits),
    galacticScore: nonNegativeInteger(raw.galacticScore),
    totalExported: nonNegativeInteger(raw.totalExported),
    exportedLastMinute: nonNegativeNumber(raw.exportedLastMinute),
    exportWindowAmount: nonNegativeInteger(raw.exportWindowAmount),
    exportWindowStartedAt: nonNegativeNumber(raw.exportWindowStartedAt),
    infiniteResearch,
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
  return value === 30 || value === 60 || value === 120;
}

function inferLegacyPlanet(entity: FactoryEntity): PlanetId {
  if (entity.id.startsWith("ashen_")) return "ashen";
  if (entity.resourceId === "silicon_ore" || entity.resourceId === "titanium_ore") return "ashen";
  if (entity.kind !== "vein" && entity.position?.x < -650) return "ashen";
  return "home";
}

export function migrateGame(value: unknown): GameState | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Record<string, any>;
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31].includes(saved.version) || !Array.isArray(saved.entities)) return null;
  const savedSeed = saved.version >= 20 && typeof saved.galaxy?.seed === "number" && Number.isFinite(saved.galaxy.seed)
    ? saved.galaxy.seed
    : DEFAULT_GALAXY_SEED;
  const initial = createInitialState(savedSeed, saved.version < 20);
  const galaxy = normalizeGalaxyState(saved.version >= 20 ? saved.galaxy : { seed: initial.galaxy.seed }, saved.version < 20);
  const entities = saved.entities.map((entity: FactoryEntity) => {
    const currentResource = saved.version < 13
      ? initial.entities.find((candidate) => candidate.kind === "vein" && candidate.id === entity.id)
      : undefined;
    const legacyRelocation = currentResource
      ? { planetId: currentResource.planetId, position: currentResource.position }
      : undefined;
    const planetId = legacyRelocation?.planetId ?? (validPlanetId(entity.planetId) ? entity.planetId : inferLegacyPlanet(entity));
    const position = { ...entity.position };
    if (legacyRelocation) Object.assign(position, legacyRelocation.position);
    const sprayCoaterInstalled = Boolean(entity.sprayCoaterInstalled);
    const planetaryStation = entity.buildingId === "planetary_logistics_station";
    const interstellarStation = entity.buildingId === "interstellar_logistics_station";
    const orbitalCollector = entity.buildingId === "orbital_collector";
    const accumulator = entity.buildingId === "accumulator";
    const energyExchanger = entity.buildingId === "energy_exchanger";
    const materialDeliveryHub = entity.buildingId === "material_delivery_hub";
    const storedEnergyCapacity = accumulator || energyExchanger
      ? (getBuilding(entity.buildingId!).energyCapacityMj ?? 0) * Math.max(0, Math.floor(entity.machineCount ?? 0))
      : 0;
    const resourceId = entity.kind === "vein" && entity.resourceId && ITEMS[entity.resourceId] ? entity.resourceId : undefined;
    const generatedReserve = resourceId ? createVeinReserve(galaxy, planetId, resourceId, entity.id) : undefined;
    if (saved.version < 4 && position.x < -650 && (planetId === "ashen" || entity.resourceId === "water")) {
      position.x += 640;
    }
    return {
      ...entity,
      planetId,
      position,
      inputs: integerRecord(entity.inputs),
      outputs: integerRecord(entity.outputs),
      machineCount: Math.max(0, Math.floor(entity.machineCount ?? 0)),
      minerCount: Math.max(0, Math.floor(entity.minerCount ?? 0)),
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
        ? Math.min(Math.max(1, nonNegativeInteger(entity.resourceCapacity) || generatedReserve || 1), nonNegativeInteger(entity.resourceRemaining) || generatedReserve || 1)
        : undefined,
      recipeId: energyExchanger
        ? entity.energyMode === "discharge" ? "accumulator_discharge" : "accumulator_charge"
        : entity.recipeId,
      routingCursor: Math.max(0, Math.floor(entity.routingCursor ?? 0)),
      distributionMode: entity.kind === "splitter" ? entity.distributionMode ?? "balanced" : entity.distributionMode,
      storedItemId: orbitalCollector
        ? entity.storedItemId && (getPlanetOrbitalYields({ galaxy }, planetId)[entity.storedItemId] ?? 0) > 0 ? entity.storedItemId : "hydrogen"
        : entity.storedItemId,
      deliveryItemIds: materialDeliveryHub
        ? [...new Set((Array.isArray(entity.deliveryItemIds) ? entity.deliveryItemIds : []).filter((itemId): itemId is ItemId => typeof itemId === "string" && itemId in ITEMS))].slice(0, 3)
        : undefined,
      stationMode: entity.kind === "station" ? orbitalCollector ? "supply" : entity.stationMode ?? "supply" : entity.stationMode,
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
      extractorBuildingId: entity.kind === "vein" && entity.minerCount > 0
        ? entity.extractorBuildingId ?? getExtractorBuildingId(entity.resourceId!)
        : entity.extractorBuildingId,
    };
  }) as FactoryEntity[];

  for (const resource of initial.entities.filter((entity) => entity.kind === "vein")) {
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
    return {
      ...belt,
      planetId: validPlanetId(belt.planetId) ? belt.planetId : source?.planetId ?? "home",
      lanes: Math.max(1, Math.floor(belt.lanes ?? 1)),
      tier,
      sorterTier: tier,
      progress: typeof belt.progress === "number" ? Math.max(0, belt.progress) : 0,
      priority: validPriority(belt.priority) ? belt.priority : 0,
      stackSize: validCargoStackSize(belt.stackSize) ? belt.stackSize : 1,
      monitorEnabled: Boolean(belt.monitorEnabled),
      routeMode: validBeltRouteMode(belt.routeMode) ? belt.routeMode : "auto",
      routeOffsetY: routeOffset(belt.routeOffsetY),
      totalTransferred: nonNegativeInteger(belt.totalTransferred),
      congestion: Math.min(1, nonNegativeNumber(belt.congestion)),
      lastFlow: typeof belt.lastFlow === "number" ? belt.lastFlow : 0,
    } as BeltConnection;
  }) : [];
  const belts = migratedBelts.filter((belt) => {
    const source = entities.find((entity) => entity.id === belt.source);
    const target = entities.find((entity) => entity.id === belt.target);
    return source && target && source.planetId === target.planetId && belt.planetId === source.planetId;
  });
  for (const belt of migratedBelts.filter((candidate) => !belts.includes(candidate))) {
    const constructionId = getBeltConstructionId(belt.tier);
    construction[constructionId] = (construction[constructionId] ?? 0) + belt.lanes;
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
    ? 2000
    : completedTechIds.includes("construction_capacity_1") ? 500 : 100;
  const constructionAutomation: GameState["constructionAutomation"] = {
    enabled: saved.version >= 26 ? saved.constructionAutomation?.enabled !== false : true,
    targetStock: Object.fromEntries(Object.entries(saved.version >= 26 ? saved.constructionAutomation?.targetStock ?? {} : {}).flatMap(([constructionId, amount]) =>
      constructionId in initial.construction
        ? [[constructionId, Math.min(constructionAutomationLimit, nonNegativeInteger(amount))]]
        : [])) as GameState["constructionAutomation"]["targetStock"],
    cursor: saved.version >= 26 ? nonNegativeInteger(saved.constructionAutomation?.cursor) % Math.max(1, Object.keys(initial.construction).length) : 0,
    totalCrafted: saved.version >= 26 ? nonNegativeInteger(saved.constructionAutomation?.totalCrafted) : 0,
    lastCraftedId: saved.version >= 26 && typeof saved.constructionAutomation?.lastCraftedId === "string" && saved.constructionAutomation.lastCraftedId in initial.construction
      ? saved.constructionAutomation.lastCraftedId as ConstructionId
      : null,
    jobs: {},
  };
  if (saved.version >= 31 && saved.constructionAutomation?.jobs && typeof saved.constructionAutomation.jobs === "object") {
    const centerIds = new Set(entities.filter((entity) => entity.buildingId === "construction_center").map((entity) => entity.id));
    for (const [entityId, rawJob] of Object.entries(saved.constructionAutomation.jobs as Record<string, any>)) {
      if (!centerIds.has(entityId) || !rawJob || typeof rawJob !== "object" ||
        typeof rawJob.constructionId !== "string" || !(rawJob.constructionId in initial.construction) || !Array.isArray(rawJob.steps)) continue;
      const steps = rawJob.steps.flatMap((step: Record<string, any>) => {
        if (step?.kind === "material" && typeof step.recipeId === "string" && getRecipe(step.recipeId as RecipeId) &&
          typeof step.outputItemId === "string" && step.outputItemId in ITEMS) {
          return [{ kind: "material" as const, recipeId: step.recipeId as RecipeId, batches: Math.max(1, nonNegativeInteger(step.batches)), outputItemId: step.outputItemId as ItemId, outputAmount: Math.max(1, nonNegativeInteger(step.outputAmount)) }];
        }
        if (step?.kind === "building" && typeof step.constructionId === "string" && step.constructionId in initial.construction) {
          return [{ kind: "building" as const, constructionId: step.constructionId as ConstructionId }];
        }
        return [];
      });
      if (steps.length === 0) continue;
      constructionAutomation.jobs[entityId] = {
        constructionId: rawJob.constructionId as ConstructionId,
        steps,
        stepIndex: Math.min(steps.length - 1, nonNegativeInteger(rawJob.stepIndex)),
        elapsedSeconds: nonNegativeNumber(rawJob.elapsedSeconds),
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
  const blueprints: BlueprintDefinition[] = saved.version >= 14 && Array.isArray(saved.blueprints)
    ? saved.blueprints.flatMap((blueprint: Record<string, any>, blueprintIndex: number) => {
      if (!Array.isArray(blueprint.entities)) return [];
      const blueprintEntities = blueprint.entities.flatMap((entity: Record<string, any>, entityIndex: number) => {
        if (typeof entity.buildingId !== "string" || !(entity.buildingId in BUILDINGS)) return [];
        const recipeId = typeof entity.recipeId === "string" && getRecipe(entity.recipeId as RecipeId) ? entity.recipeId as RecipeId : undefined;
        const storedItemId = typeof entity.storedItemId === "string" && entity.storedItemId in ITEMS ? entity.storedItemId as ItemId : undefined;
        const fuelItemId = typeof entity.fuelItemId === "string" && entity.fuelItemId in ITEMS ? entity.fuelItemId as ItemId : undefined;
        return [{
          key: typeof entity.key === "string" && entity.key ? entity.key : `node_${entityIndex + 1}`,
          buildingId: entity.buildingId as BuildingId,
          offset: {
            x: typeof entity.offset?.x === "number" && Number.isFinite(entity.offset.x) ? entity.offset.x : 0,
            y: typeof entity.offset?.y === "number" && Number.isFinite(entity.offset.y) ? entity.offset.y : 0,
          },
          machineCount: Math.max(1, nonNegativeInteger(entity.machineCount)),
          recipeId,
          storedItemId,
          deliveryItemIds: entity.buildingId === "material_delivery_hub"
            ? [...new Set((Array.isArray(entity.deliveryItemIds) ? entity.deliveryItemIds : []).filter((itemId): itemId is ItemId => typeof itemId === "string" && itemId in ITEMS))].slice(0, 3)
            : undefined,
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
      if (blueprintEntities.length === 0) return [];
      const keys = new Set(blueprintEntities.map((entity) => entity.key));
      const blueprintBelts = Array.isArray(blueprint.belts) ? blueprint.belts.flatMap((belt: Record<string, any>, beltIndex: number) => {
        if (!keys.has(belt.sourceKey) || !keys.has(belt.targetKey) || typeof belt.itemId !== "string" || !(belt.itemId in ITEMS)) return [];
        const tier = validBeltTier(belt.tier) ? belt.tier : 1;
        return [{
          key: typeof belt.key === "string" && belt.key ? belt.key : `line_${beltIndex + 1}`,
          sourceKey: belt.sourceKey as string,
          targetKey: belt.targetKey as string,
          itemId: belt.itemId as ItemId,
          lanes: Math.max(1, nonNegativeInteger(belt.lanes)),
          tier,
          sorterTier: tier,
          priority: validPriority(belt.priority) ? belt.priority : 0,
          stackSize: validCargoStackSize(belt.stackSize) ? belt.stackSize : 1,
          monitorEnabled: Boolean(belt.monitorEnabled),
          routeMode: validBeltRouteMode(belt.routeMode) ? belt.routeMode : "auto",
          routeOffsetY: routeOffset(belt.routeOffsetY),
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
      return [{
        id: typeof blueprint.id === "string" && blueprint.id ? blueprint.id : `blueprint_migrated_${blueprintIndex + 1}`,
        name: typeof blueprint.name === "string" && blueprint.name.trim() ? blueprint.name.trim().slice(0, 32) : `蓝图 ${String(blueprintIndex + 1).padStart(2, "0")}`,
        entities: blueprintEntities,
        belts: blueprintBelts,
        externalPorts,
        rotation: validBlueprintRotation(blueprint.rotation) ? blueprint.rotation : 0,
        mirror: validBlueprintMirror(blueprint.mirror) ? blueprint.mirror : "none",
        recipeOverrides,
      } as BlueprintDefinition];
    })
    : [];
  const constructionQueue: GameState["constructionQueue"] = Array.isArray(saved.constructionQueue)
    ? saved.constructionQueue.flatMap((entry: Record<string, any>, index: number) => {
      const blueprint = blueprints.find((candidate) => candidate.id === entry.blueprintId);
      if (!blueprint || !validPlanetId(entry.planetId)) return [];
      return [{
        id: typeof entry.id === "string" && entry.id ? entry.id : `construction_migrated_${index + 1}`,
        blueprintId: blueprint.id,
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
      }];
    })
    : [];
  const handcraftQueue: GameState["handcraftQueue"] = Array.isArray(saved.handcraftQueue)
    ? saved.handcraftQueue.slice(0, 20).flatMap((entry: Record<string, any>, index: number) => {
      if (!getRecipe(entry.recipeId as RecipeId) || !validPlanetId(entry.planetId)) return [];
      const batchesTotal = Math.max(1, Math.min(100, nonNegativeInteger(entry.batchesTotal) || 1));
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
        productionPerMinute: nonNegativeRecord(sample.productionPerMinute),
        consumptionPerMinute: nonNegativeRecord(sample.consumptionPerMinute),
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
        const capacity = Math.max(1, nonNegativeInteger(shell.sailCapacity));
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
    getStarLuminosity({ galaxy }, plan.systemId), 0));
  const sailsInOrbit = saved.version >= 6 ? nonNegativeInteger(saved.dysonSwarm?.sailsInOrbit) : 0;
  const totalExpired = saved.version >= 6 ? nonNegativeInteger(saved.dysonSwarm?.totalExpired) : 0;
  const totalLaunched = saved.version >= 6
    ? Math.max(sailsInOrbit + totalExpired + dysonSphere.totalSailsAbsorbed, nonNegativeInteger(saved.dysonSwarm?.totalLaunched))
    : 0;
  const swarmGenerationKw = sailsInOrbit * SOLAR_SAIL_POWER_KW * getStarLuminosity({ galaxy }, "helios");
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
        generationKw: nonNegativeNumber(orbit.sailsInOrbit) * SOLAR_SAIL_POWER_KW * getStarLuminosity({ galaxy }, systemId),
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
    autosaveIntervalSeconds: validAutosaveInterval(saved.settings?.autosaveIntervalSeconds)
      ? saved.settings.autosaveIntervalSeconds
      : initial.settings.autosaveIntervalSeconds,
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
  const endgame = migrateEndgame(saved);

  const migrated = {
    ...initial,
    ...saved,
    version: 31,
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
    achievements: { unlockedIds: unlockedAchievementIds },
    campaign: normalizeCampaignState(saved.campaign),
    planetViewports,
    canvasBookmarks,
    canvasRegions,
    blueprints,
    constructionQueue,
    handcraftQueue,
    productionPlans,
    productionHistory,
    historyRecordedAt: Math.max(
      nonNegativeNumber(saved.historyRecordedAt),
      productionHistory.at(-1)?.elapsedSeconds ?? 0,
    ),
    metrics: { ...planetMetrics[activePlanetId] },
    planetMetrics,
    powerGridMetrics,
    dysonSwarm,
    dysonSphere,
    dysonEngineering,
    dysonPlans,
    endgame,
  } as GameState;
  return syncCampaignProgress(migrated, { grantRewards: saved.version >= 18 });
}

function persistentState(state: GameState): GameState {
  return {
    ...state,
    // Production curves are runtime diagnostics. Keeping them in every local
    // recovery point multiplies save size without affecting factory progress.
    productionHistory: [],
    planetTrays: { ...state.planetTrays, [state.activePlanetId]: { ...state.tray } },
  };
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
    produced,
    completedTechIds: after.research.completedTechIds.filter((techId) => !beforeTechIds.has(techId)),
    structurePointsAdded: Math.max(0, after.dysonSphere.structurePoints - before.dysonSphere.structurePoints),
    shellSailsAdded: Math.max(0, after.dysonSphere.shellSails - before.dysonSphere.shellSails),
    infiniteResearchLevels,
    exported,
    galacticCreditsAdded: Math.max(0, after.endgame.galacticCredits - before.endgame.galacticCredits),
  };
}

function applyReturningReward(state: GameState, savedAt: number, seconds: number): { state: GameState; reward: Array<{ itemId: ItemId; amount: number }> } {
  if (seconds < RETURNING_REWARD_MIN_SECONDS) return { state, reward: [] };
  const claimKey = `${RETURNING_REWARD_KEY_PREFIX}.${Math.floor(savedAt)}`;
  try {
    if (window.localStorage.getItem(claimKey)) return { state, reward: [] };
  } catch {
    return { state, reward: [] };
  }
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
  try { window.localStorage.setItem(claimKey, String(Date.now())); } catch { /* optional reward receipt */ }
  return { state: next, reward };
}

/** Inspect an imported or locally stored envelope without advancing time. */
export function inspectSave(raw: string): SaveInspection {
  const invalid = (issues: string[], formatVersion: number | null = null, stateVersion: number | null = null): SaveInspection => ({
    valid: false,
    repairable: false,
    integrity: "corrupt",
    formatVersion,
    stateVersion,
    savedAt: null,
    checksum: "invalid",
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

  let checksum: SaveInspection["checksum"] = "missing";
  let checksumMatchedAfterMigration = false;
  if (typeof envelope.checksum === "string" && envelope.checksum.length > 0) {
    const expected = checksumFor(formatVersion, envelope.state);
    checksum = envelope.checksum === expected ? "valid" : "invalid";
  } else {
    issues.push("旧版存档没有完整性校验，导入后会自动补写");
  }

  let state: GameState | null = null;
  try {
    state = migrateGame(envelope.state);
  } catch {
    return invalid(["存档数据结构无法修复"], formatVersion, stateVersion);
  }
  if (!state) return invalid(["游戏状态版本不受支持或缺少实体列表"], formatVersion, stateVersion);

  if (checksum === "invalid" && typeof envelope.checksum === "string") {
    // Unknown legacy fields (for example an achievement added by a newer
    // client) are removed by migration. Accept that lossless normalization,
    // but still reject changes to meaningful game state.
    checksumMatchedAfterMigration = envelope.checksum === checksumFor(formatVersion, state);
    if (!checksumMatchedAfterMigration) return invalid(["完整性校验失败：文件可能被截断或修改"], formatVersion, stateVersion);
    checksum = "valid";
    issues.push("检测到可忽略的旧字段差异，已按当前目录标准化");
  }

  const migrated = stateVersion !== state.version;
  const formatUpgrade = formatVersion < SAVE_FORMAT_VERSION || !hasEnvelope;
  if (migrated) issues.push(`游戏状态已从 v${stateVersion ?? "未知"} 迁移到 v${state.version}`);
  if (!hasEnvelope) issues.push("检测到旧版裸状态格式");
  if (formatUpgrade && !hasEnvelope) issues.push(`导入后会升级到存档格式 v${SAVE_FORMAT_VERSION}`);
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
    checksum,
    issues,
    state,
    summary,
  };
}

function parseEnvelope(raw: string, advanceOffline: boolean): LoadedGame | null {
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

export function loadGame(): LoadedGame {
  try {
    const candidates: Array<{ source: SaveRecovery["source"]; raw: string | null; issues?: string[] }> = [
      { source: "primary", raw: window.localStorage.getItem(SAVE_KEY) },
      { source: "backup", raw: window.localStorage.getItem(SAVE_BACKUP_KEY), issues: ["主存档校验失败，已回退到最近一次有效备份"] },
    ];
    for (const key of listSnapshotKeys()) {
      candidates.push({ source: "snapshot", raw: window.localStorage.getItem(key), issues: ["主存档不可用，已回退到自动快照"] });
    }
    for (const candidate of candidates) {
      if (!candidate.raw) continue;
      const loaded = parseEnvelope(candidate.raw, true);
      if (!loaded) continue;
      if (candidate.source !== "primary") loaded.recovery = { source: candidate.source, issues: candidate.issues ?? [] };
      return loaded;
    }
    return {
      state: createInitialState(),
      offlineSeconds: 0,
      offlineReport: null,
      recovery: { source: "fresh", issues: ["没有找到可恢复的存档，已创建新工厂"] },
    };
  } catch {
    return { state: createInitialState(), offlineSeconds: 0, offlineReport: null, recovery: { source: "fresh", issues: ["本地存储不可用，已创建临时工厂"] } };
  }
}

/** Inspect the save that Continue will load without advancing offline time. */
export function inspectContinueSave(): ContinueSaveInspection | null {
  try {
    const candidates: Array<{ source: SaveRecovery["source"]; raw: string | null }> = [
      { source: "primary", raw: window.localStorage.getItem(SAVE_KEY) },
      { source: "backup", raw: window.localStorage.getItem(SAVE_BACKUP_KEY) },
      ...listSnapshotKeys().map((key) => ({ source: "snapshot" as const, raw: window.localStorage.getItem(key) })),
    ];
    for (const candidate of candidates) {
      if (!candidate.raw) continue;
      const inspection = inspectSave(candidate.raw);
      if (inspection.valid && inspection.state) return { source: candidate.source, inspection };
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

export function saveGame(state: GameState): SaveGameResult {
  const savedAt = Date.now();
  let raw: string;
  try {
    raw = JSON.stringify(envelopeFor(state, savedAt));
  } catch {
    return failedSave("unavailable", "无法生成本地主存档，请立即导出当前进度");
  }

  const bytes = utf8ByteLength(raw);
  let previous: string | null = null;
  let removedAutomaticSnapshots = 0;
  try {
    previous = window.localStorage.getItem(SAVE_KEY);
    removedAutomaticSnapshots += prepareAutomaticSnapshotsForPrimarySave();
  } catch {
    return failedSave("unavailable", "本地存储当前不可用，请立即导出当前进度", bytes, removedAutomaticSnapshots);
  }

  const writeAndVerify = (): boolean => {
    window.localStorage.setItem(SAVE_KEY, raw);
    const stored = window.localStorage.getItem(SAVE_KEY);
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
      removedAutomaticSnapshots += removeAutomaticSnapshotsForQuotaRetry();
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

  let backupSaved = false;
  if (previous && inspectSave(previous).valid) {
    try {
      window.localStorage.setItem(SAVE_BACKUP_KEY, previous);
      backupSaved = window.localStorage.getItem(SAVE_BACKUP_KEY) === previous;
    } catch {
      // The verified primary save has priority over its optional previous-version backup.
    }
  }

  // Recovery points are best effort and must never turn a verified primary
  // write into a reported failure.
  maybeSaveAutomaticSnapshot(state);
  return {
    success: true,
    message: "主存档已保存",
    savedAt,
    bytes,
    removedAutomaticSnapshots,
    backupSaved,
  };
}

export function exportGame(state: GameState): string {
  return JSON.stringify(envelopeFor(state));
}

export function importGame(raw: string): GameState | null {
  try {
    return parseEnvelope(raw, false)?.state ?? null;
  } catch {
    return null;
  }
}

function saveSlotKey(slotId: SaveSlotId): string {
  return `${SAVE_SLOT_KEY_PREFIX}.${slotId}`;
}

export function saveGameSlot(slotId: SaveSlotId, state: GameState): void {
  window.localStorage.setItem(saveSlotKey(slotId), JSON.stringify(envelopeFor(state, Date.now(), "slot")));
}

export function loadGameSlot(slotId: SaveSlotId): LoadedGame | null {
  try {
    const raw = window.localStorage.getItem(saveSlotKey(slotId));
    return raw ? parseEnvelope(raw, true) : null;
  } catch {
    return null;
  }
}

/** Export a validated manual slot without applying offline simulation. */
export function exportGameSlot(slotId: SaveSlotId): string | null {
  try {
    const raw = window.localStorage.getItem(saveSlotKey(slotId));
    if (!raw) return null;
    const inspection = inspectSave(raw);
    return inspection.valid && inspection.state ? raw : null;
  } catch {
    return null;
  }
}

export function clearGameSlot(slotId: SaveSlotId): void {
  window.localStorage.removeItem(saveSlotKey(slotId));
}

export function getSaveSlotSummaries(): SaveSlotSummary[] {
  return ([1, 2, 3] as SaveSlotId[]).flatMap((slotId) => {
    try {
      const raw = window.localStorage.getItem(saveSlotKey(slotId));
      if (!raw) return [];
      const inspection = inspectSave(raw);
      const parsed = JSON.parse(raw) as Partial<SaveEnvelope>;
      const summary = inspection.summary ?? {
        savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
        elapsedSeconds: 0,
        completedTechCount: 0,
        structurePoints: 0,
        activePlanetId: "home" as PlanetId,
      };
      return [{
        slotId,
        ...summary,
        integrity: inspection.integrity,
        valid: inspection.valid,
        issues: inspection.issues,
      }];
    } catch {
      return [];
    }
  });
}

function listSnapshotKeys(): string[] {
  const sequenceKey = `${SAVE_SNAPSHOT_KEY_PREFIX}.sequence`;
  return Object.keys(window.localStorage)
    .filter((key) => key.startsWith(`${SAVE_SNAPSHOT_KEY_PREFIX}.`) && key !== sequenceKey)
    .sort((left, right) => right.localeCompare(left));
}

interface StoredSnapshotEntry {
  key: string;
  savedAt: number;
  automatic: boolean;
  hasPersistedProductionHistory: boolean;
}

function storedSnapshotEntries(): StoredSnapshotEntry[] {
  return listSnapshotKeys().flatMap((key) => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return [];
      const reason = typeof parsed.reason === "string" ? parsed.reason : "";
      const state = isRecord(parsed.state) ? parsed.state : parsed;
      const history = isRecord(state) && Array.isArray(state.productionHistory) ? state.productionHistory : [];
      const idTimestamp = Number(key.slice(`${SAVE_SNAPSHOT_KEY_PREFIX}.`.length).split("-")[0]);
      return [{
        key,
        savedAt: typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt)
          ? parsed.savedAt
          : Number.isFinite(idTimestamp) ? idTimestamp : 0,
        automatic: reason.length === 0 || reason === "自动快照",
        hasPersistedProductionHistory: history.length > 0,
      }];
    } catch {
      // Unknown or corrupt snapshots are left untouched. They may be a manual
      // recovery point whose reason can no longer be read safely.
      return [];
    }
  }).sort((left, right) => right.savedAt - left.savedAt || right.key.localeCompare(left.key));
}

function removeStoredSnapshots(entries: StoredSnapshotEntry[]): number {
  let removed = 0;
  for (const entry of entries) {
    window.localStorage.removeItem(entry.key);
    removed += 1;
  }
  return removed;
}

function trimAutomaticSnapshots(limit: number): number {
  const automatic = storedSnapshotEntries().filter((entry) => entry.automatic);
  return removeStoredSnapshots(automatic.slice(Math.max(0, limit)).reverse());
}

function prepareAutomaticSnapshotsForPrimarySave(): number {
  let automatic = storedSnapshotEntries().filter((entry) => entry.automatic);
  let removed = 0;
  if (automatic.some((entry) => entry.hasPersistedProductionHistory) && automatic.length > 1) {
    // On the first emergency save retain only the newest automatic recovery
    // point. Manual snapshots and slots are never part of this cleanup.
    removed += removeStoredSnapshots(automatic.slice(1).reverse());
    automatic = storedSnapshotEntries().filter((entry) => entry.automatic);
  }
  if (automatic.length > AUTOMATIC_SAVE_SNAPSHOT_LIMIT) {
    removed += removeStoredSnapshots(automatic.slice(AUTOMATIC_SAVE_SNAPSHOT_LIMIT).reverse());
  }
  return removed;
}

function removeAutomaticSnapshotsForQuotaRetry(): number {
  const oldestFirst = storedSnapshotEntries()
    .filter((entry) => entry.automatic)
    .sort((left, right) => left.savedAt - right.savedAt || left.key.localeCompare(right.key));
  return removeStoredSnapshots(oldestFirst);
}

function nextSnapshotSequence(): number {
  const sequenceKey = `${SAVE_SNAPSHOT_KEY_PREFIX}.sequence`;
  const previous = Number(window.localStorage.getItem(sequenceKey) ?? 0);
  const next = Number.isFinite(previous) ? Math.max(0, Math.floor(previous)) + 1 : 1;
  window.localStorage.setItem(sequenceKey, String(next));
  return next;
}

function maybeSaveAutomaticSnapshot(state: GameState): void {
  const latest = getSaveSnapshotSummaries().find((snapshot) => snapshot.valid && snapshot.reason === "自动快照");
  if (!latest || state.elapsedSeconds < latest.elapsedSeconds || state.elapsedSeconds - latest.elapsedSeconds >= AUTO_SNAPSHOT_MIN_SECONDS) {
    saveGameSnapshot(state, "自动快照");
  }
}

export function saveGameSnapshot(state: GameState, reason = "自动快照"): SaveSnapshotSummary | null {
  try {
    const savedAt = Date.now();
    const sequence = nextSnapshotSequence();
    const id = `${savedAt}-${sequence}`;
    const key = `${SAVE_SNAPSHOT_KEY_PREFIX}.${id}`;
    window.localStorage.setItem(key, JSON.stringify(envelopeFor(state, savedAt, "snapshot", reason)));
    if (reason === "自动快照") trimAutomaticSnapshots(AUTOMATIC_SAVE_SNAPSHOT_LIMIT);
    return getSaveSnapshotSummaries().find((snapshot) => snapshot.id === id) ?? null;
  } catch {
    return null;
  }
}

export function getSaveSnapshotSummaries(): SaveSnapshotSummary[] {
  return listSnapshotKeys().flatMap((key) => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return [];
      const inspection = inspectSave(raw);
      const parsed = JSON.parse(raw) as Partial<SaveEnvelope>;
      const id = key.slice(`${SAVE_SNAPSHOT_KEY_PREFIX}.`.length);
      const summary = inspection.summary ?? {
        savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
        elapsedSeconds: 0,
        completedTechCount: 0,
        structurePoints: 0,
        activePlanetId: "home" as PlanetId,
      };
      return [{
        id,
        ...summary,
        reason: typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "自动快照",
        integrity: inspection.integrity,
        valid: inspection.valid,
        issues: inspection.issues,
      }];
    } catch {
      return [];
    }
  }).sort((left, right) => right.savedAt - left.savedAt);
}

export function loadSaveSnapshot(id: string): GameState | null {
  try {
    const raw = window.localStorage.getItem(`${SAVE_SNAPSHOT_KEY_PREFIX}.${id}`);
    return raw ? parseEnvelope(raw, false)?.state ?? null : null;
  } catch {
    return null;
  }
}

export function clearSaveSnapshot(id: string): void {
  window.localStorage.removeItem(`${SAVE_SNAPSHOT_KEY_PREFIX}.${id}`);
}

export function clearGame(): void {
  window.localStorage.removeItem(SAVE_KEY);
}
