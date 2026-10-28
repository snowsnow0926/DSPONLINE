import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceSimulationSession, completeSimulationAdvanceSession, createInitialState,
  createSimulationAdvanceSession, type SimulationContractExperiment, type SimulationLookupContext } from "./engine";
import * as quantum from "./quantumLogisticsNetwork";
import type { FactoryEntity, GameState, StationSlot } from "./types";

const hash = (state: GameState) => createHash("sha256").update(JSON.stringify(state)).digest("hex");

function fixture(inventory: unknown = "0", capacity: unknown = "1000000", fullBuffers = false): GameState {
  const state = createInitialState(20_261_029, false);
  state.paused = false;
  state.entities = [];
  state.belts = [];
  state.quantumLogisticsNetwork.enabled = true;
  if (inventory === undefined) delete state.quantumLogisticsNetwork.inventory.iron_ore;
  else state.quantumLogisticsNetwork.inventory.iron_ore = inventory as string;
  if (capacity === undefined) delete state.quantumLogisticsNetwork.itemCapacities.iron_ore;
  else state.quantumLogisticsNetwork.itemCapacities.iron_ore = capacity as string;
  const base = { planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false, inputs: {}, outputs: {},
    progress: 0, utilization: 0, productionRate: 0, routingCursor: 0, machineCount: 1, minerCount: 0 } as const;
  const slot: StationSlot = { itemId: "iron_ore", localMode: "storage", remoteMode: "supply", minimumLoad: 1,
    minStock: 1000, maxStock: 10000, priority: 1, routePolicy: "direct", warperBudget: 2 };
  for (let index = 0; index < 12; index++) {
    const source: FactoryEntity = { ...base, id: `source-${index}`, kind: "storage", buildingId: "storage_mk1",
      storedItemId: "iron_ore", inputs: {}, outputs: { iron_ore: 10000 } };
    const target: FactoryEntity = { ...base, id: `tower-${index}`, kind: "station", buildingId: "interstellar_logistics_station",
      quantumMode: "quantum", stationTier: 2, stationSlots: [structuredClone(slot),
        ...(["copper_ore", "stone", "coal", "water"] as const).map((itemId) =>
          ({ ...slot, itemId, remoteMode: "storage" as const, minStock: 0 }))], stationRoutes: [],
      stationDrones: 0, stationVessels: 0, stationWarpers: 0, inputs: { iron_ore: fullBuffers ? 10000 : 0 }, outputs: {} };
    state.entities.push(source, target);
    state.belts.push({ id: `belt-${index}`, planetId: "home", source: source.id, target: target.id,
      itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 100, priority: 1, lastFlow: 0 });
  }
  state.entities.push({ ...base, id: "power", kind: "power", buildingId: "wind_turbine", machineCount: 1_000_000, inputs: {}, outputs: {} });
  // Give the owned and copying paths the same normalized record shape, without
  // advancing physics; real saves do not share mutable buffers between nodes.
  return createSimulationAdvanceSession(state, 1, { indexedLogistics: false }).state;
}

function step(source: GameState, flat: boolean, contractExperiment?: SimulationContractExperiment) {
  const before = structuredClone(source);
  const parser = vi.spyOn(quantum, "normalizeQuantumInteger");
  const session = createSimulationAdvanceSession(source, 1, { forceFlatRouteOracle: flat, contractExperiment });
  parser.mockClear();
  try {
    advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
    return { state: completeSimulationAdvanceSession(session), parserCalls: parser.mock.calls.length };
  } finally {
    parser.mockRestore();
    expect(source).toStrictEqual(before);
  }
}

