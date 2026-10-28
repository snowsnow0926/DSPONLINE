import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSTRUCTION, RECIPES, TECHNOLOGIES } from "./content";
import { advancePersistentSimulationRuntime, createInitialState, createPersistentSimulationRuntime } from "./engine";
import type { GameState } from "./types";

const cases = ["scarce-centers", "later-target", "late-advanced", "stopped", "legacy-suffix"] as const;
type Scenario = typeof cases[number];
// Captured before context sharing from fcf7250d, engine SHA-256 3ff5703d0c371033...
// These hashes cover the full JSON state at 5/10/30 seconds, not a field subset.
const golden: Record<Scenario, { hashes: string[]; catalogReads: number[] }> = {
  "scarce-centers": { hashes: [
    "583c1dab73af845e1073837c86960315a6c594f7bffc09c421c5c0002732eb13",
    "9a988dbd0d1ab4f8d800fd24e2b8c7911bce9ba6e9376688850e1134924a52eb",
    "ed5e33dd7d308bcc941a873c2863691ee415bff18d29ab5b08b0d850c0f01d0c",
  ], catalogReads: [23, 52, 156] },
  "later-target": { hashes: [
    "da318e3a4e6930433ac098d6e683718a7c608adb68b717fee6ab51893dfee14b",
    "dc48218967300fe7d753d8cb202f4862e6fd9f81afc99767eb2b8630906cd79e",
    "ac6ead1c07859dae01f01ba7249abc8568462ffb0049ba88246ebe25e434187b",
  ], catalogReads: [8, 21, 71] },
  "late-advanced": { hashes: [
    "037812437ddd07115483efcbe9dd15e338459faaf030090bc84f7013769deb07",
    "e6875bf4f70b91a8b1a602fe9fec014538bd6010b647603e2a27eea0c0bb65f6",
    "ed43d2c8aff2b6fb707394ec61712dc7da4299705524d42aa8842a1f2564505b",
  ], catalogReads: [5, 12, 32] },
  stopped: { hashes: [
    "192dc120cbc47de4f5e832435d95ec934a64d7d97efd7edd66055f78449b5159",
    "8698aa1f18e4c35c2746120c6849293215e1ab0f454b80463c50d3764c3c1659",
    "5eaf5cc9547d0a00c88aa965ce0b3e39c5d318dfa1a1ddfc9bde2d037a0eed02",
  ], catalogReads: [0, 0, 0] },
  "legacy-suffix": { hashes: [
    "0e7ff6a7888818f80f034933c6e3cda057316bfa201aec58a26cf4f373a77752",
    "4d9ac132a68620c305c473524f9648e0d42d25eb4923fa48367d6f3a31a008c4",
    "d03f2609c4c67c99aa6c3082ef318a035a24ca6260fa2fc43ac1f7517f428400",
  ], catalogReads: [6, 11, 31] },
};
const direct = { iron_ingot: "4", stone_brick: "2", circuit_board: "4", magnetic_coil: "2" };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture(name: Scenario): GameState {
  const state = createInitialState(20_261_028, false);
  state.entities = [];
  state.belts = [];
  state.tray = {};
  state.planetTrays.home = state.tray;
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as GameState["research"]["completedTechIds"];
  state.construction.arc_smelter = 0;
  state.constructionAutomation = { enabled: true, quantumSourceEnabled: true, targetStock: { arc_smelter: 1 },
    jobs: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {} };
  state.quantumLogisticsNetwork.enabled = true;
  state.quantumLogisticsNetwork.inventory = { ...direct };
  const base = { planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false, inputs: {}, outputs: {},
    progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0 } as const;
  state.entities.push(
    { ...base, id: "center-a", kind: "machine", buildingId: "construction_center" },
    { ...base, id: "tower", kind: "station", buildingId: "interstellar_logistics_station", stationTier: 2,
      quantumMode: "quantum", stationSlots: [], stationRoutes: [] },
    { ...base, id: "power", kind: "power", buildingId: "wind_turbine", machineCount: 10_000 },
  );
  if (name === "scarce-centers" || name === "stopped") {
    state.entities.push(...["center-b", "center-c"].map(id => ({ ...structuredClone(state.entities[0]), id })));
    state.constructionAutomation.targetStock.arc_smelter = 3;
  }
  if (name === "later-target") {
    state.construction.plane_smelter = 0;
    state.constructionAutomation.targetStock = { arc_smelter: 1, plane_smelter: 1 };
    state.quantumLogisticsNetwork.inventory = Object.fromEntries(CONSTRUCTION.find(d => d.buildingId === "plane_smelter")!.costs.map(c => [c.itemId, String(c.amount)]));
  }
  if (name === "late-advanced") {
    state.construction.ray_receiver = 0;
    state.constructionAutomation.targetStock = { ray_receiver: 1 };
    state.tray = { steel: 60, high_purity_silicon: 60, processor: 15, circuit_board: 30, prism: 60 };
    state.planetTrays.home = state.tray;
    state.quantumLogisticsNetwork.inventory = {};
  }
  if (name === "stopped") state.constructionAutomation.enabled = false;
  if (name === "legacy-suffix") state.constructionAutomation.jobs["center-a"] = {
    constructionId: "arc_smelter", inventory: {}, elapsedSeconds: 0, stepIndex: 0,
    steps: [{ kind: "material", recipeId: "iron_ingot", batches: 4, outputItemId: "iron_ingot", outputAmount: 4 },
      { kind: "building", constructionId: "arc_smelter" }],
  };
  return state;
}

