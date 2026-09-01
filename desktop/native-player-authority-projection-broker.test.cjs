"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  nativeProjectionHasPlayerAuthorityRun,
  NativePlayerAuthorityProjectionBroker,
  routeNativeProjectionRead,
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
  let session = {
    kind: "native-core-session-owner-state-v1",
    sessionId: "core-main-1",
    ownerId: "main-player-authority",
    slot: "normal-main",
    registryFingerprint: "7df8cf3a",
    ownerEpoch: 2,
    state: "owned",
    inFlight: 0,
  };
  const calls = [];
  const registry = {
    inspectSession(ownerId, sessionId) {
      if (ownerId !== session.ownerId || sessionId !== session.sessionId) {
        const error = new Error("native core session is not owned by this caller");
        error.code = "NATIVE_CORE_SESSION_INVALID";
        throw error;
      }
      return Object.freeze({ ...session });
    },
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
      return {
        projectionType: "factory-inventory-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async constructionInventoryProjection(ownerId, request) {
      calls.push(["construction-inventory-v1", ownerId, request]);
      return {
        projectionType: "construction-inventory-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
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
      return {
        projectionType: "recipe-workspace-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async blueprintWorkspaceProjection(ownerId, request) {
      calls.push(["blueprint-workspace-v1", ownerId, request]);
      return {
        projectionType: "blueprint-workspace-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
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
      return {
        projectionType: "command-palette-entity-search-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async starMapOverviewProjection(ownerId, request) {
      calls.push(["star-map-overview-v1", ownerId, request]);
      return {
        projectionType: "star-map-overview-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async starMapCatalogProjection(ownerId, request) {
      calls.push(["star-map-catalog-v1", ownerId, request]);
      return {
        projectionType: "star-map-catalog-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async stellarIndustryProjection(ownerId, request) {
      calls.push(["stellar-industry-v1", ownerId, request]);
      return {
        projectionType: "stellar-industry-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async stellarIndustryProjectionV2(ownerId, request) {
      calls.push(["stellar-industry-v2", ownerId, request]);
      return {
        projectionType: "stellar-industry-v2",
        schemaVersion: 2,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async stellarQuantumProjection(ownerId, request) {
      calls.push(["stellar-quantum-v1", ownerId, request]);
      return {
        projectionType: "stellar-quantum-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
    },
    async dysonWorkspaceProjection(ownerId, request) {
      calls.push(["dyson-workspace-v1", ownerId, request]);
      return {
        projectionType: "dyson-workspace-v1",
        schemaVersion: 1,
        revision: request.expectedRevision,
        registryFingerprint: request.expectedRegistryFingerprint,
      };
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
    setSession(value) { session = { ...session, ...value }; },
    setSnapshot(value) { snapshot = { ...snapshot, ...value }; },
    setNow(value) { now = value; },
  };
}

test("active same-session same-revision reads use only the main owner identity", async () => {
  const value = fixture();
  for (const projectionType of ["viewport-v2", "factory-read-model-v1", "factory-inventory-v1", "construction-inventory-v1", "construction-placement-context-v1", "construction-belt-placement-context-v1", "construction-belt-lane-context-v1", "construction-belt-removal-context-v1", "construction-removal-context-v1", "construction-stack-context-v1", "statistics-v1", "technology-v1", "recipe-workspace-v1", "blueprint-workspace-v1", "blueprint-capture-context-v1", "blueprint-import-context-v1", "blueprint-export-context-v1", "blueprint-enqueue-context-v1", "blueprint-direct-deploy-context-v1", "command-palette-entity-search-v1", "star-map-overview-v1", "star-map-catalog-v1", "stellar-industry-v1", "stellar-industry-v2", "stellar-quantum-v1", "dyson-workspace-v1", "system-space-station-workspace-v1", "orbital-contract-workspace-v1", "campaign-workspace-v1", "operations-workspace-v1", "galaxy-account-workspace-v1"]) {
    const request = projectionType === "statistics-v1"
      ? {
          sessionId: "core-main-1",
          runId: "run-1",
          expectedRevision: 17,
          expectedRegistryFingerprint: "7df8cf3a",
          minElapsedSeconds: 0,
          maxElapsedSeconds: 100,
          cursor: 0,
          limit: 32,
        }
      : [
          "factory-inventory-v1",
          "construction-inventory-v1",
          "blueprint-workspace-v1",
          "technology-v1",
          "recipe-workspace-v1",
          "command-palette-entity-search-v1",
          "star-map-overview-v1",
          "star-map-catalog-v1",
          "stellar-industry-v1",
          "stellar-industry-v2",
          "stellar-quantum-v1",
          "dyson-workspace-v1",
          "orbital-contract-workspace-v1",
          "campaign-workspace-v1",
          "operations-workspace-v1",
          "galaxy-account-workspace-v1",
        ].includes(projectionType)
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

test("campaign and Galaxy reads bind registry and owner epoch across delivery", async () => {
  const request = {
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a",
  };
  for (const [projectionType, method] of [
    ["campaign-workspace-v1", "campaignWorkspaceProjection"],
    ["galaxy-account-workspace-v1", "galaxyAccountWorkspaceProjection"],
  ]) {
    const wrongRegistry = fixture();
    wrongRegistry.setSession({ registryFingerprint: "ffffffff" });
    await assert.rejects(wrongRegistry.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REGISTRY_MISMATCH");
    assert.equal(wrongRegistry.calls.length, 0);

    const result = (input) => ({
      projectionType,
      schemaVersion: 1,
      sessionId: input.sessionId,
      runId: input.runId,
      revision: input.expectedRevision,
      registryFingerprint: input.expectedRegistryFingerprint,
    });
    const registryRace = fixture();
    registryRace.registry[method] = async (_ownerId, input) => {
      registryRace.setSession({ registryFingerprint: "ffffffff" });
      return result(input);
    };
    await assert.rejects(registryRace.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REGISTRY_MISMATCH");

    const handoffRace = fixture();
    handoffRace.registry[method] = async (_ownerId, input) => {
      handoffRace.setSession({ ownerEpoch: 3 });
      return result(input);
    };
    await assert.rejects(handoffRace.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_LINEAGE_MISMATCH");
  }
});

test("technology, recipe, and Dyson reads reject ABA runs and owner handoff across delivery", async () => {
  const request = {
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a",
  };
  for (const [projectionType, method] of [
    ["technology-v1", "technologyProjection"],
    ["recipe-workspace-v1", "recipeWorkspaceProjection"],
    ["dyson-workspace-v1", "dysonWorkspaceProjection"],
  ]) {
    const stale = fixture({ runId: "run-2", revision: 17 });
    await assert.rejects(stale.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RUN_MISMATCH");
    assert.equal(stale.calls.length, 0);

    const handoffRace = fixture();
    handoffRace.registry[method] = async (_ownerId, input) => {
      handoffRace.setSession({ ownerEpoch: 3 });
      return {
        projectionType,
        schemaVersion: 1,
        revision: input.expectedRevision,
        ...(projectionType === "technology-v1"
          ? {}
          : { registryFingerprint: input.expectedRegistryFingerprint }),
      };
    };
    await assert.rejects(handoffRace.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_LINEAGE_MISMATCH");
  }
});

test("recipe and Dyson result registries remain bound to the requested content pack", async () => {
  const request = {
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a",
  };
  for (const [projectionType, method] of [
    ["recipe-workspace-v1", "recipeWorkspaceProjection"],
    ["dyson-workspace-v1", "dysonWorkspaceProjection"],
  ]) {
    const value = fixture();
    value.registry[method] = async (_ownerId, input) => ({
      projectionType,
      schemaVersion: 1,
      revision: input.expectedRevision,
      registryFingerprint: "ffffffff",
    });
    await assert.rejects(value.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RESULT_MISMATCH");
  }
});

test("technology, recipe, and Dyson require complete run and registry lineage tags", async () => {
  const value = fixture();
  for (const projectionType of ["technology-v1", "recipe-workspace-v1", "dyson-workspace-v1"]) {
    await assert.rejects(value.broker.read(23, projectionType, {
      sessionId: "core-main-1", runId: "run-1", expectedRevision: 17,
    }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID");
    await assert.rejects(value.broker.read(23, projectionType, {
      sessionId: "core-main-1", expectedRevision: 17, expectedRegistryFingerprint: "7df8cf3a",
    }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID");
  }
});

test("inventory, blueprint, search, and stellar reads fence run, registry, owner epoch, and result registry", async () => {
  const request = {
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a",
  };
  for (const [projectionType, method] of [
    ["factory-inventory-v1", "factoryInventoryProjection"],
    ["construction-inventory-v1", "constructionInventoryProjection"],
    ["blueprint-workspace-v1", "blueprintWorkspaceProjection"],
    ["command-palette-entity-search-v1", "commandPaletteEntitySearchProjection"],
    ["star-map-overview-v1", "starMapOverviewProjection"],
    ["star-map-catalog-v1", "starMapCatalogProjection"],
    ["stellar-industry-v1", "stellarIndustryProjection"],
    ["stellar-industry-v2", "stellarIndustryProjectionV2"],
    ["stellar-quantum-v1", "stellarQuantumProjection"],
  ]) {
    const staleRun = fixture({ runId: "run-2", revision: 17 });
    await assert.rejects(staleRun.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RUN_MISMATCH");
    assert.equal(staleRun.calls.length, 0);

    const wrongRegistry = fixture();
    wrongRegistry.setSession({ registryFingerprint: "ffffffff" });
    await assert.rejects(wrongRegistry.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REGISTRY_MISMATCH");
    assert.equal(wrongRegistry.calls.length, 0);

    const handoffRace = fixture();
    handoffRace.registry[method] = async (_ownerId, input) => {
      handoffRace.setSession({ ownerEpoch: 3 });
      return {
        projectionType,
        schemaVersion: projectionType === "stellar-industry-v2" ? 2 : 1,
        revision: input.expectedRevision,
        registryFingerprint: input.expectedRegistryFingerprint,
      };
    };
    await assert.rejects(handoffRace.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_LINEAGE_MISMATCH");

    const registryRace = fixture();
    registryRace.registry[method] = async (_ownerId, input) => {
      registryRace.setSession({ registryFingerprint: "ffffffff" });
      return {
        projectionType,
        schemaVersion: projectionType === "stellar-industry-v2" ? 2 : 1,
        revision: input.expectedRevision,
        registryFingerprint: input.expectedRegistryFingerprint,
      };
    };
    await assert.rejects(registryRace.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REGISTRY_MISMATCH");

    const forgedResult = fixture();
    forgedResult.registry[method] = async (_ownerId, input) => ({
      projectionType,
      schemaVersion: projectionType === "stellar-industry-v2" ? 2 : 1,
      revision: input.expectedRevision,
      registryFingerprint: "ffffffff",
    });
    await assert.rejects(forgedResult.broker.read(23, projectionType, request),
      (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RESULT_MISMATCH");
  }

  const partial = fixture();
  for (const projectionType of [
    "factory-inventory-v1",
    "construction-inventory-v1",
    "blueprint-workspace-v1",
    "command-palette-entity-search-v1",
    "star-map-overview-v1",
    "star-map-catalog-v1",
    "stellar-industry-v1",
    "stellar-industry-v2",
    "stellar-quantum-v1",
  ]) {
    await assert.rejects(partial.broker.read(23, projectionType, {
      sessionId: "core-main-1",
      expectedRevision: 17,
      expectedRegistryFingerprint: "7df8cf3a",
    }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID");
  }
});

test("statistics player-authority reads reject old runs before and after an asynchronous read", async () => {
  const request = {
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a",
    minElapsedSeconds: 0,
    maxElapsedSeconds: 100,
    cursor: 0,
    limit: 32,
  };
  const stale = fixture({ runId: "run-2" });
  await assert.rejects(stale.broker.read(23, "statistics-v1", request),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RUN_MISMATCH");
  assert.equal(stale.calls.length, 0);

  const raced = fixture();
  raced.registry.statisticsProjection = async (ownerId, input) => {
    raced.calls.push(["statistics-v1", ownerId, input]);
    raced.setSnapshot({ runId: "run-2" });
    return { projectionType: "statistics-v1", schemaVersion: 1, revision: 17 };
  };
  await assert.rejects(raced.broker.read(23, "statistics-v1", request),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_RUN_MISMATCH");
});

test("statistics player-authority reads bind registry and owner epoch across delivery", async () => {
  const request = {
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a",
    minElapsedSeconds: 0,
    maxElapsedSeconds: 100,
    cursor: 0,
    limit: 32,
  };
  const wrongRegistry = fixture();
  wrongRegistry.setSession({ registryFingerprint: "ffffffff" });
  await assert.rejects(wrongRegistry.broker.read(23, "statistics-v1", request),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REGISTRY_MISMATCH");
  assert.equal(wrongRegistry.calls.length, 0);

  const registryRace = fixture();
  registryRace.registry.statisticsProjection = async (_ownerId, input) => {
    registryRace.setSession({ registryFingerprint: "ffffffff" });
    return { projectionType: "statistics-v1", schemaVersion: 1, revision: input.expectedRevision };
  };
  await assert.rejects(registryRace.broker.read(23, "statistics-v1", request),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REGISTRY_MISMATCH");

  const handoffRace = fixture();
  handoffRace.registry.statisticsProjection = async (_ownerId, input) => {
    handoffRace.setSession({ ownerEpoch: 3 });
    return { projectionType: "statistics-v1", schemaVersion: 1, revision: input.expectedRevision };
  };
  await assert.rejects(handoffRace.broker.read(23, "statistics-v1", request),
    (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_LINEAGE_MISMATCH");
});

test("statistics requires both player-authority lineage tags while preserving untagged shadow compatibility", async () => {
  const value = fixture();
  await assert.rejects(value.broker.read(23, "statistics-v1", {
    sessionId: "core-main-1", runId: "run-1", expectedRevision: 17,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID");
  await assert.rejects(value.broker.read(23, "statistics-v1", {
    sessionId: "core-main-1", expectedRevision: 17, expectedRegistryFingerprint: "7df8cf3a",
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID");
  await assert.rejects(value.broker.read(23, "statistics-v1", {
    sessionId: "core-main-1", runId: "run-1", expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a", unexpected: true,
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID");

  await assert.doesNotReject(value.broker.read(23, "statistics-v1", {
    sessionId: "core-main-1", expectedRevision: 17,
  }));
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

test("tagged projection routing never falls through to shadow after authority ownership changes", async () => {
  let authorityReads = 0;
  let shadowReads = 0;
  const authorityError = Object.assign(new Error("authority session no longer owns this id"), {
    code: "NATIVE_PLAYER_AUTHORITY_PROJECTION_SESSION_MISMATCH",
  });
  const broker = {
    ownsSession() {
      return false;
    },
    async read() {
      authorityReads += 1;
      throw authorityError;
    },
  };
  const request = {
    sessionId: "shadow-session-1",
    runId: "main-run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "registry-1",
  };

  assert.equal(nativeProjectionHasPlayerAuthorityRun(request), true);
  await assert.rejects(routeNativeProjectionRead({
    broker,
    ownerId: 23,
    projectionType: "factory-inventory-v1",
    request,
    shadowRead: async () => {
      shadowReads += 1;
      return { source: "shadow" };
    },
  }), (error) => error === authorityError);
  assert.equal(authorityReads, 1);
  assert.equal(shadowReads, 0);

  await assert.rejects(routeNativeProjectionRead({
    broker: null,
    ownerId: 23,
    projectionType: "factory-inventory-v1",
    request,
    shadowRead: async () => {
      shadowReads += 1;
      return { source: "shadow" };
    },
  }), (error) => error.code === "NATIVE_PLAYER_AUTHORITY_PROJECTION_UNAVAILABLE");
  assert.equal(shadowReads, 0);
});

test("untagged legacy projection routing remains compatible with shadow sessions", async () => {
  let authorityReads = 0;
  let shadowReads = 0;
  const request = {
    sessionId: "shadow-session-1",
    expectedRevision: 17,
    // Registry identity predates the authority-only run tag and remains valid
    // for renderer-owned shadow projections.
    expectedRegistryFingerprint: "registry-1",
  };
  const broker = {
    ownsSession() {
      return false;
    },
    async read() {
      authorityReads += 1;
      return { source: "authority" };
    },
  };

  assert.equal(nativeProjectionHasPlayerAuthorityRun(request), false);
  const result = await routeNativeProjectionRead({
    broker,
    ownerId: 23,
    projectionType: "factory-inventory-v1",
    request,
    shadowRead: async () => {
      shadowReads += 1;
      return { source: "shadow" };
    },
  });
  assert.deepEqual(result, { source: "shadow" });
  assert.equal(authorityReads, 0);
  assert.equal(shadowReads, 1);
});

test("main routes matching authority reads and keeps identity-bearing control out of preload", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  const broker = readFileSync("desktop/native-player-authority-projection-broker.cjs", "utf8");
  const routedHandlers = [
    ["desktop:native-core-factory-inventory", "factory-inventory-v1", "factoryInventoryProjection"],
    ["desktop:native-core-construction-inventory", "construction-inventory-v1", "constructionInventoryProjection"],
    ["desktop:native-core-blueprint-workspace", "blueprint-workspace-v1", "blueprintWorkspaceProjection"],
    ["desktop:native-core-command-palette-entity-search", "command-palette-entity-search-v1", "commandPaletteEntitySearchProjection"],
    ["desktop:native-core-star-map-overview-projection", "star-map-overview-v1", "starMapOverviewProjection"],
    ["desktop:native-core-star-map-catalog-projection", "star-map-catalog-v1", "starMapCatalogProjection"],
    ["desktop:native-core-stellar-industry-projection", "stellar-industry-v1", "stellarIndustryProjection"],
    ["desktop:native-core-stellar-industry-v2-projection", "stellar-industry-v2", "stellarIndustryProjectionV2"],
    ["desktop:native-core-stellar-quantum-projection", "stellar-quantum-v1", "stellarQuantumProjection"],
  ];

  assert.match(main, /new NativePlayerAuthorityProjectionBroker\(\{[\s\S]*?runtime:\s*nativePlayerAuthorityRuntime[\s\S]*?registry:\s*nativeCoreSessions/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "viewport-v2", request\)/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "factory-read-model-v1", request\)/);
  for (const [channel, projectionType, shadowMethod] of routedHandlers) {
    const start = main.indexOf(`ipcMain.handle("${channel}"`);
    assert.notEqual(start, -1, `${channel} handler must exist`);
    const next = main.indexOf("\nipcMain.", start + 1);
    const handler = main.slice(start, next === -1 ? main.length : next);
    assert.match(handler, /return await routeNativeProjectionRead\(\{/);
    assert.ok(handler.includes(`projectionType: "${projectionType}"`));
    assert.ok(handler.includes(`shadowRead: () => nativeCoreSessions.${shadowMethod}`));
  }
  assert.match(main, /nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "statistics-v1", request\)/);
  const statisticsHandler = main.slice(
    main.indexOf('ipcMain.handle("desktop:native-core-statistics-projection"'),
    main.indexOf('ipcMain.handle("desktop:native-core-technology-projection"'),
  );
  assert.match(statisticsHandler, /hasPlayerAuthorityLineage \|\| nativePlayerAuthorityProjectionBroker\?\.ownsSession/);
  assert.ok(statisticsHandler.indexOf('nativePlayerAuthorityProjectionBroker.read(ownerId, "statistics-v1", request)') <
    statisticsHandler.indexOf("nativeCoreSessions.statisticsProjection(ownerId, request)"));
  assert.match(main, /nativeStatisticsProjectionHasPlayerAuthorityLineage[\s\S]*?Object\.hasOwn\(request, "runId"\)[\s\S]*?Object\.hasOwn\(request, "expectedRegistryFingerprint"\)/);
  assert.match(main, /nativeProjectionHasPlayerAuthorityRun\(request\) \|\|[\s\S]*?nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "technology-v1", request\)/);
  assert.match(main, /nativeProjectionHasPlayerAuthorityRun\(request\) \|\|[\s\S]*?nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "recipe-workspace-v1", request\)/);
  assert.match(main, /nativeProjectionHasPlayerAuthorityRun\(request\) \|\|[\s\S]*?nativePlayerAuthorityProjectionBroker\?\.ownsSession\(request\?\.sessionId\)[\s\S]*?nativePlayerAuthorityProjectionBroker\.read\(ownerId, "dyson-workspace-v1", request\)/);
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
