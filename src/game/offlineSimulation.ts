import type { GameSettings, GameState } from "./types";
import { OFFLINE_PERFORMANCE_SESSION_KEY } from "./performanceMonitor";
import { createContentPackRuntimeSnapshot, loadContentPackRegistry, type ContentPackRuntimeSnapshot } from "./contentPacks";
import { advanceSimulationSession, type SimulationAdvanceSession } from "./engine";
import { getNextOfflineCriticalEvent } from "./offlineCriticalEvents";
import {
  runOfflineApproximation,
  type OfflineApproximationReport,
} from "./offlineApproximation";
import {
  classifyOfflineWorkload,
  type OfflineComplexityReport,
} from "./offlineComplexity";
import { decodeVerifiedSaveTransfer, type SaveTransferVerification } from "./saveTransfer";

export type OfflineSimulationWorkerRequest =
  | {
    type: "start";
    id: number;
    state: GameState;
    seconds: number;
    wallSeconds?: number;
    registry: ContentPackRuntimeSnapshot;
    approximate?: boolean;
    conservativeOnly?: boolean;
    conservativeReason?: string;
    deadlineMs?: number;
  }
  | {
    type: "prepare-upload";
    id: number;
    rawBytes: ArrayBuffer;
    now: number;
    menuSettings?: Partial<GameSettings>;
    returningRewardClaimed: boolean;
    skipOffline?: boolean;
    registry: ContentPackRuntimeSnapshot;
  }
  | { type: "cancel"; id: number };

export type OfflineSimulationWorkerResponse =
  | {
    type: "progress";
    id: number;
    completedSeconds: number;
    totalSeconds: number;
    progress: number;
    phase: OfflineSimulationPhase;
    wallClockMs: number;
    estimatedRemainingMs?: number;
    algorithmVersion?: string;
    degradedReason?: string;
  }
  | {
    type: "complete";
    id: number;
    payloadBytes: ArrayBuffer;
    payloadChecksum: string;
    byteLength: number;
    summary: CloudUploadSummary;
    totalSeconds: number;
    approximation?: OfflineApproximationReport;
  }
  | { type: "decision-required"; id: number; totalSeconds: number; approximation: OfflineApproximationReport }
  | {
    type: "upload-complete";
    id: number;
    payloadBytes: ArrayBuffer;
    payloadChecksum: string;
    byteLength: number;
    summary: CloudUploadSummary;
    offlineSeconds: number;
    returningReward: Array<{ itemId: string; amount: number }>;
    diagnostics?: CloudUploadPreparationDiagnostics;
  }
  | { type: "cancelled"; id: number }
  | {
    type: "error";
    id: number;
    message: string;
    code: "invalid-source" | "worker-failure";
  };

export interface OfflineSimulationProgress {
  completedSeconds: number;
  totalSeconds: number;
  progress: number;
  phase: OfflineSimulationPhase;
  wallClockMs: number;
  estimatedRemainingMs?: number;
  algorithmVersion?: string;
  degradedReason?: string;
}

export type OfflineSimulationPhase =
  | "preparing"
  | "calibrating"
  | "macro"
  | "conservative"
  | "validating"
  | "bounded-exact"
  | "saving";

export interface OfflineSimulationCompletedResult {
  status: "complete";
  state: GameState;
  approximation?: OfflineApproximationReport;
  complexity: OfflineComplexityReport;
}

export interface OfflineSimulationDecisionResult {
  status: "decision-required";
  approximation: OfflineApproximationReport;
  complexity: OfflineComplexityReport;
}

export type OfflineSimulationRunResult = OfflineSimulationCompletedResult | OfflineSimulationDecisionResult;

export class OfflineSettlementDecisionRequiredError extends Error {
  constructor(readonly approximation: OfflineApproximationReport, readonly complexity: OfflineComplexityReport) {
    super(approximation.fallbackReason ?? "快速离线结算未完成，需要玩家选择后续操作");
    this.name = "OfflineSettlementDecisionRequiredError";
  }
}

export interface OfflineSimulationChunkOptions {
  /** Maximum amount of deterministic session work requested per worker turn. */
  maximumWindowSeconds?: number;
  /** Keep critical-event scheduling for sessions whose engine step is larger than a hub boundary. */
  scanCriticalEvents?: boolean;
}

