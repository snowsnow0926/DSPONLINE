import type {
  DesktopNativeCoreBlueprintImportContextRequest,
  DesktopNativeCoreBlueprintImportUnsupportedReason,
} from "../desktop";
import { sha256Text } from "./payloadDigest";
import type { NativeBlueprintWorkspaceIdentity } from "./nativeBlueprintWorkspaceStore";
import {
  NATIVE_BLUEPRINT_IMPORT_RAW_BYTES,
  validateNativeBlueprintImportRaw,
} from "./nativeBlueprintImportInput";

const UTF8_ENCODER = new TextEncoder();
const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const BLUEPRINT_ID = /^blueprint_(0|[1-9][0-9]*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_PROJECTION_BYTES = 1_048_576;
const MAX_COMMAND_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 32;
const MAX_OPAQUE_BYTES = 512;
const BLUEPRINT_KEYS = Object.freeze([
  "id", "name", "revision", "entities", "resourceAnchors", "belts", "externalPorts",
  "rotation", "mirror", "recipeOverrides",
]);
const ENTITY_REQUIRED_KEYS = Object.freeze(["key", "buildingId", "offset", "machineCount"]);
const ENTITY_KEYS = new Set([
  ...ENTITY_REQUIRED_KEYS,
  "recipeId", "targetDysonOrbitId", "storedItemId", "distributionMode", "fuelItemId",
  "energyMode", "powerGridId", "powerPriority", "generationPriority", "sprayCoaterInstalled",
  "proliferatorTier", "proliferatorMode",
]);
const BELT_REQUIRED_KEYS = Object.freeze([
  "key", "sourceKey", "targetKey", "itemId", "lanes", "tier", "priority",
]);
const BELT_KEYS = new Set([
  ...BELT_REQUIRED_KEYS,
  "sorterTier", "stackSize", "monitorEnabled", "routeMode", "routeOffsetY",
]);
const SUPPORT_REASONS = new Set<DesktopNativeCoreBlueprintImportUnsupportedReason>([
  "invalid-exchange",
  "unsupported-active-planet",
  "unsupported-blueprint-domain",
  "catalog-incomplete",
  "position-overlap",
  "library-full",
  "next-id-exhausted",
  "serialized-budget-exceeded",
]);

export type NativeBlueprintImportSupportReason = DesktopNativeCoreBlueprintImportUnsupportedReason;

export interface NativeBlueprintImportPreparedBlueprint extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly name: string;
  readonly revision: 1;
  readonly entities: readonly Readonly<Record<string, unknown>>[];
  readonly resourceAnchors: readonly [];
  readonly belts: readonly Readonly<Record<string, unknown>>[];
  readonly externalPorts: readonly [];
  readonly rotation: 0 | 90 | 180 | 270;
  readonly mirror: "none" | "horizontal";
  readonly recipeOverrides: Readonly<Record<string, string>>;
}

export interface NativeBlueprintImportPreparedIntent {
  readonly kind: "import";
  readonly sourceName: string;
  readonly blueprint: NativeBlueprintImportPreparedBlueprint;
  readonly blueprintSha256: string;
  readonly revision: number;
}

export interface NativeBlueprintImportContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly projectionType: "blueprint-import-context-v1";
  readonly source: "native-core";
  readonly revision: number;
  readonly stateVersion: 47;
  readonly registryFingerprint: string;
  readonly request: Readonly<{
    expectedRevision: number;
    expectedRegistryFingerprint: string;
    rawBytes: number;
    rawSha256: string;
  }>;
  readonly activePlanetId: string;
  readonly support: Readonly<{
    supported: boolean;
    reason: NativeBlueprintImportSupportReason | null;
  }>;
  readonly preparedIntent: NativeBlueprintImportPreparedIntent | null;
  readonly limits: Readonly<{
    rawBytes: 1_048_576;
    projectionBytes: 1_048_576;
    commandBytes: 1_048_576;
    libraryRows: 64;
    blueprintEntities: 512;
    blueprintBelts: 1_024;
  }>;
}

