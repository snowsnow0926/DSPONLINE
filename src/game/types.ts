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
  | "reforming_refine"
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
  | "dyson_shell"
  | "micro_black_hole_containment"
  | "time_warp_engineering"
  | "orbital_elevator_engineering"
  | "orbital_multi_cargo_bus"
  | "orbital_energy_recovery"
  | "system_space_station_engineering"
  | "orbital_modular_assembly"
  | "autonomous_station_construction"
  | "unified_system_logistics_protocol"
  | "quantum_logistics_network";

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
  | "construction_center"
  | "galactic_material_exporter"
  | "micro_black_hole_connector"
  | "time_warp_device"
  | "space_station_construction_launcher";

/** Core tiers are 1..3; declarative content packs may register tiers 4..32. */
export type BeltTier = number;
export type SorterTier = 1 | 2 | 3;
export type BeltRouteMode = "bezier" | "auto" | "upper" | "lower" | "manual";
export type DefaultBeltRouteMode = Exclude<BeltRouteMode, "manual">;
export type ProliferatorTier = 1 | 2 | 3;
export type ProliferatorMode = "normal" | "extra" | "speed";
export type ConveyorBeltId = string;
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
  | "reforming_refine"
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
  | "space_warper_from_gravity_matrix"
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
export type MaterialDeliverySlotMode = "auto" | "manual" | "disabled";

export interface MaterialDeliverySlot {
  itemId: ItemId | null;
  mode: MaterialDeliverySlotMode;
}
export type CargoStackSize = 1 | 2 | 4;
export type EnergyMode = "auto" | "charge" | "discharge";
export type PowerGridId = "grid-a" | "grid-b" | "grid-c";
export type PowerPriority = 1 | 2 | 3;
export type ResourceMode = "finite" | "infinite";
/** Runtime balance preset. Missing values in legacy saves migrate to standard. */
export type DifficultyMode = "relaxed" | "standard" | "hard";
export type RecipeFocusMode = "full" | "two-level";
export type SimulationSpeed = 1 | 2 | 4;
/** Persisted save ownership. Missing legacy values migrate to normal. */
export type SaveMode = "normal" | "speedrun";
/** Local save cadence. Zero explicitly disables the periodic timer. */
export type AutosaveIntervalSeconds = 0 | 30 | 60 | 120 | 600 | 1800;
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
export type DecimalIntegerString = string;
export type GalacticExportInputMode = "legacy-network" | "building";
export type ActivityMaterialId = "universe_matrix" | "solar_sail" | "small_carrier_rocket" | "antimatter_fuel_rod";
export type StationTier = 1 | 2;
export type StationOperationMode = "legacy" | "elevator";
export type StationModeTransition = "to-elevator" | "to-legacy" | null;
export type SpaceStationStatus = "not-started" | "building" | "operational";
export type SpaceStationOutputPortIndex = 0 | 1 | 2 | 3 | 4;

/**
 * Quantum logistics is deliberately independent from the deprecated space
 * station/elevator mode. A tower is upgraded first, then explicitly attached
 * to the shared network.
 */
export type QuantumStationMode = "legacy" | "transitioning" | "quantum";

export interface QuantumBridgeContract {
  id: string;
  itemId: ItemId;
  sourceStationId: string;
  targetStationId: string;
  cargo: DecimalIntegerString;
  remainingCargo: DecimalIntegerString;
  arriveAtSecond: number;
}

export interface QuantumStationTransition {
  targetMode: "quantum" | "legacy";
  startedAtSecond: number;
  boundarySecond: number;
  bridges: QuantumBridgeContract[];
}

export interface QuantumLogisticsNetworkState {
  enabled: boolean;
  inventory: Partial<Record<ItemId, DecimalIntegerString>>;
  /** Missing entries use the default 10-billion per-item capacity. */
  itemCapacities: Partial<Record<ItemId, DecimalIntegerString>>;
  routingCursors: Partial<Record<ItemId, number>>;
  uploadRoutingCursors: Partial<Record<ItemId, number>>;
  /** Runtime-only diagnostics. Save serialization deliberately removes this. */
  runtimeFlow?: QuantumLogisticsRuntimeFlow;
}