/**
 * Advance one bounded exact chunk without inventing an alternate simulation
 * formula. Sessions with a five-second hub step already settle every
 * boundary inside the engine; scanning every machine for a cycle boundary in
 * that case only adds O(entityCount) work and can never make the engine settle
 * an extra phase. Larger-step sessions retain the conservative event hint.
 */
export function advanceOfflineSimulationChunk(
  session: SimulationAdvanceSession,
  options: OfflineSimulationChunkOptions = {},
): number {
  const maximumWindowSeconds = Math.max(1, Math.floor(options.maximumWindowSeconds ?? 256));
  const scanCriticalEvents = options.scanCriticalEvents ?? session.stepSize > 5;
  const event = scanCriticalEvents
    ? getNextOfflineCriticalEvent(session.state, session.remainingSeconds, maximumWindowSeconds)
    : null;
  return advanceSimulationSession(session, event?.seconds ?? maximumWindowSeconds);
}

export interface CloudUploadSummary {
  mode: "normal" | "speedrun";
  stateVersion: number;
  savedAt: number;
  elapsedSeconds: number;
  activePlanetId: string;
  entityCount: number;
  completedTechCount: number;
  structurePoints: number;
  uploadedWhiteMatrix: number;
  stateChecksum: string | null;
  computedStateChecksum?: string | null;
  integrity?: "valid" | "invalid";
}

export interface CloudUploadPreparationDiagnostics {
  sourceBytes: number;
  payloadBytes: number;
  totalMs: number;
  inspectMs: number;
  offlineMs: number;
  serializeMs: number;
  offlineSeconds: number;
  skippedOffline: boolean;
}

function parseTrustedOfflineWorkerState(raw: string, summary: CloudUploadSummary): GameState {
  const envelope = JSON.parse(raw) as {
    formatVersion?: unknown;
    mode?: unknown;
    checksum?: unknown;
    state?: unknown;
  };
  if (envelope.formatVersion !== 2 || envelope.mode !== summary.mode ||
    typeof envelope.checksum !== "string" || envelope.checksum !== summary.stateChecksum ||
    !envelope.state || typeof envelope.state !== "object" || Array.isArray(envelope.state)) {
    throw new Error("离线 Worker 结果信封与完整性证明不一致");
  }
  const state = envelope.state as GameState;
  if (state.version !== summary.stateVersion || state.mode !== summary.mode ||
    !Array.isArray(state.entities) || state.entities.length !== summary.entityCount) {
    throw new Error("离线 Worker 结果摘要与游戏状态不一致");
  }
  return state;
}

export function runOfflineSimulationInWorker(
  state: GameState,
  seconds: number,
  options: { signal?: AbortSignal; onProgress?: (progress: OfflineSimulationProgress) => void; registry?: ContentPackRuntimeSnapshot; approximate?: boolean; onApproximationReport?: (report: OfflineApproximationReport) => void } = {},
): Promise<GameState> {
  return runOfflineSimulationInWorkerDetailed(state, seconds, options).then((result) => {
    if (result.status === "decision-required") throw new OfflineSettlementDecisionRequiredError(result.approximation, result.complexity);
    return result.state;
  });
}

