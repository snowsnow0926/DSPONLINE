import {
  getDesktopBridge,
  type DesktopNativeCoreCompareResult,
  type DesktopNativeCoreCommitOperationResult,
  type DesktopNativeCoreCheckpointResult,
  type DesktopNativeCoreOpenResult,
  type DesktopNativeCoreSummary,
  type DesktopNativeCoreProjectionResult,
  type DesktopNativeSaveCommitResult,
} from "../desktop";
import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import type { SimulationCommandPatch } from "./simulationRuntimeProtocol";
import type { SaveMode } from "./types";

export interface WindowsNativeCoreShadow {
  readonly sessionId: string;
  readonly checkpoint: DesktopNativeSaveCommitResult;
  status(): Promise<DesktopNativeCoreSummary>;
  projection(request: { baseFields?: string[]; entityIds?: string[]; beltIds?: string[] }): Promise<DesktopNativeCoreProjectionResult>;
  applyCommand(command: SimulationCommandPatch): Promise<{ revision: number; topologyDirty: boolean }>;
  advance(request: { baseRevision: number; simulationSeconds: number; wallSeconds: number }): Promise<{ supported: boolean; revision: number; reason?: string }>;
  advanceSegmented(request: NativeCoreSegmentedAdvanceRequest): Promise<NativeCoreSegmentedAdvanceResult>;
  commitOperation(request: {
    commandId: string;
    baseRevision: number;
    command?: SimulationCommandPatch | null;
    simulationSeconds: number;
    wallSeconds: number;
    includeDiagnostics?: boolean;
  }): Promise<DesktopNativeCoreCommitOperationResult>;
  createCheckpoint(savedAtMs?: number): Promise<DesktopNativeCoreCheckpointResult>;
  compare(expected: { revision: number; canonicalSha256: string; domainSha256: string }): Promise<DesktopNativeCoreCompareResult>;
  close(): Promise<void>;
}

export interface NativeCoreAdvanceSegment {
  simulationSeconds: number;
  wallSeconds: number;
}

export interface NativeCoreSegmentedAdvanceRequest {
  baseRevision: number;
  simulationSeconds: number;
  wallSeconds: number;
  maxSegmentSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (progress: {
    revision: number;
    advancedSimulationSeconds: number;
    advancedWallSeconds: number;
    totalSimulationSeconds: number;
    totalWallSeconds: number;
  }) => void;
}

export interface NativeCoreSegmentedAdvanceResult {
  supported: boolean;
  revision: number;
  cancelled: boolean;
  advancedSimulationSeconds: number;
  advancedWallSeconds: number;
  reason?: string;
}

export function partitionNativeAdvanceBudget(
  simulationSeconds: number,
  wallSeconds: number,
  maxSegmentSeconds = 600,
): NativeCoreAdvanceSegment[] {
  if (!Number.isFinite(simulationSeconds) || simulationSeconds < 0 ||
    !Number.isFinite(wallSeconds) || wallSeconds < 0 ||
    !Number.isFinite(maxSegmentSeconds) || maxSegmentSeconds <= 0) {
    throw new RangeError("原生模拟分段预算无效");
  }
  const simulation = Math.min(simulationSeconds, 30 * 24 * 60 * 60);
  const wall = Math.min(wallSeconds, 30 * 24 * 60 * 60);
  const maximum = Math.max(1, Math.min(3_600, maxSegmentSeconds));
  if (simulation <= 0 && wall <= 0) return [];
  const segments: NativeCoreAdvanceSegment[] = [];
  let remainingSimulation = simulation;
  let remainingWall = wall;
  if (simulation > 0) {
    while (remainingSimulation > 0) {
      const segmentSimulation = Math.min(maximum, remainingSimulation);
      const segmentWall = segmentSimulation === remainingSimulation
        ? remainingWall
        : Math.min(remainingWall, wall * segmentSimulation / simulation);
      segments.push({ simulationSeconds: segmentSimulation, wallSeconds: segmentWall });
      remainingSimulation = Math.max(0, remainingSimulation - segmentSimulation);
      remainingWall = Math.max(0, remainingWall - segmentWall);
    }
  } else {
    while (remainingWall > 0) {
      const segmentWall = Math.min(maximum, remainingWall);
      segments.push({ simulationSeconds: 0, wallSeconds: segmentWall });
      remainingWall = Math.max(0, remainingWall - segmentWall);
    }
  }
  return segments;
}

class DesktopNativeCoreShadow implements WindowsNativeCoreShadow {
  private closed = false;

  constructor(
    readonly sessionId: string,
    readonly checkpoint: DesktopNativeSaveCommitResult,
  ) {}

