"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  EXPERIMENTAL_DISABLE_HARDWARE_ACCELERATION_ENV,
  initializeShellRuntimePolicy,
  resolveShellRuntimePolicy,
} = require("./shell-runtime-policy.cjs");

function testApp() {
  const calls = [];
  return {
    calls,
    disableHardwareAcceleration() {
      calls.push("disableHardwareAcceleration");
    },
    commandLine: {
      appendSwitch() {
        throw new Error("shell runtime policy must not append Chromium switches");
      },
    },
  };
}

test("default policy leaves Chromium hardware acceleration enabled and applies no risky tuning", () => {
  const app = testApp();
  const policy = initializeShellRuntimePolicy({ app, environment: {} });

  assert.deepEqual(app.calls, []);
  assert.deepEqual(policy, {
    schemaVersion: 1,
    hardwareAcceleration: {
      mode: "chromium-default",
      experimentalDisableRequested: false,
      configurationState: "default",
    },
    v8Heap: { mode: "chromium-managed", overrideApplied: false },
    processPriority: { mode: "os-default", mutationApplied: false },
    chromiumCommandLine: { highRiskSwitchesApplied: false },
  });
});

test("hardware acceleration can be disabled only by the exact experimental opt-in", () => {
  const app = testApp();
  const policy = initializeShellRuntimePolicy({
    app,
    environment: { [EXPERIMENTAL_DISABLE_HARDWARE_ACCELERATION_ENV]: "1" },
  });

  assert.deepEqual(app.calls, ["disableHardwareAcceleration"]);
  assert.equal(policy.hardwareAcceleration.mode, "disabled-experimental");
  assert.equal(policy.hardwareAcceleration.configurationState, "experimental-opt-in");
});

test("ambiguous hardware acceleration values are ignored instead of becoming hidden flags", () => {
  for (const value of ["true", "yes", "-1", " 1 "]) {
    const app = testApp();
    const policy = initializeShellRuntimePolicy({
      app,
      environment: { [EXPERIMENTAL_DISABLE_HARDWARE_ACCELERATION_ENV]: value },
    });
    assert.deepEqual(app.calls, []);
    assert.equal(policy.hardwareAcceleration.mode, "chromium-default");
    assert.equal(policy.hardwareAcceleration.configurationState, "invalid-ignored");
  }
});

test("zero and empty experimental values retain the default without reporting invalid configuration", () => {
  for (const value of ["0", ""]) {
    const policy = resolveShellRuntimePolicy({
      [EXPERIMENTAL_DISABLE_HARDWARE_ACCELERATION_ENV]: value,
    });
    assert.equal(policy.hardwareAcceleration.mode, "chromium-default");
    assert.equal(policy.hardwareAcceleration.configurationState, "default");
  }
});

test("desktop entrypoint applies policy before readiness and exposes only trusted no-argument diagnostics", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const policyOffset = mainSource.indexOf("initializeShellRuntimePolicy({ app, environment: process.env })");
  const readyOffset = mainSource.indexOf("app.whenReady()");

  assert.ok(policyOffset >= 0 && readyOffset > policyOffset, "shell policy must be resolved before app readiness");
  assert.match(mainSource, /ipcMain\.handle\("desktop:runtime-diagnostics", async \(event\) => \{\s+if \(!trustedSender\(event\)\)/);
  assert.match(mainSource, /return runtimeDiagnosticsSampler\.sample\(\);/);
  assert.match(preloadSource, /getRuntimeDiagnostics: \(\) => ipcRenderer\.invoke\("desktop:runtime-diagnostics"\)/);
  for (const forbidden of ["appendSwitch", "setPriority", "max-old-space-size", "--js-flags", "--disable-gpu"]) {
    assert.equal(mainSource.includes(forbidden), false, forbidden);
  }
});