describe("quantum demand planning preserves the pre-sharing full-state golden", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(cases)("preserves complete records and live supply for %s", (name) => {
    const state = fixture(name);
    const values = Object.values;
    let reads = 0;
    vi.spyOn(Object, "values").mockImplementation(value => {
      if (value === RECIPES) reads++;
      return values(value);
    });
    const runtime = createPersistentSimulationRuntime(state);
    const row = { hashes: [] as string[], catalogReads: [] as number[] };
    for (let second = 1; second <= 30; second++) {
      if (name === "late-advanced" && second === 6) {
        runtime.state.constructionAutomation.targetStock.ray_receiver = 3;
        Object.assign(runtime.state.tray, { steel: 60, high_purity_silicon: 60, processor: 15, circuit_board: 30, prism: 60 });
        runtime.state.quantumLogisticsNetwork.inventory.optical_grating_crystal = "20";
      }
      if (name === "scarce-centers" && second === 11) runtime.state.quantumLogisticsNetwork.inventory = { ...direct };
      advancePersistentSimulationRuntime(runtime, 1, 1);
      if (second === 5 || second === 10 || second === 30) {
        row.hashes.push(sha256(JSON.stringify(runtime.state)));
        row.catalogReads.push(reads);
      }
    }
    expect(row.hashes).toEqual(golden[name].hashes);
    row.catalogReads.forEach((count, index) => expect(count).toBeLessThanOrEqual(golden[name].catalogReads[index]));
    if (name === "scarce-centers" || name === "later-target") {
      expect(row.catalogReads.at(-1)).toBeLessThan(golden[name].catalogReads.at(-1)!);
    }
    if (process.env.DSP_CONTEXT_READ_DIAGNOSTICS === "1") {
      console.info(JSON.stringify({ scenario: name, catalogReads: row.catalogReads }));
    }
    if (name === "scarce-centers") expect(runtime.state.construction.arc_smelter).toBe(2);
    if (name === "later-target") {
      expect(runtime.state.construction.arc_smelter).toBe(0);
      expect(runtime.state.construction.plane_smelter).toBe(1);
    }
    if (name === "late-advanced") expect(runtime.state.quantumLogisticsNetwork.inventory.optical_grating_crystal).toBe("0");
    if (name === "stopped") {
      expect(runtime.state.construction.arc_smelter).toBe(0);
      expect(runtime.state.quantumLogisticsNetwork.inventory).toEqual(direct);
    }
    if (name === "legacy-suffix") expect(runtime.state.construction.arc_smelter).toBe(1);
  });
});
