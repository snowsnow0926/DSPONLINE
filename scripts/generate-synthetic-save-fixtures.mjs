#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SYNTHETIC_FIXTURE_GENERATOR_VERSION = "p2-08-v1";
export const SYNTHETIC_FIXTURE_SEED = 1_040_406;
export const SYNTHETIC_FIXTURE_SAVED_AT = 1_767_225_600_000;
export const SYNTHETIC_FIXTURE_FORMAT_VERSION = 2;
export const SYNTHETIC_FIXTURE_STATE_VERSION = 47;
export const SYNTHETIC_FIXTURE_MAX_BUFFER_BYTES = 64 * 1024;

const MEBIBYTE = 1024 * 1024;
const PROFILE_ORDER = ["1m", "8m", "20m", "29m"];
const MODES = ["normal", "speedrun"];
const SLOTS = ["main", 1, 2, 3];
const COVERAGE = [
  "entities",
  "belts",
  "building-stacks",
  "power",
  "traditional-logistics",
  "quantum-logistics",
  "dyson",
  "research",
  "fluids",
  "byproducts",
  "recursive-manufacturing",
  "galactic-exports",
  "finite-veins",
  "infinite-veins",
  "cache-boundaries",
];

export const SYNTHETIC_FIXTURE_PROFILES = Object.freeze({
  "1m": Object.freeze({ id: "1m", targetBytes: 1 * MEBIBYTE, targetMiB: 1, normalResourceMode: "finite", elapsedSeconds: 86_400 }),
  "8m": Object.freeze({ id: "8m", targetBytes: 8 * MEBIBYTE, targetMiB: 8, normalResourceMode: "infinite", elapsedSeconds: 7 * 86_400 }),
  "20m": Object.freeze({ id: "20m", targetBytes: 20 * MEBIBYTE, targetMiB: 20, normalResourceMode: "finite", elapsedSeconds: 30 * 86_400 }),
  "29m": Object.freeze({ id: "29m", targetBytes: 29 * MEBIBYTE, targetMiB: 29, normalResourceMode: "infinite", elapsedSeconds: 180 * 86_400 }),
});

const COMPLETE_TECH_IDS = [
  "electromagnetic_matrix",
  "electromagnetism",
  "basic_logistics",
  "thermal_power",
  "solar_energy",
  "energy_storage",
  "fractionation",
  "high_efficiency_plasma_control",
  "energy_matrix",
  "xray_cracking",
  "reforming_refine",
  "basic_chemical_engineering",
  "polymer_chemistry",
  "structure_matrix",
  "titanium_alloy",
  "processor",
  "planetary_logistics",
  "interstellar_logistics",
  "orbital_collection",
  "space_warp",
  "stellar_exploration",
  "nanomaterials",
  "rare_resource_utilization",
  "quantum_chemical_engineering",
  "information_matrix",
  "miniature_particle_collider",
  "fusion_power",
  "quantum_chip",
  "gravity_matrix",
  "dyson_swarm",
  "ray_receiver",
  "antimatter",
  "artificial_star",
  "dyson_sphere_program",
  "vertical_launching_silo",
  "dyson_shell",
  "construction_automation",
  "construction_capacity_1",
  "construction_capacity_2",
  "super_magnetic_logistics",
  "material_delivery_logistics",
  "time_warp_engineering",
  "quantum_logistics_network",
];

const STATION_EMPTY_SLOT = Object.freeze({
  localMode: "storage",
  remoteMode: "storage",
  minimumLoad: 1,
  minStock: 0,
  maxStock: 0,
  priority: 1,
  routePolicy: "relay-preferred",
  warperBudget: 2,
});

function cloneEmptySlot() {
  return { ...STATION_EMPTY_SLOT };
}

function stationSlots(primary, secondary, mode) {
  return [
    {
      itemId: primary,
      localMode: mode,
      remoteMode: mode,
      minimumLoad: 0.25,
      minStock: mode === "demand" ? 1_000 : 0,
      maxStock: mode === "demand" ? 100_000_000 : 0,
      priority: 2,
      routePolicy: "direct",
      warperBudget: 2,
    },
    {
      itemId: secondary,
      localMode: "storage",
      remoteMode: mode,
      minimumLoad: 0.5,
      minStock: 0,
      maxStock: mode === "demand" ? 99_999_999 : 0,
      priority: 1,
      routePolicy: "relay-preferred",
      warperBudget: 3,
    },
    cloneEmptySlot(),
    cloneEmptySlot(),
    cloneEmptySlot(),
  ];
}

function baseEntity(id, kind, buildingId, position, extras = {}) {
  return {
    id,
    kind,
    planetId: "home",
    position,
    interactionLocked: false,
    ...(buildingId ? { buildingId } : {}),
    powerGridId: "grid-a",
    powerPriority: 2,
    routingCursor: 0,
    machineCount: kind === "vein" ? 0 : 1,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    utilization: 0,
    productionRate: 0,
    ...extras,
  };
}

