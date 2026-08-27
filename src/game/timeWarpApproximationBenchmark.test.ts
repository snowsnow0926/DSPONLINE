import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import {
  runTimeWarpApproximateSettlement,
  runTimeWarpApproximateSettlementInPlace,
  type TimeWarpApproximationReport,
} from "./offlineApproximation";
import { migrateGame } from "./storage";
import {
  createTimeWarpComputeGovernor,
  forceTimeWarpApproximation,
  resolveTimeWarpComputeLimits,
} from "./timeWarpComputeGovernor";

const environment = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env;
const nodeProcess = (globalThis as typeof globalThis & {
  process?: {
    cpuUsage: (previous?: { user: number; system: number }) => { user: number; system: number };
    memoryUsage: () => { heapUsed: number; rss: number };
  };
}).process;

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))];
}

function criticalSnapshot(state: NonNullable<ReturnType<typeof migrateGame>>) {
  return {
    elapsedSeconds: state.elapsedSeconds,
    whiteMatrixProduced: state.totalProduced.universe_matrix ?? 0,
    rocketsLaunched: state.dysonSphere.totalRocketsLaunched,
    structurePoints: state.dysonSphere.structurePoints,
    shellSails: state.dysonSphere.shellSails,
    sailsAbsorbed: state.dysonSphere.totalSailsAbsorbed,
    dysonGenerationKw: state.dysonSphere.generationKw + state.dysonSwarm.generationKw,
  };
}

