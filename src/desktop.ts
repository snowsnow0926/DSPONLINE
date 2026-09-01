import type { BeltConnection, FactoryEntity, ProductionHistorySample } from "./game/types";
import type { FactoryNodePresentationReadModel, FactoryReadModelBundle } from "./game/factoryReadModels";
import type {
  LocalSaveNativeAuthorityCheckpoint,
  LocalSaveNativeAuthorityHandoffJournal,
  LocalSaveNativeAuthorityHandoffReconcileDecision,
  LocalSaveNativeAuthorityLeaseReceipt,
  LocalSaveWriterFence,
} from "./game/localSaveAuthorityLease";

export type DesktopUpdateState = "development" | "idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";

export interface DesktopUpdateStatus {
  state: DesktopUpdateState;
  message: string;
  channel: "stable" | "beta" | "nightly";
  version?: string;
  progress?: number;
}

export interface DesktopReleaseInfo {
  isDesktop: true;
  /** Present in the isolated performance-edition shell; older rollback hosts may omit it. */
  editionId?: "windows-performance-development-v1";
  productName?: "DSP极简网络 Windows 性能开发版";
  platform: string;
  channel: "stable" | "beta" | "nightly";
  channelLabel: string;
  version: string;
  update: DesktopUpdateStatus;
}

export type DesktopNativePlayerAuthorityPhase =
  | "idle"
  | "activating"
  | "recovering"
  | "active"
  | "pausing"
  | "paused"
  | "resuming"
  | "pause-uncertain"
  | "resume-uncertain"
  | "uncertain"
  | "faulted"
  | "shutdown";

export type DesktopNativePlayerAuthorityOperation =
  | "activation"
  | "recovery"
  | "tick"
  | "command"
  | "pause"
  | "resume";

export type DesktopNativePlayerAuthorityMacroPhase =
  | "macro-active"
  | "macro-committing"
  | "macro-finishing"
  | "macro-uncertain"
  | "faulted"
  | "shutdown";

export type DesktopNativePlayerAuthorityMacroOperation = "advance" | "finish";

export interface DesktopNativePlayerAuthorityMacroRecoveryHint {
  readonly kind: "finished-pending-disable";
  readonly revision: number;
}

export type DesktopNativePlayerAuthorityMacroPausedReason =
  | "macro-window-active"
  | "macro-advance-committing"
  | "macro-finish-committing"
  | "macro-advance-uncertain"
  | "macro-finish-uncertain"
  | "macro-runtime-faulted"
  | "macro-runtime-shutdown";

/**
 * Bounded, renderer-safe view of the main-owned Rust authority clock.
 *
 * This is deliberately a clock/identity receipt rather than gameplay state.
 * It contains no owner ID, fencing token, checkpoint, command, save payload or
 * authority-control capability.
 */
export interface DesktopNativePlayerAuthorityClockState {
  readonly schemaVersion: 1;
  readonly phase: DesktopNativePlayerAuthorityPhase;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly revision: number | null;
  readonly acknowledgedSequence: number | null;
  readonly nextSequence: number | null;
  readonly nextDeadlineMs: number | null;
  readonly inFlight: boolean;
  readonly currentOperation: DesktopNativePlayerAuthorityOperation | null;
  readonly queuedCommands: number;
  readonly lastErrorCode: string | null;
  /** Main-owned durable finish recovery still needs the renderer to disable time warp. */
  readonly macroRecoveryHint?: DesktopNativePlayerAuthorityMacroRecoveryHint;
}

/**
 * Identity-free renderer status for a main-owned productive macro window.
 * Optional `never` identity fields document that callers may probe them while
 * still guaranteeing that a valid wire object cannot contain those keys.
 */
export interface DesktopNativePlayerAuthorityMacroState {
  readonly schemaVersion: 2;
  readonly statusKind: "macro";
  readonly phase: DesktopNativePlayerAuthorityMacroPhase;
  readonly revision: number;
  readonly acknowledgedSequence: number;
  readonly nextSequence: number;
  readonly nextDeadlineMs: number;
  readonly inFlight: boolean;
  readonly currentOperation: DesktopNativePlayerAuthorityMacroOperation | null;
  readonly simulationBudgetMilliseconds: number | null;
  readonly wallBudgetMilliseconds: number | null;
  readonly simulationProgressMilliseconds: number | null;
  readonly wallProgressMilliseconds: number | null;
  readonly pausedReason: DesktopNativePlayerAuthorityMacroPausedReason;
  readonly sessionId?: never;
  readonly runId?: never;
  readonly queuedCommands?: never;
  readonly lastErrorCode?: never;
}

export type DesktopNativePlayerAuthorityState =
  | DesktopNativePlayerAuthorityClockState
  | DesktopNativePlayerAuthorityMacroState;

export interface DesktopNativePlayerAuthorityHandoffPrepareRequest {
  readonly kind: "native-player-authority-quiescence-prepare-v1";
  readonly handoffId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly initialRevision: number;
  readonly timeoutMs: number;
}

export interface DesktopNativePlayerAuthorityHandoffCommitRequest {
  readonly kind: "native-player-authority-quiescence-request-v1";
  readonly handoffId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly checkpoint: LocalSaveNativeAuthorityCheckpoint;
  readonly publicWriterFence: LocalSaveWriterFence;
  readonly settledDeadlineMs: number;
}

export interface DesktopNativePlayerAuthorityHandoffCancelRequest {
  readonly kind: "native-player-authority-quiescence-cancel-v1";
  readonly handoffId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly releaseAuthorized: true;
  readonly browserFenceAcquired: false;
}

export interface DesktopNativePlayerAuthorityHandoffReleaseRequest {
  readonly kind: "native-player-authority-browser-fence-release-v1";
  readonly handoffId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly checkpoint: LocalSaveNativeAuthorityCheckpoint;
  readonly receipt: LocalSaveNativeAuthorityLeaseReceipt;
  readonly releaseAuthorized: true;
  readonly decision: LocalSaveNativeAuthorityHandoffReconcileDecision;
}

export interface DesktopNativePlayerAuthorityHandoffCompleteRequest {
  readonly kind: "native-player-authority-handoff-complete-v1";
  readonly handoffId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly checkpoint: LocalSaveNativeAuthorityCheckpoint;
  readonly nativeWriterFence: LocalSaveWriterFence;
  readonly summary: DesktopNativeCoreSummary;
}

export type DesktopNativePlayerAuthorityStartupLeaseObservation =
  | {
      readonly state: "active";
      readonly runId: string;
      readonly sessionId: string;
      readonly stateVersion: 47;
      readonly mode: "normal";
      /** Exact entry checkpoint stored in the browser-fence journal. */
      readonly entryCheckpoint: LocalSaveNativeAuthorityCheckpoint;
      /** Latest Rust-ACKed checkpoint used to bind the thin renderer. */
      readonly checkpoint: LocalSaveNativeAuthorityCheckpoint;
      readonly summary: DesktopNativeCoreSummary;
    }
  | { readonly state: "absent" }
  | { readonly state: "unknown" };

export interface DesktopNativePlayerAuthorityStartupReconcileRequest {
  readonly kind: "native-player-authority-startup-reconcile-v1";
  readonly handoffId: string;
  readonly rustLease: DesktopNativePlayerAuthorityStartupLeaseObservation;
  readonly releaseAuthorized: boolean;
  readonly timeoutMs: number;
}

export type DesktopNativePlayerAuthorityHandoffRequest =
  | DesktopNativePlayerAuthorityHandoffPrepareRequest
  | DesktopNativePlayerAuthorityHandoffCommitRequest
  | DesktopNativePlayerAuthorityHandoffCancelRequest
  | DesktopNativePlayerAuthorityHandoffReleaseRequest
  | DesktopNativePlayerAuthorityHandoffCompleteRequest
  | DesktopNativePlayerAuthorityStartupReconcileRequest;

export type DesktopNativePlayerAuthorityHandoffResult =
  | {
      readonly kind: "native-player-authority-quiescence-prepared-v1";
      readonly publicWriterFence: LocalSaveWriterFence;
      readonly rendererInFlightCoreOperations: 0;
      readonly workerInFlightCoreOperations: 0;
      readonly settledDeadlineMs: number;
    }
  | {
      readonly kind: "native-player-authority-browser-fenced-v1";
      readonly leaseReceipt: LocalSaveNativeAuthorityLeaseReceipt;
      readonly journal: Extract<LocalSaveNativeAuthorityHandoffJournal, { phase: "browser-fenced" }>;
      readonly rendererInFlightCoreOperations: 0;
      readonly workerInFlightCoreOperations: 0;
    }
  | {
      readonly kind: "native-player-authority-quiescence-cancelled-v1";
      readonly resumedJavaScript: true;
    }
  | {
      readonly kind: "native-player-authority-browser-fence-released-v1";
      readonly released: true;
      readonly returnedWriterFence: LocalSaveWriterFence;
    }
  | {
      readonly kind: "native-player-authority-handoff-completed-v1";
      readonly sessionId: string;
      readonly runId: string;
      readonly revision: number;
      readonly checkpoint: LocalSaveNativeAuthorityCheckpoint;
      readonly nativeWriterFence: LocalSaveWriterFence;
      readonly rendererInFlightCoreOperations: 0;
      readonly workerInFlightCoreOperations: 0;
      readonly controllerPhase: "native-authoritative";
    }
  | {
      readonly kind: "native-player-authority-startup-reconciled-v1";
      readonly action: "resumed-native" | "released-browser-fence" | "no-browser-fence" | "fail-closed";
      readonly rendererInFlightCoreOperations: 0;
      readonly workerInFlightCoreOperations: 0;
    };

export interface DesktopNativePlayerAuthorityMacroStartRequest {
  /** Optimistic fences only; main derives time budgets and owns every durable identity. */
  readonly expectedRevision: number;
  readonly effectiveMultiplier: number;
}

/** Identity-free receipt; all durable macro IDs remain inside main/Rust. */
export interface DesktopNativePlayerAuthorityMacroReceipt {
  readonly schemaVersion: 1;
  readonly state: "macro-active" | "finished";
  readonly revision: number;
  readonly previousRevision: number | null;
  readonly simulationMilliseconds: number | null;
  readonly wallMilliseconds: number | null;
  readonly recovered: boolean;
}

/** Exact browser source proof only; Electron main owns time and export identity. */
export interface DesktopNativeOfflineStartupRequest {
  readonly sessionId: string;
  readonly expectedGeneration: number;
  readonly expectedRootHash: string;
  readonly expectedRevision: number;
  readonly expectedRegistryFingerprint: string;
  readonly expectedCanonicalSha256: string;
  readonly expectedDomainSha256: string;
  readonly strategy: "macro-v1";
}

