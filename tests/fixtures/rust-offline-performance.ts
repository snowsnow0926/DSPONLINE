import { createInitialState, placeBuilding, setEntityRecipe, setStationSlotItem, setStationSlotMode, connectBelt, advanceSimulation, advanceSimulationBudget } from "../../src/game/engine";
import { migrateGame, serializeEnvelope, inspectSave } from "../../src/game/storage";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "../../src/game/contentPacks";
import { createNativeCoreCatalog } from "../../src/game/nativeCoreCatalog";
import { createNativeCoreRevisionProof } from "../../src/game/nativeCoreProof";
import { buildChunkedSaveJournal, streamChunkedSaveJournalFromRuntimeState } from "../../src/game/chunkedSaveJournal";
import { projectPersistentSaveState } from "../../src/game/saveProjection";
import { runFastOfflineSettlement, runFastOfflineSettlementAsync, runConservativeOfflineSettlement } from "../../src/game/offlineApproximation";
import { classifyOfflineWorkload } from "../../src/game/offlineComplexity";
import type { FactoryEntity, GameState } from "../../src/game/types";

export const SAVED_AT = 1_800_000_000_000;
export const runtime = createContentPackRuntimeSnapshot(createContentPackRegistry());
export const catalog = createNativeCoreCatalog(runtime);

/** Public engine-created templates; synthetic inventories, never player data. */
export function createRustOfflineFixture(tiles: number, activeFraction = 1, quantum = false, sourceKind: "buffer" | "vein" = "buffer") {
  if (!Number.isSafeInteger(tiles) || tiles < 1 || tiles > 10000 || activeFraction < 0 || activeFraction > 1) throw new Error("Invalid synthetic factory size");
  let state = createInitialState();
  state.construction.storage_mk1 = 10;
  state.construction.arc_smelter = 10;
  state.construction.wind_turbine = 10;
  state.construction.conveyor_belt_mk1 = 50;
  const natural = state.entities;
  const veinTemplate = natural.find(entity => entity.id === "vein_iron")!;
  state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
  state = placeBuilding(state, "arc_smelter", { x: 400, y: 0 });
  state = placeBuilding(state, "wind_turbine", { x: 0, y: -300 });
  const storage = state.entities.find(entity => entity.buildingId === "storage_mk1")!;
  const machine = state.entities.find(entity => entity.buildingId === "arc_smelter")!;
  const power = state.entities.find(entity => entity.buildingId === "wind_turbine")!;
  state = setEntityRecipe(state, machine.id, "iron_ingot");
  state = connectBelt(state, "vein_iron", machine.id, "iron_ore");
  const beltTemplate = state.belts[0];
  if (!storage || !machine || !power || !beltTemplate) throw new Error("Public engine fixture template unavailable");
  const machineTemplate = state.entities.find(entity => entity.id === machine.id)!;
  state.entities = [...natural, { ...power, id: "rp_power", machineCount: tiles * 16 }];
  state.belts = [];
  const activeTiles = Math.ceil(tiles * activeFraction);
  for (let tile = 0; tile < tiles; tile++) {
    const baseX = (tile % 50) * 2200;
    const baseY = Math.floor(tile / 50) * 1400;
    const clone = (template: FactoryEntity, suffix: string, x: number, y: number): FactoryEntity => ({
      ...structuredClone(template), id: `rp_${tile}_${suffix}`, position: { x: baseX + x, y: baseY + y }, inputs: {}, outputs: {},
    });
    const source = clone(sourceKind === "buffer" ? storage : veinTemplate, "source", 0, 400);
    if (sourceKind === "buffer") {
      source.machineCount = 500;
      source.storedItemId = "iron_ore";
      source.outputs.iron_ore = tile < activeTiles ? 200000 : 0;
    } else {
      source.minerCount = tile < activeTiles ? 8 : 0;
      source.resourceCapacity = 2_000_000;
      source.resourceRemaining = 2_000_000;
      source.outputs.iron_ore = 0;
    }
    state.entities.push(source);
    const machines: FactoryEntity[] = [];
    const sinks: FactoryEntity[] = [];
    for (let index = 0; index < 4; index++) {
      const nextMachine = clone(machineTemplate, `machine_${index}`, 700, index * 300);
      const sink = clone(storage, `sink_${index}`, 1500, index * 300);
      sink.machineCount = 500;
      sink.storedItemId = "iron_ingot";
      machines.push(nextMachine); sinks.push(sink);
      state.entities.push(nextMachine, sink);
    }
    const connect = (from: FactoryEntity, to: FactoryEntity, itemId: "iron_ore" | "iron_ingot") => state.belts.push({
      ...structuredClone(beltTemplate), id: `rp_belt_${state.belts.length}`, source: from.id, target: to.id, itemId,
    });
    for (const nextMachine of machines) {
      connect(source, nextMachine, "iron_ore");
      for (const sink of sinks) connect(nextMachine, sink, "iron_ingot");
    }
  }
  state.nextId = 1_000_000;
  state.paused = false;
  state.settings.autosaveIntervalSeconds = 0;
  state.quantumLogisticsNetwork.enabled = quantum;
  if (quantum) state.quantumLogisticsNetwork.itemCapacities = { iron_ore: "10000000000", iron_ingot: "10000000000" };
  state.galaxy.planetMetadata.home = { customName: `RP0 合成工厂 ${tiles} / ${activeFraction} / ${quantum ? "quantum" : "ordinary"} / ${sourceKind}`, note: "Synthetic public-catalog fixture; no player data", tags: ["rust-performance"] };
  state = migrateGame(state)!;
  state.achievements.unlockedIds = ["first_logistics_line"];
  state.orbitalStation.contractBoard.lastConfirmedWallClockMs = SAVED_AT;
  return state;
}

