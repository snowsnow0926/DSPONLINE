"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MEBIBYTE_BYTES = 1024n * 1024n;
const MINIMUM_NATIVE_SAVE_HEADROOM_BYTES = 64n * MEBIBYTE_BYTES;

const NATIVE_SAVE_DISK_BUDGET_CODES = Object.freeze({
  OK: "NATIVE_SAVE_DISK_BUDGET_OK",
  REQUEST_INVALID: "NATIVE_SAVE_DISK_BUDGET_REQUEST_INVALID",
  PATH_INVALID: "NATIVE_SAVE_DISK_BUDGET_PATH_INVALID",
  PARENT_MISSING: "NATIVE_SAVE_DISK_BUDGET_PARENT_MISSING",
  PARENT_INVALID: "NATIVE_SAVE_DISK_BUDGET_PARENT_INVALID",
  PARENT_INSPECTION_FAILED: "NATIVE_SAVE_DISK_BUDGET_PARENT_INSPECTION_FAILED",
  PAYLOAD_INVALID: "NATIVE_SAVE_DISK_BUDGET_PAYLOAD_INVALID",
  STATFS_UNSUPPORTED: "NATIVE_SAVE_DISK_BUDGET_STATFS_UNSUPPORTED",
  STATFS_FAILED: "NATIVE_SAVE_DISK_BUDGET_STATFS_FAILED",
  STATFS_INVALID: "NATIVE_SAVE_DISK_BUDGET_STATFS_INVALID",
  SPACE_INSUFFICIENT: "NATIVE_SAVE_DISK_BUDGET_SPACE_INSUFFICIENT",
});

class NativeSaveDiskBudgetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "NativeSaveDiskBudgetError";
    this.code = code;
    for (const [key, value] of Object.entries(details)) this[key] = value;
  }
}

function budgetError(code, message, details) {
  return new NativeSaveDiskBudgetError(code, message, details);
}

function exactUtf8PayloadBytes(payload) {
  const values = typeof payload === "string"
    ? [payload]
    : Array.isArray(payload) ? payload : null;
  if (values === null || values.some((value) => typeof value !== "string")) {
    throw budgetError(
      NATIVE_SAVE_DISK_BUDGET_CODES.PAYLOAD_INVALID,
      "native save disk budget requires a UTF-8 string payload or string array",
    );
  }
  let total = 0n;
  for (const value of values) {
    const measured = Buffer.byteLength(value, "utf8");
    if (!Number.isSafeInteger(measured) || measured < 0) {
      throw budgetError(
        NATIVE_SAVE_DISK_BUDGET_CODES.PAYLOAD_INVALID,
        "native save UTF-8 payload length is outside the supported range",
      );
    }
    total += BigInt(measured);
  }
  return total;
}

function nativeSaveTargetParent(targetPath, pathModule) {
  if (typeof targetPath !== "string" || targetPath.length === 0 || targetPath.includes("\0") ||
      !pathModule.isAbsolute(targetPath)) {
    throw budgetError(
      NATIVE_SAVE_DISK_BUDGET_CODES.PATH_INVALID,
      "native save disk budget target must be an absolute path",
    );
  }
  const normalizedTargetPath = pathModule.resolve(targetPath);
  const parentPath = pathModule.dirname(normalizedTargetPath);
  if (parentPath === normalizedTargetPath || pathModule.basename(normalizedTargetPath).length === 0) {
    throw budgetError(
      NATIVE_SAVE_DISK_BUDGET_CODES.PATH_INVALID,
      "native save disk budget target must have a parent directory",
    );
  }
  return { normalizedTargetPath, parentPath };
}

function requireExistingDirectParent(fileSystem, parentPath) {
  let metadata;
  try {
    metadata = fileSystem.lstatSync(parentPath);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : null;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw budgetError(
        NATIVE_SAVE_DISK_BUDGET_CODES.PARENT_MISSING,
        "native save disk budget parent directory does not exist",
      );
    }
    throw budgetError(
      NATIVE_SAVE_DISK_BUDGET_CODES.PARENT_INSPECTION_FAILED,
      "native save disk budget parent directory could not be inspected",
    );
  }
  if (!metadata || typeof metadata.isDirectory !== "function" || !metadata.isDirectory() ||
      (typeof metadata.isSymbolicLink === "function" && metadata.isSymbolicLink())) {
    throw budgetError(
      NATIVE_SAVE_DISK_BUDGET_CODES.PARENT_INVALID,
      "native save disk budget parent is not a direct directory",
    );
  }
}

