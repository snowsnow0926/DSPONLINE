import type {
  NativeCoreAuthorityCheckpointReceipt,
  NativeCoreBetaControllerSnapshot,
  NativeCoreDurableArtifactIdentity,
} from "./nativeCoreBetaController";

export type NativeAuthorityRuntimeKind = "inactive" | "active" | "bound-paused" | "macro";

export interface NativeAuthorityRuntimeObservation {
  kind: NativeAuthorityRuntimeKind;
  sessionId: string | null;
  runId: string | null;
  revision: number | null;
}

export interface NativeAuthorityCheckpointToken {
  sessionId: string;
  runId: string;
  minimumRevision: number;
}

export interface NativeAuthorityPersistenceBoundary {
  protected: boolean;
  runtimeKind: NativeAuthorityRuntimeKind | "bootstrap-pending" | "recovery-required";
  checkpointToken: NativeAuthorityCheckpointToken | null;
  canExportAuthoritativeV47: boolean;
  reason: string;
}

const RECOVERY_PHASES = new Set(["paused-core-crash", "paused-recovery-required"]);

function validRevision(value: number | null): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function controllerOwnsNative(snapshot: NativeCoreBetaControllerSnapshot): boolean {
  return snapshot.authority.phase === "native-authoritative" &&
    snapshot.authority.authority === "native" &&
    typeof snapshot.authority.sessionId === "string" && snapshot.authority.sessionId.length > 0;
}

function controllerProofIsSelfConsistent(snapshot: NativeCoreBetaControllerSnapshot): boolean {
  const summary = snapshot.summary;
  const proof = snapshot.authority.latestVerifiedProof;
  return Boolean(summary && proof && snapshot.recoveryRootHash &&
    snapshot.authority.shadowRevision === summary.revision &&
    proof.revision === summary.revision &&
    proof.rootHash === snapshot.recoveryRootHash &&
    proof.canonicalSha256 === summary.canonicalSha256 &&
    proof.domainSha256 === summary.domainSha256 &&
    proof.registryFingerprint === summary.registryFingerprint);
}

/**
 * Persistence/replacement policy after the renderer has handed gameplay
 * authority to Rust.  A bound clock is enough to protect the save even if the
 * controller is currently recovering; lack of a usable receipt can only make
 * an operation less available, never reopen the JavaScript fallback.
 */
export function evaluateNativeAuthorityPersistenceBoundary(
  snapshot: NativeCoreBetaControllerSnapshot,
  runtime: NativeAuthorityRuntimeObservation,
): NativeAuthorityPersistenceBoundary {
  const recoveryRequired = RECOVERY_PHASES.has(snapshot.authority.phase) || snapshot.authority.authority === "none";
  const protectedState = runtime.kind !== "inactive" || controllerOwnsNative(snapshot) || recoveryRequired;
  if (!protectedState) {
    return {
      protected: false,
      runtimeKind: "inactive",
      checkpointToken: null,
      canExportAuthoritativeV47: false,
      reason: "javascript-authority",
    };
  }
  if (recoveryRequired) {
    return {
      protected: true,
      runtimeKind: "recovery-required",
      checkpointToken: null,
      canExportAuthoritativeV47: false,
      reason: "native-authority-recovery-required",
    };
  }
  if (runtime.kind !== "active") {
    return {
      protected: true,
      runtimeKind: runtime.kind,
      checkpointToken: null,
      canExportAuthoritativeV47: false,
      reason: runtime.kind === "macro"
        ? "native-macro-owns-durable-boundary"
        : "native-authority-not-settled",
    };
  }
  const controllerSessionId = snapshot.authority.sessionId;
  if (!controllerOwnsNative(snapshot) || typeof controllerSessionId !== "string" ||
    runtime.sessionId !== controllerSessionId || typeof runtime.runId !== "string" ||
    runtime.runId.length < 1 || !validRevision(runtime.revision)) {
    return {
      protected: true,
      runtimeKind: "active",
      checkpointToken: null,
      canExportAuthoritativeV47: false,
      reason: "native-authority-identity-unverified",
    };
  }
  return {
    protected: true,
    runtimeKind: "active",
    checkpointToken: {
      sessionId: controllerSessionId,
      runId: runtime.runId,
      minimumRevision: runtime.revision,
    },
    canExportAuthoritativeV47: true,
    reason: "native-authority-settled",
  };
}

/**
 * A durable artifact is immutable once ACKed, while the live clock is allowed
 * to advance. Bind both ends to the same session/run lineage and require only
 * monotonic revisions; equality with the post-dialog clock would turn normal
 * one-second ticks into false save failures.
 */
export function verifyNativeAuthorityArtifactLineage(
  token: NativeAuthorityCheckpointToken,
  artifact: NativeCoreDurableArtifactIdentity,
  runtime: NativeAuthorityRuntimeObservation,
): boolean {
  return (runtime.kind === "active" || runtime.kind === "bound-paused") &&
    runtime.sessionId === token.sessionId &&
    runtime.runId === token.runId && artifact.sessionId === token.sessionId &&
    artifact.runId === token.runId && validRevision(runtime.revision) &&
    validRevision(artifact.revision) && artifact.revision >= token.minimumRevision &&
    runtime.revision >= artifact.revision;
}

export function verifyNativeAuthorityCheckpointReceipt(
  token: NativeAuthorityCheckpointToken,
  receipt: NativeCoreAuthorityCheckpointReceipt,
  runtime: NativeAuthorityRuntimeObservation,
): boolean {
  return verifyNativeAuthorityCheckpointArtifact(token, receipt) &&
    verifyNativeAuthorityArtifactLineage(token, receipt.artifact.identity, runtime);
}

export function verifyNativeAuthorityCheckpointArtifact(
  token: NativeAuthorityCheckpointToken,
  receipt: NativeCoreAuthorityCheckpointReceipt,
): boolean {
  const { artifact, snapshot } = receipt;
  if (artifact.identity.sessionId !== token.sessionId || artifact.identity.runId !== token.runId ||
    !validRevision(artifact.identity.revision) || artifact.identity.revision < token.minimumRevision ||
    !controllerOwnsNative(snapshot) || snapshot.authority.sessionId !== token.sessionId ||
    !controllerProofIsSelfConsistent(snapshot) || artifact.checkpoint.revision !== artifact.identity.revision ||
    artifact.summary.revision !== artifact.identity.revision || artifact.summary.stateVersion !== 47 ||
    artifact.summary.mode !== "normal" || artifact.summary.paused !== false ||
    artifact.summary.coverage.authorityEligible !== true) return false;
  const latestProof = snapshot.authority.latestVerifiedProof;
  if (!latestProof || latestProof.revision < artifact.identity.revision ||
    latestProof.registryFingerprint !== artifact.summary.registryFingerprint) return false;
  return latestProof.revision > artifact.identity.revision ||
    (latestProof.rootHash === artifact.checkpoint.rootHash &&
      latestProof.canonicalSha256 === artifact.summary.canonicalSha256 &&
      latestProof.domainSha256 === artifact.summary.domainSha256);
}

export function nativeAuthorityReplacementBlockedMessage(
  operation: "import" | "cloud-restore" | "load-slot" | "load-snapshot" | "repair" | "content-pack",
): string {
  const labels = {
    import: "导入存档",
    "cloud-restore": "恢复云存档",
    "load-slot": "载入本地槽位",
    "load-snapshot": "回滚快照",
    repair: "受控存档修复",
    "content-pack": "修改内容包",
  } as const;
  return `Windows 原生权威尚未安全交还控制权，已阻止${labels[operation]}；当前 Rust 工厂和原存档均未改变`;
}