export interface QuantumLogisticsRuntimeFlow {
  boundarySecond: number;
  uploaded: Partial<Record<ItemId, DecimalIntegerString>>;
  downloaded: Partial<Record<ItemId, DecimalIntegerString>>;
  globalUploadPerMinute: number;
  globalDownloadPerMinute: number;
  quantumTowerStacks: number;
  quantumCollectorStacks: number;
}

export interface SystemHubItemPolicy {
  interstellarEnabled: boolean;
  reserve: DecimalIntegerString;
  target: DecimalIntegerString;
}

export interface SpaceStationModules {
  backbone: number;
  energy: number;
  interstellar: number;
}

export interface SpaceStationDecoration {
  id: string;
  kind: "marker" | "label";
  position: XYPosition;
  text?: string;
}

export interface SystemSpaceStationState {
  systemId: StarSystemId;
  status: SpaceStationStatus;
  costRevision: number;
  costMultiplierBasisPoints: number;
  phaseIndex: number;
  delivered: Partial<Record<ItemId, DecimalIntegerString>>;
  /** Materials that reached a construction launcher but are waiting for a later phase. */
  constructionBuffer: Partial<Record<ItemId, DecimalIntegerString>>;
  inventory: Partial<Record<ItemId, DecimalIntegerString>>;
  itemPolicies: Partial<Record<ItemId, SystemHubItemPolicy>>;
  modules: SpaceStationModules;
  routingCursors: Record<string, number>;
  viewport: CanvasViewport;
  decorations: SpaceStationDecoration[];
}

export interface FleetReturnBucket {
  routeKey: string;
  returnAtSecond: number;
  vesselCount: number;
}

export interface GalacticHubNetworkState {
  fleetInstalled: number;
  fleetBusy: number;
  fleetReturns: FleetReturnBucket[];
  warpers: DecimalIntegerString;
  warperTarget: DecimalIntegerString;
  routingCursors: Record<string, number>;
}

export interface BlackHolePortState {
  index: 0 | 1 | 2;
  currentItemId?: ItemId;
  totalDestroyed: DecimalIntegerString;
}

export interface TimeWarpState {
  controllerEntityId: string | null;
  enabled: boolean;
  requestedMultiplier: number;
  effectiveMultiplier: number;
  pendingSimulationSeconds: number;
  pendingWallSeconds: number;
  requiredPowerKw: number;
  allocatedPowerKw: number;
}

/**
 * Pure-idle accounting is deliberately separate from elapsedSeconds and the
 * speedrun clock. All time values here are wall-clock seconds except the
 * optional run start timestamp, which is an epoch millisecond anchor.
 */
export interface IdleSettlementState {
  currentRunStartedAt: number | null;
  currentRunElapsed: number;
  lastSettledAt: number;
  totalIdleTime: number;
  currentRunProduction: Partial<Record<ItemId, number>>;
  totalProduction: Partial<Record<ItemId, number>>;
}

export interface InfiniteResearchProgress {
  level: number;
  /** Original legacy level when it exceeded the current effective cap. */
  historicalLevel?: number;
  /** Universe matrices invested into the next level. */
  progress: DecimalIntegerString;
}

export interface ActivityPendingBatch {
  id: string;
  itemId: ActivityMaterialId;
  amount: number;
  sequence: number;
  firstDeliveredAtMs: number;
  lastDeliveredAtMs: number;
}

