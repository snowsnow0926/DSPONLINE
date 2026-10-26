import { describe, expect, it } from "vitest";
import { TECHNOLOGIES } from "./content";
import { advanceConstructionAutomationMacroInPlace, createInitialState, createSimulationLookupContext } from "./engine";
import type { BeltConnection, FactoryEntity } from "./types";

// Explicit local benchmark: no player data and no timing threshold in CI.
describe.skipIf(process.env.DSP_CONSTRUCTION_ENDGAME_BENCHMARK !== "1")("endgame construction domain benchmark", () => {
  it("measures certified construction independently of a 100 MiB factory graph", { timeout: 120_000 }, () => {
    const state = createInitialState(20261026, false);
    state.research.completedTechIds = Object.values(TECHNOLOGIES).map((technology) => technology.id);
    state.tray = {};
    state.planetTrays.home = state.tray;
    state.construction.arc_smelter = 0;
    state.constructionAutomation.enabled = true;
    state.constructionAutomation.quantumSourceEnabled = true;
    state.constructionAutomation.targetStock = { arc_smelter: 1_000_000 };
    state.quantumLogisticsNetwork.enabled = true;
    state.quantumLogisticsNetwork.inventory = { iron_ore: "10000000", copper_ore: "10000000", stone: "10000000" };
    const storage: FactoryEntity = {
      id: "benchmark-storage-999999", kind: "storage", planetId: "home",
      buildingId: "storage_mk1", position: { x: 0, y: 0 }, interactionLocked: false,
      inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
      routingCursor: 0, machineCount: 1, minerCount: 0,
    };
    const belt: BeltConnection = {
      id: "benchmark-belt-999999", source: "benchmark-storage-999999", target: "benchmark-storage-999998",
      itemId: "iron_ore", planetId: "home", tier: 1, sorterTier: 1, lanes: 1,
      progress: 0, priority: 1, lastFlow: 0, totalTransferred: 0,
    };
    const count = Math.ceil(105 * 1024 * 1024 / (JSON.stringify(storage).length + 2 * JSON.stringify(belt).length));
    state.entities = Array.from({ length: count }, (_, index) => ({
      ...storage, id: `benchmark-storage-${index}`, inputs: {}, outputs: {},
    }));
    state.entities.push({ ...storage, id: "benchmark-center", kind: "machine", buildingId: "construction_center", machineCount: 100 });
    state.belts = Array.from({ length: count * 2 }, (_, index) => ({
      ...belt, id: `benchmark-belt-${index}`, source: `benchmark-storage-${index % count}`,
      target: `benchmark-storage-${(index + 1) % count}`,
    }));
    const bytes = Buffer.byteLength(JSON.stringify(state));
    expect(bytes).toBeGreaterThan(100 * 1024 * 1024);
    const lookupStart = performance.now();
    const fullLookup = createSimulationLookupContext(state);
    const fullLookupMs = performance.now() - lookupStart;
    expect(fullLookup.beltById.size).toBe(state.belts.length);
    const domainStart = performance.now();
    const result = advanceConstructionAutomationMacroInPlace(state, 30, {
      powerFactorByCenterId: new Map([["benchmark-center", 1]]),
      quantumDownloadPerBoundary: 100_000, quantumTimelineStartSeconds: 0, quantumReplaySeconds: 30,
    });
    const constructionDomainMs = performance.now() - domainStart;
    expect(result.completed).toBeGreaterThan(0);
    expect(state.entities[0].outputs).toEqual({});
    expect(state.belts[0].totalTransferred).toBe(0);
    console.log(`CONSTRUCTION_ENDGAME_BENCHMARK ${JSON.stringify({
      bytes, entityCount: state.entities.length, beltCount: state.belts.length,
      fullLookupMs, constructionDomainMs, completed: result.completed,
    })}`);
  });
});
