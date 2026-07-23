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
  specializationApplies,
} from "./galaxy";
import type {
  BeltTier,
  BeltRouteMode,
  BeltConnection,
  BlueprintDefinition,
  BlueprintMirror,
  BlueprintRotation,
  BuildingId,
  CanvasRegion,
  CargoStackSize,
  ConstructionId,
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

const BELT_CAPACITY_PER_SECOND: Record<BeltTier, number> = { 1: 6, 2: 12, 3: 30 };
export const ACCUMULATOR_ENERGY_MJ = 90;
export const SOLAR_SAIL_POWER_KW = 36;
export const SOLAR_SAIL_LIFETIME_SECONDS = 1200;
export const RAY_RECEIVER_CAPACITY_KW = 6000;
export const DYSON_STRUCTURE_POWER_KW = 960;
export const DYSON_SHELL_SAIL_POWER_KW = 36;
export const DYSON_SHELL_CAPACITY_PER_STRUCTURE = 20;
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
export const POWER_GRID_IDS: PowerGridId[] = ["grid-a", "grid-b", "grid-c"];
export const POWER_GRID_LABELS: Record<PowerGridId, string> = {
  "grid-a": "A 主网",
  "grid-b": "B 工业网",
  "grid-c": "C 备用网",
};
/** Zero represents an unlimited, planet-wide grid domain. */
export const POWER_SUPPLY_RADIUS = 0;
export const MATERIAL_DELIVERY_SLOT_COUNT = 3;
export const MIN_PLANET_TRAY_ITEM_LIMIT = 1_000;
export const MAX_PLANET_TRAY_ITEM_LIMIT = 1_000_000;
export const DEFAULT_PLANET_TRAY_ITEM_LIMIT = MAX_PLANET_TRAY_ITEM_LIMIT;
export const MIN_CANVAS_REGION_SIZE = 40;
const EPSILON = 0.0001;

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function isPortableFleetItem(itemId: ItemId): itemId is PortableFleetItemId {
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
      stationRoutes: entity.stationRoutes?.map((route) => ({
        ...route,
        waypointStationIds: route.waypointStationIds ? [...route.waypointStationIds] : [],
      })),
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
      jobs: Object.fromEntries(Object.entries(state.constructionAutomation.jobs).map(([entityId, job]) => [
        entityId,
        { ...job, steps: job.steps.map((step) => ({ ...step })) },
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
      })),
      belts: blueprint.belts.map((belt) => ({ ...belt })),
      externalPorts: blueprint.externalPorts?.map((port) => ({ ...port, offset: { ...port.offset } })),
      recipeOverrides: { ...blueprint.recipeOverrides },
    })),
    constructionQueue: state.constructionQueue.map((entry) => ({ ...entry, position: { ...entry.position } })),
    handcraftQueue: state.handcraftQueue.map((entry) => ({ ...entry })),
    productionPlans: state.productionPlans.map((plan) => ({ ...plan, recipeSelections: { ...plan.recipeSelections } })),
    productionHistory: state.productionHistory.map((sample) => ({
      ...sample,
      productionPerMinute: { ...sample.productionPerMinute },
      consumptionPerMinute: { ...sample.consumptionPerMinute },
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
    },
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
    version: 31,
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
    },
    constructionAutomation: {
      enabled: true,
      targetStock: {},
      cursor: 0,
      totalCrafted: 0,
      lastCraftedId: null,
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
      autosaveIntervalSeconds: 30,
      resourceMode: "finite",
      difficulty: "standard",
    },
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
    constructionQueue: [],
    handcraftQueue: [],
    productionPlans: [],
    productionHistory: [],
    historyRecordedAt: 0,
    elapsedSeconds: 0,
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
    endgame: createEndgameState(),
    paused: false,
  };
}

export function createPlayerInitialState(): GameState {
  return createInitialState(createPlayerGalaxySeed(), false);
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
  const progress = state.endgame.infiniteResearch[infiniteId] ?? { level: 0, progress: 0 };
  const amount = Math.max(0, getInfiniteResearchCost(infiniteId, progress.level) - progress.progress);
  return amount > 0 ? [{ itemId: "universe_matrix", amount }] : [];
}