export interface DesktopBridge {
  isDesktop: true;
  setFontScale: (scale: number) => Promise<{ scale: number; zoomFactor: number }>;
  getReleaseInfo: () => Promise<DesktopReleaseInfo>;
  getNativePerformanceStatus: () => Promise<DesktopNativePerformanceStatus>;
  /** Current Windows authority host only; absent on Web and rollback shells. */
  getNativePlayerAuthorityState?: () => Promise<DesktopNativePlayerAuthorityState>;
  /** Requests only pause intent; main owns authority identity and every wall-clock anchor. */
  setNativePlayerAuthorityPaused?: (
    request: { readonly paused: boolean },
  ) => Promise<DesktopNativePlayerAuthorityClockState>;
  /** Read-only transition notifications; unsubscribe removes only this listener. */
  onNativePlayerAuthorityState?: (
    listener: (state: DesktopNativePlayerAuthorityState) => void,
  ) => () => void;
  /** Main-generated response-only challenge; it cannot initiate or transfer ownership. */
  onNativePlayerAuthorityHandoffRequest?: (
    listener: (
      request: DesktopNativePlayerAuthorityHandoffRequest,
    ) => Promise<DesktopNativePlayerAuthorityHandoffResult>,
  ) => () => void;
  /** Main-owned and identity-free; reuses the last Rust lease ACK checkpoint. */
  checkpointNativePlayerAuthority?: () => Promise<DesktopNativePlayerAuthorityCheckpointResult>;
  /** Explicit fault recovery; Rust ownership is retained and the app reopens from durable state. */
  restartNativePlayerAuthorityFromDurable?: (
    request: { readonly expectedRevision: number },
  ) => Promise<DesktopNativePlayerAuthorityDurableRestartResult>;
  /** Main selects the active authority session; renderer supplies only export presentation data. */
  exportNativePlayerAuthorityV47?: (
    request: DesktopNativePlayerAuthorityExportRequest,
  ) => Promise<DesktopNativePlayerAuthorityExportResult>;
  /** Main streams a fixed Rust export; renderer never receives save bytes or a file path. */
  uploadNativePlayerAuthorityCloudSave?: (
    request: DesktopNativePlayerAuthorityCloudUploadRequest,
  ) => Promise<DesktopNativePlayerAuthorityCloudUploadResult>;
  onNativePlayerAuthorityCloudProgress?: (
    listener: (progress: DesktopNativePlayerAuthorityCloudProgress) => void,
  ) => () => void;
  /** Revision/multiplier observation only; main derives all elapsed-time budgets. */
  startNativePlayerAuthorityMacro?: (
    request: DesktopNativePlayerAuthorityMacroStartRequest,
  ) => Promise<DesktopNativePlayerAuthorityMacroReceipt>;
  /** Parameter-free intent; main samples its monotonic clock at acceptance. */
  advanceNativePlayerAuthorityMacro?: () => Promise<DesktopNativePlayerAuthorityMacroReceipt>;
  finishNativePlayerAuthorityMacro?: () => Promise<DesktopNativePlayerAuthorityMacroReceipt>;
  recoverNativePlayerAuthorityMacro?: () => Promise<DesktopNativePlayerAuthorityMacroReceipt>;
  /** Read-only startup candidate; source checkpoint remains unchanged until browser adoption. */
  prepareNativeOfflineStartup?: (
    request: DesktopNativeOfflineStartupRequest,
  ) => Promise<DesktopNativeOfflineStartupResult>;
  getRuntimeDiagnostics: () => Promise<DesktopRuntimeDiagnostics>;
  getNativeProjectionSubscriptionDiagnostics?: () =>
    Promise<DesktopNativeProjectionSubscriptionDiagnostics>;
  getNativePerformancePolicy: () => Promise<DesktopNativePerformancePolicyStatus>;
  setNativePerformancePolicy: (request: DesktopNativePerformancePolicy) => Promise<DesktopNativePerformancePolicyStatus>;
  beginNativeSave: (request: DesktopNativeSaveBeginRequest) => Promise<DesktopNativeSaveBeginResult>;
  writeNativeSave: (request: DesktopNativeSaveWriteRequest) => Promise<{ acceptedRecords: number }>;
  commitNativeSave: (request: DesktopNativeSaveTransactionRequest) => Promise<DesktopNativeSaveCommitResult>;
  abortNativeSave: (request: DesktopNativeSaveTransactionRequest) => Promise<{ aborted: boolean }>;
  recoverNativeSave: (request: DesktopNativeSaveSlotRequest) => Promise<DesktopNativeSaveRecoveryResult | null>;
  readNativeSave: (request: DesktopNativeSaveReadRequest) => Promise<DesktopNativeSaveReadResult>;
  appendNativeWal: (request: DesktopNativeWalAppendRequest) => Promise<DesktopNativeWalAppendResult>;
  compactNativeSave: (request: DesktopNativeSaveSlotRequest & { retainGenerations?: number }) => Promise<{ removedGenerations: number }>;
  openNativeCore: (request: DesktopNativeCoreOpenRequest) => Promise<DesktopNativeCoreOpenResult>;
  /** Current Windows host only; accepts GameState v46/v47 and normalizes to v47. */
  importNativeCoreV47?: (request: DesktopNativeCoreImportRequest) => Promise<DesktopNativeCoreImportResult>;
  getNativeCoreStatus: (request: DesktopNativeCoreSessionRequest) => Promise<DesktopNativeCoreSummary>;
  getNativeCoreProjection: (request: DesktopNativeCoreProjectionRequest) => Promise<DesktopNativeCoreProjectionResult>;
  getNativeCoreViewportProjection: (request: DesktopNativeCoreViewportProjectionRequest) => Promise<DesktopNativeCoreViewportProjectionResult>;
  getNativeCoreViewportProjectionV2: (request: DesktopNativeCoreViewportProjectionV2Request) => Promise<DesktopNativeCoreViewportProjectionV2Result>;
  getNativeCoreFactoryReadModel: (request: DesktopNativeCoreFactoryReadModelRequest) => Promise<DesktopNativeCoreFactoryReadModelResult>;
  /** Independently paged active-planet tray and held stack for the native thin UI. */
  getNativeCoreFactoryInventory?: (request: DesktopNativeCoreFactoryInventoryRequest) => Promise<DesktopNativeCoreFactoryInventoryResult>;
  /** Read-only, catalog-identity-bound top-level construction stock for the native thin UI. */
  getNativeCoreConstructionInventory?: (request: DesktopNativeCoreConstructionInventoryRequest) => Promise<DesktopNativeCoreConstructionInventoryResult>;
  /** Paged native blueprint library, one selected compact detail, and construction queue; never a full GameState. */
  getNativeCoreBlueprintWorkspace?: (request: DesktopNativeCoreBlueprintWorkspaceRequest) => Promise<DesktopNativeCoreBlueprintWorkspaceResult>;
  /** Same-revision Rust proof for capturing one ordered ordinary-building selection. */
  getNativeCoreBlueprintCaptureContext?: (request: DesktopNativeCoreBlueprintCaptureContextRequest) => Promise<DesktopNativeCoreBlueprintCaptureContextResult>;
  /** Rust parses one bounded exchange string and returns an opaque prepared import marker. */
  getNativeCoreBlueprintImportContext?: (request: DesktopNativeCoreBlueprintImportContextRequest) => Promise<DesktopNativeCoreBlueprintImportContextResult>;
  /** Rust serializes one exact ordinary blueprint row into a bounded canonical exchange. */
  getNativeCoreBlueprintExportContext?: (request: DesktopNativeCoreBlueprintExportContextRequest) => Promise<DesktopNativeCoreBlueprintExportContextResult>;
  /** Click-time Rust proof for queueing one exact blueprint row at a renderer-supplied finite position. */
  getNativeCoreBlueprintEnqueueContext?: (request: DesktopNativeCoreBlueprintEnqueueContextRequest) => Promise<DesktopNativeCoreBlueprintEnqueueContextResult>;
  /** Click-time Rust proof for directly deploying one exact ordinary blueprint row. */
  getNativeCoreBlueprintDirectDeployContext?: (request: DesktopNativeCoreBlueprintDirectDeployContextRequest) => Promise<DesktopNativeCoreBlueprintDirectDeployContextResult>;
  /** Same-revision Rust-derived ordinary single-building template; the renderer may add only a finite position. */
  getNativeCoreConstructionPlacementContext?: (request: DesktopNativeCoreConstructionPlacementContextRequest) => Promise<DesktopNativeCoreConstructionPlacementContextResult>;
  /** Same-revision Rust-derived exact single ordinary-belt template and construction debit. */
  getNativeCoreConstructionBeltPlacementContext?: (request: DesktopNativeCoreConstructionBeltPlacementContextRequest) => Promise<DesktopNativeCoreConstructionBeltPlacementContextResult>;
  /** Same-revision Rust-derived exact ordinary-belt lane adjustment and material delta. */
  getNativeCoreConstructionBeltLaneContext?: (request: DesktopNativeCoreConstructionBeltLaneContextRequest) => Promise<DesktopNativeCoreConstructionBeltLaneContextResult>;
  /** Same-revision Rust-derived exact single ordinary-belt removal and construction refund. */
  getNativeCoreConstructionBeltRemovalContext?: (request: DesktopNativeCoreConstructionBeltRemovalContextRequest) => Promise<DesktopNativeCoreConstructionBeltRemovalContextResult>;
  /** Same-revision Rust-derived complete ordinary-building recycling eligibility and exact refund. */
  getNativeCoreConstructionRemovalContext?: (request: DesktopNativeCoreConstructionRemovalContextRequest) => Promise<DesktopNativeCoreConstructionRemovalContextResult>;
  /** Same-revision Rust-derived ordinary-building stack target and exact material adjustment. */
  getNativeCoreConstructionStackContext?: (request: DesktopNativeCoreConstructionStackContextRequest) => Promise<DesktopNativeCoreConstructionStackContextResult>;
  getNativeCoreStatisticsProjection: (request: DesktopNativeCoreStatisticsProjectionRequest) => Promise<DesktopNativeCoreStatisticsProjectionResult>;
  getNativeCoreTechnologyProjection: (request: DesktopNativeCoreTechnologyProjectionRequest) => Promise<DesktopNativeCoreTechnologyProjectionResult>;
  /** Current Windows thin-UI host only; older shells fail closed instead of reading the Web GameState. */
  getNativeCoreRecipeWorkspaceProjection?: (request: DesktopNativeCoreRecipeWorkspaceProjectionRequest) => Promise<DesktopNativeCoreRecipeWorkspaceProjectionResult>;
  /** Bounded star-system page tied to one exact native revision and catalog. */
  getNativeCoreStarMapOverviewProjection?: (request: DesktopNativeCoreStarMapOverviewProjectionRequest) => Promise<DesktopNativeCoreStarMapOverviewProjectionResult>;
  /** Complete, independently paged system/planet directory for the native star map. */
  getNativeCoreStarMapCatalogProjection?: (request: DesktopNativeCoreStarMapCatalogProjectionRequest) => Promise<DesktopNativeCoreStarMapCatalogProjectionResult>;
  /** Independently bounded planet/station pages; never falls back to the Web GameState. */
  getNativeCoreStellarIndustryProjection?: (request: DesktopNativeCoreStellarIndustryProjectionRequest) => Promise<DesktopNativeCoreStellarIndustryProjectionResult>;
  /** Adds an independently paged, filtered native route table to the v1 industry model. */
  getNativeCoreStellarIndustryV2Projection?: (request: DesktopNativeCoreStellarIndustryV2ProjectionRequest) => Promise<DesktopNativeCoreStellarIndustryV2ProjectionResult>;
  /** Bounded shared quantum inventory and orbital-collector attachment pages. */
  getNativeCoreStellarQuantumProjection?: (request: DesktopNativeCoreStellarQuantumProjectionRequest) => Promise<DesktopNativeCoreStellarQuantumProjectionResult>;
  /** Read-only Dyson planner pages bound to one native session revision and catalog. */
  getNativeCoreDysonWorkspaceProjection?: (request: DesktopNativeCoreDysonWorkspaceProjectionRequest) => Promise<DesktopNativeCoreDysonWorkspaceProjectionResult>;
  /** Bounded, independently paged system-space-station workspace; never a full GameState. */
  getNativeCoreSystemSpaceStationWorkspaceProjection?: (request: DesktopNativeCoreSystemSpaceStationWorkspaceProjectionRequest) => Promise<DesktopNativeCoreSystemSpaceStationWorkspaceProjectionResult>;
  /** Intent-only durable player-authority mutation; session/run/owner/patch stay main/Rust-owned. */
  commitNativeSystemSpaceStationIntent?: (request: DesktopNativeSystemSpaceStationIntentRequest) => Promise<DesktopNativeCoreCommandResult>;
  /** Bounded Rust-owned orbital contract board; never exposes a GameState or inventory map. */
  getNativeCoreOrbitalContractWorkspaceProjection?: (request: DesktopNativeCoreOrbitalContractWorkspaceProjectionRequest) => Promise<DesktopNativeCoreOrbitalContractWorkspaceProjectionResult>;
  /** Fixed-catalog campaign progress only; navigation locators cannot mutate the game. */
  getNativeCoreCampaignWorkspaceProjection?: (request: DesktopNativeCoreCampaignWorkspaceProjectionRequest) => Promise<DesktopNativeCoreCampaignWorkspaceProjectionResult>;
  getNativeCoreOperationsWorkspaceProjection?: (request: DesktopNativeCoreOperationsWorkspaceProjectionRequest) => Promise<DesktopNativeCoreOperationsWorkspaceProjectionResult>;
  /** Game-only Galaxy summary; renderer-owned account data stays outside this projection. */
  getNativeCoreGalaxyAccountWorkspaceProjection?: (request: DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest) => Promise<DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult>;
  /** Intent-only durable contract mutation; reward/material totals stay Rust-owned. */
  commitNativeOrbitalContractIntent?: (request: DesktopNativeOrbitalContractIntentRequest) => Promise<DesktopNativeCoreCommandResult>;
  commitNativeOperationsSettingIntent?: (request: DesktopNativeOperationsSettingIntentRequest) => Promise<DesktopNativeCoreCommandResult>;
  /** Current Windows thin-UI host only; native authority never falls back to a renderer entity scan. */
  getNativeCoreCommandPaletteEntitySearch?: (request: DesktopNativeCoreCommandPaletteEntitySearchRequest) => Promise<DesktopNativeCoreCommandPaletteEntitySearchResult>;
  requestNativeCoreProjectionTransfer?: (request: DesktopNativeCoreProjectionTransferRequest) => Promise<DesktopNativeCoreProjectionTransferResult>;
  /** Persistent, ACK-gated thin projection stream. Closing releases every queued frame in preload/main. */
  subscribeNativeCoreProjection?: (
    request: DesktopNativeCoreProjectionSubscriptionRequest,
    listener: (event: DesktopNativeCoreProjectionSubscriptionEvent) =>
      void | boolean | Promise<void | boolean>,
  ) => DesktopNativeCoreProjectionSubscriptionHandle;
  applyNativeCoreCommand: (request: DesktopNativeCoreCommandRequest) => Promise<DesktopNativeCoreCommandResult>;
  /** Read-only lookup after a dispatched command lost its renderer response. */
  reconcileNativeCoreCommand?: (request: DesktopNativeCoreCommandRequest) => Promise<DesktopNativeCoreCommandReconciliationResult>;
  /** Session-only reversible command journal; it is intentionally truncated at restart/import. */
  getNativePlayerAuthorityHistoryStatus?: (
    request: DesktopNativePlayerAuthorityHistoryStatusRequest,
  ) => Promise<DesktopNativePlayerAuthorityHistoryStatus>;
  commitNativePlayerAuthorityHistory?: (
    request: DesktopNativePlayerAuthorityHistoryCommitRequest,
  ) => Promise<DesktopNativePlayerAuthorityHistoryCommitResult>;
  advanceNativeCore: (request: DesktopNativeCoreAdvanceRequest) => Promise<DesktopNativeCoreAdvanceResult>;
  commitNativeCoreOperation: (request: DesktopNativeCoreCommitOperationRequest) => Promise<DesktopNativeCoreCommitOperationResult>;
  checkpointNativeCore: (request: DesktopNativeCoreCheckpointRequest) => Promise<DesktopNativeCoreCheckpointResult>;
  exportNativeCoreV47: (request: DesktopNativeCoreExportRequest) => Promise<DesktopNativeCoreExportResult>;
  compareNativeCore: (request: DesktopNativeCoreCompareRequest) => Promise<DesktopNativeCoreCompareResult>;
  closeNativeCore: (request: DesktopNativeCoreSessionRequest) => Promise<{ closed: boolean }>;
  requestApi: (request: DesktopApiRequest) => Promise<DesktopApiResponse>;
  requestApiTransfer: (request: DesktopApiTransferRequest, body: ArrayBuffer) => Promise<DesktopApiTransferResponse>;
  cancelApiRequest: (requestId: string) => void;
  downloadAccountArchive: (request: DesktopAccountArchiveDownloadRequest) => Promise<DesktopAccountArchiveDownloadResult>;
  cancelAccountArchiveDownload: (requestId: string) => void;
  checkForUpdates: () => Promise<DesktopUpdateStatus>;
  downloadUpdate: () => Promise<DesktopUpdateStatus>;
  installUpdate: () => Promise<{ accepted: boolean }>;
  confirmUpdateReady: () => Promise<void>;
  onPrepareForUpdate: (listener: () => void) => () => void;
  onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => () => void;
}

export interface DesktopNativePerformanceStatus {
  available: boolean;
  state: "starting" | "ready" | "unavailable" | "unsupported";
  message: string;
  /** Stable renderer-safe code only; older rollback hosts may omit it. */
  errorCode?: string | null;
  protocolVersion?: number;
  nativeFormatVersion?: number;
  hostVersion?: string;
  capabilities: string[];
  /** Present in desktop hosts with the trusted thread-policy bridge; older test/rollback hosts may omit it. */
  performancePolicy?: DesktopNativePerformancePolicyStatus;
}

export interface DesktopShellRuntimePolicy {
  schemaVersion: 1;
  hardwareAcceleration: {
    mode: "chromium-default" | "disabled-experimental";
    experimentalDisableRequested: boolean;
    configurationState: "default" | "experimental-opt-in" | "invalid-ignored";
  };
  v8Heap: { mode: "chromium-managed"; overrideApplied: false };
  processPriority: { mode: "os-default"; mutationApplied: false };
  chromiumCommandLine: { highRiskSwitchesApplied: false };
}

export interface DesktopRuntimeDiagnostics {
  schemaVersion: 1;
  sampledAtMs: number;
  runtime: {
    platform: string;
    architecture: string;
    electronVersion: string | null;
    chromeVersion: string | null;
    nodeVersion: string | null;
  };
  policy: DesktopShellRuntimePolicy;
  gpu: {
    featureStatus: Record<string, string>;
    devices: Array<{
      active?: boolean;
      vendorId?: number | string;
      deviceId?: number | string;
      driverVendor?: string;
      driverVersion?: string;
    }>;
    deviceListTruncated: boolean;
  };
  processTree: {
    scope: "electron-app-metrics";
    reportedProcessCount: number;
    scannedProcessCount: number;
    validProcessCount: number;
    includedProcessCount: number;
    truncated: boolean;
    totalsComplete: boolean;
    totalsKib: {
      workingSet: number;
      peakWorkingSet: number;
      privateBytes: number;
    };
    processes: DesktopRuntimeProcessMetric[];
  };
  nativeHost: {
    state: "running" | "not-running";
    pid?: number;
    /** Electron's getAppMetrics does not include this separately spawned process. */
    includedInElectronProcessTree: false;
  };
  memory: {
    systemKib: {
      totalKib?: number;
      freeKib?: number;
      swapTotalKib?: number;
      swapFreeKib?: number;
    } | null;
    mainProcessKib: {
      privateKib?: number;
      residentSetKib?: number;
      sharedKib?: number;
    } | null;
    mainNodeBytes: {
      rssBytes?: number;
      heapTotalBytes?: number;
      heapUsedBytes?: number;
      externalBytes?: number;
      arrayBuffersBytes?: number;
    } | null;
    mainV8Bytes: {
      heapSizeLimitBytes?: number;
      totalHeapSizeBytes?: number;
      usedHeapSizeBytes?: number;
      externalMemoryBytes?: number;
    } | null;
  };
  mainProcess: {
    pid?: number;
    priority: number | null;
    uptimeSeconds: number | null;
    cpu: { userMicros: number; systemMicros: number } | null;
  };
  unavailable: Array<
    | "gpuFeatureStatus"
    | "gpuInfo"
    | "electronProcessMetrics"
    | "systemMemory"
    | "mainProcessMemory"
    | "nodeMemory"
    | "nodeCpu"
    | "v8Heap"
  >;
}

export interface DesktopRuntimeProcessMetric {
  pid: number;
  type: string;
  priority: number | null;
  name?: string;
  serviceName?: string;
  creationTimeMs?: number;
  sandboxed?: boolean;
  integrityLevel?: "untrusted" | "low" | "medium" | "high" | "unknown";
  memoryKib?: {
    workingSetKib?: number;
    peakWorkingSetKib?: number;
    privateBytesKib?: number;
  };
  cpu?: {
    percent: number;
    idleWakeupsPerSecond: number;
    cumulativeSeconds?: number;
  };
}

