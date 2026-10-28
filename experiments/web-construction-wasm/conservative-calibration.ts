import { advancePersistentSimulationRuntime, createPersistentSimulationRuntime, refreshTimeWarpPowerSnapshotInPlace } from "../../src/game/engine";
import { createPureIdleMacroSessionAsync, advancePureIdleMacroSession, finalizePureIdleMacroCandidate } from "../../src/game/pureIdleMacro";
import { serializeEnvelope } from "../../src/game/storage";
import type { GameState } from "../../src/game/types";

function takeProfile(): Record<string, { calls: number; milliseconds: number }> {
  const scope = globalThis as unknown as { __dspMacroProbeProfile?: Record<string, { calls: number; milliseconds: number }> };
  const result = scope.__dspMacroProbeProfile ?? {};
  scope.__dspMacroProbeProfile = {};
  return result;
}

async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Fresh, exclusively owned browser state. Mirrors the Worker's asynchronous
// single-state calibration, without database/UI claims or extra materials.
async function runConservativeCalibration() {
  const setupStarted = performance.now();
  let state = (await (await fetch("/prepared.json")).json()).state as GameState;
  state.paused = false;
  const runtime = createPersistentSimulationRuntime(state);
  advancePersistentSimulationRuntime(runtime, 0.1, 0.1);
  state = structuredClone(runtime.state);
  state.timeWarp.enabled = true;
  state.timeWarp.requestedMultiplier = 8;
  state.timeWarp.pendingSimulationSeconds = state.timeWarp.pendingWallSeconds = 0;
  const controller = state.entities.find((entity) => entity.buildingId === "time_warp_device");
  if (!controller) throw new Error("Missing time-warp controller");
  state.timeWarp.controllerEntityId = controller.id;
  state.constructionAutomation.enabled = true;
  refreshTimeWarpPowerSnapshotInPlace(state);
  const setupMs = performance.now() - setupStarted;
  const setupProfile = takeProfile();
  const progress: Array<{ simulationSeconds: number; total: number; atMs: number }> = [];
  const start = performance.now();
  const session = await createPureIdleMacroSessionAsync(state, "stable", {
    consumeCalibrationState: true,
    deadlineAtMs: Date.now() + 90_000,
    onCalibrationProgress(simulationSeconds, total) {
      progress.push({ simulationSeconds, total, atMs: performance.now() - start });
      console.log(`[conservative-calibration] ${simulationSeconds}/${total}`);
    },
  }).catch((error: unknown) => {
    console.log(`[conservative-calibration] aborted ${JSON.stringify({
      elapsedMs: performance.now() - start, progress, partialProfile: takeProfile(),
    })}`);
    throw error;
  });
  const initializationMs = performance.now() - start;
  const initializationProfile = takeProfile();
  if (!session.conservativeOnly || session.actualMultiplier !== 8 || session.settledWallSeconds > 5) {
    throw new Error("Expected owned large-save conservative prefix at 8x");
  }
  const initialization = {
    conservativeOnly: session.conservativeOnly,
    calibrationWindowsCompleted: session.calibrationWindowsCompleted,
    settledWallSeconds: session.settledWallSeconds,
    settledSimulationSeconds: session.settledSimulationSeconds,
    contractEntries: session.contract.deltas.length,
    contractMaximumSimulationSeconds: session.contract.maximumSimulationSeconds,
    powerRemainingSimulationSeconds: session.powerRemainingSimulationSeconds,
    constructionPowerCertificate: Boolean(session.constructionPowerCertificate),
    validationFailures: session.validationFailures,
    degradedReason: session.degradedReason,
  };
  const buckets = [];
  for (const targetWallSeconds of [5, 10, 30]) {
    const before = performance.now();
    advancePureIdleMacroSession(session, targetWallSeconds);
    buckets.push({ targetWallSeconds, milliseconds: performance.now() - before, profile: takeProfile() });
  }
  const finalizeStarted = performance.now();
  const result = finalizePureIdleMacroCandidate(session, 30);
  const finalizeMs = performance.now() - finalizeStarted;
  const finalizeProfile = takeProfile();
  const fullStateJson = JSON.stringify(result.state);
  const fullStateSha256 = await digest(fullStateJson);
  const envelope = serializeEnvelope(result.state, 1_800_000_000_000);
  const fullEnvelopeSha256 = await digest(envelope);
  return {
    scope: "Owned async conservative calibration and fixed 30 wall seconds at 8x; no UI/database qualification",
    mode: "stable", supply: "stock", setupMs, setupProfile, initializationMs, initializationProfile,
    initialization, progress, buckets, finalizeMs, finalizeProfile,
    fullStateJsonLength: fullStateJson.length, fullStateSha256,
    fullEnvelopeJsonLength: envelope.length, fullEnvelopeSha256,
    entities: result.state.entities.length, belts: result.state.belts.length,
    settledSimulationSeconds: result.summary.settledSimulationSeconds,
    settledWallSeconds: result.summary.settledWallSeconds,
  };
}

Object.assign(globalThis, { runConservativeCalibration });
