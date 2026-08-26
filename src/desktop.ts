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
  beginNativeSave: (request: DesktopNativeSaveBeginRequest) => Promise<DesktopNativeSaveBeginResult>;
  writeNativeSave: (request: DesktopNativeSaveWriteRequest) => Promise<{ acceptedRecords: number }>;
  commitNativeSave: (request: DesktopNativeSaveTransactionRequest) => Promise<DesktopNativeSaveCommitResult>;
  abortNativeSave: (request: DesktopNativeSaveTransactionRequest) => Promise<{ aborted: boolean }>;
  recoverNativeSave: (request: DesktopNativeSaveSlotRequest) => Promise<DesktopNativeSaveRecoveryResult | null>;
  readNativeSave: (request: DesktopNativeSaveReadRequest) => Promise<DesktopNativeSaveReadResult>;
  appendNativeWal: (request: DesktopNativeWalAppendRequest) => Promise<DesktopNativeWalAppendResult>;
  compactNativeSave: (request: DesktopNativeSaveSlotRequest & { retainGenerations?: number }) => Promise<{ removedGenerations: number }>;
  openNativeCore: (request: DesktopNativeCoreOpenRequest) => Promise<DesktopNativeCoreOpenResult>;
  getNativeCoreStatus: (request: DesktopNativeCoreSessionRequest) => Promise<DesktopNativeCoreSummary>;
  getNativeCoreProjection: (request: DesktopNativeCoreProjectionRequest) => Promise<DesktopNativeCoreProjectionResult>;
  applyNativeCoreCommand: (request: DesktopNativeCoreCommandRequest) => Promise<DesktopNativeCoreCommandResult>;
  advanceNativeCore: (request: DesktopNativeCoreAdvanceRequest) => Promise<DesktopNativeCoreAdvanceResult>;
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
  protocolVersion?: number;
  nativeFormatVersion?: number;
  hostVersion?: string;
  capabilities: string[];
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
}

export interface DesktopNativeCoreItemDefinition {
  id: string;
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
  buildingId: string;
  duration: number;
  requiredTechId?: string;
  inputs: Array<{ itemId: string; amount: number }>;
  outputs: Array<{ itemId: string; amount: number }>;
}

export interface DesktopNativeCorePlanetDefinition {
  id: string;
  systemId: string;
  kind: "terrestrial" | "gas-giant";
  orbitIndex: number;
  orbitalYields: Record<string, number>;
}

export interface DesktopNativeCoreCatalog {
  protocolVersion: 1;
  registryFingerprint: string;
  planets: DesktopNativeCorePlanetDefinition[];
  items: DesktopNativeCoreItemDefinition[];
  buildings: DesktopNativeCoreBuildingDefinition[];
  recipes: DesktopNativeCoreRecipeDefinition[];
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
  entities: Array<Record<string, unknown>>;
  belts: Array<Record<string, unknown>>;
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
}

export interface DesktopNativeCoreAdvanceResult {
  supported: boolean;
  exactScope: "no-change" | "clock-only" | "simple-factory-v1" | "unsupported-domain";
  changed: boolean;
  previousRevision: number;
  revision: number;
  reason?: string;
  summary: DesktopNativeCoreSummary;
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
