"use strict";

/*
 * Main-process-only control surface for productive PureIdleMacroV10 windows.
 *
 * Callers provide only the revision and effective multiplier they observed at
 * start, then parameter-free continue/finish intents. Wall time, simulation
 * budgets, session, lease, run and operation identities never cross the
 * renderer boundary: this broker samples the main-owned monotonic clock,
 * derives one bounded budget from the durable lease deadline, and creates
 * non-reusable macro/operation IDs inside Electron's main process.
 * The runtime remains the only lifecycle state machine and the Rust Host
 * remains the only durable stage/WAL/checkpoint/ACK authority.
 */

const { randomUUID } = require("node:crypto");

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_MACRO_BUDGET_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const MAX_IDENTITY_SEQUENCE = Number.MAX_SAFE_INTEGER;

class NativePlayerAuthorityMacroBrokerError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "NativePlayerAuthorityMacroBrokerError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function brokerError(message, code, cause) {
  return new NativePlayerAuthorityMacroBrokerError(message, code, cause);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Reflect.ownKeys(value).every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function validLogicalId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    LOGICAL_ID_PATTERN.test(value);
}

function isPersistenceBoundaryBusy(error) {
  return error?.code === "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY";
}

function normalizeEffectiveMultiplier(value) {
  if (!Number.isSafeInteger(value) || value < 2 || value > MAX_MACRO_BUDGET_MILLISECONDS) {
    throw brokerError(
      "native player-authority macro multiplier is invalid",
      "NATIVE_PLAYER_AUTHORITY_MACRO_REQUEST_INVALID",
    );
  }
  return value;
}

function normalizeStartRequest(value) {
  if (!exactKeys(value, ["expectedRevision", "effectiveMultiplier"]) ||
      !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw brokerError(
      "native player-authority macro start request is invalid",
      "NATIVE_PLAYER_AUTHORITY_MACRO_REQUEST_INVALID",
    );
  }
  return Object.freeze({
    expectedRevision: value.expectedRevision,
    effectiveMultiplier: normalizeEffectiveMultiplier(value.effectiveMultiplier),
  });
}

function settledThroughMilliseconds(snapshot) {
  if (!Number.isSafeInteger(snapshot?.nextDeadlineMs) || snapshot.nextDeadlineMs < 1_000) {
    throw brokerError(
      "native player-authority macro durable deadline is invalid",
      "NATIVE_PLAYER_AUTHORITY_MACRO_UNAVAILABLE",
    );
  }
  return snapshot.nextDeadlineMs - 1_000;
}

function deriveMainOwnedBudget(snapshot, effectiveMultiplier, now) {
  const settledThroughMs = settledThroughMilliseconds(snapshot);
  let sampledAtMs;
  try {
    sampledAtMs = now();
  } catch (cause) {
    throw brokerError(
      "native player-authority macro main clock failed",
      "NATIVE_PLAYER_AUTHORITY_MACRO_CLOCK_INVALID",
      cause,
    );
  }
  if (!Number.isSafeInteger(sampledAtMs) || sampledAtMs < 0) {
    throw brokerError(
      "native player-authority macro main clock is invalid",
      "NATIVE_PLAYER_AUTHORITY_MACRO_CLOCK_INVALID",
    );
  }
  const availableWallMilliseconds = sampledAtMs - settledThroughMs;
  const maximumWallMilliseconds = Math.floor(
    MAX_MACRO_BUDGET_MILLISECONDS / effectiveMultiplier,
  );
  if (availableWallMilliseconds < 1 || maximumWallMilliseconds < 1) {
    throw brokerError(
      "native player-authority macro has no main-confirmed wall time to settle",
      "NATIVE_PLAYER_AUTHORITY_MACRO_BUSY",
    );
  }
  const wallMilliseconds = Math.min(availableWallMilliseconds, maximumWallMilliseconds);
  const simulationMilliseconds = wallMilliseconds * effectiveMultiplier;
  if (!Number.isSafeInteger(simulationMilliseconds) || simulationMilliseconds < 1 ||
      simulationMilliseconds > MAX_MACRO_BUDGET_MILLISECONDS) {
    throw brokerError(
      "native player-authority macro main-owned budget is invalid",
      "NATIVE_PLAYER_AUTHORITY_MACRO_CLOCK_INVALID",
    );
  }
  return Object.freeze({ simulationMilliseconds, wallMilliseconds });
}

