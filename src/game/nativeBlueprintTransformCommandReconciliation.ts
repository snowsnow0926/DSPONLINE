import type {
  NativePlayerAuthorityCommandReceipt,
  NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type {
  NativeBlueprintMirror,
  NativeBlueprintRotation,
  NativeBlueprintTransformBinding,
} from "./nativeBlueprintWorkspaceStore";

export const NATIVE_BLUEPRINT_TRANSFORM_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

export type NativeBlueprintTransformPendingPhase =
  | "dispatching"
  | "reconciling"
  | "awaiting-projection"
  | "blocked";

export interface NativeBlueprintTransformCommitReceipt {
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

export type NativeBlueprintTransformBlockedReason =
  | "conflict"
  | "receipt-invalid"
  | "pending-timeout"
  | "reconciliation-unavailable"
  | "receipt-projection-mismatch";

export interface NativeBlueprintTransformPendingCommand extends NativeBlueprintTransformBinding {
  readonly token: number;
  readonly source: NativePlayerAuthorityCommandSource;
  readonly command: SimulationCommandPatch;
  readonly targetRotation: NativeBlueprintRotation;
  readonly targetMirror: NativeBlueprintMirror;
  readonly phase: NativeBlueprintTransformPendingPhase;
  readonly receipt: NativeBlueprintTransformCommitReceipt | null;
  readonly blockedReason: NativeBlueprintTransformBlockedReason | null;
}

export type NativeBlueprintTransformReconciliationResult = Readonly<
  | { status: "committed"; receipt: NativeBlueprintTransformCommitReceipt }
  | { status: "not-committed" }
  | { status: "cancelled" }
  | { status: "blocked"; reason: NativeBlueprintTransformBlockedReason }
>;

export type NativeBlueprintTransformProjectionResult = Readonly<
  | { status: "waiting" }
  | { status: "confirmed" }
  | { status: "lineage-changed" }
  | { status: "blocked"; reason: "receipt-projection-mismatch" }
>;

export interface NativeBlueprintTransformAuthorityObservation {
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
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function isEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}

function pinExactTransformCommand(
  command: SimulationCommandPatch,
  binding: NativeBlueprintTransformBinding,
  targetRotation: NativeBlueprintRotation,
  targetMirror: NativeBlueprintMirror,
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
    throw new TypeError("原生蓝图变换命令不是精确的单意图补丁");
  }
  const marker = value.topLevelChanges[0];
  if (!isRecord(marker) || !hasExactKeys(marker, ["path", "operation", "value"]) ||
      !Array.isArray(marker.path) || marker.path.length !== 2 ||
      marker.path[0] !== "blueprints" || marker.path[1] !== "intent" ||
      marker.operation !== "set" || !isRecord(marker.value) ||
      !hasExactKeys(marker.value, ["kind", "id", "rotation", "mirror"]) ||
      marker.value.kind !== "transform" || marker.value.id !== binding.blueprintId ||
      marker.value.rotation !== targetRotation || marker.value.mirror !== targetMirror) {
    throw new TypeError("原生蓝图变换命令标记与选中行绑定不一致");
  }

  const pinnedValue = Object.freeze({
    kind: "transform" as const,
    id: binding.blueprintId,
    rotation: targetRotation,
    mirror: targetMirror,
  });
  const pinnedMarker = Object.freeze({
    path: Object.freeze(["blueprints", "intent"]),
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
  pending: NativeBlueprintTransformPendingCommand,
  receipt: NativeBlueprintTransformCommitReceipt,
): NativeBlueprintTransformCommitReceipt {
  if (receipt.previousRevision !== pending.revision ||
      receipt.revision !== pending.revision + 1 ||
      receipt.changedEntityIds.length !== 0 || receipt.changedBeltIds.length !== 0 ||
      receipt.topologyDirty !== true) {
    throw new TypeError("原生蓝图变换回执与原命令不一致");
  }
  return Object.freeze({
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: Object.freeze([]),
    changedBeltIds: Object.freeze([]),
    topologyDirty: true,
  });
}

export function createNativeBlueprintTransformPendingCommand(input: Readonly<{
  token: number;
  source: NativePlayerAuthorityCommandSource;
  command: SimulationCommandPatch;
  binding: NativeBlueprintTransformBinding;
  targetRotation: NativeBlueprintRotation;
  targetMirror: NativeBlueprintMirror;
}>): NativeBlueprintTransformPendingCommand {
  const { token, source, binding, targetRotation, targetMirror } = input;
  if (!Number.isSafeInteger(token) || token <= 0 ||
      source.sessionId !== binding.sessionId || source.runId !== binding.runId ||
      source.baseRevision !== binding.revision ||
      targetRotation === binding.currentRotation && targetMirror === binding.currentMirror) {
    throw new TypeError("原生蓝图变换命令 source、目标与投影 lineage 不一致");
  }
  const command = pinExactTransformCommand(input.command, binding, targetRotation, targetMirror);
  return Object.freeze({
    ...binding,
    token,
    source,
    command,
    targetRotation,
    targetMirror,
    phase: "dispatching" as const,
    receipt: null,
    blockedReason: null,
  });
}

export function updateNativeBlueprintTransformPendingCommand(
  pending: NativeBlueprintTransformPendingCommand,
  phase: NativeBlueprintTransformPendingPhase,
  options: Readonly<{
    receipt?: NativeBlueprintTransformCommitReceipt;
    blockedReason?: NativeBlueprintTransformBlockedReason;
  }> = {},
): NativeBlueprintTransformPendingCommand {
  const receipt = options.receipt === undefined ? pending.receipt : pinReceipt(pending, options.receipt);
  const blockedReason = phase === "blocked" ? options.blockedReason ?? pending.blockedReason : null;
  if (phase === "awaiting-projection" && receipt === null) {
    throw new TypeError("等待原生蓝图变换投影前必须持有精确提交回执");
  }
  if (phase === "blocked" && blockedReason === null) {
    throw new TypeError("锁定原生蓝图变换事务必须给出原因");
  }
  return Object.freeze({ ...pending, phase, receipt, blockedReason });
}

export async function reconcileNativeBlueprintTransformPendingCommand(input: Readonly<{
  pending: NativeBlueprintTransformPendingCommand;
  isCurrent: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<NativeBlueprintTransformReconciliationResult> {
  let observedPending = false;
  let observedUnavailable = false;
  for (const delay of NATIVE_BLUEPRINT_TRANSFORM_RECONCILIATION_DELAYS_MS) {
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

export function evaluateNativeBlueprintTransformPendingProjection(
  pending: NativeBlueprintTransformPendingCommand,
  authority: NativeBlueprintTransformAuthorityObservation | null,
  projection: NativeBlueprintTransformBinding | null,
): NativeBlueprintTransformProjectionResult {
  if (!authority) return Object.freeze({ status: "waiting" as const });
  if (authority.sessionId !== pending.sessionId || authority.runId !== pending.runId) {
    return Object.freeze({ status: "lineage-changed" as const });
  }
  if (pending.receipt === null || authority.revision < pending.receipt.revision || !projection ||
      projection.sessionId !== pending.sessionId || projection.runId !== pending.runId ||
      projection.revision < pending.receipt.revision || projection.revision !== authority.revision) {
    return Object.freeze({ status: "waiting" as const });
  }
  if (projection.registryFingerprint !== pending.registryFingerprint ||
      projection.blueprintId !== pending.blueprintId ||
      projection.currentRowRevision !== pending.currentRowRevision + 1 ||
      projection.currentRotation !== pending.targetRotation ||
      projection.currentMirror !== pending.targetMirror) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  return Object.freeze({ status: "confirmed" as const });
}

export function asNativeBlueprintTransformCommitReceipt(
  pending: NativeBlueprintTransformPendingCommand,
  receipt: NativePlayerAuthorityCommandReceipt,
): NativeBlueprintTransformCommitReceipt {
  return pinReceipt(pending, receipt);
}
