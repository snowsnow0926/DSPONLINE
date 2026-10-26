import contractJson from "./save-field-contract.json" with { type: "json" };

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const SAVE_FIELD_CONTRACT = deepFreeze(contractJson);

function scopeFields(scope) {
  return SAVE_FIELD_CONTRACT.scopes[scope] ?? null;
}

function ownDataValue(record, field) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { kind: "invalid-record", value: undefined };
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (!descriptor) return { kind: "missing", value: undefined };
  if (!("value" in descriptor)) return { kind: "accessor", value: undefined };
  if (descriptor.value === undefined) return { kind: "undefined", value: undefined };
  return { kind: "value", value: descriptor.value };
}

function versionIncluded(versions, gameStateVersion) {
  return Array.isArray(versions) && versions.includes(gameStateVersion);
}

function resolveDefaultDescriptor(defaultDescriptor, record) {
  if (defaultDescriptor.kind === "literal") return defaultDescriptor.value;
  if (defaultDescriptor.kind === "empty-object") return {};
  if (defaultDescriptor.kind === "empty-array") return [];
  if (defaultDescriptor.kind === "sibling-integer-clamp") {
    const sibling = ownDataValue(record, defaultDescriptor.field);
    const raw = sibling.kind === "value" && Number.isSafeInteger(sibling.value)
      ? sibling.value
      : defaultDescriptor.fallback;
    return Math.max(defaultDescriptor.minimum, Math.min(defaultDescriptor.maximum, raw));
  }
  throw new TypeError(`Unsupported save-field default kind: ${String(defaultDescriptor.kind)}`);
}

