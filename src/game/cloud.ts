import { normalizeLeaderboardMetrics, type LeaderboardCategoryId, type LeaderboardMetrics } from "./leaderboardContract";
import type { PublicStationMetricKey, SaveMode, SpeedrunTargetId, StationDecorationPlacement } from "./types";
import {
  assessSavePayloadSize,
  CLOUD_SAVE_LARGE_ENDGAME_BYTES,
  CLOUD_SAVE_RAW_SAFE_LIMIT_BYTES,
  utf8Bytes,
  type SavePayloadSizeTier,
} from "./saveSizePolicy";
import { apiFetch } from "./apiTransport";
import { androidBase64RequestSupported } from "./androidApiTransport";
import { CLOUD_TRANSFER_CONTRACT, cloudRequestTimeoutMs, createCloudRequestId, validCloudExpectedRevision } from "./cloudTransferContract";
import { inspectSaveEnvelopeChecksum } from "./saveEnvelopeIntegrity";
import { sha256Text } from "./payloadDigest";
import {
  capacityDetailsFromCloudError,
  cloudSaveCapacityDetails,
  cloudSaveSizeErrorMessage,
  type CloudSaveCapacityDetails,
} from "./cloudSaveCapacity";
import type {
  CloudAccountArchiveImportPreview,
  CloudAccountArchiveImportResult,
} from "./cloudAccountArchive";
import {
  clearWebCookieSessionState,
  createWebSessionMigrationCoordinator,
  parseWebCookieSessionPayload,
  webCookieSessionRequest,
  webSessionIssuanceHeaders,
  type WebCookieSession,
  type WebSessionMigrationState,
} from "./webSessionMigration";

export const CLOUD_TOKEN_STORAGE_KEY = "dsp-idle-network.cloud-token.v1";
export const CLOUD_SYNC_STORAGE_KEY = "dsp-idle-network.cloud-sync.v1";
export const CLOUD_AUTO_SYNC_STORAGE_KEY = "dsp-idle-network.cloud-auto-sync.v1";
export const CLOUD_DEVICE_ID_STORAGE_KEY = "dsp-idle-network.cloud-device-id.v1";
export const CLOUD_AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
export const CLOUD_ACCOUNT_LEGACY_JSON_CONTENT_TYPE = "application/vnd.dspidle.account-export+json";
export const CLOUD_SAVE_SLOTS = ["main", "1", "2", "3"] as const;
export type CloudSaveSlot = typeof CLOUD_SAVE_SLOTS[number];
export type CloudSaveMode = SaveMode;

let inMemoryCloudToken: string | null = null;
let preferInMemoryCloudToken = false;
let inMemoryWebCookieSession: WebCookieSession | null = null;
let webSessionMigrationState: WebSessionMigrationState = clearWebCookieSessionState();
const webSessionMigrationCoordinator = createWebSessionMigrationCoordinator();

export interface CloudUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  createdAt: number;
  emailVerified: boolean;
  emailVerifiedAt: number | null;
  passwordChangedAt: number;
  leaderboardVisible: boolean;
  /** Missing on schema v7 nodes and is treated as the default public setting. */
  stationVisibility?: "public" | "private";
  /** Stable anonymous aliases used only to identify this account in public lists. */
  leaderboardPublicId?: string;
  speedrunPublicId?: string;
}

export interface CloudAccountSession {
  id: string;
  deviceName: string;
  clientType: "desktop" | "mobile-web" | "desktop-web" | string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  current: boolean;
}

export interface CloudLoginSecurityEvent {
  deviceHash: string;
  regionHash: string;
  occurredAt: number;
  clientType: string;
}

export interface CloudAccountExport {
  exportedAt: number;
  schemaVersion: number;
  user: CloudUser;
  cloudSave: CloudSave | null;
  cloudSaveHistory: CloudSaveMetadata[];
  cloudSaveSlots?: Partial<Record<Exclude<CloudSaveSlot, "main">, CloudSave>>;
  cloudSaveSlotHistory?: Partial<Record<Exclude<CloudSaveSlot, "main">, CloudSaveMetadata[]>>;
  cloudSavesByMode?: Partial<Record<CloudSaveMode, unknown>>;
  cloudSaveHistoriesByMode?: Partial<Record<CloudSaveMode, unknown>>;
  submissions: unknown[];
  feedback: unknown[];
  errors: unknown[];
}

export interface CloudSaveMetadata {
  mode?: CloudSaveMode;
  slot?: CloudSaveSlot;
  revision: number;
  updatedAt: number;
  size: number;
  checksum: string;
  summary: CloudSaveSummary | null;
  restoredFromRevision?: number;
}

export interface CloudSaveSummary {
  mode?: CloudSaveMode;
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

export interface CloudSyncMarker {
  userId: string;
  slot?: CloudSaveSlot;
  revision: number;
  cloudChecksum: string;
  stateChecksum: string | null;
  syncedAt: number;
}

export type CloudSyncState = "empty" | "local-only" | "cloud-only" | "synced" | "local-newer" | "cloud-newer" | "conflict" | "unbound";

export interface CloudSyncComparison {
  state: CloudSyncState;
  marker: CloudSyncMarker | null;
  local: CloudSaveSummary | null;
  cloud: CloudSaveMetadata | null;
  localChanged: boolean;
  cloudChanged: boolean;
}

export interface CloudSave extends CloudSaveMetadata {
  payload: string;
}

export interface CloudSession {
  status: "checking" | "offline" | "anonymous" | "authenticated";
  user: CloudUser | null;
  cloudSave: CloudSaveMetadata | null;
  cloudSaves?: Record<CloudSaveSlot, CloudSaveMetadata | null>;
  mode?: CloudSaveMode;
  cloudSavesByMode?: Partial<Record<CloudSaveMode, Record<CloudSaveSlot, CloudSaveMetadata | null>>>;
  mailAvailable: boolean;
  message: string | null;
}

export interface CloudTransferLimits {
  guaranteedSavePayloadBytes: number;
  savePayloadLimitBytes: number;
  rawFallbackSafeLimitBytes: number;
  requestCompressedLimitBytes: number;
  requestExpandedLimitBytes: number;
  compression: string[];
  chunkedUpload: boolean;
}

export interface CloudQuotaPreflightPlan {
  accepted: boolean;
  reason: string | null;
  code: string | null;
  incoming?: { bytes?: number; checksum?: string | null };
  limits?: Record<string, number>;
  usage?: Record<string, unknown>;
  prune?: { revisionCount?: number; logicalBytes?: number; revisions?: number[] };
  projected?: Record<string, number>;
}

export interface CloudAutoSyncStatus {
  userId: string;
  state: "success" | "error" | "conflict" | "skipped";
  attemptedAt: number;
  uploadedAt: number | null;
  revision: number | null;
  message: string;
}

export type CloudUploadStage = "compressing" | "sending" | "waiting" | "confirming";

export interface CloudUploadOptions {
  mode?: CloudSaveMode;
  verified?: boolean;
  signal?: AbortSignal;
  onStage?: (stage: CloudUploadStage) => void;
  onDiagnostics?: (diagnostics: CloudUploadDiagnostics) => void;
  /** Build-selected in production; injectable so native transport contracts can be unit tested. */
  runtimePlatform?: CloudUploadRuntimePlatform;
  /** Injectable Android capability probe for native bridge tests. */
  androidGzipSupported?: boolean;
  /** Exact SHA-256 produced by an upstream save Worker, when already available. */
  payloadSha256?: string;
  /** Exact UTF-8 byte length paired with payloadSha256 by an upstream Worker. */
  payloadByteLength?: number;
}

export interface CloudUploadDiagnostics {
  status: "running" | "success" | "failed" | "cancelled";
  stage: CloudUploadStage;
  slot: CloudSaveSlot;
  payloadBytes: number;
  requestBytes: number;
  compressedBytes: number | null;
  sizeTier: SavePayloadSizeTier;
  compressionMs: number;
  networkMs: number;
  totalMs: number;
  attempts: number;
  usedCompression: boolean;
  usedRawFallback: boolean;
  fallbackReason?: string;
  lastErrorCode?: string;
  capacity: CloudSaveCapacityDetails;
}

const CLOUD_COMPRESSION_MIN_BYTES = 256 * 1024;
const CLOUD_COMPRESSION_TIMEOUT_MS = CLOUD_TRANSFER_CONTRACT.compressionTimeoutMs;
const CLOUD_UPLOAD_RAW_FALLBACK_LIMIT_BYTES = CLOUD_SAVE_RAW_SAFE_LIMIT_BYTES;
const CLOUD_UPLOAD_DIAGNOSTICS_SESSION_KEY = "dsp-idle-network.cloud-upload-diagnostics.v1";

function persistCloudUploadDiagnostics(diagnostics: CloudUploadDiagnostics): void {
  try { window.sessionStorage.setItem(CLOUD_UPLOAD_DIAGNOSTICS_SESSION_KEY, JSON.stringify(diagnostics)); } catch { /* runtime diagnostics are optional */ }
}

export function readLastCloudUploadDiagnostics(): CloudUploadDiagnostics | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(CLOUD_UPLOAD_DIAGNOSTICS_SESSION_KEY) ?? "null") as CloudUploadDiagnostics | null;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function assertRawCloudRetryAllowed(rawBodyBytes: number): void {
  if (rawBodyBytes <= CLOUD_UPLOAD_RAW_FALLBACK_LIMIT_BYTES) return;
  const capacity = cloudSaveCapacityDetails(rawBodyBytes);
  throw new CloudApiError(`${cloudSaveSizeErrorMessage(capacity)} 当前存档超过 30 MiB 明文回退边界，需要可用的 gzip 压缩。`, 413, {
    code: "CLOUD_UPLOAD_RAW_FALLBACK_TOO_LARGE",
    ...capacity,
  });
}

