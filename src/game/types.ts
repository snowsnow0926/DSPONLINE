import type { XYPosition } from "@xyflow/react";

export type StarSystemId =
  | "helios"
  | "borealis"
  | "aurora"
  | "ember"
  | "sirius"
  | "white_dwarf"
  | "neutron"
  | "blue_giant";

export type PlanetId =
  | "home"
  | "ashen"
  | "giant"
  | "frost"
  | "boreal_giant"
  | "magnetar"
  | "verdant"
  | "pelagic"
  | "aurora_giant"
  | "dune"
  | "cinder"
  | "ember_giant"
  | "crystal"
  | "prairie"
  | "sirius_giant"
  | "salt"
  | "obsidian"
  | "white_giant"
  | "tempest"
  | "inferno"
  | "abyss"
  | "azure_giant";

export type PlanetTemplateId =
  | "oceanic"
  | "lava"
  | "ice_field"
  | "tidal_locked"
  | "mediterranean"
  | "prairie"
  | "savanna"
  | "desert"
  | "arid_canyon"
  | "salt_lake"
  | "volcanic_ash"
  | "crystal_desert"
  | "gas_giant"
  | "ice_giant"
  | "hydrogen_giant"
  | "fire_ice_giant";

export type PlanetOceanType = "water" | "sulfuric-acid" | "lava" | "ice" | "none";

export type StarClassId =
  | "g_main"
  | "k_dwarf"
  | "f_main"
  | "m_dwarf"
  | "a_main"
  | "white_dwarf"
  | "neutron_star"
  | "o_blue_giant";

export type ItemId =
  | "iron_ore"
  | "copper_ore"
  | "coal"
  | "stone"
  | "crude_oil"
  | "silicon_ore"
  | "titanium_ore"
  | "fire_ice"
  | "kimberlite_ore"
  | "fractal_silicon"
  | "optical_grating_crystal"
  | "spiniform_stalagmite_crystal"
  | "unipolar_magnet"
  | "water"
  | "sulfuric_acid"
  | "iron_ingot"
  | "copper_ingot"
  | "magnet"
  | "stone_brick"
  | "glass"
  | "steel"
  | "gear"
  | "magnetic_coil"
  | "circuit_board"
  | "prism"
  | "plasma_exciter"
  | "energetic_graphite"
  | "refined_oil"
  | "hydrogen"
  | "high_purity_silicon"
  | "titanium_ingot"
  | "titanium_alloy"
  | "microcrystalline_component"
  | "processor"
  | "logistics_drone"
  | "logistics_vessel"
  | "space_warper"
  | "accumulator"
  | "charged_accumulator"
  | "graphene"
  | "carbon_nanotube"
  | "proliferator_mk1"
  | "proliferator_mk2"
  | "proliferator_mk3"
  | "crystal_silicon"
  | "particle_broadband"
  | "electric_motor"
  | "electromagnetic_turbine"
  | "super_magnetic_ring"
  | "particle_container"
  | "deuterium"
  | "hydrogen_fuel_rod"
  | "deuteron_fuel_rod"
  | "titanium_glass"
  | "casimir_crystal"
  | "plane_filter"
  | "quantum_chip"
  | "strange_matter"
  | "graviton_lens"
  | "photon_combiner"
  | "solar_sail"
  | "critical_photon"
  | "antimatter"
  | "annihilation_constraint_sphere"
  | "antimatter_fuel_rod"
  | "frame_material"
  | "dyson_sphere_component"
  | "small_carrier_rocket"
  | "diamond"
  | "plastic"
  | "organic_crystal"
  | "titanium_crystal"
  | "electromagnetic_matrix"
  | "energy_matrix"
  | "structure_matrix"
  | "information_matrix"
  | "gravity_matrix"
  | "universe_matrix";

export type PortableFleetItemId = "logistics_drone" | "logistics_vessel";

