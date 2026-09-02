"use strict";

/*
 * Main-process-only mutation broker for a player-authoritative Rust session.
 *
 * The renderer may submit the same bounded SimulationCommandPatch shape that
 * it used while the session was a shadow, but it never receives the main
 * owner ID or access to the raw authority lease. The broker binds the caller,
 * session, base revision and deterministic command ID to the active runtime;
 * the runtime then owns FIFO ordering and the durable stage/WAL/checkpoint/ACK
 * transaction. A lost IPC response is reconciled through a main-owned,
 * read-only receipt lookup; the renderer never resends the mutation.
 */

const { createHash } = require("node:crypto");

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const COMMAND_KEYS = Object.freeze([
  "protocolVersion", "baseRevision", "topLevelChanges", "changedEntities", "addedEntities",
  "removedEntityIds", "changedBelts", "addedBelts", "removedBeltIds",
]);
const MAX_DURABLE_COMMAND_BYTES = 1_750_000;
const MAX_RECONCILIATION_RECEIPTS = 64;

class NativePlayerAuthorityCommandBrokerError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "NativePlayerAuthorityCommandBrokerError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function brokerError(message, code, cause) {
  return new NativePlayerAuthorityCommandBrokerError(message, code, cause);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validLogicalId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    LOGICAL_ID_PATTERN.test(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Reflect.ownKeys(value).every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function normalizeRequest(value) {
  if (!exactKeys(value, ["sessionId", "command"]) || !validLogicalId(value.sessionId) ||
      !exactKeys(value.command, COMMAND_KEYS) || value.command.protocolVersion !== 1 ||
      !Number.isSafeInteger(value.command.baseRevision) || value.command.baseRevision < 0 ||
      COMMAND_KEYS.slice(2).some((key) => !Array.isArray(value.command[key]))) {
    throw brokerError(
      "native player-authority command request is invalid",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_REQUEST_INVALID",
    );
  }
  if (value.command.topLevelChanges.some((change) =>
    isRecord(change) && Array.isArray(change.path) && change.path[0] === "paused")) {
    throw brokerError(
      "native player-authority pause requires the dedicated durable lifecycle",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_REQUEST_INVALID",
    );
  }
  let encoded;
  try {
    encoded = JSON.stringify(value.command);
  } catch (cause) {
    throw brokerError(
      "native player-authority command is not JSON serializable",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_REQUEST_INVALID",
      cause,
    );
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_DURABLE_COMMAND_BYTES) {
    throw brokerError(
      "native player-authority command exceeds its durable payload limit",
      "NATIVE_PLAYER_AUTHORITY_COMMAND_REQUEST_TOO_LARGE",
    );
  }
  const command = JSON.parse(encoded);
  const digest = createHash("sha256").update(encoded, "utf8").digest("hex");
  return Object.freeze({
    sessionId: value.sessionId,
    baseRevision: command.baseRevision,
    commandId: `renderer-${command.baseRevision}-${digest.slice(0, 40)}`,
    command,
  });
}

function assertBoundSnapshot(snapshot, request, label) {
  if (!isRecord(snapshot) || snapshot.sessionId !== request.sessionId ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw brokerError(
      `native player-authority ${label} is not bound to the active session`,
      "NATIVE_PLAYER_AUTHORITY_COMMAND_UNAVAILABLE",
    );
  }
}

function assertActiveSnapshot(snapshot, request, label) {
  assertBoundSnapshot(snapshot, request, label);
  if (snapshot.phase !== "active") {
    throw brokerError(
      `native player-authority ${label} is not active`,
      "NATIVE_PLAYER_AUTHORITY_COMMAND_UNAVAILABLE",
    );
  }
}

function normalizeStableChangeIds(value, label) {
  if (!Array.isArray(value) || value.length > 65_536) {
    throw brokerError(label, "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID");
  }
  const ids = value.map((id) => {
    if (typeof id !== "string" || id.length < 1 || id.includes("\0") ||
        Buffer.byteLength(id, "utf8") > 512) {
      throw brokerError(label, "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID");
    }
    for (let index = 0; index < id.length; index += 1) {
      const unit = id.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = id.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw brokerError(label, "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID");
        }
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw brokerError(label, "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID");
      }
    }
    return id;
  });
  for (let index = 1; index < ids.length; index += 1) {
    if (Buffer.compare(Buffer.from(ids[index - 1], "utf8"), Buffer.from(ids[index], "utf8")) >= 0) {
      throw brokerError(label, "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID");
    }
  }
  return Object.freeze(ids);
}

