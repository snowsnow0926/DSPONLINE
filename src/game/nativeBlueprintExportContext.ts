import type {
  DesktopNativeCoreBlueprintExportContextRequest,
  DesktopNativeCoreBlueprintExportUnsupportedReason,
} from "../desktop";
import { sha256Text } from "./payloadDigest";
import type { NativeBlueprintWorkspaceIdentity } from "./nativeBlueprintWorkspaceStore";

const UTF8_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const SHA256 = /^[a-f0-9]{64}$/;
const WINDOWS_FILE_INVALID = /[/\\<>:"|?*]/u;
const WINDOWS_RESERVED_DEVICE_BASE = /^(?:con|prn|aux|nul|(?:com|lpt)[1-9\u00b9\u00b2\u00b3])$/iu;
const MAX_BYTES = 1_048_576;
const SUPPORT_REASONS = new Set<DesktopNativeCoreBlueprintExportUnsupportedReason>([
  "version-conflict",
  "unsupported-active-planet",
  "unsupported-blueprint-domain",
  "catalog-incomplete",
  "position-overlap",
  "serialized-budget-exceeded",
]);

export interface NativeBlueprintExportBinding extends NativeBlueprintWorkspaceIdentity {
  readonly blueprintId: string;
  readonly blueprintName: string;
  readonly blueprintRevision: number;
}

export type NativeBlueprintExportSupportReason = DesktopNativeCoreBlueprintExportUnsupportedReason;

export interface NativeBlueprintExportContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly projectionType: "blueprint-export-context-v1";
  readonly source: "native-core";
  readonly revision: number;
  readonly stateVersion: 47;
  readonly registryFingerprint: string;
  readonly request: Readonly<Omit<DesktopNativeCoreBlueprintExportContextRequest, "sessionId">>;
  readonly activePlanetId: string;
  readonly support: Readonly<{
    supported: boolean;
    reason: NativeBlueprintExportSupportReason | null;
  }>;
  readonly rawExchange: string | null;
  readonly rawBytes: number | null;
  readonly rawSha256: string | null;
  readonly blueprintName: string | null;
  readonly fileNameStem: string | null;
  readonly limits: Readonly<{
    exchangeBytes: 1_048_576;
    projectionBytes: 1_048_576;
    blueprintEntities: 512;
    blueprintBelts: 1_024;
  }>;
}

