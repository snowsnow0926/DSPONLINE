"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  NATIVE_BLUEPRINT_DIRECT_DEPLOY_CONTEXT_CAPABILITY,
  NativeCoreSessionRegistry,
} = require("./native-host.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

function requestContext(overrides = {}) {
  return {
    sessionId: "core-blueprint-direct",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    blueprintId: "ordinary-blueprint",
    blueprintRevision: 4,
    position: { x: 20.25, y: -30.5 },
    ...overrides,
  };
}

function projection(overrides = {}) {
  return {
    schemaVersion: 1,
    projectionType: "blueprint-direct-deploy-context-v1",
    source: "native-core",
    revision: 9,
    stateVersion: 47,
    registryFingerprint: "builtin:test",
    request: {
      expectedRevision: 9,
      expectedRegistryFingerprint: "builtin:test",
      blueprintId: "ordinary-blueprint",
      blueprintRevision: 4,
      position: { x: 20.25, y: -30.5 },
    },
    activePlanetId: "planet-home",
    support: { supported: true, reason: null },
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

test("blueprint direct deploy context is wired through direct, authority, shadow, and transfer paths", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");
  const broker = source("native-player-authority-projection-broker.cjs");
  const boundary = source("native-renderer-boundary.cjs");
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");

  assert.match(main, /function nativeBlueprintDirectDeployContextResultContext\(request\)[\s\S]*?sessionId:[\s\S]*?expectedRevision:[\s\S]*?expectedRegistryFingerprint:[\s\S]*?blueprintId:[\s\S]*?blueprintRevision:[\s\S]*?position:/);
  assert.match(main, /desktop:native-core-blueprint-direct-deploy-context"[\s\S]*?coreBlueprintDirectDeployContext[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\([\s\S]*?"blueprint-direct-deploy-context-v1"[\s\S]*?blueprintDirectDeployContext\(ownerId, request\)/);
  assert.match(main, /request\.projectionType === "blueprint-direct-deploy-context-v1"[\s\S]*?blueprintDirectDeployContext\(ownerId, normalizedRequest\)/);
  assert.match(preload, /getNativeCoreBlueprintDirectDeployContext:[\s\S]*?desktop:native-core-blueprint-direct-deploy-context/);
  assert.match(broker, /"blueprint-direct-deploy-context-v1":\s*"blueprintDirectDeployContext"/);
  assert.match(boundary, /coreBlueprintDirectDeployContext:\s*normalizeCoreBlueprintDirectDeployContext/);
  assert.match(desktop, /interface DesktopNativeCoreBlueprintDirectDeployContextRequest[\s\S]*?blueprintRevision:\s*number[\s\S]*?position:\s*\{ x: number; y: number \}/);
  assert.match(nativeCore, /blueprintDirectDeployContext\([\s\S]*?blueprint-direct-deploy-context-v1[\s\S]*?DesktopNativeCoreBlueprintDirectDeployContextResult/);
});

test("desktop registry forwards only the exact finite direct-deploy click identity", async () => {
  assert.equal(
    NATIVE_BLUEPRINT_DIRECT_DEPLOY_CONTEXT_CAPABILITY,
    "native-core-blueprint-direct-deploy-context-v1",
  );
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [NATIVE_BLUEPRINT_DIRECT_DEPLOY_CONTEXT_CAPABILITY] },
    request(request) {
      calls.push(request);
      return Promise.resolve({ projectionType: "blueprint-direct-deploy-context-v1", revision: 9 });
    },
  });
  registry.sessions.set("core-blueprint-direct", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  await registry.blueprintDirectDeployContext(7, requestContext());
  assert.deepEqual(calls, [{
    operation: "coreBlueprintDirectDeployContext",
    sessionId: "core-blueprint-direct",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    blueprintId: "ordinary-blueprint",
    blueprintRevision: 4,
    position: { x: 20.25, y: -30.5 },
  }]);

  for (const invalid of [
    requestContext({ position: { x: Number.NaN, y: 2 } }),
    requestContext({ position: { x: 1, y: Number.POSITIVE_INFINITY } }),
    requestContext({ position: { x: 1, y: 2, z: 3 } }),
    requestContext({ blueprintId: "bad\nidentifier" }),
    requestContext({ blueprintRevision: 0 }),
    { ...requestContext(), planetId: "planet-home" },
    { ...requestContext(), inventory: { assembler: 1 } },
  ]) {
    assert.throws(
      () => registry.blueprintDirectDeployContext(7, invalid),
      /blueprint direct deploy|position/,
    );
  }
});

test("desktop registry fail-closes before IPC when Host lacks direct-deploy capability", () => {
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [] },
    request(request) {
      calls.push(request);
      throw new Error("must not reach Host");
    },
  });
  registry.sessions.set("core-blueprint-direct", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  assert.throws(
    () => registry.blueprintDirectDeployContext(7, requestContext()),
    (error) => error?.code === "NATIVE_CORE_CAPABILITY_MISSING",
  );
  assert.deepEqual(calls, []);
});

test("renderer accepts only exact bounded Rust context with no derived deploy state", () => {
  const context = requestContext();
  const value = projection();
  const normalized = normalizeRendererNativeResult(
    "coreBlueprintDirectDeployContext",
    value,
    context,
  );
  assert.deepEqual(normalized, value);
  assert.notEqual(normalized, value);
  const body = JSON.stringify(normalized);
  for (const forbidden of ["planetName", "inventory", "entities", "belts", "nextId", "rotation", "body"]) {
    assert.equal(body.includes(`\"${forbidden}\"`), false);
  }

  const rejects = (candidate, request = context) => assert.throws(
    () => normalizeRendererNativeResult("coreBlueprintDirectDeployContext", candidate, request),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejects(value, requestContext({ position: { x: 20, y: -30.5 } }));
  rejects({ ...value, revision: 8 });
  rejects({ ...value, request: { ...value.request, position: { x: 20, y: -30.5 } } });
  rejects({ ...value, support: { supported: true, reason: "position-overlap" } });
  rejects({ ...value, support: { supported: false, reason: null } });
  rejects({ ...value, inventory: {} });
  rejects({ ...value, limits: { projectionBytes: 1_048_575 } });
});

test("all canonical unsupported direct-deploy reasons remain structured", () => {
  const reasons = [
    "next-id-exhausted",
    "unsupported-blueprint-domain",
    "unsupported-active-planet",
    "insufficient-construction-materials",
    "position-overlap",
    "version-conflict",
    "catalog-incomplete",
  ];
  for (const reason of reasons) {
    const normalized = normalizeRendererNativeResult(
      "coreBlueprintDirectDeployContext",
      projection({ support: { supported: false, reason } }),
      requestContext(),
    );
    assert.deepEqual(normalized.support, { supported: false, reason });
  }
  assert.throws(
    () => normalizeRendererNativeResult(
      "coreBlueprintDirectDeployContext",
      projection({ support: { supported: false, reason: "queue-full" } }),
      requestContext(),
    ),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
});
