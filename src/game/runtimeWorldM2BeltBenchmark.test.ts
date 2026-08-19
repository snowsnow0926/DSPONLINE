import { readFileSync } from "node:fs";
import { Session } from "node:inspector";
import { describe, expect, it, vi } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advancePersistentSimulationRuntime,
  createPersistentSimulationRuntime,
  createSimulationProfiler,
  type BeltRuntimeImplementation,
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

function run(source: GameState, seconds: number, implementation: BeltRuntimeImplementation) {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
  const profiler = createSimulationProfiler();
  const compileStartedAt = performance.now();
  const runtime = createPersistentSimulationRuntime(structuredClone(source), profiler, {
    beltImplementation: implementation,
  });
  const compileWallMs = performance.now() - compileStartedAt;
  const startedAt = performance.now();
  advancePersistentSimulationRuntime(runtime, seconds, seconds, profiler);
  return {
    implementation,
    durationMs: performance.now() - startedAt,
    compileWallMs,
    hash: hashGameState(runtime.state),
    profiler,
    topology: {
      groups: runtime.lookup?.beltRuntime.routeGroups.length ?? 0,
      singleRouteGroups: runtime.lookup?.beltRuntime.routeGroups.filter((group) => group.routes.length === 1).length ?? 0,
      multiRouteGroups: runtime.lookup?.beltRuntime.routeGroups.filter((group) => group.routes.length > 1).length ?? 0,
      singlePriorityMultiRouteGroups: runtime.lookup?.beltRuntime.routeGroups.filter((group) =>
        group.routes.length > 1 && (group.priorityMask & (group.priorityMask - 1)) === 0).length ?? 0,
      targetCapacityGroups: runtime.lookup?.beltRuntime.targetCapacityGroupCount ?? 0,
      activeQueueEnabled: runtime.lookup?.beltRuntime.activeQueueEnabled ?? false,
      compiledFrontierEnabled: runtime.lookup?.beltRuntime.compiledFrontierEnabled ?? false,
      compiledInitiallyDormantRouteCount: runtime.lookup?.beltRuntime.compiledInitiallyDormantRouteCount ?? 0,
      initiallyDormantRouteCount: runtime.lookup?.beltRuntime.initiallyDormantRouteCount ?? 0,
    },
  };
}

type RunResult = ReturnType<typeof run>;

async function captureCpuProfile<T>(execute: () => T): Promise<{
  result: T;
  top: Array<{ samples: number; name: string; url: string; line: number }>;
}> {
  const session = new Session();
  session.connect();
  const post = <R,>(method: string) => new Promise<R>((resolve, reject) => {
    session.post(method as never, (error, value) => error ? reject(error) : resolve(value as R));
  });
  await post("Profiler.enable");
  await post("Profiler.start");
  const result = execute();
  const stopped = await post<{ profile: {
    nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>;
    samples?: number[];
  } }>("Profiler.stop");
  session.disconnect();
  const counts = new Map<number, number>();
  for (const sample of stopped.profile.samples ?? []) counts.set(sample, (counts.get(sample) ?? 0) + 1);
  const top = stopped.profile.nodes
    .map((node) => ({
      samples: counts.get(node.id) ?? 0,
      name: node.callFrame.functionName,
      url: node.callFrame.url,
      line: node.callFrame.lineNumber + 1,
    }))
    .filter((entry) => entry.samples > 0)
    .sort((left, right) => right.samples - left.samples)
    .slice(0, 40);
  return { result, top };
}

