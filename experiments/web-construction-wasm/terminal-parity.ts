import { TECHNOLOGY_LIST } from "../../src/game/content";
import { loadContentPackRegistry } from "../../src/game/contentPacks";
import { advancePersistentSimulationRuntime, createPersistentSimulationRuntime, refreshTimeWarpPowerSnapshotInPlace } from "../../src/game/engine";
import { applyPureIdleMacroFinalState, createPureIdleMacroSession, finalizePureIdleMacroCandidate } from "../../src/game/pureIdleMacro";
import { capturePureIdleReplicationTelemetry } from "../../src/game/pureIdleReplicationTelemetry";
import { hydrateCurrentPersistentSaveProjection, projectPersistentSaveState } from "../../src/game/saveProjection";
import { decodeVerifiedSaveTransfer, serializeSaveEnvelopeToTransfer } from "../../src/game/saveTransfer";
import { parseTrustedWorkerEnvelope } from "../../src/game/storage";
import { serializeAuthoritativePrimarySaveInWorker } from "../../src/game/authoritativeSaveSerializationClient";
import type { GameState } from "../../src/game/types";

async function digest(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

function summarizeDifferences(left: GameState, right: GameState) {
  const fields = (a: Record<string, unknown>, b: Record<string, unknown>, counts: Record<string, number>) => {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) counts[key] = (counts[key] ?? 0) + 1;
    }
  };
  const entities: Record<string, number> = {};
  const belts: Record<string, number> = {};
  for (let i = 0; i < Math.min(left.entities.length, right.entities.length); i++) {
    const a = left.entities[i] as unknown as Record<string, unknown>;
    const b = right.entities[i] as unknown as Record<string, unknown>;
    if (JSON.stringify(a) !== JSON.stringify(b)) fields(a, b, entities);
  }
  for (let i = 0; i < Math.min(left.belts.length, right.belts.length); i++) {
    const a = left.belts[i] as unknown as Record<string, unknown>;
    const b = right.belts[i] as unknown as Record<string, unknown>;
    if (JSON.stringify(a) !== JSON.stringify(b)) fields(a, b, belts);
  }
  const topLevel: Record<string, number> = {};
  const a = left as unknown as Record<string, unknown>;
  const b = right as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key !== "entities" && key !== "belts" && JSON.stringify(a[key]) !== JSON.stringify(b[key])) topLevel[key] = 1;
  }
  return { entities, belts, topLevel };
}

