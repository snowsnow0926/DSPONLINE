"use strict";

/*
 * E1 main-process experiment only. This module deliberately has no Electron,
 * renderer, JavaScript-simulation, authority promotion, or checkpoint-install
 * dependency. It cannot make native state player-authoritative. It accepts only
 * the Rust SaveStore-backed v2 lease adapter, whose files share the SaveStore
 * lifetime root lock and Windows WRITE_THROUGH publication path.
 */

const crypto = require("node:crypto");

const {
  EXACT_TICK_MILLISECONDS,
  EXACT_TICK_SECONDS,
  NativeCoreExactRealtimeRustLeaseStore,
} = require("./native-core-exact-realtime-experiment.cjs");

const NORMAL_MODE = "normal";
const NORMAL_SLOT = "normal-main";
const STATE_VERSION = 47;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{8,128}$/;
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

class NativeCoreExactRealtimeOrchestratorError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "NativeCoreExactRealtimeOrchestratorError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function orchestratorError(message, code = "NATIVE_CORE_EXACT_REALTIME_E1_INVALID", cause) {
  return new NativeCoreExactRealtimeOrchestratorError(message, code, cause);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireOnlyKeys(value, allowedKeys, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`);
  const allowed = new Set(allowedKeys);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} contains an unknown field`);
  }
}

function requireRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw orchestratorError(`${label} is invalid`);
  }
  return value;
}

function requireLogicalId(value, maximumLength, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength || !LOGICAL_ID_PATTERN.test(value)) {
    throw orchestratorError(`${label} is invalid`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw orchestratorError(`${label} is invalid`);
  }
  return value;
}

function requireChecksum(value, label) {
  if (typeof value !== "string" || !CHECKSUM_PATTERN.test(value)) {
    throw orchestratorError(`${label} is invalid`);
  }
  return value;
}

function requireSafeInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw orchestratorError(`${label} is invalid`);
  }
  return value;
}

function safeAdd(value, increment, label) {
  const result = value + increment;
  if (!Number.isSafeInteger(result)) throw orchestratorError(`${label} exceeds the safe integer range`);
  return result;
}

function normalizeCallOptions(value, label) {
  if (value === undefined) return { signal: undefined };
  requireOnlyKeys(value, ["signal"], label);
  const signal = value.signal;
  if (signal !== undefined &&
      (signal === null || typeof signal !== "object" || typeof signal.aborted !== "boolean")) {
    throw new TypeError(`${label}.signal is invalid`);
  }
  return { signal };
}

function abortError() {
  const error = new Error("native exact realtime operation was cancelled");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function failureReason(prefix, error) {
  return error?.name === "AbortError" ? `${prefix}-cancelled` : `${prefix}-failed`;
}

function deriveRunToken(runId) {
  requireLogicalId(runId, 128, "runId");
  return crypto.createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 40);
}

function deriveExactTickCommandId(runId, sequence) {
  requireSafeInteger(sequence, 1, "tick sequence");
  return `e1:${deriveRunToken(runId)}:tick:${sequence}`;
}

function deriveFinalExportId(runId, revision) {
  requireSafeInteger(revision, 0, "final export revision");
  return `e1-${deriveRunToken(runId)}-r${revision}`;
}

