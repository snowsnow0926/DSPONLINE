import type {
  DesktopNativeCoreBlueprintDirectDeployContextRequest,
  DesktopNativeCoreBlueprintDirectDeployUnsupportedReason,
} from "../desktop";
import type {
  NativeBlueprintDirectDeploySelectionBinding,
  NativeBlueprintWorkspaceIdentity,
} from "./nativeBlueprintWorkspaceStore";

const UTF8_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_PROJECTION_BYTES = 1_048_576;
const SUPPORT_REASONS = new Set<DesktopNativeCoreBlueprintDirectDeployUnsupportedReason>([
  "next-id-exhausted",
  "unsupported-blueprint-domain",
  "unsupported-active-planet",
  "insufficient-construction-materials",
  "position-overlap",
  "version-conflict",
  "catalog-incomplete",
]);

export type NativeBlueprintDirectDeploySupportReason =
  DesktopNativeCoreBlueprintDirectDeployUnsupportedReason;

export interface NativeBlueprintDirectDeployContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly projectionType: "blueprint-direct-deploy-context-v1";
  readonly source: "native-core";
  readonly revision: number;
  readonly stateVersion: 47;
  readonly registryFingerprint: string;
  readonly request: Readonly<Omit<DesktopNativeCoreBlueprintDirectDeployContextRequest, "sessionId">>;
  readonly activePlanetId: string;
  readonly support: Readonly<{
    supported: boolean;
    reason: NativeBlueprintDirectDeploySupportReason | null;
  }>;
  readonly limits: Readonly<{
    projectionBytes: 1_048_576;
  }>;
}

export interface NativeBlueprintDirectDeployContextBridge {
  getNativeCoreBlueprintDirectDeployContext?(
    request: DesktopNativeCoreBlueprintDirectDeployContextRequest,
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

function validPosition(value: unknown): value is Readonly<{ x: number; y: number }> {
  return isRecord(value) && hasExactKeys(value, ["x", "y"]) &&
    Number.isFinite(value.x) && Number.isFinite(value.y);
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
  selection: NativeBlueprintDirectDeploySelectionBinding,
): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    safeNonnegativeInteger(identity.revision) && identity.revision < Number.MAX_SAFE_INTEGER &&
    validLogicalId(identity.registryFingerprint, 256) &&
    selection.sessionId === identity.sessionId && selection.runId === identity.runId &&
    selection.registryFingerprint === identity.registryFingerprint &&
    validOpaqueText(selection.blueprintId, 512) &&
    validOpaqueText(selection.blueprintName, 256) &&
    safeNonnegativeInteger(selection.currentRowRevision) && selection.currentRowRevision >= 1;
}

function validContext(
  value: unknown,
  identity: NativeBlueprintWorkspaceIdentity,
  selection: NativeBlueprintDirectDeploySelectionBinding,
  position: Readonly<{ x: number; y: number }>,
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
    "limits",
  ]) || value.schemaVersion !== 1 ||
      value.projectionType !== "blueprint-direct-deploy-context-v1" ||
      value.source !== "native-core" || value.revision !== identity.revision ||
      value.stateVersion !== 47 || value.registryFingerprint !== identity.registryFingerprint ||
      !validOpaqueText(value.activePlanetId, 512) || !isRecord(value.request) ||
      !hasExactKeys(value.request, [
        "expectedRevision",
        "expectedRegistryFingerprint",
        "blueprintId",
        "blueprintRevision",
        "position",
      ]) || value.request.expectedRevision !== identity.revision ||
      value.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
      value.request.blueprintId !== selection.blueprintId ||
      value.request.blueprintRevision !== selection.currentRowRevision ||
      !validPosition(value.request.position) ||
      value.request.position.x !== position.x || value.request.position.y !== position.y ||
      !isRecord(value.support) || !hasExactKeys(value.support, ["supported", "reason"]) ||
      typeof value.support.supported !== "boolean" ||
      !isRecord(value.limits) || !hasExactKeys(value.limits, ["projectionBytes"]) ||
      value.limits.projectionBytes !== MAX_PROJECTION_BYTES) return false;

  const reason = value.support.reason;
  if (reason !== null && (typeof reason !== "string" || !SUPPORT_REASONS.has(
    reason as NativeBlueprintDirectDeploySupportReason,
  ))) return false;
  return value.support.supported ? reason === null : reason !== null;
}