function requireNoRequest(value, label) {
  if (value !== undefined && !exactKeys(value, [])) {
    throw brokerError(
      `native player-authority macro ${label} request is invalid`,
      "NATIVE_PLAYER_AUTHORITY_MACRO_REQUEST_INVALID",
    );
  }
}

function requireAuthorityIdentity(snapshot, phases, label) {
  if (!isRecord(snapshot) || !phases.includes(snapshot.phase) ||
      !validLogicalId(snapshot.sessionId) || !validLogicalId(snapshot.runId) ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw brokerError(
      `native player-authority macro ${label} is not settled`,
      "NATIVE_PLAYER_AUTHORITY_MACRO_UNAVAILABLE",
    );
  }
  // A tick or durable player command may enter the main-owned gate after the
  // renderer observed its last settled frame but before this request reaches
  // main. That is a definite, retryable no-op: no macro identity has been
  // issued and no Host call has occurred. Publish the existing BUSY code so
  // the renderer preserves and rebases the exact start intent.
  if (snapshot.inFlight !== false || snapshot.currentOperation !== null ||
      snapshot.queuedCommands !== 0) {
    throw brokerError(
      `native player-authority macro ${label} is temporarily busy`,
      "NATIVE_PLAYER_AUTHORITY_MACRO_BUSY",
    );
  }
  return Object.freeze({
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    revision: snapshot.revision,
  });
}

function requireFinishedLineage(snapshot, expected, label, allowRevisionAdvance) {
  if (!isRecord(snapshot) || !["active", "uncertain"].includes(snapshot.phase) ||
      !validLogicalId(snapshot.sessionId) || !validLogicalId(snapshot.runId) ||
      snapshot.sessionId !== expected.sessionId || snapshot.runId !== expected.runId ||
      !Number.isSafeInteger(snapshot.revision) ||
      (allowRevisionAdvance ? snapshot.revision < expected.revision : snapshot.revision !== expected.revision) ||
      snapshot.macroSessionId !== null || snapshot.macroAlgorithmVersion !== null) {
    throw brokerError(
      `native player-authority macro ${label} lineage is stale`,
      "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID",
    );
  }
  return Object.freeze({
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    revision: snapshot.revision,
  });
}

function sanitizedActiveReceipt(snapshot, expected, budgets, recovered) {
  const identity = requireAuthorityIdentity(snapshot, ["macro-active"], "receipt");
  if (identity.sessionId !== expected.sessionId || identity.runId !== expected.runId ||
      identity.revision <= expected.revision ||
      snapshot.macroSessionId !== expected.macroSessionId ||
      !validLogicalId(snapshot.macroAlgorithmVersion)) {
    throw brokerError(
      "native player-authority macro receipt does not match the main-owned operation",
      "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    state: "macro-active",
    previousRevision: expected.revision,
    revision: identity.revision,
    simulationMilliseconds: budgets.simulationMilliseconds,
    wallMilliseconds: budgets.wallMilliseconds,
    algorithmVersion: snapshot.macroAlgorithmVersion,
    recovered,
  });
}

