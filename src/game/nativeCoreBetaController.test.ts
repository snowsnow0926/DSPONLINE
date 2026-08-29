import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopNativeCoreCommitOperationResult,
  DesktopNativeCoreDomainCoverage,
  DesktopNativeCoreStellarIndustryV2ProjectionResult,
  DesktopNativeCoreSummary,
  DesktopNativePlayerAuthorityExportResult,
  DesktopNativeSaveCommitResult,
} from "../desktop";
import type { ContentPackRuntimeSnapshot } from "./contentPacks";
import type {
  NativeCoreSegmentedAdvanceRequest,
  NativeCoreSegmentedAdvanceResult,
  WindowsNativeCoreShadow,
} from "./nativeCore";
import {
  WindowsNativeCoreBetaController,
} from "./nativeCoreBetaController";
import type { NativeCoreRevisionProof } from "./nativeCoreAuthority";
import type { SimulationCommandPatch } from "./simulationRuntimeProtocol";

const ROOT = "a".repeat(64);
const CANONICAL = "b".repeat(64);
const DOMAIN = "c".repeat(64);
const FINGERPRINT = "builtin:test";

const checkpoint: DesktopNativeSaveCommitResult = {
  slot: "normal-main",
  generation: 1,
  revision: 1,
  rootHash: ROOT,
  recordCount: 3,
  changedRecords: 3,
  changedBytes: 100,
  totalUncompressedBytes: 100,
};

const runtime = { fingerprint: FINGERPRINT } as ContentPackRuntimeSnapshot;

function coverage(authorityEligible: boolean): DesktopNativeCoreDomainCoverage {
  return { authorityEligible } as DesktopNativeCoreDomainCoverage;
}

function summary(revision: number, authorityEligible = false, canonicalSha256 = CANONICAL): DesktopNativeCoreSummary {
  return {
    revision,
    stateVersion: 47,
    mode: "normal",
    activePlanetId: "home",
    elapsedSeconds: revision,
    paused: false,
    entityCount: 1,
    beltCount: 0,
    canonicalSha256,
    canonicalComponents: { base: CANONICAL, entities: CANONICAL, belts: CANONICAL },
    canonicalFields: {},
    domainSha256: DOMAIN,
    catalogSha256: "d".repeat(64),
    registryFingerprint: FINGERPRINT,
    memory: {
      rawRecordBytes: 100,
      indexedStringBytes: 10,
      inventoryEntryCount: 0,
      topologyIndexBytes: 10,
      estimatedRuntimeBytes: 120,
    },
    coverage: coverage(authorityEligible),
  };
}

