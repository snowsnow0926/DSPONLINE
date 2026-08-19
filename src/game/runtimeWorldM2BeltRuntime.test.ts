import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advancePersistentSimulationRuntime,
  applyPersistentSimulationRuntimeCommand,
  createPersistentSimulationRuntime,
  createSimulationProfiler,
} from "./engine";
import { createSyntheticPerformanceFixture } from "./performanceFixtures";
import { createSimulationCommandPatch } from "./simulationRuntimeProtocol";
import type { BeltConnection, GameState } from "./types";

function persisted(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function pair(source: GameState) {
  return {
    compiled: createPersistentSimulationRuntime(structuredClone(source), undefined, { beltImplementation: "compiled" }),
    legacy: createPersistentSimulationRuntime(structuredClone(source), undefined, { beltImplementation: "legacy" }),
  };
}

function expectPairEqual(runtimes: ReturnType<typeof pair>): void {
  const compiled = persisted(runtimes.compiled.state);
  const legacy = persisted(runtimes.legacy.state);
  expect(hashGameState(compiled)).toBe(hashGameState(legacy));
  expect(compiled).toEqual(legacy);
}

function applyTopologyState(
  runtimes: ReturnType<typeof pair>,
  mutate: (state: GameState) => GameState,
  revision: number,
): void {
  for (const runtime of [runtimes.compiled, runtimes.legacy]) {
    const desired = mutate(runtime.state);
    const command = createSimulationCommandPatch(runtime.state, desired, revision);
    expect(command).not.toBeNull();
    const result = applyPersistentSimulationRuntimeCommand(runtime, command!);
    expect(result.cacheRebuilt).toBe(true);
    expect(runtime.lookup?.beltRuntime.implementation).toBe(runtime.beltImplementation);
  }
}

describe("RuntimeWorld M2 compiled belt runtime", () => {
  it.each([1, 4, 12, 60, 600])(
    "matches the retained transferBelts oracle after %i exact seconds",
    (seconds) => {
      const source = createSyntheticPerformanceFixture("p50");
      source.paused = false;
      const runtimes = pair(source);
      const compiledProfiler = createSimulationProfiler();
      const legacyProfiler = createSimulationProfiler();
      advancePersistentSimulationRuntime(runtimes.compiled, seconds, seconds, compiledProfiler);
      advancePersistentSimulationRuntime(runtimes.legacy, seconds, seconds, legacyProfiler);
      expectPairEqual(runtimes);
      expect(compiledProfiler.beltInputRouteChecks).toBeGreaterThan(0);
      expect(compiledProfiler.beltOutputRouteChecks).toBeGreaterThan(0);
      expect(legacyProfiler.beltInputRouteChecks).toBe(compiledProfiler.beltInputRouteChecks);
      expect(compiledProfiler.beltOutputRouteChecks).toBeLessThanOrEqual(legacyProfiler.beltOutputRouteChecks);
    },
    120_000,
  );

  it("stays exact across remove/add topology rebuild boundaries and preserves fallback mode", () => {
    const source = createSyntheticPerformanceFixture("p50");
    source.paused = false;
    const runtimes = pair(source);
    advancePersistentSimulationRuntime(runtimes.compiled, 4, 4);
    advancePersistentSimulationRuntime(runtimes.legacy, 4, 4);
    expectPairEqual(runtimes);

    const removed = structuredClone(runtimes.compiled.state.belts[0]);
    applyTopologyState(runtimes, (state) => ({
      ...state,
      belts: state.belts.filter((belt) => belt.id !== removed.id),
    }), 1);
    expectPairEqual(runtimes);
    advancePersistentSimulationRuntime(runtimes.compiled, 12, 12);
    advancePersistentSimulationRuntime(runtimes.legacy, 12, 12);
    expectPairEqual(runtimes);

    const replacement: BeltConnection = {
      ...removed,
      id: `${removed.id}-runtimeworld-m2`,
      progress: 0,
      lastFlow: 0,
      congestion: 0,
      totalTransferred: 0,
    };
    applyTopologyState(runtimes, (state) => ({ ...state, belts: [replacement, ...state.belts] }), 2);
    expectPairEqual(runtimes);
    advancePersistentSimulationRuntime(runtimes.compiled, 60, 60);
    advancePersistentSimulationRuntime(runtimes.legacy, 60, 60);
    expectPairEqual(runtimes);
  }, 120_000);
});