function coreEntities(resourceMode) {
  const finite = resourceMode === "finite";
  const entities = [
    baseEntity("syn_vein_iron_finite", "vein", undefined, { x: 40, y: 40 }, {
      resourceId: "iron_ore",
      extractorBuildingId: "mining_machine",
      minerCount: 4_096,
      outputs: { iron_ore: 999_999 },
      progress: 0.875,
      resourceDepletionRemainder: 7,
      ...(finite ? { resourceCapacity: 9_000_000_000, resourceRemaining: 4_500_000_000 } : {}),
    }),
    baseEntity("syn_vein_water_infinite", "vein", undefined, { x: 40, y: 220 }, {
      resourceId: "water",
      extractorBuildingId: "water_pump",
      minerCount: 256,
      outputs: { water: 1_000_000 },
      progress: 0.25,
    }),
    baseEntity("syn_vein_oil", "vein", undefined, { x: 40, y: 400 }, {
      resourceId: "crude_oil",
      extractorBuildingId: "oil_extractor",
      minerCount: 128,
      outputs: { crude_oil: 500_000 },
      progress: 0.5,
      ...(finite ? { resourceCapacity: 8_000_000_000, resourceRemaining: 7_999_999_999 } : {}),
    }),
    baseEntity("syn_power_wind_stack", "power", "wind_turbine", { x: 300, y: 40 }, {
      machineCount: 100_000_000,
      generationPriority: 1,
      powerOutputKw: 30_000_000,
      powerFactor: 1,
    }),
    baseEntity("syn_power_thermal_low_fuel", "power", "thermal_power_plant", { x: 300, y: 220 }, {
      machineCount: 50_000,
      fuelItemId: "hydrogen_fuel_rod",
      fuelRemainingMj: 1,
      inputs: { hydrogen_fuel_rod: 1 },
      powerOutputKw: 90_000,
      powerFactor: 0.25,
    }),
    baseEntity("syn_power_ray_receiver", "machine", "ray_receiver", { x: 300, y: 400 }, {
      machineCount: 12_000_000,
      recipeId: "critical_photon",
      inputs: { graviton_lens: 999_999 },
      outputs: { critical_photon: 999_999 },
      powerOutputKw: 12_000_000,
      powerFactor: 0.75,
      progress: 0.999,
    }),
    baseEntity("syn_storage_empty", "storage", "storage_mk1", { x: 600, y: 40 }, {
      machineCount: 1_000,
      storedItemId: "iron_ingot",
      inputs: { iron_ingot: 0 },
      outputs: { iron_ingot: 0 },
    }),
    baseEntity("syn_storage_near_full", "storage", "storage_mk1", { x: 600, y: 220 }, {
      machineCount: 1_000,
      storedItemId: "iron_ingot",
      inputs: { iron_ingot: 999_999 },
      outputs: { iron_ingot: 999_999 },
    }),
    baseEntity("syn_storage_full", "storage", "storage_mk1", { x: 600, y: 400 }, {
      machineCount: 1_000,
      storedItemId: "iron_ingot",
      inputs: { iron_ingot: 1_000_000 },
      outputs: { iron_ingot: 1_000_000 },
    }),
    baseEntity("syn_storage_fluid", "storage", "storage_tank", { x: 600, y: 580 }, {
      machineCount: 1_000_000,
      storedItemId: "hydrogen",
      inputs: { hydrogen: 999_999 },
      outputs: { hydrogen: 1_000_000 },
    }),
    baseEntity("syn_storage_refined_oil", "storage", "storage_tank", { x: 600, y: 760 }, {
      machineCount: 1_000_000,
      storedItemId: "refined_oil",
      inputs: { refined_oil: 1 },
      outputs: { refined_oil: 0 },
    }),
    baseEntity("syn_storage_water", "storage", "storage_tank", { x: 600, y: 940 }, {
      machineCount: 1_000_000,
      storedItemId: "water",
      inputs: { water: 999_999 },
      outputs: { water: 1_000_000 },
    }),
    baseEntity("syn_storage_solar_sail", "storage", "storage_mk1", { x: 600, y: 1_120 }, {
      machineCount: 1_000_000,
      storedItemId: "solar_sail",
      inputs: { solar_sail: 1_000_000 },
      outputs: { solar_sail: 1_000_000 },
    }),
    baseEntity("syn_storage_carrier_rocket", "storage", "storage_mk1", { x: 600, y: 1_300 }, {
      machineCount: 1_000_000,
      storedItemId: "small_carrier_rocket",
      inputs: { small_carrier_rocket: 999_999 },
      outputs: { small_carrier_rocket: 999_999 },
    }),
    baseEntity("syn_storage_titanium", "storage", "storage_mk1", { x: 600, y: 1_480 }, {
      machineCount: 1_000_000,
      storedItemId: "titanium_ingot",
      inputs: { titanium_ingot: 999_999 },
      outputs: { titanium_ingot: 1_000_000 },
    }),
    baseEntity("syn_machine_smelter", "machine", "plane_smelter", { x: 900, y: 40 }, {
      machineCount: 88_000_000,
      recipeId: "iron_ingot",
      inputs: { iron_ore: 1_000_000 },
      outputs: { iron_ingot: 999_999 },
      progress: 0.5,
      utilization: 0.9,
      productionRate: 52_800_000,
      sprayCoaterInstalled: true,
      proliferatorTier: 3,
      proliferatorMode: "extra",
      proliferatorPoints: 600,
      proliferatorBonusProgress: { iron_ingot: 0.5 },
    }),
    baseEntity("syn_machine_refinery_byproduct", "machine", "oil_refinery", { x: 900, y: 220 }, {
      machineCount: 55_000_000,
      recipeId: "plasma_refining",
      inputs: { crude_oil: 1_000_000 },
      outputs: { refined_oil: 999_999, hydrogen: 1_000_000 },
      progress: 0.75,
      utilization: 1,
      productionRate: 27_500_000,
    }),
    baseEntity("syn_machine_fire_ice_byproduct", "machine", "chemical_plant", { x: 900, y: 400 }, {
      machineCount: 34_000_000,
      recipeId: "graphene_from_fire_ice",
      inputs: { fire_ice: 1_000_000 },
      outputs: { graphene: 999_999, hydrogen: 999_999 },
      progress: 0.125,
      utilization: 0.8,
      productionRate: 34_000_000,
    }),
    baseEntity("syn_machine_fractionator_fluid", "machine", "fractionator", { x: 900, y: 580 }, {
      machineCount: 21_000_000,
      recipeId: "deuterium_fractionation",
      inputs: { hydrogen: 1_000_000 },
      outputs: { deuterium: 999_999, hydrogen: 1 },
      progress: 0.375,
      utilization: 0.7,
      productionRate: 12_600_000,
    }),
    baseEntity("syn_machine_recursive_target", "machine", "assembling_machine_mk3", { x: 1_200, y: 40 }, {
      machineCount: 12_345_678,
      recipeId: "casimir_crystal_advanced",
      inputs: { optical_grating_crystal: 1_000_000, graphene: 999_999, hydrogen: 1_000_000 },
      outputs: { casimir_crystal: 999_999 },
      progress: 0.625,
      utilization: 0.85,
      productionRate: 9_259_258,
    }),
    baseEntity("syn_machine_matrix_lab", "machine", "matrix_lab", { x: 1_200, y: 220 }, {
      machineCount: 9_876_543,
      recipeId: "universe_matrix",
      inputs: {
        electromagnetic_matrix: 1_000_000,
        energy_matrix: 1_000_000,
        structure_matrix: 999_999,
        information_matrix: 999_999,
        gravity_matrix: 999_999,
        antimatter: 999_999,
      },
      outputs: { universe_matrix: 999_999 },
      progress: 0.875,
      utilization: 0.95,
      productionRate: 3_950_617,
    }),
    baseEntity("syn_construction_recursive_center", "machine", "construction_center", { x: 1_200, y: 400 }, {
      machineCount: 10_000_000,
      inputs: { fire_ice: 1_000_000, electromagnetic_turbine: 999_999, super_magnetic_ring: 999_999 },
      outputs: {},
      progress: 0.5,
      utilization: 0.6,
      productionRate: 1_000_000,
    }),
    baseEntity("syn_station_planetary_supply", "station", "planetary_logistics_station", { x: 1_500, y: 40 }, {
      machineCount: 25_000,
      stationMode: "supply",
      stationDrones: 12_500,
      stationProgress: 0.5,
      stationTrips: 123_456,
      stationLastTransfer: 1_000,
      stationMinimumLoad: 0.25,
      stationSlots: stationSlots("iron_ingot", "hydrogen", "supply"),
      stationRoutes: [],
      stationDispatchCursor: 7,
      stationCongestion: 0.25,
      storedItemId: "iron_ingot",
      outputs: { iron_ingot: 100_000_000, hydrogen: 50_000_000 },
    }),
    baseEntity("syn_station_planetary_demand", "station", "planetary_logistics_station", { x: 1_500, y: 220 }, {
      machineCount: 25_000,
      stationMode: "demand",
      stationDrones: 12_500,
      stationProgress: 0.75,
      stationTrips: 123_457,
      stationLastTransfer: 999,
      stationMinimumLoad: 0.25,
      stationSlots: stationSlots("iron_ingot", "hydrogen", "demand"),
      stationRoutes: [{
        id: "syn_route_local_inflight",
        slotIndex: 0,
        peerId: "syn_station_planetary_supply",
        itemId: "iron_ingot",
        scope: "local",
        cargo: 10_000,
        vehicleCount: 100,
        progress: 0.5,
        duration: 30,
        requiresWarp: false,
        vehicleStationId: "syn_station_planetary_demand",
      }],
      stationDispatchCursor: 8,
      stationCongestion: 0.75,
      storedItemId: "iron_ingot",
      inputs: { iron_ingot: 99_999_999, hydrogen: 100_000_000 },
    }),
    baseEntity("syn_station_interstellar_supply", "station", "interstellar_logistics_station", { x: 1_500, y: 400 }, {
      planetId: "frost",
      machineCount: 10_000,
      stationMode: "supply",
      stationTier: 2,
      stationOperationMode: "legacy",
      stationModeTransition: null,
      quantumMode: "legacy",
      quantumTransition: null,
      quantumTarget: false,
      elevatorOutputItems: [null, null, null, null, null],
      stationDrones: 5_000,
      stationVessels: 2_000,
      stationWarpers: 1_000,
      stationWarpEnabled: true,
      stationWarperAutoRefill: true,
      stationWarperTarget: 5_000,
      stationHubEnabled: true,
      stationHubPriority: 2,
      stationMinimumLoad: 0.25,
      stationSlots: stationSlots("processor", "space_warper", "supply"),
      stationRoutes: [],
      stationDispatchCursor: 11,
      storedItemId: "processor",
      outputs: { processor: 100_000_000, space_warper: 99_999_999 },
    }),
    baseEntity("syn_station_interstellar_demand", "station", "interstellar_logistics_station", { x: 1_500, y: 580 }, {
      machineCount: 10_000,
      stationMode: "demand",
      stationTier: 2,
      stationOperationMode: "legacy",
      stationModeTransition: null,
      quantumMode: "legacy",
      quantumTransition: null,
      quantumTarget: false,
      elevatorOutputItems: [null, null, null, null, null],
      stationDrones: 5_000,
      stationVessels: 2_000,
      stationWarpers: 1_000,
      stationWarpEnabled: true,
      stationWarperAutoRefill: true,
      stationWarperTarget: 5_000,
      stationHubEnabled: false,
      stationHubPriority: 1,
      stationMinimumLoad: 0.25,
      stationSlots: stationSlots("processor", "space_warper", "demand"),
      stationRoutes: [{
        id: "syn_route_remote_inflight",
        slotIndex: 0,
        peerId: "syn_station_interstellar_supply",
        itemId: "processor",
        scope: "remote",
        cargo: 20_000,
        vehicleCount: 20,
        progress: 0.4,
        duration: 120,
        requiresWarp: true,
        distanceLy: 18.5,
        waypointStationIds: [],
        warpersPerVessel: 1,
        vehicleStationId: "syn_station_interstellar_supply",
      }],
      stationDispatchCursor: 12,
      storedItemId: "processor",
      inputs: { processor: 99_999_999, space_warper: 100_000_000 },
    }),
    baseEntity("syn_quantum_supply", "station", "interstellar_logistics_station", { x: 1_800, y: 40 }, {
      machineCount: 50_000_000,
      stationMode: "supply",
      stationTier: 2,
      stationOperationMode: "legacy",
      stationModeTransition: null,
      quantumMode: "quantum",
      quantumTransition: null,
      quantumTarget: false,
      elevatorOutputItems: [null, null, null, null, null],
      stationDrones: 0,
      stationVessels: 0,
      stationWarpers: 0,
      stationWarpEnabled: true,
      stationWarperAutoRefill: false,
      stationWarperTarget: 50,
      stationHubEnabled: false,
      stationHubPriority: 1,
      stationMinimumLoad: 0.25,
      stationSlots: stationSlots("titanium_ingot", "hydrogen", "supply"),
      stationRoutes: [],
      stationDispatchCursor: 21,
      storedItemId: "titanium_ingot",
      outputs: { titanium_ingot: 100_000_000, hydrogen: 99_999_999 },
    }),
    baseEntity("syn_quantum_demand", "station", "interstellar_logistics_station", { x: 1_800, y: 220 }, {
      machineCount: 50_000_000,
      stationMode: "demand",
      stationTier: 2,
      stationOperationMode: "legacy",
      stationModeTransition: null,
      quantumMode: "quantum",
      quantumTransition: null,
      quantumTarget: false,
      elevatorOutputItems: [null, null, null, null, null],
      stationDrones: 0,
      stationVessels: 0,
      stationWarpers: 0,
      stationWarpEnabled: true,
      stationWarperAutoRefill: false,
      stationWarperTarget: 50,
      stationHubEnabled: false,
      stationHubPriority: 1,
      stationMinimumLoad: 0.25,
      stationSlots: stationSlots("titanium_ingot", "hydrogen", "demand"),
      stationRoutes: [],
      stationDispatchCursor: 22,
      storedItemId: "titanium_ingot",
      inputs: { titanium_ingot: 99_999_999, hydrogen: 100_000_000 },
    }),
    {
      ...baseEntity("syn_quantum_orbital_collector", "station", "orbital_collector", { x: 1_800, y: 400 }, {
        machineCount: 33_000_000,
        stationMode: "supply",
        quantumMode: "quantum",
        quantumTransition: null,
        stationRoutes: [],
        storedItemId: "hydrogen",
        outputs: { hydrogen: 100_000_000 },
      }),
      planetId: "giant",
    },
    baseEntity("syn_dyson_ejector", "machine", "em_rail_ejector", { x: 2_100, y: 40 }, {
      machineCount: 8_000_000,
      recipeId: "solar_sail_launch",
      targetDysonOrbitId: "syn_dyson_orbit_helios_1",
      inputs: { solar_sail: 1_000_000 },
      progress: 0.5,
      utilization: 0.8,
      productionRate: 4_800_000,
    }),
    baseEntity("syn_dyson_silo", "machine", "vertical_launching_silo", { x: 2_100, y: 220 }, {
      machineCount: 4_000_000,
      recipeId: "carrier_rocket_launch",
      inputs: { small_carrier_rocket: 999_999 },
      progress: 0.25,
      utilization: 0.7,
      productionRate: 1_400_000,
    }),
    baseEntity("syn_time_warp_controller", "machine", "time_warp_device", { x: 2_100, y: 400 }, {
      machineCount: 1,
      inputs: { universe_matrix: 999_999 },
      progress: 0.125,
      utilization: 0,
      productionRate: 0,
    }),
  ];
  return entities;
}

