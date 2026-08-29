import {
  LOCAL_SAVE_COORDINATION_PREFIX,
  LOCAL_SAVE_LEASE_DURATION_MS,
  type LocalSaveWriterLease,
} from "./localSaveCoordination";

export const LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX = "native_authority:";
export const LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_EXPIRES_AT = Number.MAX_SAFE_INTEGER;
export const LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_RECEIPT_KIND = "local-save-native-authority-lease-v1";
export const LOCAL_SAVE_NATIVE_AUTHORITY_HANDOFF_JOURNAL_KIND = "local-save-native-authority-handoff-journal-v1";
export const LOCAL_SAVE_NATIVE_AUTHORITY_HANDOFF_JOURNAL_KEY_PREFIX =
  `${LOCAL_SAVE_COORDINATION_PREFIX}.native-authority-handoff.`;

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
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

export interface LocalSaveNativeAuthorityCheckpoint {
  generation: number;
  rootHash: string;
  revision: number;
}

interface LocalSaveNativeAuthorityHandoffJournalBase {
  schemaVersion: 1;
  kind: typeof LOCAL_SAVE_NATIVE_AUTHORITY_HANDOFF_JOURNAL_KIND;
  runId: string;
  sessionId: string;
  stateVersion: 47;
  mode: "normal";
  checkpoint: LocalSaveNativeAuthorityCheckpoint;
  previousWriterFence: LocalSaveWriterFence;
  nativeWriterFence: LocalSaveWriterFence;
  createdAt: number;
}

export interface LocalSaveNativeAuthorityBrowserFencedJournal
  extends LocalSaveNativeAuthorityHandoffJournalBase {
  phase: "browser-fenced";
}

export interface LocalSaveNativeAuthorityHandedBackTombstone
  extends LocalSaveNativeAuthorityHandoffJournalBase {
  phase: "handed-back";
  handedBackAt: number;
  returnedWriterFence: LocalSaveWriterFence;
}

export type LocalSaveNativeAuthorityHandoffJournal =
  | LocalSaveNativeAuthorityBrowserFencedJournal
  | LocalSaveNativeAuthorityHandedBackTombstone;

export type LocalSaveNativeAuthorityRustLeaseObservation =
  | {
      state: "active";
      runId: string;
      sessionId: string;
      stateVersion: 47;
      mode: "normal";
      checkpoint: LocalSaveNativeAuthorityCheckpoint;
    }
  | { state: "absent" }
  | { state: "unknown" };

export type LocalSaveNativeAuthorityHandoffReconcileDecision =
  | {
      action: "resume-native";
      reason: "rust-active-matches-browser-fence";
      runId: string;
      sessionId: string;
      checkpoint: LocalSaveNativeAuthorityCheckpoint;
    }
  | {
      action: "release-browser-fence";
      reason: "rust-lease-absent-release-authorized";
      runId: string;
      sessionId: string;
      checkpoint: LocalSaveNativeAuthorityCheckpoint;
    }
  | {
      action: "fail-closed";
      reason:
        | "browser-fence-invalid"
        | "journal-not-browser-fenced"
        | "rust-active-mismatch"
        | "rust-lease-absent-release-not-authorized"
        | "rust-lease-state-unknown";
      runId: string | null;
    };

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

export type LocalSaveNativeAuthorityHandoffAcquireResult =
  | {
      ok: true;
      changed: boolean;
      lease: LocalSaveWriterLease;
      receipt: LocalSaveNativeAuthorityLeaseReceipt;
      journal: LocalSaveNativeAuthorityBrowserFencedJournal;
    }
  | {
      ok: false;
      reason: "invalid" | "cas-mismatch" | "native-held" | "token-exhausted" | "journal-conflict";
    };

export type LocalSaveNativeAuthorityHandoffReleaseResult =
  | {
      ok: true;
      changed: boolean;
      lease: LocalSaveWriterLease;
      journal: LocalSaveNativeAuthorityHandedBackTombstone;
    }
  | {
      ok: false;
      reason: "invalid" | "cas-mismatch" | "token-exhausted" | "journal-conflict" | "release-not-authorized";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
}

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