export type TechId =
  | "electromagnetic_matrix"
  | "electromagnetism"
  | "basic_logistics"
  | "thermal_power"
  | "solar_energy"
  | "energy_storage"
  | "geothermal_power"
  | "fractionation"
  | "high_efficiency_plasma_control"
  | "energy_matrix"
  | "xray_cracking"
  | "high_strength_crystal"
  | "basic_chemical_engineering"
  | "polymer_chemistry"
  | "structure_matrix"
  | "titanium_alloy"
  | "processor"
  | "planetary_logistics"
  | "interstellar_logistics"
  | "orbital_collection"
  | "space_warp"
  | "stellar_exploration"
  | "nanomaterials"
  | "rare_resource_utilization"
  | "quantum_chemical_engineering"
  | "information_matrix"
  | "research_speed_1"
  | "miniature_particle_collider"
  | "fusion_power"
  | "quantum_chip"
  | "gravity_matrix"
  | "research_speed_2"
  | "dyson_swarm"
  | "ray_receiver"
  | "antimatter"
  | "artificial_star"
  | "universe_matrix"
  | "research_speed_3"
  | "high_speed_assembling"
  | "high_speed_logistics"
  | "mining_speed_1"
  | "mining_speed_2"
  | "mining_speed_3"
  | "logistics_engine_1"
  | "logistics_engine_2"
  | "logistics_capacity_1"
  | "logistics_capacity_2"
  | "solar_sail_life_1"
  | "solar_sail_life_2"
  | "ray_transmission_1"
  | "ray_transmission_2"
  | "dyson_absorption_1"
  | "plane_smelting"
  | "quantum_printing"
  | "super_magnetic_logistics"
  | "proliferator_1"
  | "proliferator_2"
  | "proliferator_3"
  | "material_delivery_logistics"
  | "construction_automation"
  | "construction_capacity_1"
  | "construction_capacity_2"
  | "dyson_sphere_program"
  | "vertical_launching_silo"
  | "dyson_shell";

export type BuildingId =
  | "wind_turbine"
  | "solar_panel"
  | "geothermal_power_station"
  | "thermal_power_plant"
  | "mini_fusion_power_plant"
  | "artificial_star"
  | "accumulator"
  | "energy_exchanger"
  | "mining_machine"
  | "arc_smelter"
  | "plane_smelter"
  | "assembling_machine_mk1"
  | "assembling_machine_mk2"
  | "assembling_machine_mk3"
  | "spray_coater"
  | "matrix_lab"
  | "oil_extractor"
  | "oil_refinery"
  | "water_pump"
  | "chemical_plant"
  | "quantum_chemical_plant"
  | "fractionator"
  | "miniature_particle_collider"
  | "em_rail_ejector"
  | "ray_receiver"
  | "vertical_launching_silo"
  | "planetary_logistics_station"
  | "interstellar_logistics_station"
  | "orbital_collector"
  | "storage_mk1"
  | "material_delivery_hub"
  | "storage_tank"
  | "splitter_4way"
  | "construction_center";

export type BeltTier = 1 | 2 | 3;
export type SorterTier = 1 | 2 | 3;
export type BeltRouteMode = "bezier" | "auto" | "upper" | "lower" | "manual";
export type ProliferatorTier = 1 | 2 | 3;
export type ProliferatorMode = "normal" | "extra" | "speed";
export type ConveyorBeltId = "conveyor_belt_mk1" | "conveyor_belt_mk2" | "conveyor_belt_mk3";
export type SorterId = "sorter_mk1" | "sorter_mk2" | "sorter_mk3";
export type ConstructionId = BuildingId | ConveyorBeltId | SorterId;

export type RecipeId =
  | "iron_ingot"
  | "copper_ingot"
  | "magnet"
  | "stone_brick"
  | "glass"
  | "steel"
  | "gear"
  | "magnetic_coil"
  | "circuit_board"
  | "prism"
  | "plasma_exciter"
  | "energetic_graphite"
  | "plasma_refining"
  | "xray_cracking"
  | "high_purity_silicon"
  | "silicon_ore_from_stone"
  | "titanium_ingot"
  | "sulfuric_acid"
  | "titanium_alloy"
  | "microcrystalline_component"
  | "processor"
  | "logistics_drone"
  | "logistics_vessel"
  | "space_warper"
  | "accumulator"
  | "accumulator_charge"
  | "accumulator_discharge"
  | "hydrogen_fuel_rod"
  | "deuterium_fractionation"
  | "graphene_from_fire_ice"
  | "diamond_from_kimberlite"
  | "crystal_silicon_from_fractal"
  | "photon_combiner_from_grating"
  | "casimir_crystal_advanced"
  | "carbon_nanotube_from_spiniform"
  | "particle_container_from_unipolar"
  | "graphene"
  | "carbon_nanotube"
  | "proliferator_mk1"
  | "proliferator_mk2"
  | "proliferator_mk3"
  | "crystal_silicon"
  | "particle_broadband"
  | "electric_motor"
  | "electromagnetic_turbine"
  | "super_magnetic_ring"
  | "particle_container"
  | "deuterium"
  | "deuteron_fuel_rod"
  | "titanium_glass"
  | "casimir_crystal"
  | "plane_filter"
  | "quantum_chip"
  | "strange_matter"
  | "graviton_lens"
  | "photon_combiner"
  | "solar_sail"
  | "solar_sail_launch"
  | "ray_power"
  | "critical_photon"
  | "antimatter"
  | "annihilation_constraint_sphere"
  | "antimatter_fuel_rod"
  | "frame_material"
  | "dyson_sphere_component"
  | "small_carrier_rocket"
  | "carrier_rocket_launch"
  | "diamond"
  | "plastic"
  | "organic_crystal"
  | "titanium_crystal"
  | "electromagnetic_matrix"
  | "energy_matrix"
  | "structure_matrix"
  | "information_matrix"
  | "gravity_matrix"
  | "universe_matrix"
  | "matrix_research";

