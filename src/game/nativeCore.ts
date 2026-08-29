import {
  getDesktopBridge,
  type DesktopNativeCoreCompareResult,
  type DesktopNativeCoreCommitOperationResult,
  type DesktopNativeCoreCheckpointResult,
  type DesktopNativeCoreExportResult,
  type DesktopNativeCoreOpenResult,
  type DesktopNativeCoreSummary,
  type DesktopNativeCoreProjectionResult,
  type DesktopNativeCoreProjectionTransferResult,
  type DesktopNativeCoreViewportProjectionRequest,
  type DesktopNativeCoreViewportProjectionResult,
  type DesktopNativeCoreViewportProjectionV2Request,
  type DesktopNativeCoreViewportProjectionV2Result,
  type DesktopNativeCoreFactoryReadModelRequest,
  type DesktopNativeCoreFactoryReadModelResult,
  type DesktopNativeCoreFactoryInventoryRequest,
  type DesktopNativeCoreFactoryInventoryResult,
  type DesktopNativeCoreConstructionInventoryRequest,
  type DesktopNativeCoreConstructionInventoryResult,
  type DesktopNativeCoreConstructionPlacementContextRequest,
  type DesktopNativeCoreConstructionPlacementContextResult,
  type DesktopNativeCoreConstructionBeltPlacementContextRequest,
  type DesktopNativeCoreConstructionBeltPlacementContextResult,
  type DesktopNativeCoreConstructionBeltRemovalContextRequest,
  type DesktopNativeCoreConstructionBeltRemovalContextResult,
  type DesktopNativeCoreConstructionRemovalContextRequest,
  type DesktopNativeCoreConstructionRemovalContextResult,
  type DesktopNativeCoreConstructionStackContextRequest,
  type DesktopNativeCoreConstructionStackContextResult,
  type DesktopNativeCoreStatisticsProjectionRequest,
  type DesktopNativeCoreStatisticsProjectionResult,
  type DesktopNativeCoreTechnologyProjectionRequest,
  type DesktopNativeCoreTechnologyProjectionResult,
  type DesktopNativeCoreRecipeWorkspaceProjectionRequest,
  type DesktopNativeCoreRecipeWorkspaceProjectionResult,
  type DesktopNativeCoreStarMapOverviewProjectionRequest,
  type DesktopNativeCoreStarMapOverviewProjectionResult,
  type DesktopNativeCoreStarMapCatalogProjectionRequest,
  type DesktopNativeCoreStarMapCatalogProjectionResult,
  type DesktopNativeCoreStellarIndustryProjectionRequest,
  type DesktopNativeCoreStellarIndustryProjectionResult,
  type DesktopNativeCoreStellarIndustryV2ProjectionRequest,
  type DesktopNativeCoreStellarIndustryV2ProjectionResult,
  type DesktopNativeCoreStellarQuantumProjectionRequest,
  type DesktopNativeCoreStellarQuantumProjectionResult,
  type DesktopNativeCoreDysonWorkspaceProjectionRequest,
  type DesktopNativeCoreDysonWorkspaceProjectionResult,
  type DesktopNativeSaveCommitResult,
} from "../desktop";
import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import { createNativeCoreCatalog } from "./nativeCoreCatalog";
import type { SimulationCommandPatch } from "./simulationRuntimeProtocol";
import type { SaveMode } from "./types";

const MAX_NATIVE_PROJECTION_TRANSFER_BYTES = 1024 * 1024;

export type NativeCoreAdvanceMode = "exact" | "pure-idle-conservative-v2" | "pure-idle-macro-v10";

type NativeCoreTransferProjection =
  | DesktopNativeCoreViewportProjectionResult
  | DesktopNativeCoreViewportProjectionV2Result
  | DesktopNativeCoreFactoryReadModelResult
  | DesktopNativeCoreFactoryInventoryResult
  | DesktopNativeCoreConstructionInventoryResult
  | DesktopNativeCoreConstructionPlacementContextResult
  | DesktopNativeCoreConstructionBeltPlacementContextResult
  | DesktopNativeCoreConstructionBeltRemovalContextResult
  | DesktopNativeCoreConstructionRemovalContextResult
  | DesktopNativeCoreConstructionStackContextResult
  | DesktopNativeCoreStatisticsProjectionResult
  | DesktopNativeCoreTechnologyProjectionResult
  | DesktopNativeCoreRecipeWorkspaceProjectionResult
  | DesktopNativeCoreStarMapOverviewProjectionResult
  | DesktopNativeCoreStarMapCatalogProjectionResult
  | DesktopNativeCoreStellarIndustryProjectionResult
  | DesktopNativeCoreStellarIndustryV2ProjectionResult
  | DesktopNativeCoreStellarQuantumProjectionResult
  | DesktopNativeCoreDysonWorkspaceProjectionResult;