const CLOUD_SIZE_ERROR_CODES = new Set([
  "SAVE_SIZE_TOO_LARGE",
  "CLOUD_REVISION_QUOTA_EXCEEDED",
  "CLOUD_SLOT_BYTES_QUOTA_EXCEEDED",
  "CLOUD_MODE_BYTES_QUOTA_EXCEEDED",
  "CLOUD_ACCOUNT_BYTES_QUOTA_EXCEEDED",
  "CLOUD_HISTORY_REVISIONS_QUOTA_EXCEEDED",
  "CLOUD_QUOTA_EXCEEDED",
  "REQUEST_BODY_TOO_LARGE",
  "REQUEST_EXPANDED_BODY_TOO_LARGE",
  "CLOUD_UPLOAD_RAW_FALLBACK_TOO_LARGE",
]);

export function describeCloudUploadError(
  error: unknown,
  fallbackOriginalBytes = 0,
  fallbackCompressedBytes: number | null = null,
): { message: string; code: string | null; capacity: CloudSaveCapacityDetails | null } {
  if (!(error instanceof CloudApiError)) {
    return { message: error instanceof Error ? error.message : "云存档上传失败", code: null, capacity: null };
  }
  const code = typeof error.payload.code === "string" ? error.payload.code : null;
  if (!code || !CLOUD_SIZE_ERROR_CODES.has(code)) return { message: error.message, code, capacity: null };
  const capacity = capacityDetailsFromCloudError(error.payload, fallbackOriginalBytes, fallbackCompressedBytes);
  const suggestion = capacity.overPayloadBytes > 0
    ? "请先导出本地备份并使用存档瘦身；分块上传尚未启用，不能绕过完整性校验。"
    : capacity.compressionAvailable
      ? "压缩体积在请求边界内，可安全重试；若仍失败请复制脱敏诊断。"
      : capacity.originalBytes > CLOUD_TRANSFER_CONTRACT.rawFallbackSafeLimitBytes
        ? "该存档必须使用 gzip；当前环境无法安全回退明文上传。"
        : "可以重试 gzip 或明文兼容路径。";
  return { message: `${cloudSaveSizeErrorMessage(capacity)} ${suggestion}`, code, capacity };
}

type CloudUploadRuntimePlatform = "web" | "desktop" | "android";

function cloudUploadRuntimePlatform(): CloudUploadRuntimePlatform {
  return typeof __APP_PLATFORM__ === "undefined" ? "web" : __APP_PLATFORM__;
}

export interface CloudLeaderboardEntry {
  userId: string;
  accountId: string;
  displayName: string;
  avatar: string;
  seasonId: string;
  metrics: LeaderboardMetrics;
  submittedAt: number;
  value: number;
  verified: boolean;
  rank: number;
  stationPublicId?: string;
}

export type StationSignalId = "spectacular" | "precise" | "industrial" | "layout";

export interface PublicStationSnapshot {
  schema: "station-showcase-v1";
  publicId: string;
  owner: { displayName: string; avatar: string };
  profile: { title: string; motto: string };
  station: {
    stage: "operational";
    reputation: string;
    level: number;
    themeId: string;
    placements: StationDecorationPlacement[];
    featuredAchievementIds: string[];
    completedContracts: number;
    featuredContract: { id: string; title: string; difficulty: "P1" | "P2" | "P3"; settledAtTaskDay: number } | null;
  };
  metrics: Partial<Record<PublicStationMetricKey, number | string>>;
  aggregateMetrics: Partial<Record<PublicStationMetricKey, number | string>>;
  metricStatus: "official" | "content-pack-unverified";
  publishedAt: number;
}

export interface PublicStationSocial {
  favoriteCount: number;
  viewerFavorite: boolean;
  signals: Record<StationSignalId, number>;
  viewerSignal: StationSignalId | null;
}

export interface PublicStationResponse {
  snapshot: PublicStationSnapshot;
  social: PublicStationSocial;
}

export interface CloudStationProfile {
  visibility: "public" | "private";
  publicId: string | null;
  published: boolean;
  sourceRevision: number | null;
  snapshot: PublicStationSnapshot | null;
  social: PublicStationSocial;
}

export type CloudLeaderboardMeStatus =
  | "ranked"
  | "hidden"
  | "restricted"
  | "revalidation_required"
  | "missing_main_save"
  | "missing_adjacent_revision"
  | "interval_too_short"
  | "elapsed_not_increasing"
  | "valid_zero_production"
  | "unavailable";

export type CloudLeaderboardWindowStatus =
  | "ranked"
  | "missing_adjacent_revision"
  | "interval_too_short"
  | "elapsed_not_increasing"
  | "valid_zero_production"
  | "unavailable";

export interface CloudLeaderboardMetricWindow {
  status: CloudLeaderboardWindowStatus;
  valid: boolean;
  value: number | null;
  metricVersion: string;
  requiredSeconds: number;
  observedSeconds: number;
  remainingSeconds: number;
  productionDelta: number | null;
  fromRevision: number | null;
  toRevision: number | null;
}

export interface CloudLeaderboardMe {
  status: CloudLeaderboardMeStatus;
  entry: CloudLeaderboardEntry | null;
  rank: number | null;
  totalEntries: number;
  serverMetrics: LeaderboardMetrics | null;
  latestWindowState: CloudLeaderboardMetricWindow | null;
  mode: "normal";
  slot: "main";
  latestCloudRevision: number | null;
  reviewResumeAfterRevision: number | null;
}

export interface SpeedrunLeaderboardEntry {
  submissionId: string;
  userId: string;
  accountId: string;
  displayName: string;
  avatar: string;
  targetId: SpeedrunTargetId;
  seasonId: string;
  rulesetVersion: string;
  factoryId: string;
  elapsedSeconds: number;
  completedAtSeconds: number;
  completedAt: number;
  receivedAt: number;
  resourceMode: "finite" | "infinite";
  verified: boolean;
  rank: number;
}

export interface SpeedrunSubmissionPayload {
  targetId: SpeedrunTargetId;
  seasonId: string;
  rulesetVersion: string;
  factoryId: string;
  elapsedSeconds: number;
  saveRevision: number;
  saveHash: string;
  clientVersion: string;
}

export interface CloudPublicStatus {
  ok: boolean;
  timeZone: string;
  today: string;
  uptimeSeconds: number;
  players: {
    total: number;
    today: number;
    online: number;
    onlineWindowSeconds: number;
  };
  activity?: {
    enabled: boolean;
    status: "disabled" | "scheduled" | "active" | "ended";
    serverNow: number;
    reason?: string | null;
    id?: string;
    revision?: string | null;
    startsAtMs?: number;
    endsAtMs?: number;
    openEnded?: boolean;
    personalTargets?: Record<"universe_matrix" | "solar_sail" | "small_carrier_rocket" | "antimatter_fuel_rod", number>;
    globalTargets?: Record<"universe_matrix" | "solar_sail" | "small_carrier_rocket" | "antimatter_fuel_rod", number>;
    globalDelivered?: Record<"universe_matrix" | "solar_sail" | "small_carrier_rocket" | "antimatter_fuel_rod", number>;
  };
}

export class CloudApiError extends Error {
  constructor(message: string, readonly status: number, readonly payload: Record<string, unknown> = {}) {
    super(message);
  }
}

export function cloudApiBase(allowInsecurePublicRead = false): string | null {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (typeof __APP_PLATFORM__ !== "undefined" && __APP_PLATFORM__ !== "web") return null;
  if (typeof window === "undefined" || window.location.protocol === "file:") return null;
  const localDevelopment = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  if (window.location.protocol !== "https:" && !localDevelopment && !allowInsecurePublicRead) return null;
  return "/api";
}

export function getCloudToken(): string | null {
  try {
    const storedToken = window.localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY);
    if (preferInMemoryCloudToken) {
      if (storedToken === inMemoryCloudToken) preferInMemoryCloudToken = false;
      return inMemoryCloudToken;
    }
    inMemoryCloudToken = storedToken;
    return storedToken;
  } catch {
    return inMemoryCloudToken;
  }
}

function isWebCloudRuntime(): boolean {
  return typeof window !== "undefined"
    && (typeof __APP_PLATFORM__ === "undefined" || __APP_PLATFORM__ === "web");
}

function webCookieSessionEligible(base = cloudApiBase()): boolean {
  if (!isWebCloudRuntime() || !base) return false;
  try {
    const page = new URL(window.location.href);
    const target = new URL(base, page);
    const localDevelopment = page.protocol === "http:"
      && (page.hostname === "localhost" || page.hostname === "127.0.0.1");
    return (page.protocol === "https:" || localDevelopment)
      && target.origin === page.origin
      && target.pathname.replace(/\/+$/, "") === "/api"
      && !target.username
      && !target.password
      && !target.search
      && !target.hash;
  } catch {
    return false;
  }
}

function activeWebCookieSession(): WebCookieSession | null {
  if (!isWebCloudRuntime() || !inMemoryWebCookieSession) return null;
  if (inMemoryWebCookieSession.expiresAt > Date.now()) return inMemoryWebCookieSession;
  inMemoryWebCookieSession = null;
  webSessionMigrationState = clearWebCookieSessionState();
  return null;
}

