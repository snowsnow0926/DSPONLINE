"use strict";

/*
 * Main-process-only control surface for productive PureIdleMacroV10 windows.
 *
 * Callers provide only two bounded integer millisecond budgets. Session,
 * lease, run and operation identities never cross the renderer boundary:
 * this broker derives the current revision from the authority runtime and
 * creates non-reusable macro/operation IDs inside Electron's main process.
 * The runtime remains the only lifecycle state machine and the Rust Host
 * remains the only durable stage/WAL/checkpoint/ACK authority.
 */

const { randomUUID } = require("node:crypto");

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_MACRO_BUDGET_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ISSUED_IDENTITIES = 65_536;

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

function normalizeBudgetRequest(value) {
  if (!exactKeys(value, ["simulationMilliseconds", "wallMilliseconds"]) ||
      !Number.isSafeInteger(value.simulationMilliseconds) || value.simulationMilliseconds < 1 ||
      value.simulationMilliseconds > MAX_MACRO_BUDGET_MILLISECONDS ||
      !Number.isSafeInteger(value.wallMilliseconds) || value.wallMilliseconds < 1 ||
      value.wallMilliseconds > MAX_MACRO_BUDGET_MILLISECONDS) {
    throw brokerError(
      "native player-authority macro budget is invalid",
      "NATIVE_PLAYER_AUTHORITY_MACRO_REQUEST_INVALID",
    );
  }
  return Object.freeze({
    simulationMilliseconds: value.simulationMilliseconds,
    wallMilliseconds: value.wallMilliseconds,
  });
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
  if (!isRecord(snapshot) || !phases.includes(snapshot.phase) || snapshot.inFlight !== false ||
      snapshot.currentOperation !== null || snapshot.queuedCommands !== 0 ||
      !validLogicalId(snapshot.sessionId) || !validLogicalId(snapshot.runId) ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw brokerError(
      `native player-authority macro ${label} is not settled`,
      "NATIVE_PLAYER_AUTHORITY_MACRO_UNAVAILABLE",
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
        options.createId !== undefined && typeof options.createId !== "function") {
      throw new TypeError("native player-authority macro broker options are invalid");
    }
    if (options.recoveredOperationId !== undefined &&
        !validLogicalId(options.recoveredOperationId)) {
      throw new TypeError("native player-authority recovered macro operation ID is invalid");
    }
    this.runtime = options.runtime;
    this.createId = options.createId ?? (() => randomUUID());
    this.issuedIds = new Set();
    this.pending = null;
    this.inFlight = false;
    const snapshot = this.runtime.snapshot();
    this.activeMacroSessionId = null;
    if (snapshot?.phase === "macro-active") {
      requireAuthorityIdentity(snapshot, ["macro-active"], "startup recovery");
      if (!validLogicalId(snapshot.macroSessionId) || !validLogicalId(snapshot.macroAlgorithmVersion)) {
        throw new TypeError("native player-authority recovered macro session is invalid");
      }
      this.activeMacroSessionId = snapshot.macroSessionId;
    } else if (options.recoveredOperationId !== undefined) {
      throw new TypeError("native player-authority recovered macro operation has no active session");
    }
    if (this.activeMacroSessionId) this.issuedIds.add(this.activeMacroSessionId);
    if (options.recoveredOperationId !== undefined) {
      if (this.issuedIds.has(options.recoveredOperationId)) {
        throw new TypeError("native player-authority recovered macro identity was reused");
      }
      this.issuedIds.add(options.recoveredOperationId);
    }
  }

  issueId(kind) {
    if (this.issuedIds.size >= MAX_ISSUED_IDENTITIES) {
      throw brokerError(
        "native player-authority macro identity budget is exhausted",
        "NATIVE_PLAYER_AUTHORITY_MACRO_ID_EXHAUSTED",
      );
    }
    let raw;
    try {
      raw = this.createId(kind);
    } catch (cause) {
      throw brokerError(
        "native player-authority macro identity generation failed",
        "NATIVE_PLAYER_AUTHORITY_MACRO_ID_INVALID",
        cause,
      );
    }
    const id = `native-${kind}-${raw}`;
    if (!validLogicalId(raw) || !validLogicalId(id)) {
      throw brokerError(
        "native player-authority macro identity is invalid",
        "NATIVE_PLAYER_AUTHORITY_MACRO_ID_INVALID",
      );
    }
    if (this.issuedIds.has(id)) {
      throw brokerError(
        "native player-authority macro identity was reused",
        "NATIVE_PLAYER_AUTHORITY_MACRO_ID_REUSED",
      );
    }
    this.issuedIds.add(id);
    return id;
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
    const budgets = normalizeBudgetRequest(rawRequest);
    const before = this.runtime.snapshot();
    const identity = requireAuthorityIdentity(before, ["active"], "start");
    if (before.macroSessionId !== null || this.activeMacroSessionId !== null || this.pending !== null) {
      throw brokerError(
        "native player-authority macro session is already active",
        "NATIVE_PLAYER_AUTHORITY_MACRO_SESSION_CONFLICT",
      );
    }
    const macroSessionId = this.issueId("macro-session");
    const operationId = this.issueId("macro-operation");
    return this.commitAdvance(identity, macroSessionId, operationId, budgets);
  }

  async advance(rawRequest) {
    this.assertAvailable();
    const budgets = normalizeBudgetRequest(rawRequest);
    const before = this.runtime.snapshot();
    const identity = requireAuthorityIdentity(before, ["macro-active"], "advance");
    if (!this.activeMacroSessionId || before.macroSessionId !== this.activeMacroSessionId ||
        !validLogicalId(before.macroAlgorithmVersion) || this.pending !== null) {
      throw brokerError(
        "native player-authority macro session identity is stale",
        "NATIVE_PLAYER_AUTHORITY_MACRO_SESSION_CONFLICT",
      );
    }
    const operationId = this.issueId("macro-operation");
    return this.commitAdvance(identity, this.activeMacroSessionId, operationId, budgets);
  }

  async commitAdvance(identity, macroSessionId, operationId, budgets) {
    this.pending = Object.freeze({
      kind: "advance",
      identity,
      macroSessionId,
      operationId,
      budgets,
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
      this.pending = null;
      return receipt;
    } catch (cause) {
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
      await this.runtime.finishMacroSession({ macroSessionId: this.activeMacroSessionId });
      const after = this.runtime.snapshot();
      const settled = requireAuthorityIdentity(after, ["active"], "finish receipt");
      if (settled.sessionId !== identity.sessionId || settled.runId !== identity.runId ||
          settled.revision !== identity.revision || after.macroSessionId !== null ||
          after.macroAlgorithmVersion !== null) {
        throw brokerError(
          "native player-authority macro finish receipt is stale",
          "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID",
        );
      }
      this.activeMacroSessionId = null;
      this.pending = null;
      return Object.freeze({ schemaVersion: 1, state: "finished", revision: settled.revision });
    } catch (cause) {
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

  async recover(rawRequest) {
    this.assertAvailable();
    requireNoRequest(rawRequest, "recovery");
    const before = this.runtime.snapshot();
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
    try {
      await this.runtime.retryUncertain();
      if (this.pending.kind === "advance") {
        const receipt = sanitizedActiveReceipt(
          this.runtime.snapshot(),
          { ...this.pending.identity, macroSessionId: this.pending.macroSessionId },
          this.pending.budgets,
          true,
        );
        this.activeMacroSessionId = this.pending.macroSessionId;
        this.pending = null;
        return receipt;
      }
      const after = this.runtime.snapshot();
      const settled = requireAuthorityIdentity(after, ["active"], "recovered finish receipt");
      if (settled.sessionId !== this.pending.identity.sessionId ||
          settled.runId !== this.pending.identity.runId ||
          settled.revision !== this.pending.identity.revision || after.macroSessionId !== null ||
          after.macroAlgorithmVersion !== null) {
        throw brokerError(
          "native player-authority recovered finish receipt is stale",
          "NATIVE_PLAYER_AUTHORITY_MACRO_RECEIPT_INVALID",
        );
      }
      this.activeMacroSessionId = null;
      this.pending = null;
      return Object.freeze({
        schemaVersion: 1,
        state: "finished",
        revision: settled.revision,
        recovered: true,
      });
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
