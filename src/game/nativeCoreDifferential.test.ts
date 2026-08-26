import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "./contentPacks";
import {
  advanceSimulationBudget,
  connectBeltWithResult,
  createInitialState,
  placeBuilding,
  setStationSlotItem,
  setStationSlotMinimumLoad,
  setStationSlotMode,
  setStationSlotPriority,
} from "./engine";
import { CAMPAIGN_TASKS } from "./campaign";
import { getConstructionDefinition, TECHNOLOGIES } from "./content";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import { startSystemSpaceStationConstruction } from "./systemSpaceStation";
import type { GameState } from "./types";

const require = createRequire(import.meta.url);
const { NativeHostClient, NativeSaveSessionRegistry } = require("../../desktop/native-host.cjs") as {
  NativeHostClient: new (options: { binaryPath: string; rootPath: string; requestTimeoutMs: number }) => {
    start(version: string): Promise<{ capabilities: string[] }>;
    request(request: Record<string, unknown>): Promise<any>;
    stop(): Promise<void>;
  };
  NativeSaveSessionRegistry: new (client: any) => {
    begin(owner: number, request: Record<string, unknown>): Promise<{ transactionId: string }>;
    write(owner: number, transactionId: string, records: Array<{ key: string; value: string | null }>): Promise<void>;
    commit(owner: number, transactionId: string): Promise<any>;
  };
};

const binaryPath = path.resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");

function canonicalSha256(value: unknown): string {
  value = JSON.parse(JSON.stringify(value));
  const hash = createHash("sha256");
  const visit = (current: unknown) => {
    if (current === null || typeof current !== "object") {
      hash.update(JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      hash.update("[");
      current.forEach((entry, index) => {
        if (index > 0) hash.update(",");
        visit(entry);
      });
      hash.update("]");
      return;
    }
    hash.update("{");
    const record = current as Record<string, unknown>;
    Object.keys(record).sort().forEach((key, index) => {
      if (index > 0) hash.update(",");
      hash.update(JSON.stringify(key));
      hash.update(":");
      visit(record[key]);
    });
    hash.update("}");
  };
  visit(value);
  return hash.digest("hex");
}

function canonicalFields(value: GameState): Record<string, string> {
  const persisted = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(persisted).map(([key, field]) => [key, canonicalSha256(field)]));
}

function quiescentState(): GameState {
  const state = createInitialState(0x1a2b3c4d);
  state.entities = [];
  state.belts = [];
  state.handcraftQueue = [];
  state.constructionQueue = [];
  state.constructionAutomation.enabled = false;
  state.constructionAutomation.jobs = {};
  state.constructionAutomation.targetStock = {};
  state.exploration.missions = [];
  state.dysonSwarm.totalLaunched = 0;
  state.dysonSphere.totalRocketsLaunched = 0;
  state.systemSpaceStations = {};
  state.quantumLogisticsNetwork.inventory = {};
  state.timeWarp.enabled = false;
  state.timeWarp.controllerEntityId = null;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  state.endgame.activeInfiniteResearchId = null;
  state.endgame.constructionActivity.activityId = null;
  for (const project of Object.values(state.endgame.exportProjects)) project.enabled = false;
  return state;
}

function simpleMiningState(): GameState {
  let state = createInitialState(0x5e71cafe);
  state.entities = state.entities.filter((entity) =>
    ["vein_iron", "vein_water", "vein_oil"].includes(entity.id));
  const configureExtractor = (
    entityId: string,
    extractorBuildingId: "mining_machine" | "water_pump" | "oil_extractor",
    minerCount: number,
  ) => {
    const vein = state.entities.find((entity) => entity.id === entityId)!;
    vein.minerCount = minerCount;
    vein.extractorBuildingId = extractorBuildingId;
    vein.outputs[vein.resourceId!] = 0;
    vein.progress = 0;
    vein.utilization = 0;
    vein.productionRate = 0;
  };
  configureExtractor("vein_iron", "mining_machine", 4);
  configureExtractor("vein_water", "water_pump", 2);
  configureExtractor("vein_oil", "oil_extractor", 1);
  state.belts = [];
  state.settings.resourceMode = "infinite";
  state.constructionAutomation.enabled = false;
  state.constructionAutomation.jobs = {};
  state.constructionAutomation.targetStock = {};
  state.exploration.missions = [];
  state.systemSpaceStations = {};
  state.quantumLogisticsNetwork.enabled = false;
  state.quantumLogisticsNetwork.inventory = {};
  state.timeWarp.enabled = false;
  state.timeWarp.controllerEntityId = null;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  state.endgame.activeInfiniteResearchId = null;
  state.endgame.infiniteResearch.vein_utilization.level = 3;
  state.endgame.constructionActivity.activityId = null;
  for (const project of Object.values(state.endgame.exportProjects)) project.enabled = false;
  state.research.completedTechIds = ["mining_speed_2", "proliferator_3"];
  const completedCampaign = CAMPAIGN_TASKS.map((task) => task.id);
  state.campaign = {
    activeChapterId: "galactic_endgame",
    activeTaskId: null,
    completedTaskIds: [...completedCampaign],
    rewardedTaskIds: [...completedCampaign],
  };
  state.construction.wind_turbine = 2;
  state = placeBuilding(state, "wind_turbine", { x: 0, y: -180 }, 2);
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  state.entities.push(
    {
      ...wind,
      id: "native_solar_fixture",
      buildingId: "solar_panel",
      machineCount: 3,
      position: { x: 160, y: -180 },
      inputs: {},
      outputs: {},
    },
    {
      ...wind,
      id: "native_geothermal_fixture",
      buildingId: "geothermal_power_station",
      planetId: "ashen",
      machineCount: 1,
      position: { x: 0, y: 0 },
      inputs: {},
      outputs: {},
    },
  );
  state.construction.arc_smelter = 2;
  state = placeBuilding(state, "arc_smelter", { x: 320, y: -180 }, 1);
  state = placeBuilding(state, "arc_smelter", { x: 320, y: 20 }, 1);
  const smelters = state.entities.filter((entity) => entity.buildingId === "arc_smelter");
  for (const smelter of smelters) {
    smelter.recipeId = "iron_ingot";
    smelter.inputs.iron_ore = 0;
    smelter.outputs.iron_ingot = 0;
  }
  smelters[0].sprayCoaterInstalled = true;
  smelters[0].proliferatorTier = 3;
  smelters[0].proliferatorMode = "extra";
  smelters[0].proliferatorPoints = 7;
  smelters[0].inputs.proliferator_mk3 = 20;
  smelters[0].proliferatorBonusProgress = { iron_ingot: 0.375 };
  smelters[1].sprayCoaterInstalled = true;
  smelters[1].proliferatorTier = 3;
  smelters[1].proliferatorMode = "speed";
  smelters[1].proliferatorPoints = 5;
  smelters[1].inputs.proliferator_mk3 = 20;
  state.construction.assembling_machine_mk1 = 1;
  state = placeBuilding(state, "assembling_machine_mk1", { x: 620, y: -80 }, 1);
  const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
  assembler.recipeId = "gear";
  assembler.inputs.iron_ingot = 0;
  assembler.outputs.gear = 0;
  state.construction.splitter_4way = 1;
  state = placeBuilding(state, "splitter_4way", { x: 500, y: 160 }, 1);
  const splitter = state.entities.find((entity) => entity.buildingId === "splitter_4way")!;
  splitter.distributionMode = "balanced";
  state.construction.storage_mk1 = 1;
  state = placeBuilding(state, "storage_mk1", { x: 660, y: 180 }, 1);
  const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  state.construction.conveyor_belt_mk1 = 24;
  state = connectBeltWithResult(state, "vein_iron", smelters[0].id, "iron_ore", 1, undefined, 2).state;
  state = connectBeltWithResult(state, "vein_iron", smelters[1].id, "iron_ore", 1, undefined, 1).state;
  state = connectBeltWithResult(state, smelters[0].id, splitter.id, "iron_ingot", 1, undefined, 2).state;
  state = connectBeltWithResult(state, smelters[1].id, splitter.id, "iron_ingot", 1, undefined, 1).state;
  state = connectBeltWithResult(state, splitter.id, assembler.id, "iron_ingot", 1, undefined, 2).state;
  state = connectBeltWithResult(state, splitter.id, storage.id, "iron_ingot", 1, undefined, 1).state;
  state = connectBeltWithResult(state, storage.id, assembler.id, "iron_ingot", 1, undefined, 1).state;
  state.belts[0].priority = 2;
  state.belts[1].priority = 1;
  state.belts.at(-2)!.priority = 0;
  return state;
}

function inactiveTimeWarpControllerState(): GameState {
  const state = simpleMiningState();
  const template = state.entities.find((entity) => entity.kind === "machine")!;
  state.entities.push({
    ...template,
    id: "native_time_warp_controller",
    buildingId: "time_warp_device",
    recipeId: undefined,
    position: { x: -420, y: 260 },
    inputs: {},
    outputs: {},
    progress: 0,
    powerFactor: 1,
    powerInputKw: 10 ** 16,
    utilization: 1,
    productionRate: 0,
  });
  state.timeWarp = {
    ...state.timeWarp,
    controllerEntityId: "native_time_warp_controller",
    enabled: false,
    requestedMultiplier: 15,
    effectiveMultiplier: 15,
    requiredPowerKw: 10 ** 16,
    allocatedPowerKw: 10 ** 16,
  };
  return state;
}

