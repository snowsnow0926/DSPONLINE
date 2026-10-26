import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { describe, expect, it } from "vitest";
import { ITEMS } from "./content";
import { advancePersistentSimulationRuntime, createPersistentSimulationRuntime, refreshTimeWarpPowerSnapshotInPlace } from "./engine";
import { createPureIdleMacroSession, advancePureIdleMacroSession, finalizePureIdleMacroCandidate } from "./pureIdleMacro";
import { capturePureIdleReplicationTelemetry } from "./pureIdleReplicationTelemetry";
import { serializeEnvelope } from "./storage";
import type { GameState } from "./types";

const preparedPath = process.env.DSP_REPLICATION_BENCHMARK_PREPARED;

describe.skipIf(!preparedPath)("large-save replication construction performance", () => {
  it("measures the complete construction path without changing the input file", { timeout: 900_000 }, async () => {
    const raw = readFileSync(preparedPath!, "utf8");
    const inputHash = createHash("sha256").update(raw).digest("hex");
    const prepared = JSON.parse(raw).state as GameState;
    const stress = process.env.DSP_REPLICATION_BENCHMARK_STRESS === "1";
    if (stress) {
      for (const planet of new Set(prepared.entities.filter((entity) => entity.buildingId === "construction_center").map((entity) => entity.planetId))) {
        const tray = prepared.planetTrays[planet] ??= {};
        for (const item of Object.keys(ITEMS)) (tray as Record<string, number>)[item] = 1_000_000_000;
        if (prepared.activePlanetId === planet) prepared.tray = tray;
      }
      const runtime = createPersistentSimulationRuntime(prepared);
      advancePersistentSimulationRuntime(runtime, 0.1, 0.1);
      const latest = prepared.productionHistory.at(-1)!;
      latest.elapsedSeconds = prepared.elapsedSeconds;
      latest.pureIdleReplication = capturePureIdleReplicationTelemetry(prepared)!;
    }
    const rows = [];
    const repeats = Math.max(1, Math.min(5, Number(process.env.DSP_REPLICATION_BENCHMARK_REPEATS ?? 3)));
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const state = structuredClone(prepared);
      state.paused = false;
      state.timeWarp.enabled = true;
      state.timeWarp.requestedMultiplier = 8;
      state.timeWarp.pendingSimulationSeconds = state.timeWarp.pendingWallSeconds = 0;
      const controller = state.entities.find((entity) => entity.buildingId === "time_warp_device");
      if (controller) state.timeWarp.controllerEntityId = controller.id;
      state.constructionAutomation.enabled = true;
      refreshTimeWarpPowerSnapshotInPlace(state);
      const started = performance.now();
      const session = createPureIdleMacroSession(state, "replication");
      const startupMs = performance.now() - started;
      const profiler = process.env.DSP_REPLICATION_BENCHMARK_PROFILE && repeat === 0 ? new Session() : null;
      if (profiler) {
        profiler.connect();
        await profiler.post("Profiler.enable");
        await profiler.post("Profiler.start");
      }
      const buckets = [];
      for (const target of [1, 10, 30]) {
        const before = performance.now();
        advancePureIdleMacroSession(session, target);
        buckets.push({ targetWallSeconds: target, milliseconds: performance.now() - before });
      }
      if (profiler) {
        const result = await profiler.post("Profiler.stop");
        writeFileSync(process.env.DSP_REPLICATION_BENCHMARK_PROFILE!, JSON.stringify(result.profile));
        profiler.disconnect();
      }
      const result = finalizePureIdleMacroCandidate(session, 30);
      const finalHash = createHash("sha256").update(serializeEnvelope(result.state, 1_800_000_000_000)).digest("hex");
      const row = { repeat, startupMs, buckets, finalHash, crafted: result.state.constructionAutomation.totalCrafted,
        simulatedSeconds: result.summary.settledSimulationSeconds, rssBytes: process.memoryUsage().rss };
      rows.push(row);
      console.log(`REPLICATION_CONSTRUCTION_BENCHMARK ${JSON.stringify(row)}`);
    }
    expect(new Set(rows.map((row) => row.finalHash)).size).toBe(1);
    expect(createHash("sha256").update(readFileSync(preparedPath!, "utf8")).digest("hex")).toBe(inputHash);
    if (process.env.DSP_REPLICATION_BENCHMARK_OUTPUT) {
      writeFileSync(process.env.DSP_REPLICATION_BENCHMARK_OUTPUT, JSON.stringify({ inputHash, stress, rows }, null, 2));
    }
  });
});
