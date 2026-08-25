/// <reference lib="webworker" />

import { applyContentPackRuntimeSnapshot, type ContentPackRuntimeSnapshot } from "./contentPacks";
import { advancePersistentSimulationRuntime, advancePersistentSimulationRuntimeMulticore, createPersistentSimulationRuntime, createSimulationPlanetPhaseLookup, ensureSimulationDynamicRouteLookup, createSimulationProfiler, markPersistentSimulationRuntimeDirty, replacePersistentSimulationRuntimeState, type PersistentSimulationRuntime, type SimulationProfiler } from "./engine";
import { BrowserMulticoreExecutor, planMulticoreSimulation, type MulticoreSimulationOptions } from "./multicoreSimulation";
import type { GameState } from "./types";
import { captureSimulationProjectionBaseline, chunkFullRecordSimulationProjection, createDeferredTopLevelSimulationProjection, createFullCurrentPlanetSimulationProjection, createSimulationProjectionWithBaseline, type SimulationProjection, type SimulationProjectionBaseline } from "./simulationProjection";
import { createSimulationStateDelta, shouldUseSimulationDelta, type SimulationStateDelta } from "./simulationDelta";
import { runTimeWarpApproximateSettlement, type TimeWarpApproximationReport } from "./offlineApproximation";
import { createFactoryAlertProjection } from "./alerts";
import { streamChunkedSaveJournalFromRuntimeState, type ChunkedSaveJournalContext, type PersistChunkedSaveOptions, type PersistChunkedSaveResult } from "./chunkedSaveJournal";
import type { LocalSaveInternalWrite } from "./localSaveStore";
import type { AuthoritativeSaveCheckpointOverlay } from "./authoritativeSaveSerializationProtocol";
import { applyAuthoritativeSaveCheckpointOverlay } from "./saveCheckpointOverlay";
import {
  applySimulationCommandPatchMutable,
  createSimulationStateIdentity,
  deserializeSimulationStateTransfer,
  serializeSimulationStateForTransfer,
  type SimulationCommandPatch,
  type SimulationStateIdentity,
  type SimulationStateBlobTransfer,
  type SimulationStateTransfer,
} from "./simulationRuntimeProtocol";
import {
  replaySimulationRuntimeDurableJournal,
  SimulationRuntimeDurableReplayError,
  type SimulationRuntimeDurableReplayPlan,
  type SimulationRuntimeDurableReplayProgress,
  type SimulationRuntimeDurableReplayResult,
} from "./simulationRuntimeDurableReplay";

export interface SimulationWorkerRequest {
  id: number;
  kind?: "advance" | "checkpoint" | "sync-projection" | "replay-durable";
  state?: GameState;
  /** One-time/bootstrap state; callers transfer the backing buffer. */
  stateTransfer?: SimulationStateTransfer;
  /** Large immutable checkpoint relayed without UI-thread buffer adoption. */
  stateBlobTransfer?: SimulationStateBlobTransfer;
  /** Ordered UI command against the last acknowledged Worker revision. */
  command?: SimulationCommandPatch;
  simulationSeconds: number;
  wallSeconds: number;
  profile?: boolean;
  registryFingerprint: string;
  registry?: ContentPackRuntimeSnapshot;
  protocol?: "full" | "delta" | "projection";
  stateRevision?: number;
  multicore?: MulticoreSimulationOptions;
  /** Use the guarded short-calibration macro path for pure-idle time warp. */
  approximate?: boolean;
  projectionScope?: "default" | "full-top-level";
  /** Device-only diagnostics switch. Omitted/false skips the full-factory alert scan. */
  includeFactoryAlerts?: boolean;
  /** Echoed so the UI cannot accept an alert snapshot from before a toggle. */
  factoryAlertsGeneration?: number;
  /** A very large normal-play factory may deliberately skip this one UI
   * projection. The authoritative simulation step and revision still commit;
   * the next non-deferred projection is compared with the last published
   * baseline and therefore contains every accumulated record change. */
  deferUiProjection?: boolean;
  /** Validated durable journal; accepted only with a transferred checkpoint. */
  durableReplay?: SimulationRuntimeDurableReplayPlan;
  /** MessagePort lets a long replay observe cancellation between RLE steps. */
  durableReplayCancelPort?: MessagePort;
  /** Authority replacement requests may ask for the exact post-replay state
   * mirror using the same bounded checkpoint chunk protocol as normal saves. */
  includeCheckpointStateMirror?: boolean;
  /** Primary persistence can consume the transferable checkpoint directly.
   * This mode returns only its bounded identity proof and deliberately skips
   * the second JSON.parse plus full-state mirror clones. */
  checkpointIdentityOnly?: boolean;
  /** Large autosaves can be projected and committed directly from the
   * Worker-owned authority. This avoids a full JSON transfer and decoded save
   * mirror while retaining the same internal v1 chunk journal. */
  chunkedSave?: {
    options: PersistChunkedSaveOptions;
    context: ChunkedSaveJournalContext;
    checkpointOverlay?: AuthoritativeSaveCheckpointOverlay;
  };
  chunkedSaveWritePort?: MessagePort;
  /** Pure-idle authority replacement keeps the full state in the Worker and
   * streams only bounded current-planet UI projection chunks. */
  streamAuthorityProjection?: boolean;
  /** Dedicated flow-control channel. The Worker sends the next projection
   * chunk only after the UI has committed and painted the previous one. */
  authorityProjectionAckPort?: MessagePort;
}