export interface NativeBlueprintExportContextBridge {
  getNativeCoreBlueprintExportContext?(
    request: DesktopNativeCoreBlueprintExportContextRequest,
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

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validLogicalId(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    LOGICAL_ID.test(value);
}

function validOpaqueText(value: unknown, maximumBytes = 512): value is string {
  return typeof value === "string" && value.length > 0 && wellFormedUnicode(value) &&
    !CONTROL_CHARACTER.test(value) && UTF8_ENCODER.encode(value).byteLength <= maximumBytes;
}

function validBlueprintName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 48 &&
    wellFormedUnicode(value) && !CONTROL_CHARACTER.test(value) &&
    UTF8_ENCODER.encode(value).byteLength <= 192;
}

function validFileNameStem(value: unknown): value is string {
  if (!validOpaqueText(value, 320) || value.length > 80 || WINDOWS_FILE_INVALID.test(value) ||
      /[. ]$/u.test(value) || value === "." || value === "..") return false;
  const windowsDeviceBase = value.split(".", 1)[0].replace(/[. ]+$/u, "");
  return !WINDOWS_RESERVED_DEVICE_BASE.test(windowsDeviceBase);
}

function validBinding(binding: NativeBlueprintExportBinding): boolean {
  return validLogicalId(binding.sessionId, 128) && validLogicalId(binding.runId, 128) &&
    safeNonnegativeInteger(binding.revision) && binding.revision <= Number.MAX_SAFE_INTEGER &&
    validLogicalId(binding.registryFingerprint, 256) && validOpaqueText(binding.blueprintId) &&
    validBlueprintName(binding.blueprintName) && Number.isSafeInteger(binding.blueprintRevision) &&
    binding.blueprintRevision >= 1 && binding.blueprintRevision <= Number.MAX_SAFE_INTEGER;
}

function validLimits(value: unknown): value is NativeBlueprintExportContext["limits"] {
  return isRecord(value) && hasExactKeys(value, [
    "exchangeBytes", "projectionBytes", "blueprintEntities", "blueprintBelts",
  ]) && value.exchangeBytes === MAX_BYTES && value.projectionBytes === MAX_BYTES &&
    value.blueprintEntities === 512 && value.blueprintBelts === 1_024;
}

function projectionFitsBudget(value: unknown): boolean {
  try {
    return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength <= MAX_BYTES;
  } catch {
    return false;
  }
}

function validRawContext(value: unknown, binding: NativeBlueprintExportBinding): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "support", "rawExchange", "rawBytes",
    "rawSha256", "blueprintName", "fileNameStem", "limits",
  ]) || value.schemaVersion !== 1 || value.projectionType !== "blueprint-export-context-v1" ||
      value.source !== "native-core" || value.revision !== binding.revision ||
      value.stateVersion !== 47 || value.registryFingerprint !== binding.registryFingerprint ||
      !isRecord(value.request) || !hasExactKeys(value.request, [
        "expectedRevision", "expectedRegistryFingerprint", "blueprintId", "blueprintRevision",
      ]) || value.request.expectedRevision !== binding.revision ||
      value.request.expectedRegistryFingerprint !== binding.registryFingerprint ||
      value.request.blueprintId !== binding.blueprintId ||
      value.request.blueprintRevision !== binding.blueprintRevision ||
      !validOpaqueText(value.activePlanetId) || !isRecord(value.support) ||
      !hasExactKeys(value.support, ["supported", "reason"]) ||
      typeof value.support.supported !== "boolean" || !validLimits(value.limits) ||
      !projectionFitsBudget(value)) return false;
  const reason = value.support.reason;
  if (reason !== null && (typeof reason !== "string" || !SUPPORT_REASONS.has(
    reason as NativeBlueprintExportSupportReason,
  ))) return false;
  if (!value.support.supported) {
    return reason !== null && value.rawExchange === null && value.rawBytes === null &&
      value.rawSha256 === null && value.blueprintName === null && value.fileNameStem === null;
  }
  if (reason !== null || typeof value.rawExchange !== "string" ||
      value.rawExchange.length < 1 || !wellFormedUnicode(value.rawExchange) ||
      UTF8_ENCODER.encode(value.rawExchange).byteLength !== value.rawBytes ||
      !safeNonnegativeInteger(value.rawBytes) || value.rawBytes < 1 || value.rawBytes > MAX_BYTES ||
      typeof value.rawSha256 !== "string" || !SHA256.test(value.rawSha256) ||
      !validBlueprintName(value.blueprintName) || value.blueprintName !== binding.blueprintName ||
      !validFileNameStem(value.fileNameStem)) return false;
  return true;
}

/** Reads one immutable Rust exchange; the renderer verifies but never parses or regenerates it. */
export async function readVerifiedNativeBlueprintExportContext(
  bridge: NativeBlueprintExportContextBridge | null,
  binding: NativeBlueprintExportBinding,
): Promise<NativeBlueprintExportContext | null> {
  const reader = bridge?.getNativeCoreBlueprintExportContext;
  if (typeof reader !== "function" || !validBinding(binding)) return null;
  try {
    const value = await reader({
      sessionId: binding.sessionId,
      expectedRevision: binding.revision,
      expectedRegistryFingerprint: binding.registryFingerprint,
      blueprintId: binding.blueprintId,
      blueprintRevision: binding.blueprintRevision,
    });
    if (!validRawContext(value, binding)) return null;
    const support = value.support as NativeBlueprintExportContext["support"];
    if (support.supported) {
      const measuredSha256 = await sha256Text(value.rawExchange as string);
      if (measuredSha256 !== value.rawSha256) return null;
    }
    return Object.freeze({
      sessionId: binding.sessionId,
      runId: binding.runId,
      schemaVersion: 1 as const,
      projectionType: "blueprint-export-context-v1" as const,
      source: "native-core" as const,
      revision: binding.revision,
      stateVersion: 47 as const,
      registryFingerprint: binding.registryFingerprint,
      request: Object.freeze({ ...(value.request as NativeBlueprintExportContext["request"]) }),
      activePlanetId: value.activePlanetId as string,
      support: Object.freeze({ ...support }),
      rawExchange: value.rawExchange as string | null,
      rawBytes: value.rawBytes as number | null,
      rawSha256: value.rawSha256 as string | null,
      blueprintName: value.blueprintName as string | null,
      fileNameStem: value.fileNameStem as string | null,
      limits: Object.freeze({ ...(value.limits as NativeBlueprintExportContext["limits"]) }),
    });
  } catch {
    return null;
  }
}
