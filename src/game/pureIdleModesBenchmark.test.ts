import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as macro from "./pureIdleMacro";
import { createPersistentSimulationRuntime, advancePersistentSimulationRuntime, refreshTimeWarpPowerSnapshotInPlace } from "./engine";
import { capturePureIdleReplicationTelemetry } from "./pureIdleReplicationTelemetry";
import { ITEMS } from "./content";
import { migrateGame, serializeEnvelope } from "./storage";
import type { GameState } from "./types";

const fixturePath = process.env.DSP_PURE_IDLE_MODES_FIXTURE;
const preparedPath = process.env.DSP_PURE_IDLE_MODES_PREPARED;
const materialStress = process.env.DSP_PURE_IDLE_MODES_MATERIAL_STRESS === "1";

describe.skipIf(!fixturePath)("two pure-idle modes on the same private workload", () => {
  it("compares startup, repeated buckets and finalization without writing the supplied save", { timeout: 900_000 }, async () => {
    const raw = readFileSync(fixturePath!, "utf8");
    const sourceSha256 = createHash("sha256").update(raw).digest("hex");
    let prepared: GameState;
    if (preparedPath && existsSync(preparedPath)) {
      const saved = JSON.parse(readFileSync(preparedPath, "utf8"));
      expect(saved.sourceSha256).toBe(sourceSha256);
      prepared = saved.state;
    } else {
      const parsed = JSON.parse(raw);
      const state = migrateGame(parsed.state ?? parsed)!;
      const constructionEnabled = state.constructionAutomation.enabled;
      state.paused = false;
      state.timeWarp.enabled = false;
      state.constructionAutomation.enabled = false;
      const start = state.elapsedSeconds;
      const initialTelemetry = capturePureIdleReplicationTelemetry(state)!;
      const initialPower = { generationKw: state.metrics.generationKw, demandKw: state.metrics.demandKw };
      const runtime = createPersistentSimulationRuntime(state);
      advancePersistentSimulationRuntime(runtime, 30, 30);
      prepared = runtime.state;
      prepared.productionHistory = [
        { elapsedSeconds: start, ...initialPower, productionPerMinute: {}, consumptionPerMinute: {}, inventory: {}, pureIdleReplication: initialTelemetry },
        { elapsedSeconds: prepared.elapsedSeconds, generationKw: prepared.metrics.generationKw, demandKw: prepared.metrics.demandKw,
          productionPerMinute: {}, consumptionPerMinute: {}, inventory: {}, pureIdleReplication: capturePureIdleReplicationTelemetry(prepared)! },
      ];
      prepared.constructionAutomation.enabled = constructionEnabled;
      if (preparedPath) writeFileSync(preparedPath, JSON.stringify({ sourceSha256, state: prepared }));
    }
    if (materialStress) {
      // Explicit synthetic supply variant of the same topology. The player's
      // fixture, targets and quantum-source preference remain untouched.
      for (const planetId of new Set(prepared.entities.filter((entity) => entity.buildingId === "construction_center").map((entity) => entity.planetId))) {
        const tray = prepared.planetTrays[planetId] ??= {};
        for (const itemId of Object.keys(ITEMS)) (tray as Record<string, number>)[itemId] = 1_000_000_000;
        if (prepared.activePlanetId === planetId) prepared.tray = tray;
      }
      const runtime = createPersistentSimulationRuntime(prepared);
      advancePersistentSimulationRuntime(runtime, 0.1, 0.1);
      prepared = runtime.state;
      const latest = prepared.productionHistory.at(-1)!;
      latest.elapsedSeconds = prepared.elapsedSeconds;
      latest.pureIdleReplication = capturePureIdleReplicationTelemetry(prepared)!;
    }
    const results = [];
    const modes = (process.env.DSP_PURE_IDLE_MODES ?? "replication,stable").split(",") as Array<"replication" | "stable">;
    for (const mode of modes) for (const construction of [false, true]) {
      const state = structuredClone(prepared);
      state.paused = false;
      state.timeWarp.enabled = true;
      state.timeWarp.requestedMultiplier = 8;
      state.timeWarp.pendingSimulationSeconds = state.timeWarp.pendingWallSeconds = 0;
      const controller = state.entities.find((entity) => entity.buildingId === "time_warp_device");
      if (controller) state.timeWarp.controllerEntityId = controller.id;
      state.constructionAutomation.enabled = construction;
      refreshTimeWarpPowerSnapshotInPlace(state);
      const heapBefore = process.memoryUsage().heapUsed;
      console.log(`PURE_IDLE_MODE_START ${JSON.stringify({ mode, construction })}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const started = performance.now();
      const asyncFactory = (macro as unknown as { createPureIdleMacroSessionAsync?: typeof macro.createPureIdleMacroSession }).createPureIdleMacroSessionAsync;
      const session = await (asyncFactory ? asyncFactory(state, mode, { consumeCalibrationState: true,
        onCalibrationProgress: (seconds) => console.log(`PURE_IDLE_MODE_CALIBRATION ${JSON.stringify({ mode, construction, seconds, ms: performance.now() - started })}`) })
        : macro.createPureIdleMacroSession(state, mode, { consumeCalibrationState: true }));
      const startupMs = performance.now() - started;
      const baseWall = session.settledWallSeconds;
      const buckets = [];
      for (const delta of [1, 10, 30]) {
        const before = performance.now();
        macro.advancePureIdleMacroSession(session, baseWall + delta);
        buckets.push(performance.now() - before);
        console.log(`PURE_IDLE_MODE_BUCKET ${JSON.stringify({ mode, construction, delta, ms: buckets.at(-1) })}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const stopStarted = performance.now();
      const result = macro.finalizePureIdleMacroCandidate(session, baseWall + 30);
      const stopMs = performance.now() - stopStarted;
      const serialized = serializeEnvelope(result.state, 1_800_000_000_000);
      const row = { mode, construction, materialStress, startupMs, buckets, stopMs,
        finalSha256: createHash("sha256").update(serialized).digest("hex"),
        heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
        rssBytes: process.memoryUsage().rss, crafted: result.state.constructionAutomation.totalCrafted,
        simulated: result.summary.settledSimulationSeconds,
        phase: result.summary.phase, reason: result.summary.lastValidationReason };
      results.push(row);
      console.log(`PURE_IDLE_MODE_CASE ${JSON.stringify(row)}`);
    }
    expect(createHash("sha256").update(readFileSync(fixturePath!, "utf8")).digest("hex")).toBe(sourceSha256);
    console.log(`PURE_IDLE_MODES ${JSON.stringify({ sourceSha256, materialStress, results })}`);
  });
});
