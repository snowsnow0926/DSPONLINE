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

  assert.match(main, /function nativeViewportProjectionV2ResultContext\(request\)[\s\S]*?sessionId:\s*request\?\.sessionId[\s\S]*?expectedRevision:\s*request\?\.expectedRevision[\s\S]*?beltCursor:[\s\S]*?pinnedEntityIds:[\s\S]*?pinnedBeltIds:[\s\S]*?entityPresentationVersion:/);
  assert.match(main, /desktop:native-core-viewport-projection-v2"[\s\S]*?runRendererNativeOperation\("coreViewportProjectionV2"[\s\S]*?nativeCoreSessions\.viewportProjectionV2\(ownerId, request\)/);
  assert.match(main, /\["viewport-v1", "viewport-v2", "factory-read-model-v1", "factory-inventory-v1", "construction-inventory-v1", "blueprint-workspace-v1", "blueprint-enqueue-context-v1", "blueprint-direct-deploy-context-v1", "construction-placement-context-v1", "construction-belt-placement-context-v1", "construction-belt-lane-context-v1", "construction-belt-removal-context-v1", "construction-removal-context-v1", "construction-stack-context-v1", "statistics-v1", "technology-v1", "recipe-workspace-v1", "star-map-overview-v1", "star-map-catalog-v1", "stellar-industry-v1", "stellar-industry-v2", "stellar-quantum-v1", "dyson-workspace-v1"\]\.includes\(request\.projectionType\)/);
  assert.match(main, /request\.projectionType === "viewport-v2"[\s\S]*?nativeCoreSessions\.viewportProjectionV2\(ownerId, normalizedRequest\)/);
  assert.match(main, /request\.projectionType === "viewport-v2"[\s\S]*?"coreViewportProjectionV2"[\s\S]*?nativeViewportProjectionV2ResultContext\(normalizedRequest\)/);

  assert.match(preload, /NATIVE_CORE_TRANSFER_PROJECTION_TYPES\.includes\(request\.projectionType\)/);
  assert.match(preload, /getNativeCoreViewportProjectionV2:\s*\(request\)\s*=>\s*invokeNative\("desktop:native-core-viewport-projection-v2"[\s\S]*?request\)/);
  assert.match(preload, /getNativeCoreViewportProjection:\s*\(request\)\s*=>\s*invokeNative\("desktop:native-core-viewport-projection"/);
  assert.match(preload, /getNativeCoreStatisticsProjection:\s*\(request\)\s*=>\s*invokeNative\("desktop:native-core-statistics-projection"/);
});

test("viewport v2 TypeScript contract binds a caller revision and independent cursors", () => {
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");

  assert.match(desktop, /getNativeCoreViewportProjectionV2:\s*\(request:\s*DesktopNativeCoreViewportProjectionV2Request\)\s*=>\s*Promise<DesktopNativeCoreViewportProjectionV2Result>/);
  assert.match(desktop, /interface DesktopNativeCoreViewportProjectionV2Request[\s\S]*?expectedRevision:\s*number;[\s\S]*?entityPresentationVersion\?:\s*1;[\s\S]*?entityCursor\?:\s*number;[\s\S]*?beltCursor\?:\s*number;[\s\S]*?pinnedEntityIds\?:\s*string\[\];[\s\S]*?pinnedBeltIds\?:\s*string\[\];/);
  assert.match(desktop, /interface DesktopNativeCoreViewportProjectionV2Result[\s\S]*?schemaVersion:\s*2;[\s\S]*?projectionType:\s*"viewport-v2";[\s\S]*?entities:\s*DesktopNativeCoreEntityProjection\[\];[\s\S]*?entityPresentationVersion\?:\s*1;[\s\S]*?entityPresentation\?:\s*FactoryNodePresentationReadModel\[\];[\s\S]*?nextEntityCursor:\s*number \| null;[\s\S]*?nextBeltCursor:\s*number \| null;[\s\S]*?planetTotals:[\s\S]*?viewportTotals:[\s\S]*?minimap:[\s\S]*?broadQueryFallback:\s*boolean;/);
  assert.match(desktop, /projectionType:\s*"viewport-v1" \| "viewport-v2" \| "factory-read-model-v1" \| "factory-inventory-v1" \| "construction-inventory-v1" \| "blueprint-workspace-v1" \| "blueprint-enqueue-context-v1" \| "blueprint-direct-deploy-context-v1" \| "construction-placement-context-v1" \| "construction-belt-placement-context-v1" \| "construction-belt-lane-context-v1" \| "construction-belt-removal-context-v1" \| "construction-removal-context-v1" \| "construction-stack-context-v1" \| "statistics-v1" \| "technology-v1" \| "recipe-workspace-v1" \| "star-map-overview-v1" \| "star-map-catalog-v1" \| "stellar-industry-v1" \| "stellar-industry-v2" \| "stellar-quantum-v1" \| "dyson-workspace-v1";/);
});
