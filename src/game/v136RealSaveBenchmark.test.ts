import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advancePersistentSimulationRuntime,
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createPersistentSimulationRuntime,
  createSimulationAdvanceSession,
  createSimulationProfiler,
} from "./engine";
import { migrateGame } from "./storage";
import type { GameState, ItemId } from "./types";

const environment = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
const nodeProcess = (globalThis as typeof globalThis & {
  process?: { memoryUsage?: () => { heapUsed: number } };
}).process;

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))] ?? 0;
}

function integrity(state: GameState) {
  let invalidAmounts = 0;
  let buffered = 0;
  let routeCargo = 0;
  let finiteVeinRemaining = 0;
  const inspect = (record: Partial<Record<ItemId, number>>) => {
    for (const amount of Object.values(record)) {
      if (!Number.isSafeInteger(amount) || (amount ?? 0) < 0) invalidAmounts += 1;
      else buffered += amount ?? 0;
    }
  };
  for (const entity of state.entities) {
    inspect(entity.inputs);
    inspect(entity.outputs);
    for (const route of entity.stationRoutes ?? []) {
      if (!Number.isSafeInteger(route.cargo) || route.cargo < 0) invalidAmounts += 1;
      else routeCargo += route.cargo;
    }
    if (entity.kind === "vein" && Number.isFinite(entity.resourceRemaining)) {
      const remaining = Math.floor(entity.resourceRemaining ?? 0);
      if (!Number.isSafeInteger(remaining) || remaining < 0) invalidAmounts += 1;
      else finiteVeinRemaining += remaining;
    }
  }
  for (const tray of Object.values(state.planetTrays)) inspect(tray);
  let quantumInventory = 0n;
  for (const amount of Object.values(state.quantumLogisticsNetwork.inventory)) {
    try { quantumInventory += BigInt(amount || "0"); } catch { invalidAmounts += 1; }
  }
  return { invalidAmounts, buffered, routeCargo, finiteVeinRemaining, quantumInventory: quantumInventory.toString() };
}

function gameplayHash(state: GameState): string {
  const { productionHistory: _productionHistory, ...gameplay } = state;
  return hashGameState(gameplay as GameState);
}

describe("1.0.36 read-only real-save benchmark", () => {
  it.skipIf(!environment?.DSP_V136_REAL_FIXTURE)("records exact, steady-slice, memory, hash, and conservation evidence", () => {
    const fixturePath = environment!.DSP_V136_REAL_FIXTURE!;
    const exactSeconds = Math.max(1, Math.min(600, Math.floor(Number(environment?.DSP_V136_EXACT_SECONDS ?? 60))));
    const sliceCount = Math.max(0, Math.min(120, Math.floor(Number(environment?.DSP_V136_SLICE_COUNT ?? 60))));
    const raw = readFileSync(fixturePath, "utf8");
    const parsed = JSON.parse(raw);
    // A pre-v47 save creates its initial station contract board during
    // migration. Freeze that wall clock to the immutable envelope timestamp so
    // independent cold-process samples start from the exact same GameState.
    // This is benchmark isolation only; product migration semantics are not
    // changed.
    const requestedFixedNowMs = Number(environment?.DSP_V136_FIXED_NOW_MS);
    const envelopeSavedAt = Number(parsed?.savedAt);
    const fixedMigrationNowMs = Number.isFinite(requestedFixedNowMs) && requestedFixedNowMs > 0
      ? Math.floor(requestedFixedNowMs)
      : Number.isFinite(envelopeSavedAt) && envelopeSavedAt > 0
        ? Math.floor(envelopeSavedAt)
        : 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(fixedMigrationNowMs);
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
    const heapBeforeBytes = nodeProcess?.memoryUsage?.().heapUsed ?? 0;

    const profiler = createSimulationProfiler();
    const exactStartedAt = performance.now();
    const exactSession = createSimulationAdvanceSession(structuredClone(source), exactSeconds, { profiler });
    advanceSimulationSession(exactSession, Number.MAX_SAFE_INTEGER);
    const exactState = completeSimulationAdvanceSession(exactSession);
    const exactDurationMs = performance.now() - exactStartedAt;

    const slices: number[] = [];
    let sliceState: GameState | null = null;
    if (sliceCount > 0) {
      const runtime = createPersistentSimulationRuntime(structuredClone(source));
      for (let index = 0; index < sliceCount; index += 1) {
        const startedAt = performance.now();
        advancePersistentSimulationRuntime(runtime, 1, 1);
        slices.push(performance.now() - startedAt);
      }
      sliceState = runtime.state;
    }

    const planets = new Map<string, { entities: number; belts: number; stations: number }>();
    for (const entity of source.entities) {
      const counts = planets.get(entity.planetId) ?? { entities: 0, belts: 0, stations: 0 };
      counts.entities += 1;
      if (entity.kind === "station") counts.stations += 1;
      planets.set(entity.planetId, counts);
    }
    for (const belt of source.belts) {
      const counts = planets.get(belt.planetId) ?? { entities: 0, belts: 0, stations: 0 };
      counts.belts += 1;
      planets.set(belt.planetId, counts);
    }
    const densest = [...planets].sort((left, right) =>
      right[1].belts - left[1].belts || right[1].entities - left[1].entities || left[0].localeCompare(right[0]))[0];
    const exactIntegrity = integrity(exactState);
    const report = {
      fixture: fixturePath,
      bytes: new TextEncoder().encode(raw).byteLength,
      fixedMigrationNowMs,
      gameStateVersion: source.version,
      entities: source.entities.length,
      belts: source.belts.length,
      stations: source.entities.filter((entity) => entity.kind === "station").length,
      planets: planets.size,
      activePlanetId: source.activePlanetId,
      activePlanet: planets.get(source.activePlanetId),
      densestPlanet: densest ? { planetId: densest[0], ...densest[1] } : null,
      workerPayloadBytes: new TextEncoder().encode(JSON.stringify(source)).byteLength,
      sourceGameplayHash: gameplayHash(source),
      heap: { beforeBytes: heapBeforeBytes, afterBytes: nodeProcess?.memoryUsage?.().heapUsed ?? 0 },
      exact: {
        seconds: exactSeconds,
        durationMs: Number(exactDurationMs.toFixed(3)),
        hash: hashGameState(exactState),
        gameplayHash: gameplayHash(exactState),
        profiler,
        integrity: exactIntegrity,
      },
      slices: {
        count: slices.length,
        p50Ms: Number(percentile(slices, 0.5).toFixed(3)),
        p95Ms: Number(percentile(slices, 0.95).toFixed(3)),
        maxMs: Number(Math.max(0, ...slices).toFixed(3)),
        hash: sliceState ? hashGameState(sliceState) : null,
        gameplayHash: sliceState ? gameplayHash(sliceState) : null,
        integrity: sliceState ? integrity(sliceState) : null,
      },
    };
    console.log(`V136_REAL_SAVE_BENCHMARK ${JSON.stringify(report)}`);
    expect(source.version).toBe(47);
    expect(exactState.elapsedSeconds).toBeCloseTo(source.elapsedSeconds + exactSeconds, 6);
    expect(exactIntegrity.invalidAmounts).toBe(0);
    if (sliceState && sliceCount === exactSeconds) expect(report.slices.gameplayHash).toBe(report.exact.gameplayHash);
    if (environment?.DSP_V136_EXPECTED_HASH) expect(report.exact.hash).toBe(environment.DSP_V136_EXPECTED_HASH);
  }, 180_000);
});
