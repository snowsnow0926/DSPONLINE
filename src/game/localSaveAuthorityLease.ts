import {
  LOCAL_SAVE_LEASE_DURATION_MS,
  type LocalSaveWriterLease,
} from "./localSaveCoordination";

export const LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX = "native_authority:";
export const LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_EXPIRES_AT = Number.MAX_SAFE_INTEGER;
export const LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_RECEIPT_KIND = "local-save-native-authority-lease-v1";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_LEASE_ID_LENGTH = 128;
const MAX_OWNER_ID_LENGTH = 200;

export interface LocalSaveWriterFence {
  ownerId: string;
  fencingToken: number;
}

export interface LocalSaveNativeAuthorityLeaseReceipt {
  kind: typeof LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_RECEIPT_KIND;
  leaseId: string;
  previousWriterFence: LocalSaveWriterFence;
  nativeWriterFence: LocalSaveWriterFence;
}

export type LocalSaveNativeAuthorityLeaseAcquireResult =
  | {
      ok: true;
      changed: boolean;
      lease: LocalSaveWriterLease;
      receipt: LocalSaveNativeAuthorityLeaseReceipt;
    }
  | {
      ok: false;
      reason: "invalid" | "cas-mismatch" | "native-held" | "token-exhausted";
    };

export type LocalSaveNativeAuthorityLeaseReleaseResult =
  | {
      ok: true;
      changed: boolean;
      lease: LocalSaveWriterLease;
    }
  | {
      ok: false;
      reason: "invalid" | "cas-mismatch" | "token-exhausted";
    };

function validLogicalId(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    LOGICAL_ID_PATTERN.test(value);
}

function validWriterFence(value: unknown): value is LocalSaveWriterFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<LocalSaveWriterFence>;
  return Reflect.ownKeys(value).length === 2 && validLogicalId(candidate.ownerId, MAX_OWNER_ID_LENGTH) &&
    Number.isSafeInteger(candidate.fencingToken) && candidate.fencingToken! >= 1;
}

function nextFencingToken(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER
    ? value + 1
    : null;
}

export function localSaveNativeAuthorityOwnerId(leaseId: string): string | null {
  if (!validLogicalId(leaseId, MAX_LEASE_ID_LENGTH)) return null;
  const ownerId = `${LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX}${leaseId}`;
  return ownerId.length <= MAX_OWNER_ID_LENGTH ? ownerId : null;
}

export function localSaveNativeAuthorityLeaseId(lease: LocalSaveWriterLease | null): string | null {
  if (!lease || !lease.ownerId.startsWith(LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX) ||
    lease.expiresAt !== LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_EXPIRES_AT) return null;
  const leaseId = lease.ownerId.slice(LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX.length);
  return localSaveNativeAuthorityOwnerId(leaseId) === lease.ownerId ? leaseId : null;
}

export function isLocalSaveNativeAuthorityLease(lease: LocalSaveWriterLease | null): boolean {
  return localSaveNativeAuthorityLeaseId(lease) !== null;
}

export function localSaveWriterLeaseMatchesFence(
  lease: LocalSaveWriterLease | null,
  fence: LocalSaveWriterFence,
): lease is LocalSaveWriterLease {
  return Boolean(lease && validWriterFence(fence) && lease.ownerId === fence.ownerId &&
    lease.fencingToken === fence.fencingToken);
}

function receiptFor(
  leaseId: string,
  previousWriterFence: LocalSaveWriterFence,
  nativeWriterFence: LocalSaveWriterFence,
): LocalSaveNativeAuthorityLeaseReceipt {
  return Object.freeze({
    kind: LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_RECEIPT_KIND,
    leaseId,
    previousWriterFence: Object.freeze({ ...previousWriterFence }),
    nativeWriterFence: Object.freeze({ ...nativeWriterFence }),
  });
}

/**
 * Atomically transfer the existing browser-writer lease to a reserved native
 * owner. The caller must persist the returned lease in the same IndexedDB
 * object store used by save transactions. Readwrite transaction ordering then
 * creates the publication boundary: a prior JS transaction finishes before
 * this CAS, while a later/stale transaction observes the new fence and aborts.
 */
