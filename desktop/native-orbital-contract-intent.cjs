"use strict";

const { createHash } = require("node:crypto");

const DOMAIN_ID_PATTERN = /^[A-Za-z0-9_.:\/-]+$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,255})$/;
const MAX_REQUEST_BYTES = 32_768;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Reflect.ownKeys(value).every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function domainId(value, label, maximumBytes = 512) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > maximumBytes || !DOMAIN_ID_PATTERN.test(value)) {
    throw new TypeError(`native orbital-contract ${label} is invalid`);
  }
  return value;
}

function safeRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("native orbital-contract revision is invalid");
  }
  return value;
}

function nonterminalRevision(value) {
  const revision = safeRevision(value);
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("native orbital-contract revision is exhausted");
  }
  return revision;
}

function positiveDecimal(value) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value) || value === "0") {
    throw new TypeError("native orbital-contract requested amount is invalid");
  }
  return value;
}

function normalizeOrbitalContractIntent(value) {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new TypeError("native orbital-contract intent is invalid");
  }
  switch (value.type) {
    case "accept":
    case "claim":
    case "abandon":
      if (!exactKeys(value, ["type", "contractId"])) {
        throw new TypeError(`native orbital-contract ${value.type} intent is invalid`);
      }
      return Object.freeze({ type: value.type, contractId: domainId(value.contractId, "contract ID") });
    case "deliver-quantum":
      if (!exactKeys(value, ["type", "contractId", "itemId", "requestedAmount"])) {
        throw new TypeError("native orbital-contract delivery intent is invalid");
      }
      return Object.freeze({
        type: "deliver-quantum",
        contractId: domainId(value.contractId, "contract ID"),
        itemId: domainId(value.itemId, "item ID", 256),
        requestedAmount: positiveDecimal(value.requestedAmount),
      });
    case "feature":
      if (!exactKeys(value, ["type", "contractId"]) ||
          value.contractId !== null && typeof value.contractId !== "string") {
        throw new TypeError("native orbital-contract feature intent is invalid");
      }
      return Object.freeze({
        type: "feature",
        contractId: value.contractId === null ? null : domainId(value.contractId, "contract ID"),
      });
    default:
      throw new TypeError("native orbital-contract intent type is invalid");
  }
}

function orbitalContractSemanticRequest(value) {
  if (!exactKeys(value, [
    "sessionId", "runId", "expectedRevision", "expectedRegistryFingerprint",
    "confirmedWallClockMs", "intent",
  ])) {
    throw new TypeError("native orbital-contract semantic request is invalid");
  }
  const normalized = {
    sessionId: domainId(value.sessionId, "session ID", 256),
    runId: domainId(value.runId, "run ID", 256),
    expectedRevision: nonterminalRevision(value.expectedRevision),
    expectedRegistryFingerprint: domainId(value.expectedRegistryFingerprint, "registry fingerprint", 256),
    confirmedWallClockMs: safeRevision(value.confirmedWallClockMs),
    intent: normalizeOrbitalContractIntent(value.intent),
  };
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
    throw new RangeError("native orbital-contract semantic request exceeds its bounded limit");
  }
  return Object.freeze(normalized);
}

function deriveOrbitalContractCommandIdentity(value) {
  const semantic = orbitalContractSemanticRequest(value);
  const semanticSha256 = createHash("sha256").update(JSON.stringify(semantic), "utf8").digest("hex");
  return Object.freeze({
    semantic,
    semanticSha256,
    commandId: `orbital-contract-v1-${semanticSha256}`,
  });
}

function createMonotonicOrbitalContractClock(now = Date.now) {
  if (typeof now !== "function") {
    throw new TypeError("native orbital-contract wall-clock source is invalid");
  }
  let lastConfirmedWallClockMs = 0;
  return () => {
    const sampled = now();
    if (!Number.isSafeInteger(sampled) || sampled < 0) {
      throw new TypeError("native orbital-contract main wall clock is invalid");
    }
    lastConfirmedWallClockMs = Math.max(lastConfirmedWallClockMs, sampled);
    return lastConfirmedWallClockMs;
  };
}

module.exports = {
  MAX_ORBITAL_CONTRACT_INTENT_REQUEST_BYTES: MAX_REQUEST_BYTES,
  createMonotonicOrbitalContractClock,
  deriveOrbitalContractCommandIdentity,
  normalizeOrbitalContractIntent,
  orbitalContractSemanticRequest,
};
