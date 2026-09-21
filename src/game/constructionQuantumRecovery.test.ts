import { describe, expect, it } from "vitest";
import { CONSTRUCTION, TECHNOLOGIES } from "./content";
import {
  advancePersistentSimulationRuntime, createPersistentSimulationRuntime, createPlayerInitialState,
  getConstructionAutomationStatus, getConstructionQuantumDeliveryStatus, setConstructionAutomationTarget,
} from "./engine";
import { exportGame, migrateGame } from "./storage";
import type { GameState, ItemId } from "./types";

const direct = { iron_ingot: "4", stone_brick: "2", circuit_board: "4", magnetic_coil: "2" };
function factory(inventory: Partial<Record<ItemId, string>>): GameState {
  const s = createPlayerInitialState();
  s.entities = []; s.belts = []; s.tray = {}; s.planetTrays.home = s.tray;
  s.research.completedTechIds = Object.values(TECHNOLOGIES).map(t => t.id);
  s.construction.arc_smelter = 0;
  s.constructionAutomation = { enabled: true, quantumSourceEnabled: true, targetStock: { arc_smelter: 1 }, jobs: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {} };
  s.quantumLogisticsNetwork.enabled = true; s.quantumLogisticsNetwork.inventory = { ...inventory };
  const base = { planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false, inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0 } as const;
  s.entities.push(
    { ...base, id: "entity_1", kind: "machine", buildingId: "construction_center" },
    { ...base, id: "entity_2", kind: "station", buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "quantum", stationSlots: [], stationRoutes: [] },
    { ...base, id: "entity_3", kind: "power", buildingId: "wind_turbine", machineCount: 10000 },
  );
  return s;
}
function run(state: GameState, seconds = 30) {
  const runtime = createPersistentSimulationRuntime(state);
  for (let i = 0; i < seconds; i += 1) advancePersistentSimulationRuntime(runtime, 1, 1);
  return runtime.state;
}

