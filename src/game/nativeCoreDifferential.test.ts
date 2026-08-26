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
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
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

  it("matches exact relay-required paths, per-hop warpers, and hub power", async () => {
    const initial = relayInterstellarLogisticsState();
    const checkpoint = await seed(initial, 199);
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

  it.skipIf(process.env.DSP_RUN_NATIVE_CORE_LONG_DIFFERENTIAL !== "1")(
    "matches long mining boundaries and segmented offline settlement",
    async () => {
      const initial = simpleMiningState();
      const checkpoint = await seed(initial, 200);
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
