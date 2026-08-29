import {
  getDesktopBridge,
  type DesktopNativeCoreCommitOperationResult,
  type DesktopNativeCoreFactoryReadModelRequest,
  type DesktopNativeCoreFactoryReadModelResult,
  type DesktopNativeCoreProjectionResult,
  type DesktopNativeCoreStatisticsProjectionRequest,
  type DesktopNativeCoreStatisticsProjectionResult,
  type DesktopNativeCoreStarMapOverviewProjectionRequest,
  type DesktopNativeCoreStarMapOverviewProjectionResult,
  type DesktopNativeCoreStellarIndustryProjectionRequest,
  type DesktopNativeCoreStellarIndustryProjectionResult,
  type DesktopNativeCoreStellarIndustryV2ProjectionRequest,
  type DesktopNativeCoreStellarIndustryV2ProjectionResult,
  type DesktopNativeCoreTechnologyProjectionRequest,
  type DesktopNativeCoreTechnologyProjectionResult,
  type DesktopNativeCoreViewportProjectionV2Request,
  type DesktopNativeCoreViewportProjectionV2Result,
  type DesktopNativeCoreSummary,
  type DesktopNativeSaveCommitResult,
  type DesktopNativeCoreExportResult,
  type DesktopNativePlayerAuthorityArtifactIdentity,
  type DesktopNativePlayerAuthorityCheckpointResult,
  type DesktopNativePlayerAuthorityExportResult,
} from "../desktop";
import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import {
  attachWindowsNativeCoreMainOwnedAuthority,
  openWindowsNativeCoreShadow,
  type NativeCoreAdvanceMode,
  type WindowsNativeCoreShadow,
} from "./nativeCore";
import {
  beginNativeCoreShadow,
  bindMainOwnedNativeCoreAuthority,
  createNativeCoreAuthorityState,
  fallbackNativeCoreToJavaScript,
  handleNativeCoreExit,
  recordNativeCoreAuthorityCheckpoint,
  recordNativeCoreAuthorityProgress,
  recordNativeCoreGateEvidence,
  recordNativeCoreShadowComparison,
  recordNativeCoreUnverifiedShadowProgress,
  recoverNativeCoreAuthority,
  reseedNativeCoreShadow,
  type NativeCoreAuthorityState,
  type NativeCoreGateEvidence,
  type NativeCoreRevisionProof,
} from "./nativeCoreAuthority";
import type { SimulationCommandPatch } from "./simulationRuntimeProtocol";
import type { SaveMode } from "./types";

const COMMAND_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,180}$/;
const MAX_BASE_FIELDS = 64;
const MAX_ENTITY_IDS = 4_096;
const MAX_BELT_IDS = 8_192;
const MAX_FIELD_BYTES = 128;
const MAX_ID_BYTES = 180;

export interface NativeCoreProjectionSelection {
  baseFields?: string[];
  entityIds?: string[];
  beltIds?: string[];
}

export interface NativeCoreGateMeasurement {
  observedAtMs: number;
  netThroughputRatio: number;
  ipcFrameShare: number;
  processTreeMemoryImprovementRatio: number;
}

export interface NativeCoreBetaControllerSnapshot {
  authority: NativeCoreAuthorityState;
  summary: DesktopNativeCoreSummary | null;
  recoveryRootHash: string | null;
}

export interface NativeCoreMirroredOperationResult {
  mirrored: boolean;
  reason?: string;
  state: NativeCoreAuthorityState;
}

export interface NativeCoreAuthoritativeOperationResult {
  commit: DesktopNativeCoreCommitOperationResult;
  projection?: DesktopNativeCoreProjectionResult;
  state: NativeCoreAuthorityState;
}

export interface NativeCoreDurableArtifactIdentity {
  sessionId: string;
  runId: string | null;
  revision: number;
}

export interface NativeCoreAuthorityCheckpointReceipt {
  artifact: {
    identity: NativeCoreDurableArtifactIdentity;
    checkpoint: DesktopNativePlayerAuthorityCheckpointResult["checkpoint"];
    summary: DesktopNativeCoreSummary;
  };
  snapshot: NativeCoreBetaControllerSnapshot;
}

export interface NativeCoreAuthorityExportReceipt {
  artifact: {
    identity: NativeCoreDurableArtifactIdentity;
    export: DesktopNativeCoreExportResult;
  };
}

export class NativeCoreAuthorityPausedError extends Error {
  readonly authorityState: NativeCoreAuthorityState;

  constructor(message: string, state: NativeCoreAuthorityState) {
    super(message);
    this.name = "NativeCoreAuthorityPausedError";
    this.authorityState = cloneAuthorityState(state);
  }
}

type NativeCoreShadowOpener = (
  mode: SaveMode,
  checkpoint: DesktopNativeSaveCommitResult,
  runtime: ContentPackRuntimeSnapshot,
) => Promise<WindowsNativeCoreShadow | null>;

interface VerifiedNativeShadowReadIdentity {
  session: WindowsNativeCoreShadow;
  sessionId: string;
  revision: number;
  registryFingerprint: string;
  rootHash: string;
  canonicalSha256: string;
  domainSha256: string;
}

function cloneProof(proof: NativeCoreRevisionProof | null): NativeCoreRevisionProof | null {
  return proof ? { ...proof } : null;
}