function applyWebSessionMigrationState(next: WebSessionMigrationState): WebSessionMigrationState {
  webSessionMigrationState = next;
  inMemoryWebCookieSession = next.phase === "ready" || next.phase === "cleanup_pending"
    ? next.session
    : null;
  return next;
}

function clearCloudAuthenticationState(clearBearer = true): void {
  applyWebSessionMigrationState(clearWebCookieSessionState());
  if (clearBearer) setCloudToken(null);
}

/**
 * Attempts the one-way legacy Web Bearer -> HttpOnly Cookie migration.
 * A failed or unsupported migration deliberately leaves the legacy token in
 * place so 1.0.39 APIs and interrupted rolling upgrades remain usable.
 */
export async function initializeCloudAuthentication(): Promise<WebSessionMigrationState> {
  if (!webCookieSessionEligible()) return webSessionMigrationState;
  const existing = activeWebCookieSession();
  if (existing) return applyWebSessionMigrationState({
    ...webSessionMigrationState,
    phase: "ready",
    session: existing,
    legacyTokenPresent: Boolean(getCloudToken()),
    reason: null,
    retryable: false,
  });
  const base = cloudApiBase();
  if (!base) return webSessionMigrationState;
  const next = await webSessionMigrationCoordinator.run({
    apiBase: base,
    pageUrl: window.location.href,
    storage: window.localStorage,
  });
  return applyWebSessionMigrationState(next);
}

export function hasCloudAuthentication(): boolean {
  return Boolean(activeWebCookieSession() || getCloudToken());
}

export function getWebCookieSession(): WebCookieSession | null {
  return activeWebCookieSession();
}

export function prepareCloudAuthenticatedRequest(init: RequestInit = {}): RequestInit {
  const cookieSession = activeWebCookieSession();
  if (cookieSession) return webCookieSessionRequest(cookieSession, init);
  const token = getCloudToken();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
  // Preserve the historical request contract when no local credential is
  // present: the server remains authoritative and returns its stable 401.
  // Callers that must avoid an anonymous request use hasCloudAuthentication().
  if (token) headers.authorization = `Bearer ${token}`;
  return { ...init, headers };
}

function setCloudToken(token: string | null): void {
  inMemoryCloudToken = token;
  try {
    if (token) window.localStorage.setItem(CLOUD_TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(CLOUD_TOKEN_STORAGE_KEY);
    preferInMemoryCloudToken = false;
  } catch {
    // Keep the current session usable without allowing a stale persisted token
    // to override an explicit login or logout while storage is unavailable.
    preferInMemoryCloudToken = true;
  }
}

function cloudDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(CLOUD_DEVICE_ID_STORAGE_KEY);
    if (existing && /^[A-Za-z0-9_-]{16,96}$/.test(existing)) return existing;
    const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `device_${crypto.randomUUID().replaceAll("-", "")}`
      : `device_${Date.now().toString(36)}_${Math.random().toString(36).slice(2).padEnd(16, "0")}`;
    window.localStorage.setItem(CLOUD_DEVICE_ID_STORAGE_KEY, random);
    return random;
  } catch {
    return "device_storage_unavailable";
  }
}

function readCloudSyncMarkers(): Record<string, CloudSyncMarker> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CLOUD_SYNC_STORAGE_KEY) ?? "{}") as Record<string, CloudSyncMarker>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCloudSyncMarkers(markers: Record<string, CloudSyncMarker>): void {
  try { window.localStorage.setItem(CLOUD_SYNC_STORAGE_KEY, JSON.stringify(markers)); } catch { /* optional sync metadata */ }
}

function cloudMarkerKey(userId: string, slot: CloudSaveSlot, mode: CloudSaveMode = "normal"): string {
  return mode === "normal" ? `${userId}:${slot}` : `${userId}:${mode}:${slot}`;
}

export function emptyCloudSaveSlots(main: CloudSaveMetadata | null = null): Record<CloudSaveSlot, CloudSaveMetadata | null> {
  return { main, "1": null, "2": null, "3": null };
}

function normalizedCloudSaveSlots(
  main: CloudSaveMetadata | null,
  slots?: Partial<Record<CloudSaveSlot, CloudSaveMetadata | null>>,
): Record<CloudSaveSlot, CloudSaveMetadata | null> {
  return Object.fromEntries(CLOUD_SAVE_SLOTS.map((slot) => {
    const save = slots?.[slot] ?? (slot === "main" ? main : null);
    return [slot, save ? { ...save, slot } : null];
  })) as Record<CloudSaveSlot, CloudSaveMetadata | null>;
}

function normalizeCloudSaveMode(value: unknown): CloudSaveMode {
  return value === "speedrun" ? "speedrun" : "normal";
}

export function summarizeCloudPayload(payload: string): CloudSaveSummary | null {
  try {
    const integrity = inspectSaveEnvelopeChecksum(payload);
    const parsed = JSON.parse(payload) as Record<string, any>;
    const state = parsed?.state ?? parsed;
    if (!state || typeof state !== "object" || !Array.isArray(state.entities)) return null;
    return {
      mode: normalizeCloudSaveMode(parsed.mode ?? state.mode),
      stateVersion: typeof state.version === "number" ? Math.max(0, Math.floor(state.version)) : 0,
      savedAt: typeof parsed.savedAt === "number" ? Math.max(0, Math.floor(parsed.savedAt)) : 0,
      elapsedSeconds: typeof state.elapsedSeconds === "number" ? Math.max(0, Math.floor(state.elapsedSeconds)) : 0,
      activePlanetId: typeof state.activePlanetId === "string" ? state.activePlanetId : "home",
      entityCount: state.entities.length,
      completedTechCount: Array.isArray(state.research?.completedTechIds) ? state.research.completedTechIds.length : 0,
      structurePoints: typeof state.dysonSphere?.structurePoints === "number" ? Math.max(0, Math.floor(state.dysonSphere.structurePoints)) : 0,
      uploadedWhiteMatrix: typeof state.totalProduced?.universe_matrix === "number" ? Math.max(0, Math.floor(state.totalProduced.universe_matrix)) : 0,
      stateChecksum: typeof parsed.checksum === "string" ? parsed.checksum : null,
      computedStateChecksum: integrity.computedChecksum,
      integrity: integrity.status === "valid" ? "valid" : "invalid",
    };
  } catch {
    return null;
  }
}

export function getCloudSyncMarker(userId: string, slot: CloudSaveSlot = "main", mode: CloudSaveMode = "normal"): CloudSyncMarker | null {
  const markers = readCloudSyncMarkers();
  const marker = markers[cloudMarkerKey(userId, slot, mode)] ?? (mode === "normal" && slot === "main" ? markers[userId] : undefined);
  return marker && marker.userId === userId && (!marker.slot || marker.slot === slot) ? { ...marker, slot } : null;
}

export function markCloudSaveSynchronized(userId: string, cloudSave: CloudSaveMetadata, payload?: string, requestedSlot?: CloudSaveSlot, requestedMode?: CloudSaveMode): void {
  const slot = requestedSlot ?? cloudSave.slot ?? "main";
  const mode = requestedMode ?? cloudSave.mode ?? "normal";
  const markers = readCloudSyncMarkers();
  markers[cloudMarkerKey(userId, slot, mode)] = {
    userId,
    slot,
    revision: cloudSave.revision,
    cloudChecksum: cloudSave.checksum,
    stateChecksum: cloudSave.summary?.stateChecksum ?? (payload ? summarizeCloudPayload(payload)?.stateChecksum ?? null : null),
    syncedAt: Date.now(),
  };
  writeCloudSyncMarkers(markers);
}

export function clearCloudSyncMarker(userId: string, slot?: CloudSaveSlot, mode: CloudSaveMode = "normal"): void {
  const markers = readCloudSyncMarkers();
  if (slot) {
    delete markers[cloudMarkerKey(userId, slot, mode)];
    if (mode === "normal" && slot === "main") delete markers[userId];
  } else {
    delete markers[userId];
    for (const candidate of CLOUD_SAVE_SLOTS) {
      for (const candidateMode of ["normal", "speedrun"] as const) delete markers[cloudMarkerKey(userId, candidate, candidateMode)];
    }
  }
  writeCloudSyncMarkers(markers);
}

export function compareCloudSave(userId: string, localPayload: string | null, cloudSave: CloudSaveMetadata | null, slot: CloudSaveSlot = "main", mode: CloudSaveMode = "normal"): CloudSyncComparison {
  const local = localPayload ? summarizeCloudPayload(localPayload) : null;
  return compareCloudSaveSummary(userId, local, cloudSave, slot, mode);
}

