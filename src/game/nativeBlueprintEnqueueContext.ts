import type {
  DesktopNativeCoreBlueprintEnqueueContextRequest,
  DesktopNativeCoreBlueprintEnqueueUnsupportedReason,
} from "../desktop";
import type {
  NativeBlueprintEnqueueSelectionBinding,
  NativeBlueprintWorkspaceIdentity,
} from "./nativeBlueprintWorkspaceStore";

const UTF8_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const QUEUE_ID = /^construction_(0|[1-9][0-9]*)$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const SUPPORT_REASONS = new Set<DesktopNativeCoreBlueprintEnqueueUnsupportedReason>([
  "queue-full",
  "next-id-exhausted",
  "queue-id-collision",
  "unsupported-blueprint-domain",
  "unsupported-active-planet",
  "unsupported-existing-queue-domain",
  "version-conflict",
]);

export type NativeBlueprintEnqueueSupportReason =
  DesktopNativeCoreBlueprintEnqueueUnsupportedReason;

export interface NativeBlueprintEnqueueContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly projectionType: "blueprint-enqueue-context-v1";
  readonly source: "native-core";
  readonly revision: number;
  readonly stateVersion: 47;
  readonly registryFingerprint: string;
  readonly request: Readonly<Omit<DesktopNativeCoreBlueprintEnqueueContextRequest, "sessionId">>;
  readonly activePlanetId: string;
  readonly support: Readonly<{
    supported: boolean;
    reason: NativeBlueprintEnqueueSupportReason | null;
  }>;
  readonly expectedQueueId: string | null;
  readonly limits: Readonly<{
    projectionBytes: 1_048_576;
  }>;
}

export interface NativeBlueprintEnqueueContextBridge {
  getNativeCoreBlueprintEnqueueContext?(request: DesktopNativeCoreBlueprintEnqueueContextRequest): Promise<unknown>;
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

function validQueueId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = QUEUE_ID.exec(value);
  if (!match) return false;
  const suffix = Number(match[1]);
  return Number.isSafeInteger(suffix) && suffix >= 0 && suffix < Number.MAX_SAFE_INTEGER;
}

function validSelectionForIdentity(
  identity: NativeBlueprintWorkspaceIdentity,
  selection: NativeBlueprintEnqueueSelectionBinding,
): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    safeNonnegativeInteger(identity.revision) &&
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
  selection: NativeBlueprintEnqueueSelectionBinding,
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
    "expectedQueueId",
    "limits",
  ]) || value.schemaVersion !== 1 ||
      value.projectionType !== "blueprint-enqueue-context-v1" ||
      value.source !== "native-core" || value.revision !== identity.revision ||
      value.stateVersion !== 47 || value.registryFingerprint !== identity.registryFingerprint ||
      !validOpaqueText(value.activePlanetId, 512) || !isRecord(value.request) ||
      !hasExactKeys(value.request, [
        "expectedRevision",
        "expectedRegistryFingerprint",
        "blueprintId",
        "blueprintRevision",
      ]) || value.request.expectedRevision !== identity.revision ||
      value.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
      value.request.blueprintId !== selection.blueprintId ||
      value.request.blueprintRevision !== selection.currentRowRevision ||
      !isRecord(value.support) ||
      !hasExactKeys(value.support, ["supported", "reason"]) ||
      typeof value.support.supported !== "boolean" ||
      !isRecord(value.limits) ||
      !hasExactKeys(value.limits, ["projectionBytes"]) ||
      value.limits.projectionBytes !== 1_048_576) return false;

  const reason = value.support.reason;
  if (reason !== null &&
      (typeof reason !== "string" || !SUPPORT_REASONS.has(
        reason as NativeBlueprintEnqueueSupportReason,
      ))) return false;
  return value.support.supported
    ? reason === null && validQueueId(value.expectedQueueId)
    : reason !== null && value.expectedQueueId === null;
}

export function nativeBlueprintEnqueueContextSupportsCommand(
  value: unknown,
): value is NativeBlueprintEnqueueContext {
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
    "expectedQueueId",
    "limits",
  ]) || !validLogicalId(value.sessionId, 128) || !validLogicalId(value.runId, 128) ||
      value.schemaVersion !== 1 || value.projectionType !== "blueprint-enqueue-context-v1" ||
      value.source !== "native-core" || !safeNonnegativeInteger(value.revision) ||
      value.revision >= Number.MAX_SAFE_INTEGER || value.stateVersion !== 47 ||
      !validLogicalId(value.registryFingerprint, 256) ||
      !validOpaqueText(value.activePlanetId, 512) || !isRecord(value.request) ||
      !hasExactKeys(value.request, [
        "expectedRevision",
        "expectedRegistryFingerprint",
        "blueprintId",
        "blueprintRevision",
      ]) || value.request.expectedRevision !== value.revision ||
      value.request.expectedRegistryFingerprint !== value.registryFingerprint ||
      !validOpaqueText(value.request.blueprintId, 512) ||
      !safeNonnegativeInteger(value.request.blueprintRevision) ||
      value.request.blueprintRevision < 1 || !isRecord(value.support) ||
      !hasExactKeys(value.support, ["supported", "reason"]) ||
      value.support.supported !== true || value.support.reason !== null ||
      !validQueueId(value.expectedQueueId) || !isRecord(value.limits) ||
      !hasExactKeys(value.limits, ["projectionBytes"]) ||
      value.limits.projectionBytes !== 1_048_576) return false;
  return true;
}

/**
 * Reads the position-independent Rust enqueue proof at the latest authority
 * revision. The earlier workspace selection contributes only a stable row
 * identity; revision, active planet, support and expected queue ID are never
 * inferred by the renderer.
 */
export async function readVerifiedNativeBlueprintEnqueueContext(
  bridge: NativeBlueprintEnqueueContextBridge | null,
  identity: NativeBlueprintWorkspaceIdentity,
  selection: NativeBlueprintEnqueueSelectionBinding,
): Promise<NativeBlueprintEnqueueContext | null> {
  const reader = bridge?.getNativeCoreBlueprintEnqueueContext;
  if (typeof reader !== "function" || !validSelectionForIdentity(identity, selection)) return null;
  try {
    const value = await reader({
      sessionId: identity.sessionId,
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      blueprintId: selection.blueprintId,
      blueprintRevision: selection.currentRowRevision,
    });
    if (!validContext(value, identity, selection)) return null;
    const request = value.request as NativeBlueprintEnqueueContext["request"];
    const support = value.support as NativeBlueprintEnqueueContext["support"];
    const limits = value.limits as NativeBlueprintEnqueueContext["limits"];
    return Object.freeze({
      sessionId: identity.sessionId,
      runId: identity.runId,
      schemaVersion: 1 as const,
      projectionType: "blueprint-enqueue-context-v1" as const,
      source: "native-core" as const,
      revision: identity.revision,
      stateVersion: 47 as const,
      registryFingerprint: identity.registryFingerprint,
      request: Object.freeze({ ...request }),
      activePlanetId: value.activePlanetId as string,
      support: Object.freeze({ ...support }),
      expectedQueueId: value.expectedQueueId as string | null,
      limits: Object.freeze({ ...limits }),
    });
  } catch {
    return null;
  }
}
