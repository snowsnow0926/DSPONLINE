import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  NativeFactoryProjectionIdentity,
  SelectedBeltReadModel,
} from "./factoryReadModels";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_LOGICAL_ID_BYTES = 256;
const MAX_OPAQUE_ID_BYTES = 512;
const TEXT_ENCODER = new TextEncoder();

export interface NativeProjectedBeltPriorityCommandInput {
  readonly commandIdentity: NativeFactoryProjectionIdentity;
  readonly inspector: FactoryInspectorSummaryReadModel;
  readonly selection: FactoryMultiSelectionSummaryReadModel;
  readonly targetPriority: 0 | 1 | 2;
}

function validLogicalId(value: unknown): value is string {
  return typeof value === "string" && LOGICAL_ID_PATTERN.test(value) &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_LOGICAL_ID_BYTES;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_OPAQUE_ID_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function safeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validPriority(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}

function sameIdentity(
  left: NativeFactoryProjectionIdentity | null,
  right: NativeFactoryProjectionIdentity,
): boolean {
  return left !== null && left.sessionId === right.sessionId && left.runId === right.runId &&
    left.revision === right.revision && left.planetId === right.planetId;
}

function validBeltRow(row: SelectedBeltReadModel, planetId: string): boolean {
  return validOpaqueId(row.beltId) && row.planetId === planetId &&
    validOpaqueId(row.sourceEntityId) && validOpaqueId(row.targetEntityId) &&
    validOpaqueId(row.itemId) && safeNonnegativeInteger(row.lanes) && row.lanes > 0 &&
    safeNonnegativeInteger(row.tier) && row.tier > 0 &&
    safeNonnegativeInteger(row.sorterTier) && row.sorterTier > 0 &&
    (row.stackSize === null || safeNonnegativeInteger(row.stackSize) && row.stackSize > 0) &&
    validPriority(row.priority) && typeof row.progress === "number" && Number.isFinite(row.progress) &&
    typeof row.lastFlow === "number" && Number.isFinite(row.lastFlow) &&
    (row.totalTransferred === null || typeof row.totalTransferred === "number" && Number.isFinite(row.totalTransferred)) &&
    (row.congestion === null || typeof row.congestion === "number" && Number.isFinite(row.congestion));
}

function sameBeltRow(left: SelectedBeltReadModel, right: SelectedBeltReadModel): boolean {
  return left.beltId === right.beltId && left.planetId === right.planetId &&
    left.sourceEntityId === right.sourceEntityId && left.targetEntityId === right.targetEntityId &&
    left.itemId === right.itemId && left.lanes === right.lanes && left.tier === right.tier &&
    left.sorterTier === right.sorterTier && left.stackSize === right.stackSize &&
    left.priority === right.priority && Object.is(left.progress, right.progress) &&
    Object.is(left.lastFlow, right.lastFlow) && left.totalTransferred === right.totalTransferred &&
    left.congestion === right.congestion;
}

/**
 * Builds one belt-priority leaf only from a complete same-revision Rust
 * inspector/selection pair. Rust remains authoritative and rechecks both the
 * base revision and current priority before durable staging.
 */
export function createNativeProjectedBeltPriorityCommand(
  input: NativeProjectedBeltPriorityCommandInput,
): SimulationCommandPatch | null {
  const { commandIdentity, inspector, selection, targetPriority } = input;
  if (!validLogicalId(commandIdentity.sessionId) || !validLogicalId(commandIdentity.runId) ||
      !safeNonnegativeInteger(commandIdentity.revision) || !validOpaqueId(commandIdentity.planetId) ||
      !validPriority(targetPriority) || inspector.schema !== "factory-read-model-v1" ||
      inspector.source !== "native-core" || inspector.revision !== commandIdentity.revision ||
      inspector.activePlanetId !== commandIdentity.planetId || inspector.entity !== null ||
      inspector.belt === null || selection.schema !== "factory-read-model-v1" ||
      selection.source !== "native-core" || selection.revision !== commandIdentity.revision ||
      selection.activePlanetId !== commandIdentity.planetId ||
      !sameIdentity(selection.projectionIdentity, commandIdentity) ||
      selection.requestedEntityCount !== 0 || selection.requestedBeltCount !== 1 ||
      selection.entityRows.truncated || selection.entityRows.totalCount !== 0 ||
      selection.entityRows.rows.length !== 0 || selection.beltRows.truncated ||
      selection.beltRows.totalCount !== 1 || selection.beltRows.rows.length !== 1) {
    throw new TypeError("原生传送带优先级投影 identity 或完整性无效");
  }
  const selected = selection.beltRows.rows[0];
  if (!validBeltRow(inspector.belt, commandIdentity.planetId) ||
      !validBeltRow(selected, commandIdentity.planetId) ||
      !sameBeltRow(inspector.belt, selected)) {
    throw new TypeError("原生传送带优先级投影行不一致");
  }
  if (selected.priority === targetPriority) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: commandIdentity.revision,
    topLevelChanges: [],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [{
      id: selected.beltId,
      changes: [{ path: ["priority"], operation: "set", value: targetPriority }],
    }],
    addedBelts: [],
    removedBeltIds: [],
  };
}