/** Compare a payload using a summary produced by the upload Worker. */
export function compareCloudSaveSummary(userId: string, local: CloudSaveSummary | null, cloudSave: CloudSaveMetadata | null, slot: CloudSaveSlot = "main", mode: CloudSaveMode = "normal"): CloudSyncComparison {
  const marker = getCloudSyncMarker(userId, slot, mode);
  if (local?.mode && local.mode !== mode || cloudSave?.mode && cloudSave.mode !== mode) {
    return { state: "unbound", marker, local, cloud: cloudSave, localChanged: true, cloudChanged: true };
  }
  if (!local && !cloudSave) return { state: "empty", marker, local, cloud: cloudSave, localChanged: false, cloudChanged: false };
  if (local && !cloudSave) return { state: "local-only", marker, local, cloud: cloudSave, localChanged: true, cloudChanged: false };
  if (!local && cloudSave) return { state: "cloud-only", marker, local, cloud: cloudSave, localChanged: false, cloudChanged: true };
  if (!local || !cloudSave) return { state: "unbound", marker, local, cloud: cloudSave, localChanged: true, cloudChanged: true };
  if (!marker) {
    const sameState = Boolean(local.stateChecksum && cloudSave.summary?.stateChecksum && local.stateChecksum === cloudSave.summary.stateChecksum);
    return { state: sameState ? "synced" : "unbound", marker, local, cloud: cloudSave, localChanged: !sameState, cloudChanged: !sameState };
  }
  const localChanged = local.stateChecksum !== marker.stateChecksum;
  const cloudChanged = cloudSave.revision !== marker.revision || cloudSave.checksum !== marker.cloudChecksum;
  const state: CloudSyncState = localChanged && cloudChanged
    ? "conflict"
    : localChanged ? "local-newer"
      : cloudChanged ? "cloud-newer"
        : "synced";
  return { state, marker, local, cloud: cloudSave, localChanged, cloudChanged };
}

export function readCloudAutoSyncStatus(userId?: string): CloudAutoSyncStatus | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CLOUD_AUTO_SYNC_STORAGE_KEY) ?? "null") as CloudAutoSyncStatus | null;
    return parsed && (!userId || parsed.userId === userId) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCloudAutoSyncStatus(status: CloudAutoSyncStatus): void {
  try { window.localStorage.setItem(CLOUD_AUTO_SYNC_STORAGE_KEY, JSON.stringify(status)); } catch { /* optional status */ }
}

async function cloudRequest<T>(
  path: string,
  options: RequestInit = {},
  authenticated = false,
  allowInsecurePublicRead = false,
  transferBytes = 0,
  expectedResponseBytes = 0,
  sessionIssuance = false,
  preserveAuthenticationOnSessionFailure = false,
): Promise<T> {
  const base = cloudApiBase(allowInsecurePublicRead);
  if (!base) throw new CloudApiError(
    typeof window !== "undefined" && window.location.protocol === "http:"
      ? "云账户仅在 HTTPS 安全入口开放"
      : "原生应用未配置云服务地址",
    0,
  );
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), cloudRequestTimeoutMs(transferBytes, expectedResponseBytes));
  const externalSignal = options.signal;
  if (externalSignal?.aborted) {
    window.clearTimeout(timer);
    throw new DOMException("云存档上传已取消", "AbortError");
  }
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const headers = new Headers(options.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    let requestInit: RequestInit = {
      ...options,
      signal: controller.signal,
      headers,
    };
    if (authenticated) requestInit = prepareCloudAuthenticatedRequest(requestInit);
    else if (sessionIssuance && webCookieSessionEligible(base)) {
      requestInit = {
        ...requestInit,
        headers: webSessionIssuanceHeaders(requestInit.headers),
        credentials: "include",
      };
    }
    const response = await apiFetch(`${base}${path}`, requestInit);
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const code = payload.code;
      if (!preserveAuthenticationOnSessionFailure
        && response.status === 401
        && (code === "SESSION_EXPIRED" || code === "SESSION_REVOKED" || code === "AUTH_REQUIRED")) {
        clearCloudAuthenticationState();
      }
      throw new CloudApiError(typeof payload.error === "string" ? payload.error : `云服务返回 ${response.status}`, response.status, payload);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof CloudApiError) throw error;
    if (externalSignal?.aborted) throw new DOMException("云存档上传已取消", "AbortError");
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    throw new CloudApiError(timedOut ? "云服务连接超时" : "无法连接云服务", 0, {
      code: timedOut ? "CLOUD_REQUEST_TIMEOUT" : "CLOUD_REQUEST_NETWORK",
    });
  } finally {
    externalSignal?.removeEventListener("abort", abortFromCaller);
    window.clearTimeout(timer);
  }
}

export async function resumeCloudSession(mode: CloudSaveMode = "normal"): Promise<CloudSession> {
  try {
    const health = await cloudRequest<{ ok: boolean; mailProvider?: string }>("/health", {}, false, true);
    const mailAvailable = Boolean(health.mailProvider && health.mailProvider !== "disabled");
    if (isWebCloudRuntime()) {
      // Migration is opportunistic. Unsupported/temporarily unavailable new
      // endpoints must never prevent the retained legacy Bearer from working.
      await initializeCloudAuthentication().catch(() => webSessionMigrationState);
    }
    if (!hasCloudAuthentication()) return { status: "anonymous", user: null, cloudSave: null, mode, mailAvailable, message: null };
    try {
      const account = await cloudRequest<{ user: CloudUser; cloudSave: CloudSaveMetadata | null; cloudSaves?: Partial<Record<CloudSaveSlot, CloudSaveMetadata | null>>; cloudSavesByMode?: Partial<Record<CloudSaveMode, Partial<Record<CloudSaveSlot, CloudSaveMetadata | null>>>> }>("/account", {}, true);
      const selected = account.cloudSavesByMode?.[mode];
      const cloudSaves = normalizedCloudSaveSlots(
        mode === "normal" ? account.cloudSave : selected?.main ?? null,
        selected ?? (mode === "normal" ? account.cloudSaves : undefined),
      );
      return { status: "authenticated", user: account.user, cloudSave: cloudSaves.main, cloudSaves, mode, cloudSavesByMode: account.cloudSavesByMode as CloudSession["cloudSavesByMode"], mailAvailable, message: null };
    } catch (error) {
      return { status: "anonymous", user: null, cloudSave: null, mode, mailAvailable, message: error instanceof Error ? error.message : null };
    }
  } catch (error) {
    return { status: "offline", user: null, cloudSave: null, mode, mailAvailable: false, message: error instanceof Error ? error.message : "云服务离线" };
  }
}

interface CloudSessionIssuanceResponse {
  token?: unknown;
  session?: unknown;
}

async function acceptCloudSessionIssuance(result: CloudSessionIssuanceResponse): Promise<"cookie" | "bearer"> {
  const cookieSession = parseWebCookieSessionPayload(result);
  if (cookieSession && isWebCloudRuntime()) {
    const confirmation = await cloudRequest<CloudSessionIssuanceResponse>("/auth/web-session", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: webSessionIssuanceHeaders(),
    }, false, false, 0, 0, false, true);
    const confirmed = parseWebCookieSessionPayload(confirmation);
    if (!confirmed || confirmed.csrfToken !== cookieSession.csrfToken || confirmed.expiresAt !== cookieSession.expiresAt) {
      throw new CloudApiError("浏览器未能确认安全云会话，请重试登录", 0, {
        code: "CLOUD_COOKIE_SESSION_CONFIRMATION_FAILED",
      });
    }
    applyWebSessionMigrationState({
      phase: "ready",
      session: confirmed,
      legacyTokenPresent: false,
      attempt: webSessionMigrationState.attempt,
      reason: null,
      retryable: false,
    });
    // The secret is now HttpOnly. Remove any previous JS-readable credential
    // only after a structurally valid Cookie response was received.
    setCloudToken(null);
    return "cookie";
  }
  if (typeof result.token !== "string" || result.token.length < 1 || result.token.length > 4_096 || /[\r\n]/.test(result.token)) {
    throw new CloudApiError("云服务返回的会话凭据无效", 0, { code: "CLOUD_SESSION_RESPONSE_INVALID" });
  }
  applyWebSessionMigrationState(clearWebCookieSessionState());
  setCloudToken(result.token);
  return "bearer";
}

export async function registerCloudAccount(username: string, password: string, displayName: string): Promise<CloudSession> {
  const result = await cloudRequest<CloudSessionIssuanceResponse & { user: CloudUser; mailAvailable?: boolean }>("/auth/register", { method: "POST", body: JSON.stringify({ username, password, displayName, deviceId: cloudDeviceId() }) }, false, false, 0, 0, true);
  await acceptCloudSessionIssuance(result);
  return { status: "authenticated", user: result.user, cloudSave: null, cloudSaves: emptyCloudSaveSlots(), mailAvailable: result.mailAvailable === true, message: null };
}

export async function loginCloudAccount(identifier: string, password: string): Promise<CloudSession> {
  const result = await cloudRequest<CloudSessionIssuanceResponse & { user: CloudUser; security?: { newDevice: boolean; newRegion: boolean; message: string | null } }>("/auth/login", { method: "POST", body: JSON.stringify({ identifier, password, deviceId: cloudDeviceId() }) }, false, false, 0, 0, true);
  await acceptCloudSessionIssuance(result);
  const resumed = await resumeCloudSession();
  return resumed.status === "authenticated"
    ? { ...resumed, message: result.security?.message ?? null }
    : { status: "authenticated", user: result.user, cloudSave: null, cloudSaves: emptyCloudSaveSlots(), mailAvailable: resumed.mailAvailable, message: result.security?.message ?? null };
}

export async function logoutCloudAccount(): Promise<void> {
  try { await cloudRequest("/auth/logout", { method: "POST" }, true); } finally { clearCloudAuthenticationState(); }
}

