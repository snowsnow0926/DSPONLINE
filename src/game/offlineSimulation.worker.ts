/// <reference lib="webworker" />

import { completeSimulationAdvanceSession, createSimulationAdvanceSession } from "./engine";
import { applyContentPackRuntimeSnapshot } from "./contentPacks";
import { advanceOfflineSimulationChunk, type CloudUploadSummary, type OfflineSimulationWorkerRequest, type OfflineSimulationWorkerResponse } from "./offlineSimulation";
import {
  FAST_OFFLINE_CALIBRATION_SECONDS,
  FAST_OFFLINE_DESKTOP_DEADLINE_MS,
  runConservativeOfflineSettlement,
  runFastOfflineSettlementAsync,
  type OfflineApproximationReport,
} from "./offlineApproximation";
import {
  selectInitialOfflineWorkerStrategy,
  selectOfflineWorkerStrategyAfterFastResult,
  type OfflineWorkerSettlementRequestShape,
} from "./offlineSettlementStrategy";
import { applyReturningRewardToState, inspectSave, prepareSaveStateForBackground } from "./storage";
import { serializeSaveEnvelopeToTransfer } from "./saveTransfer";
import { getOfflineSimulationLimitSeconds } from "./endgame";
import type { GameSettings, GameState } from "./types";

let activeId: number | null = null;
let cancelled = false;

class InvalidOfflineSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOfflineSourceError";
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

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

