"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  NATIVE_BLUEPRINT_CAPTURE_CONTEXT_CAPABILITY,
  NativeCoreSessionRegistry,
} = require("./native-host.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

function requestContext(overrides = {}) {
  return {
    sessionId: "core-blueprint-capture",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    entityIds: ["entity-z", "实体-β", "entity-a"],
    ...overrides,
  };
}

function projection(overrides = {}) {
  return {
    schemaVersion: 1,
    projectionType: "blueprint-capture-context-v1",
    source: "native-core",
    revision: 9,
    stateVersion: 47,
    registryFingerprint: "builtin:test",
    request: {
      expectedRevision: 9,
      expectedRegistryFingerprint: "builtin:test",
      entityIds: ["entity-z", "实体-β", "entity-a"],
    },
    activePlanetId: "planet-home",
    support: { supported: true, reason: null },
    expectedBlueprintId: "blueprint_17",
    expectedBlueprintName: "蓝图 08",
    expectedBlueprintRevision: 1,
    limits: {
      selectionEntityIds: 512,
      blueprintEntities: 512,
      blueprintBelts: 1_024,
      opaqueIdBytes: 512,
      projectionBytes: 1_048_576,
    },
    ...overrides,
  };
}

test("blueprint capture context is wired through direct, authority, shadow, and transfer paths", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");
  const broker = source("native-player-authority-projection-broker.cjs");
  const boundary = source("native-renderer-boundary.cjs");
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");

  assert.match(main, /function nativeBlueprintCaptureContextResultContext\(request\)[\s\S]*?sessionId:[\s\S]*?expectedRevision:[\s\S]*?expectedRegistryFingerprint:[\s\S]*?entityIds:/);
  assert.match(main, /desktop:native-core-blueprint-capture-context"[\s\S]*?coreBlueprintCaptureContext[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\([\s\S]*?"blueprint-capture-context-v1"[\s\S]*?blueprintCaptureContext\(ownerId, request\)/);
  assert.match(main, /request\.projectionType === "blueprint-capture-context-v1"[\s\S]*?blueprintCaptureContext\(ownerId, normalizedRequest\)/);
  assert.match(preload, /getNativeCoreBlueprintCaptureContext:\s*invokeNativeBlueprintCaptureContext/);
  assert.match(preload, /function invokeNativeBlueprintCaptureContext[\s\S]*?desktop:native-core-blueprint-capture-context/);
  assert.match(broker, /"blueprint-capture-context-v1":\s*"blueprintCaptureContext"/);
  assert.match(boundary, /coreBlueprintCaptureContext:\s*normalizeCoreBlueprintCaptureContext/);
  assert.match(desktop, /interface DesktopNativeCoreBlueprintCaptureContextRequest[\s\S]*?entityIds:\s*string\[\]/);
  assert.match(nativeCore, /blueprintCaptureContext\([\s\S]*?blueprint-capture-context-v1[\s\S]*?DesktopNativeCoreBlueprintCaptureContextResult/);
});

test("desktop registry forwards only the exact ordered entity selection", async () => {
  assert.equal(
    NATIVE_BLUEPRINT_CAPTURE_CONTEXT_CAPABILITY,
    "native-core-blueprint-capture-context-v1",
  );
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [NATIVE_BLUEPRINT_CAPTURE_CONTEXT_CAPABILITY] },
    request(request) {
      calls.push(request);
      return Promise.resolve({ projectionType: "blueprint-capture-context-v1", revision: 9 });
    },
  });
  registry.sessions.set("core-blueprint-capture", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  await registry.blueprintCaptureContext(7, requestContext());
  assert.deepEqual(calls, [{
    operation: "coreBlueprintCaptureContext",
    sessionId: "core-blueprint-capture",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    entityIds: ["entity-z", "实体-β", "entity-a"],
  }]);

  for (const invalid of [
    requestContext({ entityIds: [] }),
    requestContext({ entityIds: ["entity-a", "entity-a"] }),
    requestContext({ entityIds: ["bad\nidentifier"] }),
    requestContext({ entityIds: Array.from({ length: 513 }, (_, index) => `entity-${index}`) }),
    requestContext({ entityIds: "entity-a" }),
    { ...requestContext(), entities: [] },
    { ...requestContext(), inventory: {} },
    { ...requestContext(), nextId: 18 },
  ]) {
    assert.throws(
      () => registry.blueprintCaptureContext(7, invalid),
      /blueprint capture context request is invalid/,
    );
  }
});