export async function verifyCloudEmail(token: string): Promise<CloudUser> {
  const result = await cloudRequest<{ user: CloudUser }>("/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });
  return result.user;
}

export async function resendCloudVerification(): Promise<void> {
  await cloudRequest("/auth/resend-verification", { method: "POST" }, true);
}

export async function bindCloudEmail(email: string): Promise<CloudUser> {
  const result = await cloudRequest<{ user: CloudUser }>("/account/email", {
    method: "POST",
    body: JSON.stringify({ email }),
  }, true);
  return result.user;
}

export async function requestCloudPasswordReset(email: string): Promise<string> {
  const result = await cloudRequest<{ message: string }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
  return result.message;
}

export async function resetCloudPassword(token: string, password: string): Promise<CloudSession> {
  const result = await cloudRequest<CloudSessionIssuanceResponse & { user: CloudUser; security?: { message: string | null } }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password, deviceId: cloudDeviceId() }) }, false, false, 0, 0, true);
  await acceptCloudSessionIssuance(result);
  const resumed = await resumeCloudSession();
  return resumed.status === "authenticated"
    ? { ...resumed, message: result.security?.message ?? null }
    : { status: "authenticated", user: result.user, cloudSave: null, cloudSaves: emptyCloudSaveSlots(), mailAvailable: resumed.mailAvailable, message: result.security?.message ?? null };
}

export async function changeCloudPassword(currentPassword: string, newPassword: string): Promise<CloudUser> {
  const result = await cloudRequest<{ user: CloudUser }>("/account/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  }, true);
  return result.user;
}

export async function fetchCloudSessions(): Promise<CloudAccountSession[]> {
  const result = await cloudRequest<{ sessions: CloudAccountSession[] }>("/account/sessions", {}, true);
  return result.sessions;
}

export async function fetchCloudSecurityEvents(): Promise<CloudLoginSecurityEvent[]> {
  const result = await cloudRequest<{ events: CloudLoginSecurityEvent[] }>("/account/security-events", {}, true);
  // Keep the client compatible with an older node (or a partial test double)
  // during a rolling deployment. The ledger is supplemental account metadata;
  // absence must not make the primary cloud-save controls unusable.
  return Array.isArray(result.events) ? result.events : [];
}

export async function revokeCloudSession(sessionId: string): Promise<{ currentSessionRevoked: boolean }> {
  const result = await cloudRequest<{ currentSessionRevoked: boolean }>("/account/sessions/revoke", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  }, true);
  if (result.currentSessionRevoked) clearCloudAuthenticationState();
  return result;
}

export async function revokeAllCloudSessions(): Promise<{ currentSessionRevoked: boolean; revokedCount: number }> {
  const result = await cloudRequest<{ currentSessionRevoked: boolean; revokedCount: number }>("/account/sessions/revoke-all", {
    method: "POST",
    body: "{}",
  }, true);
  if (result.currentSessionRevoked) clearCloudAuthenticationState();
  return result;
}

export async function exportCloudAccountData(): Promise<CloudAccountExport> {
  return cloudRequest<CloudAccountExport>("/account/export", {}, true);
}

function legacyJsonImportResponseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudApiError(`${label}格式无效`, 0, { code: "CLOUD_RESPONSE_INVALID" });
  }
  return value as Record<string, unknown>;
}

function legacyJsonImportSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CloudApiError(`${label}格式无效`, 0, { code: "CLOUD_RESPONSE_INVALID" });
  }
  return value as number;
}

function normalizeLegacyJsonImportResult(value: unknown): CloudAccountArchiveImportResult {
  const source = legacyJsonImportResponseRecord(value, "旧版 JSON 账号导入响应");
  if (source.imported !== true) {
    throw new CloudApiError("旧版 JSON 账号导入响应缺少成功标记", 0, { code: "CLOUD_RESPONSE_INVALID" });
  }
  if (typeof source.guard !== "string" || !/^[a-f0-9]{64}$/.test(source.guard)) {
    throw new CloudApiError("旧版 JSON 账号导入响应 guard 无效", 0, { code: "CLOUD_RESPONSE_INVALID" });
  }
  const modes = legacyJsonImportResponseRecord(source.modes, "旧版 JSON 导入后模式槽位");
  const revalidation = legacyJsonImportResponseRecord(
    source.leaderboardRevalidationRequired,
    "旧版 JSON 排行榜复核状态",
  );
  const normalizedModes = Object.fromEntries((["normal", "speedrun"] as const).map((mode) => [
    mode,
    legacyJsonImportResponseRecord(modes[mode], `${mode} 模式槽位`),
  ])) as CloudAccountArchiveImportResult["modes"];
  const normalizedRevalidation = Object.fromEntries((["normal", "speedrun"] as const).map((mode) => {
    if (typeof revalidation[mode] !== "boolean") {
      throw new CloudApiError(`${mode} 排行榜复核状态无效`, 0, { code: "CLOUD_RESPONSE_INVALID" });
    }
    return [mode, revalidation[mode]];
  })) as CloudAccountArchiveImportResult["leaderboardRevalidationRequired"];
  return {
    imported: true,
    revisionCount: legacyJsonImportSafeInteger(source.revisionCount, "旧版 JSON 导入修订数"),
    logicalBytes: legacyJsonImportSafeInteger(source.logicalBytes, "旧版 JSON 导入逻辑字节数"),
    guard: source.guard,
    modes: normalizedModes,
    leaderboardRevalidationRequired: normalizedRevalidation,
  };
}

function rethrowLegacyJsonImportError(error: unknown): never {
  if (!(error instanceof CloudApiError)) throw error;
  const code = typeof error.payload.code === "string" ? error.payload.code : "";
  if (code === "ACCOUNT_ARCHIVE_LEGACY_JSON_HISTORY_UNRESTORABLE") {
    throw new CloudApiError(
      "旧版 JSON 含有缺少正文、无法安全恢复的独立历史修订；请改用 ZIP 账号归档。现有云存档未修改。",
      error.status,
      error.payload,
    );
  }
  if (code === "ACCOUNT_ARCHIVE_MODE_MISMATCH") {
    throw new CloudApiError(
      "旧版 JSON 的普通/速通模式标记不匹配；缺少模式不会被推断为速通。现有云存档未修改。",
      error.status,
      error.payload,
    );
  }
  if (error.status === 404 || error.status === 501) {
    throw new CloudApiError(
      "当前云节点尚不支持旧版 JSON 账号导入；请优先使用 ZIP 账号归档。现有云存档未修改。",
      error.status,
      { ...error.payload, code: "LEGACY_JSON_IMPORT_UNSUPPORTED" },
    );
  }
  if (!/现有云存档未修改/.test(error.message)) {
    throw new CloudApiError(`${error.message}；现有云存档未修改`, error.status, error.payload);
  }
  throw error;
}

/**
 * Imports a player-selected pre-ZIP account export without parsing or rewriting
 * it on the client. The server remains authoritative for UTF-8, identity,
 * schema, checksum, mode and quota validation before its atomic replacement.
 */
export async function importLegacyJsonCloudAccountArchive(
  archive: Blob,
  preview: CloudAccountArchiveImportPreview,
): Promise<CloudAccountArchiveImportResult> {
  if (typeof Blob === "undefined" || !(archive instanceof Blob) || archive.size < 1) {
    throw new CloudApiError("请选择有效的旧版 JSON 账号导出文件", 0, {
      code: "ACCOUNT_ARCHIVE_IMPORT_FILE_INVALID",
    });
  }
  if (!preview || !/^[a-f0-9]{64}$/.test(preview.guard)
    || preview.confirmation !== `REPLACE_CLOUD_SAVES:${preview.guard}`) {
    throw new CloudApiError("账号归档导入确认信息无效，请重新预检", 0, {
      code: "ACCOUNT_ARCHIVE_IMPORT_CONFIRMATION_INVALID",
    });
  }
  try {
    const response = await cloudRequest<unknown>("/account/import/legacy-json", {
      method: "POST",
      headers: {
        "content-type": CLOUD_ACCOUNT_LEGACY_JSON_CONTENT_TYPE,
        "x-dsp-account-import-guard": preview.guard,
        "x-dsp-account-import-confirmation": preview.confirmation,
      },
      body: archive,
    }, true, false, archive.size);
    return normalizeLegacyJsonImportResult(response);
  } catch (error) {
    return rethrowLegacyJsonImportError(error);
  }
}

export async function deleteCloudAccount(password: string): Promise<void> {
  await cloudRequest("/account/delete", {
    method: "POST",
    body: JSON.stringify({ password, confirmation: "DELETE" }),
  }, true);
  clearCloudAuthenticationState();
}

function cloudSaveQuery(slot: CloudSaveSlot, revision?: number, mode: CloudSaveMode = "normal"): string {
  const parameters = new URLSearchParams();
  if (slot !== "main") parameters.set("slot", slot);
  if (mode !== "normal") parameters.set("mode", mode);
  if (revision) parameters.set("revision", String(revision));
  const query = parameters.toString();
  return query ? `?${query}` : "";
}

export async function uploadCloudSave(
  payload: string,
  expectedRevision: number,
  slot: CloudSaveSlot = "main",
  options: CloudUploadOptions = {},
): Promise<CloudSaveMetadata> {
  return uploadCloudSaveWithOptions(payload, expectedRevision, slot, options);
}

function isUncertainCloudRequestError(error: unknown): error is CloudApiError {
  return error instanceof CloudApiError
    && error.status === 0
    && (error.payload.code === "CLOUD_REQUEST_TIMEOUT" || error.payload.code === "CLOUD_REQUEST_NETWORK");
}

function cloudMetadataMatchesPayload(
  remote: CloudSaveMetadata,
  expectedRevision: number,
  payloadChecksum: string,
  payloadBytes: number,
): boolean {
  return remote.revision === expectedRevision + 1 && remote.checksum === payloadChecksum && remote.size === payloadBytes;
}