/** A second, explicitly quantum topology; the ordinary fixtures remain negative controls. */
export function createQuantumProductionFixture(tiles: number) {
  let state = createInitialState();
  state.research.completedTechIds.push("interstellar_logistics", "quantum_logistics_network");
  state.quantumLogisticsNetwork.enabled = true;
  state.quantumLogisticsNetwork.itemCapacities = { iron_ore: "10000000000", iron_ingot: "10000000000" };
  state.construction.interstellar_logistics_station = 1;
  state.construction.arc_smelter = 1;
  state.construction.wind_turbine = 1;
  state.construction.conveyor_belt_mk1 = 20;
  state = placeBuilding(state, "wind_turbine", { x: 0, y: -300 });
  state = placeBuilding(state, "arc_smelter", { x: 400, y: 0 });
  state = placeBuilding(state, "interstellar_logistics_station", { x: 800, y: 0 });
  const machineId = state.entities.find(e => e.buildingId === "arc_smelter")!.id;
  const stationId = state.entities.find(e => e.buildingId === "interstellar_logistics_station")!.id;
  state = setEntityRecipe(state, machineId, "iron_ingot");
  state = setStationSlotItem(state, stationId, 0, "iron_ingot");
  state = setStationSlotMode(state, stationId, 0, "remote", "supply");
  state = connectBelt(state, "vein_iron", machineId, "iron_ore");
  state = connectBelt(state, machineId, stationId, "iron_ingot");
  const vein = state.entities.find(e => e.id === "vein_iron")!;
  vein.minerCount = 2;
  vein.resourceCapacity = vein.resourceRemaining = 2_000_000;
  const machine = state.entities.find(e => e.id === machineId)!;
  const station = state.entities.find(e => e.id === stationId)!;
  station.stationTier = 2;
  station.quantumMode = "quantum";
  station.stationDrones = station.stationVessels = 0;
  const templates = [vein, machine, station];
  const belts = state.belts;
  if (belts.length !== 2) throw new Error("Quantum production belt templates missing");
  state.entities = state.entities.filter(e => !templates.some(t => t.id === e.id));
  state.entities.find(e => e.buildingId === "wind_turbine")!.machineCount = tiles * 100;
  state.belts = [];
  for (let tile = 0; tile < tiles; tile++) {
    for (const e of templates) state.entities.push({ ...structuredClone(e), id: `quantum_${tile}_${e.id}`, position: { x: tile % 50 * 1400 + e.position.x, y: Math.floor(tile / 50) * 800 } });
    for (const b of belts) state.belts.push({ ...structuredClone(b), id: `quantum_${tile}_${b.id}`, source: `quantum_${tile}_${b.source}`, target: `quantum_${tile}_${b.target}` });
  }
  state.nextId = 1_000_000;
  state.paused = false;
  state.constructionAutomation.enabled = false;
  state.settings.autosaveIntervalSeconds = 0;
  state = advanceSimulation(state, 30);
  state = migrateGame(state)!;
  state.orbitalStation.contractBoard.lastConfirmedWallClockMs = SAVED_AT;
  return state;
}

export { serializeEnvelope, inspectSave, migrateGame, buildChunkedSaveJournal, streamChunkedSaveJournalFromRuntimeState, projectPersistentSaveState, createNativeCoreRevisionProof,
  advanceSimulationBudget, runFastOfflineSettlement, runFastOfflineSettlementAsync, runConservativeOfflineSettlement, classifyOfflineWorkload };
export type { GameState };
