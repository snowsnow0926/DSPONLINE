import type {
  DesktopNativeCoreConstructionBeltPlacementContextResult,
  DesktopNativeCoreConstructionBeltPlacementContextRequest,
} from "../desktop";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { BeltConnection } from "./types";

const MAX_OPAQUE_ID_BYTES = 512;
const TEXT_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const NEXT_BELT_ID = /^belt_(0|[1-9][0-9]*)$/;
const CONSTRUCTION_BY_TIER = Object.freeze({
  1: "conveyor_belt_mk1",
  2: "conveyor_belt_mk2",
  3: "conveyor_belt_mk3",
} as const);
const SUPPORT_REASONS = new Set([
  "unsupported-active-planet",
  "invalid-lanes",
  "unsupported-belt-tier",
  "missing-construction-definition",
  "technology-locked",
  "unknown-item",
  "insufficient-inventory",
  "same-endpoint",
  "source-not-found",
  "target-not-found",
  "not-active-planet",
  "interaction-locked",
  "unsupported-source-domain",
  "unsupported-target-domain",
  "source-not-configured",
  "target-not-configured",
  "matching-route-exists",
  "next-id-exhausted",
  "next-id-collision",
  "invalid-default-settings",
] as const);
const ROUTE_MODES = new Set(["auto", "bezier", "upper", "lower"] as const);
const TEMPLATE_KEYS = new Set([
  "id",
  "planetId",
  "source",
  "target",
  "itemId",
  "lanes",
  "tier",
  "sorterTier",
  "progress",
  "priority",
  "stackSize",
  "monitorEnabled",
  "totalTransferred",
  "congestion",
  "lastFlow",
  "routeMode",
]);

export interface NativeConstructionBeltPlacementIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeConstructionBeltPlacementBridge {
  getNativeCoreConstructionBeltPlacementContext?(
    request: DesktopNativeCoreConstructionBeltPlacementContextRequest,
  ): Promise<unknown>;
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

function validRequestEcho(
  value: unknown,
  identity: NativeConstructionBeltPlacementIdentity,
  request: Omit<DesktopNativeCoreConstructionBeltPlacementContextRequest, "sessionId">,
): boolean {
  return isRecord(value) && Object.keys(value).length === 7 &&
    value.expectedRevision === identity.revision &&
    value.expectedRegistryFingerprint === identity.registryFingerprint &&
    value.sourceId === request.sourceId && value.targetId === request.targetId &&
    value.itemId === request.itemId && value.tier === request.tier && value.lanes === request.lanes;
}

function validTemplate(
  value: unknown,
  context: DesktopNativeCoreConstructionBeltPlacementContextResult,
): value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== TEMPLATE_KEYS.size ||
      Object.keys(value).some((key) => !TEMPLATE_KEYS.has(key)) ||
      value.id !== context.nextBeltId || value.planetId !== context.activePlanetId ||
      value.source !== context.request.sourceId || value.target !== context.request.targetId ||
      value.itemId !== context.request.itemId || value.lanes !== context.request.lanes ||
      value.tier !== context.request.tier || value.sorterTier !== Math.min(3, context.request.tier) ||
      value.progress !== 0 || value.priority !== 1 ||
      value.stackSize !== 1 && value.stackSize !== 2 && value.stackSize !== 4 ||
      value.monitorEnabled !== false || value.totalTransferred !== 0 ||
      value.congestion !== 0 || value.lastFlow !== 0 ||
      typeof value.routeMode !== "string" ||
      !ROUTE_MODES.has(value.routeMode as "auto" | "bezier" | "upper" | "lower")) return false;
  return true;
}

