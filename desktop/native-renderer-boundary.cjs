"use strict";

const NATIVE_ERROR_CODE_PATTERN = /^NATIVE_[A-Z0-9_]{1,95}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{8,64}$/;
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_PROJECTION_DEPTH = 16;
const MAX_PROJECTION_NODES = 300_000;
const MAX_PROJECTION_ARRAY_ENTRIES = 16_384;
const MAX_PROJECTION_OBJECT_ENTRIES = 8_192;
const MAX_PROJECTION_STRING_LENGTH = 4_096;
const MAX_NATIVE_PROJECTION_BYTES = 1_048_576;
const MAX_VIEWPORT_V2_OPAQUE_ID_BYTES = 512;
const VIEWPORT_V2_SPATIAL_CELL_SIZE = 512;

const PRIVATE_PROJECTION_KEYS = new Set([
  "sourcepath", "path", "filepath", "stderr", "stdout", "stack", "body",
  "state", "envelope", "rawbody", "entities", "belts",
]);

const ENTITY_PROJECTION_KEYS = new Set([
  "id", "kind", "planetId", "position", "interactionLocked", "resourceId", "buildingId",
  "extractorBuildingId", "recipeId", "targetDysonOrbitId", "storedItemId", "deliveryItemIds",
  "deliverySlots", "orbitalCargoPortItems", "orbitalCargoBinding", "orbitalCargoProgress",
  "orbitalCargoTotalUploaded", "distributionMode", "fuelItemId", "fuelRemainingMj",
  "powerOutputKw", "powerInputKw", "powerFactor", "storedEnergyMj", "energyMode", "powerGridId",
  "powerPriority", "generationPriority", "resourceRemaining", "resourceCapacity",
  "resourceDepletionRemainder", "stationMode", "stationTier", "stationOperationMode",
  "stationModeTransition", "quantumMode", "quantumTransition", "quantumTarget",
  "elevatorOutputItems", "stationProgress", "stationTrips", "stationLastTransfer", "stationPeerId",
  "stationDrones", "stationVessels", "stationWarpers", "stationWarpEnabled",
  "stationWarperAutoRefill", "stationWarperTarget", "stationHubEnabled", "stationHubPriority",
  "stationMinimumLoad", "stationSlots", "stationRoutes", "stationDispatchCursor",
  "stationLastSupplyPeerBySlot", "stationCongestion", "sprayCoaterInstalled", "proliferatorTier",
  "proliferatorMode", "proliferatorPoints", "proliferatorBonusProgress", "galacticExporterPaused",
  "blackHolePaused", "blackHoleActivationConfirmed", "blackHolePorts", "routingCursor",
  "machineCount", "minerCount", "inputs", "outputs", "progress", "utilization", "productionRate",
]);

const BELT_PROJECTION_KEYS = new Set([
  "id", "planetId", "source", "target", "itemId", "lanes", "tier", "sorterTier", "progress",
  "priority", "stackSize", "monitorEnabled", "totalTransferred", "congestion", "lastFlow",
  "recentFlowSampleSeconds", "recentFlowTransferred", "recentFlowSampling", "routeMode",
  "routeOffsetY", "targetPortIndex", "elevatorOutputIndex",
]);

const ENTITY_QUANTITY_RECORD_KEYS = new Set([
  "inputs", "outputs", "proliferatorBonusProgress",
]);

const PRODUCTION_HISTORY_SAMPLE_REQUIRED_KEYS = Object.freeze([
  "elapsedSeconds", "productionPerMinute", "consumptionPerMinute", "inventory", "generationKw", "demandKw",
]);
const PRODUCTION_HISTORY_SAMPLE_OPTIONAL_KEYS = Object.freeze([
  "sampleDurationSeconds", "planetProductionPerMinute", "planetConsumptionPerMinute",
  "machineEfficiency", "logisticsEfficiency", "powerEfficiency", "activeMachines", "blockedMachines",
]);

// A merely syntactically valid code is insufficient: a hostile or damaged
// Host could encode stderr/path fragments into it. Only published symbolic
// identities are allowed through the bridge.
const PUBLIC_NATIVE_ERROR_CODES = new Set([
  "NATIVE_CORE_ADVANCE_FAILED", "NATIVE_CORE_CHECKPOINT_FAILED", "NATIVE_CORE_CLOSE_FAILED",
  "NATIVE_CORE_COMMAND_FAILED", "NATIVE_CORE_COMMIT_FAILED", "NATIVE_CORE_COMPARE_FAILED",
  "NATIVE_CORE_EXACT_REALTIME_RUST_LEASE_UNAVAILABLE",
  "NATIVE_CORE_EXACT_REALTIME_WRITER_FENCE_UNAVAILABLE", "NATIVE_CORE_OPEN_FAILED",
  "NATIVE_CORE_PROJECTION_FAILED", "NATIVE_CORE_PROJECTION_TIMEOUT", "NATIVE_CORE_SESSION_INVALID",
  "NATIVE_CORE_STATUS_FAILED", "NATIVE_CORE_V47_EXPORT_FAILED",
  "NATIVE_CORE_V47_EXPORT_IDENTITY_INVALID", "NATIVE_CORE_V47_EXPORT_TARGET_INVALID",
  "NATIVE_CORE_V47_IMPORT_CANCELLED", "NATIVE_CORE_V47_IMPORT_FAILED",
  "NATIVE_CORE_V47_IMPORT_FILE_INVALID", "NATIVE_CORE_V47_IMPORT_UNAVAILABLE",
  "NATIVE_HOST_EXITED", "NATIVE_HOST_START_FAILED", "NATIVE_HOST_TIMEOUT",
  "NATIVE_HOST_UNAVAILABLE", "NATIVE_HOST_WRITE_FAILED", "NATIVE_OPERATION_FAILED",
  "NATIVE_PERFORMANCE_POLICY_READ_FAILED", "NATIVE_PERFORMANCE_POLICY_WRITE_FAILED",
  "NATIVE_PLAYER_AUTHORITY_STATE_FAILED",
  "NATIVE_PROTOCOL_INVALID", "NATIVE_SAVE_ABORT_FAILED", "NATIVE_SAVE_BEGIN_FAILED",
  "NATIVE_SAVE_COMMIT_FAILED", "NATIVE_SAVE_COMPACT_FAILED", "NATIVE_SAVE_READ_FAILED",
  "NATIVE_SAVE_RECOVER_FAILED", "NATIVE_SAVE_WRITE_FAILED", "NATIVE_STATUS_FAILED",
  "NATIVE_TRANSACTION_INVALID", "NATIVE_V47_IMPORT_JS_COMPATIBILITY_REQUIRED",
  "NATIVE_WAL_APPEND_FAILED",
]);

const CORE_COVERAGE_KEYS = Object.freeze([
  "stateContainer", "commandPatches", "quiescentClock", "infiniteSolidMining",
  "finiteSolidMining", "fluidMining", "windPower", "renewablePower", "fuelPower",
  "energyStorage", "powerPriorities", "ordinaryProduction", "proliferatedProduction",
  "finiteResearch", "infiniteResearch", "ordinaryBelts", "storageAndSplitters",
  "planetaryLogistics", "sameSystemInterstellarLogistics", "directWarpLogistics",
  "relayLogistics", "orbitalCollectors", "stationWarperAutoRefill",
  "quantumLogisticsNetwork", "quantumLocalDroneBridge", "quantumBeltBridge",
  "persistedConstructionJobs", "constructionQuantumPrefetch", "recursiveConstructionPlanning",
  "portableFleetConstruction", "constructionByproductSettlement", "constructionArithmeticBatching",
  "quantumAttachmentTransitions", "inactiveTimeWarpController", "activeTimeWarpPower",
  "unifiedAdvanceBudgets", "dysonSwarmAndSphere", "dysonLaunchers", "dysonRayReceivers",
  "orbitalCargoTerminals", "stationContractRefresh", "systemSpaceStationConstruction",
  "systemHubLogistics", "elevatorBelts", "stationModeTransitions", "campaignProgress",
  "handcraftQueue", "explorationMissions", "galacticExports", "speedrunClockAndMilestones",
  "exactSegmentedOffline", "pureIdleMacro", "mining", "production", "research", "belts",
  "logistics", "power", "dyson", "construction", "spaceStation", "offlineAndTimeWarp",
  "contentPacks", "authorityEligible",
]);

function requireNativeErrorCode(value, label) {
  if (typeof value !== "string" || !NATIVE_ERROR_CODE_PATTERN.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function requirePublicMessage(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 240 || /[\r\n\0]/.test(value)) {
    throw new TypeError("renderer native error message is invalid");
  }
  return value;
}

function protocolError(label) {
  return Object.assign(new Error(`${label} is invalid`), { name: "NativeHostError", code: "NATIVE_PROTOCOL_INVALID" });
}

function objectWithKeys(value, requiredKeys, optionalKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw protocolError(label);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      requiredKeys.some((key) => !Object.hasOwn(value, key))) throw protocolError(label);
  return value;
}

