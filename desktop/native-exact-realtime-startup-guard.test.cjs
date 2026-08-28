"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DISK_LEASE_CORRUPT_CODE,
  DISK_LEASE_UNKNOWN_CODE,
  EXPERIMENTAL_NATIVE_EXACT_REALTIME_ENV,
  HOST_UNAVAILABLE_UNINSPECTED_CODE,
  INSPECTION_FAILED_CODE,
  LEGACY_DISK_LEASE_PRESENT_CODE,
  MAX_RUST_LEASE_BYTES,
  RUST_LEASE_FILE_NAME,
  inspectFixedNativeExactRealtimeLeaseOnDisk,
  inspectNativeExactRealtimeStartup,
  inspectNativeExactRealtimeStartupWithoutHost,
  resolveFixedNativeSaveRootPath,
  statusForInspection,
  unavailableStartupStatus,
} = require("./native-exact-realtime-startup-guard.cjs");
const { PERFORMANCE_EDITION_IDENTITY } = require("./performance-edition-identity.cjs");

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function validPreparedLease() {
  const checkpoint = { generation: 3, rootHash: SHA_C, revision: 7 };
  const proof = { revision: 7, canonicalSha256: SHA_A, domainSha256: SHA_B };
  return {
    schemaVersion: 2,
    kind: "native-core-exact-realtime-experiment-lease-v2",
    phase: "prepared",
    runId: "startup-guard-test",
    mode: "normal",
    slot: "normal-main",
    registryFingerprint: "builtin:test",
    checkpoint,
    entryProof: proof,
    acknowledged: {
      sequence: 0,
      commandId: null,
      revision: 7,
      proof,
      checkpoint,
      settledDeadlineMs: 10_000,
    },
    pendingTick: null,
    pause: null,
    finalization: null,
  };
}

function createDiskFixture(t, { createSlot = false } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-startup-guard-"));
  const userDataPath = path.join(parent, PERFORMANCE_EDITION_IDENTITY.userDataDirectoryName);
  fs.mkdirSync(userDataPath);
  const nativeRootPath = resolveFixedNativeSaveRootPath(userDataPath);
  const slotPath = path.join(nativeRootPath, "authority", "normal-main");
  if (createSlot) fs.mkdirSync(slotPath, { recursive: true });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { nativeRootPath, slotPath, userDataPath };
}

function writeStoredLease(slotPath, lease = validPreparedLease()) {
  const checksum = createHash("sha256").update(JSON.stringify(lease)).digest("hex");
  fs.writeFileSync(
    path.join(slotPath, RUST_LEASE_FILE_NAME),
    `${JSON.stringify({ storageVersion: 2, lease, checksum })}\n`,
    "utf8",
  );
}

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

test("uninspected host-unavailable status fails closed", () => {
  const status = unavailableStartupStatus({});
  assert.equal(status.normalWindowAllowed, false);
  assert.equal(status.state, "host-unavailable-uninspected");
  assert.equal(status.leaseState, "unknown");
  assert.equal(status.code, HOST_UNAVAILABLE_UNINSPECTED_CODE);
});

test("host-unavailable startup is allowed only after the fixed disk root proves lease absence", (t) => {
  const fixture = createDiskFixture(t);
  const inspection = inspectFixedNativeExactRealtimeLeaseOnDisk({
    performanceEditionUserDataPath: fixture.userDataPath,
  });
  assert.deepEqual(inspection, { state: "missing" });

  const status = inspectNativeExactRealtimeStartupWithoutHost({
    performanceEditionUserDataPath: fixture.userDataPath,
    environment: {},
  });
  assert.equal(status.normalWindowAllowed, true);
  assert.equal(status.state, "host-unavailable-no-lease");
  assert.equal(status.leaseState, "missing");
});

