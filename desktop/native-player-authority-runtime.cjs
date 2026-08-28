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
const MAX_DURABLE_COMMAND_BYTES = 1_750_000;
const COMMAND_KEYS = Object.freeze([
  "protocolVersion", "baseRevision", "topLevelChanges", "changedEntities", "addedEntities",
  "removedEntityIds", "changedBelts", "addedBelts", "removedBeltIds",
]);

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
      lease.pendingTick !== null || lease.pendingCommand != null || !isRecord(lease.acknowledged)) {
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

function normalizeCommandRequest(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string" ||
      !["commandId", "baseRevision", "command"].includes(key)) ||
      !Object.hasOwn(value, "commandId") || !Object.hasOwn(value, "baseRevision") ||
      !Object.hasOwn(value, "command") || !isRecord(value.command)) {
    throw runtimeError("native player-authority command request is invalid");
  }
  const commandId = requireLogicalId(value.commandId, "commandId");
  const baseRevision = requireSafeInteger(value.baseRevision, 0, "baseRevision");
  if (Reflect.ownKeys(value.command).some((key) => typeof key !== "string" || !COMMAND_KEYS.includes(key)) ||
      COMMAND_KEYS.some((key) => !Object.hasOwn(value.command, key)) ||
      value.command.protocolVersion !== 1 || value.command.baseRevision !== baseRevision ||
      COMMAND_KEYS.slice(2).some((key) => !Array.isArray(value.command[key]))) {
    throw runtimeError("native player-authority command revision is invalid");
  }
  let encoded;
  try {
    encoded = JSON.stringify(value.command);
  } catch (cause) {
    throw runtimeError("native player-authority command is not JSON serializable", undefined, cause);
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_DURABLE_COMMAND_BYTES) {
    throw runtimeError("native player-authority command exceeds its durable payload limit");
  }
  return Object.freeze({ commandId, baseRevision, command: JSON.parse(encoded) });
}

function validateRecoveryReceipt(value, sessionId) {
  if (!isRecord(value) || value.runId === undefined || value.duplicate !== true) {
    throw runtimeError(
      "native player-authority recovery receipt is invalid",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECOVERY_INVALID",
    );
  }
  const runId = requireLogicalId(value.runId, "recovered runId");
  const sequence = requireSafeInteger(value.sequence, 1, "recovered sequence");
  const baseRevision = requireSafeInteger(value.baseRevision, 0, "recovered baseRevision");
  const revision = requireSafeInteger(value.revision, 1, "recovered revision");
  const settledDeadlineMs = requireSafeInteger(
    value.settledDeadlineMs,
    0,
    "recovered settledDeadlineMs",
  );
  if (revision !== baseRevision + 1) {
    throw runtimeError(
      "native player-authority recovery revision is not contiguous",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECOVERY_INVALID",
    );
  }
  const checkpoint = normalizeCheckpoint(value.checkpoint, "recovered player-authority checkpoint");
  if (checkpoint.revision !== revision) {
    throw runtimeError(
      "native player-authority recovery checkpoint revision conflicts",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECOVERY_INVALID",
    );
  }
  validateSummary(value.summary, revision, "recovered player-authority summary");
  return { sessionId, runId, sequence, revision, settledDeadlineMs, checkpoint };
}

function validateStartupRecoveryReceipt(value, ownerId) {
  const keys = [
    "schemaVersion", "kind", "ownerId", "sessionId", "runId", "registryFingerprint",
    "revision", "checkpoint", "acknowledgedSequence", "nextSequence",
    "settledDeadlineMs", "nextDeadlineMs", "summary",
  ];
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(value, key)) || value.schemaVersion !== 1 ||
      value.kind !== "native-core-player-authority-startup-recovery-v1" ||
      value.ownerId !== ownerId) {
    throw runtimeError(
      "native player-authority startup recovery receipt is invalid",
      "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
    );
  }
  const sessionId = requireLogicalId(value.sessionId, "startup recovery sessionId");
  const runId = requireLogicalId(value.runId, "startup recovery runId");
  requireLogicalId(value.registryFingerprint, "startup recovery registryFingerprint");
  const revision = requireSafeInteger(value.revision, 0, "startup recovery revision");
  const checkpoint = normalizeCheckpoint(value.checkpoint, "startup recovery checkpoint");
  const acknowledgedSequence = requireSafeInteger(
    value.acknowledgedSequence,
    0,
    "startup recovery acknowledgedSequence",
  );
  const nextSequence = requireSafeInteger(value.nextSequence, 1, "startup recovery nextSequence");
  const settledDeadlineMs = requireSafeInteger(
    value.settledDeadlineMs,
    0,
    "startup recovery settledDeadlineMs",
  );
  const nextDeadlineMs = requireSafeInteger(
    value.nextDeadlineMs,
    TICK_MILLISECONDS,
    "startup recovery nextDeadlineMs",
  );
  if (checkpoint.revision !== revision || nextSequence !== acknowledgedSequence + 1 ||
      nextDeadlineMs !== settledDeadlineMs + TICK_MILLISECONDS ||
      value.summary?.registryFingerprint !== value.registryFingerprint) {
    throw runtimeError(
      "native player-authority startup recovery chain is not contiguous",
      "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
    );
  }
  validateSummary(value.summary, revision, "startup recovery summary");
  return { sessionId, runId, revision, checkpoint, nextSequence, nextDeadlineMs };
}