function validCheckpoint(value: unknown): value is LocalSaveNativeAuthorityCheckpoint {
  if (!hasExactKeys(value, ["generation", "rootHash", "revision"])) return false;
  return Number.isSafeInteger(value.generation) && (value.generation as number) >= 1 &&
    typeof value.rootHash === "string" && SHA256_PATTERN.test(value.rootHash) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) >= 0;
}

function cloneFence(value: LocalSaveWriterFence): LocalSaveWriterFence {
  return Object.freeze({ ownerId: value.ownerId, fencingToken: value.fencingToken });
}

function cloneCheckpoint(value: LocalSaveNativeAuthorityCheckpoint): LocalSaveNativeAuthorityCheckpoint {
  return Object.freeze({ generation: value.generation, rootHash: value.rootHash, revision: value.revision });
}

function sameCheckpoint(left: LocalSaveNativeAuthorityCheckpoint, right: LocalSaveNativeAuthorityCheckpoint): boolean {
  return left.generation === right.generation && left.rootHash === right.rootHash && left.revision === right.revision;
}

function sameWriterFence(left: LocalSaveWriterFence, right: LocalSaveWriterFence): boolean {
  return left.ownerId === right.ownerId && left.fencingToken === right.fencingToken;
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

export function localSaveNativeAuthorityHandoffJournalKey(runId: string): string | null {
  return validLogicalId(runId, MAX_LEASE_ID_LENGTH)
    ? `${LOCAL_SAVE_NATIVE_AUTHORITY_HANDOFF_JOURNAL_KEY_PREFIX}${runId}`
    : null;
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

function browserFencedJournalFor(options: {
  runId: string;
  sessionId: string;
  checkpoint: LocalSaveNativeAuthorityCheckpoint;
  receipt: LocalSaveNativeAuthorityLeaseReceipt;
  createdAt: number;
}): LocalSaveNativeAuthorityBrowserFencedJournal | null {
  const { runId, sessionId, checkpoint, receipt, createdAt } = options;
  if (!validLogicalId(runId, MAX_LEASE_ID_LENGTH) || receipt.leaseId !== runId ||
    !validLogicalId(sessionId, MAX_LEASE_ID_LENGTH) || !validCheckpoint(checkpoint) ||
    !Number.isSafeInteger(createdAt) || createdAt < 0 || !validReceipt(receipt) ||
    receipt.previousWriterFence.ownerId.startsWith(LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX)) return null;
  return Object.freeze({
    schemaVersion: 1,
    kind: LOCAL_SAVE_NATIVE_AUTHORITY_HANDOFF_JOURNAL_KIND,
    runId,
    sessionId,
    stateVersion: 47,
    mode: "normal",
    checkpoint: cloneCheckpoint(checkpoint),
    previousWriterFence: cloneFence(receipt.previousWriterFence),
    nativeWriterFence: cloneFence(receipt.nativeWriterFence),
    phase: "browser-fenced",
    createdAt,
  });
}

function handedBackTombstoneFor(
  journal: LocalSaveNativeAuthorityBrowserFencedJournal,
  returnedWriterFence: LocalSaveWriterFence,
  handedBackAt: number,
): LocalSaveNativeAuthorityHandedBackTombstone | null {
  const expectedReturnedToken = nextFencingToken(journal.nativeWriterFence.fencingToken);
  if (!validWriterFence(returnedWriterFence) ||
    returnedWriterFence.ownerId.startsWith(LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX) ||
    returnedWriterFence.fencingToken !== expectedReturnedToken || !Number.isSafeInteger(handedBackAt) ||
    handedBackAt < journal.createdAt) return null;
  return Object.freeze({
    ...journal,
    checkpoint: cloneCheckpoint(journal.checkpoint),
    previousWriterFence: cloneFence(journal.previousWriterFence),
    nativeWriterFence: cloneFence(journal.nativeWriterFence),
    phase: "handed-back",
    handedBackAt,
    returnedWriterFence: cloneFence(returnedWriterFence),
  });
}

function sameBrowserFencedJournalBinding(
  left: LocalSaveNativeAuthorityBrowserFencedJournal,
  right: LocalSaveNativeAuthorityBrowserFencedJournal,
): boolean {
  return left.schemaVersion === right.schemaVersion && left.kind === right.kind && left.runId === right.runId &&
    left.sessionId === right.sessionId && left.stateVersion === right.stateVersion && left.mode === right.mode &&
    sameCheckpoint(left.checkpoint, right.checkpoint) &&
    sameWriterFence(left.previousWriterFence, right.previousWriterFence) &&
    sameWriterFence(left.nativeWriterFence, right.nativeWriterFence);
}

export function parseLocalSaveNativeAuthorityHandoffJournal(
  raw: string | null | undefined,
): LocalSaveNativeAuthorityHandoffJournal | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || (value.phase !== "browser-fenced" && value.phase !== "handed-back")) return null;
    const keys = value.phase === "browser-fenced"
      ? [
          "schemaVersion", "kind", "runId", "sessionId", "stateVersion", "mode", "checkpoint",
          "previousWriterFence", "nativeWriterFence", "phase", "createdAt",
        ]
      : [
          "schemaVersion", "kind", "runId", "sessionId", "stateVersion", "mode", "checkpoint",
          "previousWriterFence", "nativeWriterFence", "phase", "createdAt", "handedBackAt",
          "returnedWriterFence",
        ];
    if (!hasExactKeys(value, keys) || value.schemaVersion !== 1 ||
      value.kind !== LOCAL_SAVE_NATIVE_AUTHORITY_HANDOFF_JOURNAL_KIND ||
      !validLogicalId(value.runId, MAX_LEASE_ID_LENGTH) ||
      !validLogicalId(value.sessionId, MAX_LEASE_ID_LENGTH) || value.stateVersion !== 47 || value.mode !== "normal" ||
      !validCheckpoint(value.checkpoint) || !validWriterFence(value.previousWriterFence) ||
      !validWriterFence(value.nativeWriterFence) || !Number.isSafeInteger(value.createdAt) ||
      (value.createdAt as number) < 0) return null;
    if (value.previousWriterFence.ownerId.startsWith(LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX)) return null;
    const nativeOwnerId = localSaveNativeAuthorityOwnerId(value.runId);
    const expectedNativeToken = nextFencingToken(value.previousWriterFence.fencingToken);
    if (nativeOwnerId === null || value.nativeWriterFence.ownerId !== nativeOwnerId ||
      value.nativeWriterFence.fencingToken !== expectedNativeToken) return null;
    const createdAt = value.createdAt as number;
    const base: LocalSaveNativeAuthorityHandoffJournalBase = {
      schemaVersion: 1 as const,
      kind: LOCAL_SAVE_NATIVE_AUTHORITY_HANDOFF_JOURNAL_KIND,
      runId: value.runId,
      sessionId: value.sessionId,
      stateVersion: 47 as const,
      mode: "normal" as const,
      checkpoint: cloneCheckpoint(value.checkpoint),
      previousWriterFence: cloneFence(value.previousWriterFence),
      nativeWriterFence: cloneFence(value.nativeWriterFence),
      createdAt,
    };
    if (value.phase === "browser-fenced") {
      return Object.freeze({ ...base, phase: "browser-fenced" as const });
    }
    if (!validWriterFence(value.returnedWriterFence) ||
      value.returnedWriterFence.ownerId.startsWith(LOCAL_SAVE_NATIVE_AUTHORITY_OWNER_PREFIX) ||
      value.returnedWriterFence.fencingToken !== nextFencingToken(value.nativeWriterFence.fencingToken) ||
      !Number.isSafeInteger(value.handedBackAt) || (value.handedBackAt as number) < createdAt) return null;
    const handedBackAt = value.handedBackAt as number;
    return Object.freeze({
      ...base,
      phase: "handed-back" as const,
      handedBackAt,
      returnedWriterFence: cloneFence(value.returnedWriterFence),
    });
  } catch {
    return null;
  }
}

