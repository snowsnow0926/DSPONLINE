"use strict";

const {
  normalizeSystemSpaceStationIntent,
} = require("./native-system-space-station-intent.cjs");

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
const MAX_MACRO_BUDGET_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE =
  "NATIVE_CORE_PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED";
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

function isDefiniteSystemSpaceStationPreStageRejection(entry, cause) {
  return entry?.request?.kind === "system-space-station" && isRecord(cause) &&
    cause.code === SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE;
}

function requireLogicalId(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !LOGICAL_ID_PATTERN.test(value)) {
    throw runtimeError(`${label} is invalid`);
  }
  return value;
}

function requireChangeId(value, label, code) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > 512) {
    throw runtimeError(`${label} is invalid`, code);
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw runtimeError(`${label} is invalid`, code);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw runtimeError(`${label} is invalid`, code);
    }
  }
  return value;
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Reflect.ownKeys(value).every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function normalizeStableChangeIds(value, label, code) {
  if (!Array.isArray(value) || value.length > 65_536) throw runtimeError(`${label} is invalid`, code);
  const normalized = value.map((entry, index) => requireChangeId(entry, `${label}[${index}]`, code));
  for (let index = 1; index < normalized.length; index += 1) {
    if (Buffer.compare(Buffer.from(normalized[index - 1], "utf8"), Buffer.from(normalized[index], "utf8")) >= 0) {
      throw runtimeError(`${label} is not strictly ordered`, code);
    }
  }
  return Object.freeze(normalized);
}

function normalizeChangeReceipt(value, label, code) {
  const changedEntityIds = normalizeStableChangeIds(value.changedEntityIds, `${label}.changedEntityIds`, code);
  const changedBeltIds = normalizeStableChangeIds(value.changedBeltIds, `${label}.changedBeltIds`, code);
  if (changedEntityIds.length + changedBeltIds.length > 65_536 || typeof value.topologyDirty !== "boolean") {
    throw runtimeError(`${label} is invalid`, code);
  }
  return Object.freeze({ changedEntityIds, changedBeltIds, topologyDirty: value.topologyDirty });
}

