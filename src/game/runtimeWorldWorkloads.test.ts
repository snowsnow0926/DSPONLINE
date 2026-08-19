import { afterAll, describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import {
  applyContentPackRuntimeSnapshot,
  createContentPackRegistry,
  createContentPackRuntimeSnapshot,
} from "./contentPacks";
import {
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createSimulationAdvanceSession,
  createSimulationProfiler,
  type SimulationProfiler,
} from "./engine";
import { createRuntimeWorldWorkloads } from "./runtimeWorldWorkloads";
import type { GameState, ItemId } from "./types";

const baseRegistry = createContentPackRuntimeSnapshot(createContentPackRegistry());

function invalidMaterialAmounts(state: GameState): number {
  let invalid = 0;
  const inspect = (record: Partial<Record<ItemId, number>>) => {
    for (const amount of Object.values(record)) {
      if (!Number.isSafeInteger(amount) || (amount ?? 0) < 0) invalid += 1;
    }
  };
  for (const entity of state.entities) {
    inspect(entity.inputs);
    inspect(entity.outputs);
    for (const route of entity.stationRoutes ?? []) {
      if (!Number.isSafeInteger(route.cargo) || route.cargo < 0) invalid += 1;
    }
  }
  for (const tray of Object.values(state.planetTrays)) inspect(tray);
  for (const amount of Object.values(state.quantumLogisticsNetwork.inventory)) {
    try {
      if (BigInt(amount || "0") < 0n) invalid += 1;
    } catch {
      invalid += 1;
    }
  }
  return invalid;
}

function run(state: GameState, seconds: number, indexedLogistics: boolean) {
  const profiler = createSimulationProfiler();
  const startedAt = performance.now();
  const session = createSimulationAdvanceSession(structuredClone(state), seconds, { indexedLogistics, profiler });
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  const result = completeSimulationAdvanceSession(session);
  return { durationMs: performance.now() - startedAt, profiler, result, hash: hashGameState(result) };
}

function phaseSummary(profiler: SimulationProfiler) {
  const phases = {
    production: profiler.productionMs,
    belts: profiler.beltsMs,
    logistics: profiler.logisticsMs,
    power: profiler.powerMs,
    quantum: profiler.quantumMs,
  };
  return Object.fromEntries(Object.entries(phases).map(([key, value]) => [key, Number(value.toFixed(3))]));
}

afterAll(() => applyContentPackRuntimeSnapshot(baseRegistry));

describe("RuntimeWorld deterministic workload matrix", () => {
  const workloads = createRuntimeWorldWorkloads();

  it("covers every required synthetic shape with explicit provenance", () => {
    expect(workloads.map((workload) => workload.id)).toEqual([
      "midgame",
      "production-heavy",
      "belt-heavy",
      "logistics-heavy",
      "fully-blocked",
      "content-pack",
      "speedrun",
      "offline",
    ]);
    expect(workloads.every((workload) => workload.source === "synthetic" && workload.description.length > 0)).toBe(true);
    expect(workloads.every((workload) => workload.state.paused === false)).toBe(true);
    expect(workloads.find((workload) => workload.id === "speedrun")?.state.mode).toBe("speedrun");
    expect(workloads.find((workload) => workload.id === "content-pack")?.state.contentPacks)
      .toEqual([{ id: "runtimeworld_m1_pack", version: "1.0.0" }]);
  });

  it("keeps indexed and legacy results identical across every shape", () => {
    const reports = [];
    for (const workload of workloads) {
      applyContentPackRuntimeSnapshot(workload.registry);
      const legacy = run(workload.state, workload.simulationSeconds, false);
      const indexed = run(workload.state, workload.simulationSeconds, true);
      const repeated = run(workload.state, workload.simulationSeconds, true);
      expect(indexed.hash, workload.id).toBe(legacy.hash);
      expect(repeated.hash, workload.id).toBe(indexed.hash);
      expect(invalidMaterialAmounts(indexed.result), workload.id).toBe(0);
      expect(indexed.result.elapsedSeconds, workload.id)
        .toBeCloseTo(workload.state.elapsedSeconds + workload.simulationSeconds, 6);
      reports.push({
        id: workload.id,
        source: workload.source,
        seconds: workload.simulationSeconds,
        entities: workload.state.entities.length,
        belts: workload.state.belts.length,
        durationMs: Number(indexed.durationMs.toFixed(3)),
        repeatDurationMs: Number(repeated.durationMs.toFixed(3)),
        hash: indexed.hash,
        phases: phaseSummary(indexed.profiler),
        beltRouteChecks: indexed.profiler.beltRouteChecks,
        peerCandidateChecks: indexed.profiler.peerCandidateChecks,
      });
    }
    console.log(`RUNTIMEWORLD_WORKLOAD_MATRIX ${JSON.stringify({ reports })}`);
  }, 120_000);
});