/** Re-read only the current cloud metadata after an uncertain upload response. */
export async function refreshCloudSaveMetadata(slot: CloudSaveSlot = "main", signal?: AbortSignal, mode: CloudSaveMode = "normal"): Promise<CloudSaveMetadata | null> {
  const result = await cloudRequest<{
    cloudSave: CloudSaveMetadata | null;
    cloudSaves?: Partial<Record<CloudSaveSlot, CloudSaveMetadata | null>>;
    cloudSavesByMode?: Partial<Record<CloudSaveMode, Partial<Record<CloudSaveSlot, CloudSaveMetadata | null>>>>;
  }>("/account", { signal, ...(mode !== "normal" ? { headers: { "x-dsp-save-mode": mode } } : {}) }, true);
  const modeSlots = result.cloudSavesByMode?.[mode];
  const save = modeSlots?.[slot] ?? (mode === "normal" ? result.cloudSaves?.[slot] ?? (slot === "main" ? result.cloudSave : null) : null);
  return save ? { ...save, slot, mode } : null;
}

function unknownCloudUploadState(): CloudApiError {
  return new CloudApiError("云存档上传状态未知，请重新打开云存档核对修订号", 0, {
    code: "CLOUD_UPLOAD_STATUS_UNKNOWN",
  });
}

function conflictFromCloudSave(cloudSave: CloudSaveMetadata): CloudApiError {
  return new CloudApiError("云端已有更新版本，请先下载或确认覆盖", 409, { cloudSave });
}

async function fetchCloudOperationReceipt(requestId: string): Promise<CloudSaveMetadata | null> {
  try {
    const result = await cloudRequest<{
      receipt?: {
        status?: string;
        result?: { cloudSave?: CloudSaveMetadata };
      };
    }>(`/operations/${encodeURIComponent(requestId)}`, {}, true);
    const receipt = result.receipt;
    return receipt?.status === "succeeded" && receipt.result?.cloudSave
      ? receipt.result.cloudSave
      : null;
  } catch (error) {
    // 1.0.39 APIs do not expose operation receipts. Preserve rolling-upgrade
    // compatibility and let exact revision/checksum confirmation remain the
    // fallback instead of converting an old-server 404 into an upload error.
    if (error instanceof CloudApiError && error.status === 404) return null;
    return null;
  }
}

async function confirmTimedOutUpload(
  expectedRevision: number,
  slot: CloudSaveSlot,
  mode: CloudSaveMode,
  payloadChecksum: string,
  payloadBytes: number,
  requestId?: string,
): Promise<{ state: "confirmed" | "unobserved"; cloudSave?: CloudSaveMetadata }> {
  let cloudSave: CloudSaveMetadata | null;
  try {
    cloudSave = await refreshCloudSaveMetadata(slot, undefined, mode);
  } catch (error) {
    const receiptSave = requestId ? await fetchCloudOperationReceipt(requestId) : null;
    if (receiptSave && cloudMetadataMatchesPayload(receiptSave, expectedRevision, payloadChecksum, payloadBytes)) {
      return { state: "confirmed", cloudSave: { ...receiptSave, slot, mode } };
    }
    throw unknownCloudUploadState();
  }
  if (cloudSave && cloudSave.revision > expectedRevision) {
    if (cloudMetadataMatchesPayload(cloudSave, expectedRevision, payloadChecksum, payloadBytes)) return { state: "confirmed", cloudSave };
    const receiptSave = requestId ? await fetchCloudOperationReceipt(requestId) : null;
    if (receiptSave && cloudMetadataMatchesPayload(receiptSave, expectedRevision, payloadChecksum, payloadBytes)) {
      return { state: "confirmed", cloudSave: { ...receiptSave, slot, mode } };
    }
    throw conflictFromCloudSave(cloudSave);
  }
  if ((cloudSave?.revision ?? 0) !== expectedRevision) throw unknownCloudUploadState();
  const receiptSave = requestId ? await fetchCloudOperationReceipt(requestId) : null;
  if (receiptSave && cloudMetadataMatchesPayload(receiptSave, expectedRevision, payloadChecksum, payloadBytes)) {
    return { state: "confirmed", cloudSave: { ...receiptSave, slot, mode } };
  }
  return { state: "unobserved" };
}

