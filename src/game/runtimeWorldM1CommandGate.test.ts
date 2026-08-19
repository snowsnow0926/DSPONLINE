import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hashGameState } from "./benchmark";
import {
  applyPersistentSimulationRuntimeCommand,
  createPersistentSimulationRuntime,
  createSimulationProfiler,
} from "./engine";
import { createSimulationCommandPatch } from "./simulationRuntimeProtocol";
import { migrateGame } from "./storage";
import type { FactoryEntity, GameState } from "./types";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;

interface CommandGateSample {
  patchMs: number;
  commandMs: number;
  applyMs: number;
  invalidationMs: number;
  compileMs: number;
  rebuilt: boolean;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0;
}

function summarize(samples: readonly CommandGateSample[]) {
  const timing = (key: Exclude<keyof CommandGateSample, "rebuilt">) => ({
    medianMs: rounded(percentile(samples.map((sample) => sample[key]), 0.5)),
    p95Ms: rounded(percentile(samples.map((sample) => sample[key]), 0.95)),
  });
  return {
    samples: samples.length,
    patch: timing("patchMs"),
    command: timing("commandMs"),
    apply: timing("applyMs"),
    invalidation: timing("invalidationMs"),
    compile: timing("compileMs"),
    rebuilds: samples.filter((sample) => sample.rebuilt).length,
  };
}

function changeTopLevel(source: GameState, iteration: number): GameState {
  const viewport = source.planetViewports[source.activePlanetId];
  return {
    ...source,
    planetViewports: {
      ...source.planetViewports,
      [source.activePlanetId]: { ...viewport, x: viewport.x + (iteration % 2 === 0 ? 1 : -1) },
    },
  };
}

function changeEntities(source: GameState, count: number): GameState {
  let remaining = Math.min(count, source.entities.length);
  return {
    ...source,
    entities: source.entities.map((entity): FactoryEntity => {
      if (remaining <= 0) return entity;
      remaining -= 1;
      return { ...entity, interactionLocked: !entity.interactionLocked };
    }),
  };
}

function runScenario(
  source: GameState,
  mutate: (state: GameState, iteration: number) => GameState,
): CommandGateSample[] {
  const runtime = createPersistentSimulationRuntime(structuredClone(source));
  const samples: CommandGateSample[] = [];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const previous = runtime.state;
    const desired = mutate(previous, iteration);
    const expectedHash = hashGameState(desired);
    const patchStartedAt = performance.now();
    const patch = createSimulationCommandPatch(previous, desired, iteration + 1);
    const patchMs = performance.now() - patchStartedAt;
    expect(patch).not.toBeNull();
    const profiler = createSimulationProfiler();
    const commandStartedAt = performance.now();
    const result = applyPersistentSimulationRuntimeCommand(runtime, patch!, profiler);
    const commandMs = performance.now() - commandStartedAt;
    expect(hashGameState(result.state)).toBe(expectedHash);
    samples.push({
      patchMs,
      commandMs,
      applyMs: profiler.commandApplyMs,
      invalidationMs: profiler.domainInvalidationMs,
      compileMs: profiler.compileMs,
      rebuilt: result.cacheRebuilt,
    });
  }
  return samples;
}

describe("RuntimeWorld M1 real-save command gate", () => {
  it.skipIf(!environment?.DSP_M1_REAL_FIXTURE)(
    "meets local-command budgets without a non-topology lookup rebuild",
    () => {
      const raw = readFileSync(environment!.DSP_M1_REAL_FIXTURE!, "utf8");
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

      const scenarios = [
        { kind: "top-level", count: 1, samples: runScenario(source, changeTopLevel) },
        ...([1, 100, 1_000] as const).map((count) => ({
          kind: "entity-non-topology",
          count,
          samples: runScenario(source, (state) => changeEntities(state, count)),
        })),
      ];
      for (const scenario of scenarios) {
        expect(scenario.samples.every((sample) => !sample.rebuilt)).toBe(true);
        expect(scenario.samples.every((sample) => sample.compileMs === 0)).toBe(true);
      }
      const label = environment?.DSP_M1_FIXTURE_LABEL ?? "anonymous";
      const oneRecord = scenarios.slice(0, 2);
      const minimumBudgetMs = label === "A" ? 85 : label === "B" ? 40 : 250;
      for (const scenario of oneRecord) {
        expect(percentile(scenario.samples.slice(1).map((sample) => sample.patchMs + sample.commandMs), 0.5))
          .toBeLessThanOrEqual(minimumBudgetMs);
      }
      expect(hashGameState(source)).toBe(sourceHash);
      console.log(`RUNTIMEWORLD_M1_COMMAND_GATE ${JSON.stringify({
        fixture: label,
        bytes: Buffer.byteLength(raw, "utf8"),
        entities: source.entities.length,
        belts: source.belts.length,
        sourceHash,
        reports: scenarios.map((scenario) => ({
          kind: scenario.kind,
          count: scenario.count,
          cold: Object.fromEntries(Object.entries(scenario.samples[0]).map(([key, value]) => [key, typeof value === "number" ? rounded(value) : value])),
          hot: summarize(scenario.samples.slice(1)),
        })),
      })}`);
    },
    180_000,
  );
});

