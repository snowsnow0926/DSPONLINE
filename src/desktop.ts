import type { BeltConnection, FactoryEntity, ProductionHistorySample } from "./game/types";

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

export interface DesktopBridge {
  isDesktop: true;
  setFontScale: (scale: number) => Promise<{ scale: number; zoomFactor: number }>;
  getReleaseInfo: () => Promise<DesktopReleaseInfo>;
  getNativePerformanceStatus: () => Promise<DesktopNativePerformanceStatus>;
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
  getNativeCoreStatisticsProjection: (request: DesktopNativeCoreStatisticsProjectionRequest) => Promise<DesktopNativeCoreStatisticsProjectionResult>;
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

export interface DesktopNativeCoreStatisticsProjectionRequest extends DesktopNativeCoreSessionRequest {
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
      projectionType: "statistics-v1";
      payload: Omit<DesktopNativeCoreStatisticsProjectionRequest, "sessionId">;
    };

export interface DesktopNativeCoreProjectionTransferHeader {
  schemaVersion: 1;
  sessionId: string;
  revision: number;
  sequence: number;
  projectionType: "viewport-v1" | "viewport-v2" | "statistics-v1";
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