test("bounded disk fallback detects a durable Rust lease and blocks normal startup", (t) => {
  const fixture = createDiskFixture(t, { createSlot: true });
  writeStoredLease(fixture.slotPath);
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === "readFileSync") return () => { throw new Error("unbounded read forbidden"); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const inspection = inspectFixedNativeExactRealtimeLeaseOnDisk({
    performanceEditionUserDataPath: fixture.userDataPath,
    fileSystem,
  });
  assert.equal(inspection.state, "present");
  assert.equal(inspection.lease.phase, "prepared");

  const status = inspectNativeExactRealtimeStartupWithoutHost({
    performanceEditionUserDataPath: fixture.userDataPath,
    fileSystem,
    environment: {},
  });
  assert.equal(status.normalWindowAllowed, false);
  assert.equal(status.state, "host-unavailable-recovery-required");
  assert.equal(status.leaseState, "present");
});

test("corrupt, oversized, legacy and unknown disk states all fail closed", (t) => {
  const corrupt = createDiskFixture(t, { createSlot: true });
  fs.writeFileSync(path.join(corrupt.slotPath, RUST_LEASE_FILE_NAME), "{not-json", "utf8");
  assert.deepEqual(inspectFixedNativeExactRealtimeLeaseOnDisk({
    performanceEditionUserDataPath: corrupt.userDataPath,
  }), { state: "corrupt", code: DISK_LEASE_CORRUPT_CODE });

  const oversized = createDiskFixture(t, { createSlot: true });
  fs.writeFileSync(path.join(oversized.slotPath, RUST_LEASE_FILE_NAME), Buffer.alloc(MAX_RUST_LEASE_BYTES + 1));
  assert.deepEqual(inspectFixedNativeExactRealtimeLeaseOnDisk({
    performanceEditionUserDataPath: oversized.userDataPath,
  }), { state: "corrupt", code: DISK_LEASE_CORRUPT_CODE });

  const legacy = createDiskFixture(t, { createSlot: true });
  fs.writeFileSync(path.join(legacy.slotPath, "exact-realtime-lease-v1.json"), "legacy", "utf8");
  assert.deepEqual(inspectFixedNativeExactRealtimeLeaseOnDisk({
    performanceEditionUserDataPath: legacy.userDataPath,
  }), { state: "unknown", code: LEGACY_DISK_LEASE_PRESENT_CODE });

  const unknown = createDiskFixture(t);
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === "lstatSync") return (targetPath) => {
        if (targetPath === unknown.nativeRootPath) {
          const error = new Error("access denied");
          error.code = "EACCES";
          throw error;
        }
        return fs.lstatSync(targetPath);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const unknownStatus = inspectNativeExactRealtimeStartupWithoutHost({
    performanceEditionUserDataPath: unknown.userDataPath,
    fileSystem,
    environment: {},
  });
  assert.equal(unknownStatus.normalWindowAllowed, false);
  assert.equal(unknownStatus.leaseState, "unknown");
  assert.equal(unknownStatus.code, DISK_LEASE_UNKNOWN_CODE);
});

test("disk fallback accepts no arbitrary native root or renderer-selected path", (t) => {
  const fixture = createDiskFixture(t);
  assert.throws(() => inspectFixedNativeExactRealtimeLeaseOnDisk({
    performanceEditionUserDataPath: path.dirname(fixture.userDataPath),
  }), /fixed performance-edition/);
  assert.throws(() => inspectFixedNativeExactRealtimeLeaseOnDisk({
    performanceEditionUserDataPath: fixture.userDataPath,
    path: "C:\\renderer-selected",
  }), /unknown field/);
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
  assert.match(source, /resolveFixedNativeSaveRootPath\(performanceEditionRuntimeIdentity\.userDataPath\)/);
  assert.match(source, /nativeExactRealtimeStartupStatus = inspectWithoutHost\(\)/);
  assert.doesNotMatch(source, /inspectNativeExactRealtimeStartupWithoutHost\([^)]*(?:request|event|sender)/);
  const failedHostStop = source.indexOf("await failedNativeHostClient.stop();");
  const diskFallback = source.indexOf("nativeExactRealtimeStartupStatus = inspectWithoutHost();", failedHostStop);
  assert.ok(failedHostStop > hello, "a failed or incompatible host must be stopped before fallback inspection");
  assert.ok(diskFallback > failedHostStop, "disk absence must be proven only after the failed host stops");
});
