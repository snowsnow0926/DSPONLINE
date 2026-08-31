import type {
  NativePlayerAuthorityCommandReceipt,
  NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type { NativeProjectedEntityRecipeBinding } from "./nativeProjectedEntityRecipeCommands";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { PlanetId, RecipeId } from "./types";

export const NATIVE_ENTITY_RECIPE_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

export type NativeEntityRecipePendingPhase =
  | "dispatching"
  | "reconciling"
  | "awaiting-projection"
  | "blocked";

export interface NativeEntityRecipeCommitReceipt {
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

export interface NativeEntityRecipePendingCommand {
  readonly token: number;
  readonly source: NativePlayerAuthorityCommandSource;
  readonly command: SimulationCommandPatch;
  readonly sessionId: string;
  readonly runId: string;
  readonly baseRevision: number;
  readonly registryFingerprint: string;
  readonly activePlanetId: PlanetId;
  readonly entityId: string;
  readonly targetRecipeId: RecipeId;
  readonly phase: NativeEntityRecipePendingPhase;
  readonly receipt: NativeEntityRecipeCommitReceipt | null;
  readonly blockedReason: NativeEntityRecipeReconciliationBlockedReason | null;
}

export type NativeEntityRecipeReconciliationBlockedReason =
  | "conflict"
  | "receipt-invalid"
  | "pending-timeout"
  | "reconciliation-unavailable"
  | "receipt-projection-mismatch";

export type NativeEntityRecipeReconciliationResult = Readonly<
  | { status: "committed"; receipt: NativeEntityRecipeCommitReceipt }
  | { status: "not-committed" }
  | { status: "cancelled" }
  | { status: "blocked"; reason: NativeEntityRecipeReconciliationBlockedReason }
>;

export type NativeEntityRecipeProjectionResult = Readonly<
  | { status: "waiting" }
  | { status: "confirmed" }
  | { status: "lineage-changed" }
  | {
    status: "blocked";
    reason: "receipt-projection-mismatch";
  }
>;

export interface NativeEntityRecipeAuthorityObservation {
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

function pinExactRecipeCommand(
  command: SimulationCommandPatch,
  baseRevision: number,
  entityId: string,
  targetRecipeId: RecipeId,
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
      value.baseRevision !== baseRevision || !Array.isArray(value.topLevelChanges) ||
      value.topLevelChanges.length !== 1 ||
      !isEmptyArray(value.changedEntities) || !isEmptyArray(value.addedEntities) ||
      !isEmptyArray(value.removedEntityIds) || !isEmptyArray(value.changedBelts) ||
      !isEmptyArray(value.addedBelts) || !isEmptyArray(value.removedBeltIds)) {
    throw new TypeError("原生建筑配方命令不是精确的单意图补丁");
  }
  const marker = value.topLevelChanges[0];
  if (!isRecord(marker) || !hasExactKeys(marker, ["path", "operation", "value"]) ||
      !Array.isArray(marker.path) || marker.path.length !== 2 ||
      marker.path[0] !== "entityRecipe" || marker.path[1] !== "intent" ||
      marker.operation !== "set" || !isRecord(marker.value) ||
      !hasExactKeys(marker.value, ["entityId", "targetRecipeId"]) ||
      marker.value.entityId !== entityId || marker.value.targetRecipeId !== targetRecipeId) {
    throw new TypeError("原生建筑配方命令标记与投影绑定不一致");
  }

  const pinnedValue = Object.freeze({ entityId, targetRecipeId });
  const pinnedMarker = Object.freeze({
    path: Object.freeze(["entityRecipe", "intent"]),
    operation: "set" as const,
    value: pinnedValue,
  });
  return Object.freeze({
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
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
  pending: NativeEntityRecipePendingCommand,
  receipt: NativeEntityRecipeCommitReceipt,
): NativeEntityRecipeCommitReceipt {
  if (receipt.previousRevision !== pending.baseRevision ||
      receipt.revision !== pending.baseRevision + 1 ||
      receipt.changedEntityIds.length !== 1 ||
      receipt.changedEntityIds[0] !== pending.entityId ||
      receipt.changedBeltIds.length !== 0 || receipt.topologyDirty !== true) {
    throw new TypeError("原生建筑配方回执与原命令不一致");
  }
  return Object.freeze({
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: Object.freeze([...receipt.changedEntityIds]),
    changedBeltIds: Object.freeze([...receipt.changedBeltIds]),
    topologyDirty: true,
  });
}

export function createNativeEntityRecipePendingCommand(input: Readonly<{
  token: number;
  source: NativePlayerAuthorityCommandSource;
  command: SimulationCommandPatch;
  binding: NativeProjectedEntityRecipeBinding;
  targetRecipeId: RecipeId;
}>): NativeEntityRecipePendingCommand {
  const { token, source, binding, targetRecipeId } = input;
  if (!Number.isSafeInteger(token) || token <= 0 ||
      source.sessionId !== binding.sessionId || source.runId !== binding.runId ||
      source.baseRevision !== binding.revision || binding.entity.planetId !== binding.activePlanetId) {
    throw new TypeError("原生建筑配方命令 source 与投影 lineage 不一致");
  }
  const command = pinExactRecipeCommand(
    input.command,
    binding.revision,
    binding.entity.id,
    targetRecipeId,
  );
  return Object.freeze({
    token,
    source,
    command,
    sessionId: binding.sessionId,
    runId: binding.runId,
    baseRevision: binding.revision,
    registryFingerprint: binding.registryFingerprint,
    activePlanetId: binding.activePlanetId,
    entityId: binding.entity.id,
    targetRecipeId,
    phase: "dispatching" as const,
    receipt: null,
    blockedReason: null,
  });
}

export function updateNativeEntityRecipePendingCommand(
  pending: NativeEntityRecipePendingCommand,
  phase: NativeEntityRecipePendingPhase,
  options: Readonly<{
    receipt?: NativeEntityRecipeCommitReceipt;
    blockedReason?: NativeEntityRecipeReconciliationBlockedReason;
  }> = {},
): NativeEntityRecipePendingCommand {
  const receipt = options.receipt === undefined
    ? pending.receipt
    : pinReceipt(pending, options.receipt);
  const blockedReason = phase === "blocked"
    ? options.blockedReason ?? pending.blockedReason
    : null;
  if (phase === "awaiting-projection" && receipt === null) {
    throw new TypeError("等待原生配方投影前必须持有精确提交回执");
  }
  if (phase === "blocked" && blockedReason === null) {
    throw new TypeError("锁定原生配方事务必须给出原因");
  }
  return Object.freeze({ ...pending, phase, receipt, blockedReason });
}

export async function reconcileNativeEntityRecipePendingCommand(input: Readonly<{
  pending: NativeEntityRecipePendingCommand;
  isCurrent: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<NativeEntityRecipeReconciliationResult> {
  let observedPending = false;
  let observedUnavailable = false;
  for (const delay of NATIVE_ENTITY_RECIPE_RECONCILIATION_DELAYS_MS) {
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

export function evaluateNativeEntityRecipePendingProjection(
  pending: NativeEntityRecipePendingCommand,
  authority: NativeEntityRecipeAuthorityObservation | null,
  projection: NativeProjectedEntityRecipeBinding | null,
): NativeEntityRecipeProjectionResult {
  if (!authority) return Object.freeze({ status: "waiting" as const });
  if (authority.sessionId !== pending.sessionId || authority.runId !== pending.runId) {
    return Object.freeze({ status: "lineage-changed" as const });
  }
  if (pending.receipt === null) return Object.freeze({ status: "waiting" as const });
  if (authority.revision < pending.receipt.revision) {
    return Object.freeze({ status: "waiting" as const });
  }
  if (!projection || projection.sessionId !== pending.sessionId ||
      projection.runId !== pending.runId || projection.revision !== authority.revision ||
      projection.revision < pending.receipt.revision ||
      projection.registryFingerprint !== pending.registryFingerprint ||
      projection.activePlanetId !== pending.activePlanetId ||
      projection.entity.id !== pending.entityId ||
      projection.entity.planetId !== pending.activePlanetId) {
    return Object.freeze({ status: "waiting" as const });
  }
  if (projection.entity.recipeId !== pending.targetRecipeId) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "receipt-projection-mismatch" as const,
    });
  }
  return Object.freeze({ status: "confirmed" as const });
}

export function asNativeEntityRecipeCommitReceipt(
  pending: NativeEntityRecipePendingCommand,
  receipt: NativePlayerAuthorityCommandReceipt,
): NativeEntityRecipeCommitReceipt {
  return pinReceipt(pending, receipt);
}