function uploadSummary(state: GameState, stateChecksum: string, savedAt: number): CloudUploadSummary {
  return {
    mode: state.mode === "speedrun" ? "speedrun" : "normal",
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

function serializeWorkerState(
  state: GameState,
  savedAt: number,
  persistent: boolean,
  registry: Parameters<typeof prepareSaveStateForBackground>[1],
) {
  const serializedState = persistent ? prepareSaveStateForBackground(state, registry) : state;
  const serialized = serializeSaveEnvelopeToTransfer(serializedState, {
    formatVersion: 2,
    kind: "primary",
    mode: state.mode === "speedrun" ? "speedrun" : "normal",
    slot: "main",
    savedAt,
  });
  return {
    serialized,
    summary: uploadSummary(state, serialized.stateChecksum, savedAt),
  };
}

function postCompletedState(
  requestId: number,
  state: GameState,
  totalSeconds: number,
  registry: Parameters<typeof prepareSaveStateForBackground>[1],
  approximation?: OfflineApproximationReport,
): void {
  const { serialized, summary } = serializeWorkerState(state, Date.now(), false, registry);
  post({
    type: "complete",
    id: requestId,
    payloadBytes: serialized.bytes,
    payloadChecksum: serialized.payloadChecksum,
    byteLength: serialized.byteLength,
    summary,
    totalSeconds,
    ...(approximation ? { approximation } : {}),
  }, [serialized.bytes]);
}

self.onmessage = async (event: MessageEvent<OfflineSimulationWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    if (activeId === request.id) cancelled = true;
    return;
  }
  activeId = request.id;
  cancelled = false;
  const operationStartedAt = nowMs();
  let currentPhase: Extract<OfflineSimulationWorkerResponse, { type: "progress" }>["phase"] = "preparing";
  const postProgress = (
    completedSeconds: number,
    totalSeconds: number,
    extra: { algorithmVersion?: string; degradedReason?: string } = {},
  ) => {
    if (activeId !== request.id || cancelled) return;
    const wallClockMs = Math.max(0, nowMs() - operationStartedAt);
    const progress = totalSeconds > 0 ? Math.max(0, Math.min(1, completedSeconds / totalSeconds)) : 1;
    const estimatedRemainingMs = completedSeconds > 0 && completedSeconds < totalSeconds
      ? wallClockMs * (totalSeconds - completedSeconds) / completedSeconds
      : undefined;
    post({
      type: "progress",
      id: request.id,
      completedSeconds,
      totalSeconds,
      progress,
      phase: currentPhase,
      wallClockMs,
      ...(estimatedRemainingMs !== undefined ? { estimatedRemainingMs } : {}),
      ...extra,
    });
  };
  try {
    applyContentPackRuntimeSnapshot(request.registry);
    if (request.type === "prepare-upload") {
      const sourceBytes = request.rawBytes.byteLength;
      let sourceRaw = new TextDecoder("utf-8", { fatal: true }).decode(request.rawBytes);
      request.rawBytes = new ArrayBuffer(0);
      const inspectStartedAt = nowMs();
      const inspection = inspectSave(sourceRaw, request.registry.registry);
      sourceRaw = "";
      const inspectMs = Math.max(0, nowMs() - inspectStartedAt);
      if (!inspection.valid || !inspection.state) throw new Error(inspection.issues[0] ?? "本地存档格式或完整性无效");
      const savedAt = inspection.savedAt ?? request.now;
      const offlineSeconds = !request.skipOffline && !inspection.state.paused
        ? Math.min(getOfflineSimulationLimitSeconds(inspection.state), Math.max(0, (request.now - savedAt) / 1000))
        : 0;
      const session = createSimulationAdvanceSession(inspection.state, offlineSeconds);
      const offlineStartedAt = nowMs();
      const runChunk = () => {
        if (activeId !== request.id || cancelled) {
          post({ type: "cancelled", id: request.id });
          return;
        }
        currentPhase = "bounded-exact";
        const startedAt = nowMs();
        if (session.remainingSeconds > 0) {
          do {
            advanceOfflineSimulationChunk(session, { maximumWindowSeconds: 256 });
            if (activeId !== request.id || cancelled) {
              post({ type: "cancelled", id: request.id });
              return;
            }
          } while (session.remainingSeconds > 0 &&
            nowMs() - startedAt < 75);
          const completedSeconds = session.totalSeconds - session.remainingSeconds;
          postProgress(completedSeconds, session.totalSeconds);
          if (session.remainingSeconds > 0) {
            setTimeout(runChunk, 0);
            return;
          }
        }
        const advanced = completeSimulationAdvanceSession(session);
        const returning = applyReturningRewardToState(advanced, savedAt, offlineSeconds, request.returningRewardClaimed);
        const state = { ...returning.state, settings: mergeUploadSettings(returning.state.settings, request.menuSettings) };
        const offlineMs = Math.max(0, nowMs() - offlineStartedAt);
        currentPhase = "saving";
        postProgress(offlineSeconds, offlineSeconds);
        const serializeStartedAt = nowMs();
        const { serialized, summary } = serializeWorkerState(state, request.now, true, request.registry.registry);
        const serializeMs = Math.max(0, nowMs() - serializeStartedAt);
        post({
          type: "upload-complete",
          id: request.id,
          payloadBytes: serialized.bytes,
          payloadChecksum: serialized.payloadChecksum,
          byteLength: serialized.byteLength,
          summary,
          offlineSeconds,
          returningReward: returning.reward.map((entry) => ({ itemId: entry.itemId, amount: entry.amount })),
          diagnostics: {
            sourceBytes,
            payloadBytes: serialized.byteLength,
            totalMs: Math.max(0, nowMs() - operationStartedAt),
            inspectMs,
            offlineMs,
            serializeMs,
            offlineSeconds,
            skippedOffline: request.skipOffline === true,
          },
        }, [serialized.bytes]);
        activeId = null;
      };
      runChunk();
      return;
    }
    let approximation: OfflineApproximationReport | undefined;
    const strategyRequest: OfflineWorkerSettlementRequestShape = {
      approximate: request.approximate === true,
      conservativeOnly: request.conservativeOnly === true,
      speedrun: request.state.speedrun?.enabled === true,
      seconds: request.seconds,
    };
    let strategy = selectInitialOfflineWorkerStrategy(strategyRequest);
    if (strategy === "conservative-preview") {
      const conservativeReason = request.conservativeReason ??
        "Worker 达到现实时间上限后使用零校准保守宏观";
      currentPhase = "conservative";
      postProgress(0, request.seconds, {
        algorithmVersion: "fast-30s-v2",
        degradedReason: conservativeReason,
      });
      const conservative = runConservativeOfflineSettlement(
        request.state,
        request.seconds,
        request.wallSeconds ?? request.seconds,
        conservativeReason,
        undefined,
        0,
        undefined,
        true,
      );
      if (conservative.status !== "conservative") {
        if (conservative.status === "invalid-source") {
          throw new InvalidOfflineSourceError(conservative.report.fallbackReason ?? "源存档未通过保守宏观安全校验");
        }
        throw new Error(conservative.report.fallbackReason ?? "保守宏观候选无效");
      }
      postProgress(request.seconds, request.seconds, {
        algorithmVersion: conservative.report.algorithmVersion,
        degradedReason: conservative.report.fallbackReason,
      });
      post({ type: "decision-required", id: request.id, totalSeconds: request.seconds, approximation: { ...conservative.report, settlementStatus: "conservative-preview" } });
      activeId = null;
      return;
    }
    if (strategy === "fast") {
      // Do not create the exact session until the fast path declines. The
      // fast contract owns isolated calibration copies and otherwise this
      // would clone the entire save twice before any useful work starts.
      const experiment = await runFastOfflineSettlementAsync(request.state, request.seconds, {
        wallSeconds: request.wallSeconds ?? request.seconds,
        deadlineAtMs: nowMs() + Math.max(1_000, request.deadlineMs ?? FAST_OFFLINE_DESKTOP_DEADLINE_MS),
        shouldCancel: () => activeId !== request.id || cancelled,
        onPhase: (phase) => {
          currentPhase = phase === "calibrating" ? "calibrating"
            : phase === "macro" ? "macro"
              : phase === "validating" ? "validating"
                : "conservative";
          postProgress(0, request.seconds, { algorithmVersion: "fast-30s-v2" });
        },
        onProgress: (completedSeconds, totalSeconds) => {
          postProgress(completedSeconds, totalSeconds, { algorithmVersion: "fast-30s-v2" });
        },
      });
      approximation = experiment.report;
      strategy = selectOfflineWorkerStrategyAfterFastResult(strategyRequest, experiment);
      if (experiment.status === "approximate" || experiment.status === "bounded-exact") {
        currentPhase = experiment.status === "bounded-exact" ? "bounded-exact" : "macro";
        postProgress(request.seconds, request.seconds, {
          algorithmVersion: experiment.report.algorithmVersion,
          degradedReason: experiment.report.fallbackReason,
        });
        postCompletedState(request.id, experiment.state, request.seconds, request.registry.registry, approximation);
        activeId = null;
        return;
      }
      if (experiment.status === "conservative") {
        currentPhase = "conservative";
        postProgress(request.seconds, request.seconds, {
          algorithmVersion: experiment.report.algorithmVersion,
          degradedReason: experiment.report.fallbackReason,
        });
        post({ type: "decision-required", id: request.id, totalSeconds: request.seconds, approximation: { ...experiment.report, settlementStatus: "conservative-preview" } });
        activeId = null;
        return;
      }
      if (strategy === "invalid-source") {
        throw new InvalidOfflineSourceError(experiment.report.fallbackReason ?? "源存档未通过快速结算安全校验");
      }
      if (strategy === "conservative-preview") {
        currentPhase = "conservative";
        postProgress(FAST_OFFLINE_CALIBRATION_SECONDS, request.seconds, {
          algorithmVersion: experiment.report.algorithmVersion,
          degradedReason: experiment.report.fallbackReason,
        });
        const conservative = runConservativeOfflineSettlement(
          request.state,
          request.seconds,
          request.wallSeconds ?? request.seconds,
          experiment.report.fallbackReason ?? "普通合同不可用，已使用保守宏观结算",
        );
        if (conservative.status === "conservative") {
          postProgress(request.seconds, request.seconds, {
            algorithmVersion: conservative.report.algorithmVersion,
            degradedReason: conservative.report.fallbackReason,
          });
          post({ type: "decision-required", id: request.id, totalSeconds: request.seconds, approximation: { ...conservative.report, settlementStatus: "conservative-preview" } });
          activeId = null;
          return;
        }
        if (conservative.status === "invalid-source") {
          throw new InvalidOfflineSourceError(conservative.report.fallbackReason ?? "源存档未通过保守宏观安全校验");
        }
        throw new Error(conservative.report.fallbackReason ?? "保守宏观候选无效");
      }
    }
    currentPhase = "bounded-exact";
    const session = createSimulationAdvanceSession(request.state, request.seconds);
    const runChunk = () => {
      if (activeId !== request.id || cancelled) {
        post({ type: "cancelled", id: request.id });
        return;
      }
      const startedAt = nowMs();
      do {
        // The helper only changes scheduling overhead. Every engine step and
        // settlement boundary remains the same deterministic path.
        advanceOfflineSimulationChunk(session, { maximumWindowSeconds: 256 });
        if (activeId !== request.id || cancelled) {
          post({ type: "cancelled", id: request.id });
          return;
        }
      } while (session.remainingSeconds > 0 &&
        nowMs() - startedAt < 75);
      const completedSeconds = session.totalSeconds - session.remainingSeconds;
      postProgress(completedSeconds, session.totalSeconds, { algorithmVersion: "deterministic-exact" });
      if (session.remainingSeconds > 0) {
        setTimeout(runChunk, 0);
        return;
      }
      postCompletedState(request.id, completeSimulationAdvanceSession(session), session.totalSeconds, request.registry.registry, approximation);
      activeId = null;
    };
    runChunk();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      post({ type: "cancelled", id: request.id });
      activeId = null;
      return;
    }
    post({
      type: "error",
      id: request.id,
      message: error instanceof Error ? error.message : "离线计算失败",
      code: error instanceof InvalidOfflineSourceError ? "invalid-source" : "worker-failure",
    });
    activeId = null;
  }
};

export {};
