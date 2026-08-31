"use strict";

const { createHash } = require("node:crypto");

const DOMAIN_ID_PATTERN = /^[A-Za-z0-9_.:\/-]+$/;
const MAX_REQUEST_BYTES = 32_768;
const MAX_MODULE_TARGET = 1_000_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Reflect.ownKeys(value).every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function domainId(value, label, maximumBytes = 256) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > maximumBytes || !DOMAIN_ID_PATTERN.test(value)) {
    throw new TypeError(`native system-space-station ${label} is invalid`);
  }
  return value;
}

function safeInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`native system-space-station ${label} is invalid`);
  }
  return value;
}

function normalizeSystemSpaceStationIntent(value) {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new TypeError("native system-space-station intent is invalid");
  }
  switch (value.type) {
    case "start":
      if (!exactKeys(value, ["type", "systemId"])) throw new TypeError("native system-space-station start intent is invalid");
      return Object.freeze({ type: "start", systemId: domainId(value.systemId, "system ID") });
    case "deliver-from-tray":
      if (!exactKeys(value, ["type", "systemId", "planetId", "itemId", "requestedAmount"])) throw new TypeError("native system-space-station delivery intent is invalid");
      return Object.freeze({
        type: "deliver-from-tray",
        systemId: domainId(value.systemId, "system ID"),
        planetId: domainId(value.planetId, "planet ID"),
        itemId: domainId(value.itemId, "item ID"),
        requestedAmount: safeInteger(value.requestedAmount, 1, Number.MAX_SAFE_INTEGER, "requested amount"),
      });
    case "module-target":
      if (!exactKeys(value, ["type", "systemId", "module", "target"]) ||
          !["backbone", "energy", "interstellar"].includes(value.module)) {
        throw new TypeError("native system-space-station module intent is invalid");
      }
      return Object.freeze({
        type: "module-target",
        systemId: domainId(value.systemId, "system ID"),
        module: value.module,
        target: safeInteger(value.target, 0, MAX_MODULE_TARGET, "module target"),
      });
    case "upgrade-one":
      if (!exactKeys(value, ["type", "entityId"])) throw new TypeError("native system-space-station upgrade intent is invalid");
      return Object.freeze({ type: "upgrade-one", entityId: domainId(value.entityId, "entity ID", 512) });
    case "upgrade-all":
      if (!exactKeys(value, ["type", "systemId"]) || value.systemId !== null && typeof value.systemId !== "string") {
        throw new TypeError("native system-space-station fleet upgrade intent is invalid");
      }
      return Object.freeze({
        type: "upgrade-all",
        systemId: value.systemId === null ? null : domainId(value.systemId, "system ID"),
      });
    case "mode-target":
      if (!exactKeys(value, ["type", "entityId", "mode"]) || !["legacy", "elevator"].includes(value.mode)) {
        throw new TypeError("native system-space-station mode intent is invalid");
      }
      return Object.freeze({
        type: "mode-target",
        entityId: domainId(value.entityId, "entity ID", 512),
        mode: value.mode,
      });
    case "output-target":
      if (!exactKeys(value, ["type", "entityId", "portIndex", "itemId", "confirmations"]) ||
          value.itemId !== null && typeof value.itemId !== "string") {
        throw new TypeError("native system-space-station output intent is invalid");
      }
      return Object.freeze({
        type: "output-target",
        entityId: domainId(value.entityId, "entity ID", 512),
        portIndex: safeInteger(value.portIndex, 0, 4, "output port"),
        itemId: value.itemId === null ? null : domainId(value.itemId, "item ID"),
        confirmations: safeInteger(value.confirmations, 2, 255, "output confirmation count"),
      });
    default:
      throw new TypeError("native system-space-station intent type is invalid");
  }
}

function systemSpaceStationSemanticRequest(value) {
  if (!exactKeys(value, [
    "sessionId", "runId", "expectedRevision", "expectedRegistryFingerprint", "intent",
  ])) {
    throw new TypeError("native system-space-station semantic request is invalid");
  }
  const normalized = {
    sessionId: domainId(value.sessionId, "session ID"),
    runId: domainId(value.runId, "run ID"),
    expectedRevision: safeInteger(value.expectedRevision, 0, Number.MAX_SAFE_INTEGER, "revision"),
    expectedRegistryFingerprint: domainId(value.expectedRegistryFingerprint, "registry fingerprint"),
    intent: normalizeSystemSpaceStationIntent(value.intent),
  };
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
    throw new RangeError("native system-space-station semantic request exceeds its bounded limit");
  }
  return Object.freeze(normalized);
}

function deriveSystemSpaceStationCommandIdentity(value) {
  const semantic = systemSpaceStationSemanticRequest(value);
  const semanticSha256 = createHash("sha256").update(JSON.stringify(semantic), "utf8").digest("hex");
  return Object.freeze({
    semantic,
    semanticSha256,
    commandId: `system-space-station-v1-${semanticSha256}`,
  });
}

module.exports = {
  MAX_SYSTEM_SPACE_STATION_INTENT_REQUEST_BYTES: MAX_REQUEST_BYTES,
  deriveSystemSpaceStationCommandIdentity,
  normalizeSystemSpaceStationIntent,
  systemSpaceStationSemanticRequest,
};