export type EntityKind = "vein" | "machine" | "power" | "storage" | "splitter" | "station";
export type PlacementCount = 1 | 2 | 5 | 10;
export type StationMinimumLoad = 0.1 | 0.25 | 0.5 | 1;
export type StationLogisticsMode = "supply" | "demand" | "storage";
export type StationLogisticsScope = "local" | "remote";
export type LogisticsPriority = 0 | 1 | 2;
export type CargoStackSize = 1 | 2 | 4;
export type EnergyMode = "auto" | "charge" | "discharge";
export type PowerGridId = "grid-a" | "grid-b" | "grid-c";
export type PowerPriority = 1 | 2 | 3;
export type ResourceMode = "finite" | "infinite";
/** Runtime balance preset. Missing values in legacy saves migrate to standard. */
export type DifficultyMode = "relaxed" | "standard" | "hard";
export type RecipeFocusMode = "full" | "two-level";
export type SimulationSpeed = 1 | 2 | 4;
export type AutosaveIntervalSeconds = 30 | 60 | 120;
export type FontScale = 0.8 | 1 | 1.25 | 1.5 | 2;

/** Repeatable endgame research tracks unlocked after the universe matrix. */
export type InfiniteResearchId =
  | "matrix_compression"
  | "vein_utilization"
  | "galactic_logistics"
  | "stellar_harnessing"
  | "continuum_simulation";

export type GalacticExportProjectId =
  | "universe_archive"
  | "solar_sail_array"
  | "carrier_rocket_fleet"
  | "antimatter_exchange";

export type GalacticDispatchThrottle = 0.25 | 0.5 | 1;

export interface InfiniteResearchProgress {
  level: number;
  /** Universe matrices invested into the next level. */
  progress: number;
}

export interface GalacticExportProjectState {
  id: GalacticExportProjectId;
  enabled: boolean;
  priority: LogisticsPriority;
  level: number;
  /** Items delivered toward the current project level. */
  delivered: number;
  totalDelivered: number;
  /** Fractional dispatch budget retained between simulation steps. */
  dispatchProgress: number;
}

export interface EndgameState {
  activeInfiniteResearchId: InfiniteResearchId | null;
  autoResearch: boolean;
  autoDispatch: boolean;
  dispatchThrottle: GalacticDispatchThrottle;
  exportProjects: Record<GalacticExportProjectId, GalacticExportProjectState>;
  galacticCredits: number;
  galacticScore: number;
  totalExported: number;
  exportedLastMinute: number;
  exportWindowAmount: number;
  exportWindowStartedAt: number;
  infiniteResearch: Record<InfiniteResearchId, InfiniteResearchProgress>;
}

export type AchievementId =
  | "first_manual_mine"
  | "automated_mining"
  | "first_logistics_line"
  | "stable_power_grid"
  | "electromagnetic_matrix_online"
  | "energy_matrix_online"
  | "six_matrix_mastery"
  | "planetary_logistics_online"
  | "interstellar_delivery"
  | "rare_resource_harvest"
  | "dyson_swarm_online"
  | "permanent_dyson_structure"
  | "multi_system_industry";

export type CampaignChapterId =
  | "foundation"
  | "blue_matrix"
  | "red_matrix"
  | "planetary_logistics"
  | "interstellar_logistics"
  | "matrix_mastery"
  | "dyson_program"
  | "galactic_endgame";