class NativePlayerAuthorityMacroBroker {
  constructor(options) {
    if (!isRecord(options) || !options.runtime || typeof options.runtime.snapshot !== "function" ||
        typeof options.runtime.commitMacroAdvance !== "function" ||
        typeof options.runtime.finishMacroSession !== "function" ||
        typeof options.runtime.retryUncertain !== "function" ||
        options.createId !== undefined && typeof options.createId !== "function" ||
        options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("native player-authority macro broker options are invalid");
    }
    const hasCleanupSession = options.pendingMacroCleanupSessionId !== undefined;
    const hasCleanupRevision = options.pendingMacroCleanupRevision !== undefined;
    if (hasCleanupSession !== hasCleanupRevision || hasCleanupSession &&
        (!validLogicalId(options.pendingMacroCleanupSessionId) ||
          !Number.isSafeInteger(options.pendingMacroCleanupRevision) ||
          options.pendingMacroCleanupRevision < 0)) {
      throw new TypeError("native player-authority pending macro cleanup is invalid");
    }
    if (options.recoveredOperationId !== undefined &&
        !validLogicalId(options.recoveredOperationId)) {
      throw new TypeError("native player-authority recovered macro operation ID is invalid");
    }
    const hasRecoveredSimulationBudget = options.recoveredSimulationMilliseconds !== undefined;
    const hasRecoveredWallBudget = options.recoveredWallMilliseconds !== undefined;
    if (hasRecoveredSimulationBudget !== hasRecoveredWallBudget) {
      throw new TypeError("native player-authority recovered macro budget is partial");
    }
    this.runtime = options.runtime;
    this.createId = options.createId ?? (() => randomUUID());
    this.now = options.now ?? Date.now;
    // One random process-local epoch plus a monotonic safe-integer sequence
    // makes every generated identity unique without retaining one string per
    // one-second macro advance. Only identities recovered from the durable
    // lease need a bounded collision set because their epoch was created by a
    // previous main-process lifetime.
    this.identityEpoch = null;
    this.nextIdentitySequence = 0;
    this.startupReservedIds = new Set();
    this.pending = null;
    this.inFlight = false;
    this.lastRecovered = null;
    const snapshot = this.runtime.snapshot();
    this.activeMacroSessionId = null;
    this.activeMultiplier = null;
    if (snapshot?.phase === "macro-active") {
      requireAuthorityIdentity(snapshot, ["macro-active"], "startup recovery");
      if (!validLogicalId(snapshot.macroSessionId) || !validLogicalId(snapshot.macroAlgorithmVersion)) {
        throw new TypeError("native player-authority recovered macro session is invalid");
      }
      this.activeMacroSessionId = snapshot.macroSessionId;
      if (!hasRecoveredSimulationBudget || !hasRecoveredWallBudget ||
          !Number.isSafeInteger(options.recoveredSimulationMilliseconds) ||
          !Number.isSafeInteger(options.recoveredWallMilliseconds) ||
          options.recoveredWallMilliseconds < 1 ||
          options.recoveredSimulationMilliseconds < 1 ||
          options.recoveredSimulationMilliseconds % options.recoveredWallMilliseconds !== 0) {
        throw new TypeError("native player-authority recovered macro budget is invalid");
      }
      this.activeMultiplier = normalizeEffectiveMultiplier(
        options.recoveredSimulationMilliseconds / options.recoveredWallMilliseconds,
      );
    } else if (options.recoveredOperationId !== undefined) {
      throw new TypeError("native player-authority recovered macro operation has no active session");
    } else if (hasRecoveredSimulationBudget) {
      throw new TypeError("native player-authority recovered macro budget has no active session");
    }
    if (this.activeMacroSessionId) this.startupReservedIds.add(this.activeMacroSessionId);
    if (options.recoveredOperationId !== undefined) {
      if (this.startupReservedIds.has(options.recoveredOperationId)) {
        throw new TypeError("native player-authority recovered macro identity was reused");
      }
      this.startupReservedIds.add(options.recoveredOperationId);
    }
    if (hasCleanupSession) {
      const identity = requireAuthorityIdentity(snapshot, ["active"], "startup cleanup");
      if (snapshot.macroSessionId !== null || snapshot.macroAlgorithmVersion !== null ||
          options.pendingMacroCleanupRevision > identity.revision ||
          this.activeMacroSessionId !== null ||
          this.startupReservedIds.has(options.pendingMacroCleanupSessionId)) {
        throw new TypeError("native player-authority pending macro cleanup lineage is invalid");
      }
      this.startupReservedIds.add(options.pendingMacroCleanupSessionId);
      this.lastRecovered = Object.freeze({
        receipt: Object.freeze({
          schemaVersion: 1,
          state: "finished",
          revision: options.pendingMacroCleanupRevision,
          recovered: true,
        }),
        sessionId: identity.sessionId,
        runId: identity.runId,
        macroSessionId: options.pendingMacroCleanupSessionId,
        algorithmVersion: null,
      });
    }
  }

  issueId(kind) {
    if (this.identityEpoch === null) {
      let raw;
      try {
        raw = this.createId("macro-epoch");
      } catch (cause) {
        throw brokerError(
          "native player-authority macro identity generation failed",
          "NATIVE_PLAYER_AUTHORITY_MACRO_ID_INVALID",
          cause,
        );
      }
      // Validate against the longest generated form once, before publishing
      // any session/operation identity from this epoch.
      const longest = `native-macro-operation-${raw}-${MAX_IDENTITY_SEQUENCE.toString(36)}`;
      if (!validLogicalId(raw) || !validLogicalId(longest)) {
        throw brokerError(
          "native player-authority macro identity is invalid",
          "NATIVE_PLAYER_AUTHORITY_MACRO_ID_INVALID",
        );
      }
      this.identityEpoch = raw;
    }
    while (this.nextIdentitySequence < MAX_IDENTITY_SEQUENCE) {
      this.nextIdentitySequence += 1;
      const id = `native-${kind}-${this.identityEpoch}-${this.nextIdentitySequence.toString(36)}`;
      if (this.startupReservedIds.has(id)) continue;
      return id;
    }
    throw brokerError(
      "native player-authority macro identity budget is exhausted",
      "NATIVE_PLAYER_AUTHORITY_MACRO_ID_EXHAUSTED",
    );
  }