/**
 * Pure transaction planner for the browser-fenced handoff journal. The store
 * layer persists both returned records in one IndexedDB readwrite transaction.
 */
export function acquireLocalSaveNativeAuthorityHandoff(options: {
  currentLease: LocalSaveWriterLease | null;
  currentJournal: LocalSaveNativeAuthorityHandoffJournal | null;
  expectedWriterFence: LocalSaveWriterFence;
  runId: string;
  sessionId: string;
  checkpoint: LocalSaveNativeAuthorityCheckpoint;
  now?: number;
}): LocalSaveNativeAuthorityHandoffAcquireResult {
  const now = options.now ?? Date.now();
  const acquired = acquireLocalSaveNativeAuthorityLease({
    current: options.currentLease,
    expectedWriterFence: options.expectedWriterFence,
    leaseId: options.runId,
    now,
  });
  if (!acquired.ok) return acquired;
  const candidate = browserFencedJournalFor({
    runId: options.runId,
    sessionId: options.sessionId,
    checkpoint: options.checkpoint,
    receipt: acquired.receipt,
    createdAt: now,
  });
  if (!candidate) return { ok: false, reason: "invalid" };
  if (options.currentJournal === null) {
    // A native lease without its journal could only have come from an older
    // non-journal API or partial/corrupt external state. Never backfill it with
    // caller-supplied session/checkpoint identity after the CAS already won.
    if (!acquired.changed) return { ok: false, reason: "journal-conflict" };
    return { ok: true, changed: true, lease: acquired.lease, receipt: acquired.receipt, journal: candidate };
  }
  if (options.currentJournal.phase !== "browser-fenced" || acquired.changed ||
    !sameBrowserFencedJournalBinding(options.currentJournal, candidate)) {
    return { ok: false, reason: "journal-conflict" };
  }
  return {
    ok: true,
    changed: false,
    lease: acquired.lease,
    receipt: acquired.receipt,
    journal: options.currentJournal,
  };
}

