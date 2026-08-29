import type {
  DesktopNativeCoreConstructionBeltLaneContextRequest,
  DesktopNativeCoreConstructionBeltLaneContextResult,
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
  "sourceId", "targetId", "itemId", "tier", "currentLanes", "targetLanes",
  "constructionId", "currentConstruction", "laneDelta",
  "constructionAfterAdjustment", "support", "limits",
]);
const SUPPORT_REASONS = new Set([
  "invalid-target-lanes", "unsupported-active-planet", "belt-not-found", "invalid-belt",
  "not-active-planet", "unsupported-item", "unsupported-belt-domain", "unsupported-belt-tier",
  "missing-construction-definition", "unchanged-lanes", "target-lanes-exceed-limit",
  "source-not-found", "target-not-found", "unsupported-source-domain", "unsupported-target-domain",
  "invalid-construction-inventory", "insufficient-construction", "refund-overflow",
] as const);

export interface NativeConstructionBeltLaneIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeConstructionBeltLaneBridge {
  getNativeCoreConstructionBeltLaneContext?(
    request: DesktopNativeCoreConstructionBeltLaneContextRequest,
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

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validLogicalId(value: unknown, maximumLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength && LOGICAL_ID.test(value);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    TEXT_ENCODER.encode(value).byteLength <= MAX_OPAQUE_ID_BYTES &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validRequestEcho(
  value: unknown,
  identity: NativeConstructionBeltLaneIdentity,
  beltId: string,
  targetLanes: number,
): boolean {
  return isRecord(value) && exactKeys(value, new Set([
    "expectedRevision", "expectedRegistryFingerprint", "beltId", "targetLanes",
  ])) && value.expectedRevision === identity.revision &&
    value.expectedRegistryFingerprint === identity.registryFingerprint &&
    value.beltId === beltId && value.targetLanes === targetLanes;
}

function validContext(
  value: unknown,
  identity: NativeConstructionBeltLaneIdentity,
  beltId: string,
  targetLanes: number,
): value is DesktopNativeCoreConstructionBeltLaneContextResult {
  if (!isRecord(value) || !exactKeys(value, ROOT_KEYS) || value.schemaVersion !== 1 ||
      value.projectionType !== "construction-belt-lane-context-v1" || value.source !== "native-core" ||
      value.stateVersion !== 47 || value.revision !== identity.revision ||
      value.registryFingerprint !== identity.registryFingerprint ||
      !validRequestEcho(value.request, identity, beltId, targetLanes) || value.beltId !== beltId ||
      value.targetLanes !== targetLanes || !validOpaqueId(value.activePlanetId) ||
      !isRecord(value.support) || !exactKeys(value.support, new Set(["supported", "reason"])) ||
      typeof value.support.supported !== "boolean" || !isRecord(value.limits) ||
      !exactKeys(value.limits, new Set(["maxPlayerLanes", "projectionBytes"])) ||
      value.limits.maxPlayerLanes !== 4096 || value.limits.projectionBytes !== 1_048_576) return false;
  const reason = value.support.reason;
  if (reason !== null && (typeof reason !== "string" || !SUPPORT_REASONS.has(
    reason as (typeof SUPPORT_REASONS extends Set<infer T> ? T : never),
  ))) return false;
  if (!value.support.supported) {
    return reason !== null && value.laneDelta === null && value.constructionAfterAdjustment === null;
  }
  if (reason !== null || !validOpaqueId(value.planetId) || value.planetId !== value.activePlanetId ||
      !validOpaqueId(value.sourceId) || !validOpaqueId(value.targetId) || value.sourceId === value.targetId ||
      !validOpaqueId(value.itemId) || value.tier !== 1 && value.tier !== 2 && value.tier !== 3 ||
      !safeNonnegativeInteger(value.currentLanes) || value.currentLanes < 1 ||
      !safeNonnegativeInteger(value.targetLanes) || value.targetLanes < 1 || value.targetLanes === value.currentLanes ||
      value.constructionId !== CONSTRUCTION_BY_TIER[value.tier] ||
      !safeNonnegativeInteger(value.currentConstruction) || !safeInteger(value.laneDelta) ||
      value.laneDelta !== value.targetLanes - value.currentLanes ||
      !safeNonnegativeInteger(value.constructionAfterAdjustment) ||
      value.constructionAfterAdjustment !== value.currentConstruction - value.laneDelta) return false;
  return true;
}

export async function readVerifiedNativeConstructionBeltLaneContext(
  bridge: NativeConstructionBeltLaneBridge | null,
  identity: NativeConstructionBeltLaneIdentity,
  request: Omit<DesktopNativeCoreConstructionBeltLaneContextRequest, "sessionId" | "expectedRevision" | "expectedRegistryFingerprint">,
): Promise<DesktopNativeCoreConstructionBeltLaneContextResult | null> {
  const reader = bridge?.getNativeCoreConstructionBeltLaneContext;
  if (typeof reader !== "function" || !validLogicalId(identity.sessionId, 128) ||
      !validLogicalId(identity.runId, 128) || !safeNonnegativeInteger(identity.revision) ||
      !validLogicalId(identity.registryFingerprint) || !validOpaqueId(request.beltId) ||
      !safeNonnegativeInteger(request.targetLanes)) return null;
  try {
    const value = await reader({
      sessionId: identity.sessionId,
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      beltId: request.beltId,
      targetLanes: request.targetLanes,
    });
    return validContext(value, identity, request.beltId, request.targetLanes) ? value : null;
  } catch {
    return null;
  }
}

export function createNativeProjectedOrdinaryBeltLaneCommand(
  context: DesktopNativeCoreConstructionBeltLaneContextResult,
): SimulationCommandPatch | null {
  const identity = {
    sessionId: "validation",
    runId: "validation",
    revision: context.revision,
    registryFingerprint: context.registryFingerprint,
  };
  if (!validContext(context, identity, context.beltId, context.targetLanes) ||
      !context.support.supported || !context.constructionId ||
      context.constructionAfterAdjustment === null) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
    topLevelChanges: [{
      path: ["construction", context.constructionId],
      operation: "set",
      value: context.constructionAfterAdjustment,
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [{
      id: context.beltId,
      changes: [{ path: ["lanes"], operation: "set", value: context.targetLanes }],
    }],
    addedBelts: [],
    removedBeltIds: [],
  };
}
