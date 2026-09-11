import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advancePersistentSimulationRuntime,
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createPersistentSimulationRuntime,
  createSimulationAdvanceSession,
} from "./engine";
import { createSyntheticPerformanceFixture } from "./performanceFixtures";
import {
  createEmptyQuantumLogisticsNetworkState,
  settleQuantumLogisticsNetwork,
  type QuantumSettlementInput,
  type QuantumSettlementOutput,
} from "./quantumLogisticsNetwork";
import type { GameState } from "./types";

function persistedState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

describe("1.0.38 persistent batching parity", () => {
  it("reuses belt candidates and capacity ledgers across steps while matching the legacy full-state hash", () => {
    const source = createSyntheticPerformanceFixture("p50");
    source.paused = false;
    const normalizedSource = structuredClone(createPersistentSimulationRuntime(structuredClone(source)).state);
    const runtime = createPersistentSimulationRuntime(structuredClone(normalizedSource));
    const entries = runtime.lookup!.beltRuntime.settlementEntries;
    const sourceLedgers = runtime.lookup!.beltRuntime.sourceAvailabilityLedgers;
    const targetLedgers = runtime.lookup!.beltRuntime.targetCapacityLedgers;
    advancePersistentSimulationRuntime(runtime, 1, 1);
    const candidate = runtime.lookup!.beltRuntime.routeGroups
      .flatMap((group) => group.routes)
      .find((route) => route.runtimeCandidate)?.runtimeCandidate;
    expect(candidate).toBeDefined();
    advancePersistentSimulationRuntime(runtime, 1, 1);
    expect(runtime.lookup!.beltRuntime.settlementEntries).toBe(entries);
    expect(runtime.lookup!.beltRuntime.sourceAvailabilityLedgers).toBe(sourceLedgers);
    expect(runtime.lookup!.beltRuntime.targetCapacityLedgers).toBe(targetLedgers);
    expect(runtime.lookup!.beltRuntime.routeGroups.flatMap((group) => group.routes)
      .find((route) => route.belt.id === candidate!.belt.id)?.runtimeCandidate).toBe(candidate);

    let oracleState = structuredClone(normalizedSource);
    for (let step = 0; step < 2; step += 1) {
      const oracle = createSimulationAdvanceSession(oracleState, 1, { indexedLogistics: false });
      advanceSimulationSession(oracle, Number.MAX_SAFE_INTEGER);
      oracleState = completeSimulationAdvanceSession(oracle);
    }
    expect(persistedState(runtime.state)).toEqual(persistedState(oracleState));
    expect(hashGameState(persistedState(runtime.state))).toBe(hashGameState(persistedState(oracleState)));
  });

  it("in-place normalized quantum batching is byte-for-byte equivalent to the public immutable path", () => {
    const network = createEmptyQuantumLogisticsNetworkState();
    network.enabled = true;
    network.inventory.iron_ore = "120000";
    network.inventory.copper_ore = "20000";
    const inputs: QuantumSettlementInput[] = [
      { key: "supply-a:iron", stationId: "supply-a", itemId: "iron_ore", requested: 8_000, priority: 2 },
      { key: "supply-b:copper", stationId: "supply-b", itemId: "copper_ore", requested: 6_000, priority: 1 },
    ];
    const outputs: QuantumSettlementOutput[] = [
      { key: "demand-a:iron", stationId: "demand-a", itemId: "iron_ore", requested: 20_000, capacity: 12_000, priority: 2 },
      { key: "demand-b:copper", stationId: "demand-b", itemId: "copper_ore", requested: 5_000, capacity: 5_000, priority: 1 },
    ];
    const immutableSource = structuredClone(network);
    const immutable = settleQuantumLogisticsNetwork(network, inputs, outputs, {
      globalUploadCap: 7_000,
      globalDownloadCap: 13_000,
    });
    expect(network).toEqual(immutableSource);
    const mutableSource = structuredClone(network);
    const mutable = settleQuantumLogisticsNetwork(mutableSource, inputs, outputs, {
      globalUploadCap: 7_000,
      globalDownloadCap: 13_000,
      mutateNormalizedState: true,
    });
    expect(mutable).toEqual(immutable);
    expect(mutable.state).toBe(mutableSource);
  });
});
