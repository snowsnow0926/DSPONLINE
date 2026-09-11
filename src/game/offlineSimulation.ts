import type { GameSettings, GameState } from "./types";
import { OFFLINE_PERFORMANCE_SESSION_KEY } from "./performanceMonitor";
import { createContentPackRuntimeSnapshot, loadContentPackRegistry, type ContentPackRuntimeSnapshot } from "./contentPacks";
import type { OfflineSettlementDiagnostics, OfflineSettlementPhase, OfflineSettlementTransportDiagnostics } from "./offlineExperiment";
import {
  deserializeOfflineSimulationState,
  serializeOfflineSimulationState,
  type OfflineSimulationStatePayload,
} from "./offlineSimulationProtocol";

export type OfflineSimulationWorkerRequest =
  | { type: "start"; id: number; statePayload: OfflineSimulationStatePayload; seconds: number; approximate?: boolean; registry: ContentPackRuntimeSnapshot }
  | {
    type: "prepare-upload";
    id: number;
    raw: string;
    now: number;
    menuSettings?: Partial<GameSettings>;
    returningRewardClaimed: boolean;
    skipOffline?: boolean;
    registry: ContentPackRuntimeSnapshot;
  }
  | { type: "cancel"; id: number };

export type OfflineSimulationWorkerResponse =
  | { type: "progress"; id: number; completedSeconds: number; totalSeconds: number; progress: number; phase?: OfflineSettlementPhase; approximateSeconds?: number; estimatedError?: number }
  | {
    type: "complete";
    id: number;
    statePayload: OfflineSimulationStatePayload;
    totalSeconds: number;
    diagnostics?: OfflineSettlementDiagnostics;
    transport: Pick<OfflineSettlementTransportDiagnostics, "inputBytes" | "outputBytes" | "workerDecodeMs" | "workerEncodeMs">;
  }
  | { type: "upload-complete"; id: number; payload: string; summary: CloudUploadSummary; offlineSeconds: number; returningReward: Array<{ itemId: string; amount: number }> }
  | { type: "cancelled"; id: number }
  | { type: "error"; id: number; message: string };

export interface OfflineSimulationProgress {
  completedSeconds: number;
  totalSeconds: number;
  progress: number;
  phase?: OfflineSettlementPhase;
  approximateSeconds?: number;
  estimatedError?: number;
}

export interface OfflineSimulationSettlementResult {
  state: GameState;
  diagnostics: OfflineSettlementDiagnostics;
}