function dysonOperationsState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push(
    "dyson_swarm",
    "ray_receiver",
    "dyson_sphere_program",
    "vertical_launching_silo",
    "dyson_shell",
  );
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  wind.machineCount = 2_000;

  state.construction.em_rail_ejector = 2;
  state = placeBuilding(state, "em_rail_ejector", { x: 880, y: -180 }, 2);
  const ejector = state.entities.find((entity) => entity.buildingId === "em_rail_ejector")!;
  ejector.recipeId = "solar_sail_launch";
  ejector.inputs.solar_sail = 200;
  ejector.targetDysonOrbitId = state.dysonEngineering.activeOrbitBySystem.helios!;

  state.construction.vertical_launching_silo = 2;
  state = placeBuilding(state, "vertical_launching_silo", { x: 1080, y: -180 }, 2);
  const silo = state.entities.find((entity) => entity.buildingId === "vertical_launching_silo")!;
  silo.recipeId = "carrier_rocket_launch";
  silo.inputs.small_carrier_rocket = 200;

  state.construction.ray_receiver = 2;
  state = placeBuilding(state, "ray_receiver", { x: 1280, y: -180 });
  state = placeBuilding(state, "ray_receiver", { x: 1480, y: -180 });
  const receivers = state.entities.filter((entity) => entity.buildingId === "ray_receiver");
  receivers[0].machineCount = 2;
  receivers[0].recipeId = "ray_power";
  receivers[1].recipeId = "critical_photon";
  receivers[1].outputs.critical_photon = 0;

  const orbit = state.dysonEngineering.orbitsBySystem.helios[0];
  orbit.sailsInOrbit = 240;
  orbit.totalLaunched = 260;
  orbit.totalExpired = 20;
  orbit.decayProgress = 0.35;
  orbit.generationKw = orbit.sailsInOrbit * 88;
  state.dysonSwarm = {
    sailsInOrbit: orbit.sailsInOrbit,
    totalLaunched: orbit.totalLaunched,
    totalExpired: orbit.totalExpired,
    decayProgress: orbit.decayProgress,
    generationKw: orbit.generationKw,
    receiverLoadKw: 0,
  };
  state.dysonPlans.helios.structurePoints = 25;
  state.dysonPlans.helios.shellSails = 100;
  state.dysonSphere = {
    structurePoints: 25,
    totalRocketsLaunched: 25,
    shellSails: 100,
    totalSailsAbsorbed: 100,
    absorptionProgress: 0.2,
    generationKw: 25 * 960 + 100 * 88,
  };
  state.dysonEngineering.absorptionProgressBySystem.helios = 0.2;
  state.dysonEngineering.launchEnabled = true;
  state.dysonEngineering.launchMode = "balanced";
  state.dysonEngineering.launchThrottle = 0.5;
  state.dysonEngineering.launchEnergySpentMj = 123.456;
  return state;
}

function finiteMiningState(): GameState {
  const state = simpleMiningState();
  state.settings.resourceMode = "finite";
  for (const entityId of ["vein_iron", "vein_oil"]) {
    const vein = state.entities.find((entity) => entity.id === entityId)!;
    vein.resourceRemaining = 3;
    vein.resourceCapacity = 3;
    vein.resourceDepletionRemainder = 0;
    vein.outputs[vein.resourceId!] = 0;
  }
  return state;
}

function finiteResearchState(): GameState {
  let state = simpleMiningState();
  state.construction.matrix_lab = 2;
  state = placeBuilding(state, "matrix_lab", { x: 820, y: -180 }, 1);
  state = placeBuilding(state, "matrix_lab", { x: 820, y: 20 }, 1);
  const labs = state.entities.filter((entity) => entity.buildingId === "matrix_lab");
  for (const lab of labs) {
    lab.recipeId = "matrix_research";
    lab.inputs.electromagnetic_matrix = 100;
    lab.progress = 0;
  }
  labs[0].sprayCoaterInstalled = true;
  labs[0].proliferatorTier = 3;
  labs[0].proliferatorMode = "speed";
  labs[0].proliferatorPoints = 2;
  labs[0].inputs.proliferator_mk3 = 10;
  state.research.selectedTechId = "electromagnetic_matrix";
  state.research.queuedTechIds = ["electromagnetism", "solar_energy"];
  state.research.progressByTech = {};
  return state;
}

function infiniteResearchState(): GameState {
  const state = finiteResearchState();
  if (!state.research.completedTechIds.includes("universe_matrix")) {
    state.research.completedTechIds.push("universe_matrix");
  }
  state.research.selectedTechId = null;
  state.research.queuedTechIds = [];
  state.endgame.activeInfiniteResearchId = "matrix_compression";
  state.endgame.autoResearch = true;
  state.endgame.infiniteResearch.matrix_compression = { level: 9, progress: "12900" };
  const labs = state.entities.filter((entity) => entity.recipeId === "matrix_research");
  for (const lab of labs) {
    lab.inputs = { universe_matrix: 100_000 };
    lab.machineCount = 4;
    lab.progress = 0.25;
  }
  labs[0].sprayCoaterInstalled = true;
  labs[0].proliferatorTier = 3;
  labs[0].proliferatorMode = "speed";
  labs[0].proliferatorPoints = 8;
  labs[0].inputs.proliferator_mk3 = 20;
  return state;
}

function dispatchablePowerState(): GameState {
  let state = simpleMiningState();
  const template = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  const solar = state.entities.find((entity) => entity.id === "native_solar_fixture")!;
  solar.powerGridId = "grid-b";
  const powerEntity = (
    id: string,
    buildingId: "thermal_power_plant" | "mini_fusion_power_plant" | "artificial_star" | "accumulator" | "energy_exchanger",
    powerGridId: "grid-a" | "grid-b",
  ) => ({
    ...template,
    id,
    buildingId,
    powerGridId,
    machineCount: 1,
    position: { x: template.position.x + state.entities.length * 20, y: template.position.y - 120 },
    inputs: {},
    outputs: {},
    progress: 0,
    utilization: 0,
    productionRate: 0,
    powerOutputKw: 0,
    powerInputKw: 0,
  });
  state.entities.push(
    {
      ...powerEntity("native_thermal_fixture", "thermal_power_plant", "grid-a"),
      fuelItemId: "coal",
      fuelRemainingMj: 0.25,
      inputs: { coal: 4 },
      generationPriority: 1,
    },
    {
      ...powerEntity("native_fusion_fixture", "mini_fusion_power_plant", "grid-a"),
      fuelItemId: "deuteron_fuel_rod",
      fuelRemainingMj: 0.5,
      inputs: { deuteron_fuel_rod: 0 },
      generationPriority: 3,
    },
    {
      ...powerEntity("native_star_fixture", "artificial_star", "grid-a"),
      fuelItemId: "antimatter_fuel_rod",
      fuelRemainingMj: 0.5,
      inputs: { antimatter_fuel_rod: 0 },
      generationPriority: 3,
    },
    {
      ...powerEntity("native_accumulator_discharge", "accumulator", "grid-a"),
      storedEnergyMj: 45,
      energyMode: "auto",
      generationPriority: 2,
    },
    {
      ...powerEntity("native_exchanger_discharge", "energy_exchanger", "grid-a"),
      storedEnergyMj: 0.5,
      energyMode: "discharge",
      inputs: { charged_accumulator: 2 },
      outputs: { accumulator: 0 },
      generationPriority: 2,
      recipeId: "accumulator_discharge",
    },
    {
      ...powerEntity("native_exchanger_charge", "energy_exchanger", "grid-b"),
      storedEnergyMj: 89,
      energyMode: "charge",
      inputs: { accumulator: 1 },
      outputs: { charged_accumulator: 0 },
      recipeId: "accumulator_charge",
    },
    {
      ...powerEntity("native_accumulator_charge", "accumulator", "grid-b"),
      storedEnergyMj: 0,
      energyMode: "auto",
    },
  );
  const storageTemplate = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  state.entities.push(
    {
      ...storageTemplate,
      id: "native_coal_storage",
      storedItemId: "coal",
      position: { x: 920, y: 220 },
      inputs: { coal: 0 },
      outputs: { coal: 20 },
    },
    {
      ...storageTemplate,
      id: "native_empty_cell_storage",
      storedItemId: "accumulator",
      position: { x: 1040, y: 220 },
      inputs: { accumulator: 0 },
      outputs: { accumulator: 4 },
    },
    {
      ...storageTemplate,
      id: "native_discharged_cell_storage",
      storedItemId: "accumulator",
      position: { x: 1160, y: 220 },
      inputs: { accumulator: 0 },
      outputs: { accumulator: 0 },
    },
  );
  state = connectBeltWithResult(state, "native_coal_storage", "native_thermal_fixture", "coal", 1).state;
  state = connectBeltWithResult(state, "native_empty_cell_storage", "native_exchanger_charge", "accumulator", 1).state;
  state = connectBeltWithResult(state, "native_exchanger_discharge", "native_discharged_cell_storage", "accumulator", 1).state;
  return state;
}