export type CampaignTaskId =
  | "mine_first_ore"
  | "smelt_iron"
  | "deploy_miner"
  | "lay_first_belt"
  | "deploy_matrix_lab"
  | "produce_blue_matrix"
  | "refine_oil"
  | "produce_plastic"
  | "produce_red_matrix"
  | "deploy_planetary_station"
  | "complete_planetary_trip"
  | "produce_structure_matrix"
  | "unlock_borealis"
  | "deploy_interstellar_station"
  | "complete_interstellar_trip"
  | "produce_information_matrix"
  | "produce_gravity_matrix"
  | "produce_universe_matrix"
  | "launch_solar_sail"
  | "launch_carrier_rocket"
  | "build_dyson_structure"
  | "absorb_shell_sail"
  | "side_storage"
  | "side_stable_power"
  | "side_belt_upgrade"
  | "side_rare_resource"
  | "side_spray_coater"
  | "side_blueprint"
  | "endgame_infinite_research"
  | "endgame_export"
  | "endgame_score"
  | "endgame_mastery";

export interface CampaignState {
  activeChapterId: CampaignChapterId;
  activeTaskId: CampaignTaskId | null;
  completedTaskIds: CampaignTaskId[];
  rewardedTaskIds: CampaignTaskId[];
}

export interface ItemAmount {
  itemId: ItemId;
  amount: number;
}

export interface ItemDefinition {
  id: ItemId;
  name: string;
  symbol: string;
  color: string;
  kind: "solid" | "fluid" | "matrix";
  description: string;
}

export interface PlanetDefinition {
  id: PlanetId;
  name: string;
  code: string;
  color: string;
  environment: string;
  resources: string;
  kind: "terrestrial" | "gas-giant";
  defaultTemplateId: PlanetTemplateId;
  systemId: StarSystemId;
  orbitIndex: number;
  solarMultiplier: number;
  orbitalYields?: Partial<Record<ItemId, number>>;
}

export interface StarSystemDefinition {
  id: StarSystemId;
  name: string;
  code: string;
  starType: string;
  defaultStarClassId: StarClassId;
  color: string;
  distanceLy: number;
  description: string;
  planetIds: PlanetId[];
  explorationCost: ItemAmount[];
  requiredTechId?: TechId;
  prerequisiteSystemId?: StarSystemId;
}

export interface RecipeDefinition {
  id: RecipeId;
  name: string;
  buildingId: BuildingId;
  duration: number;
  inputs: ItemAmount[];
  outputs: ItemAmount[];
  requiredTechId?: TechId;
}

export interface BuildingDefinition {
  id: BuildingId;
  name: string;
  shortName: string;
  kind: "machine" | "miner" | "power" | "storage" | "splitter" | "station";
  powerDemandKw?: number;
  powerGenerationKw?: number;
  powerChargeKw?: number;
  energyCapacityMj?: number;
  speed: number;
  inputCapacity: number;
  outputCapacity: number;
  accepts?: "solid" | "fluid" | "any";
  tier?: BeltTier;
  family?: "smelter" | "assembler" | "chemical";
  megastructure?: boolean;
  description: string;
}

export interface ConstructionDefinition {
  buildingId: ConstructionId;
  name: string;
  outputAmount: number;
  costs: ItemAmount[];
  requiredTechId?: TechId;
}

export interface TechnologyDefinition {
  id: TechId;
  name: string;
  summary: string;
  costs: ItemAmount[];
  tier: number;
  prerequisites: TechId[];
  unlocks: string[];
}

