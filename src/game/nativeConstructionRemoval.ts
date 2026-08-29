import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const MAX_OPAQUE_ID_BYTES = 512;
const TEXT_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const SUPPORT_REASONS = new Set([
  "entity-not-found",
  "invalid-entity",
  "not-active-planet",
  "interaction-locked",
  "missing-building-id",
  "unknown-building",
  "missing-construction-definition",
  "unsupported-building-kind",
  "unsupported-building-domain",
  "entity-kind-mismatch",
  "invalid-machine-count",
  "empty-machine-stack",
  "spray-coater-installed",
  "buffered-material",
  "incident-belt",
  "construction-queue-reference",
  "blueprint-pruning-required",
  "invalid-construction-inventory",
  "refund-overflow",
] as const);

export type NativeConstructionRemovalSupportReason =
  | "entity-not-found"
  | "invalid-entity"
  | "not-active-planet"
  | "interaction-locked"
  | "missing-building-id"
  | "unknown-building"
  | "missing-construction-definition"
  | "unsupported-building-kind"
  | "unsupported-building-domain"
  | "entity-kind-mismatch"
  | "invalid-machine-count"
  | "empty-machine-stack"
  | "spray-coater-installed"
  | "buffered-material"
  | "incident-belt"
  | "construction-queue-reference"
  | "blueprint-pruning-required"
  | "invalid-construction-inventory"
  | "refund-overflow";

export interface NativeConstructionRemovalIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeConstructionRemovalContext {
  readonly schemaVersion: 1;
  readonly projectionType: "construction-removal-context-v1";
  readonly source: "native-core";
  readonly revision: number;
  readonly stateVersion: 47;
  readonly registryFingerprint: string;
  readonly request: Readonly<{
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    entityId: string;
  }>;
  readonly activePlanetId: string;
  readonly entityId: string;
  readonly buildingId: string | null;
  readonly machineCount: number | null;
  readonly currentConstruction: number | null;
  readonly refundAfterRemoval: number | null;
  readonly support: Readonly<{
    supported: boolean;
    reason: NativeConstructionRemovalSupportReason | null;
  }>;
  readonly limits: Readonly<{ projectionBytes: number }>;
}

export interface NativeConstructionRemovalBridge {
  getNativeCoreConstructionRemovalContext?(request: {
    sessionId: string;
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    entityId: string;
  }): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validLogicalId(value: unknown, maximumLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    LOGICAL_ID.test(value);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_OPAQUE_ID_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validOptionalOpaqueId(value: unknown): value is string | null {
  return value === null || validOpaqueId(value);
}

function validOptionalQuantity(value: unknown): value is number | null {
  return value === null || safeNonnegativeInteger(value);
}

function validContext(
  value: unknown,
  identity: NativeConstructionRemovalIdentity,
  entityId: string,
): value is NativeConstructionRemovalContext {
  if (!validOpaqueId(entityId) || !isRecord(value) || value.schemaVersion !== 1 ||
      value.projectionType !== "construction-removal-context-v1" ||
      value.source !== "native-core" || value.stateVersion !== 47 ||
      value.revision !== identity.revision ||
      value.registryFingerprint !== identity.registryFingerprint ||
      !validOpaqueId(value.activePlanetId) || value.entityId !== entityId ||
      !validOptionalOpaqueId(value.buildingId) ||
      !validOptionalQuantity(value.machineCount) ||
      !validOptionalQuantity(value.currentConstruction) ||
      !validOptionalQuantity(value.refundAfterRemoval) ||
      !isRecord(value.request) ||
      value.request.expectedRevision !== identity.revision ||
      value.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
      value.request.entityId !== entityId || !isRecord(value.support) ||
      typeof value.support.supported !== "boolean" || !isRecord(value.limits) ||
      value.limits.projectionBytes !== 1_048_576) return false;

  const supportReason = value.support.reason;
  if (supportReason !== null &&
      (typeof supportReason !== "string" || !SUPPORT_REASONS.has(
        supportReason as NativeConstructionRemovalSupportReason,
      ))) return false;
  if (!value.support.supported) {
    return supportReason !== null && value.refundAfterRemoval === null;
  }
  return supportReason === null && validOpaqueId(value.buildingId) &&
    safeNonnegativeInteger(value.machineCount) && value.machineCount > 0 &&
    safeNonnegativeInteger(value.currentConstruction) &&
    safeNonnegativeInteger(value.refundAfterRemoval) &&
    value.refundAfterRemoval === value.currentConstruction + value.machineCount;
}

/**
 * Obtains one same-revision, read-only removal capability from the Rust owner.
 * The renderer never derives a refund from its sealed JavaScript checkpoint.
 */
export async function readVerifiedNativeConstructionRemovalContext(
  bridge: NativeConstructionRemovalBridge | null,
  identity: NativeConstructionRemovalIdentity,
  entityId: string,
): Promise<NativeConstructionRemovalContext | null> {
  const reader = bridge?.getNativeCoreConstructionRemovalContext;
  if (typeof reader !== "function" || !validLogicalId(identity.sessionId, 128) ||
      !validLogicalId(identity.runId, 128) || !safeNonnegativeInteger(identity.revision) ||
      !validLogicalId(identity.registryFingerprint) || !validOpaqueId(entityId)) return null;
  try {
    const value = await reader({
      sessionId: identity.sessionId,
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      entityId,
    });
    return validContext(value, identity, entityId) ? value : null;
  } catch {
    return null;
  }
}

/** Builds the sole exact command admitted by Rust for this capability. */
export function createNativeProjectedOrdinaryBuildingRemovalCommand(
  context: NativeConstructionRemovalContext,
): SimulationCommandPatch | null {
  if (!validContext(context, {
    sessionId: "validation",
    runId: "validation",
    revision: context.revision,
    registryFingerprint: context.registryFingerprint,
  }, context.entityId) || !context.support.supported || !context.buildingId ||
      context.refundAfterRemoval === null) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
    topLevelChanges: [{
      path: ["construction", context.buildingId],
      operation: "set",
      value: context.refundAfterRemoval,
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [context.entityId],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}