describe("RuntimeWorld M2 read-only belt gate", () => {
  it.skipIf(!environment?.DSP_M2_REAL_FIXTURE)(
    "compares compiled and retained belt domains in the same indexed runtime",
    async () => {
      const fixturePath = environment!.DSP_M2_REAL_FIXTURE!;
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
      const seconds = Math.max(1, Math.min(600, Math.floor(Number(environment?.DSP_M2_SECONDS ?? 10))));
      const sampleCount = Math.max(1, Math.min(7, Math.floor(Number(environment?.DSP_M2_SAMPLES ?? 3))));

      if (environment?.DSP_M2_CPU_PROFILE === "true") {
        const profile = await captureCpuProfile(() => run(source, seconds, "compiled"));
        console.log(`RUNTIMEWORLD_M2_CPU_PROFILE ${JSON.stringify(profile.top)}`);
        expect(profile.result.hash.length).toBeGreaterThan(0);
      }

      // One discarded pair warms identical module/JIT paths before measured,
      // alternating samples. No mutable runtime or source state is reused.
      run(source, 1, "legacy");
      run(source, 1, "compiled");
      const legacy: RunResult[] = [];
      const compiled: RunResult[] = [];
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const ordered = sample % 2 === 0
          ? (["legacy", "compiled"] as const)
          : (["compiled", "legacy"] as const);
        const pair = ordered.map((implementation) => run(source, seconds, implementation));
        legacy.push(pair.find((entry) => entry.implementation === "legacy")!);
        compiled.push(pair.find((entry) => entry.implementation === "compiled")!);
      }
      for (let index = 0; index < sampleCount; index += 1) {
        expect(compiled[index].hash).toBe(legacy[index].hash);
      }
      expect(new Set(compiled.map((sample) => sample.hash)).size).toBe(1);
      const median = (samples: typeof legacy, read: (sample: typeof legacy[number]) => number) =>
        percentile(samples.map(read), 0.5);
      const legacyTotal = median(legacy, (sample) => sample.durationMs);
      const compiledTotal = median(compiled, (sample) => sample.durationMs);
      const legacyBelts = median(legacy, (sample) => sample.profiler.beltsMs + sample.profiler.beltReserveMs);
      const compiledBelts = median(compiled, (sample) => sample.profiler.beltsMs + sample.profiler.beltReserveMs);
      const report = {
        fixture: environment?.DSP_M2_FIXTURE_LABEL ?? "anonymous",
        fixturePath,
        bytes: Buffer.byteLength(raw, "utf8"),
        seconds,
        samples: sampleCount,
        entities: source.entities.length,
        belts: source.belts.length,
        sourceHash,
        resultHash: compiled[0].hash,
        topology: compiled[0].topology,
        legacy: {
          totalMedianMs: rounded(legacyTotal),
          beltDomainMedianMs: rounded(legacyBelts),
          totalSamplesMs: legacy.map((sample) => rounded(sample.durationMs)),
          beltSamplesMs: legacy.map((sample) => rounded(sample.profiler.beltsMs + sample.profiler.beltReserveMs)),
          phaseMedianMs: {
            belts: rounded(median(legacy, (sample) => sample.profiler.beltsMs)),
            reserve: rounded(median(legacy, (sample) => sample.profiler.beltReserveMs)),
            scan: rounded(median(legacy, (sample) => sample.profiler.beltScanMs)),
            distribute: rounded(median(legacy, (sample) => sample.profiler.beltDistributeMs)),
            production: rounded(median(legacy, (sample) => sample.profiler.productionMs)),
            power: rounded(median(legacy, (sample) => sample.profiler.powerMs)),
            logistics: rounded(median(legacy, (sample) => sample.profiler.logisticsMs)),
          },
        },
        compiled: {
          totalMedianMs: rounded(compiledTotal),
          beltDomainMedianMs: rounded(compiledBelts),
          totalSamplesMs: compiled.map((sample) => rounded(sample.durationMs)),
          beltSamplesMs: compiled.map((sample) => rounded(sample.profiler.beltsMs + sample.profiler.beltReserveMs)),
          routeChecksPerSecond: rounded(compiled[0].profiler.beltRouteChecks / seconds),
          targetChecksPerSecond: rounded(compiled[0].profiler.beltTargetChecks / seconds),
          activeSourceGroupsPerSecond: rounded(compiled[0].profiler.beltActiveSourceGroups / seconds),
          reservationRouteChecksPerSecond: rounded(compiled[0].profiler.beltReservationRouteChecks / seconds),
          inputStarvedChecksPerSecond: rounded(compiled[0].profiler.beltInputStarvedChecks / seconds),
          outputStarvedChecksPerSecond: rounded(compiled[0].profiler.beltOutputStarvedChecks / seconds),
          targetFullChecksPerSecond: rounded(compiled[0].profiler.beltTargetFullChecks / seconds),
          distributionCandidatesPerSecond: rounded(compiled[0].profiler.beltDistributionCandidates / seconds),
          stableRoutesSkippedPerSecond: rounded(compiled[0].profiler.beltStableRoutesSkipped / seconds),
          phaseMedianMs: {
            belts: rounded(median(compiled, (sample) => sample.profiler.beltsMs)),
            reserve: rounded(median(compiled, (sample) => sample.profiler.beltReserveMs)),
            scan: rounded(median(compiled, (sample) => sample.profiler.beltScanMs)),
            distribute: rounded(median(compiled, (sample) => sample.profiler.beltDistributeMs)),
            production: rounded(median(compiled, (sample) => sample.profiler.productionMs)),
            power: rounded(median(compiled, (sample) => sample.profiler.powerMs)),
            logistics: rounded(median(compiled, (sample) => sample.profiler.logisticsMs)),
          },
        },
        reduction: {
          total: rounded(1 - compiledTotal / legacyTotal),
          beltDomain: rounded(1 - compiledBelts / legacyBelts),
        },
      };
      console.log(`RUNTIMEWORLD_M2_BELT_GATE ${JSON.stringify(report)}`);
      expect(hashGameState(source)).toBe(sourceHash);
      if (environment?.DSP_M2_ENFORCE_GATE === "true") {
        expect(report.reduction.beltDomain).toBeGreaterThanOrEqual(0.35);
        expect(report.reduction.total).toBeGreaterThanOrEqual(0.20);
      }
    },
    360_000,
  );
});
