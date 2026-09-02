import { describe, expect, it } from "vitest";
import type { DesktopNativeCoreDomainCoverage } from "../desktop";
import type { NativeCoreBetaControllerSnapshot } from "./nativeCoreBetaController";
import {
  evaluateNativeAuthorityPersistenceBoundary,
  nativeAuthorityReplacementBlockedMessage,
  verifyNativeAuthorityArtifactLineage,
  verifyNativeAuthorityCheckpointArtifact,
  verifyNativeAuthorityCheckpointReceipt,
  type NativeAuthorityRuntimeObservation,
} from "./nativeAuthorityPersistenceBoundary";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function nativeSnapshot(revision = 12): NativeCoreBetaControllerSnapshot {
  return {
    authority: {
      phase: "native-authoritative",
      authority: "native",
      sessionId: "native-session",
      shadowStartedAtMs: 1,
      shadowRevision: revision,
      comparisonCount: 10,
      latestVerifiedProof: {
        revision,
        rootHash: HASH_A,
        canonicalSha256: HASH_B,
        domainSha256: HASH_C,
        registryFingerprint: "registry-1",
      },
      exactCompatibleFallback: null,
      gateEvidence: null,
      reason: null,
    },
    summary: {
      revision,
      stateVersion: 47,
      mode: "normal",
      activePlanetId: "planet-1",
      elapsedSeconds: 100,
      paused: false,
      entityCount: 2,
      beltCount: 1,
      canonicalSha256: HASH_B,
      canonicalComponents: { base: HASH_A, entities: HASH_B, belts: HASH_C },
      canonicalFields: {},
      domainSha256: HASH_C,
      catalogSha256: HASH_A,
      registryFingerprint: "registry-1",
      memory: {
        rawRecordBytes: 1,
        indexedStringBytes: 1,
        inventoryEntryCount: 0,
        topologyIndexBytes: 1,
        estimatedRuntimeBytes: 3,
      },
      coverage: { authorityEligible: true } as DesktopNativeCoreDomainCoverage,
    },
    recoveryRootHash: HASH_A,
  };
}

function runtime(kind: NativeAuthorityRuntimeObservation["kind"], revision: number | null = 12): NativeAuthorityRuntimeObservation {
  return {
    kind,
    sessionId: kind === "inactive" ? null : "native-session",
    runId: kind === "active" || kind === "bound-paused" ? "native-run" : null,
    revision: kind === "inactive" ? null : revision,
  };
}

function checkpointReceipt(artifactRevision = 13, snapshotRevision = artifactRevision) {
  const artifactSnapshot = nativeSnapshot(artifactRevision);
  return {
    artifact: {
      identity: {
        sessionId: "native-session",
        runId: "native-run",
        revision: artifactRevision,
      },
      checkpoint: { generation: 3, rootHash: HASH_A, revision: artifactRevision },
      summary: artifactSnapshot.summary!,
    },
    snapshot: nativeSnapshot(snapshotRevision),
  };
}

