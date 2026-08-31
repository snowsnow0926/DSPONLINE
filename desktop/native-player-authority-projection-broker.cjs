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
  "blueprint-enqueue-context-v1": "blueprintEnqueueContext",
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
});

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
  if (snapshot.revision !== request.expectedRevision) {
    throw brokerError(
      "native player-authority projection revision is no longer current",
      "NATIVE_PLAYER_AUTHORITY_PROJECTION_REVISION_MISMATCH",
    );
  }
}

class NativePlayerAuthorityProjectionBroker {
  constructor(options) {
    if (!isRecord(options) || !options.runtime || typeof options.runtime.snapshot !== "function" ||
        !options.registry || typeof options.isTrustedRendererOwner !== "function") {
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
    if (!method || !isRecord(request) || !validLogicalId(request.sessionId) ||
        !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
      throw brokerError(
        "native player-authority projection request is invalid",
        "NATIVE_PLAYER_AUTHORITY_PROJECTION_REQUEST_INVALID",
      );
    }

    const before = this.runtime.snapshot();
    assertAuthoritySnapshot(before, request);
    const result = await this.registry[method](this.ownerId, request);
    if (!this.isTrustedRendererOwner(rendererOwnerId)) {
      throw brokerError(
        "native player-authority projection renderer disappeared before delivery",
        "NATIVE_PLAYER_AUTHORITY_PROJECTION_RENDERER_UNTRUSTED",
      );
    }
    const after = this.runtime.snapshot();
    assertAuthoritySnapshot(after, request);
    if (!isRecord(result) || result.revision !== request.expectedRevision) {
      throw brokerError(
        "native player-authority projection result is not bound to the requested revision",
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
