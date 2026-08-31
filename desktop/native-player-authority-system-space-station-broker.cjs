"use strict";

/*
 * Renderer-safe intent broker for the Rust-authoritative system space station.
 * The renderer supplies only the revision/catalog it rendered plus one exact
 * intent. Session/run/owner/command identity and every material patch remain
 * main/Rust-owned.
 */

const {
  deriveSystemSpaceStationCommandIdentity,
  normalizeSystemSpaceStationIntent,
} = require("./native-system-space-station-intent.cjs");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Reflect.ownKeys(value).every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function validIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    /^[A-Za-z0-9_.:\/-]+$/.test(value);
}

function normalizeIds(value, label) {
  if (!Array.isArray(value) || value.length > 65_536) throw new TypeError(label);
  const result = value.map((id) => {
    if (typeof id !== "string" || id.length < 1 || id.includes("\0") ||
        Buffer.byteLength(id, "utf8") > 512) throw new TypeError(label);
    return id;
  });
  for (let index = 1; index < result.length; index += 1) {
    if (Buffer.compare(Buffer.from(result[index - 1], "utf8"), Buffer.from(result[index], "utf8")) >= 0) {
      throw new TypeError(label);
    }
  }
  return Object.freeze(result);
}

class NativePlayerAuthoritySystemSpaceStationBroker {
  constructor(options) {
    if (!isRecord(options) || !options.runtime || typeof options.runtime.snapshot !== "function" ||
        typeof options.runtime.commitSystemSpaceStationIntent !== "function" ||
        typeof options.isTrustedRendererOwner !== "function") {
      throw new TypeError("native system-space-station broker options are invalid");
    }
    this.runtime = options.runtime;
    this.isTrustedRendererOwner = options.isTrustedRendererOwner;
  }

  async commit(rendererOwnerId, rawRequest) {
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw Object.assign(new Error("native system-space-station caller is not trusted"), {
        code: "NATIVE_PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_RENDERER_UNTRUSTED",
      });
    }
    if (!exactKeys(rawRequest, ["expectedRevision", "expectedRegistryFingerprint", "intent"]) ||
        !Number.isSafeInteger(rawRequest.expectedRevision) || rawRequest.expectedRevision < 0 ||
        !validIdentity(rawRequest.expectedRegistryFingerprint)) {
      throw new TypeError("native system-space-station renderer request is invalid");
    }
    const before = this.runtime.snapshot();
    if (!isRecord(before) || before.phase !== "active" || !validIdentity(before.sessionId) ||
        !validIdentity(before.runId) || !Number.isSafeInteger(before.revision)) {
      throw Object.assign(new Error("native system-space-station authority is unavailable"), {
        code: "NATIVE_PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_UNAVAILABLE",
      });
    }
    const identity = deriveSystemSpaceStationCommandIdentity({
      sessionId: before.sessionId,
      runId: before.runId,
      expectedRevision: rawRequest.expectedRevision,
      expectedRegistryFingerprint: rawRequest.expectedRegistryFingerprint,
      intent: normalizeSystemSpaceStationIntent(rawRequest.intent),
    });
    const receipt = await this.runtime.commitSystemSpaceStationIntent({
      commandId: identity.commandId,
      baseRevision: rawRequest.expectedRevision,
      expectedRegistryFingerprint: rawRequest.expectedRegistryFingerprint,
      intent: identity.semantic.intent,
    });
    if (!isRecord(receipt) || receipt.phase !== "active" ||
        receipt.sessionId !== before.sessionId ||
        receipt.previousRevision !== rawRequest.expectedRevision ||
        receipt.revision !== rawRequest.expectedRevision + 1 ||
        typeof receipt.topologyDirty !== "boolean") {
      throw new TypeError("native system-space-station durable receipt is invalid");
    }
    const changedEntityIds = normalizeIds(
      receipt.changedEntityIds,
      "native system-space-station entity receipt is invalid",
    );
    const changedBeltIds = normalizeIds(
      receipt.changedBeltIds,
      "native system-space-station belt receipt is invalid",
    );
    if (changedEntityIds.length + changedBeltIds.length > 65_536) {
      throw new TypeError("native system-space-station receipt exceeds its bounded ID budget");
    }
    return Object.freeze({
      previousRevision: receipt.previousRevision,
      revision: receipt.revision,
      changedEntityIds,
      changedBeltIds,
      topologyDirty: receipt.topologyDirty,
    });
  }
}

module.exports = {
  NativePlayerAuthoritySystemSpaceStationBroker,
};
