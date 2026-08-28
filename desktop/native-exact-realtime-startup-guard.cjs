"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeLease } = require("./native-core-exact-realtime-experiment.cjs");
const { PERFORMANCE_EDITION_IDENTITY } = require("./performance-edition-identity.cjs");

const EXPERIMENTAL_NATIVE_EXACT_REALTIME_ENV =
  "DSP_DESKTOP_EXPERIMENTAL_NATIVE_EXACT_REALTIME";
const STARTUP_GUARD_SCHEMA_VERSION = 1;
const INSPECTION_FAILED_CODE = "NATIVE_CORE_EXACT_REALTIME_STARTUP_INSPECTION_FAILED";
const HOST_UNAVAILABLE_UNINSPECTED_CODE = "NATIVE_CORE_EXACT_REALTIME_HOST_UNAVAILABLE_UNINSPECTED";
const DISK_LEASE_CORRUPT_CODE = "NATIVE_CORE_EXACT_REALTIME_DISK_LEASE_CORRUPT";
const DISK_LEASE_UNKNOWN_CODE = "NATIVE_CORE_EXACT_REALTIME_DISK_LEASE_UNKNOWN";
const LEGACY_DISK_LEASE_PRESENT_CODE = "NATIVE_CORE_EXACT_REALTIME_LEGACY_DISK_LEASE_PRESENT";
const NATIVE_SAVE_DIRECTORY_NAME = "native-saves-v1";
const AUTHORITY_DIRECTORY_NAME = "authority";
const NORMAL_SLOT_DIRECTORY_NAME = "normal-main";
const RUST_LEASE_FILE_NAME = "exact-realtime-lease-v2.json";
const LEGACY_RUST_LEASE_FILE_NAME = "exact-realtime-lease-v1.json";
const RUST_LEASE_STORAGE_VERSION = 2;
const MAX_RUST_LEASE_BYTES = 32 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class NativeExactRealtimeDiskInspectionError extends Error {
  constructor(message, state, code) {
    super(message);
    this.name = "NativeExactRealtimeDiskInspectionError";
    this.state = state;
    this.code = code;
  }
}

function diskInspectionError(message, state = "unknown", code = DISK_LEASE_UNKNOWN_CODE) {
  return new NativeExactRealtimeDiskInspectionError(message, state, code);
}

