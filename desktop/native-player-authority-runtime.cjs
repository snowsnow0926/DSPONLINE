"use strict";

/*
 * Main-process-only player-authority clock.
 *
 * This module intentionally has no Electron IPC or renderer dependency.  It
 * cannot promote a session on its own: the caller must first establish a
 * main-owned normal-main session and supply the exact durable checkpoint that
 * was installed as the public player state.  The Rust host remains responsible
 * for the authoritative coverage gate and for the atomic WAL/checkpoint/ACK
 * transaction of each one-second tick.
 */

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const TICK_MILLISECONDS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

class NativePlayerAuthorityRuntimeError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "NativePlayerAuthorityRuntimeError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function runtimeError(message, code = "NATIVE_PLAYER_AUTHORITY_RUNTIME_INVALID", cause) {
  return new NativePlayerAuthorityRuntimeError(message, code, cause);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireLogicalId(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !LOGICAL_ID_PATTERN.test(value)) {
    throw runtimeError(`${label} is invalid`);
  }
  return value;
}

function requireSafeInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) throw runtimeError(`${label} is invalid`);
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw runtimeError(`${label} is invalid`);
  return value;
}

function normalizeCheckpoint(value, label) {
  if (!isRecord(value)) throw runtimeError(`${label} is invalid`);
  return Object.freeze({
    generation: requireSafeInteger(value.generation, 1, `${label}.generation`),
    rootHash: requireSha256(value.rootHash, `${label}.rootHash`),
    revision: requireSafeInteger(value.revision, 0, `${label}.revision`),
  });
}

function sameCheckpoint(left, right) {
  return left.generation === right.generation && left.rootHash === right.rootHash && left.revision === right.revision;
}

function validateSummary(value, expectedRevision, label) {
  if (!isRecord(value) || value.revision !== expectedRevision || value.stateVersion !== 47 ||
      value.mode !== "normal" || value.paused !== false || value.coverage?.authorityEligible !== true) {
    throw runtimeError(
      `${label} is not a complete running v47 player-authority state`,
      "NATIVE_PLAYER_AUTHORITY_COVERAGE_INCOMPLETE",
    );
  }
  requireSha256(value.canonicalSha256, `${label}.canonicalSha256`);
  requireSha256(value.domainSha256, `${label}.domainSha256`);
  return value;
}

function validateLeaseReceipt(value, phase, expected) {
  if (!isRecord(value) || !isRecord(value.lease)) throw runtimeError(`native ${phase} receipt is invalid`);
  const lease = value.lease;
  if (lease.phase !== phase || lease.kind !== "native-core-exact-realtime-player-authority-lease-v1" ||
      lease.runId !== expected.runId || lease.mode !== "normal" || lease.slot !== "normal-main" ||
      lease.pendingTick !== null || !isRecord(lease.acknowledged)) {
    throw runtimeError(`native ${phase} lease identity is invalid`);
  }
  const checkpoint = normalizeCheckpoint(lease.checkpoint, `native ${phase} lease checkpoint`);
  const acknowledgedCheckpoint = normalizeCheckpoint(
    lease.acknowledged.checkpoint,
    `native ${phase} acknowledged checkpoint`,
  );
  if (!sameCheckpoint(checkpoint, expected.expectedCheckpoint) ||
      !sameCheckpoint(acknowledgedCheckpoint, expected.expectedCheckpoint) ||
      lease.acknowledged.revision !== expected.expectedCheckpoint.revision ||
      lease.acknowledged.settledDeadlineMs !== expected.settledDeadlineMs) {
    throw runtimeError(`native ${phase} lease checkpoint is not the requested public state`);
  }
  const sequence = requireSafeInteger(
    lease.acknowledged.sequence,
    0,
    `native ${phase} acknowledged sequence`,
  );
  validateSummary(value.summary, expected.expectedCheckpoint.revision, `native ${phase} summary`);
  return { lease, sequence, checkpoint, summary: value.summary };
}

