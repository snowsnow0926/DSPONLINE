"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  NATIVE_EXACT_REALTIME_LEASE_CAPABILITY,
  NATIVE_EXACT_REALTIME_WRITER_FENCE_CAPABILITY,
  NativeCoreSessionRegistry,
  NativeExactRealtimeLeaseRegistry,
  normalizeNativeExactRealtimeLeaseRequest,
} = require("./native-host.cjs");
const {
  NativeCoreExactRealtimeRustLeaseStore,
} = require("./native-core-exact-realtime-experiment.cjs");

const SHA = "a".repeat(64);

function client(capabilities = [
  NATIVE_EXACT_REALTIME_LEASE_CAPABILITY,
  NATIVE_EXACT_REALTIME_WRITER_FENCE_CAPABILITY,
]) {
  const requests = [];
  return {
    hello: { capabilities },
    requests,
    async request(value) {
      requests.push(value);
      return { accepted: true };
    },
  };
}

test("lease bridge accepts only the fixed Rust action schema and no path or raw ACK", () => {
  assert.deepEqual(normalizeNativeExactRealtimeLeaseRequest({ action: "inspect" }), { action: "inspect" });
  assert.deepEqual(normalizeNativeExactRealtimeLeaseRequest({
    action: "stageExactTick",
    runId: "run-1",
    registryFingerprint: "builtin:test",
    sequence: 1,
    commandId: "e1:derived:tick:1",
    baseRevision: 7,
    expectedRevision: 8,
    simulationSeconds: 1,
    wallSeconds: 1,
    settledDeadlineMs: 11_000,
  }).expectedRevision, 8);
  assert.throws(
    () => normalizeNativeExactRealtimeLeaseRequest({ action: "inspect", path: "C:\\renderer" }),
    /invalid/,
  );
  assert.throws(
    () => normalizeNativeExactRealtimeLeaseRequest({ action: "acknowledgeExactTick" }),
    /not allowed/,
  );
});

test("old host capability is a hard No-Go and never receives a lease request", async () => {
  const oldClient = client([]);
  const registry = new NativeExactRealtimeLeaseRegistry(oldClient);
  const store = new NativeCoreExactRealtimeRustLeaseStore({ leaseRegistry: registry });
  await assert.rejects(async () => store.inspect(), (error) => {
    assert.equal(error.code, "NATIVE_CORE_EXACT_REALTIME_RUST_LEASE_UNAVAILABLE");
    return true;
  });
  assert.deepEqual(oldClient.requests, []);
});

test("capable lease bridge forwards the normalized operation without filesystem input", async () => {
  const capableClient = client();
  const registry = new NativeExactRealtimeLeaseRegistry(capableClient);
  await registry.request({
    action: "prepare",
    runId: "run-1",
    registryFingerprint: "builtin:test",
    checkpoint: { generation: 3, rootHash: SHA, revision: 7 },
    proof: { revision: 7, canonicalSha256: SHA, domainSha256: SHA },
    settledDeadlineMs: 10_000,
  });
  assert.deepEqual(capableClient.requests, [{
    operation: "exactRealtimeLease",
    request: {
      action: "prepare",
      runId: "run-1",
      registryFingerprint: "builtin:test",
      checkpoint: { generation: 3, rootHash: SHA, revision: 7 },
      proof: { revision: 7, canonicalSha256: SHA, domainSha256: SHA },
      settledDeadlineMs: 10_000,
    },
  }]);
});

test("exact commit bridge is capability-gated, identity-only, and absent from renderer IPC", async () => {
  const capableClient = client();
  const registry = new NativeCoreSessionRegistry(capableClient);
  registry.sessions.set("core-1", { ownerId: "main-owner", slot: "normal-main" });
  await registry.commitOperationExactRealtime("main-owner", {
    sessionId: "core-1",
    runId: "run-1",
    registryFingerprint: "builtin:test",
  });
  assert.deepEqual(capableClient.requests, [{
    operation: "coreCommitOperationExactRealtime",
    sessionId: "core-1",
    request: {
      runId: "run-1",
      registryFingerprint: "builtin:test",
    },
  }]);
  assert.throws(() => registry.commitOperationExactRealtime("main-owner", {
    sessionId: "core-1",
    runId: "run-1",
    registryFingerprint: "builtin:test",
    commandId: "renderer-selected-command",
  }), /invalid/);

  const oldClient = client([NATIVE_EXACT_REALTIME_LEASE_CAPABILITY]);
  const oldRegistry = new NativeCoreSessionRegistry(oldClient);
  oldRegistry.sessions.set("core-1", { ownerId: "main-owner", slot: "normal-main" });
  assert.throws(() => oldRegistry.commitOperationExactRealtime("main-owner", {
    sessionId: "core-1",
    runId: "run-1",
    registryFingerprint: "builtin:test",
  }), (error) => {
    assert.equal(error.code, "NATIVE_CORE_EXACT_REALTIME_WRITER_FENCE_UNAVAILABLE");
    return true;
  });
  assert.deepEqual(oldClient.requests, []);

  for (const file of ["main.cjs", "preload.cjs"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.doesNotMatch(source, /coreCommitOperationExactRealtime|commitOperationExactRealtime/);
  }
});

test("core checkpoint ACK bridge exposes no caller-supplied proof or checkpoint", async () => {
  const capableClient = client();
  const registry = new NativeCoreSessionRegistry(capableClient);
  registry.sessions.set("core-1", { ownerId: "main-owner", slot: "normal-main" });
  await registry.checkpointAndAcknowledgeExactRealtime("main-owner", {
    sessionId: "core-1",
    runId: "run-1",
    registryFingerprint: "builtin:test",
    sequence: 1,
    commandId: "e1:derived:tick:1",
    settledDeadlineMs: 11_000,
  });
  assert.deepEqual(capableClient.requests, [{
    operation: "coreCheckpointAcknowledgeExactRealtime",
    sessionId: "core-1",
    request: {
      runId: "run-1",
      registryFingerprint: "builtin:test",
      sequence: 1,
      commandId: "e1:derived:tick:1",
      settledDeadlineMs: 11_000,
    },
  }]);
  assert.throws(() => registry.checkpointAndAcknowledgeExactRealtime("main-owner", {
    sessionId: "core-1",
    runId: "run-1",
    registryFingerprint: "builtin:test",
    sequence: 1,
    commandId: "e1:derived:tick:1",
    settledDeadlineMs: 11_000,
    proof: { revision: 8, canonicalSha256: SHA, domainSha256: SHA },
  }), /invalid/);

  capableClient.requests.length = 0;
  await registry.checkpointExactRealtimeFinalization("main-owner", {
    sessionId: "core-1",
    runId: "run-1",
    registryFingerprint: "builtin:test",
    savedAtMs: 11_000,
  });
  assert.deepEqual(capableClient.requests, [{
    operation: "coreCheckpointExactRealtimeFinalization",
    sessionId: "core-1",
    request: {
      runId: "run-1",
      registryFingerprint: "builtin:test",
      savedAtMs: 11_000,
    },
  }]);
});