export interface GalacticConstructionActivityState {
  activityId: string | null;
  participantId: string | null;
  configRevision: string | null;
  startsAtMs: number;
  endsAtMs: number;
  serverTimeAnchorMs: number;
  activityClockMs: number;
  personalTargets: Record<ActivityMaterialId, number>;
  globalTargets: Record<ActivityMaterialId, number>;
  personalDelivered: Record<ActivityMaterialId, number>;
  pendingBatches: Partial<Record<ActivityMaterialId, ActivityPendingBatch>>;
  nextBatchSequence: number;
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
  exportInputMode: GalacticExportInputMode;
  constructionActivity: GalacticConstructionActivityState;
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
  /** Higher values are preferred by automatic recursive manufacturing. */
  recursivePriority?: number;
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
  stackLimit?: number;
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
  interactionLocked: boolean;
  resourceId?: ItemId;
  buildingId?: BuildingId;
  extractorBuildingId?: BuildingId;
  recipeId?: RecipeId;
  /** Persisted Dyson swarm orbit target for electromagnetic rail ejectors. */
  targetDysonOrbitId?: string;
  storedItemId?: ItemId;
  /** Up to three item types routed directly into this planet's material tray. */
  deliveryItemIds?: ItemId[];
  /** Stable per-port configuration for the three material delivery inputs. */
  deliverySlots?: MaterialDeliverySlot[];
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
  /** Tenths of one reserve unit already consumed; kept as an integer for deterministic depletion. */
  resourceDepletionRemainder?: number;
  stationMode?: "supply" | "demand";
  stationTier?: StationTier;
  stationOperationMode?: StationOperationMode;
  stationModeTransition?: StationModeTransition;
  /** Explicit quantum network attachment for Mk.II towers and orbital collectors. */
  quantumMode?: QuantumStationMode;
  quantumTransition?: QuantumStationTransition | null;
  /** Persisted blueprint intent; cleared after a safe quantum handoff starts. */
  quantumTarget?: boolean;
  /** Fixed five output assignments used only by Mk.II elevator mode. */
  elevatorOutputItems?: Array<ItemId | null>;
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
  stationLastSupplyPeerBySlot?: Partial<Record<string, string>>;
  stationCongestion?: number;
  sprayCoaterInstalled?: boolean;
  proliferatorTier?: ProliferatorTier;
  proliferatorMode?: ProliferatorMode;
  proliferatorPoints?: number;
  proliferatorBonusProgress?: Partial<Record<ItemId, number>>;
  galacticExporterPaused?: boolean;
  blackHolePaused?: boolean;
  blackHoleActivationConfirmed?: boolean;
  blackHolePorts?: BlackHolePortState[];
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
  /** UI-only recent observation fields. Storage migration intentionally drops them. */
  recentFlowSampleSeconds?: number;
  recentFlowTransferred?: number;
  recentFlowSampling?: boolean;
  routeMode?: BeltRouteMode;
  routeOffsetY?: number;
  targetPortIndex?: 0 | 1 | 2;
  /** Stable output port used by a Mk.II space elevator. */
  elevatorOutputIndex?: SpaceStationOutputPortIndex;
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
  operationalReceiverCapacityKw: number;
  receiverLoadKw: number;
  theoreticalReceptionRate: number;
  receiverUtilization: number;
  dysonPowerUtilization: number;
  configuredReceiverCount: number;
  blockedReceiverCount: number;
  /** @deprecated Use one of the explicit reception/utilization metrics. */
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
  structureAllocationFloor: number;
  shellAllocationFloor: number;
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
    | "fleet-busy"
    | "missing-vessel"
    | "missing-drone"
     | "missing-warper"
     | "missing-hub"
    | "waiting-load"
    | "waiting-route"
    | "collecting"
    | "missing-dyson-swarm"
    | "missing-dyson-orbit"
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

export interface PlanetDisplayMetadata {
  customName: string;
  note: string;
  tags: string[];
}

export interface StarSystemDisplayMetadata {
  customName: string;
}

export interface GalaxyState {
  seed: number;
  profiles: Record<PlanetId, PlanetIndustrialProfile>;
  systemProfiles: Record<StarSystemId, StarSystemProfile>;
  planetRoles: Record<PlanetId, PlanetIndustryRole>;
  planetMetadata: Partial<Record<PlanetId, PlanetDisplayMetadata>>;
  systemMetadata: Partial<Record<StarSystemId, StarSystemDisplayMetadata>>;
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
  defaultBeltStackSize: CargoStackSize;
  defaultBeltRouteMode: DefaultBeltRouteMode;
  productionBufferLimit: number;
  logisticsBufferLimit: number;
  /** Maximum transient transport credit per belt; not cargo or throughput. */
  beltBufferLimit: number;
  proliferatorBufferLimit: number;
  autosaveIntervalSeconds: AutosaveIntervalSeconds;
  /** Automatically open the missing recipe after a failed quick-craft. */
  autoShortageNavigation: boolean;
  resourceMode: ResourceMode;
  difficulty: DifficultyMode;
}

export interface GameContentPackReference {
  id: string;
  version: string;
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
  targetDysonOrbitId?: string;
  storedItemId?: ItemId;
  deliveryItemIds?: ItemId[];
  deliverySlots?: MaterialDeliverySlot[];
  distributionMode?: "balanced" | "priority";
  fuelItemId?: ItemId;
  energyMode?: EnergyMode;
  powerGridId?: PowerGridId;
  powerPriority?: PowerPriority;
  generationPriority?: PowerPriority;
  stationMode?: "supply" | "demand";
  stationTier?: StationTier;
  stationOperationMode?: StationOperationMode;
  /** Request quantum attachment after the placed station satisfies its prerequisites. */
  quantumTarget?: boolean;
  /** Player intent for micro black hole connectors; runtime counters are never copied. */
  operationEnabledOnDeploy?: boolean;
  elevatorOutputItems?: Array<ItemId | null>;
  stationMinimumLoad?: StationMinimumLoad;
  stationWarpEnabled?: boolean;
  stationWarperAutoRefill?: boolean;
  stationWarperTarget?: number;
  stationDroneTarget?: number;
  stationVesselTarget?: number;
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
  targetPortIndex?: 0 | 1 | 2;
  elevatorOutputIndex?: SpaceStationOutputPortIndex;
}

/**
 * A resource anchor describes an installed extractor layout without making the
 * underlying resource node buildable. Reserve and depletion data deliberately
 * stay on the destination planet's existing vein.
 */
export interface BlueprintResourceAnchor {
  key: string;
  resourceId: ItemId;
  offset: XYPosition;
  extractorBuildingId: BuildingId;
  minerCount: number;
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
  /** Monotonic local revision used by immutable queued construction orders. */
  revision?: number;
  entities: BlueprintEntityTemplate[];
  resourceAnchors?: BlueprintResourceAnchor[];
  belts: BlueprintBeltTemplate[];
  externalPorts?: BlueprintExternalPort[];
  rotation?: BlueprintRotation;
  mirror?: BlueprintMirror;
  recipeOverrides?: Partial<Record<RecipeId, RecipeId>>;
}

export interface BlueprintVersionSnapshot {
  id: string;
  blueprintId: string;
  revision: number;
  definition: BlueprintDefinition;
}

export type BlueprintConstructionStatus = "pending-materials" | "waiting-fleet";

export interface ConstructionQueueEntry {
  id: string;
  blueprintId: string;
  blueprintVersionId?: string;
  blueprintRevision?: number;
  blueprintName: string;
  planetId: PlanetId;
  position: XYPosition;
  rotation: BlueprintRotation;
  mirror: BlueprintMirror;
  queuedAt: number;
  status?: BlueprintConstructionStatus;
  reservedConstruction?: Partial<Record<ConstructionId, number>>;
  reservedFleet?: Partial<Record<PortableFleetItemId, number>>;
  placedEntityIdsByKey?: Record<string, string>;
  buildingCompletedAt?: number;
  /** Command policy captured only for an explicitly opted-in overlapping placement. */
  allowExactOverlap?: true;
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
  /** Simulated seconds represented by this rolling bucket. Legacy samples imply 10 seconds. */
  sampleDurationSeconds?: number;
  productionPerMinute: Partial<Record<ItemId, number>>;
  consumptionPerMinute: Partial<Record<ItemId, number>>;
  /** Optional v46-compatible runtime history for planet-scoped statistics. */
  planetProductionPerMinute?: Partial<Record<PlanetId, Partial<Record<ItemId, number>>>>;
  planetConsumptionPerMinute?: Partial<Record<PlanetId, Partial<Record<ItemId, number>>>>;
  inventory: Partial<Record<ItemId, number>>;
  generationKw: number;
  demandKw: number;
  machineEfficiency?: number;
  logisticsEfficiency?: number;
  powerEfficiency?: number;
  activeMachines?: number;
  blockedMachines?: number;
}

export type ConstructionAutomationTargetId = ConstructionId | PortableFleetItemId;

export interface ConstructionAutomationState {
  enabled: boolean;
  targetStock: Partial<Record<ConstructionAutomationTargetId, number>>;
  cursor: number;
  totalCrafted: number;
  lastCraftedId: ConstructionAutomationTargetId | null;
  destroyedByproducts: Partial<Record<ItemId, number>>;
  jobs: Record<string, ConstructionAutomationJob>;
}

export interface ConstructionAutomationRecipeDecision {
  itemId: ItemId;
  recipeId: RecipeId;
  fallbackReason?: string;
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

export interface ConstructionAutomationFleetStep {
  kind: "fleet";
  itemId: PortableFleetItemId;
  amount: number;
}

export type ConstructionAutomationStep = ConstructionAutomationRecipeStep | ConstructionAutomationBuildingStep | ConstructionAutomationFleetStep;

export interface ConstructionAutomationJob {
  constructionId: ConstructionAutomationTargetId;
  steps: ConstructionAutomationStep[];
  stepIndex: number;
  elapsedSeconds: number;
  inventory: Partial<Record<ItemId, number>>;
  recipeDecisions?: ConstructionAutomationRecipeDecision[];
}

/** Stable target identifiers for the opt-in speedrun mode. */
export type SpeedrunTargetId = "all_technologies" | "dyson_rockets_10000" | "white_matrix_1m";

export interface SpeedrunMilestone {
  completed: boolean;
  completedAtSeconds?: number;
}

export interface SpeedrunState {
  enabled: boolean;
  mode: "speedrun";
  rulesetVersion: string;
  seasonId: string;
  /** Wall-clock timestamp used only as an audit anchor, never as the timer. */
  startedAt: number;
  /** Effective active wall seconds. Paused time and time-warp simulation time are excluded. */
  elapsedActiveSeconds: number;
  baseline: {
    completedTechIds: TechId[];
    rocketsLaunched: number;
    whiteMatrixProduced: number;
  };
  milestones: Record<SpeedrunTargetId, SpeedrunMilestone>;
  eligible: boolean;
  invalidReason?: string;
  lastValidatedRevision?: string;
  /** Server-side anti-conversion identity, absent only in invalid legacy imports. */
  factoryId?: string;
}

export interface GameState {
  /** v45 adds quantum item limits and collector endpoints; v46 adds immutable
    * blueprint construction reservations. v43 is retained so
    * old test fixtures can be inspected and rejected without unsafe casts. */
  version: 43 | 44 | 45 | 46;
  /** Explicitly separates ordinary and ranked factory saves. */
  mode: SaveMode;
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
  /** Enabled declarative content required to interpret extension IDs in this save. */
  contentPacks: GameContentPackReference[];
  achievements: AchievementState;
  campaign: CampaignState;
  planetViewports: Record<PlanetId, CanvasViewport>;
  canvasBookmarks: CanvasBookmark[];
  canvasRegions: CanvasRegion[];
  blueprints: BlueprintDefinition[];
  blueprintVersions: BlueprintVersionSnapshot[];
  constructionQueue: ConstructionQueueEntry[];
  handcraftQueue: HandcraftQueueEntry[];
  productionPlans: ProductionTargetPlan[];
  productionHistory: ProductionHistorySample[];
  historyRecordedAt: number;
  elapsedSeconds: number;
  idleSettlement: IdleSettlementState;
  /** Optional so ordinary and legacy saves remain byte-compatible in shape. */
  speedrun?: SpeedrunState;
  metrics: FactoryMetrics;
  planetMetrics: Record<PlanetId, FactoryMetrics>;
  powerGridMetrics: Record<PlanetId, Record<PowerGridId, PowerGridMetrics>>;
  dysonSwarm: DysonSwarmState;
  dysonSphere: DysonSphereState;
  dysonEngineering: DysonEngineeringState;
  dysonPlans: Record<StarSystemId, DysonSpherePlanState>;
  systemSpaceStations: Partial<Record<StarSystemId, SystemSpaceStationState>>;
  galacticHubNetwork: GalacticHubNetworkState;
  quantumLogisticsNetwork: QuantumLogisticsNetworkState;
  timeWarp: TimeWarpState;
  endgame: EndgameState;
  paused: boolean;
}

export interface SimulationResult {
  state: GameState;
  completedItems: Partial<Record<ItemId, number>>;
}