export function runOfflineSimulationInWorkerDetailed(
  state: GameState,
  seconds: number,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: OfflineSimulationProgress) => void;
    registry?: ContentPackRuntimeSnapshot;
    approximate?: boolean;
    conservativeOnly?: boolean;
    conservativeReason?: string;
    wallSeconds?: number;
    deadlineMs?: number;
    onApproximationReport?: (report: OfflineApproximationReport) => void;
    onComplexity?: (report: OfflineComplexityReport) => void;
    complexity?: OfflineComplexityReport;
  } = {},
): Promise<OfflineSimulationRunResult> {
  if (typeof Worker === "undefined") return Promise.reject(new Error("当前浏览器不支持离线计算 Worker"));
  const complexity = options.complexity ?? classifyOfflineWorkload(state, seconds);
  options.onComplexity?.(complexity);
  const classifierConservative = options.approximate === true && complexity.recommendedStrategy === "conservative";
  const conservativeOnly = options.conservativeOnly === true || classifierConservative;
  const conservativeReason = options.conservativeReason ?? (classifierConservative
    ? `${complexity.warning ?? "当前设备资源不足以安全执行多份精确校准副本"}（${complexity.profile}）`
    : undefined);
  const worker = new Worker(new URL("./offlineSimulation.worker.ts", import.meta.url), { type: "module", name: "offline-simulation" });
  const id = Date.now() + Math.floor(Math.random() * 1_000_000);
  const startedAt = performance.now();
  const deadlineMs = options.deadlineMs ?? (options.approximate === true
    ? complexity.recommendedDeadlineMs || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? 60_000 : 30_000)
    : undefined);
  const conservativeReserveMs = options.approximate === true && !conservativeOnly && deadlineMs !== undefined
    ? Math.min(5_000, Math.max(1_000, deadlineMs / 4))
    : 0;
  const workerDeadlineMs = deadlineMs === undefined ? undefined : Math.max(1_000, deadlineMs - conservativeReserveMs);
  const registry = options.registry ?? createContentPackRuntimeSnapshot(loadContentPackRegistry());
  return new Promise<OfflineSimulationRunResult>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: number | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== null) window.clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const failOrRetryConservative = (reason: string, terminalMessage: string) => {
      finish(() => {
        if (options.approximate === true && !conservativeOnly && !options.signal?.aborted) {
          void runOfflineSimulationInWorkerDetailed(state, seconds, {
            ...options,
            conservativeOnly: true,
            conservativeReason: reason,
            deadlineMs: conservativeReserveMs > 0 ? conservativeReserveMs : 5_000,
          }).then(resolve, reject);
          return;
        }
        reject(new Error(terminalMessage));
      });
    };
    const abort = () => {
      try { worker.postMessage({ type: "cancel", id } satisfies OfflineSimulationWorkerRequest); } catch { /* worker may already be gone */ }
      finish(() => reject(new DOMException("离线计算已取消", "AbortError")));
    };
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (workerDeadlineMs !== undefined) {
      deadlineTimer = window.setTimeout(() => {
        try { worker.postMessage({ type: "cancel", id } satisfies OfflineSimulationWorkerRequest); } catch { /* worker may be blocked */ }
        failOrRetryConservative(
          "快速 Worker 达到现实时间上限，已使用零校准保守宏观",
          "离线计算达到现实时间上限，临时候选已丢弃，原存档保持不变",
        );
      }, workerDeadlineMs + 250);
    }
    worker.onmessage = (event: MessageEvent<OfflineSimulationWorkerResponse>) => {
      if (settled) return;
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === "progress") {
        options.onProgress?.(message);
        return;
      }
      if (message.type === "complete") {
        try {
          const verification: SaveTransferVerification = {
            integrity: "valid",
            stateChecksum: message.summary.stateChecksum ?? "",
            payloadChecksum: message.payloadChecksum,
            byteLength: message.byteLength,
          };
          const raw = decodeVerifiedSaveTransfer(message.payloadBytes, verification);
          const workerState = parseTrustedOfflineWorkerState(raw, message.summary);
          try { window.sessionStorage.setItem(OFFLINE_PERFORMANCE_SESSION_KEY, String(Math.max(0, performance.now() - startedAt))); } catch { /* optional diagnostics */ }
          if (message.approximation) options.onApproximationReport?.(message.approximation);
          finish(() => resolve({ status: "complete", state: workerState, approximation: message.approximation, complexity }));
        } catch (error) {
          failOrRetryConservative(
            "离线 Worker 结果传输校验失败，已使用一次零校准保守宏观恢复",
            `${error instanceof Error ? error.message : "离线结果传输失败"}；未保存任何半成品`,
          );
        }
        return;
      }
      if (message.type === "decision-required") {
        const approximation = { ...message.approximation, settlementStatus: "conservative-preview" as const };
        options.onApproximationReport?.(approximation);
        finish(() => resolve({ status: "decision-required", approximation, complexity }));
        return;
      }
      if (message.type === "cancelled") {
        finish(() => reject(new DOMException("离线计算已取消", "AbortError")));
        return;
      }
      if (message.type === "error") {
        if (message.code === "worker-failure") {
          failOrRetryConservative(
            `快速 Worker 返回异常，已使用一次零校准保守宏观恢复：${message.message}`,
            `${message.message}；未保存任何半成品`,
          );
        } else {
          finish(() => reject(new Error(message.message)));
        }
      }
    };
    worker.onerror = () => failOrRetryConservative(
      "快速 Worker 运行失败，已使用一次零校准保守宏观恢复",
      "离线计算 Worker 运行失败，未保存任何半成品",
    );
    try {
      worker.postMessage({
        type: "start",
        id,
        state,
        seconds,
        wallSeconds: options.wallSeconds,
        registry,
        approximate: options.approximate === true,
        conservativeOnly,
        conservativeReason,
        deadlineMs: workerDeadlineMs,
      } satisfies OfflineSimulationWorkerRequest);
    } catch {
      failOrRetryConservative(
        "快速 Worker 无法启动，已使用一次零校准保守宏观恢复",
        "无法启动离线计算 Worker，未保存任何半成品",
      );
    }
  });
}

