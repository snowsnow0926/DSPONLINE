"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  NATIVE_BLUEPRINT_ENQUEUE_CONTEXT_CAPABILITY,
  NativeCoreSessionRegistry,
} = require("./native-host.cjs");
const {
  normalizeRendererNativeResult,
} = require("./native-renderer-boundary.cjs");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

function requestContext(overrides = {}) {
  return {
    sessionId: "core-blueprint-enqueue",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    blueprintId: "未知/MOD-蓝图",
    blueprintRevision: 4,
    ...overrides,
  };
}

function projection(overrides = {}) {
  return {
    schemaVersion: 1,
    projectionType: "blueprint-enqueue-context-v1",
    source: "native-core",
    revision: 9,
    stateVersion: 47,
    registryFingerprint: "builtin:test",
    request: {
      expectedRevision: 9,
      expectedRegistryFingerprint: "builtin:test",
      blueprintId: "未知/MOD-蓝图",
      blueprintRevision: 4,
    },
    activePlanetId: "planet-home",
    support: { supported: true, reason: null },
    expectedQueueId: "construction_17",
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

test("blueprint enqueue context is wired through direct, authority, shadow, and transfer paths", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");
  const broker = source("native-player-authority-projection-broker.cjs");
  const boundary = source("native-renderer-boundary.cjs");
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");

  assert.match(main, /function nativeBlueprintEnqueueContextResultContext\(request\)[\s\S]*?sessionId:[\s\S]*?expectedRevision:[\s\S]*?expectedRegistryFingerprint:[\s\S]*?blueprintId:[\s\S]*?blueprintRevision:/);
  assert.match(main, /desktop:native-core-blueprint-enqueue-context"[\s\S]*?coreBlueprintEnqueueContext[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\([\s\S]*?"blueprint-enqueue-context-v1"[\s\S]*?blueprintEnqueueContext\(ownerId, request\)/);
  assert.match(main, /request\.projectionType === "blueprint-enqueue-context-v1"[\s\S]*?blueprintEnqueueContext\(ownerId, normalizedRequest\)/);
  assert.match(preload, /getNativeCoreBlueprintEnqueueContext:[\s\S]*?desktop:native-core-blueprint-enqueue-context/);
  assert.match(preload, /"blueprint-enqueue-context-v1"[\s\S]*?NATIVE_CORE_TRANSFER_PROJECTION_TYPES\.includes/);
  assert.match(broker, /"blueprint-enqueue-context-v1":\s*"blueprintEnqueueContext"/);
  assert.match(boundary, /coreBlueprintEnqueueContext:\s*normalizeCoreBlueprintEnqueueContext/);
  assert.match(desktop, /interface DesktopNativeCoreBlueprintEnqueueContextRequest[\s\S]*?blueprintId:\s*string[\s\S]*?blueprintRevision:\s*number/);
  assert.match(desktop, /projectionType:\s*"blueprint-enqueue-context-v1"[\s\S]*?expectedQueueId:\s*string \| null/);
  assert.match(nativeCore, /blueprintEnqueueContext\([\s\S]*?blueprint-enqueue-context-v1[\s\S]*?DesktopNativeCoreBlueprintEnqueueContextResult/);
});

test("desktop registry forwards only an exact bounded click-time identity", async () => {
  assert.equal(
    NATIVE_BLUEPRINT_ENQUEUE_CONTEXT_CAPABILITY,
    "native-core-blueprint-enqueue-context-v1",
  );
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [NATIVE_BLUEPRINT_ENQUEUE_CONTEXT_CAPABILITY] },
    request(request) {
      calls.push(request);
      return Promise.resolve({ projectionType: "blueprint-enqueue-context-v1", revision: 9 });
    },
  });
  registry.sessions.set("core-blueprint-enqueue", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  await registry.blueprintEnqueueContext(7, requestContext());
  assert.deepEqual(calls, [{
    operation: "coreBlueprintEnqueueContext",
    sessionId: "core-blueprint-enqueue",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    blueprintId: "未知/MOD-蓝图",
    blueprintRevision: 4,
  }]);
  for (const invalid of [
    requestContext({ blueprintId: "bad\nidentifier" }),
    requestContext({ blueprintId: "x".repeat(513) }),
    requestContext({ blueprintId: "bad\ud800id" }),
    requestContext({ blueprintRevision: 0 }),
    requestContext({ blueprintRevision: Number.MAX_SAFE_INTEGER + 1 }),
    requestContext({ expectedRevision: -1 }),
    requestContext({ expectedRegistryFingerprint: "bad fingerprint" }),
    { ...requestContext(), queueId: "construction_17" },
    { ...requestContext(), planetId: "planet-home" },
  ]) {
    assert.throws(
      () => registry.blueprintEnqueueContext(7, invalid),
      /blueprint enqueue context request is invalid/,
    );
  }
});

test("desktop registry fail-closes before IPC when Host lacks the enqueue capability", () => {
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [] },
    request(request) {
      calls.push(request);
      throw new Error("must not reach Host");
    },
  });
  registry.sessions.set("core-blueprint-enqueue", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });

  assert.throws(
    () => registry.blueprintEnqueueContext(7, requestContext()),
    (error) => error?.code === "NATIVE_CORE_CAPABILITY_MISSING",
  );
  assert.deepEqual(calls, []);
});