function exactObject(value, keys, label) { return objectWithKeys(value, keys, [], label); }
function boolean(value, label) { if (typeof value !== "boolean") throw protocolError(label); return value; }
function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw protocolError(label);
  return value;
}
function finiteNumber(value, label, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) throw protocolError(label);
  return value;
}
function boundedString(value, label, maximum = 512, minimum = 1) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw protocolError(label);
  }
  return value;
}
function oneOf(value, allowed, label) { if (!allowed.includes(value)) throw protocolError(label); return value; }
function logicalId(value, label, maximum = 256) {
  const result = boundedString(value, label, maximum);
  if (!LOGICAL_ID_PATTERN.test(result)) throw protocolError(label);
  return result;
}
function opaqueId(value, label, maximumBytes = MAX_VIEWPORT_V2_OPAQUE_ID_BYTES) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > maximumBytes) throw protocolError(label);
  // JSON emitted by serde_json cannot contain unpaired UTF-16 surrogates.
  // Reject them here too so two distinct renderer strings cannot collapse to
  // the same replacement-character byte sequence at a later IPC boundary.
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw protocolError(label);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw protocolError(label);
    }
  }
  return value;
}
function recordKey(value, label) {
  const result = boundedString(value, label, 512);
  if (result.includes("..") || /[\\/]/.test(result)) throw protocolError(label);
  return result;
}
function safeToken(value, label, maximum = 160) { return logicalId(value, label, maximum); }
function publicReason(value) {
  if (typeof value === "string" && value.length > 0 && value.length <= 160 && LOGICAL_ID_PATTERN.test(value)) return value;
  // Reasons can be assembled from internal anyhow chains. Those are useful in
  // the main process, but they can contain stderr or filesystem context. Keep
  // the operation a successful, unsupported-domain receipt while replacing
  // any non-symbolic diagnostic with a stable public reason.
  return "native-domain-unavailable";
}
function sha256(value, label) { if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw protocolError(label); return value; }
function checksum(value, label) { if (typeof value !== "string" || !CHECKSUM_PATTERN.test(value)) throw protocolError(label); return value; }
function jsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string")) throw protocolError(label);
  return value;
}
function logicalIdArray(value, label, maximumEntries = 1_000_000, maximumLength = 256) {
  if (!Array.isArray(value) || value.length > maximumEntries) throw protocolError(label);
  return value.map((entry, index) => logicalId(entry, `${label}[${index}]`, maximumLength));
}
function stableOpaqueIdArray(value, label, maximumEntries = 65_536) {
  const ids = opaqueIdArray(value, label, maximumEntries);
  for (let index = 1; index < ids.length; index += 1) {
    if (Buffer.compare(Buffer.from(ids[index - 1], "utf8"), Buffer.from(ids[index], "utf8")) >= 0) {
      throw protocolError(label);
    }
  }
  return ids;
}
function opaqueIdArray(value, label, maximumEntries) {
  if (!Array.isArray(value) || value.length > maximumEntries) throw protocolError(label);
  const seen = new Set();
  return value.map((entry, index) => {
    const id = opaqueId(entry, `${label}[${index}]`);
    if (seen.has(id)) throw protocolError(`${label}[${index}]`);
    seen.add(id);
    return id;
  });
}
function stringHashRecord(value, label, maximumEntries = 4_096) {
  const source = jsonObject(value, label);
  const entries = Reflect.ownKeys(source);
  if (entries.length > maximumEntries) throw protocolError(label);
  return Object.fromEntries(entries.map((key) => {
    if (typeof key !== "string" || key.length < 1 || key.length > 512 || /[\0\r\n]/.test(key)) throw protocolError(label);
    return [key, sha256(source[key], `${label}.${key}`)];
  }));
}

function projectionBudget() { return { nodes: 0 }; }

function requireProjectionByteBudget(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw protocolError(`${label} byte budget`);
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_NATIVE_PROJECTION_BYTES) {
    throw protocolError(`${label} byte budget`);
  }
}

function claimProjectionNode(budget, label) {
  budget.nodes += 1;
  if (budget.nodes > MAX_PROJECTION_NODES) throw protocolError(`${label} node budget`);
}

function requireProjectionKey(key, label) {
  if (typeof key !== "string" || key.length < 1 || key.length > 512 || /[\0\r\n]/.test(key) ||
      PRIVATE_PROJECTION_KEYS.has(key.toLowerCase())) throw protocolError(label);
  return key;
}

function sanitizeProjectionValue(value, label, budget, depth = 0) {
  if (depth > MAX_PROJECTION_DEPTH) throw protocolError(`${label} depth`);
  claimProjectionNode(budget, label);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw protocolError(label);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_PROJECTION_STRING_LENGTH || /\0/.test(value)) throw protocolError(label);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PROJECTION_ARRAY_ENTRIES) throw protocolError(label);
    return value.map((entry, index) => sanitizeProjectionValue(entry, `${label}[${index}]`, budget, depth + 1));
  }
  const source = jsonObject(value, label);
  const keys = Reflect.ownKeys(source);
  if (keys.length > MAX_PROJECTION_OBJECT_ENTRIES) throw protocolError(label);
  return Object.fromEntries(keys.map((key) => {
    const safeKey = requireProjectionKey(key, `${label} key`);
    return [safeKey, sanitizeProjectionValue(source[safeKey], `${label}.${safeKey}`, budget, depth + 1)];
  }));
}

function normalizeProjectionBaseFields(value, label) {
  if (!Array.isArray(value) || value.length > 64) throw protocolError(label);
  return new Set(value.map((entry, index) => {
    const field = logicalId(entry, `${label} base field[${index}]`, 160);
    requireProjectionKey(field, `${label} base field[${index}]`);
    if (field === "entities" || field === "belts") throw protocolError(`${label} base field[${index}]`);
    return field;
  }));
}

function normalizeProjectionContext(value, label) {
  const source = exactObject(value, ["baseFields", "entityIds", "beltIds"], label);
  return {
    baseFields: normalizeProjectionBaseFields(source.baseFields, label),
    entityIds: new Set(logicalIdArray(source.entityIds, `${label} entity IDs`, 32, 160)),
    beltIds: new Set(logicalIdArray(source.beltIds, `${label} belt IDs`, 64, 160)),
  };
}

function normalizeViewportProjectionContext(value, label) {
  const source = exactObject(value, ["baseFields", "planetId", "bounds", "entityCursor", "entityLimit", "beltLimit"], label);
  return {
    baseFields: normalizeProjectionBaseFields(source.baseFields, label),
    planetId: logicalId(source.planetId, `${label} planet`, 160),
    bounds: normalizeBounds(source.bounds, `${label} bounds`),
    entityCursor: safeInteger(source.entityCursor, `${label} entity cursor`),
    entityLimit: (() => {
      const result = safeInteger(source.entityLimit, `${label} entity limit`, 1);
      if (result > 4_096) throw protocolError(`${label} entity limit`);
      return result;
    })(),
    beltLimit: (() => {
      const result = safeInteger(source.beltLimit, `${label} belt limit`);
      if (result > 8_192) throw protocolError(`${label} belt limit`);
      return result;
    })(),
  };
}

function normalizeViewportProjectionV2Context(value, label) {
  const source = exactObject(value, [
    "sessionId", "expectedRevision", "baseFields", "planetId", "bounds",
    "entityCursor", "entityLimit", "beltCursor", "beltLimit",
    "pinnedEntityIds", "pinnedBeltIds",
  ], label);
  const entityLimit = safeInteger(source.entityLimit, `${label} entity limit`, 1);
  const beltLimit = safeInteger(source.beltLimit, `${label} belt limit`, 1);
  if (entityLimit > 4_096 || beltLimit > 8_192) throw protocolError(`${label} limits`);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    baseFields: normalizeProjectionBaseFields(source.baseFields, label),
    planetId: opaqueId(source.planetId, `${label} planet`),
    bounds: normalizeBounds(source.bounds, `${label} bounds`),
    entityCursor: safeInteger(source.entityCursor, `${label} entity cursor`),
    entityLimit,
    beltCursor: safeInteger(source.beltCursor, `${label} belt cursor`),
    beltLimit,
    pinnedEntityIds: opaqueIdArray(source.pinnedEntityIds, `${label} pinned entity IDs`, 32),
    pinnedBeltIds: opaqueIdArray(source.pinnedBeltIds, `${label} pinned belt IDs`, 64),
  };
}

function normalizeFactoryReadModelContext(value, label) {
  const source = exactObject(
    value,
    ["sessionId", "expectedRevision", "selectedEntityIds", "selectedBeltIds"],
    label,
  );
  const selectorIds = (entry, entryLabel) => {
    if (!Array.isArray(entry) || entry.length > 64) throw protocolError(entryLabel);
    return entry.map((id, index) => opaqueId(id, `${entryLabel}[${index}]`));
  };
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    selectedEntityIds: selectorIds(source.selectedEntityIds, `${label} selected entity IDs`),
    selectedBeltIds: selectorIds(source.selectedBeltIds, `${label} selected belt IDs`),
  };
}

function normalizeStatisticsProjectionContext(value, label) {
  const source = exactObject(value, ["minElapsedSeconds", "maxElapsedSeconds", "cursor", "limit", "planetId", "itemId"], label);
  const minElapsedSeconds = finiteNumber(source.minElapsedSeconds, `${label} minimum elapsed seconds`);
  const maxElapsedSeconds = finiteNumber(source.maxElapsedSeconds, `${label} maximum elapsed seconds`);
  if (maxElapsedSeconds < minElapsedSeconds) throw protocolError(`${label} window`);
  const limit = safeInteger(source.limit, `${label} limit`, 1);
  if (limit > 512) throw protocolError(`${label} limit`);
  const optionalId = (entry, entryLabel) => entry === null ? null : logicalId(entry, entryLabel, 160);
  return {
    minElapsedSeconds,
    maxElapsedSeconds,
    cursor: safeInteger(source.cursor, `${label} cursor`),
    limit,
    planetId: optionalId(source.planetId, `${label} planet`),
    itemId: optionalId(source.itemId, `${label} item`),
  };
}

function normalizeProjectionBase(value, allowedFields, label, budget) {
  const source = jsonObject(value, label);
  const keys = Reflect.ownKeys(source);
  if (keys.length > allowedFields.size || keys.some((key) => typeof key !== "string" ||
      key === "entities" || key === "belts" || !allowedFields.has(key))) throw protocolError(label);
  return sanitizeProjectionValue(source, label, budget);
}

function normalizeProjectionRecords(value, allowedKeys, label, maximum, budget, requestedIds = null, quantityRecordKeys = null, idNormalizer = logicalId, quantityIdNormalizer = logicalId) {
  if (!Array.isArray(value) || value.length > maximum) throw protocolError(label);
  claimProjectionNode(budget, label);
  const seen = new Set();
  return value.map((entry, index) => {
    const source = jsonObject(entry, `${label}[${index}]`);
    const keys = Reflect.ownKeys(source);
    if (keys.length > allowedKeys.size || keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
      throw protocolError(`${label}[${index}]`);
    }
    const id = idNormalizer(source.id, `${label}[${index}].id`, 160);
    if (seen.has(id) || requestedIds && !requestedIds.has(id)) throw protocolError(`${label}[${index}].id`);
    seen.add(id);
    claimProjectionNode(budget, `${label}[${index}]`);
    return Object.fromEntries(keys.map((key) => [
      key,
      quantityRecordKeys?.has(key)
        ? normalizeQuantityRecord(source[key], `${label}[${index}].${key}`, budget, quantityIdNormalizer)
        : sanitizeProjectionValue(source[key], `${label}[${index}].${key}`, budget, 1),
    ]));
  });
}

function normalizeQuantityRecord(value, label, budget, idNormalizer = logicalId) {
  const source = jsonObject(value, label);
  const keys = Reflect.ownKeys(source);
  if (keys.length > 4_096) throw protocolError(label);
  claimProjectionNode(budget, label);
  return Object.fromEntries(keys.map((key) => {
    // Item IDs are typed map keys, not diagnostic property names. A mod may
    // legitimately publish an item named "state" or "body"; its value must
    // still be a finite numeric quantity, so it cannot smuggle Host objects.
    const itemId = idNormalizer(key, `${label} item`, 256);
    claimProjectionNode(budget, `${label}.${itemId}`);
    return [itemId, finiteNumber(source[itemId], `${label}.${itemId}`)];
  }));
}