function browserFenceMatchesLease(
  journal: LocalSaveNativeAuthorityBrowserFencedJournal,
  lease: LocalSaveWriterLease | null,
): boolean {
  return localSaveWriterLeaseMatchesFence(lease, journal.nativeWriterFence) &&
    lease.expiresAt === LOCAL_SAVE_NATIVE_AUTHORITY_LEASE_EXPIRES_AT &&
    localSaveNativeAuthorityLeaseId(lease) === journal.runId;
}

function decisionFor(
  action: "resume-native" | "release-browser-fence",
  journal: LocalSaveNativeAuthorityBrowserFencedJournal,
): LocalSaveNativeAuthorityHandoffReconcileDecision {
  const identity = {
    runId: journal.runId,
    sessionId: journal.sessionId,
    checkpoint: cloneCheckpoint(journal.checkpoint),
  };
  return action === "resume-native"
    ? Object.freeze({ action, reason: "rust-active-matches-browser-fence" as const, ...identity })
    : Object.freeze({ action, reason: "rust-lease-absent-release-authorized" as const, ...identity });
}

function failClosed(
  reason: Extract<LocalSaveNativeAuthorityHandoffReconcileDecision, { action: "fail-closed" }>["reason"],
  runId: string | null,
): LocalSaveNativeAuthorityHandoffReconcileDecision {
  return Object.freeze({ action: "fail-closed", reason, runId });
}

/**
 * Cross-store recovery policy. Absence must be an explicit Rust observation
 * and still needs explicit release authorization. Timeouts are represented as
 * unknown and can therefore only retain the browser fence.
 */
