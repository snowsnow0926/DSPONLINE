"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

test("factory read model is exposed through direct and bounded transfer IPC", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");

  assert.match(main, /function nativeFactoryReadModelResultContext\(request\)[\s\S]*?sessionId:\s*request\?\.sessionId[\s\S]*?expectedRevision:\s*request\?\.expectedRevision[\s\S]*?selectedEntityIds:[\s\S]*?selectedBeltIds:/);
  assert.match(main, /desktop:native-core-factory-read-model"[\s\S]*?runRendererNativeOperation\("coreFactoryReadModelProjection"[\s\S]*?nativeCoreSessions\.factoryReadModelProjection\(ownerId, request\)/);
  assert.match(main, /request\.projectionType === "factory-read-model-v1"[\s\S]*?nativeCoreSessions\.factoryReadModelProjection\(ownerId, normalizedRequest\)/);
  assert.match(main, /request\.projectionType === "factory-read-model-v1"[\s\S]*?"coreFactoryReadModelProjection"[\s\S]*?nativeFactoryReadModelResultContext\(normalizedRequest\)/);

  assert.match(preload, /getNativeCoreFactoryReadModel:\s*\(request\)\s*=>\s*invokeNative\("desktop:native-core-factory-read-model"[\s\S]*?request\)/);
  assert.match(preload, /\["viewport-v1", "viewport-v2", "factory-read-model-v1", "statistics-v1", "technology-v1"\]\.includes\(request\.projectionType\)/);
});

test("factory read model TypeScript contract is revision-bound and included in transfer types", () => {
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");

  assert.match(desktop, /getNativeCoreFactoryReadModel:\s*\(request:\s*DesktopNativeCoreFactoryReadModelRequest\)\s*=>\s*Promise<DesktopNativeCoreFactoryReadModelResult>/);
  assert.match(desktop, /interface DesktopNativeCoreFactoryReadModelRequest[\s\S]*?expectedRevision:\s*number;[\s\S]*?selectedEntityIds\?:\s*string\[\];[\s\S]*?selectedBeltIds\?:\s*string\[\];/);
  assert.match(desktop, /interface DesktopNativeCoreFactoryReadModelResult extends FactoryReadModelBundle[\s\S]*?schemaVersion:\s*1;[\s\S]*?projectionType:\s*"factory-read-model-v1";[\s\S]*?revision:\s*number;/);
  assert.match(desktop, /projectionType:\s*"factory-read-model-v1";[\s\S]*?Omit<DesktopNativeCoreFactoryReadModelRequest, "sessionId">/);
  assert.match(nativeCore, /factoryReadModel\([\s\S]*?projectionType:\s*"factory-read-model-v1"[\s\S]*?decodeNativeCoreProjectionTransfer<DesktopNativeCoreFactoryReadModelResult>/);
});