describe("time-warp approximation real-save benchmark", () => {
  it.skipIf(!environment?.DSP_TIME_WARP_FIXTURES)("runs virtual pure-idle slices without writing supplied saves", () => {
    const fixtures = environment!.DSP_TIME_WARP_FIXTURES!.split(";").map((entry) => entry.trim()).filter(Boolean);
    const wallSeconds = Math.max(1, Math.floor(Number(environment?.DSP_TIME_WARP_WALL_SECONDS ?? 300)));
    const multipliers = (environment?.DSP_TIME_WARP_MULTIPLIERS ?? "8,12,16")
      .split(",")
      .map((value) => Math.floor(Number(value.trim())))
      .filter((value) => Number.isFinite(value) && value > 0);
    const reports = fixtures.map((fixture) => {
      const raw = readFileSync(fixture, "utf8");
      const parsed = JSON.parse(raw) as { state?: unknown };
      const migrated = migrateGame(parsed.state ?? parsed);
      expect(migrated).not.toBeNull();
      if (!migrated) return { fixture, runs: [] };
      migrated.paused = false;
      migrated.timeWarp.enabled = true;
      migrated.timeWarp.pendingSimulationSeconds = 0;
      migrated.timeWarp.pendingWallSeconds = 0;
      return {
        fixture,
        rawBytes: new TextEncoder().encode(raw).byteLength,
        entityCount: migrated.entities.length,
        beltCount: migrated.belts.length,
        runs: multipliers.map((multiplier) => {
          let state = structuredClone(migrated);
          state.timeWarp.requestedMultiplier = multiplier;
          const computeLimits = resolveTimeWarpComputeLimits(
            forceTimeWarpApproximation(createTimeWarpComputeGovernor(state.settings.simulationSpeed), "compute-limit"),
            multiplier,
            multiplier,
            state.settings.simulationSpeed,
          );
          const sliceSimulationSeconds = computeLimits.sliceSimulationSeconds;
          const sourceHash = hashGameState(state);
          const before = criticalSnapshot(state);
          const durations: number[] = [];
          const approximationReports: TimeWarpApproximationReport[] = [];
          let remainingSimulationSeconds = wallSeconds * multiplier;
          let remainingWallSeconds = wallSeconds;
          const cpuBefore = nodeProcess?.cpuUsage() ?? { user: 0, system: 0 };
          const heapBefore = nodeProcess?.memoryUsage().heapUsed ?? 0;
          let peakHeapBytes = heapBefore;
          let peakRssBytes = nodeProcess?.memoryUsage().rss ?? 0;
          const runStartedAt = performance.now();
          while (remainingSimulationSeconds > 1e-9) {
            const simulationSeconds = Math.min(sliceSimulationSeconds, remainingSimulationSeconds);
            const sliceWallSeconds = remainingSimulationSeconds > 0
              ? remainingWallSeconds * simulationSeconds / remainingSimulationSeconds
              : 0;
            const startedAt = performance.now();
            // Match the production simulation Worker: the first slice creates
            // an exact-validated rolling certificate, later slices reuse the
            // same Worker-owned authority in place until its refresh boundary.
            const result = runTimeWarpApproximateSettlementInPlace(state, simulationSeconds, sliceWallSeconds);
            durations.push(performance.now() - startedAt);
            approximationReports.push(result.report);
            state = result.state;
            remainingSimulationSeconds -= simulationSeconds;
            remainingWallSeconds = Math.max(0, remainingWallSeconds - sliceWallSeconds);
            const memory = nodeProcess?.memoryUsage();
            peakHeapBytes = Math.max(peakHeapBytes, memory?.heapUsed ?? peakHeapBytes);
            peakRssBytes = Math.max(peakRssBytes, memory?.rss ?? peakRssBytes);
          }
          const elapsedMs = performance.now() - runStartedAt;
          const cpu = nodeProcess?.cpuUsage(cpuBefore) ?? { user: 0, system: 0 };
          const after = criticalSnapshot(state);
          const approximateSlices = approximationReports.filter((report) => report.mode === "approximate").length;
          const fallbackReasons = [...new Set(approximationReports.map((report) => report.fallbackReason).filter(Boolean))];
          const replay = runTimeWarpApproximateSettlement(
            { ...structuredClone(migrated), timeWarp: { ...migrated.timeWarp, enabled: true, requestedMultiplier: multiplier } },
            Math.min(sliceSimulationSeconds, multiplier * wallSeconds),
            Math.min(sliceSimulationSeconds, multiplier * wallSeconds) / multiplier,
          );
          const first = runTimeWarpApproximateSettlement(
            { ...structuredClone(migrated), timeWarp: { ...migrated.timeWarp, enabled: true, requestedMultiplier: multiplier } },
            Math.min(sliceSimulationSeconds, multiplier * wallSeconds),
            Math.min(sliceSimulationSeconds, multiplier * wallSeconds) / multiplier,
          );
          return {
            multiplier,
            wallSeconds,
            sliceSimulationSeconds,
            sliceCount: durations.length,
            elapsedMs: Math.round(elapsedMs * 100) / 100,
            actualAdvanceMultiplier: (after.elapsedSeconds - before.elapsedSeconds) / wallSeconds,
            durationP50Ms: Math.round(percentile(durations, 0.5) * 100) / 100,
            durationP95Ms: Math.round(percentile(durations, 0.95) * 100) / 100,
            durationMaxMs: Math.round(Math.max(...durations) * 100) / 100,
            approximateSlices,
            rollingCertificateSlices: approximationReports.filter((report) => report.certificateReused).length,
            exactCalibrationSeconds: approximationReports.reduce(
              (sum, report) => sum + report.exactCalibrationSeconds,
              0,
            ),
            exactFallbackSlices: durations.length - approximateSlices,
            approximateRatio: durations.length > 0 ? approximateSlices / durations.length : 0,
            maxCriticalTailError: Math.max(0, ...approximationReports.map((report) => report.maxCriticalError)),
            boundaryCorrections: approximationReports.reduce((sum, report) => sum + report.boundaryCorrections, 0),
            fallbackReasons,
            criticalDelta: {
              whiteMatrixProduced: after.whiteMatrixProduced - before.whiteMatrixProduced,
              rocketsLaunched: after.rocketsLaunched - before.rocketsLaunched,
              structurePoints: after.structurePoints - before.structurePoints,
              shellSails: after.shellSails - before.shellSails,
              sailsAbsorbed: after.sailsAbsorbed - before.sailsAbsorbed,
              dysonGenerationKw: after.dysonGenerationKw - before.dysonGenerationKw,
            },
            cpuUserMs: Math.round(cpu.user / 1_000 * 100) / 100,
            cpuSystemMs: Math.round(cpu.system / 1_000 * 100) / 100,
            peakHeapDeltaBytes: peakHeapBytes - heapBefore,
            peakRssBytes,
            deterministicFirstSlice: hashGameState(first.state) === hashGameState(replay.state),
            sourceUnchanged: hashGameState({ ...migrated, timeWarp: { ...migrated.timeWarp, enabled: true, requestedMultiplier: multiplier } }) === sourceHash,
          };
        }),
      };
    });
    console.log(`TIME_WARP_APPROXIMATION_BENCHMARK ${JSON.stringify(reports)}`);
    expect(reports).toHaveLength(fixtures.length);
  }, 900_000);
});
