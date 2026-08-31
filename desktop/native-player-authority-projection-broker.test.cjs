"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  NativePlayerAuthorityProjectionBroker,
} = require("./native-player-authority-projection-broker.cjs");

function fixture(initialSnapshot = {}) {
  let rendererTrusted = true;
  let now = 8_697_599_999;
  let snapshot = {
    phase: "active",
    sessionId: "core-main-1",
    runId: "run-1",
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
    async factoryInventoryProjection(ownerId, request) {
      calls.push(["factory-inventory-v1", ownerId, request]);
      return { projectionType: "factory-inventory-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async constructionInventoryProjection(ownerId, request) {
      calls.push(["construction-inventory-v1", ownerId, request]);
      return { projectionType: "construction-inventory-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async constructionPlacementContext(ownerId, request) {
      calls.push(["construction-placement-context-v1", ownerId, request]);
      return { projectionType: "construction-placement-context-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async constructionBeltPlacementContext(ownerId, request) {
      calls.push(["construction-belt-placement-context-v1", ownerId, request]);
      return { projectionType: "construction-belt-placement-context-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async constructionBeltLaneContext(ownerId, request) {
      calls.push(["construction-belt-lane-context-v1", ownerId, request]);
      return { projectionType: "construction-belt-lane-context-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async constructionBeltRemovalContext(ownerId, request) {
      calls.push(["construction-belt-removal-context-v1", ownerId, request]);
      return { projectionType: "construction-belt-removal-context-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async constructionRemovalContext(ownerId, request) {
      calls.push(["construction-removal-context-v1", ownerId, request]);
      return { projectionType: "construction-removal-context-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async constructionStackContext(ownerId, request) {
      calls.push(["construction-stack-context-v1", ownerId, request]);
      return { projectionType: "construction-stack-context-v1", schemaVersion: 1, revision: request.expectedRevision };
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
    async blueprintWorkspaceProjection(ownerId, request) {
      calls.push(["blueprint-workspace-v1", ownerId, request]);
      return { projectionType: "blueprint-workspace-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async blueprintCaptureContext(ownerId, request) {
      calls.push(["blueprint-capture-context-v1", ownerId, request]);
      return { projectionType: "blueprint-capture-context-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async blueprintImportContext(ownerId, request) {
      calls.push(["blueprint-import-context-v1", ownerId, request]);
      return { projectionType: "blueprint-import-context-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async blueprintExportContext(ownerId, request) {
      calls.push(["blueprint-export-context-v1", ownerId, request]);
      return { projectionType: "blueprint-export-context-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async blueprintEnqueueContext(ownerId, request) {
      calls.push(["blueprint-enqueue-context-v1", ownerId, request]);
      return { projectionType: "blueprint-enqueue-context-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async blueprintDirectDeployContext(ownerId, request) {
      calls.push(["blueprint-direct-deploy-context-v1", ownerId, request]);
      return { projectionType: "blueprint-direct-deploy-context-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async commandPaletteEntitySearchProjection(ownerId, request) {
      calls.push(["command-palette-entity-search-v1", ownerId, request]);
      return { projectionType: "command-palette-entity-search-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async starMapOverviewProjection(ownerId, request) {
      calls.push(["star-map-overview-v1", ownerId, request]);
      return { projectionType: "star-map-overview-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async starMapCatalogProjection(ownerId, request) {
      calls.push(["star-map-catalog-v1", ownerId, request]);
      return { projectionType: "star-map-catalog-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async stellarIndustryProjection(ownerId, request) {
      calls.push(["stellar-industry-v1", ownerId, request]);
      return { projectionType: "stellar-industry-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async stellarIndustryProjectionV2(ownerId, request) {
      calls.push(["stellar-industry-v2", ownerId, request]);
      return { projectionType: "stellar-industry-v2", schemaVersion: 2, revision: request.expectedRevision };
    },
    async stellarQuantumProjection(ownerId, request) {
      calls.push(["stellar-quantum-v1", ownerId, request]);
      return { projectionType: "stellar-quantum-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async dysonWorkspaceProjection(ownerId, request) {
      calls.push(["dyson-workspace-v1", ownerId, request]);
      return { projectionType: "dyson-workspace-v1", schemaVersion: 1, revision: request.expectedRevision };
    },
    async systemSpaceStationWorkspaceProjection(ownerId, request) {
      calls.push(["system-space-station-workspace-v1", ownerId, request]);
      return {
        projectionType: "system-space-station-workspace-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
      };
    },
    async orbitalContractWorkspaceProjection(ownerId, request) {
      calls.push(["orbital-contract-workspace-v1", ownerId, request]);
      return {
        projectionType: "orbital-contract-workspace-v1",
        schemaVersion: 1,
        sessionId: request.sessionId,
        runId: request.runId,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async campaignWorkspaceProjection(ownerId, request) {
      calls.push(["campaign-workspace-v1", ownerId, request]);
      return {
        projectionType: "campaign-workspace-v1",
        schemaVersion: 1,
        sessionId: request.sessionId,
        runId: request.runId,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async operationsWorkspaceProjection(ownerId, request) {
      calls.push(["operations-workspace-v1", ownerId, request]);
      return {
        projectionType: "operations-workspace-v1",
        schemaVersion: 1,
        sessionId: request.sessionId,
        runId: request.runId,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async galaxyAccountWorkspaceProjection(ownerId, request) {
      calls.push(["galaxy-account-workspace-v1", ownerId, request]);
      return {
        projectionType: "galaxy-account-workspace-v1",
        schemaVersion: 1,
        sessionId: request.sessionId,
        runId: request.runId,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
  };
  const broker = new NativePlayerAuthorityProjectionBroker({
    runtime: { snapshot: () => ({ ...snapshot }) },
    registry,
    ownerId: "main-player-authority",
    isTrustedRendererOwner: (ownerId) => rendererTrusted && ownerId === 23,
    now: () => now,
  });
  return {
    broker,
    calls,
    registry,
    setRendererTrusted(value) { rendererTrusted = value; },
    setSnapshot(value) { snapshot = { ...snapshot, ...value }; },
    setNow(value) { now = value; },
  };
}

test("active same-session same-revision reads use only the main owner identity", async () => {
  const value = fixture();
  for (const projectionType of ["viewport-v2", "factory-read-model-v1", "factory-inventory-v1", "construction-inventory-v1", "construction-placement-context-v1", "construction-belt-placement-context-v1", "construction-belt-lane-context-v1", "construction-belt-removal-context-v1", "construction-removal-context-v1", "construction-stack-context-v1", "statistics-v1", "technology-v1", "recipe-workspace-v1", "blueprint-workspace-v1", "blueprint-capture-context-v1", "blueprint-import-context-v1", "blueprint-export-context-v1", "blueprint-enqueue-context-v1", "blueprint-direct-deploy-context-v1", "command-palette-entity-search-v1", "star-map-overview-v1", "star-map-catalog-v1", "stellar-industry-v1", "stellar-industry-v2", "stellar-quantum-v1", "dyson-workspace-v1", "system-space-station-workspace-v1", "orbital-contract-workspace-v1", "campaign-workspace-v1", "operations-workspace-v1", "galaxy-account-workspace-v1"]) {
    const request = ["orbital-contract-workspace-v1", "campaign-workspace-v1", "operations-workspace-v1", "galaxy-account-workspace-v1"].includes(projectionType)
      ? {
          sessionId: "core-main-1",
          runId: "run-1",
          expectedRevision: 17,
          expectedRegistryFingerprint: "7df8cf3a",
        }
      : { sessionId: "core-main-1", expectedRevision: 17 };
    const result = await value.broker.read(23, projectionType, request);
    assert.equal(result.revision, 17);
  }
  assert.deepEqual(value.calls.map(([type, ownerId]) => [type, ownerId]), [
    ["viewport-v2", "main-player-authority"],
    ["factory-read-model-v1", "main-player-authority"],
    ["factory-inventory-v1", "main-player-authority"],
    ["construction-inventory-v1", "main-player-authority"],
    ["construction-placement-context-v1", "main-player-authority"],
    ["construction-belt-placement-context-v1", "main-player-authority"],
    ["construction-belt-lane-context-v1", "main-player-authority"],
    ["construction-belt-removal-context-v1", "main-player-authority"],
    ["construction-removal-context-v1", "main-player-authority"],
    ["construction-stack-context-v1", "main-player-authority"],
    ["statistics-v1", "main-player-authority"],
    ["technology-v1", "main-player-authority"],
    ["recipe-workspace-v1", "main-player-authority"],
    ["blueprint-workspace-v1", "main-player-authority"],
    ["blueprint-capture-context-v1", "main-player-authority"],
    ["blueprint-import-context-v1", "main-player-authority"],
    ["blueprint-export-context-v1", "main-player-authority"],
    ["blueprint-enqueue-context-v1", "main-player-authority"],
    ["blueprint-direct-deploy-context-v1", "main-player-authority"],
    ["command-palette-entity-search-v1", "main-player-authority"],
    ["star-map-overview-v1", "main-player-authority"],
    ["star-map-catalog-v1", "main-player-authority"],
    ["stellar-industry-v1", "main-player-authority"],
    ["stellar-industry-v2", "main-player-authority"],
    ["stellar-quantum-v1", "main-player-authority"],
    ["dyson-workspace-v1", "main-player-authority"],
    ["system-space-station-workspace-v1", "main-player-authority"],
    ["orbital-contract-workspace-v1", "main-player-authority"],
    ["campaign-workspace-v1", "main-player-authority"],
    ["operations-workspace-v1", "main-player-authority"],
    ["galaxy-account-workspace-v1", "main-player-authority"],
  ]);
});

test("orbital projections bind a fresh main clock on same-revision reads across Shanghai midnight", async () => {
  const value = fixture();
  const rendererRequest = Object.freeze({
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a",
  });
  await value.broker.read(23, "orbital-contract-workspace-v1", rendererRequest);
  value.setNow(8_697_600_000);
  await value.broker.read(23, "orbital-contract-workspace-v1", rendererRequest);
  const requests = value.calls
    .filter(([type]) => type === "orbital-contract-workspace-v1")
    .map(([, , request]) => request);
  assert.deepEqual(requests.map((request) => request.confirmedWallClockMs), [
    8_697_599_999,
    8_697_600_000,
  ]);
  assert.equal(Object.hasOwn(rendererRequest, "confirmedWallClockMs"), false);
  assert.notStrictEqual(requests[0], rendererRequest);
  await assert.rejects(value.broker.read(23, "orbital-contract-workspace-v1", {
    ...rendererRequest,
    confirmedWallClockMs: 1,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID");
});

test("orbital projection rejects stale active runs before and after an asynchronous read", async () => {
  const request = {
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a",
  };
  const stale = fixture({ runId: "run-2" });
  await assert.rejects(
    stale.broker.read(23, "orbital-contract-workspace-v1", request),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RUN_MISMATCH",
  );
  assert.equal(stale.calls.length, 0);

  const raced = fixture();
  raced.registry.orbitalContractWorkspaceProjection = async (ownerId, hostRequest) => {
    raced.calls.push(["orbital-contract-workspace-v1", ownerId, hostRequest]);
    raced.setSnapshot({ runId: "run-2" });
    return {
      projectionType: "orbital-contract-workspace-v1",
      schemaVersion: 1,
      sessionId: hostRequest.sessionId,
      runId: hostRequest.runId,
      revision: 17,
      registryFingerprint: hostRequest.expectedRegistryFingerprint,
    };
  };
  await assert.rejects(
    raced.broker.read(23, "orbital-contract-workspace-v1", request),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RUN_MISMATCH",
  );

  const mismatchedResult = fixture();
  mismatchedResult.registry.orbitalContractWorkspaceProjection = async () => ({
    projectionType: "orbital-contract-workspace-v1",
    schemaVersion: 1,
    sessionId: "core-main-1",
    runId: "run-1",
    revision: 17,
    registryFingerprint: "ffffffff",
  });
  await assert.rejects(
    mismatchedResult.broker.read(23, "orbital-contract-workspace-v1", request),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RESULT_MISMATCH",
  );
});

test("campaign, Operations, and Galaxy exact-lineage reads reject same-revision old runs before and after read", async () => {
  const request = {
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a",
  };
  for (const projectionType of ["campaign-workspace-v1", "operations-workspace-v1", "galaxy-account-workspace-v1"]) {
    const stale = fixture({ runId: "run-2", revision: 17 });
    await assert.rejects(stale.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RUN_MISMATCH");

    const changed = fixture();
    const method = projectionType === "campaign-workspace-v1"
      ? "campaignWorkspaceProjection"
      : projectionType === "operations-workspace-v1"
        ? "operationsWorkspaceProjection"
        : "galaxyAccountWorkspaceProjection";
    changed.registry[method] = async (_ownerId, input) => {
      changed.setSnapshot({ runId: "run-2", revision: 17 });
      return {
        projectionType,
        schemaVersion: 1,
        sessionId: input.sessionId,
        runId: input.runId,
        revision: input.expectedRevision,
        registryFingerprint: input.expectedRegistryFingerprint,
      };
    };
    await assert.rejects(changed.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RUN_MISMATCH");
  }
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
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "factory-inventory-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?"construction-inventory-v1",[\s\S]*?request/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "statistics-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "technology-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "recipe-workspace-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?"command-palette-entity-search-v1",[\s\S]*?request/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "star-map-overview-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "star-map-catalog-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "stellar-industry-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "stellar-industry-v2", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "stellar-quantum-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "dyson-workspace-v1", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?"system-space-station-workspace-v1",[\s\S]*?request/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\.read\([\s\S]*?"campaign-workspace-v1",[\s\S]*?request/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\.read\([\s\S]*?"operations-workspace-v1",[\s\S]*?request/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\.read\([\s\S]*?"galaxy-account-workspace-v1",[\s\S]*?request/);
  assert.match(preload, /getNativePlayerAuthorityState/);
  assert.match(preload, /onNativePlayerAuthorityState/);
  assert.doesNotMatch(preload, /activateNativePlayerAuthority|commitNativePlayerAuthority|retryNativePlayerAuthority/);
  assert.match(preload, /normalizeAuthorityWorkspacePreloadRequest[\s\S]*?"sessionId", "runId", "expectedRevision", "expectedRegistryFingerprint"/);
  assert.doesNotMatch(preload, /macroSessionId|operationId|main-player-authority/);
  assert.doesNotMatch(broker, /\.preparePlayerAuthority|\.activatePlayerAuthority|\.commitPlayerAuthorityTick|\.applyCommand|\.advance\(/);
});
