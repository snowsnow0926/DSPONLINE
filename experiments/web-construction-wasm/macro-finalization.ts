import clockWorkerUrl from "./macro-finalization-clock.worker.ts?worker&url";
import { createContentPackRegistry, createContentPackRuntimeSnapshot } from "../../src/game/contentPacks";
import { createPersistentSimulationRuntime, advancePersistentSimulationRuntime, refreshTimeWarpPowerSnapshotInPlace } from "../../src/game/engine";
import { capturePureIdleReplicationTelemetry } from "../../src/game/pureIdleReplicationTelemetry";
import { PureIdleMacroClient } from "../../src/game/pureIdleMacroClient";
import { decodeVerifiedSaveTransfer } from "../../src/game/saveTransfer";
import { parseTrustedWorkerEnvelope } from "../../src/game/storage";
import { serializeAuthoritativePrimarySaveInWorker } from "../../src/game/authoritativeSaveSerializationClient";
import type { GameState } from "../../src/game/types";

const digest = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map((value) => value.toString(16).padStart(2, "0")).join("");
const stateDigest = (state: GameState) => digest(new TextEncoder().encode(JSON.stringify(state)).buffer);

async function runMacroFinalization() {
  let state = (await (await fetch("/prepared.json")).json()).state as GameState;
  state.timeWarp.enabled = false;
  state.timeWarp.pendingSimulationSeconds = state.timeWarp.pendingWallSeconds = 0;
  state.paused = false;
  const runtime = createPersistentSimulationRuntime(state);
  advancePersistentSimulationRuntime(runtime, 0.1, 0.1);
  state = runtime.state;
  const latest = state.productionHistory.at(-1);
  if (!latest) throw new Error("Missing replication history");
  latest.elapsedSeconds = state.elapsedSeconds;
  latest.pureIdleReplication = capturePureIdleReplicationTelemetry(state)!;
  const controller = state.entities.find((entity) => entity.id === state.timeWarp.controllerEntityId && entity.buildingId === "time_warp_device")
    ?? state.entities.find((entity) => entity.buildingId === "time_warp_device");
  if (!controller) throw new Error("Missing time-warp controller");
  state.timeWarp.controllerEntityId = controller.id;
  state.timeWarp.enabled = true;
  state.timeWarp.requestedMultiplier = 8;
  state.constructionAutomation.enabled = true;
  refreshTimeWarpPowerSnapshotInPlace(state);
  const before = await stateDigest(state);
  const originalNow = Date.now;
  const NativeWorker = globalThis.Worker;
  function ClockWorker(url: string | URL, options?: WorkerOptions): Worker {
    return new NativeWorker(options?.name === "pure-idle-macro" ? clockWorkerUrl : url, options);
  }
  Date.now = () => 1_786_377_600_000;
  globalThis.Worker = ClockWorker as unknown as typeof Worker;
  const client = new PureIdleMacroClient();
  try {
    const registry = createContentPackRegistry();
    await client.initialize(state, "replication", createContentPackRuntimeSnapshot(registry), {
      startedPaused: true, baselineIdleSettlement: structuredClone(state.idleSettlement), baselineTotalProduced: { ...state.totalProduced },
    });
    const result = await client.finalizeEnvelope(30, { terminal: true, binaryTransport: "array-buffer" });
    client.close();
    const envelope = result.finalEnvelope;
    if (!(envelope.payloadBytes instanceof ArrayBuffer)) throw new Error("Expected exact transferable bytes");
    const sourcePayloadSha256 = await digest(envelope.payloadBytes);
    const canonical = parseTrustedWorkerEnvelope(decodeVerifiedSaveTransfer(envelope.payloadBytes, envelope.verification), envelope.verification, registry);
    const canonicalStateSha256 = await stateDigest(canonical);
    const saved = await serializeAuthoritativePrimarySaveInWorker(canonical, { savedAt: 1_786_377_600_000 });
    const body = saved.proof.transportEncoding === "gzip"
      ? await new Response(new Blob([saved.bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer() : saved.bytes;
    const payloadSha256 = await digest(body);
    if (payloadSha256 !== saved.proof.payloadSha256 || body.byteLength !== saved.proof.byteLength) throw new Error("Saved payload proof mismatch");
    if (before !== await stateDigest(state)) throw new Error("Macro initialization changed caller state");
    return { scope: "actual macro Worker, fixed 30 seconds at 8x, full envelope/canonical state/actual save Worker bytes; diagnostic only, no database/UI qualification",
      inputUnchanged: true, sourcePayloadSha256, sourcePayloadBytes: envelope.verification.byteLength, canonicalStateSha256,
      payloadSha256, payloadBytes: body.byteLength, identity: { mode: canonical.mode, version: canonical.version,
        entities: canonical.entities.length, belts: canonical.belts.length, elapsedSeconds: canonical.elapsedSeconds },
      settledWallSeconds: result.summary.settledWallSeconds, settledSimulationSeconds: result.summary.settledSimulationSeconds };
  } finally { client.close(); globalThis.Worker = NativeWorker; Date.now = originalNow; }
}

Object.assign(globalThis, { runMacroFinalization });
