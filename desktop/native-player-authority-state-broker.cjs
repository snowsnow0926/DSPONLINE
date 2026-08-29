"use strict";

/*
 * Renderer-safe, read-only view of the main-owned Rust authority clock.
 *
 * Ordinary exact/command states retain the v1 shape used by the existing
 * thin-UI projection router. Productive macro windows use a separate v2
 * status shape: the broker validates every main-owned identity internally,
 * then deliberately drops session, run, macro, operation and algorithm IDs.
 * No method in this module can mutate or recover the authority runtime.
 */

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_MACRO_BUDGET_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const LEGACY_PHASES = new Set([
  "idle", "activating", "recovering", "active", "pausing", "paused", "resuming",
  "pause-uncertain", "resume-uncertain", "uncertain", "faulted", "shutdown",
]);
const MACRO_PHASES = new Set([
  "macro-active", "macro-committing", "macro-finishing", "macro-uncertain",
]);
const LEGACY_OPERATIONS = new Set([
  null, "activation", "recovery", "tick", "command", "pause", "resume",
]);
const MACRO_OPERATIONS = new Set([null, "macro-advance", "macro-finish"]);

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

function hasExactKeys(value, keys) {
  return isRecord(value) && Reflect.ownKeys(value).every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function nullableLogicalId(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
      !LOGICAL_ID_PATTERN.test(value)) {
    throw stateError(`${label} is invalid`);
  }
  return value;
}

function requireLogicalId(value, label) {
  const normalized = nullableLogicalId(value, label);
  if (normalized === null) throw stateError(`${label} is missing`);
  return normalized;
}

function nullableSafeInteger(value, minimum, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < minimum) throw stateError(`${label} is invalid`);
  return value;
}

function requireSafeInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw stateError(`${label} is invalid`);
  }
  return value;
}

function normalizeErrorCode(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !ERROR_CODE_PATTERN.test(value)) {
    throw stateError("native player-authority lastErrorCode is invalid");
  }
  return value;
}