function projectionBodySchemaVersion(projectionType: NativeCoreTransferProjection["projectionType"]): 1 | 2 {
  return projectionType === "viewport-v2" || projectionType === "stellar-industry-v2" ? 2 : 1;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export async function decodeNativeCoreProjectionTransfer<T extends NativeCoreTransferProjection>(
  transfer: DesktopNativeCoreProjectionTransferResult,
  expected: { sessionId: string; projectionType: T["projectionType"] },
): Promise<T> {
  const { header, bodyBuffer } = transfer;
  if (!header || header.schemaVersion !== 1 || header.sessionId !== expected.sessionId ||
    header.projectionType !== expected.projectionType || !Number.isSafeInteger(header.sequence) || header.sequence < 1 ||
    !Number.isSafeInteger(header.revision) || header.revision < 0 ||
    !Number.isSafeInteger(header.payloadLength) || header.payloadLength < 1 ||
    header.payloadLength > MAX_NATIVE_PROJECTION_TRANSFER_BYTES ||
    typeof header.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(header.sha256) ||
    !(bodyBuffer instanceof ArrayBuffer) || bodyBuffer.byteLength !== header.payloadLength) {
    throw new Error("原生投影二进制响应边界无效");
  }
  const digest = bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bodyBuffer)));
  if (digest !== header.sha256) throw new Error("原生投影二进制响应校验失败");
  const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBuffer)) as Partial<T>;
  if (!decoded || decoded.schemaVersion !== projectionBodySchemaVersion(expected.projectionType) ||
    decoded.projectionType !== expected.projectionType ||
    decoded.revision !== header.revision) {
    throw new Error("原生投影二进制正文身份无效");
  }
  return decoded as T;
}