describe("quantum belt capacity value reuse", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([
    ["zero", "0", "10000"], ["near", "9999", "10000"], ["full", "10000", "10000"],
    ["over", "10001", "10000"], ["padded", "00009999", "00010000"],
    ["huge", "9".repeat(256), "10000"], ["oversized", "9".repeat(257), "10000"],
    ["invalid", "1e12", "bad"], ["legacy-number", 777, 10000],
    ["missing", undefined, undefined], ["legacy-nan", NaN, "10000"],
  ])("preserves complete multi-step flat-oracle state for %s", (_name, inventory, capacity) => {
    let state = fixture(inventory, capacity);
    for (let second = 0; second < 6; second++) {
      const actual = step(state, false);
      const reference = step(state, true);
      expect(actual.state).toStrictEqual(reference.state);
      expect(hash(actual.state)).toBe(hash(reference.state));
      state = actual.state;
    }
  });

  it.each(["withdraw", "capacity", "default-capacity", "local-buffer", "disable", "replace-inventory"] as const)(
    "observes %s changes inside the same simulation step", (kind) => {
      const state = fixture("10000", "10000", true);
      const mutate = (candidate: GameState) => {
        if (kind === "withdraw") candidate.quantumLogisticsNetwork.inventory.iron_ore = "0";
        if (kind === "capacity") candidate.quantumLogisticsNetwork.itemCapacities.iron_ore = "1000000";
        if (kind === "default-capacity") delete candidate.quantumLogisticsNetwork.itemCapacities.iron_ore;
        if (kind === "disable") candidate.quantumLogisticsNetwork.enabled = false;
        if (kind === "replace-inventory") candidate.quantumLogisticsNetwork.inventory = { iron_ore: "0" };
        if (kind === "local-buffer") for (const entity of candidate.entities) {
          if (entity.kind === "station") entity.inputs.iron_ore = 0;
        }
        for (const belt of candidate.belts) belt.progress = 100;
      };
      const actual = step(state, false, { beforeOutputBelts: mutate });
      const reference = step(state, true, { beforeOutputBelts: mutate });
      expect(hash(actual.state)).toBe(hash(reference.state));
      if (["withdraw", "capacity", "default-capacity", "replace-inventory"].includes(kind)) {
        expect(actual.state.quantumLogisticsNetwork.inventory.iron_ore).not.toBe(kind === "withdraw" || kind === "replace-inventory" ? "0" : "10000");
      }
    });

  it("avoids repeated integer parsing when twelve towers share unchanged warehouse values", () => {
    const state = fixture("0", "1000000");
    const actual = step(state, false);
    const reference = step(state, true);
    expect(hash(actual.state)).toBe(hash(reference.state));
    expect(actual.parserCalls).toBeGreaterThan(0);
    expect(actual.parserCalls).toBeLessThan(reference.parserCalls);
  });

  it("refreshes values across capacity, enabled and inventory changes while retaining the same lookup", () => {
    let actual = fixture("10000", "10000", true);
    let reference = structuredClone(actual);
    let lookup: SimulationLookupContext | undefined;
    let reused = 0;
    for (let index = 0; index < 6; index++) {
      for (const state of [actual, reference]) {
        if (index === 1) state.quantumLogisticsNetwork.inventory.iron_ore = "0";
        if (index === 2) state.quantumLogisticsNetwork.itemCapacities.iron_ore = "1000000";
        if (index === 3) state.quantumLogisticsNetwork.enabled = false;
        if (index === 4) {
          state.quantumLogisticsNetwork.enabled = true;
          state.quantumLogisticsNetwork.inventory = { iron_ore: "0" };
        }
        if (index === 5) delete state.quantumLogisticsNetwork.itemCapacities.iron_ore;
        for (const belt of state.belts) belt.progress = 100;
      }
      const session = createSimulationAdvanceSession(actual, 1, { mutateState: true, lookup });
      if (lookup && session.lookup === lookup) reused++;
      advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
      actual = completeSimulationAdvanceSession(session);
      lookup = session.lookup;
      reference = step(reference, true).state;
      expect(actual).toStrictEqual(reference);
      expect(hash(actual)).toBe(hash(reference));
    }
    expect(reused).toBeGreaterThan(0);
  });
});