function validateTickReceipt(value, context) {
  if (!isRecord(value) || value.sequence !== context.nextSequence ||
      value.revision !== context.revision + 1 || typeof value.duplicate !== "boolean") {
    throw runtimeError(
      "native player-authority tick receipt is not the requested next second",
      "NATIVE_PLAYER_AUTHORITY_TICK_RECEIPT_INVALID",
    );
  }
  const checkpoint = normalizeCheckpoint(value.checkpoint, "native player-authority tick checkpoint");
  if (checkpoint.revision !== value.revision || checkpoint.generation < context.checkpoint.generation) {
    throw runtimeError(
      "native player-authority tick checkpoint regressed or has the wrong revision",
      "NATIVE_PLAYER_AUTHORITY_TICK_RECEIPT_INVALID",
    );
  }
  validateSummary(value.summary, value.revision, "native player-authority tick summary");
  return { checkpoint, summary: value.summary };
}

function frozenSnapshot(runtime) {
  const context = runtime.context;
  return Object.freeze({
    phase: runtime.phase,
    sessionId: context?.sessionId ?? null,
    runId: context?.runId ?? null,
    revision: context?.revision ?? null,
    acknowledgedSequence: context ? context.nextSequence - 1 : null,
    nextSequence: context?.nextSequence ?? null,
    nextDeadlineMs: context?.nextDeadlineMs ?? null,
    inFlight: runtime.inFlight !== null,
    lastErrorCode: runtime.lastError?.code ?? null,
  });
}

class NativePlayerAuthorityRuntime {
  constructor(options) {
    if (!isRecord(options) || !options.registry ||
        typeof options.registry.preparePlayerAuthority !== "function" ||
        typeof options.registry.activatePlayerAuthority !== "function" ||
        typeof options.registry.commitPlayerAuthorityTick !== "function") {
      throw new TypeError("native player-authority runtime registry is invalid");
    }
    if (options.now !== undefined && typeof options.now !== "function" ||
        options.schedule !== undefined && typeof options.schedule !== "function" ||
        options.cancel !== undefined && typeof options.cancel !== "function" ||
        options.onTransition !== undefined && typeof options.onTransition !== "function") {
      throw new TypeError("native player-authority runtime options are invalid");
    }
    this.registry = options.registry;
    this.ownerId = requireLogicalId(options.ownerId ?? "main-player-authority", "ownerId");
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
    this.onTransition = options.onTransition ?? (() => undefined);
    this.minimumYieldMs = requireSafeInteger(options.minimumYieldMs ?? 16, 0, "minimumYieldMs");
    this.phase = "idle";
    this.context = null;
    this.timer = null;
    this.inFlight = null;
    this.lastError = null;
  }

  snapshot() {
    return frozenSnapshot(this);
  }

  transition(phase, error = null) {
    this.phase = phase;
    this.lastError = error;
    const snapshot = this.snapshot();
    this.onTransition(snapshot);
    return snapshot;
  }

