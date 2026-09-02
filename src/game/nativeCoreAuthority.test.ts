import { describe, expect, it } from "vitest";

import {
  beginNativeCoreShadow,
  bindMainOwnedNativeCoreAuthority,
  createNativeCoreAuthorityState,
  fallbackNativeCoreToJavaScript,
  handleNativeCoreExit,
  nativeCoreGateIssues,
  promoteNativeCoreAuthority,
  recordNativeCoreAuthorityProgress,
  recordNativeCoreAuthorityCheckpoint,
  recordNativeCoreGateEvidence,
  recordNativeCoreShadowComparison,
  recordNativeCoreUnverifiedShadowProgress,
  recoverNativeCoreAuthority,
  reseedNativeCoreShadow,
  type NativeCoreGateEvidence,
  type NativeCoreRevisionProof,
} from "./nativeCoreAuthority";

const proof = (revision: number, token = "a"): NativeCoreRevisionProof => ({
  revision,
  rootHash: token.repeat(64),
  canonicalSha256: "b".repeat(64),
  domainSha256: "c".repeat(64),
  registryFingerprint: "builtin:test",
});

const gate = (overrides: Partial<NativeCoreGateEvidence> = {}): NativeCoreGateEvidence => ({
  shadowStartedAtMs: 1_000,
  observedAtMs: 1_000 + 24 * 60 * 60 * 1_000,
  comparisonCount: 2,
  netThroughputRatio: 1.5,
  ipcFrameShare: 0.19,
  processTreeMemoryImprovementRatio: 0.3,
  authorityEligibleCoverage: true,
  ...overrides,
});