function normalizePlanetQuantityRecord(value, label, budget) {
  const source = jsonObject(value, label);
  const keys = Reflect.ownKeys(source);
  if (keys.length > 1_024) throw protocolError(label);
  claimProjectionNode(budget, label);
  return Object.fromEntries(keys.map((key) => {
    const planetId = logicalId(key, `${label} planet`, 256);
    return [planetId, normalizeQuantityRecord(source[planetId], `${label}.${planetId}`, budget)];
  }));
}

function normalizeProductionHistorySample(value, label, budget) {
  const source = objectWithKeys(
    value,
    PRODUCTION_HISTORY_SAMPLE_REQUIRED_KEYS,
    PRODUCTION_HISTORY_SAMPLE_OPTIONAL_KEYS,
    label,
  );
  claimProjectionNode(budget, label);
  const result = {
    elapsedSeconds: finiteNumber(source.elapsedSeconds, `${label}.elapsedSeconds`),
    productionPerMinute: normalizeQuantityRecord(source.productionPerMinute, `${label}.productionPerMinute`, budget),
    consumptionPerMinute: normalizeQuantityRecord(source.consumptionPerMinute, `${label}.consumptionPerMinute`, budget),
    inventory: normalizeQuantityRecord(source.inventory, `${label}.inventory`, budget),
    generationKw: finiteNumber(source.generationKw, `${label}.generationKw`),
    demandKw: finiteNumber(source.demandKw, `${label}.demandKw`),
  };
  for (const key of ["elapsedSeconds", "generationKw", "demandKw"]) claimProjectionNode(budget, `${label}.${key}`);
  if (source.sampleDurationSeconds !== undefined) {
    const duration = finiteNumber(source.sampleDurationSeconds, `${label}.sampleDurationSeconds`, 1);
    if (duration > 3_600) throw protocolError(`${label}.sampleDurationSeconds`);
    result.sampleDurationSeconds = duration;
    claimProjectionNode(budget, `${label}.sampleDurationSeconds`);
  }
  if (source.planetProductionPerMinute !== undefined) {
    result.planetProductionPerMinute = normalizePlanetQuantityRecord(source.planetProductionPerMinute, `${label}.planetProductionPerMinute`, budget);
  }
  if (source.planetConsumptionPerMinute !== undefined) {
    result.planetConsumptionPerMinute = normalizePlanetQuantityRecord(source.planetConsumptionPerMinute, `${label}.planetConsumptionPerMinute`, budget);
  }
  for (const key of ["machineEfficiency", "logisticsEfficiency", "powerEfficiency"]) {
    if (source[key] === undefined) continue;
    const efficiency = finiteNumber(source[key], `${label}.${key}`);
    if (efficiency > 1) throw protocolError(`${label}.${key}`);
    result[key] = efficiency;
    claimProjectionNode(budget, `${label}.${key}`);
  }
  for (const key of ["activeMachines", "blockedMachines"]) {
    if (source[key] === undefined) continue;
    result[key] = safeInteger(source[key], `${label}.${key}`);
    claimProjectionNode(budget, `${label}.${key}`);
  }
  return result;
}

function rendererNativeErrorCode(error, fallbackCode) {
  const fallback = requireNativeErrorCode(fallbackCode, "renderer native fallback code");
  const candidate = error && typeof error === "object" ? error.code : undefined;
  return typeof candidate === "string" && PUBLIC_NATIVE_ERROR_CODES.has(candidate) ? candidate : fallback;
}

function createRendererNativeError(error, options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("renderer native error options are invalid");
  const code = rendererNativeErrorCode(error, options.fallbackCode);
  const result = new Error(`${requirePublicMessage(options.message)}（${code}）`);
  result.name = error && typeof error === "object" && error.name === "AbortError" ? "AbortError" : "NativeHostError";
  result.code = code;
  result.stack = `${result.name}: ${result.message}`;
  return result;
}

function createRendererNativeRejection(error, options) {
  const fallbackCode = requireNativeErrorCode(options?.fallbackCode, "renderer native fallback code");
  const rawMessage = error && typeof error === "object" && typeof error.message === "string" ? error.message : "";
  const suffix = rawMessage.match(/（(NATIVE_[A-Z0-9_]{1,95})）$/)?.[1];
  const recoveredCode = suffix && PUBLIC_NATIVE_ERROR_CODES.has(suffix) ? suffix : fallbackCode;
  return createRendererNativeError({
    name: error && typeof error === "object" ? error.name : undefined,
    code: recoveredCode,
  }, options);
}

function serializeRendererNativeError(error, options) {
  const safe = createRendererNativeError(error, options);
  return { name: safe.name, message: safe.message, code: safe.code };
}

function normalizePerformancePolicy(value) {
  const source = exactObject(value, ["schemaVersion", "requestedPolicy", "effectivePolicy", "logicalCpuCount", "restartRequired", "configurationState"], "native performance policy status");
  if (source.schemaVersion !== 1) throw protocolError("native performance policy schema");
  const requested = objectWithKeys(source.requestedPolicy, ["mode"], ["customThreads"], "native requested policy");
  const requestedMode = oneOf(requested.mode, ["quiet", "balanced", "performance", "custom"], "native requested policy mode");
  if ((requestedMode === "custom") !== Object.hasOwn(requested, "customThreads")) throw protocolError("native requested custom policy");
  const threadSetting = (entry, label) => entry === "auto" ? entry : oneOf(entry, [1, 2, 4, 8], label);
  const effective = exactObject(source.effectivePolicy, ["mode", "threadSetting"], "native effective policy");
  return {
    schemaVersion: 1,
    requestedPolicy: requestedMode === "custom"
      ? { mode: requestedMode, customThreads: threadSetting(requested.customThreads, "native requested threads") }
      : { mode: requestedMode },
    effectivePolicy: {
      mode: oneOf(effective.mode, ["quiet", "balanced", "performance", "custom"], "native effective policy mode"),
      threadSetting: threadSetting(effective.threadSetting, "native effective threads"),
    },
    logicalCpuCount: safeInteger(source.logicalCpuCount, "native logical CPU count", 1),
    restartRequired: boolean(source.restartRequired, "native policy restart flag"),
    configurationState: oneOf(source.configurationState, ["default", "loaded", "invalid", "saved"], "native policy configuration state"),
  };
}

function normalizeHostHello(value) {
  // The optional startup-recovery receipt is consumed only by the main
  // process NativeCoreSessionRegistry and is deliberately omitted from the
  // renderer-safe projection returned here.
  const source = objectWithKeys(
    value,
    ["protocolVersion", "nativeFormatVersion", "hostVersion", "capabilities"],
    ["playerAuthorityStartupRecovery"],
    "native Host hello",
  );
  if (!Array.isArray(source.capabilities) || source.capabilities.length > 128) throw protocolError("native Host capabilities");
  return {
    protocolVersion: safeInteger(source.protocolVersion, "native Host protocol", 1),
    nativeFormatVersion: safeInteger(source.nativeFormatVersion, "native Host format", 1),
    hostVersion: safeToken(source.hostVersion, "native Host version", 64),
    capabilities: source.capabilities.map((entry, index) => safeToken(entry, `native Host capability[${index}]`, 128)),
  };
}

function normalizeNativeStatus(value) {
  const source = objectWithKeys(value, ["available", "state", "message", "capabilities"], ["errorCode", "protocolVersion", "nativeFormatVersion", "hostVersion", "exactRealtime", "performancePolicy"], "native renderer status");
  if (!Array.isArray(source.capabilities) || source.capabilities.length > 128) throw protocolError("native status capabilities");
  const result = {
    available: boolean(source.available, "native status availability"),
    state: oneOf(source.state, ["starting", "ready", "unavailable", "unsupported"], "native status state"),
    message: requirePublicMessage(source.message),
    errorCode: source.errorCode == null ? null : rendererNativeErrorCode({ code: source.errorCode }, "NATIVE_STATUS_FAILED"),
    capabilities: source.capabilities.map((entry, index) => safeToken(entry, `native status capability[${index}]`, 128)),
  };
  if (source.protocolVersion !== undefined) result.protocolVersion = safeInteger(source.protocolVersion, "native status protocol", 1);
  if (source.nativeFormatVersion !== undefined) result.nativeFormatVersion = safeInteger(source.nativeFormatVersion, "native status format", 1);
  if (source.hostVersion !== undefined) result.hostVersion = safeToken(source.hostVersion, "native status Host version", 64);
  if (source.performancePolicy !== undefined) result.performancePolicy = normalizePerformancePolicy(source.performancePolicy);
  return result;
}

function normalizeSaveBegin(value) {
  const source = objectWithKeys(value, ["transactionId"], ["previousGeneration", "previousRevision"], "native save begin result");
  const result = { transactionId: logicalId(source.transactionId, "native transaction ID", 128) };
  if (source.previousGeneration != null) result.previousGeneration = safeInteger(source.previousGeneration, "native previous generation", 1);
  if (source.previousRevision != null) result.previousRevision = safeInteger(source.previousRevision, "native previous revision");
  return result;
}

function normalizeSaveWrite(value) {
  const source = exactObject(value, ["acceptedRecords"], "native save write result");
  return { acceptedRecords: safeInteger(source.acceptedRecords, "native accepted record count") };
}

function normalizeSaveCommit(value) {
  const source = objectWithKeys(value, ["slot", "generation", "revision", "rootHash", "recordCount", "changedRecords", "changedBytes", "totalUncompressedBytes"], ["walMaintenancePending", "walBytes"], "native save commit result");
  const result = {
    slot: oneOf(source.slot, ["normal-main", "speedrun-main"], "native commit slot"),
    generation: safeInteger(source.generation, "native commit generation", 1),
    revision: safeInteger(source.revision, "native commit revision"),
    rootHash: sha256(source.rootHash, "native commit root hash"),
    recordCount: safeInteger(source.recordCount, "native commit record count"),
    changedRecords: safeInteger(source.changedRecords, "native changed record count"),
    changedBytes: safeInteger(source.changedBytes, "native changed bytes"),
    totalUncompressedBytes: safeInteger(source.totalUncompressedBytes, "native total uncompressed bytes"),
  };
  if (source.walMaintenancePending !== undefined) result.walMaintenancePending = boolean(source.walMaintenancePending, "native WAL maintenance flag");
  if (source.walBytes !== undefined) result.walBytes = safeInteger(source.walBytes, "native WAL bytes");
  return result;
}