function belt(id, source, target, itemId, index, extras = {}) {
  return {
    id,
    planetId: "home",
    source,
    target,
    itemId,
    lanes: [1, 4, 512, 4_096][index % 4],
    tier: [1, 2, 3][index % 3],
    sorterTier: [1, 2, 3][index % 3],
    progress: [0, 0.25, 0.5, 0.999][index % 4],
    priority: index % 3,
    stackSize: [1, 2, 4][index % 3],
    monitorEnabled: index % 5 === 0,
    totalTransferred: index * 10_000,
    congestion: [0, 0.25, 0.75, 1][index % 4],
    lastFlow: [0, 1, 99_999, 100_000][index % 4],
    routeMode: ["auto", "upper", "lower", "bezier"][index % 4],
    ...extras,
  };
}

function coreBelts() {
  return [
    belt("syn_belt_iron_to_smelter", "syn_vein_iron_finite", "syn_machine_smelter", "iron_ore", 0),
    belt("syn_belt_smelter_to_empty", "syn_machine_smelter", "syn_storage_empty", "iron_ingot", 1),
    belt("syn_belt_smelter_to_near_full", "syn_machine_smelter", "syn_storage_near_full", "iron_ingot", 2),
    belt("syn_belt_smelter_blocked", "syn_machine_smelter", "syn_storage_full", "iron_ingot", 3),
    belt("syn_belt_oil_to_refinery", "syn_vein_oil", "syn_machine_refinery_byproduct", "crude_oil", 4),
    belt("syn_belt_refinery_hydrogen", "syn_machine_refinery_byproduct", "syn_storage_fluid", "hydrogen", 5),
    belt("syn_belt_refinery_oil", "syn_machine_refinery_byproduct", "syn_storage_refined_oil", "refined_oil", 6),
    belt("syn_belt_water_boundary", "syn_vein_water_infinite", "syn_storage_water", "water", 7),
    belt("syn_belt_station_supply", "syn_storage_near_full", "syn_station_planetary_supply", "iron_ingot", 8),
    belt("syn_belt_station_demand", "syn_station_planetary_demand", "syn_storage_empty", "iron_ingot", 9),
    belt("syn_belt_dyson_sail", "syn_storage_solar_sail", "syn_dyson_ejector", "solar_sail", 10),
    belt("syn_belt_dyson_rocket", "syn_storage_carrier_rocket", "syn_dyson_silo", "small_carrier_rocket", 11),
  ];
}

function mixed32(value) {
  let current = value >>> 0;
  current ^= current >>> 16;
  current = Math.imul(current, 0x7feb352d);
  current ^= current >>> 15;
  current = Math.imul(current, 0x846ca68b);
  current ^= current >>> 16;
  return current >>> 0;
}