function localLogisticsState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push("logistics_engine_1", "logistics_capacity_1");
  state.endgame.infiniteResearch.galactic_logistics.level = 2;
  state.construction.planetary_logistics_station = 3;
  state = placeBuilding(state, "planetary_logistics_station", { x: 820, y: 80 }, 1);
  state = placeBuilding(state, "planetary_logistics_station", { x: 1020, y: 80 }, 1);
  state = placeBuilding(state, "planetary_logistics_station", { x: 1220, y: 80 }, 1);
  const [supplyA, supplyB, demand] = state.entities.filter((entity) =>
    entity.buildingId === "planetary_logistics_station");
  const solar = state.entities.find((entity) => entity.id === "native_solar_fixture")!;
  solar.powerGridId = "grid-b";
  for (const station of [supplyA, supplyB, demand]) station.powerGridId = "grid-b";

  for (const station of [supplyA, supplyB, demand]) {
    state = setStationSlotItem(state, station.id, 0, "iron_ingot");
  }
  state = setStationSlotMode(state, demand.id, 0, "local", "demand");
  state = setStationSlotMinimumLoad(state, demand.id, 0, 0.5);
  state = setStationSlotMinimumLoad(state, supplyA.id, 0, 0.25);
  state = setStationSlotMinimumLoad(state, supplyB.id, 0, 1);
  state = setStationSlotPriority(state, supplyB.id, 0, 2);

  for (const station of [supplyA, demand]) {
    state = setStationSlotItem(state, station.id, 1, "copper_ingot");
  }
  state = setStationSlotMode(state, demand.id, 1, "local", "demand");
  state = setStationSlotMinimumLoad(state, demand.id, 1, 1);
  state = setStationSlotPriority(state, demand.id, 1, 2);

  const currentSupplyA = state.entities.find((entity) => entity.id === supplyA.id)!;
  const currentSupplyB = state.entities.find((entity) => entity.id === supplyB.id)!;
  const currentDemand = state.entities.find((entity) => entity.id === demand.id)!;
  currentSupplyA.stationSlots![0].minStock = 5;
  currentSupplyA.outputs = { iron_ingot: 83, copper_ingot: 0 };
  currentSupplyA.inputs = { iron_ingot: 0, copper_ingot: 0 };
  currentSupplyA.stationDrones = 1;
  currentSupplyB.outputs = { iron_ingot: 61 };
  currentSupplyB.inputs = { iron_ingot: 0 };
  currentSupplyB.stationDrones = 1;
  currentDemand.stationSlots![0].maxStock = 90;
  currentDemand.stationSlots![1].maxStock = 130;
  currentDemand.outputs = { iron_ingot: 0, copper_ingot: 0 };
  currentDemand.inputs = { iron_ingot: 0, copper_ingot: 0 };
  currentDemand.stationDrones = 2;

  const storageTemplate = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  state.entities.push(
    {
      ...storageTemplate,
      id: "native_station_copper_feed",
      position: { x: 800, y: 260 },
      storedItemId: "copper_ingot",
      inputs: { copper_ingot: 0 },
      outputs: { copper_ingot: 180 },
    },
    {
      ...storageTemplate,
      id: "native_station_copper_sink",
      position: { x: 1240, y: 260 },
      storedItemId: "copper_ingot",
      inputs: { copper_ingot: 0 },
      outputs: { copper_ingot: 0 },
    },
  );
  state = connectBeltWithResult(state, "native_station_copper_feed", supplyA.id, "copper_ingot", 1, undefined, 2).state;
  state = connectBeltWithResult(state, demand.id, "native_station_copper_sink", "copper_ingot", 1, undefined, 1).state;
  return state;
}

function interstellarLogisticsState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push("interstellar_logistics", "logistics_engine_1", "logistics_capacity_1");
  state.endgame.infiniteResearch.galactic_logistics.level = 1;
  state.construction.interstellar_logistics_station = 2;
  state.activePlanetId = "home";
  state = placeBuilding(state, "interstellar_logistics_station", { x: 820, y: 80 }, 1);
  const supplyId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!.id;
  state.activePlanetId = "ashen";
  state = placeBuilding(state, "interstellar_logistics_station", { x: 200, y: 80 }, 1);
  const demandId = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station" && entity.id !== supplyId)!.id;
  state.activePlanetId = "home";

  for (const stationId of [supplyId, demandId]) {
    state = setStationSlotItem(state, stationId, 0, "titanium_ingot");
    state = setStationSlotItem(state, stationId, 1, "high_purity_silicon");
  }
  state = setStationSlotMode(state, demandId, 0, "remote", "demand");
  state = setStationSlotMode(state, demandId, 1, "remote", "demand");
  state = setStationSlotMinimumLoad(state, demandId, 0, 0.5);
  state = setStationSlotMinimumLoad(state, supplyId, 0, 0.25);
  state = setStationSlotMinimumLoad(state, demandId, 1, 1);
  state = setStationSlotPriority(state, demandId, 1, 2);

  const supply = state.entities.find((entity) => entity.id === supplyId)!;
  const demand = state.entities.find((entity) => entity.id === demandId)!;
  supply.outputs = { titanium_ingot: 257, high_purity_silicon: 170 };
  supply.inputs = { titanium_ingot: 0, high_purity_silicon: 0 };
  supply.stationSlots![0].minStock = 7;
  supply.stationVessels = 2;
  demand.outputs = { titanium_ingot: 0, high_purity_silicon: 0 };
  demand.inputs = { titanium_ingot: 0, high_purity_silicon: 0 };
  demand.stationSlots![0].maxStock = 180;
  demand.stationSlots![1].maxStock = 220;
  demand.stationVessels = 2;
  return state;
}

function warpedInterstellarLogisticsState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push(
    "interstellar_logistics",
    "space_warp",
    "logistics_engine_1",
    "logistics_capacity_1",
  );
  state.exploration.unlockedSystemIds.push("borealis");
  state.construction.interstellar_logistics_station = 2;
  state.activePlanetId = "home";
  state = placeBuilding(state, "interstellar_logistics_station", { x: 820, y: 80 }, 1);
  const supplyId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!.id;
  state.activePlanetId = "frost";
  state = placeBuilding(state, "interstellar_logistics_station", { x: 200, y: 80 }, 1);
  const demandId = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station" && entity.id !== supplyId)!.id;
  state.activePlanetId = "home";
  for (const stationId of [supplyId, demandId]) {
    state = setStationSlotItem(state, stationId, 0, "titanium_ingot");
  }
  state = setStationSlotMode(state, demandId, 0, "remote", "demand");
  state = setStationSlotMinimumLoad(state, demandId, 0, 0.5);
  state = setStationSlotMinimumLoad(state, supplyId, 0, 0.25);
  const supply = state.entities.find((entity) => entity.id === supplyId)!;
  const demand = state.entities.find((entity) => entity.id === demandId)!;
  supply.outputs = { titanium_ingot: 400 };
  supply.inputs = { titanium_ingot: 0 };
  supply.stationVessels = 1;
  supply.stationWarpers = 1;
  demand.outputs = { titanium_ingot: 0 };
  demand.inputs = { titanium_ingot: 0 };
  demand.stationVessels = 2;
  demand.stationWarpers = 2;
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  state.entities.push({
    ...wind,
    id: "native_frost_wind_fixture",
    planetId: "frost",
    position: { x: 0, y: -180 },
    machineCount: 10,
    inputs: {},
    outputs: {},
  });
  return state;
}

function stationWarperAutoRefillState(): GameState {
  const state = warpedInterstellarLogisticsState();
  const supply = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station" && entity.planetId === "home")!;
  const demand = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station" && entity.planetId === "frost")!;
  supply.stationWarperAutoRefill = true;
  supply.stationWarperTarget = 10;
  supply.stationWarpers = 0;
  supply.stationVessels = 1;
  supply.inputs = { ...supply.inputs, space_warper: 2 };
  supply.outputs = { ...supply.outputs, space_warper: 3 };
  demand.stationVessels = 0;
  demand.stationWarpers = 0;
  state.tray.space_warper = 20;
  state.planetTrays.home.space_warper = 20;
  return state;
}

function relayInterstellarLogisticsState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push("interstellar_logistics", "space_warp", "logistics_engine_1");
  state.exploration.unlockedSystemIds.push("borealis", "aurora");
  state.construction.interstellar_logistics_station = 3;
  const placeStation = (planetId: GameState["activePlanetId"], position: { x: number; y: number }) => {
    state.activePlanetId = planetId;
    state = placeBuilding(state, "interstellar_logistics_station", position, 1);
    return state.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station").at(-1)!.id;
  };
  const supplyId = placeStation("home", { x: 820, y: 80 });
  const hubId = placeStation("frost", { x: 200, y: 80 });
  const demandId = placeStation("verdant", { x: 200, y: 80 });
  state.activePlanetId = "home";
  for (const stationId of [supplyId, demandId]) {
    state = setStationSlotItem(state, stationId, 0, "processor");
  }
  state = setStationSlotMode(state, demandId, 0, "remote", "demand");
  const supply = state.entities.find((entity) => entity.id === supplyId)!;
  const hub = state.entities.find((entity) => entity.id === hubId)!;
  const demand = state.entities.find((entity) => entity.id === demandId)!;
  supply.outputs = { processor: 200 };
  supply.inputs = { processor: 0 };
  supply.stationVessels = 1;
  supply.stationWarpers = 2;
  hub.stationHubEnabled = true;
  hub.stationHubPriority = 2;
  demand.outputs = { processor: 0 };
  demand.inputs = { processor: 0 };
  demand.stationVessels = 1;
  demand.stationWarpers = 2;
  demand.stationSlots![0].routePolicy = "relay-required";
  demand.stationSlots![0].warperBudget = 2;
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  state.entities.push(
    {
      ...wind,
      id: "native_relay_frost_power",
      planetId: "frost",
      position: { x: 0, y: -180 },
      machineCount: 10,
      inputs: {},
      outputs: {},
    },
    {
      ...wind,
      id: "native_relay_verdant_power",
      planetId: "verdant",
      position: { x: 0, y: -180 },
      machineCount: 10,
      inputs: {},
      outputs: {},
    },
  );
  return state;
}