function normalizeSaveAbort(value) {
  const source = exactObject(value, ["aborted"], "native save abort result");
  return { aborted: boolean(source.aborted, "native save aborted flag") };
}

function normalizeSaveRecovery(value) {
  if (value === null) return null;
  const source = objectWithKeys(value, ["slot", "generation", "revision", "rootHash", "stateVersion", "mode", "baseChecksum", "registryFingerprint", "savedAtMs", "recordKeys", "walEntryCount"], ["walFirstRevision", "walLastRevision"], "native save recovery result");
  const result = {
    slot: oneOf(source.slot, ["normal-main", "speedrun-main"], "native recovery slot"), generation: safeInteger(source.generation, "native recovery generation", 1),
    revision: safeInteger(source.revision, "native recovery revision"), rootHash: sha256(source.rootHash, "native recovery root hash"),
    stateVersion: safeInteger(source.stateVersion, "native recovery state version", 1), mode: oneOf(source.mode, ["normal", "speedrun"], "native recovery mode"),
    baseChecksum: checksum(source.baseChecksum, "native recovery base checksum"), registryFingerprint: logicalId(source.registryFingerprint, "native recovery registry fingerprint", 256),
    savedAtMs: safeInteger(source.savedAtMs, "native recovery timestamp"), recordKeys: (() => {
      if (!Array.isArray(source.recordKeys) || source.recordKeys.length > 1_000_000) throw protocolError("native recovery record keys");
      return source.recordKeys.map((entry, index) => recordKey(entry, `native recovery record keys[${index}]`));
    })(),
    walEntryCount: safeInteger(source.walEntryCount, "native recovery WAL entries"),
  };
  if (source.walFirstRevision != null) result.walFirstRevision = safeInteger(source.walFirstRevision, "native recovery first WAL revision");
  if (source.walLastRevision != null) result.walLastRevision = safeInteger(source.walLastRevision, "native recovery last WAL revision");
  return result;
}

function normalizeSaveRead(value) {
  const source = exactObject(value, ["slot", "generation", "rootHash", "key", "value"], "native save read result");
  if (source.value !== null && typeof source.value !== "string") throw protocolError("native save record value");
  return { slot: oneOf(source.slot, ["normal-main", "speedrun-main"], "native read slot"), generation: safeInteger(source.generation, "native read generation", 1), rootHash: sha256(source.rootHash, "native read root hash"), key: recordKey(source.key, "native read key"), value: source.value };
}

function normalizeWalAppend(value) {
  const source = objectWithKeys(value, ["revision", "entryHash", "walBytes"], ["duplicate"], "native WAL append result");
  const result = { revision: safeInteger(source.revision, "native WAL revision"), entryHash: sha256(source.entryHash, "native WAL entry hash"), walBytes: safeInteger(source.walBytes, "native WAL bytes") };
  if (source.duplicate !== undefined) result.duplicate = boolean(source.duplicate, "native WAL duplicate flag");
  return result;
}

function normalizeSaveCompact(value) {
  const source = exactObject(value, ["removedGenerations"], "native save compact result");
  return { removedGenerations: safeInteger(source.removedGenerations, "native removed generation count") };
}

function normalizeCoverage(value) {
  const source = exactObject(value, CORE_COVERAGE_KEYS, "native core coverage");
  return Object.fromEntries(CORE_COVERAGE_KEYS.map((key) => [key, boolean(source[key], `native core coverage.${key}`)]));
}

function normalizeCoreMemory(value) {
  const keys = ["rawRecordBytes", "indexedStringBytes", "inventoryEntryCount", "topologyIndexBytes", "estimatedRuntimeBytes"];
  const source = exactObject(value, keys, "native core memory estimate");
  return Object.fromEntries(keys.map((key) => [key, safeInteger(source[key], `native core memory.${key}`)]));
}

function normalizeCoreSummary(value) {
  const source = exactObject(value, ["revision", "stateVersion", "mode", "activePlanetId", "elapsedSeconds", "paused", "entityCount", "beltCount", "canonicalSha256", "canonicalComponents", "canonicalFields", "domainSha256", "catalogSha256", "registryFingerprint", "memory", "coverage"], "native core summary");
  const components = exactObject(source.canonicalComponents, ["base", "entities", "belts"], "native canonical components");
  return {
    revision: safeInteger(source.revision, "native core revision"),
    stateVersion: safeInteger(source.stateVersion, "native core state version", 1),
    mode: oneOf(source.mode, ["normal", "speedrun"], "native core mode"),
    activePlanetId: logicalId(source.activePlanetId, "native active planet", 256),
    elapsedSeconds: finiteNumber(source.elapsedSeconds, "native elapsed seconds"),
    paused: boolean(source.paused, "native paused flag"),
    entityCount: safeInteger(source.entityCount, "native entity count"),
    beltCount: safeInteger(source.beltCount, "native belt count"),
    canonicalSha256: sha256(source.canonicalSha256, "native canonical hash"),
    canonicalComponents: {
      base: sha256(components.base, "native base hash"),
      entities: sha256(components.entities, "native entities hash"),
      belts: sha256(components.belts, "native belts hash"),
    },
    canonicalFields: stringHashRecord(source.canonicalFields, "native canonical fields"),
    domainSha256: sha256(source.domainSha256, "native domain hash"),
    catalogSha256: sha256(source.catalogSha256, "native catalog hash"),
    registryFingerprint: logicalId(source.registryFingerprint, "native core registry fingerprint", 256),
    memory: normalizeCoreMemory(source.memory),
    coverage: normalizeCoverage(source.coverage),
  };
}

function normalizeCoreOpen(value) {
  const source = exactObject(value, ["sessionId", "authority", "checkpointRevision", "replayedWalEntries", "replayedRevision", "summary"], "native core open result");
  const summary = normalizeCoreSummary(source.summary);
  const checkpointRevision = safeInteger(source.checkpointRevision, "native checkpoint revision");
  const replayedRevision = safeInteger(source.replayedRevision, "native replayed revision");
  if (replayedRevision < checkpointRevision || summary.revision !== replayedRevision) throw protocolError("native core open revision proof");
  return {
    sessionId: logicalId(source.sessionId, "native core session ID", 128),
    authority: oneOf(source.authority, ["shadow"], "native core authority"),
    checkpointRevision,
    replayedWalEntries: safeInteger(source.replayedWalEntries, "native replayed WAL count"),
    replayedRevision,
    summary,
  };
}

function normalizeCoreImportProof(value) {
  const source = exactObject(value, ["formatVersion", "stateVersion", "kind", "envelopeSlot", "mode", "savedAtMs", "stateChecksum", "sourceSha256", "sourceByteLength", "entityCount", "beltCount"], "native v47 import proof");
  if (source.formatVersion !== 2 || source.stateVersion !== 47) throw protocolError("native v47 import format");
  return {
    formatVersion: 2,
    stateVersion: 47,
    kind: oneOf(source.kind, ["primary", "slot", "snapshot"], "native v47 import kind"),
    envelopeSlot: oneOf(source.envelopeSlot, ["main", "1", "2", "3"], "native v47 import slot"),
    mode: oneOf(source.mode, ["normal", "speedrun"], "native v47 import mode"),
    savedAtMs: safeInteger(source.savedAtMs, "native v47 import timestamp"),
    stateChecksum: checksum(source.stateChecksum, "native v47 state checksum"),
    sourceSha256: sha256(source.sourceSha256, "native v47 source hash"),
    sourceByteLength: safeInteger(source.sourceByteLength, "native v47 source bytes", 1),
    entityCount: safeInteger(source.entityCount, "native v47 entity count"),
    beltCount: safeInteger(source.beltCount, "native v47 belt count"),
  };
}

function normalizeCoreImport(value) {
  const source = exactObject(value, ["sessionId", "authority", "checkpoint", "import", "summary"], "native v47 import result");
  const checkpoint = normalizeSaveCommit(source.checkpoint);
  const proof = normalizeCoreImportProof(source.import);
  const summary = normalizeCoreSummary(source.summary);
  if (proof.mode !== summary.mode || proof.entityCount !== summary.entityCount || proof.beltCount !== summary.beltCount || checkpoint.revision !== summary.revision) {
    throw protocolError("native v47 import proof consistency");
  }
  return {
    sessionId: logicalId(source.sessionId, "native imported session ID", 128),
    authority: oneOf(source.authority, ["shadow"], "native imported authority"),
    checkpoint,
    import: proof,
    summary,
  };
}

function normalizeCoreProjection(value, context) {
  const source = exactObject(value, ["revision", "base", "entities", "belts"], "native core projection");
  const projectionContext = normalizeProjectionContext(context, "native core projection context");
  const budget = projectionBudget();
  return {
    revision: safeInteger(source.revision, "native projection revision"),
    base: normalizeProjectionBase(source.base, projectionContext.baseFields, "native projection base", budget),
    entities: normalizeProjectionRecords(source.entities, ENTITY_PROJECTION_KEYS, "native projection entities", 32, budget, projectionContext.entityIds, ENTITY_QUANTITY_RECORD_KEYS),
    belts: normalizeProjectionRecords(source.belts, BELT_PROJECTION_KEYS, "native projection belts", 64, budget, projectionContext.beltIds),
  };
}

function normalizeBounds(value, label) {
  const source = exactObject(value, ["minX", "minY", "maxX", "maxY"], label);
  const result = {
    minX: finiteNumber(source.minX, `${label}.minX`, -10_000_000), minY: finiteNumber(source.minY, `${label}.minY`, -10_000_000),
    maxX: finiteNumber(source.maxX, `${label}.maxX`, -10_000_000), maxY: finiteNumber(source.maxY, `${label}.maxY`, -10_000_000),
  };
  if (Object.values(result).some((entry) => Math.abs(entry) > 10_000_000) || result.maxX < result.minX || result.maxY < result.minY) throw protocolError(label);
  return result;
}