describe("native authority persistence boundary", () => {
  it("leaves JavaScript-only persistence behavior open", () => {
    const snapshot = nativeSnapshot();
    snapshot.authority.phase = "js-only";
    snapshot.authority.authority = "javascript";
    snapshot.authority.sessionId = null;
    snapshot.summary = null;
    snapshot.recoveryRootHash = null;
    expect(evaluateNativeAuthorityPersistenceBoundary(snapshot, runtime("inactive"))).toEqual({
      protected: false,
      runtimeKind: "inactive",
      checkpointToken: null,
      canExportAuthoritativeV47: false,
      reason: "javascript-authority",
    });
  });

  it.each(["shadow", "native-ready"] as const)("does not block %s while JavaScript is still authority", (phase) => {
    const snapshot = nativeSnapshot();
    snapshot.authority.phase = phase;
    snapshot.authority.authority = "javascript";
    expect(evaluateNativeAuthorityPersistenceBoundary(snapshot, runtime("inactive"))).toMatchObject({
      protected: false,
      runtimeKind: "inactive",
      reason: "javascript-authority",
    });
  });

  it.each(["bound-paused", "macro"] as const)("protects %s without inventing a checkpoint", (kind) => {
    const boundary = evaluateNativeAuthorityPersistenceBoundary(nativeSnapshot(), runtime(kind));
    expect(boundary.protected).toBe(true);
    expect(boundary.checkpointToken).toBeNull();
    expect(boundary.canExportAuthoritativeV47).toBe(false);
  });

  it.each(["paused-core-crash", "paused-recovery-required"] as const)("keeps %s protected after the clock identity disappears", (phase) => {
    const snapshot = nativeSnapshot();
    snapshot.authority.phase = phase;
    snapshot.authority.authority = "none";
    snapshot.authority.sessionId = null;
    const boundary = evaluateNativeAuthorityPersistenceBoundary(snapshot, runtime("inactive"));
    expect(boundary).toMatchObject({ protected: true, runtimeKind: "recovery-required", checkpointToken: null });
  });

  it("allows only settled active authority to request a native durable checkpoint", () => {
    const boundary = evaluateNativeAuthorityPersistenceBoundary(nativeSnapshot(), runtime("active"));
    expect(boundary).toMatchObject({
      protected: true,
      runtimeKind: "active",
      checkpointToken: { sessionId: "native-session", runId: "native-run", minimumRevision: 12 },
      canExportAuthoritativeV47: true,
    });
  });

  it("accepts same-lineage forward clock progress and rejects rollback, replacement, or corrupt artifacts", () => {
    const token = evaluateNativeAuthorityPersistenceBoundary(nativeSnapshot(), runtime("active")).checkpointToken!;
    expect(verifyNativeAuthorityCheckpointReceipt(token, checkpointReceipt(13), runtime("active", 13))).toBe(true);
    expect(verifyNativeAuthorityCheckpointReceipt(token, checkpointReceipt(13, 14), runtime("active", 15))).toBe(true);
    expect(verifyNativeAuthorityCheckpointReceipt(token, checkpointReceipt(13, 14), runtime("bound-paused", 15))).toBe(true);
    expect(verifyNativeAuthorityCheckpointReceipt(token, checkpointReceipt(11), runtime("active", 15))).toBe(false);
    expect(verifyNativeAuthorityCheckpointReceipt(token, checkpointReceipt(13), runtime("active", 12))).toBe(false);
    expect(verifyNativeAuthorityCheckpointReceipt(token, checkpointReceipt(13), {
      kind: "active",
      sessionId: "replacement-session",
      runId: "native-run",
      revision: 13,
    })).toBe(false);
    expect(verifyNativeAuthorityCheckpointReceipt(token, checkpointReceipt(13), {
      kind: "active",
      sessionId: "native-session",
      runId: "replacement-run",
      revision: 13,
    })).toBe(false);
    const corrupt = checkpointReceipt(13);
    corrupt.snapshot.recoveryRootHash = HASH_B;
    expect(verifyNativeAuthorityCheckpointReceipt(token, corrupt, runtime("active", 13))).toBe(false);
    expect(verifyNativeAuthorityCheckpointArtifact(token, checkpointReceipt(13, 14))).toBe(true);
    expect(verifyNativeAuthorityCheckpointArtifact(token, checkpointReceipt(11))).toBe(false);
    const replacedArtifact = checkpointReceipt(13);
    replacedArtifact.artifact.identity.runId = "replacement-run";
    expect(verifyNativeAuthorityCheckpointArtifact(token, replacedArtifact)).toBe(false);
    expect(verifyNativeAuthorityCheckpointArtifact(token, corrupt)).toBe(false);
    expect(verifyNativeAuthorityArtifactLineage(token, {
      sessionId: "native-session",
      runId: "native-run",
      revision: 13,
    }, runtime("active", 99))).toBe(true);
    expect(verifyNativeAuthorityArtifactLineage(token, {
      sessionId: "native-session",
      runId: "native-run",
      revision: 13,
    }, runtime("bound-paused", 14))).toBe(true);
    expect(verifyNativeAuthorityArtifactLineage(token, {
      sessionId: "native-session",
      runId: "native-run",
      revision: 13,
    }, runtime("bound-paused", 12))).toBe(false);
  });

  it("does not mutate source state when a replacement is rejected", () => {
    const source = Object.freeze({ revision: 99, inventory: Object.freeze({ iron: 123 }) });
    const before = JSON.stringify(source);
    const boundary = evaluateNativeAuthorityPersistenceBoundary(nativeSnapshot(), runtime("macro", 20));
    expect(boundary.protected).toBe(true);
    expect(nativeAuthorityReplacementBlockedMessage("import")).toContain("均未改变");
    expect(JSON.stringify(source)).toBe(before);
  });
});
