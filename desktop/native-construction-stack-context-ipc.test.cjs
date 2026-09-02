"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  NATIVE_CONSTRUCTION_STACK_CONTEXT_CAPABILITY,
  NativeCoreSessionRegistry,
} = require("./native-host.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

function requestContext(overrides = {}) {
  return {
    sessionId: "core-stack",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    entityId: "MOD/设备-一",
    targetCount: 15,
    ...overrides,
  };
}

function supportedProjection(overrides = {}) {
  return {
    schemaVersion: 1,
    projectionType: "construction-stack-context-v1",
    source: "native-core",
    sessionId: "core-stack",
    revision: 9,
    stateVersion: 47,
    registryFingerprint: "builtin:test",
    request: {
      sessionId: "core-stack",
      expectedRevision: 9,
      expectedRegistryFingerprint: "builtin:test",
      entityId: "MOD/设备-一",
      targetCount: 15,
    },
    activePlanetId: "home",
    entityId: "MOD/设备-一",
    buildingId: "MOD/custom-machine",
    currentCount: 5,
    targetCount: 15,
    currentConstruction: 20,
    constructionAfter: 10,
    support: { supported: true, reason: null },
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

function unsupportedProjection(reason, overrides = {}) {
  return supportedProjection({
    constructionAfter: null,
    support: { supported: false, reason },
    ...overrides,
  });
}

test("construction stack context is wired through direct, brokered, and transfer IPC", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");
  const broker = source("native-player-authority-projection-broker.cjs");
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");

  assert.match(main, /function nativeConstructionStackContextResultContext\(request\)[\s\S]*?sessionId:[\s\S]*?expectedRevision:[\s\S]*?expectedRegistryFingerprint:[\s\S]*?entityId:[\s\S]*?targetCount:/);
  assert.match(main, /desktop:native-core-construction-stack-context"[\s\S]*?coreConstructionStackContext[\s\S]*?constructionStackContext\(ownerId, request\)/);
  assert.match(main, /request\.projectionType === "construction-stack-context-v1"[\s\S]*?constructionStackContext\(ownerId, normalizedRequest\)/);
  assert.match(preload, /getNativeCoreConstructionStackContext:[\s\S]*?desktop:native-core-construction-stack-context/);
  assert.match(preload, /"construction-stack-context-v1"[\s\S]*?NATIVE_CORE_TRANSFER_PROJECTION_TYPES\.includes/);
  assert.match(broker, /"construction-stack-context-v1":\s*"constructionStackContext"/);
  assert.match(desktop, /interface DesktopNativeCoreConstructionStackContextRequest[\s\S]*?entityId:\s*string;[\s\S]*?targetCount:\s*number/);
  assert.match(desktop, /projectionType:\s*"construction-stack-context-v1"[\s\S]*?constructionAfter:\s*number \| null/);
  assert.match(nativeCore, /constructionStackContext\([\s\S]*?construction-stack-context-v1[\s\S]*?DesktopNativeCoreConstructionStackContextResult/);
});

test("desktop registry forwards only an exact safe-integer target request", async () => {
  assert.equal(
    NATIVE_CONSTRUCTION_STACK_CONTEXT_CAPABILITY,
    "native-core-construction-stack-context-v1",
  );
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    request(request) {
      calls.push(request);
      return Promise.resolve({ projectionType: "construction-stack-context-v1", revision: 9 });
    },
  });
  registry.sessions.set("core-stack", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  await registry.constructionStackContext(7, requestContext());
  assert.deepEqual(calls, [{
    operation: "coreConstructionStackContext",
    sessionId: "core-stack",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    entityId: "MOD/设备-一",
    targetCount: 15,
  }]);
  for (const invalid of [
    requestContext({ entityId: "bad\nidentifier" }),
    requestContext({ targetCount: 0 }),
    requestContext({ targetCount: 1.5 }),
    requestContext({ targetCount: Number.MAX_SAFE_INTEGER + 1 }),
    requestContext({ expectedRegistryFingerprint: "bad fingerprint" }),
    { ...requestContext(), path: "C:\\secret" },
  ]) {
    assert.throws(
      () => registry.constructionStackContext(7, invalid),
      /construction stack context request is invalid/,
    );
  }
});

test("renderer binds session revision registry entity target and exact material delta", () => {
  const context = requestContext();
  const projection = supportedProjection();
  const normalized = normalizeRendererNativeResult("coreConstructionStackContext", projection, context);
  assert.deepEqual(normalized, projection);
  assert.notEqual(normalized, projection);

  const rejects = (value, request = context) => assert.throws(
    () => normalizeRendererNativeResult("coreConstructionStackContext", value, request),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejects(projection, requestContext({ sessionId: "other-session" }));
  rejects(projection, requestContext({ expectedRevision: 8 }));
  rejects(projection, requestContext({ expectedRegistryFingerprint: "builtin:other" }));
  rejects(projection, requestContext({ entityId: "other-entity" }));
  rejects(projection, requestContext({ targetCount: 16 }));
  rejects({ ...projection, sessionId: "other-session" });
  rejects({ ...projection, targetCount: 16 });
  rejects({ ...projection, constructionAfter: 11 });
  rejects({ ...projection, support: { supported: false, reason: "stack-limit" } });
  rejects({ ...projection, path: "C:\\secret" });
  rejects({ ...projection, limits: { projectionBytes: 1_048_575 } });

  const decreaseContext = requestContext({ targetCount: 1 });
  const decrease = supportedProjection({
    request: { ...supportedProjection().request, targetCount: 1 },
    targetCount: 1,
    constructionAfter: 24,
  });
  assert.equal(
    normalizeRendererNativeResult("coreConstructionStackContext", decrease, decreaseContext)
      .constructionAfter,
    24,
  );
});

test("renderer preserves fail-closed reasons including historical over-limit semantics", () => {
  const cases = [
    unsupportedProjection("entity-not-found", {
      buildingId: null,
      currentCount: null,
      currentConstruction: null,
    }),
    unsupportedProjection("not-active-planet"),
    unsupportedProjection("interaction-locked"),
    unsupportedProjection("unsupported-building-kind"),
    unsupportedProjection("catalog-incomplete"),
    unsupportedProjection("inventory-insufficient", { currentConstruction: 9 }),
    unsupportedProjection("stack-limit"),
    unsupportedProjection("unchanged-target", {
      request: { ...supportedProjection().request, targetCount: 5 },
      currentCount: 5,
      targetCount: 5,
    }),
    unsupportedProjection("invalid-construction-inventory", {
      currentConstruction: null,
    }),
    unsupportedProjection("refund-overflow", {
      request: { ...supportedProjection().request, targetCount: 1 },
      currentConstruction: Number.MAX_SAFE_INTEGER,
      targetCount: 1,
    }),
  ];
  for (const projection of cases) {
    const result = normalizeRendererNativeResult(
      "coreConstructionStackContext",
      projection,
      requestContext({ targetCount: projection.targetCount }),
    );
    assert.equal(result.support.supported, false);
    assert.equal(result.support.reason, projection.support.reason);
    assert.equal(result.constructionAfter, null);
  }
});