export interface WindowsNativeCoreShadow {
  readonly sessionId: string;
  readonly checkpoint: Pick<DesktopNativeSaveCommitResult, "slot" | "generation" | "rootHash" | "revision">;
  status(): Promise<DesktopNativeCoreSummary>;
  projection(request: { baseFields?: string[]; entityIds?: string[]; beltIds?: string[] }): Promise<DesktopNativeCoreProjectionResult>;
  viewportProjection(request: Omit<DesktopNativeCoreViewportProjectionRequest, "sessionId">): Promise<DesktopNativeCoreViewportProjectionResult>;
  viewportProjectionV2(request: Omit<DesktopNativeCoreViewportProjectionV2Request, "sessionId">): Promise<DesktopNativeCoreViewportProjectionV2Result>;
  factoryReadModel(request: Omit<DesktopNativeCoreFactoryReadModelRequest, "sessionId">): Promise<DesktopNativeCoreFactoryReadModelResult>;
  factoryInventoryProjection?(request: Omit<DesktopNativeCoreFactoryInventoryRequest, "sessionId">): Promise<DesktopNativeCoreFactoryInventoryResult>;
  constructionInventoryProjection?(request: Omit<DesktopNativeCoreConstructionInventoryRequest, "sessionId">): Promise<DesktopNativeCoreConstructionInventoryResult>;
  constructionPlacementContext?(request: Omit<DesktopNativeCoreConstructionPlacementContextRequest, "sessionId">): Promise<DesktopNativeCoreConstructionPlacementContextResult>;
  constructionBeltPlacementContext?(request: Omit<DesktopNativeCoreConstructionBeltPlacementContextRequest, "sessionId">): Promise<DesktopNativeCoreConstructionBeltPlacementContextResult>;
  constructionBeltRemovalContext?(request: Omit<DesktopNativeCoreConstructionBeltRemovalContextRequest, "sessionId">): Promise<DesktopNativeCoreConstructionBeltRemovalContextResult>;
  constructionRemovalContext?(request: Omit<DesktopNativeCoreConstructionRemovalContextRequest, "sessionId">): Promise<DesktopNativeCoreConstructionRemovalContextResult>;
  constructionStackContext?(request: Omit<DesktopNativeCoreConstructionStackContextRequest, "sessionId">): Promise<DesktopNativeCoreConstructionStackContextResult>;
  statisticsProjection(request: Omit<DesktopNativeCoreStatisticsProjectionRequest, "sessionId">): Promise<DesktopNativeCoreStatisticsProjectionResult>;
  technologyProjection(request: Omit<DesktopNativeCoreTechnologyProjectionRequest, "sessionId">): Promise<DesktopNativeCoreTechnologyProjectionResult>;
  recipeWorkspaceProjection(request: Omit<DesktopNativeCoreRecipeWorkspaceProjectionRequest, "sessionId">): Promise<DesktopNativeCoreRecipeWorkspaceProjectionResult>;
  starMapOverviewProjection(request: Omit<DesktopNativeCoreStarMapOverviewProjectionRequest, "sessionId">): Promise<DesktopNativeCoreStarMapOverviewProjectionResult>;
  starMapCatalogProjection?(request: Omit<DesktopNativeCoreStarMapCatalogProjectionRequest, "sessionId">): Promise<DesktopNativeCoreStarMapCatalogProjectionResult>;
  stellarIndustryProjection(request: Omit<DesktopNativeCoreStellarIndustryProjectionRequest, "sessionId">): Promise<DesktopNativeCoreStellarIndustryProjectionResult>;
  stellarIndustryV2Projection(request: Omit<DesktopNativeCoreStellarIndustryV2ProjectionRequest, "sessionId">): Promise<DesktopNativeCoreStellarIndustryV2ProjectionResult>;
  stellarQuantumProjection?(request: Omit<DesktopNativeCoreStellarQuantumProjectionRequest, "sessionId">): Promise<DesktopNativeCoreStellarQuantumProjectionResult>;
  dysonWorkspaceProjection?(request: Omit<DesktopNativeCoreDysonWorkspaceProjectionRequest, "sessionId">): Promise<DesktopNativeCoreDysonWorkspaceProjectionResult>;
  applyCommand(command: SimulationCommandPatch): Promise<{ revision: number; topologyDirty: boolean }>;
  advance(request: {
    baseRevision: number;
    simulationSeconds: number;
    wallSeconds: number;
    advanceMode?: NativeCoreAdvanceMode;
  }): Promise<{ supported: boolean; revision: number; reason?: string }>;
  advanceSegmented(request: NativeCoreSegmentedAdvanceRequest): Promise<NativeCoreSegmentedAdvanceResult>;
  commitOperation(request: {
    commandId: string;
    baseRevision: number;
    command?: SimulationCommandPatch | null;
    simulationSeconds: number;
    wallSeconds: number;
    advanceMode?: NativeCoreAdvanceMode;
    includeDiagnostics?: boolean;
  }): Promise<DesktopNativeCoreCommitOperationResult>;
  createCheckpoint(savedAtMs?: number): Promise<DesktopNativeCoreCheckpointResult>;
  exportV47(exportId: string, suggestedName?: string, savedAtMs?: number): Promise<DesktopNativeCoreExportResult>;
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
  advanceMode?: NativeCoreAdvanceMode;
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

export type NativeCoreAdvanceSegmentExecutor = (request: {
  baseRevision: number;
  simulationSeconds: number;
  wallSeconds: number;
  advanceMode?: NativeCoreAdvanceMode;
}) => Promise<{ supported: boolean; revision: number; reason?: string }>;

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

/**
 * Execute a long native budget as individually acknowledged revisions. The
 * caller can stop only between committed segments: cancellation never claims
 * that an in-flight native operation was rolled back, and the returned totals
 * describe the exact durable prefix that can be checkpointed or discarded.
 */
export async function advanceNativeCoreSegmented(
  advance: NativeCoreAdvanceSegmentExecutor,
  request: NativeCoreSegmentedAdvanceRequest,
): Promise<NativeCoreSegmentedAdvanceResult> {
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
    const result = await advance(request.advanceMode === undefined
      ? { baseRevision: revision, ...segment }
      : { baseRevision: revision, ...segment, advanceMode: request.advanceMode });
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
    if (!Number.isSafeInteger(result.revision) || result.revision <= revision) {
      throw new Error("原生分段推进返回了不连续 revision");
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

class DesktopNativeCoreShadow implements WindowsNativeCoreShadow {
  private closed = false;

  constructor(
    readonly sessionId: string,
    readonly checkpoint: Pick<DesktopNativeSaveCommitResult, "slot" | "generation" | "rootHash" | "revision">,
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

  async viewportProjection(
    request: Omit<DesktopNativeCoreViewportProjectionRequest, "sessionId">,
  ): Promise<DesktopNativeCoreViewportProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "viewport-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreViewportProjectionResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "viewport-v1",
      });
    }
    return desktop.getNativeCoreViewportProjection({ sessionId: this.sessionId, ...request });
  }