  assertAvailable() {
    if (this.inFlight) {
      throw brokerError(
        "native player-authority macro operation is already in flight",
        "NATIVE_PLAYER_AUTHORITY_MACRO_BUSY",
      );
    }
  }

  async start(rawRequest) {
    this.assertAvailable();
    const request = normalizeStartRequest(rawRequest);
    const before = this.runtime.snapshot();
    const identity = requireAuthorityIdentity(before, ["active"], "start");
    if (identity.revision !== request.expectedRevision) {
      throw brokerError(
        "native player-authority macro start revision must be rebased",
        "NATIVE_PLAYER_AUTHORITY_MACRO_START_REBASE_REQUIRED",
      );
    }
    if (before.macroSessionId !== null || this.activeMacroSessionId !== null || this.pending !== null) {
      throw brokerError(
        "native player-authority macro session is already active",
        "NATIVE_PLAYER_AUTHORITY_MACRO_SESSION_CONFLICT",
      );
    }
    const budgets = deriveMainOwnedBudget(before, request.effectiveMultiplier, this.now);
    const macroSessionId = this.issueId("macro-session");
    const operationId = this.issueId("macro-operation");
    return this.commitAdvance(
      identity,
      macroSessionId,
      operationId,
      budgets,
      request.effectiveMultiplier,
    );
  }

  async advance(rawRequest) {
    this.assertAvailable();
    requireNoRequest(rawRequest, "advance");
    const before = this.runtime.snapshot();
    const identity = requireAuthorityIdentity(before, ["macro-active"], "advance");
    if (!this.activeMacroSessionId || before.macroSessionId !== this.activeMacroSessionId ||
        !validLogicalId(before.macroAlgorithmVersion) || this.pending !== null ||
        !Number.isSafeInteger(this.activeMultiplier)) {
      throw brokerError(
        "native player-authority macro session identity is stale",
        "NATIVE_PLAYER_AUTHORITY_MACRO_SESSION_CONFLICT",
      );
    }
    const budgets = deriveMainOwnedBudget(before, this.activeMultiplier, this.now);
    const operationId = this.issueId("macro-operation");
    return this.commitAdvance(
      identity,
      this.activeMacroSessionId,
      operationId,
      budgets,
      this.activeMultiplier,
    );
  }

  async commitAdvance(identity, macroSessionId, operationId, budgets, effectiveMultiplier) {
    this.pending = Object.freeze({
      kind: "advance",
      identity,
      macroSessionId,
      operationId,
      budgets,
      effectiveMultiplier,
    });
    this.inFlight = true;
    try {
      await this.runtime.commitMacroAdvance({
        macroSessionId,
        operationId,
        baseRevision: identity.revision,
        simulationMilliseconds: budgets.simulationMilliseconds,
        wallMilliseconds: budgets.wallMilliseconds,
      });
      const receipt = sanitizedActiveReceipt(
        this.runtime.snapshot(),
        { ...identity, macroSessionId },
        budgets,
        false,
      );
      this.activeMacroSessionId = macroSessionId;
      this.activeMultiplier = effectiveMultiplier;
      this.pending = null;
      this.lastRecovered = null;
      return receipt;
    } catch (cause) {
      // The runtime reports this code only before it stages or calls the Host.
      // This is a definite no-op, not an uncertain durable outcome, so release
      // the broker-side operation and let the caller retry after persistence.
      if (isPersistenceBoundaryBusy(cause)) {
        this.pending = null;
        throw brokerError(
          "native player-authority macro advance is blocked by persistence",
          "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
          cause,
        );
      }
      if (cause instanceof NativePlayerAuthorityMacroBrokerError) throw cause;
      throw brokerError(
        "native player-authority macro outcome is uncertain",
        "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
        cause,
      );
    } finally {
      this.inFlight = false;
    }
  }

