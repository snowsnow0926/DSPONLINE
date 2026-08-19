import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advanceSimulationSession,
  createSimulationAdvanceSession,
  type SimulationAdvanceSession,
} from "./engine";
import { migrateGame } from "./storage";
import type { GameState } from "./types";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;

const HORIZONS = [
  { label: "1h", seconds: 60 * 60 },
  { label: "24h", seconds: 24 * 60 * 60 },
  { label: "30d", seconds: 30 * 24 * 60 * 60 },
] as const;

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function invalidAmountCount(state: GameState): number {
  let invalid = 0;
  const inspect = (record: Partial<Record<string, number>>) => {
    for (const value of Object.values(record)) {
      if (!Number.isSafeInteger(value) || Number(value) < 0) invalid += 1;
    }
  };
  for (const tray of Object.values(state.planetTrays)) inspect(tray);
  inspect(state.construction);
  inspect(state.portableFleet);
  inspect(state.constructionAutomation.destroyedByproducts);
  for (const value of Object.values(state.quantumLogisticsNetwork.inventory)) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) invalid += 1;
  }
  for (const entity of state.entities) {
    inspect(entity.inputs);
    inspect(entity.outputs);
    for (const route of entity.stationRoutes ?? []) {
      if (!Number.isSafeInteger(route.cargo) || route.cargo < 0) invalid += 1;
    }
  }
  for (const job of Object.values(state.constructionAutomation.jobs)) inspect(job.inventory);
  return invalid;
}

interface PrefixRun {
  session: SimulationAdvanceSession;
  stepDurationsMs: number[];
  elapsedMs: number;
  stateHash: string;
  invalidAmounts: number;
}

function runDeterministicPrefix(source: GameState, seconds: number, maximumSteps: number): PrefixRun {
  const session = createSimulationAdvanceSession(structuredClone(source), seconds);
  const stepDurationsMs: number[] = [];
  const startedAt = performance.now();
  while (session.remainingSeconds > 1e-9 && stepDurationsMs.length < maximumSteps) {
    const stepStartedAt = performance.now();
    const completed = advanceSimulationSession(session, 1);
    stepDurationsMs.push(performance.now() - stepStartedAt);
    expect(completed).toBe(1);
  }
  return {
    session,
    stepDurationsMs,
    elapsedMs: performance.now() - startedAt,
    stateHash: hashGameState(session.state),
    invalidAmounts: invalidAmountCount(session.state),
  };
}

describe("RuntimeWorld M-1 long-horizon exact-engine baseline", () => {
  it.skipIf(!environment?.DSP_M1_REAL_FIXTURE)(
    "records deterministic bounded prefixes, pending debt, and unyielded segments for 1h/24h/30d",
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
      const maximumSteps = Math.max(1, Math.min(60, Math.floor(Number(environment?.DSP_M1_LONG_HORIZON_PREFIX_STEPS ?? 12))));

      const reports = HORIZONS.map((horizon) => {
        const first = runDeterministicPrefix(source, horizon.seconds, maximumSteps);
        const second = runDeterministicPrefix(source, horizon.seconds, maximumSteps);
        expect(second.stateHash).toBe(first.stateHash);
        expect(second.session.remainingSeconds).toBe(first.session.remainingSeconds);
        expect(second.session.remainingWallSeconds).toBe(first.session.remainingWallSeconds);
        expect(first.invalidAmounts).toBe(0);
        const advancedSeconds = horizon.seconds - first.session.remainingSeconds;
        const maxStepMs = Math.max(0, ...first.stepDurationsMs);
        const projectedFullWallMs = advancedSeconds > 0
          ? first.elapsedMs * horizon.seconds / advancedSeconds
          : Number.POSITIVE_INFINITY;
        return {
          label: horizon.label,
          requestedSeconds: horizon.seconds,
          stepSizeSeconds: first.session.stepSize,
          prefixSteps: first.stepDurationsMs.length,
          advancedSeconds,
          pendingSimulationSeconds: first.session.remainingSeconds,
          pendingWallSeconds: first.session.remainingWallSeconds,
          prefixElapsedMs: rounded(first.elapsedMs),
          maximumUnyieldedStepMs: rounded(maxStepMs),
          projectedFullWallMs: rounded(projectedFullWallMs),
          projectedRealtimeRatio: rounded(projectedFullWallMs / (horizon.seconds * 1_000)),
          deterministicReplay: true,
          invalidAmounts: first.invalidAmounts,
          prefixHash: first.stateHash,
        };
      });

      expect(hashGameState(source)).toBe(sourceHash);
      console.log(`RUNTIMEWORLD_M1_LONG_HORIZON_BASELINE ${JSON.stringify({
        fixture: environment?.DSP_M1_FIXTURE_LABEL ?? "anonymous",
        fixedNowMs,
        bytes: Buffer.byteLength(raw, "utf8"),
        entities: source.entities.length,
        belts: source.belts.length,
        sourceHash,
        maximumSteps,
        reports,
      })}`);
    },
    180_000,
  );
});