export type SimulationCheckpointStateChunk =
  | { kind: "base"; state: Omit<GameState, "entities" | "belts">; entityCount: number; beltCount: number }
  | { kind: "entities"; offset: number; values: GameState["entities"] }
  | { kind: "belts"; offset: number; values: GameState["belts"] };

export interface SimulationWorkerResponse {
  id: number;
  changed: boolean;
  state?: GameState;
  /** Lightweight request duration is always returned; detailed phases remain opt-in. */
  durationMs: number;
  /** JSON-equivalent payload size, sampled only while the diagnostics panel is active. */
  transferBytes?: number;
  profiler?: SimulationProfiler;
  needsState?: boolean;
  needsResync?: boolean;
  reusedState?: boolean;
  cacheRebuilt?: boolean;
  registryFingerprint?: string;
  needsRegistry?: boolean;
  registryError?: string;
  /** Optional P4 projection; `state` remains the compatibility oracle. */
  projection?: SimulationProjection;
  /** The authoritative revision advanced, but this response intentionally
   * omitted the large record projection. */
  projectionDeferred?: boolean;
  /** Small clock update retained while the record projection is deferred. */
  deferredElapsedSeconds?: number;
  factoryAlertsGeneration?: number;
  protocol?: "full" | "delta" | "projection";
  stateRevision?: number;
  delta?: SimulationStateDelta;
  deltaFallback?: "larger-than-full";
  multicore?: { enabled: boolean; workerCount: number; fallback?: boolean; reason?: string };
  timeWarpApproximation?: TimeWarpApproximationReport;
  checkpoint?: SimulationStateTransfer;
  /** JSON-canonical mirror created from the exact checkpoint text in Worker. */
  checkpointState?: GameState;
  /** Large checkpoint mirrors are streamed in ordered small clones before the final buffer response. */
  checkpointStateChunk?: SimulationCheckpointStateChunk;
  checkpointIdentity?: SimulationStateIdentity;
  chunkedSaveResult?: PersistChunkedSaveResult;
  chunkedSaveError?: string;
  authorityProjectionChunk?: { index: number; total: number };
  authorityProjectionChunkCount?: number;
  commandApplied?: boolean;
  durableReplayProgress?: SimulationRuntimeDurableReplayProgress;
  durableReplayResult?: SimulationRuntimeDurableReplayResult;
  durableReplayError?: { code: string; message: string };
  /** Original checkpoint bytes, not the post-replay state; returned without parsing on main. */
  sourceCheckpointTransfer?: SimulationStateTransfer;
}

export interface SimulationChunkedSaveWriteRequest {
  id: number;
  sequence: number;
  records: LocalSaveInternalWrite[];
}

export interface SimulationChunkedSaveWriteAck {
  id: number;
  sequence: number;
  ok: boolean;
  error?: string;
}

let runtime: PersistentSimulationRuntime | null = null;
let activeRegistryFingerprint: string | null = null;
let runtimeRevision = 0;
let multicoreExecutor: BrowserMulticoreExecutor | null = null;
let multicoreExecutorWorkerCount = 0;
let activeRegistrySnapshot: ContentPackRuntimeSnapshot | undefined;
let simulationMessageQueue: Promise<void> = Promise.resolve();
let runtimeInvalidated = false;
/** Last state actually projected to the UI. It is updated in one pass while
 * building the next response, so steady simulation no longer allocates two
 * complete signature/index baselines per second. */
let uiProjectionBaseline: SimulationProjectionBaseline | null = null;

function applyCommandToPersistentRuntime(command: SimulationCommandPatch, profiler?: SimulationProfiler): void {
  if (!runtime) throw new Error("模拟 Worker 尚未建立权威运行时");
  const applied = applySimulationCommandPatchMutable(runtime.state, command, runtime.records);
  if (applied.topologyDirty) {
    replacePersistentSimulationRuntimeState(runtime, applied.state, profiler);
    return;
  }
  runtime.state = applied.state;
  markPersistentSimulationRuntimeDirty(runtime, {
    entityIds: applied.changedEntityIds,
    beltIds: applied.changedBeltIds,
    planetIds: applied.dirtyPlanetIds,
  });
  if (applied.dynamicRouteDirty && runtime.lookup) runtime.lookup.dynamicRouteLookupDirty = true;
  if (runtime.state.paused && runtime.lookup) {
    // Paused factories keep only the compact ID indexes. Release the larger
    // simulation lookup graph until the next admitted advance.
    runtime.records = { entityById: runtime.lookup.entityById, beltById: runtime.lookup.beltById };
    runtime.lookup = undefined;
  }
}