export interface DesktopNativeProjectionSubscriptionDiagnostics {
  readonly schemaVersion: 1;
  readonly activeSubscriptions: number;
  readonly retainedClosedSubscriptions: number;
  readonly acknowledgedFrames: number;
  readonly deliveredFrames: number;
  readonly coalescedFrames: number;
  readonly queuedFrames: number;
  readonly channels: ReadonlyArray<{
    readonly channel: DesktopNativeCoreProjectionSubscriptionChannel;
    readonly subscriptions: number;
    readonly deliveredFrames: number;
    readonly acknowledgedFrames: number;
    readonly coalescedFrames: number;
    readonly maximumQueuedFrames: number;
    readonly readP95Ms: number;
    readonly encodeP95Ms: number;
    readonly validationP95Ms: number;
    readonly installP95Ms: number;
  }>;
  readonly gateC: {
    readonly frameBudgetMs: number;
    readonly maximumRatio: 0.2;
    readonly transportP95Ms: number;
    readonly frameBudgetRatio: number;
    readonly decision:
      | "insufficient-samples"
      | "bounded-message-port-retained"
      | "shared-memory-evaluation-required";
  };
}

export type DesktopNativePerformanceMode = "quiet" | "balanced" | "performance" | "custom";
export type DesktopNativeCoreThreadSetting = "auto" | 1 | 2 | 4 | 8;

export type DesktopNativePerformancePolicy =
  | { mode: Exclude<DesktopNativePerformanceMode, "custom"> }
  | { mode: "custom"; customThreads: DesktopNativeCoreThreadSetting };

export interface DesktopNativePerformancePolicyStatus {
  schemaVersion: 1;
  requestedPolicy: DesktopNativePerformancePolicy;
  effectivePolicy: {
    mode: DesktopNativePerformanceMode;
    threadSetting: DesktopNativeCoreThreadSetting;
  };
  logicalCpuCount: number;
  /** The native host is never killed in place; a changed thread setting applies on the next app launch. */
  restartRequired: boolean;
  configurationState: "default" | "loaded" | "invalid" | "saved";
}

export interface DesktopNativeSaveBeginRequest {
  slot: "normal-main" | "speedrun-main";
  mode: "normal" | "speedrun";
  stateVersion: 47;
  baseChecksum: string;
  registryFingerprint: string;
  revision: number;
  savedAtMs: number;
}

export interface DesktopNativeSaveBeginResult {
  transactionId: string;
  previousGeneration?: number;
  previousRevision?: number;
}

export interface DesktopNativeSaveWriteRequest {
  transactionId: string;
  records: Array<{ key: string; value: string | null }>;
}

export interface DesktopNativeSaveTransactionRequest {
  transactionId: string;
}

export interface DesktopNativeSaveSlotRequest {
  slot: "normal-main" | "speedrun-main";
}

export interface DesktopNativeSaveCommitResult {
  slot: string;
  generation: number;
  revision: number;
  rootHash: string;
  recordCount: number;
  changedRecords: number;
  changedBytes: number;
  totalUncompressedBytes: number;
  walMaintenancePending?: boolean;
  walBytes?: number;
}

export interface DesktopNativeSaveRecoveryResult {
  slot: string;
  generation: number;
  revision: number;
  rootHash: string;
  stateVersion: number;
  mode: "normal" | "speedrun";
  baseChecksum: string;
  registryFingerprint: string;
  savedAtMs: number;
  recordKeys: string[];
  walFirstRevision?: number;
  walLastRevision?: number;
  walEntryCount: number;
}

export interface DesktopNativeSaveReadRequest extends DesktopNativeSaveSlotRequest {
  key: string;
  generation: number;
  rootHash: string;
}

export interface DesktopNativeSaveReadResult extends DesktopNativeSaveReadRequest {
  value: string | null;
}

export interface DesktopNativeWalAppendRequest extends DesktopNativeSaveSlotRequest {
  baseRevision: number;
  revision: number;
  commandId: string;
  payload: Record<string, unknown>;
}

export interface DesktopNativeWalAppendResult {
  revision: number;
  entryHash: string;
  walBytes: number;
  duplicate?: boolean;
}

export interface DesktopNativeCoreItemDefinition {
  id: string;
  name: string;
  kind: "solid" | "fluid" | "matrix";
  fuelEnergyMj: number;
}

export interface DesktopNativeCoreBuildingDefinition {
  id: string;
  name?: string;
  shortName?: string;
  description?: string;
  kind: string;
  speed: number;
  inputCapacity: number;
  outputCapacity: number;
  powerDemandKw: number;
  powerGenerationKw: number;
  powerChargeKw: number;
  energyCapacityMj: number;
  fuelItemIds: string[];
  fuelEfficiency: number;
  family?: string;
  accepts?: "solid" | "fluid" | "any";
  /** Present on current clients so Rust can distinguish unbounded from omitted. */
  stackLimit?: number | null;
  stackLimitComplete?: boolean;
  requiredTechId?: string;
  upgradeTargetId?: string;
  megastructure?: boolean;
  unique?: boolean;
  layoutWidth?: number;
  layoutHeight?: number;
  layoutClearance?: number;
  ports?: Array<{
    index: number;
    direction: "input" | "output" | "bidirectional";
    accepts: "solid" | "fluid" | "matrix" | "any";
    maxConnections?: number;
    special?: string;
  }>;
  capabilities?: string[];
  scripted?: boolean;
}

export interface DesktopNativeCoreRecipeDefinition {
  id: string;
  name: string;
  buildingId: string;
  duration: number;
  requiredTechId?: string;
  recursivePriority: number;
  recursiveManufacturing: boolean;
  inputs: Array<{ itemId: string; amount: number }>;
  outputs: Array<{ itemId: string; amount: number }>;
}

export interface DesktopNativeCoreConstructionDefinition {
  id: string;
  outputAmount: number;
  automationOrder: number;
  requiredTechId?: string;
  costs: Array<{ itemId: string; amount: number }>;
}

export interface DesktopNativeCorePlanetDefinition {
  id: string;
  name: string;
  systemId: string;
  kind: "terrestrial" | "gas-giant";
  orbitIndex: number;
  /** Stable PLANET_LIST position used for JavaScript-equivalent float folds. */
  simulationOrder: number;
  orbitalYields: Record<string, number>;
}

export interface DesktopNativeCoreStarSystemDefinition {
  id: string;
  name: string;
  planetIds: string[];
  explorationCost: Array<{ itemId: string; amount: number }>;
  requiredTechId?: string;
  prerequisiteSystemId?: string;
}

export interface DesktopNativeCoreCatalog {
  protocolVersion: 1;
  registryFingerprint: string;
  planets: DesktopNativeCorePlanetDefinition[];
  /** Transient command directory; it is not a GameState or cloud-schema field. */
  /** Transient desktop semantic directory; older hosts may omit it. */
  starSystems?: DesktopNativeCoreStarSystemDefinition[];
  items: DesktopNativeCoreItemDefinition[];
  buildings: DesktopNativeCoreBuildingDefinition[];
  recipes: DesktopNativeCoreRecipeDefinition[];
  constructions: DesktopNativeCoreConstructionDefinition[];
  belts: Array<{ tier: number; speed: number; id?: string; name?: string; constructionId?: string }>;
  proliferators: Array<{
    tier: number;
    itemId: string;
    sprayPoints: number;
    extraProductBonus: number;
    speedBonus: number;
    powerMultiplier: number;
    requiredTechId: string;
  }>;
  technologies: Array<{
    id: string;
    name: string;
    costs: Array<{ itemId: string; amount: number }>;
    prerequisites: string[];
    constructionRewards: string[];
  }>;
}

export interface DesktopNativeCoreOpenRequest extends DesktopNativeSaveSlotRequest {
  generation: number;
  rootHash: string;
  revision: number;
  registryFingerprint: string;
  catalog: DesktopNativeCoreCatalog;
}

export interface DesktopNativeCoreImportRequest {
  registryFingerprint: string;
  catalog: DesktopNativeCoreCatalog;
}

export interface DesktopNativeCoreDomainCoverage {
  stateContainer: boolean;
  commandPatches: boolean;
  quiescentClock: boolean;
  infiniteSolidMining: boolean;
  finiteSolidMining: boolean;
  fluidMining: boolean;
  windPower: boolean;
  renewablePower: boolean;
  fuelPower: boolean;
  energyStorage: boolean;
  powerPriorities: boolean;
  ordinaryProduction: boolean;
  proliferatedProduction: boolean;
  finiteResearch: boolean;
  infiniteResearch: boolean;
  ordinaryBelts: boolean;
  storageAndSplitters: boolean;
  planetaryLogistics: boolean;
  sameSystemInterstellarLogistics: boolean;
  directWarpLogistics: boolean;
  relayLogistics: boolean;
  orbitalCollectors: boolean;
  stationWarperAutoRefill: boolean;
  quantumLogisticsNetwork: boolean;
  quantumLocalDroneBridge: boolean;
  quantumBeltBridge: boolean;
  persistedConstructionJobs: boolean;
  constructionQuantumPrefetch: boolean;
  recursiveConstructionPlanning: boolean;
  portableFleetConstruction: boolean;
  constructionByproductSettlement: boolean;
  constructionArithmeticBatching: boolean;
  quantumAttachmentTransitions: boolean;
  inactiveTimeWarpController: boolean;
  activeTimeWarpPower: boolean;
  unifiedAdvanceBudgets: boolean;
  dysonSwarmAndSphere: boolean;
  dysonLaunchers: boolean;
  dysonRayReceivers: boolean;
  orbitalCargoTerminals: boolean;
  stationContractRefresh: boolean;
  systemSpaceStationConstruction: boolean;
  systemHubLogistics: boolean;
  elevatorBelts: boolean;
  stationModeTransitions: boolean;
  campaignProgress: boolean;
  handcraftQueue: boolean;
  explorationMissions: boolean;
  galacticExports: boolean;
  speedrunClockAndMilestones: boolean;
  exactSegmentedOffline: boolean;
  pureIdleMacro: boolean;
  mining: boolean;
  production: boolean;
  research: boolean;
  belts: boolean;
  logistics: boolean;
  power: boolean;
  dyson: boolean;
  construction: boolean;
  spaceStation: boolean;
  offlineAndTimeWarp: boolean;
  contentPacks: boolean;
  authorityEligible: boolean;
}

export interface DesktopNativeCoreSummary {
  revision: number;
  stateVersion: number;
  mode: "normal" | "speedrun";
  activePlanetId: string;
  elapsedSeconds: number;
  paused: boolean;
  entityCount: number;
  beltCount: number;
  canonicalSha256: string;
  canonicalComponents: Record<"base" | "entities" | "belts", string>;
  canonicalFields: Record<string, string>;
  domainSha256: string;
  catalogSha256: string;
  registryFingerprint: string;
  memory: {
    rawRecordBytes: number;
    indexedStringBytes: number;
    inventoryEntryCount: number;
    topologyIndexBytes: number;
    estimatedRuntimeBytes: number;
  };
  coverage: DesktopNativeCoreDomainCoverage;
}

export interface DesktopNativeCoreOpenResult {
  sessionId: string;
  authority: "shadow";
  checkpointRevision: number;
  replayedWalEntries: number;
  replayedRevision: number;
  summary: DesktopNativeCoreSummary;
}

export interface DesktopNativeCoreImportProof {
  formatVersion: 2;
  stateVersion: 47;
  kind: "primary" | "slot" | "snapshot";
  envelopeSlot: "main" | "1" | "2" | "3";
  mode: "normal" | "speedrun";
  savedAtMs: number;
  stateChecksum: string;
  sourceSha256: string;
  sourceByteLength: number;
  entityCount: number;
  beltCount: number;
}

export type DesktopNativeCoreImportResult =
  | { cancelled: true }
  | ({
    cancelled: false;
    committed: true;
    fileName: string;
    authority: "shadow";
    checkpoint: DesktopNativeSaveCommitResult;
    import: DesktopNativeCoreImportProof;
    summary: DesktopNativeCoreSummary;
  } & (
    | {
      ownerClosed: false;
      sessionClosed: false;
      sessionId: string;
    }
    | {
      ownerClosed: true;
      sessionClosed: boolean;
      sessionId: null;
    }
  ));

export interface DesktopNativeCoreSessionRequest {
  sessionId: string;
}

export interface DesktopNativeCoreCommandRequest extends DesktopNativeCoreSessionRequest {
  command: Record<string, unknown>;
}

export interface DesktopNativeCoreProjectionRequest extends DesktopNativeCoreSessionRequest {
  baseFields: string[];
  entityIds: string[];
  beltIds: string[];
}

export interface DesktopNativeCoreProjectionResult {
  revision: number;
  base: Record<string, unknown>;
  entities: DesktopNativeCoreEntityProjection[];
  belts: DesktopNativeCoreBeltProjection[];
}

export type DesktopNativeCoreEntityProjection = { id: string } & Partial<Omit<FactoryEntity, "id">>;
export type DesktopNativeCoreBeltProjection = { id: string } & Partial<Omit<BeltConnection, "id">>;

export interface DesktopNativeCoreViewportProjectionRequest extends DesktopNativeCoreSessionRequest {
  baseFields?: string[];
  planetId: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  entityCursor?: number;
  entityLimit: number;
  beltLimit: number;
}

export interface DesktopNativeCoreViewportProjectionResult {
  schemaVersion: 1;
  projectionType: "viewport-v1";
  revision: number;
  planetId: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  base: Record<string, unknown>;
  entities: DesktopNativeCoreEntityProjection[];
  belts: DesktopNativeCoreBeltProjection[];
  nextEntityCursor: number | null;
  truncatedBelts: boolean;
}

export interface DesktopNativeCoreViewportProjectionV2Request extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  /** Opt-in projection-only Rust semantics for the exact returned entity page. */
  entityPresentationVersion?: 1;
  baseFields?: string[];
  planetId: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  entityCursor?: number;
  entityLimit: number;
  beltCursor?: number;
  beltLimit: number;
  pinnedEntityIds?: string[];
  pinnedBeltIds?: string[];
}

export interface DesktopNativeCoreViewportProjectionV2Result {
  schemaVersion: 2;
  projectionType: "viewport-v2";
  revision: number;
  planetId: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  base: Record<string, unknown>;
  entities: DesktopNativeCoreEntityProjection[];
  /** Present iff entityPresentationVersion=1 was requested and accepted. */
  entityPresentationVersion?: 1;
  /** Same order and cardinality as entities; never merged into FactoryEntity. */
  entityPresentation?: FactoryNodePresentationReadModel[];
  belts: DesktopNativeCoreBeltProjection[];
  pinnedEntityIds: string[];
  pinnedBeltIds: string[];
  nextEntityCursor: number | null;
  nextBeltCursor: number | null;
  planetTotals: { entities: number; belts: number };
  viewportTotals: { entities: number; belts: number };
  worldBounds: { minX: number; minY: number; maxX: number; maxY: number };
  minimap: {
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
    entityCount: number;
    beltCount: number;
    occupiedCellCount: number;
    cellSize: number;
  };
  broadQueryFallback: boolean;
}

export interface DesktopNativeCoreFactoryReadModelRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  selectedEntityIds?: string[];
  selectedBeltIds?: string[];
}

export interface DesktopNativeCoreFactoryReadModelResult extends FactoryReadModelBundle {
  schemaVersion: 1;
  projectionType: "factory-read-model-v1";
  revision: number;
}

export interface DesktopNativeCoreFactoryInventoryRequest extends DesktopNativeCoreSessionRequest {
  /** Present only for a main-owned player-authority read; shadow reads omit it. */
  runId?: string;
  expectedRevision: number;
  /** Present together with runId so main can fence the registry owner epoch. */
  expectedRegistryFingerprint?: string;
  cursor: number;
  limit: number;
}

export type DesktopNativeCoreFactoryInventoryCargoOrigin = {
  kind: "node-output" | "node-input" | "tray";
  id: string | null;
};

export type DesktopNativeCoreFactoryInventoryCargo = {
  itemId: string;
  amount: number;
  origin: DesktopNativeCoreFactoryInventoryCargoOrigin | null;
};

export interface DesktopNativeCoreFactoryInventoryRow {
  itemId: string;
  amount: number;
  freeCapacity: number;
  overLimit: boolean;
}

