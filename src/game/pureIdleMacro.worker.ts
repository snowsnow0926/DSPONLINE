/// <reference lib="webworker" />

import {
  applyContentPackRuntimeSnapshot,
  type ContentPackRegistry,
} from "./contentPacks";
import {
  applyPureIdleMacroFinalState,
  advancePureIdleMacroSession,
  createPureIdleMacroSession,
  finalizePureIdleMacroCandidate,
  PURE_IDLE_MACRO_ALGORITHM_VERSION,
  PURE_IDLE_MACRO_OPERATION_DEADLINE_MS,
  type PureIdleMacroFinalStateOptions,
  type PureIdleMacroPhase,
  type PureIdleMacroSession,
} from "./pureIdleMacro";
import type {
  PureIdleMacroFinalizedIdentity,
  PureIdleMacroWorkerRequest,
  PureIdleMacroWorkerResponse,
} from "./pureIdleMacroProtocol";
import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import { projectPersistentSaveState } from "./saveProjection";
import {
  createImmutableWorkerBinaryPayload,
  workerBinaryPayloadTransferables,
} from "./workerBinaryPayload";

export type { PureIdleMacroWorkerRequest, PureIdleMacroWorkerResponse } from "./pureIdleMacroProtocol";

interface PureIdleMacroWorkerSessionContext {
  session: PureIdleMacroSession;
  registryFingerprint: string;
  registry: ContentPackRegistry;
  terminalState?: PureIdleMacroFinalStateOptions;
}

function readTerminalState(request: Extract<PureIdleMacroWorkerRequest, { type: "initialize" }>): PureIdleMacroFinalStateOptions | undefined {
  const hasTerminalState = request.startedPaused !== undefined ||
    request.baselineIdleSettlement !== undefined || request.baselineTotalProduced !== undefined;
  if (!hasTerminalState) return undefined;
  if (typeof request.startedPaused !== "boolean" ||
    !request.baselineIdleSettlement || typeof request.baselineIdleSettlement !== "object" ||
    !request.baselineTotalProduced || typeof request.baselineTotalProduced !== "object" ||
    Array.isArray(request.baselineTotalProduced)) {
    throw new Error("纯挂机 Worker 终止态基线不完整");
  }
  return {
    startedPaused: request.startedPaused,
    baselineIdleSettlement: request.baselineIdleSettlement,
    baselineTotalProduced: request.baselineTotalProduced,
  };
}

let sessionContext: PureIdleMacroWorkerSessionContext | null = null;
let queue: Promise<void> = Promise.resolve();
let activeRequestId: number | null = null;
const cancelledRequestIds = new Set<number>();

self.onmessage = (event: MessageEvent<PureIdleMacroWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    const targetId = request.targetId ?? activeRequestId;
    if (targetId !== null) cancelledRequestIds.add(targetId);
    return;
  }
  queue = queue.then(() => processRequest(request)).catch((error) => {
    self.postMessage({
      id: request.id,
      type: "error",
      operation: request.type,
      message: error instanceof Error ? error.message : "纯挂机 Worker 发生未知错误",
      recoverable: true,
      durationMs: 0,
    } satisfies PureIdleMacroWorkerResponse);
  });
};

