import { describe, expect, it } from "vitest";

import {
  beginNativeCoreShadow,
  createNativeCoreAuthorityState,
  fallbackNativeCoreToJavaScript,
  handleNativeCoreExit,
  nativeCoreGateIssues,
  promoteNativeCoreAuthority,
  recordNativeCoreAuthorityCheckpoint,
  recordNativeCoreGateEvidence,
  recordNativeCoreShadowComparison,
  recoverNativeCoreAuthority,
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