export interface DesktopNativeCoreFactoryInventoryResult {
  schemaVersion: 1;
  projectionType: "factory-inventory-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  activePlanetId: string;
  cargo: DesktopNativeCoreFactoryInventoryCargo | null;
  pickupTargetAmount: 100;
  portableFleet: {
    logistics_drone: number;
    logistics_vessel: number;
  };
  productionBufferLimit: number;
  trayItemLimit: number;
  trayItemLimitBounds: {
    minimum: 1000;
    default: 1000000;
    maximum: 100000000;
  };
  request: {
    expectedRevision: number;
    cursor: number;
    limit: number;
  };
  totalCount: number;
  rows: DesktopNativeCoreFactoryInventoryRow[];
  nextCursor: number | null;
  truncated: boolean;
  limits: {
    rows: 256;
    projectionBytes: 1048576;
  };
}

export interface DesktopNativeCoreConstructionInventoryRequest extends DesktopNativeCoreSessionRequest {
  /** Present only for a main-owned player-authority read; shadow reads omit it. */
  runId?: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  cursor: number;
  limit: number;
}

export interface DesktopNativeCoreConstructionInventoryRow {
  buildingId: string;
  amount: number;
}

export interface DesktopNativeCoreConstructionInventoryResult {
  schemaVersion: 1;
  projectionType: "construction-inventory-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  readOnly: true;
  request: {
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    cursor: number;
    limit: number;
  };
  totalCount: number;
  rows: DesktopNativeCoreConstructionInventoryRow[];
  nextCursor: number | null;
  truncated: boolean;
  limits: {
    rows: 256;
    projectionBytes: 1048576;
  };
}

export type DesktopNativeCoreBlueprintWorkspaceSection =
  | "library"
  | "detail"
  | "queue"
  | "queue-membership"
  | "library-membership";

export interface DesktopNativeCoreBlueprintWorkspaceRequest extends DesktopNativeCoreSessionRequest {
  /** Present only for a main-owned player-authority read; shadow reads omit it. */
  runId?: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  section: DesktopNativeCoreBlueprintWorkspaceSection;
  blueprintId: string | null;
  queueEntryId: string | null;
  cursor: number;
  limit: 32;
}

export interface DesktopNativeCoreBlueprintCounts {
  entities: number;
  belts: number;
  resourceAnchors: number;
  externalPorts: number;
}

export interface DesktopNativeCoreBlueprintSummary {
  id: string;
  name: string;
  revision: number;
  rotation: 0 | 90 | 180 | 270;
  mirror: "none" | "horizontal";
  counts: DesktopNativeCoreBlueprintCounts;
  detailStatus: "candidate" | "truncated";
}

export interface DesktopNativeCoreBlueprintDetailEntity {
  key: string;
  buildingId: string;
  /** Native catalog display value; currently falls back to the catalog building ID. */
  buildingLabel: string;
  offset: { x: number; y: number };
  machineCount: number;
  recipeId: string | null;
  operationEnabledOnDeploy: boolean | null;
}

export interface DesktopNativeCoreBlueprintDetailBelt {
  key: string;
  sourceKey: string;
  targetKey: string;
  itemId: string;
  lanes: number;
  tier: number;
}

export interface DesktopNativeCoreBlueprintDetailAnchor {
  key: string;
  resourceId: string;
  extractorBuildingId: string;
  offset: { x: number; y: number };
  minerCount: number;
}

export interface DesktopNativeCoreBlueprintDetailPort {
  key: string;
  entityKey: string;
  direction: "input" | "output";
  itemId: string;
  offset: { x: number; y: number };
}

export interface DesktopNativeCoreBlueprintRecipeOption {
  id: string;
  name: string;
}

/**
 * Rust-derived target-state recipe group for one source recipe present in the
 * selected blueprint. The renderer may choose only one listed target; Rust
 * revalidates the complete template and catalog again at command time.
 */
export interface DesktopNativeCoreBlueprintRecipeOverrideGroup {
  sourceRecipeId: string;
  targetRecipeId: string;
  options: DesktopNativeCoreBlueprintRecipeOption[];
}

export interface DesktopNativeCoreBlueprintDetail {
  summary: DesktopNativeCoreBlueprintSummary;
  status: "supported" | "truncated" | "unsupported";
  unsupportedReason: "detail-limits-exceeded" | "projection-byte-budget-exceeded" | "unproven-catalog-semantics" | null;
  entities: DesktopNativeCoreBlueprintDetailEntity[];
  belts: DesktopNativeCoreBlueprintDetailBelt[];
  resourceAnchors: DesktopNativeCoreBlueprintDetailAnchor[];
  externalPorts: DesktopNativeCoreBlueprintDetailPort[];
  recipeOverrideGroups: DesktopNativeCoreBlueprintRecipeOverrideGroup[];
}

export interface DesktopNativeCoreBlueprintQueueRow {
  id: string;
  blueprintId: string;
  blueprintVersionId: string | null;
  blueprintRevision: number;
  blueprintName: string;
  planetId: string;
  planetName: string | null;
  position: { x: number; y: number };
  rotation: 0 | 90 | 180 | 270;
  mirror: "none" | "horizontal";
  queuedAt: number;
  status: "pending-materials" | "waiting-fleet";
  counts: DesktopNativeCoreBlueprintCounts | null;
  semanticStatus: "catalog-backed" | "truncated" | "unsupported";
  reservedConstructionTotal: number;
  reservedFleetTotal: number;
  placedEntityCount: number;
  /** Rust-only deployment readiness; renderer must never derive this value. */
  actionable: boolean;
}

/** Minimal same-revision global membership proof row; no mutable queue payload crosses IPC. */
export interface DesktopNativeCoreBlueprintQueueMembershipRow {
  id: string;
}

/** Minimal same-revision whole-library membership proof row. */
export type DesktopNativeCoreBlueprintLibraryMembershipRow =
  DesktopNativeCoreBlueprintQueueMembershipRow;

export interface DesktopNativeCoreBlueprintWorkspaceResult {
  schemaVersion: 1;
  projectionType: "blueprint-workspace-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  readOnly: true;
  request: Omit<DesktopNativeCoreBlueprintWorkspaceRequest, "sessionId">;
  counts: { library: number; queue: number };
  page: {
    cursor: number;
    limit: 32;
    totalCount: number;
    rows: Array<DesktopNativeCoreBlueprintSummary | DesktopNativeCoreBlueprintDetail |
      DesktopNativeCoreBlueprintQueueRow | DesktopNativeCoreBlueprintQueueMembershipRow>;
    nextCursor: number | null;
    truncated: boolean;
  };
  limits: {
    pageRows: 32;
    sourceRows: 4096;
    detailEntities: 512;
    detailBelts: 1024;
    detailResourceAnchors: 256;
    detailExternalPorts: 256;
    projectionBytes: 1048576;
    opaqueIdBytes: 512;
    nameBytes: 256;
  };
}

export interface DesktopNativeCoreBlueprintCaptureContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  /** Stable native selection order; no entity body may cross this boundary. */
  entityIds: string[];
}

export type DesktopNativeCoreBlueprintCaptureUnsupportedReason =
  | "selection-conflict"
  | "unsupported-active-planet"
  | "unsupported-blueprint-domain"
  | "catalog-incomplete"
  | "position-overlap"
  | "library-full"
  | "next-id-exhausted";

export interface DesktopNativeCoreBlueprintCaptureContextResult {
  schemaVersion: 1;
  projectionType: "blueprint-capture-context-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: Omit<DesktopNativeCoreBlueprintCaptureContextRequest, "sessionId">;
  activePlanetId: string;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreBlueprintCaptureUnsupportedReason | null;
  };
  expectedBlueprintId: string | null;
  expectedBlueprintName: string | null;
  expectedBlueprintRevision: 1 | null;
  limits: {
    selectionEntityIds: 512;
    blueprintEntities: 512;
    blueprintBelts: 1024;
    opaqueIdBytes: 512;
    projectionBytes: 1048576;
  };
}

export interface DesktopNativeCoreBlueprintImportContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  /** Bounded UTF-8 exchange source; the desktop bridge never parses it. */
  raw: string;
}

export type DesktopNativeCoreBlueprintImportUnsupportedReason =
  | "invalid-exchange"
  | "unsupported-active-planet"
  | "unsupported-blueprint-domain"
  | "catalog-incomplete"
  | "position-overlap"
  | "library-full"
  | "next-id-exhausted"
  | "serialized-budget-exceeded";

export interface DesktopNativeCoreBlueprintImportPreparedIntent {
  kind: "import";
  sourceName: string;
  blueprint: Record<string, unknown>;
  blueprintSha256: string;
  revision: number;
}

export interface DesktopNativeCoreBlueprintImportContextResult {
  schemaVersion: 1;
  projectionType: "blueprint-import-context-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: {
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    rawBytes: number;
    rawSha256: string;
  };
  activePlanetId: string;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreBlueprintImportUnsupportedReason | null;
  };
  preparedIntent: DesktopNativeCoreBlueprintImportPreparedIntent | null;
  limits: {
    rawBytes: 1048576;
    projectionBytes: 1048576;
    commandBytes: 1048576;
    libraryRows: 64;
    blueprintEntities: 512;
    blueprintBelts: 1024;
  };
}

export interface DesktopNativeCoreBlueprintExportContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  blueprintId: string;
  blueprintRevision: number;
}

export type DesktopNativeCoreBlueprintExportUnsupportedReason =
  | "version-conflict"
  | "unsupported-active-planet"
  | "unsupported-blueprint-domain"
  | "catalog-incomplete"
  | "position-overlap"
  | "serialized-budget-exceeded";

export interface DesktopNativeCoreBlueprintExportContextResult {
  schemaVersion: 1;
  projectionType: "blueprint-export-context-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: Omit<DesktopNativeCoreBlueprintExportContextRequest, "sessionId">;
  activePlanetId: string;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreBlueprintExportUnsupportedReason | null;
  };
  rawExchange: string | null;
  rawBytes: number | null;
  rawSha256: string | null;
  blueprintName: string | null;
  fileNameStem: string | null;
  limits: {
    exchangeBytes: 1048576;
    projectionBytes: 1048576;
    blueprintEntities: 512;
    blueprintBelts: 1024;
  };
}

export interface DesktopNativeCoreBlueprintEnqueueContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  blueprintId: string;
  blueprintRevision: number;
}

export type DesktopNativeCoreBlueprintEnqueueUnsupportedReason =
  | "queue-full"
  | "next-id-exhausted"
  | "queue-id-collision"
  | "unsupported-blueprint-domain"
  | "unsupported-active-planet"
  | "unsupported-existing-queue-domain"
  | "version-conflict";

export interface DesktopNativeCoreBlueprintEnqueueContextResult {
  schemaVersion: 1;
  projectionType: "blueprint-enqueue-context-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: Omit<DesktopNativeCoreBlueprintEnqueueContextRequest, "sessionId">;
  activePlanetId: string;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreBlueprintEnqueueUnsupportedReason | null;
  };
  expectedQueueId: string | null;
  limits: {
    projectionBytes: 1048576;
  };
}

export interface DesktopNativeCoreBlueprintDirectDeployContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  blueprintId: string;
  blueprintRevision: number;
  position: { x: number; y: number };
}

export type DesktopNativeCoreBlueprintDirectDeployUnsupportedReason =
  | "next-id-exhausted"
  | "unsupported-blueprint-domain"
  | "unsupported-active-planet"
  | "insufficient-construction-materials"
  | "position-overlap"
  | "version-conflict"
  | "catalog-incomplete";

export interface DesktopNativeCoreBlueprintDirectDeployContextResult {
  schemaVersion: 1;
  projectionType: "blueprint-direct-deploy-context-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: Omit<DesktopNativeCoreBlueprintDirectDeployContextRequest, "sessionId">;
  activePlanetId: string;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreBlueprintDirectDeployUnsupportedReason | null;
  };
  limits: {
    projectionBytes: 1048576;
  };
}

export interface DesktopNativeCoreConstructionPlacementContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  buildingId: string;
}

export type DesktopNativeCoreConstructionPlacementUnsupportedReason =
  | "unknown-building"
  | "missing-construction-definition"
  | "technology-locked"
  | "unsupported-building-kind"
  | "unsupported-building-domain"
  | "unsupported-active-planet"
  | "inventory-empty"
  | "next-id-exhausted";

export interface DesktopNativeCoreConstructionPlacementContextResult {
  schemaVersion: 1;
  projectionType: "construction-placement-context-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: {
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    buildingId: string;
  };
  activePlanetId: string;
  available: number;
  appendEntityIndex: number;
  nextEntityId: string;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreConstructionPlacementUnsupportedReason | null;
  };
  placement: null | {
    remainingConstruction: number;
    nextIdAfterPlacement: number;
    entityTemplate: Record<string, unknown>;
  };
  limits: {
    projectionBytes: 1048576;
  };
}

export interface DesktopNativeCoreConstructionBeltPlacementContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  sourceId: string;
  targetId: string;
  itemId: string;
  tier: number;
  lanes: number;
}

export type DesktopNativeCoreConstructionBeltPlacementUnsupportedReason =
  | "unsupported-active-planet"
  | "invalid-lanes"
  | "unsupported-belt-tier"
  | "missing-construction-definition"
  | "technology-locked"
  | "unknown-item"
  | "insufficient-inventory"
  | "same-endpoint"
  | "source-not-found"
  | "target-not-found"
  | "not-active-planet"
  | "interaction-locked"
  | "unsupported-source-domain"
  | "unsupported-target-domain"
  | "source-not-configured"
  | "target-not-configured"
  | "matching-route-exists"
  | "next-id-exhausted"
  | "next-id-collision"
  | "invalid-default-settings";

export interface DesktopNativeCoreConstructionBeltPlacementContextResult {
  schemaVersion: 1;
  projectionType: "construction-belt-placement-context-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: {
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    sourceId: string;
    targetId: string;
    itemId: string;
    tier: number;
    lanes: number;
  };
  activePlanetId: string;
  constructionId: "conveyor_belt_mk1" | "conveyor_belt_mk2" | "conveyor_belt_mk3" | null;
  available: number | null;
  appendBeltIndex: number | null;
  nextBeltId: string | null;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreConstructionBeltPlacementUnsupportedReason | null;
  };
  placement: null | {
    remainingConstruction: number;
    nextIdAfterPlacement: number;
    beltTemplate: {
      id: string;
      planetId: string;
      source: string;
      target: string;
      itemId: string;
      lanes: number;
      tier: 1 | 2 | 3;
      sorterTier: 1 | 2 | 3;
      progress: 0;
      priority: 1;
      stackSize: 1 | 2 | 4;
      monitorEnabled: false;
      totalTransferred: 0;
      congestion: 0;
      lastFlow: 0;
      routeMode: "auto" | "bezier" | "upper" | "lower";
    };
  };
  limits: {
    projectionBytes: 1048576;
  };
}

export interface DesktopNativeCoreConstructionBeltRemovalContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  beltId: string;
}

export interface DesktopNativeCoreConstructionBeltLaneContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  beltId: string;
  targetLanes: number;
}

export type DesktopNativeCoreConstructionBeltLaneUnsupportedReason =
  | "invalid-target-lanes"
  | "unsupported-active-planet"
  | "belt-not-found"
  | "invalid-belt"
  | "not-active-planet"
  | "unsupported-item"
  | "unsupported-belt-domain"
  | "unsupported-belt-tier"
  | "missing-construction-definition"
  | "unchanged-lanes"
  | "target-lanes-exceed-limit"
  | "source-not-found"
  | "target-not-found"
  | "unsupported-source-domain"
  | "unsupported-target-domain"
  | "invalid-construction-inventory"
  | "insufficient-construction"
  | "refund-overflow";

