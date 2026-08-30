import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildChunkedSaveJournal } from "./chunkedSaveJournal";
import {
  applyContentPackRuntimeSnapshot,
  createContentPackRegistry,
  createContentPackRuntimeSnapshot,
  registerContentPack,
  type ContentPackRuntimeSnapshot,
} from "./contentPacks";
import {
  advanceSimulationBudget,
  advanceSimulationSession,
  attachInterstellarStationToQuantumNetwork,
  completeSimulationAdvanceSession,
  connectBeltWithResult,
  createInitialState,
  createSimulationLookupContext,
  createSimulationAdvanceSession,
  createSimulationProfiler,
  getEntityItemInputCapacity,
  placeBuilding,
  setStationSlotItem,
  setStationSlotMinimumLoad,
  setStationSlotMode,
  setStationSlotPriority,
} from "./engine";
import { CAMPAIGN_TASKS } from "./campaign";
import { getConstructionDefinition, TECHNOLOGIES } from "./content";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import { nativeCoreDomainSha256 } from "./nativeCoreProof";
import { createSpeedrunState } from "./speedrun";
import {
  requestStationOperationMode,
  startSystemSpaceStationConstruction,
} from "./systemSpaceStation";
import { validateContentPack } from "./mods";
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

const binaryPath = process.env.DSP_NATIVE_CORE_HOST_BINARY
  ? path.resolve(process.env.DSP_NATIVE_CORE_HOST_BINARY)
  : path.resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");

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

function rendererProjectedEntities(entities: GameState["entities"]): Array<Record<string, unknown>> {
  const projected = JSON.parse(JSON.stringify(entities)) as Array<Record<string, unknown>>;
  for (const entity of projected) delete entity.stationRoutes;
  return projected;
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

function dormantBeltWakeState(): GameState {
  const state = simpleMiningState();
  const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
  const template = state.belts.find((belt) => belt.source === smelter.id && belt.itemId === "iron_ingot")!;
  const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  const dormantSource = {
    ...structuredClone(storage),
    id: "native_dormant_source",
    position: { x: 760, y: 360 },
    inputs: { iron_ingot: 0 },
    outputs: { iron_ingot: 0 },
    storedItemId: "iron_ingot" as const,
  };
  state.entities.push(dormantSource);
  // Keep more than the active-queue threshold behind a storage source that
  // cannot create cargo by itself. Existing smelter/vein groups begin empty but
  // can produce in this exact step and therefore must remain awake; treating
  // those as dormant would delay the first output boundary.
  for (let index = 0; index < 80; index += 1) {
    state.belts.push({
      ...template,
      id: `native_dormant_wake_${String(index).padStart(3, "0")}`,
      source: dormantSource.id,
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    });
  }
  return state;
}

function dormantOrdinaryProducerWakeState(): GameState {
  const state = simpleMiningState();
  const ironVein = state.entities.find((entity) => entity.id === "vein_iron")!;
  const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
  const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  const template = state.belts.find((belt) =>
    belt.source === smelter.id && belt.itemId === "iron_ingot")!;
  // The native exact step transfers belts before it runs this step's mining
  // cycle. Seed real upstream cargo so the original smelter is woken during
  // the positive-seconds transfer phase, not only during the zero-second
  // post-production phase.
  ironVein.outputs.iron_ore = 12;
  // The original smelter starts without ore and receives it through its active
  // mining route during the first belt phase. Its output route therefore
  // exercises same-step reverse wake plus clock catch-up. The cloned machines
  // have no input route or complete input cycle and prove that ordinary recipe
  // outputs no longer keep a large idle cohort permanently awake.
  for (let index = 0; index < 96; index += 1) {
    const producer = structuredClone(smelter);
    producer.id = `native_dormant_producer_${String(index).padStart(3, "0")}`;
    producer.position = { x: 900 + index * 4, y: 420 };
    producer.inputs = { iron_ore: 0 };
    producer.outputs = { iron_ingot: 0 };
    producer.progress = 0;
    producer.utilization = 0;
    producer.productionRate = 0;
    state.entities.push(producer);
    state.belts.push({
      ...template,
      id: `native_dormant_producer_output_${String(index).padStart(3, "0")}`,
      source: producer.id,
      target: storage.id,
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    });
  }
  return state;
}

function logisticsStationSourceWakeState(
  dormantRouteCount: number,
  activeRouteCount = 1,
  initiallyStocked = false,
): GameState {
  const state = quantumBeltBridgeState();
  const demand = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station" &&
    entity.stationSlots?.some((slot) => slot.itemId === "copper_ore" && slot.remoteMode === "demand"))!;
  const sink = state.entities.find((entity) => entity.id === "native_quantum_belt_sink")!;
  demand.machineCount = 1;
  demand.stationOperationMode = "legacy";
  demand.stationModeTransition = null;
  demand.quantumMode = "quantum";
  demand.quantumTransition = null;
  demand.stationRoutes = [];
  for (const [slotIndex, slot] of (demand.stationSlots ?? []).entries()) {
    slot.itemId = slotIndex === 0 ? "copper_ore" : undefined;
    slot.localMode = "storage";
    slot.remoteMode = slotIndex === 0 ? "demand" : "storage";
    slot.minimumLoad = 1;
    slot.minStock = 0;
    slot.priority = 1;
    slot.routePolicy = "relay-preferred";
  }
  // quantumBeltBridgeState intentionally goes through the inventory-checked
  // player build API and may have no spare Mk.II belt in this synthetic save.
  // The differential fixture needs a persisted route, so derive every static
  // field from an already valid built-in route and replace only its endpoints
  // and cargo. This is equivalent to loading an existing valid save; it does
  // not exercise or bypass the player placement command.
  let route = state.belts.find((belt) =>
    belt.source === demand.id && belt.target === sink.id && belt.itemId === "copper_ore");
  if (!route) {
    route = {
      ...structuredClone(state.belts[0]),
      id: "native_quantum_belt_download",
      planetId: demand.planetId,
      source: demand.id,
      target: sink.id,
      itemId: "copper_ore",
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    };
    state.belts.push(route);
  }

  // The real built-in quantum demand station owns only the routes that can be
  // woken by its five-second inventory writer. A second shape-valid legacy
  // station owns the idle cohort, so a quantum write never turns the dormant
  // evidence group into artificial work.
  demand.inputs.copper_ore = 0;
  demand.outputs.copper_ore = initiallyStocked ? activeRouteCount * 100 : 0;
  if (!initiallyStocked) state.quantumLogisticsNetwork.inventory.copper_ore = "1";
  const dormantStation = structuredClone(demand);
  dormantStation.id = "native_dormant_quantum_station";
  dormantStation.position = { x: 1_400, y: 520 };
  dormantStation.stationMode = "supply";
  dormantStation.stationOperationMode = "legacy";
  dormantStation.stationModeTransition = null;
  dormantStation.quantumMode = "legacy";
  dormantStation.quantumTransition = null;
  dormantStation.storedItemId = "copper_ore";
  dormantStation.stationVessels = 0;
  dormantStation.stationDrones = 0;
  dormantStation.stationRoutes = [];
  dormantStation.inputs = { copper_ore: 0 };
  dormantStation.outputs = { copper_ore: 0 };
  for (const slot of dormantStation.stationSlots ?? []) {
    slot.localMode = "storage";
    slot.remoteMode = "storage";
  }
  state.entities.push(dormantStation);

  for (let index = 1; index < activeRouteCount; index += 1) {
    state.belts.push({
      ...structuredClone(route),
      id: `native_active_quantum_output_${String(index).padStart(3, "0")}`,
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    });
  }
  for (let index = 0; index < dormantRouteCount; index += 1) {
    state.belts.push({
      ...structuredClone(route),
      id: `native_dormant_quantum_output_${String(index).padStart(3, "0")}`,
      source: dormantStation.id,
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    });
  }
  return state;
}

function dormantQuantumStationSourceState(): GameState {
  return logisticsStationSourceWakeState(96);
}

function denseQuantumStationSourceState(): GameState {
  // 250 genuinely stocked routes exceed 75% of the whole fixture, while the
  // second station's 70 empty routes still exceed the 64-route queue threshold.
  // Rust must therefore enable the queue and deterministically choose Dense.
  return logisticsStationSourceWakeState(70, 250, true);
}

/**
 * A five-second quantum download and an ordinary recipe output both need the
 * same two remaining target slots. The ordinary producer starts with more
 * completed work than its own 120-item output buffer can hold, so it can only
 * publish the final two ingots when the reservation phase grants its belt
 * direct-through output credit. The source-empty quantum demand route sorts
 * before that producer route and remains positive-step eligible, so both must
 * participate in one reservation ledger before the boundary writer runs.
 */
function sharedQuantumProducerTargetState(): GameState {
  const state = quantumBeltBridgeState();
  const demand = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station" &&
    entity.stationSlots?.some((slot) => slot.remoteMode === "demand"))!;
  const producer = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
  const storageTemplate = state.entities.find((entity) => entity.id === "native_quantum_belt_sink")!;
  const sink = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
  const power = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  const quantumRouteTemplate = state.belts.find((belt) => belt.source === demand.id) ?? state.belts[0];

  state.elapsedSeconds = 4;
  state.quantumLogisticsNetwork.enabled = true;
  state.quantumLogisticsNetwork.inventory = { iron_ingot: "1" };
  state.quantumLogisticsNetwork.runtimeFlow = undefined;
  state.settings.beltBufferLimit = 1;
  demand.machineCount = 1;
  demand.stationOperationMode = "legacy";
  demand.stationModeTransition = null;
  demand.quantumMode = "quantum";
  demand.quantumTransition = null;
  demand.stationRoutes = [];
  demand.storedItemId = "iron_ingot";
  demand.stationMode = "demand";
  demand.inputs = { iron_ingot: 0 };
  demand.outputs = { iron_ingot: 0 };
  for (const [index, slot] of (demand.stationSlots ?? []).entries()) {
    slot.itemId = index === 0 ? "iron_ingot" : undefined;
    slot.localMode = "storage";
    slot.remoteMode = index === 0 ? "demand" : "storage";
    slot.minimumLoad = 1;
    slot.minStock = 0;
    slot.priority = 1;
    slot.routePolicy = "relay-preferred";
  }

  producer.machineCount = 1;
  producer.recipeId = "iron_ingot";
  producer.inputs = { iron_ore: 122 };
  producer.outputs = { iron_ingot: 0 };
  producer.progress = 121;
  producer.sprayCoaterInstalled = false;
  producer.proliferatorTier = undefined;
  producer.proliferatorMode = undefined;
  producer.proliferatorPoints = 0;
  producer.proliferatorBonusProgress = {};

  sink.id = "native_shared_target_blocked_sink";
  sink.recipeId = "gear";
  sink.machineCount = 1;
  sink.inputs = { iron_ingot: 118 };
  sink.outputs = { gear: 120 };
  sink.progress = 0;

  const dormantStation = structuredClone(demand);
  dormantStation.id = "native_shared_target_dormant_station";
  dormantStation.position = { x: 1_420, y: 620 };
  dormantStation.quantumMode = "legacy";
  dormantStation.quantumTransition = null;
  dormantStation.storedItemId = "copper_ore";
  dormantStation.stationMode = "supply";
  dormantStation.stationOperationMode = "legacy";
  dormantStation.stationModeTransition = null;
  dormantStation.inputs = { copper_ore: 0 };
  dormantStation.outputs = { copper_ore: 0 };
  dormantStation.stationRoutes = [];
  for (const [index, slot] of (dormantStation.stationSlots ?? []).entries()) {
    slot.itemId = index === 0 ? "copper_ore" : undefined;
    slot.localMode = "storage";
    slot.remoteMode = "storage";
    slot.minStock = 0;
  }
  const dormantSink = structuredClone(storageTemplate);
  dormantSink.id = "native_shared_target_dormant_sink";
  dormantSink.position = { x: 1_620, y: 620 };
  dormantSink.storedItemId = "copper_ore";
  dormantSink.inputs = { copper_ore: 0 };
  dormantSink.outputs = { copper_ore: 0 };

  power.machineCount = 1_000;
  power.inputs = {};
  power.outputs = {};
  state.entities = [power, producer, demand, sink, dormantStation, dormantSink];
  state.totalProduced.iron_ingot = 0;
  state.belts = [
    {
      ...structuredClone(quantumRouteTemplate),
      id: "native_shared_target_Z_quantum",
      planetId: demand.planetId,
      source: demand.id,
      target: sink.id,
      itemId: "iron_ingot",
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    },
    {
      ...structuredClone(quantumRouteTemplate),
      id: "native_shared_target_00_producer",
      planetId: producer.planetId,
      source: producer.id,
      target: sink.id,
      itemId: "iron_ingot",
      progress: 1,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    },
    {
      ...structuredClone(quantumRouteTemplate),
      id: "native_shared_target_a_quantum_second",
      planetId: demand.planetId,
      source: demand.id,
      target: sink.id,
      itemId: "iron_ingot",
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    },
    ...Array.from({ length: 96 }, (_, index) => ({
      ...structuredClone(quantumRouteTemplate),
      id: `native_shared_target_legacy_${String(index).padStart(3, "0")}`,
      planetId: dormantStation.planetId,
      source: dormantStation.id,
      target: dormantSink.id,
      itemId: "copper_ore" as const,
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    })),
  ];
  return state;
}

/**
 * Two independently capacious targets compete for one real item from the same
 * legacy station source. Persisted row order and locale collation put `a`
 * first, while Rust `str::cmp` and the authority contract put ASCII `Z` first.
 * The unrelated dormant station cohort only enables the sparse queue; it has
 * no material or runtime signal that can participate in the race.
 */
function utf8SameSourceFairnessState(): GameState {
  const state = sharedQuantumProducerTargetState();
  const source = state.entities.find((entity) => entity.quantumMode === "quantum")!;
  const sinkTemplate = state.entities.find((entity) => entity.id === "native_shared_target_blocked_sink")!;
  const power = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  const dormantStation = state.entities.find((entity) => entity.id === "native_shared_target_dormant_station")!;
  const dormantSink = state.entities.find((entity) => entity.id === "native_shared_target_dormant_sink")!;
  const routeTemplate = state.belts[0];

  state.elapsedSeconds = 0;
  state.quantumLogisticsNetwork.enabled = false;
  state.quantumLogisticsNetwork.inventory = {};
  state.quantumLogisticsNetwork.runtimeFlow = undefined;
  state.settings.beltBufferLimit = 1;
  source.stationOperationMode = "legacy";
  source.stationModeTransition = null;
  source.quantumMode = "legacy";
  source.quantumTransition = null;
  source.stationMode = "supply";
  source.storedItemId = "iron_ingot";
  source.inputs = { iron_ingot: 0 };
  source.outputs = { iron_ingot: 1 };
  source.routingCursor = 0;
  source.stationRoutes = [];
  for (const [index, slot] of (source.stationSlots ?? []).entries()) {
    slot.itemId = index === 0 ? "iron_ingot" : undefined;
    slot.localMode = index === 0 ? "supply" : "storage";
    slot.remoteMode = "storage";
    slot.minimumLoad = 1;
    slot.minStock = 0;
    slot.priority = 1;
    slot.routePolicy = "relay-preferred";
  }

  const sinkA = structuredClone(sinkTemplate);
  sinkA.id = "native_utf8_sink_a";
  sinkA.position = { x: 1_020, y: 180 };
  sinkA.inputs = { iron_ingot: 0 };
  sinkA.outputs = { gear: 120 };
  sinkA.progress = 0;
  const sinkZ = structuredClone(sinkA);
  sinkZ.id = "native_utf8_sink_Z";
  sinkZ.position = { x: 1_020, y: 360 };

  state.entities = [power, source, sinkA, sinkZ, dormantStation, dormantSink];
  state.belts = [
    {
      ...structuredClone(routeTemplate),
      id: "native_utf8_a_route",
      planetId: source.planetId,
      source: source.id,
      target: sinkA.id,
      itemId: "iron_ingot",
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    },
    {
      ...structuredClone(routeTemplate),
      id: "native_utf8_Z_route",
      planetId: source.planetId,
      source: source.id,
      target: sinkZ.id,
      itemId: "iron_ingot",
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    },
    ...state.belts.slice(3).map((belt) => structuredClone(belt)),
  ];
  return state;
}

/**
 * Ninety-six independent legacy station source groups share no source state.
 * The only inventory writer is a real producer belt into station 000: the
 * assembler needs two one-second revisions to complete its first gear. This
 * lets the first revision absorb cold directory initialization, while the
 * second revision proves reverse lookup work scales with the one changed
 * station rather than the full station cohort.
 */
