import {
  nativeBlueprintDirectDeployContextSupportsCommand,
  type NativeBlueprintDirectDeployContext,
} from "./nativeBlueprintDirectDeployContext";
import type {
  NativePlayerAuthorityCommandReceipt,
  NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const UTF8_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export const NATIVE_BLUEPRINT_DIRECT_DEPLOY_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

export type NativeBlueprintDirectDeployPendingPhase =
  | "dispatching"
  | "reconciling"
  | "awaiting-topology"
  | "blocked";

export interface NativeBlueprintDirectDeployCommitReceipt {
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedEntityIds: readonly string[];
  readonly changedBeltIds: readonly string[];
  readonly topologyDirty: boolean;
}

export type NativeBlueprintDirectDeployBlockedReason =
  | "conflict"
  | "receipt-invalid"
  | "pending-timeout"
  | "reconciliation-unavailable"
  | "receipt-topology-mismatch";

export interface NativeBlueprintDirectDeployPendingCommand {
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
  readonly position: Readonly<{ x: number; y: number }>;
  readonly phase: NativeBlueprintDirectDeployPendingPhase;
  readonly receipt: NativeBlueprintDirectDeployCommitReceipt | null;
  readonly blockedReason: NativeBlueprintDirectDeployBlockedReason | null;
}

export interface NativeBlueprintDirectDeployAuthorityObservation {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
}

export interface NativeBlueprintDirectDeployTopologyObservation
  extends NativeBlueprintDirectDeployAuthorityObservation {
  readonly registryFingerprint: string;
  readonly activePlanetId: string;
  readonly source: "native-authoritative";
}

export type NativeBlueprintDirectDeployReconciliationResult = Readonly<
  | { status: "committed"; receipt: NativeBlueprintDirectDeployCommitReceipt }
  | { status: "not-committed" }
  | { status: "cancelled" }
  | { status: "blocked"; reason: NativeBlueprintDirectDeployBlockedReason }
>;

export type NativeBlueprintDirectDeployTopologyResult = Readonly<
  | { status: "waiting" }
  | { status: "confirmed" }
  | { status: "lineage-changed" }
  | { status: "blocked"; reason: "receipt-topology-mismatch" }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
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

function validFinitePosition(value: unknown): value is Readonly<{ x: number; y: number }> {
  return isRecord(value) && hasExactKeys(value, ["x", "y"]) &&
    Number.isFinite(value.x) && Number.isFinite(value.y);
}

function validLogicalId(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && LOGICAL_ID.test(value) &&
    UTF8_ENCODER.encode(value).byteLength <= maximumBytes;
}

function validOpaqueId(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0 ||
      UTF8_ENCODER.encode(value).byteLength > maximumBytes || CONTROL_CHARACTER.test(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function pinExactDirectDeployCommand(
  command: SimulationCommandPatch,
  context: NativeBlueprintDirectDeployContext,
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
    throw new TypeError("原生蓝图直接部署命令不是精确的单意图补丁");
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
      ]) || marker.value.kind !== "direct-deploy" ||
      marker.value.blueprintId !== context.request.blueprintId ||
      marker.value.blueprintRevision !== context.request.blueprintRevision ||
      marker.value.revision !== context.revision ||
      !validFinitePosition(marker.value.position) ||
      marker.value.position.x !== context.request.position.x ||
      marker.value.position.y !== context.request.position.y) {
    throw new TypeError("原生蓝图直接部署命令标记与 Rust 上下文不一致");
  }

  const pinnedPosition = Object.freeze({
    x: context.request.position.x,
    y: context.request.position.y,
  });
  const pinnedValue = Object.freeze({
    kind: "direct-deploy" as const,
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
  pending: NativeBlueprintDirectDeployPendingCommand,
  receipt: NativeBlueprintDirectDeployCommitReceipt,
): NativeBlueprintDirectDeployCommitReceipt {
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
    throw new TypeError("原生蓝图直接部署回执与原命令不一致");
  }
  return Object.freeze({
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: Object.freeze([]),
    changedBeltIds: Object.freeze([]),
    topologyDirty: true as const,
  });
}

export function createNativeBlueprintDirectDeployPendingCommand(input: Readonly<{
  token: number;
  source: NativePlayerAuthorityCommandSource;
  command: SimulationCommandPatch;
  context: NativeBlueprintDirectDeployContext;
}>): NativeBlueprintDirectDeployPendingCommand {
  const { token, source, context } = input;
  if (!Number.isSafeInteger(token) || token <= 0 ||
      !nativeBlueprintDirectDeployContextSupportsCommand(context) ||
      source.sessionId !== context.sessionId || source.runId !== context.runId ||
      source.baseRevision !== context.revision) {
    throw new TypeError("原生蓝图直接部署 source 与 Rust 上下文不一致");
  }
  const command = pinExactDirectDeployCommand(input.command, context);
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
    position: Object.freeze({ ...context.request.position }),
    phase: "dispatching" as const,
    receipt: null,
    blockedReason: null,
  });
}

