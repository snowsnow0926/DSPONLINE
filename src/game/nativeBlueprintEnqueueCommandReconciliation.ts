import {
  nativeBlueprintEnqueueContextSupportsCommand,
  type NativeBlueprintEnqueueContext,
} from "./nativeBlueprintEnqueueContext";
import type { NativeBlueprintEnqueuePosition } from "./nativeBlueprintEnqueueIntentCommands";
import type {
  NativePlayerAuthorityCommandReceipt,
  NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type {
  NativeConstructionQueueMembershipProof,
} from "./nativeBlueprintWorkspaceStore";

export const NATIVE_BLUEPRINT_ENQUEUE_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

export type NativeBlueprintEnqueuePendingPhase =
  | "dispatching"
  | "reconciling"
  | "awaiting-projection"
  | "blocked";

export interface NativeBlueprintEnqueueCommitReceipt {
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

export type NativeBlueprintEnqueueBlockedReason =
  | "conflict"
  | "receipt-invalid"
  | "pending-timeout"
  | "reconciliation-unavailable"
  | "receipt-projection-mismatch";

export interface NativeBlueprintEnqueuePendingCommand {
  readonly token: number;
  readonly source: NativePlayerAuthorityCommandSource;
  readonly command: SimulationCommandPatch;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly blueprintId: string;
  readonly blueprintRevision: number;
  readonly activePlanetId: string;
  readonly expectedQueueId: string;
  readonly position: Readonly<NativeBlueprintEnqueuePosition>;
  readonly phase: NativeBlueprintEnqueuePendingPhase;
  readonly receipt: NativeBlueprintEnqueueCommitReceipt | null;
  readonly membershipProof: NativeConstructionQueueMembershipProof | null;
  readonly blockedReason: NativeBlueprintEnqueueBlockedReason | null;
}

export type NativeBlueprintEnqueueReconciliationResult = Readonly<
  | { status: "committed"; receipt: NativeBlueprintEnqueueCommitReceipt }
  | { status: "not-committed" }
  | { status: "cancelled" }
  | { status: "blocked"; reason: NativeBlueprintEnqueueBlockedReason }
>;

export type NativeBlueprintEnqueueProjectionResult = Readonly<
  | { status: "waiting" }
  | { status: "confirmed" }
  | { status: "stale-proof" }
  | { status: "lineage-changed" }
  | { status: "blocked"; reason: "receipt-projection-mismatch" }
>;

export interface NativeBlueprintEnqueueAuthorityObservation {
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

function validPosition(value: unknown): value is NativeBlueprintEnqueuePosition {
  return isRecord(value) && hasExactKeys(value, ["x", "y"]) &&
    Number.isFinite(value.x) && Number.isFinite(value.y);
}

function pinExactEnqueueCommand(
  command: SimulationCommandPatch,
  context: NativeBlueprintEnqueueContext,
  position: NativeBlueprintEnqueuePosition,
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
      value.baseRevision !== context.revision || !Array.isArray(value.topLevelChanges) ||
      value.topLevelChanges.length !== 1 ||
      !isEmptyArray(value.changedEntities) || !isEmptyArray(value.addedEntities) ||
      !isEmptyArray(value.removedEntityIds) || !isEmptyArray(value.changedBelts) ||
      !isEmptyArray(value.addedBelts) || !isEmptyArray(value.removedBeltIds)) {
    throw new TypeError("原生蓝图入队命令不是精确的单意图补丁");
  }
  const marker = value.topLevelChanges[0];
  if (!isRecord(marker) || !hasExactKeys(marker, ["path", "operation", "value"]) ||
      !Array.isArray(marker.path) || marker.path.length !== 2 ||
      marker.path[0] !== "constructionQueue" || marker.path[1] !== "intent" ||
      marker.operation !== "set" || !isRecord(marker.value) ||
      !hasExactKeys(marker.value, [
        "kind",
        "blueprintId",
        "blueprintRevision",
        "position",
        "revision",
      ]) || marker.value.kind !== "enqueue" ||
      marker.value.blueprintId !== context.request.blueprintId ||
      marker.value.blueprintRevision !== context.request.blueprintRevision ||
      marker.value.revision !== context.revision || !validPosition(marker.value.position) ||
      marker.value.position.x !== position.x || marker.value.position.y !== position.y) {
    throw new TypeError("原生蓝图入队命令标记与 Rust 上下文不一致");
  }

  const pinnedPosition = Object.freeze({ x: position.x, y: position.y });
  const pinnedValue = Object.freeze({
    kind: "enqueue" as const,
    blueprintId: context.request.blueprintId,
    blueprintRevision: context.request.blueprintRevision,
    position: pinnedPosition,
    revision: context.revision,
  });
  const pinnedMarker = Object.freeze({
    path: Object.freeze(["constructionQueue", "intent"]),
    operation: "set" as const,
    value: pinnedValue,
  });
  return Object.freeze({
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
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
  pending: NativeBlueprintEnqueuePendingCommand,
  receipt: NativeBlueprintEnqueueCommitReceipt,
): NativeBlueprintEnqueueCommitReceipt {
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
    throw new TypeError("原生蓝图入队回执与原命令不一致");
  }
  return Object.freeze({
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: Object.freeze([]),
    changedBeltIds: Object.freeze([]),
    topologyDirty: true,
  });
}

export function createNativeBlueprintEnqueuePendingCommand(input: Readonly<{
  token: number;
  source: NativePlayerAuthorityCommandSource;
  command: SimulationCommandPatch;
  context: NativeBlueprintEnqueueContext;
  position: NativeBlueprintEnqueuePosition;
}>): NativeBlueprintEnqueuePendingCommand {
  const { token, source, context, position } = input;
  if (!Number.isSafeInteger(token) || token <= 0 ||
      !nativeBlueprintEnqueueContextSupportsCommand(context) ||
      source.sessionId !== context.sessionId || source.runId !== context.runId ||
      source.baseRevision !== context.revision || !validPosition(position) ||
      context.expectedQueueId === null) {
    throw new TypeError("原生蓝图入队命令 source、上下文或坐标不一致");
  }
  const command = pinExactEnqueueCommand(input.command, context, position);
  return Object.freeze({
    token,
    source,
    command,
    sessionId: context.sessionId,
    runId: context.runId,
    revision: context.revision,
    registryFingerprint: context.registryFingerprint,
    blueprintId: context.request.blueprintId,
    blueprintRevision: context.request.blueprintRevision,
    activePlanetId: context.activePlanetId,
    expectedQueueId: context.expectedQueueId,
    position: Object.freeze({ x: position.x, y: position.y }),
    phase: "dispatching" as const,
    receipt: null,
    membershipProof: null,
    blockedReason: null,
  });
}

export function attachNativeBlueprintEnqueueMembershipProof(
  pending: NativeBlueprintEnqueuePendingCommand,
  proof: NativeConstructionQueueMembershipProof,
): NativeBlueprintEnqueuePendingCommand {
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
      proof.queueEntryId !== pending.expectedQueueId || !Number.isSafeInteger(proof.revision) ||
      proof.revision < pending.receipt.revision || typeof proof.present !== "boolean") {
    throw new TypeError("蓝图入队全局成员证明未绑定同一事务和 revision");
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

export function clearNativeBlueprintEnqueueMembershipProof(
  pending: NativeBlueprintEnqueuePendingCommand,
): NativeBlueprintEnqueuePendingCommand {
  if (pending.phase !== "awaiting-projection" || pending.receipt === null ||
      pending.membershipProof === null) {
    throw new TypeError("只能退役等待投影阶段的旧蓝图入队成员证明");
  }
  return Object.freeze({
    ...pending,
    membershipProof: null,
  });
}

export function updateNativeBlueprintEnqueuePendingCommand(
  pending: NativeBlueprintEnqueuePendingCommand,
  phase: NativeBlueprintEnqueuePendingPhase,
  options: Readonly<{
    receipt?: NativeBlueprintEnqueueCommitReceipt;
    blockedReason?: NativeBlueprintEnqueueBlockedReason;
  }> = {},
): NativeBlueprintEnqueuePendingCommand {
  const receipt = options.receipt === undefined ? pending.receipt : pinReceipt(pending, options.receipt);
  const blockedReason = phase === "blocked" ? options.blockedReason ?? pending.blockedReason : null;
  if (phase === "awaiting-projection" && receipt === null) {
    throw new TypeError("等待原生蓝图入队投影前必须持有精确提交回执");
  }
  if (phase === "blocked" && blockedReason === null) {
    throw new TypeError("锁定原生蓝图入队事务必须给出原因");
  }
  return Object.freeze({ ...pending, phase, receipt, blockedReason });
}

export async function reconcileNativeBlueprintEnqueuePendingCommand(input: Readonly<{
  pending: NativeBlueprintEnqueuePendingCommand;
  isCurrent: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<NativeBlueprintEnqueueReconciliationResult> {
  let observedPending = false;
  let observedUnavailable = false;
  for (const delay of NATIVE_BLUEPRINT_ENQUEUE_RECONCILIATION_DELAYS_MS) {
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

export function evaluateNativeBlueprintEnqueuePendingProjection(
  pending: NativeBlueprintEnqueuePendingCommand,
  authority: NativeBlueprintEnqueueAuthorityObservation | null,
): NativeBlueprintEnqueueProjectionResult {
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
      pending.membershipProof.queueEntryId !== pending.expectedQueueId) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  if (pending.membershipProof.revision !== authority.revision) {
    if (pending.membershipProof.revision < authority.revision) {
      return Object.freeze({ status: "stale-proof" as const });
    }
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  if (!pending.membershipProof.present) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  return Object.freeze({ status: "confirmed" as const });
}

export function asNativeBlueprintEnqueueCommitReceipt(
  pending: NativeBlueprintEnqueuePendingCommand,
  receipt: NativePlayerAuthorityCommandReceipt,
): NativeBlueprintEnqueueCommitReceipt {
  return pinReceipt(pending, {
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: receipt.changedEntityIds,
    changedBeltIds: receipt.changedBeltIds,
    topologyDirty: receipt.topologyDirty,
  });
}
