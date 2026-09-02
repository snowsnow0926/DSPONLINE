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
  NativeConstructionQueueFundBinding,
  NativeConstructionQueueFundScope,
} from "./nativeBlueprintWorkspaceStore";

export const NATIVE_CONSTRUCTION_QUEUE_FUND_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

export type NativeConstructionQueueFundPendingPhase =
  | "dispatching"
  | "reconciling"
  | "awaiting-projection"
  | "blocked";

export interface NativeConstructionQueueFundCommitReceipt {
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

export type NativeConstructionQueueFundBlockedReason =
  | "conflict"
  | "receipt-invalid"
  | "pending-timeout"
  | "reconciliation-unavailable"
  | "receipt-projection-mismatch";

export interface NativeConstructionQueueFundPendingCommand
  extends NativeConstructionQueueFundBinding {
  readonly token: number;
  readonly scope: NativeConstructionQueueFundScope;
  readonly source: NativePlayerAuthorityCommandSource;
  readonly command: SimulationCommandPatch;
  readonly phase: NativeConstructionQueueFundPendingPhase;
  readonly receipt: NativeConstructionQueueFundCommitReceipt | null;
  readonly blockedReason: NativeConstructionQueueFundBlockedReason | null;
}

export type NativeConstructionQueueFundReconciliationResult = Readonly<
  | { status: "committed"; receipt: NativeConstructionQueueFundCommitReceipt }
  | { status: "not-committed" }
  | { status: "cancelled" }
  | { status: "blocked"; reason: NativeConstructionQueueFundBlockedReason }
>;

export type NativeConstructionQueueFundProjectionResult = Readonly<
  | { status: "waiting" }
  | { status: "confirmed" }
  | { status: "lineage-changed" }
  | { status: "blocked"; reason: "receipt-projection-mismatch" }
>;

export interface NativeConstructionQueueFundAuthorityObservation {
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

function validScope(value: unknown): value is NativeConstructionQueueFundScope {
  return value === "construction" || value === "fleet" || value === "all";
}

function pinExactFundCommand(
  command: SimulationCommandPatch,
  binding: NativeConstructionQueueFundBinding,
  scope: NativeConstructionQueueFundScope,
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
      value.baseRevision !== binding.revision || !validScope(scope) ||
      !Array.isArray(value.topLevelChanges) || value.topLevelChanges.length !== 1 ||
      !isEmptyArray(value.changedEntities) || !isEmptyArray(value.addedEntities) ||
      !isEmptyArray(value.removedEntityIds) || !isEmptyArray(value.changedBelts) ||
      !isEmptyArray(value.addedBelts) || !isEmptyArray(value.removedBeltIds)) {
    throw new TypeError("原生施工队列领料命令不是精确的单意图补丁");
  }
  const marker = value.topLevelChanges[0];
  if (!isRecord(marker) || !hasExactKeys(marker, ["path", "operation", "value"]) ||
      !Array.isArray(marker.path) || marker.path.length !== 2 ||
      marker.path[0] !== "constructionQueue" || marker.path[1] !== "intent" ||
      marker.operation !== "set" || !isRecord(marker.value) ||
      !hasExactKeys(marker.value, ["kind", "id", "scope", "revision"]) ||
      marker.value.kind !== "fund" || marker.value.id !== binding.queueEntryId ||
      marker.value.scope !== scope || marker.value.revision !== binding.revision) {
    throw new TypeError("原生施工队列领料命令标记与可见行绑定不一致");
  }

