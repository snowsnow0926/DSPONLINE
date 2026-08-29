"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  NATIVE_CONSTRUCTION_REMOVAL_CONTEXT_CAPABILITY,
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
    sessionId: "core-removal",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    entityId: "MOD/设备-一",
    ...overrides,
  };
}

function supportedProjection(overrides = {}) {
  return {
    schemaVersion: 1,
    projectionType: "construction-removal-context-v1",
    source: "native-core",
    revision: 9,
    stateVersion: 47,
    registryFingerprint: "builtin:test",
    request: {
      expectedRevision: 9,
      expectedRegistryFingerprint: "builtin:test",
      entityId: "MOD/设备-一",
    },
    activePlanetId: "home",
    entityId: "MOD/设备-一",
    buildingId: "MOD/custom-machine",
    machineCount: 2,
    currentConstruction: 4,
    refundAfterRemoval: 6,
    support: { supported: true, reason: null },
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

function unsupportedProjection(reason, overrides = {}) {
  return supportedProjection({
    refundAfterRemoval: null,
    support: { supported: false, reason },
    ...overrides,
  });
}

test("construction removal context is wired through direct, brokered, and transfer IPC", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");
  const broker = source("native-player-authority-projection-broker.cjs");
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");

  assert.match(main, /function nativeConstructionRemovalContextResultContext\(request\)[\s\S]*?sessionId:[\s\S]*?expectedRevision:[\s\S]*?expectedRegistryFingerprint:[\s\S]*?entityId:/);
  assert.match(main, /desktop:native-core-construction-removal-context"[\s\S]*?coreConstructionRemovalContext[\s\S]*?constructionRemovalContext\(ownerId, request\)/);
  assert.match(main, /request\.projectionType === "construction-removal-context-v1"[\s\S]*?constructionRemovalContext\(ownerId, normalizedRequest\)/);
  assert.match(preload, /getNativeCoreConstructionRemovalContext:[\s\S]*?desktop:native-core-construction-removal-context/);
  assert.match(preload, /"construction-removal-context-v1"[\s\S]*?NATIVE_CORE_TRANSFER_PROJECTION_TYPES\.includes/);
  assert.match(broker, /"construction-removal-context-v1":\s*"constructionRemovalContext"/);
  assert.match(desktop, /interface DesktopNativeCoreConstructionRemovalContextRequest[\s\S]*?entityId:\s*string/);
  assert.match(desktop, /projectionType:\s*"construction-removal-context-v1"[\s\S]*?refundAfterRemoval:\s*number \| null/);
  assert.match(nativeCore, /constructionRemovalContext\([\s\S]*?construction-removal-context-v1[\s\S]*?DesktopNativeCoreConstructionRemovalContextResult/);
});

test("desktop registry forwards only an exact, bounded, Unicode-safe removal request", async () => {
  assert.equal(
    NATIVE_CONSTRUCTION_REMOVAL_CONTEXT_CAPABILITY,
    "native-core-construction-removal-context-v1",
  );
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    request(request) {
      calls.push(request);
      return Promise.resolve({ projectionType: "construction-removal-context-v1", revision: 9 });
    },
  });
  registry.sessions.set("core-removal", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  await registry.constructionRemovalContext(7, requestContext());
  assert.deepEqual(calls, [{
    operation: "coreConstructionRemovalContext",
    sessionId: "core-removal",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    entityId: "MOD/设备-一",
  }]);
  for (const invalid of [
    requestContext({ entityId: "bad\nidentifier" }),
    requestContext({ entityId: "界".repeat(171) }),
    requestContext({ entityId: "bad\ud800id" }),
    requestContext({ expectedRegistryFingerprint: "bad fingerprint" }),
    { ...requestContext(), path: "C:\\secret" },
  ]) {
    assert.throws(
      () => registry.constructionRemovalContext(7, invalid),
      /construction removal context request is invalid/,
    );
  }
});

test("renderer accepts an exact refund and fail-closes stale, drifted, or forged contexts", () => {
  const context = requestContext();
  const projection = supportedProjection();
  const normalized = normalizeRendererNativeResult(
    "coreConstructionRemovalContext",
    projection,
    context,
  );
  assert.deepEqual(normalized, projection);
  assert.notEqual(normalized, projection);

  const rejects = (value, request = context) => assert.throws(
    () => normalizeRendererNativeResult("coreConstructionRemovalContext", value, request),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejects(projection, requestContext({ expectedRevision: 8 }));
  rejects(projection, requestContext({ expectedRegistryFingerprint: "builtin:other" }));
  rejects(projection, requestContext({ entityId: "other-entity" }));
  rejects({ ...projection, revision: 8 });
  rejects({ ...projection, registryFingerprint: "builtin:other" });
  rejects({ ...projection, entityId: "other-entity" });
  rejects({ ...projection, refundAfterRemoval: 7 });
  rejects({ ...projection, support: { supported: false, reason: "incident-belt" } });
  rejects({ ...projection, path: "C:\\secret" });
  rejects({ ...projection, limits: { projectionBytes: 1_048_575 } });
  rejects(unsupportedProjection("refund-overflow", {
    currentConstruction: Number.MAX_SAFE_INTEGER - 2,
    machineCount: 1,
  }));
});

test("renderer preserves explicit fail-closed reasons and nullable unavailable facts", () => {
  const cases = [
    unsupportedProjection("entity-not-found", {
      buildingId: null,
      machineCount: null,
      currentConstruction: null,
    }),
    unsupportedProjection("not-active-planet"),
    unsupportedProjection("interaction-locked"),
    unsupportedProjection("unsupported-building-kind"),
    unsupportedProjection("unsupported-building-domain"),
    unsupportedProjection("buffered-material"),
    unsupportedProjection("spray-coater-installed"),
    unsupportedProjection("incident-belt"),
    unsupportedProjection("construction-queue-reference"),
    unsupportedProjection("blueprint-pruning-required"),
    unsupportedProjection("invalid-construction-inventory", {
      currentConstruction: null,
    }),
    unsupportedProjection("refund-overflow", {
      currentConstruction: Number.MAX_SAFE_INTEGER,
      machineCount: 1,
    }),
  ];
  for (const projection of cases) {
    const result = normalizeRendererNativeResult(
      "coreConstructionRemovalContext",
      projection,
      requestContext(),
    );
    assert.equal(result.support.supported, false);
    assert.equal(result.support.reason, projection.support.reason);
    assert.equal(result.refundAfterRemoval, null);
  }
});