  async finish(rawRequest) {
    this.assertAvailable();
    requireNoRequest(rawRequest, "finish");
    const before = this.runtime.snapshot();
    const identity = requireAuthorityIdentity(before, ["macro-active"], "finish");
    if (!this.activeMacroSessionId || before.macroSessionId !== this.activeMacroSessionId ||
        this.pending !== null) {
      throw brokerError(
        "native player-authority macro finish session is stale",
        "NATIVE_PLAYER_AUTHORITY_MACRO_SESSION_CONFLICT",
      );
    }
    this.pending = Object.freeze({
      kind: "finish",
      identity,
      macroSessionId: this.activeMacroSessionId,
    });
    this.inFlight = true;
    try {
      const finished = await this.runtime.finishMacroSession({
        macroSessionId: this.activeMacroSessionId,
      });
      requireFinishedLineage(finished, identity, "finish result", false);
      requireFinishedLineage(this.runtime.snapshot(), identity, "finish receipt", true);
      const macroSessionId = this.activeMacroSessionId;
      this.activeMacroSessionId = null;
      this.activeMultiplier = null;
      this.pending = null;
      // Keep an idempotent replay receipt in main until the renderer's durable
      // time-warp-disable command is observed. The first caller still receives
      // the ordinary result; a renderer reload after a lost IPC reply can
      // recover the same terminal result without finishing or advancing twice.
      this.lastRecovered = Object.freeze({
        receipt: Object.freeze({
          schemaVersion: 1,
          state: "finished",
          revision: identity.revision,
          recovered: true,
        }),
        sessionId: identity.sessionId,
        runId: identity.runId,
        macroSessionId,
        algorithmVersion: null,
      });
      return Object.freeze({ schemaVersion: 1, state: "finished", revision: identity.revision });
    } catch (cause) {
      if (isPersistenceBoundaryBusy(cause)) {
        this.pending = null;
        throw brokerError(
          "native player-authority macro finish is blocked by persistence",
          "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
          cause,
        );
      }
      if (cause instanceof NativePlayerAuthorityMacroBrokerError) throw cause;
      throw brokerError(
        "native player-authority macro finish outcome is uncertain",
        "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
        cause,
      );
    } finally {
      this.inFlight = false;
    }
  }

  validatedLastRecovered(before = this.runtime.snapshot(), allowTransientFinished = false) {
    const cached = this.lastRecovered;
    if (!cached || this.pending !== null) return null;
    if (!isRecord(before) || !validLogicalId(before.sessionId) || !validLogicalId(before.runId) ||
        !Number.isSafeInteger(before.revision) || before.revision < 0) {
      this.lastRecovered = null;
      return null;
    }
    if (before.sessionId !== cached.sessionId || before.runId !== cached.runId ||
        before.revision < cached.receipt.revision) {
      this.lastRecovered = null;
      return null;
    }
    if (cached.receipt.state === "macro-active") {
      if (before.phase === "macro-active" && before.inFlight === false &&
          before.currentOperation === null && before.queuedCommands === 0 &&
          before.revision === cached.receipt.revision &&
          this.activeMacroSessionId === cached.macroSessionId &&
          before.macroSessionId === cached.macroSessionId &&
          before.macroAlgorithmVersion === cached.algorithmVersion) return cached;
      // A new operation can temporarily move the same macro lineage away from
      // settled macro-active. Its success path clears this cache; do not erase
      // the prior idempotent receipt merely because a transition is in flight.
      if (this.activeMacroSessionId === cached.macroSessionId &&
          before.macroSessionId === cached.macroSessionId) return null;
      this.lastRecovered = null;
      return null;
    }
    if (this.activeMacroSessionId !== null || before.macroSessionId !== null ||
        before.macroAlgorithmVersion !== null) {
      this.lastRecovered = null;
      return null;
    }
    if (before.phase === "active" && before.inFlight === false &&
        before.currentOperation === null && before.queuedCommands === 0) return cached;
    // Exact tick/command transitions remain in the same authority lineage.
    // Keep the finish hint until the clock is settled instead of deleting it
    // during the active-before-finally publication window.
    if (["active", "uncertain"].includes(before.phase)) {
      return allowTransientFinished ? cached : null;
    }
    this.lastRecovered = null;
    return null;
  }

  recoveryHint() {
    const cached = this.validatedLastRecovered();
    return cached?.receipt.state === "finished"
      ? Object.freeze({ kind: "finished-pending-disable", revision: cached.receipt.revision })
      : null;
  }