const CHECKPOINT_CHUNK_THRESHOLD_BYTES = 1024 * 1024;
const CHECKPOINT_ENTITY_CHUNK_SIZE = 1024;
const CHECKPOINT_BELT_CHUNK_SIZE = 2048;

function postCheckpointStateChunks(id: number, state: GameState): void {
  const { entities, belts, ...base } = state;
  self.postMessage({
    id,
    changed: false,
    durationMs: 0,
    checkpointStateChunk: { kind: "base", state: base, entityCount: entities.length, beltCount: belts.length },
  } satisfies SimulationWorkerResponse);
  for (let offset = 0; offset < entities.length; offset += CHECKPOINT_ENTITY_CHUNK_SIZE) {
    self.postMessage({
      id,
      changed: false,
      durationMs: 0,
      checkpointStateChunk: { kind: "entities", offset, values: entities.slice(offset, offset + CHECKPOINT_ENTITY_CHUNK_SIZE) },
    } satisfies SimulationWorkerResponse);
  }
  for (let offset = 0; offset < belts.length; offset += CHECKPOINT_BELT_CHUNK_SIZE) {
    self.postMessage({
      id,
      changed: false,
      durationMs: 0,
      checkpointStateChunk: { kind: "belts", offset, values: belts.slice(offset, offset + CHECKPOINT_BELT_CHUNK_SIZE) },
    } satisfies SimulationWorkerResponse);
  }
}

function serializeCheckpointResponse(
  id: number,
  state: GameState,
): { checkpoint: SimulationStateTransfer; checkpointState?: GameState } {
  const checkpoint = serializeSimulationStateForTransfer(state);
  if (checkpoint.byteLength >= CHECKPOINT_CHUNK_THRESHOLD_BYTES) {
    // Stream the already-owned authority graph. The former path parsed the
    // complete JSON back into a second GameState before slicing it, so a 77 MB
    // save briefly retained authority + JSON + bytes + parsed mirror.
    postCheckpointStateChunks(id, state);
    return { checkpoint };
  }
  return {
    checkpoint,
    checkpointState: deserializeSimulationStateTransfer(checkpoint),
  };
}

function attachFactoryAlertProjection(projection: SimulationProjection, includeFactoryAlerts: boolean): SimulationProjection {
  if (!runtime || !includeFactoryAlerts) return projection;
  if (!runtime.state.paused) {
    runtime.lookup = runtime.lookup
      ? ensureSimulationDynamicRouteLookup(runtime.state, runtime.lookup)
      : createSimulationPlanetPhaseLookup(runtime.state);
  }
  projection.alerts = createFactoryAlertProjection(runtime.state, runtime.lookup);
  return projection;
}

function activateRuntimeRegistry(registry: ContentPackRuntimeSnapshot, profiler?: SimulationProfiler): void {
  if (activeRegistryFingerprint === registry.fingerprint) return;
  applyContentPackRuntimeSnapshot(registry);
  activeRegistryFingerprint = registry.fingerprint;
  activeRegistrySnapshot = registry;
  // Registry changes rebuild catalog-dependent lookup state only. Inventories,
  // route progress and production remain owned by the existing runtime.
  if (runtime) replacePersistentSimulationRuntimeState(runtime, runtime.state, profiler);
  multicoreExecutor?.setRegistry(registry);
}

interface AuthoritativeAdvanceResult {
  result: { state: GameState; changed: boolean; cacheRebuilt: boolean };
  multicorePlan: ReturnType<typeof requestMulticorePlan>;
  multicoreUsed: boolean;
  multicoreFallback: boolean;
  timeWarpApproximation: TimeWarpApproximationReport | undefined;
}