/**
 * Prepare a cloud payload without loading, simulating or serializing the save
 * on the UI thread. The Worker returns the one final checksum-verified payload
 * used by local persistence, conflict comparison and upload.
 */
export function prepareCloudUploadInWorker(
  raw: string,
  options: {
    signal?: AbortSignal;
    now?: number;
    menuSettings?: Partial<GameSettings>;
    returningRewardClaimed?: boolean;
    skipOffline?: boolean;
    registry?: ContentPackRuntimeSnapshot;
    onProgress?: (progress: OfflineSimulationProgress) => void;
  } = {},
): Promise<{
  payload: string;
  summary: CloudUploadSummary;
  verification: SaveTransferVerification;
  offlineSeconds: number;
  returningReward: Array<{ itemId: string; amount: number }>;
  diagnostics: CloudUploadPreparationDiagnostics;
}> {
  if (typeof Worker === "undefined") return Promise.reject(new Error("当前浏览器不支持云存档后台 Worker"));
  const worker = new Worker(new URL("./offlineSimulation.worker.ts", import.meta.url), { type: "module", name: "cloud-upload-preparation" });
  const id = Date.now() + Math.floor(Math.random() * 1_000_000);
  const registry = options.registry ?? createContentPackRuntimeSnapshot(loadContentPackRegistry());
  const now = options.now ?? Date.now();
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const abort = () => {
      try { worker.postMessage({ type: "cancel", id } satisfies OfflineSimulationWorkerRequest); } catch { /* worker may already be gone */ }
      finish(() => reject(new DOMException("云存档准备已取消", "AbortError")));
    };
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<OfflineSimulationWorkerResponse>) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === "progress") {
        options.onProgress?.(message);
        return;
      }
      if (message.type === "upload-complete") {
        const verification: SaveTransferVerification = {
          integrity: "valid",
          stateChecksum: message.summary.stateChecksum ?? "",
          payloadChecksum: message.payloadChecksum,
          byteLength: message.byteLength,
        };
        let payload: string;
        try {
          payload = decodeVerifiedSaveTransfer(message.payloadBytes, verification);
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error("云存档传输校验失败")));
          return;
        }
        const diagnostics = message.diagnostics ?? {
          sourceBytes: 0,
          payloadBytes: message.byteLength,
          totalMs: Math.max(0, performance.now() - startedAt),
          inspectMs: 0,
          offlineMs: 0,
          serializeMs: 0,
          offlineSeconds: message.offlineSeconds,
          skippedOffline: options.skipOffline === true,
        };
        finish(() => resolve({ payload, summary: message.summary, verification, offlineSeconds: message.offlineSeconds, returningReward: message.returningReward, diagnostics }));
        return;
      }
      if (message.type === "cancelled") {
        finish(() => reject(new DOMException("云存档准备已取消", "AbortError")));
        return;
      }
      if (message.type === "error") finish(() => reject(new Error(message.message)));
    };
    worker.onerror = () => finish(() => reject(new Error("云存档后台 Worker 运行失败，未修改本地存档")));
    try {
      const encoded = new TextEncoder().encode(raw);
      const rawBytes = encoded.buffer;
      worker.postMessage({
        type: "prepare-upload",
        id,
        rawBytes,
        now,
        menuSettings: options.menuSettings,
        returningRewardClaimed: options.returningRewardClaimed ?? false,
        skipOffline: options.skipOffline === true,
        registry,
      } satisfies OfflineSimulationWorkerRequest, [rawBytes]);
    } catch {
      finish(() => reject(new Error("云存档无法交给后台 Worker 处理，未修改本地存档")));
    }
  });
}