async function processRequest(request: PureIdleMacroWorkerRequest): Promise<void> {
  if (request.type === "cancel") return;
  const startedAt = performance.now();
  activeRequestId = request.id;
  const deadlineAtMs = startedAt + Math.max(1_000, request.deadlineMs ?? PURE_IDLE_MACRO_OPERATION_DEADLINE_MS);
  const operation = request.type;
  const interrupted = () => cancelledRequestIds.has(request.id);
  const postProgress = (phase: PureIdleMacroPhase) => {
    self.postMessage({
      id: request.id,
      type: "progress",
      operation,
      phase,
      wallClockMs: Math.max(0, performance.now() - startedAt),
      algorithmVersion: PURE_IDLE_MACRO_ALGORITHM_VERSION,
    } satisfies PureIdleMacroWorkerResponse);
  };
  try {
    if (request.type === "initialize") {
      postProgress(request.forceConservativeReason ? "conservative" : "preparing-power");
      sessionContext = null;
      applyContentPackRuntimeSnapshot(request.registry);
      postProgress(request.forceConservativeReason ? "conservative" : "calibrating");
      const initializedSession = createPureIdleMacroSession(request.state, request.mode, {
        deadlineAtMs,
        shouldCancel: interrupted,
        forceConservativeReason: request.forceConservativeReason,
      });
      const summary = advancePureIdleMacroSession(initializedSession, 0);
      const terminalState = readTerminalState(request);
      sessionContext = {
        session: initializedSession,
        registryFingerprint: request.registry.fingerprint,
        registry: request.registry.registry,
        ...(terminalState ? { terminalState } : {}),
      };
      self.postMessage({
        id: request.id,
        type: "ready",
        summary,
        durationMs: Math.max(0, performance.now() - startedAt),
      } satisfies PureIdleMacroWorkerResponse);
      return;
    }
    if (!sessionContext) throw new Error("纯挂机 Worker 尚未完成校准");
    const { session } = sessionContext;
    if (request.type === "advance") {
      postProgress(session.conservativeOnly ? "conservative" : "running");
      self.postMessage({
        id: request.id,
        type: "advanced",
        summary: advancePureIdleMacroSession(session, request.targetWallSeconds, { deadlineAtMs, shouldCancel: interrupted }),
        durationMs: Math.max(0, performance.now() - startedAt),
      } satisfies PureIdleMacroWorkerResponse);
      return;
    }
    if (request.terminal && !sessionContext.terminalState) {
      throw new Error("纯挂机 Worker 缺少终止态基线，未生成可提交 envelope");
    }
    postProgress("finalizing");
    const result = finalizePureIdleMacroCandidate(session, request.targetWallSeconds, {
      deadlineAtMs,
      shouldCancel: interrupted,
    });
    const finalState = request.terminal
      ? applyPureIdleMacroFinalState(result.state, request.targetWallSeconds, sessionContext.terminalState!)
      : result.state;
    // Keep the pure-idle stop path on the same sparse, canonical persistence
    // boundary as ordinary autosave/manual-save. Serializing the full runtime
    // state here retained exact defaults on every late-game entity and could
    // hold the Worker for minutes on 70+ MiB saves.
    const persistent = projectPersistentSaveState(finalState, sessionContext.registry);
    const mode = persistent.mode === "speedrun" ? "speedrun" : "normal";
    const savedAt = Date.now();
    const serialized = serializeSaveEnvelopeToTransfer(persistent, {
      formatVersion: 2,
      kind: "primary",
      mode,
      slot: "main",
      savedAt,
    });
    const identity: PureIdleMacroFinalizedIdentity = {
      stateChecksum: serialized.stateChecksum,
      stateVersion: persistent.version,
      mode,
      activePlanetId: persistent.activePlanetId,
      entityCount: persistent.entities.length,
      beltCount: persistent.belts.length,
      elapsedSeconds: persistent.elapsedSeconds,
      algorithmVersion: result.summary.algorithmVersion,
      settledWallSeconds: result.summary.settledWallSeconds,
      settledSimulationSeconds: result.summary.settledSimulationSeconds,
      registryFingerprint: sessionContext.registryFingerprint,
    };
    const payloadBytes = createImmutableWorkerBinaryPayload(
      serialized.bytes,
      request.binaryTransport ?? "array-buffer",
    );
    self.postMessage({
      id: request.id,
      type: "finalized",
      summary: result.summary,
      finalEnvelope: {
        payloadBytes,
        verification: {
          integrity: serialized.integrity,
          stateChecksum: serialized.stateChecksum,
          payloadChecksum: serialized.payloadChecksum,
          byteLength: serialized.byteLength,
        },
        identity,
      },
      durationMs: Math.max(0, performance.now() - startedAt),
    } satisfies PureIdleMacroWorkerResponse, workerBinaryPayloadTransferables(payloadBytes));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      self.postMessage({
        id: request.id,
        type: "cancelled",
        operation,
        durationMs: Math.max(0, performance.now() - startedAt),
      } satisfies PureIdleMacroWorkerResponse);
      return;
    }
    self.postMessage({
      id: request.id,
      type: "error",
      operation: request.type,
      message: error instanceof Error ? error.message : "纯挂机 Worker 处理失败",
      recoverable: true,
      durationMs: Math.max(0, performance.now() - startedAt),
    } satisfies PureIdleMacroWorkerResponse);
  } finally {
    cancelledRequestIds.delete(request.id);
    if (activeRequestId === request.id) activeRequestId = null;
  }
}

export {};