function orbitalCollectorLogisticsState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push("interstellar_logistics", "orbital_collection", "logistics_engine_1");
  state.construction.orbital_collector = 1;
  state.construction.interstellar_logistics_station = 1;
  state.activePlanetId = "giant";
  state = placeBuilding(state, "orbital_collector", { x: 0, y: 0 }, 1);
  const collector = state.entities.find((entity) => entity.buildingId === "orbital_collector")!;
  collector.storedItemId = "hydrogen";
  collector.inputs = {};
  collector.outputs = { hydrogen: 150 };
  collector.progress = 0.25;
  state.activePlanetId = "home";
  state = placeBuilding(state, "interstellar_logistics_station", { x: 820, y: 80 }, 1);
  const demandId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!.id;
  state = setStationSlotItem(state, demandId, 0, "hydrogen");
  state = setStationSlotMode(state, demandId, 0, "remote", "demand");
  state = setStationSlotMinimumLoad(state, demandId, 0, 0.5);
  const demand = state.entities.find((entity) => entity.id === demandId)!;
  demand.outputs = { hydrogen: 0 };
  demand.inputs = { hydrogen: 0 };
  demand.stationVessels = 2;
  return state;
}

function quantumLogisticsState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push("interstellar_logistics", "orbital_collection", "quantum_logistics_network");
  state.quantumLogisticsNetwork.enabled = true;
  state.quantumLogisticsNetwork.inventory.copper_ore = "5";
  state.construction.interstellar_logistics_station = 2;
  state.construction.orbital_collector = 1;
  state.activePlanetId = "home";
  state = placeBuilding(state, "interstellar_logistics_station", { x: 820, y: 80 }, 1);
  const supplyId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!.id;
  state = placeBuilding(state, "interstellar_logistics_station", { x: 1040, y: 80 }, 1);
  const demandId = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station" && entity.id !== supplyId)!.id;
  state = setStationSlotItem(state, supplyId, 0, "iron_ore");
  state = setStationSlotMode(state, supplyId, 0, "remote", "supply");
  state = setStationSlotItem(state, demandId, 0, "iron_ore");
  state = setStationSlotMode(state, demandId, 0, "remote", "demand");
  state = setStationSlotItem(state, demandId, 1, "copper_ore");
  state = setStationSlotMode(state, demandId, 1, "remote", "demand");
  state = setStationSlotPriority(state, demandId, 0, 2);
  const supply = state.entities.find((entity) => entity.id === supplyId)!;
  const demand = state.entities.find((entity) => entity.id === demandId)!;
  for (const station of [supply, demand]) {
    station.stationTier = 2;
    station.quantumMode = "quantum";
    station.stationVessels = 0;
  }
  supply.inputs = { iron_ore: 20 };
  supply.outputs = { iron_ore: 80 };
  demand.inputs = { iron_ore: 0, copper_ore: 0 };
  demand.outputs = { iron_ore: 0, copper_ore: 0 };

  state.activePlanetId = "giant";
  state = placeBuilding(state, "orbital_collector", { x: 0, y: 0 }, 1);
  const collector = state.entities.find((entity) => entity.buildingId === "orbital_collector")!;
  collector.quantumMode = "quantum";
  collector.storedItemId = "hydrogen";
  collector.inputs = {};
  collector.outputs = { hydrogen: 150 };
  collector.progress = 0.25;
  state.activePlanetId = "home";
  return state;
}

function quantumLocalDroneBridgeState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push("interstellar_logistics", "quantum_logistics_network", "logistics_engine_1");
  state.quantumLogisticsNetwork.enabled = true;
  state.quantumLogisticsNetwork.inventory.copper_ore = "1000";
  state.construction.planetary_logistics_station = 2;
  state.construction.interstellar_logistics_station = 2;
  state.activePlanetId = "home";
  const placeStation = (buildingId: "planetary_logistics_station" | "interstellar_logistics_station", x: number) => {
    state = placeBuilding(state, buildingId, { x, y: 300 }, 1);
    return state.entities.filter((entity) => entity.buildingId === buildingId).at(-1)!.id;
  };
  const localSourceId = placeStation("planetary_logistics_station", 500);
  const quantumUploadId = placeStation("interstellar_logistics_station", 700);
  const quantumDownloadId = placeStation("interstellar_logistics_station", 900);
  const localSinkId = placeStation("planetary_logistics_station", 1100);
  for (const stationId of [localSourceId, quantumUploadId]) {
    state = setStationSlotItem(state, stationId, 0, "iron_ore");
  }
  state = setStationSlotMode(state, localSourceId, 0, "local", "supply");
  state = setStationSlotMode(state, quantumUploadId, 0, "local", "demand");
  state = setStationSlotMode(state, quantumUploadId, 0, "remote", "supply");
  for (const stationId of [quantumDownloadId, localSinkId]) {
    state = setStationSlotItem(state, stationId, 0, "copper_ore");
  }
  state = setStationSlotMode(state, quantumDownloadId, 0, "local", "supply");
  state = setStationSlotMode(state, quantumDownloadId, 0, "remote", "demand");
  state = setStationSlotMode(state, localSinkId, 0, "local", "demand");
  for (const stationId of [localSourceId, quantumUploadId, quantumDownloadId, localSinkId]) {
    state = setStationSlotMinimumLoad(state, stationId, 0, 0.1);
    const station = state.entities.find((entity) => entity.id === stationId)!;
    station.stationDrones = 10;
    station.inputs = {};
    station.outputs = {};
  }
  const source = state.entities.find((entity) => entity.id === localSourceId)!;
  source.outputs.iron_ore = 1000;
  for (const stationId of [quantumUploadId, quantumDownloadId]) {
    const station = state.entities.find((entity) => entity.id === stationId)!;
    station.stationTier = 2;
    station.quantumMode = "quantum";
    station.stationVessels = 0;
  }
  return state;
}

function quantumBeltBridgeState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push("interstellar_logistics", "quantum_logistics_network");
  state.quantumLogisticsNetwork.enabled = true;
  state.quantumLogisticsNetwork.inventory.copper_ore = "1000";
  state.construction.interstellar_logistics_station = 2;
  state.activePlanetId = "home";
  state = placeBuilding(state, "interstellar_logistics_station", { x: 820, y: 420 }, 1);
  state = placeBuilding(state, "interstellar_logistics_station", { x: 1120, y: 420 }, 1);
  const [supply, demand] = state.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station");
  state = setStationSlotItem(state, supply.id, 0, "iron_ore");
  state = setStationSlotMode(state, supply.id, 0, "remote", "supply");
  state = setStationSlotItem(state, demand.id, 0, "copper_ore");
  state = setStationSlotMode(state, demand.id, 0, "remote", "demand");
  for (const stationId of [supply.id, demand.id]) {
    const station = state.entities.find((entity) => entity.id === stationId)!;
    station.stationTier = 2;
    station.quantumMode = "quantum";
    station.stationVessels = 0;
    station.inputs = {};
    station.outputs = {};
  }
  const storageTemplate = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  state.entities.push(
    {
      ...storageTemplate,
      id: "native_quantum_belt_feed",
      position: { x: 650, y: 420 },
      storedItemId: "iron_ore",
      inputs: { iron_ore: 0 },
      outputs: { iron_ore: 500 },
    },
    {
      ...storageTemplate,
      id: "native_quantum_belt_sink",
      position: { x: 1300, y: 420 },
      storedItemId: "copper_ore",
      inputs: { copper_ore: 0 },
      outputs: { copper_ore: 0 },
    },
  );
  state = connectBeltWithResult(state, "native_quantum_belt_feed", supply.id, "iron_ore", 2).state;
  state = connectBeltWithResult(state, demand.id, "native_quantum_belt_sink", "copper_ore", 2).state;
  return state;
}

function quantumConstructionState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push(
    "basic_logistics",
    "construction_automation",
    "interstellar_logistics",
    "quantum_logistics_network",
  );
  state.quantumLogisticsNetwork.enabled = true;
  state.quantumLogisticsNetwork.inventory.iron_ingot = "100";
  state.quantumLogisticsNetwork.inventory.stone_brick = "100";
  state.construction.interstellar_logistics_station = 1;
  state = placeBuilding(state, "interstellar_logistics_station", { x: 900, y: 500 }, 1);
  const tower = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
  tower.stationTier = 2;
  tower.quantumMode = "quantum";
  tower.stationVessels = 0;
  tower.inputs = {};
  tower.outputs = {};

  state.construction.construction_center = 1;
  state = placeBuilding(state, "construction_center", { x: 1120, y: 500 }, 1);
  const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
  const definition = getConstructionDefinition("storage_mk1")!;
  state.constructionAutomation.enabled = true;
  state.constructionAutomation.quantumSourceEnabled = true;
  state.constructionAutomation.targetStock = {
    storage_mk1: (state.construction.storage_mk1 ?? 0) + definition.outputAmount,
  };
  state.constructionAutomation.jobs = {
    [center.id]: {
      constructionId: "storage_mk1",
      steps: [{ kind: "building", constructionId: "storage_mk1" }],
      stepIndex: 0,
      elapsedSeconds: 0,
      inventory: {},
    },
  };
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  wind.machineCount = 1000;
  return state;
}

