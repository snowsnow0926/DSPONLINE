import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advancePersistentSimulationRuntime,
  advanceSimulationSession,
  applyPersistentSimulationRuntimeCommand,
  createPersistentSimulationRuntime,
  createPlayerInitialState,
  createSimulationAdvanceSession,
  createSimulationProfiler,
  getSimulationLogisticsProfilerAttribution,
  getSimulationLogisticsRuntimeDiagnostics,
  completeSimulationAdvanceSession,
} from "./engine";
import { createLogisticsBenchmarkState } from "./logisticsBenchmark";
import { createSimulationCommandPatch } from "./simulationRuntimeProtocol";
import type { GameState } from "./types";

function persisted(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function pair(source: GameState) {
  return {
    compiled: createPersistentSimulationRuntime(structuredClone(source), undefined, {
      beltImplementation: "compiled",
      powerImplementation: "compiled",
      logisticsImplementation: "compiled",
    }),
    legacy: createPersistentSimulationRuntime(structuredClone(source), undefined, {
      beltImplementation: "compiled",
      powerImplementation: "compiled",
      logisticsImplementation: "legacy",
    }),
  };
}

function expectPairEqual(runtimes: ReturnType<typeof pair>): void {
  const compiled = persisted(runtimes.compiled.state);
  const legacy = persisted(runtimes.legacy.state);
  expect(hashGameState(compiled)).toBe(hashGameState(legacy));
  expect(compiled).toEqual(legacy);
}

function firstDifference(left: unknown, right: unknown, path = "$"): string | undefined {
  if (Object.is(left, right)) return undefined;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== "object") {
    return `${path}: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return `${path}: container type`;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const key of keys) {
    const difference = firstDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return undefined;
}

describe("RuntimeWorld M4 compiled logistics runtime", () => {
  it.each([1, 4, 12, 60, 600])(
    "matches the retained logistics oracle after %i exact seconds",
    (seconds) => {
      const source = createLogisticsBenchmarkState(48);
      source.paused = false;
      const runtimes = pair(source);
      advancePersistentSimulationRuntime(runtimes.compiled, seconds, seconds);
      advancePersistentSimulationRuntime(runtimes.legacy, seconds, seconds);
      expectPairEqual(runtimes);
      expect(getSimulationLogisticsRuntimeDiagnostics(runtimes.compiled.lookup).implementation).toBe("compiled");
      expect(getSimulationLogisticsRuntimeDiagnostics(runtimes.legacy.lookup).implementation).toBe("legacy");
    },
    120_000,
  );

  it("skips only an unchanged local stable island and records every full-scan fallback reason", () => {
    const source = createLogisticsBenchmarkState(48);
    source.paused = false;
    const runtime = createPersistentSimulationRuntime(source, undefined, { logisticsImplementation: "compiled" });
    advancePersistentSimulationRuntime(runtime, 20, 20);
    const diagnostics = getSimulationLogisticsRuntimeDiagnostics(runtime.lookup);

    expect(diagnostics.cachedStationSlotSets).toBe(diagnostics.stations);
    expect(diagnostics.stationSlotCacheHits).toBeGreaterThan(0);
    expect(diagnostics.stableIslandEligibleSlots).toBeGreaterThan(0);
    expect(diagnostics.fallbackIslandSlots).toBeGreaterThan(0);
    expect(diagnostics.stableDispatchChecks).toBeGreaterThan(0);
    expect(diagnostics.stableDispatchSkips).toBeGreaterThan(0);
    expect(diagnostics.fullScanFallbacks).toBeGreaterThan(0);
    expect(diagnostics.fallbackReasons["snapshot-changed"]).toBeGreaterThan(0);
    expect(diagnostics.fallbackReasons["cross-island"]).toBeGreaterThan(0);
    expect(diagnostics.fallbackRatio).toBeGreaterThanOrEqual(0);
    expect(diagnostics.fallbackRatio).toBeLessThanOrEqual(1);
  });

  it("rebuilds changed station topology, wakes its island, and preserves the selected oracle", () => {
    const source = createLogisticsBenchmarkState(16);
    source.paused = false;
    const runtimes = pair(source);
    advancePersistentSimulationRuntime(runtimes.compiled, 4, 4);
    advancePersistentSimulationRuntime(runtimes.legacy, 4, 4);
    expectPairEqual(runtimes);

    for (const runtime of [runtimes.compiled, runtimes.legacy]) {
      const desired = structuredClone(runtime.state);
      const station = desired.entities.find((entity) => entity.kind === "station" && entity.stationSlots?.length)!;
      station.stationSlots![0].priority = station.stationSlots![0].priority === 2 ? 0 : 2;
      const command = createSimulationCommandPatch(runtime.state, desired, 1);
      expect(command).not.toBeNull();
      const result = applyPersistentSimulationRuntimeCommand(runtime, command!);
      expect(result.cacheRebuilt).toBe(true);
      expect(runtime.lookup?.logisticsImplementation).toBe(runtime.logisticsImplementation);
    }

    advancePersistentSimulationRuntime(runtimes.compiled, 12, 12);
    advancePersistentSimulationRuntime(runtimes.legacy, 12, 12);
    expectPairEqual(runtimes);
  });

  it("keeps mutually exclusive logistics attribution above the 95 percent evidence gate", () => {
    const source = createLogisticsBenchmarkState(48);
    source.paused = false;
    const profiler = createSimulationProfiler();
    const runtime = createPersistentSimulationRuntime(source, profiler, { logisticsImplementation: "compiled" });
    advancePersistentSimulationRuntime(runtime, 12, 12, profiler);
    const attribution = getSimulationLogisticsProfilerAttribution(profiler);

    expect(attribution.logisticsMs).toBeGreaterThan(0);
    expect(attribution.attributedMs).toBeGreaterThan(0);
    expect(attribution.attributionRatio).toBeGreaterThanOrEqual(0.95);
    expect(attribution.attributionRatio).toBeLessThanOrEqual(1.000_001);
  });

  it("keeps the five-second quantum boundary exact while explicitly falling back from island skipping", () => {
    const source = createPlayerInitialState();
    source.paused = false;
    source.quantumLogisticsNetwork.enabled = true;
    source.quantumLogisticsNetwork.inventory.iron_ore = "1000";
    source.research.completedTechIds = [...new Set([
      ...source.research.completedTechIds,
      "interstellar_logistics",
      "quantum_logistics_network",
    ])] as typeof source.research.completedTechIds;
    source.entities.push({
      id: "m4-quantum-demand",
      kind: "station",
      planetId: "home",
      position: { x: 0, y: 0 },
      interactionLocked: false,
      buildingId: "interstellar_logistics_station",
      stationTier: 2,
      quantumMode: "quantum",
      quantumTransition: null,
      stationSlots: [{
        itemId: "iron_ore",
        localMode: "demand",
        remoteMode: "demand",
        minimumLoad: 0.1,
        minStock: 0,
        maxStock: 10_000,
        priority: 1,
        routePolicy: "direct",
        warperBudget: 2,
      }],
      stationRoutes: [],
      stationDrones: 10,
      stationVessels: 0,
      stationWarpers: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      utilization: 0,
      productionRate: 0,
      routingCursor: 0,
      machineCount: 1,
      minerCount: 0,
    });
    const runtimes = pair(source);
    advancePersistentSimulationRuntime(runtimes.compiled, 10, 10);
    advancePersistentSimulationRuntime(runtimes.legacy, 10, 10);
    expectPairEqual(runtimes);

    const diagnostics = getSimulationLogisticsRuntimeDiagnostics(runtimes.compiled.lookup);
    expect(diagnostics.quantumBoundarySettlements).toBe(2);
    expect(diagnostics.fallbackReasons["quantum-boundary"]).toBeGreaterThan(0);
    expect(diagnostics.stableDispatchSkips).toBe(0);
  });

  it("matches the retained full-scan adapter outside the domain selector", () => {
    const source = createLogisticsBenchmarkState(50);
    const run = (indexedLogistics: boolean) => {
      const session = createSimulationAdvanceSession(structuredClone(source), 4, { indexedLogistics });
      advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
      return persisted(completeSimulationAdvanceSession(session));
    };
    const legacy = run(false);
    const compiled = run(true);
    expect(firstDifference(compiled, legacy)).toBeUndefined();
    expect(compiled).toEqual(legacy);
  });
});
