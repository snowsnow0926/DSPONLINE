"use strict";

const {
  createMonotonicOrbitalContractClock,
  deriveOrbitalContractCommandIdentity,
  normalizeOrbitalContractIntent,
} = require("./native-orbital-contract-intent.cjs");

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

function emptyChangeIds(value, label) {
  if (!Array.isArray(value) || value.length !== 0) throw new TypeError(label);
  return Object.freeze([]);
}

class NativePlayerAuthorityOrbitalContractBroker {
  constructor(options) {
    if (!isRecord(options) || !options.runtime || typeof options.runtime.snapshot !== "function" ||
        typeof options.runtime.commitOrbitalContractIntent !== "function" ||
        typeof options.isTrustedRendererOwner !== "function" ||
        options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("native orbital-contract broker options are invalid");
    }
    this.runtime = options.runtime;
    this.isTrustedRendererOwner = options.isTrustedRendererOwner;
    this.now = options.now ?? Date.now;
  }

  async commit(rendererOwnerId, rawRequest) {
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw Object.assign(new Error("native orbital-contract caller is not trusted"), {
        code: "NATIVE_PLAYER_AUTHORITY_ORBITAL_CONTRACT_RENDERER_UNTRUSTED",
      });
    }
    if (!exactKeys(rawRequest, [
      "expectedSessionId", "expectedRunId", "expectedRevision",
      "expectedRegistryFingerprint", "intent",
    ]) || !validIdentity(rawRequest.expectedSessionId) ||
        !validIdentity(rawRequest.expectedRunId) ||
        !Number.isSafeInteger(rawRequest.expectedRevision) || rawRequest.expectedRevision < 0 ||
        rawRequest.expectedRevision >= Number.MAX_SAFE_INTEGER ||
        !validIdentity(rawRequest.expectedRegistryFingerprint)) {
      throw new TypeError("native orbital-contract renderer request is invalid");
    }
    const before = this.runtime.snapshot();
    if (!isRecord(before) || before.phase !== "active" || !validIdentity(before.sessionId) ||
        !validIdentity(before.runId) || !Number.isSafeInteger(before.revision)) {
      throw Object.assign(new Error("native orbital-contract authority is unavailable"), {
        code: "NATIVE_PLAYER_AUTHORITY_ORBITAL_CONTRACT_UNAVAILABLE",
      });
    }
    if (before.sessionId !== rawRequest.expectedSessionId ||
        before.runId !== rawRequest.expectedRunId ||
        before.revision !== rawRequest.expectedRevision) {
      throw Object.assign(new Error("native orbital-contract projection lineage is stale"), {
        code: "NATIVE_PLAYER_AUTHORITY_ORBITAL_CONTRACT_STALE",
      });
    }
    const confirmedWallClockMs = this.now();
    if (!Number.isSafeInteger(confirmedWallClockMs) || confirmedWallClockMs < 0) {
      throw new TypeError("native orbital-contract main wall clock is invalid");
    }
    const identity = deriveOrbitalContractCommandIdentity({
      sessionId: rawRequest.expectedSessionId,
      runId: rawRequest.expectedRunId,
      expectedRevision: rawRequest.expectedRevision,
      expectedRegistryFingerprint: rawRequest.expectedRegistryFingerprint,
      confirmedWallClockMs,
      intent: normalizeOrbitalContractIntent(rawRequest.intent),
    });
    const receipt = await this.runtime.commitOrbitalContractIntent({
      commandId: identity.commandId,
      baseRevision: rawRequest.expectedRevision,
      expectedRegistryFingerprint: rawRequest.expectedRegistryFingerprint,
      confirmedWallClockMs,
      intent: identity.semantic.intent,
    });
    if (!isRecord(receipt) || receipt.phase !== "active" ||
        receipt.sessionId !== before.sessionId ||
        receipt.previousRevision !== rawRequest.expectedRevision ||
        receipt.revision !== rawRequest.expectedRevision + 1 ||
        typeof receipt.topologyDirty !== "boolean") {
      throw new TypeError("native orbital-contract durable receipt is invalid");
    }
    return Object.freeze({
      previousRevision: receipt.previousRevision,
      revision: receipt.revision,
      changedEntityIds: emptyChangeIds(
        receipt.changedEntityIds,
        "native orbital-contract entity receipt is invalid",
      ),
      changedBeltIds: emptyChangeIds(
        receipt.changedBeltIds,
        "native orbital-contract belt receipt is invalid",
      ),
      topologyDirty: receipt.topologyDirty,
    });
  }
}

module.exports = {
  createMonotonicOrbitalContractClock,
  NativePlayerAuthorityOrbitalContractBroker,
};
