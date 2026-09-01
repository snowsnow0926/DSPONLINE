"use strict";

/*
 * Main-process-only read broker for a future Rust player-authority session.
 *
 * The broker deliberately exposes only bounded thin-UI projections.
 * It cannot open, activate, advance, mutate, checkpoint, or close a session.
 * Existing renderer-owned shadow sessions bypass this module in main.cjs.
 */

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

const PROJECTION_METHODS = Object.freeze({
  "viewport-v2": "viewportProjectionV2",
  "factory-read-model-v1": "factoryReadModelProjection",
  "factory-inventory-v1": "factoryInventoryProjection",
  "construction-inventory-v1": "constructionInventoryProjection",
  "blueprint-workspace-v1": "blueprintWorkspaceProjection",
  "blueprint-capture-context-v1": "blueprintCaptureContext",
  "blueprint-import-context-v1": "blueprintImportContext",
  "blueprint-export-context-v1": "blueprintExportContext",
  "blueprint-enqueue-context-v1": "blueprintEnqueueContext",
  "blueprint-direct-deploy-context-v1": "blueprintDirectDeployContext",
  "construction-placement-context-v1": "constructionPlacementContext",
  "construction-belt-placement-context-v1": "constructionBeltPlacementContext",
  "construction-belt-lane-context-v1": "constructionBeltLaneContext",
  "construction-belt-removal-context-v1": "constructionBeltRemovalContext",
  "construction-removal-context-v1": "constructionRemovalContext",
  "construction-stack-context-v1": "constructionStackContext",
  "statistics-v1": "statisticsProjection",
  "technology-v1": "technologyProjection",
  "recipe-workspace-v1": "recipeWorkspaceProjection",
  "command-palette-entity-search-v1": "commandPaletteEntitySearchProjection",
  "star-map-overview-v1": "starMapOverviewProjection",
  "star-map-catalog-v1": "starMapCatalogProjection",
  "stellar-industry-v1": "stellarIndustryProjection",
  "stellar-industry-v2": "stellarIndustryProjectionV2",
  "stellar-quantum-v1": "stellarQuantumProjection",
  "dyson-workspace-v1": "dysonWorkspaceProjection",
  "system-space-station-workspace-v1": "systemSpaceStationWorkspaceProjection",
  "orbital-contract-workspace-v1": "orbitalContractWorkspaceProjection",
  "campaign-workspace-v1": "campaignWorkspaceProjection",
  "operations-workspace-v1": "operationsWorkspaceProjection",
  "galaxy-account-workspace-v1": "galaxyAccountWorkspaceProjection",
});
const EXACT_LINEAGE_WORKSPACE_PROJECTIONS = new Set([
  "orbital-contract-workspace-v1",
  "campaign-workspace-v1",
  "operations-workspace-v1",
  "galaxy-account-workspace-v1",
]);
const STATISTICS_LINEAGE_KEYS = new Set([
  "sessionId", "runId", "expectedRevision", "expectedRegistryFingerprint",
  "minElapsedSeconds", "maxElapsedSeconds", "cursor", "limit", "planetId", "itemId",
]);
const OWNER_LINEAGE_FENCED_PROJECTIONS = new Set([
  "statistics-v1",
  "technology-v1",
  "recipe-workspace-v1",
  "dyson-workspace-v1",
  "campaign-workspace-v1",
  "galaxy-account-workspace-v1",
]);
const OWNER_LINEAGE_REQUIRED_PROJECTIONS = new Set([
  ...EXACT_LINEAGE_WORKSPACE_PROJECTIONS,
  "technology-v1",
  "recipe-workspace-v1",
  "dyson-workspace-v1",
]);
const REGISTRY_RESULT_FENCED_PROJECTIONS = new Set([
  "recipe-workspace-v1",
  "dyson-workspace-v1",
]);

class NativePlayerAuthorityProjectionBrokerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "NativePlayerAuthorityProjectionBrokerError";
    this.code = code;
  }
}