function dynamicConstructionAutomationState(): GameState {
  let state = simpleMiningState();
  state.entities = state.entities.filter((entity) => entity.kind === "power");
  state.belts = [];
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as GameState["research"]["completedTechIds"];
  state.construction.construction_center = 1;
  state = placeBuilding(state, "construction_center", { x: 920, y: 320 }, 1);
  const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
  center.machineCount = 4;
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  wind.machineCount = 10_000;
  state.tray = {
    iron_ore: 20_000,
    stone: 20_000,
    steel: 100,
    processor: 100,
    electromagnetic_turbine: 100,
    super_magnetic_ring: 100,
    fire_ice: 100,
  };
  state.planetTrays.home = { ...state.tray };
  state.constructionAutomation.enabled = true;
  state.constructionAutomation.quantumSourceEnabled = false;
  state.constructionAutomation.jobs = {};
  state.constructionAutomation.targetStock = {
    storage_mk1: 3,
    conveyor_belt_mk3: 3,
    logistics_drone: 3,
  };
  state.constructionAutomation.cursor = 0;
  state.constructionAutomation.totalCrafted = 0;
  state.constructionAutomation.lastCraftedId = null;
  state.constructionAutomation.destroyedByproducts = {};
  delete state.constructionAutomation.quantumMaterialBuffer;
  return state;
}

function millionStackConstructionState(): GameState {
  const state = dynamicConstructionAutomationState();
  const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
  center.machineCount = 1_000_000;
  state.tray = { iron_ingot: 5_000_000, stone_brick: 5_000_000 };
  state.planetTrays.home = { ...state.tray };
  state.constructionAutomation.targetStock = { storage_mk1: 1_000_000 };
  state.constructionAutomation.cursor = 0;
  return state;
}

function orphanedQuantumConstructionBufferState(): GameState {
  const state = quantumConstructionState();
  const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
  state.constructionAutomation.jobs = {};
  state.constructionAutomation.targetStock = {};
  state.constructionAutomation.quantumMaterialBuffer = {
    [center.id]: { iron_ingot: 7, stone_brick: 9 },
  };
  return state;
}

function quantumAttachmentTransitionState(): GameState {
  const state = interstellarLogisticsState();
  state.research.completedTechIds.push("quantum_logistics_network");
  state.quantumLogisticsNetwork.enabled = false;
  const stations = state.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station");
  for (const station of stations) {
    station.stationTier = 2;
    station.quantumMode = "legacy";
    station.quantumTransition = null;
  }
  const supply = stations.find((station) => station.planetId === "home")!;
  supply.quantumTarget = true;
  return state;
}

function orbitalCargoConstructionState(): GameState {
  let state = simpleMiningState();
  state.orbitalStation.status = "core-building";
  state.construction.orbital_cargo_terminal = 1;
  state.construction.conveyor_belt_mk3 = 128;
  state = placeBuilding(state, "orbital_cargo_terminal", { x: 1_450, y: 420 }, 1);
  const terminal = state.entities.find((entity) => entity.buildingId === "orbital_cargo_terminal")!;
  terminal.orbitalCargoBinding = { kind: "construction" };
  terminal.orbitalCargoPortItems = ["titanium_alloy", null, "processor", null];
  terminal.orbitalCargoProgress = 0.375;
  terminal.routingCursor = 2;
  const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  state.entities.push(
    {
      ...storage,
      id: "native_orbital_titanium_feed",
      position: { x: 1_050, y: 360 },
      storedItemId: "titanium_alloy",
      inputs: { titanium_alloy: 0 },
      outputs: { titanium_alloy: 100_000 },
      routingCursor: 0,
    },
    {
      ...storage,
      id: "native_orbital_processor_feed",
      position: { x: 1_050, y: 520 },
      storedItemId: "processor",
      inputs: { processor: 0 },
      outputs: { processor: 100_000 },
      routingCursor: 0,
    },
  );
  state = connectBeltWithResult(
    state, "native_orbital_titanium_feed", terminal.id, "titanium_alloy", 3, 0, 32,
  ).state;
  state = connectBeltWithResult(
    state, "native_orbital_processor_feed", terminal.id, "processor", 3, 2, 32,
  ).state;
  state.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = 100_000;
  return state;
}

function orbitalCargoContractState(): GameState {
  let state = simpleMiningState();
  state.orbitalStation.status = "operational";
  const contract = {
    id: "native-orbital-contract",
    templateId: "multi-origin",
    slot: 0 as const,
    title: "原生合同差分",
    summary: "验证轨道终端自动交付。",
    taskDay: state.orbitalStation.contractBoard.taskDay,
    expiresAtTaskDay: state.orbitalStation.contractBoard.taskDay + 3,
    special: false,
    difficulty: "P2" as const,
    status: "accepted" as const,
    requirements: [
      {
        itemId: "titanium_alloy" as const,
        amount: "10000",
        delivered: "125",
        sourcePlanetIds: ["home" as const],
        channel: "terminal" as const,
        weight: 4,
      },
      {
        itemId: "processor" as const,
        amount: "12000",
        delivered: "0",
        channel: "any" as const,
        weight: 3,
      },
    ],
    rewards: {
      baseMarks: "120",
      baseReputation: "80",
      completionMarks: "65",
      completionReputation: "40",
    },
    acceptedAtTaskDay: state.orbitalStation.contractBoard.taskDay,
  };
  state.orbitalStation.contractBoard.accepted = [contract];
  state.orbitalStation.contractBoard.offers = [{
    ...contract,
    id: "native-orbital-offer",
    status: "offered",
    acceptedAtTaskDay: undefined,
    requirements: contract.requirements.map((requirement) => ({ ...requirement, delivered: "0" })),
  }];
  state.construction.orbital_cargo_terminal = 1;
  state.construction.conveyor_belt_mk3 = 128;
  state = placeBuilding(state, "orbital_cargo_terminal", { x: 1_450, y: 420 }, 1);
  const terminal = state.entities.find((entity) => entity.buildingId === "orbital_cargo_terminal")!;
  terminal.orbitalCargoBinding = { kind: "contract", contractId: contract.id };
  terminal.orbitalCargoPortItems = ["titanium_alloy", "processor", null, null];
  terminal.orbitalCargoProgress = 0.625;
  terminal.routingCursor = 1;
  const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  state.entities.push(
    {
      ...storage,
      id: "native_contract_titanium_feed",
      position: { x: 1_050, y: 360 },
      storedItemId: "titanium_alloy",
      inputs: { titanium_alloy: 0 },
      outputs: { titanium_alloy: 100_000 },
      routingCursor: 0,
    },
    {
      ...storage,
      id: "native_contract_processor_feed",
      position: { x: 1_050, y: 520 },
      storedItemId: "processor",
      inputs: { processor: 0 },
      outputs: { processor: 100_000 },
      routingCursor: 0,
    },
  );
  state = connectBeltWithResult(
    state, "native_contract_titanium_feed", terminal.id, "titanium_alloy", 3, 0, 32,
  ).state;
  state = connectBeltWithResult(
    state, "native_contract_processor_feed", terminal.id, "processor", 3, 1, 32,
  ).state;
  state.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = 100_000;
  return state;
}

function systemSpaceStationConstructionState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds.push("system_space_station_engineering");
  if (!state.exploration.unlockedSystemIds.includes("helios")) state.exploration.unlockedSystemIds.push("helios");
  state.construction.space_station_construction_launcher = 1;
  state = placeBuilding(state, "space_station_construction_launcher", { x: 1_500, y: 620 }, 1);
  state = startSystemSpaceStationConstruction(state, "helios");
  const launcher = state.entities.find((entity) => entity.buildingId === "space_station_construction_launcher")!;
  launcher.inputs = {
    titanium_alloy: 1_000_000,
    frame_material: 2_500_000,
    small_carrier_rocket: 100_000,
    universe_matrix: 1_100_000,
    dyson_sphere_component: 1_000_000,
    titanium_glass: 1_000_000,
    quantum_chip: 2_500_000,
    antimatter_fuel_rod: 250_000,
    annihilation_constraint_sphere: 500_000,
    strange_matter: 1_000_000,
    plane_filter: 1_000_000,
    processor: 5_000_000,
    particle_broadband: 2_000_000,
  };
  launcher.powerFactor = 0.625;
  state.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = 100_000;
  return state;
}

