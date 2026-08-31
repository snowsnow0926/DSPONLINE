"use strict";

const { createHash } = require("node:crypto");

const MAX_REQUEST_BYTES = 16_384;
const ID_PATTERN = /^[A-Za-z0-9_.:\/-]+$/;

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return record(value) && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
}
function id(value, label, max = 256) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > max || !ID_PATTERN.test(value)) {
    throw new TypeError(`native operations ${label} is invalid`);
  }
  return value;
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`native operations ${label} is invalid`);
  }
  return value;
}

function normalizeOperationsSettingIntent(value) {
  if (!exactKeys(value, ["type", "value"]) || typeof value.type !== "string") {
    throw new TypeError("native operations setting intent is invalid");
  }
  switch (value.type) {
    case "set-simulation-speed":
      if (![1, 2, 4].includes(value.value)) throw new TypeError("native operations simulation speed is invalid");
      break;
    case "set-technology-layout":
      if (!["standard", "compact"].includes(value.value)) throw new TypeError("native operations technology layout is invalid");
      break;
    case "set-default-belt-route-mode":
      if (!["auto", "bezier", "upper", "lower"].includes(value.value)) throw new TypeError("native operations belt route mode is invalid");
      break;
    case "set-production-buffer-limit":
    case "set-logistics-buffer-limit":
    case "set-belt-buffer-limit":
      integer(value.value, 1_000, 100_000_000, "buffer limit");
      break;
    case "set-proliferator-buffer-limit":
      integer(value.value, 1, 100_000_000, "proliferator buffer limit");
      break;
    default:
      throw new TypeError("native operations setting intent type is invalid");
  }
  return Object.freeze({ type: value.type, value: value.value });
}

function operationsSettingSemanticRequest(value) {
  if (!exactKeys(value, ["sessionId", "runId", "expectedRevision", "expectedRegistryFingerprint", "intent"])) {
    throw new TypeError("native operations semantic request is invalid");
  }
  const normalized = {
    sessionId: id(value.sessionId, "session ID"),
    runId: id(value.runId, "run ID"),
    expectedRevision: integer(value.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1, "revision"),
    expectedRegistryFingerprint: id(value.expectedRegistryFingerprint, "registry fingerprint"),
    intent: normalizeOperationsSettingIntent(value.intent),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_REQUEST_BYTES) {
    throw new RangeError("native operations semantic request exceeds its bounded limit");
  }
  return Object.freeze(normalized);
}

function deriveOperationsSettingCommandIdentity(value) {
  const semantic = operationsSettingSemanticRequest(value);
  const semanticSha256 = createHash("sha256").update(JSON.stringify(semantic), "utf8").digest("hex");
  return Object.freeze({ semantic, semanticSha256, commandId: `operations-setting-v1-${semanticSha256}` });
}

module.exports = { deriveOperationsSettingCommandIdentity, normalizeOperationsSettingIntent, operationsSettingSemanticRequest };