test("renderer normalizes only the exact supported context and safe derived queue ID", () => {
  const context = requestContext();
  const value = projection();
  const normalized = normalizeRendererNativeResult(
    "coreBlueprintEnqueueContext",
    value,
    context,
  );
  assert.deepEqual(normalized, value);
  assert.notEqual(normalized, value);
  assert.deepEqual(Object.keys(normalized), [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "support", "expectedQueueId",
    "limits",
  ]);
  assert.equal(JSON.stringify(normalized).includes("rotation"), false);
  assert.equal(JSON.stringify(normalized).includes("allowOverlap"), false);
  assert.equal(JSON.stringify(normalized).includes("versionId"), false);
  assert.equal(JSON.stringify(normalized).includes("body"), false);

  const rejects = (candidate, request = context) => assert.throws(
    () => normalizeRendererNativeResult("coreBlueprintEnqueueContext", candidate, request),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejects(value, requestContext({ expectedRevision: 8 }));
  rejects(value, requestContext({ expectedRegistryFingerprint: "builtin:other" }));
  rejects(value, requestContext({ blueprintRevision: 3 }));
  rejects({ ...value, revision: 8 });
  rejects({ ...value, registryFingerprint: "builtin:other" });
  rejects({ ...value, expectedQueueId: "construction_017" });
  rejects({ ...value, expectedQueueId: `construction_${Number.MAX_SAFE_INTEGER}` });
  rejects({ ...value, expectedQueueId: "queue_17" });
  rejects({ ...value, support: { supported: true, reason: "queue-full" } });
  rejects({ ...value, support: { supported: false, reason: "queue-full" } });
  rejects({ ...value, queueId: "construction_17" });
  rejects({ ...value, planetName: "Home" });
  rejects({ ...value, rotation: 0 });
  rejects({ ...value, limits: { ...value.limits, projectionBytes: 1_048_575 } });
  rejects({ ...value, request: { ...value.request, blueprintId: "x".repeat(1_048_576) } });
});

test("all canonical unsupported contexts remain structured and fail closed", () => {
  const reasons = [
    "queue-full",
    "next-id-exhausted",
    "queue-id-collision",
    "unsupported-blueprint-domain",
    "unsupported-active-planet",
    "unsupported-existing-queue-domain",
    "version-conflict",
  ];
  for (const reason of reasons) {
    const value = projection({
      support: { supported: false, reason },
      expectedQueueId: null,
    });
    const normalized = normalizeRendererNativeResult(
      "coreBlueprintEnqueueContext",
      value,
      requestContext(),
    );
    assert.deepEqual(normalized.support, { supported: false, reason });
    assert.equal(normalized.expectedQueueId, null);
  }
  for (const value of [
    projection({ support: { supported: false, reason: "version-limit" }, expectedQueueId: null }),
    projection({ support: { supported: false, reason: null }, expectedQueueId: null }),
    projection({ support: { supported: false, reason: "queue-full" }, expectedQueueId: "construction_17" }),
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult(
        "coreBlueprintEnqueueContext",
        value,
        requestContext(),
      ),
      (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
    );
  }
});
