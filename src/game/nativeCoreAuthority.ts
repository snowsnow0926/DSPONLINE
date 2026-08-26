export type NativeCoreAuthorityPhase =
  | "js-only"
  | "shadow"
  | "shadow-diverged"
  | "native-ready"
  | "native-authoritative"
  | "paused-core-crash"
  | "paused-recovery-required";

export type NativeCoreAuthorityOwner = "javascript" | "native" | "none";

export interface NativeCoreRevisionProof {
  revision: number;
  rootHash: string;
  canonicalSha256: string;
  domainSha256: string;
  registryFingerprint: string;
}

export interface NativeCoreGateEvidence {
  shadowStartedAtMs: number;
  observedAtMs: number;
  comparisonCount: number;
  netThroughputRatio: number;
  ipcFrameShare: number;
  processTreeMemoryImprovementRatio: number;
  authorityEligibleCoverage: boolean;
}

export interface NativeCoreAuthorityState {
  phase: NativeCoreAuthorityPhase;
  authority: NativeCoreAuthorityOwner;
  sessionId: string | null;
  shadowStartedAtMs: number | null;
  /** Current in-memory shadow/native revision, including not-yet-compared replay. */
  shadowRevision: number | null;
  comparisonCount: number;
  latestVerifiedProof: NativeCoreRevisionProof | null;
  exactCompatibleFallback: NativeCoreRevisionProof | null;
  gateEvidence: NativeCoreGateEvidence | null;
  reason: string | null;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ROOT_HASH_PATTERN = SHA256_PATTERN;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const GATE_SHADOW_DURATION_MS = 24 * 60 * 60 * 1_000;

function validProof(proof: NativeCoreRevisionProof): boolean {
  return Number.isSafeInteger(proof.revision) && proof.revision >= 0 &&
    ROOT_HASH_PATTERN.test(proof.rootHash) && SHA256_PATTERN.test(proof.canonicalSha256) &&
    SHA256_PATTERN.test(proof.domainSha256) && proof.registryFingerprint.length > 0 &&
    proof.registryFingerprint.length <= 256;
}

export function sameNativeCoreRevisionProof(
  left: NativeCoreRevisionProof,
  right: NativeCoreRevisionProof,
): boolean {
  return left.revision === right.revision && left.rootHash === right.rootHash &&
    left.canonicalSha256 === right.canonicalSha256 && left.domainSha256 === right.domainSha256 &&
    left.registryFingerprint === right.registryFingerprint;
}

export function createNativeCoreAuthorityState(): NativeCoreAuthorityState {
  return {
    phase: "js-only",
    authority: "javascript",
    sessionId: null,
    shadowStartedAtMs: null,
    shadowRevision: null,
    comparisonCount: 0,
    latestVerifiedProof: null,
    exactCompatibleFallback: null,
    gateEvidence: null,
    reason: null,
  };
}

export function beginNativeCoreShadow(
  current: NativeCoreAuthorityState,
  input: {
    sessionId: string;
    javascriptProof: NativeCoreRevisionProof;
    nativeProof: NativeCoreRevisionProof;
    startedAtMs: number;
  },
): NativeCoreAuthorityState {
  if (current.authority !== "javascript" || !["js-only", "shadow-diverged"].includes(current.phase)) {
    throw new Error("只有 JavaScript 权威状态可以启动原生影子");
  }
  if (!SESSION_ID_PATTERN.test(input.sessionId) || !validProof(input.javascriptProof) ||
    !validProof(input.nativeProof) || !Number.isFinite(input.startedAtMs) || input.startedAtMs < 0) {
    throw new Error("原生影子启动身份无效");
  }
  if (!sameNativeCoreRevisionProof(input.javascriptProof, input.nativeProof)) {
    return {
      ...createNativeCoreAuthorityState(),
      phase: "shadow-diverged",
      reason: "shadow-open-proof-mismatch",
      shadowRevision: null,
      latestVerifiedProof: input.javascriptProof,
      exactCompatibleFallback: input.javascriptProof,
    };
  }
  return {
    phase: "shadow",
    authority: "javascript",
    sessionId: input.sessionId,
    shadowStartedAtMs: input.startedAtMs,
    shadowRevision: input.javascriptProof.revision,
    comparisonCount: 1,
    latestVerifiedProof: input.javascriptProof,
    exactCompatibleFallback: input.javascriptProof,
    gateEvidence: null,
    reason: null,
  };
}

export function recordNativeCoreShadowComparison(
  current: NativeCoreAuthorityState,
  input: {
    javascriptProof: NativeCoreRevisionProof;
    nativeProof: NativeCoreRevisionProof;
    compatibleFallback?: NativeCoreRevisionProof;
  },
): NativeCoreAuthorityState {
  if (!["shadow", "native-ready"].includes(current.phase) || current.authority !== "javascript" || !current.sessionId) {
    throw new Error("当前没有可比较的原生影子");
  }
  if (!validProof(input.javascriptProof) || !validProof(input.nativeProof) ||
    input.javascriptProof.revision < (current.latestVerifiedProof?.revision ?? 0) ||
    input.javascriptProof.revision < (current.shadowRevision ?? 0)) {
    throw new Error("原生影子比较 revision 无效");
  }
  if (!sameNativeCoreRevisionProof(input.javascriptProof, input.nativeProof)) {
    return {
      ...current,
      phase: "shadow-diverged",
      sessionId: null,
      gateEvidence: null,
      reason: "shadow-state-diverged",
    };
  }
  const fallback = input.compatibleFallback;
  if (fallback && (!validProof(fallback) || !sameNativeCoreRevisionProof(fallback, input.javascriptProof))) {
    throw new Error("兼容回退检查点与影子 revision 不一致");
  }
  return {
    ...current,
    comparisonCount: current.comparisonCount + 1,
    shadowRevision: input.javascriptProof.revision,
    latestVerifiedProof: input.javascriptProof,
    exactCompatibleFallback: fallback ?? current.exactCompatibleFallback,
    reason: null,
  };
}

/** Marks a durably replayed shadow revision without claiming a state match. */
export function recordNativeCoreUnverifiedShadowProgress(
  current: NativeCoreAuthorityState,
  revision: number,
): NativeCoreAuthorityState {
  if (!["shadow", "native-ready"].includes(current.phase) || current.authority !== "javascript" ||
    !current.sessionId || !Number.isSafeInteger(revision) || revision <= (current.shadowRevision ?? -1)) {
    throw new Error("原生影子未校验 revision 不连续");
  }
  return {
    ...current,
    phase: "shadow",
    shadowRevision: revision,
    gateEvidence: null,
    reason: "shadow-comparison-pending",
  };
}

/** Replaces the physical checkpoint/session while preserving 24h shadow history. */
export function reseedNativeCoreShadow(
  current: NativeCoreAuthorityState,
  input: {
    sessionId: string;
    javascriptProof: NativeCoreRevisionProof;
    nativeProof: NativeCoreRevisionProof;
  },
): NativeCoreAuthorityState {
  if (!["shadow", "native-ready"].includes(current.phase) || current.authority !== "javascript" ||
    !current.sessionId || current.shadowStartedAtMs === null || !SESSION_ID_PATTERN.test(input.sessionId) ||
    !validProof(input.javascriptProof) || !validProof(input.nativeProof) ||
    current.shadowRevision !== current.latestVerifiedProof?.revision ||
    input.javascriptProof.revision < (current.latestVerifiedProof?.revision ?? 0)) {
    throw new Error("原生影子重建身份无效");
  }
  if (!sameNativeCoreRevisionProof(input.javascriptProof, input.nativeProof)) {
    return {
      ...current,
      phase: "shadow-diverged",
      sessionId: null,
      shadowRevision: null,
      gateEvidence: null,
      reason: "shadow-reseed-proof-mismatch",
    };
  }
  return {
    ...current,
    phase: "shadow",
    sessionId: input.sessionId,
    shadowRevision: input.javascriptProof.revision,
    comparisonCount: current.comparisonCount + 1,
    latestVerifiedProof: input.javascriptProof,
    exactCompatibleFallback: input.javascriptProof,
    gateEvidence: null,
    reason: null,
  };
}

export function nativeCoreGateIssues(evidence: NativeCoreGateEvidence): string[] {
  const issues: string[] = [];
  if (!Number.isFinite(evidence.shadowStartedAtMs) || !Number.isFinite(evidence.observedAtMs) ||
    evidence.observedAtMs - evidence.shadowStartedAtMs < GATE_SHADOW_DURATION_MS) issues.push("shadow-duration-under-24h");
  if (!Number.isSafeInteger(evidence.comparisonCount) || evidence.comparisonCount < 1) issues.push("no-shadow-comparisons");
  if (!Number.isFinite(evidence.netThroughputRatio) || evidence.netThroughputRatio < 1.5) issues.push("throughput-under-1.5x");
  if (!Number.isFinite(evidence.ipcFrameShare) || evidence.ipcFrameShare < 0 || evidence.ipcFrameShare >= 0.2) issues.push("ipc-share-not-under-20-percent");
  if (!Number.isFinite(evidence.processTreeMemoryImprovementRatio) || evidence.processTreeMemoryImprovementRatio <= 0) issues.push("process-tree-memory-not-improved");
  if (!evidence.authorityEligibleCoverage) issues.push("native-domain-coverage-incomplete");
  return issues;
}

export function recordNativeCoreGateEvidence(
  current: NativeCoreAuthorityState,
  evidence: NativeCoreGateEvidence,
): NativeCoreAuthorityState {
  if (!["shadow", "native-ready"].includes(current.phase) || current.authority !== "javascript" || current.shadowStartedAtMs === null) {
    throw new Error("原生 Gate 只能绑定正在运行的影子");
  }
  if (!current.latestVerifiedProof || current.shadowRevision !== current.latestVerifiedProof.revision) {
    throw new Error("原生影子仍有尚未比较的 revision");
  }
  if (evidence.shadowStartedAtMs !== current.shadowStartedAtMs || evidence.comparisonCount > current.comparisonCount) {
    throw new Error("原生 Gate 证据不属于当前影子会话");
  }
  const issues = nativeCoreGateIssues(evidence);
  return {
    ...current,
    phase: issues.length === 0 ? "native-ready" : "shadow",
    gateEvidence: issues.length === 0 ? evidence : null,
    reason: issues.length === 0 ? null : `gate-blocked:${issues.join(",")}`,
  };
}

export function promoteNativeCoreAuthority(
  current: NativeCoreAuthorityState,
  exactCompatibleCheckpoint: NativeCoreRevisionProof,
): NativeCoreAuthorityState {
  if (current.phase !== "native-ready" || current.authority !== "javascript" || !current.sessionId ||
    !current.gateEvidence || nativeCoreGateIssues(current.gateEvidence).length > 0 || !current.latestVerifiedProof ||
    current.shadowRevision !== current.latestVerifiedProof.revision) {
    throw new Error("原生核心尚未满足权威切换门槛");
  }
  if (!validProof(exactCompatibleCheckpoint) ||
    !sameNativeCoreRevisionProof(current.latestVerifiedProof, exactCompatibleCheckpoint)) {
    throw new Error("权威切换缺少同 revision 的兼容恢复点");
  }
  return {
    ...current,
    phase: "native-authoritative",
    authority: "native",
    exactCompatibleFallback: exactCompatibleCheckpoint,
    reason: null,
  };
}

export function recordNativeCoreAuthorityCheckpoint(
  current: NativeCoreAuthorityState,
  nativeProof: NativeCoreRevisionProof,
  exactCompatibleCheckpoint: NativeCoreRevisionProof,
): NativeCoreAuthorityState {
  if (current.phase !== "native-authoritative" || current.authority !== "native") {
    throw new Error("只有原生权威可以提交原生检查点");
  }
  if (!validProof(nativeProof) || !validProof(exactCompatibleCheckpoint) ||
    !sameNativeCoreRevisionProof(nativeProof, exactCompatibleCheckpoint) ||
    nativeProof.revision < (current.latestVerifiedProof?.revision ?? 0)) {
    throw new Error("原生权威检查点证明无效");
  }
  return { ...current, shadowRevision: nativeProof.revision, latestVerifiedProof: nativeProof, exactCompatibleFallback: exactCompatibleCheckpoint };
}

/**
 * Advance the last replayable native proof after a durable WAL operation.
 * The compatible JavaScript fallback intentionally remains at its older
 * checkpoint until a same-revision v47 checkpoint is written and verified.
 */
export function recordNativeCoreAuthorityProgress(
  current: NativeCoreAuthorityState,
  nativeProof: NativeCoreRevisionProof,
): NativeCoreAuthorityState {
  if (current.phase !== "native-authoritative" || current.authority !== "native" ||
    !current.latestVerifiedProof || !validProof(nativeProof) ||
    nativeProof.revision < current.latestVerifiedProof.revision ||
    nativeProof.registryFingerprint !== current.latestVerifiedProof.registryFingerprint) {
    throw new Error("原生权威 WAL 进度证明无效");
  }
  if (nativeProof.revision === current.latestVerifiedProof.revision &&
    !sameNativeCoreRevisionProof(nativeProof, current.latestVerifiedProof)) {
    throw new Error("原生权威同 revision 出现不同证明");
  }
  return { ...current, shadowRevision: nativeProof.revision, latestVerifiedProof: nativeProof, reason: null };
}

export function handleNativeCoreExit(
  current: NativeCoreAuthorityState,
  reason = "native-core-exited",
): NativeCoreAuthorityState {
  if (current.authority === "javascript") {
    return {
      ...createNativeCoreAuthorityState(),
      latestVerifiedProof: current.latestVerifiedProof,
      exactCompatibleFallback: current.exactCompatibleFallback,
      reason,
    };
  }
  if (current.authority !== "native" || current.phase !== "native-authoritative") return current;
  return {
    ...current,
    phase: "paused-core-crash",
    authority: "none",
    sessionId: null,
    reason,
  };
}

export function recoverNativeCoreAuthority(
  current: NativeCoreAuthorityState,
  sessionId: string,
  recoveredProof: NativeCoreRevisionProof,
): NativeCoreAuthorityState {
  if (!["paused-core-crash", "paused-recovery-required"].includes(current.phase) ||
    current.authority !== "none" || !current.latestVerifiedProof || !SESSION_ID_PATTERN.test(sessionId) ||
    !validProof(recoveredProof) || !sameNativeCoreRevisionProof(current.latestVerifiedProof, recoveredProof)) {
    return { ...current, phase: "paused-recovery-required", authority: "none", reason: "native-recovery-proof-mismatch" };
  }
  return { ...current, phase: "native-authoritative", authority: "native", sessionId, shadowRevision: recoveredProof.revision, reason: null };
}

export function fallbackNativeCoreToJavaScript(
  current: NativeCoreAuthorityState,
  compatibleCheckpoint: NativeCoreRevisionProof,
): NativeCoreAuthorityState {
  if (!["paused-core-crash", "paused-recovery-required"].includes(current.phase) || current.authority !== "none" ||
    !current.latestVerifiedProof || !current.exactCompatibleFallback || !validProof(compatibleCheckpoint) ||
    !sameNativeCoreRevisionProof(current.latestVerifiedProof, compatibleCheckpoint) ||
    !sameNativeCoreRevisionProof(current.exactCompatibleFallback, compatibleCheckpoint)) {
    return { ...current, phase: "paused-recovery-required", authority: "none", reason: "javascript-fallback-proof-mismatch" };
  }
  return {
    ...createNativeCoreAuthorityState(),
    latestVerifiedProof: compatibleCheckpoint,
    exactCompatibleFallback: compatibleCheckpoint,
    reason: "explicit-javascript-fallback",
  };
}
