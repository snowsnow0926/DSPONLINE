import type {
  DesktopNativeCoreBlueprintCaptureContextRequest,
  DesktopNativeCoreBlueprintCaptureUnsupportedReason,
} from "../desktop";
import type { NativeBlueprintWorkspaceIdentity } from "./nativeBlueprintWorkspaceStore";

const UTF8_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const EXPECTED_BLUEPRINT_ID = /^blueprint_(0|[1-9][0-9]*)$/;
const EXPECTED_BLUEPRINT_NAME = /^蓝图 [0-9]{2,}$/u;
const MAX_PROJECTION_BYTES = 1_048_576;
const MAX_SELECTION_ENTITY_IDS = 512;
const SUPPORT_REASONS = new Set<DesktopNativeCoreBlueprintCaptureUnsupportedReason>([
  "selection-conflict",
  "unsupported-active-planet",
  "unsupported-blueprint-domain",
  "catalog-incomplete",
  "position-overlap",
  "library-full",
  "next-id-exhausted",
]);

export interface NativeBlueprintCaptureSelectionBinding extends NativeBlueprintWorkspaceIdentity {
  readonly activePlanetId: string;
  readonly entityIds: readonly string[];
}

export type NativeBlueprintCaptureSupportReason =
  DesktopNativeCoreBlueprintCaptureUnsupportedReason;

export interface NativeBlueprintCaptureContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly projectionType: "blueprint-capture-context-v1";
  readonly source: "native-core";
  readonly revision: number;
  readonly stateVersion: 47;
  readonly registryFingerprint: string;
  readonly request: Readonly<
    Omit<DesktopNativeCoreBlueprintCaptureContextRequest, "sessionId" | "entityIds"> & {
      readonly entityIds: readonly string[];
    }
  >;
  readonly activePlanetId: string;
  readonly support: Readonly<{
    supported: boolean;
    reason: NativeBlueprintCaptureSupportReason | null;
  }>;
  readonly expectedBlueprintId: string | null;
  readonly expectedBlueprintName: string | null;
  readonly expectedBlueprintRevision: 1 | null;
  readonly limits: Readonly<{
    selectionEntityIds: 512;
    blueprintEntities: 512;
    blueprintBelts: 1_024;
    opaqueIdBytes: 512;
    projectionBytes: 1_048_576;
  }>;
}

export interface NativeBlueprintCaptureContextBridge {
  getNativeCoreBlueprintCaptureContext?(
    request: DesktopNativeCoreBlueprintCaptureContextRequest,
  ): Promise<unknown>;
}

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

function safeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validLogicalId(value: unknown, maximumLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    LOGICAL_ID.test(value);
}

function wellFormedUnicode(value: string): boolean {
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

function validOpaqueText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && wellFormedUnicode(value) &&
    UTF8_ENCODER.encode(value).byteLength <= maximumBytes && !CONTROL_CHARACTER.test(value);
}

function validOrderedEntityIds(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SELECTION_ENTITY_IDS) {
    return false;
  }
  const ids = new Set<string>();
  for (const id of value) {
    if (!validOpaqueText(id, 512) || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function validExpectedBlueprintId(value: unknown): value is string {
  if (!validOpaqueText(value, 512)) return false;
  const match = EXPECTED_BLUEPRINT_ID.exec(value);
  if (!match) return false;
  const suffix = Number(match[1]);
  return Number.isSafeInteger(suffix) && suffix >= 0 && suffix < Number.MAX_SAFE_INTEGER;
}

function validExpectedBlueprintName(value: unknown): value is string {
  return validOpaqueText(value, 256) && EXPECTED_BLUEPRINT_NAME.test(value);
}

function projectionFitsByteBudget(value: unknown): boolean {
  try {
    return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength <= MAX_PROJECTION_BYTES;
  } catch {
    return false;
  }
}

function validSelectionForIdentity(
  identity: NativeBlueprintWorkspaceIdentity,
  selection: NativeBlueprintCaptureSelectionBinding,
): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    safeNonnegativeInteger(identity.revision) && identity.revision < Number.MAX_SAFE_INTEGER &&
    validLogicalId(identity.registryFingerprint, 256) &&
    selection.sessionId === identity.sessionId && selection.runId === identity.runId &&
    selection.revision === identity.revision &&
    selection.registryFingerprint === identity.registryFingerprint &&
    validOpaqueText(selection.activePlanetId, 512) && validOrderedEntityIds(selection.entityIds);
}

function validLimits(value: unknown): value is NativeBlueprintCaptureContext["limits"] {
  return isRecord(value) && hasExactKeys(value, [
    "selectionEntityIds",
    "blueprintEntities",
    "blueprintBelts",
    "opaqueIdBytes",
    "projectionBytes",
  ]) && value.selectionEntityIds === 512 && value.blueprintEntities === 512 &&
    value.blueprintBelts === 1_024 && value.opaqueIdBytes === 512 &&
    value.projectionBytes === MAX_PROJECTION_BYTES;
}

function validContext(
  value: unknown,
  identity: NativeBlueprintWorkspaceIdentity,
  selection: NativeBlueprintCaptureSelectionBinding,
): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "projectionType",
    "source",
    "revision",
    "stateVersion",
    "registryFingerprint",
    "request",
    "activePlanetId",
    "support",
    "expectedBlueprintId",
    "expectedBlueprintName",
    "expectedBlueprintRevision",
    "limits",
  ]) || value.schemaVersion !== 1 || value.projectionType !== "blueprint-capture-context-v1" ||
      value.source !== "native-core" || value.revision !== identity.revision ||
      value.stateVersion !== 47 || value.registryFingerprint !== identity.registryFingerprint ||
      value.activePlanetId !== selection.activePlanetId || !isRecord(value.request) ||
      !hasExactKeys(value.request, [
        "expectedRevision",
        "expectedRegistryFingerprint",
        "entityIds",
      ]) || value.request.expectedRevision !== identity.revision ||
      value.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
      !validOrderedEntityIds(value.request.entityIds) ||
      !sameOrderedIds(value.request.entityIds, selection.entityIds) ||
      !isRecord(value.support) || !hasExactKeys(value.support, ["supported", "reason"]) ||
      typeof value.support.supported !== "boolean" || !validLimits(value.limits)) return false;

  const reason = value.support.reason;
  if (reason !== null && (typeof reason !== "string" || !SUPPORT_REASONS.has(
    reason as NativeBlueprintCaptureSupportReason,
  ))) return false;
  if (value.support.supported) {
    return reason === null && validExpectedBlueprintId(value.expectedBlueprintId) &&
      validExpectedBlueprintName(value.expectedBlueprintName) && value.expectedBlueprintRevision === 1;
  }
  return reason !== null && value.expectedBlueprintId === null &&
    value.expectedBlueprintName === null && value.expectedBlueprintRevision === null;
}

