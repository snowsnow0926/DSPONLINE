"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  NATIVE_CONSTRUCTION_PLACEMENT_CONTEXT_CAPABILITY,
  NativeCoreSessionRegistry,
} = require("./native-host.cjs");
const {
  normalizeRendererNativeResult,
} = require("./native-renderer-boundary.cjs");

function source(file) {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

function requestContext(overrides = {}) {
  return {
    sessionId: "core-placement",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    buildingId: "arc_smelter",
    ...overrides,
  };
}

function supportedProjection(overrides = {}) {
  return {
    schemaVersion: 1,
    projectionType: "construction-placement-context-v1",
    source: "native-core",
    revision: 9,
    stateVersion: 47,
    registryFingerprint: "builtin:test",
    request: {
      expectedRevision: 9,
      expectedRegistryFingerprint: "builtin:test",
      buildingId: "arc_smelter",
    },
    activePlanetId: "home",
    available: 4,
    appendEntityIndex: 12,
    nextEntityId: "entity_20",
    support: { supported: true, reason: null },
    placement: {
      remainingConstruction: 3,
      nextIdAfterPlacement: 21,
      entityTemplate: {
        id: "entity_20",
        kind: "machine",
        planetId: "home",
        interactionLocked: false,
        buildingId: "arc_smelter",
        powerGridId: "grid-a",
        powerPriority: 2,
        machineCount: 1,
        minerCount: 0,
        inputs: {},
        outputs: {},
        progress: 0,
        routingCursor: 0,
        utilization: 0,
        productionRate: 0,
        recipeId: "iron_ingot",
      },
    },
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

test("construction placement context is wired through direct, brokered, and transfer IPC", () => {
  const main = source("main.cjs");
  const preload = source("preload.cjs");
  const broker = source("native-player-authority-projection-broker.cjs");
  const desktop = fs.readFileSync(path.resolve(__dirname, "../src/desktop.ts"), "utf8");
  const nativeCore = fs.readFileSync(path.resolve(__dirname, "../src/game/nativeCore.ts"), "utf8");

  assert.match(main, /function nativeConstructionPlacementContextResultContext\(request\)[\s\S]*?sessionId:[\s\S]*?expectedRevision:[\s\S]*?expectedRegistryFingerprint:[\s\S]*?buildingId:/);
  assert.match(main, /desktop:native-core-construction-placement-context"[\s\S]*?coreConstructionPlacementContext[\s\S]*?constructionPlacementContext\(ownerId, request\)/);
  assert.match(main, /request\.projectionType === "construction-placement-context-v1"[\s\S]*?constructionPlacementContext\(ownerId, normalizedRequest\)/);
  assert.match(preload, /getNativeCoreConstructionPlacementContext:[\s\S]*?desktop:native-core-construction-placement-context/);
  assert.match(preload, /"construction-placement-context-v1"[\s\S]*?NATIVE_CORE_TRANSFER_PROJECTION_TYPES\.includes/);
  assert.match(broker, /"construction-placement-context-v1":\s*"constructionPlacementContext"/);
  assert.match(desktop, /interface DesktopNativeCoreConstructionPlacementContextRequest[\s\S]*?buildingId:\s*string/);
  assert.match(desktop, /projectionType:\s*"construction-placement-context-v1"[\s\S]*?entityTemplate:\s*Record<string, unknown>/);
  assert.match(nativeCore, /constructionPlacementContext\([\s\S]*?construction-placement-context-v1[\s\S]*?DesktopNativeCoreConstructionPlacementContextResult/);
});

test("desktop registry forwards only an exact, bounded, Unicode-safe placement request", async () => {
  assert.equal(
    NATIVE_CONSTRUCTION_PLACEMENT_CONTEXT_CAPABILITY,
    "native-core-construction-placement-context-v1",
  );
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    request(request) {
      calls.push(request);
      return Promise.resolve({ projectionType: "construction-placement-context-v1", revision: 9 });
    },
  });
  registry.sessions.set("core-placement", {
    ownerId: 7,
    slot: "normal-main",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });
  await registry.constructionPlacementContext(7, requestContext({ buildingId: "未知/MOD-建筑" }));
  assert.deepEqual(calls, [{
    operation: "coreConstructionPlacementContext",
    sessionId: "core-placement",
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    buildingId: "未知/MOD-建筑",
  }]);
  for (const invalid of [
    requestContext({ buildingId: "bad\nidentifier" }),
    requestContext({ buildingId: "x".repeat(513) }),
    requestContext({ buildingId: "bad\ud800id" }),
    requestContext({ expectedRegistryFingerprint: "bad fingerprint" }),
    { ...requestContext(), path: "C:\\secret" },
  ]) {
    assert.throws(
      () => registry.constructionPlacementContext(7, invalid),
      /construction placement context request is invalid/,
    );
  }
});

test("renderer accepts one canonical template and fail-closes stale or drifted contexts", () => {
  const context = requestContext();
  const projection = supportedProjection();
  const normalized = normalizeRendererNativeResult(
    "coreConstructionPlacementContext",
    projection,
    context,
  );
  assert.deepEqual(normalized, projection);
  assert.notEqual(normalized, projection);
  assert.notEqual(normalized.placement.entityTemplate, projection.placement.entityTemplate);

  const rejects = (value, request = context) => assert.throws(
    () => normalizeRendererNativeResult("coreConstructionPlacementContext", value, request),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejects(projection, requestContext({ expectedRevision: 8 }));
  rejects(projection, requestContext({ expectedRegistryFingerprint: "builtin:other" }));
  rejects({ ...projection, revision: 8 });
  rejects({ ...projection, registryFingerprint: "builtin:other" });
  rejects({
    ...projection,
    placement: {
      ...projection.placement,
      entityTemplate: { ...projection.placement.entityTemplate, powerPriority: 1 },
    },
  });
  rejects({
    ...projection,
    placement: {
      ...projection.placement,
      entityTemplate: {
        ...projection.placement.entityTemplate,
        position: { x: 0, y: 0 },
      },
    },
  });
  rejects({ ...projection, path: "C:\\secret" });
  rejects({
    ...projection,
    request: { ...projection.request, buildingId: "x".repeat(1_048_576) },
  });
});

test("unsupported Unicode, technology-lock, and empty-stock results remain structured and read-only", () => {
  for (const [buildingId, available, reason] of [
    ["未知/MOD-建筑", 5, "unknown-building"],
    ["locked_machine", 3, "technology-locked"],
    ["arc_smelter", 0, "inventory-empty"],
  ]) {
    const context = requestContext({ buildingId });
    const projection = supportedProjection({
      request: {
        expectedRevision: 9,
        expectedRegistryFingerprint: "builtin:test",
        buildingId,
      },
      available,
      support: { supported: false, reason },
      placement: null,
    });
    const result = normalizeRendererNativeResult(
      "coreConstructionPlacementContext",
      projection,
      context,
    );
    assert.deepEqual(result.support, { supported: false, reason });
    assert.equal(result.placement, null);
  }
});

test("renderer accepts the exact optional fields for ordinary power and splitter templates", () => {
  for (const [buildingId, templateFields] of [
    ["solar_panel", {
      kind: "power",
      generationPriority: 3,
      powerOutputKw: 0,
      powerInputKw: 0,
    }],
    ["splitter_4way", {
      kind: "splitter",
      distributionMode: "balanced",
    }],
  ]) {
    const projection = supportedProjection();
    projection.request = { ...projection.request, buildingId };
    projection.placement.entityTemplate = {
      ...projection.placement.entityTemplate,
      buildingId,
      ...templateFields,
    };
    const result = normalizeRendererNativeResult(
      "coreConstructionPlacementContext",
      projection,
      requestContext({ buildingId }),
    );
    assert.equal(result.placement.entityTemplate.kind, templateFields.kind);
  }
});
