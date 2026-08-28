"use strict";

/*
 * Renderer-safe, read-only view of the main-owned Rust authority clock.
 *
 * It deliberately omits owner IDs, fencing tokens, checkpoints and every
 * mutation method. The same normalizer is used for pull responses and pushed
 * transition events so a thin renderer can advance its projection revision
 * without retaining a full GameState or gaining authority control.
 */

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const PHASES = new Set([
  "idle", "activating", "recovering", "active", "uncertain", "faulted", "shutdown",
]);
const OPERATIONS = new Set([null, "activation", "recovery", "tick", "command"]);

class NativePlayerAuthorityStateBrokerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "NativePlayerAuthorityStateBrokerError";
    this.code = code;
  }
}

function stateError(message, code = "NATIVE_PLAYER_AUTHORITY_STATE_INVALID") {
  return new NativePlayerAuthorityStateBrokerError(message, code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableLogicalId(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
      !LOGICAL_ID_PATTERN.test(value)) {
    throw stateError(`${label} is invalid`);
  }
  return value;
}

function nullableSafeInteger(value, minimum, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < minimum) throw stateError(`${label} is invalid`);
  return value;
}

function normalizeNativePlayerAuthorityState(value) {
  if (!isRecord(value) || !PHASES.has(value.phase) || typeof value.inFlight !== "boolean" ||
      !OPERATIONS.has(value.currentOperation) || !Number.isSafeInteger(value.queuedCommands) ||
      value.queuedCommands < 0 || value.queuedCommands > 64) {
    throw stateError("native player-authority state is invalid");
  }
  const sessionId = nullableLogicalId(value.sessionId, "native player-authority sessionId");
  const runId = nullableLogicalId(value.runId, "native player-authority runId");
  const revision = nullableSafeInteger(value.revision, 0, "native player-authority revision");
  const acknowledgedSequence = nullableSafeInteger(
    value.acknowledgedSequence,
    0,
    "native player-authority acknowledgedSequence",
  );
  const nextSequence = nullableSafeInteger(value.nextSequence, 1, "native player-authority nextSequence");
  const nextDeadlineMs = nullableSafeInteger(
    value.nextDeadlineMs,
    0,
    "native player-authority nextDeadlineMs",
  );
  const lastErrorCode = value.lastErrorCode === null
    ? null
    : typeof value.lastErrorCode === "string" && ERROR_CODE_PATTERN.test(value.lastErrorCode)
      ? value.lastErrorCode
      : (() => { throw stateError("native player-authority lastErrorCode is invalid"); })();
  const identityValues = [sessionId, runId, revision, acknowledgedSequence, nextSequence, nextDeadlineMs];
  const hasCompleteIdentity = identityValues.every((entry) => entry !== null);
  const hasNoIdentity = identityValues.every((entry) => entry === null);
  if (!hasCompleteIdentity && !hasNoIdentity) {
    throw stateError("native player-authority state has a partial identity");
  }
  if (hasCompleteIdentity && acknowledgedSequence + 1 !== nextSequence) {
    throw stateError("native player-authority sequence is not contiguous");
  }
  if (value.phase === "active" && (!hasCompleteIdentity || lastErrorCode !== null)) {
    throw stateError("active native player-authority state is incomplete");
  }
  if (["idle", "activating", "recovering"].includes(value.phase) && !hasNoIdentity) {
    throw stateError("pre-authority state unexpectedly exposes an identity");
  }
  return Object.freeze({
    schemaVersion: 1,
    phase: value.phase,
    sessionId,
    runId,
    revision,
    acknowledgedSequence,
    nextSequence,
    nextDeadlineMs,
    inFlight: value.inFlight,
    currentOperation: value.currentOperation,
    queuedCommands: value.queuedCommands,
    lastErrorCode,
  });
}

class NativePlayerAuthorityStateBroker {
  constructor(options) {
    if (!isRecord(options) || !options.runtime || typeof options.runtime.snapshot !== "function" ||
        typeof options.isTrustedRendererOwner !== "function") {
      throw new TypeError("native player-authority state broker options are invalid");
    }
    this.runtime = options.runtime;
    this.isTrustedRendererOwner = options.isTrustedRendererOwner;
  }

  read(rendererOwnerId) {
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw stateError(
        "native player-authority state caller is not the trusted renderer",
        "NATIVE_PLAYER_AUTHORITY_STATE_RENDERER_UNTRUSTED",
      );
    }
    return normalizeNativePlayerAuthorityState(this.runtime.snapshot());
  }
}

module.exports = {
  NativePlayerAuthorityStateBroker,
  NativePlayerAuthorityStateBrokerError,
  normalizeNativePlayerAuthorityState,
};