export interface NativeBlueprintImportContextBridge {
  getNativeCoreBlueprintImportContext?(
    request: DesktopNativeCoreBlueprintImportContextRequest,
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
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validLogicalId(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    LOGICAL_ID.test(value);
}

function validOpaqueText(value: unknown, maximumBytes = MAX_OPAQUE_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && wellFormedUnicode(value) &&
    !CONTROL_CHARACTER.test(value) && UTF8_ENCODER.encode(value).byteLength <= maximumBytes;
}

function validPreparedName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 48 &&
    wellFormedUnicode(value) && !CONTROL_CHARACTER.test(value) &&
    UTF8_ENCODER.encode(value).byteLength <= 192;
}

function validBlueprintId(value: unknown): value is string {
  if (!validOpaqueText(value)) return false;
  const match = BLUEPRINT_ID.exec(value);
  if (!match) return false;
  const suffix = Number(match[1]);
  return Number.isSafeInteger(suffix) && suffix >= 0 && suffix < Number.MAX_SAFE_INTEGER;
}

function validJsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return wellFormedUnicode(value) &&
    UTF8_ENCODER.encode(value).byteLength <= MAX_OPAQUE_BYTES;
  if (typeof value !== "object" || value === null || ancestors.has(value)) return false;
  if (!Array.isArray(value) && !isRecord(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => validJsonValue(entry, depth + 1, ancestors))
    : Reflect.ownKeys(value).every((key) => typeof key === "string" && wellFormedUnicode(key) &&
      UTF8_ENCODER.encode(key).byteLength <= MAX_OPAQUE_BYTES &&
      validJsonValue((value as Record<string, unknown>)[key], depth + 1, ancestors));
  ancestors.delete(value);
  return valid;
}

function keysAreAllowed(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: ReadonlySet<string>,
): boolean {
  const keys = Reflect.ownKeys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every(
    (key) => typeof key === "string" && allowed.has(key),
  );
}

function validPreparedEntity(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !keysAreAllowed(value, ENTITY_REQUIRED_KEYS, ENTITY_KEYS) ||
      !validOpaqueText(value.key) || !validOpaqueText(value.buildingId) ||
      !isRecord(value.offset) || !hasExactKeys(value.offset, ["x", "y"]) ||
      typeof value.offset.x !== "number" || !Number.isFinite(value.offset.x) ||
      typeof value.offset.y !== "number" || !Number.isFinite(value.offset.y) ||
      typeof value.machineCount !== "number" || !Number.isSafeInteger(value.machineCount) ||
      value.machineCount < 1) return false;
  return validJsonValue(value);
}

function validPreparedBelt(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !keysAreAllowed(value, BELT_REQUIRED_KEYS, BELT_KEYS)) return false;
  for (const key of ["key", "sourceKey", "targetKey", "itemId"] as const) {
    if (!validOpaqueText(value[key])) return false;
  }
  return validJsonValue(value);
}

function validRecipeOverrides(value: unknown): value is Record<string, string> {
  return isRecord(value) && Reflect.ownKeys(value).every((key) => typeof key === "string" &&
    validOpaqueText(key) && validOpaqueText(value[key]));
}

function validPreparedBlueprint(value: unknown): value is NativeBlueprintImportPreparedBlueprint {
  return isRecord(value) && hasExactKeys(value, BLUEPRINT_KEYS) &&
    validBlueprintId(value.id) && validPreparedName(value.name) && value.revision === 1 &&
    Array.isArray(value.entities) && value.entities.length <= 512 &&
    value.entities.every(validPreparedEntity) && Array.isArray(value.resourceAnchors) &&
    value.resourceAnchors.length === 0 && Array.isArray(value.belts) && value.belts.length <= 1_024 &&
    value.belts.every(validPreparedBelt) && Array.isArray(value.externalPorts) &&
    value.externalPorts.length === 0 && [0, 90, 180, 270].includes(value.rotation as number) &&
    ["none", "horizontal"].includes(value.mirror as string) &&
    validRecipeOverrides(value.recipeOverrides) && validJsonValue(value);
}

function validPreparedIntent(
  value: unknown,
  revision: number,
): value is NativeBlueprintImportPreparedIntent {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "sourceName", "blueprint", "blueprintSha256", "revision",
  ]) && value.kind === "import" && validPreparedName(value.sourceName) &&
    validPreparedBlueprint(value.blueprint) && typeof value.blueprintSha256 === "string" &&
    SHA256.test(value.blueprintSha256) && value.revision === revision;
}

function validLimits(value: unknown): value is NativeBlueprintImportContext["limits"] {
  return isRecord(value) && hasExactKeys(value, [
    "rawBytes", "projectionBytes", "commandBytes", "libraryRows", "blueprintEntities",
    "blueprintBelts",
  ]) && value.rawBytes === NATIVE_BLUEPRINT_IMPORT_RAW_BYTES &&
    value.projectionBytes === MAX_PROJECTION_BYTES && value.commandBytes === MAX_COMMAND_BYTES &&
    value.libraryRows === 64 && value.blueprintEntities === 512 && value.blueprintBelts === 1_024;
}

function projectionFitsByteBudget(value: unknown): boolean {
  try {
    return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength <= MAX_PROJECTION_BYTES;
  } catch {
    return false;
  }
}

function cloneFrozenJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneFrozenJson(entry))) as T;
  }
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) clone[key] = cloneFrozenJson(value[key]);
    return Object.freeze(clone) as T;
  }
  return value;
}

function validIdentity(identity: NativeBlueprintWorkspaceIdentity): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    safeNonnegativeInteger(identity.revision) && identity.revision < Number.MAX_SAFE_INTEGER &&
    validLogicalId(identity.registryFingerprint, 256);
}