function validateCommandReceipt(value, context, command) {
  if (!isRecord(value) || value.sequence !== context.nextSequence ||
      value.commandId !== command.commandId || value.baseRevision !== command.baseRevision ||
      value.revision !== command.baseRevision + 1 || value.revision !== context.revision + 1 ||
      value.settledDeadlineMs !== context.nextDeadlineMs - TICK_MILLISECONDS ||
      typeof value.duplicate !== "boolean") {
    throw runtimeError(
      "native player-authority command receipt is not the requested next event",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    );
  }
  const checkpoint = normalizeCheckpoint(value.checkpoint, "native player-authority command checkpoint");
  if (checkpoint.revision !== value.revision || checkpoint.generation < context.checkpoint.generation) {
    throw runtimeError(
      "native player-authority command checkpoint regressed or has the wrong revision",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    );
  }
  validateSummary(value.summary, value.revision, "native player-authority command summary");
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
    currentOperation: runtime.currentOperation,
    queuedCommands: runtime.commandQueue.length,
    lastErrorCode: runtime.lastError?.code ?? null,
  });
}

class NativePlayerAuthorityRuntime {
  constructor(options) {
    if (!isRecord(options) || !options.registry ||
        typeof options.registry.preparePlayerAuthority !== "function" ||
        typeof options.registry.activatePlayerAuthority !== "function" ||
        typeof options.registry.commitPlayerAuthorityTick !== "function" ||
        typeof options.registry.commitPlayerAuthorityCommand !== "function" ||
        typeof options.registry.recoverPlayerAuthorityCommand !== "function") {
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
    this.currentOperation = null;
    this.commandQueue = [];
    this.activeCommand = null;
    this.shutdownRequested = false;
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

  rejectQueuedCommands(cause) {
    const error = runtimeError(
      "native player-authority queued command was discarded before becoming durable",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_QUEUE_ABORTED",
      cause,
    );
    for (const entry of this.commandQueue.splice(0)) entry.reject(error);
    return error;
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
    this.currentOperation = "activation";
    let operation;
    operation = this.performActivation(normalized)
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
        this.currentOperation = null;
        this.pump();
      })
      .then(() => this.snapshot());
    this.inFlight = operation;
    return operation;
  }

