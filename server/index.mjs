import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import cloudTransferContract from "./cloud-transfer-contract.json" with { type: "json" };
import Database from "better-sqlite3";
import {
  DEFAULT_METRIC_TIME_ZONE,
  analyticsSummary,
  metricDay,
  normalizeAnalyticsState,
  recordAnalyticsBatch,
} from "./analytics.mjs";
import { createTencentSesMailer, createWebhookMailer } from "./mail.mjs";
import { getActivityPublicStatus, loadActivityConfig, normalizeActivityConfig } from "./activity.mjs";
import { inspectParsedSavePayloadIntegrity, inspectSavePayloadIntegrity } from "./save-integrity.mjs";
import { UploadInspectionScheduler } from "./upload-inspection-scheduler.mjs";
import {
  isLeaderboardRestricted,
  LEADERBOARD_RESTRICTED_CODE,
  normalizeLeaderboardModeration,
} from "./leaderboard-moderation.mjs";
import {
  aggregateGalacticFactoryMetric,
  GALACTIC_NOMINAL_METRIC_VERSION,
} from "./galactic-metrics.mjs";
import {
  CLOUD_HISTORY_LIMIT,
  CLOUD_HISTORY_PRUNE_CONFIRMATION,
  backupWindowState,
  backupStartupGraceElapsed,
  normalizeBackupStartupGraceMs,
  buildCloudHistoryPrunePlan,
  collectSqliteGovernanceMetrics,
  parseDailyBackupWindow,
  publicCloudHistoryPrunePlan,
  trimCloudHistoryMetadataInPlace,
} from "./cloud-governance.mjs";
import {
  DEFAULT_CLOUD_QUOTA_POLICY,
  cloudQuotaSnapshot,
  normalizeCloudQuotaPolicy,
  planCloudSaveUpload,
  publicCloudQuotaPlan,
} from "./cloud-quota.mjs";
import { inspectSaveContractRecord } from "./save-field-contract.mjs";
import {
  WEB_SESSION_MODE_HEADER,
  WebSessionError,
  assertLegacyWebSessionMigrationRequest,
  clearWebSessionCookie,
  createSessionDelivery,
  createWebSessionPolicy,
  inspectSessionCredential,
  inspectSessionIssuanceRequest,
  protectSessionRequest,
  publicCookieSession,
  requireCookieSessionCredential,
} from "./web-session.mjs";

import {
  anonymousLoginContext,
  clearLeaderboardRevalidationIfSatisfied,
  createLoginFailureGuard,
  leaderboardRevalidationRequired,
  leaderboardRevalidationThresholds,
  loginDisabled,
  normalizeAccountControls,
  normalizeAccountSecurity,
  publicLoginSecurityEvents,
  recordSuccessfulLogin,
} from "./account-security.mjs";
import { evaluateLeaderboardIntegrity, LEADERBOARD_INTEGRITY_VERSION } from "./leaderboard-integrity.mjs";
import { AccountArchiveError, createAccountArchiveZipStream } from "./account-archive.mjs";
import {
  ACCOUNT_ARCHIVE_IMPORT_CONFIRMATION_HEADER,
  ACCOUNT_ARCHIVE_IMPORT_GUARD_HEADER,
  AccountArchiveImportError,
  accountArchiveImportConfirmation,
  accountArchiveImportGuard,
  inspectAccountArchivePayloadFile,
  maximumAccountArchiveImportBytes,
  prepareAccountArchiveImport,
  receiveAccountArchiveRequest,
} from "./account-archive-import.mjs";
import {
  auditCloudPayloadAliasReferences,
  deleteCloudPayload,
  deleteCloudPayloadsForUser,
  garbageCollectCloudPayloadBlobCandidates,
  initializeCloudPayloadStore,
  linkVerifiedCloudPayload,
  readCloudPayload,
  writeInspectedCloudPayload,
} from "./cloud-payload-store.mjs";
import {
  applyRuntimeRetentionPolicy,
  LeaderboardSnapshotIndex,
  PresenceIndex,
  RuntimeMetricsAggregator,
} from "./runtime-indexes.mjs";
import {
  SqliteRuntimeStatePersistence,
  createRuntimeStatePersistencePlan,
  runtimeAppStateFingerprint,
} from "./runtime-state-persistence.mjs";
import {
  ACCOUNT_JSON_SCHEMAS,
  accountArchiveBodyCapability,
  cloudSaveBodyCapability,
  createBodyCapability,
  createCorsPolicy,
  HttpSecurityError,
  inspectHttpRequest,
  noBodyCapability,
  securityResponseHeaders,
  projectPublicLeaderboard,
  projectPublicSpeedrunLeaderboard,
  validateClientReport,
  validateJsonDto,
} from "./http-security.mjs";
import { bodyCapabilityForRoute } from "./http-route-policy.mjs";
import { prepareLegacyJsonAccountImport } from "./account-archive-legacy-json.mjs";

const cloudTransferNumericKeys = [
  "version", "mibBytes", "guaranteedSavePayloadBytes", "savePayloadLimitBytes", "rawFallbackSafeLimitBytes",
  "requestCompressedLimitBytes", "requestExpandedLimitBytes", "legacyJsonRequestLimitBytes", "singleSaveResponseLimitBytes",
  "maximumConcurrentExpandedBytes",
  "baseTimeoutMs", "timeoutPerMibMs", "maximumTimeoutMs", "compressionTimeoutMs", "ipcChunkBytes",
];
if (!cloudTransferNumericKeys.every((key) => Number.isSafeInteger(cloudTransferContract[key]) && cloudTransferContract[key] > 0) ||
  cloudTransferContract.guaranteedSavePayloadBytes > cloudTransferContract.savePayloadLimitBytes ||
  cloudTransferContract.savePayloadLimitBytes > cloudTransferContract.requestExpandedLimitBytes ||
  cloudTransferContract.requestCompressedLimitBytes > cloudTransferContract.requestExpandedLimitBytes ||
  cloudTransferContract.requestExpandedLimitBytes > cloudTransferContract.maximumConcurrentExpandedBytes ||
  cloudTransferContract.baseTimeoutMs > cloudTransferContract.maximumTimeoutMs) {
  throw new Error("Invalid cloud transfer contract");
}

const scrypt = promisify(scryptCallback);
// The envelope remains v2, but end-game saves can exceed the historical 8 MiB
// request boundary. Keep a finite compressed and expanded limit so increasing
// the boundary cannot turn the endpoint into an unbounded decompression sink.
const BODY_LIMIT_BYTES = cloudTransferContract.requestCompressedLimitBytes;
const EXPANDED_BODY_LIMIT_BYTES = cloudTransferContract.requestExpandedLimitBytes;
const SAVE_PAYLOAD_LIMIT_BYTES = cloudTransferContract.savePayloadLimitBytes;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLOUD_SAVE_SLOTS = ["main", "1", "2", "3"];
const SAVE_MODES = ["normal", "speedrun"];
const MANUAL_CLOUD_SAVE_SLOTS = CLOUD_SAVE_SLOTS.slice(1);
const SQLITE_CLOUD_PAYLOAD_LAYOUT_VERSION = 2;
const EMAIL_ACTION_TTL_MS = 30 * 60 * 1000;
const OPERATION_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OPERATION_RECEIPT_LIMIT = 5_000;
const OPERATION_RECEIPT_USER_LIMIT = 128;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const DEFAULT_PLAYER_ONLINE_WINDOW_MS = 120_000;
const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{16,96}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{4,24}$/;
const VALID_CATEGORIES = new Set(["power", "upload", "white-rate", "dyson", "throughput", "galaxy"]);
const VALID_SEASONS = new Set(["season_01", "season_00"]);
const ACTIVE_LEADERBOARD_SEASON_ID = "season_01";
const SPEEDRUN_RULESET_VERSION = "speedrun-v1";
const SPEEDRUN_TARGETS = {
  all_technologies: { category: "speedrun-all-technologies", target: 0 },
  dyson_rockets_10000: { category: "speedrun-dyson-rockets-10000", target: 10_000 },
  white_matrix_1m: { category: "speedrun-white-matrix-1m", target: 1_000_000 },
};
const SPEEDRUN_FINITE_TECH_IDS = [
  "electromagnetic_matrix", "electromagnetism", "solar_energy", "basic_logistics", "thermal_power",
  "high_efficiency_plasma_control", "energy_matrix", "energy_storage", "fractionation", "geothermal_power",
  "high_speed_assembling", "high_speed_logistics", "mining_speed_1", "proliferator_1", "xray_cracking",
  "reforming_refine", "high_strength_crystal", "basic_chemical_engineering", "polymer_chemistry", "structure_matrix",
  "material_delivery_logistics", "proliferator_2", "titanium_alloy", "processor", "planetary_logistics",
  "interstellar_logistics", "nanomaterials", "rare_resource_utilization", "quantum_chemical_engineering", "orbital_collection",
  "information_matrix", "construction_automation", "proliferator_3", "research_speed_1", "miniature_particle_collider",
  "fusion_power", "quantum_chip", "plane_smelting", "gravity_matrix", "construction_capacity_1", "space_warp",
  "stellar_exploration", "quantum_printing", "super_magnetic_logistics", "research_speed_2", "dyson_swarm", "ray_receiver",
  "antimatter", "artificial_star", "universe_matrix", "micro_black_hole_containment", "time_warp_engineering",
  "construction_capacity_2", "research_speed_3", "dyson_sphere_program", "vertical_launching_silo", "dyson_shell",
  "mining_speed_2", "mining_speed_3", "logistics_engine_1", "logistics_engine_2", "logistics_capacity_1", "logistics_capacity_2",
  "solar_sail_life_1", "solar_sail_life_2", "ray_transmission_1", "ray_transmission_2", "dyson_absorption_1",
  "quantum_logistics_network",
];
const WHITE_MATRIX_RATE_MIN_INTERVAL_SECONDS = 60;
const THROUGHPUT_RATE_MIN_INTERVAL_SECONDS = 60;
const THROUGHPUT_METRIC_VERSION = "settled-total-produced-v1";
const WHITE_MATRIX_METRIC_VERSION = "settled-universe-matrix-v1";
const METRIC_KEYS = [
  "energyGeneratedMj",
  "uploadedWhiteMatrix",
  "peakWhiteMatrixPerMinute",
  "peakGenerationKw",
  "peakThroughputPerMinute",
  "theoreticalPeakThroughputPerMinute",
  "peakDysonPowerKw",
  "exploredSystems",
  "colonizedPlanets",
];
const DEFAULT_DATA = {
  schemaVersion: 7,
  users: {},
  sessions: {},
  emailVerifications: {},
  passwordResets: {},
  auditLog: [],
  cloudSaves: {},
  cloudSaveHistory: {},
  cloudSaveSlots: {},
  cloudSaveSlotHistory: {},
  // Normal-mode records keep their historical keys for backward compatibility.
  // Speedrun records live in these mode-qualified maps so the same slot name
  // can never overwrite a normal save.
  cloudSavesByMode: {},
  cloudSaveHistoryByMode: {},
  cloudSaveSlotsByMode: {},
  cloudSaveSlotHistoryByMode: {},
  submissions: {},
  speedrunSubmissions: {},
  leaderboardModeration: {},
  accountSecurity: {},
  accountControls: {},
  operationReceipts: {},
  players: {},
  feedback: [],
  errors: [],
  dailyMetrics: {},
  analytics: { visitors: {}, sessions: {}, daily: {} },
};

function cloneDefaultData() {
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function normalizePlayerRecords(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([playerHash, record]) => {
    if (!/^[a-f0-9]{64}$/.test(playerHash) || !record || typeof record !== "object") return [];
    const firstSeenAt = Number.isFinite(record.firstSeenAt) ? Math.max(0, Math.floor(record.firstSeenAt)) : 0;
    const lastSeenAt = Number.isFinite(record.lastSeenAt) ? Math.max(firstSeenAt, Math.floor(record.lastSeenAt)) : firstSeenAt;
    const lastActiveDay = typeof record.lastActiveDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.lastActiveDay)
      ? record.lastActiveDay
      : metricDay(lastSeenAt);
    return [[playerHash, { firstSeenAt, lastSeenAt, lastActiveDay }]];
  }));
}

function normalizedUsername(value) {
  if (typeof value !== "string") return null;
  const username = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : null;
}

function migratedUsername(id, occupied) {
  const digest = createHash("sha256").update(`cloud-username:${id}`).digest("hex");
  const base = `pilot_${digest.slice(0, 12)}`;
  let candidate = base;
  let suffix = 0;
  while (occupied.has(candidate)) {
    suffix += 1;
    candidate = `${base.slice(0, 21)}_${suffix.toString(36)}`;
  }
  return candidate;
}

function normalizeUserRecords(value, sourceSchemaVersion) {
  if (!value || typeof value !== "object") return {};
  const users = {};
  const occupied = new Set();
  for (const [key, record] of Object.entries(value)) {
    if (!record || typeof record !== "object") continue;
    const id = typeof record.id === "string" && record.id ? record.id : key;
    if (!id) continue;
    const createdAt = Number.isFinite(record.createdAt) ? Math.max(0, Math.floor(record.createdAt)) : 0;
    const email = typeof record.email === "string" ? record.email.trim().toLowerCase() : "";
    const emailVerifiedAt = !email
      ? null
      : sourceSchemaVersion < 5
        ? createdAt
        : Number.isFinite(record.emailVerifiedAt) ? Math.max(0, Math.floor(record.emailVerifiedAt)) : null;
    const requestedUsername = normalizedUsername(record.username);
    const username = requestedUsername && !occupied.has(requestedUsername)
      ? requestedUsername
      : migratedUsername(id, occupied);
    occupied.add(username);
    users[id] = {
      ...record,
      id,
      username,
      email,
      displayName: typeof record.displayName === "string" ? record.displayName : "星际工程师",
      createdAt,
      emailVerifiedAt,
      passwordChangedAt: Number.isFinite(record.passwordChangedAt) ? Math.max(createdAt, Math.floor(record.passwordChangedAt)) : createdAt,
      leaderboardVisible: record.leaderboardVisible !== false,
    };
  }
  return users;
}

function normalizeSessionRecords(value, users) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([tokenHash, record]) => {
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !record || typeof record !== "object" || !users[record.userId]) return [];
    const createdAt = Number.isFinite(record.createdAt) ? Math.max(0, Math.floor(record.createdAt)) : 0;
    const expiresAt = Number.isFinite(record.expiresAt) ? Math.max(createdAt, Math.floor(record.expiresAt)) : createdAt;
    return [[tokenHash, {
      id: typeof record.id === "string" && /^session_[A-Za-z0-9_-]{16,80}$/.test(record.id)
        ? record.id
        : `session_${tokenHash.slice(0, 24)}`,
      userId: record.userId,
      createdAt,
      lastSeenAt: Number.isFinite(record.lastSeenAt) ? Math.max(createdAt, Math.floor(record.lastSeenAt)) : createdAt,
      expiresAt,
      deviceName: typeof record.deviceName === "string" ? record.deviceName.slice(0, 80) : "未知设备",
      clientType: typeof record.clientType === "string" ? record.clientType.slice(0, 32) : "unknown",
      ipHash: typeof record.ipHash === "string" && /^[a-f0-9]{16}$/.test(record.ipHash) ? record.ipHash : null,
      deviceHash: typeof record.deviceHash === "string" && /^[a-f0-9]{16}$/.test(record.deviceHash) ? record.deviceHash : null,
      regionHash: typeof record.regionHash === "string" && /^[a-f0-9]{16}$/.test(record.regionHash) ? record.regionHash : null,
    }]];
  }));
}

function normalizeActionTokens(value, users) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([tokenHash, record]) => (
    /^[a-f0-9]{64}$/.test(tokenHash) && record && typeof record === "object" && users[record.userId] && Number.isFinite(record.expiresAt)
      ? [[tokenHash, { userId: record.userId, createdAt: Math.max(0, Math.floor(record.createdAt ?? 0)), expiresAt: Math.max(0, Math.floor(record.expiresAt)) }]]
      : []
  )));
}

function normalizedCloudSaveMode(value) {
  return value === "speedrun" ? "speedrun" : value === "normal" || value === null || value === undefined ? "normal" : null;
}

function savePayloadModeFromParsed(parsed) {
  const state = parsed?.state ?? parsed;
  const envelopeMode = parsed?.mode;
  const stateMode = state?.mode;
  if (envelopeMode !== undefined && !SAVE_MODES.includes(envelopeMode)) return null;
  if (stateMode !== undefined && !SAVE_MODES.includes(stateMode)) return null;
  if (envelopeMode !== undefined && stateMode !== undefined && envelopeMode !== stateMode) return null;
  if (envelopeMode !== undefined || stateMode !== undefined) return normalizedCloudSaveMode(envelopeMode ?? stateMode);
  // v2 speedrun saves predate the top-level mode marker. Their complete,
  // server-verifiable run identity is an unambiguous legacy marker; plain
  // legacy saves without this structure remain normal.
  const legacySpeedrun = state?.speedrun;
  if (legacySpeedrun?.enabled === true && legacySpeedrun.mode === "speedrun" &&
    typeof legacySpeedrun.factoryId === "string" && legacySpeedrun.factoryId.length > 0) return "speedrun";
  return "normal";
}

function isLegacyImplicitSpeedrunParsed(parsed) {
  const state = parsed?.state ?? parsed;
  return parsed?.mode === undefined && state?.mode === undefined && savePayloadModeFromParsed(parsed) === "speedrun";
}

function summarizeParsedSavePayload(parsed, integrity = inspectParsedSavePayloadIntegrity(parsed), mode = savePayloadModeFromParsed(parsed)) {
  const state = parsed?.state ?? parsed;
  if (!state || typeof state !== "object" || !Array.isArray(state.entities)) return null;
  return {
    mode: mode ?? "normal",
    stateVersion: Number.isFinite(state.version) ? Math.max(0, Math.floor(state.version)) : 0,
    savedAt: Number.isFinite(parsed?.savedAt) ? Math.max(0, Math.floor(parsed.savedAt)) : 0,
    elapsedSeconds: Number.isFinite(state.elapsedSeconds) ? Math.max(0, Math.floor(state.elapsedSeconds)) : 0,
    activePlanetId: typeof state.activePlanetId === "string" ? state.activePlanetId.slice(0, 80) : "home",
    entityCount: state.entities.length,
    completedTechCount: Array.isArray(state.research?.completedTechIds) ? state.research.completedTechIds.length : 0,
    structurePoints: Number.isFinite(state.dysonSphere?.structurePoints) ? Math.max(0, Math.floor(state.dysonSphere.structurePoints)) : 0,
    uploadedWhiteMatrix: Number.isFinite(state.totalProduced?.universe_matrix) ? Math.max(0, Math.floor(state.totalProduced.universe_matrix)) : 0,
    stateChecksum: typeof parsed?.checksum === "string" ? parsed.checksum.slice(0, 128) : null,
    computedStateChecksum: integrity.computedChecksum,
    integrity: integrity.valid ? "valid" : "invalid",
  };
}

function summarizeSavePayload(payload) {
  if (typeof payload !== "string") return null;
  try {
    const integrity = inspectSavePayloadIntegrity(payload);
    return summarizeParsedSavePayload(integrity.parsed, integrity, savePayloadModeFromParsed(integrity.parsed));
  } catch {
    return null;
  }
}

function normalizeSaveRecord(save) {
  if (!save || typeof save !== "object") return save;
  // Persisted summaries avoid reparsing every historical save during server startup.
  return { ...save, summary: save.summary ?? summarizeSavePayload(save.payload) };
}

function normalizeManualSaveSlots(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([userId, slots]) => {
    if (!slots || typeof slots !== "object") return [];
    const normalized = Object.fromEntries(MANUAL_CLOUD_SAVE_SLOTS.flatMap((slot) =>
      slots[slot] && typeof slots[slot] === "object" ? [[slot, normalizeSaveRecord(slots[slot])]] : []));
    return Object.keys(normalized).length > 0 ? [[userId, normalized]] : [];
  }));
}

function normalizeManualSaveSlotHistory(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([userId, slots]) => {
    if (!slots || typeof slots !== "object") return [];
    const normalized = Object.fromEntries(MANUAL_CLOUD_SAVE_SLOTS.flatMap((slot) =>
      Array.isArray(slots[slot]) ? [[slot, slots[slot].map(normalizeSaveRecord)]] : []));
    return Object.keys(normalized).length > 0 ? [[userId, normalized]] : [];
  }));
}

function normalizeModeCloudSaves(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([userId, modes]) => {
    if (!modes || typeof modes !== "object") return [];
    const normalized = Object.fromEntries(SAVE_MODES.flatMap((mode) =>
      modes[mode] && typeof modes[mode] === "object" ? [[mode, normalizeSaveRecord(modes[mode])]] : []));
    return Object.keys(normalized).length > 0 ? [[userId, normalized]] : [];
  }));
}

function normalizeModeCloudHistory(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([userId, modes]) => {
    if (!modes || typeof modes !== "object") return [];
    const normalized = Object.fromEntries(SAVE_MODES.flatMap((mode) =>
      Array.isArray(modes[mode]) ? [[mode, modes[mode].map(normalizeSaveRecord)]] : []));
    return Object.keys(normalized).length > 0 ? [[userId, normalized]] : [];
  }));
}

function normalizeModeCloudSlots(value, history = false) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([userId, modes]) => {
    if (!modes || typeof modes !== "object") return [];
    const normalized = Object.fromEntries(SAVE_MODES.flatMap((mode) => {
      const slots = modes[mode];
      if (!slots || typeof slots !== "object") return [];
      const clean = history ? normalizeManualSaveSlotHistory({ [userId]: slots })[userId] : normalizeManualSaveSlots({ [userId]: slots })[userId];
      return clean && Object.keys(clean).length > 0 ? [[mode, clean]] : [];
    }));
    return Object.keys(normalized).length > 0 ? [[userId, normalized]] : [];
  }));
}

function normalizeSpeedrunSubmissions(value, users) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (!entry || typeof entry !== "object" || !users[entry.userId] || !Object.hasOwn(SPEEDRUN_TARGETS, entry.targetId) ||
      entry.seasonId !== ACTIVE_LEADERBOARD_SEASON_ID || entry.rulesetVersion !== SPEEDRUN_RULESET_VERSION ||
      typeof entry.factoryId !== "string" || !/^[A-Za-z0-9_-]{16,96}$/.test(entry.factoryId) ||
      !Number.isFinite(entry.elapsedSeconds) || entry.elapsedSeconds < 0 || !Number.isFinite(entry.receivedAt)) return [];
    return [[key, {
      submissionId: typeof entry.submissionId === "string" ? entry.submissionId.slice(0, 120) : `speedrun_${randomUUID()}`,
      userId: entry.userId,
      displayName: typeof entry.displayName === "string" ? entry.displayName.slice(0, 24) : users[entry.userId].displayName,
      avatar: typeof entry.avatar === "string" ? entry.avatar.slice(0, 8) : "A",
      targetId: entry.targetId,
      seasonId: entry.seasonId,
      rulesetVersion: entry.rulesetVersion,
      factoryId: entry.factoryId,
      elapsedSeconds: Math.max(0, Number(entry.elapsedSeconds)),
      completedAtSeconds: Math.max(0, Number(entry.completedAtSeconds ?? entry.elapsedSeconds)),
      completedAt: Number.isFinite(entry.completedAt) ? Math.max(0, Math.floor(entry.completedAt)) : Math.max(0, Math.floor(entry.receivedAt)),
      receivedAt: Math.max(0, Math.floor(entry.receivedAt)),
      saveRevision: Number.isSafeInteger(entry.saveRevision) ? entry.saveRevision : 0,
      saveHash: typeof entry.saveHash === "string" ? entry.saveHash.slice(0, 128) : "",
      resourceMode: entry.resourceMode === "infinite" ? "infinite" : "finite",
      verified: entry.verified === true,
    }]];
  }));
}

function normalizeOperationReceipts(value, users, now = Date.now()) {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value).flatMap(([requestId, receipt]) => {
    if (!OPERATION_ID_PATTERN.test(requestId) || !receipt || typeof receipt !== "object" ||
      receipt.requestId !== requestId || !users[receipt.userId] || receipt.operation !== "cloud-save.put" ||
      receipt.method !== "PUT" || !SAVE_MODES.includes(receipt.mode) || !CLOUD_SAVE_SLOTS.includes(receipt.slot) ||
      !Number.isSafeInteger(receipt.expectedRevision) || receipt.expectedRevision < 0 ||
      typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
      !Number.isFinite(receipt.completedAt) || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= now ||
      receipt.status !== "succeeded" || !receipt.result || typeof receipt.result !== "object" ||
      !receipt.result.cloudSave || typeof receipt.result.cloudSave !== "object") return [];
    const completedAt = Math.max(0, Math.floor(receipt.completedAt));
    const expiresAt = Math.max(completedAt, Math.floor(receipt.expiresAt));
    const cloudSave = receipt.result.cloudSave;
    if (!Number.isSafeInteger(cloudSave.revision) || cloudSave.revision <= 0 ||
      !Number.isFinite(cloudSave.updatedAt) || !Number.isSafeInteger(cloudSave.size) || cloudSave.size < 0 ||
      typeof cloudSave.checksum !== "string" || !/^[a-f0-9]{64}$/.test(cloudSave.checksum)) return [];
    return [[requestId, {
      requestId,
      userId: receipt.userId,
      operation: "cloud-save.put",
      method: "PUT",
      mode: receipt.mode,
      slot: receipt.slot,
      expectedRevision: receipt.expectedRevision,
      fingerprint: receipt.fingerprint,
      status: "succeeded",
      completedAt,
      expiresAt,
      result: {
        cloudSave: {
          mode: receipt.mode,
          slot: receipt.slot,
          revision: cloudSave.revision,
          updatedAt: Math.max(0, Math.floor(cloudSave.updatedAt)),
          size: cloudSave.size,
          checksum: cloudSave.checksum,
          summary: cloudSave.summary && typeof cloudSave.summary === "object" ? cloudSave.summary : null,
          ...(Number.isInteger(cloudSave.restoredFromRevision) ? { restoredFromRevision: cloudSave.restoredFromRevision } : {}),
        },
      },
    }]];
  });
  entries.sort(([, left], [, right]) => right.completedAt - left.completedAt || left.requestId.localeCompare(right.requestId));
  const perUser = new Map();
  const retained = [];
  for (const entry of entries) {
    if (retained.length >= OPERATION_RECEIPT_LIMIT) break;
    const receipt = entry[1];
    const count = perUser.get(receipt.userId) ?? 0;
    if (count >= OPERATION_RECEIPT_USER_LIMIT) continue;
    perUser.set(receipt.userId, count + 1);
    retained.push(entry);
  }
  return Object.fromEntries(retained);
}

function pruneOperationReceipts(data, now = Date.now()) {
  const before = data?.operationReceipts && typeof data.operationReceipts === "object"
    ? Object.keys(data.operationReceipts).length
    : 0;
  data.operationReceipts = normalizeOperationReceipts(data?.operationReceipts, data?.users ?? {}, now);
  return Math.max(0, before - Object.keys(data.operationReceipts).length);
}

function cloudPutOperationFingerprint({ userId, mode, slot, expectedRevision, payloadChecksum, payloadSize }) {
  return sha256(JSON.stringify([
    "cloud-save.put.v1",
    userId,
    "PUT",
    mode,
    slot,
    expectedRevision,
    payloadChecksum,
    payloadSize,
  ]));
}

function publicOperationReceipt(receipt) {
  if (!receipt) return null;
  return {
    requestId: receipt.requestId,
    operation: receipt.operation,
    method: receipt.method,
    mode: receipt.mode,
    slot: receipt.slot,
    expectedRevision: receipt.expectedRevision,
    status: receipt.status,
    completedAt: receipt.completedAt,
    expiresAt: receipt.expiresAt,
    result: structuredClone(receipt.result),
  };
}

function recordCloudPutOperationReceipt(data, {
  requestId,
  userId,
  mode,
  slot,
  expectedRevision,
  fingerprint,
  cloudSave,
  now = Date.now(),
}) {
  if (!requestId) return null;
  data.operationReceipts ??= {};
  const receipt = {
    requestId,
    userId,
    operation: "cloud-save.put",
    method: "PUT",
    mode,
    slot,
    expectedRevision,
    fingerprint,
    status: "succeeded",
    completedAt: now,
    expiresAt: now + OPERATION_RECEIPT_TTL_MS,
    result: { cloudSave: structuredClone(cloudSave) },
  };
  data.operationReceipts[requestId] = receipt;
  pruneOperationReceipts(data, now);
  return receipt;
}

function normalizeStoredData(parsed) {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const sourceSchemaVersion = Number.isInteger(source.schemaVersion) ? source.schemaVersion : 1;
  const users = normalizeUserRecords(source.users, sourceSchemaVersion);
  const data = {
    ...cloneDefaultData(),
    ...source,
    schemaVersion: DEFAULT_DATA.schemaVersion,
    users,
    sessions: normalizeSessionRecords(source.sessions, users),
    emailVerifications: normalizeActionTokens(source.emailVerifications, users),
    passwordResets: normalizeActionTokens(source.passwordResets, users),
    auditLog: Array.isArray(source.auditLog) ? source.auditLog.slice(-2000).flatMap((entry) => (
      entry && typeof entry === "object" && typeof entry.action === "string" && Number.isFinite(entry.occurredAt)
        ? [{
            action: entry.action.slice(0, 80),
            occurredAt: Math.max(0, Math.floor(entry.occurredAt)),
            actorHash: typeof entry.actorHash === "string" ? entry.actorHash.slice(0, 16) : null,
            ipHash: typeof entry.ipHash === "string" ? entry.ipHash.slice(0, 16) : null,
            clientType: typeof entry.clientType === "string" ? entry.clientType.slice(0, 32) : "unknown",
          }]
        : []
    )) : [],
    cloudSaves: source.cloudSaves && typeof source.cloudSaves === "object"
      ? Object.fromEntries(Object.entries(source.cloudSaves).map(([userId, save]) => [userId, normalizeSaveRecord(save)]))
      : {},
    cloudSaveHistory: source.cloudSaveHistory && typeof source.cloudSaveHistory === "object"
      ? Object.fromEntries(Object.entries(source.cloudSaveHistory).map(([userId, history]) => [userId, Array.isArray(history) ? history.map(normalizeSaveRecord) : []]))
      : {},
    cloudSaveSlots: normalizeManualSaveSlots(source.cloudSaveSlots),
    cloudSaveSlotHistory: normalizeManualSaveSlotHistory(source.cloudSaveSlotHistory),
    cloudSavesByMode: normalizeModeCloudSaves(source.cloudSavesByMode),
    cloudSaveHistoryByMode: normalizeModeCloudHistory(source.cloudSaveHistoryByMode),
    cloudSaveSlotsByMode: normalizeModeCloudSlots(source.cloudSaveSlotsByMode),
    cloudSaveSlotHistoryByMode: normalizeModeCloudSlots(source.cloudSaveSlotHistoryByMode, true),
    submissions: source.submissions && typeof source.submissions === "object" ? source.submissions : {},
    speedrunSubmissions: normalizeSpeedrunSubmissions(source.speedrunSubmissions, users),
    leaderboardModeration: normalizeLeaderboardModeration(source.leaderboardModeration, users),
    accountSecurity: normalizeAccountSecurity(source.accountSecurity, users),
    accountControls: normalizeAccountControls(source.accountControls, users),
    operationReceipts: normalizeOperationReceipts(source.operationReceipts, users),
    players: normalizePlayerRecords(source.players),
    feedback: Array.isArray(source.feedback) ? source.feedback.slice(-1000) : [],
    errors: Array.isArray(source.errors) ? source.errors.slice(-1000) : [],
    dailyMetrics: source.dailyMetrics && typeof source.dailyMetrics === "object" ? source.dailyMetrics : {},
    analytics: normalizeAnalyticsState(source.analytics),
  };
  for (const [userId, save] of Object.entries(data.cloudSaves)) {
    const history = Array.isArray(data.cloudSaveHistory[userId]) ? data.cloudSaveHistory[userId] : [];
    if (save && !history.some((entry) => entry.revision === save.revision)) history.push(save);
    data.cloudSaveHistory[userId] = history.sort((left, right) => left.revision - right.revision).slice(-CLOUD_HISTORY_LIMIT);
  }
  for (const [userId, slots] of Object.entries(data.cloudSaveSlots)) {
    data.cloudSaveSlotHistory[userId] ??= {};
    for (const slot of MANUAL_CLOUD_SAVE_SLOTS) {
      const save = slots?.[slot];
      if (!save) continue;
      const history = Array.isArray(data.cloudSaveSlotHistory[userId][slot]) ? data.cloudSaveSlotHistory[userId][slot] : [];
      if (!history.some((entry) => entry.revision === save.revision)) history.push(save);
      data.cloudSaveSlotHistory[userId][slot] = history
        .sort((left, right) => left.revision - right.revision)
        .slice(-CLOUD_HISTORY_LIMIT);
    }
  }
  for (const [userId, modes] of Object.entries(data.cloudSavesByMode)) {
    data.cloudSaveHistoryByMode[userId] ??= {};
    for (const mode of SAVE_MODES) {
      const save = modes?.[mode];
      if (!save) continue;
      const history = Array.isArray(data.cloudSaveHistoryByMode[userId][mode]) ? data.cloudSaveHistoryByMode[userId][mode] : [];
      if (!history.some((entry) => entry.revision === save.revision)) history.push(save);
      data.cloudSaveHistoryByMode[userId][mode] = history
        .sort((left, right) => left.revision - right.revision)
        .slice(-CLOUD_HISTORY_LIMIT);
    }
  }
  for (const [userId, modes] of Object.entries(data.cloudSaveSlotsByMode)) {
    data.cloudSaveSlotHistoryByMode[userId] ??= {};
    for (const mode of SAVE_MODES) {
      const slots = modes?.[mode];
      if (!slots) continue;
      data.cloudSaveSlotHistoryByMode[userId][mode] ??= {};
      for (const slot of MANUAL_CLOUD_SAVE_SLOTS) {
        const save = slots[slot];
        if (!save) continue;
        const history = Array.isArray(data.cloudSaveSlotHistoryByMode[userId][mode][slot])
          ? data.cloudSaveSlotHistoryByMode[userId][mode][slot]
          : [];
        if (!history.some((entry) => entry.revision === save.revision)) history.push(save);
        data.cloudSaveSlotHistoryByMode[userId][mode][slot] = history
          .sort((left, right) => left.revision - right.revision)
          .slice(-CLOUD_HISTORY_LIMIT);
      }
    }
  }
  return data;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

function normalizedName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ").slice(0, 24);
  return name.length >= 2 ? name : null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
    emailVerified: Number.isFinite(user.emailVerifiedAt),
    emailVerifiedAt: Number.isFinite(user.emailVerifiedAt) ? user.emailVerifiedAt : null,
    passwordChangedAt: user.passwordChangedAt,
    leaderboardVisible: user.leaderboardVisible !== false,
    leaderboardPublicId: leaderboardPublicId(user.id, "galaxy"),
    speedrunPublicId: leaderboardPublicId(user.id, "speedrun"),
  };
}

function normalizedDeviceName(value, request) {
  if (typeof value === "string") {
    const name = value.trim().replace(/\s+/g, " ").slice(0, 80);
    if (name) return name;
  }
  const userAgent = typeof request?.headers?.["user-agent"] === "string" ? request.headers["user-agent"] : "";
  if (/Electron/i.test(userAgent)) return "DSP极简网络桌面版";
  if (/Android/i.test(userAgent)) return "Android 浏览器";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "iOS 浏览器";
  if (/Mobile/i.test(userAgent)) return "移动浏览器";
  return "网页浏览器";
}

function clientTypeForRequest(request) {
  const userAgent = typeof request?.headers?.["user-agent"] === "string" ? request.headers["user-agent"] : "";
  if (/Electron/i.test(userAgent)) return "desktop";
  if (/Mobile|Android|iPhone|iPad|iPod/i.test(userAgent)) return "mobile-web";
  return "desktop-web";
}

function normalizeMetric(value, integer = false, maximum = Number.MAX_VALUE) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const normalized = Math.max(0, Math.min(maximum, number));
  if (integer) return Math.floor(normalized);
  return normalized > Number.MAX_VALUE / 100 ? normalized : Math.round(normalized * 100) / 100;
}

