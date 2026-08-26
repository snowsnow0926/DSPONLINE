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
  NativeCoreAuthorityPausedError,
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

  async commitOperation(request: {
    commandId: string;
    baseRevision: number;
  }): Promise<DesktopNativeCoreCommitOperationResult> {
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
    return { checkpoint: nextCheckpoint, summary: await this.status() };
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

async function readyController(session: FakeNativeSession) {
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
  controller.promoteToAuthority(proof(2), true);
  return controller;
}

describe("Windows native core invitation-Beta controller", () => {
  it("mirrors JavaScript durably while JavaScript remains authoritative", async () => {
    const session = new FakeNativeSession();
    const controller = await openController(session);
    const mirrored = await controller.mirrorJavaScriptOperation({
      commandId: "shadow-1",
      baseRevision: 1,
      simulationSeconds: 1,
      wallSeconds: 1,
      javascriptProof: proof(2),
      compatibleFallback: proof(2),
    });
    expect(mirrored).toMatchObject({ mirrored: true, state: { phase: "shadow", authority: "javascript", comparisonCount: 2 } });
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
    });
    expect(replayed).toMatchObject({ mirrored: true, state: { shadowRevision: 2, comparisonCount: 1 } });
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

  it("retries an uncertain durable command with the same ID and publishes only a bounded projection", async () => {
    const session = new FakeNativeSession();
    const controller = await readyController(session);
    session.uncertainOnce = true;
    const result = await controller.commitAuthoritativeOperation({
      commandId: "authority-2",
      baseRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
      projection: { baseFields: ["metrics", "metrics"], entityIds: ["entity-1"], beltIds: [] },
    });
    expect(result.commit).toMatchObject({ revision: 3, duplicate: true });
    expect(result.projection).toMatchObject({ revision: 3, entities: [{ id: "entity-1" }] });
    expect(result.state).toMatchObject({ phase: "native-authoritative", authority: "native", latestVerifiedProof: { revision: 3 } });
    expect(result.state.exactCompatibleFallback).toEqual(proof(2));
    expect(session.projectionCalls).toBe(1);
  });

  it("pauses on an unconfirmed native failure and never silently installs the older JavaScript checkpoint", async () => {
    const session = new FakeNativeSession();
    const controller = await readyController(session);
    session.alwaysFail = true;
    await expect(controller.commitAuthoritativeOperation({
      commandId: "authority-failure",
      baseRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
    })).rejects.toBeInstanceOf(NativeCoreAuthorityPausedError);
    expect(controller.snapshot().authority).toMatchObject({ phase: "paused-core-crash", authority: "none" });
  });

  it("refuses an older fallback after durable native progress and requires exact recovery", async () => {
    const session = new FakeNativeSession();
    const controller = await readyController(session);
    await controller.commitAuthoritativeOperation({
      commandId: "authority-2",
      baseRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
    });
    await controller.notifyCoreExit("test-crash");
    const refused = await controller.explicitFallbackToJavaScript(proof(2));
    expect(refused.authority).toMatchObject({ phase: "paused-recovery-required", authority: "none" });
  });

  it("rejects an oversized projection before committing a player operation", async () => {
    const session = new FakeNativeSession();
    const controller = await readyController(session);
    await expect(controller.commitAuthoritativeOperation({
      commandId: "authority-oversized",
      baseRevision: 2,
      simulationSeconds: 1,
      wallSeconds: 1,
      projection: { entityIds: Array.from({ length: 4_097 }, (_, index) => `entity-${index}`) },
    })).rejects.toThrow(/单帧上限/);
    expect(session.current.revision).toBe(2);
    expect(controller.snapshot().authority.authority).toBe("native");
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
