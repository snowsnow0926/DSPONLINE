const contract = require("../cloud-transfer-contract.json");

const numericContractKeys = [
  "version", "mibBytes", "guaranteedSavePayloadBytes", "savePayloadLimitBytes", "rawFallbackSafeLimitBytes",
  "requestCompressedLimitBytes", "requestExpandedLimitBytes", "legacyJsonRequestLimitBytes", "singleSaveResponseLimitBytes",
  "maximumConcurrentExpandedBytes",
  "baseTimeoutMs", "timeoutPerMibMs", "maximumTimeoutMs", "compressionTimeoutMs", "ipcChunkBytes",
];
if (!numericContractKeys.every((key) => Number.isSafeInteger(contract[key]) && contract[key] > 0) ||
  contract.guaranteedSavePayloadBytes > contract.savePayloadLimitBytes ||
  contract.savePayloadLimitBytes > contract.requestExpandedLimitBytes ||
  contract.requestCompressedLimitBytes > contract.requestExpandedLimitBytes ||
  contract.requestExpandedLimitBytes > contract.maximumConcurrentExpandedBytes ||
  contract.baseTimeoutMs > contract.maximumTimeoutMs) {
  throw new Error("Invalid desktop cloud transfer contract");
}

const allowedRequestHeaders = new Set([
  "authorization",
  "content-type",
  "content-encoding",
  "x-dsp-save-mode",
  contract.expectedRevisionHeader,
  contract.requestIdHeader,
  contract.originalBytesHeader,
  contract.compressedBytesHeader,
]);

function validRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,120}$/.test(value);
}

function normalizeRequestHeaders(source = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(source)) {
    const normalized = name.toLowerCase();
    if (allowedRequestHeaders.has(normalized) && typeof value === "string" && value.length <= 512) {
      headers[normalized] = value;
    }
  }
  return headers;
}

// IPC request IDs identify cancellation/stream acknowledgements. Only the
// direct upload protocol also uses that ID as an HTTP idempotency header.
function normalizeTransferRequestHeaders(request) {
  const headers = normalizeRequestHeaders(request?.headers);
  if (String(request?.method ?? "GET").toUpperCase() === "PUT" &&
      /^\/(?:api\/)?cloud-save(?:\?|$)/.test(request?.path ?? "") &&
      headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() === contract.directPayloadContentType &&
      validRequestId(request?.requestId)) {
    headers[contract.requestIdHeader] = request.requestId;
  }
  return headers;
}

function requestTimeoutMs(requestBytes = 0, responseBytes = 0, requestedTimeoutMs) {
  const bytes = Math.max(0, Number.isFinite(requestBytes) ? requestBytes : 0) +
    Math.max(0, Number.isFinite(responseBytes) ? responseBytes : 0);
  const calculated = Math.min(
    contract.maximumTimeoutMs,
    contract.baseTimeoutMs + Math.ceil(bytes / contract.mibBytes) * contract.timeoutPerMibMs,
  );
  if (!Number.isFinite(requestedTimeoutMs)) return calculated;
  const requested = Math.max(contract.baseTimeoutMs, Math.min(contract.maximumTimeoutMs, Math.floor(requestedTimeoutMs)));
  return Math.min(contract.maximumTimeoutMs, Math.max(calculated, requested));
}

function requestBodyLimit(headers = {}) {
  const contentType = String(headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType === contract.directPayloadContentType) return contract.requestCompressedLimitBytes;
  return contract.legacyJsonRequestLimitBytes;
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  throw new TypeError("Desktop API transferable body must be an ArrayBuffer");
}

function exactUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Desktop API transferable chunk must be binary");
}

module.exports = {
  contract,
  exactArrayBuffer,
  exactUint8Array,
  normalizeRequestHeaders,
  normalizeTransferRequestHeaders,
  requestBodyLimit,
  requestTimeoutMs,
  validRequestId,
};