function saturatingMetricProduct(left, right) {
  const normalizedLeft = normalizeMetric(left);
  const normalizedRight = normalizeMetric(right);
  if (normalizedLeft === 0 || normalizedRight === 0) return 0;
  return normalizedLeft > Number.MAX_VALUE / normalizedRight
    ? Number.MAX_VALUE
    : normalizedLeft * normalizedRight;
}

function saturatingMetricAdd(left, right) {
  const normalizedLeft = normalizeMetric(left);
  const normalizedRight = normalizeMetric(right);
  return normalizedLeft >= Number.MAX_VALUE - normalizedRight
    ? Number.MAX_VALUE
    : normalizedLeft + normalizedRight;
}

function calculateGalaxyScore(metrics) {
  const terms = [
    metrics.energyGeneratedMj / 1_000_000,
    saturatingMetricProduct(metrics.uploadedWhiteMatrix, 12),
    metrics.peakDysonPowerKw / 100,
    saturatingMetricProduct(metrics.peakThroughputPerMinute, 8),
    saturatingMetricProduct(metrics.exploredSystems, 10_000),
    saturatingMetricProduct(metrics.colonizedPlanets, 2_000),
  ];
  const total = terms.reduce(saturatingMetricAdd, 0);
  return Math.round(total);
}

function normalizeMetrics(value) {
  const source = value && typeof value === "object" ? value : {};
  const nominalFallback = normalizeMetric(source.theoreticalPeakThroughputPerMinute
    ?? source.galacticThroughputPerMinute
    ?? source.peakThroughputPerMinute);
  const metrics = {
    energyGeneratedMj: normalizeMetric(source.energyGeneratedMj),
    uploadedWhiteMatrix: normalizeMetric(source.uploadedWhiteMatrix, true),
    peakWhiteMatrixPerMinute: normalizeMetric(source.peakWhiteMatrixPerMinute),
    peakGenerationKw: normalizeMetric(source.peakGenerationKw),
    peakThroughputPerMinute: normalizeMetric(source.peakThroughputPerMinute),
    theoreticalPeakThroughputPerMinute: nominalFallback,
    activePlanetThroughputPerMinute: normalizeMetric(source.activePlanetThroughputPerMinute ?? nominalFallback),
    galacticThroughputPerMinute: normalizeMetric(source.galacticThroughputPerMinute ?? nominalFallback),
    peakDysonPowerKw: normalizeMetric(source.peakDysonPowerKw),
    exploredSystems: normalizeMetric(source.exploredSystems, true, 10_000),
    colonizedPlanets: normalizeMetric(source.colonizedPlanets, true, 100_000),
  };
  metrics.galaxyScore = calculateGalaxyScore(metrics);
  return {
    ...metrics,
    nominalThroughputMetricVersion: source.nominalThroughputMetricVersion === GALACTIC_NOMINAL_METRIC_VERSION
      ? GALACTIC_NOMINAL_METRIC_VERSION
      : "legacy-active-planet-v1",
    throughputMetricVersion: source.throughputMetricVersion === THROUGHPUT_METRIC_VERSION
      ? THROUGHPUT_METRIC_VERSION
      : "legacy-nominal-v1",
    throughputWindowSeconds: normalizeMetric(source.throughputWindowSeconds),
  };
}

function categoryValue(metrics, category) {
  if (category === "power") return metrics.energyGeneratedMj;
  if (category === "upload") return metrics.uploadedWhiteMatrix;
  if (category === "white-rate") return metrics.peakWhiteMatrixPerMinute;
  if (category === "dyson") return metrics.peakDysonPowerKw;
  if (category === "throughput") return metrics.peakThroughputPerMinute;
  return metrics.galaxyScore;
}

function speedrunSubmissionKey(seasonId, targetId, userId, factoryId) {
  return `${seasonId}:${targetId}:${userId}:${factoryId}`;
}

function leaderboardPublicId(identity, kind = "galaxy") {
  return `public_${sha256(`dspidle-public-leaderboard-v1:${kind}:${identity}`).slice(0, 32)}`;
}

function speedrunEntryPublic(entry, rank = 0) {
  return projectPublicSpeedrunLeaderboard({
    category: SPEEDRUN_TARGETS[entry.targetId]?.category ?? "speedrun",
    targetId: entry.targetId,
    seasonId: entry.seasonId,
    rulesetVersion: entry.rulesetVersion,
    entries: [{ ...entry, rank: rank > 0 ? rank : 1 }],
    generatedAt: Date.now(),
  }, { publicIdFor: leaderboardPublicId, maximumEntries: 1 }).entries[0] ?? null;
}

function speedrunProgressFromState(state, targetId) {
  const speedrun = state?.speedrun;
  const baseline = speedrun?.baseline && typeof speedrun.baseline === "object" ? speedrun.baseline : {};
  if (targetId === "all_technologies") {
    const baselineIds = new Set(Array.isArray(baseline.completedTechIds) ? baseline.completedTechIds : []);
    const completed = new Set(Array.isArray(state?.research?.completedTechIds) ? state.research.completedTechIds : []);
    const current = SPEEDRUN_FINITE_TECH_IDS.filter((id) => completed.has(id) && !baselineIds.has(id)).length;
    const target = SPEEDRUN_FINITE_TECH_IDS.filter((id) => !baselineIds.has(id)).length;
    return { current, target, completed: current >= target };
  }
  if (targetId === "dyson_rockets_10000") {
    const current = Math.max(0, Math.floor(numberAt(state?.dysonSphere?.totalRocketsLaunched) - numberAt(baseline.rocketsLaunched)));
    return { current, target: 10_000, completed: current >= 10_000 };
  }
  const current = Math.max(0, Math.floor(numberAt(state?.totalProduced?.universe_matrix) - numberAt(baseline.whiteMatrixProduced)));
  return { current, target: 1_000_000, completed: current >= 1_000_000 };
}

function speedrunForbiddenStateReason(state) {
  if (state?.settings?.difficulty && state.settings.difficulty !== "standard") return "非标准难度不能进入速通正式榜";
  if (state?.extremeMode === true || state?.endgameExtremeMode === true || state?.settings?.endgameExtremeMode === true ||
    state?.speedrun?.extremeMode === true) return "极限模式状态不能进入速通正式榜";
  if (state?.experimentalSettlement === true || state?.approximateSettlement === true ||
    state?.speedrun?.experimentalSettlement === true || state?.speedrun?.approximateSettlement === true) {
    return "实验结算标记不能进入速通正式榜";
  }
  return null;
}

function validateSpeedrunSubmission(store, userId, body) {
  const targetId = typeof body?.targetId === "string" && Object.hasOwn(SPEEDRUN_TARGETS, body.targetId) ? body.targetId : null;
  if (!targetId) return { error: "速通目标无效", code: "SPEEDRUN_TARGET_INVALID", status: 400 };
  if (body.seasonId !== ACTIVE_LEADERBOARD_SEASON_ID || body.rulesetVersion !== SPEEDRUN_RULESET_VERSION) {
    return { error: "速通赛季或规则版本已封存", code: "SPEEDRUN_RULESET_INVALID", status: 409 };
  }
  let current = currentCloudSave(store, userId, "main", "speedrun");
  let currentMode = "speedrun";
  if (!current) return { error: "请先上传速通工厂主云存档", code: "SPEEDRUN_SAVE_MISSING", status: 409 };
  // Compatibility for pre-marker clients: if they subsequently uploaded an
  // ordinary save through the old unqualified endpoint, let the validator
  // inspect that ordinary payload and reject it as ordinary rather than
  // treating the revision mismatch as a valid speedrun submission.
  if (current.legacyMode === true && body.saveRevision !== current.revision) {
    const legacyNormal = currentCloudSave(store, userId, "main", "normal");
    if (legacyNormal?.revision === body.saveRevision) {
      current = legacyNormal;
      currentMode = "normal";
    }
  }
  if (!Number.isInteger(body.saveRevision) || body.saveRevision !== current.revision) {
    return { error: "速通提交必须使用当前速通云存档修订", code: "SPEEDRUN_REVISION_MISMATCH", status: 409, cloudSave: cloudSaveMetadata(current, "main", "speedrun") };
  }
  const hashMatches = typeof body.saveHash === "string" && (body.saveHash === current.checksum || body.saveHash === current.summary?.stateChecksum);
  if (!hashMatches) return { error: "速通存档摘要不匹配", code: "SPEEDRUN_HASH_MISMATCH", status: 409 };
  const materialized = materializeCloudSave(store, userId, "main", current, currentMode);
  const state = parseSaveState(materialized?.payload);
  const speedrun = state?.speedrun;
  const verifiedLegacySpeedrunMode = current.legacyMode === true && state?.mode === undefined;
  if (!state || (state.mode !== "speedrun" && !verifiedLegacySpeedrunMode) || !speedrun || speedrun.enabled !== true || speedrun.mode !== "speedrun") {
    return { error: "普通存档不能提交速通成绩", code: "SPEEDRUN_SAVE_NOT_ENABLED", status: 422 };
  }
  if (speedrun.rulesetVersion !== SPEEDRUN_RULESET_VERSION || speedrun.seasonId !== ACTIVE_LEADERBOARD_SEASON_ID || speedrun.eligible !== true) {
    return { error: speedrun.invalidReason || "速通存档未通过资格校验", code: "SPEEDRUN_SAVE_INELIGIBLE", status: 422 };
  }
  if (Array.isArray(state.contentPacks) && state.contentPacks.length > 0) {
    return { error: "启用内容包的存档不能进入速通正式榜", code: "SPEEDRUN_MODDED_SAVE", status: 422 };
  }
  const forbiddenStateReason = speedrunForbiddenStateReason(state);
  if (forbiddenStateReason) return { error: forbiddenStateReason, code: "SPEEDRUN_FORBIDDEN_STATE", status: 422 };
  const factoryId = typeof speedrun.factoryId === "string" ? speedrun.factoryId : "";
  if (!factoryId || body.factoryId !== factoryId) return { error: "速通工厂身份不匹配", code: "SPEEDRUN_FACTORY_MISMATCH", status: 422 };
  if (!Number.isSafeInteger(speedrun.startedAt) || speedrun.startedAt <= 0 || !Number.isFinite(speedrun.elapsedActiveSeconds) || speedrun.elapsedActiveSeconds < 0) {
    return { error: "速通计时字段异常", code: "SPEEDRUN_CLOCK_INVALID", status: 422 };
  }
  const elapsedSeconds = numberAt(speedrun.elapsedActiveSeconds);
  if (speedrun.startedAt > Date.now() + 5 * 60_000) return { error: "速通开始时间异常", code: "SPEEDRUN_START_INVALID", status: 422 };
  const wallAgeSeconds = Math.max(0, (Date.now() - speedrun.startedAt) / 1_000);
  if (elapsedSeconds > wallAgeSeconds + 5 * 60) {
    return { error: "速通有效计时超过可验证运行时间", code: "SPEEDRUN_CLOCK_INVALID", status: 422 };
  }
  const milestone = speedrun.milestones?.[targetId];
  const progress = speedrunProgressFromState(state, targetId);
  if (!progress.completed) return { error: "速通目标尚未完成", code: "SPEEDRUN_TARGET_INCOMPLETE", status: 422 };
  // Historical v46 saves can have the authoritative cumulative counter but
  // lack the derived milestone write. Accept that monotonic fact only, using
  // the current elapsed clock as a conservative time. The server never edits
  // the cloud payload or grants a faster result through this recovery path.
  const completedAtSeconds = milestone?.completed === true
    ? numberAt(milestone.completedAtSeconds)
    : elapsedSeconds;
  if (!Number.isFinite(body.elapsedSeconds) || body.elapsedSeconds <= 0 || completedAtSeconds <= 0 || Math.abs(body.elapsedSeconds - completedAtSeconds) > 0.000001 || completedAtSeconds > elapsedSeconds + 0.000001) {
    return { error: "客户端完成时间与存档不一致", code: "SPEEDRUN_TIME_INVALID", status: 422 };
  }
  return {
    state,
    current,
    targetId,
    factoryId,
    elapsedSeconds: completedAtSeconds,
    resourceMode: state?.settings?.resourceMode === "infinite" ? "infinite" : "finite",
    milestoneRecovered: milestone?.completed !== true,
    saveHash: current.checksum,
  };
}

function submitSpeedrunResult(store, user, body, now = Date.now()) {
  const validation = validateSpeedrunSubmission(store, user.id, body);
  if (validation.error) return validation;
  const key = speedrunSubmissionKey(validation.current ? body.seasonId : ACTIVE_LEADERBOARD_SEASON_ID, validation.targetId, user.id, validation.factoryId);
  const previous = store.data.speedrunSubmissions[key];
  if (previous && previous.saveRevision > validation.current.revision) {
    return { error: "检测到云存档回滚，成绩不可验证", code: "SPEEDRUN_ROLLBACK", status: 409 };
  }
  if (previous && previous.saveRevision === validation.current.revision && previous.saveHash === validation.saveHash && previous.elapsedSeconds === validation.elapsedSeconds) {
    return { entry: speedrunEntryPublic(previous), idempotent: true };
  }
  // A target is completed once per factory. A later revision may re-submit
  // the same result, but it cannot make that factory's elapsed time shorter;
  // accepting that would let a rolled-back or edited save rewrite its score.
  if (previous && validation.elapsedSeconds < previous.elapsedSeconds) {
    return { error: "检测到速通完成时间回退，成绩不可验证", code: "SPEEDRUN_ROLLBACK", status: 409 };
  }
  if (previous && previous.elapsedSeconds <= validation.elapsedSeconds) {
    return { entry: speedrunEntryPublic(previous), idempotent: true };
  }
  const entry = {
    submissionId: previous?.submissionId ?? `speedrun_${randomUUID()}`,
    userId: user.id,
    displayName: user.displayName,
    avatar: user.displayName.trim().slice(0, 1).toUpperCase() || "A",
    targetId: validation.targetId,
    seasonId: body.seasonId,
    rulesetVersion: body.rulesetVersion,
    factoryId: validation.factoryId,
    elapsedSeconds: validation.elapsedSeconds,
    completedAtSeconds: validation.elapsedSeconds,
    completedAt: now,
    receivedAt: now,
    saveRevision: validation.current.revision,
    saveHash: validation.saveHash,
    resourceMode: validation.resourceMode,
    verified: true,
  };
  store.data.speedrunSubmissions[key] = entry;
  return { entry: speedrunEntryPublic(entry), idempotent: false };
}

function cloneStoreData(data) {
  return structuredClone(data);
}

function persistenceErrorCategory(error) {
  const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  if (code.includes("FULL") || code === "ENOSPC") return "capacity";
  if (code.includes("BUSY") || code.includes("LOCKED")) return "busy";
  if (code.includes("READONLY") || code === "EACCES" || code === "EPERM") return "read-only";
  if (code.includes("IOERR") || code === "EIO") return "io";
  return "unknown";
}

function writeConflictError() {
  const error = new Error("服务器状态已被另一项操作更新，请刷新后重试");
  error.statusCode = 409;
  error.code = "STATE_WRITE_CONFLICT";
  error.persistenceFailure = false;
  return error;
}

class AtomicStoreBase {
  constructor(faultInjector = null) {
    this._data = cloneDefaultData();
    this.mutationStorage = new AsyncLocalStorage();
    this.mutationQueue = Promise.resolve();
    this.commitGeneration = 0;
    this.writeQueue = Promise.resolve();
    this.pendingWriteOperations = 0;
    this.maxPendingWriteOperations = 0;
    this.slowWriteCount = 0;
    this.lastWriteDurationMs = 0;
    this.lastPersistenceSuccessAt = null;
    this.lastPersistenceErrorAt = null;
    this.lastPersistenceErrorCategory = null;
    this.persistenceWritable = true;
    this.acceptingMutations = true;
    this.faultInjector = typeof faultInjector === "function" ? faultInjector : null;
    this.commitObservers = new Set();
    this.externalMutationObserver = null;
    this.externalCollectionProxies = new Map();
    this.externalDataView = new Proxy({}, {
      get: (_target, property) => this.externalValue(property),
      set: (_target, property, value) => {
        const previous = this._data[property];
        this._data[property] = value;
        this.externalMutationObserver?.({ collection: property, key: null, previous, value, operation: "set" });
        return true;
      },
      deleteProperty: (_target, property) => {
        const previous = this._data[property];
        const deleted = delete this._data[property];
        if (deleted) this.externalMutationObserver?.({ collection: property, key: null, previous, value: undefined, operation: "delete" });
        return deleted;
      },
      ownKeys: () => Reflect.ownKeys(this._data),
      getOwnPropertyDescriptor: (_target, property) => {
        if (!Reflect.has(this._data, property)) return undefined;
        return { configurable: true, enumerable: true, writable: true, value: this.externalValue(property) };
      },
    });
  }

  get data() {
    return this.mutationStorage.getStore()?.data ?? this.externalDataView;
  }

  set data(value) {
    const mutation = this.mutationStorage.getStore();
    if (mutation) mutation.data = value;
    else this._data = value;
  }

  currentMutation() {
    return this.mutationStorage.getStore() ?? null;
  }

