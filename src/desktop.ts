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
  revision: number;
  commandId: string;
  payload: Record<string, unknown>;
}

export interface DesktopNativeWalAppendResult {
  revision: number;
  entryHash: string;
  walBytes: number;
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