function validContext(
  value: unknown,
  identity: NativeConstructionBeltPlacementIdentity,
  request: Omit<DesktopNativeCoreConstructionBeltPlacementContextRequest, "sessionId">,
): value is DesktopNativeCoreConstructionBeltPlacementContextResult {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      value.projectionType !== "construction-belt-placement-context-v1" ||
      value.source !== "native-core" || value.stateVersion !== 47 ||
      value.revision !== identity.revision ||
      value.registryFingerprint !== identity.registryFingerprint ||
      !validOpaqueId(value.activePlanetId) || !validRequestEcho(value.request, identity, request) ||
      !isRecord(value.support) || typeof value.support.supported !== "boolean" ||
      !isRecord(value.limits) || value.limits.projectionBytes !== 1_048_576) return false;

  const reason = value.support.reason;
  if (reason !== null && (typeof reason !== "string" || !SUPPORT_REASONS.has(
    reason as (typeof SUPPORT_REASONS extends Set<infer T> ? T : never),
  ))) return false;

  if (!value.support.supported) {
    return reason !== null && value.placement === null;
  }
  if (reason !== null || request.tier !== 1 && request.tier !== 2 && request.tier !== 3 ||
      !safeNonnegativeInteger(request.lanes) || request.lanes < 1 || request.lanes > 4096 ||
      value.constructionId !== CONSTRUCTION_BY_TIER[request.tier] ||
      !safeNonnegativeInteger(value.available) || value.available < request.lanes ||
      !safeNonnegativeInteger(value.appendBeltIndex) || !validLogicalId(value.nextBeltId) ||
      !isRecord(value.placement) ||
      value.placement.remainingConstruction !== value.available - request.lanes ||
      !safeNonnegativeInteger(value.placement.nextIdAfterPlacement)) return false;

  const idMatch = NEXT_BELT_ID.exec(value.nextBeltId);
  if (!idMatch) return false;
  const nextId = Number(idMatch[1]);
  if (!safeNonnegativeInteger(nextId) || nextId >= Number.MAX_SAFE_INTEGER ||
      value.placement.nextIdAfterPlacement !== nextId + 1) return false;
  return validTemplate(value.placement.beltTemplate, value as unknown as DesktopNativeCoreConstructionBeltPlacementContextResult);
}

/** Reads one bounded, same-revision belt placement capability from Rust. */
export async function readVerifiedNativeConstructionBeltPlacementContext(
  bridge: NativeConstructionBeltPlacementBridge | null,
  identity: NativeConstructionBeltPlacementIdentity,
  request: Omit<DesktopNativeCoreConstructionBeltPlacementContextRequest, "sessionId" | "expectedRevision" | "expectedRegistryFingerprint">,
): Promise<DesktopNativeCoreConstructionBeltPlacementContextResult | null> {
  const reader = bridge?.getNativeCoreConstructionBeltPlacementContext;
  if (typeof reader !== "function" || !validLogicalId(identity.sessionId, 128) ||
      !validLogicalId(identity.runId, 128) || !safeNonnegativeInteger(identity.revision) ||
      !validLogicalId(identity.registryFingerprint) || !validOpaqueId(request.sourceId) ||
      !validOpaqueId(request.targetId) || !validOpaqueId(request.itemId) ||
      request.tier !== 1 && request.tier !== 2 && request.tier !== 3 ||
      !safeNonnegativeInteger(request.lanes) || request.lanes < 1 || request.lanes > 4096) return null;
  const completeRequest = {
    ...request,
    expectedRevision: identity.revision,
    expectedRegistryFingerprint: identity.registryFingerprint,
  };
  try {
    const value = await reader({ sessionId: identity.sessionId, ...completeRequest });
    return validContext(value, identity, completeRequest) ? value : null;
  } catch {
    return null;
  }
}

/** Builds the sole exact durable command admitted by the Rust capability. */
export function createNativeProjectedOrdinaryBeltPlacementCommand(
  context: DesktopNativeCoreConstructionBeltPlacementContextResult,
): SimulationCommandPatch | null {
  const identity = {
    sessionId: "validation",
    runId: "validation",
    revision: context.revision,
    registryFingerprint: context.registryFingerprint,
  };
  if (!validContext(context, identity, context.request) || !context.support.supported ||
      !context.constructionId || context.appendBeltIndex === null || !context.placement) return null;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
    topLevelChanges: [
      {
        path: ["construction", context.constructionId],
        operation: "set",
        value: context.placement.remainingConstruction,
      },
      {
        path: ["nextId"],
        operation: "set",
        value: context.placement.nextIdAfterPlacement,
      },
    ],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [{
      index: context.appendBeltIndex,
      value: { ...context.placement.beltTemplate } as unknown as BeltConnection,
    }],
    removedBeltIds: [],
  };
}