  runAtomic(operation) {
    if (this.currentMutation()) return operation();
    if (!this.acceptingMutations) {
      const error = new Error("服务正在安全关闭，请稍后重试");
      error.statusCode = 503;
      error.code = "SERVER_SHUTTING_DOWN";
      return Promise.reject(error);
    }
    const execute = () => {
      const mutation = this.createStandaloneMutation();
      return this.mutationStorage.run(mutation, operation);
    };
    const result = this.mutationQueue.then(execute);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  persistenceStatus() {
    return {
      writable: this.persistenceWritable,
      lastSuccessAt: this.lastPersistenceSuccessAt,
      lastErrorAt: this.lastPersistenceErrorAt,
      lastErrorCategory: this.lastPersistenceErrorCategory,
      pendingWrites: this.pendingWriteOperations,
    };
  }

  maybeInjectPersistenceFault(phase, context = {}) {
    this.faultInjector?.({ phase, ...context });
  }

  enqueueWrite(operation) {
    this.pendingWriteOperations += 1;
    this.maxPendingWriteOperations = Math.max(this.maxPendingWriteOperations, this.pendingWriteOperations);
    const startedAt = performance.now();
    const result = this.writeQueue.then(operation);
    const observed = result.then((value) => {
      this.lastPersistenceSuccessAt = Date.now();
      this.persistenceWritable = true;
      this.observePersistence?.({ durationMs: Math.max(0, performance.now() - startedAt), ok: true, queueDepth: this.pendingWriteOperations });
      return value;
    }, (error) => {
      if (error?.persistenceFailure !== false) {
        this.lastPersistenceErrorAt = Date.now();
        this.lastPersistenceErrorCategory = persistenceErrorCategory(error);
        this.persistenceWritable = false;
      }
      this.observePersistence?.({
        durationMs: Math.max(0, performance.now() - startedAt),
        ok: false,
        errorCategory: persistenceErrorCategory(error),
        queueDepth: this.pendingWriteOperations,
      });
      throw error;
    }).finally(() => {
      this.pendingWriteOperations = Math.max(0, this.pendingWriteOperations - 1);
      this.lastWriteDurationMs = Math.max(0, performance.now() - startedAt);
      if (this.lastWriteDurationMs >= 1_000) this.slowWriteCount += 1;
    });
    this.writeQueue = observed.catch(() => undefined);
    return observed;
  }

  commitMutation(mutation, context = {}) {
    if (mutation.commitPromise) return mutation.commitPromise;
    mutation.commitPromise = this.enqueueWrite(async () => {
      if (mutation.baseGeneration !== this.commitGeneration) throw writeConflictError();
      // Clone before the durable write so allocation failure cannot happen
      // after SQLite commits. Publish the clone, not the request-owned graph:
      // handlers may retain object references after awaiting persist().
      const published = cloneStoreData(mutation.data);
      await this.commitCandidate(mutation.data, mutation, context);
      this._data = published;
      this.commitGeneration += 1;
      mutation.baseGeneration = this.commitGeneration;
      const runtimeIndexEvents = mutation.runtimeIndexEvents.splice(0);
      // SQLite is already committed at this point. Runtime cache publication
      // and legacy staging cleanup are deliberately best-effort and must never
      // turn a durable success into a failed HTTP response.
      try { this.afterMutationCommitted(mutation); } catch { /* durable state remains authoritative */ }
      for (const observer of this.commitObservers) {
        try { observer({ data: this._data, context, runtimeIndexEvents }); } catch { /* durable state remains authoritative */ }
      }
      mutation.writes.clear();
      mutation.fileWrites?.clear();
      mutation.deletes.clear();
      mutation.userDeletes.clear();
      mutation.replaceUserPayloads?.clear();
    }).finally(() => { mutation.commitPromise = null; });
    return mutation.commitPromise;
  }

  persist(context = {}) {
    const active = this.currentMutation();
    const mutation = active ?? this.createStandaloneMutation();
    if (!active) mutation.runtimeIndexEvents.push({ type: "rebuild" });
    return this.commitMutation(mutation, context);
  }

  createStandaloneMutation() {
    return {
      data: cloneStoreData(this._data),
      baseGeneration: this.commitGeneration,
      writes: new Map(),
      deletes: new Map(),
      userDeletes: new Set(),
      leaderboardWindowCache: new Map(this.leaderboardWindowCache instanceof Map ? this.leaderboardWindowCache : []),
      runtimeIndexEvents: [],
      commitPromise: null,
    };
  }

  afterMutationCommitted(_mutation) {
    if (_mutation.leaderboardWindowCache instanceof Map) this.leaderboardWindowCache = new Map(_mutation.leaderboardWindowCache);
  }

  onCommitted(observer) {
    if (typeof observer !== "function") throw new TypeError("commit observer must be a function");
    this.commitObservers.add(observer);
    return () => this.commitObservers.delete(observer);
  }

  setPersistenceObserver(observer) {
    this.observePersistence = typeof observer === "function" ? observer : null;
  }

  setExternalMutationObserver(observer) {
    this.externalMutationObserver = typeof observer === "function" ? observer : null;
  }

  externalValue(property) {
    const value = this._data[property];
    if (!this.externalMutationObserver || !["submissions", "users", "leaderboardModeration", "accountControls"].includes(property) || !value || typeof value !== "object") return value;
    const cached = this.externalCollectionProxies.get(property);
    if (cached?.target === value) return cached.proxy;
    const proxy = new Proxy(value, {
      set: (target, key, next) => {
        const previous = target[key];
        const updated = Reflect.set(target, key, next);
        if (updated && previous !== next) this.externalMutationObserver?.({ collection: property, key, previous, value: next, operation: "set" });
        return updated;
      },
      deleteProperty: (target, key) => {
        const previous = target[key];
        const deleted = Reflect.deleteProperty(target, key);
        if (deleted && previous !== undefined) this.externalMutationObserver?.({ collection: property, key, previous, value: undefined, operation: "delete" });
        return deleted;
      },
    });
    this.externalCollectionProxies.set(property, { target: value, proxy });
    return proxy;
  }

  recordRuntimeIndexEvent(event) {
    const mutation = this.currentMutation();
    if (!mutation || !event || typeof event !== "object") return false;
    mutation.runtimeIndexEvents.push(event);
    return true;
  }

  mutate(mutator, context = {}) {
    return this.runAtomic(async () => {
      const result = await mutator(this);
      await this.persist(context);
      return result;
    });
  }

  async drain() {
    await this.mutationQueue;
    await this.writeQueue;
  }

  beginShutdown() {
    this.acceptingMutations = false;
  }
}

class JsonStore extends AtomicStoreBase {
  constructor(file, faultInjector = null) {
    super(faultInjector);
    this.file = file;
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.data = normalizeStoredData(parsed);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  async commitCandidate(candidate, _mutation, context = {}) {
    const payload = JSON.stringify(candidate);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      this.maybeInjectPersistenceFault("before-json-write", context);
      await fs.writeFile(temporary, payload, { mode: 0o600 });
      this.maybeInjectPersistenceFault("before-json-rename", context);
      await fs.rename(temporary, this.file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async backup(destination) {
    await this.drain();
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(this.file, destination);
  }

  replaceUserCloudSavePayloads(userId) {
    this.discardUserCloudSavePayloads?.(userId);
  }

  stageCloudSavePayloadFile(userId, slot, save) {
    const raw = readFileSync(save.payloadFile);
    const payload = raw.toString("utf8");
    if (raw.byteLength !== save.size || Buffer.from(payload, "utf8").compare(raw) !== 0 || sha256(payload) !== save.checksum) {
      const error = new Error("账号归档临时正文在提交前发生变化");
      error.code = "ACCOUNT_ARCHIVE_IMPORT_TEMP_CHANGED";
      throw error;
    }
    return { ...metadataOnlySaveRecord(save), payload };
  }

  createCloudArchiveSnapshot() {
    const payloads = new Map();
    forEachCloudSaveRecord(this._data, (userId, slot, save, mode = "normal") => {
      if (!Number.isInteger(save?.revision) || typeof save?.payload !== "string") return;
      payloads.set(`${userId}\u0000${cloudStorageSlot(mode, slot)}\u0000${save.revision}`, save.payload);
    });
    return {
      readPayload(userId, storageSlot, revision) {
        return payloads.get(`${userId}\u0000${storageSlot}\u0000${revision}`) ?? null;
      },
      close() { payloads.clear(); },
    };
  }
}

function forEachCloudSaveRecord(source, visit) {
  if (!source || typeof source !== "object") return;
  if (source.cloudSaves && typeof source.cloudSaves === "object") {
    for (const [userId, save] of Object.entries(source.cloudSaves)) visit(userId, "main", save);
  }
  if (source.cloudSaveHistory && typeof source.cloudSaveHistory === "object") {
    for (const [userId, history] of Object.entries(source.cloudSaveHistory)) {
      if (Array.isArray(history)) for (const save of history) visit(userId, "main", save);
    }
  }
  if (source.cloudSaveSlots && typeof source.cloudSaveSlots === "object") {
    for (const [userId, slots] of Object.entries(source.cloudSaveSlots)) {
      if (!slots || typeof slots !== "object") continue;
      for (const slot of MANUAL_CLOUD_SAVE_SLOTS) visit(userId, slot, slots[slot]);
    }
  }
  if (source.cloudSaveSlotHistory && typeof source.cloudSaveSlotHistory === "object") {
    for (const [userId, slots] of Object.entries(source.cloudSaveSlotHistory)) {
      if (!slots || typeof slots !== "object") continue;
      for (const slot of MANUAL_CLOUD_SAVE_SLOTS) {
        if (Array.isArray(slots[slot])) for (const save of slots[slot]) visit(userId, slot, save);
      }
    }
  }
  for (const [userId, modes] of Object.entries(source.cloudSavesByMode ?? {})) {
    if (!modes || typeof modes !== "object") continue;
    for (const mode of SAVE_MODES) visit(userId, "main", modes[mode], mode);
  }
  for (const [userId, modes] of Object.entries(source.cloudSaveHistoryByMode ?? {})) {
    if (!modes || typeof modes !== "object") continue;
    for (const mode of SAVE_MODES) {
      if (Array.isArray(modes[mode])) for (const save of modes[mode]) visit(userId, "main", save, mode);
    }
  }
  for (const [userId, modes] of Object.entries(source.cloudSaveSlotsByMode ?? {})) {
    if (!modes || typeof modes !== "object") continue;
    for (const mode of SAVE_MODES) {
      const slots = modes[mode];
      if (!slots || typeof slots !== "object") continue;
      for (const slot of MANUAL_CLOUD_SAVE_SLOTS) visit(userId, slot, slots[slot], mode);
    }
  }
  for (const [userId, modes] of Object.entries(source.cloudSaveSlotHistoryByMode ?? {})) {
    if (!modes || typeof modes !== "object") continue;
    for (const mode of SAVE_MODES) {
      const slots = modes[mode];
      if (!slots || typeof slots !== "object") continue;
      for (const slot of MANUAL_CLOUD_SAVE_SLOTS) {
        if (Array.isArray(slots[slot])) for (const save of slots[slot]) visit(userId, slot, save, mode);
      }
    }
  }
}

function metadataOnlySaveRecord(save) {
  if (!save || typeof save !== "object") return save;
  const { payload: _payload, payloadFile: _payloadFile, ...metadata } = save;
  return metadata;
}

function cloudPayloadReferenceKey(userId, slot, revision) {
  return `${userId}\u0000${slot}\u0000${revision}`;
}

function addCloudPayloadCleanupCandidate(candidates, reference) {
  if (!reference || typeof reference.checksum !== "string" || !Number.isSafeInteger(reference.sizeBytes)) return;
  const previousSize = candidates.get(reference.checksum);
  if (previousSize !== undefined && previousSize !== reference.sizeBytes) {
    const error = new Error("同一云正文地址的 alias 大小不一致");
    error.code = "CLOUD_PAYLOAD_ALIAS_SIZE_MISMATCH";
    throw error;
  }
  candidates.set(reference.checksum, reference.sizeBytes);
}

function buildCloudPayloadReferenceIndex(database) {
  const startupAudit = auditCloudPayloadAliasReferences(database);
  const references = new Map();
  const counts = new Map();
  for (const reference of startupAudit.references) {
    references.set(
      cloudPayloadReferenceKey(reference.userId, reference.slot, reference.revision),
      reference,
    );
    counts.set(reference.checksum, (counts.get(reference.checksum) ?? 0) + 1);
  }
  return { references, counts, audit: startupAudit.audit };
}

function prepareCloudPayloadReferenceCommit(currentReferences, currentCounts, mutation, cleanupCandidates) {
  const referenceChanges = new Map();
  const countDeltas = new Map();
  const referenceAt = (key) => referenceChanges.has(key) ? referenceChanges.get(key) : currentReferences.get(key);
  const adjustCount = (checksum, delta) => {
    countDeltas.set(checksum, (countDeltas.get(checksum) ?? 0) + delta);
  };
  const removeKey = (key) => {
    const previous = referenceAt(key);
    if (previous) {
      addCloudPayloadCleanupCandidate(cleanupCandidates, previous);
      adjustCount(previous.checksum, -1);
    }
    referenceChanges.set(key, null);
  };
  const removeUser = (userId) => {
    for (const [key, reference] of currentReferences) {
      if (reference.userId !== userId) continue;
      removeKey(key);
    }
  };
  for (const userId of mutation.replaceUserPayloads) removeUser(userId);
  for (const userId of mutation.userDeletes) removeUser(userId);
  for (const deletion of mutation.deletes.values()) {
    removeKey(cloudPayloadReferenceKey(deletion.userId, deletion.slot, deletion.revision));
  }
  for (const write of [...mutation.writes.values(), ...mutation.fileWrites.values()]) {
    const key = cloudPayloadReferenceKey(write.userId, write.slot, write.revision);
    removeKey(key);
    if (typeof write.checksum === "string" && /^[a-f0-9]{64}$/.test(write.checksum) &&
      Number.isSafeInteger(write.sizeBytes) && write.sizeBytes >= 0) {
      referenceChanges.set(key, {
        userId: write.userId,
        slot: write.slot,
        revision: write.revision,
        checksum: write.checksum,
        sizeBytes: write.sizeBytes,
      });
      adjustCount(write.checksum, 1);
    }
  }
  const projectedCounts = new Map();
  for (const [checksum, delta] of countDeltas) {
    const projected = (currentCounts.get(checksum) ?? 0) + delta;
    if (!Number.isSafeInteger(projected) || projected < 0) {
      const error = new Error("云正文引用索引计数不一致");
      error.code = "CLOUD_PAYLOAD_REFERENCE_COUNT_INVALID";
      throw error;
    }
    projectedCounts.set(checksum, projected);
  }
  return { referenceChanges, projectedCounts };
}

function cloudPayloadCandidateReferenceCounts(currentCounts, projectedCounts, candidates, referenceIndexComplete) {
  const counts = new Map([...candidates.keys()].map((checksum) => [checksum, 0]));
  if (referenceIndexComplete !== true) {
    for (const checksum of counts.keys()) counts.set(checksum, 1);
    return counts;
  }
  for (const checksum of counts.keys()) {
    counts.set(checksum, projectedCounts.has(checksum) ? projectedCounts.get(checksum) : (currentCounts.get(checksum) ?? 0));
  }
  return counts;
}

function publishCloudPayloadReferenceCommit(references, counts, prepared) {
  for (const [key, reference] of prepared.referenceChanges) {
    if (reference) references.set(key, reference);
    else references.delete(key);
  }
  for (const [checksum, count] of prepared.projectedCounts) {
    if (count === 0) counts.delete(checksum);
    else counts.set(checksum, count);
  }
}

class SqliteStore extends AtomicStoreBase {
  constructor(file, faultInjector = null) {
    super(faultInjector);
    this.file = file;
    this.data = cloneDefaultData();
    this.database = null;
    this.pendingCloudSaveWrites = new Map();
    this.pendingCloudSaveDeletes = new Map();
    this.pendingCloudSaveUserDeletes = new Set();
    this.cloudPayloadReferenceIndex = new Map();
    this.cloudPayloadReferenceCounts = new Map();
    this.cloudPayloadReferenceAudit = {
      complete: true,
      scannedRows: 0,
      aliasRows: 0,
      directRows: 0,
      invalidAliasRows: 0,
      invalidStorageTypeRows: 0,
      maximumProjectedCharacters: 161,
    };
    this.runtimeStatePersistence = null;
  }

  rebuildCloudPayloadReferenceIndex() {
    const rebuilt = buildCloudPayloadReferenceIndex(this.database);
    this.cloudPayloadReferenceIndex = rebuilt.references;
    this.cloudPayloadReferenceCounts = rebuilt.counts;
    this.cloudPayloadReferenceAudit = rebuilt.audit;
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    this.database = new Database(this.file);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.exec("CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    this.database.exec("CREATE TABLE IF NOT EXISTS cloud_save_payloads (user_id TEXT NOT NULL, slot TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (user_id, slot, revision)) WITHOUT ROWID");
    initializeCloudPayloadStore(this.database);
    const row = this.database.prepare("SELECT payload, updated_at AS updatedAt FROM app_state WHERE id = 1").get();
    if (!row?.payload) {
      this.data.storageLayoutVersion = SQLITE_CLOUD_PAYLOAD_LAYOUT_VERSION;
      await this.persist();
      const initialized = this.database.prepare("SELECT payload, updated_at AS updatedAt FROM app_state WHERE id = 1").get();
      this.runtimeStatePersistence = new SqliteRuntimeStatePersistence(this.database, { faultInjector: this.faultInjector });
      this.runtimeStatePersistence.initialize(this._data, {
        appStateUpdatedAt: initialized.updatedAt,
        appStateFingerprint: runtimeAppStateFingerprint(initialized.payload),
      });
      this.rebuildCloudPayloadReferenceIndex();
      return;
    }
    const parsed = JSON.parse(row.payload);
    if (parsed?.storageLayoutVersion === SQLITE_CLOUD_PAYLOAD_LAYOUT_VERSION) {
      const normalized = normalizeStoredData(parsed);
      this.runtimeStatePersistence = new SqliteRuntimeStatePersistence(this.database, { faultInjector: this.faultInjector });
      this.runtimeStatePersistence.initialize(normalized, {
        appStateUpdatedAt: row.updatedAt,
        appStateFingerprint: runtimeAppStateFingerprint(row.payload),
      });
      this.data = this.runtimeStatePersistence.hydrateState(normalized);
      row.payload = null;
      this.rebuildCloudPayloadReferenceIndex();
      return;
    }
    row.payload = null;
    await this.migrateLegacyPayloadLayout(parsed);
    const migrated = this.database.prepare("SELECT payload, updated_at AS updatedAt FROM app_state WHERE id = 1").get();
    this.runtimeStatePersistence = new SqliteRuntimeStatePersistence(this.database, { faultInjector: this.faultInjector });
    this.runtimeStatePersistence.initialize(this._data, {
      appStateUpdatedAt: migrated.updatedAt,
      appStateFingerprint: runtimeAppStateFingerprint(migrated.payload),
    });
    this.rebuildCloudPayloadReferenceIndex();
  }

  async importLegacyData(source) {
    await this.migrateLegacyPayloadLayout(source);
    const migrated = this.database.prepare("SELECT payload, updated_at AS updatedAt FROM app_state WHERE id = 1").get();
    this.runtimeStatePersistence ??= new SqliteRuntimeStatePersistence(this.database, { faultInjector: this.faultInjector });
    this.runtimeStatePersistence.initialize(this._data, {
      appStateUpdatedAt: migrated.updatedAt,
      appStateFingerprint: runtimeAppStateFingerprint(migrated.payload),
    });
    this.rebuildCloudPayloadReferenceIndex();
  }

  createStandaloneMutation() {
    return {
      ...super.createStandaloneMutation(),
      writes: new Map(this.pendingCloudSaveWrites),
      fileWrites: new Map(),
      deletes: new Map(this.pendingCloudSaveDeletes),
      userDeletes: new Set(this.pendingCloudSaveUserDeletes),
      replaceUserPayloads: new Set(),
      legacyPending: true,
    };
  }

  afterMutationCommitted(mutation) {
    super.afterMutationCommitted(mutation);
    if (!mutation.legacyPending) return;
    for (const [key, write] of mutation.writes) {
      if (this.pendingCloudSaveWrites.get(key) === write) this.pendingCloudSaveWrites.delete(key);
    }
    for (const [key, deletion] of mutation.deletes) {
      if (this.pendingCloudSaveDeletes.get(key) === deletion) this.pendingCloudSaveDeletes.delete(key);
    }
    for (const userId of mutation.userDeletes) this.pendingCloudSaveUserDeletes.delete(userId);
  }

  stageCloudSavePayload(userId, slot, save) {
    const metadata = metadataOnlySaveRecord(save);
    if (typeof save?.payload !== "string") return metadata;
    const revision = Number.isInteger(save.revision) && save.revision > 0 ? save.revision : null;
    if (!revision) return metadata;
    const key = `${userId}\u0000${slot}\u0000${revision}`;
    const mutation = this.currentMutation();
    const writes = mutation?.writes ?? this.pendingCloudSaveWrites;
    const fileWrites = mutation?.fileWrites;
    const deletes = mutation?.deletes ?? this.pendingCloudSaveDeletes;
    const userDeletes = mutation?.userDeletes ?? this.pendingCloudSaveUserDeletes;
    writes.set(key, {
      userId,
      slot,
      revision,
      payload: save.payload,
      ...(typeof save.checksum === "string" ? { checksum: save.checksum } : {}),
      ...(Number.isSafeInteger(save.size) ? { sizeBytes: save.size } : {}),
    });
    fileWrites?.delete(key);
    deletes.delete(key);
    userDeletes.delete(userId);
    return metadata;
  }

  stageCloudSavePayloadFile(userId, slot, save) {
    const metadata = metadataOnlySaveRecord(save);
    const revision = Number.isInteger(save?.revision) && save.revision > 0 ? save.revision : null;
    if (!revision || typeof save?.payloadFile !== "string" || !path.isAbsolute(save.payloadFile) ||
      typeof save?.checksum !== "string" || !/^[a-f0-9]{64}$/.test(save.checksum) ||
      !Number.isSafeInteger(save?.size) || save.size < 1) {
      const error = new Error("账号归档导入正文暂存描述无效");
      error.statusCode = 500;
      error.code = "ACCOUNT_ARCHIVE_IMPORT_STAGING_INVALID";
      throw error;
    }
    const mutation = this.currentMutation();
    if (!mutation) {
      const error = new Error("账号归档导入正文只能在原子事务中暂存");
      error.statusCode = 500;
      error.code = "ACCOUNT_ARCHIVE_IMPORT_TRANSACTION_REQUIRED";
      throw error;
    }
    const key = `${userId}\u0000${slot}\u0000${revision}`;
    mutation.writes.delete(key);
    mutation.deletes.delete(key);
    mutation.fileWrites.set(key, {
      userId,
      slot,
      revision,
      payloadFile: save.payloadFile,
      checksum: save.checksum,
      sizeBytes: save.size,
    });
    return metadata;
  }

  replaceUserCloudSavePayloads(userId) {
    const mutation = this.currentMutation();
    if (!mutation) {
      const error = new Error("账号归档导入替换只能在原子事务中执行");
      error.statusCode = 500;
      error.code = "ACCOUNT_ARCHIVE_IMPORT_TRANSACTION_REQUIRED";
      throw error;
    }
    mutation.replaceUserPayloads.add(userId);
    mutation.userDeletes.delete(userId);
    for (const [key, write] of mutation.writes) if (write.userId === userId) mutation.writes.delete(key);
    for (const [key, write] of mutation.fileWrites) if (write.userId === userId) mutation.fileWrites.delete(key);
    for (const [key, deletion] of mutation.deletes) if (deletion.userId === userId) mutation.deletes.delete(key);
  }

  discardCloudSavePayload(userId, slot, revision) {
    if (!Number.isInteger(revision) || revision <= 0) return;
    const key = `${userId}\u0000${slot}\u0000${revision}`;
    const mutation = this.currentMutation();
    const writes = mutation?.writes ?? this.pendingCloudSaveWrites;
    const fileWrites = mutation?.fileWrites;
    const deletes = mutation?.deletes ?? this.pendingCloudSaveDeletes;
    writes.delete(key);
    fileWrites?.delete(key);
    deletes.set(key, { userId, slot, revision });
  }

  discardUserCloudSavePayloads(userId) {
    const mutation = this.currentMutation();
    const writes = mutation?.writes ?? this.pendingCloudSaveWrites;
    const fileWrites = mutation?.fileWrites;
    const deletes = mutation?.deletes ?? this.pendingCloudSaveDeletes;
    const userDeletes = mutation?.userDeletes ?? this.pendingCloudSaveUserDeletes;
    userDeletes.add(userId);
    for (const [key, write] of writes) {
      if (write.userId === userId) writes.delete(key);
    }
    if (fileWrites) for (const [key, write] of fileWrites) {
      if (write.userId === userId) fileWrites.delete(key);
    }
    for (const [key, deletion] of deletes) {
      if (deletion.userId === userId) deletes.delete(key);
    }
  }

  readCloudSavePayload(userId, slot, revision) {
    if (!Number.isInteger(revision) || revision <= 0) return null;
    const mutation = this.currentMutation();
    if (mutation?.userDeletes.has(userId)) return null;
    const key = `${userId}\u0000${slot}\u0000${revision}`;
    if (mutation?.deletes.has(key)) return null;
    const drafted = mutation?.writes.get(key);
    if (drafted) return drafted.payload;
    const fileDraft = mutation?.fileWrites?.get(key);
    if (fileDraft) {
      const raw = readFileSync(fileDraft.payloadFile);
      if (raw.byteLength !== fileDraft.sizeBytes || createHash("sha256").update(raw).digest("hex") !== fileDraft.checksum) {
        const error = new Error("账号归档临时正文在事务内发生变化");
        error.code = "ACCOUNT_ARCHIVE_IMPORT_TEMP_CHANGED";
        throw error;
      }
      return raw.toString("utf8");
    }
    if (mutation?.replaceUserPayloads?.has(userId)) return null;
    return readCloudPayload(this.database, { userId, slot, revision });
  }

  createCloudArchiveSnapshot() {
    const snapshot = new Database(this.file, { readonly: true, fileMustExist: true });
    let closed = false;
    try {
      snapshot.pragma("query_only = ON");
      snapshot.exec("BEGIN");
      // Force SQLite to establish the WAL snapshot while this request still
      // owns the mutation fence. Subsequent uploads can commit without
      // changing the revision rows observed by this archive stream.
      snapshot.prepare("SELECT updated_at FROM app_state WHERE id = 1").get();
      return {
        readPayload(userId, storageSlot, revision) {
          if (closed) return null;
          return readCloudPayload(snapshot, { userId, slot: storageSlot, revision });
        },
        close() {
          if (closed) return;
          closed = true;
          try { snapshot.exec("ROLLBACK"); } catch { /* snapshot already ended */ }
          snapshot.close();
        },
      };
    } catch (error) {
      try { snapshot.close(); } catch { /* initialization already failed */ }
      throw error;
    }
  }

  async commitCandidate(candidate, mutation, context = {}) {
    candidate.storageLayoutVersion = SQLITE_CLOUD_PAYLOAD_LAYOUT_VERSION;
    const operation = typeof context.operation === "string" ? context.operation : "store.persist";
    const runtimePlan = this.runtimeStatePersistence
      ? createRuntimeStatePersistencePlan(this._data, candidate, {
        operation,
        runtimeIndexEvents: mutation.runtimeIndexEvents,
        dirtyServiceDays: Object.keys(candidate.dailyMetrics ?? {}).filter((day) =>
          !Object.is(candidate.dailyMetrics?.[day], this._data.dailyMetrics?.[day]) ||
          JSON.stringify(candidate.dailyMetrics?.[day]) !== JSON.stringify(this._data.dailyMetrics?.[day])),
      })
      : null;
    const skipAppState = runtimePlan?.canSkipAppState === true;
    const payload = skipAppState ? null : JSON.stringify(candidate);
    const writeState = this.database.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at");
    let runtimeCommitResult = null;
    const blobCleanupCandidates = new Map();
    const nextCloudPayloadReferenceState = prepareCloudPayloadReferenceCommit(
      this.cloudPayloadReferenceIndex,
      this.cloudPayloadReferenceCounts,
      mutation,
      blobCleanupCandidates,
    );
    this.database.transaction(() => {
      this.maybeInjectPersistenceFault("before-sqlite-transaction", context);
      for (const userId of mutation.replaceUserPayloads) deleteCloudPayloadsForUser(this.database, userId, { blobCleanupCandidates });
      for (const userId of mutation.userDeletes) deleteCloudPayloadsForUser(this.database, userId, { blobCleanupCandidates });
      this.maybeInjectPersistenceFault("after-user-payload-deletes", context);
      for (const deletion of mutation.deletes.values()) deleteCloudPayload(this.database, deletion, { blobCleanupCandidates });
      this.maybeInjectPersistenceFault("after-payload-deletes", context);
      for (const write of mutation.writes.values()) writeInspectedCloudPayload(this.database, write);
      const importedChecksums = new Set();
      for (const write of mutation.fileWrites.values()) {
        if (importedChecksums.has(write.checksum)) {
          linkVerifiedCloudPayload(this.database, write);
          continue;
        }
        let raw = readFileSync(write.payloadFile);
        if (raw.byteLength !== write.sizeBytes || createHash("sha256").update(raw).digest("hex") !== write.checksum) {
          const error = new Error("账号归档临时正文在 SQLite 提交前发生变化");
          error.code = "ACCOUNT_ARCHIVE_IMPORT_TEMP_CHANGED";
          throw error;
        }
        const payload = raw.toString("utf8");
        // The extraction pass and authoritative worker already proved strict
        // UTF-8. Matching the same SHA-256 here proves the temporary bytes did
        // not change, so avoid allocating another large re-encoded Buffer.
        raw = Buffer.alloc(0);
        writeInspectedCloudPayload(this.database, { ...write, payload });
        importedChecksums.add(write.checksum);
      }
      this.maybeInjectPersistenceFault("after-payload-writes", context);
      if (!skipAppState) writeState.run(payload, Date.now());
      if (runtimePlan) runtimeCommitResult = this.runtimeStatePersistence.applyPlanInTransaction(runtimePlan, { operation, synchronizeAppState: !skipAppState });
      this.maybeInjectPersistenceFault("after-app-state-write", context);
      if (blobCleanupCandidates.size > 0) {
        garbageCollectCloudPayloadBlobCandidates(
          this.database,
          blobCleanupCandidates,
          cloudPayloadCandidateReferenceCounts(
            this.cloudPayloadReferenceCounts,
            nextCloudPayloadReferenceState.projectedCounts,
            blobCleanupCandidates,
            this.cloudPayloadReferenceAudit.complete,
          ),
        );
        this.maybeInjectPersistenceFault("after-payload-blob-cleanup", context);
      }
    })();
    publishCloudPayloadReferenceCommit(
      this.cloudPayloadReferenceIndex,
      this.cloudPayloadReferenceCounts,
      nextCloudPayloadReferenceState,
    );
    if (runtimePlan) this.runtimeStatePersistence.observeCommitted(runtimePlan, runtimeCommitResult);
  }

  async previewCloudHistoryPrune() {
    await this.writeQueue;
    const rows = this.database.prepare("SELECT user_id AS userId, slot, revision FROM cloud_save_payloads ORDER BY user_id, slot, revision").all();
    return buildCloudHistoryPrunePlan(this.data, rows);
  }

  async applyCloudHistoryPrune(expectedPreviewId) {
    await this.writeQueue;
    const plan = await this.previewCloudHistoryPrune();
    if (plan.previewId !== expectedPreviewId) {
      const error = new Error("裁剪预览已变化，请重新确认");
      error.statusCode = 409;
      error.code = "CLOUD_PRUNE_PREVIEW_CHANGED";
      throw error;
    }
    const metadataRemoved = trimCloudHistoryMetadataInPlace(this.data);
    for (const deletion of plan.deletions) this.discardCloudSavePayload(deletion.userId, deletion.slot, deletion.revision);
    return { ...publicCloudHistoryPrunePlan(plan), metadataRemoved };
  }

  governanceMetrics(fileStats = {}) {
    return collectSqliteGovernanceMetrics(this.database, this.data, fileStats);
  }

  async migrateLegacyPayloadLayout(source) {
    source = source && typeof source === "object" ? source : cloneDefaultData();
    const writes = new Map();
    forEachCloudSaveRecord(source, (userId, slot, save, mode = "normal") => {
      if (!save || typeof save !== "object") return;
      const revision = Number.isInteger(save.revision) && save.revision > 0 ? save.revision : null;
      if (revision && typeof save.payload === "string") {
        const storageSlot = cloudStorageSlot(mode, slot);
        const key = `${userId}\u0000${storageSlot}\u0000${revision}`;
        if (!writes.has(key)) writes.set(key, { userId, slot: storageSlot, revision, payload: save.payload });
      }
      if (save.summary === undefined) save.summary = summarizeSavePayload(save.payload);
      delete save.payload;
    });
    source.storageLayoutVersion = SQLITE_CLOUD_PAYLOAD_LAYOUT_VERSION;
    const candidate = normalizeStoredData(source);
    const retainedKeys = new Set();
    forEachCloudSaveRecord(candidate, (userId, slot, save, mode = "normal") => {
      if (Number.isInteger(save?.revision) && save.revision > 0) retainedKeys.add(`${userId}\u0000${cloudStorageSlot(mode, slot)}\u0000${save.revision}`);
    });
    const payload = JSON.stringify(candidate);
    await this.enqueueWrite(() => {
      const writeState = this.database.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at");
      const writeCloudPayload = this.database.prepare("INSERT INTO cloud_save_payloads (user_id, slot, revision, payload) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, slot, revision) DO UPDATE SET payload = excluded.payload");
      this.database.transaction(() => {
        this.maybeInjectPersistenceFault("before-sqlite-transaction", { operation: "storage.migrate-layout" });
        this.database.prepare("DELETE FROM cloud_save_payloads").run();
        this.maybeInjectPersistenceFault("after-payload-deletes", { operation: "storage.migrate-layout" });
        for (const [key, write] of writes) {
          if (retainedKeys.has(key)) writeCloudPayload.run(write.userId, write.slot, write.revision, write.payload);
        }
        this.maybeInjectPersistenceFault("after-payload-writes", { operation: "storage.migrate-layout" });
        writeState.run(payload, Date.now());
        this.maybeInjectPersistenceFault("after-app-state-write", { operation: "storage.migrate-layout" });
      })();
    });
    this._data = candidate;
    this.commitGeneration += 1;
  }

  async backup(destination) {
    await this.drain();
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await this.database.backup(destination);
  }

  close() {
    this.database?.close();
  }
}

export function createRateLimiter(nowProvider = Date.now) {
  const buckets = new Map();
  let nextCleanupAt = 0;
  const cleanup = (now = nowProvider()) => {
    let removed = 0;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt > now) continue;
      buckets.delete(key);
      removed += 1;
    }
    nextCleanupAt = now + 60_000;
    return removed;
  };
  const rateLimit = (key, maximum, windowMs) => {
    const now = nowProvider();
    if (now >= nextCleanupAt) cleanup(now);
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= maximum;
  };
  rateLimit.cleanup = cleanup;
  return rateLimit;
}

export function cleanupExpiredAuthRecords(data, now = Date.now()) {
  const users = data?.users && typeof data.users === "object" ? data.users : {};
  const removed = { sessions: 0, emailVerifications: 0, passwordResets: 0, total: 0 };
  for (const collectionName of ["sessions", "emailVerifications", "passwordResets"]) {
    const collection = data?.[collectionName];
    if (!collection || typeof collection !== "object") continue;
    for (const [tokenHash, record] of Object.entries(collection)) {
      const invalid = !record
        || typeof record !== "object"
        || !users[record.userId]
        || !Number.isFinite(record.expiresAt)
        || record.expiresAt <= now;
      if (!invalid) continue;
      delete collection[tokenHash];
      removed[collectionName] += 1;
      removed.total += 1;
    }
  }
  return removed;
}

function requestIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  const chain = typeof forwarded === "string" ? forwarded.split(",").map((value) => value.trim()).filter(Boolean) : [];
  return chain.at(-1) || request.socket.remoteAddress || "unknown";
}

function appendAudit(store, request, action, userId = null) {
  store.data.auditLog.push({
    action: String(action).slice(0, 80),
    occurredAt: Date.now(),
    actorHash: userId ? sha256(`audit-user:${userId}`).slice(0, 16) : null,
    ipHash: sha256(`audit-ip:${requestIp(request)}`).slice(0, 16),
    clientType: clientTypeForRequest(request),
  });
  if (store.data.auditLog.length > 2000) store.data.auditLog.splice(0, store.data.auditLog.length - 2000);
}

function appendSystemAudit(store, action, userId = null, clientType = "operations") {
  store.data.auditLog.push({
    action: String(action).slice(0, 80),
    occurredAt: Date.now(),
    actorHash: userId ? sha256(`audit-user:${userId}`).slice(0, 16) : null,
    ipHash: null,
    clientType: String(clientType).slice(0, 32),
  });
  if (store.data.auditLog.length > 2000) store.data.auditLog.splice(0, store.data.auditLog.length - 2000);
}

function appendAdminAudit(store, request, action) {
  const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
  store.data.auditLog.push({
    action: String(action).slice(0, 80),
    occurredAt: Date.now(),
    actorHash: authorization ? sha256(`audit-admin:${authorization}`).slice(0, 16) : null,
    ipHash: sha256(`audit-ip:${requestIp(request)}`).slice(0, 16),
    clientType: "admin-api",
  });
  if (store.data.auditLog.length > 2000) store.data.auditLog.splice(0, store.data.auditLog.length - 2000);
}

function deleteAccountData(store, userId) {
  revokeUserSessions(store, userId);
  removeUserActionTokens(store, userId);
  delete store.data.cloudSaves[userId];
  delete store.data.cloudSaveHistory[userId];
  delete store.data.cloudSaveSlots[userId];
  delete store.data.cloudSaveSlotHistory[userId];
  delete store.data.cloudSavesByMode[userId];
  delete store.data.cloudSaveHistoryByMode[userId];
  delete store.data.cloudSaveSlotsByMode[userId];
  delete store.data.cloudSaveSlotHistoryByMode[userId];
  delete store.data.leaderboardModeration[userId];
  delete store.data.accountSecurity[userId];
  delete store.data.accountControls[userId];
  for (const [requestId, receipt] of Object.entries(store.data.operationReceipts ?? {})) {
    if (receipt?.userId === userId) delete store.data.operationReceipts[requestId];
  }
  store.discardUserCloudSavePayloads?.(userId);
  removeUserLeaderboardSubmissions(store, userId);
  for (const [key, submission] of Object.entries(store.data.speedrunSubmissions)) {
    if (submission.userId === userId) delete store.data.speedrunSubmissions[key];
  }
  store.data.feedback = store.data.feedback.filter((entry) => entry.userId !== userId);
  store.data.errors = store.data.errors.filter((entry) => entry.userId !== userId);
  delete store.data.users[userId];
  store.recordRuntimeIndexEvent?.({ type: "leaderboard-account", userId });
}

function adminAccountSummary(store, userId) {
  const user = store.data.users[userId];
  if (!user) return null;
  const savesByMode = Object.fromEntries(SAVE_MODES.map((mode) => [mode,
    CLOUD_SAVE_SLOTS.map((slot) => ({ slot, save: currentCloudSave(store, userId, slot, mode), history: saveHistory(store, userId, slot, mode) })),
  ]));
  const cloudBytes = Object.values(savesByMode).flat().reduce((sum, entry) =>
    sum + (entry.history ?? []).reduce((historySum, save) => historySum + Math.max(0, Number(save.size) || 0), 0), 0);
  const controls = store.data.accountControls[userId] ?? null;
  const reviewRevisions = leaderboardRevalidationThresholds(store.data, userId);
  return {
    accountId: userId,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt,
    emailBound: Boolean(user.email),
    emailVerified: Number.isFinite(user.emailVerifiedAt),
    leaderboardVisible: user.leaderboardVisible !== false,
    sessionCount: Object.values(store.data.sessions).filter((session) => session.userId === userId && session.expiresAt > Date.now()).length,
    recentLogins: publicLoginSecurityEvents(store.data, userId),
    cloud: {
      bytes: cloudBytes,
      modes: Object.fromEntries(SAVE_MODES.map((mode) => [mode,
        Object.fromEntries(savesByMode[mode].map(({ slot, save, history }) => [slot, {
          revision: save?.revision ?? 0,
          size: save?.size ?? 0,
          historyCount: history.length,
        }])),
      ])),
      // Keep the pre-v7 ordinary-mode shape for existing operations clients.
      slots: Object.fromEntries(savesByMode.normal.map(({ slot, save, history }) => [slot, {
        revision: save?.revision ?? 0,
        size: save?.size ?? 0,
        historyCount: history.length,
      }])),
    },
    loginDisabledUntil: controls?.loginDisabledUntil ?? null,
    leaderboardRestricted: isLeaderboardRestricted(store.data, userId),
    leaderboardResumeAfterRevision: reviewRevisions.normal || null,
    leaderboardResumeAfterRevisionByMode: {
      normal: reviewRevisions.normal || null,
      speedrun: reviewRevisions.speedrun || null,
    },
  };
}

function send(response, status, payload, extraHeaders = {}) {
  const normalizedPayload = status === 401
    && payload
    && typeof payload === "object"
    && !("code" in payload)
    && (payload.error === "请先登录" || payload.error === "登录已过期")
      ? { ...payload, code: "SESSION_EXPIRED" }
      : payload;
  const body = status === 204 ? "" : JSON.stringify(normalizedPayload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-dsp-api-capabilities": "direct-cloud-payload-v1",
    ...securityResponseHeaders({
      privacy: "private",
      responseKind: status >= 400 ? "error" : "api",
      cors: response.httpSecurityCors ?? null,
      secureTransport: response.httpSecuritySecureTransport === true,
    }),
    ...extraHeaders,
  });
  response.end(body);
}

function cloudUploadCancelledError(signal) {
  if (signal?.reason?.code === "SERVER_SHUTTING_DOWN") return signal.reason;
  const error = new Error("云存档上传已取消，本地存档未修改");
  error.statusCode = 499;
  error.code = "UPLOAD_CANCELLED";
  return error;
}

function writeResponseChunk(response, chunk) {
  if (response.destroyed || response.writableEnded) {
    const error = new Error("云存档下载已取消");
    error.code = "DOWNLOAD_CANCELLED";
    return Promise.reject(error);
  }
  if (response.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      response.removeListener("error", onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => {
      cleanup();
      const error = new Error("云存档下载已取消");
      error.code = "DOWNLOAD_CANCELLED";
      reject(error);
    };
    const onError = (error) => { cleanup(); reject(error); };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

async function sendCloudSaveDownload(response, save, mode, slot) {
  if (!save) return send(response, 200, { cloudSave: null, mode, slot });
  const metadata = cloudSaveMetadata(save, slot, mode);
  const metadataJson = JSON.stringify(metadata);
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "x-dsp-api-capabilities": "direct-cloud-payload-v1",
    ...securityResponseHeaders({
      privacy: "private",
      responseKind: "download",
      cors: response.httpSecurityCors ?? null,
      secureTransport: response.httpSecuritySecureTransport === true,
    }),
  });
  await writeResponseChunk(response, `{"cloudSave":${metadataJson.slice(0, -1)},"payload":"`);
  const chunkCharacters = 64 * 1024;
  for (let offset = 0; offset < save.payload.length; offset += chunkCharacters) {
    // JSON.stringify performs the exact escaping expected by old clients. A
    // split surrogate pair is emitted as two \uXXXX escapes and parses back to
    // the same JavaScript string, so bounded chunks preserve every payload.
    const escaped = JSON.stringify(save.payload.slice(offset, offset + chunkCharacters));
    await writeResponseChunk(response, escaped.slice(1, -1));
  }
  await writeResponseChunk(response, `"},"mode":${JSON.stringify(mode)},"slot":${JSON.stringify(slot)}}`);
  response.end();
}

async function readJson(request, options = {}) {
  const inspectedLimit = Number.isSafeInteger(request.httpSecurity?.body?.maximumBytes)
    ? request.httpSecurity.body.maximumBytes
    : BODY_LIMIT_BYTES;
  const maximumBytes = options.maximumBytes ?? inspectedLimit;
  const maximumExpandedBytes = options.maximumExpandedBytes ?? maximumBytes;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error("请求内容超过当前接口允许上限");
      error.statusCode = 413;
      error.code = "REQUEST_BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  let raw = Buffer.concat(chunks);
  const encoding = String(request.headers["content-encoding"] ?? "").toLowerCase();
  if (encoding && encoding !== "identity") {
    if (encoding !== "gzip") {
      const error = new Error("请求压缩格式不受支持");
      error.statusCode = 415;
      error.code = "REQUEST_ENCODING_UNSUPPORTED";
      throw error;
    }
    try {
      raw = gunzipSync(raw, { maxOutputLength: maximumExpandedBytes });
    } catch (cause) {
      const tooLarge = cause && typeof cause === "object" && "code" in cause && cause.code === "ERR_BUFFER_TOO_LARGE";
      const error = new Error(tooLarge ? "解压后的请求内容超过允许上限" : "请求压缩内容无效");
      error.statusCode = tooLarge ? 413 : 400;
      error.code = tooLarge ? "REQUEST_EXPANDED_BODY_TOO_LARGE" : "REQUEST_ENCODING_INVALID";
      throw error;
    }
  }
  if (raw.byteLength > maximumExpandedBytes) {
    const error = new Error("解压后的请求内容超过当前接口允许上限");
    error.statusCode = 413;
    error.code = "REQUEST_EXPANDED_BODY_TOO_LARGE";
    throw error;
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    const error = new Error("JSON 格式无效");
    error.statusCode = 400;
    error.code = "REQUEST_FORMAT_INVALID";
    throw error;
  }
}

async function readRawRequest(request, maximumBytes = request.httpSecurity?.body?.maximumBytes ?? BODY_LIMIT_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error("请求内容超过当前接口允许上限");
      error.statusCode = 413;
      error.code = "REQUEST_BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function decodeStrictRequestUtf8(rawBody) {
  let text;
  try {
    // Preserve a leading BOM long enough to reject it explicitly. The default
    // TextDecoder behavior consumes it, which would silently change the exact
    // cloud payload, its byte length and its SHA-256.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody);
  } catch {
    const error = new Error("请求正文不是有效 UTF-8");
    error.statusCode = 400;
    error.code = "REQUEST_FORMAT_INVALID";
    throw error;
  }
  if (text.charCodeAt(0) === 0xfeff) {
    const error = new Error("请求正文不能包含 UTF-8 BOM");
    error.statusCode = 400;
    error.code = "REQUEST_FORMAT_INVALID";
    throw error;
  }
  return text;
}

function directCloudSaveDescriptor(request) {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== cloudTransferContract.directPayloadContentType) return null;
  const declaredOriginalBytes = request.headers[cloudTransferContract.originalBytesHeader];
  if (declaredOriginalBytes !== undefined && (
    Array.isArray(declaredOriginalBytes) || typeof declaredOriginalBytes !== "string" || !/^\d{1,10}$/.test(declaredOriginalBytes)
  )) {
    const error = new Error("云存档原始字节数无效");
    error.statusCode = 400;
    error.code = "REQUEST_SIZE_INVALID";
    throw error;
  }
  const revisionHeader = request.headers[cloudTransferContract.expectedRevisionHeader];
  if (Array.isArray(revisionHeader) || typeof revisionHeader !== "string" || !/^\d{1,16}$/.test(revisionHeader)) {
    const error = new Error("云存档预期修订无效");
    error.statusCode = 400;
    error.code = "EXPECTED_REVISION_INVALID";
    throw error;
  }
  const expectedRevision = Number(revisionHeader);
  if (!Number.isSafeInteger(expectedRevision)) {
    const error = new Error("云存档预期修订无效");
    error.statusCode = 400;
    error.code = "EXPECTED_REVISION_INVALID";
    throw error;
  }
  const requestIdHeader = request.headers[cloudTransferContract.requestIdHeader];
  if (requestIdHeader !== undefined && (
    Array.isArray(requestIdHeader) || typeof requestIdHeader !== "string" || !OPERATION_ID_PATTERN.test(requestIdHeader)
  )) {
    const error = new Error("云存档操作标识无效");
    error.statusCode = 400;
    error.code = "OPERATION_ID_INVALID";
    throw error;
  }
  return {
    direct: true,
    expectedRevision,
    requestId: requestIdHeader ?? null,
    declaredOriginalBytes: declaredOriginalBytes === undefined ? null : Number(declaredOriginalBytes),
  };
}

function cloudSaveUploadDescriptor(request) {
  const directContentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() === cloudTransferContract.directPayloadContentType;
  const encoding = String(request.headers["content-encoding"] ?? "").toLowerCase();
  if (encoding && encoding !== "identity" && encoding !== "gzip") {
    const error = new Error("请求压缩格式不受支持");
    error.statusCode = 415;
    error.code = "REQUEST_ENCODING_UNSUPPORTED";
    throw error;
  }
  const direct = directContentType ? directCloudSaveDescriptor(request) : null;
  const inputLimit = directContentType ? BODY_LIMIT_BYTES : cloudTransferContract.legacyJsonRequestLimitBytes;
  const expandedLimit = directContentType
    ? EXPANDED_BODY_LIMIT_BYTES
    : cloudTransferContract.legacyJsonRequestLimitBytes;
  return {
    ...direct,
    direct: Boolean(direct),
    encoding: encoding === "gzip" ? "gzip" : "",
    inputLimit,
    expandedLimit,
    payloadLimit: SAVE_PAYLOAD_LIMIT_BYTES,
  };
}

async function readCloudSaveUpload(request, inspect, descriptor, signal = null) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      if (signal?.aborted) throw cloudUploadCancelledError(signal);
      size += chunk.length;
      if (size > descriptor.inputLimit) {
        const error = new Error("请求内容超过允许上限");
        error.statusCode = 413;
        error.code = "REQUEST_BODY_TOO_LARGE";
        throw error;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal?.aborted) throw cloudUploadCancelledError(signal);
    throw error;
  }
  if (signal?.aborted) throw cloudUploadCancelledError(signal);
  const raw = chunks.length > 0 ? Buffer.concat(chunks, size) : Buffer.alloc(0);
  chunks.length = 0;
  return inspect(raw, descriptor);
}

async function passwordRecord(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return { passwordSalt: salt, passwordHash: Buffer.from(derived).toString("hex") };
}

async function passwordMatches(password, user) {
  const derived = Buffer.from(await scrypt(password, user.passwordSalt, 64));
  const expected = Buffer.from(user.passwordHash, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function issueSession(store, userId, request, deviceName, deviceId) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const now = Date.now();
  const context = anonymousLoginContext(request, { deviceName, deviceId });
  const session = {
    id: `session_${randomUUID().replaceAll("-", "")}`,
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_TTL_MS,
    deviceName: normalizedDeviceName(deviceName, request),
    clientType: clientTypeForRequest(request),
    ipHash: sha256(`session-ip:${requestIp(request)}`).slice(0, 16),
    deviceHash: context.deviceHash,
    regionHash: context.regionHash,
  };
  store.data.sessions[tokenHash] = session;
  return { token, tokenHash, session, context };
}

function authenticatedUser(request, store, webSessionPolicy = null) {
  const credential = webSessionPolicy
    ? protectSessionRequest(request, undefined, webSessionPolicy).credential
    : null;
  const authorization = request.headers.authorization;
  const token = credential?.token ?? (typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "");
  if (!token) return null;
  const tokenHash = sha256(token);
  const session = store.data.sessions[tokenHash];
  if (!session || session.expiresAt <= Date.now()) {
    return null;
  }
  const user = store.data.users[session.userId];
  if (!user) return null;
  if (store.currentMutation?.()) session.lastSeenAt = Date.now();
  return { user, tokenHash, session, credentialKind: credential?.kind ?? "bearer" };
}

function issueActionToken(collection, userId) {
  for (const [tokenHash, record] of Object.entries(collection)) {
    if (record.userId === userId || record.expiresAt <= Date.now()) delete collection[tokenHash];
  }
  const token = randomBytes(32).toString("base64url");
  collection[sha256(token)] = { userId, createdAt: Date.now(), expiresAt: Date.now() + EMAIL_ACTION_TTL_MS };
  return token;
}

function validActionToken(collection, token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) return null;
  const tokenHash = sha256(token);
  const record = collection[tokenHash];
  if (!record || record.expiresAt <= Date.now()) {
    if (record) delete collection[tokenHash];
    return null;
  }
  return { tokenHash, record };
}

function revokeUserSessions(store, userId, exceptTokenHash = null) {
  for (const [tokenHash, session] of Object.entries(store.data.sessions)) {
    if (session.userId === userId && tokenHash !== exceptTokenHash) delete store.data.sessions[tokenHash];
  }
}

function removeUserActionTokens(store, userId) {
  for (const collection of [store.data.emailVerifications, store.data.passwordResets]) {
    for (const [tokenHash, record] of Object.entries(collection)) {
      if (record.userId === userId) delete collection[tokenHash];
    }
  }
}

function publicSession(session, currentTokenHash, tokenHash) {
  return {
    id: session.id,
    deviceName: session.deviceName,
    clientType: session.clientType,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    current: tokenHash === currentTokenHash,
  };
}

function cloudSaveMetadata(save, slot = "main", mode = "normal") {
  return save ? {
    mode,
    slot,
    revision: save.revision,
    updatedAt: save.updatedAt,
    size: save.size,
    checksum: save.checksum,
    summary: save.summary ?? summarizeSavePayload(save.payload),
    ...(Number.isInteger(save.restoredFromRevision) ? { restoredFromRevision: save.restoredFromRevision } : {}),
  } : null;
}

function publicUploadInspection(inspection) {
  if (!inspection) return null;
  return {
    payloadMode: inspection.payloadMode,
    validPayload: inspection.validPayload,
    legacyImplicitSpeedrun: inspection.legacyImplicitSpeedrun,
    tooLarge: inspection.tooLarge,
    payloadChecksum: inspection.payloadChecksum,
    payloadSize: inspection.payloadSize,
    summary: inspection.summary,
    leaderboardProjection: inspection.leaderboardProjection,
    integrity: inspection.integrity,
    payloadParseCount: inspection.payloadParseCount,
  };
}

function cloudUploadValidationFailure(inspection, effectiveMode) {
  if (inspection.validPayload && inspection.payloadMode === effectiveMode) return null;
  const integrityFailure = inspection.integrity && !inspection.integrity.valid && inspection.integrity.hasState;
  const code = inspection.tooLarge
    ? "SAVE_SIZE_TOO_LARGE"
    : inspection.validPayload && inspection.payloadMode !== effectiveMode
      ? "SAVE_MODE_MISMATCH"
      : integrityFailure ? "SAVE_INTEGRITY_INVALID" : "SAVE_FORMAT_INVALID";
  return {
    status: inspection.tooLarge ? 413 : 400,
    code,
    error: inspection.tooLarge
      ? `云存档体积过大，单个存档不能超过 ${Math.floor(SAVE_PAYLOAD_LIMIT_BYTES / 1024 / 1024 * 100) / 100} MB`
      : integrityFailure
        ? "云存档内部完整性校验失败，服务器已拒绝上传"
        : "云存档格式无效，服务器已拒绝上传",
    ...(inspection.tooLarge ? {
      originalBytes: inspection.payloadSize,
      expandedBytes: inspection.payloadSize,
      payloadLimitBytes: SAVE_PAYLOAD_LIMIT_BYTES,
      expandedLimitBytes: EXPANDED_BODY_LIMIT_BYTES,
      compressedLimitBytes: BODY_LIMIT_BYTES,
      overBytes: Math.max(0, inspection.payloadSize - SAVE_PAYLOAD_LIMIT_BYTES),
    } : {}),
    ...(code === "SAVE_MODE_MISMATCH" ? { expectedMode: effectiveMode, receivedMode: inspection.payloadMode } : {}),
    ...(inspection.summary ? { summary: inspection.summary } : {}),
  };
}

