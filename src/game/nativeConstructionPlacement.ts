import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";
import type { FactoryEntity } from "./types";

const MAX_SAFE_QUANTITY = Number.MAX_SAFE_INTEGER;
const MAX_OPAQUE_ID_BYTES = 512;
const TEXT_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const NEXT_ENTITY_ID = /^entity_(0|[1-9][0-9]*)$/;
const SUPPORT_REASONS = new Set([
  "unknown-building",
  "missing-construction-definition",
  "technology-locked",
  "unsupported-building-kind",
  "unsupported-building-domain",
  "unsupported-active-planet",
  "inventory-empty",
  "next-id-exhausted",
] as const);
const ENTITY_TEMPLATE_KEYS = new Set([
  "id",
  "kind",
  "planetId",
  "interactionLocked",
  "buildingId",
  "powerGridId",
  "powerPriority",
  "machineCount",
  "minerCount",
  "inputs",
  "outputs",
  "progress",
  "routingCursor",
  "utilization",
  "productionRate",
  "generationPriority",
  "powerOutputKw",
  "powerInputKw",
  "recipeId",
  "targetDysonOrbitId",
  "distributionMode",
  "fuelRemainingMj",
  "storedEnergyMj",
  "energyMode",
]);

export type NativeConstructionPlacementSupportReason =
  | "unknown-building"
  | "missing-construction-definition"
  | "technology-locked"
  | "unsupported-building-kind"
  | "unsupported-building-domain"
  | "unsupported-active-planet"
  | "inventory-empty"
  | "next-id-exhausted";

export interface NativeConstructionPlacementIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeConstructionPlacementContext {
  readonly schemaVersion: 1;
  readonly projectionType: "construction-placement-context-v1";
  readonly source: "native-core";
  readonly revision: number;
  readonly stateVersion: 47;
  readonly registryFingerprint: string;
  readonly request: Readonly<{
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    buildingId: string;
  }>;
  readonly activePlanetId: string;
  readonly available: number;
  readonly appendEntityIndex: number;
  readonly nextEntityId: string;
  readonly support: Readonly<{
    supported: boolean;
    reason: NativeConstructionPlacementSupportReason | null;
  }>;
  readonly placement: Readonly<{
    remainingConstruction: number;
    nextIdAfterPlacement: number;
    entityTemplate: Readonly<Record<string, unknown>>;
  }> | null;
  readonly limits: Readonly<{ projectionBytes: number }>;
}