function normalizeCoreViewportProjection(value, context) {
  const source = exactObject(value, ["schemaVersion", "projectionType", "revision", "planetId", "bounds", "base", "entities", "belts", "nextEntityCursor", "truncatedBelts"], "native viewport projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "viewport-v1") throw protocolError("native viewport projection identity");
  const projectionContext = normalizeViewportProjectionContext(context, "native viewport projection context");
  const planetId = logicalId(source.planetId, "native viewport planet", 256);
  const bounds = normalizeBounds(source.bounds, "native viewport bounds");
  if (planetId !== projectionContext.planetId ||
      bounds.minX !== projectionContext.bounds.minX || bounds.minY !== projectionContext.bounds.minY ||
      bounds.maxX !== projectionContext.bounds.maxX || bounds.maxY !== projectionContext.bounds.maxY) {
    throw protocolError("native viewport request binding");
  }
  const budget = projectionBudget();
  const entities = normalizeProjectionRecords(
    source.entities,
    ENTITY_PROJECTION_KEYS,
    "native viewport entities",
    projectionContext.entityLimit,
    budget,
    null,
    ENTITY_QUANTITY_RECORD_KEYS,
  );
  for (const [index, entity] of entities.entries()) {
    if (entity.planetId !== projectionContext.planetId) throw protocolError(`native viewport entities[${index}].planetId`);
    const position = exactObject(entity.position, ["x", "y"], `native viewport entities[${index}].position`);
    const x = finiteNumber(position.x, `native viewport entities[${index}].position.x`, -10_000_000);
    const y = finiteNumber(position.y, `native viewport entities[${index}].position.y`, -10_000_000);
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
      throw protocolError(`native viewport entities[${index}].position`);
    }
    entity.position = { x, y };
  }
  const belts = normalizeProjectionRecords(
    source.belts,
    BELT_PROJECTION_KEYS,
    "native viewport belts",
    projectionContext.beltLimit,
    budget,
  );
  for (const [index, belt] of belts.entries()) {
    if (belt.planetId !== projectionContext.planetId) throw protocolError(`native viewport belts[${index}].planetId`);
  }
  const nextEntityCursor = source.nextEntityCursor === null
    ? null
    : safeInteger(source.nextEntityCursor, "native viewport cursor");
  if (nextEntityCursor !== null && nextEntityCursor !== projectionContext.entityCursor + entities.length) {
    throw protocolError("native viewport cursor binding");
  }
  return {
    schemaVersion: 1, projectionType: "viewport-v1", revision: safeInteger(source.revision, "native viewport revision"),
    planetId, bounds,
    base: normalizeProjectionBase(source.base, projectionContext.baseFields, "native viewport base", budget),
    entities,
    belts,
    nextEntityCursor,
    truncatedBelts: boolean(source.truncatedBelts, "native viewport truncated flag"),
  };
}

function equalBounds(left, right) {
  return left.minX === right.minX && left.minY === right.minY &&
    left.maxX === right.maxX && left.maxY === right.maxY;
}

function pointWithinBounds(x, y, bounds) {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

function normalizeViewportTotals(value, label) {
  const source = exactObject(value, ["entities", "belts"], label);
  return {
    entities: safeInteger(source.entities, `${label}.entities`),
    belts: safeInteger(source.belts, `${label}.belts`),
  };
}

function normalizeCoreViewportProjectionV2(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "planetId", "bounds", "base",
    "entities", "belts", "pinnedEntityIds", "pinnedBeltIds", "nextEntityCursor",
    "nextBeltCursor", "planetTotals", "viewportTotals", "worldBounds", "minimap",
    "broadQueryFallback",
  ], "native viewport v2 projection");
  if (source.schemaVersion !== 2 || source.projectionType !== "viewport-v2") {
    throw protocolError("native viewport v2 projection identity");
  }
  requireProjectionByteBudget(source, "native viewport v2 projection");
  const projectionContext = normalizeViewportProjectionV2Context(
    context,
    "native viewport v2 projection context",
  );
  const revision = safeInteger(source.revision, "native viewport v2 revision");
  if (revision !== projectionContext.expectedRevision) {
    throw protocolError("native viewport v2 revision binding");
  }
  // Validating the session selector here is intentional even though the
  // projection body does not echo it. The main-process MessagePort header is
  // the session-bearing half of this same request binding.
  if (!projectionContext.sessionId) throw protocolError("native viewport v2 session binding");
  const planetId = opaqueId(source.planetId, "native viewport v2 planet");
  const bounds = normalizeBounds(source.bounds, "native viewport v2 bounds");
  if (planetId !== projectionContext.planetId || !equalBounds(bounds, projectionContext.bounds)) {
    throw protocolError("native viewport v2 request binding");
  }

  const planetTotals = normalizeViewportTotals(source.planetTotals, "native viewport v2 planet totals");
  const viewportTotals = normalizeViewportTotals(source.viewportTotals, "native viewport v2 viewport totals");
  if (viewportTotals.entities > planetTotals.entities || viewportTotals.belts > planetTotals.belts ||
      projectionContext.entityCursor > viewportTotals.entities ||
      projectionContext.beltCursor > viewportTotals.belts) {
    throw protocolError("native viewport v2 total binding");
  }

  const pinnedEntityIds = opaqueIdArray(
    source.pinnedEntityIds,
    "native viewport v2 pinned entity IDs",
    projectionContext.pinnedEntityIds.length,
  );
  const pinnedBeltIds = opaqueIdArray(
    source.pinnedBeltIds,
    "native viewport v2 pinned belt IDs",
    projectionContext.pinnedBeltIds.length,
  );
  const requestedPinnedEntityIds = new Set(projectionContext.pinnedEntityIds);
  const requestedPinnedBeltIds = new Set(projectionContext.pinnedBeltIds);
  if (pinnedEntityIds.some((id) => !requestedPinnedEntityIds.has(id)) ||
      pinnedBeltIds.some((id) => !requestedPinnedBeltIds.has(id))) {
    throw protocolError("native viewport v2 pinned request binding");
  }

  const budget = projectionBudget();
  const entities = normalizeProjectionRecords(
    source.entities,
    ENTITY_PROJECTION_KEYS,
    "native viewport v2 entities",
    projectionContext.entityLimit + pinnedEntityIds.length,
    budget,
    null,
    ENTITY_QUANTITY_RECORD_KEYS,
    (entry, label) => opaqueId(entry, label),
    (entry, label) => opaqueId(entry, label),
  );
  const belts = normalizeProjectionRecords(
    source.belts,
    BELT_PROJECTION_KEYS,
    "native viewport v2 belts",
    projectionContext.beltLimit + pinnedBeltIds.length,
    budget,
    null,
    null,
    (entry, label) => opaqueId(entry, label),
  );
  const entityIds = new Set(entities.map((entity) => entity.id));
  const beltIds = new Set(belts.map((belt) => belt.id));
  if (pinnedEntityIds.some((id) => !entityIds.has(id)) || pinnedBeltIds.some((id) => !beltIds.has(id))) {
    throw protocolError("native viewport v2 pinned record binding");
  }

  const worldBounds = normalizeBounds(source.worldBounds, "native viewport v2 world bounds");
  const pinnedEntitySet = new Set(pinnedEntityIds);
  for (const [index, entity] of entities.entries()) {
    if (entity.planetId !== planetId) throw protocolError(`native viewport v2 entities[${index}].planetId`);
    const position = exactObject(entity.position, ["x", "y"], `native viewport v2 entities[${index}].position`);
    const x = finiteNumber(position.x, `native viewport v2 entities[${index}].position.x`, -10_000_000);
    const y = finiteNumber(position.y, `native viewport v2 entities[${index}].position.y`, -10_000_000);
    if (!pointWithinBounds(x, y, worldBounds) ||
        !pointWithinBounds(x, y, bounds) && !pinnedEntitySet.has(entity.id)) {
      throw protocolError(`native viewport v2 entities[${index}].position`);
    }
    entity.position = { x, y };
  }
  for (const [index, belt] of belts.entries()) {
    if (belt.planetId !== planetId) throw protocolError(`native viewport v2 belts[${index}].planetId`);
  }

  const expectedEntityPageSize = Math.min(
    projectionContext.entityLimit,
    viewportTotals.entities - projectionContext.entityCursor,
  );
  const expectedBeltPageSize = Math.min(
    projectionContext.beltLimit,
    viewportTotals.belts - projectionContext.beltCursor,
  );
  if (entities.length < expectedEntityPageSize ||
      entities.length > expectedEntityPageSize + pinnedEntityIds.length ||
      belts.length < expectedBeltPageSize ||
      belts.length > expectedBeltPageSize + pinnedBeltIds.length ||
      entities.length > planetTotals.entities || belts.length > planetTotals.belts) {
    throw protocolError("native viewport v2 page cardinality");
  }
  const expectedNextEntityCursor = projectionContext.entityCursor + expectedEntityPageSize < viewportTotals.entities
    ? projectionContext.entityCursor + expectedEntityPageSize
    : null;
  const expectedNextBeltCursor = projectionContext.beltCursor + expectedBeltPageSize < viewportTotals.belts
    ? projectionContext.beltCursor + expectedBeltPageSize
    : null;
  const nextEntityCursor = source.nextEntityCursor === null
    ? null
    : safeInteger(source.nextEntityCursor, "native viewport v2 entity cursor");
  const nextBeltCursor = source.nextBeltCursor === null
    ? null
    : safeInteger(source.nextBeltCursor, "native viewport v2 belt cursor");
  if (nextEntityCursor !== expectedNextEntityCursor || nextBeltCursor !== expectedNextBeltCursor) {
    throw protocolError("native viewport v2 cursor binding");
  }

  const minimapSource = exactObject(
    source.minimap,
    ["bounds", "entityCount", "beltCount", "occupiedCellCount", "cellSize"],
    "native viewport v2 minimap",
  );
  const minimapBounds = normalizeBounds(minimapSource.bounds, "native viewport v2 minimap bounds");
  const minimap = {
    bounds: minimapBounds,
    entityCount: safeInteger(minimapSource.entityCount, "native viewport v2 minimap entity count"),
    beltCount: safeInteger(minimapSource.beltCount, "native viewport v2 minimap belt count"),
    occupiedCellCount: safeInteger(minimapSource.occupiedCellCount, "native viewport v2 minimap occupied cell count"),
    cellSize: finiteNumber(minimapSource.cellSize, "native viewport v2 minimap cell size", 1),
  };
  if (!equalBounds(minimap.bounds, worldBounds) || minimap.entityCount !== planetTotals.entities ||
      minimap.beltCount !== planetTotals.belts || minimap.occupiedCellCount > minimap.entityCount ||
      minimap.cellSize !== VIEWPORT_V2_SPATIAL_CELL_SIZE) {
    throw protocolError("native viewport v2 minimap binding");
  }

  return {
    schemaVersion: 2,
    projectionType: "viewport-v2",
    revision,
    planetId,
    bounds,
    base: normalizeProjectionBase(source.base, projectionContext.baseFields, "native viewport v2 base", budget),
    entities,
    belts,
    pinnedEntityIds,
    pinnedBeltIds,
    nextEntityCursor,
    nextBeltCursor,
    planetTotals,
    viewportTotals,
    worldBounds,
    minimap,
    broadQueryFallback: boolean(source.broadQueryFallback, "native viewport v2 broad query fallback"),
  };
}

