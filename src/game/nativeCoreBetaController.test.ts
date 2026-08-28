import { describe, expect, it } from "vitest";

import type {
  DesktopNativeCoreCommitOperationResult,
  DesktopNativeCoreDomainCoverage,
  DesktopNativeCoreSummary,
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

class FakeNativeSession implements WindowsNativeCoreShadow {
  readonly sessionId: string;
  readonly checkpoint: DesktopNativeSaveCommitResult;
  current: DesktopNativeCoreSummary;
  canonicalAfterCommit = CANONICAL;
  eligible = false;
  uncertainOnce = false;
  alwaysFail = false;
  closed = false;
  projectionCalls = 0;
  factoryReadModelCalls = 0;
  factoryReadModelRevisionOffset = 0;
  viewportProjectionV2Calls = 0;
  viewportProjectionV2RevisionOffset = 0;
  statisticsProjectionCalls = 0;
  statisticsProjectionRevisionOffset = 0;
  technologyProjectionCalls = 0;
  technologyProjectionRevisionOffset = 0;
  lastStatisticsProjectionRequest: Parameters<WindowsNativeCoreShadow["statisticsProjection"]>[0] | null = null;
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

  async starMapOverviewProjection(_request: Parameters<WindowsNativeCoreShadow["starMapOverviewProjection"]>[0]): Promise<never> {
    throw new Error("star-map overview projection is not exercised by this controller fixture");
  }

  async stellarIndustryProjection(_request: Parameters<WindowsNativeCoreShadow["stellarIndustryProjection"]>[0]): Promise<never> {
    throw new Error("stellar industry projection is not exercised by this controller fixture");
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
    const nextCheckpoint = { ...checkpoint, generation: 2, revision: this.current.revision, rootHash: "f".repeat(64) };
    return { checkpoint: nextCheckpoint, summary: await this.status(), encodedRecords: 1, reusedRecords: 0 };
  }

  async exportV47(exportId: string, _suggestedName?: string, savedAtMs = 1) {
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

describe("Windows native core invitation-Beta controller", () => {
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