function hasActiveResearch(state: GameState): boolean {
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
  return base * (1 + getInfiniteResearchLevel(state, "vein_utilization") * 0.1) * difficulty.miningMultiplier;
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

export function getInterstellarRouteEconomics(
  state: GameState,
  source: FactoryEntity,
  target: FactoryEntity,
  vehicleCount = 1,
  options: InterstellarRouteOptions = {},
): InterstellarRouteEconomics {
  const sourcePlanet = getPlanet(source.planetId);
  const targetPlanet = getPlanet(target.planetId);
  const requiresWarp = sourcePlanet.systemId !== targetPlanet.systemId;
  const routePolicy = options.routePolicy ?? "relay-preferred";
  const warperBudget = Math.max(1, Math.min(4, Math.floor(options.warperBudget ?? 2)));
  const path = requiresWarp ? planInterstellarPath(state, source, target, routePolicy, warperBudget) : null;
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
    const station = state.entities.find((entity) => entity.id === stationId);
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

function getDysonPowerMultiplier(state: GameState): number {
  return 1 + getInfiniteResearchLevel(state, "stellar_harnessing") * 0.05;
}

function getSolarSailPowerFor(state: GameState, systemId: StarSystemId): number {
  return SOLAR_SAIL_POWER_KW * getDysonPowerMultiplier(state) * getStarLuminosity(state, systemId);
}

function proliferatorApplies(entity: FactoryEntity, recipe: RecipeDefinition | undefined): boolean {
  return Boolean(entity.sprayCoaterInstalled && entity.proliferatorTier && entity.proliferatorMode &&
    entity.proliferatorMode !== "normal" && recipe && recipe.inputs.length > 0 && recipe.outputs.length > 0);
}

export function isProliferatorEligible(entity: FactoryEntity): boolean {
  const recipe = getRecipe(entity.recipeId);
  return entity.kind === "machine" && entity.buildingId !== "spray_coater" && Boolean(recipe?.inputs.length && recipe.outputs.length);
}

export function getEntityProliferatorItemId(entity: FactoryEntity): ItemId | undefined {
  return entity.proliferatorTier ? getProliferator(entity.proliferatorTier).itemId : undefined;
}

export function getEntityProliferatorSpeedMultiplier(entity: FactoryEntity): number {
  const recipe = getRecipe(entity.recipeId);
  if (!proliferatorApplies(entity, recipe) || entity.proliferatorMode !== "speed") return 1;
  return 1 + getProliferator(entity.proliferatorTier!).speedBonus;
}

export function getEntityProliferatorPowerMultiplier(entity: FactoryEntity): number {
  const recipe = getRecipe(entity.recipeId);
  return proliferatorApplies(entity, recipe) ? getProliferator(entity.proliferatorTier!).powerMultiplier : 1;
}

export function getEntityExtraProductBonus(entity: FactoryEntity): number {
  const recipe = getRecipe(entity.recipeId);
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

function availableProliferatorCycles(entity: FactoryEntity, recipe: RecipeDefinition): number {
  if (!proliferatorApplies(entity, recipe)) return Number.POSITIVE_INFINITY;
  return availableProliferatorPoints(entity) / getProliferatorSprayCost(recipe);
}

function availableInputCycles(state: GameState, entity: FactoryEntity): number {
  const recipe = getRecipe(entity.recipeId);
  if (!recipe) return 0;
  if (recipe.id === "matrix_research") {
    return remainingResearchCosts(state).reduce((available, cost) =>
      available + Math.min(cost.amount, Math.floor((entity.inputs[cost.itemId] ?? 0) + EPSILON)), 0);
  }
  return recipe.inputs.reduce((available, input) =>
    Math.min(available, (entity.inputs[input.itemId] ?? 0) / input.amount), Number.POSITIVE_INFINITY);
}

function availableOutputCycles(entity: FactoryEntity): number {
  const recipe = getRecipe(entity.recipeId);
  if (!recipe || !entity.buildingId) return 0;
  const capacity = getEntityOutputCapacity(entity);
  const extraProductBonus = getEntityExtraProductBonus(entity);
  return recipe.outputs.reduce((available, output) => {
    const free = Math.floor(Math.max(0, capacity - (entity.outputs[output.itemId] ?? 0)) + EPSILON);
    let low = 0;
    let high = Math.floor(free / output.amount);
    const bonusProgress = entity.proliferatorBonusProgress?.[output.itemId] ?? 0;
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      const bonus = Math.floor(bonusProgress + output.amount * candidate * extraProductBonus + EPSILON);
      if (output.amount * candidate + bonus <= free) low = candidate;
      else high = candidate - 1;
    }
    return Math.min(available, low);
  }, Number.POSITIVE_INFINITY);
}

function canMachineRun(state: GameState, entity: FactoryEntity): boolean {
  if (entity.recipeId === "matrix_research" && !hasActiveResearch(state)) return false;
  const recipe = getRecipe(entity.recipeId);
  if (recipe?.requiredTechId && !isTechnologyCompleted(state, recipe.requiredTechId)) return false;
  if (proliferatorApplies(entity, recipe)) {
    const definition = getProliferator(entity.proliferatorTier!);
    if (!isTechnologyCompleted(state, definition.requiredTechId) ||
      Math.floor(availableProliferatorCycles(entity, recipe!) + EPSILON) < 1) return false;
  }
  return entity.kind === "machine" && Boolean(recipe) &&
    Math.floor(availableInputCycles(state, entity) + EPSILON) >= 1 &&
    Math.floor(availableOutputCycles(entity) + EPSILON) >= 1;
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

export function getEntityPowerFactor(state: GameState, entity: FactoryEntity): number {
  if (!isEntityInPowerCoverage(state, entity)) return 0;
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

export const MAX_STACKED_ENTITY_BUFFER = 1_000_000;

function stackedEntityCapacity(baseCapacity: number, machineCount: number): number {
  return Math.min(MAX_STACKED_ENTITY_BUFFER,
    Math.max(0, Math.floor(baseCapacity)) * Math.max(1, Math.floor(machineCount)));
}

export function getEntityInputCapacity(entity: FactoryEntity): number {
  return entity.buildingId
    ? stackedEntityCapacity(getBuilding(entity.buildingId).inputCapacity, entity.machineCount)
    : 0;
}

export function getEntityOutputCapacity(entity: FactoryEntity): number {
  return entity.buildingId
    ? stackedEntityCapacity(getBuilding(entity.buildingId).outputCapacity, entity.machineCount)
    : 0;
}

export function getStationSlotCapacity(station: FactoryEntity, slot: StationSlot): number {
  if (!station.buildingId) return 0;
  const rated = getEntityOutputCapacity(station);
  return slot.maxStock > 0 ? Math.min(rated, slot.maxStock) : rated;
}

function stationSlotMode(station: FactoryEntity, slot: StationSlot, scope: StationLogisticsScope): StationLogisticsMode {
  if (station.buildingId === "orbital_collector") return scope === "remote" ? "supply" : "storage";
  return scope === "local" ? slot.localMode : slot.remoteMode;
}

interface StationPeerMatch {
  peer: FactoryEntity;
  peerSlotIndex: number;
}

export function findStationSlotPeer(
  state: GameState,
  station: FactoryEntity,
  slotIndex: number,
  scope: StationLogisticsScope,
): StationPeerMatch | undefined {
  const slot = getStationSlots(station)[slotIndex];
  if (!slot?.itemId) return undefined;
  const mode = stationSlotMode(station, slot, scope);
  if (mode === "storage") return undefined;
  if (scope === "local" && station.buildingId === "orbital_collector") return undefined;
  if (scope === "remote" && station.buildingId !== "interstellar_logistics_station" && station.buildingId !== "orbital_collector") return undefined;
  const opposite: StationLogisticsMode = mode === "supply" ? "demand" : "supply";
  const candidates: Array<StationPeerMatch & { priority: number; routeAvailable: boolean; routeDuration: number }> = [];
  for (const peer of state.entities) {
    if (peer.id === station.id || peer.kind !== "station") continue;
    if (scope === "local") {
      if (peer.planetId !== station.planetId || peer.buildingId === "orbital_collector") continue;
    } else {
      if (peer.planetId === station.planetId ||
        (peer.buildingId !== "interstellar_logistics_station" && peer.buildingId !== "orbital_collector") ||
        !isStarSystemUnlocked(state, getPlanet(peer.planetId).systemId)) continue;
    }
    const peerSlots = peer.buildingId === "orbital_collector"
      ? [{
        itemId: peer.storedItemId,
        localMode: "storage" as const,
        remoteMode: "supply" as const,
        minimumLoad: 1 as const,
        minStock: 0,
        maxStock: 0,
        priority: 1 as const,
        routePolicy: "direct" as const,
        warperBudget: 1,
      }]
      : getStationSlots(peer);
    peerSlots.forEach((peerSlot, peerSlotIndex) => {
      if (peerSlot.itemId === slot.itemId && stationSlotMode(peer, peerSlot, scope) === opposite) {
        const demand = mode === "demand" ? station : peer;
        const supply = mode === "demand" ? peer : station;
        const demandSlot = mode === "demand" ? slot : peerSlot;
        const economics = scope === "remote" ? getInterstellarRouteEconomics(state, supply, demand, 1, {
          routePolicy: demandSlot.routePolicy,
          warperBudget: demandSlot.warperBudget,
        }) : null;
        candidates.push({
          peer,
          peerSlotIndex,
          priority: peerSlot.priority,
          routeAvailable: economics?.routeAvailable ?? true,
          routeDuration: economics?.durationSeconds ?? 0,
        });
      }
    });
  }
  return candidates.sort((a, b) => Number(b.routeAvailable) - Number(a.routeAvailable) || b.priority - a.priority ||
    a.routeDuration - b.routeDuration || a.peer.id.localeCompare(b.peer.id))[0];
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
  const capacity = getEntityOutputCapacity(demand);
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
  const capacity = getEntityOutputCapacity(demand);
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

function stationRouteReady(state: GameState, station: FactoryEntity): boolean {
  if (station.buildingId === "orbital_collector") return false;
  if (stationActiveRoutes(state, station).length > 0) return true;
  const scopes: StationLogisticsScope[] = station.buildingId === "interstellar_logistics_station"
    ? ["local", "remote"]
    : ["local"];
  const slots = getStationSlots(station);
  for (const scope of scopes) {
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const slot = slots[slotIndex];
      if (!slot.itemId || stationSlotMode(station, slot, scope) === "storage") continue;
      const match = findStationSlotPeer(state, station, slotIndex, scope);
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
      const minimumCargo = getStationMinimumCargo(state, demand, demandSlotIndex, scope);
      const available = Math.floor(Math.max(0, (supply.outputs[itemId] ?? 0) - supplySlot.minStock));
      const free = Math.floor(Math.max(0, getStationSlotCapacity(demand, demandSlot) -
        (demand.outputs[itemId] ?? 0) - stationInFlightCargo(demand, itemId)));
      const vehicleOwners = [demand, supply].filter((candidate, index, all) =>
        candidate.buildingId !== "orbital_collector" && all.findIndex((entry) => entry.id === candidate.id) === index);
      const vehicles = vehicleOwners.reduce((sum, owner) => sum + Math.max(0,
        stationInstalledVehicles(owner, scope) - stationBusyVehicles(state, owner, scope)), 0);
      const requiresWarp = scope === "remote" && stationRouteRequiresWarp(demand, supply);
      const economics = requiresWarp ? getInterstellarRouteEconomics(state, supply, demand, 1, {
        routePolicy: demandSlot.routePolicy,
        warperBudget: demandSlot.warperBudget,
      }) : null;
      const warpReady = !requiresWarp || (Boolean(economics?.routeAvailable) && isTechnologyCompleted(state, "space_warp") &&
        vehicleOwners.some((owner) => owner.stationWarpEnabled && (owner.stationWarpers ?? 0) >= (economics?.warpersPerVessel ?? 1)));
      if (vehicles > 0 && warpReady && available >= minimumCargo && free >= minimumCargo) return true;
    }
  }
  return false;
}

interface PowerPlan {
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

interface DysonReceptionPlan {
  efficiency: number;
  receiverLoadKw: number;
  allocationByEntity: Map<string, number>;
  efficiencyByEntity: Map<string, number>;
  rayPowerByPlanet: Map<PlanetId, number>;
}

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
  let structureBudget = Math.max(0, Math.floor(plan.structurePoints));
  plan.structurePoints = structureBudget;
  for (const layer of plan.layers) {
    for (const node of layer.nodes) {
      node.requiredStructurePoints = Math.max(1, Math.floor(node.requiredStructurePoints));
      node.completedStructurePoints = Math.min(node.requiredStructurePoints, structureBudget);
      structureBudget -= node.completedStructurePoints;
    }
    for (const frame of layer.frames) {
      frame.requiredStructurePoints = Math.max(1, Math.floor(frame.requiredStructurePoints));
      frame.completedStructurePoints = Math.min(frame.requiredStructurePoints, structureBudget);
      structureBudget -= frame.completedStructurePoints;
    }
  }
  let sailBudget = Math.max(0, Math.floor(plan.shellSails));
  plan.shellSails = sailBudget;
  for (const layer of plan.layers) {
    for (const shell of layer.shells) {
      shell.sailCapacity = Math.max(1, Math.floor(shell.sailCapacity));
      shell.absorbedSails = dysonShellActive(layer, shell) ? Math.min(shell.sailCapacity, sailBudget) : 0;
      sailBudget -= shell.absorbedSails;
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
    .filter((entity) => entity.recipeId === recipeId)
    .reduce((sum, entity) => {
      const recipe = getRecipe(recipeId)!;
      return sum + getBuilding(entity.buildingId!).speed * entity.machineCount / recipe.duration * 60 * launchFactorFor(recipeId);
    }, 0);
  const sailLaunchesPerMinute = round(nominalRate("solar_sail_launch"), 2);
  const rocketLaunchesPerMinute = round(nominalRate("carrier_rocket_launch"), 2);
  const receiverEntities = entities.filter((entity) => entity.buildingId === "ray_receiver" &&
    (entity.recipeId === "ray_power" || entity.recipeId === "critical_photon"));
  const receiverCapacityKw = receiverEntities.reduce((sum, entity) => sum + getRayReceiverCapacityKw(state) * entity.machineCount, 0);
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
    receiverLoadKw,
    rayEfficiency: receiverCapacityKw > EPSILON ? round(Math.min(1, receiverLoadKw / receiverCapacityKw), 4) : 0,
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

function launchDysonStructure(state: GameState, systemId: StarSystemId, amount: number): void {
  syncLegacySphereIntoPlans(state);
  state.dysonPlans[systemId].structurePoints += Math.max(0, Math.floor(amount));
  state.dysonSphere.totalRocketsLaunched = Math.floor(state.dysonSphere.totalRocketsLaunched + amount);
  reconcileDysonPlan(state.dysonPlans[systemId]);
  updateDysonSphereGeneration(state);
}

function launchDysonSails(state: GameState, systemId: StarSystemId, amount: number): void {
  if (amount <= 0) return;
  syncLegacySwarmIntoOrbits(state);
  const orbit = ensureDysonOrbit(state, systemId);
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

function calculateDysonReception(state: GameState): DysonReceptionPlan {
  const receivers = state.entities.filter((entity) =>
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
    generationBySystem.set(systemId, dysonGenerationForSystem(state, systemId));
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

function itemOutputFree(entity: FactoryEntity, itemId: ItemId): number {
  if (!entity.buildingId) return 0;
  const capacity = getEntityOutputCapacity(entity);
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

function exchangerDischargeCapacityForStep(entity: FactoryEntity, seconds: number): number {
  if (entity.buildingId !== "energy_exchanger" || entity.energyMode !== "discharge" || seconds <= EPSILON) return 0;
  const activeEnergy = storedEnergy(entity);
  const activeCells = activeEnergy > EPSILON ? 1 : 0;
  const queuedCells = Math.floor((entity.inputs.charged_accumulator ?? 0) + EPSILON);
  const usableCells = Math.min(activeCells + queuedCells, itemOutputFree(entity, "accumulator"));
  const availableEnergyMj = usableCells > 0
    ? activeEnergy + Math.max(0, usableCells - activeCells) * ACCUMULATOR_ENERGY_MJ
    : 0;
  const rated = (getBuilding("energy_exchanger").powerGenerationKw ?? 0) * entity.machineCount;
  return Math.min(rated, availableEnergyMj * 1000 / seconds);
}

function exchangerChargeCapacityForStep(entity: FactoryEntity, seconds: number): number {
  if (entity.buildingId !== "energy_exchanger" || entity.energyMode !== "charge" || seconds <= EPSILON) return 0;
  const activeEnergy = storedEnergy(entity);
  const activeCells = activeEnergy > EPSILON ? 1 : 0;
  const queuedCells = Math.floor((entity.inputs.accumulator ?? 0) + EPSILON);
  const usableCells = Math.min(activeCells + queuedCells, itemOutputFree(entity, "charged_accumulator"));
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
  for (const priority of [3, 2, 1] as PowerPriority[]) {
    const group = candidates.filter((candidate) => (candidate.entity.generationPriority ?? defaultGenerationPriority(candidate.entity)) === priority);
    const supplied = allocatePower(group, remaining, outputs);
    allocated += supplied;
    remaining -= supplied;
    if (remaining <= EPSILON) break;
  }
  return allocated;
}

export function getEntityPowerGridId(entity: FactoryEntity): PowerGridId {
  return entity.powerGridId ?? "grid-a";
}

function gridPowerSources(state: GameState, planetId: PlanetId, gridId: PowerGridId): FactoryEntity[] {
  return state.entities.filter((entity) => entity.planetId === planetId && getEntityPowerGridId(entity) === gridId &&
    (entity.kind === "power" || (entity.buildingId === "ray_receiver" && entity.recipeId === "ray_power")));
}

function powerCoverageLabel(state: GameState, entity: FactoryEntity): string {
  return gridPowerSources(state, entity.planetId, getEntityPowerGridId(entity)).length > 0
    ? "电网供电不足"
    : "电网断电";
}

export function isEntityInPowerCoverage(state: GameState, entity: FactoryEntity): boolean {
  if (entity.kind === "power" || (entity.buildingId === "ray_receiver" && entity.recipeId === "ray_power")) return true;
  return gridPowerSources(state, entity.planetId, getEntityPowerGridId(entity)).length > 0;
}

interface PowerConsumer {
  entity: FactoryEntity;
  demandKw: number;
}

function allocateConsumerPower(consumers: PowerConsumer[], availableKw: number): Map<string, number> {
  const factors = new Map<string, number>();
  let remaining = Math.max(0, availableKw);
  for (const priority of [3, 2, 1] as PowerPriority[]) {
    const group = consumers.filter((consumer) => (consumer.entity.powerPriority ?? 2) === priority);
    const demand = group.reduce((sum, consumer) => sum + consumer.demandKw, 0);
    const factor = demand <= EPSILON ? 1 : Math.min(1, remaining / demand);
    for (const consumer of group) factors.set(consumer.entity.id, factor);
    remaining = Math.max(0, remaining - demand * factor);
  }
  return factors;
}

function calculatePower(state: GameState, seconds: number, planetId: PlanetId, gridId: PowerGridId, reception: DysonReceptionPlan): PowerPlan {
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
  const consumers: PowerConsumer[] = [];
  const fuelCandidates: PowerCandidate[] = [];
  const accumulatorCandidates: PowerCandidate[] = [];
  const exchangerDischargeCandidates: PowerCandidate[] = [];
  const accumulatorChargeCandidates: PowerCandidate[] = [];
  const exchangerChargeCandidates: PowerCandidate[] = [];
  const powerOutputByEntity = new Map<string, number>();
  const powerInputByEntity = new Map<string, number>();
  const factorByEntity = new Map<string, number>();

  for (const entity of state.entities) {
    if (entity.planetId !== planetId || getEntityPowerGridId(entity) !== gridId) continue;
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
        const discharge = exchangerDischargeCapacityForStep(entity, seconds);
        const charge = exchangerChargeCapacityForStep(entity, seconds);
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
      if (!isEntityInPowerCoverage(state, entity)) {
        disconnectedEntities += 1;
        factorByEntity.set(entity.id, 0);
        const extractor = extractorFor(entity);
        const capacity = extractor.outputCapacity * entity.minerCount;
        if ((entity.outputs[entity.resourceId!] ?? 0) < capacity - EPSILON) {
          disconnectedDemandKw += (extractor.powerDemandKw ?? 0) * entity.minerCount * difficultyPowerMultiplier;
        }
        continue;
      }
      connectedEntities += 1;
      const extractor = extractorFor(entity);
      const capacity = extractor.outputCapacity * entity.minerCount;
      if ((entity.outputs[entity.resourceId!] ?? 0) < capacity - EPSILON) {
        consumers.push({ entity, demandKw: (extractor.powerDemandKw ?? 0) * entity.minerCount * difficultyPowerMultiplier });
      }
    } else if (entity.buildingId === "construction_center" && constructionAutomationHasDeficit(state)) {
      if (!isEntityInPowerCoverage(state, entity)) {
        disconnectedEntities += 1;
        factorByEntity.set(entity.id, 0);
        disconnectedDemandKw += (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier;
        continue;
      }
      connectedEntities += 1;
      consumers.push({ entity, demandKw: (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * difficultyPowerMultiplier });
    } else if (canMachineRun(state, entity) && entity.buildingId) {
      if (!isEntityInPowerCoverage(state, entity)) {
        disconnectedEntities += 1;
        factorByEntity.set(entity.id, 0);
        disconnectedDemandKw += (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount *
          getEntityProliferatorPowerMultiplier(entity) * difficultyPowerMultiplier;
        continue;
      }
      connectedEntities += 1;
      consumers.push({
        entity,
        demandKw: (getBuilding(entity.buildingId).powerDemandKw ?? 0) * entity.machineCount * getEntityProliferatorPowerMultiplier(entity) * difficultyPowerMultiplier,
      });
    } else if (entity.kind === "station" && entity.buildingId && stationRouteReady(state, entity)) {
      if (!isEntityInPowerCoverage(state, entity)) {
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
  const demandKw = connectedDemandKw + disconnectedDemandKw;
  const baseGenerationKw = windGenerationKw + solarGenerationKw + geothermalGenerationKw + rayGenerationKw;
  const exchangerCapacityKw = exchangerDischargeCandidates.reduce((sum, candidate) => sum + candidate.capacity, 0);
  const fuelCapacityKw = fuelCandidates.reduce((sum, candidate) => sum + candidate.capacity, 0);
  const accumulatorCapacityKw = accumulatorCandidates.reduce((sum, candidate) => sum + candidate.capacity, 0);
  const generationKw = baseGenerationKw + exchangerCapacityKw + fuelCapacityKw + accumulatorCapacityKw;
  const dispatchCandidates = [...exchangerDischargeCandidates, ...fuelCandidates, ...accumulatorCandidates];
  const missingKw = Math.max(0, Math.min(connectedDemandKw, generationKw) - baseGenerationKw);
  allocatePowerByPriority(dispatchCandidates, missingKw, powerOutputByEntity);
  const outputFor = (candidates: PowerCandidate[]) => candidates.reduce((sum, candidate) =>
    sum + (powerOutputByEntity.get(candidate.entity.id) ?? 0), 0);
  const exchangerGenerationKw = outputFor(exchangerDischargeCandidates);
  const accumulatorGenerationKw = outputFor(accumulatorCandidates);
  const suppliedKw = Math.min(connectedDemandKw, generationKw);
  const allocatedFactors = allocateConsumerPower(consumers, suppliedKw);
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

function burnFuel(entity: FactoryEntity, outputKw: number, seconds: number): void {
  if (!entity.buildingId || !entity.fuelItemId || outputKw <= EPSILON) return;
  const energyPerItem = FUEL_ENERGY_MJ[entity.fuelItemId] ?? 0;
  let requiredHeatMj = outputKw * seconds / (1000 * getFuelEfficiency(entity.buildingId));
  let remainingHeatMj = Math.max(0, entity.fuelRemainingMj ?? 0);
  while (requiredHeatMj > EPSILON) {
    if (remainingHeatMj <= EPSILON) {
      const queuedFuel = Math.floor((entity.inputs[entity.fuelItemId] ?? 0) + EPSILON);
      if (queuedFuel < 1 || energyPerItem <= EPSILON) break;
      entity.inputs[entity.fuelItemId] = queuedFuel - 1;
      remainingHeatMj += energyPerItem;
    }
    const burned = Math.min(requiredHeatMj, remainingHeatMj);
    requiredHeatMj -= burned;
    remainingHeatMj -= burned;
  }
  entity.fuelRemainingMj = round(Math.max(0, remainingHeatMj), 6);
}

function chargeExchanger(state: GameState, entity: FactoryEntity, energyMj: number): number {
  let remaining = Math.max(0, energyMj);
  let stored = storedEnergy(entity);
  let completed = 0;
  while (remaining > EPSILON) {
    if (stored <= EPSILON) {
      const queued = Math.floor((entity.inputs.accumulator ?? 0) + EPSILON);
      if (queued < 1 || itemOutputFree(entity, "charged_accumulator") < 1) break;
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

function dischargeExchanger(state: GameState, entity: FactoryEntity, energyMj: number): number {
  let remaining = Math.max(0, energyMj);
  let stored = storedEnergy(entity);
  let completed = 0;
  while (remaining > EPSILON) {
    if (stored <= EPSILON) {
      const queued = Math.floor((entity.inputs.charged_accumulator ?? 0) + EPSILON);
      if (queued < 1 || itemOutputFree(entity, "accumulator") < 1) break;
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

function runPowerFacilities(state: GameState, seconds: number, power: PowerPlan, planetId: PlanetId): void {
  for (const entity of state.entities) {
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
      burnFuel(entity, outputKw, seconds);
    } else if (entity.buildingId === "accumulator") {
      const capacity = energyCapacity(entity);
      entity.storedEnergyMj = round(Math.min(capacity, Math.max(0,
        storedEnergy(entity) + inputKw * seconds / 1000 - outputKw * seconds / 1000)), 6);
      entity.progress = capacity > EPSILON ? entity.storedEnergyMj / capacity : 0;
    } else if (entity.buildingId === "energy_exchanger") {
      const completed = entity.energyMode === "discharge"
        ? dischargeExchanger(state, entity, outputKw * seconds / 1000)
        : chargeExchanger(state, entity, inputKw * seconds / 1000);
      entity.productionRate = seconds > EPSILON ? round(completed * 60 / seconds, 2) : 0;
    }
  }
}

function fuelReserveSeconds(state: GameState, planetId: PlanetId, gridId?: PowerGridId): number {
  let electricEnergyMj = 0;
  let ratedGeneratorKw = 0;
  for (const entity of state.entities) {
    if (entity.planetId !== planetId || (gridId && getEntityPowerGridId(entity) !== gridId) || !isFuelGenerator(entity) || !entity.buildingId) continue;
    electricEnergyMj += fuelEnergyAvailable(entity) * getFuelEfficiency(entity.buildingId);
    ratedGeneratorKw += (getBuilding(entity.buildingId).powerGenerationKw ?? 0) * entity.machineCount;
  }
  return ratedGeneratorKw > EPSILON ? round(electricEnergyMj * 1000 / ratedGeneratorKw, 1) : 0;
}

function gridStoredEnergy(state: GameState, planetId: PlanetId, gridId?: PowerGridId): { stored: number; capacity: number } {
  return state.entities.reduce((total, entity) => {
    if (entity.planetId !== planetId || (gridId && getEntityPowerGridId(entity) !== gridId) ||
      (entity.buildingId !== "accumulator" && entity.buildingId !== "energy_exchanger")) return total;
    total.stored += storedEnergy(entity);
    total.capacity += energyCapacity(entity);
    return total;
  }, { stored: 0, capacity: 0 });
}

function transferLogisticsBuffers(state: GameState): void {
  for (const entity of state.entities) {
    if ((entity.kind !== "storage" && entity.kind !== "splitter" && entity.kind !== "station") || !entity.buildingId) continue;
    if (entity.buildingId === "material_delivery_hub") continue;
    const slots = entity.kind === "station" && entity.buildingId !== "orbital_collector"
      ? ensureStationSlots(entity).filter((slot): slot is StationSlot & { itemId: ItemId } => Boolean(slot.itemId))
      : entity.storedItemId ? [{ ...emptyStationSlot(), itemId: entity.storedItemId }] : [];
    for (const slot of slots) {
      const capacity = entity.kind === "station"
        ? getStationSlotCapacity(entity, slot)
        : getEntityOutputCapacity(entity);
      const incoming = Math.floor((entity.inputs[slot.itemId] ?? 0) + EPSILON);
      const stored = Math.floor((entity.outputs[slot.itemId] ?? 0) + EPSILON);
      const moved = Math.min(incoming, Math.max(0, capacity - stored));
      entity.inputs[slot.itemId] = incoming - moved;
      entity.outputs[slot.itemId] = stored + moved;
    }
  }
}

function drainMaterialDeliveryHubs(state: GameState, seconds: number): void {
  for (const entity of state.entities) {
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
  allowance: number;
  moved: number;
  capacity: number;
}

function targetFreeCapacity(target: FactoryEntity, itemId: ItemId): number {
  if (!target.buildingId) return 0;
  const capacity = getEntityInputCapacity(target);
  return Math.floor(Math.max(0, capacity - (target.inputs[itemId] ?? 0)) + EPSILON);
}

function transferBelts(state: GameState, seconds: number): void {
  const groups = new Map<string, { source: FactoryEntity; itemId: ItemId; candidates: BeltTransferCandidate[] }>();

  for (const belt of state.belts) {
    belt.lastFlow = round(belt.lastFlow * 0.8, 3);
    belt.congestion = round((belt.congestion ?? 0) * 0.85, 3);
    const source = state.entities.find((entity) => entity.id === belt.source);
    const target = state.entities.find((entity) => entity.id === belt.target);
    if (!source || !target || source.planetId !== target.planetId || belt.planetId !== source.planetId ||
      !sourceProduces(source, belt.itemId) || !targetConsumes(state, target, belt.itemId)) {
      belt.progress = 0;
      continue;
    }
    const available = Math.floor((source.outputs[belt.itemId] ?? 0) -
      stationReservedOutgoing(state, source.id, belt.itemId) + EPSILON);
    if (available < 1 || targetFreeCapacity(target, belt.itemId) < 1) {
      belt.progress = 0;
      continue;
    }
    const capacity = getBeltCapacity(belt);
    belt.progress = round((belt.progress ?? 0) + capacity * seconds);
    const key = `${belt.source}:${belt.itemId}`;
    const group = groups.get(key) ?? { source, itemId: belt.itemId, candidates: [] };
    group.candidates.push({ belt, target, allowance: Math.floor(belt.progress + EPSILON), moved: 0, capacity });
    groups.set(key, group);
  }

  const moveOne = (group: { source: FactoryEntity; itemId: ItemId }, candidate: BeltTransferCandidate) => {
    if (candidate.allowance < 1 || targetFreeCapacity(candidate.target, group.itemId) < 1) return false;
    candidate.allowance -= 1;
    candidate.moved += 1;
    candidate.target.inputs[group.itemId] = Math.floor((candidate.target.inputs[group.itemId] ?? 0) + 1);
    return true;
  };

  for (const group of groups.values()) {
    const reserved = stationReservedOutgoing(state, group.source.id, group.itemId);
    let available = Math.floor((group.source.outputs[group.itemId] ?? 0) - reserved + EPSILON);
    const usable = (candidate: BeltTransferCandidate) => candidate.allowance > 0 && targetFreeCapacity(candidate.target, group.itemId) > 0;

    if (group.source.kind === "splitter") {
      const distribute = (candidates: BeltTransferCandidate[]) => {
        if (candidates.length === 0) return;
        let cursor = group.source.routingCursor % candidates.length;
        let stalled = 0;
        while (available > 0 && stalled < candidates.length) {
          const candidate = candidates[cursor];
          cursor = (cursor + 1) % candidates.length;
          if (moveOne(group, candidate)) {
            available -= 1;
            stalled = 0;
          } else {
            stalled += 1;
          }
        }
        group.source.routingCursor = cursor;
      };
      if (group.source.distributionMode === "priority") {
        for (const priority of [2, 1, 0] as const) {
          distribute(group.candidates.filter((candidate) => candidate.belt.priority === priority && usable(candidate)));
          if (available <= 0) break;
        }
      } else {
        distribute(group.candidates.filter(usable));
      }
    } else {
      for (const candidate of [...group.candidates].sort((a, b) => b.belt.priority - a.belt.priority)) {
        const moved = Math.min(available, candidate.allowance, targetFreeCapacity(candidate.target, group.itemId));
        if (moved <= 0) continue;
        candidate.allowance -= moved;
        candidate.moved += moved;
        candidate.target.inputs[group.itemId] = Math.floor((candidate.target.inputs[group.itemId] ?? 0) + moved);
        available -= moved;
        if (available <= 0) break;
      }
    }

    group.source.outputs[group.itemId] = available + reserved;
    for (const candidate of group.candidates) {
      candidate.belt.progress = available <= 0 || targetFreeCapacity(candidate.target, group.itemId) <= 0
        ? 0
        : round(Math.max(0, candidate.belt.progress - candidate.moved));
      if (candidate.moved > 0 && seconds > 0) {
        candidate.belt.lastFlow = round(Math.min(candidate.capacity, candidate.moved / seconds), 3);
        candidate.belt.totalTransferred = Math.floor((candidate.belt.totalTransferred ?? 0) + candidate.moved);
      }
      const sourceWaiting = (group.source.outputs[group.itemId] ?? 0) > 0;
      const targetBlocked = targetFreeCapacity(candidate.target, group.itemId) <= 0;
      const load = candidate.capacity > EPSILON ? candidate.belt.lastFlow / candidate.capacity : 0;
      candidate.belt.congestion = round(Math.min(1, Math.max(load, sourceWaiting && targetBlocked ? 1 : 0)), 3);
    }
  }
}

function runMiners(state: GameState, seconds: number, power: PowerPlan, planetId: PlanetId): void {
  const researchedMiningSpeed = getMiningSpeedMultiplier(state);
  const profile = getPlanetIndustrialProfile(state, planetId);
  for (const entity of state.entities) {
    if (entity.planetId !== planetId || entity.kind !== "vein" || entity.minerCount <= 0 || !entity.resourceId) continue;
    const powerFactor = powerFactorForEntity(power, entity);
    entity.powerFactor = round(powerFactor, 4);
    const miner = extractorFor(entity);
    const miningSpeed = (ITEMS[entity.resourceId].kind === "solid" ? researchedMiningSpeed : 1) * profile.miningMultiplier;
    const capacity = miner.outputCapacity * entity.minerCount;
    const current = Math.floor((entity.outputs[entity.resourceId] ?? 0) + EPSILON);
    const free = Math.max(0, capacity - current);
    const finite = !isInfiniteResource(entity.resourceId, planetId, state.settings.resourceMode, state.galaxy);
    const remaining = finite ? Math.max(0, Math.floor(entity.resourceRemaining ?? 0)) : Number.POSITIVE_INFINITY;
    if (free < 1 || powerFactor <= EPSILON || remaining < 1) {
      entity.progress = 0;
      entity.utilization = 0;
      entity.productionRate = 0;
      continue;
    }
    entity.progress = round((entity.progress ?? 0) + miner.speed * miningSpeed * entity.minerCount * seconds * powerFactor);
    const produced = Math.min(free, remaining, Math.floor(entity.progress + EPSILON));
    entity.outputs[entity.resourceId] = current + produced;
    if (finite) entity.resourceRemaining = Math.max(0, remaining - produced);
    entity.progress = produced >= free ? 0 : round(entity.progress - produced);
    entity.utilization = powerFactor;
    entity.productionRate = round(miner.speed * miningSpeed * entity.minerCount * powerFactor * 60, 2);
    state.totalProduced[entity.resourceId] = Math.floor((state.totalProduced[entity.resourceId] ?? 0) + produced);
  }
}

function consumeProliferatorPoints(entity: FactoryEntity, recipe: RecipeDefinition, cycles: number): void {
  if (!proliferatorApplies(entity, recipe) || cycles < 1) return;
  const definition = getProliferator(entity.proliferatorTier!);
  const requiredPoints = getProliferatorSprayCost(recipe) * cycles;
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

function runMachines(state: GameState, seconds: number, power: PowerPlan, planetId: PlanetId): void {
  const profile = getPlanetIndustrialProfile(state, planetId);
  for (const entity of state.entities) {
    const recipe = getRecipe(entity.recipeId);
    if (entity.planetId !== planetId || entity.kind !== "machine" || entity.buildingId === "ray_receiver" || !entity.buildingId || !recipe) continue;
    entity.powerFactor = power.factorByEntity.has(entity.id)
      ? round(power.factorByEntity.get(entity.id)!, 4)
      : undefined;
    if (recipe.id === "matrix_research" && !hasActiveResearch(state)) {
      entity.progress = 0;
      entity.utilization = 0;
      entity.productionRate = 0;
      continue;
    }
    const building = getBuilding(entity.buildingId);
    const powerFactor = powerFactorForEntity(power, entity);
    const planetSpeed = specializationApplies(profile, building.family, entity.buildingId) ? profile.productionSpeedMultiplier : 1;
    const cyclesPerSecond = building.speed * entity.machineCount * getRecipeSpeedMultiplier(state, recipe.id) *
      getEntityProliferatorSpeedMultiplier(entity) * planetSpeed / recipe.duration;
    const launchFactor = dysonLaunchFactor(state, recipe.id);
    const potentialCycles = cyclesPerSecond * seconds * powerFactor * launchFactor;
    if (recipe.requiredTechId && !isTechnologyCompleted(state, recipe.requiredTechId)) {
      entity.progress = 0;
      entity.utilization = 0;
      entity.productionRate = 0;
      continue;
    }
    const fullInputCycles = Math.floor(availableInputCycles(state, entity) + EPSILON);
    const fullOutputCycles = Math.floor(availableOutputCycles(entity) + EPSILON);
    let maximumCycles = Math.min(fullInputCycles, fullOutputCycles, Math.floor(availableProliferatorCycles(entity, recipe) + EPSILON));
    if (maximumCycles < 1 || potentialCycles <= EPSILON) {
      entity.utilization = 0;
      entity.productionRate = 0;
      continue;
    }

    const work = Math.min(potentialCycles, Math.max(0, maximumCycles - (entity.progress ?? 0)));
    entity.progress = round((entity.progress ?? 0) + work, 6);
    const cycles = Math.min(maximumCycles, Math.floor(entity.progress + EPSILON));

    if (recipe.id === "matrix_research") {
      const techId = state.research.selectedTechId;
      const technology = getTechnology(techId);
      const infiniteId = state.endgame?.activeInfiniteResearchId;
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
        const progress = state.endgame.infiniteResearch[infiniteId] ?? { level: 0, progress: 0 };
        const cost = getInfiniteResearchCost(infiniteId, progress.level);
        const consumed = Math.min(
          cycles,
          Math.max(0, cost - progress.progress),
          Math.floor((entity.inputs.universe_matrix ?? 0) + EPSILON),
        );
        if (consumed > 0) {
          entity.inputs.universe_matrix = Math.floor((entity.inputs.universe_matrix ?? 0) - consumed);
          progress.progress = Math.floor(progress.progress + consumed);
          state.endgame.infiniteResearch[infiniteId] = progress;
          if (progress.progress >= cost) {
            progress.level += 1;
            progress.progress = 0;
            state.endgame.galacticScore = Math.floor(state.endgame.galacticScore + 1_000 + progress.level * 250);
            if (!state.endgame.autoResearch) state.endgame.activeInfiniteResearchId = null;
          }
          for (const researchEntity of state.entities) {
            if (researchEntity.recipeId === "matrix_research") researchEntity.progress = 0;
          }
        }
      }
    } else {
      for (const input of recipe.inputs) {
        entity.inputs[input.itemId] = Math.max(0, Math.floor((entity.inputs[input.itemId] ?? 0) - input.amount * cycles));
      }
      consumeProliferatorPoints(entity, recipe, cycles);
      if (recipe.id === "solar_sail_launch" && cycles > 0) launchDysonSails(state, getPlanet(entity.planetId).systemId, cycles);
      if (recipe.id === "carrier_rocket_launch" && cycles > 0) {
        launchDysonStructure(state, getPlanet(entity.planetId).systemId, cycles);
      }
      const launchEnergy = dysonLaunchEnergyPerCycle(recipe.id);
      if (launchEnergy > EPSILON && cycles > 0) {
        state.dysonEngineering.launchEnergySpentMj = round(state.dysonEngineering.launchEnergySpentMj + launchEnergy * cycles, 3);
      }
      const extraProductBonus = getEntityExtraProductBonus(entity);
      for (const output of recipe.outputs) {
        const baseProduced = output.amount * cycles;
        const accumulatedBonus = (entity.proliferatorBonusProgress?.[output.itemId] ?? 0) +
          baseProduced * extraProductBonus;
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
    const unitsPerCycle = recipe.id === "matrix_research" || recipe.id === "solar_sail_launch" || recipe.id === "carrier_rocket_launch"
      ? 1
      : recipe.outputs.reduce((sum, output) => sum + output.amount, 0) * (1 + getEntityExtraProductBonus(entity));
    entity.productionRate = round(cyclesPerSecond * unitsPerCycle * 60 * entity.utilization, 2);
  }
}

function runRayReceivers(
  state: GameState,
  seconds: number,
  reception: DysonReceptionPlan,
  planetId: PlanetId,
): void {
  for (const entity of state.entities) {
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
    const maximumCycles = Math.floor(availableOutputCycles(entity) + EPSILON);
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

function resetStationRuntime(state: GameState): void {
  for (const station of state.entities.filter((entity) => entity.kind === "station")) {
    station.utilization = 0;
    station.productionRate = 0;
    station.stationPeerId = undefined;
  }
}

function runOrbitalCollectors(state: GameState, seconds: number): void {
  for (const collector of state.entities.filter((entity) => entity.buildingId === "orbital_collector")) {
    const yields = getPlanetOrbitalYields(state, collector.planetId);
    const itemId = collector.storedItemId && (yields[collector.storedItemId] ?? 0) > 0
      ? collector.storedItemId
      : (Object.keys(yields)[0] as ItemId | undefined) ?? "hydrogen";
    collector.storedItemId = itemId;
    collector.stationMode = "supply";
    const capacity = getEntityOutputCapacity(collector);
    const current = Math.floor((collector.outputs[itemId] ?? 0) + EPSILON);
    const free = Math.max(0, capacity - current);
    if (free < 1) {
      collector.progress = 0;
      continue;
    }
    const profile = getPlanetIndustrialProfile(state, collector.planetId);
    const rate = (yields[itemId] ?? 0) * collector.machineCount * profile.orbitalYieldMultiplier;
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

function stationBusyVehicles(state: GameState, station: FactoryEntity, scope: StationLogisticsScope): number {
  return state.entities.reduce((sum, demand) => sum + (demand.stationRoutes ?? []).reduce((routeSum, route) =>
    route.scope === scope && routeVehicleStationId(demand, route) === station.id
      ? routeSum + route.vehicleCount
      : routeSum, 0), 0);
}

function stationActiveRoutes(state: GameState, station: FactoryEntity): Array<{ demand: FactoryEntity; route: StationRoute }> {
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

function stationInFlightCargo(station: FactoryEntity, itemId: ItemId): number {
  return (station.stationRoutes ?? []).reduce((sum, route) => route.itemId === itemId ? sum + route.cargo : sum, 0);
}

function stationReservedOutgoing(state: GameState, sourceId: string, itemId: ItemId): number {
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

function dispatchStationScope(
  state: GameState,
  scope: StationLogisticsScope,
  powerByPlanet: Map<PlanetId, PowerPlan>,
): void {
  const demands = state.entities.filter((entity) => {
    if (entity.kind !== "station" || entity.buildingId === "orbital_collector") return false;
    if (scope === "remote" && entity.buildingId !== "interstellar_logistics_station") return false;
    return getStationSlots(entity).some((slot) => stationSlotMode(entity, slot, scope) === "demand" && slot.itemId);
  });
  for (const demand of demands) {
    const slots = ensureStationSlots(demand);
    const orderedSlots = slots
      .map((slot, slotIndex) => ({ slot, slotIndex }))
      .filter(({ slot }) => slot.itemId && stationSlotMode(demand, slot, scope) === "demand")
      .sort((a, b) => b.slot.priority - a.slot.priority || a.slotIndex - b.slotIndex);
    const cursor = Math.max(0, Math.floor(demand.stationDispatchCursor ?? 0));
    const rotated = orderedSlots.length > 1
      ? [...orderedSlots.slice(cursor % orderedSlots.length), ...orderedSlots.slice(0, cursor % orderedSlots.length)]
      : orderedSlots;
    for (const { slot, slotIndex } of rotated) {
      if (!slot.itemId) continue;
      const match = findStationSlotPeer(state, demand, slotIndex, scope);
      if (!match) continue;
      const { peer: supply, peerSlotIndex } = match;
      const supplySlot = supply.buildingId === "orbital_collector"
        ? { ...emptyStationSlot(), itemId: supply.storedItemId, remoteMode: "supply" as const }
        : ensureStationSlots(supply)[peerSlotIndex];
      const sourcePlan = powerByPlanet.get(supply.planetId);
      const targetPlan = powerByPlanet.get(demand.planetId);
      const sourcePower = sourcePlan?.factorByEntity.get(supply.id) ?? sourcePlan?.factor ?? 0;
      const targetPower = targetPlan?.factorByEntity.get(demand.id) ?? targetPlan?.factor ?? 0;
      const requiresWarp = scope === "remote" && stationRouteRequiresWarp(demand, supply);
      const economics = scope === "remote" ? getInterstellarRouteEconomics(state, supply, demand, 1, {
        routePolicy: slot.routePolicy,
        warperBudget: slot.warperBudget,
      }) : null;
      if (requiresWarp && (!isTechnologyCompleted(state, "space_warp") || !economics?.routeAvailable)) continue;
      const hubPower = economics?.waypointStationIds.reduce((factor, stationId) => {
        const station = state.entities.find((entity) => entity.id === stationId);
        const plan = station ? powerByPlanet.get(station.planetId) : undefined;
        return Math.min(factor, station ? plan?.factorByEntity.get(station.id) ?? plan?.factor ?? 0 : 0);
      }, 1) ?? 1;
      const vehicleOwners = [demand, supply].filter((candidate, index, all) =>
        candidate.buildingId !== "orbital_collector" && all.findIndex((entry) => entry.id === candidate.id) === index);
      for (const owner of vehicleOwners) {
        const freeVehicles = Math.max(0, stationInstalledVehicles(owner, scope) - stationBusyVehicles(state, owner, scope));
        if (freeVehicles < 1) continue;
        const ownerPlan = powerByPlanet.get(owner.planetId);
        const ownerPower = ownerPlan?.factorByEntity.get(owner.id) ?? ownerPlan?.factor ?? 0;
        const powerFactor = scope === "local" ? ownerPower : Math.min(sourcePower, targetPower, hubPower);
        if (powerFactor <= EPSILON) continue;
        if (requiresWarp && !owner.stationWarpEnabled) continue;
        const warpAvailable = Math.max(0, Math.floor(owner.stationWarpers ?? 0));
        if (requiresWarp && warpAvailable < (economics?.warpersPerVessel ?? 1)) continue;
        const itemId = slot.itemId;
        const available = Math.max(0, Math.floor((supply.outputs[itemId] ?? 0) - supplySlot.minStock -
          stationReservedOutgoing(state, supply.id, itemId) + EPSILON));
        const demandCapacity = getStationSlotCapacity(demand, slot);
        const free = Math.max(0, Math.floor(demandCapacity - (demand.outputs[itemId] ?? 0) - stationInFlightCargo(demand, itemId) + EPSILON));
        const unitCargo = scope === "local" ? getPlanetaryCargoCapacity(state) : getInterstellarCargoCapacity(state);
        const minimumCargo = getStationMinimumCargo(state, demand, slotIndex, scope);
        const dispatchable = Math.min(
          freeVehicles,
          Math.floor(available / minimumCargo),
          Math.floor(free / minimumCargo),
          requiresWarp ? Math.floor(warpAvailable / Math.max(1, economics?.warpersPerVessel ?? 1)) : Number.POSITIVE_INFINITY,
        );
        if (dispatchable < 1) continue;
        const cargo = Math.min(available, free, unitCargo * dispatchable);
        const dispatchedEconomics = scope === "remote" ? getInterstellarRouteEconomics(state, supply, demand, dispatchable, {
          routePolicy: slot.routePolicy,
          warperBudget: slot.warperBudget,
        }) : null;
        const duration = scope === "local" ? getPlanetaryTripSeconds(state) : dispatchedEconomics!.durationSeconds;
        const initialProgress = demand.stationRoutes!.length === 0
          ? Math.max(0, Math.min(0.999999, demand.stationProgress ?? 0))
          : 0;
        demand.stationRoutes!.push({
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
        });
        state.nextId += 1;
        if (requiresWarp) owner.stationWarpers = warpAvailable - dispatchable * (dispatchedEconomics?.warpersPerVessel ?? 1);
        demand.stationProgress = Math.max(demand.stationProgress ?? 0, initialProgress);
        demand.stationPeerId = supply.id;
        supply.stationPeerId = demand.id;
        owner.stationPeerId = owner.id === demand.id ? supply.id : demand.id;
        demand.stationDispatchCursor = slotIndex + 1;
      }
    }
  }
}

function advanceStationRoutes(
  state: GameState,
  scope: StationLogisticsScope,
  seconds: number,
  powerByPlanet: Map<PlanetId, PowerPlan>,
): void {
  for (const demand of state.entities.filter((entity) => entity.kind === "station" && (entity.stationRoutes?.length ?? 0) > 0)) {
    const remaining: StationRoute[] = [];
    let completedCargo = 0;
    for (const route of demand.stationRoutes ?? []) {
      if (route.scope !== scope) {
        remaining.push(route);
        continue;
      }
      const peer = state.entities.find((entity) => entity.id === route.peerId);
      const vehicleOwner = state.entities.find((entity) => entity.id === routeVehicleStationId(demand, route)) ?? demand;
      const sourcePlan = peer ? powerByPlanet.get(peer.planetId) : undefined;
      const targetPlan = powerByPlanet.get(demand.planetId);
      const ownerPlan = powerByPlanet.get(vehicleOwner.planetId);
      const sourcePower = peer ? sourcePlan?.factorByEntity.get(peer.id) ?? sourcePlan?.factor ?? 0 : 1;
      const targetPower = targetPlan?.factorByEntity.get(demand.id) ?? targetPlan?.factor ?? 0;
      const ownerPower = ownerPlan?.factorByEntity.get(vehicleOwner.id) ?? ownerPlan?.factor ?? 0;
      const hubPower = (route.waypointStationIds ?? []).reduce((factor, stationId) => {
        const station = state.entities.find((entity) => entity.id === stationId);
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
      demand.outputs[route.itemId] = Math.floor((demand.outputs[route.itemId] ?? 0) + route.cargo);
      if (peer) peer.outputs[route.itemId] = Math.max(0, Math.floor((peer.outputs[route.itemId] ?? 0) - route.cargo));
      demand.stationTrips = Math.floor((demand.stationTrips ?? 0) + route.vehicleCount);
      demand.stationLastTransfer = route.cargo;
      completedCargo += route.cargo;
      if (peer) {
        peer.stationTrips = Math.floor((peer.stationTrips ?? 0) + route.vehicleCount);
        peer.stationLastTransfer = route.cargo;
      }
    }
    demand.stationRoutes = remaining;
    demand.productionRate += seconds > EPSILON ? completedCargo * 60 / seconds : 0;
    demand.stationProgress = remaining.length > 0 ? Math.max(...remaining.map((route) => route.progress)) : 0;
  }
}

function updateStationCongestion(state: GameState): void {
  for (const station of state.entities.filter((entity) => entity.kind === "station" && entity.buildingId !== "orbital_collector")) {
    const slots = ensureStationSlots(station);
    const waiting = slots.filter((slot, slotIndex) => slot.itemId && (["local", "remote"] as StationLogisticsScope[]).some((scope) =>
      stationSlotMode(station, slot, scope) === "demand" && findStationSlotPeer(state, station, slotIndex, scope))).length;
    const installed = getStationDroneCapacity(station) + getStationVesselCapacity(station);
    const busy = stationBusyVehicles(state, station, "local") + stationBusyVehicles(state, station, "remote");
    const fleetLoad = installed > 0 ? busy / installed : waiting > 0 ? 1 : 0;
    station.stationCongestion = round(Math.min(1, Math.max(fleetLoad, waiting > 0 && busy === 0 ? 0.35 : 0)), 3);
    const activeRoutes = stationActiveRoutes(state, station).map(({ route }) => route);
    station.stationProgress = activeRoutes.length
      ? Math.max(...activeRoutes.map((route) => route.progress))
      : 0;
  }
}

function refillStationWarpersFromPlanetTrays(state: GameState): void {
  if (!isTechnologyCompleted(state, "space_warp")) return;
  for (const station of state.entities) {
    if (station.buildingId !== "interstellar_logistics_station" || !station.stationWarperAutoRefill) continue;
    const loaded = Math.max(0, Math.floor(station.stationWarpers ?? 0));
    const target = getStationWarperAutoRefillTarget(station);
    if (loaded >= target) continue;
    const tray = trayForPlanet(state, station.planetId);
    const available = Math.max(0, Math.floor(tray.space_warper ?? 0));
    const moved = Math.min(target - loaded, available);
    if (moved < 1) continue;
    station.stationWarpers = loaded + moved;
    tray.space_warper = available - moved;
  }
}

function simulateStep(state: GameState, seconds: number): void {
  advanceExplorationMissions(state, seconds);
  advanceHandcraftQueue(state, seconds);
  absorbDysonSails(state, seconds);
  decayDysonSwarm(state, seconds);
  resetStationRuntime(state);
  runOrbitalCollectors(state, seconds);
  transferLogisticsBuffers(state);
  transferBelts(state, seconds);
  drainMaterialDeliveryHubs(state, seconds);
  const reception = calculateDysonReception(state);
  const powerByPlanet = new Map<PlanetId, PowerPlan>();
  for (const planet of PLANET_LIST) {
    const gridPlans = POWER_GRID_IDS.map((gridId) => calculatePower(state, seconds, planet.id, gridId, reception));
    const power = combinePowerPlans(gridPlans);
    powerByPlanet.set(planet.id, power);
    for (const gridPlan of gridPlans) {
      const gridId = gridPlan.gridId!;
      const storage = gridStoredEnergy(state, planet.id, gridId);
      state.powerGridMetrics[planet.id][gridId] = {
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
        fuelReserveSeconds: fuelReserveSeconds(state, planet.id, gridId),
        totalItemsPerMinute: 0,
        connectedEntities: gridPlan.connectedEntities,
        disconnectedEntities: gridPlan.disconnectedEntities,
        generatorCount: gridPlan.generatorCount,
        coverageRadius: POWER_SUPPLY_RADIUS,
      };
    }
    runPowerFacilities(state, seconds, power, planet.id);
    runMiners(state, seconds, power, planet.id);
    runMachines(state, seconds, power, planet.id);
    runConstructionCenters(state, seconds, power, planet.id);
    runRayReceivers(state, seconds, reception, planet.id);
    const storage = gridStoredEnergy(state, planet.id);
    state.planetMetrics[planet.id] = {
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
      fuelReserveSeconds: fuelReserveSeconds(state, planet.id),
      totalItemsPerMinute: round(state.entities.reduce((sum, entity) =>
        entity.planetId === planet.id ? sum + entity.productionRate : sum, 0), 2),
    };
  }
  refillStationWarpersFromPlanetTrays(state);
  dispatchStationScope(state, "local", powerByPlanet);
  dispatchStationScope(state, "remote", powerByPlanet);
  advanceStationRoutes(state, "local", seconds, powerByPlanet);
  advanceStationRoutes(state, "remote", seconds, powerByPlanet);
  updateStationCongestion(state);
  runGalacticExports(state, seconds);
  syncLegacySwarmIntoOrbits(state);
  updateDysonSphereGeneration(state);
  state.dysonSwarm.receiverLoadKw = round(reception.receiverLoadKw, 2);
  state.elapsedSeconds = round(state.elapsedSeconds + seconds);
  if (state.endgame.exportWindowStartedAt <= 0) state.endgame.exportWindowStartedAt = state.elapsedSeconds;
  const exportWindowSeconds = state.elapsedSeconds - state.endgame.exportWindowStartedAt;
  if (exportWindowSeconds >= 10 - EPSILON) {
    state.endgame.exportedLastMinute = round(state.endgame.exportWindowAmount * 60 / exportWindowSeconds, 2);
    state.endgame.exportWindowAmount = 0;
    state.endgame.exportWindowStartedAt = state.elapsedSeconds;
  }
  state.metrics = { ...state.planetMetrics[state.activePlanetId] };
}

function recordProductionHistory(state: GameState): void {
  if (state.elapsedSeconds - state.historyRecordedAt < 10 - EPSILON) return;
  const productionPerMinute: Partial<Record<ItemId, number>> = {};
  const consumptionPerMinute: Partial<Record<ItemId, number>> = {};
  const inventory: Partial<Record<ItemId, number>> = {};
  const add = (record: Partial<Record<ItemId, number>>, itemId: ItemId, amount: number) => {
    record[itemId] = round((record[itemId] ?? 0) + amount, 2);
  };
  for (const entity of state.entities) {
    if (entity.kind === "vein" && entity.resourceId) add(productionPerMinute, entity.resourceId, entity.productionRate);
    else if (entity.buildingId === "orbital_collector" && entity.storedItemId) {
      add(productionPerMinute, entity.storedItemId, entity.productionRate);
    } else if (entity.kind === "machine") {
      const recipe = getRecipe(entity.recipeId);
      if (recipe && recipe.id !== "matrix_research") {
        for (const input of recipe.inputs) add(consumptionPerMinute, input.itemId, entity.productionRate * input.amount);
        for (const output of recipe.outputs) add(productionPerMinute, output.itemId, entity.productionRate * output.amount);
      }
    }
    for (const [itemId, amount] of Object.entries(entity.inputs)) add(inventory, itemId as ItemId, Math.floor(amount ?? 0));
    for (const [itemId, amount] of Object.entries(entity.outputs)) add(inventory, itemId as ItemId, Math.floor(amount ?? 0));
  }
  for (const tray of Object.values(state.planetTrays)) {
    for (const [itemId, amount] of Object.entries(tray)) add(inventory, itemId as ItemId, Math.floor(amount ?? 0));
  }
  const productiveEntities = state.entities.filter((entity) => entity.kind === "machine" || (entity.kind === "vein" && entity.minerCount > 0));
  const productiveUnits = productiveEntities.reduce((sum, entity) => sum + (entity.kind === "vein" ? entity.minerCount : entity.machineCount), 0);
  const utilizedUnits = productiveEntities.reduce((sum, entity) => sum + entity.utilization * (entity.kind === "vein" ? entity.minerCount : entity.machineCount), 0);
  const activeMachines = productiveEntities.reduce((sum, entity) => sum + (entity.utilization > EPSILON ? (entity.kind === "vein" ? entity.minerCount : entity.machineCount) : 0), 0);
  const blockedMachines = productiveEntities.reduce((sum, entity) => sum + (getEntityOperatingStatus(state, entity).tone === "blocked" ? (entity.kind === "vein" ? entity.minerCount : entity.machineCount) : 0), 0);
  const beltCapacity = state.belts.reduce((sum, belt) => sum + getBeltCapacity(belt), 0);
  const beltFlow = state.belts.reduce((sum, belt) => sum + Math.max(0, belt.lastFlow ?? 0), 0);
  const totalPowerDemand = Object.values(state.planetMetrics).reduce((sum, metrics) => sum + metrics.demandKw, 0);
  const deliveredPower = Object.values(state.planetMetrics).reduce((sum, metrics) => sum + metrics.demandKw * metrics.powerFactor, 0);
  state.productionHistory.push({
    elapsedSeconds: state.elapsedSeconds,
    productionPerMinute,
    consumptionPerMinute,
    inventory,
    generationKw: round(Object.values(state.planetMetrics).reduce((sum, metrics) => sum + metrics.generationKw, 0), 2),
    demandKw: round(Object.values(state.planetMetrics).reduce((sum, metrics) => sum + metrics.demandKw, 0), 2),
    machineEfficiency: round(productiveUnits > 0 ? utilizedUnits / productiveUnits : 0, 4),
    logisticsEfficiency: round(beltCapacity > 0 ? Math.min(1, beltFlow / beltCapacity) : 0, 4),
    powerEfficiency: round(totalPowerDemand > 0 ? Math.min(1, deliveredPower / totalPowerDemand) : 1, 4),
    activeMachines: Math.max(0, Math.floor(activeMachines)),
    blockedMachines: Math.max(0, Math.floor(blockedMachines)),
  });
  state.productionHistory = state.productionHistory.slice(-180);
  state.historyRecordedAt = state.elapsedSeconds;
}

export function advanceSimulation(state: GameState, seconds: number): GameState {
  if (state.paused || seconds <= 0) return state;
  const next = copyState(state);
  let remaining = Math.min(seconds, 30 * 24 * 60 * 60);
  // Long offline sessions use coarser deterministic slices to keep the idle loop bounded.
  const stepSize = remaining >= 24 * 60 * 60 ? 30 : remaining > 8 * 60 * 60 ? 10 : 1;
  while (remaining > EPSILON) {
    const step = Math.min(stepSize, remaining);
    simulateStep(next, step);
    remaining -= step;
  }
  recordProductionHistory(next);
  return processConstructionQueue(syncCampaignProgress(next));
}

export function setPaused(state: GameState, paused: boolean): GameState {
  return { ...state, paused };
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

export function manualMine(state: GameState, entityId: string, amount = 1): GameState {
  const next = copyState(state);
  const entity = next.entities.find((item) => item.id === entityId);
  if (!entity || entity.kind !== "vein" || !entity.resourceId || ITEMS[entity.resourceId].kind === "fluid") return state;
  const capacity = Math.max(60, extractorFor(entity).outputCapacity * Math.max(1, entity.minerCount));
  const current = Math.floor((entity.outputs[entity.resourceId] ?? 0) + EPSILON);
  const finite = !isInfiniteResource(entity.resourceId, entity.planetId, next.settings.resourceMode, next.galaxy);
  const remaining = finite ? Math.max(0, Math.floor(entity.resourceRemaining ?? 0)) : Number.POSITIVE_INFINITY;
  const mined = Math.max(0, Math.floor(Math.min(amount, capacity - current, remaining)));
  entity.outputs[entity.resourceId] = current + mined;
  if (finite) entity.resourceRemaining = Math.max(0, remaining - mined);
  next.manualMined = Math.floor(next.manualMined + mined);
  next.totalProduced[entity.resourceId] = Math.floor((next.totalProduced[entity.resourceId] ?? 0) + mined);
  return next;
}

export function moveEntity(state: GameState, entityId: string, position: { x: number; y: number }): GameState {
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, position } : entity),
  };
}

export function moveEntities(state: GameState, positions: Array<{ id: string; position: { x: number; y: number } }>): GameState {
  const positionById = new Map(positions.map((entry) => [entry.id, entry.position]));
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
    .filter((entity) => entity.planetId === state.activePlanetId && entity.kind !== "vein" && entity.buildingId && selectedIds.has(entity.id))
    .map((entity) => entity.id);
}

export function createBlueprint(state: GameState, entityIds: string[], name?: string): GameState {
  const eligibleIds = getBlueprintEligibleEntityIds(state, entityIds);
  if (eligibleIds.length === 0) return state;
  const selected = state.entities.filter((entity) => eligibleIds.includes(entity.id));
  const originX = Math.min(...selected.map((entity) => entity.position.x));
  const originY = Math.min(...selected.map((entity) => entity.position.y));
  const keyById = new Map(selected.map((entity, index) => [entity.id, `node_${index + 1}`]));
  const blueprint: BlueprintDefinition = {
    id: `blueprint_${state.nextId}`,
    name: name?.trim().slice(0, 32) || `蓝图 ${String(state.blueprints.length + 1).padStart(2, "0")}`,
    entities: selected.map((entity) => ({
      key: keyById.get(entity.id)!,
      buildingId: entity.buildingId!,
      offset: { x: entity.position.x - originX, y: entity.position.y - originY },
      machineCount: Math.max(1, Math.floor(entity.machineCount)),
      recipeId: entity.recipeId,
      storedItemId: entity.storedItemId,
      deliveryItemIds: entity.deliveryItemIds ? [...entity.deliveryItemIds] : undefined,
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
      stationHubEnabled: entity.stationHubEnabled,
      stationHubPriority: entity.stationHubPriority,
      stationSlots: entity.stationSlots?.map((slot) => ({ ...slot })),
      sprayCoaterInstalled: entity.sprayCoaterInstalled,
      proliferatorTier: entity.proliferatorTier,
      proliferatorMode: entity.proliferatorMode,
    })),
    belts: state.belts
      .filter((belt) => keyById.has(belt.source) && keyById.has(belt.target))
      .map((belt, index) => ({
        key: `line_${index + 1}`,
        sourceKey: keyById.get(belt.source)!,
        targetKey: keyById.get(belt.target)!,
        itemId: belt.itemId,
        lanes: belt.lanes,
        tier: belt.tier,
        sorterTier: belt.tier,
        priority: belt.priority,
        stackSize: belt.stackSize,
        monitorEnabled: belt.monitorEnabled,
        routeMode: belt.routeMode ?? "auto",
        routeOffsetY: belt.routeOffsetY,
      })),
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
    blueprints: state.blueprints.map((blueprint) => blueprint.id === blueprintId ? { ...blueprint, name: normalized } : blueprint),
  };
}

export function removeBlueprint(state: GameState, blueprintId: string): GameState {
  if (!state.blueprints.some((blueprint) => blueprint.id === blueprintId)) return state;
  return {
    ...state,
    blueprints: state.blueprints.filter((blueprint) => blueprint.id !== blueprintId),
    constructionQueue: state.constructionQueue.filter((entry) => entry.blueprintId !== blueprintId),
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
      ? { ...blueprint, rotation, mirror }
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
    blueprints: state.blueprints.map((candidate) => candidate.id === blueprintId ? { ...candidate, recipeOverrides: overrides } : candidate),
  };
}

export function getBlueprintRequirements(blueprint: BlueprintDefinition): Array<{ constructionId: ConstructionId; amount: number }> {
  const requirements = new Map<ConstructionId, number>();
  const add = (constructionId: ConstructionId, amount: number) => {
    requirements.set(constructionId, (requirements.get(constructionId) ?? 0) + amount);
  };
  for (const entity of blueprint.entities) {
    add(entity.buildingId, entity.machineCount);
    if (entity.sprayCoaterInstalled) add("spray_coater", 1);
  }
  for (const belt of blueprint.belts) {
    add(getBeltConstructionId(belt.tier), belt.lanes);
  }
  return [...requirements].map(([constructionId, amount]) => ({ constructionId, amount }));
}

export function canPlaceBlueprint(state: GameState, blueprintId: string, planetId: PlanetId = state.activePlanetId): boolean {
  const blueprint = state.blueprints.find((candidate) => candidate.id === blueprintId);
  if (!blueprint || blueprint.entities.length === 0 ||
    blueprint.entities.some((entity) => !canPlaceBuildingOnPlanet(entity.buildingId, planetId, state))) return false;
  return getBlueprintRequirements(blueprint).every((requirement) =>
    (state.construction[requirement.constructionId] ?? 0) >= requirement.amount);
}

function transformBlueprintOffset(
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
  options: { planetId?: PlanetId; rotation?: BlueprintRotation; mirror?: BlueprintMirror } = {},
): GameState {
  const blueprint = state.blueprints.find((candidate) => candidate.id === blueprintId);
  const planetId = options.planetId ?? state.activePlanetId;
  const rotation = options.rotation ?? blueprint?.rotation ?? 0;
  const mirror = options.mirror ?? blueprint?.mirror ?? "none";
  if (!blueprint || !canPlaceBlueprint(state, blueprintId, planetId)) return state;
  const next = copyState(state);
  for (const requirement of getBlueprintRequirements(blueprint)) {
    next.construction[requirement.constructionId] = (next.construction[requirement.constructionId] ?? 0) - requirement.amount;
  }
  const entityIdByKey = new Map<string, string>();
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
      buildingId: template.buildingId,
      recipeId,
      storedItemId: template.storedItemId,
      deliveryItemIds: template.deliveryItemIds ? [...template.deliveryItemIds] : undefined,
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
      stationCongestion: building.kind === "station" ? 0 : undefined,
      sprayCoaterInstalled: template.sprayCoaterInstalled,
      proliferatorTier: template.sprayCoaterInstalled ? template.proliferatorTier ?? 1 : undefined,
      proliferatorMode: template.sprayCoaterInstalled ? template.proliferatorMode ?? "normal" : undefined,
      proliferatorPoints: 0,
      proliferatorBonusProgress: {},
      machineCount: template.machineCount,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    });
  }
  for (const template of blueprint.belts) {
    const source = entityIdByKey.get(template.sourceKey);
    const target = entityIdByKey.get(template.targetKey);
    if (!source || !target) continue;
    next.belts.push({
      id: `belt_${next.nextId}`,
      planetId,
      source,
      target,
      itemId: template.itemId,
      lanes: template.lanes,
      tier: template.tier,
      sorterTier: template.tier,
      progress: 0,
      priority: template.priority,
      stackSize: template.stackSize ?? 1,
      monitorEnabled: template.monitorEnabled ?? false,
      routeMode: template.routeMode ?? "auto",
      routeOffsetY: template.routeOffsetY,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
    });
    next.nextId += 1;
  }
  return next;
}

export function canQueueBlueprint(state: GameState, blueprintId: string, planetId: PlanetId = state.activePlanetId): boolean {
  const blueprint = state.blueprints.find((candidate) => candidate.id === blueprintId);
  return Boolean(blueprint?.entities.length && blueprint.entities.every((entity) =>
    canPlaceBuildingOnPlanet(entity.buildingId, planetId, state)));
}

export function queueBlueprint(
  state: GameState,
  blueprintId: string,
  position: { x: number; y: number },
): GameState {
  const blueprint = state.blueprints.find((candidate) => candidate.id === blueprintId);
  if (!blueprint || !canQueueBlueprint(state, blueprintId)) return state;
  const next = copyState(state);
  next.constructionQueue.push({
    id: `construction_${next.nextId}`,
    blueprintId,
    blueprintName: blueprint.name,
    planetId: next.activePlanetId,
    position: { ...position },
    rotation: blueprint.rotation ?? 0,
    mirror: blueprint.mirror ?? "none",
    queuedAt: next.elapsedSeconds,
  });
  next.nextId += 1;
  return next;
}

export function cancelConstructionQueueEntry(state: GameState, entryId: string): GameState {
  if (!state.constructionQueue.some((entry) => entry.id === entryId)) return state;
  return { ...state, constructionQueue: state.constructionQueue.filter((entry) => entry.id !== entryId) };
}

export function getConstructionQueueDeficits(state: GameState, entryId: string) {
  const entry = state.constructionQueue.find((candidate) => candidate.id === entryId);
  const blueprint = entry ? state.blueprints.find((candidate) => candidate.id === entry.blueprintId) : undefined;
  if (!blueprint) return [];
  return getBlueprintRequirements(blueprint).flatMap((requirement) => {
    const available = Math.floor(state.construction[requirement.constructionId] ?? 0);
    const missing = Math.max(0, requirement.amount - available);
    return missing > 0 ? [{ ...requirement, available, missing }] : [];
  });
}

export function processConstructionQueue(state: GameState): GameState {
  let next = state;
  for (const entry of state.constructionQueue) {
    if (!canPlaceBlueprint(next, entry.blueprintId, entry.planetId)) continue;
    const deployed = placeBlueprint(next, entry.blueprintId, entry.position, {
      planetId: entry.planetId,
      rotation: entry.rotation,
      mirror: entry.mirror,
    });
    if (deployed === next) continue;
    next = {
      ...deployed,
      constructionQueue: deployed.constructionQueue.filter((candidate) => candidate.id !== entry.id),
    };
  }
  return next;
}

export function canPlaceBuildingOnPlanet(buildingId: BuildingId, planetId: PlanetId, state?: { galaxy?: GameState["galaxy"] }): boolean {
  if (getPlanet(planetId).kind === "gas-giant") return buildingId === "orbital_collector";
  if (buildingId === "orbital_collector") return false;
  return buildingId !== "geothermal_power_station" || getPlanetIndustrialProfile(state ?? { galaxy: createGalaxyState() }, planetId).geothermalMultiplier > 0;
}

export function placeBuilding(state: GameState, buildingId: BuildingId, position: { x: number; y: number }, count = 1): GameState {
  const building = getBuilding(buildingId);
  const amount = Math.max(1, Math.floor(count));
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
    buildingId,
    powerGridId: "grid-a",
    powerPriority: 2,
    generationPriority: building.kind === "power" ? defaultGenerationPriority({ buildingId } as FactoryEntity) : undefined,
    recipeId: recipe?.id,
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
    stationMode: building.kind === "station" ? "supply" : undefined,
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
    stationCongestion: building.kind === "station" ? 0 : undefined,
    fuelRemainingMj: getFuelItemIdsForBuilding(buildingId).length > 0 ? 0 : undefined,
    powerOutputKw: building.kind === "power" ? 0 : undefined,
    powerInputKw: building.kind === "power" ? 0 : undefined,
    storedEnergyMj: buildingId === "accumulator" || buildingId === "energy_exchanger" ? 0 : undefined,
    energyMode: buildingId === "accumulator" ? "auto" : buildingId === "energy_exchanger" ? "charge" : undefined,
    utilization: 0,
    productionRate: 0,
  });
  next.nextId += 1;
  return next;
}

export function addBuildingToGroup(state: GameState, entityId: string, buildingId: BuildingId, count = 1): GameState {
  const amount = Math.max(1, Math.floor(count));
  if (getBuilding(buildingId).kind === "miner" || (state.construction[buildingId] ?? 0) < amount) return state;
  const next = copyState(state);
  const entity = next.entities.find((item) => item.id === entityId && item.buildingId === buildingId);
  if (!entity) return state;
  entity.machineCount += amount;
  next.construction[buildingId] = (next.construction[buildingId] ?? 0) - amount;
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
  if (!source?.resourceId) return state;
  const extractorId = getExtractorBuildingId(source.resourceId);
  const amount = Math.max(1, Math.floor(count));
  if ((state.construction[extractorId] ?? 0) < amount) return state;
  const next = copyState(state);
  const entity = next.entities.find((item) => item.id === entityId && item.kind === "vein");
  if (!entity) return state;
  entity.minerCount += amount;
  entity.extractorBuildingId = extractorId;
  next.construction[extractorId] = (next.construction[extractorId] ?? 0) - amount;
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

export function getMaterialDeliveryItems(entity: FactoryEntity): ItemId[] {
  if (entity.buildingId !== "material_delivery_hub") return [];
  return [...new Set((entity.deliveryItemIds ?? []).filter((itemId) => Boolean(ITEMS[itemId])))].slice(0, MATERIAL_DELIVERY_SLOT_COUNT);
}

function refundBelts(state: GameState, belts: BeltConnection[]): void {
  for (const belt of belts) {
    const constructionId = getBeltConstructionId(belt.tier);
    state.construction[constructionId] = (state.construction[constructionId] ?? 0) + belt.lanes;
  }
}

function logisticsAccepts(state: GameState, entity: FactoryEntity, itemId: ItemId): boolean {
  if ((entity.kind !== "storage" && entity.kind !== "splitter" && entity.kind !== "station") || !entity.buildingId) return false;
  if (entity.buildingId === "orbital_collector") {
    return (getPlanetOrbitalYields(state, entity.planetId)[itemId] ?? 0) > 0 && (!entity.storedItemId || entity.storedItemId === itemId);
  }
  const accepts = getBuilding(entity.buildingId).accepts ?? "any";
  const itemKind = ITEMS[itemId].kind;
  const compatibleKind = accepts === "any" || accepts === itemKind || (accepts === "solid" && itemKind === "matrix");
  if (!compatibleKind) return false;
  if (entity.buildingId === "material_delivery_hub") {
    const configured = getMaterialDeliveryItems(entity);
    return configured.includes(itemId) || configured.length < MATERIAL_DELIVERY_SLOT_COUNT;
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

function targetConsumes(state: GameState, entity: FactoryEntity, itemId: ItemId): boolean {
  if (logisticsAccepts(state, entity, itemId)) return true;
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
  if (entity.kind !== "machine" || !entity.buildingId || hasBufferedItems(entity)) return undefined;
  const recipes = getRecipesForBuilding(entity.buildingId)
    .filter((recipe) => !recipe.requiredTechId || isTechnologyCompleted(state, recipe.requiredTechId));
  const defaultRecipe = recipes[0];
  if (!defaultRecipe || entity.recipeId !== defaultRecipe.id) return undefined;
  return recipes.find((recipe) => recipe.inputs.some((input) => input.itemId === itemId));
}

function targetCanAcceptBeltItem(state: GameState, entity: FactoryEntity, itemId: ItemId): boolean {
  return targetConsumes(state, entity, itemId) || Boolean(getAutoRecipeForInput(state, entity, itemId));
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

function configureTargetItem(entity: FactoryEntity, itemId: ItemId): void {
  if (entity.buildingId === "material_delivery_hub") {
    const configured = getMaterialDeliveryItems(entity);
    if (!configured.includes(itemId) && configured.length < MATERIAL_DELIVERY_SLOT_COUNT) {
      entity.deliveryItemIds = [...configured, itemId];
    }
  } else if (entity.kind === "station" && entity.buildingId !== "orbital_collector") {
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
    .filter((entity) => requested.has(entity.id) && entity.buildingId && buildingSupportsRecipe(entity.buildingId, recipe))
    .map((entity) => entity.id);
}

export function setEntitiesRecipe(state: GameState, entityIds: string[], recipeId: RecipeId): GameState {
  const compatibleIds = getRecipeCompatibleEntityIds(state, entityIds, recipeId)
    .filter((entityId) => state.entities.find((entity) => entity.id === entityId)?.recipeId !== recipeId);
  if (compatibleIds.length === 0) return state;
  return applyAcrossEntityPlanets(state, compatibleIds, (current, planetEntityIds) =>
    planetEntityIds.reduce((next, entityId) => setEntityRecipe(next, entityId, recipeId), current));
}

export function canInstallSprayCoater(state: GameState, entityId: string): boolean {
  const entity = state.entities.find((item) => item.id === entityId);
  return Boolean(entity && !entity.sprayCoaterInstalled && isProliferatorEligible(entity) &&
    isTechnologyCompleted(state, "proliferator_1") && (state.construction.spray_coater ?? 0) >= 1);
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

export function setProliferatorConfiguration(
  state: GameState,
  entityId: string,
  tier: ProliferatorTier,
  mode: ProliferatorMode,
): GameState {
  const current = state.entities.find((entity) => entity.id === entityId);
  const definition = getProliferator(tier);
  if (!current?.sprayCoaterInstalled || !isProliferatorEligible(current) ||
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
  const capacity = getEntityInputCapacity(target);
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
  const capacity = getEntityInputCapacity(target);
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
  const capacity = getEntityInputCapacity(target);
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
  const capacity = getEntityInputCapacity(target);
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

export function craftConstruction(state: GameState, buildingId: ConstructionId): GameState {
  const definition = CONSTRUCTION.find((item) => item.buildingId === buildingId);
  if (!definition || (definition.requiredTechId && !isTechnologyCompleted(state, definition.requiredTechId)) ||
    definition.costs.some((cost) => (state.tray[cost.itemId] ?? 0) + EPSILON < cost.amount)) return state;
  const next = copyState(state);
  for (const cost of definition.costs) {
    next.tray[cost.itemId] = Math.floor((next.tray[cost.itemId] ?? 0) - cost.amount);
  }
  next.construction[buildingId] = (next.construction[buildingId] ?? 0) + definition.outputAmount;
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
}

interface ConstructionQuickCraftWork {
  inventory: Partial<Record<ItemId, number>>;
  produced: Partial<Record<ItemId, number>>;
}

interface InternalConstructionQuickCraftPlan extends ConstructionQuickCraftPlan {
  inventory?: Partial<Record<ItemId, number>>;
}

const QUICK_CRAFT_OPTION_LIMIT = 24;

function copyQuickCraftWork(work: ConstructionQuickCraftWork): ConstructionQuickCraftWork {
  return { inventory: { ...work.inventory }, produced: { ...work.produced } };
}

function ensureQuickCraftItemOptions(
  state: GameState,
  work: ConstructionQuickCraftWork,
  itemId: ItemId,
  requiredAmount: number,
  resolving: ReadonlySet<ItemId>,
): ConstructionQuickCraftWork[] {
  const available = Math.max(0, Math.floor(work.inventory[itemId] ?? 0));
  if (available >= requiredAmount) return [work];
  if (resolving.has(itemId)) return [];

  const nextResolving = new Set(resolving);
  nextResolving.add(itemId);
  const options: ConstructionQuickCraftWork[] = [];
  const recipes = Object.values(RECIPES).filter((recipe) =>
    isHandcraftableRecipe(recipe.id) &&
    (!recipe.requiredTechId || isTechnologyCompleted(state, recipe.requiredTechId)) &&
    recipe.outputs.some((output) => output.itemId === itemId && output.amount > 0));

  for (const recipe of recipes) {
    const requestedOutput = recipe.outputs.find((output) => output.itemId === itemId)!;
    const batches = Math.ceil((requiredAmount - available) / requestedOutput.amount);
    let candidates = [copyQuickCraftWork(work)];
    for (const input of recipe.inputs) {
      const requiredInput = input.amount * batches;
      const reserved: ConstructionQuickCraftWork[] = [];
      for (const candidate of candidates) {
        for (const supplied of ensureQuickCraftItemOptions(state, candidate, input.itemId, requiredInput, nextResolving)) {
          const next = copyQuickCraftWork(supplied);
          next.inventory[input.itemId] = Math.max(0, Math.floor((next.inventory[input.itemId] ?? 0) - requiredInput));
          reserved.push(next);
          if (reserved.length >= QUICK_CRAFT_OPTION_LIMIT) break;
        }
        if (reserved.length >= QUICK_CRAFT_OPTION_LIMIT) break;
      }
      candidates = reserved;
      if (candidates.length === 0) break;
    }

    for (const candidate of candidates) {
      for (const output of recipe.outputs) {
        const amount = output.amount * batches;
        candidate.inventory[output.itemId] = Math.floor((candidate.inventory[output.itemId] ?? 0) + amount);
        candidate.produced[output.itemId] = Math.floor((candidate.produced[output.itemId] ?? 0) + amount);
      }
      if ((candidate.inventory[itemId] ?? 0) >= requiredAmount) options.push(candidate);
      if (options.length >= QUICK_CRAFT_OPTION_LIMIT) return options;
    }
  }
  return options;
}

function buildConstructionQuickCraftPlan(state: GameState, buildingId: ConstructionId): InternalConstructionQuickCraftPlan {
  const definition = getConstructionDefinition(buildingId);
  const directDeficits = getConstructionCraftDeficits(state, buildingId);
  const impossible = {
    status: "blocked",
    possible: false,
    usesUpstream: false,
    missingTechnology: directDeficits.missingTechnology,
    missingItems: directDeficits.missingItems,
    consumedItems: [],
    producedItems: [],
  } satisfies ConstructionQuickCraftPlan;
  if (!definition || directDeficits.missingTechnology) return impossible;

  const initialInventory = Object.fromEntries((Object.entries(state.tray) as Array<[ItemId, number]>).map(([itemId, amount]) => [
    itemId,
    Math.max(0, Math.floor(amount ?? 0)),
  ])) as Partial<Record<ItemId, number>>;
  let candidates: ConstructionQuickCraftWork[] = [{ inventory: { ...initialInventory }, produced: {} }];
  for (const cost of definition.costs) {
    const paid: ConstructionQuickCraftWork[] = [];
    for (const candidate of candidates) {
      for (const supplied of ensureQuickCraftItemOptions(state, candidate, cost.itemId, cost.amount, new Set())) {
        const next = copyQuickCraftWork(supplied);
        next.inventory[cost.itemId] = Math.max(0, Math.floor((next.inventory[cost.itemId] ?? 0) - cost.amount));
        paid.push(next);
        if (paid.length >= QUICK_CRAFT_OPTION_LIMIT) break;
      }
      if (paid.length >= QUICK_CRAFT_OPTION_LIMIT) break;
    }
    candidates = paid;
    if (candidates.length === 0) return impossible;
  }

  const selected = candidates[0];
  const consumedItems = (Object.keys(ITEMS) as ItemId[]).flatMap((itemId) => {
    const consumed = Math.max(0, Math.floor((initialInventory[itemId] ?? 0) - (selected.inventory[itemId] ?? 0)));
    return consumed > 0 ? [{ itemId, amount: consumed }] : [];
  });
  const producedItems = (Object.entries(selected.produced) as Array<[ItemId, number]>).flatMap(([itemId, amount]) =>
    amount > 0 ? [{ itemId, amount: Math.floor(amount) }] : []);
  return {
    status: producedItems.length > 0 ? "upstream" : "direct",
    possible: true,
    usesUpstream: producedItems.length > 0,
    missingTechnology: null,
    missingItems: directDeficits.missingItems,
    consumedItems,
    producedItems,
    inventory: selected.inventory,
  };
}

export function getConstructionQuickCraftPlan(state: GameState, buildingId: ConstructionId): ConstructionQuickCraftPlan {
  const { inventory: _inventory, ...plan } = buildConstructionQuickCraftPlan(state, buildingId);
  return plan;
}

export type ConstructionCraftNavigationResult =
  | { status: "target"; itemId: ItemId; recipeId: RecipeId }
  | { status: "technology"; itemId: ItemId; technologyName: string }
  | { status: "raw-shortage"; itemId: ItemId; current: number; required: number }
  | { status: "no-handcraft"; itemId: ItemId }
  | { status: "ready" };

function findConstructionCraftNavigationTarget(
  state: GameState,
  itemId: ItemId,
  required: number,
  resolving: ReadonlySet<ItemId>,
): ConstructionCraftNavigationResult {
  const current = Math.max(0, Math.floor(state.tray[itemId] ?? 0));
  if (current >= required) return { status: "ready" };
  if (resolving.has(itemId)) return { status: "no-handcraft", itemId };

  const producingRecipes = Object.values(RECIPES).filter((recipe) =>
    recipe.outputs.some((output) => output.itemId === itemId && output.amount > 0));
  const handcraftRecipes = producingRecipes.filter((recipe) => isHandcraftableRecipe(recipe.id));
  if (handcraftRecipes.length === 0) {
    return producingRecipes.length === 0
      ? { status: "raw-shortage", itemId, current, required }
      : { status: "no-handcraft", itemId };
  }

  const unlockedRecipes = handcraftRecipes.filter((recipe) =>
    !recipe.requiredTechId || isTechnologyCompleted(state, recipe.requiredTechId));
  if (unlockedRecipes.length === 0) {
    const locked = handcraftRecipes.find((recipe) => recipe.requiredTechId);
    return {
      status: "technology",
      itemId,
      technologyName: locked?.requiredTechId
        ? getTechnology(locked.requiredTechId)?.name ?? locked.requiredTechId
        : "未知科技",
    };
  }

  for (const recipe of unlockedRecipes) {
    if (canHandcraftRecipe(state, recipe.id, 1)) return { status: "target", itemId, recipeId: recipe.id };
  }

  const nextResolving = new Set(resolving);
  nextResolving.add(itemId);
  const blockers: ConstructionCraftNavigationResult[] = [];
  for (const recipe of unlockedRecipes) {
    for (const input of recipe.inputs) {
      const available = Math.max(0, Math.floor(state.tray[input.itemId] ?? 0));
      if (available >= input.amount) continue;
      const result = findConstructionCraftNavigationTarget(state, input.itemId, input.amount, nextResolving);
      if (result.status === "target") return result;
      if (result.status !== "ready") blockers.push(result);
    }
  }

  return blockers.find((result) => result.status === "technology")
    ?? blockers.find((result) => result.status === "raw-shortage")
    ?? blockers[0]
    ?? { status: "no-handcraft", itemId };
}

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
  for (const cost of definition.costs) {
    const result = findConstructionCraftNavigationTarget(state, cost.itemId, cost.amount, new Set());
    if (result.status !== "ready") return result;
  }
  return { status: "ready" };
}

export function craftConstructionWithUpstream(state: GameState, buildingId: ConstructionId): GameState {
  const definition = getConstructionDefinition(buildingId);
  const plan = buildConstructionQuickCraftPlan(state, buildingId);
  if (!definition || !plan.possible || !plan.inventory) return state;
  const next = copyState(state);
  next.tray = { ...plan.inventory };
  for (const item of plan.producedItems) {
    next.totalProduced[item.itemId] = Math.floor((next.totalProduced[item.itemId] ?? 0) + item.amount);
  }
  next.construction[buildingId] = Math.floor((next.construction[buildingId] ?? 0) + definition.outputAmount);
  return next;
}

export function getConstructionAutomationStockLimit(state: GameState): number {
  if (isTechnologyCompleted(state, "construction_capacity_2")) return 2000;
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

export function setConstructionAutomationTarget(state: GameState, constructionId: ConstructionId, target: number): GameState {
  if (!getConstructionDefinition(constructionId)) return state;
  const normalized = Math.max(0, Math.min(getConstructionAutomationStockLimit(state), Math.floor(target)));
  if ((state.constructionAutomation.targetStock[constructionId] ?? 0) === normalized) return state;
  const targetStock = { ...state.constructionAutomation.targetStock };
  if (normalized < 1) delete targetStock[constructionId];
  else targetStock[constructionId] = normalized;
  const jobs = normalized <= (state.construction[constructionId] ?? 0)
    ? Object.fromEntries(Object.entries(state.constructionAutomation.jobs).filter(([, job]) => job.constructionId !== constructionId))
    : state.constructionAutomation.jobs;
  return { ...state, constructionAutomation: { ...state.constructionAutomation, targetStock, jobs } };
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
}

interface ConstructionAutomationPlanWork {
  inventory: Partial<Record<ItemId, number>>;
  steps: ConstructionAutomationStep[];
}

function constructionAutomationPending(state: GameState, constructionId: ConstructionId): number {
  return Object.values(state.constructionAutomation.jobs).reduce((sum, job) => sum + job.steps
    .filter((step) => step.kind === "building" && step.constructionId === constructionId).length, 0);
}

function constructionAutomationTarget(state: GameState, cursor = state.constructionAutomation.cursor): { index: number; definition: typeof CONSTRUCTION[number] } | null {
  if (CONSTRUCTION.length === 0) return null;
  for (let offset = 0; offset < CONSTRUCTION.length; offset += 1) {
    const index = (cursor + offset) % CONSTRUCTION.length;
    const definition = CONSTRUCTION[index];
    const target = state.constructionAutomation.targetStock[definition.buildingId] ?? 0;
    const current = (state.construction[definition.buildingId] ?? 0) + constructionAutomationPending(state, definition.buildingId);
    if (target <= current || definition.requiredTechId && !isTechnologyCompleted(state, definition.requiredTechId)) continue;
    return { index, definition };
  }
  return null;
}

function automationRecipesForOutput(state: GameState, itemId: ItemId): RecipeDefinition[] {
  void state;
  return Object.values(RECIPES).filter((recipe) =>
    isHandcraftableRecipe(recipe.id) &&
    recipe.outputs.some((output) => output.itemId === itemId && output.amount > 0));
}

function planAutomationItem(
  state: GameState,
  work: ConstructionAutomationPlanWork,
  itemId: ItemId,
  requiredAmount: number,
  resolving: ReadonlySet<ItemId>,
): { work?: ConstructionAutomationPlanWork; blocker?: ConstructionAutomationBlocker } {
  const current = Math.max(0, Math.floor(work.inventory[itemId] ?? 0));
  if (current >= requiredAmount) return { work };
  if (resolving.has(itemId)) return { blocker: { itemId, current, required: requiredAmount, reason: "no-handcraft" } };
  const recipes = automationRecipesForOutput(state, itemId);
  if (recipes.length === 0) return { blocker: { itemId, current, required: requiredAmount, reason: "raw-shortage" } };
  const nextResolving = new Set(resolving);
  nextResolving.add(itemId);
  let lastBlocker: ConstructionAutomationBlocker | undefined;
  for (const recipe of recipes) {
    if (recipe.requiredTechId && !isTechnologyCompleted(state, recipe.requiredTechId)) {
      lastBlocker = { itemId, current, required: requiredAmount, reason: "technology", technologyName: getTechnology(recipe.requiredTechId)?.name ?? recipe.requiredTechId };
      continue;
    }
    const primary = recipe.outputs.find((output) => output.itemId === itemId && output.amount > 0)!;
    const batches = Math.max(1, Math.ceil((requiredAmount - current) / primary.amount));
    let candidate: ConstructionAutomationPlanWork = {
      inventory: { ...work.inventory },
      steps: work.steps.map((step) => ({ ...step })),
    };
    let failed: ConstructionAutomationBlocker | undefined;
    for (const input of recipe.inputs) {
      const result = planAutomationItem(state, candidate, input.itemId, input.amount * batches, nextResolving);
      if (!result.work) {
        failed = result.blocker;
        break;
      }
      candidate = result.work;
      candidate.inventory[input.itemId] = Math.max(0, Math.floor((candidate.inventory[input.itemId] ?? 0) - input.amount * batches));
    }
    if (failed) {
      lastBlocker = failed;
      continue;
    }
    for (const output of recipe.outputs) {
      candidate.inventory[output.itemId] = Math.floor((candidate.inventory[output.itemId] ?? 0) + output.amount * batches);
    }
    candidate.steps.push({
      kind: "material",
      recipeId: recipe.id,
      batches,
      outputItemId: itemId,
      outputAmount: primary.amount * batches,
    });
    return { work: candidate };
  }
  return { blocker: lastBlocker ?? { itemId, current, required: requiredAmount, reason: "no-handcraft" } };
}

function buildConstructionAutomationPlan(state: GameState, definition: typeof CONSTRUCTION[number], planetId: PlanetId): ConstructionAutomationPlan {
  const tray = trayForPlanet(state, planetId);
  let work: ConstructionAutomationPlanWork = {
    inventory: Object.fromEntries((Object.entries(tray) as Array<[ItemId, number]>).map(([itemId, amount]) => [itemId, Math.max(0, Math.floor(amount ?? 0))])),
    steps: [],
  };
  for (const cost of definition.costs) {
    const result = planAutomationItem(state, work, cost.itemId, cost.amount, new Set());
    if (!result.work) return { steps: [], blocker: result.blocker };
    work = result.work;
    work.inventory[cost.itemId] = Math.max(0, Math.floor((work.inventory[cost.itemId] ?? 0) - cost.amount));
  }
  work.steps.push({ kind: "building", constructionId: definition.buildingId });
  return { steps: work.steps };
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
  blockerReason?: "raw-shortage" | "technology" | "no-handcraft";
  technologyName?: string;
}

function constructionAutomationStepDuration(state: GameState, step: ConstructionAutomationStep): number {
  if (step.kind === "building") return getConstructionAutomationCycleSeconds(state);
  return Math.max(0.01, getConstructionAutomationMaterialSeconds(state) * step.outputAmount);
}

export function getConstructionAutomationStatus(state: GameState, entityId: string): ConstructionAutomationStatus {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  if (!entity || entity.buildingId !== "construction_center") return { stage: "无制造任务", progress: 0, etaSeconds: 0 };
  const job = state.constructionAutomation.jobs[entityId];
  if (job) {
    const step = job.steps[job.stepIndex];
    if (!step) return { stage: "准备下一项", progress: 0, etaSeconds: 0 };
    const duration = constructionAutomationStepDuration(state, step);
    const tray = trayForPlanet(state, entity.planetId);
    const requirements = step.kind === "building"
      ? getConstructionDefinition(step.constructionId)?.costs ?? []
      : getRecipe(step.recipeId)?.inputs.map((input) => ({ itemId: input.itemId, amount: input.amount * step.batches })) ?? [];
    const missing = requirements.find((requirement) => (tray[requirement.itemId] ?? 0) + EPSILON < requirement.amount);
    return {
      stage: step.kind === "building"
        ? `制造 ${getConstructionDefinition(step.constructionId)?.name ?? step.constructionId}`
        : `加工 ${ITEMS[step.outputItemId].name}`,
      progress: Math.max(0, Math.min(1, job.elapsedSeconds / duration)),
      etaSeconds: Math.max(0, (duration - job.elapsedSeconds) + job.steps.slice(job.stepIndex + 1).reduce((sum, pending) => sum + constructionAutomationStepDuration(state, pending), 0)) /
        Math.max(1, entity.machineCount),
      missingItemId: missing?.itemId,
      missingAmount: missing ? Math.max(0, missing.amount - Math.floor(tray[missing.itemId] ?? 0)) : undefined,
      blockerReason: missing ? "raw-shortage" : undefined,
    };
  }
  const target = constructionAutomationTarget(state);
  if (!target) return { stage: state.constructionAutomation.enabled ? "目标库存已满足" : "自动制造已关闭", progress: 0, etaSeconds: 0 };
  const plan = buildConstructionAutomationPlan(state, target.definition, entity.planetId);
  if (plan.blocker) {
    return {
      stage: "等待材料",
      progress: 0,
      etaSeconds: 0,
      missingItemId: plan.blocker.itemId,
      missingAmount: Math.max(0, plan.blocker.required - plan.blocker.current),
      blockerReason: plan.blocker.reason,
      technologyName: plan.blocker.technologyName,
    };
  }
  return { stage: `准备 ${target.definition.name}`, progress: 0, etaSeconds: plan.steps.reduce((sum, step) => sum + constructionAutomationStepDuration(state, step), 0) / Math.max(1, entity.machineCount) };
}

function constructionAutomationInputsAvailable(state: GameState, planetId: PlanetId, step: ConstructionAutomationStep): boolean {
  const tray = trayForPlanet(state, planetId);
  const requirements = step.kind === "building"
    ? getConstructionDefinition(step.constructionId)?.costs ?? []
    : getRecipe(step.recipeId)?.inputs.map((input) => ({ itemId: input.itemId, amount: input.amount * step.batches })) ?? [];
  return requirements.every((requirement) => (tray[requirement.itemId] ?? 0) + EPSILON >= requirement.amount);
}

function finishConstructionAutomationStep(state: GameState, planetId: PlanetId, step: ConstructionAutomationStep): boolean {
  if (!constructionAutomationInputsAvailable(state, planetId, step)) return false;
  const tray = trayForPlanet(state, planetId);
  if (step.kind === "building") {
    const definition = getConstructionDefinition(step.constructionId);
    if (!definition) return false;
    for (const cost of definition.costs) tray[cost.itemId] = Math.max(0, Math.floor((tray[cost.itemId] ?? 0) - cost.amount));
    state.construction[step.constructionId] = Math.floor((state.construction[step.constructionId] ?? 0) + definition.outputAmount);
    state.constructionAutomation.totalCrafted += definition.outputAmount;
    state.constructionAutomation.lastCraftedId = step.constructionId;
    return true;
  }
  const recipe = getRecipe(step.recipeId);
  if (!recipe) return false;
  for (const output of recipe.outputs) {
    if (getPlanetTrayItemFreeCapacity(state, planetId, output.itemId) < output.amount * step.batches) return false;
  }
  for (const input of recipe.inputs) tray[input.itemId] = Math.max(0, Math.floor((tray[input.itemId] ?? 0) - input.amount * step.batches));
  for (const output of recipe.outputs) {
    storeInPlanetTray(state, planetId, output.itemId, output.amount * step.batches);
    state.totalProduced[output.itemId] = Math.floor((state.totalProduced[output.itemId] ?? 0) + output.amount * step.batches);
  }
  return true;
}

function runConstructionCenters(state: GameState, seconds: number, power: PowerPlan, planetId: PlanetId): void {
  for (const entity of state.entities) {
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
    let guard = 0;
    while (remainingWork > EPSILON && guard++ < 128) {
      if (!job) {
        const target = constructionAutomationTarget(state);
        if (!target) break;
        const plan = buildConstructionAutomationPlan(state, target.definition, entity.planetId);
        if (plan.blocker) break;
        job = { constructionId: target.definition.buildingId, steps: plan.steps, stepIndex: 0, elapsedSeconds: 0 };
        state.constructionAutomation.jobs[entity.id] = job;
        state.constructionAutomation.cursor = (target.index + 1) % Math.max(1, CONSTRUCTION.length);
      }
      const step = job.steps[job.stepIndex];
      if (!step) {
        delete state.constructionAutomation.jobs[entity.id];
        job = undefined;
        continue;
      }
      const duration = constructionAutomationStepDuration(state, step);
      if (!constructionAutomationInputsAvailable(state, entity.planetId, step)) break;
      const needed = Math.max(0, duration - job.elapsedSeconds);
      const used = Math.min(remainingWork, needed);
      job.elapsedSeconds = round(job.elapsedSeconds + used, 6);
      remainingWork -= used;
      worked ||= used > EPSILON;
      entity.progress = round(Math.min(1, job.elapsedSeconds / duration), 6);
      if (job.elapsedSeconds + EPSILON < duration) break;
      if (!finishConstructionAutomationStep(state, entity.planetId, step)) break;
      if (step.kind === "building") completed += getConstructionDefinition(step.constructionId)?.outputAmount ?? 0;
      job.stepIndex += 1;
      job.elapsedSeconds = 0;
      entity.progress = 0;
      if (job.stepIndex >= job.steps.length) {
        delete state.constructionAutomation.jobs[entity.id];
        job = undefined;
      }
    }
    entity.utilization = worked || completed > 0 ? powerFactor : 0;
    entity.productionRate = seconds > EPSILON ? round(completed * 60 / seconds, 2) : 0;
  }
}

function sourceProduces(entity: FactoryEntity, itemId: ItemId): boolean {
  if (entity.kind === "vein") return entity.resourceId === itemId;
  if (entity.kind === "station" && entity.buildingId !== "orbital_collector") {
    // A logistics station can expose up to five independent item slots. The
    // legacy storedItemId field mirrors only the first configured slot, so
    // using it here silently invalidates every second/third belt output.
    return getStationSlots(entity).some((slot) => slot.itemId === itemId);
  }
  if (entity.kind === "storage" || entity.kind === "splitter" || entity.kind === "station") return entity.storedItemId === itemId;
  return getRecipe(entity.recipeId)?.outputs.some((output) => output.itemId === itemId) ?? false;
}

export type BeltConnectionCheck =
  | { ok: true; code: "ready"; label: string }
  | { ok: false; code: "missing-belt" | "same-node" | "missing-node" | "different-planet" | "invalid-source" | "station-slots-full" | "item-conflict" | "invalid-target"; label: string };

export function getBeltConnectionCheck(state: GameState, sourceId: string, targetId: string, itemId: ItemId, tier: BeltTier = 1): BeltConnectionCheck {
  const constructionId = getBeltConstructionId(tier);
  if ((state.construction[constructionId] ?? 0) < 1) return { ok: false, code: "missing-belt", label: `缺少${getConstructionDefinition(constructionId)?.name ?? "传送带"}` };
  if (sourceId === targetId) return { ok: false, code: "same-node", label: "线路不能连接到同一建筑" };
  const source = state.entities.find((entity) => entity.id === sourceId);
  const target = state.entities.find((entity) => entity.id === targetId);
  if (!source || !target) return { ok: false, code: "missing-node", label: "连接端点不存在" };
  if (source.planetId !== target.planetId) return { ok: false, code: "different-planet", label: "传送带不能跨越行星" };
  if (!sourceProduces(source, itemId)) return { ok: false, code: "invalid-source", label: "来源设备不能输出该物品" };
  if (target.kind === "station" && target.buildingId !== "orbital_collector") {
    const slots = getStationSlots(target);
    if (!slots.some((slot) => slot.itemId === itemId) && !slots.some((slot) => !slot.itemId)) {
      return { ok: false, code: "station-slots-full", label: "物流站没有可用空槽" };
    }
  }
  if (!targetCanAcceptBeltItem(state, target, itemId)) {
    if ((target.kind === "storage" || target.kind === "splitter") && target.storedItemId && target.storedItemId !== itemId) {
      return { ok: false, code: "item-conflict", label: `目标已配置${ITEMS[target.storedItemId].name}` };
    }
    return { ok: false, code: "invalid-target", label: "目标设备没有兼容的输入接口或配方" };
  }
  return { ok: true, code: "ready", label: "可以建立运输线" };
}

export function canConnectBelt(state: GameState, sourceId: string, targetId: string, itemId: ItemId, tier: BeltTier = 1): boolean {
  return getBeltConnectionCheck(state, sourceId, targetId, itemId, tier).ok;
}

export function connectBelt(state: GameState, sourceId: string, targetId: string, itemId: ItemId, tier: BeltTier = 1): GameState {
  const constructionId = getBeltConstructionId(tier);
  if (!canConnectBelt(state, sourceId, targetId, itemId, tier)) return state;
  const source = state.entities.find((entity) => entity.id === sourceId);
  const target = state.entities.find((entity) => entity.id === targetId);
  if (!source || !target) return state;
  const next = copyState(state);
  const configuredTarget = next.entities.find((entity) => entity.id === targetId)!;
  configureAutoTargetRecipe(next, configuredTarget, itemId);
  configureTargetItem(configuredTarget, itemId);
  const existing = next.belts.find((belt) => belt.source === sourceId && belt.target === targetId && belt.itemId === itemId);
  if (existing) {
    if (existing.tier !== tier) return state;
    existing.lanes += 1;
  } else {
    next.belts.push({
      id: `belt_${next.nextId}`,
      planetId: source.planetId,
      source: sourceId,
      target: targetId,
      itemId,
      lanes: 1,
      tier,
      sorterTier: tier,
      progress: 0,
      priority: target.buildingId === "material_delivery_hub" ? 0 : 1,
      stackSize: 1,
      monitorEnabled: false,
      totalTransferred: 0,
      congestion: 0,
      lastFlow: 0,
      routeMode: "auto",
    });
    next.nextId += 1;
  }
  next.construction[constructionId] = (next.construction[constructionId] ?? 0) - 1;
  return next;
}

export function removeBelt(state: GameState, beltId: string): GameState {
  const belt = state.belts.find((item) => item.id === beltId);
  if (!belt) return state;
  const next = copyState(state);
  next.belts = next.belts.filter((item) => item.id !== beltId);
  const constructionId = getBeltConstructionId(belt.tier);
  next.construction[constructionId] = (next.construction[constructionId] ?? 0) + belt.lanes;
  return next;
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
  if (!current) return state;
  if (current.buildingId === "material_delivery_hub") {
    const next = copyState(state);
    const entity = next.entities.find((candidate) => candidate.id === entityId)!;
    for (const [bufferedItemId, amount] of Object.entries(entity.inputs)) addToPlanetTray(next, entity.planetId, bufferedItemId as ItemId, amount ?? 0);
    entity.inputs = {};
    entity.outputs = {};
    entity.deliveryItemIds = [itemId];
    return next;
  }
  if (current.kind === "station" && current.buildingId !== "orbital_collector") {
    return setStationSlotItem(state, entityId, 0, itemId);
  }
  if (!logisticsAccepts(state, { ...current, storedItemId: undefined }, itemId)) return state;
  if (current.storedItemId === itemId) return state;
  const next = copyState(state);
  const entity = next.entities.find((candidate) => candidate.id === entityId)!;
  for (const [bufferedItemId, amount] of Object.entries(entity.inputs)) addToTray(next, bufferedItemId as ItemId, amount ?? 0);
  for (const [bufferedItemId, amount] of Object.entries(entity.outputs)) addToTray(next, bufferedItemId as ItemId, amount ?? 0);
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
  const current = state.entities.find((entity) => entity.id === entityId && entity.kind === "station" &&
    entity.buildingId !== "orbital_collector");
  if (!current || current.planetId !== state.activePlanetId || slotIndex < 0 || slotIndex >= STATION_SLOT_COUNT ||
    (itemId && !ITEMS[itemId])) return state;
  const currentSlots = getStationSlots(current);
  const previousItemId = currentSlots[slotIndex]?.itemId;
  if (previousItemId === itemId || (itemId && currentSlots.some((slot, index) => index !== slotIndex && slot.itemId === itemId))) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  const slots = ensureStationSlots(station);
  if (previousItemId) {
    addToTray(next, previousItemId, station.inputs[previousItemId] ?? 0);
    addToTray(next, previousItemId, station.outputs[previousItemId] ?? 0);
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
  if (!current || !getStationSlots(current)[slotIndex]?.itemId ||
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
  if (!current || !STATION_MINIMUM_LOAD_OPTIONS.includes(minimumLoad) || !getStationSlots(current)[slotIndex]?.itemId) return state;
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
  if (!current || !getStationSlots(current)[slotIndex]?.itemId) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  const slot = ensureStationSlots(station)[slotIndex];
  slot.minStock = Math.max(0, Math.floor(minStock));
  slot.maxStock = Math.max(0, Math.floor(maxStock));
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
  if (!current || !getStationSlots(current)[slotIndex]?.itemId) return state;
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
  if (!current || !getStationSlots(current)[slotIndex]?.itemId ||
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
  if (!current || !getStationSlots(current)[slotIndex]?.itemId || !Number.isFinite(warperBudget)) return state;
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
  if (!state.entities.some((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station")) return state;
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
      if (!requested.has(entity.id) || entity.kind !== "station" || entity.buildingId === "orbital_collector") return false;
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
  if (!station) return state;
  const scope: StationLogisticsScope = station.buildingId === "planetary_logistics_station" ? "local" : "remote";
  return setStationSlotMode(state, entityId, 0, scope, mode);
}

export function adjustStationVessels(state: GameState, entityId: string, delta: number): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station");
  const requested = Math.trunc(delta);
  if (!current || current.planetId !== state.activePlanetId || requested === 0) return state;
  const loaded = Math.max(0, Math.floor(current.stationVessels ?? 0));
  const busy = stationBusyVehicles(state, current, "remote");
  const capacity = getStationVesselCapacity(current);
  const available = Math.max(0, Math.floor(state.portableFleet?.logistics_vessel ?? 0));
  const change = requested > 0
    ? Math.min(requested, capacity - loaded, available)
    : -Math.min(-requested, Math.max(0, loaded - busy));
  if (change === 0) return state;

  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  station.stationVessels = loaded + change;
  station.stationProgress = 0;
  if (change > 0) {
    next.portableFleet.logistics_vessel = available - change;
  } else {
    addToTray(next, "logistics_vessel", -change);
  }
  if (station.stationPeerId) {
    const peer = next.entities.find((entity) => entity.id === station.stationPeerId);
    if (peer) peer.stationProgress = 0;
  }
  return next;
}

export function adjustStationDrones(state: GameState, entityId: string, delta: number): GameState {
  const current = state.entities.find((entity) => entity.id === entityId &&
    (entity.buildingId === "planetary_logistics_station" || entity.buildingId === "interstellar_logistics_station"));
  const requested = Math.trunc(delta);
  if (!current || current.planetId !== state.activePlanetId || requested === 0) return state;
  const loaded = Math.max(0, Math.floor(current.stationDrones ?? 0));
  const busy = stationBusyVehicles(state, current, "local");
  const capacity = getStationDroneCapacity(current);
  const available = Math.max(0, Math.floor(state.portableFleet?.logistics_drone ?? 0));
  const change = requested > 0
    ? Math.min(requested, capacity - loaded, available)
    : -Math.min(-requested, Math.max(0, loaded - busy));
  if (change === 0) return state;

  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  station.stationDrones = loaded + change;
  station.stationProgress = 0;
  if (change > 0) next.portableFleet.logistics_drone = available - change;
  else addToTray(next, "logistics_drone", -change);
  if (station.stationPeerId) {
    const peer = next.entities.find((entity) => entity.id === station.stationPeerId);
    if (peer) peer.stationProgress = 0;
  }
  return next;
}

export function adjustStationWarpers(state: GameState, entityId: string, delta: number): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station");
  const requested = Math.trunc(delta);
  if (!current || current.planetId !== state.activePlanetId || requested === 0 ||
    !isTechnologyCompleted(state, "space_warp")) return state;
  const loaded = Math.max(0, Math.floor(current.stationWarpers ?? 0));
  const capacity = getStationWarperCapacity(current);
  const available = Math.max(0, Math.floor(state.tray.space_warper ?? 0));
  const change = requested > 0
    ? Math.min(requested, capacity - loaded, available)
    : -Math.min(-requested, loaded);
  if (change === 0) return state;
  const next = copyState(state);
  const station = next.entities.find((entity) => entity.id === entityId)!;
  station.stationWarpers = loaded + change;
  if (change > 0) next.tray.space_warper = available - change;
  else addToTray(next, "space_warper", -change);
  return next;
}

export function setStationWarpEnabled(state: GameState, entityId: string, enabled: boolean): GameState {
  if (!state.entities.some((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station") ||
    (enabled && !isTechnologyCompleted(state, "space_warp"))) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, stationWarpEnabled: enabled } : entity),
  };
}

export function setStationWarperAutoRefill(state: GameState, entityId: string, enabled: boolean): GameState {
  const station = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station");
  if (!station || (enabled && !isTechnologyCompleted(state, "space_warp")) || Boolean(station.stationWarperAutoRefill) === enabled) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, stationWarperAutoRefill: enabled } : entity),
  };
}

export function setStationWarperTarget(state: GameState, entityId: string, target: number): GameState {
  const station = state.entities.find((entity) => entity.id === entityId && entity.buildingId === "interstellar_logistics_station");
  if (!station || !Number.isFinite(target)) return state;
  const normalized = Math.max(1, Math.min(getStationWarperCapacity(station), Math.floor(target)));
  if (getStationWarperAutoRefillTarget(station) === normalized) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, stationWarperTarget: normalized } : entity),
  };
}

export function setStationMinimumLoad(state: GameState, entityId: string, minimumLoad: StationMinimumLoad): GameState {
  const current = state.entities.find((entity) => entity.id === entityId && entity.kind === "station");
  if (!current || !STATION_MINIMUM_LOAD_OPTIONS.includes(minimumLoad) || getStationMinimumLoad(current) === minimumLoad) return state;
  return setStationSlotMinimumLoad(state, entityId, 0, minimumLoad);
}

export function setFuelItem(state: GameState, entityId: string, itemId: ItemId): GameState {
  const current = state.entities.find((entity) => entity.id === entityId);
  if (!current?.buildingId || !getFuelItemIdsForBuilding(current.buildingId).includes(itemId)) return state;
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
  if (!current || current.buildingId !== "energy_exchanger" || mode === "auto" ||
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
  if (!POWER_GRID_IDS.includes(gridId) || !state.entities.some((entity) => entity.id === entityId)) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, powerGridId: gridId } : entity),
  };
}

export function setEntityPowerPriority(state: GameState, entityId: string, priority: PowerPriority): GameState {
  if (![1, 2, 3].includes(priority) || !state.entities.some((entity) => entity.id === entityId)) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, powerPriority: priority } : entity),
  };
}

export function setEntityGenerationPriority(state: GameState, entityId: string, priority: PowerPriority): GameState {
  const target = state.entities.find((entity) => entity.id === entityId);
  if (![1, 2, 3].includes(priority) || !target || (target.kind !== "power" && target.buildingId !== "ray_receiver")) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, generationPriority: priority } : entity),
  };
}

export function setSplitterMode(state: GameState, entityId: string, mode: "balanced" | "priority"): GameState {
  if (!state.entities.some((entity) => entity.id === entityId && entity.kind === "splitter")) return state;
  return {
    ...state,
    entities: state.entities.map((entity) => entity.id === entityId ? { ...entity, distributionMode: mode } : entity),
  };
}

export function removeEntity(state: GameState, entityId: string, count?: number): GameState {
  const entity = state.entities.find((item) => item.id === entityId);
  if (!entity) return state;
  if (entity.kind === "vein") {
    if (!entity.resourceId || entity.minerCount < 1) return state;
    const requested = count === undefined ? entity.minerCount : Math.max(1, Math.floor(count));
    const recovered = Math.min(entity.minerCount, requested);
    const next = copyState(state);
    const target = next.entities.find((item) => item.id === entityId)!;
    const extractorId = getExtractorBuildingId(target.resourceId!);
    target.minerCount -= recovered;
    next.construction[extractorId] = Math.floor((next.construction[extractorId] ?? 0) + recovered);
    if (target.minerCount === 0) {
      target.utilization = 0;
      target.productionRate = 0;
      target.powerFactor = undefined;
    }
    return next;
  }
  const requested = count === undefined ? entity.machineCount : Math.max(1, Math.floor(count));
  if (entity.buildingId && entity.machineCount > requested) {
    const next = copyState(state);
    const target = next.entities.find((item) => item.id === entityId)!;
    target.machineCount -= requested;
    next.construction[target.buildingId!] = Math.floor((next.construction[target.buildingId!] ?? 0) + requested);
    return next;
  }
  const next = copyState(state);
  const target = next.entities.find((item) => item.id === entityId)!;
  if (target.buildingId === "construction_center") delete next.constructionAutomation.jobs[entityId];
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
  return next;
}

export function removeEntities(state: GameState, entityIds: string[]): GameState {
  let next = state;
  for (const entityId of [...new Set(entityIds)]) next = removeEntity(next, entityId);
  return next;
}

export function canUpgradeEntity(state: GameState, entityId: string): boolean {
  const entity = state.entities.find((item) => item.id === entityId);
  if (!entity?.buildingId || entity.kind === "vein") return false;
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
  if (!belt || belt.tier >= 3) return false;
  const targetId = getBeltConstructionId((belt.tier + 1) as BeltTier);
  const definition = getConstructionDefinition(targetId);
  return Boolean(definition &&
    (!definition.requiredTechId || isTechnologyCompleted(state, definition.requiredTechId)) &&
    (state.construction[targetId] ?? 0) >= belt.lanes);
}

export function upgradeBelt(state: GameState, beltId: string): GameState {
  if (!canUpgradeBelt(state, beltId)) return state;
  const current = state.belts.find((belt) => belt.id === beltId)!;
  const sourceId = getBeltConstructionId(current.tier);
  const targetTier = (current.tier + 1) as BeltTier;
  const targetId = getBeltConstructionId(targetTier);
  const next = copyState(state);
  const belt = next.belts.find((candidate) => candidate.id === beltId)!;
  next.construction[targetId] = (next.construction[targetId] ?? 0) - belt.lanes;
  next.construction[sourceId] = (next.construction[sourceId] ?? 0) + belt.lanes;
  belt.tier = targetTier;
  belt.sorterTier = targetTier;
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
  return BELT_CAPACITY_PER_SECOND[belt.tier] * belt.lanes * (belt.stackSize ?? 1);
}

export function getBeltCapacity(belt: BeltConnection): number {
  return BELT_CAPACITY_PER_SECOND[belt.tier] * belt.lanes * (belt.stackSize ?? 1);
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

export function applyBeltConfigurationToNetwork(state: GameState, sourceBeltId: string): GameState {
  const source = state.belts.find((belt) => belt.id === sourceBeltId);
  if (!source) return state;
  const ids = new Set(getBeltNetworkIds(state, sourceBeltId));
  const stackSize = canSetBeltStackSize(state, source.stackSize ?? 1) ? source.stackSize ?? 1 : 1;
  return {
    ...state,
    belts: state.belts.map((belt) => ids.has(belt.id) ? {
      ...belt,
      priority: source.priority,
      stackSize,
      monitorEnabled: source.monitorEnabled,
      routeMode: source.routeMode ?? "auto",
      routeOffsetY: source.routeOffsetY,
      progress: 0,
    } : belt),
  };
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
  const source = state.belts.find((belt) => belt.id === sourceBeltId);
  const target = state.belts.find((belt) => belt.id === targetBeltId);
  if (!source || !target || source.id === target.id) return state;
  const stackSize = canSetBeltStackSize(state, source.stackSize ?? 1) ? source.stackSize ?? 1 : 1;
  return {
    ...state,
    belts: state.belts.map((belt) => belt.id === targetBeltId ? {
      ...belt,
      priority: source.priority,
      stackSize,
      monitorEnabled: source.monitorEnabled,
      routeMode: source.routeMode ?? "auto",
      routeOffsetY: source.routeOffsetY,
      progress: 0,
    } : belt),
  };
}

export function getConstructionCraftDeficits(state: GameState, buildingId: ConstructionId): {
  missingTechnology: string | null;
  missingItems: Array<{ itemId: ItemId; current: number; required: number; missing: number }>;
} {
  const definition = CONSTRUCTION.find((item) => item.buildingId === buildingId);
  if (!definition) return { missingTechnology: null, missingItems: [] };
  return {
    missingTechnology: definition.requiredTechId && !isTechnologyCompleted(state, definition.requiredTechId)
      ? getTechnology(definition.requiredTechId)?.name ?? definition.requiredTechId
      : null,
    missingItems: definition.costs.flatMap((cost) => {
      const current = Math.max(0, Math.floor(state.tray[cost.itemId] ?? 0));
      return current + EPSILON < cost.amount ? [{ itemId: cost.itemId, current, required: cost.amount, missing: cost.amount - current }] : [];
    }),
  };
}

export function canCraftConstruction(state: GameState, buildingId: ConstructionId): boolean {
  const definition = CONSTRUCTION.find((item) => item.buildingId === buildingId);
  if (!definition) return false;
  const deficits = getConstructionCraftDeficits(state, buildingId);
  return !deficits.missingTechnology && deficits.missingItems.length === 0;
}

const NON_HANDCRAFTABLE_RECIPE_IDS = new Set<RecipeId>([
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
  const amount = Math.max(1, Math.floor(batches));
  return Boolean(recipe && isHandcraftableRecipe(recipeId) &&
    (!recipe.requiredTechId || isTechnologyCompleted(state, recipe.requiredTechId)) &&
    recipe.inputs.every((input) => (state.tray[input.itemId] ?? 0) + EPSILON >= input.amount * amount) &&
    canStoreRecipeOutputsInTray(state, recipe, amount));
}

export function handcraftRecipe(state: GameState, recipeId: RecipeId, batches = 1): GameState {
  const amount = Math.max(1, Math.floor(batches));
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

export function queueHandcraftRecipe(state: GameState, recipeId: RecipeId, batches = 1): GameState {
  const amount = Math.max(1, Math.min(100, Math.floor(batches)));
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
  if (techId === "interstellar_logistics") {
    for (const planetId of ["ashen", "giant"] as PlanetId[]) {
      if (!state.exploration.colonizedPlanetIds.includes(planetId)) state.exploration.colonizedPlanetIds.push(planetId);
    }
  }
}

export function canSelectTechnology(state: GameState, techId: TechId): boolean {
  const technology = getTechnology(techId);
  return Boolean(technology && !isTechnologyCompleted(state, techId) && state.research.selectedTechId !== techId &&
    !state.research.queuedTechIds.includes(techId) &&
    technology.prerequisites.every((prerequisite) => isTechnologyCompleted(state, prerequisite)));
}

export function canQueueTechnology(state: GameState, techId: TechId): boolean {
  const technology = getTechnology(techId);
  if (!technology || isTechnologyCompleted(state, techId) || state.research.selectedTechId === techId ||
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
    return next;
  }
  if (!canSelectTechnology(state, techId)) return state;
  const next = copyState(state);
  next.research.selectedTechId = techId;
  if (next.research.pausedTechId === techId) next.research.pausedTechId = null;
  for (const entity of next.entities) {
    if (entity.recipeId === "matrix_research") entity.progress = 0;
  }
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
  return next;
}

export function cancelCurrentResearch(state: GameState): GameState {
  if (!state.research.selectedTechId && !state.endgame?.activeInfiniteResearchId) return state;
  const next = copyState(state);
  next.research.selectedTechId = null;
  if (next.endgame?.activeInfiniteResearchId) next.endgame.activeInfiniteResearchId = null;
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

function dispatchGalacticExportInternal(state: GameState, projectId: GalacticExportProjectId, requested: number): number {
  if (!isEndgameUnlocked(state) || !state.endgame.exportProjects[projectId]) return 0;
  const project = state.endgame.exportProjects[projectId];
  const definition = getGalacticExportDefinition(projectId);
  const reserve = Math.floor(definition.reserve * (1 + project.level * 0.08));
  const available = Math.max(0, networkItemStockForExport(state, definition.itemId) - reserve);
  const shipped = withdrawNetworkItem(state, definition.itemId, Math.min(available, Math.max(0, Math.floor(requested))));
  if (shipped > 0) {
    project.delivered += shipped;
    project.totalDelivered += shipped;
    state.endgame.totalExported += shipped;
    state.endgame.exportWindowAmount += shipped;
    state.endgame.galacticCredits = Math.floor(state.endgame.galacticCredits + shipped * definition.creditsPerItem);
    state.endgame.galacticScore = Math.floor(state.endgame.galacticScore + shipped * definition.creditsPerItem);
    completeGalacticExportLevels(state, projectId);
  }
  return shipped;
}

export function dispatchGalacticExport(state: GameState, projectId: GalacticExportProjectId, amount?: number): GameState {
  if (!isEndgameUnlocked(state) || !state.endgame.exportProjects[projectId]) return state;
  const next = copyState(state);
  const definition = getGalacticExportDefinition(projectId);
  dispatchGalacticExportInternal(next, projectId, amount ?? definition.baseRatePerMinute);
  return next;
}

function runGalacticExports(state: GameState, seconds: number): void {
  if (!isEndgameUnlocked(state) || !state.endgame.autoDispatch || seconds <= EPSILON) return;
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
  const infinite = isInfiniteResource(entity.resourceId, entity.planetId, state.settings.resourceMode, state.galaxy);
  if (infinite) {
    return { infinite: true, exhausted: false, remaining: null, capacity: null, remainingRatio: 1, remainingPercent: 100 };
  }
  const remaining = Math.max(0, Math.floor(entity.resourceRemaining ?? 0));
  const capacity = Math.max(remaining, Math.floor(entity.resourceCapacity ?? remaining));
  const remainingRatio = capacity > 0 ? Math.max(0, Math.min(1, remaining / capacity)) : 0;
  return {
    infinite: false,
    exhausted: remaining < 1,
    remaining,
    capacity,
    remainingRatio,
    remainingPercent: Math.round(remainingRatio * 100),
  };
}

export function getEntityOperatingStatus(state: GameState, entity: FactoryEntity): EntityOperatingStatus {
  if (state.paused) return { code: "paused", label: "模拟已暂停", tone: "idle" };
  const entityPowerFactor = getEntityPowerFactor(state, entity);

  if (entity.kind === "vein") {
    if (getResourceReserveSnapshot(state, entity)?.exhausted) {
      return { code: "resource-depleted", label: "资源已枯竭", tone: "blocked" };
    }
    if (entity.minerCount < 1) return {
      code: "idle",
      label: ITEMS[entity.resourceId!].kind === "fluid" ? `等待${extractorFor(entity).shortName}` : "可手动采集",
      tone: "idle",
    };
    const extractor = extractorFor(entity);
    const capacity = extractor.outputCapacity * entity.minerCount;
    if ((entity.outputs[entity.resourceId!] ?? 0) >= capacity - EPSILON) {
      return { code: "output-blocked", label: "输出缓存已满", tone: "blocked" };
    }
    if (entityPowerFactor <= EPSILON) return { code: "no-power", label: powerCoverageLabel(state, entity), tone: "blocked" };
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
    if (itemOutputFree(entity, outputId) < 1) return { code: "output-blocked", label: `${ITEMS[outputId].name}输出已满`, tone: "blocked" };
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
      const yields = getPlanetOrbitalYields(state, entity.planetId);
      const itemId = entity.storedItemId && (yields[entity.storedItemId] ?? 0) > 0
        ? entity.storedItemId
        : (Object.keys(yields)[0] as ItemId | undefined) ?? "hydrogen";
      const capacity = getEntityOutputCapacity(entity);
      if ((entity.outputs[itemId] ?? 0) >= capacity - EPSILON) {
        return { code: "output-blocked", label: `${ITEMS[itemId].name}储量已满`, tone: "blocked" };
      }
      return { code: "collecting", label: `轨道采集${ITEMS[itemId].name}中`, tone: "running" };
    }
    const slots = getStationSlots(entity);
    const configured = slots.map((slot, slotIndex) => ({ slot, slotIndex })).filter(({ slot }) => slot.itemId);
    if (configured.length === 0) return { code: "unconfigured", label: "未配置物流槽位", tone: "blocked" };
    const activeRoutes = stationActiveRoutes(state, entity).map(({ route }) => route);
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
        const match = findStationSlotPeer(state, entity, slotIndex, scope);
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
        const minimumCargo = getStationMinimumCargo(state, demand, demandSlotIndex, scope);
        const free = Math.floor(Math.max(0, getStationSlotCapacity(demand, demandSlot) -
          (demand.outputs[itemId] ?? 0) - stationInFlightCargo(demand, itemId)));
      const available = Math.floor(Math.max(0, (supply.outputs[itemId] ?? 0) - supplySlot.minStock -
        stationReservedOutgoing(state, supply.id, itemId)));
        const vehicleOwners = [demand, supply].filter((candidate, index, all) =>
          candidate.buildingId !== "orbital_collector" && all.findIndex((entry) => entry.id === candidate.id) === index);
        if (!vehicleOwners.some((owner) => stationInstalledVehicles(owner, scope) - stationBusyVehicles(state, owner, scope) > 0)) {
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
        if (requiresWarp && (!isTechnologyCompleted(state, "space_warp") || !vehicleOwners.some((owner) =>
          owner.stationWarpEnabled && (owner.stationWarpers ?? 0) >= (economics?.warpersPerVessel ?? 1)))) {
          return { code: "missing-warper", label: `跨恒星航线需要 ${economics?.warpersPerVessel ?? 1} 个翘曲器/船`, tone: "blocked" };
        }
        if (free < minimumCargo) {
          outputBlocked = true;
          continue;
        }
        if (available < minimumCargo) {
          waitingLoad = true;
          continue;
        }
        const hubPower = economics?.waypointStationIds.reduce((factor, stationId) => {
          const station = state.entities.find((candidate) => candidate.id === stationId);
          return Math.min(factor, station ? getEntityPowerFactor(state, station) : 0);
        }, 1) ?? 1;
        const routePower = scope === "local"
          ? Math.max(...vehicleOwners.map((owner) => getEntityPowerFactor(state, owner)))
          : Math.min(entityPowerFactor, getEntityPowerFactor(state, match.peer), hubPower);
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
      const flowing = state.belts.some((belt) => belt.target === entity.id && belt.lastFlow > 0.001);
      return flowing
        ? { code: "running", label: "物资直送托盘中", tone: "running" }
        : { code: "missing-input", label: `等待物料 · ${configured.length}/${MATERIAL_DELIVERY_SLOT_COUNT} 接口`, tone: "idle" };
    }
    if (!entity.storedItemId) return { code: "unconfigured", label: "未选择物流物品", tone: "blocked" };
    const flowing = state.belts.some((belt) => (belt.source === entity.id || belt.target === entity.id) && belt.lastFlow > 0.001);
    if (flowing) return { code: "running", label: "物流运行中", tone: "running" };
    const buffered = (entity.inputs[entity.storedItemId] ?? 0) + (entity.outputs[entity.storedItemId] ?? 0);
    return buffered > 0
      ? { code: "idle", label: "等待下游取货", tone: "idle" }
      : { code: "missing-input", label: "等待物料", tone: "idle" };
  }

  if (entity.buildingId === "construction_center") {
    if (!state.constructionAutomation.enabled) return { code: "paused", label: "自动制造已关闭", tone: "idle" };
    if (!constructionAutomationHasDeficit(state)) return { code: "grid-standby", label: "目标库存已满足", tone: "idle" };
    if (entityPowerFactor <= EPSILON) return { code: "no-power", label: powerCoverageLabel(state, entity), tone: "blocked" };
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

  if (entity.buildingId === "ray_receiver") {
    const capacity = getEntityOutputCapacity(entity);
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
      ? { code: "running", label: `向电网输出 ${receivedKw.toFixed(0)} kW`, tone: "running" }
      : { code: "running", label: "临界光子生成中", tone: "running" };
  }

  if (entity.buildingId) {
    const capacity = getEntityOutputCapacity(entity);
    const extraProductBonus = getEntityExtraProductBonus(entity);
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

  if (proliferatorApplies(entity, recipe) && Math.floor(availableProliferatorCycles(entity, recipe) + EPSILON) < 1) {
    const itemId = getEntityProliferatorItemId(entity)!;
    return { code: "missing-proliferator", label: `缺少${ITEMS[itemId].name}`, tone: "blocked" };
  }

  if (entityPowerFactor <= EPSILON) return { code: "no-power", label: powerCoverageLabel(state, entity), tone: "blocked" };
  if (entityPowerFactor < 0.999) {
    return { code: "low-power", label: `供电不足 · ${Math.round(entityPowerFactor * 100)}%`, tone: "warning" };
  }

  return { code: "running", label: "运行中", tone: "running" };
}

export function getAcceptedInputs(entity: FactoryEntity, state?: GameState): ItemId[] {
  if (entity.buildingId === "material_delivery_hub") return getMaterialDeliveryItems(entity);
  if (entity.kind === "station" && entity.buildingId !== "orbital_collector") {
    return getStationSlots(entity).flatMap((slot) => slot.itemId ? [slot.itemId] : []);
  }
  if ((entity.kind === "storage" || entity.kind === "splitter" || entity.kind === "station") && entity.storedItemId) return [entity.storedItemId];
  if (entity.buildingId === "thermal_power_plant" && entity.fuelItemId) return [entity.fuelItemId];
  if (entity.recipeId === "matrix_research" && state) return [...MATRIX_ITEM_IDS];
  const recipeInputs = getRecipe(entity.recipeId)?.inputs.map((input) => input.itemId) ?? [];
  const proliferatorItemId = entity.sprayCoaterInstalled ? getEntityProliferatorItemId(entity) : undefined;
  return proliferatorItemId ? [...recipeInputs, proliferatorItemId] : recipeInputs;
}

export function getProducedOutputs(entity: FactoryEntity): ItemId[] {
  if (entity.buildingId === "material_delivery_hub" || entity.buildingId === "construction_center") return [];
  if (entity.kind === "vein" && entity.resourceId) return [entity.resourceId];
  if (entity.kind === "station" && entity.buildingId !== "orbital_collector") {
    return getStationSlots(entity).flatMap((slot) => slot.itemId ? [slot.itemId] : []);
  }
  if ((entity.kind === "storage" || entity.kind === "splitter" || entity.kind === "station") && entity.storedItemId) return [entity.storedItemId];
  return getRecipe(entity.recipeId)?.outputs.map((output) => output.itemId) ?? [];
}
