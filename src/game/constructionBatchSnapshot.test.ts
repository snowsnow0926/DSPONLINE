import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TECHNOLOGIES } from "./content";
import { advanceSimulationSession, completeSimulationAdvanceSession, createInitialState, createSimulationAdvanceSession } from "./engine";
import type { GameState } from "./types";

const scenarios = ["single-small", "single-large", "multi-small", "multi-large", "existing-job"] as const;
type Scenario = typeof scenarios[number];
// Captured from 669cc588 before reusing the per-attempt eligibility snapshot.
const golden: Record<Scenario, { hashes: string[]; targetReads: number[] }> = {
  "single-small": { hashes: [
    "d6a69a85ecea7ea0cc91083d6e34ab6a25e3755769f702740e6f36bc7a437158",
    "1100114c91df1b915b23e90e0e77ae8edcb46e199253f136fc31d89029e05774",
    "46c6ee8d638b15350756ca383e00ef275957743735138a8073539a173ce4e080",
  ], targetReads: [8, 8, 13] },
  "single-large": { hashes: [
    "59d57db1ff8841070ef4e5a9e6189890273868e1156ee3d73c5b814e0771fe4e",
    "bfaaa02155aa59c5d6fef2fc22a1ede238400c373852878d888b119b91364c65",
    "f5295fc497c8458759bea1c86f33e968fac4216d8b63012d375be7c2842cbf75",
  ], targetReads: [9, 8, 13] },
  "multi-small": { hashes: [
    "31f556252da284ed4053aef4c4e17dcfc46ff55a76d0d339c5977e062192ced4",
    "ea5cf2a4616e1a3162fcb68f860f234e3ccb655ce78a895693b4dc89af09a717",
    "79a6e920d96b7cca66929f8f9816527de4a877a71e9a4b8d97f25f973d5275a2",
  ], targetReads: [65, 63, 31] },
  "multi-large": { hashes: [
    "448b889e576ed1a729bec2f86d20d5d30d07a9b947a794167193b490eb8fd2ab",
    "0a50d87ac64af0a3eedc6836bf39b638f989f418bc9abed9f5a09c519edf319e",
    "ec347a7c41ac57ae0b69eee72828c3129a8024ad0eff99e753e65f329a92479a",
  ], targetReads: [21, 13, 13] },
  "existing-job": { hashes: [
    "15bc1b8fbcfc8e85f8675c8298f0914c7a886e4aa58e9f37a5b737be5975c936",
    "76ed6addddf165823fc16817a3e101391c99c59d59fcedc990c015262a9536fb",
    "643d6cb5b9b8f1102fd2d87f500074b64aa245adda9567dde18f50b932744e2b",
  ], targetReads: [8, 7, 12] },
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture(name: Scenario): GameState {
  const state = createInitialState(20_261_028, false);
  state.tray = { iron_ingot: 1_000_000, gear: 1_000_000, magnetic_coil: 1_000_000,
    stone_brick: 1_000_000, circuit_board: 1_000_000 };
  state.planetTrays.home = state.tray;
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as GameState["research"]["completedTechIds"];
  state.construction.wind_turbine = state.construction.arc_smelter = 0;
  state.constructionAutomation = { enabled: true, targetStock: { wind_turbine: 20 }, jobs: {}, cursor: 0,
    totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {} };
  const base = { planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false, inputs: {}, outputs: {},
    progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0 } as const;
  state.entities = [
    { ...base, id: "center", kind: "machine", buildingId: "construction_center", machineCount: name.endsWith("small") ? 10 : 300 },
    { ...base, id: "power", kind: "power", buildingId: "wind_turbine", machineCount: 100_000 },
  ];
  state.belts = [];
  if (name.startsWith("multi")) state.constructionAutomation.targetStock.arc_smelter = 20;
  if (name === "existing-job") {
    state.entities.push({ ...structuredClone(state.entities[0]), id: "parked-center", machineCount: 0 });
    state.constructionAutomation.jobs["parked-center"] = { constructionId: "wind_turbine", inventory: {}, elapsedSeconds: 0,
      stepIndex: 0, steps: [{ kind: "building", constructionId: "wind_turbine" }] };
  }
  return state;
}

function step(source: GameState) {
  const session = createSimulationAdvanceSession(source, 1);
  const targets = session.state.constructionAutomation.targetStock;
  const values = { ...targets };
  const keys = Object.keys(targets) as Array<keyof typeof targets>;
  let reads = 0;
  for (const key of keys) Object.defineProperty(targets, key, {
    configurable: true, enumerable: true,
    get: () => { reads++; return values[key]; },
    set: (value: number) => { values[key] = value; },
  });
  try {
    advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
    const state = completeSimulationAdvanceSession(session);
    return { state, get reads() { return reads; } };
  } finally {
    for (const key of keys) if (Object.hasOwn(targets, key)) Object.defineProperty(targets, key, {
      value: values[key], writable: true, enumerable: true, configurable: true,
    });
  }
}

describe("one construction batch attempt reuses live target eligibility", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => vi.useRealTimers());

  it.each(scenarios)("preserves complete state and fresh goals for %s", (name) => {
    let state = fixture(name);
    const row = { hashes: [] as string[], targetReads: [] as number[] };
    for (let second = 1; second <= 3; second++) {
      if (second === 2) state.constructionAutomation.targetStock.wind_turbine = (state.construction.wind_turbine ?? 0) + 7;
      if (second === 3) state.constructionAutomation.targetStock.arc_smelter = (state.construction.arc_smelter ?? 0) + 4;
      const next = step(state);
      state = next.state;
      row.hashes.push(hash(JSON.stringify(state)));
      row.targetReads.push(next.reads);
    }
    expect(state.constructionAutomation.totalCrafted).toBeGreaterThan(0);
    if (name === "existing-job") expect(state.constructionAutomation.jobs["parked-center"]).toBeDefined();
    expect(row.hashes).toEqual(golden[name].hashes);
    row.targetReads.forEach((count, index) => expect(count).toBeLessThan(golden[name].targetReads[index]));
    if (process.env.DSP_BATCH_TARGET_READS === "1") {
      console.info(JSON.stringify({ scenario: name, targetReads: row.targetReads }));
    }
  });
});