async function runTerminalParityProbe(path = "legacy", scenario = "natural") {
  if (!["legacy", "terminal", "terminal-safe"].includes(path) || !["natural", "completed-research", "replication"].includes(scenario)) {
    throw new Error("Unknown terminal comparison variant");
  }
  let state: GameState | null = (await (await fetch("/prepared.json")).json()).state as GameState;
  state.timeWarp.enabled = false;
  state.timeWarp.pendingSimulationSeconds = state.timeWarp.pendingWallSeconds = 0;
  state.paused = false;
  if (scenario === "replication") {
    {
      const runtime = createPersistentSimulationRuntime(state);
      advancePersistentSimulationRuntime(runtime, 0.1, 0.1);
      state = runtime.state;
      const latest = state.productionHistory.at(-1);
      if (!latest) throw new Error("No production history for replication");
      latest.elapsedSeconds = state.elapsedSeconds;
      latest.pureIdleReplication = capturePureIdleReplicationTelemetry(state)!;
    }
    state = structuredClone(state);
    const controller = state.entities.find((entity) => entity.id === state!.timeWarp.controllerEntityId && entity.buildingId === "time_warp_device")
      ?? state.entities.find((entity) => entity.buildingId === "time_warp_device");
    if (!controller) throw new Error("No time-warp controller in the fixture");
    state.timeWarp.controllerEntityId = controller.id;
    state.timeWarp.enabled = true;
    state.timeWarp.requestedMultiplier = 8;
    state.timeWarp.pendingSimulationSeconds = state.timeWarp.pendingWallSeconds = 0;
    state.constructionAutomation.enabled = true;
    refreshTimeWarpPowerSnapshotInPlace(state);
  }
  if (scenario === "completed-research") {
    const technology = TECHNOLOGY_LIST.find((item) => item.costs.length > 0 && state!.research.completedTechIds.includes(item.id));
    if (!technology) throw new Error("Fixture has no usable completed technology");
    state.research.completedTechIds = state.research.completedTechIds.filter((id) => id !== technology.id);
    state.research.queuedTechIds = [];
    state.research.selectedTechId = technology.id;
    state.research.progressByTech[technology.id] = Object.fromEntries(technology.costs.map((cost) => [cost.itemId, cost.amount]));
  }
  const terminal = { startedPaused: true, baselineIdleSettlement: structuredClone(state.idleSettlement),
    baselineTotalProduced: { ...state.totalProduced } };
  let replicationSummary: { simulatedSeconds: number; beforeCrafted: number; crafted: number; craftedDelta: number } | undefined;
  if (scenario === "replication") {
    const beforeCrafted = state.constructionAutomation.totalCrafted;
    const session = createPureIdleMacroSession(state, "replication");
    const finalized = finalizePureIdleMacroCandidate(session, 30);
    state = finalized.state;
    const crafted = state.constructionAutomation.totalCrafted;
    if (crafted < beforeCrafted) throw new Error("Construction counter decreased");
    replicationSummary = { simulatedSeconds: finalized.summary.settledSimulationSeconds, beforeCrafted,
      crafted, craftedDelta: crafted - beforeCrafted };
  }
  const registry = loadContentPackRegistry();
  const timestamp = 1_786_377_600_000;
  const metadata = { formatVersion: 2, kind: "primary" as const, mode: state.mode, slot: "main" as const, savedAt: timestamp };
  let candidate: GameState | null = path !== "legacy" ? applyPureIdleMacroFinalState(state, 30, terminal) : state;
  let projected: GameState | null = projectPersistentSaveState(candidate, registry);
  const encoded = serializeSaveEnvelopeToTransfer(projected, metadata);
  state = null;
  candidate = null;
  projected = null;
  const raw = decodeVerifiedSaveTransfer(encoded.bytes, encoded);
  const uiState = parseTrustedWorkerEnvelope(raw, encoded);
  const legacyFinal = path === "legacy" ? applyPureIdleMacroFinalState(uiState, 30, terminal) : uiState;
  let uiProjection: GameState | null = projectPersistentSaveState(legacyFinal, registry);
  let persisted: GameState | null = path === "terminal"
    ? projectPersistentSaveState(hydrateCurrentPersistentSaveProjection(JSON.parse(raw).state), registry) : uiProjection;
  const uiStateSha256 = await digest(new TextEncoder().encode(JSON.stringify(uiProjection)).buffer);
  const persistedStateSha256 = await digest(new TextEncoder().encode(JSON.stringify(persisted)).buffer);
  const saved = serializeSaveEnvelopeToTransfer(persisted, metadata);
  const payloadSha256 = await digest(saved.bytes);
  const summary = { entities: persisted.entities.length, belts: persisted.belts.length,
    paused: persisted.paused, idleSeconds: persisted.idleSettlement.totalIdleTime };
  const differences = path === "terminal" && uiStateSha256 !== persistedStateSha256
    ? summarizeDifferences(uiProjection, persisted) : undefined;
  uiProjection = null;
  persisted = null;
  let workerPayloadSha256: string | undefined;
  if (path !== "terminal") {
    const worker = await serializeAuthoritativePrimarySaveInWorker(legacyFinal, { savedAt: timestamp });
    const bytes = worker.proof.transportEncoding === "gzip"
      ? await new Response(new Blob([worker.bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
      : worker.bytes;
    workerPayloadSha256 = await digest(bytes);
    if (workerPayloadSha256 !== worker.proof.payloadSha256) throw new Error("Worker payload proof mismatch");
  }
  return { path, scenario, uiStateSha256, persistedStateSha256, payloadSha256, payloadBytes: saved.byteLength,
    ...(workerPayloadSha256 ? { workerPayloadSha256 } : {}), ...(differences ? { differences } : {}),
    ...(replicationSummary ? { replicationSummary } : {}), ...summary };
}

Object.assign(globalThis, { runTerminalParityProbe });