export function updateNativeBlueprintDirectDeployPendingCommand(
  pending: NativeBlueprintDirectDeployPendingCommand,
  phase: NativeBlueprintDirectDeployPendingPhase,
  options: Readonly<{
    receipt?: NativeBlueprintDirectDeployCommitReceipt;
    blockedReason?: NativeBlueprintDirectDeployBlockedReason;
  }> = {},
): NativeBlueprintDirectDeployPendingCommand {
  const receipt = options.receipt === undefined ? pending.receipt : pinReceipt(pending, options.receipt);
  const blockedReason = phase === "blocked" ? options.blockedReason ?? pending.blockedReason : null;
  if (phase === "awaiting-topology" && receipt === null) {
    throw new TypeError("等待原生蓝图直接部署拓扑前必须持有精确提交回执");
  }
  if (phase === "blocked" && blockedReason === null) {
    throw new TypeError("锁定原生蓝图直接部署事务必须给出原因");
  }
  return Object.freeze({ ...pending, phase, receipt, blockedReason });
}

export async function reconcileNativeBlueprintDirectDeployPendingCommand(input: Readonly<{
  pending: NativeBlueprintDirectDeployPendingCommand;
  isCurrent: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<NativeBlueprintDirectDeployReconciliationResult> {
  let observedPending = false;
  let observedUnavailable = false;
  for (const delay of NATIVE_BLUEPRINT_DIRECT_DEPLOY_RECONCILIATION_DELAYS_MS) {
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

function validTopologyObservation(value: unknown): value is NativeBlueprintDirectDeployTopologyObservation {
  return isRecord(value) && hasExactKeys(value, [
    "sessionId",
    "runId",
    "revision",
    "registryFingerprint",
    "activePlanetId",
    "source",
  ]) && validLogicalId(value.sessionId, 128) && validLogicalId(value.runId, 128) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 &&
    (value.revision as number) < Number.MAX_SAFE_INTEGER &&
    validLogicalId(value.registryFingerprint, 256) &&
    validOpaqueId(value.activePlanetId, 512) &&
    value.source === "native-authoritative";
}

export function evaluateNativeBlueprintDirectDeployTopology(
  pending: NativeBlueprintDirectDeployPendingCommand,
  topology: NativeBlueprintDirectDeployTopologyObservation | null,
): NativeBlueprintDirectDeployTopologyResult {
  if (topology === null) return Object.freeze({ status: "waiting" as const });
  if (!validTopologyObservation(topology)) {
    return Object.freeze({ status: "blocked" as const, reason: "receipt-topology-mismatch" as const });
  }
  if (topology.sessionId !== pending.sessionId || topology.runId !== pending.runId) {
    return Object.freeze({ status: "lineage-changed" as const });
  }
  if (pending.receipt === null || topology.revision < pending.receipt.revision) {
    return Object.freeze({ status: "waiting" as const });
  }
  if (topology.registryFingerprint !== pending.registryFingerprint) {
    return Object.freeze({ status: "blocked" as const, reason: "receipt-topology-mismatch" as const });
  }
  return Object.freeze({ status: "confirmed" as const });
}

export function asNativeBlueprintDirectDeployCommitReceipt(
  pending: NativeBlueprintDirectDeployPendingCommand,
  receipt: NativePlayerAuthorityCommandReceipt,
): NativeBlueprintDirectDeployCommitReceipt {
  return pinReceipt(pending, {
    previousRevision: receipt.previousRevision,
    revision: receipt.revision,
    changedEntityIds: receipt.changedEntityIds,
    changedBeltIds: receipt.changedBeltIds,
    topologyDirty: receipt.topologyDirty as true,
  });
}
