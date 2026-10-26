import { ITEMS } from "../../src/game/content";
import { advancePersistentSimulationRuntime, createPersistentSimulationRuntime, refreshTimeWarpPowerSnapshotInPlace } from "../../src/game/engine";
import { createPureIdleMacroSession, advancePureIdleMacroSession, finalizePureIdleMacroCandidate } from "../../src/game/pureIdleMacro";
import { capturePureIdleReplicationTelemetry } from "../../src/game/pureIdleReplicationTelemetry";
import { serializeEnvelope } from "../../src/game/storage";
import type { GameState } from "../../src/game/types";

// Localhost-only fixture supplied by the runner; no save is written or uploaded.
// Setup, reading, hashing and serialization are reported separately from advance.
async function runLargeSaveProbe() {
  const setupStarted = performance.now();
  let state = (await (await fetch("/prepared.json")).json()).state as GameState;
  for (const planet of new Set(state.entities.filter((entity) => entity.buildingId === "construction_center").map((entity) => entity.planetId))) {
    const tray = state.planetTrays[planet] ??= {};
    for (const item of Object.keys(ITEMS)) (tray as Record<string, number>)[item] = 1_000_000_000;
    if (state.activePlanetId === planet) state.tray = tray;
  }
  const runtime = createPersistentSimulationRuntime(state);
  advancePersistentSimulationRuntime(runtime, 0.1, 0.1);
  const latest = state.productionHistory.at(-1)!;
  latest.elapsedSeconds = state.elapsedSeconds;
  latest.pureIdleReplication = capturePureIdleReplicationTelemetry(state)!;
  // Match the Node benchmark: start settlement with a fresh object identity,
  // rather than carrying the preheating runtime's WeakMap caches into the run.
  state = structuredClone(state);
  state.paused = false;
  state.timeWarp.enabled = true;
  state.timeWarp.requestedMultiplier = 8;
  state.timeWarp.pendingSimulationSeconds = state.timeWarp.pendingWallSeconds = 0;
  const controller = state.entities.find((entity) => entity.buildingId === "time_warp_device");
  if (controller) state.timeWarp.controllerEntityId = controller.id;
  state.constructionAutomation.enabled = true;
  refreshTimeWarpPowerSnapshotInPlace(state);
  const setupMs = performance.now() - setupStarted;
  const started = performance.now();
  const session = createPureIdleMacroSession(state, "replication");
  const startupMs = performance.now() - started;
  const buckets = [];
  for (const target of [1, 10, 30]) {
    const before = performance.now();
    advancePureIdleMacroSession(session, target);
    buckets.push({ targetWallSeconds: target, milliseconds: performance.now() - before });
  }
  const result = finalizePureIdleMacroCandidate(session, 30);
  const serializeStarted = performance.now();
  const encoded = new TextEncoder().encode(serializeEnvelope(result.state, 1_800_000_000_000));
  const serializationMs = performance.now() - serializeStarted;
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const finalHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { setupMs, startupMs, buckets, serializationMs, serializedBytes: encoded.length, finalHash,
    crafted: result.state.constructionAutomation.totalCrafted,
    simulatedSeconds: result.summary.settledSimulationSeconds };
}

Object.assign(globalThis, { runLargeSaveProbe });