export function reconcileLocalSaveNativeAuthorityHandoff(options: {
  journal: LocalSaveNativeAuthorityHandoffJournal | null;
  currentLease: LocalSaveWriterLease | null;
  rustLease: LocalSaveNativeAuthorityRustLeaseObservation | unknown;
  releaseAuthorized: boolean;
}): LocalSaveNativeAuthorityHandoffReconcileDecision {
  const { journal, currentLease, rustLease, releaseAuthorized } = options;
  if (!journal) return failClosed("browser-fence-invalid", null);
  if (journal.phase !== "browser-fenced") return failClosed("journal-not-browser-fenced", journal.runId);
  if (!browserFenceMatchesLease(journal, currentLease)) return failClosed("browser-fence-invalid", journal.runId);
  if (!isRecord(rustLease)) return failClosed("rust-lease-state-unknown", journal.runId);
  if (rustLease.state === "active") {
    return hasExactKeys(rustLease, ["state", "runId", "sessionId", "stateVersion", "mode", "checkpoint"]) &&
      validLogicalId(rustLease.runId, MAX_LEASE_ID_LENGTH) &&
      validLogicalId(rustLease.sessionId, MAX_LEASE_ID_LENGTH) && validCheckpoint(rustLease.checkpoint) &&
      rustLease.runId === journal.runId && rustLease.sessionId === journal.sessionId &&
      rustLease.stateVersion === journal.stateVersion && rustLease.mode === journal.mode &&
      sameCheckpoint(rustLease.checkpoint, journal.checkpoint)
      ? decisionFor("resume-native", journal)
      : failClosed("rust-active-mismatch", journal.runId);
  }
  if (rustLease.state === "absent" && hasExactKeys(rustLease, ["state"])) {
    return releaseAuthorized === true
      ? decisionFor("release-browser-fence", journal)
      : failClosed("rust-lease-absent-release-not-authorized", journal.runId);
  }
  return failClosed("rust-lease-state-unknown", journal.runId);
}

function validReleaseDecision(
  value: unknown,
): value is Extract<LocalSaveNativeAuthorityHandoffReconcileDecision, { action: "release-browser-fence" }> {
  if (!hasExactKeys(value, ["action", "reason", "runId", "sessionId", "checkpoint"])) return false;
  return value.action === "release-browser-fence" && value.reason === "rust-lease-absent-release-authorized" &&
    validLogicalId(value.runId, MAX_LEASE_ID_LENGTH) && validLogicalId(value.sessionId, MAX_LEASE_ID_LENGTH) &&
    validCheckpoint(value.checkpoint);
}

/** Pure transaction planner for an explicitly authorized, auditable hand-back. */
export function releaseLocalSaveNativeAuthorityHandoff(options: {
  currentLease: LocalSaveWriterLease | null;
  currentJournal: LocalSaveNativeAuthorityHandoffJournal | null;
  receipt: LocalSaveNativeAuthorityLeaseReceipt;
  targetWriterId: string;
  decision: LocalSaveNativeAuthorityHandoffReconcileDecision;
  now?: number;
}): LocalSaveNativeAuthorityHandoffReleaseResult {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || !validReceipt(options.receipt) ||
    !validReleaseDecision(options.decision) ||
    options.decision.runId !== options.receipt.leaseId) {
    return { ok: false, reason: !Number.isSafeInteger(now) || now < 0 ? "invalid" : "release-not-authorized" };
  }
  const journal = options.currentJournal;
  if (!journal || journal.runId !== options.receipt.leaseId || journal.sessionId !== options.decision.sessionId ||
    !sameCheckpoint(journal.checkpoint, options.decision.checkpoint) ||
    !sameWriterFence(journal.previousWriterFence, options.receipt.previousWriterFence) ||
    !sameWriterFence(journal.nativeWriterFence, options.receipt.nativeWriterFence)) {
    return { ok: false, reason: "journal-conflict" };
  }
  if (journal.phase === "handed-back") {
    return journal.returnedWriterFence.ownerId === options.targetWriterId &&
      localSaveWriterLeaseMatchesFence(options.currentLease, journal.returnedWriterFence)
      ? { ok: true, changed: false, lease: options.currentLease, journal }
      : { ok: false, reason: "journal-conflict" };
  }
  if (!browserFenceMatchesLease(journal, options.currentLease)) {
    return { ok: false, reason: "cas-mismatch" };
  }
  const released = releaseLocalSaveNativeAuthorityLease({
    current: options.currentLease,
    receipt: options.receipt,
    targetWriterId: options.targetWriterId,
    now,
  });
  if (!released.ok) return released;
  if (!released.changed) return { ok: false, reason: "journal-conflict" };
  const tombstone = handedBackTombstoneFor(
    journal,
    { ownerId: released.lease.ownerId, fencingToken: released.lease.fencingToken },
    now,
  );
  return tombstone
    ? { ok: true, changed: true, lease: released.lease, journal: tombstone }
    : { ok: false, reason: "invalid" };
}