function boundedReadModelText(value, label, maximumBytes = 4_096, minimumBytes = 0) {
  if (typeof value !== "string" || value.includes("\0")) throw protocolError(label);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) throw protocolError(label);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw protocolError(label);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw protocolError(label);
    }
  }
  return value;
}

function nullableReadModelId(value, label) {
  return value === null ? null : opaqueId(value, label);
}

function nullableReadModelNumber(value, label) {
  return value === null ? null : finiteNumber(value, label);
}

function normalizeReadModelRows(value, label, maximumRows, normalizeRow) {
  const source = exactObject(value, ["rows", "totalCount", "truncated"], label);
  if (!Array.isArray(source.rows) || source.rows.length > maximumRows) throw protocolError(`${label}.rows`);
  const rows = source.rows.map((row, index) => normalizeRow(row, `${label}.rows[${index}]`));
  const totalCount = safeInteger(source.totalCount, `${label}.totalCount`);
  const truncated = boolean(source.truncated, `${label}.truncated`);
  if (totalCount < rows.length || truncated !== (totalCount > rows.length)) {
    throw protocolError(`${label} cardinality`);
  }
  return { rows, totalCount, truncated };
}

function normalizeReadModelQuantityRows(value, label, maximumRows, idKey) {
  const result = normalizeReadModelRows(value, label, maximumRows, (row, rowLabel) => {
    const source = exactObject(row, [idKey, "amount"], rowLabel);
    return {
      [idKey]: opaqueId(source[idKey], `${rowLabel}.${idKey}`),
      amount: finiteNumber(source.amount, `${rowLabel}.amount`),
    };
  });
  const ids = new Set();
  for (const row of result.rows) {
    if (ids.has(row[idKey])) throw protocolError(`${label} duplicate ID`);
    ids.add(row[idKey]);
  }
  return result;
}

function normalizeReadModelPosition(value, label) {
  const source = exactObject(value, ["x", "y"], label);
  const x = finiteNumber(source.x, `${label}.x`, -10_000_000);
  const y = finiteNumber(source.y, `${label}.y`, -10_000_000);
  if (Math.abs(x) > 10_000_000 || Math.abs(y) > 10_000_000) throw protocolError(label);
  return { x, y };
}

function normalizeFactoryShellReadModel(value) {
  const source = exactObject(value, [
    "schema", "source", "stateVersion", "mode", "activePlanetId", "paused",
    "elapsedSeconds", "simulationSpeed", "entityCount", "beltCount",
    "activePlanetEntityCount", "activePlanetBeltCount", "constructionQueueCount",
  ], "native factory shell");
  if (source.schema !== "factory-read-model-v1" || source.source !== "native-core") {
    throw protocolError("native factory shell identity");
  }
  const result = {
    schema: "factory-read-model-v1",
    source: "native-core",
    stateVersion: safeInteger(source.stateVersion, "native factory shell state version", 1),
    mode: oneOf(source.mode, ["normal", "speedrun"], "native factory shell mode"),
    activePlanetId: opaqueId(source.activePlanetId, "native factory shell active planet"),
    paused: boolean(source.paused, "native factory shell paused flag"),
    elapsedSeconds: finiteNumber(source.elapsedSeconds, "native factory shell elapsed seconds"),
    simulationSpeed: finiteNumber(source.simulationSpeed, "native factory shell simulation speed", 1),
    entityCount: safeInteger(source.entityCount, "native factory shell entity count"),
    beltCount: safeInteger(source.beltCount, "native factory shell belt count"),
    activePlanetEntityCount: safeInteger(source.activePlanetEntityCount, "native factory shell active entity count"),
    activePlanetBeltCount: safeInteger(source.activePlanetBeltCount, "native factory shell active belt count"),
    constructionQueueCount: safeInteger(source.constructionQueueCount, "native factory shell construction queue count"),
  };
  if (result.activePlanetEntityCount > result.entityCount || result.activePlanetBeltCount > result.beltCount) {
    throw protocolError("native factory shell active counts");
  }
  return result;
}

function normalizeFactoryPlanetNavigation(value, activePlanetId) {
  const source = exactObject(value, ["schema", "activePlanetId", "planets"], "native factory planet navigation");
  if (source.schema !== "factory-read-model-v1" ||
      opaqueId(source.activePlanetId, "native factory navigation active planet") !== activePlanetId) {
    throw protocolError("native factory planet navigation identity");
  }
  const planets = normalizeReadModelRows(source.planets, "native factory planets", 64, (row, label) => {
    const entry = exactObject(row, [
      "planetId", "systemId", "displayName", "code", "active", "discovered", "colonized",
      "role", "entityCount", "deviceCount", "beltCount", "constructionQueueCount", "powerFactor",
    ], label);
    const planetId = opaqueId(entry.planetId, `${label}.planetId`);
    const active = boolean(entry.active, `${label}.active`);
    if (active !== (planetId === activePlanetId)) throw protocolError(`${label}.active binding`);
    return {
      planetId,
      systemId: nullableReadModelId(entry.systemId, `${label}.systemId`),
      displayName: boundedReadModelText(entry.displayName, `${label}.displayName`, 4_096),
      code: boundedReadModelText(entry.code, `${label}.code`, 4_096, 1),
      active,
      discovered: boolean(entry.discovered, `${label}.discovered`),
      colonized: boolean(entry.colonized, `${label}.colonized`),
      role: entry.role === null ? null : boundedReadModelText(entry.role, `${label}.role`, 512),
      entityCount: safeInteger(entry.entityCount, `${label}.entityCount`),
      deviceCount: finiteNumber(entry.deviceCount, `${label}.deviceCount`, 0),
      beltCount: safeInteger(entry.beltCount, `${label}.beltCount`),
      constructionQueueCount: safeInteger(entry.constructionQueueCount, `${label}.constructionQueueCount`),
      powerFactor: finiteNumber(entry.powerFactor, `${label}.powerFactor`, 0),
    };
  });
  const planetIds = new Set();
  for (const row of planets.rows) {
    if (planetIds.has(row.planetId)) throw protocolError("native factory planets duplicate ID");
    planetIds.add(row.planetId);
  }
  return { schema: "factory-read-model-v1", activePlanetId, planets };
}

function normalizeFactorySelectedEntity(value, label) {
  const source = exactObject(value, [
    "entityId", "planetId", "kind", "position", "interactionLocked", "buildingId",
    "resourceId", "recipeId", "storedItemId", "fuelItemId", "machineCount", "minerCount",
    "progress", "utilization", "productionRate", "powerFactor", "inputItems", "outputItems",
  ], label);
  return {
    entityId: opaqueId(source.entityId, `${label}.entityId`),
    planetId: opaqueId(source.planetId, `${label}.planetId`),
    kind: opaqueId(source.kind, `${label}.kind`),
    position: normalizeReadModelPosition(source.position, `${label}.position`),
    interactionLocked: boolean(source.interactionLocked, `${label}.interactionLocked`),
    buildingId: nullableReadModelId(source.buildingId, `${label}.buildingId`),
    resourceId: nullableReadModelId(source.resourceId, `${label}.resourceId`),
    recipeId: nullableReadModelId(source.recipeId, `${label}.recipeId`),
    storedItemId: nullableReadModelId(source.storedItemId, `${label}.storedItemId`),
    fuelItemId: nullableReadModelId(source.fuelItemId, `${label}.fuelItemId`),
    machineCount: finiteNumber(source.machineCount, `${label}.machineCount`),
    minerCount: finiteNumber(source.minerCount, `${label}.minerCount`),
    progress: finiteNumber(source.progress, `${label}.progress`),
    utilization: finiteNumber(source.utilization, `${label}.utilization`),
    productionRate: finiteNumber(source.productionRate, `${label}.productionRate`),
    powerFactor: nullableReadModelNumber(source.powerFactor, `${label}.powerFactor`),
    inputItems: normalizeReadModelQuantityRows(source.inputItems, `${label}.inputItems`, 32, "itemId"),
    outputItems: normalizeReadModelQuantityRows(source.outputItems, `${label}.outputItems`, 32, "itemId"),
  };
}

function normalizeFactorySelectedBelt(value, label) {
  const source = exactObject(value, [
    "beltId", "planetId", "sourceEntityId", "targetEntityId", "itemId", "lanes", "tier",
    "sorterTier", "stackSize", "priority", "progress", "lastFlow", "totalTransferred", "congestion",
  ], label);
  return {
    beltId: opaqueId(source.beltId, `${label}.beltId`),
    planetId: opaqueId(source.planetId, `${label}.planetId`),
    sourceEntityId: opaqueId(source.sourceEntityId, `${label}.sourceEntityId`),
    targetEntityId: opaqueId(source.targetEntityId, `${label}.targetEntityId`),
    itemId: opaqueId(source.itemId, `${label}.itemId`),
    lanes: finiteNumber(source.lanes, `${label}.lanes`),
    tier: finiteNumber(source.tier, `${label}.tier`),
    sorterTier: finiteNumber(source.sorterTier, `${label}.sorterTier`),
    stackSize: nullableReadModelNumber(source.stackSize, `${label}.stackSize`),
    priority: finiteNumber(source.priority, `${label}.priority`),
    progress: finiteNumber(source.progress, `${label}.progress`),
    lastFlow: finiteNumber(source.lastFlow, `${label}.lastFlow`),
    totalTransferred: nullableReadModelNumber(source.totalTransferred, `${label}.totalTransferred`),
    congestion: nullableReadModelNumber(source.congestion, `${label}.congestion`),
  };
}

function requireFactorySelectionOrder(rows, idKey, requestedIds, label) {
  const order = [];
  const seenRequested = new Set();
  for (const id of requestedIds) {
    if (!seenRequested.has(id)) order.push(id);
    seenRequested.add(id);
  }
  const rank = new Map(order.map((id, index) => [id, index]));
  const seenRows = new Set();
  let previous = -1;
  for (const row of rows) {
    const id = row[idKey];
    const index = rank.get(id);
    if (index === undefined || index <= previous || seenRows.has(id)) throw protocolError(label);
    previous = index;
    seenRows.add(id);
  }
}