function legacyStationReverseDirectoryState(stationCount = 96): GameState {
  const state = quantumBeltBridgeState();
  const stationTemplate = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station")!;
  const producer = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
  const sink = state.entities.find((entity) => entity.id === "native_quantum_belt_sink")!;
  const power = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  const routeTemplate = state.belts[0];

  state.quantumLogisticsNetwork.enabled = false;
  state.quantumLogisticsNetwork.inventory = {};
  state.quantumLogisticsNetwork.runtimeFlow = undefined;
  producer.machineCount = 1;
  producer.recipeId = "gear";
  producer.inputs = { iron_ingot: 10 };
  producer.outputs = { gear: 0 };
  producer.progress = 0;
  producer.sprayCoaterInstalled = false;
  producer.proliferatorTier = undefined;
  producer.proliferatorMode = undefined;
  producer.proliferatorPoints = 0;
  producer.proliferatorBonusProgress = {};
  sink.storedItemId = "gear";
  sink.inputs = { gear: 0 };
  sink.outputs = { gear: 0 };
  power.machineCount = 1_000;
  power.inputs = {};
  power.outputs = {};

  const stations = Array.from({ length: stationCount }, (_, index) => {
    const station = structuredClone(stationTemplate);
    station.id = `native_reverse_station_${String(index).padStart(3, "0")}`;
    station.position = { x: 1_000 + (index % 16) * 80, y: 500 + Math.floor(index / 16) * 80 };
    station.machineCount = 1;
    station.stationMode = "supply";
    station.stationOperationMode = "legacy";
    station.stationModeTransition = null;
    station.quantumMode = "legacy";
    station.quantumTransition = null;
    station.storedItemId = "gear";
    station.stationDrones = 0;
    station.stationVessels = 0;
    station.stationRoutes = [];
    station.inputs = { gear: 0 };
    station.outputs = { gear: 0 };
    for (const [slotIndex, slot] of (station.stationSlots ?? []).entries()) {
      slot.itemId = slotIndex === 0 ? "gear" : undefined;
      slot.localMode = "storage";
      slot.remoteMode = "storage";
      slot.minimumLoad = 1;
      slot.minStock = 0;
      slot.priority = 1;
      slot.routePolicy = "relay-preferred";
    }
    return station;
  });
  state.entities = [power, producer, ...stations, sink];
  state.totalProduced.gear = 0;
  state.belts = [
    {
      ...structuredClone(routeTemplate),
      id: "native_reverse_writer",
      planetId: producer.planetId,
      source: producer.id,
      target: stations[0].id,
      itemId: "gear",
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    },
    ...stations.map((station, index) => ({
      ...structuredClone(routeTemplate),
      id: `native_reverse_station_output_${String(index).padStart(3, "0")}`,
      planetId: station.planetId,
      source: station.id,
      target: sink.id,
      itemId: "gear" as const,
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    })),
  ];
  return state;
}

/**
 * One legacy station owns independent copper and iron source groups. Its
 * copper input is the only real inventory write in the step. The empty iron
 * route sorts before an ordinary iron producer and shares the producer's
 * two-slot target, so waking every item group for the station would let the
 * empty iron group steal output credit from real production.
 */
function selectiveLegacyStationItemWakeState(): GameState {
  const state = quantumBeltBridgeState();
  const station = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station")!;
  const producer = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
  const sharedSink = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
  const storageTemplate = state.entities.find((entity) => entity.id === "native_quantum_belt_sink")!;
  const power = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  const routeTemplate = state.belts[0];

  state.quantumLogisticsNetwork.enabled = false;
  state.quantumLogisticsNetwork.inventory = {};
  state.quantumLogisticsNetwork.runtimeFlow = undefined;
  station.id = "native_selective_item_station";
  station.machineCount = 1;
  station.stationMode = "supply";
  station.stationOperationMode = "legacy";
  station.stationModeTransition = null;
  station.quantumMode = "legacy";
  station.quantumTransition = null;
  station.storedItemId = "copper_ore";
  station.stationDrones = 0;
  station.stationVessels = 0;
  station.stationRoutes = [];
  station.inputs = { copper_ore: 1, iron_ingot: 0 };
  station.outputs = { copper_ore: 0, iron_ingot: 0 };
  for (const [slotIndex, slot] of (station.stationSlots ?? []).entries()) {
    slot.itemId = slotIndex === 0 ? "copper_ore" : slotIndex === 1 ? "iron_ingot" : undefined;
    slot.localMode = "storage";
    slot.remoteMode = "storage";
    slot.minimumLoad = 1;
    slot.minStock = 0;
    slot.priority = 1;
    slot.routePolicy = "relay-preferred";
  }

  producer.machineCount = 1;
  producer.recipeId = "iron_ingot";
  producer.inputs = { iron_ore: 122 };
  producer.outputs = { iron_ingot: 0 };
  producer.progress = 121;
  producer.sprayCoaterInstalled = false;
  producer.proliferatorTier = undefined;
  producer.proliferatorMode = undefined;
  producer.proliferatorPoints = 0;
  producer.proliferatorBonusProgress = {};

  sharedSink.id = "native_selective_item_shared_sink";
  sharedSink.recipeId = "gear";
  sharedSink.machineCount = 1;
  sharedSink.inputs = { iron_ingot: 118 };
  sharedSink.outputs = { gear: 120 };
  sharedSink.progress = 0;

  const copperSink = structuredClone(storageTemplate);
  copperSink.id = "native_selective_item_copper_sink";
  copperSink.position = { x: 1_360, y: 520 };
  copperSink.storedItemId = "copper_ore";
  copperSink.inputs = { copper_ore: 0 };
  copperSink.outputs = { copper_ore: 0 };
  const dormantSource = structuredClone(storageTemplate);
  dormantSource.id = "native_selective_item_dormant_source";
  dormantSource.position = { x: 1_520, y: 680 };
  dormantSource.storedItemId = "stone";
  dormantSource.inputs = { stone: 0 };
  dormantSource.outputs = { stone: 0 };
  const dormantSink = structuredClone(storageTemplate);
  dormantSink.id = "native_selective_item_dormant_sink";
  dormantSink.position = { x: 1_760, y: 680 };
  dormantSink.storedItemId = "stone";
  dormantSink.inputs = { stone: 0 };
  dormantSink.outputs = { stone: 0 };

  power.machineCount = 1_000;
  power.inputs = {};
  power.outputs = {};
  state.entities = [power, producer, station, sharedSink, copperSink, dormantSource, dormantSink];
  state.totalProduced.iron_ingot = 0;
  state.belts = [
    {
      ...structuredClone(routeTemplate),
      id: "native_selective_item_00_copper",
      planetId: station.planetId,
      source: station.id,
      target: copperSink.id,
      itemId: "copper_ore",
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    },
    {
      ...structuredClone(routeTemplate),
      id: "native_selective_item_01_empty_iron",
      planetId: station.planetId,
      source: station.id,
      target: sharedSink.id,
      itemId: "iron_ingot",
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    },
    {
      ...structuredClone(routeTemplate),
      id: "native_selective_item_02_producer",
      planetId: producer.planetId,
      source: producer.id,
      target: sharedSink.id,
      itemId: "iron_ingot",
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    },
    ...Array.from({ length: 96 }, (_, index) => ({
      ...structuredClone(routeTemplate),
      id: `native_selective_item_dormant_${String(index).padStart(3, "0")}`,
      planetId: dormantSource.planetId,
      source: dormantSource.id,
      target: dormantSink.id,
      itemId: "stone" as const,
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    })),
  ];
  return state;
}

function forcedFullLogisticsAdvance(state: GameState, seconds: number): GameState {
  const session = createSimulationAdvanceSession(state, seconds, {
    wallSeconds: seconds,
    indexedLogistics: false,
  });
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  return completeSimulationAdvanceSession(session);
}

function exactInventoryAmount(value: unknown): bigint {
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return 0n;
}

