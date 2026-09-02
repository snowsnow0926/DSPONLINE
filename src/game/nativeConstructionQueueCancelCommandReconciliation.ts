import type {
  NativePlayerAuthorityCommandReceipt,
  NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeConstructionQueueMembershipProof,
  NativeConstructionQueueCancelBinding,
} from "./nativeBlueprintWorkspaceStore";

export const NATIVE_CONSTRUCTION_QUEUE_CANCEL_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

export type NativeConstructionQueueCancelPendingPhase =
  | "dispatching"
  | "reconciling"
  | "awaiting-projection"
  | "blocked";

export interface NativeConstructionQueueCancelCommitReceipt {
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

export type NativeConstructionQueueCancelBlockedReason =
  | "conflict"
  | "receipt-invalid"
  | "pending-timeout"
  | "reconciliation-unavailable"
  | "receipt-projection-mismatch";

export interface NativeConstructionQueueCancelPendingCommand
  extends NativeConstructionQueueCancelBinding {
  readonly token: number;
  readonly source: NativePlayerAuthorityCommandSource;
  readonly command: SimulationCommandPatch;
  readonly phase: NativeConstructionQueueCancelPendingPhase;
  readonly receipt: NativeConstructionQueueCancelCommitReceipt | null;
  readonly membershipProof: NativeConstructionQueueMembershipProof | null;
  readonly blockedReason: NativeConstructionQueueCancelBlockedReason | null;
}

export type NativeConstructionQueueCancelReconciliationResult = Readonly<
  | { status: "committed"; receipt: NativeConstructionQueueCancelCommitReceipt }
  | { status: "not-committed" }
  | { status: "cancelled" }
  | { status: "blocked"; reason: NativeConstructionQueueCancelBlockedReason }
>;

export type NativeConstructionQueueCancelProjectionResult = Readonly<
  | { status: "waiting" }
  | { status: "confirmed" }
  | { status: "lineage-changed" }
  | { status: "blocked"; reason: "receipt-projection-mismatch" }
>;

export interface NativeConstructionQueueCancelAuthorityObservation {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index]);
}

function isEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}