function sendCloudUploadValidationFailure(response, failure) {
  return send(response, failure.status, {
    error: failure.error,
    code: failure.code,
    directPayloadSupported: true,
    ...(failure.expectedMode ? { expectedMode: failure.expectedMode, receivedMode: failure.receivedMode } : {}),
    ...(failure.summary ? { summary: failure.summary } : {}),
    ...(failure.originalBytes !== undefined ? {
      originalBytes: failure.originalBytes,
      expandedBytes: failure.expandedBytes,
      payloadLimitBytes: failure.payloadLimitBytes,
      expandedLimitBytes: failure.expandedLimitBytes,
      compressedLimitBytes: failure.compressedLimitBytes,
      overBytes: failure.overBytes,
    } : {}),
  });
}

function validateParsedSavePayload(parsed, integrity = inspectParsedSavePayloadIntegrity(parsed)) {
  try {
    if (!integrity.valid) return false;
    const state = parsed?.state ?? parsed;
    if (!state || typeof state !== "object" || !Array.isArray(state.entities) ||
      !Number.isInteger(state.version) || state.version < 1 || state.version > 46) return false;
    if (savePayloadModeFromParsed(parsed) === null) return false;
    if (state.entities.some((entity) => !entity || typeof entity !== "object" || Array.isArray(entity) ||
      !inspectSaveContractRecord("entity", entity, state.version).valid)) return false;
    if (state.entities.some((entity) => entity.stationSlots !== undefined &&
      (!Array.isArray(entity.stationSlots) || entity.stationSlots.length > 5 || entity.stationSlots.some((slot) =>
        !slot || typeof slot !== "object" || Array.isArray(slot) ||
        !inspectSaveContractRecord("station-slot", slot, state.version).valid)))) return false;
    if (state.version >= 38 && !Array.isArray(state.belts)) return false;
    if (state.belts !== undefined && (!Array.isArray(state.belts) || state.belts.some((belt) =>
      !belt || typeof belt !== "object" || Array.isArray(belt) ||
      !inspectSaveContractRecord("belt", belt, state.version).valid))) return false;
    const validBufferLimit = (value) => Number.isInteger(value) && value >= 1_000 && value <= 100_000_000;
    const productionLimit = state.settings?.productionBufferLimit;
    const logisticsLimit = state.settings?.logisticsBufferLimit;
    if (state.version >= 32 && (!validBufferLimit(productionLimit) || !validBufferLimit(logisticsLimit))) return false;
    if (productionLimit !== undefined && !validBufferLimit(productionLimit)) return false;
    if (logisticsLimit !== undefined && !validBufferLimit(logisticsLimit)) return false;
    if (state.version >= 40) {
      if (!validBufferLimit(state.settings?.beltBufferLimit)) return false;
      if (!Array.isArray(state.contentPacks) || state.contentPacks.length > 64 || state.contentPacks.some((entry) =>
        !entry || typeof entry !== "object" || typeof entry.id !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(entry.id) ||
        typeof entry.version !== "string" || entry.version.length > 40 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version))) return false;
    }
    if (state.version >= 42) {
      const planetMetadata = state.galaxy?.planetMetadata;
      const systemMetadata = state.galaxy?.systemMetadata;
      if (!planetMetadata || typeof planetMetadata !== "object" || Array.isArray(planetMetadata) ||
        Object.keys(planetMetadata).length > 256 || Object.values(planetMetadata).some((metadata) =>
          !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
          typeof metadata.customName !== "string" || metadata.customName.length > 32 ||
          typeof metadata.note !== "string" || metadata.note.length > 240 ||
          !Array.isArray(metadata.tags) || metadata.tags.length > 8 || metadata.tags.some((tag) => typeof tag !== "string" || tag.length < 1 || tag.length > 16))) return false;
      if (!systemMetadata || typeof systemMetadata !== "object" || Array.isArray(systemMetadata) ||
        Object.keys(systemMetadata).length > 64 || Object.values(systemMetadata).some((metadata) =>
          !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
          typeof metadata.customName !== "string" || metadata.customName.length < 1 || metadata.customName.length > 32)) return false;
    }
    if (state.version === 43) {
      const decimal = (value) => typeof value === "string" && /^(0|[1-9][0-9]{0,255})$/.test(value);
      const stationMap = state.systemSpaceStations;
      if (!stationMap || typeof stationMap !== "object" || Array.isArray(stationMap) || Object.keys(stationMap).length > 8) return false;
      for (const [systemId, station] of Object.entries(stationMap)) {
        if (!/^[a-z][a-z0-9_]{1,31}$/.test(systemId) || !station || typeof station !== "object" ||
          station.systemId !== systemId || !["not-started", "building", "operational"].includes(station.status) ||
          !Number.isSafeInteger(station.costRevision) || station.costRevision < 0 ||
          ![8_000, 9_000, 10_000].includes(station.costMultiplierBasisPoints) ||
          !Number.isSafeInteger(station.phaseIndex) || station.phaseIndex < 0 || station.phaseIndex > 16 ||
          !station.delivered || typeof station.delivered !== "object" || Array.isArray(station.delivered) ||
          Object.entries(station.delivered).some(([itemId, amount]) => !/^[a-z][a-z0-9_]{1,80}$/.test(itemId) || !decimal(amount)) ||
          !station.inventory || typeof station.inventory !== "object" || Array.isArray(station.inventory) ||
          Object.entries(station.inventory).some(([itemId, amount]) => !/^[a-z][a-z0-9_]{1,80}$/.test(itemId) || !decimal(amount)) ||
          !station.modules || typeof station.modules !== "object" ||
          [station.modules.backbone, station.modules.energy, station.modules.interstellar].some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) ||
          !station.routingCursors || typeof station.routingCursors !== "object" ||
          Object.values(station.routingCursors).some((value) => !Number.isSafeInteger(value) || value < 0) ||
          !station.viewport || !Number.isFinite(station.viewport.x) || !Number.isFinite(station.viewport.y) ||
          !Number.isFinite(station.viewport.zoom) || station.viewport.zoom < 0.1 || station.viewport.zoom > 4 ||
          !Array.isArray(station.decorations) || station.decorations.length > 256) return false;
        if (station.itemPolicies !== undefined && (!station.itemPolicies || typeof station.itemPolicies !== "object" || Array.isArray(station.itemPolicies) ||
          Object.entries(station.itemPolicies).some(([itemId, policy]) => !/^[a-z][a-z0-9_]{1,80}$/.test(itemId) || !policy || typeof policy !== "object" ||
            typeof policy.interstellarEnabled !== "boolean" || !decimal(policy.reserve) || !decimal(policy.target)))) return false;
      }
      const network = state.galacticHubNetwork;
      if (!network || typeof network !== "object" || Array.isArray(network) ||
        !Number.isSafeInteger(network.fleetInstalled) || network.fleetInstalled < 0 || network.fleetInstalled > 1_000_000_000 ||
        !Number.isSafeInteger(network.fleetBusy) || network.fleetBusy < 0 || network.fleetBusy > 1_000_000_000 ||
        !decimal(network.warpers) || !decimal(network.warperTarget) || !Array.isArray(network.fleetReturns) || network.fleetReturns.length > 4_096 ||
        network.fleetReturns.some((bucket) => !bucket || typeof bucket.routeKey !== "string" || bucket.routeKey.length < 1 || bucket.routeKey.length > 160 ||
          !Number.isSafeInteger(bucket.returnAtSecond) || bucket.returnAtSecond < 0 || !Number.isSafeInteger(bucket.vesselCount) || bucket.vesselCount < 1)) return false;
      for (const entity of state.entities) {
        if (entity?.buildingId !== "interstellar_logistics_station") continue;
        if (entity.stationTier !== 1 && entity.stationTier !== 2) return false;
        if (entity.stationOperationMode !== "legacy" && entity.stationOperationMode !== "elevator") return false;
        if (entity.stationModeTransition !== null && entity.stationModeTransition !== "to-elevator" && entity.stationModeTransition !== "to-legacy") return false;
        if (!Array.isArray(entity.elevatorOutputItems) || entity.elevatorOutputItems.length !== 5 || entity.elevatorOutputItems.some((itemId) => itemId !== null && (typeof itemId !== "string" || !/^[a-z][a-z0-9_]{1,80}$/.test(itemId)))) return false;
      }
      if ((state.belts ?? []).some((belt) => belt.elevatorOutputIndex !== undefined &&
        (!Number.isInteger(belt.elevatorOutputIndex) || belt.elevatorOutputIndex < 0 || belt.elevatorOutputIndex > 4))) return false;
    }
    if (state.version >= 44) {
      const quantum = state.quantumLogisticsNetwork;
      const decimal = (value) => typeof value === "string" && /^(0|[1-9][0-9]{0,255})$/.test(value);
      if (!quantum || typeof quantum !== "object" || Array.isArray(quantum) || typeof quantum.enabled !== "boolean" ||
        !quantum.inventory || typeof quantum.inventory !== "object" || Array.isArray(quantum.inventory) ||
        Object.entries(quantum.inventory).some(([itemId, amount]) => !/^[a-z][a-z0-9_]{1,80}$/.test(itemId) || !decimal(amount)) ||
        !quantum.routingCursors || typeof quantum.routingCursors !== "object" || Array.isArray(quantum.routingCursors) ||
        Object.entries(quantum.routingCursors).some(([itemId, cursor]) => !/^[a-z][a-z0-9_]{1,80}$/.test(itemId) || !Number.isSafeInteger(cursor) || cursor < 0)) return false;
      if (state.version >= 45) {
        const validCapacity = (value) => decimal(value) && BigInt(value) >= 10_000n && BigInt(value) <= 10_000_000_000n;
        if (!quantum.itemCapacities || typeof quantum.itemCapacities !== "object" || Array.isArray(quantum.itemCapacities) ||
          Object.entries(quantum.itemCapacities).some(([itemId, amount]) => !/^[a-z][a-z0-9_]{1,80}$/.test(itemId) || !validCapacity(amount)) ||
          !quantum.uploadRoutingCursors || typeof quantum.uploadRoutingCursors !== "object" || Array.isArray(quantum.uploadRoutingCursors) ||
          Object.entries(quantum.uploadRoutingCursors).some(([itemId, cursor]) => !/^[a-z][a-z0-9_]{1,80}$/.test(itemId) || !Number.isSafeInteger(cursor) || cursor < 0) ||
          quantum.runtimeFlow !== undefined) return false;
      }
      for (const entity of state.entities) {
        const quantumEndpoint = entity?.buildingId === "interstellar_logistics_station" ||
          state.version >= 45 && entity?.buildingId === "orbital_collector";
        if (!quantumEndpoint && entity?.quantumTarget !== undefined && entity.quantumTarget !== false) return false;
        if (!quantumEndpoint) continue;
        if (entity.quantumMode !== undefined && !["legacy", "transitioning", "quantum"].includes(entity.quantumMode)) return false;
        if (state.version >= 45 && !["legacy", "transitioning", "quantum"].includes(entity.quantumMode)) return false;
        const transition = entity.quantumTransition;
        if (transition !== undefined && transition !== null) {
          if (!transition || typeof transition !== "object" || !["quantum", "legacy"].includes(transition.targetMode) ||
            !Number.isFinite(transition.startedAtSecond) || transition.startedAtSecond < 0 ||
            !Number.isFinite(transition.boundarySecond) || transition.boundarySecond < 0 || !Array.isArray(transition.bridges) || transition.bridges.length > 256 ||
            transition.bridges.some((bridge) => !bridge || typeof bridge !== "object" || typeof bridge.id !== "string" || bridge.id.length > 160 ||
              !/^[a-z][a-z0-9_]{1,80}$/.test(bridge.itemId) || typeof bridge.sourceStationId !== "string" || typeof bridge.targetStationId !== "string" ||
              !decimal(bridge.cargo) || !decimal(bridge.remainingCargo) || !Number.isFinite(bridge.arriveAtSecond) || bridge.arriveAtSecond < 0)) return false;
        }
      }
    }
    if (state.planetTrayItemLimits !== undefined) {
      if (!state.planetTrayItemLimits || typeof state.planetTrayItemLimits !== "object" || Array.isArray(state.planetTrayItemLimits) ||
        Object.values(state.planetTrayItemLimits).some((value) => !validBufferLimit(value))) return false;
    }
    if (state.version >= 33) {
      const proliferatorLimit = state.settings?.proliferatorBufferLimit;
      if (!Number.isInteger(proliferatorLimit) || proliferatorLimit < 1 || proliferatorLimit > 100_000_000) return false;
      const infiniteResearch = state.endgame?.infiniteResearch;
      if (!infiniteResearch || typeof infiniteResearch !== "object") return false;
      const maximumLevels = {
        matrix_compression: 1_000,
        vein_utilization: 1_000,
        galactic_logistics: 1_000,
        stellar_harnessing: 1_000,
        continuum_simulation: 23,
      };
      for (const [researchId, maximumLevel] of Object.entries(maximumLevels)) {
        const progress = infiniteResearch[researchId];
        if (!progress || typeof progress !== "object" || !Number.isInteger(progress.level) || progress.level < 0 || progress.level > maximumLevel) return false;
        if (progress.historicalLevel !== undefined &&
          (!Number.isInteger(progress.historicalLevel) || progress.historicalLevel < progress.level)) return false;
        if (typeof progress.progress !== "string" || !/^(0|[1-9][0-9]{0,63})$/.test(progress.progress)) return false;
      }
    }
    if (state.version >= 38) {
      const destroyed = state.constructionAutomation?.destroyedByproducts;
      if (!destroyed || typeof destroyed !== "object" || Array.isArray(destroyed) ||
        Object.entries(destroyed).some(([itemId, amount]) => !/^[a-z][a-z0-9_]{1,80}$/.test(itemId) || !Number.isSafeInteger(amount) || amount < 0)) return false;
      if (!Array.isArray(state.blueprints) || state.blueprints.some((blueprint) => {
        if (!blueprint || typeof blueprint !== "object" || !Array.isArray(blueprint.entities) || !Array.isArray(blueprint.belts) ||
          (blueprint.resourceAnchors !== undefined && !Array.isArray(blueprint.resourceAnchors))) return true;
        const keys = new Set();
        const blueprintEntityByKey = new Map();
        for (const entity of blueprint.entities) {
          if (typeof entity?.key !== "string" || keys.has(entity.key)) return true;
          keys.add(entity.key);
          blueprintEntityByKey.set(entity.key, entity);
          if (state.version >= 41 && entity.targetDysonOrbitId !== undefined &&
            (entity.buildingId !== "em_rail_ejector" || typeof entity.targetDysonOrbitId !== "string" ||
              entity.targetDysonOrbitId.length < 1 || entity.targetDysonOrbitId.length > 160)) return true;
          if (state.version >= 39 && entity.buildingId === "material_delivery_hub" &&
            (!Array.isArray(entity.deliverySlots) || entity.deliverySlots.length !== 3 || entity.deliverySlots.some((slot) =>
              !slot || !["auto", "manual", "disabled"].includes(slot.mode) ||
              (slot.mode === "disabled" ? slot.itemId !== null : slot.mode === "manual"
                ? typeof slot.itemId !== "string" || !/^[a-z][a-z0-9_]{1,80}$/.test(slot.itemId)
                : !(slot.itemId === null || typeof slot.itemId === "string" && /^[a-z][a-z0-9_]{1,80}$/.test(slot.itemId)))))) return true;
        }
        for (const anchor of blueprint.resourceAnchors ?? []) {
          if (!anchor || typeof anchor.key !== "string" || keys.has(anchor.key) || typeof anchor.resourceId !== "string" ||
            typeof anchor.extractorBuildingId !== "string" || !Number.isSafeInteger(anchor.minerCount) || anchor.minerCount < 1 || anchor.minerCount > Number.MAX_SAFE_INTEGER ||
            !Number.isFinite(anchor.offset?.x) || !Number.isFinite(anchor.offset?.y)) return true;
          keys.add(anchor.key);
        }
        if (keys.size < 1) return true;
        return blueprint.belts.some((belt) => {
          if (!keys.has(belt?.sourceKey) || !keys.has(belt?.targetKey) ||
            !Number.isInteger(belt?.lanes) || belt.lanes < 1 || belt.lanes > 4_096) return true;
          if (belt.targetPortIndex === undefined) return false;
          const targetTemplate = blueprintEntityByKey.get(belt.targetKey);
          return ![0, 1, 2].includes(belt.targetPortIndex) ||
            (targetTemplate?.buildingId !== "micro_black_hole_connector" && targetTemplate?.buildingId !== "material_delivery_hub");
        });
      })) return false;
    }
    if (state.version >= 46) {
      const validId = (value, maximum = 160) => typeof value === "string" && value.length >= 1 && value.length <= maximum;
      const validBlueprintDefinition = (blueprint) => {
        if (!blueprint || typeof blueprint !== "object" || !validId(blueprint.id) || !validId(blueprint.name, 32) ||
          !Number.isSafeInteger(blueprint.revision) || blueprint.revision < 1 || !Array.isArray(blueprint.entities) ||
          blueprint.entities.length > 100_000 || !Array.isArray(blueprint.belts) || blueprint.belts.length > 250_000 ||
          (blueprint.resourceAnchors !== undefined && (!Array.isArray(blueprint.resourceAnchors) || blueprint.resourceAnchors.length > 256))) return false;
        const keys = new Set();
        for (const entity of blueprint.entities) {
          if (!entity || typeof entity !== "object" || !validId(entity.key) || keys.has(entity.key) || !validId(entity.buildingId, 80) ||
            !Number.isSafeInteger(entity.machineCount) || entity.machineCount < 1 || entity.machineCount > Number.MAX_SAFE_INTEGER ||
            !Number.isFinite(entity.offset?.x) || !Number.isFinite(entity.offset?.y) ||
            (entity.quantumTarget !== undefined &&
              (entity.buildingId === "interstellar_logistics_station"
                ? typeof entity.quantumTarget !== "boolean"
                : entity.quantumTarget !== false))) return false;
          keys.add(entity.key);
        }
        for (const anchor of blueprint.resourceAnchors ?? []) {
          if (!anchor || typeof anchor !== "object" || !validId(anchor.key) || keys.has(anchor.key) || !validId(anchor.resourceId, 80) ||
            !validId(anchor.extractorBuildingId, 80) || !Number.isSafeInteger(anchor.minerCount) || anchor.minerCount < 1 || anchor.minerCount > Number.MAX_SAFE_INTEGER ||
            !Number.isFinite(anchor.offset?.x) || !Number.isFinite(anchor.offset?.y)) return false;
          keys.add(anchor.key);
        }
        if (keys.size < 1) return false;
        return blueprint.belts.every((belt) => belt && typeof belt === "object" && validId(belt.key) && keys.has(belt.sourceKey) && keys.has(belt.targetKey) &&
          belt.sourceKey !== belt.targetKey && validId(belt.itemId, 80) && Number.isInteger(belt.lanes) && belt.lanes >= 1 && belt.lanes <= 4_096 &&
          Number.isInteger(belt.tier) && belt.tier >= 1 && belt.tier <= 32 && [0, 1, 2].includes(belt.priority));
      };
      if (!Array.isArray(state.blueprints) || state.blueprints.some((blueprint) => !validBlueprintDefinition(blueprint)) ||
        !Array.isArray(state.blueprintVersions) || state.blueprintVersions.length > 100) return false;
      const snapshotById = new Map();
      for (const snapshot of state.blueprintVersions) {
        if (!snapshot || typeof snapshot !== "object" || !validId(snapshot.id, 200) || snapshotById.has(snapshot.id) ||
          !validId(snapshot.blueprintId) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 ||
          !validBlueprintDefinition(snapshot.definition) || snapshot.definition.id !== snapshot.blueprintId ||
          snapshot.definition.revision !== snapshot.revision) return false;
        snapshotById.set(snapshot.id, snapshot);
      }
      if (!Array.isArray(state.constructionQueue) || state.constructionQueue.length > 100) return false;
      for (const entry of state.constructionQueue) {
        const snapshot = entry && typeof entry === "object" ? snapshotById.get(entry.blueprintVersionId) : undefined;
        const validInventory = (value, allowedKeys) => value && typeof value === "object" && !Array.isArray(value) &&
          Object.entries(value).every(([key, amount]) => allowedKeys(key) && Number.isSafeInteger(amount) && amount >= 0);
        if (!entry || typeof entry !== "object" || !validId(entry.id) || !snapshot || entry.blueprintId !== snapshot.blueprintId ||
          entry.blueprintRevision !== snapshot.revision || !validId(entry.blueprintName, 32) || !validId(entry.planetId, 80) ||
          !Number.isFinite(entry.position?.x) || !Number.isFinite(entry.position?.y) || ![0, 90, 180, 270].includes(entry.rotation) ||
          !["none", "horizontal", "vertical"].includes(entry.mirror) || !Number.isFinite(entry.queuedAt) || entry.queuedAt < 0 ||
          !["pending-materials", "waiting-fleet"].includes(entry.status) ||
          !validInventory(entry.reservedConstruction, (key) => /^[a-z][a-z0-9_]{1,80}$/.test(key)) ||
          !validInventory(entry.reservedFleet, (key) => key === "logistics_drone" || key === "logistics_vessel") ||
          !entry.placedEntityIdsByKey || typeof entry.placedEntityIdsByKey !== "object" || Array.isArray(entry.placedEntityIdsByKey) ||
          Object.entries(entry.placedEntityIdsByKey).some(([key, entityId]) => !validId(key) || !validId(entityId, 200))) return false;
        if (entry.status === "waiting-fleet" && (Object.keys(entry.reservedConstruction).length > 0 || Object.keys(entry.reservedFleet).length > 0 ||
          !Number.isFinite(entry.buildingCompletedAt) || entry.buildingCompletedAt < 0)) return false;
        if (entry.status === "pending-materials" && Object.keys(entry.placedEntityIdsByKey).length > 0) return false;
      }
    }
    if (state.version >= 34) {
      const timeWarp = state.timeWarp;
      if (!timeWarp || typeof timeWarp !== "object" ||
        !(timeWarp.controllerEntityId === null || typeof timeWarp.controllerEntityId === "string") ||
        typeof timeWarp.enabled !== "boolean" || !Number.isSafeInteger(timeWarp.requestedMultiplier) ||
        timeWarp.requestedMultiplier < 5 || !Number.isFinite(timeWarp.pendingSimulationSeconds) ||
        timeWarp.pendingSimulationSeconds < 0 || timeWarp.pendingSimulationSeconds > 30 * 24 * 60 * 60 ||
        !Number.isFinite(timeWarp.pendingWallSeconds) || timeWarp.pendingWallSeconds < 0 ||
        timeWarp.pendingWallSeconds > 30 * 24 * 60 * 60 ||
        !Number.isSafeInteger(timeWarp.effectiveMultiplier) || timeWarp.effectiveMultiplier < 1 ||
        !Number.isFinite(timeWarp.requiredPowerKw) || timeWarp.requiredPowerKw < 0 ||
        !Number.isFinite(timeWarp.allocatedPowerKw) || timeWarp.allocatedPowerKw < 0) return false;
      const entityById = new Map(state.entities.map((entity) => [entity?.id, entity]));
      const controller = timeWarp.controllerEntityId === null ? null : entityById.get(timeWarp.controllerEntityId);
      if ((timeWarp.controllerEntityId !== null && controller?.buildingId !== "time_warp_device") ||
        (timeWarp.enabled && timeWarp.controllerEntityId === null)) return false;
      for (const plan of Object.values(state.dysonPlans ?? {})) {
        for (const layer of plan?.layers ?? []) {
          if (!Number.isInteger(layer.structureAllocationFloor) || layer.structureAllocationFloor < 0 ||
            !Number.isInteger(layer.shellAllocationFloor) || layer.shellAllocationFloor < 0) return false;
        }
      }
      for (const entity of state.entities) {
        if (entity?.buildingId === "time_warp_device" && (!Number.isSafeInteger(entity.machineCount) || entity.machineCount < 1)) return false;
        if (state.version >= 41 && entity?.buildingId === "em_rail_ejector" &&
          (typeof entity.targetDysonOrbitId !== "string" || entity.targetDysonOrbitId.length < 1 || entity.targetDysonOrbitId.length > 160)) return false;
        if (state.version >= 39 && entity?.buildingId === "material_delivery_hub") {
          if (!Array.isArray(entity.deliverySlots) || entity.deliverySlots.length !== 3 || entity.deliverySlots.some((slot) =>
            !slot || !["auto", "manual", "disabled"].includes(slot.mode) ||
            (slot.mode === "disabled" ? slot.itemId !== null : slot.mode === "manual"
              ? typeof slot.itemId !== "string" || !/^[a-z][a-z0-9_]{1,80}$/.test(slot.itemId)
              : !(slot.itemId === null || typeof slot.itemId === "string" && /^[a-z][a-z0-9_]{1,80}$/.test(slot.itemId))))) return false;
        }
        if (entity?.buildingId !== "micro_black_hole_connector") continue;
        if (!Number.isSafeInteger(entity.machineCount) || entity.machineCount < 1 ||
          typeof entity.blackHolePaused !== "boolean" || typeof entity.blackHoleActivationConfirmed !== "boolean" ||
          !Array.isArray(entity.blackHolePorts) || entity.blackHolePorts.length !== 3 ||
          entity.blackHolePorts.some((port, index) => port?.index !== index ||
            typeof port.totalDestroyed !== "string" || !/^(0|[1-9][0-9]{0,255})$/.test(port.totalDestroyed))) return false;
      }
      const occupiedBlackHolePorts = new Set();
      for (const belt of state.belts ?? []) {
        const target = entityById.get(belt?.target);
        if (target?.buildingId === "micro_black_hole_connector") {
          if (![0, 1, 2].includes(belt.targetPortIndex)) return false;
          const key = `${belt.target}:${belt.targetPortIndex}`;
          if (occupiedBlackHolePorts.has(key)) return false;
          occupiedBlackHolePorts.add(key);
        } else if (state.version >= 39 && target?.buildingId === "material_delivery_hub") {
          if (![0, 1, 2].includes(belt.targetPortIndex)) return false;
          const slot = target.deliverySlots?.[belt.targetPortIndex];
          if (!slot || slot.mode === "disabled" || typeof belt.itemId !== "string" || slot.itemId !== belt.itemId) return false;
        } else if (belt?.targetPortIndex !== undefined) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function leaderboardProjectionFromState(state) {
  if (!state || typeof state !== "object") return null;
  const metrics = state.metrics && typeof state.metrics === "object" ? {
    generationKw: state.metrics.generationKw,
    totalItemsPerMinute: state.metrics.totalItemsPerMinute,
  } : null;
  const planetMetrics = state.planetMetrics && typeof state.planetMetrics === "object" && !Array.isArray(state.planetMetrics)
    ? Object.fromEntries(Object.entries(state.planetMetrics).map(([planetId, value]) => [planetId, {
      totalItemsPerMinute: value?.totalItemsPerMinute,
    }]))
    : null;
  return {
    version: state.version,
    elapsedSeconds: state.elapsedSeconds,
    totalProduced: state.totalProduced,
    contentPacks: state.contentPacks,
    // The integrity gate only needs to distinguish an empty factory from a
    // non-empty one; never clone the full entity array back from the worker.
    entities: Array.isArray(state.entities) && state.entities.length > 0 ? [true] : [],
    metrics,
    planetMetrics,
    activePlanetId: state.activePlanetId,
    exploration: state.exploration,
    dysonSwarm: { generationKw: state.dysonSwarm?.generationKw },
    dysonSphere: { generationKw: state.dysonSphere?.generationKw },
  };
}

export function inspectDecodedCloudSaveUpload(rawBody, descriptor, { returnPayloadBuffer = false, parseJson = JSON.parse } = {}) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? []);
  let decoded = decodeStrictRequestUtf8(raw);
  let payload = decoded;
  let expectedRevision = descriptor.direct ? descriptor.expectedRevision : 0;
  let requestId = descriptor.direct ? descriptor.requestId : null;
  if (descriptor.direct) {
    if (Number.isSafeInteger(descriptor.declaredOriginalBytes) && descriptor.declaredOriginalBytes !== raw.byteLength) {
      const error = new Error("云存档原始字节数无效");
      error.statusCode = 400;
      error.code = "REQUEST_SIZE_INVALID";
      throw error;
    }
  } else {
    if (raw.byteLength === 0) {
      const error = new Error("JSON 格式无效");
      error.statusCode = 400;
      error.code = "REQUEST_FORMAT_INVALID";
      throw error;
    }
    let wrapper;
    try {
      wrapper = parseJson(decoded);
    } catch {
      const error = new Error("JSON 格式无效");
      error.statusCode = 400;
      error.code = "REQUEST_FORMAT_INVALID";
      throw error;
    }
    if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) {
      const error = new Error("JSON 格式无效");
      error.statusCode = 400;
      error.code = "REQUEST_FORMAT_INVALID";
      throw error;
    }
    payload = wrapper.payload;
    expectedRevision = wrapper.expectedRevision;
    requestId = null;
    wrapper = null;
    decoded = "";
  }
  const payloadSize = typeof payload === "string"
    ? descriptor.direct ? raw.byteLength : Buffer.byteLength(payload)
    : 0;
  const tooLarge = typeof payload === "string" && payloadSize > descriptor.payloadLimit;
  let parsed = null;
  let parseSucceeded = false;
  if (typeof payload === "string" && !tooLarge) {
    try {
      parsed = parseJson(payload);
      parseSucceeded = true;
    } catch {
      parsed = null;
    }
  }
  const integrity = parseSucceeded
    ? inspectParsedSavePayloadIntegrity(parsed)
    : { parsed: null, formatVersion: null, state: null, recordedChecksum: null, computedChecksum: null, valid: false };
  const payloadMode = parseSucceeded ? savePayloadModeFromParsed(parsed) : null;
  const validPayload = typeof payload === "string" && payload.length >= 10 && !tooLarge &&
    validateParsedSavePayload(parsed, integrity);
  const summary = parseSucceeded ? summarizeParsedSavePayload(parsed, integrity, payloadMode) : null;
  const legacyImplicitSpeedrun = parseSucceeded && isLegacyImplicitSpeedrunParsed(parsed);
  const payloadChecksum = validPayload ? sha256(descriptor.direct ? raw : payload) : null;
  const leaderboardProjection = validPayload ? leaderboardProjectionFromState(integrity.state ?? parsed?.state ?? parsed) : null;
  let payloadBuffer;
  if (returnPayloadBuffer && validPayload) {
    if (descriptor.direct) {
      payloadBuffer = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength
        ? raw.buffer
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    } else {
      payloadBuffer = new TextEncoder().encode(payload).buffer;
    }
  }
  parsed = null;
  return {
    payload: returnPayloadBuffer ? undefined : payload,
    ...(returnPayloadBuffer ? { payloadBuffer } : {}),
    expectedRevision,
    requestId,
    payloadMode,
    validPayload,
    legacyImplicitSpeedrun,
    tooLarge,
    payloadChecksum,
    payloadSize,
    summary,
    leaderboardProjection,
    integrity: {
      valid: integrity.valid,
      hasState: Boolean(integrity.state),
      recordedChecksum: integrity.recordedChecksum,
      computedChecksum: integrity.computedChecksum,
    },
    payloadParseCount: parseSucceeded ? 1 : 0,
  };
}

function parseSaveState(payload) {
  try {
    const parsed = JSON.parse(payload);
    return parsed?.state ?? parsed;
  } catch {
    return null;
  }
}