  const pinnedValue = Object.freeze({
    kind: "fund" as const,
    id: binding.queueEntryId,
    scope,
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
  pending: NativeConstructionQueueFundPendingCommand,
  receipt: NativeConstructionQueueFundCommitReceipt,
): NativeConstructionQueueFundCommitReceipt {
  if (receipt.previousRevision !== pending.revision ||
      receipt.revision !== pending.revision + 1 ||
      receipt.changedEntityIds.length !== 0 || receipt.changedBeltIds.length !== 0 ||
      receipt.topologyDirty !== true) {
    throw new TypeError("原生施工队列领料回执与原命令不一致");
  }
  return Object.freeze({
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: Object.freeze([]),
    changedBeltIds: Object.freeze([]),
    topologyDirty: true,
  });
}

export function createNativeConstructionQueueFundPendingCommand(input: Readonly<{
  token: number;
  scope: NativeConstructionQueueFundScope;
  source: NativePlayerAuthorityCommandSource;
  command: SimulationCommandPatch;
  binding: NativeConstructionQueueFundBinding;
}>): NativeConstructionQueueFundPendingCommand {
  const { token, source, binding, scope } = input;
  if (!Number.isSafeInteger(token) || token <= 0 || !validScope(scope) ||
      source.sessionId !== binding.sessionId || source.runId !== binding.runId ||
      source.baseRevision !== binding.revision ||
      !Number.isSafeInteger(binding.queueTotalCount) || binding.queueTotalCount < 1 ||
      !Number.isSafeInteger(binding.queuePageCursor) || binding.queuePageCursor < 0 ||
      binding.initialStatus !== "pending-materials" ||
      !Number.isSafeInteger(binding.initialReservedConstructionTotal) ||
      binding.initialReservedConstructionTotal < 0 ||
      !Number.isSafeInteger(binding.initialReservedFleetTotal) ||
      binding.initialReservedFleetTotal < 0) {
    throw new TypeError("原生施工队列领料命令 source 与投影 lineage 不一致");
  }
  const command = pinExactFundCommand(input.command, binding, scope);
  return Object.freeze({
    ...binding,
    token,
    scope,
    source,
    command,
    phase: "dispatching" as const,
    receipt: null,
    blockedReason: null,
  });
}

export function updateNativeConstructionQueueFundPendingCommand(
  pending: NativeConstructionQueueFundPendingCommand,
  phase: NativeConstructionQueueFundPendingPhase,
  options: Readonly<{
    receipt?: NativeConstructionQueueFundCommitReceipt;
    blockedReason?: NativeConstructionQueueFundBlockedReason;
  }> = {},
): NativeConstructionQueueFundPendingCommand {
  const receipt = options.receipt === undefined ? pending.receipt : pinReceipt(pending, options.receipt);
  const blockedReason = phase === "blocked" ? options.blockedReason ?? pending.blockedReason : null;
  if (phase === "awaiting-projection" && receipt === null) {
    throw new TypeError("等待原生施工队列领料投影前必须持有精确提交回执");
  }
  if (phase === "blocked" && blockedReason === null) {
    throw new TypeError("锁定原生施工队列领料事务必须给出原因");
  }
  return Object.freeze({ ...pending, phase, receipt, blockedReason });
}

export async function reconcileNativeConstructionQueueFundPendingCommand(input: Readonly<{
  pending: NativeConstructionQueueFundPendingCommand;
  isCurrent: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<NativeConstructionQueueFundReconciliationResult> {
  let observedPending = false;
  let observedUnavailable = false;
  for (const delay of NATIVE_CONSTRUCTION_QUEUE_FUND_RECONCILIATION_DELAYS_MS) {
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

export function evaluateNativeConstructionQueueFundPendingProjection(
  pending: NativeConstructionQueueFundPendingCommand,
  authority: NativeConstructionQueueFundAuthorityObservation | null,
  frame: NativeBlueprintWorkspaceFrame | null,
): NativeConstructionQueueFundProjectionResult {
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
      frame.queuePage.totalCount !== pending.queueTotalCount ||
      frame.queuePage.cursor !== pending.queuePageCursor) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  const row = frame.queue.find((candidate) => candidate.id === pending.queueEntryId);
  if (!row || row.semanticStatus !== "catalog-backed" || row.status !== "pending-materials" ||
      row.reservedConstructionTotal === pending.initialReservedConstructionTotal &&
      row.reservedFleetTotal === pending.initialReservedFleetTotal) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  return Object.freeze({ status: "confirmed" as const });
}

export function asNativeConstructionQueueFundCommitReceipt(
  pending: NativeConstructionQueueFundPendingCommand,
  receipt: NativePlayerAuthorityCommandReceipt,
): NativeConstructionQueueFundCommitReceipt {
  return pinReceipt(pending, receipt);
}
