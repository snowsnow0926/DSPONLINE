import type {
  NativePlayerAuthorityCommandReceipt,
  NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type {
  NativeBlueprintRecipeOverrideBinding,
} from "./nativeBlueprintWorkspaceStore";

export const NATIVE_BLUEPRINT_RECIPE_OVERRIDE_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

export type NativeBlueprintRecipeOverridePendingPhase =
  | "dispatching"
  | "reconciling"
  | "awaiting-projection"
  | "blocked";

export interface NativeBlueprintRecipeOverrideCommitReceipt {
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

export type NativeBlueprintRecipeOverrideBlockedReason =
  | "conflict"
  | "receipt-invalid"
  | "pending-timeout"
  | "reconciliation-unavailable"
  | "receipt-projection-mismatch";

export interface NativeBlueprintRecipeOverridePendingCommand
  extends NativeBlueprintRecipeOverrideBinding {
  readonly token: number;
  readonly source: NativePlayerAuthorityCommandSource;
  readonly command: SimulationCommandPatch;
  readonly targetRecipeId: string;
  readonly phase: NativeBlueprintRecipeOverridePendingPhase;
  readonly receipt: NativeBlueprintRecipeOverrideCommitReceipt | null;
  readonly blockedReason: NativeBlueprintRecipeOverrideBlockedReason | null;
}

export type NativeBlueprintRecipeOverrideReconciliationResult = Readonly<
  | { status: "committed"; receipt: NativeBlueprintRecipeOverrideCommitReceipt }
  | { status: "not-committed" }
  | { status: "cancelled" }
  | { status: "blocked"; reason: NativeBlueprintRecipeOverrideBlockedReason }
>;

export type NativeBlueprintRecipeOverrideProjectionResult = Readonly<
  | { status: "waiting" }
  | { status: "confirmed" }
  | { status: "lineage-changed" }
  | { status: "blocked"; reason: "receipt-projection-mismatch" }
>;

export interface NativeBlueprintRecipeOverrideAuthorityObservation {
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

function pinExactRecipeOverrideCommand(
  command: SimulationCommandPatch,
  binding: NativeBlueprintRecipeOverrideBinding,
  targetRecipeId: string,
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
    throw new TypeError("原生蓝图配方覆盖命令不是精确的单意图补丁");
  }
  const marker = value.topLevelChanges[0];
  if (!isRecord(marker) || !hasExactKeys(marker, ["path", "operation", "value"]) ||
      !Array.isArray(marker.path) || marker.path.length !== 2 ||
      marker.path[0] !== "blueprints" || marker.path[1] !== "intent" ||
      marker.operation !== "set" || !isRecord(marker.value) ||
      !hasExactKeys(marker.value, [
        "kind",
        "id",
        "sourceRecipeId",
        "targetRecipeId",
      ]) || marker.value.kind !== "recipe-override" ||
      marker.value.id !== binding.blueprintId ||
      marker.value.sourceRecipeId !== binding.sourceRecipeId ||
      marker.value.targetRecipeId !== targetRecipeId) {
    throw new TypeError("原生蓝图配方覆盖命令标记与选中配方组绑定不一致");
  }

  const pinnedValue = Object.freeze({
    kind: "recipe-override" as const,
    id: binding.blueprintId,
    sourceRecipeId: binding.sourceRecipeId,
    targetRecipeId,
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
  pending: NativeBlueprintRecipeOverridePendingCommand,
  receipt: NativeBlueprintRecipeOverrideCommitReceipt,
): NativeBlueprintRecipeOverrideCommitReceipt {
  if (!Array.isArray(receipt.changedEntityIds) || !Array.isArray(receipt.changedBeltIds) ||
      receipt.previousRevision !== pending.revision ||
      receipt.revision !== pending.revision + 1 ||
      receipt.changedEntityIds.length !== 0 || receipt.changedBeltIds.length !== 0 ||
      receipt.topologyDirty !== true) {
    throw new TypeError("原生蓝图配方覆盖回执与原命令不一致");
  }
  return Object.freeze({
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: Object.freeze([]),
    changedBeltIds: Object.freeze([]),
    topologyDirty: true,
  });
}

export function createNativeBlueprintRecipeOverridePendingCommand(input: Readonly<{
  token: number;
  source: NativePlayerAuthorityCommandSource;
  command: SimulationCommandPatch;
  binding: NativeBlueprintRecipeOverrideBinding;
  targetRecipeId: string;
}>): NativeBlueprintRecipeOverridePendingCommand {
  const { token, source, binding, targetRecipeId } = input;
  if (!Number.isSafeInteger(token) || token <= 0 ||
      source.sessionId !== binding.sessionId || source.runId !== binding.runId ||
      source.baseRevision !== binding.revision ||
      targetRecipeId === binding.currentTargetRecipeId) {
    throw new TypeError("原生蓝图配方覆盖命令 source、目标与投影 lineage 不一致");
  }
  const command = pinExactRecipeOverrideCommand(input.command, binding, targetRecipeId);
  return Object.freeze({
    ...binding,
    token,
    source,
    command,
    targetRecipeId,
    phase: "dispatching" as const,
    receipt: null,
    blockedReason: null,
  });
}

export function updateNativeBlueprintRecipeOverridePendingCommand(
  pending: NativeBlueprintRecipeOverridePendingCommand,
  phase: NativeBlueprintRecipeOverridePendingPhase,
  options: Readonly<{
    receipt?: NativeBlueprintRecipeOverrideCommitReceipt;
    blockedReason?: NativeBlueprintRecipeOverrideBlockedReason;
  }> = {},
): NativeBlueprintRecipeOverridePendingCommand {
  const receipt = options.receipt === undefined ? pending.receipt : pinReceipt(pending, options.receipt);
  const blockedReason = phase === "blocked" ? options.blockedReason ?? pending.blockedReason : null;
  if (phase === "awaiting-projection" && receipt === null) {
    throw new TypeError("等待原生蓝图配方覆盖投影前必须持有精确提交回执");
  }
  if (phase === "blocked" && blockedReason === null) {
    throw new TypeError("锁定原生蓝图配方覆盖事务必须给出原因");
  }
  return Object.freeze({ ...pending, phase, receipt, blockedReason });
}

export async function reconcileNativeBlueprintRecipeOverridePendingCommand(input: Readonly<{
  pending: NativeBlueprintRecipeOverridePendingCommand;
  isCurrent: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<NativeBlueprintRecipeOverrideReconciliationResult> {
  let observedPending = false;
  let observedUnavailable = false;
  for (const delay of NATIVE_BLUEPRINT_RECIPE_OVERRIDE_RECONCILIATION_DELAYS_MS) {
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

export function evaluateNativeBlueprintRecipeOverridePendingProjection(
  pending: NativeBlueprintRecipeOverridePendingCommand,
  authority: NativeBlueprintRecipeOverrideAuthorityObservation | null,
  projection: NativeBlueprintRecipeOverrideBinding | null,
): NativeBlueprintRecipeOverrideProjectionResult {
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
      projection.sourceRecipeId !== pending.sourceRecipeId ||
      projection.currentTargetRecipeId !== pending.targetRecipeId) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  return Object.freeze({ status: "confirmed" as const });
}

export function asNativeBlueprintRecipeOverrideCommitReceipt(
  pending: NativeBlueprintRecipeOverridePendingCommand,
  receipt: NativePlayerAuthorityCommandReceipt,
): NativeBlueprintRecipeOverrideCommitReceipt {
  return pinReceipt(pending, receipt);
}