const GENERATED_ENTITY_TEMPLATES = [
  { kind: "machine", buildingId: "plane_smelter", recipeId: "iron_ingot", inputs: ["iron_ore"], outputs: ["iron_ingot"] },
  { kind: "machine", buildingId: "oil_refinery", recipeId: "plasma_refining", inputs: ["crude_oil"], outputs: ["refined_oil", "hydrogen"] },
  { kind: "machine", buildingId: "chemical_plant", recipeId: "graphene_from_fire_ice", inputs: ["fire_ice"], outputs: ["graphene", "hydrogen"] },
  { kind: "machine", buildingId: "fractionator", recipeId: "deuterium_fractionation", inputs: ["hydrogen"], outputs: ["deuterium", "hydrogen"] },
  { kind: "machine", buildingId: "assembling_machine_mk3", recipeId: "casimir_crystal_advanced", inputs: ["optical_grating_crystal", "graphene", "hydrogen"], outputs: ["casimir_crystal"] },
  { kind: "machine", buildingId: "matrix_lab", recipeId: "universe_matrix", inputs: ["electromagnetic_matrix", "energy_matrix", "structure_matrix", "information_matrix", "gravity_matrix", "antimatter"], outputs: ["universe_matrix"] },
  { kind: "storage", buildingId: "storage_mk1", storedItemId: "processor", inputs: ["processor"], outputs: ["processor"] },
  { kind: "machine", buildingId: "ray_receiver", recipeId: "critical_photon", inputs: ["graviton_lens"], outputs: ["critical_photon"] },
];

function generatedEntity(index, seed) {
  const random = mixed32(seed ^ Math.imul(index + 1, 0x9e3779b1));
  const template = GENERATED_ENTITY_TEMPLATES[index % GENERATED_ENTITY_TEMPLATES.length];
  const cacheValues = [0, 1, 999_999, 1_000_000];
  const inputValue = cacheValues[random & 3];
  const outputValue = cacheValues[(random >>> 2) & 3];
  const record = baseEntity(
    `syn_entity_${index.toString().padStart(6, "0")}_${random.toString(16).padStart(8, "0")}`,
    template.kind,
    template.buildingId,
    { x: 2_400 + (index % 128) * 180, y: 40 + Math.floor(index / 128) * 140 },
    {
      machineCount: 1 + (random % 100_000_000),
      ...(template.recipeId ? { recipeId: template.recipeId } : {}),
      ...(template.storedItemId ? { storedItemId: template.storedItemId } : {}),
      inputs: Object.fromEntries(template.inputs.map((itemId, itemIndex) => [itemId, itemIndex === 0 ? inputValue : cacheValues[(random >>> (itemIndex + 3)) & 3]])),
      outputs: Object.fromEntries(template.outputs.map((itemId, itemIndex) => [itemId, itemIndex === 0 ? outputValue : cacheValues[(random >>> (itemIndex + 5)) & 3]])),
      progress: (random % 1_000) / 1_000,
      routingCursor: random % 10_000,
      utilization: ((random >>> 8) % 101) / 100,
      productionRate: random % 100_000_000,
      powerGridId: ["grid-a", "grid-b", "grid-c"][(random >>> 10) % 3],
      powerPriority: 1 + ((random >>> 12) % 3),
      powerFactor: ((random >>> 14) % 101) / 100,
    },
  );
  if (template.kind === "machine" && index % 4 === 0) {
    record.sprayCoaterInstalled = true;
    record.proliferatorTier = 1 + (index % 3);
    record.proliferatorMode = ["normal", "extra", "speed"][index % 3];
    record.proliferatorPoints = [0, 1, 599, 600][index % 4];
    record.proliferatorBonusProgress = { [template.outputs[0]]: (index % 10) / 10 };
  }
  if (template.kind === "power") {
    record.powerOutputKw = random % 100_000_000;
    record.generationPriority = 1 + ((random >>> 16) % 3);
  }
  return record;
}

const GENERATED_BELT_ENDPOINTS = [
  ["syn_vein_iron_finite", "syn_machine_smelter", "iron_ore"],
  ["syn_machine_smelter", "syn_storage_empty", "iron_ingot"],
  ["syn_machine_refinery_byproduct", "syn_storage_fluid", "hydrogen"],
  ["syn_machine_fire_ice_byproduct", "syn_storage_fluid", "hydrogen"],
  ["syn_storage_near_full", "syn_station_planetary_supply", "iron_ingot"],
  ["syn_quantum_demand", "syn_storage_titanium", "titanium_ingot"],
];

function generatedBelt(index, seed) {
  const random = mixed32(seed ^ Math.imul(index + 1, 0x85ebca6b));
  const [source, target, itemId] = GENERATED_BELT_ENDPOINTS[index % GENERATED_BELT_ENDPOINTS.length];
  return belt(
    `syn_belt_${index.toString().padStart(6, "0")}_${random.toString(16).padStart(8, "0")}`,
    source,
    target,
    itemId,
    random,
    {
      lanes: [1, 4, 512, 4_096][random & 3],
      tier: [1, 2, 3][(random >>> 2) % 3],
      sorterTier: [1, 2, 3][(random >>> 4) % 3],
      progress: [0, 0.25, 0.5, 0.999][(random >>> 6) & 3],
      priority: (random >>> 8) % 3,
      stackSize: [1, 2, 4][(random >>> 10) % 3],
      monitorEnabled: (random & 15) === 0,
      totalTransferred: random * 10,
      congestion: [0, 0.25, 0.75, 1][(random >>> 12) & 3],
      lastFlow: [0, 1, 99_999, 100_000][(random >>> 14) & 3],
      routeMode: ["auto", "upper", "lower", "bezier"][((random >>> 16) & 3)],
    },
  );
}

function emptyMetrics(overrides = {}) {
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
    ...overrides,
  };
}

function infiniteResearch() {
  return {
    matrix_compression: { level: 12, progress: "123456789" },
    vein_utilization: { level: 9, progress: "987654321" },
    galactic_logistics: { level: 8, progress: "24681012" },
    stellar_harnessing: { level: 7, progress: "1357911" },
    continuum_simulation: { level: 20, progress: "11235813" },
  };
}

function exportProjects() {
  return Object.fromEntries([
    ["universe_archive", "universe_matrix"],
    ["solar_sail_array", "solar_sail"],
    ["carrier_rocket_fleet", "small_carrier_rocket"],
    ["antimatter_exchange", "antimatter_fuel_rod"],
  ].map(([id], index) => [id, {
    id,
    enabled: index % 2 === 0,
    // Galactic export priorities are a distinct 1..3 domain (belt priority
    // remains 0..2 above). Keep the fixture admissible to the authoritative
    // export stage so thread/performance gates exercise the complete state.
    priority: (index % 3) + 1,
    level: index + 1,
    delivered: index * 1_000,
    totalDelivered: index * 10_000,
    dispatchProgress: index / 4,
  }]));
}

function speedrunState(profile, seed) {
  return {
    enabled: true,
    mode: "speedrun",
    rulesetVersion: "speedrun-v1",
    seasonId: "season_01",
    startedAt: SYNTHETIC_FIXTURE_SAVED_AT - profile.elapsedSeconds * 1_000,
    elapsedActiveSeconds: profile.elapsedSeconds,
    baseline: { completedTechIds: [], rocketsLaunched: 0, whiteMatrixProduced: 0 },
    milestones: {
      all_technologies: { completed: false },
      dyson_rockets_10000: { completed: false },
      white_matrix_1m: { completed: false },
    },
    eligible: true,
    factoryId: `synthetic_fixture_${profile.id}_${seed.toString(36).padStart(8, "0")}`,
  };
}