  async status(): Promise<DesktopNativeCoreSummary> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    return desktop.getNativeCoreStatus({ sessionId: this.sessionId });
  }

  async projection(request: { baseFields?: string[]; entityIds?: string[]; beltIds?: string[] }): Promise<DesktopNativeCoreProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    return desktop.getNativeCoreProjection({
      sessionId: this.sessionId,
      baseFields: request.baseFields ?? [],
      entityIds: request.entityIds ?? [],
      beltIds: request.beltIds ?? [],
    });
  }

  async applyCommand(command: SimulationCommandPatch): Promise<{ revision: number; topologyDirty: boolean }> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    const result = await desktop.applyNativeCoreCommand({
      sessionId: this.sessionId,
      command: command as unknown as Record<string, unknown>,
    });
    return { revision: result.revision, topologyDirty: result.topologyDirty };
  }

  async advance(request: { baseRevision: number; simulationSeconds: number; wallSeconds: number }): Promise<{ supported: boolean; revision: number; reason?: string }> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    const result = await desktop.advanceNativeCore({
      sessionId: this.sessionId,
      ...request,
      includeDiagnostics: false,
    });
    return { supported: result.supported, revision: result.revision, ...(result.reason ? { reason: result.reason } : {}) };
  }

  async advanceSegmented(request: NativeCoreSegmentedAdvanceRequest): Promise<NativeCoreSegmentedAdvanceResult> {
    let revision = request.baseRevision;
    let advancedSimulationSeconds = 0;
    let advancedWallSeconds = 0;
    const segments = partitionNativeAdvanceBudget(
      request.simulationSeconds,
      request.wallSeconds,
      request.maxSegmentSeconds,
    );
    for (const segment of segments) {
      if (request.signal?.aborted) {
        return { supported: true, revision, cancelled: true, advancedSimulationSeconds, advancedWallSeconds };
      }
      const result = await this.advance({ baseRevision: revision, ...segment });
      if (!result.supported) {
        return {
          supported: false,
          revision,
          cancelled: false,
          advancedSimulationSeconds,
          advancedWallSeconds,
          ...(result.reason ? { reason: result.reason } : {}),
        };
      }
      revision = result.revision;
      advancedSimulationSeconds += segment.simulationSeconds;
      advancedWallSeconds += segment.wallSeconds;
      request.onProgress?.({
        revision,
        advancedSimulationSeconds,
        advancedWallSeconds,
        totalSimulationSeconds: Math.min(request.simulationSeconds, 30 * 24 * 60 * 60),
        totalWallSeconds: Math.min(request.wallSeconds, 30 * 24 * 60 * 60),
      });
    }
    return { supported: true, revision, cancelled: false, advancedSimulationSeconds, advancedWallSeconds };
  }

  async commitOperation(request: {
    commandId: string;
    baseRevision: number;
    command?: SimulationCommandPatch | null;
    simulationSeconds: number;
    wallSeconds: number;
    includeDiagnostics?: boolean;
  }): Promise<DesktopNativeCoreCommitOperationResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    return desktop.commitNativeCoreOperation({
      sessionId: this.sessionId,
      ...request,
      command: request.command as unknown as Record<string, unknown> | null | undefined,
    });
  }

  async createCheckpoint(savedAtMs = Date.now()): Promise<DesktopNativeCoreCheckpointResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    const result = await desktop.checkpointNativeCore({ sessionId: this.sessionId, savedAtMs });
    if (result.checkpoint.slot !== this.checkpoint.slot ||
      result.checkpoint.revision !== result.summary.revision ||
      result.checkpoint.generation <= this.checkpoint.generation) {
      throw new Error("Windows 原生核心检查点回执与权威 revision 不一致");
    }
    return result;
  }

  compare(expected: { revision: number; canonicalSha256: string; domainSha256: string }): Promise<DesktopNativeCoreCompareResult> {
    if (this.closed) return Promise.reject(new Error("Windows 原生核心影子会话已关闭"));
    const desktop = getDesktopBridge();
    if (!desktop) return Promise.reject(new Error("Windows 原生核心桥接已断开"));
    return desktop.compareNativeCore({ sessionId: this.sessionId, ...expected });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const desktop = getDesktopBridge();
    if (!desktop) return;
    await desktop.closeNativeCore({ sessionId: this.sessionId });
  }
}

export async function openWindowsNativeCoreShadow(
  mode: SaveMode,
  checkpoint: DesktopNativeSaveCommitResult,
  runtime: ContentPackRuntimeSnapshot,
): Promise<WindowsNativeCoreShadow | null> {
  const desktop = getDesktopBridge();
  if (!desktop) return null;
  const status = await desktop.getNativePerformanceStatus();
  if (!status.available || !status.capabilities.includes("native-core-shadow-v1")) return null;
  const opened: DesktopNativeCoreOpenResult = await desktop.openNativeCore({
    slot: mode === "speedrun" ? "speedrun-main" : "normal-main",
    generation: checkpoint.generation,
    rootHash: checkpoint.rootHash,
    revision: checkpoint.revision,
    registryFingerprint: runtime.fingerprint,
    catalog: createNativeCoreCatalog(runtime),
  });
  if (opened.authority !== "shadow" || opened.checkpointRevision !== checkpoint.revision ||
    opened.replayedRevision !== opened.summary.revision || opened.replayedWalEntries < 0 ||
    opened.summary.registryFingerprint !== runtime.fingerprint || opened.summary.coverage.authorityEligible) {
    await desktop.closeNativeCore({ sessionId: opened.sessionId }).catch(() => undefined);
    throw new Error("Windows 原生核心影子检查点身份无效");
  }
  return new DesktopNativeCoreShadow(opened.sessionId, checkpoint);
}