function normalizeFactorySelection(value, activePlanetId, context) {
  const source = exactObject(value, [
    "schema", "activePlanetId", "requestedEntityCount", "requestedBeltCount", "entityRows", "beltRows",
  ], "native factory selection");
  if (source.schema !== "factory-read-model-v1" ||
      opaqueId(source.activePlanetId, "native factory selection active planet") !== activePlanetId ||
      safeInteger(source.requestedEntityCount, "native factory requested entity count") !== context.selectedEntityIds.length ||
      safeInteger(source.requestedBeltCount, "native factory requested belt count") !== context.selectedBeltIds.length) {
    throw protocolError("native factory selection request binding");
  }
  const entityRows = normalizeReadModelRows(source.entityRows, "native factory selected entities", 64, normalizeFactorySelectedEntity);
  const beltRows = normalizeReadModelRows(source.beltRows, "native factory selected belts", 64, normalizeFactorySelectedBelt);
  if (entityRows.totalCount !== entityRows.rows.length || beltRows.totalCount !== beltRows.rows.length) {
    throw protocolError("native factory selection cardinality");
  }
  requireFactorySelectionOrder(entityRows.rows, "entityId", context.selectedEntityIds, "native factory entity selection order");
  requireFactorySelectionOrder(beltRows.rows, "beltId", context.selectedBeltIds, "native factory belt selection order");
  return {
    schema: "factory-read-model-v1",
    activePlanetId,
    requestedEntityCount: context.selectedEntityIds.length,
    requestedBeltCount: context.selectedBeltIds.length,
    entityRows,
    beltRows,
  };
}

function normalizeFactoryConstruction(value, activePlanetId) {
  const source = exactObject(value, ["schema", "activePlanetId", "queue", "automation"], "native factory construction");
  if (source.schema !== "factory-read-model-v1" ||
      opaqueId(source.activePlanetId, "native factory construction active planet") !== activePlanetId) {
    throw protocolError("native factory construction identity");
  }
  const queue = normalizeReadModelRows(source.queue, "native factory construction queue", 64, (row, label) => {
    const entry = exactObject(row, [
      "queueId", "blueprintId", "blueprintVersionId", "blueprintRevision", "blueprintName",
      "planetId", "queuedAt", "status", "rotation", "mirror", "placedEntityCount",
      "reservedConstruction", "reservedFleet",
    ], label);
    return {
      queueId: opaqueId(entry.queueId, `${label}.queueId`),
      blueprintId: opaqueId(entry.blueprintId, `${label}.blueprintId`),
      blueprintVersionId: nullableReadModelId(entry.blueprintVersionId, `${label}.blueprintVersionId`),
      blueprintRevision: nullableReadModelNumber(entry.blueprintRevision, `${label}.blueprintRevision`),
      blueprintName: boundedReadModelText(entry.blueprintName, `${label}.blueprintName`, 4_096),
      planetId: opaqueId(entry.planetId, `${label}.planetId`),
      queuedAt: finiteNumber(entry.queuedAt, `${label}.queuedAt`),
      status: oneOf(entry.status, ["pending-materials", "waiting-fleet"], `${label}.status`),
      rotation: finiteNumber(entry.rotation, `${label}.rotation`),
      mirror: boundedReadModelText(entry.mirror, `${label}.mirror`, 128, 1),
      placedEntityCount: safeInteger(entry.placedEntityCount, `${label}.placedEntityCount`),
      reservedConstruction: normalizeReadModelQuantityRows(
        entry.reservedConstruction,
        `${label}.reservedConstruction`,
        32,
        "constructionId",
      ),
      reservedFleet: normalizeReadModelQuantityRows(entry.reservedFleet, `${label}.reservedFleet`, 32, "itemId"),
    };
  });
  const queueIds = new Set();
  for (const row of queue.rows) {
    if (queueIds.has(row.queueId)) throw protocolError("native factory construction queue duplicate ID");
    queueIds.add(row.queueId);
  }
  const automationSource = exactObject(source.automation, [
    "enabled", "quantumSourceEnabled", "totalCrafted", "lastCraftedId", "targets", "jobs", "destroyedByproducts",
  ], "native factory construction automation");
  const targets = normalizeReadModelQuantityRows(automationSource.targets, "native factory construction targets", 128, "targetId");
  const jobs = normalizeReadModelRows(automationSource.jobs, "native factory construction jobs", 64, (row, label) => {
    const entry = exactObject(row, [
      "entityId", "constructionId", "stepIndex", "stepCount", "elapsedSeconds", "inventory",
    ], label);
    return {
      entityId: opaqueId(entry.entityId, `${label}.entityId`),
      constructionId: opaqueId(entry.constructionId, `${label}.constructionId`),
      stepIndex: finiteNumber(entry.stepIndex, `${label}.stepIndex`),
      stepCount: safeInteger(entry.stepCount, `${label}.stepCount`),
      elapsedSeconds: finiteNumber(entry.elapsedSeconds, `${label}.elapsedSeconds`),
      inventory: normalizeReadModelQuantityRows(entry.inventory, `${label}.inventory`, 32, "itemId"),
    };
  });
  const jobEntityIds = new Set();
  for (const row of jobs.rows) {
    if (jobEntityIds.has(row.entityId)) throw protocolError("native factory construction jobs duplicate entity");
    jobEntityIds.add(row.entityId);
  }
  const destroyedByproducts = normalizeReadModelQuantityRows(
    automationSource.destroyedByproducts,
    "native factory destroyed byproducts",
    32,
    "itemId",
  );
  return {
    schema: "factory-read-model-v1",
    activePlanetId,
    queue,
    automation: {
      enabled: boolean(automationSource.enabled, "native factory automation enabled"),
      quantumSourceEnabled: boolean(automationSource.quantumSourceEnabled, "native factory automation quantum source"),
      totalCrafted: finiteNumber(automationSource.totalCrafted, "native factory automation total crafted"),
      lastCraftedId: nullableReadModelId(automationSource.lastCraftedId, "native factory automation last crafted ID"),
      targets,
      jobs,
      destroyedByproducts,
    },
  };
}

function normalizeCoreFactoryReadModelProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "shell", "planetNavigation", "selection", "construction",
  ], "native factory read-model projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "factory-read-model-v1") {
    throw protocolError("native factory read-model identity");
  }
  requireProjectionByteBudget(source, "native factory read-model projection");
  const projectionContext = normalizeFactoryReadModelContext(context, "native factory read-model context");
  const revision = safeInteger(source.revision, "native factory read-model revision");
  if (revision !== projectionContext.expectedRevision || !projectionContext.sessionId) {
    throw protocolError("native factory read-model revision binding");
  }
  const shell = normalizeFactoryShellReadModel(source.shell);
  const planetNavigation = normalizeFactoryPlanetNavigation(source.planetNavigation, shell.activePlanetId);
  const selection = normalizeFactorySelection(source.selection, shell.activePlanetId, projectionContext);
  const construction = normalizeFactoryConstruction(source.construction, shell.activePlanetId);
  if (construction.queue.totalCount !== shell.constructionQueueCount) {
    throw protocolError("native factory construction queue binding");
  }
  for (const row of planetNavigation.planets.rows) {
    if (row.entityCount > shell.entityCount || row.beltCount > shell.beltCount ||
        row.constructionQueueCount > shell.constructionQueueCount) {
      throw protocolError("native factory planet count binding");
    }
    if (row.active && (row.entityCount !== shell.activePlanetEntityCount ||
        row.beltCount !== shell.activePlanetBeltCount)) {
      throw protocolError("native factory active planet count binding");
    }
  }
  return {
    schemaVersion: 1,
    projectionType: "factory-read-model-v1",
    revision,
    shell,
    planetNavigation,
    selection,
    construction,
  };
}

