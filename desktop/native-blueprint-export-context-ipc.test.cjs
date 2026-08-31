"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  NATIVE_BLUEPRINT_EXPORT_CONTEXT_CAPABILITY,
  NativeCoreSessionRegistry,
} = require("./native-host.cjs");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const rawExchange = JSON.stringify({
  type: "dsp-idle-blueprint",
  formatVersion: 2,
  blueprint: { id: "blueprint_17", name: "蓝图 08" },
});

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

function context(overrides = {}) {
  return {
    sessionId: "core-blueprint-export",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    blueprintId: "blueprint_17",
    blueprintRevision: 1,
    ...overrides,
  };
}

function projection(overrides = {}) {
  return {
    schemaVersion: 1,
    projectionType: "blueprint-export-context-v1",
    source: "native-core",
    revision: 9,
    stateVersion: 47,
    registryFingerprint: "builtin:test",
    request: {
      expectedRevision: 9,
      expectedRegistryFingerprint: "builtin:test",
      blueprintId: "blueprint_17",
      blueprintRevision: 1,
    },
    activePlanetId: "planet-home",
    support: { supported: true, reason: null },
    rawExchange,
    rawBytes: Buffer.byteLength(rawExchange, "utf8"),
    rawSha256: createHash("sha256").update(rawExchange, "utf8").digest("hex"),
    blueprintName: "蓝图 08",
    fileNameStem: "蓝图 08",
    limits: {
      exchangeBytes: 1_048_576,
      projectionBytes: 1_048_576,
      blueprintEntities: 512,
      blueprintBelts: 1_024,
    },
    ...overrides,
  };
}

test("blueprint export is wired through direct, authority, shadow, and bounded transfer paths", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");
  const broker = source("native-player-authority-projection-broker.cjs");
  const boundary = source("native-renderer-boundary.cjs");
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");
  assert.match(main, /desktop:native-core-blueprint-export-context"[\s\S]*?coreBlueprintExportContext[\s\S]*?blueprint-export-context-v1/);
  assert.match(main, /request\.projectionType === "blueprint-export-context-v1"[\s\S]*?blueprintExportContext\(ownerId, normalizedRequest\)/);
  assert.match(preload, /getNativeCoreBlueprintExportContext:\s*invokeNativeBlueprintExportContext/);
  assert.match(preload, /"blueprint-export-context-v1"/);
  assert.match(broker, /"blueprint-export-context-v1":\s*"blueprintExportContext"/);
  assert.match(boundary, /coreBlueprintExportContext:\s*normalizeCoreBlueprintExportContext/);
  assert.match(desktop, /interface DesktopNativeCoreBlueprintExportContextRequest[\s\S]*?blueprintRevision:\s*number/);
  assert.match(nativeCore, /blueprintExportContext\([\s\S]*?blueprint-export-context-v1/);
});

test("desktop registry forwards only the exact capability-gated read request and allows max-safe revision", async () => {
  assert.equal(
    NATIVE_BLUEPRINT_EXPORT_CONTEXT_CAPABILITY,
    "native-core-blueprint-export-context-v1",
  );
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    hello: { capabilities: [NATIVE_BLUEPRINT_EXPORT_CONTEXT_CAPABILITY] },
    request(value) { calls.push(value); return Promise.resolve(projection()); },
  });
  registry.sessions.set("core-blueprint-export", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  await registry.blueprintExportContext(7, context());
  assert.deepEqual(calls, [{
    operation: "coreBlueprintExportContext",
    sessionId: "core-blueprint-export",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    blueprintId: "blueprint_17",
    blueprintRevision: 1,
  }]);
  assert.doesNotThrow(() => registry.blueprintExportContext(7, context({
    expectedRevision: Number.MAX_SAFE_INTEGER,
    blueprintRevision: Number.MAX_SAFE_INTEGER,
  })));
  for (const invalid of [
    context({ blueprintId: "" }),
    context({ blueprintRevision: 0 }),
    context({ expectedRevision: -1 }),
    { ...context(), raw: "{}" },
  ]) assert.throws(() => registry.blueprintExportContext(7, invalid));
});

test("renderer verifies the exact Rust bytes, digest, row binding, and Windows-safe filename", () => {
  const normalized = normalizeRendererNativeResult(
    "coreBlueprintExportContext",
    projection(),
    context(),
  );
  assert.deepEqual(normalized, projection());
  const rejects = (value, request = context()) => assert.throws(
    () => normalizeRendererNativeResult("coreBlueprintExportContext", value, request),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejects({ ...projection(), rawBytes: 1 });
  rejects({ ...projection(), rawSha256: "b".repeat(64) });
  rejects({ ...projection(), request: { ...projection().request, blueprintRevision: 2 } });
  const windowsDevices = [
    "CON", "prn", "AUX", "nul",
    ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
    "COM¹", "com²", "COM³", "LPT¹", "lpt²", "LPT³",
  ];
  for (const device of windowsDevices) {
    rejects({ ...projection(), fileNameStem: device });
    rejects({ ...projection(), fileNameStem: `${device}.json` });
  }
  rejects({ ...projection(), fileNameStem: "COM¹ .json" });
  assert.doesNotThrow(() => normalizeRendererNativeResult(
    "coreBlueprintExportContext",
    projection({ fileNameStem: "COM⁴.json" }),
    context(),
  ));
  const escapedMaxLengthDevice = `_COM¹.${"x".repeat(74)}`;
  assert.equal(escapedMaxLengthDevice.length, 80);
  assert.doesNotThrow(() => normalizeRendererNativeResult(
    "coreBlueprintExportContext",
    projection({ fileNameStem: escapedMaxLengthDevice }),
    context(),
  ));
  rejects({ ...projection(), fileNameStem: "bad/name" });
  rejects({ ...projection(), hidden: true });
  rejects(projection(), context({ blueprintId: "blueprint_18" }));
});

test("every unsupported reason requires all exchange and filename fields to be null", () => {
  const reasons = [
    "version-conflict", "unsupported-active-planet", "unsupported-blueprint-domain",
    "catalog-incomplete", "position-overlap", "serialized-budget-exceeded",
  ];
  for (const reason of reasons) {
    const normalized = normalizeRendererNativeResult(
      "coreBlueprintExportContext",
      projection({
        support: { supported: false, reason },
        rawExchange: null,
        rawBytes: null,
        rawSha256: null,
        blueprintName: null,
        fileNameStem: null,
      }),
      context(),
    );
    assert.deepEqual(normalized.support, { supported: false, reason });
  }
  assert.throws(() => normalizeRendererNativeResult(
    "coreBlueprintExportContext",
    projection({ support: { supported: false, reason: "catalog-incomplete" } }),
    context(),
  ));
});