function numberAt(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function unavailableAdjacentWindow(status, metricVersion, details = {}) {
  const observedSeconds = Number.isFinite(details.observedSeconds) ? details.observedSeconds : 0;
  return {
    ...details,
    value: null,
    valid: false,
    status,
    metricVersion,
    requiredSeconds: 60,
    observedSeconds: Math.max(0, observedSeconds),
    windowSeconds: Math.max(0, observedSeconds),
    remainingSeconds: Math.max(0, 60 - Math.max(0, observedSeconds)),
    productionDelta: null,
  };
}

function validAdjacentWindow(status, metricVersion, value, observedSeconds, productionDelta, fromRevision, toRevision) {
  return {
    value,
    valid: true,
    status,
    metricVersion,
    requiredSeconds: 60,
    observedSeconds,
    windowSeconds: observedSeconds,
    remainingSeconds: 0,
    productionDelta,
    fromRevision,
    toRevision,
  };
}

function whiteMatrixRateFromAdjacentRevision(store, userId, currentSave, currentState, previousStateOverride = undefined) {
  const currentRevision = Number.isInteger(currentSave?.revision) ? currentSave.revision : 0;
  if (currentRevision <= 1) return unavailableAdjacentWindow("missing_adjacent_revision", WHITE_MATRIX_METRIC_VERSION, { toRevision: currentRevision || null });
  const previousMetadata = saveHistory(store, userId, "main").find((entry) => entry.revision === currentRevision - 1);
  if (!previousMetadata) return unavailableAdjacentWindow("missing_adjacent_revision", WHITE_MATRIX_METRIC_VERSION, { fromRevision: currentRevision - 1, toRevision: currentRevision });
  const previousSave = previousStateOverride === undefined
    ? materializeCloudSave(store, userId, "main", previousMetadata)
    : null;
  const previousState = previousStateOverride === undefined
    ? parseSaveState(previousSave?.payload)
    : previousStateOverride;
  if (!previousState || typeof previousState !== "object" || !currentState || typeof currentState !== "object") {
    return unavailableAdjacentWindow("unavailable", WHITE_MATRIX_METRIC_VERSION, { fromRevision: currentRevision - 1, toRevision: currentRevision });
  }
  if ((Array.isArray(previousState.contentPacks) && previousState.contentPacks.length > 0)
    || (Array.isArray(currentState.contentPacks) && currentState.contentPacks.length > 0)) {
    return unavailableAdjacentWindow("unavailable", WHITE_MATRIX_METRIC_VERSION, { fromRevision: currentRevision - 1, toRevision: currentRevision });
  }
  const previousElapsed = numberAt(previousState.elapsedSeconds);
  const currentElapsed = numberAt(currentState.elapsedSeconds);
  const elapsedDelta = currentElapsed - previousElapsed;
  if (elapsedDelta <= 0) {
    return unavailableAdjacentWindow("elapsed_not_increasing", WHITE_MATRIX_METRIC_VERSION, {
      observedSeconds: elapsedDelta,
      fromRevision: currentRevision - 1,
      toRevision: currentRevision,
    });
  }
  if (elapsedDelta < WHITE_MATRIX_RATE_MIN_INTERVAL_SECONDS) {
    return unavailableAdjacentWindow("interval_too_short", WHITE_MATRIX_METRIC_VERSION, {
      observedSeconds: elapsedDelta,
      fromRevision: currentRevision - 1,
      toRevision: currentRevision,
    });
  }
  const previousProduced = Math.floor(numberAt(previousState.totalProduced?.universe_matrix));
  const currentProduced = Math.floor(numberAt(currentState.totalProduced?.universe_matrix));
  const producedDelta = currentProduced - previousProduced;
  if (producedDelta < 0) {
    return unavailableAdjacentWindow("unavailable", WHITE_MATRIX_METRIC_VERSION, {
      observedSeconds: elapsedDelta,
      fromRevision: currentRevision - 1,
      toRevision: currentRevision,
    });
  }
  if (producedDelta === 0) {
    return validAdjacentWindow("valid_zero_production", WHITE_MATRIX_METRIC_VERSION, 0, elapsedDelta, 0, currentRevision - 1, currentRevision);
  }
  const scaled = producedDelta > Number.MAX_VALUE / 60 ? Number.MAX_VALUE : producedDelta * 60;
  return validAdjacentWindow(
    "ranked",
    WHITE_MATRIX_METRIC_VERSION,
    Number.isFinite(scaled) ? normalizeMetric(scaled / elapsedDelta) : Number.MAX_VALUE,
    elapsedDelta,
    producedDelta,
    currentRevision - 1,
    currentRevision,
  );
}

function throughputRateFromAdjacentRevision(store, userId, currentSave, currentState, previousStateOverride = undefined) {
  const currentRevision = Number.isInteger(currentSave?.revision) ? currentSave.revision : 0;
  if (currentRevision <= 1) return unavailableAdjacentWindow("missing_adjacent_revision", THROUGHPUT_METRIC_VERSION, { toRevision: currentRevision || null });
  const previousMetadata = saveHistory(store, userId, "main").find((entry) => entry.revision === currentRevision - 1);
  if (!previousMetadata) return unavailableAdjacentWindow("missing_adjacent_revision", THROUGHPUT_METRIC_VERSION, { fromRevision: currentRevision - 1, toRevision: currentRevision });
  const previousSave = previousStateOverride === undefined
    ? materializeCloudSave(store, userId, "main", previousMetadata)
    : null;
  const previousState = previousStateOverride === undefined
    ? parseSaveState(previousSave?.payload)
    : previousStateOverride;
  if (!previousState || typeof previousState !== "object" || !currentState || typeof currentState !== "object") {
    return unavailableAdjacentWindow("unavailable", THROUGHPUT_METRIC_VERSION, { fromRevision: currentRevision - 1, toRevision: currentRevision });
  }
  if ((Array.isArray(previousState.contentPacks) && previousState.contentPacks.length > 0)
    || (Array.isArray(currentState.contentPacks) && currentState.contentPacks.length > 0)) {
    return unavailableAdjacentWindow("unavailable", THROUGHPUT_METRIC_VERSION, { fromRevision: currentRevision - 1, toRevision: currentRevision });
  }
  const previousElapsed = numberAt(previousState.elapsedSeconds);
  const currentElapsed = numberAt(currentState.elapsedSeconds);
  const elapsedDelta = currentElapsed - previousElapsed;
  if (elapsedDelta <= 0) {
    return unavailableAdjacentWindow("elapsed_not_increasing", THROUGHPUT_METRIC_VERSION, {
      observedSeconds: elapsedDelta,
      fromRevision: currentRevision - 1,
      toRevision: currentRevision,
    });
  }
  if (elapsedDelta < THROUGHPUT_RATE_MIN_INTERVAL_SECONDS) {
    return unavailableAdjacentWindow("interval_too_short", THROUGHPUT_METRIC_VERSION, {
      observedSeconds: elapsedDelta,
      fromRevision: currentRevision - 1,
      toRevision: currentRevision,
    });
  }
  const previousProduced = previousState.totalProduced && typeof previousState.totalProduced === "object"
    ? previousState.totalProduced
    : {};
  const currentProduced = currentState.totalProduced && typeof currentState.totalProduced === "object"
    ? currentState.totalProduced
    : {};
  let producedDelta = 0;
  for (const itemId of new Set([...Object.keys(previousProduced), ...Object.keys(currentProduced)])) {
    const before = Math.floor(numberAt(previousProduced[itemId]));
    const after = Math.floor(numberAt(currentProduced[itemId]));
    if (after < before) {
      return unavailableAdjacentWindow("unavailable", THROUGHPUT_METRIC_VERSION, {
        observedSeconds: elapsedDelta,
        fromRevision: currentRevision - 1,
        toRevision: currentRevision,
      });
    }
    producedDelta = saturatingMetricAdd(producedDelta, after - before);
  }
  const scaled = saturatingMetricProduct(producedDelta, 60);
  return validAdjacentWindow(
    producedDelta > 0 ? "ranked" : "valid_zero_production",
    THROUGHPUT_METRIC_VERSION,
    normalizeMetric(scaled / elapsedDelta),
    elapsedDelta,
    producedDelta,
    currentRevision - 1,
    currentRevision,
  );
}

function leaderboardMetricsFromState(state, whiteMatrixWindow = null, throughputWindow = null) {
  if (!state || typeof state !== "object") return null;
  const generationKw = numberAt(state.metrics?.generationKw);
  const elapsedSeconds = numberAt(state.elapsedSeconds);
  const producedWhiteMatrix = Math.floor(numberAt(state.totalProduced?.universe_matrix));
  const exploredSystems = Array.isArray(state.exploration?.unlockedSystemIds) ? new Set(state.exploration.unlockedSystemIds).size : 1;
  const colonizedPlanets = Array.isArray(state.exploration?.colonizedPlanetIds) ? new Set(state.exploration.colonizedPlanetIds).size : 1;
  const dysonPowerKw = saturatingMetricAdd(state.dysonSwarm?.generationKw, state.dysonSphere?.generationKw);
  const nominalThroughput = aggregateGalacticFactoryMetric(state, "totalItemsPerMinute");
  return normalizeMetrics({
    energyGeneratedMj: saturatingMetricProduct(generationKw, elapsedSeconds / 1000),
    uploadedWhiteMatrix: producedWhiteMatrix,
    peakWhiteMatrixPerMinute: whiteMatrixWindow?.valid ? whiteMatrixWindow.value : 0,
    peakGenerationKw: generationKw,
    peakThroughputPerMinute: throughputWindow?.valid ? throughputWindow.value : 0,
    theoreticalPeakThroughputPerMinute: nominalThroughput.galacticValue,
    activePlanetThroughputPerMinute: nominalThroughput.activePlanetValue,
    galacticThroughputPerMinute: nominalThroughput.galacticValue,
    nominalThroughputMetricVersion: nominalThroughput.metricVersion,
    throughputMetricVersion: THROUGHPUT_METRIC_VERSION,
    throughputWindowSeconds: throughputWindow?.valid ? throughputWindow.windowSeconds : 0,
    peakDysonPowerKw: dysonPowerKw,
    exploredSystems,
    colonizedPlanets,
  });
}

function leaderboardMetricsFromSave(save, whiteMatrixWindow = null, throughputWindow = null) {
  return leaderboardMetricsFromState(parseSaveState(save?.payload), whiteMatrixWindow, throughputWindow);
}

function mergeLeaderboardMetrics(previous, current, mergePreviousThroughput = true) {
  if (!previous) return current;
  return normalizeMetrics({
    ...Object.fromEntries(METRIC_KEYS.map((key) => [key,
      key === "peakThroughputPerMinute" && !mergePreviousThroughput
        ? numberAt(current[key])
        : Math.max(numberAt(previous[key]), numberAt(current[key])),
    ])),
    activePlanetThroughputPerMinute: numberAt(current.activePlanetThroughputPerMinute),
    galacticThroughputPerMinute: numberAt(current.galacticThroughputPerMinute),
    nominalThroughputMetricVersion: current.nominalThroughputMetricVersion,
    throughputMetricVersion: THROUGHPUT_METRIC_VERSION,
    throughputWindowSeconds: numberAt(current.throughputWindowSeconds),
  });
}

function isServerLeaderboardSubmission(value) {
  return typeof value?.verification?.strategy === "string" && value.verification.strategy.startsWith("main-cloud-save-v");
}

function removeUserLeaderboardSubmissions(store, userId) {
  let removed = 0;
  const seasons = new Set();
  for (const [key, submission] of Object.entries(store.data.submissions)) {
    if (submission.userId !== userId && submission.accountId !== userId) continue;
    if (typeof submission.seasonId === "string") seasons.add(submission.seasonId);
    delete store.data.submissions[key];
    removed += 1;
  }
  for (const seasonId of seasons) store.recordRuntimeIndexEvent?.({ type: "leaderboard-submission", userId, seasonId });
  return removed;
}

function applyLeaderboardIntegrityGate(store, userId, currentSave, currentState, previousStateOverride = undefined) {
  // A restore created by this server is already protected by expectedRevision
  // and an audit entry. Its cumulative counters can legitimately be lower than
  // the immediately preceding revision, so it must not be treated as a forged
  // client rollback. The restored revision is still excluded from producing a
  // faster historical peak by the existing adjacent-window rules.
  if (Number.isInteger(currentSave?.restoredFromRevision)) {
    return { version: LEADERBOARD_INTEGRITY_VERSION, freeze: false, findings: [{ code: "SERVER_RESTORE", severity: "info" }] };
  }
  let previousState = previousStateOverride;
  if (previousState === undefined) {
    const previousMetadata = Number.isInteger(currentSave?.revision) && currentSave.revision > 1
      ? saveHistory(store, userId, "main").find((entry) => entry.revision === currentSave.revision - 1)
      : null;
    const previous = previousMetadata ? materializeCloudSave(store, userId, "main", previousMetadata) : null;
    previousState = parseSaveState(previous?.payload);
  }
  const result = evaluateLeaderboardIntegrity(currentState, previousState);
  if (!result.freeze) return result;
  const alreadyRestricted = isLeaderboardRestricted(store.data, userId);
  store.data.leaderboardModeration[userId] = {
    status: "blocked",
    reasonCode: "SAVE_DATA_INTEGRITY",
    source: LEADERBOARD_INTEGRITY_VERSION,
    createdAt: alreadyRestricted ? store.data.leaderboardModeration[userId].createdAt : Date.now(),
  };
  store.recordRuntimeIndexEvent?.({ type: "leaderboard-restriction", userId });
  if (!alreadyRestricted) appendSystemAudit(store, "leaderboard.integrity_frozen", userId, "integrity-gate");
  return result;
}

function updateLeaderboardFromMainSave(store, userId, { save = null, now = Date.now(), force = false, inspection = null } = {}) {
  const user = store.data.users[userId];
  if (!user) return { changed: false, submission: null, reason: "missing-user" };
  if (isLeaderboardRestricted(store.data, userId)) {
    return { changed: removeUserLeaderboardSubmissions(store, userId) > 0, submission: null, reason: "restricted" };
  }
  if (user.leaderboardVisible === false) {
    return { changed: removeUserLeaderboardSubmissions(store, userId) > 0, submission: null, reason: "hidden" };
  }
  const metadata = save ?? store.data.cloudSaves[userId];
  if (!metadata) return { changed: false, submission: null, reason: "missing-save" };
  if (leaderboardRevalidationRequired(store.data, userId, metadata.revision)) {
    return { changed: removeUserLeaderboardSubmissions(store, userId) > 0, submission: null, reason: "revalidation-required" };
  }
  clearLeaderboardRevalidationIfSatisfied(store.data, userId, metadata.revision);
  const materialized = typeof metadata.payload === "string" ? metadata : materializeCloudSave(store, userId, "main", metadata);
  if (!materialized) return { changed: false, submission: null, reason: "missing-payload" };
  const state = inspection?.leaderboardProjection ?? parseSaveState(materialized.payload);
  if (Array.isArray(state?.contentPacks) && state.contentPacks.length > 0) {
    return { changed: removeUserLeaderboardSubmissions(store, userId) > 0, submission: null, reason: "modded-save" };
  }
  const previousMetadata = Number.isInteger(materialized.revision) && materialized.revision > 1
    ? saveHistory(store, userId, "main").find((entry) => entry.revision === materialized.revision - 1)
    : null;
  const previousMaterialized = previousMetadata ? materializeCloudSave(store, userId, "main", previousMetadata) : null;
  const previousState = parseSaveState(previousMaterialized?.payload);
  const integrity = applyLeaderboardIntegrityGate(store, userId, materialized, state, previousState);
  if (integrity.freeze) {
    return { changed: removeUserLeaderboardSubmissions(store, userId) > 0, submission: null, reason: "integrity-frozen", integrity };
  }
  const whiteMatrixWindow = whiteMatrixRateFromAdjacentRevision(store, userId, materialized, state, previousState);
  const throughputWindow = throughputRateFromAdjacentRevision(store, userId, materialized, state, previousState);
  rememberLeaderboardWindows(store, userId, materialized.revision, whiteMatrixWindow, throughputWindow);
  const observed = inspection?.leaderboardProjection
    ? leaderboardMetricsFromState(state, whiteMatrixWindow, throughputWindow)
    : leaderboardMetricsFromSave(materialized, whiteMatrixWindow, throughputWindow);
  if (!observed) return { changed: false, submission: null, reason: "invalid-save" };
  const key = `${ACTIVE_LEADERBOARD_SEASON_ID}:${userId}`;
  const previous = store.data.submissions[key];
  const previousServerMetrics = isServerLeaderboardSubmission(previous) ? previous.metrics : null;
  const previousUsesActualThroughput = previous?.verification?.strategy === "main-cloud-save-v2";
  const metrics = mergeLeaderboardMetrics(previousServerMetrics, observed, previousUsesActualThroughput);
  const sameMetrics = previousServerMetrics
    && METRIC_KEYS.every((key) => numberAt(previousServerMetrics[key]) === numberAt(metrics[key]))
    && numberAt(previousServerMetrics.activePlanetThroughputPerMinute) === numberAt(metrics.activePlanetThroughputPerMinute)
    && numberAt(previousServerMetrics.galacticThroughputPerMinute) === numberAt(metrics.galacticThroughputPerMinute)
    && previousServerMetrics.nominalThroughputMetricVersion === metrics.nominalThroughputMetricVersion
    && numberAt(previousServerMetrics.galaxyScore) === numberAt(metrics.galaxyScore);
  if (!force
    && isServerLeaderboardSubmission(previous)
    && previous.verification.cloudRevision === materialized.revision
    && previous.displayName === user.displayName
    && previous.visible !== false
    && sameMetrics) {
    return { changed: false, submission: previous, reason: "current" };
  }
  const submission = {
    userId,
    accountId: userId,
    displayName: user.displayName,
    avatar: user.displayName.trim().slice(0, 1).toUpperCase() || "A",
    seasonId: ACTIVE_LEADERBOARD_SEASON_ID,
    metrics,
    ...(previous && !previousUsesActualThroughput
      ? { legacyMetrics: { strategy: previous.verification?.strategy ?? "client-legacy", peakThroughputPerMinute: numberAt(previous.metrics?.peakThroughputPerMinute) } }
      : previous?.legacyMetrics ? { legacyMetrics: previous.legacyMetrics } : {}),
    submittedAt: Number.isFinite(materialized.updatedAt) ? materialized.updatedAt : now,
    visible: true,
    verification: {
      strategy: "main-cloud-save-v2",
      cloudRevision: materialized.revision,
      checksum: materialized.checksum,
      checkedAt: now,
      throughputMetricVersion: THROUGHPUT_METRIC_VERSION,
      nominalThroughputMetricVersion: metrics.nominalThroughputMetricVersion,
      throughputWindow: throughputWindow.valid ? {
        fromRevision: throughputWindow.fromRevision,
        toRevision: throughputWindow.toRevision,
        elapsedSeconds: throughputWindow.windowSeconds,
      } : null,
    },
  };
  store.data.submissions[key] = submission;
  store.recordRuntimeIndexEvent?.({ type: "leaderboard-submission", userId, seasonId: ACTIVE_LEADERBOARD_SEASON_ID });
  return { changed: true, submission, reason: previous ? "updated" : "created" };
}

function publicLeaderboardWindow(window) {
  if (!window) return null;
  return {
    status: window.status,
    valid: window.valid === true,
    value: window.valid ? numberAt(window.value) : null,
    metricVersion: window.metricVersion,
    requiredSeconds: numberAt(window.requiredSeconds, 60),
    observedSeconds: Number.isFinite(window.observedSeconds) ? window.observedSeconds : 0,
    remainingSeconds: numberAt(window.remainingSeconds),
    productionDelta: window.valid ? numberAt(window.productionDelta) : null,
    fromRevision: Number.isInteger(window.fromRevision) ? window.fromRevision : null,
    toRevision: Number.isInteger(window.toRevision) ? window.toRevision : null,
  };
}

function leaderboardWindowCache(store) {
  const mutation = store.currentMutation?.();
  if (mutation) {
    if (!(mutation.leaderboardWindowCache instanceof Map)) mutation.leaderboardWindowCache = new Map();
    return mutation.leaderboardWindowCache;
  }
  if (!(store.leaderboardWindowCache instanceof Map)) store.leaderboardWindowCache = new Map();
  return store.leaderboardWindowCache;
}

function leaderboardWindowCacheKey(userId, revision) {
  return `${userId}:${revision}`;
}

function rememberLeaderboardWindows(store, userId, revision, whiteRate, throughput) {
  if (!Number.isInteger(revision) || revision < 1) return;
  const cache = leaderboardWindowCache(store);
  const key = leaderboardWindowCacheKey(userId, revision);
  cache.delete(key);
  cache.set(key, {
    whiteRate: publicLeaderboardWindow(whiteRate),
    throughput: publicLeaderboardWindow(throughput),
  });
  while (cache.size > 2_048) cache.delete(cache.keys().next().value);
}

function readLeaderboardWindows(store, userId, save) {
  if (!save || !Number.isInteger(save.revision)) return { whiteRate: null, throughput: null };
  const cache = leaderboardWindowCache(store);
  const key = leaderboardWindowCacheKey(userId, save.revision);
  const cached = cache.get(key);
  if (cached) return cached;
  const materialized = materializeCloudSave(store, userId, "main", save, "normal");
  const state = parseSaveState(materialized?.payload);
  const whiteRate = materialized && state && typeof state === "object"
    ? whiteMatrixRateFromAdjacentRevision(store, userId, materialized, state)
    : unavailableAdjacentWindow("unavailable", WHITE_MATRIX_METRIC_VERSION, { toRevision: save.revision });
  const throughput = materialized && state && typeof state === "object"
    ? throughputRateFromAdjacentRevision(store, userId, materialized, state)
    : unavailableAdjacentWindow("unavailable", THROUGHPUT_METRIC_VERSION, { toRevision: save.revision });
  rememberLeaderboardWindows(store, userId, save.revision, whiteRate, throughput);
  return cache.get(key);
}

function leaderboardMeSnapshot(store, userId, category, seasonId, leaderboardSnapshot, rankedEntry = null) {
  const user = store.data.users[userId];
  if (!user) return null;
  const save = currentCloudSave(store, userId, "main", "normal");
  const reviewResumeAfterRevision = leaderboardRevalidationThresholds(store.data, userId).normal;
  let status = "unavailable";
  let latestWindowState = null;
  let entry = rankedEntry ? anonymousPublicLeaderboardEntry(rankedEntry, rankedEntry.rank) : null;
  if (isLeaderboardRestricted(store.data, userId)) {
    status = "restricted";
    entry = null;
  } else if (user.leaderboardVisible === false) {
    status = "hidden";
    entry = null;
  } else if (!save) {
    status = "missing_main_save";
    entry = null;
  } else if (leaderboardRevalidationRequired(store.data, userId, save.revision, "normal")) {
    status = "revalidation_required";
    entry = null;
  } else if (seasonId === ACTIVE_LEADERBOARD_SEASON_ID && (category === "white-rate" || category === "throughput")) {
    const windows = readLeaderboardWindows(store, userId, save);
    latestWindowState = category === "white-rate" ? windows.whiteRate : windows.throughput;
    status = latestWindowState?.status ?? "unavailable";
    if (status === "ranked" && !entry) status = "unavailable";
  } else {
    status = entry ? "ranked" : "unavailable";
  }
  return {
    status,
    entry,
    rank: entry?.rank ?? null,
    totalEntries: leaderboardSnapshot.totalEntries,
    serverMetrics: entry?.metrics ?? null,
    latestWindowState,
    mode: "normal",
    slot: "main",
    latestCloudRevision: Number.isInteger(save?.revision) ? save.revision : null,
    reviewResumeAfterRevision: reviewResumeAfterRevision > 0 ? reviewResumeAfterRevision : null,
  };
}

function anonymousPublicLeaderboardEntry(entry, rank) {
  return projectPublicLeaderboard({
    category: entry?.category ?? "galaxy",
    seasonId: entry?.seasonId ?? ACTIVE_LEADERBOARD_SEASON_ID,
    entries: [{ ...entry, rank }],
    generatedAt: Date.now(),
  }, { publicIdFor: leaderboardPublicId, maximumEntries: 1 }).entries[0] ?? null;
}

function publicLeaderboardEntry(entry, rank) {
  return anonymousPublicLeaderboardEntry(entry, rank);
}

function backfillLeaderboardFromMainSaves(store) {
  const summary = { changed: 0, created: 0, updated: 0, hidden: 0, skipped: 0 };
  for (const userId of Object.keys(store.data.users).sort()) {
    const result = updateLeaderboardFromMainSave(store, userId);
    if (result.changed) summary.changed += 1;
    if (result.reason === "created") summary.created += 1;
    else if (result.reason === "updated") summary.updated += 1;
    else if (result.reason === "hidden") summary.hidden += 1;
    else summary.skipped += 1;
  }
  return summary;
}

function normalizedCloudSaveSlot(value) {
  return typeof value === "string" && CLOUD_SAVE_SLOTS.includes(value) ? value : null;
}

function cloudStorageSlot(mode, slot) {
  return mode === "normal" ? slot : `${mode}:${slot}`;
}

function currentCloudSave(store, userId, slot = "main", mode = "normal") {
  if (mode === "normal") return slot === "main" ? store.data.cloudSaves[userId] : store.data.cloudSaveSlots[userId]?.[slot];
  return slot === "main"
    ? store.data.cloudSavesByMode[userId]?.[mode]
    : store.data.cloudSaveSlotsByMode[userId]?.[mode]?.[slot];
}

function legacyCloudSaveFallback(store, userId, slot = "main") {
  const save = currentCloudSave(store, userId, slot, "speedrun");
  return save?.legacyMode === true ? save : null;
}

function saveHistory(store, userId, slot = "main", mode = "normal") {
  if (mode === "normal") {
    if (slot === "main") return Array.isArray(store.data.cloudSaveHistory[userId]) ? store.data.cloudSaveHistory[userId] : [];
    return Array.isArray(store.data.cloudSaveSlotHistory[userId]?.[slot]) ? store.data.cloudSaveSlotHistory[userId][slot] : [];
  }
  if (slot === "main") return Array.isArray(store.data.cloudSaveHistoryByMode[userId]?.[mode]) ? store.data.cloudSaveHistoryByMode[userId][mode] : [];
  return Array.isArray(store.data.cloudSaveSlotHistoryByMode[userId]?.[mode]?.[slot]) ? store.data.cloudSaveSlotHistoryByMode[userId][mode][slot] : [];
}

function cloudSavePayload(store, userId, slot, revision, save = null, mode = "normal") {
  if (typeof store.readCloudSavePayload === "function") return store.readCloudSavePayload(userId, cloudStorageSlot(mode, slot), revision);
  const candidate = save ?? saveHistory(store, userId, slot, mode).find((entry) => entry.revision === revision) ?? currentCloudSave(store, userId, slot, mode);
  return typeof candidate?.payload === "string" ? candidate.payload : null;
}

function materializeCloudSave(store, userId, slot, save, mode = "normal") {
  if (!save) return null;
  const payload = cloudSavePayload(store, userId, slot, save.revision, save, mode);
  return typeof payload === "string" ? { ...save, payload } : null;
}

function appendSaveRevision(store, userId, save, slot = "main", mode = "normal") {
  const previousHistory = saveHistory(store, userId, slot, mode);
  const storageSlot = cloudStorageSlot(mode, slot);
  const storedSave = typeof save?.payloadFile === "string" && typeof store.stageCloudSavePayloadFile === "function"
    ? store.stageCloudSavePayloadFile(userId, storageSlot, save)
    : typeof store.stageCloudSavePayload === "function"
      ? store.stageCloudSavePayload(userId, storageSlot, save)
      : save;
  const history = [...previousHistory.filter((entry) => entry.revision !== save.revision), storedSave]
    .sort((left, right) => left.revision - right.revision)
    .slice(-CLOUD_HISTORY_LIMIT);
  if (typeof store.discardCloudSavePayload === "function") {
    const retainedRevisions = new Set(history.map((entry) => entry.revision));
    for (const entry of previousHistory) {
      if (!retainedRevisions.has(entry.revision)) store.discardCloudSavePayload(userId, storageSlot, entry.revision);
    }
  }
  if (mode === "normal" && slot === "main") {
    store.data.cloudSaveHistory[userId] = history;
    store.data.cloudSaves[userId] = storedSave;
    return;
  }
  if (mode === "normal") {
    store.data.cloudSaveSlots[userId] ??= {};
    store.data.cloudSaveSlotHistory[userId] ??= {};
    store.data.cloudSaveSlots[userId][slot] = storedSave;
    store.data.cloudSaveSlotHistory[userId][slot] = history;
    return;
  }
  store.data.cloudSavesByMode[userId] ??= {};
  store.data.cloudSaveHistoryByMode[userId] ??= {};
  if (slot === "main") {
    store.data.cloudSavesByMode[userId][mode] = storedSave;
    store.data.cloudSaveHistoryByMode[userId][mode] = history;
    return;
  }
  store.data.cloudSaveSlotsByMode[userId] ??= {};
  store.data.cloudSaveSlotHistoryByMode[userId] ??= {};
  store.data.cloudSaveSlotsByMode[userId][mode] ??= {};
  store.data.cloudSaveSlotHistoryByMode[userId][mode] ??= {};
  store.data.cloudSaveSlotsByMode[userId][mode][slot] = storedSave;
  store.data.cloudSaveSlotHistoryByMode[userId][mode][slot] = history;
}

function accountCloudRevisionRecords(store, userId) {
  const records = [];
  for (const mode of SAVE_MODES) {
    for (const slot of CLOUD_SAVE_SLOTS) {
      const byRevision = new Map();
      for (const save of saveHistory(store, userId, slot, mode)) {
        if (Number.isInteger(save?.revision) && save.revision > 0) byRevision.set(save.revision, save);
      }
      const current = currentCloudSave(store, userId, slot, mode);
      if (Number.isInteger(current?.revision) && current.revision > 0) byRevision.set(current.revision, current);
      for (const save of byRevision.values()) {
        records.push({
          mode,
          slot,
          revision: save.revision,
          updatedAt: Number.isSafeInteger(save.updatedAt) ? Math.max(0, save.updatedAt) : 0,
          size: Number.isSafeInteger(save.size) ? save.size : 0,
          checksum: save.checksum,
        });
      }
    }
  }
  return records;
}

function currentAccountArchiveImportGuard(store, userId) {
  return accountArchiveImportGuard(accountCloudRevisionRecords(store, userId));
}

function clearAccountCloudSaveMetadata(store, userId) {
  delete store.data.cloudSaves[userId];
  delete store.data.cloudSaveHistory[userId];
  delete store.data.cloudSaveSlots[userId];
  delete store.data.cloudSaveSlotHistory[userId];
  delete store.data.cloudSavesByMode[userId];
  delete store.data.cloudSaveHistoryByMode[userId];
  delete store.data.cloudSaveSlotsByMode[userId];
  delete store.data.cloudSaveSlotHistoryByMode[userId];
  if (typeof store.replaceUserCloudSavePayloads === "function") store.replaceUserCloudSavePayloads(userId);
  else store.discardUserCloudSavePayloads?.(userId);
}

function installAccountArchiveCloudSaves(store, userId, records) {
  clearAccountCloudSaveMetadata(store, userId);
  const grouped = new Map();
  for (const record of records) {
    const key = `${record.mode}:${record.slot}`;
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }
  const reviewRevisions = {};
  for (const mode of SAVE_MODES) {
    for (const slot of CLOUD_SAVE_SLOTS) {
      const group = (grouped.get(`${mode}:${slot}`) ?? []).sort((left, right) => left.revision - right.revision);
      for (const record of group) {
        appendSaveRevision(store, userId, {
          revision: record.revision,
          ...(typeof record.payloadFile === "string"
            ? { payloadFile: record.payloadFile }
            : { payload: record.payload }),
          checksum: record.checksum,
          size: record.size,
          updatedAt: record.updatedAt,
          summary: record.summary,
          ...(record.legacyMode ? { legacyMode: true } : {}),
        }, slot, mode);
      }
      const latest = group.at(-1);
      if (slot === "main" && latest) reviewRevisions[mode] = latest.revision;
    }
  }
  const previousControl = store.data.accountControls[userId] ?? null;
  const existingThresholds = leaderboardRevalidationThresholds(store.data, userId);
  const thresholds = Object.fromEntries(SAVE_MODES.flatMap((mode) => {
    const threshold = Math.max(existingThresholds[mode] ?? 0, reviewRevisions[mode] ?? 0);
    return threshold > 0 ? [[mode, threshold]] : [];
  }));
  if (Object.keys(thresholds).length > 0 || previousControl?.loginDisabledUntil) {
    store.data.accountControls[userId] = {
      ...(previousControl ?? {}),
      source: previousControl?.source ?? "account-archive-import",
      createdAt: previousControl?.createdAt ?? Date.now(),
      ...(thresholds.normal ? { leaderboardResumeAfterRevision: thresholds.normal } : {}),
      leaderboardResumeAfterRevisionByMode: thresholds,
    };
  }
  if ((thresholds.normal ?? 0) > 0) store.recordRuntimeIndexEvent?.({ type: "leaderboard-revalidation", userId });
  // Existing public records remain byte-for-byte untouched. Revalidation
  // hides the imported cloud state from future refreshes until a new revision.
  const cache = leaderboardWindowCache(store);
  for (const key of [...cache.keys()]) if (key.startsWith(`${userId}:`)) cache.delete(key);
}

function pruneCloudSaveRevisions(store, userId, slot, mode, revisions) {
  const requested = new Set((revisions ?? []).filter((revision) => Number.isInteger(revision) && revision > 0));
  if (requested.size === 0) return { revisionCount: 0, logicalBytes: 0, revisions: [] };
  const current = currentCloudSave(store, userId, slot, mode);
  if (Number.isInteger(current?.revision)) requested.delete(current.revision);
  const history = saveHistory(store, userId, slot, mode);
  const removed = history.filter((entry) => requested.has(entry?.revision));
  if (removed.length === 0) return { revisionCount: 0, logicalBytes: 0, revisions: [] };
  const retained = history.filter((entry) => !requested.has(entry?.revision));
  if (mode === "normal" && slot === "main") {
    store.data.cloudSaveHistory[userId] = retained;
  } else if (mode === "normal") {
    store.data.cloudSaveSlotHistory[userId] ??= {};
    store.data.cloudSaveSlotHistory[userId][slot] = retained;
  } else if (slot === "main") {
    store.data.cloudSaveHistoryByMode[userId] ??= {};
    store.data.cloudSaveHistoryByMode[userId][mode] = retained;
  } else {
    store.data.cloudSaveSlotHistoryByMode[userId] ??= {};
    store.data.cloudSaveSlotHistoryByMode[userId][mode] ??= {};
    store.data.cloudSaveSlotHistoryByMode[userId][mode][slot] = retained;
  }
  if (typeof store.discardCloudSavePayload === "function") {
    const storageSlot = cloudStorageSlot(mode, slot);
    for (const entry of removed) store.discardCloudSavePayload(userId, storageSlot, entry.revision);
  }
  return {
    revisionCount: removed.length,
    logicalBytes: removed.reduce((sum, entry) => sum + Math.max(0, Number(entry?.size) || 0), 0),
    revisions: removed.map((entry) => entry.revision).sort((left, right) => left - right),
  };
}

function deleteCloudSaveData(store, userId, slot = "main", mode = "normal") {
  const current = currentCloudSave(store, userId, slot, mode);
  const revisions = new Set(saveHistory(store, userId, slot, mode).map((entry) => entry?.revision));
  if (current?.revision) revisions.add(current.revision);
  if (typeof store.discardCloudSavePayload === "function") {
    const storageSlot = cloudStorageSlot(mode, slot);
    for (const revision of revisions) store.discardCloudSavePayload(userId, storageSlot, revision);
  }
  if (mode === "normal" && slot === "main") {
    delete store.data.cloudSaves[userId];
    delete store.data.cloudSaveHistory[userId];
    removeUserLeaderboardSubmissions(store, userId);
    store.recordRuntimeIndexEvent?.({ type: "leaderboard-revalidation", userId });
  } else if (mode === "normal") {
    delete store.data.cloudSaveSlots[userId]?.[slot];
    delete store.data.cloudSaveSlotHistory[userId]?.[slot];
    if (store.data.cloudSaveSlots[userId] && Object.keys(store.data.cloudSaveSlots[userId]).length === 0) delete store.data.cloudSaveSlots[userId];
    if (store.data.cloudSaveSlotHistory[userId] && Object.keys(store.data.cloudSaveSlotHistory[userId]).length === 0) delete store.data.cloudSaveSlotHistory[userId];
  } else if (slot === "main") {
    delete store.data.cloudSavesByMode[userId]?.[mode];
    delete store.data.cloudSaveHistoryByMode[userId]?.[mode];
    if (store.data.cloudSavesByMode[userId] && Object.keys(store.data.cloudSavesByMode[userId]).length === 0) delete store.data.cloudSavesByMode[userId];
    if (store.data.cloudSaveHistoryByMode[userId] && Object.keys(store.data.cloudSaveHistoryByMode[userId]).length === 0) delete store.data.cloudSaveHistoryByMode[userId];
  } else {
    delete store.data.cloudSaveSlotsByMode[userId]?.[mode]?.[slot];
    delete store.data.cloudSaveSlotHistoryByMode[userId]?.[mode]?.[slot];
    if (store.data.cloudSaveSlotsByMode[userId]?.[mode] && Object.keys(store.data.cloudSaveSlotsByMode[userId][mode]).length === 0) delete store.data.cloudSaveSlotsByMode[userId][mode];
    if (store.data.cloudSaveSlotHistoryByMode[userId]?.[mode] && Object.keys(store.data.cloudSaveSlotHistoryByMode[userId][mode]).length === 0) delete store.data.cloudSaveSlotHistoryByMode[userId][mode];
    if (store.data.cloudSaveSlotsByMode[userId] && Object.keys(store.data.cloudSaveSlotsByMode[userId]).length === 0) delete store.data.cloudSaveSlotsByMode[userId];
    if (store.data.cloudSaveSlotHistoryByMode[userId] && Object.keys(store.data.cloudSaveSlotHistoryByMode[userId]).length === 0) delete store.data.cloudSaveSlotHistoryByMode[userId];
  }
  return { current, deletedRevisions: revisions.size };
}

function cloudSaveSlotMetadata(store, userId, mode = "normal") {
  return Object.fromEntries(CLOUD_SAVE_SLOTS.map((slot) => [slot, cloudSaveMetadata(currentCloudSave(store, userId, slot, mode), slot, mode)]));
}

function materializeManualCloudSaveSlots(store, userId, mode = "normal") {
  return Object.fromEntries(MANUAL_CLOUD_SAVE_SLOTS.flatMap((slot) => {
    const save = currentCloudSave(store, userId, slot, mode);
    return save ? [[slot, materializeCloudSave(store, userId, slot, save, mode)]] : [];
  }));
}

function materializeManualCloudSaveHistory(store, userId, mode = "normal") {
  return Object.fromEntries(MANUAL_CLOUD_SAVE_SLOTS.flatMap((slot) => {
    const history = saveHistory(store, userId, slot, mode);
    return history.length > 0
      ? [[slot, history.map((save) => materializeCloudSave(store, userId, slot, save, mode))]]
      : [];
  }));
}

function accountArchiveSaveEntries(store, userId, snapshot) {
  const entries = [];
  for (const mode of SAVE_MODES) {
    for (const slot of CLOUD_SAVE_SLOTS) {
      const byRevision = new Map();
      for (const save of saveHistory(store, userId, slot, mode)) {
        if (Number.isInteger(save?.revision) && save.revision > 0) byRevision.set(save.revision, save);
      }
      const current = currentCloudSave(store, userId, slot, mode);
      if (Number.isInteger(current?.revision) && current.revision > 0) byRevision.set(current.revision, current);
      for (const save of [...byRevision.values()].sort((left, right) => left.revision - right.revision)) {
        if (!Number.isSafeInteger(save.size) || save.size < 1 || typeof save.checksum !== "string" || !/^[a-f0-9]{64}$/.test(save.checksum)) {
          const error = new Error("云存档修订元数据不完整，账号归档已停止；现有数据未修改");
          error.statusCode = 409;
          error.code = "ACCOUNT_ARCHIVE_SAVE_METADATA_INVALID";
          throw error;
        }
        entries.push({
          mode,
          slot,
          revision: save.revision,
          updatedAt: Number.isSafeInteger(save.updatedAt) ? Math.max(0, save.updatedAt) : 0,
          size: save.size,
          checksum: save.checksum,
          payload: () => {
            const payload = snapshot.readPayload(userId, cloudStorageSlot(mode, slot), save.revision);
            if (typeof payload !== "string") {
              const error = new Error("账号归档期间云存档正文不可用");
              error.code = "CLOUD_SAVE_PAYLOAD_MISSING";
              throw error;
            }
            return payload;
          },
        });
      }
    }
  }
  return entries;
}

function accountArchiveMetadata(store, userId, exportedAt) {
  const submissions = Object.values(store.data.submissions).filter((entry) => entry.userId === userId);
  const speedrunSubmissions = Object.values(store.data.speedrunSubmissions).filter((entry) => entry.userId === userId);
  const feedback = store.data.feedback.filter((entry) => entry.userId === userId).map(({ ipHash: _ipHash, ...entry }) => entry);
  const errors = store.data.errors.filter((entry) => entry.userId === userId).map(({ ipHash: _ipHash, ...entry }) => entry);
  return structuredClone({
    format: "dspidle-account-data",
    version: 2,
    exportedAt,
    accountId: userId,
    user: publicUser(store.data.users[userId]),
    submissions,
    speedrunSubmissions,
    feedback,
    errors,
  });
}

function preflightAccountArchiveSources(archiveInput, signal) {
  const verified = new Set();
  for (const save of archiveInput.saves) {
    if (signal?.aborted) {
      const error = new Error("账号归档下载已取消");
      error.code = "ACCOUNT_ARCHIVE_ABORTED";
      throw error;
    }
    if (verified.has(save.checksum)) continue;
    const payload = typeof save.payload === "function" ? save.payload() : save.payload;
    if (typeof payload !== "string") {
      const error = new Error("账号归档期间云存档正文不可用");
      error.statusCode = 500;
      error.code = "CLOUD_SAVE_PAYLOAD_MISSING";
      throw error;
    }
    if (Buffer.byteLength(payload, "utf8") !== save.size) {
      const error = new Error("云存档正文大小与修订元数据不一致，账号归档已停止");
      error.statusCode = 409;
      error.code = "ACCOUNT_ARCHIVE_PAYLOAD_SIZE_MISMATCH";
      throw error;
    }
    if (sha256(payload) !== save.checksum) {
      const error = new Error("云存档正文与修订校验值不一致，账号归档已停止");
      error.statusCode = 409;
      error.code = "ACCOUNT_ARCHIVE_PAYLOAD_CHECKSUM_MISMATCH";
      throw error;
    }
    verified.add(save.checksum);
  }
}

async function sendAccountArchive(response, request, archiveInput, fileName, snapshot) {
  const abort = new AbortController();
  const onRequestAborted = () => abort.abort();
  const onResponseClose = () => {
    if (!response.writableEnded) abort.abort();
  };
  request.once("aborted", onRequestAborted);
  response.once("close", onResponseClose);
  try {
    // A streaming response cannot change its status after headers are sent.
    // Validate one unique payload at a time from the stable SQLite snapshot so
    // corruption returns an explicit JSON error instead of a misleading 200
    // followed by a reset. No payload is retained after its digest is checked.
    preflightAccountArchiveSources(archiveInput, abort.signal);
    const archive = createAccountArchiveZipStream(archiveInput, { signal: abort.signal });
    response.writeHead(200, {
      "content-type": "application/vnd.dspidle.account-archive+zip",
      "content-length": String(archive.byteLength),
      "content-disposition": `attachment; filename="${fileName}"`,
      "x-dsp-account-archive-version": "2",
      ...securityResponseHeaders({
        privacy: "private",
        responseKind: "download",
        cors: response.httpSecurityCors ?? null,
        secureTransport: response.httpSecuritySecureTransport === true,
      }),
    });
    for await (const chunk of archive.stream) {
      if (abort.signal.aborted) {
        const error = new Error("账号归档下载已取消");
        error.code = "ACCOUNT_ARCHIVE_ABORTED";
        throw error;
      }
      await writeResponseChunk(response, chunk);
    }
    response.end();
  } finally {
    request.removeListener("aborted", onRequestAborted);
    response.removeListener("close", onResponseClose);
    snapshot.close();
  }
}

function normalizedPlayerId(value) {
  return typeof value === "string" && PLAYER_ID_PATTERN.test(value) ? value : null;
}

function adminAuthorized(request, adminToken) {
  if (!adminToken) return false;
  const authorization = request.headers.authorization;
  const provided = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!provided) return false;
  return timingSafeEqual(Buffer.from(sha256(provided), "hex"), Buffer.from(sha256(adminToken), "hex"));
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 100) / 100;
}