export async function uploadCloudSaveWithOptions(
  payload: string,
  expectedRevision: number,
  slot: CloudSaveSlot = "main",
  options: CloudUploadOptions = {},
): Promise<CloudSaveMetadata> {
  const mode = options.mode ?? summarizeCloudPayload(payload)?.mode ?? "normal";
  if (!validCloudExpectedRevision(expectedRevision)) {
    throw new CloudApiError("云存档预期修订无效", 400, { code: "EXPECTED_REVISION_INVALID" });
  }
  const uploadStartedAt = performance.now();
  if (!options.verified) {
    const integrity = inspectSaveEnvelopeChecksum(payload);
    if (integrity.status !== "valid") {
      throw new CloudApiError("云存档上传前完整性自检失败，请先在存档管理中导出备份并使用救援入口", 0, {
        code: "SAVE_INTEGRITY_INVALID",
        recordedChecksum: integrity.recordedChecksum,
        computedChecksum: integrity.computedChecksum,
      });
    }
  }
  if (options.signal?.aborted) throw new DOMException("云存档上传已取消", "AbortError");
  const hasWorkerProof = /^[a-f0-9]{64}$/.test(options.payloadSha256 ?? "") &&
    Number.isSafeInteger(options.payloadByteLength) && options.payloadByteLength! > 0;
  const payloadBytes = hasWorkerProof ? options.payloadByteLength! : utf8Bytes(payload);
  if (hasWorkerProof && payload.length > payloadBytes) {
    throw new CloudApiError("云存档 Worker 字节证明无效", 0, { code: "SAVE_TRANSFER_PROOF_INVALID" });
  }
  if (payloadBytes > CLOUD_TRANSFER_CONTRACT.savePayloadLimitBytes) {
    const capacity = cloudSaveCapacityDetails(payloadBytes);
    throw new CloudApiError(cloudSaveSizeErrorMessage(capacity), 413, {
      code: "SAVE_SIZE_TOO_LARGE",
      payloadBytes,
      ...capacity,
    });
  }
  const rawBody = payload;
  const rawBodyBytes = payloadBytes;
  const size = assessSavePayloadSize(payloadBytes);
  const payloadChecksum = hasWorkerProof
    ? options.payloadSha256!
    : await sha256Text(payload);
  if (payloadBytes > CLOUD_SAVE_LARGE_ENDGAME_BYTES) {
    try {
      const plan = await preflightCloudSaveUpload(payloadBytes, payloadChecksum, slot, mode);
      if (!plan.accepted) {
        const payloadLimitBytes = typeof plan.limits?.revisionBytes === "number"
          ? plan.limits.revisionBytes
          : CLOUD_TRANSFER_CONTRACT.savePayloadLimitBytes;
        throw new CloudApiError("云存档容量预检未通过；大文件正文尚未发送，本地和云端旧修订均未修改", plan.reason === "revisionBytes" ? 413 : 507, {
          code: plan.code ?? "CLOUD_QUOTA_EXCEEDED",
          payloadBytes,
          originalBytes: payloadBytes,
          expandedBytes: payloadBytes,
          payloadLimitBytes,
          ...(plan.reason && typeof plan.limits?.[plan.reason] === "number"
            ? { quotaLimitBytes: plan.limits[plan.reason] }
            : {}),
          plan,
        });
      }
    } catch (error) {
      // During API-first rolling upgrades an older server may not expose the
      // small quota-preflight endpoint yet. Keep its established upload path;
      // all other preflight failures are authoritative and stop before PUT.
      if (!(error instanceof CloudApiError && error.status === 404)) throw error;
    }
  }
  if (options.signal?.aborted) throw new DOMException("云存档上传已取消", "AbortError");
  let diagnostics: CloudUploadDiagnostics = {
    status: "running",
    stage: "compressing",
    slot,
    payloadBytes,
    requestBytes: rawBodyBytes,
    compressedBytes: null,
    sizeTier: size.tier,
    compressionMs: 0,
    networkMs: 0,
    totalMs: 0,
    attempts: 0,
    usedCompression: false,
    usedRawFallback: false,
    capacity: cloudSaveCapacityDetails(payloadBytes),
  };
  const emitDiagnostics = (changes: Partial<CloudUploadDiagnostics> = {}) => {
    diagnostics = { ...diagnostics, ...changes, totalMs: Math.max(0, performance.now() - uploadStartedAt) };
    persistCloudUploadDiagnostics(diagnostics);
    options.onDiagnostics?.(diagnostics);
  };
  const stage = (next: CloudUploadStage) => {
    options.onStage?.(next);
    emitDiagnostics({ stage: next });
  };
  try {
    stage("compressing");
    const compressionStartedAt = performance.now();
    const compressed = await compressCloudRequestBody(rawBody, options.signal, options.runtimePlatform, options.androidGzipSupported, rawBodyBytes);
    emitDiagnostics({
      compressionMs: Math.max(0, performance.now() - compressionStartedAt),
      compressedBytes: compressed?.body.size ?? null,
      capacity: cloudSaveCapacityDetails(payloadBytes, compressed?.body.size ?? null),
      usedCompression: Boolean(compressed),
      ...(compressed ? {} : {
        fallbackReason: "compression-unavailable-timeout-or-not-beneficial",
      }),
    });
    if (options.signal?.aborted) throw new DOMException("云存档上传已取消", "AbortError");
    if (!compressed) assertRawCloudRetryAllowed(rawBodyBytes);

    const legacyBody = () => JSON.stringify({ payload, expectedRevision });
    // A gzip/raw compatibility retry is still the same logical upload. Reuse
    // one operation id so a lost response cannot create a second revision.
    // The legacy JSON fallback intentionally carries no protocol-specific id.
    const requestId = createCloudRequestId();

    const send = async (
      body: BodyInit,
      headers?: Record<string, string>,
      protocol: "direct" | "legacy" = "direct",
    ): Promise<CloudSaveMetadata> => {
      const rawAttempt = !headers?.["content-encoding"];
      stage("sending");
      emitDiagnostics({ attempts: diagnostics.attempts + 1, usedRawFallback: diagnostics.usedRawFallback || rawAttempt && diagnostics.attempts > 0 });
      stage("waiting");
      const requestStartedAt = performance.now();
      try {
        const requestBytes = body instanceof Blob ? body.size : typeof body === "string" ? rawBodyBytes : payloadBytes;
        const result = await cloudRequest<{ cloudSave: CloudSaveMetadata }>(`/cloud-save${cloudSaveQuery(slot, undefined, mode)}`, {
          method: "PUT",
          body,
          headers: protocol === "legacy" ? {
            "content-type": "application/json",
            ...(headers ?? {}),
          } : {
              "content-type": CLOUD_TRANSFER_CONTRACT.directPayloadContentType,
              [CLOUD_TRANSFER_CONTRACT.expectedRevisionHeader]: String(expectedRevision),
              [CLOUD_TRANSFER_CONTRACT.requestIdHeader]: requestId,
              [CLOUD_TRANSFER_CONTRACT.originalBytesHeader]: String(rawBodyBytes),
              ...(headers ?? {}),
            },
          signal: options.signal,
        }, true, false, Math.max(requestBytes, rawBodyBytes));
        emitDiagnostics({
          status: "success",
          networkMs: diagnostics.networkMs + Math.max(0, performance.now() - requestStartedAt),
        });
        return { ...result.cloudSave, slot, mode };
      } catch (error) {
        const cancelled = options.signal?.aborted || error instanceof DOMException && error.name === "AbortError";
        emitDiagnostics({
          status: cancelled ? "cancelled" : "running",
          networkMs: diagnostics.networkMs + Math.max(0, performance.now() - requestStartedAt),
          lastErrorCode: error instanceof CloudApiError && typeof error.payload.code === "string"
            ? error.payload.code
            : cancelled ? "ABORTED" : "CLOUD_REQUEST_FAILED",
        });
        throw error;
      }
    };

    const resolveRawRetryFailure = async (retryError: unknown): Promise<CloudSaveMetadata> => {
      if (retryError instanceof CloudApiError && retryError.status === 409) {
        stage("confirming");
        const finalConfirmation = await confirmTimedOutUpload(expectedRevision, slot, mode, payloadChecksum, payloadBytes, requestId);
        if (finalConfirmation.state === "confirmed" && finalConfirmation.cloudSave) {
          emitDiagnostics({ status: "success", fallbackReason: "retry-response-lost-server-confirmed" });
          return finalConfirmation.cloudSave;
        }
        throw retryError;
      }
      if (!isUncertainCloudRequestError(retryError)) throw retryError;
      stage("confirming");
      const finalConfirmation = await confirmTimedOutUpload(expectedRevision, slot, mode, payloadChecksum, payloadBytes, requestId);
      if (finalConfirmation.state === "confirmed" && finalConfirmation.cloudSave) {
        emitDiagnostics({ status: "success", fallbackReason: "retry-timeout-server-confirmed" });
        return finalConfirmation.cloudSave;
      }
      throw unknownCloudUploadState();
    };

    try {
      return await send(compressed?.body ?? rawBody, compressed?.headers);
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 400 && error.payload.code === "SAVE_FORMAT_INVALID" && error.payload.directPayloadSupported !== true) {
        const wrapped = legacyBody();
        const wrappedBytes = utf8Bytes(wrapped);
        if (wrappedBytes > CLOUD_TRANSFER_CONTRACT.legacyJsonRequestLimitBytes) throw error;
        emitDiagnostics({ usedRawFallback: true, fallbackReason: "legacy-api-direct-payload-unsupported" });
        try {
          return await send(wrapped, undefined, "legacy");
        } catch (retryError) {
          return resolveRawRetryFailure(retryError);
        }
      }
      if (compressed && error instanceof CloudApiError && error.status === 400 && error.payload.code === "REQUEST_ENCODING_INVALID") {
        assertRawCloudRetryAllowed(rawBodyBytes);
        emitDiagnostics({ usedRawFallback: true, fallbackReason: "server-rejected-content-encoding" });
        try {
          return await send(rawBody);
        } catch (retryError) {
          return resolveRawRetryFailure(retryError);
        }
      }
      const sentRequestWasCancelled = options.signal?.aborted || error instanceof DOMException && error.name === "AbortError";
      if (!isUncertainCloudRequestError(error) && !sentRequestWasCancelled) throw error;
      stage("confirming");
      const confirmation = await confirmTimedOutUpload(expectedRevision, slot, mode, payloadChecksum, payloadBytes, requestId);
      if (confirmation.state === "confirmed" && confirmation.cloudSave) {
        emitDiagnostics({ status: "success", fallbackReason: sentRequestWasCancelled ? "cancelled-server-confirmed" : "network-timeout-server-confirmed" });
        return confirmation.cloudSave;
      }
      emitDiagnostics({ fallbackReason: sentRequestWasCancelled ? "cancelled-status-unconfirmed" : "network-status-unconfirmed" });
      throw unknownCloudUploadState();
    }
  } catch (error) {
    if (diagnostics.status !== "success") {
      const cancelled = options.signal?.aborted || error instanceof DOMException && error.name === "AbortError";
      emitDiagnostics({
        status: cancelled ? "cancelled" : "failed",
        lastErrorCode: error instanceof CloudApiError && typeof error.payload.code === "string"
          ? error.payload.code
          : cancelled ? "ABORTED" : diagnostics.lastErrorCode ?? "CLOUD_UPLOAD_FAILED",
      });
    }
    if (error instanceof CloudApiError) {
      const described = describeCloudUploadError(error, payloadBytes, diagnostics.compressedBytes);
      if (described.capacity) throw new CloudApiError(described.message, error.status, { ...error.payload, ...described.capacity });
    }
    throw error;
  }
}

/**
 * Compress a request while continuously consuming the output stream. Starting
 * the writer before the reader can deadlock on browser stream backpressure.
 */
export async function compressCloudRequestBody(
  rawBody: string,
  signal?: AbortSignal,
  runtimePlatform: CloudUploadRuntimePlatform = cloudUploadRuntimePlatform(),
  androidGzipSupported = androidBase64RequestSupported(),
  knownRawBodyBytes?: number,
): Promise<{ body: Blob; headers: Record<string, string> } | null> {
  if (signal?.aborted) throw new DOMException("云存档上传已取消", "AbortError");
  if (
    runtimePlatform === "android" && !androidGzipSupported
    || typeof CompressionStream === "undefined"
    || typeof TextEncoder === "undefined"
    || typeof Blob === "undefined"
    || typeof ReadableStream === "undefined"
  ) return null;
  const rawBodyBytes = Number.isSafeInteger(knownRawBodyBytes) && knownRawBodyBytes! >= 0
    ? knownRawBodyBytes!
    : utf8Bytes(rawBody);
  if (rawBodyBytes < CLOUD_COMPRESSION_MIN_BYTES) return null;

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let rejectControl: (reason?: unknown) => void = () => undefined;
  let timedOut = false;
  const control = new Promise<never>((_, reject) => { rejectControl = reject; });
  const chunks: Uint8Array[] = [];
  let compressedBytes = 0;
  let readAll: Promise<void> = Promise.resolve();
  let timeout: number | null = null;
  let onAbort: (() => void) | null = null;
  try {
    const compressor = new CompressionStream("gzip");
    const source = typeof Blob.prototype.stream === "function"
      ? new Blob([rawBody]).stream()
      : new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(rawBody));
          controller.close();
        },
      });
    const compressedStream = source.pipeThrough(compressor as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    reader = compressedStream.getReader();
    readAll = (async () => {
      while (true) {
        const result = await reader!.read();
        if (result.done) return;
        if (result.value) {
          const chunk = new Uint8Array(result.value);
          chunks.push(chunk);
          compressedBytes += chunk.byteLength;
        }
      }
    })();
    onAbort = () => {
      void reader?.cancel();
      rejectControl(new DOMException("云存档上传已取消", "AbortError"));
    };
    timeout = window.setTimeout(() => {
      timedOut = true;
      void reader?.cancel();
      rejectControl(new Error("云存档压缩超时"));
    }, CLOUD_COMPRESSION_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    await Promise.race([readAll, control]);
    if (signal?.aborted) throw new DOMException("云存档上传已取消", "AbortError");
    if (compressedBytes >= rawBodyBytes) return null;
    if (
      runtimePlatform === "android"
      && rawBodyBytes <= CLOUD_UPLOAD_RAW_FALLBACK_LIMIT_BYTES
      && Math.ceil(compressedBytes * 4 / 3) >= rawBodyBytes
    ) return null;
    return {
      body: new Blob(chunks.map((chunk) => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer), { type: "application/json" }),
      headers: {
        "content-encoding": "gzip",
        "x-dsp-save-original-bytes": String(rawBodyBytes),
        "x-dsp-save-compressed-bytes": String(compressedBytes),
      },
    };
  } catch (error) {
    if (signal?.aborted) {
      throw new DOMException("云存档上传已取消", "AbortError");
    }
    return null;
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (timedOut) void readAll.catch(() => undefined);
    try { reader?.releaseLock(); } catch { /* stream is already cancelled */ }
  }
}