function requireOnlyKeys(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const allowed = new Set(allowedKeys);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} contains an unknown field`);
  }
}

function experimentalConfiguration(environment) {
  const raw = environment?.[EXPERIMENTAL_NATIVE_EXACT_REALTIME_ENV];
  const labRequested = raw === "1";
  const invalid = raw !== undefined && raw !== "" && raw !== "0" && raw !== "1";
  return {
    labRequested,
    configurationState: labRequested
      ? "experimental-opt-in"
      : invalid
        ? "invalid-ignored"
        : "default",
  };
}

function statusForInspection(inspection, environment = process.env) {
  const configuration = experimentalConfiguration(environment);
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    throw new TypeError("native exact realtime lease inspection is invalid");
  }
  if (inspection.state === "missing") {
    return {
      schemaVersion: STARTUP_GUARD_SCHEMA_VERSION,
      ...configuration,
      state: "inactive",
      leaseState: "missing",
      code: null,
      normalWindowAllowed: true,
      message: "未发现待恢复的原生权威租约",
    };
  }
  if (inspection.state === "valid" || inspection.state === "present") {
    const phase = inspection.lease?.phase;
    if (!["prepared", "active", "paused", "finalizing"].includes(phase)) {
      throw new TypeError("native exact realtime valid lease phase is invalid");
    }
    return {
      schemaVersion: STARTUP_GUARD_SCHEMA_VERSION,
      ...configuration,
      state: "recovery-required",
      leaseState: inspection.state,
      leasePhase: phase,
      code: "NATIVE_CORE_EXACT_REALTIME_RECOVERY_REQUIRED",
      normalWindowAllowed: false,
      message: `检测到 ${phase} 原生权威租约；当前版本尚未接入桌面恢复，已阻止普通游戏窗口启动`,
    };
  }
  if (["blocked", "corrupt", "unknown"].includes(inspection.state) &&
      typeof inspection.code === "string" && inspection.code.length > 0) {
    return {
      schemaVersion: STARTUP_GUARD_SCHEMA_VERSION,
      ...configuration,
      state: "inspection-blocked",
      leaseState: inspection.state,
      code: inspection.code,
      normalWindowAllowed: false,
      message: `原生权威租约无法安全验证（${inspection.code}）；已阻止普通游戏窗口启动`,
    };
  }
  throw new TypeError("native exact realtime lease inspection state is invalid");
}

/**
 * Process-initial default only. A host failure must replace this with a
 * bounded disk-inspection result before normal startup can be considered.
 */
function unavailableStartupStatus(environment = process.env) {
  return {
    schemaVersion: STARTUP_GUARD_SCHEMA_VERSION,
    ...experimentalConfiguration(environment),
    state: "host-unavailable-uninspected",
    leaseState: "unknown",
    code: HOST_UNAVAILABLE_UNINSPECTED_CODE,
    normalWindowAllowed: false,
    message: "Windows 原生性能服务不可用，且尚未证明磁盘上不存在原生权威租约；已阻止普通游戏窗口启动",
  };
}

function resolveFixedNativeSaveRootPath(performanceEditionUserDataPath, pathModule = path) {
  if (typeof performanceEditionUserDataPath !== "string" ||
      !pathModule.isAbsolute(performanceEditionUserDataPath) ||
      performanceEditionUserDataPath.includes("\0")) {
    throw new TypeError("performance-edition userData path is invalid");
  }
  const userDataPath = pathModule.resolve(performanceEditionUserDataPath);
  if (pathModule.basename(userDataPath) !== PERFORMANCE_EDITION_IDENTITY.userDataDirectoryName) {
    throw new TypeError("native save inspection is outside the fixed performance-edition userData root");
  }
  const nativeSaveRootPath = pathModule.join(userDataPath, NATIVE_SAVE_DIRECTORY_NAME);
  if (pathModule.dirname(nativeSaveRootPath) !== userDataPath) {
    throw new TypeError("native save inspection path escaped the fixed performance-edition userData root");
  }
  return nativeSaveRootPath;
}

function optionalMetadata(fileSystem, targetPath) {
  try {
    return fileSystem.lstatSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function comparableIdentity(metadata) {
  const identity = {};
  for (const key of ["dev", "ino"]) {
    if (typeof metadata?.[key] === "number" || typeof metadata?.[key] === "bigint") {
      identity[key] = metadata[key];
    }
  }
  if (Reflect.ownKeys(identity).length === 0) {
    throw diskInspectionError("filesystem did not expose a stable directory identity");
  }
  return identity;
}

function sameIdentity(expected, actual) {
  return Reflect.ownKeys(expected).every((key) => (
    typeof actual?.[key] === typeof expected[key] && actual[key] === expected[key]
  ));
}

function requireDirectDirectory(fileSystem, targetPath, label) {
  const metadata = optionalMetadata(fileSystem, targetPath);
  if (metadata === null) return null;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw diskInspectionError(`${label} is not a direct directory`);
  }
  return { metadata, identity: comparableIdentity(metadata) };
}

function requireSameDirectDirectory(fileSystem, targetPath, expected, label) {
  const current = requireDirectDirectory(fileSystem, targetPath, label);
  if (current === null || !sameIdentity(expected.identity, current.metadata)) {
    throw diskInspectionError(`${label} changed during native lease inspection`);
  }
  return current;
}

function proveChildMissing(fileSystem, childPath, parentPath, parent, label) {
  if (optionalMetadata(fileSystem, childPath) !== null) return false;
  requireSameDirectDirectory(fileSystem, parentPath, parent, `${label} parent`);
  if (optionalMetadata(fileSystem, childPath) !== null) return false;
  return true;
}

function requireRegularLeaseMetadata(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw diskInspectionError("native exact realtime lease is not a direct regular file");
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_RUST_LEASE_BYTES) {
    throw diskInspectionError(
      "native exact realtime lease size is invalid",
      "corrupt",
      DISK_LEASE_CORRUPT_CODE,
    );
  }
}

function readBoundedStableFile(fileSystem, filePath, before) {
  requireRegularLeaseMetadata(before);
  const expectedIdentity = comparableIdentity(before);
  const buffer = Buffer.alloc(before.size + 1);
  let descriptor;
  let bytesRead = 0;
  try {
    descriptor = fileSystem.openSync(filePath, "r");
    const descriptorMetadata = fileSystem.fstatSync(descriptor);
    requireRegularLeaseMetadata(descriptorMetadata);
    if (!sameIdentity(expectedIdentity, descriptorMetadata) || descriptorMetadata.size !== before.size) {
      throw diskInspectionError("native exact realtime lease changed before bounded read");
    }
    while (bytesRead < buffer.length) {
      const count = fileSystem.readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
  const after = optionalMetadata(fileSystem, filePath);
  if (after === null) throw diskInspectionError("native exact realtime lease disappeared during bounded read");
  requireRegularLeaseMetadata(after);
  if (!sameIdentity(expectedIdentity, after) || after.size !== before.size || bytesRead !== before.size) {
    throw diskInspectionError("native exact realtime lease changed during bounded read");
  }
  return buffer.subarray(0, bytesRead);
}

function parseStoredRustLease(bytes) {
  let stored;
  try {
    stored = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw diskInspectionError("native exact realtime lease JSON is corrupt", "corrupt", DISK_LEASE_CORRUPT_CODE);
  }
  try {
    requireOnlyKeys(stored, ["storageVersion", "lease", "checksum"], "stored Rust lease");
    if (stored.storageVersion !== RUST_LEASE_STORAGE_VERSION ||
        typeof stored.checksum !== "string" ||
        !SHA256_PATTERN.test(stored.checksum)) {
      throw new TypeError("stored Rust lease identity is invalid");
    }
    const lease = normalizeLease(stored.lease);
    const checksum = createHash("sha256").update(JSON.stringify(lease)).digest("hex");
    if (checksum !== stored.checksum) throw new TypeError("stored Rust lease checksum is invalid");
    return lease;
  } catch (error) {
    if (error instanceof NativeExactRealtimeDiskInspectionError) throw error;
    throw diskInspectionError(
      "native exact realtime lease payload is corrupt",
      "corrupt",
      DISK_LEASE_CORRUPT_CODE,
    );
  }
}

function inspectFixedNativeExactRealtimeLeaseOnDisk(options) {
  requireOnlyKeys(options, ["performanceEditionUserDataPath", "fileSystem", "pathModule"], "disk lease inspection options");
  const fileSystem = options.fileSystem ?? fs;
  const pathModule = options.pathModule ?? path;
  const nativeSaveRootPath = resolveFixedNativeSaveRootPath(
    options.performanceEditionUserDataPath,
    pathModule,
  );
  try {
    const userDataPath = pathModule.dirname(nativeSaveRootPath);
    const userData = requireDirectDirectory(fileSystem, userDataPath, "performance-edition userData");
    if (userData === null) throw diskInspectionError("performance-edition userData disappeared");

    const nativeRoot = requireDirectDirectory(fileSystem, nativeSaveRootPath, "native save root");
    if (nativeRoot === null) {
      return proveChildMissing(fileSystem, nativeSaveRootPath, userDataPath, userData, "native save root")
        ? { state: "missing" }
        : { state: "unknown", code: DISK_LEASE_UNKNOWN_CODE };
    }
    const authorityPath = pathModule.join(nativeSaveRootPath, AUTHORITY_DIRECTORY_NAME);
    const authority = requireDirectDirectory(fileSystem, authorityPath, "native authority directory");
    if (authority === null) {
      return proveChildMissing(fileSystem, authorityPath, nativeSaveRootPath, nativeRoot, "native authority directory")
        ? { state: "missing" }
        : { state: "unknown", code: DISK_LEASE_UNKNOWN_CODE };
    }
    const slotPath = pathModule.join(authorityPath, NORMAL_SLOT_DIRECTORY_NAME);
    const slot = requireDirectDirectory(fileSystem, slotPath, "native normal-main authority directory");
    if (slot === null) {
      return proveChildMissing(fileSystem, slotPath, authorityPath, authority, "native normal-main authority directory")
        ? { state: "missing" }
        : { state: "unknown", code: DISK_LEASE_UNKNOWN_CODE };
    }

    const legacyPath = pathModule.join(slotPath, LEGACY_RUST_LEASE_FILE_NAME);
    if (optionalMetadata(fileSystem, legacyPath) !== null) {
      return { state: "unknown", code: LEGACY_DISK_LEASE_PRESENT_CODE };
    }
    const leasePath = pathModule.join(slotPath, RUST_LEASE_FILE_NAME);
    const leaseMetadata = optionalMetadata(fileSystem, leasePath);
    if (leaseMetadata === null) {
      requireSameDirectDirectory(fileSystem, slotPath, slot, "native normal-main authority directory");
      if (optionalMetadata(fileSystem, legacyPath) !== null || optionalMetadata(fileSystem, leasePath) !== null) {
        return { state: "unknown", code: DISK_LEASE_UNKNOWN_CODE };
      }
      return { state: "missing" };
    }
    const lease = parseStoredRustLease(readBoundedStableFile(fileSystem, leasePath, leaseMetadata));
    requireSameDirectDirectory(fileSystem, slotPath, slot, "native normal-main authority directory");
    return { state: "present", lease };
  } catch (error) {
    if (error instanceof NativeExactRealtimeDiskInspectionError) {
      return { state: error.state, code: error.code };
    }
    return { state: "unknown", code: DISK_LEASE_UNKNOWN_CODE };
  }
}

async function inspectNativeExactRealtimeStartup(options) {
  requireOnlyKeys(options, ["leaseStore", "environment"], "native exact realtime startup options");
  if (!options.leaseStore || typeof options.leaseStore.inspect !== "function") {
    throw new TypeError("native exact realtime lease store is invalid");
  }
  const environment = options.environment ?? process.env;
  try {
    return statusForInspection(await options.leaseStore.inspect(), environment);
  } catch {
    return {
      schemaVersion: STARTUP_GUARD_SCHEMA_VERSION,
      ...experimentalConfiguration(environment),
      state: "inspection-blocked",
      leaseState: "blocked",
      code: INSPECTION_FAILED_CODE,
      normalWindowAllowed: false,
      message: "原生权威租约检查未能完成；已阻止普通游戏窗口启动",
    };
  }
}

function inspectNativeExactRealtimeStartupWithoutHost(options) {
  requireOnlyKeys(
    options,
    ["performanceEditionUserDataPath", "fileSystem", "pathModule", "environment"],
    "host-unavailable startup inspection options",
  );
  const environment = options.environment ?? process.env;
  const inspection = inspectFixedNativeExactRealtimeLeaseOnDisk({
    performanceEditionUserDataPath: options.performanceEditionUserDataPath,
    ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
    ...(options.pathModule ? { pathModule: options.pathModule } : {}),
  });
  const status = statusForInspection(inspection, environment);
  if (inspection.state === "missing") {
    return {
      ...status,
      state: "host-unavailable-no-lease",
      message: "Windows 原生性能服务不可用；磁盘检查已确认不存在原生权威租约，继续使用 JavaScript 权威启动",
    };
  }
  return {
    ...status,
    state: status.state === "recovery-required"
      ? "host-unavailable-recovery-required"
      : "host-unavailable-inspection-blocked",
    message: `Windows 原生性能服务不可用；${status.message}`,
  };
}

module.exports = {
  DISK_LEASE_CORRUPT_CODE,
  DISK_LEASE_UNKNOWN_CODE,
  EXPERIMENTAL_NATIVE_EXACT_REALTIME_ENV,
  HOST_UNAVAILABLE_UNINSPECTED_CODE,
  INSPECTION_FAILED_CODE,
  LEGACY_DISK_LEASE_PRESENT_CODE,
  MAX_RUST_LEASE_BYTES,
  NATIVE_SAVE_DIRECTORY_NAME,
  RUST_LEASE_FILE_NAME,
  STARTUP_GUARD_SCHEMA_VERSION,
  inspectFixedNativeExactRealtimeLeaseOnDisk,
  inspectNativeExactRealtimeStartup,
  inspectNativeExactRealtimeStartupWithoutHost,
  resolveFixedNativeSaveRootPath,
  statusForInspection,
  unavailableStartupStatus,
};
