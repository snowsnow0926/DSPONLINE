import { advancePersistentSimulationRuntime, createPersistentSimulationRuntime, createSimulationProfiler } from "../../src/game/engine";
import type { GameState } from "../../src/game/types";

async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The real prepared save is read-only and remains on loopback. No material is
// supplied for this probe. The ordinary simulation runs at one simulated
// second per requested wall second, independently of UI scheduler debt.
async function runQuantumRuntimeProbe() {
  const state = (await (await fetch("/prepared.json")).json()).state as GameState;
  state.paused = false;
  state.timeWarp.enabled = false;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  state.settings.autosaveIntervalSeconds = 0;
  const setup = createSimulationProfiler();
  const setupStarted = performance.now();
  const runtime = createPersistentSimulationRuntime(state, setup);
  const setupMs = performance.now() - setupStarted;
  const buckets = [];
  let previous = 0;
  for (const target of [1, 10, 30]) {
    const profile = createSimulationProfiler();
    const started = performance.now();
    const duration = target - previous;
    advancePersistentSimulationRuntime(runtime, duration, duration, profile);
    buckets.push({ targetSimulationSeconds: target, milliseconds: performance.now() - started, profile });
    previous = target;
  }
  const hashStarted = performance.now();
  const rawState = JSON.stringify(runtime.state);
  const fullStateSha256 = await digest(rawState);
  const quantumSha256 = await digest(JSON.stringify(runtime.state.quantumLogisticsNetwork));
  return { setupMs, buckets, hashMs: performance.now() - hashStarted,
    fullStateJsonLength: rawState.length, fullStateSha256, quantumSha256,
    entities: runtime.state.entities.length, belts: runtime.state.belts.length,
    elapsedSeconds: runtime.state.elapsedSeconds,
    constructionCrafted: runtime.state.constructionAutomation.totalCrafted };
}

Object.assign(globalThis, { runQuantumRuntimeProbe });