function cloneAuthorityState(state: NativeCoreAuthorityState): NativeCoreAuthorityState {
  return {
    ...state,
    latestVerifiedProof: cloneProof(state.latestVerifiedProof),
    exactCompatibleFallback: cloneProof(state.exactCompatibleFallback),
    gateEvidence: state.gateEvidence ? { ...state.gateEvidence } : null,
  };
}

function proofFromSummary(summary: DesktopNativeCoreSummary, rootHash: string): NativeCoreRevisionProof {
  return {
    revision: summary.revision,
    rootHash,
    canonicalSha256: summary.canonicalSha256,
    domainSha256: summary.domainSha256,
    registryFingerprint: summary.registryFingerprint,
  };
}

function boundedUniqueStrings(values: string[] | undefined, maximum: number, maxBytes: number, label: string): string[] {
  const source = values ?? [];
  if (source.length > maximum) throw new RangeError(`${label} 超过单帧上限 ${maximum}`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of source) {
    if (typeof value !== "string" || value.length < 1 || new TextEncoder().encode(value).byteLength > maxBytes) {
      throw new RangeError(`${label} 包含非法字段`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function normalizeProjectionSelection(selection: NativeCoreProjectionSelection = {}): Required<NativeCoreProjectionSelection> {
  return {
    baseFields: boundedUniqueStrings(selection.baseFields, MAX_BASE_FIELDS, MAX_FIELD_BYTES, "原生基础投影"),
    entityIds: boundedUniqueStrings(selection.entityIds, MAX_ENTITY_IDS, MAX_ID_BYTES, "原生实体投影"),
    beltIds: boundedUniqueStrings(selection.beltIds, MAX_BELT_IDS, MAX_ID_BYTES, "原生线路投影"),
  };
}

function validateCommandId(commandId: string): void {
  if (!COMMAND_ID_PATTERN.test(commandId)) throw new RangeError("原生权威命令 ID 非法");
}

function sameMainOwnedArtifactIdentity(
  expected: { sessionId: string; runId: string },
  actual: DesktopNativePlayerAuthorityArtifactIdentity,
  revision: number,
): boolean {
  return actual.sessionId === expected.sessionId && actual.runId === expected.runId &&
    actual.revision === revision;
}

function playerAuthorityArtifactIdentity(value: unknown): DesktopNativePlayerAuthorityArtifactIdentity | null {
  if (!value || typeof value !== "object" || !("authority" in value)) return null;
  const authority = value.authority;
  return authority && typeof authority === "object" &&
    "sessionId" in authority && typeof authority.sessionId === "string" &&
    "runId" in authority && typeof authority.runId === "string" &&
    "revision" in authority && Number.isSafeInteger(authority.revision)
    ? authority as DesktopNativePlayerAuthorityArtifactIdentity
    : null;
}

function nativeErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/**
 * Owns the invitation-Beta transition without changing the public v47 save
 * contract. JavaScript remains authoritative during shadow mode. Once native
 * authority is explicitly promoted, any uncertain failure pauses the factory;
 * it never installs an older JavaScript mirror automatically.
 */
export class WindowsNativeCoreBetaController {
  private authorityState = createNativeCoreAuthorityState();
  private session: WindowsNativeCoreShadow | null = null;
  private lastSummary: DesktopNativeCoreSummary | null = null;
  private recoveryRootHash: string | null = null;
  private operationInFlight = false;
  private mainOwnedPlayerAuthority: { sessionId: string; runId: string } | null = null;

  constructor(
    private readonly opener: NativeCoreShadowOpener = openWindowsNativeCoreShadow,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): NativeCoreBetaControllerSnapshot {
    return {
      authority: cloneAuthorityState(this.authorityState),
      summary: this.lastSummary ? structuredClone(this.lastSummary) : null,
      recoveryRootHash: this.recoveryRootHash,
    };
  }

  async openShadow(input: {
    mode: SaveMode;
    checkpoint: DesktopNativeSaveCommitResult;
    runtime: ContentPackRuntimeSnapshot;
    javascriptProof: NativeCoreRevisionProof;
  }): Promise<NativeCoreBetaControllerSnapshot> {
    if (this.authorityState.authority !== "javascript") {
      throw new Error("原生权威暂停或运行期间不能重建 JavaScript 影子");
    }
    const previousState = this.authorityState;
    const preserveShadowHistory = ["shadow", "native-ready"].includes(previousState.phase) &&
      previousState.sessionId !== null;
    await this.closeSession();
    if (!preserveShadowHistory) this.authorityState = createNativeCoreAuthorityState();
    this.lastSummary = null;
    this.recoveryRootHash = null;
    let session: WindowsNativeCoreShadow | null;
    try {
      session = await this.opener(input.mode, input.checkpoint, input.runtime);
    } catch (error) {
      if (preserveShadowHistory) this.authorityState = handleNativeCoreExit(previousState, "native-shadow-reseed-open-failed");
      throw error;
    }
    if (!session) {
      if (preserveShadowHistory) this.authorityState = handleNativeCoreExit(previousState, "native-shadow-reseed-unavailable");
      return this.snapshot();
    }
    try {
      const summary = await session.status();
      const nativeProof = proofFromSummary(summary, input.checkpoint.rootHash);
      const state = preserveShadowHistory
        ? reseedNativeCoreShadow(previousState, {
          sessionId: session.sessionId,
          javascriptProof: input.javascriptProof,
          nativeProof,
        })
        : beginNativeCoreShadow(this.authorityState, {
          sessionId: session.sessionId,
          javascriptProof: input.javascriptProof,
          nativeProof,
          startedAtMs: this.now(),
        });
      this.lastSummary = summary;
      this.recoveryRootHash = input.checkpoint.rootHash;
      this.authorityState = state;
      if (state.phase === "shadow-diverged") {
        await session.close().catch(() => undefined);
      } else {
        this.session = session;
      }
      return this.snapshot();
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Replays one already-durable JavaScript operation between proof boundaries.
   * It deliberately does not claim equality until verifyJavaScriptState runs.
   */
  async mirrorJavaScriptOperationUnverified(input: {
    commandId: string;
    baseRevision: number;
    resultRevision: number;
    command?: SimulationCommandPatch | null;
    simulationSeconds: number;
    wallSeconds: number;
    advanceMode?: NativeCoreAdvanceMode;
  }): Promise<NativeCoreMirroredOperationResult> {
    validateCommandId(input.commandId);
    if (this.authorityState.authority !== "javascript" ||
      !["shadow", "native-ready"].includes(this.authorityState.phase) || !this.session) {
      return { mirrored: false, reason: "native-shadow-not-running", state: cloneAuthorityState(this.authorityState) };
    }
    if (!Number.isSafeInteger(input.resultRevision) || input.resultRevision <= input.baseRevision) {
      throw new RangeError("原生影子结果 revision 无效");
    }
    try {
      if (this.authorityState.shadowRevision !== input.baseRevision) {
        throw new Error("原生影子操作 base revision 不连续");
      }
      const commit = await this.commitWithIdempotentRetry({ ...input, includeDiagnostics: false });
      if (commit.commandId !== input.commandId || commit.baseRevision !== input.baseRevision ||
        commit.revision !== input.resultRevision || commit.currentRevision !== input.resultRevision) {
        throw new Error("原生影子未校验操作回执 revision 不连续");
      }
      this.authorityState = recordNativeCoreUnverifiedShadowProgress(this.authorityState, commit.revision);
      return { mirrored: true, state: cloneAuthorityState(this.authorityState) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "原生影子操作失败";
      this.authorityState = handleNativeCoreExit(this.authorityState, `shadow-operation-failed:${reason}`);
      await this.closeSession();
      return { mirrored: false, reason, state: cloneAuthorityState(this.authorityState) };
    }
  }

  async verifyJavaScriptState(input: {
    javascriptProof: NativeCoreRevisionProof;
    compatibleFallback?: NativeCoreRevisionProof;
  }): Promise<NativeCoreMirroredOperationResult> {
    if (this.authorityState.authority !== "javascript" ||
      !["shadow", "native-ready"].includes(this.authorityState.phase) || !this.session ||
      !this.recoveryRootHash || input.javascriptProof.rootHash !== this.recoveryRootHash) {
      return { mirrored: false, reason: "native-shadow-not-running", state: cloneAuthorityState(this.authorityState) };
    }
    try {
      const comparison = await this.session.compare({
        revision: input.javascriptProof.revision,
        canonicalSha256: input.javascriptProof.canonicalSha256,
        domainSha256: input.javascriptProof.domainSha256,
      });
      const nativeProof = proofFromSummary(comparison.summary, input.javascriptProof.rootHash);
      this.authorityState = recordNativeCoreShadowComparison(this.authorityState, {
        javascriptProof: input.javascriptProof,
        nativeProof,
        ...(input.compatibleFallback ? { compatibleFallback: input.compatibleFallback } : {}),
      });
      this.lastSummary = comparison.summary;
      if (!comparison.matches || this.authorityState.phase === "shadow-diverged") {
        await this.closeSession();
        return { mirrored: false, reason: "native-shadow-diverged", state: cloneAuthorityState(this.authorityState) };
      }
      return { mirrored: true, state: cloneAuthorityState(this.authorityState) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "原生影子状态校验失败";
      this.authorityState = handleNativeCoreExit(this.authorityState, `shadow-compare-failed:${reason}`);
      await this.closeSession();
      return { mirrored: false, reason, state: cloneAuthorityState(this.authorityState) };
    }
  }

  async mirrorJavaScriptOperation(input: {
    commandId: string;
    baseRevision: number;
    command?: SimulationCommandPatch | null;
    simulationSeconds: number;
    wallSeconds: number;
    advanceMode?: NativeCoreAdvanceMode;
    javascriptProof: NativeCoreRevisionProof;
    compatibleFallback?: NativeCoreRevisionProof;
  }): Promise<NativeCoreMirroredOperationResult> {
    validateCommandId(input.commandId);
    if (this.authorityState.authority !== "javascript" ||
      !["shadow", "native-ready"].includes(this.authorityState.phase) || !this.session) {
      return { mirrored: false, reason: "native-shadow-not-running", state: cloneAuthorityState(this.authorityState) };
    }
    try {
      const commit = await this.commitWithIdempotentRetry({ ...input, includeDiagnostics: true });
      const summary = commit.summary ?? await this.session.status();
      if (commit.commandId !== input.commandId || commit.baseRevision !== input.baseRevision ||
        commit.revision !== input.javascriptProof.revision || commit.currentRevision !== summary.revision) {
        throw new Error("原生影子操作回执 revision 与 JavaScript 权威不一致");
      }
      const comparison = await this.session.compare({
        revision: input.javascriptProof.revision,
        canonicalSha256: input.javascriptProof.canonicalSha256,
        domainSha256: input.javascriptProof.domainSha256,
      });
      const nativeProof = proofFromSummary(comparison.summary, input.javascriptProof.rootHash);
      this.authorityState = recordNativeCoreShadowComparison(this.authorityState, {
        javascriptProof: input.javascriptProof,
        nativeProof,
        ...(input.compatibleFallback ? { compatibleFallback: input.compatibleFallback } : {}),
      });
      this.lastSummary = comparison.summary;
      if (!comparison.matches || this.authorityState.phase === "shadow-diverged") {
        await this.closeSession();
        return { mirrored: false, reason: "native-shadow-diverged", state: cloneAuthorityState(this.authorityState) };
      }
      return { mirrored: true, state: cloneAuthorityState(this.authorityState) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "原生影子操作失败";
      this.authorityState = handleNativeCoreExit(this.authorityState, `shadow-operation-failed:${reason}`);
      await this.closeSession();
      return { mirrored: false, reason, state: cloneAuthorityState(this.authorityState) };
    }
  }

  recordGateMeasurement(measurement: NativeCoreGateMeasurement): NativeCoreBetaControllerSnapshot {
    if (!this.lastSummary || this.authorityState.shadowStartedAtMs === null) {
      throw new Error("原生影子尚未产生可验证 Gate 数据");
    }
    const evidence: NativeCoreGateEvidence = {
      shadowStartedAtMs: this.authorityState.shadowStartedAtMs,
      observedAtMs: measurement.observedAtMs,
      comparisonCount: this.authorityState.comparisonCount,
      netThroughputRatio: measurement.netThroughputRatio,
      ipcFrameShare: measurement.ipcFrameShare,
      processTreeMemoryImprovementRatio: measurement.processTreeMemoryImprovementRatio,
      authorityEligibleCoverage: this.lastSummary.coverage.authorityEligible,
    };
    this.authorityState = recordNativeCoreGateEvidence(this.authorityState, evidence);
    return this.snapshot();
  }

  promoteToAuthority(exactCompatibleCheckpoint: NativeCoreRevisionProof, userOptIn: boolean): NativeCoreBetaControllerSnapshot {
    if (!userOptIn) throw new Error("原生权威必须由邀请 Beta 玩家明确选择");
    // This controller lives in the renderer and can prove only shadow
    // equality. It must never manufacture a player-authority transition from
    // a caller-provided checkpoint: the durable Rust lease, its bound host
    // session and the first acknowledged native commit are main-process-only
    // facts. Until that coordinator hands ownership over atomically, keep the
    // JavaScript factory running and fail closed without changing state.
    void exactCompatibleCheckpoint;
    throw new Error("原生权威尚未获得主进程 Rust 持久租约，已保持 JavaScript 权威");
  }

  /**
   * Completes only the renderer-side binding after a trusted main challenge
   * proves that Rust is already the active owner. Calling this method cannot
   * prepare/activate a lease or transfer a host session.
   */
  bindMainOwnedPlayerAuthority(input: {
    sessionId: string;
    runId: string;
    checkpoint: { generation: number; rootHash: string; revision: number };
    summary: DesktopNativeCoreSummary;
    source: "handoff" | "startup-recovery";
  }): NativeCoreBetaControllerSnapshot {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.runId) ||
      input.summary.stateVersion !== 47 || input.summary.mode !== "normal" || input.summary.paused ||
      input.summary.coverage.authorityEligible !== true ||
      input.summary.revision !== input.checkpoint.revision) {
      throw new Error("主进程原生权威完成回执无效");
    }
    if (input.source === "startup-recovery" && this.session) {
      throw new Error("启动恢复不能替换已有原生影子会话");
    }
    if (input.source === "handoff" && (!this.session || this.session.sessionId !== input.sessionId)) {
      throw new Error("原生权威完成回执不属于当前影子会话");
    }
    const proof = proofFromSummary(input.summary, input.checkpoint.rootHash);
    if (input.source === "handoff" && this.mainOwnedPlayerAuthority) {
      if (this.mainOwnedPlayerAuthority.sessionId !== input.sessionId ||
        this.mainOwnedPlayerAuthority.runId !== input.runId ||
        this.authorityState.phase !== "native-authoritative" ||
        this.authorityState.authority !== "native" ||
        !this.authorityState.latestVerifiedProof ||
        proof.revision < this.authorityState.latestVerifiedProof.revision ||
        proof.registryFingerprint !== this.authorityState.latestVerifiedProof.registryFingerprint) {
        throw new Error("重复的主进程原生权威完成回执发生 lineage 回退或替换");
      }
      this.authorityState = recordNativeCoreAuthorityProgress(this.authorityState, proof);
      this.recoveryRootHash = input.checkpoint.rootHash;
      this.lastSummary = input.summary;
      return this.snapshot();
    }
    const nextAuthorityState = bindMainOwnedNativeCoreAuthority(this.authorityState, {
      sessionId: input.sessionId,
      proof,
      authorityEligibleCoverage: true,
      source: input.source,
    });
    if (input.source === "startup-recovery") {
      this.session = attachWindowsNativeCoreMainOwnedAuthority(input.sessionId, input.checkpoint);
    }
    this.authorityState = nextAuthorityState;
    this.recoveryRootHash = input.checkpoint.rootHash;
    this.lastSummary = input.summary;
    this.mainOwnedPlayerAuthority = Object.freeze({
      sessionId: input.sessionId,
      runId: input.runId,
    });
    return this.snapshot();
  }

  async commitAuthoritativeOperation(input: {
    commandId: string;
    baseRevision: number;
    command?: SimulationCommandPatch | null;
    simulationSeconds: number;
    wallSeconds: number;
    advanceMode?: NativeCoreAdvanceMode;
    projection?: NativeCoreProjectionSelection;
  }): Promise<NativeCoreAuthoritativeOperationResult> {
    validateCommandId(input.commandId);
    const projectionSelection = input.projection ? normalizeProjectionSelection(input.projection) : null;
    if (this.authorityState.phase !== "native-authoritative" ||
      this.authorityState.authority !== "native" || !this.session || !this.recoveryRootHash) {
      throw new Error("Windows 原生核心当前不是权威状态");
    }
    try {
      const commit = await this.commitWithIdempotentRetry({ ...input, includeDiagnostics: true });
      const summary = commit.summary ?? await this.session.status();
      if (commit.commandId !== input.commandId || commit.baseRevision !== input.baseRevision ||
        commit.currentRevision !== commit.revision || summary.revision !== commit.revision) {
        throw new Error("原生权威操作回执不连续");
      }
      this.authorityState = recordNativeCoreAuthorityProgress(
        this.authorityState,
        proofFromSummary(summary, this.recoveryRootHash),
      );
      this.lastSummary = summary;
      const projection = projectionSelection
        ? await this.readBoundedProjection(projectionSelection, commit.revision)
        : undefined;
      return {
        commit,
        ...(projection ? { projection } : {}),
        state: cloneAuthorityState(this.authorityState),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "原生权威操作失败";
      this.authorityState = handleNativeCoreExit(this.authorityState, `authority-operation-failed:${reason}`);
      throw new NativeCoreAuthorityPausedError(`原生核心回执不确定，工厂已暂停：${reason}`, this.authorityState);
    }
  }

  async createAuthorityCheckpoint(
    exactCompatibleCheckpoint?: NativeCoreRevisionProof,
    savedAtMs = this.now(),
  ): Promise<NativeCoreAuthorityCheckpointReceipt> {
    if (this.authorityState.phase !== "native-authoritative" ||
      this.authorityState.authority !== "native" || !this.session) {
      throw new Error("只有原生权威可以创建检查点");
    }
    try {
      const mainOwnedIdentity = this.mainOwnedPlayerAuthority;
      const result: DesktopNativePlayerAuthorityCheckpointResult |
        Awaited<ReturnType<WindowsNativeCoreShadow["createCheckpoint"]>> = mainOwnedIdentity
          ? await (() => {
            const desktop = getDesktopBridge();
            if (!desktop?.checkpointNativePlayerAuthority) {
              throw new Error("主进程原生权威检查点桥接不可用");
            }
            return desktop.checkpointNativePlayerAuthority();
          })()
          : await this.session.createCheckpoint(savedAtMs);
      const resultAuthority = playerAuthorityArtifactIdentity(result);
      if (result.checkpoint.revision !== result.summary.revision ||
        mainOwnedIdentity && (!resultAuthority ||
        !sameMainOwnedArtifactIdentity(mainOwnedIdentity, resultAuthority, result.summary.revision))) {
        throw new Error("主进程原生权威检查点不属于当前 session/run lineage");
      }
      const nativeProof = proofFromSummary(result.summary, result.checkpoint.rootHash);
      const currentProof = this.authorityState.latestVerifiedProof;
      if (!currentProof || nativeProof.revision >= currentProof.revision || exactCompatibleCheckpoint) {
        this.authorityState = exactCompatibleCheckpoint
          ? recordNativeCoreAuthorityCheckpoint(this.authorityState, nativeProof, exactCompatibleCheckpoint)
          : recordNativeCoreAuthorityProgress(this.authorityState, nativeProof);
        this.recoveryRootHash = result.checkpoint.rootHash;
        this.lastSummary = result.summary;
      } else if (!mainOwnedIdentity || nativeProof.registryFingerprint !== currentProof.registryFingerprint) {
        throw new Error("原生权威检查点 lineage 回退或发生替换");
      }
      const identity: NativeCoreDurableArtifactIdentity = resultAuthority
        ? { ...resultAuthority }
        : { sessionId: this.session.sessionId, runId: null, revision: result.summary.revision };
      return {
        artifact: {
          identity,
          checkpoint: { ...result.checkpoint },
          summary: structuredClone(result.summary),
        },
        snapshot: this.snapshot(),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "原生权威检查点失败";
      if (this.mainOwnedPlayerAuthority &&
        nativeErrorCode(error) === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY") {
        throw error instanceof Error ? error : new Error(reason);
      }
      this.authorityState = handleNativeCoreExit(this.authorityState, `authority-checkpoint-failed:${reason}`);
      throw new NativeCoreAuthorityPausedError(`原生检查点不确定，工厂已暂停：${reason}`, this.authorityState);
    }
  }

  async exportAuthoritativeV47(
    exportId: string,
    suggestedName?: string,
    savedAtMs = this.now(),
  ): Promise<NativeCoreAuthorityExportReceipt> {
    if (this.authorityState.phase !== "native-authoritative" ||
      this.authorityState.authority !== "native" || !this.session) {
      throw new Error("只有原生权威可以直接流式导出 v47 存档");
    }
    try {
      const mainOwnedIdentity = this.mainOwnedPlayerAuthority;
      const result: DesktopNativePlayerAuthorityExportResult | DesktopNativeCoreExportResult = mainOwnedIdentity
        ? await (() => {
          const desktop = getDesktopBridge();
          if (!desktop?.exportNativePlayerAuthorityV47) {
            throw new Error("主进程原生权威导出桥接不可用");
          }
          return desktop.exportNativePlayerAuthorityV47({
            exportId,
            savedAtMs,
            ...(suggestedName ? { suggestedName } : {}),
          });
        })()
        : await this.session.exportV47(exportId, suggestedName, savedAtMs);
      // The main-owned clock can advance between renderer projections and the
      // frozen export boundary. The dedicated main broker proves that export
      // belongs to the current lease, so forward progress is valid; a
      // renderer-owned shadow must still match its exact cached revision. Once
      // main returns, the selected file has already been atomically published;
      // a renderer clock-lineage change is therefore a recovery warning, not a
      // reason to misreport the durable file as failed.
      const resultAuthority = playerAuthorityArtifactIdentity(result);
      if (mainOwnedIdentity && (result.mode !== "normal" || !resultAuthority ||
        resultAuthority.revision !== result.result.revision)) {
        throw new Error("主进程原生权威导出回执结构无效");
      }
      if (!this.lastSummary || (!mainOwnedIdentity &&
        result.result.revision !== this.lastSummary.revision)) {
        throw new Error("原生导出 revision 与当前权威状态不一致");
      }
      return {
        artifact: {
          identity: resultAuthority
            ? { ...resultAuthority }
            : { sessionId: this.session.sessionId, runId: null, revision: result.result.revision },
          export: result,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "原生权威导出失败";
      throw new Error(`原生 v47 导出失败，权威工厂未改变：${reason}`);
    }
  }

  async recoverAuthority(input: {
    mode: SaveMode;
    checkpoint: DesktopNativeSaveCommitResult;
    runtime: ContentPackRuntimeSnapshot;
  }): Promise<NativeCoreBetaControllerSnapshot> {
    if (!["paused-core-crash", "paused-recovery-required"].includes(this.authorityState.phase) ||
      this.authorityState.authority !== "none") {
      throw new Error("当前没有待恢复的原生权威会话");
    }
    await this.closeSession();
    const session = await this.opener(input.mode, input.checkpoint, input.runtime);
    if (!session) {
      this.authorityState = { ...this.authorityState, phase: "paused-recovery-required", reason: "native-recovery-unavailable" };
      return this.snapshot();
    }
    try {
      const summary = await session.status();
      const recovered = recoverNativeCoreAuthority(
        this.authorityState,
        session.sessionId,
        proofFromSummary(summary, input.checkpoint.rootHash),
      );
      this.authorityState = recovered;
      if (recovered.authority === "native") {
        this.session = session;
        this.lastSummary = summary;
        this.recoveryRootHash = input.checkpoint.rootHash;
      } else {
        await session.close().catch(() => undefined);
      }
      return this.snapshot();
    } catch (error) {
      await session.close().catch(() => undefined);
      this.authorityState = { ...this.authorityState, phase: "paused-recovery-required", reason: "native-recovery-failed" };
      throw error;
    }
  }

  async explicitFallbackToJavaScript(compatibleCheckpoint: NativeCoreRevisionProof): Promise<NativeCoreBetaControllerSnapshot> {
    const next = fallbackNativeCoreToJavaScript(this.authorityState, compatibleCheckpoint);
    this.authorityState = next;
    if (next.authority === "javascript") {
      await this.closeSession();
      this.recoveryRootHash = compatibleCheckpoint.rootHash;
    }
    return this.snapshot();
  }

  async notifyCoreExit(reason = "native-core-exited"): Promise<NativeCoreBetaControllerSnapshot> {
    this.authorityState = handleNativeCoreExit(this.authorityState, reason);
    await this.closeSession();
    return this.snapshot();
  }

  /**
   * Returns the bounded shell/selection/construction model only while the
   * native shadow remains proven to be the exact renderer revision. Both the
   * main-process boundary and this controller perform the revision check.
   */
  async readVerifiedFactoryReadModel(
    request: Omit<DesktopNativeCoreFactoryReadModelRequest, "sessionId" | "expectedRevision">,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreFactoryReadModelResult | null> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
    const session = this.session;
    const state = this.authorityState;
    if (!session || this.operationInFlight || state.authority !== "javascript" ||
      !["shadow", "native-ready"].includes(state.phase) ||
      state.shadowRevision !== expectedRevision || state.latestVerifiedProof?.revision !== expectedRevision) {
      return null;
    }
    try {
      const projection = await session.factoryReadModel({ ...request, expectedRevision });
      const current = this.authorityState;
      if (this.session !== session || this.operationInFlight || current.authority !== "javascript" ||
        !["shadow", "native-ready"].includes(current.phase) ||
        current.shadowRevision !== expectedRevision || current.latestVerifiedProof?.revision !== expectedRevision ||
        projection.revision !== expectedRevision) {
        return null;
      }
      return projection;
    } catch {
      // A read-model failure never changes authority state or stops simulation.
      return null;
    }
  }

  /**
   * Optional read-only acceleration for the renderer. JavaScript remains the
   * authority: a native result is exposed only while the shadow and its latest
   * verified proof identify the exact revision requested by the caller.
   */
  async readVerifiedStatisticsProjection(
    request: Omit<DesktopNativeCoreStatisticsProjectionRequest, "sessionId" | "expectedRevision">,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreStatisticsProjectionResult | null> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
    const session = this.session;
    const state = this.authorityState;
    if (!session || this.operationInFlight || state.authority !== "javascript" ||
      !["shadow", "native-ready"].includes(state.phase) ||
      state.shadowRevision !== expectedRevision || state.latestVerifiedProof?.revision !== expectedRevision) {
      return null;
    }
    try {
      const projection = await session.statisticsProjection({ ...request, expectedRevision });
      const current = this.authorityState;
      if (this.session !== session || this.operationInFlight || current.authority !== "javascript" ||
        !["shadow", "native-ready"].includes(current.phase) ||
        current.shadowRevision !== expectedRevision || current.latestVerifiedProof?.revision !== expectedRevision ||
        projection.revision !== expectedRevision) {
        return null;
      }
      return projection;
    } catch {
      // A read-model failure never changes authority state or stops simulation.
      return null;
    }
  }

  async readVerifiedTechnologyProjection(
    request: Omit<DesktopNativeCoreTechnologyProjectionRequest, "sessionId" | "expectedRevision">,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreTechnologyProjectionResult | null> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
    const session = this.session;
    const state = this.authorityState;
    if (!session || this.operationInFlight || state.authority !== "javascript" ||
      !["shadow", "native-ready"].includes(state.phase) ||
      state.shadowRevision !== expectedRevision || state.latestVerifiedProof?.revision !== expectedRevision) {
      return null;
    }
    try {
      const projection = await session.technologyProjection({ ...request, expectedRevision });
      const current = this.authorityState;
      if (this.session !== session || this.operationInFlight || current.authority !== "javascript" ||
        !["shadow", "native-ready"].includes(current.phase) ||
        current.shadowRevision !== expectedRevision || current.latestVerifiedProof?.revision !== expectedRevision ||
        projection.revision !== expectedRevision) {
        return null;
      }
      return projection;
    } catch {
      return null;
    }
  }

  /**
   * Exposes the bounded native star-map page only while the exact JavaScript
   * shadow proof remains current. The registry fingerprint is always derived
   * from that proof and overwrites any runtime property supplied by a caller.
   */
  async readVerifiedStarMapOverviewProjection(
    request: Omit<
      DesktopNativeCoreStarMapOverviewProjectionRequest,
      "sessionId" | "expectedRevision" | "expectedRegistryFingerprint"
  >,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreStarMapOverviewProjectionResult | null> {
    try {
      const identity = this.verifiedShadowReadIdentity(expectedRevision);
      if (!identity) return null;
      const projection = await identity.session.starMapOverviewProjection({
        ...request,
        expectedRevision: identity.revision,
        expectedRegistryFingerprint: identity.registryFingerprint,
      });
      if (!this.isVerifiedShadowReadIdentityCurrent(identity) ||
        projection.schemaVersion !== 1 || projection.projectionType !== "star-map-overview-v1" ||
        projection.stateVersion !== 47 || projection.revision !== identity.revision ||
        projection.registryFingerprint !== identity.registryFingerprint ||
        projection.request.expectedRevision !== identity.revision ||
        projection.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
        projection.request.cursor !== request.cursor || projection.request.limit !== request.limit) {
        return null;
      }
      return projection;
    } catch {
      return null;
    }
  }

  async readVerifiedStellarIndustryProjection(
    request: Omit<
      DesktopNativeCoreStellarIndustryProjectionRequest,
      "sessionId" | "expectedRevision" | "expectedRegistryFingerprint"
  >,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreStellarIndustryProjectionResult | null> {
    try {
      const identity = this.verifiedShadowReadIdentity(expectedRevision);
      if (!identity) return null;
      const projection = await identity.session.stellarIndustryProjection({
        ...request,
        expectedRevision: identity.revision,
        expectedRegistryFingerprint: identity.registryFingerprint,
      });
      if (!this.isVerifiedShadowReadIdentityCurrent(identity) ||
        projection.schemaVersion !== 1 || projection.projectionType !== "stellar-industry-v1" ||
        projection.stateVersion !== 47 || projection.revision !== identity.revision ||
        projection.registryFingerprint !== identity.registryFingerprint ||
        projection.request.expectedRevision !== identity.revision ||
        projection.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
        projection.request.systemId !== request.systemId || projection.request.planetId !== request.planetId ||
        projection.request.planetCursor !== request.planetCursor || projection.request.planetLimit !== request.planetLimit ||
        projection.request.stationCursor !== request.stationCursor || projection.request.stationLimit !== request.stationLimit) {
        return null;
      }
      return projection;
    } catch {
      return null;
    }
  }

  async readVerifiedStellarIndustryV2Projection(
    request: Omit<
      DesktopNativeCoreStellarIndustryV2ProjectionRequest,
      "sessionId" | "expectedRevision" | "expectedRegistryFingerprint"
    >,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreStellarIndustryV2ProjectionResult | null> {
    try {
      const identity = this.verifiedShadowReadIdentity(expectedRevision);
      if (!identity) return null;
      const projection = await identity.session.stellarIndustryV2Projection({
        ...request,
        expectedRevision: identity.revision,
        expectedRegistryFingerprint: identity.registryFingerprint,
      });
      if (!this.isVerifiedShadowReadIdentityCurrent(identity) ||
        projection.schemaVersion !== 2 || projection.projectionType !== "stellar-industry-v2" ||
        projection.stateVersion !== 47 || projection.revision !== identity.revision ||
        projection.registryFingerprint !== identity.registryFingerprint ||
        projection.request.expectedRevision !== identity.revision ||
        projection.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
        projection.request.systemId !== request.systemId || projection.request.planetId !== request.planetId ||
        projection.request.planetCursor !== request.planetCursor || projection.request.planetLimit !== request.planetLimit ||
        projection.request.stationCursor !== request.stationCursor || projection.request.stationLimit !== request.stationLimit ||
        projection.request.routeCursor !== request.routeCursor || projection.request.routeLimit !== request.routeLimit ||
        projection.request.routeFilter !== request.routeFilter || projection.request.query !== request.query ||
        projection.scopeSystemId !== request.systemId || projection.scopePlanetId !== request.planetId) {
        return null;
      }
      return projection;
    } catch {
      return null;
    }
  }

  /**
   * Returns a viewport block only when the native shadow is still proven to be
   * the exact renderer revision both before and after the asynchronous IPC.
   * The main process independently binds expectedRevision to the response.
   */
  async readVerifiedViewportProjectionV2(
    request: Omit<DesktopNativeCoreViewportProjectionV2Request, "sessionId" | "expectedRevision">,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreViewportProjectionV2Result | null> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
    const session = this.session;
    const state = this.authorityState;
    if (!session || this.operationInFlight || state.authority !== "javascript" ||
      !["shadow", "native-ready"].includes(state.phase) ||
      state.shadowRevision !== expectedRevision || state.latestVerifiedProof?.revision !== expectedRevision) {
      return null;
    }
    try {
      const projection = await session.viewportProjectionV2({ ...request, expectedRevision });
      const current = this.authorityState;
      if (this.session !== session || this.operationInFlight || current.authority !== "javascript" ||
        !["shadow", "native-ready"].includes(current.phase) ||
        current.shadowRevision !== expectedRevision || current.latestVerifiedProof?.revision !== expectedRevision ||
        projection.revision !== expectedRevision) {
        return null;
      }
      return projection;
    } catch {
      // A read-model failure never changes authority state or stops simulation.
      return null;
    }
  }

  private async readBoundedProjection(
    selection: NativeCoreProjectionSelection,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreProjectionResult> {
    if (!this.session) throw new Error("原生投影会话不可用");
    const projection = await this.session.projection(normalizeProjectionSelection(selection));
    if (projection.revision !== expectedRevision) throw new Error("原生投影 revision 与权威回执不一致");
    return projection;
  }

  private verifiedShadowReadIdentity(expectedRevision: number): VerifiedNativeShadowReadIdentity | null {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
    const session = this.session;
    const state = this.authorityState;
    const proof = state.latestVerifiedProof;
    if (!session || this.operationInFlight || state.authority !== "javascript" ||
      !["shadow", "native-ready"].includes(state.phase) || state.sessionId !== session.sessionId ||
      state.shadowRevision !== expectedRevision || proof?.revision !== expectedRevision ||
      typeof proof.registryFingerprint !== "string" || proof.registryFingerprint.length < 1) {
      return null;
    }
    return {
      session,
      sessionId: session.sessionId,
      revision: expectedRevision,
      registryFingerprint: proof.registryFingerprint,
      rootHash: proof.rootHash,
      canonicalSha256: proof.canonicalSha256,
      domainSha256: proof.domainSha256,
    };
  }

  private isVerifiedShadowReadIdentityCurrent(identity: VerifiedNativeShadowReadIdentity): boolean {
    const current = this.authorityState;
    const proof = current.latestVerifiedProof;
    return this.session === identity.session && identity.session.sessionId === identity.sessionId &&
      !this.operationInFlight && current.authority === "javascript" &&
      ["shadow", "native-ready"].includes(current.phase) && current.sessionId === identity.sessionId &&
      current.shadowRevision === identity.revision && proof?.revision === identity.revision &&
      proof.registryFingerprint === identity.registryFingerprint && proof.rootHash === identity.rootHash &&
      proof.canonicalSha256 === identity.canonicalSha256 && proof.domainSha256 === identity.domainSha256;
  }

  private async commitWithIdempotentRetry(input: {
    commandId: string;
    baseRevision: number;
    command?: SimulationCommandPatch | null;
    simulationSeconds: number;
    wallSeconds: number;
    advanceMode?: NativeCoreAdvanceMode;
    includeDiagnostics: boolean;
  }): Promise<DesktopNativeCoreCommitOperationResult> {
    if (!this.session) throw new Error("原生核心会话不可用");
    if (this.operationInFlight) throw new Error("已有原生权威命令正在等待回执");
    this.operationInFlight = true;
    try {
      try {
        return await this.session.commitOperation(input);
      } catch (firstError) {
        // A transport timeout can occur after the native WAL commit. Query the
        // same session and retry the identical command ID exactly once; the
        // host returns the durable receipt instead of executing it twice.
        await this.session.status();
        try {
          return await this.session.commitOperation(input);
        } catch (retryError) {
          throw retryError instanceof Error ? retryError : firstError;
        }
      }
    } finally {
      this.operationInFlight = false;
    }
  }

  private async closeSession(): Promise<void> {
    const current = this.session;
    this.session = null;
    const mainOwned = this.mainOwnedPlayerAuthority;
    this.mainOwnedPlayerAuthority = null;
    if (current && !mainOwned) await current.close().catch(() => undefined);
  }
}