  async viewportProjectionV2(
    request: Omit<DesktopNativeCoreViewportProjectionV2Request, "sessionId">,
  ): Promise<DesktopNativeCoreViewportProjectionV2Result> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "viewport-v2",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreViewportProjectionV2Result>(transfer, {
        sessionId: this.sessionId,
        projectionType: "viewport-v2",
      });
    }
    return desktop.getNativeCoreViewportProjectionV2({ sessionId: this.sessionId, ...request });
  }

  async factoryReadModel(
    request: Omit<DesktopNativeCoreFactoryReadModelRequest, "sessionId">,
  ): Promise<DesktopNativeCoreFactoryReadModelResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "factory-read-model-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreFactoryReadModelResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "factory-read-model-v1",
      });
    }
    return desktop.getNativeCoreFactoryReadModel({ sessionId: this.sessionId, ...request });
  }

  async factoryInventoryProjection(
    request: Omit<DesktopNativeCoreFactoryInventoryRequest, "sessionId">,
  ): Promise<DesktopNativeCoreFactoryInventoryResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "factory-inventory-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreFactoryInventoryResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "factory-inventory-v1",
      });
    }
    if (typeof desktop.getNativeCoreFactoryInventory !== "function") {
      throw new Error("Windows 原生工厂库存投影不可用");
    }
    return desktop.getNativeCoreFactoryInventory({ sessionId: this.sessionId, ...request });
  }

  async constructionInventoryProjection(
    request: Omit<DesktopNativeCoreConstructionInventoryRequest, "sessionId">,
  ): Promise<DesktopNativeCoreConstructionInventoryResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "construction-inventory-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreConstructionInventoryResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "construction-inventory-v1",
      });
    }
    if (typeof desktop.getNativeCoreConstructionInventory !== "function") {
      throw new Error("Windows 原生建筑库存投影不可用");
    }
    return desktop.getNativeCoreConstructionInventory({ sessionId: this.sessionId, ...request });
  }

  async constructionPlacementContext(
    request: Omit<DesktopNativeCoreConstructionPlacementContextRequest, "sessionId">,
  ): Promise<DesktopNativeCoreConstructionPlacementContextResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "construction-placement-context-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreConstructionPlacementContextResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "construction-placement-context-v1",
      });
    }
    if (typeof desktop.getNativeCoreConstructionPlacementContext !== "function") {
      throw new Error("Windows 原生建筑放置上下文不可用");
    }
    return desktop.getNativeCoreConstructionPlacementContext({ sessionId: this.sessionId, ...request });
  }

  async constructionBeltPlacementContext(
    request: Omit<DesktopNativeCoreConstructionBeltPlacementContextRequest, "sessionId">,
  ): Promise<DesktopNativeCoreConstructionBeltPlacementContextResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "construction-belt-placement-context-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreConstructionBeltPlacementContextResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "construction-belt-placement-context-v1",
      });
    }
    if (typeof desktop.getNativeCoreConstructionBeltPlacementContext !== "function") {
      throw new Error("Windows 原生传送带放置上下文不可用");
    }
    return desktop.getNativeCoreConstructionBeltPlacementContext({ sessionId: this.sessionId, ...request });
  }

  async constructionBeltRemovalContext(
    request: Omit<DesktopNativeCoreConstructionBeltRemovalContextRequest, "sessionId">,
  ): Promise<DesktopNativeCoreConstructionBeltRemovalContextResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "construction-belt-removal-context-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreConstructionBeltRemovalContextResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "construction-belt-removal-context-v1",
      });
    }
    if (typeof desktop.getNativeCoreConstructionBeltRemovalContext !== "function") {
      throw new Error("Windows 原生传送带回收上下文不可用");
    }
    return desktop.getNativeCoreConstructionBeltRemovalContext({ sessionId: this.sessionId, ...request });
  }

  async constructionRemovalContext(
    request: Omit<DesktopNativeCoreConstructionRemovalContextRequest, "sessionId">,
  ): Promise<DesktopNativeCoreConstructionRemovalContextResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "construction-removal-context-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreConstructionRemovalContextResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "construction-removal-context-v1",
      });
    }
    if (typeof desktop.getNativeCoreConstructionRemovalContext !== "function") {
      throw new Error("Windows 原生建筑回收上下文不可用");
    }
    return desktop.getNativeCoreConstructionRemovalContext({ sessionId: this.sessionId, ...request });
  }

  async constructionStackContext(
    request: Omit<DesktopNativeCoreConstructionStackContextRequest, "sessionId">,
  ): Promise<DesktopNativeCoreConstructionStackContextResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "construction-stack-context-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreConstructionStackContextResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "construction-stack-context-v1",
      });
    }
    if (typeof desktop.getNativeCoreConstructionStackContext !== "function") {
      throw new Error("Windows 原生建筑堆叠上下文不可用");
    }
    return desktop.getNativeCoreConstructionStackContext({ sessionId: this.sessionId, ...request });
  }

  async statisticsProjection(
    request: Omit<DesktopNativeCoreStatisticsProjectionRequest, "sessionId">,
  ): Promise<DesktopNativeCoreStatisticsProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "statistics-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreStatisticsProjectionResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "statistics-v1",
      });
    }
    return desktop.getNativeCoreStatisticsProjection({ sessionId: this.sessionId, ...request });
  }

  async technologyProjection(
    request: Omit<DesktopNativeCoreTechnologyProjectionRequest, "sessionId">,
  ): Promise<DesktopNativeCoreTechnologyProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "technology-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreTechnologyProjectionResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "technology-v1",
      });
    }
    return desktop.getNativeCoreTechnologyProjection({ sessionId: this.sessionId, ...request });
  }

  async recipeWorkspaceProjection(
    request: Omit<DesktopNativeCoreRecipeWorkspaceProjectionRequest, "sessionId">,
  ): Promise<DesktopNativeCoreRecipeWorkspaceProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "recipe-workspace-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreRecipeWorkspaceProjectionResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "recipe-workspace-v1",
      });
    }
    if (typeof desktop.getNativeCoreRecipeWorkspaceProjection !== "function") {
      throw new Error("Windows 原生生产资料库投影不可用");
    }
    return desktop.getNativeCoreRecipeWorkspaceProjection({ sessionId: this.sessionId, ...request });
  }

  async starMapOverviewProjection(
    request: Omit<DesktopNativeCoreStarMapOverviewProjectionRequest, "sessionId">,
  ): Promise<DesktopNativeCoreStarMapOverviewProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "star-map-overview-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreStarMapOverviewProjectionResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "star-map-overview-v1",
      });
    }
    if (typeof desktop.getNativeCoreStarMapOverviewProjection !== "function") {
      throw new Error("Windows 原生星图总览投影不可用");
    }
    return desktop.getNativeCoreStarMapOverviewProjection({ sessionId: this.sessionId, ...request });
  }

  async starMapCatalogProjection(
    request: Omit<DesktopNativeCoreStarMapCatalogProjectionRequest, "sessionId">,
  ): Promise<DesktopNativeCoreStarMapCatalogProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "star-map-catalog-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreStarMapCatalogProjectionResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "star-map-catalog-v1",
      });
    }
    if (typeof desktop.getNativeCoreStarMapCatalogProjection !== "function") {
      throw new Error("Windows 原生星图目录投影不可用");
    }
    return desktop.getNativeCoreStarMapCatalogProjection({ sessionId: this.sessionId, ...request });
  }

  async stellarIndustryProjection(
    request: Omit<DesktopNativeCoreStellarIndustryProjectionRequest, "sessionId">,
  ): Promise<DesktopNativeCoreStellarIndustryProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "stellar-industry-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreStellarIndustryProjectionResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "stellar-industry-v1",
      });
    }
    if (typeof desktop.getNativeCoreStellarIndustryProjection !== "function") {
      throw new Error("Windows 原生恒星工业投影不可用");
    }
    return desktop.getNativeCoreStellarIndustryProjection({ sessionId: this.sessionId, ...request });
  }

  async stellarIndustryV2Projection(
    request: Omit<DesktopNativeCoreStellarIndustryV2ProjectionRequest, "sessionId">,
  ): Promise<DesktopNativeCoreStellarIndustryV2ProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "stellar-industry-v2",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreStellarIndustryV2ProjectionResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "stellar-industry-v2",
      });
    }
    if (typeof desktop.getNativeCoreStellarIndustryV2Projection !== "function") {
      throw new Error("Windows 原生恒星工业 v2 投影不可用");
    }
    return desktop.getNativeCoreStellarIndustryV2Projection({ sessionId: this.sessionId, ...request });
  }

  async stellarQuantumProjection(
    request: Omit<DesktopNativeCoreStellarQuantumProjectionRequest, "sessionId">,
  ): Promise<DesktopNativeCoreStellarQuantumProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "stellar-quantum-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreStellarQuantumProjectionResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "stellar-quantum-v1",
      });
    }
    if (typeof desktop.getNativeCoreStellarQuantumProjection !== "function") {
      throw new Error("Windows 原生量子库存投影不可用");
    }
    return desktop.getNativeCoreStellarQuantumProjection({ sessionId: this.sessionId, ...request });
  }

  async dysonWorkspaceProjection(
    request: Omit<DesktopNativeCoreDysonWorkspaceProjectionRequest, "sessionId">,
  ): Promise<DesktopNativeCoreDysonWorkspaceProjectionResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    if (desktop.requestNativeCoreProjectionTransfer) {
      const transfer = await desktop.requestNativeCoreProjectionTransfer({
        sessionId: this.sessionId,
        projectionType: "dyson-workspace-v1",
        payload: request,
      });
      return decodeNativeCoreProjectionTransfer<DesktopNativeCoreDysonWorkspaceProjectionResult>(transfer, {
        sessionId: this.sessionId,
        projectionType: "dyson-workspace-v1",
      });
    }
    if (typeof desktop.getNativeCoreDysonWorkspaceProjection !== "function") {
      throw new Error("Windows 原生戴森球工作区投影不可用");
    }
    return desktop.getNativeCoreDysonWorkspaceProjection({ sessionId: this.sessionId, ...request });
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

  async advance(request: {
    baseRevision: number;
    simulationSeconds: number;
    wallSeconds: number;
    advanceMode?: NativeCoreAdvanceMode;
  }): Promise<{ supported: boolean; revision: number; reason?: string }> {
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
    return advanceNativeCoreSegmented((segment) => this.advance(segment), request);
  }

  async commitOperation(request: {
    commandId: string;
    baseRevision: number;
    command?: SimulationCommandPatch | null;
    simulationSeconds: number;
    wallSeconds: number;
    advanceMode?: NativeCoreAdvanceMode;
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

  async exportV47(
    exportId: string,
    suggestedName?: string,
    savedAtMs = Date.now(),
  ): Promise<DesktopNativeCoreExportResult> {
    if (this.closed) throw new Error("Windows 原生核心影子会话已关闭");
    const desktop = getDesktopBridge();
    if (!desktop) throw new Error("Windows 原生核心桥接已断开");
    const result = await desktop.exportNativeCoreV47({
      sessionId: this.sessionId,
      exportId,
      savedAtMs,
      ...(suggestedName ? { suggestedName } : {}),
    });
    if (result.result.revision < this.checkpoint.revision || result.result.savedAtMs !== savedAtMs) {
      throw new Error("Windows 原生兼容导出回执与权威 revision 不一致");
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

/**
 * Creates only a renderer-side thin-session facade for a host session whose
 * owner was independently recovered by main. It never calls coreOpen and
 * cannot claim or transfer native ownership.
 */
export function attachWindowsNativeCoreMainOwnedAuthority(
  sessionId: string,
  checkpoint: { generation: number; rootHash: string; revision: number },
): WindowsNativeCoreShadow {
  return new DesktopNativeCoreShadow(sessionId, { slot: "normal-main", ...checkpoint });
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
    opened.summary.registryFingerprint !== runtime.fingerprint) {
    await desktop.closeNativeCore({ sessionId: opened.sessionId }).catch(() => undefined);
    throw new Error("Windows 原生核心影子检查点身份无效");
  }
  return new DesktopNativeCoreShadow(opened.sessionId, checkpoint);
}
