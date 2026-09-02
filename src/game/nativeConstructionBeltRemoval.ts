import type {
  DesktopNativeCoreConstructionBeltRemovalContextRequest,
  DesktopNativeCoreConstructionBeltRemovalContextResult,
} from "../desktop";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

const MAX_OPAQUE_ID_BYTES = 512;
const TEXT_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const CONSTRUCTION_BY_TIER = Object.freeze({
  1: "conveyor_belt_mk1",
  2: "conveyor_belt_mk2",
  3: "conveyor_belt_mk3",
} as const);
const ROOT_KEYS = new Set([
  "schemaVersion", "projectionType", "source", "revision", "stateVersion",
  "registryFingerprint", "request", "activePlanetId", "beltId", "planetId",
  "sourceId", "targetId", "tier", "lanes", "constructionId",
  "currentConstruction", "refundAfterRemoval", "support", "limits",
]);
const SUPPORT_REASONS = new Set([
  "unsupported-active-planet", "belt-not-found", "invalid-belt", "not-active-planet",
  "unsupported-belt-domain", "unsupported-belt-tier", "missing-construction-definition",
  "source-not-found", "target-not-found", "unsupported-source-domain",
  "unsupported-target-domain", "invalid-construction-inventory", "refund-overflow",
] as const);

export interface NativeConstructionBeltRemovalIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeConstructionBeltRemovalBridge {
  getNativeCoreConstructionBeltRemovalContext?(
    request: DesktopNativeCoreConstructionBeltRemovalContextRequest,
  ): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
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

function validRequestEcho(
  value: unknown,
  identity: NativeConstructionBeltRemovalIdentity,
  beltId: string,
): boolean {
  return isRecord(value) && exactKeys(value, new Set([
    "expectedRevision", "expectedRegistryFingerprint", "beltId",
  ])) && value.expectedRevision === identity.revision &&
    value.expectedRegistryFingerprint === identity.registryFingerprint && value.beltId === beltId;
}

function validContext(
  value: unknown,
  identity: NativeConstructionBeltRemovalIdentity,
  beltId: string,
): value is DesktopNativeCoreConstructionBeltRemovalContextResult {
  if (!isRecord(value) || !exactKeys(value, ROOT_KEYS) || value.schemaVersion !== 1 ||
      value.projectionType !== "construction-belt-removal-context-v1" ||
      value.source !== "native-core" || value.stateVersion !== 47 ||
      value.revision !== identity.revision || value.registryFingerprint !== identity.registryFingerprint ||
      !validRequestEcho(value.request, identity, beltId) || value.beltId !== beltId ||
      !validOpaqueId(value.activePlanetId) || !isRecord(value.support) ||
      !exactKeys(value.support, new Set(["supported", "reason"])) ||
      typeof value.support.supported !== "boolean" || !isRecord(value.limits) ||
      !exactKeys(value.limits, new Set(["projectionBytes"])) ||
      value.limits.projectionBytes !== 1_048_576) return false;
  const reason = value.support.reason;
  if (reason !== null && (typeof reason !== "string" || !SUPPORT_REASONS.has(
    reason as (typeof SUPPORT_REASONS extends Set<infer T> ? T : never),
  ))) return false;
  if (!value.support.supported) {
    return reason !== null && value.refundAfterRemoval === null;
  }
  if (reason !== null || !validOpaqueId(value.planetId) || value.planetId !== value.activePlanetId ||
      !validOpaqueId(value.sourceId) || !validOpaqueId(value.targetId) || value.sourceId === value.targetId ||
      value.tier !== 1 && value.tier !== 2 && value.tier !== 3 ||
      !safeNonnegativeInteger(value.lanes) || value.lanes < 1 ||
      value.constructionId !== CONSTRUCTION_BY_TIER[value.tier] ||
      !safeNonnegativeInteger(value.currentConstruction) ||
      !safeNonnegativeInteger(value.refundAfterRemoval) ||
      value.refundAfterRemoval !== value.currentConstruction + value.lanes) return false;
  return true;
}

/** Reads one bounded, same-revision ordinary-belt recycling capability from Rust. */
export async function readVerifiedNativeConstructionBeltRemovalContext(
  bridge: NativeConstructionBeltRemovalBridge | null,
  identity: NativeConstructionBeltRemovalIdentity,
  request: Omit<DesktopNativeCoreConstructionBeltRemovalContextRequest, "sessionId" | "expectedRevision" | "expectedRegistryFingerprint">,
): Promise<DesktopNativeCoreConstructionBeltRemovalContextResult | null> {
  const reader = bridge?.getNativeCoreConstructionBeltRemovalContext;
  if (typeof reader !== "function" || !validLogicalId(identity.sessionId, 128) ||
      !validLogicalId(identity.runId, 128) || !safeNonnegativeInteger(identity.revision) ||
      !validLogicalId(identity.registryFingerprint) || !validOpaqueId(request.beltId)) return null;
  const completeRequest = {
    beltId: request.beltId,
    expectedRevision: identity.revision,
    expectedRegistryFingerprint: identity.registryFingerprint,
  };
  try {
    const value = await reader({ sessionId: identity.sessionId, ...completeRequest });
    return validContext(value, identity, request.beltId) ? value : null;
  } catch {
    return null;
  }
}

/** Builds the only durable command admitted by the Rust removal capability. */
export function createNativeProjectedOrdinaryBeltRemovalCommand(
  context: DesktopNativeCoreConstructionBeltRemovalContextResult,
): SimulationCommandPatch | null {
  const identity = {
    sessionId: "validation",
    runId: "validation",
    revision: context.revision,
    registryFingerprint: context.registryFingerprint,
  };
  if (!validContext(context, identity, context.beltId) || !context.support.supported ||
      !context.constructionId || context.refundAfterRemoval === null) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
    topLevelChanges: [{
      path: ["construction", context.constructionId],
      operation: "set",
      value: context.refundAfterRemoval,
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [context.beltId],
  };
}