export interface FactoryEntity {
  id: string;
  kind: EntityKind;
  planetId: PlanetId;
  position: XYPosition;
  resourceId?: ItemId;
  buildingId?: BuildingId;
  extractorBuildingId?: BuildingId;
  recipeId?: RecipeId;
  storedItemId?: ItemId;
  /** Up to three item types routed directly into this planet's material tray. */
  deliveryItemIds?: ItemId[];
  distributionMode?: "balanced" | "priority";
  fuelItemId?: ItemId;
  fuelRemainingMj?: number;
  powerOutputKw?: number;
  powerInputKw?: number;
  /** Last simulated power allocation for this entity, separate from work utilization. */
  powerFactor?: number;
  storedEnergyMj?: number;
  energyMode?: EnergyMode;
  powerGridId?: PowerGridId;
  powerPriority?: PowerPriority;
  generationPriority?: PowerPriority;
  resourceRemaining?: number;
  resourceCapacity?: number;
  stationMode?: "supply" | "demand";
  stationProgress?: number;
  stationTrips?: number;
  stationLastTransfer?: number;
  stationPeerId?: string;
  stationDrones?: number;
  stationVessels?: number;
  stationWarpers?: number;
  stationWarpEnabled?: boolean;
  stationWarperAutoRefill?: boolean;
  stationWarperTarget?: number;
  stationHubEnabled?: boolean;
  stationHubPriority?: LogisticsPriority;
  stationMinimumLoad?: StationMinimumLoad;
  stationSlots?: StationSlot[];
  stationRoutes?: StationRoute[];
  stationDispatchCursor?: number;
  stationCongestion?: number;
  sprayCoaterInstalled?: boolean;
  proliferatorTier?: ProliferatorTier;
  proliferatorMode?: ProliferatorMode;
  proliferatorPoints?: number;
  proliferatorBonusProgress?: Partial<Record<ItemId, number>>;
  routingCursor: number;
  machineCount: number;
  minerCount: number;
  inputs: Partial<Record<ItemId, number>>;
  outputs: Partial<Record<ItemId, number>>;
  progress: number;
  utilization: number;
  productionRate: number;
}

export interface BeltConnection {
  id: string;
  planetId: PlanetId;
  source: string;
  target: string;
  itemId: ItemId;
  lanes: number;
  tier: BeltTier;
  sorterTier: SorterTier;
  progress: number;
  priority: LogisticsPriority;
  stackSize?: CargoStackSize;
  monitorEnabled?: boolean;
  totalTransferred?: number;
  congestion?: number;
  lastFlow: number;
  routeMode?: BeltRouteMode;
  routeOffsetY?: number;
}

export interface StationSlot {
  itemId?: ItemId;
  localMode: StationLogisticsMode;
  remoteMode: StationLogisticsMode;
  minimumLoad: StationMinimumLoad;
  minStock: number;
  maxStock: number;
  priority: LogisticsPriority;
  routePolicy: InterstellarRoutePolicy;
  warperBudget: number;
}

export interface StationSlotTemplate {
  itemId: ItemId;
  localMode: StationLogisticsMode;
  remoteMode: StationLogisticsMode;
  minimumLoad: StationMinimumLoad;
  minStock: number;
  maxStock: number;
  priority: LogisticsPriority;
  routePolicy?: InterstellarRoutePolicy;
  warperBudget?: number;
}

export type InterstellarRoutePolicy = "direct" | "relay-preferred" | "relay-required";

export interface StationRoute {
  id: string;
  slotIndex: number;
  peerId: string;
  itemId: ItemId;
  scope: StationLogisticsScope;
  cargo: number;
  vehicleCount: number;
  progress: number;
  duration: number;
  requiresWarp: boolean;
  waypointStationIds?: string[];
  distanceLy?: number;
  warpersPerVessel?: number;
  /** Station whose installed fleet is occupied by this route. Legacy routes use the demand station. */
  vehicleStationId?: string;
}

export type DraggedItemSourceKind = "node" | "node-input" | "tray";

export interface CargoStack {
  itemId: ItemId;
  amount: number;
  origin?: { kind: "node-output" | "node-input" | "tray"; id?: string };
}

export interface FactoryMetrics {
  generationKw: number;
  demandKw: number;
  powerFactor: number;
  windGenerationKw: number;
  solarGenerationKw: number;
  geothermalGenerationKw: number;
  thermalGenerationKw: number;
  fusionGenerationKw: number;
  artificialStarGenerationKw: number;
  rayGenerationKw: number;
  storageDischargeKw: number;
  storageChargeKw: number;
  storedEnergyMj: number;
  storageCapacityMj: number;
  fuelReserveSeconds: number;
  totalItemsPerMinute: number;
}

export interface PowerGridMetrics extends FactoryMetrics {
  gridId: PowerGridId;
  connectedEntities: number;
  disconnectedEntities: number;
  generatorCount: number;
  coverageRadius: number;
}

export interface DysonSwarmState {
  sailsInOrbit: number;
  totalLaunched: number;
  totalExpired: number;
  decayProgress: number;
  generationKw: number;
  receiverLoadKw: number;
}

