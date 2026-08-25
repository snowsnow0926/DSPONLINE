import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advancePersistentSimulationRuntime, createPersistentSimulationRuntime, createSimulationProfiler } from "./engine";
import { captureSimulationProjectionBaseline, createSimulationProjectionWithBaseline } from "./simulationProjection";
import { inspectSave, migrateGame } from "./storage";

const fixturePath = process.env.DSPIDLE_REAL_SAVE_PATH;
const requestedSteps = Math.max(1, Math.min(60, Number(process.env.DSPIDLE_REAL_SAVE_STEPS ?? 3)));
const realSaveDescribe = fixturePath ? describe : describe.skip;

/**
 * Opt-in release gate for the private 80k/155k player fixture. The path is
 * supplied by the release operator and is never embedded in source or written
 * by this test:
 *
 *   DSPIDLE_REAL_SAVE_PATH=<path> npm test -- --run src/game/v119RealSaveProjectionGate.test.ts
 */
realSaveDescribe("1.1.9 real-save persistent projection gate", () => {
  it("advances the authoritative runtime through bounded compact projections", () => {
    const inspection = inspectSave(readFileSync(fixturePath!, "utf8"));
    const migrated = inspection.state ? migrateGame(inspection.state) : null;
    expect(migrated).not.toBeNull();
    const state = structuredClone(migrated!);
    state.paused = false;
    const runtime = createPersistentSimulationRuntime(state);
    let baseline = captureSimulationProjectionBaseline(runtime.state);
    const metrics: Array<Record<string, number>> = [];

    for (let step = 0; step < requestedSteps; step += 1) {
      const profiler = createSimulationProfiler();
      const advanceStartedAt = performance.now();
      const advanced = advancePersistentSimulationRuntime(runtime, 1, 1, profiler);
      const advanceMs = performance.now() - advanceStartedAt;
      const projectionStartedAt = performance.now();
      const projected = createSimulationProjectionWithBaseline(baseline, advanced.state, { compact: true });
      const projectionMs = performance.now() - projectionStartedAt;
      expect(projected.baseline).toBe(baseline);
      expect(projected.projection.changedEntityIds.length).toBeGreaterThan(0);
      expect(projected.projection.changedBeltIds.length).toBeGreaterThan(0);
      expect(projected.projection.changedEntities).toEqual([]);
      expect(projected.projection.changedBelts).toEqual([]);
      baseline = projected.baseline;
      metrics.push({
        step,
        advanceMs: Math.round(advanceMs),
        projectionMs: Math.round(projectionMs),
        changedEntities: projected.projection.changedEntityIds.length,
        changedBelts: projected.projection.changedBeltIds.length,
        productionMs: Math.round(profiler.productionMs),
        beltsMs: Math.round(profiler.beltsMs),
        logisticsMs: Math.round(profiler.logisticsMs),
        powerMs: Math.round(profiler.powerMs),
        constructionMs: Math.round(profiler.constructionMs),
        historyMs: Math.round(profiler.historyMs),
        beltRouteChecks: profiler.beltRouteChecks,
        beltStableRoutesSkipped: profiler.beltStableRoutesSkipped,
      });
    }
    console.info("v119-real-save-projection-metrics", JSON.stringify(metrics));
  }, 120_000);
});
