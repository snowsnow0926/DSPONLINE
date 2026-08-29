"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

test("factory inventory is exposed through direct and bounded transfer IPC", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");
  const broker = source("native-player-authority-projection-broker.cjs");

  assert.match(main, /function nativeFactoryInventoryResultContext\(request\)[\s\S]*?sessionId:\s*request\?\.sessionId[\s\S]*?expectedRevision:\s*request\?\.expectedRevision[\s\S]*?cursor:[\s\S]*?limit:/);
  assert.match(main, /desktop:native-core-factory-inventory"[\s\S]*?runRendererNativeOperation\("coreFactoryInventoryProjection"[\s\S]*?nativeCoreSessions\.factoryInventoryProjection\(ownerId, request\)/);
  assert.match(main, /request\.projectionType === "factory-inventory-v1"[\s\S]*?nativeCoreSessions\.factoryInventoryProjection\(ownerId, normalizedRequest\)/);
  assert.match(main, /request\.projectionType === "factory-inventory-v1"[\s\S]*?"coreFactoryInventoryProjection"[\s\S]*?nativeFactoryInventoryResultContext\(normalizedRequest\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "factory-inventory-v1", request\)/);

  assert.match(preload, /getNativeCoreFactoryInventory:\s*\(request\)\s*=>\s*invokeNative\("desktop:native-core-factory-inventory"[\s\S]*?request\)/);
  assert.match(preload, /"factory-inventory-v1"[\s\S]*?NATIVE_CORE_TRANSFER_PROJECTION_TYPES\.includes\(request\.projectionType\)/);
  assert.match(broker, /"factory-inventory-v1":\s*"factoryInventoryProjection"/);
});

test("factory inventory TypeScript contract is revision-bound and included in transfer types", () => {
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");

  assert.match(desktop, /getNativeCoreFactoryInventory\?:\s*\(request:\s*DesktopNativeCoreFactoryInventoryRequest\)\s*=>\s*Promise<DesktopNativeCoreFactoryInventoryResult>/);
  assert.match(desktop, /interface DesktopNativeCoreFactoryInventoryRequest[\s\S]*?expectedRevision:\s*number;[\s\S]*?cursor:\s*number;[\s\S]*?limit:\s*number;/);
  assert.match(desktop, /interface DesktopNativeCoreFactoryInventoryResult[\s\S]*?projectionType:\s*"factory-inventory-v1";[\s\S]*?source:\s*"native-core";[\s\S]*?portableFleet:[\s\S]*?logistics_drone:[\s\S]*?logistics_vessel:[\s\S]*?productionBufferLimit:\s*number;[\s\S]*?trayItemLimitBounds:[\s\S]*?request:[\s\S]*?nextCursor:[\s\S]*?limits:/);
  const boundary = source("native-renderer-boundary.cjs");
  assert.match(boundary, /"portableFleet",\s*"productionBufferLimit",\s*"trayItemLimit"/);
  assert.match(boundary, /productionBufferLimit\s*=\s*safeInteger\([\s\S]*?1_000[\s\S]*?productionBufferLimit\s*>\s*100_000_000/);
  assert.match(desktop, /projectionType:\s*"factory-inventory-v1";[\s\S]*?Omit<DesktopNativeCoreFactoryInventoryRequest, "sessionId">/);
  assert.match(nativeCore, /factoryInventoryProjection\([\s\S]*?projectionType:\s*"factory-inventory-v1"[\s\S]*?decodeNativeCoreProjectionTransfer<DesktopNativeCoreFactoryInventoryResult>/);
});

test("Rust host publishes and dispatches the revision-fenced factory inventory capability", () => {
  const protocol = fs.readFileSync(path.resolve(__dirname, "../native/dsp-native-host/src/protocol.rs"), "utf8");
  const runtime = fs.readFileSync(path.resolve(__dirname, "../native/dsp-native-host/src/core_runtime.rs"), "utf8");
  const main = fs.readFileSync(path.resolve(__dirname, "../native/dsp-native-host/src/main.rs"), "utf8");

  assert.match(protocol, /CoreFactoryInventoryProjection\s*\{[\s\S]*?session_id:\s*String,[\s\S]*?expected_revision:\s*u64,[\s\S]*?cursor:\s*usize,[\s\S]*?limit:\s*usize/);
  assert.match(runtime, /pub fn factory_inventory_projection\([\s\S]*?expected_revision:\s*u64[\s\S]*?\.factory_inventory_projection\(expected_revision, cursor, limit\)/);
  assert.match(main, /"native-core-factory-inventory-v1"/);
  assert.match(main, /ControlRequest::CoreFactoryInventoryProjection[\s\S]*?cores\.factory_inventory_projection/);
});
