"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  NativePlayerAuthorityProjectionBroker,
} = require("./native-player-authority-projection-broker.cjs");

function fixture(initialSnapshot = {}) {
  let rendererTrusted = true;
  let snapshot = {
    phase: "active",
    sessionId: "core-main-1",
    revision: 17,
    inFlight: false,
    ...initialSnapshot,
  };
  const calls = [];
  const registry = {
    async viewportProjectionV2(ownerId, request) {
      calls.push(["viewport-v2", ownerId, request]);
      return { projectionType: "viewport-v2", schemaVersion: 2, revision: request.expectedRevision };
    },
    async factoryReadModelProjection(ownerId, request) {
      calls.push(["factory-read-model-v1", ownerId, request]);
      return { projectionType: "factory-read-model-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async statisticsProjection(ownerId, request) {
      calls.push(["statistics-v1", ownerId, request]);
      return { projectionType: "statistics-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async technologyProjection(ownerId, request) {
      calls.push(["technology-v1", ownerId, request]);
      return { projectionType: "technology-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async recipeWorkspaceProjection(ownerId, request) {
      calls.push(["recipe-workspace-v1", ownerId, request]);
      return { projectionType: "recipe-workspace-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async commandPaletteEntitySearchProjection(ownerId, request) {
      calls.push(["command-palette-entity-search-v1", ownerId, request]);
      return { projectionType: "command-palette-entity-search-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async starMapOverviewProjection(ownerId, request) {
      calls.push(["star-map-overview-v1", ownerId, request]);
      return { projectionType: "star-map-overview-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async stellarIndustryProjection(ownerId, request) {
      calls.push(["stellar-industry-v1", ownerId, request]);
      return { projectionType: "stellar-industry-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async stellarIndustryProjectionV2(ownerId, request) {
      calls.push(["stellar-industry-v2", ownerId, request]);
      return { projectionType: "stellar-industry-v2", schemaVersion: 2, revision: request.expectedRevision };
    },
  };
  const broker = new NativePlayerAuthorityProjectionBroker({
    runtime: { snapshot: () => ({ ...snapshot }) },
    registry,
    ownerId: "main-player-authority",
    isTrustedRendererOwner: (ownerId) => rendererTrusted && ownerId === 23,
  });
  return {
    broker,
    calls,
    registry,
    setRendererTrusted(value) { rendererTrusted = value; },
    setSnapshot(value) { snapshot = { ...snapshot, ...value }; },
  };
}

test("active same-session same-revision reads use only the main owner identity", async () => {
  const value = fixture();
  for (const projectionType of ["viewport-v2", "factory-read-model-v1", "statistics-v1", "technology-v1", "recipe-workspace-v1", "command-palette-entity-search-v1", "star-map-overview-v1", "stellar-industry-v1", "stellar-industry-v2"]) {
    const request = { sessionId: "core-main-1", expectedRevision: 17 };
    const result = await value.broker.read(23, projectionType, request);
    assert.equal(result.revision, 17);
  }
  assert.deepEqual(value.calls.map(([type, ownerId]) => [type, ownerId]), [
    ["viewport-v2", "main-player-authority"],
    ["factory-read-model-v1", "main-player-authority"],
    ["statistics-v1", "main-player-authority"],
    ["technology-v1", "main-player-authority"],
    ["recipe-workspace-v1", "main-player-authority"],
    ["command-palette-entity-search-v1", "main-player-authority"],
    ["star-map-overview-v1", "main-player-authority"],
    ["stellar-industry-v1", "main-player-authority"],
    ["stellar-industry-v2", "main-player-authority"],
  ]);
});

test("untrusted renderer, unsupported projections, wrong sessions, and old revisions fail closed", async () => {
  const value = fixture();
  await assert.rejects(value.broker.read(99, "viewport-v2", {
    sessionId: "core-main-1", expectedRevision: 17,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RENDERER_UNTRUSTED");
  await assert.rejects(value.broker.read(23, "viewport-v1", {
    sessionId: "core-main-1", expectedRevision: 17,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID");
  await assert.rejects(value.broker.read(23, "viewport-v2", {
    sessionId: "core-other", expectedRevision: 17,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_SESSION_MISMATCH");
  await assert.rejects(value.broker.read(23, "viewport-v2", {
    sessionId: "core-main-1", expectedRevision: 16,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REVISION_MISMATCH");
  await assert.rejects(value.broker.read(23, "statistics-v1", {
    sessionId: "core-main-1",
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID");
  assert.equal(value.calls.length, 0);
});

test("uncertain, faulted, shutdown, and in-flight authority phases remain routed but unreadable", async () => {
  for (const snapshot of [
    { phase: "uncertain", inFlight: false },
    { phase: "faulted", inFlight: false },
    { phase: "shutdown", inFlight: false },
    { phase: "active", inFlight: true },
  ]) {
    const value = fixture(snapshot);
    assert.equal(value.broker.ownsSession("core-main-1"), true);
    await assert.rejects(value.broker.read(23, "factory-read-model-v1", {
      sessionId: "core-main-1", expectedRevision: 17,
    }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_UNAVAILABLE");
    assert.equal(value.calls.length, 0);
  }
});

test("a tick or phase transition during an asynchronous read discards the result", async () => {
  const value = fixture();
  value.registry.viewportProjectionV2 = async (ownerId, request) => {
    value.calls.push(["viewport-v2", ownerId, request]);
    value.setSnapshot({ revision: 18 });
    return { projectionType: "viewport-v2", schemaVersion: 2, revision: 17 };
  };
  await assert.rejects(value.broker.read(23, "viewport-v2", {
    sessionId: "core-main-1", expectedRevision: 17,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REVISION_MISMATCH");

  const stale = fixture();
  stale.registry.statisticsProjection = async () => ({
    projectionType: "statistics-v1", schemaVersion: 1, revision: 18,
  });
  await assert.rejects(stale.broker.read(23, "statistics-v1", {
    sessionId: "core-main-1", expectedRevision: 17,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RESULT_MISMATCH");

  const closedRenderer = fixture();
  closedRenderer.registry.factoryReadModelProjection = async () => {
    closedRenderer.setRendererTrusted(false);
    return { projectionType: "factory-read-model-v1", schemaVersion: 1, revision: 17 };
  };
  await assert.rejects(closedRenderer.broker.read(23, "factory-read-model-v1", {
    sessionId: "core-main-1", expectedRevision: 17,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RENDERER_UNTRUSTED");
});

test("main routes matching authority reads and keeps identity-bearing control out of preload", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  const broker = readFileSync("desktop/native-player-authority-projection-broker.cjs", "utf8");

  assert.match(main, /new NativePlayerAuthorityProjectionBroker\(\{[\s\S]*?runtime:\s*nativePlayerAuthorityRuntime[\s\S]*?registry:\s*nativeCoreSessions/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "viewport-v2", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "factory-read-model-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "statistics-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "technology-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "recipe-workspace-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?"command-palette-entity-search-v1",[\s\S]*?request/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "star-map-overview-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "stellar-industry-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "stellar-industry-v2", request\)/);
  assert.match(preload, /getNativePlayerAuthorityState/);
  assert.match(preload, /onNativePlayerAuthorityState/);
  assert.doesNotMatch(preload, /activateNativePlayerAuthority|commitNativePlayerAuthority|retryNativePlayerAuthority/);
  assert.doesNotMatch(preload, /macroSessionId|operationId|runId|main-player-authority/);
  assert.doesNotMatch(broker, /\.preparePlayerAuthority|\.activatePlayerAuthority|\.commitPlayerAuthorityTick|\.applyCommand|\.advance\(/);
});