async function operationalStatus(file) {
  if (!file) return { configured: false, ok: false, state: "disabled" };
  try {
    const source = JSON.parse(await fs.readFile(file, "utf8"));
    return {
      configured: true,
      ok: source.ok === true,
      state: source.ok === true ? "ready" : "failed",
      completedAt: Number.isFinite(source.completedAt) ? source.completedAt : null,
      failedAt: Number.isFinite(source.failedAt) ? source.failedAt : null,
      durationMs: Number.isFinite(source.durationMs) ? source.durationMs : null,
      transported: source.transported === true,
      transport: typeof source.transport === "string" ? source.transport.slice(0, 20) : null,
      schemaVersion: Number.isInteger(source.schemaVersion ?? source.restoredSchemaVersion) ? (source.schemaVersion ?? source.restoredSchemaVersion) : null,
      artifact: typeof source.artifact === "string" ? path.basename(source.artifact).slice(0, 160) : null,
      error: typeof source.error === "string" ? source.error.slice(0, 300) : null,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      state: error?.code === "ENOENT" ? "pending" : "unreadable",
      completedAt: null,
      failedAt: null,
      error: error?.code === "ENOENT" ? null : "状态文件无法读取",
    };
  }
}

async function nodeHealthStatus(file) {
  if (!file) return { configured: false, ok: false, state: "disabled" };
  try {
    const source = JSON.parse(await fs.readFile(file, "utf8"));
    return {
      configured: true,
      ok: source.ok === true,
      state: source.ok === true ? "ready" : "failed",
      checkedAt: Number.isFinite(source.checkedAt) ? source.checkedAt : null,
      failedChecks: Array.isArray(source.failedChecks) ? source.failedChecks.slice(0, 20).map((value) => String(value).slice(0, 160)) : [],
      endpoints: Array.isArray(source.endpoints) ? source.endpoints.slice(0, 10).map((entry) => ({
        url: typeof entry.url === "string" ? entry.url.slice(0, 240) : "",
        ok: entry.ok === true,
        status: Number.isInteger(entry.status) ? entry.status : 0,
        latencyMs: Number.isFinite(entry.latencyMs) ? entry.latencyMs : null,
        contentEncoding: typeof entry.contentEncoding === "string" ? entry.contentEncoding.slice(0, 30) : null,
      })) : [],
      disk: source.disk && typeof source.disk === "object" ? {
        ok: source.disk.ok === true,
        freeBytes: Number.isFinite(source.disk.freeBytes) ? source.disk.freeBytes : null,
        totalBytes: Number.isFinite(source.disk.totalBytes) ? source.disk.totalBytes : null,
        freeRatio: Number.isFinite(source.disk.freeRatio) ? source.disk.freeRatio : null,
      } : null,
      tls: source.tls && typeof source.tls === "object" ? {
        configured: source.tls.configured === true,
        ok: source.tls.ok === true,
        expiresAt: Number.isFinite(source.tls.expiresAt) ? source.tls.expiresAt : null,
        daysRemaining: Number.isFinite(source.tls.daysRemaining) ? source.tls.daysRemaining : null,
      } : null,
      alertSent: source.alertSent === true,
    };
  } catch (error) {
    return { configured: true, ok: false, state: error?.code === "ENOENT" ? "pending" : "unreadable", checkedAt: null, failedChecks: [] };
  }
}