export interface DesktopNativeCoreConstructionBeltLaneContextResult {
  schemaVersion: 1;
  projectionType: "construction-belt-lane-context-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: {
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    beltId: string;
    targetLanes: number;
  };
  activePlanetId: string;
  beltId: string;
  planetId: string | null;
  sourceId: string | null;
  targetId: string | null;
  itemId: string | null;
  tier: 1 | 2 | 3 | null;
  currentLanes: number | null;
  targetLanes: number;
  constructionId: "conveyor_belt_mk1" | "conveyor_belt_mk2" | "conveyor_belt_mk3" | null;
  currentConstruction: number | null;
  laneDelta: number | null;
  constructionAfterAdjustment: number | null;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreConstructionBeltLaneUnsupportedReason | null;
  };
  limits: {
    maxPlayerLanes: 4096;
    projectionBytes: 1048576;
  };
}

export type DesktopNativeCoreConstructionBeltRemovalUnsupportedReason =
  | "unsupported-active-planet"
  | "belt-not-found"
  | "invalid-belt"
  | "not-active-planet"
  | "unsupported-belt-domain"
  | "unsupported-belt-tier"
  | "missing-construction-definition"
  | "source-not-found"
  | "target-not-found"
  | "unsupported-source-domain"
  | "unsupported-target-domain"
  | "invalid-construction-inventory"
  | "refund-overflow";

export interface DesktopNativeCoreConstructionBeltRemovalContextResult {
  schemaVersion: 1;
  projectionType: "construction-belt-removal-context-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: {
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    beltId: string;
  };
  activePlanetId: string;
  beltId: string;
  planetId: string | null;
  sourceId: string | null;
  targetId: string | null;
  tier: 1 | 2 | 3 | null;
  lanes: number | null;
  constructionId: "conveyor_belt_mk1" | "conveyor_belt_mk2" | "conveyor_belt_mk3" | null;
  currentConstruction: number | null;
  refundAfterRemoval: number | null;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreConstructionBeltRemovalUnsupportedReason | null;
  };
  limits: {
    projectionBytes: 1048576;
  };
}

export interface DesktopNativeCoreConstructionRemovalContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  entityId: string;
}

export type DesktopNativeCoreConstructionRemovalUnsupportedReason =
  | "entity-not-found"
  | "invalid-entity"
  | "not-active-planet"
  | "interaction-locked"
  | "missing-building-id"
  | "unknown-building"
  | "missing-construction-definition"
  | "unsupported-building-kind"
  | "unsupported-building-domain"
  | "entity-kind-mismatch"
  | "invalid-machine-count"
  | "empty-machine-stack"
  | "spray-coater-installed"
  | "buffered-material"
  | "incident-belt"
  | "construction-queue-reference"
  | "blueprint-pruning-required"
  | "invalid-construction-inventory"
  | "refund-overflow";

export interface DesktopNativeCoreConstructionRemovalContextResult {
  schemaVersion: 1;
  projectionType: "construction-removal-context-v1";
  source: "native-core";
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: {
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    entityId: string;
  };
  activePlanetId: string;
  entityId: string;
  buildingId: string | null;
  machineCount: number | null;
  currentConstruction: number | null;
  refundAfterRemoval: number | null;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreConstructionRemovalUnsupportedReason | null;
  };
  limits: {
    projectionBytes: 1048576;
  };
}

export interface DesktopNativeCoreConstructionStackContextRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  entityId: string;
  targetCount: number;
}

export type DesktopNativeCoreConstructionStackUnsupportedReason =
  | "invalid-target-count"
  | "entity-not-found"
  | "invalid-entity"
  | "not-active-planet"
  | "interaction-locked"
  | "missing-building-id"
  | "unknown-building"
  | "missing-construction-definition"
  | "unsupported-building-kind"
  | "unsupported-building-domain"
  | "entity-kind-mismatch"
  | "invalid-current-count"
  | "empty-machine-stack"
  | "unchanged-target"
  | "stack-limit"
  | "catalog-incomplete"
  | "invalid-construction-inventory"
  | "inventory-insufficient"
  | "refund-overflow";

export interface DesktopNativeCoreConstructionStackContextResult {
  schemaVersion: 1;
  projectionType: "construction-stack-context-v1";
  source: "native-core";
  sessionId: string;
  revision: number;
  stateVersion: 47;
  registryFingerprint: string;
  request: {
    sessionId: string;
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    entityId: string;
    targetCount: number;
  };
  activePlanetId: string;
  entityId: string;
  buildingId: string | null;
  currentCount: number | null;
  targetCount: number;
  currentConstruction: number | null;
  constructionAfter: number | null;
  support: {
    supported: boolean;
    reason: DesktopNativeCoreConstructionStackUnsupportedReason | null;
  };
  limits: {
    projectionBytes: 1048576;
  };
}

export interface DesktopNativeCoreStatisticsProjectionRequest extends DesktopNativeCoreSessionRequest {
  /** Present together only for a main-owned player-authority read. */
  runId?: string;
  expectedRevision: number;
  /** Present together with runId; JS shadow reads omit both lineage tags. */
  expectedRegistryFingerprint?: string;
  minElapsedSeconds: number;
  maxElapsedSeconds: number;
  cursor?: number;
  limit: number;
  planetId?: string;
  itemId?: string;
}

export interface DesktopNativeCoreStatisticsProjectionResult {
  schemaVersion: 1;
  projectionType: "statistics-v1";
  revision: number;
  window: { minElapsedSeconds: number; maxElapsedSeconds: number };
  filters: { planetId: string | null; itemId: string | null };
  samples: ProductionHistorySample[];
  nextCursor: number | null;
}

export type DesktopTechnologyMatrixItemId =
  | "electromagnetic_matrix"
  | "energy_matrix"
  | "structure_matrix"
  | "information_matrix"
  | "gravity_matrix"
  | "universe_matrix";

export interface DesktopNativeCoreTechnologyProjectionRequest extends DesktopNativeCoreSessionRequest {
  /** Present together only for a main-owned player-authority read. */
  runId?: string;
  expectedRevision: number;
  /** Present together with runId; shadow reads omit both lineage tags. */
  expectedRegistryFingerprint?: string;
}

export interface DesktopNativeCoreTechnologyProgressRow {
  techId: string;
  totalCount: number;
  truncated: boolean;
  items: Array<{ itemId: string; amount: number }>;
}

export interface DesktopNativeCoreTechnologyInfiniteRow {
  researchId: string;
  level: number;
  historicalLevel: number | null;
  progress: string;
}

export interface DesktopNativeCoreTechnologyProjectionResult {
  schemaVersion: 1;
  projectionType: "technology-v1";
  revision: number;
  truncated: boolean;
  limits: { techRows: 512; progressItemsPerTech: 16; infiniteRows: 8 };
  counts: {
    completedTechIds: number;
    queuedTechIds: number;
    progressTechs: number;
    infiniteResearch: number;
  };
  selectedTechId: string | null;
  pausedTechId: string | null;
  completedTechIds: string[];
  queuedTechIds: string[];
  progressByTech: DesktopNativeCoreTechnologyProgressRow[];
  activeInfiniteResearchId: string | null;
  autoResearch: boolean;
  infiniteResearch: DesktopNativeCoreTechnologyInfiniteRow[];
  settings: {
    technologyLayout: "standard" | "compact";
    fontScale: 0.8 | 1 | 1.25 | 1.5 | 2;
    difficulty: "relaxed" | "standard" | "hard";
  };
  matrixStock: Record<DesktopTechnologyMatrixItemId, number>;
}

export interface DesktopNativeCoreRecipeWorkspaceLocationRequest {
  planetId: string;
  cursor: number;
  limit: number;
}

export interface DesktopNativeCoreRecipeWorkspaceProjectionRequest extends DesktopNativeCoreSessionRequest {
  /** Main-owned player-authority reads bind the current runtime run. */
  runId?: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  itemIds: string[];
  selectedItemId: string;
  location: DesktopNativeCoreRecipeWorkspaceLocationRequest | null;
}

export interface DesktopNativeCoreRecipeWorkspaceCountedRows<T> {
  rows: T[];
  totalCount: number;
  truncated: boolean;
}

export interface DesktopNativeCoreRecipeWorkspacePlanetProfile {
  planetId: string;
  climateName: string;
  starTypeName: string;
  oceanType: string;
  windMultiplier: number;
  solarPowerMultiplier: number;
  geothermalMultiplier: number;
  miningMultiplier: number;
  reserveScale: number;
  tidalLocked: boolean;
  resourceIds: DesktopNativeCoreRecipeWorkspaceCountedRows<string>;
  orbitalYields: DesktopNativeCoreRecipeWorkspaceCountedRows<{ itemId: string; rate: number }>;
  colonyCost: DesktopNativeCoreRecipeWorkspaceCountedRows<{ itemId: string; amount: number }>;
}

export interface DesktopNativeCoreRecipeWorkspaceProjectionResult {
  schemaVersion: 1;
  projectionType: "recipe-workspace-v1";
  revision: number;
  registryFingerprint: string;
  truncated: boolean;
  limits: {
    itemRows: 256;
    completedTechRows: 512;
    planetRows: 64;
    profileItemRows: 256;
    colonyCostRows: 32;
    locationRows: 4096;
  };
  counts: { catalogItems: number; completedTechIds: number; planetProfiles: number };
  request: {
    itemIds: string[];
    selectedItemId: string;
    location: DesktopNativeCoreRecipeWorkspaceLocationRequest | null;
  };
  live: {
    activePlanetId: string;
    recipeFocus: { itemId: string | null; mode: "two-level" | "full" };
    completedTechIds: string[];
    beltCount: number;
    metrics: { generationKw: number; demandKw: number; powerFactor: number };
    planetProfiles: DesktopNativeCoreRecipeWorkspacePlanetProfile[];
    dyson: {
      systemId: string;
      orbitCount: number;
      orbitSails: number;
      completedStructurePoints: number;
      projectedGenerationKw: number;
      sailLaunchesPerMinute: number;
      rocketLaunchesPerMinute: number;
      receiverLoadKw: number;
      criticalPhotonPerMinute: number;
      shellSails: number;
      shellCapacity: number;
    };
  };
  itemStocks: Array<{ itemId: string; amount: number }>;
  selectedItem: {
    itemId: string;
    stock: number;
    productionLocations: Array<{ planetId: string; producerCount: number }>;
  };
  locationPage: null | {
    planetId: string;
    cursor: number;
    totalCount: number;
    entities: Array<{ id: string; x: number; y: number }>;
    nextCursor: number | null;
  };
}

export interface DesktopNativeCoreStellarProjectionLimits {
  requestBytes: 32768;
  projectionBytes: 1048576;
  pageRows: 64;
  labelBytes: 512;
}

export interface DesktopNativeCoreStellarPage<T> {
  cursor: number;
  limit: number;
  totalCount: number;
  nextCursor: number | null;
  rows: T[];
}

export interface DesktopNativeCoreStarMapOverviewProjectionRequest extends DesktopNativeCoreSessionRequest {
  /** Present only for a main-owned player-authority read; shadow reads omit it. */
  runId?: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  cursor: number;
  limit: number;
}

export interface DesktopNativeCoreStarMapSystemRow {
  systemId: string;
  displayName: string;
  displayNameTruncated: boolean;
  starTypeName: string;
  starTypeNameTruncated: boolean;
  positionX: number;
  positionY: number;
  distanceFromOriginLy: number;
  luminosity: number;
  active: boolean;
  unlocked: boolean;
  missionActive: boolean;
  missionElapsedSeconds: number;
  missionDurationSeconds: number;
  surveyProgress: number;
  firstPlanetId: string;
  planetCount: number;
  colonizedPlanetCount: number;
  entityCount: number;
  deviceCount: number;
  beltCount: number;
  stationCount: number;
  interstellarStationCount: number;
  orbitalCollectorCount: number;
  legacyStationCount: number;
  quantumStationCount: number;
  quantumAttachableCount: number;
  configuredImportSlotCount: number;
  configuredExportSlotCount: number;
  routeCount: number;
  activeRouteCount: number;
  generationKw: number;
  demandKw: number;
  powerFactor: number;
}

export interface DesktopNativeCoreStarMapOverviewProjectionResult {
  schemaVersion: 1;
  projectionType: "star-map-overview-v1";
  revision: number;
  registryFingerprint: string;
  stateVersion: 47;
  limits: DesktopNativeCoreStellarProjectionLimits;
  request: Omit<DesktopNativeCoreStarMapOverviewProjectionRequest, "sessionId">;
  activePlanetId: string;
  activeSystemId: string;
  galaxySeed: number;
  summary: {
    systemCount: number;
    unlockedSystemCount: number;
    planetCount: number;
    colonizedPlanetCount: number;
    stationCount: number;
  };
  systems: DesktopNativeCoreStellarPage<DesktopNativeCoreStarMapSystemRow>;
}

export interface DesktopNativeCoreStarMapCatalogProjectionRequest extends DesktopNativeCoreSessionRequest {
  /** Present only for a main-owned player-authority read; shadow reads omit it. */
  runId?: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  systemCursor: number;
  systemLimit: number;
  planetCursor: number;
  planetLimit: number;
}

export interface DesktopNativeCoreStarMapCatalogSystemRow {
  systemId: string;
  displayName: string;
  displayNameTruncated: boolean;
  starClassId: string | null;
  starTypeName: string;
  starTypeNameTruncated: boolean;
  positionX: number;
  positionY: number;
  distanceFromOriginLy: number;
  luminosity: number;
  massMultiplier: number;
  radiusMultiplier: number;
  active: boolean;
  discovered: boolean;
  missionActive: boolean;
  missionElapsedSeconds: number;
  missionDurationSeconds: number;
  surveyProgress: number;
  firstPlanetId: string;
  planetCount: number;
  colonizedPlanetCount: number;
}

export interface DesktopNativeCoreStarMapCatalogList<T> {
  totalCount: number;
  truncated: boolean;
  rows: T[];
}

export interface DesktopNativeCoreStarMapCatalogPlanetRow {
  planetId: string;
  displayName: string;
  displayNameTruncated: boolean;
  systemId: string;
  systemDisplayName: string;
  systemDisplayNameTruncated: boolean;
  kind: string;
  orbitIndex: number;
  simulationOrder: number;
  systemPositionX: number;
  systemPositionY: number;
  active: boolean;
  discovered: boolean;
  colonized: boolean;
  industryRole: "auto" | "mining" | "smelting" | "manufacturing" | "chemical" | "research" | "logistics" | "power";
  entityCount: number;
  deviceCount: number;
  beltCount: number;
  metadata: {
    note: string;
    noteTruncated: boolean;
    /** Added by star-map-catalog-v1 hosts; absent on older typed fixtures/bridges. */
    tagTextTruncated?: boolean;
    tags: DesktopNativeCoreStarMapCatalogList<string>;
  };
  profile: {
    climateName: string;
    climateNameTruncated: boolean;
    oceanType: string;
    specialization: string;
    specializationName: string;
    specializationNameTruncated: boolean;
    tidalLocked: boolean;
    sulfuricOcean: boolean;
    windMultiplier: number;
    solarMultiplier: number;
    geothermalMultiplier: number;
    miningMultiplier: number;
    orbitalYieldMultiplier: number;
    reserveScale: number;
    travelTimeMultiplier: number;
    productionSpeedMultiplier: number;
    surveyDurationSeconds: number;
    resourceIds: DesktopNativeCoreStarMapCatalogList<string>;
    rareResourceIds: DesktopNativeCoreStarMapCatalogList<string>;
    orbitalYields: DesktopNativeCoreStarMapCatalogList<{ itemId: string; rate: number }>;
  };
}

export interface DesktopNativeCoreStarMapCatalogProjectionResult {
  schemaVersion: 1;
  projectionType: "star-map-catalog-v1";
  revision: number;
  registryFingerprint: string;
  stateVersion: 47;
  limits: DesktopNativeCoreStellarProjectionLimits & {
    nestedRows: 64;
    tagRows: 32;
  };
  request: Omit<DesktopNativeCoreStarMapCatalogProjectionRequest, "sessionId">;
  activePlanetId: string;
  activeSystemId: string;
  galaxySeed: number;
  summary: {
    systemCount: number;
    unlockedSystemCount: number;
    planetCount: number;
    colonizedPlanetCount: number;
  };
  truncated: boolean;
  systems: DesktopNativeCoreStellarPage<DesktopNativeCoreStarMapCatalogSystemRow>;
  planets: DesktopNativeCoreStellarPage<DesktopNativeCoreStarMapCatalogPlanetRow>;
}

