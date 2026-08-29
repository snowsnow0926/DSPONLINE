import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const MAX_OPAQUE_ID_BYTES = 512;
const PROJECTION_BYTE_LIMIT = 1_048_576;
const TEXT_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const SUPPORT_REASONS = new Set([
  "invalid-target-count",
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
  "invalid-current-count",
  "empty-machine-stack",
  "unchanged-target",
  "stack-limit",
  "catalog-incomplete",
  "invalid-construction-inventory",
  "inventory-insufficient",
  "refund-overflow",
] as const);

export type NativeConstructionStackSupportReason = typeof SUPPORT_REASONS extends Set<infer T>
  ? T
  : never;

export interface NativeConstructionStackIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeConstructionStackContext {
  readonly schemaVersion: 1;
  readonly projectionType: "construction-stack-context-v1";
  readonly source: "native-core";
  readonly sessionId: string;
  readonly revision: number;
  readonly stateVersion: 47;
  readonly registryFingerprint: string;
  readonly request: Readonly<{
    sessionId: string;
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    entityId: string;
    targetCount: number;
  }>;
  readonly activePlanetId: string;
  readonly entityId: string;
  readonly buildingId: string | null;
  readonly currentCount: number | null;
  readonly targetCount: number;
  readonly currentConstruction: number | null;
  readonly constructionAfter: number | null;
  readonly support: Readonly<{
    supported: boolean;
    reason: NativeConstructionStackSupportReason | null;
  }>;
  readonly limits: Readonly<{ projectionBytes: 1_048_576 }>;
}

export interface NativeConstructionStackBridge {
  getNativeCoreConstructionStackContext?(request: {
    sessionId: string;
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    entityId: string;
    targetCount: number;
  }): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safePositiveInteger(value: unknown): value is number {
  return safeNonnegativeInteger(value) && value > 0;
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
  identity: NativeConstructionStackIdentity,
  entityId: string,
  targetCount: number,
): value is NativeConstructionStackContext {
  if (!validOpaqueId(entityId) || !safePositiveInteger(targetCount) || !isRecord(value) ||
      value.schemaVersion !== 1 || value.projectionType !== "construction-stack-context-v1" ||
      value.source !== "native-core" || value.sessionId !== identity.sessionId ||
      value.revision !== identity.revision || value.stateVersion !== 47 ||
      value.registryFingerprint !== identity.registryFingerprint ||
      !validOpaqueId(value.activePlanetId) || value.entityId !== entityId ||
      !validOptionalOpaqueId(value.buildingId) || !validOptionalQuantity(value.currentCount) ||
      value.targetCount !== targetCount || !validOptionalQuantity(value.currentConstruction) ||
      !validOptionalQuantity(value.constructionAfter) || !isRecord(value.request) ||
      value.request.sessionId !== identity.sessionId ||
      value.request.expectedRevision !== identity.revision ||
      value.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
      value.request.entityId !== entityId || value.request.targetCount !== targetCount ||
      !isRecord(value.support) || typeof value.support.supported !== "boolean" ||
      !isRecord(value.limits) || value.limits.projectionBytes !== PROJECTION_BYTE_LIMIT) return false;

  const reason = value.support.reason;
  if (reason !== null &&
      (typeof reason !== "string" || !SUPPORT_REASONS.has(reason as NativeConstructionStackSupportReason))) {
    return false;
  }
  if (!value.support.supported) return reason !== null && value.constructionAfter === null;
  if (reason !== null || !validOpaqueId(value.buildingId) ||
      !safePositiveInteger(value.currentCount) || value.currentCount === targetCount ||
      !safeNonnegativeInteger(value.currentConstruction) ||
      !safeNonnegativeInteger(value.constructionAfter)) return false;

  if (targetCount > value.currentCount) {
    const debit = targetCount - value.currentCount;
    return value.currentConstruction >= debit &&
      value.constructionAfter === value.currentConstruction - debit;
  }
  const refund = value.currentCount - targetCount;
  return value.currentConstruction <= Number.MAX_SAFE_INTEGER - refund &&
    value.constructionAfter === value.currentConstruction + refund;
}

/** Reads one same-session, same-revision material proof from the Rust owner. */
export async function readVerifiedNativeConstructionStackContext(
  bridge: NativeConstructionStackBridge | null,
  identity: NativeConstructionStackIdentity,
  entityId: string,
  targetCount: number,
): Promise<NativeConstructionStackContext | null> {
  const reader = bridge?.getNativeCoreConstructionStackContext;
  if (typeof reader !== "function" || !validLogicalId(identity.sessionId, 128) ||
      !validLogicalId(identity.runId, 128) || !safeNonnegativeInteger(identity.revision) ||
      !validLogicalId(identity.registryFingerprint) || !validOpaqueId(entityId) ||
      !safePositiveInteger(targetCount)) return null;
  try {
    const value = await reader({
      sessionId: identity.sessionId,
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      entityId,
      targetCount,
    });
    return validContext(value, identity, entityId, targetCount) ? value : null;
  } catch {
    return null;
  }
}

/** Builds only the exact inventory adjustment + machineCount command proved by Rust. */
export function createNativeProjectedOrdinaryBuildingStackCommand(
  context: NativeConstructionStackContext,
): SimulationCommandPatch | null {
  const identity: NativeConstructionStackIdentity = {
    sessionId: context.sessionId,
    runId: "validation",
    revision: context.revision,
    registryFingerprint: context.registryFingerprint,
  };
  if (!validContext(context, identity, context.entityId, context.targetCount) ||
      !context.support.supported || !context.buildingId || context.constructionAfter === null) {
    return null;
  }
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
    topLevelChanges: [{
      path: ["construction", context.buildingId],
      operation: "set",
      value: context.constructionAfter,
    }],
    changedEntities: [{
      id: context.entityId,
      changes: [{ path: ["machineCount"], operation: "set", value: context.targetCount }],
    }],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}