function systemHubElevatorState(): GameState {
  let state = simpleMiningState();
  const defaults = createInitialState(0x61a7e001);
  state.systemSpaceStations = {
    helios: JSON.parse(JSON.stringify(defaults.systemSpaceStations.helios)),
    borealis: JSON.parse(JSON.stringify(defaults.systemSpaceStations.borealis)),
  };
  state.systemSpaceStations.helios!.status = "operational";
  state.systemSpaceStations.borealis!.status = "operational";
  state.systemSpaceStations.helios!.itemPolicies.iron_ingot = {
    interstellarEnabled: true, reserve: "0", target: "0",
  };
  state.systemSpaceStations.borealis!.itemPolicies.iron_ingot = {
    interstellarEnabled: true, reserve: "0", target: "2000",
  };
  state.systemSpaceStations.helios!.inventory.iron_ingot = "1000";
  state.galacticHubNetwork = JSON.parse(JSON.stringify(defaults.galacticHubNetwork));
  state.galacticHubNetwork.warpers = "200";
  state.research.completedTechIds.push("unified_system_logistics_protocol");
  state.construction.interstellar_logistics_station = 2;
  state.activePlanetId = "home";
  state = placeBuilding(state, "interstellar_logistics_station", { x: 1_250, y: 760 }, 1);
  state.activePlanetId = "frost";
  state = placeBuilding(state, "interstellar_logistics_station", { x: 1_250, y: 760 }, 1);
  state.activePlanetId = "home";
  state.tray = state.planetTrays.home;
  const [homeElevator, frostElevator] = state.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station");
  for (const elevator of [homeElevator, frostElevator]) {
    elevator.stationTier = 2;
    elevator.stationOperationMode = "elevator";
    elevator.stationModeTransition = null;
    elevator.stationSlots = [];
    elevator.stationRoutes = [];
    elevator.elevatorOutputItems = [null, null, null, null, null];
    elevator.inputs = {};
    elevator.outputs = {};
    elevator.powerFactor = 0.8;
  }
  homeElevator.stationVessels = 20;
  frostElevator.stationVessels = 0;
  frostElevator.elevatorOutputItems = ["iron_ingot", null, null, null, null];

  const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  state.entities.push(
    {
      ...storage,
      id: "native_hub_input_feed",
      planetId: "home",
      position: { x: 1_000, y: 760 },
      storedItemId: "iron_ingot",
      inputs: { iron_ingot: 0 },
      outputs: { iron_ingot: 50_000 },
      routingCursor: 0,
    },
    {
      ...storage,
      id: "native_hub_output_sink",
      planetId: "frost",
      position: { x: 1_500, y: 760 },
      storedItemId: "iron_ingot",
      inputs: { iron_ingot: 0 },
      outputs: { iron_ingot: 0 },
      routingCursor: 0,
    },
  );
  state.construction.conveyor_belt_mk3 = 256;
  state = connectBeltWithResult(
    state, "native_hub_input_feed", homeElevator.id, "iron_ingot", 3, undefined, 32,
  ).state;
  state = connectBeltWithResult(
    state, frostElevator.id, "native_hub_output_sink", "iron_ingot", 3, undefined, 32,
  ).state;
  state.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = 100_000;
  return state;
}