export interface DesktopNativeCoreStellarIndustryProjectionRequest extends DesktopNativeCoreSessionRequest {
  /** Present only for a main-owned player-authority read; shadow reads omit it. */
  runId?: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  systemId: string | null;
  planetId: string | null;
  planetCursor: number;
  planetLimit: number;
  stationCursor: number;
  stationLimit: number;
}

export interface DesktopNativeCoreStellarIndustryPlanetRow {
  planetId: string;
  displayName: string;
  displayNameTruncated: boolean;
  systemId: string;
  systemDisplayName: string;
  systemDisplayNameTruncated: boolean;
  kind: string;
  orbitIndex: number;
  simulationOrder: number;
  systemPositionX: number;
  systemPositionY: number;
  active: boolean;
  discovered: boolean;
  colonized: boolean;
  industryRole: "auto" | "mining" | "smelting" | "manufacturing" | "chemical" | "research" | "logistics" | "power";
  entityCount: number;
  deviceCount: number;
  beltCount: number;
  stationCount: number;
  interstellarStationCount: number;
  orbitalCollectorCount: number;
  legacyStationCount: number;
  quantumStationCount: number;
  quantumAttachableCount: number;
  configuredImportSlotCount: number;
  configuredExportSlotCount: number;
  routeCount: number;
  activeRouteCount: number;
  congestedStationId: string | null;
  power: {
    generationKw: number;
    demandKw: number;
    powerFactor: number;
    totalItemsPerMinute: number;
  };
  profile: {
    climateName: string;
    climateNameTruncated: boolean;
    oceanType: string | null;
    specialization: string | null;
    specializationName: string;
    specializationNameTruncated: boolean;
    tidalLocked: boolean;
    windMultiplier: number;
    solarMultiplier: number;
    geothermalMultiplier: number;
    miningMultiplier: number;
    orbitalYieldMultiplier: number;
    reserveScale: number;
    travelTimeMultiplier: number;
  };
}

export interface DesktopNativeCoreStellarIndustryStationRow {
  stationId: string;
  buildingId: string | null;
  buildingLabel: string;
  buildingLabelTruncated: boolean;
  planetId: string;
  planetLabel: string;
  planetLabelTruncated: boolean;
  systemId: string;
  positionX: number;
  positionY: number;
  stationTier: number;
  quantumMode: string | null;
  quantumTransitionActive: boolean;
  powerFactor: number;
  congestion: number;
  installedDrones: number;
  installedVessels: number;
  availableWarpers: number;
  slotCount: number;
  configuredImportSlotCount: number;
  configuredExportSlotCount: number;
  routeCount: number;
  activeRouteCount: number;
}

export interface DesktopNativeCoreStellarIndustryProjectionResult {
  schemaVersion: 1;
  projectionType: "stellar-industry-v1";
  revision: number;
  registryFingerprint: string;
  stateVersion: 47;
  limits: DesktopNativeCoreStellarProjectionLimits;
  request: Omit<DesktopNativeCoreStellarIndustryProjectionRequest, "sessionId">;
  activePlanetId: string;
  activeSystemId: string;
  scopeSystemId: string | null;
  scopePlanetId: string | null;
  truncated: boolean;
  planets: DesktopNativeCoreStellarPage<DesktopNativeCoreStellarIndustryPlanetRow>;
  stations: DesktopNativeCoreStellarPage<DesktopNativeCoreStellarIndustryStationRow>;
}

export type DesktopNativeCoreStellarRouteFilter = "all" | "remote" | "issues";

export interface DesktopNativeCoreStellarIndustryV2ProjectionRequest
  extends DesktopNativeCoreStellarIndustryProjectionRequest {
  routeCursor: number;
  routeLimit: number;
  routeFilter: DesktopNativeCoreStellarRouteFilter;
  query: string;
}

export interface DesktopNativeCoreStellarIndustryRouteRow {
  id: string;
  scope: "local" | "remote";
  itemId: string;
  itemLabel: string;
  itemLabelTruncated: boolean;
  sourceStationId: string | null;
  sourceStationLabel: string;
  sourceStationLabelTruncated: boolean;
  sourceBuildingId: string | null;
  sourceBuildingLabel: string | null;
  sourceSlotIndex: number | null;
  sourcePlanetId: string | null;
  sourcePlanetLabel: string | null;
  sourcePlanetLabelTruncated: boolean;
  targetStationId: string;
  targetStationLabel: string;
  targetStationLabelTruncated: boolean;
  targetBuildingId: string;
  targetBuildingLabel: string;
  targetSlotIndex: number;
  targetSlotIsPrimary: boolean;
  targetPlanetId: string;
  targetPlanetLabel: string;
  targetPlanetLabelTruncated: boolean;
  sourceStock: number;
  sourceReserve: number;
  sourceSlotMinStock: number;
  sourceSlotMaxStock: number;
  targetStock: number;
  targetLimit: number;
  targetFree: number;
  targetSlotMinStock: number;
  targetSlotMaxStock: number;
  minimumLoad: number;
  minimumCargo: number;
  priority: number;
  installedVehicles: number;
  installedVehicleCapacity: number;
  availableVehicles: number;
  activeVehicles: number;
  activeRouteCount: number;
  activeCargo: number;
  activeRouteItemConsistent: boolean;
  distanceLy: number;
  orbitSpan: number;
  durationSeconds: number;
  cargoPerTrip: number;
  throughputPerMinute: number;
  economicsThroughputPerMinute: number;
  powerKw: number;
  energyMjPerTrip: number;
  warpersPerTrip: number;
  warpersPerVessel: number;
  availableWarpers: number;
  dispatchStationId: string | null;
  dispatchPlanetId: string | null;
  dispatchDirection: "unassigned" | "supply-delivery" | "demand-pickup";
  routeKind: "local" | "direct" | "relay";
  routeAvailable: boolean;
  routePlanningComplete: boolean;
  routePathLabel: string;
  routePathLabelTruncated: boolean;
  waypointStationIds: string[];
  waypointPlanetIds: string[];
  waypointStationLabels: string[];
  hopCount: number;
  maxLegDistanceLy: number;
  routePolicy: "direct" | "relay-preferred" | "relay-required";
  warperBudget: number;
  requiresWarp: boolean;
  warpVehicleReady: boolean;
  localVehiclePowerReady: boolean;
  sourcePowerFactor: number;
  targetPowerFactor: number;
  routePowerReady: boolean;
  powerProofComplete: boolean;
  sourceCongestion: number;
  targetCongestion: number;
  waypointMaxCongestion: number;
  routeCongestion: number;
  status: "active" | "ready" | "missing-source" | "missing-vehicle" | "missing-hub" |
    "missing-warper" | "missing-stock" | "target-full" | "no-power";
  statusLabel: string;
}

export interface DesktopNativeCoreStellarIndustryV2ProjectionResult
  extends Omit<DesktopNativeCoreStellarIndustryProjectionResult, "schemaVersion" | "projectionType" | "limits" | "request" | "truncated"> {
  schemaVersion: 2;
  projectionType: "stellar-industry-v2";
  limits: DesktopNativeCoreStellarProjectionLimits & {
    queryBytes: 512;
    pathVisits: 200000;
  };
  request: Omit<DesktopNativeCoreStellarIndustryV2ProjectionRequest, "sessionId">;
  truncated: boolean;
  routeSummary: {
    scopeTotalCount: number;
    filteredCount: number;
    activeCount: number;
    blockedCount: number;
    remoteCount: number;
    routePlanningIncompleteCount: number;
    powerUnprovenCount: number;
    statusCounts: Partial<Record<DesktopNativeCoreStellarIndustryRouteRow["status"], number>>;
  };
  routes: DesktopNativeCoreStellarPage<DesktopNativeCoreStellarIndustryRouteRow>;
}

export interface DesktopNativeCoreStellarQuantumProjectionRequest extends DesktopNativeCoreSessionRequest {
  /** Present only for a main-owned player-authority read; shadow reads omit it. */
  runId?: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  itemCursor: number;
  itemLimit: number;
  collectorCursor: number;
  collectorLimit: number;
}

export interface DesktopNativeCoreStellarQuantumItemRow {
  itemId: string;
  inventory: string;
  capacity: string;
  uploaded: string;
  downloaded: string;
}

export interface DesktopNativeCoreStellarQuantumCollectorRow {
  collectorId: string;
  planetId: string;
  systemId: string;
  machineCount: number;
  quantumMode: "legacy" | "transitioning" | "quantum";
  quantumTransitionActive: boolean;
  attachmentState: "available" | "pending" | "connected" | "unavailable";
}

export interface DesktopNativeCoreStellarQuantumProjectionResult {
  schemaVersion: 1;
  projectionType: "stellar-quantum-v1";
  revision: number;
  registryFingerprint: string;
  stateVersion: 47;
  limits: {
    requestBytes: 32768;
    projectionBytes: 1048576;
    pageRows: 64;
    decimalDigits: 256;
  };
  request: Omit<DesktopNativeCoreStellarQuantumProjectionRequest, "sessionId">;
  enabled: boolean;
  bandwidth: {
    multiplier: number;
    globalUploadPerMinute: number;
    globalDownloadPerMinute: number;
    activeTowerCount: number;
    activeTowerStacks: number;
  };
  runtime: null | {
    boundarySecond: number;
    globalUploadPerMinute: number;
    globalDownloadPerMinute: number;
    quantumTowerStacks: number;
    quantumCollectorStacks: number;
  };
  collectorSummary: {
    totalCount: number;
    connectedCount: number;
    pendingCount: number;
    availableCount: number;
    connectedStacks: number;
  };
  truncated: boolean;
  items: DesktopNativeCoreStellarPage<DesktopNativeCoreStellarQuantumItemRow>;
  collectors: DesktopNativeCoreStellarPage<DesktopNativeCoreStellarQuantumCollectorRow>;
}

export interface DesktopNativeCoreDysonWorkspaceProjectionRequest extends DesktopNativeCoreSessionRequest {
  /** Main-owned player-authority reads bind the current runtime run. */
  runId?: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  selectedSystemId: string;
  systemCursor: number;
  systemLimit: number;
  layerCursor: number;
  layerLimit: number;
  orbitCursor: number;
  orbitLimit: number;
  nodeCursor: number;
  nodeLimit: number;
  frameCursor: number;
  frameLimit: number;
  shellCursor: number;
  shellLimit: number;
}

export interface DesktopNativeCoreDysonEngineeringSummary {
  launchMode: "balanced" | "swarm" | "sphere";
  launchThrottle: 0.25 | 0.5 | 0.75 | 1;
  launchEnabled: boolean;
  orbitCount: number;
  orbitSails: number;
  queuedSails: number;
  queuedRockets: number;
  sailLaunchesPerMinute: number;
  rocketLaunchesPerMinute: number;
  launchEnergyPerSailMj: number;
  launchEnergyPerRocketMj: number;
  launchEnergyPerMinuteMj: number;
  rayGenerationKw: number;
  receiverCapacityKw: number;
  operationalReceiverCapacityKw: number;
  receiverLoadKw: number;
  theoreticalReceptionRate: number;
  receiverUtilization: number;
  dysonPowerUtilization: number;
  configuredReceiverCount: number;
  blockedReceiverCount: number;
  criticalPhotonPerMinute: number;
  antimatterPerMinute: number;
  feedbackGenerationKw: number;
  plannedStructurePoints: number;
  completedStructurePoints: number;
  remainingStructurePoints: number;
  shellCapacity: number;
  shellSails: number;
  projectedGenerationKw: number;
}

export interface DesktopNativeCoreDysonSystemRow {
  systemId: string;
  displayName: string;
  displayNameTruncated: boolean;
  starProfile: {
    available: boolean;
    starTypeName: string;
    starTypeNameTruncated: boolean;
    luminosity: number;
    radiusMultiplier: number;
  };
  unlocked: boolean;
  active: boolean;
  activeLayerId: string | null;
  activeOrbitId: string | null;
  structurePoints: number;
  shellSails: number;
  totals: {
    layerCount: number;
    nodeCount: number;
    frameCount: number;
    shellCount: number;
    plannedStructurePoints: number;
    completedStructurePoints: number;
    sailCapacity: number;
    absorbedSails: number;
  };
  orbitCount: number;
  orbitSails: number;
  projectedGenerationKw: number;
  engineering: DesktopNativeCoreDysonEngineeringSummary;
}

export interface DesktopNativeCoreDysonLayerRow {
  layerId: string;
  name: string;
  nameTruncated: boolean;
  radius: number;
  inclination: number;
  longitude: number;
  structureAllocationFloor: number;
  shellAllocationFloor: number;
  nodeCount: number;
  frameCount: number;
  shellCount: number;
  plannedStructurePoints: number;
  completedStructurePoints: number;
  sailCapacity: number;
  absorbedSails: number;
}

export interface DesktopNativeCoreDysonOrbitRow {
  orbitId: string;
  name: string;
  nameTruncated: boolean;
  radius: number;
  inclination: number;
  longitude: number;
  sailsInOrbit: number;
  totalLaunched: number;
  totalExpired: number;
  decayProgress: number;
  generationKw: number;
}

export interface DesktopNativeCoreDysonNodeRow {
  layerId: string;
  nodeId: string;
  angle: number;
  requiredStructurePoints: number;
  completedStructurePoints: number;
}

export interface DesktopNativeCoreDysonFrameRow {
  layerId: string;
  frameId: string;
  sourceNodeId: string;
  targetNodeId: string;
  requiredStructurePoints: number;
  completedStructurePoints: number;
}

export interface DesktopNativeCoreDysonShellRow {
  layerId: string;
  shellId: string;
  sourceNodeId: string;
  targetNodeId: string;
  boundaryFrameCount: number;
  active: boolean;
  sailCapacity: number;
  absorbedSails: number;
}

export interface DesktopNativeCoreDysonWorkspaceProjectionResult {
  schemaVersion: 1;
  projectionType: "dyson-workspace-v1";
  revision: number;
  registryFingerprint: string;
  stateVersion: 47;
  limits: {
    requestBytes: 32768;
    projectionBytes: 1048576;
    pageRows: 64;
    totalRows: 65536;
    idBytes: 1024;
    labelBytes: 512;
  };
  request: Omit<DesktopNativeCoreDysonWorkspaceProjectionRequest, "sessionId">;
  activePlanetId: string;
  activeSystemId: string;
  selectedSystemId: string;
  technology: { programReady: boolean; shellReady: boolean; swarmReady: boolean };
  global: {
    sphere: { structurePoints: number; totalRocketsLaunched: number; shellSails: number; totalSailsAbsorbed: number; generationKw: number };
    swarm: { sailsInOrbit: number; totalLaunched: number; totalExpired: number; generationKw: number; receiverLoadKw: number };
    launch: { mode: "balanced" | "swarm" | "sphere"; throttle: 0.25 | 0.5 | 0.75 | 1; enabled: boolean; energySpentMj: number };
  };
  summary: { systemCount: number; unlockedSystemCount: number; layerCount: number; orbitCount: number; nodeCount: number; frameCount: number; shellCount: number };
  selectedSystem: DesktopNativeCoreDysonSystemRow;
  systems: DesktopNativeCoreStellarPage<DesktopNativeCoreDysonSystemRow>;
  layers: DesktopNativeCoreStellarPage<DesktopNativeCoreDysonLayerRow>;
  orbits: DesktopNativeCoreStellarPage<DesktopNativeCoreDysonOrbitRow>;
  nodes: DesktopNativeCoreStellarPage<DesktopNativeCoreDysonNodeRow>;
  frames: DesktopNativeCoreStellarPage<DesktopNativeCoreDysonFrameRow>;
  shells: DesktopNativeCoreStellarPage<DesktopNativeCoreDysonShellRow>;
}

export interface DesktopNativeCoreSystemSpaceStationWorkspaceProjectionRequest extends DesktopNativeCoreSessionRequest {
  runId: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  systemId: string;
  requirementCursor: number;
  requirementLimit: number;
  inventoryCursor: number;
  inventoryLimit: number;
  trayCursor: number;
  trayLimit: number;
  stationCursor: number;
  stationLimit: number;
}

