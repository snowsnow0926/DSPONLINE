export const LOCAL_SAVE_COORDINATION_PREFIX = "dsp-idle-network.local-save-coordination.v1";
export const LOCAL_SAVE_WRITER_LEASE_KEY = `${LOCAL_SAVE_COORDINATION_PREFIX}.writer-lease`;
export const LOCAL_SAVE_REVISION_KEY_PREFIX = `${LOCAL_SAVE_COORDINATION_PREFIX}.revision.`;
export const LOCAL_SAVE_CONFLICT_KEY_PREFIX = "dsp-idle-network.save.v1.conflict.";
export const LOCAL_SAVE_CONFLICT_METADATA_KEY_PREFIX = `${LOCAL_SAVE_COORDINATION_PREFIX}.conflict.`;
export const LOCAL_SAVE_BROADCAST_CHANNEL = "dsp-idle-network.local-save-writes.v1";
export const LOCAL_SAVE_STORAGE_EVENT_KEY = `${LOCAL_SAVE_COORDINATION_PREFIX}.event`;
export const LOCAL_SAVE_WRITER_LOCK = "dsp-idle-network.local-save-writer.v1";
export const LOCAL_SAVE_WRITER_SESSION_KEY = `${LOCAL_SAVE_COORDINATION_PREFIX}.tab-id`;
export const LOCAL_SAVE_WRITER_CONTINUATION_KEY = `${LOCAL_SAVE_COORDINATION_PREFIX}.same-tab-continuation`;
export const LOCAL_SAVE_EMERGENCY_MIRROR_PREFIX = `${LOCAL_SAVE_COORDINATION_PREFIX}.emergency-mirror`;
export const LOCAL_SAVE_LEASE_DURATION_MS = 15_000;
export const LOCAL_SAVE_HEARTBEAT_INTERVAL_MS = 5_000;

export type LocalSaveWriterRole = "initializing" | "primary" | "secondary" | "conflict" | "unavailable";

export interface LocalSaveWriterStatus {
  role: LocalSaveWriterRole;
  writerId: string;
  fencingToken: number;
  leaseExpiresAt: number;
  reason: string;
  conflictId?: string;
}

export interface LocalSaveWriterLease {
  schemaVersion: 1;
  ownerId: string;
  fencingToken: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface LocalSaveRevision {
  schemaVersion: 1;
  saveKey: string;
  revision: number;
  savedAt: number;
  checksum: string | null;
  deleted: boolean;
  writerId: string;
  fencingToken: number;
  updatedAt: number;
}

export interface LocalSaveEmergencyMirrorMetadata {
  schemaVersion: 1;
  mode: "normal" | "speedrun";
  saveKey: string;
  writerId: string;
  fencingToken: number;
  candidateRevision: number;
  savedAt: number;
  checksum: string | null;
  createdAt: number;
}

export interface LocalSaveBroadcastMessage {
  schemaVersion: 1;
  type: "saved" | "deleted" | "lease" | "conflict";
  writerId: string;
  sentAt: number;
  key?: string;
  revision?: number;
  fencingToken?: number;
  leaseExpiresAt?: number;
  conflictId?: string;
}

export interface LocalSaveConflictRecord {
  schemaVersion: 1;
  conflictId: string;
  saveKey: string;
  candidateKey: string;
  persistedKey: string;
  candidateDeleted: boolean;
  persistedMissing: boolean;
  writerId: string;
  fencingToken: number;
  createdAt: number;
  resolvedAt?: number;
  resolution?: "candidate" | "persisted";
}

export class LocalSaveReadOnlyError extends Error {
  constructor(message = "另一个标签页正在管理本地存档，当前页面为只读") {
    super(message);
    this.name = "LocalSaveReadOnlyError";
  }
}

export class LocalSaveConflictError extends Error {
  constructor(
    readonly conflictId: string,
    message = "检测到另一个标签页已更新存档，已停止覆盖并保留冲突副本",
  ) {
    super(message);
    this.name = "LocalSaveConflictError";
  }
}

export function localSaveRevisionKey(saveKey: string): string {
  return `${LOCAL_SAVE_REVISION_KEY_PREFIX}${encodeURIComponent(saveKey)}`;
}

export function localSaveConflictMetadataKey(conflictId: string): string {
  return `${LOCAL_SAVE_CONFLICT_METADATA_KEY_PREFIX}${conflictId}`;
}

export function localSaveEmergencyMirrorKeys(mode: "normal" | "speedrun"): { payload: string; metadata: string } {
  return {
    payload: `${LOCAL_SAVE_EMERGENCY_MIRROR_PREFIX}.${mode}.payload`,
    metadata: `${LOCAL_SAVE_EMERGENCY_MIRROR_PREFIX}.${mode}.metadata`,
  };
}

export function createLocalSaveWriterId(now = Date.now()): string {
  try {
    return `tab_${crypto.randomUUID()}`;
  } catch {
    return `tab_${now.toString(36)}_${Math.random().toString(36).slice(2)}`;
  }
}

export function parseLocalSaveWriterLease(raw: string | null | undefined): LocalSaveWriterLease | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LocalSaveWriterLease>;
    return value.schemaVersion === 1 && typeof value.ownerId === "string" && value.ownerId.length > 0 &&
      Number.isSafeInteger(value.fencingToken) && value.fencingToken! >= 1 &&
      typeof value.heartbeatAt === "number" && Number.isFinite(value.heartbeatAt) &&
      typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
      ? value as LocalSaveWriterLease
      : null;
  } catch {
    return null;
  }
}

