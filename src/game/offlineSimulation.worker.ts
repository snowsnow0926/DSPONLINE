/// <reference lib="webworker" />

import { advanceSimulationSession, completeSimulationAdvanceSession, createSimulationAdvanceSession } from "./engine";
import { applyContentPackRuntimeSnapshot } from "./contentPacks";
import type { OfflineSimulationWorkerRequest, OfflineSimulationWorkerResponse } from "./offlineSimulation";
import { getNextOfflineCriticalEvent } from "./offlineCriticalEvents";
import { applyReturningRewardToState, inspectSave, serializeEnvelope } from "./storage";
import { getOfflineSimulationLimitSeconds } from "./endgame";
import type { GameSettings, GameState } from "./types";
import { runApproximateOfflineSettlement, runExactOfflineSettlement } from "./approximateOfflineSimulation";
import {
  deserializeOfflineSimulationState,
  serializeOfflineSimulationState,
} from "./offlineSimulationProtocol";

let activeId: number | null = null;
let cancelled = false;

function post(message: OfflineSimulationWorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function mergeUploadSettings(saved: GameSettings, menu?: Partial<GameSettings>): GameSettings {
  if (!menu) return saved;
  return {
    ...saved,
    ...menu,
    // These settings affect deterministic gameplay and must follow the save.
    defaultBeltStackSize: saved.defaultBeltStackSize,
    defaultBeltRouteMode: saved.defaultBeltRouteMode,
    productionBufferLimit: saved.productionBufferLimit,
    logisticsBufferLimit: saved.logisticsBufferLimit,
    beltBufferLimit: saved.beltBufferLimit,
    proliferatorBufferLimit: saved.proliferatorBufferLimit,
    resourceMode: saved.resourceMode,
    difficulty: saved.difficulty,
  };
}

function uploadSummary(state: GameState, payload: string, savedAt: number) {
  const envelope = JSON.parse(payload) as { checksum?: unknown };
  const stateChecksum = typeof envelope.checksum === "string" ? envelope.checksum : null;
  return {
    stateVersion: state.version,
    savedAt,
    elapsedSeconds: Math.max(0, Math.floor(state.elapsedSeconds)),
    activePlanetId: state.activePlanetId,
    entityCount: state.entities.length,
    completedTechCount: state.research.completedTechIds.length,
    structurePoints: Math.max(0, Math.floor(state.dysonSphere.structurePoints)),
    uploadedWhiteMatrix: Math.max(0, Math.floor(state.totalProduced.universe_matrix ?? 0)),
    stateChecksum,
    computedStateChecksum: stateChecksum,
    integrity: "valid" as const,
  };
}

self.onmessage = (event: MessageEvent<OfflineSimulationWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    if (activeId === request.id) cancelled = true;
    return;
  }
  activeId = request.id;
  cancelled = false;
  try {
    applyContentPackRuntimeSnapshot(request.registry);
    if (request.type === "prepare-upload") {
      const inspection = inspectSave(request.raw, request.registry.registry);
      if (!inspection.valid || !inspection.state) throw new Error(inspection.issues[0] ?? "本地存档格式或完整性无效");
      const savedAt = inspection.savedAt ?? request.now;
      const offlineSeconds = !request.skipOffline && !inspection.state.paused
        ? Math.min(getOfflineSimulationLimitSeconds(inspection.state), Math.max(0, (request.now - savedAt) / 1000))
        : 0;
      const session = createSimulationAdvanceSession(inspection.state, offlineSeconds);
      const runChunk = () => {
        if (activeId !== request.id || cancelled) {
          post({ type: "cancelled", id: request.id });
          return;
        }
        const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (session.remainingSeconds > 0) {
          do {
            const event = getNextOfflineCriticalEvent(session.state, session.remainingSeconds, 256);
            advanceSimulationSession(session, event?.seconds ?? 256);
            if (activeId !== request.id || cancelled) {
              post({ type: "cancelled", id: request.id });
              return;
            }
          } while (session.remainingSeconds > 0 &&
            (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt < 75);
          const completedSeconds = session.totalSeconds - session.remainingSeconds;
          post({
            type: "progress",
            id: request.id,
            completedSeconds,
            totalSeconds: session.totalSeconds,
            progress: session.totalSeconds > 0 ? completedSeconds / session.totalSeconds : 1,
          });
          if (session.remainingSeconds > 0) {
            setTimeout(runChunk, 0);
            return;
          }
        }
        const advanced = completeSimulationAdvanceSession(session);
        const returning = applyReturningRewardToState(advanced, savedAt, offlineSeconds, request.returningRewardClaimed);
        const state = { ...returning.state, settings: mergeUploadSettings(returning.state.settings, request.menuSettings) };
        const payload = serializeEnvelope(state, request.now, "primary", undefined, request.registry.registry);
        post({
          type: "upload-complete",
          id: request.id,
          payload,
          summary: uploadSummary(state, payload, request.now),
          offlineSeconds,
          returningReward: returning.reward.map((entry) => ({ itemId: entry.itemId, amount: entry.amount })),
        });
        activeId = null;
      };
      runChunk();
      return;
    }
    const inputBytes = request.statePayload.bytes.byteLength;
    const decodeStartedAt = performance.now();
    const state: GameState = deserializeOfflineSimulationState(request.statePayload);
    const workerDecodeMs = Math.max(0, performance.now() - decodeStartedAt);
    const runner = request.approximate ? runApproximateOfflineSettlement : runExactOfflineSettlement;
    void runner(state, request.seconds, {
      shouldCancel: () => activeId !== request.id || cancelled,
      yieldControl: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      onProgress: (progress) => post({ type: "progress", id: request.id, ...progress }),
    }).then((result) => {
      if (activeId !== request.id || cancelled) {
        post({ type: "cancelled", id: request.id });
        return;
      }
      const encodeStartedAt = performance.now();
      const statePayload = serializeOfflineSimulationState(result.state);
      const workerEncodeMs = Math.max(0, performance.now() - encodeStartedAt);
      post({
        type: "complete",
        id: request.id,
        statePayload,
        totalSeconds: request.seconds,
        diagnostics: result.diagnostics,
        transport: { inputBytes, outputBytes: statePayload.bytes.byteLength, workerDecodeMs, workerEncodeMs },
      }, [statePayload.bytes]);
      activeId = null;
    }).catch((error) => {
      if (activeId !== request.id || cancelled || (error instanceof Error && error.name === "AbortError")) {
        post({ type: "cancelled", id: request.id });
      } else {
        post({ type: "error", id: request.id, message: error instanceof Error ? error.message : "离线计算失败" });
      }
      activeId = null;
    });
  } catch (error) {
    post({ type: "error", id: request.id, message: error instanceof Error ? error.message : "离线计算失败" });
    activeId = null;
  }
};

export {};