async function advanceAuthoritativeRuntime(
  simulationSeconds: number,
  wallSeconds: number,
  multicore: MulticoreSimulationOptions | undefined,
  approximate: boolean,
  profiler?: SimulationProfiler,
): Promise<AuthoritativeAdvanceResult> {
  if (!runtime) throw new Error("模拟运行时尚未初始化");
  const multicorePlan = requestMulticorePlan(runtime.state, multicore);
  let multicoreUsed = false;
  let multicoreFallback = false;
  let timeWarpApproximation: TimeWarpApproximationReport | undefined;
  let result: { state: GameState; changed: boolean; cacheRebuilt: boolean };
  if (approximate && runtime.state.timeWarp.enabled) {
    if (multicoreExecutor) {
      multicoreExecutor.terminate();
      multicoreExecutor = null;
      multicoreExecutorWorkerCount = 0;
    }
    const settled = runTimeWarpApproximateSettlement(runtime.state, simulationSeconds, wallSeconds);
    timeWarpApproximation = settled.report;
    replacePersistentSimulationRuntimeState(runtime, settled.state, profiler);
    result = { state: runtime.state, changed: simulationSeconds > 0 || wallSeconds > 0, cacheRebuilt: true };
  } else if (multicorePlan.enabled && multicorePlan.mode === "planet-phase") {
    const baseline = structuredClone(runtime.state);
    try {
      if (!multicoreExecutor || multicoreExecutorWorkerCount !== multicorePlan.workerCount) {
        multicoreExecutor?.terminate();
        multicoreExecutor = new BrowserMulticoreExecutor(multicorePlan.workerCount, undefined, activeRegistrySnapshot);
        multicoreExecutorWorkerCount = multicorePlan.workerCount;
      }
      multicoreExecutor.setRegistry(activeRegistrySnapshot);
      result = await advancePersistentSimulationRuntimeMulticore(runtime, simulationSeconds, wallSeconds, multicoreExecutor, profiler);
      multicoreUsed = true;
    } catch (error) {
      multicoreFallback = true;
      if (multicoreExecutor) {
        multicoreExecutor.terminate();
        multicoreExecutor = null;
        multicoreExecutorWorkerCount = 0;
      }
      replacePersistentSimulationRuntimeState(runtime, baseline, profiler);
      result = advancePersistentSimulationRuntime(runtime, simulationSeconds, wallSeconds, profiler);
      void error;
    }
  } else {
    if (multicoreExecutor) {
      multicoreExecutor.terminate();
      multicoreExecutor = null;
      multicoreExecutorWorkerCount = 0;
    }
    result = advancePersistentSimulationRuntime(runtime, simulationSeconds, wallSeconds, profiler);
  }
  return { result, multicorePlan, multicoreUsed, multicoreFallback, timeWarpApproximation };
}

// A content-pack update is a simulation boundary. Serialising requests here
// prevents an older awaited planet-phase response from racing a newer state or
// registry update and overwriting the authoritative runtime.
self.onmessage = (event: MessageEvent<SimulationWorkerRequest>) => {
  const receivedAt = performance.now();
  simulationMessageQueue = simulationMessageQueue
    .then(() => processSimulationRequest(event, receivedAt))
    .catch((error) => {
      self.postMessage({
        id: event.data.id,
        changed: false,
        durationMs: Math.max(0, performance.now() - receivedAt),
        needsState: true,
        registryFingerprint: activeRegistryFingerprint ?? undefined,
        registryError: error instanceof Error ? error.message : "模拟 Worker 处理失败，已请求安全重建",
      } satisfies SimulationWorkerResponse);
    });
};