function stateHeader(plan) {
  return {
    version: SYNTHETIC_FIXTURE_STATE_VERSION,
    mode: plan.mode,
    nextId: 90_000_000,
    activePlanetId: "home",
  };
}

function syntheticOrbitalStation(plan) {
  const taskDay = Math.floor((SYNTHETIC_FIXTURE_SAVED_AT + 8 * 60 * 60 * 1_000) / (24 * 60 * 60 * 1_000));
  const stage = (stageId, costs, logisticsVessels = 0) => ({
    stageId,
    costs: costs.map(([itemId, amount]) => ({ itemId, amount })),
    fleetCosts: logisticsVessels > 0 ? { logistics_vessel: logisticsVessels } : {},
    delivered: {},
    deliveredFleet: {},
  });
  return {
    stateVersion: 1,
    status: plan.mode === "normal" ? "eligible" : "locked",
    construction: {
      costRevision: 1,
      stageRequirements: [
        stage("core", [["titanium_alloy", "200000"], ["frame_material", "100000"], ["processor", "200000"], ["universe_matrix", "20000"]]),
        stage("dock", [["quantum_chip", "100000"], ["particle_container", "200000"], ["space_warper", "20000"]], 200),
        stage("showcase", [["titanium_glass", "300000"], ["particle_broadband", "200000"], ["plastic", "500000"], ["universe_matrix", "50000"]]),
      ],
    },
    viewport: { x: 0, y: 0, zoom: 0.72 },
    contractBoard: {
      rulesVersion: 1,
      taskDay,
      lastConfirmedWallClockMs: SYNTHETIC_FIXTURE_SAVED_AT,
      offers: [],
      accepted: [],
      history: [],
      settledIds: [],
      featuredContractId: null,
    },
    economy: { orbitalMarks: "0", stationReputation: "0", unlockedDecorationIds: [] },
    layout: { themeId: "orbital_teal", placements: [], featuredAchievementIds: [] },
    profile: {
      title: "Synthetic orbital station",
      motto: "Deterministic fixture state.",
      featuredMetricKeys: ["total-generation", "peak-throughput", "dyson-power"],
    },
    totals: { completedContracts: 0, exportedByItem: {} },
  };
}