function statfsUnsupported(error) {
  const code = error && typeof error === "object" ? error.code : null;
  return code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" ||
    code === "ERR_METHOD_NOT_IMPLEMENTED" || code === "ERR_NOT_IMPLEMENTED";
}

function unsupportedReceipt(payloadBytes) {
  return Object.freeze({
    allowed: true,
    checked: false,
    code: NATIVE_SAVE_DISK_BUDGET_CODES.STATFS_UNSUPPORTED,
    payloadBytes,
    minimumHeadroomBytes: MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
    requiredAvailableBytes: payloadBytes + MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
  });
}

/**
 * Fail-closed disk admission check for one prospective native-save write.
 *
 * The caller supplies the final target path only to select its already-existing
 * parent filesystem. This helper does not create, write, rename, or remove any
 * file. `payload` is either one UTF-8 string or an array whose encoded byte
 * lengths are summed without separators. A checked receipt proves that the
 * caller's exact payload bytes plus the fixed 64 MiB safety margin fit inside
 * the filesystem's unprivileged available-block budget at inspection time.
 * Platforms that explicitly do not implement statfs fail open with a stable
 * unchecked receipt. All inspection failures and malformed receipts fail
 * closed; unsupported is never inferred from an ordinary I/O error.
 */
function requireNativeSaveDiskBudget(request, dependencies = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).some((key) => key !== "targetPath" && key !== "payload") ||
      !Object.hasOwn(request, "targetPath") || !Object.hasOwn(request, "payload")) {
    throw budgetError(
      NATIVE_SAVE_DISK_BUDGET_CODES.REQUEST_INVALID,
      "native save disk budget request is invalid",
    );
  }
  const fileSystem = dependencies.fileSystem ?? fs;
  const pathModule = dependencies.pathModule ?? path;
  const { parentPath } = nativeSaveTargetParent(request.targetPath, pathModule);
  const payloadBytes = exactUtf8PayloadBytes(request.payload);

  requireExistingDirectParent(fileSystem, parentPath);
  if (typeof fileSystem.statfsSync !== "function") {
    return unsupportedReceipt(payloadBytes);
  }

  let capacity;
  try {
    capacity = fileSystem.statfsSync(parentPath, { bigint: true });
  } catch (error) {
    if (statfsUnsupported(error)) return unsupportedReceipt(payloadBytes);
    throw budgetError(
      NATIVE_SAVE_DISK_BUDGET_CODES.STATFS_FAILED,
      "native save filesystem capacity inspection failed",
    );
  }
  if (!capacity || typeof capacity.bsize !== "bigint" || typeof capacity.bavail !== "bigint" ||
      capacity.bsize <= 0n || capacity.bavail < 0n) {
    throw budgetError(
      NATIVE_SAVE_DISK_BUDGET_CODES.STATFS_INVALID,
      "native save filesystem capacity receipt is invalid",
    );
  }

  const availableBytes = capacity.bsize * capacity.bavail;
  const requiredAvailableBytes = payloadBytes + MINIMUM_NATIVE_SAVE_HEADROOM_BYTES;
  if (availableBytes < requiredAvailableBytes) {
    throw budgetError(
      NATIVE_SAVE_DISK_BUDGET_CODES.SPACE_INSUFFICIENT,
      "native save filesystem does not have enough available space",
      {
        payloadBytes,
        minimumHeadroomBytes: MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
        requiredAvailableBytes,
        availableBytes,
      },
    );
  }

  return Object.freeze({
    allowed: true,
    checked: true,
    code: NATIVE_SAVE_DISK_BUDGET_CODES.OK,
    payloadBytes,
    minimumHeadroomBytes: MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
    requiredAvailableBytes,
    availableBytes,
  });
}

module.exports = {
  MINIMUM_NATIVE_SAVE_HEADROOM_BYTES,
  NATIVE_SAVE_DISK_BUDGET_CODES,
  NativeSaveDiskBudgetError,
  exactUtf8PayloadBytes,
  requireNativeSaveDiskBudget,
};
