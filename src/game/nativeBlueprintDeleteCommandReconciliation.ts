import type {
  NativePlayerAuthorityCommandReceipt,
  NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type {
  NativeBlueprintDeleteBinding,
  NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";

export const NATIVE_BLUEPRINT_DELETE_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

export type NativeBlueprintDeletePendingPhase =
  | "dispatching"
  | "reconciling"
  | "awaiting-projection"
  | "blocked";

export interface NativeBlueprintDeleteCommitReceipt {
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

export type NativeBlueprintDeleteBlockedReason =
  | "conflict"
  | "receipt-invalid"
  | "pending-timeout"
  | "reconciliation-unavailable"
  | "receipt-projection-mismatch";

export interface NativeBlueprintDeletePendingCommand extends NativeBlueprintDeleteBinding {
  readonly token: number;
  readonly source: NativePlayerAuthorityCommandSource;
  readonly command: SimulationCommandPatch;
  readonly phase: NativeBlueprintDeletePendingPhase;
  readonly receipt: NativeBlueprintDeleteCommitReceipt | null;
  readonly blockedReason: NativeBlueprintDeleteBlockedReason | null;
}

export type NativeBlueprintDeleteReconciliationResult = Readonly<
  | { status: "committed"; receipt: NativeBlueprintDeleteCommitReceipt }
  | { status: "not-committed" }
  | { status: "cancelled" }
  | { status: "blocked"; reason: NativeBlueprintDeleteBlockedReason }
>;

export type NativeBlueprintDeleteProjectionResult = Readonly<
  | { status: "waiting" }
  | { status: "confirmed" }
  | { status: "lineage-changed" }
  | { status: "blocked"; reason: "receipt-projection-mismatch" }
>;

export interface NativeBlueprintDeleteAuthorityObservation {
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

function pinExactDeleteCommand(
  command: SimulationCommandPatch,
  binding: NativeBlueprintDeleteBinding,
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
    throw new TypeError("原生蓝图删除命令不是精确的单意图补丁");
  }
  const marker = value.topLevelChanges[0];
  if (!isRecord(marker) || !hasExactKeys(marker, ["path", "operation", "value"]) ||
      !Array.isArray(marker.path) || marker.path.length !== 2 ||
      marker.path[0] !== "blueprints" || marker.path[1] !== "intent" ||
      marker.operation !== "set" || !isRecord(marker.value) ||
      !hasExactKeys(marker.value, ["kind", "id", "revision"]) ||
      marker.value.kind !== "delete" || marker.value.id !== binding.blueprintId ||
      marker.value.revision !== binding.currentRowRevision) {
    throw new TypeError("原生蓝图删除命令标记与选中行绑定不一致");
  }

  const pinnedValue = Object.freeze({
    kind: "delete" as const,
    id: binding.blueprintId,
    revision: binding.currentRowRevision,
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
  pending: NativeBlueprintDeletePendingCommand,
  receipt: NativeBlueprintDeleteCommitReceipt,
): NativeBlueprintDeleteCommitReceipt {
  if (receipt.previousRevision !== pending.revision ||
      receipt.revision !== pending.revision + 1 ||
      receipt.changedEntityIds.length !== 0 || receipt.changedBeltIds.length !== 0 ||
      receipt.topologyDirty !== true) {
    throw new TypeError("原生蓝图删除回执与原命令不一致");
  }
  return Object.freeze({
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: Object.freeze([]),
    changedBeltIds: Object.freeze([]),
    topologyDirty: true,
  });
}

export function createNativeBlueprintDeletePendingCommand(input: Readonly<{
  token: number;
  source: NativePlayerAuthorityCommandSource;
  command: SimulationCommandPatch;
  binding: NativeBlueprintDeleteBinding;
}>): NativeBlueprintDeletePendingCommand {
  const { token, source, binding } = input;
  if (!Number.isSafeInteger(token) || token <= 0 ||
      source.sessionId !== binding.sessionId || source.runId !== binding.runId ||
      source.baseRevision !== binding.revision ||
      !Number.isSafeInteger(binding.currentRowRevision) || binding.currentRowRevision < 1 ||
      binding.currentRowRevision > Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(binding.libraryTotalCount) || binding.libraryTotalCount < 1) {
    throw new TypeError("原生蓝图删除命令 source 与投影 lineage 不一致");
  }
  const command = pinExactDeleteCommand(input.command, binding);
  return Object.freeze({
    ...binding,
    token,
    source,
    command,
    phase: "dispatching" as const,
    receipt: null,
    blockedReason: null,
  });
}

export function updateNativeBlueprintDeletePendingCommand(
  pending: NativeBlueprintDeletePendingCommand,
  phase: NativeBlueprintDeletePendingPhase,
  options: Readonly<{
    receipt?: NativeBlueprintDeleteCommitReceipt;
    blockedReason?: NativeBlueprintDeleteBlockedReason;
  }> = {},
): NativeBlueprintDeletePendingCommand {
  const receipt = options.receipt === undefined ? pending.receipt : pinReceipt(pending, options.receipt);
  const blockedReason = phase === "blocked" ? options.blockedReason ?? pending.blockedReason : null;
  if (phase === "awaiting-projection" && receipt === null) {
    throw new TypeError("等待原生蓝图删除投影前必须持有精确提交回执");
  }
  if (phase === "blocked" && blockedReason === null) {
    throw new TypeError("锁定原生蓝图删除事务必须给出原因");
  }
  return Object.freeze({ ...pending, phase, receipt, blockedReason });
}

export async function reconcileNativeBlueprintDeletePendingCommand(input: Readonly<{
  pending: NativeBlueprintDeletePendingCommand;
  isCurrent: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<NativeBlueprintDeleteReconciliationResult> {
  let observedPending = false;
  let observedUnavailable = false;
  for (const delay of NATIVE_BLUEPRINT_DELETE_RECONCILIATION_DELAYS_MS) {
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

export function evaluateNativeBlueprintDeletePendingProjection(
  pending: NativeBlueprintDeletePendingCommand,
  authority: NativeBlueprintDeleteAuthorityObservation | null,
  frame: NativeBlueprintWorkspaceFrame | null,
): NativeBlueprintDeleteProjectionResult {
  if (!authority) return Object.freeze({ status: "waiting" as const });
  if (authority.sessionId !== pending.sessionId || authority.runId !== pending.runId) {
    return Object.freeze({ status: "lineage-changed" as const });
  }
  if (pending.receipt === null || authority.revision < pending.receipt.revision || !frame ||
      frame.sessionId !== pending.sessionId || frame.runId !== pending.runId ||
      frame.revision < pending.receipt.revision || frame.revision !== authority.revision) {
    return Object.freeze({ status: "waiting" as const });
  }
  if (frame.registryFingerprint !== pending.registryFingerprint ||
      frame.libraryPage.totalCount !== pending.libraryTotalCount - 1 ||
      frame.selectedBlueprintId !== null || frame.libraryById.has(pending.blueprintId)) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  return Object.freeze({ status: "confirmed" as const });
}

export function asNativeBlueprintDeleteCommitReceipt(
  pending: NativeBlueprintDeletePendingCommand,
  receipt: NativePlayerAuthorityCommandReceipt,
): NativeBlueprintDeleteCommitReceipt {
  return pinReceipt(pending, receipt);
}