test("desktop registry fail-closes before IPC when Host lacks capture capability", () => {
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [] },
    request(request) {
      calls.push(request);
      throw new Error("must not reach Host");
    },
  });
  registry.sessions.set("core-blueprint-capture", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  assert.throws(
    () => registry.blueprintCaptureContext(7, requestContext()),
    (error) => error?.code === "NATIVE_CORE_CAPABILITY_MISSING",
  );
  assert.deepEqual(calls, []);
});

test("renderer accepts only the exact bounded capture context without entity bodies", () => {
  const context = requestContext();
  const value = projection();
  const normalized = normalizeRendererNativeResult("coreBlueprintCaptureContext", value, context);
  assert.deepEqual(normalized, value);
  assert.notEqual(normalized, value);
  const body = JSON.stringify(normalized);
  for (const forbidden of ["entities", "belts", "inventory", "materials", "nextId", "body"]) {
    assert.equal(body.includes(`"${forbidden}"`), false);
  }

  const rejects = (candidate, request = context) => assert.throws(
    () => normalizeRendererNativeResult("coreBlueprintCaptureContext", candidate, request),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejects(value, requestContext({ entityIds: ["entity-a", "实体-β", "entity-z"] }));
  rejects(value, requestContext({ entityIds: ["entity-z", "实体-β"] }));
  rejects({ ...value, request: { ...value.request, entityIds: ["entity-z", "entity-a", "实体-β"] } });
  rejects({ ...value, request: { ...value.request, entityIds: ["entity-z", "实体-β", "entity-a", "x"] } });
  rejects({ ...value, support: { supported: true, reason: "selection-conflict" } });
  rejects({ ...value, expectedBlueprintId: "blueprint_017" });
  rejects({ ...value, expectedBlueprintName: "Blueprint 08" });
  rejects({ ...value, expectedBlueprintRevision: 2 });
  rejects({ ...value, inventory: {} });
  rejects({ ...value, limits: { ...value.limits, selectionEntityIds: 511 } });
  rejects({ ...value, request: { ...value.request, entityIds: ["x".repeat(1_048_576)] } });
});

test("all canonical unsupported capture reasons require null expected fields", () => {
  const reasons = [
    "selection-conflict",
    "unsupported-active-planet",
    "unsupported-blueprint-domain",
    "catalog-incomplete",
    "position-overlap",
    "library-full",
    "next-id-exhausted",
  ];
  for (const reason of reasons) {
    const normalized = normalizeRendererNativeResult(
      "coreBlueprintCaptureContext",
      projection({
        support: { supported: false, reason },
        expectedBlueprintId: null,
        expectedBlueprintName: null,
        expectedBlueprintRevision: null,
      }),
      requestContext(),
    );
    assert.deepEqual(normalized.support, { supported: false, reason });
  }
  for (const candidate of [
    projection({
      support: { supported: false, reason: "version-conflict" },
      expectedBlueprintId: null,
      expectedBlueprintName: null,
      expectedBlueprintRevision: null,
    }),
    projection({
      support: { supported: false, reason: null },
      expectedBlueprintId: null,
      expectedBlueprintName: null,
      expectedBlueprintRevision: null,
    }),
    projection({ support: { supported: false, reason: "library-full" } }),
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult("coreBlueprintCaptureContext", candidate, requestContext()),
      (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
    );
  }
});
