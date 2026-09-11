/// <reference lib="webworker" />

import {
  applyContentPackRuntimeSnapshot,
  type ContentPackRuntimeSnapshot,
} from "./contentPacks";
import {
  advancePureIdleMacroSession,
  createPureIdleMacroSession,
  finalizePureIdleMacroCandidate,
  PURE_IDLE_MACRO_ALGORITHM_VERSION,
  PURE_IDLE_MACRO_OPERATION_DEADLINE_MS,
  type PureIdleMacroMode,
  type PureIdleMacroPhase,
  type PureIdleMacroSession,
  type PureIdleMacroSummary,
} from "./pureIdleMacro";
import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import type { GameState } from "./types";

export type PureIdleMacroWorkerRequest =
  | {
    id: number;
    type: "initialize";
    state: GameState;
    mode: PureIdleMacroMode;
    registry: ContentPackRuntimeSnapshot;
    deadlineMs?: number;
    forceConservativeReason?: string;
  }
  | { id: number; type: "advance"; targetWallSeconds: number; deadlineMs?: number }
  | { id: number; type: "finalize"; targetWallSeconds: number; deadlineMs?: number }
  | { id: number; type: "cancel"; targetId?: number };

export type PureIdleMacroWorkerResponse =
  | {
    id: number;
    type: "ready" | "advanced";
    summary: PureIdleMacroSummary;
    durationMs: number;
  }
  | {
    id: number;
    type: "progress";
    operation: Exclude<PureIdleMacroWorkerRequest["type"], "cancel">;
    phase: PureIdleMacroPhase;
    wallClockMs: number;
    algorithmVersion: string;
  }
  | {
    id: number;
    type: "cancelled";
    operation: Exclude<PureIdleMacroWorkerRequest["type"], "cancel">;
    durationMs: number;
  }
  | {
    id: number;
    type: "finalized";
    summary: PureIdleMacroSummary;
    payloadBytes: ArrayBuffer;
    payloadChecksum: string;
    stateChecksum: string;
    byteLength: number;
    stateVersion: number;
    mode: "normal" | "speedrun";
    entityCount: number;
    rawBytes: number;
    durationMs: number;
  }
  | {
    id: number;
    type: "error";
    operation: Exclude<PureIdleMacroWorkerRequest["type"], "cancel">;
    message: string;
    recoverable: true;
    durationMs: number;
  };

let session: PureIdleMacroSession | null = null;
let registry: ContentPackRuntimeSnapshot | null = null;
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
      applyContentPackRuntimeSnapshot(request.registry);
      registry = request.registry;
      postProgress(request.forceConservativeReason ? "conservative" : "calibrating");
      session = createPureIdleMacroSession(request.state, request.mode, {
        deadlineAtMs,
        shouldCancel: interrupted,
        forceConservativeReason: request.forceConservativeReason,
      });
      self.postMessage({
        id: request.id,
        type: "ready",
        summary: advancePureIdleMacroSession(session, 0),
        durationMs: Math.max(0, performance.now() - startedAt),
      } satisfies PureIdleMacroWorkerResponse);
      return;
    }
    if (!session || !registry) throw new Error("纯挂机 Worker 尚未完成校准");
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
    postProgress("finalizing");
    const result = finalizePureIdleMacroCandidate(session, request.targetWallSeconds, {
      deadlineAtMs,
      shouldCancel: interrupted,
    });
    const mode = result.state.mode === "speedrun" ? "speedrun" : "normal";
    const serialized = serializeSaveEnvelopeToTransfer(result.state, {
      formatVersion: 2,
      kind: "primary",
      mode,
      slot: "main",
      savedAt: Date.now(),
    });
    self.postMessage({
      id: request.id,
      type: "finalized",
      summary: result.summary,
      payloadBytes: serialized.bytes,
      payloadChecksum: serialized.payloadChecksum,
      stateChecksum: serialized.stateChecksum,
      byteLength: serialized.byteLength,
      stateVersion: result.state.version,
      mode,
      entityCount: result.state.entities.length,
      rawBytes: serialized.byteLength,
      durationMs: Math.max(0, performance.now() - startedAt),
    } satisfies PureIdleMacroWorkerResponse, [serialized.bytes]);
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