describe("native core authority state machine", () => {
  it("keeps JavaScript authoritative when the opening shadow proof diverges", () => {
    const state = beginNativeCoreShadow(createNativeCoreAuthorityState(), {
      sessionId: "core-1", javascriptProof: proof(4), nativeProof: proof(3), startedAtMs: 1_000,
    });
    expect(state).toMatchObject({ phase: "shadow-diverged", authority: "javascript", sessionId: null });
  });

  it("requires every Gate C condition before native-ready", () => {
    const issues = nativeCoreGateIssues(gate({ observedAtMs: 10, netThroughputRatio: 1.49, ipcFrameShare: 0.2 }));
    expect(issues).toEqual(expect.arrayContaining([
      "shadow-duration-under-24h", "throughput-under-1.5x", "ipc-share-not-under-20-percent",
    ]));
    const shadow = beginNativeCoreShadow(createNativeCoreAuthorityState(), {
      sessionId: "core-1", javascriptProof: proof(1), nativeProof: proof(1), startedAtMs: 1_000,
    });
    expect(recordNativeCoreGateEvidence(shadow, gate({ comparisonCount: 1, netThroughputRatio: 1.49 })).phase).toBe("shadow");
  });

  it("promotes only after matching comparisons, 24h evidence and an exact compatible checkpoint", () => {
    let state = beginNativeCoreShadow(createNativeCoreAuthorityState(), {
      sessionId: "core-1", javascriptProof: proof(1), nativeProof: proof(1), startedAtMs: 1_000,
    });
    state = recordNativeCoreShadowComparison(state, {
      javascriptProof: proof(2), nativeProof: proof(2), compatibleFallback: proof(2),
    });
    state = recordNativeCoreGateEvidence(state, gate());
    expect(state.phase).toBe("native-ready");
    expect(() => promoteNativeCoreAuthority(state, proof(1))).toThrow(/同 revision/);
    state = promoteNativeCoreAuthority(state, proof(2));
    expect(state).toMatchObject({ phase: "native-authoritative", authority: "native" });
  });

  it("binds a main-owned handoff only to the exact verified shadow identity", () => {
    let state = beginNativeCoreShadow(createNativeCoreAuthorityState(), {
      sessionId: "core-1", javascriptProof: proof(1), nativeProof: proof(1), startedAtMs: 1_000,
    });
    state = recordNativeCoreShadowComparison(state, {
      javascriptProof: proof(2), nativeProof: proof(2), compatibleFallback: proof(2),
    });
    const bound = bindMainOwnedNativeCoreAuthority(state, {
      sessionId: "core-1",
      proof: proof(2, "d"),
      authorityEligibleCoverage: true,
      source: "handoff",
    });
    expect(bound).toMatchObject({
      phase: "native-authoritative",
      authority: "native",
      sessionId: "core-1",
      shadowRevision: 2,
      latestVerifiedProof: proof(2, "d"),
    });
    expect(() => bindMainOwnedNativeCoreAuthority(state, {
      sessionId: "core-other",
      proof: proof(2, "d"),
      authorityEligibleCoverage: true,
      source: "handoff",
    })).toThrow(/影子不一致/);
  });

  it("binds startup recovery only from a fresh JavaScript state and never invents Gate evidence", () => {
    const state = bindMainOwnedNativeCoreAuthority(createNativeCoreAuthorityState(), {
      sessionId: "core-recovered-1",
      proof: proof(41, "e"),
      authorityEligibleCoverage: true,
      source: "startup-recovery",
    });
    expect(state).toMatchObject({
      phase: "native-authoritative",
      authority: "native",
      sessionId: "core-recovered-1",
      shadowRevision: 41,
      comparisonCount: 0,
      gateEvidence: null,
    });
    expect(() => bindMainOwnedNativeCoreAuthority(state, {
      sessionId: "core-recovered-1",
      proof: proof(41, "e"),
      authorityEligibleCoverage: true,
      source: "startup-recovery",
    })).toThrow(/启动恢复/);
  });

  it("continues comparing a ready shadow and keeps the latest exact fallback", () => {
    let state = beginNativeCoreShadow(createNativeCoreAuthorityState(), {
      sessionId: "core-1", javascriptProof: proof(1), nativeProof: proof(1), startedAtMs: 1_000,
    });
    state = recordNativeCoreShadowComparison(state, {
      javascriptProof: proof(2), nativeProof: proof(2), compatibleFallback: proof(2),
    });
    state = recordNativeCoreGateEvidence(state, gate());
    state = recordNativeCoreShadowComparison(state, {
      javascriptProof: proof(3, "d"), nativeProof: proof(3, "d"), compatibleFallback: proof(3, "d"),
    });
    expect(state).toMatchObject({ phase: "native-ready", comparisonCount: 3, latestVerifiedProof: proof(3, "d") });
  });

  it("cannot promote unverified replay and preserves shadow history after a verified reseed", () => {
    let state = beginNativeCoreShadow(createNativeCoreAuthorityState(), {
      sessionId: "core-1", javascriptProof: proof(1), nativeProof: proof(1), startedAtMs: 1_000,
    });
    state = recordNativeCoreUnverifiedShadowProgress(state, 2);
    expect(state).toMatchObject({ phase: "shadow", shadowRevision: 2, comparisonCount: 1 });
    expect(() => recordNativeCoreGateEvidence(state, gate({ comparisonCount: 1 }))).toThrow(/尚未比较/);
    state = recordNativeCoreShadowComparison(state, {
      javascriptProof: proof(2), nativeProof: proof(2), compatibleFallback: proof(2),
    });
    state = reseedNativeCoreShadow(state, {
      sessionId: "core-2", javascriptProof: proof(2, "d"), nativeProof: proof(2, "d"),
    });
    expect(state).toMatchObject({
      phase: "shadow",
      sessionId: "core-2",
      shadowStartedAtMs: 1_000,
      shadowRevision: 2,
      comparisonCount: 3,
      exactCompatibleFallback: proof(2, "d"),
    });
  });

  it("pauses after a native crash and rejects an older silent JavaScript rollback", () => {
    let state = beginNativeCoreShadow(createNativeCoreAuthorityState(), {
      sessionId: "core-1", javascriptProof: proof(1), nativeProof: proof(1), startedAtMs: 1_000,
    });
    state = recordNativeCoreShadowComparison(state, {
      javascriptProof: proof(2), nativeProof: proof(2), compatibleFallback: proof(2),
    });
    state = promoteNativeCoreAuthority(recordNativeCoreGateEvidence(state, gate()), proof(2));
    state = recordNativeCoreAuthorityCheckpoint(state, proof(5, "d"), proof(5, "d"));
    state = handleNativeCoreExit(state);
    expect(state).toMatchObject({ phase: "paused-core-crash", authority: "none" });
    const refused = fallbackNativeCoreToJavaScript(state, proof(2));
    expect(refused).toMatchObject({ phase: "paused-recovery-required", authority: "none" });
    const restored = recoverNativeCoreAuthority(refused, "core-2", proof(5, "d"));
    expect(restored).toMatchObject({ phase: "native-authoritative", authority: "native", sessionId: "core-2" });
  });

  it("records replayable WAL progress without moving the older JavaScript fallback", () => {
    let state = beginNativeCoreShadow(createNativeCoreAuthorityState(), {
      sessionId: "core-1", javascriptProof: proof(1), nativeProof: proof(1), startedAtMs: 1_000,
    });
    state = recordNativeCoreShadowComparison(state, {
      javascriptProof: proof(2), nativeProof: proof(2), compatibleFallback: proof(2),
    });
    state = promoteNativeCoreAuthority(recordNativeCoreGateEvidence(state, gate()), proof(2));
    state = recordNativeCoreAuthorityProgress(state, proof(4, "d"));
    expect(state.latestVerifiedProof).toEqual(proof(4, "d"));
    expect(state.exactCompatibleFallback).toEqual(proof(2));
    const paused = handleNativeCoreExit(state);
    expect(fallbackNativeCoreToJavaScript(paused, proof(2))).toMatchObject({
      phase: "paused-recovery-required", authority: "none",
    });
  });

  it("allows explicit JS fallback only from the exact verified native revision", () => {
    let state = beginNativeCoreShadow(createNativeCoreAuthorityState(), {
      sessionId: "core-1", javascriptProof: proof(1), nativeProof: proof(1), startedAtMs: 1_000,
    });
    state = recordNativeCoreShadowComparison(state, {
      javascriptProof: proof(2), nativeProof: proof(2), compatibleFallback: proof(2),
    });
    state = handleNativeCoreExit(promoteNativeCoreAuthority(recordNativeCoreGateEvidence(state, gate()), proof(2)));
    const fallback = fallbackNativeCoreToJavaScript(state, proof(2));
    expect(fallback).toMatchObject({ phase: "js-only", authority: "javascript", reason: "explicit-javascript-fallback" });
  });
});
