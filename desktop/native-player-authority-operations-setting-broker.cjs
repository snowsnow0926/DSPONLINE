"use strict";

const {
  deriveOperationsSettingCommandIdentity,
  normalizeOperationsSettingIntent,
} = require("./native-operations-setting-intent.cjs");

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return record(value) && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
}
function identity(value) { return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_.:\/-]+$/.test(value); }

class NativePlayerAuthorityOperationsSettingBroker {
  constructor(options) {
    if (!record(options) || !options.runtime || typeof options.runtime.snapshot !== "function" ||
        typeof options.runtime.commitOperationsSettingIntent !== "function" ||
        typeof options.isTrustedRendererOwner !== "function") {
      throw new TypeError("native operations setting broker options are invalid");
    }
    this.runtime = options.runtime;
    this.isTrustedRendererOwner = options.isTrustedRendererOwner;
  }

  async commit(rendererOwnerId, rawRequest) {
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw Object.assign(new Error("native operations setting caller is not trusted"), { code: "NATIVE_PLAYER_AUTHORITY_OPERATIONS_RENDERER_UNTRUSTED" });
    }
    if (!exactKeys(rawRequest, [
      "expectedSessionId", "expectedRunId", "expectedRevision", "expectedRegistryFingerprint", "intent",
    ]) || !identity(rawRequest.expectedSessionId) || !identity(rawRequest.expectedRunId) ||
      !Number.isSafeInteger(rawRequest.expectedRevision) || rawRequest.expectedRevision < 0 ||
      !identity(rawRequest.expectedRegistryFingerprint)) {
      throw new TypeError("native operations setting renderer request is invalid");
    }
    const before = this.runtime.snapshot();
    if (!record(before) || before.phase !== "active" || before.sessionId !== rawRequest.expectedSessionId ||
        before.runId !== rawRequest.expectedRunId || before.revision !== rawRequest.expectedRevision) {
      throw Object.assign(new Error("native operations projection lineage is stale"), { code: "NATIVE_PLAYER_AUTHORITY_OPERATIONS_STALE" });
    }
    const derived = deriveOperationsSettingCommandIdentity({
      sessionId: rawRequest.expectedSessionId,
      runId: rawRequest.expectedRunId,
      expectedRevision: rawRequest.expectedRevision,
      expectedRegistryFingerprint: rawRequest.expectedRegistryFingerprint,
      intent: normalizeOperationsSettingIntent(rawRequest.intent),
    });
    const receipt = await this.runtime.commitOperationsSettingIntent({
      commandId: derived.commandId,
      baseRevision: rawRequest.expectedRevision,
      expectedRegistryFingerprint: rawRequest.expectedRegistryFingerprint,
      intent: derived.semantic.intent,
    });
    if (!record(receipt) || receipt.phase !== "active" || receipt.sessionId !== before.sessionId ||
        receipt.previousRevision !== rawRequest.expectedRevision || receipt.revision !== rawRequest.expectedRevision + 1 ||
        receipt.topologyDirty !== false || !Array.isArray(receipt.changedEntityIds) || receipt.changedEntityIds.length !== 0 ||
        !Array.isArray(receipt.changedBeltIds) || receipt.changedBeltIds.length !== 0) {
      throw new TypeError("native operations leaf-only durable receipt is invalid");
    }
    return Object.freeze({
      previousRevision: receipt.previousRevision, revision: receipt.revision,
      changedEntityIds: Object.freeze([]), changedBeltIds: Object.freeze([]), topologyDirty: false,
    });
  }
}

module.exports = { NativePlayerAuthorityOperationsSettingBroker };