describe.skipIf(!fs.existsSync(binaryPath))("native core differential oracle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-core-differential-"));
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 30_000 });
  const runtime = createContentPackRuntimeSnapshot(createContentPackRegistry());
  let saves: InstanceType<typeof NativeSaveSessionRegistry>;

  beforeAll(async () => {
    const hello = await client.start("native-core-differential");
    expect(hello.capabilities).toContain("native-core-shadow-v1");
    saves = new NativeSaveSessionRegistry(client);
  });

  afterAll(async () => {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function seed(state: GameState, revision = 1): Promise<{ generation: number; rootHash: string; revision: number }> {
    const journal = buildChunkedSaveJournal(state, {
      mode: state.mode,
      basePrimaryChecksum: "01234567",
      savedAt: 1,
      retainAllChunks: true,
    });
    const prefix = `dsp-idle-network.internal.v1.chunked.v1.${state.mode}.`;
    const records = [
      ...[...journal.chunks.entries()].map(([id, value]) => ({ key: `${prefix}chunk.${encodeURIComponent(id)}`, value })),
      { key: `${prefix}manifest`, value: JSON.stringify(journal.manifest) },
    ];
    const transaction = await saves.begin(1, {
      slot: "normal-main", mode: state.mode, stateVersion: 47, baseChecksum: "01234567",
      registryFingerprint: runtime.fingerprint, revision, savedAtMs: 1,
    });
    for (let index = 0; index < records.length; index += 8) {
      await saves.write(1, transaction.transactionId, records.slice(index, index + 8));
    }
    return saves.commit(1, transaction.transactionId);
  }

  async function open(checkpoint: { generation: number; rootHash: string; revision: number }): Promise<any> {
    return client.request({
      operation: "coreOpen", slot: "normal-main", generation: checkpoint.generation,
      rootHash: checkpoint.rootHash, revision: checkpoint.revision, registryFingerprint: runtime.fingerprint,
      catalog: createNativeCoreCatalog(runtime),
    });
  }

  it("matches the JS authority at quiescent 1s/60s/600s/8h/30d boundaries", async () => {
    const initial = quiescentState();
    const checkpoint = await seed(initial);
    for (const seconds of [1, 60, 600, 8 * 60 * 60, 30 * 24 * 60 * 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `${seconds} 秒 native support`).toBe(true);
      expect(advanced.summary.canonicalFields, `${seconds} 秒顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${seconds} 秒完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const sequences = [
      { label: "60x1s", steps: Array.from({ length: 60 }, () => 1) },
      { label: "10x60s", steps: Array.from({ length: 10 }, () => 60) },
      { label: "8x1h", steps: Array.from({ length: 8 }, () => 60 * 60) },
      { label: "30x1d", steps: Array.from({ length: 30 }, () => 24 * 60 * 60) },
    ];
    for (const sequence of sequences) {
      const opened = await open(checkpoint);
      let expected = initial;
      let revision = checkpoint.revision;
      let advanced: any = null;
      for (const seconds of sequence.steps) {
        expected = advanceSimulationBudget(expected, seconds, seconds);
        advanced = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(advanced.supported, `${sequence.label} native support`).toBe(true);
        revision += 1;
      }
      expect(advanced.summary.canonicalFields, `${sequence.label} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${sequence.label} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 30_000);

  it("matches infinite mining, ordinary production, and renewable allocation at an exact boundary", async () => {
    const initial = simpleMiningState();
    const checkpoint = await seed(initial, 100);
    for (const seconds of [1, 10, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
  });

      expect(advanced.supported, `${seconds} 秒 native support: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection",
        sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: [],
      });
      expect(projection.entities, `${seconds} 秒实体投影`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.belts, `${seconds} 秒线路投影`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(advanced.summary.canonicalFields, `${seconds} 秒顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${seconds} 秒完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    for (const sequence of [
      { label: "simple-factory-60x1s", steps: Array.from({ length: 60 }, () => 1) },
      { label: "simple-factory-10x60s", steps: Array.from({ length: 10 }, () => 60) },
    ]) {
      const opened = await open(checkpoint);
      let expected = initial;
      let revision = checkpoint.revision;
      let advanced: any = null;
      for (const seconds of sequence.steps) {
        expected = advanceSimulationBudget(expected, seconds, seconds);
        advanced = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(advanced.supported, `${sequence.label} native support: ${advanced.reason ?? ""}`).toBe(true);
        revision += 1;
      }
      expect(advanced.summary.canonicalFields, `${sequence.label} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${sequence.label} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 120_000);

  it("matches an installed but disabled time-warp controller without clearing its selection", async () => {
    const initial = inactiveTimeWarpControllerState();
    const checkpoint = await seed(initial, 101);
    for (const seconds of [1, 10, 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `inactive-time-warp-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), beltIds: [],
        baseFields: ["productionHistory", "timeWarp"],
      });
      expect(projection.entities, `inactive-time-warp-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.productionHistory, `inactive-time-warp-${seconds} 生产历史`).toEqual(JSON.parse(JSON.stringify(expected.productionHistory)));
      expect(projection.base.timeWarp, `inactive-time-warp-${seconds} 状态`).toEqual(JSON.parse(JSON.stringify(expected.timeWarp)));
      expect(advanced.summary.canonicalFields, `inactive-time-warp-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `inactive-time-warp-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  });

  it("matches Dyson absorption, decay, throttled launch, ray power, and critical photons", async () => {
    const initial = dysonOperationsState();
    const checkpoint = await seed(initial, 125);
    for (const seconds of [1, 5, 10, 60, 120]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `dyson-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: [
          "dysonSwarm", "dysonSphere", "dysonEngineering", "dysonPlans",
          "totalProduced", "productionHistory", "metrics", "planetMetrics", "powerGridMetrics",
        ],
      });
      expect(projection.entities, `dyson-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.dysonSwarm, `dyson-${seconds} 戴森云`).toEqual(JSON.parse(JSON.stringify(expected.dysonSwarm)));
      expect(projection.base.dysonSphere, `dyson-${seconds} 戴森球`).toEqual(JSON.parse(JSON.stringify(expected.dysonSphere)));
      expect(projection.base.dysonEngineering, `dyson-${seconds} 工程`).toEqual(JSON.parse(JSON.stringify(expected.dysonEngineering)));
      expect(projection.base.dysonPlans, `dyson-${seconds} 计划`).toEqual(JSON.parse(JSON.stringify(expected.dysonPlans)));
      expect(advanced.summary.canonicalFields, `dyson-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `dyson-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }

    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `dyson-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "dyson-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "dyson-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches finite reserve depletion and the exhausted boundary", async () => {
    const initial = finiteMiningState();
    const checkpoint = await seed(initial, 150);
    for (const seconds of [1, 10, 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `finite-${seconds} native support: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id), baseFields: [],
      });
      expect(projection.entities, `finite-${seconds} 实体投影`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.belts, `finite-${seconds} 线路投影`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(advanced.summary.canonicalFields, `finite-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `finite-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 30_000);

  it("matches finite research completion, queue activation, rewards, and sprayed labs", async () => {
    const initial = finiteResearchState();
    const checkpoint = await seed(initial, 175);
    for (const seconds of [1, 3, 10, 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `research-${seconds} native support: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id), baseFields: ["research", "construction"],
      });
      expect(projection.entities, `research-${seconds} 实体投影`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.belts, `research-${seconds} 线路投影`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(projection.base.research, `research-${seconds} 科研状态`).toEqual(JSON.parse(JSON.stringify(expected.research)));
      expect(projection.base.construction, `research-${seconds} 科研奖励`).toEqual(JSON.parse(JSON.stringify(expected.construction)));
      expect(advanced.summary.canonicalFields, `research-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `research-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 60_000);

  it("matches BigInt infinite research levels, automatic continuation, and lab reset order", async () => {
    const initial = infiniteResearchState();
    const checkpoint = await seed(initial, 185);
    for (const seconds of [1, 3, 10, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `infinite-research-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["endgame", "research"],
      });
      expect(projection.entities, `infinite-research-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.endgame, `infinite-research-${seconds} 无限科研`).toEqual(JSON.parse(JSON.stringify(expected.endgame)));
      expect(advanced.summary.canonicalFields, `infinite-research-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `infinite-research-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `infinite-research-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalSha256, "infinite-research-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 60_000);

  it("matches fuel dispatch, generation priorities, accumulators, and energy exchangers", async () => {
    const initial = dispatchablePowerState();
    const checkpoint = await seed(initial, 190);
    for (const seconds of [1, 10, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `power-${seconds} native support: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["metrics", "planetMetrics", "powerGridMetrics", "totalProduced"],
      });
      expect(projection.entities, `power-${seconds} 实体投影`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.metrics, `power-${seconds} 活跃星球指标`).toEqual(JSON.parse(JSON.stringify(expected.metrics)));
      expect(projection.base.planetMetrics, `power-${seconds} 星球指标`).toEqual(JSON.parse(JSON.stringify(expected.planetMetrics)));
      expect(projection.base.powerGridMetrics, `power-${seconds} 电网指标`).toEqual(JSON.parse(JSON.stringify(expected.powerGridMetrics)));
      expect(projection.base.totalProduced, `power-${seconds} 储能单元产量`).toEqual(JSON.parse(JSON.stringify(expected.totalProduced)));
      expect(advanced.summary.canonicalFields, `power-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `power-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    for (const sequence of [
      { label: "power-60x1s", steps: Array.from({ length: 60 }, () => 1) },
      { label: "power-10x60s", steps: Array.from({ length: 10 }, () => 60) },
    ]) {
      const opened = await open(checkpoint);
      let expected = initial;
      let revision = checkpoint.revision;
      let advanced: any = null;
      for (const seconds of sequence.steps) {
        expected = advanceSimulationBudget(expected, seconds, seconds);
        advanced = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(advanced.supported, `${sequence.label} native support: ${advanced.reason ?? ""}`).toBe(true);
        revision += 1;
      }
      expect(advanced.summary.canonicalFields, `${sequence.label} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${sequence.label} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 60_000);

  it("matches exact multi-slot planetary logistics, both drone fleets, and station belts", async () => {
    const initial = localLogisticsState();
    const checkpoint = await seed(initial, 195);
    for (const seconds of [1, 8, 10, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `local-logistics-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["nextId", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `local-logistics-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.belts, `local-logistics-${seconds} 线路`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(projection.base.nextId, `local-logistics-${seconds} 路线 ID`).toBe(expected.nextId);
      expect(advanced.summary.canonicalFields, `local-logistics-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `local-logistics-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `local-logistics-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "local-logistics-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "local-logistics-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches exact same-system interstellar vessels across planets", async () => {
    const initial = interstellarLogisticsState();
    const checkpoint = await seed(initial, 197);
    for (const seconds of [1, 10, 30, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `interstellar-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["nextId", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `interstellar-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.nextId, `interstellar-${seconds} 路线 ID`).toBe(expected.nextId);
      expect(advanced.summary.canonicalFields, `interstellar-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `interstellar-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `interstellar-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "interstellar-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "interstellar-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches exact direct warp routes, warper consumption, and cross-system power", async () => {
    const initial = warpedInterstellarLogisticsState();
    const checkpoint = await seed(initial, 198);
    for (const seconds of [1, 8, 10, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `warped-interstellar-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["nextId", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `warped-interstellar-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.nextId, `warped-interstellar-${seconds} 路线 ID`).toBe(expected.nextId);
      expect(advanced.summary.canonicalFields, `warped-interstellar-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `warped-interstellar-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `warped-interstellar-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "warped-interstellar-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "warped-interstellar-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches exact station warper auto-refill ordering before and after dispatch", async () => {
    const initial = stationWarperAutoRefillState();
    const checkpoint = await seed(initial, 199);
    for (const seconds of [1, 8, 10, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `warper-refill-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["nextId", "planetTrays", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `warper-refill-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.planetTrays, `warper-refill-${seconds} 行星托盘`).toEqual(JSON.parse(JSON.stringify(expected.planetTrays)));
      expect(projection.base.nextId, `warper-refill-${seconds} 路线 ID`).toBe(expected.nextId);
      expect(advanced.summary.canonicalFields, `warper-refill-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `warper-refill-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `warper-refill-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "warper-refill-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "warper-refill-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches exact relay-required paths, per-hop warpers, and hub power", async () => {
    const initial = relayInterstellarLogisticsState();
    const checkpoint = await seed(initial, 200);
    for (const seconds of [1, 10, 30, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `relay-interstellar-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["nextId", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `relay-interstellar-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.nextId, `relay-interstellar-${seconds} 路线 ID`).toBe(expected.nextId);
      expect(advanced.summary.canonicalFields, `relay-interstellar-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `relay-interstellar-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `relay-interstellar-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "relay-interstellar-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "relay-interstellar-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches orbital collection and demand-owned vessel pickup", async () => {
    const initial = orbitalCollectorLogisticsState();
    const checkpoint = await seed(initial, 201);
    for (const seconds of [1, 10, 30, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `orbital-collector-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["nextId", "totalProduced", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `orbital-collector-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.totalProduced, `orbital-collector-${seconds} 产量`).toEqual(JSON.parse(JSON.stringify(expected.totalProduced)));
      expect(advanced.summary.canonicalFields, `orbital-collector-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `orbital-collector-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `orbital-collector-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "orbital-collector-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "orbital-collector-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches exact five-second quantum uploads, downloads, BigInt inventory, and collectors", async () => {
    const initial = quantumLogisticsState();
    const checkpoint = await seed(initial, 202);
    for (const seconds of [1, 4, 5, 10, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `quantum-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["quantumLogisticsNetwork", "totalProduced", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `quantum-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.quantumLogisticsNetwork, `quantum-${seconds} 网络`).toEqual(JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)));
      expect(projection.base.planetMetrics, `quantum-${seconds} 行星指标`).toEqual(JSON.parse(JSON.stringify(expected.planetMetrics)));
      expect(advanced.summary.canonicalFields, `quantum-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `quantum-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `quantum-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "quantum-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "quantum-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches exact local drone collection into and delivery out of quantum inventory", async () => {
    const initial = quantumLocalDroneBridgeState();
    const checkpoint = await seed(initial, 203);
    for (const seconds of [1, 5, 10, 30, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `quantum-local-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["nextId", "quantumLogisticsNetwork", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `quantum-local-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.quantumLogisticsNetwork, `quantum-local-${seconds} 网络`).toEqual(JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)));
      expect(advanced.summary.canonicalFields, `quantum-local-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `quantum-local-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `quantum-local-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "quantum-local-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "quantum-local-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches exact belt ingress and reserved same-step egress for quantum towers", async () => {
    const initial = quantumBeltBridgeState();
    const checkpoint = await seed(initial, 204);
    for (const seconds of [1, 5, 10, 30, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `quantum-belt-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["quantumLogisticsNetwork", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `quantum-belt-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.belts, `quantum-belt-${seconds} 线路`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(projection.base.quantumLogisticsNetwork, `quantum-belt-${seconds} 网络`).toEqual(JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)));
      expect(advanced.summary.canonicalFields, `quantum-belt-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `quantum-belt-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `quantum-belt-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "quantum-belt-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "quantum-belt-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches persisted construction work and direct quantum material prefetch", async () => {
    const initial = quantumConstructionState();
    const checkpoint = await seed(initial, 205);
    for (const seconds of [1, 5, 6, 9, 10, 15, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `quantum-construction-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: [
          "constructionAutomation", "construction", "quantumLogisticsNetwork",
          "totalProduced", "productionHistory", "metrics", "planetMetrics", "powerGridMetrics",
        ],
      });
      expect(projection.entities, `quantum-construction-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.constructionAutomation, `quantum-construction-${seconds} 自动制造`).toEqual(JSON.parse(JSON.stringify(expected.constructionAutomation)));
      expect(projection.base.construction, `quantum-construction-${seconds} 建筑库存`).toEqual(JSON.parse(JSON.stringify(expected.construction)));
      expect(projection.base.quantumLogisticsNetwork, `quantum-construction-${seconds} 网络`).toEqual(JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)));
      expect(projection.base.productionHistory, `quantum-construction-${seconds} 生产历史`).toEqual(JSON.parse(JSON.stringify(expected.productionHistory)));
      expect(advanced.summary.canonicalFields, `quantum-construction-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `quantum-construction-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `quantum-construction-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "quantum-construction-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "quantum-construction-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches recursive construction planning, byproduct settlement, and portable-fleet targets", async () => {
    const initial = dynamicConstructionAutomationState();
    const checkpoint = await seed(initial, 206);
    for (const seconds of [1, 5, 10, 30, 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `dynamic-construction-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: [
          "constructionAutomation", "construction", "portableFleet", "tray", "planetTrays",
          "totalProduced", "productionHistory", "metrics", "planetMetrics", "powerGridMetrics",
        ],
      });
      expect(projection.entities, `dynamic-construction-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.constructionAutomation, `dynamic-construction-${seconds} 自动制造`).toEqual(JSON.parse(JSON.stringify(expected.constructionAutomation)));
      expect(projection.base.construction, `dynamic-construction-${seconds} 建筑库存`).toEqual(JSON.parse(JSON.stringify(expected.construction)));
      expect(projection.base.portableFleet, `dynamic-construction-${seconds} 便携舰队`).toEqual(JSON.parse(JSON.stringify(expected.portableFleet)));
      expect(projection.base.tray, `dynamic-construction-${seconds} 托盘`).toEqual(JSON.parse(JSON.stringify(expected.tray)));
      expect(advanced.summary.canonicalFields, `dynamic-construction-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `dynamic-construction-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("matches million-stack construction work with bounded arithmetic batching", async () => {
    const initial = millionStackConstructionState();
    const checkpoint = await seed(initial, 207);
    for (const seconds of [1, 5, 10]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `million-construction-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: [],
        baseFields: ["constructionAutomation", "construction", "tray", "planetTrays", "totalProduced"],
      });
      expect(projection.entities, `million-construction-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.constructionAutomation, `million-construction-${seconds} 自动制造`).toEqual(JSON.parse(JSON.stringify(expected.constructionAutomation)));
      expect(projection.base.construction, `million-construction-${seconds} 建筑库存`).toEqual(JSON.parse(JSON.stringify(expected.construction)));
      expect(projection.base.tray, `million-construction-${seconds} 托盘`).toEqual(JSON.parse(JSON.stringify(expected.tray)));
      expect(advanced.summary.canonicalFields, `million-construction-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `million-construction-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("returns orphaned direct-construction reservations without losing material", async () => {
    const initial = orphanedQuantumConstructionBufferState();
    const checkpoint = await seed(initial, 208);
    const opened = await open(checkpoint);
    const expected = advanceSimulationBudget(initial, 1, 1);
    const advanced = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    expect(advanced.supported, advanced.reason ?? "orphaned quantum construction buffer").toBe(true);
    const projection = await client.request({
      operation: "coreProjection", sessionId: opened.sessionId,
      entityIds: expected.entities.map((entity) => entity.id), beltIds: [],
      baseFields: ["constructionAutomation", "quantumLogisticsNetwork", "tray", "planetTrays"],
    });
    expect(projection.base.constructionAutomation).toEqual(JSON.parse(JSON.stringify(expected.constructionAutomation)));
    expect(projection.base.quantumLogisticsNetwork).toEqual(JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)));
    expect(advanced.summary.canonicalFields).toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256).toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  });

  it("matches a planned quantum attachment while legacy vessel tails drain", async () => {
    const initial = quantumAttachmentTransitionState();
    const checkpoint = await seed(initial, 209);
    for (const seconds of [1, 4, 5, 6, 10, 20, 30, 35, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `quantum-transition-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: [
          "quantumLogisticsNetwork", "productionHistory", "metrics",
          "planetMetrics", "powerGridMetrics", "nextId",
        ],
      });
      expect(projection.entities, `quantum-transition-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.quantumLogisticsNetwork, `quantum-transition-${seconds} 网络`).toEqual(JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)));
      expect(advanced.summary.canonicalFields, `quantum-transition-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `quantum-transition-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    const opened = await open(checkpoint);
    let expected = initial;
    let revision = checkpoint.revision;
    let advanced: any = null;
    for (let index = 0; index < 60; index += 1) {
      expected = advanceSimulationBudget(expected, 1, 1);
      advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `quantum-transition-60x1-${index}: ${advanced.reason ?? ""}`).toBe(true);
      revision += 1;
    }
    expect(advanced.summary.canonicalFields, "quantum-transition-60x1 顶层字段").toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "quantum-transition-60x1 完整哈希").toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("matches orbital cargo ports, fair upload budgets, and station construction delivery", async () => {
    const initial = orbitalCargoConstructionState();
    const checkpoint = await seed(initial, 210);
    for (const seconds of [1, 5, 10, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `orbital-cargo-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["orbitalStation", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `orbital-cargo-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.belts, `orbital-cargo-${seconds} 线路`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(projection.base.orbitalStation, `orbital-cargo-${seconds} 空间站`).toEqual(JSON.parse(JSON.stringify(expected.orbitalStation)));
      expect(advanced.summary.canonicalFields, `orbital-cargo-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `orbital-cargo-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("matches orbital cargo contract restrictions, totals, and claimable transition", async () => {
    const initial = orbitalCargoContractState();
    const checkpoint = await seed(initial, 211);
    for (const seconds of [1, 5, 10, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `orbital-contract-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["orbitalStation", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `orbital-contract-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.orbitalStation, `orbital-contract-${seconds} 空间站`).toEqual(JSON.parse(JSON.stringify(expected.orbitalStation)));
      expect(advanced.summary.canonicalFields, `orbital-contract-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `orbital-contract-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("matches powered construction-launcher settlement across system-station phases", async () => {
    const initial = systemSpaceStationConstructionState();
    const checkpoint = await seed(initial, 212);
    for (const seconds of [1, 5, 10, 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `system-construction-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["systemSpaceStations", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `system-construction-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.base.systemSpaceStations, `system-construction-${seconds} 空间站`).toEqual(JSON.parse(JSON.stringify(expected.systemSpaceStations)));
      expect(advanced.summary.canonicalFields, `system-construction-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `system-construction-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("matches elevator belts, local hub settlement, cross-system fleet dispatch, and returns", async () => {
    const initial = systemHubElevatorState();
    const checkpoint = await seed(initial, 213);
    for (const seconds of [1, 5, 10, 30, 60, 600]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `system-hub-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["systemSpaceStations", "galacticHubNetwork", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `system-hub-${seconds} 实体`).toEqual(JSON.parse(JSON.stringify(expected.entities)));
      expect(projection.belts, `system-hub-${seconds} 线路`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(projection.base.systemSpaceStations, `system-hub-${seconds} 空间站`).toEqual(JSON.parse(JSON.stringify(expected.systemSpaceStations)));
      expect(projection.base.galacticHubNetwork, `system-hub-${seconds} 舰队`).toEqual(JSON.parse(JSON.stringify(expected.galacticHubNetwork)));
      expect(advanced.summary.canonicalFields, `system-hub-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `system-hub-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it.skipIf(process.env.DSP_RUN_NATIVE_CORE_LONG_DIFFERENTIAL !== "1")(
    "matches long mining boundaries and segmented offline settlement",
    async () => {
      const initial = simpleMiningState();
      const checkpoint = await seed(initial, 300);
      for (const seconds of [60, 600, 8 * 60 * 60, 30 * 24 * 60 * 60]) {
        const opened = await open(checkpoint);
        const expected = advanceSimulationBudget(initial, seconds, seconds);
        const advanced = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(advanced.supported, `long-${seconds} native support: ${advanced.reason ?? ""}`).toBe(true);
        expect(advanced.summary.canonicalFields, `long-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
        expect(advanced.summary.canonicalSha256, `long-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
        await client.request({ operation: "coreClose", sessionId: opened.sessionId });
      }
      for (const sequence of [
        { label: "mining-8x1h", steps: Array.from({ length: 8 }, () => 60 * 60) },
        { label: "mining-30x1d", steps: Array.from({ length: 30 }, () => 24 * 60 * 60) },
      ]) {
        const opened = await open(checkpoint);
        let expected = initial;
        let revision = checkpoint.revision;
        let advanced: any = null;
        for (const seconds of sequence.steps) {
          expected = advanceSimulationBudget(expected, seconds, seconds);
          advanced = await client.request({
            operation: "coreAdvance", sessionId: opened.sessionId,
            request: { baseRevision: revision, simulationSeconds: seconds, wallSeconds: seconds },
          });
          expect(advanced.supported, `${sequence.label} native support: ${advanced.reason ?? ""}`).toBe(true);
          revision += 1;
        }
        expect(advanced.summary.canonicalFields, `${sequence.label} 顶层字段`).toEqual(canonicalFields(expected));
        expect(advanced.summary.canonicalSha256, `${sequence.label} 完整哈希`).toBe(canonicalSha256(expected));
        await client.request({ operation: "coreClose", sessionId: opened.sessionId });
      }
    },
    240_000,
  );
});