function stateTail(plan) {
  const { profile, mode, seed, resourceMode, slot } = plan;
  const metrics = emptyMetrics({
    generationKw: 42_000_000_000,
    demandKw: 39_000_000_000,
    powerFactor: 0.923,
    windGenerationKw: 30_000_000_000,
    thermalGenerationKw: 90_000,
    rayGenerationKw: 12_000_000_000,
    totalItemsPerMinute: 19_600_000_000,
  });
  return {
    cargo: null,
    tray: { iron_ore: 0, processor: 99_999_999, hydrogen: 100_000_000, universe_matrix: 1 },
    planetTrays: {
      home: { iron_ore: 0, processor: 99_999_999, hydrogen: 100_000_000, universe_matrix: 1 },
      ashen: { titanium_ingot: 1_000_000, space_warper: 999_999 },
    },
    planetTrayItemLimits: { home: 100_000_000, ashen: 100_000_000 },
    construction: {
      conveyor_belt_mk1: 1,
      conveyor_belt_mk2: 1_000_000,
      conveyor_belt_mk3: 100_000_000,
      interstellar_logistics_station: 10_000,
      ray_receiver: 12_000_000,
    },
    constructionAutomation: {
      enabled: true,
      targetStock: { conveyor_belt_mk3: 100 },
      cursor: 17,
      totalCrafted: 10_000_000,
      lastCraftedId: "conveyor_belt_mk3",
      destroyedByproducts: { hydrogen: 123_456, refined_oil: 7_890 },
      jobs: {
        syn_construction_recursive_center: {
          constructionId: "conveyor_belt_mk3",
          steps: [
            { kind: "material", recipeId: "graphene_from_fire_ice", batches: 10_000, outputItemId: "graphene", outputAmount: 20_000 },
            { kind: "material", recipeId: "electromagnetic_turbine", batches: 5_000, outputItemId: "electromagnetic_turbine", outputAmount: 5_000 },
            { kind: "building", constructionId: "conveyor_belt_mk3" },
          ],
          stepIndex: 1,
          elapsedSeconds: 0.5,
          inventory: { fire_ice: 20_000, hydrogen: 10_000, electromagnetic_turbine: 5_000 },
          recipeDecisions: [
            { itemId: "graphene", recipeId: "graphene_from_fire_ice", fallbackReason: "synthetic-byproduct-path" },
            { itemId: "electromagnetic_turbine", recipeId: "electromagnetic_turbine" },
          ],
        },
      },
    },
    portableFleet: { logistics_drone: 100_000_000, logistics_vessel: 100_000_000 },
    manualMined: 12_345,
    totalProduced: {
      iron_ore: 9_000_000_000,
      refined_oil: 2_000_000_000,
      hydrogen: 4_000_000_000,
      universe_matrix: 999_999,
    },
    research: {
      selectedTechId: "universe_matrix",
      pausedTechId: null,
      queuedTechIds: [],
      progressByTech: { universe_matrix: { electromagnetic_matrix: 999_999, energy_matrix: 999_999 } },
      completedTechIds: COMPLETE_TECH_IDS,
    },
    exploration: {
      unlockedSystemIds: ["helios", "borealis", "aurora", "ember", "sirius", "white_dwarf", "neutron", "blue_giant"],
      colonizedPlanetIds: ["home", "ashen", "giant", "frost", "magnetar", "verdant", "crystal", "azure_giant"],
      missions: [],
      surveyProgressBySystem: { helios: 1, borealis: 1, aurora: 1, ember: 1, sirius: 1, white_dwarf: 1, neutron: 1, blue_giant: 1 },
    },
    galaxy: { seed, planetMetadata: {}, systemMetadata: {} },
    recipeFocus: { itemId: "universe_matrix", mode: "two-level", position: { x: 24, y: 72 } },
    settings: {
      simulationSpeed: 1,
      fontScale: 1,
      theme: "dark",
      technologyLayout: "standard",
      performanceMode: true,
      reducedMotion: true,
      soundEnabled: false,
      allowDoubleClickZoom: false,
      beltHeatmapEnabled: false,
      defaultBeltStackSize: 4,
      defaultBeltRouteMode: "auto",
      productionBufferLimit: 1_000_000,
      logisticsBufferLimit: 100_000_000,
      beltBufferLimit: 100_000_000,
      proliferatorBufferLimit: 600,
      autosaveIntervalSeconds: 600,
      autoShortageNavigation: false,
      resourceMode,
      difficulty: "standard",
    },
    contentPacks: [],
    achievements: { unlockedIds: ["automated_mining", "stable_power_grid", "multi_system_industry"] },
    campaign: { activeChapterId: "matrix_mastery", activeTaskId: "produce_white_matrix", completedTaskIds: [], rewardedTaskIds: [] },
    planetViewports: { home: { x: 510, y: 250, zoom: 0.84 }, ashen: { x: 510, y: 250, zoom: 0.84 } },
    canvasBookmarks: [],
    canvasRegions: [],
    blueprints: [],
    blueprintVersions: [],
    constructionQueue: [],
    handcraftQueue: [],
    productionPlans: [{
      id: "syn_plan_universe_matrix",
      name: "Synthetic universe matrix plan",
      itemId: "universe_matrix",
      targetPerMinute: 1_000_000,
      planetId: "all",
      recipeSelections: { graphene: "graphene_from_fire_ice", universe_matrix: "universe_matrix" },
      createdAt: 1,
    }],
    productionHistory: [{
      elapsedSeconds: profile.elapsedSeconds,
      sampleDurationSeconds: 60,
      productionPerMinute: { iron_ingot: 10_000_000, hydrogen: 5_000_000, universe_matrix: 1_000_000 },
      consumptionPerMinute: { iron_ore: 10_000_000, crude_oil: 2_000_000 },
      inventory: { iron_ingot: 999_999, hydrogen: 1_000_000, universe_matrix: 1 },
      generationKw: 42_000_000_000,
      demandKw: 39_000_000_000,
      machineEfficiency: 0.9,
      logisticsEfficiency: 0.8,
      powerEfficiency: 0.923,
      activeMachines: 100_000_000,
      blockedMachines: 1_000_000,
    }],
    historyRecordedAt: profile.elapsedSeconds,
    elapsedSeconds: profile.elapsedSeconds,
    idleSettlement: {
      currentRunStartedAt: null,
      currentRunElapsed: 300,
      lastSettledAt: 300,
      totalIdleTime: 86_400,
      currentRunProduction: { iron_ingot: 50_000, hydrogen: 25_000 },
      totalProduction: { iron_ingot: 5_000_000, hydrogen: 2_500_000 },
    },
    ...(mode === "speedrun" ? { speedrun: speedrunState(profile, seed) } : {}),
    metrics,
    planetMetrics: { home: metrics, ashen: emptyMetrics({ generationKw: 1_000_000, demandKw: 900_000, powerFactor: 1, totalItemsPerMinute: 500_000 }) },
    powerGridMetrics: {
      home: {
        "grid-a": { ...metrics, gridId: "grid-a", connectedEntities: 100_000, disconnectedEntities: 0, generatorCount: 3, coverageRadius: 720 },
      },
    },
    dysonSwarm: {
      sailsInOrbit: 50_000_000,
      totalLaunched: 75_000_000,
      totalExpired: 20_000_000,
      decayProgress: 0.5,
      generationKw: 10_000_000_000,
      receiverLoadKw: 8_000_000_000,
    },
    dysonSphere: {
      structurePoints: 10_000_000,
      totalRocketsLaunched: 12_000_000,
      shellSails: 25_000_000,
      totalSailsAbsorbed: 25_000_000,
      absorptionProgress: 0.25,
      generationKw: 30_000_000_000,
    },
    dysonEngineering: {
      launchMode: "balanced",
      launchThrottle: 1,
      launchEnabled: true,
      activeOrbitBySystem: { helios: "syn_dyson_orbit_helios_1" },
      orbitsBySystem: {
        helios: [{
          id: "syn_dyson_orbit_helios_1",
          name: "Synthetic orbit A",
          radius: 12_000,
          inclination: 12,
          longitude: 45,
          sailsInOrbit: 50_000_000,
          totalLaunched: 75_000_000,
          totalExpired: 20_000_000,
          decayProgress: 0.5,
          generationKw: 10_000_000_000,
        }],
      },
      absorptionProgressBySystem: { helios: 0.25 },
      launchEnergySpentMj: 9_000_000_000,
    },
    dysonPlans: {
      helios: {
        systemId: "helios",
        activeLayerId: "syn_dyson_layer_1",
        structurePoints: 10_000_000,
        shellSails: 25_000_000,
        layers: [{
          id: "syn_dyson_layer_1",
          name: "Synthetic shell",
          radius: 20_000,
          inclination: 15,
          longitude: 30,
          nodes: [
            { id: "syn_dyson_node_a", angle: 0, requiredStructurePoints: 5_000_000, completedStructurePoints: 5_000_000 },
            { id: "syn_dyson_node_b", angle: 180, requiredStructurePoints: 5_000_000, completedStructurePoints: 5_000_000 },
          ],
          frames: [{ id: "syn_dyson_frame_ab", sourceNodeId: "syn_dyson_node_a", targetNodeId: "syn_dyson_node_b", requiredStructurePoints: 10_000_000, completedStructurePoints: 10_000_000 }],
          shells: [{ id: "syn_dyson_shell_ab", sourceNodeId: "syn_dyson_node_a", targetNodeId: "syn_dyson_node_b", boundaryFrameIds: ["syn_dyson_frame_ab"], sailCapacity: 25_000_000, absorbedSails: 25_000_000 }],
          structureAllocationFloor: 1_000,
          shellAllocationFloor: 2_000,
        }],
      },
    },
    systemSpaceStations: {},
    galacticHubNetwork: {
      fleetInstalled: 1_000_000,
      fleetBusy: 500_000,
      fleetReturns: [{ routeKey: "syn_hub_route", returnAtSecond: profile.elapsedSeconds + 60, vesselCount: 100 }],
      warpers: "999999999",
      warperTarget: "1000000000",
      routingCursors: { processor: 12 },
    },
    quantumLogisticsNetwork: {
      enabled: true,
      inventory: { titanium_ingot: "9999999999", hydrogen: "10000000000", processor: "0" },
      itemCapacities: { titanium_ingot: "10000000000", hydrogen: "10000000000", processor: "10000" },
      routingCursors: { titanium_ingot: 17, hydrogen: 18, processor: 0 },
      uploadRoutingCursors: { titanium_ingot: 19, hydrogen: 20, processor: 0 },
    },
    orbitalStation: syntheticOrbitalStation(plan),
    timeWarp: {
      controllerEntityId: "syn_time_warp_controller",
      enabled: false,
      requestedMultiplier: 12,
      effectiveMultiplier: 1,
      pendingSimulationSeconds: 0,
      pendingWallSeconds: 0,
      requiredPowerKw: 0,
      allocatedPowerKw: 0,
    },
    endgame: {
      activeInfiniteResearchId: "continuum_simulation",
      autoResearch: true,
      autoDispatch: true,
      dispatchThrottle: 1,
      exportProjects: exportProjects(),
      galacticCredits: 12_345_678,
      galacticScore: 98_765_432,
      totalExported: 1_000_000,
      exportedLastMinute: 10_000,
      exportWindowAmount: 10_000,
      exportWindowStartedAt: profile.elapsedSeconds - 60,
      infiniteResearch: infiniteResearch(),
      exportInputMode: "building",
      constructionActivity: {
        activityId: null,
        participantId: null,
        configRevision: null,
        startsAtMs: 0,
        endsAtMs: 0,
        serverTimeAnchorMs: 0,
        activityClockMs: 0,
        personalTargets: { universe_matrix: 0, solar_sail: 0, small_carrier_rocket: 0, antimatter_fuel_rod: 0 },
        globalTargets: { universe_matrix: 0, solar_sail: 0, small_carrier_rocket: 0, antimatter_fuel_rod: 0 },
        personalDelivered: { universe_matrix: 0, solar_sail: 0, small_carrier_rocket: 0, antimatter_fuel_rod: 0 },
        pendingBatches: {},
        nextBatchSequence: 0,
      },
    },
    paused: true,
    syntheticFixture: {
      generator: SYNTHETIC_FIXTURE_GENERATOR_VERSION,
      profile: profile.id,
      seed,
      mode,
      slot,
      anonymous: true,
      productionShaped: true,
      coverage: COVERAGE,
    },
  };
}

function bodyOf(object) {
  const serialized = JSON.stringify(object);
  return serialized.slice(1, -1);
}

function normalizedProfile(profile) {
  const selected = SYNTHETIC_FIXTURE_PROFILES[profile];
  if (!selected) throw new Error(`Unknown synthetic fixture profile: ${String(profile)}`);
  return selected;
}

function normalizedMode(mode) {
  if (!MODES.includes(mode)) throw new Error(`Unknown synthetic fixture mode: ${String(mode)}`);
  return mode;
}

function normalizedSlot(slot) {
  const numeric = typeof slot === "string" && /^[1-3]$/.test(slot) ? Number(slot) : slot;
  if (!SLOTS.includes(numeric)) throw new Error(`Unknown synthetic fixture slot: ${String(slot)}`);
  return numeric;
}

function normalizedSeed(seed) {
  const value = Number(seed);
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fff_ffff) throw new Error(`Synthetic fixture seed must be an integer from 1 through ${0x7fff_ffff}`);
  return value;
}