async function processDurableReplayRequest(
  event: MessageEvent<SimulationWorkerRequest>,
  receivedAt: number,
): Promise<void> {
  const { id, stateRevision, registry, registryFingerprint, durableReplay, durableReplayCancelPort, authorityProjectionAckPort } = event.data;
  const sourceStateTransfer = event.data.stateTransfer;
  const sourceStateBlobTransfer = event.data.stateBlobTransfer;
  let cancelled = false;
  let returned = false;
  durableReplayCancelPort?.addEventListener("message", () => { cancelled = true; });
  durableReplayCancelPort?.start();
  authorityProjectionAckPort?.start();
  const returnSourceCheckpoint = (response: Omit<SimulationWorkerResponse, "id" | "durationMs">) => {
    if (returned) return;
    durableReplayCancelPort?.close();
    authorityProjectionAckPort?.close();
    // A successful streamed authority adoption has already decoded the source
    // into the live Worker runtime and verified the persisted primary. Sending
    // that 30+ MiB source buffer back to the UI creates a browser message-
    // adoption long task without adding any recovery value. Failure and the
    // ordinary durable-replay protocol still return ownership for exact retry.
    const returnSource = Boolean(sourceStateTransfer) &&
      (!event.data.streamAuthorityProjection || !response.durableReplayResult);
    const envelope: SimulationWorkerResponse = {
      id,
      durationMs: Math.max(0, performance.now() - receivedAt),
      ...response,
      ...(returnSource && sourceStateTransfer ? { sourceCheckpointTransfer: sourceStateTransfer } : {}),
    };
    const transfers: Transferable[] = [];
    if (returnSource && sourceStateTransfer?.buffer instanceof ArrayBuffer && sourceStateTransfer.buffer.byteLength === sourceStateTransfer.byteLength) {
      transfers.push(sourceStateTransfer.buffer);
    }
    if (response.checkpoint?.buffer instanceof ArrayBuffer && response.checkpoint.buffer.byteLength === response.checkpoint.byteLength) {
      transfers.push(response.checkpoint.buffer);
    }
    self.postMessage(envelope, transfers);
    returned = true;
  };
  try {
    if ((!sourceStateTransfer && !sourceStateBlobTransfer) || (sourceStateTransfer && sourceStateBlobTransfer) ||
      !durableReplay || !registry || registry.fingerprint !== registryFingerprint ||
      stateRevision !== durableReplay.checkpointStateRevision) {
      throw new SimulationRuntimeDurableReplayError("invalid-plan", "durable replay 缺少精确 checkpoint/registry/revision");
    }
    const stateTransfer = sourceStateTransfer ?? {
      protocolVersion: sourceStateBlobTransfer!.protocolVersion,
      byteLength: sourceStateBlobTransfer!.byteLength,
      buffer: await sourceStateBlobTransfer!.blob.arrayBuffer(),
    };
    const state = deserializeSimulationStateTransfer(stateTransfer);
    activateRuntimeRegistry(registry);
    if (runtime) replacePersistentSimulationRuntimeState(runtime, state);
    else runtime = createPersistentSimulationRuntime(state);
    uiProjectionBaseline = null;
    runtimeRevision = durableReplay.checkpointStateRevision;
    runtimeInvalidated = false;

    const executeStep = async (
      baseStateRevision: number,
      command: SimulationCommandPatch | null,
      simulationSeconds: number,
      wallSeconds: number,
      multicore: MulticoreSimulationOptions | undefined,
      approximate: boolean,
      stepRegistry: ContentPackRuntimeSnapshot,
    ): Promise<number> => {
      activateRuntimeRegistry(stepRegistry);
      if (!runtime || runtimeRevision !== baseStateRevision) {
        throw new SimulationRuntimeDurableReplayError("revision-mismatch", "durable replay engine base revision 不匹配");
      }
      if (command) {
        if (command.baseRevision !== runtimeRevision) {
          throw new SimulationRuntimeDurableReplayError("revision-mismatch", "durable replay command revision 不匹配");
        }
        applyCommandToPersistentRuntime(command);
        runtimeRevision += 1;
      }
      const advanced = await advanceAuthoritativeRuntime(simulationSeconds, wallSeconds, multicore, approximate);
      if (advanced.result.changed) runtimeRevision += 1;
      return runtimeRevision;
    };

    const replayResult = await replaySimulationRuntimeDurableJournal(durableReplay, {
      executeIntent: (intent) => executeStep(
        intent.baseStateRevision,
        intent.command,
        intent.simulationSeconds,
        intent.wallSeconds,
        intent.multicore,
        intent.approximate,
        intent.registry,
      ),
      executePassiveStep: (step) => executeStep(
        step.baseStateRevision,
        null,
        step.simulationSeconds,
        step.wallSeconds,
        step.multicore,
        step.approximate,
        step.registry,
      ),
      isCancelled: () => cancelled,
      yieldControl: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      onProgress: (progress) => self.postMessage({
        id,
        changed: false,
        durationMs: Math.max(0, performance.now() - receivedAt),
        protocol: "projection",
        stateRevision: runtimeRevision,
        registryFingerprint: activeRegistryFingerprint ?? undefined,
        durableReplayProgress: progress,
      } satisfies SimulationWorkerResponse),
    });
    if (!runtime || runtimeRevision !== replayResult.finalStateRevision) {
      throw new SimulationRuntimeDurableReplayError("revision-mismatch", "durable replay final revision 不匹配");
    }
    runtimeInvalidated = false;
    let checkpoint: SimulationStateTransfer | undefined;
    let checkpointState: GameState | undefined;
    let checkpointIdentity: SimulationStateIdentity | undefined;
    if (event.data.includeCheckpointStateMirror) {
      const serialized = serializeCheckpointResponse(id, runtime.state);
      checkpoint = serialized.checkpoint;
      checkpointState = serialized.checkpointState;
    } else if (event.data.streamAuthorityProjection) {
      // The exact full state remains authoritative in this Worker. The UI only
      // needs the bounded identity proof for its ordered current-planet mirror;
      // a later save can request a fresh transferable checkpoint on demand.
      checkpointIdentity = createSimulationStateIdentity(runtime.state);
    }
    const fullProjection = attachFactoryAlertProjection(
      createFullCurrentPlanetSimulationProjection(runtime.state),
      event.data.includeFactoryAlerts === true,
    );
    uiProjectionBaseline = captureSimulationProjectionBaseline(runtime.state, { includeDeferredTopLevel: true });
    const projectionChunks = event.data.streamAuthorityProjection
      ? chunkFullRecordSimulationProjection(fullProjection)
      : [];
    for (const chunk of projectionChunks) {
      self.postMessage({
        id,
        changed: true,
        durationMs: Math.max(0, performance.now() - receivedAt),
        protocol: "projection",
        stateRevision: runtimeRevision,
        registryFingerprint: activeRegistryFingerprint ?? undefined,
        projection: chunk.projection,
        factoryAlertsGeneration: event.data.factoryAlertsGeneration,
        authorityProjectionChunk: { index: chunk.index, total: chunk.total },
      } satisfies SimulationWorkerResponse);
      if (authorityProjectionAckPort) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            authorityProjectionAckPort.removeEventListener("message", onMessage);
            reject(new Error("挂机终态 UI 投影分块确认超时"));
          }, 10_000);
          const onMessage = (ack: MessageEvent<{ index?: unknown }>) => {
            if (ack.data?.index !== chunk.index) return;
            clearTimeout(timeout);
            authorityProjectionAckPort.removeEventListener("message", onMessage);
            resolve();
          };
          authorityProjectionAckPort.addEventListener("message", onMessage);
        });
      } else if ((chunk.index + 1) % 8 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    returnSourceCheckpoint({
      changed: true,
      protocol: "projection",
      stateRevision: runtimeRevision,
      registryFingerprint: activeRegistryFingerprint ?? undefined,
      ...(!event.data.streamAuthorityProjection ? { projection: fullProjection } : {}),
      factoryAlertsGeneration: event.data.factoryAlertsGeneration,
      durableReplayResult: replayResult,
      ...(checkpoint ? { checkpoint } : {}),
      ...(checkpointState ? { checkpointState } : {}),
      ...(checkpointIdentity ? { checkpointIdentity } : {}),
      ...(event.data.streamAuthorityProjection ? { authorityProjectionChunkCount: projectionChunks.length } : {}),
    });
  } catch (error) {
    const replayError = error instanceof SimulationRuntimeDurableReplayError
      ? error
      : new SimulationRuntimeDurableReplayError("engine-failed", error instanceof Error ? error.message : "durable replay 失败");
    // A failed replay may have mutated several records. Never let a later
    // ordinary request observe or advance that partial runtime; only an exact
    // bootstrap transfer may make this Worker authoritative again.
    runtime = null;
    runtimeRevision = 0;
    runtimeInvalidated = true;
    activeRegistryFingerprint = null;
    activeRegistrySnapshot = undefined;
    multicoreExecutor?.terminate();
    multicoreExecutor = null;
    multicoreExecutorWorkerCount = 0;
    returnSourceCheckpoint({
      changed: false,
      protocol: "projection",
      durableReplayError: { code: replayError.code, message: replayError.message },
    });
  }
}