class NativePlayerAuthorityCommandBroker {
  constructor(options) {
    if (!isRecord(options) || !options.runtime || typeof options.runtime.snapshot !== "function" ||
        typeof options.runtime.commitCommand !== "function" ||
        typeof options.isTrustedRendererOwner !== "function" ||
        options.onCommittedCommand !== undefined && typeof options.onCommittedCommand !== "function") {
      throw new TypeError("native player-authority command broker options are invalid");
    }
    this.runtime = options.runtime;
    this.isTrustedRendererOwner = options.isTrustedRendererOwner;
    this.onCommittedCommand = options.onCommittedCommand ?? (() => undefined);
    this.pendingReconciliationKeys = new Set();
    this.reconciliationReceipts = new Map();
  }

  ownsSession(sessionId) {
    if (!validLogicalId(sessionId)) return false;
    try {
      return this.runtime.snapshot()?.sessionId === sessionId;
    } catch {
      return false;
    }
  }

  async historyStatus(rendererOwnerId, rawRequest) {
    if (!this.isTrustedRendererOwner(rendererOwnerId) ||
        !exactKeys(rawRequest, ["sessionId"]) || !validLogicalId(rawRequest.sessionId) ||
        !this.ownsSession(rawRequest.sessionId) || typeof this.runtime.historyStatus !== "function") {
      throw brokerError(
        "native player-authority history is unavailable",
        "NATIVE_PLAYER_AUTHORITY_HISTORY_UNAVAILABLE",
      );
    }
    return this.runtime.historyStatus();
  }

  async commitHistory(rendererOwnerId, rawRequest) {
    if (!this.isTrustedRendererOwner(rendererOwnerId) ||
        !exactKeys(rawRequest, ["sessionId", "operationId", "baseRevision", "direction"]) ||
        !validLogicalId(rawRequest.sessionId) || !validLogicalId(rawRequest.operationId) ||
        !Number.isSafeInteger(rawRequest.baseRevision) || rawRequest.baseRevision < 0 ||
        (rawRequest.direction !== "undo" && rawRequest.direction !== "redo") ||
        !this.ownsSession(rawRequest.sessionId) || typeof this.runtime.commitHistory !== "function") {
      throw brokerError(
        "native player-authority history request is invalid",
        "NATIVE_PLAYER_AUTHORITY_HISTORY_REQUEST_INVALID",
      );
    }
    const receipt = await this.runtime.commitHistory({
      operationId: rawRequest.operationId,
      baseRevision: rawRequest.baseRevision,
      direction: rawRequest.direction,
    });
    if (receipt.previousRevision !== rawRequest.baseRevision ||
        receipt.revision !== rawRequest.baseRevision + 1 ||
        !Array.isArray(receipt.changedEntityIds) || !Array.isArray(receipt.changedBeltIds) ||
        typeof receipt.topologyDirty !== "boolean" || !isRecord(receipt.history)) {
      throw brokerError(
        "native player-authority history receipt is invalid",
        "NATIVE_PLAYER_AUTHORITY_HISTORY_RECEIPT_INVALID",
      );
    }
    return receipt;
  }

