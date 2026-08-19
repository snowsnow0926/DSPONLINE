import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advancePersistentSimulationRuntime,
  createPersistentSimulationRuntime,
  createSimulationProfiler,
  getSimulationMachineRuntimeDiagnostics,
  type PowerRuntimeImplementation,
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

function run(source: GameState, seconds: number, implementation: PowerRuntimeImplementation) {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
  const profiler = createSimulationProfiler();
  const runtime = createPersistentSimulationRuntime(structuredClone(source), profiler, {
    beltImplementation: "compiled",
    powerImplementation: implementation,
  });
  const startedAt = performance.now();
  advancePersistentSimulationRuntime(runtime, seconds, seconds, profiler);
  return {
    implementation,
    durationMs: performance.now() - startedAt,
    hash: hashGameState(runtime.state),
    profiler,
    diagnostics: getSimulationMachineRuntimeDiagnostics(runtime.lookup),
  };
}

describe("RuntimeWorld M3 read-only production/power gate", () => {
  it.skipIf(!environment?.DSP_M3_REAL_FIXTURE)(
    "compares compiled and retained power paths on one normalized real fixture",
    () => {
      const fixturePath = environment!.DSP_M3_REAL_FIXTURE!;
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
      const seconds = Math.max(1, Math.min(600, Math.floor(Number(environment?.DSP_M3_SECONDS ?? 10))));
      const sampleCount = Math.max(1, Math.min(7, Math.floor(Number(environment?.DSP_M3_SAMPLES ?? 3))));

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
      const report = {
        fixture: environment?.DSP_M3_FIXTURE_LABEL ?? "anonymous",
        fixturePath,
        bytes: Buffer.byteLength(raw, "utf8"),
        seconds,
        samples: sampleCount,
        entities: source.entities.length,
        sourceHash,
        resultHash: compiled[0].hash,
        machineRuntime: compiled[0].diagnostics,
        legacy: {
          totalMedianMs: rounded(legacyTotal),
          powerMedianMs: rounded(median(legacy, (sample) => sample.profiler.powerMs)),
          productionMedianMs: rounded(median(legacy, (sample) => sample.profiler.productionMs)),
        },
        compiled: {
          totalMedianMs: rounded(compiledTotal),
          powerMedianMs: rounded(median(compiled, (sample) => sample.profiler.powerMs)),
          productionMedianMs: rounded(median(compiled, (sample) => sample.profiler.productionMs)),
        },
        reduction: {
          total: rounded(1 - compiledTotal / legacyTotal),
          powerAndProduction: rounded(1 -
            (median(compiled, (sample) => sample.profiler.powerMs + sample.profiler.productionMs) /
              median(legacy, (sample) => sample.profiler.powerMs + sample.profiler.productionMs))),
        },
      };
      console.log(`RUNTIMEWORLD_M3_POWER_GATE ${JSON.stringify(report)}`);
      expect(hashGameState(source)).toBe(sourceHash);
    },
    360_000,
  );
});