  observeCommittedCommand(value) {
    // Receipt validation and durability already happened in the command
    // broker. A following queued tick/command may have entered flight before
    // this observer runs, but the same-lineage immutable cleanup marker must
    // still retire in this process.
    const cached = this.validatedLastRecovered(this.runtime.snapshot(), true);
    if (!cached || cached.receipt.state !== "finished" || !isRecord(value) ||
        value.sessionId !== cached.sessionId || !Number.isSafeInteger(value.baseRevision) ||
        value.baseRevision < cached.receipt.revision ||
        value.revision !== value.baseRevision + 1 || !isRecord(value.command) ||
        !Array.isArray(value.command.topLevelChanges)) return false;
    const disabled = value.command.topLevelChanges.some((change) => {
      if (!isRecord(change) || !Array.isArray(change.path) || change.path.length !== 2 ||
          change.path[0] !== "timeWarp" || change.operation !== "set") return false;
      if (change.path[1] === "enabled") return change.value === false;
      return change.path[1] === "intent" && isRecord(change.value) &&
        typeof change.value.controllerEntityId === "string" &&
        change.value.controllerEntityId.length > 0 && change.value.enabled === false &&
        Object.keys(change.value).length === 2;
    });
    if (!disabled) return false;
    this.lastRecovered = null;
    return true;
  }

  async recover(rawRequest) {
    this.assertAvailable();
    requireNoRequest(rawRequest, "recovery");
    const before = this.runtime.snapshot();
    // A settled hint can race with the next exact tick/command before this IPC
    // reaches main. The immutable terminal receipt remains safe to replay as
    // long as its authority lineage is unchanged and no macro identity has
    // reappeared; only hint publication itself requires a settled clock.
    const cached = this.validatedLastRecovered(before, true);
    if (cached) return cached.receipt;
    if (before?.phase === "macro-active" && this.pending === null &&
        this.activeMacroSessionId === before.macroSessionId) {
      const identity = requireAuthorityIdentity(before, ["macro-active"], "startup recovery");
      if (!validLogicalId(before.macroAlgorithmVersion)) {
        throw brokerError(
          "native player-authority startup macro receipt is invalid",
          "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID",
        );
      }
      return Object.freeze({
        schemaVersion: 1,
        state: "macro-active",
        revision: identity.revision,
        algorithmVersion: before.macroAlgorithmVersion,
        recovered: true,
      });
    }
    if (before?.phase !== "macro-uncertain" || !this.pending) {
      throw brokerError(
        "native player-authority macro has no uncertain operation",
        "NATIVE_PLAYER_AUTHORITY_MACRO_RECOVERY_UNAVAILABLE",
      );
    }
    this.inFlight = true;
    const pending = this.pending;
    try {
      const recovered = await this.runtime.retryUncertain();
      if (pending.kind === "advance") {
        const receipt = sanitizedActiveReceipt(
          this.runtime.snapshot(),
          { ...pending.identity, macroSessionId: pending.macroSessionId },
          pending.budgets,
          true,
        );
        this.activeMacroSessionId = pending.macroSessionId;
        this.activeMultiplier = pending.effectiveMultiplier;
        this.lastRecovered = Object.freeze({
          receipt,
          sessionId: pending.identity.sessionId,
          runId: pending.identity.runId,
          macroSessionId: pending.macroSessionId,
          algorithmVersion: receipt.algorithmVersion,
        });
        this.pending = null;
        return receipt;
      }
      requireFinishedLineage(recovered, pending.identity, "recovered finish result", false);
      requireFinishedLineage(
        this.runtime.snapshot(),
        pending.identity,
        "recovered finish receipt",
        true,
      );
      this.activeMacroSessionId = null;
      this.activeMultiplier = null;
      const receipt = Object.freeze({
        schemaVersion: 1,
        state: "finished",
        revision: pending.identity.revision,
        recovered: true,
      });
      this.lastRecovered = Object.freeze({
        receipt,
        sessionId: pending.identity.sessionId,
        runId: pending.identity.runId,
        macroSessionId: pending.macroSessionId,
        algorithmVersion: null,
      });
      this.pending = null;
      return receipt;
    } catch (cause) {
      if (cause instanceof NativePlayerAuthorityMacroBrokerError) throw cause;
      throw brokerError(
        "native player-authority macro recovery remains uncertain",
        "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
        cause,
      );
    } finally {
      this.inFlight = false;
    }
  }
}

module.exports = {
  MAX_MACRO_BUDGET_MILLISECONDS,
  NativePlayerAuthorityMacroBroker,
  NativePlayerAuthorityMacroBrokerError,
};
