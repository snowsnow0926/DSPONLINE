"use strict";

const EXPERIMENTAL_NATIVE_EXACT_REALTIME_ENV =
  "DSP_DESKTOP_EXPERIMENTAL_NATIVE_EXACT_REALTIME";
const STARTUP_GUARD_SCHEMA_VERSION = 1;
const INSPECTION_FAILED_CODE = "NATIVE_CORE_EXACT_REALTIME_STARTUP_INSPECTION_FAILED";

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
  if (inspection.state === "valid") {
    const phase = inspection.lease?.phase;
    if (!["prepared", "active", "paused", "finalizing"].includes(phase)) {
      throw new TypeError("native exact realtime valid lease phase is invalid");
    }
    return {
      schemaVersion: STARTUP_GUARD_SCHEMA_VERSION,
      ...configuration,
      state: "recovery-required",
      leaseState: "valid",
      leasePhase: phase,
      code: "NATIVE_CORE_EXACT_REALTIME_RECOVERY_REQUIRED",
      normalWindowAllowed: false,
      message: `检测到 ${phase} 原生权威租约；当前版本尚未接入桌面恢复，已阻止普通游戏窗口启动`,
    };
  }
  if (inspection.state === "blocked" && typeof inspection.code === "string" && inspection.code.length > 0) {
    return {
      schemaVersion: STARTUP_GUARD_SCHEMA_VERSION,
      ...configuration,
      state: "inspection-blocked",
      leaseState: "blocked",
      code: inspection.code,
      normalWindowAllowed: false,
      message: `原生权威租约无法安全验证（${inspection.code}）；已阻止普通游戏窗口启动`,
    };
  }
  throw new TypeError("native exact realtime lease inspection state is invalid");
}

function unavailableStartupStatus(environment = process.env) {
  return {
    schemaVersion: STARTUP_GUARD_SCHEMA_VERSION,
    ...experimentalConfiguration(environment),
    state: "host-unavailable",
    leaseState: "unavailable",
    code: null,
    normalWindowAllowed: true,
    message: "Windows 原生性能服务不可用，未执行原生权威租约检查",
  };
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

module.exports = {
  EXPERIMENTAL_NATIVE_EXACT_REALTIME_ENV,
  INSPECTION_FAILED_CODE,
  STARTUP_GUARD_SCHEMA_VERSION,
  inspectNativeExactRealtimeStartup,
  statusForInspection,
  unavailableStartupStatus,
};