/** Closed copper ledger for the quantum-station belt fixtures. */
function quantumStationCopperInventory(state: GameState): bigint {
  let total = exactInventoryAmount(state.quantumLogisticsNetwork.inventory.copper_ore) +
    exactInventoryAmount(state.tray.copper_ore);
  for (const tray of Object.values(state.planetTrays)) {
    total += exactInventoryAmount(tray.copper_ore);
  }
  if (state.cargo?.itemId === "copper_ore") total += exactInventoryAmount(state.cargo.amount);
  for (const entity of state.entities) {
    total += exactInventoryAmount(entity.inputs.copper_ore);
    total += exactInventoryAmount(entity.outputs.copper_ore);
    for (const route of entity.stationRoutes ?? []) {
      if (route.itemId === "copper_ore") total += exactInventoryAmount(route.cargo);
    }
  }
  for (const job of Object.values(state.constructionAutomation.jobs)) {
    total += exactInventoryAmount(job.inventory.copper_ore);
  }
  for (const inventory of Object.values(state.constructionAutomation.quantumMaterialBuffer ?? {})) {
    total += exactInventoryAmount(inventory.copper_ore);
  }
  return total;
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

function partialCampaignResearchState(): GameState {
  const state = finiteResearchState();
  state.campaign = {
    activeChapterId: "foundation",
    activeTaskId: "mine_first_ore",
    completedTaskIds: [],
    rewardedTaskIds: [],
  };
  state.productionHistory = [];
  state.historyRecordedAt = 0;
  return state;
}

function queuedGlobalProgressState(): GameState {
  const state = simpleMiningState();
  state.tray.iron_ingot = 20;
  state.planetTrays[state.activePlanetId] = { ...state.tray };
  state.handcraftQueue = [{
    id: "native_handcraft_gear",
    recipeId: "gear",
    planetId: state.activePlanetId,
    batchesTotal: 4,
    batchesRemaining: 4,
    progress: 0,
    queuedAt: state.elapsedSeconds,
  }];
  state.exploration.unlockedSystemIds = state.exploration.unlockedSystemIds.filter((id) => id !== "borealis");
  state.exploration.colonizedPlanetIds = state.exploration.colonizedPlanetIds.filter((id) => id !== "frost");
  state.exploration.missions = [{ systemId: "borealis", elapsedSeconds: 1.25, durationSeconds: 3 }];
  state.exploration.surveyProgressBySystem.borealis = 0.4167;
  return state;
}

function legacyGalacticExportState(): GameState {
  const state = simpleMiningState();
  if (!state.research.completedTechIds.includes("universe_matrix")) state.research.completedTechIds.push("universe_matrix");
  state.endgame.exportInputMode = "legacy-network";
  state.endgame.autoDispatch = true;
  state.endgame.dispatchThrottle = 0.5;
  state.endgame.infiniteResearch.galactic_logistics.level = 2;
  state.endgame.exportProjects.universe_archive = {
    ...state.endgame.exportProjects.universe_archive,
    enabled: true,
    priority: 3,
    dispatchProgress: 0.4,
  };
  state.endgame.exportProjects.solar_sail_array = {
    ...state.endgame.exportProjects.solar_sail_array,
    enabled: true,
    priority: 2,
    dispatchProgress: 0.8,
  };
  state.endgame.exportProjects.carrier_rocket_fleet = {
    ...state.endgame.exportProjects.carrier_rocket_fleet,
    enabled: true,
    priority: 1,
    dispatchProgress: 0.2,
  };
  state.tray.universe_matrix = 4_000;
  state.planetTrays[state.activePlanetId] = { ...state.tray };
  state.planetTrays.ashen.small_carrier_rocket = 500;
  const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
  storage.outputs.solar_sail = 2_000;
  return state;
}

function physicalGalacticExportState(): GameState {
  let state = simpleMiningState();
  if (!state.research.completedTechIds.includes("universe_matrix")) state.research.completedTechIds.push("universe_matrix");
  state.construction.galactic_material_exporter = 1;
  state = placeBuilding(state, "galactic_material_exporter", { x: 900, y: -240 }, 1);
  const exporter = state.entities.find((entity) => entity.buildingId === "galactic_material_exporter")!;
  exporter.galacticExporterPaused = false;
  exporter.inputs = {
    universe_matrix: 7,
    solar_sail: 11,
    small_carrier_rocket: 5,
    antimatter_fuel_rod: 3,
  };
  state.endgame.exportInputMode = "building";
  state.endgame.exportProjects.universe_archive.priority = 3;
  state.endgame.exportProjects.antimatter_exchange.priority = 2;
  state.endgame.constructionActivity.activityId = "native_activity";
  state.endgame.constructionActivity.participantId = "native_player";
  state.endgame.constructionActivity.startsAtMs = 1_000;
  state.endgame.constructionActivity.endsAtMs = 3_500;
  state.endgame.constructionActivity.activityClockMs = 500;
  return state;
}

function speedrunFactoryState(): GameState {
  const state = simpleMiningState();
  state.mode = "speedrun";
  state.speedrun = createSpeedrunState(state, 1_700_000_000_000, "native_speedrun_factory_01");
  state.dysonSphere.totalRocketsLaunched = state.speedrun.baseline.rocketsLaunched + 10_000;
  state.totalProduced.universe_matrix = state.speedrun.baseline.whiteMatrixProduced + 1_000_000;
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

function noJobQuantumConstructionState(): GameState {
  const state = quantumConstructionState();
  const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
  const tower = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  state.elapsedSeconds = 4;
  state.tray = {};
  state.planetTrays.home = {};
  center.machineCount = 1;
  tower.machineCount = 100;
  wind.machineCount = 10_000;
  state.constructionAutomation.jobs = {};
  state.constructionAutomation.targetStock = {
    arc_smelter: (state.construction.arc_smelter ?? 0) + 1,
  };
  delete state.constructionAutomation.quantumMaterialBuffer;
  state.quantumLogisticsNetwork.inventory = {
    copper_ore: "1000000000",
    iron_ore: "1000000000",
    stone: "1000000000",
  };
  delete state.quantumLogisticsNetwork.runtimeFlow;
  return state;
}

function existingJobQuantumPrefetchState(): GameState {
  const state = quantumConstructionState();
  const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
  const tower = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  state.elapsedSeconds = 4;
  state.tray = {};
  state.planetTrays.home = {};
  center.machineCount = 100;
  tower.machineCount = 100;
  wind.machineCount = 10_000;
  state.constructionAutomation.targetStock = {
    storage_mk1: (state.construction.storage_mk1 ?? 0) + 100,
  };
  delete state.constructionAutomation.quantumMaterialBuffer;
  state.quantumLogisticsNetwork.inventory = {
    iron_ingot: "1000000000",
    stone_brick: "1000000000",
  };
  delete state.quantumLogisticsNetwork.runtimeFlow;
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

function guardedDirectCacheConstructionState(): GameState {
  const state = dynamicConstructionAutomationState();
  const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  center.machineCount = 999_999;
  wind.machineCount = 100_000_000;
  state.tray = {};
  state.planetTrays.home = {};
  state.constructionAutomation.quantumSourceEnabled = true;
  state.constructionAutomation.targetStock = {
    arc_smelter: (state.construction.arc_smelter ?? 0) + 1_000_000_000,
    storage_mk1: (state.construction.storage_mk1 ?? 0) + 1_000_000_000,
  };
  state.constructionAutomation.quantumMaterialBuffer = {
    [center.id]: {
      copper_ore: 1_000_000_000,
      iron_ore: 1_000_000_000,
      stone: 1_000_000_000,
    },
  };
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

function activeTimeWarpState(): GameState {
  let state = simpleMiningState();
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as GameState["research"]["completedTechIds"];
  state.construction.time_warp_device = 1;
  state = placeBuilding(state, "time_warp_device", { x: 1_340, y: -120 }, 1);
  const controller = state.entities.find((entity) => entity.buildingId === "time_warp_device")!;
  const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  wind.machineCount = 1_000_000;
  state.timeWarp.controllerEntityId = controller.id;
  state.timeWarp.enabled = true;
  state.timeWarp.requestedMultiplier = 5;
  state.timeWarp.effectiveMultiplier = 1;
  state.timeWarp.pendingSimulationSeconds = 123;
  state.timeWarp.pendingWallSeconds = 17;
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

/**
 * One empty Mk.II ILS crosses the supported legacy -> quantum five-second
 * attachment boundary while a second, unrelated legacy ILS owns a large
 * dormant belt cohort. The transition source has no cargo or runtime belt
 * signal: after attachment its single route can only stay selected because a
 * quantum station retains the historical positive-step always-awake rule.
 * The unrelated station never changes classification.
 */
function quantumAttachmentBeltActivityTransitionState(): GameState {
  let state = quantumBeltBridgeState();
  const transitionStation = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station" &&
    entity.stationSlots?.some((slot) => slot.itemId === "copper_ore" && slot.remoteMode === "demand"))!;
  const stationTemplate = state.entities.find((entity) =>
    entity.buildingId === "interstellar_logistics_station" && entity.id !== transitionStation.id)!;
  const sinkTemplate = state.entities.find((entity) => entity.id === "native_quantum_belt_sink")!;
  const power = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
  const routeTemplate = state.belts[0];

  state.elapsedSeconds = 0;
  state.quantumLogisticsNetwork.enabled = false;
  state.quantumLogisticsNetwork.inventory = {};
  state.quantumLogisticsNetwork.runtimeFlow = undefined;

  transitionStation.id = "native_quantum_transition_station";
  transitionStation.machineCount = 1;
  transitionStation.stationTier = 2;
  transitionStation.stationMode = "demand";
  transitionStation.stationOperationMode = "legacy";
  transitionStation.stationModeTransition = null;
  transitionStation.quantumMode = "legacy";
  transitionStation.quantumTransition = null;
  transitionStation.quantumTarget = undefined;
  transitionStation.storedItemId = "copper_ore";
  transitionStation.stationDrones = 0;
  transitionStation.stationVessels = 0;
  transitionStation.stationRoutes = [];
  transitionStation.inputs = { copper_ore: 0 };
  transitionStation.outputs = { copper_ore: 0 };
  for (const [slotIndex, slot] of (transitionStation.stationSlots ?? []).entries()) {
    slot.itemId = slotIndex === 0 ? "copper_ore" : undefined;
    slot.localMode = "storage";
    slot.remoteMode = slotIndex === 0 ? "demand" : "storage";
    slot.minimumLoad = 1;
    slot.minStock = 0;
    slot.priority = 1;
    slot.routePolicy = "relay-preferred";
  }

  const dormantStation = structuredClone(stationTemplate);
  dormantStation.id = "native_unrelated_legacy_station";
  dormantStation.position = { x: 1_480, y: 620 };
  dormantStation.machineCount = 1;
  dormantStation.stationTier = 2;
  dormantStation.stationMode = "supply";
  dormantStation.stationOperationMode = "legacy";
  dormantStation.stationModeTransition = null;
  dormantStation.quantumMode = "legacy";
  dormantStation.quantumTransition = null;
  dormantStation.quantumTarget = undefined;
  dormantStation.storedItemId = "stone";
  dormantStation.stationDrones = 0;
  dormantStation.stationVessels = 0;
  dormantStation.stationRoutes = [];
  dormantStation.inputs = { stone: 0 };
  dormantStation.outputs = { stone: 0 };
  for (const [slotIndex, slot] of (dormantStation.stationSlots ?? []).entries()) {
    slot.itemId = slotIndex === 0 ? "stone" : undefined;
    slot.localMode = "storage";
    slot.remoteMode = "storage";
    slot.minimumLoad = 1;
    slot.minStock = 0;
    slot.priority = 1;
    slot.routePolicy = "relay-preferred";
  }

  const transitionSink = structuredClone(sinkTemplate);
  transitionSink.id = "native_quantum_transition_sink";
  transitionSink.position = { x: 1_240, y: 620 };
  transitionSink.storedItemId = "copper_ore";
  transitionSink.inputs = { copper_ore: 0 };
  transitionSink.outputs = { copper_ore: 0 };
  const dormantSink = structuredClone(sinkTemplate);
  dormantSink.id = "native_unrelated_legacy_sink";
  dormantSink.position = { x: 1_720, y: 620 };
  dormantSink.storedItemId = "stone";
  dormantSink.inputs = { stone: 0 };
  dormantSink.outputs = { stone: 0 };

  power.machineCount = 1_000;
  power.inputs = {};
  power.outputs = {};
  state.entities = [power, transitionStation, transitionSink, dormantStation, dormantSink];
  state.belts = [
    {
      ...structuredClone(routeTemplate),
      id: "native_quantum_transition_output",
      planetId: transitionStation.planetId,
      source: transitionStation.id,
      target: transitionSink.id,
      itemId: "copper_ore",
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    },
    ...Array.from({ length: 96 }, (_, index) => ({
      ...structuredClone(routeTemplate),
      id: `native_unrelated_legacy_output_${String(index).padStart(3, "0")}`,
      planetId: dormantStation.planetId,
      source: dormantStation.id,
      target: dormantSink.id,
      itemId: "stone" as const,
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    })),
  ];
  // Use the same public gameplay transition constructor as the UI action.
  // Exact simulation consumes the persisted transition; `quantumTarget` is a
  // separate macro-planning marker and is intentionally not used here.
  state = attachInterstellarStationToQuantumNetwork(state, transitionStation.id);
  return state;
}

/**
 * The public station-mode action reverses an empty ILS from elevator routing
 * to ordinary legacy routing at the next five-second hub boundary. It reuses
 * the same one-route plus 96-route dormant topology as the quantum fixture so
 * the following revision must carry no active source group.
 */
function elevatorToLegacyBeltActivityTransitionState(): GameState {
  let state = quantumAttachmentBeltActivityTransitionState();
  const station = state.entities.find((entity) =>
    entity.id === "native_quantum_transition_station")!;
  const sourceBelt = state.belts.find((belt) =>
    belt.id === "native_quantum_transition_output")!;
  station.id = "native_elevator_transition_station";
  station.stationOperationMode = "elevator";
  station.stationModeTransition = null;
  station.quantumMode = "legacy";
  station.quantumTransition = null;
  station.quantumTarget = undefined;
  station.elevatorOutputItems = ["copper_ore", null, null, null, null];
  sourceBelt.id = "native_elevator_transition_output";
  sourceBelt.source = station.id;
  sourceBelt.elevatorOutputIndex = 0;
  state.quantumLogisticsNetwork.enabled = false;
  state.quantumLogisticsNetwork.inventory = {};
  state.quantumLogisticsNetwork.runtimeFlow = undefined;
  state = requestStationOperationMode(state, station.id, "legacy");
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

function orbitalCargoContractRefreshState(expireAccepted: boolean): GameState {
  const state = orbitalCargoContractState();
  const board = state.orbitalStation.contractBoard;
  board.offers = [];
  if (expireAccepted) {
    const currentTaskDay = board.taskDay;
    board.taskDay = Math.max(0, currentTaskDay - 3);
    board.accepted[0].taskDay = board.taskDay;
    board.accepted[0].expiresAtTaskDay = currentTaskDay;
  }
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
  const client = new NativeHostClient({
    binaryPath,
    rootPath: root,
    requestTimeoutMs: process.env.DSP_RUN_NATIVE_CORE_LONG_DIFFERENTIAL === "1" ? 180_000 : 30_000,
  });
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

  async function seed(
    state: GameState,
    revision = 1,
    activeRuntime: ContentPackRuntimeSnapshot = runtime,
  ): Promise<{ slot: string; generation: number; rootHash: string; revision: number }> {
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
    const slot = state.mode === "speedrun" ? "speedrun-main" : "normal-main";
    const transaction = await saves.begin(1, {
      slot, mode: state.mode, stateVersion: 47, baseChecksum: "01234567",
      registryFingerprint: activeRuntime.fingerprint, revision, savedAtMs: 1,
    });
    for (let index = 0; index < records.length; index += 8) {
      await saves.write(1, transaction.transactionId, records.slice(index, index + 8));
    }
    return { slot, ...await saves.commit(1, transaction.transactionId) };
  }

  async function open(
    checkpoint: { slot: string; generation: number; rootHash: string; revision: number },
    activeRuntime: ContentPackRuntimeSnapshot = runtime,
  ): Promise<any> {
    return client.request({
      operation: "coreOpen", slot: checkpoint.slot, generation: checkpoint.generation,
      rootHash: checkpoint.rootHash, revision: checkpoint.revision, registryFingerprint: activeRuntime.fingerprint,
      catalog: createNativeCoreCatalog(activeRuntime),
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
      expect(advanced.summary.domainSha256, `${seconds} 秒领域哈希`).toBe(
        nativeCoreDomainSha256(expected, checkpoint.revision + 1),
      );
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

  it("durably commits and idempotently retries one exact shadow operation", async () => {
    const initial = simpleMiningState();
    const checkpoint = await seed(initial, 90);
    const opened = await open(checkpoint);
    const request = {
      commandId: "native-differential-shadow-90",
      baseRevision: checkpoint.revision,
      command: null,
      simulationSeconds: 1,
      wallSeconds: 1,
      includeDiagnostics: true,
    };
    const committed = await client.request({
      operation: "coreCommitOperation", sessionId: opened.sessionId, request,
    });
    const expected = advanceSimulationBudget(initial, 1, 1);
    expect(committed).toMatchObject({
      commandId: request.commandId,
      baseRevision: 90,
      revision: 91,
      currentRevision: 91,
      duplicate: false,
    });
    expect(committed.summary.canonicalSha256).toBe(canonicalSha256(expected));
    expect(committed.summary.domainSha256).toBe(nativeCoreDomainSha256(expected, 91));
    const retried = await client.request({
      operation: "coreCommitOperation", sessionId: opened.sessionId, request,
    });
    expect(retried).toMatchObject({ revision: 91, currentRevision: 91, duplicate: true });
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  });

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
      expect(projection.entities, `${seconds} 秒实体投影`).toEqual(rendererProjectedEntities(expected.entities));
      expect(projection.belts, `${seconds} 秒线路投影`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(advanced.summary.canonicalFields, `${seconds} 秒顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${seconds} 秒完整哈希`).toBe(canonicalSha256(expected));
      expect(advanced.summary.domainSha256, `${seconds} 秒领域哈希`).toBe(
        nativeCoreDomainSha256(expected, checkpoint.revision + 1),
      );
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
      expect(projection.entities, `inactive-time-warp-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `dyson-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `finite-${seconds} 实体投影`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `research-${seconds} 实体投影`).toEqual(rendererProjectedEntities(expected.entities));
      expect(projection.belts, `research-${seconds} 线路投影`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(projection.base.research, `research-${seconds} 科研状态`).toEqual(JSON.parse(JSON.stringify(expected.research)));
      expect(projection.base.construction, `research-${seconds} 科研奖励`).toEqual(JSON.parse(JSON.stringify(expected.construction)));
      expect(advanced.summary.canonicalFields, `research-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `research-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 60_000);

  it("matches partial campaign completion, rewards, and research-lab blocked diagnostics", async () => {
    const initial = partialCampaignResearchState();
    const checkpoint = await seed(initial, 180);
    for (const seconds of [1, 5, 10]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      expect(expected.campaign.completedTaskIds.length).toBeGreaterThan(0);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `partial-campaign-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["campaign", "construction", "tray", "productionHistory"],
      });
      expect(projection.base.campaign, `partial-campaign-${seconds} 任务状态`).toEqual(JSON.parse(JSON.stringify(expected.campaign)));
      expect(projection.base.construction, `partial-campaign-${seconds} 建筑奖励`).toEqual(JSON.parse(JSON.stringify(expected.construction)));
      expect(projection.base.tray, `partial-campaign-${seconds} 物品奖励`).toEqual(JSON.parse(JSON.stringify(expected.tray)));
      expect(projection.base.productionHistory, `partial-campaign-${seconds} 阻塞统计`).toEqual(JSON.parse(JSON.stringify(expected.productionHistory)));
      expect(advanced.summary.canonicalFields, `partial-campaign-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `partial-campaign-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 60_000);

  it("matches queued handcraft and exploration completion at partial and complete boundaries", async () => {
    const initial = queuedGlobalProgressState();
    const checkpoint = await seed(initial, 182);
    for (const seconds of [0.5, 1, 2, 5, 10]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `global-progress-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["handcraftQueue", "exploration", "tray", "planetTrays", "portableFleet", "totalProduced"],
      });
      for (const field of ["handcraftQueue", "exploration", "tray", "planetTrays", "portableFleet", "totalProduced"] as const) {
        expect(projection.base[field], `global-progress-${seconds} ${field}`).toEqual(JSON.parse(JSON.stringify(expected[field])));
      }
      expect(advanced.summary.canonicalFields, `global-progress-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `global-progress-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 60_000);

  it("matches legacy network exports, reserves, project levels, and inventory withdrawal order", async () => {
    const initial = legacyGalacticExportState();
    const checkpoint = await seed(initial, 183);
    for (const seconds of [1, 5, 10, 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `legacy-export-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["endgame", "tray", "planetTrays", "campaign", "productionHistory"],
      });
      expect(projection.entities, `legacy-export-${seconds} 实体库存`).toEqual(rendererProjectedEntities(expected.entities));
      for (const field of ["endgame", "tray", "planetTrays", "campaign", "productionHistory"] as const) {
        expect(projection.base[field], `legacy-export-${seconds} ${field}`).toEqual(JSON.parse(JSON.stringify(expected[field])));
      }
      expect(advanced.summary.canonicalFields, `legacy-export-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `legacy-export-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 60_000);

  it("matches powered exporter activity windows and pending delivery batches", async () => {
    const initial = physicalGalacticExportState();
    const checkpoint = await seed(initial, 184);
    for (const seconds of [0.25, 0.5, 1, 3, 5]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `physical-export-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["endgame", "campaign", "productionHistory", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `physical-export-${seconds} 出口建筑`).toEqual(rendererProjectedEntities(expected.entities));
      for (const field of ["endgame", "campaign", "productionHistory", "planetMetrics", "powerGridMetrics"] as const) {
        expect(projection.base[field], `physical-export-${seconds} ${field}`).toEqual(JSON.parse(JSON.stringify(expected[field])));
      }
      expect(advanced.summary.canonicalFields, `physical-export-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `physical-export-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 60_000);

  it("matches speedrun wall-clock advancement and milestone timestamps", async () => {
    const initial = speedrunFactoryState();
    const checkpoint = await seed(initial, 186);
    for (const budget of [
      { simulationSeconds: 1, wallSeconds: 0.25 },
      { simulationSeconds: 5, wallSeconds: 2.5 },
      { simulationSeconds: 0, wallSeconds: 3 },
      { simulationSeconds: 5, wallSeconds: 0 },
    ]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, budget.simulationSeconds, budget.wallSeconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, ...budget },
      });
      const label = `${budget.simulationSeconds}s-${budget.wallSeconds}w`;
      expect(advanced.supported, `speedrun-${label}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["speedrun", "campaign", "productionHistory", "orbitalStation"],
      });
      expect(projection.entities, `speedrun-${label} 实体`).toEqual(rendererProjectedEntities(expected.entities));
      for (const field of ["speedrun", "campaign", "productionHistory", "orbitalStation"] as const) {
        expect(projection.base[field], `speedrun-${label} ${field}`).toEqual(JSON.parse(JSON.stringify(expected[field])));
      }
      expect(advanced.summary.canonicalFields, `speedrun-${label} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `speedrun-${label} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 60_000);

  it("matches enabled content-pack machines, recipes, items, and custom belt tiers", async () => {
    const validation = validateContentPack({
      formatVersion: 2,
      id: "native_core_content_pack",
      name: "Native Core Content Pack",
      version: "1.0.0",
      items: [{ id: "native_core_alloy", name: "原生合金", kind: "solid" }],
      buildings: [{
        id: "native_core_fabricator",
        name: "原生合金制造机",
        kind: "machine",
        speed: 2,
        inputCapacity: 20_000,
        outputCapacity: 20_000,
        powerDemandKw: 720,
        costs: [{ itemId: "iron_ingot", amount: 2 }],
      }],
      recipes: [{
        id: "native_core_alloy_recipe",
        name: "原生合金",
        buildingId: "native_core_fabricator",
        duration: 2,
        inputs: [{ itemId: "iron_ingot", amount: 2 }],
        outputs: [{ itemId: "native_core_alloy", amount: 3 }],
      }],
      belts: [{
        id: "native_core_belt_mk4",
        name: "原生传送带 Mk.4",
        tier: 4,
        speed: 60,
        costs: [{ itemId: "iron_ingot", amount: 1 }],
        outputAmount: 5,
      }],
    });
    expect(validation.valid).toBe(true);
    const customRuntime = createContentPackRuntimeSnapshot(
      registerContentPack(createContentPackRegistry(), validation).registry,
    );
    applyContentPackRuntimeSnapshot(customRuntime);
    try {
      let initial = simpleMiningState();
      const construction = initial.construction as Record<string, number>;
      construction.native_core_fabricator = 1;
      construction.native_core_belt_mk4 = 64;
      initial = placeBuilding(initial, "native_core_fabricator" as never, { x: 900, y: 120 }, 1);
      const fabricator = initial.entities.find((entity) =>
        (entity.buildingId as string | undefined) === "native_core_fabricator")!;
      fabricator.recipeId = "native_core_alloy_recipe" as never;
      fabricator.inputs = { iron_ingot: 0 };
      fabricator.outputs = { native_core_alloy: 0 } as never;
      const storage = initial.entities.find((entity) => entity.buildingId === "storage_mk1")!;
      storage.outputs.iron_ingot = 1_000;
      initial = connectBeltWithResult(
        initial,
        storage.id,
        fabricator.id,
        "iron_ingot",
        4 as never,
        undefined,
        8,
      ).state;
      const checkpoint = await seed(initial, 187, customRuntime);
      for (const seconds of [1, 5, 20]) {
        applyContentPackRuntimeSnapshot(customRuntime);
        const expected = advanceSimulationBudget(initial, seconds, seconds);
        const opened = await open(checkpoint, customRuntime);
        const advanced = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(advanced.supported, `content-pack-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
        const projection = await client.request({
          operation: "coreProjection", sessionId: opened.sessionId,
          entityIds: expected.entities.map((entity) => entity.id), beltIds: expected.belts.map((belt) => belt.id),
          baseFields: ["totalProduced", "planetMetrics", "powerGridMetrics"],
        });
        expect(projection.entities, `content-pack-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
        expect(projection.belts, `content-pack-${seconds} 线路`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
        expect(advanced.summary.catalogSha256, `content-pack-${seconds} 目录哈希`).toBe(opened.summary.catalogSha256);
        expect(advanced.summary.catalogSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(advanced.summary.coverage).toMatchObject({
          contentPacks: true,
          exactSegmentedOffline: true,
          pureIdleMacro: false,
          authorityEligible: false,
        });
        expect(advanced.summary.canonicalFields, `content-pack-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
        expect(advanced.summary.canonicalSha256, `content-pack-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
        await client.request({ operation: "coreClose", sessionId: opened.sessionId });
      }
    } finally {
      applyContentPackRuntimeSnapshot(runtime);
    }
  }, 60_000);

  it("matches BigInt infinite research levels, automatic continuation, and lab reset order", async () => {
    const initial = infiniteResearchState();
    const checkpoint = await seed(initial, 188);
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
      expect(projection.entities, `infinite-research-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `power-${seconds} 实体投影`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `local-logistics-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `interstellar-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `warped-interstellar-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `warper-refill-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `relay-interstellar-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `orbital-collector-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `quantum-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `quantum-local-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `quantum-belt-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
      expect(projection.entities, `quantum-construction-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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

  it("matches recursive no-job construction prefetch at a quantum boundary", async () => {
    const initial = noJobQuantumConstructionState();
    const checkpoint = await seed(initial, 206);
    const expected = advanceSimulationBudget(initial, 1, 1);
    const center = expected.entities.find((entity) => entity.buildingId === "construction_center")!;
    expect(expected.constructionAutomation.quantumMaterialBuffer?.[center.id]).toEqual({
      copper_ore: 3,
      iron_ore: 10,
      stone: 2,
    });
    expect(expected.constructionAutomation.jobs).toEqual({});
    expect(expected.construction.arc_smelter ?? 0).toBe(0);
    expect(expected.quantumLogisticsNetwork.inventory.copper_ore).toBe("999999997");
    expect(expected.quantumLogisticsNetwork.inventory.iron_ore).toBe("999999990");
    expect(expected.quantumLogisticsNetwork.inventory.stone).toBe("999999998");
    expect(expected.quantumLogisticsNetwork.runtimeFlow?.downloaded).toEqual({
      copper_ore: "3",
      iron_ore: "10",
      stone: "2",
    });

    const opened = await open(checkpoint);
    const advanced = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    expect(advanced.supported, advanced.reason ?? "no-job quantum construction").toBe(true);
    const projection = await client.request({
      operation: "coreProjection", sessionId: opened.sessionId,
      entityIds: expected.entities.map((entity) => entity.id), beltIds: [],
      baseFields: [
        "constructionAutomation", "construction", "quantumLogisticsNetwork",
        "planetTrays", "totalProduced", "productionHistory", "metrics",
        "planetMetrics", "powerGridMetrics",
      ],
    });
    expect(projection.entities).toEqual(rendererProjectedEntities(expected.entities));
    expect(projection.base.constructionAutomation).toEqual(
      JSON.parse(JSON.stringify(expected.constructionAutomation)),
    );
    expect(projection.base.quantumLogisticsNetwork).toEqual(
      JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)),
    );
    expect(advanced.summary.canonicalFields).toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256).toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });

    let segmentedExpected = initial;
    const segmentedOpened = await open(checkpoint);
    let segmentedRevision = checkpoint.revision;
    let segmentedAdvanced: any = null;
    for (let index = 0; index < 2; index += 1) {
      segmentedExpected = advanceSimulationBudget(segmentedExpected, 0.5, 0.5);
      segmentedAdvanced = await client.request({
        operation: "coreAdvance", sessionId: segmentedOpened.sessionId,
        request: {
          baseRevision: segmentedRevision,
          simulationSeconds: 0.5,
          wallSeconds: 0.5,
        },
      });
      expect(segmentedAdvanced.supported, `no-job quantum segment ${index}`).toBe(true);
      segmentedRevision += 1;
    }
    expect(segmentedExpected.constructionAutomation).toEqual(expected.constructionAutomation);
    expect(segmentedExpected.construction).toEqual(expected.construction);
    expect(segmentedExpected.quantumLogisticsNetwork).toEqual(expected.quantumLogisticsNetwork);
    expect(segmentedAdvanced.summary.canonicalFields).toEqual(canonicalFields(segmentedExpected));
    expect(segmentedAdvanced.summary.canonicalSha256).toBe(canonicalSha256(segmentedExpected));
    await client.request({ operation: "coreClose", sessionId: segmentedOpened.sessionId });
  });

  it("matches five-second batch prefetch for an existing construction job", async () => {
    const initial = existingJobQuantumPrefetchState();
    const expected = advanceSimulationBudget(initial, 1, 1);
    const center = expected.entities.find((entity) => entity.buildingId === "construction_center")!;
    expect(expected.constructionAutomation.quantumMaterialBuffer?.[center.id]).toEqual({
      iron_ingot: 400,
      stone_brick: 400,
    });
    expect(expected.constructionAutomation.jobs[center.id]?.stepIndex).toBe(0);
    expect(expected.construction.storage_mk1 ?? 0).toBe(initial.construction.storage_mk1 ?? 0);

    const checkpoint = await seed(initial, 207);
    const opened = await open(checkpoint);
    const advanced = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    expect(advanced.supported, advanced.reason ?? "existing-job construction prefetch").toBe(true);
    const projection = await client.request({
      operation: "coreProjection", sessionId: opened.sessionId,
      entityIds: expected.entities.map((entity) => entity.id), beltIds: [],
      baseFields: [
        "constructionAutomation", "construction", "quantumLogisticsNetwork",
        "planetTrays", "totalProduced", "productionHistory", "metrics",
        "planetMetrics", "powerGridMetrics",
      ],
    });
    expect(projection.entities).toEqual(rendererProjectedEntities(expected.entities));
    expect(projection.base.constructionAutomation).toEqual(
      JSON.parse(JSON.stringify(expected.constructionAutomation)),
    );
    expect(projection.base.quantumLogisticsNetwork).toEqual(
      JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)),
    );
    expect(advanced.summary.canonicalFields).toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256).toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  });

  it("matches recursive construction planning, byproduct settlement, and portable-fleet targets", async () => {
    const initial = dynamicConstructionAutomationState();
    const checkpoint = await seed(initial, 208);
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
      expect(projection.entities, `dynamic-construction-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
    const checkpoint = await seed(initial, 209);
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
      expect(projection.entities, `million-construction-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
      expect(projection.base.constructionAutomation, `million-construction-${seconds} 自动制造`).toEqual(JSON.parse(JSON.stringify(expected.constructionAutomation)));
      expect(projection.base.construction, `million-construction-${seconds} 建筑库存`).toEqual(JSON.parse(JSON.stringify(expected.construction)));
      expect(projection.base.tray, `million-construction-${seconds} 托盘`).toEqual(JSON.parse(JSON.stringify(expected.tray)));
      expect(advanced.summary.canonicalFields, `million-construction-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `million-construction-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("reuses guarded direct-buffer plans across repeated target rotations", async () => {
    const initial = guardedDirectCacheConstructionState();
    const profiler = createSimulationProfiler();
    const session = createSimulationAdvanceSession(initial, 1, { profiler });
    advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
    const expected = completeSimulationAdvanceSession(session);
    expect(profiler.constructionIterations).toBeGreaterThan(24);
    expect(profiler.constructionPlanBuilds).toBeLessThan(24);
    expect(expected.constructionAutomation.totalCrafted).toBeGreaterThan(0);

    const checkpoint = await seed(initial, 210);
    const opened = await open(checkpoint);
    const advanced = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    expect(advanced.supported, advanced.reason ?? "guarded direct plan cache").toBe(true);
    const projection = await client.request({
      operation: "coreProjection", sessionId: opened.sessionId,
      entityIds: expected.entities.map((entity) => entity.id), beltIds: [],
      baseFields: [
        "constructionAutomation", "construction", "planetTrays", "tray",
        "totalProduced", "productionHistory", "metrics", "planetMetrics",
        "powerGridMetrics",
      ],
    });
    expect(projection.entities).toEqual(rendererProjectedEntities(expected.entities));
    expect(projection.base.constructionAutomation).toEqual(
      JSON.parse(JSON.stringify(expected.constructionAutomation)),
    );
    expect(projection.base.construction).toEqual(JSON.parse(JSON.stringify(expected.construction)));
    expect(advanced.summary.canonicalFields).toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256).toBe(canonicalSha256(expected));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  });

  it("returns orphaned direct-construction reservations without losing material", async () => {
    const initial = orphanedQuantumConstructionBufferState();
    const checkpoint = await seed(initial, 211);
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
    const checkpoint = await seed(initial, 212);
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
      expect(projection.entities, `quantum-transition-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
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
    const checkpoint = await seed(initial, 213);
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
      expect(projection.entities, `orbital-cargo-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
      expect(projection.belts, `orbital-cargo-${seconds} 线路`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(projection.base.orbitalStation, `orbital-cargo-${seconds} 空间站`).toEqual(JSON.parse(JSON.stringify(expected.orbitalStation)));
      expect(advanced.summary.canonicalFields, `orbital-cargo-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `orbital-cargo-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("matches orbital cargo contract restrictions, totals, and claimable transition", async () => {
    const initial = orbitalCargoContractState();
    const checkpoint = await seed(initial, 214);
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
      expect(projection.entities, `orbital-contract-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
      expect(projection.base.orbitalStation, `orbital-contract-${seconds} 空间站`).toEqual(JSON.parse(JSON.stringify(expected.orbitalStation)));
      expect(advanced.summary.canonicalFields, `orbital-contract-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `orbital-contract-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("matches deterministic station offer generation and expired-contract settlement", async () => {
    for (const [index, expireAccepted] of [false, true].entries()) {
      const initial = orbitalCargoContractRefreshState(expireAccepted);
      const checkpoint = await seed(initial, 215 + index);
      const expected = advanceSimulationBudget(initial, 1, 1);
      const opened = await open(checkpoint);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      const label = expireAccepted ? "station-contract-expiry" : "station-contract-generation";
      expect(advanced.supported, `${label}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["orbitalStation", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `${label} 实体`).toEqual(rendererProjectedEntities(expected.entities));
      expect(projection.base.orbitalStation, `${label} 合同板`).toEqual(JSON.parse(JSON.stringify(expected.orbitalStation)));
      expect(advanced.summary.canonicalFields, `${label} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${label} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 30_000);

  it("matches powered construction-launcher settlement across system-station phases", async () => {
    const initial = systemSpaceStationConstructionState();
    const checkpoint = await seed(initial, 217);
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
      expect(projection.entities, `system-construction-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
      expect(projection.base.systemSpaceStations, `system-construction-${seconds} 空间站`).toEqual(JSON.parse(JSON.stringify(expected.systemSpaceStations)));
      expect(advanced.summary.canonicalFields, `system-construction-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `system-construction-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("matches elevator belts, local hub settlement, cross-system fleet dispatch, and returns", async () => {
    const initial = systemHubElevatorState();
    const checkpoint = await seed(initial, 218);
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
      expect(projection.entities, `system-hub-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
      expect(projection.belts, `system-hub-${seconds} 线路`).toEqual(JSON.parse(JSON.stringify(expected.belts)));
      expect(projection.base.systemSpaceStations, `system-hub-${seconds} 空间站`).toEqual(JSON.parse(JSON.stringify(expected.systemSpaceStations)));
      expect(projection.base.galacticHubNetwork, `system-hub-${seconds} 舰队`).toEqual(JSON.parse(JSON.stringify(expected.galacticHubNetwork)));
      expect(advanced.summary.canonicalFields, `system-hub-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `system-hub-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("matches active time-warp power allocation and clears committed pending budgets", async () => {
    const initial = activeTimeWarpState();
    const checkpoint = await seed(initial, 219);
    for (const seconds of [1, 5, 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `time-warp-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id), beltIds: expected.belts.map((belt) => belt.id),
        baseFields: ["timeWarp", "metrics", "planetMetrics", "powerGridMetrics"],
      });
      expect(projection.entities, `time-warp-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
      expect(projection.base.timeWarp, `time-warp-${seconds} 控制器`).toEqual(JSON.parse(JSON.stringify(expected.timeWarp)));
      expect(advanced.summary.canonicalFields, `time-warp-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `time-warp-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }

    const opened = await open(checkpoint);
    const first = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    const second = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: checkpoint.revision + 1, simulationSeconds: 1, wallSeconds: 1 },
    });
    const expectedSegmented = advanceSimulationBudget(advanceSimulationBudget(initial, 1, 1), 1, 1);
    expect(first.beltScheduler.initializationGroupChecks).toBe(first.beltScheduler.groupCount);
    expect(first.beltScheduler.carriedActiveGroups).toBe(0);
    expect(second.beltScheduler.initializationGroupChecks).toBe(0);
    expect(second.beltScheduler.carriedActiveGroups).toBeGreaterThan(0);
    expect(second.beltScheduler.selectionGroupChecks).toBeLessThan(
      second.beltScheduler.groupCount *
        (second.beltScheduler.transferPasses + second.beltScheduler.reservationPasses),
    );
    expect(second.summary.canonicalSha256, "carried active queue exact hash").toBe(canonicalSha256(expectedSegmented));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 90_000);

  it("wakes a large initially dormant belt cohort without changing exact settlement", async () => {
    const initial = dormantBeltWakeState();
    const checkpoint = await seed(initial, 220);
    for (const seconds of [1, 5, 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const fullScanSession = createSimulationAdvanceSession(initial, seconds, {
        wallSeconds: seconds,
        indexedLogistics: false,
      });
      advanceSimulationSession(fullScanSession, Number.MAX_SAFE_INTEGER);
      const fullScan = completeSimulationAdvanceSession(fullScanSession);
      expect(canonicalSha256(expected), `dormant-wake-${seconds} JS active/full scan`).toBe(canonicalSha256(fullScan));
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `dormant-wake-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      expect(advanced.beltScheduler).toMatchObject({
        activeQueueEnabled: true,
        routeCount: initial.belts.length,
      });
      expect(advanced.beltScheduler.stableRoutesSkipped).toBeGreaterThanOrEqual(80);
      expect(advanced.beltScheduler.transferRouteChecks + advanced.beltScheduler.reservationRouteChecks)
        .toBeLessThan(advanced.beltScheduler.routeCount *
          (advanced.beltScheduler.transferPasses + advanced.beltScheduler.reservationPasses));
      expect(advanced.beltScheduler.reservationAllowanceEntries)
        .toBeLessThan(advanced.beltScheduler.routeCount);
      expect(advanced.beltScheduler.reservationCreditEntries)
        .toBeLessThan(advanced.beltScheduler.groupCount);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.map((entity) => entity.id),
        beltIds: [],
        baseFields: [],
      });
      expect(projection.entities, `dormant-wake-${seconds} 实体`).toEqual(rendererProjectedEntities(expected.entities));
      expect(advanced.summary.canonicalFields, `dormant-wake-${seconds} 顶层字段`).toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `dormant-wake-${seconds} 完整哈希`).toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("sleeps empty ordinary producer outputs and catches up a real first-phase input at 1/5/60", async () => {
    const initial = dormantOrdinaryProducerWakeState();
    const checkpoint = await seed(initial, 221);
    for (const seconds of [1, 5, 60]) {
      const opened = await open(checkpoint);
      const expected = advanceSimulationBudget(initial, seconds, seconds);
      const fullScanSession = createSimulationAdvanceSession(initial, seconds, {
        wallSeconds: seconds,
        indexedLogistics: false,
      });
      advanceSimulationSession(fullScanSession, Number.MAX_SAFE_INTEGER);
      const fullScan = completeSimulationAdvanceSession(fullScanSession);
      expect(canonicalSha256(expected), `ordinary-wake-${seconds} JS active/full scan`)
        .toBe(canonicalSha256(fullScan));
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `ordinary-wake-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      expect(advanced.beltScheduler).toMatchObject({
        activeQueueEnabled: true,
        routeCount: initial.belts.length,
      });
      expect(advanced.beltScheduler.stableRoutesSkipped).toBeGreaterThanOrEqual(96);
      expect(advanced.beltScheduler.transferRouteChecks + advanced.beltScheduler.reservationRouteChecks)
        .toBeLessThan(advanced.beltScheduler.routeCount *
          (advanced.beltScheduler.transferPasses + advanced.beltScheduler.reservationPasses));
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: expected.entities.slice(0, 32).map((entity) => entity.id),
        beltIds: expected.belts.slice(0, 64).map((belt) => belt.id),
        baseFields: [],
      });
      expect(projection.entities, `ordinary-wake-${seconds} entities`)
        .toEqual(rendererProjectedEntities(expected.entities.slice(0, 32)));
      expect(projection.belts, `ordinary-wake-${seconds} belts`)
        .toEqual(JSON.parse(JSON.stringify(expected.belts.slice(0, 64))));
      expect(advanced.summary.canonicalFields, `ordinary-wake-${seconds} top-level`)
        .toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `ordinary-wake-${seconds} canonical hash`)
        .toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
    for (const sequence of [
      { label: "ordinary-wake-60x1", steps: Array.from({ length: 60 }, () => 1) },
      { label: "ordinary-wake-12x5", steps: Array.from({ length: 12 }, () => 5) },
    ]) {
      const opened = await open(checkpoint);
      let expected = initial;
      let fullScanExpected = initial;
      let revision = checkpoint.revision;
      let advanced: any = null;
      for (const seconds of sequence.steps) {
        expected = advanceSimulationBudget(expected, seconds, seconds);
        const fullScanSession = createSimulationAdvanceSession(fullScanExpected, seconds, {
          wallSeconds: seconds,
          indexedLogistics: false,
        });
        advanceSimulationSession(fullScanSession, Number.MAX_SAFE_INTEGER);
        fullScanExpected = completeSimulationAdvanceSession(fullScanSession);
        advanced = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(advanced.supported, `${sequence.label}: ${advanced.reason ?? ""}`).toBe(true);
        expect(advanced.beltScheduler, `${sequence.label} carried activity`).toMatchObject({
          activeQueueEnabled: true,
          routeCount: initial.belts.length,
        });
        expect(advanced.beltScheduler.stableRoutesSkipped, `${sequence.label} skipped routes`)
          .toBeGreaterThanOrEqual(96);
        expect(
          advanced.beltScheduler.transferRouteChecks + advanced.beltScheduler.reservationRouteChecks,
          `${sequence.label} sparse route checks`,
        ).toBeLessThan(advanced.beltScheduler.routeCount *
          (advanced.beltScheduler.transferPasses + advanced.beltScheduler.reservationPasses));
        revision = advanced.revision;
      }
      expect(canonicalSha256(expected), `${sequence.label} JS active/full scan`)
        .toBe(canonicalSha256(fullScanExpected));
      expect(advanced.summary.canonicalFields, `${sequence.label} top-level`)
        .toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${sequence.label} canonical hash`)
        .toBe(canonicalSha256(expected));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 120_000);

  it("reserves one shared target ledger for a quantum boundary writer and an output-credit producer", async () => {
    const initial = sharedQuantumProducerTargetState();
    const initialEntityById = new Map(initial.entities.map((entity) => [entity.id, entity]));
    expect(initial.belts.filter((belt) =>
      belt.planetId !== initialEntityById.get(belt.source)?.planetId ||
      belt.planetId !== initialEntityById.get(belt.target)?.planetId,
    ).map((belt) => ({
      id: belt.id,
      planetId: belt.planetId,
      sourcePlanetId: initialEntityById.get(belt.source)?.planetId,
      targetPlanetId: initialEntityById.get(belt.target)?.planetId,
    })), "shared-target fixture belt planets").toEqual([]);
    const initialSink = initial.entities.find((entity) => entity.id === "native_shared_target_blocked_sink")!;
    expect(
      getEntityItemInputCapacity(initial, initialSink, "iron_ingot") -
        (initialSink.inputs.iron_ingot ?? 0),
      "shared-target fixture has exactly two free target slots",
    ).toBe(2);
    expect(initialSink.outputs.gear, "shared-target fixture keeps the target recipe output-blocked")
      .toBe(120);
    const checkpoint = await seed(initial, 222);
    const warmActive = advanceSimulationBudget(initial, 0, 0);
    const warmFull = forcedFullLogisticsAdvance(initial, 0);
    expect(canonicalSha256(warmActive), "shared-target zero-budget JS active/full scan")
      .toBe(canonicalSha256(warmFull));

    const active = advanceSimulationBudget(warmActive, 1, 1);
    const full = forcedFullLogisticsAdvance(warmFull, 1);
    const demandId = initial.entities.find((entity) => entity.quantumMode === "quantum")!.id;
    const producerId = initial.entities.find((entity) => entity.buildingId === "arc_smelter")!.id;
    const entityIds = [demandId, producerId, "native_shared_target_blocked_sink"];
    const beltIds = [
      "native_shared_target_Z_quantum",
      "native_shared_target_00_producer",
      "native_shared_target_a_quantum_second",
    ];
    expect(initial.belts.slice(0, 3).map((belt) => belt.id),
      "shared-target fixture persists interleaved A1, B1, A2 source groups")
      .toEqual(beltIds);
    expect(beltIds[0].localeCompare(beltIds[2]),
      "shared-target source order differs under locale collation")
      .toBeGreaterThan(0);
    expect(Buffer.compare(Buffer.from(beltIds[0], "utf8"), Buffer.from(beltIds[2], "utf8")),
      "shared-target native source order follows stable UTF-8 bytes")
      .toBeLessThan(0);

    const opened = await open(checkpoint);
    const warmed = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: checkpoint.revision, simulationSeconds: 0, wallSeconds: 0 },
    });
    expect(warmed.supported, `shared-target zero-budget warm-up: ${warmed.reason ?? ""}`).toBe(true);
    expect(warmed.summary.canonicalSha256, "shared-target zero-budget native warm-up")
      .toBe(canonicalSha256(warmFull));
    const advanced = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: warmed.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    expect(advanced.supported, `shared-target five-second boundary: ${advanced.reason ?? ""}`).toBe(true);
    expect(advanced.beltScheduler).toMatchObject({
      activeQueueEnabled: true,
      routeCount: initial.belts.length,
    });
    const projection = await client.request({
      operation: "coreProjection", sessionId: opened.sessionId,
      entityIds,
      beltIds,
      baseFields: ["quantumLogisticsNetwork", "totalProduced"],
    });

    // Persisted row order is the semantic oracle across indexed, no-index fallback,
    // and native settlement. The two quantum rows deliberately surround the
    // producer row, so an active path that concatenates source groups as
    // A1,A2,B1 would steal B1's shared target credit. Belt IDs also oppose the
    // persisted order. Keep every assertion soft so one RED run records all
    // disagreements together.
    expect.soft(canonicalSha256(active), "shared-target JS active/full canonical")
      .toBe(canonicalSha256(full));
    expect.soft(active.belts.find((belt) => belt.id === beltIds[0])?.totalTransferred,
      "shared-target UTF-8-first quantum route wins its source tie")
      .toBeGreaterThan(active.belts.find((belt) => belt.id === beltIds[2])?.totalTransferred ?? 0);
    expect.soft(active.totalProduced.iron_ingot, "shared-target JS active production")
      .toBe(full.totalProduced.iron_ingot);
    expect.soft(
      active.entities.find((entity) => entity.id === demandId)?.outputs.iron_ingot,
      "shared-target JS active quantum remainder",
    ).toBe(full.entities.find((entity) => entity.id === demandId)?.outputs.iron_ingot);
    expect.soft(advanced.summary.canonicalFields, "shared-target native top-level")
      .toEqual(canonicalFields(full));
    expect.soft(advanced.summary.canonicalSha256, "shared-target native canonical/conservation")
      .toBe(canonicalSha256(full));
    expect.soft(advanced.summary.domainSha256, "shared-target native domain proof")
      .toBe(nativeCoreDomainSha256(full, advanced.revision));
    expect.soft(projection.entities, "shared-target bounded entities")
      .toEqual(rendererProjectedEntities(entityIds.map((entityId) =>
        full.entities.find((entity) => entity.id === entityId)!)));
    expect.soft(projection.belts, "shared-target bounded belts")
      .toEqual(JSON.parse(JSON.stringify(full.belts.filter((belt) => beltIds.includes(belt.id)))));
    expect.soft(projection.base.quantumLogisticsNetwork, "shared-target bounded quantum network")
      .toEqual(JSON.parse(JSON.stringify(full.quantumLogisticsNetwork)));
    expect.soft(projection.base.totalProduced, "shared-target bounded production counters")
      .toEqual(JSON.parse(JSON.stringify(full.totalProduced)));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 60_000);

  it("uses UTF-8 byte order for an independent same-source one-item race in JS active, JS no-index fallback, and Rust", async () => {
    const initial = utf8SameSourceFairnessState();
    const sourceId = initial.entities.find((entity) =>
      entity.id !== "native_shared_target_dormant_station" &&
      entity.buildingId === "interstellar_logistics_station")!.id;
    const aBeltId = "native_utf8_a_route";
    const zBeltId = "native_utf8_Z_route";
    const aSinkId = "native_utf8_sink_a";
    const zSinkId = "native_utf8_sink_Z";
    const competingBeltIds = [aBeltId, zBeltId];
    const entityIds = [sourceId, aSinkId, zSinkId];
    const relevantIron = (state: GameState) => entityIds.reduce((total, entityId) => {
      const entity = state.entities.find((candidate) => candidate.id === entityId)!;
      return total + exactInventoryAmount(entity.inputs.iron_ingot) +
        exactInventoryAmount(entity.outputs.iron_ingot);
    }, 0n);

    expect(initial.belts.slice(0, 2).map((belt) => belt.id),
      "UTF-8 race persists locale-first row order")
      .toEqual([aBeltId, zBeltId]);
    expect(initial.entities.find((entity) => entity.id === sourceId)?.outputs.iron_ingot,
      "UTF-8 race has exactly one source item")
      .toBe(1);
    for (const sinkId of [aSinkId, zSinkId]) {
      const sink = initial.entities.find((entity) => entity.id === sinkId)!;
      expect(
        getEntityItemInputCapacity(initial, sink, "iron_ingot") - (sink.inputs.iron_ingot ?? 0),
        `${sinkId} independently has room for the source item`,
      ).toBeGreaterThan(0);
    }

    const legacyLocaleWinner = [...competingBeltIds]
      .sort((left, right) => left.localeCompare(right))[0];
    const utf8Winner = [...competingBeltIds]
      .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))[0];
    expect(legacyLocaleWinner, "the removed localeCompare implementation would pick lowercase a")
      .toBe(aBeltId);
    expect(utf8Winner, "the cross-language UTF-8 contract picks ASCII uppercase Z")
      .toBe(zBeltId);

    const active = advanceSimulationBudget(initial, 1, 1);
    const full = forcedFullLogisticsAdvance(initial, 1);
    expect(canonicalSha256(active), "UTF-8 race JS active/no-index fallback canonical")
      .toBe(canonicalSha256(full));
    const activeTransferred = Object.fromEntries(competingBeltIds.map((beltId) => [
      beltId,
      active.belts.find((belt) => belt.id === beltId)?.totalTransferred ?? 0,
    ]));
    const actualWinner = competingBeltIds.find((beltId) => activeTransferred[beltId] === 1);
    expect(activeTransferred, "UTF-8 race transfers the sole item exactly once")
      .toEqual({ [aBeltId]: 0, [zBeltId]: 1 });
    expect(actualWinner, "UTF-8 race winner differs from the removed locale comparator")
      .toBe(utf8Winner);
    expect(actualWinner).not.toBe(legacyLocaleWinner);
    expect(active.entities.find((entity) => entity.id === sourceId)?.outputs.iron_ingot,
      "UTF-8 race drains the source once")
      .toBe(0);
    expect(active.entities.find((entity) => entity.id === aSinkId)?.inputs.iron_ingot,
      "UTF-8 race locale-first target receives nothing")
      .toBe(0);
    expect(active.entities.find((entity) => entity.id === zSinkId)?.inputs.iron_ingot,
      "UTF-8 race byte-first target receives the item")
      .toBe(1);
    expect(relevantIron(initial), "UTF-8 race initial closed ledger").toBe(1n);
    expect(relevantIron(active), "UTF-8 race JS closed ledger").toBe(relevantIron(initial));
    expect(relevantIron(full), "UTF-8 race full closed ledger").toBe(relevantIron(initial));

    const checkpoint = await seed(initial, 222);
    const opened = await open(checkpoint);
    const advanced = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    expect(advanced.supported, `UTF-8 race native support: ${advanced.reason ?? ""}`).toBe(true);
    expect(advanced.beltScheduler).toMatchObject({
      activeQueueEnabled: true,
      routeCount: initial.belts.length,
    });
    expect(advanced.beltScheduler.stableRoutesSkipped, "UTF-8 race leaves dormant station routes asleep")
      .toBeGreaterThanOrEqual(96);
    expect(advanced.summary.canonicalFields, "UTF-8 race native top-level")
      .toEqual(canonicalFields(full));
    expect(advanced.summary.canonicalSha256, "UTF-8 race native canonical/conservation")
      .toBe(canonicalSha256(full));
    expect(advanced.summary.domainSha256, "UTF-8 race native domain proof")
      .toBe(nativeCoreDomainSha256(full, advanced.revision));
    const projection = await client.request({
      operation: "coreProjection", sessionId: opened.sessionId,
      entityIds,
      beltIds: competingBeltIds,
      baseFields: [],
    });
    expect(projection.entities, "UTF-8 race native bounded entities")
      .toEqual(rendererProjectedEntities(entityIds.map((entityId) =>
        full.entities.find((entity) => entity.id === entityId)!)));
    expect(projection.belts, "UTF-8 race native bounded belts")
      .toEqual(JSON.parse(JSON.stringify(full.belts.filter((belt) => competingBeltIds.includes(belt.id)))));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 60_000);

  it("fails closed malformed legacy station metadata without rejecting missing defaults", async () => {
    const initial = selectiveLegacyStationItemWakeState();
    const stationId = "native_selective_item_station";
    const inspect = (state: GameState) => {
      const lookup = createSimulationLookupContext(state);
      const sourceGroups = lookup.beltRuntime.routeGroups.filter((group) =>
        group.source?.id === stationId);
      expect(sourceGroups.length, "malformed-slot fixture has routed station groups")
        .toBeGreaterThan(0);
      return {
        tracked: lookup.beltRuntime.trackedStationSourceIds.has(stationId),
        allAwake: sourceGroups.every((group) => group.potentiallyProduces),
      };
    };
    const mutateFirstSlot = (state: GameState, field: string, value: unknown, remove = false) => {
      const station = state.entities.find((entity) => entity.id === stationId)!;
      const slot = station.stationSlots![0] as unknown as Record<string, unknown>;
      if (remove) delete slot[field];
      else slot[field] = value;
    };
    const mutateStation = (state: GameState, field: string, value: unknown, remove = false) => {
      const station = state.entities.find((entity) => entity.id === stationId)! as unknown as Record<string, unknown>;
      if (remove) delete station[field];
      else station[field] = value;
    };

    for (const [field, value] of [
      ["localMode", ["supply"]],
      ["remoteMode", ["supply"]],
      ["routePolicy", ["direct"]],
      ["localMode", 7],
      ["remoteMode", { opaque: true }],
    ] as const) {
      const malformed = structuredClone(initial);
      mutateFirstSlot(malformed, field, value);
      expect(inspect(malformed), `${field} non-string must fail closed`)
        .toEqual({ tracked: false, allAwake: true });
    }
    const nearMinimumLoad = structuredClone(initial);
    mutateFirstSlot(nearMinimumLoad, "minimumLoad", 0.1 + Number.EPSILON);
    expect(inspect(nearMinimumLoad), "near but non-catalog minimum load must fail closed")
      .toEqual({ tracked: false, allAwake: true });

    for (const field of ["localMode", "remoteMode", "routePolicy"] as const) {
      const missing = structuredClone(initial);
      mutateFirstSlot(missing, field, undefined, true);
      expect(inspect(missing), `${field} missing uses its legacy default`)
        .toEqual({ tracked: true, allAwake: false });
      const nullish = structuredClone(initial);
      mutateFirstSlot(nullish, field, null);
      expect(inspect(nullish), `${field} null uses its legacy default`)
        .toEqual({ tracked: true, allAwake: false });
    }

    for (const [field, value] of [
      ["stationOperationMode", null],
      ["stationOperationMode", 7],
      ["stationOperationMode", { opaque: true }],
      ["quantumMode", null],
      ["quantumMode", 7],
      ["quantumMode", { opaque: true }],
    ] as const) {
      const malformed = structuredClone(initial);
      mutateStation(malformed, field, value);
      expect(inspect(malformed), `${field} malformed value must fail closed`)
        .toEqual({ tracked: false, allAwake: true });
    }
    for (const field of ["stationOperationMode", "quantumMode"] as const) {
      const missing = structuredClone(initial);
      mutateStation(missing, field, undefined, true);
      expect(inspect(missing), `${field} missing retains the legacy-v47 default`)
        .toEqual({ tracked: true, allAwake: false });
    }

    for (const [field, value] of [
      ["stationOperationMode", { opaque: true }],
      ["quantumMode", 7],
    ] as const) {
      const malformed = structuredClone(initial);
      mutateStation(malformed, field, value);
      const active = advanceSimulationBudget(malformed, 1, 1);
      const full = forcedFullLogisticsAdvance(malformed, 1);
      expect(canonicalSha256(active), `${field} malformed JS active/full`)
        .toBe(canonicalSha256(full));
      // Keep the shared normal-slot save revision monotonic for later fixtures;
      // equal-revision generations are valid independent checkpoints.
      const checkpoint = await seed(malformed, 222);
      const opened = await open(checkpoint);
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `${field} malformed native support: ${advanced.reason ?? ""}`).toBe(true);
      expect(advanced.summary.canonicalSha256, `${field} malformed JS/full/native`)
        .toBe(canonicalSha256(full));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 60_000);

  it("scales the legacy-station reverse directory with one real inventory write", async () => {
    const stationCount = 96;
    const initial = legacyStationReverseDirectoryState(stationCount);
    const warmActive = advanceSimulationBudget(initial, 1, 1);
    const warmFull = forcedFullLogisticsAdvance(initial, 1);
    expect(canonicalSha256(warmActive), "legacy reverse-directory cold JS active/full scan")
      .toBe(canonicalSha256(warmFull));
    expect(
      warmActive.entities.find((entity) => entity.id === "native_reverse_station_000")?.inputs.gear,
      "legacy reverse-directory warm-up has no station inventory write",
    ).toBe(0);

    const expected = advanceSimulationBudget(warmActive, 1, 1);
    const full = forcedFullLogisticsAdvance(warmFull, 1);
    expect(canonicalSha256(expected), "legacy reverse-directory sustained JS active/full scan")
      .toBe(canonicalSha256(full));
    expect(expected.entities.filter((entity) =>
      entity.id.startsWith("native_reverse_station_") && (entity.inputs.gear ?? 0) > 0,
    ).map((entity) => entity.id), "legacy reverse-directory has exactly one inventory writer")
      .toEqual(["native_reverse_station_000"]);

    const checkpoint = await seed(initial, 223);
    const opened = await open(checkpoint);
    const warmed = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    expect(warmed.supported, `legacy reverse-directory cold warm-up: ${warmed.reason ?? ""}`).toBe(true);
    const warmEntityIds = [
      "native_reverse_station_000",
      "native_reverse_station_095",
      initial.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id,
      "native_quantum_belt_sink",
    ];
    const warmProjection = await client.request({
      operation: "coreProjection", sessionId: opened.sessionId,
      entityIds: warmEntityIds,
      beltIds: [],
      baseFields: [],
    });
    expect(warmProjection.entities, "legacy reverse-directory cold bounded entities")
      .toEqual(rendererProjectedEntities(warmEntityIds.map((entityId) =>
        warmFull.entities.find((entity) => entity.id === entityId)!)));
    expect(warmed.summary.canonicalFields, "legacy reverse-directory cold native fields")
      .toEqual(canonicalFields(warmFull));
    expect(warmed.summary.canonicalSha256, "legacy reverse-directory cold native hash")
      .toBe(canonicalSha256(warmFull));
    const advanced = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: warmed.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    expect(advanced.supported, `legacy reverse-directory sustained advance: ${advanced.reason ?? ""}`)
      .toBe(true);
    expect(advanced.beltScheduler).toMatchObject({
      activeQueueEnabled: true,
      routeCount: initial.belts.length,
      fullScanPasses: 0,
      initializationGroupChecks: 0,
    });
    const passes = advanced.beltScheduler.transferPasses + advanced.beltScheduler.reservationPasses;
    const routeChecks = advanced.beltScheduler.transferRouteChecks +
      advanced.beltScheduler.reservationRouteChecks;
    expect(passes, "legacy reverse-directory sustained route passes").toBeGreaterThan(0);
    expect(advanced.beltScheduler.selectionGroupChecks,
      "legacy reverse-directory selection scales below the station cohort")
      .toBeLessThan(stationCount);
    expect(advanced.beltScheduler.stableRoutesSkipped,
      "legacy reverse-directory skips the unchanged station routes")
      .toBeGreaterThanOrEqual((stationCount - 2) * passes);
    expect(routeChecks * 8, "legacy reverse-directory route work is materially sparse")
      .toBeLessThan(advanced.beltScheduler.routeCount * passes);
    expect(advanced.beltScheduler.wakeCount, "legacy reverse-directory wakes the written station")
      .toBeGreaterThan(0);
    expect(advanced.beltScheduler.wakeCount, "legacy reverse-directory does not wake every station")
      .toBeLessThan(8);

    const entityIds = [
      "native_reverse_station_000",
      "native_reverse_station_095",
      initial.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id,
      "native_quantum_belt_sink",
    ];
    const beltIds = [
      "native_reverse_writer",
      "native_reverse_station_output_000",
      "native_reverse_station_output_095",
    ];
    const projection = await client.request({
      operation: "coreProjection", sessionId: opened.sessionId,
      entityIds,
      beltIds,
      baseFields: ["totalProduced"],
    });
    expect(projection.entities, "legacy reverse-directory bounded entities")
      .toEqual(rendererProjectedEntities(entityIds.map((entityId) =>
        expected.entities.find((entity) => entity.id === entityId)!)));
    expect(projection.belts, "legacy reverse-directory bounded belts")
      .toEqual(JSON.parse(JSON.stringify(beltIds.map((beltId) =>
        expected.belts.find((belt) => belt.id === beltId)!))));
    expect(projection.base.totalProduced, "legacy reverse-directory bounded counters")
      .toEqual(JSON.parse(JSON.stringify(expected.totalProduced)));
    expect(advanced.summary.canonicalFields, "legacy reverse-directory native top-level")
      .toEqual(canonicalFields(expected));
    expect(advanced.summary.canonicalSha256, "legacy reverse-directory native canonical/conservation")
      .toBe(canonicalSha256(expected));
    expect(advanced.summary.domainSha256, "legacy reverse-directory native domain proof")
      .toBe(nativeCoreDomainSha256(expected, advanced.revision));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 60_000);

  it("sleeps 96 legacy station routes while keeping the quantum boundary writer exact", async () => {
    const initial = dormantQuantumStationSourceState();
    const initialCopper = quantumStationCopperInventory(initial);
    const entityIds = new Set(initial.entities.map((entity) => entity.id));
    expect(entityIds.size, "station-source-wake fixture entity IDs are unique")
      .toBe(initial.entities.length);
    expect(initial.belts.filter((belt) =>
      belt.source === belt.target || !entityIds.has(belt.source) || !entityIds.has(belt.target)),
    "station-source-wake fixture belt endpoints exist and differ").toEqual([]);
    const checkpoint = await seed(initial, 224);
    const warmExpected = advanceSimulationBudget(initial, 1, 1);
    const warmFullScan = forcedFullLogisticsAdvance(initial, 1);
    expect(canonicalSha256(warmExpected), "station-source-wake cold JS active/full scan")
      .toBe(canonicalSha256(warmFullScan));
    expect(quantumStationCopperInventory(warmExpected), "station-source-wake cold copper conservation")
      .toBe(initialCopper);
    const demandId = initial.entities.find((entity) =>
      entity.buildingId === "interstellar_logistics_station" &&
      entity.quantumMode === "quantum" &&
      entity.stationSlots?.some((slot) =>
        slot.itemId === "copper_ore" && slot.remoteMode === "demand"))!.id;
    const sinkId = "native_quantum_belt_sink";
    const boundedEntityIds = initial.entities
      .filter((entity) =>
        entity.id === demandId || entity.id === sinkId ||
        entity.id === "native_dormant_quantum_station")
      .slice(0, 10)
      .map((entity) => entity.id);
    const boundedBeltIds = initial.belts
      .filter((belt) =>
        belt.source === demandId || belt.id.startsWith("native_dormant_quantum_output_"))
      .slice(0, 32)
      .map((belt) => belt.id);

    for (const seconds of [1, 5, 60]) {
      const expected = advanceSimulationBudget(warmExpected, seconds, seconds);
      const fullScan = forcedFullLogisticsAdvance(warmFullScan, seconds);
      expect(canonicalSha256(expected), `station-source-wake-${seconds} JS active/full scan`)
        .toBe(canonicalSha256(fullScan));
      expect(quantumStationCopperInventory(expected), `station-source-wake-${seconds} JS copper conservation`)
        .toBe(initialCopper);
      expect(quantumStationCopperInventory(fullScan), `station-source-wake-${seconds} full-scan copper conservation`)
        .toBe(initialCopper);
      if (seconds === 5) {
        expect(
          exactInventoryAmount(expected.quantumLogisticsNetwork.runtimeFlow?.downloaded.copper_ore),
          `station-source-wake-${seconds} real quantum inventory write`,
        ).toBeGreaterThan(0n);
      }
      if (seconds === 60) {
        const sink = expected.entities.find((entity) => entity.id === sinkId)!;
        expect(
          exactInventoryAmount(sink.inputs.copper_ore) + exactInventoryAmount(sink.outputs.copper_ore),
          `station-source-wake-${seconds} same-step quantum belt output`,
        ).toBeGreaterThan(0n);
      }

      const opened = await open(checkpoint);
      const warmed = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(warmed.supported, `station-source-wake-${seconds} cold warm-up: ${warmed.reason ?? ""}`)
        .toBe(true);
      const warmProjection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: boundedEntityIds,
        beltIds: [],
        baseFields: [],
      });
      expect(warmProjection.entities, `station-source-wake-${seconds} cold warm-up entities`)
        .toEqual(rendererProjectedEntities(warmExpected.entities.filter((entity) =>
          boundedEntityIds.includes(entity.id))));
      expect(warmed.summary.canonicalFields, `station-source-wake-${seconds} cold warm-up fields`)
        .toEqual(canonicalFields(warmExpected));
      expect(warmed.summary.canonicalSha256, `station-source-wake-${seconds} cold warm-up hash`)
        .toBe(canonicalSha256(warmExpected));
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: warmed.revision, simulationSeconds: seconds, wallSeconds: seconds },
      });
      expect(advanced.supported, `station-source-wake-${seconds}: ${advanced.reason ?? ""}`).toBe(true);
      expect(advanced.beltScheduler).toMatchObject({
        activeQueueEnabled: true,
        routeCount: initial.belts.length,
      });
      const passes = advanced.beltScheduler.transferPasses + advanced.beltScheduler.reservationPasses;
      const routeChecks = advanced.beltScheduler.transferRouteChecks +
        advanced.beltScheduler.reservationRouteChecks;
      const fullRouteBudget = advanced.beltScheduler.routeCount * passes;
      const sparsePasses = passes - advanced.beltScheduler.fullScanPasses;
      expect(passes, `station-source-wake-${seconds} route passes`).toBeGreaterThan(0);
      expect(sparsePasses, `station-source-wake-${seconds} sustained sparse passes`)
        .toBeGreaterThan(0);
      expect(advanced.beltScheduler.stableRoutesSkipped, `station-source-wake-${seconds} dormant routes`)
        .toBeGreaterThanOrEqual(96 * sparsePasses);
      expect(routeChecks, `station-source-wake-${seconds} bounded route checks`)
        .toBeLessThanOrEqual(
          advanced.beltScheduler.routeCount * advanced.beltScheduler.fullScanPasses +
          (advanced.beltScheduler.routeCount - 96) * sparsePasses,
        );
      expect(routeChecks * 2, `station-source-wake-${seconds} materially below full scan`)
        .toBeLessThan(fullRouteBudget);

      const projectedExpectedEntities = expected.entities.filter((entity) =>
        boundedEntityIds.includes(entity.id));
      const projectedExpectedBelts = expected.belts.filter((belt) =>
        boundedBeltIds.includes(belt.id));
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: boundedEntityIds,
        beltIds: boundedBeltIds,
        baseFields: ["quantumLogisticsNetwork"],
      });
      expect(projection.entities, `station-source-wake-${seconds} bounded entities`)
        .toEqual(rendererProjectedEntities(projectedExpectedEntities));
      expect(projection.belts, `station-source-wake-${seconds} bounded belts`)
        .toEqual(JSON.parse(JSON.stringify(projectedExpectedBelts)));
      expect(projection.base.quantumLogisticsNetwork, `station-source-wake-${seconds} quantum projection`)
        .toEqual(JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)));
      expect(advanced.summary.canonicalFields, `station-source-wake-${seconds} top-level`)
        .toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `station-source-wake-${seconds} canonical/conservation`)
        .toBe(canonicalSha256(expected));
      expect(advanced.summary.domainSha256, `station-source-wake-${seconds} domain proof`)
        .toBe(nativeCoreDomainSha256(expected, checkpoint.revision + 2));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }

    const singleExpected = advanceSimulationBudget(warmExpected, 60, 60);
    const singleFullScan = forcedFullLogisticsAdvance(warmFullScan, 60);
    const singleCanonical = canonicalSha256(singleExpected);
    expect(singleCanonical, "station-source-wake single 60 JS active/full scan")
      .toBe(canonicalSha256(singleFullScan));
    expect(quantumStationCopperInventory(singleExpected), "station-source-wake single 60 conservation")
      .toBe(initialCopper);

    for (const sequence of [
      { label: "station-source-wake-60x1", steps: Array.from({ length: 60 }, () => 1) },
      { label: "station-source-wake-12x5", steps: Array.from({ length: 12 }, () => 5) },
    ]) {
      const opened = await open(checkpoint);
      const warmed = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(warmed.supported, `${sequence.label} cold warm-up: ${warmed.reason ?? ""}`).toBe(true);
      expect(warmed.summary.canonicalSha256, `${sequence.label} cold warm-up hash`)
        .toBe(canonicalSha256(warmExpected));
      let expected = warmExpected;
      let fullScanExpected = warmFullScan;
      let revision = warmed.revision;
      let advanced: any = null;
      for (const seconds of sequence.steps) {
        expected = advanceSimulationBudget(expected, seconds, seconds);
        fullScanExpected = forcedFullLogisticsAdvance(fullScanExpected, seconds);
        expect(canonicalSha256(expected), `${sequence.label} per-revision JS active/full scan`)
          .toBe(canonicalSha256(fullScanExpected));
        advanced = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(advanced.supported, `${sequence.label}: ${advanced.reason ?? ""}`).toBe(true);
        expect(advanced.beltScheduler).toMatchObject({
          activeQueueEnabled: true,
          routeCount: initial.belts.length,
        });
        const passes = advanced.beltScheduler.transferPasses + advanced.beltScheduler.reservationPasses;
        const routeChecks = advanced.beltScheduler.transferRouteChecks +
          advanced.beltScheduler.reservationRouteChecks;
        const sparsePasses = passes - advanced.beltScheduler.fullScanPasses;
        expect(sparsePasses, `${sequence.label} sustained sparse passes`).toBeGreaterThan(0);
        expect(advanced.beltScheduler.stableRoutesSkipped, `${sequence.label} dormant routes`)
          .toBeGreaterThanOrEqual(96 * sparsePasses);
        expect(routeChecks * 2, `${sequence.label} materially sparse route checks`)
          .toBeLessThan(advanced.beltScheduler.routeCount * passes);
        revision = advanced.revision;
      }
      const { productionHistory: _segmentedHistory, ...segmentedSemanticState } = expected;
      const { productionHistory: _singleHistory, ...singleSemanticState } = singleExpected;
      expect(canonicalSha256(segmentedSemanticState), `${sequence.label} semantic state equals single 60`)
        .toBe(canonicalSha256(singleSemanticState));
      expect(nativeCoreDomainSha256(expected, 0), `${sequence.label} domain equals single 60`)
        .toBe(nativeCoreDomainSha256(singleExpected, 0));
      expect(canonicalSha256(fullScanExpected), `${sequence.label} JS active/full scan`)
        .toBe(canonicalSha256(expected));
      expect(quantumStationCopperInventory(expected), `${sequence.label} copper conservation`)
        .toBe(initialCopper);
      expect(advanced.summary.canonicalFields, `${sequence.label} top-level`)
        .toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `${sequence.label} canonical/conservation`)
        .toBe(canonicalSha256(expected));
      expect(advanced.summary.domainSha256, `${sequence.label} domain proof`)
        .toBe(nativeCoreDomainSha256(expected, revision));

      const projectedExpectedEntities = expected.entities.filter((entity) =>
        boundedEntityIds.includes(entity.id));
      const projectedExpectedBelts = expected.belts.filter((belt) =>
        boundedBeltIds.includes(belt.id));
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: boundedEntityIds,
        beltIds: boundedBeltIds,
        baseFields: ["quantumLogisticsNetwork"],
      });
      expect(projection.entities, `${sequence.label} bounded entities`)
        .toEqual(rendererProjectedEntities(projectedExpectedEntities));
      expect(projection.belts, `${sequence.label} bounded belts`)
        .toEqual(JSON.parse(JSON.stringify(projectedExpectedBelts)));
      expect(projection.base.quantumLogisticsNetwork, `${sequence.label} quantum projection`)
        .toEqual(JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 180_000);

  it("deterministically degrades a greater-than-75-percent active station frontier to dense scans", async () => {
    const initial = denseQuantumStationSourceState();
    const initialCopper = quantumStationCopperInventory(initial);
    const entityById = new Map(initial.entities.map((entity) => [entity.id, entity]));
    const stockedStationRoutes = initial.belts.filter((belt) =>
      belt.itemId === "copper_ore" &&
      belt.source !== "native_dormant_quantum_station" &&
      exactInventoryAmount(entityById.get(belt.source)?.outputs.copper_ore) > 0n).length;
    expect(stockedStationRoutes * 4, "dense fixture has more than 75% truly stocked routes")
      .toBeGreaterThan(initial.belts.length * 3);
    const warmExpected = advanceSimulationBudget(initial, 1, 1);
    const warmFullScan = forcedFullLogisticsAdvance(initial, 1);
    const expected = advanceSimulationBudget(warmExpected, 1, 1);
    const fullScan = forcedFullLogisticsAdvance(warmFullScan, 1);
    expect(canonicalSha256(expected), "dense-station-source JS active/full scan")
      .toBe(canonicalSha256(fullScan));
    expect(quantumStationCopperInventory(expected), "dense-station-source JS copper conservation")
      .toBe(initialCopper);
    const checkpoint = await seed(initial, 225);
    const boundedEntityIds = initial.entities
      .filter((entity) =>
        entity.id === "native_quantum_belt_sink" ||
        entity.id === "native_dormant_quantum_station" ||
        (entity.buildingId === "interstellar_logistics_station" && entity.quantumMode === "quantum"))
      .map((entity) => entity.id);
    const boundedBeltIds = initial.belts
      .filter((belt) =>
        belt.id.startsWith("native_active_quantum_output_") ||
        belt.id.startsWith("native_dormant_quantum_output_") ||
        belt.id === "native_quantum_belt_download")
      .slice(0, 64)
      .map((belt) => belt.id);
    let firstAdvanced: any = null;

    for (let run = 0; run < 2; run += 1) {
      const opened = await open(checkpoint);
      const warmed = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(warmed.supported, `dense-station-source-${run} cold warm-up: ${warmed.reason ?? ""}`)
        .toBe(true);
      expect(warmed.summary.canonicalSha256, `dense-station-source-${run} cold warm-up hash`)
        .toBe(canonicalSha256(warmExpected));
      const advanced = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: warmed.revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(advanced.supported, `dense-station-source-${run}: ${advanced.reason ?? ""}`).toBe(true);
      expect(advanced.beltScheduler).toMatchObject({
        activeQueueEnabled: true,
        routeCount: initial.belts.length,
      });
      const passes = advanced.beltScheduler.transferPasses + advanced.beltScheduler.reservationPasses;
      const routeChecks = advanced.beltScheduler.transferRouteChecks +
        advanced.beltScheduler.reservationRouteChecks;
      expect(passes, `dense-station-source-${run} route passes`).toBeGreaterThan(0);
      expect(advanced.beltScheduler.fullScanPasses, `dense-station-source-${run} dense passes`)
        .toBe(passes);
      expect(advanced.beltScheduler.stableRoutesSkipped, `dense-station-source-${run} skipped routes`)
        .toBe(0);
      expect(routeChecks, `dense-station-source-${run} full route checks`)
        .toBe(advanced.beltScheduler.routeCount * passes);
      expect(advanced.summary.canonicalFields, `dense-station-source-${run} top-level`)
        .toEqual(canonicalFields(expected));
      expect(advanced.summary.canonicalSha256, `dense-station-source-${run} canonical/conservation`)
        .toBe(canonicalSha256(expected));
      expect(advanced.summary.domainSha256, `dense-station-source-${run} domain proof`)
        .toBe(nativeCoreDomainSha256(expected, checkpoint.revision + 2));

      if (run === 0) {
        const projectedExpectedEntities = expected.entities.filter((entity) =>
          boundedEntityIds.includes(entity.id));
        const projectedExpectedBelts = expected.belts.filter((belt) =>
          boundedBeltIds.includes(belt.id));
        const projection = await client.request({
          operation: "coreProjection", sessionId: opened.sessionId,
          entityIds: boundedEntityIds,
          beltIds: boundedBeltIds,
          baseFields: ["quantumLogisticsNetwork"],
        });
        expect(projection.entities, "dense-station-source bounded entities")
          .toEqual(rendererProjectedEntities(projectedExpectedEntities));
        expect(projection.belts, "dense-station-source bounded belts")
          .toEqual(JSON.parse(JSON.stringify(projectedExpectedBelts)));
        expect(projection.base.quantumLogisticsNetwork, "dense-station-source quantum projection")
          .toEqual(JSON.parse(JSON.stringify(expected.quantumLogisticsNetwork)));
        firstAdvanced = advanced;
      } else {
        expect(advanced.beltScheduler, "dense-station-source stable scheduler diagnostics")
          .toEqual(firstAdvanced.beltScheduler);
        expect(advanced.summary.canonicalSha256, "dense-station-source stable canonical hash")
          .toBe(firstAdvanced.summary.canonicalSha256);
      }
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
    }
  }, 90_000);

  it("wakes only the changed item group of a multi-item legacy station", async () => {
    const initial = selectiveLegacyStationItemWakeState();
    const station = initial.entities.find((entity) => entity.id === "native_selective_item_station")!;
    const producer = initial.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    const sharedSink = initial.entities.find((entity) => entity.id === "native_selective_item_shared_sink")!;
    const emptyIronBeltId = "native_selective_item_01_empty_iron";
    const producerBeltId = "native_selective_item_02_producer";
    expect(station.inputs.copper_ore, "selective-item fixture has one real A inventory write")
      .toBe(1);
    expect(station.outputs.copper_ore, "selective-item fixture A starts before buffer promotion")
      .toBe(0);
    expect(station.outputs.iron_ingot, "selective-item fixture B source stays empty")
      .toBe(0);
    expect(initial.belts.find((belt) => belt.id === emptyIronBeltId)?.progress,
      "selective-item fixture B has no runtime clock signal").toBe(0);
    expect(initial.belts.findIndex((belt) => belt.id === emptyIronBeltId),
      "selective-item B route sorts before the ordinary producer")
      .toBeLessThan(initial.belts.findIndex((belt) => belt.id === producerBeltId));
    expect(
      getEntityItemInputCapacity(initial, sharedSink, "iron_ingot") -
        (sharedSink.inputs.iron_ingot ?? 0),
      "selective-item shared target has exactly two free slots",
    ).toBe(2);

    const active = advanceSimulationBudget(initial, 1, 1);
    const full = forcedFullLogisticsAdvance(initial, 1);
    const activeProducer = active.entities.find((entity) => entity.id === producer.id)!;
    const fullProducer = full.entities.find((entity) => entity.id === producer.id)!;
    const activeSharedSink = active.entities.find((entity) => entity.id === sharedSink.id)!;
    const fullSharedSink = full.entities.find((entity) => entity.id === sharedSink.id)!;
    const activeStation = active.entities.find((entity) => entity.id === station.id)!;
    const activeCopperBelt = active.belts.find((belt) => belt.id === "native_selective_item_00_copper")!;
    const activeEmptyIronBelt = active.belts.find((belt) => belt.id === emptyIronBeltId)!;
    expect(canonicalSha256(active), "selective-item JS active/full canonical")
      .toBe(canonicalSha256(full));
    expect(active.totalProduced.iron_ingot, "selective-item JS active/full production")
      .toBe(full.totalProduced.iron_ingot);
    expect(activeProducer.outputs.iron_ingot, "selective-item JS active/full producer output")
      .toBe(fullProducer.outputs.iron_ingot);
    expect(activeSharedSink.inputs.iron_ingot, "selective-item JS active/full shared target")
      .toBe(fullSharedSink.inputs.iron_ingot);
    expect(activeCopperBelt.totalTransferred, "selective-item A writer reaches its real output belt")
      .toBeGreaterThan(0);
    expect(activeStation.outputs.iron_ingot, "selective-item B source remains empty after the A write")
      .toBe(0);
    expect(activeEmptyIronBelt, "selective-item active B route remains untouched").toMatchObject({
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    });

    const checkpoint = await seed(initial, 226);
    const opened = await open(checkpoint);
    const advanced = await client.request({
      operation: "coreAdvance", sessionId: opened.sessionId,
      request: { baseRevision: checkpoint.revision, simulationSeconds: 1, wallSeconds: 1 },
    });
    expect(advanced.supported, `selective-item native advance: ${advanced.reason ?? ""}`).toBe(true);
    expect(advanced.beltScheduler).toMatchObject({
      activeQueueEnabled: true,
      routeCount: initial.belts.length,
      fullScanPasses: 0,
    });
    const entityIds = [station.id, producer.id, sharedSink.id, "native_selective_item_copper_sink"];
    const beltIds = ["native_selective_item_00_copper", emptyIronBeltId, producerBeltId];
    const projection = await client.request({
      operation: "coreProjection", sessionId: opened.sessionId,
      entityIds,
      beltIds,
      baseFields: ["totalProduced"],
    });
    const projectedProducer = projection.entities.find((entity: Record<string, unknown>) =>
      entity.id === producer.id) as Record<string, any>;
    const projectedSharedSink = projection.entities.find((entity: Record<string, unknown>) =>
      entity.id === sharedSink.id) as Record<string, any>;
    const projectedEmptyIronBelt = projection.belts.find((belt: Record<string, unknown>) =>
      belt.id === emptyIronBeltId) as Record<string, any>;

    // Indexed, forced-full, and native settlement must share one exact oracle.
    expect.soft(advanced.summary.canonicalFields, "selective-item native top-level")
      .toEqual(canonicalFields(active));
    expect.soft(advanced.summary.canonicalSha256, "selective-item native canonical/conservation")
      .toBe(canonicalSha256(active));
    expect.soft(advanced.summary.domainSha256, "selective-item native domain proof")
      .toBe(nativeCoreDomainSha256(active, advanced.revision));
    expect.soft(projection.entities, "selective-item bounded entities")
      .toEqual(rendererProjectedEntities(entityIds.map((entityId) =>
        active.entities.find((entity) => entity.id === entityId)!)));
    expect.soft(projection.belts, "selective-item bounded belts")
      .toEqual(JSON.parse(JSON.stringify(beltIds.map((beltId) =>
        active.belts.find((belt) => belt.id === beltId)!))));
    expect.soft(projection.base.totalProduced, "selective-item bounded production counters")
      .toEqual(JSON.parse(JSON.stringify(active.totalProduced)));
    expect.soft(projectedProducer.outputs.iron_ingot,
      "selective-item B does not steal ordinary output credit")
      .toBe(activeProducer.outputs.iron_ingot);
    expect.soft(projectedSharedSink.inputs.iron_ingot,
      "selective-item B does not steal shared target capacity")
      .toBe(activeSharedSink.inputs.iron_ingot);
    expect.soft(projectedEmptyIronBelt, "selective-item B stays clockless and unreserved")
      .toEqual(JSON.parse(JSON.stringify(activeEmptyIronBelt)));
    await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  }, 60_000);

  it("reclassifies a supported legacy ILS attachment at the five-second boundary without waking an unrelated legacy group", async () => {
    const initial = quantumAttachmentBeltActivityTransitionState();
    const transitionStationId = "native_quantum_transition_station";
    const dormantStationId = "native_unrelated_legacy_station";
    const transitionBeltId = "native_quantum_transition_output";
    const boundedEntityIds = [
      transitionStationId,
      "native_quantum_transition_sink",
      dormantStationId,
      "native_unrelated_legacy_sink",
    ];
    const boundedBeltIds = [
      transitionBeltId,
      "native_unrelated_legacy_output_000",
      "native_unrelated_legacy_output_095",
    ];
    const initialTransitionStation = initial.entities.find((entity) =>
      entity.id === transitionStationId)!;
    const initialDormantStation = initial.entities.find((entity) =>
      entity.id === dormantStationId)!;
    expect(initialTransitionStation, "quantum-transition fixture starts from the supported attach action")
      .toMatchObject({
        quantumMode: "transitioning",
        quantumTarget: undefined,
        quantumTransition: {
          targetMode: "quantum",
          startedAtSecond: 0,
          boundarySecond: 5,
          bridges: [],
        },
      });
    expect(initialDormantStation, "quantum-transition fixture has an unrelated stable legacy source")
      .toMatchObject({ quantumMode: "legacy", quantumTransition: null });
    expect(initial.belts, "quantum-transition fixture has one target route plus 96 dormant routes")
      .toHaveLength(97);
    expect(initial.belts.every((belt) =>
      belt.progress === 0 && belt.totalTransferred === 0 && belt.lastFlow === 0),
    "quantum-transition fixture has no persisted belt wake signal").toBe(true);

    const beforeBoundary = advanceSimulationBudget(initial, 4, 4);
    const beforeBoundaryStation = beforeBoundary.entities.find((entity) =>
      entity.id === transitionStationId)!;
    expect(beforeBoundaryStation.quantumMode, "attachment remains in handoff before second five")
      .toBe("transitioning");
    expect(beforeBoundaryStation.quantumTransition?.boundarySecond,
      "attachment owns the exact five-second settlement boundary").toBe(5);

    const boundaryOneShotExpected = advanceSimulationBudget(initial, 5, 5);
    let boundarySegmentedExpected = initial;
    for (let index = 0; index < 5; index += 1) {
      boundarySegmentedExpected = advanceSimulationBudget(boundarySegmentedExpected, 1, 1);
    }
    const boundaryOneShotFields = canonicalFields(boundaryOneShotExpected);
    const boundarySegmentedFields = canonicalFields(boundarySegmentedExpected);
    expect(Object.keys(boundaryOneShotFields).filter((field) =>
      boundaryOneShotFields[field] !== boundarySegmentedFields[field]),
    "quantum-transition JS active one-shot/segmented boundary differs only by sampling history")
      .toEqual(["productionHistory"]);
    const {
      productionHistory: _boundaryOneShotHistory,
      ...boundaryOneShotSemanticState
    } = boundaryOneShotExpected;
    const {
      productionHistory: _boundarySegmentedHistory,
      ...boundarySegmentedSemanticState
    } = boundarySegmentedExpected;
    expect(canonicalSha256(boundarySegmentedSemanticState),
      "quantum-transition JS active one-shot/segmented boundary semantic state")
      .toBe(canonicalSha256(boundaryOneShotSemanticState));
    const boundaryStation = boundaryOneShotExpected.entities.find((entity) =>
      entity.id === transitionStationId)!;
    const boundaryDormantStation = boundaryOneShotExpected.entities.find((entity) =>
      entity.id === dormantStationId)!;
    expect(boundaryStation, "attachment completes at second five")
      .toMatchObject({ quantumMode: "quantum", quantumTransition: null });
    expect(boundaryStation.quantumTarget, "attachment marker is consumed atomically").toBeUndefined();
    expect(boundaryOneShotExpected.quantumLogisticsNetwork.enabled,
      "completed attachment enables the quantum network").toBe(true);
    expect(boundaryDormantStation, "unrelated station never changes classification")
      .toMatchObject({ quantumMode: "legacy", quantumTransition: null });

    const finalOneShotExpected = advanceSimulationBudget(boundaryOneShotExpected, 1, 1);
    const finalSegmentedExpected = advanceSimulationBudget(boundarySegmentedExpected, 1, 1);
    const finalOneShotFields = canonicalFields(finalOneShotExpected);
    const finalSegmentedFields = canonicalFields(finalSegmentedExpected);
    expect(Object.keys(finalOneShotFields).filter((field) =>
      finalOneShotFields[field] !== finalSegmentedFields[field]),
    "quantum-transition JS active final fields differ only by sampling history")
      .toEqual(["productionHistory"]);
    const {
      productionHistory: _finalOneShotHistory,
      ...finalOneShotSemanticState
    } = finalOneShotExpected;
    const {
      productionHistory: _finalSegmentedHistory,
      ...finalSegmentedSemanticState
    } = finalSegmentedExpected;
    expect(canonicalSha256(finalSegmentedSemanticState),
      "quantum-transition JS active final visible state")
      .toBe(canonicalSha256(finalOneShotSemanticState));
    expect(finalOneShotExpected.belts.filter((belt) =>
      belt.source === dormantStationId).every((belt) =>
        belt.progress === 0 && belt.totalTransferred === 0 && belt.lastFlow === 0),
    "unrelated legacy source remains dormant after the quantum transition").toBe(true);

    const checkpoint = await seed(initial, 227);
    const assertSteadyQuantumScheduler = (label: string, advanced: any) => {
      expect(advanced.beltScheduler, `${label} sparse quantum scheduler`).toMatchObject({
        activeQueueEnabled: true,
        routeCount: initial.belts.length,
        groupCount: 2,
        fullScanPasses: 0,
        initializationGroupChecks: 0,
        carriedActiveGroups: 1,
      });
      const passes = advanced.beltScheduler.transferPasses +
        advanced.beltScheduler.reservationPasses;
      const routeChecks = advanced.beltScheduler.transferRouteChecks +
        advanced.beltScheduler.reservationRouteChecks;
      expect(passes, `${label} has real belt passes`).toBeGreaterThan(0);
      expect(advanced.beltScheduler.stableRoutesSkipped,
        `${label} skips only the 96-route unrelated legacy group`)
        .toBe(96 * passes);
      expect(routeChecks, `${label} keeps the empty quantum route always awake`)
        .toBe(passes);
    };

    const oneShotOpened = await open(checkpoint);
    const oneShotBoundary = await client.request({
      operation: "coreAdvance", sessionId: oneShotOpened.sessionId,
      request: { baseRevision: checkpoint.revision, simulationSeconds: 5, wallSeconds: 5 },
    });
    expect(oneShotBoundary.supported,
      `quantum-transition one-shot boundary: ${oneShotBoundary.reason ?? ""}`).toBe(true);
    expect(oneShotBoundary.summary.canonicalFields, "quantum-transition one-shot boundary fields")
      .toEqual(canonicalFields(boundaryOneShotExpected));
    expect(oneShotBoundary.summary.canonicalSha256, "quantum-transition one-shot boundary hash")
      .toBe(canonicalSha256(boundaryOneShotExpected));
    const oneShotSteady = await client.request({
      operation: "coreAdvance", sessionId: oneShotOpened.sessionId,
      request: {
        baseRevision: oneShotBoundary.revision,
        simulationSeconds: 1,
        wallSeconds: 1,
      },
    });
    expect(oneShotSteady.supported,
      `quantum-transition one-shot steady: ${oneShotSteady.reason ?? ""}`).toBe(true);
    assertSteadyQuantumScheduler("quantum-transition one-shot steady", oneShotSteady);
    expect(oneShotSteady.summary.canonicalFields, "quantum-transition one-shot final fields")
      .toEqual(canonicalFields(finalOneShotExpected));
    expect(oneShotSteady.summary.canonicalSha256, "quantum-transition one-shot final hash")
      .toBe(canonicalSha256(finalOneShotExpected));
    expect(oneShotSteady.summary.domainSha256, "quantum-transition one-shot final domain")
      .toBe(nativeCoreDomainSha256(finalOneShotExpected, oneShotSteady.revision));
    const oneShotProjection = await client.request({
      operation: "coreProjection", sessionId: oneShotOpened.sessionId,
      entityIds: boundedEntityIds,
      beltIds: boundedBeltIds,
      baseFields: ["quantumLogisticsNetwork"],
    });
    expect(oneShotProjection.entities, "quantum-transition one-shot bounded entities")
      .toEqual(rendererProjectedEntities(boundedEntityIds.map((entityId) =>
        finalOneShotExpected.entities.find((entity) => entity.id === entityId)!)));
    expect(oneShotProjection.belts, "quantum-transition one-shot bounded belts")
      .toEqual(JSON.parse(JSON.stringify(boundedBeltIds.map((beltId) =>
        finalOneShotExpected.belts.find((belt) => belt.id === beltId)!))));
    expect(oneShotProjection.base.quantumLogisticsNetwork,
      "quantum-transition one-shot quantum network")
      .toEqual(JSON.parse(JSON.stringify(finalOneShotExpected.quantumLogisticsNetwork)));
    await client.request({ operation: "coreClose", sessionId: oneShotOpened.sessionId });

    const segmentedOpened = await open(checkpoint);
    let segmentedExpected = initial;
    let segmentedRevision = checkpoint.revision;
    let segmentedBoundary: any = null;
    for (let index = 0; index < 5; index += 1) {
      segmentedExpected = advanceSimulationBudget(segmentedExpected, 1, 1);
      segmentedBoundary = await client.request({
        operation: "coreAdvance", sessionId: segmentedOpened.sessionId,
        request: { baseRevision: segmentedRevision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(segmentedBoundary.supported,
        `quantum-transition segmented boundary ${index + 1}: ${segmentedBoundary.reason ?? ""}`)
        .toBe(true);
      segmentedRevision = segmentedBoundary.revision;
      expect(segmentedBoundary.summary.canonicalFields,
        `quantum-transition segmented boundary ${index + 1} fields`)
        .toEqual(canonicalFields(segmentedExpected));
      expect(segmentedBoundary.summary.canonicalSha256,
        `quantum-transition segmented boundary ${index + 1} hash`)
        .toBe(canonicalSha256(segmentedExpected));
    }
    expect(Object.keys(oneShotBoundary.summary.canonicalFields).filter((field) =>
      oneShotBoundary.summary.canonicalFields[field] !==
        segmentedBoundary.summary.canonicalFields[field]),
    "quantum-transition native one-shot/segmented boundary fields")
      .toEqual(["productionHistory"]);
    expect(segmentedExpected.entities.find((entity) => entity.id === transitionStationId),
      "quantum-transition segmented session reaches quantum mode")
      .toMatchObject({ quantumMode: "quantum", quantumTransition: null });

    segmentedExpected = advanceSimulationBudget(segmentedExpected, 1, 1);
    const segmentedSteady = await client.request({
      operation: "coreAdvance", sessionId: segmentedOpened.sessionId,
      request: { baseRevision: segmentedRevision, simulationSeconds: 1, wallSeconds: 1 },
    });
    expect(segmentedSteady.supported,
      `quantum-transition segmented steady: ${segmentedSteady.reason ?? ""}`).toBe(true);
    assertSteadyQuantumScheduler("quantum-transition segmented steady", segmentedSteady);
    expect(segmentedSteady.beltScheduler,
      "quantum-transition steady scheduler is segmentation invariant")
      .toEqual(oneShotSteady.beltScheduler);
    expect(segmentedSteady.summary.canonicalFields, "quantum-transition segmented final fields")
      .toEqual(canonicalFields(segmentedExpected));
    expect(segmentedSteady.summary.canonicalSha256, "quantum-transition segmented final hash")
      .toBe(canonicalSha256(segmentedExpected));
    expect(Object.keys(oneShotSteady.summary.canonicalFields).filter((field) =>
      oneShotSteady.summary.canonicalFields[field] !== segmentedSteady.summary.canonicalFields[field]),
    "quantum-transition native one-shot/segmented final fields")
      .toEqual(["productionHistory"]);
    expect(segmentedSteady.summary.domainSha256, "quantum-transition segmented final domain")
      .toBe(nativeCoreDomainSha256(segmentedExpected, segmentedSteady.revision));
    const segmentedProjection = await client.request({
      operation: "coreProjection", sessionId: segmentedOpened.sessionId,
      entityIds: boundedEntityIds,
      beltIds: boundedBeltIds,
      baseFields: ["quantumLogisticsNetwork"],
    });
    expect(segmentedProjection.entities, "quantum-transition segmented bounded entities")
      .toEqual(oneShotProjection.entities);
    expect(segmentedProjection.belts, "quantum-transition segmented bounded belts")
      .toEqual(oneShotProjection.belts);
    expect(segmentedProjection.base.quantumLogisticsNetwork,
      "quantum-transition segmented quantum network")
      .toEqual(oneShotProjection.base.quantumLogisticsNetwork);
    await client.request({ operation: "coreClose", sessionId: segmentedOpened.sessionId });
  }, 90_000);

  it("puts an empty elevator source to sleep after the supported elevator-to-legacy boundary", async () => {
    const initial = elevatorToLegacyBeltActivityTransitionState();
    const stationId = "native_elevator_transition_station";
    const dormantStationId = "native_unrelated_legacy_station";
    const sourceBeltId = "native_elevator_transition_output";
    const boundedEntityIds = [stationId, dormantStationId];
    const boundedBeltIds = [
      sourceBeltId,
      "native_unrelated_legacy_output_000",
      "native_unrelated_legacy_output_095",
    ];
    expect(initial.entities.find((entity) => entity.id === stationId),
      "elevator-transition fixture uses the public reverse action")
      .toMatchObject({
        stationOperationMode: "elevator",
        stationModeTransition: "to-legacy",
        quantumMode: "legacy",
        quantumTransition: null,
      });
    expect(initial.belts, "elevator-transition fixture has one target route plus 96 dormant routes")
      .toHaveLength(97);
    expect(initial.belts.find((belt) => belt.id === sourceBeltId),
      "elevator source route retains its real output-port binding during handoff")
      .toMatchObject({ elevatorOutputIndex: 0, progress: 0, totalTransferred: 0, lastFlow: 0 });

    const beforeBoundary = advanceSimulationBudget(initial, 4, 4);
    expect(beforeBoundary.entities.find((entity) => entity.id === stationId),
      "elevator mode remains authoritative before second five")
      .toMatchObject({ stationOperationMode: "elevator", stationModeTransition: "to-legacy" });

    const checkpoint = await seed(initial, 228);
    const semanticState = (state: GameState) => {
      const { productionHistory: _history, ...semantic } = state;
      return semantic;
    };
    const assertSleepingScheduler = (label: string, advanced: any) => {
      expect(advanced.beltScheduler, `${label} carried empty legacy scheduler`).toMatchObject({
        activeQueueEnabled: true,
        routeCount: initial.belts.length,
        groupCount: 2,
        fullScanPasses: 0,
        initializationGroupChecks: 0,
        carriedActiveGroups: 0,
      });
      const passes = advanced.beltScheduler.transferPasses +
        advanced.beltScheduler.reservationPasses;
      const routeChecks = advanced.beltScheduler.transferRouteChecks +
        advanced.beltScheduler.reservationRouteChecks;
      expect(passes, `${label} has real belt passes`).toBeGreaterThan(0);
      expect(advanced.beltScheduler.stableRoutesSkipped,
        `${label} skips both empty legacy source groups`).toBe(initial.belts.length * passes);
      expect(routeChecks, `${label} performs no route work for empty legacy sources`).toBe(0);
    };
    const run = async (label: string, steps: readonly number[]) => {
      const opened = await open(checkpoint);
      let expected = initial;
      let revision = checkpoint.revision;
      let boundary: any = null;
      for (const seconds of steps) {
        expected = advanceSimulationBudget(expected, seconds, seconds);
        boundary = await client.request({
          operation: "coreAdvance", sessionId: opened.sessionId,
          request: { baseRevision: revision, simulationSeconds: seconds, wallSeconds: seconds },
        });
        expect(boundary.supported, `${label} boundary: ${boundary.reason ?? ""}`).toBe(true);
        expect(boundary.summary.canonicalFields, `${label} boundary fields`)
          .toEqual(canonicalFields(expected));
        expect(boundary.summary.canonicalSha256, `${label} boundary hash`)
          .toBe(canonicalSha256(expected));
        revision = boundary.revision;
      }
      expect(expected.entities.find((entity) => entity.id === stationId),
        `${label} completes the supported reverse transition`)
        .toMatchObject({ stationOperationMode: "legacy", stationModeTransition: null });
      expected = advanceSimulationBudget(expected, 1, 1);
      const steady = await client.request({
        operation: "coreAdvance", sessionId: opened.sessionId,
        request: { baseRevision: revision, simulationSeconds: 1, wallSeconds: 1 },
      });
      expect(steady.supported, `${label} steady: ${steady.reason ?? ""}`).toBe(true);
      assertSleepingScheduler(`${label} steady`, steady);
      expect(steady.summary.canonicalFields, `${label} steady fields`)
        .toEqual(canonicalFields(expected));
      expect(steady.summary.canonicalSha256, `${label} steady hash`)
        .toBe(canonicalSha256(expected));
      expect(steady.summary.domainSha256, `${label} steady domain`)
        .toBe(nativeCoreDomainSha256(expected, steady.revision));
      expect(expected.belts.every((belt) =>
        belt.progress === 0 && belt.totalTransferred === 0 && belt.lastFlow === 0),
      `${label} leaves every empty legacy route asleep`).toBe(true);
      const projection = await client.request({
        operation: "coreProjection", sessionId: opened.sessionId,
        entityIds: boundedEntityIds,
        beltIds: boundedBeltIds,
        baseFields: [],
      });
      expect(projection.entities, `${label} bounded entities`)
        .toEqual(rendererProjectedEntities(boundedEntityIds.map((entityId) =>
          expected.entities.find((entity) => entity.id === entityId)!)));
      expect(projection.belts, `${label} bounded belts`)
        .toEqual(JSON.parse(JSON.stringify(boundedBeltIds.map((beltId) =>
          expected.belts.find((belt) => belt.id === beltId)!))));
      await client.request({ operation: "coreClose", sessionId: opened.sessionId });
      return { boundary, steady, expected, projection };
    };

    const oneShot = await run("elevator-transition-one-shot", [5]);
    const segmented = await run("elevator-transition-segmented", [1, 1, 1, 1, 1]);
    expect(canonicalSha256(semanticState(segmented.expected)),
      "elevator-transition one-shot/segmented final semantic state")
      .toBe(canonicalSha256(semanticState(oneShot.expected)));
    expect(Object.keys(oneShot.steady.summary.canonicalFields).filter((field) =>
      oneShot.steady.summary.canonicalFields[field] !== segmented.steady.summary.canonicalFields[field]),
    "elevator-transition one-shot/segmented fields differ only by sampling history")
      .toEqual(["productionHistory"]);
    expect(segmented.steady.beltScheduler,
      "elevator-transition next-revision scheduler is segmentation invariant")
      .toEqual(oneShot.steady.beltScheduler);
    expect(segmented.projection.entities, "elevator-transition final visible entities")
      .toEqual(oneShot.projection.entities);
    expect(segmented.projection.belts, "elevator-transition final visible belts")
      .toEqual(oneShot.projection.belts);
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
    10 * 60_000,
  );
});