describe("construction quantum recovery in the persistent Web runtime", () => {
  it("distinguishes warehouse stock, missing infrastructure, and actual delivery receipts", () => {
    const s = factory({ water: "1000000", hydrogen: "1000000" });
    s.constructionAutomation.targetStock = { geothermal_power_station: 1 }; s.construction.geothermal_power_station = 0;
    s.tray = { steel: 23, titanium_ingot: 8, refined_oil: 24, stone: 32, processor: 4 }; s.planetTrays.home = s.tray;
    expect(getConstructionAutomationStatus(s, "entity_1").missingItemId).toBe("water");
    expect(getConstructionQuantumDeliveryStatus(s, "entity_1")).toMatchObject({ state: "waiting-boundary", itemId: "water", warehouseAmount: "1000000" });
    s.entities[1].stationSlots = [{ itemId: "hydrogen", localMode: "storage", remoteMode: "demand", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 2, routePolicy: "direct", warperBudget: 2 }];
    const waiting = run(structuredClone(s), 5);
    expect(getConstructionQuantumDeliveryStatus(waiting, "entity_1")).toMatchObject({ state: "waiting-allocation", itemId: "water", requested: 16, delivered: 0, warehouseAmount: "1000000", boundarySecond: 5 });
    const noTower = structuredClone(s); noTower.entities[1].quantumMode = "legacy";
    expect(getConstructionQuantumDeliveryStatus(run(noTower, 5), "entity_1").state).toBe("no-bandwidth");
    s.entities[1].stationSlots = [];
    const delivered = run(structuredClone(s), 5);
    expect(getConstructionQuantumDeliveryStatus(delivered, "entity_1")).toMatchObject({ state: "received", requested: 16, delivered: 16, bufferAmount: 16 });
    const exported = JSON.parse(exportGame(delivered)).state;
    expect(exported.quantumLogisticsNetwork.runtimeFlow).toBeUndefined();
    s.quantumLogisticsNetwork.inventory.water = "0";
    expect(getConstructionQuantumDeliveryStatus(run(s, 5), "entity_1").state).toBe("missing-stock");
  });
  it("delivers water even when a high-priority tower keeps requesting absent hydrogen", () => {
    const s = factory({ water: "1000000" });
    s.constructionAutomation.targetStock = { geothermal_power_station: 1 }; s.construction.geothermal_power_station = 0;
    s.tray = { steel: 23, titanium_ingot: 8, refined_oil: 24, stone: 32, processor: 4 }; s.planetTrays.home = s.tray;
    s.entities[1].stationSlots = [{ itemId: "hydrogen", localMode: "storage", remoteMode: "demand", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 2, routePolicy: "direct", warperBudget: 2 }];
    const end = run(s);
    expect(end.construction.geothermal_power_station).toBe(1);
    expect(end.quantumLogisticsNetwork.inventory.water).toBe("999984");
  });

  it("uses finished ingredients in the shared warehouse for a new job", () => {
    const s = factory(direct); const end = run(s);
    expect(end.construction.arc_smelter).toBe(1);
    expect(Object.values(end.quantumLogisticsNetwork.inventory).every(n => n === "0")).toBe(true);
    expect(Object.values(end.constructionAutomation.quantumMaterialBuffer ?? {})).toEqual([]);
  });

  it("combines partial finished stock with recursively manufacturable raw materials", () => {
    const s = factory({ iron_ingot: "4", iron_ore: "6", copper_ore: "3", stone: "2" });
    expect(run(s).construction.arc_smelter).toBe(1);
  });

  it("does not treat another center's reservation as available material", () => {
    const s = factory(direct); const second = { ...structuredClone(s.entities[0]), id: "entity_4" }; s.entities.push(second);
    s.constructionAutomation.targetStock.arc_smelter = 2;
    const end = run(s);
    expect(end.construction.arc_smelter).toBe(1);
    // After the scarce first batch, replenishment must resume without resetting jobs.
    end.quantumLogisticsNetwork.inventory = { ...direct };
    expect(run(end).construction.arc_smelter).toBe(2);
  });

  it("finishes one scarce batch before spreading a bandwidth-limited reservation across centers", () => {
    const ingredients = CONSTRUCTION.find(d => d.buildingId === "construction_center")!.costs;
    const s = factory(Object.fromEntries(ingredients.map(c => [c.itemId, String(c.amount)])));
    s.construction.construction_center = 0;
    s.constructionAutomation.targetStock = { construction_center: 1 };
    s.entities.push({ ...structuredClone(s.entities[0]), id: "entity_4" });
    const end = run(s, 300);
    expect(end.construction.construction_center).toBe(1);
    expect(Object.values(end.quantumLogisticsNetwork.inventory).every(n => n === "0")).toBe(true);
  });

  it("repairs a legacy raw-material suffix after real intermediates are delivered", () => {
    const s = factory(direct);
    s.constructionAutomation.jobs.entity_1 = { constructionId: "arc_smelter", inventory: {}, elapsedSeconds: 0, stepIndex: 0, steps: [
      { kind: "material", recipeId: "iron_ingot", batches: 4, outputItemId: "iron_ingot", outputAmount: 4 },
      { kind: "building", constructionId: "arc_smelter" },
    ] };
    expect(run(s).construction.arc_smelter).toBe(1);
  });

  it("keeps direct delivery opt-in", () => {
    const s = factory(direct); s.constructionAutomation.quantumSourceEnabled = false;
    const end = run(s);
    expect(end.construction.arc_smelter).toBe(0); expect(end.quantumLogisticsNetwork.inventory).toEqual(direct);
  });

  it("tries a later ready target while preserving the earlier blocked target", () => {
    const s = factory({}); s.constructionAutomation.quantumSourceEnabled = false;
    s.constructionAutomation.targetStock = { arc_smelter: 1, plane_smelter: 1 };
    s.construction.plane_smelter = 0;
    s.constructionAutomation.cursor = CONSTRUCTION.findIndex(d => d.buildingId === "arc_smelter");
    s.tray = Object.fromEntries(CONSTRUCTION.find(d => d.buildingId === "plane_smelter")!.costs.map(c => [c.itemId, c.amount])); s.planetTrays.home = s.tray;
    const end = run(s);
    expect(end.construction.plane_smelter).toBe(1); expect(end.construction.arc_smelter).toBe(0);
    expect(end.constructionAutomation.targetStock.arc_smelter).toBe(1);
    end.tray = Object.fromEntries(Object.entries(direct).map(([id, n]) => [id, Number(n)])); end.planetTrays.home = end.tray;
    expect(run(end).construction.arc_smelter).toBe(1);
  });

  it("selects a warehouse-backed target after an earlier target is missing raw stock", () => {
    const s = factory({}); s.constructionAutomation.targetStock = { arc_smelter: 1, plane_smelter: 1 }; s.construction.plane_smelter = 0;
    s.quantumLogisticsNetwork.inventory = Object.fromEntries(CONSTRUCTION.find(d => d.buildingId === "plane_smelter")!.costs.map(c => [c.itemId, String(c.amount)]));
    expect(run(s).construction.plane_smelter).toBe(1);
  });

  it("preserves a received partial cache and fairness position across save/reload", () => {
    const s = factory({ iron_ore: "10", copper_ore: "3" });
    const partial = run(s, 5); partial.quantumLogisticsNetwork.downloadCursor = 7;
    const loaded = migrateGame(JSON.parse(exportGame(partial)).state)!;
    expect(loaded.quantumLogisticsNetwork.downloadCursor).toBe(7);
    expect(loaded.constructionAutomation.quantumMaterialBuffer).toEqual(partial.constructionAutomation.quantumMaterialBuffer);
    loaded.quantumLogisticsNetwork.inventory.stone = "2";
    expect(run(loaded).construction.arc_smelter).toBe(1);
  });

  it("returns unconsumed direct ingredients on cancellation without duplicating them", () => {
    const delivered = run(factory(direct), 5);
    const cancelled = setConstructionAutomationTarget(delivered, "arc_smelter", 0);
    expect(cancelled.quantumLogisticsNetwork.inventory).toMatchObject(direct);
    expect(cancelled.constructionAutomation.quantumMaterialBuffer).toBeUndefined();
    expect(cancelled.construction.arc_smelter).toBe(0);
  });
});