export function acquireLocalSaveNativeAuthorityLease(options: {
  current: LocalSaveWriterLease | null;
  expectedWriterFence: LocalSaveWriterFence;
  leaseId: string;
  now?: number;
}): LocalSaveNativeAuthorityLeaseAcquireResult {
  const { current, expectedWriterFence, leaseId } = options;
  const now = options.now ?? Date.now();
  const nativeOwnerId = localSaveNativeAuthorityOwnerId(leaseId);
  if (!nativeOwnerId || !validWriterFence(expectedWriterFence) || !Number.isFinite(now) || now < 0) {
    return { ok: false, reason: "invalid" };
  }
  const nativeFencingToken = nextFencingToken(expectedWriterFence.fencingToken);
  if (nativeFencingToken === null) return { ok: false, reason: "token-exhausted" };
  const nativeWriterFence = { ownerId: nativeOwnerId, fencingToken: nativeFencingToken };
  const receipt = receiptFor(leaseId, expectedWriterFence, nativeWriterFence);

  // An identical retry is safe after an uncertain IndexedDB completion. The
  // deterministic owner/token pair proves it is the result of this exact CAS.
  if (localSaveWriterLeaseMatchesFence(current, nativeWriterFence) &&
    current.expiresAt === LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_EXPIRES_AT) {
    return { ok: true, changed: false, lease: current, receipt };
  }
  if (isLocalSaveNativeAuthorityLease(current)) return { ok: false, reason: "native-held" };
  if (!localSaveWriterLeaseMatchesFence(current, expectedWriterFence)) {
    return { ok: false, reason: "cas-mismatch" };
  }
  const lease: LocalSaveWriterLease = {
    schemaVersion: 1,
    ownerId: nativeOwnerId,
    fencingToken: nativeFencingToken,
    heartbeatAt: now,
    expiresAt: LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_EXPIRES_AT,
  };
  return { ok: true, changed: true, lease, receipt };
}

function validReceipt(value: unknown): value is LocalSaveNativeAuthorityLeaseReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<LocalSaveNativeAuthorityLeaseReceipt>;
  if (Reflect.ownKeys(value).length !== 4 || candidate.kind !== LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_RECEIPT_KIND ||
    !validLogicalId(candidate.leaseId, MAX_LEASE_ID_LENGTH) || !validWriterFence(candidate.previousWriterFence) ||
    !validWriterFence(candidate.nativeWriterFence)) return false;
  const nativeOwnerId = localSaveNativeAuthorityOwnerId(candidate.leaseId);
  const expectedNativeToken = nextFencingToken(candidate.previousWriterFence.fencingToken);
  return nativeOwnerId !== null && candidate.nativeWriterFence.ownerId === nativeOwnerId &&
    candidate.nativeWriterFence.fencingToken === expectedNativeToken;
}

/**
 * Explicitly return a not-yet-transferred/finished native lease to this JS
 * writer. The second token increment prevents a pre-handoff JS request from
 * becoming valid again after the native owner releases the store (ABA).
 */
export function releaseLocalSaveNativeAuthorityLease(options: {
  current: LocalSaveWriterLease | null;
  receipt: LocalSaveNativeAuthorityLeaseReceipt;
  targetWriterId: string;
  now?: number;
}): LocalSaveNativeAuthorityLeaseReleaseResult {
  const { current, receipt, targetWriterId } = options;
  const now = options.now ?? Date.now();
  if (!validReceipt(receipt) || !validLogicalId(targetWriterId, MAX_OWNER_ID_LENGTH) ||
    targetWriterId.startsWith(LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX) || !Number.isFinite(now) || now < 0) {
    return { ok: false, reason: "invalid" };
  }
  const returnedToken = nextFencingToken(receipt.nativeWriterFence.fencingToken);
  if (returnedToken === null) return { ok: false, reason: "token-exhausted" };
  const returnedFence = { ownerId: targetWriterId, fencingToken: returnedToken };

  // The exact hand-back retry is idempotent, while every pre-handoff token is
  // still stale because the returned writer uses nativeToken + 1.
  if (localSaveWriterLeaseMatchesFence(current, returnedFence)) {
    return { ok: true, changed: false, lease: current };
  }
  if (!localSaveWriterLeaseMatchesFence(current, receipt.nativeWriterFence) ||
    localSaveNativeAuthorityLeaseId(current) !== receipt.leaseId) {
    return { ok: false, reason: "cas-mismatch" };
  }
  const lease: LocalSaveWriterLease = {
    schemaVersion: 1,
    ownerId: targetWriterId,
    fencingToken: returnedToken,
    heartbeatAt: now,
    expiresAt: now + LOCAL_SAVE_LEASE_DURATION_MS,
  };
  return { ok: true, changed: true, lease };
}