export interface DysonSphereState {
  structurePoints: number;
  totalRocketsLaunched: number;
  shellSails: number;
  totalSailsAbsorbed: number;
  absorptionProgress: number;
  generationKw: number;
}

export type DysonLaunchMode = "balanced" | "swarm" | "sphere";
export type DysonLaunchThrottle = 0.25 | 0.5 | 0.75 | 1;

export interface DysonSwarmOrbitState {
  id: string;
  name: string;
  radius: number;
  inclination: number;
  longitude: number;
  sailsInOrbit: number;
  totalLaunched: number;
  totalExpired: number;
  decayProgress: number;
  generationKw: number;
}

export interface DysonEngineeringState {
  launchMode: DysonLaunchMode;
  launchThrottle: DysonLaunchThrottle;
  launchEnabled: boolean;
  activeOrbitBySystem: Record<StarSystemId, string | null>;
  orbitsBySystem: Record<StarSystemId, DysonSwarmOrbitState[]>;
  absorptionProgressBySystem: Record<StarSystemId, number>;
  launchEnergySpentMj: number;
}

export interface DysonEngineeringSnapshot {
  systemId: StarSystemId;
  launchMode: DysonLaunchMode;
  launchThrottle: DysonLaunchThrottle;
  launchEnabled: boolean;
  orbitCount: number;
  orbitSails: number;
  queuedSails: number;
  queuedRockets: number;
  sailLaunchesPerMinute: number;
  rocketLaunchesPerMinute: number;
  launchEnergyPerSailMj: number;
  launchEnergyPerRocketMj: number;
  launchEnergyPerMinuteMj: number;
  launchEnergySpentMj: number;
  rayGenerationKw: number;
  receiverCapacityKw: number;
  receiverLoadKw: number;
  rayEfficiency: number;
  criticalPhotonPerMinute: number;
  antimatterPerMinute: number;
  feedbackGenerationKw: number;
  plannedStructurePoints: number;
  completedStructurePoints: number;
  remainingStructurePoints: number;
  shellCapacity: number;
  shellSails: number;
  projectedGenerationKw: number;
}

export interface DysonNodeState {
  id: string;
  angle: number;
  requiredStructurePoints: number;
  completedStructurePoints: number;
}

export interface DysonFrameState {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  requiredStructurePoints: number;
  completedStructurePoints: number;
}

export interface DysonShellState {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  boundaryFrameIds: string[];
  sailCapacity: number;
  absorbedSails: number;
}

export interface DysonLayerState {
  id: string;
  name: string;
  radius: number;
  inclination: number;
  longitude: number;
  nodes: DysonNodeState[];
  frames: DysonFrameState[];
  shells: DysonShellState[];
}

export interface DysonSpherePlanState {
  systemId: StarSystemId;
  activeLayerId: string | null;
  structurePoints: number;
  shellSails: number;
  layers: DysonLayerState[];
}

export interface EntityOperatingStatus {
  code:
    | "running"
    | "idle"
    | "paused"
    | "missing-recipe"
    | "missing-research"
    | "missing-input"
    | "output-blocked"
    | "no-power"
    | "low-power"
    | "missing-fuel"
    | "resource-depleted"
    | "missing-proliferator"
    | "no-fuel-selected"
    | "grid-standby"
    | "missing-route"
    | "missing-vessel"
    | "missing-drone"
     | "missing-warper"
     | "missing-hub"
    | "waiting-load"
    | "collecting"
    | "missing-dyson-swarm"
    | "launch-paused"
    | "unconfigured";
  label: string;
  tone: "running" | "warning" | "blocked" | "idle";
}

export interface ResearchState {
  selectedTechId: TechId | null;
  pausedTechId: TechId | null;
  queuedTechIds: TechId[];
  progressByTech: Partial<Record<TechId, Partial<Record<ItemId, number>>>>;
  completedTechIds: TechId[];
}

export interface ExplorationState {
  unlockedSystemIds: StarSystemId[];
  colonizedPlanetIds: PlanetId[];
  missions: ExplorationMission[];
  surveyProgressBySystem: Partial<Record<StarSystemId, number>>;
}

export interface ExplorationMission {
  systemId: StarSystemId;
  elapsedSeconds: number;
  durationSeconds: number;
}

export type PlanetSpecialization = "balanced" | "smelting" | "chemical" | "logistics" | "research" | "particle";