async function processSimulationRequest(event: MessageEvent<SimulationWorkerRequest>, receivedAt: number): Promise<void> {
  if (event.data.kind === "replay-durable") {
    await processDurableReplayRequest(event, receivedAt);
    return;
  }
  const { id, stateTransfer, simulationSeconds, wallSeconds, profile, registryFingerprint, registry, stateRevision } = event.data;
  const state = event.data.state ?? (stateTransfer ? deserializeSimulationStateTransfer(stateTransfer) : undefined);
  const profiler = profile ? createSimulationProfiler() : undefined;
  const reusedState = !state && Boolean(runtime);
  if (profiler && reusedState) profiler.persistentRuntimeHits += 1;
  if (runtimeInvalidated && !state) {
    self.postMessage({
      id,
      changed: false,
      durationMs: Math.max(0, performance.now() - receivedAt),
      needsState: true,
      registryFingerprint: activeRegistryFingerprint ?? undefined,
      registryError: "模拟 Worker 上一次恢复未完成，必须从精确 checkpoint 重建",
    } satisfies SimulationWorkerResponse);
    return;
  }
  if (!registryFingerprint || activeRegistryFingerprint !== registryFingerprint) {
    if (!registry || registry.fingerprint !== registryFingerprint) {
      self.postMessage({
        id,
        changed: false,
        durationMs: Math.max(0, performance.now() - receivedAt),
        needsRegistry: true,
        registryFingerprint: activeRegistryFingerprint ?? undefined,
        registryError: "内容包运行时注册表缺失或指纹不匹配",
      } satisfies SimulationWorkerResponse);
      return;
    }
    try {
      activateRuntimeRegistry(registry, profiler);
    } catch (error) {
      self.postMessage({
        id,
        changed: false,
        durationMs: Math.max(0, performance.now() - receivedAt),
        needsRegistry: true,
        registryFingerprint: activeRegistryFingerprint ?? undefined,
        registryError: error instanceof Error ? error.message : "内容包运行时目录校验失败",
      } satisfies SimulationWorkerResponse);
      return;
    }
  }
  const suppliedState = Boolean(state);
  if (state) {
    if (runtime) replacePersistentSimulationRuntimeState(runtime, state, profiler);
    else runtime = createPersistentSimulationRuntime(state, profiler);
    uiProjectionBaseline = null;
    runtimeRevision = Math.max(runtimeRevision + 1, stateRevision ?? 0);
    runtimeInvalidated = false;
  }
  if (!runtime) {
    self.postMessage({
      id,
      changed: false,
      durationMs: Math.max(0, performance.now() - receivedAt),
      needsState: true,
      registryFingerprint: activeRegistryFingerprint ?? undefined,
    } satisfies SimulationWorkerResponse);
    return;
  }
  const includeDeferredTopLevel = event.data.projectionScope === "full-top-level";
  // This baseline represents the last state sent to the UI, not merely the
  // state at the start of this one-second request. Keeping it across requests
  // removes a second full signature/index allocation from every projection.
  const requestProjectionBaseline = uiProjectionBaseline ??
    captureSimulationProjectionBaseline(runtime.state, { includeDeferredTopLevel });
  let commandApplied = false;
  if (event.data.command) {
    if (event.data.command.baseRevision !== runtimeRevision) {
      let checkpoint: SimulationStateTransfer;
      let checkpointState: GameState | undefined;
      if (event.data.checkpointIdentityOnly) {
        checkpoint = serializeSimulationStateForTransfer(runtime.state);
      } else {
        const serialized = serializeCheckpointResponse(id, runtime.state);
        checkpoint = serialized.checkpoint;
        checkpointState = serialized.checkpointState;
      }
      self.postMessage({
        id,
        changed: false,
        durationMs: Math.max(0, performance.now() - receivedAt),
        needsResync: true,
        stateRevision: runtimeRevision,
        registryFingerprint: activeRegistryFingerprint ?? undefined,
        checkpoint,
        ...(checkpointState ? { checkpointState } : {}),
        ...(event.data.checkpointIdentityOnly ? { checkpointIdentity: createSimulationStateIdentity(runtime.state) } : {}),
      } satisfies SimulationWorkerResponse, [checkpoint.buffer]);
      return;
    }
    applyCommandToPersistentRuntime(event.data.command, profiler);
    runtimeRevision += 1;
    commandApplied = true;
  }
  if (event.data.kind === "checkpoint") {
    if (commandApplied) {
      uiProjectionBaseline = captureSimulationProjectionBaseline(runtime.state, { includeDeferredTopLevel });
    }
    if (event.data.checkpointIdentityOnly) {
      if (event.data.chunkedSave) {
        const writePort = event.data.chunkedSaveWritePort;
        try {
          if (!activeRegistrySnapshot) throw new Error("模拟 Worker 缺少分块保存内容包目录");
          if (!writePort) throw new Error("模拟 Worker 缺少分块保存回压通道");
          writePort.start();
          let writeSequence = 0;
          const writeBatch = (records: LocalSaveInternalWrite[]): Promise<void> => new Promise((resolve, reject) => {
            const sequence = ++writeSequence;
            const timeout = setTimeout(() => {
              writePort.removeEventListener("message", onAck);
              reject(new Error("分块保存批次确认超时"));
            }, 120_000);
            const onAck = (ackEvent: MessageEvent<SimulationChunkedSaveWriteAck>) => {
              const ack = ackEvent.data;
              if (ack.id !== id || ack.sequence !== sequence) return;
              clearTimeout(timeout);
              writePort.removeEventListener("message", onAck);
              if (ack.ok) resolve();
              else reject(new Error(ack.error ?? "分块保存批次提交失败"));
            };
            writePort.addEventListener("message", onAck);
            writePort.postMessage({ id, sequence, records } satisfies SimulationChunkedSaveWriteRequest);
          });
          const saveState = applyAuthoritativeSaveCheckpointOverlay(
            runtime.state,
            event.data.chunkedSave.checkpointOverlay,
          );
          const chunkedSaveResult = await streamChunkedSaveJournalFromRuntimeState(
            saveState,
            activeRegistrySnapshot.registry,
            event.data.chunkedSave.options,
            event.data.chunkedSave.context,
            writeBatch,
          );
          writePort.close();
          self.postMessage({
            id,
            changed: commandApplied,
            commandApplied,
            durationMs: Math.max(0, performance.now() - receivedAt),
            protocol: event.data.protocol ?? "projection",
            stateRevision: runtimeRevision,
            registryFingerprint: activeRegistryFingerprint ?? undefined,
            checkpointIdentity: createSimulationStateIdentity(saveState),
            chunkedSaveResult,
          } satisfies SimulationWorkerResponse);
          return;
        } catch (error) {
          writePort?.close();
          // Preserve the verified full-save fallback. The failure response
          // returns one transferable checkpoint, never a second object mirror.
          const checkpoint = serializeSimulationStateForTransfer(runtime.state);
          self.postMessage({
            id,
            changed: commandApplied,
            commandApplied,
            durationMs: Math.max(0, performance.now() - receivedAt),
            protocol: event.data.protocol ?? "projection",
            stateRevision: runtimeRevision,
            registryFingerprint: activeRegistryFingerprint ?? undefined,
            checkpoint,
            checkpointIdentity: createSimulationStateIdentity(runtime.state),
            chunkedSaveError: error instanceof Error ? error.message : "权威分块保存失败",
          } satisfies SimulationWorkerResponse, [checkpoint.buffer]);
          return;
        }
      }
      const checkpoint = serializeSimulationStateForTransfer(runtime.state);
      self.postMessage({
        id,
        changed: commandApplied,
        commandApplied,
        durationMs: Math.max(0, performance.now() - receivedAt),
        protocol: event.data.protocol ?? "projection",
        stateRevision: runtimeRevision,
        registryFingerprint: activeRegistryFingerprint ?? undefined,
        checkpoint,
        checkpointIdentity: createSimulationStateIdentity(runtime.state),
      } satisfies SimulationWorkerResponse, [checkpoint.buffer]);
      return;
    }
    const { checkpoint, checkpointState } = serializeCheckpointResponse(id, runtime.state);
    self.postMessage({
      id,
      changed: commandApplied,
      commandApplied,
      durationMs: Math.max(0, performance.now() - receivedAt),
      protocol: event.data.protocol ?? "projection",
      stateRevision: runtimeRevision,
      registryFingerprint: activeRegistryFingerprint ?? undefined,
      checkpoint,
      ...(checkpointState ? { checkpointState } : {}),
    } satisfies SimulationWorkerResponse, [checkpoint.buffer]);
    return;
  }
  if (event.data.kind === "sync-projection") {
    const projection = attachFactoryAlertProjection(createDeferredTopLevelSimulationProjection(runtime.state), event.data.includeFactoryAlerts === true);
    uiProjectionBaseline = captureSimulationProjectionBaseline(runtime.state, { includeDeferredTopLevel: true });
    const response: SimulationWorkerResponse = {
      id,
      // This is a forced publication even when no simulation field changed.
      // The UI mirror may intentionally hold stale deferred top-level data.
      changed: true,
      commandApplied,
      durationMs: Math.max(0, performance.now() - receivedAt),
      protocol: "projection",
      stateRevision: runtimeRevision,
      registryFingerprint: activeRegistryFingerprint ?? undefined,
      projection,
      factoryAlertsGeneration: event.data.factoryAlertsGeneration,
    };
    if (profile) {
      try {
        response.transferBytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;
      } catch {
        response.transferBytes = 0;
      }
    }
    self.postMessage(response);
    return;
  }
  const startedAt = performance.now();
  const previousState = runtime.state;
  // The legacy experimental delta comparator requires an immutable pre-step
  // oracle because the persistent engine mutates runtime records in place.
  // This expensive clone remains isolated behind its opt-in device switch.
  const deltaBaseline = event.data.protocol === "delta" && !suppliedState ? structuredClone(previousState) : null;
  const previousRevision = runtimeRevision;
  const advanced = await advanceAuthoritativeRuntime(
    simulationSeconds,
    wallSeconds,
    event.data.multicore,
    event.data.approximate === true,
    profiler,
  );
  const { result, multicorePlan, multicoreUsed, multicoreFallback, timeWarpApproximation } = advanced;
  if (result.changed) runtimeRevision += 1;
  if (profiler && result.cacheRebuilt) profiler.persistentRuntimeRebuilds += 1;
  const projectionDeferred = result.changed && event.data.deferUiProjection === true &&
    event.data.protocol === "projection" && !commandApplied && !suppliedState && uiProjectionBaseline !== null;
  const projected = !projectionDeferred && (result.changed || commandApplied || (suppliedState && event.data.includeFactoryAlerts === true))
    ? createSimulationProjectionWithBaseline(requestProjectionBaseline, result.state, {
      compact: event.data.protocol === "projection",
      includeDeferredTopLevel,
    })
    : null;
  if (projected) uiProjectionBaseline = projected.baseline;
  const response: SimulationWorkerResponse = {
    id,
    changed: result.changed || commandApplied,
    durationMs: Math.max(0, performance.now() - startedAt),
    protocol: event.data.protocol ?? "full",
    stateRevision: runtimeRevision,
    ...(commandApplied ? { commandApplied } : {}),
    ...((result.changed || commandApplied) && event.data.protocol !== "projection" && (event.data.protocol !== "delta" || suppliedState) ? { state: result.state } : {}),
    ...(profile ? { profiler } : {}),
    reusedState,
    cacheRebuilt: result.cacheRebuilt,
    registryFingerprint: activeRegistryFingerprint ?? undefined,
    factoryAlertsGeneration: event.data.factoryAlertsGeneration,
    ...(projected ? { projection: attachFactoryAlertProjection(projected.projection, event.data.includeFactoryAlerts === true) } : {}),
    ...(projectionDeferred ? {
      projectionDeferred: true,
      deferredElapsedSeconds: result.state.elapsedSeconds,
    } : {}),
    ...(event.data.multicore ? { multicore: {
      enabled: multicoreUsed,
      workerCount: multicoreUsed ? multicoreExecutor?.workerCount ?? multicorePlan.workerCount : multicorePlan.workerCount,
      fallback: multicoreFallback,
      reason: multicorePlan.reason,
    } } : {}),
    ...(timeWarpApproximation ? { timeWarpApproximation } : {}),
  };
  if (result.changed && event.data.protocol === "delta" && !suppliedState) {
    const delta = createSimulationStateDelta(deltaBaseline ?? previousState, result.state, previousRevision, runtimeRevision);
    if (shouldUseSimulationDelta(result.state, delta)) {
      response.delta = delta;
    } else {
      // A busy end-game state can change most records every second. Sending a
      // larger delta would increase GC and structured-clone cost, so fall back
      // to the compatibility payload while keeping the same revision.
      response.protocol = "full";
      response.state = result.state;
      response.deltaFallback = "larger-than-full";
    }
  }
  if (profile) {
    try {
      const raw = JSON.stringify(response);
      response.transferBytes = typeof TextEncoder === "undefined" ? raw.length : new TextEncoder().encode(raw).byteLength;
    } catch {
      response.transferBytes = 0;
    }
  }
  self.postMessage(response);
}

function requestMulticorePlan(state: GameState, options?: MulticoreSimulationOptions) {
  return planMulticoreSimulation(state, options);
}

export {};