export type DesktopNativeSystemSpaceStationIntent =
  | { type: "start"; systemId: string }
  | { type: "deliver-from-tray"; systemId: string; planetId: string; itemId: string; requestedAmount: number }
  | { type: "module-target"; systemId: string; module: "backbone" | "energy" | "interstellar"; target: number }
  | { type: "upgrade-one"; entityId: string }
  | { type: "upgrade-all"; systemId: string | null }
  | { type: "mode-target"; entityId: string; mode: "legacy" | "elevator" }
  | { type: "output-target"; entityId: string; portIndex: number; itemId: string | null; confirmations: number };

export interface DesktopNativeSystemSpaceStationIntentRequest {
  expectedSessionId: string;
  expectedRunId: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  expectedSystemId: string;
  intent: DesktopNativeSystemSpaceStationIntent;
}

export interface DesktopNativeCoreSystemSpaceStationRequirementRow {
  requirementIndex: number;
  phaseName: string;
  itemId: string;
  itemName: string;
  itemNameTruncated: boolean;
  baseAmount: number;
  requiredAmount: string;
  deliveredAmount: string;
  constructionBufferAmount: string;
  complete: boolean;
  current: boolean;
}

export interface DesktopNativeCoreSystemSpaceStationInventoryRow {
  itemId: string;
  itemName: string;
  itemNameTruncated: boolean;
  amount: string;
  policy: null | { interstellarEnabled: boolean; reserve: string; target: string };
}

export interface DesktopNativeCoreSystemSpaceStationTrayRow {
  planetId: string;
  planetName: string;
  planetNameTruncated: boolean;
  activePlanet: boolean;
  itemId: string;
  itemName: string;
  itemNameTruncated: boolean;
  amount: number;
  constructionMaterial: boolean;
}

export interface DesktopNativeCoreSystemSpaceStationEntityRow {
  entityId: string;
  planetId: string;
  planetName: string;
  planetNameTruncated: boolean;
  machineCount: number;
  stationTier: 1 | 2;
  operationMode: "legacy" | "elevator";
  modeTransition: "to-elevator" | "to-legacy" | null;
  effectiveTargetMode: "legacy" | "elevator";
  outputTargets: Array<{
    portIndex: number;
    itemId: string | null;
    itemName: string;
    itemNameTruncated: boolean;
  }>;
  outputConfigurationEnabled: boolean;
}

export interface DesktopNativeCoreSystemSpaceStationWorkspaceProjectionResult {
  schemaVersion: 1;
  projectionType: "system-space-station-workspace-v1";
  source: "native-core";
  sessionId: string;
  runId: string;
  revision: number;
  registryFingerprint: string;
  stateVersion: 47;
  limits: {
    requestBytes: 32768;
    projectionBytes: 1048576;
    pageRows: 64;
    totalRows: 65536;
    idBytes: 512;
    labelBytes: 512;
    decimalDigits: 256;
  };
  request: DesktopNativeCoreSystemSpaceStationWorkspaceProjectionRequest;
  system: {
    systemId: string;
    displayName: string;
    displayNameTruncated: boolean;
    planetCount: number;
    activePlanetId: string;
    activePlanetInSystem: boolean;
    unlocked: boolean;
  };
  technology: {
    constructionReady: boolean;
    moduleAssemblyReady: boolean;
    autonomousConstructionReady: boolean;
    orbitalBusReady: boolean;
  };
  station: {
    persisted: boolean;
    status: "not-started" | "building" | "operational";
    costRevision: number;
    costMultiplierBasisPoints: number;
    phaseIndex: number;
    canStartConstruction: boolean;
    launcherPresent: boolean;
    modules: { backbone: number; energy: number; interstellar: number };
    progress: {
      basisPoints: number;
      deliveredAmount: string;
      requiredAmount: string;
      constructionBufferAmount: string;
    };
    inventoryAmount: string;
  };
  hubNetwork: {
    fleetInstalled: number;
    fleetBusy: number;
    fleetReturnCount: number;
    warpers: string;
    warperTarget: string;
  };
  summary: {
    requirementCount: number;
    inventoryItemCount: number;
    trayMaterialCount: number;
    trayAvailableAmount: string;
    interstellarStationCount: number;
    mk1StationCount: number;
    mk2StationCount: number;
    elevatorStationCount: number;
    transitioningStationCount: number;
  };
  requirements: DesktopNativeCoreStellarPage<DesktopNativeCoreSystemSpaceStationRequirementRow>;
  sharedInventory: DesktopNativeCoreStellarPage<DesktopNativeCoreSystemSpaceStationInventoryRow>;
  trayMaterials: DesktopNativeCoreStellarPage<DesktopNativeCoreSystemSpaceStationTrayRow>;
  interstellarStations: DesktopNativeCoreStellarPage<DesktopNativeCoreSystemSpaceStationEntityRow>;
}

export interface DesktopNativeCoreOrbitalContractWorkspaceProjectionRequest extends DesktopNativeCoreSessionRequest {
  runId: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
}

export type DesktopNativeOrbitalContractIntent =
  | { type: "accept"; contractId: string }
  | { type: "deliver-quantum"; contractId: string; itemId: string; requestedAmount: string }
  | { type: "claim"; contractId: string }
  | { type: "abandon"; contractId: string }
  | { type: "feature"; contractId: string | null };

export interface DesktopNativeOrbitalContractIntentRequest {
  expectedSessionId: string;
  expectedRunId: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  intent: DesktopNativeOrbitalContractIntent;
}

export interface DesktopNativeCoreOrbitalContractRequirementRow {
  itemId: string;
  amount: string;
  delivered: string;
  channel: "any" | "terminal" | "quantum";
  sourcePlanetIds: string[];
  availableQuantum: string;
}

export interface DesktopNativeCoreOrbitalContractRow {
  id: string;
  templateId: "single" | "combination" | "dyson" | "origin" | "multi-origin" | "quantum" | "advanced";
  slot: number;
  title: string;
  summary: string;
  taskDay: number;
  expiresAtTaskDay: number;
  special: boolean;
  difficulty: "P1" | "P2" | "P3";
  status: "offered" | "accepted" | "claimable";
  requirements: DesktopNativeCoreOrbitalContractRequirementRow[];
  rewardMarks: string;
  rewardReputation: string;
  completionBasisPoints: number;
}

export interface DesktopNativeCoreOrbitalContractWorkspaceProjectionResult {
  schemaVersion: 1;
  projectionType: "orbital-contract-workspace-v1";
  source: "native-core";
  sessionId: string;
  runId: string;
  revision: number;
  registryFingerprint: string;
  stateVersion: 47;
  stationStatus: "showcase-building" | "operational";
  taskDay: number;
  rulesVersion: 1;
  quantumEnabled: boolean;
  orbitalMarks: string;
  stationReputation: string;
  completedContracts: number;
  featuredContractId: string | null;
  offers: DesktopNativeCoreOrbitalContractRow[];
  accepted: DesktopNativeCoreOrbitalContractRow[];
  completedHistory: Array<{
    id: string;
    title: string;
    difficulty: "P1" | "P2" | "P3";
    settledAtTaskDay: number;
  }>;
  limits: {
    offerCount: 4;
    acceptedCount: 3;
    historyCount: 8;
    requirementsPerContract: 6;
    projectionBytes: 262144;
  };
  unsupported: ["cargo-terminal-binding", "decorations", "profile", "construction"];
}

export interface DesktopNativeCoreAuthorityWorkspaceProjectionRequest extends DesktopNativeCoreSessionRequest {
  runId: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
}

export type DesktopNativeCoreOperationsWorkspaceProjectionRequest = DesktopNativeCoreSessionRequest & {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly expectedRegistryFingerprint: string;
};

export type DesktopNativeOperationsSettingIntent =
  | { readonly type: "set-simulation-speed"; readonly value: 1 | 2 | 4 }
  | { readonly type: "set-technology-layout"; readonly value: "standard" | "compact" }
  | { readonly type: "set-default-belt-route-mode"; readonly value: "auto" | "bezier" | "upper" | "lower" }
  | { readonly type: "set-production-buffer-limit"; readonly value: number }
  | { readonly type: "set-logistics-buffer-limit"; readonly value: number }
  | { readonly type: "set-belt-buffer-limit"; readonly value: number }
  | { readonly type: "set-proliferator-buffer-limit"; readonly value: number };

export interface DesktopNativeOperationsSettingIntentRequest {
  readonly expectedSessionId: string;
  readonly expectedRunId: string;
  readonly expectedRevision: number;
  readonly expectedRegistryFingerprint: string;
  readonly intent: DesktopNativeOperationsSettingIntent;
}

export interface DesktopNativeCoreOperationsAlertRow {
  readonly entityId: string;
  readonly planetId: string;
  readonly buildingId: string | null;
  readonly recipeId: string | null;
  readonly resourceId: string | null;
  readonly severity: "critical" | "warning";
  readonly code: string;
  readonly label: string;
}

export interface DesktopNativeFactoryStageScanDiagnostics {
  readonly stage: "logistics-buffer" | "material-delivery" | "ordinary-production" |
    "planet-metrics" | "power-probe" | "quantum" | "construction" |
    "local-dispatch" | "interstellar-dispatch" | "warper-refill" |
    "local-congestion" | "interstellar-congestion" | "station-transition" | "belt";
  readonly invocations: number;
  readonly selectedRows: number;
  readonly totalCandidateRows: number;
  readonly stableRowsSkipped: number;
  readonly denseFallbacks: number;
  readonly directoryFallbacks: number;
  readonly fullScans: number;
}

export interface DesktopNativeFactoryExecutionDiagnostics {
  readonly sourceRevision: number;
  readonly resultRevision: number;
  readonly simulationSeconds: number;
  readonly steps: number;
  readonly entityCount: number;
  readonly writerSubmittedRows: number;
  readonly writerUniqueDomainRows: number;
  readonly writerUniqueRows: number;
  readonly writerDomains: readonly string[];
  readonly topologyChanged: boolean;
  readonly workerLimit: number;
  readonly observedWorkerCount: number;
  readonly parallelPrepareStages: number;
  readonly serialPrepareStages: number;
  readonly stageScans: readonly DesktopNativeFactoryStageScanDiagnostics[];
}

export interface DesktopNativeCoreOperationsWorkspaceProjectionResult {
  readonly schemaVersion: 1;
  readonly projectionType: "operations-workspace-v1";
  readonly source: "native-core";
  readonly stateVersion: 47;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly truncated: false;
  readonly settings: {
    readonly simulationSpeed: 1 | 2 | 4;
    readonly technologyLayout: "standard" | "compact";
    readonly defaultBeltRouteMode: "auto" | "bezier" | "upper" | "lower";
    readonly productionBufferLimit: number;
    readonly logisticsBufferLimit: number;
    readonly beltBufferLimit: number;
    readonly proliferatorBufferLimit: number;
  };
  readonly summary: {
    readonly paused: boolean;
    readonly elapsedSeconds: number;
    readonly entityCount: number;
    readonly beltCount: number;
    readonly activePlanetId: string;
    readonly activePlanetEntityCount: number;
    readonly activePlanetBeltCount: number;
    readonly constructionQueueCount: number;
  };
  readonly alerts: {
    readonly status: "complete" | "overflow";
    readonly totalCount: number;
    readonly criticalCount: number;
    readonly warningCount: number;
    readonly rows: readonly DesktopNativeCoreOperationsAlertRow[];
  };
  readonly factoryExecution: DesktopNativeFactoryExecutionDiagnostics | null;
  readonly limits: { readonly alertRows: 1024; readonly projectionBytes: 524288 };
}

export type DesktopNativeCoreCampaignWorkspaceProjectionRequest =
  DesktopNativeCoreAuthorityWorkspaceProjectionRequest;

export type DesktopNativeCampaignLocator = {
  kind: "item" | "technology" | "entity" | "planet" | "workspace";
  targetId: string;
};

export interface DesktopNativeCoreCampaignTaskRow {
  id: string;
  track: "main" | "side";
  status: "locked" | "available" | "active" | "complete";
  progress: {
    current: number;
    target: number;
  };
  locator: DesktopNativeCampaignLocator | null;
}

export interface DesktopNativeCoreCampaignChapterRow {
  id: string;
  completedCount: number;
  totalCount: number;
  complete: boolean;
  tasks: DesktopNativeCoreCampaignTaskRow[];
}

export interface DesktopNativeCoreCampaignWorkspaceProjectionResult {
  schemaVersion: 1;
  projectionType: "campaign-workspace-v1";
  source: "native-core";
  stateVersion: 47;
  sessionId: string;
  runId: string;
  revision: number;
  registryFingerprint: string;
  truncated: false;
  limits: {
    chapters: 16;
    tasks: 64;
    payloadBytes: 262144;
  };
  counts: {
    chapters: number;
    tasks: number;
    completedTasks: number;
  };
  activeChapterId: string | null;
  activeTaskId: string | null;
  chapters: DesktopNativeCoreCampaignChapterRow[];
}

export type DesktopNativeCoreGalaxyAccountWorkspaceProjectionRequest =
  DesktopNativeCoreAuthorityWorkspaceProjectionRequest;

export type DesktopNativeCoreGalacticExportProjectId =
  | "universe_archive"
  | "solar_sail_array"
  | "carrier_rocket_fleet"
  | "antimatter_exchange";

export interface DesktopNativeCoreGalacticExportProjectRow {
  id: DesktopNativeCoreGalacticExportProjectId;
  itemId: "universe_matrix" | "solar_sail" | "small_carrier_rocket" | "antimatter_fuel_rod";
  enabled: boolean;
  priority: 1 | 2 | 3;
  level: string;
  delivered: string;
  totalDelivered: string;
  dispatchProgress: string;
  target: string;
  reserve: string;
}

export interface DesktopNativeCoreGalaxyAccountWorkspaceProjectionResult {
  schemaVersion: 1;
  projectionType: "galaxy-account-workspace-v1";
  source: "native-core";
  stateVersion: 47;
  sessionId: string;
  runId: string;
  revision: number;
  registryFingerprint: string;
  truncated: false;
  limits: {
    payloadBytes: 65536;
    decimalDigits: 256;
  };
  game: {
    mode: "normal" | "speedrun";
    elapsedSeconds: string;
    difficulty: string;
  };
  production: {
    totalProduced: string;
    universeMatrixProduced: string;
    generationKw: string;
    throughputPerMinute: string;
  };
  progress: {
    campaignCompleted: number;
    campaignTotal: number;
    researchCompleted: number;
    exploredSystems: number;
    colonizedPlanets: number;
    galacticScore: string;
  };
  dyson: {
    powerKw: string;
    structurePoints: string;
    rocketsLaunched: string;
    sailsLaunched: string;
  };
  galacticExports: {
    unlocked: boolean;
    inputMode: "building" | "legacy-network";
    autoDispatch: boolean;
    dispatchThrottle: 0.25 | 0.5 | 1;
    galacticCredits: string;
    galacticScore: string;
    totalExported: string;
    exportedLastMinute: string;
    exporters: {
      total: number;
      paused: number;
      running: number;
    };
    projects: DesktopNativeCoreGalacticExportProjectRow[];
  };
  cloudCompatibility: {
    gameStateVersion: 47;
    envelopeVersion: 2;
    cloudSchemaVersion: 8;
    exportSupported: true;
    restoreIntoActiveAuthority: false;
    importIntoActiveAuthority: false;
    overwriteActiveAuthority: false;
  };
}

export interface DesktopNativeCoreCommandPaletteEntitySearchRequest extends DesktopNativeCoreSessionRequest {
  /** Present only for a main-owned player-authority read; shadow reads omit it. */
  runId?: string;
  expectedRevision: number;
  expectedRegistryFingerprint: string;
  query: string;
  cursor: number;
  limit: number;
  buildingIds: string[];
  resourceIds: string[];
  planetIds: string[];
}