function envelopePrefix(plan) {
  return `{"formatVersion":${SYNTHETIC_FIXTURE_FORMAT_VERSION},"kind":"primary","savedAt":${SYNTHETIC_FIXTURE_SAVED_AT},"mode":${JSON.stringify(plan.mode)},"slot":${JSON.stringify(plan.slot)},"state":`;
}

function statePieces(plan) {
  const header = stateHeader(plan);
  const tail = stateTail(plan);
  return {
    statePrefix: `{${bodyOf(header)},"entities":[`,
    stateMiddle: `],"belts":[`,
    stateSuffixPrefix: `],${bodyOf(tail)},"syntheticPadding":"`,
    stateSuffix: `"}`,
  };
}

function envelopeSuffix(checksum) {
  return `,"checksum":"${checksum}"}`;
}

function encodedBytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function arrayBytes(records) {
  let bytes = 0;
  for (let index = 0; index < records.length; index += 1) {
    if (index > 0) bytes += 1;
    bytes += encodedBytes(JSON.stringify(records[index]));
  }
  return bytes;
}

/**
 * Build a deterministic generation plan without materializing either large
 * array. The final padding is always smaller than one generated belt record;
 * almost all bytes therefore remain production-shaped entity/belt data.
 */
export function createSyntheticFixturePlan(options = {}) {
  const profile = normalizedProfile(options.profile ?? "1m");
  const mode = normalizedMode(options.mode ?? "normal");
  const slot = normalizedSlot(options.slot ?? "main");
  const seed = normalizedSeed(options.seed ?? SYNTHETIC_FIXTURE_SEED);
  const resourceMode = mode === "speedrun" ? "finite" : profile.normalResourceMode;
  const draft = { profile, mode, slot, seed, resourceMode };
  const entities = coreEntities(resourceMode);
  const belts = coreBelts();
  const pieces = statePieces(draft);
  const fixedBytes = encodedBytes(envelopePrefix(draft)) + encodedBytes(pieces.statePrefix) + arrayBytes(entities) +
    encodedBytes(pieces.stateMiddle) + arrayBytes(belts) + encodedBytes(pieces.stateSuffixPrefix) +
    encodedBytes(pieces.stateSuffix) + encodedBytes(envelopeSuffix("00000000"));
  if (fixedBytes >= profile.targetBytes) throw new Error(`Synthetic fixture ${profile.id} core exceeds its target size`);

  const available = profile.targetBytes - fixedBytes;
  const entityBudget = Math.floor(available * 0.46);
  let generatedEntityCount = 0;
  let canonicalEntityBytes = 0;
  while (true) {
    // Profile shape must not drift when callers vary the content seed. Plan
    // the entity count from the pinned generator seed, then account for the
    // requested seed's exact bytes below. Belts and final padding absorb the
    // small representation-size delta without changing the entity workload.
    const next = JSON.stringify(generatedEntity(generatedEntityCount, SYNTHETIC_FIXTURE_SEED));
    const cost = 1 + encodedBytes(next);
    if (canonicalEntityBytes + cost > entityBudget) break;
    canonicalEntityBytes += cost;
    generatedEntityCount += 1;
  }

  let generatedEntityBytes = 0;
  for (let index = 0; index < generatedEntityCount; index += 1) {
    generatedEntityBytes += 1 + encodedBytes(JSON.stringify(generatedEntity(index, seed)));
  }
  if (generatedEntityBytes >= available) {
    throw new Error(`Synthetic fixture ${profile.id} seeded entities exceed its target size`);
  }

  let generatedBeltCount = 0;
  let generatedBeltBytes = 0;
  let remaining = available - generatedEntityBytes;
  while (true) {
    const next = JSON.stringify(generatedBelt(generatedBeltCount, seed));
    const cost = 1 + encodedBytes(next);
    if (cost > remaining) break;
    generatedBeltBytes += cost;
    remaining -= cost;
    generatedBeltCount += 1;
  }

  const paddingBytes = remaining;
  return Object.freeze({
    ...draft,
    targetBytes: profile.targetBytes,
    fixedBytes,
    coreEntityCount: entities.length,
    generatedEntityCount,
    entityCount: entities.length + generatedEntityCount,
    coreBeltCount: belts.length,
    generatedBeltCount,
    beltCount: belts.length + generatedBeltCount,
    generatedEntityBytes,
    generatedBeltBytes,
    paddingBytes,
    coverage: COVERAGE,
  });
}

function updateFnv(hash, chunk) {
  let next = hash >>> 0;
  for (let index = 0; index < chunk.length; index += 1) {
    next ^= chunk.charCodeAt(index);
    next = Math.imul(next, 0x01000193);
  }
  return next >>> 0;
}

function* repeatedAscii(character, count, chunkBytes = SYNTHETIC_FIXTURE_MAX_BUFFER_BYTES) {
  let remaining = count;
  const full = character.repeat(Math.min(chunkBytes, count));
  while (remaining > 0) {
    const size = Math.min(remaining, chunkBytes);
    yield size === full.length ? full : character.repeat(size);
    remaining -= size;
  }
}

function* stateChunks(plan) {
  const pieces = statePieces(plan);
  yield pieces.statePrefix;
  const core = coreEntities(plan.resourceMode);
  for (let index = 0; index < core.length; index += 1) {
    if (index > 0) yield ",";
    yield JSON.stringify(core[index]);
  }
  for (let index = 0; index < plan.generatedEntityCount; index += 1) {
    yield ",";
    yield JSON.stringify(generatedEntity(index, plan.seed));
  }
  yield pieces.stateMiddle;
  const belts = coreBelts();
  for (let index = 0; index < belts.length; index += 1) {
    if (index > 0) yield ",";
    yield JSON.stringify(belts[index]);
  }
  for (let index = 0; index < plan.generatedBeltCount; index += 1) {
    yield ",";
    yield JSON.stringify(generatedBelt(index, plan.seed));
  }
  yield pieces.stateSuffixPrefix;
  yield* repeatedAscii("x", plan.paddingBytes);
  yield pieces.stateSuffix;
}

function asyncOutput(outputPath, overwrite) {
  if (!outputPath) {
    return {
      async write() {},
      async close() {},
      async abort() {},
    };
  }
  let stream;
  return {
    async open() {
      await mkdir(dirname(outputPath), { recursive: true });
      stream = createWriteStream(outputPath, { flags: overwrite ? "w" : "wx", highWaterMark: SYNTHETIC_FIXTURE_MAX_BUFFER_BYTES });
      await once(stream, "open");
    },
    async write(chunk) {
      if (!stream.write(chunk, "utf8")) await once(stream, "drain");
    },
    async close() {
      stream.end();
      await once(stream, "close");
    },
    async abort() {
      if (stream && !stream.closed) stream.destroy();
      if (outputPath) await rm(outputPath, { force: true });
    },
  };
}

/**
 * Stream one exact-size envelope. At most one small record plus a 64 KiB
 * output batch is retained, independent of the requested fixture size.
 */
