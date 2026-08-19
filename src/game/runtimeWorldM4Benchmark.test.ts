import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advancePersistentSimulationRuntime,
  createPersistentSimulationRuntime,
  createSimulationProfiler,
  getSimulationLogisticsProfilerAttribution,
  getSimulationLogisticsRuntimeDiagnostics,
  type LogisticsRuntimeImplementation,
} from "./engine";
import { migrateGame } from "./storage";
import type { GameState } from "./types";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function run(source: GameState, seconds: number, implementation: LogisticsRuntimeImplementation) {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
  const profiler = createSimulationProfiler();
  const runtime = createPersistentSimulationRuntime(structuredClone(source), profiler, {
    beltImplementation: "compiled",
    powerImplementation: "compiled",
    logisticsImplementation: implementation,
  });
  const startedAt = performance.now();
  advancePersistentSimulationRuntime(runtime, seconds, seconds, profiler);
  return {
    implementation,
    durationMs: performance.now() - startedAt,
    hash: hashGameState(runtime.state),
    profiler,
    attribution: getSimulationLogisticsProfilerAttribution(profiler),
    diagnostics: getSimulationLogisticsRuntimeDiagnostics(runtime.lookup),
  };
}

describe("RuntimeWorld M4 read-only logistics gate", () => {
  it.skipIf(!environment?.DSP_M4_REAL_FIXTURE)(
    "compares compiled and retained logistics paths on one normalized real fixture",
    () => {
      const fixturePath = environment!.DSP_M4_REAL_FIXTURE!;
      const raw = readFileSync(fixturePath, "utf8");
      const parsed = JSON.parse(raw);
      const fixedNowMs = Number.isFinite(Number(parsed?.savedAt)) && Number(parsed.savedAt) > 0
        ? Math.floor(Number(parsed.savedAt))
        : 1_700_000_000_000;
      const dateNow = vi.spyOn(Date, "now").mockReturnValue(fixedNowMs);
      let migrated: GameState | null;
      try {
        migrated = migrateGame(parsed.state ?? parsed);
      } finally {
        dateNow.mockRestore();
      }
      expect(migrated).not.toBeNull();
      const source = structuredClone(migrated!);
      source.paused = false;
      source.timeWarp.pendingSimulationSeconds = 0;
      source.timeWarp.pendingWallSeconds = 0;
      const sourceHash = hashGameState(source);
      const seconds = Math.max(1, Math.min(600, Math.floor(Number(environment?.DSP_M4_SECONDS ?? 10))));
      const sampleCount = Math.max(1, Math.min(7, Math.floor(Number(environment?.DSP_M4_SAMPLES ?? 3))));

      run(source, 1, "legacy");
      run(source, 1, "compiled");
      const legacy: ReturnType<typeof run>[] = [];
      const compiled: ReturnType<typeof run>[] = [];
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const order = sample % 2 === 0 ? (["legacy", "compiled"] as const) : (["compiled", "legacy"] as const);
        for (const implementation of order) {
          const result = run(source, seconds, implementation);
          (implementation === "legacy" ? legacy : compiled).push(result);
        }
      }
      for (let index = 0; index < sampleCount; index += 1) expect(compiled[index].hash).toBe(legacy[index].hash);
      const median = (samples: typeof legacy, select: (sample: typeof legacy[number]) => number) =>
        percentile(samples.map(select), 0.5);
      const legacyTotal = median(legacy, (sample) => sample.durationMs);
      const compiledTotal = median(compiled, (sample) => sample.durationMs);
      const legacyLogistics = median(legacy, (sample) => sample.profiler.logisticsMs + sample.profiler.quantumMs);
      const compiledLogistics = median(compiled, (sample) => sample.profiler.logisticsMs + sample.profiler.quantumMs);
      const report = {
        fixture: environment?.DSP_M4_FIXTURE_LABEL ?? "anonymous",
        fixturePath,
        bytes: Buffer.byteLength(raw, "utf8"),
        seconds,
        samples: sampleCount,
        entities: source.entities.length,
        stations: source.entities.filter((entity) => entity.kind === "station").length,
        sourceHash,
        resultHash: compiled[0].hash,
        logisticsRuntime: compiled[0].diagnostics,
        attribution: {
          legacy: rounded(legacy[0].attribution.attributionRatio),
          compiled: rounded(compiled[0].attribution.attributionRatio),
        },
        legacy: {
          totalMedianMs: rounded(legacyTotal),
          logisticsMedianMs: rounded(legacyLogistics),
        },
        compiled: {
          totalMedianMs: rounded(compiledTotal),
          logisticsMedianMs: rounded(compiledLogistics),
          phases: {
            buffer: rounded(median(compiled, (sample) => sample.profiler.logisticsBufferMs)),
            dispatch: rounded(median(compiled, (sample) => sample.profiler.dispatchMs)),
            routeAdvance: rounded(median(compiled, (sample) => sample.profiler.routeAdvanceMs)),
            congestion: rounded(median(compiled, (sample) => sample.profiler.congestionMs)),
            quantum: rounded(median(compiled, (sample) => sample.profiler.quantumMs)),
            belts: rounded(median(compiled, (sample) => sample.profiler.beltsMs)),
            production: rounded(median(compiled, (sample) => sample.profiler.productionMs)),
            power: rounded(median(compiled, (sample) => sample.profiler.powerMs)),
            dyson: rounded(median(compiled, (sample) => sample.profiler.dysonMs)),
            construction: rounded(median(compiled, (sample) => sample.profiler.constructionMs)),
            history: rounded(median(compiled, (sample) => sample.profiler.historyMs)),
          },
        },
        reduction: {
          total: rounded(1 - compiledTotal / legacyTotal),
          logisticsAndQuantum: rounded(1 - compiledLogistics / legacyLogistics),
        },
      };
      console.log(`RUNTIMEWORLD_M4_LOGISTICS_GATE ${JSON.stringify(report)}`);
      expect(compiled[0].attribution.attributionRatio).toBeGreaterThanOrEqual(0.95);
      expect(legacy[0].attribution.attributionRatio).toBeGreaterThanOrEqual(0.95);
      expect(hashGameState(source)).toBe(sourceHash);
    },
    360_000,
  );
});