function proof(revision: number, rootHash = ROOT): NativeCoreRevisionProof {
  return {
    revision,
    rootHash,
    canonicalSha256: CANONICAL,
    domainSha256: DOMAIN,
    registryFingerprint: FINGERPRINT,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeNativeSession implements WindowsNativeCoreShadow {
  readonly sessionId: string;
  readonly checkpoint: DesktopNativeSaveCommitResult;
  current: DesktopNativeCoreSummary;
  canonicalAfterCommit = CANONICAL;
  eligible = false;
  uncertainOnce = false;
  alwaysFail = false;
  closed = false;
  checkpointCalls = 0;
  exportCalls = 0;
  projectionCalls = 0;
  factoryReadModelCalls = 0;
  factoryReadModelRevisionOffset = 0;
  viewportProjectionV2Calls = 0;
  viewportProjectionV2RevisionOffset = 0;
  statisticsProjectionCalls = 0;
  statisticsProjectionRevisionOffset = 0;
  technologyProjectionCalls = 0;
  technologyProjectionRevisionOffset = 0;
  starMapOverviewProjectionCalls = 0;
  starMapOverviewProjectionRevisionOffset = 0;
  starMapOverviewProjectionFingerprint = FINGERPRINT;
  starMapOverviewProjectionError: Error | null = null;
  starMapOverviewProjectionBarrier: Promise<void> | null = null;
  stellarIndustryProjectionCalls = 0;
  stellarIndustryProjectionRevisionOffset = 0;
  stellarIndustryProjectionFingerprint = FINGERPRINT;
  stellarIndustryProjectionError: Error | null = null;
  stellarIndustryProjectionBarrier: Promise<void> | null = null;
  stellarIndustryV2ProjectionCalls = 0;
  stellarIndustryV2ProjectionRevisionOffset = 0;
  stellarIndustryV2ProjectionFingerprint = FINGERPRINT;
  stellarIndustryV2ProjectionEchoQuery: string | null = null;
  stellarIndustryV2ProjectionError: Error | null = null;
  stellarIndustryV2ProjectionBarrier: Promise<void> | null = null;
  commitBarrier: Promise<void> | null = null;
  lastStatisticsProjectionRequest: Parameters<WindowsNativeCoreShadow["statisticsProjection"]>[0] | null = null;
  lastStarMapOverviewProjectionRequest: Parameters<WindowsNativeCoreShadow["starMapOverviewProjection"]>[0] | null = null;
  lastStellarIndustryProjectionRequest: Parameters<WindowsNativeCoreShadow["stellarIndustryProjection"]>[0] | null = null;
  lastStellarIndustryV2ProjectionRequest: Parameters<WindowsNativeCoreShadow["stellarIndustryV2Projection"]>[0] | null = null;
  readonly commitRequests: Array<Parameters<WindowsNativeCoreShadow["commitOperation"]>[0]> = [];
  private readonly receipts = new Map<string, DesktopNativeCoreCommitOperationResult>();

  constructor(sessionId = "native-test-session", sourceCheckpoint: DesktopNativeSaveCommitResult = checkpoint) {
    this.sessionId = sessionId;
    this.checkpoint = structuredClone(sourceCheckpoint);
    this.current = summary(sourceCheckpoint.revision);
  }

  async status(): Promise<DesktopNativeCoreSummary> {
    return { ...this.current, coverage: coverage(this.eligible) };
  }

  async projection(request: { baseFields?: string[]; entityIds?: string[]; beltIds?: string[] }) {
    this.projectionCalls += 1;
    return {
      revision: this.current.revision,
      base: Object.fromEntries((request.baseFields ?? []).map((field) => [field, field])),
      entities: (request.entityIds ?? []).map((id) => ({ id })),
      belts: (request.beltIds ?? []).map((id) => ({ id })),
    };
  }

  async viewportProjection(request: { planetId: string; bounds: { minX: number; minY: number; maxX: number; maxY: number } }) {
    return {
      schemaVersion: 1 as const,
      projectionType: "viewport-v1" as const,
      revision: this.current.revision,
      planetId: request.planetId,
      bounds: request.bounds,
      base: {},
      entities: [],
      belts: [],
      nextEntityCursor: null,
      truncatedBelts: false,
    };
  }

  async viewportProjectionV2(request: {
    expectedRevision: number;
    planetId: string;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
    pinnedEntityIds?: string[];
    pinnedBeltIds?: string[];
  }) {
    this.viewportProjectionV2Calls += 1;
    return {
      schemaVersion: 2 as const,
      projectionType: "viewport-v2" as const,
      revision: this.current.revision + this.viewportProjectionV2RevisionOffset,
      planetId: request.planetId,
      bounds: request.bounds,
      base: {},
      entities: (request.pinnedEntityIds ?? []).map((id) => ({ id })),
      belts: (request.pinnedBeltIds ?? []).map((id) => ({ id })),
      pinnedEntityIds: request.pinnedEntityIds ?? [],
      pinnedBeltIds: request.pinnedBeltIds ?? [],
      nextEntityCursor: null,
      nextBeltCursor: null,
      planetTotals: { entities: 1, belts: 1 },
      viewportTotals: { entities: 0, belts: 0 },
      worldBounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
      minimap: {
        bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
        entityCount: 1,
        beltCount: 1,
        occupiedCellCount: 1,
        cellSize: 512,
      },
      broadQueryFallback: false,
    };
  }

  async factoryReadModel(request: {
    expectedRevision: number;
    selectedEntityIds?: string[];
    selectedBeltIds?: string[];
  }): Promise<any> {
    this.factoryReadModelCalls += 1;
    const emptyRows = { rows: [], totalCount: 0, truncated: false };
    return {
      schemaVersion: 1 as const,
      projectionType: "factory-read-model-v1" as const,
      revision: this.current.revision + this.factoryReadModelRevisionOffset,
      shell: {
        schema: "factory-read-model-v1" as const,
        source: "native-core" as const,
        stateVersion: 47,
        mode: "normal" as const,
        activePlanetId: "home",
        paused: false,
        elapsedSeconds: 1,
        simulationSpeed: 1,
        entityCount: 1,
        beltCount: 0,
        activePlanetEntityCount: 1,
        activePlanetBeltCount: 0,
        constructionQueueCount: 0,
      },
      planetNavigation: {
        schema: "factory-read-model-v1" as const,
        activePlanetId: "home",
        planets: {
          rows: [{
            planetId: "home", systemId: "helios", displayName: "家园", code: "home",
            active: true, discovered: true, colonized: true, role: null,
            entityCount: 1, deviceCount: 1, beltCount: 0, constructionQueueCount: 0, powerFactor: 1,
          }],
          totalCount: 1,
          truncated: false,
        },
      },
      selection: {
        schema: "factory-read-model-v1" as const,
        activePlanetId: "home",
        requestedEntityCount: request.selectedEntityIds?.length ?? 0,
        requestedBeltCount: request.selectedBeltIds?.length ?? 0,
        entityRows: emptyRows,
        beltRows: emptyRows,
      },
      construction: {
        schema: "factory-read-model-v1" as const,
        activePlanetId: "home",
        queue: emptyRows,
        automation: {
          enabled: false,
          quantumSourceEnabled: false,
          totalCrafted: 0,
          lastCraftedId: null,
          targets: emptyRows,
          jobs: emptyRows,
          destroyedByproducts: emptyRows,
        },
      },
    };
  }

  async statisticsProjection(request: Parameters<WindowsNativeCoreShadow["statisticsProjection"]>[0]) {
    this.statisticsProjectionCalls += 1;
    this.lastStatisticsProjectionRequest = request;
    return {
      schemaVersion: 1 as const,
      projectionType: "statistics-v1" as const,
      revision: this.current.revision + this.statisticsProjectionRevisionOffset,
      window: {
        minElapsedSeconds: request.minElapsedSeconds,
        maxElapsedSeconds: request.maxElapsedSeconds,
      },
      filters: { planetId: null, itemId: null },
      samples: [],
      nextCursor: null,
    };
  }

  async technologyProjection(_request: Parameters<WindowsNativeCoreShadow["technologyProjection"]>[0]) {
    this.technologyProjectionCalls += 1;
    return {
      schemaVersion: 1 as const,
      projectionType: "technology-v1" as const,
      revision: this.current.revision + this.technologyProjectionRevisionOffset,
      truncated: false,
      limits: { techRows: 512 as const, progressItemsPerTech: 16 as const, infiniteRows: 8 as const },
      counts: { completedTechIds: 0, queuedTechIds: 0, progressTechs: 0, infiniteResearch: 5 },
      selectedTechId: null,
      pausedTechId: null,
      completedTechIds: [],
      queuedTechIds: [],
      progressByTech: [],
      activeInfiniteResearchId: null,
      autoResearch: false,
      infiniteResearch: [
        "matrix_compression", "vein_utilization", "galactic_logistics", "stellar_harnessing", "continuum_simulation",
      ].map((researchId) => ({ researchId, level: 0, historicalLevel: null, progress: "0" })),
      settings: { technologyLayout: "standard" as const, fontScale: 1 as const, difficulty: "standard" as const },
      matrixStock: {
        electromagnetic_matrix: 0,
        energy_matrix: 0,
        structure_matrix: 0,
        information_matrix: 0,
        gravity_matrix: 0,
        universe_matrix: 0,
      },
    };
  }

  async recipeWorkspaceProjection(_request: Parameters<WindowsNativeCoreShadow["recipeWorkspaceProjection"]>[0]): Promise<never> {
    throw new Error("recipe workspace projection is not exercised by this controller fixture");
  }

  async starMapOverviewProjection(
    request: Parameters<WindowsNativeCoreShadow["starMapOverviewProjection"]>[0],
  ): Promise<Awaited<ReturnType<WindowsNativeCoreShadow["starMapOverviewProjection"]>>> {
    this.starMapOverviewProjectionCalls += 1;
    this.lastStarMapOverviewProjectionRequest = structuredClone(request);
    if (this.starMapOverviewProjectionBarrier) await this.starMapOverviewProjectionBarrier;
    if (this.starMapOverviewProjectionError) throw this.starMapOverviewProjectionError;
    return {
      schemaVersion: 1,
      projectionType: "star-map-overview-v1",
      revision: this.current.revision + this.starMapOverviewProjectionRevisionOffset,
      registryFingerprint: this.starMapOverviewProjectionFingerprint,
      stateVersion: 47,
      limits: { requestBytes: 32768, projectionBytes: 1048576, pageRows: 64, labelBytes: 512 },
      request: structuredClone(request),
      activePlanetId: "home",
      activeSystemId: "helios",
      galaxySeed: 1,
      summary: {
        systemCount: 1,
        unlockedSystemCount: 1,
        planetCount: 1,
        colonizedPlanetCount: 1,
        stationCount: 0,
      },
      systems: {
        cursor: request.cursor,
        limit: request.limit,
        totalCount: 0,
        nextCursor: null,
        rows: [],
      },
    };
  }

  async stellarIndustryProjection(
    request: Parameters<WindowsNativeCoreShadow["stellarIndustryProjection"]>[0],
  ): Promise<Awaited<ReturnType<WindowsNativeCoreShadow["stellarIndustryProjection"]>>> {
    this.stellarIndustryProjectionCalls += 1;
    this.lastStellarIndustryProjectionRequest = structuredClone(request);
    if (this.stellarIndustryProjectionBarrier) await this.stellarIndustryProjectionBarrier;
    if (this.stellarIndustryProjectionError) throw this.stellarIndustryProjectionError;
    return {
      schemaVersion: 1,
      projectionType: "stellar-industry-v1",
      revision: this.current.revision + this.stellarIndustryProjectionRevisionOffset,
      registryFingerprint: this.stellarIndustryProjectionFingerprint,
      stateVersion: 47,
      limits: { requestBytes: 32768, projectionBytes: 1048576, pageRows: 64, labelBytes: 512 },
      request: structuredClone(request),
      activePlanetId: "home",
      activeSystemId: "helios",
      scopeSystemId: request.systemId,
      scopePlanetId: request.planetId,
      truncated: false,
      planets: {
        cursor: request.planetCursor,
        limit: request.planetLimit,
        totalCount: 0,
        nextCursor: null,
        rows: [],
      },
      stations: {
        cursor: request.stationCursor,
        limit: request.stationLimit,
        totalCount: 0,
        nextCursor: null,
        rows: [],
      },
    };
  }

  async stellarIndustryV2Projection(
    request: Parameters<WindowsNativeCoreShadow["stellarIndustryV2Projection"]>[0],
  ): Promise<DesktopNativeCoreStellarIndustryV2ProjectionResult> {
    this.stellarIndustryV2ProjectionCalls += 1;
    this.lastStellarIndustryV2ProjectionRequest = structuredClone(request);
    if (this.stellarIndustryV2ProjectionBarrier) await this.stellarIndustryV2ProjectionBarrier;
    if (this.stellarIndustryV2ProjectionError) throw this.stellarIndustryV2ProjectionError;
    const echoedRequest = structuredClone(request);
    if (this.stellarIndustryV2ProjectionEchoQuery !== null) {
      echoedRequest.query = this.stellarIndustryV2ProjectionEchoQuery;
    }
    return {
      schemaVersion: 2,
      projectionType: "stellar-industry-v2",
      revision: this.current.revision + this.stellarIndustryV2ProjectionRevisionOffset,
      registryFingerprint: this.stellarIndustryV2ProjectionFingerprint,
      stateVersion: 47,
      limits: {
        requestBytes: 32768,
        projectionBytes: 1048576,
        pageRows: 64,
        labelBytes: 512,
        queryBytes: 512,
        pathVisits: 200000,
      },
      request: echoedRequest,
      activePlanetId: "home",
      activeSystemId: "helios",
      scopeSystemId: request.systemId,
      scopePlanetId: request.planetId,
      truncated: false,
      planets: {
        cursor: request.planetCursor,
        limit: request.planetLimit,
        totalCount: 0,
        nextCursor: null,
        rows: [],
      },
      stations: {
        cursor: request.stationCursor,
        limit: request.stationLimit,
        totalCount: 0,
        nextCursor: null,
        rows: [],
      },
      routeSummary: {
        scopeTotalCount: 0,
        filteredCount: 0,
        activeCount: 0,
        blockedCount: 0,
        remoteCount: 0,
        routePlanningIncompleteCount: 0,
        powerUnprovenCount: 0,
        statusCounts: {},
      },
      routes: {
        cursor: request.routeCursor,
        limit: request.routeLimit,
        totalCount: 0,
        nextCursor: null,
        rows: [],
      },
    };
  }

  async applyCommand(_command: SimulationCommandPatch) {
    return { revision: this.current.revision, topologyDirty: false };
  }

  async advance(request: { baseRevision: number }) {
    return { supported: true, revision: request.baseRevision + 1 };
  }

  async advanceSegmented(request: NativeCoreSegmentedAdvanceRequest): Promise<NativeCoreSegmentedAdvanceResult> {
    return {
      supported: true,
      revision: request.baseRevision + 1,
      cancelled: false,
      advancedSimulationSeconds: request.simulationSeconds,
      advancedWallSeconds: request.wallSeconds,
    };
  }

  async commitOperation(
    request: Parameters<WindowsNativeCoreShadow["commitOperation"]>[0],
  ): Promise<DesktopNativeCoreCommitOperationResult> {
    this.commitRequests.push(structuredClone(request));
    if (this.commitBarrier) await this.commitBarrier;
    if (this.alwaysFail) throw new Error("native host unavailable");
    const existing = this.receipts.get(request.commandId);
    if (existing) return { ...existing, duplicate: true, summary: await this.status() };
    const nextRevision = request.baseRevision + 1;
    this.current = summary(nextRevision, this.eligible, this.canonicalAfterCommit);
    const result: DesktopNativeCoreCommitOperationResult = {
      commandId: request.commandId,
      baseRevision: request.baseRevision,
      revision: nextRevision,
      currentRevision: nextRevision,
      entryHash: "e".repeat(64),
      walBytes: 128,
      duplicate: false,
      summary: await this.status(),
    };
    this.receipts.set(request.commandId, result);
    if (this.uncertainOnce) {
      this.uncertainOnce = false;
      throw new Error("transport timeout after commit");
    }
    return result;
  }

  async createCheckpoint() {
    this.checkpointCalls += 1;
    const nextCheckpoint = { ...checkpoint, generation: 2, revision: this.current.revision, rootHash: "f".repeat(64) };
    return { checkpoint: nextCheckpoint, summary: await this.status(), encodedRecords: 1, reusedRecords: 0 };
  }

  async exportV47(exportId: string, _suggestedName?: string, savedAtMs = 1) {
    this.exportCalls += 1;
    return {
      exportId,
      mode: "normal" as const,
      result: {
        revision: this.current.revision,
        savedAtMs,
        byteLength: 1,
        envelopeSha256: "a".repeat(64),
        stateChecksum: "12345678",
      },
      cancelled: true,
    };
  }

  async compare(expected: { revision: number; canonicalSha256: string; domainSha256: string }) {
    const current = await this.status();
    const revisionMatches = expected.revision === current.revision;
    const canonicalMatches = expected.canonicalSha256 === current.canonicalSha256;
    const domainMatches = expected.domainSha256 === current.domainSha256;
    return {
      matches: revisionMatches && canonicalMatches && domainMatches,
      revisionMatches,
      canonicalMatches,
      domainMatches,
      promotionBlocked: !(revisionMatches && canonicalMatches && domainMatches),
      summary: current,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function openController(session: FakeNativeSession, now = 1_000) {
  const controller = new WindowsNativeCoreBetaController(async () => session, () => now);
  await controller.openShadow({ mode: "normal", checkpoint, runtime, javascriptProof: proof(1) });
  return controller;
}

async function gatedController(session: FakeNativeSession) {
  session.eligible = true;
  const controller = await openController(session);
  await controller.mirrorJavaScriptOperation({
    commandId: "shadow-1",
    baseRevision: 1,
    simulationSeconds: 1,
    wallSeconds: 1,
    javascriptProof: proof(2),
    compatibleFallback: proof(2),
  });
  controller.recordGateMeasurement({
    observedAtMs: 1_000 + 24 * 60 * 60 * 1_000,
    netThroughputRatio: 1.5,
    ipcFrameShare: 0.19,
    processTreeMemoryImprovementRatio: 0.3,
  });
  return controller;
}

function stellarIndustryV2Request() {
  return {
    systemId: "helios",
    planetId: "home",
    planetCursor: 0,
    planetLimit: 32,
    stationCursor: 0,
    stationLimit: 32,
    routeCursor: 0,
    routeLimit: 24,
    routeFilter: "issues" as const,
    query: "deuterium",
  };
}

describe("Windows native core invitation-Beta controller", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("serves factory read models only from a verified same-revision JavaScript shadow", async () => {
    const session = new FakeNativeSession();
    const controller = await openController(session);
    const request = {
      selectedEntityIds: ["selected-entity"],
      selectedBeltIds: ["selected-belt"],
    };
    await expect(controller.readVerifiedFactoryReadModel(request, 1)).resolves.toMatchObject({
      projectionType: "factory-read-model-v1",
      revision: 1,
      selection: { requestedEntityCount: 1, requestedBeltCount: 1 },
    });
    expect(session.factoryReadModelCalls).toBe(1);

    session.factoryReadModelRevisionOffset = 1;
    await expect(controller.readVerifiedFactoryReadModel(request, 1)).resolves.toBeNull();
    expect(session.factoryReadModelCalls).toBe(2);

    await controller.mirrorJavaScriptOperationUnverified({
      commandId: "factory-read-model-unverified",
      baseRevision: 1,
      resultRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
    });
    await expect(controller.readVerifiedFactoryReadModel(request, 2)).resolves.toBeNull();
    expect(session.factoryReadModelCalls).toBe(2);
  });

  it("serves viewport v2 only from a verified same-revision JavaScript shadow", async () => {
    const session = new FakeNativeSession();
    const controller = await openController(session);
    const request = {
      baseFields: ["paused"],
      planetId: "home",
      bounds: { minX: -5, minY: -5, maxX: 5, maxY: 5 },
      entityCursor: 0,
      entityLimit: 64,
      beltCursor: 0,
      beltLimit: 128,
      pinnedEntityIds: ["selected-entity"],
      pinnedBeltIds: ["selected-belt"],
    };
    await expect(controller.readVerifiedViewportProjectionV2(request, 1)).resolves.toMatchObject({
      projectionType: "viewport-v2",
      revision: 1,
      pinnedEntityIds: ["selected-entity"],
      pinnedBeltIds: ["selected-belt"],
    });
    expect(session.viewportProjectionV2Calls).toBe(1);

    session.viewportProjectionV2RevisionOffset = 1;
    await expect(controller.readVerifiedViewportProjectionV2(request, 1)).resolves.toBeNull();
    expect(session.viewportProjectionV2Calls).toBe(2);
    expect(controller.snapshot().authority).toMatchObject({ authority: "javascript", phase: "shadow" });

    await controller.mirrorJavaScriptOperationUnverified({
      commandId: "viewport-unverified",
      baseRevision: 1,
      resultRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
    });
    await expect(controller.readVerifiedViewportProjectionV2(request, 2)).resolves.toBeNull();
    expect(session.viewportProjectionV2Calls).toBe(2);
  });

  it("serves statistics only from a verified same-revision JavaScript shadow", async () => {
    const session = new FakeNativeSession();
    const controller = await openController(session);
    const verified = await controller.readVerifiedStatisticsProjection({
      minElapsedSeconds: 0,
      maxElapsedSeconds: 60,
      cursor: 0,
      limit: 512,
    }, 1);
    expect(verified).toMatchObject({ projectionType: "statistics-v1", revision: 1 });
    expect(session.statisticsProjectionCalls).toBe(1);
    expect(session.lastStatisticsProjectionRequest?.expectedRevision).toBe(1);

    await controller.mirrorJavaScriptOperationUnverified({
      commandId: "statistics-unverified",
      baseRevision: 1,
      resultRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
    });
    expect(await controller.readVerifiedStatisticsProjection({
      minElapsedSeconds: 0,
      maxElapsedSeconds: 60,
      cursor: 0,
      limit: 512,
    }, 2)).toBeNull();
    expect(session.statisticsProjectionCalls).toBe(1);
  });

  it("falls back without changing authority when native statistics returns another revision", async () => {
    const session = new FakeNativeSession();
    session.statisticsProjectionRevisionOffset = 1;
    const controller = await openController(session);
    expect(await controller.readVerifiedStatisticsProjection({
      minElapsedSeconds: 0,
      maxElapsedSeconds: 60,
      cursor: 0,
      limit: 512,
    }, 1)).toBeNull();
    expect(controller.snapshot().authority).toMatchObject({ authority: "javascript", phase: "shadow", shadowRevision: 1 });
  });

  it("serves technology only from a verified same-revision JavaScript shadow", async () => {
    const session = new FakeNativeSession();
    const controller = await openController(session);
    await expect(controller.readVerifiedTechnologyProjection({}, 1)).resolves.toMatchObject({
      projectionType: "technology-v1",
      revision: 1,
    });
    expect(session.technologyProjectionCalls).toBe(1);

    session.technologyProjectionRevisionOffset = 1;
    await expect(controller.readVerifiedTechnologyProjection({}, 1)).resolves.toBeNull();
    expect(session.technologyProjectionCalls).toBe(2);

    await controller.mirrorJavaScriptOperationUnverified({
      commandId: "technology-unverified",
      baseRevision: 1,
      resultRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
    });
    await expect(controller.readVerifiedTechnologyProjection({}, 2)).resolves.toBeNull();
    expect(session.technologyProjectionCalls).toBe(2);
  });

  it("serves stellar projections in verified shadow/native-ready state and derives fingerprint from proof", async () => {
    const shadowSession = new FakeNativeSession();
    const shadowController = await openController(shadowSession);
    const forgedStarMapRequest = {
      cursor: 0,
      limit: 32,
      expectedRevision: 999,
      expectedRegistryFingerprint: "renderer:forged",
    } as Parameters<WindowsNativeCoreBetaController["readVerifiedStarMapOverviewProjection"]>[0];
    await expect(shadowController.readVerifiedStarMapOverviewProjection(
      forgedStarMapRequest,
      1,
    )).resolves.toMatchObject({
      projectionType: "star-map-overview-v1",
      revision: 1,
      registryFingerprint: FINGERPRINT,
    });
    expect(shadowSession.lastStarMapOverviewProjectionRequest).toMatchObject({
      cursor: 0,
      limit: 32,
      expectedRevision: 1,
      expectedRegistryFingerprint: FINGERPRINT,
    });

    const readySession = new FakeNativeSession();
    const readyController = await gatedController(readySession);
    expect(readyController.snapshot().authority.phase).toBe("native-ready");
    await expect(readyController.readVerifiedStellarIndustryProjection({
      systemId: "helios",
      planetId: "home",
      planetCursor: 0,
      planetLimit: 32,
      stationCursor: 0,
      stationLimit: 32,
    }, 2)).resolves.toMatchObject({
      projectionType: "stellar-industry-v1",
      revision: 2,
      registryFingerprint: FINGERPRINT,
      scopeSystemId: "helios",
      scopePlanetId: "home",
    });
    expect(readySession.lastStellarIndustryProjectionRequest).toMatchObject({
      expectedRevision: 2,
      expectedRegistryFingerprint: FINGERPRINT,
    });
  });

  it("serves only the exact echoed stellar industry v2 route page from the current proof", async () => {
    const session = new FakeNativeSession();
    const controller = await openController(session);
    const request = {
      ...stellarIndustryV2Request(),
      expectedRevision: 999,
      expectedRegistryFingerprint: "renderer:forged",
    } as Parameters<WindowsNativeCoreBetaController["readVerifiedStellarIndustryV2Projection"]>[0];
    await expect(controller.readVerifiedStellarIndustryV2Projection(request, 1)).resolves.toMatchObject({
      schemaVersion: 2,
      projectionType: "stellar-industry-v2",
      revision: 1,
      registryFingerprint: FINGERPRINT,
      scopeSystemId: "helios",
      scopePlanetId: "home",
      request: {
        routeCursor: 0,
        routeLimit: 24,
        routeFilter: "issues",
        query: "deuterium",
        expectedRevision: 1,
        expectedRegistryFingerprint: FINGERPRINT,
      },
    });
    expect(session.lastStellarIndustryV2ProjectionRequest).toEqual({
      ...stellarIndustryV2Request(),
      expectedRevision: 1,
      expectedRegistryFingerprint: FINGERPRINT,
    });
    expect(session.stellarIndustryV2ProjectionCalls).toBe(1);
    expect(session.stellarIndustryProjectionCalls).toBe(0);
  });

  it("fails closed on mismatched v2 revision, fingerprint, or echoed route request", async () => {
    const session = new FakeNativeSession();
    const controller = await openController(session);
    const authorityBefore = controller.snapshot().authority;
    const request = stellarIndustryV2Request();

    session.stellarIndustryV2ProjectionRevisionOffset = 1;
    await expect(controller.readVerifiedStellarIndustryV2Projection(request, 1)).resolves.toBeNull();
    session.stellarIndustryV2ProjectionRevisionOffset = 0;
    session.stellarIndustryV2ProjectionFingerprint = "pack:other";
    await expect(controller.readVerifiedStellarIndustryV2Projection(request, 1)).resolves.toBeNull();
    session.stellarIndustryV2ProjectionFingerprint = FINGERPRINT;
    session.stellarIndustryV2ProjectionEchoQuery = "forged-query";
    await expect(controller.readVerifiedStellarIndustryV2Projection(request, 1)).resolves.toBeNull();

    expect(session.stellarIndustryV2ProjectionCalls).toBe(3);
    expect(session.stellarIndustryProjectionCalls).toBe(0);
    expect(controller.snapshot().authority).toEqual(authorityBefore);
  });

  it("drops an in-flight stellar industry v2 page when the verified session identity changes", async () => {
    const first = new FakeNativeSession("stellar-v2-session-1");
    const second = new FakeNativeSession("stellar-v2-session-2");
    const gate = deferred();
    first.stellarIndustryV2ProjectionBarrier = gate.promise;
    let opens = 0;
    const controller = new WindowsNativeCoreBetaController(
      async () => opens++ === 0 ? first : second,
      () => 1_000,
    );
    await controller.openShadow({ mode: "normal", checkpoint, runtime, javascriptProof: proof(1) });
    const pending = controller.readVerifiedStellarIndustryV2Projection(stellarIndustryV2Request(), 1);
    expect(first.stellarIndustryV2ProjectionCalls).toBe(1);
    await controller.openShadow({ mode: "normal", checkpoint, runtime, javascriptProof: proof(1) });
    gate.resolve();
    await expect(pending).resolves.toBeNull();
    expect(second.stellarIndustryV2ProjectionCalls).toBe(0);
  });

  it("does not fall back to v1 when the stellar industry v2 reader fails", async () => {
    const session = new FakeNativeSession();
    session.stellarIndustryV2ProjectionError = new Error("v2 reader unavailable");
    const controller = await openController(session);
    const authorityBefore = controller.snapshot().authority;
    await expect(controller.readVerifiedStellarIndustryV2Projection(stellarIndustryV2Request(), 1))
      .resolves.toBeNull();
    expect(session.stellarIndustryV2ProjectionCalls).toBe(1);
    expect(session.stellarIndustryProjectionCalls).toBe(0);
    expect(controller.snapshot().authority).toEqual(authorityBefore);
  });

  it("does not dispatch stellar reads while the latest proof is stale", async () => {
    const session = new FakeNativeSession();
    const controller = await openController(session);
    await controller.mirrorJavaScriptOperationUnverified({
      commandId: "stellar-proof-pending",
      baseRevision: 1,
      resultRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
    });
    expect(controller.snapshot().authority).toMatchObject({
      shadowRevision: 2,
      latestVerifiedProof: { revision: 1 },
    });
    await expect(controller.readVerifiedStarMapOverviewProjection({ cursor: 0, limit: 32 }, 2))
      .resolves.toBeNull();
    await expect(controller.readVerifiedStellarIndustryProjection({
      systemId: null,
      planetId: null,
      planetCursor: 0,
      planetLimit: 32,
      stationCursor: 0,
      stationLimit: 32,
    }, 2)).resolves.toBeNull();
    await expect(controller.readVerifiedStellarIndustryV2Projection(stellarIndustryV2Request(), 2))
      .resolves.toBeNull();
    expect(session.starMapOverviewProjectionCalls).toBe(0);
    expect(session.stellarIndustryProjectionCalls).toBe(0);
    expect(session.stellarIndustryV2ProjectionCalls).toBe(0);
  });

  it("rejects stellar responses from another revision without changing authority", async () => {
    const session = new FakeNativeSession();
    session.starMapOverviewProjectionRevisionOffset = 1;
    session.stellarIndustryProjectionRevisionOffset = 1;
    const controller = await openController(session);
    const authorityBefore = controller.snapshot().authority;
    await expect(controller.readVerifiedStarMapOverviewProjection({ cursor: 0, limit: 32 }, 1))
      .resolves.toBeNull();
    await expect(controller.readVerifiedStellarIndustryProjection({
      systemId: null,
      planetId: null,
      planetCursor: 0,
      planetLimit: 32,
      stationCursor: 0,
      stationLimit: 32,
    }, 1)).resolves.toBeNull();
    expect(controller.snapshot().authority).toEqual(authorityBefore);
  });

  it("rejects stellar responses with another registry fingerprint", async () => {
    const session = new FakeNativeSession();
    session.starMapOverviewProjectionFingerprint = "pack:other";
    session.stellarIndustryProjectionFingerprint = "pack:other";
    const controller = await openController(session);
    const authorityBefore = controller.snapshot().authority;
    await expect(controller.readVerifiedStarMapOverviewProjection({ cursor: 0, limit: 32 }, 1))
      .resolves.toBeNull();
    await expect(controller.readVerifiedStellarIndustryProjection({
      systemId: null,
      planetId: null,
      planetCursor: 0,
      planetLimit: 32,
      stationCursor: 0,
      stationLimit: 32,
    }, 1)).resolves.toBeNull();
    expect(controller.snapshot().authority).toEqual(authorityBefore);
    expect(session.lastStarMapOverviewProjectionRequest?.expectedRegistryFingerprint).toBe(FINGERPRINT);
    expect(session.lastStellarIndustryProjectionRequest?.expectedRegistryFingerprint).toBe(FINGERPRINT);
  });

  it("does not dispatch stellar reads while a native operation is in flight", async () => {
    const session = new FakeNativeSession();
    const gate = deferred();
    session.commitBarrier = gate.promise;
    const controller = await openController(session);
    const operation = controller.mirrorJavaScriptOperationUnverified({
      commandId: "stellar-in-flight",
      baseRevision: 1,
      resultRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
    });
    expect(session.commitRequests).toHaveLength(1);
    const authorityBefore = controller.snapshot().authority;
    await expect(controller.readVerifiedStarMapOverviewProjection({ cursor: 0, limit: 32 }, 1))
      .resolves.toBeNull();
    await expect(controller.readVerifiedStellarIndustryProjection({
      systemId: null,
      planetId: null,
      planetCursor: 0,
      planetLimit: 32,
      stationCursor: 0,
      stationLimit: 32,
    }, 1)).resolves.toBeNull();
    expect(session.starMapOverviewProjectionCalls).toBe(0);
    expect(session.stellarIndustryProjectionCalls).toBe(0);
    expect(controller.snapshot().authority).toEqual(authorityBefore);
    gate.resolve();
    await expect(operation).resolves.toMatchObject({ mirrored: true });
  });

  it("drops an in-flight stellar response after the shadow session is replaced", async () => {
    const first = new FakeNativeSession("stellar-session-1");
    const second = new FakeNativeSession("stellar-session-2");
    const gate = deferred();
    first.starMapOverviewProjectionBarrier = gate.promise;
    let opens = 0;
    const controller = new WindowsNativeCoreBetaController(
      async () => opens++ === 0 ? first : second,
      () => 1_000,
    );
    await controller.openShadow({ mode: "normal", checkpoint, runtime, javascriptProof: proof(1) });
    const pending = controller.readVerifiedStarMapOverviewProjection({ cursor: 0, limit: 32 }, 1);
    expect(first.starMapOverviewProjectionCalls).toBe(1);
    await controller.openShadow({ mode: "normal", checkpoint, runtime, javascriptProof: proof(1) });
    expect(controller.snapshot().authority.sessionId).toBe("stellar-session-2");
    gate.resolve();
    await expect(pending).resolves.toBeNull();
    expect(second.starMapOverviewProjectionCalls).toBe(0);
  });

  it("turns stellar read exceptions into null without changing authority", async () => {
    const session = new FakeNativeSession();
    session.starMapOverviewProjectionError = new Error("star map read failed");
    session.stellarIndustryProjectionError = new Error("stellar industry read failed");
    const controller = await openController(session);
    const authorityBefore = controller.snapshot().authority;
    await expect(controller.readVerifiedStarMapOverviewProjection({ cursor: 0, limit: 32 }, 1))
      .resolves.toBeNull();
    await expect(controller.readVerifiedStellarIndustryProjection({
      systemId: null,
      planetId: null,
      planetCursor: 0,
      planetLimit: 32,
      stationCursor: 0,
      stationLimit: 32,
    }, 1)).resolves.toBeNull();
    expect(controller.snapshot().authority).toEqual(authorityBefore);
    expect(session.closed).toBe(false);
  });

  it("mirrors JavaScript durably while JavaScript remains authoritative", async () => {
    const session = new FakeNativeSession();
    const controller = await openController(session);
    const mirrored = await controller.mirrorJavaScriptOperation({
      commandId: "shadow-1",
      baseRevision: 1,
      simulationSeconds: 1,
      wallSeconds: 1,
      advanceMode: "pure-idle-conservative-v2",
      javascriptProof: proof(2),
      compatibleFallback: proof(2),
    });
    expect(mirrored).toMatchObject({ mirrored: true, state: { phase: "shadow", authority: "javascript", comparisonCount: 2 } });
    expect(session.commitRequests[0]?.advanceMode).toBe("pure-idle-conservative-v2");
  });

  it("replays without claiming equality, then verifies and reseeds without resetting the 24h window", async () => {
    const first = new FakeNativeSession("native-session-1");
    const nextCheckpoint = { ...checkpoint, generation: 2, revision: 2, rootHash: "f".repeat(64) };
    const second = new FakeNativeSession("native-session-2", nextCheckpoint);
    let opens = 0;
    const controller = new WindowsNativeCoreBetaController(async () => opens++ === 0 ? first : second, () => 1_000);
    await controller.openShadow({ mode: "normal", checkpoint, runtime, javascriptProof: proof(1) });
    const replayed = await controller.mirrorJavaScriptOperationUnverified({
      commandId: "shadow-unverified-1",
      baseRevision: 1,
      resultRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
      advanceMode: "pure-idle-conservative-v2",
    });
    expect(replayed).toMatchObject({ mirrored: true, state: { shadowRevision: 2, comparisonCount: 1 } });
    expect(first.commitRequests[0]?.advanceMode).toBe("pure-idle-conservative-v2");
    expect(() => controller.recordGateMeasurement({
      observedAtMs: 1_000 + 24 * 60 * 60 * 1_000,
      netThroughputRatio: 2,
      ipcFrameShare: 0.1,
      processTreeMemoryImprovementRatio: 0.5,
    })).toThrow(/尚未比较/);
    const verified = await controller.verifyJavaScriptState({ javascriptProof: proof(2) });
    expect(verified).toMatchObject({ mirrored: true, state: { comparisonCount: 2, shadowRevision: 2 } });
    const reseeded = await controller.openShadow({
      mode: "normal",
      checkpoint: nextCheckpoint,
      runtime,
      javascriptProof: proof(2, nextCheckpoint.rootHash),
    });
    expect(reseeded.authority).toMatchObject({
      phase: "shadow",
      sessionId: "native-session-2",
      shadowStartedAtMs: 1_000,
      shadowRevision: 2,
      comparisonCount: 3,
    });
  });

  it("derives the coverage Gate from the native summary instead of trusting a caller", async () => {
    const controller = await openController(new FakeNativeSession());
    const gated = controller.recordGateMeasurement({
      observedAtMs: 1_000 + 24 * 60 * 60 * 1_000,
      netThroughputRatio: 2,
      ipcFrameShare: 0.1,
      processTreeMemoryImprovementRatio: 0.5,
    });
    expect(gated.authority).toMatchObject({ phase: "shadow", authority: "javascript" });
    expect(gated.authority.reason).toContain("native-domain-coverage-incomplete");
  });

  it("keeps JavaScript authoritative until the main process owns a durable Rust player lease", async () => {
    const session = new FakeNativeSession();
    const controller = await gatedController(session);
    expect(controller.snapshot().authority).toMatchObject({
      phase: "native-ready",
      authority: "javascript",
      shadowRevision: 2,
    });

    expect(() => controller.promoteToAuthority(proof(2), true)).toThrow(/主进程 Rust 持久租约/);
    await expect(controller.commitAuthoritativeOperation({
      commandId: "phantom-authority-operation",
      baseRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
    })).rejects.toThrow(/不是权威状态/);
    expect(session.current.revision).toBe(2);
    expect(controller.snapshot().authority).toMatchObject({ phase: "native-ready", authority: "javascript" });
    expect(session.commitRequests).toHaveLength(1);
  });

  it("formally binds a completed main-owned handoff and routes persistence without the old renderer owner", async () => {
    const session = new FakeNativeSession();
    const controller = await gatedController(session);
    const authorityCheckpoint = {
      generation: 5,
      rootHash: "f".repeat(64),
      revision: 2,
    };
    const authoritySummary = summary(2, true);
    const authorityIdentity = {
      sessionId: session.sessionId,
      runId: "player-run-1",
      revision: 2,
    };
    const checkpointBridge = vi.fn(async () => ({
      authority: authorityIdentity,
      checkpoint: authorityCheckpoint,
      summary: authoritySummary,
      reusedAcknowledgedCheckpoint: true as const,
    }));
    const exportBridge = vi.fn(async (request: {
      exportId: string;
      savedAtMs: number;
      suggestedName?: string;
    }) => ({
      authority: authorityIdentity,
      exportId: request.exportId,
      mode: "normal" as const,
      result: {
        revision: 2,
        savedAtMs: request.savedAtMs,
        byteLength: 123,
        envelopeSha256: "d".repeat(64),
        stateChecksum: "12345678",
      },
      cancelled: false,
      fileName: request.suggestedName,
    }));
    vi.stubGlobal("window", {
      dspDesktop: {
        checkpointNativePlayerAuthority: checkpointBridge,
        exportNativePlayerAuthorityV47: exportBridge,
      },
    });

    const bound = controller.bindMainOwnedPlayerAuthority({
      sessionId: session.sessionId,
      runId: "player-run-1",
      checkpoint: authorityCheckpoint,
      summary: authoritySummary,
      source: "handoff",
    });
    expect(bound.authority).toMatchObject({
      phase: "native-authoritative",
      authority: "native",
      sessionId: session.sessionId,
      shadowRevision: 2,
    });

    const checkpointed = await controller.createAuthorityCheckpoint(undefined, 20_000);
    expect(checkpointed.snapshot.authority).toMatchObject({ phase: "native-authoritative", authority: "native" });
    expect(checkpointed.artifact.identity).toEqual(authorityIdentity);
    expect(checkpointBridge).toHaveBeenCalledTimes(1);
    expect(session.checkpointCalls).toBe(0);

    await expect(controller.exportAuthoritativeV47("export-1", "factory.json", 21_000)).resolves.toMatchObject({
      artifact: {
        identity: authorityIdentity,
        export: {
          exportId: "export-1",
          mode: "normal",
          result: { revision: 2, savedAtMs: 21_000 },
        },
      },
    });
    expect(exportBridge).toHaveBeenCalledWith({
      exportId: "export-1",
      savedAtMs: 21_000,
      suggestedName: "factory.json",
    });
    exportBridge.mockResolvedValueOnce({
      authority: { ...authorityIdentity, revision: 3 },
      exportId: "export-after-clock-tick",
      mode: "normal" as const,
      result: {
        revision: 3,
        savedAtMs: 22_000,
        byteLength: 124,
        envelopeSha256: "e".repeat(64),
        stateChecksum: "87654321",
      },
      cancelled: false,
      fileName: "factory-after-clock-tick.json",
    });
    await expect(controller.exportAuthoritativeV47(
      "export-after-clock-tick",
      "factory-after-clock-tick.json",
      22_000,
    )).resolves.toMatchObject({ artifact: { export: { result: { revision: 3 } } } });
    exportBridge.mockResolvedValueOnce({
      authority: { sessionId: "replacement-session", runId: "replacement-run", revision: 4 },
      exportId: "export-after-lineage-change",
      mode: "normal" as const,
      result: {
        revision: 4,
        savedAtMs: 23_000,
        byteLength: 125,
        envelopeSha256: "9".repeat(64),
        stateChecksum: "abcdef12",
      },
      cancelled: false,
      fileName: "factory-after-lineage-change.json",
    });
    await expect(controller.exportAuthoritativeV47(
      "export-after-lineage-change",
      "factory-after-lineage-change.json",
      23_000,
    )).rejects.toThrow(/导出回执结构无效/);
    expect(session.exportCalls).toBe(0);
  });

  it("keeps main-owned authority active when persistence is busy and accepts an older ACKed artifact on the same lineage", async () => {
    const session = new FakeNativeSession();
    const controller = await gatedController(session);
    const authorityCheckpoint = { generation: 5, rootHash: "f".repeat(64), revision: 2 };
    const authoritySummary = summary(2, true);
    const busy = Object.assign(new Error("persistence boundary busy"), {
      code: "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY",
    });
    const checkpointBridge = vi.fn()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce({
        authority: { sessionId: session.sessionId, runId: "player-run-race", revision: 2 },
        checkpoint: authorityCheckpoint,
        summary: authoritySummary,
        reusedAcknowledgedCheckpoint: true as const,
      });
    let resolveExport!: (value: DesktopNativePlayerAuthorityExportResult) => void;
    const pendingExportBridge = new Promise<DesktopNativePlayerAuthorityExportResult>((resolve) => {
      resolveExport = resolve;
    });
    const exportBridge = vi.fn(() => pendingExportBridge);
    vi.stubGlobal("window", {
      dspDesktop: {
        checkpointNativePlayerAuthority: checkpointBridge,
        exportNativePlayerAuthorityV47: exportBridge,
      },
    });
    controller.bindMainOwnedPlayerAuthority({
      sessionId: session.sessionId,
      runId: "player-run-race",
      checkpoint: authorityCheckpoint,
      summary: authoritySummary,
      source: "handoff",
    });

    await expect(controller.createAuthorityCheckpoint()).rejects.toBe(busy);
    expect(controller.snapshot().authority).toMatchObject({
      phase: "native-authoritative",
      authority: "native",
      shadowRevision: 2,
    });

    const exportWhileClockAdvances = controller.exportAuthoritativeV47(
      "export-before-next-tick",
      "before-next-tick.json",
      30_000,
    );
    await Promise.resolve();
    await controller.commitAuthoritativeOperation({
      commandId: "tick-won-after-artifact",
      baseRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
    });
    resolveExport({
      authority: { sessionId: session.sessionId, runId: "player-run-race", revision: 2 },
      exportId: "export-before-next-tick",
      mode: "normal",
      result: {
        revision: 2,
        savedAtMs: 30_000,
        byteLength: 123,
        envelopeSha256: "e".repeat(64),
        stateChecksum: "12345678",
      },
      cancelled: false,
      fileName: "before-next-tick.json",
    });
    await expect(exportWhileClockAdvances).resolves.toMatchObject({
      artifact: {
        identity: { revision: 2 },
        export: { result: { revision: 2 } },
      },
    });
    const receipt = await controller.createAuthorityCheckpoint();
    expect(receipt.artifact.identity.revision).toBe(2);
    expect(receipt.snapshot.authority).toMatchObject({
      phase: "native-authoritative",
      authority: "native",
      shadowRevision: 3,
    });
  });

  it("idempotently rebinds a lost completion ACK only for monotonic same-run progress", async () => {
    const session = new FakeNativeSession();
    const controller = await gatedController(session);
    controller.bindMainOwnedPlayerAuthority({
      sessionId: session.sessionId,
      runId: "player-run-completion-retry",
      checkpoint: { generation: 5, rootHash: "f".repeat(64), revision: 2 },
      summary: summary(2, true),
      source: "handoff",
    });
    const advanced = controller.bindMainOwnedPlayerAuthority({
      sessionId: session.sessionId,
      runId: "player-run-completion-retry",
      checkpoint: { generation: 6, rootHash: "e".repeat(64), revision: 3 },
      summary: summary(3, true),
      source: "handoff",
    });
    expect(advanced.authority).toMatchObject({
      phase: "native-authoritative",
      authority: "native",
      shadowRevision: 3,
    });
    expect(() => controller.bindMainOwnedPlayerAuthority({
      sessionId: session.sessionId,
      runId: "replacement-run",
      checkpoint: { generation: 6, rootHash: "e".repeat(64), revision: 3 },
      summary: summary(3, true),
      source: "handoff",
    })).toThrow(/lineage 回退或替换/);
    expect(() => controller.bindMainOwnedPlayerAuthority({
      sessionId: session.sessionId,
      runId: "player-run-completion-retry",
      checkpoint: { generation: 5, rootHash: "f".repeat(64), revision: 2 },
      summary: summary(2, true),
      source: "handoff",
    })).toThrow(/lineage 回退或替换/);
  });

  it("recovers a main-owned startup session only from a complete v47 eligible receipt", async () => {
    const opener = vi.fn(async () => null);
    const controller = new WindowsNativeCoreBetaController(opener, () => 1_000);
    const startupCheckpoint = {
      generation: 8,
      rootHash: "e".repeat(64),
      revision: 41,
    };
    const startupSummary = { ...summary(41, true), paused: true };

    const bound = controller.bindMainOwnedPlayerAuthority({
      sessionId: "core-recovered-1",
      runId: "player-run-recovered-1",
      checkpoint: startupCheckpoint,
      summary: startupSummary,
      source: "startup-recovery",
    });
    expect(bound.authority).toMatchObject({
      phase: "native-authoritative",
      authority: "native",
      sessionId: "core-recovered-1",
      shadowRevision: 41,
    });
    expect(opener).not.toHaveBeenCalled();

    const rebound = controller.bindMainOwnedPlayerAuthority({
      sessionId: "core-recovered-1",
      runId: "player-run-recovered-1",
      checkpoint: { generation: 9, rootHash: "d".repeat(64), revision: 42 },
      summary: summary(42, true),
      source: "startup-recovery",
    });
    expect(rebound.authority).toMatchObject({
      phase: "native-authoritative",
      authority: "native",
      sessionId: "core-recovered-1",
      shadowRevision: 42,
    });
    expect(() => controller.bindMainOwnedPlayerAuthority({
      sessionId: "core-recovered-1",
      runId: "replacement-run",
      checkpoint: { generation: 9, rootHash: "d".repeat(64), revision: 42 },
      summary: summary(42, true),
      source: "startup-recovery",
    })).toThrow(/lineage 回退或替换/);
    expect(() => controller.bindMainOwnedPlayerAuthority({
      sessionId: "core-recovered-1",
      runId: "player-run-recovered-1",
      checkpoint: startupCheckpoint,
      summary: startupSummary,
      source: "startup-recovery",
    })).toThrow(/lineage 回退或替换/);

    const rejected = new WindowsNativeCoreBetaController(opener, () => 1_000);
    expect(() => rejected.bindMainOwnedPlayerAuthority({
      sessionId: "core-recovered-2",
      runId: "player-run-recovered-2",
      checkpoint: startupCheckpoint,
      summary: summary(41, false),
      source: "startup-recovery",
    })).toThrow(/完成回执无效/);
    expect(rejected.snapshot().authority).toMatchObject({ phase: "js-only", authority: "javascript" });
  });

  it("requires explicit player opt-in before consulting any authority transition", async () => {
    const controller = await gatedController(new FakeNativeSession());
    expect(() => controller.promoteToAuthority(proof(2), false)).toThrow(/明确选择/);
    expect(controller.snapshot().authority).toMatchObject({ phase: "native-ready", authority: "javascript" });
  });

  it("drops a diverged shadow without affecting the JavaScript authority", async () => {
    const session = new FakeNativeSession();
    const controller = await openController(session);
    session.canonicalAfterCommit = "9".repeat(64);
    const mirrored = await controller.mirrorJavaScriptOperation({
      commandId: "shadow-diverge",
      baseRevision: 1,
      simulationSeconds: 1,
      wallSeconds: 1,
      javascriptProof: proof(2),
    });
    expect(mirrored).toMatchObject({ mirrored: false, state: { phase: "shadow-diverged", authority: "javascript" } });
    expect(session.closed).toBe(true);
  });
});