function derivePublicCommitId(runId, revision) {
  requireSafeInteger(revision, 0, "public commit revision");
  return `e1:${deriveRunToken(runId)}:public:${revision}`;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function proofFromSummary(summary, expectedRevision, registryFingerprint, label) {
  requireRecord(summary, label);
  if (summary.revision !== expectedRevision || summary.stateVersion !== STATE_VERSION ||
      summary.mode !== NORMAL_MODE || summary.paused !== false ||
      summary.registryFingerprint !== registryFingerprint) {
    throw orchestratorError(
      `${label} identity does not match the exact normal-main lease`,
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  return {
    revision: expectedRevision,
    canonicalSha256: requireSha256(summary.canonicalSha256, `${label}.canonicalSha256`),
    domainSha256: requireSha256(summary.domainSha256, `${label}.domainSha256`),
  };
}

function requireMatchingProof(actual, expected, label) {
  if (!sameValue(actual, expected)) {
    throw orchestratorError(
      `${label} does not match the durable lease proof`,
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
}

function normalizeCommitReceipt(value, pending, registryFingerprint) {
  requireRecord(value, "native commit receipt");
  if (value.commandId !== pending.commandId || value.baseRevision !== pending.baseRevision ||
      value.revision !== pending.expectedRevision || value.currentRevision !== pending.expectedRevision ||
      typeof value.duplicate !== "boolean") {
    throw orchestratorError(
      "native commit receipt is not the staged exact tick",
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  const proof = proofFromSummary(
    value.summary,
    pending.expectedRevision,
    registryFingerprint,
    "native commit summary",
  );
  return {
    commandId: value.commandId,
    baseRevision: value.baseRevision,
    revision: value.revision,
    currentRevision: value.currentRevision,
    duplicate: value.duplicate,
    proof,
  };
}

function normalizeCheckpointReceipt(value, acknowledged, registryFingerprint) {
  requireRecord(value, "native checkpoint receipt");
  const checkpoint = requireRecord(value.checkpoint, "native checkpoint identity");
  if ((checkpoint.slot !== undefined && checkpoint.slot !== NORMAL_SLOT) ||
      checkpoint.revision !== acknowledged.revision) {
    throw orchestratorError(
      "native checkpoint revision or slot does not match the lease",
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  requireSafeInteger(checkpoint.generation, 1, "native checkpoint generation");
  requireSha256(checkpoint.rootHash, "native checkpoint rootHash");
  const proof = proofFromSummary(
    value.summary,
    acknowledged.revision,
    registryFingerprint,
    "native checkpoint summary",
  );
  requireMatchingProof(proof, acknowledged.proof, "native checkpoint proof");
  return {
    generation: checkpoint.generation,
    rootHash: checkpoint.rootHash,
    revision: checkpoint.revision,
    proof,
  };
}

function normalizeCheckpointAckReceipt(value, pending, registryFingerprint, expectedProof) {
  requireRecord(value, "native checkpoint ACK receipt");
  if (typeof value.duplicate !== "boolean") {
    throw orchestratorError(
      "native checkpoint ACK duplicate marker is invalid",
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  const checkpoint = requireRecord(value.checkpoint, "native checkpoint ACK identity");
  requireSha256(checkpoint.rootHash, "native checkpoint ACK rootHash");
  if (!Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1 ||
      checkpoint.revision !== pending.expectedRevision) {
    throw orchestratorError(
      "native checkpoint ACK identity does not match the staged tick",
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  const proof = proofFromSummary(
    value.summary,
    pending.expectedRevision,
    registryFingerprint,
    "native checkpoint ACK summary",
  );
  requireMatchingProof(proof, expectedProof, "native checkpoint ACK proof");
  const lease = requireRecord(value.lease, "native checkpoint ACK lease");
  if (lease.pendingTick !== null || lease.registryFingerprint !== registryFingerprint ||
      lease.acknowledged?.sequence !== pending.sequence ||
      lease.acknowledged?.commandId !== pending.commandId ||
      lease.acknowledged?.revision !== pending.expectedRevision ||
      lease.acknowledged?.settledDeadlineMs !== pending.settledDeadlineMs ||
      !sameValue(lease.acknowledged?.proof, proof) ||
      !sameValue(lease.acknowledged?.checkpoint, checkpoint)) {
    throw orchestratorError(
      "native checkpoint ACK lease does not close the staged tick",
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  return { checkpoint: { ...checkpoint }, proof, lease, duplicate: value.duplicate };
}

function normalizeExportReceipt(value, expected) {
  requireRecord(value, "native v47 export receipt");
  const result = requireRecord(value.result, "native v47 export result");
  if (value.exportId !== expected.exportId || value.mode !== NORMAL_MODE ||
      result.revision !== expected.revision || result.savedAtMs !== expected.savedAtMs) {
    throw orchestratorError(
      "native v47 export identity does not match finalization",
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  if (typeof value.openStream !== "function") {
    throw orchestratorError(
      "native v47 export did not provide a bounded stream opener",
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  return {
    exportId: value.exportId,
    mode: value.mode,
    revision: result.revision,
    savedAtMs: result.savedAtMs,
    byteLength: requireSafeInteger(result.byteLength, 1, "native v47 export byteLength"),
    payloadSha256: requireSha256(result.envelopeSha256, "native v47 export envelopeSha256"),
    baseChecksum: requireChecksum(result.stateChecksum, "native v47 export stateChecksum"),
    openStream: value.openStream.bind(value),
  };
}

function normalizeWriterIdentity(value, expected, label, requireStream) {
  requireRecord(value, label);
  if (value.commitId !== expected.commitId || value.slot !== NORMAL_SLOT || value.mode !== NORMAL_MODE ||
      value.revision !== expected.revision || value.savedAtMs !== expected.savedAtMs ||
      value.registryFingerprint !== expected.registryFingerprint ||
      value.payloadSha256 !== expected.payloadSha256 || value.baseChecksum !== expected.baseChecksum ||
      value.byteLength !== expected.byteLength) {
    throw orchestratorError(
      `${label} identity does not match the native export`,
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  if (requireStream && typeof value.openStream !== "function") {
    throw orchestratorError(
      `${label} did not provide a readback stream`,
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  if (!requireStream && typeof value.duplicate !== "boolean") {
    throw orchestratorError(
      `${label}.duplicate is invalid`,
      "NATIVE_CORE_EXACT_REALTIME_E1_RECEIPT_INVALID",
    );
  }
  return value;
}

function normalizeByteChunk(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw orchestratorError(`${label} yielded a non-byte chunk`);
}

async function resolveByteIterable(value, label) {
  const resolved = await value;
  if (Buffer.isBuffer(resolved) || resolved instanceof Uint8Array || resolved instanceof ArrayBuffer) {
    return (async function* oneChunk() {
      yield normalizeByteChunk(resolved, label);
    }());
  }
  if (resolved && typeof resolved[Symbol.asyncIterator] === "function") return resolved;
  if (resolved && typeof resolved[Symbol.iterator] === "function" && typeof resolved !== "string") return resolved;
  throw orchestratorError(`${label} is not a byte stream`);
}

function verifyingByteStream(iterable, expected, signal, state, label) {
  return (async function* verify() {
    const hash = crypto.createHash("sha256");
    let byteLength = 0;
    for await (const rawChunk of iterable) {
      throwIfAborted(signal);
      const chunk = normalizeByteChunk(rawChunk, label);
      byteLength = safeAdd(byteLength, chunk.byteLength, `${label} byteLength`);
      hash.update(chunk);
      yield chunk;
    }
    throwIfAborted(signal);
    const payloadSha256 = hash.digest("hex");
    if (byteLength !== expected.byteLength || payloadSha256 !== expected.payloadSha256) {
      throw orchestratorError(
        `${label} bytes do not match the native export`,
        "NATIVE_CORE_EXACT_REALTIME_E1_READBACK_INVALID",
      );
    }
    state.completed = true;
  }());
}

function normalizedByteChunks(iterable, signal, label) {
  return (async function* normalize() {
    for await (const rawChunk of iterable) {
      throwIfAborted(signal);
      const chunk = normalizeByteChunk(rawChunk, label);
      if (chunk.byteLength > 0) yield chunk;
    }
    throwIfAborted(signal);
  }());
}

async function compareByteStreams(expectedIterable, actualIterable, expectedIdentity, signal) {
  const expectedIterator = normalizedByteChunks(
    expectedIterable,
    signal,
    "native v47 verification stream",
  )[Symbol.asyncIterator]();
  const actualIterator = normalizedByteChunks(
    actualIterable,
    signal,
    "public primary readback stream",
  )[Symbol.asyncIterator]();
  const expectedHash = crypto.createHash("sha256");
  const actualHash = crypto.createHash("sha256");
  let expectedChunk = Buffer.alloc(0);
  let actualChunk = Buffer.alloc(0);
  let expectedOffset = 0;
  let actualOffset = 0;
  let expectedDone = false;
  let actualDone = false;
  let byteLength = 0;

  try {
    while (true) {
      if (expectedOffset === expectedChunk.byteLength && !expectedDone) {
        const next = await expectedIterator.next();
        expectedDone = next.done === true;
        expectedChunk = expectedDone ? Buffer.alloc(0) : next.value;
        expectedOffset = 0;
        if (!expectedDone) expectedHash.update(expectedChunk);
      }
      if (actualOffset === actualChunk.byteLength && !actualDone) {
        const next = await actualIterator.next();
        actualDone = next.done === true;
        actualChunk = actualDone ? Buffer.alloc(0) : next.value;
        actualOffset = 0;
        if (!actualDone) actualHash.update(actualChunk);
      }
      if (expectedDone || actualDone) {
        if (expectedDone && actualDone) break;
        throw orchestratorError(
          "public primary readback ended at a different byte boundary",
          "NATIVE_CORE_EXACT_REALTIME_E1_READBACK_INVALID",
        );
      }
      const comparedBytes = Math.min(
        expectedChunk.byteLength - expectedOffset,
        actualChunk.byteLength - actualOffset,
      );
      if (Buffer.compare(
        expectedChunk.subarray(expectedOffset, expectedOffset + comparedBytes),
        actualChunk.subarray(actualOffset, actualOffset + comparedBytes),
      ) !== 0) {
        throw orchestratorError(
          "public primary readback differs from the native export bytes",
          "NATIVE_CORE_EXACT_REALTIME_E1_READBACK_INVALID",
        );
      }
      byteLength = safeAdd(byteLength, comparedBytes, "public primary compared byteLength");
      expectedOffset += comparedBytes;
      actualOffset += comparedBytes;
    }

    const expectedSha256 = expectedHash.digest("hex");
    const actualSha256 = actualHash.digest("hex");
    if (byteLength !== expectedIdentity.byteLength ||
        expectedSha256 !== expectedIdentity.payloadSha256 ||
        actualSha256 !== expectedIdentity.payloadSha256) {
      throw orchestratorError(
        "public primary byte-for-byte readback identity does not match the native export",
        "NATIVE_CORE_EXACT_REALTIME_E1_READBACK_INVALID",
      );
    }
    return { byteLength, payloadSha256: actualSha256 };
  } finally {
    const closes = [];
    if (typeof expectedIterator.return === "function") closes.push(expectedIterator.return());
    if (typeof actualIterator.return === "function") closes.push(actualIterator.return());
    if (closes.length > 0) {
      await Promise.allSettled(closes);
    }
  }
}

class NativeCoreExactRealtimeOrchestrator {
  constructor(options) {
    requireOnlyKeys(options, ["leaseStore", "nativeCoreProvider", "publicPrimaryWriter"], "orchestrator options");
    if (!(options.leaseStore instanceof NativeCoreExactRealtimeRustLeaseStore) ||
        typeof options.leaseStore.inspect !== "function" ||
        typeof options.leaseStore.activate !== "function" || typeof options.leaseStore.pause !== "function" ||
        typeof options.leaseStore.stageExactTick !== "function" ||
        typeof options.leaseStore.beginFinalizing !== "function" ||
        typeof options.leaseStore.recordPublicPrimaryReadback !== "function" ||
        typeof options.leaseStore.clearFinalized !== "function") {
      throw new TypeError("orchestrator leaseStore is invalid");
    }
    if (typeof options.nativeCoreProvider !== "function") {
      throw new TypeError("orchestrator nativeCoreProvider is invalid");
    }
    if (!options.publicPrimaryWriter || typeof options.publicPrimaryWriter.commit !== "function" ||
        typeof options.publicPrimaryWriter.readback !== "function") {
      throw new TypeError("orchestrator publicPrimaryWriter is invalid");
    }
    Object.defineProperties(this, {
      leaseStore: { value: options.leaseStore },
      nativeCoreProvider: { value: options.nativeCoreProvider },
      publicPrimaryWriter: { value: options.publicPrimaryWriter },
      lifecycleInFlight: { value: null, writable: true },
    });
  }

  async inspect() {
    return await this.leaseStore.inspect();
  }

  activate(value) {
    let options;
    try {
      options = normalizeCallOptions(value, "activate options");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.runLifecycleOperation("activate", () => this.performActivation(options));
  }

  async performActivation({ signal }) {
    try {
      throwIfAborted(signal);
      const lease = await this.requireValidLease();
      if (lease.pendingTick !== null) {
        throw orchestratorError("pending exact tick must recover before activation");
      }
      if (lease.phase !== "prepared" && lease.phase !== "paused" && lease.phase !== "active") {
        throw orchestratorError("lease cannot activate from its current phase");
      }
      const nativeCore = await this.getNativeCore(["status"]);
      const summary = await nativeCore.status({ signal });
      throwIfAborted(signal);
      const proof = proofFromSummary(
        summary,
        lease.acknowledged.revision,
        lease.registryFingerprint,
        "native activation summary",
      );
      requireMatchingProof(proof, lease.acknowledged.proof, "native activation proof");
      return await this.leaseStore.activate(this.identityOf(lease));
    } catch (error) {
      throw await this.persistPausedFailure("e1-activate", error);
    }
  }

  tick(value) {
    const options = normalizeCallOptions(value, "tick options");
    return this.runLifecycleOperation("tick", () => this.performTick(options));
  }

  async performTick({ signal }) {
    try {
      throwIfAborted(signal);
      let lease = await this.requireValidLease();
      if (lease.phase !== "active" || lease.pendingTick !== null) {
        throw orchestratorError("only an active lease without pending work can tick");
      }
      const sequence = safeAdd(lease.acknowledged.sequence, 1, "next exact tick sequence");
      const expectedRevision = safeAdd(lease.acknowledged.revision, 1, "next exact tick revision");
      const settledDeadlineMs = safeAdd(
        lease.acknowledged.settledDeadlineMs,
        EXACT_TICK_MILLISECONDS,
        "next exact tick deadline",
      );
      const commandId = deriveExactTickCommandId(lease.runId, sequence);
      lease = await this.leaseStore.stageExactTick({
        ...this.identityOf(lease),
        sequence,
        commandId,
        baseRevision: lease.acknowledged.revision,
        expectedRevision,
        simulationSeconds: EXACT_TICK_SECONDS,
        wallSeconds: EXACT_TICK_SECONDS,
        settledDeadlineMs,
      });
      const pending = lease.pendingTick;
      throwIfAborted(signal);
      const nativeCore = await this.getNativeCore([
        "commitOperationExactRealtime",
        "checkpointAndAcknowledgeExactRealtime",
      ]);
      const rawReceipt = await nativeCore.commitOperationExactRealtime(
        this.identityOf(lease),
        { signal },
      );
      throwIfAborted(signal);
      const receipt = normalizeCommitReceipt(rawReceipt, pending, lease.registryFingerprint);
      const current = await this.requireValidLease();
      if ((current.phase !== "active" && current.phase !== "paused") ||
          !sameValue(current.pendingTick, pending) ||
          current.acknowledged.revision !== pending.baseRevision ||
          current.registryFingerprint !== lease.registryFingerprint) {
        throw orchestratorError(
          "durable pending tick changed before ACK",
          "NATIVE_CORE_EXACT_REALTIME_E1_LEASE_CONFLICT",
        );
      }
      const rawAcknowledged = await nativeCore.checkpointAndAcknowledgeExactRealtime({
        ...this.identityOf(current),
        sequence: pending.sequence,
        commandId: pending.commandId,
        settledDeadlineMs: pending.settledDeadlineMs,
      }, { signal });
      const acknowledged = normalizeCheckpointAckReceipt(
        rawAcknowledged,
        pending,
        lease.registryFingerprint,
        receipt.proof,
      );
      return {
        commandId: pending.commandId,
        sequence: pending.sequence,
        revision: receipt.revision,
        proof: receipt.proof,
        settledDeadlineMs: pending.settledDeadlineMs,
        duplicate: receipt.duplicate || acknowledged.duplicate,
        checkpoint: acknowledged.checkpoint,
        lease: acknowledged.lease,
      };
    } catch (error) {
      throw await this.persistPausedFailure("e1-tick", error);
    }
  }

  recoverPending(value) {
    const options = normalizeCallOptions(value, "recover options");
    return this.runLifecycleOperation("recover", () => this.performRecovery(options));
  }

  async performRecovery({ signal }) {
    try {
      throwIfAborted(signal);
      let lease = await this.requireValidLease();
      if (lease.pendingTick === null) {
        const nativeCore = await this.getNativeCore(["status"]);
        const summary = await nativeCore.status({ signal });
        throwIfAborted(signal);
        const proof = proofFromSummary(
          summary,
          lease.acknowledged.revision,
          lease.registryFingerprint,
          "native recovery summary",
        );
        requireMatchingProof(proof, lease.acknowledged.proof, "native recovery proof");
        return { recovered: false, lease };
      }
      if (lease.phase === "active") {
        lease = await this.leaseStore.pause({
          ...this.identityOf(lease),
          reasonCode: "e1-recovering-pending",
        });
      }
      if (lease.phase !== "paused") {
        throw orchestratorError("pending recovery requires an active or paused lease");
      }
      const pending = lease.pendingTick;
      const derivedCommandId = deriveExactTickCommandId(lease.runId, pending.sequence);
      if (pending.commandId !== derivedCommandId) {
        throw orchestratorError(
          "pending command ID is not derived from the lease run and sequence",
          "NATIVE_CORE_EXACT_REALTIME_E1_LEASE_CONFLICT",
        );
      }
      throwIfAborted(signal);
      const nativeCore = await this.getNativeCore([
        "commitOperationExactRealtime",
        "checkpointAndAcknowledgeExactRealtime",
      ]);
      const rawReceipt = await nativeCore.commitOperationExactRealtime(
        this.identityOf(lease),
        { signal },
      );
      throwIfAborted(signal);
      const receipt = normalizeCommitReceipt(rawReceipt, pending, lease.registryFingerprint);
      const current = await this.requireValidLease();
      if (current.phase !== "paused" || !sameValue(current.pendingTick, pending)) {
        throw orchestratorError(
          "pending recovery lease changed before ACK",
          "NATIVE_CORE_EXACT_REALTIME_E1_LEASE_CONFLICT",
        );
      }
      const rawAcknowledged = await nativeCore.checkpointAndAcknowledgeExactRealtime({
        ...this.identityOf(current),
        sequence: pending.sequence,
        commandId: pending.commandId,
        settledDeadlineMs: pending.settledDeadlineMs,
      }, { signal });
      const acknowledged = normalizeCheckpointAckReceipt(
        rawAcknowledged,
        pending,
        lease.registryFingerprint,
        receipt.proof,
      );
      return {
        recovered: true,
        commandId: pending.commandId,
        revision: receipt.revision,
        proof: receipt.proof,
        settledDeadlineMs: pending.settledDeadlineMs,
        duplicate: receipt.duplicate || acknowledged.duplicate,
        checkpoint: acknowledged.checkpoint,
        lease: acknowledged.lease,
      };
    } catch (error) {
      throw await this.persistPausedFailure("e1-recovery", error);
    }
  }

  finalize(value) {
    const options = normalizeCallOptions(value, "finalize options");
    return this.runLifecycleOperation("finalize", () => this.performFinalization(options));
  }

  async performFinalization({ signal }) {
    let finalizingStarted = false;
    try {
      throwIfAborted(signal);
      let lease = await this.requireValidLease();
      if (lease.phase === "finalizing") {
        finalizingStarted = true;
        if (lease.finalization.status === "finalized") {
          throwIfAborted(signal);
          const proof = lease.finalization.publicPrimaryReadbackProof;
          const cleared = await this.leaseStore.clearFinalized({
            ...this.identityOf(lease),
            publicPrimaryReadbackProof: proof,
          });
          return { cleared, publicPrimaryReadbackProof: proof, resumedFinalizedLease: true };
        }
      } else {
        if (lease.pendingTick !== null || (lease.phase !== "active" && lease.phase !== "paused")) {
          throw orchestratorError("finalization requires no pending tick and an active or paused lease");
        }
        lease = await this.leaseStore.beginFinalizing(this.identityOf(lease));
        finalizingStarted = true;
      }

      const acknowledged = lease.acknowledged;
      const nativeCore = await this.getNativeCore([
        "checkpointExactRealtimeFinalization",
        "exportV47",
      ]);
      throwIfAborted(signal);
      const rawCheckpoint = await nativeCore.checkpointExactRealtimeFinalization({
        ...this.identityOf(lease),
        savedAtMs: acknowledged.settledDeadlineMs,
      }, { signal });
      throwIfAborted(signal);
      const checkpoint = normalizeCheckpointReceipt(
        rawCheckpoint,
        acknowledged,
        lease.registryFingerprint,
      );

      const exportId = deriveFinalExportId(lease.runId, acknowledged.revision);
      const rawExport = await nativeCore.exportV47({
        exportId,
        savedAtMs: acknowledged.settledDeadlineMs,
      }, { signal });
      throwIfAborted(signal);
      const exported = normalizeExportReceipt(rawExport, {
        exportId,
        revision: acknowledged.revision,
        savedAtMs: acknowledged.settledDeadlineMs,
      });

      const commitId = derivePublicCommitId(lease.runId, acknowledged.revision);
      const writerIdentity = {
        commitId,
        slot: NORMAL_SLOT,
        mode: NORMAL_MODE,
        revision: acknowledged.revision,
        savedAtMs: acknowledged.settledDeadlineMs,
        registryFingerprint: lease.registryFingerprint,
        payloadSha256: exported.payloadSha256,
        baseChecksum: exported.baseChecksum,
        byteLength: exported.byteLength,
      };
      const sourceIterable = await resolveByteIterable(exported.openStream(), "native v47 export stream");
      const sourceState = { completed: false };
      const source = verifyingByteStream(
        sourceIterable,
        exported,
        signal,
        sourceState,
        "native v47 export stream",
      );
      let rawPublicCommit;
      try {
        rawPublicCommit = await this.publicPrimaryWriter.commit({
          ...writerIdentity,
          source,
        }, { signal });
      } finally {
        if (!sourceState.completed && typeof source.return === "function") {
          await source.return().catch(() => undefined);
        }
      }
      if (!sourceState.completed) {
        throw orchestratorError(
          "public primary writer returned before consuming the complete native export",
          "NATIVE_CORE_EXACT_REALTIME_E1_READBACK_INVALID",
        );
      }
      throwIfAborted(signal);
      const publicCommit = normalizeWriterIdentity(
        rawPublicCommit,
        writerIdentity,
        "public primary commit receipt",
        false,
      );

      const rawReadback = await this.publicPrimaryWriter.readback({
        commitId,
        slot: NORMAL_SLOT,
      }, { signal });
      const readback = normalizeWriterIdentity(
        rawReadback,
        writerIdentity,
        "public primary readback receipt",
        true,
      );
      const readbackIterable = await resolveByteIterable(
        readback.openStream.call(readback),
        "public primary readback stream",
      );
      const verificationIterable = await resolveByteIterable(
        exported.openStream(),
        "native v47 verification stream",
      );
      const readbackDigest = await compareByteStreams(
        verificationIterable,
        readbackIterable,
        exported,
        signal,
      );
      if (readbackDigest.byteLength !== exported.byteLength ||
          readbackDigest.payloadSha256 !== exported.payloadSha256) {
        throw orchestratorError(
          "public primary byte-for-byte readback does not match the native export",
          "NATIVE_CORE_EXACT_REALTIME_E1_READBACK_INVALID",
        );
      }
      throwIfAborted(signal);

      const publicPrimaryReadbackProof = {
        kind: "public-primary-readback-v1",
        revision: acknowledged.revision,
        canonicalSha256: acknowledged.proof.canonicalSha256,
        domainSha256: acknowledged.proof.domainSha256,
        registryFingerprint: lease.registryFingerprint,
        payloadSha256: exported.payloadSha256,
        baseChecksum: exported.baseChecksum,
        byteLength: exported.byteLength,
        savedAtMs: acknowledged.settledDeadlineMs,
      };
      const finalized = await this.leaseStore.recordPublicPrimaryReadback({
        ...this.identityOf(lease),
        publicPrimaryReadbackProof,
      });
      throwIfAborted(signal);
      const cleared = await this.leaseStore.clearFinalized({
        ...this.identityOf(finalized),
        publicPrimaryReadbackProof,
      });
      return {
        cleared,
        checkpoint,
        exportId,
        commitId,
        publicCommitDuplicate: publicCommit.duplicate,
        publicPrimaryReadbackProof,
        resumedFinalizedLease: false,
      };
    } catch (error) {
      const inspected = await this.inspect();
      if (finalizingStarted || inspected.state === "valid" && inspected.lease.phase === "finalizing") {
        throw orchestratorError(
          "native finalization failed; the durable finalizing lease was retained",
          "NATIVE_CORE_EXACT_REALTIME_E1_FINALIZATION_RETAINED",
          error,
        );
      }
      throw await this.persistPausedFailure("e1-finalize", error);
    }
  }

  async requireValidLease() {
    const inspected = await this.leaseStore.inspect();
    if (inspected?.state !== "valid") {
      throw orchestratorError(
        `exact realtime lease is ${inspected?.state ?? "unavailable"}`,
        "NATIVE_CORE_EXACT_REALTIME_E1_LEASE_BLOCKED",
      );
    }
    const lease = inspected.lease;
    if (lease.mode !== NORMAL_MODE || lease.slot !== NORMAL_SLOT) {
      throw orchestratorError(
        "exact realtime lease is outside normal-main",
        "NATIVE_CORE_EXACT_REALTIME_E1_LEASE_BLOCKED",
      );
    }
    return lease;
  }

  runLifecycleOperation(kind, operationFactory) {
    const current = this.lifecycleInFlight;
    if (current) {
      if (current.kind === kind) return current.promise;
      return Promise.reject(orchestratorError(
        `native exact realtime ${current.kind} transition is already in progress`,
        "NATIVE_CORE_EXACT_REALTIME_E1_LIFECYCLE_BUSY",
      ));
    }
    const operation = Promise.resolve().then(operationFactory);
    const tracked = operation.finally(() => {
      if (this.lifecycleInFlight?.promise === tracked) this.lifecycleInFlight = null;
    });
    this.lifecycleInFlight = { kind, promise: tracked };
    return tracked;
  }

  identityOf(lease) {
    return {
      runId: lease.runId,
      registryFingerprint: lease.registryFingerprint,
    };
  }

  async getNativeCore(requiredMethods) {
    const nativeCore = await this.nativeCoreProvider();
    if (!nativeCore || requiredMethods.some((method) => typeof nativeCore[method] !== "function")) {
      throw orchestratorError("native core API is unavailable", "NATIVE_CORE_EXACT_REALTIME_E1_NATIVE_UNAVAILABLE");
    }
    return nativeCore;
  }

  async persistPausedFailure(prefix, error) {
    const reasonCode = failureReason(prefix, error);
    try {
      const inspected = await this.leaseStore.inspect();
      if (inspected?.state !== "valid") {
        throw orchestratorError("lease cannot persist a paused failure state");
      }
      const lease = inspected.lease;
      if (lease.phase === "active") {
        await this.leaseStore.pause({
          ...this.identityOf(lease),
          reasonCode,
        });
      }
    } catch (pauseError) {
      return orchestratorError(
        "operation failed and its durable pause could not be persisted",
        "NATIVE_CORE_EXACT_REALTIME_E1_PAUSE_PERSIST_FAILED",
        { operationError: error, pauseError },
      );
    }
    return orchestratorError(
      `native exact realtime experiment paused: ${reasonCode}`,
      "NATIVE_CORE_EXACT_REALTIME_E1_PAUSED",
      error,
    );
  }
}

module.exports = {
  NativeCoreExactRealtimeOrchestrator,
  NativeCoreExactRealtimeOrchestratorError,
  deriveExactTickCommandId,
  deriveFinalExportId,
  derivePublicCommitId,
};