function normalizeCommonState(value) {
  const phase = value?.phase;
  const macroPhase = MACRO_PHASES.has(phase) ||
    (["faulted", "shutdown"].includes(phase) &&
      ["macro-advance", "macro-finish"].includes(value?.currentOperation));
  if (!isRecord(value) || (!macroPhase && !LEGACY_PHASES.has(phase)) ||
      typeof value.inFlight !== "boolean" ||
      !(macroPhase ? MACRO_OPERATIONS : LEGACY_OPERATIONS).has(value.currentOperation) ||
      !Number.isSafeInteger(value.queuedCommands) || value.queuedCommands < 0 ||
      value.queuedCommands > 64) {
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
  const lastErrorCode = normalizeErrorCode(value.lastErrorCode);
  const identityValues = [sessionId, runId, revision, acknowledgedSequence, nextSequence, nextDeadlineMs];
  const hasCompleteIdentity = identityValues.every((entry) => entry !== null);
  const hasNoIdentity = identityValues.every((entry) => entry === null);
  if (!hasCompleteIdentity && !hasNoIdentity) {
    throw stateError("native player-authority state has a partial identity");
  }
  if (hasCompleteIdentity && acknowledgedSequence + 1 !== nextSequence) {
    throw stateError("native player-authority sequence is not contiguous");
  }
  if (([
    "active", "pausing", "paused", "resuming", "pause-uncertain", "resume-uncertain",
  ].includes(phase) || macroPhase) && !hasCompleteIdentity) {
    throw stateError("active native player-authority state is incomplete");
  }
  if (["idle", "activating", "recovering"].includes(phase) && !hasNoIdentity) {
    throw stateError("pre-authority state unexpectedly exposes an identity");
  }
  return {
    phase,
    macroPhase,
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
    hasCompleteIdentity,
    hasNoIdentity,
  };
}

function normalizeMacroIdentity(value, common, forceMacro) {
  const hasSessionField = Object.hasOwn(value, "macroSessionId");
  const hasAlgorithmField = Object.hasOwn(value, "macroAlgorithmVersion");
  if (hasSessionField !== hasAlgorithmField) {
    throw stateError("native player-authority macro identity is partial");
  }
  const macroSessionId = hasSessionField
    ? nullableLogicalId(value.macroSessionId, "native player-authority macroSessionId")
    : null;
  const macroAlgorithmVersion = hasAlgorithmField
    ? nullableLogicalId(value.macroAlgorithmVersion, "native player-authority macroAlgorithmVersion")
    : null;
  if ((macroSessionId === null) !== (macroAlgorithmVersion === null)) {
    throw stateError("native player-authority macro identity is partial");
  }
  const macroState = forceMacro || common.macroPhase ||
    (["faulted", "shutdown"].includes(common.phase) && macroSessionId !== null);
  if (!macroState && macroSessionId !== null) {
    throw stateError("non-macro native player-authority state has a macro identity");
  }
  if (common.macroPhase && (!hasSessionField || !hasAlgorithmField)) {
    throw stateError("native player-authority macro fields are missing");
  }
  if (["macro-active", "macro-finishing"].includes(common.phase) && macroSessionId === null) {
    throw stateError("native player-authority macro session is incomplete");
  }
  return { macroState, macroSessionId, macroAlgorithmVersion };
}

function assertMacroPhaseShape(common) {
  if (!common.macroPhase && !["faulted", "shutdown"].includes(common.phase)) {
    throw stateError("native player-authority macro phase is invalid");
  }
  if (common.queuedCommands !== 0) {
    throw stateError("native player-authority macro state has queued commands");
  }
  if (common.phase === "macro-active" &&
      (common.inFlight || common.currentOperation !== null || common.lastErrorCode !== null)) {
    throw stateError("native player-authority macro-active state is not settled");
  }
  if (common.phase === "macro-committing" &&
      (common.currentOperation !== "macro-advance" || common.lastErrorCode !== null)) {
    throw stateError("native player-authority macro commit state is invalid");
  }
  if (common.phase === "macro-finishing" &&
      (common.currentOperation !== "macro-finish" || common.lastErrorCode !== null)) {
    throw stateError("native player-authority macro finish state is invalid");
  }
  if (common.phase === "macro-uncertain") {
    if (common.lastErrorCode === null ||
        (common.inFlight && common.currentOperation === null) ||
        (!common.inFlight && common.currentOperation !== null)) {
      throw stateError("native player-authority macro uncertain state is invalid");
    }
  }
  if (["faulted", "shutdown"].includes(common.phase) && common.lastErrorCode === null) {
    throw stateError("terminal native player-authority macro state has no paused reason");
  }
}

function normalizeMacroDetails(value) {
  if (value === undefined || value === null) {
    return {
      simulationBudgetMilliseconds: null,
      wallBudgetMilliseconds: null,
      simulationProgressMilliseconds: null,
      wallProgressMilliseconds: null,
      operationKind: null,
      pausedReason: null,
    };
  }
  const keys = [
    "revision", "simulationBudgetMilliseconds", "wallBudgetMilliseconds",
    "simulationProgressMilliseconds", "wallProgressMilliseconds", "operationKind", "pausedReason",
  ];
  if (!hasExactKeys(value, keys)) throw stateError("native player-authority macro status is invalid");
  const revision = requireSafeInteger(value.revision, 0, Number.MAX_SAFE_INTEGER, "macro status revision");
  const simulationBudgetMilliseconds = requireSafeInteger(
    value.simulationBudgetMilliseconds,
    1,
    MAX_MACRO_BUDGET_MILLISECONDS,
    "macro simulation budget",
  );
  const wallBudgetMilliseconds = requireSafeInteger(
    value.wallBudgetMilliseconds,
    1,
    MAX_MACRO_BUDGET_MILLISECONDS,
    "macro wall budget",
  );
  const nullableProgress = (entry, maximum, label) => entry === null
    ? null
    : requireSafeInteger(entry, 0, maximum, label);
  const simulationProgressMilliseconds = nullableProgress(
    value.simulationProgressMilliseconds,
    simulationBudgetMilliseconds,
    "macro simulation progress",
  );
  const wallProgressMilliseconds = nullableProgress(
    value.wallProgressMilliseconds,
    wallBudgetMilliseconds,
    "macro wall progress",
  );
  if ((simulationProgressMilliseconds === null) !== (wallProgressMilliseconds === null) ||
      !["advance", "finish", "active"].includes(value.operationKind) ||
      ![
        "macro-window-active", "macro-advance-committing", "macro-finish-committing",
        "macro-advance-uncertain", "macro-finish-uncertain", "macro-runtime-faulted",
        "macro-runtime-shutdown",
      ].includes(value.pausedReason)) {
    throw stateError("native player-authority macro progress is invalid");
  }
  return {
    revision,
    simulationBudgetMilliseconds,
    wallBudgetMilliseconds,
    simulationProgressMilliseconds,
    wallProgressMilliseconds,
    operationKind: value.operationKind,
    pausedReason: value.pausedReason,
  };
}

function fallbackMacroPausedReason(common) {
  if (common.phase === "macro-active") return "macro-window-active";
  if (common.phase === "macro-committing") return "macro-advance-committing";
  if (common.phase === "macro-finishing") return "macro-finish-committing";
  if (common.phase === "macro-uncertain") {
    return common.currentOperation === "macro-finish"
      ? "macro-finish-uncertain"
      : "macro-advance-uncertain";
  }
  return common.phase === "shutdown" ? "macro-runtime-shutdown" : "macro-runtime-faulted";
}

function normalizeMacroRecoveryHint(value, common) {
  if (value === undefined || value === null) return null;
  if (!hasExactKeys(value, ["kind", "revision"]) ||
      value.kind !== "finished-pending-disable" || common.phase !== "active") {
    throw stateError("native player-authority macro recovery hint is invalid");
  }
  const revision = requireSafeInteger(
    value.revision,
    0,
    Number.MAX_SAFE_INTEGER,
    "macro recovery hint revision",
  );
  if (common.revision === null || revision > common.revision) {
    throw stateError("native player-authority macro recovery hint is stale");
  }
  return Object.freeze({ kind: "finished-pending-disable", revision });
}

function normalizeNativePlayerAuthorityState(value, macroDetails, macroRecoveryHint) {
  const common = normalizeCommonState(value);
  const macroIdentity = normalizeMacroIdentity(value, common, macroDetails !== undefined && macroDetails !== null);
  if (!macroIdentity.macroState) {
    if (macroDetails !== undefined && macroDetails !== null) {
      throw stateError("ordinary native player-authority state has macro status");
    }
    if (common.phase === "active" && common.lastErrorCode !== null) {
      throw stateError("active native player-authority state is incomplete");
    }
    if (common.phase === "paused" &&
        (common.inFlight || common.currentOperation !== null || common.lastErrorCode !== null ||
          common.queuedCommands !== 0)) {
      throw stateError("paused native player-authority state is not settled");
    }
    if (common.phase === "pausing" &&
        (common.currentOperation !== "pause" || common.lastErrorCode !== null) ||
        common.phase === "resuming" &&
        (common.currentOperation !== "resume" || common.lastErrorCode !== null)) {
      throw stateError("native player-authority pause lifecycle transition is invalid");
    }
    if (common.phase === "pause-uncertain" &&
        (common.lastErrorCode === null || ![null, "pause"].includes(common.currentOperation)) ||
        common.phase === "resume-uncertain" &&
        (common.lastErrorCode === null || ![null, "resume"].includes(common.currentOperation))) {
      throw stateError("native player-authority pause lifecycle uncertainty is invalid");
    }
    const recoveryHint = normalizeMacroRecoveryHint(macroRecoveryHint, common);
    return Object.freeze({
      schemaVersion: 1,
      phase: common.phase,
      sessionId: common.sessionId,
      runId: common.runId,
      revision: common.revision,
      acknowledgedSequence: common.acknowledgedSequence,
      nextSequence: common.nextSequence,
      nextDeadlineMs: common.nextDeadlineMs,
      inFlight: common.inFlight,
      currentOperation: common.currentOperation,
      queuedCommands: common.queuedCommands,
      lastErrorCode: common.lastErrorCode,
      ...(recoveryHint ? { macroRecoveryHint: recoveryHint } : {}),
    });
  }

  assertMacroPhaseShape(common);
  const details = normalizeMacroDetails(macroDetails);
  if (details.revision !== undefined && details.revision !== common.revision) {
    throw stateError(
      "native player-authority macro status revision is stale",
      "NATIVE_PLAYER_AUTHORITY_STATE_STALE",
    );
  }
  const currentOperation = common.currentOperation === "macro-advance"
    ? "advance"
    : common.currentOperation === "macro-finish"
      ? "finish"
      : null;
  return Object.freeze({
    schemaVersion: 2,
    statusKind: "macro",
    phase: common.phase,
    revision: common.revision,
    acknowledgedSequence: common.acknowledgedSequence,
    nextSequence: common.nextSequence,
    nextDeadlineMs: common.nextDeadlineMs,
    inFlight: common.inFlight,
    currentOperation,
    simulationBudgetMilliseconds: details.simulationBudgetMilliseconds,
    wallBudgetMilliseconds: details.wallBudgetMilliseconds,
    simulationProgressMilliseconds: details.simulationProgressMilliseconds,
    wallProgressMilliseconds: details.wallProgressMilliseconds,
    pausedReason: details.pausedReason ?? fallbackMacroPausedReason(common),
  });
}

function normalizeInternalMacroSession(value, snapshot, allowMissing) {
  if (value === null) {
    if (!allowMissing) throw stateError("native player-authority internal macro session is missing");
    return null;
  }
  if (!hasExactKeys(value, ["macroSessionId", "algorithmVersion", "lastOperation"]) ||
      !hasExactKeys(value.lastOperation, [
        "operationId", "revision", "simulationMilliseconds", "wallMilliseconds",
      ])) {
    throw stateError("native player-authority internal macro session is invalid");
  }
  const macroSessionId = requireLogicalId(value.macroSessionId, "internal macro sessionId");
  const algorithmVersion = requireLogicalId(value.algorithmVersion, "internal macro algorithmVersion");
  requireLogicalId(value.lastOperation.operationId, "internal macro operationId");
  const revision = requireSafeInteger(
    value.lastOperation.revision,
    0,
    Number.MAX_SAFE_INTEGER,
    "internal macro revision",
  );
  const simulationMilliseconds = requireSafeInteger(
    value.lastOperation.simulationMilliseconds,
    1,
    MAX_MACRO_BUDGET_MILLISECONDS,
    "internal macro simulation budget",
  );
  const wallMilliseconds = requireSafeInteger(
    value.lastOperation.wallMilliseconds,
    1,
    MAX_MACRO_BUDGET_MILLISECONDS,
    "internal macro wall budget",
  );
  if (macroSessionId !== snapshot.macroSessionId || algorithmVersion !== snapshot.macroAlgorithmVersion ||
      revision !== snapshot.revision) {
    throw stateError(
      "native player-authority internal macro session is stale",
      "NATIVE_PLAYER_AUTHORITY_STATE_STALE",
    );
  }
  return { macroSessionId, revision, simulationMilliseconds, wallMilliseconds };
}

function normalizePendingMacroAction(value, snapshot, macroSession) {
  if (value === null) return null;
  if (!isRecord(value) || !["advance", "finish"].includes(value.kind)) {
    throw stateError("native player-authority pending macro action is invalid");
  }
  if (value.kind === "advance") {
    if (!hasExactKeys(value, ["kind", "request"]) || !hasExactKeys(value.request, [
      "macroSessionId", "operationId", "baseRevision", "simulationMilliseconds", "wallMilliseconds",
    ])) {
      throw stateError("native player-authority pending macro advance is invalid");
    }
    const macroSessionId = requireLogicalId(value.request.macroSessionId, "pending macro sessionId");
    requireLogicalId(value.request.operationId, "pending macro operationId");
    const baseRevision = requireSafeInteger(
      value.request.baseRevision,
      0,
      Number.MAX_SAFE_INTEGER,
      "pending macro baseRevision",
    );
    const simulationMilliseconds = requireSafeInteger(
      value.request.simulationMilliseconds,
      1,
      MAX_MACRO_BUDGET_MILLISECONDS,
      "pending macro simulation budget",
    );
    const wallMilliseconds = requireSafeInteger(
      value.request.wallMilliseconds,
      1,
      MAX_MACRO_BUDGET_MILLISECONDS,
      "pending macro wall budget",
    );
    if (baseRevision !== snapshot.revision ||
        macroSession && macroSession.macroSessionId !== macroSessionId) {
      throw stateError(
        "native player-authority pending macro advance is stale",
        "NATIVE_PLAYER_AUTHORITY_STATE_STALE",
      );
    }
    return { kind: "advance", macroSessionId, baseRevision, simulationMilliseconds, wallMilliseconds };
  }
  if (!hasExactKeys(value, ["kind", "macroSessionId"]) || !macroSession ||
      requireLogicalId(value.macroSessionId, "pending macro finish sessionId") !== macroSession.macroSessionId) {
    throw stateError("native player-authority pending macro finish is invalid");
  }
  return { kind: "finish", macroSessionId: value.macroSessionId };
}

function deriveMacroDetails(runtime, snapshot) {
  const context = runtime.context;
  if (!isRecord(context) || context.sessionId !== snapshot.sessionId || context.runId !== snapshot.runId ||
      context.revision !== snapshot.revision || context.nextSequence - 1 !== snapshot.acknowledgedSequence ||
      context.nextSequence !== snapshot.nextSequence || context.nextDeadlineMs !== snapshot.nextDeadlineMs) {
    throw stateError(
      "native player-authority internal context is stale",
      "NATIVE_PLAYER_AUTHORITY_STATE_STALE",
    );
  }
  const allowMissingSession = ["macro-committing", "macro-uncertain"].includes(snapshot.phase);
  const macroSession = normalizeInternalMacroSession(context.macroSession, snapshot, allowMissingSession);
  const pending = normalizePendingMacroAction(runtime.pendingMacroAction, snapshot, macroSession);

  if (snapshot.phase === "macro-active" && (pending !== null || !macroSession) ||
      snapshot.phase === "macro-committing" && pending?.kind !== "advance" ||
      snapshot.phase === "macro-finishing" && pending?.kind !== "finish" ||
      snapshot.phase === "macro-uncertain" && pending === null ||
      ["faulted", "shutdown"].includes(snapshot.phase) && !pending && !macroSession) {
    throw stateError("native player-authority macro lifecycle is inconsistent");
  }

  const budget = pending?.kind === "advance" ? pending : macroSession;
  if (!budget) throw stateError("native player-authority macro budget is unavailable");
  const uncertainAdvance = snapshot.phase === "macro-uncertain" && pending?.kind === "advance";
  const committingAdvance = snapshot.phase === "macro-committing";
  const simulationProgressMilliseconds = uncertainAdvance
    ? null
    : committingAdvance ? 0 : budget.simulationMilliseconds;
  const wallProgressMilliseconds = uncertainAdvance
    ? null
    : committingAdvance ? 0 : budget.wallMilliseconds;
  let pausedReason;
  if (snapshot.phase === "macro-active") pausedReason = "macro-window-active";
  else if (snapshot.phase === "macro-committing") pausedReason = "macro-advance-committing";
  else if (snapshot.phase === "macro-finishing") pausedReason = "macro-finish-committing";
  else if (snapshot.phase === "macro-uncertain") {
    pausedReason = pending.kind === "finish" ? "macro-finish-uncertain" : "macro-advance-uncertain";
  } else pausedReason = snapshot.phase === "shutdown" ? "macro-runtime-shutdown" : "macro-runtime-faulted";
  return Object.freeze({
    revision: snapshot.revision,
    simulationBudgetMilliseconds: budget.simulationMilliseconds,
    wallBudgetMilliseconds: budget.wallMilliseconds,
    simulationProgressMilliseconds,
    wallProgressMilliseconds,
    operationKind: pending?.kind ?? "active",
    pausedReason,
  });
}

class NativePlayerAuthorityStateBroker {
  constructor(options) {
    if (!isRecord(options) || !options.runtime || typeof options.runtime.snapshot !== "function" ||
        typeof options.isTrustedRendererOwner !== "function" ||
        options.getMacroRecoveryHint !== undefined &&
          typeof options.getMacroRecoveryHint !== "function") {
      throw new TypeError("native player-authority state broker options are invalid");
    }
    this.runtime = options.runtime;
    this.isTrustedRendererOwner = options.isTrustedRendererOwner;
    this.getMacroRecoveryHint = options.getMacroRecoveryHint ?? (() => null);
    this.lastAuthorityIdentity = null;
    this.lastAuthorityRevision = null;
  }

  read(rendererOwnerId) {
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw stateError(
        "native player-authority state caller is not the trusted renderer",
        "NATIVE_PLAYER_AUTHORITY_STATE_RENDERER_UNTRUSTED",
      );
    }
    const snapshot = this.runtime.snapshot();
    const common = normalizeCommonState(snapshot);
    const hasMacroInternals = MACRO_PHASES.has(common.phase) ||
      (["faulted", "shutdown"].includes(common.phase) &&
        ((Object.hasOwn(snapshot, "macroSessionId") && snapshot.macroSessionId !== null) ||
          (this.runtime.pendingMacroAction !== undefined && this.runtime.pendingMacroAction !== null)));
    if (!hasMacroInternals) {
      const normalized = normalizeNativePlayerAuthorityState(
        snapshot,
        undefined,
        this.getMacroRecoveryHint(),
      );
      if (common.hasCompleteIdentity) {
        const identity = `${common.sessionId}\0${common.runId}`;
        if (this.lastAuthorityIdentity !== null && this.lastAuthorityIdentity !== identity) {
          throw stateError(
            "native player-authority identity changed without a lifecycle boundary",
            "NATIVE_PLAYER_AUTHORITY_STATE_STALE",
          );
        }
        if (this.lastAuthorityIdentity === identity && this.lastAuthorityRevision !== null &&
            common.revision < this.lastAuthorityRevision) {
          throw stateError(
            "native player-authority revision regressed",
            "NATIVE_PLAYER_AUTHORITY_STATE_STALE",
          );
        }
        this.lastAuthorityIdentity = identity;
        this.lastAuthorityRevision = common.revision;
      } else if (common.hasNoIdentity) {
        this.lastAuthorityIdentity = null;
        this.lastAuthorityRevision = null;
      }
      return normalized;
    }

    const identity = `${common.sessionId}\0${common.runId}`;
    if (this.lastAuthorityIdentity !== null && this.lastAuthorityIdentity !== identity) {
      throw stateError(
        "native player-authority macro identity changed without a lifecycle boundary",
        "NATIVE_PLAYER_AUTHORITY_STATE_STALE",
      );
    }
    if (this.lastAuthorityIdentity === identity && this.lastAuthorityRevision !== null &&
        common.revision < this.lastAuthorityRevision) {
      throw stateError(
        "native player-authority macro revision regressed",
        "NATIVE_PLAYER_AUTHORITY_STATE_STALE",
      );
    }
    const normalized = normalizeNativePlayerAuthorityState(
      snapshot,
      deriveMacroDetails(this.runtime, snapshot),
    );
    this.lastAuthorityIdentity = identity;
    this.lastAuthorityRevision = common.revision;
    return normalized;
  }
}

module.exports = {
  MAX_MACRO_BUDGET_MILLISECONDS,
  NativePlayerAuthorityStateBroker,
  NativePlayerAuthorityStateBrokerError,
  normalizeNativePlayerAuthorityState,
};