  activate(request) {
    if (this.phase !== "idle" || this.inFlight) {
      return Promise.reject(runtimeError("native player-authority activation is already in progress or settled"));
    }
    let normalized;
    try {
      if (!isRecord(request)) throw runtimeError("native player-authority activation request is invalid");
      normalized = Object.freeze({
        sessionId: requireLogicalId(request.sessionId, "sessionId"),
        runId: requireLogicalId(request.runId, "runId"),
        expectedCheckpoint: normalizeCheckpoint(request.expectedCheckpoint, "expectedCheckpoint"),
        settledDeadlineMs: requireSafeInteger(request.settledDeadlineMs, 0, "settledDeadlineMs"),
      });
    } catch (error) {
      return Promise.reject(error);
    }
    this.transition("activating");
    let operation;
    operation = this.performActivation(normalized)
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
        this.armTimer();
      })
      .then(() => this.snapshot());
    this.inFlight = operation;
    return operation;
  }

  async performActivation(request) {
    try {
      const preparedRaw = await this.registry.preparePlayerAuthority(this.ownerId, request);
      const prepared = validateLeaseReceipt(preparedRaw, "prepared", request);
      const activeRaw = await this.registry.activatePlayerAuthority(this.ownerId, {
        sessionId: request.sessionId,
        runId: request.runId,
        expectedCheckpoint: request.expectedCheckpoint,
      });
      const active = validateLeaseReceipt(activeRaw, "active", request);
      if (active.sequence !== prepared.sequence) {
        throw runtimeError("native player-authority sequence changed during activation");
      }
      const nextSequence = active.sequence + 1;
      const nextDeadlineMs = request.settledDeadlineMs + TICK_MILLISECONDS;
      if (!Number.isSafeInteger(nextSequence) || !Number.isSafeInteger(nextDeadlineMs)) {
        throw runtimeError("native player-authority clock exceeds the safe integer range");
      }
      this.context = {
        sessionId: request.sessionId,
        runId: request.runId,
        revision: request.expectedCheckpoint.revision,
        checkpoint: active.checkpoint,
        nextSequence,
        nextDeadlineMs,
      };
      this.transition("active");
    } catch (cause) {
      const error = cause instanceof NativePlayerAuthorityRuntimeError
        ? cause
        : runtimeError("native player-authority activation failed", "NATIVE_PLAYER_AUTHORITY_ACTIVATION_FAILED", cause);
      this.transition("faulted", error);
      throw error;
    }
  }

  armTimer() {
    if (this.phase !== "active" || !this.context || this.timer !== null || this.inFlight) return;
    const now = this.now();
    if (!Number.isFinite(now)) {
      this.transition("faulted", runtimeError("native player-authority clock is invalid"));
      return;
    }
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(this.minimumYieldMs, Math.ceil(this.context.nextDeadlineMs - now)),
    );
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.settleDue().catch(() => undefined);
    }, delay);
  }

  settleDue() {
    if (this.phase !== "active" || !this.context) return Promise.resolve(this.snapshot());
    if (this.inFlight) return this.inFlight;
    if (this.now() < this.context.nextDeadlineMs) {
      this.armTimer();
      return Promise.resolve(this.snapshot());
    }
    return this.commitCurrentSequence();
  }

  retryUncertain() {
    if (this.phase !== "uncertain" || !this.context || this.inFlight) {
      return Promise.reject(runtimeError("native player-authority runtime has no uncertain tick to retry"));
    }
    return this.commitCurrentSequence();
  }

  commitCurrentSequence() {
    const context = this.context;
    if (!context) return Promise.reject(runtimeError("native player-authority runtime is not active"));
    let operation;
    operation = this.registry.commitPlayerAuthorityTick(this.ownerId, {
      sessionId: context.sessionId,
      runId: context.runId,
      sequence: context.nextSequence,
    }).then((receipt) => {
      const validated = validateTickReceipt(receipt, context);
      context.revision = receipt.revision;
      context.checkpoint = validated.checkpoint;
      context.nextSequence += 1;
      context.nextDeadlineMs += TICK_MILLISECONDS;
      if (!Number.isSafeInteger(context.nextSequence) || !Number.isSafeInteger(context.nextDeadlineMs)) {
        throw runtimeError("native player-authority clock exceeds the safe integer range");
      }
      this.transition("active");
    }).catch((cause) => {
      const error = cause instanceof NativePlayerAuthorityRuntimeError
        ? cause
        : runtimeError("native player-authority tick outcome is uncertain", "NATIVE_PLAYER_AUTHORITY_TICK_UNCERTAIN", cause);
      this.transition("uncertain", error);
      throw error;
    }).finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
      this.armTimer();
    }).then(() => this.snapshot());
    this.inFlight = operation;
    return operation;
  }

  shutdownForProcessExit() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    return this.transition("shutdown");
  }
}

module.exports = {
  NativePlayerAuthorityRuntime,
  NativePlayerAuthorityRuntimeError,
  TICK_MILLISECONDS,
};