export async function downloadCloudSave(revision?: number, slot: CloudSaveSlot = "main", mode: CloudSaveMode = "normal"): Promise<CloudSave | null> {
  const result = await cloudRequest<{ cloudSave: CloudSave | null }>(
    `/cloud-save${cloudSaveQuery(slot, revision, mode)}`,
    {},
    true,
    false,
    0,
    CLOUD_TRANSFER_CONTRACT.singleSaveResponseLimitBytes,
  );
  if (!result.cloudSave) return null;
  const payloadMode = summarizeCloudPayload(result.cloudSave.payload)?.mode;
  const metadataMode = result.cloudSave.mode === undefined ? mode : normalizeCloudSaveMode(result.cloudSave.mode);
  if (payloadMode !== mode || metadataMode !== mode) {
    throw new CloudApiError("云存档模式与当前工厂不匹配，已阻止恢复", 409, {
      code: "SAVE_MODE_MISMATCH",
      expectedMode: mode,
      receivedMode: payloadMode ?? metadataMode,
    });
  }
  if (result.cloudSave.slot !== undefined && result.cloudSave.slot !== slot) {
    throw new CloudApiError("云存档槽位与请求目标不匹配，已阻止恢复", 409, {
      code: "SAVE_SLOT_MISMATCH",
      expectedSlot: slot,
      receivedSlot: result.cloudSave.slot,
    });
  }
  return { ...result.cloudSave, slot, mode };
}

export async function fetchCloudTransferLimits(): Promise<{
  cloudQuota: Record<string, unknown>;
  transferLimits: CloudTransferLimits;
}> {
  return cloudRequest("/cloud-save/quota", {}, true);
}

export async function preflightCloudSaveUpload(
  size: number,
  checksum: string,
  slot: CloudSaveSlot = "main",
  mode: CloudSaveMode = "normal",
): Promise<CloudQuotaPreflightPlan> {
  const result = await cloudRequest<{ plan: CloudQuotaPreflightPlan }>("/cloud-save/quota", {
    method: "POST",
    body: JSON.stringify({ size, checksum, slot, mode }),
  }, true);
  return result.plan;
}

export async function fetchCloudSaveHistory(slot: CloudSaveSlot = "main", mode: CloudSaveMode = "normal"): Promise<CloudSaveMetadata[]> {
  const result = await cloudRequest<{ history: CloudSaveMetadata[] }>(`/cloud-save/history${cloudSaveQuery(slot, undefined, mode)}`, {}, true);
  return result.history.map((save) => ({ ...save, slot, mode }));
}

export async function restoreCloudSaveRevision(revision: number, expectedRevision: number, slot: CloudSaveSlot = "main", mode: CloudSaveMode = "normal"): Promise<CloudSaveMetadata> {
  const result = await cloudRequest<{ cloudSave: CloudSaveMetadata }>(`/cloud-save/restore${cloudSaveQuery(slot, undefined, mode)}`, { method: "POST", body: JSON.stringify({ revision, expectedRevision }) }, true);
  return { ...result.cloudSave, slot, mode };
}

export async function deleteCloudSave(slot: CloudSaveSlot, expectedRevision: number, mode: CloudSaveMode = "normal"): Promise<void> {
  await cloudRequest(`/cloud-save${cloudSaveQuery(slot, undefined, mode)}`, {
    method: "DELETE",
    body: JSON.stringify({
      expectedRevision,
      confirmation: `DELETE_CLOUD_SAVE:${mode}:${slot}`,
    }),
  }, true);
}

export async function fetchCloudLeaderboard(category: LeaderboardCategoryId, seasonId: string): Promise<CloudLeaderboardEntry[]> {
  const result = await cloudRequest<{ entries: CloudLeaderboardEntry[] }>(`/leaderboard?category=${encodeURIComponent(category)}&seasonId=${encodeURIComponent(seasonId)}`, {}, false, true);
  const normalizeEntry = (entry: CloudLeaderboardEntry): CloudLeaderboardEntry => ({
    ...entry,
    metrics: normalizeLeaderboardMetrics(entry.metrics),
  });
  return result.entries.map(normalizeEntry);
}

export async function fetchCloudLeaderboardMe(category: LeaderboardCategoryId, seasonId: string): Promise<CloudLeaderboardMe> {
  const result = await cloudRequest<CloudLeaderboardMe>(`/leaderboard/me?category=${encodeURIComponent(category)}&seasonId=${encodeURIComponent(seasonId)}`, {}, true);
  return {
    ...result,
    entry: result.entry ? { ...result.entry, metrics: normalizeLeaderboardMetrics(result.entry.metrics) } : null,
    serverMetrics: result.serverMetrics ? normalizeLeaderboardMetrics(result.serverMetrics) : null,
  };
}

export async function fetchCloudPublicStatus(): Promise<CloudPublicStatus> {
  // This endpoint is anonymous and read-only. Account credentials remain blocked on public HTTP origins.
  return cloudRequest<CloudPublicStatus>("/public-status", {}, false, true);
}

export async function submitCloudLeaderboard(seasonId: string): Promise<void> {
  await cloudRequest("/leaderboard", { method: "POST", body: JSON.stringify({ seasonId }) }, true);
}

export async function fetchSpeedrunLeaderboard(targetId: SpeedrunTargetId, seasonId: string): Promise<SpeedrunLeaderboardEntry[]> {
  const result = await cloudRequest<{ entries: SpeedrunLeaderboardEntry[] }>(`/speedrun/leaderboard?targetId=${encodeURIComponent(targetId)}&seasonId=${encodeURIComponent(seasonId)}`, {}, false, true);
  return result.entries;
}

export async function submitSpeedrunResult(payload: SpeedrunSubmissionPayload): Promise<{ entry: SpeedrunLeaderboardEntry; idempotent: boolean }> {
  return cloudRequest<{ entry: SpeedrunLeaderboardEntry; idempotent: boolean }>("/speedrun/submit", {
    method: "POST",
    body: JSON.stringify(payload),
  }, true);
}

export async function setCloudLeaderboardVisibility(visible: boolean): Promise<CloudUser> {
  const result = await cloudRequest<{ user: CloudUser }>("/leaderboard/visibility", {
    method: "POST",
    body: JSON.stringify({ visible }),
  }, true);
  return result.user;
}

function validStationPublicId(publicId: string): boolean {
  return /^station_[a-f0-9]{32}$/.test(publicId);
}

export async function fetchPublicStation(publicId: string): Promise<PublicStationResponse> {
  if (!validStationPublicId(publicId)) throw new CloudApiError("空间站公开地址无效", 404, { code: "STATION_NOT_FOUND" });
  return cloudRequest<PublicStationResponse>(`/stations/${encodeURIComponent(publicId)}`, {}, hasCloudAuthentication(), true);
}

export async function fetchCloudStationProfile(): Promise<CloudStationProfile> {
  return cloudRequest<CloudStationProfile>("/station/me", {}, true);
}

export async function publishCloudStation(): Promise<CloudStationProfile> {
  const result = await cloudRequest<Omit<CloudStationProfile, "social">>("/station/publish", {
    method: "POST",
    body: "{}",
  }, true);
  const current = await fetchCloudStationProfile();
  return { ...current, ...result };
}

export async function setCloudStationVisibility(visibility: "public" | "private"): Promise<CloudStationProfile> {
  await cloudRequest("/station/visibility", {
    method: "POST",
    body: JSON.stringify({ visibility }),
  }, true);
  return fetchCloudStationProfile();
}

export async function setCloudStationFavorite(publicId: string, favorite: boolean): Promise<PublicStationSocial> {
  if (!validStationPublicId(publicId)) throw new CloudApiError("空间站公开地址无效", 404, { code: "STATION_NOT_FOUND" });
  const result = await cloudRequest<{ social: PublicStationSocial }>(`/stations/${encodeURIComponent(publicId)}/favorite`, {
    method: favorite ? "POST" : "DELETE",
    ...(favorite ? { body: "{}" } : {}),
  }, true);
  return result.social;
}

export async function sendCloudStationSignal(publicId: string, signalId: StationSignalId): Promise<PublicStationSocial> {
  if (!validStationPublicId(publicId)) throw new CloudApiError("空间站公开地址无效", 404, { code: "STATION_NOT_FOUND" });
  const result = await cloudRequest<{ social: PublicStationSocial }>(`/stations/${encodeURIComponent(publicId)}/signal`, {
    method: "POST",
    body: JSON.stringify({ signalId }),
  }, true);
  return result.social;
}

export async function sendCloudFeedback(kind: string, message: string, diagnostics: Record<string, unknown>): Promise<string> {
  const result = await cloudRequest<{ id: string }>("/feedback", { method: "POST", body: JSON.stringify({ kind, message, diagnostics }) }, hasCloudAuthentication());
  return result.id;
}

export async function reportCloudError(message: string, diagnostics: Record<string, unknown>): Promise<void> {
  try {
    await cloudRequest("/errors", { method: "POST", body: JSON.stringify({ kind: "client-error", message, diagnostics }) }, hasCloudAuthentication());
  } catch {
    // Error reporting must never cause another user-facing error.
  }
}