export async function generateSyntheticSaveFixture(options = {}) {
  const plan = createSyntheticFixturePlan(options);
  const outputPath = options.outputPath ? resolve(options.outputPath) : null;
  const output = asyncOutput(outputPath, options.overwrite === true);
  if (output.open) await output.open();
  const sha256 = createHash("sha256");
  let fnv = 0x811c9dc5;
  let writtenBytes = 0;
  let buffered = "";
  let maxBufferedBytes = 0;
  let maxRecordBytes = 0;

  const flush = async () => {
    if (!buffered) return;
    const bytes = encodedBytes(buffered);
    sha256.update(buffered, "utf8");
    await output.write(buffered);
    writtenBytes += bytes;
    buffered = "";
  };
  const emit = async (chunk, record = false) => {
    const bytes = encodedBytes(chunk);
    if (record) maxRecordBytes = Math.max(maxRecordBytes, bytes);
    if (buffered && encodedBytes(buffered) + bytes > SYNTHETIC_FIXTURE_MAX_BUFFER_BYTES) await flush();
    if (bytes > SYNTHETIC_FIXTURE_MAX_BUFFER_BYTES) {
      await flush();
      sha256.update(chunk, "utf8");
      await output.write(chunk);
      writtenBytes += bytes;
      maxBufferedBytes = Math.max(maxBufferedBytes, bytes);
      return;
    }
    buffered += chunk;
    maxBufferedBytes = Math.max(maxBufferedBytes, encodedBytes(buffered));
  };

  try {
    await emit(envelopePrefix(plan));
    fnv = updateFnv(fnv, `{"formatVersion":${SYNTHETIC_FIXTURE_FORMAT_VERSION},"state":`);
    for (const chunk of stateChunks(plan)) {
      fnv = updateFnv(fnv, chunk);
      await emit(chunk, chunk.startsWith("{") && chunk.includes("\"id\""));
    }
    fnv = updateFnv(fnv, "}");
    const stateChecksum = fnv.toString(16).padStart(8, "0");
    await emit(envelopeSuffix(stateChecksum));
    await flush();
    await output.close();
    if (writtenBytes !== plan.targetBytes) {
      throw new Error(`Synthetic fixture size mismatch: expected ${plan.targetBytes}, wrote ${writtenBytes}`);
    }
    return {
      generatorVersion: SYNTHETIC_FIXTURE_GENERATOR_VERSION,
      profile: plan.profile.id,
      mode: plan.mode,
      slot: plan.slot,
      seed: plan.seed,
      resourceMode: plan.resourceMode,
      bytes: writtenBytes,
      sha256: sha256.digest("hex"),
      stateChecksum,
      entityCount: plan.entityCount,
      beltCount: plan.beltCount,
      paddingBytes: plan.paddingBytes,
      maxBufferedBytes,
      maxRecordBytes,
      outputPath,
    };
  } catch (error) {
    await output.abort();
    throw error;
  }
}

const FORBIDDEN_IDENTITY_KEYS = new Set([
  "username",
  "email",
  "password",
  "token",
  "userId",
  "accountId",
  "displayName",
  "sessionId",
  "ipHash",
  "deviceHash",
]);

function auditValue(value, path, result) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) result.nonFinite.push(path);
    if (value < 0) result.negative.push(path);
    return;
  }
  if (typeof value === "string") {
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) result.identityValues.push(path);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) auditValue(value[index], `${path}[${index}]`, result);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_IDENTITY_KEYS.has(key) && child !== null && child !== undefined && child !== "") result.identityKeys.push(childPath);
    auditValue(child, childPath, result);
  }
}

/** Audit every generated record one at a time; no full payload is retained. */
export function auditSyntheticFixtureContract(options = {}) {
  const plan = createSyntheticFixturePlan(options);
  const result = { negative: [], nonFinite: [], identityKeys: [], identityValues: [] };
  let maxRecordBytes = 0;
  const inspect = (record, path) => {
    auditValue(record, path, result);
    maxRecordBytes = Math.max(maxRecordBytes, encodedBytes(JSON.stringify(record)));
  };
  coreEntities(plan.resourceMode).forEach((record, index) => inspect(record, `entities[${index}]`));
  for (let index = 0; index < plan.generatedEntityCount; index += 1) inspect(generatedEntity(index, plan.seed), `entities[${plan.coreEntityCount + index}]`);
  coreBelts().forEach((record, index) => inspect(record, `belts[${index}]`));
  for (let index = 0; index < plan.generatedBeltCount; index += 1) inspect(generatedBelt(index, plan.seed), `belts[${plan.coreBeltCount + index}]`);
  inspect(stateHeader(plan), "state");
  inspect(stateTail(plan), "state");
  return {
    profile: plan.profile.id,
    mode: plan.mode,
    slot: plan.slot,
    seed: plan.seed,
    resourceMode: plan.resourceMode,
    entityCount: plan.entityCount,
    beltCount: plan.beltCount,
    paddingBytes: plan.paddingBytes,
    maxRecordBytes,
    coverage: plan.coverage,
    ...result,
  };
}

export function syntheticFixtureFilename({ profile, mode, slot = "main", seed = SYNTHETIC_FIXTURE_SEED }) {
  return `dsp-idle-synthetic-v47-${profile}-${mode}-slot-${slot}-seed-${seed}.json`;
}

function parseList(value, allowed, label) {
  if (value === "all") return [...allowed];
  const selected = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of selected) {
    if (!allowed.map(String).includes(entry)) throw new Error(`Unknown ${label}: ${entry}`);
  }
  return selected;
}

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set();
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const separator = argument.indexOf("=");
    if (separator < 0) flags.add(argument.slice(2));
    else values.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  return { values, flags };
}

function usage() {
  return [
    "Generate deterministic, anonymous DSPidle v47 save fixtures.",
    "",
    "  node scripts/generate-synthetic-save-fixtures.mjs --profile=1m,8m,20m,29m --mode=normal,speedrun --output-dir=<dir>",
    "  node scripts/generate-synthetic-save-fixtures.mjs --profile=29m --mode=normal --dry-run --json",
    "",
    "Options:",
    "  --profile=<1m|8m|20m|29m|all>  One or more comma-separated profiles.",
    "  --mode=<normal|speedrun|all>     One or more comma-separated modes.",
    "  --slot=<main|1|2|3>              Envelope slot; default main.",
    "  --seed=<integer>                 Deterministic seed; default 1040406.",
    "  --output-dir=<dir>               Required unless --dry-run is used.",
    "  --dry-run                        Compute bytes/checksums without writing files.",
    "  --force                          Explicitly replace same-name output files.",
    "  --json                           Emit one machine-readable JSON record per fixture.",
    "  --describe                       Print profile descriptions without generating.",
  ].join("\n");
}

async function runCli(argv) {
  const { values, flags } = parseArguments(argv);
  if (flags.has("help")) {
    console.log(usage());
    return;
  }
  if (flags.has("describe")) {
    console.log(JSON.stringify({
      generatorVersion: SYNTHETIC_FIXTURE_GENERATOR_VERSION,
      seed: SYNTHETIC_FIXTURE_SEED,
      profiles: SYNTHETIC_FIXTURE_PROFILES,
      modes: MODES,
      slots: SLOTS,
      coverage: COVERAGE,
    }, null, 2));
    return;
  }
  const profiles = parseList(values.get("profile") ?? "all", PROFILE_ORDER, "profile");
  const modes = parseList(values.get("mode") ?? "all", MODES, "mode");
  const slot = normalizedSlot(values.get("slot") ?? "main");
  const seed = normalizedSeed(values.get("seed") ?? SYNTHETIC_FIXTURE_SEED);
  const dryRun = flags.has("dry-run");
  const outputDirectory = values.get("output-dir") ? resolve(values.get("output-dir")) : null;
  if (!dryRun && !outputDirectory) throw new Error("--output-dir is required unless --dry-run is used");
  for (const profile of profiles) {
    for (const mode of modes) {
      const outputPath = outputDirectory ? join(outputDirectory, syntheticFixtureFilename({ profile, mode, slot, seed })) : null;
      const result = await generateSyntheticSaveFixture({ profile, mode, slot, seed, outputPath, overwrite: flags.has("force") });
      if (flags.has("json")) console.log(JSON.stringify(result));
      else console.log(`${result.profile}/${result.mode}/slot-${result.slot}: ${result.bytes} bytes sha256=${result.sha256} state=${result.stateChecksum}${result.outputPath ? ` -> ${result.outputPath}` : ""}`);
    }
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
  });
}

export const SYNTHETIC_FIXTURE_SCRIPT_PATH = fileURLToPath(import.meta.url);