function exactDefaultMatch(value, defaultDescriptor, defaultValue) {
  if (defaultDescriptor.kind === "empty-object") {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  }
  if (defaultDescriptor.kind === "empty-array") return Array.isArray(value) && value.length === 0;
  return Object.is(value, defaultValue);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateSaveContractValue(value, validation) {
  if (!validation || typeof validation !== "object") return false;
  if (validation.type === "boolean") return typeof value === "boolean";
  if (validation.type === "number") {
    if (typeof value !== "number") return false;
    if (validation.finite !== false && !Number.isFinite(value)) return false;
    if (validation.integer === true && !Number.isInteger(value)) return false;
    if (validation.safeInteger === true && !Number.isSafeInteger(value)) return false;
    if (Array.isArray(validation.enum) && !validation.enum.some((entry) => Object.is(entry, value))) return false;
    if (typeof validation.minimum === "number" && value < validation.minimum) return false;
    if (typeof validation.maximum === "number" && value > validation.maximum) return false;
    if (typeof validation.exclusiveMaximum === "number" && value >= validation.exclusiveMaximum) return false;
    return true;
  }
  if (validation.type === "string") {
    if (typeof value !== "string") return false;
    if (Array.isArray(validation.enum) && !validation.enum.includes(value)) return false;
    if (typeof validation.minimumLength === "number" && value.length < validation.minimumLength) return false;
    if (typeof validation.maximumLength === "number" && value.length > validation.maximumLength) return false;
    if (typeof validation.pattern === "string" && !new RegExp(validation.pattern, "u").test(value)) return false;
    return true;
  }
  if (validation.type === "record") {
    if (!isRecord(value)) return false;
    const keyPattern = typeof validation.keyPattern === "string" ? new RegExp(validation.keyPattern, "u") : null;
    for (const key of Object.keys(value)) {
      if (keyPattern && !keyPattern.test(key)) return false;
      const child = ownDataValue(value, key);
      if (child.kind !== "value" || validation.values && !validateSaveContractValue(child.value, validation.values)) return false;
    }
    return true;
  }
  if (validation.type === "array") {
    if (!Array.isArray(value)) return false;
    if (typeof validation.maximumItems === "number" && value.length > validation.maximumItems) return false;
    return !validation.items || value.every((entry) => validateSaveContractValue(entry, validation.items));
  }
  return false;
}

export function getSaveFieldDefinition(scope, field) {
  return scopeFields(scope)?.[field] ?? null;
}

export function listSaveContractFields(scope, gameStateVersion, purpose = "all") {
  const entries = Object.entries(scopeFields(scope) ?? {});
  if (purpose === "all" || gameStateVersion === undefined) return entries.map(([field]) => field);
  if (purpose === "projection") {
    return entries
      .filter(([, definition]) => versionIncluded(definition.projection?.omitDefaultVersions, gameStateVersion))
      .map(([field]) => field);
  }
  if (purpose === "missing-default") {
    return entries
      .filter(([, definition]) => versionIncluded(definition.missing?.defaultVersions, gameStateVersion))
      .map(([field]) => field);
  }
  throw new TypeError(`Unsupported save-field listing purpose: ${String(purpose)}`);
}

export function resolveSaveContractDefault(scope, field, record, gameStateVersion) {
  const definition = getSaveFieldDefinition(scope, field);
  if (!definition || !versionIncluded(definition.missing?.defaultVersions, gameStateVersion)) {
    return { applies: false, value: undefined };
  }
  return { applies: true, value: resolveDefaultDescriptor(definition.default, record) };
}

export function inspectSaveContractField(scope, field, record, gameStateVersion) {
  const definition = getSaveFieldDefinition(scope, field);
  if (!definition) {
    return { valid: false, status: "unknown-field", source: "none", value: undefined, reason: "unknown-field" };
  }
  if (!Number.isInteger(gameStateVersion) || gameStateVersion < 1) {
    return { valid: false, status: "invalid-version", source: "none", value: undefined, reason: "invalid-version" };
  }
  const own = ownDataValue(record, field);
  if (own.kind === "invalid-record" || own.kind === "accessor") {
    return { valid: false, status: "invalid", source: "explicit", value: undefined, reason: own.kind };
  }
  if (own.kind === "missing" || own.kind === "undefined") {
    const resolved = resolveSaveContractDefault(scope, field, record, gameStateVersion);
    if (resolved.applies) {
      return { valid: true, status: "defaulted", source: "default", value: resolved.value, reason: null };
    }
    const requiredFromVersion = definition.missing?.requiredFromVersion;
    if (Number.isInteger(requiredFromVersion) && gameStateVersion >= requiredFromVersion) {
      return { valid: false, status: "missing-required", source: "missing", value: undefined, reason: "missing-required" };
    }
    return { valid: true, status: "missing-optional", source: "missing", value: undefined, reason: null };
  }
  if (!validateSaveContractValue(own.value, definition.validation)) {
    return { valid: false, status: "invalid", source: "explicit", value: own.value, reason: "invalid-value" };
  }
  return { valid: true, status: "explicit", source: "explicit", value: own.value, reason: null };
}

export function inspectSaveContractRecord(scope, record, gameStateVersion) {
  const fields = Object.fromEntries(listSaveContractFields(scope).map((field) => [
    field,
    inspectSaveContractField(scope, field, record, gameStateVersion),
  ]));
  const errors = Object.entries(fields)
    .filter(([, result]) => !result.valid)
    .map(([field, result]) => ({ field, status: result.status, reason: result.reason }));
  return { valid: errors.length === 0, fields, errors };
}

function compileProjectionPlan(scope, gameStateVersion) {
  const dynamic = [];
  const entries = listSaveContractFields(scope, gameStateVersion, "projection").map((field) => {
    const descriptor = getSaveFieldDefinition(scope, field).default;
    const constant = descriptor.kind === "literal" || descriptor.kind === "empty-object" || descriptor.kind === "empty-array";
    const entry = Object.freeze({ field, descriptor,
      // Empty containers are matched structurally; they need no fresh object.
      value: descriptor.kind === "literal" ? descriptor.value : undefined,
      dynamicIndex: constant ? -1 : dynamic.length,
    });
    if (!constant) dynamic.push(entry);
    return entry;
  });
  return Object.freeze({ entries: Object.freeze(entries), dynamic: Object.freeze(dynamic) });
}

// The contract is deeply frozen. Compile only its finite, declared versions;
// caller-supplied versions must not create an unbounded process-wide cache.
const projectionPlans = new Map(Object.entries(SAVE_FIELD_CONTRACT.scopes).map(([scope, definitions]) => {
  const versions = new Set(Object.values(definitions).flatMap((definition) => definition.projection?.omitDefaultVersions ?? []));
  return [scope, new Map([undefined, ...versions].map((version) => [version, compileProjectionPlan(scope, version)]))];
}));

export function omitSaveContractDefaults(record, scope, gameStateVersion) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const plan = projectionPlans.get(scope)?.get(gameStateVersion);
  if (!plan) return record;
  // Read sibling-derived defaults before deleting anything (e.g. sorterTier
  // depends on tier). No record or record-derived value is kept in the plan.
  const dynamicValues = plan.dynamic.length
    ? plan.dynamic.map(({ descriptor }) => resolveDefaultDescriptor(descriptor, record)) : null;
  for (const { field, descriptor, value, dynamicIndex } of plan.entries) {
    const own = ownDataValue(record, field);
    if (own.kind === "undefined") {
      delete record[field];
      continue;
    }
    if (own.kind === "invalid-record" || own.kind === "accessor" || own.kind === "missing") continue;
    const defaultValue = dynamicIndex < 0 ? value : dynamicValues[dynamicIndex];
    if (exactDefaultMatch(own.value, descriptor, defaultValue)) delete record[field];
  }
  return record;
}