  recoverPendingCommand(request) {
    if (this.phase !== "idle" || this.inFlight || !isRecord(request)) {
      return Promise.reject(runtimeError("native player-authority recovery cannot start"));
    }
    let sessionId;
    try {
      if (Reflect.ownKeys(request).some((key) => key !== "sessionId")) {
        throw runtimeError("native player-authority recovery request is invalid");
      }
      sessionId = requireLogicalId(request.sessionId, "sessionId");
    } catch (error) {
      return Promise.reject(error);
    }
    this.transition("recovering");
    this.currentOperation = "recovery";
    let operation;
    operation = Promise.resolve()
      .then(() => this.registry.recoverPlayerAuthorityCommand(this.ownerId, { sessionId }))
      .then((receipt) => {
        const recovered = validateRecoveryReceipt(receipt, sessionId);
        const nextSequence = recovered.sequence + 1;
        const nextDeadlineMs = recovered.settledDeadlineMs + TICK_MILLISECONDS;
        if (!Number.isSafeInteger(nextSequence) || !Number.isSafeInteger(nextDeadlineMs)) {
          throw runtimeError("native player-authority recovered clock exceeds the safe integer range");
        }
        this.context = {
          sessionId,
          runId: recovered.runId,
          revision: recovered.revision,
          checkpoint: recovered.checkpoint,
          nextSequence,
          nextDeadlineMs,
        };
        this.transition("active");
      })
      .catch((cause) => {
        const error = cause instanceof NativePlayerAuthorityRuntimeError
          ? cause
          : runtimeError(
            "native player-authority pending command recovery failed",
            "NATIVE_PLAYER_AUTHORITY_COMMAND_RECOVERY_FAILED",
            cause,
          );
        this.transition("faulted", error);
        throw error;
      })
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
        this.currentOperation = null;
        this.pump();
      })
      .then(() => this.snapshot());
    this.inFlight = operation;
    return operation;
  }

  resumeFromStartupRecovery(receipt) {
    if (this.phase !== "idle" || this.inFlight) {
      throw runtimeError("native player-authority startup recovery cannot resume this runtime");
    }
    try {
      const recovered = validateStartupRecoveryReceipt(receipt, this.ownerId);
      if (typeof this.registry.inspectSession !== "function") {
        throw runtimeError(
          "native player-authority startup session registry is unavailable",
          "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
        );
      }
      const owned = this.registry.inspectSession(this.ownerId, recovered.sessionId);
      if (owned?.ownerId !== this.ownerId || owned.slot !== "normal-main" ||
          owned.state !== "owned" || owned.inFlight !== 0) {
        throw runtimeError(
          "native player-authority startup session is not exclusively main-owned",
          "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
        );
      }
      this.context = recovered;
      const snapshot = this.transition("active");
      this.pump();
      return snapshot;
    } catch (cause) {
      const error = cause instanceof NativePlayerAuthorityRuntimeError
        ? cause
        : runtimeError(
          "native player-authority startup recovery failed",
          "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
          cause,
        );
      this.transition("faulted", error);
      throw error;
    }
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

  commitCommand(rawRequest) {
    if (this.phase !== "active" || !this.context) {
      return Promise.reject(runtimeError("native player-authority runtime is not accepting commands"));
    }
    let request;
    try {
      request = normalizeCommandRequest(rawRequest);
      if (this.commandQueue.length >= 64) {
        throw runtimeError(
          "native player-authority command queue is full",
          "NATIVE_PLAYER_AUTHORITY_COMMAND_QUEUE_FULL",
        );
      }
      let projectedRevision = this.context.revision;
      if (this.currentOperation === "tick" || this.currentOperation === "command") {
        projectedRevision += 1;
      }
      projectedRevision += this.commandQueue.length;
      if (!Number.isSafeInteger(projectedRevision) || request.baseRevision !== projectedRevision) {
        throw runtimeError(
          "native player-authority command base revision is not the queued revision",
          "NATIVE_PLAYER_AUTHORITY_COMMAND_REVISION_MISMATCH",
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }
    let resolveCommand;
    let rejectCommand;
    const promise = new Promise((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
    });
    this.commandQueue.push({ request, promise, resolve: resolveCommand, reject: rejectCommand });
    this.pump();
    return promise;
  }

  pump() {
    if (this.phase !== "active" || !this.context || this.inFlight) return;
    if (!this.activeCommand && this.commandQueue.length > 0) {
      this.activeCommand = this.commandQueue.shift();
    }
    if (this.activeCommand) {
      this.commitCurrentCommand();
      return;
    }
    this.armTimer();
  }

  commitCurrentCommand() {
    const context = this.context;
    const entry = this.activeCommand;
    if (!context || !entry || this.inFlight) return this.inFlight;
    this.currentOperation = "command";
    let resolveInFlight;
    const completion = new Promise((resolve) => {
      resolveInFlight = resolve;
    });
    this.inFlight = completion;
    Promise.resolve().then(() => this.registry.commitPlayerAuthorityCommand(this.ownerId, {
      sessionId: context.sessionId,
      runId: context.runId,
      commandId: entry.request.commandId,
      baseRevision: entry.request.baseRevision,
      command: entry.request.command,
    })).then((receipt) => {
      if (this.shutdownRequested) {
        throw runtimeError(
          "native player-authority runtime shut down during a command",
          "NATIVE_PLAYER_AUTHORITY_RUNTIME_SHUTDOWN",
        );
      }
      const validated = validateCommandReceipt(receipt, context, entry.request);
      const nextSequence = context.nextSequence + 1;
      if (!Number.isSafeInteger(nextSequence)) {
        throw runtimeError("native player-authority event sequence exceeds the safe integer range");
      }
      context.revision = receipt.revision;
      context.checkpoint = validated.checkpoint;
      context.nextSequence = nextSequence;
      this.activeCommand = null;
      this.transition("active");
      return { ok: true };
    }).catch((cause) => {
      const error = cause instanceof NativePlayerAuthorityRuntimeError
        ? cause
        : runtimeError(
          "native player-authority command outcome is uncertain",
          "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN",
          cause,
        );
      if (!this.shutdownRequested) {
        this.rejectQueuedCommands(error);
        this.transition("uncertain", error);
      }
      return { ok: false, error };
    }).then((outcome) => {
      this.inFlight = null;
      this.currentOperation = null;
      if (outcome.ok) {
        const snapshot = this.snapshot();
        entry.resolve(snapshot);
        resolveInFlight(snapshot);
        this.pump();
      } else {
        entry.reject(outcome.error);
        resolveInFlight(this.snapshot());
      }
    });
    return completion;
  }

  armTimer() {
    if (this.phase !== "active" || !this.context || this.timer !== null || this.inFlight ||
        this.activeCommand || this.commandQueue.length > 0) return;
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
    if (this.activeCommand) {
      let resolveRetry;
      let rejectRetry;
      const retry = new Promise((resolve, reject) => {
        resolveRetry = resolve;
        rejectRetry = reject;
      });
      this.activeCommand.resolve = resolveRetry;
      this.activeCommand.reject = rejectRetry;
      this.commitCurrentCommand();
      return retry;
    }
    return this.commitCurrentSequence();
  }

  commitCurrentSequence() {
    const context = this.context;
    if (!context) return Promise.reject(runtimeError("native player-authority runtime is not active"));
    this.currentOperation = "tick";
    let invocation;
    try {
      invocation = this.registry.commitPlayerAuthorityTick(this.ownerId, {
        sessionId: context.sessionId,
        runId: context.runId,
        sequence: context.nextSequence,
      });
    } catch (cause) {
      invocation = Promise.reject(cause);
    }
    let operation;
    operation = Promise.resolve(invocation).then((receipt) => {
      if (this.shutdownRequested) {
        throw runtimeError(
          "native player-authority runtime shut down during a tick",
          "NATIVE_PLAYER_AUTHORITY_RUNTIME_SHUTDOWN",
        );
      }
      const validated = validateTickReceipt(receipt, context);
      const nextSequence = context.nextSequence + 1;
      const nextDeadlineMs = context.nextDeadlineMs + TICK_MILLISECONDS;
      if (!Number.isSafeInteger(nextSequence) || !Number.isSafeInteger(nextDeadlineMs)) {
        throw runtimeError("native player-authority clock exceeds the safe integer range");
      }
      context.revision = receipt.revision;
      context.checkpoint = validated.checkpoint;
      context.nextSequence = nextSequence;
      context.nextDeadlineMs = nextDeadlineMs;
      this.transition("active");
    }).catch((cause) => {
      const error = cause instanceof NativePlayerAuthorityRuntimeError
        ? cause
        : runtimeError("native player-authority tick outcome is uncertain", "NATIVE_PLAYER_AUTHORITY_TICK_UNCERTAIN", cause);
      if (!this.shutdownRequested) {
        this.rejectQueuedCommands(error);
        this.transition("uncertain", error);
      }
      throw error;
    }).finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
      this.currentOperation = null;
      this.pump();
    }).then(() => this.snapshot());
    this.inFlight = operation;
    return operation;
  }

  shutdownForProcessExit() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.shutdownRequested = true;
    const error = runtimeError(
      "native player-authority runtime is shutting down",
      "NATIVE_PLAYER_AUTHORITY_RUNTIME_SHUTDOWN",
    );
    this.rejectQueuedCommands(error);
    if (this.activeCommand) this.activeCommand.reject(error);
    this.activeCommand = null;
    return this.transition("shutdown", error);
  }
}

module.exports = {
  NativePlayerAuthorityRuntime,
  NativePlayerAuthorityRuntimeError,
  TICK_MILLISECONDS,
};