export type PlanetIndustryRole =
  | "auto"
  | "mining"
  | "smelting"
  | "manufacturing"
  | "chemical"
  | "research"
  | "logistics"
  | "power";

export interface PlanetIndustrialProfile {
  planetId: PlanetId;
  templateId: PlanetTemplateId;
  climateName: string;
  resourceIds: ItemId[];
  rareResourceIds: ItemId[];
  oceanType: PlanetOceanType;
  orbitalYields: Partial<Record<ItemId, number>>;
  windMultiplier: number;
  solarMultiplier: number;
  geothermalMultiplier: number;
  miningMultiplier: number;
  orbitalYieldMultiplier: number;
  reserveScale: number;
  travelTimeMultiplier: number;
  tidalLocked: boolean;
  sulfuricOcean: boolean;
  specialization: PlanetSpecialization;
  specializationName: string;
  productionSpeedMultiplier: number;
  colonyCost: ItemAmount[];
  surveyDurationSeconds: number;
}

export interface StarSystemProfile {
  systemId: StarSystemId;
  starClassId: StarClassId;
  starTypeName: string;
  luminosity: number;
  massMultiplier: number;
  radiusMultiplier: number;
  positionX: number;
  positionY: number;
  distanceFromOriginLy: number;
}

export interface GalaxyState {
  seed: number;
  profiles: Record<PlanetId, PlanetIndustrialProfile>;
  systemProfiles: Record<StarSystemId, StarSystemProfile>;
  planetRoles: Record<PlanetId, PlanetIndustryRole>;
}

export interface RecipeFocusState {
  itemId: ItemId | null;
  mode: RecipeFocusMode;
  position: XYPosition;
}

export interface GameSettings {
  simulationSpeed: SimulationSpeed;
  fontScale: FontScale;
  theme: ThemeMode;
  technologyLayout: TechnologyLayoutMode;
  performanceMode: boolean;
  reducedMotion: boolean;
  soundEnabled: boolean;
  allowDoubleClickZoom: boolean;
  beltHeatmapEnabled: boolean;
  autosaveIntervalSeconds: AutosaveIntervalSeconds;
  resourceMode: ResourceMode;
  difficulty: DifficultyMode;
}

export type ThemeMode = "dark" | "light" | "system";
export type TechnologyLayoutMode = "standard" | "compact";

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasBookmark {
  id: string;
  name: string;
  planetId: PlanetId;
  viewport: { x: number; y: number; zoom: number };
  createdAtSeconds: number;
}

export interface CanvasRegion {
  id: string;
  name: string;
  planetId: PlanetId;
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor: string;
  borderColor: string;
}

export interface AchievementState {
  unlockedIds: AchievementId[];
}

export interface BlueprintEntityTemplate {
  key: string;
  buildingId: BuildingId;
  offset: XYPosition;
  machineCount: number;
  recipeId?: RecipeId;
  storedItemId?: ItemId;
  deliveryItemIds?: ItemId[];
  distributionMode?: "balanced" | "priority";
  fuelItemId?: ItemId;
  energyMode?: EnergyMode;
  powerGridId?: PowerGridId;
  powerPriority?: PowerPriority;
  generationPriority?: PowerPriority;
  stationMode?: "supply" | "demand";
  stationMinimumLoad?: StationMinimumLoad;
  stationWarpEnabled?: boolean;
  stationWarperAutoRefill?: boolean;
  stationWarperTarget?: number;
  stationHubEnabled?: boolean;
  stationHubPriority?: LogisticsPriority;
  stationSlots?: StationSlot[];
  sprayCoaterInstalled?: boolean;
  proliferatorTier?: ProliferatorTier;
  proliferatorMode?: ProliferatorMode;
}

export interface BlueprintBeltTemplate {
  key: string;
  sourceKey: string;
  targetKey: string;
  itemId: ItemId;
  lanes: number;
  tier: BeltTier;
  sorterTier: SorterTier;
  priority: LogisticsPriority;
  stackSize?: CargoStackSize;
  monitorEnabled?: boolean;
  routeMode?: BeltRouteMode;
  routeOffsetY?: number;
}

export type BlueprintRotation = 0 | 90 | 180 | 270;
export type BlueprintMirror = "none" | "horizontal";

export interface BlueprintExternalPort {
  key: string;
  entityKey: string;
  direction: "input" | "output";
  itemId: ItemId;
  offset: XYPosition;
}