function normalizeCoreStatisticsProjection(value, context) {
  const source = exactObject(value, ["schemaVersion", "projectionType", "revision", "window", "filters", "samples", "nextCursor"], "native statistics projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "statistics-v1") throw protocolError("native statistics projection identity");
  const projectionContext = normalizeStatisticsProjectionContext(context, "native statistics projection context");
  const window = exactObject(source.window, ["minElapsedSeconds", "maxElapsedSeconds"], "native statistics window");
  const minElapsedSeconds = finiteNumber(window.minElapsedSeconds, "native statistics minimum elapsed seconds");
  const maxElapsedSeconds = finiteNumber(window.maxElapsedSeconds, "native statistics maximum elapsed seconds");
  if (maxElapsedSeconds < minElapsedSeconds || minElapsedSeconds !== projectionContext.minElapsedSeconds ||
      maxElapsedSeconds !== projectionContext.maxElapsedSeconds) throw protocolError("native statistics window binding");
  const filters = exactObject(source.filters, ["planetId", "itemId"], "native statistics filters");
  const optionalId = (entry, label) => entry === null ? null : logicalId(entry, label, 256);
  const planetId = optionalId(filters.planetId, "native statistics planet");
  const itemId = optionalId(filters.itemId, "native statistics item");
  if (planetId !== projectionContext.planetId || itemId !== projectionContext.itemId) {
    throw protocolError("native statistics filter binding");
  }
  if (!Array.isArray(source.samples) || source.samples.length > projectionContext.limit) throw protocolError("native statistics samples");
  const budget = projectionBudget();
  const samples = source.samples.map((entry, index) => normalizeProductionHistorySample(entry, `native statistics samples[${index}]`, budget));
  if (samples.some((sample) => sample.elapsedSeconds < minElapsedSeconds || sample.elapsedSeconds > maxElapsedSeconds)) {
    throw protocolError("native statistics sample window binding");
  }
  const nextCursor = source.nextCursor === null ? null : safeInteger(source.nextCursor, "native statistics cursor");
  if (nextCursor !== null && nextCursor !== projectionContext.cursor + samples.length) {
    throw protocolError("native statistics cursor binding");
  }
  return {
    schemaVersion: 1, projectionType: "statistics-v1", revision: safeInteger(source.revision, "native statistics revision"),
    window: { minElapsedSeconds, maxElapsedSeconds },
    filters: { planetId, itemId },
    samples,
    nextCursor,
  };
}

function normalizeCoreCommand(value) {
  const source = exactObject(value, ["previousRevision", "revision", "changedEntityIds", "changedBeltIds", "topologyDirty"], "native core command result");
  const previousRevision = safeInteger(source.previousRevision, "native command previous revision");
  const revision = safeInteger(source.revision, "native command revision");
  if (revision < previousRevision) throw protocolError("native command revision chain");
  const changedEntityIds = stableOpaqueIdArray(source.changedEntityIds, "native changed entity IDs");
  const changedBeltIds = stableOpaqueIdArray(source.changedBeltIds, "native changed belt IDs");
  if (changedEntityIds.length + changedBeltIds.length > 65_536) throw protocolError("native changed ID budget");
  return { previousRevision, revision, changedEntityIds, changedBeltIds, topologyDirty: boolean(source.topologyDirty, "native topology dirty flag") };
}

function normalizeBeltScheduler(value) {
  const keys = ["routeCount", "groupCount", "activeQueueEnabled", "initializationGroupChecks", "selectionGroupChecks", "carriedActiveGroups", "transferPasses", "reservationPasses", "fullScanPasses", "transferRouteChecks", "reservationRouteChecks", "reservationAllowanceEntries", "reservationCreditEntries", "stableRoutesSkipped", "wakeCount", "sleepCount", "changedBeltRecords", "writeBackPatchRecords", "writeBackWorkers"];
  const source = exactObject(value, keys, "native belt scheduler diagnostics");
  return Object.fromEntries(keys.map((key) => [key, key === "activeQueueEnabled" ? boolean(source[key], `native belt scheduler.${key}`) : safeInteger(source[key], `native belt scheduler.${key}`)]));
}

function normalizeCoreAdvance(value) {
  const source = objectWithKeys(value, ["supported", "exactScope", "changed", "previousRevision", "revision"], ["reason", "algorithmVersion", "exactCalibrationSeconds", "approximatedSeconds", "beltScheduler", "summary"], "native core advance result");
  const result = {
    supported: boolean(source.supported, "native advance supported flag"),
    exactScope: oneOf(source.exactScope, ["no-change", "clock-only", "simple-factory-v1", "pure-idle-bounded-exact", "pure-idle-conservative-v2", "pure-idle-macro-v10", "unsupported-domain"], "native advance exact scope"),
    changed: boolean(source.changed, "native advance changed flag"),
    previousRevision: safeInteger(source.previousRevision, "native advance previous revision"),
    revision: safeInteger(source.revision, "native advance revision"),
  };
  if (result.revision < result.previousRevision) throw protocolError("native advance revision chain");
  if (source.reason !== undefined) result.reason = publicReason(source.reason);
  if (source.algorithmVersion !== undefined) result.algorithmVersion = safeToken(source.algorithmVersion, "native advance algorithm", 160);
  if (source.exactCalibrationSeconds !== undefined) result.exactCalibrationSeconds = finiteNumber(source.exactCalibrationSeconds, "native exact calibration seconds");
  if (source.approximatedSeconds !== undefined) result.approximatedSeconds = finiteNumber(source.approximatedSeconds, "native approximated seconds");
  if (source.beltScheduler !== undefined) result.beltScheduler = normalizeBeltScheduler(source.beltScheduler);
  if (source.summary !== undefined) {
    result.summary = normalizeCoreSummary(source.summary);
    if (result.summary.revision !== result.revision) throw protocolError("native advance summary revision");
  }
  return result;
}

function normalizeCoreCommit(value) {
  const source = objectWithKeys(value, ["commandId", "baseRevision", "revision", "currentRevision", "entryHash", "walBytes", "duplicate"], ["summary"], "native core commit result");
  const result = {
    commandId: logicalId(source.commandId, "native commit command ID", 128),
    baseRevision: safeInteger(source.baseRevision, "native commit base revision"),
    revision: safeInteger(source.revision, "native commit revision"),
    currentRevision: safeInteger(source.currentRevision, "native current revision"),
    entryHash: sha256(source.entryHash, "native commit entry hash"),
    walBytes: safeInteger(source.walBytes, "native commit WAL bytes"),
    duplicate: boolean(source.duplicate, "native commit duplicate flag"),
  };
  if (result.revision <= result.baseRevision || result.currentRevision < result.revision) throw protocolError("native commit revision chain");
  if (source.summary !== undefined) {
    result.summary = normalizeCoreSummary(source.summary);
    if (result.summary.revision !== result.currentRevision) throw protocolError("native commit summary revision");
  }
  return result;
}

function normalizeCoreCheckpoint(value) {
  const source = exactObject(value, ["checkpoint", "summary", "encodedRecords", "reusedRecords"], "native core checkpoint result");
  const checkpoint = normalizeSaveCommit(source.checkpoint);
  const summary = normalizeCoreSummary(source.summary);
  if (checkpoint.revision !== summary.revision) throw protocolError("native checkpoint summary revision");
  return { checkpoint, summary, encodedRecords: safeInteger(source.encodedRecords, "native checkpoint encoded records"), reusedRecords: safeInteger(source.reusedRecords, "native checkpoint reused records") };
}

function normalizeCoreExport(value) {
  const source = exactObject(value, ["exportId", "mode", "result"], "native core v47 export result");
  const proof = exactObject(source.result, ["revision", "savedAtMs", "byteLength", "envelopeSha256", "stateChecksum"], "native v47 export proof");
  return {
    exportId: logicalId(source.exportId, "native export ID", 128),
    mode: oneOf(source.mode, ["normal", "speedrun"], "native export mode"),
    result: {
      revision: safeInteger(proof.revision, "native export revision"), savedAtMs: safeInteger(proof.savedAtMs, "native export timestamp"),
      byteLength: safeInteger(proof.byteLength, "native export bytes", 1), envelopeSha256: sha256(proof.envelopeSha256, "native export envelope hash"),
      stateChecksum: checksum(proof.stateChecksum, "native export state checksum"),
    },
  };
}

function normalizeCoreCompare(value) {
  const source = exactObject(value, ["matches", "revisionMatches", "canonicalMatches", "domainMatches", "promotionBlocked", "summary"], "native core comparison result");
  return {
    matches: boolean(source.matches, "native comparison match flag"),
    revisionMatches: boolean(source.revisionMatches, "native comparison revision flag"),
    canonicalMatches: boolean(source.canonicalMatches, "native comparison canonical flag"),
    domainMatches: boolean(source.domainMatches, "native comparison domain flag"),
    promotionBlocked: boolean(source.promotionBlocked, "native comparison promotion flag"),
    summary: normalizeCoreSummary(source.summary),
  };
}

function normalizeCoreClose(value) {
  const source = exactObject(value, ["closed"], "native core close result");
  return { closed: boolean(source.closed, "native core closed flag") };
}

function normalizePlayerAuthorityState(value) {
  const source = exactObject(value, [
    "schemaVersion", "phase", "sessionId", "runId", "revision", "acknowledgedSequence",
    "nextSequence", "nextDeadlineMs", "inFlight", "currentOperation", "queuedCommands",
    "lastErrorCode",
  ], "native player-authority state");
  if (source.schemaVersion !== 1) throw protocolError("native player-authority state schema");
  const phase = oneOf(source.phase, [
    "idle", "activating", "recovering", "active", "uncertain", "faulted", "shutdown",
  ], "native player-authority phase");
  const nullableLogicalId = (entry, label) => entry === null ? null : logicalId(entry, label, 128);
  const nullableInteger = (entry, label, minimum) => entry === null
    ? null
    : safeInteger(entry, label, minimum);
  const sessionId = nullableLogicalId(source.sessionId, "native player-authority session ID");
  const runId = nullableLogicalId(source.runId, "native player-authority run ID");
  const revision = nullableInteger(source.revision, "native player-authority revision", 0);
  const acknowledgedSequence = nullableInteger(
    source.acknowledgedSequence,
    "native player-authority acknowledged sequence",
    0,
  );
  const nextSequence = nullableInteger(
    source.nextSequence,
    "native player-authority next sequence",
    1,
  );
  const nextDeadlineMs = nullableInteger(
    source.nextDeadlineMs,
    "native player-authority next deadline",
    0,
  );
  const currentOperation = oneOf(source.currentOperation, [
    null, "activation", "recovery", "tick", "command",
  ], "native player-authority operation");
  const queuedCommands = safeInteger(
    source.queuedCommands,
    "native player-authority queued commands",
  );
  if (queuedCommands > 64) throw protocolError("native player-authority queued commands");
  const lastErrorCode = source.lastErrorCode === null
    ? null
    : requireNativeErrorCode(source.lastErrorCode, "native player-authority error code");
  const identity = [sessionId, runId, revision, acknowledgedSequence, nextSequence, nextDeadlineMs];
  const completeIdentity = identity.every((entry) => entry !== null);
  const emptyIdentity = identity.every((entry) => entry === null);
  if ((!completeIdentity && !emptyIdentity) ||
      completeIdentity && acknowledgedSequence + 1 !== nextSequence ||
      phase === "active" && (!completeIdentity || lastErrorCode !== null) ||
      ["idle", "activating", "recovering"].includes(phase) && !emptyIdentity) {
    throw protocolError("native player-authority state identity");
  }
  return {
    schemaVersion: 1,
    phase,
    sessionId,
    runId,
    revision,
    acknowledgedSequence,
    nextSequence,
    nextDeadlineMs,
    inFlight: boolean(source.inFlight, "native player-authority in-flight flag"),
    currentOperation,
    queuedCommands,
    lastErrorCode,
  };
}

const RESULT_NORMALIZERS = Object.freeze({
  hostHello: normalizeHostHello,
  nativeStatus: normalizeNativeStatus,
  performancePolicy: normalizePerformancePolicy,
  saveBegin: normalizeSaveBegin,
  saveWrite: normalizeSaveWrite,
  saveCommit: normalizeSaveCommit,
  saveAbort: normalizeSaveAbort,
  saveRecovery: normalizeSaveRecovery,
  saveRead: normalizeSaveRead,
  walAppend: normalizeWalAppend,
  saveCompact: normalizeSaveCompact,
  coreOpen: normalizeCoreOpen,
  coreImport: normalizeCoreImport,
  coreSummary: normalizeCoreSummary,
  coreProjection: normalizeCoreProjection,
  coreViewportProjection: normalizeCoreViewportProjection,
  coreViewportProjectionV2: normalizeCoreViewportProjectionV2,
  coreFactoryReadModelProjection: normalizeCoreFactoryReadModelProjection,
  coreStatisticsProjection: normalizeCoreStatisticsProjection,
  coreCommand: normalizeCoreCommand,
  coreAdvance: normalizeCoreAdvance,
  coreCommit: normalizeCoreCommit,
  coreCheckpoint: normalizeCoreCheckpoint,
  coreExport: normalizeCoreExport,
  coreCompare: normalizeCoreCompare,
  coreClose: normalizeCoreClose,
  playerAuthorityState: normalizePlayerAuthorityState,
});

function normalizeRendererNativeResult(kind, value, context) {
  const normalize = RESULT_NORMALIZERS[kind];
  if (typeof normalize !== "function") throw new TypeError("renderer native result kind is invalid");
  return normalize(value, context);
}
module.exports = {
  CORE_COVERAGE_KEYS,
  NATIVE_ERROR_CODE_PATTERN,
  PUBLIC_NATIVE_ERROR_CODES,
  createRendererNativeError,
  createRendererNativeRejection,
  normalizeRendererNativeResult,
  rendererNativeErrorCode,
  serializeRendererNativeError,
};
