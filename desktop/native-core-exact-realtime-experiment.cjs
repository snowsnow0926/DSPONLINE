"use strict";

/*
 * Legacy E0 persistence coordinator only. Atomic replacement plus fsync/readback makes
 * process-crash outcomes recoverable or fail-closed, but Node's Windows rename
 * API does not provide a provable WRITE_THROUGH guarantee. This store also has
 * no cross-process lock: an experiment must be behind Electron's single-instance
 * guard. Neither property is sufficient for player authority; that requires the
 * Rust SaveStore/double-pointer durability path and an inter-process exclusion
 * mechanism before any production integration. E1 rejects this legacy store;
 * only NativeCoreExactRealtimeRustLeaseStore is accepted there.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCHEMA_VERSION = 2;
const LEASE_KIND = "native-core-exact-realtime-experiment-lease-v2";
const STORAGE_DIRECTORY_NAME = "native-core-exact-realtime-experiment-v2";
const LEASE_FILE_NAME = "lease-v2.json";
const MAX_LEASE_BYTES = 32 * 1024;
const EXACT_TICK_SECONDS = 1;
const EXACT_TICK_MILLISECONDS = 1_000;

const PHASES = new Set(["prepared", "active", "paused", "finalizing"]);
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{8,128}$/;

class NativeCoreExactRealtimeExperimentLeaseError extends Error {
  constructor(message, code = "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_LEASE_INVALID") {
    super(message);
    this.name = "NativeCoreExactRealtimeExperimentLeaseError";
    this.code = code;
  }
}

function leaseError(message, code) {
  return new NativeCoreExactRealtimeExperimentLeaseError(message, code);
}

function isMissingError(error) {
  return error?.code === "ENOENT";
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isPlainRecord(value)) {
    throw leaseError(`${label} must be a plain object`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.some((key) => typeof key !== "string")) {
    throw leaseError(`${label} contains an unsupported property key`);
  }
  const expected = new Set(expectedKeys);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key) => !expected.has(key))) {
    throw leaseError(`${label} contains missing or unknown fields`);
  }
}

function requireLogicalId(value, maximumLength, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength || !LOGICAL_ID_PATTERN.test(value)) {
    throw leaseError(`${label} is invalid`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw leaseError(`${label} is invalid`);
  }
  return value;
}

function requireChecksum(value, label) {
  if (typeof value !== "string" || !CHECKSUM_PATTERN.test(value)) {
    throw leaseError(`${label} is invalid`);
  }
  return value;
}

function requireSafeInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw leaseError(`${label} is invalid`);
  }
  return value;
}

function requireExactInteger(value, expected, label) {
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw leaseError(`${label} must equal ${expected}`);
  }
  return value;
}

function safeAdd(value, increment, label) {
  const result = value + increment;
  if (!Number.isSafeInteger(result)) {
    throw leaseError(`${label} exceeds the safe integer range`);
  }
  return result;
}

function normalizeCheckpoint(value, label = "checkpoint") {
  requireExactKeys(value, ["generation", "rootHash", "revision"], label);
  return {
    generation: requireSafeInteger(value.generation, 1, `${label}.generation`),
    rootHash: requireSha256(value.rootHash, `${label}.rootHash`),
    revision: requireSafeInteger(value.revision, 0, `${label}.revision`),
  };
}

function normalizeStateProof(value, label = "proof") {
  requireExactKeys(value, ["revision", "canonicalSha256", "domainSha256"], label);
  return {
    revision: requireSafeInteger(value.revision, 0, `${label}.revision`),
    canonicalSha256: requireSha256(value.canonicalSha256, `${label}.canonicalSha256`),
    domainSha256: requireSha256(value.domainSha256, `${label}.domainSha256`),
  };
}

function normalizeAcknowledged(value, label = "acknowledged") {
  requireExactKeys(value, ["sequence", "commandId", "revision", "proof", "checkpoint", "settledDeadlineMs"], label);
  const sequence = requireSafeInteger(value.sequence, 0, `${label}.sequence`);
  let commandId = null;
  if (value.commandId !== null) {
    commandId = requireLogicalId(value.commandId, 128, `${label}.commandId`);
  }
  return {
    sequence,
    commandId,
    revision: requireSafeInteger(value.revision, 0, `${label}.revision`),
    proof: normalizeStateProof(value.proof, `${label}.proof`),
    checkpoint: normalizeCheckpoint(value.checkpoint, `${label}.checkpoint`),
    settledDeadlineMs: requireSafeInteger(value.settledDeadlineMs, 0, `${label}.settledDeadlineMs`),
  };
}

function normalizePendingTick(value, label = "pendingTick") {
  if (value === null) return null;
  requireExactKeys(value, [
    "sequence",
    "commandId",
    "baseRevision",
    "expectedRevision",
    "simulationSeconds",
    "wallSeconds",
    "settledDeadlineMs",
  ], label);
  return {
    sequence: requireSafeInteger(value.sequence, 1, `${label}.sequence`),
    commandId: requireLogicalId(value.commandId, 128, `${label}.commandId`),
    baseRevision: requireSafeInteger(value.baseRevision, 0, `${label}.baseRevision`),
    expectedRevision: requireSafeInteger(value.expectedRevision, 1, `${label}.expectedRevision`),
    simulationSeconds: requireExactInteger(value.simulationSeconds, EXACT_TICK_SECONDS, `${label}.simulationSeconds`),
    wallSeconds: requireExactInteger(value.wallSeconds, EXACT_TICK_SECONDS, `${label}.wallSeconds`),
    settledDeadlineMs: requireSafeInteger(value.settledDeadlineMs, 0, `${label}.settledDeadlineMs`),
  };
}

function normalizePause(value, label = "pause") {
  if (value === null) return null;
  requireExactKeys(value, ["reasonCode"], label);
  return {
    reasonCode: requireLogicalId(value.reasonCode, 160, `${label}.reasonCode`),
  };
}

function normalizePublicPrimaryReadbackProof(value, label = "publicPrimaryReadbackProof") {
  requireExactKeys(value, [
    "kind",
    "revision",
    "canonicalSha256",
    "domainSha256",
    "registryFingerprint",
    "payloadSha256",
    "baseChecksum",
    "byteLength",
    "savedAtMs",
  ], label);
  if (value.kind !== "public-primary-readback-v1") {
    throw leaseError(`${label}.kind is invalid`);
  }
  return {
    kind: value.kind,
    revision: requireSafeInteger(value.revision, 0, `${label}.revision`),
    canonicalSha256: requireSha256(value.canonicalSha256, `${label}.canonicalSha256`),
    domainSha256: requireSha256(value.domainSha256, `${label}.domainSha256`),
    registryFingerprint: requireLogicalId(value.registryFingerprint, 256, `${label}.registryFingerprint`),
    payloadSha256: requireSha256(value.payloadSha256, `${label}.payloadSha256`),
    baseChecksum: requireChecksum(value.baseChecksum, `${label}.baseChecksum`),
    byteLength: requireSafeInteger(value.byteLength, 1, `${label}.byteLength`),
    savedAtMs: requireSafeInteger(value.savedAtMs, 0, `${label}.savedAtMs`),
  };
}

function normalizeFinalization(value, label = "finalization") {
  if (value === null) return null;
  requireExactKeys(value, ["status", "targetRevision", "targetProof", "checkpoint", "publicPrimaryReadbackProof"], label);
  if (value.status !== "pending" && value.status !== "finalized") {
    throw leaseError(`${label}.status is invalid`);
  }
  return {
    status: value.status,
    targetRevision: requireSafeInteger(value.targetRevision, 0, `${label}.targetRevision`),
    targetProof: normalizeStateProof(value.targetProof, `${label}.targetProof`),
    checkpoint: value.checkpoint === null
      ? null
      : normalizeCheckpoint(value.checkpoint, `${label}.checkpoint`),
    publicPrimaryReadbackProof: value.publicPrimaryReadbackProof === null
      ? null
      : normalizePublicPrimaryReadbackProof(value.publicPrimaryReadbackProof, `${label}.publicPrimaryReadbackProof`),
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireSameProof(left, right, label) {
  if (!sameValue(left, right)) {
    throw leaseError(`${label} does not match the acknowledged proof`, "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT");
  }
}

function validatePublicPrimaryReadbackProof(proof, acknowledged, registryFingerprint) {
  if (proof.revision !== acknowledged.revision ||
      proof.canonicalSha256 !== acknowledged.proof.canonicalSha256 ||
      proof.domainSha256 !== acknowledged.proof.domainSha256 ||
      proof.registryFingerprint !== registryFingerprint ||
      proof.savedAtMs !== acknowledged.settledDeadlineMs) {
    throw leaseError(
      "public primary readback proof does not match the acknowledged state and deadline",
      "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT",
    );
  }
}

function normalizeLease(value) {
  requireExactKeys(value, [
    "schemaVersion",
    "kind",
    "phase",
    "runId",
    "mode",
    "slot",
    "registryFingerprint",
    "checkpoint",
    "entryProof",
    "acknowledged",
    "pendingTick",
    "pause",
    "finalization",
  ], "lease");

  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw leaseError(
      value.schemaVersion > SCHEMA_VERSION
        ? "lease schema version is newer than this build"
        : "lease schema version is unsupported",
      "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_SCHEMA_UNSUPPORTED",
    );
  }
  if (value.kind !== LEASE_KIND) throw leaseError("lease kind is invalid");
  if (!PHASES.has(value.phase)) throw leaseError("lease phase is invalid");
  if (value.mode !== "normal" || value.slot !== "normal-main") {
    throw leaseError("lease is outside the exact realtime normal-slot experiment");
  }

  const lease = {
    schemaVersion: SCHEMA_VERSION,
    kind: LEASE_KIND,
    phase: value.phase,
    runId: requireLogicalId(value.runId, 128, "lease.runId"),
    mode: "normal",
    slot: "normal-main",
    registryFingerprint: requireLogicalId(value.registryFingerprint, 256, "lease.registryFingerprint"),
    checkpoint: normalizeCheckpoint(value.checkpoint, "lease.checkpoint"),
    entryProof: normalizeStateProof(value.entryProof, "lease.entryProof"),
    acknowledged: normalizeAcknowledged(value.acknowledged, "lease.acknowledged"),
    pendingTick: normalizePendingTick(value.pendingTick, "lease.pendingTick"),
    pause: normalizePause(value.pause, "lease.pause"),
    finalization: normalizeFinalization(value.finalization, "lease.finalization"),
  };

  if (lease.entryProof.revision !== lease.checkpoint.revision) {
    throw leaseError("entry proof revision does not match the checkpoint");
  }
  const expectedAcknowledgedRevision = safeAdd(
    lease.checkpoint.revision,
    lease.acknowledged.sequence,
    "acknowledged revision",
  );
  if (lease.acknowledged.revision !== expectedAcknowledgedRevision ||
      lease.acknowledged.proof.revision !== lease.acknowledged.revision ||
      lease.acknowledged.checkpoint.revision !== lease.acknowledged.revision) {
    throw leaseError("acknowledged revision chain is invalid");
  }
  if ((lease.acknowledged.sequence === 0) !== (lease.acknowledged.commandId === null)) {
    throw leaseError("acknowledged command ID does not match its sequence");
  }
  if (lease.acknowledged.sequence === 0) {
    requireSameProof(lease.acknowledged.proof, lease.entryProof, "initial acknowledged proof");
    if (!sameValue(lease.acknowledged.checkpoint, lease.checkpoint)) {
      throw leaseError("initial acknowledged checkpoint differs from the entry checkpoint");
    }
  }

  if (lease.pendingTick !== null) {
    const expectedSequence = safeAdd(lease.acknowledged.sequence, 1, "pending sequence");
    const expectedRevision = safeAdd(lease.pendingTick.baseRevision, 1, "pending expected revision");
    const expectedDeadline = safeAdd(
      lease.acknowledged.settledDeadlineMs,
      EXACT_TICK_MILLISECONDS,
      "pending settled deadline",
    );
    if (lease.pendingTick.sequence !== expectedSequence ||
        lease.pendingTick.baseRevision !== lease.acknowledged.revision ||
        lease.pendingTick.expectedRevision !== expectedRevision ||
        lease.pendingTick.settledDeadlineMs !== expectedDeadline) {
      throw leaseError("pending exact tick is not the next acknowledged one-second revision");
    }
  }

  if (lease.phase === "prepared") {
    if (lease.acknowledged.sequence !== 0 || lease.pendingTick !== null || lease.pause !== null || lease.finalization !== null) {
      throw leaseError("prepared lease contains post-entry state");
    }
  } else if (lease.phase === "active") {
    if (lease.pause !== null || lease.finalization !== null) {
      throw leaseError("active lease contains paused or finalizing state");
    }
  } else if (lease.phase === "paused") {
    if (lease.pause === null || lease.finalization !== null) {
      throw leaseError("paused lease is missing its pause state");
    }
  } else if (lease.phase === "finalizing") {
    if (lease.pendingTick !== null || lease.finalization === null) {
      throw leaseError("finalizing lease has an unresolved tick or no finalization state");
    }
  }

  if (lease.finalization !== null) {
    if (lease.finalization.targetRevision !== lease.acknowledged.revision) {
      throw leaseError("finalization revision does not match the acknowledged revision");
    }
    requireSameProof(lease.finalization.targetProof, lease.acknowledged.proof, "finalization target proof");
    if (lease.finalization.checkpoint !== null &&
        lease.finalization.checkpoint.revision !== lease.finalization.targetRevision) {
      throw leaseError("finalization checkpoint does not match its target revision");
    }
    if (lease.finalization.status === "pending" && lease.finalization.publicPrimaryReadbackProof !== null) {
      throw leaseError("pending finalization already contains a public primary proof");
    }
    if (lease.finalization.status === "finalized") {
      if (lease.finalization.checkpoint === null || lease.finalization.publicPrimaryReadbackProof === null) {
        throw leaseError("finalized lease is missing a public primary readback proof");
      }
      validatePublicPrimaryReadbackProof(
        lease.finalization.publicPrimaryReadbackProof,
        lease.acknowledged,
        lease.registryFingerprint,
      );
    }
  }

  return lease;
}

function normalizeIdentityInput(value, label) {
  requireExactKeys(value, ["runId", "registryFingerprint"], label);
  return {
    runId: requireLogicalId(value.runId, 128, `${label}.runId`),
    registryFingerprint: requireLogicalId(value.registryFingerprint, 256, `${label}.registryFingerprint`),
  };
}

function requireLeaseIdentity(lease, identity) {
  if (lease.runId !== identity.runId || lease.registryFingerprint !== identity.registryFingerprint) {
    throw leaseError(
      "lease run or registry fingerprint conflicts with the caller",
      "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT",
    );
  }
}

function normalizePrepareInput(value) {
  requireExactKeys(value, ["runId", "registryFingerprint", "checkpoint", "proof", "settledDeadlineMs"], "prepare input");
  const result = {
    runId: requireLogicalId(value.runId, 128, "prepare input.runId"),
    registryFingerprint: requireLogicalId(value.registryFingerprint, 256, "prepare input.registryFingerprint"),
    checkpoint: normalizeCheckpoint(value.checkpoint, "prepare input.checkpoint"),
    proof: normalizeStateProof(value.proof, "prepare input.proof"),
    settledDeadlineMs: requireSafeInteger(value.settledDeadlineMs, 0, "prepare input.settledDeadlineMs"),
  };
  if (result.proof.revision !== result.checkpoint.revision) {
    throw leaseError("prepare proof revision does not match its checkpoint");
  }
  return result;
}

function normalizePauseInput(value) {
  requireExactKeys(value, ["runId", "registryFingerprint", "reasonCode"], "pause input");
  return {
    runId: requireLogicalId(value.runId, 128, "pause input.runId"),
    registryFingerprint: requireLogicalId(value.registryFingerprint, 256, "pause input.registryFingerprint"),
    reasonCode: requireLogicalId(value.reasonCode, 160, "pause input.reasonCode"),
  };
}

function normalizeTickInput(value) {
  requireExactKeys(value, [
    "runId",
    "registryFingerprint",
    "sequence",
    "commandId",
    "baseRevision",
    "expectedRevision",
    "simulationSeconds",
    "wallSeconds",
    "settledDeadlineMs",
  ], "tick input");
  return {
    runId: requireLogicalId(value.runId, 128, "tick input.runId"),
    registryFingerprint: requireLogicalId(value.registryFingerprint, 256, "tick input.registryFingerprint"),
    ...normalizePendingTick({
      sequence: value.sequence,
      commandId: value.commandId,
      baseRevision: value.baseRevision,
      expectedRevision: value.expectedRevision,
      simulationSeconds: value.simulationSeconds,
      wallSeconds: value.wallSeconds,
      settledDeadlineMs: value.settledDeadlineMs,
    }, "tick input"),
  };
}

function normalizeAckInput(value) {
  requireExactKeys(value, [
    "runId",
    "registryFingerprint",
    "sequence",
    "commandId",
    "revision",
    "proof",
    "checkpoint",
    "settledDeadlineMs",
  ], "ack input");
  return {
    runId: requireLogicalId(value.runId, 128, "ack input.runId"),
    registryFingerprint: requireLogicalId(value.registryFingerprint, 256, "ack input.registryFingerprint"),
    sequence: requireSafeInteger(value.sequence, 1, "ack input.sequence"),
    commandId: requireLogicalId(value.commandId, 128, "ack input.commandId"),
    revision: requireSafeInteger(value.revision, 1, "ack input.revision"),
    proof: normalizeStateProof(value.proof, "ack input.proof"),
    checkpoint: normalizeCheckpoint(value.checkpoint, "ack input.checkpoint"),
    settledDeadlineMs: requireSafeInteger(value.settledDeadlineMs, 0, "ack input.settledDeadlineMs"),
  };
}

function normalizeFinalizedInput(value, label) {
  requireExactKeys(value, ["runId", "registryFingerprint", "publicPrimaryReadbackProof"], label);
  return {
    runId: requireLogicalId(value.runId, 128, `${label}.runId`),
    registryFingerprint: requireLogicalId(value.registryFingerprint, 256, `${label}.registryFingerprint`),
    publicPrimaryReadbackProof: normalizePublicPrimaryReadbackProof(
      value.publicPrimaryReadbackProof,
      `${label}.publicPrimaryReadbackProof`,
    ),
  };
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateStorageDirectoryPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw leaseError(
      "storage directory must be an absolute main-process path",
      "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_PATH_INVALID",
    );
  }
  const resolved = path.resolve(value);
  if (path.basename(resolved) !== STORAGE_DIRECTORY_NAME) {
    throw leaseError(
      `storage directory must use the fixed ${STORAGE_DIRECTORY_NAME} subdirectory`,
      "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_PATH_INVALID",
    );
  }
  return resolved;
}

class NativeCoreExactRealtimeRustLeaseStore {
  constructor(options) {
    requireExactKeys(options, ["leaseRegistry"], "Rust lease store options");
    if (!options.leaseRegistry || typeof options.leaseRegistry.request !== "function") {
      throw new TypeError("Rust lease registry is invalid");
    }
    Object.defineProperty(this, "leaseRegistry", { value: options.leaseRegistry });
  }

  inspect() {
    return Promise.resolve()
      .then(() => this.leaseRegistry.request({ action: "inspect" }))
      .then((result) => {
        if (!isPlainRecord(result) || !["missing", "valid", "blocked"].includes(result.state)) {
          throw leaseError("Rust lease inspection response is invalid");
        }
        if (result.state === "valid") {
          requireExactKeys(result, ["state", "lease"], "Rust lease inspection response");
          return { state: "valid", lease: normalizeLease(result.lease) };
        }
        if (result.state === "missing") {
          requireExactKeys(result, ["state"], "Rust lease inspection response");
          return { state: "missing" };
        }
        requireExactKeys(result, ["state", "code"], "Rust lease inspection response");
        return {
          state: "blocked",
          code: requireLogicalId(result.code, 160, "Rust lease inspection code"),
        };
      });
  }

  mutate(request) {
    return Promise.resolve()
      .then(() => this.leaseRegistry.request(request))
      .then((lease) => normalizeLease(lease));
  }

  prepare(value) {
    const input = normalizePrepareInput(value);
    return this.mutate({ action: "prepare", ...input });
  }

  activate(value) {
    const input = normalizeIdentityInput(value, "activate input");
    return this.mutate({ action: "activate", ...input });
  }

  pause(value) {
    const input = normalizePauseInput(value);
    return this.mutate({ action: "pause", ...input });
  }

  stageExactTick(value) {
    const input = normalizeTickInput(value);
    return this.mutate({ action: "stageExactTick", ...input });
  }

  beginFinalizing(value) {
    const input = normalizeIdentityInput(value, "begin finalizing input");
    return this.mutate({ action: "beginFinalizing", ...input });
  }

  recordPublicPrimaryReadback(value) {
    const input = normalizeFinalizedInput(value, "record readback input");
    return this.mutate({ action: "recordPublicPrimaryReadback", ...input });
  }

  clearFinalized(value) {
    const input = normalizeFinalizedInput(value, "clear finalized input");
    return Promise.resolve()
      .then(() => this.leaseRegistry.request({ action: "clearFinalized", ...input }))
      .then((result) => {
        requireExactKeys(result, ["state"], "Rust lease clear response");
        if (result.state !== "missing") throw leaseError("Rust lease clear response is invalid");
        return { state: "missing" };
      });
  }
}

class NativeCoreExactRealtimeExperimentLeaseStore {
  constructor(options) {
    if (!isPlainRecord(options)) throw new TypeError("lease store options are required");
    const optionKeys = Reflect.ownKeys(options);
    const knownOptionKeys = new Set(["storageDirectoryPath", "fileSystem", "randomBytes"]);
    if (optionKeys.some((key) => typeof key !== "string" || !knownOptionKeys.has(key))) {
      throw new TypeError("lease store options contain an unknown field");
    }
    const fileSystem = options.fileSystem ?? fs;
    const randomBytes = options.randomBytes ?? crypto.randomBytes;
    if (typeof randomBytes !== "function") throw new TypeError("randomBytes must be a function");
    const storageDirectoryPath = validateStorageDirectoryPath(options.storageDirectoryPath);
    Object.defineProperties(this, {
      fileSystem: { value: fileSystem, enumerable: false },
      randomBytes: { value: randomBytes, enumerable: false },
      storageDirectoryPath: { value: storageDirectoryPath, enumerable: true },
      leaseFilePath: { value: path.join(storageDirectoryPath, LEASE_FILE_NAME), enumerable: true },
    });
  }

  inspect() {
    try {
      const lease = this.readLease();
      return lease === null
        ? { state: "missing" }
        : { state: "valid", lease };
    } catch (error) {
      return {
        state: "blocked",
        code: typeof error?.code === "string"
          ? error.code
          : "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_IO_FAILED",
      };
    }
  }

  readLease() {
    const record = this.readLeaseRecord();
    return record === null ? null : cloneValue(record.lease);
  }

  prepare(value) {
    const input = normalizePrepareInput(value);
    const current = this.readLease();
    const next = normalizeLease({
      schemaVersion: SCHEMA_VERSION,
      kind: LEASE_KIND,
      phase: "prepared",
      runId: input.runId,
      mode: "normal",
      slot: "normal-main",
      registryFingerprint: input.registryFingerprint,
      checkpoint: input.checkpoint,
      entryProof: input.proof,
      acknowledged: {
        sequence: 0,
        commandId: null,
        revision: input.checkpoint.revision,
        proof: input.proof,
        checkpoint: input.checkpoint,
        settledDeadlineMs: input.settledDeadlineMs,
      },
      pendingTick: null,
      pause: null,
      finalization: null,
    });
    if (current !== null) {
      if (sameValue(current, next)) return current;
      throw leaseError(
        "a different experiment lease already exists",
        "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT",
      );
    }
    return this.writeLease(next);
  }

  activate(value) {
    const identity = normalizeIdentityInput(value, "activate input");
    const current = this.requireLease();
    requireLeaseIdentity(current, identity);
    if (current.phase === "active") return current;
    if (current.phase !== "prepared" && current.phase !== "paused") {
      throw leaseError("lease cannot activate from its current phase", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_TRANSITION_INVALID");
    }
    if (current.pendingTick !== null) {
      throw leaseError("lease cannot resume while an exact tick is unresolved", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_TRANSITION_INVALID");
    }
    return this.writeLease(normalizeLease({
      ...current,
      phase: "active",
      pause: null,
    }));
  }

  pause(value) {
    const input = normalizePauseInput(value);
    const current = this.requireLease();
    requireLeaseIdentity(current, input);
    if (current.phase === "paused") {
      if (current.pause.reasonCode === input.reasonCode) return current;
      throw leaseError("paused lease reason conflicts with the stored reason", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT");
    }
    if (current.phase !== "active") {
      throw leaseError("only an active lease can pause", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_TRANSITION_INVALID");
    }
    return this.writeLease(normalizeLease({
      ...current,
      phase: "paused",
      pause: { reasonCode: input.reasonCode },
    }));
  }

  stageExactTick(value) {
    const input = normalizeTickInput(value);
    const current = this.requireLease();
    requireLeaseIdentity(current, input);

    const pendingTick = {
      sequence: input.sequence,
      commandId: input.commandId,
      baseRevision: input.baseRevision,
      expectedRevision: input.expectedRevision,
      simulationSeconds: input.simulationSeconds,
      wallSeconds: input.wallSeconds,
      settledDeadlineMs: input.settledDeadlineMs,
    };

    if (current.pendingTick !== null) {
      if (sameValue(current.pendingTick, pendingTick)) return current;
      throw leaseError("a different exact tick is already pending", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT");
    }

    if (current.acknowledged.sequence > 0 &&
        input.sequence === current.acknowledged.sequence &&
        input.commandId === current.acknowledged.commandId) {
      const acknowledgedTick = {
        sequence: current.acknowledged.sequence,
        commandId: current.acknowledged.commandId,
        baseRevision: current.acknowledged.revision - 1,
        expectedRevision: current.acknowledged.revision,
        simulationSeconds: EXACT_TICK_SECONDS,
        wallSeconds: EXACT_TICK_SECONDS,
        settledDeadlineMs: current.acknowledged.settledDeadlineMs,
      };
      if (sameValue(acknowledgedTick, pendingTick)) return current;
      throw leaseError("replayed exact tick conflicts with its acknowledged command", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT");
    }

    if (current.phase !== "active") {
      throw leaseError("only an active lease can stage a tick", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_TRANSITION_INVALID");
    }
    const expectedSequence = safeAdd(current.acknowledged.sequence, 1, "next tick sequence");
    const expectedRevision = safeAdd(current.acknowledged.revision, 1, "next tick revision");
    const expectedDeadline = safeAdd(
      current.acknowledged.settledDeadlineMs,
      EXACT_TICK_MILLISECONDS,
      "next tick deadline",
    );
    if (input.sequence !== expectedSequence ||
        input.baseRevision !== current.acknowledged.revision ||
        input.expectedRevision !== expectedRevision ||
        input.settledDeadlineMs !== expectedDeadline) {
      throw leaseError("exact tick is not the next one-second revision", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT");
    }
    return this.writeLease(normalizeLease({
      ...current,
      pendingTick,
    }));
  }

  acknowledgeExactTick(value) {
    const input = normalizeAckInput(value);
    const current = this.requireLease();
    requireLeaseIdentity(current, input);
    if (input.proof.revision !== input.revision || input.checkpoint.revision !== input.revision) {
      throw leaseError("ACK proof or checkpoint revision does not match its revision");
    }

    if (current.pendingTick === null) {
      const duplicate = current.acknowledged.sequence === input.sequence &&
        current.acknowledged.commandId === input.commandId &&
        current.acknowledged.revision === input.revision &&
        current.acknowledged.settledDeadlineMs === input.settledDeadlineMs &&
        sameValue(current.acknowledged.proof, input.proof) &&
        sameValue(current.acknowledged.checkpoint, input.checkpoint);
      if (duplicate) return current;
      throw leaseError("ACK has no matching pending exact tick", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT");
    }

    const pending = current.pendingTick;
    if (input.sequence !== pending.sequence ||
        input.commandId !== pending.commandId ||
        input.revision !== pending.expectedRevision ||
        input.settledDeadlineMs !== pending.settledDeadlineMs) {
      throw leaseError("ACK skips or conflicts with the pending exact tick", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT");
    }
    return this.writeLease(normalizeLease({
      ...current,
      acknowledged: {
        sequence: input.sequence,
        commandId: input.commandId,
        revision: input.revision,
        proof: input.proof,
        checkpoint: input.checkpoint,
        settledDeadlineMs: input.settledDeadlineMs,
      },
      pendingTick: null,
    }));
  }

  beginFinalizing(value) {
    const identity = normalizeIdentityInput(value, "begin finalizing input");
    const current = this.requireLease();
    requireLeaseIdentity(current, identity);
    if (current.phase === "finalizing") return current;
    if ((current.phase !== "active" && current.phase !== "paused") || current.pendingTick !== null) {
      throw leaseError(
        "lease cannot finalize before all exact ticks are acknowledged",
        "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_TRANSITION_INVALID",
      );
    }
    return this.writeLease(normalizeLease({
      ...current,
      phase: "finalizing",
      finalization: {
        status: "pending",
        targetRevision: current.acknowledged.revision,
        targetProof: current.acknowledged.proof,
        checkpoint: current.acknowledged.checkpoint,
        publicPrimaryReadbackProof: null,
      },
    }));
  }

  recordPublicPrimaryReadback(value) {
    const input = normalizeFinalizedInput(value, "record readback input");
    const current = this.requireLease();
    requireLeaseIdentity(current, input);
    if (current.phase !== "finalizing" || current.finalization === null) {
      throw leaseError("lease is not finalizing", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_TRANSITION_INVALID");
    }
    validatePublicPrimaryReadbackProof(
      input.publicPrimaryReadbackProof,
      current.acknowledged,
      current.registryFingerprint,
    );
    if (current.finalization.status === "finalized") {
      if (sameValue(current.finalization.publicPrimaryReadbackProof, input.publicPrimaryReadbackProof)) return current;
      throw leaseError("finalized public primary proof conflicts with the stored proof", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT");
    }
    return this.writeLease(normalizeLease({
      ...current,
      finalization: {
        ...current.finalization,
        status: "finalized",
        publicPrimaryReadbackProof: input.publicPrimaryReadbackProof,
      },
    }));
  }

  clearFinalized(value) {
    const input = normalizeFinalizedInput(value, "clear finalized input");
    const current = this.requireLease();
    requireLeaseIdentity(current, input);
    if (current.phase !== "finalizing" || current.finalization?.status !== "finalized") {
      throw leaseError(
        "lease cannot clear before public primary finalization",
        "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_TRANSITION_INVALID",
      );
    }
    validatePublicPrimaryReadbackProof(
      input.publicPrimaryReadbackProof,
      current.acknowledged,
      current.registryFingerprint,
    );
    if (!sameValue(current.finalization.publicPrimaryReadbackProof, input.publicPrimaryReadbackProof)) {
      throw leaseError("clear proof does not match the finalized readback proof", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_CONFLICT");
    }
    this.fileSystem.unlinkSync(this.leaseFilePath);
    this.syncStorageDirectory();
    if (this.readLease() !== null) {
      throw leaseError("lease clear readback failed", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_READBACK_FAILED");
    }
    return { state: "missing" };
  }

  requireLease() {
    const lease = this.readLease();
    if (lease === null) {
      throw leaseError("experiment lease is missing", "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_LEASE_MISSING");
    }
    return lease;
  }

  readLeaseRecord() {
    let directoryStat;
    try {
      directoryStat = this.fileSystem.lstatSync(this.storageDirectoryPath);
    } catch (error) {
      if (isMissingError(error)) return null;
      throw error;
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw leaseError(
        "lease storage directory is not a direct directory",
        "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_PATH_INVALID",
      );
    }

    let fileStat;
    try {
      fileStat = this.fileSystem.lstatSync(this.leaseFilePath);
    } catch (error) {
      if (isMissingError(error)) return null;
      throw error;
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw leaseError("lease path is not a regular file");
    }
    if (fileStat.size < 1 || fileStat.size > MAX_LEASE_BYTES) {
      throw leaseError("lease file size is invalid");
    }
    const raw = this.fileSystem.readFileSync(this.leaseFilePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") !== fileStat.size || Buffer.byteLength(raw, "utf8") > MAX_LEASE_BYTES) {
      throw leaseError("lease changed while it was being read");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw leaseError("lease JSON is corrupt");
    }
    return { raw, lease: normalizeLease(parsed) };
  }

  ensureStorageDirectory() {
    this.fileSystem.mkdirSync(this.storageDirectoryPath, { recursive: true, mode: 0o700 });
    const stat = this.fileSystem.lstatSync(this.storageDirectoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw leaseError(
        "lease storage directory is not a direct directory",
        "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_PATH_INVALID",
      );
    }
  }

  writeLease(value) {
    const normalized = normalizeLease(value);
    const encoded = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_LEASE_BYTES) {
      throw leaseError("lease exceeds its storage bound");
    }
    this.ensureStorageDirectory();

    const nonceValue = this.randomBytes(12);
    const nonce = Buffer.isBuffer(nonceValue)
      ? nonceValue.toString("hex")
      : String(nonceValue);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) {
      throw new TypeError("randomBytes returned an invalid lease nonce");
    }
    const temporaryPath = path.join(
      this.storageDirectoryPath,
      `.${LEASE_FILE_NAME}.${process.pid}.${nonce}.tmp`,
    );
    let temporaryCreated = false;
    let published = false;
    let descriptor;
    try {
      descriptor = this.fileSystem.openSync(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      this.fileSystem.writeFileSync(descriptor, encoded, "utf8");
      this.fileSystem.fsyncSync(descriptor);
      this.fileSystem.closeSync(descriptor);
      descriptor = undefined;
      this.fileSystem.renameSync(temporaryPath, this.leaseFilePath);
      published = true;
      this.syncStorageDirectory();

      const readback = this.readLeaseRecord();
      if (readback === null || readback.raw !== encoded || !sameValue(readback.lease, normalized)) {
        throw leaseError(
          "lease atomic write readback did not match",
          "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_READBACK_FAILED",
        );
      }
      return cloneValue(readback.lease);
    } finally {
      if (descriptor !== undefined) {
        try {
          this.fileSystem.closeSync(descriptor);
        } catch {
          // The original write failure remains the actionable fault.
        }
      }
      if (temporaryCreated && !published) {
        try {
          this.fileSystem.unlinkSync(temporaryPath);
        } catch (error) {
          if (!isMissingError(error)) {
            // A stranded temp file is never treated as a committed lease.
          }
        }
      }
    }
  }

  syncStorageDirectory() {
    let descriptor;
    try {
      descriptor = this.fileSystem.openSync(this.storageDirectoryPath, "r");
      this.fileSystem.fsyncSync(descriptor);
    } catch (error) {
      if (process.platform === "win32" && ["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(error?.code)) {
        return;
      }
      throw error;
    } finally {
      if (descriptor !== undefined) {
        this.fileSystem.closeSync(descriptor);
      }
    }
  }
}

function createTestOnlyNativeCoreExactRealtimeExperimentLeaseStore(options) {
  if (!isPlainRecord(options) || typeof options.storageDirectoryPath !== "string") {
    throw new TypeError("test-only lease store options are required");
  }
  const temporaryRoot = path.resolve(os.tmpdir());
  const storageDirectoryPath = path.resolve(options.storageDirectoryPath);
  const relative = path.relative(temporaryRoot, storageDirectoryPath);
  if (relative.length === 0 || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw leaseError(
      "legacy JavaScript lease persistence is test-only and must stay under the operating-system temporary root",
      "NATIVE_CORE_EXACT_REALTIME_EXPERIMENT_PATH_INVALID",
    );
  }
  return new NativeCoreExactRealtimeExperimentLeaseStore(options);
}

module.exports = {
  EXACT_TICK_MILLISECONDS,
  EXACT_TICK_SECONDS,
  LEASE_FILE_NAME,
  LEASE_KIND,
  MAX_LEASE_BYTES,
  NativeCoreExactRealtimeExperimentLeaseError,
  NativeCoreExactRealtimeRustLeaseStore,
  SCHEMA_VERSION,
  STORAGE_DIRECTORY_NAME,
  createTestOnlyNativeCoreExactRealtimeExperimentLeaseStore,
  normalizeLease,
};