export function parseLocalSaveRevision(raw: string | null | undefined): LocalSaveRevision | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LocalSaveRevision>;
    return value.schemaVersion === 1 && typeof value.saveKey === "string" && value.saveKey.length > 0 &&
      Number.isSafeInteger(value.revision) && value.revision! >= 1 &&
      typeof value.savedAt === "number" && Number.isFinite(value.savedAt) &&
      (value.checksum === null || typeof value.checksum === "string") && typeof value.deleted === "boolean" &&
      typeof value.writerId === "string" && value.writerId.length > 0 &&
      Number.isSafeInteger(value.fencingToken) && value.fencingToken! >= 1 &&
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
      ? value as LocalSaveRevision
      : null;
  } catch {
    return null;
  }
}

export function parseLocalSaveEmergencyMirrorMetadata(raw: string | null | undefined): LocalSaveEmergencyMirrorMetadata | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LocalSaveEmergencyMirrorMetadata>;
    return value.schemaVersion === 1 && (value.mode === "normal" || value.mode === "speedrun") &&
      typeof value.saveKey === "string" && value.saveKey.length > 0 &&
      typeof value.writerId === "string" && value.writerId.length > 0 &&
      Number.isSafeInteger(value.fencingToken) && value.fencingToken! >= 1 &&
      Number.isSafeInteger(value.candidateRevision) && value.candidateRevision! >= 1 &&
      typeof value.savedAt === "number" && Number.isFinite(value.savedAt) &&
      (value.checksum === null || typeof value.checksum === "string") &&
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value as LocalSaveEmergencyMirrorMetadata
      : null;
  } catch {
    return null;
  }
}

export function canApplyLocalSaveEmergencyMirror(options: {
  metadata: LocalSaveEmergencyMirrorMetadata;
  expectedWriterId: string;
  expectedMode: "normal" | "speedrun";
  expectedSaveKey: string;
  payloadIdentity: { savedAt: number; checksum: string | null };
  durableRevision: LocalSaveRevision | null;
  durableLease: LocalSaveWriterLease | null;
}): boolean {
  return options.metadata.writerId === options.expectedWriterId && matchesLocalSaveEmergencyMirrorLineage(options);
}

export function matchesLocalSaveEmergencyMirrorLineage(options: {
  metadata: LocalSaveEmergencyMirrorMetadata;
  expectedMode: "normal" | "speedrun";
  expectedSaveKey: string;
  payloadIdentity: { savedAt: number; checksum: string | null };
  durableRevision: LocalSaveRevision | null;
  durableLease: LocalSaveWriterLease | null;
}): boolean {
  const { metadata, expectedMode, expectedSaveKey, payloadIdentity, durableRevision, durableLease } = options;
  return metadata.mode === expectedMode && metadata.saveKey === expectedSaveKey &&
    metadata.savedAt === payloadIdentity.savedAt && metadata.checksum === payloadIdentity.checksum &&
    metadata.candidateRevision > (durableRevision?.revision ?? 0) &&
    (!durableRevision || durableRevision.writerId === metadata.writerId && durableRevision.fencingToken === metadata.fencingToken) &&
    durableLease?.ownerId === metadata.writerId && durableLease.fencingToken === metadata.fencingToken;
}