export function nativeBlueprintCaptureContextSupportsCommand(
  value: unknown,
): value is NativeBlueprintCaptureContext {
  return isRecord(value) && hasExactKeys(value, [
    "sessionId",
    "runId",
    "schemaVersion",
    "projectionType",
    "source",
    "revision",
    "stateVersion",
    "registryFingerprint",
    "request",
    "activePlanetId",
    "support",
    "expectedBlueprintId",
    "expectedBlueprintName",
    "expectedBlueprintRevision",
    "limits",
  ]) && validLogicalId(value.sessionId, 128) && validLogicalId(value.runId, 128) &&
    value.schemaVersion === 1 && value.projectionType === "blueprint-capture-context-v1" &&
    value.source === "native-core" && safeNonnegativeInteger(value.revision) &&
    value.revision < Number.MAX_SAFE_INTEGER && value.stateVersion === 47 &&
    validLogicalId(value.registryFingerprint, 256) && validOpaqueText(value.activePlanetId, 512) &&
    isRecord(value.request) && hasExactKeys(value.request, [
      "expectedRevision",
      "expectedRegistryFingerprint",
      "entityIds",
    ]) && value.request.expectedRevision === value.revision &&
    value.request.expectedRegistryFingerprint === value.registryFingerprint &&
    validOrderedEntityIds(value.request.entityIds) && isRecord(value.support) &&
    hasExactKeys(value.support, ["supported", "reason"]) &&
    value.support.supported === true && value.support.reason === null &&
    validExpectedBlueprintId(value.expectedBlueprintId) &&
    validExpectedBlueprintName(value.expectedBlueprintName) &&
    value.expectedBlueprintRevision === 1 && validLimits(value.limits) &&
    projectionFitsByteBudget(value);
}

/** Reads one same-revision Rust proof without exposing entity bodies or allocator state. */
export async function readVerifiedNativeBlueprintCaptureContext(
  bridge: NativeBlueprintCaptureContextBridge | null,
  identity: NativeBlueprintWorkspaceIdentity,
  selection: NativeBlueprintCaptureSelectionBinding,
): Promise<NativeBlueprintCaptureContext | null> {
  const reader = bridge?.getNativeCoreBlueprintCaptureContext;
  if (typeof reader !== "function" || !validSelectionForIdentity(identity, selection)) return null;
  try {
    const value = await reader({
      sessionId: identity.sessionId,
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      entityIds: [...selection.entityIds],
    });
    if (!validContext(value, identity, selection) || !projectionFitsByteBudget(value)) return null;
    const request = value.request as NativeBlueprintCaptureContext["request"];
    const support = value.support as NativeBlueprintCaptureContext["support"];
    const limits = value.limits as NativeBlueprintCaptureContext["limits"];
    return Object.freeze({
      sessionId: identity.sessionId,
      runId: identity.runId,
      schemaVersion: 1 as const,
      projectionType: "blueprint-capture-context-v1" as const,
      source: "native-core" as const,
      revision: identity.revision,
      stateVersion: 47 as const,
      registryFingerprint: identity.registryFingerprint,
      request: Object.freeze({ ...request, entityIds: Object.freeze([...request.entityIds]) }),
      activePlanetId: value.activePlanetId as string,
      support: Object.freeze({ ...support }),
      expectedBlueprintId: value.expectedBlueprintId as string | null,
      expectedBlueprintName: value.expectedBlueprintName as string | null,
      expectedBlueprintRevision: value.expectedBlueprintRevision as 1 | null,
      limits: Object.freeze({ ...limits }),
    });
  } catch {
    return null;
  }
}