function validRawContext(
  value: unknown,
  identity: NativeBlueprintWorkspaceIdentity,
  rawBytes: number,
  rawSha256: string,
): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "support", "preparedIntent", "limits",
  ]) || value.schemaVersion !== 1 || value.projectionType !== "blueprint-import-context-v1" ||
      value.source !== "native-core" || value.revision !== identity.revision || value.stateVersion !== 47 ||
      value.registryFingerprint !== identity.registryFingerprint || !isRecord(value.request) ||
      !hasExactKeys(value.request, [
        "expectedRevision", "expectedRegistryFingerprint", "rawBytes", "rawSha256",
      ]) || value.request.expectedRevision !== identity.revision ||
      value.request.expectedRegistryFingerprint !== identity.registryFingerprint ||
      value.request.rawBytes !== rawBytes || value.request.rawSha256 !== rawSha256 ||
      !validOpaqueText(value.activePlanetId) || !isRecord(value.support) ||
      !hasExactKeys(value.support, ["supported", "reason"]) ||
      typeof value.support.supported !== "boolean" || !validLimits(value.limits) ||
      !projectionFitsByteBudget(value)) return false;
  const reason = value.support.reason;
  if (reason !== null && (typeof reason !== "string" ||
      !SUPPORT_REASONS.has(reason as NativeBlueprintImportSupportReason))) return false;
  return value.support.supported
    ? reason === null && validPreparedIntent(value.preparedIntent, identity.revision)
    : reason !== null && value.preparedIntent === null;
}

export function nativeBlueprintImportContextSupportsCommand(
  value: unknown,
): value is NativeBlueprintImportContext & { preparedIntent: NativeBlueprintImportPreparedIntent } {
  return isRecord(value) && hasExactKeys(value, [
    "sessionId", "runId", "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "support", "preparedIntent", "limits",
  ]) && validLogicalId(value.sessionId, 128) && validLogicalId(value.runId, 128) &&
    safeNonnegativeInteger(value.revision) && value.revision < Number.MAX_SAFE_INTEGER &&
    validLogicalId(value.registryFingerprint, 256) && value.schemaVersion === 1 &&
    value.projectionType === "blueprint-import-context-v1" && value.source === "native-core" &&
    value.stateVersion === 47 && isRecord(value.request) && hasExactKeys(value.request, [
      "expectedRevision", "expectedRegistryFingerprint", "rawBytes", "rawSha256",
    ]) && value.request.expectedRevision === value.revision &&
    value.request.expectedRegistryFingerprint === value.registryFingerprint &&
    safeNonnegativeInteger(value.request.rawBytes) && value.request.rawBytes > 0 &&
    value.request.rawBytes <= NATIVE_BLUEPRINT_IMPORT_RAW_BYTES &&
    typeof value.request.rawSha256 === "string" && SHA256.test(value.request.rawSha256) &&
    validOpaqueText(value.activePlanetId) && isRecord(value.support) &&
    hasExactKeys(value.support, ["supported", "reason"]) && value.support.supported === true &&
    value.support.reason === null && validPreparedIntent(value.preparedIntent, value.revision) &&
    validLimits(value.limits) && projectionFitsByteBudget(value);
}

/** Rust alone parses the exchange; renderer verifies only identity, digest and the opaque marker envelope. */
export async function readVerifiedNativeBlueprintImportContext(
  bridge: NativeBlueprintImportContextBridge | null,
  identity: NativeBlueprintWorkspaceIdentity,
  raw: string,
): Promise<NativeBlueprintImportContext | null> {
  const reader = bridge?.getNativeCoreBlueprintImportContext;
  const validated = validateNativeBlueprintImportRaw(raw);
  if (typeof reader !== "function" || !validIdentity(identity) || !validated.ok) return null;
  let rawSha256: string;
  try {
    rawSha256 = await sha256Text(validated.raw);
  } catch {
    return null;
  }
  try {
    const value = await reader({
      sessionId: identity.sessionId,
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      raw: validated.raw,
    });
    if (!validRawContext(value, identity, validated.rawBytes, rawSha256)) return null;
    const request = value.request as NativeBlueprintImportContext["request"];
    const support = value.support as NativeBlueprintImportContext["support"];
    const limits = value.limits as NativeBlueprintImportContext["limits"];
    return Object.freeze({
      sessionId: identity.sessionId,
      runId: identity.runId,
      schemaVersion: 1 as const,
      projectionType: "blueprint-import-context-v1" as const,
      source: "native-core" as const,
      revision: identity.revision,
      stateVersion: 47 as const,
      registryFingerprint: identity.registryFingerprint,
      request: Object.freeze({ ...request }),
      activePlanetId: value.activePlanetId as string,
      support: Object.freeze({ ...support }),
      preparedIntent: value.preparedIntent === null
        ? null
        : cloneFrozenJson(value.preparedIntent as NativeBlueprintImportPreparedIntent),
      limits: Object.freeze({ ...limits }),
    });
  } catch {
    return null;
  }
}