export interface BlueprintDefinition {
  id: string;
  name: string;
  entities: BlueprintEntityTemplate[];
  belts: BlueprintBeltTemplate[];
  externalPorts?: BlueprintExternalPort[];
  rotation?: BlueprintRotation;
  mirror?: BlueprintMirror;
  recipeOverrides?: Partial<Record<RecipeId, RecipeId>>;
}

export interface ConstructionQueueEntry {
  id: string;
  blueprintId: string;
  blueprintName: string;
  planetId: PlanetId;
  position: XYPosition;
  rotation: BlueprintRotation;
  mirror: BlueprintMirror;
  queuedAt: number;
}

export interface HandcraftQueueEntry {
  id: string;
  recipeId: RecipeId;
  planetId: PlanetId;
  batchesTotal: number;
  batchesRemaining: number;
  progress: number;
  queuedAt: number;
}

export interface ProductionTargetPlan {
  id: string;
  name: string;
  itemId: ItemId;
  targetPerMinute: number;
  planetId: PlanetId | "all";
  recipeSelections: Partial<Record<ItemId, RecipeId>>;
  createdAt: number;
}

export interface ProductionHistorySample {
  elapsedSeconds: number;
  productionPerMinute: Partial<Record<ItemId, number>>;
  consumptionPerMinute: Partial<Record<ItemId, number>>;
  inventory: Partial<Record<ItemId, number>>;
  generationKw: number;
  demandKw: number;
  machineEfficiency?: number;
  logisticsEfficiency?: number;
  powerEfficiency?: number;
  activeMachines?: number;
  blockedMachines?: number;
}

export interface ConstructionAutomationState {
  enabled: boolean;
  targetStock: Partial<Record<ConstructionId, number>>;
  cursor: number;
  totalCrafted: number;
  lastCraftedId: ConstructionId | null;
  jobs: Record<string, ConstructionAutomationJob>;
}

export interface ConstructionAutomationRecipeStep {
  kind: "material";
  recipeId: RecipeId;
  batches: number;
  outputItemId: ItemId;
  outputAmount: number;
}

export interface ConstructionAutomationBuildingStep {
  kind: "building";
  constructionId: ConstructionId;
}

export type ConstructionAutomationStep = ConstructionAutomationRecipeStep | ConstructionAutomationBuildingStep;

export interface ConstructionAutomationJob {
  constructionId: ConstructionId;
  steps: ConstructionAutomationStep[];
  stepIndex: number;
  elapsedSeconds: number;
}

export interface GameState {
  version: 31;
  nextId: number;
  activePlanetId: PlanetId;
  entities: FactoryEntity[];
  belts: BeltConnection[];
  cargo: CargoStack | null;
  tray: Partial<Record<ItemId, number>>;
  planetTrays: Record<PlanetId, Partial<Record<ItemId, number>>>;
  planetTrayItemLimits: Record<PlanetId, number>;
  construction: Partial<Record<ConstructionId, number>>;
  constructionAutomation: ConstructionAutomationState;
  portableFleet: Record<PortableFleetItemId, number>;
  manualMined: number;
  totalProduced: Partial<Record<ItemId, number>>;
  research: ResearchState;
  exploration: ExplorationState;
  galaxy: GalaxyState;
  recipeFocus: RecipeFocusState;
  settings: GameSettings;
  achievements: AchievementState;
  campaign: CampaignState;
  planetViewports: Record<PlanetId, CanvasViewport>;
  canvasBookmarks: CanvasBookmark[];
  canvasRegions: CanvasRegion[];
  blueprints: BlueprintDefinition[];
  constructionQueue: ConstructionQueueEntry[];
  handcraftQueue: HandcraftQueueEntry[];
  productionPlans: ProductionTargetPlan[];
  productionHistory: ProductionHistorySample[];
  historyRecordedAt: number;
  elapsedSeconds: number;
  metrics: FactoryMetrics;
  planetMetrics: Record<PlanetId, FactoryMetrics>;
  powerGridMetrics: Record<PlanetId, Record<PowerGridId, PowerGridMetrics>>;
  dysonSwarm: DysonSwarmState;
  dysonSphere: DysonSphereState;
  dysonEngineering: DysonEngineeringState;
  dysonPlans: Record<StarSystemId, DysonSpherePlanState>;
  endgame: EndgameState;
  paused: boolean;
}

export interface SimulationResult {
  state: GameState;
  completedItems: Partial<Record<ItemId, number>>;
}
