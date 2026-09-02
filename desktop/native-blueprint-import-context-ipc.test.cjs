"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  NATIVE_BLUEPRINT_IMPORT_CONTEXT_CAPABILITY,
  NativeCoreSessionRegistry,
  normalizeNativeCoreCommand,
} = require("./native-host.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const raw = "{\"schemaVersion\":2,\"name\":\"蓝图\"}";

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

function context(overrides = {}) {
  return {
    sessionId: "core-blueprint-import",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    raw,
    ...overrides,
  };
}

function preparedIntent() {
  return {
    kind: "import",
    sourceName: "蓝图",
    blueprint: {
      id: "blueprint_17",
      name: "蓝图 08",
      revision: 1,
      entities: [],
      resourceAnchors: [],
      belts: [],
      externalPorts: [],
      rotation: 0,
      mirror: "none",
      recipeOverrides: {},
    },
    blueprintSha256: "a".repeat(64),
    revision: 9,
  };
}

function projection(overrides = {}) {
  return {
    schemaVersion: 1,
    projectionType: "blueprint-import-context-v1",
    source: "native-core",
    revision: 9,
    stateVersion: 47,
    registryFingerprint: "builtin:test",
    request: {
      expectedRevision: 9,
      expectedRegistryFingerprint: "builtin:test",
      rawBytes: Buffer.byteLength(raw, "utf8"),
      rawSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    },
    activePlanetId: "planet-home",
    support: { supported: true, reason: null },
    preparedIntent: preparedIntent(),
    limits: {
      rawBytes: 1_048_576,
      projectionBytes: 1_048_576,
      commandBytes: 1_048_576,
      libraryRows: 64,
      blueprintEntities: 512,
      blueprintBelts: 1_024,
    },
    ...overrides,
  };
}

test("blueprint import context is wired through direct, authority, shadow, and transfer paths", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");
  const broker = source("native-player-authority-projection-broker.cjs");
  const boundary = source("native-renderer-boundary.cjs");
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");
  assert.match(main, /desktop:native-core-blueprint-import-context"[\s\S]*?coreBlueprintImportContext[\s\S]*?blueprint-import-context-v1/);
  assert.match(main, /request\.projectionType === "blueprint-import-context-v1"[\s\S]*?blueprintImportContext\(ownerId, normalizedRequest\)/);
  assert.match(preload, /getNativeCoreBlueprintImportContext:\s*invokeNativeBlueprintImportContext/);
  assert.match(broker, /"blueprint-import-context-v1":\s*"blueprintImportContext"/);
  assert.match(boundary, /coreBlueprintImportContext:\s*normalizeCoreBlueprintImportContext/);
  assert.match(desktop, /interface DesktopNativeCoreBlueprintImportContextRequest[\s\S]*?raw:\s*string/);
  assert.match(nativeCore, /blueprintImportContext\([\s\S]*?blueprint-import-context-v1/);
});

test("desktop registry forwards only bounded raw exchange to the capability-gated Host", async () => {
  assert.equal(NATIVE_BLUEPRINT_IMPORT_CONTEXT_CAPABILITY, "native-core-blueprint-import-context-v1");
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [NATIVE_BLUEPRINT_IMPORT_CONTEXT_CAPABILITY] },
    request(value) { calls.push(value); return Promise.resolve(projection()); },
  });
  registry.sessions.set("core-blueprint-import", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  await registry.blueprintImportContext(7, context());
  assert.deepEqual(calls, [{
    operation: "coreBlueprintImportContext",
    sessionId: "core-blueprint-import",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    raw,
  }]);
  for (const invalid of [
    context({ raw: "" }),
    context({ raw: "{\"x\":\"\ud800\"}" }),
    context({ raw: "x".repeat(1_048_577) }),
    { ...context(), inventory: {} },
  ]) assert.throws(() => registry.blueprintImportContext(7, invalid));
});

test("renderer binds Rust import result to raw bytes/digest and exact prepared marker", () => {
  const normalized = normalizeRendererNativeResult("coreBlueprintImportContext", projection(), context());
  assert.deepEqual(normalized, projection());
  assert.equal(JSON.stringify(normalized).includes(raw), false);
  const rejects = (value, request = context()) => assert.throws(
    () => normalizeRendererNativeResult("coreBlueprintImportContext", value, request),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejects({ ...projection(), request: { ...projection().request, rawBytes: 1 } });
  rejects({ ...projection(), request: { ...projection().request, rawSha256: "b".repeat(64) } });
  rejects({ ...projection(), preparedIntent: { ...preparedIntent(), inventory: {} } });
  rejects({ ...projection(), preparedIntent: {
    ...preparedIntent(), blueprint: { ...preparedIntent().blueprint, hidden: true },
  } });
  rejects({ ...projection(), limits: { ...projection().limits, blueprintEntities: 256 } });
  rejects(projection(), context({ raw: `${raw} ` }));
});

test("unsupported reasons require a null prepared marker", () => {
  const reasons = [
    "invalid-exchange", "unsupported-active-planet", "unsupported-blueprint-domain",
    "catalog-incomplete", "position-overlap", "library-full", "next-id-exhausted",
    "serialized-budget-exceeded",
  ];
  for (const reason of reasons) {
    const normalized = normalizeRendererNativeResult(
      "coreBlueprintImportContext",
      projection({ support: { supported: false, reason }, preparedIntent: null }),
      context(),
    );
    assert.deepEqual(normalized.support, { supported: false, reason });
  }
  assert.throws(() => normalizeRendererNativeResult(
    "coreBlueprintImportContext",
    projection({ support: { supported: false, reason: "surprise" }, preparedIntent: null }),
    context(),
  ));
});

test("prepared offsets cross JSON frame/WAL transport in canonical +0 form without marker hash drift", () => {
  const marker = preparedIntent();
  marker.blueprint.entities = [{
    key: "entity-a",
    buildingId: "assembler_mk1",
    offset: { x: -0, y: -0.5 },
    machineCount: 1,
  }];
  const normalizedContext = normalizeRendererNativeResult(
    "coreBlueprintImportContext",
    projection({ preparedIntent: marker }),
    context(),
  );
  const preparedOffset = normalizedContext.preparedIntent.blueprint.entities[0].offset;
  assert.equal(Object.is(preparedOffset.x, -0), false);
  assert.equal(preparedOffset.x, 0);
  assert.equal(preparedOffset.y, -0.5);

  const command = {
    protocolVersion: 1,
    baseRevision: 9,
    topLevelChanges: [{
      path: ["blueprints", "intent"],
      operation: "set",
      value: normalizedContext.preparedIntent,
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
  const framed = JSON.parse(JSON.stringify(command));
  const durable = normalizeNativeCoreCommand(framed);
  const durableMarker = durable.topLevelChanges[0].value;
  assert.equal(Object.is(durableMarker.blueprint.entities[0].offset.x, -0), false);
  assert.equal(durableMarker.blueprint.entities[0].offset.y, -0.5);
  assert.equal(durableMarker.blueprintSha256, marker.blueprintSha256);
});