export function nativeBlueprintDirectDeployContextSupportsCommand(
  value: unknown,
): value is NativeBlueprintDirectDeployContext {
  if (!isRecord(value) || !hasExactKeys(value, [
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
    "limits",
  ]) || !validLogicalId(value.sessionId, 128) || !validLogicalId(value.runId, 128) ||
      value.schemaVersion !== 1 ||
      value.projectionType !== "blueprint-direct-deploy-context-v1" ||
      value.source !== "native-core" || !safeNonnegativeInteger(value.revision) ||
      value.revision >= Number.MAX_SAFE_INTEGER || value.stateVersion !== 47 ||
      !validLogicalId(value.registryFingerprint, 256) ||
      !validOpaqueText(value.activePlanetId, 512) || !isRecord(value.request) ||
      !hasExactKeys(value.request, [
        "expectedRevision",
        "expectedRegistryFingerprint",
        "blueprintId",
        "blueprintRevision",
        "position",
      ]) || value.request.expectedRevision !== value.revision ||
      value.request.expectedRegistryFingerprint !== value.registryFingerprint ||
      !validOpaqueText(value.request.blueprintId, 512) ||
      !safeNonnegativeInteger(value.request.blueprintRevision) ||
      value.request.blueprintRevision < 1 || !validPosition(value.request.position) ||
      !isRecord(value.support) || !hasExactKeys(value.support, ["supported", "reason"]) ||
      value.support.supported !== true || value.support.reason !== null ||
      !isRecord(value.limits) || !hasExactKeys(value.limits, ["projectionBytes"]) ||
      value.limits.projectionBytes !== MAX_PROJECTION_BYTES ||
      !projectionFitsByteBudget(value)) return false;
  return true;
}

/**
 * Reads the click-time Rust proof. Selection supplies only a stable row
 * identity; position, current revision, planet, materials and overlap are
 * revalidated by Rust before any durable marker can be created.
 */
export async function readVerifiedNativeBlueprintDirectDeployContext(
  bridge: NativeBlueprintDirectDeployContextBridge | null,
  identity: NativeBlueprintWorkspaceIdentity,
  selection: NativeBlueprintDirectDeploySelectionBinding,
  position: Readonly<{ x: number; y: number }>,
): Promise<NativeBlueprintDirectDeployContext | null> {
  const reader = bridge?.getNativeCoreBlueprintDirectDeployContext;
  if (typeof reader !== "function" || !validSelectionForIdentity(identity, selection) ||
      !validPosition(position)) return null;
  try {
    const value = await reader({
      sessionId: identity.sessionId,
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      blueprintId: selection.blueprintId,
      blueprintRevision: selection.currentRowRevision,
      position: { x: position.x, y: position.y },
    });
    if (!validContext(value, identity, selection, position) || !projectionFitsByteBudget(value)) {
      return null;
    }
    const request = value.request as NativeBlueprintDirectDeployContext["request"];
    const support = value.support as NativeBlueprintDirectDeployContext["support"];
    const limits = value.limits as NativeBlueprintDirectDeployContext["limits"];
    return Object.freeze({
      sessionId: identity.sessionId,
      runId: identity.runId,
      schemaVersion: 1 as const,
      projectionType: "blueprint-direct-deploy-context-v1" as const,
      source: "native-core" as const,
      revision: identity.revision,
      stateVersion: 47 as const,
      registryFingerprint: identity.registryFingerprint,
      request: Object.freeze({
        ...request,
        position: Object.freeze({ ...request.position }),
      }),
      activePlanetId: value.activePlanetId as string,
      support: Object.freeze({ ...support }),
      limits: Object.freeze({ ...limits }),
    });
  } catch {
    return null;
  }
}
