"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  EXPERIMENTAL_NATIVE_EXACT_REALTIME_ENV,
  INSPECTION_FAILED_CODE,
  inspectNativeExactRealtimeStartup,
  statusForInspection,
  unavailableStartupStatus,
} = require("./native-exact-realtime-startup-guard.cjs");

test("missing lease preserves normal startup for default, disabled, and invalid lab settings", () => {
  for (const [raw, expectedConfiguration, expectedLabRequested] of [
    [undefined, "default", false],
    ["", "default", false],
    ["0", "default", false],
    ["1", "experimental-opt-in", true],
    ["invalid", "invalid-ignored", false],
  ]) {
    const environment = raw === undefined ? {} : { [EXPERIMENTAL_NATIVE_EXACT_REALTIME_ENV]: raw };
    const status = statusForInspection({ state: "missing" }, environment);
    assert.equal(status.normalWindowAllowed, true);
    assert.equal(status.state, "inactive");
    assert.equal(status.leaseState, "missing");
    assert.equal(status.labRequested, expectedLabRequested);
    assert.equal(status.configurationState, expectedConfiguration);
  }
});

test("valid lease blocks normal startup even when the lab flag is absent", async () => {
  const status = await inspectNativeExactRealtimeStartup({
    leaseStore: { inspect: async () => ({ state: "valid", lease: { phase: "active" } }) },
    environment: {},
  });
  assert.equal(status.normalWindowAllowed, false);
  assert.equal(status.state, "recovery-required");
  assert.equal(status.leaseState, "valid");
  assert.equal(status.leasePhase, "active");
  assert.equal(status.labRequested, false);
});

test("blocked lease and inspection failure both fail closed regardless of the lab flag", async () => {
  const environment = { [EXPERIMENTAL_NATIVE_EXACT_REALTIME_ENV]: "1" };
  const blocked = await inspectNativeExactRealtimeStartup({
    leaseStore: { inspect: async () => ({ state: "blocked", code: "LEASE_CHECKSUM_INVALID" }) },
    environment,
  });
  assert.equal(blocked.normalWindowAllowed, false);
  assert.equal(blocked.code, "LEASE_CHECKSUM_INVALID");
  assert.equal(blocked.labRequested, true);

  const failed = await inspectNativeExactRealtimeStartup({
    leaseStore: { inspect: async () => { throw new Error("private host detail"); } },
    environment: {},
  });
  assert.equal(failed.normalWindowAllowed, false);
  assert.equal(failed.code, INSPECTION_FAILED_CODE);
  assert.doesNotMatch(failed.message, /private host detail/);
});

test("host-unavailable status preserves the existing JavaScript startup path", () => {
  const status = unavailableStartupStatus({});
  assert.equal(status.normalWindowAllowed, true);
  assert.equal(status.state, "host-unavailable");
  assert.equal(status.leaseState, "unavailable");
});

test("Electron main inspects after host hello and blocks before creating the normal window", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const hello = source.indexOf("await nativeHostClient.start(app.getVersion())");
  const inspection = source.indexOf("await inspectNativeExactRealtimeStartup(");
  const startupGuard = source.indexOf("if (!nativeExactRealtimeStartupStatus.normalWindowAllowed)");
  const normalWindow = source.indexOf("createWindow();", startupGuard);
  assert.ok(hello >= 0, "native host hello must remain explicit");
  assert.ok(inspection > hello, "lease inspection must follow the authenticated host hello");
  assert.ok(startupGuard > inspection, "startup guard must consume the completed lease inspection");
  assert.ok(normalWindow > startupGuard, "normal window creation must remain behind the guard");
});