export interface CloudUploadSummary {
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

export interface OfflineSettlementWorkerOptions {
  signal?: AbortSignal;
  onProgress?: (progress: OfflineSimulationProgress) => void;
  registry?: ContentPackRuntimeSnapshot;
  approximate?: boolean;
}

export function runOfflineSettlementInWorker(
  state: GameState,
  seconds: number,
  options: OfflineSettlementWorkerOptions = {},
): Promise<OfflineSimulationSettlementResult> {
  if (typeof Worker === "undefined") return Promise.reject(new Error("当前浏览器不支持离线计算 Worker"));
  const worker = new Worker(new URL("./offlineSimulation.worker.ts", import.meta.url), { type: "module", name: "offline-simulation" });
  const id = Date.now() + Math.floor(Math.random() * 1_000_000);
  const startedAt = performance.now();
  const encodeStartedAt = performance.now();
  let statePayload: OfflineSimulationStatePayload;
  try {
    statePayload = serializeOfflineSimulationState(state);
  } catch (error) {
    worker.terminate();
    return Promise.reject(error instanceof Error ? error : new Error("离线状态无法安全交给 Worker"));
  }
  const mainThreadEncodeMs = Math.max(0, performance.now() - encodeStartedAt);
  return new Promise<OfflineSimulationSettlementResult>((resolve, reject) => {
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
      finish(() => reject(new DOMException("离线计算已取消", "AbortError")));
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
      if (message.type === "complete") {
        const decodeStartedAt = performance.now();
        let completedState: GameState;
        try {
          completedState = deserializeOfflineSimulationState(message.statePayload);
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error("离线 Worker 返回状态解析失败")));
          return;
        }
        const mainThreadDecodeMs = Math.max(0, performance.now() - decodeStartedAt);
        try { window.sessionStorage.setItem(OFFLINE_PERFORMANCE_SESSION_KEY, String(Math.max(0, performance.now() - startedAt))); } catch { /* optional diagnostics */ }
        const calculationMs = Math.max(0, performance.now() - startedAt);
        const workerCalculationMs = message.diagnostics?.calculationMs ?? 0;
        const transport: OfflineSettlementTransportDiagnostics = {
          ...message.transport,
          mainThreadEncodeMs,
          workerCalculationMs,
          mainThreadDecodeMs,
        };
        finish(() => resolve({
          state: completedState,
          diagnostics: message.diagnostics ? {
            ...message.diagnostics,
            calculationMs,
            softTimeoutExceeded: message.diagnostics.softTimeoutExceeded || calculationMs > 30_000,
            transport,
          } : {
            mode: "exact",
            calibrationWindowSeconds: 0,
            approximateSeconds: 0,
            attemptedApproximateSeconds: 0,
            exactSeconds: seconds,
            maximumEstimatedError: 0,
            fellBack: false,
            calculationMs,
            incomplete: false,
            conservationVerified: true,
            softTimeoutExceeded: calculationMs > 30_000,
            workerMessageCount: 0,
            transport,
          },
        }));
        return;
      }
      if (message.type === "cancelled") {
        finish(() => reject(new DOMException("离线计算已取消", "AbortError")));
        return;
      }
      if (message.type === "error") finish(() => reject(new Error(message.message)));
    };
    worker.onerror = () => finish(() => reject(new Error("离线计算 Worker 运行失败，未保存任何半成品")));
    const registry = options.registry ?? createContentPackRuntimeSnapshot(loadContentPackRegistry());
    try {
      worker.postMessage({ type: "start", id, statePayload, seconds, approximate: options.approximate === true, registry } satisfies OfflineSimulationWorkerRequest, [statePayload.bytes]);
    } catch {
      finish(() => reject(new Error("离线状态无法转移到 Worker，原存档未修改")));
    }
  });
}

export function runOfflineSimulationInWorker(
  state: GameState,
  seconds: number,
  options: Omit<OfflineSettlementWorkerOptions, "approximate"> = {},
): Promise<GameState> {
  return runOfflineSettlementInWorker(state, seconds, options).then((result) => result.state);
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
): Promise<{ payload: string; summary: CloudUploadSummary; offlineSeconds: number; returningReward: Array<{ itemId: string; amount: number }> }> {
  if (typeof Worker === "undefined") return Promise.reject(new Error("当前浏览器不支持云存档后台 Worker"));
  const worker = new Worker(new URL("./offlineSimulation.worker.ts", import.meta.url), { type: "module", name: "cloud-upload-preparation" });
  const id = Date.now() + Math.floor(Math.random() * 1_000_000);
  const registry = options.registry ?? createContentPackRuntimeSnapshot(loadContentPackRegistry());
  const now = options.now ?? Date.now();
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
        finish(() => resolve({ payload: message.payload, summary: message.summary, offlineSeconds: message.offlineSeconds, returningReward: message.returningReward }));
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
      worker.postMessage({
        type: "prepare-upload",
        id,
        raw,
        now,
        menuSettings: options.menuSettings,
        returningRewardClaimed: options.returningRewardClaimed ?? false,
        skipOffline: options.skipOffline === true,
        registry,
      } satisfies OfflineSimulationWorkerRequest);
    } catch {
      finish(() => reject(new Error("云存档无法交给后台 Worker 处理，未修改本地存档")));
    }
  });
}
