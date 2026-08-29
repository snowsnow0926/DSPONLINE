import type { BeltConnection, FactoryEntity, ProductionHistorySample } from "./game/types";
import type { FactoryReadModelBundle } from "./game/factoryReadModels";

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
  | "uncertain"
  | "faulted"
  | "shutdown";

export type DesktopNativePlayerAuthorityOperation =
  | "activation"
  | "recovery"
  | "tick"
  | "command";

export type DesktopNativePlayerAuthorityMacroPhase =
  | "macro-active"
  | "macro-committing"
  | "macro-finishing"
  | "macro-uncertain"
  | "faulted"
  | "shutdown";

export type DesktopNativePlayerAuthorityMacroOperation = "advance" | "finish";

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

export interface DesktopNativePlayerAuthorityMacroBudgetRequest {
  readonly simulationMilliseconds: number;
  readonly wallMilliseconds: number;
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

export interface DesktopBridge {
  isDesktop: true;
  setFontScale: (scale: number) => Promise<{ scale: number; zoomFactor: number }>;
  getReleaseInfo: () => Promise<DesktopReleaseInfo>;
  getNativePerformanceStatus: () => Promise<DesktopNativePerformanceStatus>;
  /** Current Windows authority host only; absent on Web and rollback shells. */
  getNativePlayerAuthorityState?: () => Promise<DesktopNativePlayerAuthorityState>;
  /** Read-only transition notifications; unsubscribe removes only this listener. */
  onNativePlayerAuthorityState?: (
    listener: (state: DesktopNativePlayerAuthorityState) => void,
  ) => () => void;
  /** Budget-only request; session/run/operation IDs cannot be supplied by the renderer. */
  startNativePlayerAuthorityMacro?: (
    request: DesktopNativePlayerAuthorityMacroBudgetRequest,
  ) => Promise<DesktopNativePlayerAuthorityMacroReceipt>;
  advanceNativePlayerAuthorityMacro?: (
    request: DesktopNativePlayerAuthorityMacroBudgetRequest,
  ) => Promise<DesktopNativePlayerAuthorityMacroReceipt>;
  finishNativePlayerAuthorityMacro?: () => Promise<DesktopNativePlayerAuthorityMacroReceipt>;
  recoverNativePlayerAuthorityMacro?: () => Promise<DesktopNativePlayerAuthorityMacroReceipt>;
  getRuntimeDiagnostics: () => Promise<DesktopRuntimeDiagnostics>;
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
  /** Current Windows host only; legacy/web import remains the compatibility fallback. */
  importNativeCoreV47?: (request: DesktopNativeCoreImportRequest) => Promise<DesktopNativeCoreImportResult>;
  getNativeCoreStatus: (request: DesktopNativeCoreSessionRequest) => Promise<DesktopNativeCoreSummary>;
  getNativeCoreProjection: (request: DesktopNativeCoreProjectionRequest) => Promise<DesktopNativeCoreProjectionResult>;
  getNativeCoreViewportProjection: (request: DesktopNativeCoreViewportProjectionRequest) => Promise<DesktopNativeCoreViewportProjectionResult>;
  getNativeCoreViewportProjectionV2: (request: DesktopNativeCoreViewportProjectionV2Request) => Promise<DesktopNativeCoreViewportProjectionV2Result>;
  getNativeCoreFactoryReadModel: (request: DesktopNativeCoreFactoryReadModelRequest) => Promise<DesktopNativeCoreFactoryReadModelResult>;
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
  /** Current Windows thin-UI host only; native authority never falls back to a renderer entity scan. */
  getNativeCoreCommandPaletteEntitySearch?: (request: DesktopNativeCoreCommandPaletteEntitySearchRequest) => Promise<DesktopNativeCoreCommandPaletteEntitySearchResult>;
  requestNativeCoreProjectionTransfer?: (request: DesktopNativeCoreProjectionTransferRequest) => Promise<DesktopNativeCoreProjectionTransferResult>;
  applyNativeCoreCommand: (request: DesktopNativeCoreCommandRequest) => Promise<DesktopNativeCoreCommandResult>;
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

export interface DesktopNativeCoreCatalog {
  protocolVersion: 1;
  registryFingerprint: string;
  planets: DesktopNativeCorePlanetDefinition[];
  items: DesktopNativeCoreItemDefinition[];
  buildings: DesktopNativeCoreBuildingDefinition[];
  recipes: DesktopNativeCoreRecipeDefinition[];
  constructions: DesktopNativeCoreConstructionDefinition[];
  belts: Array<{ tier: number; speed: number }>;
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

export interface DesktopNativeCoreStatisticsProjectionRequest extends DesktopNativeCoreSessionRequest {
  expectedRevision: number;
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
  expectedRevision: number;
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

export interface DesktopNativeCoreCommandPaletteEntitySearchRequest extends DesktopNativeCoreSessionRequest {
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
    };

export interface DesktopNativeCoreProjectionTransferHeader {
  schemaVersion: 1;
  sessionId: string;
  revision: number;
  sequence: number;
  projectionType: "viewport-v1" | "viewport-v2" | "factory-read-model-v1" | "statistics-v1" | "technology-v1" | "recipe-workspace-v1" | "star-map-overview-v1" | "star-map-catalog-v1" | "stellar-industry-v1" | "stellar-industry-v2" | "stellar-quantum-v1";
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

export interface DesktopNativeCoreAdvanceRequest extends DesktopNativeCoreSessionRequest {
  baseRevision: number;
  simulationSeconds: number;
  wallSeconds: number;
  advanceMode?: "exact" | "pure-idle-conservative-v2" | "pure-idle-macro-v10";
  includeDiagnostics?: boolean;
}

export interface DesktopNativeCoreAdvanceResult {
  supported: boolean;
  exactScope: "no-change" | "clock-only" | "simple-factory-v1" | "pure-idle-bounded-exact" | "pure-idle-conservative-v2" | "pure-idle-macro-v10" | "unsupported-domain";
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
  advanceMode?: "exact" | "pure-idle-conservative-v2" | "pure-idle-macro-v10";
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
