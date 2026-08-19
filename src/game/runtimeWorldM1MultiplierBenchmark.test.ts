import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advancePersistentSimulationRuntime,
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createPersistentSimulationRuntime,
  createSimulationAdvanceSession,
} from "./engine";
import { migrateGame } from "./storage";
import type { GameState } from "./types";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;

function percentile(values: readonly number[], ratio: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))] ?? 0;
}

describe("RuntimeWorld M-1 simulation multiplier baseline", () => {
  it.skipIf(!environment?.DSP_M1_REAL_FIXTURE)(
    "records 1x, 4x, and 11x unyielded and deterministic-boundary durations",
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
      // Establish the same Worker-only optional runtime shape before branching
      // into monolithic and one-boundary-at-a-time executions.
      createPersistentSimulationRuntime(source);

      const reports = ([1, 4, 11] as const).map((multiplier) => {
        const monolithicMs: number[] = [];
        const boundaryMaxMs: number[] = [];
        const boundaryTotalsMs: number[] = [];
        const hashes: string[] = [];
        for (let sample = 0; sample < 3; sample += 1) {
          const runtime = createPersistentSimulationRuntime(structuredClone(source));
          const monolithicStartedAt = performance.now();
          const monolithic = advancePersistentSimulationRuntime(runtime, multiplier, 1);
          monolithicMs.push(performance.now() - monolithicStartedAt);
          expect(monolithic.state.timeWarp.pendingSimulationSeconds).toBe(0);
          expect(monolithic.state.timeWarp.pendingWallSeconds).toBe(0);

          const session = createSimulationAdvanceSession(structuredClone(source), multiplier, {
            wallSeconds: 1,
            mutateState: true,
          });
          const stepMs: number[] = [];
          const segmentedStartedAt = performance.now();
          while (session.remainingSeconds > 1e-9) {
            const stepStartedAt = performance.now();
            const steps = advanceSimulationSession(session, 1);
            stepMs.push(performance.now() - stepStartedAt);
            expect(steps).toBe(1);
          }
          const segmented = completeSimulationAdvanceSession(session);
          boundaryTotalsMs.push(performance.now() - segmentedStartedAt);
          boundaryMaxMs.push(Math.max(0, ...stepMs));
          const monolithicHash = hashGameState(monolithic.state);
          expect(hashGameState(segmented)).toBe(monolithicHash);
          hashes.push(monolithicHash);
        }
        expect(new Set(hashes).size).toBe(1);
        return {
          multiplier,
          simulationSeconds: multiplier,
          wallSeconds: 1,
          samples: 3,
          monolithicMs: monolithicMs.map((value) => Number(value.toFixed(3))),
          monolithicP50Ms: Number(percentile(monolithicMs, 0.5).toFixed(3)),
          monolithicP95Ms: Number(percentile(monolithicMs, 0.95).toFixed(3)),
          currentMaximumUnyieldedP95Ms: Number(percentile(monolithicMs, 0.95).toFixed(3)),
          deterministicBoundaryMaximumP95Ms: Number(percentile(boundaryMaxMs, 0.95).toFixed(3)),
          segmentedTotalP50Ms: Number(percentile(boundaryTotalsMs, 0.5).toFixed(3)),
          worstCaseQueuedCommandWaitP95Ms: Number(percentile(monolithicMs, 0.95).toFixed(3)),
          pendingSimulationSeconds: 0,
          hash: hashes[0],
        };
      });
      console.log(`RUNTIMEWORLD_M1_MULTIPLIER_BASELINE ${JSON.stringify({
        fixture: environment?.DSP_M1_FIXTURE_LABEL ?? "anonymous",
        reports,
      })}`);
    },
    180_000,
  );
});
