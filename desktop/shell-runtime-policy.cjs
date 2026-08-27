"use strict";

const SHELL_RUNTIME_POLICY_SCHEMA_VERSION = 1;
const EXPERIMENTAL_DISABLE_HARDWARE_ACCELERATION_ENV =
  "DSP_DESKTOP_EXPERIMENTAL_DISABLE_HARDWARE_ACCELERATION";

function resolveShellRuntimePolicy(environment = process.env) {
  const rawDisable = environment?.[EXPERIMENTAL_DISABLE_HARDWARE_ACCELERATION_ENV];
  const disableRequested = rawDisable === "1";
  const invalidDisableRequest = rawDisable !== undefined && rawDisable !== "" && rawDisable !== "0" && rawDisable !== "1";
  return {
    schemaVersion: SHELL_RUNTIME_POLICY_SCHEMA_VERSION,
    hardwareAcceleration: {
      mode: disableRequested ? "disabled-experimental" : "chromium-default",
      experimentalDisableRequested: disableRequested,
      configurationState: disableRequested
        ? "experimental-opt-in"
        : invalidDisableRequest
          ? "invalid-ignored"
          : "default",
    },
    v8Heap: {
      mode: "chromium-managed",
      overrideApplied: false,
    },
    processPriority: {
      mode: "os-default",
      mutationApplied: false,
    },
    chromiumCommandLine: {
      highRiskSwitchesApplied: false,
    },
  };
}

function initializeShellRuntimePolicy({ app, environment = process.env }) {
  if (!app || typeof app !== "object") throw new TypeError("Electron app is required");
  const policy = resolveShellRuntimePolicy(environment);
  if (policy.hardwareAcceleration.experimentalDisableRequested) {
    if (typeof app.disableHardwareAcceleration !== "function") {
      throw new TypeError("Electron hardware acceleration control is unavailable");
    }
    // Electron requires this call before app readiness. It is intentionally reachable
    // only through the exact experimental environment opt-in above.
    app.disableHardwareAcceleration();
  }
  return policy;
}

module.exports = {
  EXPERIMENTAL_DISABLE_HARDWARE_ACCELERATION_ENV,
  SHELL_RUNTIME_POLICY_SCHEMA_VERSION,
  initializeShellRuntimePolicy,
  resolveShellRuntimePolicy,
};
