import type {
  NativePlayerAuthorityCommandReceipt,
  NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type {
  NativeConstructionQueueDeployBinding,
  NativeConstructionQueueMembershipProof,
} from "./nativeBlueprintWorkspaceStore";

export const NATIVE_CONSTRUCTION_QUEUE_DEPLOY_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

export type NativeConstructionQueueDeployPendingPhase =
  | "dispatching"
  | "reconciling"
  | "awaiting-projection"
  | "blocked";

export interface NativeConstructionQueueDeployCommitReceipt {
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

export type NativeConstructionQueueDeployBlockedReason =
  | "conflict"
  | "receipt-invalid"
  | "pending-timeout"
  | "reconciliation-unavailable"
  | "receipt-projection-mismatch";

export interface NativeConstructionQueueDeployPendingCommand
  extends NativeConstructionQueueDeployBinding {
  readonly token: number;
  readonly source: NativePlayerAuthorityCommandSource;
  readonly command: SimulationCommandPatch;
  readonly phase: NativeConstructionQueueDeployPendingPhase;
  readonly receipt: NativeConstructionQueueDeployCommitReceipt | null;
  readonly membershipProof: NativeConstructionQueueMembershipProof | null;
  readonly blockedReason: NativeConstructionQueueDeployBlockedReason | null;
}

export type NativeConstructionQueueDeployReconciliationResult = Readonly<
  | { status: "committed"; receipt: NativeConstructionQueueDeployCommitReceipt }
  | { status: "not-committed" }
  | { status: "cancelled" }
  | { status: "blocked"; reason: NativeConstructionQueueDeployBlockedReason }
>;

export type NativeConstructionQueueDeployProjectionResult = Readonly<
  | { status: "waiting" }
  | { status: "confirmed" }
  | { status: "stale-proof" }
  | { status: "lineage-changed" }
  | { status: "blocked"; reason: "receipt-projection-mismatch" }
>;

export interface NativeConstructionQueueDeployAuthorityObservation {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every(
    (key) => typeof key === "string" && expected.includes(key),
  ) && expected.every((key) => Object.hasOwn(value, key));
}

function isEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}

function pinExactDeployCommand(
  command: SimulationCommandPatch,
  binding: NativeConstructionQueueDeployBinding,
): SimulationCommandPatch {
  const value = command as unknown;
  if (!isRecord(value) || !hasExactKeys(value, [
    "protocolVersion",
    "baseRevision",
    "topLevelChanges",
    "changedEntities",
    "addedEntities",
    "removedEntityIds",
    "changedBelts",
    "addedBelts",
    "removedBeltIds",
  ]) || value.protocolVersion !== SIMULATION_RUNTIME_PROTOCOL_VERSION ||
      value.baseRevision !== binding.revision || !Array.isArray(value.topLevelChanges) ||
      value.topLevelChanges.length !== 1 ||
      !isEmptyArray(value.changedEntities) || !isEmptyArray(value.addedEntities) ||
      !isEmptyArray(value.removedEntityIds) || !isEmptyArray(value.changedBelts) ||
      !isEmptyArray(value.addedBelts) || !isEmptyArray(value.removedBeltIds)) {
    throw new TypeError("原生施工部署命令不是精确的单意图补丁");
  }
  const marker = value.topLevelChanges[0];
  if (!isRecord(marker) || !hasExactKeys(marker, ["path", "operation", "value"]) ||
      !Array.isArray(marker.path) || marker.path.length !== 2 ||
      marker.path[0] !== "constructionQueue" || marker.path[1] !== "intent" ||
      marker.operation !== "set" || !isRecord(marker.value) ||
      !hasExactKeys(marker.value, ["kind", "id", "revision"]) ||
      marker.value.kind !== "deploy" || marker.value.id !== binding.queueEntryId ||
      marker.value.revision !== binding.revision) {
    throw new TypeError("原生施工部署命令标记与 Rust-ready 队列行不一致");
  }

  const pinnedValue = Object.freeze({
    kind: "deploy" as const,
    id: binding.queueEntryId,
    revision: binding.revision,
  });
  const pinnedMarker = Object.freeze({
    path: Object.freeze(["constructionQueue", "intent"]),
    operation: "set" as const,
    value: pinnedValue,
  });
  return Object.freeze({
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: binding.revision,
    topLevelChanges: Object.freeze([pinnedMarker]),
    changedEntities: Object.freeze([]),
    addedEntities: Object.freeze([]),
    removedEntityIds: Object.freeze([]),
    changedBelts: Object.freeze([]),
    addedBelts: Object.freeze([]),
    removedBeltIds: Object.freeze([]),
  }) as unknown as SimulationCommandPatch;
}

function pinReceipt(
  pending: NativeConstructionQueueDeployPendingCommand,
  receipt: NativeConstructionQueueDeployCommitReceipt,
): NativeConstructionQueueDeployCommitReceipt {
  const value = receipt as unknown;
  if (!isRecord(value) || !hasExactKeys(value, [
    "previousRevision",
    "revision",
    "changedEntityIds",
    "changedBeltIds",
    "topologyDirty",
  ]) || !Array.isArray(receipt.changedEntityIds) || !Array.isArray(receipt.changedBeltIds) ||
      receipt.previousRevision !== pending.revision ||
      receipt.revision !== pending.revision + 1 ||
      receipt.changedEntityIds.length !== 0 || receipt.changedBeltIds.length !== 0 ||
      receipt.topologyDirty !== true) {
    throw new TypeError("原生施工部署回执与原命令不一致");
  }
  return Object.freeze({
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: Object.freeze([]),
    changedBeltIds: Object.freeze([]),
    topologyDirty: true,
  });
}

export function createNativeConstructionQueueDeployPendingCommand(input: Readonly<{
  token: number;
  source: NativePlayerAuthorityCommandSource;
  command: SimulationCommandPatch;
  binding: NativeConstructionQueueDeployBinding;
}>): NativeConstructionQueueDeployPendingCommand {
  const { token, source, binding } = input;
  if (!Number.isSafeInteger(token) || token <= 0 ||
      source.sessionId !== binding.sessionId || source.runId !== binding.runId ||
      source.baseRevision !== binding.revision ||
      !Number.isSafeInteger(binding.queueTotalCount) || binding.queueTotalCount < 1 ||
      !Number.isSafeInteger(binding.queuePageCursor) || binding.queuePageCursor < 0 ||
      !Number.isSafeInteger(binding.blueprintRevision) || binding.blueprintRevision < 1 ||
      binding.status !== "pending-materials" || binding.semanticStatus !== "catalog-backed" ||
      binding.actionable !== true || !Number.isSafeInteger(binding.counts.entities) ||
      binding.counts.entities < 1 || !Number.isSafeInteger(binding.counts.belts) ||
      binding.counts.belts < 0 || binding.counts.resourceAnchors !== 0 ||
      binding.counts.externalPorts !== 0) {
    throw new TypeError("原生施工部署命令 source 与 Rust-ready 队列行不一致");
  }
  const command = pinExactDeployCommand(input.command, binding);
  return Object.freeze({
    ...binding,
    counts: Object.freeze({ ...binding.counts }),
    token,
    source,
    command,
    phase: "dispatching" as const,
    receipt: null,
    membershipProof: null,
    blockedReason: null,
  });
}

export function attachNativeConstructionQueueDeployMembershipProof(
  pending: NativeConstructionQueueDeployPendingCommand,
  proof: NativeConstructionQueueMembershipProof,
): NativeConstructionQueueDeployPendingCommand {
  const value = proof as unknown;
  if (!isRecord(value) || !hasExactKeys(value, [
    "sessionId",
    "runId",
    "revision",
    "registryFingerprint",
    "queueEntryId",
    "present",
  ]) || pending.receipt === null || proof.sessionId !== pending.sessionId ||
      proof.runId !== pending.runId || proof.registryFingerprint !== pending.registryFingerprint ||
      proof.queueEntryId !== pending.queueEntryId || !Number.isSafeInteger(proof.revision) ||
      proof.revision < pending.receipt.revision || typeof proof.present !== "boolean") {
    throw new TypeError("施工部署全局成员证明未绑定同一事务和 revision");
  }
  return Object.freeze({
    ...pending,
    membershipProof: Object.freeze({
      sessionId: proof.sessionId,
      runId: proof.runId,
      revision: proof.revision,
      registryFingerprint: proof.registryFingerprint,
      queueEntryId: proof.queueEntryId,
      present: proof.present,
    }),
  });
}

export function clearNativeConstructionQueueDeployMembershipProof(
  pending: NativeConstructionQueueDeployPendingCommand,
): NativeConstructionQueueDeployPendingCommand {
  if (pending.phase !== "awaiting-projection" || pending.receipt === null ||
      pending.membershipProof === null) {
    throw new TypeError("只能退役等待投影阶段的旧施工部署成员证明");
  }
  return Object.freeze({ ...pending, membershipProof: null });
}

export function updateNativeConstructionQueueDeployPendingCommand(
  pending: NativeConstructionQueueDeployPendingCommand,
  phase: NativeConstructionQueueDeployPendingPhase,
  options: Readonly<{
    receipt?: NativeConstructionQueueDeployCommitReceipt;
    blockedReason?: NativeConstructionQueueDeployBlockedReason;
  }> = {},
): NativeConstructionQueueDeployPendingCommand {
  const receipt = options.receipt === undefined ? pending.receipt : pinReceipt(pending, options.receipt);
  const blockedReason = phase === "blocked" ? options.blockedReason ?? pending.blockedReason : null;
  if (phase === "awaiting-projection" && receipt === null) {
    throw new TypeError("等待原生施工部署投影前必须持有精确提交回执");
  }
  if (phase === "blocked" && blockedReason === null) {
    throw new TypeError("锁定原生施工部署事务必须给出原因");
  }
  return Object.freeze({ ...pending, phase, receipt, blockedReason });
}

export async function reconcileNativeConstructionQueueDeployPendingCommand(input: Readonly<{
  pending: NativeConstructionQueueDeployPendingCommand;
  isCurrent: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<NativeConstructionQueueDeployReconciliationResult> {
  let observedPending = false;
  let observedUnavailable = false;
  for (const delay of NATIVE_CONSTRUCTION_QUEUE_DEPLOY_RECONCILIATION_DELAYS_MS) {
    if (!input.isCurrent()) return Object.freeze({ status: "cancelled" as const });
    if (delay > 0) await input.wait(delay);
    if (!input.isCurrent()) return Object.freeze({ status: "cancelled" as const });
    let outcome;
    try {
      outcome = await input.pending.source.reconcileCommand(input.pending.command);
    } catch {
      return Object.freeze({ status: "blocked" as const, reason: "receipt-invalid" as const });
    }
    if (!input.isCurrent()) return Object.freeze({ status: "cancelled" as const });
    if (outcome.status === "committed") {
      try {
        return Object.freeze({
          status: "committed" as const,
          receipt: pinReceipt(input.pending, outcome.receipt),
        });
      } catch {
        return Object.freeze({ status: "blocked" as const, reason: "receipt-invalid" as const });
      }
    }
    if (outcome.status === "not-committed") {
      return Object.freeze({ status: "not-committed" as const });
    }
    if (outcome.status === "conflict") {
      return Object.freeze({ status: "blocked" as const, reason: "conflict" as const });
    }
    if (outcome.status === "pending") observedPending = true;
    if (outcome.status === "unavailable") observedUnavailable = true;
  }
  return Object.freeze({
    status: "blocked" as const,
    reason: observedPending
      ? "pending-timeout" as const
      : observedUnavailable
        ? "reconciliation-unavailable" as const
        : "receipt-invalid" as const,
  });
}

export function evaluateNativeConstructionQueueDeployPendingProjection(
  pending: NativeConstructionQueueDeployPendingCommand,
  authority: NativeConstructionQueueDeployAuthorityObservation | null,
): NativeConstructionQueueDeployProjectionResult {
  if (!authority) return Object.freeze({ status: "waiting" as const });
  if (authority.sessionId !== pending.sessionId || authority.runId !== pending.runId) {
    return Object.freeze({ status: "lineage-changed" as const });
  }
  if (pending.receipt === null || authority.revision < pending.receipt.revision) {
    return Object.freeze({ status: "waiting" as const });
  }
  if (pending.membershipProof === null) return Object.freeze({ status: "waiting" as const });
  if (pending.membershipProof.sessionId !== pending.sessionId ||
      pending.membershipProof.runId !== pending.runId ||
      pending.membershipProof.registryFingerprint !== pending.registryFingerprint ||
      pending.membershipProof.queueEntryId !== pending.queueEntryId) {
    return Object.freeze({ status: "blocked" as const, reason: "receipt-projection-mismatch" as const });
  }
  if (pending.membershipProof.revision !== authority.revision) {
    return pending.membershipProof.revision < authority.revision
      ? Object.freeze({ status: "stale-proof" as const })
      : Object.freeze({ status: "blocked" as const, reason: "receipt-projection-mismatch" as const });
  }
  if (pending.membershipProof.present) {
    return Object.freeze({ status: "blocked" as const, reason: "receipt-projection-mismatch" as const });
  }
  return Object.freeze({ status: "confirmed" as const });
}

export function asNativeConstructionQueueDeployCommitReceipt(
  pending: NativeConstructionQueueDeployPendingCommand,
  receipt: NativePlayerAuthorityCommandReceipt,
): NativeConstructionQueueDeployCommitReceipt {
  return pinReceipt(pending, {
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: receipt.changedEntityIds,
    changedBeltIds: receipt.changedBeltIds,
    topologyDirty: receipt.topologyDirty,
  });
}