function sameChangeReceipt(left, right) {
  return left.topologyDirty === right.topologyDirty &&
    left.changedEntityIds.length === right.changedEntityIds.length &&
    left.changedBeltIds.length === right.changedBeltIds.length &&
    left.changedEntityIds.every((id, index) => id === right.changedEntityIds[index]) &&
    left.changedBeltIds.every((id, index) => id === right.changedBeltIds[index]);
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

function validateSummary(value, expectedRevision, label, expectedPaused = false) {
  if (!isRecord(value) || value.revision !== expectedRevision || value.stateVersion !== 47 ||
      value.mode !== "normal" || value.paused !== expectedPaused ||
      value.coverage?.authorityEligible !== true) {
    throw runtimeError(
      `${label} is not a complete lifecycle-consistent v47 player-authority state`,
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
      lease.pendingTick !== null || lease.pendingCommand != null || lease.pendingAdvance != null ||
      lease.macroSession != null || !isRecord(lease.acknowledged)) {
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

function validatePauseLifecycleReceipt(value, context, request) {
  const keys = [
    "sequence", "baseRevision", "revision", "targetPaused", "settledDeadlineMs",
    "checkpoint", "summary", "duplicate",
  ];
  if (!hasExactKeys(value, keys) || value.sequence !== context.nextSequence ||
      value.baseRevision !== request.baseRevision || value.revision !== request.baseRevision + 1 ||
      value.targetPaused !== request.targetPaused ||
      value.settledDeadlineMs !== request.settledDeadlineMs ||
      typeof value.duplicate !== "boolean") {
    throw runtimeError(
      "native player-authority pause lifecycle receipt is not the requested durable transition",
      "NATIVE_PLAYER_AUTHORITY_PAUSE_RECEIPT_INVALID",
    );
  }
  const checkpoint = normalizeCheckpoint(
    value.checkpoint,
    "native player-authority pause lifecycle checkpoint",
  );
  if (checkpoint.revision !== value.revision ||
      checkpoint.generation < context.checkpoint.generation) {
    throw runtimeError(
      "native player-authority pause lifecycle checkpoint regressed",
      "NATIVE_PLAYER_AUTHORITY_PAUSE_RECEIPT_INVALID",
    );
  }
  validateSummary(
    value.summary,
    value.revision,
    "native player-authority pause lifecycle summary",
    request.targetPaused,
  );
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
  return Object.freeze({ kind: "patch", commandId, baseRevision, command: JSON.parse(encoded) });
}

function normalizeSystemSpaceStationCommandRequest(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string" ||
      !["commandId", "baseRevision", "expectedRegistryFingerprint", "intent"].includes(key)) ||
      !Object.hasOwn(value, "commandId") || !Object.hasOwn(value, "baseRevision") ||
      !Object.hasOwn(value, "expectedRegistryFingerprint") || !Object.hasOwn(value, "intent")) {
    throw runtimeError("native player-authority system-space-station request is invalid");
  }
  const commandId = requireLogicalId(value.commandId, "commandId");
  const baseRevision = requireSafeInteger(value.baseRevision, 0, "baseRevision");
  const expectedRegistryFingerprint = requireLogicalId(
    value.expectedRegistryFingerprint,
    "expectedRegistryFingerprint",
  );
  let intent;
  try {
    intent = normalizeSystemSpaceStationIntent(value.intent);
  } catch (cause) {
    throw runtimeError(
      "native player-authority system-space-station intent is invalid",
      "NATIVE_PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_INTENT_INVALID",
      cause,
    );
  }
  return Object.freeze({
    kind: "system-space-station",
    commandId,
    baseRevision,
    expectedRegistryFingerprint,
    intent,
  });
}

function validateRecoveryReceipt(value, sessionId) {
  const keys = [
    "runId", "sequence", "commandId", "baseRevision", "revision", "settledDeadlineMs",
    "checkpoint", "changedEntityIds", "changedBeltIds", "topologyDirty", "summary", "duplicate",
  ];
  if (!hasExactKeys(value, keys) || value.duplicate !== true) {
    throw runtimeError(
      "native player-authority recovery receipt is invalid",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECOVERY_INVALID",
    );
  }
  const runId = requireLogicalId(value.runId, "recovered runId");
  const sequence = requireSafeInteger(value.sequence, 1, "recovered sequence");
  const commandId = requireLogicalId(value.commandId, "recovered commandId");
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
  if (typeof value.summary?.paused !== "boolean") {
    throw runtimeError(
      "native player-authority recovery pause state is invalid",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECOVERY_INVALID",
    );
  }
  const paused = value.summary.paused;
  validateSummary(value.summary, revision, "recovered player-authority summary", paused);
  const changes = normalizeChangeReceipt(
    value,
    "recovered player-authority change receipt",
    "NATIVE_PLAYER_AUTHORITY_COMMAND_RECOVERY_INVALID",
  );
  return {
    sessionId,
    runId,
    sequence,
    commandId,
    baseRevision,
    revision,
    settledDeadlineMs,
    checkpoint,
    changes,
    paused,
  };
}

function validateStartupRecoveryReceipt(value, ownerId) {
  const baseKeys = [
    "schemaVersion", "kind", "ownerId", "sessionId", "runId", "registryFingerprint",
    "revision", "checkpoint", "acknowledgedSequence", "nextSequence",
    "settledDeadlineMs", "nextDeadlineMs", "commandId", "commandBaseRevision",
    "changedEntityIds", "changedBeltIds", "topologyDirty", "paused", "summary",
  ];
  const macroKeys = [
    "macroSessionId", "recoveredMacroOperationId", "macroAlgorithmVersion",
    "macroSimulationMilliseconds", "macroWallMilliseconds",
  ];
  const cleanupKeys = ["pendingMacroCleanupSessionId", "pendingMacroCleanupRevision"];
  const recoveryKeys = ["entryCheckpoint"];
  if (!isRecord(value) || baseKeys.some((key) => !Object.hasOwn(value, key)) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" ||
        !baseKeys.includes(key) && !macroKeys.includes(key) &&
        !cleanupKeys.includes(key) && !recoveryKeys.includes(key)) ||
      value.schemaVersion !== 1 ||
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
  const entryCheckpoint = Object.hasOwn(value, "entryCheckpoint")
    ? normalizeCheckpoint(value.entryCheckpoint, "startup recovery entry checkpoint")
    : null;
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
  if (checkpoint.revision !== revision || entryCheckpoint && entryCheckpoint.revision > checkpoint.revision ||
      nextSequence !== acknowledgedSequence + 1 ||
      nextDeadlineMs !== settledDeadlineMs + TICK_MILLISECONDS ||
      typeof value.paused !== "boolean" ||
      value.summary?.registryFingerprint !== value.registryFingerprint) {
    throw runtimeError(
      "native player-authority startup recovery chain is not contiguous",
      "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
    );
  }
  validateSummary(value.summary, revision, "startup recovery summary", value.paused);
  const changes = normalizeChangeReceipt(
    value,
    "startup recovery change receipt",
    "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
  );
  let lastCommand = null;
  if (value.commandId === null || value.commandBaseRevision === null) {
    if (value.commandId !== null || value.commandBaseRevision !== null ||
        changes.changedEntityIds.length !== 0 || changes.changedBeltIds.length !== 0 || changes.topologyDirty) {
      throw runtimeError(
        "native player-authority startup command receipt is incomplete",
        "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
      );
    }
  } else {
    const commandId = requireLogicalId(value.commandId, "startup recovery commandId");
    const baseRevision = requireSafeInteger(
      value.commandBaseRevision,
      0,
      "startup recovery commandBaseRevision",
    );
    if (baseRevision + 1 !== revision) {
      throw runtimeError(
        "native player-authority startup command revision is not contiguous",
        "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
      );
    }
    lastCommand = Object.freeze({ commandId, baseRevision, revision, checkpoint, ...changes });
  }
  const presentMacroKeys = macroKeys.filter((key) => Object.hasOwn(value, key));
  let macroSession = null;
  if (presentMacroKeys.length > 0) {
    if (presentMacroKeys.length !== macroKeys.length || value.paused || lastCommand !== null ||
        changes.changedEntityIds.length !== 0 || changes.changedBeltIds.length !== 0 || changes.topologyDirty) {
      throw runtimeError(
        "native player-authority startup macro receipt is incomplete",
        "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
      );
    }
    const macroSessionId = requireLogicalId(value.macroSessionId, "startup recovery macroSessionId");
    const operationId = requireLogicalId(
      value.recoveredMacroOperationId,
      "startup recovery recoveredMacroOperationId",
    );
    const algorithmVersion = requireLogicalId(
      value.macroAlgorithmVersion,
      "startup recovery macroAlgorithmVersion",
    );
    const simulationMilliseconds = requireSafeInteger(
      value.macroSimulationMilliseconds,
      1,
      "startup recovery macroSimulationMilliseconds",
    );
    const wallMilliseconds = requireSafeInteger(
      value.macroWallMilliseconds,
      1,
      "startup recovery macroWallMilliseconds",
    );
    if (simulationMilliseconds > MAX_MACRO_BUDGET_MILLISECONDS ||
        wallMilliseconds > MAX_MACRO_BUDGET_MILLISECONDS) {
      throw runtimeError(
        "native player-authority startup macro budget is invalid",
        "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
      );
    }
    macroSession = Object.freeze({
      macroSessionId,
      algorithmVersion,
      lastOperation: Object.freeze({
        operationId,
        revision,
        simulationMilliseconds,
        wallMilliseconds,
      }),
    });
  }
  const presentCleanupKeys = cleanupKeys.filter((key) => Object.hasOwn(value, key));
  let pendingMacroCleanup = null;
  if (presentCleanupKeys.length > 0) {
    if (presentCleanupKeys.length !== cleanupKeys.length || macroSession !== null) {
      throw runtimeError(
        "native player-authority startup macro cleanup receipt is incomplete",
        "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
      );
    }
    const macroSessionId = requireLogicalId(
      value.pendingMacroCleanupSessionId,
      "startup recovery pendingMacroCleanupSessionId",
    );
    const cleanupRevision = requireSafeInteger(
      value.pendingMacroCleanupRevision,
      0,
      "startup recovery pendingMacroCleanupRevision",
    );
    if (cleanupRevision > revision || entryCheckpoint && cleanupRevision < entryCheckpoint.revision) {
      throw runtimeError(
        "native player-authority startup macro cleanup revision is invalid",
        "NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID",
      );
    }
    pendingMacroCleanup = Object.freeze({ macroSessionId, revision: cleanupRevision });
  }
  return {
    sessionId,
    runId,
    revision,
    checkpoint,
    ...(entryCheckpoint ? { entryCheckpoint } : {}),
    nextSequence,
    nextDeadlineMs,
    paused: value.paused,
    lastCommand,
    macroSession,
    pendingMacroCleanup,
  };
}

function normalizeMacroAdvanceRequest(value) {
  const keys = [
    "macroSessionId", "operationId", "baseRevision", "simulationMilliseconds", "wallMilliseconds",
  ];
  if (!hasExactKeys(value, keys)) {
    throw runtimeError("native player-authority macro request is invalid");
  }
  const request = {
    macroSessionId: requireLogicalId(value.macroSessionId, "macroSessionId"),
    operationId: requireLogicalId(value.operationId, "operationId"),
    baseRevision: requireSafeInteger(value.baseRevision, 0, "baseRevision"),
    simulationMilliseconds: requireSafeInteger(
      value.simulationMilliseconds,
      1,
      "simulationMilliseconds",
    ),
    wallMilliseconds: requireSafeInteger(value.wallMilliseconds, 1, "wallMilliseconds"),
  };
  if (request.simulationMilliseconds > MAX_MACRO_BUDGET_MILLISECONDS ||
      request.wallMilliseconds > MAX_MACRO_BUDGET_MILLISECONDS) {
    throw runtimeError("native player-authority macro budget is invalid");
  }
  return Object.freeze(request);
}

function validateMacroAdvanceReceipt(value, context, request) {
  const keys = [
    "acknowledgedSequence", "macroSessionId", "operationId", "baseRevision", "revision",
    "simulationMilliseconds", "wallMilliseconds", "algorithmVersion", "settledDeadlineMs",
    "checkpoint", "summary", "duplicate",
  ];
  if (!hasExactKeys(value, keys) || value.macroSessionId !== request.macroSessionId ||
      value.operationId !== request.operationId || value.baseRevision !== request.baseRevision ||
      value.simulationMilliseconds !== request.simulationMilliseconds ||
      value.wallMilliseconds !== request.wallMilliseconds || typeof value.duplicate !== "boolean") {
    throw runtimeError(
      "native player-authority macro receipt does not match the request",
      "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID",
    );
  }
  const revision = requireSafeInteger(value.revision, request.baseRevision + 1, "macro revision");
  const acknowledgedSequence = requireSafeInteger(
    value.acknowledgedSequence,
    context.nextSequence,
    "macro acknowledgedSequence",
  );
  const revisionDelta = revision - request.baseRevision;
  const sequenceDelta = acknowledgedSequence - (context.nextSequence - 1);
  const expectedSettledDeadlineMs = context.nextDeadlineMs - TICK_MILLISECONDS + request.wallMilliseconds;
  if (request.baseRevision !== context.revision || revisionDelta !== sequenceDelta ||
      revisionDelta < 1 || revisionDelta > 64 ||
      value.settledDeadlineMs !== expectedSettledDeadlineMs) {
    throw runtimeError(
      "native player-authority macro receipt is not contiguous",
      "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID",
    );
  }
  const algorithmVersion = requireLogicalId(value.algorithmVersion, "macro algorithmVersion");
  const checkpoint = normalizeCheckpoint(value.checkpoint, "native player-authority macro checkpoint");
  if (checkpoint.revision !== revision || checkpoint.generation < context.checkpoint.generation) {
    throw runtimeError(
      "native player-authority macro checkpoint regressed",
      "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID",
    );
  }
  validateSummary(value.summary, revision, "native player-authority macro summary");
  return { revision, acknowledgedSequence, algorithmVersion, checkpoint, summary: value.summary };
}

function validateMacroFinishReceipt(value, context, macroSessionId) {
  if (!isRecord(value) || !isRecord(value.lease)) {
    throw runtimeError("native player-authority macro finish receipt is invalid");
  }
  const lease = value.lease;
  const checkpoint = normalizeCheckpoint(lease.checkpoint, "native macro finish checkpoint");
  const acknowledgedCheckpoint = normalizeCheckpoint(
    lease.acknowledged?.checkpoint,
    "native macro finish acknowledged checkpoint",
  );
  if (lease.phase !== "active" || lease.kind !== "native-core-exact-realtime-player-authority-lease-v1" ||
      lease.runId !== context.runId || lease.mode !== "normal" || lease.slot !== "normal-main" ||
      lease.pendingTick !== null || lease.pendingCommand != null || lease.pendingAdvance != null ||
      lease.macroSession != null || lease.lastFinishedMacroSessionId !== macroSessionId ||
      lease.acknowledged?.sequence !== context.nextSequence - 1 ||
      lease.acknowledged?.revision !== context.revision ||
      lease.acknowledged?.settledDeadlineMs !== context.nextDeadlineMs - TICK_MILLISECONDS ||
      !sameCheckpoint(checkpoint, context.checkpoint) ||
      !sameCheckpoint(acknowledgedCheckpoint, context.checkpoint)) {
    throw runtimeError(
      "native player-authority macro finish identity conflicts",
      "NATIVE_PLAYER_AUTHORITY_MACRO_FINISH_INVALID",
    );
  }
  validateSummary(value.summary, context.revision, "native player-authority macro finish summary");
  return value.summary;
}

function validateCommandReceipt(value, context, command, replay) {
  const keys = [
    "sequence", "commandId", "baseRevision", "revision", "settledDeadlineMs", "checkpoint",
    "changedEntityIds", "changedBeltIds", "topologyDirty", "summary", "duplicate",
  ];
  const expectedSequence = replay ? context.nextSequence - 1 : context.nextSequence;
  const expectedRevision = replay ? context.revision : context.revision + 1;
  if (!hasExactKeys(value, keys) || value.sequence !== expectedSequence ||
      value.commandId !== command.commandId || value.baseRevision !== command.baseRevision ||
      value.revision !== command.baseRevision + 1 || value.revision !== expectedRevision ||
      value.settledDeadlineMs !== context.nextDeadlineMs - TICK_MILLISECONDS ||
      typeof value.duplicate !== "boolean" || (replay && value.duplicate !== true)) {
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
  if (replay && !sameCheckpoint(checkpoint, context.checkpoint)) {
    throw runtimeError(
      "native player-authority replayed command checkpoint changed",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    );
  }
  validateSummary(value.summary, value.revision, "native player-authority command summary");
  const changes = normalizeChangeReceipt(
    value,
    "native player-authority command change receipt",
    "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
  );
  if (replay && (!context.lastCommand || !sameChangeReceipt(changes, context.lastCommand))) {
    throw runtimeError(
      "native player-authority replayed command change receipt differs",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
    );
  }
  return { checkpoint, summary: value.summary, changes };
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
    macroSessionId: context?.macroSession?.macroSessionId ?? null,
    macroAlgorithmVersion: context?.macroSession?.algorithmVersion ?? null,
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
        typeof options.registry.commitPlayerAuthorityPause !== "function" ||
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
    this.pendingPauseAction = null;
    this.pauseDrainInProgress = false;
    this.pendingMacroAction = null;
    // A main-owned checkpoint/export read holds the scheduler at an already
    // acknowledged durable boundary. It is intentionally separate from the
    // mutation `inFlight` promise so renderer clock frames never advertise a
    // synthetic gameplay operation.
    this.persistenceBoundaryInFlight = false;
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
    let recoveredCommand = null;
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
          paused: recovered.paused,
          lastCommand: Object.freeze({
            commandId: recovered.commandId,
            baseRevision: recovered.baseRevision,
            revision: recovered.revision,
            checkpoint: recovered.checkpoint,
            ...recovered.changes,
          }),
          macroSession: null,
        };
        recoveredCommand = this.context.lastCommand;
        if (recovered.paused) {
          if (this.inFlight === operation) this.inFlight = null;
          this.currentOperation = null;
        }
        this.transition(recovered.paused ? "paused" : "active");
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
      .then(() => Object.freeze({
        ...this.snapshot(),
        previousRevision: recoveredCommand.baseRevision,
        changedEntityIds: recoveredCommand.changedEntityIds,
        changedBeltIds: recoveredCommand.changedBeltIds,
        topologyDirty: recoveredCommand.topologyDirty,
      }));
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
      const phase = recovered.paused
        ? "paused"
        : recovered.macroSession ? "macro-active" : "active";
      const snapshot = this.transition(phase);
      if (phase === "active") this.pump();
      return recovered.lastCommand ? Object.freeze({
        ...snapshot,
        previousRevision: recovered.lastCommand.baseRevision,
        changedEntityIds: recovered.lastCommand.changedEntityIds,
        changedBeltIds: recovered.lastCommand.changedBeltIds,
        topologyDirty: recovered.lastCommand.topologyDirty,
      }) : snapshot;
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
        paused: false,
        lastCommand: null,
        macroSession: null,
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
    let replay = false;
    try {
      request = normalizeCommandRequest(rawRequest);
      if (this.commandQueue.length >= 64) {
        throw runtimeError(
          "native player-authority command queue is full",
          "NATIVE_PLAYER_AUTHORITY_COMMAND_QUEUE_FULL",
        );
      }
      replay = !this.inFlight && !this.activeCommand && this.commandQueue.length === 0 &&
        this.context.lastCommand?.commandId === request.commandId &&
        this.context.lastCommand?.baseRevision === request.baseRevision &&
        this.context.lastCommand?.revision === this.context.revision;
      let projectedRevision = this.context.revision;
      if (!replay && (this.currentOperation === "tick" || this.currentOperation === "command")) {
        projectedRevision += 1;
      }
      if (!replay) projectedRevision += this.commandQueue.length;
      if (!Number.isSafeInteger(projectedRevision) ||
          (!replay && request.baseRevision !== projectedRevision)) {
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
    this.commandQueue.push({ request, replay, promise, resolve: resolveCommand, reject: rejectCommand });
    this.pump();
    return promise;
  }

  commitSystemSpaceStationIntent(rawRequest) {
    if (this.phase !== "active" || !this.context) {
      return Promise.reject(runtimeError(
        "native player-authority runtime is not accepting system-space-station intents",
      ));
    }
    let request;
    let replay = false;
    try {
      request = normalizeSystemSpaceStationCommandRequest(rawRequest);
      if (this.commandQueue.length >= 64) {
        throw runtimeError(
          "native player-authority command queue is full",
          "NATIVE_PLAYER_AUTHORITY_COMMAND_QUEUE_FULL",
        );
      }
      replay = !this.inFlight && !this.activeCommand && this.commandQueue.length === 0 &&
        this.context.lastCommand?.commandId === request.commandId &&
        this.context.lastCommand?.baseRevision === request.baseRevision &&
        this.context.lastCommand?.revision === this.context.revision;
      let projectedRevision = this.context.revision;
      if (!replay && (this.currentOperation === "tick" || this.currentOperation === "command")) {
        projectedRevision += 1;
      }
      if (!replay) projectedRevision += this.commandQueue.length;
      if (!Number.isSafeInteger(projectedRevision) ||
          !replay && request.baseRevision !== projectedRevision) {
        throw runtimeError(
          "native player-authority system-space-station revision is not the queued revision",
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
    this.commandQueue.push({ request, replay, promise, resolve: resolveCommand, reject: rejectCommand });
    this.pump();
    return promise;
  }

  /**
   * Commits the player-visible pause flag and the exact-realtime lease phase as
   * one durable Host transaction. The caller supplies only the desired state:
   * this main-process runtime owns every identity, revision, and wall-clock
   * field. A pause first drains the exact ticks that were due when the request
   * was made. A resume installs a fresh anchor, so wall time spent paused can
   * never become simulation backlog.
   */
  setPaused(targetPaused) {
    if (typeof targetPaused !== "boolean") {
      return Promise.reject(runtimeError(
        "native player-authority pause target is invalid",
        "NATIVE_PLAYER_AUTHORITY_PAUSE_INVALID",
      ));
    }
    if (!this.context || this.shutdownRequested) {
      return Promise.reject(runtimeError("native player-authority pause lifecycle is unavailable"));
    }
    if (this.phase === (targetPaused ? "paused" : "active") &&
        !this.inFlight && this.pendingPauseAction === null) {
      return Promise.resolve(this.snapshot());
    }
    const uncertainPhase = targetPaused ? "pause-uncertain" : "resume-uncertain";
    if (this.phase === uncertainPhase && this.pendingPauseAction?.request?.targetPaused === targetPaused) {
      return this.executePauseTransition();
    }
    const sourcePhase = targetPaused ? "active" : "paused";
    if (this.phase !== sourcePhase || this.inFlight || this.currentOperation !== null ||
        this.persistenceBoundaryInFlight || this.activeCommand || this.commandQueue.length > 0 ||
        this.pendingPauseAction !== null || this.pendingMacroAction !== null ||
        this.context.macroSession !== null) {
      return Promise.reject(runtimeError(
        "native player-authority pause lifecycle requires a settled boundary",
        "NATIVE_PLAYER_AUTHORITY_PAUSE_BUSY",
      ));
    }
    let requestedAtMs;
    try {
      const now = this.now();
      if (!Number.isFinite(now) || now < 0) {
        throw runtimeError(
          "native player-authority pause clock is invalid",
          "NATIVE_PLAYER_AUTHORITY_PAUSE_INVALID",
        );
      }
      requestedAtMs = Math.floor(now);
      if (!Number.isSafeInteger(requestedAtMs)) {
        throw runtimeError(
          "native player-authority pause clock exceeds the safe integer range",
          "NATIVE_PLAYER_AUTHORITY_PAUSE_INVALID",
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    if (targetPaused) return this.drainDueTicksAndPause(requestedAtMs);
    const previousSettledDeadlineMs = this.context.nextDeadlineMs - TICK_MILLISECONDS;
    const settledDeadlineMs = Math.max(previousSettledDeadlineMs, requestedAtMs);
    if (!Number.isSafeInteger(settledDeadlineMs + TICK_MILLISECONDS)) {
      return Promise.reject(runtimeError(
        "native player-authority resume clock exceeds the safe integer range",
        "NATIVE_PLAYER_AUTHORITY_PAUSE_INVALID",
      ));
    }
    this.pendingPauseAction = Object.freeze({
      request: Object.freeze({
        sessionId: this.context.sessionId,
        runId: this.context.runId,
        baseRevision: this.context.revision,
        targetPaused: false,
        settledDeadlineMs,
      }),
    });
    return this.executePauseTransition();
  }

  async drainDueTicksAndPause(requestedAtMs) {
    const context = this.context;
    if (!context || this.phase !== "active" || this.pauseDrainInProgress) {
      throw runtimeError(
        "native player-authority pause drain cannot start",
        "NATIVE_PLAYER_AUTHORITY_PAUSE_BUSY",
      );
    }
    this.pauseDrainInProgress = true;
    this.currentOperation = "pause";
    this.transition("pausing");
    try {
      while (context.nextDeadlineMs <= requestedAtMs) {
        await this.commitCurrentSequence({ pauseDrain: true });
        if (this.shutdownRequested || this.context !== context || this.phase !== "pausing") {
          throw runtimeError(
            "native player-authority pause drain changed before completion",
            "NATIVE_PLAYER_AUTHORITY_PAUSE_UNCERTAIN",
          );
        }
      }
      const settledDeadlineMs = context.nextDeadlineMs - TICK_MILLISECONDS;
      this.pendingPauseAction = Object.freeze({
        request: Object.freeze({
          sessionId: context.sessionId,
          runId: context.runId,
          baseRevision: context.revision,
          targetPaused: true,
          settledDeadlineMs,
        }),
      });
    } finally {
      this.pauseDrainInProgress = false;
      if (this.pendingPauseAction === null && this.currentOperation === "pause") {
        this.currentOperation = null;
      }
    }
    return this.executePauseTransition();
  }

  executePauseTransition() {
    const context = this.context;
    const pending = this.pendingPauseAction;
    if (!context || !pending || this.inFlight || this.persistenceBoundaryInFlight) {
      return Promise.reject(runtimeError(
        "native player-authority pause transition is not pending",
        "NATIVE_PLAYER_AUTHORITY_PAUSE_BUSY",
      ));
    }
    const request = pending.request;
    const operationName = request.targetPaused ? "pause" : "resume";
    this.currentOperation = operationName;
    this.transition(request.targetPaused ? "pausing" : "resuming");
    let operation;
    operation = Promise.resolve().then(() => this.registry.commitPlayerAuthorityPause(
      this.ownerId,
      request,
    )).then((receipt) => {
      if (this.shutdownRequested) {
        throw runtimeError(
          `native player-authority runtime shut down during ${operationName}`,
          "NATIVE_PLAYER_AUTHORITY_RUNTIME_SHUTDOWN",
        );
      }
      const validated = validatePauseLifecycleReceipt(receipt, context, request);
      const nextSequence = context.nextSequence + 1;
      const nextDeadlineMs = request.settledDeadlineMs + TICK_MILLISECONDS;
      if (!Number.isSafeInteger(nextSequence) || !Number.isSafeInteger(nextDeadlineMs)) {
        throw runtimeError("native player-authority pause clock exceeds the safe integer range");
      }
      context.revision = receipt.revision;
      context.checkpoint = validated.checkpoint;
      context.nextSequence = nextSequence;
      context.nextDeadlineMs = nextDeadlineMs;
      context.paused = request.targetPaused;
      context.lastCommand = null;
      this.pendingPauseAction = null;
      if (this.inFlight === operation) this.inFlight = null;
      this.currentOperation = null;
      this.transition(request.targetPaused ? "paused" : "active");
      return this.snapshot();
    }).catch((cause) => {
      const error = cause instanceof NativePlayerAuthorityRuntimeError
        ? cause
        : runtimeError(
          `native player-authority ${operationName} outcome is uncertain`,
          request.targetPaused
            ? "NATIVE_PLAYER_AUTHORITY_PAUSE_UNCERTAIN"
            : "NATIVE_PLAYER_AUTHORITY_RESUME_UNCERTAIN",
          cause,
        );
      if (!this.shutdownRequested) {
        this.transition(request.targetPaused ? "pause-uncertain" : "resume-uncertain", error);
      }
      throw error;
    }).finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
      this.currentOperation = null;
      if (this.phase === "active") this.pump();
    });
    this.inFlight = operation;
    return operation;
  }

  /**
   * Runs one main-process persistence read against an immutable, already ACKed
   * player-authority boundary. Every player-authority tick/command publishes
   * its checkpoint before the Rust lease ACK, so a manual save must validate
   * and reuse that checkpoint rather than enter the generic checkpoint path
   * (which is correctly fenced while this lease exists).
   */
  withSettledPersistenceBoundary(operation) {
    return this.withFrozenPersistenceBoundary(operation, false);
  }

  /**
   * Startup/reload reconciliation also has to bind a renderer while a durable
   * macro session is active. It freezes that already-ACKed macro checkpoint
   * without finishing, replaying, or advancing the macro operation.
   */
  withStartupReconciliationBoundary(operation) {
    return this.withFrozenPersistenceBoundary(operation, true);
  }

  async withFrozenPersistenceBoundary(operation, allowMacro) {
    if (typeof operation !== "function") {
      throw new TypeError("native player-authority persistence operation is invalid");
    }
    const phaseAllowed = this.phase === "active" || this.phase === "paused" ||
      allowMacro && this.phase === "macro-active";
    if (!phaseAllowed || !this.context || this.inFlight ||
        this.currentOperation !== null || this.persistenceBoundaryInFlight ||
        this.pendingMacroAction !== null ||
        (!allowMacro && this.context.macroSession !== null) ||
        (this.phase === "macro-active") !== (this.context.macroSession !== null) ||
        this.pendingPauseAction !== null || this.pauseDrainInProgress) {
      throw runtimeError(
        "native player-authority persistence requires a settled active boundary",
        "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
      );
    }
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.persistenceBoundaryInFlight = true;
    const context = this.context;
    const frozenPhase = this.phase;
    const frozenMacroSession = context.macroSession;
    const boundary = Object.freeze({
      sessionId: context.sessionId,
      runId: context.runId,
      revision: context.revision,
      checkpoint: Object.freeze({ ...context.checkpoint }),
      acknowledgedSequence: context.nextSequence - 1,
      settledDeadlineMs: context.nextDeadlineMs - TICK_MILLISECONDS,
      paused: frozenPhase === "paused",
    });
    try {
      const result = await operation(boundary);
      if (this.shutdownRequested || this.phase !== frozenPhase || this.context !== context ||
          context.sessionId !== boundary.sessionId || context.runId !== boundary.runId ||
          context.revision !== boundary.revision ||
          !sameCheckpoint(context.checkpoint, boundary.checkpoint) ||
          context.nextSequence - 1 !== boundary.acknowledgedSequence ||
          context.nextDeadlineMs - TICK_MILLISECONDS !== boundary.settledDeadlineMs ||
          (this.phase === "paused") !== boundary.paused ||
          context.macroSession !== frozenMacroSession || this.pendingMacroAction !== null ||
          this.inFlight || this.currentOperation !== null) {
        throw runtimeError(
          "native player-authority persistence boundary changed before completion",
          "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_STALE",
        );
      }
      return result;
    } finally {
      this.persistenceBoundaryInFlight = false;
      if (!this.shutdownRequested && this.phase === "active") this.pump();
    }
  }

  commitMacroAdvance(rawRequest) {
    if (this.persistenceBoundaryInFlight) {
      return Promise.reject(runtimeError(
        "native player-authority macro advance is blocked by persistence",
        "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
      ));
    }
    if (!this.context || !["active", "macro-active", "macro-uncertain"].includes(this.phase) ||
        this.inFlight || this.activeCommand || this.commandQueue.length > 0 ||
        typeof this.registry.commitPlayerAuthorityMacroAdvance !== "function") {
      return Promise.reject(runtimeError("native player-authority runtime cannot start a macro advance"));
    }
    let request;
    try {
      request = normalizeMacroAdvanceRequest(rawRequest);
      const currentMacro = this.context.macroSession;
      if (currentMacro && currentMacro.macroSessionId !== request.macroSessionId) {
        throw runtimeError(
          "native player-authority macro session identity conflicts",
          "NATIVE_PLAYER_AUTHORITY_MACRO_SESSION_CONFLICT",
        );
      }
      if (request.baseRevision !== this.context.revision) {
        throw runtimeError(
          "native player-authority macro base revision is stale",
          "NATIVE_PLAYER_AUTHORITY_MACRO_REVISION_MISMATCH",
        );
      }
      if (this.phase === "macro-uncertain") {
        const pending = this.pendingMacroAction;
        if (!pending || pending.kind !== "advance" ||
            JSON.stringify(pending.request) !== JSON.stringify(request)) {
          throw runtimeError(
            "native player-authority macro has a different uncertain operation",
            "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
          );
        }
      } else {
        this.pendingMacroAction = Object.freeze({ kind: "advance", request });
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    return this.executeMacroAdvance();
  }

  executeMacroAdvance() {
    const context = this.context;
    const pending = this.pendingMacroAction;
    if (!context || !pending || pending.kind !== "advance" || this.inFlight) {
      return Promise.reject(runtimeError("native player-authority macro advance is not pending"));
    }
    const request = pending.request;
    this.currentOperation = "macro-advance";
    this.transition("macro-committing");
    let operation;
    operation = Promise.resolve().then(() => this.registry.commitPlayerAuthorityMacroAdvance(this.ownerId, {
      sessionId: context.sessionId,
      runId: context.runId,
      ...request,
    })).then((receipt) => {
      if (this.shutdownRequested) {
        throw runtimeError(
          "native player-authority runtime shut down during a macro advance",
          "NATIVE_PLAYER_AUTHORITY_RUNTIME_SHUTDOWN",
        );
      }
      const validated = validateMacroAdvanceReceipt(receipt, context, request);
      if (context.macroSession && context.macroSession.algorithmVersion !== validated.algorithmVersion) {
        throw runtimeError(
          "native player-authority macro algorithm changed inside one session",
          "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID",
        );
      }
      const nextSequence = validated.acknowledgedSequence + 1;
      const nextDeadlineMs = receipt.settledDeadlineMs + TICK_MILLISECONDS;
      if (!Number.isSafeInteger(nextSequence) || !Number.isSafeInteger(nextDeadlineMs)) {
        throw runtimeError("native player-authority macro clock exceeds the safe integer range");
      }
      context.revision = validated.revision;
      context.checkpoint = validated.checkpoint;
      context.nextSequence = nextSequence;
      context.nextDeadlineMs = nextDeadlineMs;
      context.lastCommand = null;
      context.macroSession = Object.freeze({
        macroSessionId: request.macroSessionId,
        algorithmVersion: validated.algorithmVersion,
        lastOperation: Object.freeze({
          operationId: request.operationId,
          revision: validated.revision,
          simulationMilliseconds: request.simulationMilliseconds,
          wallMilliseconds: request.wallMilliseconds,
        }),
      });
      this.pendingMacroAction = null;
      this.transition("macro-active");
      return this.snapshot();
    }).catch((cause) => {
      const error = cause instanceof NativePlayerAuthorityRuntimeError
        ? cause
        : runtimeError(
          "native player-authority macro outcome is uncertain",
          "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
          cause,
        );
      if (!this.shutdownRequested) this.transition("macro-uncertain", error);
      throw error;
    }).finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
      this.currentOperation = null;
    });
    this.inFlight = operation;
    return operation;
  }

  finishMacroSession(rawRequest) {
    if (this.persistenceBoundaryInFlight) {
      return Promise.reject(runtimeError(
        "native player-authority macro finish is blocked by persistence",
        "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
      ));
    }
    if (!this.context || !["macro-active", "macro-uncertain"].includes(this.phase) ||
        this.inFlight || typeof this.registry.finishPlayerAuthorityMacroSession !== "function") {
      return Promise.reject(runtimeError("native player-authority macro session cannot finish"));
    }
    let macroSessionId;
    try {
      if (!hasExactKeys(rawRequest, ["macroSessionId"])) {
        throw runtimeError("native player-authority macro finish request is invalid");
      }
      macroSessionId = requireLogicalId(rawRequest.macroSessionId, "macroSessionId");
      if (this.context.macroSession?.macroSessionId !== macroSessionId) {
        throw runtimeError(
          "native player-authority macro finish session is stale",
          "NATIVE_PLAYER_AUTHORITY_MACRO_SESSION_CONFLICT",
        );
      }
      if (this.phase === "macro-uncertain") {
        const pending = this.pendingMacroAction;
        if (!pending || pending.kind !== "finish" || pending.macroSessionId !== macroSessionId) {
          throw runtimeError(
            "native player-authority macro has a different uncertain operation",
            "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
          );
        }
      } else {
        this.pendingMacroAction = Object.freeze({ kind: "finish", macroSessionId });
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.executeMacroFinish();
  }

  executeMacroFinish() {
    const context = this.context;
    const pending = this.pendingMacroAction;
    if (!context || !pending || pending.kind !== "finish" || this.inFlight) {
      return Promise.reject(runtimeError("native player-authority macro finish is not pending"));
    }
    this.currentOperation = "macro-finish";
    this.transition("macro-finishing");
    let operation;
    operation = Promise.resolve().then(() => this.registry.finishPlayerAuthorityMacroSession(this.ownerId, {
      sessionId: context.sessionId,
      runId: context.runId,
      macroSessionId: pending.macroSessionId,
    })).then((receipt) => {
      if (this.shutdownRequested) {
        throw runtimeError(
          "native player-authority runtime shut down while finishing a macro session",
          "NATIVE_PLAYER_AUTHORITY_RUNTIME_SHUTDOWN",
        );
      }
      validateMacroFinishReceipt(receipt, context, pending.macroSessionId);
      context.macroSession = null;
      this.pendingMacroAction = null;
      this.transition("active");
      return this.snapshot();
    }).catch((cause) => {
      const error = cause instanceof NativePlayerAuthorityRuntimeError
        ? cause
        : runtimeError(
          "native player-authority macro finish outcome is uncertain",
          "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
          cause,
        );
      if (!this.shutdownRequested) this.transition("macro-uncertain", error);
      throw error;
    }).finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
      this.currentOperation = null;
      if (this.phase === "active") this.pump();
    });
    this.inFlight = operation;
    return operation;
  }

  pump() {
    if (this.phase !== "active" || !this.context || this.inFlight || this.persistenceBoundaryInFlight ||
        this.pendingPauseAction !== null || this.pauseDrainInProgress) return;
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
    if (!context || !entry || this.inFlight || this.persistenceBoundaryInFlight) return this.inFlight;
    this.currentOperation = "command";
    let resolveInFlight;
    const completion = new Promise((resolve) => {
      resolveInFlight = resolve;
    });
    this.inFlight = completion;
    const commit = () => {
      if (entry.request.kind === "system-space-station") {
        if (typeof this.registry.commitPlayerAuthoritySystemSpaceStationCommand !== "function") {
          throw runtimeError(
          "native player-authority system-space-station capability is unavailable",
          "NATIVE_PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_UNAVAILABLE",
          );
        }
        return this.registry.commitPlayerAuthoritySystemSpaceStationCommand(this.ownerId, {
          sessionId: context.sessionId,
          runId: context.runId,
          commandId: entry.request.commandId,
          baseRevision: entry.request.baseRevision,
          expectedRegistryFingerprint: entry.request.expectedRegistryFingerprint,
          intent: entry.request.intent,
        });
      }
      return this.registry.commitPlayerAuthorityCommand(this.ownerId, {
        sessionId: context.sessionId,
        runId: context.runId,
        commandId: entry.request.commandId,
        baseRevision: entry.request.baseRevision,
        command: entry.request.command,
      });
    };
    Promise.resolve().then(commit).then((receipt) => {
      if (this.shutdownRequested) {
        throw runtimeError(
          "native player-authority runtime shut down during a command",
          "NATIVE_PLAYER_AUTHORITY_RUNTIME_SHUTDOWN",
        );
      }
      const validated = validateCommandReceipt(receipt, context, entry.request, entry.replay);
      if (!entry.replay) {
        const nextSequence = context.nextSequence + 1;
        if (!Number.isSafeInteger(nextSequence)) {
          throw runtimeError("native player-authority event sequence exceeds the safe integer range");
        }
        context.revision = receipt.revision;
        context.checkpoint = validated.checkpoint;
        context.nextSequence = nextSequence;
      }
      context.lastCommand = Object.freeze({
        commandId: entry.request.commandId,
        baseRevision: entry.request.baseRevision,
        revision: receipt.revision,
        checkpoint: validated.checkpoint,
        ...validated.changes,
      });
      this.activeCommand = null;
      this.transition("active");
      return { ok: true, command: context.lastCommand };
    }).catch((cause) => {
      const definitePreStageRejection =
        isDefiniteSystemSpaceStationPreStageRejection(entry, cause);
      const error = definitePreStageRejection
        ? runtimeError(
          typeof cause.message === "string" && cause.message.length > 0
            ? cause.message
            : "native system-space-station command was rejected before durable staging",
          SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE,
          cause,
        )
        : cause instanceof NativePlayerAuthorityRuntimeError
          ? cause
          : runtimeError(
            "native player-authority command outcome is uncertain",
            "NATIVE_PLAYER_AUTHORITY_COMMAND_UNCERTAIN",
            cause,
          );
      if (!this.shutdownRequested) {
        this.rejectQueuedCommands(error);
        if (definitePreStageRejection) {
          // Rust emits this code only before creating a durable pending
          // command. The active intent and every command whose base revision
          // depended on it are therefore safe to discard. Keep the published
          // checkpoint unchanged and resume the exact clock immediately.
          this.activeCommand = null;
          this.transition("active");
        } else {
          this.transition("uncertain", error);
        }
      }
      return { ok: false, error, definitePreStageRejection };
    }).then((outcome) => {
      this.inFlight = null;
      this.currentOperation = null;
      if (outcome.ok) {
        const snapshot = this.snapshot();
        entry.resolve(Object.freeze({
          ...snapshot,
          previousRevision: outcome.command.baseRevision,
          changedEntityIds: outcome.command.changedEntityIds,
          changedBeltIds: outcome.command.changedBeltIds,
          topologyDirty: outcome.command.topologyDirty,
        }));
        resolveInFlight(snapshot);
        this.pump();
      } else {
        entry.reject(outcome.error);
        resolveInFlight(this.snapshot());
        if (outcome.definitePreStageRejection && this.phase === "active") this.pump();
      }
    });
    return completion;
  }

  armTimer() {
    if (this.phase !== "active" || !this.context || this.timer !== null || this.inFlight ||
        this.persistenceBoundaryInFlight || this.pendingPauseAction !== null || this.pauseDrainInProgress ||
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
    if (this.persistenceBoundaryInFlight) return Promise.resolve(this.snapshot());
    if (this.now() < this.context.nextDeadlineMs) {
      this.armTimer();
      return Promise.resolve(this.snapshot());
    }
    return this.commitCurrentSequence();
  }

  retryUncertain() {
    if (["pause-uncertain", "resume-uncertain"].includes(this.phase) &&
        this.context && !this.inFlight && this.pendingPauseAction) {
      return this.executePauseTransition();
    }
    if (this.phase === "macro-uncertain" && this.context && !this.inFlight) {
      if (this.pendingMacroAction?.kind === "advance") return this.executeMacroAdvance();
      if (this.pendingMacroAction?.kind === "finish") return this.executeMacroFinish();
      return Promise.reject(runtimeError("native player-authority runtime has no uncertain macro operation"));
    }
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

  commitCurrentSequence(options = null) {
    const context = this.context;
    if (!context) return Promise.reject(runtimeError("native player-authority runtime is not active"));
    if (this.persistenceBoundaryInFlight) {
      return Promise.reject(runtimeError(
        "native player-authority persistence boundary is active",
        "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
      ));
    }
    const pauseDrain = options?.pauseDrain === true;
    this.currentOperation = pauseDrain ? "pause" : "tick";
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
      context.lastCommand = null;
      this.transition(pauseDrain ? "pausing" : "active");
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
      this.currentOperation = pauseDrain && this.pauseDrainInProgress ? "pause" : null;
      if (!pauseDrain) this.pump();
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
  SYSTEM_SPACE_STATION_PRE_STAGE_REJECTED_CODE,
  TICK_MILLISECONDS,
};
