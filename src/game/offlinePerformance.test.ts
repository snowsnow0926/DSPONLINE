import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advancePersistentSimulationRuntime,
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createPersistentSimulationRuntime,
  createSimulationAdvanceSession,
  createSimulationProfiler,
} from "./engine";
import { exportGame, importGame, inspectSave, migrateGame } from "./storage";
import { getNextOfflineCriticalEvent } from "./offlineCriticalEvents";
import { advanceOfflineSimulationChunk } from "./offlineSimulation";
import { hashGameState } from "./benchmark";
import { advancePureIdleMacroSession, createConservativePureIdleMacroSession } from "./pureIdleMacro";
import { normalizeQuantumLogisticsNetworkState } from "./quantumLogisticsNetwork";
import type { GameState } from "./types";

const environment = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;

describe("offline exact scheduler benchmark", () => {
  it.skipIf(!environment?.DSP_OFFLINE_BENCHMARK || !environment.DSP_REAL_FIXTURE)(
    "compares legacy critical scans with the five-second batched scheduler",
    () => {
      const raw = readFileSync(environment!.DSP_REAL_FIXTURE!, "utf8");
      const parsed = JSON.parse(raw);
      const migrated = migrateGame(parsed.state ?? parsed);
      expect(migrated).not.toBeNull();
      const source = migrated!;
      source.paused = false;
      source.timeWarp.pendingSimulationSeconds = 0;
      source.timeWarp.pendingWallSeconds = 0;
      const run = (seconds: number, optimized: boolean) => {
        const session = createSimulationAdvanceSession(structuredClone(source), seconds);
        const startedAt = performance.now();
        while (session.remainingSeconds > 0) {
          if (optimized) {
            advanceOfflineSimulationChunk(session, { maximumWindowSeconds: 256 });
          } else {
            const event = getNextOfflineCriticalEvent(session.state, session.remainingSeconds, 256);
            advanceSimulationSession(session, event?.seconds ?? 256);
          }
        }
        const result = completeSimulationAdvanceSession(session);
        return { durationMs: performance.now() - startedAt, hash: hashGameState(result) };
      };
      const reports = [5, 10, 60, 600].map((seconds) => ({
        seconds,
        legacy: run(seconds, false),
        optimized: run(seconds, true),
      }));
      expect(reports.every((report) => report.legacy.hash === report.optimized.hash)).toBe(true);
      console.log(`OFFLINE_SCHEDULER_BENCHMARK ${JSON.stringify({ reports })}`);
    },
    180_000,
  );

  it.skipIf(!environment?.DSP_OFFLINE_PROFILE || !environment.DSP_REAL_FIXTURE)(
    "profiles the indexed exact path",
    () => {
      const raw = readFileSync(environment!.DSP_REAL_FIXTURE!, "utf8");
      const parsed = JSON.parse(raw);
      const migrated = migrateGame(parsed.state ?? parsed);
      expect(migrated).not.toBeNull();
      if (!migrated) return;
      migrated.paused = false;
      migrated.timeWarp.pendingSimulationSeconds = 0;
      migrated.timeWarp.pendingWallSeconds = 0;
      const profiler = createSimulationProfiler();
      const session = createSimulationAdvanceSession(structuredClone(migrated), 60, { profiler });
      const startingElapsed = session.state.elapsedSeconds;
      const startedAt = performance.now();
      while (session.remainingSeconds > 0) advanceOfflineSimulationChunk(session, { maximumWindowSeconds: 256 });
      const result = completeSimulationAdvanceSession(session);
      console.log(`OFFLINE_EXACT_PROFILE ${JSON.stringify({ durationMs: performance.now() - startedAt, hash: hashGameState(result), profiler })}`);
      expect(result.elapsedSeconds).toBeCloseTo(startingElapsed + 60, 6);
    },
    120_000,
  );

  it.skipIf(!environment?.DSP_CONSTRUCTION_STABILITY_PROFILE || !environment.DSP_REAL_FIXTURE)(
    "profiles bounded realtime slices and save reload determinism",
    () => {
      const raw = readFileSync(environment!.DSP_REAL_FIXTURE!, "utf8");
      const parsed = JSON.parse(raw);
      const migrated = migrateGame(parsed.state ?? parsed);
      expect(migrated).not.toBeNull();
      if (!migrated) return;
      migrated.paused = false;
      migrated.timeWarp.pendingSimulationSeconds = 0;
      migrated.timeWarp.pendingWallSeconds = 0;

      const runSegmented = () => {
        const runtime = createPersistentSimulationRuntime(structuredClone(migrated));
        const durations: number[] = [];
        const totals = {
          constructionMs: 0,
          planBuilds: 0,
          planCacheHits: 0,
          guardHits: 0,
          iterations: 0,
        };
        for (let second = 0; second < 60; second += 1) {
          const profiler = createSimulationProfiler();
          const startedAt = performance.now();
          advancePersistentSimulationRuntime(runtime, 1, 1, profiler);
          durations.push(performance.now() - startedAt);
          totals.constructionMs += profiler.constructionMs;
          totals.planBuilds += profiler.constructionPlanBuilds;
          totals.planCacheHits += profiler.constructionPlanCacheHits;
          totals.guardHits += profiler.constructionGuardHits;
          totals.iterations += profiler.constructionIterations;
        }
        return { state: runtime.state, durations, totals };
      };
      const first = runSegmented();
      const second = runSegmented();
      const sorted = [...first.durations].sort((left, right) => left - right);
      const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
      const invalidAmounts: string[] = [];
      const inspectRecord = (label: string, record: Partial<Record<string, number>>) => {
        for (const [key, value] of Object.entries(record)) {
          const amount = Number(value);
          if (!Number.isSafeInteger(amount) || amount < 0) invalidAmounts.push(`${label}.${key}=${value}`);
        }
      };
      for (const [planetId, tray] of Object.entries(first.state.planetTrays)) inspectRecord(`planetTrays.${planetId}`, tray);
      inspectRecord("construction", first.state.construction);
      inspectRecord("portableFleet", first.state.portableFleet);
      inspectRecord("destroyedByproducts", first.state.constructionAutomation.destroyedByproducts);
      for (const entity of first.state.entities) {
        inspectRecord(`entities.${entity.id}.inputs`, entity.inputs);
        inspectRecord(`entities.${entity.id}.outputs`, entity.outputs);
        for (const route of entity.stationRoutes ?? []) {
          if (!Number.isSafeInteger(route.cargo) || route.cargo < 0) invalidAmounts.push(`routes.${route.id}.cargo=${route.cargo}`);
        }
      }
      for (const [entityId, job] of Object.entries(first.state.constructionAutomation.jobs)) {
        inspectRecord(`jobs.${entityId}`, job.inventory);
      }
      const exported = exportGame(first.state);
      const reloaded = importGame(exported);
      const reloadedRaw = reloaded ? exportGame(reloaded) : null;
      const conservedSnapshot = (state: GameState) => {
        const { runtimeFlow: _runtimeFlow, ...quantumLogisticsNetwork } = state.quantumLogisticsNetwork;
        return ({
        version: state.version,
        elapsedSeconds: state.elapsedSeconds,
        entities: state.entities.map((entity) => ({
          id: entity.id,
          planetId: entity.planetId,
          kind: entity.kind,
          buildingId: entity.buildingId,
          machineCount: entity.machineCount,
          minerCount: entity.minerCount,
          inputs: entity.inputs,
          outputs: entity.outputs,
          stationDrones: entity.stationDrones,
          stationVessels: entity.stationVessels,
          stationWarpers: entity.stationWarpers,
          stationRoutes: entity.stationRoutes,
        })),
        belts: state.belts.map((belt) => ({
          id: belt.id,
          source: belt.source,
          target: belt.target,
          itemId: belt.itemId,
          lanes: belt.lanes,
          progress: belt.progress,
          totalTransferred: belt.totalTransferred,
          lastFlow: belt.lastFlow,
        })),
        planetTrays: { ...state.planetTrays, [state.activePlanetId]: state.tray },
        construction: state.construction,
        constructionAutomation: state.constructionAutomation,
        portableFleet: state.portableFleet,
        cargo: state.cargo,
        totalProduced: state.totalProduced,
        research: state.research,
        quantumLogisticsNetwork,
        });
      };
      expect(reloaded).not.toBeNull();
      expect(hashGameState(first.state)).toBe(hashGameState(second.state));
      expect(reloaded && conservedSnapshot(reloaded)).toEqual(conservedSnapshot(first.state));
      expect(inspectSave(exported).checksum).toBe("valid");
      expect(reloadedRaw && inspectSave(reloadedRaw).checksum).toBe("valid");
      expect(first.state.elapsedSeconds).toBeCloseTo(migrated.elapsedSeconds + 60, 6);
      expect(Math.max(...first.durations)).toBeLessThan(2_000);
      expect(invalidAmounts).toEqual([]);
      console.log(`CONSTRUCTION_STABILITY_PROFILE ${JSON.stringify({
        totalMs: first.durations.reduce((sum, duration) => sum + duration, 0),
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: Math.max(...first.durations),
        hash: hashGameState(first.state),
        saveReloadChecksumValid: Boolean(reloadedRaw && inspectSave(reloadedRaw).checksum === "valid"),
        jobs: Object.keys(first.state.constructionAutomation.jobs).length,
        totalCrafted: first.state.constructionAutomation.totalCrafted,
        invalidAmountCount: invalidAmounts.length,
        ...first.totals,
      })}`);
    },
    120_000,
  );

  it.skipIf(!environment?.DSP_CONSTRUCTION_STABILITY_PROFILE || !environment.DSP_REAL_FIXTURE)(
    "keeps gameplay state identical between one 60-second request and sixty one-second requests",
    () => {
      const raw = readFileSync(environment!.DSP_REAL_FIXTURE!, "utf8");
      const parsed = JSON.parse(raw);
      const migrated = migrateGame(parsed.state ?? parsed);
      expect(migrated).not.toBeNull();
      if (!migrated) return;
      migrated.paused = false;
      migrated.timeWarp.pendingSimulationSeconds = 0;
      migrated.timeWarp.pendingWallSeconds = 0;

      const continuousRuntime = createPersistentSimulationRuntime(structuredClone(migrated));
      advancePersistentSimulationRuntime(continuousRuntime, 60, 60);
      const segmentedRuntime = createPersistentSimulationRuntime(structuredClone(migrated));
      for (let second = 0; second < 60; second += 1) {
        advancePersistentSimulationRuntime(segmentedRuntime, 1, 1);
      }

      const withoutSamplingHistory = (state: GameState) => {
        const { productionHistory: _productionHistory, ...gameplayState } = state;
        return gameplayState;
      };
      const differingTopLevelKeys = Object.keys(continuousRuntime.state).filter((key) =>
        JSON.stringify(continuousRuntime.state[key as keyof GameState]) !==
        JSON.stringify(segmentedRuntime.state[key as keyof GameState]),
      );

      expect(withoutSamplingHistory(segmentedRuntime.state)).toEqual(withoutSamplingHistory(continuousRuntime.state));
      expect(differingTopLevelKeys).toEqual(["productionHistory"]);
      expect(continuousRuntime.state.historyRecordedAt).toBe(segmentedRuntime.state.historyRecordedAt);
      console.log(`CONSTRUCTION_SEGMENTATION_EQUIVALENCE ${JSON.stringify({
        continuousHash: hashGameState(continuousRuntime.state),
        segmentedHash: hashGameState(segmentedRuntime.state),
        differingTopLevelKeys,
        continuousHistorySamples: continuousRuntime.state.productionHistory.length,
        segmentedHistorySamples: segmentedRuntime.state.productionHistory.length,
      })}`);
    },
    120_000,
  );

  it.skipIf(!environment?.DSP_CONSERVATIVE_CONSTRUCTION_PROFILE || !environment.DSP_REAL_FIXTURE)(
    "keeps real-save construction progressing in the conservative pure-idle tail",
    () => {
      const raw = readFileSync(environment!.DSP_REAL_FIXTURE!, "utf8");
      const parsed = JSON.parse(raw);
      const state = migrateGame(parsed.state ?? parsed);
      expect(state).not.toBeNull();
      if (!state) return;
      state.paused = false;
      state.timeWarp.pendingSimulationSeconds = 0;
      state.timeWarp.pendingWallSeconds = 0;
      const controller = state.entities.find((entity) => entity.buildingId === "time_warp_device");
      expect(controller).toBeDefined();
      if (!controller) return;
      state.timeWarp.controllerEntityId = controller.id;
      state.timeWarp.enabled = true;
      const targetDeficit = (candidate: GameState) => Object.entries(candidate.constructionAutomation.targetStock)
        .reduce((sum, [targetId, target]) => {
          const current = Object.prototype.hasOwnProperty.call(candidate.portableFleet, targetId)
            ? candidate.portableFleet[targetId as keyof typeof candidate.portableFleet] ?? 0
            : candidate.construction[targetId as keyof typeof candidate.construction] ?? 0;
          return sum + Math.max(0, Math.floor(target ?? 0) - Math.max(0, Math.floor(current)));
        }, 0);
      const deficitBefore = targetDeficit(state);
      const craftedBefore = state.constructionAutomation.totalCrafted;
      const startedAt = performance.now();
      console.log(`CONSERVATIVE_CONSTRUCTION_STAGE ${JSON.stringify({ stage: "prefix-start", deficitBefore })}`);
      const session = createConservativePureIdleMacroSession(state, "stable", "real-save large-memory guard");
      console.log(`CONSERVATIVE_CONSTRUCTION_STAGE ${JSON.stringify({
        stage: "prefix-complete",
        durationMs: performance.now() - startedAt,
        prefixCrafted: session.candidate.constructionAutomation.totalCrafted - craftedBefore,
      })}`);
      advancePureIdleMacroSession(session, 30);
      const durationMs = performance.now() - startedAt;
      const deficitAfter = targetDeficit(session.candidate);
      const crafted = session.candidate.constructionAutomation.totalCrafted - craftedBefore;
      const exported = exportGame(session.candidate);
      const reloaded = importGame(exported);

      expect(crafted).toBeGreaterThan(0);
      expect(deficitAfter).toBeLessThan(deficitBefore);
      expect(session.candidate.elapsedSeconds).toBeGreaterThan(state.elapsedSeconds);
      expect(inspectSave(exported).checksum).toBe("valid");
      expect(reloaded).not.toBeNull();
      expect(reloaded?.constructionAutomation.totalCrafted).toBe(session.candidate.constructionAutomation.totalCrafted);
      expect(reloaded?.constructionAutomation.targetStock).toEqual(session.candidate.constructionAutomation.targetStock);
      expect(reloaded?.quantumLogisticsNetwork.inventory).toEqual(
        normalizeQuantumLogisticsNetworkState(session.candidate.quantumLogisticsNetwork).inventory,
      );
      console.log(`CONSERVATIVE_CONSTRUCTION_PROFILE ${JSON.stringify({
        durationMs,
        exportedBytes: Buffer.byteLength(exported),
        actualMultiplier: session.actualMultiplier,
        deficitBefore,
        deficitAfter,
        crafted,
        remainingJobs: Object.keys(session.candidate.constructionAutomation.jobs).length,
        remainingBuffers: Object.keys(session.candidate.constructionAutomation.quantumMaterialBuffer ?? {}).length,
      })}`);
    },
    180_000,
  );
});