export function parseLocalSaveConflictRecord(raw: string | null | undefined): LocalSaveConflictRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LocalSaveConflictRecord>;
    return value.schemaVersion === 1 && typeof value.conflictId === "string" && value.conflictId.length > 0 &&
      typeof value.saveKey === "string" && value.saveKey.length > 0 &&
      typeof value.candidateKey === "string" && value.candidateKey.length > 0 &&
      typeof value.persistedKey === "string" && value.persistedKey.length > 0 &&
      typeof value.candidateDeleted === "boolean" && typeof value.persistedMissing === "boolean" &&
      typeof value.writerId === "string" && value.writerId.length > 0 &&
      Number.isSafeInteger(value.fencingToken) && value.fencingToken! >= 1 &&
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt) &&
      (value.resolvedAt === undefined || typeof value.resolvedAt === "number" && Number.isFinite(value.resolvedAt)) &&
      (value.resolution === undefined || value.resolution === "candidate" || value.resolution === "persisted")
      ? value as LocalSaveConflictRecord
      : null;
  } catch {
    return null;
  }
}

export function createLocalSaveWriterLease(
  writerId: string,
  previous: LocalSaveWriterLease | null,
  now = Date.now(),
): LocalSaveWriterLease {
  const fencingToken = previous?.ownerId === writerId
    ? previous.fencingToken
    : Math.max(0, previous?.fencingToken ?? 0) + 1;
  return {
    schemaVersion: 1,
    ownerId: writerId,
    fencingToken,
    heartbeatAt: now,
    expiresAt: now + LOCAL_SAVE_LEASE_DURATION_MS,
  };
}

export function canClaimLocalSaveWriterLease(
  lease: LocalSaveWriterLease | null,
  writerId: string,
  now = Date.now(),
): boolean {
  return !lease || lease.ownerId === writerId || lease.expiresAt <= now;
}

/**
 * Renew an expired lease only when the durable owner and fencing token still
 * identify this exact writer. A long parse, structured clone, or IndexedDB
 * preparation can delay the heartbeat beyond 15 seconds without creating a
 * competing writer. Treating that delay as a cross-tab fork creates a false
 * conflict for large first-time imports. A real takeover always changes the
 * owner or fencing token and therefore remains rejected.
 */
export function renewOwnedLocalSaveWriterLease(
  lease: LocalSaveWriterLease | null,
  writerId: string,
  fencingToken: number,
  now = Date.now(),
): LocalSaveWriterLease | null {
  if (!lease || lease.ownerId !== writerId || lease.fencingToken !== fencingToken) return null;
  return {
    ...lease,
    heartbeatAt: now,
    expiresAt: now + LOCAL_SAVE_LEASE_DURATION_MS,
  };
}

/**
 * Read the envelope identity without JSON.parse of a multi-megabyte state.
 * savedAt is emitted before state and checksum is the final envelope field.
 */
export function inspectLocalSaveIdentity(value: string | null): { savedAt: number; checksum: string | null } {
  if (value === null) return { savedAt: 0, checksum: null };
  const prefix = value.slice(0, Math.min(value.length, 2_048));
  const savedAtMatch = /"savedAt"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(prefix);
  const suffix = value.slice(Math.max(0, value.length - 256));
  const checksumMatch = /"checksum"\s*:\s*"([a-zA-Z0-9_-]{1,160})"\s*}\s*$/.exec(suffix);
  const parsedSavedAt = savedAtMatch ? Number(savedAtMatch[1]) : 0;
  return {
    savedAt: Number.isFinite(parsedSavedAt) ? parsedSavedAt : 0,
    checksum: checksumMatch?.[1] ?? null,
  };
}

export function createLocalSaveRevision(options: {
  saveKey: string;
  previousRevision: number;
  value: string | null;
  writerId: string;
  fencingToken: number;
  now?: number;
}): LocalSaveRevision {
  const identity = inspectLocalSaveIdentity(options.value);
  return {
    schemaVersion: 1,
    saveKey: options.saveKey,
    revision: Math.max(0, options.previousRevision) + 1,
    savedAt: identity.savedAt,
    checksum: identity.checksum,
    deleted: options.value === null,
    writerId: options.writerId,
    fencingToken: options.fencingToken,
    updatedAt: options.now ?? Date.now(),
  };
}

export function createLocalSaveConflictId(now = Date.now(), writerId = "tab"): string {
  const safeWriter = writerId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-20) || "tab";
  return `${now.toString(36)}-${safeWriter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function localSaveConflictKeys(conflictId: string): { candidate: string; persisted: string } {
  return {
    candidate: `${LOCAL_SAVE_CONFLICT_KEY_PREFIX}${conflictId}.candidate`,
    persisted: `${LOCAL_SAVE_CONFLICT_KEY_PREFIX}${conflictId}.persisted`,
  };
}
