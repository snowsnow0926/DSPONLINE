"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  NATIVE_CONSTRUCTION_INVENTORY_CAPABILITY,
  NativeCoreSessionRegistry,
} = require("./native-host.cjs");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

test("construction inventory is exposed through direct and bounded transfer IPC", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");
  const broker = source("native-player-authority-projection-broker.cjs");

  assert.match(main, /function nativeConstructionInventoryResultContext\(request\)[\s\S]*?sessionId:\s*request\?\.sessionId[\s\S]*?expectedRevision:\s*request\?\.expectedRevision[\s\S]*?expectedRegistryFingerprint:\s*request\?\.expectedRegistryFingerprint[\s\S]*?cursor:[\s\S]*?limit:/);
  assert.match(main, /desktop:native-core-construction-inventory"[\s\S]*?runRendererNativeOperation\("coreConstructionInventoryProjection"[\s\S]*?nativeCoreSessions\.constructionInventoryProjection\(ownerId, request\)/);
  assert.match(main, /request\.projectionType === "construction-inventory-v1"[\s\S]*?nativeCoreSessions\.constructionInventoryProjection\(ownerId, normalizedRequest\)/);
  assert.match(main, /request\.projectionType === "construction-inventory-v1"[\s\S]*?"coreConstructionInventoryProjection"[\s\S]*?nativeConstructionInventoryResultContext\(normalizedRequest\)/);
  assert.match(main, /desktop:native-core-construction-inventory"[\s\S]*?routeNativeProjectionRead\(\{[\s\S]*?projectionType: "construction-inventory-v1"[\s\S]*?shadowRead: \(\) => nativeCoreSessions\.constructionInventoryProjection\(ownerId, request\)/);

  assert.match(preload, /getNativeCoreConstructionInventory:\s*\(request\)\s*=>\s*invokeNative\("desktop:native-core-construction-inventory"[\s\S]*?request\)/);
  assert.match(preload, /"construction-inventory-v1"[\s\S]*?NATIVE_CORE_TRANSFER_PROJECTION_TYPES\.includes\(request\.projectionType\)/);
  assert.match(broker, /"construction-inventory-v1":\s*"constructionInventoryProjection"/);
});

test("construction inventory TypeScript contract is catalog-identity-bound, read-only, and transferable", () => {
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");

  assert.match(desktop, /getNativeCoreConstructionInventory\?:\s*\(request:\s*DesktopNativeCoreConstructionInventoryRequest\)\s*=>\s*Promise<DesktopNativeCoreConstructionInventoryResult>/);
  assert.match(desktop, /interface DesktopNativeCoreConstructionInventoryRequest[\s\S]*?expectedRevision:\s*number;[\s\S]*?expectedRegistryFingerprint:\s*string;[\s\S]*?cursor:\s*number;[\s\S]*?limit:\s*number;/);
  assert.match(desktop, /interface DesktopNativeCoreConstructionInventoryResult[\s\S]*?projectionType:\s*"construction-inventory-v1";[\s\S]*?source:\s*"native-core";[\s\S]*?readOnly:\s*true;[\s\S]*?rows:\s*DesktopNativeCoreConstructionInventoryRow\[\];[\s\S]*?nextCursor:[\s\S]*?limits:/);
  assert.match(desktop, /projectionType:\s*"construction-inventory-v1";[\s\S]*?Omit<DesktopNativeCoreConstructionInventoryRequest, "sessionId">/);
  assert.match(nativeCore, /constructionInventoryProjection\([\s\S]*?projectionType:\s*"construction-inventory-v1"[\s\S]*?decodeNativeCoreProjectionTransfer<DesktopNativeCoreConstructionInventoryResult>/);
});

test("Rust host publishes and dispatches the catalog-fenced construction inventory capability", () => {
  const protocol = fs.readFileSync(path.resolve(__dirname, "../native/dsp-native-host/src/protocol.rs"), "utf8");
  const runtime = fs.readFileSync(path.resolve(__dirname, "../native/dsp-native-host/src/core_runtime.rs"), "utf8");
  const main = fs.readFileSync(path.resolve(__dirname, "../native/dsp-native-host/src/rpc.rs"), "utf8");

  assert.match(protocol, /CoreConstructionInventoryProjection\s*\{[\s\S]*?session_id:\s*String,[\s\S]*?expected_revision:\s*u64,[\s\S]*?expected_registry_fingerprint:\s*String,[\s\S]*?cursor:\s*usize,[\s\S]*?limit:\s*usize/);
  assert.match(runtime, /pub fn construction_inventory_projection\([\s\S]*?expected_revision:\s*u64[\s\S]*?expected_registry_fingerprint:\s*&str[\s\S]*?\.construction_inventory_projection\([\s\S]*?expected_revision,[\s\S]*?expected_registry_fingerprint,[\s\S]*?cursor,[\s\S]*?limit/);
  assert.match(main, /"native-core-construction-inventory-v1"/);
  assert.match(main, /ControlRequest::CoreConstructionInventoryProjection[\s\S]*?cores\.construction_inventory_projection/);
});

test("desktop registry forwards only the exact bounded construction inventory request", async () => {
  assert.equal(
    NATIVE_CONSTRUCTION_INVENTORY_CAPABILITY,
    "native-core-construction-inventory-v1",
  );
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    request(request) {
      calls.push(request);
      return Promise.resolve({ projectionType: "construction-inventory-v1", revision: 9 });
    },
  });
  registry.sessions.set("core-construction", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  await registry.constructionInventoryProjection(7, {
    sessionId: "core-construction",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    cursor: 256,
    limit: 128,
  });
  assert.deepEqual(calls, [{
    operation: "coreConstructionInventoryProjection",
    sessionId: "core-construction",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    cursor: 256,
    limit: 128,
  }]);
  assert.throws(() => registry.constructionInventoryProjection(7, {
    sessionId: "core-construction",
    expectedRevision: 9,
    expectedRegistryFingerprint: "bad fingerprint",
    cursor: 0,
    limit: 128,
  }), /construction inventory projection request is invalid/);
  assert.throws(() => registry.constructionInventoryProjection(7, {
    sessionId: "core-construction",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    cursor: 0,
    limit: 257,
  }), /construction inventory projection request is invalid/);
  assert.throws(() => registry.constructionInventoryProjection(7, {
    sessionId: "core-construction",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    cursor: 0,
    limit: 128,
    path: "C:\\secret",
  }), /construction inventory projection request is invalid/);
});
