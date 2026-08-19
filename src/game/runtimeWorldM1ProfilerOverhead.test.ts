import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advancePersistentSimulationRuntime,
  createPersistentSimulationRuntime,
  createSimulationProfiler,
} from "./engine";
import type { SimulationProfiler } from "./engine";
import { migrateGame } from "./storage";
import type { GameState } from "./types";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

describe("RuntimeWorld M-1 profiler overhead", () => {
  it.skipIf(!environment?.DSP_M1_REAL_FIXTURE)(
    "compares paired persistent runtimes with diagnostics off and on",
    () => {
      const parsed = JSON.parse(readFileSync(environment!.DSP_M1_REAL_FIXTURE!, "utf8"));
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
      const off = createPersistentSimulationRuntime(structuredClone(source));
      const on = createPersistentSimulationRuntime(structuredClone(source));
      for (let index = 0; index < 2; index += 1) {
        advancePersistentSimulationRuntime(off, 1, 1);
        advancePersistentSimulationRuntime(on, 1, 1, createSimulationProfiler());
      }
      const offMs: number[] = [];
      const onMs: number[] = [];
      const profilers: SimulationProfiler[] = [];
      for (let index = 0; index < 7; index += 1) {
        const runOff = () => {
          const startedAt = performance.now();
          advancePersistentSimulationRuntime(off, 1, 1);
          offMs.push(performance.now() - startedAt);
        };
        const runOn = () => {
          const profiler = createSimulationProfiler();
          const startedAt = performance.now();
          advancePersistentSimulationRuntime(on, 1, 1, profiler);
          onMs.push(performance.now() - startedAt);
          profilers.push(profiler);
        };
        if (index % 2 === 0) {
          runOff();
          runOn();
        } else {
          runOn();
          runOff();
        }
      }
      const offMedianMs = median(offMs);
      const onMedianMs = median(onMs);
      const report = {
        fixture: environment?.DSP_M1_FIXTURE_LABEL ?? "anonymous",
        warmupSteps: 2,
        samples: 7,
        offMs: offMs.map((value) => Number(value.toFixed(3))),
        onMs: onMs.map((value) => Number(value.toFixed(3))),
        offMedianMs: Number(offMedianMs.toFixed(3)),
        onMedianMs: Number(onMedianMs.toFixed(3)),
        medianOverheadRatio: Number((offMedianMs > 0 ? onMedianMs / offMedianMs - 1 : 0).toFixed(4)),
        attributedMedianMs: Number(median(profilers.map((profiler) =>
          profiler.productionMs + profiler.beltsMs + profiler.logisticsMs + profiler.quantumMs +
          profiler.powerMs + profiler.dysonMs + profiler.constructionMs + profiler.historyMs,
        )).toFixed(3)),
      };
      console.log(`RUNTIMEWORLD_M1_PROFILER_OVERHEAD ${JSON.stringify(report)}`);
      expect(hashGameState(on.state)).toBe(hashGameState(off.state));
      expect(profilers.every((profiler) => Object.values(profiler).every((value) => Number.isFinite(value) && value >= 0))).toBe(true);
    },
    120_000,
  );
});