export async function createCloudServer({
  dataFile = process.env.DSP_CLOUD_DATA_FILE || "",
  databaseFile = process.env.DSP_CLOUD_DATABASE_FILE || (dataFile ? "" : path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "cloud.sqlite")),
  backupDirectory = process.env.DSP_CLOUD_BACKUP_DIRECTORY || "",
  backupIntervalMs = Number(process.env.DSP_CLOUD_BACKUP_INTERVAL_MS || 6 * 60 * 60 * 1000),
  backupWindow = process.env.DSP_CLOUD_BACKUP_WINDOW || "",
  backupStartupGraceMs = Number(process.env.DSP_CLOUD_BACKUP_STARTUP_GRACE_MS || 15 * 60 * 1000),
  historyPruneIntervalMs = Number(process.env.DSP_CLOUD_PRUNE_INTERVAL_MS || 6 * 60 * 60 * 1000),
  requestTimeoutMs = Number(process.env.DSP_CLOUD_REQUEST_TIMEOUT_MS || cloudTransferContract.maximumTimeoutMs + 10_000),
  allowedOrigin = process.env.DSP_ALLOWED_ORIGIN || "",
  playerOnlineWindowMs = Number(process.env.DSP_PLAYER_ONLINE_WINDOW_MS || DEFAULT_PLAYER_ONLINE_WINDOW_MS),
  metricTimeZone = process.env.DSP_METRIC_TIME_ZONE || DEFAULT_METRIC_TIME_ZONE,
  adminToken = process.env.DSP_ADMIN_TOKEN || "",
  mailer,
  mailWebhookUrl = process.env.DSP_MAIL_WEBHOOK_URL || "",
  mailWebhookToken = process.env.DSP_MAIL_WEBHOOK_TOKEN || "",
  mailTencentSecretId = process.env.DSP_MAIL_TENCENT_SECRET_ID || "",
  mailTencentSecretKey = process.env.DSP_MAIL_TENCENT_SECRET_KEY || "",
  mailTencentRegion = process.env.DSP_MAIL_TENCENT_REGION || "ap-hongkong",
  mailTencentFrom = process.env.DSP_MAIL_TENCENT_FROM || "",
  mailTencentVerificationTemplateId = process.env.DSP_MAIL_TENCENT_VERIFY_TEMPLATE_ID || "",
  mailTencentResetTemplateId = process.env.DSP_MAIL_TENCENT_RESET_TEMPLATE_ID || "",
  mailReplyTo = process.env.DSP_MAIL_REPLY_TO || "",
  publicBaseUrl = process.env.DSP_PUBLIC_BASE_URL || "",
  offsiteBackupStatusFile = process.env.DSP_OFFSITE_BACKUP_STATUS_FILE || "",
  restoreDrillStatusFile = process.env.DSP_RESTORE_DRILL_STATUS_FILE || "",
  nodeHealthStatusFile = process.env.DSP_NODE_HEALTH_STATUS_FILE || "",
  registrationLimit = Number(process.env.DSP_REGISTRATION_LIMIT_PER_HOUR || 3),
  activityConfigFile = process.env.DSP_ACTIVITY_CONFIG_FILE || "",
  activityConfig = null,
  persistenceFaultInjector = null,
  uploadInspectionConcurrency = Number(process.env.DSP_UPLOAD_INSPECTION_CONCURRENCY || 2),
  uploadInspectionQueueLimit = Number(process.env.DSP_UPLOAD_INSPECTION_QUEUE_LIMIT || 16),
  uploadInspectionWorkerThresholdBytes = Number(process.env.DSP_UPLOAD_INSPECTION_WORKER_THRESHOLD_BYTES || 1024 * 1024),
  cloudQuotaPolicy = null,
  accountArchivePayloadInspector = inspectAccountArchivePayloadFile,
  accountArchiveTemporaryRoot = "",
  nowProvider = Date.now,
  runtimeRetentionPolicy = null,
  logger = console,
} = {}) {
  const store = databaseFile
    ? new SqliteStore(databaseFile, persistenceFaultInjector)
    : new JsonStore(dataFile || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "cloud.json"), persistenceFaultInjector);
  try {
    await store.load();
  } catch (error) {
    store.close?.();
    throw error;
  }
  if (databaseFile && dataFile && Object.keys(store.data.users).length === 0) {
    try {
      const legacy = JSON.parse(await fs.readFile(dataFile, "utf8"));
      if (Object.keys(legacy?.users ?? {}).length > 0 || Object.keys(legacy?.cloudSaves ?? {}).length > 0 || legacy?.feedback?.length > 0 || legacy?.errors?.length > 0) {
        await store.importLegacyData(legacy);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logger.error?.("legacy cloud data migration failed", error);
        store.close?.();
        throw error;
      }
    }
  }
  const startupResult = await store.mutate((draftStore) => ({
    cleanup: cleanupExpiredAuthRecords(draftStore.data),
    leaderboardBackfill: backfillLeaderboardFromMainSaves(draftStore),
  }), { operation: "startup.normalize" });
  const leaderboardBackfill = startupResult.leaderboardBackfill;
  const startedAt = nowProvider();
  const galacticActivityConfig = activityConfig ? normalizeActivityConfig(activityConfig) : await loadActivityConfig(activityConfigFile);
  const rateLimit = createRateLimiter();
  const registrationRateLimit = createRateLimiter();
  const loginFailureGuard = createLoginFailureGuard();
  const uploadInspections = new UploadInspectionScheduler({
    inspectInline: inspectDecodedCloudSaveUpload,
    concurrency: uploadInspectionConcurrency,
    queueLimit: uploadInspectionQueueLimit,
    workerThresholdBytes: uploadInspectionWorkerThresholdBytes,
    maximumConcurrentExpandedBytes: cloudTransferContract.maximumConcurrentExpandedBytes,
  });
  const quotaPolicy = normalizeCloudQuotaPolicy(cloudQuotaPolicy ?? {
    revisionBytes: Number(process.env.DSP_CLOUD_REVISION_QUOTA_BYTES || DEFAULT_CLOUD_QUOTA_POLICY.revisionBytes),
    slotBytes: Number(process.env.DSP_CLOUD_SLOT_QUOTA_BYTES || DEFAULT_CLOUD_QUOTA_POLICY.slotBytes),
    modeBytes: Number(process.env.DSP_CLOUD_MODE_QUOTA_BYTES || DEFAULT_CLOUD_QUOTA_POLICY.modeBytes),
    accountBytes: Number(process.env.DSP_CLOUD_ACCOUNT_QUOTA_BYTES || DEFAULT_CLOUD_QUOTA_POLICY.accountBytes),
    historyRevisions: Number(process.env.DSP_CLOUD_HISTORY_REVISIONS || DEFAULT_CLOUD_QUOTA_POLICY.historyRevisions),
  });
  const runtime = {
    requests: 0,
    errors: 0,
    rateLimited: 0,
    cloudConflicts: 0,
    latencies: [],
    lastBackupAt: null,
    lastBackupErrorAt: null,
    backup: { state: backupDirectory ? "idle" : "disabled", startedAt: null, completedAt: null, failedAt: null, durationMs: null },
    lastBackupDayKey: null,
    historyPruneRuns: 0,
    historyPrunedPayloads: 0,
    historyPrunedMetadata: 0,
    lastHistoryPruneAt: null,
    slowRequests: 0,
    maxRequestMs: 0,
    shuttingDown: false,
  };
  const activeRequests = new Set();
  const onlineWindowMs = Number.isFinite(playerOnlineWindowMs)
    ? Math.max(50, Math.floor(playerOnlineWindowMs))
    : DEFAULT_PLAYER_ONLINE_WINDOW_MS;
  let metricsTimeZone = DEFAULT_METRIC_TIME_ZONE;
  try {
    metricDay(Date.now(), metricTimeZone);
    metricsTimeZone = metricTimeZone;
  } catch {
    logger.error?.(`invalid metric time zone ${metricTimeZone}; using ${DEFAULT_METRIC_TIME_ZONE}`);
  }
  const presenceIndex = new PresenceIndex({ onlineWindowMs, timeZone: metricsTimeZone });
  presenceIndex.rebuild(store.data.players, nowProvider());
  const leaderboardIndex = new LeaderboardSnapshotIndex({
    getAuthoritativeData: () => store._data,
    categories: [...VALID_CATEGORIES],
    normalizeMetrics,
    categoryValue,
    isRestricted: (data, userId) => isLeaderboardRestricted(data, userId),
  });
  const runtimeMetrics = new RuntimeMetricsAggregator();
  store.setPersistenceObserver((sample) => runtimeMetrics.observeSqliteCommit(sample));
  store.setExternalMutationObserver(({ collection, key, previous, value }) => {
    if (collection === "submissions") {
      const entry = value ?? previous;
      if (typeof entry?.seasonId === "string") leaderboardIndex.markSubmissionChanged({ userId: entry.userId ?? String(key).split(":").at(-1), seasonId: entry.seasonId });
    } else if (collection === "users" && typeof key === "string") leaderboardIndex.markAccountChanged(key);
    else if (collection === "leaderboardModeration" && typeof key === "string") leaderboardIndex.markRestrictionChanged(key);
    else if (collection === "accountControls" && typeof key === "string") leaderboardIndex.markRevalidationChanged(key);
    else if (["submissions", "users", "leaderboardModeration", "accountControls"].includes(collection)) leaderboardIndex.rebuild();
  });
  let eventLoopExpectedAt = performance.now() + 1_000;
  const runtimeSampleTimer = setInterval(() => {
    const sampledAt = performance.now();
    runtimeMetrics.observeEventLoopDelay(Math.max(0, sampledAt - eventLoopExpectedAt));
    eventLoopExpectedAt = sampledAt + 1_000;
    runtimeMetrics.sampleMemory(process.memoryUsage());
    runtimeMetrics.observeUploadSnapshot(uploadInspections.snapshot());
    runtimeMetrics.observeLeaderboardCache(leaderboardIndex.metrics());
  }, 1_000);
  runtimeSampleTimer.unref?.();
  const unsubscribeStoreCommit = store.onCommitted(({ data, runtimeIndexEvents }) => {
    for (const event of runtimeIndexEvents) {
      if (event.type === "presence") presenceIndex.heartbeat(event.playerHash, event.seenAt);
      else if (event.type === "leaderboard-submission") leaderboardIndex.markSubmissionChanged({ userId: event.userId, seasonId: event.seasonId });
      else if (event.type === "leaderboard-visibility") leaderboardIndex.markVisibilityChanged(event.userId);
      else if (event.type === "leaderboard-restriction") leaderboardIndex.markRestrictionChanged(event.userId);
      else if (event.type === "leaderboard-revalidation") leaderboardIndex.markRevalidationChanged(event.userId);
      else if (event.type === "leaderboard-account") leaderboardIndex.markAccountChanged(event.userId);
      else if (event.type === "rebuild") {
        presenceIndex.rebuild(data.players, nowProvider());
        leaderboardIndex.rebuild();
      }
    }
  });
  const secureAdminToken = typeof adminToken === "string" && adminToken.length >= 32 ? adminToken : "";
  if (adminToken && !secureAdminToken) logger.error?.("DSP_ADMIN_TOKEN must contain at least 32 characters; admin metrics remain disabled");
  const allowedOrigins = new Set(allowedOrigin.split(",").map((origin) => origin.trim()).filter(Boolean));
  const corsPolicy = createCorsPolicy({ allowedOrigins: [...allowedOrigins], allowCredentials: true });
  const webSessionPolicy = allowedOrigins.size > 0
    ? createWebSessionPolicy({ allowedOrigins: [...allowedOrigins] })
    : null;
  const authenticateRequest = (request) => authenticatedUser(request, store, webSessionPolicy);
  const requireWebSessionPolicy = () => {
    if (webSessionPolicy) return webSessionPolicy;
    throw new WebSessionError("WEB_SESSION_UNAVAILABLE", "当前云节点未配置 Web Cookie 会话", 501);
  };
  const inspectSessionIssuance = (request) => {
    if (request.headers[WEB_SESSION_MODE_HEADER] !== undefined && !webSessionPolicy) requireWebSessionPolicy();
    return inspectSessionIssuanceRequest(request, webSessionPolicy);
  };
  const deliverIssuedSession = (request, issued) => createSessionDelivery(request, {
    sessionToken: issued.token,
    sessionExpiresAt: issued.session.expiresAt,
  }, webSessionPolicy);
  const tencentSesMailer = mailer === undefined ? createTencentSesMailer({
    secretId: mailTencentSecretId,
    secretKey: mailTencentSecretKey,
    region: mailTencentRegion,
    fromEmailAddress: mailTencentFrom,
    verificationTemplateId: mailTencentVerificationTemplateId,
    resetTemplateId: mailTencentResetTemplateId,
    replyToAddresses: mailReplyTo,
    publicBaseUrl,
    logger,
  }) : null;
  const webhookMailer = mailer === undefined && !tencentSesMailer
    ? createWebhookMailer({ url: mailWebhookUrl, token: mailWebhookToken, publicBaseUrl, logger })
    : null;
  const accountMailer = mailer === undefined
    ? tencentSesMailer ?? webhookMailer
    : typeof mailer === "function" ? mailer : null;
  const accountMailProvider = typeof mailer === "function"
    ? "custom"
    : tencentSesMailer ? "tencent-ses" : webhookMailer ? "webhook" : "disabled";
  const configuredBackupWindow = parseDailyBackupWindow(backupWindow);
  if (backupWindow && !configuredBackupWindow) logger.error?.("DSP_CLOUD_BACKUP_WINDOW must use HH:MM-HH:MM; interval scheduling remains active");
  const normalizedBackupStartupGraceMs = normalizeBackupStartupGraceMs(backupStartupGraceMs);
  const backupStartedAt = nowProvider();

  const flushMetrics = setInterval(() => {
    if (runtime.shuttingDown) return;
    rateLimit.cleanup();
    registrationRateLimit.cleanup();
    void store.mutate((draftStore) => {
      const retention = applyRuntimeRetentionPolicy(draftStore.data, {
        now: nowProvider(),
        timeZone: metricsTimeZone,
        ...(runtimeRetentionPolicy ? { policy: runtimeRetentionPolicy } : {}),
      });
      draftStore.data.dailyMetrics = retention.retained.dailyMetrics;
      draftStore.data.analytics = retention.retained.analytics;
      draftStore.data.errors = retention.retained.errors;
      draftStore.data.errorSummaries = retention.retained.errorSummaries;
      draftStore.data.auditLog = retention.retained.auditLog;
      return {
        auth: cleanupExpiredAuthRecords(draftStore.data),
        operationReceipts: pruneOperationReceipts(draftStore.data),
        retention: retention.report,
      };
    }, { operation: "periodic.cleanup" })
      .catch((error) => logger.error?.("cloud metrics persistence failed", error));
  }, 60_000);
  flushMetrics.unref?.();
  let activeBackupPromise = null;
  let activeHistoryPrunePromise = null;
  const createBackup = async () => {
    if (!backupDirectory || runtime.backup.state === "running") return false;
    const started = Date.now();
    runtime.backup = { state: "running", startedAt: started, completedAt: runtime.backup.completedAt, failedAt: runtime.backup.failedAt, durationMs: null };
    try {
      const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      const extension = databaseFile ? ".sqlite" : ".json";
      await store.backup(path.join(backupDirectory, `cloud-${stamp}${extension}`));
      const files = (await fs.readdir(backupDirectory)).filter((file) => file.startsWith("cloud-") && file.endsWith(extension)).sort().reverse();
      await Promise.all(files.slice(30).map((file) => fs.unlink(path.join(backupDirectory, file))));
      runtime.lastBackupAt = Date.now();
      runtime.backup = { state: "ready", startedAt: started, completedAt: runtime.lastBackupAt, failedAt: null, durationMs: runtime.lastBackupAt - started };
      return true;
    } catch (error) {
      runtime.lastBackupErrorAt = Date.now();
      runtime.backup = { state: "failed", startedAt: started, completedAt: runtime.backup.completedAt, failedAt: runtime.lastBackupErrorAt, durationMs: runtime.lastBackupErrorAt - started };
      throw error;
    }
  };
  const startBackup = () => {
    if (activeBackupPromise) return activeBackupPromise;
    activeBackupPromise = createBackup().finally(() => { activeBackupPromise = null; });
    return activeBackupPromise;
  };
  const scheduledBackupTick = () => {
    if (runtime.shuttingDown) return;
    if (!backupStartupGraceElapsed(backupStartedAt, nowProvider(), normalizedBackupStartupGraceMs)) return;
    if (!configuredBackupWindow) return void startBackup().catch((error) => logger.error?.("cloud backup failed", error));
    const windowState = backupWindowState(configuredBackupWindow, new Date());
    if (!windowState.withinWindow || runtime.lastBackupDayKey === windowState.dayKey) return;
    runtime.lastBackupDayKey = windowState.dayKey;
    void startBackup().catch((error) => {
      runtime.lastBackupDayKey = null;
      logger.error?.("cloud backup failed", error);
    });
  };
  const backupTimer = backupDirectory && configuredBackupWindow
    ? setInterval(scheduledBackupTick, 60_000)
    : backupDirectory && Number.isFinite(backupIntervalMs) && backupIntervalMs >= 60_000
      ? setInterval(scheduledBackupTick, backupIntervalMs)
      : null;
  backupTimer?.unref?.();
  const backupStartupTimer = backupDirectory && normalizedBackupStartupGraceMs > 0
    ? setTimeout(scheduledBackupTick, normalizedBackupStartupGraceMs)
    : null;
  backupStartupTimer?.unref?.();
  if (backupDirectory && !configuredBackupWindow && normalizedBackupStartupGraceMs === 0) void startBackup().catch((error) => logger.error?.("initial cloud backup failed", error));
  else if (backupDirectory) scheduledBackupTick();

  const runPeriodicHistoryPrune = async () => {
    if (typeof store.previewCloudHistoryPrune !== "function") return;
    const preview = await store.previewCloudHistoryPrune();
    runtime.historyPruneRuns += 1;
    runtime.lastHistoryPruneAt = Date.now();
    if (preview.deletionCount < 1) return;
    const result = await store.mutate(async (draftStore) => {
      const applied = await draftStore.applyCloudHistoryPrune(preview.previewId);
      appendSystemAudit(draftStore, "cloud.history_pruned_periodic", null, "scheduled-governance");
      return applied;
    }, { operation: "cloud.history-prune-periodic" });
    runtime.historyPrunedPayloads += result.deletionCount;
    runtime.historyPrunedMetadata += result.metadataRemoved;
  };
  const startPeriodicHistoryPrune = () => {
    if (runtime.shuttingDown) return Promise.resolve();
    if (activeHistoryPrunePromise) return activeHistoryPrunePromise;
    activeHistoryPrunePromise = runPeriodicHistoryPrune().finally(() => { activeHistoryPrunePromise = null; });
    return activeHistoryPrunePromise;
  };
  const historyPruneTimer = databaseFile && Number.isFinite(historyPruneIntervalMs) && historyPruneIntervalMs >= 60_000
    ? setInterval(() => void startPeriodicHistoryPrune().catch((error) => logger.error?.("cloud history prune failed", error)), historyPruneIntervalMs)
    : null;
  historyPruneTimer?.unref?.();

  const handleRequest = async (request, response, atomicRequest, { preludeProcessed = false } = {}) => {
    if (!preludeProcessed) {
      const requestStartedAt = performance.now();
      response.once("finish", () => {
        const durationMs = Math.max(0, performance.now() - requestStartedAt);
        runtimeMetrics.observeRequest({ durationMs, statusCode: response.statusCode });
        runtime.latencies.push(durationMs);
        if (runtime.latencies.length > 2000) runtime.latencies.splice(0, runtime.latencies.length - 2000);
        if (response.statusCode === 429) runtime.rateLimited += 1;
        if (durationMs >= 1_000) runtime.slowRequests += 1;
        runtime.maxRequestMs = Math.max(runtime.maxRequestMs, durationMs);
      });
      runtime.requests += 1;
    }
    const day = metricDay(Date.now(), metricsTimeZone);
    const storedDayMetric = store.data.dailyMetrics[day] ?? { requests: 0, errors: 0, feedback: 0, leaderboardSubmissions: 0, cloudUploads: 0, players: 0 };
    const dayMetric = atomicRequest ? storedDayMetric : { ...storedDayMetric };
    for (const key of ["requests", "errors", "feedback", "leaderboardSubmissions", "cloudUploads", "players"]) {
      if (!Number.isFinite(dayMetric[key])) dayMetric[key] = 0;
    }
    dayMetric.requests += 1;
    if (atomicRequest) store.data.dailyMetrics[day] = dayMetric;
    const url = new URL(request.url || "/", "http://localhost");
    const ip = requestIp(request);

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return send(response, 200, { ok: true, service: "dsp-idle-cloud", schemaVersion: DEFAULT_DATA.schemaVersion, storage: databaseFile ? "sqlite" : "json", storageLayoutVersion: databaseFile ? store.data.storageLayoutVersion ?? 1 : 1, mailProvider: accountMailProvider, activity: { enabled: galacticActivityConfig.enabled, valid: galacticActivityConfig.valid, reason: galacticActivityConfig.reason }, maintenance: { backup: runtime.backup.state === "running", backupState: runtime.backup.state }, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), time: Date.now() });
      }
      if (request.method === "GET" && url.pathname === "/api/ready") {
        const persistence = store.persistenceStatus();
        const ready = persistence.writable && !runtime.shuttingDown;
        return send(response, ready ? 200 : 503, {
          writable: persistence.writable,
          lastSuccessAt: persistence.lastSuccessAt,
          lastErrorAt: persistence.lastErrorAt,
          lastErrorCategory: persistence.lastErrorCategory,
          pendingWrites: persistence.pendingWrites,
          shuttingDown: runtime.shuttingDown,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/public-status") {
        return send(response, 200, {
          ok: true,
          timeZone: metricsTimeZone,
          today: metricDay(Date.now(), metricsTimeZone),
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          players: presenceIndex.metrics(Date.now()),
          activity: getActivityPublicStatus(galacticActivityConfig, Date.now()),
        });
      }
      if (request.method === "GET" && (url.pathname === "/api/metrics" || url.pathname === "/api/admin/metrics")) {
        if (!secureAdminToken) return send(response, 503, { error: "管理员监控尚未配置" });
        if (!adminAuthorized(request, secureAdminToken)) return send(response, 401, { error: "管理员凭据无效" });
        const requestedDays = Number(url.searchParams.get("days"));
        const days = Number.isInteger(requestedDays) ? Math.max(1, Math.min(365, requestedDays)) : 30;
        const now = Date.now();
        const activeSessions = Object.values(store.data.sessions).filter((session) => session.expiresAt > now).length;
        const serviceDaily = Object.entries(store.data.dailyMetrics)
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(-days)
          .map(([metricDayId, metrics]) => ({ day: metricDayId, ...metrics }));
        const [offsiteBackup, restoreDrill, infrastructure] = await Promise.all([
          operationalStatus(offsiteBackupStatusFile),
          operationalStatus(restoreDrillStatusFile),
          nodeHealthStatus(nodeHealthStatusFile),
        ]);
        const statSize = async (file) => {
          try { return (await fs.stat(file)).size; } catch { return 0; }
        };
        const governance = databaseFile && typeof store.governanceMetrics === "function"
          ? store.governanceMetrics({
            databaseBytes: await statSize(databaseFile),
            walBytes: await statSize(`${databaseFile}-wal`),
            shmBytes: await statSize(`${databaseFile}-shm`),
          })
          : null;
        const diskFreeRatio = infrastructure?.disk?.freeRatio;
        runtimeMetrics.observeUploadSnapshot(uploadInspections.snapshot());
        runtimeMetrics.observeLeaderboardCache(leaderboardIndex.metrics());
        return send(response, 200, {
          generatedAt: now,
          timeZone: metricsTimeZone,
          schemaVersion: DEFAULT_DATA.schemaVersion,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          runtime: {
            requests: runtime.requests,
            errors: runtime.errors,
            rateLimited: runtime.rateLimited,
            cloudConflicts: runtime.cloudConflicts,
            p50LatencyMs: percentile(runtime.latencies, 0.5),
            p95LatencyMs: percentile(runtime.latencies, 0.95),
            slowRequests: runtime.slowRequests,
            maxRequestMs: Math.round(runtime.maxRequestMs * 100) / 100,
            writeQueueDepth: store.pendingWriteOperations ?? 0,
            maxWriteQueueDepth: store.maxPendingWriteOperations ?? 0,
            slowWrites: store.slowWriteCount ?? 0,
            lastWriteDurationMs: Math.round((store.lastWriteDurationMs ?? 0) * 100) / 100,
            uploadInspections: uploadInspections.snapshot(),
            loginSecurity: loginFailureGuard.metrics(),
            scale: runtimeMetrics.snapshot(),
            presenceIndex: presenceIndex.diagnostics(),
            runtimeStatePersistence: store.runtimeStatePersistence?.diagnostics({ includeRowCounts: true }) ?? null,
          },
          accounts: {
            users: Object.keys(store.data.users).length,
            activeSessions,
            cloudSaves: Object.keys(store.data.cloudSaves).length,
            submissions: Object.keys(store.data.submissions).length,
          },
          players: presenceIndex.metrics(now),
          analytics: analyticsSummary(store.data.analytics, { now, timeZone: metricsTimeZone, days }),
          reports: { feedback: store.data.feedback.length, clientErrors: store.data.errors.length },
          audit: {
            entries: store.data.auditLog.length,
            recent: [...store.data.auditLog].reverse().slice(0, 20),
          },
          backups: {
            configured: Boolean(backupDirectory),
            lastSuccessAt: runtime.lastBackupAt,
            lastErrorAt: runtime.lastBackupErrorAt,
            state: runtime.backup.state,
            startedAt: runtime.backup.startedAt,
            durationMs: runtime.backup.durationMs,
            dailyWindow: configuredBackupWindow?.source ?? null,
            offsite: offsiteBackup,
            restoreDrill,
          },
          governance: {
            sqlite: governance,
            historyPrune: {
              runs: runtime.historyPruneRuns,
              payloadsRemoved: runtime.historyPrunedPayloads,
              metadataRemoved: runtime.historyPrunedMetadata,
              lastRunAt: runtime.lastHistoryPruneAt,
            },
            disk: {
              warning80Percent: typeof diskFreeRatio === "number" ? diskFreeRatio <= 0.2 : false,
              protection90Percent: typeof diskFreeRatio === "number" ? diskFreeRatio <= 0.1 : false,
            },
          },
          infrastructure,
          daily: serviceDaily,
          storage: databaseFile ? "sqlite" : "json",
        });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/cloud-history/prune-preview") {
        if (!secureAdminToken) return send(response, 503, { error: "管理员接口尚未配置" });
        if (!adminAuthorized(request, secureAdminToken)) return send(response, 401, { error: "管理员凭据无效" });
        if (typeof store.previewCloudHistoryPrune !== "function") return send(response, 501, { error: "当前存储后端不支持在线历史治理" });
        await store.persist();
        const preview = await store.previewCloudHistoryPrune();
        return send(response, 200, { preview: publicCloudHistoryPrunePlan(preview) });
      }

      if (request.method === "POST" && url.pathname === "/api/admin/cloud-history/prune") {
        if (!secureAdminToken) return send(response, 503, { error: "管理员接口尚未配置" });
        if (!adminAuthorized(request, secureAdminToken)) return send(response, 401, { error: "管理员凭据无效" });
        if (typeof store.applyCloudHistoryPrune !== "function") return send(response, 501, { error: "当前存储后端不支持在线历史治理" });
        const body = await readJson(request);
        if (body.confirmation !== CLOUD_HISTORY_PRUNE_CONFIRMATION || typeof body.previewId !== "string" || !/^[a-f0-9]{64}$/.test(body.previewId)) {
          return send(response, 400, { error: "裁剪确认文字或预览标识无效", code: "CLOUD_PRUNE_CONFIRMATION_INVALID" });
        }
        const result = await store.applyCloudHistoryPrune(body.previewId);
        appendAdminAudit(store, request, "cloud.history_pruned_confirmed");
        await store.persist();
        runtime.historyPruneRuns += 1;
        runtime.historyPrunedPayloads += result.deletionCount;
        runtime.historyPrunedMetadata += result.metadataRemoved;
        runtime.lastHistoryPruneAt = Date.now();
        return send(response, 200, { result });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/account") {
        if (!secureAdminToken) return send(response, 503, { error: "管理员接口尚未配置" });
        if (!adminAuthorized(request, secureAdminToken)) return send(response, 401, { error: "管理员凭据无效" });
        const accountId = url.searchParams.get("accountId");
        const summary = typeof accountId === "string" ? adminAccountSummary(store, accountId) : null;
        if (!summary) return send(response, 404, { error: "账号不存在；管理员查询只接受精确 account ID" });
        appendAdminAudit(store, request, "admin.account_summary_viewed");
        await store.persist();
        return send(response, 200, { account: summary });
      }

      if (request.method === "POST" && url.pathname === "/api/admin/account/action") {
        if (!secureAdminToken) return send(response, 503, { error: "管理员接口尚未配置" });
        if (!adminAuthorized(request, secureAdminToken)) return send(response, 401, { error: "管理员凭据无效" });
        const body = await readJson(request);
        const accountId = typeof body.accountId === "string" && store.data.users[body.accountId] ? body.accountId : null;
        const action = typeof body.action === "string" ? body.action : "";
        const allowedActions = new Set(["revoke-sessions", "disable-login", "enable-login", "restrict-leaderboard", "restore-leaderboard", "delete-account"]);
        if (!accountId || !allowedActions.has(action)) return send(response, 400, { error: "账号或管理员动作无效" });
        if (body.confirmation !== `CONFIRM:${action}:${accountId}`) {
          return send(response, 400, { error: "二次确认文字不匹配", code: "ADMIN_CONFIRMATION_INVALID" });
        }
        store.data.accountControls ??= {};
        if (action === "revoke-sessions") {
          revokeUserSessions(store, accountId);
        } else if (action === "disable-login") {
          const durationSeconds = Number.isFinite(body.durationSeconds) ? Math.max(60, Math.min(30 * 24 * 60 * 60, Math.floor(body.durationSeconds))) : 24 * 60 * 60;
          store.data.accountControls[accountId] = {
            ...(store.data.accountControls[accountId] ?? {}),
            source: "admin-account-action",
            createdAt: Date.now(),
            loginDisabledUntil: Date.now() + durationSeconds * 1_000,
          };
          revokeUserSessions(store, accountId);
        } else if (action === "enable-login") {
          const control = store.data.accountControls[accountId];
          if (control) {
            delete control.loginDisabledUntil;
            const reviewRevisions = leaderboardRevalidationThresholds(store.data, accountId);
            if (reviewRevisions.normal <= 0 && reviewRevisions.speedrun <= 0) delete store.data.accountControls[accountId];
          }
        } else if (action === "restrict-leaderboard") {
          store.data.leaderboardModeration[accountId] = {
            status: "blocked",
            reasonCode: "SAVE_DATA_INTEGRITY",
            source: "admin-manual-review",
            createdAt: Date.now(),
          };
          removeUserLeaderboardSubmissions(store, accountId);
          store.recordRuntimeIndexEvent?.({ type: "leaderboard-restriction", userId: accountId });
        } else if (action === "restore-leaderboard") {
          delete store.data.leaderboardModeration[accountId];
          removeUserLeaderboardSubmissions(store, accountId);
          const reviewRevisions = Object.fromEntries(SAVE_MODES.flatMap((mode) => {
            const revision = currentCloudSave(store, accountId, "main", mode)?.revision ?? 0;
            return revision > 0 ? [[mode, revision]] : [];
          }));
          const control = {
            ...(store.data.accountControls[accountId] ?? {}),
            source: "admin-manual-review",
            createdAt: Date.now(),
          };
          delete control.leaderboardResumeAfterRevision;
          delete control.leaderboardResumeAfterRevisionByMode;
          if (reviewRevisions.normal > 0) control.leaderboardResumeAfterRevision = reviewRevisions.normal;
          if (Object.keys(reviewRevisions).length > 0) control.leaderboardResumeAfterRevisionByMode = reviewRevisions;
          if (control.loginDisabledUntil || Object.keys(reviewRevisions).length > 0) store.data.accountControls[accountId] = control;
          else delete store.data.accountControls[accountId];
          store.recordRuntimeIndexEvent?.({ type: "leaderboard-restriction", userId: accountId });
          store.recordRuntimeIndexEvent?.({ type: "leaderboard-revalidation", userId: accountId });
        } else if (action === "delete-account") {
          const verifiedAt = Number(body.verifiedBackupAt);
          if (!runtime.lastBackupAt || verifiedAt !== runtime.lastBackupAt || Date.now() - runtime.lastBackupAt > 24 * 60 * 60 * 1_000) {
            return send(response, 409, { error: "彻底注销要求 24 小时内的已验证本机备份时间戳", code: "ADMIN_BACKUP_REQUIRED", lastBackupAt: runtime.lastBackupAt });
          }
          deleteAccountData(store, accountId);
        }
        appendAdminAudit(store, request, `admin.account_${action.replaceAll("-", "_")}`);
        await store.persist();
        return send(response, 200, { applied: true, action, account: action === "delete-account" ? null : adminAccountSummary(store, accountId) });
      }

      if (request.method === "POST" && url.pathname === "/api/analytics") {
        const result = recordAnalyticsBatch(store.data.analytics, await readJson(request), { timeZone: metricsTimeZone });
        if (!result.ok) return send(response, 400, { error: result.error });
        await store.persist({ operation: "analytics.record" });
        return send(response, 202, { accepted: true, duplicate: result.duplicate, day: result.day });
      }

      if (request.method === "POST" && url.pathname === "/api/presence") {
        const body = await readJson(request);
        const playerId = normalizedPlayerId(body.playerId);
        if (!playerId) return send(response, 400, { error: "匿名玩家标识格式无效" });
        const now = Date.now();
        const activeDay = metricDay(now, metricsTimeZone);
        const playerHash = sha256(`player:${playerId}`);
        let player = store.data.players[playerHash];
        let persistRequired = false;
        if (!player) {
          player = { firstSeenAt: now, lastSeenAt: now, lastActiveDay: activeDay };
          store.data.players[playerHash] = player;
          dayMetric.players += 1;
          persistRequired = true;
        } else {
          player.lastSeenAt = now;
          if (player.lastActiveDay !== activeDay) {
            player.lastActiveDay = activeDay;
            dayMetric.players += 1;
            persistRequired = true;
          }
        }
        store.recordRuntimeIndexEvent?.({ type: "presence", playerHash, seenAt: now });
        await store.persist({ operation: persistRequired ? "presence.update" : "presence.touch" });
        return send(response, 202, { accepted: true, players: presenceIndex.metrics(now) });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/register") {
        inspectSessionIssuance(request);
        const body = validateJsonDto(await readJson(request), ACCOUNT_JSON_SCHEMAS.register);
        const username = normalizedUsername(body.username);
        const displayName = normalizedName(body.displayName);
        const password = typeof body.password === "string" ? body.password : "";
        if (!username || !displayName || password.length < 8 || password.length > 128) return send(response, 400, { error: "用户名、名称或密码格式无效（用户名 4 至 24 位字母/数字/下划线，密码至少 8 位）" });
        if (Object.values(store.data.users).some((user) => user.username === username)) return send(response, 409, { error: "该用户名已注册" });
        const maximumRegistrations = Number.isFinite(registrationLimit) ? Math.max(1, Math.floor(registrationLimit)) : 3;
        if (!registrationRateLimit(`register:${ip}`, maximumRegistrations, 60 * 60 * 1000)) {
          return send(response, 429, { error: "该网络注册账号过于频繁，请一小时后再试", code: "REGISTRATION_RATE_LIMITED" }, { "retry-after": "3600" });
        }
        const credentials = await passwordRecord(password);
        if (Object.values(store.data.users).some((user) => user.username === username)) return send(response, 409, { error: "该用户名已注册" });
        const now = Date.now();
        const user = {
          id: `user_${randomUUID().replaceAll("-", "")}`,
          username,
          email: "",
          displayName,
          createdAt: now,
          emailVerifiedAt: null,
          passwordChangedAt: now,
          leaderboardVisible: true,
          ...credentials,
        };
        store.data.users[user.id] = user;
        const issued = issueSession(store, user.id, request, body.deviceName, body.deviceId);
        recordSuccessfulLogin(store.data, user.id, issued.context, { clientType: clientTypeForRequest(request), now });
        appendAudit(store, request, "account.register", user.id);
        await store.persist();
        const delivery = deliverIssuedSession(request, issued);
        return send(response, 201, {
          ...delivery.publicCredentials,
          user: publicUser(user),
          verificationRequired: false,
          mailAvailable: Boolean(accountMailer),
        }, delivery.headers);
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        inspectSessionIssuance(request);
        const rawLogin = await readJson(request);
        // A few pre-1.0 clients used `email`; normalize that one compatibility
        // alias, then apply the same strict allow-list before scrypt work.
        const loginKeys = rawLogin && typeof rawLogin === "object" && !Array.isArray(rawLogin) ? Object.keys(rawLogin) : [];
        if (loginKeys.some((key) => !["identifier", "email", "password", "deviceName", "deviceId"].includes(key))
          || rawLogin?.identifier !== undefined && rawLogin?.email !== undefined) {
          throw new HttpSecurityError("JSON_UNKNOWN_FIELD", "登录正文包含当前接口不支持或相互冲突的字段");
        }
        const body = validateJsonDto({
          identifier: rawLogin?.identifier ?? rawLogin?.email,
          password: rawLogin?.password,
          ...(rawLogin?.deviceName !== undefined ? { deviceName: rawLogin.deviceName } : {}),
          ...(rawLogin?.deviceId !== undefined ? { deviceId: rawLogin.deviceId } : {}),
        }, ACCOUNT_JSON_SCHEMAS.login);
        const identifier = body.identifier;
        const email = normalizedEmail(identifier);
        const username = normalizedUsername(identifier);
        const password = typeof body.password === "string" ? body.password : "";
        const networkHash = sha256(`login-network:${ip}`).slice(0, 16);
        const guard = loginFailureGuard.check(identifier ?? "", networkHash);
        if (guard.locked) {
          appendAudit(store, request, "account.login_temporarily_locked");
          await store.persist({ operation: "auth.login-denied" });
          return send(response, 429, { error: "登录失败次数过多，请稍后再试", code: "LOGIN_TEMPORARILY_LOCKED" }, { "retry-after": String(guard.retryAfterSeconds) });
        }
        const user = Object.values(store.data.users).find((candidate) => (email && candidate.email === email) || (username && candidate.username === username));
        if (!user || !(await passwordMatches(password, user))) {
          const failure = loginFailureGuard.fail(identifier ?? "", networkHash);
          appendAudit(store, request, failure.locked ? "account.login_temporarily_locked" : "account.login_failed", user?.id ?? null);
          await store.persist({ operation: "auth.login-failed" });
          return send(response, failure.locked ? 429 : 401, {
            error: failure.locked ? "登录失败次数过多，请稍后再试" : "用户名、邮箱或密码错误",
            ...(failure.locked ? { code: "LOGIN_TEMPORARILY_LOCKED" } : {}),
          }, failure.locked ? { "retry-after": String(failure.retryAfterSeconds) } : {});
        }
        if (loginDisabled(store.data, user.id)) {
          appendAudit(store, request, "account.login_disabled", user.id);
          await store.persist({ operation: "auth.login-disabled" });
          return send(response, 423, { error: "该账号已被临时限制登录，请联系管理员复核", code: "ACCOUNT_LOGIN_DISABLED" });
        }
        loginFailureGuard.success(identifier ?? "", networkHash);
        const issued = issueSession(store, user.id, request, body.deviceName, body.deviceId);
        const security = recordSuccessfulLogin(store.data, user.id, issued.context, { clientType: clientTypeForRequest(request) });
        appendAudit(store, request, "account.login", user.id);
        await store.persist();
        const delivery = deliverIssuedSession(request, issued);
        return send(response, 200, { ...delivery.publicCredentials, user: publicUser(user), security }, delivery.headers);
      }

      if (request.method === "POST" && url.pathname === "/api/auth/verify-email") {
        const body = validateJsonDto(await readJson(request), ACCOUNT_JSON_SCHEMAS.tokenOnly);
        const action = validActionToken(store.data.emailVerifications, body.token);
        if (!action) return send(response, 400, { error: "验证链接无效或已过期", code: "EMAIL_TOKEN_INVALID" });
        const user = store.data.users[action.record.userId];
        if (!user) return send(response, 400, { error: "验证链接无效或已过期", code: "EMAIL_TOKEN_INVALID" });
        user.emailVerifiedAt = Date.now();
        removeUserActionTokens(store, user.id);
        appendAudit(store, request, "account.email_verified", user.id);
        await store.persist();
        return send(response, 200, { verified: true, user: publicUser(user) });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/resend-verification") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录", code: "SESSION_EXPIRED" });
        if (Number.isFinite(auth.user.emailVerifiedAt)) return send(response, 200, { verified: true, user: publicUser(auth.user) });
        if (!normalizedEmail(auth.user.email)) return send(response, 400, { error: "请先绑定邮箱", code: "EMAIL_NOT_BOUND" });
        if (!accountMailer) return send(response, 503, { error: "邮件验证服务尚未配置", code: "EMAIL_SERVICE_UNAVAILABLE" });
        const verificationToken = issueActionToken(store.data.emailVerifications, auth.user.id);
        appendAudit(store, request, "account.verification_requested", auth.user.id);
        await store.persist();
        const delivered = await accountMailer({ kind: "verify", email: auth.user.email, actionToken: verificationToken });
        if (!delivered) return send(response, 502, { error: "验证邮件发送失败，请稍后重试", code: "EMAIL_DELIVERY_FAILED" });
        return send(response, 202, { sent: true });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/forgot-password") {
        if (!accountMailer) return send(response, 503, { error: "密码重置邮件服务尚未配置", code: "EMAIL_SERVICE_UNAVAILABLE" });
        const body = validateJsonDto(await readJson(request), ACCOUNT_JSON_SCHEMAS.emailOnly);
        const email = normalizedEmail(body.email);
        if (!email) return send(response, 400, { error: "邮箱格式无效" });
        const user = Object.values(store.data.users).find((candidate) => candidate.email === email);
        if (user && Number.isFinite(user.emailVerifiedAt)) {
          const resetToken = issueActionToken(store.data.passwordResets, user.id);
          appendAudit(store, request, "account.password_reset_requested", user.id);
          await store.persist();
          const delivered = await accountMailer({ kind: "reset", email: user.email, actionToken: resetToken });
          if (!delivered) return send(response, 503, { error: "密码重置邮件暂时无法发送，请稍后重试", code: "EMAIL_DELIVERY_FAILED" });
        }
        return send(response, 202, { accepted: true, message: "如果该邮箱已注册，重置链接会发送到邮箱" });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/reset-password") {
        inspectSessionIssuance(request);
        const body = validateJsonDto(await readJson(request), ACCOUNT_JSON_SCHEMAS.resetPassword);
        const password = typeof body.password === "string" ? body.password : "";
        if (password.length < 8 || password.length > 128) return send(response, 400, { error: "新密码必须为 8 至 128 位" });
        const action = validActionToken(store.data.passwordResets, body.token);
        if (!action) return send(response, 400, { error: "重置链接无效或已过期", code: "PASSWORD_TOKEN_INVALID" });
        const user = store.data.users[action.record.userId];
        if (!user) return send(response, 400, { error: "重置链接无效或已过期", code: "PASSWORD_TOKEN_INVALID" });
        Object.assign(user, await passwordRecord(password), { passwordChangedAt: Date.now() });
        revokeUserSessions(store, user.id);
        removeUserActionTokens(store, user.id);
        const issued = issueSession(store, user.id, request, body.deviceName, body.deviceId);
        const security = recordSuccessfulLogin(store.data, user.id, issued.context, { clientType: clientTypeForRequest(request) });
        appendAudit(store, request, "account.password_reset", user.id);
        await store.persist();
        const delivery = deliverIssuedSession(request, issued);
        return send(response, 200, { ...delivery.publicCredentials, user: publicUser(user), security }, delivery.headers);
      }

      if (request.method === "POST" && url.pathname === "/api/auth/web-session/migrate") {
        const policy = requireWebSessionPolicy();
        const credential = assertLegacyWebSessionMigrationRequest(request, policy);
        const auth = authenticateRequest(request);
        if (!auth || auth.credentialKind !== "bearer" || sha256(credential.token) !== auth.tokenHash) {
          return send(response, 401, { error: "旧 Web 会话已过期，请重新登录", code: "SESSION_EXPIRED" });
        }
        const delivery = createSessionDelivery(request, {
          sessionToken: credential.token,
          sessionExpiresAt: auth.session.expiresAt,
        }, policy);
        return send(response, 200, delivery.publicCredentials, delivery.headers);
      }

      if (request.method === "GET" && url.pathname === "/api/auth/web-session") {
        const policy = requireWebSessionPolicy();
        const credential = requireCookieSessionCredential(request, policy);
        const auth = authenticateRequest(request);
        if (!auth || auth.credentialKind !== "cookie") {
          return send(response, 401, { error: "Web 会话已过期", code: "SESSION_EXPIRED" });
        }
        return send(response, 200, { session: publicCookieSession(credential, auth.session.expiresAt) });
      }

      if (request.method === "GET" && url.pathname === "/api/account") {
        const auth = authenticateRequest(request);
        return auth ? send(response, 200, {
          user: publicUser(auth.user),
          cloudSave: cloudSaveMetadata(currentCloudSave(store, auth.user.id, "main", "normal"), "main", "normal"),
          cloudSaves: cloudSaveSlotMetadata(store, auth.user.id, "normal"),
          cloudSavesByMode: {
            normal: cloudSaveSlotMetadata(store, auth.user.id, "normal"),
            speedrun: cloudSaveSlotMetadata(store, auth.user.id, "speedrun"),
          },
          cloudQuota: cloudQuotaSnapshot(store.data, auth.user.id, quotaPolicy),
        }) : send(response, 401, { error: "登录已过期", code: "SESSION_EXPIRED" });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const auth = authenticateRequest(request);
        const credentialKind = webSessionPolicy
          ? inspectSessionCredential(request, webSessionPolicy).kind
          : "none";
        if (auth) {
          delete store.data.sessions[auth.tokenHash];
          appendAudit(store, request, "account.logout", auth.user.id);
          await store.persist();
        }
        return send(response, 200, { ok: true }, credentialKind === "cookie"
          ? { "set-cookie": clearWebSessionCookie(webSessionPolicy) }
          : {});
      }

      if (request.method === "GET" && url.pathname === "/api/account/sessions") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录", code: "SESSION_EXPIRED" });
        const sessions = Object.entries(store.data.sessions)
          .filter(([, session]) => session.userId === auth.user.id && session.expiresAt > Date.now())
          .sort(([, left], [, right]) => right.lastSeenAt - left.lastSeenAt)
          .map(([tokenHash, session]) => publicSession(session, auth.tokenHash, tokenHash));
        return send(response, 200, { sessions });
      }

      if (request.method === "GET" && url.pathname === "/api/account/security-events") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录", code: "SESSION_EXPIRED" });
        return send(response, 200, { events: publicLoginSecurityEvents(store.data, auth.user.id) });
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/operations/")) {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录", code: "SESSION_EXPIRED" });
        let requestId = "";
        try { requestId = decodeURIComponent(url.pathname.slice("/api/operations/".length)); } catch { /* handled below */ }
        if (!OPERATION_ID_PATTERN.test(requestId)) return send(response, 400, { error: "操作标识无效", code: "OPERATION_ID_INVALID" });
        const receipt = store.data.operationReceipts?.[requestId];
        if (!receipt || receipt.userId !== auth.user.id || receipt.expiresAt <= Date.now()) {
          return send(response, 404, { error: "操作记录不存在或已过期", code: "OPERATION_NOT_FOUND" });
        }
        return send(response, 200, { receipt: publicOperationReceipt(receipt) });
      }

      if (request.method === "POST" && url.pathname === "/api/account/sessions/revoke") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录", code: "SESSION_EXPIRED" });
        const body = validateJsonDto(await readJson(request), ACCOUNT_JSON_SCHEMAS.revokeSession);
        const target = Object.entries(store.data.sessions).find(([, session]) => session.userId === auth.user.id && session.id === body.sessionId);
        if (!target) return send(response, 404, { error: "会话不存在或已结束" });
        delete store.data.sessions[target[0]];
        appendAudit(store, request, "account.session_revoked", auth.user.id);
        await store.persist();
        const currentSessionRevoked = target[0] === auth.tokenHash;
        return send(response, 200, { revoked: true, currentSessionRevoked }, currentSessionRevoked && auth.credentialKind === "cookie"
          ? { "set-cookie": clearWebSessionCookie(webSessionPolicy) }
          : {});
      }

      if (request.method === "POST" && url.pathname === "/api/account/sessions/revoke-all") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录", code: "SESSION_EXPIRED" });
        const revokedCount = Object.values(store.data.sessions)
          .filter((session) => session.userId === auth.user.id)
          .length;
        revokeUserSessions(store, auth.user.id);
        appendAudit(store, request, "account.sessions_revoked_all", auth.user.id);
        await store.persist();
        return send(response, 200, { revoked: true, revokedCount, currentSessionRevoked: true }, auth.credentialKind === "cookie"
          ? { "set-cookie": clearWebSessionCookie(webSessionPolicy) }
          : {});
      }

      if (request.method === "POST" && url.pathname === "/api/account/password") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录", code: "SESSION_EXPIRED" });
        const body = validateJsonDto(await readJson(request), ACCOUNT_JSON_SCHEMAS.changePassword);
        const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
        const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
        if (!(await passwordMatches(currentPassword, auth.user))) return send(response, 401, { error: "当前密码错误", code: "CURRENT_PASSWORD_INVALID" });
        if (newPassword.length < 8 || newPassword.length > 128) return send(response, 400, { error: "新密码必须为 8 至 128 位" });
        Object.assign(auth.user, await passwordRecord(newPassword), { passwordChangedAt: Date.now() });
        revokeUserSessions(store, auth.user.id, auth.tokenHash);
        appendAudit(store, request, "account.password_changed", auth.user.id);
        await store.persist();
        return send(response, 200, { changed: true, user: publicUser(auth.user) });
      }

      if (request.method === "POST" && url.pathname === "/api/account/email") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        if (!accountMailer) return send(response, 503, { error: "邮件验证服务尚未配置", code: "EMAIL_SERVICE_UNAVAILABLE" });
        if (Number.isFinite(auth.user.emailVerifiedAt)) return send(response, 409, { error: "当前账号已经绑定并验证邮箱" });
        const body = validateJsonDto(await readJson(request), ACCOUNT_JSON_SCHEMAS.emailOnly);
        const email = normalizedEmail(body.email);
        if (!email) return send(response, 400, { error: "邮箱格式无效" });
        if (Object.values(store.data.users).some((user) => user.id !== auth.user.id && user.email === email)) {
          return send(response, 409, { error: "该邮箱已绑定其他账号" });
        }
        auth.user.email = email;
        auth.user.emailVerifiedAt = null;
        removeUserActionTokens(store, auth.user.id);
        const verificationToken = issueActionToken(store.data.emailVerifications, auth.user.id);
        appendAudit(store, request, "account.email_bound", auth.user.id);
        await store.persist();
        const delivered = await accountMailer({ kind: "verify", email, actionToken: verificationToken });
        if (!delivered) return send(response, 502, { error: "邮箱已绑定，但验证邮件发送失败；请稍后重发", code: "EMAIL_DELIVERY_FAILED", user: publicUser(auth.user) });
        return send(response, 202, { sent: true, user: publicUser(auth.user) });
      }

      if (request.method === "GET" && url.pathname === "/api/account/export") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const userId = auth.user.id;
        const currentMainSave = currentCloudSave(store, userId, "main", "normal");
        const materializedMainSave = materializeCloudSave(store, userId, "main", currentMainSave, "normal");
        const manualSlots = materializeManualCloudSaveSlots(store, userId, "normal");
        const manualHistory = materializeManualCloudSaveHistory(store, userId, "normal");
        const currentSpeedrunSave = currentCloudSave(store, userId, "main", "speedrun");
        const materializedSpeedrunSave = materializeCloudSave(store, userId, "main", currentSpeedrunSave, "speedrun");
        const speedrunSlots = materializeManualCloudSaveSlots(store, userId, "speedrun");
        const speedrunHistory = materializeManualCloudSaveHistory(store, userId, "speedrun");
        if ((currentMainSave && !materializedMainSave)
          || (currentSpeedrunSave && !materializedSpeedrunSave)
          || Object.values(manualSlots).some((save) => !save)
          || Object.values(manualHistory).some((history) => history.some((save) => !save))
          || Object.values(speedrunSlots).some((save) => !save)
          || Object.values(speedrunHistory).some((history) => history.some((save) => !save))) {
          return send(response, 500, { error: "云存档正文缺失，账号数据导出已停止", code: "CLOUD_SAVE_PAYLOAD_MISSING" });
        }
        const submissions = Object.values(store.data.submissions).filter((entry) => entry.userId === userId);
        const feedback = store.data.feedback.filter((entry) => entry.userId === userId).map(({ ipHash: _ipHash, ...entry }) => entry);
        const errors = store.data.errors.filter((entry) => entry.userId === userId).map(({ ipHash: _ipHash, ...entry }) => entry);
        appendAudit(store, request, "account.data_exported", userId);
        await store.persist();
        return send(response, 200, {
          exportedAt: Date.now(),
          schemaVersion: DEFAULT_DATA.schemaVersion,
          user: publicUser(auth.user),
          cloudSave: materializedMainSave,
          cloudSaveHistory: [...saveHistory(store, userId, "main", "normal")].reverse().map((save) => cloudSaveMetadata(save, "main", "normal")),
          cloudSaveSlots: manualSlots,
          cloudSaveSlotHistory: manualHistory,
          cloudSavesByMode: {
            normal: { main: materializedMainSave, slots: manualSlots },
            speedrun: { main: materializedSpeedrunSave, slots: speedrunSlots },
          },
          cloudSaveHistoriesByMode: {
            normal: { main: [...saveHistory(store, userId, "main", "normal")].reverse().map((save) => cloudSaveMetadata(save, "main", "normal")), slots: manualHistory },
            speedrun: { main: [...saveHistory(store, userId, "main", "speedrun")].reverse().map((save) => cloudSaveMetadata(save, "main", "speedrun")), slots: speedrunHistory },
          },
          submissions,
          feedback,
          errors,
        }, { "content-disposition": `attachment; filename="dsp-account-${userId}.json"` });
      }

      if (request.method === "GET" && url.pathname === "/api/account/export/archive") {
        const initialAuth = authenticateRequest(request);
        if (!initialAuth) return send(response, 401, { error: "请先登录" });
        const prepared = await store.runAtomic(async () => {
          const auth = authenticateRequest(request);
          if (!auth || auth.user.id !== initialAuth.user.id) {
            const error = new Error("登录已过期");
            error.statusCode = 401;
            throw error;
          }
          const userId = auth.user.id;
          const exportedAt = Date.now();
          const snapshot = store.createCloudArchiveSnapshot();
          try {
            const archiveInput = {
              exportedAt,
              schemaVersion: DEFAULT_DATA.schemaVersion,
              accountData: accountArchiveMetadata(store, userId, exportedAt),
              saves: accountArchiveSaveEntries(store, userId, snapshot),
            };
            appendAudit(store, request, "account.archive_exported", userId);
            await store.persist({ operation: "account.archive-export" });
            return { userId, exportedAt, snapshot, archiveInput };
          } catch (error) {
            snapshot.close();
            throw error;
          }
        });
        return sendAccountArchive(
          response,
          request,
          prepared.archiveInput,
          `dsp-account-${prepared.userId}-${prepared.exportedAt}.dspaccount.zip`,
          prepared.snapshot,
        );
      }

      if (request.method === "GET" && url.pathname === "/api/account/import/archive") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const guard = currentAccountArchiveImportGuard(store, auth.user.id);
        response.setHeader("cache-control", "private, no-store");
        return send(response, 200, {
          import: {
            version: 1,
            guard,
            confirmation: accountArchiveImportConfirmation(guard),
            replaces: { modes: [...SAVE_MODES], slots: [...CLOUD_SAVE_SLOTS] },
            preserves: ["account_identity", "sessions", "account_controls", "leaderboard_submissions", "speedrun_submissions"],
          },
          cloudQuota: cloudQuotaSnapshot(store.data, auth.user.id, quotaPolicy),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/account/import/archive") {
        const initialAuth = authenticateRequest(request);
        if (!initialAuth) return send(response, 401, { error: "请先登录" });
        const expectedGuard = typeof request.headers[ACCOUNT_ARCHIVE_IMPORT_GUARD_HEADER] === "string"
          ? request.headers[ACCOUNT_ARCHIVE_IMPORT_GUARD_HEADER]
          : "";
        const confirmation = typeof request.headers[ACCOUNT_ARCHIVE_IMPORT_CONFIRMATION_HEADER] === "string"
          ? request.headers[ACCOUNT_ARCHIVE_IMPORT_CONFIRMATION_HEADER]
          : "";
        if (!/^[a-f0-9]{64}$/.test(expectedGuard) || confirmation !== accountArchiveImportConfirmation(expectedGuard)) {
          return send(response, 400, { error: "账号归档导入确认文字或云状态 guard 无效", code: "ACCOUNT_ARCHIVE_IMPORT_CONFIRMATION_INVALID" });
        }
        const openingGuard = currentAccountArchiveImportGuard(store, initialAuth.user.id);
        if (openingGuard !== expectedGuard) {
          runtime.cloudConflicts += 1;
          return send(response, 409, {
            error: "云存档在导入开始前已变化，请重新确认；现有云存档未修改",
            code: "ACCOUNT_ARCHIVE_IMPORT_GUARD_CONFLICT",
            guard: openingGuard,
          });
        }
        const disconnect = new AbortController();
        const onAborted = () => disconnect.abort();
        const onResponseClose = () => {
          if (!response.writableEnded) disconnect.abort();
        };
        request.once("aborted", onAborted);
        response.once("close", onResponseClose);
        let received;
        try {
          received = await receiveAccountArchiveRequest(request, {
            signal: disconnect.signal,
            maximumBytes: maximumAccountArchiveImportBytes(quotaPolicy),
            ...(accountArchiveTemporaryRoot ? { temporaryRoot: accountArchiveTemporaryRoot } : {}),
          });
          const prepared = await prepareAccountArchiveImport(received.archiveFile, {
            signal: disconnect.signal,
            workspaceDirectory: received.directory,
            maximumArchiveBytes: maximumAccountArchiveImportBytes(quotaPolicy),
            maximumPayloadBytes: quotaPolicy.revisionBytes,
            quotaPolicy,
            inspectPayload: accountArchivePayloadInspector,
          });
          if (prepared.source.accountId !== initialAuth.user.id) {
            await received.cleanup();
            received = null;
            return send(response, 409, {
              error: "账号归档属于其他账号；不能导入当前账号，现有云存档未修改",
              code: "ACCOUNT_ARCHIVE_ACCOUNT_MISMATCH",
            });
          }
          const result = await store.runAtomic(async () => {
            const auth = authenticateRequest(request);
            if (!auth || auth.user.id !== initialAuth.user.id) {
              const error = new Error("登录已过期，现有云存档未修改");
              error.statusCode = 401;
              error.code = "ACCOUNT_ARCHIVE_IMPORT_AUTH_CHANGED";
              throw error;
            }
            const actualGuard = currentAccountArchiveImportGuard(store, auth.user.id);
            if (actualGuard !== expectedGuard) {
              const error = new Error("归档校验期间云存档已变化，服务器保留双方；请重新确认");
              error.statusCode = 409;
              error.code = "ACCOUNT_ARCHIVE_IMPORT_GUARD_CONFLICT";
              error.guard = actualGuard;
              throw error;
            }
            if (disconnect.signal.aborted) {
              const error = new Error("账号归档导入已取消，现有云存档未修改");
              error.statusCode = 499;
              error.code = "ACCOUNT_ARCHIVE_IMPORT_ABORTED";
              throw error;
            }
            installAccountArchiveCloudSaves(store, auth.user.id, prepared.refs);
            appendAudit(store, request, "account.archive_imported", auth.user.id);
            await store.persist({ operation: "account.archive-import" });
            return {
              imported: true,
              revisionCount: prepared.refs.length,
              logicalBytes: prepared.quota.logicalBytes,
              guard: currentAccountArchiveImportGuard(store, auth.user.id),
              modes: Object.fromEntries(SAVE_MODES.map((mode) => [mode, cloudSaveSlotMetadata(store, auth.user.id, mode)])),
              leaderboardRevalidationRequired: {
                normal: leaderboardRevalidationThresholds(store.data, auth.user.id).normal > 0,
                speedrun: leaderboardRevalidationThresholds(store.data, auth.user.id).speedrun > 0,
              },
            };
          });
          await received.cleanup();
          received = null;
          return send(response, 200, result);
        } finally {
          request.removeListener("aborted", onAborted);
          response.removeListener("close", onResponseClose);
          await received?.cleanup().catch(() => undefined);
        }
      }

      if (request.method === "POST" && url.pathname === "/api/account/import/legacy-json") {
        const initialAuth = authenticateRequest(request);
        if (!initialAuth) return send(response, 401, { error: "请先登录", code: "SESSION_EXPIRED" });
        const expectedGuard = typeof request.headers[ACCOUNT_ARCHIVE_IMPORT_GUARD_HEADER] === "string"
          ? request.headers[ACCOUNT_ARCHIVE_IMPORT_GUARD_HEADER]
          : "";
        const confirmation = typeof request.headers[ACCOUNT_ARCHIVE_IMPORT_CONFIRMATION_HEADER] === "string"
          ? request.headers[ACCOUNT_ARCHIVE_IMPORT_CONFIRMATION_HEADER]
          : "";
        if (!/^[a-f0-9]{64}$/.test(expectedGuard) || confirmation !== accountArchiveImportConfirmation(expectedGuard)) {
          return send(response, 400, {
            error: "旧版 JSON 账号导入确认文字或云状态 guard 无效",
            code: "ACCOUNT_ARCHIVE_IMPORT_CONFIRMATION_INVALID",
          });
        }
        const openingGuard = currentAccountArchiveImportGuard(store, initialAuth.user.id);
        if (openingGuard !== expectedGuard) {
          runtime.cloudConflicts += 1;
          return send(response, 409, {
            error: "云存档在导入开始前已变化，请重新确认；现有云存档未修改",
            code: "ACCOUNT_ARCHIVE_IMPORT_GUARD_CONFLICT",
            guard: openingGuard,
          });
        }
        const raw = await readRawRequest(request);
        const prepared = await prepareLegacyJsonAccountImport(raw, {
          expectedAccountId: initialAuth.user.id,
          maximumBytes: request.httpSecurity.body.maximumBytes,
          quotaPolicy,
          inspectPayload: async (record) => {
            const descriptor = {
              direct: true,
              expectedRevision: 0,
              requestId: null,
              declaredOriginalBytes: record.size,
              payloadLimit: quotaPolicy.revisionBytes,
            };
            return inspectDecodedCloudSaveUpload(Buffer.from(record.payload, "utf8"), descriptor);
          },
        });
        const result = await store.runAtomic(async () => {
          const auth = authenticateRequest(request);
          if (!auth || auth.user.id !== initialAuth.user.id) {
            const error = new Error("登录已过期，现有云存档未修改");
            error.statusCode = 401;
            error.code = "ACCOUNT_ARCHIVE_IMPORT_AUTH_CHANGED";
            throw error;
          }
          const actualGuard = currentAccountArchiveImportGuard(store, auth.user.id);
          if (actualGuard !== expectedGuard) {
            const error = new Error("旧版 JSON 校验期间云存档已变化，服务器保留双方；请重新确认");
            error.statusCode = 409;
            error.code = "ACCOUNT_ARCHIVE_IMPORT_GUARD_CONFLICT";
            error.guard = actualGuard;
            throw error;
          }
          installAccountArchiveCloudSaves(store, auth.user.id, prepared.refs);
          appendAudit(store, request, "account.legacy_json_imported", auth.user.id);
          await store.persist({ operation: "account.legacy-json-import" });
          return {
            imported: true,
            format: prepared.format,
            revisionCount: prepared.refs.length,
            logicalBytes: prepared.quota.logicalBytes,
            ignoredMetadataOnlyHistoryRevisions: prepared.redundantHistoryRevisions,
            guard: currentAccountArchiveImportGuard(store, auth.user.id),
            modes: Object.fromEntries(SAVE_MODES.map((mode) => [mode, cloudSaveSlotMetadata(store, auth.user.id, mode)])),
            leaderboardRevalidationRequired: {
              normal: leaderboardRevalidationThresholds(store.data, auth.user.id).normal > 0,
              speedrun: leaderboardRevalidationThresholds(store.data, auth.user.id).speedrun > 0,
            },
          };
        });
        return send(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/api/account/delete") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const body = validateJsonDto(await readJson(request), ACCOUNT_JSON_SCHEMAS.deleteAccount);
        if (body.confirmation !== "DELETE" || !(await passwordMatches(typeof body.password === "string" ? body.password : "", auth.user))) {
          return send(response, 400, { error: "密码或注销确认文字不正确" });
        }
        const userId = auth.user.id;
        appendAudit(store, request, "account.deleted", userId);
        deleteAccountData(store, userId);
        await store.persist();
        return send(response, 200, { deleted: true }, auth.credentialKind === "cookie"
          ? { "set-cookie": clearWebSessionCookie(webSessionPolicy) }
          : {});
      }

      if (request.method === "GET" && url.pathname === "/api/cloud-save/history") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const slot = normalizedCloudSaveSlot(url.searchParams.get("slot") ?? "main");
        const requestedMode = normalizedCloudSaveMode(url.searchParams.get("mode") ?? "normal");
        const mode = requestedMode;
        if (!slot) return send(response, 400, { error: "云存档槽位无效" });
        if (!mode) return send(response, 400, { error: "云存档模式无效", code: "SAVE_MODE_INVALID" });
        const history = [...saveHistory(store, auth.user.id, slot, mode)].reverse().map((save) => cloudSaveMetadata(save, slot, mode));
        return send(response, 200, { history, mode, slot });
      }

      if (request.method === "GET" && url.pathname === "/api/cloud-save/quota") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        return send(response, 200, {
          cloudQuota: cloudQuotaSnapshot(store.data, auth.user.id, quotaPolicy),
          transferLimits: {
            guaranteedSavePayloadBytes: cloudTransferContract.guaranteedSavePayloadBytes,
            savePayloadLimitBytes: cloudTransferContract.savePayloadLimitBytes,
            rawFallbackSafeLimitBytes: cloudTransferContract.rawFallbackSafeLimitBytes,
            requestCompressedLimitBytes: cloudTransferContract.requestCompressedLimitBytes,
            requestExpandedLimitBytes: cloudTransferContract.requestExpandedLimitBytes,
            compression: ["gzip"],
            chunkedUpload: false,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/cloud-save/quota") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const body = await readJson(request);
        const slot = normalizedCloudSaveSlot(body.slot ?? "main");
        const mode = normalizedCloudSaveMode(body.mode ?? "normal");
        const size = Number(body.size);
        const checksum = typeof body.checksum === "string" && /^[a-f0-9]{64}$/.test(body.checksum) ? body.checksum : null;
        if (!slot) return send(response, 400, { error: "云存档槽位无效", code: "CLOUD_QUOTA_TARGET_INVALID" });
        if (!mode) return send(response, 400, { error: "云存档模式无效", code: "SAVE_MODE_INVALID" });
        if (!Number.isSafeInteger(size) || size < 0 || size > cloudTransferContract.savePayloadLimitBytes || (body.checksum != null && !checksum)) {
          return send(response, size > cloudTransferContract.savePayloadLimitBytes ? 413 : 400, {
            error: size > cloudTransferContract.savePayloadLimitBytes
              ? "云存档容量预检发现单修订超过服务端上限；正文尚未发送"
              : "云存档容量预检参数无效",
            code: size > cloudTransferContract.savePayloadLimitBytes ? "SAVE_SIZE_TOO_LARGE" : "CLOUD_QUOTA_INPUT_INVALID",
            ...(Number.isSafeInteger(size) && size >= 0 ? {
              originalBytes: size,
              expandedBytes: size,
              payloadLimitBytes: cloudTransferContract.savePayloadLimitBytes,
              expandedLimitBytes: cloudTransferContract.requestExpandedLimitBytes,
              compressedLimitBytes: cloudTransferContract.requestCompressedLimitBytes,
              overBytes: Math.max(0, size - cloudTransferContract.savePayloadLimitBytes),
            } : {}),
          });
        }
        const plan = planCloudSaveUpload(store.data, auth.user.id, mode, slot, { size, checksum }, quotaPolicy);
        return send(response, 200, { plan: publicCloudQuotaPlan(plan) });
      }

      if (request.method === "GET" && url.pathname === "/api/cloud-save") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const slot = normalizedCloudSaveSlot(url.searchParams.get("slot") ?? "main");
        const mode = normalizedCloudSaveMode(url.searchParams.get("mode") ?? "normal");
        if (!slot) return send(response, 400, { error: "云存档槽位无效" });
        if (!mode) return send(response, 400, { error: "云存档模式无效", code: "SAVE_MODE_INVALID" });
        const requestedRevision = Number(url.searchParams.get("revision"));
        let effectiveMode = mode;
        let save = Number.isInteger(requestedRevision) && requestedRevision > 0
          ? saveHistory(store, auth.user.id, slot, mode).find((entry) => entry.revision === requestedRevision)
          : currentCloudSave(store, auth.user.id, slot, mode);
        if (!save && mode === "normal" && url.searchParams.get("mode") === null) {
          save = legacyCloudSaveFallback(store, auth.user.id, slot);
          if (save) effectiveMode = "speedrun";
        }
        const materialized = materializeCloudSave(store, auth.user.id, slot, save, effectiveMode);
        if (save && !materialized) return send(response, 500, { error: "云存档正文缺失，请联系管理员恢复备份", code: "CLOUD_SAVE_PAYLOAD_MISSING" });
        return sendCloudSaveDownload(response, materialized, effectiveMode, slot);
      }

      if (request.method === "DELETE" && url.pathname === "/api/cloud-save") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const slot = normalizedCloudSaveSlot(url.searchParams.get("slot") ?? "main");
        const mode = normalizedCloudSaveMode(url.searchParams.get("mode") ?? "normal");
        if (!slot) return send(response, 400, { error: "云存档槽位无效" });
        if (!mode) return send(response, 400, { error: "云存档模式无效", code: "SAVE_MODE_INVALID" });
        const body = await readJson(request);
        if (body.confirmation !== `DELETE_CLOUD_SAVE:${mode}:${slot}`) {
          return send(response, 400, { error: "云存档删除确认文字不正确", code: "CLOUD_SAVE_DELETE_CONFIRMATION_INVALID" });
        }
        const current = currentCloudSave(store, auth.user.id, slot, mode);
        if (!current) return send(response, 404, { error: "目标云存档不存在", code: "CLOUD_SAVE_NOT_FOUND", mode, slot });
        const expectedRevision = Number.isInteger(body.expectedRevision) ? body.expectedRevision : 0;
        if (current.revision !== expectedRevision) {
          runtime.cloudConflicts += 1;
          return send(response, 409, { error: "云端已有更新版本，请刷新后再删除", code: "CLOUD_SAVE_REVISION_CONFLICT", cloudSave: cloudSaveMetadata(current, slot, mode) });
        }
        const deleted = deleteCloudSaveData(store, auth.user.id, slot, mode);
        appendAudit(store, request, "cloud.save_deleted", auth.user.id);
        await store.persist();
        return send(response, 200, { deleted: true, mode, slot, revision: current.revision, deletedRevisions: deleted.deletedRevisions });
      }

      if (request.method === "PUT" && url.pathname === "/api/cloud-save") {
        const preparedUpload = request.preparedCloudUpload;
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const slot = normalizedCloudSaveSlot(url.searchParams.get("slot") ?? "main");
        const mode = normalizedCloudSaveMode(url.searchParams.get("mode") ?? "normal");
        if (!slot) return send(response, 400, { error: "云存档槽位无效" });
        if (!mode) return send(response, 400, { error: "云存档模式无效", code: "SAVE_MODE_INVALID" });
        if (nodeHealthStatusFile) {
          const infrastructure = await nodeHealthStatus(nodeHealthStatusFile);
          if (typeof infrastructure?.disk?.freeRatio === "number" && infrastructure.disk.freeRatio <= 0.1) {
            return send(response, 507, { error: "云节点磁盘已达到 90% 保护阈值，上传暂时停止；本地存档未修改", code: "STORAGE_PROTECTION_ACTIVE" });
          }
        }
        if (!preparedUpload) return { deferredCloudUpload: true };
        const body = preparedUpload?.body;
        if (!body) {
          const error = new Error("云存档上传尚未完成检查");
          error.statusCode = 503;
          error.code = "UPLOAD_INSPECTION_FAILED";
          error.retryAfterSeconds = 1;
          throw error;
        }
        const payloadMode = body.payloadMode;
        const validPayload = body.validPayload;
        const legacyImplicitSpeedrun = url.searchParams.get("mode") === null && body.legacyImplicitSpeedrun;
        const effectiveMode = legacyImplicitSpeedrun ? "speedrun" : mode;
        const validationFailure = cloudUploadValidationFailure(body, effectiveMode);
        if (validationFailure) {
          uploadInspections.recordRejection(validationFailure.code);
          return sendCloudUploadValidationFailure(response, validationFailure);
        }
        const payloadChecksum = body.payloadChecksum;
        const payloadSize = body.payloadSize;
        const operationFingerprint = body.requestId ? cloudPutOperationFingerprint({
          userId: auth.user.id,
          mode: effectiveMode,
          slot,
          expectedRevision: body.expectedRevision,
          payloadChecksum,
          payloadSize,
        }) : null;
        let previousReceipt = body.requestId ? store.data.operationReceipts?.[body.requestId] : null;
        if (previousReceipt && previousReceipt.expiresAt <= Date.now()) {
          delete store.data.operationReceipts[body.requestId];
          previousReceipt = null;
        }
        if (previousReceipt) {
          if (previousReceipt.userId !== auth.user.id || previousReceipt.fingerprint !== operationFingerprint) {
            return send(response, 409, { error: "同一操作标识已用于不同请求", code: "OPERATION_ID_CONFLICT" });
          }
          return send(response, 200, previousReceipt.result);
        }
        const currentModeSave = currentCloudSave(store, auth.user.id, slot, effectiveMode);
        const current = currentModeSave ?? (effectiveMode === "normal" && url.searchParams.get("mode") === null
          ? legacyCloudSaveFallback(store, auth.user.id, slot)
          : null);
        const expectedRevision = Number.isInteger(body.expectedRevision) ? body.expectedRevision : 0;
        if ((current?.revision ?? 0) !== expectedRevision) {
          runtime.cloudConflicts += 1;
          return send(response, 409, { error: "云端已有更新版本，请先下载或确认覆盖", cloudSave: cloudSaveMetadata(current, slot, effectiveMode) });
        }
        const quotaPlan = planCloudSaveUpload(store.data, auth.user.id, effectiveMode, slot, {
          size: payloadSize,
          checksum: payloadChecksum,
        }, quotaPolicy);
        if (!quotaPlan.accepted) {
          return send(response, quotaPlan.reason === "revisionBytes" ? 413 : 507, {
            error: quotaPlan.reason === "revisionBytes"
              ? "单个云存档修订超过容量上限，本地存档未修改"
              : "当前云存档配额不足；服务器没有删除其他模式或槽位，本地存档未修改",
            code: quotaPlan.code,
            plan: publicCloudQuotaPlan(quotaPlan),
            originalBytes: payloadSize,
            expandedBytes: payloadSize,
            payloadLimitBytes: quotaPolicy.revisionBytes,
            expandedLimitBytes: cloudTransferContract.requestExpandedLimitBytes,
            compressedLimitBytes: cloudTransferContract.requestCompressedLimitBytes,
            overBytes: Math.max(0, payloadSize - quotaPolicy.revisionBytes),
          });
        }
        const pruned = pruneCloudSaveRevisions(store, auth.user.id, slot, effectiveMode, quotaPlan.prune.revisions);
        const next = {
          revision: (current?.revision ?? 0) + 1,
          payload: body.payload,
          checksum: payloadChecksum,
          size: payloadSize,
          updatedAt: Date.now(),
          summary: body.summary,
          ...(legacyImplicitSpeedrun ? { legacyMode: true } : {}),
        };
        appendSaveRevision(store, auth.user.id, next, slot, effectiveMode);
        if (slot === "main") {
          const revalidationCleared = clearLeaderboardRevalidationIfSatisfied(store.data, auth.user.id, next.revision, effectiveMode);
          if (revalidationCleared && effectiveMode === "normal") store.recordRuntimeIndexEvent?.({ type: "leaderboard-revalidation", userId: auth.user.id });
          if (effectiveMode === "normal") updateLeaderboardFromMainSave(store, auth.user.id, {
            save: next,
            inspection: publicUploadInspection(body),
          });
        }
        dayMetric.cloudUploads += 1;
        const metadata = cloudSaveMetadata(next, slot, effectiveMode);
        recordCloudPutOperationReceipt(store.data, {
          requestId: body.requestId,
          userId: auth.user.id,
          mode: effectiveMode,
          slot,
          expectedRevision,
          fingerprint: operationFingerprint,
          cloudSave: metadata,
        });
        if (pruned.revisionCount > 0) appendAudit(store, request, "cloud.history_pruned_for_quota", auth.user.id);
        await store.persist();
        return send(response, 200, { cloudSave: metadata });
      }

      if (request.method === "POST" && url.pathname === "/api/cloud-save/restore") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const slot = normalizedCloudSaveSlot(url.searchParams.get("slot") ?? "main");
        const mode = normalizedCloudSaveMode(url.searchParams.get("mode") ?? "normal");
        if (!slot) return send(response, 400, { error: "云存档槽位无效" });
        if (!mode) return send(response, 400, { error: "云存档模式无效", code: "SAVE_MODE_INVALID" });
        const body = await readJson(request);
        const current = currentCloudSave(store, auth.user.id, slot, mode);
        const expectedRevision = Number.isInteger(body.expectedRevision) ? body.expectedRevision : 0;
        if ((current?.revision ?? 0) !== expectedRevision) {
          runtime.cloudConflicts += 1;
          return send(response, 409, { error: "云端已有更新版本，请刷新历史记录", cloudSave: cloudSaveMetadata(current, slot, mode) });
        }
        const sourceRevision = Number(body.revision);
        const source = saveHistory(store, auth.user.id, slot, mode).find((entry) => entry.revision === sourceRevision);
        if (!source) return send(response, 404, { error: "历史修订不存在或已过期" });
        const materializedSource = materializeCloudSave(store, auth.user.id, slot, source, mode);
        if (!materializedSource) return send(response, 500, { error: "历史云存档正文缺失，无法恢复", code: "CLOUD_SAVE_PAYLOAD_MISSING" });
        const quotaPlan = planCloudSaveUpload(store.data, auth.user.id, mode, slot, {
          size: materializedSource.size,
          checksum: materializedSource.checksum,
        }, quotaPolicy);
        if (!quotaPlan.accepted) {
          return send(response, quotaPlan.reason === "revisionBytes" ? 413 : 507, {
            error: quotaPlan.reason === "revisionBytes"
              ? "待恢复的云存档修订超过容量上限，现有云存档未修改"
              : "当前云存档配额不足；历史恢复未执行，其他模式和槽位未修改",
            code: quotaPlan.code,
            plan: publicCloudQuotaPlan(quotaPlan),
          });
        }
        const pruned = pruneCloudSaveRevisions(store, auth.user.id, slot, mode, quotaPlan.prune.revisions);
        const restored = {
          ...materializedSource,
          revision: (current?.revision ?? 0) + 1,
          updatedAt: Date.now(),
          restoredFromRevision: sourceRevision,
        };
        appendSaveRevision(store, auth.user.id, restored, slot, mode);
        if (slot === "main") {
          const revalidationCleared = clearLeaderboardRevalidationIfSatisfied(store.data, auth.user.id, restored.revision, mode);
          if (revalidationCleared && mode === "normal") store.recordRuntimeIndexEvent?.({ type: "leaderboard-revalidation", userId: auth.user.id });
          if (mode === "normal") updateLeaderboardFromMainSave(store, auth.user.id, { save: restored });
        }
        dayMetric.cloudUploads += 1;
        appendAudit(store, request, "cloud.revision_restored", auth.user.id);
        if (pruned.revisionCount > 0) appendAudit(store, request, "cloud.history_pruned_for_quota", auth.user.id);
        await store.persist();
        return send(response, 200, { cloudSave: cloudSaveMetadata(restored, slot, mode) });
      }

      if (request.method === "GET" && url.pathname === "/api/speedrun/leaderboard") {
        const targetId = url.searchParams.get("targetId");
        const seasonId = url.searchParams.get("seasonId") || ACTIVE_LEADERBOARD_SEASON_ID;
        if (!targetId || !Object.hasOwn(SPEEDRUN_TARGETS, targetId)) return send(response, 400, { error: "速通目标无效", code: "SPEEDRUN_TARGET_INVALID" });
        if (seasonId !== ACTIVE_LEADERBOARD_SEASON_ID) return send(response, 409, { error: "历史速通赛季已封存", code: "SPEEDRUN_SEASON_CLOSED" });
        const bestByUser = new Map();
        for (const entry of Object.values(store.data.speedrunSubmissions)) {
          if (entry.targetId !== targetId || entry.seasonId !== seasonId || entry.verified !== true ||
            store.data.users[entry.userId]?.leaderboardVisible === false || isLeaderboardRestricted(store.data, entry.userId)) continue;
          const key = entry.userId;
          const previous = bestByUser.get(key);
          if (!previous || entry.elapsedSeconds < previous.elapsedSeconds || entry.elapsedSeconds === previous.elapsedSeconds && entry.receivedAt < previous.receivedAt) bestByUser.set(key, entry);
        }
        const entries = [...bestByUser.values()]
          .sort((left, right) => left.elapsedSeconds - right.elapsedSeconds || left.receivedAt - right.receivedAt || left.submissionId.localeCompare(right.submissionId))
          .slice(0, 100)
          .map((entry, index) => ({ ...entry, rank: index + 1 }));
        return send(response, 200, projectPublicSpeedrunLeaderboard({
          category: SPEEDRUN_TARGETS[targetId].category,
          targetId,
          seasonId,
          rulesetVersion: SPEEDRUN_RULESET_VERSION,
          entries,
          generatedAt: Date.now(),
        }, { publicIdFor: leaderboardPublicId }));
      }

      if (request.method === "POST" && url.pathname === "/api/speedrun/submit") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        if (isLeaderboardRestricted(store.data, auth.user.id) || leaderboardRevalidationRequired(
          store.data,
          auth.user.id,
          currentCloudSave(store, auth.user.id, "main", "speedrun")?.revision,
          "speedrun",
        )) {
          return send(response, 403, { error: "当前账号暂时不能加入官方排行榜", code: LEADERBOARD_RESTRICTED_CODE });
        }
        if (auth.user.leaderboardVisible === false) return send(response, 409, { error: "当前账号已退出公开排行榜", code: "SPEEDRUN_VISIBILITY_DISABLED" });
        const body = await readJson(request);
        const result = submitSpeedrunResult(store, auth.user, body);
        if (result.error) return send(response, result.status ?? 422, { error: result.error, code: result.code, ...(result.cloudSave ? { cloudSave: result.cloudSave } : {}) });
        await store.persist();
        return send(response, 200, { entry: result.entry, verified: true, idempotent: result.idempotent === true, category: SPEEDRUN_TARGETS[result.entry.targetId].category });
      }

      if (request.method === "POST" && url.pathname === "/api/leaderboard/visibility") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const body = await readJson(request);
        if (typeof body.visible !== "boolean") return send(response, 400, { error: "排行榜可见性设置无效" });
        if (body.visible && isLeaderboardRestricted(store.data, auth.user.id)) {
          return send(response, 403, { error: "当前账号暂时不能加入官方排行榜", code: LEADERBOARD_RESTRICTED_CODE });
        }
        auth.user.leaderboardVisible = body.visible;
        store.recordRuntimeIndexEvent?.({ type: "leaderboard-visibility", userId: auth.user.id });
        const result = body.visible
          ? updateLeaderboardFromMainSave(store, auth.user.id, { force: true })
          : { changed: removeUserLeaderboardSubmissions(store, auth.user.id) > 0, submission: null, reason: "hidden" };
        appendAudit(store, request, body.visible ? "leaderboard.visibility_enabled" : "leaderboard.visibility_disabled", auth.user.id);
        await store.persist();
        return send(response, 200, {
          visible: body.visible,
          user: publicUser(auth.user),
          submission: result.submission,
          autoJoined: Boolean(result.submission),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/leaderboard") {
        const category = VALID_CATEGORIES.has(url.searchParams.get("category")) ? url.searchParams.get("category") : "galaxy";
        const seasonId = VALID_SEASONS.has(url.searchParams.get("seasonId")) ? url.searchParams.get("seasonId") : ACTIVE_LEADERBOARD_SEASON_ID;
        const page = leaderboardIndex.getPublicPage(category, seasonId, { limit: 100, project: publicLeaderboardEntry });
        return send(response, 200, {
          category,
          seasonId,
          entries: page.entries,
          generatedAt: Date.now(),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/leaderboard/me") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        const category = VALID_CATEGORIES.has(url.searchParams.get("category")) ? url.searchParams.get("category") : "galaxy";
        const seasonId = VALID_SEASONS.has(url.searchParams.get("seasonId")) ? url.searchParams.get("seasonId") : ACTIVE_LEADERBOARD_SEASON_ID;
        const leaderboardSnapshot = leaderboardIndex.getSnapshot(category, seasonId);
        const rankedEntry = leaderboardIndex.getUserEntry(category, seasonId, auth.user.id);
        const snapshot = leaderboardMeSnapshot(store, auth.user.id, category, seasonId, leaderboardSnapshot, rankedEntry);
        response.setHeader("cache-control", "private, no-store");
        return send(response, 200, { category, seasonId, ...snapshot, generatedAt: Date.now() });
      }

      if (request.method === "POST" && url.pathname === "/api/leaderboard") {
        const auth = authenticateRequest(request);
        if (!auth) return send(response, 401, { error: "请先登录" });
        if (isLeaderboardRestricted(store.data, auth.user.id)) {
          removeUserLeaderboardSubmissions(store, auth.user.id);
          await store.persist();
          return send(response, 403, { error: "当前账号暂时不能加入官方排行榜", code: LEADERBOARD_RESTRICTED_CODE });
        }
        const body = await readJson(request);
        const seasonId = VALID_SEASONS.has(body.seasonId) ? body.seasonId : ACTIVE_LEADERBOARD_SEASON_ID;
        if (seasonId !== ACTIVE_LEADERBOARD_SEASON_ID) return send(response, 409, { error: "历史赛季已封存" });
        if (auth.user.leaderboardVisible === false) return send(response, 409, { error: "当前账号已退出公开排行榜" });
        const result = updateLeaderboardFromMainSave(store, auth.user.id, { force: true });
        await store.persist({ operation: "leaderboard.refresh" });
        if (result.reason === "missing-save") return send(response, 409, { error: "请先上传当前主云存档，再刷新排行榜" });
        if (result.reason === "missing-payload") return send(response, 500, { error: "云存档正文缺失，暂时无法刷新排行榜", code: "CLOUD_SAVE_PAYLOAD_MISSING" });
        if (result.reason === "modded-save") return send(response, 422, { error: "启用内容包的存档不参与官方排行榜" });
        if (result.reason === "invalid-save" || !result.submission) return send(response, 422, { error: "主云存档无法用于排行榜计算" });
        dayMetric.leaderboardSubmissions += 1;
        return send(response, 200, { submission: result.submission, verified: true, source: "main-cloud-save" });
      }

      if (request.method === "POST" && (url.pathname === "/api/feedback" || url.pathname === "/api/errors")) {
        const body = validateClientReport(await readJson(request));
        const auth = authenticateRequest(request);
        const record = {
          id: randomUUID(),
          userId: auth?.user.id ?? null,
          kind: body.kind,
          message: body.message,
          diagnostics: body.diagnostics,
          receivedAt: Date.now(),
          ipHash: sha256(ip).slice(0, 16),
        };
        const collection = url.pathname === "/api/errors" ? store.data.errors : store.data.feedback;
        collection.push(record);
        if (collection.length > 1000) collection.splice(0, collection.length - 1000);
        if (url.pathname === "/api/feedback") dayMetric.feedback += 1;
        await store.persist();
        return send(response, 202, { id: record.id, accepted: true });
      }

      return send(response, 404, { error: "接口不存在" });
    } catch (error) {
      if (error?.code === "DOWNLOAD_CANCELLED") return undefined;
      if (error?.code === "ACCOUNT_ARCHIVE_ABORTED") return undefined;
      if (response.headersSent) throw error;
      runtime.errors += 1;
      dayMetric.errors += 1;
      logger.error?.("cloud request failed", error);
      return send(response, error?.statusCode || 500, {
        error: error?.statusCode || error instanceof AccountArchiveError ? error.message : "服务暂时不可用",
        ...(error?.code ? { code: error.code } : {}),
        ...(Number.isSafeInteger(error?.originalBytes) ? { originalBytes: error.originalBytes } : {}),
        ...(Number.isSafeInteger(error?.compressedBytes) ? { compressedBytes: error.compressedBytes } : {}),
        ...(Number.isSafeInteger(error?.expandedBytes) ? { expandedBytes: error.expandedBytes } : {}),
        ...(Number.isSafeInteger(error?.expandedLimitBytes) ? { expandedLimitBytes: error.expandedLimitBytes } : {}),
        ...(Number.isSafeInteger(error?.payloadLimitBytes) ? { payloadLimitBytes: error.payloadLimitBytes } : {}),
        ...(Number.isSafeInteger(error?.overBytes) ? { overBytes: error.overBytes } : {}),
        ...(error?.expandedBytesAtLeast === true ? { expandedBytesAtLeast: true } : {}),
      }, Number.isInteger(error?.retryAfterSeconds) ? { "retry-after": String(error.retryAfterSeconds) } : {});
    }
  };
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const routeKey = `${requestIp(request)}:${request.method}:${requestUrl.pathname}`;
    const routeLimit = requestUrl.pathname.startsWith("/api/auth/")
      ? 12
      : requestUrl.pathname === "/api/presence"
        ? 10
        : requestUrl.pathname === "/api/analytics"
          ? 30
          : 120;
    const rateAllowed = rateLimit(routeKey, routeLimit, 60_000);
    response.httpSecuritySecureTransport = request.socket?.encrypted === true
      || String(request.headers["x-forwarded-proto"] ?? "").toLowerCase() === "https";
    try {
      const httpSecurity = inspectHttpRequest(request, {
        corsPolicy,
        bodyCapability: bodyCapabilityForRoute(request.method, requestUrl.pathname, {
          cloudTransferContract,
          maximumArchiveBytes: maximumAccountArchiveImportBytes(quotaPolicy),
          maximumLegacyJsonBytes: maximumAccountArchiveImportBytes(quotaPolicy),
        }),
      });
      request.httpSecurity = httpSecurity;
      response.httpSecurityCors = httpSecurity.cors;
      if (httpSecurity.preflight) return send(response, 204, null);
    } catch (error) {
      const statusCode = error instanceof HttpSecurityError ? error.statusCode : 400;
      return send(response, statusCode, {
        error: error instanceof HttpSecurityError ? error.publicMessage : "请求安全检查失败",
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    if (!rateAllowed) {
      return send(response, 429, { error: "请求过于频繁，请稍后再试" }, { "retry-after": "60" });
    }
    const atomicGetRoutes = new Set([
      "/api/admin/cloud-history/prune-preview",
      "/api/admin/account",
      "/api/account/export",
    ]);
    const mutatingRequest = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET") || atomicGetRoutes.has(requestUrl.pathname);
    const streamedAccountImport = request.method === "POST"
      && (requestUrl.pathname === "/api/account/import/archive" || requestUrl.pathname === "/api/account/import/legacy-json");
    const atomicRequest = mutatingRequest && !streamedAccountImport;
    if (runtime.shuttingDown && mutatingRequest) {
      response.setHeader("connection", "close");
      return send(response, 503, { error: "服务正在安全关闭，请稍后重试", code: "SERVER_SHUTTING_DOWN" }, { "retry-after": "1" });
    }
    const cloudUpload = request.method === "PUT" && requestUrl.pathname === "/api/cloud-save";
    const operation = async () => {
      if (!cloudUpload) return handleRequest(request, response, atomicRequest);
      const preliminary = await handleRequest(request, response, false);
      if (!preliminary?.deferredCloudUpload || response.writableEnded) return preliminary;
      const contentLengthHeader = request.headers["content-length"];
      const contentLength = typeof contentLengthHeader === "string" && /^\d{1,12}$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : null;
      let uploadDescriptor;
      try {
        uploadDescriptor = cloudSaveUploadDescriptor(request);
      } catch (error) {
        uploadInspections.recordRejection(error?.code);
        throw error;
      }
      if (Number.isSafeInteger(contentLength) && contentLength > uploadDescriptor.inputLimit) {
        uploadInspections.recordRejection("REQUEST_BODY_TOO_LARGE");
        return send(response, 413, {
          error: "请求内容超过允许上限",
          code: "REQUEST_BODY_TOO_LARGE",
          originalBytes: uploadDescriptor.declaredOriginalBytes,
          compressedBytes: contentLength,
          compressedLimitBytes: uploadDescriptor.inputLimit,
          expandedLimitBytes: uploadDescriptor.expandedLimit,
          payloadLimitBytes: uploadDescriptor.payloadLimit,
        });
      }
      const scheduled = uploadInspections.shouldSchedule({
        encoding: uploadDescriptor.encoding,
        contentLength,
        declaredOriginalBytes: uploadDescriptor.declaredOriginalBytes,
      });
      const disconnect = new AbortController();
      const onAborted = () => disconnect.abort();
      const onResponseClose = () => {
        if (!response.writableEnded) disconnect.abort();
      };
      request.once("aborted", onAborted);
      response.once("close", onResponseClose);
      try {
        return await uploadInspections.run(
          async ({ inspect, signal }) => {
            const body = await readCloudSaveUpload(request, inspect, uploadDescriptor, signal);
            const requestedMode = normalizedCloudSaveMode(requestUrl.searchParams.get("mode") ?? "normal");
            const effectiveMode = requestUrl.searchParams.get("mode") === null && body.legacyImplicitSpeedrun
              ? "speedrun"
              : requestedMode;
            const validationFailure = effectiveMode ? cloudUploadValidationFailure(body, effectiveMode) : null;
            if (validationFailure) {
              uploadInspections.recordRejection(validationFailure.code);
              return sendCloudUploadValidationFailure(response, validationFailure);
            }
            request.preparedCloudUpload = { body };
            try {
              return await store.runAtomic(() => {
                if (signal.aborted) throw cloudUploadCancelledError(signal);
                return handleRequest(request, response, true, { preludeProcessed: true });
              });
            } finally {
              request.preparedCloudUpload = null;
            }
          },
          {
            scheduled,
            signal: disconnect.signal,
            expandedBytes: uploadDescriptor.encoding === "gzip"
              ? uploadDescriptor.expandedLimit
              : Number.isSafeInteger(contentLength)
                ? Math.min(contentLength, uploadDescriptor.expandedLimit)
                : Number.isSafeInteger(uploadDescriptor.declaredOriginalBytes)
                  ? Math.min(uploadDescriptor.declaredOriginalBytes, uploadDescriptor.expandedLimit)
                : uploadDescriptor.expandedLimit,
          },
        );
      } finally {
        request.removeListener("aborted", onAborted);
        response.removeListener("close", onResponseClose);
      }
    };
    const handled = cloudUpload ? operation() : atomicRequest ? store.runAtomic(operation) : operation();
    const observedRequest = handled.catch((error) => {
      logger.error?.("cloud request transaction failed", error);
      if (!response.headersSent) {
        send(response, error?.statusCode || 500, {
          error: error?.statusCode ? error.message : "服务暂时不可用",
          ...(error?.code ? { code: error.code } : {}),
          ...(Number.isSafeInteger(error?.originalBytes) ? { originalBytes: error.originalBytes } : {}),
          ...(Number.isSafeInteger(error?.compressedBytes) ? { compressedBytes: error.compressedBytes } : {}),
          ...(Number.isSafeInteger(error?.expandedBytes) ? { expandedBytes: error.expandedBytes } : {}),
          ...(Number.isSafeInteger(error?.expandedLimitBytes) ? { expandedLimitBytes: error.expandedLimitBytes } : {}),
          ...(Number.isSafeInteger(error?.payloadLimitBytes) ? { payloadLimitBytes: error.payloadLimitBytes } : {}),
          ...(Number.isSafeInteger(error?.overBytes) ? { overBytes: error.overBytes } : {}),
          ...(error?.expandedBytesAtLeast === true ? { expandedBytesAtLeast: true } : {}),
        }, Number.isInteger(error?.retryAfterSeconds) ? { "retry-after": String(error.retryAfterSeconds) } : {});
      } else if (!response.writableEnded) response.destroy(error);
    });
    activeRequests.add(observedRequest);
    void observedRequest.finally(() => activeRequests.delete(observedRequest));
  });

  server.store = store;
  server.leaderboardBackfill = leaderboardBackfill;
  server.presenceIndex = presenceIndex;
  server.leaderboardIndex = leaderboardIndex;
  server.runtimeMetrics = runtimeMetrics;
  server.uploadInspections = uploadInspections;
  server.requestTimeout = Number.isFinite(requestTimeoutMs)
    ? Math.max(cloudTransferContract.maximumTimeoutMs + 10_000, Math.floor(requestTimeoutMs))
    : cloudTransferContract.maximumTimeoutMs + 10_000;
  server.headersTimeout = Math.min(server.requestTimeout, 15_000);
  server.keepAliveTimeout = 5_000;
  let closeFinalized = false;
  const finalizeClose = async () => {
    if (closeFinalized) return;
    closeFinalized = true;
    await Promise.allSettled([activeBackupPromise, activeHistoryPrunePromise].filter(Boolean));
    // http.Server.close() waits for sockets, not async request-listener
    // promises. A streamed response can reach the client while its snapshot or
    // temporary-file cleanup is still running, so SQLite must remain open
    // until every accepted request has completed its server-side tail.
    await Promise.allSettled([...activeRequests]);
    await store.drain();
    store.close?.();
  };
  const nativeClose = server.close.bind(server);
  server.close = (callback) => {
    if (!runtime.shuttingDown) {
      runtime.shuttingDown = true;
      store.beginShutdown();
      uploadInspections.close();
      clearInterval(flushMetrics);
      clearInterval(runtimeSampleTimer);
      if (backupTimer) clearInterval(backupTimer);
      if (backupStartupTimer) clearTimeout(backupStartupTimer);
      if (historyPruneTimer) clearInterval(historyPruneTimer);
    }
    return nativeClose((error) => {
      void finalizeClose().then(
        () => callback?.(error),
        (closeError) => callback?.(closeError),
      );
    });
  };
  server.on("close", () => {
    clearInterval(flushMetrics);
    clearInterval(runtimeSampleTimer);
    unsubscribeStoreCommit();
    if (backupTimer) clearInterval(backupTimer);
    if (backupStartupTimer) clearTimeout(backupStartupTimer);
    if (historyPruneTimer) clearInterval(historyPruneTimer);
  });
  server.shutdown = () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return server;
}

async function startFromCli() {
  const port = Number(process.env.PORT || 4320);
  const host = process.env.HOST || "127.0.0.1";
  const server = await createCloudServer();
  server.listen(port, host, () => console.log(`DSP cloud service listening on http://${host}:${port}`));
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`DSP cloud service received ${signal}; draining requests`);
    const forceExit = setTimeout(() => process.exit(1), 75_000);
    forceExit.unref?.();
    void server.shutdown().then(
      () => { clearTimeout(forceExit); process.exit(0); },
      (error) => { console.error("DSP cloud service shutdown failed", error); clearTimeout(forceExit); process.exit(1); },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  void startFromCli();
}
