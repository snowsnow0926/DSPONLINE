import {
  BUILDINGS,
  CONSTRUCTION,
  FUEL_ENERGY_MJ,
  ITEMS,
  MATRIX_ITEM_IDS,
  PLANET_LIST,
  PROLIFERATOR_ITEM_IDS,
  RECIPES,
  STAR_SYSTEM_LIST,
  STAR_SYSTEMS,
  buildingSupportsRecipe,
  getBeltConstructionId,
  getBeltSpeed,
  getNextBeltTier,
  getBuilding,
  getBuildingUpgradeTarget,
  getConstructionDefinition,
  getExtractorBuildingId,
  getFuelEfficiency,
  getFuelItemIdsForBuilding,
  getPlanet,
  getProliferator,
  getRecipe,
  getRecipesForBuilding,
  getStarSystem,
  getTechnology,
  isDeprecatedTechnology,
} from "./content";
import {
  DEFAULT_GALAXY_SEED,
  createGalaxyState,
  createPlayerGalaxySeed,
  createVeinReserve,
  getPlanetIndustrialProfile,
  getPlanetOrbitalYields,
  getPlanetSolarPowerMultiplier,
  getStarLuminosity,
  getSystemDistanceLy,
  isInfiniteResource,
  normalizePlanetDisplayMetadata,
  normalizeStarSystemDisplayMetadata,
  specializationApplies,
} from "./galaxy";
import { completeStationOperationModeTransition, createEmptyGalacticHubNetwork, createEmptySystemSpaceStations, settleSpaceStationConstructionInputs } from "./systemSpaceStation";
import { isElevatorStation, settleSystemHubLogistics, SYSTEM_HUB_SETTLEMENT_SECONDS } from "./systemHubLogistics";
import { compactProductionHistory, PRODUCTION_HISTORY_SAMPLE_SECONDS } from "./productionStatistics";
import type {
  BeltTier,
  BeltRouteMode,
  BeltConnection,
  BlueprintDefinition,
  BlueprintResourceAnchor,
  BlueprintMirror,
  BlueprintRotation,
  BuildingId,
  CanvasRegion,
  CargoStackSize,
  ConstructionId,
  DecimalIntegerString,
  DysonEngineeringSnapshot,
  DysonEngineeringState,
  DysonLayerState,
  DysonLaunchMode,
  DysonLaunchThrottle,
  DysonSwarmOrbitState,
  DysonSpherePlanState,
  EnergyMode,
  EntityOperatingStatus,
  FactoryEntity,
  GameState,
  ItemId,
  InterstellarRoutePolicy,
  LogisticsPriority,
  MaterialDeliverySlot,
  MaterialDeliverySlotMode,
  PlanetId,
  PlanetIndustryRole,
  PowerGridId,
  PowerGridMetrics,
  PowerPriority,
  PortableFleetItemId,
  ProliferatorMode,
  ProliferatorTier,
  RecipeDefinition,
  RecipeId,
  ConstructionAutomationStep,
  ConstructionAutomationJob,
  ConstructionAutomationTargetId,
  SorterTier,
  StationLogisticsMode,
  StationLogisticsScope,
  StarSystemId,
  StationMinimumLoad,
  StationRoute,
  StationSlot,
  StationSlotTemplate,
  TechId,
} from "./types";
import { syncCampaignProgress } from "./campaign";
import { getDifficultyDefinition } from "./difficulty";
import {
  GALACTIC_EXPORT_DEFINITIONS,
  INFINITE_RESEARCH_BY_ID,
  createEndgameState,
  getGalacticExportDefinition,
  getGalacticExportReward,
  getGalacticExportTarget,
  getInfiniteResearchCost,
  getInfiniteResearchLevel,
  isEndgameUnlocked,
} from "./endgame";
import type { GalacticDispatchThrottle, GalacticExportProjectId, InfiniteResearchId } from "./types";
import {
  getInfiniteResearchCompletionBasisPoints,
  getInfiniteResearchCostBigInt,
  getInfiniteResearchMaximumLevel,
  isInfiniteResearchComplete,
  settleInfiniteResearchBudget,
} from "./infiniteResearch";
import { ACTIVITY_MATERIAL_IDS, ACTIVITY_PROJECT_BY_ITEM } from "./activity";
import { formatPowerKw } from "./units";
import {
  addQuantumInteger,
  beginOrbitalCollectorQuantumModeChange,
  beginOrbitalCollectorQuantumModeChanges,
  depositIntoQuantumInventory,
  createEmptyQuantumLogisticsNetworkState,
  beginQuantumAttachment,
  beginQuantumAttachments,
  getQuantumBandwidthSummary,
  getQuantumLogisticsMultiplier,
  getQuantumItemCapacity,
  normalizeQuantumInteger,
  setQuantumNetworkItemCapacity,
  settleQuantumAttachments,
  settleQuantumLogisticsNetwork,
  QUANTUM_SETTLEMENT_SECONDS,
  QUANTUM_UNIT_CAP_PER_MINUTE,
} from "./quantumLogisticsNetwork";
import type { QuantumSettlementInput, QuantumSettlementOutput } from "./quantumLogisticsNetwork";
import {
  getRecipeNetOutput,
  planRecursiveRequirements,
  planSelectedRecipe,
  type RecursiveCraftBlocker,
  type RecursiveCraftDecision,
  type RecursiveCraftPlan,
} from "./recursiveCrafting";
import { advanceSpeedrunClock, createSpeedrunState, evaluateSpeedrunMilestones } from "./speedrun";
import { createIdleSettlementState } from "./idleSettlement";

export const ACCUMULATOR_ENERGY_MJ = 90;
export const SOLAR_SAIL_POWER_KW = 88;
export const SOLAR_SAIL_LIFETIME_SECONDS = 1200;
export const RAY_RECEIVER_CAPACITY_KW = 6000;
export const DYSON_STRUCTURE_POWER_KW = 960;
export const DYSON_SHELL_SAIL_POWER_KW = 88;
export const DYSON_SHELL_CAPACITY_PER_STRUCTURE = 40;
export const DYSON_SAIL_ABSORPTION_PER_STRUCTURE_PER_SECOND = 0.1;
export const DYSON_SAIL_LAUNCH_ENERGY_MJ = 21.6;
export const DYSON_ROCKET_LAUNCH_ENERGY_MJ = 108;
export const INTERSTELLAR_TRIP_SECONDS = 30;
export const WARP_TRIP_SECONDS = 12;
export const INTERSTELLAR_CARGO_PER_VESSEL = 100;
export const STATION_VESSELS_PER_BUILDING = 10;
export const PLANETARY_TRIP_SECONDS = 8;
export const PLANETARY_CARGO_PER_DRONE = 25;
export const STATION_DRONES_PER_BUILDING = 50;
export const STATION_WARPER_CAPACITY_PER_BUILDING = 50;
export const DEFAULT_STATION_WARPER_TARGET = STATION_WARPER_CAPACITY_PER_BUILDING;
export const STATION_MINIMUM_LOAD_OPTIONS: StationMinimumLoad[] = [0.1, 0.25, 0.5, 1];
export const STATION_SLOT_COUNT = 5;
export const PORTABLE_FLEET_ITEM_IDS: PortableFleetItemId[] = ["logistics_drone", "logistics_vessel"];
export const CARGO_STACK_OPTIONS: CargoStackSize[] = [1, 2, 4];
export const MAX_BELT_LANES = 4096;
export const POWER_GRID_IDS: PowerGridId[] = ["grid-a", "grid-b", "grid-c"];
export const POWER_GRID_LABELS: Record<PowerGridId, string> = {
  "grid-a": "A 主网",
  "grid-b": "B 工业网",
  "grid-c": "C 备用网",
};
/** Zero represents an unlimited, planet-wide grid domain. */
export const POWER_SUPPLY_RADIUS = 0;
export const MATERIAL_DELIVERY_SLOT_COUNT = 3;
const VEIN_DEPLETION_SCALE = 10;
export const MIN_PLANET_TRAY_ITEM_LIMIT = 1_000;
export const MAX_PLANET_TRAY_ITEM_LIMIT = 100_000_000;

function normalizedDefaultBeltLanes(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 1
    ? Math.min(MAX_BELT_LANES, value as number)
    : 1;
}
export const DEFAULT_PLANET_TRAY_ITEM_LIMIT = 1_000_000;
export const MIN_CANVAS_REGION_SIZE = 40;
const EPSILON = 0.0001;
const TIME_WARP_MINIMUM_MULTIPLIER = 4;
const TIME_WARP_BASE_POWER_KW = 100_000;

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function roundBeltMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function getTimeWarpRequiredPowerKw(multiplier: number): number | null {
  if (!Number.isSafeInteger(multiplier) || multiplier < TIME_WARP_MINIMUM_MULTIPLIER) return null;
  const exponent = multiplier + 1;
  if (exponent > 308) return null;
  const power = 10 ** exponent;
  return Number.isFinite(power) ? power : null;
}

export function getMaximumStableTimeWarpMultiplier(availablePowerKw: number, requestedMultiplier: number): number | null {
  if (!Number.isFinite(availablePowerKw) || availablePowerKw < TIME_WARP_BASE_POWER_KW ||
    !Number.isSafeInteger(requestedMultiplier) || requestedMultiplier < 5) return null;
  const supported = Math.max(TIME_WARP_MINIMUM_MULTIPLIER, Math.floor(Math.log10(availablePowerKw) - 1 + 1e-12));
  return Math.min(requestedMultiplier, supported);
}

export function isPortableFleetItem(itemId: ItemId | ConstructionId): itemId is PortableFleetItemId {
  return PORTABLE_FLEET_ITEM_IDS.includes(itemId as PortableFleetItemId);
}

function copyState(state: GameState): GameState {
  const sourceEndgame = state.endgame ?? createEndgameState();
  const planetTrays = Object.fromEntries(Object.entries(state.planetTrays).map(([planetId, tray]) => [
    planetId,
    { ...(planetId === state.activePlanetId ? state.tray : tray) },
  ])) as GameState["planetTrays"];
  return {
    ...state,
    entities: state.entities.map((entity) => ({
      ...entity,
      position: { ...entity.position },
      inputs: { ...entity.inputs },
      outputs: { ...entity.outputs },
      stationSlots: entity.stationSlots?.map((slot) => ({ ...slot })),
      deliveryItemIds: entity.deliveryItemIds ? [...entity.deliveryItemIds] : undefined,
      deliverySlots: entity.deliverySlots?.map((slot) => ({ ...slot })),
      stationRoutes: entity.stationRoutes?.map((route) => ({
        ...route,
        waypointStationIds: route.waypointStationIds ? [...route.waypointStationIds] : [],
      })),
      stationLastSupplyPeerBySlot: { ...entity.stationLastSupplyPeerBySlot },
      blackHolePorts: entity.blackHolePorts?.map((port) => ({ ...port })),
      proliferatorBonusProgress: { ...entity.proliferatorBonusProgress },
    })),
    belts: state.belts.map((belt) => ({ ...belt })),
    canvasBookmarks: state.canvasBookmarks.map((bookmark) => ({ ...bookmark, viewport: { ...bookmark.viewport } })),
    canvasRegions: state.canvasRegions.map((region) => ({ ...region })),
    cargo: state.cargo ? { ...state.cargo, origin: state.cargo.origin ? { ...state.cargo.origin } : undefined } : null,
    tray: { ...state.tray },
    planetTrays,
    planetTrayItemLimits: { ...state.planetTrayItemLimits },
    construction: { ...state.construction },
    constructionAutomation: {
      ...state.constructionAutomation,
      targetStock: { ...state.constructionAutomation.targetStock },
      destroyedByproducts: { ...state.constructionAutomation.destroyedByproducts },
      jobs: Object.fromEntries(Object.entries(state.constructionAutomation.jobs).map(([entityId, job]) => [
        entityId,
        {
          ...job,
          steps: job.steps.map((step) => ({ ...step })),
          inventory: { ...job.inventory },
          recipeDecisions: job.recipeDecisions?.map((decision) => ({ ...decision })),
        },
      ])),
    },
    portableFleet: state.portableFleet ? { ...state.portableFleet } : { logistics_drone: 0, logistics_vessel: 0 },
    totalProduced: { ...state.totalProduced },
    research: {
      ...state.research,
      pausedTechId: state.research.pausedTechId,
      queuedTechIds: [...state.research.queuedTechIds],
      progressByTech: Object.fromEntries(Object.entries(state.research.progressByTech).map(([techId, progress]) => [
        techId,
        { ...progress },
      ])),
      completedTechIds: [...state.research.completedTechIds],
    },
    exploration: {
      unlockedSystemIds: [...state.exploration.unlockedSystemIds],
      colonizedPlanetIds: [...state.exploration.colonizedPlanetIds],
      missions: state.exploration.missions.map((mission) => ({ ...mission })),
      surveyProgressBySystem: { ...state.exploration.surveyProgressBySystem },
    },
    galaxy: {
      ...state.galaxy,
      profiles: Object.fromEntries(Object.entries(state.galaxy.profiles).map(([planetId, profile]) => [
        planetId,
        {
          ...profile,
          resourceIds: [...profile.resourceIds],
          rareResourceIds: [...profile.rareResourceIds],
          orbitalYields: { ...profile.orbitalYields },
          colonyCost: profile.colonyCost.map((cost) => ({ ...cost })),
        },
      ])) as GameState["galaxy"]["profiles"],
      systemProfiles: Object.fromEntries(Object.entries(state.galaxy.systemProfiles).map(([systemId, profile]) => [
        systemId,
        { ...profile },
      ])) as GameState["galaxy"]["systemProfiles"],
      planetRoles: { ...(state.galaxy.planetRoles ?? {}) },
      planetMetadata: Object.fromEntries(Object.entries(state.galaxy.planetMetadata ?? {}).map(([planetId, metadata]) => [
        planetId,
        metadata ? { ...metadata, tags: [...metadata.tags] } : metadata,
      ])),
      systemMetadata: Object.fromEntries(Object.entries(state.galaxy.systemMetadata ?? {}).map(([systemId, metadata]) => [
        systemId,
        metadata ? { ...metadata } : metadata,
      ])),
    },
    recipeFocus: { ...state.recipeFocus, position: { ...state.recipeFocus.position } },
    planetViewports: Object.fromEntries(Object.entries(state.planetViewports).map(([planetId, viewport]) => [
      planetId,
      { ...viewport },
    ])) as GameState["planetViewports"],
    blueprints: state.blueprints.map((blueprint) => ({
      ...blueprint,
      entities: blueprint.entities.map((entity) => ({
        ...entity,
        offset: { ...entity.offset },
        stationSlots: entity.stationSlots?.map((slot) => ({ ...slot })),
        deliverySlots: entity.deliverySlots?.map((slot) => ({ ...slot })),
      })),
      resourceAnchors: blueprint.resourceAnchors?.map((anchor) => ({ ...anchor, offset: { ...anchor.offset } })),
      belts: blueprint.belts.map((belt) => ({ ...belt })),
      externalPorts: blueprint.externalPorts?.map((port) => ({ ...port, offset: { ...port.offset } })),
      recipeOverrides: { ...blueprint.recipeOverrides },
    })),
    blueprintVersions: (state.blueprintVersions ?? []).map((snapshot) => ({
      ...snapshot,
      definition: {
        ...snapshot.definition,
        entities: snapshot.definition.entities.map((entity) => ({
          ...entity,
          offset: { ...entity.offset },
          stationSlots: entity.stationSlots?.map((slot) => ({ ...slot })),
          deliverySlots: entity.deliverySlots?.map((slot) => ({ ...slot })),
        })),
        resourceAnchors: snapshot.definition.resourceAnchors?.map((anchor) => ({ ...anchor, offset: { ...anchor.offset } })),
        belts: snapshot.definition.belts.map((belt) => ({ ...belt })),
        externalPorts: snapshot.definition.externalPorts?.map((port) => ({ ...port, offset: { ...port.offset } })),
        recipeOverrides: { ...snapshot.definition.recipeOverrides },
      },
    })),
    constructionQueue: state.constructionQueue.map((entry) => ({
      ...entry,
      position: { ...entry.position },
      reservedConstruction: { ...entry.reservedConstruction },
      reservedFleet: { ...entry.reservedFleet },
      placedEntityIdsByKey: { ...entry.placedEntityIdsByKey },
    })),
    handcraftQueue: state.handcraftQueue.map((entry) => ({ ...entry })),
    productionPlans: state.productionPlans.map((plan) => ({ ...plan, recipeSelections: { ...plan.recipeSelections } })),
    productionHistory: state.productionHistory.map((sample) => ({
      ...sample,
      productionPerMinute: { ...sample.productionPerMinute },
      consumptionPerMinute: { ...sample.consumptionPerMinute },
      planetProductionPerMinute: sample.planetProductionPerMinute
        ? Object.fromEntries(Object.entries(sample.planetProductionPerMinute).map(([planetId, values]) => [planetId, { ...values }])) as GameState["productionHistory"][number]["planetProductionPerMinute"]
        : undefined,
      planetConsumptionPerMinute: sample.planetConsumptionPerMinute
        ? Object.fromEntries(Object.entries(sample.planetConsumptionPerMinute).map(([planetId, values]) => [planetId, { ...values }])) as GameState["productionHistory"][number]["planetConsumptionPerMinute"]
        : undefined,
      inventory: { ...sample.inventory },
    })),
    metrics: { ...state.metrics },
    planetMetrics: Object.fromEntries(Object.entries(state.planetMetrics).map(([planetId, metrics]) => [
      planetId,
      { ...metrics },
    ])) as GameState["planetMetrics"],
    powerGridMetrics: Object.fromEntries(Object.entries(state.powerGridMetrics).map(([planetId, grids]) => [
      planetId,
      Object.fromEntries(Object.entries(grids).map(([gridId, metrics]) => [gridId, { ...metrics }])),
    ])) as GameState["powerGridMetrics"],
    dysonSwarm: { ...state.dysonSwarm },
    dysonSphere: { ...state.dysonSphere },
    dysonEngineering: {
      ...state.dysonEngineering,
      activeOrbitBySystem: { ...state.dysonEngineering.activeOrbitBySystem },
      absorptionProgressBySystem: { ...state.dysonEngineering.absorptionProgressBySystem },
      orbitsBySystem: Object.fromEntries(Object.entries(state.dysonEngineering.orbitsBySystem).map(([systemId, orbits]) => [
        systemId,
        orbits.map((orbit) => ({ ...orbit })),
      ])) as GameState["dysonEngineering"]["orbitsBySystem"],
    },
    dysonPlans: Object.fromEntries(Object.entries(state.dysonPlans).map(([systemId, plan]) => [
      systemId,
      {
        ...plan,
        layers: plan.layers.map((layer) => ({
          ...layer,
          nodes: layer.nodes.map((node) => ({ ...node })),
          frames: layer.frames.map((frame) => ({ ...frame })),
          shells: layer.shells.map((shell) => ({ ...shell, boundaryFrameIds: [...shell.boundaryFrameIds] })),
        })),
      },
    ])) as GameState["dysonPlans"],
    systemSpaceStations: Object.fromEntries(Object.entries(state.systemSpaceStations).map(([systemId, station]) => [
      systemId,
      {
        ...station,
        delivered: { ...station.delivered },
        constructionBuffer: { ...station.constructionBuffer },
        inventory: { ...station.inventory },
        itemPolicies: Object.fromEntries(Object.entries(station.itemPolicies).map(([itemId, policy]) => [itemId, policy ? { ...policy } : policy])),
        modules: { ...station.modules },
        routingCursors: { ...station.routingCursors },
        viewport: { ...station.viewport },
        decorations: station.decorations.map((decoration) => ({ ...decoration, position: { ...decoration.position } })),
      },
    ])) as GameState["systemSpaceStations"],
    galacticHubNetwork: {
      ...state.galacticHubNetwork,
      fleetReturns: state.galacticHubNetwork.fleetReturns.map((bucket) => ({ ...bucket })),
      routingCursors: { ...state.galacticHubNetwork.routingCursors },
    },
    quantumLogisticsNetwork: {
      enabled: state.quantumLogisticsNetwork?.enabled === true,
      inventory: { ...(state.quantumLogisticsNetwork?.inventory ?? {}) },
      itemCapacities: { ...(state.quantumLogisticsNetwork?.itemCapacities ?? {}) },
      routingCursors: { ...(state.quantumLogisticsNetwork?.routingCursors ?? {}) },
      uploadRoutingCursors: { ...(state.quantumLogisticsNetwork?.uploadRoutingCursors ?? {}) },
      ...(state.quantumLogisticsNetwork?.runtimeFlow ? {
        runtimeFlow: {
          ...state.quantumLogisticsNetwork.runtimeFlow,
          uploaded: { ...state.quantumLogisticsNetwork.runtimeFlow.uploaded },
          downloaded: { ...state.quantumLogisticsNetwork.runtimeFlow.downloaded },
        },
      } : {}),
    },
    timeWarp: { ...state.timeWarp },
    idleSettlement: {
      ...state.idleSettlement,
      currentRunProduction: { ...state.idleSettlement.currentRunProduction },
      totalProduction: { ...state.idleSettlement.totalProduction },
    },
    endgame: {
      ...sourceEndgame,
      exportProjects: Object.fromEntries(Object.entries(sourceEndgame.exportProjects).map(([projectId, project]) => [
        projectId,
        { ...project },
      ])) as GameState["endgame"]["exportProjects"],
      infiniteResearch: Object.fromEntries(Object.entries(sourceEndgame.infiniteResearch).map(([researchId, progress]) => [
        researchId,
        { ...progress },
      ])) as GameState["endgame"]["infiniteResearch"],
      constructionActivity: {
        ...sourceEndgame.constructionActivity,
        personalTargets: { ...sourceEndgame.constructionActivity.personalTargets },
        globalTargets: { ...sourceEndgame.constructionActivity.globalTargets },
        personalDelivered: { ...sourceEndgame.constructionActivity.personalDelivered },
        pendingBatches: Object.fromEntries(Object.entries(sourceEndgame.constructionActivity.pendingBatches).map(([itemId, batch]) => [
          itemId,
          batch ? { ...batch } : batch,
        ])),
      },
    },
    speedrun: state.speedrun ? {
      ...state.speedrun,
      baseline: {
        ...state.speedrun.baseline,
        completedTechIds: [...state.speedrun.baseline.completedTechIds],
      },
      milestones: Object.fromEntries(Object.entries(state.speedrun.milestones).map(([targetId, milestone]) => [
        targetId,
        milestone ? { ...milestone } : { completed: false },
      ])) as NonNullable<GameState["speedrun"]>["milestones"],
    } : undefined,
    campaign: {
      ...state.campaign,
      completedTaskIds: [...state.campaign.completedTaskIds],
      rewardedTaskIds: [...state.campaign.rewardedTaskIds],
    },
  };
}

function createEmptyDysonPlans(): GameState["dysonPlans"] {
  const createPlan = (systemId: StarSystemId): DysonSpherePlanState => ({
    systemId,
    activeLayerId: null,
    structurePoints: 0,
    shellSails: 0,
    layers: [],
  });
  return Object.fromEntries(STAR_SYSTEM_LIST.map((system) => [system.id, createPlan(system.id)])) as GameState["dysonPlans"];
}

function createDefaultDysonOrbit(systemId: StarSystemId, index = 0): DysonSwarmOrbitState {
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

function createEmptyDysonEngineering(): DysonEngineeringState {
  const systems = STAR_SYSTEM_LIST.map((system) => system.id);
  return {
    launchMode: "balanced",
    launchThrottle: 1,
    launchEnabled: true,
    activeOrbitBySystem: Object.fromEntries(systems.map((systemId) => [systemId, `dyson_orbit_${systemId}_1`])) as Record<StarSystemId, string | null>,
    orbitsBySystem: Object.fromEntries(systems.map((systemId) => [systemId, [createDefaultDysonOrbit(systemId)]])) as Record<StarSystemId, DysonSwarmOrbitState[]>,
    absorptionProgressBySystem: Object.fromEntries(systems.map((systemId) => [systemId, 0])) as Record<StarSystemId, number>,
    launchEnergySpentMj: 0,
  };
}

function emptyMetrics(): GameState["metrics"] {
  return {
    generationKw: 0,
    demandKw: 0,
    powerFactor: 1,
    windGenerationKw: 0,
    solarGenerationKw: 0,
    geothermalGenerationKw: 0,
    thermalGenerationKw: 0,
    fusionGenerationKw: 0,
    artificialStarGenerationKw: 0,
    rayGenerationKw: 0,
    storageDischargeKw: 0,
    storageChargeKw: 0,
    storedEnergyMj: 0,
    storageCapacityMj: 0,
    fuelReserveSeconds: 0,
    totalItemsPerMinute: 0,
  };
}

function emptyPowerGridMetrics(gridId: PowerGridId): PowerGridMetrics {
  return {
    ...emptyMetrics(),
    gridId,
    connectedEntities: 0,
    disconnectedEntities: 0,
    generatorCount: 0,
    coverageRadius: POWER_SUPPLY_RADIUS,
  };
}

function createEmptyPowerGridMetrics(): GameState["powerGridMetrics"] {
  return Object.fromEntries(PLANET_LIST.map((planet) => [
    planet.id,
    Object.fromEntries(POWER_GRID_IDS.map((gridId) => [gridId, emptyPowerGridMetrics(gridId)])),
  ])) as GameState["powerGridMetrics"];
}

function makeVein(id: string, planetId: PlanetId, resourceId: ItemId, x: number, y: number): FactoryEntity {
  return {
    id,
    kind: "vein",
    planetId,
    position: { x, y },
    interactionLocked: false,
    resourceId,
    powerGridId: "grid-a",
    powerPriority: 2,
    machineCount: 0,
    minerCount: 0,
    inputs: {},
    outputs: { [resourceId]: 0 },
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
    ...(ITEMS[resourceId].kind === "solid" ? { resourceDepletionRemainder: 0 } : {}),
  };
}

export function createInitialState(seed = DEFAULT_GALAXY_SEED, preserveBaseline = seed === DEFAULT_GALAXY_SEED): GameState {
  const galaxy = createGalaxyState(seed, preserveBaseline);
  const planetMetrics = Object.fromEntries(PLANET_LIST.map((planet) => [planet.id, emptyMetrics()])) as GameState["planetMetrics"];
  const legacyVeins = [
    makeVein("vein_iron", "home", "iron_ore", -470, -250),
    makeVein("vein_copper", "home", "copper_ore", -470, 35),
    makeVein("vein_stone", "home", "stone", -470, 320),
    makeVein("vein_water", "home", "water", -150, -250),
    makeVein("vein_oil", "home", "crude_oil", -150, 35),
    makeVein("vein_coal", "home", "coal", -150, 320),
    makeVein("ashen_iron", "ashen", "iron_ore", -470, -250),
    makeVein("ashen_copper", "ashen", "copper_ore", -470, 35),
    makeVein("ashen_stone", "ashen", "stone", -470, 320),
    makeVein("vein_silicon", "ashen", "silicon_ore", -150, -250),
    makeVein("vein_titanium", "ashen", "titanium_ore", -150, 35),
    makeVein("ashen_coal", "ashen", "coal", -150, 320),
    makeVein("ashen_sulfuric", "ashen", "sulfuric_acid", 170, -250),
    makeVein("ashen_kimberlite", "ashen", "kimberlite_ore", 490, -250),
    makeVein("ashen_fractal_silicon", "ashen", "fractal_silicon", 490, 35),
    makeVein("ashen_organic_crystal", "ashen", "organic_crystal", 490, 320),
    makeVein("frost_iron", "frost", "iron_ore", -470, -250),
    makeVein("frost_copper", "frost", "copper_ore", -470, 35),
    makeVein("frost_titanium", "frost", "titanium_ore", -470, 320),
    makeVein("frost_silicon", "frost", "silicon_ore", -150, -250),
    makeVein("frost_fire_ice", "frost", "fire_ice", -150, 35),
    makeVein("vein_optical_grating", "frost", "optical_grating_crystal", -150, 320),
    makeVein("ashen_spiniform", "frost", "spiniform_stalagmite_crystal", 170, -250),
    makeVein("magnetar_iron", "magnetar", "iron_ore", -470, -250),
    makeVein("magnetar_copper", "magnetar", "copper_ore", -470, 35),
    makeVein("magnetar_titanium", "magnetar", "titanium_ore", -150, -250),
    makeVein("magnetar_silicon", "magnetar", "silicon_ore", -150, 35),
    makeVein("ashen_unipolar", "magnetar", "unipolar_magnet", 170, -250),
  ];
  const legacyPlanetIds = new Set<PlanetId>(["home", "ashen", "giant", "frost", "boreal_giant", "magnetar"]);
  const generatedVeins = PLANET_LIST.flatMap((planet) => {
    if (legacyPlanetIds.has(planet.id) || planet.kind === "gas-giant") return [];
    return galaxy.profiles[planet.id].resourceIds.map((resourceId, index) => makeVein(
      `vein_${planet.id}_${resourceId}`,
      planet.id,
      resourceId,
      -470 + (index % 4) * 320,
      -250 + Math.floor(index / 4) * 285,
    ));
  });
  const entities = [...legacyVeins, ...generatedVeins].map((entity) => {
    if (!entity.resourceId || isInfiniteResource(entity.resourceId, entity.planetId, "finite", galaxy)) return entity;
    const reserve = createVeinReserve(galaxy, entity.planetId, entity.resourceId, entity.id);
    return { ...entity, resourceRemaining: reserve, resourceCapacity: reserve };
  });
  return {
    version: 46,
    mode: "normal",
    nextId: 1,
    activePlanetId: "home",
    entities,
    belts: [],
    cargo: null,
    tray: { iron_ore: 100, copper_ore: 100, stone: 100 },
    planetTrays: Object.fromEntries(PLANET_LIST.map((planet) => [
      planet.id,
      planet.id === "home" ? { iron_ore: 100, copper_ore: 100, stone: 100 } : {},
    ])) as GameState["planetTrays"],
    planetTrayItemLimits: Object.fromEntries(PLANET_LIST.map((planet) => [
      planet.id,
      DEFAULT_PLANET_TRAY_ITEM_LIMIT,
    ])) as GameState["planetTrayItemLimits"],
    construction: {
      ...Object.fromEntries(CONSTRUCTION.map((definition) => [definition.buildingId, 0])),
      wind_turbine: 3,
      solar_panel: 0,
      geothermal_power_station: 0,
      thermal_power_plant: 0,
      mini_fusion_power_plant: 0,
      artificial_star: 0,
      accumulator: 0,
      energy_exchanger: 0,
      mining_machine: 2,
      arc_smelter: 3,
      plane_smelter: 0,
      assembling_machine_mk1: 3,
      assembling_machine_mk2: 0,
      assembling_machine_mk3: 0,
      spray_coater: 0,
      matrix_lab: 2,
      conveyor_belt_mk1: 10,
      conveyor_belt_mk2: 0,
      conveyor_belt_mk3: 0,
      sorter_mk1: 0,
      sorter_mk2: 0,
      sorter_mk3: 0,
      oil_extractor: 0,
      oil_refinery: 0,
      water_pump: 0,
      chemical_plant: 0,
      quantum_chemical_plant: 0,
      fractionator: 0,
      miniature_particle_collider: 0,
      em_rail_ejector: 0,
      ray_receiver: 0,
      vertical_launching_silo: 0,
      planetary_logistics_station: 0,
      interstellar_logistics_station: 0,
      orbital_collector: 0,
      storage_mk1: 0,
      material_delivery_hub: 0,
      storage_tank: 0,
      splitter_4way: 0,
      construction_center: 0,
      galactic_material_exporter: 0,
      micro_black_hole_connector: 0,
      time_warp_device: 0,
    },
    constructionAutomation: {
      enabled: true,
      targetStock: {},
      cursor: 0,
      totalCrafted: 0,
      lastCraftedId: null,
      destroyedByproducts: {},
      jobs: {},
    },
    portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
    manualMined: 0,
    totalProduced: {},
    research: {
      selectedTechId: null,
      pausedTechId: null,
      queuedTechIds: [],
      progressByTech: {},
      completedTechIds: [],
    },
    exploration: {
      unlockedSystemIds: ["helios"],
      colonizedPlanetIds: ["home"],
      missions: [],
      surveyProgressBySystem: { helios: 1 },
    },
    galaxy,
    recipeFocus: { itemId: null, mode: "two-level", position: { x: 24, y: 72 } },
    settings: {
      simulationSpeed: 1,
      fontScale: 1,
      theme: "dark",
      technologyLayout: "standard",
      performanceMode: false,
      reducedMotion: false,
      soundEnabled: false,
      allowDoubleClickZoom: false,
      beltHeatmapEnabled: false,
      defaultBeltStackSize: 1,
      defaultBeltRouteMode: "auto",
      productionBufferLimit: 1_000_000,
      logisticsBufferLimit: 1_000_000,
      beltBufferLimit: 100_000_000,
      proliferatorBufferLimit: 600,
      autosaveIntervalSeconds: 30,
      autoShortageNavigation: false,
      resourceMode: "finite",
      difficulty: "standard",
    },
    contentPacks: [],
    achievements: { unlockedIds: [] },
    campaign: {
      activeChapterId: "foundation",
      activeTaskId: "mine_first_ore",
      completedTaskIds: [],
      rewardedTaskIds: [],
    },
    planetViewports: Object.fromEntries(PLANET_LIST.map((planet) => [
      planet.id,
      { x: 510, y: 250, zoom: 0.84 },
    ])) as GameState["planetViewports"],
    canvasBookmarks: [],
    canvasRegions: [],
    blueprints: [],
    blueprintVersions: [],
    constructionQueue: [],
    handcraftQueue: [],
    productionPlans: [],
    productionHistory: [],
    historyRecordedAt: 0,
    elapsedSeconds: 0,
    idleSettlement: createIdleSettlementState(),
    metrics: { ...planetMetrics.home },
    planetMetrics,
    powerGridMetrics: createEmptyPowerGridMetrics(),
    dysonSwarm: {
      sailsInOrbit: 0,
      totalLaunched: 0,
      totalExpired: 0,
      decayProgress: 0,
      generationKw: 0,
      receiverLoadKw: 0,
    },
    dysonSphere: {
      structurePoints: 0,
      totalRocketsLaunched: 0,
      shellSails: 0,
      totalSailsAbsorbed: 0,
      absorptionProgress: 0,
      generationKw: 0,
    },
    dysonEngineering: createEmptyDysonEngineering(),
    dysonPlans: createEmptyDysonPlans(),
    systemSpaceStations: createEmptySystemSpaceStations(),
    galacticHubNetwork: createEmptyGalacticHubNetwork(),
    quantumLogisticsNetwork: createEmptyQuantumLogisticsNetworkState(),
    timeWarp: {
      controllerEntityId: null,
      enabled: false,
      requestedMultiplier: 5,
      effectiveMultiplier: 1,
      pendingSimulationSeconds: 0,
      pendingWallSeconds: 0,
      requiredPowerKw: 0,
      allocatedPowerKw: 0,
    },
    endgame: createEndgameState(),
    paused: false,
  };
}

export function createPlayerInitialState(): GameState {
  return createInitialState(createPlayerGalaxySeed(), false);
}

/** Create a fresh, isolated speedrun factory. Existing saves never call this path. */
export function createSpeedrunInitialState(nowMs = Date.now(), factoryId?: string): GameState {
  const state = createPlayerInitialState();
  state.mode = "speedrun";
  state.speedrun = createSpeedrunState(state, nowMs, factoryId);
  return evaluateSpeedrunMilestones(state);
}

function remainingResearchCosts(state: GameState): Array<{ itemId: ItemId; amount: number }> {
  const technology = getTechnology(state.research.selectedTechId);
  if (technology) {
    const progress = state.research.progressByTech[technology.id] ?? {};
    return technology.costs
      .map((cost) => ({ itemId: cost.itemId, amount: Math.max(0, cost.amount - (progress[cost.itemId] ?? 0)) }))
      .filter((cost) => cost.amount > 0);
  }
  const infiniteId = state.endgame?.activeInfiniteResearchId;
  if (!infiniteId || !isEndgameUnlocked(state)) return [];
  const progress = state.endgame.infiniteResearch[infiniteId] ?? { level: 0, progress: "0" };
  if (isInfiniteResearchComplete(infiniteId, progress.level)) return [];
  const remaining = getInfiniteResearchCostBigInt(infiniteId, progress.level) - BigInt(progress.progress);
  const amount = Number(remaining > BigInt(MAX_BUILDING_BUFFER_LIMIT) ? BigInt(MAX_BUILDING_BUFFER_LIMIT) : remaining);
  return amount > 0 ? [{ itemId: "universe_matrix", amount }] : [];
}

export function hasActiveResearch(state: GameState): boolean {
  return Boolean(state.research.selectedTechId || (state.endgame?.activeInfiniteResearchId && isEndgameUnlocked(state)));
}

export function getRecipeSpeedMultiplier(state: GameState, recipeId: RecipeId | undefined): number {
  const difficulty = getDifficultyDefinition(state.settings?.difficulty);
  if (recipeId !== "matrix_research") return getIndustrialEfficiencyMultiplier(state) * difficulty.productionMultiplier;
  return (1 + (state.research.completedTechIds.includes("research_speed_1") ? 0.25 : 0) +
    (state.research.completedTechIds.includes("research_speed_2") ? 0.25 : 0) +
    (state.research.completedTechIds.includes("research_speed_3") ? 0.25 : 0)) *
    (1 + getInfiniteResearchLevel(state, "matrix_compression") * 0.1) * difficulty.productionMultiplier;
}

export function getMiningSpeedMultiplier(state: GameState): number {
  const difficulty = getDifficultyDefinition(state.settings?.difficulty);
  const base = state.research.completedTechIds.includes("mining_speed_3")
    ? 3
    : state.research.completedTechIds.includes("mining_speed_2")
      ? 2
      : state.research.completedTechIds.includes("mining_speed_1") ? 1.5 : 1;
  return base * getInfiniteResourceCollectionSpeedMultiplier(state) * difficulty.miningMultiplier;
}

export function getInfiniteResourceCollectionSpeedMultiplier(state: GameState): number {
  return 1 + getInfiniteResearchLevel(state, "vein_utilization") * 0.1;
}

export function getVeinConsumptionMultiplier(state: GameState): number {
  return Math.max(0, VEIN_DEPLETION_SCALE - Math.min(10, getInfiniteResearchLevel(state, "vein_utilization"))) /
    VEIN_DEPLETION_SCALE;
}

function getVeinConsumptionTenths(state: GameState, resourceId: ItemId): number {
  if (ITEMS[resourceId].kind !== "solid") return VEIN_DEPLETION_SCALE;
  return Math.max(0, VEIN_DEPLETION_SCALE - Math.min(10, getInfiniteResearchLevel(state, "vein_utilization")));
}

function getVeinDepletionRemainder(entity: FactoryEntity): number {
  return Math.max(0, Math.min(VEIN_DEPLETION_SCALE - 1, Math.floor(entity.resourceDepletionRemainder ?? 0)));
}

function getFiniteVeinOutputAllowance(entity: FactoryEntity, consumptionTenths: number): number {
  if (consumptionTenths <= 0) return Number.POSITIVE_INFINITY;
  const remaining = Math.max(0, Math.floor(entity.resourceRemaining ?? 0));
  const availableTenths = Math.max(0, remaining * VEIN_DEPLETION_SCALE - getVeinDepletionRemainder(entity));
  return Math.floor(availableTenths / consumptionTenths);
}

function consumeFiniteVeinReserve(entity: FactoryEntity, amount: number, consumptionTenths: number): void {
  if (amount < 1 || consumptionTenths <= 0) return;
  const remaining = Math.max(0, Math.floor(entity.resourceRemaining ?? 0));
  const accruedTenths = getVeinDepletionRemainder(entity) + Math.max(0, Math.floor(amount)) * consumptionTenths;
  const depleted = Math.min(remaining, Math.floor(accruedTenths / VEIN_DEPLETION_SCALE));
  entity.resourceRemaining = remaining - depleted;
  entity.resourceDepletionRemainder = accruedTenths - depleted * VEIN_DEPLETION_SCALE;
}

function isVeinInfiniteForState(state: GameState, entity: FactoryEntity): boolean {
  if (!entity.resourceId) return false;
  return isInfiniteResource(entity.resourceId, entity.planetId, state.settings.resourceMode, state.galaxy) ||
    getVeinConsumptionTenths(state, entity.resourceId) === 0;
}

export function getLogisticsSpeedMultiplier(state: GameState): number {
  const difficulty = getDifficultyDefinition(state.settings?.difficulty);
  return (1 + (state.research.completedTechIds.includes("logistics_engine_1") ? 0.5 : 0) +
    (state.research.completedTechIds.includes("logistics_engine_2") ? 0.5 : 0)) *
    (1 + getInfiniteResearchLevel(state, "galactic_logistics") * 0.05) * difficulty.logisticsMultiplier;
}

export function getPlanetaryCargoCapacity(state: GameState): number {
  const multiplier = (1 + (state.research.completedTechIds.includes("logistics_capacity_1") ? 0.5 : 0) +
    (state.research.completedTechIds.includes("logistics_capacity_2") ? 0.5 : 0)) *
    (1 + getInfiniteResearchLevel(state, "galactic_logistics") * 0.05);
  return Math.round(PLANETARY_CARGO_PER_DRONE * multiplier);
}

export function getInterstellarCargoCapacity(state: GameState): number {
  const multiplier = (1 + (state.research.completedTechIds.includes("logistics_capacity_1") ? 0.5 : 0) +
    (state.research.completedTechIds.includes("logistics_capacity_2") ? 0.5 : 0)) *
    (1 + getInfiniteResearchLevel(state, "galactic_logistics") * 0.05);
  return Math.round(INTERSTELLAR_CARGO_PER_VESSEL * multiplier);
}

export function getPlanetaryTripSeconds(state: GameState): number {
  return PLANETARY_TRIP_SECONDS / getLogisticsSpeedMultiplier(state);
}

export function getInterstellarTripSeconds(state: GameState, requiresWarp = false): number {
  return (requiresWarp ? WARP_TRIP_SECONDS : INTERSTELLAR_TRIP_SECONDS) / getLogisticsSpeedMultiplier(state);
}

export interface InterstellarRouteEconomics {
  distanceLy: number;
  orbitSpan: number;
  requiresWarp: boolean;
  durationSeconds: number;
  cargoPerTrip: number;
  throughputPerMinute: number;
  warpersPerTrip: number;
  powerKw: number;
  energyMjPerTrip: number;
  routeAvailable: boolean;
  routeKind: "local" | "direct" | "relay";
  waypointStationIds: string[];
  hopCount: number;
  maxLegDistanceLy: number;
  warpersPerVessel: number;
}

interface InterstellarRouteOptions {
  routePolicy?: InterstellarRoutePolicy;
  warperBudget?: number;
}

interface PlannedInterstellarPath {
  stations: FactoryEntity[];
  distanceLy: number;
  durationSeconds: number;
  maxLegDistanceLy: number;
  score: number;
}

const LONG_WARP_LEG_LY = 12;

function interstellarLegDuration(state: GameState, source: FactoryEntity, target: FactoryEntity): { distanceLy: number; durationSeconds: number } {
  const sourceSystemId = getPlanet(source.planetId).systemId;
  const targetSystemId = getPlanet(target.planetId).systemId;
  const distanceLy = getSystemDistanceLy(state, sourceSystemId, targetSystemId);
  const sourceProfile = getPlanetIndustrialProfile(state, source.planetId);
  const targetProfile = getPlanetIndustrialProfile(state, target.planetId);
  const environmentFactor = (sourceProfile.travelTimeMultiplier + targetProfile.travelTimeMultiplier) / 2;
  const distanceFactor = 0.75 + distanceLy / 24;
  const longLegPenalty = distanceLy > LONG_WARP_LEG_LY ? 1 + (distanceLy - LONG_WARP_LEG_LY) / 14 : 1;
  return {
    distanceLy,
    durationSeconds: getInterstellarTripSeconds(state, true) * environmentFactor * distanceFactor * longLegPenalty,
  };
}

function planInterstellarPath(
  state: GameState,
  source: FactoryEntity,
  target: FactoryEntity,
  routePolicy: InterstellarRoutePolicy,
  warperBudget: number,
): PlannedInterstellarPath | null {
  const sourceSystemId = getPlanet(source.planetId).systemId;
  const targetSystemId = getPlanet(target.planetId).systemId;
  if (sourceSystemId === targetSystemId) return null;
  const maximumHops = Math.max(1, Math.min(4, Math.floor(warperBudget)));
  const hubBySystem = new Map<StarSystemId, FactoryEntity>();
  for (const station of state.entities) {
    if (station.id === source.id || station.id === target.id || station.buildingId !== "interstellar_logistics_station" || !station.stationHubEnabled) continue;
    const systemId = getPlanet(station.planetId).systemId;
    if (systemId === sourceSystemId || systemId === targetSystemId || !isStarSystemUnlocked(state, systemId)) continue;
    const previous = hubBySystem.get(systemId);
    if (!previous || (station.stationHubPriority ?? 1) > (previous.stationHubPriority ?? 1) ||
      ((station.stationHubPriority ?? 1) === (previous.stationHubPriority ?? 1) && station.id.localeCompare(previous.id) < 0)) {
      hubBySystem.set(systemId, station);
    }
  }
  const hubs = [...hubBySystem.values()];
  const candidates: PlannedInterstellarPath[] = [];
  const visit = (stations: FactoryEntity[], remainingHubs: FactoryEntity[]) => {
    const hopsUsed = stations.length - 1;
    if (hopsUsed >= maximumHops) return;
    const current = stations.at(-1)!;
    const directStations = [...stations, target];
    const hasRelay = directStations.length > 2;
    if (routePolicy !== "relay-required" || hasRelay) {
      const legs = directStations.slice(1).map((station, index) => interstellarLegDuration(state, directStations[index], station));
      const durationSeconds = legs.reduce((sum, leg) => sum + leg.durationSeconds, 0);
      const priorityBonus = directStations.slice(1, -1).reduce((sum, station) => sum + (station.stationHubPriority ?? 1) * 0.025, 0);
      candidates.push({
        stations: directStations,
        distanceLy: legs.reduce((sum, leg) => sum + leg.distanceLy, 0),
        durationSeconds,
        maxLegDistanceLy: Math.max(...legs.map((leg) => leg.distanceLy)),
        score: durationSeconds * Math.max(0.85, 1 - priorityBonus),
      });
    }
    if (routePolicy === "direct" || hopsUsed + 1 >= maximumHops) return;
    for (const hub of remainingHubs) {
      const leg = interstellarLegDuration(state, current, hub);
      if (leg.distanceLy > LONG_WARP_LEG_LY * 1.5) continue;
      visit([...stations, hub], remainingHubs.filter((candidate) => candidate.id !== hub.id));
    }
  };
  visit([source], hubs);
  return candidates.sort((left, right) => left.score - right.score || left.stations.length - right.stations.length ||
    left.stations.map((station) => station.id).join(":").localeCompare(right.stations.map((station) => station.id).join(":")))[0] ?? null;
}

function interstellarRouteEconomicsFromPath(
  state: GameState,
  source: FactoryEntity,
  target: FactoryEntity,
  vehicleCount: number,
  options: InterstellarRouteOptions,
  path: PlannedInterstellarPath | null,
  entityById?: ReadonlyMap<string, FactoryEntity>,
): InterstellarRouteEconomics {
  const sourcePlanet = getPlanet(source.planetId);
  const targetPlanet = getPlanet(target.planetId);
  const requiresWarp = sourcePlanet.systemId !== targetPlanet.systemId;
  const warperBudget = Math.max(1, Math.min(4, Math.floor(options.warperBudget ?? 2)));
  const routeAvailable = !requiresWarp || Boolean(path);
  const distanceLy = path?.distanceLy ?? (requiresWarp ? getSystemDistanceLy(state, sourcePlanet.systemId, targetPlanet.systemId) : 0);
  const orbitSpan = Math.max(1, Math.abs(sourcePlanet.orbitIndex - targetPlanet.orbitIndex));
  const sourceProfile = getPlanetIndustrialProfile(state, source.planetId);
  const targetProfile = getPlanetIndustrialProfile(state, target.planetId);
  const environmentFactor = (sourceProfile.travelTimeMultiplier + targetProfile.travelTimeMultiplier) / 2;
  const durationSeconds = round(requiresWarp
    ? path?.durationSeconds ?? getInterstellarTripSeconds(state, true) * environmentFactor * 4
    : getInterstellarTripSeconds(state, false) * environmentFactor * (0.9 + orbitSpan * 0.1), 2);
  const vessels = Math.max(1, Math.floor(vehicleCount));
  const cargoPerTrip = getInterstellarCargoCapacity(state) * vessels;
  const sourcePower = source.buildingId ? (getBuilding(source.buildingId).powerDemandKw ?? 0) * Math.max(1, source.machineCount) : 0;
  const targetPower = target.buildingId ? (getBuilding(target.buildingId).powerDemandKw ?? 0) * Math.max(1, target.machineCount) : 0;
  const waypointStationIds = path?.stations.slice(1, -1).map((station) => station.id) ?? [];
  const hubPower = waypointStationIds.reduce((sum, stationId) => {
    const station = entityById?.get(stationId) ?? state.entities.find((entity) => entity.id === stationId);
    return sum + (station?.buildingId ? (getBuilding(station.buildingId).powerDemandKw ?? 0) * Math.max(1, station.machineCount) : 0);
  }, 0);
  const hopCount = requiresWarp ? Math.max(1, path ? path.stations.length - 1 : warperBudget) : 0;
  const drivePower = (requiresWarp ? 900 * hopCount : 240) * vessels;
  const powerKw = round(sourcePower + targetPower + hubPower + drivePower, 2);
  return {
    distanceLy: round(distanceLy, 2),
    orbitSpan,
    requiresWarp,
    durationSeconds,
    cargoPerTrip,
    throughputPerMinute: round(cargoPerTrip * 60 / Math.max(1, durationSeconds), 2),
    warpersPerTrip: requiresWarp ? vessels * hopCount : 0,
    powerKw,
    energyMjPerTrip: round(powerKw * durationSeconds / 1_000, 2),
    routeAvailable,
    routeKind: !requiresWarp ? "local" : waypointStationIds.length > 0 ? "relay" : "direct",
    waypointStationIds,
    hopCount,
    maxLegDistanceLy: round(path?.maxLegDistanceLy ?? distanceLy, 2),
    warpersPerVessel: requiresWarp ? hopCount : 0,
  };
}

export function getInterstellarRouteEconomics(
  state: GameState,
  source: FactoryEntity,
  target: FactoryEntity,
  vehicleCount = 1,
  options: InterstellarRouteOptions = {},
): InterstellarRouteEconomics {
  const sourceSystemId = getPlanet(source.planetId).systemId;
  const targetSystemId = getPlanet(target.planetId).systemId;
  const routePolicy = options.routePolicy ?? "relay-preferred";
  const warperBudget = Math.max(1, Math.min(4, Math.floor(options.warperBudget ?? 2)));
  const path = sourceSystemId === targetSystemId
    ? null
    : planInterstellarPath(state, source, target, routePolicy, warperBudget);
  return interstellarRouteEconomicsFromPath(state, source, target, vehicleCount, options, path);
}

function getCachedInterstellarPath(
  state: GameState,
  source: FactoryEntity,
  target: FactoryEntity,
  options: InterstellarRouteOptions,
  lookup: SimulationLookupContext,
  profiler?: SimulationProfiler,
): PlannedInterstellarPath | null {
  if (getPlanet(source.planetId).systemId === getPlanet(target.planetId).systemId) return null;
  const key = interstellarPathCacheKey(source, target, options, lookup.routeEnvironmentKey);
  if (lookup.interstellarPaths.has(key)) {
    if (profiler) profiler.routePathCacheHits += 1;
    return lookup.interstellarPaths.get(key) ?? null;
  }
  const path = planInterstellarPath(
    state,
    source,
    target,
    options.routePolicy ?? "relay-preferred",
    Math.max(1, Math.min(4, Math.floor(options.warperBudget ?? 2))),
  );
  lookup.interstellarPaths.set(key, path);
  if (profiler) profiler.routePathPlans += 1;
  return path;
}

function getCachedInterstellarRouteEconomics(
  state: GameState,
  source: FactoryEntity,
  target: FactoryEntity,
  vehicleCount: number,
  options: InterstellarRouteOptions,
  lookup?: SimulationLookupContext,
  profiler?: SimulationProfiler,
): InterstellarRouteEconomics {
  const key = lookup ? [
    source.id,
    target.id,
    Math.max(1, Math.floor(vehicleCount)),
    options.routePolicy ?? "relay-preferred",
    Math.max(1, Math.min(4, Math.floor(options.warperBudget ?? 2))),
    lookup.routeEnvironmentKey,
  ].join("|") : "";
  const cached = key ? lookup!.routeEconomics.get(key) : undefined;
  if (cached) {
    if (profiler) profiler.routeEconomicsCacheHits += 1;
    return cached;
  }
  const startedAt = profileNow();
  const result = lookup
    ? interstellarRouteEconomicsFromPath(
      state,
      source,
      target,
      vehicleCount,
      options,
      getCachedInterstellarPath(state, source, target, options, lookup, profiler),
      lookup.entityById,
    )
    : getInterstellarRouteEconomics(state, source, target, vehicleCount, options);
  if (profiler) {
    profiler.routeEconomicsCalls += 1;
    profiler.routeEconomicsMs += profileNow() - startedAt;
  }
  if (key) lookup!.routeEconomics.set(key, result);
  return result;
}

export function getSolarSailLifetimeSeconds(state: GameState): number {
  const multiplier = 1 + (state.research.completedTechIds.includes("solar_sail_life_1") ? 0.5 : 0) +
    (state.research.completedTechIds.includes("solar_sail_life_2") ? 0.5 : 0);
  return SOLAR_SAIL_LIFETIME_SECONDS * multiplier;
}

export function getRayReceiverCapacityKw(state: GameState): number {
  const multiplier = (1 + (state.research.completedTechIds.includes("ray_transmission_1") ? 0.5 : 0) +
    (state.research.completedTechIds.includes("ray_transmission_2") ? 0.5 : 0)) *
    (1 + getInfiniteResearchLevel(state, "stellar_harnessing") * 0.05);
  return RAY_RECEIVER_CAPACITY_KW * multiplier;
}

export function getDysonSailAbsorptionMultiplier(state: GameState): number {
  return (state.research.completedTechIds.includes("dyson_absorption_1") ? 2 : 1) *
    (1 + getInfiniteResearchLevel(state, "stellar_harnessing") * 0.05);
}

export function getIndustrialEfficiencyMultiplier(state: GameState): number {
  return 1 + getInfiniteResearchLevel(state, "matrix_compression") * 0.04;
}

export function getDysonPowerMultiplier(state: Pick<GameState, "endgame">): number {
  return 1 + getInfiniteResearchLevel(state, "stellar_harnessing") * 0.05;
}

function getSolarSailPowerFor(state: GameState, systemId: StarSystemId): number {
  return SOLAR_SAIL_POWER_KW * getDysonPowerMultiplier(state) * getStarLuminosity(state, systemId);
}

function proliferatorApplies(entity: FactoryEntity, recipe: RecipeDefinition | undefined): boolean {
  if (!entity.sprayCoaterInstalled || !entity.proliferatorTier || !entity.proliferatorMode ||
    entity.proliferatorMode === "normal" || !recipe) return false;
  if (recipe.id === "matrix_research") return entity.proliferatorMode === "speed";
  return recipe.inputs.length > 0 && recipe.outputs.length > 0;
}

export function isProliferatorEligible(entity: FactoryEntity): boolean {
  const recipe = getRecipe(entity.recipeId);
  return entity.kind === "machine" && entity.buildingId !== "spray_coater" &&
    Boolean(recipe && (recipe.id === "matrix_research" || (recipe.inputs.length > 0 && recipe.outputs.length > 0)));
}

export function getEntityProliferatorItemId(entity: FactoryEntity): ItemId | undefined {
  return entity.proliferatorTier ? getProliferator(entity.proliferatorTier).itemId : undefined;
}

export function getEntityProliferatorSpeedMultiplier(entity: FactoryEntity): number {
  const recipe = getRecipe(entity.recipeId);
  return recipe ? getEntityProliferatorSpeedMultiplierForRecipe(entity, recipe) : 1;
}

function getEntityProliferatorSpeedMultiplierForRecipe(entity: FactoryEntity, recipe: RecipeDefinition): number {
  if (!proliferatorApplies(entity, recipe) || entity.proliferatorMode !== "speed") return 1;
  return 1 + getProliferator(entity.proliferatorTier!).speedBonus;
}

export function getEntityProliferatorPowerMultiplier(entity: FactoryEntity): number {
  const recipe = getRecipe(entity.recipeId);
  return recipe ? getEntityProliferatorPowerMultiplierForRecipe(entity, recipe) : 1;
}

function getEntityProliferatorPowerMultiplierForRecipe(entity: FactoryEntity, recipe: RecipeDefinition): number {
  return proliferatorApplies(entity, recipe) ? getProliferator(entity.proliferatorTier!).powerMultiplier : 1;
}

function getEntityProliferatorPowerMultiplierForStep(
  state: GameState,
  entity: FactoryEntity,
  seconds: number,
  runtime?: IndexedMachineRuntime,
  preparedRecipeSpeedMultiplier?: number,
): number {
  const recipe = runtime?.recipe ?? getRecipe(entity.recipeId);
  if (!recipe || !entity.buildingId || !proliferatorApplies(entity, recipe)) return 1;
  const sprayedCycles = availableFullProliferatorCycles(entity, recipe, runtime?.sprayCost);
  if (sprayedCycles < 1) return 1;
  const baseCyclesPerSecond = runtime
    ? runtime.baseSpeedProduct * (preparedRecipeSpeedMultiplier ?? getRecipeSpeedMultiplier(state, recipe.id)) * runtime.planetSpeed / runtime.recipeDuration
    : (() => {
        const building = getBuilding(entity.buildingId!);
        const profile = getPlanetIndustrialProfile(state, entity.planetId);
        const planetSpeed = specializationApplies(profile, building.family, entity.buildingId!) ? profile.productionSpeedMultiplier : 1;
        return building.speed * entity.machineCount * getRecipeSpeedMultiplier(state, recipe.id) * planetSpeed / recipe.duration;
      })();
  if (baseCyclesPerSecond <= EPSILON || seconds <= EPSILON) return 1;
  const speedMultiplier = entity.proliferatorMode === "speed" ? getEntityProliferatorSpeedMultiplierForRecipe(entity, recipe) : 1;
  const acceleratedWork = Math.max(0, sprayedCycles - (entity.progress ?? 0));
  const sprayedSeconds = acceleratedWork / Math.max(EPSILON, baseCyclesPerSecond * speedMultiplier);
  const sprayedFraction = Math.min(1, sprayedSeconds / seconds);
  return 1 + (getEntityProliferatorPowerMultiplierForRecipe(entity, recipe) - 1) * sprayedFraction;
}

export function getEntityExtraProductBonus(entity: FactoryEntity): number {
  const recipe = getRecipe(entity.recipeId);
  return recipe ? getEntityExtraProductBonusForRecipe(entity, recipe) : 0;
}

function getEntityExtraProductBonusForRecipe(entity: FactoryEntity, recipe: RecipeDefinition): number {
  if (!proliferatorApplies(entity, recipe) || entity.proliferatorMode !== "extra") return 0;
  return getProliferator(entity.proliferatorTier!).extraProductBonus;
}

export function getProliferatorSprayCost(recipe: RecipeDefinition | undefined): number {
  return recipe ? Math.max(1, recipe.inputs.reduce((sum, input) => sum + input.amount, 0)) : 1;
}

function availableProliferatorPoints(entity: FactoryEntity): number {
  const definition = entity.proliferatorTier ? getProliferator(entity.proliferatorTier) : undefined;
  if (!definition) return 0;
  return Math.max(0, entity.proliferatorPoints ?? 0) +
    Math.floor((entity.inputs[definition.itemId] ?? 0) + EPSILON) * definition.sprayPoints;
}

function availableProliferatorCycles(entity: FactoryEntity, recipe: RecipeDefinition, sprayCost = getProliferatorSprayCost(recipe)): number {
  if (!proliferatorApplies(entity, recipe)) return Number.POSITIVE_INFINITY;
  return availableProliferatorPoints(entity) / sprayCost;
}

function availableFullProliferatorCycles(entity: FactoryEntity, recipe: RecipeDefinition, sprayCost = getProliferatorSprayCost(recipe)): number {
  if (!proliferatorApplies(entity, recipe)) return 0;
  return Math.max(0, Math.floor(availableProliferatorCycles(entity, recipe, sprayCost) + EPSILON));
}

function availableInputCyclesForRecipe(state: GameState, entity: FactoryEntity, recipe: RecipeDefinition): number {
  if (recipe.id === "matrix_research") {
    return remainingResearchCosts(state).reduce((available, cost) =>
      available + Math.min(cost.amount, Math.floor((entity.inputs[cost.itemId] ?? 0) + EPSILON)), 0);
  }
  return recipe.inputs.reduce((available, input) =>
    Math.min(available, (entity.inputs[input.itemId] ?? 0) / input.amount), Number.POSITIVE_INFINITY);
}

function availableInputCycles(state: GameState, entity: FactoryEntity): number {
  const recipe = getRecipe(entity.recipeId);
  return recipe ? availableInputCyclesForRecipe(state, entity, recipe) : 0;
}

type OutputCapacityCredits = ReadonlyMap<string, number>;

function outputCapacityCreditKey(entityId: string, itemId: ItemId): string {
  return `${entityId}:${itemId}`;
}

function outputCapacityCredit(credits: OutputCapacityCredits | undefined, entity: FactoryEntity, itemId: ItemId, key?: string): number {
  return Math.max(0, Math.floor(credits?.get(key ?? outputCapacityCreditKey(entity.id, itemId)) ?? 0));
}

function availableOutputCycles(
  state: GameState,
  entity: FactoryEntity,
  credits?: OutputCapacityCredits,
  runtime?: IndexedMachineRuntime,
  maximumCycles = Number.POSITIVE_INFINITY,
  preparedProliferator?: { extraProductBonus: number; sprayedCycleLimit: number },
): number {
  const recipe = runtime?.recipe ?? getRecipe(entity.recipeId);
  if (!recipe || !entity.buildingId) return 0;
  const capacity = runtime?.outputCapacity ?? getEntityOutputCapacity(state, entity);
  const extraProductBonus = preparedProliferator?.extraProductBonus ?? getEntityExtraProductBonusForRecipe(entity, recipe);
  const sprayedCycleLimit = preparedProliferator?.sprayedCycleLimit ??
    availableFullProliferatorCycles(entity, recipe, runtime?.sprayCost);
  let available = Number.POSITIVE_INFINITY;
  for (let outputIndex = 0; outputIndex < recipe.outputs.length; outputIndex += 1) {
    const output = recipe.outputs[outputIndex];
    const free = Math.floor(Math.max(0, capacity - (entity.outputs[output.itemId] ?? 0)) + EPSILON) +
      outputCapacityCredit(credits, entity, output.itemId, runtime?.outputCreditKeys[outputIndex]);
    let low = 0;
    let high = Math.min(Math.floor(free / output.amount), Math.max(0, Math.floor(maximumCycles)));
    const bonusProgress = entity.proliferatorBonusProgress?.[output.itemId] ?? 0;
    if (extraProductBonus <= EPSILON || sprayedCycleLimit < 1) {
      const staticBonus = Math.floor(bonusProgress + EPSILON);
      available = Math.min(available, Math.max(0, Math.min(high, Math.floor((free - staticBonus) / output.amount))));
      continue;
    } else if (high > sprayedCycleLimit) {
      const bonusAtLimit = Math.floor(bonusProgress + output.amount * sprayedCycleLimit * extraProductBonus + EPSILON);
      const beyondSpray = Math.max(0, Math.min(high, Math.floor((free - bonusAtLimit) / output.amount)));
      if (beyondSpray >= sprayedCycleLimit) {
        available = Math.min(available, beyondSpray);
        continue;
      }
      high = Math.min(high, sprayedCycleLimit);
    }
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      const sprayedCycles = Math.min(candidate, sprayedCycleLimit);
      const bonus = Math.floor(bonusProgress + output.amount * sprayedCycles * extraProductBonus + EPSILON);
      if (output.amount * candidate + bonus <= free) low = candidate;
      else high = candidate - 1;
    }
    available = Math.min(available, low);
  }
  return available;
}

function canMachineRun(state: GameState, entity: FactoryEntity, runtime?: IndexedMachineRuntime): boolean {
  if (entity.recipeId === "matrix_research" && !hasActiveResearch(state)) return false;
  if (entity.recipeId === "solar_sail_launch" && !getEjectorOrbitTargetStatus(state, entity).valid) return false;
  const recipe = runtime?.recipe ?? getRecipe(entity.recipeId);
  if (recipe?.requiredTechId && !isTechnologyCompleted(state, recipe.requiredTechId)) return false;
  if (proliferatorApplies(entity, recipe)) {
    const definition = getProliferator(entity.proliferatorTier!);
    if (!isTechnologyCompleted(state, definition.requiredTechId)) return false;
  }
  return entity.kind === "machine" && Boolean(recipe) &&
    Math.floor(recipe ? availableInputCyclesForRecipe(state, entity, recipe) + EPSILON : 0) >= 1 &&
    Math.floor(availableOutputCycles(state, entity, undefined, runtime, 1) + EPSILON) >= 1;
}

function extractorFor(entity: FactoryEntity) {
  const buildingId = entity.extractorBuildingId ?? getExtractorBuildingId(entity.resourceId!);
  return getBuilding(buildingId);
}

export function getPlanetMetrics(state: GameState, planetId: PlanetId): GameState["metrics"] {
  return state.planetMetrics[planetId] ?? emptyMetrics();
}

export function getPowerGridMetrics(state: GameState, planetId: PlanetId, gridId: PowerGridId): PowerGridMetrics {
  return state.powerGridMetrics?.[planetId]?.[gridId] ?? emptyPowerGridMetrics(gridId);
}

export function getEntityPowerFactor(state: GameState, entity: FactoryEntity, lookup?: SimulationLookupContext): number {
  // Orbital collectors are self-powered infrastructure. Treating their gas
  // giant grid (which intentionally has no generators) as a route endpoint
  // made otherwise healthy interstellar routes alternate between no-power
  // and all-vessels-busy diagnostics.
  if (entity.buildingId === "orbital_collector") return 1;
  if (!isEntityInPowerCoverage(state, entity, lookup)) return 0;
  if (typeof entity.powerFactor === "number" && Number.isFinite(entity.powerFactor)) {
    return Math.max(0, Math.min(1, entity.powerFactor));
  }
  return getPowerGridMetrics(state, entity.planetId, getEntityPowerGridId(entity)).powerFactor;
}

function emptyStationSlot(): StationSlot {
  return {
    localMode: "storage",
    remoteMode: "storage",
    minimumLoad: 1,
    minStock: 0,
    maxStock: 0,
    priority: 1,
    routePolicy: "relay-preferred",
    warperBudget: 2,
  };
}

function stationSlotsForPlacement(
  buildingId: BuildingId,
  itemId?: ItemId,
  mode: "supply" | "demand" = "supply",
  minimumLoad: StationMinimumLoad = 1,
): StationSlot[] {
  const slots = Array.from({ length: STATION_SLOT_COUNT }, emptyStationSlot);
  if (itemId && buildingId !== "orbital_collector") {
    slots[0] = {
      itemId,
      localMode: buildingId === "planetary_logistics_station" ? mode : "storage",
      remoteMode: buildingId === "interstellar_logistics_station" ? mode : "storage",
      minimumLoad,
      minStock: 0,
      maxStock: 0,
      priority: 1,
      routePolicy: "relay-preferred",
      warperBudget: 2,
    };
  }
  return slots;
}

function normalizeStationSlot(slot: Partial<StationSlot> | undefined): StationSlot {
  const logisticsMode = (value: unknown): StationLogisticsMode =>
    value === "supply" || value === "demand" || value === "storage" ? value : "storage";
  return {
    itemId: slot?.itemId && ITEMS[slot.itemId] ? slot.itemId : undefined,
    localMode: logisticsMode(slot?.localMode),
    remoteMode: logisticsMode(slot?.remoteMode),
    minimumLoad: STATION_MINIMUM_LOAD_OPTIONS.includes(slot?.minimumLoad as StationMinimumLoad)
      ? slot!.minimumLoad as StationMinimumLoad
      : 1,
    minStock: Math.max(0, Math.floor(slot?.minStock ?? 0)),
    maxStock: Math.max(0, Math.floor(slot?.maxStock ?? 0)),
    priority: slot?.priority === 0 || slot?.priority === 2 ? slot.priority : 1,
    routePolicy: slot?.routePolicy === "direct" || slot?.routePolicy === "relay-required" ? slot.routePolicy : "relay-preferred",
    warperBudget: Math.max(1, Math.min(4, Math.floor(slot?.warperBudget ?? 2))),
  };
}

export function getStationSlots(station: FactoryEntity): StationSlot[] {
  if (station.buildingId === "orbital_collector") return [];
  const legacyMode: StationLogisticsMode = station.stationMode === "demand" ? "demand" : "supply";
  const slots = station.stationSlots?.map(normalizeStationSlot) ?? [];
  if (slots.length === 0 && station.storedItemId) {
    slots.push({
      itemId: station.storedItemId,
      localMode: station.buildingId === "planetary_logistics_station" ? legacyMode : "storage",
      remoteMode: station.buildingId === "interstellar_logistics_station" ? legacyMode : "storage",
      minimumLoad: getStationMinimumLoad(station),
      minStock: 0,
      maxStock: 0,
      priority: 1,
      routePolicy: "relay-preferred" as InterstellarRoutePolicy,
      warperBudget: 2,
    });
  }
  while (slots.length < STATION_SLOT_COUNT) slots.push(emptyStationSlot());
  return slots.slice(0, STATION_SLOT_COUNT);
}

function ensureStationSlots(station: FactoryEntity): StationSlot[] {
  station.stationSlots = getStationSlots(station);
  const primary = station.stationSlots.find((slot) => slot.itemId);
  station.storedItemId = primary?.itemId;
  if (primary) {
    const mode = station.buildingId === "planetary_logistics_station" ? primary.localMode : primary.remoteMode;
    station.stationMode = mode === "demand" ? "demand" : "supply";
    station.stationMinimumLoad = primary.minimumLoad;
  }
  station.stationRoutes ??= [];
  return station.stationSlots;
}

export const MIN_BUILDING_BUFFER_LIMIT = 1_000;
export const DEFAULT_BUILDING_BUFFER_LIMIT = 1_000_000;
export const MAX_BUILDING_BUFFER_LIMIT = 100_000_000;
/** Shared upper bound for persisted entity and blueprint building stacks. */
export const MAX_BUILDING_STACK_COUNT = 100_000_000;
export const MIN_PROLIFERATOR_BUFFER_LIMIT = 1;
export const DEFAULT_PROLIFERATOR_BUFFER_LIMIT = 600;
export const MAX_PROLIFERATOR_BUFFER_LIMIT = 100_000;
/** Maximum target inventory for the construction center after capacity II. */
export const MAX_CONSTRUCTION_AUTOMATION_TARGET = 100_000_000;

export type BuildingStackAdditionCheck =
  | { ok: true; amount: number; total: number }
  | { ok: false; amount: number; total: number; code: "invalid-count" | "unsafe-total" | "stack-limit"; label: string };

/**
 * New construction is capped even when a grandfathered save already exceeds
 * the current limit. Historical stacks may be reduced, but never extended.
 */
export function getBuildingStackAdditionCheck(
  currentCount: number,
  requestedCount: number,
  subject = "建筑堆叠",
): BuildingStackAdditionCheck {
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) {
    return { ok: false, amount: 0, total: currentCount, code: "invalid-count", label: `${subject}新增数量必须是正安全整数` };
  }
  const amount = requestedCount;
  if (!Number.isSafeInteger(currentCount) || currentCount < 0 || !Number.isSafeInteger(currentCount + amount)) {
    return { ok: false, amount, total: currentCount, code: "unsafe-total", label: `${subject}数量超出安全整数范围，请先导出备份并联系存档救援` };
  }
  const total = currentCount + amount;
  if (total > MAX_BUILDING_STACK_COUNT) {
    return {
      ok: false,
      amount,
      total,
      code: "stack-limit",
      label: `${subject}最多为 ${MAX_BUILDING_STACK_COUNT.toLocaleString("zh-CN")}；历史超限堆叠可以保留和回收，但不能继续增加`,
    };
  }
  return { ok: true, amount, total };
}

export function normalizeBuildingBufferLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BUILDING_BUFFER_LIMIT;
  return Math.max(MIN_BUILDING_BUFFER_LIMIT, Math.min(MAX_BUILDING_BUFFER_LIMIT, Math.floor(value)));
}

export function normalizeProliferatorBufferLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PROLIFERATOR_BUFFER_LIMIT;
  return Math.max(MIN_PROLIFERATOR_BUFFER_LIMIT, Math.min(MAX_PROLIFERATOR_BUFFER_LIMIT, Math.floor(value)));
}

export function getEntityBufferLimit(state: GameState, entity: FactoryEntity): number {
  const logistics = entity.kind === "storage" || entity.kind === "splitter" || entity.kind === "station";
  return normalizeBuildingBufferLimit(logistics ? state.settings.logisticsBufferLimit : state.settings.productionBufferLimit);
}

function stackedEntityCapacity(baseCapacity: number, machineCount: number, limit: number): number {
  const base = Math.max(0, Math.floor(Number.isFinite(baseCapacity) ? baseCapacity : 0));
  const count = Math.max(1, Math.floor(Number.isFinite(machineCount) ? machineCount : 1));
  if (base === 0) return 0;
  return base > limit / count ? limit : Math.min(limit, base * count);
}

function getManualMiningOutputCapacity(state: GameState, entity: FactoryEntity): number {
  const rated = stackedEntityCapacity(
    extractorFor(entity).outputCapacity,
    Math.max(1, entity.minerCount),
    getEntityBufferLimit(state, entity),
  );
  return Math.min(getEntityBufferLimit(state, entity), Math.max(60, rated));
}

function getEntityCapacityDefinition(entity: FactoryEntity): { inputCapacity: number; outputCapacity: number; count: number } | null {
  if (entity.buildingId) {
    const building = getBuilding(entity.buildingId);
    return { inputCapacity: building.inputCapacity, outputCapacity: building.outputCapacity, count: entity.machineCount };
  }
  if (entity.kind === "vein" && entity.resourceId && entity.minerCount > 0) {
    const extractor = extractorFor(entity);
    return { inputCapacity: 0, outputCapacity: extractor.outputCapacity, count: entity.minerCount };
  }
  return null;
}

export function getEntityInputCapacity(state: GameState, entity: FactoryEntity): number {
  const definition = getEntityCapacityDefinition(entity);
  return definition ? stackedEntityCapacity(definition.inputCapacity, definition.count, getEntityBufferLimit(state, entity)) : 0;
}

export function getEntityOutputCapacity(state: GameState, entity: FactoryEntity): number {
  const definition = getEntityCapacityDefinition(entity);
  return definition ? stackedEntityCapacity(definition.outputCapacity, definition.count, getEntityBufferLimit(state, entity)) : 0;
}

export function getStationSlotCapacity(state: GameState, station: FactoryEntity, slot: StationSlot): number {
  if (!station.buildingId) return 0;
  const rated = getEntityOutputCapacity(state, station);
  return slot.maxStock > 0 ? Math.min(rated, slot.maxStock) : rated;
}

export function getEntityItemInputCapacity(state: GameState, entity: FactoryEntity, itemId: ItemId): number {
  if (entity.kind === "station" && entity.buildingId !== "orbital_collector") {
    const slot = getStationSlots(entity).find((candidate) => candidate.itemId === itemId);
    if (slot) return getStationSlotCapacity(state, entity, slot);
  }
  const rated = getEntityInputCapacity(state, entity);
  if (entity.sprayCoaterInstalled && getEntityProliferatorItemId(entity) === itemId) {
    return Math.min(rated, normalizeProliferatorBufferLimit(state.settings.proliferatorBufferLimit));
  }
  return rated;
}

function stationSlotMode(station: FactoryEntity, slot: StationSlot, scope: StationLogisticsScope): StationLogisticsMode {
  if (station.buildingId === "orbital_collector") return scope === "remote" ? "supply" : "storage";
  return scope === "local" ? slot.localMode : slot.remoteMode;
}

function isQuantumStation(station: FactoryEntity): boolean {
  return station.kind === "station" && station.buildingId === "interstellar_logistics_station" && station.quantumMode === "quantum";
}

function isQuantumCollector(station: FactoryEntity): boolean {
  return station.kind === "station" && station.buildingId === "orbital_collector" && station.quantumMode === "quantum";
}

/**
 * Quantum access replaces interstellar vessel dispatch only. Quantum towers
 * keep their local drone network live before, during, and after handoff.
 */
function isTraditionalStationScopeDisabled(station: FactoryEntity, scope: StationLogisticsScope): boolean {
  if (scope === "local") return station.buildingId === "orbital_collector";
  return isQuantumStation(station) || isQuantumCollector(station) || Boolean(station.quantumTransition);
}

function hasQuantumBoundaryLogistics(station: FactoryEntity): boolean {
  return isQuantumStation(station) || isQuantumCollector(station) || Boolean(station.quantumTransition);
}

function quantumSupplySlot(station: FactoryEntity, itemId: ItemId): StationSlot | undefined {
  if (!isQuantumStation(station)) return undefined;
  return getStationSlots(station).find((slot) => slot.itemId === itemId && slot.remoteMode === "supply");
}

function quantumInventoryFree(state: GameState, itemId: ItemId): number {
  if (!state.quantumLogisticsNetwork?.enabled) return 0;
  const current = BigInt(normalizeQuantumInteger(state.quantumLogisticsNetwork.inventory[itemId]));
  const capacity = BigInt(getQuantumItemCapacity(state.quantumLogisticsNetwork, itemId));
  const free = capacity > current ? capacity - current : 0n;
  return Number(free > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : free);
}

function quantumSupplyFreeCapacity(
  state: GameState,
  station: FactoryEntity,
  itemId: ItemId,
  lookup?: SimulationLookupContext,
): number {
  const slot = quantumSupplySlot(station, itemId);
  if (!slot) return 0;
  const localCapacity = getEntityItemInputCapacity(state, station, itemId);
  const localFree = Math.max(0, Math.floor(localCapacity - (station.inputs[itemId] ?? 0)));
  void lookup;
  return Math.max(0, quantumInventoryFree(state, itemId) + localFree);
}

function recordImmediateQuantumUpload(state: GameState, itemId: ItemId, amount: number): void {
  if (amount < 1) return;
  if (!state.quantumLogisticsNetwork?.enabled) return;
  const boundarySecond = (Math.floor(state.elapsedSeconds / QUANTUM_SETTLEMENT_SECONDS) + 1) * QUANTUM_SETTLEMENT_SECONDS;
  if (state.quantumLogisticsNetwork.runtimeFlow?.boundarySecond !== boundarySecond) {
    state.quantumLogisticsNetwork.runtimeFlow = createQuantumBoundaryFlow(state, boundarySecond);
  }
  const flow = state.quantumLogisticsNetwork.runtimeFlow;
  if (!flow) return;
  addQuantumBoundaryFlow(flow.uploaded, itemId, amount);
}

/**
 * Receive material at a quantum supply tower. The configured minStock remains
 * local; everything else is deposited directly into shared inventory and any
 * capacity remainder falls back to the ordinary tower input buffer.
 */
function receiveQuantumSupplyMaterial(
  state: GameState,
  station: FactoryEntity,
  itemId: ItemId,
  amount: number,
): number {
  const slot = quantumSupplySlot(station, itemId);
  if (!slot || amount < 1 || !state.quantumLogisticsNetwork?.enabled) return 0;
  const requested = Math.max(0, Math.floor(amount));
  const currentInput = Math.max(0, Math.floor(station.inputs[itemId] ?? 0));
  const currentOutput = Math.max(0, Math.floor(station.outputs[itemId] ?? 0));
  const inputCapacity = Math.max(0, Math.floor(getEntityItemInputCapacity(state, station, itemId)));
  const inputFree = Math.max(0, inputCapacity - currentInput);
  const localReserve = Math.max(0, Math.floor(slot.minStock ?? 0) - currentInput - currentOutput);
  const kept = Math.min(requested, inputFree, localReserve);
  if (kept > 0) station.inputs[itemId] = currentInput + kept;
  let remaining = requested - kept;
  if (remaining > 0) {
    const deposited = depositIntoQuantumInventory(state.quantumLogisticsNetwork, itemId, remaining);
    state.quantumLogisticsNetwork = deposited.state;
    const accepted = Number(deposited.accepted);
    if (accepted > 0) recordImmediateQuantumUpload(state, itemId, accepted);
    remaining = Number(deposited.remainder);
  }
  const localRemainder = Math.min(remaining, Math.max(0, inputFree - kept));
  if (localRemainder > 0) station.inputs[itemId] = Math.floor((station.inputs[itemId] ?? 0) + localRemainder);
  return kept + (requested - kept - remaining) + localRemainder;
}

function flushQuantumSupplyBuffer(state: GameState, station: FactoryEntity, itemId: ItemId, lookup?: SimulationLookupContext): number {
  const slot = quantumSupplySlot(station, itemId);
  if (!slot || !state.quantumLogisticsNetwork?.enabled) return 0;
  const input = Math.max(0, Math.floor(station.inputs[itemId] ?? 0));
  const output = Math.max(0, Math.floor(station.outputs[itemId] ?? 0));
  const reserve = Math.max(0, Math.floor(slot.minStock ?? 0));
  const reservedOutgoing = Math.max(0, Math.floor(stationReservedOutgoing(state, station.id, itemId, lookup)));
  const uploadable = Math.max(0, output - reserve - reservedOutgoing) +
    Math.max(0, input - Math.max(0, reserve - output));
  if (uploadable < 1) return 0;
  const deposited = depositIntoQuantumInventory(state.quantumLogisticsNetwork, itemId, uploadable);
  state.quantumLogisticsNetwork = deposited.state;
  const accepted = Number(deposited.accepted);
  if (accepted < 1) return 0;
  let remaining = accepted;
  const fromOutput = Math.min(Math.max(0, output - reserve - reservedOutgoing), remaining);
  if (fromOutput > 0) station.outputs[itemId] = output - fromOutput;
  remaining -= fromOutput;
  if (remaining > 0) station.inputs[itemId] = Math.max(0, input - remaining);
  recordImmediateQuantumUpload(state, itemId, accepted);
  return accepted;
}

export interface StationPeerMatch {
  peer: FactoryEntity;
  peerSlotIndex: number;
}

export interface SimulationProfiler {
  copyStateMs: number;
  productionMs: number;
  beltsMs: number;
  beltScanMs: number;
  beltDistributeMs: number;
  beltReserveMs: number;
  logisticsMs: number;
  quantumMs: number;
  powerMs: number;
  dysonMs: number;
  constructionMs: number;
  historyMs: number;
  stationIndexBuildMs: number;
  peerMatchMs: number;
  routeEconomicsMs: number;
  dispatchMs: number;
  dispatchPeerSortMs: number;
  routeAdvanceMs: number;
  congestionMs: number;
  peerCandidateChecks: number;
  peerMatchCalls: number;
  peerMatchCacheHits: number;
  routeEconomicsCalls: number;
  routeEconomicsCacheHits: number;
  routePathPlans: number;
  routePathCacheHits: number;
  congestionDispatchReuseHits: number;
  routesCreated: number;
  dispatchSlotChecks: number;
  dispatchPeerOrderChecks: number;
  dispatchPeerVisits: number;
  dispatchBlockedCacheHits: number;
  quantumStationCount: number;
  quantumRequestCount: number;
  persistentRuntimeHits: number;
  persistentRuntimeRebuilds: number;
  fuelItemsLoaded: number;
  exchangerCellsSettled: number;
  constructionJobsBatched: number;
  constructionPlanBuilds: number;
  constructionPlanCacheHits: number;
  constructionGuardHits: number;
  constructionIterations: number;
  beltRouteChecks: number;
  beltTargetChecks: number;
  beltStableRoutesSkipped: number;
}

/**
 * Local benchmark hook for proving deterministic simulation contracts. The
 * production runtime never supplies this object; it deliberately stays out of
 * GameState and save data.
 */
export interface SimulationContractExperiment {
  skippedBeltIds?: ReadonlySet<string>;
  skippedProductionEntityIds?: ReadonlySet<string>;
  beforeInputBelts?: (state: GameState) => void;
  afterInputBelts?: (state: GameState) => void;
  beforePlanetProduction?: (state: GameState, planetId: PlanetId) => void;
  afterPlanetProduction?: (state: GameState, planetId: PlanetId) => void;
  beforeOutputBelts?: (state: GameState) => void;
  afterOutputBelts?: (state: GameState) => void;
}

interface IndexedStationSlot {
  peer: FactoryEntity;
  peerSlotIndex: number;
  slot: StationSlot;
}

interface IndexedBeltRoute {
  belt: BeltConnection;
  source?: FactoryEntity;
  target?: FactoryEntity;
  capacity: number;
  compatible: boolean;
  targetCapacityIndex?: number;
  sourceGroupIndex?: number;
  /** Stable locale order inside one source/item group for deterministic batching. */
  stableSourceOrder?: number;
  targetInputCapacity?: number;
  /** Per-call exact-settlement scratch; runtime-only and never serialized. */
  runtimeTargetCapacity?: { free: number };
  runtimeAllowance?: number;
  runtimeCandidate?: BeltTransferCandidate;
  runtimeEpoch?: number;
}

interface IndexedBeltRouteGroup {
  index: number;
  key: string;
  planetId: PlanetId;
  source?: FactoryEntity;
  itemId: ItemId;
  routes: IndexedBeltRoute[];
  potentiallyProduces: boolean;
  runtimeEpoch?: number;
  runtimeGroup?: RuntimeBeltTransferGroup;
}

export interface SimulationBeltPlanetRuntimeIndex {
  beltById: Map<string, BeltConnection>;
  sourceToBelts: Map<string, BeltConnection[]>;
  targetToBelts: Map<string, BeltConnection[]>;
  itemToBelts: Map<ItemId, BeltConnection[]>;
  activeBelts: Set<string>;
  blockedBelts: Set<string>;
  inputStarvedBelts: Set<string>;
  outputFullBelts: Set<string>;
  powerLimitedBelts: Set<string>;
}

export interface SimulationBeltRuntimeIndex {
  byPlanet: Map<PlanetId, SimulationBeltPlanetRuntimeIndex>;
  routeGroups: IndexedBeltRouteGroup[];
  routeGroupByKey: Map<string, IndexedBeltRouteGroup>;
  groupKeyByBeltId: Map<string, string>;
  /** Groups carrying persisted runtime state; rebuilt from belt fields on cache creation. */
  activeGroupKeys: Set<string>;
  /** Enabled only when the rebuilt index proves a meaningful dormant cohort. */
  activeQueueEnabled: boolean;
  initiallyDormantRouteCount: number;
  targetCapacityGroupCount: number;
  /** Per-topology scratch reused by every exact belt phase. */
  settlementEpoch: number;
  sourceAvailabilityLedgers: RuntimeSourceAvailabilityLedger[];
  targetCapacityLedgers: RuntimeTargetCapacityLedger[];
  settlementEntries: Array<IndexedBeltRoute | RuntimeBeltTransferGroup>;
}

interface StationDispatchSlotResult {
  hasMatchingPeer: boolean;
  routesCreated: number;
  cargoDispatched: number;
}

interface IndexedStationDispatchPlan {
  demand: FactoryEntity;
  orderedSlots: Array<{ slot: StationSlot; slotIndex: number }>;
}

interface IndexedMachineRuntime {
  entity: FactoryEntity;
  recipe: RecipeDefinition;
  baseSpeedProduct: number;
  planetSpeed: number;
  recipeDuration: number;
  outputCapacity: number;
  outputCreditKeys: string[];
  powerDemandProduct: number;
  sprayCost: number;
  baseUnitsPerCycle: number;
  launchEnergyPerCycle: number;
  matrixResearch: boolean;
}

interface IndexedLogisticsBufferRuntime {
  entity: FactoryEntity;
  itemId: ItemId;
  capacity: number;
}

interface IndexedQuantumSlotPlan {
  endpoint: FactoryEntity;
  itemId: ItemId;
  key: string;
  priority: number;
  slot: StationSlot;
}

interface BlockedStationDispatchCache {
  values: number[];
  lastPeerId?: string;
  result: StationDispatchSlotResult;
}

export interface SimulationLookupContext {
  entityById: Map<string, FactoryEntity>;
  entitiesByPlanet: Map<PlanetId, FactoryEntity[]>;
  /** Planet/grid partitions avoid scanning every planet entity for each grid. */
  entitiesByPlanetGrid: Map<string, FactoryEntity[]>;
  /** Stable entity-kind views reused by every exact simulation step. */
  machinesByPlanet: Map<PlanetId, FactoryEntity[]>;
  rayReceivers: FactoryEntity[];
  machineRuntimesByPlanet: Map<PlanetId, IndexedMachineRuntime[]>;
  machineRuntimeById: Map<string, IndexedMachineRuntime>;
  veinsByPlanet: Map<PlanetId, FactoryEntity[]>;
  stations: FactoryEntity[];
  orbitalCollectors: FactoryEntity[];
  /** Static quantum endpoints/slot intents, rebuilt only with the topology lookup. */
  quantumStations: FactoryEntity[];
  quantumEndpoints: FactoryEntity[];
  quantumDownloadSlots: IndexedQuantumSlotPlan[];
  quantumUploadSlots: IndexedQuantumSlotPlan[];
  quantumTowerStacks: number;
  quantumCollectorStacks: number;
  logisticsBufferEntities: FactoryEntity[];
  logisticsBufferRuntimes: IndexedLogisticsBufferRuntime[];
  materialDeliveryHubs: FactoryEntity[];
  galacticExporters: FactoryEntity[];
  timeWarpDevices: FactoryEntity[];
  beltsByPlanet: Map<PlanetId, BeltConnection[]>;
  beltById: Map<string, BeltConnection>;
  sortedBelts: BeltConnection[];
  beltRoutes: IndexedBeltRoute[];
  outgoingBeltsBySource: Map<string, BeltConnection[]>;
  incomingBeltsByTarget: Map<string, BeltConnection[]>;
  /** Runtime-only active/blocked belt queues. Never serialized into GameState. */
  beltRuntime: SimulationBeltRuntimeIndex;
  powerSourcesByPlanetGrid: Map<string, FactoryEntity[]>;
  stationSlotsByKey: Map<string, IndexedStationSlot[]>;
  stationPeerMatches: Map<string, StationPeerMatch[]>;
  stationDispatchPlans: Record<StationLogisticsScope, IndexedStationDispatchPlan[]>;
  blockedStationDispatch: Map<string, BlockedStationDispatchCache>;
  dispatchResultsBySlot: Map<string, StationDispatchSlotResult>;
  busyVehicles: Map<string, number>;
  reservedOutgoing: Map<string, number>;
  inFlightCargo: Map<string, number>;
  activeRoutesByStation: Map<string, Array<{ demand: FactoryEntity; route: StationRoute }>>;
  activeRouteVehicleLoadByStation: Map<string, number>;
  routeEconomics: Map<string, InterstellarRouteEconomics>;
  interstellarPaths: Map<string, PlannedInterstellarPath | null>;
  routeEnvironmentKey: string;
  /** Runtime-only dirty bit for the active-route ledger. */
  dynamicRouteLookupDirty: boolean;
  /** Worker/session-owned recursive plans. Never serialised into GameState. */
  constructionAutomationPlanCache: Map<string, CachedConstructionAutomationPlan>;
}

function profileNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function stationSlotIndexKey(scope: StationLogisticsScope, location: PlanetId | "*", itemId: ItemId, mode: StationLogisticsMode): string {
  return `${scope}|${location}|${itemId}|${mode}`;
}

function stationPeerMatchCacheKey(
  state: GameState,
  stationId: string,
  slotIndex: number,
  scope: StationLogisticsScope,
  environmentKey = routeEnvironmentKey(state),
): string {
  return [
    stationId,
    slotIndex,
    scope,
    environmentKey,
  ].join("|");
}

function routeEnvironmentKey(state: GameState): string {
  return [
    getLogisticsSpeedMultiplier(state),
    getInterstellarCargoCapacity(state),
    state.exploration.unlockedSystemIds.join(","),
  ].join("|");
}

function interstellarPathCacheKey(
  source: FactoryEntity,
  target: FactoryEntity,
  options: InterstellarRouteOptions,
  environmentKey: string,
): string {
  return [
    source.planetId,
    target.planetId,
    options.routePolicy ?? "relay-preferred",
    Math.max(1, Math.min(4, Math.floor(options.warperBudget ?? 2))),
    environmentKey,
  ].join("|");
}

function stationDispatchSlotKey(stationId: string, slotIndex: number, scope: StationLogisticsScope): string {
  return `${stationId}|${slotIndex}|${scope}`;
}

export function createSimulationLookupContext(
  state: GameState,
  profiler?: SimulationProfiler,
  constructionAutomationPlanCache = new Map<string, CachedConstructionAutomationPlan>(),
): SimulationLookupContext {
  const startedAt = profileNow();
  const context: SimulationLookupContext = {
    entityById: new Map(state.entities.map((entity) => [entity.id, entity])),
    entitiesByPlanet: new Map(),
    entitiesByPlanetGrid: new Map(),
    machinesByPlanet: new Map(),
    rayReceivers: [],
    machineRuntimesByPlanet: new Map(),
    machineRuntimeById: new Map(),
    veinsByPlanet: new Map(),
    stations: [],
    orbitalCollectors: [],
    quantumStations: [],
    quantumEndpoints: [],
    quantumDownloadSlots: [],
    quantumUploadSlots: [],
    quantumTowerStacks: 0,
    quantumCollectorStacks: 0,
    logisticsBufferEntities: [],
    logisticsBufferRuntimes: [],
    materialDeliveryHubs: [],
    galacticExporters: [],
    timeWarpDevices: [],
    beltsByPlanet: new Map(),
    beltById: new Map(state.belts.map((belt) => [belt.id, belt])),
    // Preserve persisted belt order. It is part of the legacy deterministic
    // tie-breaking for equal-priority sources; caching must not reorder it.
    sortedBelts: [...state.belts],
    beltRoutes: [],
    outgoingBeltsBySource: new Map(),
    incomingBeltsByTarget: new Map(),
    beltRuntime: {
      byPlanet: new Map(),
      routeGroups: [],
      routeGroupByKey: new Map(),
      groupKeyByBeltId: new Map(),
      activeGroupKeys: new Set(),
      activeQueueEnabled: false,
      initiallyDormantRouteCount: 0,
      targetCapacityGroupCount: 0,
      settlementEpoch: 0,
      sourceAvailabilityLedgers: [],
      targetCapacityLedgers: [],
      settlementEntries: [],
    },
    powerSourcesByPlanetGrid: new Map(),
    stationSlotsByKey: new Map(),
    stationPeerMatches: new Map(),
    stationDispatchPlans: { local: [], remote: [] },
    blockedStationDispatch: new Map(),
    dispatchResultsBySlot: new Map(),
    busyVehicles: new Map(),
    reservedOutgoing: new Map(),
    inFlightCargo: new Map(),
    activeRoutesByStation: new Map(),
    activeRouteVehicleLoadByStation: new Map(),
    routeEconomics: new Map(),
    interstellarPaths: new Map(),
    routeEnvironmentKey: routeEnvironmentKey(state),
    dynamicRouteLookupDirty: true,
    constructionAutomationPlanCache,
  };
  const addTo = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const values = map.get(key);
    if (values) values.push(value);
    else map.set(key, [value]);
  };
  for (const entity of state.entities) {
    const planetEntities = context.entitiesByPlanet.get(entity.planetId);
    if (planetEntities) planetEntities.push(entity);
    else context.entitiesByPlanet.set(entity.planetId, [entity]);
    const gridKey = `${entity.planetId}|${getEntityPowerGridId(entity)}`;
    const gridEntities = context.entitiesByPlanetGrid.get(gridKey);
    if (gridEntities) gridEntities.push(entity);
    else context.entitiesByPlanetGrid.set(gridKey, [entity]);
    if (entity.kind === "machine") {
      const machines = context.machinesByPlanet.get(entity.planetId);
      if (machines) machines.push(entity);
      else context.machinesByPlanet.set(entity.planetId, [entity]);
      if (entity.buildingId && entity.buildingId !== "ray_receiver") {
        const recipe = getRecipe(entity.recipeId);
        if (recipe) {
          const building = getBuilding(entity.buildingId);
          const profile = getPlanetIndustrialProfile(state, entity.planetId);
          const planetSpeed = specializationApplies(profile, building.family, entity.buildingId) ? profile.productionSpeedMultiplier : 1;
          const runtime = {
            entity,
            recipe,
            baseSpeedProduct: building.speed * entity.machineCount,
            planetSpeed,
            recipeDuration: recipe.duration,
            outputCapacity: getEntityOutputCapacity(state, entity),
            outputCreditKeys: recipe.outputs.map((output) => outputCapacityCreditKey(entity.id, output.itemId)),
            powerDemandProduct: (building.powerDemandKw ?? 0) * entity.machineCount,
            sprayCost: getProliferatorSprayCost(recipe),
            baseUnitsPerCycle: recipe.id === "matrix_research" || recipe.id === "solar_sail_launch" || recipe.id === "carrier_rocket_launch"
              ? 1
              : recipe.outputs.reduce((sum, output) => sum + output.amount, 0),
            launchEnergyPerCycle: dysonLaunchEnergyPerCycle(recipe.id),
            matrixResearch: recipe.id === "matrix_research",
          } satisfies IndexedMachineRuntime;
          context.machineRuntimeById.set(entity.id, runtime);
          const runtimes = context.machineRuntimesByPlanet.get(entity.planetId);
          if (runtimes) runtimes.push(runtime);
          else context.machineRuntimesByPlanet.set(entity.planetId, [runtime]);
        }
      }
      if (entity.buildingId === "ray_receiver") context.rayReceivers.push(entity);
    }
    if (entity.kind === "vein") {
      const veins = context.veinsByPlanet.get(entity.planetId);
      if (veins) veins.push(entity);
      else context.veinsByPlanet.set(entity.planetId, [entity]);
    }
    if (entity.kind === "station") context.stations.push(entity);
    if (entity.buildingId === "orbital_collector") context.orbitalCollectors.push(entity);
    if ((entity.kind === "storage" || entity.kind === "splitter" || entity.kind === "station") && entity.buildingId !== "material_delivery_hub" && !isElevatorStation(entity)) {
      context.logisticsBufferEntities.push(entity);
    }
    if (entity.buildingId === "material_delivery_hub") context.materialDeliveryHubs.push(entity);
    if (entity.buildingId === "galactic_material_exporter") context.galacticExporters.push(entity);
    if (entity.buildingId === "time_warp_device") context.timeWarpDevices.push(entity);
    if (entity.kind === "power" || (entity.buildingId === "ray_receiver" && entity.recipeId === "ray_power")) {
      addTo(context.powerSourcesByPlanetGrid, `${entity.planetId}|${getEntityPowerGridId(entity)}`, entity);
    }
  }
  for (const belt of context.sortedBelts) {
    const planetBelts = context.beltsByPlanet.get(belt.planetId);
    if (planetBelts) planetBelts.push(belt);
    else context.beltsByPlanet.set(belt.planetId, [belt]);
    addTo(context.outgoingBeltsBySource, belt.source, belt);
    addTo(context.incomingBeltsByTarget, belt.target, belt);
    let planetRuntime = context.beltRuntime.byPlanet.get(belt.planetId);
    if (!planetRuntime) {
      planetRuntime = {
        beltById: new Map(),
        sourceToBelts: new Map(),
        targetToBelts: new Map(),
        itemToBelts: new Map(),
        activeBelts: new Set(),
        blockedBelts: new Set(),
        inputStarvedBelts: new Set(),
        outputFullBelts: new Set(),
        powerLimitedBelts: new Set(),
      };
      context.beltRuntime.byPlanet.set(belt.planetId, planetRuntime);
    }
    planetRuntime.beltById.set(belt.id, belt);
    addTo(planetRuntime.sourceToBelts, belt.source, belt);
    addTo(planetRuntime.targetToBelts, belt.target, belt);
    const itemBelts = planetRuntime.itemToBelts.get(belt.itemId);
    if (itemBelts) itemBelts.push(belt);
    else planetRuntime.itemToBelts.set(belt.itemId, [belt]);
  }
  context.beltRoutes = context.sortedBelts.map((belt) => {
    const source = context.entityById.get(belt.source);
    const target = context.entityById.get(belt.target);
    const compatible = Boolean(source && target && source.planetId === target.planetId &&
      belt.planetId === source.planetId && sourceProduces(source, belt.itemId) &&
      targetConsumes(state, target, belt.itemId, belt.targetPortIndex));
    return {
      belt,
      source,
      target,
      capacity: getBeltCapacity(belt),
      compatible,
      targetInputCapacity: target ? staticBeltTargetInputCapacity(state, target, belt.itemId) : undefined,
    };
  });
  const targetCapacityIndexByKey = new Map<string, number>();
  for (const route of context.beltRoutes) {
    if (!route.target) continue;
    const key = beltTargetCapacityKey(route.target, route.belt.itemId, route.belt.targetPortIndex);
    let index = targetCapacityIndexByKey.get(key);
    if (index === undefined) {
      index = targetCapacityIndexByKey.size;
      targetCapacityIndexByKey.set(key, index);
    }
    route.targetCapacityIndex = index;
  }
  context.beltRuntime.targetCapacityGroupCount = targetCapacityIndexByKey.size;
  for (const route of context.beltRoutes) {
    const key = `${route.belt.source}:${route.belt.itemId}`;
    let group = context.beltRuntime.routeGroupByKey.get(key);
    if (!group) {
      group = {
        index: context.beltRuntime.routeGroups.length,
        key,
        planetId: route.belt.planetId,
        source: route.source,
        itemId: route.belt.itemId,
        routes: [],
        potentiallyProduces: Boolean(route.source && beltSourceMayProduceDuringStep(route.source, route.belt.itemId)),
      };
      context.beltRuntime.routeGroupByKey.set(key, group);
      context.beltRuntime.routeGroups.push(group);
    }
    group.routes.push(route);
    route.sourceGroupIndex = group.index;
    context.beltRuntime.groupKeyByBeltId.set(route.belt.id, key);
    if (beltHasRuntimeSignal(route.belt)) context.beltRuntime.activeGroupKeys.add(key);
  }
  let initiallyDormantRouteCount = 0;
  for (const group of context.beltRuntime.routeGroups) {
    [...group.routes]
      .sort((left, right) => left.belt.id.localeCompare(right.belt.id))
      .forEach((route, index) => { route.stableSourceOrder = index; });
    const sourceAmount = group.source?.outputs[group.itemId] ?? 0;
    const active = group.potentiallyProduces || sourceAmount > EPSILON || context.beltRuntime.activeGroupKeys.has(group.key);
    const planetRuntime = context.beltRuntime.byPlanet.get(group.planetId);
    for (const route of group.routes) {
      if (active) planetRuntime?.activeBelts.add(route.belt.id);
      else {
        initiallyDormantRouteCount += 1;
        planetRuntime?.inputStarvedBelts.add(route.belt.id);
      }
    }
  }
  context.beltRuntime.initiallyDormantRouteCount = initiallyDormantRouteCount;
  context.beltRuntime.activeQueueEnabled = initiallyDormantRouteCount >= Math.max(64, Math.ceil(context.beltRoutes.length * 0.1));
  for (const group of context.beltRuntime.routeGroups) {
    if (group.routes.length === 1) {
      context.beltRuntime.settlementEntries.push(group.routes[0]);
    } else if (group.source) {
      const runtimeGroup: RuntimeBeltTransferGroup = {
        source: group.source,
        itemId: group.itemId,
        available: 0,
        reserved: 0,
        candidates: [],
        runtimeEpoch: 0,
      };
      group.runtimeGroup = runtimeGroup;
      context.beltRuntime.settlementEntries.push(runtimeGroup);
    }
  }
  context.quantumStations = context.stations.filter(isQuantumStation);
  context.quantumEndpoints = context.stations.filter((entity) => isQuantumStation(entity) || isQuantumCollector(entity));
  const quantumDownloadByKey = new Map<string, IndexedQuantumSlotPlan>();
  const quantumUploadByKey = new Map<string, IndexedQuantumSlotPlan>();
  for (const endpoint of context.quantumStations) {
    for (const slot of getStationSlots(endpoint)) {
      if (!slot.itemId || (slot.remoteMode !== "demand" && slot.remoteMode !== "supply")) continue;
      const key = `${endpoint.id}:${slot.itemId}`;
      const target = slot.remoteMode === "demand" ? quantumDownloadByKey : quantumUploadByKey;
      const existing = target.get(key);
      if (!existing || (slot.priority ?? 1) > existing.priority) {
        target.set(key, { endpoint, itemId: slot.itemId, key, priority: slot.priority ?? 1, slot });
      }
    }
  }
  context.quantumDownloadSlots = [...quantumDownloadByKey.values()];
  context.quantumUploadSlots = [...quantumUploadByKey.values()];
  context.quantumTowerStacks = context.quantumStations.reduce((sum, entity) =>
    sum + Math.max(0, Math.floor(entity.machineCount)), 0);
  context.quantumCollectorStacks = context.quantumEndpoints.reduce((sum, entity) =>
    sum + (isQuantumCollector(entity) ? Math.max(0, Math.floor(entity.machineCount)) : 0), 0);
  const add = (key: string, value: IndexedStationSlot) => {
    const existing = context.stationSlotsByKey.get(key);
    if (existing) existing.push(value);
    else context.stationSlotsByKey.set(key, [value]);
  };
  for (const peer of state.entities) {
    if (peer.kind !== "station") continue;
    // Mk.II elevator stations use the system hub contract and must never enter
    // the legacy slot/partner index. Transitioning stations keep their legacy
    // mode until all old routes have drained.
    if (isElevatorStation(peer)) continue;
    if (peer.buildingId === "orbital_collector") {
      if (isTraditionalStationScopeDisabled(peer, "remote")) continue;
      if (peer.storedItemId) add(stationSlotIndexKey("remote", "*", peer.storedItemId, "supply"), {
        peer,
        peerSlotIndex: 0,
        slot: { ...emptyStationSlot(), itemId: peer.storedItemId, remoteMode: "supply" },
      });
      continue;
    }
    const slots = getStationSlots(peer);
    for (let peerSlotIndex = 0; peerSlotIndex < slots.length; peerSlotIndex += 1) {
      const slot = slots[peerSlotIndex];
      if (!slot.itemId) continue;
      if (!isTraditionalStationScopeDisabled(peer, "local")) {
        add(stationSlotIndexKey("local", peer.planetId, slot.itemId, slot.localMode), { peer, peerSlotIndex, slot });
      }
      if (peer.buildingId === "interstellar_logistics_station" && !isTraditionalStationScopeDisabled(peer, "remote")) {
        add(stationSlotIndexKey("remote", "*", slot.itemId, slot.remoteMode), { peer, peerSlotIndex, slot });
      }
    }
  }
  for (const values of context.stationSlotsByKey.values()) {
    values.sort((left, right) => right.slot.priority - left.slot.priority ||
      left.peer.id.localeCompare(right.peer.id) || left.peerSlotIndex - right.peerSlotIndex);
  }
  for (const entity of context.logisticsBufferEntities) {
    const slots = entity.kind === "station" && entity.buildingId !== "orbital_collector"
      ? getStationSlots(entity).filter((slot): slot is StationSlot & { itemId: ItemId } => Boolean(slot.itemId))
      : entity.storedItemId ? [{ ...emptyStationSlot(), itemId: entity.storedItemId }] : [];
    for (const slot of slots) {
      context.logisticsBufferRuntimes.push({
        entity,
        itemId: slot.itemId,
        capacity: entity.kind === "station" ? getStationSlotCapacity(state, entity, slot) : getEntityOutputCapacity(state, entity),
      });
    }
  }
  for (const demand of context.stations) {
    if (demand.buildingId === "orbital_collector" || isElevatorStation(demand)) continue;
    for (const scope of ["local", "remote"] as const) {
      if (isTraditionalStationScopeDisabled(demand, scope) ||
        (scope === "remote" && demand.buildingId !== "interstellar_logistics_station")) continue;
      const orderedSlots = getStationSlots(demand)
        .map((slot, slotIndex) => ({ slot, slotIndex }))
        .filter(({ slot }) => Boolean(slot.itemId) && stationSlotMode(demand, slot, scope) === "demand")
        .sort((left, right) => right.slot.priority - left.slot.priority || left.slotIndex - right.slotIndex);
      if (orderedSlots.length > 0) context.stationDispatchPlans[scope].push({ demand, orderedSlots });
    }
  }
  if (profiler) profiler.stationIndexBuildMs += profileNow() - startedAt;
  return context;
}

export function findStationSlotPeers(
  state: GameState,
  station: FactoryEntity,
  slotIndex: number,
  scope: StationLogisticsScope,
  lookup?: SimulationLookupContext,
  profiler?: SimulationProfiler,
): StationPeerMatch[] {
  const startedAt = profileNow();
  const slot = getStationSlots(station)[slotIndex];
  if (!slot?.itemId) return [];
  const mode = stationSlotMode(station, slot, scope);
  if (mode === "storage") return [];
  if (scope === "local" && station.buildingId === "orbital_collector") return [];
  if (scope === "remote" && station.buildingId !== "interstellar_logistics_station" && station.buildingId !== "orbital_collector") return [];
  const cacheKey = lookup ? stationPeerMatchCacheKey(state, station.id, slotIndex, scope, lookup.routeEnvironmentKey) : "";
  if (profiler) profiler.peerMatchCalls += 1;
  const cached = cacheKey ? lookup!.stationPeerMatches.get(cacheKey) : undefined;
  if (cached) {
    if (profiler) profiler.peerMatchCacheHits += 1;
    return cached;
  }
  const opposite: StationLogisticsMode = mode === "supply" ? "demand" : "supply";
  const candidates: Array<StationPeerMatch & { priority: number; routeAvailable: boolean; routeDuration: number }> = [];
  const indexKey = stationSlotIndexKey(scope, scope === "local" ? station.planetId : "*", slot.itemId, opposite);
  const peerCandidates: IndexedStationSlot[] = lookup ? (lookup.stationSlotsByKey.get(indexKey) ?? []) : state.entities.flatMap((peer) => {
    if (peer.kind !== "station") return [];
    if (isElevatorStation(peer) || isTraditionalStationScopeDisabled(peer, scope)) return [];
    const peerSlots = peer.buildingId === "orbital_collector"
      ? [{ ...emptyStationSlot(), itemId: peer.storedItemId, remoteMode: "supply" as const }]
      : getStationSlots(peer);
    return peerSlots.map((peerSlot, peerSlotIndex) => ({ peer, peerSlotIndex, slot: peerSlot }));
  });
  if (profiler) profiler.peerCandidateChecks += peerCandidates.length;
  for (const { peer, peerSlotIndex, slot: peerSlot } of peerCandidates) {
    if (peer.id === station.id || peer.kind !== "station") continue;
    if (isElevatorStation(peer) || isTraditionalStationScopeDisabled(peer, scope) ||
      isElevatorStation(station) || isTraditionalStationScopeDisabled(station, scope)) continue;
    if (scope === "local") {
      if (peer.planetId !== station.planetId || peer.buildingId === "orbital_collector") continue;
    } else {
      if (peer.planetId === station.planetId ||
        (peer.buildingId !== "interstellar_logistics_station" && peer.buildingId !== "orbital_collector") ||
        !isStarSystemUnlocked(state, getPlanet(peer.planetId).systemId)) continue;
    }
      if (peerSlot.itemId === slot.itemId && stationSlotMode(peer, peerSlot, scope) === opposite) {
        const demand = mode === "demand" ? station : peer;
        const supply = mode === "demand" ? peer : station;
        const demandSlot = mode === "demand" ? slot : peerSlot;
        const economics = scope === "remote" ? getCachedInterstellarRouteEconomics(state, supply, demand, 1, {
          routePolicy: demandSlot.routePolicy,
          warperBudget: demandSlot.warperBudget,
        }, lookup, profiler) : null;
        candidates.push({
          peer,
          peerSlotIndex,
          priority: peerSlot.priority,
          routeAvailable: economics?.routeAvailable ?? true,
          routeDuration: economics?.durationSeconds ?? 0,
        });
      }
  }
  // The index narrows the candidate pool, but must not alter the legacy
  // deterministic ordering used by logistics fairness and route allocation.
  const result = candidates.sort((a, b) => Number(b.routeAvailable) - Number(a.routeAvailable) || b.priority - a.priority ||
    a.routeDuration - b.routeDuration || a.peer.id.localeCompare(b.peer.id));
  if (profiler) profiler.peerMatchMs += profileNow() - startedAt;
  const matches = result.map(({ peer, peerSlotIndex }) => ({ peer, peerSlotIndex }));
  if (cacheKey) lookup!.stationPeerMatches.set(cacheKey, matches);
  return matches;
}

export function findStationSlotPeer(
  state: GameState,
  station: FactoryEntity,
  slotIndex: number,
  scope: StationLogisticsScope,
  lookup?: SimulationLookupContext,
  profiler?: SimulationProfiler,
): StationPeerMatch | undefined {
  return findStationSlotPeers(state, station, slotIndex, scope, lookup, profiler)[0];
}

export function findInterstellarPeer(state: GameState, station: FactoryEntity): FactoryEntity | undefined {
  if (station.kind !== "station" || station.buildingId === "planetary_logistics_station") return undefined;
  if (station.buildingId === "orbital_collector") {
    const itemId = station.storedItemId;
    if (!itemId) return undefined;
    return state.entities.find((candidate) => candidate.buildingId === "interstellar_logistics_station" &&
      candidate.planetId !== station.planetId && getStationSlots(candidate).some((slot) =>
        slot.itemId === itemId && slot.remoteMode === "demand"));
  }
  return findStationSlotPeer(state, station, 0, "remote")?.peer;
}

export function findPlanetaryPeer(state: GameState, station: FactoryEntity): FactoryEntity | undefined {
  if (station.kind !== "station" || station.buildingId === "orbital_collector") return undefined;
  return findStationSlotPeer(state, station, 0, "local")?.peer;
}

export function getStationDroneCapacity(station: FactoryEntity): number {
  return station.buildingId === "planetary_logistics_station" || station.buildingId === "interstellar_logistics_station"
    ? STATION_DRONES_PER_BUILDING * Math.max(0, Math.floor(station.machineCount))
    : 0;
}

export function getStationVesselCapacity(station: FactoryEntity): number {
  return station.buildingId === "interstellar_logistics_station"
    ? STATION_VESSELS_PER_BUILDING * Math.max(0, Math.floor(station.machineCount))
    : 0;
}

export function getStationWarperCapacity(station: FactoryEntity): number {
  return station.buildingId === "interstellar_logistics_station"
    ? STATION_WARPER_CAPACITY_PER_BUILDING * Math.max(0, Math.floor(station.machineCount))
    : 0;
}

export function getStationWarperAutoRefillTarget(station: FactoryEntity): number {
  const capacity = getStationWarperCapacity(station);
  if (capacity < 1) return 0;
  return Math.max(1, Math.min(capacity, Math.floor(station.stationWarperTarget ?? DEFAULT_STATION_WARPER_TARGET)));
}

export function getStationMinimumLoad(station: FactoryEntity, slotIndex = 0): StationMinimumLoad {
  const slotLoad = station.stationSlots?.[slotIndex]?.minimumLoad;
  if (STATION_MINIMUM_LOAD_OPTIONS.includes(slotLoad as StationMinimumLoad)) return slotLoad as StationMinimumLoad;
  return STATION_MINIMUM_LOAD_OPTIONS.includes(station.stationMinimumLoad as StationMinimumLoad)
    ? station.stationMinimumLoad as StationMinimumLoad
    : 1;
}

export function getStationMinimumCargo(state: GameState, station: FactoryEntity, slotIndex = 0, scope?: StationLogisticsScope): number {
  const local = scope ? scope === "local" : station.buildingId === "planetary_logistics_station";
  const vehicleCapacity = local
    ? getPlanetaryCargoCapacity(state)
    : getInterstellarCargoCapacity(state);
  return Math.ceil(vehicleCapacity * getStationMinimumLoad(station, slotIndex));
}

export function stationRouteRequiresWarp(station: FactoryEntity, peer: FactoryEntity | undefined): boolean {
  return Boolean(peer && getPlanet(station.planetId).systemId !== getPlanet(peer.planetId).systemId);
}

function planetaryDispatchableDrones(state: GameState, station: FactoryEntity): number {
  const peer = findPlanetaryPeer(state, station);
  if (!peer || !station.storedItemId) return 0;
  const supply = station.stationMode === "supply" ? station : peer;
  const demand = station.stationMode === "demand" ? station : peer;
  const itemId = station.storedItemId;
  const capacity = getEntityOutputCapacity(state, demand);
  const available = Math.floor((supply.outputs[itemId] ?? 0) + EPSILON);
  const free = Math.floor(Math.max(0, capacity - (demand.outputs[itemId] ?? 0)) + EPSILON);
  const minimumCargo = getStationMinimumCargo(state, demand);
  const drones = Math.min(getStationDroneCapacity(demand), Math.max(0, Math.floor(demand.stationDrones ?? 0)));
  return Math.max(0, Math.min(drones, Math.floor(available / minimumCargo), Math.floor(free / minimumCargo)));
}

function stationDispatchableVessels(state: GameState, station: FactoryEntity): number {
  const peer = findInterstellarPeer(state, station);
  if (!peer || !station.storedItemId) return 0;
  const supply = station.stationMode === "supply" ? station : peer;
  const demand = station.stationMode === "demand" ? station : peer;
  const itemId = station.storedItemId;
  const capacity = getEntityOutputCapacity(state, demand);
  const available = Math.floor((supply.outputs[itemId] ?? 0) + EPSILON);
  const free = Math.floor(Math.max(0, capacity - (demand.outputs[itemId] ?? 0)) + EPSILON);
  const minimumCargo = getStationMinimumCargo(state, demand);
  const vessels = Math.min(
    getStationVesselCapacity(demand),
    Math.max(0, Math.floor(demand.stationVessels ?? 0)),
  );
  const demandSlot = getStationSlots(demand).find((slot) => slot.itemId === itemId && slot.remoteMode === "demand") ?? getStationSlots(demand)[0];
  const economics = getInterstellarRouteEconomics(state, supply, demand, 1, {
    routePolicy: demandSlot?.routePolicy,
    warperBudget: demandSlot?.warperBudget,
  });
  const warpLimit = stationRouteRequiresWarp(demand, supply)
    ? demand.stationWarpEnabled && isTechnologyCompleted(state, "space_warp") && economics.routeAvailable
      ? Math.floor(Math.max(0, Math.floor(demand.stationWarpers ?? 0)) / Math.max(1, economics.warpersPerVessel))
      : 0
    : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(vessels, warpLimit, Math.floor(available / minimumCargo), Math.floor(free / minimumCargo)));
}

function stationRouteReady(state: GameState, station: FactoryEntity, lookup?: SimulationLookupContext, profiler?: SimulationProfiler): boolean {
  if (station.buildingId === "orbital_collector") return false;
  if (stationActiveRoutes(state, station, lookup).length > 0) return true;
  const scopes: StationLogisticsScope[] = station.buildingId === "interstellar_logistics_station"
    ? ["local", "remote"]
    : ["local"];
  const slots = getStationSlots(station);
  for (const scope of scopes) {
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const slot = slots[slotIndex];
      if (!slot.itemId || stationSlotMode(station, slot, scope) === "storage") continue;
      const match = findStationSlotPeer(state, station, slotIndex, scope, lookup, profiler);
      if (!match) continue;
      const demand = stationSlotMode(station, slot, scope) === "demand" ? station : match.peer;
      const demandSlotIndex = demand.id === station.id ? slotIndex : match.peerSlotIndex;
      const demandSlot = getStationSlots(demand)[demandSlotIndex];
      const supply = demand.id === station.id ? match.peer : station;
      const supplySlotIndex = demand.id === station.id ? match.peerSlotIndex : slotIndex;
      const supplySlot = supply.buildingId === "orbital_collector"
        ? { ...emptyStationSlot(), itemId: supply.storedItemId }
        : getStationSlots(supply)[supplySlotIndex];
      const itemId = demandSlot?.itemId;
      if (!itemId) continue;
      const available = Math.floor(Math.max(0, (supply.outputs[itemId] ?? 0) - supplySlot.minStock));
      const free = Math.floor(Math.max(0, getStationSlotCapacity(state, demand, demandSlot) -
        (demand.outputs[itemId] ?? 0) - stationInFlightCargo(demand, itemId, lookup)));
      const vehicleOwners = [demand, supply].filter((candidate, index, all) =>
        candidate.buildingId !== "orbital_collector" && all.findIndex((entry) => entry.id === candidate.id) === index);
      const requiresWarp = scope === "remote" && stationRouteRequiresWarp(demand, supply);
      const economics = requiresWarp ? getCachedInterstellarRouteEconomics(state, supply, demand, 1, {
        routePolicy: demandSlot.routePolicy,
        warperBudget: demandSlot.warperBudget,
      }, lookup, profiler) : null;
      const readyOwner = vehicleOwners.some((owner) => {
        const ownerSlotIndex = owner.id === demand.id ? demandSlotIndex : supplySlotIndex;
        const ownerMinimumCargo = getStationMinimumCargo(state, owner, ownerSlotIndex, scope);
        const hasVehicle = stationInstalledVehicles(owner, scope) - stationBusyVehicles(state, owner, scope, lookup) > 0;
        const warpReady = !requiresWarp || (Boolean(economics?.routeAvailable) && isTechnologyCompleted(state, "space_warp") &&
          Boolean(owner.stationWarpEnabled) && (owner.stationWarpers ?? 0) >= (economics?.warpersPerVessel ?? 1));
        return hasVehicle && warpReady && available >= ownerMinimumCargo && free >= ownerMinimumCargo;
      });
      if (readyOwner) return true;
    }
  }
  return false;
}

export interface SimulationPowerPlan {
  gridId?: PowerGridId;
  generationKw: number;
  demandKw: number;
  factor: number;
  windGenerationKw: number;
  solarGenerationKw: number;
  geothermalGenerationKw: number;
  thermalGenerationKw: number;
  fusionGenerationKw: number;
  artificialStarGenerationKw: number;
  rayGenerationKw: number;
  storageDischargeKw: number;
  storageChargeKw: number;
  powerOutputByEntity: Map<string, number>;
  powerInputByEntity: Map<string, number>;
  factorByEntity: Map<string, number>;
  connectedEntities: number;
  disconnectedEntities: number;
  generatorCount: number;
}

export interface SimulationDysonReceptionPlan {
  efficiency: number;
  receiverLoadKw: number;
  allocationByEntity: Map<string, number>;
  efficiencyByEntity: Map<string, number>;
  rayPowerByPlanet: Map<PlanetId, number>;
}

// Internal aliases keep the simulation implementation readable while the
// phased worker protocol can use the same deterministic domain types.
type PowerPlan = SimulationPowerPlan;
type DysonReceptionPlan = SimulationDysonReceptionPlan;

const DYSON_SYSTEM_IDS: StarSystemId[] = STAR_SYSTEM_LIST.map((system) => system.id);

function ensureDysonOrbit(state: GameState, systemId: StarSystemId): DysonSwarmOrbitState {
  state.dysonEngineering.orbitsBySystem[systemId] ??= [];
  let orbit = state.dysonEngineering.orbitsBySystem[systemId].find((candidate) =>
    candidate.id === state.dysonEngineering.activeOrbitBySystem[systemId]);
  if (!orbit) {
    orbit = state.dysonEngineering.orbitsBySystem[systemId][0];
  }
  if (!orbit) {
    orbit = createDefaultDysonOrbit(systemId);
    state.dysonEngineering.orbitsBySystem[systemId].push(orbit);
  }
  state.dysonEngineering.activeOrbitBySystem[systemId] = orbit.id;
  return orbit;
}

function allDysonOrbits(state: GameState): DysonSwarmOrbitState[] {
  return DYSON_SYSTEM_IDS.flatMap((systemId) => state.dysonEngineering.orbitsBySystem[systemId] ?? []);
}

export interface EjectorOrbitTargetStatus {
  systemId: StarSystemId;
  targetOrbitId: string | null;
  orbit: DysonSwarmOrbitState | null;
  valid: boolean;
  reason: "missing-target" | "missing-orbit" | "foreign-system" | null;
}

export function getEjectorOrbitTargetStatus(state: GameState, entity: FactoryEntity): EjectorOrbitTargetStatus {
  const systemId = getPlanet(entity.planetId).systemId;
  const targetOrbitId = typeof entity.targetDysonOrbitId === "string" && entity.targetDysonOrbitId.length > 0
    ? entity.targetDysonOrbitId
    : null;
  const orbit = targetOrbitId
    ? state.dysonEngineering.orbitsBySystem[systemId]?.find((candidate) => candidate.id === targetOrbitId) ?? null
    : null;
  if (orbit) return { systemId, targetOrbitId, orbit, valid: true, reason: null };
  if (!targetOrbitId) return { systemId, targetOrbitId, orbit: null, valid: false, reason: "missing-target" };
  const belongsToAnotherSystem = DYSON_SYSTEM_IDS.some((candidateSystemId) => candidateSystemId !== systemId &&
    state.dysonEngineering.orbitsBySystem[candidateSystemId]?.some((candidate) => candidate.id === targetOrbitId));
  return {
    systemId,
    targetOrbitId,
    orbit: null,
    valid: false,
    reason: belongsToAnotherSystem ? "foreign-system" : "missing-orbit",
  };
}

function activeDysonOrbitIdForPlanet(state: GameState, planetId: PlanetId): string | undefined {
  const systemId = getPlanet(planetId).systemId;
  const activeId = state.dysonEngineering.activeOrbitBySystem[systemId];
  const orbits = state.dysonEngineering.orbitsBySystem[systemId] ?? [];
  return activeId && orbits.some((orbit) => orbit.id === activeId) ? activeId : orbits[0]?.id;
}

function aggregateDysonSwarm(state: GameState): void {
  const orbits = allDysonOrbits(state);
  state.dysonSwarm.sailsInOrbit = Math.floor(orbits.reduce((sum, orbit) => sum + Math.max(0, orbit.sailsInOrbit), 0));
  state.dysonSwarm.totalLaunched = Math.floor(orbits.reduce((sum, orbit) => sum + Math.max(0, orbit.totalLaunched), 0));
  state.dysonSwarm.totalExpired = Math.floor(orbits.reduce((sum, orbit) => sum + Math.max(0, orbit.totalExpired), 0));
  state.dysonSwarm.decayProgress = round(orbits.reduce((sum, orbit) => sum + Math.max(0, orbit.decayProgress), 0), 6);
  state.dysonSwarm.generationKw = Math.floor(orbits.reduce((sum, orbit) => sum + Math.max(0, orbit.generationKw), 0));
}

function adjustOrbitAggregate(state: GameState, field: "sailsInOrbit" | "totalLaunched" | "totalExpired"): void {
  const orbits = allDysonOrbits(state);
  const current = orbits.reduce((sum, orbit) => sum + Math.max(0, Math.floor(orbit[field])), 0);
  const requested = Math.max(0, Math.floor(state.dysonSwarm[field]));
  const delta = requested - current;
  if (delta > 0) {
    const orbit = ensureDysonOrbit(state, "helios");
    orbit[field] = Math.max(0, Math.floor(orbit[field] + delta));
  } else if (delta < 0) {
    let remaining = -delta;
    for (const orbit of [...orbits].reverse()) {
      const removed = Math.min(remaining, Math.max(0, Math.floor(orbit[field])));
      orbit[field] -= removed;
      remaining -= removed;
      if (remaining <= 0) break;
    }
  }
}

function syncLegacySwarmIntoOrbits(state: GameState): void {
  // Older saves and external test fixtures only know the aggregate swarm fields.
  // Fold those values into the first Helios orbit before using per-orbit state.
  ensureDysonOrbit(state, "helios");
  adjustOrbitAggregate(state, "sailsInOrbit");
  adjustOrbitAggregate(state, "totalLaunched");
  adjustOrbitAggregate(state, "totalExpired");
  for (const systemId of DYSON_SYSTEM_IDS) {
    for (const orbit of state.dysonEngineering.orbitsBySystem[systemId] ?? []) {
      orbit.sailsInOrbit = Math.max(0, Math.floor(orbit.sailsInOrbit));
      orbit.totalLaunched = Math.max(orbit.sailsInOrbit, Math.floor(orbit.totalLaunched));
      orbit.totalExpired = Math.max(0, Math.floor(orbit.totalExpired));
      orbit.decayProgress = Math.max(0, orbit.decayProgress) % 1;
      orbit.generationKw = orbit.sailsInOrbit * getSolarSailPowerFor(state, systemId);
    }
  }
  aggregateDysonSwarm(state);
}

function decayDysonSwarm(state: GameState, seconds: number): void {
  syncLegacySwarmIntoOrbits(state);
  if (seconds <= EPSILON) return;
  for (const systemId of DYSON_SYSTEM_IDS) {
    for (const orbit of state.dysonEngineering.orbitsBySystem[systemId] ?? []) {
      const sails = Math.max(0, Math.floor(orbit.sailsInOrbit));
      if (sails < 1) {
        orbit.generationKw = 0;
        continue;
      }
      const accumulatedDecay = Math.max(0, orbit.decayProgress) + sails * seconds / getSolarSailLifetimeSeconds(state);
      const expired = Math.min(sails, Math.floor(accumulatedDecay + EPSILON));
      orbit.sailsInOrbit = sails - expired;
      orbit.totalExpired = Math.floor(orbit.totalExpired + expired);
      orbit.decayProgress = round(Math.max(0, accumulatedDecay - expired), 6);
      orbit.generationKw = orbit.sailsInOrbit * getSolarSailPowerFor(state, systemId);
    }
  }
  aggregateDysonSwarm(state);
}

function dysonFrameComplete(frame: DysonLayerState["frames"][number]): boolean {
  return frame.completedStructurePoints >= frame.requiredStructurePoints;
}

function dysonShellActive(layer: DysonLayerState, shell: DysonLayerState["shells"][number]): boolean {
  return shell.boundaryFrameIds.length > 0 && shell.boundaryFrameIds.every((frameId) => {
    const frame = layer.frames.find((candidate) => candidate.id === frameId);
    return Boolean(frame && dysonFrameComplete(frame));
  });
}

function reconcileDysonPlan(plan: DysonSpherePlanState): void {
  const structurePoints = Math.max(0, Math.floor(plan.structurePoints));
  plan.structurePoints = structurePoints;
  let structureCursor = 0;
  for (const layer of plan.layers) {
    layer.structureAllocationFloor = Math.max(0, Math.floor(layer.structureAllocationFloor ?? 0));
    structureCursor = Math.max(structureCursor, layer.structureAllocationFloor);
    let structureBudget = Math.max(0, structurePoints - structureCursor);
    let layerRequirement = 0;
    for (const node of layer.nodes) {
      node.requiredStructurePoints = Math.max(1, Math.floor(node.requiredStructurePoints));
      node.completedStructurePoints = Math.min(node.requiredStructurePoints, structureBudget);
      structureBudget -= node.completedStructurePoints;
      layerRequirement += node.requiredStructurePoints;
    }
    for (const frame of layer.frames) {
      frame.requiredStructurePoints = Math.max(1, Math.floor(frame.requiredStructurePoints));
      frame.completedStructurePoints = Math.min(frame.requiredStructurePoints, structureBudget);
      structureBudget -= frame.completedStructurePoints;
      layerRequirement += frame.requiredStructurePoints;
    }
    structureCursor += layerRequirement;
  }
  const shellSails = Math.max(0, Math.floor(plan.shellSails));
  plan.shellSails = shellSails;
  let sailCursor = 0;
  for (const layer of plan.layers) {
    layer.shellAllocationFloor = Math.max(0, Math.floor(layer.shellAllocationFloor ?? 0));
    sailCursor = Math.max(sailCursor, layer.shellAllocationFloor);
    for (const shell of layer.shells) {
      shell.sailCapacity = Math.max(1, Math.floor(shell.sailCapacity));
      if (!dysonShellActive(layer, shell)) {
        shell.absorbedSails = 0;
        continue;
      }
      const sailBudget = Math.max(0, shellSails - sailCursor);
      shell.absorbedSails = Math.min(shell.sailCapacity, sailBudget);
      sailCursor += shell.sailCapacity;
    }
  }
}

function syncLegacySphereIntoPlans(state: GameState): void {
  const plans = Object.values(state.dysonPlans);
  const plannedStructure = plans.reduce((sum, plan) => sum + Math.max(0, Math.floor(plan.structurePoints)), 0);
  const plannedSails = plans.reduce((sum, plan) => sum + Math.max(0, Math.floor(plan.shellSails)), 0);
  if (state.dysonSphere.structurePoints > plannedStructure) {
    state.dysonPlans.helios.structurePoints += Math.floor(state.dysonSphere.structurePoints - plannedStructure);
  }
  if (state.dysonSphere.shellSails > plannedSails) {
    state.dysonPlans.helios.shellSails += Math.floor(state.dysonSphere.shellSails - plannedSails);
  }
  for (const plan of plans) reconcileDysonPlan(plan);
}

function dysonPlanShellCapacity(plan: DysonSpherePlanState): number {
  const shells = plan.layers.flatMap((layer) => layer.shells.map((shell) => ({ layer, shell })));
  if (shells.length === 0) return plan.layers.length === 0 ? plan.structurePoints * DYSON_SHELL_CAPACITY_PER_STRUCTURE : 0;
  return shells.reduce((sum, entry) => sum + (dysonShellActive(entry.layer, entry.shell) ? entry.shell.sailCapacity : 0), 0);
}

export function getDysonShellCapacity(state: GameState): number {
  const plans = Object.values(state.dysonPlans);
  const hasPlannedLayer = plans.some((plan) => plan.layers.length > 0);
  if (!hasPlannedLayer) return Math.floor(state.dysonSphere.structurePoints) * DYSON_SHELL_CAPACITY_PER_STRUCTURE;
  return plans.reduce((sum, plan) => sum + dysonPlanShellCapacity(plan), 0);
}

export function getDysonPlanTotals(plan: DysonSpherePlanState) {
  const nodes = plan.layers.flatMap((layer) => layer.nodes);
  const frames = plan.layers.flatMap((layer) => layer.frames);
  const shells = plan.layers.flatMap((layer) => layer.shells.map((shell) => ({ layer, shell })));
  const plannedStructure = nodes.reduce((sum, node) => sum + node.requiredStructurePoints, 0) +
    frames.reduce((sum, frame) => sum + frame.requiredStructurePoints, 0);
  const completedStructure = nodes.reduce((sum, node) => sum + node.completedStructurePoints, 0) +
    frames.reduce((sum, frame) => sum + frame.completedStructurePoints, 0);
  return {
    layerCount: plan.layers.length,
    nodeCount: nodes.length,
    frameCount: frames.length,
    shellCount: shells.length,
    plannedStructure,
    completedStructure,
    sailCapacity: shells.length > 0
      ? shells.reduce((sum, entry) => sum + (dysonShellActive(entry.layer, entry.shell) ? entry.shell.sailCapacity : 0), 0)
      : plan.layers.length === 0 ? plan.structurePoints * DYSON_SHELL_CAPACITY_PER_STRUCTURE : 0,
    absorbedSails: plan.shellSails,
  };
}

function validDysonLaunchMode(mode: DysonLaunchMode): boolean {
  return mode === "balanced" || mode === "swarm" || mode === "sphere";
}

function validDysonLaunchThrottle(throttle: DysonLaunchThrottle): boolean {
  return throttle === 0.25 || throttle === 0.5 || throttle === 0.75 || throttle === 1;
}

export function setDysonLaunchMode(state: GameState, mode: DysonLaunchMode): GameState {
  if (!validDysonLaunchMode(mode) || state.dysonEngineering.launchMode === mode) return state;
  return { ...state, dysonEngineering: { ...state.dysonEngineering, launchMode: mode } };
}

export function setDysonLaunchThrottle(state: GameState, throttle: DysonLaunchThrottle): GameState {
  if (!validDysonLaunchThrottle(throttle) || state.dysonEngineering.launchThrottle === throttle) return state;
  return { ...state, dysonEngineering: { ...state.dysonEngineering, launchThrottle: throttle } };
}

export function setDysonLaunchEnabled(state: GameState, enabled: boolean): GameState {
  if (state.dysonEngineering.launchEnabled === enabled) return state;
  return { ...state, dysonEngineering: { ...state.dysonEngineering, launchEnabled: enabled } };
}

export function addDysonSwarmOrbit(state: GameState, systemId: StarSystemId): GameState {
  if (!isStarSystemUnlocked(state, systemId) || !isTechnologyCompleted(state, "dyson_swarm")) return state;
  const current = state.dysonEngineering.orbitsBySystem[systemId] ?? [];
  if (current.length >= 8) return state;
  const next = copyState(state);
  const orbit = createDefaultDysonOrbit(systemId, current.length);
  orbit.id = `dyson_orbit_${next.nextId}`;
  orbit.name = `太阳帆轨道 ${String.fromCharCode(65 + current.length)}`;
  orbit.radius = 12_000 + current.length * 6_000;
  next.nextId += 1;
  next.dysonEngineering.orbitsBySystem[systemId].push(orbit);
  next.dysonEngineering.activeOrbitBySystem[systemId] = orbit.id;
  return next;
}

export function setActiveDysonSwarmOrbit(state: GameState, systemId: StarSystemId, orbitId: string): GameState {
  if (!state.dysonEngineering.orbitsBySystem[systemId]?.some((orbit) => orbit.id === orbitId)) return state;
  return {
    ...state,
    dysonEngineering: {
      ...state.dysonEngineering,
      activeOrbitBySystem: { ...state.dysonEngineering.activeOrbitBySystem, [systemId]: orbitId },
    },
  };
}

export function setEjectorTargetOrbitForEntities(
  state: GameState,
  entityIds: readonly string[],
  orbitId: string,
): GameState {
  const ids = [...new Set(entityIds)];
  if (ids.length === 0 || typeof orbitId !== "string" || orbitId.length === 0) return state;
  const targets = ids.map((entityId) => state.entities.find((entity) => entity.id === entityId));
  if (targets.some((entity) => !entity || entity.buildingId !== "em_rail_ejector" ||
    entity.interactionLocked ||
    !state.dysonEngineering.orbitsBySystem[getPlanet(entity.planetId).systemId]?.some((orbit) => orbit.id === orbitId))) return state;
  if (targets.every((entity) => entity!.targetDysonOrbitId === orbitId)) return state;
  const idSet = new Set(ids);
  return {
    ...state,
    entities: state.entities.map((entity) => idSet.has(entity.id) ? { ...entity, targetDysonOrbitId: orbitId } : entity),
  };
}

export function setEjectorTargetOrbit(state: GameState, entityId: string, orbitId: string): GameState {
  return setEjectorTargetOrbitForEntities(state, [entityId], orbitId);
}

export function setDysonSwarmOrbit(
  state: GameState,
  systemId: StarSystemId,
  orbitId: string,
  changes: { radius?: number; inclination?: number; longitude?: number },
): GameState {
  const orbit = state.dysonEngineering.orbitsBySystem[systemId]?.find((candidate) => candidate.id === orbitId);
  if (!orbit) return state;
  const next = copyState(state);
  const target = next.dysonEngineering.orbitsBySystem[systemId].find((candidate) => candidate.id === orbitId)!;
  if (changes.radius != null && Number.isFinite(changes.radius)) target.radius = Math.max(5_000, Math.min(50_000, Math.round(changes.radius)));
  if (changes.inclination != null && Number.isFinite(changes.inclination)) target.inclination = Math.max(-90, Math.min(90, Math.round(changes.inclination)));
  if (changes.longitude != null && Number.isFinite(changes.longitude)) target.longitude = normalizeDysonAngle(changes.longitude);
  return next;
}

export function removeDysonSwarmOrbit(state: GameState, systemId: StarSystemId, orbitId: string): GameState {
  const current = state.dysonEngineering.orbitsBySystem[systemId] ?? [];
  if (current.length <= 1 || !current.some((orbit) => orbit.id === orbitId)) return state;
  const next = copyState(state);
  const removed = next.dysonEngineering.orbitsBySystem[systemId].find((orbit) => orbit.id === orbitId)!;
  const fallback = next.dysonEngineering.orbitsBySystem[systemId].find((orbit) => orbit.id !== orbitId)!;
  fallback.sailsInOrbit += removed.sailsInOrbit;
  fallback.totalLaunched += removed.totalLaunched;
  fallback.totalExpired += removed.totalExpired;
  fallback.generationKw = fallback.sailsInOrbit * getSolarSailPowerFor(next, systemId);
  next.dysonEngineering.orbitsBySystem[systemId] = next.dysonEngineering.orbitsBySystem[systemId].filter((orbit) => orbit.id !== orbitId);
  if (next.dysonEngineering.activeOrbitBySystem[systemId] === orbitId) {
    next.dysonEngineering.activeOrbitBySystem[systemId] = fallback.id;
  }
  aggregateDysonSwarm(next);
  return next;
}

export function getDysonEngineeringSnapshot(state: GameState, systemId: StarSystemId): DysonEngineeringSnapshot {
  const plan = state.dysonPlans[systemId];
  const orbits = state.dysonEngineering.orbitsBySystem[systemId] ?? [];
  const entities = state.entities.filter((entity) => getPlanet(entity.planetId).systemId === systemId);
  const launchFactorFor = (recipeId: RecipeId) => dysonLaunchFactor(state, recipeId);
  const launchEntities = entities.filter((entity) => entity.kind === "machine" &&
    (entity.recipeId === "solar_sail_launch" || entity.recipeId === "carrier_rocket_launch") && entity.buildingId);
  const queuedSails = launchEntities.filter((entity) => entity.recipeId === "solar_sail_launch")
    .reduce((sum, entity) => sum + Math.floor(entity.inputs.solar_sail ?? 0), 0);
  const queuedRockets = launchEntities.filter((entity) => entity.recipeId === "carrier_rocket_launch")
    .reduce((sum, entity) => sum + Math.floor(entity.inputs.small_carrier_rocket ?? 0), 0);
  const nominalRate = (recipeId: RecipeId) => launchEntities
    .filter((entity) => entity.recipeId === recipeId &&
      (recipeId !== "solar_sail_launch" || getEjectorOrbitTargetStatus(state, entity).valid))
    .reduce((sum, entity) => {
      const recipe = getRecipe(recipeId)!;
      return sum + getBuilding(entity.buildingId!).speed * entity.machineCount / recipe.duration * 60 * launchFactorFor(recipeId);
    }, 0);
  const sailLaunchesPerMinute = round(nominalRate("solar_sail_launch"), 2);
  const rocketLaunchesPerMinute = round(nominalRate("carrier_rocket_launch"), 2);
  const receiverEntities = entities.filter((entity) => entity.buildingId === "ray_receiver" &&
    (entity.recipeId === "ray_power" || entity.recipeId === "critical_photon"));
  const operationalReceiverEntities = receiverEntities.filter((entity) => canMachineRun(state, entity));
  const receiverCapacityKw = receiverEntities.reduce((sum, entity) => sum + getRayReceiverCapacityKw(state) * entity.machineCount, 0);
  const operationalReceiverCapacityKw = operationalReceiverEntities.reduce((sum, entity) => sum + getRayReceiverCapacityKw(state) * entity.machineCount, 0);
  const receiverLoadKw = receiverEntities.reduce((sum, entity) => sum + Math.max(0, entity.powerOutputKw ?? 0), 0);
  const criticalPhotonPerMinute = entities.filter((entity) => entity.recipeId === "critical_photon")
    .reduce((sum, entity) => sum + Math.max(0, entity.productionRate), 0);
  const antimatterPerMinute = entities.filter((entity) => entity.recipeId === "antimatter")
    .reduce((sum, entity) => sum + Math.max(0, entity.productionRate) * 0.5, 0);
  const feedbackGenerationKw = entities.filter((entity) => entity.buildingId === "artificial_star")
    .reduce((sum, entity) => sum + Math.max(0, entity.powerOutputKw ?? 0), 0);
  const totals = getDysonPlanTotals(plan);
  const orbitSails = orbits.reduce((sum, orbit) => sum + orbit.sailsInOrbit, 0);
  const launchEnergyPerMinuteMj = sailLaunchesPerMinute * DYSON_SAIL_LAUNCH_ENERGY_MJ +
    rocketLaunchesPerMinute * DYSON_ROCKET_LAUNCH_ENERGY_MJ;
  const currentGenerationKw = dysonGenerationForSystem(state, systemId);
  const theoreticalReceptionRate = receiverCapacityKw > EPSILON
    ? Math.min(1, currentGenerationKw / receiverCapacityKw)
    : 0;
  const receiverUtilization = operationalReceiverCapacityKw > EPSILON
    ? Math.min(1, receiverLoadKw / operationalReceiverCapacityKw)
    : 0;
  const dysonPowerUtilization = currentGenerationKw > EPSILON
    ? Math.min(1, receiverLoadKw / currentGenerationKw)
    : 0;
  return {
    systemId,
    launchMode: state.dysonEngineering.launchMode,
    launchThrottle: state.dysonEngineering.launchThrottle,
    launchEnabled: state.dysonEngineering.launchEnabled,
    orbitCount: orbits.length,
    orbitSails: Math.floor(orbitSails),
    queuedSails,
    queuedRockets,
    sailLaunchesPerMinute,
    rocketLaunchesPerMinute,
    launchEnergyPerSailMj: DYSON_SAIL_LAUNCH_ENERGY_MJ,
    launchEnergyPerRocketMj: DYSON_ROCKET_LAUNCH_ENERGY_MJ,
    launchEnergyPerMinuteMj: round(launchEnergyPerMinuteMj, 2),
    launchEnergySpentMj: round(state.dysonEngineering.launchEnergySpentMj, 3),
    rayGenerationKw: receiverEntities.filter((entity) => entity.recipeId === "ray_power")
      .reduce((sum, entity) => sum + Math.max(0, entity.powerOutputKw ?? 0), 0),
    receiverCapacityKw,
    operationalReceiverCapacityKw,
    receiverLoadKw,
    theoreticalReceptionRate: round(theoreticalReceptionRate, 4),
    receiverUtilization: round(receiverUtilization, 4),
    dysonPowerUtilization: round(dysonPowerUtilization, 4),
    configuredReceiverCount: receiverEntities.reduce((sum, entity) => sum + entity.machineCount, 0),
    blockedReceiverCount: receiverEntities.filter((entity) => !canMachineRun(state, entity)).reduce((sum, entity) => sum + entity.machineCount, 0),
    rayEfficiency: round(theoreticalReceptionRate, 4),
    criticalPhotonPerMinute: round(criticalPhotonPerMinute, 2),
    antimatterPerMinute: round(antimatterPerMinute, 2),
    feedbackGenerationKw: round(feedbackGenerationKw, 2),
    plannedStructurePoints: totals.plannedStructure,
    completedStructurePoints: totals.completedStructure,
    remainingStructurePoints: Math.max(0, totals.plannedStructure - totals.completedStructure),
    shellCapacity: totals.sailCapacity,
    shellSails: Math.floor(plan.shellSails),
    projectedGenerationKw: Math.floor(currentGenerationKw),
  };
}

function normalizeDysonAngle(angle: number): number {
  return ((Math.round(angle * 10) / 10) % 360 + 360) % 360;
}

function dysonFrameRequirement(radius: number, sourceAngle: number, targetAngle: number): number {
  const direct = Math.abs(sourceAngle - targetAngle) % 360;
  const arc = Math.min(direct, 360 - direct);
  return Math.max(1, Math.ceil(radius / 10_000 * arc / 45));
}

function canEditDysonSystem(state: GameState, systemId: StarSystemId): boolean {
  return isStarSystemUnlocked(state, systemId) && isTechnologyCompleted(state, "dyson_sphere_program");
}

export function addDysonLayer(state: GameState, systemId: StarSystemId): GameState {
  if (!canEditDysonSystem(state, systemId) || state.dysonPlans[systemId].layers.length >= 8) return state;
  const next = copyState(state);
  syncLegacySphereIntoPlans(next);
  const plan = next.dysonPlans[systemId];
  const layer: DysonLayerState = {
    id: `dyson_layer_${next.nextId}`,
    name: `壳层 ${plan.layers.length + 1}`,
    radius: 10_000 + plan.layers.length * 4_000,
    inclination: 0,
    longitude: 0,
    nodes: [],
    frames: [],
    shells: [],
    structureAllocationFloor: 0,
    shellAllocationFloor: 0,
  };
  next.nextId += 1;
  plan.layers.push(layer);
  plan.activeLayerId = layer.id;
  reconcileDysonPlan(plan);
  return next;
}

export function createStandardDysonLayer(state: GameState, systemId: StarSystemId, nodeCount = 8): GameState {
  if (!canEditDysonSystem(state, systemId) || state.dysonPlans[systemId].layers.length >= 8) return state;
  const count = Math.max(3, Math.min(16, Math.floor(nodeCount)));
  const next = copyState(state);
  syncLegacySphereIntoPlans(next);
  const plan = next.dysonPlans[systemId];
  const radius = 10_000 + plan.layers.length * 4_000;
  const layer: DysonLayerState = {
    id: `dyson_layer_${next.nextId}`,
    name: `标准壳层 ${plan.layers.length + 1}`,
    radius,
    inclination: plan.layers.length % 2 === 0 ? 0 : 18,
    longitude: plan.layers.length * 24 % 360,
    nodes: [],
    frames: [],
    shells: [],
    structureAllocationFloor: 0,
    shellAllocationFloor: 0,
  };
  next.nextId += 1;
  for (let index = 0; index < count; index += 1) {
    layer.nodes.push({
      id: `dyson_node_${next.nextId}`,
      angle: index * 360 / count,
      requiredStructurePoints: 1,
      completedStructurePoints: 0,
    });
    next.nextId += 1;
  }
  for (let index = 0; index < count; index += 1) {
    const source = layer.nodes[index];
    const target = layer.nodes[(index + 1) % count];
    const frame = {
      id: `dyson_frame_${next.nextId}`,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      requiredStructurePoints: dysonFrameRequirement(radius, source.angle, target.angle),
      completedStructurePoints: 0,
    };
    next.nextId += 1;
    layer.frames.push(frame);
    if (isTechnologyCompleted(next, "dyson_shell")) {
      layer.shells.push({
        id: `dyson_shell_${next.nextId}`,
        sourceNodeId: source.id,
        targetNodeId: target.id,
        boundaryFrameIds: [frame.id],
        sailCapacity: frame.requiredStructurePoints * DYSON_SHELL_CAPACITY_PER_STRUCTURE,
        absorbedSails: 0,
      });
      next.nextId += 1;
    }
  }
  plan.layers.push(layer);
  plan.activeLayerId = layer.id;
  reconcileDysonPlan(plan);
  return next;
}

export function setActiveDysonLayer(state: GameState, systemId: StarSystemId, layerId: string): GameState {
  if (!state.dysonPlans[systemId].layers.some((layer) => layer.id === layerId)) return state;
  return {
    ...state,
    dysonPlans: {
      ...state.dysonPlans,
      [systemId]: { ...state.dysonPlans[systemId], activeLayerId: layerId },
    },
  };
}

export function setDysonLayerOrbit(state: GameState, systemId: StarSystemId, layerId: string, orbit: { radius?: number; inclination?: number; longitude?: number }): GameState {
  if (!canEditDysonSystem(state, systemId) || !state.dysonPlans[systemId].layers.some((layer) => layer.id === layerId)) return state;
  const next = copyState(state);
  const layer = next.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId)!;
  if (orbit.radius != null) layer.radius = Math.max(5_000, Math.min(50_000, Math.round(orbit.radius)));
  if (orbit.inclination != null) layer.inclination = Math.max(-90, Math.min(90, Math.round(orbit.inclination)));
  if (orbit.longitude != null) layer.longitude = normalizeDysonAngle(orbit.longitude);
  for (const frame of layer.frames) {
    const source = layer.nodes.find((node) => node.id === frame.sourceNodeId);
    const target = layer.nodes.find((node) => node.id === frame.targetNodeId);
    if (source && target) frame.requiredStructurePoints = dysonFrameRequirement(layer.radius, source.angle, target.angle);
  }
  for (const shell of layer.shells) {
    const frame = layer.frames.find((candidate) => shell.boundaryFrameIds.includes(candidate.id));
    if (frame) shell.sailCapacity = frame.requiredStructurePoints * DYSON_SHELL_CAPACITY_PER_STRUCTURE;
  }
  reconcileDysonPlan(next.dysonPlans[systemId]);
  return next;
}

export function removeDysonLayer(state: GameState, systemId: StarSystemId, layerId: string): GameState {
  if (!canEditDysonSystem(state, systemId) || !state.dysonPlans[systemId].layers.some((layer) => layer.id === layerId)) return state;
  const next = copyState(state);
  const plan = next.dysonPlans[systemId];
  plan.layers = plan.layers.filter((layer) => layer.id !== layerId);
  if (plan.activeLayerId === layerId) plan.activeLayerId = plan.layers[0]?.id ?? null;
  reconcileDysonPlan(plan);
  return next;
}

export function addDysonNode(state: GameState, systemId: StarSystemId, layerId: string, angle: number): GameState {
  const layer = state.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId);
  const normalized = normalizeDysonAngle(angle);
  if (!canEditDysonSystem(state, systemId) || !layer || layer.nodes.length >= 24 ||
    layer.nodes.some((node) => Math.min(Math.abs(node.angle - normalized), 360 - Math.abs(node.angle - normalized)) < 5)) return state;
  const next = copyState(state);
  next.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId)!.nodes.push({
    id: `dyson_node_${next.nextId}`,
    angle: normalized,
    requiredStructurePoints: 1,
    completedStructurePoints: 0,
  });
  next.nextId += 1;
  reconcileDysonPlan(next.dysonPlans[systemId]);
  return next;
}

export function removeDysonNode(state: GameState, systemId: StarSystemId, layerId: string, nodeId: string): GameState {
  const layer = state.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId);
  if (!canEditDysonSystem(state, systemId) || !layer?.nodes.some((node) => node.id === nodeId)) return state;
  const next = copyState(state);
  const target = next.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId)!;
  const removedFrameIds = new Set(target.frames.filter((frame) => frame.sourceNodeId === nodeId || frame.targetNodeId === nodeId).map((frame) => frame.id));
  target.nodes = target.nodes.filter((node) => node.id !== nodeId);
  target.frames = target.frames.filter((frame) => !removedFrameIds.has(frame.id));
  target.shells = target.shells.filter((shell) => shell.sourceNodeId !== nodeId && shell.targetNodeId !== nodeId && !shell.boundaryFrameIds.some((frameId) => removedFrameIds.has(frameId)));
  reconcileDysonPlan(next.dysonPlans[systemId]);
  return next;
}

export function connectDysonNodes(state: GameState, systemId: StarSystemId, layerId: string, sourceNodeId: string, targetNodeId: string): GameState {
  const layer = state.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId);
  const source = layer?.nodes.find((node) => node.id === sourceNodeId);
  const target = layer?.nodes.find((node) => node.id === targetNodeId);
  const exists = layer?.frames.some((frame) =>
    (frame.sourceNodeId === sourceNodeId && frame.targetNodeId === targetNodeId) ||
    (frame.sourceNodeId === targetNodeId && frame.targetNodeId === sourceNodeId));
  if (!canEditDysonSystem(state, systemId) || !layer || !source || !target || sourceNodeId === targetNodeId || exists) return state;
  const next = copyState(state);
  next.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId)!.frames.push({
    id: `dyson_frame_${next.nextId}`,
    sourceNodeId,
    targetNodeId,
    requiredStructurePoints: dysonFrameRequirement(layer.radius, source.angle, target.angle),
    completedStructurePoints: 0,
  });
  next.nextId += 1;
  reconcileDysonPlan(next.dysonPlans[systemId]);
  return next;
}

export function autoConnectDysonLayer(state: GameState, systemId: StarSystemId, layerId: string): GameState {
  const layer = state.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId);
  if (!canEditDysonSystem(state, systemId) || !layer || layer.nodes.length < 3) return state;
  let next = state;
  const sorted = [...layer.nodes].sort((a, b) => a.angle - b.angle);
  for (let index = 0; index < sorted.length; index += 1) {
    next = connectDysonNodes(next, systemId, layerId, sorted[index].id, sorted[(index + 1) % sorted.length].id);
  }
  return next;
}

export function planDysonShell(state: GameState, systemId: StarSystemId, layerId: string): GameState {
  if (!isTechnologyCompleted(state, "dyson_shell")) return state;
  const connected = autoConnectDysonLayer(state, systemId, layerId);
  const layer = connected.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId);
  if (!layer || layer.nodes.length < 3) return state;
  const next = copyState(connected);
  const target = next.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId)!;
  const sorted = [...target.nodes].sort((a, b) => a.angle - b.angle);
  for (let index = 0; index < sorted.length; index += 1) {
    const source = sorted[index];
    const destination = sorted[(index + 1) % sorted.length];
    const exists = target.shells.some((shell) =>
      (shell.sourceNodeId === source.id && shell.targetNodeId === destination.id) ||
      (shell.sourceNodeId === destination.id && shell.targetNodeId === source.id));
    const frame = target.frames.find((candidate) =>
      (candidate.sourceNodeId === source.id && candidate.targetNodeId === destination.id) ||
      (candidate.sourceNodeId === destination.id && candidate.targetNodeId === source.id));
    if (exists || !frame) continue;
    target.shells.push({
      id: `dyson_shell_${next.nextId}`,
      sourceNodeId: source.id,
      targetNodeId: destination.id,
      boundaryFrameIds: [frame.id],
      sailCapacity: frame.requiredStructurePoints * DYSON_SHELL_CAPACITY_PER_STRUCTURE,
      absorbedSails: 0,
    });
    next.nextId += 1;
  }
  reconcileDysonPlan(next.dysonPlans[systemId]);
  return next;
}

export function clearDysonShells(state: GameState, systemId: StarSystemId, layerId: string): GameState {
  if (!canEditDysonSystem(state, systemId)) return state;
  const next = copyState(state);
  const layer = next.dysonPlans[systemId].layers.find((candidate) => candidate.id === layerId);
  if (!layer) return state;
  layer.shells = [];
  reconcileDysonPlan(next.dysonPlans[systemId]);
  return next;
}

export interface DysonLayerTemplate {
  name: string;
  radius: number;
  inclination: number;
  longitude: number;
  nodes: Array<{ key: string; angle: number }>;
  frames: Array<{ key: string; sourceNodeKey: string; targetNodeKey: string }>;
  shells: Array<{ sourceNodeKey: string; targetNodeKey: string; boundaryFrameKeys: string[] }>;
}

export interface PasteDysonLayerResult {
  state: GameState;
  layerId?: string;
  error?: string;
}

export function createDysonLayerTemplate(layer: DysonLayerState): DysonLayerTemplate {
  const nodeKeyById = new Map(layer.nodes.map((node, index) => [node.id, `node_${index}`]));
  const frameKeyById = new Map(layer.frames.map((frame, index) => [frame.id, `frame_${index}`]));
  return {
    name: layer.name,
    radius: layer.radius,
    inclination: layer.inclination,
    longitude: layer.longitude,
    nodes: layer.nodes.map((node, index) => ({ key: `node_${index}`, angle: node.angle })),
    frames: layer.frames.map((frame, index) => ({
      key: `frame_${index}`,
      sourceNodeKey: nodeKeyById.get(frame.sourceNodeId) ?? "",
      targetNodeKey: nodeKeyById.get(frame.targetNodeId) ?? "",
    })),
    shells: layer.shells.map((shell) => ({
      sourceNodeKey: nodeKeyById.get(shell.sourceNodeId) ?? "",
      targetNodeKey: nodeKeyById.get(shell.targetNodeId) ?? "",
      boundaryFrameKeys: shell.boundaryFrameIds.map((frameId) => frameKeyById.get(frameId) ?? ""),
    })),
  };
}

export function pasteDysonLayerTemplate(state: GameState, systemId: StarSystemId, template: DysonLayerTemplate): PasteDysonLayerResult {
  const plan = state.dysonPlans[systemId];
  if (!plan || !canEditDysonSystem(state, systemId)) return { state, error: "目标恒星系尚未解锁戴森球计划" };
  if (plan.layers.length >= 8) return { state, error: "目标恒星系已达到 8 层上限" };
  if (template.shells.length > 0 && !isTechnologyCompleted(state, "dyson_shell")) return { state, error: "需要戴森球壳科技才能粘贴壳面" };
  if (!Number.isFinite(template.radius) || template.radius < 5_000 || template.radius > 50_000 ||
    !Number.isFinite(template.inclination) || !Number.isFinite(template.longitude)) {
    return { state, error: "壳层轨道参数超出有效范围" };
  }
  if (template.nodes.length > 24) return { state, error: "壳层节点不能超过 24 个" };
  const nodeKeys = new Set<string>();
  const normalizedNodes: Array<{ key: string; angle: number }> = [];
  for (const node of template.nodes) {
    if (!node.key || nodeKeys.has(node.key) || !Number.isFinite(node.angle)) return { state, error: "壳层节点模板无效" };
    const angle = normalizeDysonAngle(node.angle);
    if (normalizedNodes.some((candidate) => Math.min(Math.abs(candidate.angle - angle), 360 - Math.abs(candidate.angle - angle)) < 5)) {
      return { state, error: "壳层节点角度间距不足 5°" };
    }
    nodeKeys.add(node.key);
    normalizedNodes.push({ key: node.key, angle });
  }
  const frameKeys = new Set<string>();
  const frameEdges = new Set<string>();
  for (const frame of template.frames) {
    const edge = [frame.sourceNodeKey, frame.targetNodeKey].sort().join("|");
    if (!frame.key || frameKeys.has(frame.key) || !nodeKeys.has(frame.sourceNodeKey) || !nodeKeys.has(frame.targetNodeKey) ||
      frame.sourceNodeKey === frame.targetNodeKey || frameEdges.has(edge)) return { state, error: "壳层框架引用无效或重复" };
    frameKeys.add(frame.key);
    frameEdges.add(edge);
  }
  for (const shell of template.shells) {
    if (!nodeKeys.has(shell.sourceNodeKey) || !nodeKeys.has(shell.targetNodeKey) || shell.sourceNodeKey === shell.targetNodeKey ||
      shell.boundaryFrameKeys.length === 0 || shell.boundaryFrameKeys.some((key) => !frameKeys.has(key))) {
      return { state, error: "壳面边界引用不闭合" };
    }
  }
  const next = copyState(state);
  const targetPlan = next.dysonPlans[systemId];
  const layerId = `dyson_layer_${next.nextId++}`;
  const nodeIdByKey = new Map<string, string>();
  const layer: DysonLayerState = {
    id: layerId,
    name: `${template.name || "壳层"} 副本`,
    radius: Math.round(template.radius),
    inclination: Math.max(-90, Math.min(90, Math.round(template.inclination))),
    longitude: normalizeDysonAngle(template.longitude),
    nodes: [],
    frames: [],
    shells: [],
    structureAllocationFloor: targetPlan.structurePoints,
    shellAllocationFloor: targetPlan.shellSails,
  };
  for (const node of normalizedNodes) {
    const id = `dyson_node_${next.nextId++}`;
    nodeIdByKey.set(node.key, id);
    layer.nodes.push({ id, angle: node.angle, requiredStructurePoints: 1, completedStructurePoints: 0 });
  }
  const frameIdByKey = new Map<string, string>();
  for (const frame of template.frames) {
    const source = normalizedNodes.find((node) => node.key === frame.sourceNodeKey)!;
    const target = normalizedNodes.find((node) => node.key === frame.targetNodeKey)!;
    const id = `dyson_frame_${next.nextId++}`;
    frameIdByKey.set(frame.key, id);
    layer.frames.push({
      id,
      sourceNodeId: nodeIdByKey.get(frame.sourceNodeKey)!,
      targetNodeId: nodeIdByKey.get(frame.targetNodeKey)!,
      requiredStructurePoints: dysonFrameRequirement(layer.radius, source.angle, target.angle),
      completedStructurePoints: 0,
    });
  }
  for (const shell of template.shells) {
    const boundaryFrameIds = shell.boundaryFrameKeys.map((key) => frameIdByKey.get(key)!);
    const sailCapacity = boundaryFrameIds.reduce((sum, frameId) =>
      sum + (layer.frames.find((frame) => frame.id === frameId)?.requiredStructurePoints ?? 0) * DYSON_SHELL_CAPACITY_PER_STRUCTURE, 0);
    layer.shells.push({
      id: `dyson_shell_${next.nextId++}`,
      sourceNodeId: nodeIdByKey.get(shell.sourceNodeKey)!,
      targetNodeId: nodeIdByKey.get(shell.targetNodeKey)!,
      boundaryFrameIds,
      sailCapacity,
      absorbedSails: 0,
    });
  }
  targetPlan.layers.push(layer);
  targetPlan.activeLayerId = layer.id;
  reconcileDysonPlan(targetPlan);
  return { state: next, layerId };
}

function launchDysonStructure(state: GameState, systemId: StarSystemId, amount: number): void {
  syncLegacySphereIntoPlans(state);
  state.dysonPlans[systemId].structurePoints += Math.max(0, Math.floor(amount));
  state.dysonSphere.totalRocketsLaunched = Math.floor(state.dysonSphere.totalRocketsLaunched + amount);
  reconcileDysonPlan(state.dysonPlans[systemId]);
  updateDysonSphereGeneration(state);
}

function launchDysonSails(state: GameState, systemId: StarSystemId, orbitId: string, amount: number): void {
  if (amount <= 0) return;
  syncLegacySwarmIntoOrbits(state);
  const orbit = state.dysonEngineering.orbitsBySystem[systemId]?.find((candidate) => candidate.id === orbitId);
  if (!orbit) return;
  orbit.sailsInOrbit = Math.floor(orbit.sailsInOrbit + amount);
  orbit.totalLaunched = Math.floor(orbit.totalLaunched + amount);
  orbit.generationKw = orbit.sailsInOrbit * getSolarSailPowerFor(state, systemId);
  aggregateDysonSwarm(state);
}

function updateDysonSphereGeneration(state: GameState): void {
  syncLegacySwarmIntoOrbits(state);
  syncLegacySphereIntoPlans(state);
  state.dysonSphere.structurePoints = Object.values(state.dysonPlans).reduce((sum, plan) => sum + plan.structurePoints, 0);
  state.dysonSphere.shellSails = Object.values(state.dysonPlans).reduce((sum, plan) => sum + plan.shellSails, 0);
  const powerMultiplier = getDysonPowerMultiplier(state);
  state.dysonSphere.generationKw = Math.floor(Object.values(state.dysonPlans).reduce((sum, plan) => {
    const luminosity = getStarLuminosity(state, plan.systemId);
    return sum + (Math.floor(plan.structurePoints) * DYSON_STRUCTURE_POWER_KW +
      Math.floor(plan.shellSails) * DYSON_SHELL_SAIL_POWER_KW) * powerMultiplier * luminosity;
  }, 0));
}

/**
 * Refresh derived Dyson power after a guarded macro settlement changes the
 * persisted sail/structure counters without replaying every launch event.
 */
export function refreshDysonGenerationSnapshot(state: GameState): void {
  syncLegacySwarmIntoOrbits(state);
  for (const [systemId, orbits] of Object.entries(state.dysonEngineering.orbitsBySystem)) {
    for (const orbit of orbits ?? []) {
      orbit.generationKw = Math.max(0, Math.floor(orbit.sailsInOrbit)) *
        getSolarSailPowerFor(state, systemId as StarSystemId);
    }
  }
  aggregateDysonSwarm(state);
  updateDysonSphereGeneration(state);
}

function consumeDysonOrbitSails(state: GameState, systemId: StarSystemId, amount: number): number {
  let remaining = Math.max(0, Math.floor(amount));
  for (const orbit of state.dysonEngineering.orbitsBySystem[systemId] ?? []) {
    if (remaining < 1) break;
    const removed = Math.min(remaining, Math.max(0, Math.floor(orbit.sailsInOrbit)));
    orbit.sailsInOrbit -= removed;
    orbit.generationKw = orbit.sailsInOrbit * getSolarSailPowerFor(state, systemId);
    remaining -= removed;
  }
  aggregateDysonSwarm(state);
  return amount - remaining;
}

function absorbDysonSails(state: GameState, seconds: number): void {
  updateDysonSphereGeneration(state);
  if (!isTechnologyCompleted(state, "dyson_shell") || seconds <= EPSILON) return;
  syncLegacySwarmIntoOrbits(state);
  const absorptionMultiplier = getDysonSailAbsorptionMultiplier(state);
  let totalAbsorbed = 0;
  let aggregateProgress = 0;
  for (const systemId of DYSON_SYSTEM_IDS) {
    const plan = state.dysonPlans[systemId];
    const structurePoints = Math.max(0, Math.floor(plan.structurePoints));
    const capacity = dysonPlanShellCapacity(plan);
    const free = Math.max(0, capacity - Math.max(0, Math.floor(plan.shellSails)));
    const sailsInOrbit = (state.dysonEngineering.orbitsBySystem[systemId] ?? [])
      .reduce((sum, orbit) => sum + Math.max(0, Math.floor(orbit.sailsInOrbit)), 0);
    let progress = Math.max(0, state.dysonEngineering.absorptionProgressBySystem[systemId] ?? 0);
    if (structurePoints < 1 || free < 1 || sailsInOrbit < 1) {
      if (free < 1) progress = 0;
      state.dysonEngineering.absorptionProgressBySystem[systemId] = round(progress % 1, 6);
      aggregateProgress += progress;
      continue;
    }

    const accumulated = progress +
      structurePoints * DYSON_SAIL_ABSORPTION_PER_STRUCTURE_PER_SECOND * absorptionMultiplier * seconds;
    const requested = Math.min(free, sailsInOrbit, Math.floor(accumulated + EPSILON));
    const consumed = consumeDysonOrbitSails(state, systemId, requested);
    if (consumed > 0) {
      plan.shellSails = Math.floor(plan.shellSails + consumed);
      reconcileDysonPlan(plan);
      totalAbsorbed += consumed;
    }
    progress = Math.max(0, accumulated - consumed);
    state.dysonEngineering.absorptionProgressBySystem[systemId] = round(Math.min(0.999999, progress), 6);
    aggregateProgress += progress;
  }
  state.dysonSphere.totalSailsAbsorbed = Math.floor(state.dysonSphere.totalSailsAbsorbed + totalAbsorbed);
  // Keep the legacy field as a compact aggregate for old UI/save readers.
  state.dysonSphere.absorptionProgress = round(Math.min(0.999999, aggregateProgress % 1), 6);
  updateDysonSphereGeneration(state);
}

function totalDysonGenerationKw(state: GameState): number {
  syncLegacySwarmIntoOrbits(state);
  return Math.max(0, state.dysonSwarm.generationKw) + Math.max(0, state.dysonSphere.generationKw);
}

function dysonGenerationForSystem(state: GameState, systemId: StarSystemId): number {
  const swarm = (state.dysonEngineering.orbitsBySystem[systemId] ?? []).reduce((sum, orbit) => sum + Math.max(0, orbit.generationKw), 0);
  const plan = state.dysonPlans[systemId];
  const powerMultiplier = getDysonPowerMultiplier(state);
  const sphere = (Math.max(0, Math.floor(plan.structurePoints)) * DYSON_STRUCTURE_POWER_KW +
    Math.max(0, Math.floor(plan.shellSails)) * DYSON_SHELL_SAIL_POWER_KW) * powerMultiplier * getStarLuminosity(state, systemId);
  return swarm + sphere;
}

function calculateDysonReception(state: GameState, lookup?: SimulationLookupContext): DysonReceptionPlan {
  const receivers = (lookup?.rayReceivers ?? state.entities).filter((entity) =>
    entity.kind === "machine" && entity.buildingId === "ray_receiver" && entity.machineCount > 0 &&
    (entity.recipeId === "ray_power" || entity.recipeId === "critical_photon") && canMachineRun(state, entity));
  const ratedCapacityKw = getRayReceiverCapacityKw(state);
  const receiverCapacityKw = receivers.reduce((sum, entity) => sum + ratedCapacityKw * entity.machineCount, 0);
  const allocationByEntity = new Map<string, number>();
  const efficiencyByEntity = new Map<string, number>();
  const rayPowerByPlanet = new Map<PlanetId, number>();

  const generationBySystem = new Map<StarSystemId, number>();
  const capacityBySystem = new Map<StarSystemId, number>();
  for (const receiver of receivers) {
    const systemId = getPlanet(receiver.planetId).systemId;
    if (!generationBySystem.has(systemId)) generationBySystem.set(systemId, dysonGenerationForSystem(state, systemId));
    capacityBySystem.set(systemId, (capacityBySystem.get(systemId) ?? 0) + ratedCapacityKw * receiver.machineCount);
  }
  const efficiencyBySystem = new Map<StarSystemId, number>();
  for (const systemId of generationBySystem.keys()) {
    const capacity = capacityBySystem.get(systemId) ?? 0;
    efficiencyBySystem.set(systemId, capacity <= EPSILON ? 0 : Math.min(1, (generationBySystem.get(systemId) ?? 0) / capacity));
  }
  for (const receiver of receivers) {
    const systemId = getPlanet(receiver.planetId).systemId;
    const efficiency = efficiencyBySystem.get(systemId) ?? 0;
    const allocationKw = ratedCapacityKw * receiver.machineCount * efficiency;
    allocationByEntity.set(receiver.id, allocationKw);
    efficiencyByEntity.set(receiver.id, efficiency);
    if (receiver.recipeId === "ray_power") {
      rayPowerByPlanet.set(receiver.planetId, (rayPowerByPlanet.get(receiver.planetId) ?? 0) + allocationKw);
    }
  }

  const generationKw = [...generationBySystem.values()].reduce((sum, value) => sum + value, 0);
  const receiverLoadKw = [...allocationByEntity.values()].reduce((sum, value) => sum + value, 0);
  const efficiency = receiverCapacityKw <= EPSILON ? 0 : Math.min(1, receiverLoadKw / receiverCapacityKw);
  state.dysonSwarm.receiverLoadKw = receiverLoadKw;
  return {
    efficiency,
    receiverLoadKw,
    allocationByEntity,
    efficiencyByEntity,
    rayPowerByPlanet,
  };
}

const FUEL_GENERATOR_IDS: BuildingId[] = ["thermal_power_plant", "mini_fusion_power_plant", "artificial_star"];

function isFuelGenerator(entity: FactoryEntity): boolean {
  return Boolean(entity.buildingId && FUEL_GENERATOR_IDS.includes(entity.buildingId));
}

function fuelEnergyAvailable(entity: FactoryEntity): number {
  if (!entity.fuelItemId || !entity.buildingId ||
    !getFuelItemIdsForBuilding(entity.buildingId).includes(entity.fuelItemId)) return 0;
  const energyPerItem = FUEL_ENERGY_MJ[entity.fuelItemId] ?? 0;
  return Math.max(0, entity.fuelRemainingMj ?? 0) +
    Math.floor((entity.inputs[entity.fuelItemId] ?? 0) + EPSILON) * energyPerItem;
}

function fuelGeneratorCapacityForStep(entity: FactoryEntity, seconds: number): number {
  if (!isFuelGenerator(entity) || !entity.buildingId || seconds <= EPSILON) return 0;
  const rated = (getBuilding(entity.buildingId).powerGenerationKw ?? 0) * entity.machineCount;
  const fuelLimited = fuelEnergyAvailable(entity) * getFuelEfficiency(entity.buildingId) * 1000 / seconds;
  return Math.min(rated, fuelLimited);
}

function energyCapacity(entity: FactoryEntity): number {
  return (entity.buildingId ? getBuilding(entity.buildingId).energyCapacityMj ?? 0 : 0) * entity.machineCount;
}

function storedEnergy(entity: FactoryEntity): number {
  return Math.min(energyCapacity(entity), Math.max(0, entity.storedEnergyMj ?? 0));
}

function itemOutputFree(state: GameState, entity: FactoryEntity, itemId: ItemId): number {
  if (!entity.buildingId) return 0;
  const capacity = getEntityOutputCapacity(state, entity);
  return Math.floor(Math.max(0, capacity - (entity.outputs[itemId] ?? 0)) + EPSILON);
}

function accumulatorDischargeCapacityForStep(entity: FactoryEntity, seconds: number): number {
  if (entity.buildingId !== "accumulator" || seconds <= EPSILON) return 0;
  const rated = (getBuilding("accumulator").powerGenerationKw ?? 0) * entity.machineCount;
  return Math.min(rated, storedEnergy(entity) * 1000 / seconds);
}

function accumulatorChargeCapacityForStep(entity: FactoryEntity, seconds: number): number {
  if (entity.buildingId !== "accumulator" || seconds <= EPSILON) return 0;
  const rated = (getBuilding("accumulator").powerChargeKw ?? 0) * entity.machineCount;
  return Math.min(rated, Math.max(0, energyCapacity(entity) - storedEnergy(entity)) * 1000 / seconds);
}

function exchangerDischargeCapacityForStep(state: GameState, entity: FactoryEntity, seconds: number): number {
  if (entity.buildingId !== "energy_exchanger" || entity.energyMode !== "discharge" || seconds <= EPSILON) return 0;
  const activeEnergy = storedEnergy(entity);
  const activeCells = activeEnergy > EPSILON ? 1 : 0;
  const queuedCells = Math.floor((entity.inputs.charged_accumulator ?? 0) + EPSILON);
  const usableCells = Math.min(activeCells + queuedCells, itemOutputFree(state, entity, "accumulator"));
  const availableEnergyMj = usableCells > 0
    ? activeEnergy + Math.max(0, usableCells - activeCells) * ACCUMULATOR_ENERGY_MJ
    : 0;
  const rated = (getBuilding("energy_exchanger").powerGenerationKw ?? 0) * entity.machineCount;
  return Math.min(rated, availableEnergyMj * 1000 / seconds);
}

function exchangerChargeCapacityForStep(state: GameState, entity: FactoryEntity, seconds: number): number {
  if (entity.buildingId !== "energy_exchanger" || entity.energyMode !== "charge" || seconds <= EPSILON) return 0;
  const activeEnergy = storedEnergy(entity);
  const activeCells = activeEnergy > EPSILON ? 1 : 0;
  const queuedCells = Math.floor((entity.inputs.accumulator ?? 0) + EPSILON);
  const usableCells = Math.min(activeCells + queuedCells, itemOutputFree(state, entity, "charged_accumulator"));
  const availableCapacityMj = usableCells > 0
    ? usableCells * ACCUMULATOR_ENERGY_MJ - activeEnergy
    : 0;
  const rated = (getBuilding("energy_exchanger").powerChargeKw ?? 0) * entity.machineCount;
  return Math.min(rated, Math.max(0, availableCapacityMj) * 1000 / seconds);
}

interface PowerCandidate {
  entity: FactoryEntity;
  capacity: number;
}

function allocatePower(candidates: PowerCandidate[], requestedKw: number, outputs: Map<string, number>): number {
  const capacity = candidates.reduce((sum, candidate) => sum + candidate.capacity, 0);
  const allocated = Math.min(Math.max(0, requestedKw), capacity);
  for (const candidate of candidates) {
    outputs.set(candidate.entity.id, capacity > EPSILON ? allocated * candidate.capacity / capacity : 0);
  }
  return allocated;
}

function defaultGenerationPriority(entity: FactoryEntity): PowerPriority {
  if (entity.buildingId === "accumulator") return 1;
  if (entity.buildingId === "energy_exchanger") return 2;
  if (isFuelGenerator(entity)) return 1;
  return 3;
}

function allocatePowerByPriority(candidates: PowerCandidate[], requestedKw: number, outputs: Map<string, number>): number {
  let remaining = Math.max(0, requestedKw);
  let allocated = 0;
  const groups: [PowerCandidate[], PowerCandidate[], PowerCandidate[], PowerCandidate[]] = [[], [], [], []];
  for (const candidate of candidates) {
    groups[candidate.entity.generationPriority ?? defaultGenerationPriority(candidate.entity)].push(candidate);
  }
  for (const priority of [3, 2, 1] as PowerPriority[]) {
    const supplied = allocatePower(groups[priority], remaining, outputs);
    allocated += supplied;
    remaining -= supplied;
    if (remaining <= EPSILON) break;
  }
  return allocated;
}

export function getEntityPowerGridId(entity: FactoryEntity): PowerGridId {
  return entity.powerGridId ?? "grid-a";
}

function gridPowerSources(state: GameState, planetId: PlanetId, gridId: PowerGridId, lookup?: SimulationLookupContext): FactoryEntity[] {
  return lookup?.powerSourcesByPlanetGrid.get(`${planetId}|${gridId}`) ?? state.entities.filter((entity) => entity.planetId === planetId && getEntityPowerGridId(entity) === gridId &&
    (entity.kind === "power" || (entity.buildingId === "ray_receiver" && entity.recipeId === "ray_power")));
}

function powerCoverageLabel(state: GameState, entity: FactoryEntity, lookup?: SimulationLookupContext): string {
  return gridPowerSources(state, entity.planetId, getEntityPowerGridId(entity), lookup).length > 0
    ? "电网供电不足"
    : "电网断电";
}

export function isEntityInPowerCoverage(state: GameState, entity: FactoryEntity, lookup?: SimulationLookupContext): boolean {
  if (entity.kind === "power" || (entity.buildingId === "ray_receiver" && entity.recipeId === "ray_power")) return true;
  return gridPowerSources(state, entity.planetId, getEntityPowerGridId(entity), lookup).length > 0;
}

interface PowerConsumer {
  entity: FactoryEntity;
  demandKw: number;
}

function allocateConsumerPower(consumers: PowerConsumer[], availableKw: number): Map<string, number> {
  const factors = new Map<string, number>();
  let remaining = Math.max(0, availableKw);
  const groups: [PowerConsumer[], PowerConsumer[], PowerConsumer[], PowerConsumer[]] = [[], [], [], []];
  for (const consumer of consumers) groups[consumer.entity.powerPriority ?? 2].push(consumer);
  for (const priority of [3, 2, 1] as PowerPriority[]) {
    const group = groups[priority];
    const demand = group.reduce((sum, consumer) => sum + consumer.demandKw, 0);
    const factor = demand <= EPSILON ? 1 : Math.min(1, remaining / demand);
    for (const consumer of group) factors.set(consumer.entity.id, factor);
    remaining = Math.max(0, remaining - demand * factor);
  }
  return factors;
}

function calculatePower(state: GameState, seconds: number, planetId: PlanetId, gridId: PowerGridId, reception: DysonReceptionPlan, lookup?: SimulationLookupContext, profiler?: SimulationProfiler): PowerPlan {
  let windGenerationKw = 0;
  let solarGenerationKw = 0;
  let geothermalGenerationKw = 0;
  let rayGenerationKw = 0;
  let connectedEntities = 0;
  let disconnectedEntities = 0;
  let disconnectedDemandKw = 0;
  let generatorCount = 0;
  const profile = getPlanetIndustrialProfile(state, planetId);
  const difficultyPowerMultiplier = getDifficultyDefinition(state.settings?.difficulty).powerDemandMultiplier;
  const industrialRecipeSpeed = getRecipeSpeedMultiplier(state, "iron_ingot");
  const matrixResearchSpeed = getRecipeSpeedMultiplier(state, "matrix_research");
  const consumers: PowerConsumer[] = [];
  const fuelCandidates: PowerCandidate[] = [];
  const accumulatorCandidates: PowerCandidate[] = [];
  const exchangerDischargeCandidates: PowerCandidate[] = [];
  const accumulatorChargeCandidates: PowerCandidate[] = [];
  const exchangerChargeCandidates: PowerCandidate[] = [];
  const powerOutputByEntity = new Map<string, number>();
  const powerInputByEntity = new Map<string, number>();
  const factorByEntity = new Map<string, number>();
  const entities = lookup
    ? (lookup.entitiesByPlanetGrid.get(`${planetId}|${gridId}`) ?? [])
    : state.entities;
  const gridCovered = gridPowerSources(state, planetId, gridId, lookup).length > 0;

  for (const entity of entities) {
    if (entity.planetId !== planetId || getEntityPowerGridId(entity) !== gridId) continue;
    const machineRuntime = lookup?.machineRuntimeById.get(entity.id);
    if (entity.kind === "power" && entity.buildingId) {
      generatorCount += entity.machineCount;
      if (isFuelGenerator(entity)) {
        const capacity = fuelGeneratorCapacityForStep(entity, seconds);
        if (capacity > EPSILON) fuelCandidates.push({ entity, capacity });
      } else if (entity.buildingId === "accumulator") {
        const discharge = accumulatorDischargeCapacityForStep(entity, seconds);
        const charge = accumulatorChargeCapacityForStep(entity, seconds);
        if (discharge > EPSILON) accumulatorCandidates.push({ entity, capacity: discharge });
        if (charge > EPSILON) accumulatorChargeCandidates.push({ entity, capacity: charge });
      } else if (entity.buildingId === "energy_exchanger") {
        const discharge = exchangerDischargeCapacityForStep(state, entity, seconds);
        const charge = exchangerChargeCapacityForStep(state, entity, seconds);
        if (discharge > EPSILON) exchangerDischargeCandidates.push({ entity, capacity: discharge });
        if (charge > EPSILON) exchangerChargeCandidates.push({ entity, capacity: charge });
      } else {
        const rated = (getBuilding(entity.buildingId).powerGenerationKw ?? 0) * entity.machineCount;
        const output = entity.buildingId === "solar_panel"
          ? rated * getPlanetSolarPowerMultiplier(state, planetId)
          : entity.buildingId === "geothermal_power_station"
            ? rated * profile.geothermalMultiplier
            : rated * profile.windMultiplier;
        powerOutputByEntity.set(entity.id, output);
        if (entity.buildingId === "solar_panel") solarGenerationKw += output;
        else if (entity.buildingId === "geothermal_power_station") geothermalGenerationKw += output;
        else windGenerationKw += output;
      }
    } else if (entity.buildingId === "ray_receiver") {
      if (entity.recipeId === "ray_power") {
        rayGenerationKw += reception.allocationByEntity.get(entity.id) ?? 0;
        generatorCount += entity.machineCount;
      }
      continue;
    } else if (entity.kind === "vein" && entity.minerCount > 0) {
      if (!gridCovered) {
        disconnectedEntities += 1;
        factorByEntity.set(entity.id, 0);
        const extractor = extractorFor(entity);
        const capacity = getEntityOutputCapacity(state, entity);
        if ((entity.outputs[entity.resourceId!] ?? 0) < capacity - EPSILON) {
          disconnectedDemandKw += (extractor.powerDemandKw ?? 0) * entity.minerCount * difficultyPowerMultiplier;
        }
        continue;
      }
      connectedEntities += 1;
      const extractor = extractorFor(entity);
      const capacity = getEntityOutputCapacity(state, entity);
      if ((entity.outputs[entity.resourceId!] ?? 0) < capacity - EPSILON) {
        consumers.push({ entity, demandKw: (extractor.powerDemandKw ?? 0) * entity.minerCount * difficultyPowerMultiplier });
      }
    } else if (entity.buildingId === "galactic_material_exporter" && entity.galacticExporterPaused === false &&
      Object.keys(ACTIVITY_PROJECT_BY_ITEM).some((itemId) => (entity.inputs[itemId as ItemId] ?? 0) >= 1)) {
      if (!gridCovered) {
        disconnectedEntities += 1;
        factorByEntity.set(entity.id, 0);
        disconnectedDemandKw += (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier;
        continue;
      }
      connectedEntities += 1;
      consumers.push({ entity, demandKw: (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier });
    } else if (entity.buildingId === "construction_center" && constructionAutomationHasDeficit(state)) {
      if (!gridCovered) {
        disconnectedEntities += 1;
        factorByEntity.set(entity.id, 0);
        disconnectedDemandKw += (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier;
        continue;
      }
      connectedEntities += 1;
      consumers.push({ entity, demandKw: (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier });
    } else if (entity.buildingId === "space_station_construction_launcher" &&
      state.systemSpaceStations[getPlanet(entity.planetId).systemId]?.status === "building") {
      if (!gridCovered) {
        disconnectedEntities += 1;
        factorByEntity.set(entity.id, 0);
        disconnectedDemandKw += (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier;
        continue;
      }
      connectedEntities += 1;
      consumers.push({ entity, demandKw: (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier });
    } else if (entity.kind === "station" && (isQuantumStation(entity) ||
      isElevatorStation(entity) && state.systemSpaceStations[getPlanet(entity.planetId).systemId]?.status === "operational")) {
      if (!gridCovered) {
        disconnectedEntities += 1;
        factorByEntity.set(entity.id, 0);
        disconnectedDemandKw += (getBuilding(entity.buildingId!).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier;
        continue;
      }
      connectedEntities += 1;
      consumers.push({ entity, demandKw: (getBuilding(entity.buildingId!).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier });
    } else if (canMachineRun(state, entity, machineRuntime) && entity.buildingId) {
      if (!gridCovered) {
        disconnectedEntities += 1;
        factorByEntity.set(entity.id, 0);
        disconnectedDemandKw += (machineRuntime?.powerDemandProduct ?? (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount) *
          getEntityProliferatorPowerMultiplierForStep(
            state,
            entity,
            seconds,
            machineRuntime,
            machineRuntime?.matrixResearch ? matrixResearchSpeed : industrialRecipeSpeed,
          ) * difficultyPowerMultiplier;
        continue;
      }
      connectedEntities += 1;
      consumers.push({
        entity,
        demandKw: (machineRuntime?.powerDemandProduct ?? (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount) *
          getEntityProliferatorPowerMultiplierForStep(
            state,
            entity,
            seconds,
            machineRuntime,
            machineRuntime?.matrixResearch ? matrixResearchSpeed : industrialRecipeSpeed,
          ) * difficultyPowerMultiplier,
      });
    } else if (entity.kind === "station" && entity.buildingId && stationRouteReady(state, entity, lookup, profiler)) {
      if (!gridCovered) {
        disconnectedEntities += 1;
        factorByEntity.set(entity.id, 0);
        disconnectedDemandKw += (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier;
        continue;
      }
      connectedEntities += 1;
      consumers.push({ entity, demandKw: (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier });
    }
  }

  const connectedDemandKw = consumers.reduce((sum, consumer) => sum + consumer.demandKw, 0);
  const baseGenerationKw = windGenerationKw + solarGenerationKw + geothermalGenerationKw + rayGenerationKw;
  const exchangerCapacityKw = exchangerDischargeCandidates.reduce((sum, candidate) => sum + candidate.capacity, 0);
  const fuelCapacityKw = fuelCandidates.reduce((sum, candidate) => sum + candidate.capacity, 0);
  const accumulatorCapacityKw = accumulatorCandidates.reduce((sum, candidate) => sum + candidate.capacity, 0);
  const generationKw = baseGenerationKw + exchangerCapacityKw + fuelCapacityKw + accumulatorCapacityKw;
  const regularSuppliedKw = Math.min(connectedDemandKw, generationKw);
  const controllerCandidate = state.timeWarp.enabled
    ? (lookup?.entityById.get(state.timeWarp.controllerEntityId ?? "") ?? state.entities.find((entity) => entity.id === state.timeWarp.controllerEntityId))
    : undefined;
  const controller = controllerCandidate && controllerCandidate.buildingId === "time_warp_device" &&
      controllerCandidate.planetId === planetId && getEntityPowerGridId(controllerCandidate) === gridId
    ? controllerCandidate
    : undefined;
  let timeWarpDemandKw = 0;
  let timeWarpAllocatedKw = 0;
  if (controller) {
    const availablePowerKw = Math.max(0, generationKw - regularSuppliedKw);
    const stableMultiplier = getMaximumStableTimeWarpMultiplier(availablePowerKw, state.timeWarp.requestedMultiplier);
    const effectiveMultiplier = stableMultiplier ?? state.settings.simulationSpeed;
    timeWarpDemandKw = getTimeWarpRequiredPowerKw(stableMultiplier ?? TIME_WARP_MINIMUM_MULTIPLIER) ?? TIME_WARP_BASE_POWER_KW;
    timeWarpAllocatedKw = Math.min(availablePowerKw, timeWarpDemandKw);
    state.timeWarp.effectiveMultiplier = effectiveMultiplier;
    state.timeWarp.requiredPowerKw = timeWarpDemandKw;
    state.timeWarp.allocatedPowerKw = timeWarpAllocatedKw;
    controller.powerInputKw = round(timeWarpAllocatedKw, 2);
    controller.powerFactor = timeWarpDemandKw > EPSILON ? round(timeWarpAllocatedKw / timeWarpDemandKw, 4) : 0;
    controller.utilization = stableMultiplier ? 1 : 0;
    controller.productionRate = 0;
    factorByEntity.set(controller.id, timeWarpDemandKw > EPSILON ? Math.min(1, timeWarpAllocatedKw / timeWarpDemandKw) : 0);
    powerInputByEntity.set(controller.id, timeWarpAllocatedKw);
    if (gridCovered) connectedEntities += 1;
    else disconnectedEntities += 1;
  }
  const demandKw = connectedDemandKw + disconnectedDemandKw + timeWarpDemandKw;
  const suppliedKw = regularSuppliedKw + timeWarpAllocatedKw;
  const dispatchCandidates = [...exchangerDischargeCandidates, ...fuelCandidates, ...accumulatorCandidates];
  const missingKw = Math.max(0, suppliedKw - baseGenerationKw);
  allocatePowerByPriority(dispatchCandidates, missingKw, powerOutputByEntity);
  const outputFor = (candidates: PowerCandidate[]) => candidates.reduce((sum, candidate) =>
    sum + (powerOutputByEntity.get(candidate.entity.id) ?? 0), 0);
  const exchangerGenerationKw = outputFor(exchangerDischargeCandidates);
  const accumulatorGenerationKw = outputFor(accumulatorCandidates);
  const allocatedFactors = allocateConsumerPower(consumers, regularSuppliedKw);
  for (const [entityId, factor] of allocatedFactors) factorByEntity.set(entityId, factor);

  let surplusKw = Math.max(0, baseGenerationKw - demandKw);
  const exchangerChargeKw = allocatePower(exchangerChargeCandidates, surplusKw, powerInputByEntity);
  surplusKw -= exchangerChargeKw;
  const accumulatorChargeKw = allocatePower(accumulatorChargeCandidates, surplusKw, powerInputByEntity);
  const fuelOutput = (buildingId: BuildingId) => fuelCandidates.reduce((sum, candidate) =>
    candidate.entity.buildingId === buildingId ? sum + (powerOutputByEntity.get(candidate.entity.id) ?? 0) : sum, 0);

  return {
    gridId,
    generationKw,
    demandKw,
    factor: demandKw <= EPSILON ? 1 : Math.min(1, suppliedKw / demandKw),
    windGenerationKw,
    solarGenerationKw,
    geothermalGenerationKw,
    thermalGenerationKw: fuelOutput("thermal_power_plant"),
    fusionGenerationKw: fuelOutput("mini_fusion_power_plant"),
    artificialStarGenerationKw: fuelOutput("artificial_star"),
    rayGenerationKw,
    storageDischargeKw: exchangerGenerationKw + accumulatorGenerationKw,
    storageChargeKw: exchangerChargeKw + accumulatorChargeKw,
    powerOutputByEntity,
    powerInputByEntity,
    factorByEntity,
    connectedEntities,
    disconnectedEntities,
    generatorCount,
  };
}

function combinePowerPlans(plans: PowerPlan[]): PowerPlan {
  const sum = (select: (plan: PowerPlan) => number) => plans.reduce((total, plan) => total + select(plan), 0);
  const demandKw = sum((plan) => plan.demandKw);
  const suppliedKw = sum((plan) => plan.demandKw * plan.factor);
  const powerOutputByEntity = new Map<string, number>();
  const powerInputByEntity = new Map<string, number>();
  const factorByEntity = new Map<string, number>();
  for (const plan of plans) {
    for (const [entityId, value] of plan.powerOutputByEntity) powerOutputByEntity.set(entityId, value);
    for (const [entityId, value] of plan.powerInputByEntity) powerInputByEntity.set(entityId, value);
    for (const [entityId, value] of plan.factorByEntity) factorByEntity.set(entityId, value);
  }
  return {
    generationKw: sum((plan) => plan.generationKw),
    demandKw,
    factor: demandKw <= EPSILON ? 1 : suppliedKw / demandKw,
    windGenerationKw: sum((plan) => plan.windGenerationKw),
    solarGenerationKw: sum((plan) => plan.solarGenerationKw),
    geothermalGenerationKw: sum((plan) => plan.geothermalGenerationKw),
    thermalGenerationKw: sum((plan) => plan.thermalGenerationKw),
    fusionGenerationKw: sum((plan) => plan.fusionGenerationKw),
    artificialStarGenerationKw: sum((plan) => plan.artificialStarGenerationKw),
    rayGenerationKw: sum((plan) => plan.rayGenerationKw),
    storageDischargeKw: sum((plan) => plan.storageDischargeKw),
    storageChargeKw: sum((plan) => plan.storageChargeKw),
    powerOutputByEntity,
    powerInputByEntity,
    factorByEntity,
    connectedEntities: sum((plan) => plan.connectedEntities),
    disconnectedEntities: sum((plan) => plan.disconnectedEntities),
    generatorCount: sum((plan) => plan.generatorCount),
  };
}

function powerFactorForEntity(power: PowerPlan, entity: FactoryEntity): number {
  return power.factorByEntity.get(entity.id) ?? 1;
}

function burnFuelLegacy(entity: FactoryEntity, outputKw: number, seconds: number): number {
  if (!entity.buildingId || !entity.fuelItemId || outputKw <= EPSILON) return 0;
  const energyPerItem = FUEL_ENERGY_MJ[entity.fuelItemId] ?? 0;
  let requiredHeatMj = outputKw * seconds / (1000 * getFuelEfficiency(entity.buildingId));
  let remainingHeatMj = Math.max(0, entity.fuelRemainingMj ?? 0);
  let loaded = 0;
  while (requiredHeatMj > EPSILON) {
    if (remainingHeatMj <= EPSILON) {
      const queuedFuel = Math.floor((entity.inputs[entity.fuelItemId] ?? 0) + EPSILON);
      if (queuedFuel < 1 || energyPerItem <= EPSILON) break;
      entity.inputs[entity.fuelItemId] = queuedFuel - 1;
      remainingHeatMj += energyPerItem;
      loaded += 1;
    }
    const burned = Math.min(requiredHeatMj, remainingHeatMj);
    requiredHeatMj -= burned;
    remainingHeatMj -= burned;
  }
  entity.fuelRemainingMj = round(Math.max(0, remainingHeatMj), 6);
  return loaded;
}

function burnFuel(entity: FactoryEntity, outputKw: number, seconds: number): number {
  if (!entity.buildingId || !entity.fuelItemId || outputKw <= EPSILON) return 0;
  const energyPerItem = FUEL_ENERGY_MJ[entity.fuelItemId] ?? 0;
  const requiredHeatMj = Math.max(0, outputKw * seconds / (1000 * getFuelEfficiency(entity.buildingId)));
  const initialHeatMj = Math.max(0, entity.fuelRemainingMj ?? 0);
  const queuedFuel = Math.floor((entity.inputs[entity.fuelItemId] ?? 0) + EPSILON);
  if (energyPerItem <= EPSILON) {
    entity.fuelRemainingMj = round(Math.max(0, initialHeatMj - Math.min(requiredHeatMj, initialHeatMj)), 6);
    return 0;
  }
  const heatNeededAfterCurrent = Math.max(0, requiredHeatMj - initialHeatMj);
  const requestedItems = heatNeededAfterCurrent > EPSILON
    ? Math.ceil(Math.max(0, heatNeededAfterCurrent - EPSILON) / energyPerItem)
    : 0;
  const loaded = Math.min(queuedFuel, requestedItems);
  const availableHeatMj = initialHeatMj + loaded * energyPerItem;
  const burnedHeatMj = Math.min(requiredHeatMj, availableHeatMj);
  if (loaded > 0) entity.inputs[entity.fuelItemId] = queuedFuel - loaded;
  entity.fuelRemainingMj = round(Math.max(0, availableHeatMj - burnedHeatMj), 6);
  return loaded;
}

function chargeExchangerLegacy(state: GameState, entity: FactoryEntity, energyMj: number): number {
  let remaining = Math.max(0, energyMj);
  let stored = storedEnergy(entity);
  let completed = 0;
  while (remaining > EPSILON) {
    if (stored <= EPSILON) {
      const queued = Math.floor((entity.inputs.accumulator ?? 0) + EPSILON);
      if (queued < 1 || itemOutputFree(state, entity, "charged_accumulator") < 1) break;
      entity.inputs.accumulator = queued - 1;
    }
    const charged = Math.min(remaining, ACCUMULATOR_ENERGY_MJ - stored);
    stored += charged;
    remaining -= charged;
    if (stored + EPSILON >= ACCUMULATOR_ENERGY_MJ) {
      entity.outputs.charged_accumulator = Math.floor((entity.outputs.charged_accumulator ?? 0) + 1);
      state.totalProduced.charged_accumulator = Math.floor((state.totalProduced.charged_accumulator ?? 0) + 1);
      stored = 0;
      completed += 1;
    }
  }
  entity.storedEnergyMj = round(stored, 6);
  entity.progress = stored / ACCUMULATOR_ENERGY_MJ;
  return completed;
}

function dischargeExchangerLegacy(state: GameState, entity: FactoryEntity, energyMj: number): number {
  let remaining = Math.max(0, energyMj);
  let stored = storedEnergy(entity);
  let completed = 0;
  while (remaining > EPSILON) {
    if (stored <= EPSILON) {
      const queued = Math.floor((entity.inputs.charged_accumulator ?? 0) + EPSILON);
      if (queued < 1 || itemOutputFree(state, entity, "accumulator") < 1) break;
      entity.inputs.charged_accumulator = queued - 1;
      stored = ACCUMULATOR_ENERGY_MJ;
    }
    const discharged = Math.min(remaining, stored);
    stored -= discharged;
    remaining -= discharged;
    if (stored <= EPSILON) {
      entity.outputs.accumulator = Math.floor((entity.outputs.accumulator ?? 0) + 1);
      state.totalProduced.accumulator = Math.floor((state.totalProduced.accumulator ?? 0) + 1);
      stored = 0;
      completed += 1;
    }
  }
  entity.storedEnergyMj = round(stored, 6);
  entity.progress = stored > EPSILON ? 1 - stored / ACCUMULATOR_ENERGY_MJ : 0;
  return completed;
}

function chargeExchanger(state: GameState, entity: FactoryEntity, energyMj: number): number {
  if (energyMj <= EPSILON) return 0;
  const stored = Math.min(ACCUMULATOR_ENERGY_MJ, storedEnergy(entity));
  const activeCells = stored > EPSILON ? 1 : 0;
  const queuedCells = Math.floor((entity.inputs.accumulator ?? 0) + EPSILON);
  const usableCells = Math.min(activeCells + queuedCells, itemOutputFree(state, entity, "charged_accumulator"));
  if (usableCells < 1) return 0;
  const appliedEnergyMj = Math.min(Math.max(0, energyMj), Math.max(0, usableCells * ACCUMULATOR_ENERGY_MJ - stored));
  if (appliedEnergyMj <= EPSILON) return 0;
  const totalEnergyMj = stored + appliedEnergyMj;
  const completed = Math.min(usableCells, Math.floor((totalEnergyMj + EPSILON) / ACCUMULATOR_ENERGY_MJ));
  const remainingEnergyMj = Math.max(0, totalEnergyMj - completed * ACCUMULATOR_ENERGY_MJ);
  const residual = remainingEnergyMj > EPSILON ? remainingEnergyMj : 0;
  const touchedCells = completed + (residual > EPSILON ? 1 : 0);
  const consumedCells = Math.min(queuedCells, Math.max(0, touchedCells - activeCells));
  if (consumedCells > 0) entity.inputs.accumulator = queuedCells - consumedCells;
  entity.outputs.charged_accumulator = Math.floor((entity.outputs.charged_accumulator ?? 0) + completed);
  state.totalProduced.charged_accumulator = Math.floor((state.totalProduced.charged_accumulator ?? 0) + completed);
  entity.storedEnergyMj = round(residual, 6);
  entity.progress = residual / ACCUMULATOR_ENERGY_MJ;
  return completed;
}

function dischargeExchanger(state: GameState, entity: FactoryEntity, energyMj: number): number {
  if (energyMj <= EPSILON) return 0;
  const stored = Math.min(ACCUMULATOR_ENERGY_MJ, storedEnergy(entity));
  const activeCells = stored > EPSILON ? 1 : 0;
  const queuedCells = Math.floor((entity.inputs.charged_accumulator ?? 0) + EPSILON);
  const usableCells = Math.min(activeCells + queuedCells, itemOutputFree(state, entity, "accumulator"));
  if (usableCells < 1) return 0;
  const availableEnergyMj = stored + Math.max(0, usableCells - activeCells) * ACCUMULATOR_ENERGY_MJ;
  const appliedEnergyMj = Math.min(Math.max(0, energyMj), availableEnergyMj);
  if (appliedEnergyMj <= EPSILON) return 0;
  const energyNeededAfterCurrent = Math.max(0, appliedEnergyMj - stored);
  const loadedCells = Math.min(queuedCells, energyNeededAfterCurrent > EPSILON
    ? Math.ceil(Math.max(0, energyNeededAfterCurrent - EPSILON) / ACCUMULATOR_ENERGY_MJ)
    : 0);
  const remainingEnergyMj = Math.max(0, stored + loadedCells * ACCUMULATOR_ENERGY_MJ - appliedEnergyMj);
  const residual = remainingEnergyMj > EPSILON ? remainingEnergyMj : 0;
  const completed = Math.max(0, activeCells + loadedCells - (residual > EPSILON ? 1 : 0));
  if (loadedCells > 0) entity.inputs.charged_accumulator = queuedCells - loadedCells;
  entity.outputs.accumulator = Math.floor((entity.outputs.accumulator ?? 0) + completed);
  state.totalProduced.accumulator = Math.floor((state.totalProduced.accumulator ?? 0) + completed);
  entity.storedEnergyMj = round(residual, 6);
  entity.progress = residual > EPSILON ? 1 - residual / ACCUMULATOR_ENERGY_MJ : 0;
  return completed;
}

function runPowerFacilities(
  state: GameState,
  seconds: number,
  power: PowerPlan,
  planetId: PlanetId,
  entities = state.entities,
  batchPowerStorage = true,
  profiler?: SimulationProfiler,
): void {
  for (const entity of entities) {
    if (entity.planetId !== planetId || entity.kind !== "power" || !entity.buildingId) continue;
    const outputKw = power.powerOutputByEntity.get(entity.id) ?? 0;
    const inputKw = power.powerInputByEntity.get(entity.id) ?? 0;
    const building = getBuilding(entity.buildingId);
    const ratedKw = (building.powerGenerationKw ?? 0) * entity.machineCount;
    entity.powerOutputKw = round(outputKw, 2);
    entity.powerInputKw = round(inputKw, 2);
    entity.utilization = ratedKw > EPSILON ? round(Math.max(outputKw, inputKw) / ratedKw, 4) : 0;
    entity.productionRate = 0;

    if (isFuelGenerator(entity)) {
      const loaded = batchPowerStorage
        ? burnFuel(entity, outputKw, seconds)
        : burnFuelLegacy(entity, outputKw, seconds);
      if (profiler) profiler.fuelItemsLoaded += loaded;
    } else if (entity.buildingId === "accumulator") {
      const capacity = energyCapacity(entity);
      entity.storedEnergyMj = round(Math.min(capacity, Math.max(0,
        storedEnergy(entity) + inputKw * seconds / 1000 - outputKw * seconds / 1000)), 6);
      entity.progress = capacity > EPSILON ? entity.storedEnergyMj / capacity : 0;
    } else if (entity.buildingId === "energy_exchanger") {
      const completed = entity.energyMode === "discharge"
        ? batchPowerStorage
          ? dischargeExchanger(state, entity, outputKw * seconds / 1000)
          : dischargeExchangerLegacy(state, entity, outputKw * seconds / 1000)
        : batchPowerStorage
          ? chargeExchanger(state, entity, inputKw * seconds / 1000)
          : chargeExchangerLegacy(state, entity, inputKw * seconds / 1000);
      if (profiler) profiler.exchangerCellsSettled += completed;
      entity.productionRate = seconds > EPSILON ? round(completed * 60 / seconds, 2) : 0;
    }
  }
}

function fuelReserveSeconds(state: GameState, planetId: PlanetId, gridId?: PowerGridId, lookup?: SimulationLookupContext): number {
  let electricEnergyMj = 0;
  let ratedGeneratorKw = 0;
  const entities = lookup ? (lookup.entitiesByPlanet.get(planetId) ?? []) : state.entities;
  for (const entity of entities) {
    if (entity.planetId !== planetId || (gridId && getEntityPowerGridId(entity) !== gridId) || !isFuelGenerator(entity) || !entity.buildingId) continue;
    electricEnergyMj += fuelEnergyAvailable(entity) * getFuelEfficiency(entity.buildingId);
    ratedGeneratorKw += (getBuilding(entity.buildingId).powerGenerationKw ?? 0) * entity.machineCount;
  }
  return ratedGeneratorKw > EPSILON ? round(electricEnergyMj * 1000 / ratedGeneratorKw, 1) : 0;
}

function gridStoredEnergy(state: GameState, planetId: PlanetId, gridId?: PowerGridId, lookup?: SimulationLookupContext): { stored: number; capacity: number } {
  const entities = lookup ? (lookup.entitiesByPlanet.get(planetId) ?? []) : state.entities;
  return entities.reduce((total, entity) => {
    if (entity.planetId !== planetId || (gridId && getEntityPowerGridId(entity) !== gridId) ||
      (entity.buildingId !== "accumulator" && entity.buildingId !== "energy_exchanger")) return total;
    total.stored += storedEnergy(entity);
    total.capacity += energyCapacity(entity);
    return total;
  }, { stored: 0, capacity: 0 });
}

function transferLogisticsBuffers(state: GameState, lookup?: SimulationLookupContext): void {
  if (lookup) {
    for (const { entity, itemId, capacity } of lookup.logisticsBufferRuntimes) {
      if (entity.kind === "station" && entity.buildingId !== "orbital_collector" && !entity.stationSlots) ensureStationSlots(entity);
      const incoming = Math.floor((entity.inputs[itemId] ?? 0) + EPSILON);
      const stored = Math.floor((entity.outputs[itemId] ?? 0) + EPSILON);
      const moved = Math.min(incoming, Math.max(0, capacity - stored));
      entity.inputs[itemId] = incoming - moved;
      entity.outputs[itemId] = stored + moved;
      if (isQuantumStation(entity)) flushQuantumSupplyBuffer(state, entity, itemId, lookup);
    }
    return;
  }
  for (const entity of state.entities) {
    if ((entity.kind !== "storage" && entity.kind !== "splitter" && entity.kind !== "station") || !entity.buildingId) continue;
    if (entity.buildingId === "material_delivery_hub") continue;
    if (isElevatorStation(entity)) continue;
    const slots = entity.kind === "station" && entity.buildingId !== "orbital_collector"
      ? ensureStationSlots(entity).filter((slot): slot is StationSlot & { itemId: ItemId } => Boolean(slot.itemId))
      : entity.storedItemId ? [{ ...emptyStationSlot(), itemId: entity.storedItemId }] : [];
    for (const slot of slots) {
      const capacity = entity.kind === "station"
        ? getStationSlotCapacity(state, entity, slot)
        : getEntityOutputCapacity(state, entity);
      const incoming = Math.floor((entity.inputs[slot.itemId] ?? 0) + EPSILON);
      const stored = Math.floor((entity.outputs[slot.itemId] ?? 0) + EPSILON);
      const moved = Math.min(incoming, Math.max(0, capacity - stored));
      entity.inputs[slot.itemId] = incoming - moved;
      entity.outputs[slot.itemId] = stored + moved;
      if (isQuantumStation(entity)) flushQuantumSupplyBuffer(state, entity, slot.itemId, lookup);
    }
  }
}

function drainMaterialDeliveryHubs(state: GameState, seconds: number, lookup?: SimulationLookupContext): void {
  for (const entity of lookup?.materialDeliveryHubs ?? state.entities) {
    if (entity.buildingId !== "material_delivery_hub") continue;
    let delivered = 0;
    for (const itemId of getMaterialDeliveryItems(entity)) {
      const amount = Math.max(0, Math.floor((entity.inputs[itemId] ?? 0) + EPSILON));
      if (amount < 1) continue;
      const moved = storeInPlanetTray(state, entity.planetId, itemId, amount);
      entity.inputs[itemId] = amount - moved;
      delivered += moved;
    }
    entity.utilization = delivered > 0 ? 1 : 0;
    entity.productionRate = seconds > EPSILON ? round(delivered * 60 / seconds, 2) : 0;
    entity.progress = delivered > 0 ? 1 : 0;
  }
}

interface BeltTransferCandidate {
  belt: BeltConnection;
  target: FactoryEntity;
  targetCapacity: { free: number };
  allowance: number;
  moved: number;
  capacity: number;
  stableSourceOrder: number;
  runtimeEpoch: number;
}

interface RuntimeSourceAvailabilityLedger {
  epoch: number;
  available: number;
  reserved: number;
}

interface RuntimeTargetCapacityLedger {
  epoch: number;
  free: number;
}

interface RuntimeBeltTransferGroup {
  source: FactoryEntity;
  itemId: ItemId;
  available: number;
  reserved: number;
  candidates: BeltTransferCandidate[];
  runtimeEpoch?: number;
}

function beltHasRuntimeSignal(belt: BeltConnection): boolean {
  return Math.abs(belt.progress ?? 0) > EPSILON || Math.abs(belt.lastFlow ?? 0) > EPSILON ||
    Math.abs(belt.congestion ?? 0) > EPSILON;
}

function beltTargetCapacityKey(target: FactoryEntity, itemId: ItemId, portIndex?: 0 | 1 | 2): string {
  return target.buildingId === "material_delivery_hub"
    ? `tray:${target.planetId}:${itemId}`
    : `${target.id}:${itemId}:${portIndex ?? -1}`;
}

function beltSourceMayProduceDuringStep(source: FactoryEntity, itemId: ItemId): boolean {
  if (source.kind === "vein") return source.resourceId === itemId;
  if (getRecipe(source.recipeId)?.outputs.some((output) => output.itemId === itemId)) return true;
  return source.buildingId === "orbital_collector" || source.buildingId === "energy_exchanger" ||
    (source.kind === "station" && isQuantumStation(source));
}

function activeBeltSettlementRoutes(
  lookup: SimulationLookupContext,
  seconds: number,
  allowanceCaps?: ReadonlyMap<string, number>,
): { routes: IndexedBeltRoute[]; groupKeys: Set<string> } {
  const allowanceGroupKeys = new Set<string>();
  if (allowanceCaps) {
    for (const beltId of allowanceCaps.keys()) {
      const key = lookup.beltRuntime.groupKeyByBeltId.get(beltId);
      if (key) allowanceGroupKeys.add(key);
    }
  }
  const routes: IndexedBeltRoute[] = [];
  const groupKeys = new Set<string>();
  for (const group of lookup.beltRuntime.routeGroups) {
    const sourceAmount = group.source?.outputs[group.itemId] ?? 0;
    const active = sourceAmount > EPSILON || lookup.beltRuntime.activeGroupKeys.has(group.key) ||
      allowanceGroupKeys.has(group.key) || (seconds > 0 && group.potentiallyProduces);
    if (!active) continue;
    groupKeys.add(group.key);
    routes.push(...group.routes);
  }
  return { routes, groupKeys };
}

function refreshActiveBeltGroups(lookup: SimulationLookupContext, groupKeys: ReadonlySet<string>): void {
  for (const key of groupKeys) {
    const group = lookup.beltRuntime.routeGroupByKey.get(key);
    if (!group) continue;
    if (group.routes.some((route) => beltHasRuntimeSignal(route.belt))) lookup.beltRuntime.activeGroupKeys.add(key);
    else lookup.beltRuntime.activeGroupKeys.delete(key);
  }
}

function targetFreeCapacity(state: GameState, target: FactoryEntity, itemId: ItemId, targetPortIndex?: 0 | 1 | 2, lookup?: SimulationLookupContext): number {
  if (!target.buildingId) return 0;
  if (target.buildingId === "micro_black_hole_connector") {
    if (target.blackHolePaused !== false || !target.blackHoleActivationConfirmed || targetPortIndex === undefined) return 0;
    return Number.MAX_SAFE_INTEGER;
  }
  if (target.buildingId === "material_delivery_hub") {
    if (resolveMaterialDeliverySlotIndex(target, itemId, targetPortIndex) === undefined) return 0;
    const pendingEntities = lookup?.entitiesByPlanet.get(target.planetId) ?? state.entities;
    const pending = pendingEntities.reduce((sum, entity) => entity.planetId === target.planetId && entity.buildingId === "material_delivery_hub"
      ? sum + Math.max(0, Math.floor(entity.inputs[itemId] ?? 0))
      : sum, 0);
    return Math.floor(Math.max(0, getPlanetTrayItemFreeCapacity(state, target.planetId, itemId) - pending) + EPSILON);
  }
  if (quantumSupplySlot(target, itemId)) {
    return Math.max(0, quantumSupplyFreeCapacity(state, target, itemId, lookup) - stationInFlightCargo(target, itemId, lookup));
  }
  const capacity = getEntityItemInputCapacity(state, target, itemId);
  return Math.floor(Math.max(0, capacity - (target.inputs[itemId] ?? 0)) + EPSILON);
}

function staticBeltTargetInputCapacity(state: GameState, target: FactoryEntity, itemId: ItemId): number | undefined {
  if (target.buildingId === "material_delivery_hub" || target.buildingId === "micro_black_hole_connector" || isQuantumStation(target)) return undefined;
  return getEntityItemInputCapacity(state, target, itemId);
}

function createIndexedBeltRoutes(state: GameState, sorted = false): IndexedBeltRoute[] {
  const entityById = new Map(state.entities.map((entity) => [entity.id, entity]));
  const belts = sorted ? [...state.belts].sort((left, right) => left.id.localeCompare(right.id)) : state.belts;
  return belts.map((belt) => {
    const source = entityById.get(belt.source);
    const target = entityById.get(belt.target);
    return {
      belt,
      source,
      target,
      capacity: getBeltCapacity(belt),
      compatible: Boolean(source && target && source.planetId === target.planetId && belt.planetId === source.planetId &&
        sourceProduces(source, belt.itemId) && targetConsumes(state, target, belt.itemId, belt.targetPortIndex)),
      targetInputCapacity: target ? staticBeltTargetInputCapacity(state, target, belt.itemId) : undefined,
    } satisfies IndexedBeltRoute;
  });
}

function transferBelts(
  state: GameState,
  seconds: number,
  deferSourceDepletionReset = false,
  allowanceCaps?: ReadonlyMap<string, number>,
  flowWindowSeconds = seconds,
  lookup?: SimulationLookupContext,
  skippedBeltIds?: ReadonlySet<string>,
  profiler?: SimulationProfiler,
): void {
  const runtimeEpoch = lookup ? ++lookup.beltRuntime.settlementEpoch : 0;
  const distributionEntries: Array<IndexedBeltRoute | RuntimeBeltTransferGroup> = lookup
    ? lookup.beltRuntime.settlementEntries
    : [];
  if (!lookup) distributionEntries.length = 0;
  const fallbackGroups = new Map<string, RuntimeBeltTransferGroup>();
  const indexedSourceAvailability = lookup?.beltRuntime.sourceAvailabilityLedgers ?? [];
  // A candidate reads its capacity ledger many times during fair routing.
  // Resolve the target once, then share the mutable ledger between belts that
  // feed the same slot. This avoids millions of capacity calls without doing
  // a Map lookup in the inner distribution loop.
  const indexedTargetCapacityLedgers = lookup?.beltRuntime.targetCapacityLedgers ?? [];
  const fallbackTargetCapacityLedgers = new Map<string, { free: number }>();
  const targetCapacity = (route: IndexedBeltRoute, target: FactoryEntity, itemId: ItemId, portIndex?: 0 | 1 | 2): { free: number } => {
    if (profiler) profiler.beltTargetChecks += 1;
    const index = route.targetCapacityIndex;
    if (index !== undefined) {
      const cached = indexedTargetCapacityLedgers[index];
      if (cached?.epoch === runtimeEpoch) return cached;
      const free = route.targetInputCapacity === undefined
        ? targetFreeCapacity(state, target, itemId, portIndex, lookup)
        : Math.floor(Math.max(0, route.targetInputCapacity - (target.inputs[itemId] ?? 0)) + EPSILON);
      const ledger = cached ?? { epoch: runtimeEpoch, free: 0 };
      ledger.epoch = runtimeEpoch;
      ledger.free = Math.max(0, free);
      indexedTargetCapacityLedgers[index] = ledger;
      return ledger;
    }
    const key = beltTargetCapacityKey(target, itemId, portIndex);
    const cached = fallbackTargetCapacityLedgers.get(key);
    if (cached) return cached;
    const free = route.targetInputCapacity === undefined
      ? targetFreeCapacity(state, target, itemId, portIndex, lookup)
      : Math.floor(Math.max(0, route.targetInputCapacity - (target.inputs[itemId] ?? 0)) + EPSILON);
    const ledger = { free: Math.max(0, free) };
    fallbackTargetCapacityLedgers.set(key, ledger);
    return ledger;
  };
  // These decay factors depend only on the simulation window. Compute them
  // once instead of once per belt; the persisted rounding behavior is intact.
  const flowDecay = Math.pow(0.8, Math.max(0, seconds));
  const congestionDecay = Math.pow(0.85, Math.max(0, seconds));

  if (lookup?.beltRuntime.activeQueueEnabled) {
    for (const planetRuntime of lookup.beltRuntime.byPlanet.values()) {
      planetRuntime.activeBelts.clear();
      planetRuntime.blockedBelts.clear();
      planetRuntime.inputStarvedBelts.clear();
      planetRuntime.outputFullBelts.clear();
      planetRuntime.powerLimitedBelts.clear();
    }
  }
  const activeSelection = lookup?.beltRuntime.activeQueueEnabled
    ? activeBeltSettlementRoutes(lookup, seconds, allowanceCaps)
    : null;
  const routes = activeSelection?.routes ?? lookup?.beltRoutes ?? createIndexedBeltRoutes(state);
  if (profiler) {
    profiler.beltRouteChecks += routes.length;
    profiler.beltStableRoutesSkipped += Math.max(0, (lookup?.beltRoutes.length ?? routes.length) - routes.length);
  }
  const scanStartedAt = profiler ? profileNow() : 0;
  for (const route of routes) {
    const belt = route.belt;
    if (skippedBeltIds?.has(belt.id)) continue;
    const planetRuntime = lookup?.beltRuntime.activeQueueEnabled
      ? lookup.beltRuntime.byPlanet.get(belt.planetId)
      : undefined;
    planetRuntime?.activeBelts.add(belt.id);
    belt.lastFlow = roundBeltMetric(belt.lastFlow * flowDecay);
    belt.congestion = roundBeltMetric((belt.congestion ?? 0) * congestionDecay);
    const source = route.source;
    const target = route.target;
    if (!route.compatible || !source || !target) {
      belt.progress = 0;
      planetRuntime?.blockedBelts.add(belt.id);
      continue;
    }
    const capacity = route.capacity;
    if (seconds > 0) {
      const currentCredit = Math.max(0, belt.progress ?? 0);
      const creditLimit = normalizeBuildingBufferLimit(state.settings.beltBufferLimit);
      belt.progress = round(currentCredit > creditLimit
        ? currentCredit
        : Math.min(creditLimit, currentCredit + capacity * seconds));
    }
    const groupIndex = route.sourceGroupIndex;
    let sourceAvailability = groupIndex === undefined ? undefined : indexedSourceAvailability[groupIndex];
    if (!sourceAvailability || sourceAvailability.epoch !== runtimeEpoch) {
      const reserved = stationReservedOutgoing(state, source.id, belt.itemId, lookup);
      sourceAvailability ??= { epoch: runtimeEpoch, available: 0, reserved: 0 };
      sourceAvailability.epoch = runtimeEpoch;
      sourceAvailability.available = Math.floor((source.outputs[belt.itemId] ?? 0) - reserved + EPSILON);
      sourceAvailability.reserved = reserved;
      if (groupIndex !== undefined) indexedSourceAvailability[groupIndex] = sourceAvailability;
    }
    const available = sourceAvailability.available;
    if (available < 1) {
      if (!deferSourceDepletionReset) belt.progress = 0;
      planetRuntime?.inputStarvedBelts.add(belt.id);
      if (beltSourceMayProduceDuringStep(source, belt.itemId) && (source.powerFactor ?? 1) <= EPSILON) planetRuntime?.powerLimitedBelts.add(belt.id);
      continue;
    }
    const remainingTarget = targetCapacity(route, target, belt.itemId, belt.targetPortIndex);
    if (remainingTarget.free < 1) {
      belt.progress = 0;
      planetRuntime?.blockedBelts.add(belt.id);
      planetRuntime?.outputFullBelts.add(belt.id);
      continue;
    }
    const allowance = Math.min(Math.floor(belt.progress + EPSILON), allowanceCaps?.get(belt.id) ?? Number.MAX_SAFE_INTEGER);
    if (lookup && groupIndex !== undefined && lookup.beltRuntime.routeGroups[groupIndex]?.routes.length === 1) {
      route.runtimeTargetCapacity = remainingTarget;
      route.runtimeAllowance = allowance;
      route.runtimeEpoch = runtimeEpoch;
      continue;
    }
    let group: RuntimeBeltTransferGroup | undefined;
    if (groupIndex !== undefined && lookup) {
      const indexedGroup = lookup.beltRuntime.routeGroups[groupIndex];
      group = indexedGroup.runtimeGroup;
      if (!group) {
        group = { source, itemId: belt.itemId, available, reserved: sourceAvailability.reserved, candidates: [] };
        indexedGroup.runtimeGroup = group;
      }
      if (indexedGroup.runtimeEpoch !== runtimeEpoch) {
        indexedGroup.runtimeEpoch = runtimeEpoch;
        group.source = source;
        group.itemId = belt.itemId;
        group.available = available;
        group.reserved = sourceAvailability.reserved;
        group.candidates.length = 0;
        group.runtimeEpoch = runtimeEpoch;
      }
    } else {
      group = fallbackGroups.get(`${belt.source}:${belt.itemId}`);
      if (!group) {
        group = { source, itemId: belt.itemId, available, reserved: sourceAvailability.reserved, candidates: [], runtimeEpoch };
        fallbackGroups.set(`${belt.source}:${belt.itemId}`, group);
        distributionEntries.push(group);
      }
    }
    let candidate = route.runtimeCandidate;
    if (!candidate) {
      candidate = {
        belt,
        target,
        targetCapacity: remainingTarget,
        allowance,
        moved: 0,
        capacity,
        stableSourceOrder: route.stableSourceOrder ?? 0,
        runtimeEpoch,
      };
      if (lookup) route.runtimeCandidate = candidate;
    } else {
      candidate.target = target;
      candidate.targetCapacity = remainingTarget;
      candidate.allowance = allowance;
      candidate.moved = 0;
      candidate.runtimeEpoch = runtimeEpoch;
    }
    group.candidates.push(candidate);
  }
  if (profiler) profiler.beltScanMs += profileNow() - scanStartedAt;

  const distributeStartedAt = profiler ? profileNow() : 0;
  const receiveRoute = (belt: BeltConnection, target: FactoryEntity, itemId: ItemId, amount: number): number => {
    const moved = Math.max(0, Math.floor(amount));
    if (moved < 1) return 0;
    if (isQuantumStation(target) && quantumSupplySlot(target, itemId)) {
      return receiveQuantumSupplyMaterial(state, target, itemId, moved);
    }
    if (target.buildingId !== "micro_black_hole_connector") {
      target.inputs[itemId] = Math.floor((target.inputs[itemId] ?? 0) + moved);
      return moved;
    }
    const portIndex = belt.targetPortIndex;
    const port = target.blackHolePorts?.find((entry) => entry.index === portIndex);
    if (!port || target.blackHolePaused !== false || !target.blackHoleActivationConfirmed) return 0;
    try {
      port.currentItemId = itemId;
      port.totalDestroyed = (BigInt(port.totalDestroyed || "0") + BigInt(moved)).toString();
      return moved;
    } catch {
      return 0;
    }
  };
  const receive = (candidate: BeltTransferCandidate, itemId: ItemId, amount: number): number =>
    receiveRoute(candidate.belt, candidate.target, itemId, amount);

  const candidateUsable = (candidate: BeltTransferCandidate) => candidate.allowance > 0 &&
    candidate.targetCapacity.free > 0;
  const distributeFairLegacy = (
    group: RuntimeBeltTransferGroup,
    requestedCandidates: BeltTransferCandidate[],
    startingAvailable: number,
  ): number => {
    let available = startingAvailable;
    if (requestedCandidates.length === 1) {
      const candidate = requestedCandidates[0];
      if (!candidateUsable(candidate) || available <= 0) return available;
      const requested = Math.min(available, candidate.allowance, candidate.targetCapacity.free);
      const moved = receive(candidate, group.itemId, requested);
      if (moved <= 0) return available;
      candidate.targetCapacity.free = Math.max(0, candidate.targetCapacity.free - moved);
      candidate.allowance -= moved;
      candidate.moved += moved;
      available -= moved;
      group.source.routingCursor = 0;
      return available;
    }
    const candidates = requestedCandidates.filter(candidateUsable).sort((left, right) => left.belt.id.localeCompare(right.belt.id));
    if (candidates.length === 0) return available;
    let cursor = group.source.routingCursor % candidates.length;
    while (available > 0) {
      const active = candidates.filter(candidateUsable);
      if (active.length === 0) break;
      const rotated = [...active.slice(cursor % active.length), ...active.slice(0, cursor % active.length)];
      const fairShare = Math.max(1, Math.floor(available / active.length));
      let successful = 0;
      for (const candidate of rotated) {
        if (available <= 0) break;
        const requested = Math.min(
          available,
          fairShare,
          candidate.allowance,
          candidate.targetCapacity.free,
        );
        const moved = receive(candidate, group.itemId, requested);
        if (moved <= 0) continue;
        candidate.targetCapacity.free = Math.max(0, candidate.targetCapacity.free - moved);
        candidate.allowance -= moved;
        candidate.moved += moved;
        available -= moved;
        successful += 1;
        cursor = (cursor + 1) % candidates.length;
      }
      if (successful === 0) break;
    }
    group.source.routingCursor = cursor;
    return available;
  };

  /** Indexed equivalent of the legacy fair allocator with one reusable round buffer. */
  const distributeFairIndexed = (
    group: RuntimeBeltTransferGroup,
    orderedCandidates: BeltTransferCandidate[],
    startingAvailable: number,
  ): number => {
    let available = startingAvailable;
    const candidates = orderedCandidates.filter(candidateUsable);
    if (candidates.length === 0 || available <= 0) return available;
    if (candidates.length === 1) {
      const candidate = candidates[0];
      const requested = Math.min(available, candidate.allowance, candidate.targetCapacity.free);
      const moved = receive(candidate, group.itemId, requested);
      if (moved <= 0) return available;
      candidate.targetCapacity.free = Math.max(0, candidate.targetCapacity.free - moved);
      candidate.allowance -= moved;
      candidate.moved += moved;
      group.source.routingCursor = 0;
      return available - moved;
    }
    let cursor = group.source.routingCursor % candidates.length;
    const active: BeltTransferCandidate[] = [];
    while (available > 0) {
      active.length = 0;
      for (const candidate of candidates) if (candidateUsable(candidate)) active.push(candidate);
      if (active.length === 0) break;
      const start = cursor % active.length;
      const fairShare = Math.max(1, Math.floor(available / active.length));
      let successful = 0;
      // Legacy uses a rotated snapshot. Shared target ledgers may become full
      // during the round, but the iteration order itself must not change.
      for (let offset = 0; offset < active.length; offset += 1) {
        if (available <= 0) break;
        const candidate = active[(start + offset) % active.length];
        const requested = Math.min(available, fairShare, candidate.allowance, candidate.targetCapacity.free);
        const moved = receive(candidate, group.itemId, requested);
        if (moved <= 0) continue;
        candidate.targetCapacity.free = Math.max(0, candidate.targetCapacity.free - moved);
        candidate.allowance -= moved;
        candidate.moved += moved;
        available -= moved;
        successful += 1;
        cursor = (cursor + 1) % candidates.length;
      }
      if (successful === 0) break;
    }
    group.source.routingCursor = cursor;
    return available;
  };

  for (const entry of distributionEntries) {
    if ("belt" in entry) {
      const route = entry;
      if (lookup && route.runtimeEpoch !== runtimeEpoch) continue;
      const belt = route.belt;
      const source = route.source!;
      const target = route.target!;
      const sourceAvailability = indexedSourceAvailability[route.sourceGroupIndex!]!;
      const targetCapacity = route.runtimeTargetCapacity!;
      const reserved = sourceAvailability.reserved;
      let available = sourceAvailability.available;
      const allowance = route.runtimeAllowance ?? 0;
      let moved = 0;
      if (allowance > 0 && targetCapacity.free > 0 && available > 0) {
        moved = receiveRoute(belt, target, belt.itemId, Math.min(available, allowance, targetCapacity.free));
        if (moved > 0) {
          targetCapacity.free = Math.max(0, targetCapacity.free - moved);
          available -= moved;
          source.routingCursor = 0;
        }
      }
      source.outputs[belt.itemId] = available + reserved;
      belt.progress = (!deferSourceDepletionReset && available <= 0) || targetCapacity.free <= 0
        ? 0
        : round(Math.max(0, belt.progress - moved));
      if (moved > 0) {
        if (flowWindowSeconds > 0) {
          belt.lastFlow = roundBeltMetric(Math.min(
            route.capacity,
            (seconds > 0 ? 0 : belt.lastFlow) + moved / flowWindowSeconds,
          ));
        }
        belt.totalTransferred = Math.floor((belt.totalTransferred ?? 0) + moved);
      }
      const sourceWaiting = (source.outputs[belt.itemId] ?? 0) > 0;
      const targetBlocked = targetCapacity.free <= 0;
      const load = route.capacity > EPSILON ? belt.lastFlow / route.capacity : 0;
      belt.congestion = roundBeltMetric(Math.min(1, Math.max(load, sourceWaiting && targetBlocked ? 1 : 0)));
      continue;
    }
    const group = entry;
    if (lookup && group.runtimeEpoch !== runtimeEpoch) continue;
    const reserved = group.reserved;
    let available = group.available;

    if (lookup) {
      group.candidates.sort((left, right) => left.stableSourceOrder - right.stableSourceOrder || left.belt.id.localeCompare(right.belt.id));
      if (group.candidates.length === 1 || group.source.kind === "splitter" && group.source.distributionMode !== "priority") {
        available = distributeFairIndexed(group, group.candidates, available);
      } else {
        const byPriority: [BeltTransferCandidate[], BeltTransferCandidate[], BeltTransferCandidate[]] = [[], [], []];
        for (const candidate of group.candidates) byPriority[candidate.belt.priority].push(candidate);
        for (const priority of [2, 1, 0] as const) {
          available = distributeFairIndexed(group, byPriority[priority], available);
          if (available <= 0) break;
        }
      }
    } else if (group.candidates.length === 1) {
      available = distributeFairLegacy(group, group.candidates, available);
    } else if (group.source.kind === "splitter" && group.source.distributionMode !== "priority") {
      available = distributeFairLegacy(group, group.candidates, available);
    } else {
      for (const priority of [2, 1, 0] as const) {
        available = distributeFairLegacy(group, group.candidates.filter((candidate) => candidate.belt.priority === priority), available);
        if (available <= 0) break;
      }
    }

    group.source.outputs[group.itemId] = available + reserved;
    for (const candidate of group.candidates) {
      candidate.belt.progress = (!deferSourceDepletionReset && available <= 0) ||
        candidate.targetCapacity.free <= 0
        ? 0
        : round(Math.max(0, candidate.belt.progress - candidate.moved));
      if (candidate.moved > 0) {
        if (flowWindowSeconds > 0) {
          candidate.belt.lastFlow = roundBeltMetric(Math.min(
            candidate.capacity,
            (seconds > 0 ? 0 : candidate.belt.lastFlow) + candidate.moved / flowWindowSeconds,
          ));
        }
        candidate.belt.totalTransferred = Math.floor((candidate.belt.totalTransferred ?? 0) + candidate.moved);
      }
      const sourceWaiting = (group.source.outputs[group.itemId] ?? 0) > 0;
      const targetBlocked = candidate.targetCapacity.free <= 0;
      const load = candidate.capacity > EPSILON ? candidate.belt.lastFlow / candidate.capacity : 0;
      candidate.belt.congestion = roundBeltMetric(Math.min(1, Math.max(load, sourceWaiting && targetBlocked ? 1 : 0)));
    }
  }
  if (profiler) profiler.beltDistributeMs += profileNow() - distributeStartedAt;
  if (lookup && activeSelection) refreshActiveBeltGroups(lookup, activeSelection.groupKeys);
}

interface BeltStepOutputReservation {
  allowanceByBelt: Map<string, number>;
  outputCredits: Map<string, number>;
}

function reserveBeltStepOutputCapacity(
  state: GameState,
  lookup?: SimulationLookupContext,
  skippedBeltIds?: ReadonlySet<string>,
  profiler?: SimulationProfiler,
): BeltStepOutputReservation {
  const startedAt = profiler ? profileNow() : 0;
  const allowanceByBelt = new Map<string, number>();
  const outputCredits = new Map<string, number>();
  const remainingTargetCapacity = new Map<string, number>();
  const routes = lookup?.beltRuntime.activeQueueEnabled
    ? lookup.beltRuntime.routeGroups.flatMap((group) => lookup.beltRuntime.activeGroupKeys.has(group.key) ? group.routes : [])
    : lookup
      ? lookup.beltRoutes
    : createIndexedBeltRoutes(state, true);
  for (const route of routes) {
    const belt = route.belt;
    if (skippedBeltIds?.has(belt.id)) continue;
    const source = route.source;
    const target = route.target;
    if (!route.compatible || !source || !target) continue;
    const allowance = Math.max(0, Math.floor(belt.progress + EPSILON));
    if (allowance < 1) continue;
    const targetKey = target.buildingId === "material_delivery_hub"
      ? `tray:${target.planetId}:${belt.itemId}`
      : target.buildingId === "micro_black_hole_connector"
        ? `black-hole:${target.id}:${belt.targetPortIndex ?? -1}`
        : `${target.id}:${belt.itemId}`;
    const targetFree = remainingTargetCapacity.has(targetKey)
      ? remainingTargetCapacity.get(targetKey)!
      : targetFreeCapacity(state, target, belt.itemId, belt.targetPortIndex, lookup);
    const reserved = Math.min(allowance, Math.max(0, Math.floor(targetFree)));
    if (reserved < 1) continue;
    allowanceByBelt.set(belt.id, reserved);
    remainingTargetCapacity.set(targetKey, Math.max(0, targetFree - reserved));
    const sourceKey = outputCapacityCreditKey(source.id, belt.itemId);
    outputCredits.set(sourceKey, Math.min(
      normalizeBuildingBufferLimit(state.settings.beltBufferLimit),
      (outputCredits.get(sourceKey) ?? 0) + reserved,
    ));
  }
  if (profiler) profiler.beltReserveMs += profileNow() - startedAt;
  return { allowanceByBelt, outputCredits };
}

function runMiners(
  state: GameState,
  seconds: number,
  power: PowerPlan,
  planetId: PlanetId,
  credits?: OutputCapacityCredits,
  lookup?: SimulationLookupContext,
  skippedEntityIds?: ReadonlySet<string>,
): void {
  const researchedMiningSpeed = getMiningSpeedMultiplier(state);
  const profile = getPlanetIndustrialProfile(state, planetId);
  const entities = lookup ? (lookup.veinsByPlanet.get(planetId) ?? []) : state.entities;
  for (const entity of entities) {
    if (entity.planetId !== planetId || entity.kind !== "vein" || entity.minerCount <= 0 || !entity.resourceId) continue;
    if (skippedEntityIds?.has(entity.id)) continue;
    const powerFactor = powerFactorForEntity(power, entity);
    entity.powerFactor = round(powerFactor, 4);
    const miner = extractorFor(entity);
    const miningSpeed = (ITEMS[entity.resourceId].kind === "solid"
      ? researchedMiningSpeed
      : getInfiniteResourceCollectionSpeedMultiplier(state)) * profile.miningMultiplier;
    const capacity = getEntityOutputCapacity(state, entity);
    const current = Math.floor((entity.outputs[entity.resourceId] ?? 0) + EPSILON);
    const free = Math.max(0, capacity - current) + outputCapacityCredit(credits, entity, entity.resourceId);
    const finite = !isVeinInfiniteForState(state, entity);
    const consumptionTenths = getVeinConsumptionTenths(state, entity.resourceId);
    const outputAllowance = finite ? getFiniteVeinOutputAllowance(entity, consumptionTenths) : Number.POSITIVE_INFINITY;
    if (free < 1 || powerFactor <= EPSILON || outputAllowance < 1) {
      entity.progress = 0;
      entity.utilization = 0;
      entity.productionRate = 0;
      continue;
    }
    entity.progress = round((entity.progress ?? 0) + miner.speed * miningSpeed * entity.minerCount * seconds * powerFactor);
    const produced = Math.min(free, outputAllowance, Math.floor(entity.progress + EPSILON));
    entity.outputs[entity.resourceId] = current + produced;
    if (finite) consumeFiniteVeinReserve(entity, produced, consumptionTenths);
    entity.progress = produced >= free ? 0 : round(entity.progress - produced);
    entity.utilization = powerFactor;
    entity.productionRate = round(miner.speed * miningSpeed * entity.minerCount * powerFactor * 60, 2);
    state.totalProduced[entity.resourceId] = Math.floor((state.totalProduced[entity.resourceId] ?? 0) + produced);
  }
}

function consumeProliferatorPoints(entity: FactoryEntity, recipe: RecipeDefinition, cycles: number, sprayCost = getProliferatorSprayCost(recipe)): void {
  if (!proliferatorApplies(entity, recipe) || cycles < 1) return;
  const definition = getProliferator(entity.proliferatorTier!);
  const requiredPoints = sprayCost * cycles;
  let points = Math.max(0, entity.proliferatorPoints ?? 0);
  if (points < requiredPoints) {
    const requiredItems = Math.ceil((requiredPoints - points) / definition.sprayPoints);
    const availableItems = Math.floor((entity.inputs[definition.itemId] ?? 0) + EPSILON);
    const consumedItems = Math.min(requiredItems, availableItems);
    entity.inputs[definition.itemId] = availableItems - consumedItems;
    points += consumedItems * definition.sprayPoints;
  }
  entity.proliferatorPoints = Math.max(0, points - requiredPoints);
}

export function investInfiniteResearchBudgetInPlace(
  state: GameState,
  id: InfiniteResearchId,
  requested: bigint,
): bigint {
  const progress = state.endgame.infiniteResearch[id];
  const result = settleInfiniteResearchBudget(
    id,
    progress.level,
    progress.progress,
    requested,
    state.endgame.autoResearch,
  );
  progress.level = result.level;
  progress.progress = result.progress;
  for (const completedLevel of result.completedLevels) {
    state.endgame.galacticScore = Math.floor(state.endgame.galacticScore + 1_000 + completedLevel * 250);
  }
  if (result.reachedMaximum || (result.completedLevels.length > 0 && !state.endgame.autoResearch)) {
    state.endgame.activeInfiniteResearchId = null;
  }
  return result.consumed;
}

function investInfiniteResearch(state: GameState, id: InfiniteResearchId, requested: number): number {
  const safe = Math.max(0, Math.floor(requested));
  if (safe < 1) return 0;
  return Number(investInfiniteResearchBudgetInPlace(state, id, BigInt(safe)));
}

function dysonLaunchFactor(state: GameState, recipeId: RecipeId | undefined): number {
  if (recipeId !== "solar_sail_launch" && recipeId !== "carrier_rocket_launch") return 1;
  const schedule = state.dysonEngineering;
  if (!schedule.launchEnabled) return 0;
  if (schedule.launchMode === "swarm" && recipeId === "carrier_rocket_launch") return 0;
  if (schedule.launchMode === "sphere" && recipeId === "solar_sail_launch") return 0;
  return schedule.launchThrottle;
}

function dysonLaunchEnergyPerCycle(recipeId: RecipeId | undefined): number {
  if (recipeId === "solar_sail_launch") return DYSON_SAIL_LAUNCH_ENERGY_MJ;
  if (recipeId === "carrier_rocket_launch") return DYSON_ROCKET_LAUNCH_ENERGY_MJ;
  return 0;
}

function runMachines(
  state: GameState,
  seconds: number,
  power: PowerPlan,
  planetId: PlanetId,
  credits?: OutputCapacityCredits,
  lookup?: SimulationLookupContext,
  skippedEntityIds?: ReadonlySet<string>,
): void {
  const profile = getPlanetIndustrialProfile(state, planetId);
  const runtimes = lookup?.machineRuntimesByPlanet.get(planetId) ?? state.entities.flatMap((entity): IndexedMachineRuntime[] => {
    const recipe = getRecipe(entity.recipeId);
    if (entity.planetId !== planetId || entity.kind !== "machine" || entity.buildingId === "ray_receiver" || !entity.buildingId || !recipe) return [];
    const building = getBuilding(entity.buildingId);
    const planetSpeed = specializationApplies(profile, building.family, entity.buildingId) ? profile.productionSpeedMultiplier : 1;
    return [{
      entity,
      recipe,
      baseSpeedProduct: building.speed * entity.machineCount,
      planetSpeed,
      recipeDuration: recipe.duration,
      outputCapacity: getEntityOutputCapacity(state, entity),
      outputCreditKeys: recipe.outputs.map((output) => outputCapacityCreditKey(entity.id, output.itemId)),
      powerDemandProduct: (building.powerDemandKw ?? 0) * entity.machineCount,
      sprayCost: getProliferatorSprayCost(recipe),
      baseUnitsPerCycle: recipe.id === "matrix_research" || recipe.id === "solar_sail_launch" || recipe.id === "carrier_rocket_launch"
        ? 1
        : recipe.outputs.reduce((sum, output) => sum + output.amount, 0),
      launchEnergyPerCycle: dysonLaunchEnergyPerCycle(recipe.id),
      matrixResearch: recipe.id === "matrix_research",
    }];
  });
  let industrialRecipeSpeed = getRecipeSpeedMultiplier(state, "iron_ingot");
  let matrixResearchSpeed = getRecipeSpeedMultiplier(state, "matrix_research");
  const refreshRecipeSpeeds = () => {
    industrialRecipeSpeed = getRecipeSpeedMultiplier(state, "iron_ingot");
    matrixResearchSpeed = getRecipeSpeedMultiplier(state, "matrix_research");
  };
  for (const runtime of runtimes) {
    const { entity, recipe, baseSpeedProduct, planetSpeed, recipeDuration } = runtime;
    if (skippedEntityIds?.has(entity.id)) continue;
    entity.powerFactor = power.factorByEntity.has(entity.id)
      ? round(power.factorByEntity.get(entity.id)!, 4)
      : undefined;
    if (recipe.id === "matrix_research" && !hasActiveResearch(state)) {
      entity.progress = 0;
      entity.utilization = 0;
      entity.productionRate = 0;
      continue;
    }
    const powerFactor = powerFactorForEntity(power, entity);
    const effectiveCyclesPerSecond = baseSpeedProduct *
      (runtime.matrixResearch ? matrixResearchSpeed : industrialRecipeSpeed) * planetSpeed / recipeDuration;
    const launchFactor = dysonLaunchFactor(state, recipe.id);
    if (recipe.requiredTechId && !isTechnologyCompleted(state, recipe.requiredTechId)) {
      entity.progress = 0;
      entity.utilization = 0;
      entity.productionRate = 0;
      continue;
    }
    const targetDysonOrbitId = recipe.id === "solar_sail_launch"
      ? getEjectorOrbitTargetStatus(state, entity).orbit?.id
      : undefined;
    if (recipe.id === "solar_sail_launch" && !targetDysonOrbitId) {
      entity.utilization = 0;
      entity.productionRate = 0;
      continue;
    }
    const fullInputCycles = Math.floor(availableInputCyclesForRecipe(state, entity, recipe) + EPSILON);
    const sprayedCycleLimit = availableFullProliferatorCycles(entity, recipe, runtime.sprayCost);
    const extraProductBonus = getEntityExtraProductBonusForRecipe(entity, recipe);
    const fullOutputCycles = fullInputCycles < 1
      ? 0
      : Math.floor(availableOutputCycles(state, entity, credits, runtime, fullInputCycles, {
          extraProductBonus,
          sprayedCycleLimit,
        }) + EPSILON);
    const maximumCycles = Math.min(fullInputCycles, fullOutputCycles);
    const progressAtStart = entity.progress ?? 0;
    const baseRate = effectiveCyclesPerSecond * powerFactor * launchFactor;
    let potentialCycles = baseRate * seconds;
    let sprayedWork = 0;
    if (entity.proliferatorMode === "speed" && sprayedCycleLimit > 0 && baseRate > EPSILON) {
      const acceleratedRate = baseRate * getEntityProliferatorSpeedMultiplierForRecipe(entity, recipe);
      const acceleratedCapacity = Math.max(0, Math.min(maximumCycles, sprayedCycleLimit) - progressAtStart);
      const acceleratedSeconds = Math.min(seconds, acceleratedCapacity / Math.max(EPSILON, acceleratedRate));
      sprayedWork = Math.min(acceleratedCapacity, acceleratedRate * acceleratedSeconds);
      potentialCycles = sprayedWork + baseRate * Math.max(0, seconds - acceleratedSeconds);
    }
    if (maximumCycles < 1 || potentialCycles <= EPSILON) {
      entity.utilization = 0;
      entity.productionRate = 0;
      continue;
    }

    const work = Math.min(potentialCycles, Math.max(0, maximumCycles - progressAtStart));
    if (entity.proliferatorMode !== "speed") sprayedWork = Math.min(work, Math.max(0, sprayedCycleLimit - progressAtStart));
    entity.progress = round(progressAtStart + work, 6);
    const cycles = Math.min(maximumCycles, Math.floor(entity.progress + EPSILON));
    const sprayedCycles = Math.min(cycles, sprayedCycleLimit);

    if (recipe.id === "matrix_research") {
      const techId = state.research.selectedTechId;
      const technology = getTechnology(techId);
      const infiniteId = state.endgame?.activeInfiniteResearchId;
      let consumedResearchMatrices = 0;
      if (techId && technology && cycles > 0) {
        const progress = { ...(state.research.progressByTech[techId] ?? {}) };
        let remainingCycles = cycles;
        for (const cost of technology.costs) {
          if (remainingCycles < 1) break;
          const remainingCost = Math.max(0, cost.amount - (progress[cost.itemId] ?? 0));
          const consumed = Math.min(
            remainingCycles,
            remainingCost,
            Math.floor((entity.inputs[cost.itemId] ?? 0) + EPSILON),
          );
          if (consumed < 1) continue;
          entity.inputs[cost.itemId] = Math.floor((entity.inputs[cost.itemId] ?? 0) - consumed);
          progress[cost.itemId] = Math.floor((progress[cost.itemId] ?? 0) + consumed);
          remainingCycles -= consumed;
          consumedResearchMatrices += consumed;
        }
        state.research.progressByTech[techId] = progress;
        const completed = technology.costs.every((cost) => (progress[cost.itemId] ?? 0) >= cost.amount);
        if (completed) {
          completeTechnology(state, techId);
          activateNextQueuedTechnology(state);
          for (const researchEntity of state.entities) {
            if (researchEntity.recipeId === "matrix_research") researchEntity.progress = 0;
          }
        }
      } else if (infiniteId && isEndgameUnlocked(state) && cycles > 0) {
        const available = Math.floor((entity.inputs.universe_matrix ?? 0) + EPSILON);
        const consumed = investInfiniteResearch(state, infiniteId, Math.min(cycles, available));
        if (consumed > 0) {
          entity.inputs.universe_matrix = Math.floor((entity.inputs.universe_matrix ?? 0) - consumed);
          consumedResearchMatrices = consumed;
          for (const researchEntity of state.entities) {
            if (researchEntity.recipeId === "matrix_research") researchEntity.progress = 0;
          }
        }
      }
      consumeProliferatorPoints(entity, recipe, Math.min(sprayedCycles, consumedResearchMatrices), runtime.sprayCost);
      refreshRecipeSpeeds();
    } else {
      for (const input of recipe.inputs) {
        entity.inputs[input.itemId] = Math.max(0, Math.floor((entity.inputs[input.itemId] ?? 0) - input.amount * cycles));
      }
      consumeProliferatorPoints(entity, recipe, sprayedCycles, runtime.sprayCost);
      if (recipe.id === "solar_sail_launch" && cycles > 0) {
        launchDysonSails(state, getPlanet(entity.planetId).systemId, targetDysonOrbitId!, cycles);
      }
      if (recipe.id === "carrier_rocket_launch" && cycles > 0) {
        launchDysonStructure(state, getPlanet(entity.planetId).systemId, cycles);
      }
      const launchEnergy = runtime.launchEnergyPerCycle;
      if (launchEnergy > EPSILON && cycles > 0) {
        state.dysonEngineering.launchEnergySpentMj = round(state.dysonEngineering.launchEnergySpentMj + launchEnergy * cycles, 3);
      }
      for (const output of recipe.outputs) {
        const baseProduced = output.amount * cycles;
        const accumulatedBonus = (entity.proliferatorBonusProgress?.[output.itemId] ?? 0) +
          output.amount * sprayedCycles * extraProductBonus;
        const bonusProduced = Math.floor(accumulatedBonus + EPSILON);
        entity.proliferatorBonusProgress ??= {};
        entity.proliferatorBonusProgress[output.itemId] = round(Math.max(0, accumulatedBonus - bonusProduced), 6);
        const produced = baseProduced + bonusProduced;
        entity.outputs[output.itemId] = Math.floor((entity.outputs[output.itemId] ?? 0) + produced);
        state.totalProduced[output.itemId] = Math.floor((state.totalProduced[output.itemId] ?? 0) + produced);
      }
    }

    entity.progress = Math.max(0, round(entity.progress - cycles, 6));
    const activityFactor = potentialCycles > EPSILON ? Math.min(1, work / potentialCycles) : 0;
    entity.utilization = round(powerFactor * launchFactor * activityFactor, 4);
    const bonusUnitsPerCycle = work > EPSILON ? runtime.baseUnitsPerCycle * extraProductBonus * sprayedWork / work : 0;
    entity.productionRate = round((seconds > EPSILON ? work / seconds : 0) * (runtime.baseUnitsPerCycle + bonusUnitsPerCycle) * 60, 2);
  }
}

function runRayReceivers(
  state: GameState,
  seconds: number,
  reception: DysonReceptionPlan,
  planetId: PlanetId,
  credits?: OutputCapacityCredits,
  entities = state.entities,
): void {
  for (const entity of entities) {
    if (entity.planetId !== planetId || entity.kind !== "machine" || entity.buildingId !== "ray_receiver") continue;
    const recipe = getRecipe(entity.recipeId);
    const allocationKw = reception.allocationByEntity.get(entity.id) ?? 0;
    entity.powerOutputKw = round(allocationKw, 2);
    entity.productionRate = 0;
    entity.utilization = 0;
    if (!recipe || (recipe.requiredTechId && !isTechnologyCompleted(state, recipe.requiredTechId))) {
      entity.progress = 0;
      continue;
    }
    if (recipe.id === "ray_power") {
      entity.progress = 0;
      entity.utilization = reception.efficiencyByEntity.get(entity.id) ?? 0;
      continue;
    }
    if (recipe.id !== "critical_photon" || allocationKw <= EPSILON) continue;

    const building = getBuilding("ray_receiver");
    const cyclesPerSecond = building.speed * entity.machineCount / recipe.duration;
    const efficiency = reception.efficiencyByEntity.get(entity.id) ?? 0;
    const potentialCycles = cyclesPerSecond * seconds * efficiency;
    const maximumCycles = Math.floor(availableOutputCycles(state, entity, credits) + EPSILON);
    if (maximumCycles < 1 || potentialCycles <= EPSILON) continue;
    const work = Math.min(potentialCycles, Math.max(0, maximumCycles - entity.progress));
    entity.progress = round(entity.progress + work, 6);
    const cycles = Math.min(maximumCycles, Math.floor(entity.progress + EPSILON));
    if (cycles > 0) {
      entity.outputs.critical_photon = Math.floor((entity.outputs.critical_photon ?? 0) + cycles);
      state.totalProduced.critical_photon = Math.floor((state.totalProduced.critical_photon ?? 0) + cycles);
      entity.progress = Math.max(0, round(entity.progress - cycles, 6));
    }
    const activityFactor = potentialCycles > EPSILON ? Math.min(1, work / potentialCycles) : 0;
    entity.utilization = round(efficiency * activityFactor, 4);
    entity.productionRate = round(cyclesPerSecond * 60 * entity.utilization, 2);
  }
}

function resetStationRuntime(state: GameState, lookup?: SimulationLookupContext): void {
  for (const station of lookup?.stations ?? state.entities.filter((entity) => entity.kind === "station")) {
    station.utilization = 0;
    station.productionRate = 0;
    station.stationPeerId = undefined;
  }
}

function runOrbitalCollectors(state: GameState, seconds: number, credits?: OutputCapacityCredits, lookup?: SimulationLookupContext): void {
  for (const collector of lookup?.orbitalCollectors ?? state.entities.filter((entity) => entity.buildingId === "orbital_collector")) {
    const yields = getPlanetOrbitalYields(state, collector.planetId);
    const itemId = collector.storedItemId && (yields[collector.storedItemId] ?? 0) > 0
      ? collector.storedItemId
      : (Object.keys(yields)[0] as ItemId | undefined) ?? "hydrogen";
    collector.storedItemId = itemId;
    collector.stationMode = "supply";
    const capacity = getEntityOutputCapacity(state, collector);
    const current = Math.floor((collector.outputs[itemId] ?? 0) + EPSILON);
    const free = Math.max(0, capacity - current) + outputCapacityCredit(credits, collector, itemId);
    if (free < 1) {
      collector.progress = 0;
      continue;
    }
    const profile = getPlanetIndustrialProfile(state, collector.planetId);
    const rate = (yields[itemId] ?? 0) * collector.machineCount * profile.orbitalYieldMultiplier *
      getInfiniteResourceCollectionSpeedMultiplier(state);
    collector.progress = round((collector.progress ?? 0) + rate * seconds, 6);
    const produced = Math.min(free, Math.floor(collector.progress + EPSILON));
    collector.outputs[itemId] = current + produced;
    collector.progress = produced >= free ? 0 : round(collector.progress - produced, 6);
    collector.utilization = 1;
    collector.productionRate = round(rate * 60, 2);
    state.totalProduced[itemId] = Math.floor((state.totalProduced[itemId] ?? 0) + produced);
  }
}

function stationInstalledVehicles(station: FactoryEntity, scope: StationLogisticsScope): number {
  return scope === "local"
    ? Math.min(getStationDroneCapacity(station), Math.max(0, Math.floor(station.stationDrones ?? 0)))
    : Math.min(getStationVesselCapacity(station), Math.max(0, Math.floor(station.stationVessels ?? 0)));
}

function routeVehicleStationId(demand: FactoryEntity, route: StationRoute): string {
  return route.vehicleStationId ?? demand.id;
}

function routeLookupKey(stationId: string, suffix: string): string {
  return `${stationId}|${suffix}`;
}

function addRouteToLookup(lookup: SimulationLookupContext, demand: FactoryEntity, route: StationRoute): void {
  const ownerId = routeVehicleStationId(demand, route);
  const busyKey = routeLookupKey(ownerId, route.scope);
  lookup.busyVehicles.set(busyKey, (lookup.busyVehicles.get(busyKey) ?? 0) + route.vehicleCount);
  const reservedKey = routeLookupKey(route.peerId, route.itemId);
  lookup.reservedOutgoing.set(reservedKey, (lookup.reservedOutgoing.get(reservedKey) ?? 0) + route.cargo);
  const inFlightKey = routeLookupKey(demand.id, route.itemId);
  lookup.inFlightCargo.set(inFlightKey, (lookup.inFlightCargo.get(inFlightKey) ?? 0) + route.cargo);
  for (const stationId of new Set([demand.id, route.peerId, ownerId, ...(route.waypointStationIds ?? [])])) {
    const active = lookup.activeRoutesByStation.get(stationId);
    if (active) active.push({ demand, route });
    else lookup.activeRoutesByStation.set(stationId, [{ demand, route }]);
    lookup.activeRouteVehicleLoadByStation.set(
      stationId,
      (lookup.activeRouteVehicleLoadByStation.get(stationId) ?? 0) + route.vehicleCount,
    );
  }
}

function rebuildDynamicRouteLookup(state: GameState, lookup: SimulationLookupContext): void {
  lookup.busyVehicles.clear();
  lookup.reservedOutgoing.clear();
  lookup.inFlightCargo.clear();
  lookup.activeRoutesByStation.clear();
  lookup.activeRouteVehicleLoadByStation.clear();
  for (const demand of lookup.stations) {
    for (const route of demand.stationRoutes ?? []) addRouteToLookup(lookup, demand, route);
  }
  lookup.dynamicRouteLookupDirty = false;
}

function ensureDynamicRouteLookup(state: GameState, lookup: SimulationLookupContext): void {
  if (!lookup.dynamicRouteLookupDirty) return;
  rebuildDynamicRouteLookup(state, lookup);
}

/** Builds the hydrated read-only indexes used by one P6 planet-phase batch. */
export function createSimulationPlanetPhaseLookup(state: GameState, profiler?: SimulationProfiler): SimulationLookupContext {
  const lookup = createSimulationLookupContext(state, profiler);
  ensureDynamicRouteLookup(state, lookup);
  return lookup;
}

function refreshRouteEnvironment(state: GameState, lookup: SimulationLookupContext): void {
  const nextKey = routeEnvironmentKey(state);
  if (lookup.routeEnvironmentKey === nextKey) return;
  lookup.routeEnvironmentKey = nextKey;
  lookup.stationPeerMatches.clear();
  lookup.blockedStationDispatch.clear();
  lookup.routeEconomics.clear();
  lookup.interstellarPaths.clear();
}

function stationBusyVehicles(state: GameState, station: FactoryEntity, scope: StationLogisticsScope, lookup?: SimulationLookupContext): number {
  if (lookup) return lookup.busyVehicles.get(routeLookupKey(station.id, scope)) ?? 0;
  return state.entities.reduce((sum, demand) => sum + (demand.stationRoutes ?? []).reduce((routeSum, route) =>
    route.scope === scope && routeVehicleStationId(demand, route) === station.id
      ? routeSum + route.vehicleCount
      : routeSum, 0), 0);
}

function stationActiveRoutes(state: GameState, station: FactoryEntity, lookup?: SimulationLookupContext): Array<{ demand: FactoryEntity; route: StationRoute }> {
  if (lookup) return lookup.activeRoutesByStation.get(station.id) ?? [];
  return state.entities.flatMap((demand) => (demand.stationRoutes ?? []).flatMap((route) =>
    demand.id === station.id || route.peerId === station.id || routeVehicleStationId(demand, route) === station.id ||
      (route.waypointStationIds ?? []).includes(station.id)
      ? [{ demand, route }]
      : []));
}

export function getStationActiveRoutes(state: GameState, stationId: string): StationRoute[] {
  const station = state.entities.find((entity) => entity.id === stationId);
  return station ? stationActiveRoutes(state, station).map(({ route }) => route) : [];
}

export function getStationBusyVehicleCount(state: GameState, stationId: string, scope: StationLogisticsScope): number {
  const station = state.entities.find((entity) => entity.id === stationId);
  return station ? stationBusyVehicles(state, station, scope) : 0;
}

export type StationFleetBlockerCode =
  | "none"
  | "no-match"
  | "waiting-load"
  | "demand-full"
  | "all-busy"
  | "no-power"
  | "warp-disabled"
  | "missing-warper"
  | "route-unavailable";

export interface StationFleetScopeDiagnostic {
  installed: number;
  capacity: number;
  busy: number;
  available: number;
  blocked: number;
  blockerCode: StationFleetBlockerCode;
  blockerLabel: string;
  affectedSlotIndices: number[];
}

export interface StationFleetDiagnostic {
  drones: StationFleetScopeDiagnostic;
  vessels: StationFleetScopeDiagnostic;
}

function diagnoseStationFleetScope(state: GameState, station: FactoryEntity, scope: StationLogisticsScope): StationFleetScopeDiagnostic {
  const capacity = scope === "local" ? getStationDroneCapacity(station) : getStationVesselCapacity(station);
  const installed = stationInstalledVehicles(station, scope);
  const busy = stationBusyVehicles(state, station, scope);
  const availableVehicles = Math.max(0, installed - busy);
  const base = { installed, capacity, busy, available: availableVehicles };
  if (availableVehicles < 1) return {
    ...base,
    blocked: 0,
    blockerCode: installed > 0 ? "all-busy" : "none",
    blockerLabel: installed > 0 ? "全部载具执行中" : "未安装载具",
    affectedSlotIndices: [],
  };
  const reasons: Array<{ code: StationFleetBlockerCode; label: string; slotIndex: number; available?: number; blocked?: number }> = [];
  const slots = getStationSlots(station);
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    const slot = slots[slotIndex];
    if (!slot.itemId || stationSlotMode(station, slot, scope) === "storage") continue;
    const matches = findStationSlotPeers(state, station, slotIndex, scope);
    if (matches.length === 0) {
      reasons.push({ code: "no-match", label: "无匹配供应/需求", slotIndex });
      continue;
    }
    for (const match of matches) {
      const localMode = stationSlotMode(station, slot, scope);
      const supply = localMode === "supply" ? station : match.peer;
      const demand = localMode === "demand" ? station : match.peer;
      const supplySlotIndex = localMode === "supply" ? slotIndex : match.peerSlotIndex;
      const demandSlotIndex = localMode === "demand" ? slotIndex : match.peerSlotIndex;
      const supplySlot = supply.buildingId === "orbital_collector"
        ? { ...emptyStationSlot(), itemId: supply.storedItemId, remoteMode: "supply" as const }
        : getStationSlots(supply)[supplySlotIndex];
      const demandSlot = getStationSlots(demand)[demandSlotIndex];
      const availableStock = Math.max(0, Math.floor((supply.outputs[slot.itemId] ?? 0) - supplySlot.minStock -
        stationReservedOutgoing(state, supply.id, slot.itemId)));
      const free = Math.max(0, Math.floor(getStationSlotCapacity(state, demand, demandSlot) -
        (demand.outputs[slot.itemId] ?? 0) - stationInFlightCargo(demand, slot.itemId)));
      const minimumCargo = getStationMinimumCargo(state, station, slotIndex, scope);
      if (free < minimumCargo) {
        reasons.push({ code: "demand-full", label: "需求库存已满", slotIndex });
        continue;
      }
      if (availableStock < minimumCargo) {
        reasons.push({ code: "waiting-load", label: "供应库存低于起送量", slotIndex });
        continue;
      }
      if (getEntityPowerFactor(state, supply) <= EPSILON || getEntityPowerFactor(state, demand) <= EPSILON) {
        reasons.push({ code: "no-power", label: "航线一侧供电不足", slotIndex });
        continue;
      }
      const requiresWarp = scope === "remote" && stationRouteRequiresWarp(demand, supply);
      if (requiresWarp) {
        const economics = getInterstellarRouteEconomics(state, supply, demand, 1, {
          routePolicy: demandSlot.routePolicy,
          warperBudget: demandSlot.warperBudget,
        });
        if (!economics.routeAvailable) {
          reasons.push({ code: "route-unavailable", label: "路线或中转枢纽不可达", slotIndex });
          continue;
        }
        if (!station.stationWarpEnabled) {
          reasons.push({ code: "warp-disabled", label: "空间翘曲已关闭", slotIndex });
          continue;
        }
        const warpers = Math.max(0, Math.floor(station.stationWarpers ?? 0));
        const perVessel = Math.max(1, economics.warpersPerVessel);
        const supported = Math.floor(warpers / perVessel);
        if (supported < 1) {
          reasons.push({ code: "missing-warper", label: `${installed} 艘已安装，0 艘可出发；${availableVehicles} 艘受 ${warpers} 个翘曲器/${perVessel} 个每船限制`, slotIndex, available: 0, blocked: availableVehicles });
          continue;
        }
        if (supported < availableVehicles) {
          reasons.push({
            code: "missing-warper",
            label: `${installed} 艘已安装，${supported} 艘可出发；${availableVehicles - supported} 艘受 ${warpers} 个翘曲器/${perVessel} 个每船限制`,
            slotIndex,
            available: supported,
            blocked: availableVehicles - supported,
          });
          continue;
        }
      }
      return { ...base, blocked: 0, blockerCode: "none", blockerLabel: "可立即调度", affectedSlotIndices: [] };
    }
  }
  const reason = reasons[0] ?? { code: "no-match" as const, label: "无匹配供应/需求", slotIndex: 0 };
  return {
    ...base,
    available: reason.available ?? base.available,
    blocked: reason.blocked ?? availableVehicles,
    blockerCode: reason.code,
    blockerLabel: reason.label,
    affectedSlotIndices: [...new Set(reasons.filter((entry) => entry.code === reason.code).map((entry) => entry.slotIndex))],
  };
}

export function getStationFleetDiagnostic(state: GameState, stationId: string): StationFleetDiagnostic | null {
  const station = state.entities.find((entity) => entity.id === stationId && entity.kind === "station" && entity.buildingId !== "orbital_collector");
  if (!station) return null;
  const vesselCapacity = getStationVesselCapacity(station);
  const installedVessels = stationInstalledVehicles(station, "remote");
  const busyVessels = stationBusyVehicles(state, station, "remote");
  return {
    drones: diagnoseStationFleetScope(state, station, "local"),
    vessels: isTraditionalStationScopeDisabled(station, "remote")
      ? {
        installed: installedVessels,
        capacity: vesselCapacity,
        busy: busyVessels,
        available: Math.max(0, installedVessels - busyVessels),
        blocked: 0,
        blockerCode: "none",
        blockerLabel: busyVessels > 0 ? `旧星际航线尾货返航中 · ${busyVessels} 艘` : "量子跨星模式不使用运输船",
        affectedSlotIndices: [],
      }
      : diagnoseStationFleetScope(state, station, "remote"),
  };
}

function stationInFlightCargo(station: FactoryEntity, itemId: ItemId, lookup?: SimulationLookupContext): number {
  if (lookup) return lookup.inFlightCargo.get(routeLookupKey(station.id, itemId)) ?? 0;
  return (station.stationRoutes ?? []).reduce((sum, route) => route.itemId === itemId ? sum + route.cargo : sum, 0);
}

function stationReservedOutgoing(state: GameState, sourceId: string, itemId: ItemId, lookup?: SimulationLookupContext): number {
  if (lookup) return lookup.reservedOutgoing.get(routeLookupKey(sourceId, itemId)) ?? 0;
  return state.entities.reduce((sum, station) => sum + (station.stationRoutes ?? []).reduce((routeSum, route) =>
    route.peerId === sourceId && route.itemId === itemId ? routeSum + route.cargo : routeSum, 0), 0);
}

function refundStationRouteWarpers(state: GameState, demand: FactoryEntity, route: StationRoute): void {
  const amount = route.vehicleCount * Math.max(route.requiresWarp ? 1 : 0, route.warpersPerVessel ?? 0);
  if (amount < 1) return;
  const owner = state.entities.find((entity) => entity.id === routeVehicleStationId(demand, route));
  if (!owner || owner.buildingId !== "interstellar_logistics_station") {
    addToPlanetTray(state, demand.planetId, "space_warper", amount);
    return;
  }
  const current = Math.max(0, Math.floor(owner.stationWarpers ?? 0));
  const stored = Math.min(amount, Math.max(0, getStationWarperCapacity(owner) - current));
  owner.stationWarpers = current + stored;
  addToPlanetTray(state, owner.planetId, "space_warper", amount - stored);
}

function cancelStationRoutes(
  state: GameState,
  predicate: (demand: FactoryEntity, route: StationRoute) => boolean,
): void {
  for (const demand of state.entities) {
    if (!demand.stationRoutes?.length) continue;
    const remaining: StationRoute[] = [];
    for (const route of demand.stationRoutes) {
      if (!predicate(demand, route)) {
        remaining.push(route);
        continue;
      }
      refundStationRouteWarpers(state, demand, route);
    }
    demand.stationRoutes = remaining;
    demand.stationProgress = remaining.length ? Math.max(...remaining.map((route) => route.progress)) : 0;
  }
}

function stationPowerForDispatch(powerByPlanet: Map<PlanetId, PowerPlan>, station: FactoryEntity): number {
  const plan = powerByPlanet.get(station.planetId);
  return station.buildingId === "orbital_collector" ? 1 : plan?.factorByEntity.get(station.id) ?? plan?.factor ?? 0;
}

function blockedDispatchSnapshot(
  state: GameState,
  demand: FactoryEntity,
  slot: StationSlot & { itemId: ItemId },
  slotIndex: number,
  matches: readonly StationPeerMatch[],
  powerByPlanet: Map<PlanetId, PowerPlan>,
  lookup: SimulationLookupContext,
): number[] | null {
  if (isQuantumStation(demand)) return null;
  const values = [
    getPlanetaryCargoCapacity(state),
    demand.outputs[slot.itemId] ?? 0,
    stationInFlightCargo(demand, slot.itemId, lookup),
    stationInstalledVehicles(demand, "local"),
    stationBusyVehicles(state, demand, "local", lookup),
    stationPowerForDispatch(powerByPlanet, demand),
    getStationMinimumCargo(state, demand, slotIndex, "local"),
  ];
  for (const match of matches) {
    const supply = match.peer;
    const supplySlot = getStationSlots(supply)[match.peerSlotIndex];
    values.push(
      supply.outputs[slot.itemId] ?? 0,
      stationReservedOutgoing(state, supply.id, slot.itemId, lookup),
      supplySlot?.minStock ?? 0,
      stationInstalledVehicles(supply, "local"),
      stationBusyVehicles(state, supply, "local", lookup),
      stationPowerForDispatch(powerByPlanet, supply),
      lookup.activeRouteVehicleLoadByStation.get(supply.id) ?? 0,
      getStationMinimumCargo(state, supply, match.peerSlotIndex, "local"),
    );
  }
  return values;
}

function sameDispatchSnapshot(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function dispatchStationScope(
  state: GameState,
  scope: StationLogisticsScope,
  powerByPlanet: Map<PlanetId, PowerPlan>,
  lookup?: SimulationLookupContext,
  profiler?: SimulationProfiler,
): void {
  const runtimeLookup = lookup ?? createSimulationLookupContext(state, profiler);
  if (!lookup) rebuildDynamicRouteLookup(state, runtimeLookup);
  const plans = lookup?.stationDispatchPlans[scope] ?? (state.entities.filter((entity) => entity.kind === "station").flatMap((demand) => {
    if (demand.buildingId === "orbital_collector" || isElevatorStation(demand) || isTraditionalStationScopeDisabled(demand, scope) ||
      (scope === "remote" && demand.buildingId !== "interstellar_logistics_station")) return [];
    const orderedSlots = ensureStationSlots(demand)
      .map((slot, slotIndex) => ({ slot, slotIndex }))
      .filter(({ slot }) => Boolean(slot.itemId) && stationSlotMode(demand, slot, scope) === "demand")
      .sort((left, right) => right.slot.priority - left.slot.priority || left.slotIndex - right.slotIndex);
    return orderedSlots.length > 0 ? [{ demand, orderedSlots }] : [];
  }));
  for (const { demand, orderedSlots } of plans) {
    const cursor = Math.max(0, Math.floor(demand.stationDispatchCursor ?? 0));
    for (let slotOffset = 0; slotOffset < orderedSlots.length; slotOffset += 1) {
      const { slot, slotIndex } = orderedSlots[(cursor + slotOffset) % orderedSlots.length];
      if (!slot.itemId) continue;
      if (profiler) profiler.dispatchSlotChecks += 1;
      const fairnessKey = `${scope}:${slotIndex}`;
      const lastPeerId = demand.stationLastSupplyPeerBySlot?.[fairnessKey];
      const matches = findStationSlotPeers(state, demand, slotIndex, scope, runtimeLookup, profiler);
      const dispatchResult: StationDispatchSlotResult = {
        hasMatchingPeer: matches.length > 0,
        routesCreated: 0,
        cargoDispatched: 0,
      };
      const dispatchKey = stationDispatchSlotKey(demand.id, slotIndex, scope);
      runtimeLookup.dispatchResultsBySlot.set(dispatchKey, dispatchResult);
      const snapshot = scope === "local"
        ? blockedDispatchSnapshot(state, demand, slot as StationSlot & { itemId: ItemId }, slotIndex, matches, powerByPlanet, runtimeLookup)
        : null;
      const blockedCache = snapshot ? runtimeLookup.blockedStationDispatch.get(dispatchKey) : undefined;
      if (snapshot && blockedCache && blockedCache.lastPeerId === lastPeerId && sameDispatchSnapshot(snapshot, blockedCache.values)) {
        runtimeLookup.dispatchResultsBySlot.set(dispatchKey, blockedCache.result);
        if (profiler) profiler.dispatchBlockedCacheHits += 1;
        continue;
      }
      const peerSortStartedAt = profiler ? profileNow() : 0;
      if (profiler) profiler.dispatchPeerOrderChecks += matches.length;
      const orderedMatches = matches.map((match) => ({
        ...match,
        priority: match.peer.buildingId === "orbital_collector"
          ? 1
          : getStationSlots(match.peer)[match.peerSlotIndex]?.priority ?? 1,
        activeVehicleLoad: runtimeLookup.activeRouteVehicleLoadByStation.get(match.peer.id) ?? 0,
      })).sort((left, right) => {
          const priorityOrder = right.priority - left.priority;
          if (priorityOrder !== 0) return priorityOrder;
          if (left.activeVehicleLoad !== right.activeVehicleLoad) return left.activeVehicleLoad - right.activeVehicleLoad;
          if (lastPeerId) {
            const leftAfter = left.peer.id.localeCompare(lastPeerId) > 0 ? 0 : 1;
            const rightAfter = right.peer.id.localeCompare(lastPeerId) > 0 ? 0 : 1;
            if (leftAfter !== rightAfter) return leftAfter - rightAfter;
          }
          return left.peer.id.localeCompare(right.peer.id);
        });
      if (profiler) profiler.dispatchPeerSortMs += profileNow() - peerSortStartedAt;
      let remainingDemandFree = quantumSupplySlot(demand, slot.itemId)
        ? Math.max(0, Math.floor(quantumSupplyFreeCapacity(state, demand, slot.itemId, runtimeLookup) -
          stationInFlightCargo(demand, slot.itemId, runtimeLookup) + EPSILON))
        : Math.max(0, Math.floor(getStationSlotCapacity(state, demand, slot) - (demand.outputs[slot.itemId] ?? 0) -
          stationInFlightCargo(demand, slot.itemId, runtimeLookup) + EPSILON));
      for (const { peer: supply, peerSlotIndex } of orderedMatches) {
        if (remainingDemandFree < 1) break;
        if (profiler) profiler.dispatchPeerVisits += 1;
        const supplySlot = supply.buildingId === "orbital_collector"
          ? { ...emptyStationSlot(), itemId: supply.storedItemId, remoteMode: "supply" as const }
          : ensureStationSlots(supply)[peerSlotIndex];
        const sourcePlan = powerByPlanet.get(supply.planetId);
        const targetPlan = powerByPlanet.get(demand.planetId);
        const sourcePower = supply.buildingId === "orbital_collector"
          ? 1
          : sourcePlan?.factorByEntity.get(supply.id) ?? sourcePlan?.factor ?? 0;
        const targetPower = targetPlan?.factorByEntity.get(demand.id) ?? targetPlan?.factor ?? 0;
        const requiresWarp = scope === "remote" && stationRouteRequiresWarp(demand, supply);
        const economics = scope === "remote" ? getCachedInterstellarRouteEconomics(state, supply, demand, 1, {
          routePolicy: slot.routePolicy,
          warperBudget: slot.warperBudget,
        }, runtimeLookup, profiler) : null;
        if (requiresWarp && (!isTechnologyCompleted(state, "space_warp") || !economics?.routeAvailable)) continue;
        const hubPower = economics?.waypointStationIds.reduce((factor, stationId) => {
          const station = runtimeLookup.entityById.get(stationId);
          const plan = station ? powerByPlanet.get(station.planetId) : undefined;
          return Math.min(factor, station ? plan?.factorByEntity.get(station.id) ?? plan?.factor ?? 0 : 0);
        }, 1) ?? 1;
        const vehicleOwners = [demand, supply].filter((candidate, index, all) =>
          candidate.buildingId !== "orbital_collector" && all.findIndex((entry) => entry.id === candidate.id) === index);
        for (const owner of vehicleOwners) {
          const freeVehicles = Math.max(0, stationInstalledVehicles(owner, scope) - stationBusyVehicles(state, owner, scope, runtimeLookup));
          if (freeVehicles < 1) continue;
          const ownerPlan = powerByPlanet.get(owner.planetId);
          const ownerPower = ownerPlan?.factorByEntity.get(owner.id) ?? ownerPlan?.factor ?? 0;
          const powerFactor = scope === "local" ? ownerPower : Math.min(sourcePower, targetPower, hubPower);
          if (powerFactor <= EPSILON || (requiresWarp && !owner.stationWarpEnabled)) continue;
          const warpAvailable = Math.max(0, Math.floor(owner.stationWarpers ?? 0));
          if (requiresWarp && warpAvailable < (economics?.warpersPerVessel ?? 1)) continue;
          const itemId = slot.itemId;
          const available = Math.max(0, Math.floor((supply.outputs[itemId] ?? 0) - supplySlot.minStock -
            stationReservedOutgoing(state, supply.id, itemId, runtimeLookup) + EPSILON));
          const free = remainingDemandFree;
          const unitCargo = scope === "local" ? getPlanetaryCargoCapacity(state) : getInterstellarCargoCapacity(state);
          const ownerSlotIndex = owner.id === demand.id ? slotIndex : peerSlotIndex;
          const minimumCargo = getStationMinimumCargo(state, owner, ownerSlotIndex, scope);
          const dispatchable = Math.min(
            freeVehicles,
            Math.floor(available / minimumCargo),
            Math.floor(free / minimumCargo),
            requiresWarp ? Math.floor(warpAvailable / Math.max(1, economics?.warpersPerVessel ?? 1)) : Number.POSITIVE_INFINITY,
          );
          if (dispatchable < 1) continue;
          const cargo = Math.min(available, free, unitCargo * dispatchable);
          const dispatchedEconomics = scope === "remote" ? getCachedInterstellarRouteEconomics(state, supply, demand, dispatchable, {
            routePolicy: slot.routePolicy,
            warperBudget: slot.warperBudget,
          }, runtimeLookup, profiler) : null;
          if (scope === "remote" && !dispatchedEconomics?.routeAvailable) continue;
          const duration = scope === "local" ? getPlanetaryTripSeconds(state) : dispatchedEconomics!.durationSeconds;
          const initialProgress = demand.stationRoutes!.length === 0
            ? Math.max(0, Math.min(0.999999, demand.stationProgress ?? 0))
            : 0;
          const route: StationRoute = {
            id: `route_${state.nextId}`,
            slotIndex,
            peerId: supply.id,
            itemId,
            scope,
            cargo,
            vehicleCount: dispatchable,
            progress: initialProgress,
            duration,
            requiresWarp,
            waypointStationIds: dispatchedEconomics?.waypointStationIds ?? [],
            distanceLy: dispatchedEconomics?.distanceLy ?? 0,
            warpersPerVessel: dispatchedEconomics?.warpersPerVessel ?? 0,
            vehicleStationId: owner.id,
          };
          demand.stationRoutes!.push(route);
          addRouteToLookup(runtimeLookup, demand, route);
          remainingDemandFree = Math.max(0, remainingDemandFree - cargo);
          dispatchResult.routesCreated += 1;
          dispatchResult.cargoDispatched += cargo;
          if (profiler) profiler.routesCreated += 1;
          state.nextId += 1;
          if (requiresWarp) owner.stationWarpers = warpAvailable - dispatchable * (dispatchedEconomics?.warpersPerVessel ?? 1);
          demand.stationProgress = Math.max(demand.stationProgress ?? 0, initialProgress);
          demand.stationPeerId = supply.id;
          supply.stationPeerId = demand.id;
          owner.stationPeerId = owner.id === demand.id ? supply.id : demand.id;
          demand.stationDispatchCursor = slotIndex + 1;
          demand.stationLastSupplyPeerBySlot ??= {};
          demand.stationLastSupplyPeerBySlot[fairnessKey] = supply.id;
        }
      }
      if (snapshot && dispatchResult.routesCreated === 0) {
        runtimeLookup.blockedStationDispatch.set(dispatchKey, {
          values: snapshot,
          lastPeerId,
          result: { ...dispatchResult },
        });
      } else {
        runtimeLookup.blockedStationDispatch.delete(dispatchKey);
      }
    }
  }
}

function advanceStationRoutes(
  state: GameState,
  scope: StationLogisticsScope,
  seconds: number,
  powerByPlanet: Map<PlanetId, PowerPlan>,
  lookup?: SimulationLookupContext,
): void {
  for (const demand of (lookup?.stations ?? state.entities.filter((entity) => entity.kind === "station")).filter((entity) => (entity.stationRoutes?.length ?? 0) > 0)) {
    const remaining: StationRoute[] = [];
    let completedCargo = 0;
    for (const route of demand.stationRoutes ?? []) {
      if (route.scope !== scope) {
        remaining.push(route);
        continue;
      }
      const peer = lookup?.entityById.get(route.peerId) ?? state.entities.find((entity) => entity.id === route.peerId);
      const vehicleOwner = lookup?.entityById.get(routeVehicleStationId(demand, route)) ?? state.entities.find((entity) => entity.id === routeVehicleStationId(demand, route)) ?? demand;
      const sourcePlan = peer ? powerByPlanet.get(peer.planetId) : undefined;
      const targetPlan = powerByPlanet.get(demand.planetId);
      const ownerPlan = powerByPlanet.get(vehicleOwner.planetId);
      const sourcePower = peer?.buildingId === "orbital_collector"
        ? 1
        : peer ? sourcePlan?.factorByEntity.get(peer.id) ?? sourcePlan?.factor ?? 0 : 1;
      const targetPower = targetPlan?.factorByEntity.get(demand.id) ?? targetPlan?.factor ?? 0;
      const ownerPower = ownerPlan?.factorByEntity.get(vehicleOwner.id) ?? ownerPlan?.factor ?? 0;
      const hubPower = (route.waypointStationIds ?? []).reduce((factor, stationId) => {
        const station = lookup?.entityById.get(stationId) ?? state.entities.find((entity) => entity.id === stationId);
        const plan = station ? powerByPlanet.get(station.planetId) : undefined;
        return Math.min(factor, station ? plan?.factorByEntity.get(station.id) ?? plan?.factor ?? 0 : 0);
      }, 1);
      const powerFactor = scope === "local" ? ownerPower : Math.min(sourcePower, targetPower, hubPower);
      route.progress = round(route.progress + seconds * powerFactor / Math.max(1, route.duration), 6);
      demand.utilization = Math.max(demand.utilization, powerFactor);
      if (peer) peer.utilization = Math.max(peer.utilization, powerFactor);
      vehicleOwner.utilization = Math.max(vehicleOwner.utilization, powerFactor);
      if (route.progress + EPSILON < 1) {
        remaining.push(route);
        continue;
      }
      let deliveredCargo = route.cargo;
      if (scope === "local" && isQuantumStation(demand) && quantumSupplySlot(demand, route.itemId)) {
        const received = receiveQuantumSupplyMaterial(state, demand, route.itemId, route.cargo);
        deliveredCargo = received;
        if (received < route.cargo) {
          remaining.push({ ...route, progress: 1, cargo: route.cargo - received });
        }
      } else {
        demand.outputs[route.itemId] = Math.floor((demand.outputs[route.itemId] ?? 0) + route.cargo);
      }
      if (peer && deliveredCargo > 0) peer.outputs[route.itemId] = Math.max(0, Math.floor((peer.outputs[route.itemId] ?? 0) - deliveredCargo));
      demand.stationTrips = Math.floor((demand.stationTrips ?? 0) + route.vehicleCount);
      demand.stationLastTransfer = deliveredCargo;
      completedCargo += deliveredCargo;
      if (lookup) lookup.dynamicRouteLookupDirty = true;
      if (peer) {
        peer.stationTrips = Math.floor((peer.stationTrips ?? 0) + route.vehicleCount);
        peer.stationLastTransfer = deliveredCargo;
      }
    }
    demand.stationRoutes = remaining;
    demand.productionRate += seconds > EPSILON ? completedCargo * 60 / seconds : 0;
    demand.stationProgress = remaining.length > 0 ? Math.max(...remaining.map((route) => route.progress)) : 0;
  }
}

function updateStationCongestion(state: GameState, lookup?: SimulationLookupContext, profiler?: SimulationProfiler): void {
  for (const station of (lookup?.stations ?? state.entities.filter((entity) => entity.kind === "station")).filter((entity) => entity.buildingId !== "orbital_collector")) {
    if (isElevatorStation(station)) continue;
    const candidateScopes: StationLogisticsScope[] = station.buildingId === "interstellar_logistics_station"
      ? ["local", "remote"]
      : ["local"];
    const scopes = candidateScopes.filter((scope) => !isTraditionalStationScopeDisabled(station, scope));
    if (scopes.length === 0) continue;
    const slots = ensureStationSlots(station);
    const waiting = slots.filter((slot, slotIndex) => slot.itemId && scopes.some((scope) => {
      if (stationSlotMode(station, slot, scope) !== "demand") return false;
      const dispatched = lookup?.dispatchResultsBySlot.get(stationDispatchSlotKey(station.id, slotIndex, scope));
      if (dispatched) {
        if (profiler) profiler.congestionDispatchReuseHits += 1;
        return dispatched.hasMatchingPeer;
      }
      return Boolean(findStationSlotPeer(state, station, slotIndex, scope, lookup, profiler));
    })).length;
    const installed = scopes.reduce((sum, scope) => sum + (scope === "local"
      ? getStationDroneCapacity(station)
      : getStationVesselCapacity(station)), 0);
    const busy = scopes.reduce((sum, scope) => sum + stationBusyVehicles(state, station, scope, lookup), 0);
    const fleetLoad = installed > 0 ? busy / installed : waiting > 0 ? 1 : 0;
    station.stationCongestion = round(Math.min(1, Math.max(fleetLoad, waiting > 0 && busy === 0 ? 0.35 : 0)), 3);
    const activeRoutes = stationActiveRoutes(state, station, lookup).map(({ route }) => route);
    station.stationProgress = activeRoutes.length
      ? Math.max(...activeRoutes.map((route) => route.progress))
      : 0;
  }
}

export interface StationWarperRefillSnapshot {
  loaded: number;
  target: number;
  capacity: number;
  inputAvailable: number;
  outputStored: number;
  outputReserved: number;
  outputAvailable: number;
  trayAvailable: number;
  blocker: "technology-locked" | "disabled" | "target-met" | "capacity-full" | "stock-empty" | "ready";
}

function stationWarperRefillSnapshot(
  state: GameState,
  station: FactoryEntity,
  lookup?: SimulationLookupContext,
): StationWarperRefillSnapshot {
  const loaded = Math.max(0, Math.floor(station.stationWarpers ?? 0));
  const target = getStationWarperAutoRefillTarget(station);
  const capacity = getStationWarperCapacity(station);
  const inputAvailable = Math.max(0, Math.floor(station.inputs.space_warper ?? 0));
  const outputStored = Math.max(0, Math.floor(station.outputs.space_warper ?? 0));
  const outputReserved = Math.min(outputStored, Math.max(0, Math.floor(stationReservedOutgoing(state, station.id, "space_warper", lookup))));
  const outputAvailable = Math.max(0, outputStored - outputReserved);
  const trayAvailable = Math.max(0, Math.floor(trayForPlanet(state, station.planetId).space_warper ?? 0));
  const blocker = !isTechnologyCompleted(state, "space_warp")
    ? "technology-locked"
    : !station.stationWarperAutoRefill
      ? "disabled"
      : loaded >= capacity
        ? "capacity-full"
        : loaded >= target
          ? "target-met"
          : inputAvailable + outputAvailable + trayAvailable < 1 ? "stock-empty" : "ready";
  return { loaded, target, capacity, inputAvailable, outputStored, outputReserved, outputAvailable, trayAvailable, blocker };
}

export function getStationWarperRefillSnapshot(state: GameState, stationId: string): StationWarperRefillSnapshot | null {
  const station = state.entities.find((entity) => entity.id === stationId && entity.buildingId === "interstellar_logistics_station");
  return station ? stationWarperRefillSnapshot(state, station) : null;
}

export function refillStationWarpers(state: GameState, lookup?: SimulationLookupContext): void {
  if (!isTechnologyCompleted(state, "space_warp")) return;
  if (lookup) ensureDynamicRouteLookup(state, lookup);
  for (const station of lookup?.stations ?? state.entities) {
    if (station.buildingId !== "interstellar_logistics_station" ||
      isTraditionalStationScopeDisabled(station, "remote") || !station.stationWarperAutoRefill) continue;
    const snapshot = stationWarperRefillSnapshot(state, station, lookup);
    let needed = Math.max(0, Math.min(snapshot.target, snapshot.capacity) - snapshot.loaded);
    if (needed < 1) continue;
    const fromInput = Math.min(needed, snapshot.inputAvailable);
    if (fromInput > 0) {
      station.inputs.space_warper = snapshot.inputAvailable - fromInput;
      station.stationWarpers = snapshot.loaded + fromInput;
      needed -= fromInput;
    }
    const fromOutput = Math.min(needed, snapshot.outputAvailable);
    if (fromOutput > 0) {
      station.outputs.space_warper = snapshot.outputStored - fromOutput;
      station.stationWarpers = Math.max(0, Math.floor(station.stationWarpers ?? 0)) + fromOutput;
      needed -= fromOutput;
    }
    if (needed < 1) continue;
    const tray = trayForPlanet(state, station.planetId);
    const fromTray = Math.min(needed, snapshot.trayAvailable);
    if (fromTray > 0) {
      tray.space_warper = snapshot.trayAvailable - fromTray;
      station.stationWarpers = Math.max(0, Math.floor(station.stationWarpers ?? 0)) + fromTray;
    }
  }
}

function prepareTimeWarpStep(state: GameState, lookup?: SimulationLookupContext): void {
  const controller = lookup?.entityById.get(state.timeWarp.controllerEntityId ?? "") ??
    state.entities.find((entity) => entity.id === state.timeWarp.controllerEntityId && entity.buildingId === "time_warp_device");
  if (!controller) {
    state.timeWarp.controllerEntityId = null;
    state.timeWarp.enabled = false;
  }
  state.timeWarp.effectiveMultiplier = state.settings.simulationSpeed;
  state.timeWarp.requiredPowerKw = 0;
  state.timeWarp.allocatedPowerKw = 0;
  for (const entity of lookup?.timeWarpDevices ?? state.entities) {
    if (entity.buildingId !== "time_warp_device") continue;
    entity.powerInputKw = 0;
    entity.powerFactor = 0;
    entity.utilization = 0;
    entity.productionRate = 0;
  }
}

interface QuantumBoundaryFlow {
  boundarySecond: number;
  uploaded: Partial<Record<ItemId, DecimalIntegerString>>;
  downloaded: Partial<Record<ItemId, DecimalIntegerString>>;
  globalUploadPerMinute: number;
  globalDownloadPerMinute: number;
  quantumTowerStacks: number;
  quantumCollectorStacks: number;
}

function quantumBoundaryCapacity(perMinute: number, seconds: number): number {
  if (!Number.isFinite(perMinute) || perMinute <= 0 || !Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(perMinute * seconds / 60)));
}

function addQuantumBoundaryFlow(
  record: Partial<Record<ItemId, DecimalIntegerString>>,
  itemId: ItemId,
  amount: number,
): void {
  if (amount < 1) return;
  record[itemId] = addQuantumInteger(record[itemId], Math.floor(amount));
}

function quantumBoundaryBandwidth(state: GameState, lookup?: SimulationLookupContext) {
  const level = state.endgame.infiniteResearch.galactic_logistics?.level ?? 0;
  if (!lookup) return getQuantumBandwidthSummary(state.entities, level);
  const multiplier = getQuantumLogisticsMultiplier(level);
  const globalUploadPerMinute = QUANTUM_UNIT_CAP_PER_MINUTE * multiplier * lookup.quantumTowerStacks;
  return {
    multiplier,
    globalUploadPerMinute,
    globalDownloadPerMinute: globalUploadPerMinute,
    activeTowerCount: lookup.quantumStations.length,
    activeTowerStacks: lookup.quantumTowerStacks,
  };
}

function createQuantumBoundaryFlow(state: GameState, boundarySecond: number, lookup?: SimulationLookupContext): QuantumBoundaryFlow {
  const collectors = lookup?.orbitalCollectors ?? state.entities.filter((entity) => entity.buildingId === "orbital_collector");
  const bandwidth = quantumBoundaryBandwidth(state, lookup);
  const existing = state.quantumLogisticsNetwork?.runtimeFlow;
  return {
    boundarySecond,
    uploaded: existing?.boundarySecond === boundarySecond ? { ...existing.uploaded } : {},
    downloaded: {},
    globalUploadPerMinute: bandwidth.globalUploadPerMinute,
    globalDownloadPerMinute: bandwidth.globalDownloadPerMinute,
    quantumTowerStacks: bandwidth.activeTowerStacks,
    quantumCollectorStacks: lookup?.quantumCollectorStacks ?? collectors.reduce((sum, entity) =>
      sum + (isQuantumCollector(entity) ? Math.max(0, Math.floor(entity.machineCount)) : 0), 0),
  };
}

/** Download before output belts so a demand tower can use reserved line space. */
function settleQuantumNetworkDownloads(
  state: GameState,
  credits: OutputCapacityCredits,
  boundarySecond: number,
  seconds = QUANTUM_SETTLEMENT_SECONDS,
  lookup?: SimulationLookupContext,
  profiler?: SimulationProfiler,
): QuantumBoundaryFlow | null {
  if (!state.quantumLogisticsNetwork?.enabled) return null;
  const flow = createQuantumBoundaryFlow(state, boundarySecond, lookup);
  const stations = lookup?.quantumStations ?? state.entities.filter(isQuantumStation);
  const stationById = lookup?.entityById ?? new Map(stations.map((station) => [station.id, station]));
  const requestByStationItem = new Map<string, QuantumSettlementOutput>();
  const downloadPlans = lookup?.quantumDownloadSlots ?? stations.flatMap((endpoint): IndexedQuantumSlotPlan[] => {
    const byKey = new Map<string, IndexedQuantumSlotPlan>();
    for (const slot of getStationSlots(endpoint)) {
      if (!slot.itemId || slot.remoteMode !== "demand") continue;
      const key = `${endpoint.id}:${slot.itemId}`;
      const existing = byKey.get(key);
      if (!existing || (slot.priority ?? 1) > existing.priority) {
        byKey.set(key, { endpoint, itemId: slot.itemId, key, priority: slot.priority ?? 1, slot });
      }
    }
    return [...byKey.values()];
  });
  for (const plan of downloadPlans) {
      const { endpoint: station, slot, itemId, key, priority } = plan;
      const current = Math.max(0, Math.floor(station.outputs[itemId] ?? 0));
      const localCapacity = Math.max(0, Math.floor(getStationSlotCapacity(state, station, slot)));
      const incoming = stationInFlightCargo(station, itemId, lookup);
      const localFree = Math.max(0, localCapacity - current - incoming);
      // Existing over-capacity stock must drain instead of being backfilled.
      const directThrough = current <= localCapacity ? outputCapacityCredit(credits, station, itemId) : 0;
      const capacity = Math.min(Number.MAX_SAFE_INTEGER, localFree + directThrough);
      if (capacity < 1) continue;
      const existing = requestByStationItem.get(key);
      if (!existing || priority > (existing.priority ?? 1)) {
        requestByStationItem.set(key, {
          key,
          stationId: station.id,
          itemId,
          requested: capacity,
          capacity,
          priority,
        });
      }
  }
  const outputs = [...requestByStationItem.values()];
  if (profiler) {
    profiler.quantumStationCount += stations.length;
    profiler.quantumRequestCount += outputs.length;
  }
  const result = settleQuantumLogisticsNetwork(state.quantumLogisticsNetwork, [], outputs, {
    seconds,
    globalDownloadCap: quantumBoundaryCapacity(flow.globalDownloadPerMinute, seconds),
    mutateNormalizedState: true,
  });
  state.quantumLogisticsNetwork = result.state;
  // Keep the runtime flow object attached to the post-settlement network so
  // same-step local drone deliveries can append their immediate uploads.
  state.quantumLogisticsNetwork.runtimeFlow = flow;
  for (const request of outputs) {
    const station = stationById.get(request.stationId);
    if (!station) continue;
    const delivered = Math.max(0, Math.floor(Number(result.outputDelivered[request.key] ?? "0")));
    if (delivered < 1) continue;
    station.outputs[request.itemId] = Math.floor((station.outputs[request.itemId] ?? 0) + delivered);
    station.stationLastTransfer = delivered;
    station.productionRate += seconds > EPSILON ? delivered * 60 / seconds : 0;
    addQuantumBoundaryFlow(flow.downloaded, request.itemId, delivered);
  }
  return flow;
}

/** Upload after legacy routes advance so handoff tails keep their old owner. */
function settleQuantumNetworkUploads(
  state: GameState,
  boundarySecond: number,
  previousFlow: QuantumBoundaryFlow | null,
  seconds = QUANTUM_SETTLEMENT_SECONDS,
  lookup?: SimulationLookupContext,
  profiler?: SimulationProfiler,
): void {
  if (!state.quantumLogisticsNetwork?.enabled) return;
  const flow = previousFlow ?? createQuantumBoundaryFlow(state, boundarySecond, lookup);
  if (state.quantumLogisticsNetwork.runtimeFlow && state.quantumLogisticsNetwork.runtimeFlow !== flow) {
    for (const [itemId, amount] of Object.entries(state.quantumLogisticsNetwork.runtimeFlow.uploaded)) {
      addQuantumBoundaryFlow(flow.uploaded, itemId as ItemId, Number(amount));
    }
  }
  state.quantumLogisticsNetwork.runtimeFlow = flow;
  // Attachment may have completed after the download phase. Refresh the
  // shared budget before accepting supply, without granting collectors any
  // separate bandwidth of their own.
  const stationEntities = lookup?.stations ?? state.entities;
  const collectors = lookup?.orbitalCollectors ?? state.entities.filter((entity) => entity.buildingId === "orbital_collector");
  const bandwidth = quantumBoundaryBandwidth(state, lookup);
  flow.globalUploadPerMinute = bandwidth.globalUploadPerMinute;
  flow.globalDownloadPerMinute = bandwidth.globalDownloadPerMinute;
  flow.quantumTowerStacks = bandwidth.activeTowerStacks;
  flow.quantumCollectorStacks = lookup?.quantumCollectorStacks ?? collectors.reduce((sum, entity) =>
    sum + (isQuantumCollector(entity) ? Math.max(0, Math.floor(entity.machineCount)) : 0), 0);

  const endpoints = lookup?.quantumEndpoints ?? stationEntities.filter((entity) => isQuantumStation(entity) || isQuantumCollector(entity));
  const endpointById = lookup?.entityById ?? new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  // Existing tower buffers are an overflow path only. Drain them directly
  // before building the legacy boundary requests so newly freed inventory is
  // never throttled by the five-second upload budget.
  if (lookup) {
    for (const plan of lookup.quantumUploadSlots) flushQuantumSupplyBuffer(state, plan.endpoint, plan.itemId, lookup);
  } else {
    for (const endpoint of endpoints) {
      if (!isQuantumStation(endpoint)) continue;
      for (const slot of getStationSlots(endpoint)) {
        if (slot.itemId && slot.remoteMode === "supply") flushQuantumSupplyBuffer(state, endpoint, slot.itemId, lookup);
      }
    }
  }
  const requestByEndpointItem = new Map<string, QuantumSettlementInput>();
  for (const endpoint of endpoints) {
    if (isQuantumCollector(endpoint)) {
      const itemId = endpoint.storedItemId;
      const available = itemId ? Math.max(0, Math.floor(endpoint.outputs[itemId] ?? 0)) : 0;
      if (itemId && available > 0) {
        const key = `${endpoint.id}:${itemId}`;
        requestByEndpointItem.set(key, { key, stationId: endpoint.id, itemId, requested: available, priority: 1 });
      }
      continue;
    }
    if (!lookup) {
      for (const slot of getStationSlots(endpoint)) {
        if (!slot.itemId || slot.remoteMode !== "supply") continue;
        const reserved = stationReservedOutgoing(state, endpoint.id, slot.itemId, lookup);
        const available = Math.max(0, Math.floor((endpoint.outputs[slot.itemId] ?? 0) - slot.minStock - reserved));
        if (available < 1) continue;
        const key = `${endpoint.id}:${slot.itemId}`;
        const existing = requestByEndpointItem.get(key);
        if (!existing || (slot.priority ?? 1) > (existing.priority ?? 1)) {
          requestByEndpointItem.set(key, {
            key,
            stationId: endpoint.id,
            itemId: slot.itemId,
            requested: available,
            priority: slot.priority,
          });
        }
      }
    }
  }
  if (lookup) {
    for (const plan of lookup.quantumUploadSlots) {
      const reserved = stationReservedOutgoing(state, plan.endpoint.id, plan.itemId, lookup);
      const available = Math.max(0, Math.floor((plan.endpoint.outputs[plan.itemId] ?? 0) - plan.slot.minStock - reserved));
      if (available < 1) continue;
      requestByEndpointItem.set(plan.key, {
        key: plan.key,
        stationId: plan.endpoint.id,
        itemId: plan.itemId,
        requested: available,
        priority: plan.priority,
      });
    }
  }
  const inputs = [...requestByEndpointItem.values()];
  if (profiler) profiler.quantumRequestCount += inputs.length;
  const result = settleQuantumLogisticsNetwork(state.quantumLogisticsNetwork, inputs, [], {
    seconds,
    globalUploadCap: quantumBoundaryCapacity(flow.globalUploadPerMinute, seconds),
    mutateNormalizedState: true,
  });
  state.quantumLogisticsNetwork = result.state;
  for (const request of inputs) {
    const endpoint = endpointById.get(request.stationId);
    if (!endpoint) continue;
    const accepted = Math.max(0, Math.floor(Number(result.inputAccepted[request.key] ?? "0")));
    if (accepted < 1) continue;
    endpoint.outputs[request.itemId] = Math.max(0, Math.floor(endpoint.outputs[request.itemId] ?? 0) - accepted);
    endpoint.stationLastTransfer = accepted;
    addQuantumBoundaryFlow(flow.uploaded, request.itemId, accepted);
  }
  state.quantumLogisticsNetwork.runtimeFlow = flow;
}

export interface SimulationBeltStepReservation {
  allowanceByBelt: Map<string, number>;
  outputCredits: Map<string, number>;
}

export interface SimulationStepPrepared {
  elapsedBeforeStep: number;
  projectedElapsed: number;
  firstHubBoundary: number;
  lastHubBoundary: number;
  quantumBoundarySecond: number | null;
  quantumBoundaryFlow: QuantumBoundaryFlow | null;
  beltStepReservation: SimulationBeltStepReservation;
  reception: SimulationDysonReceptionPlan;
}

export interface SimulationPlanetPhaseResult {
  planetId: PlanetId;
  entities: FactoryEntity[];
  powerGridMetrics: GameState["powerGridMetrics"][PlanetId];
  planetMetrics: GameState["planetMetrics"][PlanetId];
  totalProducedDelta: Partial<Record<ItemId, number>>;
  totalProducedKeys: ItemId[];
  powerPlan: SimulationPowerPlan;
}

/**
 * Executes the mutable, planet-local part of a simulation step. The caller
 * must keep global logistics/quantum phases at a barrier and merge the
 * returned entity and counter deltas in stable planet order.
 */
export function runPlanetSimulationPhase(
  state: GameState,
  seconds: number,
  planetId: PlanetId,
  reception: SimulationDysonReceptionPlan,
  beltStepReservation: SimulationBeltStepReservation,
  lookup?: SimulationLookupContext,
  profiler?: SimulationProfiler,
  batchPowerStorage = true,
  batchConstructionAutomation = true,
  contractExperiment?: SimulationContractExperiment,
): SimulationPlanetPhaseResult {
  const phaseLookup = lookup ?? createSimulationLookupContext(state, profiler);
  if (!lookup) ensureDynamicRouteLookup(state, phaseLookup);
  const baselineProduced = { ...state.totalProduced };
  let subsystemStartedAt = profiler ? profileNow() : 0;
  const gridPlans = POWER_GRID_IDS.map((gridId) => calculatePower(state, seconds, planetId, gridId, reception, phaseLookup, profiler));
  const power = combinePowerPlans(gridPlans);
  for (const gridPlan of gridPlans) {
    const gridId = gridPlan.gridId!;
    const storage = gridStoredEnergy(state, planetId, gridId, lookup);
    state.powerGridMetrics[planetId][gridId] = {
      gridId,
      generationKw: round(gridPlan.generationKw, 2),
      demandKw: round(gridPlan.demandKw, 2),
      powerFactor: round(gridPlan.factor, 4),
      windGenerationKw: round(gridPlan.windGenerationKw, 2),
      solarGenerationKw: round(gridPlan.solarGenerationKw, 2),
      geothermalGenerationKw: round(gridPlan.geothermalGenerationKw, 2),
      thermalGenerationKw: round(gridPlan.thermalGenerationKw, 2),
      fusionGenerationKw: round(gridPlan.fusionGenerationKw, 2),
      artificialStarGenerationKw: round(gridPlan.artificialStarGenerationKw, 2),
      rayGenerationKw: round(gridPlan.rayGenerationKw, 2),
      storageDischargeKw: round(gridPlan.storageDischargeKw, 2),
      storageChargeKw: round(gridPlan.storageChargeKw, 2),
      storedEnergyMj: round(storage.stored, 3),
      storageCapacityMj: round(storage.capacity, 3),
      fuelReserveSeconds: fuelReserveSeconds(state, planetId, gridId, lookup),
      totalItemsPerMinute: 0,
      connectedEntities: gridPlan.connectedEntities,
      disconnectedEntities: gridPlan.disconnectedEntities,
      generatorCount: gridPlan.generatorCount,
      coverageRadius: POWER_SUPPLY_RADIUS,
    };
  }
  runPowerFacilities(
    state,
    seconds,
    power,
    planetId,
    phaseLookup.entitiesByPlanet.get(planetId) ?? [],
    batchPowerStorage,
    profiler,
  );
  if (profiler) profiler.powerMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  contractExperiment?.beforePlanetProduction?.(state, planetId);
  runMiners(state, seconds, power, planetId, beltStepReservation.outputCredits, phaseLookup, contractExperiment?.skippedProductionEntityIds);
  runMachines(state, seconds, power, planetId, beltStepReservation.outputCredits, phaseLookup, contractExperiment?.skippedProductionEntityIds);
  contractExperiment?.afterPlanetProduction?.(state, planetId);
  if (profiler) profiler.productionMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  runConstructionCenters(
    state,
    seconds,
    power,
    planetId,
    phaseLookup.entitiesByPlanet.get(planetId) ?? [],
    batchConstructionAutomation,
    profiler,
    phaseLookup,
  );
  if (profiler) profiler.constructionMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  runRayReceivers(state, seconds, reception, planetId, beltStepReservation.outputCredits, phaseLookup.entitiesByPlanet.get(planetId) ?? []);
  if (profiler) profiler.dysonMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  const storage = gridStoredEnergy(state, planetId, undefined, phaseLookup);
  state.planetMetrics[planetId] = {
    generationKw: round(power.generationKw, 2),
    demandKw: round(power.demandKw, 2),
    powerFactor: round(power.factor, 4),
    windGenerationKw: round(power.windGenerationKw, 2),
    solarGenerationKw: round(power.solarGenerationKw, 2),
    geothermalGenerationKw: round(power.geothermalGenerationKw, 2),
    thermalGenerationKw: round(power.thermalGenerationKw, 2),
    fusionGenerationKw: round(power.fusionGenerationKw, 2),
    artificialStarGenerationKw: round(power.artificialStarGenerationKw, 2),
    rayGenerationKw: round(power.rayGenerationKw, 2),
    storageDischargeKw: round(power.storageDischargeKw, 2),
    storageChargeKw: round(power.storageChargeKw, 2),
    storedEnergyMj: round(storage.stored, 3),
    storageCapacityMj: round(storage.capacity, 3),
    fuelReserveSeconds: fuelReserveSeconds(state, planetId),
    totalItemsPerMinute: round((phaseLookup.entitiesByPlanet.get(planetId) ?? []).reduce((sum, entity) =>
      entity.planetId === planetId ? sum + entity.productionRate : sum, 0), 2),
  };
  if (profiler) profiler.powerMs += profileNow() - subsystemStartedAt;
  const localEntities = phaseLookup.entitiesByPlanet.get(planetId) ?? [];
  const totalProducedDelta: Partial<Record<ItemId, number>> = {};
  for (const [itemId, amount] of Object.entries(state.totalProduced)) {
    const delta = Math.floor(amount ?? 0) - Math.floor(baselineProduced[itemId as ItemId] ?? 0);
    if (delta !== 0) totalProducedDelta[itemId as ItemId] = delta;
  }
  return {
    planetId,
    entities: localEntities,
    powerGridMetrics: state.powerGridMetrics[planetId],
    planetMetrics: state.planetMetrics[planetId],
    totalProducedDelta,
    totalProducedKeys: Object.keys(state.totalProduced) as ItemId[],
    powerPlan: power,
  };
}

/** Runs the stateful global prefix before planet-local work. */
export function prepareSimulationStep(
  state: GameState,
  seconds: number,
  lookup?: SimulationLookupContext,
  profiler?: SimulationProfiler,
  contractExperiment?: SimulationContractExperiment,
): SimulationStepPrepared {
  const elapsedBeforeStep = state.elapsedSeconds;
  const projectedElapsed = round(elapsedBeforeStep + seconds);
  const firstHubBoundary = Math.floor(elapsedBeforeStep / SYSTEM_HUB_SETTLEMENT_SECONDS) + 1;
  const lastHubBoundary = Math.floor(projectedElapsed / SYSTEM_HUB_SETTLEMENT_SECONDS);
  const quantumBoundarySecond = firstHubBoundary <= lastHubBoundary
    ? firstHubBoundary * SYSTEM_HUB_SETTLEMENT_SECONDS
    : null;
  prepareTimeWarpStep(state, lookup);
  if (lookup) ensureDynamicRouteLookup(state, lookup);
  advanceExplorationMissions(state, seconds);
  let subsystemStartedAt = profiler ? profileNow() : 0;
  advanceHandcraftQueue(state, seconds);
  if (profiler) profiler.constructionMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  absorbDysonSails(state, seconds);
  decayDysonSwarm(state, seconds);
  if (profiler) profiler.dysonMs += profileNow() - subsystemStartedAt;
  resetStationRuntime(state, lookup);
  subsystemStartedAt = profiler ? profileNow() : 0;
  transferLogisticsBuffers(state, lookup);
  if (profiler) profiler.logisticsMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  contractExperiment?.beforeInputBelts?.(state);
  transferBelts(state, seconds, true, undefined, seconds, lookup, contractExperiment?.skippedBeltIds, profiler);
  contractExperiment?.afterInputBelts?.(state);
  if (profiler) profiler.beltsMs += profileNow() - subsystemStartedAt;
  const beltStepReservation = reserveBeltStepOutputCapacity(state, lookup, contractExperiment?.skippedBeltIds, profiler);
  runOrbitalCollectors(state, seconds, beltStepReservation.outputCredits, lookup);
  subsystemStartedAt = profiler ? profileNow() : 0;
  drainMaterialDeliveryHubs(state, seconds, lookup);
  if (profiler) profiler.logisticsMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  const reception = calculateDysonReception(state, lookup);
  if (profiler) profiler.dysonMs += profileNow() - subsystemStartedAt;
  return {
    elapsedBeforeStep,
    projectedElapsed,
    firstHubBoundary,
    lastHubBoundary,
    quantumBoundarySecond,
    quantumBoundaryFlow: null,
    beltStepReservation,
    reception,
  };
}

/** Runs the global barrier after all planet-local results have been merged. */
export function completeSimulationStep(
  state: GameState,
  seconds: number,
  prepared: SimulationStepPrepared,
  powerByPlanet: Map<PlanetId, PowerPlan>,
  lookup?: SimulationLookupContext,
  profiler?: SimulationProfiler,
  contractExperiment?: SimulationContractExperiment,
): void {
  let quantumBoundaryFlow = prepared.quantumBoundaryFlow;
  if (prepared.quantumBoundarySecond !== null) {
    const quantumStartedAt = profiler ? profileNow() : 0;
    quantumBoundaryFlow = settleQuantumNetworkDownloads(
      state,
      prepared.beltStepReservation.outputCredits,
      prepared.quantumBoundarySecond,
      QUANTUM_SETTLEMENT_SECONDS,
      lookup,
      profiler,
    );
    if (profiler) profiler.quantumMs += profileNow() - quantumStartedAt;
  }
  let subsystemStartedAt = profiler ? profileNow() : 0;
  contractExperiment?.beforeOutputBelts?.(state);
  transferBelts(state, 0, false, prepared.beltStepReservation.allowanceByBelt, seconds, lookup, contractExperiment?.skippedBeltIds, profiler);
  contractExperiment?.afterOutputBelts?.(state);
  if (profiler) profiler.beltsMs += profileNow() - subsystemStartedAt;
  drainMaterialDeliveryHubs(state, seconds, lookup);
  subsystemStartedAt = profiler ? profileNow() : 0;
  refillStationWarpers(state, lookup);
  let phaseStartedAt = profileNow();
  if (lookup) {
    refreshRouteEnvironment(state, lookup);
    lookup.dispatchResultsBySlot.clear();
  }
  dispatchStationScope(state, "local", powerByPlanet, lookup, profiler);
  dispatchStationScope(state, "remote", powerByPlanet, lookup, profiler);
  if (profiler) profiler.dispatchMs += profileNow() - phaseStartedAt;
  phaseStartedAt = profileNow();
  advanceStationRoutes(state, "local", seconds, powerByPlanet, lookup);
  advanceStationRoutes(state, "remote", seconds, powerByPlanet, lookup);
  refillStationWarpers(state, lookup);
  if (profiler) profiler.routeAdvanceMs += profileNow() - phaseStartedAt;
  if (lookup) ensureDynamicRouteLookup(state, lookup);
  phaseStartedAt = profileNow();
  updateStationCongestion(state, lookup, profiler);
  if (profiler) profiler.congestionMs += profileNow() - phaseStartedAt;
  if (profiler) profiler.logisticsMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  runGalacticMaterialExporters(state, powerByPlanet, lookup);
  runGalacticExports(state, seconds);
  if (profiler) profiler.logisticsMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  syncLegacySwarmIntoOrbits(state);
  updateDysonSphereGeneration(state);
  if (profiler) profiler.dysonMs += profileNow() - subsystemStartedAt;
  state.dysonSwarm.receiverLoadKw = round(prepared.reception.receiverLoadKw, 2);
  state.elapsedSeconds = prepared.projectedElapsed;
  let boundaryLookupDirty = false;
  for (let boundary = prepared.firstHubBoundary; boundary <= prepared.lastHubBoundary; boundary += 1) {
    for (const station of state.entities) {
      if (station.stationModeTransition) {
        const transitioned = completeStationOperationModeTransition(state, station.id);
        if (transitioned !== state) {
          state.entities = transitioned.entities;
          boundaryLookupDirty = true;
        }
      }
    }
    const quantumStartedAt = profiler ? profileNow() : 0;
    if (isTechnologyCompleted(state, "quantum_logistics_network")) {
      const plannedStationIds = state.entities
        .filter((entity) => entity.buildingId === "interstellar_logistics_station" && entity.quantumTarget === true &&
          (entity.stationTier ?? 1) >= 2 && entity.quantumMode !== "quantum" && !entity.quantumTransition)
        .map((entity) => entity.id);
      if (plannedStationIds.length > 0) {
        const planned = beginQuantumAttachments(state, plannedStationIds);
        if (planned.startedIds.length > 0) {
          const started = new Set(planned.startedIds);
          state.entities = planned.state.entities.map((entity) => started.has(entity.id) ? { ...entity, quantumTarget: undefined } : entity);
          boundaryLookupDirty = true;
        }
      }
    }
    const transitionedQuantum = settleQuantumAttachments(state);
    if (transitionedQuantum.changed) {
      state.entities = transitionedQuantum.state.entities;
      state.quantumLogisticsNetwork = transitionedQuantum.state.quantumLogisticsNetwork;
      boundaryLookupDirty = true;
    }
    settleSpaceStationConstructionInputs(state);
    settleSystemHubLogistics(state, boundary * SYSTEM_HUB_SETTLEMENT_SECONDS);
    settleQuantumNetworkUploads(
      state,
      boundary * SYSTEM_HUB_SETTLEMENT_SECONDS,
      quantumBoundaryFlow,
      QUANTUM_SETTLEMENT_SECONDS,
      lookup,
      profiler,
    );
    if (profiler) profiler.quantumMs += profileNow() - quantumStartedAt;
  }
  if (lookup && boundaryLookupDirty) {
    Object.assign(lookup, createSimulationLookupContext(state, profiler, lookup.constructionAutomationPlanCache));
  }
  if (state.endgame.exportWindowStartedAt <= 0) state.endgame.exportWindowStartedAt = state.elapsedSeconds;
  const exportWindowSeconds = state.elapsedSeconds - state.endgame.exportWindowStartedAt;
  if (exportWindowSeconds >= 10 - EPSILON) {
    state.endgame.exportedLastMinute = round(state.endgame.exportWindowAmount * 60 / exportWindowSeconds, 2);
    state.endgame.exportWindowAmount = 0;
    state.endgame.exportWindowStartedAt = state.elapsedSeconds;
  }
  state.metrics = { ...state.planetMetrics[state.activePlanetId] };
}

export interface SimulationPlanetPhaseExecutor {
  run(
    state: GameState,
    seconds: number,
    prepared: SimulationStepPrepared,
    planetIds: readonly PlanetId[],
    options: { batchPowerStorage: boolean; batchConstructionAutomation: boolean },
  ): Promise<SimulationPlanetPhaseResult[]>;
}

export function mergeSimulationPlanetPhaseResults(
  state: GameState,
  results: readonly SimulationPlanetPhaseResult[],
): Map<PlanetId, PowerPlan> {
  const entityById = new Map(state.entities.map((entity) => [entity.id, entity]));
  const expectedEntityIds = new Set(entityById.keys());
  const expectedPlanets = new Set(PLANET_LIST.map((planet) => planet.id));
  const seenPlanets = new Set<PlanetId>();
  const returnedEntityIds = new Set<string>();
  const orderedResults = [...results].sort((left, right) => left.planetId.localeCompare(right.planetId));

  // Validate the complete barrier before mutating the authoritative state.
  // A missing or duplicated partition must never leave a partially merged
  // state visible to the coordinator or to the next simulation request.
  for (const result of orderedResults) {
    if (!expectedPlanets.has(result.planetId)) throw new Error(`星球分区返回了未知星球：${result.planetId}`);
    if (seenPlanets.has(result.planetId)) throw new Error(`重复的星球分区结果：${result.planetId}`);
    seenPlanets.add(result.planetId);
    for (const entity of result.entities) {
      const target = entityById.get(entity.id);
      if (!target || target.planetId !== result.planetId) throw new Error(`星球分区返回了未知实体：${entity.id}`);
      if (returnedEntityIds.has(entity.id)) throw new Error(`实体出现在多个星球分区：${entity.id}`);
      returnedEntityIds.add(entity.id);
    }
  }
  if (seenPlanets.size !== expectedPlanets.size || [...expectedPlanets].some((planetId) => !seenPlanets.has(planetId))) {
    throw new Error("星球分区结果不完整");
  }
  if (returnedEntityIds.size !== expectedEntityIds.size || [...expectedEntityIds].some((entityId) => !returnedEntityIds.has(entityId))) {
    throw new Error("星球分区实体结果不完整");
  }

  const powerByPlanet = new Map<PlanetId, PowerPlan>();
  for (const result of orderedResults) {
    for (const entity of result.entities) {
      const target = entityById.get(entity.id);
      // The complete validation pass above guarantees the lookup succeeds.
      if (!target) throw new Error(`星球分区返回了未知实体：${entity.id}`);
      Object.assign(target, entity);
    }
    state.powerGridMetrics[result.planetId] = result.powerGridMetrics;
    state.planetMetrics[result.planetId] = result.planetMetrics;
    for (const [itemId, delta] of Object.entries(result.totalProducedDelta)) {
      state.totalProduced[itemId as ItemId] = Math.floor((state.totalProduced[itemId as ItemId] ?? 0) + (delta ?? 0));
    }
    for (const itemId of result.totalProducedKeys) {
      if (!(itemId in state.totalProduced)) state.totalProduced[itemId] = 0;
    }
    powerByPlanet.set(result.planetId, result.powerPlan);
  }
  return powerByPlanet;
}

/**
 * Async counterpart used only by the opt-in P6 coordinator. Global phases are
 * never executed in child workers; only the planet-local phase crosses the
 * worker boundary, then results are merged before logistics/quantum settle.
 */
export async function advanceSimulationSessionMulticore(
  session: SimulationAdvanceSession,
  maximumSteps: number,
  execute: SimulationPlanetPhaseExecutor,
): Promise<number> {
  const stepLimit = Math.max(0, Math.floor(Number.isFinite(maximumSteps) ? maximumSteps : 0));
  let steps = 0;
  if (session.remainingSeconds <= EPSILON && session.remainingWallSeconds > EPSILON && steps < stepLimit) {
    const activity = session.state.endgame.constructionActivity;
    session.advancedWallSeconds += session.remainingWallSeconds;
    if (session.state.speedrun?.enabled) {
      const advanced = advanceSpeedrunClock(session.state, session.remainingWallSeconds);
      if (advanced !== session.state) session.state = advanced;
    }
    if (activity.activityId) activity.activityClockMs = Math.max(0, Math.floor(session.initialActivityClockMs + session.advancedWallSeconds * 1_000));
    session.remainingWallSeconds = 0;
    return 1;
  }
  while (session.remainingSeconds > EPSILON && steps < stepLimit) {
    let step = Math.min(session.stepSize, session.remainingSeconds);
    const activity = session.state.endgame.constructionActivity;
    const wallPerSimulationSecond = session.remainingSeconds > EPSILON
      ? session.remainingWallSeconds / session.remainingSeconds
      : 0;
    if (activity.activityId) {
      for (const boundaryMs of [activity.startsAtMs, activity.endsAtMs]) {
        const untilBoundaryWall = (boundaryMs - activity.activityClockMs) / 1_000;
        const untilBoundarySimulation = wallPerSimulationSecond > EPSILON
          ? untilBoundaryWall / wallPerSimulationSecond
          : Number.POSITIVE_INFINITY;
        if (untilBoundarySimulation > EPSILON && untilBoundarySimulation < step - EPSILON) step = untilBoundarySimulation;
      }
    }
    const prepared = prepareSimulationStep(session.state, step, session.lookup, session.profiler, session.contractExperiment);
    const results = await execute.run(session.state, step, prepared, PLANET_LIST.map((planet) => planet.id), {
      batchPowerStorage: session.batchPowerStorage,
      batchConstructionAutomation: session.batchConstructionAutomation,
    });
    const powerByPlanet = mergeSimulationPlanetPhaseResults(session.state, results);
    completeSimulationStep(session.state, step, prepared, powerByPlanet, session.lookup, session.profiler, session.contractExperiment);
    const wallStep = Math.min(session.remainingWallSeconds, step * wallPerSimulationSecond);
    if (session.state.speedrun?.enabled) {
      const advanced = advanceSpeedrunClock(session.state, wallStep);
      if (advanced !== session.state) session.state = advanced;
    }
    if (activity.activityId && wallStep > 0) {
      session.advancedWallSeconds += wallStep;
      activity.activityClockMs = Math.max(0, Math.floor(session.initialActivityClockMs + session.advancedWallSeconds * 1_000));
    }
    session.remainingSeconds = Math.max(0, session.remainingSeconds - step);
    session.remainingWallSeconds = Math.max(0, session.remainingWallSeconds - wallStep);
    steps += 1;
  }
  return steps;
}

function simulateStep(
  state: GameState,
  seconds: number,
  lookup?: SimulationLookupContext,
  profiler?: SimulationProfiler,
  batchPowerStorage = true,
  batchConstructionAutomation = true,
  contractExperiment?: SimulationContractExperiment,
): void {
  const elapsedBeforeStep = state.elapsedSeconds;
  const projectedElapsed = round(elapsedBeforeStep + seconds);
  const firstHubBoundary = Math.floor(elapsedBeforeStep / SYSTEM_HUB_SETTLEMENT_SECONDS) + 1;
  const lastHubBoundary = Math.floor(projectedElapsed / SYSTEM_HUB_SETTLEMENT_SECONDS);
  const quantumBoundarySecond = firstHubBoundary <= lastHubBoundary
    ? firstHubBoundary * SYSTEM_HUB_SETTLEMENT_SECONDS
    : null;
  let quantumBoundaryFlow: QuantumBoundaryFlow | null = null;
  prepareTimeWarpStep(state, lookup);
  if (lookup) ensureDynamicRouteLookup(state, lookup);
  advanceExplorationMissions(state, seconds);
  let subsystemStartedAt = profiler ? profileNow() : 0;
  advanceHandcraftQueue(state, seconds);
  if (profiler) profiler.constructionMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  absorbDysonSails(state, seconds);
  decayDysonSwarm(state, seconds);
  if (profiler) profiler.dysonMs += profileNow() - subsystemStartedAt;
  resetStationRuntime(state, lookup);
  subsystemStartedAt = profiler ? profileNow() : 0;
  transferLogisticsBuffers(state, lookup);
  if (profiler) profiler.logisticsMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  contractExperiment?.beforeInputBelts?.(state);
  transferBelts(state, seconds, true, undefined, seconds, lookup, contractExperiment?.skippedBeltIds, profiler);
  contractExperiment?.afterInputBelts?.(state);
  if (profiler) profiler.beltsMs += profileNow() - subsystemStartedAt;
  const beltStepReservation = reserveBeltStepOutputCapacity(state, lookup, contractExperiment?.skippedBeltIds, profiler);
  runOrbitalCollectors(state, seconds, beltStepReservation.outputCredits, lookup);
  subsystemStartedAt = profiler ? profileNow() : 0;
  drainMaterialDeliveryHubs(state, seconds, lookup);
  if (profiler) profiler.logisticsMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  const reception = calculateDysonReception(state);
  if (profiler) profiler.dysonMs += profileNow() - subsystemStartedAt;
  const powerByPlanet = new Map<PlanetId, PowerPlan>();
  for (const planet of PLANET_LIST) {
    const result = runPlanetSimulationPhase(
      state,
      seconds,
      planet.id,
      reception,
      beltStepReservation,
      lookup,
      profiler,
      batchPowerStorage,
      batchConstructionAutomation,
      contractExperiment,
    );
    powerByPlanet.set(planet.id, result.powerPlan);
  }
  if (quantumBoundarySecond !== null) {
    const quantumStartedAt = profiler ? profileNow() : 0;
    quantumBoundaryFlow = settleQuantumNetworkDownloads(
      state,
      beltStepReservation.outputCredits,
      quantumBoundarySecond,
      QUANTUM_SETTLEMENT_SECONDS,
      lookup,
      profiler,
    );
    if (profiler) profiler.quantumMs += profileNow() - quantumStartedAt;
  }
  subsystemStartedAt = profiler ? profileNow() : 0;
  contractExperiment?.beforeOutputBelts?.(state);
  transferBelts(state, 0, false, beltStepReservation.allowanceByBelt, seconds, lookup, contractExperiment?.skippedBeltIds, profiler);
  contractExperiment?.afterOutputBelts?.(state);
  if (profiler) profiler.beltsMs += profileNow() - subsystemStartedAt;
  drainMaterialDeliveryHubs(state, seconds, lookup);
  subsystemStartedAt = profiler ? profileNow() : 0;
  refillStationWarpers(state, lookup);
  let phaseStartedAt = profileNow();
  if (lookup) {
    refreshRouteEnvironment(state, lookup);
    lookup.dispatchResultsBySlot.clear();
  }
  dispatchStationScope(state, "local", powerByPlanet, lookup, profiler);
  dispatchStationScope(state, "remote", powerByPlanet, lookup, profiler);
  if (profiler) profiler.dispatchMs += profileNow() - phaseStartedAt;
  phaseStartedAt = profileNow();
  advanceStationRoutes(state, "local", seconds, powerByPlanet, lookup);
  advanceStationRoutes(state, "remote", seconds, powerByPlanet, lookup);
  refillStationWarpers(state, lookup);
  if (profiler) profiler.routeAdvanceMs += profileNow() - phaseStartedAt;
  if (lookup) ensureDynamicRouteLookup(state, lookup);
  phaseStartedAt = profileNow();
  updateStationCongestion(state, lookup, profiler);
  if (profiler) profiler.congestionMs += profileNow() - phaseStartedAt;
  if (profiler) profiler.logisticsMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  runGalacticMaterialExporters(state, powerByPlanet, lookup);
  runGalacticExports(state, seconds);
  if (profiler) profiler.logisticsMs += profileNow() - subsystemStartedAt;
  subsystemStartedAt = profiler ? profileNow() : 0;
  syncLegacySwarmIntoOrbits(state);
  updateDysonSphereGeneration(state);
  if (profiler) profiler.dysonMs += profileNow() - subsystemStartedAt;
  state.dysonSwarm.receiverLoadKw = round(reception.receiverLoadKw, 2);
  state.elapsedSeconds = projectedElapsed;
  // System-hub logistics is deliberately quantized to five-second boundaries.
  // Iterate crossed boundaries so large offline steps cannot skip a settlement;
  // the elevator mode remains outside the legacy per-slot dispatch path.
  let boundaryLookupDirty = false;
  for (let boundary = firstHubBoundary; boundary <= lastHubBoundary; boundary += 1) {
    for (const station of state.entities) {
      if (station.stationModeTransition) {
        const transitioned = completeStationOperationModeTransition(state, station.id);
        if (transitioned !== state) {
          state.entities = transitioned.entities;
          boundaryLookupDirty = true;
        }
      }
    }
    const quantumStartedAt = profiler ? profileNow() : 0;
    if (isTechnologyCompleted(state, "quantum_logistics_network")) {
      const plannedStationIds = state.entities
        .filter((entity) => entity.buildingId === "interstellar_logistics_station" && entity.quantumTarget === true &&
          (entity.stationTier ?? 1) >= 2 && entity.quantumMode !== "quantum" && !entity.quantumTransition)
        .map((entity) => entity.id);
      if (plannedStationIds.length > 0) {
        const planned = beginQuantumAttachments(state, plannedStationIds);
        if (planned.startedIds.length > 0) {
          const started = new Set(planned.startedIds);
          state.entities = planned.state.entities.map((entity) => started.has(entity.id) ? { ...entity, quantumTarget: undefined } : entity);
          boundaryLookupDirty = true;
        }
      }
    }
    const transitionedQuantum = settleQuantumAttachments(state);
    if (transitionedQuantum.changed) {
      state.entities = transitionedQuantum.state.entities;
      state.quantumLogisticsNetwork = transitionedQuantum.state.quantumLogisticsNetwork;
      boundaryLookupDirty = true;
    }
    settleSpaceStationConstructionInputs(state);
    settleSystemHubLogistics(state, boundary * SYSTEM_HUB_SETTLEMENT_SECONDS);
    settleQuantumNetworkUploads(
      state,
      boundary * SYSTEM_HUB_SETTLEMENT_SECONDS,
      quantumBoundaryFlow,
      QUANTUM_SETTLEMENT_SECONDS,
      lookup,
      profiler,
    );
    if (profiler) profiler.quantumMs += profileNow() - quantumStartedAt;
  }
  if (lookup && boundaryLookupDirty) {
    Object.assign(lookup, createSimulationLookupContext(state, profiler, lookup.constructionAutomationPlanCache));
  }
  if (state.endgame.exportWindowStartedAt <= 0) state.endgame.exportWindowStartedAt = state.elapsedSeconds;
  const exportWindowSeconds = state.elapsedSeconds - state.endgame.exportWindowStartedAt;
  if (exportWindowSeconds >= 10 - EPSILON) {
    state.endgame.exportedLastMinute = round(state.endgame.exportWindowAmount * 60 / exportWindowSeconds, 2);
    state.endgame.exportWindowAmount = 0;
    state.endgame.exportWindowStartedAt = state.elapsedSeconds;
  }
  state.metrics = { ...state.planetMetrics[state.activePlanetId] };
}

function recordProductionHistory(state: GameState, lookup?: SimulationLookupContext): void {
  if (state.elapsedSeconds - state.historyRecordedAt < PRODUCTION_HISTORY_SAMPLE_SECONDS - EPSILON) return;
  const sampleDurationSeconds = Math.max(PRODUCTION_HISTORY_SAMPLE_SECONDS, state.elapsedSeconds - state.historyRecordedAt);
  const previousSample = state.productionHistory.at(-1);
  const previousBoundary = Math.floor(Math.max(0, state.elapsedSeconds - sampleDurationSeconds) / 10);
  const currentBoundary = Math.floor(Math.max(0, state.elapsedSeconds) / 10);
  const refreshDiagnostics = !previousSample || sampleDurationSeconds >= 10 || previousBoundary !== currentBoundary;
  const productionPerMinute: Partial<Record<ItemId, number>> = {};
  const consumptionPerMinute: Partial<Record<ItemId, number>> = {};
  const planetProductionPerMinute: Partial<Record<PlanetId, Partial<Record<ItemId, number>>>> = {};
  const planetConsumptionPerMinute: Partial<Record<PlanetId, Partial<Record<ItemId, number>>>> = {};
  const inventory: Partial<Record<ItemId, number>> = refreshDiagnostics ? {} : { ...previousSample.inventory };
  const add = (record: Partial<Record<ItemId, number>>, itemId: ItemId, amount: number) => {
    record[itemId] = round((record[itemId] ?? 0) + amount, 2);
  };
  const addPlanet = (record: Partial<Record<PlanetId, Partial<Record<ItemId, number>>>>, planetId: PlanetId, itemId: ItemId, amount: number) => {
    const planetRecord = record[planetId] ?? {};
    planetRecord[itemId] = round((planetRecord[itemId] ?? 0) + amount, 2);
    record[planetId] = planetRecord;
  };
  for (const entity of state.entities) {
    if (entity.kind === "vein" && entity.resourceId) {
      add(productionPerMinute, entity.resourceId, entity.productionRate);
      addPlanet(planetProductionPerMinute, entity.planetId, entity.resourceId, entity.productionRate);
    }
    else if (entity.buildingId === "orbital_collector" && entity.storedItemId) {
      add(productionPerMinute, entity.storedItemId, entity.productionRate);
      addPlanet(planetProductionPerMinute, entity.planetId, entity.storedItemId, entity.productionRate);
    } else if (entity.kind === "machine") {
      const recipe = getRecipe(entity.recipeId);
      if (recipe && recipe.id !== "matrix_research") {
        for (const input of recipe.inputs) {
          const amount = entity.productionRate * input.amount;
          add(consumptionPerMinute, input.itemId, amount);
          addPlanet(planetConsumptionPerMinute, entity.planetId, input.itemId, amount);
        }
        for (const output of recipe.outputs) {
          const amount = entity.productionRate * output.amount;
          add(productionPerMinute, output.itemId, amount);
          addPlanet(planetProductionPerMinute, entity.planetId, output.itemId, amount);
        }
      }
    }
    if (refreshDiagnostics) {
      for (const [itemId, amount] of Object.entries(entity.inputs)) add(inventory, itemId as ItemId, Math.floor(amount ?? 0));
      for (const [itemId, amount] of Object.entries(entity.outputs)) add(inventory, itemId as ItemId, Math.floor(amount ?? 0));
    }
  }
  if (refreshDiagnostics) {
    for (const tray of Object.values(state.planetTrays)) {
      for (const [itemId, amount] of Object.entries(tray)) add(inventory, itemId as ItemId, Math.floor(amount ?? 0));
    }
  }
  const productiveEntities = refreshDiagnostics
    ? state.entities.filter((entity) => entity.kind === "machine" || (entity.kind === "vein" && entity.minerCount > 0))
    : [];
  const productiveUnits = productiveEntities.reduce((sum, entity) => sum + (entity.kind === "vein" ? entity.minerCount : entity.machineCount), 0);
  const utilizedUnits = productiveEntities.reduce((sum, entity) => sum + entity.utilization * (entity.kind === "vein" ? entity.minerCount : entity.machineCount), 0);
  const activeMachines = refreshDiagnostics
    ? productiveEntities.reduce((sum, entity) => sum + (entity.utilization > EPSILON ? (entity.kind === "vein" ? entity.minerCount : entity.machineCount) : 0), 0)
    : previousSample?.activeMachines ?? 0;
  const blockedMachines = refreshDiagnostics
    ? productiveEntities.reduce((sum, entity) => sum + (getEntityOperatingStatus(state, entity, lookup).tone === "blocked" ? (entity.kind === "vein" ? entity.minerCount : entity.machineCount) : 0), 0)
    : previousSample?.blockedMachines ?? 0;
  const beltCapacity = refreshDiagnostics ? state.belts.reduce((sum, belt) => sum + getBeltCapacity(belt), 0) : 0;
  const beltFlow = refreshDiagnostics ? state.belts.reduce((sum, belt) => sum + Math.max(0, belt.lastFlow ?? 0), 0) : 0;
  const totalPowerDemand = Object.values(state.planetMetrics).reduce((sum, metrics) => sum + metrics.demandKw, 0);
  const deliveredPower = Object.values(state.planetMetrics).reduce((sum, metrics) => sum + metrics.demandKw * metrics.powerFactor, 0);
  state.productionHistory.push({
    elapsedSeconds: state.elapsedSeconds,
    sampleDurationSeconds,
    productionPerMinute,
    consumptionPerMinute,
    planetProductionPerMinute,
    planetConsumptionPerMinute,
    inventory,
    generationKw: round(Object.values(state.planetMetrics).reduce((sum, metrics) => sum + metrics.generationKw, 0), 2),
    demandKw: round(Object.values(state.planetMetrics).reduce((sum, metrics) => sum + metrics.demandKw, 0), 2),
    machineEfficiency: refreshDiagnostics
      ? round(productiveUnits > 0 ? utilizedUnits / productiveUnits : 0, 4)
      : previousSample?.machineEfficiency ?? 0,
    logisticsEfficiency: refreshDiagnostics
      ? round(beltCapacity > 0 ? Math.min(1, beltFlow / beltCapacity) : 0, 4)
      : previousSample?.logisticsEfficiency ?? 0,
    powerEfficiency: round(totalPowerDemand > 0 ? Math.min(1, deliveredPower / totalPowerDemand) : 1, 4),
    activeMachines: Math.max(0, Math.floor(activeMachines)),
    blockedMachines: Math.max(0, Math.floor(blockedMachines)),
  });
  state.productionHistory = compactProductionHistory(state.productionHistory);
  state.historyRecordedAt = state.elapsedSeconds;
}

export interface SimulationAdvanceSession {
  originalState: GameState;
  state: GameState;
  totalSeconds: number;
  remainingSeconds: number;
  totalWallSeconds: number;
  remainingWallSeconds: number;
  initialActivityClockMs: number;
  advancedWallSeconds: number;
  stepSize: number;
  batchPowerStorage: boolean;
  batchConstructionAutomation: boolean;
  changed: boolean;
  lookup?: SimulationLookupContext;
  profiler?: SimulationProfiler;
  contractExperiment?: SimulationContractExperiment;
}

/**
 * A large save can contain thousands of inert storage/placeholder records.
 * When no subsystem has a scheduled boundary or mutable work, running the
 * complete production pipeline is both unnecessary and disproportionately
 * expensive. This predicate is intentionally strict; one active machine,
 * belt, station, mission, Dyson task, or time-warp controller keeps the exact
 * engine path.
 */
function canFastForwardQuiescentState(state: GameState): boolean {
  if (state.paused || state.timeWarp.enabled || state.timeWarp.controllerEntityId) return false;
  if (state.timeWarp.pendingSimulationSeconds > EPSILON || state.timeWarp.pendingWallSeconds > EPSILON) return false;
  if (state.entities.length === 0 && state.belts.length === 0) {
    // The remaining checks below cover global clocks and activities.
  } else if (state.belts.length > 0 || state.entities.some((entity) =>
    entity.kind === "machine" || entity.kind === "vein" || entity.kind === "power" ||
    entity.kind === "station" || (entity.stationRoutes?.length ?? 0) > 0 ||
    entity.buildingId === "galactic_material_exporter" || entity.buildingId === "construction_center" ||
    entity.buildingId === "space_station_construction_launcher" || entity.buildingId === "material_delivery_hub" ||
    entity.buildingId === "micro_black_hole_connector" || entity.buildingId === "time_warp_device" ||
    Object.values(entity.inputs).some((amount) => Math.floor(amount ?? 0) > 0))) return false;
  if (state.handcraftQueue.length > 0 || state.constructionQueue.length > 0 ||
    Object.keys(state.constructionAutomation.jobs).length > 0 ||
    (state.constructionAutomation.enabled && Object.keys(state.constructionAutomation.targetStock).length > 0)) return false;
  if (state.exploration.missions.length > 0 || state.endgame.constructionActivity.activityId ||
    state.endgame.activeInfiniteResearchId || Object.values(state.endgame.exportProjects).some((project) => project.enabled)) return false;
  if (state.dysonSwarm.totalLaunched > 0 || state.dysonSphere.totalRocketsLaunched > 0 ||
    (state.dysonEngineering.launchEnabled && state.entities.some((entity) =>
      entity.recipeId === "solar_sail_launch" || entity.recipeId === "carrier_rocket_launch")) ||
    Object.values(state.systemSpaceStations).some((station) => station?.status === "building")) return false;
  if (state.quantumLogisticsNetwork?.enabled && (
    Object.keys(state.quantumLogisticsNetwork.inventory).length > 0)) return false;
  return true;
}

function fastForwardQuiescentState(session: SimulationAdvanceSession): void {
  const state = session.state;
  const elapsedBefore = state.elapsedSeconds;
  const elapsedAfter = round(elapsedBefore + session.remainingSeconds);
  state.elapsedSeconds = elapsedAfter;
  const wallSeconds = session.remainingWallSeconds;
  if (wallSeconds > EPSILON) {
    if (state.speedrun?.enabled) {
      const advanced = advanceSpeedrunClock(state, wallSeconds);
      if (advanced !== state) session.state = advanced;
    }
    session.advancedWallSeconds += wallSeconds;
    session.remainingWallSeconds = 0;
  }
  if (state.endgame.exportWindowStartedAt <= 0) state.endgame.exportWindowStartedAt = elapsedBefore;
  const exportWindowSeconds = state.elapsedSeconds - state.endgame.exportWindowStartedAt;
  if (exportWindowSeconds >= 10 - EPSILON) {
    state.endgame.exportedLastMinute = round(state.endgame.exportWindowAmount * 60 / exportWindowSeconds, 2);
    state.endgame.exportWindowAmount = 0;
    // The exact engine resets this rolling window after every simulation
    // step. Preserve the final boundary instead of treating the whole bulk
    // interval as one observation, which would change the saved diagnostics.
    state.endgame.exportWindowStartedAt = Math.max(
      0,
      state.elapsedSeconds - Math.min(session.stepSize, session.remainingSeconds),
    );
  }
  session.state.metrics = { ...session.state.planetMetrics[session.state.activePlanetId] };
  session.remainingSeconds = 0;
}

export interface SimulationAdvanceOptions {
  indexedLogistics?: boolean;
  batchPowerStorage?: boolean;
  batchConstructionAutomation?: boolean;
  profiler?: SimulationProfiler;
  wallSeconds?: number;
  mutateState?: boolean;
  lookup?: SimulationLookupContext;
  contractExperiment?: SimulationContractExperiment;
}

export function createSimulationProfiler(): SimulationProfiler {
  return {
    copyStateMs: 0,
    productionMs: 0,
    beltsMs: 0,
    beltScanMs: 0,
    beltDistributeMs: 0,
    beltReserveMs: 0,
    logisticsMs: 0,
    quantumMs: 0,
    powerMs: 0,
    dysonMs: 0,
    constructionMs: 0,
    historyMs: 0,
    stationIndexBuildMs: 0,
    peerMatchMs: 0,
    routeEconomicsMs: 0,
    dispatchMs: 0,
    dispatchPeerSortMs: 0,
    routeAdvanceMs: 0,
    congestionMs: 0,
    peerCandidateChecks: 0,
    peerMatchCalls: 0,
    peerMatchCacheHits: 0,
    routeEconomicsCalls: 0,
    routeEconomicsCacheHits: 0,
    routePathPlans: 0,
    routePathCacheHits: 0,
    congestionDispatchReuseHits: 0,
    routesCreated: 0,
    dispatchSlotChecks: 0,
    dispatchPeerOrderChecks: 0,
    dispatchPeerVisits: 0,
    dispatchBlockedCacheHits: 0,
    quantumStationCount: 0,
    quantumRequestCount: 0,
    persistentRuntimeHits: 0,
    persistentRuntimeRebuilds: 0,
    fuelItemsLoaded: 0,
    exchangerCellsSettled: 0,
    constructionJobsBatched: 0,
    constructionPlanBuilds: 0,
    constructionPlanCacheHits: 0,
    constructionGuardHits: 0,
    constructionIterations: 0,
    beltRouteChecks: 0,
    beltTargetChecks: 0,
    beltStableRoutesSkipped: 0,
  };
}

export function createSimulationAdvanceSession(state: GameState, seconds: number, options: SimulationAdvanceOptions = {}): SimulationAdvanceSession {
  const requestedWallSeconds = options.wallSeconds ?? seconds;
  const totalWallSeconds = state.paused || !Number.isFinite(requestedWallSeconds) || requestedWallSeconds <= 0
    ? 0
    : Math.min(requestedWallSeconds, 30 * 24 * 60 * 60);
  const totalSeconds = state.paused || !Number.isFinite(seconds) || seconds <= 0
    ? 0
    : Math.min(seconds, 30 * 24 * 60 * 60);
  const baseStepSize = totalSeconds >= 24 * 60 * 60 ? 30 : totalSeconds > 8 * 60 * 60 ? 10 : 1;
  // Elevator contracts settle on a fixed five-second boundary. Keep a hub
  // session from jumping over those boundaries so 1s/5s/offline segmentation
  // observes the same input and output order.
  const hasBoundaryStation = state.entities.some((entity) => isElevatorStation(entity) || hasQuantumBoundaryLogistics(entity));
  const stepSize = hasBoundaryStation ? Math.min(baseStepSize, SYSTEM_HUB_SETTLEMENT_SECONDS) : baseStepSize;
  const copyStartedAt = profileNow();
  const sessionState = totalSeconds > 0 || totalWallSeconds > 0
    ? options.mutateState ? state : copyState(state)
    : state;
  if (options.profiler) options.profiler.copyStateMs += profileNow() - copyStartedAt;
  return {
    originalState: state,
    state: sessionState,
    totalSeconds,
    remainingSeconds: totalSeconds,
    totalWallSeconds,
    remainingWallSeconds: totalWallSeconds,
    initialActivityClockMs: sessionState.endgame.constructionActivity.activityClockMs,
    advancedWallSeconds: 0,
    stepSize,
    batchPowerStorage: options.batchPowerStorage !== false,
    batchConstructionAutomation: options.batchConstructionAutomation !== false,
    changed: totalSeconds > 0 || totalWallSeconds > 0,
    lookup: totalSeconds > 0 && options.indexedLogistics !== false
      ? options.lookup ?? createSimulationLookupContext(sessionState, options.profiler)
      : undefined,
    profiler: options.profiler,
    contractExperiment: options.contractExperiment,
  };
}

export function advanceSimulationSession(session: SimulationAdvanceSession, maximumSteps: number): number {
  const stepLimit = Math.max(0, Math.floor(Number.isFinite(maximumSteps) ? maximumSteps : 0));
  let steps = 0;
  // Repair a persisted full-progress boundary before the first machine pass.
  // This is cheap when no research is active and prevents a zero-cycle lab
  // from becoming a permanent state-machine deadlock.
  if (session.remainingSeconds > EPSILON) {
    settleCompletedResearchBoundariesInPlace(session.state);
  }
  if (session.remainingSeconds <= EPSILON && session.remainingWallSeconds > EPSILON && steps < stepLimit) {
    const activity = session.state.endgame.constructionActivity;
    session.advancedWallSeconds += session.remainingWallSeconds;
    if (session.state.speedrun?.enabled) {
      const advanced = advanceSpeedrunClock(session.state, session.remainingWallSeconds);
      if (advanced !== session.state) session.state = advanced;
    }
    if (activity.activityId) activity.activityClockMs = Math.max(0, Math.floor(session.initialActivityClockMs + session.advancedWallSeconds * 1_000));
    session.remainingWallSeconds = 0;
    return 1;
  }
  if (steps < stepLimit && session.remainingSeconds > EPSILON && canFastForwardQuiescentState(session.state)) {
    fastForwardQuiescentState(session);
    return 1;
  }
  while (session.remainingSeconds > EPSILON && steps < stepLimit) {
    let step = Math.min(session.stepSize, session.remainingSeconds);
    const activity = session.state.endgame.constructionActivity;
    const wallPerSimulationSecond = session.remainingSeconds > EPSILON
      ? session.remainingWallSeconds / session.remainingSeconds
      : 0;
    if (activity.activityId) {
      for (const boundaryMs of [activity.startsAtMs, activity.endsAtMs]) {
        const untilBoundaryWall = (boundaryMs - activity.activityClockMs) / 1_000;
        const untilBoundarySimulation = wallPerSimulationSecond > EPSILON
          ? untilBoundaryWall / wallPerSimulationSecond
          : Number.POSITIVE_INFINITY;
        if (untilBoundarySimulation > EPSILON && untilBoundarySimulation < step - EPSILON) step = untilBoundarySimulation;
      }
    }
    simulateStep(
      session.state,
      step,
      session.lookup,
      session.profiler,
      session.batchPowerStorage,
      session.batchConstructionAutomation,
      session.contractExperiment,
    );
    const wallStep = Math.min(session.remainingWallSeconds, step * wallPerSimulationSecond);
    if (session.state.speedrun?.enabled) {
      const advanced = advanceSpeedrunClock(session.state, wallStep);
      if (advanced !== session.state) session.state = advanced;
    }
    if (activity.activityId && wallStep > 0) {
      session.advancedWallSeconds += wallStep;
      activity.activityClockMs = Math.max(0, Math.floor(session.initialActivityClockMs + session.advancedWallSeconds * 1_000));
    }
    session.remainingSeconds = Math.max(0, session.remainingSeconds - step);
    session.remainingWallSeconds = Math.max(0, session.remainingWallSeconds - wallStep);
    steps += 1;
  }
  return steps;
}

export function completeSimulationAdvanceSession(session: SimulationAdvanceSession): GameState {
  if (!session.changed) return session.originalState;
  if (session.remainingSeconds > EPSILON) advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  if (session.remainingWallSeconds > EPSILON) advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  session.state.timeWarp.pendingSimulationSeconds = 0;
  session.state.timeWarp.pendingWallSeconds = 0;
  settleCompletedResearchBoundariesInPlace(session.state);
  let startedAt = session.profiler ? profileNow() : 0;
  recordProductionHistory(session.state, session.lookup);
  if (session.profiler) session.profiler.historyMs += profileNow() - startedAt;
  startedAt = session.profiler ? profileNow() : 0;
  // Blueprint reservations are reconciled by inventory/player commands. They
  // are deliberately absent from the per-step simulation hot path.
  const completed = syncCampaignProgress(session.state);
  if (session.profiler) session.profiler.constructionMs += profileNow() - startedAt;
  session.state = evaluateSpeedrunMilestones(completed);
  return session.state;
}

export function advanceSimulation(state: GameState, seconds: number): GameState {
  const session = createSimulationAdvanceSession(state, seconds);
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  return completeSimulationAdvanceSession(session);
}

export function advanceSimulationBudget(state: GameState, simulationSeconds: number, wallSeconds: number, profiler?: SimulationProfiler): GameState {
  const session = createSimulationAdvanceSession(state, simulationSeconds, { wallSeconds, profiler });
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  return completeSimulationAdvanceSession(session);
}

/** Worker-owned mutable state and indexes. Never persist or expose this runtime object. */
export interface PersistentSimulationRuntime {
  state: GameState;
  lookup?: SimulationLookupContext;
}

function normalizePersistentRuntimeShape(state: GameState): void {
  state.quantumLogisticsNetwork ??= createEmptyQuantumLogisticsNetworkState();
  for (const entity of state.entities) {
    entity.stationLastSupplyPeerBySlot ??= {};
    entity.proliferatorBonusProgress ??= {};
    if (entity.buildingId === "interstellar_logistics_station" || entity.buildingId === "orbital_collector") {
      entity.quantumMode ??= "legacy";
    }
  }
}

export function createPersistentSimulationRuntime(state: GameState, profiler?: SimulationProfiler): PersistentSimulationRuntime {
  normalizePersistentRuntimeShape(state);
  return {
    state,
    lookup: state.paused ? undefined : createSimulationLookupContext(state, profiler),
  };
}

export function replacePersistentSimulationRuntimeState(runtime: PersistentSimulationRuntime, state: GameState, profiler?: SimulationProfiler): void {
  normalizePersistentRuntimeShape(state);
  runtime.state = state;
  runtime.lookup = state.paused ? undefined : createSimulationLookupContext(state, profiler);
}

export function advancePersistentSimulationRuntime(
  runtime: PersistentSimulationRuntime,
  simulationSeconds: number,
  wallSeconds: number,
  profiler?: SimulationProfiler,
): { state: GameState; changed: boolean; cacheRebuilt: boolean } {
  if (!runtime.lookup && !runtime.state.paused && simulationSeconds > 0) runtime.lookup = createSimulationLookupContext(runtime.state, profiler);
  const before = runtime.state;
  const entitiesBefore = before.entities;
  const beltsBefore = before.belts;
  const session = createSimulationAdvanceSession(before, simulationSeconds, {
    wallSeconds,
    profiler,
    mutateState: true,
    lookup: runtime.lookup,
  });
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  const next = completeSimulationAdvanceSession(session);
  runtime.state = next;
  // Campaign/speedrun synchronization can replace only the top-level state
  // object after every request. The entity and belt objects remain the same,
  // so rebuilding all simulation indexes in that case is wasted work. A real
  // topology transition replaces one of these arrays and still rebuilds at the
  // same atomic boundary.
  const cacheRebuilt = next.entities !== entitiesBefore || next.belts !== beltsBefore;
  if (cacheRebuilt) {
    const constructionAutomationPlanCache = runtime.lookup?.constructionAutomationPlanCache;
    runtime.lookup = next.paused
      ? undefined
      : createSimulationLookupContext(next, profiler, constructionAutomationPlanCache);
  }
  return { state: next, changed: session.changed, cacheRebuilt };
}

export async function advancePersistentSimulationRuntimeMulticore(
  runtime: PersistentSimulationRuntime,
  simulationSeconds: number,
  wallSeconds: number,
  execute: SimulationPlanetPhaseExecutor,
  profiler?: SimulationProfiler,
): Promise<{ state: GameState; changed: boolean; cacheRebuilt: boolean }> {
  if (!runtime.lookup && !runtime.state.paused && simulationSeconds > 0) runtime.lookup = createSimulationLookupContext(runtime.state, profiler);
  const before = runtime.state;
  const entitiesBefore = before.entities;
  const beltsBefore = before.belts;
  const session = createSimulationAdvanceSession(before, simulationSeconds, {
    wallSeconds,
    profiler,
    mutateState: true,
    lookup: runtime.lookup,
  });
  await advanceSimulationSessionMulticore(session, Number.MAX_SAFE_INTEGER, execute);
  const next = completeSimulationAdvanceSession(session);
  runtime.state = next;
  const cacheRebuilt = next.entities !== entitiesBefore || next.belts !== beltsBefore;
  if (cacheRebuilt) {
    const constructionAutomationPlanCache = runtime.lookup?.constructionAutomationPlanCache;
    runtime.lookup = next.paused
      ? undefined
      : createSimulationLookupContext(next, profiler, constructionAutomationPlanCache);
  }
  return { state: next, changed: session.changed, cacheRebuilt };
}

export function getEffectiveSimulationMultiplier(state: GameState): number {
  if (!state.timeWarp.enabled || !state.timeWarp.controllerEntityId) return state.settings.simulationSpeed;
  return Math.max(state.settings.simulationSpeed, Math.floor(state.timeWarp.effectiveMultiplier));
}

export function setPaused(state: GameState, paused: boolean): GameState {
  if (state.paused === paused && (!paused || (state.timeWarp.pendingSimulationSeconds <= EPSILON && state.timeWarp.pendingWallSeconds <= EPSILON))) return state;
  return {
    ...state,
    paused,
    // A pause is a simulation boundary. Any budget that has not reached a
    // deterministic commit is discarded instead of being replayed on resume.
    timeWarp: paused
      ? { ...state.timeWarp, pendingSimulationSeconds: 0, pendingWallSeconds: 0 }
      : state.timeWarp,
  };
}

export function isEntityInteractionLocked(state: GameState, entityId: string): boolean {
  return state.entities.some((entity) => entity.id === entityId && entity.interactionLocked);
}

export function setEntitiesInteractionLocked(
  state: GameState,
  entityIds: readonly string[],
  locked: boolean,
): GameState {
  const requested = new Set(entityIds);
  if (requested.size === 0 || !state.entities.some((entity) => requested.has(entity.id) && entity.interactionLocked !== locked)) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => requested.has(entity.id) ? { ...entity, interactionLocked: locked } : entity),
  };
}

export function setBlackHolePaused(state: GameState, entityId: string, paused: boolean, confirmActivation = false): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "micro_black_hole_connector");
  if (!current || current.interactionLocked || (!paused && !current.blackHoleActivationConfirmed && !confirmActivation)) return state;
  if (current.blackHolePaused === paused && (paused || current.blackHoleActivationConfirmed)) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? {
      ...entity,
      blackHolePaused: paused,
      blackHoleActivationConfirmed: entity.blackHoleActivationConfirmed || (!paused && confirmActivation),
    } : entity),
  };
}

export function setTimeWarpController(state: GameState, entityId: string): GameState {
  if (!state.entities.some((entity) => entity.id === entityId && entity.buildingId === "time_warp_device" && !entity.interactionLocked) ||
    state.timeWarp.controllerEntityId === entityId) return state;
  return {
    ...state,
    timeWarp: {
      ...state.timeWarp,
      controllerEntityId: entityId,
      enabled: false,
      effectiveMultiplier: state.settings.simulationSpeed,
      requiredPowerKw: 0,
      allocatedPowerKw: 0,
    },
  };
}

/**
 * Refresh the time-warp controller through the same power allocator used by
 * a normal engine step, without advancing production or elapsed time.
 */
export function refreshTimeWarpPowerSnapshotInPlace(state: GameState): void {
  if (!state.timeWarp.enabled) {
    state.timeWarp.effectiveMultiplier = state.settings.simulationSpeed;
    state.timeWarp.requiredPowerKw = 0;
    state.timeWarp.allocatedPowerKw = 0;
    return;
  }
  const controller = state.entities.find((entity) =>
    entity.id === state.timeWarp.controllerEntityId &&
    entity.buildingId === "time_warp_device");
  if (!controller) {
    state.timeWarp.effectiveMultiplier = state.settings.simulationSpeed;
    state.timeWarp.requiredPowerKw = 0;
    state.timeWarp.allocatedPowerKw = 0;
    return;
  }
  const lookup = createSimulationLookupContext(state);
  const reception = calculateDysonReception(state);
  calculatePower(state, 1, controller.planetId, getEntityPowerGridId(controller), reception, lookup);
}

export function refreshTimeWarpPowerSnapshot(state: GameState): GameState {
  const next = copyState(state);
  refreshTimeWarpPowerSnapshotInPlace(next);
  return next;
}

export function setTimeWarpEnabled(state: GameState, enabled: boolean): GameState {
  if (!state.timeWarp.controllerEntityId || !state.entities.some((entity) =>
    entity.id === state.timeWarp.controllerEntityId && entity.buildingId === "time_warp_device" && !entity.interactionLocked) || state.timeWarp.enabled === enabled) return state;
  return {
    ...state,
    timeWarp: {
      ...state.timeWarp,
      enabled,
      // A stopped save contains a historical allocation. A new session starts
      // from base speed until refreshTimeWarpPowerSnapshot() evaluates the
      // current controller grid.
      effectiveMultiplier: state.settings.simulationSpeed,
      requiredPowerKw: 0,
      allocatedPowerKw: 0,
    },
  };
}

export function setTimeWarpRequestedMultiplier(state: GameState, multiplier: number): GameState {
  if (!Number.isSafeInteger(multiplier) || multiplier < 5 || multiplier === state.timeWarp.requestedMultiplier ||
    (state.timeWarp.controllerEntityId ? isEntityInteractionLocked(state, state.timeWarp.controllerEntityId) : false)) return state;
  return { ...state, timeWarp: { ...state.timeWarp, requestedMultiplier: multiplier } };
}

export function isStarSystemUnlocked(state: GameState, systemId: StarSystemId): boolean {
  return state.exploration.unlockedSystemIds.includes(systemId);
}

export function canExploreStarSystem(state: GameState, systemId: StarSystemId): boolean {
  const system = STAR_SYSTEMS[systemId];
  if (!system || isStarSystemUnlocked(state, systemId) || state.exploration.missions.some((mission) => mission.systemId === systemId)) return false;
  if (system.requiredTechId && !isTechnologyCompleted(state, system.requiredTechId)) return false;
  if (system.prerequisiteSystemId && !isStarSystemUnlocked(state, system.prerequisiteSystemId)) return false;
  return system.explorationCost.every((cost) => (state.tray[cost.itemId] ?? 0) + EPSILON >= cost.amount);
}

export function exploreStarSystem(state: GameState, systemId: StarSystemId): GameState {
  if (!canExploreStarSystem(state, systemId)) return state;
  const next = copyState(state);
  for (const cost of getStarSystem(systemId).explorationCost) {
    next.tray[cost.itemId] = Math.floor((next.tray[cost.itemId] ?? 0) - cost.amount);
  }
  next.planetTrays[next.activePlanetId] = { ...next.tray };
  const durationSeconds = Math.max(...getStarSystem(systemId).planetIds.map((planetId) =>
    getPlanetIndustrialProfile(next, planetId).surveyDurationSeconds));
  if (durationSeconds <= EPSILON) {
    next.exploration.unlockedSystemIds.push(systemId);
    next.exploration.surveyProgressBySystem[systemId] = 1;
  } else {
    // The navigation beacon is available immediately; the survey continues in the background.
    next.exploration.unlockedSystemIds.push(systemId);
    next.exploration.missions.push({ systemId, elapsedSeconds: 0, durationSeconds });
    next.exploration.surveyProgressBySystem[systemId] = 0;
  }
  return next;
}

function advanceExplorationMissions(state: GameState, seconds: number): void {
  const remaining = [] as GameState["exploration"]["missions"];
  for (const mission of state.exploration.missions) {
    const elapsedSeconds = Math.min(mission.durationSeconds, mission.elapsedSeconds + seconds);
    const progress = mission.durationSeconds <= EPSILON ? 1 : elapsedSeconds / mission.durationSeconds;
    state.exploration.surveyProgressBySystem[mission.systemId] = round(progress, 4);
    if (progress + EPSILON >= 1) {
      if (!state.exploration.unlockedSystemIds.includes(mission.systemId)) state.exploration.unlockedSystemIds.push(mission.systemId);
      const pioneerPlanetId = getStarSystem(mission.systemId).planetIds[0];
      if (pioneerPlanetId && !state.exploration.colonizedPlanetIds.includes(pioneerPlanetId)) {
        state.exploration.colonizedPlanetIds.push(pioneerPlanetId);
      }
    } else {
      remaining.push({ ...mission, elapsedSeconds });
    }
  }
  state.exploration.missions = remaining;
}

export function isPlanetColonized(state: GameState, planetId: PlanetId): boolean {
  if (state.exploration.colonizedPlanetIds.includes(planetId)) return true;
  const planet = getPlanet(planetId);
  if (planet.systemId === "helios" && planetId !== "home") {
    return isTechnologyCompleted(state, "interstellar_logistics");
  }
  const system = getStarSystem(planet.systemId);
  // A surveyed system always receives a pioneer landing on its first world.
  return system.planetIds[0] === planetId && isStarSystemUnlocked(state, planet.systemId);
}

export interface ColonizationRequirements {
  status: "colonized" | "technology" | "prerequisite-system" | "system-locked" | "materials" | "ready";
  reason: string;
  sourcePlanetId: PlanetId;
  costs: Array<{
    itemId: ItemId;
    current: number;
    required: number;
    missing: number;
    source: "planet-tray" | "portable-fleet";
  }>;
}

export function getColonizationRequirements(state: GameState, planetId: PlanetId): ColonizationRequirements {
  const planet = getPlanet(planetId);
  const system = getStarSystem(planet.systemId);
  const costs = getPlanetIndustrialProfile(state, planetId).colonyCost.map((cost) => {
    const portableFleetCost = isPortableFleetItem(cost.itemId);
    const current = Math.max(0, Math.floor(portableFleetCost
      ? state.portableFleet?.[cost.itemId as PortableFleetItemId] ?? 0
      : state.tray[cost.itemId] ?? 0));
    return {
      itemId: cost.itemId,
      current,
      required: cost.amount,
      missing: Math.max(0, cost.amount - current),
      source: portableFleetCost ? "portable-fleet" as const : "planet-tray" as const,
    };
  });
  const base = { sourcePlanetId: state.activePlanetId, costs };
  if (isPlanetColonized(state, planetId)) return { ...base, status: "colonized", reason: "已建立殖民前哨" };
  if (!isStarSystemUnlocked(state, planet.systemId)) {
    if (system.requiredTechId && !isTechnologyCompleted(state, system.requiredTechId)) {
      return { ...base, status: "technology", reason: `需要科技：${getTechnology(system.requiredTechId)?.name ?? system.requiredTechId}` };
    }
    if (system.prerequisiteSystemId && !isStarSystemUnlocked(state, system.prerequisiteSystemId)) {
      return { ...base, status: "prerequisite-system", reason: `需要先完成前置星系：${getStarSystem(system.prerequisiteSystemId).name}` };
    }
    return { ...base, status: "system-locked", reason: `需要先完成${system.name}勘探` };
  }
  if (costs.some((cost) => cost.missing > 0)) {
    const missingFleet = costs.filter((cost) => cost.source === "portable-fleet" && cost.missing > 0);
    const missingMaterials = costs.filter((cost) => cost.source === "planet-tray" && cost.missing > 0);
    const reasons = [
      missingMaterials.length > 0 ? "当前所在行星的物资托盘材料不足" : null,
      missingFleet.length > 0 ? `随身载具不足：${missingFleet.map((cost) => `${ITEMS[cost.itemId].name}缺 ${cost.missing}`).join("、")}` : null,
    ].filter(Boolean);
    return { ...base, status: "materials", reason: reasons.join("；") };
  }
  return { ...base, status: "ready", reason: "物资与闲置载具均满足，可建立殖民前哨" };
}

export function canColonizePlanet(state: GameState, planetId: PlanetId): boolean {
  return getColonizationRequirements(state, planetId).status === "ready";
}

export function colonizePlanet(state: GameState, planetId: PlanetId): GameState {
  const requirements = getColonizationRequirements(state, planetId);
  if (requirements.status !== "ready") return state;
  const next = copyState(state);
  for (const cost of requirements.costs) {
    if (cost.source === "portable-fleet" && isPortableFleetItem(cost.itemId)) {
      next.portableFleet[cost.itemId] = Math.max(0, Math.floor((next.portableFleet[cost.itemId] ?? 0) - cost.required));
    } else {
      next.tray[cost.itemId] = Math.max(0, Math.floor((next.tray[cost.itemId] ?? 0) - cost.required));
    }
  }
  next.planetTrays[next.activePlanetId] = { ...next.tray };
  next.exploration.colonizedPlanetIds.push(planetId);
  return next;
}

export function setActivePlanet(state: GameState, planetId: PlanetId): GameState {
  const planet = PLANET_LIST.find((candidate) => candidate.id === planetId);
  if (!planet || !isStarSystemUnlocked(state, planet.systemId) || !isPlanetColonized(state, planetId) || state.activePlanetId === planetId) return state;
  const next = copyState(state);
  next.planetTrays[next.activePlanetId] = { ...next.tray };
  next.activePlanetId = planetId;
  next.tray = { ...next.planetTrays[planetId] };
  next.metrics = { ...getPlanetMetrics(next, planetId) };
  return next;
}

const PLANET_INDUSTRY_ROLES: PlanetIndustryRole[] = [
  "auto",
  "mining",
  "smelting",
  "manufacturing",
  "chemical",
  "research",
  "logistics",
  "power",
];

export function setPlanetIndustryRole(state: GameState, planetId: PlanetId, role: PlanetIndustryRole): GameState {
  if (!PLANET_LIST.some((planet) => planet.id === planetId) || !PLANET_INDUSTRY_ROLES.includes(role) ||
    state.galaxy.planetRoles?.[planetId] === role) return state;
  return {
    ...state,
    galaxy: {
      ...state.galaxy,
      planetRoles: { ...(state.galaxy.planetRoles ?? {}), [planetId]: role },
    },
  };
}

export function setPlanetDisplayMetadata(
  state: GameState,
  planetId: PlanetId,
  metadata: { customName: string; note: string; tags: string[] },
): GameState {
  if (!PLANET_LIST.some((planet) => planet.id === planetId)) return state;
  const normalized = normalizePlanetDisplayMetadata(metadata);
  const planetMetadata = { ...(state.galaxy.planetMetadata ?? {}) };
  if (normalized) planetMetadata[planetId] = normalized;
  else delete planetMetadata[planetId];
  return { ...state, galaxy: { ...state.galaxy, planetMetadata } };
}

export function setStarSystemDisplayName(state: GameState, systemId: StarSystemId, customName: string): GameState {
  if (!STAR_SYSTEM_LIST.some((system) => system.id === systemId)) return state;
  const normalized = normalizeStarSystemDisplayMetadata({ customName });
  const systemMetadata = { ...(state.galaxy.systemMetadata ?? {}) };
  if (normalized) systemMetadata[systemId] = normalized;
  else delete systemMetadata[systemId];
  return { ...state, galaxy: { ...state.galaxy, systemMetadata } };
}

export function manualMine(state: GameState, entityId: string, amount = 1): GameState {
  const next = copyState(state);
  const entity = next.entities.find((item) => item.id === entityId);
  if (!entity || entity.kind !== "vein" || !entity.resourceId || ITEMS[entity.resourceId].kind === "fluid") return state;
  const capacity = getManualMiningOutputCapacity(next, entity);
  const current = Math.floor((entity.outputs[entity.resourceId] ?? 0) + EPSILON);
  const finite = !isVeinInfiniteForState(next, entity);
  const consumptionTenths = getVeinConsumptionTenths(next, entity.resourceId);
  const outputAllowance = finite ? getFiniteVeinOutputAllowance(entity, consumptionTenths) : Number.POSITIVE_INFINITY;
  const mined = Math.max(0, Math.floor(Math.min(amount, capacity - current, outputAllowance)));
  entity.outputs[entity.resourceId] = current + mined;
  if (finite) consumeFiniteVeinReserve(entity, mined, consumptionTenths);
  next.manualMined = Math.floor(next.manualMined + mined);
  next.totalProduced[entity.resourceId] = Math.floor((next.totalProduced[entity.resourceId] ?? 0) + mined);
  return next;
}

export function moveEntity(state: GameState, entityId: string, position: { x: number; y: number }): GameState {
  if (isEntityInteractionLocked(state, entityId)) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, position } : entity),
  };
}

export function moveEntities(state: GameState, positions: Array<{ id: string; position: { x: number; y: number } }>): GameState {
  const positionById = new Map(positions.flatMap((entry) => isEntityInteractionLocked(state, entry.id) ? [] : [[entry.id, entry.position]]));
  if (positionById.size === 0) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => {
      const position = positionById.get(entity.id);
      return position ? { ...entity, position: { ...position } } : entity;
    }),
  };
}

export function getBlueprintEligibleEntityIds(state: GameState, entityIds: string[]): string[] {
  const selectedIds = new Set(entityIds);
  return state.entities
    .filter((entity) => entity.planetId === state.activePlanetId && selectedIds.has(entity.id) &&
      (entity.kind === "vein" ? Boolean(entity.resourceId && entity.minerCount > 0) : Boolean(entity.buildingId)))
    .map((entity) => entity.id);
}

export function createBlueprint(state: GameState, entityIds: string[], name?: string): GameState {
  const eligibleIds = getBlueprintEligibleEntityIds(state, entityIds);
  if (eligibleIds.length === 0) return state;
  const selected = state.entities.filter((entity) => eligibleIds.includes(entity.id));
  if (selected.some((entity) => {
    const count = entity.kind === "vein" ? entity.minerCount : entity.machineCount;
    return !Number.isSafeInteger(count) || count < 1 || count > MAX_BUILDING_STACK_COUNT;
  })) return state;
  const originX = Math.min(...selected.map((entity) => entity.position.x));
  const originY = Math.min(...selected.map((entity) => entity.position.y));
  const keyById = new Map(selected.map((entity, index) => [entity.id, `node_${index + 1}`]));
  const selectedBuildings = selected.filter((entity) => entity.kind !== "vein" && entity.buildingId);
  const selectedResources = selected.filter((entity) => entity.kind === "vein" && entity.resourceId && entity.minerCount > 0);
  const blueprint: BlueprintDefinition = {
    id: `blueprint_${state.nextId}`,
    name: name?.trim().slice(0, 32) || `蓝图 ${String(state.blueprints.length + 1).padStart(2, "0")}`,
    revision: 1,
    entities: selectedBuildings.map((entity) => ({
      key: keyById.get(entity.id)!,
      buildingId: entity.buildingId!,
      offset: { x: entity.position.x - originX, y: entity.position.y - originY },
      machineCount: Math.max(1, Math.floor(entity.machineCount)),
      recipeId: entity.recipeId,
      targetDysonOrbitId: entity.buildingId === "em_rail_ejector" ? entity.targetDysonOrbitId : undefined,
      storedItemId: entity.storedItemId,
      stationTier: entity.buildingId === "interstellar_logistics_station" ? entity.stationTier : undefined,
      stationOperationMode: entity.buildingId === "interstellar_logistics_station" ? entity.stationOperationMode : undefined,
      quantumTarget: entity.buildingId === "interstellar_logistics_station"
        ? entity.quantumMode === "quantum" || entity.quantumTransition?.targetMode === "quantum" || entity.quantumTarget === true
        : undefined,
      operationEnabledOnDeploy: entity.buildingId === "micro_black_hole_connector"
        ? entity.blackHolePaused === false && entity.blackHoleActivationConfirmed === true
        : undefined,
      elevatorOutputItems: entity.buildingId === "interstellar_logistics_station"
        ? Array.from({ length: 5 }, (_, index) => entity.elevatorOutputItems?.[index] ?? null)
        : undefined,
      deliveryItemIds: entity.deliveryItemIds ? [...entity.deliveryItemIds] : undefined,
      deliverySlots: entity.deliverySlots?.map((slot) => ({ ...slot })),
      distributionMode: entity.distributionMode,
      fuelItemId: entity.fuelItemId,
      energyMode: entity.energyMode,
      powerGridId: entity.powerGridId,
      powerPriority: entity.powerPriority,
      generationPriority: entity.generationPriority,
      stationMode: entity.stationMode,
      stationMinimumLoad: entity.stationMinimumLoad,
      stationWarpEnabled: entity.stationWarpEnabled,
      stationWarperAutoRefill: entity.stationWarperAutoRefill,
      stationWarperTarget: entity.stationWarperTarget,
      stationDroneTarget: entity.buildingId === "planetary_logistics_station" || entity.buildingId === "interstellar_logistics_station"
        ? Math.max(0, Math.floor(entity.stationDrones ?? 0))
        : undefined,
      stationVesselTarget: entity.buildingId === "interstellar_logistics_station"
        ? Math.max(0, Math.floor(entity.stationVessels ?? 0))
        : undefined,
      stationHubEnabled: entity.stationHubEnabled,
      stationHubPriority: entity.stationHubPriority,
      stationSlots: entity.stationSlots?.map((slot) => ({ ...slot })),
      sprayCoaterInstalled: entity.sprayCoaterInstalled,
      proliferatorTier: entity.proliferatorTier,
      proliferatorMode: entity.proliferatorMode,
    })),
    resourceAnchors: selectedResources.map((entity): BlueprintResourceAnchor => ({
      key: keyById.get(entity.id)!,
      resourceId: entity.resourceId!,
      offset: { x: entity.position.x - originX, y: entity.position.y - originY },
      extractorBuildingId: entity.extractorBuildingId ?? getExtractorBuildingId(entity.resourceId!),
      minerCount: Math.max(1, Math.floor(entity.minerCount)),
    })),
    belts: state.belts
      .filter((belt) => keyById.has(belt.source) && keyById.has(belt.target))
      .map((belt, index) => {
        const sourceEntity = selected.find((entity) => entity.id === belt.source);
        const inferredElevatorIndex = sourceEntity && isElevatorStation(sourceEntity)
          ? sourceEntity.elevatorOutputItems?.findIndex((itemId) => itemId === belt.itemId)
          : -1;
        return {
          key: `line_${index + 1}`,
          sourceKey: keyById.get(belt.source)!,
          targetKey: keyById.get(belt.target)!,
          itemId: belt.itemId,
          lanes: belt.lanes,
          tier: belt.tier,
          sorterTier: belt.sorterTier,
          priority: belt.priority,
          stackSize: belt.stackSize,
          monitorEnabled: belt.monitorEnabled,
          routeMode: belt.routeMode ?? "auto",
          routeOffsetY: belt.routeOffsetY,
          targetPortIndex: belt.targetPortIndex,
          elevatorOutputIndex: belt.elevatorOutputIndex ?? (inferredElevatorIndex !== undefined && inferredElevatorIndex >= 0 ? inferredElevatorIndex as 0 | 1 | 2 | 3 | 4 : undefined),
        };
      }),
    externalPorts: state.belts
      .filter((belt) => keyById.has(belt.source) !== keyById.has(belt.target))
      .map((belt, index) => {
        const selectedSource = keyById.has(belt.source);
        const entityId = selectedSource ? belt.source : belt.target;
        const portEntity = selected.find((entity) => entity.id === entityId)!;
        return {
          key: `port_${index + 1}`,
          entityKey: keyById.get(entityId)!,
          direction: selectedSource ? "output" as const : "input" as const,
          itemId: belt.itemId,
          offset: { x: portEntity.position.x - originX, y: portEntity.position.y - originY },
        };
      }),
    rotation: 0,
    mirror: "none",
    recipeOverrides: {},
  };
  const next = copyState(state);
  next.blueprints.push(blueprint);
  next.nextId += 1;
  return next;
}

export function renameBlueprint(state: GameState, blueprintId: string, name: string): GameState {
  const normalized = name.trim().slice(0, 32);
  if (!normalized || !state.blueprints.some((blueprint) => blueprint.id === blueprintId)) return state;
  return {
    ...state,
    blueprints: state.blueprints.map((blueprint) => blueprint.id === blueprintId ? { ...blueprint, name: normalized, revision: Math.max(1, blueprint.revision ?? 1) + 1 } : blueprint),
  };
}

function cloneBlueprintDefinition(blueprint: BlueprintDefinition): BlueprintDefinition {
  return {
    ...blueprint,
    entities: blueprint.entities.map((entity) => ({
      ...entity,
      offset: { ...entity.offset },
      stationSlots: entity.stationSlots?.map((slot) => ({ ...slot })),
      deliverySlots: entity.deliverySlots?.map((slot) => ({ ...slot })),
    })),
    resourceAnchors: blueprint.resourceAnchors?.map((anchor) => ({ ...anchor, offset: { ...anchor.offset } })),
    belts: blueprint.belts.map((belt) => ({ ...belt })),
    externalPorts: blueprint.externalPorts?.map((port) => ({ ...port, offset: { ...port.offset } })),
    recipeOverrides: { ...blueprint.recipeOverrides },
  };
}

export function removeBlueprint(state: GameState, blueprintId: string): GameState {
  if (!state.blueprints.some((blueprint) => blueprint.id === blueprintId)) return state;
  return {
    ...state,
    blueprints: state.blueprints.filter((blueprint) => blueprint.id !== blueprintId),
  };
}

export function setBlueprintTransform(
  state: GameState,
  blueprintId: string,
  rotation: BlueprintRotation,
  mirror: BlueprintMirror,
): GameState {
  if (![0, 90, 180, 270].includes(rotation) || (mirror !== "none" && mirror !== "horizontal") ||
    !state.blueprints.some((blueprint) => blueprint.id === blueprintId)) return state;
  return {
    ...state,
    blueprints: state.blueprints.map((blueprint) => blueprint.id === blueprintId
      ? { ...blueprint, rotation, mirror, revision: Math.max(1, blueprint.revision ?? 1) + 1 }
      : blueprint),
  };
}

export function setBlueprintRecipeOverride(
  state: GameState,
  blueprintId: string,
  sourceRecipeId: RecipeId,
  targetRecipeId: RecipeId,
): GameState {
  const blueprint = state.blueprints.find((candidate) => candidate.id === blueprintId);
  const targetRecipe = getRecipe(targetRecipeId);
  const templates = blueprint?.entities.filter((entity) => entity.recipeId === sourceRecipeId) ?? [];
  if (!blueprint || !targetRecipe || templates.length === 0 ||
    (targetRecipe.requiredTechId && !isTechnologyCompleted(state, targetRecipe.requiredTechId)) ||
    templates.some((template) => !buildingSupportsRecipe(template.buildingId, targetRecipe))) return state;
  const overrides = { ...blueprint.recipeOverrides };
  if (sourceRecipeId === targetRecipeId) delete overrides[sourceRecipeId];
  else overrides[sourceRecipeId] = targetRecipeId;
  return {
    ...state,
    blueprints: state.blueprints.map((candidate) => candidate.id === blueprintId ? { ...candidate, recipeOverrides: overrides, revision: Math.max(1, candidate.revision ?? 1) + 1 } : candidate),
  };
}

interface ResolvedBlueprintResourceAnchor {
  anchor: BlueprintResourceAnchor;
  entity: FactoryEntity;
  installCount: number;
}

export interface BlueprintPlacementPreview {
  matchedResourceAnchors: number;
  skippedResourceAnchors: Array<{ key: string; resourceId: ItemId }>;
  extractorInstallCount: number;
  requirements: Array<{ constructionId: ConstructionId; amount: number }>;
  compatible: boolean;
  inventoryReady: boolean;
  canPlace: boolean;
}

const BLUEPRINT_RESOURCE_ANCHOR_RADIUS = 180;

function resolveBlueprintResourceAnchors(
  state: GameState,
  blueprint: BlueprintDefinition,
  position: { x: number; y: number },
  planetId: PlanetId,
  rotation: BlueprintRotation,
  mirror: BlueprintMirror,
): { resolved: ResolvedBlueprintResourceAnchor[]; skipped: BlueprintResourceAnchor[] } {
  const usedEntityIds = new Set<string>();
  const resolved: ResolvedBlueprintResourceAnchor[] = [];
  const skipped: BlueprintResourceAnchor[] = [];
  for (const anchor of blueprint.resourceAnchors ?? []) {
    const offset = transformBlueprintOffset(anchor.offset, rotation, mirror);
    const expected = { x: position.x + offset.x, y: position.y + offset.y };
    const candidate = state.entities
      .filter((entity) => entity.kind === "vein" && entity.planetId === planetId && entity.resourceId === anchor.resourceId && !usedEntityIds.has(entity.id))
      .map((entity) => ({ entity, distance: Math.hypot(entity.position.x - expected.x, entity.position.y - expected.y) }))
      .filter(({ distance }) => distance <= BLUEPRINT_RESOURCE_ANCHOR_RADIUS)
      .sort((a, b) => a.distance - b.distance || a.entity.id.localeCompare(b.entity.id))[0]?.entity;
    if (!candidate) {
      skipped.push(anchor);
      continue;
    }
    usedEntityIds.add(candidate.id);
    resolved.push({
      anchor,
      entity: candidate,
      installCount: Math.max(0, Math.floor(anchor.minerCount) - Math.max(0, Math.floor(candidate.minerCount))),
    });
  }
  return { resolved, skipped };
}

function blueprintRequirements(
  blueprint: BlueprintDefinition,
  resourceInstalls = new Map((blueprint.resourceAnchors ?? []).map((anchor) => [anchor.key, Math.max(1, Math.floor(anchor.minerCount))])),
  activeKeys = new Set([...blueprint.entities.map((entity) => entity.key), ...(blueprint.resourceAnchors ?? []).map((anchor) => anchor.key)]),
  minimumBeltLanes = 1,
): Array<{ constructionId: ConstructionId; amount: number }> | null {
  const requirements = new Map<ConstructionId, number>();
  let valid = true;
  const add = (constructionId: ConstructionId, amount: number) => {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      valid = false;
      return;
    }
    if (amount < 1) return;
    const total = (requirements.get(constructionId) ?? 0) + amount;
    if (!Number.isSafeInteger(total)) {
      valid = false;
      return;
    }
    requirements.set(constructionId, total);
  };
  for (const entity of blueprint.entities) {
    add(entity.buildingId, entity.machineCount);
    if (entity.sprayCoaterInstalled) add("spray_coater", 1);
  }
  for (const anchor of blueprint.resourceAnchors ?? []) add(anchor.extractorBuildingId, resourceInstalls.get(anchor.key) ?? 0);
  for (const belt of blueprint.belts) {
    if (!activeKeys.has(belt.sourceKey) || !activeKeys.has(belt.targetKey)) continue;
    add(getBeltConstructionId(belt.tier), Math.max(belt.lanes, normalizedDefaultBeltLanes(minimumBeltLanes)));
  }
  return valid ? [...requirements].map(([constructionId, amount]) => ({ constructionId, amount })) : null;
}

export function getBlueprintRequirements(blueprint: BlueprintDefinition): Array<{ constructionId: ConstructionId; amount: number }> {
  return blueprintRequirements(blueprint) ?? [];
}

interface BlueprintDeploymentPlan {
  blueprint: BlueprintDefinition;
  planetId: PlanetId;
  rotation: BlueprintRotation;
  mirror: BlueprintMirror;
  matches: ReturnType<typeof resolveBlueprintResourceAnchors>;
  requirements: Array<{ constructionId: ConstructionId; amount: number }>;
  compatible: boolean;
  inventoryReady: boolean;
  canPlace: boolean;
  minimumBeltLanes: number;
}

interface BlueprintPlacementOptions {
  planetId?: PlanetId;
  rotation?: BlueprintRotation;
  mirror?: BlueprintMirror;
  /** Device preference supplied by the UI; never persisted into GameState. */
  minimumBeltLanes?: number;
}

function createBlueprintDeploymentPlan(
  state: GameState,
  blueprintId: string,
  position: { x: number; y: number },
  options: BlueprintPlacementOptions = {},
): BlueprintDeploymentPlan | null {
  const blueprint = state.blueprints.find((candidate) => candidate.id === blueprintId);
  const planetId = options.planetId ?? state.activePlanetId;
  const rotation = options.rotation ?? blueprint?.rotation ?? 0;
  const mirror = options.mirror ?? blueprint?.mirror ?? "none";
  if (!blueprint || !PLANET_LIST.some((planet) => planet.id === planetId) || ![0, 90, 180, 270].includes(rotation) ||
    (mirror !== "none" && mirror !== "horizontal") || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const allKeys = [...blueprint.entities.map((entity) => entity.key), ...(blueprint.resourceAnchors ?? []).map((anchor) => anchor.key)];
  if (new Set(allKeys).size !== allKeys.length || blueprint.entities.some((entity) =>
    !Number.isSafeInteger(entity.machineCount) || entity.machineCount < 1 || entity.machineCount > MAX_BUILDING_STACK_COUNT) || (blueprint.resourceAnchors ?? []).some((anchor) =>
    !Number.isSafeInteger(anchor.minerCount) || anchor.minerCount < 1 || anchor.minerCount > MAX_BUILDING_STACK_COUNT) || blueprint.belts.some((belt) =>
    !Number.isSafeInteger(belt.lanes) || belt.lanes < 1 || belt.lanes > MAX_BELT_LANES)) return null;
  const matches = resolveBlueprintResourceAnchors(state, blueprint, position, planetId, rotation, mirror);
  const activeKeys = new Set([
    ...blueprint.entities.map((entity) => entity.key),
    ...matches.resolved.map(({ anchor }) => anchor.key),
  ]);
  const requirements = blueprintRequirements(
    blueprint,
    new Map(matches.resolved.map(({ anchor, installCount }) => [anchor.key, installCount])),
    activeKeys,
    options.minimumBeltLanes,
  );
  if (!requirements) return null;
  const compatible = (blueprint.entities.length > 0 || matches.resolved.length > 0) &&
    blueprint.entities.every((entity) => canPlaceBuildingOnPlanet(entity.buildingId, planetId, state)) &&
    blueprint.entities.filter((entity) => entity.buildingId === "space_station_construction_launcher").length <= 1 &&
    !(blueprint.entities.some((entity) => entity.buildingId === "space_station_construction_launcher") &&
      state.entities.some((entity) => entity.planetId === planetId && entity.buildingId === "space_station_construction_launcher"));
  const inventoryReady = requirements.every((requirement) => {
    const available = state.construction[requirement.constructionId] ?? 0;
    return Number.isSafeInteger(available) && available >= requirement.amount;
  });
  return {
    blueprint,
    planetId,
    rotation,
    mirror,
    matches,
    requirements,
    compatible,
    inventoryReady,
    canPlace: compatible && inventoryReady,
    minimumBeltLanes: normalizedDefaultBeltLanes(options.minimumBeltLanes),
  };
}

export function getBlueprintPlacementPreview(
  state: GameState,
  blueprintId: string,
  position: { x: number; y: number },
  options: BlueprintPlacementOptions = {},
): BlueprintPlacementPreview {
  const plan = createBlueprintDeploymentPlan(state, blueprintId, position, options);
  if (!plan) return { matchedResourceAnchors: 0, skippedResourceAnchors: [], extractorInstallCount: 0, requirements: [], compatible: false, inventoryReady: false, canPlace: false };
  return {
    matchedResourceAnchors: plan.matches.resolved.length,
    skippedResourceAnchors: plan.matches.skipped.map((anchor) => ({ key: anchor.key, resourceId: anchor.resourceId })),
    extractorInstallCount: plan.matches.resolved.reduce((sum, match) => sum + match.installCount, 0),
    requirements: plan.requirements,
    compatible: plan.compatible,
    inventoryReady: plan.inventoryReady,
    canPlace: plan.canPlace,
  };
}

export interface BlueprintFleetLoadPreview {
  drones: { target: number; loaded: number; shortfall: number };
  vessels: { target: number; loaded: number; shortfall: number };
}

function getBlueprintFleetTargets(blueprint: BlueprintDefinition): { drones: number; vessels: number } {
  let drones = 0;
  let vessels = 0;
  for (const template of blueprint.entities) {
    const count = Math.max(1, Math.floor(template.machineCount));
    if (template.buildingId === "planetary_logistics_station" || template.buildingId === "interstellar_logistics_station") {
      drones += Math.min(STATION_DRONES_PER_BUILDING * count, Math.max(0, Math.floor(template.stationDroneTarget ?? 0)));
    }
    if (template.buildingId === "interstellar_logistics_station") {
      vessels += Math.min(STATION_VESSELS_PER_BUILDING * count, Math.max(0, Math.floor(template.stationVesselTarget ?? 0)));
    }
  }
  return { drones, vessels };
}

export function getBlueprintFleetLoadPreview(state: GameState, blueprintId: string): BlueprintFleetLoadPreview {
  const blueprint = state.blueprints.find((candidate) => candidate.id === blueprintId);
  const result: BlueprintFleetLoadPreview = {
    drones: { target: 0, loaded: 0, shortfall: 0 },
    vessels: { target: 0, loaded: 0, shortfall: 0 },
  };
  if (!blueprint) return result;
  const targets = getBlueprintFleetTargets(blueprint);
  result.drones.target = targets.drones;
  result.vessels.target = targets.vessels;
  result.drones.loaded = Math.min(result.drones.target, Math.max(0, Math.floor(state.portableFleet.logistics_drone ?? 0)));
  result.vessels.loaded = Math.min(result.vessels.target, Math.max(0, Math.floor(state.portableFleet.logistics_vessel ?? 0)));
  result.drones.shortfall = result.drones.target - result.drones.loaded;
  result.vessels.shortfall = result.vessels.target - result.vessels.loaded;
  return result;
}

export function canPlaceBlueprint(
  state: GameState,
  blueprintId: string,
  planetId: PlanetId = state.activePlanetId,
  position?: { x: number; y: number },
): boolean {
  const blueprint = state.blueprints.find((candidate) => candidate.id === blueprintId);
  if (position) return getBlueprintPlacementPreview(state, blueprintId, position, { planetId }).canPlace;
  if (!blueprint || (blueprint.entities.length === 0 && (blueprint.resourceAnchors?.length ?? 0) === 0) ||
    blueprint.entities.some((entity) => !canPlaceBuildingOnPlanet(entity.buildingId, planetId, state))) return false;
  const requirements = blueprintRequirements(blueprint);
  return Boolean(requirements) && requirements!.every((requirement) =>
    (state.construction[requirement.constructionId] ?? 0) >= requirement.amount);
}

export function transformBlueprintOffset(
  offset: { x: number; y: number },
  rotation: BlueprintRotation,
  mirror: BlueprintMirror,
): { x: number; y: number } {
  const mirrored = { x: mirror === "horizontal" ? -offset.x : offset.x, y: offset.y };
  if (rotation === 90) return { x: -mirrored.y, y: mirrored.x };
  if (rotation === 180) return { x: -mirrored.x, y: -mirrored.y };
  if (rotation === 270) return { x: mirrored.y, y: -mirrored.x };
  return mirrored;
}

export function placeBlueprint(
  state: GameState,
  blueprintId: string,
  position: { x: number; y: number },
  options: BlueprintPlacementOptions = {},
): GameState {
  const plan = createBlueprintDeploymentPlan(state, blueprintId, position, options);
  if (!plan?.canPlace) return state;
  const { blueprint, planetId, rotation, mirror, matches, requirements, minimumBeltLanes } = plan;
  let next = copyState(state);
  for (const requirement of requirements) {
    next.construction[requirement.constructionId] = (next.construction[requirement.constructionId] ?? 0) - requirement.amount;
    if (!Number.isSafeInteger(next.construction[requirement.constructionId]) || next.construction[requirement.constructionId]! < 0) return state;
  }
  const entityIdByKey = new Map<string, string>(matches.resolved.map(({ anchor, entity }) => [anchor.key, entity.id]));
  for (const match of matches.resolved) {
    if (match.installCount < 1) continue;
    const target = next.entities.find((entity) => entity.id === match.entity.id)!;
    target.minerCount = Math.floor(target.minerCount + match.installCount);
    target.extractorBuildingId = match.anchor.extractorBuildingId;
  }
  for (const template of blueprint.entities) {
    const building = getBuilding(template.buildingId);
    const transformedOffset = transformBlueprintOffset(template.offset, rotation, mirror);
    const entityId = `entity_${next.nextId}`;
    next.nextId += 1;
    entityIdByKey.set(template.key, entityId);
    const configuredRecipeId = template.recipeId ? blueprint.recipeOverrides?.[template.recipeId] ?? template.recipeId : undefined;
    const recipe = getRecipe(configuredRecipeId);
    const recipeId = recipe && buildingSupportsRecipe(template.buildingId, recipe) &&
      (!recipe.requiredTechId || isTechnologyCompleted(next, recipe.requiredTechId))
      ? recipe.id
      : getRecipesForBuilding(template.buildingId).find((candidate) => !candidate.requiredTechId || isTechnologyCompleted(next, candidate.requiredTechId))?.id;
    next.entities.push({
      id: entityId,
      kind: building.kind === "power" ? "power" : building.kind === "storage" ? "storage" :
        building.kind === "splitter" ? "splitter" : building.kind === "station" ? "station" : "machine",
      planetId,
      position: { x: position.x + transformedOffset.x, y: position.y + transformedOffset.y },
      interactionLocked: false,
      buildingId: template.buildingId,
      recipeId,
      targetDysonOrbitId: template.buildingId === "em_rail_ejector"
        ? template.targetDysonOrbitId ?? activeDysonOrbitIdForPlanet(next, planetId)
        : undefined,
      storedItemId: template.storedItemId,
      stationTier: template.buildingId === "interstellar_logistics_station" ? template.stationTier ?? 1 : undefined,
      stationOperationMode: template.buildingId === "interstellar_logistics_station"
        ? (template.stationTier === 2 ? template.stationOperationMode ?? "legacy" : "legacy")
        : undefined,
      stationModeTransition: template.buildingId === "interstellar_logistics_station" ? null : undefined,
      quantumMode: template.buildingId === "interstellar_logistics_station" ? "legacy" : undefined,
      quantumTransition: template.buildingId === "interstellar_logistics_station" ? null : undefined,
      quantumTarget: template.buildingId === "interstellar_logistics_station" ? Boolean(template.quantumTarget) : undefined,
      elevatorOutputItems: template.buildingId === "interstellar_logistics_station"
        ? Array.from({ length: 5 }, (_, index) => template.elevatorOutputItems?.[index] ?? null)
        : undefined,
      deliveryItemIds: template.deliveryItemIds ? [...template.deliveryItemIds] : undefined,
      deliverySlots: template.deliverySlots?.map((slot) => ({ ...slot })),
      distributionMode: building.kind === "splitter" ? template.distributionMode ?? "balanced" : undefined,
      fuelItemId: template.fuelItemId,
      fuelRemainingMj: getFuelItemIdsForBuilding(template.buildingId).length > 0 ? 0 : undefined,
      powerOutputKw: building.kind === "power" ? 0 : undefined,
      powerInputKw: building.kind === "power" ? 0 : undefined,
      storedEnergyMj: template.buildingId === "accumulator" || template.buildingId === "energy_exchanger" ? 0 : undefined,
      energyMode: template.buildingId === "accumulator" ? "auto" : template.buildingId === "energy_exchanger" ? template.energyMode ?? "charge" : undefined,
      powerGridId: template.powerGridId ?? "grid-a",
      powerPriority: template.powerPriority ?? 2,
      generationPriority: building.kind === "power" ? template.generationPriority ?? 2 : undefined,
      stationMode: building.kind === "station" ? template.stationMode ?? "supply" : undefined,
      stationProgress: building.kind === "station" ? 0 : undefined,
      stationTrips: building.kind === "station" ? 0 : undefined,
      stationLastTransfer: building.kind === "station" ? 0 : undefined,
      stationDrones: template.buildingId === "planetary_logistics_station" || template.buildingId === "interstellar_logistics_station" ? 0 : undefined,
      stationVessels: building.kind === "station" ? 0 : undefined,
      stationWarpers: template.buildingId === "interstellar_logistics_station" ? 0 : undefined,
      stationWarpEnabled: template.buildingId === "interstellar_logistics_station" ? template.stationWarpEnabled !== false : undefined,
      stationWarperAutoRefill: template.buildingId === "interstellar_logistics_station" ? Boolean(template.stationWarperAutoRefill) : undefined,
      stationWarperTarget: template.buildingId === "interstellar_logistics_station"
        ? Math.max(1, Math.min(STATION_WARPER_CAPACITY_PER_BUILDING * template.machineCount, Math.floor(template.stationWarperTarget ?? DEFAULT_STATION_WARPER_TARGET)))
        : undefined,
      stationHubEnabled: template.buildingId === "interstellar_logistics_station" ? Boolean(template.stationHubEnabled) : undefined,
      stationHubPriority: template.buildingId === "interstellar_logistics_station" ? template.stationHubPriority ?? 1 : undefined,
      stationMinimumLoad: building.kind === "station" ? template.stationMinimumLoad ?? 1 : undefined,
      stationSlots: building.kind === "station" && template.buildingId !== "orbital_collector"
        ? template.stationSlots?.map((slot) => ({ ...slot })) ?? stationSlotsForPlacement(
          template.buildingId,
          template.storedItemId,
          template.stationMode,
          template.stationMinimumLoad,
        )
        : undefined,
      stationRoutes: building.kind === "station" ? [] : undefined,
      stationDispatchCursor: building.kind === "station" ? 0 : undefined,
      stationLastSupplyPeerBySlot: building.kind === "station" ? {} : undefined,
      stationCongestion: building.kind === "station" ? 0 : undefined,
      sprayCoaterInstalled: template.sprayCoaterInstalled,
      proliferatorTier: template.sprayCoaterInstalled ? template.proliferatorTier ?? 1 : undefined,
      proliferatorMode: template.sprayCoaterInstalled ? template.proliferatorMode ?? "normal" : undefined,
      proliferatorPoints: 0,
      proliferatorBonusProgress: {},
      blackHolePaused: template.buildingId === "micro_black_hole_connector" ? template.operationEnabledOnDeploy !== true : undefined,
      blackHoleActivationConfirmed: template.buildingId === "micro_black_hole_connector" ? template.operationEnabledOnDeploy === true : undefined,
      blackHolePorts: template.buildingId === "micro_black_hole_connector" ? ([0, 1, 2] as const).map((index) => ({ index, totalDestroyed: "0" })) : undefined,
      machineCount: template.buildingId === "micro_black_hole_connector" || template.buildingId === "time_warp_device" ? 1 : template.machineCount,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    });
    const placed = next.entities.at(-1)!;
    if (placed.buildingId === "planetary_logistics_station" || placed.buildingId === "interstellar_logistics_station") {
      const target = Math.min(getStationDroneCapacity(placed), Math.max(0, Math.floor(template.stationDroneTarget ?? 0)));
      const loaded = Math.min(target, Math.max(0, Math.floor(next.portableFleet.logistics_drone ?? 0)));
      placed.stationDrones = loaded;
      next.portableFleet.logistics_drone -= loaded;
    }
    if (placed.buildingId === "interstellar_logistics_station") {
      const target = Math.min(getStationVesselCapacity(placed), Math.max(0, Math.floor(template.stationVesselTarget ?? 0)));
      const loaded = Math.min(target, Math.max(0, Math.floor(next.portableFleet.logistics_vessel ?? 0)));
      placed.stationVessels = loaded;
      next.portableFleet.logistics_vessel -= loaded;
    }
  }
  if (isTechnologyCompleted(next, "quantum_logistics_network")) {
    const plannedStationIds = next.entities
      .filter((entity) => entity.buildingId === "interstellar_logistics_station" && entity.quantumTarget === true && (entity.stationTier ?? 1) >= 2 && !entity.quantumTransition && entity.quantumMode !== "quantum")
      .map((entity) => entity.id);
    if (plannedStationIds.length > 0) {
      const attached = beginQuantumAttachments(next, plannedStationIds);
      if (attached.startedIds.length > 0) {
        const started = new Set(attached.startedIds);
        next = { ...attached.state, entities: attached.state.entities.map((entity) => started.has(entity.id) ? { ...entity, quantumTarget: undefined } : entity) };
      }
    }
  }
  for (const template of blueprint.belts) {
    const source = entityIdByKey.get(template.sourceKey);
    const target = entityIdByKey.get(template.targetKey);
    if (!source || !target) continue;
    const targetEntity = next.entities.find((entity) => entity.id === target)!;
    const sourceEntity = next.entities.find((entity) => entity.id === source)!;
    if (template.elevatorOutputIndex !== undefined) {
      if (!isElevatorStation(sourceEntity)) return state;
      const outputItems = Array.from({ length: 5 }, (_, index) => sourceEntity.elevatorOutputItems?.[index] ?? null);
      const currentOutput = outputItems[template.elevatorOutputIndex];
      if (currentOutput && currentOutput !== template.itemId) return state;
      if (outputItems.some((itemId, index) => index !== template.elevatorOutputIndex && itemId === template.itemId)) return state;
      outputItems[template.elevatorOutputIndex] = template.itemId;
      sourceEntity.elevatorOutputItems = outputItems;
    }
    const targetPortIndex = targetEntity.buildingId === "material_delivery_hub"
      ? resolveMaterialDeliverySlotIndex(targetEntity, template.itemId, template.targetPortIndex)
      : targetEntity.buildingId === "micro_black_hole_connector"
        ? resolveBlackHolePortIndex(next, target, template.targetPortIndex)
        : undefined;
    if ((targetEntity.buildingId === "material_delivery_hub" || targetEntity.buildingId === "micro_black_hole_connector") && targetPortIndex === undefined) return state;
    configureTargetItem(targetEntity, template.itemId, targetPortIndex);
    next.belts.push({
      id: `belt_${next.nextId}`,
      planetId,
      source,
      target,
      itemId: template.itemId,
      lanes: Math.max(template.lanes, minimumBeltLanes),
      tier: template.tier,
      sorterTier: Math.min(3, template.tier) as SorterTier,
      progress: 0,
      priority: template.priority,
      stackSize: template.stackSize ?? 1,
      monitorEnabled: template.monitorEnabled ?? false,
      routeMode: template.routeMode ?? "auto",
      routeOffsetY: template.routeOffsetY,
      targetPortIndex,
      elevatorOutputIndex: template.elevatorOutputIndex,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
    });
    next.nextId += 1;
  }
  return next;
}

export const MAX_BLUEPRINT_CONSTRUCTION_ORDERS = 100;
export const MAX_BLUEPRINT_CONSTRUCTION_NODES = 100_000;
export const MAX_BLUEPRINT_CONSTRUCTION_BELTS = 250_000;

function getConstructionQueueBlueprint(state: GameState, entry: GameState["constructionQueue"][number]): BlueprintDefinition | undefined {
  const snapshot = entry.blueprintVersionId
    ? (state.blueprintVersions ?? []).find((candidate) => candidate.id === entry.blueprintVersionId)
    : undefined;
  return snapshot?.definition ?? state.blueprints.find((candidate) => candidate.id === entry.blueprintId);
}

function queueBlueprintVersionId(blueprint: BlueprintDefinition, variant = ""): string {
  return `${blueprint.id}@${Math.max(1, Math.floor(blueprint.revision ?? 1))}${variant}`;
}

function ensureBlueprintVersion(state: GameState, blueprint: BlueprintDefinition, variant = ""): { state: GameState; versionId: string } {
  const versionId = queueBlueprintVersionId(blueprint, variant);
  if ((state.blueprintVersions ?? []).some((snapshot) => snapshot.id === versionId)) return { state, versionId };
  return {
    state: {
      ...state,
      blueprintVersions: [...(state.blueprintVersions ?? []), {
        id: versionId,
        blueprintId: blueprint.id,
        revision: Math.max(1, Math.floor(blueprint.revision ?? 1)),
        definition: cloneBlueprintDefinition(blueprint),
      }],
    },
    versionId,
  };
}

function pruneBlueprintVersions(state: GameState): GameState {
  const referenced = new Set(state.constructionQueue.flatMap((entry) => entry.blueprintVersionId ? [entry.blueprintVersionId] : []));
  const nextVersions = (state.blueprintVersions ?? []).filter((snapshot) => referenced.has(snapshot.id));
  return nextVersions.length === (state.blueprintVersions ?? []).length ? state : { ...state, blueprintVersions: nextVersions };
}

function queueBlueprintPreview(state: GameState, entry: GameState["constructionQueue"][number], blueprint: BlueprintDefinition): BlueprintPlacementPreview {
  const previewState = { ...state, blueprints: [blueprint] };
  const preview = getBlueprintPlacementPreview(previewState, blueprint.id, entry.position, {
    planetId: entry.planetId,
    rotation: entry.rotation,
    mirror: entry.mirror,
  });
  const overlaps = hasQueuedBlueprintOverlap(
    state,
    blueprint,
    entry.position,
    entry.planetId,
    entry.rotation,
    entry.mirror,
    entry.id,
  );
  return overlaps ? { ...preview, compatible: false, canPlace: false } : preview;
}

function hasQueuedBlueprintOverlap(
  state: GameState,
  blueprint: BlueprintDefinition,
  position: { x: number; y: number },
  planetId: PlanetId,
  rotation: BlueprintRotation,
  mirror: BlueprintMirror,
  excludedEntryId?: string,
): boolean {
  const occupied = new Set(state.entities
    .filter((entity) => entity.planetId === planetId)
    .map((entity) => `${Math.round(entity.position.x)}:${Math.round(entity.position.y)}`));
  for (const entry of state.constructionQueue) {
    if (entry.id === excludedEntryId || entry.planetId !== planetId || (entry.status ?? "pending-materials") === "waiting-fleet") continue;
    const queued = getConstructionQueueBlueprint(state, entry);
    if (!queued) continue;
    for (const template of queued.entities) {
      const offset = transformBlueprintOffset(template.offset, entry.rotation, entry.mirror);
      occupied.add(`${Math.round(entry.position.x + offset.x)}:${Math.round(entry.position.y + offset.y)}`);
    }
  }
  return blueprint.entities.some((template) => {
    const offset = transformBlueprintOffset(template.offset, rotation, mirror);
    return occupied.has(`${Math.round(position.x + offset.x)}:${Math.round(position.y + offset.y)}`);
  });
}

export function canQueueBlueprint(
  state: GameState,
  blueprintId: string,
  planetId: PlanetId = state.activePlanetId,
  position?: { x: number; y: number },
  options: Pick<BlueprintPlacementOptions, "minimumBeltLanes"> = {},
): boolean {
  const blueprint = state.blueprints.find((candidate) => candidate.id === blueprintId);
  if (!blueprint || (blueprint.entities.length === 0 && (blueprint.resourceAnchors?.length ?? 0) === 0) ||
    state.constructionQueue.length >= MAX_BLUEPRINT_CONSTRUCTION_ORDERS ||
    blueprint.entities.length + (blueprint.resourceAnchors?.length ?? 0) > MAX_BLUEPRINT_CONSTRUCTION_NODES ||
    blueprint.belts.length > MAX_BLUEPRINT_CONSTRUCTION_BELTS) return false;
  if (!position) return blueprint.entities.every((entity) => canPlaceBuildingOnPlanet(entity.buildingId, planetId, state));
  const preview = getBlueprintPlacementPreview(state, blueprintId, position, { planetId, ...options });
  return preview.compatible && !hasQueuedBlueprintOverlap(
    state,
    blueprint,
    position,
    planetId,
    blueprint.rotation ?? 0,
    blueprint.mirror ?? "none",
  ) && Boolean(blueprint.entities.length || preview.matchedResourceAnchors > 0);
}

export function queueBlueprint(
  state: GameState,
  blueprintId: string,
  position: { x: number; y: number },
  options: Pick<BlueprintPlacementOptions, "minimumBeltLanes"> = {},
): GameState {
  const blueprint = state.blueprints.find((candidate) => candidate.id === blueprintId);
  if (!blueprint || !canQueueBlueprint(state, blueprintId, state.activePlanetId, position, options)) return state;
  const minimumBeltLanes = normalizedDefaultBeltLanes(options.minimumBeltLanes);
  const resolvedBlueprint = minimumBeltLanes > 1
    ? { ...cloneBlueprintDefinition(blueprint), belts: blueprint.belts.map((belt) => ({ ...belt, lanes: Math.max(belt.lanes, minimumBeltLanes) })) }
    : blueprint;
  const next = copyState(state);
  const version = ensureBlueprintVersion(next, resolvedBlueprint, minimumBeltLanes > 1 ? `:lanes-${minimumBeltLanes}` : "");
  const withVersion = version.state;
  withVersion.constructionQueue.push({
    id: `construction_${withVersion.nextId}`,
    blueprintId,
    blueprintVersionId: version.versionId,
    blueprintRevision: Math.max(1, Math.floor(blueprint.revision ?? 1)),
    blueprintName: blueprint.name,
    planetId: withVersion.activePlanetId,
    position: { ...position },
    rotation: blueprint.rotation ?? 0,
    mirror: blueprint.mirror ?? "none",
    queuedAt: withVersion.elapsedSeconds,
    status: "pending-materials",
    reservedConstruction: {},
    reservedFleet: {},
    placedEntityIdsByKey: {},
  });
  withVersion.nextId += 1;
  return withVersion;
}

export interface ConstructionQueueRequirementStatus {
  constructionId: ConstructionId;
  total: number;
  reserved: number;
  available: number;
  missing: number;
}

export interface ConstructionQueueFleetStatus {
  itemId: PortableFleetItemId;
  total: number;
  installedOrReserved: number;
  available: number;
  missing: number;
}

export interface ConstructionQueueDetails {
  status: "pending-materials" | "waiting-fleet" | "invalid";
  blueprint?: BlueprintDefinition;
  requirements: ConstructionQueueRequirementStatus[];
  fleet: ConstructionQueueFleetStatus[];
  compatible: boolean;
  blockedReason?: string;
}

function installedFleetForEntry(
  state: GameState,
  entry: GameState["constructionQueue"][number],
  blueprint: BlueprintDefinition,
): { drones: number; vessels: number } {
  let drones = 0;
  let vessels = 0;
  for (const template of blueprint.entities) {
    const entityId = entry.placedEntityIdsByKey?.[template.key];
    const entity = entityId ? state.entities.find((candidate) => candidate.id === entityId) : undefined;
    if (!entity) continue;
    const droneTarget = template.buildingId === "planetary_logistics_station" || template.buildingId === "interstellar_logistics_station"
      ? Math.min(getStationDroneCapacity(entity), Math.max(0, Math.floor(template.stationDroneTarget ?? 0)))
      : 0;
    const vesselTarget = template.buildingId === "interstellar_logistics_station"
      ? Math.min(getStationVesselCapacity(entity), Math.max(0, Math.floor(template.stationVesselTarget ?? 0)))
      : 0;
    drones += Math.min(droneTarget, Math.max(0, Math.floor(entity.stationDrones ?? 0)));
    vessels += Math.min(vesselTarget, Math.max(0, Math.floor(entity.stationVessels ?? 0)));
  }
  return { drones, vessels };
}

export function getConstructionQueueDetails(state: GameState, entryId: string): ConstructionQueueDetails {
  const entry = state.constructionQueue.find((candidate) => candidate.id === entryId);
  const blueprint = entry ? getConstructionQueueBlueprint(state, entry) : undefined;
  if (!entry || !blueprint) return { status: "invalid", requirements: [], fleet: [], compatible: false, blockedReason: "蓝图版本不可用" };
  const preview = queueBlueprintPreview(state, entry, blueprint);
  const pendingMaterials = (entry.status ?? "pending-materials") !== "waiting-fleet";
  const requirements = pendingMaterials ? preview.requirements.map((requirement) => {
    const reserved = Math.max(0, Math.floor(entry.reservedConstruction?.[requirement.constructionId] ?? 0));
    const available = Math.max(0, Math.floor(state.construction[requirement.constructionId] ?? 0));
    return { ...requirement, total: requirement.amount, reserved, available, missing: Math.max(0, requirement.amount - reserved) };
  }) : [];
  const targets = getBlueprintFleetTargets(blueprint);
  const installed = pendingMaterials
    ? { drones: Math.max(0, Math.floor(entry.reservedFleet?.logistics_drone ?? 0)), vessels: Math.max(0, Math.floor(entry.reservedFleet?.logistics_vessel ?? 0)) }
    : installedFleetForEntry(state, entry, blueprint);
  const fleet = ([
    { itemId: "logistics_drone", total: targets.drones, installedOrReserved: installed.drones, available: Math.max(0, Math.floor(state.portableFleet.logistics_drone ?? 0)), missing: Math.max(0, targets.drones - installed.drones) },
    { itemId: "logistics_vessel", total: targets.vessels, installedOrReserved: installed.vessels, available: Math.max(0, Math.floor(state.portableFleet.logistics_vessel ?? 0)), missing: Math.max(0, targets.vessels - installed.vessels) },
  ] satisfies ConstructionQueueFleetStatus[]).filter((item) => item.total > 0);
  const missingPlacedEntity = !pendingMaterials && blueprint.entities.some((template) => {
    const entityId = entry.placedEntityIdsByKey?.[template.key];
    return (template.stationDroneTarget ?? 0) > 0 || (template.stationVesselTarget ?? 0) > 0
      ? !entityId || !state.entities.some((entity) => entity.id === entityId)
      : false;
  });
  const compatible = pendingMaterials ? preview.compatible : !missingPlacedEntity;
  return {
    status: pendingMaterials ? "pending-materials" : "waiting-fleet",
    blueprint,
    requirements,
    fleet,
    compatible,
    blockedReason: compatible ? undefined : pendingMaterials ? "放置位置、行星或资源锚点已不兼容" : "目标物流塔已拆除",
  };
}

export function getConstructionQueueDeficits(state: GameState, entryId: string) {
  return getConstructionQueueDetails(state, entryId).requirements.filter((requirement) => requirement.missing > 0);
}

function safeInventoryAdd(current: number | undefined, amount: number): number | null {
  const next = Math.max(0, Math.floor(current ?? 0)) + Math.max(0, Math.floor(amount));
  return Number.isSafeInteger(next) ? next : null;
}

function deployFundedConstructionQueueEntry(state: GameState, entryId: string): GameState {
  const entry = state.constructionQueue.find((candidate) => candidate.id === entryId);
  const blueprint = entry ? getConstructionQueueBlueprint(state, entry) : undefined;
  const details = getConstructionQueueDetails(state, entryId);
  if (!entry || !blueprint || details.status !== "pending-materials" || !details.compatible || details.requirements.some((requirement) => requirement.missing > 0)) return state;

  const temporary = copyState(state);
  temporary.blueprints = [cloneBlueprintDefinition(blueprint)];
  temporary.construction = { ...entry.reservedConstruction };
  temporary.portableFleet = {
    logistics_drone: Math.max(0, Math.floor(entry.reservedFleet?.logistics_drone ?? 0)),
    logistics_vessel: Math.max(0, Math.floor(entry.reservedFleet?.logistics_vessel ?? 0)),
  };
  const previousEntityIds = new Set(temporary.entities.map((entity) => entity.id));
  const deployed = placeBlueprint(temporary, blueprint.id, entry.position, {
    planetId: entry.planetId,
    rotation: entry.rotation,
    mirror: entry.mirror,
  });
  if (deployed === temporary) return state;

  const restoredConstruction = { ...state.construction };
  for (const [constructionId, amount] of Object.entries(deployed.construction) as Array<[ConstructionId, number | undefined]>) {
    const merged = safeInventoryAdd(restoredConstruction[constructionId], amount ?? 0);
    if (merged === null) return state;
    restoredConstruction[constructionId] = merged;
  }
  const restoredFleet = { ...state.portableFleet };
  for (const itemId of ["logistics_drone", "logistics_vessel"] as PortableFleetItemId[]) {
    const merged = safeInventoryAdd(restoredFleet[itemId], deployed.portableFleet[itemId]);
    if (merged === null) return state;
    restoredFleet[itemId] = merged;
  }
  const placedEntities = deployed.entities.filter((entity) => !previousEntityIds.has(entity.id));
  const placedEntityIdsByKey = Object.fromEntries(blueprint.entities.map((template, index) => [template.key, placedEntities[index]?.id]).filter((entry): entry is [string, string] => Boolean(entry[1])));
  let next: GameState = {
    ...deployed,
    blueprints: state.blueprints,
    blueprintVersions: state.blueprintVersions,
    construction: restoredConstruction,
    portableFleet: restoredFleet,
    constructionQueue: deployed.constructionQueue.map((candidate) => candidate.id === entryId ? {
      ...candidate,
      status: "waiting-fleet" as const,
      reservedConstruction: {},
      reservedFleet: {},
      placedEntityIdsByKey,
      buildingCompletedAt: deployed.elapsedSeconds,
    } : candidate),
  };
  const fleetComplete = getConstructionQueueDetails(next, entryId).fleet.every((item) => item.missing === 0);
  if (fleetComplete) next = { ...next, constructionQueue: next.constructionQueue.filter((candidate) => candidate.id !== entryId) };
  return pruneBlueprintVersions(next);
}

function fundWaitingFleetEntry(state: GameState, entryId: string): GameState {
  const entry = state.constructionQueue.find((candidate) => candidate.id === entryId);
  const blueprint = entry ? getConstructionQueueBlueprint(state, entry) : undefined;
  if (!entry || !blueprint || (entry.status ?? "pending-materials") !== "waiting-fleet") return state;
  const next = copyState(state);
  const nextEntry = next.constructionQueue.find((candidate) => candidate.id === entryId)!;
  for (const template of blueprint.entities) {
    const entityId = nextEntry.placedEntityIdsByKey?.[template.key];
    const entity = entityId ? next.entities.find((candidate) => candidate.id === entityId) : undefined;
    if (!entity) continue;
    if (template.buildingId === "planetary_logistics_station" || template.buildingId === "interstellar_logistics_station") {
      const target = Math.min(getStationDroneCapacity(entity), Math.max(0, Math.floor(template.stationDroneTarget ?? 0)));
      const missing = Math.max(0, target - Math.max(0, Math.floor(entity.stationDrones ?? 0)));
      const loaded = Math.min(missing, next.portableFleet.logistics_drone);
      entity.stationDrones = Math.max(0, Math.floor(entity.stationDrones ?? 0)) + loaded;
      next.portableFleet.logistics_drone -= loaded;
    }
    if (template.buildingId === "interstellar_logistics_station") {
      const target = Math.min(getStationVesselCapacity(entity), Math.max(0, Math.floor(template.stationVesselTarget ?? 0)));
      const missing = Math.max(0, target - Math.max(0, Math.floor(entity.stationVessels ?? 0)));
      const loaded = Math.min(missing, next.portableFleet.logistics_vessel);
      entity.stationVessels = Math.max(0, Math.floor(entity.stationVessels ?? 0)) + loaded;
      next.portableFleet.logistics_vessel -= loaded;
    }
  }
  const details = getConstructionQueueDetails(next, entryId);
  if (!details.compatible || details.fleet.every((item) => item.missing === 0)) {
    next.constructionQueue = next.constructionQueue.filter((candidate) => candidate.id !== entryId);
  }
  return pruneBlueprintVersions(next);
}

export function fundConstructionQueueEntry(
  state: GameState,
  entryId: string,
  scope: "construction" | "fleet" | "all" = "all",
): GameState {
  const details = getConstructionQueueDetails(state, entryId);
  if (!details.blueprint || !details.compatible) return state;
  if (details.status === "waiting-fleet") return scope === "construction" ? state : fundWaitingFleetEntry(state, entryId);
  const constructionAlreadyFunded = details.requirements.every((requirement) => requirement.missing === 0);
  const next = copyState(state);
  const entry = next.constructionQueue.find((candidate) => candidate.id === entryId)!;
  let changed = false;
  if (scope !== "fleet") {
    const requiredIds = new Set(details.requirements.map((requirement) => requirement.constructionId));
    for (const [constructionId, reserved] of Object.entries(entry.reservedConstruction ?? {}) as Array<[ConstructionId, number | undefined]>) {
      const target = details.requirements.find((requirement) => requirement.constructionId === constructionId)?.total ?? 0;
      if (requiredIds.has(constructionId) && (reserved ?? 0) <= target) continue;
      const returned = safeInventoryAdd(next.construction[constructionId], Math.max(0, Math.floor(reserved ?? 0)) - target);
      if (returned === null) return state;
      next.construction[constructionId] = returned;
      entry.reservedConstruction![constructionId] = target;
      changed = true;
    }
    for (const requirement of details.requirements) {
      const reserved = Math.max(0, Math.floor(entry.reservedConstruction?.[requirement.constructionId] ?? 0));
      const taken = Math.min(requirement.total - reserved, Math.max(0, Math.floor(next.construction[requirement.constructionId] ?? 0)));
      entry.reservedConstruction![requirement.constructionId] = reserved + taken;
      next.construction[requirement.constructionId] = Math.max(0, Math.floor(next.construction[requirement.constructionId] ?? 0)) - taken;
      if (taken > 0) changed = true;
    }
  }
  if (scope !== "construction") {
    for (const fleet of details.fleet) {
      const reserved = Math.max(0, Math.floor(entry.reservedFleet?.[fleet.itemId] ?? 0));
      const taken = Math.min(fleet.total - reserved, Math.max(0, Math.floor(next.portableFleet[fleet.itemId] ?? 0)));
      entry.reservedFleet![fleet.itemId] = reserved + taken;
      next.portableFleet[fleet.itemId] -= taken;
      if (taken > 0) changed = true;
    }
  }
  if (!changed) return constructionAlreadyFunded ? deployFundedConstructionQueueEntry(state, entryId) : state;
  return deployFundedConstructionQueueEntry(next, entryId);
}

export function fundAllConstructionQueueEntries(state: GameState): GameState {
  const ids = [...state.constructionQueue]
    .sort((left, right) => left.queuedAt - right.queuedAt || left.id.localeCompare(right.id))
    .map((entry) => entry.id);
  return ids.reduce((next, entryId) => fundConstructionQueueEntry(next, entryId, "all"), state);
}

export function cancelConstructionQueueEntry(state: GameState, entryId: string): GameState {
  const entry = state.constructionQueue.find((candidate) => candidate.id === entryId);
  if (!entry) return state;
  const next = copyState(state);
  const nextEntry = next.constructionQueue.find((candidate) => candidate.id === entryId)!;
  for (const [constructionId, amount] of Object.entries(nextEntry.reservedConstruction ?? {}) as Array<[ConstructionId, number | undefined]>) {
    const returned = safeInventoryAdd(next.construction[constructionId], amount ?? 0);
    if (returned === null) return state;
    next.construction[constructionId] = returned;
  }
  for (const [itemId, amount] of Object.entries(nextEntry.reservedFleet ?? {}) as Array<[PortableFleetItemId, number | undefined]>) {
    const returned = safeInventoryAdd(next.portableFleet[itemId], amount ?? 0);
    if (returned === null) return state;
    next.portableFleet[itemId] = returned;
  }
  next.constructionQueue = next.constructionQueue.filter((candidate) => candidate.id !== entryId);
  return pruneBlueprintVersions(next);
}

export function processConstructionQueue(state: GameState): GameState {
  return fundAllConstructionQueueEntries(state);
}

export function canPlaceBuildingOnPlanet(buildingId: BuildingId, planetId: PlanetId, state?: { galaxy?: GameState["galaxy"] }): boolean {
  if (getPlanet(planetId).kind === "gas-giant") return buildingId === "orbital_collector";
  if (buildingId === "orbital_collector") return false;
  return buildingId !== "geothermal_power_station" || getPlanetIndustrialProfile(state ?? { galaxy: createGalaxyState() }, planetId).geothermalMultiplier > 0;
}

export function placeBuilding(state: GameState, buildingId: BuildingId, position: { x: number; y: number }, count = 1): GameState {
  const building = getBuilding(buildingId);
  const singleEntityMegastructure = buildingId === "micro_black_hole_connector" || buildingId === "time_warp_device";
  const requested = singleEntityMegastructure ? 1 : count;
  const stackCheck = getBuildingStackAdditionCheck(0, requested, building.name);
  if (!stackCheck.ok) return state;
  const amount = stackCheck.amount;
  if (buildingId === "space_station_construction_launcher" && state.entities.some((entity) => entity.planetId === state.activePlanetId && entity.buildingId === buildingId)) return state;
  if (building.kind === "miner" || !canPlaceBuildingOnPlanet(buildingId, state.activePlanetId, state) ||
    (state.construction[buildingId] ?? 0) < amount) return state;
  const next = copyState(state);
  const recipe = getRecipesForBuilding(buildingId).find((candidate) =>
    !candidate.requiredTechId || isTechnologyCompleted(state, candidate.requiredTechId));
  next.construction[buildingId] = (next.construction[buildingId] ?? 0) - amount;
  next.entities.push({
    id: `entity_${next.nextId}`,
    kind: building.kind === "power" ? "power" : building.kind === "storage" ? "storage" :
      building.kind === "splitter" ? "splitter" : building.kind === "station" ? "station" : "machine",
    planetId: state.activePlanetId,
    position,
    interactionLocked: false,
    buildingId,
    powerGridId: "grid-a",
    powerPriority: 2,
    generationPriority: building.kind === "power" ? defaultGenerationPriority({ buildingId } as FactoryEntity) : undefined,
    recipeId: recipe?.id,
    targetDysonOrbitId: buildingId === "em_rail_ejector"
      ? activeDysonOrbitIdForPlanet(next, state.activePlanetId)
      : undefined,
    machineCount: amount,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    distributionMode: building.kind === "splitter" ? "balanced" : undefined,
    storedItemId: buildingId === "orbital_collector"
      ? (Object.keys(getPlanetOrbitalYields(state, state.activePlanetId))[0] as ItemId | undefined) ?? "hydrogen"
      : undefined,
    deliveryItemIds: buildingId === "material_delivery_hub" ? [] : undefined,
    deliverySlots: buildingId === "material_delivery_hub" ? defaultMaterialDeliverySlots() : undefined,
    stationMode: building.kind === "station" ? "supply" : undefined,
    stationTier: buildingId === "interstellar_logistics_station" ? 1 : undefined,
    stationOperationMode: buildingId === "interstellar_logistics_station" ? "legacy" : undefined,
    stationModeTransition: buildingId === "interstellar_logistics_station" ? null : undefined,
    elevatorOutputItems: buildingId === "interstellar_logistics_station" ? [null, null, null, null, null] : undefined,
    stationProgress: building.kind === "station" ? 0 : undefined,
    stationTrips: building.kind === "station" ? 0 : undefined,
    stationLastTransfer: building.kind === "station" ? 0 : undefined,
    stationDrones: buildingId === "planetary_logistics_station" || buildingId === "interstellar_logistics_station" ? 0 : undefined,
    stationVessels: building.kind === "station" ? 0 : undefined,
    stationWarpers: buildingId === "interstellar_logistics_station" ? 0 : undefined,
    stationWarpEnabled: buildingId === "interstellar_logistics_station" ? true : undefined,
    stationWarperAutoRefill: buildingId === "interstellar_logistics_station" ? false : undefined,
    stationWarperTarget: buildingId === "interstellar_logistics_station" ? DEFAULT_STATION_WARPER_TARGET : undefined,
    stationHubEnabled: buildingId === "interstellar_logistics_station" ? false : undefined,
    stationHubPriority: buildingId === "interstellar_logistics_station" ? 1 : undefined,
    stationMinimumLoad: building.kind === "station" ? 1 : undefined,
    stationSlots: building.kind === "station" && buildingId !== "orbital_collector"
      ? stationSlotsForPlacement(buildingId)
      : undefined,
    stationRoutes: building.kind === "station" ? [] : undefined,
    stationDispatchCursor: building.kind === "station" ? 0 : undefined,
    stationLastSupplyPeerBySlot: building.kind === "station" ? {} : undefined,
    stationCongestion: building.kind === "station" ? 0 : undefined,
    fuelRemainingMj: getFuelItemIdsForBuilding(buildingId).length > 0 ? 0 : undefined,
    powerOutputKw: building.kind === "power" ? 0 : undefined,
    powerInputKw: building.kind === "power" ? 0 : undefined,
    storedEnergyMj: buildingId === "accumulator" || buildingId === "energy_exchanger" ? 0 : undefined,
    energyMode: buildingId === "accumulator" ? "auto" : buildingId === "energy_exchanger" ? "charge" : undefined,
    galacticExporterPaused: buildingId === "galactic_material_exporter" ? true : undefined,
    blackHolePaused: buildingId === "micro_black_hole_connector" ? true : undefined,
    blackHoleActivationConfirmed: buildingId === "micro_black_hole_connector" ? false : undefined,
    blackHolePorts: buildingId === "micro_black_hole_connector" ? ([0, 1, 2] as const).map((index) => ({ index, totalDestroyed: "0" })) : undefined,
    utilization: 0,
    productionRate: 0,
  });
  if (buildingId === "galactic_material_exporter") next.endgame.exportInputMode = "building";
  if (buildingId === "time_warp_device" && !next.timeWarp.controllerEntityId) {
    next.timeWarp.controllerEntityId = `entity_${next.nextId}`;
    next.timeWarp.enabled = false;
  }
  next.nextId += 1;
  return next;
}

export function addBuildingToGroup(state: GameState, entityId: string, buildingId: BuildingId, count = 1): GameState {
  if (buildingId === "micro_black_hole_connector" || buildingId === "time_warp_device" || isEntityInteractionLocked(state, entityId)) return state;
  const definition = getBuilding(buildingId);
  const current = state.entities.find((item) => item.id === entityId && item.buildingId === buildingId);
  if (!current || definition.kind === "miner") return state;
  const stackCheck = getBuildingStackAdditionCheck(current.machineCount, count, definition.name);
  if (!stackCheck.ok || (state.construction[buildingId] ?? 0) < stackCheck.amount) return state;
  if (definition.stackLimit && stackCheck.total > definition.stackLimit) return state;
  const next = copyState(state);
  const entity = next.entities.find((item) => item.id === entityId && item.buildingId === buildingId)!;
  entity.machineCount = stackCheck.total;
  next.construction[buildingId] = (next.construction[buildingId] ?? 0) - stackCheck.amount;
  return next;
}

export function addUnitToEntityGroup(state: GameState, entityId: string, count = 1): GameState {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return state;
  if (entity.kind === "vein") return installMiner(state, entityId, count);
  if (!entity.buildingId) return state;
  return addBuildingToGroup(state, entityId, entity.buildingId, count);
}

export function installMiner(state: GameState, entityId: string, count = 1): GameState {
  const source = state.entities.find((item) => item.id === entityId && item.kind === "vein");
  if (!source?.resourceId || source.interactionLocked) return state;
  const extractorId = getExtractorBuildingId(source.resourceId);
  const stackCheck = getBuildingStackAdditionCheck(source.minerCount, count, getBuilding(extractorId).name);
  if (!stackCheck.ok || (state.construction[extractorId] ?? 0) < stackCheck.amount) return state;
  const next = copyState(state);
  const entity = next.entities.find((item) => item.id === entityId && item.kind === "vein");
  if (!entity) return state;
  entity.minerCount = stackCheck.total;
  entity.extractorBuildingId = extractorId;
  next.construction[extractorId] = (next.construction[extractorId] ?? 0) - stackCheck.amount;
  return next;
}

function addToTray(state: GameState, itemId: ItemId, amount: number): void {
  if (isPortableFleetItem(itemId)) {
    state.portableFleet ??= { logistics_drone: 0, logistics_vessel: 0 };
    state.portableFleet[itemId] = Math.floor((state.portableFleet[itemId] ?? 0) + amount + EPSILON);
    return;
  }
  state.tray[itemId] = Math.floor((state.tray[itemId] ?? 0) + amount + EPSILON);
}

export function getPlanetTrayItemLimit(state: GameState, planetId: PlanetId = state.activePlanetId): number {
  const value = state.planetTrayItemLimits?.[planetId];
  return Number.isFinite(value)
    ? Math.max(MIN_PLANET_TRAY_ITEM_LIMIT, Math.min(MAX_PLANET_TRAY_ITEM_LIMIT, Math.floor(value)))
    : DEFAULT_PLANET_TRAY_ITEM_LIMIT;
}

export function getPlanetTrayItemFreeCapacity(state: GameState, planetId: PlanetId, itemId: ItemId): number {
  if (isPortableFleetItem(itemId)) return Number.POSITIVE_INFINITY;
  const tray = planetId === state.activePlanetId ? state.tray : state.planetTrays[planetId] ?? {};
  return Math.max(0, getPlanetTrayItemLimit(state, planetId) - Math.floor(tray[itemId] ?? 0));
}

export function setPlanetTrayItemLimit(state: GameState, planetId: PlanetId, value: number): GameState {
  if (!Number.isFinite(value) || !PLANET_LIST.some((planet) => planet.id === planetId)) return state;
  const limit = Math.max(MIN_PLANET_TRAY_ITEM_LIMIT, Math.min(MAX_PLANET_TRAY_ITEM_LIMIT, Math.floor(value)));
  if (getPlanetTrayItemLimit(state, planetId) === limit) return state;
  return {
    ...state,
    planetTrayItemLimits: { ...state.planetTrayItemLimits, [planetId]: limit },
  };
}

export interface PlanetTrayDiscardRequest {
  itemId: ItemId;
  amount: number;
}

export function discardPlanetTrayItems(state: GameState, planetId: PlanetId, requests: readonly PlanetTrayDiscardRequest[]): GameState {
  if (!PLANET_LIST.some((planet) => planet.id === planetId) || requests.length === 0) return state;
  const source = planetId === state.activePlanetId ? state.tray : state.planetTrays[planetId];
  if (!source) return state;
  const requestedByItem = new Map<ItemId, number>();
  for (const request of requests) {
    if (!ITEMS[request.itemId] || !Number.isFinite(request.amount)) continue;
    const amount = Math.max(0, Math.floor(request.amount));
    if (amount > 0) requestedByItem.set(request.itemId, (requestedByItem.get(request.itemId) ?? 0) + amount);
  }
  const nextTray = { ...source };
  let changed = false;
  for (const [itemId, requested] of requestedByItem) {
    const current = Math.max(0, Math.floor(nextTray[itemId] ?? 0));
    const removed = Math.min(current, requested);
    if (removed < 1) continue;
    const remaining = current - removed;
    if (remaining > 0) nextTray[itemId] = remaining;
    else delete nextTray[itemId];
    changed = true;
  }
  if (!changed) return state;
  const planetTrays = { ...state.planetTrays, [planetId]: { ...nextTray } };
  return planetId === state.activePlanetId
    ? { ...state, tray: nextTray, planetTrays }
    : { ...state, planetTrays };
}

/** Permanently remove one construction inventory stack without touching placed entities or automation targets. */
export function discardConstructionInventory(state: GameState, constructionId: ConstructionId): GameState {
  if (!(constructionId in state.construction) || !Number.isFinite(state.construction[constructionId]) ||
    Math.floor(state.construction[constructionId] ?? 0) < 1) return state;
  return {
    ...state,
    construction: {
      ...state.construction,
      [constructionId]: 0,
    },
  };
}

function storeInTray(state: GameState, itemId: ItemId, amount: number): number {
  const requested = Math.max(0, Math.floor(amount + EPSILON));
  if (requested < 1) return 0;
  if (isPortableFleetItem(itemId)) {
    addToTray(state, itemId, requested);
    return requested;
  }
  const moved = Math.min(requested, getPlanetTrayItemFreeCapacity(state, state.activePlanetId, itemId));
  if (moved > 0) addToTray(state, itemId, moved);
  return moved;
}

function trayForPlanet(state: GameState, planetId: PlanetId): Partial<Record<ItemId, number>> {
  return planetId === state.activePlanetId ? state.tray : (state.planetTrays[planetId] ??= {});
}

function addToPlanetTray(state: GameState, planetId: PlanetId, itemId: ItemId, amount: number): void {
  if (amount <= EPSILON || planetId === state.activePlanetId || isPortableFleetItem(itemId)) {
    if (amount > EPSILON) addToTray(state, itemId, amount);
    return;
  }
  const tray = state.planetTrays[planetId] ?? {};
  tray[itemId] = Math.floor((tray[itemId] ?? 0) + amount + EPSILON);
  state.planetTrays[planetId] = tray;
}

function storeInPlanetTray(state: GameState, planetId: PlanetId, itemId: ItemId, amount: number): number {
  const requested = Math.max(0, Math.floor(amount + EPSILON));
  if (requested < 1) return 0;
  if (isPortableFleetItem(itemId)) {
    addToPlanetTray(state, planetId, itemId, requested);
    return requested;
  }
  const moved = Math.min(requested, getPlanetTrayItemFreeCapacity(state, planetId, itemId));
  if (moved > 0) addToPlanetTray(state, planetId, itemId, moved);
  return moved;
}

function defaultMaterialDeliverySlots(): MaterialDeliverySlot[] {
  return Array.from({ length: MATERIAL_DELIVERY_SLOT_COUNT }, () => ({ itemId: null, mode: "auto" as const }));
}

export function getMaterialDeliverySlots(entity: FactoryEntity): MaterialDeliverySlot[] {
  if (entity.buildingId !== "material_delivery_hub") return [];
  const legacyItems = [...new Set((entity.deliveryItemIds ?? []).filter((itemId) => Boolean(ITEMS[itemId])))];
  return defaultMaterialDeliverySlots().map((fallback, index) => {
    const saved = entity.deliverySlots?.[index];
    if (saved?.mode === "disabled") return { itemId: null, mode: "disabled" };
    if (saved?.mode === "manual" && saved.itemId && ITEMS[saved.itemId]) return { itemId: saved.itemId, mode: "manual" };
    if (saved?.mode === "auto") return { itemId: saved.itemId && ITEMS[saved.itemId] ? saved.itemId : null, mode: "auto" };
    return legacyItems[index] ? { itemId: legacyItems[index], mode: "auto" } : fallback;
  });
}

function synchronizeMaterialDeliverySlots(entity: FactoryEntity, slots: readonly MaterialDeliverySlot[]): void {
  entity.deliverySlots = slots.map((slot) => ({ ...slot }));
  entity.deliveryItemIds = [...new Set(slots.flatMap((slot) => slot.itemId ? [slot.itemId] : []))];
}

export function getMaterialDeliveryItems(entity: FactoryEntity): ItemId[] {
  return [...new Set(getMaterialDeliverySlots(entity).flatMap((slot) => slot.itemId ? [slot.itemId] : []))];
}

function resolveMaterialDeliverySlotIndex(
  entity: FactoryEntity,
  itemId: ItemId,
  requested?: 0 | 1 | 2,
): 0 | 1 | 2 | undefined {
  const slots = getMaterialDeliverySlots(entity);
  const accepts = (slot: MaterialDeliverySlot) => slot.mode !== "disabled" && (!slot.itemId || slot.itemId === itemId);
  if (requested !== undefined) return accepts(slots[requested]) ? requested : undefined;
  const matching = slots.findIndex((slot) => slot.mode !== "disabled" && slot.itemId === itemId);
  if (matching >= 0) return matching as 0 | 1 | 2;
  const unbound = slots.findIndex((slot) => slot.mode === "auto" && !slot.itemId);
  return unbound >= 0 ? unbound as 0 | 1 | 2 : undefined;
}

export type MaterialDeliverySlotChangeCheck =
  | { ok: true; requiresDisconnect: boolean; connectedBelts: number; bufferedItems: number; label: string }
  | { ok: false; requiresDisconnect: false; connectedBelts: 0; bufferedItems: 0; label: string };

export function getMaterialDeliverySlotChangeCheck(
  state: GameState,
  entityId: string,
  slotIndex: number,
  mode: MaterialDeliverySlotMode,
  itemId: ItemId | null = null,
): MaterialDeliverySlotChangeCheck {
  const entity = state.entities.find((candidate) => candidate.id === entityId && candidate.buildingId === "material_delivery_hub");
  if (!entity || entity.interactionLocked || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MATERIAL_DELIVERY_SLOT_COUNT) {
    return { ok: false, requiresDisconnect: false, connectedBelts: 0, bufferedItems: 0, label: "物资配送接口不可修改" };
  }
  if (mode === "manual" && (!itemId || !ITEMS[itemId])) {
    return { ok: false, requiresDisconnect: false, connectedBelts: 0, bufferedItems: 0, label: "请先选择要指定的物资" };
  }
  const slots = getMaterialDeliverySlots(entity);
  const current = slots[slotIndex];
  const next: MaterialDeliverySlot = mode === "manual" ? { itemId, mode } : { itemId: null, mode };
  if (current.mode === next.mode && current.itemId === next.itemId) {
    return { ok: true, requiresDisconnect: false, connectedBelts: 0, bufferedItems: 0, label: "接口设置没有变化" };
  }
  const connectedBelts = state.belts.filter((belt) => belt.target === entityId && belt.targetPortIndex === slotIndex).length;
  const itemChanges = current.itemId !== next.itemId || next.mode === "disabled" || next.mode === "auto";
  const remainingUsesCurrentItem = Boolean(current.itemId && slots.some((slot, index) => index !== slotIndex && slot.itemId === current.itemId));
  const bufferedItems = current.itemId && !remainingUsesCurrentItem && itemChanges
    ? Math.max(0, Math.floor(entity.inputs[current.itemId] ?? 0))
    : 0;
  const requiresDisconnect = connectedBelts > 0 && itemChanges;
  return {
    ok: true,
    requiresDisconnect,
    connectedBelts,
    bufferedItems,
    label: requiresDisconnect
      ? `接口 ${slotIndex + 1} 仍连接 ${connectedBelts} 条线路；确认后会断开并返还传送带`
      : "可以修改接口设置",
  };
}

export function setMaterialDeliverySlot(
  state: GameState,
  entityId: string,
  slotIndex: number,
  mode: MaterialDeliverySlotMode,
  itemId: ItemId | null = null,
  confirmDisconnect = false,
): GameState {
  const check = getMaterialDeliverySlotChangeCheck(state, entityId, slotIndex, mode, itemId);
  if (!check.ok || (check.requiresDisconnect && !confirmDisconnect)) return state;
  const next = copyState(state);
  const entity = next.entities.find((candidate) => candidate.id === entityId)!;
  const slots = getMaterialDeliverySlots(entity);
  const previousItemId = slots[slotIndex].itemId;
  const removedBelts = next.belts.filter((belt) => belt.target === entityId && belt.targetPortIndex === slotIndex);
  if (removedBelts.length > 0) {
    refundBelts(next, removedBelts);
    next.belts = next.belts.filter((belt) => belt.target !== entityId || belt.targetPortIndex !== slotIndex);
  }
  slots[slotIndex] = mode === "manual" ? { itemId, mode } : { itemId: null, mode };
  synchronizeMaterialDeliverySlots(entity, slots);
  if (previousItemId && !slots.some((slot) => slot.itemId === previousItemId)) {
    const buffered = Math.max(0, Math.floor(entity.inputs[previousItemId] ?? 0));
    if (buffered > 0) addToPlanetTray(next, entity.planetId, previousItemId, buffered);
    delete entity.inputs[previousItemId];
  }
  for (const [bufferedItemId, amount] of Object.entries(entity.inputs)) {
    if (slots.some((slot) => slot.itemId === bufferedItemId)) continue;
    addToPlanetTray(next, entity.planetId, bufferedItemId as ItemId, Math.max(0, Math.floor(amount ?? 0)));
    delete entity.inputs[bufferedItemId as ItemId];
  }
  return next;
}

function refundBelts(state: GameState, belts: BeltConnection[]): void {
  for (const belt of belts) {
    const constructionId = getBeltConstructionId(belt.tier);
    state.construction[constructionId] = (state.construction[constructionId] ?? 0) + belt.lanes;
  }
}

function logisticsAccepts(state: GameState, entity: FactoryEntity, itemId: ItemId, targetPortIndex?: 0 | 1 | 2): boolean {
  if ((entity.kind !== "storage" && entity.kind !== "splitter" && entity.kind !== "station") || !entity.buildingId) return false;
  if (entity.buildingId === "orbital_collector") {
    return (getPlanetOrbitalYields(state, entity.planetId)[itemId] ?? 0) > 0 && (!entity.storedItemId || entity.storedItemId === itemId);
  }
  const accepts = getBuilding(entity.buildingId).accepts ?? "any";
  const itemKind = ITEMS[itemId].kind;
  const compatibleKind = accepts === "any" || accepts === itemKind || (accepts === "solid" && itemKind === "matrix");
  if (!compatibleKind) return false;
  if (entity.buildingId === "material_delivery_hub") {
    return resolveMaterialDeliverySlotIndex(entity, itemId, targetPortIndex) !== undefined;
  }
  if (entity.kind === "station") {
    const slots = getStationSlots(entity);
    return slots.some((slot) => slot.itemId === itemId) || slots.some((slot) => !slot.itemId);
  }
  return !entity.storedItemId || entity.storedItemId === itemId;
}

function fuelGeneratorAccepts(entity: FactoryEntity, itemId: ItemId): boolean {
  return Boolean(entity.buildingId && getFuelItemIdsForBuilding(entity.buildingId).includes(itemId) &&
    (!entity.fuelItemId || entity.fuelItemId === itemId));
}

function targetConsumes(state: GameState, entity: FactoryEntity, itemId: ItemId, targetPortIndex?: 0 | 1 | 2): boolean {
  if (entity.buildingId === "micro_black_hole_connector") return Boolean(ITEMS[itemId]);
  if (isElevatorStation(entity)) return Boolean(ITEMS[itemId]);
  if (entity.buildingId === "galactic_material_exporter") return ACTIVITY_MATERIAL_IDS.includes(itemId as import("./types").ActivityMaterialId);
  if (logisticsAccepts(state, entity, itemId, targetPortIndex)) return true;
  if (fuelGeneratorAccepts(entity, itemId)) return true;
  if (entity.sprayCoaterInstalled && getEntityProliferatorItemId(entity) === itemId) return true;
  const recipe = getRecipe(entity.recipeId);
  if (recipe?.id === "matrix_research") {
    return MATRIX_ITEM_IDS.includes(itemId);
  }
  return recipe?.inputs.some((input) => input.itemId === itemId) ?? false;
}

function hasBufferedItems(entity: FactoryEntity): boolean {
  return Object.values(entity.inputs).some((amount) => amount > EPSILON) ||
    Object.values(entity.outputs).some((amount) => amount > EPSILON);
}

/**
 * A newly placed machine starts on its first available recipe. Letting a belt
 * select an alternative only while that default is empty keeps explicit player
 * choices intact while removing the extra configuration step for first use.
 */
function getAutoRecipeForInput(state: GameState, entity: FactoryEntity, itemId: ItemId): RecipeDefinition | undefined {
  if (entity.kind !== "machine" || !entity.buildingId || entity.interactionLocked || hasBufferedItems(entity)) return undefined;
  const recipes = getRecipesForBuilding(entity.buildingId)
    .filter((recipe) => !recipe.requiredTechId || isTechnologyCompleted(state, recipe.requiredTechId));
  const defaultRecipe = recipes[0];
  if (!defaultRecipe || entity.recipeId !== defaultRecipe.id) return undefined;
  return recipes.find((recipe) => {
    if (!recipe.inputs.some((input) => input.itemId === itemId)) return false;
    const acceptedInputs = new Set(recipe.id === "matrix_research"
      ? MATRIX_ITEM_IDS
      : recipe.inputs.map((input) => input.itemId));
    const proliferatorItemId = entity.sprayCoaterInstalled ? getEntityProliferatorItemId(entity) : undefined;
    if (proliferatorItemId) acceptedInputs.add(proliferatorItemId);
    const producedOutputs = new Set(recipe.outputs.map((output) => output.itemId));
    return state.belts.every((belt) => {
      if (belt.target === entity.id && !acceptedInputs.has(belt.itemId)) return false;
      if (belt.source === entity.id && !producedOutputs.has(belt.itemId)) return false;
      return true;
    });
  });
}

function targetCanAcceptBeltItem(state: GameState, entity: FactoryEntity, itemId: ItemId, targetPortIndex?: 0 | 1 | 2): boolean {
  return targetConsumes(state, entity, itemId, targetPortIndex) || Boolean(getAutoRecipeForInput(state, entity, itemId));
}

/**
 * Read-only port compatibility used by connection previews. Final placement
 * still goes through getBeltConnectionCheck(), which also validates stock,
 * endpoints, lane limits and a concrete special-port index.
 */
export function canEntityAcceptBeltItem(state: GameState, entity: FactoryEntity, itemId: ItemId): boolean {
  return targetCanAcceptBeltItem(state, entity, itemId);
}

function configureAutoTargetRecipe(state: GameState, entity: FactoryEntity, itemId: ItemId): void {
  const recipe = getAutoRecipeForInput(state, entity, itemId);
  if (!recipe || entity.recipeId === recipe.id) return;
  entity.recipeId = recipe.id;
  entity.progress = 0;
  entity.routingCursor = 0;
  entity.utilization = 0;
  entity.productionRate = 0;
  entity.proliferatorBonusProgress = {};
}

function configureTargetItem(entity: FactoryEntity, itemId: ItemId, targetPortIndex?: 0 | 1 | 2): void {
  if (entity.buildingId === "material_delivery_hub") {
    const resolved = resolveMaterialDeliverySlotIndex(entity, itemId, targetPortIndex);
    if (resolved === undefined) return;
    const slots = getMaterialDeliverySlots(entity);
    if (slots[resolved].mode === "auto" && !slots[resolved].itemId) slots[resolved] = { itemId, mode: "auto" };
    synchronizeMaterialDeliverySlots(entity, slots);
  } else if (entity.kind === "station" && entity.buildingId !== "orbital_collector" && !isElevatorStation(entity)) {
    const slots = ensureStationSlots(entity);
    if (!slots.some((slot) => slot.itemId === itemId)) {
      const empty = slots.find((slot) => !slot.itemId);
      if (empty) {
        empty.itemId = itemId;
        empty.localMode = entity.buildingId === "planetary_logistics_station" ? "supply" : "storage";
        empty.remoteMode = entity.buildingId === "interstellar_logistics_station" ? "supply" : "storage";
        ensureStationSlots(entity);
      }
    }
  } else if ((entity.kind === "storage" || entity.kind === "splitter" || entity.kind === "station") && !entity.storedItemId) {
    entity.storedItemId = itemId;
  }
  if (entity.buildingId && !entity.fuelItemId && getFuelItemIdsForBuilding(entity.buildingId).includes(itemId)) {
    entity.fuelItemId = itemId;
  }
}

export function setEntityRecipe(state: GameState, entityId: string, recipeId: RecipeId): GameState {
  if (isEntityInteractionLocked(state, entityId)) return state;
  const next = copyState(state);
  const entity = next.entities.find((item) => item.id === entityId);
  const recipe = getRecipe(recipeId);
  if (!entity?.buildingId || !recipe || !buildingSupportsRecipe(entity.buildingId, recipe) ||
    (recipe.requiredTechId && !isTechnologyCompleted(state, recipe.requiredTechId))) return state;
  if (entity.recipeId === recipeId) return state;

  for (const [itemId, amount] of Object.entries(entity.inputs)) addToTray(next, itemId as ItemId, amount ?? 0);
  for (const [itemId, amount] of Object.entries(entity.outputs)) addToTray(next, itemId as ItemId, amount ?? 0);
  entity.inputs = {};
  entity.outputs = {};
  entity.progress = 0;
  entity.proliferatorBonusProgress = {};
  if (entity.buildingId === "ray_receiver") entity.powerOutputKw = 0;
  entity.recipeId = recipeId;

  const removedBelts = next.belts.filter((belt) => belt.source === entityId || belt.target === entityId);
  refundBelts(next, removedBelts);
  next.belts = next.belts.filter((belt) => belt.source !== entityId && belt.target !== entityId);
  return next;
}

export function setRecipeFocus(state: GameState, itemId: ItemId | null): GameState {
  if (itemId !== null && !ITEMS[itemId]) return state;
  if (state.recipeFocus.itemId === itemId) return state;
  return { ...state, recipeFocus: { ...state.recipeFocus, itemId } };
}

export function setRecipeFocusMode(state: GameState, mode: "full" | "two-level"): GameState {
  if (state.recipeFocus.mode === mode) return state;
  return { ...state, recipeFocus: { ...state.recipeFocus, mode } };
}

export function setRecipeFocusPosition(state: GameState, position: { x: number; y: number }): GameState {
  const x = Number.isFinite(position.x) ? Math.max(8, Math.round(position.x)) : state.recipeFocus.position.x;
  const y = Number.isFinite(position.y) ? Math.max(8, Math.round(position.y)) : state.recipeFocus.position.y;
  if (state.recipeFocus.position.x === x && state.recipeFocus.position.y === y) return state;
  return { ...state, recipeFocus: { ...state.recipeFocus, position: { x, y } } };
}

export function addCanvasBookmark(
  state: GameState,
  planetId: PlanetId,
  viewport: { x: number; y: number; zoom: number },
  name?: string,
): GameState {
  if (!PLANET_LIST.some((planet) => planet.id === planetId) || !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom)) return state;
  const bookmark = {
    id: `bookmark_${state.nextId}`,
    name: name?.trim().slice(0, 28) || `${getPlanet(planetId).name}视角 ${state.canvasBookmarks.length + 1}`,
    planetId,
    viewport: {
      x: Math.round(viewport.x),
      y: Math.round(viewport.y),
      zoom: Math.max(0.1, Math.min(2.5, Math.round(viewport.zoom * 100) / 100)),
    },
    createdAtSeconds: Math.max(0, state.elapsedSeconds),
  } satisfies GameState["canvasBookmarks"][number];
  return { ...state, nextId: state.nextId + 1, canvasBookmarks: [...state.canvasBookmarks, bookmark].slice(-24) };
}

export function renameCanvasBookmark(state: GameState, bookmarkId: string, name: string): GameState {
  const trimmed = name.trim().slice(0, 28);
  if (!trimmed || !state.canvasBookmarks.some((bookmark) => bookmark.id === bookmarkId)) return state;
  return { ...state, canvasBookmarks: state.canvasBookmarks.map((bookmark) => bookmark.id === bookmarkId ? { ...bookmark, name: trimmed } : bookmark) };
}

export function removeCanvasBookmark(state: GameState, bookmarkId: string): GameState {
  if (!state.canvasBookmarks.some((bookmark) => bookmark.id === bookmarkId)) return state;
  return { ...state, canvasBookmarks: state.canvasBookmarks.filter((bookmark) => bookmark.id !== bookmarkId) };
}

function validCanvasColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function addCanvasRegion(
  state: GameState,
  planetId: PlanetId,
  rectangle: { x: number; y: number; width: number; height: number },
  name?: string,
  fillColor = "#2C6B66",
  borderColor = "#67C7B5",
): GameState {
  if (!PLANET_LIST.some((planet) => planet.id === planetId) ||
    !Number.isFinite(rectangle.x) || !Number.isFinite(rectangle.y) ||
    !Number.isFinite(rectangle.width) || !Number.isFinite(rectangle.height) ||
    rectangle.width < MIN_CANVAS_REGION_SIZE || rectangle.height < MIN_CANVAS_REGION_SIZE || !validCanvasColor(fillColor) || !validCanvasColor(borderColor)) return state;
  const region: CanvasRegion = {
    id: `region_${state.nextId}`,
    name: name?.trim().slice(0, 28) || `生产区域 ${state.canvasRegions.length + 1}`,
    planetId,
    x: Math.round(rectangle.x),
    y: Math.round(rectangle.y),
    width: Math.min(20_000, Math.round(rectangle.width)),
    height: Math.min(20_000, Math.round(rectangle.height)),
    fillColor: fillColor.toUpperCase(),
    borderColor: borderColor.toUpperCase(),
  };
  return { ...state, nextId: state.nextId + 1, canvasRegions: [...state.canvasRegions, region].slice(-48) };
}

export function updateCanvasRegion(state: GameState, regionId: string, changes: Partial<Pick<CanvasRegion, "name" | "fillColor" | "borderColor">>): GameState {
  const region = state.canvasRegions.find((candidate) => candidate.id === regionId);
  if (!region) return state;
  const name = typeof changes.name === "string" && changes.name.trim() ? changes.name.trim().slice(0, 28) : region.name;
  const fillColor = typeof changes.fillColor === "string" && validCanvasColor(changes.fillColor) ? changes.fillColor.toUpperCase() : region.fillColor;
  const borderColor = typeof changes.borderColor === "string" && validCanvasColor(changes.borderColor) ? changes.borderColor.toUpperCase() : region.borderColor;
  if (name === region.name && fillColor === region.fillColor && borderColor === region.borderColor) return state;
  return { ...state, canvasRegions: state.canvasRegions.map((candidate) => candidate.id === regionId ? { ...candidate, name, fillColor, borderColor } : candidate) };
}

export function resizeCanvasRegion(
  state: GameState,
  regionId: string,
  rectangle: { x: number; y: number; width: number; height: number },
): GameState {
  const region = state.canvasRegions.find((candidate) => candidate.id === regionId);
  if (!region || !Number.isFinite(rectangle.x) || !Number.isFinite(rectangle.y) ||
    !Number.isFinite(rectangle.width) || !Number.isFinite(rectangle.height)) return state;
  const nextRectangle = {
    x: Math.round(rectangle.x),
    y: Math.round(rectangle.y),
    width: Math.max(MIN_CANVAS_REGION_SIZE, Math.min(20_000, Math.round(rectangle.width))),
    height: Math.max(MIN_CANVAS_REGION_SIZE, Math.min(20_000, Math.round(rectangle.height))),
  };
  if (region.x === nextRectangle.x && region.y === nextRectangle.y &&
    region.width === nextRectangle.width && region.height === nextRectangle.height) return state;
  return {
    ...state,
    canvasRegions: state.canvasRegions.map((candidate) => candidate.id === regionId ? { ...candidate, ...nextRectangle } : candidate),
  };
}

export function removeCanvasRegion(state: GameState, regionId: string): GameState {
  if (!state.canvasRegions.some((region) => region.id === regionId)) return state;
  return { ...state, canvasRegions: state.canvasRegions.filter((region) => region.id !== regionId) };
}

function applyAcrossEntityPlanets(
  state: GameState,
  entityIds: string[],
  apply: (current: GameState, planetEntityIds: string[]) => GameState,
): GameState {
  const uniqueIds = [...new Set(entityIds)];
  const groups = new Map<PlanetId, string[]>();
  for (const entityId of uniqueIds) {
    const entity = state.entities.find((candidate) => candidate.id === entityId);
    if (!entity) continue;
    const group = groups.get(entity.planetId) ?? [];
    group.push(entityId);
    groups.set(entity.planetId, group);
  }
  if (groups.size === 0) return state;

  const originalPlanetId = state.activePlanetId;
  let next = state;
  for (const [planetId, planetEntityIds] of groups) {
    if (next.activePlanetId !== planetId) next = setActivePlanet(next, planetId);
    if (next.activePlanetId !== planetId) continue;
    next = apply(next, planetEntityIds);
  }
  if (next.activePlanetId !== originalPlanetId) next = setActivePlanet(next, originalPlanetId);
  return next;
}

export function getRecipeCompatibleEntityIds(state: GameState, entityIds: string[], recipeId: RecipeId): string[] {
  const recipe = getRecipe(recipeId);
  if (!recipe || (recipe.requiredTechId && !isTechnologyCompleted(state, recipe.requiredTechId))) return [];
  const requested = new Set(entityIds);
  return state.entities
    .filter((entity) => requested.has(entity.id) && !entity.interactionLocked && entity.buildingId && buildingSupportsRecipe(entity.buildingId, recipe))
    .map((entity) => entity.id);
}

export function setEntitiesRecipe(state: GameState, entityIds: string[], recipeId: RecipeId): GameState {
  const compatibleIds = getRecipeCompatibleEntityIds(state, entityIds, recipeId)
    .filter((entityId) => state.entities.find((entity) => entity.id === entityId)?.recipeId !== recipeId);
  if (compatibleIds.length === 0) return state;
  return applyAcrossEntityPlanets(state, compatibleIds, (current, planetEntityIds) =>
    planetEntityIds.reduce((next, entityId) => setEntityRecipe(next, entityId, recipeId), current));
}

export type SprayCoaterInstallCheck = {
  ready: boolean;
  code: "ready" | "entity-missing" | "entity-locked" | "already-installed" | "technology-locked" | "stock-empty" | "recipe-missing" | "recipe-incompatible";
  reason: string;
};

export function getSprayCoaterInstallCheck(state: GameState, entityId: string): SprayCoaterInstallCheck {
  const entity = state.entities.find((item) => item.id === entityId);
  if (!entity) return { ready: false, code: "entity-missing", reason: "设备不存在或已被回收" };
  if (entity.interactionLocked) return { ready: false, code: "entity-locked", reason: "建筑已锁定，请先解锁" };
  if (entity.sprayCoaterInstalled) return { ready: false, code: "already-installed", reason: "该设备已经安装喷涂机" };
  if (!isTechnologyCompleted(state, "proliferator_1")) return { ready: false, code: "technology-locked", reason: "需要科技：增产剂 Mk.I" };
  if ((state.construction.spray_coater ?? 0) < 1) return { ready: false, code: "stock-empty", reason: "施工托盘中没有可用喷涂机" };
  const recipe = getRecipe(entity.recipeId);
  if (!recipe) return { ready: false, code: "recipe-missing", reason: "请先为设备选择生产配方" };
  if (!entity.buildingId || entity.kind !== "machine" || entity.buildingId === "spray_coater" ||
    !buildingSupportsRecipe(entity.buildingId, recipe) ||
    (recipe.id !== "matrix_research" && (recipe.inputs.length === 0 || recipe.outputs.length === 0))) {
    return { ready: false, code: "recipe-incompatible", reason: "当前设备或配方不兼容喷涂机" };
  }
  return { ready: true, code: "ready", reason: "可以安装喷涂机" };
}

export function canInstallSprayCoater(state: GameState, entityId: string): boolean {
  return getSprayCoaterInstallCheck(state, entityId).ready;
}

export function installSprayCoater(state: GameState, entityId: string): GameState {
  if (!canInstallSprayCoater(state, entityId)) return state;
  const next = copyState(state);
  const entity = next.entities.find((candidate) => candidate.id === entityId)!;
  entity.sprayCoaterInstalled = true;
  entity.proliferatorMode = "normal";
  entity.proliferatorTier = 1;
  entity.proliferatorPoints = 0;
  entity.proliferatorBonusProgress = {};
  next.construction.spray_coater = (next.construction.spray_coater ?? 0) - 1;
  return next;
}

export function installSprayCoaters(state: GameState, entityIds: string[]): GameState {
  return [...new Set(entityIds)].reduce((current, entityId) => installSprayCoater(current, entityId), state);
}

export interface SprayCoaterRemovalRefund {
  sprayCoaters: number;
  proliferatorItemId?: ItemId;
  proliferatorItems: number;
  bufferedProliferatorItems: number;
  recoveredPointItems: number;
  remainingSprayPoints: number;
}

export function getSprayCoaterRemovalRefund(state: GameState, entityId: string): SprayCoaterRemovalRefund | null {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  if (!entity?.sprayCoaterInstalled) return null;
  const itemId = getEntityProliferatorItemId(entity);
  const bufferedProliferatorItems = itemId ? Math.max(0, Math.floor(entity.inputs[itemId] ?? 0)) : 0;
  const remainingSprayPoints = Math.max(0, Math.floor(entity.proliferatorPoints ?? 0));
  const pointsPerItem = entity.proliferatorTier ? getProliferator(entity.proliferatorTier).sprayPoints : 0;
  const recoveredPointItems = itemId && remainingSprayPoints > 0 && pointsPerItem > 0
    ? Math.ceil(remainingSprayPoints / pointsPerItem)
    : 0;
  return {
    sprayCoaters: 1,
    proliferatorItemId: itemId,
    proliferatorItems: bufferedProliferatorItems + recoveredPointItems,
    bufferedProliferatorItems,
    recoveredPointItems,
    remainingSprayPoints,
  };
}

export function removeSprayCoater(state: GameState, entityId: string): GameState {
  const current = state.entities.find((candidate) => candidate.id === entityId);
  if (!current?.sprayCoaterInstalled || current.interactionLocked) return state;
  const refund = getSprayCoaterRemovalRefund(state, entityId);
  if (!refund) return state;
  const next = copyState(state);
  const entity = next.entities.find((candidate) => candidate.id === entityId)!;
  if (refund.proliferatorItemId && refund.proliferatorItems > 0) {
    addToPlanetTray(next, entity.planetId, refund.proliferatorItemId, refund.proliferatorItems);
    entity.inputs[refund.proliferatorItemId] = 0;
  }
  const removedBelts = next.belts.filter((belt) => belt.target === entityId && PROLIFERATOR_ITEM_IDS.includes(belt.itemId));
  refundBelts(next, removedBelts);
  next.belts = next.belts.filter((belt) => !removedBelts.includes(belt));
  next.construction.spray_coater = Math.floor((next.construction.spray_coater ?? 0) + 1);
  entity.sprayCoaterInstalled = false;
  entity.proliferatorTier = undefined;
  entity.proliferatorMode = undefined;
  entity.proliferatorPoints = 0;
  entity.proliferatorBonusProgress = {};
  return next;
}

export function setProliferatorConfiguration(
  state: GameState,
  entityId: string,
  tier: ProliferatorTier,
  mode: ProliferatorMode,
): GameState {
  const current = state.entities.find((entity) => entity.id === entityId);
  const definition = getProliferator(tier);
  if (!current?.sprayCoaterInstalled || current.interactionLocked || !isProliferatorEligible(current) ||
    (current.recipeId === "matrix_research" && mode === "extra") ||
    !isTechnologyCompleted(state, definition.requiredTechId)) return state;
  if (current.proliferatorTier === tier && current.proliferatorMode === mode) return state;
  const next = copyState(state);
  const entity = next.entities.find((candidate) => candidate.id === entityId)!;
  if (entity.proliferatorTier !== tier) {
    const previousItemId = getEntityProliferatorItemId(entity);
    if (previousItemId) {
      addToTray(next, previousItemId, Math.floor(entity.inputs[previousItemId] ?? 0));
      entity.inputs[previousItemId] = 0;
    }
    const removedBelts = next.belts.filter((belt) => belt.target === entityId && PROLIFERATOR_ITEM_IDS.includes(belt.itemId));
    refundBelts(next, removedBelts);
    next.belts = next.belts.filter((belt) => !removedBelts.includes(belt));
    entity.proliferatorPoints = 0;
  }
  entity.proliferatorTier = tier;
  entity.proliferatorMode = mode;
  return next;
}

export function setEntitiesProliferatorConfiguration(
  state: GameState,
  entityIds: string[],
  tier: ProliferatorTier,
  mode: ProliferatorMode,
): GameState {
  return [...new Set(entityIds)].reduce((current, entityId) =>
    setProliferatorConfiguration(current, entityId, tier, mode), state);
}

export function pickFromEntity(state: GameState, entityId: string, itemId: ItemId, amount = 100): GameState {
  const entity = state.entities.find((item) => item.id === entityId);
  const reserved = stationReservedOutgoing(state, entityId, itemId);
  const total = Math.floor((entity?.outputs[itemId] ?? 0) + EPSILON);
  const available = Math.max(0, total - reserved);
  if (!entity || available < 1 || (state.cargo && state.cargo.itemId !== itemId)) return state;
  const next = copyState(state);
  const target = next.entities.find((item) => item.id === entityId)!;
  const currentCargo = next.cargo?.amount ?? 0;
  const taken = Math.floor(Math.min(available, amount, 100 - currentCargo));
  target.outputs[itemId] = total - taken;
  next.cargo = {
    itemId,
    amount: Math.floor(currentCargo + taken),
    origin: { kind: "node-output", id: entityId },
  };
  return next;
}

export function pickFromEntityInput(state: GameState, entityId: string, itemId: ItemId, amount = 100): GameState {
  const entity = state.entities.find((item) => item.id === entityId);
  const available = Math.floor((entity?.inputs[itemId] ?? 0) + EPSILON);
  if (!entity || available < 1 || (state.cargo && state.cargo.itemId !== itemId)) return state;
  const next = copyState(state);
  const target = next.entities.find((item) => item.id === entityId)!;
  const currentCargo = next.cargo?.amount ?? 0;
  const taken = Math.floor(Math.min(available, amount, 100 - currentCargo));
  target.inputs[itemId] = available - taken;
  next.cargo = {
    itemId,
    amount: Math.floor(currentCargo + taken),
    origin: { kind: "node-input", id: entityId },
  };
  return next;
}

export function moveEntityOutputToTray(state: GameState, entityId: string, itemId: ItemId): GameState {
  const entity = state.entities.find((item) => item.id === entityId);
  const total = Math.floor((entity?.outputs[itemId] ?? 0) + EPSILON);
  const available = Math.max(0, total - stationReservedOutgoing(state, entityId, itemId));
  if (!entity || available < 1) return state;
  const moved = Math.min(available, getPlanetTrayItemFreeCapacity(state, state.activePlanetId, itemId));
  if (moved < 1) return state;
  const next = copyState(state);
  const source = next.entities.find((item) => item.id === entityId)!;
  source.outputs[itemId] = total - moved;
  storeInTray(next, itemId, moved);
  return next;
}

export function moveEntityInputToTray(state: GameState, entityId: string, itemId: ItemId): GameState {
  const entity = state.entities.find((item) => item.id === entityId);
  const available = Math.floor((entity?.inputs[itemId] ?? 0) + EPSILON);
  if (!entity || available < 1) return state;
  const moved = Math.min(available, getPlanetTrayItemFreeCapacity(state, state.activePlanetId, itemId));
  if (moved < 1) return state;
  const next = copyState(state);
  const source = next.entities.find((item) => item.id === entityId)!;
  source.inputs[itemId] = available - moved;
  storeInTray(next, itemId, moved);
  return next;
}

export function moveEntityOutputToEntity(
  state: GameState,
  sourceId: string,
  targetId: string,
  itemId: ItemId,
): GameState {
  const source = state.entities.find((item) => item.id === sourceId);
  const target = state.entities.find((item) => item.id === targetId);
  const total = Math.floor((source?.outputs[itemId] ?? 0) + EPSILON);
  const available = Math.max(0, total - stationReservedOutgoing(state, sourceId, itemId));
  if (!source || !target?.buildingId || available < 1 || !targetConsumes(state, target, itemId)) return state;
  const capacity = getEntityItemInputCapacity(state, target, itemId);
  const current = Math.floor((target.inputs[itemId] ?? 0) + EPSILON);
  const moved = Math.floor(Math.min(available, Math.max(0, capacity - current)));
  if (moved < 1) return state;
  const next = copyState(state);
  next.entities.find((item) => item.id === sourceId)!.outputs[itemId] = total - moved;
  const nextTarget = next.entities.find((item) => item.id === targetId)!;
  configureTargetItem(nextTarget, itemId);
  nextTarget.inputs[itemId] = current + moved;
  return next;
}

export function moveEntityInputToEntity(
  state: GameState,
  sourceId: string,
  targetId: string,
  itemId: ItemId,
): GameState {
  if (sourceId === targetId) return state;
  const source = state.entities.find((item) => item.id === sourceId);
  const target = state.entities.find((item) => item.id === targetId);
  const available = Math.floor((source?.inputs[itemId] ?? 0) + EPSILON);
  if (!source || !target?.buildingId || available < 1 || !targetConsumes(state, target, itemId)) return state;
  const capacity = getEntityItemInputCapacity(state, target, itemId);
  const current = Math.floor((target.inputs[itemId] ?? 0) + EPSILON);
  const moved = Math.floor(Math.min(available, Math.max(0, capacity - current)));
  if (moved < 1) return state;
  const next = copyState(state);
  next.entities.find((item) => item.id === sourceId)!.inputs[itemId] = available - moved;
  const nextTarget = next.entities.find((item) => item.id === targetId)!;
  configureTargetItem(nextTarget, itemId);
  nextTarget.inputs[itemId] = current + moved;
  return next;
}

export function moveTrayItemToEntity(state: GameState, targetId: string, itemId: ItemId): GameState {
  const target = state.entities.find((item) => item.id === targetId);
  const available = Math.floor((state.tray[itemId] ?? 0) + EPSILON);
  if (!target?.buildingId || available < 1 || !targetConsumes(state, target, itemId)) return state;
  const capacity = getEntityItemInputCapacity(state, target, itemId);
  const current = Math.floor((target.inputs[itemId] ?? 0) + EPSILON);
  const moved = Math.floor(Math.min(available, Math.max(0, capacity - current)));
  if (moved < 1) return state;
  const next = copyState(state);
  next.tray[itemId] = available - moved;
  const nextTarget = next.entities.find((item) => item.id === targetId)!;
  configureTargetItem(nextTarget, itemId);
  nextTarget.inputs[itemId] = current + moved;
  return next;
}

export function dropCargoToEntity(state: GameState, entityId: string): GameState {
  if (!state.cargo) return state;
  const entity = state.entities.find((item) => item.id === entityId);
  if (!entity?.buildingId || !targetConsumes(state, entity, state.cargo.itemId)) return state;
  const next = copyState(state);
  const target = next.entities.find((item) => item.id === entityId)!;
  const cargo = next.cargo;
  if (!cargo) return state;
  const capacity = getEntityItemInputCapacity(next, target, cargo.itemId);
  const current = target.inputs[cargo.itemId] ?? 0;
  const moved = Math.floor(Math.min(cargo.amount, Math.max(0, capacity - current)));
  configureTargetItem(target, cargo.itemId);
  target.inputs[cargo.itemId] = Math.floor(current + moved);
  cargo.amount = Math.floor(cargo.amount - moved);
  if (cargo.amount < 1) next.cargo = null;
  return next;
}

export function dropCargoToTray(state: GameState): GameState {
  if (!state.cargo) return state;
  const next = copyState(state);
  const cargo = next.cargo;
  if (!cargo) return state;
  // A player-controlled cursor must never become trapped by an automatic tray
  // limit. Protective/manual returns are lossless; automated writers continue
  // to use storeInTray() and remain capacity-limited.
  addToTray(next, cargo.itemId, Math.max(0, Math.floor(cargo.amount)));
  next.cargo = null;
  return next;
}

export function pickFromTray(state: GameState, itemId: ItemId, amount = 100): GameState {
  const available = Math.floor((state.tray[itemId] ?? 0) + EPSILON);
  if (available < 1 || (state.cargo && state.cargo.itemId !== itemId)) return state;
  const next = copyState(state);
  const currentCargo = next.cargo?.amount ?? 0;
  const taken = Math.floor(Math.min(available, amount, 100 - currentCargo));
  next.tray[itemId] = available - taken;
  next.cargo = { itemId, amount: Math.floor(currentCargo + taken), origin: { kind: "tray" } };
  return next;
}

export const MAX_MANUAL_CRAFT_BATCHES = 100_000;

function normalizeManualCraftBatches(batches: number): number {
  return Math.max(1, Math.min(MAX_MANUAL_CRAFT_BATCHES, Math.floor(Number.isFinite(batches) ? batches : 1)));
}

export function craftConstruction(state: GameState, buildingId: ConstructionId, batches = 1): GameState {
  const definition = CONSTRUCTION.find((item) => item.buildingId === buildingId);
  const amount = normalizeManualCraftBatches(batches);
  if (!definition || (definition.requiredTechId && !isTechnologyCompleted(state, definition.requiredTechId)) ||
    definition.costs.some((cost) => (state.tray[cost.itemId] ?? 0) + EPSILON < cost.amount * amount)) return state;
  const next = copyState(state);
  for (const cost of definition.costs) {
    next.tray[cost.itemId] = Math.floor((next.tray[cost.itemId] ?? 0) - cost.amount * amount);
  }
  next.construction[buildingId] = (next.construction[buildingId] ?? 0) + definition.outputAmount * amount;
  return next;
}

export interface ConstructionQuickCraftPlan {
  status: "direct" | "upstream" | "blocked";
  possible: boolean;
  usesUpstream: boolean;
  missingTechnology: string | null;
  missingItems: Array<{ itemId: ItemId; current: number; required: number; missing: number }>;
  consumedItems: Array<{ itemId: ItemId; amount: number }>;
  producedItems: Array<{ itemId: ItemId; amount: number }>;
  batches: number;
  outputAmount: number;
  blocker?: { reason: "safety-limit"; itemId: ItemId; current: number; expected: number; limit: number };
  recipeDecisions?: RecursiveCraftDecision[];
}

interface InternalConstructionQuickCraftPlan extends ConstructionQuickCraftPlan {
  inventory?: Partial<Record<ItemId, number>>;
}

const recursiveManufacturingRecipes = (): RecipeDefinition[] =>
  Object.values(RECIPES).filter((recipe) => isRecursiveManufacturingRecipe(recipe.id));

function recursiveManufacturingInventory(state: GameState): Partial<Record<ItemId, number>> {
  return {
    ...state.tray,
    logistics_drone: Math.max(0, Math.floor(state.portableFleet?.logistics_drone ?? 0)),
    logistics_vessel: Math.max(0, Math.floor(state.portableFleet?.logistics_vessel ?? 0)),
  };
}

function recursiveProducedItems(plan: RecursiveCraftPlan): Array<{ itemId: ItemId; amount: number }> {
  const totals = new Map<ItemId, number>();
  for (const step of plan.steps) {
    const recipe = getRecipe(step.recipeId);
    if (!recipe) continue;
    for (const output of recipe.outputs) {
      totals.set(output.itemId, (totals.get(output.itemId) ?? 0) + output.amount * step.batches);
    }
  }
  return [...totals].map(([itemId, amount]) => ({ itemId, amount: Math.max(0, Math.floor(amount)) }));
}

function applyRecursiveManufacturingInventory(state: GameState, inventory: Partial<Record<ItemId, number>>): void {
  const tray = { ...inventory };
  state.portableFleet.logistics_drone = Math.max(0, Math.floor(tray.logistics_drone ?? 0));
  state.portableFleet.logistics_vessel = Math.max(0, Math.floor(tray.logistics_vessel ?? 0));
  delete tray.logistics_drone;
  delete tray.logistics_vessel;
  state.tray = tray;
  state.planetTrays[state.activePlanetId] = { ...tray };
}

function findUnsafeRecursiveInventory(inventory: Partial<Record<ItemId, number>>): { itemId: ItemId; value: number } | undefined {
  return (Object.entries(inventory) as Array<[ItemId, number | undefined]>).map(([itemId, amount]) => ({
    itemId,
    value: amount ?? 0,
  })).find(({ value }) => !Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER);
}

function recursiveMissingItem(blocker: RecursiveCraftBlocker | undefined): ConstructionQuickCraftPlan["missingItems"] {
  if (!blocker) return [];
  return [{
    itemId: blocker.itemId,
    current: blocker.current,
    required: blocker.required,
    missing: Math.max(0, blocker.required - blocker.current),
  }];
}

function buildConstructionQuickCraftPlan(state: GameState, buildingId: ConstructionId, batches = 1): InternalConstructionQuickCraftPlan {
  const definition = getConstructionDefinition(buildingId);
  const amount = normalizeManualCraftBatches(batches);
  const directDeficits = getConstructionCraftDeficits(state, buildingId, amount);
  const impossible = {
    status: "blocked",
    possible: false,
    usesUpstream: false,
    missingTechnology: directDeficits.missingTechnology,
    missingItems: directDeficits.missingItems,
    consumedItems: [],
    producedItems: [],
    batches: amount,
    outputAmount: definition ? definition.outputAmount * amount : 0,
  } satisfies ConstructionQuickCraftPlan;
  if (!definition || directDeficits.missingTechnology) return impossible;

  const initialInventory = recursiveManufacturingInventory(state);
  const recursivePlan = planRecursiveRequirements({
    inventory: initialInventory,
    requirements: definition.costs.map((cost) => ({ itemId: cost.itemId, amount: cost.amount * amount })),
    recipes: recursiveManufacturingRecipes(),
    completedTechnologyIds: state.research.completedTechIds,
  });
  if (!recursivePlan.possible) {
    return {
      ...impossible,
      missingTechnology: recursivePlan.blocker?.reason === "technology" && recursivePlan.blocker.technologyId
        ? getTechnology(recursivePlan.blocker.technologyId)?.name ?? recursivePlan.blocker.technologyId
        : null,
      missingItems: recursiveMissingItem(recursivePlan.blocker),
    };
  }

  const selected = recursivePlan;
  const unsafe = findUnsafeRecursiveInventory(selected.inventory);
  if (unsafe) return {
    ...impossible,
    blocker: {
      reason: "safety-limit",
      itemId: unsafe.itemId,
      current: Math.max(0, Math.floor(initialInventory[unsafe.itemId] ?? 0)),
      expected: unsafe.value,
      limit: Number.MAX_SAFE_INTEGER,
    },
  };
  const consumedItems = (Object.keys(ITEMS) as ItemId[]).flatMap((itemId) => {
    const consumed = Math.max(0, Math.floor((initialInventory[itemId] ?? 0) - (selected.inventory[itemId] ?? 0)));
    return consumed > 0 ? [{ itemId, amount: consumed }] : [];
  });
  const producedItems = recursiveProducedItems(recursivePlan);
  return {
    status: producedItems.length > 0 ? "upstream" : "direct",
    possible: true,
    usesUpstream: producedItems.length > 0,
    missingTechnology: null,
    missingItems: directDeficits.missingItems,
    consumedItems,
    producedItems,
    batches: amount,
    outputAmount: definition.outputAmount * amount,
    inventory: selected.inventory,
    recipeDecisions: selected.decisions,
  };
}

export function getConstructionQuickCraftPlan(state: GameState, buildingId: ConstructionId, batches = 1): ConstructionQuickCraftPlan {
  const { inventory: _inventory, ...plan } = buildConstructionQuickCraftPlan(state, buildingId, batches);
  return plan;
}

export function getMaxConstructionQuickCraftBatches(state: GameState, buildingId: ConstructionId): number {
  if (!buildConstructionQuickCraftPlan(state, buildingId, 1).possible) return 0;
  let low = 1;
  let high = 2;
  while (high < MAX_MANUAL_CRAFT_BATCHES && buildConstructionQuickCraftPlan(state, buildingId, high).possible) {
    low = high;
    high = Math.min(MAX_MANUAL_CRAFT_BATCHES, high * 2);
  }
  if (high === MAX_MANUAL_CRAFT_BATCHES && buildConstructionQuickCraftPlan(state, buildingId, high).possible) return high;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (buildConstructionQuickCraftPlan(state, buildingId, middle).possible) low = middle;
    else high = middle;
  }
  return low;
}

export type ConstructionCraftNavigationResult =
  | { status: "target"; itemId: ItemId; recipeId: RecipeId }
  | { status: "technology"; itemId: ItemId; technologyName: string }
  | { status: "raw-shortage"; itemId: ItemId; current: number; required: number }
  | { status: "no-handcraft"; itemId: ItemId }
  | { status: "ready" };

export function getConstructionCraftNavigation(state: GameState, buildingId: ConstructionId): ConstructionCraftNavigationResult {
  const definition = getConstructionDefinition(buildingId);
  if (!definition) return { status: "no-handcraft", itemId: "iron_ore" };
  if (definition.requiredTechId && !isTechnologyCompleted(state, definition.requiredTechId)) {
    return {
      status: "technology",
      itemId: definition.costs[0]?.itemId ?? "iron_ore",
      technologyName: getTechnology(definition.requiredTechId)?.name ?? definition.requiredTechId,
    };
  }
  const plan = planRecursiveRequirements({
    inventory: recursiveManufacturingInventory(state),
    requirements: definition.costs,
    recipes: recursiveManufacturingRecipes(),
    completedTechnologyIds: state.research.completedTechIds,
  });
  if (plan.possible) {
    const step = plan.steps[0];
    return step ? { status: "target", itemId: step.outputItemId, recipeId: step.recipeId } : { status: "ready" };
  }
  const blocker = plan.blocker;
  if (!blocker) return { status: "no-handcraft", itemId: definition.costs[0]?.itemId ?? "iron_ore" };
  if (blocker.reason === "technology") {
    return {
      status: "technology",
      itemId: blocker.itemId,
      technologyName: blocker.technologyId ? getTechnology(blocker.technologyId)?.name ?? blocker.technologyId : "未知科技",
    };
  }
  if (blocker.reason === "raw-shortage") {
    return { status: "raw-shortage", itemId: blocker.itemId, current: blocker.current, required: blocker.required };
  }
  return { status: "no-handcraft", itemId: blocker.itemId };
}

export function craftConstructionWithUpstream(state: GameState, buildingId: ConstructionId, batches = 1): GameState {
  const definition = getConstructionDefinition(buildingId);
  const plan = buildConstructionQuickCraftPlan(state, buildingId, batches);
  if (!definition || !plan.possible || !plan.inventory) return state;
  const next = copyState(state);
  applyRecursiveManufacturingInventory(next, plan.inventory);
  for (const item of plan.producedItems) {
    next.totalProduced[item.itemId] = Math.floor((next.totalProduced[item.itemId] ?? 0) + item.amount);
  }
  next.construction[buildingId] = Math.floor((next.construction[buildingId] ?? 0) + plan.outputAmount);
  return next;
}

export function getConstructionAutomationStockLimit(state: GameState): number {
  if (isTechnologyCompleted(state, "construction_capacity_2")) return MAX_CONSTRUCTION_AUTOMATION_TARGET;
  if (isTechnologyCompleted(state, "construction_capacity_1")) return 500;
  return 100;
}

export function getConstructionAutomationCycleSeconds(state: GameState): number {
  if (isTechnologyCompleted(state, "construction_capacity_2")) return 1;
  if (isTechnologyCompleted(state, "construction_capacity_1")) return 2.5;
  return 5;
}

export function setConstructionAutomationEnabled(state: GameState, enabled: boolean): GameState {
  if (state.constructionAutomation.enabled === enabled) return state;
  return { ...state, constructionAutomation: { ...state.constructionAutomation, enabled } };
}

export function setGalacticMaterialExporterPaused(state: GameState, entityId: string, paused: boolean): GameState {
  const entity = state.entities.find((candidate) => candidate.id === entityId && candidate.buildingId === "galactic_material_exporter");
  if (!entity || entity.interactionLocked || (entity.galacticExporterPaused !== false) === paused) return state;
  return {
    ...state,
    entities: state.entities.map((candidate) => candidate.id === entityId ? { ...candidate, galacticExporterPaused: paused } : candidate),
  };
}

function refundConstructionAutomationJob(state: GameState, entityId: string, job: ConstructionAutomationJob): void {
  const planetId = state.entities.find((entity) => entity.id === entityId)?.planetId ?? state.activePlanetId;
  const tray = trayForPlanet(state, planetId);
  for (const [itemId, amount] of Object.entries(job.inventory) as Array<[ItemId, number]>) {
    const refund = Math.max(0, Math.floor(amount ?? 0));
    if (refund < 1) continue;
    if (isPortableFleetItem(itemId)) state.portableFleet[itemId] = Math.floor((state.portableFleet[itemId] ?? 0) + refund);
    else tray[itemId] = Math.floor((tray[itemId] ?? 0) + refund);
  }
}

interface ConstructionAutomationTargetDefinition {
  id: ConstructionAutomationTargetId;
  name: string;
  outputAmount: number;
  costs: Array<{ itemId: ItemId; amount: number }>;
  requiredTechId?: TechId;
  kind: "building" | "fleet";
  recipeId?: RecipeId;
}

function getConstructionAutomationTargets(): ConstructionAutomationTargetDefinition[] {
  const buildings = CONSTRUCTION.map((definition) => ({
    id: definition.buildingId,
    name: definition.name,
    outputAmount: definition.outputAmount,
    costs: definition.costs,
    requiredTechId: definition.requiredTechId,
    kind: "building" as const,
  }));
  const fleet = PORTABLE_FLEET_ITEM_IDS.flatMap((itemId) => {
    const recipe = getRecipe(itemId);
    const output = recipe?.outputs.find((candidate) => candidate.itemId === itemId);
    return recipe && output ? [{
      id: itemId,
      name: ITEMS[itemId].name,
      outputAmount: output.amount,
      costs: recipe.inputs,
      requiredTechId: recipe.requiredTechId,
      kind: "fleet" as const,
      recipeId: recipe.id,
    }] : [];
  });
  return [...buildings, ...fleet];
}

function getConstructionAutomationTargetDefinition(id: ConstructionAutomationTargetId): ConstructionAutomationTargetDefinition | undefined {
  return getConstructionAutomationTargets().find((definition) => definition.id === id);
}

function constructionAutomationCurrentStock(state: GameState, id: ConstructionAutomationTargetId): number {
  return isPortableFleetItem(id)
    ? Math.max(0, Math.floor(state.portableFleet[id] ?? 0))
    : Math.max(0, Math.floor(state.construction[id] ?? 0));
}

export function setConstructionAutomationTarget(state: GameState, constructionId: ConstructionAutomationTargetId, target: number): GameState {
  if (!getConstructionAutomationTargetDefinition(constructionId) || !Number.isSafeInteger(target)) return state;
  const normalized = Math.max(0, Math.min(getConstructionAutomationStockLimit(state), Math.floor(target)));
  if ((state.constructionAutomation.targetStock[constructionId] ?? 0) === normalized) return state;
  const targetStock = { ...state.constructionAutomation.targetStock };
  if (normalized < 1) delete targetStock[constructionId];
  else targetStock[constructionId] = normalized;
  if (normalized <= constructionAutomationCurrentStock(state, constructionId)) {
    const next = copyState(state);
    next.constructionAutomation.targetStock = targetStock;
    for (const [entityId, job] of Object.entries(next.constructionAutomation.jobs)) {
      if (job.constructionId !== constructionId) continue;
      refundConstructionAutomationJob(next, entityId, job);
      delete next.constructionAutomation.jobs[entityId];
    }
    return next;
  }
  return { ...state, constructionAutomation: { ...state.constructionAutomation, targetStock } };
}

export interface ConstructionAutomationBatchTargetResult {
  state: GameState;
  ok: boolean;
  changedCount: number;
  affectedCount: number;
  skippedLockedCount: number;
  error?: "invalid-target" | "technology-limit" | "no-unlocked-buildings";
  label?: string;
}

/**
 * Set one target for every unlocked, manufacturable building in one state
 * update. Existing jobs and WIP are deliberately left untouched: changing a
 * target is a policy change, not a cancellation or refund operation.
 */
export function setConstructionAutomationTargetsForBuildings(state: GameState, target: number): ConstructionAutomationBatchTargetResult {
  if (!Number.isSafeInteger(target) || target < 1) {
    return { state, ok: false, changedCount: 0, affectedCount: 0, skippedLockedCount: 0, error: "invalid-target", label: "目标数量必须是正安全整数" };
  }
  const stockLimit = getConstructionAutomationStockLimit(state);
  if (target > stockLimit) {
    return {
      state,
      ok: false,
      changedCount: 0,
      affectedCount: 0,
      skippedLockedCount: 0,
      error: "technology-limit",
      label: `当前科技允许的目标上限为 ${stockLimit.toLocaleString("zh-CN")}，完成建筑仓储扩容 II 后可设置到 ${MAX_CONSTRUCTION_AUTOMATION_TARGET.toLocaleString("zh-CN")}`,
    };
  }
  const definitions = getConstructionAutomationTargets();
  const unlocked = definitions.filter((definition) => definition.kind === "building" && (!definition.requiredTechId || isTechnologyCompleted(state, definition.requiredTechId)));
  const skippedLockedCount = definitions.filter((definition) => definition.kind === "building" && definition.requiredTechId && !isTechnologyCompleted(state, definition.requiredTechId)).length;
  if (unlocked.length === 0) {
    return { state, ok: false, changedCount: 0, affectedCount: 0, skippedLockedCount, error: "no-unlocked-buildings", label: "当前没有已解锁的可制造建筑" };
  }
  const targetStock = { ...state.constructionAutomation.targetStock };
  let changedCount = 0;
  for (const definition of unlocked) {
    if ((targetStock[definition.id] ?? 0) === target) continue;
    targetStock[definition.id] = target;
    changedCount += 1;
  }
  if (changedCount === 0) return { state, ok: true, changedCount: 0, affectedCount: unlocked.length, skippedLockedCount };
  return {
    state: { ...state, constructionAutomation: { ...state.constructionAutomation, targetStock } },
    ok: true,
    changedCount,
    affectedCount: unlocked.length,
    skippedLockedCount,
  };
}

interface ConstructionAutomationBlocker {
  itemId: ItemId;
  current: number;
  required: number;
  reason: "raw-shortage" | "technology" | "no-handcraft";
  technologyName?: string;
}

interface ConstructionAutomationPlan {
  steps: ConstructionAutomationStep[];
  blocker?: ConstructionAutomationBlocker;
  recipeDecisions?: ConstructionAutomationJob["recipeDecisions"];
  recursiveDecisions?: RecursiveCraftDecision[];
}

function constructionAutomationPending(state: GameState, constructionId: ConstructionAutomationTargetId): number {
  return Object.values(state.constructionAutomation.jobs).reduce((sum, job) => {
    if (job.constructionId !== constructionId) return sum;
    const definition = getConstructionAutomationTargetDefinition(constructionId);
    return sum + (definition?.outputAmount ?? 0);
  }, 0);
}

export function normalizeConstructionAutomationCursor(cursor: number): number {
  const length = getConstructionAutomationTargets().length;
  if (length < 1) return 0;
  const integerCursor = Number.isFinite(cursor) && Number.isSafeInteger(Math.trunc(cursor))
    ? Math.trunc(cursor)
    : 0;
  return ((integerCursor % length) + length) % length;
}

function constructionAutomationTarget(state: GameState, cursor = state.constructionAutomation.cursor): { index: number; definition: ConstructionAutomationTargetDefinition } | null {
  const definitions = getConstructionAutomationTargets();
  if (definitions.length === 0) return null;
  const normalizedCursor = normalizeConstructionAutomationCursor(cursor);
  for (let offset = 0; offset < definitions.length; offset += 1) {
    const index = (normalizedCursor + offset) % definitions.length;
    const definition = definitions[index];
    // Imported and experimental saves can carry a stale cursor. A scheduler
    // cursor must never turn into a missing catalog definition.
    if (!definition) continue;
    const target = state.constructionAutomation.targetStock[definition.id] ?? 0;
    const current = constructionAutomationCurrentStock(state, definition.id) + constructionAutomationPending(state, definition.id);
    if (target <= current || definition.requiredTechId && !isTechnologyCompleted(state, definition.requiredTechId)) continue;
    return { index, definition };
  }
  return null;
}

function constructionAutomationBlocker(blocker: RecursiveCraftBlocker | undefined): ConstructionAutomationBlocker | undefined {
  if (!blocker) return undefined;
  return {
    itemId: blocker.itemId,
    current: blocker.current,
    required: blocker.required,
    reason: blocker.reason === "raw-shortage" ? "raw-shortage"
      : blocker.reason === "technology" ? "technology" : "no-handcraft",
    technologyName: blocker.technologyId
      ? getTechnology(blocker.technologyId)?.name ?? blocker.technologyId
      : undefined,
  };
}

function constructionAutomationRecipeDecisions(decisions: RecursiveCraftDecision[]): ConstructionAutomationJob["recipeDecisions"] {
  return decisions.map((decision) => ({
    itemId: decision.itemId,
    recipeId: decision.recipeId,
    fallbackReason: decision.fallbacks.length > 0
      ? decision.fallbacks.map((fallback) => {
        const recipeName = getRecipe(fallback.recipeId)?.name ?? fallback.recipeId;
        if (fallback.reason === "technology") return `${recipeName}科技未解锁`;
        const blockerName = fallback.blocker ? ITEMS[fallback.blocker.itemId]?.name : null;
        return blockerName ? `${recipeName}缺少${blockerName}` : `${recipeName}材料链不可完成`;
      }).join("；")
      : undefined,
  }));
}

function buildConstructionAutomationPlan(state: GameState, definition: ConstructionAutomationTargetDefinition, planetId: PlanetId): ConstructionAutomationPlan {
  const tray = trayForPlanet(state, planetId);
  const inventory = Object.fromEntries((Object.entries(tray) as Array<[ItemId, number]>).map(([itemId, amount]) => [
    itemId,
    Math.max(0, Math.floor(amount ?? 0)),
  ])) as Partial<Record<ItemId, number>>;
  const recipes = recursiveManufacturingRecipes();
  const plan = definition.kind === "fleet" && definition.recipeId
    ? planSelectedRecipe({
      inventory,
      recipe: RECIPES[definition.recipeId],
      batches: 1,
      recipes,
      completedTechnologyIds: state.research.completedTechIds,
      allowRecipe: (recipe) => isRecursiveManufacturingRecipe(recipe.id),
    })
    : planRecursiveRequirements({
      inventory,
      requirements: definition.costs,
      recipes,
      completedTechnologyIds: state.research.completedTechIds,
      allowRecipe: (recipe) => isRecursiveManufacturingRecipe(recipe.id),
    });
  if (!plan.possible) return { steps: [], blocker: constructionAutomationBlocker(plan.blocker) };
  const steps: ConstructionAutomationStep[] = plan.steps.map((step) => ({
    kind: "material",
    recipeId: step.recipeId,
    batches: step.batches,
    outputItemId: step.outputItemId,
    outputAmount: step.outputAmount,
  }));
  if (definition.kind === "fleet" && isPortableFleetItem(definition.id)) {
    steps.push({ kind: "fleet", itemId: definition.id, amount: definition.outputAmount });
  } else if (!isPortableFleetItem(definition.id)) {
    steps.push({ kind: "building", constructionId: definition.id });
  }
  return {
    steps,
    recipeDecisions: constructionAutomationRecipeDecisions(plan.decisions),
    recursiveDecisions: plan.decisions,
  };
}

function constructionAutomationHasDeficit(state: GameState): boolean {
  return Boolean(state.constructionAutomation.enabled &&
    (Object.keys(state.constructionAutomation.jobs).length > 0 || constructionAutomationTarget(state)));
}

export function getConstructionAutomationMaterialSeconds(state: GameState): number {
  return 0.1 * getConstructionAutomationCycleSeconds(state) / 5;
}

export interface ConstructionAutomationStatus {
  stage: string;
  progress: number;
  etaSeconds: number;
  missingItemId?: ItemId;
  missingAmount?: number;
  blockerReason?: "raw-shortage" | "technology" | "no-handcraft" | "paused" | "no-power";
  technologyName?: string;
  recipeName?: string;
  recipeFallbackReason?: string;
  wipCount?: number;
  wipItems?: Array<{ itemId: ItemId; amount: number }>;
  destroyedByproductCount?: number;
  destroyedByproductItems?: Array<{ itemId: ItemId; amount: number }>;
  protectionReason?: "high-stack";
}

export const CONSTRUCTION_AUTOMATION_PROTECTION_STACK_THRESHOLD = 10_000;
export const CONSTRUCTION_AUTOMATION_MAX_ITERATIONS_PER_SIMULATION_SECOND = 256;
export const CONSTRUCTION_AUTOMATION_MAX_PLAN_BUILDS_PER_SIMULATION_SECOND = 24;
const CONSTRUCTION_AUTOMATION_MAX_FAIR_BATCH_JOBS = 4_096;

function constructionAutomationProtectedStage(entity: FactoryEntity, stage: string): Pick<ConstructionAutomationStatus, "stage" | "protectionReason"> {
  return entity.machineCount >= CONSTRUCTION_AUTOMATION_PROTECTION_STACK_THRESHOLD
    ? { stage: `计算保护中 · 高堆叠分段 · ${stage}`, protectionReason: "high-stack" }
    : { stage };
}

export interface ConstructionCenterTraceSample {
  wallSecond: number;
  simulationSecond: number;
  workerLatencyMs: number;
  pendingSimulationSeconds: number;
  entityId: string;
  constructionId: ConstructionId | null;
  stepIndex: number;
  stepKind: ConstructionAutomationStep["kind"] | null;
  stepItemId: ItemId | null;
  stepElapsedSeconds: number;
  stepDurationSeconds: number;
  wipCount: number;
  powerFactor: number;
  statusCode: string;
  completedBuildings: number;
  guardHitCount: number;
}

function constructionAutomationStepDuration(state: GameState, step: ConstructionAutomationStep): number {
  if (step.kind === "building") return getConstructionAutomationCycleSeconds(state);
  if (step.kind === "fleet") return 0.01;
  return Math.max(0.01, getConstructionAutomationMaterialSeconds(state) * step.outputAmount);
}

export function getEntityRecipeCycleCapacityPerSimulationSecond(
  state: GameState,
  entity: FactoryEntity,
  lookup?: SimulationLookupContext,
): number {
  if (state.paused) return 0;
  if (entity.kind === "vein") return Math.max(0, entity.productionRate / 60);
  if (entity.buildingId === "construction_center") {
    const job = state.constructionAutomation.jobs[entity.id];
    const step = job?.steps[job.stepIndex];
    return step ? Math.max(0, entity.machineCount * getEntityPowerFactor(state, entity, lookup) / constructionAutomationStepDuration(state, step)) : 0;
  }
  const recipe = getRecipe(entity.recipeId);
  if (!entity.buildingId || !recipe) return 0;
  if (entity.buildingId === "ray_receiver") {
    return recipe.id === "critical_photon"
      ? getBuilding(entity.buildingId).speed * entity.machineCount / recipe.duration * entity.utilization
      : 0;
  }
  if (entity.kind === "machine") {
    const building = getBuilding(entity.buildingId);
    const profile = getPlanetIndustrialProfile(state, entity.planetId);
    const planetSpeed = specializationApplies(profile, building.family, entity.buildingId) ? profile.productionSpeedMultiplier : 1;
    const spraySpeed = entity.proliferatorMode === "speed" && availableFullProliferatorCycles(entity, recipe) > 0
      ? getEntityProliferatorSpeedMultiplier(entity)
      : 1;
    return Math.max(0, building.speed * entity.machineCount * getRecipeSpeedMultiplier(state, recipe.id) * planetSpeed /
      recipe.duration * getEntityPowerFactor(state, entity, lookup) * dysonLaunchFactor(state, recipe.id) * spraySpeed);
  }
  return Math.max(0, entity.productionRate / Math.max(1, recipe.outputs.reduce((sum, output) => sum + output.amount, 0)) / 60);
}

export function getEntityCycleRatePerSimulationSecond(
  state: GameState,
  entity: FactoryEntity,
  lookup?: SimulationLookupContext,
): number {
  if (entity.utilization <= EPSILON) return 0;
  return getEntityRecipeCycleCapacityPerSimulationSecond(state, entity, lookup);
}

export function getConstructionAutomationStatus(state: GameState, entityId: string): ConstructionAutomationStatus {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  if (!entity || entity.buildingId !== "construction_center") return { stage: "无制造任务", progress: 0, etaSeconds: 0 };
  const inventoryItems = (inventory: Partial<Record<ItemId, number>>) =>
    (Object.entries(inventory) as Array<[ItemId, number]>).flatMap(([itemId, rawAmount]) => {
      const amount = Math.max(0, Math.floor(rawAmount ?? 0));
      return amount > 0 ? [{ itemId, amount }] : [];
    }).sort((left, right) => left.itemId.localeCompare(right.itemId));
  const destroyedByproductItems = inventoryItems(state.constructionAutomation.destroyedByproducts);
  const destroyedByproductCount = destroyedByproductItems.reduce((sum, item) => sum + item.amount, 0);
  const job = state.constructionAutomation.jobs[entityId];
  if (job) {
    const step = job.steps[job.stepIndex];
    if (!step) return { stage: "准备下一项", progress: 0, etaSeconds: 0 };
    const duration = constructionAutomationStepDuration(state, step);
    const tray = trayForPlanet(state, entity.planetId);
    const requirements = constructionAutomationRequirements(step);
    const missing = requirements.find((requirement) =>
      (tray[requirement.itemId] ?? 0) + (job.inventory[requirement.itemId] ?? 0) + EPSILON < requirement.amount);
    const paused = state.paused || !state.constructionAutomation.enabled;
    const noPower = !paused && getEntityPowerFactor(state, entity) <= EPSILON;
    const blockedByMaterials = !paused && !noPower && Boolean(missing);
    const recipeDecision = step.kind === "material"
      ? job.recipeDecisions?.find((decision) => decision.itemId === step.outputItemId && decision.recipeId === step.recipeId)
      : undefined;
    const wipItems = inventoryItems(job.inventory);
    const stage = state.paused ? "游戏已暂停" : !state.constructionAutomation.enabled ? "自动制造已暂停" : noPower ? "等待供电" : blockedByMaterials ? "等待材料" : step.kind === "building"
        ? `制造 ${getConstructionDefinition(step.constructionId)?.name ?? step.constructionId}`
        : step.kind === "fleet" ? `入库 ${ITEMS[step.itemId].name}` : `加工 ${ITEMS[step.outputItemId].name}`;
    return {
      ...constructionAutomationProtectedStage(entity, stage),
      progress: Math.max(0, Math.min(1, job.elapsedSeconds / duration)),
      etaSeconds: Math.max(0, (duration - job.elapsedSeconds) + job.steps.slice(job.stepIndex + 1).reduce((sum, pending) => sum + constructionAutomationStepDuration(state, pending), 0)) /
        Math.max(1, entity.machineCount),
      missingItemId: blockedByMaterials ? missing?.itemId : undefined,
      missingAmount: blockedByMaterials && missing ? Math.max(0, missing.amount - Math.floor(tray[missing.itemId] ?? 0) - Math.floor(job.inventory[missing.itemId] ?? 0)) : undefined,
      blockerReason: paused ? "paused" : noPower ? "no-power" : blockedByMaterials ? "raw-shortage" : undefined,
      recipeName: step.kind === "material" ? getRecipe(step.recipeId)?.name : undefined,
      recipeFallbackReason: recipeDecision?.fallbackReason,
      wipCount: wipItems.reduce((sum, item) => sum + item.amount, 0),
      wipItems,
      destroyedByproductCount,
      destroyedByproductItems,
    };
  }
  const target = constructionAutomationTarget(state);
  if (state.paused || !state.constructionAutomation.enabled) return {
    stage: state.paused ? "游戏已暂停" : "自动制造已暂停",
    progress: 0,
    etaSeconds: 0,
    blockerReason: "paused",
    wipCount: 0,
    wipItems: [],
    destroyedByproductCount,
    destroyedByproductItems,
  };
  if (!target) return { stage: "目标库存已满足", progress: 0, etaSeconds: 0, wipCount: 0, wipItems: [], destroyedByproductCount, destroyedByproductItems };
  const plan = buildConstructionAutomationPlan(state, target.definition, entity.planetId);
  if (plan.blocker) {
    return {
      ...constructionAutomationProtectedStage(entity, "等待材料"),
      progress: 0,
      etaSeconds: 0,
      missingItemId: plan.blocker.itemId,
      missingAmount: Math.max(0, plan.blocker.required - plan.blocker.current),
      blockerReason: plan.blocker.reason,
      technologyName: plan.blocker.technologyName,
      wipCount: 0,
      wipItems: [],
      destroyedByproductCount,
      destroyedByproductItems,
    };
  }
  if (getEntityPowerFactor(state, entity) <= EPSILON) return {
    stage: "等待供电",
    progress: 0,
    etaSeconds: 0,
    blockerReason: "no-power",
    wipCount: 0,
    wipItems: [],
    destroyedByproductCount,
    destroyedByproductItems,
  };
  const lastDecision = plan.recipeDecisions?.at(-1);
  const recipeName = lastDecision ? getRecipe(lastDecision.recipeId)?.name : null;
  return {
    ...constructionAutomationProtectedStage(entity, `准备 ${target.definition.name}${recipeName ? ` · ${recipeName}` : ""}`),
    progress: 0,
    etaSeconds: plan.steps.reduce((sum, step) => sum + constructionAutomationStepDuration(state, step), 0) / Math.max(1, entity.machineCount),
    recipeName: recipeName ?? undefined,
    recipeFallbackReason: lastDecision?.fallbackReason,
    wipCount: 0,
    wipItems: [],
    destroyedByproductCount,
    destroyedByproductItems,
  };
}

export function getConstructionCenterTraceSample(
  state: GameState,
  entityId: string,
  wallSecond: number,
  workerLatencyMs = 0,
  pendingSimulationSeconds = 0,
): ConstructionCenterTraceSample | null {
  const entity = state.entities.find((candidate) => candidate.id === entityId && candidate.buildingId === "construction_center");
  if (!entity) return null;
  const job = state.constructionAutomation.jobs[entityId];
  const step = job?.steps[job.stepIndex];
  return {
    wallSecond: Math.max(0, wallSecond),
    simulationSecond: Math.max(0, state.elapsedSeconds),
    workerLatencyMs: Math.max(0, workerLatencyMs),
    pendingSimulationSeconds: Math.max(0, pendingSimulationSeconds),
    entityId,
    constructionId: job && !isPortableFleetItem(job.constructionId) ? job.constructionId : null,
    stepIndex: job?.stepIndex ?? -1,
    stepKind: step?.kind ?? null,
    stepItemId: step?.kind === "material" ? step.outputItemId : step?.kind === "fleet" ? step.itemId : null,
    stepElapsedSeconds: Math.max(0, job?.elapsedSeconds ?? 0),
    stepDurationSeconds: step ? constructionAutomationStepDuration(state, step) : 0,
    wipCount: Object.values(job?.inventory ?? {}).reduce((sum, amount) => sum + Math.max(0, Math.floor(amount ?? 0)), 0),
    powerFactor: getEntityPowerFactor(state, entity),
    statusCode: getEntityOperatingStatus(state, entity).code,
    completedBuildings: Math.max(0, Math.floor(state.constructionAutomation.totalCrafted)),
    guardHitCount: 0,
  };
}

function constructionAutomationRequirements(step: ConstructionAutomationStep): Array<{ itemId: ItemId; amount: number }> {
  return step.kind === "building"
    ? getConstructionDefinition(step.constructionId)?.costs ?? []
    : step.kind === "fleet" ? [{ itemId: step.itemId, amount: step.amount }]
      : getRecipe(step.recipeId)?.inputs.map((input) => ({ itemId: input.itemId, amount: input.amount * step.batches })) ?? [];
}

function planConstructionAutomationConsumption(
  inventory: Partial<Record<ItemId, number>>,
  tray: Partial<Record<ItemId, number>>,
  requirements: Array<{ itemId: ItemId; amount: number }>,
): { inventory: Partial<Record<ItemId, number>>; tray: Partial<Record<ItemId, number>> } | null {
  const nextInventory = { ...inventory };
  const nextTray = { ...tray };
  for (const requirement of requirements) {
    let remaining = Math.max(0, Math.floor(requirement.amount));
    const inJob = Math.max(0, Math.floor(nextInventory[requirement.itemId] ?? 0));
    const fromJob = Math.min(remaining, inJob);
    nextInventory[requirement.itemId] = inJob - fromJob;
    remaining -= fromJob;
    const inTray = Math.max(0, Math.floor(nextTray[requirement.itemId] ?? 0));
    if (inTray < remaining) return null;
    nextTray[requirement.itemId] = inTray - remaining;
  }
  return { inventory: nextInventory, tray: nextTray };
}

function constructionAutomationRemainingInventoryNeed(
  job: ConstructionAutomationJob,
  startIndex: number,
): Partial<Record<ItemId, number>> {
  const needed: Partial<Record<ItemId, number>> = {};
  for (let index = job.steps.length - 1; index >= startIndex; index -= 1) {
    const step = job.steps[index];
    for (const requirement of constructionAutomationRequirements(step)) {
      needed[requirement.itemId] = Math.max(0, Math.floor((needed[requirement.itemId] ?? 0) + requirement.amount));
    }
    if (step.kind !== "material") continue;
    for (const output of getRecipe(step.recipeId)?.outputs ?? []) {
      needed[output.itemId] = Math.max(0, Math.floor((needed[output.itemId] ?? 0) - output.amount * step.batches));
    }
  }
  return needed;
}

function settleConstructionAutomationExcess(
  state: GameState,
  planetId: PlanetId,
  job: ConstructionAutomationJob,
  nextStepIndex: number,
): void {
  const tray = trayForPlanet(state, planetId);
  const needed = constructionAutomationRemainingInventoryNeed(job, nextStepIndex);
  const retained: Partial<Record<ItemId, number>> = {};
  for (const [itemId, rawAmount] of Object.entries(job.inventory) as Array<[ItemId, number]>) {
    const amount = Math.max(0, Math.floor(rawAmount ?? 0));
    const keep = Math.min(amount, Math.max(0, Math.floor(needed[itemId] ?? 0)));
    if (keep > 0) retained[itemId] = keep;
    let excess = amount - keep;
    if (excess < 1) continue;
    if (isPortableFleetItem(itemId)) {
      state.portableFleet[itemId] = Math.floor((state.portableFleet[itemId] ?? 0) + excess);
      continue;
    }
    const current = Math.max(0, Math.floor(tray[itemId] ?? 0));
    const free = Math.max(0, getPlanetTrayItemLimit(state, planetId) - current);
    const stored = Math.min(excess, free);
    if (stored > 0) tray[itemId] = current + stored;
    excess -= stored;
    if (excess > 0) {
      state.constructionAutomation.destroyedByproducts[itemId] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(
        (state.constructionAutomation.destroyedByproducts[itemId] ?? 0) + excess,
      ));
    }
  }
  job.inventory = retained;
}

function constructionAutomationInputsAvailable(state: GameState, planetId: PlanetId, job: ConstructionAutomationJob, step: ConstructionAutomationStep): boolean {
  const tray = trayForPlanet(state, planetId);
  return Boolean(planConstructionAutomationConsumption(job.inventory, tray, constructionAutomationRequirements(step)));
}

function finishConstructionAutomationStep(state: GameState, planetId: PlanetId, job: ConstructionAutomationJob, step: ConstructionAutomationStep): boolean {
  const tray = trayForPlanet(state, planetId);
  const consumed = planConstructionAutomationConsumption(job.inventory, tray, constructionAutomationRequirements(step));
  if (!consumed) return false;
  if (step.kind === "building") {
    const definition = getConstructionDefinition(step.constructionId);
    if (!definition) return false;
    Object.assign(tray, consumed.tray);
    job.inventory = consumed.inventory;
    settleConstructionAutomationExcess(state, planetId, job, job.steps.length);
    state.construction[step.constructionId] = Math.floor((state.construction[step.constructionId] ?? 0) + definition.outputAmount);
    state.constructionAutomation.totalCrafted += definition.outputAmount;
    state.constructionAutomation.lastCraftedId = step.constructionId;
    return true;
  }
  if (step.kind === "fleet") {
    Object.assign(tray, consumed.tray);
    job.inventory = consumed.inventory;
    state.portableFleet[step.itemId] = Math.floor((state.portableFleet[step.itemId] ?? 0) + step.amount);
    state.constructionAutomation.totalCrafted += step.amount;
    state.constructionAutomation.lastCraftedId = step.itemId;
    return true;
  }
  const recipe = getRecipe(step.recipeId);
  if (!recipe) return false;
  const producedInventory = { ...consumed.inventory };
  for (const output of recipe.outputs) {
    producedInventory[output.itemId] = Math.floor((producedInventory[output.itemId] ?? 0) + output.amount * step.batches);
  }
  Object.assign(tray, consumed.tray);
  job.inventory = producedInventory;
  settleConstructionAutomationExcess(state, planetId, job, job.stepIndex + 1);
  for (const output of recipe.outputs) {
    state.totalProduced[output.itemId] = Math.floor((state.totalProduced[output.itemId] ?? 0) + output.amount * step.batches);
  }
  return true;
}

interface RepeatableConstructionAutomationBatch {
  workSeconds: number;
  trayCosts: Partial<Record<ItemId, number>>;
  trayReturns: Partial<Record<ItemId, number>>;
  fleetReturns: Partial<Record<ItemId, number>>;
  producedItems: Partial<Record<ItemId, number>>;
  relevantItems: ItemId[];
  touchedTrayItems: ItemId[];
}

function analyzeRepeatableConstructionAutomationPlan(
  state: GameState,
  definition: ConstructionAutomationTargetDefinition,
  plan: ConstructionAutomationPlan,
): RepeatableConstructionAutomationBatch | null {
  if (plan.steps.length === 0) return null;
  const inventory: Partial<Record<ItemId, number>> = {};
  const trayCosts: Partial<Record<ItemId, number>> = {};
  const trayReturns: Partial<Record<ItemId, number>> = {};
  const fleetReturns: Partial<Record<ItemId, number>> = {};
  const producedItems: Partial<Record<ItemId, number>> = {};
  const touchedTrayItems = new Set<ItemId>();
  const job: ConstructionAutomationJob = {
    constructionId: definition.id,
    steps: plan.steps,
    stepIndex: 0,
    elapsedSeconds: 0,
    inventory,
  };
  for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
    const step = plan.steps[stepIndex];
    for (const requirement of constructionAutomationRequirements(step)) {
      touchedTrayItems.add(requirement.itemId);
      let remaining = Math.max(0, Math.floor(requirement.amount));
      const available = Math.max(0, Math.floor(inventory[requirement.itemId] ?? 0));
      const consumed = Math.min(remaining, available);
      inventory[requirement.itemId] = available - consumed;
      remaining -= consumed;
      if (remaining > 0) trayCosts[requirement.itemId] = Math.floor((trayCosts[requirement.itemId] ?? 0) + remaining);
    }
    if (step.kind === "material") {
      const recipe = getRecipe(step.recipeId);
      if (!recipe) return null;
      for (const output of recipe.outputs) {
        const amount = Math.max(0, Math.floor(output.amount * step.batches));
        inventory[output.itemId] = Math.floor((inventory[output.itemId] ?? 0) + amount);
        producedItems[output.itemId] = Math.floor((producedItems[output.itemId] ?? 0) + amount);
      }
    }
    const needed = constructionAutomationRemainingInventoryNeed(job, stepIndex + 1);
    const retained: Partial<Record<ItemId, number>> = {};
    for (const [itemId, rawAmount] of Object.entries(inventory) as Array<[ItemId, number]>) {
      const amount = Math.max(0, Math.floor(rawAmount ?? 0));
      const keep = Math.min(amount, Math.max(0, Math.floor(needed[itemId] ?? 0)));
      if (keep > 0) retained[itemId] = keep;
      const excess = amount - keep;
      if (excess < 1) continue;
      const returns = isPortableFleetItem(itemId) ? fleetReturns : trayReturns;
      returns[itemId] = Math.floor((returns[itemId] ?? 0) + excess);
    }
    for (const itemId of Object.keys(inventory) as ItemId[]) delete inventory[itemId];
    Object.assign(inventory, retained);
  }
  if (Object.values(inventory).some((amount) => Math.max(0, Math.floor(amount ?? 0)) > 0)) return null;
  const relevant = new Set<ItemId>(touchedTrayItems);
  const pending = (plan.recursiveDecisions ?? []).flatMap((decision) => decision.fallbacks.flatMap((fallback) => {
    if (fallback.reason === "technology") return [];
    return getRecipe(fallback.recipeId)?.inputs.map((input) => input.itemId) ?? [];
  }));
  const recipes = recursiveManufacturingRecipes();
  while (pending.length > 0) {
    const itemId = pending.pop()!;
    if (relevant.has(itemId)) continue;
    relevant.add(itemId);
    for (const recipe of recipes) {
      if (getRecipeNetOutput(recipe, itemId) <= 0) continue;
      for (const input of recipe.inputs) pending.push(input.itemId);
    }
  }
  return {
    workSeconds: plan.steps.reduce((sum, step) => sum + constructionAutomationStepDuration(state, step), 0),
    trayCosts,
    trayReturns,
    fleetReturns,
    producedItems,
    relevantItems: [...relevant].sort(),
    touchedTrayItems: [...touchedTrayItems].sort(),
  };
}

function hasSingleConstructionAutomationTarget(state: GameState, targetId: ConstructionAutomationTargetId): boolean {
  const activeTargets = getConstructionAutomationTargets().filter((definition) => {
    if (definition.requiredTechId && !isTechnologyCompleted(state, definition.requiredTechId)) return false;
    const target = state.constructionAutomation.targetStock[definition.id] ?? 0;
    return target > constructionAutomationCurrentStock(state, definition.id) + constructionAutomationPending(state, definition.id);
  });
  return activeTargets.length === 1 && activeTargets[0].id === targetId;
}

interface CachedConstructionAutomationPlan {
  plan: ConstructionAutomationPlan;
  batch: RepeatableConstructionAutomationBatch | null;
  inventorySnapshot: Partial<Record<ItemId, number>>;
  materialInventoryVersion: string;
}

interface ConstructionAutomationComputeBudget {
  remainingIterations: number;
  remainingPlanBuilds: number;
}

function constructionAutomationInventorySnapshot(state: GameState, planetId: PlanetId): Partial<Record<ItemId, number>> {
  return Object.fromEntries((Object.entries(trayForPlanet(state, planetId)) as Array<[ItemId, number]>)
    .map(([itemId, amount]) => [itemId, Math.max(0, Math.floor(amount ?? 0))] as const)
    .filter(([, amount]) => amount > 0)
    .sort(([left], [right]) => left.localeCompare(right))) as Partial<Record<ItemId, number>>;
}

function constructionAutomationInventoryVersion(inventory: Partial<Record<ItemId, number>>): string {
  return (Object.entries(inventory) as Array<[ItemId, number]>)
    .map(([itemId, amount]) => `${itemId}:${amount}`)
    .join("|");
}

function constructionAutomationPlanCacheKey(
  state: GameState,
  definition: ConstructionAutomationTargetDefinition,
  planetId: PlanetId,
): string {
  const technologyVersion = [...state.research.completedTechIds].sort().join(",");
  const contentVersion = state.contentPacks.map((pack) => `${pack.id}@${pack.version}`).sort().join(",");
  return `${planetId}|${definition.id}|${definition.recipeId ?? "building"}|${technologyVersion}|${contentVersion}`;
}

function constructionAutomationPlanInputsAvailable(
  state: GameState,
  planetId: PlanetId,
  plan: ConstructionAutomationPlan,
): boolean {
  let inventory: Partial<Record<ItemId, number>> = {};
  let tray = { ...trayForPlanet(state, planetId) };
  for (const step of plan.steps) {
    const consumed = planConstructionAutomationConsumption(inventory, tray, constructionAutomationRequirements(step));
    if (!consumed) return false;
    inventory = consumed.inventory;
    tray = consumed.tray;
    if (step.kind !== "material") continue;
    const recipe = getRecipe(step.recipeId);
    if (!recipe) return false;
    for (const output of recipe.outputs) {
      inventory[output.itemId] = Math.floor((inventory[output.itemId] ?? 0) + output.amount * step.batches);
    }
  }
  return true;
}

function constructionAutomationBatchInputsAvailable(
  state: GameState,
  planetId: PlanetId,
  batch: RepeatableConstructionAutomationBatch,
  jobs = 1,
): boolean {
  const tray = trayForPlanet(state, planetId);
  return (Object.entries(batch.trayCosts) as Array<[ItemId, number]>).every(([itemId, amount]) =>
    Math.max(0, Math.floor(tray[itemId] ?? 0)) >= Math.max(0, Math.floor(amount)) * jobs);
}

function constructionAutomationCachedPlanValid(
  state: GameState,
  planetId: PlanetId,
  cached: CachedConstructionAutomationPlan,
): boolean {
  const inventorySnapshot = constructionAutomationInventorySnapshot(state, planetId);
  const materialInventoryVersion = constructionAutomationInventoryVersion(inventorySnapshot);
  if (materialInventoryVersion === cached.materialInventoryVersion) return true;
  if (cached.plan.blocker) return false;
  const materialAdded = (Object.entries(inventorySnapshot) as Array<[ItemId, number]>).some(([itemId, amount]) =>
    amount > Math.max(0, Math.floor(cached.inventorySnapshot[itemId] ?? 0)));
  if (materialAdded || !constructionAutomationPlanInputsAvailable(state, planetId, cached.plan)) return false;
  cached.inventorySnapshot = inventorySnapshot;
  cached.materialInventoryVersion = materialInventoryVersion;
  return true;
}

function resolveConstructionAutomationPlan(
  state: GameState,
  definition: ConstructionAutomationTargetDefinition,
  planetId: PlanetId,
  cache: Map<string, CachedConstructionAutomationPlan>,
  budget: ConstructionAutomationComputeBudget,
  profiler?: SimulationProfiler,
): CachedConstructionAutomationPlan | null {
  const cacheKey = constructionAutomationPlanCacheKey(state, definition, planetId);
  const cached = cache.get(cacheKey);
  if (cached && constructionAutomationCachedPlanValid(state, planetId, cached)) {
    if (profiler) profiler.constructionPlanCacheHits += 1;
    return cached;
  }
  if (budget.remainingPlanBuilds < 1) return null;
  budget.remainingPlanBuilds -= 1;
  const plan = buildConstructionAutomationPlan(state, definition, planetId);
  const batch = plan.blocker ? null : analyzeRepeatableConstructionAutomationPlan(state, definition, plan);
  const inventorySnapshot = constructionAutomationInventorySnapshot(state, planetId);
  const resolved = {
    plan,
    batch,
    inventorySnapshot,
    materialInventoryVersion: constructionAutomationInventoryVersion(inventorySnapshot),
  };
  cache.set(cacheKey, resolved);
  if (profiler) profiler.constructionPlanBuilds += 1;
  return resolved;
}

function constructionAutomationBatchCanRepeat(
  state: GameState,
  planetId: PlanetId,
  batch: RepeatableConstructionAutomationBatch,
): boolean {
  const relevant = new Set(batch.relevantItems);
  const tray = trayForPlanet(state, planetId);
  const limit = getPlanetTrayItemLimit(state, planetId);
  return (Object.entries(batch.trayReturns) as Array<[ItemId, number]>).every(([itemId, amount]) => {
    const returned = Math.max(0, Math.floor(amount));
    if (returned < 1) return true;
    const cost = Math.max(0, Math.floor(batch.trayCosts[itemId] ?? 0));
    if (cost > 0 && Math.max(0, Math.floor(tray[itemId] ?? 0)) > limit) return false;
    return !relevant.has(itemId) || returned <= cost;
  }) &&
    Object.values(batch.fleetReturns).every((amount) => Math.max(0, Math.floor(amount ?? 0)) < 1);
}

function applyConstructionAutomationBatch(
  state: GameState,
  entity: FactoryEntity,
  targetIndex: number,
  definition: ConstructionAutomationTargetDefinition,
  batch: RepeatableConstructionAutomationBatch,
  jobs: number,
): number {
  const count = Math.max(1, Math.floor(jobs));
  const tray = trayForPlanet(state, entity.planetId);
  for (const itemId of batch.touchedTrayItems) {
    if (tray[itemId] === undefined) tray[itemId] = 0;
  }
  for (const [itemId, amount] of Object.entries(batch.trayCosts) as Array<[ItemId, number]>) {
    tray[itemId] = Math.max(0, Math.floor((tray[itemId] ?? 0) - amount * count));
  }
  for (const [itemId, amount] of Object.entries(batch.trayReturns) as Array<[ItemId, number]>) {
    const returned = Math.max(0, Math.floor(amount * count));
    if (returned < 1) continue;
    const current = Math.max(0, Math.floor(tray[itemId] ?? 0));
    const stored = Math.min(returned, Math.max(0, getPlanetTrayItemLimit(state, entity.planetId) - current));
    if (stored > 0) tray[itemId] = current + stored;
    const destroyed = returned - stored;
    if (destroyed > 0) {
      state.constructionAutomation.destroyedByproducts[itemId] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(
        (state.constructionAutomation.destroyedByproducts[itemId] ?? 0) + destroyed,
      ));
    }
  }
  for (const [itemId, amount] of Object.entries(batch.fleetReturns) as Array<[ItemId, number]>) {
    const returned = Math.max(0, Math.floor(amount * count));
    if (returned > 0 && isPortableFleetItem(itemId)) {
      state.portableFleet[itemId] = Math.floor((state.portableFleet[itemId] ?? 0) + returned);
    }
  }
  for (const [itemId, amount] of Object.entries(batch.producedItems) as Array<[ItemId, number]>) {
    state.totalProduced[itemId] = Math.floor((state.totalProduced[itemId] ?? 0) + amount * count);
  }
  const completed = definition.outputAmount * count;
  if (definition.kind === "fleet" && isPortableFleetItem(definition.id)) {
    state.portableFleet[definition.id] = Math.floor((state.portableFleet[definition.id] ?? 0) + completed);
  } else if (!isPortableFleetItem(definition.id)) {
    state.construction[definition.id] = Math.floor((state.construction[definition.id] ?? 0) + completed);
  }
  state.constructionAutomation.totalCrafted += completed;
  state.constructionAutomation.lastCraftedId = definition.id;
  state.constructionAutomation.cursor = (targetIndex + 1) % Math.max(1, getConstructionAutomationTargets().length);
  return completed;
}

function tryRunConstructionAutomationBatch(
  state: GameState,
  entity: FactoryEntity,
  targetIndex: number,
  definition: ConstructionAutomationTargetDefinition,
  repeatable: RepeatableConstructionAutomationBatch,
  remainingWork: number,
  activeTargetCount: number,
  highLoadProtection: boolean,
): { usedWork: number; completed: number; jobs: number } | null {
  if (repeatable.workSeconds <= EPSILON || definition.outputAmount < 1) return null;
  const target = Math.max(0, Math.floor(state.constructionAutomation.targetStock[definition.id] ?? 0));
  const current = constructionAutomationCurrentStock(state, definition.id) + constructionAutomationPending(state, definition.id);
  const jobsForTarget = Math.ceil(Math.max(0, target - current) / definition.outputAmount);
  const jobsForWork = Math.floor((Math.max(0, remainingWork) + EPSILON) / repeatable.workSeconds);
  if (jobsForTarget < 1 || jobsForWork < 1 || !constructionAutomationBatchInputsAvailable(state, entity.planetId, repeatable)) return null;
  const tray = trayForPlanet(state, entity.planetId);
  let jobsForStock = Number.MAX_SAFE_INTEGER;
  for (const [itemId, amount] of Object.entries(repeatable.trayCosts) as Array<[ItemId, number]>) {
    if (amount < 1) continue;
    jobsForStock = Math.min(jobsForStock, Math.floor(Math.max(0, tray[itemId] ?? 0) / amount));
  }
  const canRepeat = hasSingleConstructionAutomationTarget(state, definition.id) &&
    Object.keys(state.constructionAutomation.jobs).length === 0 &&
    constructionAutomationBatchCanRepeat(state, entity.planetId, repeatable);
  const canFairBatch = highLoadProtection && constructionAutomationBatchCanRepeat(state, entity.planetId, repeatable);
  const fairShare = Math.max(1, Math.min(
    CONSTRUCTION_AUTOMATION_MAX_FAIR_BATCH_JOBS,
    Math.ceil(jobsForWork / Math.max(1, activeTargetCount)),
  ));
  const jobs = canRepeat
    ? Math.min(jobsForTarget, jobsForWork, jobsForStock)
    : canFairBatch ? Math.min(jobsForTarget, jobsForWork, jobsForStock, fairShare) : 1;
  const completed = applyConstructionAutomationBatch(state, entity, targetIndex, definition, repeatable, jobs);
  return { usedWork: repeatable.workSeconds * jobs, completed, jobs };
}

function runConstructionCenters(
  state: GameState,
  seconds: number,
  power: PowerPlan,
  planetId: PlanetId,
  entities = state.entities,
  batchConstructionAutomation = true,
  profiler?: SimulationProfiler,
  lookup?: SimulationLookupContext,
): void {
  const planCache = lookup?.constructionAutomationPlanCache ?? new Map<string, CachedConstructionAutomationPlan>();
  const budget: ConstructionAutomationComputeBudget = {
    // The unbatched path remains an exact deterministic oracle for tests.
    // Production always uses the guarded batch path.
    remainingIterations: batchConstructionAutomation
      ? Math.max(1, Math.ceil(Math.max(0, seconds) * CONSTRUCTION_AUTOMATION_MAX_ITERATIONS_PER_SIMULATION_SECOND))
      : Number.MAX_SAFE_INTEGER,
    remainingPlanBuilds: batchConstructionAutomation
      ? Math.max(1, Math.ceil(Math.max(0, seconds) * CONSTRUCTION_AUTOMATION_MAX_PLAN_BUILDS_PER_SIMULATION_SECOND))
      : Number.MAX_SAFE_INTEGER,
  };
  for (const entity of entities) {
    if (entity.planetId !== planetId || entity.buildingId !== "construction_center") continue;
    const powerFactor = powerFactorForEntity(power, entity);
    entity.powerFactor = power.factorByEntity.has(entity.id) ? round(powerFactor, 4) : undefined;
    if (!state.constructionAutomation.enabled || powerFactor <= EPSILON) {
      entity.utilization = 0;
      entity.productionRate = 0;
      entity.progress = 0;
      continue;
    }
    let job: ConstructionAutomationJob | undefined = state.constructionAutomation.jobs[entity.id];
    let remainingWork = Math.max(0, seconds) * Math.max(1, entity.machineCount) * powerFactor;
    let completed = 0;
    let worked = false;
    while (remainingWork > EPSILON) {
      if (budget.remainingIterations < 1) {
        if (profiler) profiler.constructionGuardHits += 1;
        break;
      }
      budget.remainingIterations -= 1;
      if (profiler) profiler.constructionIterations += 1;
      const remainingBeforeIteration = remainingWork;
      const jobBeforeIteration = job;
      const stepBeforeIteration = job?.stepIndex;
      if (!job) {
        const target = constructionAutomationTarget(state);
        if (!target) break;
        const resolved = batchConstructionAutomation
          ? resolveConstructionAutomationPlan(state, target.definition, entity.planetId, planCache, budget, profiler)
          : { plan: buildConstructionAutomationPlan(state, target.definition, entity.planetId), batch: null };
        if (!resolved) {
          if (profiler) profiler.constructionGuardHits += 1;
          break;
        }
        const plan = resolved.plan;
        if (plan.blocker) break;
        const activeTargetCount = Math.max(1, getConstructionAutomationTargets().filter((candidate) => {
          if (candidate.requiredTechId && !isTechnologyCompleted(state, candidate.requiredTechId)) return false;
          return (state.constructionAutomation.targetStock[candidate.id] ?? 0) >
            constructionAutomationCurrentStock(state, candidate.id) + constructionAutomationPending(state, candidate.id);
        }).length);
        const highLoadProtection = entity.machineCount >= CONSTRUCTION_AUTOMATION_PROTECTION_STACK_THRESHOLD ||
          remainingWork > CONSTRUCTION_AUTOMATION_MAX_ITERATIONS_PER_SIMULATION_SECOND;
        const batched = batchConstructionAutomation && resolved.batch
          ? tryRunConstructionAutomationBatch(
            state,
            entity,
            target.index,
            target.definition,
            resolved.batch,
            remainingWork,
            activeTargetCount,
            highLoadProtection,
          )
          : null;
        if (batched) {
          remainingWork = Math.max(0, remainingWork - batched.usedWork);
          completed += batched.completed;
          worked = true;
          entity.progress = 0;
          if (profiler) profiler.constructionJobsBatched += batched.jobs;
          continue;
        }
        job = {
          constructionId: target.definition.id,
          steps: plan.steps,
          stepIndex: 0,
          elapsedSeconds: 0,
          inventory: {},
          recipeDecisions: plan.recipeDecisions,
        };
        state.constructionAutomation.jobs[entity.id] = job;
        state.constructionAutomation.cursor = (target.index + 1) % Math.max(1, getConstructionAutomationTargets().length);
      }
      const step = job.steps[job.stepIndex];
      if (!step) {
        delete state.constructionAutomation.jobs[entity.id];
        job = undefined;
        continue;
      }
      const duration = constructionAutomationStepDuration(state, step);
      if (!constructionAutomationInputsAvailable(state, entity.planetId, job, step)) break;
      const needed = Math.max(0, duration - job.elapsedSeconds);
      const used = Math.min(remainingWork, needed);
      job.elapsedSeconds = round(job.elapsedSeconds + used, 6);
      remainingWork -= used;
      worked ||= used > EPSILON;
      entity.progress = round(Math.min(1, job.elapsedSeconds / duration), 6);
      if (job.elapsedSeconds + EPSILON < duration) break;
      if (!finishConstructionAutomationStep(state, entity.planetId, job, step)) break;
      if (step.kind === "building") completed += getConstructionDefinition(step.constructionId)?.outputAmount ?? 0;
      else if (step.kind === "fleet") completed += step.amount;
      job.stepIndex += 1;
      job.elapsedSeconds = 0;
      entity.progress = 0;
      if (job.stepIndex >= job.steps.length) {
        delete state.constructionAutomation.jobs[entity.id];
        job = undefined;
      }
      if (remainingWork + EPSILON >= remainingBeforeIteration && job === jobBeforeIteration && job?.stepIndex === stepBeforeIteration) break;
    }
    entity.utilization = worked || completed > 0 ? powerFactor : 0;
    entity.productionRate = seconds > EPSILON ? round(completed * 60 / seconds, 2) : 0;
  }
}

function sourceProduces(entity: FactoryEntity, itemId: ItemId): boolean {
  if (entity.kind === "vein") return entity.resourceId === itemId;
  if (entity.kind === "station" && entity.buildingId !== "orbital_collector") {
    if (isElevatorStation(entity)) return (entity.elevatorOutputItems ?? []).includes(itemId);
    // A logistics station can expose up to five independent item slots. The
    // legacy storedItemId field mirrors only the first configured slot, so
    // using it here silently invalidates every second/third belt output.
    return getStationSlots(entity).some((slot) => slot.itemId === itemId);
  }
  if (entity.kind === "storage" || entity.kind === "splitter" || entity.kind === "station") return entity.storedItemId === itemId;
  return getRecipe(entity.recipeId)?.outputs.some((output) => output.itemId === itemId) ?? false;
}

function resolveBlackHolePortIndex(
  state: GameState,
  targetId: string,
  requested?: 0 | 1 | 2,
): 0 | 1 | 2 | undefined {
  const occupied = new Set(state.belts.filter((belt) => belt.target === targetId && belt.targetPortIndex !== undefined)
    .map((belt) => belt.targetPortIndex));
  if (requested !== undefined) return occupied.has(requested) ? undefined : requested;
  return ([0, 1, 2] as const).find((index) => !occupied.has(index));
}

export type BeltConnectionCheck =
  | { ok: true; code: "ready"; label: string }
  | { ok: false; code: "missing-belt" | "invalid-count" | "same-node" | "missing-node" | "different-planet" | "invalid-source" | "station-slots-full" | "item-conflict" | "invalid-target" | "target-port-occupied" | "line-limit"; label: string };

export function getBeltConnectionCheck(state: GameState, sourceId: string, targetId: string, itemId: ItemId, tier: BeltTier = 1, targetPortIndex?: 0 | 1 | 2, lanes = 1): BeltConnectionCheck {
  const constructionId = getBeltConstructionId(tier);
  if (!Number.isSafeInteger(lanes) || lanes < 1) return { ok: false, code: "invalid-count", label: "新建传送带并联数量必须是正整数" };
  if (lanes > MAX_BELT_LANES) return { ok: false, code: "line-limit", label: `新建传送带并联数量不能超过 ${MAX_BELT_LANES}` };
  const availableBelts = Math.max(0, Math.floor(state.construction[constructionId] ?? 0));
  if (availableBelts < lanes) {
    const name = getConstructionDefinition(constructionId)?.name ?? "传送带";
    return { ok: false, code: "missing-belt", label: `缺少${name} ×${lanes - availableBelts}（需要 ${lanes}，现有 ${availableBelts}）` };
  }
  if (sourceId === targetId) return { ok: false, code: "same-node", label: "线路不能连接到同一建筑" };
  const source = state.entities.find((entity) => entity.id === sourceId);
  const target = state.entities.find((entity) => entity.id === targetId);
  if (!source || !target) return { ok: false, code: "missing-node", label: "连接端点不存在" };
  if (source.planetId !== target.planetId) return { ok: false, code: "different-planet", label: "传送带不能跨越行星" };
  const requestedPortIndex = target.buildingId === "micro_black_hole_connector"
    ? targetPortIndex
    : target.buildingId === "material_delivery_hub"
      ? resolveMaterialDeliverySlotIndex(target, itemId, targetPortIndex)
      : undefined;
  if (target.buildingId === "material_delivery_hub" && requestedPortIndex === undefined) {
    return { ok: false, code: "invalid-target", label: targetPortIndex === undefined
      ? "物资配送枢纽没有可自动识别的兼容接口"
      : `物资配送接口 ${targetPortIndex + 1} 已停用或指定了其他物资` };
  }
  const existing = state.belts.find((belt) => belt.source === sourceId && belt.target === targetId && belt.itemId === itemId &&
    belt.targetPortIndex === requestedPortIndex);
  if (existing && existing.lanes + lanes > MAX_BELT_LANES) {
    return { ok: false, code: "line-limit", label: `并联线路已达到上限 ${MAX_BELT_LANES}` };
  }
  if (!sourceProduces(source, itemId)) return { ok: false, code: "invalid-source", label: "来源设备不能输出该物品" };
  if (target.buildingId === "micro_black_hole_connector" && resolveBlackHolePortIndex(state, target.id, targetPortIndex) === undefined) {
    return { ok: false, code: "target-port-occupied", label: targetPortIndex === undefined
      ? "微型黑洞的三个输入接口均已占用"
      : `微型黑洞接口 ${targetPortIndex + 1} 已占用` };
  }
  if (target.kind === "station" && target.buildingId !== "orbital_collector" && !isElevatorStation(target)) {
    const slots = getStationSlots(target);
    if (!slots.some((slot) => slot.itemId === itemId) && !slots.some((slot) => !slot.itemId)) {
      return { ok: false, code: "station-slots-full", label: "物流站没有可用空槽" };
    }
  }
  if (!targetCanAcceptBeltItem(state, target, itemId, requestedPortIndex)) {
    if (target.buildingId === "galactic_material_exporter") {
      return { ok: false, code: "invalid-target", label: "超大型物资出口仅接收宇宙矩阵、太阳帆、小型运载火箭和反物质燃料棒" };
    }
    if ((target.kind === "storage" || target.kind === "splitter") && target.storedItemId && target.storedItemId !== itemId) {
      return { ok: false, code: "item-conflict", label: `目标已配置${ITEMS[target.storedItemId].name}` };
    }
    return { ok: false, code: "invalid-target", label: "目标设备没有兼容的输入接口或配方" };
  }
  return { ok: true, code: "ready", label: "可以建立运输线" };
}

export function canConnectBelt(state: GameState, sourceId: string, targetId: string, itemId: ItemId, tier: BeltTier = 1, targetPortIndex?: 0 | 1 | 2, lanes = 1): boolean {
  return getBeltConnectionCheck(state, sourceId, targetId, itemId, tier, targetPortIndex, lanes).ok;
}

export interface ConnectBeltResult {
  state: GameState;
  beltId: string | null;
  created: boolean;
}

export function connectBeltWithResult(state: GameState, sourceId: string, targetId: string, itemId: ItemId, tier: BeltTier = 1, targetPortIndex?: 0 | 1 | 2, lanes = 1): ConnectBeltResult {
  const constructionId = getBeltConstructionId(tier);
  if (!canConnectBelt(state, sourceId, targetId, itemId, tier, targetPortIndex, lanes)) return { state, beltId: null, created: false };
  const source = state.entities.find((entity) => entity.id === sourceId);
  const target = state.entities.find((entity) => entity.id === targetId);
  if (!source || !target) return { state, beltId: null, created: false };
  const next = copyState(state);
  const configuredTarget = next.entities.find((entity) => entity.id === targetId)!;
  const resolvedTargetPortIndex = configuredTarget.buildingId === "micro_black_hole_connector"
    ? resolveBlackHolePortIndex(next, targetId, targetPortIndex)
    : configuredTarget.buildingId === "material_delivery_hub"
      ? resolveMaterialDeliverySlotIndex(configuredTarget, itemId, targetPortIndex)
      : undefined;
  if ((configuredTarget.buildingId === "micro_black_hole_connector" || configuredTarget.buildingId === "material_delivery_hub") && resolvedTargetPortIndex === undefined) return { state, beltId: null, created: false };
  configureAutoTargetRecipe(next, configuredTarget, itemId);
  configureTargetItem(configuredTarget, itemId, resolvedTargetPortIndex);
  const configuredSource = next.entities.find((entity) => entity.id === sourceId)!;
  const resolvedElevatorOutputIndex = isElevatorStation(configuredSource)
    ? configuredSource.elevatorOutputItems?.findIndex((candidate) => candidate === itemId)
    : -1;
  const matchingEndpoint = next.belts.find((belt) => belt.source === sourceId && belt.target === targetId && belt.itemId === itemId &&
    belt.targetPortIndex === resolvedTargetPortIndex);
  if (matchingEndpoint && matchingEndpoint.tier !== tier) return { state, beltId: null, created: false };
  const existing = next.belts.find((belt) => belt.source === sourceId && belt.target === targetId && belt.itemId === itemId &&
    belt.targetPortIndex === resolvedTargetPortIndex && belt.tier === tier);
  let beltId: string;
  let created = false;
  if (existing) {
    if (configuredTarget.buildingId === "micro_black_hole_connector") return { state, beltId: null, created: false };
    existing.lanes += lanes;
    beltId = existing.id;
  } else {
    beltId = `belt_${next.nextId}`;
    next.belts.push({
      id: beltId,
      planetId: source.planetId,
      source: sourceId,
      target: targetId,
      itemId,
      lanes,
      tier,
      sorterTier: Math.min(3, tier) as SorterTier,
      progress: 0,
      priority: target.buildingId === "material_delivery_hub" ? 0 : 1,
      stackSize: canSetBeltStackSize(next, next.settings.defaultBeltStackSize) ? next.settings.defaultBeltStackSize : 1,
      monitorEnabled: false,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
      routeMode: next.settings.defaultBeltRouteMode,
      targetPortIndex: resolvedTargetPortIndex,
      elevatorOutputIndex: resolvedElevatorOutputIndex !== undefined && resolvedElevatorOutputIndex >= 0
        ? resolvedElevatorOutputIndex as 0 | 1 | 2 | 3 | 4
        : undefined,
    });
    next.nextId += 1;
    created = true;
  }
  next.construction[constructionId] = (next.construction[constructionId] ?? 0) - lanes;
  return { state: next, beltId, created };
}

export function connectBelt(state: GameState, sourceId: string, targetId: string, itemId: ItemId, tier: BeltTier = 1, targetPortIndex?: 0 | 1 | 2, lanes = 1): GameState {
  return connectBeltWithResult(state, sourceId, targetId, itemId, tier, targetPortIndex, lanes).state;
}

export function removeBelt(state: GameState, beltId: string): GameState {
  const belt = state.belts.find((item) => item.id === beltId);
  if (!belt) return state;
  const constructionId = getBeltConstructionId(belt.tier);
  const returned = safeInventoryAdd(state.construction[constructionId], belt.lanes);
  if (returned === null) return state;
  const next = copyState(state);
  next.belts = next.belts.filter((item) => item.id !== beltId);
  next.construction[constructionId] = returned;
  return next;
}

export type BeltLaneAdjustmentCheck =
  | { ok: true; code: "ready" | "unchanged"; label: string; targetLanes: number; delta: number; constructionId: ConstructionId; available: number }
  | { ok: false; code: "missing-line" | "invalid-count" | "minimum" | "maximum" | "missing-construction"; label: string };

export function getBeltLaneAdjustmentCheck(state: GameState, beltId: string, targetLanes: number): BeltLaneAdjustmentCheck {
  const belt = state.belts.find((candidate) => candidate.id === beltId);
  if (!belt) return { ok: false, code: "missing-line", label: "运输线不存在" };
  if (!Number.isSafeInteger(targetLanes)) return { ok: false, code: "invalid-count", label: "并联数量必须为整数" };
  if (targetLanes < 1) return { ok: false, code: "minimum", label: "至少保留 1 条并联线路；如需拆除请使用回收" };
  // Grandfathered saves may contain more than the current limit. They can be
  // reduced without losing cargo, but cannot add lanes above their current count.
  if (targetLanes > MAX_BELT_LANES && targetLanes >= belt.lanes) {
    return { ok: false, code: "maximum", label: `并联数量不能超过 ${MAX_BELT_LANES}` };
  }
  const constructionId = getBeltConstructionId(belt.tier);
  const available = Math.max(0, Math.floor(state.construction[constructionId] ?? 0));
  const delta = targetLanes - belt.lanes;
  if (delta > available) {
    const name = getConstructionDefinition(constructionId)?.name ?? "同级传送带";
    return { ok: false, code: "missing-construction", label: `缺少${name} ×${delta - available}（需要 ${delta}，现有 ${available}）` };
  }
  return {
    ok: true,
    code: delta === 0 ? "unchanged" : "ready",
    label: delta === 0 ? "并联数量未变化" : delta > 0 ? `将消耗同级传送带 ×${delta}` : `将返还同级传送带 ×${Math.abs(delta)}`,
    targetLanes,
    delta,
    constructionId,
    available,
  };
}

export function setBeltLaneCount(state: GameState, beltId: string, targetLanes: number): GameState {
  const check = getBeltLaneAdjustmentCheck(state, beltId, targetLanes);
  if (!check.ok || check.delta === 0) return state;
  const next = copyState(state);
  const belt = next.belts.find((candidate) => candidate.id === beltId);
  if (!belt) return state;
  belt.lanes = check.targetLanes;
  next.construction[check.constructionId] = check.available - check.delta;
  return next;
}

export interface BatchSelectionIncreaseResult {
  state: GameState;
  ok: boolean;
  changedBuildingCount: number;
  changedBeltCount: number;
  buildingAtLimitCount: number;
  beltAtLimitCount: number;
  uniqueBuildingSkippedCount: number;
  skippedLockedCount: number;
  requiredConstruction: Partial<Record<ConstructionId, number>>;
  missingConstruction: Partial<Record<ConstructionId, number>>;
  error?: "invalid-count" | "empty-selection" | "missing-construction";
  label?: string;
}

/**
 * Atomically add the same number of units/lanes to a mixed selection. The
 * preview data is returned even on failure so the UI can explain shortages
 * and limit hits without mutating the authoritative state.
 */
export function batchIncreaseSelection(
  state: GameState,
  entityIds: readonly string[],
  beltIds: readonly string[],
  amount: number,
): BatchSelectionIncreaseResult {
  const emptyResult = (error?: BatchSelectionIncreaseResult["error"], label?: string): BatchSelectionIncreaseResult => ({
    state,
    ok: false,
    changedBuildingCount: 0,
    changedBeltCount: 0,
    buildingAtLimitCount: 0,
    beltAtLimitCount: 0,
    uniqueBuildingSkippedCount: 0,
    skippedLockedCount: 0,
    requiredConstruction: {},
    missingConstruction: {},
    error,
    label,
  });
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000) {
    return emptyResult("invalid-count", "本次增加量必须是 1～1,000,000 的正整数");
  }
  const selectedEntityIdSet = new Set(entityIds);
  const selectedBeltIdSet = new Set(beltIds);
  if (selectedEntityIdSet.size === 0 && selectedBeltIdSet.size === 0) return emptyResult("empty-selection", "请先选择建筑或传送带");

  const requiredConstruction: Partial<Record<ConstructionId, number>> = {};
  const entityUpdates: Array<{ id: string; count: number; constructionId: ConstructionId }> = [];
  let buildingAtLimitCount = 0;
  let uniqueBuildingSkippedCount = 0;
  let skippedLockedCount = 0;
  for (const entity of state.entities) {
    if (!selectedEntityIdSet.has(entity.id)) continue;
    if (entity.interactionLocked) { skippedLockedCount += 1; continue; }
    const buildingId = entity.kind === "vein"
      ? entity.resourceId ? getExtractorBuildingId(entity.resourceId) : undefined
      : entity.buildingId;
    if (!buildingId) { skippedLockedCount += 1; continue; }
    const definition = getBuilding(buildingId);
    if (definition.kind === "miner" && entity.kind !== "vein") { skippedLockedCount += 1; continue; }
    if (buildingId === "micro_black_hole_connector" || buildingId === "time_warp_device") {
      uniqueBuildingSkippedCount += 1;
      continue;
    }
    const current = entity.kind === "vein" ? entity.minerCount : entity.machineCount;
    const check = getBuildingStackAdditionCheck(current, amount, definition.name);
    if (!check.ok || (definition.stackLimit !== undefined && check.total > definition.stackLimit)) {
      buildingAtLimitCount += 1;
      continue;
    }
    entityUpdates.push({ id: entity.id, count: check.total, constructionId: buildingId });
    requiredConstruction[buildingId] = Math.floor((requiredConstruction[buildingId] ?? 0) + amount);
  }

  const beltUpdates: Array<{ id: string; lanes: number; constructionId: ConstructionId }> = [];
  let beltAtLimitCount = 0;
  for (const belt of state.belts) {
    if (!selectedBeltIdSet.has(belt.id)) continue;
    const targetLanes = belt.lanes + amount;
    if (!Number.isSafeInteger(targetLanes) || targetLanes > MAX_BELT_LANES) {
      beltAtLimitCount += 1;
      continue;
    }
    const constructionId = getBeltConstructionId(belt.tier);
    beltUpdates.push({ id: belt.id, lanes: targetLanes, constructionId });
    requiredConstruction[constructionId] = Math.floor((requiredConstruction[constructionId] ?? 0) + amount);
  }

  const missingConstruction: Partial<Record<ConstructionId, number>> = {};
  for (const [constructionId, required] of Object.entries(requiredConstruction) as Array<[ConstructionId, number]>) {
    const available = Math.max(0, Math.floor(state.construction[constructionId] ?? 0));
    const missing = Math.max(0, required - available);
    if (missing > 0) missingConstruction[constructionId] = missing;
  }
  const hasChanges = entityUpdates.length > 0 || beltUpdates.length > 0;
  if (Object.keys(missingConstruction).length > 0) {
    return {
      state,
      ok: false,
      changedBuildingCount: 0,
      changedBeltCount: 0,
      buildingAtLimitCount,
      beltAtLimitCount,
      uniqueBuildingSkippedCount,
      skippedLockedCount,
      requiredConstruction,
      missingConstruction,
      error: "missing-construction",
      label: "施工托盘不足，批量增加未执行任何项目",
    };
  }
  if (!hasChanges) {
    return {
      state,
      ok: true,
      changedBuildingCount: 0,
      changedBeltCount: 0,
      buildingAtLimitCount,
      beltAtLimitCount,
      uniqueBuildingSkippedCount,
      skippedLockedCount,
      requiredConstruction,
      missingConstruction,
      label: uniqueBuildingSkippedCount > 0
        ? `所选项目均已达到上限或不可堆叠；${uniqueBuildingSkippedCount} 座唯一巨构已跳过`
        : "所选项目均已达到上限或不可堆叠",
    };
  }
  const next = copyState(state);
  for (const update of entityUpdates) {
    const entity = next.entities.find((candidate) => candidate.id === update.id);
    if (!entity) continue;
    if (entity.kind === "vein") entity.minerCount = update.count;
    else entity.machineCount = update.count;
  }
  for (const update of beltUpdates) {
    const belt = next.belts.find((candidate) => candidate.id === update.id);
    if (belt) belt.lanes = update.lanes;
  }
  for (const [constructionId, required] of Object.entries(requiredConstruction) as Array<[ConstructionId, number]>) {
    next.construction[constructionId] = Math.max(0, Math.floor((next.construction[constructionId] ?? 0) - required));
  }
  return {
    state: next,
    ok: true,
    changedBuildingCount: entityUpdates.length,
    changedBeltCount: beltUpdates.length,
    buildingAtLimitCount,
    beltAtLimitCount,
    uniqueBuildingSkippedCount,
    skippedLockedCount,
    requiredConstruction,
    missingConstruction,
  };
}

export function setBeltPriority(state: GameState, beltId: string, priority: 0 | 1 | 2): GameState {
  if (!state.belts.some((belt) => belt.id === beltId)) return state;
  return {
    ...state,
    belts: state.belts.map((belt) => belt.id === beltId ? { ...belt, priority } : belt),
  };
}

export function setLogisticsItem(state: GameState, entityId: string, itemId: ItemId): GameState {
  const current = state.entities.find((entity) => entity.id === entityId);
  if (!current || current.interactionLocked) return state;
  if (current.buildingId === "material_delivery_hub") {
    return setMaterialDeliverySlot(state, entityId, 0, "manual", itemId, true);
  }
  if (current.kind === "station" && current.buildingId !== "orbital_collector") {
    return setStationSlotItem(state, entityId, 0, itemId);
  }
  if (!logisticsAccepts(state, { ...current, storedItemId: undefined }, itemId)) return state;
  if (current.storedItemId === itemId) return state;
  const next = copyState(state);
  const entity = next.entities.find((candidate) => candidate.id === entityId)!;
  for (const [bufferedItemId, amount] of Object.entries(entity.inputs)) addToPlanetTray(next, entity.planetId, bufferedItemId as ItemId, amount ?? 0);
  for (const [bufferedItemId, amount] of Object.entries(entity.outputs)) addToPlanetTray(next, entity.planetId, bufferedItemId as ItemId, amount ?? 0);
  entity.inputs = {};
  entity.outputs = {};
  entity.storedItemId = itemId;
  entity.routingCursor = 0;
  entity.stationProgress = 0;
  entity.stationPeerId = undefined;
  const removedBelts = next.belts.filter((belt) => belt.source === entityId || belt.target === entityId);
  refundBelts(next, removedBelts);
  next.belts = next.belts.filter((belt) => belt.source !== entityId && belt.target !== entityId);
  return next;
}

export function setStationSlotItem(
  state: GameState,
  entityId: string,
  slotIndex: number,
  itemId: ItemId | null,
): GameState {
  const current = state.entities.find((entity) => entity.id === entityId);
  if (!current || current.planetId !== state.activePlanetId) return state;
  return setRemoteStationSlotItem(state, entityId, slotIndex, itemId);
}

/** Edit a station on its own planet without changing activePlanetId. */
export function setRemoteStationSlotItem(
  state: GameState,
  entityId: string,
  slotIndex: number,
  itemId: ItemId | null,
): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.kind === "station" &&
    entity.buildingId !== "orbital_collector");
  if (!current || current.interactionLocked || slotIndex < 0 || slotIndex >= STATION_SLOT_COUNT ||
    (itemId && !ITEMS[itemId])) return state;
  const currentSlots = getStationSlots(current);
  const previousItemId = currentSlots[slotIndex]?.itemId;
  if (previousItemId === itemId || (itemId && currentSlots.some((slot, index) => index !== slotIndex && slot.itemId === itemId))) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  const slots = ensureStationSlots(station);
  if (previousItemId) {
    addToPlanetTray(next, station.planetId, previousItemId, station.inputs[previousItemId] ?? 0);
    addToPlanetTray(next, station.planetId, previousItemId, station.outputs[previousItemId] ?? 0);
    station.inputs[previousItemId] = 0;
    station.outputs[previousItemId] = 0;
    const removedBelts = next.belts.filter((belt) =>
      belt.itemId === previousItemId && (belt.source === entityId || belt.target === entityId));
    refundBelts(next, removedBelts);
    next.belts = next.belts.filter((belt) => !removedBelts.includes(belt));
  }
  cancelStationRoutes(next, (demand, route) =>
    (demand.id === entityId && route.slotIndex === slotIndex) ||
    (route.peerId === entityId && route.itemId === previousItemId));
  slots[slotIndex] = {
    ...slots[slotIndex],
    itemId: itemId ?? undefined,
    localMode: itemId ? (station.buildingId === "planetary_logistics_station" ? "supply" : slots[slotIndex].localMode) : "storage",
    remoteMode: itemId ? (station.buildingId === "interstellar_logistics_station" ? "supply" : slots[slotIndex].remoteMode) : "storage",
  };
  station.stationProgress = 0;
  station.stationPeerId = undefined;
  ensureStationSlots(station);
  return next;
}

export function setStationSlotMode(
  state: GameState,
  entityId: string,
  slotIndex: number,
  scope: StationLogisticsScope,
  mode: StationLogisticsMode,
): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.kind === "station" &&
    entity.buildingId !== "orbital_collector");
  if (!current || current.interactionLocked || !getStationSlots(current)[slotIndex]?.itemId ||
    (scope === "remote" && current.buildingId !== "interstellar_logistics_station")) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  const slot = ensureStationSlots(station)[slotIndex];
  const itemId = slot.itemId;
  cancelStationRoutes(next, (demand, route) => route.scope === scope && (
    (demand.id === entityId && route.slotIndex === slotIndex) ||
    (route.peerId === entityId && route.itemId === itemId)));
  if (scope === "local") slot.localMode = mode;
  else slot.remoteMode = mode;
  station.stationProgress = 0;
  station.stationPeerId = undefined;
  ensureStationSlots(station);
  return next;
}

export function setStationSlotMinimumLoad(
  state: GameState,
  entityId: string,
  slotIndex: number,
  minimumLoad: StationMinimumLoad,
): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.kind === "station");
  if (!current || current.interactionLocked || !STATION_MINIMUM_LOAD_OPTIONS.includes(minimumLoad) || !getStationSlots(current)[slotIndex]?.itemId) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  ensureStationSlots(station)[slotIndex].minimumLoad = minimumLoad;
  ensureStationSlots(station);
  return next;
}

export function setStationSlotLimits(
  state: GameState,
  entityId: string,
  slotIndex: number,
  minStock: number,
  maxStock: number,
): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.kind === "station");
  if (!current || current.interactionLocked || !getStationSlots(current)[slotIndex]?.itemId) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  const slot = ensureStationSlots(station)[slotIndex];
  slot.minStock = Math.max(0, Math.min(MAX_BUILDING_BUFFER_LIMIT, Math.floor(Number.isFinite(minStock) ? minStock : 0)));
  slot.maxStock = Math.max(0, Math.min(MAX_BUILDING_BUFFER_LIMIT, Math.floor(Number.isFinite(maxStock) ? maxStock : 0)));
  if (slot.maxStock > 0 && slot.minStock > slot.maxStock) slot.minStock = slot.maxStock;
  ensureStationSlots(station);
  return next;
}

export function setStationSlotPriority(
  state: GameState,
  entityId: string,
  slotIndex: number,
  priority: 0 | 1 | 2,
): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.kind === "station");
  if (!current || current.interactionLocked || !getStationSlots(current)[slotIndex]?.itemId) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  ensureStationSlots(station)[slotIndex].priority = priority;
  ensureStationSlots(station);
  return next;
}

export function setStationSlotRoutePolicy(
  state: GameState,
  entityId: string,
  slotIndex: number,
  routePolicy: InterstellarRoutePolicy,
): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station");
  if (!current || current.interactionLocked || !getStationSlots(current)[slotIndex]?.itemId ||
    (routePolicy !== "direct" && routePolicy !== "relay-preferred" && routePolicy !== "relay-required")) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  ensureStationSlots(station)[slotIndex].routePolicy = routePolicy;
  return next;
}

export function setStationSlotWarperBudget(
  state: GameState,
  entityId: string,
  slotIndex: number,
  warperBudget: number,
): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station");
  const budget = Math.max(1, Math.min(4, Math.floor(warperBudget)));
  if (!current || current.interactionLocked || !getStationSlots(current)[slotIndex]?.itemId || !Number.isFinite(warperBudget)) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  ensureStationSlots(station)[slotIndex].warperBudget = budget;
  return next;
}

export function setStationHubConfiguration(
  state: GameState,
  entityId: string,
  enabled: boolean,
  priority: LogisticsPriority = 1,
): GameState {
  if (!state.entities.some((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station" && !entity.interactionLocked)) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId
      ? { ...entity, stationHubEnabled: enabled, stationHubPriority: priority === 0 || priority === 2 ? priority : 1 }
      : entity),
  };
}

export function getStationTemplateCompatibleEntityIds(
  state: GameState,
  entityIds: string[],
  slotIndex: number,
  template: StationSlotTemplate,
): string[] {
  if (slotIndex < 0 || slotIndex >= STATION_SLOT_COUNT || !ITEMS[template.itemId]) return [];
  const requested = new Set(entityIds);
  return state.entities
    .filter((entity) => {
      if (!requested.has(entity.id) || entity.interactionLocked || entity.kind !== "station" || entity.buildingId === "orbital_collector") return false;
      return !getStationSlots(entity).some((slot, index) => index !== slotIndex && slot.itemId === template.itemId);
    })
    .map((entity) => entity.id);
}

export function applyStationSlotTemplateToEntities(
  state: GameState,
  entityIds: string[],
  slotIndex: number,
  template: StationSlotTemplate,
): GameState {
  const compatibleIds = getStationTemplateCompatibleEntityIds(state, entityIds, slotIndex, template);
  return applyAcrossEntityPlanets(state, compatibleIds, (current, planetEntityIds) =>
    planetEntityIds.reduce((next, entityId) => {
      const station = next.entities.find((entity) => entity.id === entityId);
      if (!station) return next;
      let configured = setStationSlotItem(next, entityId, slotIndex, template.itemId);
      configured = setStationSlotMode(configured, entityId, slotIndex, "local", template.localMode);
      if (station.buildingId === "interstellar_logistics_station") {
        configured = setStationSlotMode(configured, entityId, slotIndex, "remote", template.remoteMode);
      }
      configured = setStationSlotMinimumLoad(configured, entityId, slotIndex, template.minimumLoad);
      configured = setStationSlotLimits(configured, entityId, slotIndex, template.minStock, template.maxStock);
      configured = setStationSlotPriority(configured, entityId, slotIndex, template.priority);
      if (station.buildingId === "interstellar_logistics_station" && template.routePolicy) {
        configured = setStationSlotRoutePolicy(configured, entityId, slotIndex, template.routePolicy);
      }
      if (station.buildingId === "interstellar_logistics_station" && template.warperBudget) {
        configured = setStationSlotWarperBudget(configured, entityId, slotIndex, template.warperBudget);
      }
      return configured;
    }, current));
}

export function setStationMode(state: GameState, entityId: string, mode: "supply" | "demand"): GameState {
  const station = state.entities.find((entity) => entity.id === entityId && entity.kind === "station" &&
    entity.buildingId !== "orbital_collector");
  if (!station || station.interactionLocked) return state;
  const scope: StationLogisticsScope = station.buildingId === "planetary_logistics_station" ? "local" : "remote";
  return setStationSlotMode(state, entityId, 0, scope, mode);
}

export type QuantumAttachmentBlocker = "missing-station" | "technology" | "not-upgraded" | "already-quantum" | "already-legacy" | "transition-active" | "locked";

export interface QuantumAttachmentStatus {
  stationId: string;
  mode: "legacy" | "transitioning" | "quantum";
  blocker: QuantumAttachmentBlocker | null;
  bridgeCount: number;
  bridgeCargo: string;
}

export function getQuantumAttachmentStatus(state: GameState, entityId: string): QuantumAttachmentStatus | null {
  const entity = state.entities.find((candidate) => candidate.id === entityId && candidate.buildingId === "interstellar_logistics_station");
  if (!entity) return null;
  const mode = entity.quantumMode ?? "legacy";
  const bridgeCargo = (entity.quantumTransition?.bridges ?? []).reduce((sum, bridge) => sum + BigInt(normalizeQuantumInteger(bridge.remainingCargo)), 0n).toString();
  return {
    stationId: entityId,
    mode,
    blocker: mode === "quantum" ? "already-quantum" : entity.quantumTransition ? "transition-active" : !isTechnologyCompleted(state, "quantum_logistics_network") ? "technology" : (entity.stationTier ?? 1) < 2 ? "not-upgraded" : null,
    bridgeCount: entity.quantumTransition?.bridges.length ?? 0,
    bridgeCargo,
  };
}

/** Begin the independent second action after a station reaches Mk.II. */
export function attachInterstellarStationToQuantumNetwork(state: GameState, entityId: string): GameState {
  if (!isTechnologyCompleted(state, "quantum_logistics_network")) return state;
  const result = beginQuantumAttachment(state, entityId);
  return result.changed ? result.state : state;
}

export function getOrbitalCollectorQuantumStatus(state: GameState, entityId: string): QuantumAttachmentStatus | null {
  const entity = state.entities.find((candidate) => candidate.id === entityId && candidate.buildingId === "orbital_collector");
  if (!entity) return null;
  const mode = entity.quantumMode ?? "legacy";
  const bridgeCargo = (entity.quantumTransition?.bridges ?? []).reduce((sum, bridge) =>
    sum + BigInt(normalizeQuantumInteger(bridge.remainingCargo)), 0n).toString();
  return {
    stationId: entityId,
    mode,
    blocker: entity.interactionLocked
      ? "locked"
      : entity.quantumTransition
        ? "transition-active"
        : !isTechnologyCompleted(state, "quantum_logistics_network")
          ? "technology"
          : mode === "quantum" ? "already-quantum" : null,
    bridgeCount: entity.quantumTransition?.bridges.length ?? 0,
    bridgeCargo,
  };
}

export function setOrbitalCollectorQuantumMode(state: GameState, entityId: string, enabled: boolean): GameState {
  const collector = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "orbital_collector");
  if (!collector || collector.interactionLocked || enabled && !isTechnologyCompleted(state, "quantum_logistics_network")) return state;
  const result = beginOrbitalCollectorQuantumModeChange(state, entityId, enabled ? "quantum" : "legacy");
  return result.changed ? result.state : state;
}

export function setAllOrbitalCollectorsQuantumMode(
  state: GameState,
  enabled: boolean,
  systemId?: StarSystemId,
): QuantumAttachmentBatchResult {
  const candidates = state.entities
    .filter((entity) => entity.buildingId === "orbital_collector")
    .filter((entity) => systemId == null || getPlanet(entity.planetId).systemId === systemId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const eligibleIds: string[] = [];
  const skipped: QuantumAttachmentBatchSkip[] = [];
  for (const candidate of candidates) {
    const mode = candidate.quantumMode ?? "legacy";
    const blocker: QuantumAttachmentBlocker | null = candidate.interactionLocked
      ? "locked"
      : candidate.quantumTransition
        ? "transition-active"
        : enabled && !isTechnologyCompleted(state, "quantum_logistics_network")
          ? "technology"
          : enabled && mode === "quantum"
            ? "already-quantum"
            : !enabled && mode !== "quantum" ? "already-legacy" : null;
    if (blocker) {
      skipped.push({
        entityId: candidate.id,
        blocker,
        reason: blocker === "technology" ? "需要先研究“量子物流网络”"
          : blocker === "transition-active" ? "传统航线尾货仍在交接"
            : blocker === "locked" ? "轨道采集器已锁定"
              : blocker === "already-quantum" ? "已经接入量子采集网络" : "已经使用传统物流",
      });
      continue;
    }
    eligibleIds.push(candidate.id);
  }
  const batch = beginOrbitalCollectorQuantumModeChanges(state, eligibleIds, enabled ? "quantum" : "legacy");
  return { state: batch.state, startedIds: batch.startedIds, skipped };
}

export function setQuantumLogisticsItemCapacity(state: GameState, itemId: ItemId, value: unknown): GameState {
  if (!(itemId in ITEMS)) return state;
  const quantumLogisticsNetwork = setQuantumNetworkItemCapacity(state.quantumLogisticsNetwork, itemId, value);
  return quantumLogisticsNetwork === state.quantumLogisticsNetwork ? state : { ...state, quantumLogisticsNetwork };
}

export interface QuantumAttachmentBatchSkip {
  entityId: string;
  reason: string;
  blocker: QuantumAttachmentBlocker;
}

export interface QuantumAttachmentBatchResult {
  state: GameState;
  startedIds: string[];
  skipped: QuantumAttachmentBatchSkip[];
}

/**
 * Start the same safe handoff as the single-station action for every eligible
 * interstellar station.  This only writes transition metadata; traditional
 * routes and their cargo are settled by the existing five-second boundary.
 */
export function attachAllInterstellarStationsToQuantumNetwork(
  state: GameState,
  systemId?: StarSystemId,
): QuantumAttachmentBatchResult {
  const candidates = state.entities
    .filter((entity) => entity.buildingId === "interstellar_logistics_station")
    .filter((entity) => systemId == null || getPlanet(entity.planetId).systemId === systemId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const startedIds: string[] = [];
  const skipped: QuantumAttachmentBatchSkip[] = [];
  const eligibleIds: string[] = [];
  const technologyReady = isTechnologyCompleted(state, "quantum_logistics_network");
  for (const candidate of candidates) {
    if (!technologyReady) {
      skipped.push({ entityId: candidate.id, blocker: "technology", reason: "需要先研究“量子物流网络”" });
      continue;
    }
    const mode = candidate.quantumMode ?? "legacy";
    const blocker: QuantumAttachmentBlocker | null = mode === "quantum"
      ? "already-quantum"
      : candidate.quantumTransition
        ? "transition-active"
        : (candidate.stationTier ?? 1) < 2
          ? "not-upgraded"
          : null;
    if (blocker) {
      const reason = blocker === "already-quantum"
        ? "该物流站已经接入量子网络"
        : blocker === "transition-active"
          ? "传统航线尾货仍在等待交接"
          : blocker === "not-upgraded"
            ? "请先将星际物流站升级到 Mk.II"
            : "需要先研究“量子物流网络”";
      skipped.push({ entityId: candidate.id, blocker, reason });
      continue;
    }
    eligibleIds.push(candidate.id);
  }
  const batch = beginQuantumAttachments(state, eligibleIds);
  startedIds.push(...batch.startedIds);
  for (const entry of batch.entries) {
    if (entry.changed) continue;
    skipped.push({ entityId: entry.stationId, blocker: entry.reason ?? "transition-active", reason: "状态已变化，未重复提交接入" });
  }
  return { state: batch.state, startedIds, skipped };
}

export function cancelQuantumStationAttachment(state: GameState, entityId: string): GameState {
  const station = state.entities.find((entity) => entity.id === entityId && entity.quantumTransition);
  if (!station) return state;
  const transition = station.quantumTransition!;
  const next = {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, quantumMode: "legacy" as const, quantumTransition: null } : entity),
  };
  // Cancellation is deliberately a metadata-only operation: the legacy
  // StationRoute list remains untouched and all tail cargo keeps its owner.
  void transition;
  return next;
}

export type StationFleetKind = "drone" | "vessel";

export interface StationFleetTargetResult {
  state: GameState;
  kind: StationFleetKind;
  current: number;
  requested: number;
  final: number;
  capacity: number;
  busy: number;
  available: number;
  loaded: number;
  unloaded: number;
  shortfall: number;
  reason?: "invalid-station" | "invalid-target" | "busy-vehicles" | "portable-stock";
}

export function setStationFleetTarget(
  state: GameState,
  entityId: string,
  kind: StationFleetKind,
  targetCount: number,
): StationFleetTargetResult {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  if (!entity || entity.planetId !== state.activePlanetId) {
    return { state, kind, current: 0, requested: 0, final: 0, capacity: 0, busy: 0, available: 0, loaded: 0, unloaded: 0, shortfall: 0, reason: "invalid-station" };
  }
  return setRemoteStationFleetTarget(state, entityId, kind, targetCount);
}

/** Adjust a remote station fleet from the global portable fleet pool. */
export function setRemoteStationFleetTarget(
  state: GameState,
  entityId: string,
  kind: StationFleetKind,
  targetCount: number,
): StationFleetTargetResult {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  const compatible = kind === "drone"
    ? entity?.buildingId === "planetary_logistics_station" || entity?.buildingId === "interstellar_logistics_station"
    : entity?.buildingId === "interstellar_logistics_station";
  const current = Math.max(0, Math.floor(kind === "drone" ? entity?.stationDrones ?? 0 : entity?.stationVessels ?? 0));
  if (!entity || entity.interactionLocked || !compatible) {
    return { state, kind, current, requested: current, final: current, capacity: 0, busy: 0, available: 0, loaded: 0, unloaded: 0, shortfall: 0, reason: "invalid-station" };
  }
  const capacity = kind === "drone" ? getStationDroneCapacity(entity) : getStationVesselCapacity(entity);
  const busy = stationBusyVehicles(state, entity, kind === "drone" ? "local" : "remote");
  const portableItemId: PortableFleetItemId = kind === "drone" ? "logistics_drone" : "logistics_vessel";
  const available = Math.max(0, Math.floor(state.portableFleet?.[portableItemId] ?? 0));
  if (!Number.isSafeInteger(targetCount) || targetCount < 0) {
    return { state, kind, current, requested: current, final: current, capacity, busy, available, loaded: 0, unloaded: 0, shortfall: 0, reason: "invalid-target" };
  }
  const requested = Math.min(capacity, targetCount);
  const desired = Math.max(busy, requested);
  const loaded = desired > current ? Math.min(desired - current, available) : 0;
  const unloaded = desired < current ? current - desired : 0;
  const final = current + loaded - unloaded;
  const shortfall = Math.max(0, requested - final);
  const reason = requested < busy ? "busy-vehicles" : shortfall > 0 ? "portable-stock" : undefined;
  if (final === current) {
    return { state, kind, current, requested, final, capacity, busy, available, loaded, unloaded, shortfall, reason };
  }
  const next = copyState(state);
  const station = next.entities.find((candidate) => candidate.id === entityId)!;
  if (kind === "drone") station.stationDrones = final;
  else station.stationVessels = final;
  station.stationProgress = 0;
  if (loaded > 0) next.portableFleet[portableItemId] = available - loaded;
  if (unloaded > 0) addToTray(next, portableItemId, unloaded);
  if (station.stationPeerId) {
    const peer = next.entities.find((candidate) => candidate.id === station.stationPeerId);
    if (peer) peer.stationProgress = 0;
  }
  return { state: next, kind, current, requested, final, capacity, busy, available, loaded, unloaded, shortfall, reason };
}

export function adjustStationVessels(state: GameState, entityId: string, delta: number): GameState {
  const current = state.entities.find((entity) => entity.id === entityId);
  const loaded = Math.max(0, Math.floor(current?.stationVessels ?? 0));
  return setStationFleetTarget(state, entityId, "vessel", Math.max(0, loaded + Math.trunc(delta))).state;
}

export function adjustStationDrones(state: GameState, entityId: string, delta: number): GameState {
  const current = state.entities.find((entity) => entity.id === entityId);
  const loaded = Math.max(0, Math.floor(current?.stationDrones ?? 0));
  return setStationFleetTarget(state, entityId, "drone", Math.max(0, loaded + Math.trunc(delta))).state;
}

export interface StationFleetFillResult {
  state: GameState;
  loaded: number;
  shortfall: number;
  capacity: number;
}

export function fillStationFleet(state: GameState, entityId: string, kind: StationFleetKind): StationFleetFillResult {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  const compatible = kind === "drone"
    ? entity?.buildingId === "planetary_logistics_station" || entity?.buildingId === "interstellar_logistics_station"
    : entity?.buildingId === "interstellar_logistics_station";
  if (!entity || entity.interactionLocked || !compatible || entity.planetId !== state.activePlanetId) {
    return { state, loaded: 0, shortfall: 0, capacity: 0 };
  }
  const capacity = kind === "drone" ? getStationDroneCapacity(entity) : getStationVesselCapacity(entity);
  const current = Math.max(0, Math.floor(kind === "drone" ? entity.stationDrones ?? 0 : entity.stationVessels ?? 0));
  const portableItemId: PortableFleetItemId = kind === "drone" ? "logistics_drone" : "logistics_vessel";
  const available = Math.max(0, Math.floor(state.portableFleet?.[portableItemId] ?? 0));
  const empty = Math.max(0, capacity - current);
  const loaded = Math.min(empty, available);
  const result = setStationFleetTarget(state, entityId, kind, capacity);
  return { state: result.state, loaded: result.loaded, shortfall: result.shortfall, capacity };
}

export function adjustStationWarpers(state: GameState, entityId: string, delta: number): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station");
  if (!current || current.planetId !== state.activePlanetId) return state;
  return adjustRemoteStationWarpers(state, entityId, delta);
}

/** Load or unload warpers from the station's own planet tray. */
export function adjustRemoteStationWarpers(state: GameState, entityId: string, delta: number): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station");
  const requested = Math.trunc(delta);
  if (!current || current.interactionLocked || requested === 0 ||
    !isTechnologyCompleted(state, "space_warp")) return state;
  const loaded = Math.max(0, Math.floor(current.stationWarpers ?? 0));
  const capacity = getStationWarperCapacity(current);
  const planetTray = current.planetId === state.activePlanetId ? state.tray : state.planetTrays[current.planetId] ?? {};
  const available = Math.max(0, Math.floor(planetTray.space_warper ?? 0));
  const change = requested > 0
    ? Math.min(requested, capacity - loaded, available)
    : -Math.min(-requested, loaded);
  if (change === 0) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  station.stationWarpers = loaded + change;
  if (change > 0) {
    const nextPlanetTray = station.planetId === next.activePlanetId ? next.tray : { ...(next.planetTrays[station.planetId] ?? {}) };
    nextPlanetTray.space_warper = available - change;
    if (station.planetId !== next.activePlanetId) next.planetTrays[station.planetId] = nextPlanetTray;
  } else addToPlanetTray(next, station.planetId, "space_warper", -change);
  return next;
}

export function setStationWarpEnabled(state: GameState, entityId: string, enabled: boolean): GameState {
  if (!state.entities.some((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station" && !entity.interactionLocked) ||
    (enabled && !isTechnologyCompleted(state, "space_warp"))) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, stationWarpEnabled: enabled } : entity),
  };
}

export function setStationWarperAutoRefill(state: GameState, entityId: string, enabled: boolean): GameState {
  const station = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station");
  if (!station || station.interactionLocked || (enabled && !isTechnologyCompleted(state, "space_warp")) || Boolean(station.stationWarperAutoRefill) === enabled) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, stationWarperAutoRefill: enabled } : entity),
  };
}

export function setStationWarperTarget(state: GameState, entityId: string, target: number): GameState {
  const station = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station");
  if (!station || station.interactionLocked || !Number.isFinite(target)) return state;
  const normalized = Math.max(1, Math.min(getStationWarperCapacity(station), Math.floor(target)));
  if (getStationWarperAutoRefillTarget(station) === normalized) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, stationWarperTarget: normalized } : entity),
  };
}

export function setStationMinimumLoad(state: GameState, entityId: string, minimumLoad: StationMinimumLoad): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.kind === "station");
  if (!current || current.interactionLocked || !STATION_MINIMUM_LOAD_OPTIONS.includes(minimumLoad) || getStationMinimumLoad(current) === minimumLoad) return state;
  return setStationSlotMinimumLoad(state, entityId, 0, minimumLoad);
}

export function setFuelItem(state: GameState, entityId: string, itemId: ItemId): GameState {
  const current = state.entities.find((entity) => entity.id === entityId);
  if (!current?.buildingId || current.interactionLocked || !getFuelItemIdsForBuilding(current.buildingId).includes(itemId)) return state;
  if (current.fuelItemId === itemId) return state;
  const next = copyState(state);
  const entity = next.entities.find((candidate) => candidate.id === entityId)!;
  for (const [bufferedItemId, amount] of Object.entries(entity.inputs)) addToTray(next, bufferedItemId as ItemId, amount ?? 0);
  entity.inputs = {};
  entity.fuelItemId = itemId;
  entity.powerOutputKw = 0;
  const removedBelts = next.belts.filter((belt) => belt.source === entityId || belt.target === entityId);
  refundBelts(next, removedBelts);
  next.belts = next.belts.filter((belt) => belt.source !== entityId && belt.target !== entityId);
  return next;
}

export function setEnergyMode(state: GameState, entityId: string, mode: EnergyMode): GameState {
  const current = state.entities.find((entity) => entity.id === entityId);
  if (!current || current.interactionLocked || current.buildingId !== "energy_exchanger" || mode === "auto" ||
    current.energyMode === mode || storedEnergy(current) > EPSILON) return state;
  const next = copyState(state);
  const entity = next.entities.find((candidate) => candidate.id === entityId)!;
  for (const [itemId, amount] of Object.entries(entity.inputs)) addToTray(next, itemId as ItemId, amount ?? 0);
  for (const [itemId, amount] of Object.entries(entity.outputs)) addToTray(next, itemId as ItemId, amount ?? 0);
  entity.inputs = {};
  entity.outputs = {};
  entity.energyMode = mode;
  entity.recipeId = mode === "discharge" ? "accumulator_discharge" : "accumulator_charge";
  entity.progress = 0;
  entity.powerInputKw = 0;
  entity.powerOutputKw = 0;
  const removedBelts = next.belts.filter((belt) => belt.source === entityId || belt.target === entityId);
  refundBelts(next, removedBelts);
  next.belts = next.belts.filter((belt) => belt.source !== entityId && belt.target !== entityId);
  return next;
}

export function setEntityPowerGrid(state: GameState, entityId: string, gridId: PowerGridId): GameState {
  if (!POWER_GRID_IDS.includes(gridId) || !state.entities.some((entity) => entity.id === entityId && !entity.interactionLocked)) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, powerGridId: gridId } : entity),
  };
}

export function setEntityPowerPriority(state: GameState, entityId: string, priority: PowerPriority): GameState {
  if (![1, 2, 3].includes(priority) || !state.entities.some((entity) => entity.id === entityId && !entity.interactionLocked)) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, powerPriority: priority } : entity),
  };
}

export function setEntityGenerationPriority(state: GameState, entityId: string, priority: PowerPriority): GameState {
  const target = state.entities.find((entity) => entity.id === entityId);
  if (![1, 2, 3].includes(priority) || !target || target.interactionLocked || (target.kind !== "power" && target.buildingId !== "ray_receiver")) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, generationPriority: priority } : entity),
  };
}

export function setSplitterMode(state: GameState, entityId: string, mode: "balanced" | "priority"): GameState {
  if (!state.entities.some((entity) => entity.id === entityId && entity.kind === "splitter" && !entity.interactionLocked)) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, distributionMode: mode } : entity),
  };
}

export function removeEntity(state: GameState, entityId: string, count?: number): GameState {
  const entity = state.entities.find((item) => item.id === entityId);
  if (!entity || entity.interactionLocked) return state;
  if (entity.kind === "vein") {
    if (!entity.resourceId || entity.minerCount < 1) return state;
    const requested = count === undefined ? entity.minerCount : Math.max(1, Math.floor(count));
    const recovered = Math.min(entity.minerCount, requested);
    const extractorId = getExtractorBuildingId(entity.resourceId);
    const returned = safeInventoryAdd(state.construction[extractorId], recovered);
    if (returned === null) return state;
    const next = copyState(state);
    const target = next.entities.find((item) => item.id === entityId)!;
    target.minerCount -= recovered;
    next.construction[extractorId] = returned;
    if (target.minerCount === 0) {
      target.utilization = 0;
      target.productionRate = 0;
      target.powerFactor = undefined;
    }
    return next;
  }
  const requested = count === undefined ? entity.machineCount : Math.max(1, Math.floor(count));
  if (entity.buildingId && entity.machineCount > requested) {
    const returned = safeInventoryAdd(state.construction[entity.buildingId], requested);
    if (returned === null) return state;
    const next = copyState(state);
    const target = next.entities.find((item) => item.id === entityId)!;
    target.machineCount -= requested;
    next.construction[target.buildingId!] = returned;
    return next;
  }
  if (!getEntityRemovalPreview(state, [entityId]).refundSafe) return state;
  const next = copyState(state);
  const target = next.entities.find((item) => item.id === entityId)!;
  if (target.buildingId === "construction_center") {
    const job = next.constructionAutomation.jobs[entityId];
    if (job) refundConstructionAutomationJob(next, entityId, job);
    delete next.constructionAutomation.jobs[entityId];
  }
  cancelStationRoutes(next, (demand, route) =>
    demand.id === entityId || route.peerId === entityId || routeVehicleStationId(demand, route) === entityId ||
    (route.waypointStationIds ?? []).includes(entityId));
  for (const [itemId, amount] of Object.entries(target.inputs)) addToTray(next, itemId as ItemId, amount ?? 0);
  for (const [itemId, amount] of Object.entries(target.outputs)) addToTray(next, itemId as ItemId, amount ?? 0);
  if (target.kind === "station" && (target.stationVessels ?? 0) > 0) {
    addToTray(next, "logistics_vessel", Math.floor(target.stationVessels ?? 0));
  }
  if (target.kind === "station" && (target.stationDrones ?? 0) > 0) {
    addToTray(next, "logistics_drone", Math.floor(target.stationDrones ?? 0));
  }
  if (target.kind === "station") {
    addToPlanetTray(next, target.planetId, "space_warper", Math.floor(target.stationWarpers ?? 0));
  }
  if (target.sprayCoaterInstalled) {
    next.construction.spray_coater = (next.construction.spray_coater ?? 0) + 1;
  }
  if (target.buildingId) {
    next.construction[target.buildingId] = (next.construction[target.buildingId] ?? 0) + target.machineCount;
  }
  const removedBelts = next.belts.filter((belt) => belt.source === entityId || belt.target === entityId);
  refundBelts(next, removedBelts);
  next.entities = next.entities.filter((item) => item.id !== entityId);
  next.belts = next.belts.filter((belt) => belt.source !== entityId && belt.target !== entityId);
  next.constructionQueue = next.constructionQueue.filter((entry) =>
    (entry.status ?? "pending-materials") !== "waiting-fleet" ||
    !Object.values(entry.placedEntityIdsByKey ?? {}).includes(entityId));
  if (next.timeWarp.controllerEntityId === entityId) {
    next.timeWarp.controllerEntityId = null;
    next.timeWarp.enabled = false;
    next.timeWarp.effectiveMultiplier = next.settings.simulationSpeed;
    next.timeWarp.requiredPowerKw = 0;
    next.timeWarp.allocatedPowerKw = 0;
  }
  return pruneBlueprintVersions(next);
}

export function removeEntities(state: GameState, entityIds: string[]): GameState {
  if (!getEntityRemovalPreview(state, entityIds).refundSafe) return state;
  let next = state;
  for (const entityId of [...new Set(entityIds)]) next = removeEntity(next, entityId);
  return next;
}

export interface RemovalPreviewEntry {
  constructionId: ConstructionId;
  amount: number;
}

export interface EntityRemovalPreview {
  entityCount: number;
  buildingCount: number;
  relatedBeltCount: number;
  returns: RemovalPreviewEntry[];
  refundSafe: boolean;
}

/** Read-only summary used by every selection-removal confirmation surface. */
export function getEntityRemovalPreview(state: GameState, entityIds: readonly string[], beltIds: readonly string[] = []): EntityRemovalPreview {
  const requestedIds = new Set(entityIds);
  const entities = state.entities.filter((entity) => requestedIds.has(entity.id) && !entity.interactionLocked);
  const removableIds = new Set(entities.map((entity) => entity.id));
  const selectedBeltIds = new Set(beltIds);
  const relatedBelts = state.belts.filter((belt) => selectedBeltIds.has(belt.id) || removableIds.has(belt.source) || removableIds.has(belt.target));
  const totals = new Map<ConstructionId, number>();
  let refundSafe = true;
  const add = (constructionId: ConstructionId, amount: number) => {
    const current = totals.get(constructionId) ?? 0;
    const addition = Math.max(0, Math.floor(amount));
    const next = current + addition;
    const returned = safeInventoryAdd(state.construction[constructionId], next);
    if (!Number.isSafeInteger(addition) || !Number.isSafeInteger(next) || returned === null) {
      refundSafe = false;
      return;
    }
    totals.set(constructionId, next);
  };
  let buildingCount = 0;
  for (const entity of entities) {
    const amount = entity.kind === "vein" ? entity.minerCount : entity.machineCount;
    buildingCount += amount;
    if (entity.kind === "vein" && entity.resourceId && entity.minerCount > 0) add(getExtractorBuildingId(entity.resourceId), entity.minerCount);
    else if (entity.buildingId) add(entity.buildingId, entity.machineCount);
    if (entity.sprayCoaterInstalled) add("spray_coater", 1);
  }
  for (const belt of relatedBelts) add(getBeltConstructionId(belt.tier), belt.lanes);
  return {
    entityCount: entities.length,
    buildingCount: Number.isSafeInteger(buildingCount) ? buildingCount : Number.MAX_SAFE_INTEGER,
    relatedBeltCount: relatedBelts.length,
    returns: [...totals].map(([constructionId, amount]) => ({ constructionId, amount })),
    refundSafe,
  };
}

export type EntityStackTargetCheck =
  | { ok: true; current: number; target: number; delta: number; constructionId: BuildingId }
  | { ok: false; current: number; target: number; code: "missing" | "locked" | "invalid-count" | "stack-limit" | "unique" | "inventory" | "unsafe-refund"; label: string };

/** Shared validation for local inspectors and cross-planet logistics editing. */
export function getEntityStackTargetCheck(state: GameState, entityId: string, targetCount: number): EntityStackTargetCheck {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  if (!entity || (!entity.buildingId && !(entity.kind === "vein" && entity.resourceId))) {
    return { ok: false, current: 0, target: targetCount, code: "missing", label: "目标建筑不存在或不支持堆叠调整" };
  }
  const current = entity.kind === "vein" ? entity.minerCount : entity.machineCount;
  if (entity.interactionLocked) {
    return { ok: false, current, target: targetCount, code: "locked", label: "建筑已锁定，请先解锁后再调整堆叠" };
  }
  if (!Number.isSafeInteger(targetCount) || targetCount < 1) {
    return { ok: false, current, target: targetCount, code: "invalid-count", label: "堆叠目标必须是 1 至 100,000,000 的正整数" };
  }
  const constructionId = entity.kind === "vein"
    ? getExtractorBuildingId(entity.resourceId!)
    : entity.buildingId!;
  if (targetCount === current) return { ok: true, current, target: targetCount, delta: 0, constructionId };
  if ((entity.buildingId === "micro_black_hole_connector" || entity.buildingId === "time_warp_device") && targetCount !== 1) {
    return { ok: false, current, target: targetCount, code: "unique", label: `${getBuilding(constructionId).name}是唯一巨构，堆叠目标固定为 1` };
  }
  if (targetCount > current) {
    const addition = targetCount - current;
    const additionCheck = getBuildingStackAdditionCheck(current, addition, getBuilding(constructionId).name);
    if (!additionCheck.ok) {
      return { ok: false, current, target: targetCount, code: additionCheck.code === "stack-limit" ? "stack-limit" : "invalid-count", label: additionCheck.label };
    }
    const definition = getBuilding(constructionId);
    if (definition.stackLimit && targetCount > definition.stackLimit) {
      return { ok: false, current, target: targetCount, code: "stack-limit", label: `${definition.name}最多堆叠 ${definition.stackLimit.toLocaleString("zh-CN")}` };
    }
    const available = Math.floor(state.construction[constructionId] ?? 0);
    if (available < addition) {
      return {
        ok: false,
        current,
        target: targetCount,
        code: "inventory",
        label: `施工托盘中的${getBuilding(constructionId).name}不足：需要 ${addition.toLocaleString("zh-CN")}，现有 ${available.toLocaleString("zh-CN")}`,
      };
    }
    return { ok: true, current, target: targetCount, delta: addition, constructionId };
  }
  const refund = current - targetCount;
  if (safeInventoryAdd(state.construction[constructionId], refund) === null) {
    return { ok: false, current, target: targetCount, code: "unsafe-refund", label: "返还后的施工托盘数量会超出安全整数范围，请先导出备份并联系存档救援" };
  }
  return { ok: true, current, target: targetCount, delta: -refund, constructionId };
}

export function setEntityStackTarget(state: GameState, entityId: string, targetCount: number): GameState {
  const check = getEntityStackTargetCheck(state, entityId, targetCount);
  if (!check.ok || check.delta === 0) return state;
  if (check.delta > 0) return addUnitToEntityGroup(state, entityId, check.delta);
  return removeEntity(state, entityId, -check.delta);
}

/** Set a remote station stack without switching the active planet. */
export function setRemoteBuildingStackTarget(state: GameState, entityId: string, targetCount: number): GameState {
  return setEntityStackTarget(state, entityId, targetCount);
}

export function canUpgradeEntity(state: GameState, entityId: string): boolean {
  const entity = state.entities.find((item) => item.id === entityId);
  if (!entity?.buildingId || entity.interactionLocked || entity.kind === "vein") return false;
  const targetId = getBuildingUpgradeTarget(entity.buildingId);
  const definition = targetId ? getConstructionDefinition(targetId) : undefined;
  return Boolean(targetId && definition &&
    (!definition.requiredTechId || isTechnologyCompleted(state, definition.requiredTechId)) &&
    (state.construction[targetId] ?? 0) >= entity.machineCount);
}

export function upgradeEntity(state: GameState, entityId: string): GameState {
  if (!canUpgradeEntity(state, entityId)) return state;
  const current = state.entities.find((entity) => entity.id === entityId)!;
  const sourceId = current.buildingId!;
  const targetId = getBuildingUpgradeTarget(sourceId)!;
  const next = copyState(state);
  const entity = next.entities.find((candidate) => candidate.id === entityId)!;
  next.construction[targetId] = (next.construction[targetId] ?? 0) - entity.machineCount;
  next.construction[sourceId] = (next.construction[sourceId] ?? 0) + entity.machineCount;
  entity.buildingId = targetId;
  return next;
}

export function canUpgradeEntities(state: GameState, entityIds: string[]): boolean {
  return entityIds.some((entityId) => canUpgradeEntity(state, entityId));
}

export function upgradeEntities(state: GameState, entityIds: string[]): GameState {
  let next = state;
  for (const entityId of [...new Set(entityIds)]) {
    if (canUpgradeEntity(next, entityId)) next = upgradeEntity(next, entityId);
  }
  return next;
}

export function canUpgradeBelt(state: GameState, beltId: string): boolean {
  const belt = state.belts.find((item) => item.id === beltId);
  const targetTier = belt ? getNextBeltTier(belt.tier) : null;
  if (!belt || targetTier === null) return false;
  const targetId = getBeltConstructionId(targetTier);
  const definition = getConstructionDefinition(targetId);
  return Boolean(definition &&
    (!definition.requiredTechId || isTechnologyCompleted(state, definition.requiredTechId)) &&
    (state.construction[targetId] ?? 0) >= belt.lanes);
}

export function upgradeBelt(state: GameState, beltId: string): GameState {
  if (!canUpgradeBelt(state, beltId)) return state;
  const current = state.belts.find((belt) => belt.id === beltId)!;
  const sourceId = getBeltConstructionId(current.tier);
  const targetTier = getNextBeltTier(current.tier)!;
  const targetId = getBeltConstructionId(targetTier);
  const next = copyState(state);
  const belt = next.belts.find((candidate) => candidate.id === beltId)!;
  next.construction[targetId] = (next.construction[targetId] ?? 0) - belt.lanes;
  next.construction[sourceId] = (next.construction[sourceId] ?? 0) + belt.lanes;
  belt.tier = targetTier;
  belt.sorterTier = Math.min(3, targetTier) as SorterTier;
  return next;
}

export function canUpgradeSorter(state: GameState, beltId: string): boolean {
  void state;
  void beltId;
  // Transport is now driven directly by belt capacity. This legacy API remains
  // for migrated saves and integrations, but no longer consumes a sorter item.
  return false;
}

export function upgradeSorter(state: GameState, beltId: string): GameState {
  void beltId;
  return state;
}

export function getSorterCapacity(belt: BeltConnection): number {
  return getBeltSpeed(belt.tier) * belt.lanes * (belt.stackSize ?? 1);
}

export function getBeltCapacity(belt: BeltConnection): number {
  return getBeltSpeed(belt.tier) * belt.lanes * (belt.stackSize ?? 1);
}

export function canSetBeltStackSize(state: GameState, stackSize: CargoStackSize): boolean {
  if (stackSize === 1) return true;
  if (stackSize === 2) return isTechnologyCompleted(state, "high_speed_logistics");
  return isTechnologyCompleted(state, "super_magnetic_logistics");
}

export function setBeltStackSize(state: GameState, beltId: string, stackSize: CargoStackSize): GameState {
  if (!CARGO_STACK_OPTIONS.includes(stackSize) || !canSetBeltStackSize(state, stackSize) ||
    !state.belts.some((belt) => belt.id === beltId)) return state;
  return {
    ...state,
    belts: state.belts.map((belt) => belt.id === beltId ? { ...belt, stackSize, progress: 0 } : belt),
  };
}

export function setBeltMonitorEnabled(state: GameState, beltId: string, enabled: boolean): GameState {
  if (!state.belts.some((belt) => belt.id === beltId)) return state;
  return {
    ...state,
    belts: state.belts.map((belt) => belt.id === beltId ? { ...belt, monitorEnabled: enabled } : belt),
  };
}

const BELT_ROUTE_MODES: BeltRouteMode[] = ["bezier", "auto", "upper", "lower", "manual"];

export function setBeltRouteMode(state: GameState, beltId: string, routeMode: BeltRouteMode): GameState {
  if (!BELT_ROUTE_MODES.includes(routeMode) || !state.belts.some((belt) => belt.id === beltId)) return state;
  return {
    ...state,
    belts: state.belts.map((belt) => belt.id === beltId ? { ...belt, routeMode } : belt),
  };
}

export function setBeltRouteOffsetY(state: GameState, beltId: string, routeOffsetY: number): GameState {
  if (!Number.isFinite(routeOffsetY) || !state.belts.some((belt) => belt.id === beltId)) return state;
  const offset = Math.max(-600, Math.min(600, Math.round(routeOffsetY)));
  return {
    ...state,
    belts: state.belts.map((belt) => belt.id === beltId ? { ...belt, routeMode: "manual", routeOffsetY: offset } : belt),
  };
}

export function getBeltNetworkIds(state: GameState, beltId: string): string[] {
  const origin = state.belts.find((belt) => belt.id === beltId);
  if (!origin) return [];
  const connectedNodes = new Set<string>([origin.source, origin.target]);
  const network = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const belt of state.belts) {
      if (belt.planetId !== origin.planetId || belt.itemId !== origin.itemId || network.has(belt.id)) continue;
      if (!connectedNodes.has(belt.source) && !connectedNodes.has(belt.target)) continue;
      network.add(belt.id);
      connectedNodes.add(belt.source);
      connectedNodes.add(belt.target);
      changed = true;
    }
  }
  return [...network];
}

export function upgradeBeltNetwork(state: GameState, beltId: string): GameState {
  return getBeltNetworkIds(state, beltId).reduce((current, id) => upgradeBelt(current, id), state);
}

export function upgradeSorterNetwork(state: GameState, beltId: string): GameState {
  return getBeltNetworkIds(state, beltId).reduce((current, id) => upgradeSorter(current, id), state);
}

export function setBeltNetworkRouteMode(state: GameState, beltId: string, routeMode: BeltRouteMode): GameState {
  if (!BELT_ROUTE_MODES.includes(routeMode)) return state;
  const ids = new Set(getBeltNetworkIds(state, beltId));
  if (ids.size === 0) return state;
  return { ...state, belts: state.belts.map((belt) => ids.has(belt.id) ? { ...belt, routeMode } : belt) };
}

export interface BeltConfigurationApplyResult {
  state: GameState;
  applied: number;
  skipped: number;
  failed: number;
  error?: string;
}

export function applyBeltConfigurationToBelts(
  state: GameState,
  sourceBeltId: string,
  targetBeltIds: readonly string[],
): BeltConfigurationApplyResult {
  const source = state.belts.find((belt) => belt.id === sourceBeltId);
  const ids = [...new Set(targetBeltIds)].filter((id) => id !== sourceBeltId);
  if (!source) return { state, applied: 0, skipped: 0, failed: ids.length, error: "模板运输线不存在" };
  const targets = ids.map((id) => state.belts.find((belt) => belt.id === id)).filter((belt): belt is BeltConnection => Boolean(belt));
  if (targets.length !== ids.length) return { state, applied: 0, skipped: 0, failed: ids.length, error: "目标运输线不存在" };
  if (source.lanes < 1 || source.lanes > MAX_BELT_LANES) {
    return { state, applied: 0, skipped: 0, failed: ids.length, error: `模板线路并联数量超出 1-${MAX_BELT_LANES}，请先手动调整` };
  }
  const netConstructionDelta = new Map<ConstructionId, number>();
  for (const target of targets) {
    const constructionId = getBeltConstructionId(target.tier);
    netConstructionDelta.set(constructionId, (netConstructionDelta.get(constructionId) ?? 0) + source.lanes - target.lanes);
  }
  for (const [constructionId, delta] of netConstructionDelta) {
    const available = Math.max(0, Math.floor(state.construction[constructionId] ?? 0));
    if (delta > available) {
      const name = getConstructionDefinition(constructionId)?.name ?? "同级传送带";
      return { state, applied: 0, skipped: 0, failed: ids.length, error: `缺少${name} ×${delta - available}（需要 ${delta}，现有 ${available}）` };
    }
  }
  const stackSize = canSetBeltStackSize(state, source.stackSize ?? 1) ? source.stackSize ?? 1 : 1;
  const next = copyState(state);
  for (const [constructionId, delta] of netConstructionDelta) {
    next.construction[constructionId] = Math.max(0, Math.floor(next.construction[constructionId] ?? 0) - delta);
  }
  const targetIds = new Set(ids);
  let applied = 0;
  for (const belt of next.belts) {
    if (!targetIds.has(belt.id)) continue;
    const changed = belt.lanes !== source.lanes || belt.priority !== source.priority || (belt.stackSize ?? 1) !== stackSize ||
      belt.monitorEnabled !== source.monitorEnabled || (belt.routeMode ?? "auto") !== (source.routeMode ?? "auto") ||
      belt.routeOffsetY !== source.routeOffsetY;
    belt.lanes = source.lanes;
    belt.priority = source.priority;
    belt.stackSize = stackSize;
    belt.monitorEnabled = source.monitorEnabled;
    belt.routeMode = source.routeMode ?? "auto";
    belt.routeOffsetY = source.routeOffsetY;
    if (changed) applied += 1;
  }
  const skipped = targets.length - applied;
  return applied > 0
    ? { state: next, applied, skipped, failed: 0 }
    : { state, applied: 0, skipped, failed: 0 };
}

export function applyBeltConfigurationToNetworkResult(state: GameState, sourceBeltId: string): BeltConfigurationApplyResult {
  return applyBeltConfigurationToBelts(state, sourceBeltId, getBeltNetworkIds(state, sourceBeltId));
}

export function applyBeltConfigurationToNetwork(state: GameState, sourceBeltId: string): GameState {
  return applyBeltConfigurationToNetworkResult(state, sourceBeltId).state;
}

export function removeBeltNetwork(state: GameState, beltId: string): GameState {
  const ids = new Set(getBeltNetworkIds(state, beltId));
  if (ids.size === 0) return state;
  const next = copyState(state);
  const removed = next.belts.filter((belt) => ids.has(belt.id));
  refundBelts(next, removed);
  next.belts = next.belts.filter((belt) => !ids.has(belt.id));
  return next;
}

export function applyBeltConfiguration(state: GameState, sourceBeltId: string, targetBeltId: string): GameState {
  return applyBeltConfigurationToBelts(state, sourceBeltId, [targetBeltId]).state;
}

export function getConstructionCraftDeficits(state: GameState, buildingId: ConstructionId, batches = 1): {
  missingTechnology: string | null;
  missingItems: Array<{ itemId: ItemId; current: number; required: number; missing: number }>;
} {
  const definition = CONSTRUCTION.find((item) => item.buildingId === buildingId);
  const amount = normalizeManualCraftBatches(batches);
  if (!definition) return { missingTechnology: null, missingItems: [] };
  return {
    missingTechnology: definition.requiredTechId && !isTechnologyCompleted(state, definition.requiredTechId)
      ? getTechnology(definition.requiredTechId)?.name ?? definition.requiredTechId
      : null,
    missingItems: definition.costs.flatMap((cost) => {
      const current = Math.max(0, Math.floor(state.tray[cost.itemId] ?? 0));
      const required = cost.amount * amount;
      return current + EPSILON < required ? [{ itemId: cost.itemId, current, required, missing: required - current }] : [];
    }),
  };
}

export function canCraftConstruction(state: GameState, buildingId: ConstructionId, batches = 1): boolean {
  const definition = CONSTRUCTION.find((item) => item.buildingId === buildingId);
  if (!definition) return false;
  const deficits = getConstructionCraftDeficits(state, buildingId, batches);
  return !deficits.missingTechnology && deficits.missingItems.length === 0;
}

const NON_HANDCRAFTABLE_RECIPE_IDS = new Set<RecipeId>([
  "plasma_refining",
  "xray_cracking",
  "reforming_refine",
  "ray_power",
  "critical_photon",
  "matrix_research",
  "solar_sail_launch",
  "carrier_rocket_launch",
  "accumulator_charge",
  "accumulator_discharge",
]);

/** Material recipes can be replicated by hand; facility-only state transitions cannot. */
export function isHandcraftableRecipe(recipeId: RecipeId): boolean {
  const recipe = getRecipe(recipeId);
  return Boolean(recipe && recipe.inputs.length > 0 && recipe.outputs.length > 0 && !NON_HANDCRAFTABLE_RECIPE_IDS.has(recipe.id));
}

const RECURSIVE_UPSTREAM_ONLY_RECIPE_IDS = new Set<RecipeId>([
  "plasma_refining",
]);

/** Facility recipes that may safely run as an internal recursive material step. */
export function isRecursiveManufacturingRecipe(recipeId: RecipeId): boolean {
  const recipe = getRecipe(recipeId);
  return Boolean(recipe && recipe.inputs.length > 0 && recipe.outputs.length > 0 &&
    (isHandcraftableRecipe(recipeId) || RECURSIVE_UPSTREAM_ONLY_RECIPE_IDS.has(recipeId)));
}

function canStoreRecipeOutputsInTray(state: GameState, recipe: RecipeDefinition, batches = 1): boolean {
  const requiredByItem = new Map<ItemId, number>();
  for (const output of recipe.outputs) {
    requiredByItem.set(output.itemId, (requiredByItem.get(output.itemId) ?? 0) + output.amount * batches);
  }
  return [...requiredByItem].every(([itemId, amount]) =>
    getPlanetTrayItemFreeCapacity(state, state.activePlanetId, itemId) + EPSILON >= amount);
}

export function canHandcraftRecipe(state: GameState, recipeId: RecipeId, batches = 1): boolean {
  const recipe = getRecipe(recipeId);
  const amount = normalizeManualCraftBatches(batches);
  return Boolean(recipe && isHandcraftableRecipe(recipeId) &&
    (!recipe.requiredTechId || isTechnologyCompleted(state, recipe.requiredTechId)) &&
    recipe.inputs.every((input) => (state.tray[input.itemId] ?? 0) + EPSILON >= input.amount * amount) &&
    canStoreRecipeOutputsInTray(state, recipe, amount));
}

export interface RecursiveHandcraftPlan {
  possible: boolean;
  recipeId: RecipeId;
  batches: number;
  outputAmount: number;
  consumedItems: Array<{ itemId: ItemId; amount: number }>;
  producedItems: Array<{ itemId: ItemId; amount: number }>;
  decisions: RecursiveCraftDecision[];
  blocker?: RecursiveCraftBlocker | {
    reason: "capacity";
    itemId: ItemId;
    current: number;
    required: number;
    limit: number;
  };
}

interface InternalRecursiveHandcraftPlan extends RecursiveHandcraftPlan {
  inventory?: Partial<Record<ItemId, number>>;
}

function buildRecursiveHandcraftPlan(state: GameState, recipeId: RecipeId, batches = 1): InternalRecursiveHandcraftPlan {
  const amount = normalizeManualCraftBatches(batches);
  const recipe = getRecipe(recipeId);
  const outputAmount = recipe?.outputs.reduce((sum, output) => sum + output.amount * amount, 0) ?? 0;
  const blocked = (blocker?: InternalRecursiveHandcraftPlan["blocker"]): InternalRecursiveHandcraftPlan => ({
    possible: false,
    recipeId,
    batches: amount,
    outputAmount,
    consumedItems: [],
    producedItems: [],
    decisions: [],
    blocker,
  });
  if (!recipe || !isHandcraftableRecipe(recipeId)) {
    return blocked({ itemId: recipe?.outputs[0]?.itemId ?? "iron_ore", current: 0, required: 1, reason: "no-recipe" });
  }

  const initialInventory = recursiveManufacturingInventory(state);
  const plan = planSelectedRecipe({
    inventory: initialInventory,
    recipe,
    batches: amount,
    recipes: recursiveManufacturingRecipes(),
    completedTechnologyIds: state.research.completedTechIds,
    allowRecipe: (candidate) => isRecursiveManufacturingRecipe(candidate.id),
  });
  if (!plan.possible) return blocked(plan.blocker);

  const unsafe = findUnsafeRecursiveInventory(plan.inventory);
  if (unsafe) return blocked({
    itemId: unsafe.itemId,
    current: Math.max(0, Math.floor(initialInventory[unsafe.itemId] ?? 0)),
    required: unsafe.value,
    reason: "capacity",
    limit: Number.MAX_SAFE_INTEGER,
  });

  const consumedItems = (Object.keys(ITEMS) as ItemId[]).flatMap((itemId) => {
    const consumed = Math.max(0, Math.floor((initialInventory[itemId] ?? 0) - (plan.inventory[itemId] ?? 0)));
    return consumed > 0 ? [{ itemId, amount: consumed }] : [];
  });
  return {
    possible: true,
    recipeId,
    batches: amount,
    outputAmount,
    consumedItems,
    producedItems: recursiveProducedItems(plan),
    decisions: plan.decisions,
    inventory: plan.inventory,
  };
}

export function getRecursiveHandcraftPlan(state: GameState, recipeId: RecipeId, batches = 1): RecursiveHandcraftPlan {
  const { inventory: _inventory, ...plan } = buildRecursiveHandcraftPlan(state, recipeId, batches);
  return plan;
}

export function getMaxRecursiveHandcraftBatches(state: GameState, recipeId: RecipeId): number {
  if (!buildRecursiveHandcraftPlan(state, recipeId, 1).possible) return 0;
  let low = 1;
  let high = 2;
  while (high < MAX_MANUAL_CRAFT_BATCHES && buildRecursiveHandcraftPlan(state, recipeId, high).possible) {
    low = high;
    high = Math.min(MAX_MANUAL_CRAFT_BATCHES, high * 2);
  }
  if (high === MAX_MANUAL_CRAFT_BATCHES && buildRecursiveHandcraftPlan(state, recipeId, high).possible) return high;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (buildRecursiveHandcraftPlan(state, recipeId, middle).possible) low = middle;
    else high = middle;
  }
  return low;
}

export function handcraftRecipeWithUpstream(state: GameState, recipeId: RecipeId, batches = 1): GameState {
  const plan = buildRecursiveHandcraftPlan(state, recipeId, batches);
  if (!plan.possible || !plan.inventory) return state;
  const next = copyState(state);
  applyRecursiveManufacturingInventory(next, plan.inventory);
  for (const item of plan.producedItems) {
    next.totalProduced[item.itemId] = Math.floor((next.totalProduced[item.itemId] ?? 0) + item.amount);
  }
  return next;
}

export function handcraftRecipe(state: GameState, recipeId: RecipeId, batches = 1): GameState {
  const amount = normalizeManualCraftBatches(batches);
  const recipe = getRecipe(recipeId);
  if (!recipe || !canHandcraftRecipe(state, recipeId, amount)) return state;
  const next = copyState(state);
  for (const input of recipe.inputs) {
    next.tray[input.itemId] = Math.max(0, Math.floor((next.tray[input.itemId] ?? 0) - input.amount * amount));
  }
  for (const output of recipe.outputs) {
    const produced = output.amount * amount;
    addToTray(next, output.itemId, produced);
    next.totalProduced[output.itemId] = Math.floor((next.totalProduced[output.itemId] ?? 0) + produced);
  }
  return next;
}

export function canQueueHandcraftRecipe(state: GameState, recipeId: RecipeId): boolean {
  const recipe = getRecipe(recipeId);
  return Boolean(recipe && isHandcraftableRecipe(recipeId) &&
    (!recipe.requiredTechId || isTechnologyCompleted(state, recipe.requiredTechId)) && state.handcraftQueue.length < 20);
}

export function getMaxHandcraftBatches(state: GameState, recipeId: RecipeId): number {
  const recipe = getRecipe(recipeId);
  if (!recipe || !isHandcraftableRecipe(recipeId) ||
    (recipe.requiredTechId && !isTechnologyCompleted(state, recipe.requiredTechId))) return 0;
  const inputTotals = new Map<ItemId, number>();
  const outputTotals = new Map<ItemId, number>();
  for (const input of recipe.inputs) inputTotals.set(input.itemId, (inputTotals.get(input.itemId) ?? 0) + input.amount);
  for (const output of recipe.outputs) outputTotals.set(output.itemId, (outputTotals.get(output.itemId) ?? 0) + output.amount);
  const limits = [
    ...[...inputTotals].map(([itemId, amount]) => Math.floor(Math.max(0, state.tray[itemId] ?? 0) / amount)),
    ...[...outputTotals].map(([itemId, amount]) => Math.floor(getPlanetTrayItemFreeCapacity(state, state.activePlanetId, itemId) / amount)),
    MAX_MANUAL_CRAFT_BATCHES,
  ];
  return Math.max(0, Math.min(...limits));
}

export function queueHandcraftRecipe(state: GameState, recipeId: RecipeId, batches = 1): GameState {
  const amount = normalizeManualCraftBatches(batches);
  if (!canQueueHandcraftRecipe(state, recipeId)) return state;
  const next = copyState(state);
  next.handcraftQueue.push({
    id: `handcraft_${next.nextId}`,
    recipeId,
    planetId: next.activePlanetId,
    batchesTotal: amount,
    batchesRemaining: amount,
    progress: 0,
    queuedAt: next.elapsedSeconds,
  });
  next.nextId += 1;
  return next;
}

export function cancelHandcraftQueueEntry(state: GameState, entryId: string): GameState {
  if (!state.handcraftQueue.some((entry) => entry.id === entryId)) return state;
  return { ...state, handcraftQueue: state.handcraftQueue.filter((entry) => entry.id !== entryId) };
}

function advanceHandcraftQueue(state: GameState, seconds: number): void {
  let remainingSeconds = Math.max(0, seconds);
  while (remainingSeconds > EPSILON && state.handcraftQueue.length > 0) {
    const entry = state.handcraftQueue[0];
    if (entry.planetId !== state.activePlanetId) break;
    const recipe = getRecipe(entry.recipeId);
    if (!recipe || recipe.outputs.length === 0) {
      state.handcraftQueue.shift();
      continue;
    }
    const duration = Math.max(0.05, recipe.duration);
    if (entry.progress <= EPSILON) {
      if (!canStoreRecipeOutputsInTray(state, recipe)) break;
      const hasInputs = recipe.inputs.every((input) => (state.tray[input.itemId] ?? 0) + EPSILON >= input.amount);
      if (!hasInputs) break;
      for (const input of recipe.inputs) {
        state.tray[input.itemId] = Math.max(0, Math.floor((state.tray[input.itemId] ?? 0) - input.amount));
      }
    }
    const cycleRemaining = Math.max(0, (1 - entry.progress) * duration);
    const elapsed = Math.min(remainingSeconds, cycleRemaining);
    entry.progress = Math.min(1, entry.progress + elapsed / duration);
    remainingSeconds -= elapsed;
    if (entry.progress < 1 - EPSILON) break;
    if (!canStoreRecipeOutputsInTray(state, recipe)) break;
    for (const output of recipe.outputs) {
      addToTray(state, output.itemId, output.amount);
      state.totalProduced[output.itemId] = Math.floor((state.totalProduced[output.itemId] ?? 0) + output.amount);
    }
    entry.batchesRemaining -= 1;
    entry.progress = 0;
    if (entry.batchesRemaining <= 0) state.handcraftQueue.shift();
  }
}

export function isTechnologyCompleted(state: GameState, techId: TechId): boolean {
  return state.research.completedTechIds.includes(techId);
}

export function getTechnologyConstructionRewards(techId: TechId): ConstructionId[] {
  return CONSTRUCTION.filter((definition) => definition.requiredTechId === techId)
    .filter((definition) => !(definition.buildingId in BUILDINGS) ||
      !getBuilding(definition.buildingId as BuildingId).megastructure)
    .map((definition) => definition.buildingId);
}

function completeTechnology(state: GameState, techId: TechId): void {
  if (state.research.completedTechIds.includes(techId)) return;
  state.research.completedTechIds.push(techId);
  for (const constructionId of getTechnologyConstructionRewards(techId)) {
    state.construction[constructionId] = Math.floor((state.construction[constructionId] ?? 0) + 2);
  }
  if (techId === "universe_matrix" && !state.entities.some((entity) => entity.buildingId === "galactic_material_exporter") &&
    Math.floor(state.construction.galactic_material_exporter ?? 0) < 1) {
    state.construction.galactic_material_exporter = 1;
  }
  if (techId === "interstellar_logistics") {
    for (const planetId of ["ashen", "giant"] as PlanetId[]) {
      if (!state.exploration.colonizedPlanetIds.includes(planetId)) state.exploration.colonizedPlanetIds.push(planetId);
    }
  }
}

/**
 * Complete finite research whose persisted matrix progress already reached
 * every cost boundary.  This is deliberately idempotent and is shared by
 * simulation, command, and save-migration boundaries so a skipped final
 * research cycle cannot leave a permanently stalled technology.
 */
export function settleCompletedResearchBoundariesInPlace(state: GameState): TechId[] {
  const completed: TechId[] = [];
  const technologyLimit = Object.keys(RECIPES).length + state.research.queuedTechIds.length + 8;
  let guard = 0;
  while (state.research.selectedTechId && guard++ < technologyLimit) {
    const techId = state.research.selectedTechId;
    const technology = getTechnology(techId);
    if (!technology || state.research.completedTechIds.includes(techId)) {
      activateNextQueuedTechnology(state);
      continue;
    }
    const progress = { ...(state.research.progressByTech[techId] ?? {}) };
    const complete = technology.costs.every((cost) =>
      Number.isFinite(progress[cost.itemId]) && Math.floor(progress[cost.itemId] ?? 0) >= cost.amount);
    if (!complete) break;
    // A malformed affine result may overshoot a cost.  The excess is not an
    // input inventory and must not be carried into the next technology.
    for (const cost of technology.costs) progress[cost.itemId] = cost.amount;
    state.research.progressByTech[techId] = progress;
    completeTechnology(state, techId);
    completed.push(techId);
    activateNextQueuedTechnology(state);
    for (const entity of state.entities) {
      if (entity.recipeId === "matrix_research") entity.progress = 0;
    }
  }
  return completed;
}

/**
 * Pure command-facing wrapper.  It returns the original object when no
 * boundary is due, preserving the existing immutable command convention.
 */
export function settleCompletedResearchBoundaries(state: GameState): GameState {
  const selected = state.research.selectedTechId;
  if (!selected) return state;
  const technology = getTechnology(selected);
  if (!technology) return state;
  const progress = state.research.progressByTech[selected] ?? {};
  if (!technology.costs.every((cost) => Math.floor(progress[cost.itemId] ?? 0) >= cost.amount)) return state;
  const next = copyState(state);
  settleCompletedResearchBoundariesInPlace(next);
  return next;
}


export function canSelectTechnology(state: GameState, techId: TechId): boolean {
  const technology = getTechnology(techId);
  return Boolean(technology && !isDeprecatedTechnology(techId) && !isTechnologyCompleted(state, techId) && state.research.selectedTechId !== techId &&
    !state.research.queuedTechIds.includes(techId) &&
    technology.prerequisites.every((prerequisite) => isTechnologyCompleted(state, prerequisite)));
}

export function canQueueTechnology(state: GameState, techId: TechId): boolean {
  const technology = getTechnology(techId);
  if (!technology || isDeprecatedTechnology(techId) || isTechnologyCompleted(state, techId) || state.research.selectedTechId === techId ||
    state.research.queuedTechIds.includes(techId)) return false;
  const planned = new Set<TechId>([
    ...state.research.completedTechIds,
    ...(state.research.pausedTechId ? [state.research.pausedTechId] : []),
    ...(state.research.selectedTechId ? [state.research.selectedTechId] : []),
    ...state.research.queuedTechIds,
  ]);
  return technology.prerequisites.every((prerequisite) => planned.has(prerequisite));
}

function activateNextQueuedTechnology(state: GameState): void {
  const completed = new Set(state.research.completedTechIds);
  const nextIndex = state.research.queuedTechIds.findIndex((techId) => {
    const technology = getTechnology(techId);
    return Boolean(technology?.prerequisites.every((prerequisite) => completed.has(prerequisite)));
  });
  if (nextIndex < 0) {
    state.research.selectedTechId = null;
    return;
  }
  const [nextTechId] = state.research.queuedTechIds.splice(nextIndex, 1);
  state.research.selectedTechId = nextTechId ?? null;
}

export function selectTechnology(state: GameState, techId: TechId): GameState {
  if (state.research.selectedTechId) {
    if (!canQueueTechnology(state, techId)) return state;
    const next = copyState(state);
    next.research.queuedTechIds.push(techId);
    settleCompletedResearchBoundariesInPlace(next);
    return next;
  }
  if (!canSelectTechnology(state, techId)) return state;
  const next = copyState(state);
  next.research.selectedTechId = techId;
  if (next.research.pausedTechId === techId) next.research.pausedTechId = null;
  for (const entity of next.entities) {
    if (entity.recipeId === "matrix_research") entity.progress = 0;
  }
  settleCompletedResearchBoundariesInPlace(next);
  return next;
}

export function pauseCurrentResearch(state: GameState): GameState {
  if (!state.research.selectedTechId && !state.endgame?.activeInfiniteResearchId) return state;
  const next = copyState(state);
  if (next.research.selectedTechId) {
    next.research.pausedTechId = next.research.selectedTechId;
    next.research.selectedTechId = null;
  }
  if (next.endgame?.activeInfiniteResearchId) next.endgame.activeInfiniteResearchId = null;
  for (const entity of next.entities) {
    if (entity.recipeId === "matrix_research") entity.progress = 0;
  }
  return next;
}

export function resumePausedResearch(state: GameState): GameState {
  const techId = state.research.pausedTechId;
  if (!techId || state.research.selectedTechId || !canSelectTechnology(state, techId)) return state;
  const next = copyState(state);
  next.research.selectedTechId = techId;
  next.research.pausedTechId = null;
  for (const entity of next.entities) {
    if (entity.recipeId === "matrix_research") entity.progress = 0;
  }
  settleCompletedResearchBoundariesInPlace(next);
  return next;
}

export function cancelCurrentResearch(state: GameState): GameState {
  if (!state.research.selectedTechId && !state.endgame?.activeInfiniteResearchId) return state;
  const next = copyState(state);
  const repaired = settleCompletedResearchBoundariesInPlace(next);
  // If the current item was already complete, the repair is the requested
  // state transition.  Do not immediately cancel the newly activated queue
  // item in the same command.
  if (repaired.length > 0) return next;
  next.research.selectedTechId = null;
  if (next.endgame?.activeInfiniteResearchId) next.endgame.activeInfiniteResearchId = null;
  activateNextQueuedTechnology(next);
  for (const entity of next.entities) {
    if (entity.recipeId === "matrix_research") entity.progress = 0;
  }
  return next;
}

export function removeQueuedTechnology(state: GameState, techId: TechId): GameState {
  if (!state.research.queuedTechIds.includes(techId)) return state;
  const next = copyState(state);
  const planned = new Set<TechId>([
    ...next.research.completedTechIds,
    ...(next.research.pausedTechId ? [next.research.pausedTechId] : []),
    ...(next.research.selectedTechId ? [next.research.selectedTechId] : []),
  ]);
  const validQueue: TechId[] = [];
  for (const queuedTechId of next.research.queuedTechIds.filter((queued) => queued !== techId)) {
    const technology = getTechnology(queuedTechId);
    if (!technology?.prerequisites.every((prerequisite) => planned.has(prerequisite))) continue;
    validQueue.push(queuedTechId);
    planned.add(queuedTechId);
  }
  next.research.queuedTechIds = validQueue;
  return next;
}

function validInfiniteResearchId(value: InfiniteResearchId): value is InfiniteResearchId {
  return Boolean(value && INFINITE_RESEARCH_BY_ID[value]);
}

export function selectInfiniteResearch(state: GameState, researchId: InfiniteResearchId): GameState {
  if (!validInfiniteResearchId(researchId) || !isEndgameUnlocked(state)) return state;
  if (isInfiniteResearchComplete(researchId, state.endgame.infiniteResearch[researchId]?.level ?? 0)) return state;
  if (state.endgame.activeInfiniteResearchId === researchId) return state;
  const next = copyState(state);
  next.endgame.activeInfiniteResearchId = researchId;
  for (const entity of next.entities) {
    if (entity.recipeId === "matrix_research") entity.progress = 0;
  }
  return next;
}

export function setInfiniteResearchAutomation(state: GameState, enabled: boolean): GameState {
  if (state.endgame.autoResearch === enabled) return state;
  return { ...state, endgame: { ...state.endgame, autoResearch: enabled } };
}

export function setGalacticDispatchAutomation(state: GameState, enabled: boolean): GameState {
  if (state.endgame.autoDispatch === enabled) return state;
  return { ...state, endgame: { ...state.endgame, autoDispatch: enabled } };
}

export function setGalacticDispatchThrottle(state: GameState, throttle: GalacticDispatchThrottle): GameState {
  if (![0.25, 0.5, 1].includes(throttle) || state.endgame.dispatchThrottle === throttle) return state;
  return { ...state, endgame: { ...state.endgame, dispatchThrottle: throttle } };
}

export function setGalacticExportEnabled(state: GameState, projectId: GalacticExportProjectId, enabled: boolean): GameState {
  if (!state.endgame.exportProjects[projectId] || state.endgame.exportProjects[projectId].enabled === enabled) return state;
  return {
    ...state,
    endgame: {
      ...state.endgame,
      exportProjects: {
        ...state.endgame.exportProjects,
        [projectId]: { ...state.endgame.exportProjects[projectId], enabled },
      },
    },
  };
}

export function setGalacticExportPriority(state: GameState, projectId: GalacticExportProjectId, priority: LogisticsPriority): GameState {
  if (!state.endgame.exportProjects[projectId] || ![1, 2, 3].includes(priority)) return state;
  return {
    ...state,
    endgame: {
      ...state.endgame,
      exportProjects: {
        ...state.endgame.exportProjects,
        [projectId]: { ...state.endgame.exportProjects[projectId], priority },
      },
    },
  };
}

function networkItemStockForExport(state: GameState, itemId: ItemId): number {
  let total = 0;
  const trays = new Map<PlanetId, Partial<Record<ItemId, number>>>();
  for (const planet of PLANET_LIST) trays.set(planet.id, planet.id === state.activePlanetId ? state.tray : state.planetTrays[planet.id]);
  for (const tray of trays.values()) total += Math.floor(tray[itemId] ?? 0);
  for (const entity of state.entities) total += Math.floor(entity.outputs[itemId] ?? 0);
  return Math.max(0, total);
}

function withdrawNetworkItem(state: GameState, itemId: ItemId, amount: number): number {
  let remaining = Math.max(0, Math.floor(amount));
  let withdrawn = 0;
  // Clear machine and station output buffers first so a long-running export also relieves blockages.
  for (const entity of state.entities) {
    if (remaining < 1) break;
    const available = Math.max(0, Math.floor(entity.outputs[itemId] ?? 0));
    const taken = Math.min(remaining, available);
    if (taken < 1) continue;
    entity.outputs[itemId] = available - taken;
    remaining -= taken;
    withdrawn += taken;
  }
  for (const planet of PLANET_LIST) {
    if (remaining < 1) break;
    const tray = planet.id === state.activePlanetId ? state.tray : state.planetTrays[planet.id];
    const available = Math.max(0, Math.floor(tray[itemId] ?? 0));
    const taken = Math.min(remaining, available);
    if (taken < 1) continue;
    tray[itemId] = available - taken;
    remaining -= taken;
    withdrawn += taken;
  }
  state.planetTrays[state.activePlanetId] = { ...state.tray };
  return withdrawn;
}

function completeGalacticExportLevels(state: GameState, projectId: GalacticExportProjectId): void {
  const project = state.endgame.exportProjects[projectId];
  while (project.delivered >= getGalacticExportTarget(projectId, project.level)) {
    const target = getGalacticExportTarget(projectId, project.level);
    project.delivered -= target;
    project.level += 1;
    state.endgame.galacticCredits = Math.floor(state.endgame.galacticCredits + getGalacticExportReward(projectId, project.level - 1));
    state.endgame.galacticScore = Math.floor(state.endgame.galacticScore + getGalacticExportReward(projectId, project.level - 1));
  }
}

function recordGalacticExportDelivery(state: GameState, projectId: GalacticExportProjectId, amount: number, activityEligible: boolean): void {
  const shipped = Math.max(0, Math.floor(amount));
  if (shipped < 1) return;
  const project = state.endgame.exportProjects[projectId];
  const definition = getGalacticExportDefinition(projectId);
  project.delivered += shipped;
  project.totalDelivered += shipped;
  state.endgame.totalExported += shipped;
  state.endgame.exportWindowAmount += shipped;
  state.endgame.galacticCredits = Math.floor(state.endgame.galacticCredits + shipped * definition.creditsPerItem);
  state.endgame.galacticScore = Math.floor(state.endgame.galacticScore + shipped * definition.creditsPerItem);
  completeGalacticExportLevels(state, projectId);

  const activity = state.endgame.constructionActivity;
  const itemId = definition.itemId as import("./types").ActivityMaterialId;
  if (!activityEligible || !activity.activityId || !activity.participantId || !(itemId in ACTIVITY_PROJECT_BY_ITEM)) return;
  activity.personalDelivered[itemId] = Math.floor((activity.personalDelivered[itemId] ?? 0) + shipped);
  const existing = activity.pendingBatches[itemId];
  if (existing) {
    existing.amount = Math.floor(existing.amount + shipped);
    existing.lastDeliveredAtMs = activity.activityClockMs;
  } else {
    const sequence = activity.nextBatchSequence;
    activity.nextBatchSequence += 1;
    activity.pendingBatches[itemId] = {
      id: `${activity.activityId}:${activity.participantId}:${itemId}:${sequence}`,
      itemId,
      amount: shipped,
      sequence,
      firstDeliveredAtMs: activity.activityClockMs,
      lastDeliveredAtMs: activity.activityClockMs,
    };
  }
}

function dispatchGalacticExportInternal(state: GameState, projectId: GalacticExportProjectId, requested: number): number {
  if (!isEndgameUnlocked(state) || !state.endgame.exportProjects[projectId]) return 0;
  const project = state.endgame.exportProjects[projectId];
  const definition = getGalacticExportDefinition(projectId);
  const reserve = Math.floor(definition.reserve * (1 + project.level * 0.08));
  const available = Math.max(0, networkItemStockForExport(state, definition.itemId) - reserve);
  const shipped = withdrawNetworkItem(state, definition.itemId, Math.min(available, Math.max(0, Math.floor(requested))));
  if (shipped > 0) recordGalacticExportDelivery(state, projectId, shipped, false);
  return shipped;
}

function galacticActivityStepIsActive(state: GameState): boolean {
  const activity = state.endgame.constructionActivity;
  return Boolean(activity.activityId && activity.activityClockMs >= activity.startsAtMs && activity.activityClockMs < activity.endsAtMs);
}

function runGalacticMaterialExporters(state: GameState, powerByPlanet: Map<PlanetId, PowerPlan>, lookup?: SimulationLookupContext): void {
  const activityEligible = galacticActivityStepIsActive(state);
  for (const entity of lookup?.galacticExporters ?? state.entities.filter((candidate) => candidate.buildingId === "galactic_material_exporter")) {
    const plan = powerByPlanet.get(entity.planetId);
    const powerFactor = plan?.factorByEntity.get(entity.id) ?? plan?.factor ?? 0;
    entity.powerFactor = plan?.factorByEntity.has(entity.id) ? round(powerFactor, 4) : undefined;
    entity.productionRate = 0;
    entity.utilization = 0;
    if (!activityEligible || entity.galacticExporterPaused !== false || powerFactor <= EPSILON) continue;
    let delivered = 0;
    const ordered = [...ACTIVITY_MATERIAL_IDS]
      .sort((left, right) => state.endgame.exportProjects[ACTIVITY_PROJECT_BY_ITEM[right]].priority -
        state.endgame.exportProjects[ACTIVITY_PROJECT_BY_ITEM[left]].priority || left.localeCompare(right));
    for (const itemId of ordered) {
      const amount = Math.max(0, Math.floor(entity.inputs[itemId] ?? 0));
      if (amount < 1) continue;
      entity.inputs[itemId] = 0;
      recordGalacticExportDelivery(state, ACTIVITY_PROJECT_BY_ITEM[itemId], amount, activityEligible);
      delivered += amount;
    }
    entity.utilization = delivered > 0 ? powerFactor : 0;
    entity.productionRate = delivered * 60;
  }
}

export function dispatchGalacticExport(state: GameState, projectId: GalacticExportProjectId, amount?: number): GameState {
  if (!isEndgameUnlocked(state) || state.endgame.exportInputMode !== "legacy-network" || !state.endgame.exportProjects[projectId]) return state;
  const next = copyState(state);
  const definition = getGalacticExportDefinition(projectId);
  dispatchGalacticExportInternal(next, projectId, amount ?? definition.baseRatePerMinute);
  return next;
}

function runGalacticExports(state: GameState, seconds: number): void {
  if (!isEndgameUnlocked(state) || state.endgame.exportInputMode !== "legacy-network" || !state.endgame.autoDispatch || seconds <= EPSILON) return;
  const projects = GALACTIC_EXPORT_DEFINITIONS
    .map((definition) => state.endgame.exportProjects[definition.id])
    .filter((project) => project.enabled)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  for (const project of projects) {
    const definition = getGalacticExportDefinition(project.id);
    const level = state.endgame.infiniteResearch.galactic_logistics?.level ?? 0;
    const rate = definition.baseRatePerMinute * state.endgame.dispatchThrottle * (1 + level * 0.1);
    project.dispatchProgress = Math.min(rate * 2, Math.max(0, project.dispatchProgress) + rate * seconds / 60);
    const requested = Math.floor(project.dispatchProgress + EPSILON);
    if (requested < 1) continue;
    const shipped = dispatchGalacticExportInternal(state, project.id, requested);
    // Do not accumulate an unbounded backlog when a factory is starved.
    project.dispatchProgress = shipped >= requested ? project.dispatchProgress - requested : 0;
  }
}

export interface GalacticIndustrySnapshot {
  unlocked: boolean;
  totalProductionPerMinute: number;
  totalConsumptionPerMinute: number;
  netPerMinute: number;
  activePlanets: number;
  operatingEntities: number;
  blockedEntities: number;
  logisticsTrips: number;
  networkInventory: number;
  generationKw: number;
  demandKw: number;
  dysonGenerationKw: number;
  exportedPerMinute: number;
  totalExported: number;
  galacticCredits: number;
  galacticScore: number;
  infiniteResearchLevels: number;
}

export function getGalacticIndustrySnapshot(state: GameState): GalacticIndustrySnapshot {
  const endgame = state.endgame ?? createEndgameState();
  let production = 0;
  let consumption = 0;
  let operatingEntities = 0;
  let blockedEntities = 0;
  let logisticsTrips = 0;
  let networkInventory = 0;
  for (const entity of state.entities) {
    if (entity.productionRate > EPSILON) {
      production += entity.productionRate;
      operatingEntities += 1;
    } else if (entity.machineCount > 0 || entity.minerCount > 0) {
      blockedEntities += 1;
    }
    logisticsTrips += entity.stationTrips ?? 0;
    networkInventory += Object.values(entity.inputs).reduce((sum, amount) => sum + Math.floor(amount ?? 0), 0);
    networkInventory += Object.values(entity.outputs).reduce((sum, amount) => sum + Math.floor(amount ?? 0), 0);
    const recipe = getRecipe(entity.recipeId);
    if (recipe && entity.kind === "machine") {
      const outputUnits = recipe.outputs.reduce((sum, output) => sum + output.amount, 0) || 1;
      const cyclesPerMinute = entity.productionRate / outputUnits;
      consumption += recipe.inputs.reduce((sum, input) => sum + cyclesPerMinute * input.amount, 0);
    }
  }
  for (const planet of PLANET_LIST) {
    const tray = planet.id === state.activePlanetId ? state.tray : state.planetTrays[planet.id];
    networkInventory += Object.values(tray).reduce((sum, amount) => sum + Math.floor(amount ?? 0), 0);
  }
  const infiniteResearchLevels = Object.values(endgame.infiniteResearch).reduce((sum, progress) => sum + progress.level, 0);
  const generationKw = Object.values(state.planetMetrics).reduce((sum, metrics) => sum + metrics.generationKw, 0);
  const demandKw = Object.values(state.planetMetrics).reduce((sum, metrics) => sum + metrics.demandKw, 0);
  return {
    unlocked: isEndgameUnlocked(state),
    totalProductionPerMinute: round(production, 2),
    totalConsumptionPerMinute: round(consumption, 2),
    netPerMinute: round(production - consumption, 2),
    activePlanets: state.exploration.colonizedPlanetIds.length,
    operatingEntities,
    blockedEntities,
    logisticsTrips,
    networkInventory,
    generationKw: round(generationKw, 2),
    demandKw: round(demandKw, 2),
    dysonGenerationKw: round(state.dysonSwarm.generationKw + state.dysonSphere.generationKw, 2),
    exportedPerMinute: round(endgame.exportedLastMinute, 2),
    totalExported: Math.floor(endgame.totalExported),
    galacticCredits: Math.floor(endgame.galacticCredits),
    galacticScore: Math.floor(endgame.galacticScore),
    infiniteResearchLevels,
  };
}

export interface ResourceReserveSnapshot {
  infinite: boolean;
  exhausted: boolean;
  remaining: number | null;
  capacity: number | null;
  remainingRatio: number;
  remainingPercent: number;
}

export function getResourceReserveSnapshot(state: GameState, entity: FactoryEntity): ResourceReserveSnapshot | null {
  if (entity.kind !== "vein" || !entity.resourceId) return null;
  const infinite = isVeinInfiniteForState(state, entity);
  if (infinite) {
    return { infinite: true, exhausted: false, remaining: null, capacity: null, remainingRatio: 1, remainingPercent: 100 };
  }
  const remaining = Math.max(0, Math.floor(entity.resourceRemaining ?? 0));
  const capacity = Math.max(remaining, Math.floor(entity.resourceCapacity ?? remaining));
  const remainingRatio = capacity > 0 ? Math.max(0, Math.min(1, remaining / capacity)) : 0;
  return {
    infinite: false,
    exhausted: getFiniteVeinOutputAllowance(entity, getVeinConsumptionTenths(state, entity.resourceId)) < 1,
    remaining,
    capacity,
    remainingRatio,
    remainingPercent: Math.round(remainingRatio * 100),
  };
}

export function getEntityOperatingStatus(state: GameState, entity: FactoryEntity, lookup?: SimulationLookupContext): EntityOperatingStatus {
  if (state.paused) return { code: "paused", label: "模拟已暂停", tone: "idle" };
  const entityPowerFactor = getEntityPowerFactor(state, entity, lookup);

  if (entity.kind === "vein") {
    if (getResourceReserveSnapshot(state, entity)?.exhausted) {
      return { code: "resource-depleted", label: "资源已枯竭", tone: "blocked" };
    }
    if (entity.minerCount < 1) return {
      code: "idle",
      label: ITEMS[entity.resourceId!].kind === "fluid" ? `等待${extractorFor(entity).shortName}` : "可手动采集",
      tone: "idle",
    };
    const capacity = getEntityOutputCapacity(state, entity);
    if ((entity.outputs[entity.resourceId!] ?? 0) >= capacity - EPSILON) {
      return { code: "output-blocked", label: "输出缓存已满", tone: "blocked" };
    }
    if (entityPowerFactor <= EPSILON) return { code: "no-power", label: powerCoverageLabel(state, entity, lookup), tone: "blocked" };
    if (entityPowerFactor < 0.999) {
      return { code: "low-power", label: `供电不足 · ${Math.round(entityPowerFactor * 100)}%`, tone: "warning" };
    }
    return { code: "running", label: "采矿中", tone: "running" };
  }

  if (isFuelGenerator(entity)) {
    if (!entity.fuelItemId) return { code: "no-fuel-selected", label: "未选择燃料", tone: "blocked" };
    if (fuelEnergyAvailable(entity) <= EPSILON) return { code: "missing-fuel", label: `缺少${ITEMS[entity.fuelItemId].name}`, tone: "blocked" };
    if ((entity.powerOutputKw ?? 0) > EPSILON) {
      const label = entity.buildingId === "artificial_star" ? "反物质湮灭中" : entity.buildingId === "mini_fusion_power_plant" ? "聚变发电中" : "燃烧发电中";
      return { code: "running", label, tone: "running" };
    }
    return { code: "grid-standby", label: "电网暂无缺口", tone: "idle" };
  }

  if (entity.buildingId === "accumulator") {
    const stored = storedEnergy(entity);
    const capacity = energyCapacity(entity);
    if ((entity.powerInputKw ?? 0) > EPSILON) return { code: "running", label: "吸收富余电力", tone: "running" };
    if ((entity.powerOutputKw ?? 0) > EPSILON) return { code: "running", label: "补充电网缺口", tone: "running" };
    if (stored >= capacity - EPSILON) return { code: "grid-standby", label: "储能已满", tone: "idle" };
    if (stored <= EPSILON) return { code: "grid-standby", label: "储能已空", tone: "idle" };
    return { code: "grid-standby", label: "电网平衡待机", tone: "idle" };
  }

  if (entity.buildingId === "energy_exchanger") {
    const charging = entity.energyMode !== "discharge";
    const inputId: ItemId = charging ? "accumulator" : "charged_accumulator";
    const outputId: ItemId = charging ? "charged_accumulator" : "accumulator";
    if (itemOutputFree(state, entity, outputId) < 1) return { code: "output-blocked", label: `${ITEMS[outputId].name}输出已满`, tone: "blocked" };
    if ((entity.inputs[inputId] ?? 0) < 1 && storedEnergy(entity) <= EPSILON) {
      return { code: "missing-input", label: `等待${ITEMS[inputId].name}`, tone: "idle" };
    }
    if (charging && (entity.powerInputKw ?? 0) > EPSILON) return { code: "running", label: "蓄电器充电中", tone: "running" };
    if (!charging && (entity.powerOutputKw ?? 0) > EPSILON) return { code: "running", label: "蓄电器放电中", tone: "running" };
    return { code: "grid-standby", label: charging ? "等待电网富余" : "电网暂无缺口", tone: "idle" };
  }

  if (entity.kind === "power") return { code: "running", label: "持续发电", tone: "running" };

  if (entity.kind === "station") {
    if (entity.buildingId === "orbital_collector") {
      if (entity.quantumTransition) {
        return { code: "waiting-route", label: "等待传统航线尾货交接", tone: "idle" };
      }
      if (isQuantumCollector(entity)) {
        return state.quantumLogisticsNetwork.enabled
          ? { code: "running", label: "量子采集网络供应端", tone: "running" }
          : { code: "paused", label: "量子网络未启用", tone: "idle" };
      }
      const yields = getPlanetOrbitalYields(state, entity.planetId);
      const itemId = entity.storedItemId && (yields[entity.storedItemId] ?? 0) > 0
        ? entity.storedItemId
        : (Object.keys(yields)[0] as ItemId | undefined) ?? "hydrogen";
      const capacity = getEntityOutputCapacity(state, entity);
      if ((entity.outputs[itemId] ?? 0) >= capacity - EPSILON) {
        return { code: "output-blocked", label: `${ITEMS[itemId].name}储量已满`, tone: "blocked" };
      }
      return { code: "collecting", label: `轨道采集${ITEMS[itemId].name}中`, tone: "running" };
    }
    const slots = getStationSlots(entity);
    const configured = slots.map((slot, slotIndex) => ({ slot, slotIndex })).filter(({ slot }) => slot.itemId);
    if (configured.length === 0) return { code: "unconfigured", label: "未配置物流槽位", tone: "blocked" };
    const activeRoutes = stationActiveRoutes(state, entity, lookup).map(({ route }) => route);
    const activeLocalRoutes = activeRoutes.filter((route) => route.scope === "local");
    if (isQuantumStation(entity)) {
      if (!state.quantumLogisticsNetwork?.enabled) return { code: "paused", label: "量子网络未启用", tone: "idle" };
      const demand = configured.filter(({ slot }) => slot.remoteMode === "demand").length;
      const supply = configured.filter(({ slot }) => slot.remoteMode === "supply").length;
      return activeLocalRoutes.length > 0
        ? { code: "running", label: `量子共享池 · 运输机配送中 · ${activeLocalRoutes.length} 条在途`, tone: "running" }
        : { code: "running", label: `量子共享池 · 上传 ${supply} · 下载 ${demand} · 本地运输可用`, tone: "running" };
    }
    if (entity.quantumTransition) {
      const activeRemoteRoutes = activeRoutes.filter((route) => route.scope === "remote");
      return activeLocalRoutes.length > 0
        ? { code: "running", label: `量子交接中 · 运输机配送 ${activeLocalRoutes.length} 条在途`, tone: "running" }
        : { code: "waiting-route", label: `等待旧星际尾货 ${activeRemoteRoutes.length} 条 · 本地运输可用`, tone: "idle" };
    }
    if (activeRoutes.length > 0) {
      const lead = activeRoutes.reduce((best, route) => route.progress > best.progress ? route : best, activeRoutes[0]);
      return {
        code: "running",
        label: `${lead.scope === "local" ? "运输机配送" : "运输船航行"}中 · ${activeRoutes.length} 条在途`,
        tone: "running",
      };
    }
    const scopes: StationLogisticsScope[] = entity.buildingId === "interstellar_logistics_station"
      ? ["local", "remote"]
      : ["local"];
    let missingPeer = false;
    let waitingLoad = false;
    let outputBlocked = false;
    for (const { slot, slotIndex } of configured.sort((a, b) => b.slot.priority - a.slot.priority)) {
      for (const scope of scopes) {
        const mode = stationSlotMode(entity, slot, scope);
        if (mode === "storage") continue;
        const match = findStationSlotPeer(state, entity, slotIndex, scope, lookup);
        if (!match) {
          missingPeer = true;
          continue;
        }
        const demand = mode === "demand" ? entity : match.peer;
        const demandSlotIndex = demand.id === entity.id ? slotIndex : match.peerSlotIndex;
        const demandSlot = getStationSlots(demand)[demandSlotIndex];
        const supply = demand.id === entity.id ? match.peer : entity;
        const supplySlotIndex = demand.id === entity.id ? match.peerSlotIndex : slotIndex;
        const supplySlot = supply.buildingId === "orbital_collector"
          ? { ...emptyStationSlot(), itemId: supply.storedItemId }
          : getStationSlots(supply)[supplySlotIndex];
        const itemId = demandSlot.itemId!;
        const free = Math.floor(Math.max(0, getStationSlotCapacity(state, demand, demandSlot) -
          (demand.outputs[itemId] ?? 0) - stationInFlightCargo(demand, itemId, lookup)));
        const available = Math.floor(Math.max(0, (supply.outputs[itemId] ?? 0) - supplySlot.minStock -
          stationReservedOutgoing(state, supply.id, itemId, lookup)));
        const vehicleOwners = [demand, supply].filter((candidate, index, all) =>
          candidate.buildingId !== "orbital_collector" && all.findIndex((entry) => entry.id === candidate.id) === index);
        const availableOwners = vehicleOwners.filter((owner) => stationInstalledVehicles(owner, scope) - stationBusyVehicles(state, owner, scope, lookup) > 0);
        if (availableOwners.length === 0) {
          const installedVehicles = vehicleOwners.reduce((sum, owner) => sum + stationInstalledVehicles(owner, scope), 0);
          const busyVehicles = vehicleOwners.reduce((sum, owner) => sum + stationBusyVehicles(state, owner, scope, lookup), 0);
          if (installedVehicles > 0 && busyVehicles >= installedVehicles) {
            return {
              code: "fleet-busy",
              label: `${scope === "local" ? "运输机" : "运输船"}全部执行中 · 舰队容量瓶颈 ${busyVehicles}/${installedVehicles}`,
              tone: "warning",
            };
          }
          return scope === "local"
            ? { code: "missing-drone", label: "缺少可用物流运输机", tone: "blocked" }
            : { code: "missing-vessel", label: "缺少可用物流运输船", tone: "blocked" };
        }
        const requiresWarp = scope === "remote" && stationRouteRequiresWarp(demand, supply);
        const economics = requiresWarp ? getInterstellarRouteEconomics(state, supply, demand, 1, {
          routePolicy: demandSlot.routePolicy,
          warperBudget: demandSlot.warperBudget,
        }) : null;
        if (requiresWarp && !economics?.routeAvailable) {
          return { code: "missing-hub", label: "中转策略没有可用物流枢纽", tone: "blocked" };
        }
        const warpReadyOwners = requiresWarp
          ? availableOwners.filter((owner) => owner.stationWarpEnabled && (owner.stationWarpers ?? 0) >= (economics?.warpersPerVessel ?? 1))
          : availableOwners;
        if (requiresWarp && (!isTechnologyCompleted(state, "space_warp") || warpReadyOwners.length === 0)) {
          return { code: "missing-warper", label: `跨恒星航线需要 ${economics?.warpersPerVessel ?? 1} 个翘曲器/船`, tone: "blocked" };
        }
        const ownerLoads = warpReadyOwners.map((owner) => ({
          owner,
          minimumCargo: getStationMinimumCargo(state, owner, owner.id === demand.id ? demandSlotIndex : supplySlotIndex, scope),
        }));
        if (!ownerLoads.some(({ minimumCargo }) => free >= minimumCargo && available >= minimumCargo)) {
          outputBlocked ||= ownerLoads.every(({ minimumCargo }) => free < minimumCargo);
          waitingLoad ||= ownerLoads.some(({ minimumCargo }) => free >= minimumCargo && available < minimumCargo);
          continue;
        }
        const hubPower = economics?.waypointStationIds.reduce((factor, stationId) => {
          const station = lookup?.entityById.get(stationId) ?? state.entities.find((candidate) => candidate.id === stationId);
          return Math.min(factor, station ? getEntityPowerFactor(state, station, lookup) : 0);
        }, 1) ?? 1;
        const routePower = scope === "local"
          ? Math.max(...vehicleOwners.map((owner) => getEntityPowerFactor(state, owner, lookup)))
          : Math.min(entityPowerFactor, getEntityPowerFactor(state, match.peer, lookup), hubPower);
        if (routePower <= EPSILON) return { code: "no-power", label: "航线一侧电网断电", tone: "blocked" };
        if (routePower < 0.999) {
          return { code: "low-power", label: `航线供电不足 · ${Math.round(routePower * 100)}%`, tone: "warning" };
        }
        return { code: "running", label: `${scope === "local" ? "本地" : "星际"}调度队列就绪`, tone: "running" };
      }
    }
    if (waitingLoad) return { code: "waiting-load", label: "等待槽位达到最低启航货量", tone: "idle" };
    if (outputBlocked) return { code: "output-blocked", label: "需求槽位库存已达上限", tone: "blocked" };
    return { code: "missing-route", label: missingPeer ? "等待匹配供需槽位" : "槽位仅作仓储", tone: missingPeer ? "blocked" : "idle" };
  }

  if (entity.kind === "storage" || entity.kind === "splitter") {
    if (entity.buildingId === "material_delivery_hub") {
      const configured = getMaterialDeliveryItems(entity);
      if (configured.length === 0) return { code: "unconfigured", label: "等待连接输入线路", tone: "idle" };
      const fullItemId = configured.find((itemId) => getPlanetTrayItemFreeCapacity(state, entity.planetId, itemId) < 1);
      if (fullItemId) {
        const current = Math.max(0, Math.floor(trayForPlanet(state, entity.planetId)[fullItemId] ?? 0));
        return { code: "output-blocked", label: `${ITEMS[fullItemId].name}托盘已达上限 · ${current}/${getPlanetTrayItemLimit(state, entity.planetId)}`, tone: "blocked" };
      }
      const flowing = (lookup?.incomingBeltsByTarget.get(entity.id) ?? state.belts)
        .some((belt) => belt.target === entity.id && belt.lastFlow > 0.001);
      return flowing
        ? { code: "running", label: "物资直送托盘中", tone: "running" }
        : { code: "missing-input", label: `等待物料 · ${configured.length}/${MATERIAL_DELIVERY_SLOT_COUNT} 接口`, tone: "idle" };
    }
    if (!entity.storedItemId) return { code: "unconfigured", label: "未选择物流物品", tone: "blocked" };
    const flowing = lookup
      ? (lookup.outgoingBeltsBySource.get(entity.id)?.some((belt) => belt.lastFlow > 0.001) ?? false) ||
        (lookup.incomingBeltsByTarget.get(entity.id)?.some((belt) => belt.lastFlow > 0.001) ?? false)
      : state.belts.some((belt) => (belt.source === entity.id || belt.target === entity.id) && belt.lastFlow > 0.001);
    if (flowing) return { code: "running", label: "物流运行中", tone: "running" };
    const buffered = (entity.inputs[entity.storedItemId] ?? 0) + (entity.outputs[entity.storedItemId] ?? 0);
    return buffered > 0
      ? { code: "idle", label: "等待下游取货", tone: "idle" }
      : { code: "missing-input", label: "等待物料", tone: "idle" };
  }

  if (entity.buildingId === "micro_black_hole_connector") {
    if (entity.blackHolePaused !== false) return { code: "paused", label: "微型黑洞已暂停", tone: "idle" };
    if (!entity.blackHoleActivationConfirmed) return { code: "paused", label: "等待二次确认启动", tone: "warning" };
    const connected = (lookup?.incomingBeltsByTarget.get(entity.id) ?? state.belts)
      .filter((belt) => belt.target === entity.id && belt.targetPortIndex !== undefined).length;
    return connected > 0
      ? { code: "running", label: `销毁通道运行中 · ${connected}/3`, tone: "running" }
      : { code: "missing-input", label: "等待连接物资输入", tone: "idle" };
  }

  if (entity.buildingId === "time_warp_device") {
    if (state.timeWarp.controllerEntityId !== entity.id) return { code: "grid-standby", label: "非主控装置", tone: "idle" };
    if (!state.timeWarp.enabled) return { code: "paused", label: "时间扭曲已暂停", tone: "idle" };
    if (state.timeWarp.effectiveMultiplier <= state.settings.simulationSpeed) {
      return { code: "no-power", label: `供电不足 · 请求 ${state.timeWarp.requestedMultiplier}x`, tone: "blocked" };
    }
    if (state.timeWarp.effectiveMultiplier < state.timeWarp.requestedMultiplier) {
      return { code: "low-power", label: `自动降档至 ${state.timeWarp.effectiveMultiplier}x`, tone: "warning" };
    }
    return { code: "running", label: `全局模拟 ${state.timeWarp.effectiveMultiplier}x`, tone: "running" };
  }

  if (entity.buildingId === "galactic_material_exporter") {
    if (entity.galacticExporterPaused !== false) return { code: "paused", label: "银河物资出口已暂停", tone: "idle" };
    const buffered = (Object.keys(ACTIVITY_PROJECT_BY_ITEM) as ItemId[]).reduce((sum, itemId) => sum + Math.max(0, entity.inputs[itemId] ?? 0), 0);
    if (buffered < 1) return { code: "missing-input", label: "等待四类银河工程物资", tone: "idle" };
    if (entityPowerFactor <= EPSILON) return { code: "no-power", label: powerCoverageLabel(state, entity, lookup), tone: "blocked" };
    if (entityPowerFactor < 0.999) return { code: "low-power", label: `供电不足 · ${Math.round(entityPowerFactor * 100)}%`, tone: "warning" };
    return { code: "running", label: "银河物资交付中", tone: "running" };
  }

  if (entity.buildingId === "construction_center") {
    if (!state.constructionAutomation.enabled) return { code: "paused", label: "自动制造已关闭", tone: "idle" };
    if (!constructionAutomationHasDeficit(state)) return { code: "grid-standby", label: "目标库存已满足", tone: "idle" };
    if (entityPowerFactor <= EPSILON) return { code: "no-power", label: powerCoverageLabel(state, entity, lookup), tone: "blocked" };
    const automation = getConstructionAutomationStatus(state, entity.id);
    if (automation.missingItemId) {
      const reason = automation.blockerReason === "technology"
        ? `需要科技：${automation.technologyName ?? "未解锁"}`
        : automation.blockerReason === "no-handcraft"
          ? `${ITEMS[automation.missingItemId].name}没有可用手工配方`
          : `缺少${ITEMS[automation.missingItemId].name} ×${automation.missingAmount ?? 1}`;
      return { code: "missing-input", label: reason, tone: "blocked" };
    }
    if (entityPowerFactor < 0.999) return { code: "low-power", label: `供电不足 · ${Math.round(entityPowerFactor * 100)}%`, tone: "warning" };
    return { code: "running", label: automation.stage, tone: "running" };
  }

  const recipe = getRecipe(entity.recipeId);
  if (!recipe) return { code: "missing-recipe", label: "未选择配方", tone: "blocked" };
  if (recipe.requiredTechId && !isTechnologyCompleted(state, recipe.requiredTechId)) {
    return { code: "missing-recipe", label: "配方科技未解锁", tone: "blocked" };
  }
  if (recipe.id === "matrix_research" && !hasActiveResearch(state)) {
    return { code: "missing-research", label: "未选择研究科技", tone: "blocked" };
  }
  if ((recipe.id === "solar_sail_launch" || recipe.id === "carrier_rocket_launch") &&
    dysonLaunchFactor(state, recipe.id) <= EPSILON) {
    return { code: "launch-paused", label: "戴森发射调度已暂停", tone: "idle" };
  }
  if (recipe.id === "solar_sail_launch") {
    const target = getEjectorOrbitTargetStatus(state, entity);
    if (!target.valid) {
      const label = target.reason === "foreign-system"
        ? "目标太阳帆轨道不属于当前恒星系"
        : target.reason === "missing-orbit"
          ? "目标太阳帆轨道已删除或失效"
          : "未指定太阳帆目标轨道";
      return { code: "missing-dyson-orbit", label, tone: "blocked" };
    }
  }

  if (entity.buildingId === "ray_receiver") {
    const capacity = getEntityOutputCapacity(state, entity);
    const blocked = recipe.outputs.some((output) =>
      capacity - (entity.outputs[output.itemId] ?? 0) + EPSILON < output.amount);
    if (blocked) return { code: "output-blocked", label: "临界光子缓存已满", tone: "blocked" };
    const ratedKw = getRayReceiverCapacityKw(state) * entity.machineCount;
    const receivedKw = Math.max(0, entity.powerOutputKw ?? 0);
    if (totalDysonGenerationKw(state) <= EPSILON || receivedKw <= EPSILON) {
      return { code: "missing-dyson-swarm", label: "等待戴森系统能量", tone: "blocked" };
    }
    const reception = ratedKw > EPSILON ? receivedKw / ratedKw : 0;
    if (reception < 0.999) {
      return { code: "low-power", label: `戴森云接收率 · ${Math.round(reception * 100)}%`, tone: "warning" };
    }
    return recipe.id === "ray_power"
      ? { code: "running", label: `向电网输出 ${formatPowerKw(receivedKw)}`, tone: "running" }
      : { code: "running", label: "临界光子生成中", tone: "running" };
  }

  if (entity.buildingId) {
    const capacity = getEntityOutputCapacity(state, entity);
    const extraProductBonus = availableFullProliferatorCycles(entity, recipe) > 0 ? getEntityExtraProductBonus(entity) : 0;
    const blocked = recipe.outputs.filter((output) => {
      const bonus = Math.floor((entity.proliferatorBonusProgress?.[output.itemId] ?? 0) +
        output.amount * extraProductBonus + EPSILON);
      return capacity - (entity.outputs[output.itemId] ?? 0) + EPSILON < output.amount + bonus;
    });
    if (blocked.length > 0) {
      return { code: "output-blocked", label: `输出堵塞：${blocked.map((output) => ITEMS[output.itemId].name).join("、")}`, tone: "blocked" };
    }
  }

  const requirements = recipe.id === "matrix_research"
    ? remainingResearchCosts(state).map((cost) => ({ itemId: cost.itemId, amount: 1 }))
    : recipe.inputs;
  const missing = requirements.filter((input) => (entity.inputs[input.itemId] ?? 0) + EPSILON < input.amount);
  if (missing.length > 0) {
    return { code: "missing-input", label: `缺少${missing.map((input) => ITEMS[input.itemId].name).join("、")}`, tone: "blocked" };
  }

  if (entityPowerFactor <= EPSILON) return { code: "no-power", label: powerCoverageLabel(state, entity, lookup), tone: "blocked" };
  if (entityPowerFactor < 0.999) {
    return { code: "low-power", label: `供电不足 · ${Math.round(entityPowerFactor * 100)}%`, tone: "warning" };
  }
  if (proliferatorApplies(entity, recipe) && availableFullProliferatorCycles(entity, recipe) < 1) {
    const itemId = getEntityProliferatorItemId(entity)!;
    return { code: "missing-proliferator", label: `${ITEMS[itemId].name}耗尽，按基础倍率运行`, tone: "warning" };
  }

  return { code: "running", label: "运行中", tone: "running" };
}

export function getAcceptedInputs(entity: FactoryEntity, state?: GameState): ItemId[] {
  if (entity.buildingId === "galactic_material_exporter") {
    return [...ACTIVITY_MATERIAL_IDS];
  }
  if (entity.buildingId === "micro_black_hole_connector") return Object.keys(ITEMS) as ItemId[];
  if (entity.buildingId === "material_delivery_hub") return getMaterialDeliveryItems(entity);
  if (entity.kind === "station" && entity.buildingId !== "orbital_collector") {
    return getStationSlots(entity).flatMap((slot) => slot.itemId ? [slot.itemId] : []);
  }
  if ((entity.kind === "storage" || entity.kind === "splitter" || entity.kind === "station") && entity.storedItemId) return [entity.storedItemId];
  if (entity.buildingId === "thermal_power_plant" && entity.fuelItemId) return [entity.fuelItemId];
  if (entity.recipeId === "matrix_research" && state) {
    const proliferatorItemId = entity.sprayCoaterInstalled ? getEntityProliferatorItemId(entity) : undefined;
    return proliferatorItemId ? [...MATRIX_ITEM_IDS, proliferatorItemId] : [...MATRIX_ITEM_IDS];
  }
  const recipeInputs = getRecipe(entity.recipeId)?.inputs.map((input) => input.itemId) ?? [];
  const proliferatorItemId = entity.sprayCoaterInstalled ? getEntityProliferatorItemId(entity) : undefined;
  return proliferatorItemId ? [...recipeInputs, proliferatorItemId] : recipeInputs;
}

export function getProducedOutputs(entity: FactoryEntity): ItemId[] {
  if (entity.buildingId === "material_delivery_hub" || entity.buildingId === "construction_center" ||
    entity.buildingId === "galactic_material_exporter" || entity.buildingId === "micro_black_hole_connector" ||
    entity.buildingId === "time_warp_device") return [];
  if (entity.kind === "vein" && entity.resourceId) return [entity.resourceId];
  if (entity.kind === "station" && entity.buildingId !== "orbital_collector") {
    return getStationSlots(entity).flatMap((slot) => slot.itemId ? [slot.itemId] : []);
  }
  if ((entity.kind === "storage" || entity.kind === "splitter" || entity.kind === "station") && entity.storedItemId) return [entity.storedItemId];
  return getRecipe(entity.recipeId)?.outputs.map((output) => output.itemId) ?? [];
}
