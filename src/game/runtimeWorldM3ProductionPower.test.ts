import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advancePersistentSimulationRuntime,
  applyPersistentSimulationRuntimeCommand,
  createPersistentSimulationRuntime,
  getSimulationMachineRuntimeDiagnostics,
} from "./engine";
import { createSyntheticPerformanceFixture } from "./performanceFixtures";
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
    }),
    legacy: createPersistentSimulationRuntime(structuredClone(source), undefined, {
      beltImplementation: "compiled",
      powerImplementation: "legacy",
    }),
  };
}

function expectPairEqual(runtimes: ReturnType<typeof pair>): void {
  const compiled = persisted(runtimes.compiled.state);
  const legacy = persisted(runtimes.legacy.state);
  expect(hashGameState(compiled)).toBe(hashGameState(legacy));
  expect(compiled).toEqual(legacy);
}

describe("RuntimeWorld M3 compiled production/power runtime", () => {
  it.each([1, 4, 12, 60, 600])(
    "matches the retained power allocation oracle after %i exact seconds",
    (seconds) => {
      const source = createSyntheticPerformanceFixture("p50");
      source.paused = false;
      const runtimes = pair(source);
      advancePersistentSimulationRuntime(runtimes.compiled, seconds, seconds);
      advancePersistentSimulationRuntime(runtimes.legacy, seconds, seconds);
      expectPairEqual(runtimes);
    },
    120_000,
  );

  it("wakes through recipe/grid/priority topology changes and preserves its fallback mode", () => {
    const source = createSyntheticPerformanceFixture("p50");
    source.paused = false;
    const runtimes = pair(source);
    advancePersistentSimulationRuntime(runtimes.compiled, 4, 4);
    advancePersistentSimulationRuntime(runtimes.legacy, 4, 4);
    expectPairEqual(runtimes);

    for (const [revision, field] of [[1, "powerPriority"], [2, "powerGridId"], [3, "recipeId"]] as const) {
      for (const runtime of [runtimes.compiled, runtimes.legacy]) {
        const desired = structuredClone(runtime.state);
        const machine = desired.entities.find((entity) => entity.kind === "machine" && entity.recipeId === "iron_ingot")!;
        if (field === "powerPriority") machine.powerPriority = machine.powerPriority === 3 ? 1 : 3;
        else if (field === "powerGridId") machine.powerGridId = machine.powerGridId === "grid-b" ? "grid-a" : "grid-b";
        else machine.recipeId = "copper_ingot";
        const command = createSimulationCommandPatch(runtime.state, desired, revision);
        expect(command).not.toBeNull();
        const result = applyPersistentSimulationRuntimeCommand(runtime, command!);
        expect(result.cacheRebuilt).toBe(true);
        expect(runtime.lookup?.powerImplementation).toBe(runtime.powerImplementation);
      }
      advancePersistentSimulationRuntime(runtimes.compiled, 12, 12);
      advancePersistentSimulationRuntime(runtimes.legacy, 12, 12);
      expectPairEqual(runtimes);
    }
  }, 120_000);

  it("sleeps an input-starved slot and wakes it immediately on a non-topology inventory command", () => {
    const source = createSyntheticPerformanceFixture("p50");
    source.paused = false;
    const machine = source.entities.find((entity) => entity.kind === "machine" && entity.recipeId === "iron_ingot")!;
    machine.inputs = { iron_ore: 0 };
    machine.outputs = { iron_ingot: 0 };
    source.entities = source.entities.filter((entity) =>
      entity.id === machine.id || (entity.kind === "power" && entity.planetId === machine.planetId));
    source.belts = [];
    const runtime = createPersistentSimulationRuntime(source, undefined, {
      beltImplementation: "compiled",
      powerImplementation: "compiled",
    });

    advancePersistentSimulationRuntime(runtime, 1, 1);
    const sleeping = getSimulationMachineRuntimeDiagnostics(runtime.lookup);
    expect(sleeping.frontierEnabled).toBe(true);
    expect(sleeping.inputSleeping).toBeGreaterThan(0);
    expect(runtime.state.entities.find((entity) => entity.id === machine.id)?.productionRate).toBe(0);

    const desired = structuredClone(runtime.state);
    desired.entities.find((entity) => entity.id === machine.id)!.inputs.iron_ore = 100;
    const command = createSimulationCommandPatch(runtime.state, desired, 1)!;
    const applied = applyPersistentSimulationRuntimeCommand(runtime, command);
    expect(applied.cacheRebuilt).toBe(false);
    expect(getSimulationMachineRuntimeDiagnostics(runtime.lookup).pendingWake).toBeGreaterThan(0);

    advancePersistentSimulationRuntime(runtime, 1, 1);
    const resumed = runtime.state.entities.find((entity) => entity.id === machine.id)!;
    expect(resumed.productionRate).toBeGreaterThan(0);
    expect(getSimulationMachineRuntimeDiagnostics(runtime.lookup).active).toBeGreaterThan(0);
  });
});