  async commit(rendererOwnerId, rawRequest) {
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw brokerError(
        "native player-authority command caller is not the trusted renderer",
        "NATIVE_PLAYER_AUTHORITY_COMMAND_RENDERER_UNTRUSTED",
      );
    }
    const request = normalizeRequest(rawRequest);
    const before = this.runtime.snapshot();
    assertActiveSnapshot(before, request, "runtime");
    if (request.baseRevision + 1 < before.revision) {
      throw brokerError(
        "native player-authority command revision is stale",
        "NATIVE_PLAYER_AUTHORITY_COMMAND_REVISION_MISMATCH",
      );
    }
    const reconciliationKey = `${request.sessionId}\0${request.commandId}`;
    this.pendingReconciliationKeys.add(reconciliationKey);
    try {
      return await this.commitNormalized(rendererOwnerId, request);
    } finally {
      this.pendingReconciliationKeys.delete(reconciliationKey);
    }
  }

  async commitNormalized(rendererOwnerId, request) {
    const result = await this.runtime.commitCommand({
      commandId: request.commandId,
      baseRevision: request.baseRevision,
      command: request.command,
    });
    assertActiveSnapshot(result, request, "receipt");
    if (result.previousRevision !== request.baseRevision ||
        result.revision !== request.baseRevision + 1 || result.inFlight !== false ||
        typeof result.topologyDirty !== "boolean") {
      throw brokerError(
        "native player-authority command receipt is not a settled contiguous revision",
        "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
      );
    }
    const changedEntityIds = normalizeStableChangeIds(
      result.changedEntityIds,
      "native player-authority entity receipt is invalid",
    );
    const changedBeltIds = normalizeStableChangeIds(
      result.changedBeltIds,
      "native player-authority belt receipt is invalid",
    );
    if (changedEntityIds.length + changedBeltIds.length > 65_536) {
      throw brokerError(
        "native player-authority change receipt exceeds its ID budget",
        "NATIVE_PLAYER_AUTHORITY_COMMAND_RECEIPT_INVALID",
      );
    }
    const rendererReceipt = Object.freeze({
      previousRevision: request.baseRevision,
      revision: result.revision,
      changedEntityIds,
      changedBeltIds,
      topologyDirty: result.topologyDirty,
    });
    const reconciliationKey = `${request.sessionId}\0${request.commandId}`;
    this.reconciliationReceipts.delete(reconciliationKey);
    this.reconciliationReceipts.set(reconciliationKey, rendererReceipt);
    while (this.reconciliationReceipts.size > MAX_RECONCILIATION_RECEIPTS) {
      this.reconciliationReceipts.delete(this.reconciliationReceipts.keys().next().value);
    }
    try {
      this.onCommittedCommand(Object.freeze({
        sessionId: request.sessionId,
        baseRevision: request.baseRevision,
        revision: result.revision,
        command: request.command,
      }));
    } catch {
      // The gameplay command is already durable. Optional main-owned observers
      // may lose diagnostics, but must never turn a committed command into an
      // uncertain renderer outcome.
    }
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw brokerError(
        "native player-authority command renderer disappeared before delivery",
        "NATIVE_PLAYER_AUTHORITY_COMMAND_RENDERER_UNTRUSTED",
      );
    }
    return rendererReceipt;
  }

  /**
   * Read-only reconciliation for a renderer response that was lost after
   * dispatch. The exact command is normalized only to derive the main-owned
   * durable ID; this path never calls commitCommand and therefore cannot
   * execute or retry gameplay state.
   */
  reconcile(rendererOwnerId, rawRequest) {
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw brokerError(
        "native player-authority command reconciliation caller is not trusted",
        "NATIVE_PLAYER_AUTHORITY_COMMAND_RENDERER_UNTRUSTED",
      );
    }
    const request = normalizeRequest(rawRequest);
    const current = this.runtime.snapshot();
    assertBoundSnapshot(current, request, "reconciliation runtime");
    const reconciliationKey = `${request.sessionId}\0${request.commandId}`;
    const receipt = this.reconciliationReceipts.get(reconciliationKey);
    if (receipt) {
      return Object.freeze({ status: "committed", receipt });
    }
    if (this.pendingReconciliationKeys.has(reconciliationKey)) {
      return Object.freeze({
        status: "pending",
        baseRevision: request.baseRevision,
        currentRevision: current.revision,
      });
    }
    if (current.phase !== "active" || current.inFlight || (current.queuedCommands ?? 0) > 0) {
      return Object.freeze({
        status: "pending",
        baseRevision: request.baseRevision,
        currentRevision: current.revision,
      });
    }
    if (!current.inFlight && (current.queuedCommands ?? 0) === 0 &&
        current.revision === request.baseRevision) {
      return Object.freeze({
        status: "not-committed",
        baseRevision: request.baseRevision,
        currentRevision: current.revision,
      });
    }
    return Object.freeze({
      status: "conflict",
      baseRevision: request.baseRevision,
      currentRevision: current.revision,
    });
  }
}

module.exports = {
  NativePlayerAuthorityCommandBroker,
  NativePlayerAuthorityCommandBrokerError,
};