function pinExactCancelCommand(
  command: SimulationCommandPatch,
  binding: NativeConstructionQueueCancelBinding,
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
    throw new TypeError("原生施工队列取消命令不是精确的单意图补丁");
  }
  const marker = value.topLevelChanges[0];
  if (!isRecord(marker) || !hasExactKeys(marker, ["path", "operation", "value"]) ||
      !Array.isArray(marker.path) || marker.path.length !== 2 ||
      marker.path[0] !== "constructionQueue" || marker.path[1] !== "intent" ||
      marker.operation !== "set" || !isRecord(marker.value) ||
      !hasExactKeys(marker.value, ["kind", "id", "revision"]) ||
      marker.value.kind !== "cancel" || marker.value.id !== binding.queueEntryId ||
      marker.value.revision !== binding.revision) {
    throw new TypeError("原生施工队列取消命令标记与可见行绑定不一致");
  }

  const pinnedValue = Object.freeze({
    kind: "cancel" as const,
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
  pending: NativeConstructionQueueCancelPendingCommand,
  receipt: NativeConstructionQueueCancelCommitReceipt,
): NativeConstructionQueueCancelCommitReceipt {
  if (receipt.previousRevision !== pending.revision ||
      receipt.revision !== pending.revision + 1 ||
      receipt.changedEntityIds.length !== 0 || receipt.changedBeltIds.length !== 0 ||
      receipt.topologyDirty !== true) {
    throw new TypeError("原生施工队列取消回执与原命令不一致");
  }
  return Object.freeze({
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: Object.freeze([]),
    changedBeltIds: Object.freeze([]),
    topologyDirty: true,
  });
}

export function createNativeConstructionQueueCancelPendingCommand(input: Readonly<{
  token: number;
  source: NativePlayerAuthorityCommandSource;
  command: SimulationCommandPatch;
  binding: NativeConstructionQueueCancelBinding;
}>): NativeConstructionQueueCancelPendingCommand {
  const { token, source, binding } = input;
  if (!Number.isSafeInteger(token) || token <= 0 ||
      source.sessionId !== binding.sessionId || source.runId !== binding.runId ||
      source.baseRevision !== binding.revision ||
      !Number.isSafeInteger(binding.queueTotalCount) || binding.queueTotalCount < 1) {
    throw new TypeError("原生施工队列取消命令 source 与投影 lineage 不一致");
  }
  const command = pinExactCancelCommand(input.command, binding);
  return Object.freeze({
    ...binding,
    token,
    source,
    command,
    phase: "dispatching" as const,
    receipt: null,
    membershipProof: null,
    blockedReason: null,
  });
}

export function attachNativeConstructionQueueCancelMembershipProof(
  pending: NativeConstructionQueueCancelPendingCommand,
  proof: NativeConstructionQueueMembershipProof,
): NativeConstructionQueueCancelPendingCommand {
  if (pending.receipt === null || proof.sessionId !== pending.sessionId ||
      proof.runId !== pending.runId || proof.registryFingerprint !== pending.registryFingerprint ||
      proof.queueEntryId !== pending.queueEntryId || !Number.isSafeInteger(proof.revision) ||
      proof.revision < pending.receipt.revision || typeof proof.present !== "boolean") {
    throw new TypeError("施工队列全局成员证明未绑定同一事务和 revision");
  }
  return Object.freeze({
    ...pending,
    membershipProof: Object.freeze({ ...proof }),
  });
}

export function updateNativeConstructionQueueCancelPendingCommand(
  pending: NativeConstructionQueueCancelPendingCommand,
  phase: NativeConstructionQueueCancelPendingPhase,
  options: Readonly<{
    receipt?: NativeConstructionQueueCancelCommitReceipt;
    blockedReason?: NativeConstructionQueueCancelBlockedReason;
  }> = {},
): NativeConstructionQueueCancelPendingCommand {
  const receipt = options.receipt === undefined ? pending.receipt : pinReceipt(pending, options.receipt);
  const blockedReason = phase === "blocked" ? options.blockedReason ?? pending.blockedReason : null;
  if (phase === "awaiting-projection" && receipt === null) {
    throw new TypeError("等待原生施工队列取消投影前必须持有精确提交回执");
  }
  if (phase === "blocked" && blockedReason === null) {
    throw new TypeError("锁定原生施工队列取消事务必须给出原因");
  }
  return Object.freeze({ ...pending, phase, receipt, blockedReason });
}

export async function reconcileNativeConstructionQueueCancelPendingCommand(input: Readonly<{
  pending: NativeConstructionQueueCancelPendingCommand;
  isCurrent: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<NativeConstructionQueueCancelReconciliationResult> {
  let observedPending = false;
  let observedUnavailable = false;
  for (const delay of NATIVE_CONSTRUCTION_QUEUE_CANCEL_RECONCILIATION_DELAYS_MS) {
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

export function evaluateNativeConstructionQueueCancelPendingProjection(
  pending: NativeConstructionQueueCancelPendingCommand,
  authority: NativeConstructionQueueCancelAuthorityObservation | null,
  frame: NativeBlueprintWorkspaceFrame | null,
): NativeConstructionQueueCancelProjectionResult {
  if (!authority) return Object.freeze({ status: "waiting" as const });
  if (authority.sessionId !== pending.sessionId || authority.runId !== pending.runId) {
    return Object.freeze({ status: "lineage-changed" as const });
  }
  if (pending.receipt === null || authority.revision < pending.receipt.revision || !frame ||
      frame.sessionId !== pending.sessionId || frame.runId !== pending.runId ||
      frame.revision < pending.receipt.revision || frame.revision !== authority.revision) {
    return Object.freeze({ status: "waiting" as const });
  }
  if (frame.registryFingerprint !== pending.registryFingerprint) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  if (pending.membershipProof === null) return Object.freeze({ status: "waiting" as const });
  if (
      pending.membershipProof.sessionId !== pending.sessionId ||
      pending.membershipProof.runId !== pending.runId ||
      pending.membershipProof.registryFingerprint !== pending.registryFingerprint ||
      pending.membershipProof.queueEntryId !== pending.queueEntryId ||
      pending.membershipProof.revision !== authority.revision ||
      pending.membershipProof.present) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  return Object.freeze({ status: "confirmed" as const });
}

export function asNativeConstructionQueueCancelCommitReceipt(
  pending: NativeConstructionQueueCancelPendingCommand,
  receipt: NativePlayerAuthorityCommandReceipt,
): NativeConstructionQueueCancelCommitReceipt {
  return pinReceipt(pending, receipt);
}
