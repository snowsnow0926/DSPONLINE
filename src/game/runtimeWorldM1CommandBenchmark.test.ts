import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hashGameState } from "./benchmark";
import {
  createPersistentSimulationRuntime,
  createSimulationProfiler,
  replacePersistentSimulationRuntimeState,
} from "./engine";
import {
  applySimulationCommandPatch,
  createSimulationCommandPatch,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import { migrateGame } from "./storage";
import type { BeltConnection, FactoryEntity, GameState } from "./types";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;

interface CommandSample {
  patchMs: number;
  applyMs: number;
  rebuildMs: number;
  lookupBuildMs: number;
  totalMs: number;
}

function percentile(values: readonly number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function summarize(samples: readonly CommandSample[]) {
  const summarizeField = (key: keyof CommandSample) => ({
    medianMs: rounded(percentile(samples.map((sample) => sample[key]), 0.5)),
    p95Ms: rounded(percentile(samples.map((sample) => sample[key]), 0.95)),
  });
  return {
    samples: samples.length,
    patch: summarizeField("patchMs"),
    apply: summarizeField("applyMs"),
    rebuild: summarizeField("rebuildMs"),
    lookupBuild: summarizeField("lookupBuildMs"),
    total: summarizeField("totalMs"),
  };
}

function mutateEntities(source: GameState, count: number): GameState {
  let remaining = Math.min(count, source.entities.length);
  const entities = source.entities.map((entity): FactoryEntity => {
    if (remaining <= 0) return entity;
    remaining -= 1;
    return { ...entity, interactionLocked: !entity.interactionLocked };
  });
  return { ...source, entities };
}

function mutateBeltTopology(source: GameState, count: number): GameState {
  const sourcesByPlanet = new Map<string, string[]>();
  for (const belt of source.belts) {
    const values = sourcesByPlanet.get(belt.planetId) ?? [];
    if (!values.includes(belt.source)) values.push(belt.source);
    sourcesByPlanet.set(belt.planetId, values);
  }
  let remaining = Math.min(count, source.belts.length);
  const belts = source.belts.map((belt): BeltConnection => {
    if (remaining <= 0) return belt;
    const candidates = sourcesByPlanet.get(belt.planetId) ?? [];
    const nextSource = candidates.find((id) => id !== belt.source);
    if (!nextSource) return belt;
    remaining -= 1;
    return { ...belt, source: nextSource };
  });
  return { ...source, belts };
}

function sampleCommand(
  runtime: ReturnType<typeof createPersistentSimulationRuntime>,
  previous: GameState,
  current: GameState,
): { sample: CommandSample; patch: SimulationCommandPatch; applied: GameState } {
  const totalStartedAt = performance.now();
  const patchStartedAt = performance.now();
  const patch = createSimulationCommandPatch(previous, current, 1);
  const patchMs = performance.now() - patchStartedAt;
  expect(patch).not.toBeNull();
  const applyStartedAt = performance.now();
  const applied = applySimulationCommandPatch(previous, patch!);
  const applyMs = performance.now() - applyStartedAt;
  const profiler = createSimulationProfiler();
  const rebuildStartedAt = performance.now();
  replacePersistentSimulationRuntimeState(runtime, applied, profiler);
  const rebuildMs = performance.now() - rebuildStartedAt;
  return {
    sample: {
      patchMs,
      applyMs,
      rebuildMs,
      lookupBuildMs: profiler.stationIndexBuildMs,
      totalMs: performance.now() - totalStartedAt,
    },
    patch: patch!,
    applied,
  };
}

describe("RuntimeWorld M-1 command mutation baseline", () => {
  it.skipIf(!environment?.DSP_M1_REAL_FIXTURE)(
    "records cold and seven hot samples for top-level, record, and topology commands",
    () => {
      const readStartedAt = performance.now();
      const raw = readFileSync(environment!.DSP_M1_REAL_FIXTURE!, "utf8");
      const parsed = JSON.parse(raw);
      const readParseMs = performance.now() - readStartedAt;
      const fixedNowMs = Number.isFinite(Number(parsed?.savedAt)) && Number(parsed.savedAt) > 0
        ? Math.floor(Number(parsed.savedAt))
        : 1_700_000_000_000;
      const dateNow = vi.spyOn(Date, "now").mockReturnValue(fixedNowMs);
      const migrationStartedAt = performance.now();
      let migrated: GameState | null;
      try {
        migrated = migrateGame(parsed.state ?? parsed);
      } finally {
        dateNow.mockRestore();
      }
      const migrationMs = performance.now() - migrationStartedAt;
      expect(migrated).not.toBeNull();
      // Normalize the disposable Worker-only shape once before constructing
      // command oracles. Subsequent rebuild samples must not make the expected
      // state drift merely by filling optional runtime sidecar leaves.
      const source = structuredClone(migrated!);
      source.paused = false;
      source.timeWarp.pendingSimulationSeconds = 0;
      source.timeWarp.pendingWallSeconds = 0;
      const compileProfiler = createSimulationProfiler();
      const compileStartedAt = performance.now();
      createPersistentSimulationRuntime(source, compileProfiler);
      const initialCompileMs = performance.now() - compileStartedAt;

      const scenarios = [
        {
          kind: "top-level-non-topology",
          count: 1,
          current: {
            ...source,
            planetViewports: {
              ...source.planetViewports,
              [source.activePlanetId]: {
                ...source.planetViewports[source.activePlanetId],
                x: source.planetViewports[source.activePlanetId].x + 1,
              },
            },
          },
        },
        ...([1, 100, 1_000] as const).map((count) => ({
          kind: "entity-non-topology",
          count,
          current: mutateEntities(source, count),
        })),
        ...([1, 100, 1_000] as const).map((count) => ({
          kind: "belt-topology",
          count,
          current: mutateBeltTopology(source, count),
        })),
      ];

      const reports = scenarios.map((scenario) => {
        const runtime = createPersistentSimulationRuntime(structuredClone(source));
        const samples = Array.from({ length: 8 }, () => sampleCommand(runtime, source, scenario.current));
        const first = samples[0];
        expect(hashGameState(first.applied)).toBe(hashGameState(scenario.current));
        const expectedChangedRecords = scenario.kind === "entity-non-topology"
          ? first.patch.changedEntities.length
          : scenario.kind === "belt-topology"
            ? first.patch.changedBelts.length
            : first.patch.topLevelChanges.length;
        expect(expectedChangedRecords).toBeGreaterThan(0);
        return {
          kind: scenario.kind,
          requestedRecords: scenario.count,
          changedRecords: expectedChangedRecords,
          cold: Object.fromEntries(Object.entries(first.sample).map(([key, value]) => [key, rounded(value)])),
          hot: summarize(samples.slice(1).map((entry) => entry.sample)),
        };
      });

      console.log(`RUNTIMEWORLD_M1_COMMAND_BASELINE ${JSON.stringify({
        fixture: environment?.DSP_M1_FIXTURE_LABEL ?? "anonymous",
        fixedNowMs,
        bytes: Buffer.byteLength(raw, "utf8"),
        entities: source.entities.length,
        belts: source.belts.length,
        sourceHash: hashGameState(source),
        bootstrap: {
          readParseMs: rounded(readParseMs),
          migrationMs: rounded(migrationMs),
          initialCompileMs: rounded(initialCompileMs),
          lookupBuildMs: rounded(compileProfiler.stationIndexBuildMs),
        },
        reports,
      })}`);
    },
    180_000,
  );
});