export interface NativeConstructionPlacementBridge {
  getNativeCoreConstructionPlacementContext(request: {
    sessionId: string;
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    buildingId: string;
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

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function validOptionalOpaqueId(value: unknown): boolean {
  return value === undefined || validOpaqueId(value);
}

function validCanonicalEntityTemplate(
  template: unknown,
  context: Pick<NativeConstructionPlacementContext, "activePlanetId" | "nextEntityId">,
  buildingId: string,
): template is Readonly<Record<string, unknown>> {
  if (!isRecord(template) || Object.prototype.hasOwnProperty.call(template, "position") ||
      Object.keys(template).some((key) => !ENTITY_TEMPLATE_KEYS.has(key)) ||
      template.id !== context.nextEntityId || template.planetId !== context.activePlanetId ||
      template.buildingId !== buildingId || template.interactionLocked !== false ||
      template.powerGridId !== "grid-a" || template.powerPriority !== 2 ||
      template.machineCount !== 1 || template.minerCount !== 0 ||
      !isEmptyRecord(template.inputs) || !isEmptyRecord(template.outputs) ||
      template.progress !== 0 || template.routingCursor !== 0 ||
      template.utilization !== 0 || template.productionRate !== 0 ||
      !["machine", "power", "storage", "splitter"].includes(String(template.kind))) {
    return false;
  }
  if (!validOptionalOpaqueId(template.recipeId) ||
      !validOptionalOpaqueId(template.targetDysonOrbitId)) return false;
  if (template.kind === "power") {
    if (!safeNonnegativeInteger(template.generationPriority) ||
        template.generationPriority < 1 || template.generationPriority > 3 ||
        template.powerOutputKw !== 0 || template.powerInputKw !== 0) return false;
  } else if (template.generationPriority !== undefined || template.powerOutputKw !== undefined ||
      template.powerInputKw !== undefined) return false;
  if (template.kind === "splitter") {
    if (template.distributionMode !== "balanced") return false;
  } else if (template.distributionMode !== undefined) return false;
  if (template.fuelRemainingMj !== undefined && template.fuelRemainingMj !== 0) return false;
  if ((template.storedEnergyMj === undefined) !== (template.energyMode === undefined) ||
      template.storedEnergyMj !== undefined && template.storedEnergyMj !== 0) return false;
  if (template.energyMode !== undefined && template.energyMode !== "auto" &&
      template.energyMode !== "charge") return false;
  return true;
}

function validContext(
  value: unknown,
  identity: NativeConstructionPlacementIdentity,
  buildingId: string,
): value is NativeConstructionPlacementContext {
  if (!validOpaqueId(buildingId) || !isRecord(value) || value.schemaVersion !== 1 ||
      value.projectionType !== "construction-placement-context-v1" ||
      value.source !== "native-core" || value.stateVersion !== 47 ||
      value.revision !== identity.revision ||
      value.registryFingerprint !== identity.registryFingerprint ||
      !validOpaqueId(value.activePlanetId) || !safeNonnegativeInteger(value.available) ||
      !safeNonnegativeInteger(value.appendEntityIndex) ||
      !validLogicalId(value.nextEntityId) || !isRecord(value.request) ||
      value.request.expectedRevision !== identity.revision ||
      value.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
      value.request.buildingId !== buildingId || !isRecord(value.support) ||
      typeof value.support.supported !== "boolean" || !isRecord(value.limits) ||
      value.limits.projectionBytes !== 1_048_576) return false;

  const supportReason = value.support.reason;
  if (supportReason !== null &&
      (typeof supportReason !== "string" || !SUPPORT_REASONS.has(
        supportReason as NativeConstructionPlacementSupportReason,
      ))) return false;
  if (!value.support.supported) return supportReason !== null && value.placement === null;
  if (supportReason !== null || !isRecord(value.placement) || value.available < 1 ||
      !safeNonnegativeInteger(value.placement.remainingConstruction) ||
      value.placement.remainingConstruction !== value.available - 1 ||
      !safeNonnegativeInteger(value.placement.nextIdAfterPlacement)) return false;

  const match = NEXT_ENTITY_ID.exec(value.nextEntityId);
  if (!match) return false;
  const nextId = Number(match[1]);
  if (!safeNonnegativeInteger(nextId) || nextId >= MAX_SAFE_QUANTITY ||
      value.placement.nextIdAfterPlacement !== nextId + 1) return false;
  return validCanonicalEntityTemplate(
    value.placement.entityTemplate,
    value as unknown as NativeConstructionPlacementContext,
    buildingId,
  );
}

/**
 * Reads one revision-bound placement capability directly from the Rust owner.
 * A renderer never derives stock, IDs, recipes, orbit defaults, or optional
 * entity fields from its stale GameState copy.
 */
export async function readVerifiedNativeConstructionPlacementContext(
  bridge: NativeConstructionPlacementBridge | null,
  identity: NativeConstructionPlacementIdentity,
  buildingId: string,
): Promise<NativeConstructionPlacementContext | null> {
  if (!bridge || !validLogicalId(identity.sessionId, 128) ||
      !validLogicalId(identity.runId, 128) || !safeNonnegativeInteger(identity.revision) ||
      !validLogicalId(identity.registryFingerprint) || !validOpaqueId(buildingId)) return null;
  try {
    const value = await bridge.getNativeCoreConstructionPlacementContext({
      sessionId: identity.sessionId,
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      buildingId,
    });
    return validContext(value, identity, buildingId) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The only renderer-owned placement fields are finite canvas coordinates.
 * Rust revalidates this complete command against the exact durable revision
 * before debiting construction stock and appending the entity atomically.
 */
export function createNativeProjectedOrdinaryBuildingPlacementCommand(
  context: NativeConstructionPlacementContext,
  position: Readonly<{ x: number; y: number }>,
): SimulationCommandPatch | null {
  const buildingId = context.request.buildingId;
  if (!validContext(context, {
    sessionId: "validation",
    runId: "validation",
    revision: context.revision,
    registryFingerprint: context.registryFingerprint,
  }, buildingId) || !context.support.supported || !context.placement ||
      !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;

  const entity = {
    ...context.placement.entityTemplate,
    position: { x: position.x, y: position.y },
  } as unknown as FactoryEntity;
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision: context.revision,
    topLevelChanges: [
      {
        path: ["construction", buildingId],
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
    addedEntities: [{ index: context.appendEntityIndex, value: entity }],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}
