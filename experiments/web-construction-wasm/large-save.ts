import { ITEMS } from "../../src/game/content";
import { advancePersistentSimulationRuntime, createPersistentSimulationRuntime, refreshTimeWarpPowerSnapshotInPlace } from "../../src/game/engine";
import { createPureIdleMacroSession, advancePureIdleMacroSession, finalizePureIdleMacroCandidate } from "../../src/game/pureIdleMacro";
import { capturePureIdleReplicationTelemetry } from "../../src/game/pureIdleReplicationTelemetry";
import { serializeEnvelope } from "../../src/game/storage";
import type { GameState } from "../../src/game/types";

// Localhost-only fixture supplied by the runner; no save is written or uploaded.
// Setup, reading, hashing and serialization are reported separately from advance.
function takeMacroProfile(): Record<string, { calls: number; milliseconds: number }> {
  const scope = globalThis as unknown as { __dspMacroProbeProfile?: Record<string, { calls: number; milliseconds: number }> };
  const result = scope.__dspMacroProbeProfile ?? {};
  scope.__dspMacroProbeProfile = {};
  return result;
}

async function runLargeSaveProbe(supply = "tray") {
  if (!["tray", "stock", "quantum"].includes(supply)) throw new Error("Unknown large-save supply variant");
  const setupStarted = performance.now();
  let state = (await (await fetch("/prepared.json")).json()).state as GameState;
  if (supply !== "stock") for (const planet of new Set(state.entities.filter((entity) => entity.buildingId === "construction_center").map((entity) => entity.planetId))) {
    const tray = state.planetTrays[planet] = {};
    if (supply === "tray") for (const item of Object.keys(ITEMS)) (tray as Record<string, number>)[item] = 1_000_000_000;
    if (state.activePlanetId === planet) state.tray = tray;
  }
  if (supply === "quantum") {
    if (!state.quantumLogisticsNetwork.enabled) throw new Error("Quantum fixture requires an enabled network");
    state.constructionAutomation.quantumSourceEnabled = true;
    for (const item of Object.keys(ITEMS)) state.quantumLogisticsNetwork.inventory[item] = "1000000000";
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
  const setupProfile = takeMacroProfile();
  const started = performance.now();
  const session = createPureIdleMacroSession(state, "replication");
  const startupMs = performance.now() - started;
  const startupProfile = takeMacroProfile();
  const buckets = [];
  for (const target of [1, 10, 30]) {
    const before = performance.now();
    advancePureIdleMacroSession(session, target);
    buckets.push({ targetWallSeconds: target, milliseconds: performance.now() - before, profile: takeMacroProfile() });
  }
  const result = finalizePureIdleMacroCandidate(session, 30);
  const finalizeProfile = takeMacroProfile();
  const serializeStarted = performance.now();
  const encoded = new TextEncoder().encode(serializeEnvelope(result.state, 1_800_000_000_000));
  const serializationMs = performance.now() - serializeStarted;
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const finalHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { supply, setupMs, startupMs, setupProfile, startupProfile, buckets, finalizeProfile, serializationMs, serializedBytes: encoded.length, finalHash,
    crafted: result.state.constructionAutomation.totalCrafted,
    simulatedSeconds: result.summary.settledSimulationSeconds };
}

Object.assign(globalThis, { runLargeSaveProbe });
