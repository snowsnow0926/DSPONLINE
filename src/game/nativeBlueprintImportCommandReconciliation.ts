import {
  nativeBlueprintImportContextSupportsCommand,
  type NativeBlueprintImportContext,
  type NativeBlueprintImportPreparedIntent,
} from "./nativeBlueprintImportContext";
import type {
  NativePlayerAuthorityCommandReceipt,
  NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { NativeBlueprintLibraryMembershipProof } from "./nativeBlueprintWorkspaceStore";

export const NATIVE_BLUEPRINT_IMPORT_RECONCILIATION_DELAYS_MS = Object.freeze([
  0, 100, 250, 500, 1_000, 2_000,
] as const);

export type NativeBlueprintImportPendingPhase =
  | "dispatching"
  | "reconciling"
  | "awaiting-projection"
  | "blocked";

export interface NativeBlueprintImportCommitReceipt {
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

export type NativeBlueprintImportBlockedReason =
  | "conflict"
  | "receipt-invalid"
  | "pending-timeout"
  | "reconciliation-unavailable"
  | "receipt-projection-mismatch";

export interface NativeBlueprintImportPendingCommand {
  readonly token: number;
  readonly source: NativePlayerAuthorityCommandSource;
  readonly command: SimulationCommandPatch;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly activePlanetId: string;
  readonly rawSha256: string;
  readonly preparedIntent: NativeBlueprintImportPreparedIntent;
  readonly expectedBlueprintId: string;
  readonly expectedBlueprintName: string;
  readonly expectedBlueprintRevision: 1;
  readonly phase: NativeBlueprintImportPendingPhase;
  readonly receipt: NativeBlueprintImportCommitReceipt | null;
  readonly membershipProof: NativeBlueprintLibraryMembershipProof | null;
  readonly blockedReason: NativeBlueprintImportBlockedReason | null;
}

export interface NativeBlueprintImportAuthorityObservation {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
}

export type NativeBlueprintImportReconciliationResult = Readonly<
  | { status: "committed"; receipt: NativeBlueprintImportCommitReceipt }
  | { status: "not-committed" }
  | { status: "cancelled" }
  | { status: "blocked"; reason: NativeBlueprintImportBlockedReason }
>;

export type NativeBlueprintImportProjectionResult = Readonly<
  | { status: "waiting" }
  | { status: "confirmed" }
  | { status: "stale-proof" }
  | { status: "lineage-changed" }
  | { status: "blocked"; reason: "receipt-projection-mismatch" }
>;

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

function samePreparedIntent(left: unknown, right: NativeBlueprintImportPreparedIntent): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function pinExactImportCommand(
  command: SimulationCommandPatch,
  context: NativeBlueprintImportContext & { preparedIntent: NativeBlueprintImportPreparedIntent },
): SimulationCommandPatch {
  const value = command as unknown;
  if (!isRecord(value) || !hasExactKeys(value, [
    "protocolVersion", "baseRevision", "topLevelChanges", "changedEntities", "addedEntities",
    "removedEntityIds", "changedBelts", "addedBelts", "removedBeltIds",
  ]) || value.protocolVersion !== SIMULATION_RUNTIME_PROTOCOL_VERSION ||
      value.baseRevision !== context.revision || !Array.isArray(value.topLevelChanges) ||
      value.topLevelChanges.length !== 1 || !isEmptyArray(value.changedEntities) ||
      !isEmptyArray(value.addedEntities) || !isEmptyArray(value.removedEntityIds) ||
      !isEmptyArray(value.changedBelts) || !isEmptyArray(value.addedBelts) ||
      !isEmptyArray(value.removedBeltIds)) {
    throw new TypeError("原生蓝图导入命令不是精确的单意图补丁");
  }
  const marker = value.topLevelChanges[0];
  if (!isRecord(marker) || !hasExactKeys(marker, ["path", "operation", "value"]) ||
      !Array.isArray(marker.path) || marker.path.length !== 2 ||
      marker.path[0] !== "blueprints" || marker.path[1] !== "intent" ||
      marker.operation !== "set" || !samePreparedIntent(marker.value, context.preparedIntent)) {
    throw new TypeError("原生蓝图导入命令标记与 Rust 上下文不一致");
  }
  const pinnedMarker = Object.freeze({
    path: Object.freeze(["blueprints", "intent"]),
    operation: "set" as const,
    value: context.preparedIntent,
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
  pending: NativeBlueprintImportPendingCommand,
  receipt: NativeBlueprintImportCommitReceipt,
): NativeBlueprintImportCommitReceipt {
  const value = receipt as unknown;
  if (!isRecord(value) || !hasExactKeys(value, [
    "previousRevision", "revision", "changedEntityIds", "changedBeltIds", "topologyDirty",
  ]) || !Array.isArray(receipt.changedEntityIds) || !Array.isArray(receipt.changedBeltIds) ||
      receipt.previousRevision !== pending.revision || receipt.revision !== pending.revision + 1 ||
      receipt.changedEntityIds.length !== 0 || receipt.changedBeltIds.length !== 0 ||
      receipt.topologyDirty !== true) {
    throw new TypeError("原生蓝图导入回执与原命令不一致");
  }
  return Object.freeze({
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: Object.freeze([]),
    changedBeltIds: Object.freeze([]),
    topologyDirty: true as const,
  });
}

export function createNativeBlueprintImportPendingCommand(input: Readonly<{
  token: number;
  source: NativePlayerAuthorityCommandSource;
  command: SimulationCommandPatch;
  context: NativeBlueprintImportContext;
}>): NativeBlueprintImportPendingCommand {
  const { token, source, context } = input;
  if (!Number.isSafeInteger(token) || token <= 0 ||
      !nativeBlueprintImportContextSupportsCommand(context) ||
      source.sessionId !== context.sessionId || source.runId !== context.runId ||
      source.baseRevision !== context.revision) {
    throw new TypeError("原生蓝图导入 source 与 Rust 上下文不一致");
  }
  const command = pinExactImportCommand(input.command, context);
  return Object.freeze({
    token,
    source,
    command,
    sessionId: context.sessionId,
    runId: context.runId,
    revision: context.revision,
    registryFingerprint: context.registryFingerprint,
    activePlanetId: context.activePlanetId,
    rawSha256: context.request.rawSha256,
    preparedIntent: context.preparedIntent,
    expectedBlueprintId: context.preparedIntent.blueprint.id,
    expectedBlueprintName: context.preparedIntent.blueprint.name,
    expectedBlueprintRevision: 1 as const,
    phase: "dispatching" as const,
    receipt: null,
    membershipProof: null,
    blockedReason: null,
  });
}

export function attachNativeBlueprintImportMembershipProof(
  pending: NativeBlueprintImportPendingCommand,
  proof: NativeBlueprintLibraryMembershipProof,
): NativeBlueprintImportPendingCommand {
  const value = proof as unknown;
  if (!isRecord(value) || !hasExactKeys(value, [
    "sessionId", "runId", "revision", "registryFingerprint", "blueprintId", "present",
  ]) || pending.receipt === null || proof.sessionId !== pending.sessionId ||
      proof.runId !== pending.runId || proof.registryFingerprint !== pending.registryFingerprint ||
      proof.blueprintId !== pending.expectedBlueprintId || !Number.isSafeInteger(proof.revision) ||
      proof.revision < pending.receipt.revision || typeof proof.present !== "boolean") {
    throw new TypeError("蓝图库成员证明未绑定同一导入事务和 revision");
  }
  return Object.freeze({
    ...pending,
    membershipProof: Object.freeze({
      sessionId: proof.sessionId,
      runId: proof.runId,
      revision: proof.revision,
      registryFingerprint: proof.registryFingerprint,
      blueprintId: proof.blueprintId,
      present: proof.present,
    }),
  });
}

export function clearNativeBlueprintImportMembershipProof(
  pending: NativeBlueprintImportPendingCommand,
): NativeBlueprintImportPendingCommand {
  if (pending.phase !== "awaiting-projection" || pending.receipt === null ||
      pending.membershipProof === null) {
    throw new TypeError("只能退役等待投影阶段的旧蓝图库成员证明");
  }
  return Object.freeze({ ...pending, membershipProof: null });
}

export function updateNativeBlueprintImportPendingCommand(
  pending: NativeBlueprintImportPendingCommand,
  phase: NativeBlueprintImportPendingPhase,
  options: Readonly<{
    receipt?: NativeBlueprintImportCommitReceipt;
    blockedReason?: NativeBlueprintImportBlockedReason;
  }> = {},
): NativeBlueprintImportPendingCommand {
  const receipt = options.receipt === undefined ? pending.receipt : pinReceipt(pending, options.receipt);
  const blockedReason = phase === "blocked" ? options.blockedReason ?? pending.blockedReason : null;
  if (phase === "awaiting-projection" && receipt === null) {
    throw new TypeError("等待原生蓝图导入投影前必须持有精确提交回执");
  }
  if (phase === "blocked" && blockedReason === null) {
    throw new TypeError("锁定原生蓝图导入事务必须给出原因");
  }
  return Object.freeze({ ...pending, phase, receipt, blockedReason });
}

export async function reconcileNativeBlueprintImportPendingCommand(input: Readonly<{
  pending: NativeBlueprintImportPendingCommand;
  isCurrent: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<NativeBlueprintImportReconciliationResult> {
  let observedPending = false;
  let observedUnavailable = false;
  for (const delay of NATIVE_BLUEPRINT_IMPORT_RECONCILIATION_DELAYS_MS) {
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
    if (outcome.status === "not-committed") return Object.freeze({ status: "not-committed" as const });
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

export function evaluateNativeBlueprintImportPendingProjection(
  pending: NativeBlueprintImportPendingCommand,
  authority: NativeBlueprintImportAuthorityObservation | null,
): NativeBlueprintImportProjectionResult {
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
      pending.membershipProof.blueprintId !== pending.expectedBlueprintId) {
    return Object.freeze({ status: "blocked" as const, reason: "receipt-projection-mismatch" as const });
  }
  if (pending.membershipProof.revision !== authority.revision) {
    return pending.membershipProof.revision < authority.revision
      ? Object.freeze({ status: "stale-proof" as const })
      : Object.freeze({ status: "blocked" as const, reason: "receipt-projection-mismatch" as const });
  }
  if (!pending.membershipProof.present) {
    return Object.freeze({ status: "blocked" as const, reason: "receipt-projection-mismatch" as const });
  }
  return Object.freeze({ status: "confirmed" as const });
}

export function asNativeBlueprintImportCommitReceipt(
  pending: NativeBlueprintImportPendingCommand,
  receipt: NativePlayerAuthorityCommandReceipt,
): NativeBlueprintImportCommitReceipt {
  return pinReceipt(pending, {
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: receipt.changedEntityIds,
    changedBeltIds: receipt.changedBeltIds,
    topologyDirty: receipt.topologyDirty,
  });
}