export interface DesktopNativeCoreCommandPaletteEntitySearchRow {
  entityId: string;
  buildingId: string | null;
  resourceId: string | null;
  planetId: string;
  recipeId: string | null;
  positionX: number;
  positionY: number;
}

export interface DesktopNativeCoreCommandPaletteEntitySearchResult {
  schemaVersion: 1;
  projectionType: "command-palette-entity-search-v1";
  revision: number;
  registryFingerprint: string;
  limits: {
    queryBytes: 256;
    selectorIds: 256;
    rows: 16;
    requestBytes: 32768;
    projectionBytes: 1048576;
  };
  request: {
    query: string;
    cursor: number;
    limit: number;
    buildingIds: string[];
    resourceIds: string[];
    planetIds: string[];
  };
  totalCount: number;
  rows: DesktopNativeCoreCommandPaletteEntitySearchRow[];
  nextCursor: number | null;
}

export type DesktopNativeCoreProjectionTransferRequest =
  | {
      sessionId: string;
      projectionType: "viewport-v1";
      payload: Omit<DesktopNativeCoreViewportProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "viewport-v2";
      payload: Omit<DesktopNativeCoreViewportProjectionV2Request, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "factory-read-model-v1";
      payload: Omit<DesktopNativeCoreFactoryReadModelRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "factory-inventory-v1";
      payload: Omit<DesktopNativeCoreFactoryInventoryRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "construction-inventory-v1";
      payload: Omit<DesktopNativeCoreConstructionInventoryRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "blueprint-workspace-v1";
      payload: Omit<DesktopNativeCoreBlueprintWorkspaceRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "blueprint-capture-context-v1";
      payload: Omit<DesktopNativeCoreBlueprintCaptureContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "blueprint-import-context-v1";
      payload: Omit<DesktopNativeCoreBlueprintImportContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "blueprint-export-context-v1";
      payload: Omit<DesktopNativeCoreBlueprintExportContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "blueprint-enqueue-context-v1";
      payload: Omit<DesktopNativeCoreBlueprintEnqueueContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "blueprint-direct-deploy-context-v1";
      payload: Omit<DesktopNativeCoreBlueprintDirectDeployContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "construction-placement-context-v1";
      payload: Omit<DesktopNativeCoreConstructionPlacementContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "construction-belt-placement-context-v1";
      payload: Omit<DesktopNativeCoreConstructionBeltPlacementContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "construction-belt-lane-context-v1";
      payload: Omit<DesktopNativeCoreConstructionBeltLaneContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "construction-belt-removal-context-v1";
      payload: Omit<DesktopNativeCoreConstructionBeltRemovalContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "construction-removal-context-v1";
      payload: Omit<DesktopNativeCoreConstructionRemovalContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "construction-stack-context-v1";
      payload: Omit<DesktopNativeCoreConstructionStackContextRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "statistics-v1";
      payload: Omit<DesktopNativeCoreStatisticsProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "technology-v1";
      payload: Omit<DesktopNativeCoreTechnologyProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "recipe-workspace-v1";
      payload: Omit<DesktopNativeCoreRecipeWorkspaceProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "star-map-overview-v1";
      payload: Omit<DesktopNativeCoreStarMapOverviewProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "star-map-catalog-v1";
      payload: Omit<DesktopNativeCoreStarMapCatalogProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "stellar-industry-v1";
      payload: Omit<DesktopNativeCoreStellarIndustryProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "stellar-industry-v2";
      payload: Omit<DesktopNativeCoreStellarIndustryV2ProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "stellar-quantum-v1";
      payload: Omit<DesktopNativeCoreStellarQuantumProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "dyson-workspace-v1";
      payload: Omit<DesktopNativeCoreDysonWorkspaceProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      projectionType: "system-space-station-workspace-v1";
      payload: Omit<DesktopNativeCoreSystemSpaceStationWorkspaceProjectionRequest, "sessionId">;
    };

export type DesktopNativeCoreProjectionSubscriptionChannel =
  | "viewport-topology"
  | "telemetry"
  | "belt-geometry"
  | "belt-flow"
  | "inventory"
  | "workspace"
  | "notification";

export type DesktopNativeCoreProjectionSubscriptionRequest =
  | {
      sessionId: string;
      channel: "viewport-topology" | "belt-geometry" | "belt-flow";
      projectionType: "viewport-v2";
      payload: Omit<DesktopNativeCoreViewportProjectionV2Request, "sessionId">;
    }
  | {
      sessionId: string;
      channel: "viewport-topology";
      projectionType: "factory-read-model-v1";
      payload: Omit<DesktopNativeCoreFactoryReadModelRequest, "sessionId">;
    }
  | {
      sessionId: string;
      channel: "telemetry";
      projectionType: "statistics-v1";
      payload: Omit<DesktopNativeCoreStatisticsProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      channel: "telemetry" | "workspace" | "notification";
      projectionType: "operations-workspace-v1";
      payload: Omit<DesktopNativeCoreOperationsWorkspaceProjectionRequest, "sessionId">;
    }
  | {
      sessionId: string;
      channel: "inventory";
      projectionType: "factory-inventory-v1";
      payload: Omit<DesktopNativeCoreFactoryInventoryRequest, "sessionId">;
    }
  | {
      sessionId: string;
      channel: "inventory";
      projectionType: "construction-inventory-v1";
      payload: Omit<DesktopNativeCoreConstructionInventoryRequest, "sessionId">;
    }
  | {
      sessionId: string;
      channel: "workspace";
      projectionType: "technology-v1";
      payload: Omit<DesktopNativeCoreTechnologyProjectionRequest, "sessionId">;
    };

export interface DesktopNativeCoreProjectionSubscriptionMetrics {
  readonly channel: DesktopNativeCoreProjectionSubscriptionChannel;
  readonly coalescedCount: number;
  readonly readMs: number;
  readonly encodeMs: number;
  readonly validationMs: number;
}

export type DesktopNativeCoreProjectionSubscriptionEvent =
  | {
      readonly kind: "frame";
      readonly transfer: DesktopNativeCoreProjectionTransferResult;
      readonly metrics: DesktopNativeCoreProjectionSubscriptionMetrics;
    }
  | {
      readonly kind: "error";
      readonly error: Error & { readonly code?: string };
      readonly recoverable?: boolean;
    };

export interface DesktopNativeCoreProjectionSubscriptionHandle {
  update(payload: DesktopNativeCoreProjectionSubscriptionRequest["payload"]): void;
  close(): void;
}

export interface DesktopNativeCoreProjectionTransferHeader {
  schemaVersion: 1;
  sessionId: string;
  revision: number;
  sequence: number;
  projectionType: "viewport-v1" | "viewport-v2" | "factory-read-model-v1" | "factory-inventory-v1" | "construction-inventory-v1" | "blueprint-workspace-v1" | "blueprint-capture-context-v1" | "blueprint-import-context-v1" | "blueprint-export-context-v1" | "blueprint-enqueue-context-v1" | "blueprint-direct-deploy-context-v1" | "construction-placement-context-v1" | "construction-belt-placement-context-v1" | "construction-belt-lane-context-v1" | "construction-belt-removal-context-v1" | "construction-removal-context-v1" | "construction-stack-context-v1" | "statistics-v1" | "technology-v1" | "recipe-workspace-v1" | "star-map-overview-v1" | "star-map-catalog-v1" | "stellar-industry-v1" | "stellar-industry-v2" | "stellar-quantum-v1" | "dyson-workspace-v1" | "system-space-station-workspace-v1" | "operations-workspace-v1";
  payloadLength: number;
  sha256: string;
}

export interface DesktopNativeCoreProjectionTransferResult {
  header: DesktopNativeCoreProjectionTransferHeader;
  bodyBuffer: ArrayBuffer;
}

export interface DesktopNativeCoreCommandResult {
  previousRevision: number;
  revision: number;
  changedEntityIds: string[];
  changedBeltIds: string[];
  topologyDirty: boolean;
}

export interface DesktopNativePlayerAuthorityHistoryStatusRequest {
  readonly sessionId: string;
}

export interface DesktopNativePlayerAuthorityHistoryCommitRequest {
  readonly sessionId: string;
  readonly operationId: string;
  readonly baseRevision: number;
  readonly direction: "undo" | "redo";
}

export interface DesktopNativePlayerAuthorityHistoryStatus {
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly truncatedReason: string | null;
}

export interface DesktopNativePlayerAuthorityHistoryCommitResult extends DesktopNativeCoreCommandResult {
  readonly history: DesktopNativePlayerAuthorityHistoryStatus;
}

export type DesktopNativeCoreCommandReconciliationResult =
  | {
    status: "committed";
    receipt: DesktopNativeCoreCommandResult;
  }
  | {
    status: "pending" | "not-committed" | "conflict";
    baseRevision: number;
    currentRevision: number;
  };

export interface DesktopNativeCoreAdvanceRequest extends DesktopNativeCoreSessionRequest {
  baseRevision: number;
  simulationSeconds: number;
  wallSeconds: number;
  advanceMode?: "exact" | "pure-idle-conservative-v2" | "pure-idle-macro-v10" | "offline-macro-v1";
  includeDiagnostics?: boolean;
}

export interface DesktopNativeCoreAdvanceResult {
  supported: boolean;
  exactScope: "no-change" | "clock-only" | "simple-factory-v1" | "pure-idle-bounded-exact" | "pure-idle-conservative-v2" | "pure-idle-macro-v10" | "offline-macro-v1" | "unsupported-domain";
  changed: boolean;
  previousRevision: number;
  revision: number;
  reason?: string;
  algorithmVersion?: string;
  exactCalibrationSeconds?: number;
  approximatedSeconds?: number;
  beltScheduler?: DesktopNativeBeltSchedulerDiagnostics;
  summary?: DesktopNativeCoreSummary;
}

interface DesktopNativeOfflineStartupResultBase {
  strategy: "macro-v1";
  sourceSavedAtMs: number;
  settledAtMs: number;
  settledSeconds: number;
  sourceSummary: DesktopNativeCoreSummary;
}

export type DesktopNativeOfflineStartupResult =
  | (DesktopNativeOfflineStartupResultBase & {
    prepared: true;
    advance: DesktopNativeCoreAdvanceResult;
    export: DesktopNativeCoreExportResult;
    candidateSummary: DesktopNativeCoreSummary;
    payloadBytes: ArrayBuffer;
    /** FNV-1a transfer checksum consumed by decodeVerifiedSaveTransfer. */
    payloadChecksum: string;
    reason?: never;
  })
  | (DesktopNativeOfflineStartupResultBase & {
    prepared: false;
    reason: string;
    advance?: DesktopNativeCoreAdvanceResult;
    export?: never;
    candidateSummary?: never;
    payloadBytes?: never;
    payloadChecksum?: never;
  });

export interface DesktopNativeBeltSchedulerDiagnostics {
  routeCount: number;
  groupCount: number;
  activeQueueEnabled: boolean;
  initializationGroupChecks: number;
  selectionGroupChecks: number;
  carriedActiveGroups: number;
  transferPasses: number;
  reservationPasses: number;
  fullScanPasses: number;
  transferRouteChecks: number;
  reservationRouteChecks: number;
  reservationAllowanceEntries: number;
  reservationCreditEntries: number;
  /** Transfer/reservation route scans omitted; a reverse-wake clock catch-up may still touch a subset. */
  stableRoutesSkipped: number;
  wakeCount: number;
  sleepCount: number;
  changedBeltRecords: number;
  writeBackPatchRecords: number;
  /** Configured deterministic worker width for this write-back; zero means no patches. */
  writeBackWorkers: number;
}

export interface DesktopNativeCoreCommitOperationRequest extends DesktopNativeCoreSessionRequest {
  commandId: string;
  baseRevision: number;
  command?: Record<string, unknown> | null;
  simulationSeconds: number;
  wallSeconds: number;
  advanceMode?: "exact" | "pure-idle-conservative-v2" | "pure-idle-macro-v10" | "offline-macro-v1";
  includeDiagnostics?: boolean;
}

export interface DesktopNativeCoreCommitOperationResult {
  commandId: string;
  baseRevision: number;
  revision: number;
  currentRevision: number;
  entryHash: string;
  walBytes: number;
  duplicate: boolean;
  summary?: DesktopNativeCoreSummary;
}

export interface DesktopNativeCoreCheckpointRequest extends DesktopNativeCoreSessionRequest {
  savedAtMs: number;
}

export interface DesktopNativeCoreCheckpointResult {
  checkpoint: DesktopNativeSaveCommitResult;
  summary: DesktopNativeCoreSummary;
  encodedRecords: number;
  reusedRecords: number;
}

export interface DesktopNativePlayerAuthorityCheckpointResult {
  authority: DesktopNativePlayerAuthorityArtifactIdentity;
  checkpoint: LocalSaveNativeAuthorityCheckpoint;
  summary: DesktopNativeCoreSummary;
  reusedAcknowledgedCheckpoint: true;
}

export interface DesktopNativePlayerAuthorityDurableRestartResult {
  readonly schemaVersion: 1;
  readonly accepted: true;
  readonly recoveryMode: "rust-durable-reconcile";
  readonly minimumRevision: number;
}

export interface DesktopNativePlayerAuthorityArtifactIdentity {
  sessionId: string;
  runId: string;
  revision: number;
}

export interface DesktopNativePlayerAuthorityExportRequest {
  exportId: string;
  savedAtMs: number;
  suggestedName?: string;
  /** Authority identities are deliberately impossible on this wire shape. */
  sessionId?: never;
  runId?: never;
}

export interface DesktopNativeCoreExportRequest extends DesktopNativeCoreSessionRequest {
  exportId: string;
  savedAtMs: number;
  suggestedName?: string;
}

export interface DesktopNativeCoreExportResult {
  exportId: string;
  mode: "normal" | "speedrun";
  result: {
    revision: number;
    savedAtMs: number;
    byteLength: number;
    envelopeSha256: string;
    stateChecksum: string;
  };
  cancelled: boolean;
  fileName?: string;
}

export interface DesktopNativePlayerAuthorityExportResult extends DesktopNativeCoreExportResult {
  authority: DesktopNativePlayerAuthorityArtifactIdentity;
}

export interface DesktopNativePlayerAuthorityCloudUploadRequest {
  authorization: string;
  expectedRevision: number;
  retryToken?: string;
  sessionId?: never;
  runId?: never;
  payload?: never;
  sourcePath?: never;
}

export interface DesktopNativePlayerAuthorityCloudProgress {
  stage: "uploading" | "confirmed" | "rejected" | "unknown";
  token: string;
  sentBytes: number;
  totalBytes: number;
}

export type DesktopNativePlayerAuthorityCloudUploadResult = {
  status: "confirmed" | "rejected" | "unknown";
  token: string;
  revision: number;
  httpStatus?: number;
  errorCode?: string;
  body?: string;
  cloudSave?: {
    revision: number;
    [key: string]: unknown;
  };
};

export interface DesktopNativeCoreCompareRequest extends DesktopNativeCoreSessionRequest {
  revision: number;
  canonicalSha256: string;
  domainSha256: string;
}

export interface DesktopNativeCoreCompareResult {
  matches: boolean;
  revisionMatches: boolean;
  canonicalMatches: boolean;
  domainMatches: boolean;
  promotionBlocked: boolean;
  summary: DesktopNativeCoreSummary;
}

export interface DesktopApiRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  requestId?: string;
  timeoutMs?: number;
  expectedResponseBytes?: number;
}

export interface DesktopApiTransferRequest extends Omit<DesktopApiRequest, "body"> {
  requestId: string;
  bodyByteLength: number;
}

export interface DesktopApiResponse {
  ok: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface DesktopApiTransferResponse extends Omit<DesktopApiResponse, "body"> {
  bodyBuffer: ArrayBuffer;
}

export interface DesktopAccountArchiveDownloadRequest {
  authorization: string;
  suggestedName?: string;
  requestId?: string;
}

export type DesktopAccountArchiveDownloadResult =
  | { cancelled: true; requestId: string }
  | { cancelled: false; requestId: string; byteLength: number; fileName: string };

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { dspDesktop?: DesktopBridge }).dspDesktop ?? null;
}
