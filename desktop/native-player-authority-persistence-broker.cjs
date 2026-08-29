"use strict";

/*
 * Main-owned persistence adapter for a Rust player-authority session.
 *
 * The renderer cannot select a session/run/owner. Checkpoint requests reuse
 * the checkpoint already made durable by the last lease ACK; exports run
 * against that same scheduler-frozen revision. Generic normal-main mutation
 * remains fenced for the lifetime of the player-authority lease.
 */

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class NativePlayerAuthorityPersistenceBrokerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "NativePlayerAuthorityPersistenceBrokerError";
    this.code = code;
  }
}

function brokerError(message, code = "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_INVALID") {
  return new NativePlayerAuthorityPersistenceBrokerError(message, code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) =>
    typeof key !== "string" || !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw brokerError(`${label} is invalid`);
  }
}

function validLogicalId(value, maximum = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    LOGICAL_ID_PATTERN.test(value);
}

function validateBoundary(boundary, summary) {
  if (!isRecord(boundary) || !validLogicalId(boundary.sessionId) || !validLogicalId(boundary.runId) ||
      !Number.isSafeInteger(boundary.revision) || boundary.revision < 0 ||
      !isRecord(boundary.checkpoint) || !Number.isSafeInteger(boundary.checkpoint.generation) ||
      boundary.checkpoint.generation < 1 || !SHA256_PATTERN.test(boundary.checkpoint.rootHash) ||
      boundary.checkpoint.revision !== boundary.revision || !isRecord(summary) ||
      summary.revision !== boundary.revision || summary.stateVersion !== 47 ||
      summary.mode !== "normal" || summary.paused !== false ||
      summary.coverage?.authorityEligible !== true) {
    throw brokerError(
      "native player-authority durable boundary is incomplete",
      "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BOUNDARY_INVALID",
    );
  }
}

class NativePlayerAuthorityPersistenceBroker {
  constructor(options) {
    if (!isRecord(options) || !options.runtime ||
        typeof options.runtime.withSettledPersistenceBoundary !== "function" ||
        !options.registry || typeof options.registry.status !== "function" ||
        typeof options.registry.exportV47 !== "function" ||
        typeof options.registry.inspectSession !== "function" ||
        typeof options.isTrustedRendererOwner !== "function" ||
        !validLogicalId(options.ownerId ?? "main-player-authority")) {
      throw new TypeError("native player-authority persistence broker options are invalid");
    }
    this.runtime = options.runtime;
    this.registry = options.registry;
    this.ownerId = options.ownerId ?? "main-player-authority";
    this.isTrustedRendererOwner = options.isTrustedRendererOwner;
  }

  requireTrustedRenderer(rendererOwnerId) {
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw brokerError(
        "native player-authority persistence caller is not the trusted renderer",
        "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_RENDERER_UNTRUSTED",
      );
    }
  }

  async withBoundary(rendererOwnerId, operation) {
    this.requireTrustedRenderer(rendererOwnerId);
    return this.runtime.withSettledPersistenceBoundary(async (boundary) => {
      const owned = this.registry.inspectSession(this.ownerId, boundary.sessionId);
      if (owned?.ownerId !== this.ownerId || owned.slot !== "normal-main" ||
          owned.state !== "owned" || owned.inFlight !== 0) {
        throw brokerError(
          "native player-authority persistence session is not exclusively main-owned",
          "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_OWNER_INVALID",
        );
      }
      const summary = await this.registry.status(this.ownerId, boundary.sessionId);
      validateBoundary(boundary, summary);
      const value = await operation(boundary, summary);
      this.requireTrustedRenderer(rendererOwnerId);
      return value;
    });
  }

  checkpoint(rendererOwnerId) {
    return this.withBoundary(rendererOwnerId, async (boundary, summary) => Object.freeze({
      checkpoint: Object.freeze({ ...boundary.checkpoint }),
      summary,
      reusedAcknowledgedCheckpoint: true,
    }));
  }

  exportV47(rendererOwnerId, request) {
    exactKeys(request, ["exportId", "savedAtMs"], "native player-authority export request");
    if (!validLogicalId(request.exportId) || !Number.isSafeInteger(request.savedAtMs) || request.savedAtMs < 0) {
      throw brokerError("native player-authority export request is invalid");
    }
    return this.withBoundary(rendererOwnerId, async (boundary) => {
      const result = await this.registry.exportV47(this.ownerId, {
        sessionId: boundary.sessionId,
        exportId: request.exportId,
        savedAtMs: request.savedAtMs,
      });
      if (!isRecord(result) || result.exportId !== request.exportId || result.mode !== "normal" ||
          result.result?.revision !== boundary.revision || result.result.savedAtMs !== request.savedAtMs) {
        throw brokerError(
          "native player-authority export is not bound to the settled checkpoint",
          "NATIVE_PLAYER_AUTHORITY_EXPORT_STALE",
        );
      }
      return result;
    });
  }
}

module.exports = {
  NativePlayerAuthorityPersistenceBroker,
  NativePlayerAuthorityPersistenceBrokerError,
};
