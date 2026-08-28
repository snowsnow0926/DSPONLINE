const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

test("viewport v2 is exposed through direct and bounded transfer IPC without replacing v1", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");

  assert.match(main, /function nativeViewportProjectionV2ResultContext\(request\)[\s\S]*?sessionId:\s*request\?\.sessionId[\s\S]*?expectedRevision:\s*request\?\.expectedRevision[\s\S]*?beltCursor:[\s\S]*?pinnedEntityIds:[\s\S]*?pinnedBeltIds:/);
  assert.match(main, /desktop:native-core-viewport-projection-v2"[\s\S]*?runRendererNativeOperation\("coreViewportProjectionV2"[\s\S]*?nativeCoreSessions\.viewportProjectionV2\(ownerId, request\)/);
  assert.match(main, /\["viewport-v1", "viewport-v2", "factory-read-model-v1", "statistics-v1", "technology-v1", "recipe-workspace-v1"\]\.includes\(request\.projectionType\)/);
  assert.match(main, /request\.projectionType === "viewport-v2"[\s\S]*?nativeCoreSessions\.viewportProjectionV2\(ownerId, normalizedRequest\)/);
  assert.match(main, /request\.projectionType === "viewport-v2"[\s\S]*?"coreViewportProjectionV2"[\s\S]*?nativeViewportProjectionV2ResultContext\(normalizedRequest\)/);

  assert.match(preload, /\["viewport-v1", "viewport-v2", "factory-read-model-v1", "statistics-v1", "technology-v1", "recipe-workspace-v1"\]\.includes\(request\.projectionType\)/);
  assert.match(preload, /getNativeCoreViewportProjectionV2:\s*\(request\)\s*=>\s*invokeNative\("desktop:native-core-viewport-projection-v2"[\s\S]*?request\)/);
  assert.match(preload, /getNativeCoreViewportProjection:\s*\(request\)\s*=>\s*invokeNative\("desktop:native-core-viewport-projection"/);
  assert.match(preload, /getNativeCoreStatisticsProjection:\s*\(request\)\s*=>\s*invokeNative\("desktop:native-core-statistics-projection"/);
});

test("viewport v2 TypeScript contract binds a caller revision and independent cursors", () => {
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");

  assert.match(desktop, /getNativeCoreViewportProjectionV2:\s*\(request:\s*DesktopNativeCoreViewportProjectionV2Request\)\s*=>\s*Promise<DesktopNativeCoreViewportProjectionV2Result>/);
  assert.match(desktop, /interface DesktopNativeCoreViewportProjectionV2Request[\s\S]*?expectedRevision:\s*number;[\s\S]*?entityCursor\?:\s*number;[\s\S]*?beltCursor\?:\s*number;[\s\S]*?pinnedEntityIds\?:\s*string\[\];[\s\S]*?pinnedBeltIds\?:\s*string\[\];/);
  assert.match(desktop, /interface DesktopNativeCoreViewportProjectionV2Result[\s\S]*?schemaVersion:\s*2;[\s\S]*?projectionType:\s*"viewport-v2";[\s\S]*?nextEntityCursor:\s*number \| null;[\s\S]*?nextBeltCursor:\s*number \| null;[\s\S]*?planetTotals:[\s\S]*?viewportTotals:[\s\S]*?minimap:[\s\S]*?broadQueryFallback:\s*boolean;/);
  assert.match(desktop, /projectionType:\s*"viewport-v1" \| "viewport-v2" \| "factory-read-model-v1" \| "statistics-v1" \| "technology-v1" \| "recipe-workspace-v1";/);
});