function brokerError(message, code) {
  return new NativePlayerAuthorityProjectionBrokerError(message, code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Reflect.ownKeys(value).every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function validLogicalId(value, maximumLength = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    LOGICAL_ID_PATTERN.test(value);
}

function assertAuthoritySnapshot(snapshot, request) {
  if (!isRecord(snapshot) || snapshot.phase !== "active" || snapshot.inFlight !== false) {
    throw brokerError(
      "native player-authority projections require an active settled authority clock",
      "NATIVE_PLAYER_AUTHORITY_PROJECTION_UNAVAILABLE",
    );
  }
  if (snapshot.sessionId !== request.sessionId) {
    throw brokerError(
      "native player-authority projection session does not match the active authority session",
      "NATIVE_PLAYER_AUTHORITY_PROJECTION_SESSION_MISMATCH",
    );
  }
  if (Object.hasOwn(request, "runId") && snapshot.runId !== request.runId) {
    throw brokerError(
      "native player-authority projection run does not match the active authority run",
      "NATIVE_PLAYER_AUTHORITY_PROJECTION_RUN_MISMATCH",
    );
  }
  if (snapshot.revision !== request.expectedRevision) {
    throw brokerError(
      "native player-authority projection revision is no longer current",
      "NATIVE_PLAYER_AUTHORITY_PROJECTION_REVISION_MISMATCH",
    );
  }
}

function statisticsRequestHasLineage(request) {
  return Object.hasOwn(request, "runId") || Object.hasOwn(request, "expectedRegistryFingerprint");
}

function validStatisticsLineageRequest(request) {
  const hasRunId = Object.hasOwn(request, "runId");
  const hasRegistry = Object.hasOwn(request, "expectedRegistryFingerprint");
  return hasRunId === hasRegistry && (!hasRunId || (
    validLogicalId(request.runId) && validLogicalId(request.expectedRegistryFingerprint, 256) &&
    Reflect.ownKeys(request).every((key) => typeof key === "string" && STATISTICS_LINEAGE_KEYS.has(key))
  ));
}

function inspectProjectionLineage(registry, ownerId, request) {
  let inspected;
  try {
    inspected = registry.inspectSession(ownerId, request.sessionId);
  } catch (cause) {
    throw brokerError(
      "native projection session ownership changed",
      "NATIVE_PLAYER_AUTHORITY_PROJECTION_LINEAGE_MISMATCH",
    );
  }
  if (!isRecord(inspected) || inspected.sessionId !== request.sessionId ||
      inspected.ownerId !== ownerId || inspected.state !== "owned" ||
      !Number.isSafeInteger(inspected.ownerEpoch) || inspected.ownerEpoch < 1) {
    throw brokerError(
      "native projection owner lineage is invalid",
      "NATIVE_PLAYER_AUTHORITY_PROJECTION_LINEAGE_MISMATCH",
    );
  }
  if (inspected.registryFingerprint !== request.expectedRegistryFingerprint) {
    throw brokerError(
      "native projection registry does not match the active session",
      "NATIVE_PLAYER_AUTHORITY_PROJECTION_REGISTRY_MISMATCH",
    );
  }
  return Object.freeze({
    ownerId: inspected.ownerId,
    ownerEpoch: inspected.ownerEpoch,
    registryFingerprint: inspected.registryFingerprint,
  });
}

class NativePlayerAuthorityProjectionBroker {
  constructor(options) {
    if (!isRecord(options) || !options.runtime || typeof options.runtime.snapshot !== "function" ||
        !options.registry || typeof options.registry.inspectSession !== "function" ||
        typeof options.isTrustedRendererOwner !== "function" ||
        options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("native player-authority projection broker options are invalid");
    }
    for (const method of Object.values(PROJECTION_METHODS)) {
      if (typeof options.registry[method] !== "function") {
        throw new TypeError("native player-authority projection registry is invalid");
      }
    }
    if (!validLogicalId(options.ownerId ?? "main-player-authority")) {
      throw new TypeError("native player-authority projection owner is invalid");
    }
    this.runtime = options.runtime;
    this.registry = options.registry;
    this.ownerId = options.ownerId ?? "main-player-authority";
    this.isTrustedRendererOwner = options.isTrustedRendererOwner;
    this.now = options.now ?? Date.now;
  }

  /**
   * Routing hint for main.cjs. It intentionally keeps matching an authority
   * session after it becomes uncertain/faulted/shutdown so the caller cannot
   * fall through to the renderer-owned shadow path.
   */
  ownsSession(sessionId) {
    if (!validLogicalId(sessionId)) return false;
    try {
      return this.runtime.snapshot()?.sessionId === sessionId;
    } catch {
      return false;
    }
  }

  async read(rendererOwnerId, projectionType, request) {
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw brokerError(
        "native player-authority projection caller is not the trusted renderer",
        "NATIVE_PLAYER_AUTHORITY_PROJECTION_RENDERER_UNTRUSTED",
      );
    }
    const method = PROJECTION_METHODS[projectionType];
    const ownerLineageRequired = OWNER_LINEAGE_REQUIRED_PROJECTIONS.has(projectionType);
    if (!method || !isRecord(request) || !validLogicalId(request.sessionId) ||
        !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
        projectionType === "statistics-v1" && !validStatisticsLineageRequest(request) ||
        EXACT_LINEAGE_WORKSPACE_PROJECTIONS.has(projectionType) && !hasExactKeys(request, [
          "sessionId", "runId", "expectedRevision", "expectedRegistryFingerprint",
        ]) || EXACT_LINEAGE_WORKSPACE_PROJECTIONS.has(projectionType) &&
          (!validLogicalId(request.runId) ||
           !validLogicalId(request.expectedRegistryFingerprint, 256)) ||
        ownerLineageRequired &&
          (!validLogicalId(request.runId) ||
           !validLogicalId(request.expectedRegistryFingerprint, 256))) {
      throw brokerError(
        "native player-authority projection request is invalid",
        "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID",
      );
    }

    const before = this.runtime.snapshot();
    assertAuthoritySnapshot(before, request);
    const projectionLineage = OWNER_LINEAGE_FENCED_PROJECTIONS.has(projectionType) &&
        (projectionType !== "statistics-v1" || statisticsRequestHasLineage(request))
      ? inspectProjectionLineage(this.registry, this.ownerId, request)
      : null;
    let registryRequest = request;
    if (projectionType === "orbital-contract-workspace-v1") {
      const confirmedWallClockMs = this.now();
      if (!Number.isSafeInteger(confirmedWallClockMs) || confirmedWallClockMs < 0) {
        throw brokerError(
          "native orbital-contract projection wall clock is invalid",
          "NATIVE_PLAYER_AUTHORITY_PROJECTION_CLOCK_INVALID",
        );
      }
      // Never mutate or expose the renderer request. Each read gets a fresh
      // main-process fence, so a same-revision read cannot cache yesterday's
      // board across the UTC+8 task-day boundary.
      registryRequest = Object.freeze({ ...request, confirmedWallClockMs });
    }
    const result = await this.registry[method](this.ownerId, registryRequest);
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw brokerError(
        "native player-authority projection renderer disappeared before delivery",
        "NATIVE_PLAYER_AUTHORITY_PROJECTION_RENDERER_UNTRUSTED",
      );
    }
    const after = this.runtime.snapshot();
    assertAuthoritySnapshot(after, request);
    if (projectionLineage) {
      const afterLineage = inspectProjectionLineage(this.registry, this.ownerId, request);
      if (afterLineage.ownerId !== projectionLineage.ownerId ||
          afterLineage.ownerEpoch !== projectionLineage.ownerEpoch ||
          afterLineage.registryFingerprint !== projectionLineage.registryFingerprint) {
        throw brokerError(
          "native projection owner lineage changed during the read",
          "NATIVE_PLAYER_AUTHORITY_PROJECTION_LINEAGE_MISMATCH",
        );
      }
    }
    if (!isRecord(result) || result.revision !== request.expectedRevision) {
      throw brokerError(
        "native player-authority projection result is not bound to the requested revision",
        "NATIVE_PLAYER_AUTHORITY_PROJECTION_RESULT_MISMATCH",
      );
    }
    if (REGISTRY_RESULT_FENCED_PROJECTIONS.has(projectionType) &&
        result.registryFingerprint !== request.expectedRegistryFingerprint) {
      throw brokerError(
        "native workspace projection result registry is not current",
        "NATIVE_PLAYER_AUTHORITY_PROJECTION_RESULT_MISMATCH",
      );
    }
    if (EXACT_LINEAGE_WORKSPACE_PROJECTIONS.has(projectionType) &&
        (result.sessionId !== request.sessionId || result.runId !== request.runId ||
         result.registryFingerprint !== request.expectedRegistryFingerprint)) {
      throw brokerError(
        "native workspace projection result lineage is not current",
        "NATIVE_PLAYER_AUTHORITY_PROJECTION_RESULT_MISMATCH",
      );
    }
    return result;
  }
}

module.exports = {
  NativePlayerAuthorityProjectionBroker,
  NativePlayerAuthorityProjectionBrokerError,
  PROJECTION_METHODS,
};
