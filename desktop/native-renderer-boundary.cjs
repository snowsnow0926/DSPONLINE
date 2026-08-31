"use strict";

const NATIVE_ERROR_CODE_PATTERN = /^NATIVE_[A-Z0-9_]{1,95}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{8,64}$/;
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const NATIVE_CATALOG_ID_PATTERN = /^[A-Za-z0-9_.:/-]+$/;
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
  "stationMinimumLoad", "stationSlots", "stationDispatchCursor",
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

const FACTORY_NODE_PRESENTATION_STATUS_CODES = Object.freeze([
  "running", "idle", "paused", "missing-recipe", "missing-research", "missing-input",
  "output-blocked", "no-power", "low-power", "missing-fuel", "resource-depleted",
  "missing-proliferator", "no-fuel-selected", "grid-standby", "missing-route", "fleet-busy",
  "missing-vessel", "missing-drone", "missing-warper", "missing-hub", "waiting-load",
  "waiting-route", "collecting", "missing-dyson-swarm", "missing-dyson-orbit", "launch-paused",
  "unconfigured",
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
  "NATIVE_CORE_COMMAND_FAILED", "NATIVE_CORE_COMMAND_RECONCILE_FAILED",
  "NATIVE_CORE_CAPABILITY_MISSING",
  "NATIVE_CORE_COMMIT_FAILED", "NATIVE_CORE_COMPARE_FAILED",
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
  "NATIVE_PLAYER_AUTHORITY_STATE_FAILED", "NATIVE_PLAYER_AUTHORITY_MACRO_FAILED",
  "NATIVE_PLAYER_AUTHORITY_MACRO_BUSY", "NATIVE_PLAYER_AUTHORITY_MACRO_UNCERTAIN",
  "NATIVE_PLAYER_AUTHORITY_PAUSE_FAILED", "NATIVE_PLAYER_AUTHORITY_PAUSE_BUSY",
  "NATIVE_PLAYER_AUTHORITY_PAUSE_INVALID", "NATIVE_PLAYER_AUTHORITY_PAUSE_RECEIPT_INVALID",
  "NATIVE_PLAYER_AUTHORITY_PAUSE_REQUEST_INVALID", "NATIVE_PLAYER_AUTHORITY_PAUSE_UNAVAILABLE",
  "NATIVE_PLAYER_AUTHORITY_PAUSE_UNCERTAIN", "NATIVE_PLAYER_AUTHORITY_RESUME_UNCERTAIN",
  "NATIVE_PLAYER_AUTHORITY_CHECKPOINT_FAILED", "NATIVE_PLAYER_AUTHORITY_EXPORT_FAILED",
  "NATIVE_PLAYER_AUTHORITY_MACRO_START_REBASE_REQUIRED",
  "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_BUSY", "NATIVE_PLAYER_AUTHORITY_PERSISTENCE_STALE",
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
function stableLogicalIdArray(value, label, maximumEntries, maximumLength = 160) {
  const ids = logicalIdArray(value, label, maximumEntries, maximumLength);
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1] >= ids[index]) throw protocolError(label);
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
  const source = objectWithKeys(value, [
    "sessionId", "expectedRevision", "baseFields", "planetId", "bounds",
    "entityCursor", "entityLimit", "beltCursor", "beltLimit",
    "pinnedEntityIds", "pinnedBeltIds",
  ], ["entityPresentationVersion"], label);
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
    entityPresentationVersion: source.entityPresentationVersion === undefined
      ? undefined
      : oneOf(source.entityPresentationVersion, [1], `${label} entity presentation version`),
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

function normalizeFactoryInventoryContext(value, label) {
  const source = exactObject(
    value,
    ["sessionId", "expectedRevision", "cursor", "limit"],
    label,
  );
  const limit = safeInteger(source.limit, `${label} limit`, 1);
  if (limit > 256) throw protocolError(`${label} limit`);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    cursor: safeInteger(source.cursor, `${label} cursor`),
    limit,
  };
}

function normalizeConstructionInventoryContext(value, label) {
  const source = exactObject(
    value,
    ["sessionId", "expectedRevision", "expectedRegistryFingerprint", "cursor", "limit"],
    label,
  );
  const limit = safeInteger(source.limit, `${label} limit`, 1);
  if (limit > 256) throw protocolError(`${label} limit`);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} expected registry fingerprint`,
      256,
    ),
    cursor: safeInteger(source.cursor, `${label} cursor`),
    limit,
  };
}

function normalizeBlueprintWorkspaceContext(value, label) {
  const source = exactObject(
    value,
    [
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "section",
      "blueprintId", "queueEntryId", "cursor", "limit",
    ],
    label,
  );
  const section = oneOf(
    source.section,
    ["library", "detail", "queue", "queue-membership"],
    `${label} section`,
  );
  const blueprintId = source.blueprintId === null
    ? null
    : blueprintOpaqueText(source.blueprintId, `${label} blueprint ID`, 512);
  const queueEntryId = source.queueEntryId === null
    ? null
    : blueprintOpaqueText(source.queueEntryId, `${label} queue entry ID`, 512);
  const cursor = safeInteger(source.cursor, `${label} cursor`);
  if (cursor > 4_096 || (section === "detail") !== (blueprintId !== null) ||
      (section === "queue-membership") !== (queueEntryId !== null) ||
      ["detail", "queue-membership"].includes(section) && cursor !== 0 ||
      source.limit !== 32) throw protocolError(`${label} selector`);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} expected registry fingerprint`,
      256,
    ),
    section,
    blueprintId,
    queueEntryId,
    cursor,
    limit: 32,
  };
}

function normalizeBlueprintEnqueueContext(value, label) {
  const source = exactObject(
    value,
    [
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "blueprintId",
      "blueprintRevision",
    ],
    label,
  );
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} expected registry fingerprint`,
      256,
    ),
    blueprintId: blueprintOpaqueText(source.blueprintId, `${label} blueprint ID`, 512),
    blueprintRevision: safeInteger(
      source.blueprintRevision,
      `${label} blueprint revision`,
      1,
    ),
  };
}

function normalizeConstructionPlacementContext(value, label) {
  const source = exactObject(
    value,
    ["sessionId", "expectedRevision", "expectedRegistryFingerprint", "buildingId"],
    label,
  );
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} expected registry fingerprint`,
      256,
    ),
    buildingId: factoryInventoryId(source.buildingId, `${label} building ID`),
  };
}

function normalizeConstructionBeltPlacementContext(value, label) {
  const source = exactObject(
    value,
    [
      "sessionId", "expectedRevision", "expectedRegistryFingerprint", "sourceId", "targetId",
      "itemId", "tier", "lanes",
    ],
    label,
  );
  const tier = safeInteger(source.tier, `${label} tier`, 1);
  const lanes = safeInteger(source.lanes, `${label} lanes`);
  if (tier > 255) throw protocolError(`${label} tier`);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} expected registry fingerprint`,
      256,
    ),
    sourceId: factoryInventoryId(source.sourceId, `${label} source ID`),
    targetId: factoryInventoryId(source.targetId, `${label} target ID`),
    itemId: factoryInventoryId(source.itemId, `${label} item ID`),
    tier,
    lanes,
  };
}

function normalizeConstructionBeltRemovalContext(value, label) {
  const source = exactObject(
    value,
    ["sessionId", "expectedRevision", "expectedRegistryFingerprint", "beltId"],
    label,
  );
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} expected registry fingerprint`,
      256,
    ),
    beltId: factoryInventoryId(source.beltId, `${label} belt ID`),
  };
}

function normalizeConstructionBeltLaneContext(value, label) {
  const source = exactObject(
    value,
    ["sessionId", "expectedRevision", "expectedRegistryFingerprint", "beltId", "targetLanes"],
    label,
  );
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} expected registry fingerprint`,
      256,
    ),
    beltId: factoryInventoryId(source.beltId, `${label} belt ID`),
    targetLanes: safeInteger(source.targetLanes, `${label} target lanes`),
  };
}

function normalizeConstructionRemovalContext(value, label) {
  const source = exactObject(
    value,
    ["sessionId", "expectedRevision", "expectedRegistryFingerprint", "entityId"],
    label,
  );
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} expected registry fingerprint`,
      256,
    ),
    entityId: factoryInventoryId(source.entityId, `${label} entity ID`),
  };
}

function normalizeConstructionStackContext(value, label) {
  const source = exactObject(
    value,
    ["sessionId", "expectedRevision", "expectedRegistryFingerprint", "entityId", "targetCount"],
    label,
  );
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} expected registry fingerprint`,
      256,
    ),
    entityId: factoryInventoryId(source.entityId, `${label} entity ID`),
    targetCount: safeInteger(source.targetCount, `${label} target count`, 1),
  };
}

function factoryInventoryId(value, label) {
  const result = opaqueId(value, label);
  for (const character of result) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      throw protocolError(label);
    }
  }
  return result;
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

function normalizeTechnologyProjectionContext(value, label) {
  const source = exactObject(value, ["sessionId", "expectedRevision"], label);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
  };
}

function normalizeRecipeWorkspaceProjectionContext(value, label) {
  const source = exactObject(value, [
    "sessionId", "expectedRevision", "expectedRegistryFingerprint", "itemIds",
    "selectedItemId", "location",
  ], label);
  const itemIds = opaqueIdArray(source.itemIds, `${label} item IDs`, 256);
  const location = source.location === null ? null : (() => {
    const entry = exactObject(source.location, ["planetId", "cursor", "limit"], `${label} location`);
    const limit = safeInteger(entry.limit, `${label} location limit`, 1);
    if (limit > 4_096) throw protocolError(`${label} location limit`);
    return {
      planetId: opaqueId(entry.planetId, `${label} location planet`),
      cursor: safeInteger(entry.cursor, `${label} location cursor`),
      limit,
    };
  })();
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} registry fingerprint`,
      256,
    ),
    itemIds,
    selectedItemId: opaqueId(source.selectedItemId, `${label} selected item`),
    location,
  };
}

function normalizeCommandPaletteEntitySearchContext(value, label) {
  const source = exactObject(value, [
    "sessionId", "expectedRevision", "expectedRegistryFingerprint", "query", "cursor",
    "limit", "buildingIds", "resourceIds", "planetIds",
  ], label);
  let encoded;
  try {
    encoded = JSON.stringify(source);
  } catch {
    throw protocolError(`${label} byte budget`);
  }
  if (Buffer.byteLength(encoded, "utf8") > 32_768) throw protocolError(`${label} byte budget`);
  const query = boundedReadModelText(source.query, `${label} query`, 256, 1);
  const buildingIds = stableLogicalIdArray(source.buildingIds, `${label} building IDs`, 256);
  const resourceIds = stableLogicalIdArray(source.resourceIds, `${label} resource IDs`, 256);
  const planetIds = stableLogicalIdArray(source.planetIds, `${label} planet IDs`, 256);
  const limit = safeInteger(source.limit, `${label} limit`, 1);
  if (query.length < 2 || Buffer.byteLength(query, "utf8") > 256 ||
      query.trim() !== query || query.toLocaleLowerCase("zh-CN") !== query ||
      /[\u0000-\u001f\u007f]/.test(query) || limit > 16 ||
      buildingIds.length + resourceIds.length + planetIds.length > 256) {
    throw protocolError(label);
  }
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} registry fingerprint`,
      256,
    ),
    query,
    cursor: safeInteger(source.cursor, `${label} cursor`),
    limit,
    buildingIds,
    resourceIds,
    planetIds,
  };
}

function requireStellarRequestByteBudget(source, label) {
  let encoded;
  try {
    encoded = JSON.stringify(source);
  } catch {
    throw protocolError(`${label} byte budget`);
  }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > 32_768) {
    throw protocolError(`${label} byte budget`);
  }
}

function stellarPageLimit(value, label) {
  const limit = safeInteger(value, label, 1);
  if (limit > 64) throw protocolError(label);
  return limit;
}

function stellarCursor(value, label) {
  const cursor = safeInteger(value, label);
  if (cursor > 0xffff_ffff) throw protocolError(label);
  return cursor;
}

function normalizeStarMapOverviewProjectionContext(value, label) {
  const source = exactObject(value, [
    "sessionId", "expectedRevision", "expectedRegistryFingerprint", "cursor", "limit",
  ], label);
  requireStellarRequestByteBudget(source, label);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} registry fingerprint`,
      256,
    ),
    cursor: stellarCursor(source.cursor, `${label} cursor`),
    limit: stellarPageLimit(source.limit, `${label} limit`),
  };
}

function normalizeStarMapCatalogProjectionContext(value, label) {
  const source = exactObject(value, [
    "sessionId", "expectedRevision", "expectedRegistryFingerprint", "systemCursor",
    "systemLimit", "planetCursor", "planetLimit",
  ], label);
  requireStellarRequestByteBudget(source, label);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} registry fingerprint`,
      256,
    ),
    systemCursor: stellarCursor(source.systemCursor, `${label} system cursor`),
    systemLimit: stellarPageLimit(source.systemLimit, `${label} system limit`),
    planetCursor: stellarCursor(source.planetCursor, `${label} planet cursor`),
    planetLimit: stellarPageLimit(source.planetLimit, `${label} planet limit`),
  };
}

function normalizeStellarIndustryProjectionContext(value, label) {
  const source = exactObject(value, [
    "sessionId", "expectedRevision", "expectedRegistryFingerprint", "systemId", "planetId",
    "planetCursor", "planetLimit", "stationCursor", "stationLimit",
  ], label);
  requireStellarRequestByteBudget(source, label);
  const optionalId = (entry, entryLabel) => entry === null ? null : opaqueId(entry, entryLabel);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} registry fingerprint`,
      256,
    ),
    systemId: optionalId(source.systemId, `${label} system`),
    planetId: optionalId(source.planetId, `${label} planet`),
    planetCursor: stellarCursor(source.planetCursor, `${label} planet cursor`),
    planetLimit: stellarPageLimit(source.planetLimit, `${label} planet limit`),
    stationCursor: stellarCursor(source.stationCursor, `${label} station cursor`),
    stationLimit: stellarPageLimit(source.stationLimit, `${label} station limit`),
  };
}

function normalizeStellarIndustryV2ProjectionContext(value, label) {
  const source = exactObject(value, [
    "sessionId", "expectedRevision", "expectedRegistryFingerprint", "systemId", "planetId",
    "planetCursor", "planetLimit", "stationCursor", "stationLimit", "routeCursor",
    "routeLimit", "routeFilter", "query",
  ], label);
  requireStellarRequestByteBudget(source, label);
  const base = normalizeStellarIndustryProjectionContext({
    sessionId: source.sessionId,
    expectedRevision: source.expectedRevision,
    expectedRegistryFingerprint: source.expectedRegistryFingerprint,
    systemId: source.systemId,
    planetId: source.planetId,
    planetCursor: source.planetCursor,
    planetLimit: source.planetLimit,
    stationCursor: source.stationCursor,
    stationLimit: source.stationLimit,
  }, label);
  if (typeof source.query !== "string" || Buffer.byteLength(source.query, "utf8") > 512 ||
      /\p{Cc}/u.test(source.query)) {
    throw protocolError(`${label} query`);
  }
  return {
    ...base,
    routeCursor: stellarCursor(source.routeCursor, `${label} route cursor`),
    routeLimit: stellarPageLimit(source.routeLimit, `${label} route limit`),
    routeFilter: oneOf(source.routeFilter, ["all", "remote", "issues"], `${label} route filter`),
    query: source.query,
  };
}

function normalizeStellarQuantumProjectionContext(value, label) {
  const source = exactObject(value, [
    "sessionId", "expectedRevision", "expectedRegistryFingerprint", "itemCursor", "itemLimit",
    "collectorCursor", "collectorLimit",
  ], label);
  requireStellarRequestByteBudget(source, label);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} registry fingerprint`,
      256,
    ),
    itemCursor: stellarCursor(source.itemCursor, `${label} item cursor`),
    itemLimit: stellarPageLimit(source.itemLimit, `${label} item limit`),
    collectorCursor: stellarCursor(source.collectorCursor, `${label} collector cursor`),
    collectorLimit: stellarPageLimit(source.collectorLimit, `${label} collector limit`),
  };
}

function normalizeDysonWorkspaceProjectionContext(value, label) {
  const source = exactObject(value, [
    "sessionId", "expectedRevision", "expectedRegistryFingerprint", "selectedSystemId",
    "systemCursor", "systemLimit", "layerCursor", "layerLimit", "orbitCursor",
    "orbitLimit", "nodeCursor", "nodeLimit", "frameCursor", "frameLimit",
    "shellCursor", "shellLimit",
  ], label);
  requireStellarRequestByteBudget(source, label);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    expectedRevision: safeInteger(source.expectedRevision, `${label} expected revision`),
    expectedRegistryFingerprint: logicalId(
      source.expectedRegistryFingerprint,
      `${label} registry fingerprint`,
      256,
    ),
    selectedSystemId: dysonId(source.selectedSystemId, `${label} selected system`),
    systemCursor: stellarCursor(source.systemCursor, `${label} system cursor`),
    systemLimit: stellarPageLimit(source.systemLimit, `${label} system limit`),
    layerCursor: stellarCursor(source.layerCursor, `${label} layer cursor`),
    layerLimit: stellarPageLimit(source.layerLimit, `${label} layer limit`),
    orbitCursor: stellarCursor(source.orbitCursor, `${label} orbit cursor`),
    orbitLimit: stellarPageLimit(source.orbitLimit, `${label} orbit limit`),
    nodeCursor: stellarCursor(source.nodeCursor, `${label} node cursor`),
    nodeLimit: stellarPageLimit(source.nodeLimit, `${label} node limit`),
    frameCursor: stellarCursor(source.frameCursor, `${label} frame cursor`),
    frameLimit: stellarPageLimit(source.frameLimit, `${label} frame limit`),
    shellCursor: stellarCursor(source.shellCursor, `${label} shell cursor`),
    shellLimit: stellarPageLimit(source.shellLimit, `${label} shell limit`),
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

function normalizeFactoryNodeResourceReserve(value, label) {
  if (value === null) return null;
  const source = exactObject(value, [
    "infinite", "exhausted", "remaining", "capacity", "remainingRatio", "remainingPercent",
  ], label);
  const infinite = boolean(source.infinite, `${label}.infinite`);
  const exhausted = boolean(source.exhausted, `${label}.exhausted`);
  const remaining = source.remaining === null ? null : safeInteger(source.remaining, `${label}.remaining`);
  const capacity = source.capacity === null ? null : safeInteger(source.capacity, `${label}.capacity`);
  const remainingRatio = finiteNumber(source.remainingRatio, `${label}.remainingRatio`);
  const remainingPercent = finiteNumber(source.remainingPercent, `${label}.remainingPercent`);
  if (remainingRatio > 1 || remainingPercent > 100 ||
      (infinite && (exhausted || remaining !== null || capacity !== null || remainingRatio !== 1 || remainingPercent !== 100)) ||
      (!infinite && (remaining === null || capacity === null || remaining > capacity))) {
    throw protocolError(label);
  }
  return { infinite, exhausted, remaining, capacity, remainingRatio, remainingPercent };
}

function normalizeFactoryNodePresentation(value, entity, index) {
  const label = `native viewport v2 entity presentation[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw protocolError(label);
  const supported = boolean(value.supported, `${label}.supported`);
  const source = exactObject(value, supported
    ? [
        "entityId", "supported", "coverage", "status", "powerFactor", "resourceReserve",
        "outputCapacity", "cycleRatePerSecond", "acceptedInputItemIds", "producedOutputItemIds",
        "targetDysonOrbitLabel",
      ]
    : ["entityId", "supported"], label);
  const entityId = opaqueId(source.entityId, `${label}.entityId`);
  if (entityId !== entity.id) throw protocolError(`${label}.entityId`);
  if (!supported) return { entityId, supported: false };

  const statusSource = exactObject(source.status, ["code", "label", "tone"], `${label}.status`);
  const status = {
    code: oneOf(statusSource.code, FACTORY_NODE_PRESENTATION_STATUS_CODES, `${label}.status.code`),
    label: boundedString(statusSource.label, `${label}.status.label`, 256),
    tone: oneOf(statusSource.tone, ["running", "warning", "blocked", "idle"], `${label}.status.tone`),
  };
  const powerFactor = finiteNumber(source.powerFactor, `${label}.powerFactor`);
  if (powerFactor > 1) throw protocolError(`${label}.powerFactor`);
  const outputCapacity = finiteNumber(source.outputCapacity, `${label}.outputCapacity`);
  const cycleRatePerSecond = finiteNumber(source.cycleRatePerSecond, `${label}.cycleRatePerSecond`);
  const acceptedInputItemIds = opaqueIdArray(source.acceptedInputItemIds, `${label}.acceptedInputItemIds`, 32);
  const producedOutputItemIds = opaqueIdArray(source.producedOutputItemIds, `${label}.producedOutputItemIds`, 32);
  const targetDysonOrbitLabel = source.targetDysonOrbitLabel === null
    ? null
    : boundedString(source.targetDysonOrbitLabel, `${label}.targetDysonOrbitLabel`, 256);
  return {
    entityId,
    supported: true,
    coverage: oneOf(source.coverage, ["complete", "conservative"], `${label}.coverage`),
    status,
    powerFactor,
    resourceReserve: normalizeFactoryNodeResourceReserve(source.resourceReserve, `${label}.resourceReserve`),
    outputCapacity,
    cycleRatePerSecond,
    acceptedInputItemIds,
    producedOutputItemIds,
    targetDysonOrbitLabel,
  };
}

function normalizeCoreViewportProjectionV2(value, context) {
  const projectionContext = normalizeViewportProjectionV2Context(
    context,
    "native viewport v2 projection context",
  );
  const presentationRequested = projectionContext.entityPresentationVersion === 1;
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "planetId", "bounds", "base",
    "entities", "belts", "pinnedEntityIds", "pinnedBeltIds", "nextEntityCursor",
    "nextBeltCursor", "planetTotals", "viewportTotals", "worldBounds", "minimap",
    "broadQueryFallback",
    ...(presentationRequested ? ["entityPresentationVersion", "entityPresentation"] : []),
  ], "native viewport v2 projection");
  if (source.schemaVersion !== 2 || source.projectionType !== "viewport-v2") {
    throw protocolError("native viewport v2 projection identity");
  }
  requireProjectionByteBudget(source, "native viewport v2 projection");
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
  let entityPresentation;
  if (presentationRequested) {
    if (source.entityPresentationVersion !== 1 || !Array.isArray(source.entityPresentation) ||
        source.entityPresentation.length !== entities.length) {
      throw protocolError("native viewport v2 entity presentation cardinality");
    }
    entityPresentation = source.entityPresentation.map((row, index) =>
      normalizeFactoryNodePresentation(row, entities[index], index));
  }
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
    ...(presentationRequested ? {
      entityPresentationVersion: 1,
      entityPresentation,
    } : {}),
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
    "elapsedSeconds", "simulationSpeed", "timeWarp", "entityCount", "beltCount",
    "activePlanetEntityCount", "activePlanetBeltCount", "constructionQueueCount",
  ], "native factory shell");
  if (source.schema !== "factory-read-model-v1" || source.source !== "native-core") {
    throw protocolError("native factory shell identity");
  }
  const timeWarpSource = exactObject(source.timeWarp, [
    "controllerEntityId", "enabled", "requestedMultiplier", "effectiveMultiplier",
    "requiredPowerKw", "allocatedPowerKw",
  ], "native factory shell time warp");
  const requiredPowerKw = finiteNumber(
    timeWarpSource.requiredPowerKw,
    "native factory shell time-warp required power",
    0,
  );
  const allocatedPowerKw = finiteNumber(
    timeWarpSource.allocatedPowerKw,
    "native factory shell time-warp allocated power",
    0,
  );
  const result = {
    schema: "factory-read-model-v1",
    source: "native-core",
    stateVersion: safeInteger(source.stateVersion, "native factory shell state version", 1),
    mode: oneOf(source.mode, ["normal", "speedrun"], "native factory shell mode"),
    activePlanetId: opaqueId(source.activePlanetId, "native factory shell active planet"),
    paused: boolean(source.paused, "native factory shell paused flag"),
    elapsedSeconds: finiteNumber(source.elapsedSeconds, "native factory shell elapsed seconds"),
    simulationSpeed: finiteNumber(source.simulationSpeed, "native factory shell simulation speed", 1),
    timeWarp: {
      controllerEntityId: nullableReadModelId(
        timeWarpSource.controllerEntityId,
        "native factory shell time-warp controller",
      ),
      enabled: boolean(timeWarpSource.enabled, "native factory shell time-warp enabled flag"),
      requestedMultiplier: safeInteger(
        timeWarpSource.requestedMultiplier,
        "native factory shell requested time-warp multiplier",
        1,
      ),
      effectiveMultiplier: safeInteger(
        timeWarpSource.effectiveMultiplier,
        "native factory shell effective time-warp multiplier",
        1,
      ),
      requiredPowerKw,
      allocatedPowerKw,
    },
    entityCount: safeInteger(source.entityCount, "native factory shell entity count"),
    beltCount: safeInteger(source.beltCount, "native factory shell belt count"),
    activePlanetEntityCount: safeInteger(source.activePlanetEntityCount, "native factory shell active entity count"),
    activePlanetBeltCount: safeInteger(source.activePlanetBeltCount, "native factory shell active belt count"),
    constructionQueueCount: safeInteger(source.constructionQueueCount, "native factory shell construction queue count"),
  };
  if (result.activePlanetEntityCount > result.entityCount || result.activePlanetBeltCount > result.beltCount) {
    throw protocolError("native factory shell active counts");
  }
  if (result.timeWarp.effectiveMultiplier < result.simulationSpeed ||
      result.timeWarp.requestedMultiplier < result.simulationSpeed ||
      result.timeWarp.allocatedPowerKw > result.timeWarp.requiredPowerKw) {
    throw protocolError("native factory shell time-warp bounds");
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

function normalizeFactoryStationItemOptions(value, label) {
  const source = exactObject(value, ["rows", "totalCount", "truncated", "limit"], label);
  const limit = safeInteger(source.limit, `${label}.limit`, 1);
  if (limit !== 128 || !Array.isArray(source.rows) || source.rows.length > limit) {
    throw protocolError(`${label}.rows`);
  }
  const totalCount = safeInteger(source.totalCount, `${label}.totalCount`);
  const truncated = boolean(source.truncated, `${label}.truncated`);
  if (totalCount < source.rows.length || truncated !== (totalCount > limit) ||
      (!truncated && source.rows.length !== totalCount) ||
      (truncated && source.rows.length !== limit)) {
    throw protocolError(`${label} cardinality`);
  }
  let previousItemId = null;
  const rows = source.rows.map((value, index) => {
    const rowLabel = `${label}.rows[${index}]`;
    const row = exactObject(value, ["itemId", "name", "kind"], rowLabel);
    const itemId = opaqueId(row.itemId, `${rowLabel}.itemId`, 160);
    if (!NATIVE_CATALOG_ID_PATTERN.test(itemId) ||
        previousItemId !== null && itemId <= previousItemId) {
      throw protocolError(`${rowLabel}.itemId`);
    }
    previousItemId = itemId;
    return {
      itemId,
      name: boundedReadModelText(row.name, `${rowLabel}.name`, 256, 1),
      kind: oneOf(row.kind, ["solid", "fluid", "matrix"], `${rowLabel}.kind`),
    };
  });
  return { rows, totalCount, truncated, limit };
}

function normalizeFactoryStationConfiguration(value, label, entity) {
  if (value === null) return null;
  const source = exactObject(value, [
    "schema", "registryFingerprint", "stationType", "stationDrones", "stationVessels",
    "stationWarpers", "itemOptions", "slots", "spaceWarpUnlocked", "stationWarpEnabled",
    "stationWarperAutoRefill", "stationWarperTarget", "stationHubEnabled",
    "stationHubPriority",
  ], label);
  if (source.schema !== "station-configuration-v1" || source.registryFingerprint !== "7df8cf3a") {
    throw protocolError(`${label} identity`);
  }
  const stationType = oneOf(source.stationType, ["planetary", "interstellar"], `${label}.stationType`);
  const expectedBuildingId = stationType === "interstellar"
    ? "interstellar_logistics_station"
    : "planetary_logistics_station";
  if (entity.kind !== "station" || entity.buildingId !== expectedBuildingId ||
      !Array.isArray(source.slots) || source.slots.length !== 5) {
    throw protocolError(`${label} station binding`);
  }
  const stationDrones = safeInteger(source.stationDrones, `${label}.stationDrones`);
  const stationVessels = source.stationVessels === null
    ? null
    : safeInteger(source.stationVessels, `${label}.stationVessels`);
  const stationWarpers = source.stationWarpers === null
    ? null
    : safeInteger(source.stationWarpers, `${label}.stationWarpers`);
  const itemOptions = normalizeFactoryStationItemOptions(source.itemOptions, `${label}.itemOptions`);
  const projectedItemIds = new Set(itemOptions.rows.map((row) => row.itemId));
  const machineCount = safeInteger(entity.machineCount, `${label}.machineCount`);
  if (stationDrones > machineCount * 50) throw protocolError(`${label}.stationDrones capacity`);
  const itemIds = new Set();
  const slots = source.slots.map((value, slotIndex) => {
    const keys = stationType === "interstellar"
      ? ["slotIndex", "itemId", "localMode", "remoteMode", "minimumLoad", "minStock", "maxStock", "priority", "routePolicy", "warperBudget"]
      : ["slotIndex", "itemId", "localMode", "remoteMode", "minimumLoad", "minStock", "maxStock", "priority"];
    const slot = exactObject(value, keys, `${label}.slots[${slotIndex}]`);
    if (slot.slotIndex !== slotIndex) throw protocolError(`${label}.slots[${slotIndex}].slotIndex`);
    const itemId = slot.itemId === null
      ? null
      : opaqueId(slot.itemId, `${label}.slots[${slotIndex}].itemId`, 160);
    if (itemId !== null && !NATIVE_CATALOG_ID_PATTERN.test(itemId)) {
      throw protocolError(`${label}.slots[${slotIndex}].itemId`);
    }
    if (itemId !== null && itemIds.has(itemId)) throw protocolError(`${label} duplicate slot item`);
    if (itemId !== null && !itemOptions.truncated && !projectedItemIds.has(itemId)) {
      throw protocolError(`${label}.slots[${slotIndex}].itemId binding`);
    }
    if (itemId !== null) itemIds.add(itemId);
    const minimumLoad = oneOf(slot.minimumLoad, [0.1, 0.25, 0.5, 1], `${label}.slots[${slotIndex}].minimumLoad`);
    const minStock = safeInteger(slot.minStock, `${label}.slots[${slotIndex}].minStock`);
    const maxStock = safeInteger(slot.maxStock, `${label}.slots[${slotIndex}].maxStock`);
    const priority = safeInteger(slot.priority, `${label}.slots[${slotIndex}].priority`);
    if (minStock > 100_000_000 || maxStock > 100_000_000 ||
        maxStock > 0 && minStock > maxStock || priority > 2) {
      throw protocolError(`${label}.slots[${slotIndex}] bounds`);
    }
    const result = {
      slotIndex,
      itemId,
      localMode: oneOf(slot.localMode, ["supply", "demand", "storage"], `${label}.slots[${slotIndex}].localMode`),
      remoteMode: oneOf(slot.remoteMode, ["supply", "demand", "storage"], `${label}.slots[${slotIndex}].remoteMode`),
      minimumLoad,
      minStock,
      maxStock,
      priority,
    };
    if (stationType === "interstellar") {
      result.routePolicy = oneOf(slot.routePolicy, ["direct", "relay-preferred", "relay-required"], `${label}.slots[${slotIndex}].routePolicy`);
      result.warperBudget = safeInteger(slot.warperBudget, `${label}.slots[${slotIndex}].warperBudget`, 1);
      if (result.warperBudget > 4) throw protocolError(`${label}.slots[${slotIndex}].warperBudget`);
    }
    return result;
  });
  const spaceWarpUnlocked = boolean(source.spaceWarpUnlocked, `${label}.spaceWarpUnlocked`);
  if (stationType === "planetary") {
    if (stationVessels !== null || stationWarpers !== null || source.stationWarpEnabled !== null ||
        source.stationWarperAutoRefill !== null || source.stationWarperTarget !== null ||
        source.stationHubEnabled !== null || source.stationHubPriority !== null) {
      throw protocolError(`${label} planetary scalar binding`);
    }
    return {
      schema: "station-configuration-v1", registryFingerprint: "7df8cf3a", stationType,
      itemOptions, stationDrones, stationVessels: null, stationWarpers: null, slots, spaceWarpUnlocked,
      stationWarpEnabled: null, stationWarperAutoRefill: null, stationWarperTarget: null,
      stationHubEnabled: null, stationHubPriority: null,
    };
  }
  const stationWarperTarget = safeInteger(source.stationWarperTarget, `${label}.stationWarperTarget`, 1);
  const stationHubPriority = safeInteger(source.stationHubPriority, `${label}.stationHubPriority`);
  if (stationVessels === null || stationWarpers === null || stationVessels > machineCount * 10 ||
      stationWarpers > machineCount * 50 || stationWarperTarget > machineCount * 50 ||
      stationHubPriority > 2) {
    throw protocolError(`${label} interstellar scalar binding`);
  }
  return {
    schema: "station-configuration-v1", registryFingerprint: "7df8cf3a", stationType,
    itemOptions, stationDrones, stationVessels, stationWarpers, slots, spaceWarpUnlocked,
    stationWarpEnabled: boolean(source.stationWarpEnabled, `${label}.stationWarpEnabled`),
    stationWarperAutoRefill: boolean(source.stationWarperAutoRefill, `${label}.stationWarperAutoRefill`),
    stationWarperTarget,
    stationHubEnabled: boolean(source.stationHubEnabled, `${label}.stationHubEnabled`),
    stationHubPriority,
  };
}

function normalizeFactorySelectedEntity(value, label) {
  const source = exactObject(value, [
    "entityId", "planetId", "kind", "position", "interactionLocked", "buildingId",
    "resourceId", "recipeId", "storedItemId", "fuelItemId", "machineCount", "minerCount",
    "progress", "utilization", "productionRate", "powerFactor", "inputItems", "outputItems",
    "stationConfiguration",
  ], label);
  const result = {
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
  result.stationConfiguration = normalizeFactoryStationConfiguration(
    source.stationConfiguration,
    `${label}.stationConfiguration`,
    result,
  );
  return result;
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
  if (entityRows.rows.some((row) => row.planetId !== activePlanetId) ||
      beltRows.rows.some((row) => row.planetId !== activePlanetId)) {
    throw protocolError("native factory selection active planet binding");
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

function normalizeConstructionCenterNamedQuantityRows(value, label, maximumRows, withEntityId = false) {
  const source = exactObject(value, ["rows", "totalCount", "totalAmount", "truncated"], label);
  const rowsModel = normalizeReadModelRows({
    rows: source.rows,
    totalCount: source.totalCount,
    truncated: source.truncated,
  }, label, maximumRows, (row, rowLabel) => {
    const entry = exactObject(row, withEntityId
      ? ["entityId", "itemId", "name", "amount"]
      : ["itemId", "name", "amount"], rowLabel);
    return {
      ...(withEntityId ? { entityId: opaqueId(entry.entityId, `${rowLabel}.entityId`) } : {}),
      itemId: opaqueId(entry.itemId, `${rowLabel}.itemId`),
      name: boundedReadModelText(entry.name, `${rowLabel}.name`, 256, 1),
      amount: safeInteger(entry.amount, `${rowLabel}.amount`),
    };
  });
  const totalAmount = safeInteger(source.totalAmount, `${label}.totalAmount`);
  const visibleAmount = rowsModel.rows.reduce((total, row) => total + row.amount, 0);
  if (!Number.isSafeInteger(visibleAmount) || totalAmount < visibleAmount ||
      (!rowsModel.truncated && totalAmount !== visibleAmount)) {
    throw protocolError(`${label} total amount binding`);
  }
  const ids = new Set();
  for (const row of rowsModel.rows) {
    const id = withEntityId ? `${row.entityId}\0${row.itemId}` : row.itemId;
    if (ids.has(id)) throw protocolError(`${label} duplicate row`);
    ids.add(id);
  }
  return { ...rowsModel, totalAmount };
}

function normalizeNativeConstructionCenterWorkspace(value, activePlanetId) {
  if (value === null) return null;
  const source = exactObject(value, [
    "schema", "registryFingerprint", "readOnly", "writeAvailable", "activePlanetId", "activePlanetName",
    "paused", "enabled", "quantumSourceEnabled", "quantumNetworkEnabled", "totalCrafted",
    "lastCraftedId", "lastCraftedName", "stockLimit", "cycleSeconds", "materialSeconds",
    "targets", "centers", "jobs", "materials", "quantumBuffer", "destroyedByproducts", "limits",
  ], "native construction-center workspace");
  if (source.schema !== "construction-center-workspace-v1" ||
      source.registryFingerprint !== "7df8cf3a" || source.readOnly !== true ||
      opaqueId(source.activePlanetId, "native construction-center active planet") !== activePlanetId) {
    throw protocolError("native construction-center identity");
  }
  const limits = exactObject(source.limits, [
    "targetRows", "centerRows", "jobRows", "materialRows", "quantumBufferRows",
    "destroyedByproductRows", "costRowsPerTarget", "projectionBytes",
  ], "native construction-center limits");
  const expectedLimits = {
    targetRows: 128,
    centerRows: 64,
    jobRows: 64,
    materialRows: 256,
    quantumBufferRows: 256,
    destroyedByproductRows: 256,
    costRowsPerTarget: 32,
    projectionBytes: 1_048_576,
  };
  for (const [key, expected] of Object.entries(expectedLimits)) {
    if (safeInteger(limits[key], `native construction-center limits.${key}`, 1) !== expected) {
      throw protocolError("native construction-center limit binding");
    }
  }
  const targets = normalizeReadModelRows(source.targets, "native construction-center targets", 128, (row, label) => {
    const entry = exactObject(row, [
      "targetId", "name", "kind", "category", "target", "currentStock", "unlocked",
      "requiredTechId", "requiredTechName", "outputAmount", "costs",
    ], label);
    const costs = normalizeReadModelRows(entry.costs, `${label}.costs`, 32, (cost, costLabel) => {
      const costSource = exactObject(cost, ["itemId", "name", "amount"], costLabel);
      return {
        itemId: opaqueId(costSource.itemId, `${costLabel}.itemId`),
        name: boundedReadModelText(costSource.name, `${costLabel}.name`, 256, 1),
        amount: safeInteger(costSource.amount, `${costLabel}.amount`, 1),
      };
    });
    if (new Set(costs.rows.map((cost) => cost.itemId)).size !== costs.rows.length) {
      throw protocolError(`${label}.costs duplicate item`);
    }
    const requiredTechId = nullableReadModelId(entry.requiredTechId, `${label}.requiredTechId`);
    const requiredTechName = entry.requiredTechName === null
      ? null
      : boundedReadModelText(entry.requiredTechName, `${label}.requiredTechName`, 256, 1);
    if ((requiredTechId === null) !== (requiredTechName === null)) {
      throw protocolError(`${label} technology binding`);
    }
    return {
      targetId: opaqueId(entry.targetId, `${label}.targetId`),
      name: boundedReadModelText(entry.name, `${label}.name`, 256, 1),
      kind: oneOf(entry.kind, ["building", "fleet"], `${label}.kind`),
      category: oneOf(entry.category, ["power", "production", "logistics", "dyson"], `${label}.category`),
      target: safeInteger(entry.target, `${label}.target`),
      currentStock: safeInteger(entry.currentStock, `${label}.currentStock`),
      unlocked: boolean(entry.unlocked, `${label}.unlocked`),
      requiredTechId,
      requiredTechName,
      outputAmount: safeInteger(entry.outputAmount, `${label}.outputAmount`, 1),
      costs,
    };
  });
  if (new Set(targets.rows.map((row) => row.targetId)).size !== targets.rows.length) {
    throw protocolError("native construction-center duplicate target");
  }
  const activePlanetName = boundedReadModelText(source.activePlanetName, "native construction-center active planet name", 256, 1);
  const centers = normalizeReadModelRows(source.centers, "native construction-center centers", 64, (row, label) => {
    const entry = exactObject(row, ["entityId", "planetId", "planetName", "machineCount", "status"], label);
    const planetId = opaqueId(entry.planetId, `${label}.planetId`);
    const planetName = boundedReadModelText(entry.planetName, `${label}.planetName`, 256, 1);
    if (planetId !== activePlanetId || planetName !== activePlanetName) throw protocolError(`${label} planet binding`);
    return {
      entityId: opaqueId(entry.entityId, `${label}.entityId`),
      planetId,
      planetName,
      machineCount: safeInteger(entry.machineCount, `${label}.machineCount`),
      status: oneOf(entry.status, ["game-paused", "automation-paused", "working", "idle"], `${label}.status`),
    };
  });
  if (new Set(centers.rows.map((row) => row.entityId)).size !== centers.rows.length) {
    throw protocolError("native construction-center duplicate center");
  }
  const jobs = normalizeReadModelRows(source.jobs, "native construction-center jobs", 64, (row, label) => {
    const entry = exactObject(row, [
      "entityId", "targetId", "targetName", "stepIndex", "stepCount", "elapsedSeconds", "inventory",
    ], label);
    const stepIndex = safeInteger(entry.stepIndex, `${label}.stepIndex`);
    const stepCount = safeInteger(entry.stepCount, `${label}.stepCount`);
    if (stepIndex > stepCount) throw protocolError(`${label} step binding`);
    return {
      entityId: opaqueId(entry.entityId, `${label}.entityId`),
      targetId: opaqueId(entry.targetId, `${label}.targetId`),
      targetName: boundedReadModelText(entry.targetName, `${label}.targetName`, 256, 1),
      stepIndex,
      stepCount,
      elapsedSeconds: finiteNumber(entry.elapsedSeconds, `${label}.elapsedSeconds`),
      inventory: normalizeConstructionCenterNamedQuantityRows(entry.inventory, `${label}.inventory`, 256),
    };
  });
  if (new Set(jobs.rows.map((row) => row.entityId)).size !== jobs.rows.length) {
    throw protocolError("native construction-center duplicate job");
  }
  const visibleTargets = new Map(targets.rows.map((row) => [row.targetId, row]));
  const visibleCenters = new Set(centers.rows.map((row) => row.entityId));
  for (const job of jobs.rows) {
    const target = visibleTargets.get(job.targetId);
    if ((!targets.truncated && (!target || target.name !== job.targetName)) ||
        (!centers.truncated && !visibleCenters.has(job.entityId))) {
      throw protocolError("native construction-center job directory binding");
    }
  }
  const materials = normalizeConstructionCenterNamedQuantityRows(source.materials, "native construction-center materials", 256);
  const quantumBuffer = normalizeConstructionCenterNamedQuantityRows(
    source.quantumBuffer,
    "native construction-center quantum buffer",
    256,
    true,
  );
  if (!centers.truncated && quantumBuffer.rows.some((row) => !visibleCenters.has(row.entityId))) {
    throw protocolError("native construction-center quantum center binding");
  }
  const destroyedByproducts = normalizeConstructionCenterNamedQuantityRows(
    source.destroyedByproducts,
    "native construction-center destroyed byproducts",
    256,
  );
  const lastCraftedId = nullableReadModelId(source.lastCraftedId, "native construction-center last crafted ID");
  const lastCraftedName = source.lastCraftedName === null
    ? null
    : boundedReadModelText(source.lastCraftedName, "native construction-center last crafted name", 256, 1);
  if ((lastCraftedId === null) !== (lastCraftedName === null) ||
      lastCraftedId !== null && !targets.truncated &&
        visibleTargets.get(lastCraftedId)?.name !== lastCraftedName) {
    throw protocolError("native construction-center last crafted binding");
  }
  const cycleSeconds = finiteNumber(source.cycleSeconds, "native construction-center cycle seconds", Number.EPSILON);
  const materialSeconds = finiteNumber(source.materialSeconds, "native construction-center material seconds", Number.EPSILON);
  if (Math.abs(materialSeconds - cycleSeconds / 50) > Number.EPSILON) {
    throw protocolError("native construction-center timing binding");
  }
  return {
    schema: "construction-center-workspace-v1",
    registryFingerprint: "7df8cf3a",
    readOnly: true,
    writeAvailable: boolean(source.writeAvailable, "native construction-center write availability"),
    activePlanetId,
    activePlanetName,
    paused: boolean(source.paused, "native construction-center paused"),
    enabled: boolean(source.enabled, "native construction-center enabled"),
    quantumSourceEnabled: boolean(source.quantumSourceEnabled, "native construction-center quantum source"),
    quantumNetworkEnabled: boolean(source.quantumNetworkEnabled, "native construction-center quantum network"),
    totalCrafted: safeInteger(source.totalCrafted, "native construction-center total crafted"),
    lastCraftedId,
    lastCraftedName,
    stockLimit: safeInteger(source.stockLimit, "native construction-center stock limit", 1),
    cycleSeconds,
    materialSeconds,
    targets,
    centers,
    jobs,
    materials,
    quantumBuffer,
    destroyedByproducts,
    limits: expectedLimits,
  };
}

function normalizeFactoryConstruction(value, activePlanetId) {
  const source = exactObject(value, ["schema", "activePlanetId", "queue", "nativeCenterWorkspace", "automation"], "native factory construction");
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
    nativeCenterWorkspace: normalizeNativeConstructionCenterWorkspace(source.nativeCenterWorkspace, activePlanetId),
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

function normalizeCoreFactoryInventoryProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "activePlanetId", "cargo", "pickupTargetAmount",
    "portableFleet", "productionBufferLimit", "trayItemLimit", "trayItemLimitBounds", "request",
    "totalCount", "rows", "nextCursor", "truncated", "limits",
  ], "native factory inventory projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "factory-inventory-v1" ||
      source.source !== "native-core" || source.stateVersion !== 47) {
    throw protocolError("native factory inventory identity");
  }
  requireProjectionByteBudget(source, "native factory inventory projection");
  const projectionContext = normalizeFactoryInventoryContext(
    context,
    "native factory inventory context",
  );
  const revision = safeInteger(source.revision, "native factory inventory revision");
  if (revision !== projectionContext.expectedRevision || !projectionContext.sessionId) {
    throw protocolError("native factory inventory revision binding");
  }
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native factory inventory registry fingerprint",
    256,
  );
  const activePlanetId = factoryInventoryId(source.activePlanetId, "native factory inventory active planet");
  const cargo = source.cargo === null ? null : (() => {
    const cargoSource = exactObject(
      source.cargo,
      ["itemId", "amount", "origin"],
      "native factory inventory cargo",
    );
    const origin = cargoSource.origin === null ? null : (() => {
      const originSource = exactObject(
        cargoSource.origin,
        ["kind", "id"],
        "native factory inventory cargo origin",
      );
      return {
        kind: oneOf(
          originSource.kind,
          ["node-output", "node-input", "tray"],
          "native factory inventory cargo origin kind",
        ),
        id: originSource.id === null
          ? null
          : factoryInventoryId(originSource.id, "native factory inventory cargo origin ID"),
      };
    })();
    return {
      itemId: factoryInventoryId(cargoSource.itemId, "native factory inventory cargo item ID"),
      amount: safeInteger(cargoSource.amount, "native factory inventory cargo amount", 1),
      origin,
    };
  })();
  if (source.pickupTargetAmount !== 100) {
    throw protocolError("native factory inventory pickup target");
  }
  const portableSource = exactObject(
    source.portableFleet,
    ["logistics_drone", "logistics_vessel"],
    "native factory portable fleet",
  );
  const portableFleet = {
    logistics_drone: safeInteger(
      portableSource.logistics_drone,
      "native factory portable logistics drones",
    ),
    logistics_vessel: safeInteger(
      portableSource.logistics_vessel,
      "native factory portable logistics vessels",
    ),
  };
  const productionBufferLimit = safeInteger(
    source.productionBufferLimit,
    "native factory production buffer limit",
    1_000,
  );
  if (productionBufferLimit > 100_000_000) {
    throw protocolError("native factory production buffer limit");
  }
  const boundsSource = exactObject(
    source.trayItemLimitBounds,
    ["minimum", "default", "maximum"],
    "native factory tray item limit bounds",
  );
  if (boundsSource.minimum !== 1_000 || boundsSource.default !== 1_000_000 ||
      boundsSource.maximum !== 100_000_000) {
    throw protocolError("native factory tray item limit bounds");
  }
  const trayItemLimit = safeInteger(source.trayItemLimit, "native factory tray item limit", 1_000);
  if (trayItemLimit > 100_000_000) throw protocolError("native factory tray item limit");
  const requestSource = exactObject(
    source.request,
    ["expectedRevision", "cursor", "limit"],
    "native factory inventory request echo",
  );
  if (requestSource.expectedRevision !== projectionContext.expectedRevision ||
      requestSource.cursor !== projectionContext.cursor ||
      requestSource.limit !== projectionContext.limit) {
    throw protocolError("native factory inventory request binding");
  }
  const totalCount = safeInteger(source.totalCount, "native factory inventory total count");
  if (projectionContext.cursor > totalCount || !Array.isArray(source.rows) ||
      source.rows.length > projectionContext.limit) {
    throw protocolError("native factory inventory page cardinality");
  }
  const rows = source.rows.map((row, index) => {
    const rowSource = exactObject(
      row,
      ["itemId", "amount", "freeCapacity", "overLimit"],
      `native factory inventory row[${index}]`,
    );
    const itemId = factoryInventoryId(rowSource.itemId, `native factory inventory row[${index}] item ID`);
    const amount = safeInteger(rowSource.amount, `native factory inventory row[${index}] amount`, 1);
    const freeCapacity = safeInteger(
      rowSource.freeCapacity,
      `native factory inventory row[${index}] free capacity`,
    );
    const overLimit = boolean(rowSource.overLimit, `native factory inventory row[${index}] over limit`);
    if (freeCapacity !== Math.max(0, trayItemLimit - amount) || overLimit !== (amount > trayItemLimit)) {
      throw protocolError(`native factory inventory row[${index}] capacity binding`);
    }
    return { itemId, amount, freeCapacity, overLimit };
  });
  const expectedRows = Math.min(projectionContext.limit, totalCount - projectionContext.cursor);
  if (rows.length !== expectedRows) throw protocolError("native factory inventory page cardinality");
  for (let index = 1; index < rows.length; index += 1) {
    if (Buffer.compare(Buffer.from(rows[index - 1].itemId, "utf8"), Buffer.from(rows[index].itemId, "utf8")) >= 0) {
      throw protocolError("native factory inventory row order");
    }
  }
  const consumed = projectionContext.cursor + rows.length;
  const expectedNextCursor = consumed < totalCount ? consumed : null;
  const nextCursor = source.nextCursor === null
    ? null
    : safeInteger(source.nextCursor, "native factory inventory next cursor");
  if (nextCursor !== expectedNextCursor ||
      boolean(source.truncated, "native factory inventory truncated") !== (expectedNextCursor !== null)) {
    throw protocolError("native factory inventory page continuation");
  }
  const limitsSource = exactObject(
    source.limits,
    ["rows", "projectionBytes"],
    "native factory inventory limits",
  );
  if (limitsSource.rows !== 256 || limitsSource.projectionBytes !== MAX_NATIVE_PROJECTION_BYTES) {
    throw protocolError("native factory inventory limits");
  }
  return {
    schemaVersion: 1,
    projectionType: "factory-inventory-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint,
    activePlanetId,
    cargo,
    pickupTargetAmount: 100,
    portableFleet,
    productionBufferLimit,
    trayItemLimit,
    trayItemLimitBounds: { minimum: 1_000, default: 1_000_000, maximum: 100_000_000 },
    request: {
      expectedRevision: projectionContext.expectedRevision,
      cursor: projectionContext.cursor,
      limit: projectionContext.limit,
    },
    totalCount,
    rows,
    nextCursor,
    truncated: expectedNextCursor !== null,
    limits: { rows: 256, projectionBytes: MAX_NATIVE_PROJECTION_BYTES },
  };
}

function normalizeCoreConstructionInventoryProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "readOnly", "request", "totalCount", "rows",
    "nextCursor", "truncated", "limits",
  ], "native construction inventory projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "construction-inventory-v1" ||
      source.source !== "native-core" || source.stateVersion !== 47 || source.readOnly !== true) {
    throw protocolError("native construction inventory identity");
  }
  requireProjectionByteBudget(source, "native construction inventory projection");
  const projectionContext = normalizeConstructionInventoryContext(
    context,
    "native construction inventory context",
  );
  const revision = safeInteger(source.revision, "native construction inventory revision");
  if (revision !== projectionContext.expectedRevision || !projectionContext.sessionId) {
    throw protocolError("native construction inventory revision binding");
  }
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native construction inventory registry fingerprint",
    256,
  );
  if (registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native construction inventory registry binding");
  }
  const requestSource = exactObject(
    source.request,
    ["expectedRevision", "expectedRegistryFingerprint", "cursor", "limit"],
    "native construction inventory request echo",
  );
  if (requestSource.expectedRevision !== projectionContext.expectedRevision ||
      requestSource.expectedRegistryFingerprint !== projectionContext.expectedRegistryFingerprint ||
      requestSource.cursor !== projectionContext.cursor ||
      requestSource.limit !== projectionContext.limit) {
    throw protocolError("native construction inventory request binding");
  }
  const totalCount = safeInteger(source.totalCount, "native construction inventory total count");
  if (projectionContext.cursor > totalCount || !Array.isArray(source.rows) ||
      source.rows.length > projectionContext.limit) {
    throw protocolError("native construction inventory page cardinality");
  }
  const rows = source.rows.map((row, index) => {
    const rowSource = exactObject(
      row,
      ["buildingId", "amount"],
      `native construction inventory row[${index}]`,
    );
    return {
      buildingId: factoryInventoryId(
        rowSource.buildingId,
        `native construction inventory row[${index}] building ID`,
      ),
      amount: safeInteger(
        rowSource.amount,
        `native construction inventory row[${index}] amount`,
        1,
      ),
    };
  });
  const expectedRows = Math.min(projectionContext.limit, totalCount - projectionContext.cursor);
  if (rows.length !== expectedRows) {
    throw protocolError("native construction inventory page cardinality");
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (Buffer.compare(
      Buffer.from(rows[index - 1].buildingId, "utf8"),
      Buffer.from(rows[index].buildingId, "utf8"),
    ) >= 0) {
      throw protocolError("native construction inventory row order");
    }
  }
  const consumed = projectionContext.cursor + rows.length;
  const expectedNextCursor = consumed < totalCount ? consumed : null;
  const nextCursor = source.nextCursor === null
    ? null
    : safeInteger(source.nextCursor, "native construction inventory next cursor");
  if (nextCursor !== expectedNextCursor ||
      boolean(source.truncated, "native construction inventory truncated") !==
        (expectedNextCursor !== null)) {
    throw protocolError("native construction inventory page continuation");
  }
  const limitsSource = exactObject(
    source.limits,
    ["rows", "projectionBytes"],
    "native construction inventory limits",
  );
  if (limitsSource.rows !== 256 || limitsSource.projectionBytes !== MAX_NATIVE_PROJECTION_BYTES) {
    throw protocolError("native construction inventory limits");
  }
  return {
    schemaVersion: 1,
    projectionType: "construction-inventory-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint,
    readOnly: true,
    request: {
      expectedRevision: projectionContext.expectedRevision,
      expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
      cursor: projectionContext.cursor,
      limit: projectionContext.limit,
    },
    totalCount,
    rows,
    nextCursor,
    truncated: expectedNextCursor !== null,
    limits: { rows: 256, projectionBytes: MAX_NATIVE_PROJECTION_BYTES },
  };
}

function blueprintOpaqueText(value, label, maximumBytes) {
  const result = opaqueId(value, label, maximumBytes);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(result)) throw protocolError(label);
  return result;
}

function blueprintDisplayText(value, label, maximumBytes) {
  return blueprintOpaqueText(value, label, maximumBytes);
}

function normalizeBlueprintCounts(value, label) {
  const source = exactObject(
    value,
    ["entities", "belts", "resourceAnchors", "externalPorts"],
    label,
  );
  return {
    entities: safeInteger(source.entities, `${label} entities`),
    belts: safeInteger(source.belts, `${label} belts`),
    resourceAnchors: safeInteger(source.resourceAnchors, `${label} resource anchors`),
    externalPorts: safeInteger(source.externalPorts, `${label} external ports`),
  };
}

function normalizeBlueprintRotation(value, label) {
  if (![0, 90, 180, 270].includes(value)) throw protocolError(label);
  return value;
}

function normalizeBlueprintSummary(value, label) {
  const source = exactObject(
    value,
    ["id", "name", "revision", "rotation", "mirror", "counts", "detailStatus"],
    label,
  );
  const counts = normalizeBlueprintCounts(source.counts, `${label} counts`);
  const overDetailLimit = counts.entities > 512 || counts.belts > 1_024 ||
    counts.resourceAnchors > 256 || counts.externalPorts > 256;
  const detailStatus = oneOf(source.detailStatus, ["candidate", "truncated"], `${label} detail status`);
  if ((detailStatus === "truncated") !== overDetailLimit) throw protocolError(`${label} detail status`);
  return {
    id: blueprintOpaqueText(source.id, `${label} ID`, 512),
    name: blueprintDisplayText(source.name, `${label} name`, 256),
    revision: safeInteger(source.revision, `${label} revision`, 1),
    rotation: normalizeBlueprintRotation(source.rotation, `${label} rotation`),
    mirror: oneOf(source.mirror, ["none", "horizontal"], `${label} mirror`),
    counts,
    detailStatus,
  };
}

function normalizeSignedFinite(value, label) {
  if (!Number.isFinite(value)) throw protocolError(label);
  return value;
}

function normalizeBlueprintOffset(value, label) {
  const source = exactObject(value, ["x", "y"], label);
  return {
    x: normalizeSignedFinite(source.x, `${label} x`),
    y: normalizeSignedFinite(source.y, `${label} y`),
  };
}

function normalizeBlueprintDetail(value, label) {
  const source = exactObject(
    value,
    [
      "summary", "status", "unsupportedReason", "entities", "belts",
      "resourceAnchors", "externalPorts",
    ],
    label,
  );
  const summary = normalizeBlueprintSummary(source.summary, `${label} summary`);
  const status = oneOf(source.status, ["supported", "truncated", "unsupported"], `${label} status`);
  const expectedReason = status === "supported" ? null
    : status === "truncated" ? summary.detailStatus === "truncated"
      ? "detail-limits-exceeded"
      : "projection-byte-budget-exceeded"
      : "unproven-catalog-semantics";
  if (source.unsupportedReason !== expectedReason || !Array.isArray(source.entities) ||
      !Array.isArray(source.belts) || !Array.isArray(source.resourceAnchors) ||
      !Array.isArray(source.externalPorts)) throw protocolError(`${label} status`);
  if (status !== "supported" && (source.entities.length !== 0 || source.belts.length !== 0 ||
      source.resourceAnchors.length !== 0 || source.externalPorts.length !== 0)) {
    throw protocolError(`${label} unsupported payload`);
  }
  if (status === "supported" && (summary.detailStatus !== "candidate" ||
      source.entities.length !== summary.counts.entities || source.belts.length !== summary.counts.belts ||
      source.resourceAnchors.length !== summary.counts.resourceAnchors ||
      source.externalPorts.length !== summary.counts.externalPorts)) {
    throw protocolError(`${label} cardinality`);
  }
  if (status === "unsupported" && summary.detailStatus === "truncated") {
    throw protocolError(`${label} unsupported status`);
  }
  const keys = new Set();
  const entityKeys = new Set();
  const entities = source.entities.map((row, index) => {
    const rowSource = exactObject(
      row,
      [
        "key", "buildingId", "buildingLabel", "offset", "machineCount", "recipeId",
        "operationEnabledOnDeploy",
      ],
      `${label} entity[${index}]`,
    );
    const key = blueprintOpaqueText(rowSource.key, `${label} entity[${index}] key`, 512);
    if (keys.has(key)) throw protocolError(`${label} duplicate detail key`);
    keys.add(key);
    entityKeys.add(key);
    const recipeId = rowSource.recipeId === null ? null
      : blueprintOpaqueText(rowSource.recipeId, `${label} entity[${index}] recipe ID`, 512);
    const operationEnabledOnDeploy = rowSource.operationEnabledOnDeploy === null ? null
      : boolean(rowSource.operationEnabledOnDeploy, `${label} entity[${index}] operation intent`);
    const buildingId = blueprintOpaqueText(
      rowSource.buildingId,
      `${label} entity[${index}] building ID`,
      512,
    );
    const machineCount = safeInteger(
      rowSource.machineCount,
      `${label} entity[${index}] machine count`,
      1,
    );
    if (machineCount > 100_000_000 ||
        operationEnabledOnDeploy !== null && buildingId !== "micro_black_hole_connector") {
      throw protocolError(`${label} entity[${index}] semantics`);
    }
    return {
      key,
      buildingId,
      buildingLabel: blueprintOpaqueText(rowSource.buildingLabel, `${label} entity[${index}] building label`, 512),
      offset: normalizeBlueprintOffset(rowSource.offset, `${label} entity[${index}] offset`),
      machineCount,
      recipeId,
      operationEnabledOnDeploy,
    };
  });
  const resourceAnchors = source.resourceAnchors.map((row, index) => {
    const rowSource = exactObject(
      row,
      ["key", "resourceId", "extractorBuildingId", "offset", "minerCount"],
      `${label} resource anchor[${index}]`,
    );
    const key = blueprintOpaqueText(rowSource.key, `${label} resource anchor[${index}] key`, 512);
    if (keys.has(key)) throw protocolError(`${label} duplicate detail key`);
    keys.add(key);
    const minerCount = safeInteger(rowSource.minerCount, `${label} resource anchor[${index}] miner count`, 1);
    if (minerCount > 100_000_000) throw protocolError(`${label} resource anchor[${index}] miner count`);
    return {
      key,
      resourceId: blueprintOpaqueText(rowSource.resourceId, `${label} resource anchor[${index}] item ID`, 512),
      extractorBuildingId: blueprintOpaqueText(
        rowSource.extractorBuildingId,
        `${label} resource anchor[${index}] extractor ID`,
        512,
      ),
      offset: normalizeBlueprintOffset(rowSource.offset, `${label} resource anchor[${index}] offset`),
      minerCount,
    };
  });
  const beltKeys = new Set();
  const belts = source.belts.map((row, index) => {
    const rowSource = exactObject(
      row,
      ["key", "sourceKey", "targetKey", "itemId", "lanes", "tier"],
      `${label} belt[${index}]`,
    );
    const key = blueprintOpaqueText(rowSource.key, `${label} belt[${index}] key`, 512);
    if (beltKeys.has(key)) throw protocolError(`${label} duplicate belt key`);
    beltKeys.add(key);
    const sourceKey = blueprintOpaqueText(rowSource.sourceKey, `${label} belt[${index}] source key`, 512);
    const targetKey = blueprintOpaqueText(rowSource.targetKey, `${label} belt[${index}] target key`, 512);
    if (!keys.has(sourceKey) || !keys.has(targetKey)) throw protocolError(`${label} belt endpoint`);
    const lanes = safeInteger(rowSource.lanes, `${label} belt[${index}] lanes`, 1);
    if (lanes > 4_096) throw protocolError(`${label} belt[${index}] lanes`);
    const tier = safeInteger(rowSource.tier, `${label} belt[${index}] tier`, 1);
    if (tier > 255) throw protocolError(`${label} belt[${index}] tier`);
    return {
      key,
      sourceKey,
      targetKey,
      itemId: blueprintOpaqueText(rowSource.itemId, `${label} belt[${index}] item ID`, 512),
      lanes,
      tier,
    };
  });
  const portKeys = new Set();
  const externalPorts = source.externalPorts.map((row, index) => {
    const rowSource = exactObject(
      row,
      ["key", "entityKey", "direction", "itemId", "offset"],
      `${label} external port[${index}]`,
    );
    const key = blueprintOpaqueText(rowSource.key, `${label} external port[${index}] key`, 512);
    if (portKeys.has(key)) throw protocolError(`${label} duplicate external port key`);
    portKeys.add(key);
    const entityKey = blueprintOpaqueText(rowSource.entityKey, `${label} external port[${index}] entity key`, 512);
    if (!entityKeys.has(entityKey)) throw protocolError(`${label} external port entity`);
    return {
      key,
      entityKey,
      direction: oneOf(rowSource.direction, ["input", "output"], `${label} external port[${index}] direction`),
      itemId: blueprintOpaqueText(rowSource.itemId, `${label} external port[${index}] item ID`, 512),
      offset: normalizeBlueprintOffset(rowSource.offset, `${label} external port[${index}] offset`),
    };
  });
  return { summary, status, unsupportedReason: expectedReason, entities, belts, resourceAnchors, externalPorts };
}

function normalizeBlueprintQueueRow(value, label) {
  const source = exactObject(
    value,
    [
      "id", "blueprintId", "blueprintVersionId", "blueprintRevision", "blueprintName",
      "planetId", "planetName", "position", "rotation", "mirror", "queuedAt", "status",
      "counts", "semanticStatus", "reservedConstructionTotal", "reservedFleetTotal",
      "placedEntityCount", "actionable",
    ],
    label,
  );
  const blueprintVersionId = source.blueprintVersionId === null ? null
    : blueprintOpaqueText(source.blueprintVersionId, `${label} version ID`, 512);
  const planetName = source.planetName === null ? null
    : blueprintDisplayText(source.planetName, `${label} planet name`, 256);
  const counts = source.counts === null ? null : normalizeBlueprintCounts(source.counts, `${label} counts`);
  const semanticStatus = oneOf(
    source.semanticStatus,
    ["catalog-backed", "truncated", "unsupported"],
    `${label} semantic status`,
  );
  const overDetailLimit = counts !== null && (counts.entities > 512 || counts.belts > 1_024 ||
    counts.resourceAnchors > 256 || counts.externalPorts > 256);
  if (semanticStatus === "catalog-backed" && (counts === null || overDetailLimit) ||
      semanticStatus === "truncated" && (counts === null || !overDetailLimit) ||
      semanticStatus === "unsupported" && overDetailLimit) {
    throw protocolError(`${label} semantic status`);
  }
  const queuedAt = finiteNumber(source.queuedAt, `${label} queued time`);
  if (queuedAt < 0) throw protocolError(`${label} queued time`);
  const status = oneOf(source.status, ["pending-materials", "waiting-fleet"], `${label} status`);
  const placedEntityCount = safeInteger(source.placedEntityCount, `${label} placed entity count`);
  if (counts !== null && placedEntityCount > counts.entities + counts.resourceAnchors) {
    throw protocolError(`${label} placed entity count`);
  }
  if (typeof source.actionable !== "boolean") throw protocolError(`${label} actionable`);
  const actionable = source.actionable;
  if (actionable && (status !== "pending-materials" || semanticStatus !== "catalog-backed" ||
      counts === null || counts.entities < 1 || counts.resourceAnchors !== 0 ||
      counts.externalPorts !== 0 || placedEntityCount !== 0)) {
    throw protocolError(`${label} actionable`);
  }
  return {
    id: blueprintOpaqueText(source.id, `${label} ID`, 512),
    blueprintId: blueprintOpaqueText(source.blueprintId, `${label} blueprint ID`, 512),
    blueprintVersionId,
    blueprintRevision: safeInteger(source.blueprintRevision, `${label} blueprint revision`, 1),
    blueprintName: blueprintDisplayText(source.blueprintName, `${label} blueprint name`, 256),
    planetId: blueprintOpaqueText(source.planetId, `${label} planet ID`, 512),
    planetName,
    position: normalizeBlueprintOffset(source.position, `${label} position`),
    rotation: normalizeBlueprintRotation(source.rotation, `${label} rotation`),
    mirror: oneOf(source.mirror, ["none", "horizontal"], `${label} mirror`),
    queuedAt,
    status,
    counts,
    semanticStatus,
    reservedConstructionTotal: safeInteger(source.reservedConstructionTotal, `${label} reserved construction`),
    reservedFleetTotal: safeInteger(source.reservedFleetTotal, `${label} reserved fleet`),
    placedEntityCount,
    actionable,
  };
}

function normalizeCoreBlueprintWorkspaceProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "readOnly", "request", "counts", "page", "limits",
  ], "native blueprint workspace projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "blueprint-workspace-v1" ||
      source.source !== "native-core" || source.stateVersion !== 47 || source.readOnly !== true) {
    throw protocolError("native blueprint workspace identity");
  }
  requireProjectionByteBudget(source, "native blueprint workspace projection");
  const projectionContext = normalizeBlueprintWorkspaceContext(
    context,
    "native blueprint workspace context",
  );
  const revision = safeInteger(source.revision, "native blueprint workspace revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native blueprint workspace registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native blueprint workspace identity binding");
  }
  const requestSource = exactObject(
    source.request,
    [
      "expectedRevision", "expectedRegistryFingerprint", "section", "blueprintId",
      "queueEntryId", "cursor", "limit",
    ],
    "native blueprint workspace request echo",
  );
  if (requestSource.expectedRevision !== projectionContext.expectedRevision ||
      requestSource.expectedRegistryFingerprint !== projectionContext.expectedRegistryFingerprint ||
      requestSource.section !== projectionContext.section ||
      requestSource.blueprintId !== projectionContext.blueprintId ||
      requestSource.queueEntryId !== projectionContext.queueEntryId ||
      requestSource.cursor !== projectionContext.cursor || requestSource.limit !== 32) {
    throw protocolError("native blueprint workspace request binding");
  }
  const countsSource = exactObject(source.counts, ["library", "queue"], "native blueprint workspace counts");
  const counts = {
    library: safeInteger(countsSource.library, "native blueprint workspace library count"),
    queue: safeInteger(countsSource.queue, "native blueprint workspace queue count"),
  };
  if (counts.library > 4_096 || counts.queue > 4_096) throw protocolError("native blueprint workspace source count");
  const pageSource = exactObject(
    source.page,
    ["cursor", "limit", "totalCount", "rows", "nextCursor", "truncated"],
    "native blueprint workspace page",
  );
  const totalCount = safeInteger(pageSource.totalCount, "native blueprint workspace total count");
  const expectedTotal = projectionContext.section === "library" ? counts.library
    : projectionContext.section === "queue" ? counts.queue : totalCount;
  const expectedPageCursor = totalCount === 0 ? 0
    : projectionContext.cursor < totalCount ? projectionContext.cursor
      : Math.floor((totalCount - 1) / 32) * 32;
  if (pageSource.cursor !== expectedPageCursor || pageSource.limit !== 32 ||
      !Array.isArray(pageSource.rows) ||
      totalCount !== expectedTotal || projectionContext.section === "detail" && totalCount > 1) {
    throw protocolError("native blueprint workspace page cardinality");
  }
  if (projectionContext.section === "queue-membership" && totalCount > 1) {
    throw protocolError("native blueprint workspace membership cardinality");
  }
  const rows = pageSource.rows.map((row, index) => projectionContext.section === "library"
    ? normalizeBlueprintSummary(row, `native blueprint workspace library row[${index}]`)
    : projectionContext.section === "detail"
      ? normalizeBlueprintDetail(row, `native blueprint workspace detail row[${index}]`)
      : projectionContext.section === "queue-membership"
        ? {
            id: blueprintOpaqueText(
              exactObject(row, ["id"], `native blueprint workspace membership row[${index}]`).id,
              `native blueprint workspace membership row[${index}] ID`,
              512,
            ),
          }
        : normalizeBlueprintQueueRow(row, `native blueprint workspace queue row[${index}]`));
  const expectedRows = Math.min(32, totalCount - expectedPageCursor);
  if (rows.length !== expectedRows) throw protocolError("native blueprint workspace page cardinality");
  const rowIds = new Set();
  for (const row of rows) {
    const id = projectionContext.section === "detail" ? row.summary.id : row.id;
    if (rowIds.has(id)) throw protocolError("native blueprint workspace duplicate page ID");
    rowIds.add(id);
  }
  if (projectionContext.section === "detail" && rows.length === 1 &&
      rows[0].summary.id !== projectionContext.blueprintId) {
    throw protocolError("native blueprint workspace detail selection");
  }
  if (projectionContext.section === "queue-membership" && rows.length === 1 &&
      rows[0].id !== projectionContext.queueEntryId) {
    throw protocolError("native blueprint workspace membership selection");
  }
  const consumed = expectedPageCursor + rows.length;
  const expectedNextCursor = consumed < totalCount ? consumed : null;
  const nextCursor = pageSource.nextCursor === null ? null
    : safeInteger(pageSource.nextCursor, "native blueprint workspace next cursor");
  if (nextCursor !== expectedNextCursor ||
      boolean(pageSource.truncated, "native blueprint workspace truncated") !== (nextCursor !== null)) {
    throw protocolError("native blueprint workspace continuation");
  }
  const limitsSource = exactObject(
    source.limits,
    [
      "pageRows", "sourceRows", "detailEntities", "detailBelts", "detailResourceAnchors",
      "detailExternalPorts", "projectionBytes", "opaqueIdBytes", "nameBytes",
    ],
    "native blueprint workspace limits",
  );
  if (limitsSource.pageRows !== 32 || limitsSource.sourceRows !== 4_096 ||
      limitsSource.detailEntities !== 512 || limitsSource.detailBelts !== 1_024 ||
      limitsSource.detailResourceAnchors !== 256 || limitsSource.detailExternalPorts !== 256 ||
      limitsSource.projectionBytes !== MAX_NATIVE_PROJECTION_BYTES ||
      limitsSource.opaqueIdBytes !== 512 || limitsSource.nameBytes !== 256) {
    throw protocolError("native blueprint workspace limits");
  }
  return {
    schemaVersion: 1,
    projectionType: "blueprint-workspace-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint,
    readOnly: true,
    request: {
      expectedRevision: projectionContext.expectedRevision,
      expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
      section: projectionContext.section,
      blueprintId: projectionContext.blueprintId,
      queueEntryId: projectionContext.queueEntryId,
      cursor: projectionContext.cursor,
      limit: 32,
    },
    counts,
    page: {
      cursor: expectedPageCursor,
      limit: 32,
      totalCount,
      rows,
      nextCursor,
      truncated: nextCursor !== null,
    },
    limits: {
      pageRows: 32,
      sourceRows: 4_096,
      detailEntities: 512,
      detailBelts: 1_024,
      detailResourceAnchors: 256,
      detailExternalPorts: 256,
      projectionBytes: MAX_NATIVE_PROJECTION_BYTES,
      opaqueIdBytes: 512,
      nameBytes: 256,
    },
  };
}

function normalizeCoreBlueprintEnqueueContext(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "support", "expectedQueueId",
    "limits",
  ], "native blueprint enqueue context");
  if (source.schemaVersion !== 1 ||
      source.projectionType !== "blueprint-enqueue-context-v1" ||
      source.source !== "native-core" || source.stateVersion !== 47) {
    throw protocolError("native blueprint enqueue context identity");
  }
  requireProjectionByteBudget(source, "native blueprint enqueue context");
  const projectionContext = normalizeBlueprintEnqueueContext(
    context,
    "native blueprint enqueue request context",
  );
  const revision = safeInteger(source.revision, "native blueprint enqueue revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native blueprint enqueue registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native blueprint enqueue revision binding");
  }
  const requestSource = exactObject(
    source.request,
    [
      "expectedRevision", "expectedRegistryFingerprint", "blueprintId", "blueprintRevision",
    ],
    "native blueprint enqueue request echo",
  );
  const requestBlueprintId = blueprintOpaqueText(
    requestSource.blueprintId,
    "native blueprint enqueue echoed blueprint ID",
    512,
  );
  const requestBlueprintRevision = safeInteger(
    requestSource.blueprintRevision,
    "native blueprint enqueue echoed blueprint revision",
    1,
  );
  if (requestSource.expectedRevision !== projectionContext.expectedRevision ||
      requestSource.expectedRegistryFingerprint !==
        projectionContext.expectedRegistryFingerprint ||
      requestBlueprintId !== projectionContext.blueprintId ||
      requestBlueprintRevision !== projectionContext.blueprintRevision) {
    throw protocolError("native blueprint enqueue request binding");
  }
  const activePlanetId = blueprintOpaqueText(
    source.activePlanetId,
    "native blueprint enqueue active planet",
    512,
  );
  const supportSource = exactObject(
    source.support,
    ["supported", "reason"],
    "native blueprint enqueue support",
  );
  const supported = boolean(supportSource.supported, "native blueprint enqueue support flag");
  const unsupportedReasons = [
    "queue-full",
    "next-id-exhausted",
    "queue-id-collision",
    "unsupported-blueprint-domain",
    "unsupported-active-planet",
    "unsupported-existing-queue-domain",
    "version-conflict",
  ];
  const reason = supportSource.reason === null
    ? null
    : oneOf(
        supportSource.reason,
        unsupportedReasons,
        "native blueprint enqueue support reason",
      );
  let expectedQueueId = null;
  if (source.expectedQueueId !== null) {
    expectedQueueId = blueprintOpaqueText(
      source.expectedQueueId,
      "native blueprint enqueue expected queue ID",
      512,
    );
    const match = /^construction_(0|[1-9][0-9]*)$/.exec(expectedQueueId);
    const suffix = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(suffix) || suffix < 0 || suffix >= Number.MAX_SAFE_INTEGER) {
      throw protocolError("native blueprint enqueue expected queue ID");
    }
  }
  if (supported !== (reason === null && expectedQueueId !== null) ||
      !supported && (reason === null || expectedQueueId !== null)) {
    throw protocolError("native blueprint enqueue support binding");
  }
  const limitsSource = exactObject(
    source.limits,
    ["projectionBytes"],
    "native blueprint enqueue limits",
  );
  if (limitsSource.projectionBytes !== MAX_NATIVE_PROJECTION_BYTES) {
    throw protocolError("native blueprint enqueue limits");
  }
  return {
    schemaVersion: 1,
    projectionType: "blueprint-enqueue-context-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint,
    request: {
      expectedRevision: projectionContext.expectedRevision,
      expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
      blueprintId: projectionContext.blueprintId,
      blueprintRevision: projectionContext.blueprintRevision,
    },
    activePlanetId,
    support: { supported, reason },
    expectedQueueId,
    limits: { projectionBytes: MAX_NATIVE_PROJECTION_BYTES },
  };
}

function normalizeConstructionPlacementEntityTemplate(value, context) {
  const requiredKeys = [
    "id", "kind", "planetId", "interactionLocked", "buildingId", "powerGridId",
    "powerPriority", "machineCount", "minerCount", "inputs", "outputs", "progress",
    "routingCursor", "utilization", "productionRate",
  ];
  const optionalKeys = [
    "generationPriority", "powerOutputKw", "powerInputKw", "recipeId",
    "targetDysonOrbitId", "distributionMode", "fuelRemainingMj", "storedEnergyMj",
    "energyMode",
  ];
  const source = objectWithKeys(
    value,
    requiredKeys,
    optionalKeys,
    "native construction placement entity template",
  );
  const id = logicalId(source.id, "native construction placement entity ID", 160);
  const kind = oneOf(
    source.kind,
    ["machine", "power", "storage", "splitter"],
    "native construction placement entity kind",
  );
  const planetId = factoryInventoryId(
    source.planetId,
    "native construction placement entity planet",
  );
  const buildingId = factoryInventoryId(
    source.buildingId,
    "native construction placement entity building",
  );
  if (id !== context.nextEntityId || planetId !== context.activePlanetId ||
      buildingId !== context.buildingId ||
      boolean(source.interactionLocked, "native construction placement interaction lock") !== false ||
      logicalId(source.powerGridId, "native construction placement power grid", 160) !== "grid-a" ||
      source.powerPriority !== 2 || source.machineCount !== 1 || source.minerCount !== 0 ||
      source.progress !== 0 || source.routingCursor !== 0 || source.utilization !== 0 ||
      source.productionRate !== 0) {
    throw protocolError("native construction placement canonical entity fields");
  }
  exactObject(source.inputs, [], "native construction placement entity inputs");
  exactObject(source.outputs, [], "native construction placement entity outputs");

  const hasPowerFields = ["generationPriority", "powerOutputKw", "powerInputKw"]
    .map((key) => Object.hasOwn(source, key));
  if (kind === "power") {
    if (hasPowerFields.some((present) => !present) ||
        ![1, 2, 3].includes(source.generationPriority) ||
        source.powerOutputKw !== 0 || source.powerInputKw !== 0) {
      throw protocolError("native construction placement power template");
    }
  } else if (hasPowerFields.some(Boolean)) {
    throw protocolError("native construction placement power template");
  }
  if (kind === "splitter") {
    if (source.distributionMode !== "balanced") {
      throw protocolError("native construction placement splitter template");
    }
  } else if (Object.hasOwn(source, "distributionMode")) {
    throw protocolError("native construction placement splitter template");
  }
  if (Object.hasOwn(source, "targetDysonOrbitId")) {
    factoryInventoryId(
      source.targetDysonOrbitId,
      "native construction placement Dyson orbit",
    );
    if (buildingId !== "em_rail_ejector") {
      throw protocolError("native construction placement Dyson orbit binding");
    }
  }
  if (Object.hasOwn(source, "recipeId")) {
    factoryInventoryId(source.recipeId, "native construction placement recipe");
  }
  if (Object.hasOwn(source, "fuelRemainingMj") && source.fuelRemainingMj !== 0) {
    throw protocolError("native construction placement fuel template");
  }
  const hasStoredEnergy = Object.hasOwn(source, "storedEnergyMj");
  const hasEnergyMode = Object.hasOwn(source, "energyMode");
  if (hasStoredEnergy !== hasEnergyMode ||
      hasStoredEnergy && (kind !== "power" || source.storedEnergyMj !== 0 ||
        !["auto", "charge"].includes(source.energyMode))) {
    throw protocolError("native construction placement energy template");
  }

  const result = {
    id,
    kind,
    planetId,
    interactionLocked: false,
    buildingId,
    powerGridId: "grid-a",
    powerPriority: 2,
    machineCount: 1,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  };
  for (const key of optionalKeys) {
    if (Object.hasOwn(source, key)) result[key] = source[key];
  }
  return result;
}

function normalizeCoreConstructionPlacementContext(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "available",
    "appendEntityIndex", "nextEntityId", "support", "placement", "limits",
  ], "native construction placement context");
  if (source.schemaVersion !== 1 ||
      source.projectionType !== "construction-placement-context-v1" ||
      source.source !== "native-core" || source.stateVersion !== 47) {
    throw protocolError("native construction placement identity");
  }
  requireProjectionByteBudget(source, "native construction placement context");
  const projectionContext = normalizeConstructionPlacementContext(
    context,
    "native construction placement request context",
  );
  const revision = safeInteger(source.revision, "native construction placement revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native construction placement registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native construction placement revision binding");
  }
  const requestSource = exactObject(
    source.request,
    ["expectedRevision", "expectedRegistryFingerprint", "buildingId"],
    "native construction placement request echo",
  );
  const requestBuildingId = factoryInventoryId(
    requestSource.buildingId,
    "native construction placement request building ID",
  );
  if (requestSource.expectedRevision !== projectionContext.expectedRevision ||
      requestSource.expectedRegistryFingerprint !== projectionContext.expectedRegistryFingerprint ||
      requestBuildingId !== projectionContext.buildingId) {
    throw protocolError("native construction placement request binding");
  }
  const activePlanetId = factoryInventoryId(
    source.activePlanetId,
    "native construction placement active planet",
  );
  const available = safeInteger(source.available, "native construction placement available");
  const appendEntityIndex = safeInteger(
    source.appendEntityIndex,
    "native construction placement append entity index",
  );
  const nextEntityId = logicalId(
    source.nextEntityId,
    "native construction placement next entity ID",
    160,
  );
  const nextIdMatch = /^entity_(0|[1-9]\d*)$/.exec(nextEntityId);
  const nextId = nextIdMatch ? Number(nextIdMatch[1]) : Number.NaN;
  if (!Number.isSafeInteger(nextId)) {
    throw protocolError("native construction placement next entity ID");
  }
  const supportSource = exactObject(
    source.support,
    ["supported", "reason"],
    "native construction placement support",
  );
  const supported = boolean(
    supportSource.supported,
    "native construction placement support flag",
  );
  const unsupportedReasons = [
    "unknown-building", "missing-construction-definition", "technology-locked",
    "unsupported-building-kind", "unsupported-building-domain",
    "unsupported-active-planet", "inventory-empty", "next-id-exhausted",
  ];
  const reason = supportSource.reason === null
    ? null
    : oneOf(
        supportSource.reason,
        unsupportedReasons,
        "native construction placement unsupported reason",
      );
  if (supported !== (reason === null) ||
      reason === "inventory-empty" && available !== 0 ||
      reason === "next-id-exhausted" && nextId !== Number.MAX_SAFE_INTEGER) {
    throw protocolError("native construction placement support binding");
  }

  let placement = null;
  if (supported) {
    const placementSource = exactObject(
      source.placement,
      ["remainingConstruction", "nextIdAfterPlacement", "entityTemplate"],
      "native construction placement command context",
    );
    const remainingConstruction = safeInteger(
      placementSource.remainingConstruction,
      "native construction placement remaining inventory",
    );
    const nextIdAfterPlacement = safeInteger(
      placementSource.nextIdAfterPlacement,
      "native construction placement next ID after placement",
    );
    if (available < 1 || remainingConstruction !== available - 1 ||
        nextId === Number.MAX_SAFE_INTEGER || nextIdAfterPlacement !== nextId + 1) {
      throw protocolError("native construction placement material/ID binding");
    }
    placement = {
      remainingConstruction,
      nextIdAfterPlacement,
      entityTemplate: normalizeConstructionPlacementEntityTemplate(
        placementSource.entityTemplate,
        {
          nextEntityId,
          activePlanetId,
          buildingId: projectionContext.buildingId,
        },
      ),
    };
  } else if (source.placement !== null) {
    throw protocolError("native construction placement unsupported payload");
  }
  const limitsSource = exactObject(
    source.limits,
    ["projectionBytes"],
    "native construction placement limits",
  );
  if (limitsSource.projectionBytes !== MAX_NATIVE_PROJECTION_BYTES) {
    throw protocolError("native construction placement limits");
  }
  return {
    schemaVersion: 1,
    projectionType: "construction-placement-context-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint,
    request: {
      expectedRevision: projectionContext.expectedRevision,
      expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
      buildingId: projectionContext.buildingId,
    },
    activePlanetId,
    available,
    appendEntityIndex,
    nextEntityId,
    support: { supported, reason },
    placement,
    limits: { projectionBytes: MAX_NATIVE_PROJECTION_BYTES },
  };
}

function normalizeCoreConstructionBeltPlacementContext(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "constructionId", "available",
    "appendBeltIndex", "nextBeltId", "support", "placement", "limits",
  ], "native construction belt placement context");
  if (source.schemaVersion !== 1 ||
      source.projectionType !== "construction-belt-placement-context-v1" ||
      source.source !== "native-core" || source.stateVersion !== 47) {
    throw protocolError("native construction belt placement identity");
  }
  requireProjectionByteBudget(source, "native construction belt placement context");
  const projectionContext = normalizeConstructionBeltPlacementContext(
    context,
    "native construction belt placement request context",
  );
  const revision = safeInteger(source.revision, "native construction belt placement revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native construction belt placement registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native construction belt placement revision binding");
  }
  const requestSource = exactObject(source.request, [
    "expectedRevision", "expectedRegistryFingerprint", "sourceId", "targetId", "itemId", "tier", "lanes",
  ], "native construction belt placement request echo");
  const echoed = {
    expectedRevision: safeInteger(
      requestSource.expectedRevision,
      "native construction belt placement echoed revision",
    ),
    expectedRegistryFingerprint: logicalId(
      requestSource.expectedRegistryFingerprint,
      "native construction belt placement echoed registry",
      256,
    ),
    sourceId: factoryInventoryId(requestSource.sourceId, "native construction belt placement echoed source"),
    targetId: factoryInventoryId(requestSource.targetId, "native construction belt placement echoed target"),
    itemId: factoryInventoryId(requestSource.itemId, "native construction belt placement echoed item"),
    tier: safeInteger(requestSource.tier, "native construction belt placement echoed tier", 1),
    lanes: safeInteger(requestSource.lanes, "native construction belt placement echoed lanes"),
  };
  for (const key of Object.keys(echoed)) {
    if (echoed[key] !== projectionContext[key]) {
      throw protocolError("native construction belt placement request binding");
    }
  }
  const activePlanetId = factoryInventoryId(
    source.activePlanetId,
    "native construction belt placement active planet",
  );
  const nullableInteger = (value, label) => value === null ? null : safeInteger(value, label);
  const nullableId = (value, label) => value === null ? null : factoryInventoryId(value, label);
  const constructionId = nullableId(
    source.constructionId,
    "native construction belt placement construction ID",
  );
  const available = nullableInteger(
    source.available,
    "native construction belt placement available",
  );
  const appendBeltIndex = nullableInteger(
    source.appendBeltIndex,
    "native construction belt placement append index",
  );
  const nextBeltId = nullableId(
    source.nextBeltId,
    "native construction belt placement next belt ID",
  );
  const supportSource = exactObject(
    source.support,
    ["supported", "reason"],
    "native construction belt placement support",
  );
  const supported = boolean(
    supportSource.supported,
    "native construction belt placement support flag",
  );
  const reasons = [
    "unsupported-active-planet", "invalid-lanes", "unsupported-belt-tier",
    "missing-construction-definition", "technology-locked", "unknown-item",
    "insufficient-inventory", "same-endpoint", "source-not-found", "target-not-found",
    "not-active-planet", "interaction-locked", "unsupported-source-domain",
    "unsupported-target-domain", "source-not-configured", "target-not-configured",
    "matching-route-exists", "next-id-exhausted", "next-id-collision",
    "invalid-default-settings",
  ];
  const reason = supportSource.reason === null
    ? null
    : oneOf(
        supportSource.reason,
        reasons,
        "native construction belt placement unsupported reason",
      );
  if (supported !== (reason === null)) {
    throw protocolError("native construction belt placement support binding");
  }

  let placement = null;
  if (supported) {
    const expectedConstructionId = {
      1: "conveyor_belt_mk1",
      2: "conveyor_belt_mk2",
      3: "conveyor_belt_mk3",
    }[projectionContext.tier];
    if (!expectedConstructionId || constructionId !== expectedConstructionId ||
        available === null || available < projectionContext.lanes ||
        appendBeltIndex === null || nextBeltId === null) {
      throw protocolError("native construction belt placement material identity");
    }
    const nextIdMatch = /^belt_(0|[1-9]\d*)$/.exec(nextBeltId);
    const nextId = nextIdMatch ? Number(nextIdMatch[1]) : Number.NaN;
    if (!Number.isSafeInteger(nextId) || nextId === Number.MAX_SAFE_INTEGER) {
      throw protocolError("native construction belt placement next belt ID");
    }
    const placementSource = exactObject(
      source.placement,
      ["remainingConstruction", "nextIdAfterPlacement", "beltTemplate"],
      "native construction belt placement command context",
    );
    const remainingConstruction = safeInteger(
      placementSource.remainingConstruction,
      "native construction belt placement remaining inventory",
    );
    const nextIdAfterPlacement = safeInteger(
      placementSource.nextIdAfterPlacement,
      "native construction belt placement next ID after placement",
    );
    if (remainingConstruction !== available - projectionContext.lanes ||
        nextIdAfterPlacement !== nextId + 1) {
      throw protocolError("native construction belt placement debit binding");
    }
    const beltSource = exactObject(placementSource.beltTemplate, [
      "id", "planetId", "source", "target", "itemId", "lanes", "tier", "sorterTier",
      "progress", "priority", "stackSize", "monitorEnabled", "totalTransferred",
      "congestion", "lastFlow", "routeMode",
    ], "native construction belt placement template");
    const tier = safeInteger(beltSource.tier, "native construction belt placement template tier", 1);
    const sorterTier = safeInteger(
      beltSource.sorterTier,
      "native construction belt placement template sorter tier",
      1,
    );
    const stackSize = safeInteger(
      beltSource.stackSize,
      "native construction belt placement template stack size",
      1,
    );
    const routeMode = oneOf(
      beltSource.routeMode,
      ["auto", "bezier", "upper", "lower"],
      "native construction belt placement template route mode",
    );
    if (factoryInventoryId(beltSource.id, "native construction belt placement template ID") !== nextBeltId ||
        factoryInventoryId(beltSource.planetId, "native construction belt placement template planet") !== activePlanetId ||
        factoryInventoryId(beltSource.source, "native construction belt placement template source") !== projectionContext.sourceId ||
        factoryInventoryId(beltSource.target, "native construction belt placement template target") !== projectionContext.targetId ||
        factoryInventoryId(beltSource.itemId, "native construction belt placement template item") !== projectionContext.itemId ||
        safeInteger(beltSource.lanes, "native construction belt placement template lanes", 1) !== projectionContext.lanes ||
        tier !== projectionContext.tier || sorterTier !== Math.min(3, tier) ||
        ![1, 2, 4].includes(stackSize) || beltSource.progress !== 0 || beltSource.priority !== 1 ||
        beltSource.monitorEnabled !== false || beltSource.totalTransferred !== 0 ||
        beltSource.congestion !== 0 || beltSource.lastFlow !== 0) {
      throw protocolError("native construction belt placement template binding");
    }
    placement = {
      remainingConstruction,
      nextIdAfterPlacement,
      beltTemplate: {
        id: nextBeltId,
        planetId: activePlanetId,
        source: projectionContext.sourceId,
        target: projectionContext.targetId,
        itemId: projectionContext.itemId,
        lanes: projectionContext.lanes,
        tier,
        sorterTier,
        progress: 0,
        priority: 1,
        stackSize,
        monitorEnabled: false,
        totalTransferred: 0,
        congestion: 0,
        lastFlow: 0,
        routeMode,
      },
    };
  } else if (source.placement !== null) {
    throw protocolError("native construction belt placement unsupported payload");
  }
  const limitsSource = exactObject(
    source.limits,
    ["projectionBytes"],
    "native construction belt placement limits",
  );
  if (limitsSource.projectionBytes !== MAX_NATIVE_PROJECTION_BYTES) {
    throw protocolError("native construction belt placement limits");
  }
  return {
    schemaVersion: 1,
    projectionType: "construction-belt-placement-context-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint,
    request: {
      expectedRevision: projectionContext.expectedRevision,
      expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
      sourceId: projectionContext.sourceId,
      targetId: projectionContext.targetId,
      itemId: projectionContext.itemId,
      tier: projectionContext.tier,
      lanes: projectionContext.lanes,
    },
    activePlanetId,
    constructionId,
    available,
    appendBeltIndex,
    nextBeltId,
    support: { supported, reason },
    placement,
    limits: { projectionBytes: MAX_NATIVE_PROJECTION_BYTES },
  };
}

function normalizeCoreConstructionBeltRemovalContext(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "beltId", "planetId",
    "sourceId", "targetId", "tier", "lanes", "constructionId",
    "currentConstruction", "refundAfterRemoval", "support", "limits",
  ], "native construction belt removal context");
  if (source.schemaVersion !== 1 ||
      source.projectionType !== "construction-belt-removal-context-v1" ||
      source.source !== "native-core" || source.stateVersion !== 47) {
    throw protocolError("native construction belt removal identity");
  }
  requireProjectionByteBudget(source, "native construction belt removal context");
  const projectionContext = normalizeConstructionBeltRemovalContext(
    context,
    "native construction belt removal request context",
  );
  const revision = safeInteger(source.revision, "native construction belt removal revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native construction belt removal registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native construction belt removal revision binding");
  }
  const requestSource = exactObject(source.request, [
    "expectedRevision", "expectedRegistryFingerprint", "beltId",
  ], "native construction belt removal request echo");
  const echoedRevision = safeInteger(
    requestSource.expectedRevision,
    "native construction belt removal echoed revision",
  );
  const echoedRegistryFingerprint = logicalId(
    requestSource.expectedRegistryFingerprint,
    "native construction belt removal echoed registry",
    256,
  );
  const echoedBeltId = factoryInventoryId(
    requestSource.beltId,
    "native construction belt removal echoed belt ID",
  );
  if (echoedRevision !== projectionContext.expectedRevision ||
      echoedRegistryFingerprint !== projectionContext.expectedRegistryFingerprint ||
      echoedBeltId !== projectionContext.beltId) {
    throw protocolError("native construction belt removal request binding");
  }
  const beltId = factoryInventoryId(source.beltId, "native construction belt removal belt ID");
  if (beltId !== projectionContext.beltId) {
    throw protocolError("native construction belt removal belt binding");
  }
  const activePlanetId = factoryInventoryId(
    source.activePlanetId,
    "native construction belt removal active planet",
  );
  const nullableId = (value, label) => value === null ? null : factoryInventoryId(value, label);
  const nullableInteger = (value, label) => value === null ? null : safeInteger(value, label);
  const planetId = nullableId(source.planetId, "native construction belt removal planet");
  const sourceId = nullableId(source.sourceId, "native construction belt removal source");
  const targetId = nullableId(source.targetId, "native construction belt removal target");
  const tier = nullableInteger(source.tier, "native construction belt removal tier");
  const lanes = nullableInteger(source.lanes, "native construction belt removal lanes");
  const constructionId = nullableId(
    source.constructionId,
    "native construction belt removal construction ID",
  );
  const currentConstruction = nullableInteger(
    source.currentConstruction,
    "native construction belt removal current construction",
  );
  const refundAfterRemoval = nullableInteger(
    source.refundAfterRemoval,
    "native construction belt removal refund",
  );
  const supportSource = exactObject(
    source.support,
    ["supported", "reason"],
    "native construction belt removal support",
  );
  const supported = boolean(
    supportSource.supported,
    "native construction belt removal support flag",
  );
  const reason = supportSource.reason === null
    ? null
    : oneOf(supportSource.reason, [
        "unsupported-active-planet", "belt-not-found", "invalid-belt",
        "not-active-planet", "unsupported-belt-domain", "unsupported-belt-tier",
        "missing-construction-definition", "source-not-found", "target-not-found",
        "unsupported-source-domain", "unsupported-target-domain",
        "invalid-construction-inventory", "refund-overflow",
      ], "native construction belt removal unsupported reason");
  if (supported !== (reason === null)) {
    throw protocolError("native construction belt removal support binding");
  }
  if (supported) {
    const expectedConstructionId = { 1: "conveyor_belt_mk1", 2: "conveyor_belt_mk2", 3: "conveyor_belt_mk3" }[tier];
    if (planetId !== activePlanetId || sourceId === null || targetId === null || sourceId === targetId ||
        expectedConstructionId === undefined || constructionId !== expectedConstructionId ||
        lanes === null || lanes < 1 || currentConstruction === null ||
        refundAfterRemoval === null || refundAfterRemoval !== currentConstruction + lanes ||
        !Number.isSafeInteger(refundAfterRemoval)) {
      throw protocolError("native construction belt removal refund binding");
    }
  } else if (refundAfterRemoval !== null) {
    throw protocolError("native construction belt removal unsupported refund");
  }
  const limitsSource = exactObject(
    source.limits,
    ["projectionBytes"],
    "native construction belt removal limits",
  );
  if (limitsSource.projectionBytes !== MAX_NATIVE_PROJECTION_BYTES) {
    throw protocolError("native construction belt removal limits");
  }
  return {
    schemaVersion: 1,
    projectionType: "construction-belt-removal-context-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint,
    request: {
      expectedRevision: projectionContext.expectedRevision,
      expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
      beltId: projectionContext.beltId,
    },
    activePlanetId,
    beltId,
    planetId,
    sourceId,
    targetId,
    tier,
    lanes,
    constructionId,
    currentConstruction,
    refundAfterRemoval,
    support: { supported, reason },
    limits: { projectionBytes: MAX_NATIVE_PROJECTION_BYTES },
  };
}

function normalizeCoreConstructionBeltLaneContext(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "beltId", "planetId",
    "sourceId", "targetId", "itemId", "tier", "currentLanes", "targetLanes",
    "constructionId", "currentConstruction", "laneDelta",
    "constructionAfterAdjustment", "support", "limits",
  ], "native construction belt lane context");
  if (source.schemaVersion !== 1 ||
      source.projectionType !== "construction-belt-lane-context-v1" ||
      source.source !== "native-core" || source.stateVersion !== 47) {
    throw protocolError("native construction belt lane identity");
  }
  requireProjectionByteBudget(source, "native construction belt lane context");
  const projectionContext = normalizeConstructionBeltLaneContext(
    context,
    "native construction belt lane request context",
  );
  const revision = safeInteger(source.revision, "native construction belt lane revision");
  const registryFingerprint = logicalId(source.registryFingerprint, "native construction belt lane registry fingerprint", 256);
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native construction belt lane revision binding");
  }
  const requestSource = exactObject(source.request, [
    "expectedRevision", "expectedRegistryFingerprint", "beltId", "targetLanes",
  ], "native construction belt lane request echo");
  if (safeInteger(requestSource.expectedRevision, "native construction belt lane echoed revision") !== projectionContext.expectedRevision ||
      logicalId(requestSource.expectedRegistryFingerprint, "native construction belt lane echoed registry", 256) !== projectionContext.expectedRegistryFingerprint ||
      factoryInventoryId(requestSource.beltId, "native construction belt lane echoed belt ID") !== projectionContext.beltId ||
      safeInteger(requestSource.targetLanes, "native construction belt lane echoed target") !== projectionContext.targetLanes) {
    throw protocolError("native construction belt lane request binding");
  }
  const beltId = factoryInventoryId(source.beltId, "native construction belt lane belt ID");
  const targetLanes = safeInteger(source.targetLanes, "native construction belt lane target");
  if (beltId !== projectionContext.beltId || targetLanes !== projectionContext.targetLanes) {
    throw protocolError("native construction belt lane target binding");
  }
  const activePlanetId = factoryInventoryId(source.activePlanetId, "native construction belt lane active planet");
  const nullableId = (value, label) => value === null ? null : factoryInventoryId(value, label);
  const nullableInteger = (value, label) => value === null ? null : safeInteger(value, label);
  const planetId = nullableId(source.planetId, "native construction belt lane planet");
  const sourceId = nullableId(source.sourceId, "native construction belt lane source");
  const targetId = nullableId(source.targetId, "native construction belt lane destination");
  const itemId = nullableId(source.itemId, "native construction belt lane item");
  const tier = nullableInteger(source.tier, "native construction belt lane tier");
  const currentLanes = nullableInteger(source.currentLanes, "native construction belt lane current lanes");
  const constructionId = nullableId(source.constructionId, "native construction belt lane construction ID");
  const currentConstruction = nullableInteger(source.currentConstruction, "native construction belt lane current construction");
  const laneDelta = source.laneDelta === null
    ? null
    : safeInteger(source.laneDelta, "native construction belt lane delta", Number.MIN_SAFE_INTEGER);
  const constructionAfterAdjustment = nullableInteger(
    source.constructionAfterAdjustment,
    "native construction belt lane adjusted construction",
  );
  const supportSource = exactObject(source.support, ["supported", "reason"], "native construction belt lane support");
  const supported = boolean(supportSource.supported, "native construction belt lane support flag");
  const reason = supportSource.reason === null ? null : oneOf(supportSource.reason, [
    "invalid-target-lanes", "unsupported-active-planet", "belt-not-found", "invalid-belt",
    "not-active-planet", "unsupported-item", "unsupported-belt-domain", "unsupported-belt-tier",
    "missing-construction-definition", "unchanged-lanes", "target-lanes-exceed-limit",
    "source-not-found", "target-not-found", "unsupported-source-domain", "unsupported-target-domain",
    "invalid-construction-inventory", "insufficient-construction", "refund-overflow",
  ], "native construction belt lane unsupported reason");
  if (supported !== (reason === null)) throw protocolError("native construction belt lane support binding");
  if (supported) {
    const expectedConstructionId = { 1: "conveyor_belt_mk1", 2: "conveyor_belt_mk2", 3: "conveyor_belt_mk3" }[tier];
    const expectedDelta = targetLanes - currentLanes;
    if (planetId !== activePlanetId || sourceId === null || targetId === null || sourceId === targetId || itemId === null ||
        expectedConstructionId === undefined || constructionId !== expectedConstructionId ||
        currentLanes === null || currentLanes < 1 || targetLanes < 1 || targetLanes === currentLanes ||
        laneDelta !== expectedDelta || currentConstruction === null || constructionAfterAdjustment === null ||
        constructionAfterAdjustment !== currentConstruction - expectedDelta ||
        !Number.isSafeInteger(constructionAfterAdjustment) || constructionAfterAdjustment < 0) {
      throw protocolError("native construction belt lane accounting binding");
    }
  } else if (laneDelta !== null || constructionAfterAdjustment !== null) {
    throw protocolError("native construction belt lane unsupported adjustment");
  }
  const limitsSource = exactObject(source.limits, ["maxPlayerLanes", "projectionBytes"], "native construction belt lane limits");
  if (limitsSource.maxPlayerLanes !== 4096 || limitsSource.projectionBytes !== MAX_NATIVE_PROJECTION_BYTES) {
    throw protocolError("native construction belt lane limits");
  }
  return {
    schemaVersion: 1,
    projectionType: "construction-belt-lane-context-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint,
    request: {
      expectedRevision: projectionContext.expectedRevision,
      expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
      beltId: projectionContext.beltId,
      targetLanes: projectionContext.targetLanes,
    },
    activePlanetId,
    beltId,
    planetId,
    sourceId,
    targetId,
    itemId,
    tier,
    currentLanes,
    targetLanes,
    constructionId,
    currentConstruction,
    laneDelta,
    constructionAfterAdjustment,
    support: { supported, reason },
    limits: { maxPlayerLanes: 4096, projectionBytes: MAX_NATIVE_PROJECTION_BYTES },
  };
}

function normalizeCoreConstructionRemovalContext(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "source", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "entityId", "buildingId",
    "machineCount", "currentConstruction", "refundAfterRemoval", "support", "limits",
  ], "native construction removal context");
  if (source.schemaVersion !== 1 ||
      source.projectionType !== "construction-removal-context-v1" ||
      source.source !== "native-core" || source.stateVersion !== 47) {
    throw protocolError("native construction removal identity");
  }
  requireProjectionByteBudget(source, "native construction removal context");
  const projectionContext = normalizeConstructionRemovalContext(
    context,
    "native construction removal request context",
  );
  const revision = safeInteger(source.revision, "native construction removal revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native construction removal registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native construction removal revision binding");
  }
  const requestSource = exactObject(
    source.request,
    ["expectedRevision", "expectedRegistryFingerprint", "entityId"],
    "native construction removal request echo",
  );
  const requestEntityId = factoryInventoryId(
    requestSource.entityId,
    "native construction removal request entity ID",
  );
  if (requestSource.expectedRevision !== projectionContext.expectedRevision ||
      requestSource.expectedRegistryFingerprint !== projectionContext.expectedRegistryFingerprint ||
      requestEntityId !== projectionContext.entityId) {
    throw protocolError("native construction removal request binding");
  }
  const activePlanetId = factoryInventoryId(
    source.activePlanetId,
    "native construction removal active planet",
  );
  const entityId = factoryInventoryId(source.entityId, "native construction removal entity ID");
  if (entityId !== projectionContext.entityId) {
    throw protocolError("native construction removal entity binding");
  }
  const nullableId = (value, label) => value === null ? null : factoryInventoryId(value, label);
  const nullableInteger = (value, label) => value === null ? null : safeInteger(value, label);
  const buildingId = nullableId(source.buildingId, "native construction removal building ID");
  const machineCount = nullableInteger(
    source.machineCount,
    "native construction removal machine count",
  );
  const currentConstruction = nullableInteger(
    source.currentConstruction,
    "native construction removal current construction",
  );
  const refundAfterRemoval = nullableInteger(
    source.refundAfterRemoval,
    "native construction removal refund",
  );
  const supportSource = exactObject(
    source.support,
    ["supported", "reason"],
    "native construction removal support",
  );
  const supported = boolean(
    supportSource.supported,
    "native construction removal support flag",
  );
  const unsupportedReasons = [
    "entity-not-found", "invalid-entity", "not-active-planet", "interaction-locked",
    "missing-building-id", "unknown-building", "missing-construction-definition",
    "unsupported-building-kind", "unsupported-building-domain", "entity-kind-mismatch",
    "invalid-machine-count", "empty-machine-stack", "spray-coater-installed",
    "buffered-material", "incident-belt", "construction-queue-reference",
    "blueprint-pruning-required", "invalid-construction-inventory", "refund-overflow",
  ];
  const reason = supportSource.reason === null
    ? null
    : oneOf(
        supportSource.reason,
        unsupportedReasons,
        "native construction removal unsupported reason",
      );
  if (supported !== (reason === null) || (!supported && refundAfterRemoval !== null)) {
    throw protocolError("native construction removal support binding");
  }
  if (supported) {
    if (buildingId === null || machineCount === null || machineCount < 1 ||
        currentConstruction === null || refundAfterRemoval === null ||
        currentConstruction > Number.MAX_SAFE_INTEGER - machineCount ||
        refundAfterRemoval !== currentConstruction + machineCount) {
      throw protocolError("native construction removal refund binding");
    }
  } else if ((reason === "entity-not-found" &&
      (buildingId !== null || machineCount !== null || currentConstruction !== null)) ||
      (reason === "invalid-machine-count" && machineCount !== null) ||
      (reason === "empty-machine-stack" && machineCount !== 0) ||
      (reason === "invalid-construction-inventory" && currentConstruction !== null) ||
      (reason === "refund-overflow" &&
        (machineCount === null || currentConstruction === null ||
          currentConstruction <= Number.MAX_SAFE_INTEGER - machineCount))) {
    throw protocolError("native construction removal unsupported binding");
  }
  const limitsSource = exactObject(
    source.limits,
    ["projectionBytes"],
    "native construction removal limits",
  );
  if (limitsSource.projectionBytes !== MAX_NATIVE_PROJECTION_BYTES) {
    throw protocolError("native construction removal limits");
  }
  return {
    schemaVersion: 1,
    projectionType: "construction-removal-context-v1",
    source: "native-core",
    revision,
    stateVersion: 47,
    registryFingerprint,
    request: {
      expectedRevision: projectionContext.expectedRevision,
      expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
      entityId: projectionContext.entityId,
    },
    activePlanetId,
    entityId,
    buildingId,
    machineCount,
    currentConstruction,
    refundAfterRemoval,
    support: { supported, reason },
    limits: { projectionBytes: MAX_NATIVE_PROJECTION_BYTES },
  };
}

function normalizeCoreConstructionStackContext(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "source", "sessionId", "revision", "stateVersion",
    "registryFingerprint", "request", "activePlanetId", "entityId", "buildingId",
    "currentCount", "targetCount", "currentConstruction", "constructionAfter", "support",
    "limits",
  ], "native construction stack context");
  if (source.schemaVersion !== 1 ||
      source.projectionType !== "construction-stack-context-v1" ||
      source.source !== "native-core" || source.stateVersion !== 47) {
    throw protocolError("native construction stack identity");
  }
  requireProjectionByteBudget(source, "native construction stack context");
  const projectionContext = normalizeConstructionStackContext(
    context,
    "native construction stack request context",
  );
  const sessionId = logicalId(source.sessionId, "native construction stack session", 128);
  const revision = safeInteger(source.revision, "native construction stack revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native construction stack registry fingerprint",
    256,
  );
  if (sessionId !== projectionContext.sessionId ||
      revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native construction stack identity binding");
  }
  const requestSource = exactObject(
    source.request,
    ["sessionId", "expectedRevision", "expectedRegistryFingerprint", "entityId", "targetCount"],
    "native construction stack request echo",
  );
  const requestSessionId = logicalId(
    requestSource.sessionId,
    "native construction stack request session",
    128,
  );
  const requestEntityId = factoryInventoryId(
    requestSource.entityId,
    "native construction stack request entity ID",
  );
  const requestTargetCount = safeInteger(
    requestSource.targetCount,
    "native construction stack request target count",
    1,
  );
  if (requestSessionId !== projectionContext.sessionId ||
      requestSource.expectedRevision !== projectionContext.expectedRevision ||
      requestSource.expectedRegistryFingerprint !== projectionContext.expectedRegistryFingerprint ||
      requestEntityId !== projectionContext.entityId ||
      requestTargetCount !== projectionContext.targetCount) {
    throw protocolError("native construction stack request binding");
  }
  const activePlanetId = factoryInventoryId(
    source.activePlanetId,
    "native construction stack active planet",
  );
  const entityId = factoryInventoryId(source.entityId, "native construction stack entity ID");
  const targetCount = safeInteger(source.targetCount, "native construction stack target count", 1);
  if (entityId !== projectionContext.entityId || targetCount !== projectionContext.targetCount) {
    throw protocolError("native construction stack target binding");
  }
  const nullableId = (entry, label) => entry === null ? null : factoryInventoryId(entry, label);
  const nullableInteger = (entry, label) => entry === null ? null : safeInteger(entry, label);
  const buildingId = nullableId(source.buildingId, "native construction stack building ID");
  const currentCount = nullableInteger(source.currentCount, "native construction stack current count");
  const currentConstruction = nullableInteger(
    source.currentConstruction,
    "native construction stack current construction",
  );
  const constructionAfter = nullableInteger(
    source.constructionAfter,
    "native construction stack construction after",
  );
  const supportSource = exactObject(
    source.support,
    ["supported", "reason"],
    "native construction stack support",
  );
  const supported = boolean(supportSource.supported, "native construction stack support flag");
  const unsupportedReasons = [
    "invalid-target-count", "entity-not-found", "invalid-entity", "not-active-planet",
    "interaction-locked", "missing-building-id", "unknown-building",
    "missing-construction-definition", "unsupported-building-kind",
    "unsupported-building-domain", "entity-kind-mismatch", "invalid-current-count",
    "empty-machine-stack", "unchanged-target", "stack-limit", "catalog-incomplete",
    "invalid-construction-inventory", "inventory-insufficient", "refund-overflow",
  ];
  const reason = supportSource.reason === null
    ? null
    : oneOf(
        supportSource.reason,
        unsupportedReasons,
        "native construction stack unsupported reason",
      );
  if (supported !== (reason === null) || (!supported && constructionAfter !== null)) {
    throw protocolError("native construction stack support binding");
  }
  if (supported) {
    if (buildingId === null || currentCount === null || currentCount < 1 ||
        currentConstruction === null || constructionAfter === null || targetCount === currentCount) {
      throw protocolError("native construction stack material binding");
    }
    if (targetCount > currentCount) {
      const addition = targetCount - currentCount;
      if (addition > currentConstruction || constructionAfter !== currentConstruction - addition) {
        throw protocolError("native construction stack debit binding");
      }
    } else {
      const refund = currentCount - targetCount;
      if (currentConstruction > Number.MAX_SAFE_INTEGER - refund ||
          constructionAfter !== currentConstruction + refund) {
        throw protocolError("native construction stack refund binding");
      }
    }
  } else if ((reason === "entity-not-found" &&
      (buildingId !== null || currentCount !== null || currentConstruction !== null)) ||
      (reason === "invalid-current-count" && currentCount !== null) ||
      (reason === "empty-machine-stack" && currentCount !== 0) ||
      (reason === "unchanged-target" && currentCount !== targetCount) ||
      (reason === "invalid-construction-inventory" && currentConstruction !== null) ||
      (reason === "inventory-insufficient" &&
        (currentCount === null || currentConstruction === null || targetCount <= currentCount ||
          currentConstruction >= targetCount - currentCount)) ||
      (reason === "refund-overflow" &&
        (currentCount === null || currentConstruction === null || targetCount >= currentCount ||
          currentConstruction <= Number.MAX_SAFE_INTEGER - (currentCount - targetCount)))) {
    throw protocolError("native construction stack unsupported binding");
  }
  const limitsSource = exactObject(
    source.limits,
    ["projectionBytes"],
    "native construction stack limits",
  );
  if (limitsSource.projectionBytes !== MAX_NATIVE_PROJECTION_BYTES) {
    throw protocolError("native construction stack limits");
  }
  return {
    schemaVersion: 1,
    projectionType: "construction-stack-context-v1",
    source: "native-core",
    sessionId,
    revision,
    stateVersion: 47,
    registryFingerprint,
    request: {
      sessionId: projectionContext.sessionId,
      expectedRevision: projectionContext.expectedRevision,
      expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
      entityId: projectionContext.entityId,
      targetCount: projectionContext.targetCount,
    },
    activePlanetId,
    entityId,
    buildingId,
    currentCount,
    targetCount,
    currentConstruction,
    constructionAfter,
    support: { supported, reason },
    limits: { projectionBytes: MAX_NATIVE_PROJECTION_BYTES },
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

function normalizeCoreTechnologyProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "truncated", "limits", "counts",
    "selectedTechId", "pausedTechId", "completedTechIds", "queuedTechIds", "progressByTech",
    "activeInfiniteResearchId", "autoResearch", "infiniteResearch", "settings", "matrixStock",
  ], "native technology projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "technology-v1") {
    throw protocolError("native technology projection identity");
  }
  requireProjectionByteBudget(source, "native technology projection");
  const projectionContext = normalizeTechnologyProjectionContext(context, "native technology projection context");
  const revision = safeInteger(source.revision, "native technology projection revision");
  if (revision !== projectionContext.expectedRevision || !projectionContext.sessionId) {
    throw protocolError("native technology projection revision binding");
  }
  const limits = exactObject(source.limits, ["techRows", "progressItemsPerTech", "infiniteRows"], "native technology limits");
  const techRows = safeInteger(limits.techRows, "native technology tech-row limit", 1);
  const progressItemsPerTech = safeInteger(limits.progressItemsPerTech, "native technology progress-item limit", 1);
  const infiniteRows = safeInteger(limits.infiniteRows, "native technology infinite-row limit", 1);
  if (techRows !== 512 || progressItemsPerTech !== 16 || infiniteRows !== 8) {
    throw protocolError("native technology limits binding");
  }
  const countsSource = exactObject(source.counts, [
    "completedTechIds", "queuedTechIds", "progressTechs", "infiniteResearch",
  ], "native technology counts");
  const counts = {
    completedTechIds: safeInteger(countsSource.completedTechIds, "native technology completed count"),
    queuedTechIds: safeInteger(countsSource.queuedTechIds, "native technology queued count"),
    progressTechs: safeInteger(countsSource.progressTechs, "native technology progress count"),
    infiniteResearch: safeInteger(countsSource.infiniteResearch, "native technology infinite count"),
  };
  const optionalId = (value, label) => value === null ? null : opaqueId(value, label);
  const boundedUniqueIds = (value, label) => opaqueIdArray(value, label, techRows);
  const completedTechIds = boundedUniqueIds(source.completedTechIds, "native technology completed IDs");
  const queuedTechIds = boundedUniqueIds(source.queuedTechIds, "native technology queued IDs");
  if (!Array.isArray(source.progressByTech) || source.progressByTech.length > techRows) {
    throw protocolError("native technology progress rows");
  }
  const progressTechIds = new Set();
  let nestedTruncated = false;
  const progressByTech = source.progressByTech.map((row, rowIndex) => {
    const label = `native technology progress rows[${rowIndex}]`;
    const entry = exactObject(row, ["techId", "totalCount", "truncated", "items"], label);
    const techId = opaqueId(entry.techId, `${label}.techId`);
    if (progressTechIds.has(techId)) throw protocolError(`${label}.techId`);
    progressTechIds.add(techId);
    const totalCount = safeInteger(entry.totalCount, `${label}.totalCount`);
    const truncated = boolean(entry.truncated, `${label}.truncated`);
    if (!Array.isArray(entry.items) || entry.items.length > progressItemsPerTech ||
        totalCount < entry.items.length || truncated !== (totalCount > entry.items.length)) {
      throw protocolError(`${label} cardinality`);
    }
    nestedTruncated ||= truncated;
    const itemIds = new Set();
    const items = entry.items.map((item, itemIndex) => {
      const itemLabel = `${label}.items[${itemIndex}]`;
      const itemSource = exactObject(item, ["itemId", "amount"], itemLabel);
      const itemId = opaqueId(itemSource.itemId, `${itemLabel}.itemId`);
      if (itemIds.has(itemId)) throw protocolError(`${itemLabel}.itemId`);
      itemIds.add(itemId);
      return { itemId, amount: safeInteger(itemSource.amount, `${itemLabel}.amount`) };
    });
    return { techId, totalCount, truncated, items };
  });
  if (!Array.isArray(source.infiniteResearch) || source.infiniteResearch.length > infiniteRows) {
    throw protocolError("native technology infinite rows");
  }
  const infiniteIds = new Set();
  const infiniteResearch = source.infiniteResearch.map((row, index) => {
    const label = `native technology infinite rows[${index}]`;
    const entry = exactObject(row, ["researchId", "level", "historicalLevel", "progress"], label);
    const researchId = opaqueId(entry.researchId, `${label}.researchId`);
    if (infiniteIds.has(researchId)) throw protocolError(`${label}.researchId`);
    infiniteIds.add(researchId);
    const progress = boundedReadModelText(entry.progress, `${label}.progress`, 1_024, 1);
    if (!/^\d+$/.test(progress)) throw protocolError(`${label}.progress`);
    return {
      researchId,
      level: safeInteger(entry.level, `${label}.level`),
      historicalLevel: entry.historicalLevel === null ? null : safeInteger(entry.historicalLevel, `${label}.historicalLevel`),
      progress,
    };
  });
  const settingsSource = exactObject(source.settings, ["technologyLayout", "fontScale", "difficulty"], "native technology settings");
  const fontScale = finiteNumber(settingsSource.fontScale, "native technology font scale", 0.8);
  if (![0.8, 1, 1.25, 1.5, 2].includes(fontScale)) throw protocolError("native technology font scale");
  const settings = {
    technologyLayout: oneOf(settingsSource.technologyLayout, ["standard", "compact"], "native technology layout"),
    fontScale,
    difficulty: oneOf(settingsSource.difficulty, ["relaxed", "standard", "hard"], "native technology difficulty"),
  };
  const matrixSource = exactObject(source.matrixStock, [
    "electromagnetic_matrix", "energy_matrix", "structure_matrix",
    "information_matrix", "gravity_matrix", "universe_matrix",
  ], "native technology matrix stock");
  const matrixStock = Object.fromEntries(Object.entries(matrixSource).map(([itemId, amount]) => [
    itemId, safeInteger(amount, `native technology matrix stock.${itemId}`),
  ]));
  const truncated = boolean(source.truncated, "native technology truncated flag");
  const computedTruncated = nestedTruncated ||
    counts.completedTechIds > completedTechIds.length ||
    counts.queuedTechIds > queuedTechIds.length ||
    counts.progressTechs > progressByTech.length ||
    counts.infiniteResearch > infiniteResearch.length;
  if (counts.completedTechIds < completedTechIds.length || counts.queuedTechIds < queuedTechIds.length ||
      counts.progressTechs < progressByTech.length || counts.infiniteResearch < infiniteResearch.length ||
      truncated !== computedTruncated) throw protocolError("native technology cardinality binding");
  return {
    schemaVersion: 1,
    projectionType: "technology-v1",
    revision,
    truncated,
    limits: { techRows, progressItemsPerTech, infiniteRows },
    counts,
    selectedTechId: optionalId(source.selectedTechId, "native technology selected ID"),
    pausedTechId: optionalId(source.pausedTechId, "native technology paused ID"),
    completedTechIds,
    queuedTechIds,
    progressByTech,
    activeInfiniteResearchId: optionalId(source.activeInfiniteResearchId, "native technology active infinite ID"),
    autoResearch: boolean(source.autoResearch, "native technology auto research"),
    infiniteResearch,
    settings,
    matrixStock,
  };
}

function normalizeCoreRecipeWorkspaceProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "registryFingerprint", "truncated",
    "limits", "counts", "request", "live", "itemStocks", "selectedItem", "locationPage",
  ], "native recipe workspace projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "recipe-workspace-v1") {
    throw protocolError("native recipe workspace projection identity");
  }
  requireProjectionByteBudget(source, "native recipe workspace projection");
  const projectionContext = normalizeRecipeWorkspaceProjectionContext(
    context,
    "native recipe workspace projection context",
  );
  const revision = safeInteger(source.revision, "native recipe workspace revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native recipe workspace registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native recipe workspace identity binding");
  }

  const limitsSource = exactObject(source.limits, [
    "itemRows", "completedTechRows", "planetRows", "profileItemRows", "colonyCostRows",
    "locationRows",
  ], "native recipe workspace limits");
  const limits = Object.fromEntries(Object.entries(limitsSource).map(([key, value]) => [
    key,
    safeInteger(value, `native recipe workspace limits.${key}`, 1),
  ]));
  if (limits.itemRows !== 256 || limits.completedTechRows !== 512 || limits.planetRows !== 64 ||
      limits.profileItemRows !== 256 || limits.colonyCostRows !== 32 || limits.locationRows !== 4_096) {
    throw protocolError("native recipe workspace limits binding");
  }
  const countsSource = exactObject(source.counts, [
    "catalogItems", "completedTechIds", "planetProfiles",
  ], "native recipe workspace counts");
  const counts = {
    catalogItems: safeInteger(countsSource.catalogItems, "native recipe workspace catalog count", 1),
    completedTechIds: safeInteger(countsSource.completedTechIds, "native recipe workspace completed-tech count"),
    planetProfiles: safeInteger(countsSource.planetProfiles, "native recipe workspace planet count", 1),
  };

  const requestSource = exactObject(source.request, [
    "itemIds", "selectedItemId", "location",
  ], "native recipe workspace echoed request");
  const requestItemIds = opaqueIdArray(
    requestSource.itemIds,
    "native recipe workspace echoed item IDs",
    limits.itemRows,
  );
  const selectedItemId = opaqueId(
    requestSource.selectedItemId,
    "native recipe workspace echoed selected item",
  );
  const requestLocation = requestSource.location === null ? null : (() => {
    const entry = exactObject(
      requestSource.location,
      ["planetId", "cursor", "limit"],
      "native recipe workspace echoed location",
    );
    return {
      planetId: opaqueId(entry.planetId, "native recipe workspace echoed location planet"),
      cursor: safeInteger(entry.cursor, "native recipe workspace echoed location cursor"),
      limit: safeInteger(entry.limit, "native recipe workspace echoed location limit", 1),
    };
  })();
  if (requestItemIds.length !== projectionContext.itemIds.length ||
      requestItemIds.some((itemId, index) => itemId !== projectionContext.itemIds[index]) ||
      selectedItemId !== projectionContext.selectedItemId ||
      JSON.stringify(requestLocation) !== JSON.stringify(projectionContext.location)) {
    throw protocolError("native recipe workspace selector binding");
  }

  const liveSource = exactObject(source.live, [
    "activePlanetId", "recipeFocus", "completedTechIds", "beltCount", "metrics",
    "planetProfiles", "dyson",
  ], "native recipe workspace live model");
  const activePlanetId = opaqueId(liveSource.activePlanetId, "native recipe workspace active planet");
  const recipeFocusSource = exactObject(
    liveSource.recipeFocus,
    ["itemId", "mode"],
    "native recipe workspace focus",
  );
  const recipeFocus = {
    itemId: recipeFocusSource.itemId === null
      ? null
      : opaqueId(recipeFocusSource.itemId, "native recipe workspace focus item"),
    mode: oneOf(recipeFocusSource.mode, ["two-level", "full"], "native recipe workspace focus mode"),
  };
  const completedTechIds = opaqueIdArray(
    liveSource.completedTechIds,
    "native recipe workspace completed technology IDs",
    limits.completedTechRows,
  );
  const metricsSource = exactObject(
    liveSource.metrics,
    ["generationKw", "demandKw", "powerFactor"],
    "native recipe workspace metrics",
  );
  const metrics = {
    generationKw: finiteNumber(metricsSource.generationKw, "native recipe workspace generation"),
    demandKw: finiteNumber(metricsSource.demandKw, "native recipe workspace demand"),
    powerFactor: finiteNumber(metricsSource.powerFactor, "native recipe workspace power factor"),
  };

  const normalizeCountedRows = (value, label, maximum, normalizeRow) => {
    const entry = exactObject(value, ["rows", "totalCount", "truncated"], label);
    if (!Array.isArray(entry.rows) || entry.rows.length > maximum) throw protocolError(`${label} rows`);
    const rows = entry.rows.map((row, index) => normalizeRow(row, `${label}.rows[${index}]`));
    const totalCount = safeInteger(entry.totalCount, `${label} total count`);
    const truncated = boolean(entry.truncated, `${label} truncated`);
    if (totalCount < rows.length || truncated !== (totalCount > rows.length)) {
      throw protocolError(`${label} cardinality`);
    }
    return { rows, totalCount, truncated };
  };
  if (!Array.isArray(liveSource.planetProfiles) || liveSource.planetProfiles.length > limits.planetRows) {
    throw protocolError("native recipe workspace planet profiles");
  }
  const planetIds = new Set();
  let nestedTruncated = false;
  const planetProfiles = liveSource.planetProfiles.map((row, index) => {
    const label = `native recipe workspace planet profiles[${index}]`;
    const entry = exactObject(row, [
      "planetId", "climateName", "starTypeName", "oceanType", "windMultiplier",
      "solarPowerMultiplier", "geothermalMultiplier", "miningMultiplier", "reserveScale",
      "tidalLocked", "resourceIds", "orbitalYields", "colonyCost",
    ], label);
    const planetId = opaqueId(entry.planetId, `${label}.planetId`);
    if (planetIds.has(planetId)) throw protocolError(`${label}.planetId`);
    planetIds.add(planetId);
    const resourceIds = normalizeCountedRows(
      entry.resourceIds,
      `${label}.resourceIds`,
      limits.profileItemRows,
      (itemId, itemLabel) => opaqueId(itemId, itemLabel),
    );
    const orbitalItemIds = new Set();
    const orbitalYields = normalizeCountedRows(
      entry.orbitalYields,
      `${label}.orbitalYields`,
      limits.profileItemRows,
      (value, rowLabel) => {
        const amount = exactObject(value, ["itemId", "rate"], rowLabel);
        const itemId = opaqueId(amount.itemId, `${rowLabel}.itemId`);
        if (orbitalItemIds.has(itemId)) throw protocolError(`${rowLabel}.itemId`);
        orbitalItemIds.add(itemId);
        return { itemId, rate: finiteNumber(amount.rate, `${rowLabel}.rate`) };
      },
    );
    const costItemIds = new Set();
    const colonyCost = normalizeCountedRows(
      entry.colonyCost,
      `${label}.colonyCost`,
      limits.colonyCostRows,
      (value, rowLabel) => {
        const amount = exactObject(value, ["itemId", "amount"], rowLabel);
        const itemId = opaqueId(amount.itemId, `${rowLabel}.itemId`);
        if (costItemIds.has(itemId)) throw protocolError(`${rowLabel}.itemId`);
        costItemIds.add(itemId);
        return { itemId, amount: finiteNumber(amount.amount, `${rowLabel}.amount`) };
      },
    );
    nestedTruncated ||= resourceIds.truncated || orbitalYields.truncated || colonyCost.truncated;
    return {
      planetId,
      climateName: boundedReadModelText(entry.climateName, `${label}.climateName`, 512, 1),
      starTypeName: boundedReadModelText(entry.starTypeName, `${label}.starTypeName`, 512, 1),
      oceanType: boundedReadModelText(entry.oceanType, `${label}.oceanType`, 512, 1),
      windMultiplier: finiteNumber(entry.windMultiplier, `${label}.windMultiplier`),
      solarPowerMultiplier: finiteNumber(entry.solarPowerMultiplier, `${label}.solarPowerMultiplier`),
      geothermalMultiplier: finiteNumber(entry.geothermalMultiplier, `${label}.geothermalMultiplier`),
      miningMultiplier: finiteNumber(entry.miningMultiplier, `${label}.miningMultiplier`),
      reserveScale: finiteNumber(entry.reserveScale, `${label}.reserveScale`),
      tidalLocked: boolean(entry.tidalLocked, `${label}.tidalLocked`),
      resourceIds,
      orbitalYields,
      colonyCost,
    };
  });
  if (!planetIds.has(activePlanetId)) throw protocolError("native recipe workspace active planet binding");

  const dysonSource = exactObject(liveSource.dyson, [
    "systemId", "orbitCount", "orbitSails", "completedStructurePoints", "projectedGenerationKw",
    "sailLaunchesPerMinute", "rocketLaunchesPerMinute", "receiverLoadKw",
    "criticalPhotonPerMinute", "shellSails", "shellCapacity",
  ], "native recipe workspace Dyson summary");
  const dyson = {
    systemId: opaqueId(dysonSource.systemId, "native recipe workspace Dyson system"),
    orbitCount: safeInteger(dysonSource.orbitCount, "native recipe workspace Dyson orbit count"),
    orbitSails: finiteNumber(dysonSource.orbitSails, "native recipe workspace Dyson orbit sails"),
    completedStructurePoints: finiteNumber(dysonSource.completedStructurePoints, "native recipe workspace Dyson structure"),
    projectedGenerationKw: finiteNumber(dysonSource.projectedGenerationKw, "native recipe workspace Dyson generation"),
    sailLaunchesPerMinute: finiteNumber(dysonSource.sailLaunchesPerMinute, "native recipe workspace sail launches"),
    rocketLaunchesPerMinute: finiteNumber(dysonSource.rocketLaunchesPerMinute, "native recipe workspace rocket launches"),
    receiverLoadKw: finiteNumber(dysonSource.receiverLoadKw, "native recipe workspace receiver load"),
    criticalPhotonPerMinute: finiteNumber(dysonSource.criticalPhotonPerMinute, "native recipe workspace critical photons"),
    shellSails: finiteNumber(dysonSource.shellSails, "native recipe workspace shell sails"),
    shellCapacity: finiteNumber(dysonSource.shellCapacity, "native recipe workspace shell capacity"),
  };

  if (!Array.isArray(source.itemStocks) || source.itemStocks.length !== requestItemIds.length) {
    throw protocolError("native recipe workspace stock rows");
  }
  const itemStocks = source.itemStocks.map((row, index) => {
    const entry = exactObject(row, ["itemId", "amount"], `native recipe workspace stock rows[${index}]`);
    const itemId = opaqueId(entry.itemId, `native recipe workspace stock rows[${index}].itemId`);
    if (itemId !== requestItemIds[index]) throw protocolError("native recipe workspace stock order binding");
    return { itemId, amount: finiteNumber(entry.amount, `native recipe workspace stock rows[${index}].amount`) };
  });
  const selectedSource = exactObject(
    source.selectedItem,
    ["itemId", "stock", "productionLocations"],
    "native recipe workspace selected item",
  );
  const selectedOutputItemId = opaqueId(selectedSource.itemId, "native recipe workspace selected output item");
  if (selectedOutputItemId !== selectedItemId || !Array.isArray(selectedSource.productionLocations) ||
      selectedSource.productionLocations.length > limits.planetRows) {
    throw protocolError("native recipe workspace selected item binding");
  }
  const productionPlanetIds = new Set();
  const productionLocations = selectedSource.productionLocations.map((row, index) => {
    const label = `native recipe workspace production locations[${index}]`;
    const entry = exactObject(row, ["planetId", "producerCount"], label);
    const planetId = opaqueId(entry.planetId, `${label}.planetId`);
    if (productionPlanetIds.has(planetId) || !planetIds.has(planetId)) throw protocolError(`${label}.planetId`);
    productionPlanetIds.add(planetId);
    return { planetId, producerCount: safeInteger(entry.producerCount, `${label}.producerCount`, 1) };
  });
  const selectedItem = {
    itemId: selectedOutputItemId,
    stock: finiteNumber(selectedSource.stock, "native recipe workspace selected stock"),
    productionLocations,
  };
  const selectedStockRow = itemStocks.find((row) => row.itemId === selectedItemId);
  if (selectedStockRow && selectedStockRow.amount !== selectedItem.stock) {
    throw protocolError("native recipe workspace selected stock binding");
  }

  let locationPage = null;
  if (source.locationPage !== null) {
    const entry = exactObject(source.locationPage, [
      "planetId", "cursor", "totalCount", "entities", "nextCursor",
    ], "native recipe workspace location page");
    if (!projectionContext.location) throw protocolError("native recipe workspace unsolicited location page");
    if (!Array.isArray(entry.entities) || entry.entities.length > projectionContext.location.limit) {
      throw protocolError("native recipe workspace location entities");
    }
    const entityIds = new Set();
    const entities = entry.entities.map((row, index) => {
      const label = `native recipe workspace location entities[${index}]`;
      const entity = exactObject(row, ["id", "x", "y"], label);
      const id = opaqueId(entity.id, `${label}.id`);
      if (entityIds.has(id)) throw protocolError(`${label}.id`);
      entityIds.add(id);
      return {
        id,
        x: finiteNumber(entity.x, `${label}.x`, -Number.MAX_VALUE),
        y: finiteNumber(entity.y, `${label}.y`, -Number.MAX_VALUE),
      };
    });
    const cursor = safeInteger(entry.cursor, "native recipe workspace location cursor");
    const totalCount = safeInteger(entry.totalCount, "native recipe workspace location total count");
    const nextCursor = entry.nextCursor === null
      ? null
      : safeInteger(entry.nextCursor, "native recipe workspace location next cursor");
    const expectedNextCursor = cursor + entities.length < totalCount ? cursor + entities.length : null;
    const planetId = opaqueId(entry.planetId, "native recipe workspace location planet");
    if (planetId !== projectionContext.location.planetId || cursor !== projectionContext.location.cursor ||
        totalCount < cursor + entities.length || nextCursor !== expectedNextCursor) {
      throw protocolError("native recipe workspace location binding");
    }
    locationPage = { planetId, cursor, totalCount, entities, nextCursor };
  } else if (projectionContext.location) {
    throw protocolError("native recipe workspace missing location page");
  }

  const truncated = boolean(source.truncated, "native recipe workspace truncated flag");
  const computedTruncated = nestedTruncated || counts.completedTechIds > completedTechIds.length ||
    counts.planetProfiles > planetProfiles.length;
  if (counts.catalogItems < requestItemIds.length || counts.completedTechIds < completedTechIds.length ||
      counts.planetProfiles < planetProfiles.length || truncated !== computedTruncated) {
    throw protocolError("native recipe workspace cardinality binding");
  }
  return {
    schemaVersion: 1,
    projectionType: "recipe-workspace-v1",
    revision,
    registryFingerprint,
    truncated,
    limits,
    counts,
    request: { itemIds: requestItemIds, selectedItemId, location: requestLocation },
    live: {
      activePlanetId,
      recipeFocus,
      completedTechIds,
      beltCount: safeInteger(liveSource.beltCount, "native recipe workspace belt count"),
      metrics,
      planetProfiles,
      dyson,
    },
    itemStocks,
    selectedItem,
    locationPage,
  };
}

function normalizeStellarProjectionLimits(value, label) {
  const source = exactObject(value, [
    "requestBytes", "projectionBytes", "pageRows", "labelBytes",
  ], label);
  const limits = {
    requestBytes: safeInteger(source.requestBytes, `${label}.requestBytes`, 1),
    projectionBytes: safeInteger(source.projectionBytes, `${label}.projectionBytes`, 1),
    pageRows: safeInteger(source.pageRows, `${label}.pageRows`, 1),
    labelBytes: safeInteger(source.labelBytes, `${label}.labelBytes`, 1),
  };
  if (limits.requestBytes !== 32_768 || limits.projectionBytes !== 1_048_576 ||
      limits.pageRows !== 64 || limits.labelBytes !== 512) {
    throw protocolError(`${label} binding`);
  }
  return limits;
}

function normalizeStarMapCatalogProjectionLimits(value, label) {
  const source = exactObject(value, [
    "requestBytes", "projectionBytes", "pageRows", "labelBytes", "nestedRows", "tagRows",
  ], label);
  const base = normalizeStellarProjectionLimits({
    requestBytes: source.requestBytes,
    projectionBytes: source.projectionBytes,
    pageRows: source.pageRows,
    labelBytes: source.labelBytes,
  }, label);
  const nestedRows = safeInteger(source.nestedRows, `${label}.nestedRows`, 1);
  const tagRows = safeInteger(source.tagRows, `${label}.tagRows`, 1);
  if (nestedRows !== 64 || tagRows !== 32) throw protocolError(`${label} binding`);
  return { ...base, nestedRows, tagRows };
}

function stellarLabel(value, label, minimumBytes = 0) {
  const result = boundedReadModelText(value, label, 512, minimumBytes);
  if (/\p{Cc}/u.test(result)) throw protocolError(label);
  return result;
}

function dysonId(value, label) {
  const result = opaqueId(value, label, 1_024);
  if (/\p{Cc}/u.test(result)) throw protocolError(label);
  return result;
}

function dysonOptionalId(value, label) {
  return value === null ? null : dysonId(value, label);
}

function dysonLabel(value, label) {
  const result = opaqueId(value, label, 512);
  if (/\p{Cc}/u.test(result)) throw protocolError(label);
  return result;
}

function dysonInteger(value, label) {
  return safeInteger(value, label);
}

function dysonUnitNumber(value, label) {
  const result = finiteNumber(value, label);
  if (result > 1) throw protocolError(label);
  return result;
}

function stellarNullableToken(value, label) {
  if (value === null) return null;
  const result = boundedReadModelText(value, label, 64);
  if (/\p{Cc}/u.test(result)) throw protocolError(label);
  return result;
}

function stellarUnitNumber(value, label) {
  const result = finiteNumber(value, label);
  if (result > 1) throw protocolError(label);
  return result;
}

function stellarDecimal(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 ||
      !/^(0|[1-9][0-9]*)$/.test(value)) throw protocolError(label);
  return value;
}

function stellarCapacity(value, label) {
  const result = stellarDecimal(value, label);
  const amount = BigInt(result);
  if (amount < 10_000n || amount > 10_000_000_000n) throw protocolError(label);
  return result;
}

function normalizeStellarPage(value, expectedCursor, expectedLimit, label, normalizeRow) {
  const source = exactObject(value, [
    "cursor", "limit", "totalCount", "nextCursor", "rows",
  ], label);
  const cursor = stellarCursor(source.cursor, `${label}.cursor`);
  const limit = stellarPageLimit(source.limit, `${label}.limit`);
  const totalCount = safeInteger(source.totalCount, `${label}.totalCount`);
  if (cursor !== expectedCursor || limit !== expectedLimit || totalCount < cursor ||
      !Array.isArray(source.rows) || source.rows.length > limit) {
    throw protocolError(`${label} binding`);
  }
  const rows = source.rows.map((row, index) => normalizeRow(row, `${label}.rows[${index}]`));
  const expectedRows = Math.min(limit, totalCount - cursor);
  if (rows.length !== expectedRows) throw protocolError(`${label} page size`);
  const consumed = cursor + rows.length;
  const nextCursor = source.nextCursor === null
    ? null
    : stellarCursor(source.nextCursor, `${label}.nextCursor`);
  if (nextCursor !== (consumed < totalCount ? consumed : null)) {
    throw protocolError(`${label} cursor chain`);
  }
  return { cursor, limit, totalCount, nextCursor, rows };
}

function normalizeCoreStarMapOverviewProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "registryFingerprint", "stateVersion",
    "limits", "request", "activePlanetId", "activeSystemId", "galaxySeed", "summary", "systems",
  ], "native star-map overview projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "star-map-overview-v1") {
    throw protocolError("native star-map overview projection identity");
  }
  requireProjectionByteBudget(source, "native star-map overview projection");
  const projectionContext = normalizeStarMapOverviewProjectionContext(
    context,
    "native star-map overview projection context",
  );
  const revision = safeInteger(source.revision, "native star-map overview revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native star-map overview registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint || source.stateVersion !== 47) {
    throw protocolError("native star-map overview identity binding");
  }
  const limits = normalizeStellarProjectionLimits(
    source.limits,
    "native star-map overview limits",
  );
  const requestSource = exactObject(source.request, [
    "expectedRevision", "expectedRegistryFingerprint", "cursor", "limit",
  ], "native star-map overview echoed request");
  const echoed = normalizeStarMapOverviewProjectionContext({
    sessionId: projectionContext.sessionId,
    ...requestSource,
  }, "native star-map overview echoed request");
  if (echoed.expectedRevision !== projectionContext.expectedRevision ||
      echoed.expectedRegistryFingerprint !== projectionContext.expectedRegistryFingerprint ||
      echoed.cursor !== projectionContext.cursor || echoed.limit !== projectionContext.limit) {
    throw protocolError("native star-map overview request binding");
  }

  const activePlanetId = opaqueId(source.activePlanetId, "native star-map overview active planet");
  const activeSystemId = opaqueId(source.activeSystemId, "native star-map overview active system");
  const systemIds = new Set();
  const systems = normalizeStellarPage(
    source.systems,
    echoed.cursor,
    echoed.limit,
    "native star-map overview systems",
    (row, label) => {
      const entry = exactObject(row, [
        "systemId", "displayName", "displayNameTruncated", "starTypeName", "starTypeNameTruncated",
        "positionX", "positionY", "distanceFromOriginLy", "luminosity", "active", "unlocked",
        "missionActive", "missionElapsedSeconds", "missionDurationSeconds", "surveyProgress",
        "firstPlanetId", "planetCount", "colonizedPlanetCount", "entityCount", "deviceCount",
        "beltCount", "stationCount", "interstellarStationCount", "orbitalCollectorCount",
        "legacyStationCount", "quantumStationCount", "quantumAttachableCount",
        "configuredImportSlotCount", "configuredExportSlotCount", "routeCount", "activeRouteCount",
        "generationKw", "demandKw", "powerFactor",
      ], label);
      const systemId = opaqueId(entry.systemId, `${label}.systemId`);
      if (systemIds.has(systemId)) throw protocolError(`${label}.systemId`);
      systemIds.add(systemId);
      const planetCount = safeInteger(entry.planetCount, `${label}.planetCount`, 1);
      const colonizedPlanetCount = safeInteger(entry.colonizedPlanetCount, `${label}.colonizedPlanetCount`);
      const stationCount = safeInteger(entry.stationCount, `${label}.stationCount`);
      const interstellarStationCount = safeInteger(
        entry.interstellarStationCount,
        `${label}.interstellarStationCount`,
      );
      const orbitalCollectorCount = safeInteger(
        entry.orbitalCollectorCount,
        `${label}.orbitalCollectorCount`,
      );
      const legacyStationCount = safeInteger(entry.legacyStationCount, `${label}.legacyStationCount`);
      const quantumStationCount = safeInteger(entry.quantumStationCount, `${label}.quantumStationCount`);
      const quantumAttachableCount = safeInteger(
        entry.quantumAttachableCount,
        `${label}.quantumAttachableCount`,
      );
      const routeCount = safeInteger(entry.routeCount, `${label}.routeCount`);
      const activeRouteCount = safeInteger(entry.activeRouteCount, `${label}.activeRouteCount`);
      const active = boolean(entry.active, `${label}.active`);
      const unlocked = boolean(entry.unlocked, `${label}.unlocked`);
      if (colonizedPlanetCount > planetCount || interstellarStationCount > stationCount ||
          orbitalCollectorCount > stationCount || legacyStationCount > stationCount ||
          quantumStationCount > stationCount || quantumAttachableCount > stationCount ||
          activeRouteCount > routeCount || active && (systemId !== activeSystemId || !unlocked)) {
        throw protocolError(`${label} cardinality binding`);
      }
      return {
        systemId,
        displayName: stellarLabel(entry.displayName, `${label}.displayName`, 1),
        displayNameTruncated: boolean(entry.displayNameTruncated, `${label}.displayNameTruncated`),
        starTypeName: stellarLabel(entry.starTypeName, `${label}.starTypeName`, 1),
        starTypeNameTruncated: boolean(entry.starTypeNameTruncated, `${label}.starTypeNameTruncated`),
        positionX: finiteNumber(entry.positionX, `${label}.positionX`, -Number.MAX_VALUE),
        positionY: finiteNumber(entry.positionY, `${label}.positionY`, -Number.MAX_VALUE),
        distanceFromOriginLy: finiteNumber(entry.distanceFromOriginLy, `${label}.distanceFromOriginLy`),
        luminosity: finiteNumber(entry.luminosity, `${label}.luminosity`),
        active,
        unlocked,
        missionActive: boolean(entry.missionActive, `${label}.missionActive`),
        missionElapsedSeconds: finiteNumber(entry.missionElapsedSeconds, `${label}.missionElapsedSeconds`),
        missionDurationSeconds: finiteNumber(entry.missionDurationSeconds, `${label}.missionDurationSeconds`),
        surveyProgress: stellarUnitNumber(entry.surveyProgress, `${label}.surveyProgress`),
        firstPlanetId: opaqueId(entry.firstPlanetId, `${label}.firstPlanetId`),
        planetCount,
        colonizedPlanetCount,
        entityCount: safeInteger(entry.entityCount, `${label}.entityCount`),
        deviceCount: finiteNumber(entry.deviceCount, `${label}.deviceCount`),
        beltCount: safeInteger(entry.beltCount, `${label}.beltCount`),
        stationCount,
        interstellarStationCount,
        orbitalCollectorCount,
        legacyStationCount,
        quantumStationCount,
        quantumAttachableCount,
        configuredImportSlotCount: safeInteger(
          entry.configuredImportSlotCount,
          `${label}.configuredImportSlotCount`,
        ),
        configuredExportSlotCount: safeInteger(
          entry.configuredExportSlotCount,
          `${label}.configuredExportSlotCount`,
        ),
        routeCount,
        activeRouteCount,
        generationKw: finiteNumber(entry.generationKw, `${label}.generationKw`),
        demandKw: finiteNumber(entry.demandKw, `${label}.demandKw`),
        powerFactor: stellarUnitNumber(entry.powerFactor, `${label}.powerFactor`),
      };
    },
  );
  const summarySource = exactObject(source.summary, [
    "systemCount", "unlockedSystemCount", "planetCount", "colonizedPlanetCount", "stationCount",
  ], "native star-map overview summary");
  const summary = {
    systemCount: safeInteger(summarySource.systemCount, "native star-map overview system count", 1),
    unlockedSystemCount: safeInteger(
      summarySource.unlockedSystemCount,
      "native star-map overview unlocked system count",
      1,
    ),
    planetCount: safeInteger(summarySource.planetCount, "native star-map overview planet count", 1),
    colonizedPlanetCount: safeInteger(
      summarySource.colonizedPlanetCount,
      "native star-map overview colonized planet count",
      1,
    ),
    stationCount: safeInteger(summarySource.stationCount, "native star-map overview station count"),
  };
  if (systems.totalCount !== summary.systemCount || summary.unlockedSystemCount > summary.systemCount ||
      summary.colonizedPlanetCount > summary.planetCount) {
    throw protocolError("native star-map overview summary binding");
  }
  return {
    schemaVersion: 1,
    projectionType: "star-map-overview-v1",
    revision,
    registryFingerprint,
    stateVersion: 47,
    limits,
    request: {
      expectedRevision: echoed.expectedRevision,
      expectedRegistryFingerprint: echoed.expectedRegistryFingerprint,
      cursor: echoed.cursor,
      limit: echoed.limit,
    },
    activePlanetId,
    activeSystemId,
    galaxySeed: safeInteger(source.galaxySeed, "native star-map overview galaxy seed"),
    summary,
    systems,
  };
}

function normalizeStarMapCatalogList(value, maximumRows, label, normalizeRow, rowKey) {
  const source = exactObject(value, ["totalCount", "truncated", "rows"], label);
  const totalCount = safeInteger(source.totalCount, `${label}.totalCount`);
  if (totalCount > 65_536 || !Array.isArray(source.rows) ||
      source.rows.length !== Math.min(totalCount, maximumRows)) {
    throw protocolError(`${label} cardinality`);
  }
  const truncated = boolean(source.truncated, `${label}.truncated`);
  if (truncated !== (totalCount > source.rows.length)) throw protocolError(`${label} truncation`);
  const rows = source.rows.map((row, index) => normalizeRow(row, `${label}.rows[${index}]`));
  if (rowKey) {
    const seen = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const key = rowKey(rows[index]);
      if (seen.has(key)) throw protocolError(`${label}.rows[${index}]`);
      seen.add(key);
    }
  }
  return { totalCount, truncated, rows };
}

function normalizeCoreStarMapCatalogProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "registryFingerprint", "stateVersion",
    "limits", "request", "activePlanetId", "activeSystemId", "galaxySeed", "summary",
    "truncated", "systems", "planets",
  ], "native star-map catalog projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "star-map-catalog-v1") {
    throw protocolError("native star-map catalog projection identity");
  }
  requireProjectionByteBudget(source, "native star-map catalog projection");
  const projectionContext = normalizeStarMapCatalogProjectionContext(
    context,
    "native star-map catalog projection context",
  );
  const revision = safeInteger(source.revision, "native star-map catalog revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native star-map catalog registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint || source.stateVersion !== 47) {
    throw protocolError("native star-map catalog identity binding");
  }
  const limits = normalizeStarMapCatalogProjectionLimits(
    source.limits,
    "native star-map catalog limits",
  );
  const requestSource = exactObject(source.request, [
    "expectedRevision", "expectedRegistryFingerprint", "systemCursor", "systemLimit",
    "planetCursor", "planetLimit",
  ], "native star-map catalog echoed request");
  const echoed = normalizeStarMapCatalogProjectionContext({
    sessionId: projectionContext.sessionId,
    ...requestSource,
  }, "native star-map catalog echoed request");
  for (const key of [
    "expectedRevision", "expectedRegistryFingerprint", "systemCursor", "systemLimit",
    "planetCursor", "planetLimit",
  ]) {
    if (echoed[key] !== projectionContext[key]) {
      throw protocolError("native star-map catalog request binding");
    }
  }

  const activePlanetId = opaqueId(source.activePlanetId, "native star-map catalog active planet");
  const activeSystemId = opaqueId(source.activeSystemId, "native star-map catalog active system");
  const systemIds = new Set();
  const systems = normalizeStellarPage(
    source.systems,
    echoed.systemCursor,
    echoed.systemLimit,
    "native star-map catalog systems",
    (row, label) => {
      const entry = exactObject(row, [
        "systemId", "displayName", "displayNameTruncated", "starClassId", "starTypeName",
        "starTypeNameTruncated", "positionX", "positionY", "distanceFromOriginLy",
        "luminosity", "massMultiplier", "radiusMultiplier", "active", "discovered",
        "missionActive", "missionElapsedSeconds", "missionDurationSeconds", "surveyProgress",
        "firstPlanetId", "planetCount", "colonizedPlanetCount",
      ], label);
      const systemId = opaqueId(entry.systemId, `${label}.systemId`);
      if (systemIds.has(systemId)) throw protocolError(`${label}.systemId`);
      systemIds.add(systemId);
      const active = boolean(entry.active, `${label}.active`);
      const discovered = boolean(entry.discovered, `${label}.discovered`);
      const planetCount = safeInteger(entry.planetCount, `${label}.planetCount`, 1);
      const colonizedPlanetCount = safeInteger(
        entry.colonizedPlanetCount,
        `${label}.colonizedPlanetCount`,
      );
      if (colonizedPlanetCount > planetCount || active && (!discovered || systemId !== activeSystemId)) {
        throw protocolError(`${label} cardinality binding`);
      }
      return {
        systemId,
        displayName: stellarLabel(entry.displayName, `${label}.displayName`, 1),
        displayNameTruncated: boolean(entry.displayNameTruncated, `${label}.displayNameTruncated`),
        starClassId: stellarNullableToken(entry.starClassId, `${label}.starClassId`),
        starTypeName: stellarLabel(entry.starTypeName, `${label}.starTypeName`, 1),
        starTypeNameTruncated: boolean(entry.starTypeNameTruncated, `${label}.starTypeNameTruncated`),
        positionX: finiteNumber(entry.positionX, `${label}.positionX`, -Number.MAX_VALUE),
        positionY: finiteNumber(entry.positionY, `${label}.positionY`, -Number.MAX_VALUE),
        distanceFromOriginLy: finiteNumber(entry.distanceFromOriginLy, `${label}.distanceFromOriginLy`),
        luminosity: finiteNumber(entry.luminosity, `${label}.luminosity`),
        massMultiplier: finiteNumber(entry.massMultiplier, `${label}.massMultiplier`),
        radiusMultiplier: finiteNumber(entry.radiusMultiplier, `${label}.radiusMultiplier`),
        active,
        discovered,
        missionActive: boolean(entry.missionActive, `${label}.missionActive`),
        missionElapsedSeconds: finiteNumber(entry.missionElapsedSeconds, `${label}.missionElapsedSeconds`),
        missionDurationSeconds: finiteNumber(entry.missionDurationSeconds, `${label}.missionDurationSeconds`),
        surveyProgress: stellarUnitNumber(entry.surveyProgress, `${label}.surveyProgress`),
        firstPlanetId: opaqueId(entry.firstPlanetId, `${label}.firstPlanetId`),
        planetCount,
        colonizedPlanetCount,
      };
    },
  );

  const planetIds = new Set();
  let nestedTruncated = false;
  const planets = normalizeStellarPage(
    source.planets,
    echoed.planetCursor,
    echoed.planetLimit,
    "native star-map catalog planets",
    (row, label) => {
      const entry = exactObject(row, [
        "planetId", "displayName", "displayNameTruncated", "systemId", "systemDisplayName",
        "systemDisplayNameTruncated", "kind", "orbitIndex", "simulationOrder", "systemPositionX",
        "systemPositionY", "active", "discovered", "colonized", "industryRole", "entityCount",
        "deviceCount", "beltCount", "metadata", "profile",
      ], label);
      const planetId = opaqueId(entry.planetId, `${label}.planetId`);
      if (planetIds.has(planetId)) throw protocolError(`${label}.planetId`);
      planetIds.add(planetId);
      const systemId = opaqueId(entry.systemId, `${label}.systemId`);
      const active = boolean(entry.active, `${label}.active`);
      const discovered = boolean(entry.discovered, `${label}.discovered`);
      const colonized = boolean(entry.colonized, `${label}.colonized`);
      if (active && (planetId !== activePlanetId || systemId !== activeSystemId || !colonized) ||
          colonized && !discovered) {
        throw protocolError(`${label} authority binding`);
      }
      const metadataSource = exactObject(entry.metadata, [
        "note", "noteTruncated", "tagTextTruncated", "tags",
      ], `${label}.metadata`);
      const tags = normalizeStarMapCatalogList(
        metadataSource.tags,
        limits.tagRows,
        `${label}.metadata.tags`,
        (tag, tagLabel) => stellarLabel(tag, tagLabel, 1),
        (tag) => tag,
      );
      const metadata = {
        note: stellarLabel(metadataSource.note, `${label}.metadata.note`),
        noteTruncated: boolean(metadataSource.noteTruncated, `${label}.metadata.noteTruncated`),
        tagTextTruncated: boolean(
          metadataSource.tagTextTruncated,
          `${label}.metadata.tagTextTruncated`,
        ),
        tags,
      };
      const profileSource = exactObject(entry.profile, [
        "climateName", "climateNameTruncated", "oceanType", "specialization",
        "specializationName", "specializationNameTruncated", "tidalLocked", "sulfuricOcean",
        "windMultiplier", "solarMultiplier", "geothermalMultiplier", "miningMultiplier",
        "orbitalYieldMultiplier", "reserveScale", "travelTimeMultiplier",
        "productionSpeedMultiplier", "surveyDurationSeconds", "resourceIds", "rareResourceIds",
        "orbitalYields",
      ], `${label}.profile`);
      const normalizeItems = (value, listLabel) => normalizeStarMapCatalogList(
        value,
        limits.nestedRows,
        listLabel,
        (itemId, itemLabel) => opaqueId(itemId, itemLabel),
        (itemId) => itemId,
      );
      const resourceIds = normalizeItems(profileSource.resourceIds, `${label}.profile.resourceIds`);
      const rareResourceIds = normalizeItems(
        profileSource.rareResourceIds,
        `${label}.profile.rareResourceIds`,
      );
      const orbitalYields = normalizeStarMapCatalogList(
        profileSource.orbitalYields,
        limits.nestedRows,
        `${label}.profile.orbitalYields`,
        (value, yieldLabel) => {
          const yieldSource = exactObject(value, ["itemId", "rate"], yieldLabel);
          return {
            itemId: opaqueId(yieldSource.itemId, `${yieldLabel}.itemId`),
            rate: finiteNumber(yieldSource.rate, `${yieldLabel}.rate`),
          };
        },
        (value) => value.itemId,
      );
      for (let index = 1; index < orbitalYields.rows.length; index += 1) {
        if (orbitalYields.rows[index - 1].itemId >= orbitalYields.rows[index].itemId) {
          throw protocolError(`${label}.profile.orbitalYields order`);
        }
      }
      nestedTruncated ||= metadata.noteTruncated || metadata.tagTextTruncated || tags.truncated || resourceIds.truncated ||
        rareResourceIds.truncated || orbitalYields.truncated;
      return {
        planetId,
        displayName: stellarLabel(entry.displayName, `${label}.displayName`, 1),
        displayNameTruncated: boolean(entry.displayNameTruncated, `${label}.displayNameTruncated`),
        systemId,
        systemDisplayName: stellarLabel(entry.systemDisplayName, `${label}.systemDisplayName`, 1),
        systemDisplayNameTruncated: boolean(
          entry.systemDisplayNameTruncated,
          `${label}.systemDisplayNameTruncated`,
        ),
        kind: stellarLabel(entry.kind, `${label}.kind`, 1),
        orbitIndex: safeInteger(entry.orbitIndex, `${label}.orbitIndex`),
        simulationOrder: safeInteger(entry.simulationOrder, `${label}.simulationOrder`),
        systemPositionX: finiteNumber(entry.systemPositionX, `${label}.systemPositionX`, -Number.MAX_VALUE),
        systemPositionY: finiteNumber(entry.systemPositionY, `${label}.systemPositionY`, -Number.MAX_VALUE),
        active,
        discovered,
        colonized,
        industryRole: oneOf(
          entry.industryRole,
          ["auto", "mining", "smelting", "manufacturing", "chemical", "research", "logistics", "power"],
          `${label}.industryRole`,
        ),
        entityCount: safeInteger(entry.entityCount, `${label}.entityCount`),
        deviceCount: finiteNumber(entry.deviceCount, `${label}.deviceCount`),
        beltCount: safeInteger(entry.beltCount, `${label}.beltCount`),
        metadata,
        profile: {
          climateName: stellarLabel(profileSource.climateName, `${label}.profile.climateName`, 1),
          climateNameTruncated: boolean(
            profileSource.climateNameTruncated,
            `${label}.profile.climateNameTruncated`,
          ),
          oceanType: stellarLabel(profileSource.oceanType, `${label}.profile.oceanType`, 1),
          specialization: stellarLabel(profileSource.specialization, `${label}.profile.specialization`, 1),
          specializationName: stellarLabel(
            profileSource.specializationName,
            `${label}.profile.specializationName`,
          ),
          specializationNameTruncated: boolean(
            profileSource.specializationNameTruncated,
            `${label}.profile.specializationNameTruncated`,
          ),
          tidalLocked: boolean(profileSource.tidalLocked, `${label}.profile.tidalLocked`),
          sulfuricOcean: boolean(profileSource.sulfuricOcean, `${label}.profile.sulfuricOcean`),
          windMultiplier: finiteNumber(profileSource.windMultiplier, `${label}.profile.windMultiplier`),
          solarMultiplier: finiteNumber(profileSource.solarMultiplier, `${label}.profile.solarMultiplier`),
          geothermalMultiplier: finiteNumber(
            profileSource.geothermalMultiplier,
            `${label}.profile.geothermalMultiplier`,
          ),
          miningMultiplier: finiteNumber(profileSource.miningMultiplier, `${label}.profile.miningMultiplier`),
          orbitalYieldMultiplier: finiteNumber(
            profileSource.orbitalYieldMultiplier,
            `${label}.profile.orbitalYieldMultiplier`,
          ),
          reserveScale: finiteNumber(profileSource.reserveScale, `${label}.profile.reserveScale`),
          travelTimeMultiplier: finiteNumber(
            profileSource.travelTimeMultiplier,
            `${label}.profile.travelTimeMultiplier`,
          ),
          productionSpeedMultiplier: finiteNumber(
            profileSource.productionSpeedMultiplier,
            `${label}.profile.productionSpeedMultiplier`,
          ),
          surveyDurationSeconds: finiteNumber(
            profileSource.surveyDurationSeconds,
            `${label}.profile.surveyDurationSeconds`,
          ),
          resourceIds,
          rareResourceIds,
          orbitalYields,
        },
      };
    },
  );

  const summarySource = exactObject(source.summary, [
    "systemCount", "unlockedSystemCount", "planetCount", "colonizedPlanetCount",
  ], "native star-map catalog summary");
  const summary = {
    systemCount: safeInteger(summarySource.systemCount, "native star-map catalog system count", 1),
    unlockedSystemCount: safeInteger(
      summarySource.unlockedSystemCount,
      "native star-map catalog unlocked system count",
      1,
    ),
    planetCount: safeInteger(summarySource.planetCount, "native star-map catalog planet count", 1),
    colonizedPlanetCount: safeInteger(
      summarySource.colonizedPlanetCount,
      "native star-map catalog colonized planet count",
      1,
    ),
  };
  if (systems.totalCount !== summary.systemCount || planets.totalCount !== summary.planetCount ||
      summary.unlockedSystemCount > summary.systemCount ||
      summary.colonizedPlanetCount > summary.planetCount) {
    throw protocolError("native star-map catalog summary binding");
  }
  const truncated = boolean(source.truncated, "native star-map catalog truncated");
  if (truncated !== (systems.nextCursor !== null || planets.nextCursor !== null || nestedTruncated)) {
    throw protocolError("native star-map catalog truncation binding");
  }
  return {
    schemaVersion: 1,
    projectionType: "star-map-catalog-v1",
    revision,
    registryFingerprint,
    stateVersion: 47,
    limits,
    request: {
      expectedRevision: echoed.expectedRevision,
      expectedRegistryFingerprint: echoed.expectedRegistryFingerprint,
      systemCursor: echoed.systemCursor,
      systemLimit: echoed.systemLimit,
      planetCursor: echoed.planetCursor,
      planetLimit: echoed.planetLimit,
    },
    activePlanetId,
    activeSystemId,
    galaxySeed: safeInteger(source.galaxySeed, "native star-map catalog galaxy seed"),
    summary,
    truncated,
    systems,
    planets,
  };
}

function normalizeCoreStellarIndustryProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "registryFingerprint", "stateVersion",
    "limits", "request", "activePlanetId", "activeSystemId", "scopeSystemId", "scopePlanetId",
    "truncated", "planets", "stations",
  ], "native stellar industry projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "stellar-industry-v1") {
    throw protocolError("native stellar industry projection identity");
  }
  requireProjectionByteBudget(source, "native stellar industry projection");
  const projectionContext = normalizeStellarIndustryProjectionContext(
    context,
    "native stellar industry projection context",
  );
  const revision = safeInteger(source.revision, "native stellar industry revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native stellar industry registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint || source.stateVersion !== 47) {
    throw protocolError("native stellar industry identity binding");
  }
  const limits = normalizeStellarProjectionLimits(source.limits, "native stellar industry limits");
  const requestSource = exactObject(source.request, [
    "expectedRevision", "expectedRegistryFingerprint", "systemId", "planetId",
    "planetCursor", "planetLimit", "stationCursor", "stationLimit",
  ], "native stellar industry echoed request");
  const echoed = normalizeStellarIndustryProjectionContext({
    sessionId: projectionContext.sessionId,
    ...requestSource,
  }, "native stellar industry echoed request");
  for (const key of [
    "expectedRevision", "expectedRegistryFingerprint", "systemId", "planetId",
    "planetCursor", "planetLimit", "stationCursor", "stationLimit",
  ]) {
    if (echoed[key] !== projectionContext[key]) {
      throw protocolError("native stellar industry request binding");
    }
  }
  const nullableId = (entry, label) => entry === null ? null : opaqueId(entry, label);
  const activePlanetId = opaqueId(source.activePlanetId, "native stellar industry active planet");
  const activeSystemId = opaqueId(source.activeSystemId, "native stellar industry active system");
  const scopeSystemId = nullableId(source.scopeSystemId, "native stellar industry scope system");
  const scopePlanetId = nullableId(source.scopePlanetId, "native stellar industry scope planet");
  if (scopePlanetId !== echoed.planetId ||
      echoed.systemId !== null && scopeSystemId !== echoed.systemId ||
      echoed.systemId === null && echoed.planetId === null && scopeSystemId !== null ||
      echoed.planetId !== null && scopeSystemId === null) {
    throw protocolError("native stellar industry scope binding");
  }

  const planetIds = new Set();
  const planets = normalizeStellarPage(
    source.planets,
    echoed.planetCursor,
    echoed.planetLimit,
    "native stellar industry planets",
    (row, label) => {
      const entry = exactObject(row, [
        "planetId", "displayName", "displayNameTruncated", "systemId", "systemDisplayName",
        "systemDisplayNameTruncated", "kind", "orbitIndex", "simulationOrder", "systemPositionX",
        "systemPositionY", "active", "discovered", "colonized", "industryRole", "entityCount",
        "deviceCount", "beltCount", "stationCount", "interstellarStationCount",
        "orbitalCollectorCount", "legacyStationCount", "quantumStationCount",
        "quantumAttachableCount", "configuredImportSlotCount", "configuredExportSlotCount",
        "routeCount", "activeRouteCount", "congestedStationId", "power", "profile",
      ], label);
      const planetId = opaqueId(entry.planetId, `${label}.planetId`);
      const systemId = opaqueId(entry.systemId, `${label}.systemId`);
      if (planetIds.has(planetId) || scopeSystemId !== null && systemId !== scopeSystemId ||
          scopePlanetId !== null && planetId !== scopePlanetId) {
        throw protocolError(`${label} scope binding`);
      }
      planetIds.add(planetId);
      const stationCount = safeInteger(entry.stationCount, `${label}.stationCount`);
      const interstellarStationCount = safeInteger(
        entry.interstellarStationCount,
        `${label}.interstellarStationCount`,
      );
      const orbitalCollectorCount = safeInteger(
        entry.orbitalCollectorCount,
        `${label}.orbitalCollectorCount`,
      );
      const legacyStationCount = safeInteger(entry.legacyStationCount, `${label}.legacyStationCount`);
      const quantumStationCount = safeInteger(entry.quantumStationCount, `${label}.quantumStationCount`);
      const quantumAttachableCount = safeInteger(
        entry.quantumAttachableCount,
        `${label}.quantumAttachableCount`,
      );
      const routeCount = safeInteger(entry.routeCount, `${label}.routeCount`);
      const activeRouteCount = safeInteger(entry.activeRouteCount, `${label}.activeRouteCount`);
      if (interstellarStationCount > stationCount || orbitalCollectorCount > stationCount ||
          legacyStationCount > stationCount || quantumStationCount > stationCount ||
          quantumAttachableCount > stationCount || activeRouteCount > routeCount) {
        throw protocolError(`${label} cardinality binding`);
      }
      const powerSource = exactObject(entry.power, [
        "generationKw", "demandKw", "powerFactor", "totalItemsPerMinute",
      ], `${label}.power`);
      const profileSource = exactObject(entry.profile, [
        "climateName", "climateNameTruncated", "oceanType", "specialization",
        "specializationName", "specializationNameTruncated", "tidalLocked", "windMultiplier",
        "solarMultiplier", "geothermalMultiplier", "miningMultiplier", "orbitalYieldMultiplier",
        "reserveScale", "travelTimeMultiplier",
      ], `${label}.profile`);
      const active = boolean(entry.active, `${label}.active`);
      if (active && (planetId !== activePlanetId || systemId !== activeSystemId)) {
        throw protocolError(`${label} active binding`);
      }
      return {
        planetId,
        displayName: stellarLabel(entry.displayName, `${label}.displayName`, 1),
        displayNameTruncated: boolean(entry.displayNameTruncated, `${label}.displayNameTruncated`),
        systemId,
        systemDisplayName: stellarLabel(entry.systemDisplayName, `${label}.systemDisplayName`, 1),
        systemDisplayNameTruncated: boolean(
          entry.systemDisplayNameTruncated,
          `${label}.systemDisplayNameTruncated`,
        ),
        kind: stellarLabel(entry.kind, `${label}.kind`, 1),
        orbitIndex: safeInteger(entry.orbitIndex, `${label}.orbitIndex`),
        simulationOrder: safeInteger(entry.simulationOrder, `${label}.simulationOrder`),
        systemPositionX: finiteNumber(entry.systemPositionX, `${label}.systemPositionX`, -Number.MAX_VALUE),
        systemPositionY: finiteNumber(entry.systemPositionY, `${label}.systemPositionY`, -Number.MAX_VALUE),
        active,
        discovered: boolean(entry.discovered, `${label}.discovered`),
        colonized: boolean(entry.colonized, `${label}.colonized`),
        industryRole: oneOf(entry.industryRole, [
          "auto", "mining", "smelting", "manufacturing", "chemical", "research", "logistics", "power",
        ], `${label}.industryRole`),
        entityCount: safeInteger(entry.entityCount, `${label}.entityCount`),
        deviceCount: finiteNumber(entry.deviceCount, `${label}.deviceCount`),
        beltCount: safeInteger(entry.beltCount, `${label}.beltCount`),
        stationCount,
        interstellarStationCount,
        orbitalCollectorCount,
        legacyStationCount,
        quantumStationCount,
        quantumAttachableCount,
        configuredImportSlotCount: safeInteger(
          entry.configuredImportSlotCount,
          `${label}.configuredImportSlotCount`,
        ),
        configuredExportSlotCount: safeInteger(
          entry.configuredExportSlotCount,
          `${label}.configuredExportSlotCount`,
        ),
        routeCount,
        activeRouteCount,
        congestedStationId: nullableId(entry.congestedStationId, `${label}.congestedStationId`),
        power: {
          generationKw: finiteNumber(powerSource.generationKw, `${label}.power.generationKw`),
          demandKw: finiteNumber(powerSource.demandKw, `${label}.power.demandKw`),
          powerFactor: stellarUnitNumber(powerSource.powerFactor, `${label}.power.powerFactor`),
          totalItemsPerMinute: finiteNumber(
            powerSource.totalItemsPerMinute,
            `${label}.power.totalItemsPerMinute`,
          ),
        },
        profile: {
          climateName: stellarLabel(profileSource.climateName, `${label}.profile.climateName`, 1),
          climateNameTruncated: boolean(
            profileSource.climateNameTruncated,
            `${label}.profile.climateNameTruncated`,
          ),
          oceanType: stellarNullableToken(profileSource.oceanType, `${label}.profile.oceanType`),
          specialization: stellarNullableToken(
            profileSource.specialization,
            `${label}.profile.specialization`,
          ),
          specializationName: stellarLabel(
            profileSource.specializationName,
            `${label}.profile.specializationName`,
          ),
          specializationNameTruncated: boolean(
            profileSource.specializationNameTruncated,
            `${label}.profile.specializationNameTruncated`,
          ),
          tidalLocked: boolean(profileSource.tidalLocked, `${label}.profile.tidalLocked`),
          windMultiplier: finiteNumber(profileSource.windMultiplier, `${label}.profile.windMultiplier`),
          solarMultiplier: finiteNumber(profileSource.solarMultiplier, `${label}.profile.solarMultiplier`),
          geothermalMultiplier: finiteNumber(
            profileSource.geothermalMultiplier,
            `${label}.profile.geothermalMultiplier`,
          ),
          miningMultiplier: finiteNumber(profileSource.miningMultiplier, `${label}.profile.miningMultiplier`),
          orbitalYieldMultiplier: finiteNumber(
            profileSource.orbitalYieldMultiplier,
            `${label}.profile.orbitalYieldMultiplier`,
          ),
          reserveScale: finiteNumber(profileSource.reserveScale, `${label}.profile.reserveScale`),
          travelTimeMultiplier: finiteNumber(
            profileSource.travelTimeMultiplier,
            `${label}.profile.travelTimeMultiplier`,
          ),
        },
      };
    },
  );
  if (scopePlanetId !== null && planets.totalCount > 1) {
    throw protocolError("native stellar industry planet scope cardinality");
  }

  const stationIds = new Set();
  const stations = normalizeStellarPage(
    source.stations,
    echoed.stationCursor,
    echoed.stationLimit,
    "native stellar industry stations",
    (row, label) => {
      const entry = exactObject(row, [
        "stationId", "buildingId", "buildingLabel", "buildingLabelTruncated", "planetId",
        "planetLabel", "planetLabelTruncated", "systemId", "positionX", "positionY",
        "stationTier", "quantumMode", "quantumTransitionActive", "powerFactor", "congestion",
        "installedDrones", "installedVessels", "availableWarpers", "slotCount",
        "configuredImportSlotCount", "configuredExportSlotCount", "routeCount", "activeRouteCount",
      ], label);
      const stationId = opaqueId(entry.stationId, `${label}.stationId`);
      const planetId = opaqueId(entry.planetId, `${label}.planetId`);
      const systemId = opaqueId(entry.systemId, `${label}.systemId`);
      if (stationIds.has(stationId) || scopeSystemId !== null && systemId !== scopeSystemId ||
          scopePlanetId !== null && planetId !== scopePlanetId) {
        throw protocolError(`${label} scope binding`);
      }
      stationIds.add(stationId);
      const routeCount = safeInteger(entry.routeCount, `${label}.routeCount`);
      const activeRouteCount = safeInteger(entry.activeRouteCount, `${label}.activeRouteCount`);
      if (activeRouteCount > routeCount) throw protocolError(`${label} route cardinality`);
      return {
        stationId,
        buildingId: nullableId(entry.buildingId, `${label}.buildingId`),
        buildingLabel: stellarLabel(entry.buildingLabel, `${label}.buildingLabel`, 1),
        buildingLabelTruncated: boolean(
          entry.buildingLabelTruncated,
          `${label}.buildingLabelTruncated`,
        ),
        planetId,
        planetLabel: stellarLabel(entry.planetLabel, `${label}.planetLabel`, 1),
        planetLabelTruncated: boolean(entry.planetLabelTruncated, `${label}.planetLabelTruncated`),
        systemId,
        positionX: finiteNumber(entry.positionX, `${label}.positionX`, -Number.MAX_VALUE),
        positionY: finiteNumber(entry.positionY, `${label}.positionY`, -Number.MAX_VALUE),
        stationTier: safeInteger(entry.stationTier, `${label}.stationTier`),
        quantumMode: stellarNullableToken(entry.quantumMode, `${label}.quantumMode`),
        quantumTransitionActive: boolean(
          entry.quantumTransitionActive,
          `${label}.quantumTransitionActive`,
        ),
        powerFactor: stellarUnitNumber(entry.powerFactor, `${label}.powerFactor`),
        congestion: stellarUnitNumber(entry.congestion, `${label}.congestion`),
        installedDrones: safeInteger(entry.installedDrones, `${label}.installedDrones`),
        installedVessels: safeInteger(entry.installedVessels, `${label}.installedVessels`),
        availableWarpers: safeInteger(entry.availableWarpers, `${label}.availableWarpers`),
        slotCount: safeInteger(entry.slotCount, `${label}.slotCount`),
        configuredImportSlotCount: safeInteger(
          entry.configuredImportSlotCount,
          `${label}.configuredImportSlotCount`,
        ),
        configuredExportSlotCount: safeInteger(
          entry.configuredExportSlotCount,
          `${label}.configuredExportSlotCount`,
        ),
        routeCount,
        activeRouteCount,
      };
    },
  );
  const truncated = boolean(source.truncated, "native stellar industry truncated");
  if (truncated !== (planets.nextCursor !== null || stations.nextCursor !== null)) {
    throw protocolError("native stellar industry truncation binding");
  }
  return {
    schemaVersion: 1,
    projectionType: "stellar-industry-v1",
    revision,
    registryFingerprint,
    stateVersion: 47,
    limits,
    request: {
      expectedRevision: echoed.expectedRevision,
      expectedRegistryFingerprint: echoed.expectedRegistryFingerprint,
      systemId: echoed.systemId,
      planetId: echoed.planetId,
      planetCursor: echoed.planetCursor,
      planetLimit: echoed.planetLimit,
      stationCursor: echoed.stationCursor,
      stationLimit: echoed.stationLimit,
    },
    activePlanetId,
    activeSystemId,
    scopeSystemId,
    scopePlanetId,
    truncated,
    planets,
    stations,
  };
}

function normalizeCoreStellarIndustryV2Projection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "registryFingerprint", "stateVersion",
    "limits", "request", "activePlanetId", "activeSystemId", "scopeSystemId", "scopePlanetId",
    "truncated", "planets", "stations", "routeSummary", "routes",
  ], "native stellar industry v2 projection");
  if (source.schemaVersion !== 2 || source.projectionType !== "stellar-industry-v2") {
    throw protocolError("native stellar industry v2 projection identity");
  }
  requireProjectionByteBudget(source, "native stellar industry v2 projection");
  const projectionContext = normalizeStellarIndustryV2ProjectionContext(
    context,
    "native stellar industry v2 projection context",
  );
  const requestSource = exactObject(source.request, [
    "expectedRevision", "expectedRegistryFingerprint", "systemId", "planetId",
    "planetCursor", "planetLimit", "stationCursor", "stationLimit", "routeCursor",
    "routeLimit", "routeFilter", "query",
  ], "native stellar industry v2 echoed request");
  const echoed = normalizeStellarIndustryV2ProjectionContext({
    sessionId: projectionContext.sessionId,
    ...requestSource,
  }, "native stellar industry v2 echoed request");
  for (const key of [
    "expectedRevision", "expectedRegistryFingerprint", "systemId", "planetId",
    "planetCursor", "planetLimit", "stationCursor", "stationLimit", "routeCursor",
    "routeLimit", "routeFilter", "query",
  ]) {
    if (echoed[key] !== projectionContext[key]) {
      throw protocolError("native stellar industry v2 request binding");
    }
  }

  const limitsSource = exactObject(source.limits, [
    "requestBytes", "projectionBytes", "pageRows", "labelBytes", "queryBytes", "pathVisits",
  ], "native stellar industry v2 limits");
  const limits = {
    ...normalizeStellarProjectionLimits({
      requestBytes: limitsSource.requestBytes,
      projectionBytes: limitsSource.projectionBytes,
      pageRows: limitsSource.pageRows,
      labelBytes: limitsSource.labelBytes,
    }, "native stellar industry v2 base limits"),
    queryBytes: safeInteger(limitsSource.queryBytes, "native stellar industry v2 query limit", 1),
    pathVisits: safeInteger(limitsSource.pathVisits, "native stellar industry v2 path limit", 1),
  };
  if (limits.queryBytes !== 512 || limits.pathVisits !== 200_000) {
    throw protocolError("native stellar industry v2 extended limit binding");
  }

  // The v2 envelope intentionally embeds the exact v1 planet/station model.
  // Normalize it through the already strict v1 boundary so the two versions
  // cannot drift or relax each other's identity and cardinality checks.
  const baseTruncated = source.planets?.nextCursor !== null || source.stations?.nextCursor !== null;
  const base = normalizeCoreStellarIndustryProjection({
    schemaVersion: 1,
    projectionType: "stellar-industry-v1",
    revision: source.revision,
    registryFingerprint: source.registryFingerprint,
    stateVersion: source.stateVersion,
    limits: {
      requestBytes: limits.requestBytes,
      projectionBytes: limits.projectionBytes,
      pageRows: limits.pageRows,
      labelBytes: limits.labelBytes,
    },
    request: {
      expectedRevision: requestSource.expectedRevision,
      expectedRegistryFingerprint: requestSource.expectedRegistryFingerprint,
      systemId: requestSource.systemId,
      planetId: requestSource.planetId,
      planetCursor: requestSource.planetCursor,
      planetLimit: requestSource.planetLimit,
      stationCursor: requestSource.stationCursor,
      stationLimit: requestSource.stationLimit,
    },
    activePlanetId: source.activePlanetId,
    activeSystemId: source.activeSystemId,
    scopeSystemId: source.scopeSystemId,
    scopePlanetId: source.scopePlanetId,
    truncated: baseTruncated,
    planets: source.planets,
    stations: source.stations,
  }, {
    sessionId: projectionContext.sessionId,
    expectedRevision: projectionContext.expectedRevision,
    expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
    systemId: projectionContext.systemId,
    planetId: projectionContext.planetId,
    planetCursor: projectionContext.planetCursor,
    planetLimit: projectionContext.planetLimit,
    stationCursor: projectionContext.stationCursor,
    stationLimit: projectionContext.stationLimit,
  });

  const nullableId = (entry, label) => entry === null ? null : opaqueId(entry, label);
  const nullableLabel = (entry, label) => entry === null ? null : stellarLabel(entry, label, 1);
  const nullableIndex = (entry, label) => entry === null ? null : safeInteger(entry, label);
  const routeIds = new Set();
  const routes = normalizeStellarPage(
    source.routes,
    echoed.routeCursor,
    echoed.routeLimit,
    "native stellar industry routes",
    (row, label) => {
      const entry = exactObject(row, [
        "id", "scope", "itemId", "itemLabel", "itemLabelTruncated", "sourceStationId",
        "sourceStationLabel", "sourceStationLabelTruncated", "sourceBuildingId",
        "sourceBuildingLabel", "sourceSlotIndex", "sourcePlanetId", "sourcePlanetLabel",
        "sourcePlanetLabelTruncated", "targetStationId", "targetStationLabel",
        "targetStationLabelTruncated", "targetBuildingId", "targetBuildingLabel",
        "targetSlotIndex", "targetSlotIsPrimary", "targetPlanetId", "targetPlanetLabel", "targetPlanetLabelTruncated",
        "sourceStock", "sourceReserve", "sourceSlotMinStock", "sourceSlotMaxStock",
        "targetStock", "targetLimit", "targetFree", "targetSlotMinStock", "targetSlotMaxStock",
        "minimumLoad", "minimumCargo", "priority", "installedVehicles",
        "installedVehicleCapacity", "availableVehicles", "activeVehicles", "activeRouteCount",
        "activeCargo", "activeRouteItemConsistent", "distanceLy", "orbitSpan",
        "durationSeconds", "cargoPerTrip", "throughputPerMinute",
        "economicsThroughputPerMinute", "powerKw", "energyMjPerTrip", "warpersPerTrip",
        "warpersPerVessel", "availableWarpers", "dispatchStationId", "dispatchPlanetId",
        "dispatchDirection", "routeKind", "routeAvailable", "routePlanningComplete",
        "routePathLabel", "routePathLabelTruncated", "waypointStationIds",
        "waypointPlanetIds", "waypointStationLabels", "hopCount", "maxLegDistanceLy",
        "routePolicy", "warperBudget", "requiresWarp", "warpVehicleReady",
        "localVehiclePowerReady", "sourcePowerFactor", "targetPowerFactor", "routePowerReady",
        "powerProofComplete", "sourceCongestion", "targetCongestion",
        "waypointMaxCongestion", "routeCongestion", "status", "statusLabel",
      ], label);
      const id = opaqueId(entry.id, `${label}.id`);
      if (routeIds.has(id)) throw protocolError(`${label}.id`);
      routeIds.add(id);
      const scope = oneOf(entry.scope, ["local", "remote"], `${label}.scope`);
      const sourceStationId = nullableId(entry.sourceStationId, `${label}.sourceStationId`);
      const sourceBuildingId = nullableId(entry.sourceBuildingId, `${label}.sourceBuildingId`);
      const sourceBuildingLabel = nullableLabel(entry.sourceBuildingLabel, `${label}.sourceBuildingLabel`);
      const sourceSlotIndex = nullableIndex(entry.sourceSlotIndex, `${label}.sourceSlotIndex`);
      const sourcePlanetId = nullableId(entry.sourcePlanetId, `${label}.sourcePlanetId`);
      const sourcePlanetLabel = nullableLabel(entry.sourcePlanetLabel, `${label}.sourcePlanetLabel`);
      if ((sourceStationId === null) !== (sourceBuildingId === null) ||
          (sourceStationId === null) !== (sourceBuildingLabel === null) ||
          (sourceStationId === null) !== (sourceSlotIndex === null) ||
          (sourceStationId === null) !== (sourcePlanetId === null) ||
          (sourceStationId === null) !== (sourcePlanetLabel === null)) {
        throw protocolError(`${label} source identity group`);
      }
      const waypointStationIds = opaqueIdArray(
        entry.waypointStationIds,
        `${label}.waypointStationIds`,
        200_000,
      );
      const waypointPlanetIds = opaqueIdArray(
        entry.waypointPlanetIds,
        `${label}.waypointPlanetIds`,
        200_000,
      );
      if (!Array.isArray(entry.waypointStationLabels) ||
          entry.waypointStationLabels.length !== waypointStationIds.length ||
          waypointPlanetIds.length !== waypointStationIds.length) {
        throw protocolError(`${label} waypoint binding`);
      }
      const waypointStationLabels = entry.waypointStationLabels.map((value, index) =>
        stellarLabel(value, `${label}.waypointStationLabels[${index}]`, 1));
      const minimumLoad = finiteNumber(entry.minimumLoad, `${label}.minimumLoad`);
      if (![0.1, 0.25, 0.5, 1].includes(minimumLoad)) {
        throw protocolError(`${label}.minimumLoad`);
      }
      const installedVehicles = finiteNumber(entry.installedVehicles, `${label}.installedVehicles`);
      const availableVehicles = finiteNumber(entry.availableVehicles, `${label}.availableVehicles`);
      const activeVehicles = finiteNumber(entry.activeVehicles, `${label}.activeVehicles`);
      if (availableVehicles > installedVehicles || activeVehicles > installedVehicles) {
        throw protocolError(`${label} vehicle cardinality`);
      }
      const hopCount = safeInteger(entry.hopCount, `${label}.hopCount`);
      if (hopCount !== waypointStationIds.length + 1 && sourceStationId !== null) {
        throw protocolError(`${label} hop binding`);
      }
      const status = oneOf(entry.status, [
        "active", "ready", "missing-source", "missing-vehicle", "missing-hub",
        "missing-warper", "missing-stock", "target-full", "no-power",
      ], `${label}.status`);
      const dispatchStationId = nullableId(entry.dispatchStationId, `${label}.dispatchStationId`);
      const dispatchPlanetId = nullableId(entry.dispatchPlanetId, `${label}.dispatchPlanetId`);
      if ((dispatchStationId === null) !== (dispatchPlanetId === null)) {
        throw protocolError(`${label} dispatch identity group`);
      }
      return {
        id,
        scope,
        itemId: opaqueId(entry.itemId, `${label}.itemId`),
        itemLabel: stellarLabel(entry.itemLabel, `${label}.itemLabel`, 1),
        itemLabelTruncated: boolean(entry.itemLabelTruncated, `${label}.itemLabelTruncated`),
        sourceStationId,
        sourceStationLabel: stellarLabel(entry.sourceStationLabel, `${label}.sourceStationLabel`, 1),
        sourceStationLabelTruncated: boolean(entry.sourceStationLabelTruncated, `${label}.sourceStationLabelTruncated`),
        sourceBuildingId,
        sourceBuildingLabel,
        sourceSlotIndex,
        sourcePlanetId,
        sourcePlanetLabel,
        sourcePlanetLabelTruncated: boolean(entry.sourcePlanetLabelTruncated, `${label}.sourcePlanetLabelTruncated`),
        targetStationId: opaqueId(entry.targetStationId, `${label}.targetStationId`),
        targetStationLabel: stellarLabel(entry.targetStationLabel, `${label}.targetStationLabel`, 1),
        targetStationLabelTruncated: boolean(entry.targetStationLabelTruncated, `${label}.targetStationLabelTruncated`),
        targetBuildingId: opaqueId(entry.targetBuildingId, `${label}.targetBuildingId`),
        targetBuildingLabel: stellarLabel(entry.targetBuildingLabel, `${label}.targetBuildingLabel`, 1),
        targetSlotIndex: safeInteger(entry.targetSlotIndex, `${label}.targetSlotIndex`),
        targetSlotIsPrimary: boolean(entry.targetSlotIsPrimary, `${label}.targetSlotIsPrimary`),
        targetPlanetId: opaqueId(entry.targetPlanetId, `${label}.targetPlanetId`),
        targetPlanetLabel: stellarLabel(entry.targetPlanetLabel, `${label}.targetPlanetLabel`, 1),
        targetPlanetLabelTruncated: boolean(entry.targetPlanetLabelTruncated, `${label}.targetPlanetLabelTruncated`),
        sourceStock: finiteNumber(entry.sourceStock, `${label}.sourceStock`),
        sourceReserve: finiteNumber(entry.sourceReserve, `${label}.sourceReserve`),
        sourceSlotMinStock: finiteNumber(entry.sourceSlotMinStock, `${label}.sourceSlotMinStock`),
        sourceSlotMaxStock: finiteNumber(entry.sourceSlotMaxStock, `${label}.sourceSlotMaxStock`),
        targetStock: finiteNumber(entry.targetStock, `${label}.targetStock`),
        targetLimit: finiteNumber(entry.targetLimit, `${label}.targetLimit`),
        targetFree: finiteNumber(entry.targetFree, `${label}.targetFree`),
        targetSlotMinStock: finiteNumber(entry.targetSlotMinStock, `${label}.targetSlotMinStock`),
        targetSlotMaxStock: finiteNumber(entry.targetSlotMaxStock, `${label}.targetSlotMaxStock`),
        minimumLoad,
        minimumCargo: finiteNumber(entry.minimumCargo, `${label}.minimumCargo`),
        priority: safeInteger(entry.priority, `${label}.priority`),
        installedVehicles,
        installedVehicleCapacity: finiteNumber(entry.installedVehicleCapacity, `${label}.installedVehicleCapacity`),
        availableVehicles,
        activeVehicles,
        activeRouteCount: safeInteger(entry.activeRouteCount, `${label}.activeRouteCount`),
        activeCargo: finiteNumber(entry.activeCargo, `${label}.activeCargo`),
        activeRouteItemConsistent: boolean(entry.activeRouteItemConsistent, `${label}.activeRouteItemConsistent`),
        distanceLy: finiteNumber(entry.distanceLy, `${label}.distanceLy`),
        orbitSpan: safeInteger(entry.orbitSpan, `${label}.orbitSpan`),
        durationSeconds: finiteNumber(entry.durationSeconds, `${label}.durationSeconds`),
        cargoPerTrip: finiteNumber(entry.cargoPerTrip, `${label}.cargoPerTrip`),
        throughputPerMinute: finiteNumber(entry.throughputPerMinute, `${label}.throughputPerMinute`),
        economicsThroughputPerMinute: finiteNumber(entry.economicsThroughputPerMinute, `${label}.economicsThroughputPerMinute`),
        powerKw: finiteNumber(entry.powerKw, `${label}.powerKw`),
        energyMjPerTrip: finiteNumber(entry.energyMjPerTrip, `${label}.energyMjPerTrip`),
        warpersPerTrip: finiteNumber(entry.warpersPerTrip, `${label}.warpersPerTrip`),
        warpersPerVessel: finiteNumber(entry.warpersPerVessel, `${label}.warpersPerVessel`),
        availableWarpers: finiteNumber(entry.availableWarpers, `${label}.availableWarpers`),
        dispatchStationId,
        dispatchPlanetId,
        dispatchDirection: oneOf(entry.dispatchDirection, ["unassigned", "supply-delivery", "demand-pickup"], `${label}.dispatchDirection`),
        routeKind: oneOf(entry.routeKind, ["local", "direct", "relay"], `${label}.routeKind`),
        routeAvailable: boolean(entry.routeAvailable, `${label}.routeAvailable`),
        routePlanningComplete: boolean(entry.routePlanningComplete, `${label}.routePlanningComplete`),
        routePathLabel: stellarLabel(entry.routePathLabel, `${label}.routePathLabel`, 1),
        routePathLabelTruncated: boolean(entry.routePathLabelTruncated, `${label}.routePathLabelTruncated`),
        waypointStationIds,
        waypointPlanetIds,
        waypointStationLabels,
        hopCount,
        maxLegDistanceLy: finiteNumber(entry.maxLegDistanceLy, `${label}.maxLegDistanceLy`),
        routePolicy: oneOf(entry.routePolicy, ["direct", "relay-preferred", "relay-required"], `${label}.routePolicy`),
        warperBudget: safeInteger(entry.warperBudget, `${label}.warperBudget`),
        requiresWarp: boolean(entry.requiresWarp, `${label}.requiresWarp`),
        warpVehicleReady: boolean(entry.warpVehicleReady, `${label}.warpVehicleReady`),
        localVehiclePowerReady: boolean(entry.localVehiclePowerReady, `${label}.localVehiclePowerReady`),
        sourcePowerFactor: stellarUnitNumber(entry.sourcePowerFactor, `${label}.sourcePowerFactor`),
        targetPowerFactor: stellarUnitNumber(entry.targetPowerFactor, `${label}.targetPowerFactor`),
        routePowerReady: boolean(entry.routePowerReady, `${label}.routePowerReady`),
        powerProofComplete: boolean(entry.powerProofComplete, `${label}.powerProofComplete`),
        sourceCongestion: stellarUnitNumber(entry.sourceCongestion, `${label}.sourceCongestion`),
        targetCongestion: stellarUnitNumber(entry.targetCongestion, `${label}.targetCongestion`),
        waypointMaxCongestion: stellarUnitNumber(entry.waypointMaxCongestion, `${label}.waypointMaxCongestion`),
        routeCongestion: stellarUnitNumber(entry.routeCongestion, `${label}.routeCongestion`),
        status,
        statusLabel: stellarLabel(entry.statusLabel, `${label}.statusLabel`, 1),
      };
    },
  );

  const summarySource = exactObject(source.routeSummary, [
    "scopeTotalCount", "filteredCount", "activeCount", "blockedCount", "remoteCount",
    "routePlanningIncompleteCount", "powerUnprovenCount", "statusCounts",
  ], "native stellar industry route summary");
  const allowedStatuses = [
    "active", "ready", "missing-source", "missing-vehicle", "missing-hub",
    "missing-warper", "missing-stock", "target-full", "no-power",
  ];
  const statusCountsSource = jsonObject(summarySource.statusCounts, "native stellar industry status counts");
  const statusKeys = Reflect.ownKeys(statusCountsSource);
  if (statusKeys.some((key) => typeof key !== "string" || !allowedStatuses.includes(key))) {
    throw protocolError("native stellar industry status counts");
  }
  const statusCounts = Object.fromEntries(statusKeys.map((key) => [
    key,
    safeInteger(statusCountsSource[key], `native stellar industry status counts.${key}`),
  ]));
  const routeSummary = {
    scopeTotalCount: safeInteger(summarySource.scopeTotalCount, "native stellar industry route scope count"),
    filteredCount: safeInteger(summarySource.filteredCount, "native stellar industry route filtered count"),
    activeCount: safeInteger(summarySource.activeCount, "native stellar industry active route count"),
    blockedCount: safeInteger(summarySource.blockedCount, "native stellar industry blocked route count"),
    remoteCount: safeInteger(summarySource.remoteCount, "native stellar industry remote route count"),
    routePlanningIncompleteCount: safeInteger(summarySource.routePlanningIncompleteCount, "native stellar industry incomplete route count"),
    powerUnprovenCount: safeInteger(summarySource.powerUnprovenCount, "native stellar industry unproven route power count"),
    statusCounts,
  };
  const statusTotal = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
  const blockedStatuses = ["missing-source", "missing-vehicle", "missing-hub", "missing-warper", "no-power"];
  const blockedTotal = blockedStatuses.reduce((sum, key) => sum + (statusCounts[key] ?? 0), 0);
  if (routeSummary.filteredCount !== routes.totalCount ||
      routeSummary.filteredCount > routeSummary.scopeTotalCount ||
      routeSummary.activeCount !== (statusCounts.active ?? 0) ||
      routeSummary.blockedCount !== blockedTotal ||
      routeSummary.remoteCount > routeSummary.scopeTotalCount ||
      routeSummary.routePlanningIncompleteCount > routeSummary.scopeTotalCount ||
      routeSummary.powerUnprovenCount > routeSummary.scopeTotalCount ||
      statusTotal !== routeSummary.scopeTotalCount) {
    throw protocolError("native stellar industry route summary binding");
  }
  const truncated = boolean(source.truncated, "native stellar industry v2 truncated");
  if (truncated !== (baseTruncated || routes.nextCursor !== null)) {
    throw protocolError("native stellar industry v2 truncation binding");
  }
  return {
    ...base,
    schemaVersion: 2,
    projectionType: "stellar-industry-v2",
    limits,
    request: {
      expectedRevision: echoed.expectedRevision,
      expectedRegistryFingerprint: echoed.expectedRegistryFingerprint,
      systemId: echoed.systemId,
      planetId: echoed.planetId,
      planetCursor: echoed.planetCursor,
      planetLimit: echoed.planetLimit,
      stationCursor: echoed.stationCursor,
      stationLimit: echoed.stationLimit,
      routeCursor: echoed.routeCursor,
      routeLimit: echoed.routeLimit,
      routeFilter: echoed.routeFilter,
      query: echoed.query,
    },
    truncated,
    routeSummary,
    routes,
  };
}

function normalizeCoreStellarQuantumProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "registryFingerprint", "stateVersion",
    "limits", "request", "enabled", "bandwidth", "runtime", "collectorSummary",
    "truncated", "items", "collectors",
  ], "native stellar quantum projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "stellar-quantum-v1") {
    throw protocolError("native stellar quantum projection identity");
  }
  requireProjectionByteBudget(source, "native stellar quantum projection");
  const projectionContext = normalizeStellarQuantumProjectionContext(
    context,
    "native stellar quantum projection context",
  );
  const revision = safeInteger(source.revision, "native stellar quantum revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native stellar quantum registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint || source.stateVersion !== 47) {
    throw protocolError("native stellar quantum identity binding");
  }
  const limitsSource = exactObject(source.limits, [
    "requestBytes", "projectionBytes", "pageRows", "decimalDigits",
  ], "native stellar quantum limits");
  const limits = {
    requestBytes: safeInteger(limitsSource.requestBytes, "native stellar quantum request byte limit", 1),
    projectionBytes: safeInteger(limitsSource.projectionBytes, "native stellar quantum projection byte limit", 1),
    pageRows: safeInteger(limitsSource.pageRows, "native stellar quantum page row limit", 1),
    decimalDigits: safeInteger(limitsSource.decimalDigits, "native stellar quantum decimal digit limit", 1),
  };
  if (limits.requestBytes !== 32_768 || limits.projectionBytes !== 1_048_576 ||
      limits.pageRows !== 64 || limits.decimalDigits !== 256) {
    throw protocolError("native stellar quantum limit binding");
  }
  const requestSource = exactObject(source.request, [
    "expectedRevision", "expectedRegistryFingerprint", "itemCursor", "itemLimit",
    "collectorCursor", "collectorLimit",
  ], "native stellar quantum echoed request");
  const echoed = normalizeStellarQuantumProjectionContext({
    sessionId: projectionContext.sessionId,
    ...requestSource,
  }, "native stellar quantum echoed request");
  for (const key of [
    "expectedRevision", "expectedRegistryFingerprint", "itemCursor", "itemLimit",
    "collectorCursor", "collectorLimit",
  ]) {
    if (echoed[key] !== projectionContext[key]) {
      throw protocolError("native stellar quantum request binding");
    }
  }

  const itemIds = new Set();
  const items = normalizeStellarPage(
    source.items,
    echoed.itemCursor,
    echoed.itemLimit,
    "native stellar quantum items",
    (row, label) => {
      const entry = exactObject(row, [
        "itemId", "inventory", "capacity", "uploaded", "downloaded",
      ], label);
      const itemId = opaqueId(entry.itemId, `${label}.itemId`);
      if (itemIds.has(itemId)) throw protocolError(`${label}.itemId`);
      itemIds.add(itemId);
      return {
        itemId,
        inventory: stellarDecimal(entry.inventory, `${label}.inventory`),
        capacity: stellarCapacity(entry.capacity, `${label}.capacity`),
        uploaded: stellarDecimal(entry.uploaded, `${label}.uploaded`),
        downloaded: stellarDecimal(entry.downloaded, `${label}.downloaded`),
      };
    },
  );
  if (items.totalCount > 4_096) throw protocolError("native stellar quantum item count");

  const collectorIds = new Set();
  const collectors = normalizeStellarPage(
    source.collectors,
    echoed.collectorCursor,
    echoed.collectorLimit,
    "native stellar quantum collectors",
    (row, label) => {
      const entry = exactObject(row, [
        "collectorId", "planetId", "systemId", "machineCount", "quantumMode",
        "quantumTransitionActive", "attachmentState",
      ], label);
      const collectorId = opaqueId(entry.collectorId, `${label}.collectorId`);
      if (collectorIds.has(collectorId)) throw protocolError(`${label}.collectorId`);
      collectorIds.add(collectorId);
      const quantumMode = oneOf(
        entry.quantumMode,
        ["legacy", "transitioning", "quantum"],
        `${label}.quantumMode`,
      );
      const quantumTransitionActive = boolean(
        entry.quantumTransitionActive,
        `${label}.quantumTransitionActive`,
      );
      const attachmentState = oneOf(
        entry.attachmentState,
        ["available", "pending", "connected", "unavailable"],
        `${label}.attachmentState`,
      );
      const expectedAttachmentState = quantumMode === "quantum"
        ? "connected"
        : quantumMode === "transitioning"
          ? "pending"
          : quantumTransitionActive
            ? "unavailable"
            : "available";
      if (attachmentState !== expectedAttachmentState ||
          quantumMode === "transitioning" && !quantumTransitionActive) {
        throw protocolError(`${label} attachment binding`);
      }
      return {
        collectorId,
        planetId: opaqueId(entry.planetId, `${label}.planetId`),
        systemId: opaqueId(entry.systemId, `${label}.systemId`),
        machineCount: safeInteger(entry.machineCount, `${label}.machineCount`),
        quantumMode,
        quantumTransitionActive,
        attachmentState,
      };
    },
  );
  if (collectors.totalCount > 8_192) throw protocolError("native stellar quantum collector count");

  const bandwidthSource = exactObject(source.bandwidth, [
    "multiplier", "globalUploadPerMinute", "globalDownloadPerMinute", "activeTowerCount",
    "activeTowerStacks",
  ], "native stellar quantum bandwidth");
  const bandwidth = {
    multiplier: finiteNumber(bandwidthSource.multiplier, "native stellar quantum multiplier", 1),
    globalUploadPerMinute: finiteNumber(
      bandwidthSource.globalUploadPerMinute,
      "native stellar quantum upload bandwidth",
    ),
    globalDownloadPerMinute: finiteNumber(
      bandwidthSource.globalDownloadPerMinute,
      "native stellar quantum download bandwidth",
    ),
    activeTowerCount: safeInteger(
      bandwidthSource.activeTowerCount,
      "native stellar quantum active tower count",
    ),
    activeTowerStacks: safeInteger(
      bandwidthSource.activeTowerStacks,
      "native stellar quantum active tower stacks",
    ),
  };
  if (bandwidth.globalUploadPerMinute !== bandwidth.globalDownloadPerMinute ||
      bandwidth.activeTowerCount > bandwidth.activeTowerStacks) {
    throw protocolError("native stellar quantum bandwidth binding");
  }

  const runtime = source.runtime === null ? null : (() => {
    const runtimeSource = exactObject(source.runtime, [
      "boundarySecond", "globalUploadPerMinute", "globalDownloadPerMinute",
      "quantumTowerStacks", "quantumCollectorStacks",
    ], "native stellar quantum runtime");
    return {
      boundarySecond: safeInteger(runtimeSource.boundarySecond, "native stellar quantum runtime boundary"),
      globalUploadPerMinute: finiteNumber(
        runtimeSource.globalUploadPerMinute,
        "native stellar quantum runtime upload bandwidth",
      ),
      globalDownloadPerMinute: finiteNumber(
        runtimeSource.globalDownloadPerMinute,
        "native stellar quantum runtime download bandwidth",
      ),
      quantumTowerStacks: safeInteger(
        runtimeSource.quantumTowerStacks,
        "native stellar quantum runtime tower stacks",
      ),
      quantumCollectorStacks: safeInteger(
        runtimeSource.quantumCollectorStacks,
        "native stellar quantum runtime collector stacks",
      ),
    };
  })();

  const summarySource = exactObject(source.collectorSummary, [
    "totalCount", "connectedCount", "pendingCount", "availableCount", "connectedStacks",
  ], "native stellar quantum collector summary");
  const collectorSummary = {
    totalCount: safeInteger(summarySource.totalCount, "native stellar quantum collector total"),
    connectedCount: safeInteger(summarySource.connectedCount, "native stellar quantum connected collectors"),
    pendingCount: safeInteger(summarySource.pendingCount, "native stellar quantum pending collectors"),
    availableCount: safeInteger(summarySource.availableCount, "native stellar quantum available collectors"),
    connectedStacks: safeInteger(summarySource.connectedStacks, "native stellar quantum connected stacks"),
  };
  if (collectorSummary.totalCount !== collectors.totalCount ||
      collectorSummary.connectedCount + collectorSummary.pendingCount + collectorSummary.availableCount >
        collectorSummary.totalCount || collectorSummary.connectedCount > collectorSummary.connectedStacks) {
    throw protocolError("native stellar quantum collector summary binding");
  }
  const truncated = boolean(source.truncated, "native stellar quantum truncated");
  if (truncated !== (items.nextCursor !== null || collectors.nextCursor !== null)) {
    throw protocolError("native stellar quantum truncation binding");
  }
  return {
    schemaVersion: 1,
    projectionType: "stellar-quantum-v1",
    revision,
    registryFingerprint,
    stateVersion: 47,
    limits,
    request: {
      expectedRevision: echoed.expectedRevision,
      expectedRegistryFingerprint: echoed.expectedRegistryFingerprint,
      itemCursor: echoed.itemCursor,
      itemLimit: echoed.itemLimit,
      collectorCursor: echoed.collectorCursor,
      collectorLimit: echoed.collectorLimit,
    },
    enabled: boolean(source.enabled, "native stellar quantum enabled"),
    bandwidth,
    runtime,
    collectorSummary,
    truncated,
    items,
    collectors,
  };
}

function normalizeDysonEngineering(value, label) {
  const source = exactObject(value, [
    "launchMode", "launchThrottle", "launchEnabled", "orbitCount", "orbitSails",
    "queuedSails", "queuedRockets", "sailLaunchesPerMinute", "rocketLaunchesPerMinute",
    "launchEnergyPerSailMj", "launchEnergyPerRocketMj", "launchEnergyPerMinuteMj",
    "rayGenerationKw", "receiverCapacityKw", "operationalReceiverCapacityKw",
    "receiverLoadKw", "theoreticalReceptionRate", "receiverUtilization",
    "dysonPowerUtilization", "configuredReceiverCount", "blockedReceiverCount",
    "criticalPhotonPerMinute", "antimatterPerMinute", "feedbackGenerationKw",
    "plannedStructurePoints", "completedStructurePoints", "remainingStructurePoints",
    "shellCapacity", "shellSails", "projectedGenerationKw",
  ], label);
  const result = {
    launchMode: oneOf(source.launchMode, ["balanced", "swarm", "sphere"], `${label}.launchMode`),
    launchThrottle: oneOf(source.launchThrottle, [0.25, 0.5, 0.75, 1], `${label}.launchThrottle`),
    launchEnabled: boolean(source.launchEnabled, `${label}.launchEnabled`),
    orbitCount: dysonInteger(source.orbitCount, `${label}.orbitCount`),
    orbitSails: dysonInteger(source.orbitSails, `${label}.orbitSails`),
    queuedSails: dysonInteger(source.queuedSails, `${label}.queuedSails`),
    queuedRockets: dysonInteger(source.queuedRockets, `${label}.queuedRockets`),
    sailLaunchesPerMinute: finiteNumber(source.sailLaunchesPerMinute, `${label}.sailLaunchesPerMinute`),
    rocketLaunchesPerMinute: finiteNumber(source.rocketLaunchesPerMinute, `${label}.rocketLaunchesPerMinute`),
    launchEnergyPerSailMj: finiteNumber(source.launchEnergyPerSailMj, `${label}.launchEnergyPerSailMj`),
    launchEnergyPerRocketMj: finiteNumber(source.launchEnergyPerRocketMj, `${label}.launchEnergyPerRocketMj`),
    launchEnergyPerMinuteMj: finiteNumber(source.launchEnergyPerMinuteMj, `${label}.launchEnergyPerMinuteMj`),
    rayGenerationKw: finiteNumber(source.rayGenerationKw, `${label}.rayGenerationKw`),
    receiverCapacityKw: finiteNumber(source.receiverCapacityKw, `${label}.receiverCapacityKw`),
    operationalReceiverCapacityKw: finiteNumber(source.operationalReceiverCapacityKw, `${label}.operationalReceiverCapacityKw`),
    receiverLoadKw: finiteNumber(source.receiverLoadKw, `${label}.receiverLoadKw`),
    theoreticalReceptionRate: dysonUnitNumber(source.theoreticalReceptionRate, `${label}.theoreticalReceptionRate`),
    receiverUtilization: dysonUnitNumber(source.receiverUtilization, `${label}.receiverUtilization`),
    dysonPowerUtilization: dysonUnitNumber(source.dysonPowerUtilization, `${label}.dysonPowerUtilization`),
    configuredReceiverCount: dysonInteger(source.configuredReceiverCount, `${label}.configuredReceiverCount`),
    blockedReceiverCount: dysonInteger(source.blockedReceiverCount, `${label}.blockedReceiverCount`),
    criticalPhotonPerMinute: finiteNumber(source.criticalPhotonPerMinute, `${label}.criticalPhotonPerMinute`),
    antimatterPerMinute: finiteNumber(source.antimatterPerMinute, `${label}.antimatterPerMinute`),
    feedbackGenerationKw: finiteNumber(source.feedbackGenerationKw, `${label}.feedbackGenerationKw`),
    plannedStructurePoints: dysonInteger(source.plannedStructurePoints, `${label}.plannedStructurePoints`),
    completedStructurePoints: dysonInteger(source.completedStructurePoints, `${label}.completedStructurePoints`),
    remainingStructurePoints: dysonInteger(source.remainingStructurePoints, `${label}.remainingStructurePoints`),
    shellCapacity: dysonInteger(source.shellCapacity, `${label}.shellCapacity`),
    shellSails: dysonInteger(source.shellSails, `${label}.shellSails`),
    projectedGenerationKw: dysonInteger(source.projectedGenerationKw, `${label}.projectedGenerationKw`),
  };
  if (result.launchEnergyPerSailMj !== 21.6 || result.launchEnergyPerRocketMj !== 108 ||
      result.operationalReceiverCapacityKw > result.receiverCapacityKw ||
      result.blockedReceiverCount > result.configuredReceiverCount ||
      result.completedStructurePoints > result.plannedStructurePoints ||
      result.remainingStructurePoints !== result.plannedStructurePoints - result.completedStructurePoints) {
    throw protocolError(`${label} binding`);
  }
  return result;
}

function normalizeDysonSystemRow(value, label, seenIds = null) {
  const source = exactObject(value, [
    "systemId", "displayName", "displayNameTruncated", "starProfile", "unlocked",
    "active", "activeLayerId", "activeOrbitId", "structurePoints", "shellSails",
    "totals", "orbitCount", "orbitSails", "projectedGenerationKw", "engineering",
  ], label);
  const systemId = dysonId(source.systemId, `${label}.systemId`);
  if (seenIds?.has(systemId)) throw protocolError(`${label}.systemId`);
  seenIds?.add(systemId);
  const profileSource = exactObject(source.starProfile, [
    "available", "starTypeName", "starTypeNameTruncated", "luminosity", "radiusMultiplier",
  ], `${label}.starProfile`);
  const starProfile = {
    available: boolean(profileSource.available, `${label}.starProfile.available`),
    starTypeName: dysonLabel(profileSource.starTypeName, `${label}.starProfile.starTypeName`),
    starTypeNameTruncated: boolean(profileSource.starTypeNameTruncated, `${label}.starProfile.starTypeNameTruncated`),
    luminosity: finiteNumber(profileSource.luminosity, `${label}.starProfile.luminosity`, Number.MIN_VALUE),
    radiusMultiplier: finiteNumber(profileSource.radiusMultiplier, `${label}.starProfile.radiusMultiplier`, Number.MIN_VALUE),
  };
  const totalsSource = exactObject(source.totals, [
    "layerCount", "nodeCount", "frameCount", "shellCount", "plannedStructurePoints",
    "completedStructurePoints", "sailCapacity", "absorbedSails",
  ], `${label}.totals`);
  const totals = {
    layerCount: dysonInteger(totalsSource.layerCount, `${label}.totals.layerCount`),
    nodeCount: dysonInteger(totalsSource.nodeCount, `${label}.totals.nodeCount`),
    frameCount: dysonInteger(totalsSource.frameCount, `${label}.totals.frameCount`),
    shellCount: dysonInteger(totalsSource.shellCount, `${label}.totals.shellCount`),
    plannedStructurePoints: dysonInteger(totalsSource.plannedStructurePoints, `${label}.totals.plannedStructurePoints`),
    completedStructurePoints: dysonInteger(totalsSource.completedStructurePoints, `${label}.totals.completedStructurePoints`),
    sailCapacity: dysonInteger(totalsSource.sailCapacity, `${label}.totals.sailCapacity`),
    absorbedSails: dysonInteger(totalsSource.absorbedSails, `${label}.totals.absorbedSails`),
  };
  const engineering = normalizeDysonEngineering(source.engineering, `${label}.engineering`);
  const result = {
    systemId,
    displayName: dysonLabel(source.displayName, `${label}.displayName`),
    displayNameTruncated: boolean(source.displayNameTruncated, `${label}.displayNameTruncated`),
    starProfile,
    unlocked: boolean(source.unlocked, `${label}.unlocked`),
    active: boolean(source.active, `${label}.active`),
    activeLayerId: dysonOptionalId(source.activeLayerId, `${label}.activeLayerId`),
    activeOrbitId: dysonOptionalId(source.activeOrbitId, `${label}.activeOrbitId`),
    structurePoints: dysonInteger(source.structurePoints, `${label}.structurePoints`),
    shellSails: dysonInteger(source.shellSails, `${label}.shellSails`),
    totals,
    orbitCount: dysonInteger(source.orbitCount, `${label}.orbitCount`),
    orbitSails: dysonInteger(source.orbitSails, `${label}.orbitSails`),
    projectedGenerationKw: dysonInteger(source.projectedGenerationKw, `${label}.projectedGenerationKw`),
    engineering,
  };
  if ([totals.layerCount, totals.nodeCount, totals.frameCount, totals.shellCount, result.orbitCount]
      .some((count) => count > 65_536) || totals.completedStructurePoints > totals.plannedStructurePoints ||
      totals.absorbedSails !== result.shellSails ||
      engineering.orbitCount !== result.orbitCount || engineering.orbitSails !== result.orbitSails ||
      engineering.plannedStructurePoints !== totals.plannedStructurePoints ||
      engineering.completedStructurePoints !== totals.completedStructurePoints ||
      engineering.shellCapacity !== totals.sailCapacity || engineering.shellSails !== result.shellSails ||
      engineering.projectedGenerationKw !== result.projectedGenerationKw) {
    throw protocolError(`${label} binding`);
  }
  return result;
}

function normalizeCoreDysonWorkspaceProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "registryFingerprint", "stateVersion",
    "limits", "request", "activePlanetId", "activeSystemId", "selectedSystemId",
    "technology", "global", "summary", "selectedSystem", "systems", "layers",
    "orbits", "nodes", "frames", "shells",
  ], "native Dyson workspace projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "dyson-workspace-v1") {
    throw protocolError("native Dyson workspace projection identity");
  }
  requireProjectionByteBudget(source, "native Dyson workspace projection");
  const projectionContext = normalizeDysonWorkspaceProjectionContext(
    context,
    "native Dyson workspace projection context",
  );
  const revision = safeInteger(source.revision, "native Dyson workspace revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native Dyson workspace registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint || source.stateVersion !== 47) {
    throw protocolError("native Dyson workspace identity binding");
  }
  const limitsSource = exactObject(source.limits, [
    "requestBytes", "projectionBytes", "pageRows", "totalRows", "idBytes", "labelBytes",
  ], "native Dyson workspace limits");
  const limits = Object.fromEntries(Object.entries(limitsSource).map(([key, entry]) => [
    key,
    safeInteger(entry, `native Dyson workspace limits.${key}`, 1),
  ]));
  if (limits.requestBytes !== 32_768 || limits.projectionBytes !== 1_048_576 ||
      limits.pageRows !== 64 || limits.totalRows !== 65_536 || limits.idBytes !== 1_024 ||
      limits.labelBytes !== 512) {
    throw protocolError("native Dyson workspace limit binding");
  }
  const requestSource = exactObject(source.request, [
    "expectedRevision", "expectedRegistryFingerprint", "selectedSystemId", "systemCursor",
    "systemLimit", "layerCursor", "layerLimit", "orbitCursor", "orbitLimit", "nodeCursor",
    "nodeLimit", "frameCursor", "frameLimit", "shellCursor", "shellLimit",
  ], "native Dyson workspace echoed request");
  const echoed = normalizeDysonWorkspaceProjectionContext({
    sessionId: projectionContext.sessionId,
    ...requestSource,
  }, "native Dyson workspace echoed request");
  for (const key of [
    "expectedRevision", "expectedRegistryFingerprint", "selectedSystemId", "systemCursor",
    "systemLimit", "layerCursor", "layerLimit", "orbitCursor", "orbitLimit", "nodeCursor",
    "nodeLimit", "frameCursor", "frameLimit", "shellCursor", "shellLimit",
  ]) {
    if (echoed[key] !== projectionContext[key]) throw protocolError("native Dyson workspace request binding");
  }
  const activePlanetId = dysonId(source.activePlanetId, "native Dyson workspace active planet");
  const activeSystemId = dysonId(source.activeSystemId, "native Dyson workspace active system");
  const selectedSystemId = dysonId(source.selectedSystemId, "native Dyson workspace selected system");
  if (selectedSystemId !== echoed.selectedSystemId) {
    throw protocolError("native Dyson workspace selected system binding");
  }
  const technologySource = exactObject(source.technology, [
    "programReady", "shellReady", "swarmReady",
  ], "native Dyson workspace technology");
  const technology = {
    programReady: boolean(technologySource.programReady, "native Dyson workspace program readiness"),
    shellReady: boolean(technologySource.shellReady, "native Dyson workspace shell readiness"),
    swarmReady: boolean(technologySource.swarmReady, "native Dyson workspace swarm readiness"),
  };
  const globalSource = exactObject(source.global, ["sphere", "swarm", "launch"], "native Dyson workspace global");
  const sphereSource = exactObject(globalSource.sphere, [
    "structurePoints", "totalRocketsLaunched", "shellSails", "totalSailsAbsorbed", "generationKw",
  ], "native Dyson workspace global sphere");
  const swarmSource = exactObject(globalSource.swarm, [
    "sailsInOrbit", "totalLaunched", "totalExpired", "generationKw", "receiverLoadKw",
  ], "native Dyson workspace global swarm");
  const launchSource = exactObject(globalSource.launch, [
    "mode", "throttle", "enabled", "energySpentMj",
  ], "native Dyson workspace global launch");
  const global = {
    sphere: {
      structurePoints: dysonInteger(sphereSource.structurePoints, "native Dyson workspace global structure"),
      totalRocketsLaunched: dysonInteger(sphereSource.totalRocketsLaunched, "native Dyson workspace global rockets"),
      shellSails: dysonInteger(sphereSource.shellSails, "native Dyson workspace global shell sails"),
      totalSailsAbsorbed: dysonInteger(sphereSource.totalSailsAbsorbed, "native Dyson workspace global absorbed sails"),
      generationKw: dysonInteger(sphereSource.generationKw, "native Dyson workspace sphere generation"),
    },
    swarm: {
      sailsInOrbit: dysonInteger(swarmSource.sailsInOrbit, "native Dyson workspace global orbit sails"),
      totalLaunched: dysonInteger(swarmSource.totalLaunched, "native Dyson workspace global launched sails"),
      totalExpired: dysonInteger(swarmSource.totalExpired, "native Dyson workspace global expired sails"),
      generationKw: finiteNumber(swarmSource.generationKw, "native Dyson workspace swarm generation"),
      receiverLoadKw: finiteNumber(swarmSource.receiverLoadKw, "native Dyson workspace receiver load"),
    },
    launch: {
      mode: oneOf(launchSource.mode, ["balanced", "swarm", "sphere"], "native Dyson workspace launch mode"),
      throttle: oneOf(launchSource.throttle, [0.25, 0.5, 0.75, 1], "native Dyson workspace launch throttle"),
      enabled: boolean(launchSource.enabled, "native Dyson workspace launch enabled"),
      energySpentMj: finiteNumber(launchSource.energySpentMj, "native Dyson workspace launch energy"),
    },
  };
  if (global.sphere.structurePoints > global.sphere.totalRocketsLaunched ||
      global.sphere.shellSails > global.sphere.totalSailsAbsorbed ||
      global.swarm.totalLaunched < global.swarm.sailsInOrbit + global.swarm.totalExpired +
        global.sphere.totalSailsAbsorbed) {
    throw protocolError("native Dyson workspace global conservation");
  }
  const summarySource = exactObject(source.summary, [
    "systemCount", "unlockedSystemCount", "layerCount", "orbitCount", "nodeCount",
    "frameCount", "shellCount",
  ], "native Dyson workspace summary");
  const summary = Object.fromEntries(Object.entries(summarySource).map(([key, entry]) => [
    key,
    dysonInteger(entry, `native Dyson workspace summary.${key}`),
  ]));
  if (Object.values(summary).some((count) => count > 65_536) ||
      summary.unlockedSystemCount > summary.systemCount) {
    throw protocolError("native Dyson workspace summary binding");
  }
  const selectedSystem = normalizeDysonSystemRow(
    source.selectedSystem,
    "native Dyson workspace selected system",
  );
  if (selectedSystem.systemId !== selectedSystemId || selectedSystem.active !== (selectedSystemId === activeSystemId) ||
      selectedSystem.structurePoints > global.sphere.structurePoints ||
      selectedSystem.shellSails > global.sphere.shellSails) {
    throw protocolError("native Dyson workspace selected summary binding");
  }
  const systemIds = new Set();
  const systems = normalizeStellarPage(
    source.systems,
    echoed.systemCursor,
    echoed.systemLimit,
    "native Dyson workspace systems",
    (row, label) => normalizeDysonSystemRow(row, label, systemIds),
  );
  if (systems.totalCount !== summary.systemCount ||
      systems.rows.some((row) => row.active !== (row.systemId === activeSystemId))) {
    throw protocolError("native Dyson workspace systems binding");
  }
  const pagedSelected = systems.rows.find((row) => row.systemId === selectedSystemId);
  if (pagedSelected && JSON.stringify(pagedSelected) !== JSON.stringify(selectedSystem)) {
    throw protocolError("native Dyson workspace selected page binding");
  }

  const layerIds = new Set();
  const layers = normalizeStellarPage(
    source.layers,
    echoed.layerCursor,
    echoed.layerLimit,
    "native Dyson workspace layers",
    (row, label) => {
      const entry = exactObject(row, [
        "layerId", "name", "nameTruncated", "radius", "inclination", "longitude",
        "structureAllocationFloor", "shellAllocationFloor", "nodeCount", "frameCount",
        "shellCount", "plannedStructurePoints", "completedStructurePoints", "sailCapacity",
        "absorbedSails",
      ], label);
      const layerId = dysonId(entry.layerId, `${label}.layerId`);
      if (layerIds.has(layerId)) throw protocolError(`${label}.layerId`);
      layerIds.add(layerId);
      const radius = finiteNumber(entry.radius, `${label}.radius`, 5_000);
      const inclination = finiteNumber(entry.inclination, `${label}.inclination`, -90);
      const longitude = finiteNumber(entry.longitude, `${label}.longitude`);
      const result = {
        layerId,
        name: dysonLabel(entry.name, `${label}.name`),
        nameTruncated: boolean(entry.nameTruncated, `${label}.nameTruncated`),
        radius,
        inclination,
        longitude,
        structureAllocationFloor: dysonInteger(entry.structureAllocationFloor, `${label}.structureAllocationFloor`),
        shellAllocationFloor: dysonInteger(entry.shellAllocationFloor, `${label}.shellAllocationFloor`),
        nodeCount: dysonInteger(entry.nodeCount, `${label}.nodeCount`),
        frameCount: dysonInteger(entry.frameCount, `${label}.frameCount`),
        shellCount: dysonInteger(entry.shellCount, `${label}.shellCount`),
        plannedStructurePoints: dysonInteger(entry.plannedStructurePoints, `${label}.plannedStructurePoints`),
        completedStructurePoints: dysonInteger(entry.completedStructurePoints, `${label}.completedStructurePoints`),
        sailCapacity: dysonInteger(entry.sailCapacity, `${label}.sailCapacity`),
        absorbedSails: dysonInteger(entry.absorbedSails, `${label}.absorbedSails`),
      };
      if (radius > 50_000 || inclination > 90 || longitude >= 360 ||
          result.completedStructurePoints > result.plannedStructurePoints ||
          result.absorbedSails > result.sailCapacity) throw protocolError(`${label} binding`);
      return result;
    },
  );
  const orbitIds = new Set();
  const orbits = normalizeStellarPage(
    source.orbits,
    echoed.orbitCursor,
    echoed.orbitLimit,
    "native Dyson workspace orbits",
    (row, label) => {
      const entry = exactObject(row, [
        "orbitId", "name", "nameTruncated", "radius", "inclination", "longitude",
        "sailsInOrbit", "totalLaunched", "totalExpired", "decayProgress", "generationKw",
      ], label);
      const orbitId = dysonId(entry.orbitId, `${label}.orbitId`);
      if (orbitIds.has(orbitId)) throw protocolError(`${label}.orbitId`);
      orbitIds.add(orbitId);
      const radius = finiteNumber(entry.radius, `${label}.radius`, 5_000);
      const inclination = finiteNumber(entry.inclination, `${label}.inclination`, -90);
      const longitude = finiteNumber(entry.longitude, `${label}.longitude`);
      const sailsInOrbit = dysonInteger(entry.sailsInOrbit, `${label}.sailsInOrbit`);
      const totalLaunched = dysonInteger(entry.totalLaunched, `${label}.totalLaunched`);
      const totalExpired = dysonInteger(entry.totalExpired, `${label}.totalExpired`);
      const result = {
        orbitId,
        name: dysonLabel(entry.name, `${label}.name`),
        nameTruncated: boolean(entry.nameTruncated, `${label}.nameTruncated`),
        radius,
        inclination,
        longitude,
        sailsInOrbit,
        totalLaunched,
        totalExpired,
        decayProgress: dysonUnitNumber(entry.decayProgress, `${label}.decayProgress`),
        generationKw: finiteNumber(entry.generationKw, `${label}.generationKw`),
      };
      if (radius > 50_000 || inclination > 90 || longitude >= 360 ||
          totalLaunched < sailsInOrbit + totalExpired) throw protocolError(`${label} binding`);
      return result;
    },
  );
  const nodeIds = new Set();
  const nodes = normalizeStellarPage(
    source.nodes,
    echoed.nodeCursor,
    echoed.nodeLimit,
    "native Dyson workspace nodes",
    (row, label) => {
      const entry = exactObject(row, [
        "layerId", "nodeId", "angle", "requiredStructurePoints", "completedStructurePoints",
      ], label);
      const layerId = dysonId(entry.layerId, `${label}.layerId`);
      const nodeId = dysonId(entry.nodeId, `${label}.nodeId`);
      const key = `${layerId}\0${nodeId}`;
      if (nodeIds.has(key)) throw protocolError(`${label}.nodeId`);
      nodeIds.add(key);
      const angle = finiteNumber(entry.angle, `${label}.angle`);
      const requiredStructurePoints = dysonInteger(entry.requiredStructurePoints, `${label}.requiredStructurePoints`);
      const completedStructurePoints = dysonInteger(entry.completedStructurePoints, `${label}.completedStructurePoints`);
      if (angle >= 360 || requiredStructurePoints < 1 || completedStructurePoints > requiredStructurePoints) {
        throw protocolError(`${label} binding`);
      }
      return { layerId, nodeId, angle, requiredStructurePoints, completedStructurePoints };
    },
  );
  const frameIds = new Set();
  const frames = normalizeStellarPage(
    source.frames,
    echoed.frameCursor,
    echoed.frameLimit,
    "native Dyson workspace frames",
    (row, label) => {
      const entry = exactObject(row, [
        "layerId", "frameId", "sourceNodeId", "targetNodeId", "requiredStructurePoints",
        "completedStructurePoints",
      ], label);
      const layerId = dysonId(entry.layerId, `${label}.layerId`);
      const frameId = dysonId(entry.frameId, `${label}.frameId`);
      const key = `${layerId}\0${frameId}`;
      if (frameIds.has(key)) throw protocolError(`${label}.frameId`);
      frameIds.add(key);
      const sourceNodeId = dysonId(entry.sourceNodeId, `${label}.sourceNodeId`);
      const targetNodeId = dysonId(entry.targetNodeId, `${label}.targetNodeId`);
      const requiredStructurePoints = dysonInteger(entry.requiredStructurePoints, `${label}.requiredStructurePoints`);
      const completedStructurePoints = dysonInteger(entry.completedStructurePoints, `${label}.completedStructurePoints`);
      if (sourceNodeId === targetNodeId || requiredStructurePoints < 1 ||
          completedStructurePoints > requiredStructurePoints) throw protocolError(`${label} binding`);
      return { layerId, frameId, sourceNodeId, targetNodeId, requiredStructurePoints, completedStructurePoints };
    },
  );
  const shellIds = new Set();
  const shells = normalizeStellarPage(
    source.shells,
    echoed.shellCursor,
    echoed.shellLimit,
    "native Dyson workspace shells",
    (row, label) => {
      const entry = exactObject(row, [
        "layerId", "shellId", "sourceNodeId", "targetNodeId", "boundaryFrameCount", "active",
        "sailCapacity", "absorbedSails",
      ], label);
      const layerId = dysonId(entry.layerId, `${label}.layerId`);
      const shellId = dysonId(entry.shellId, `${label}.shellId`);
      const key = `${layerId}\0${shellId}`;
      if (shellIds.has(key)) throw protocolError(`${label}.shellId`);
      shellIds.add(key);
      const sourceNodeId = dysonId(entry.sourceNodeId, `${label}.sourceNodeId`);
      const targetNodeId = dysonId(entry.targetNodeId, `${label}.targetNodeId`);
      const boundaryFrameCount = dysonInteger(entry.boundaryFrameCount, `${label}.boundaryFrameCount`);
      const sailCapacity = dysonInteger(entry.sailCapacity, `${label}.sailCapacity`);
      const absorbedSails = dysonInteger(entry.absorbedSails, `${label}.absorbedSails`);
      if (sourceNodeId === targetNodeId || boundaryFrameCount < 1 || sailCapacity < 1 ||
          absorbedSails > sailCapacity) throw protocolError(`${label} binding`);
      return {
        layerId,
        shellId,
        sourceNodeId,
        targetNodeId,
        boundaryFrameCount,
        active: boolean(entry.active, `${label}.active`),
        sailCapacity,
        absorbedSails,
      };
    },
  );
  if (layers.totalCount !== selectedSystem.totals.layerCount ||
      orbits.totalCount !== selectedSystem.orbitCount ||
      nodes.totalCount !== selectedSystem.totals.nodeCount ||
      frames.totalCount !== selectedSystem.totals.frameCount ||
      shells.totalCount !== selectedSystem.totals.shellCount ||
      summary.layerCount < layers.totalCount || summary.orbitCount < orbits.totalCount ||
      summary.nodeCount < nodes.totalCount || summary.frameCount < frames.totalCount ||
      summary.shellCount < shells.totalCount) {
    throw protocolError("native Dyson workspace page summary binding");
  }
  return {
    schemaVersion: 1,
    projectionType: "dyson-workspace-v1",
    revision,
    registryFingerprint,
    stateVersion: 47,
    limits,
    request: Object.fromEntries(Object.entries(echoed).filter(([key]) => key !== "sessionId")),
    activePlanetId,
    activeSystemId,
    selectedSystemId,
    technology,
    global,
    summary,
    selectedSystem,
    systems,
    layers,
    orbits,
    nodes,
    frames,
    shells,
  };
}

function normalizeCoreCommandPaletteEntitySearchProjection(value, context) {
  const source = exactObject(value, [
    "schemaVersion", "projectionType", "revision", "registryFingerprint", "limits",
    "request", "totalCount", "rows", "nextCursor",
  ], "native command palette entity-search projection");
  if (source.schemaVersion !== 1 || source.projectionType !== "command-palette-entity-search-v1") {
    throw protocolError("native command palette entity-search identity");
  }
  requireProjectionByteBudget(source, "native command palette entity-search projection");
  const projectionContext = normalizeCommandPaletteEntitySearchContext(
    context,
    "native command palette entity-search context",
  );
  const revision = safeInteger(source.revision, "native command palette entity-search revision");
  const registryFingerprint = logicalId(
    source.registryFingerprint,
    "native command palette entity-search registry fingerprint",
    256,
  );
  if (revision !== projectionContext.expectedRevision ||
      registryFingerprint !== projectionContext.expectedRegistryFingerprint) {
    throw protocolError("native command palette entity-search identity binding");
  }
  const limitsSource = exactObject(source.limits, [
    "queryBytes", "selectorIds", "rows", "requestBytes", "projectionBytes",
  ], "native command palette entity-search limits");
  const limits = Object.fromEntries(Object.entries(limitsSource).map(([key, entry]) => [
    key,
    safeInteger(entry, `native command palette entity-search limits.${key}`, 1),
  ]));
  if (limits.queryBytes !== 256 || limits.selectorIds !== 256 || limits.rows !== 16 ||
      limits.requestBytes !== 32_768 || limits.projectionBytes !== 1_048_576) {
    throw protocolError("native command palette entity-search limit binding");
  }
  const requestSource = exactObject(source.request, [
    "query", "cursor", "limit", "buildingIds", "resourceIds", "planetIds",
  ], "native command palette entity-search echoed request");
  const echoed = normalizeCommandPaletteEntitySearchContext({
    sessionId: projectionContext.sessionId,
    expectedRevision: projectionContext.expectedRevision,
    expectedRegistryFingerprint: projectionContext.expectedRegistryFingerprint,
    ...requestSource,
  }, "native command palette entity-search echoed request");
  for (const key of ["query", "cursor", "limit"]) {
    if (echoed[key] !== projectionContext[key]) {
      throw protocolError("native command palette entity-search request binding");
    }
  }
  for (const key of ["buildingIds", "resourceIds", "planetIds"]) {
    if (echoed[key].length !== projectionContext[key].length ||
        echoed[key].some((id, index) => id !== projectionContext[key][index])) {
      throw protocolError("native command palette entity-search selector binding");
    }
  }
  const totalCount = safeInteger(source.totalCount, "native command palette entity-search total count");
  if (echoed.cursor > totalCount || !Array.isArray(source.rows) || source.rows.length > echoed.limit) {
    throw protocolError("native command palette entity-search cardinality");
  }
  const entityIds = new Set();
  const rows = source.rows.map((row, index) => {
    const label = `native command palette entity-search rows[${index}]`;
    const entry = exactObject(row, [
      "entityId", "buildingId", "resourceId", "planetId", "recipeId", "positionX", "positionY",
    ], label);
    const entityId = opaqueId(entry.entityId, `${label}.entityId`);
    if (entityIds.has(entityId)) throw protocolError(`${label}.entityId`);
    entityIds.add(entityId);
    const optionalCatalogId = (id, idLabel) => id === null ? null : logicalId(id, idLabel, 160);
    const positionX = finiteNumber(entry.positionX, `${label}.positionX`, -10_000_000);
    const positionY = finiteNumber(entry.positionY, `${label}.positionY`, -10_000_000);
    if (positionX > 10_000_000 || positionY > 10_000_000) throw protocolError(`${label}.position`);
    return {
      entityId,
      buildingId: optionalCatalogId(entry.buildingId, `${label}.buildingId`),
      resourceId: optionalCatalogId(entry.resourceId, `${label}.resourceId`),
      planetId: logicalId(entry.planetId, `${label}.planetId`, 160),
      recipeId: optionalCatalogId(entry.recipeId, `${label}.recipeId`),
      positionX,
      positionY,
    };
  });
  const expectedRows = Math.min(echoed.limit, totalCount - echoed.cursor);
  if (rows.length !== expectedRows) throw protocolError("native command palette entity-search page size");
  const consumed = echoed.cursor + rows.length;
  const nextCursor = source.nextCursor === null
    ? null
    : safeInteger(source.nextCursor, "native command palette entity-search next cursor", 1);
  if (nextCursor !== (consumed < totalCount ? consumed : null)) {
    throw protocolError("native command palette entity-search cursor chain");
  }
  return {
    schemaVersion: 1,
    projectionType: "command-palette-entity-search-v1",
    revision,
    registryFingerprint,
    limits,
    request: {
      query: echoed.query,
      cursor: echoed.cursor,
      limit: echoed.limit,
      buildingIds: echoed.buildingIds,
      resourceIds: echoed.resourceIds,
      planetIds: echoed.planetIds,
    },
    totalCount,
    rows,
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

function normalizeCoreCommandReconcile(value) {
  if (value && typeof value === "object" && !Array.isArray(value) &&
      value.status === "committed") {
    const source = exactObject(
      value,
      ["status", "receipt"],
      "native core command reconciliation result",
    );
    const receipt = normalizeCoreCommand(source.receipt);
    if (receipt.previousRevision === Number.MAX_SAFE_INTEGER ||
        receipt.revision !== receipt.previousRevision + 1) {
      throw protocolError("native command reconciliation receipt revision chain");
    }
    return { status: "committed", receipt };
  }
  const source = exactObject(
    value,
    ["status", "baseRevision", "currentRevision"],
    "native core command reconciliation result",
  );
  const status = oneOf(
    source.status,
    ["pending", "not-committed", "conflict"],
    "native command reconciliation status",
  );
  const baseRevision = safeInteger(
    source.baseRevision,
    "native command reconciliation base revision",
  );
  const currentRevision = safeInteger(
    source.currentRevision,
    "native command reconciliation current revision",
  );
  if (status === "not-committed" && currentRevision !== baseRevision) {
    throw protocolError("native command reconciliation absent revision");
  }
  return { status, baseRevision, currentRevision };
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

function normalizePlayerAuthorityArtifactIdentity(value, label) {
  const source = exactObject(value, ["sessionId", "runId", "revision"], label);
  return {
    sessionId: logicalId(source.sessionId, `${label} session`, 128),
    runId: logicalId(source.runId, `${label} run`, 128),
    revision: safeInteger(source.revision, `${label} revision`),
  };
}

function normalizePlayerAuthorityCheckpoint(value) {
  const source = exactObject(
    value,
    ["authority", "checkpoint", "summary", "reusedAcknowledgedCheckpoint"],
    "native player-authority checkpoint result",
  );
  const authority = normalizePlayerAuthorityArtifactIdentity(
    source.authority,
    "native player-authority checkpoint authority",
  );
  const checkpointSource = exactObject(
    source.checkpoint,
    ["generation", "rootHash", "revision"],
    "native player-authority checkpoint",
  );
  const checkpoint = {
    generation: safeInteger(
      checkpointSource.generation,
      "native player-authority checkpoint generation",
      1,
    ),
    rootHash: sha256(
      checkpointSource.rootHash,
      "native player-authority checkpoint root hash",
    ),
    revision: safeInteger(
      checkpointSource.revision,
      "native player-authority checkpoint revision",
    ),
  };
  const summary = normalizeCoreSummary(source.summary);
  if (source.reusedAcknowledgedCheckpoint !== true || checkpoint.revision !== summary.revision ||
      authority.revision !== checkpoint.revision ||
      summary.stateVersion !== 47 || summary.mode !== "normal" || summary.paused !== false ||
      summary.coverage.authorityEligible !== true) {
    throw protocolError("native player-authority checkpoint binding");
  }
  return { authority, checkpoint, summary, reusedAcknowledgedCheckpoint: true };
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

function normalizePlayerAuthorityExport(value) {
  const source = exactObject(
    value,
    ["authority", "exportId", "mode", "result"],
    "native player-authority v47 export result",
  );
  const authority = normalizePlayerAuthorityArtifactIdentity(
    source.authority,
    "native player-authority export authority",
  );
  const exported = normalizeCoreExport({
    exportId: source.exportId,
    mode: source.mode,
    result: source.result,
  });
  if (exported.mode !== "normal" || authority.revision !== exported.result.revision) {
    throw protocolError("native player-authority export binding");
  }
  return { authority, ...exported };
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

function normalizePlayerAuthorityV1State(value) {
  const keys = [
    "schemaVersion", "phase", "sessionId", "runId", "revision", "acknowledgedSequence",
    "nextSequence", "nextDeadlineMs", "inFlight", "currentOperation", "queuedCommands",
    "lastErrorCode",
  ];
  if (value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.hasOwn(value, "macroRecoveryHint")) keys.push("macroRecoveryHint");
  const source = exactObject(value, keys, "native player-authority state");
  if (source.schemaVersion !== 1) throw protocolError("native player-authority state schema");
  const phase = oneOf(source.phase, [
    "idle", "activating", "recovering", "active", "pausing", "paused", "resuming",
    "pause-uncertain", "resume-uncertain", "uncertain", "faulted", "shutdown",
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
    null, "activation", "recovery", "tick", "command", "pause", "resume",
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
      ["active", "pausing", "paused", "resuming", "pause-uncertain", "resume-uncertain"]
        .includes(phase) && !completeIdentity ||
      phase === "active" && lastErrorCode !== null ||
      ["idle", "activating", "recovering"].includes(phase) && !emptyIdentity) {
    throw protocolError("native player-authority state identity");
  }
  const inFlight = boolean(source.inFlight, "native player-authority in-flight flag");
  if (phase === "paused" &&
      (inFlight || currentOperation !== null || lastErrorCode !== null || queuedCommands !== 0) ||
      phase === "pausing" && (currentOperation !== "pause" || lastErrorCode !== null) ||
      phase === "resuming" && (currentOperation !== "resume" || lastErrorCode !== null) ||
      phase === "pause-uncertain" &&
        (lastErrorCode === null || ![null, "pause"].includes(currentOperation)) ||
      phase === "resume-uncertain" &&
        (lastErrorCode === null || ![null, "resume"].includes(currentOperation))) {
    throw protocolError("native player-authority pause lifecycle state");
  }
  let macroRecoveryHint = null;
  if (Object.hasOwn(source, "macroRecoveryHint")) {
    const hint = exactObject(
      source.macroRecoveryHint,
      ["kind", "revision"],
      "native player-authority macro recovery hint",
    );
    if (hint.kind !== "finished-pending-disable" || phase !== "active") {
      throw protocolError("native player-authority macro recovery hint");
    }
    const hintRevision = safeInteger(
      hint.revision,
      "native player-authority macro recovery hint revision",
    );
    if (revision === null || hintRevision > revision) {
      throw protocolError("native player-authority macro recovery hint revision");
    }
    macroRecoveryHint = { kind: "finished-pending-disable", revision: hintRevision };
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
    inFlight,
    currentOperation,
    queuedCommands,
    lastErrorCode,
    ...(macroRecoveryHint ? { macroRecoveryHint } : {}),
  };
}

function normalizePlayerAuthorityMacroState(value) {
  const source = exactObject(value, [
    "schemaVersion", "statusKind", "phase", "revision", "acknowledgedSequence",
    "nextSequence", "nextDeadlineMs", "inFlight", "currentOperation",
    "simulationBudgetMilliseconds", "wallBudgetMilliseconds",
    "simulationProgressMilliseconds", "wallProgressMilliseconds", "pausedReason",
  ], "native player-authority macro state");
  if (source.schemaVersion !== 2 || source.statusKind !== "macro") {
    throw protocolError("native player-authority macro state schema");
  }
  const phase = oneOf(source.phase, [
    "macro-active", "macro-committing", "macro-finishing", "macro-uncertain",
    "faulted", "shutdown",
  ], "native player-authority macro phase");
  const revision = safeInteger(source.revision, "native player-authority macro revision");
  const acknowledgedSequence = safeInteger(
    source.acknowledgedSequence,
    "native player-authority macro acknowledged sequence",
  );
  const nextSequence = safeInteger(
    source.nextSequence,
    "native player-authority macro next sequence",
    1,
  );
  const nextDeadlineMs = safeInteger(
    source.nextDeadlineMs,
    "native player-authority macro next deadline",
  );
  if (acknowledgedSequence + 1 !== nextSequence) {
    throw protocolError("native player-authority macro sequence");
  }
  const currentOperation = oneOf(
    source.currentOperation,
    [null, "advance", "finish"],
    "native player-authority macro operation",
  );
  const inFlight = boolean(source.inFlight, "native player-authority macro in-flight flag");
  const maximumBudget = 30 * 24 * 60 * 60 * 1_000;
  const nullableBudget = (entry, label) => {
    if (entry === null) return null;
    const result = safeInteger(entry, label, 1);
    if (result > maximumBudget) throw protocolError(label);
    return result;
  };
  const simulationBudgetMilliseconds = nullableBudget(
    source.simulationBudgetMilliseconds,
    "native player-authority macro simulation budget",
  );
  const wallBudgetMilliseconds = nullableBudget(
    source.wallBudgetMilliseconds,
    "native player-authority macro wall budget",
  );
  if ((simulationBudgetMilliseconds === null) !== (wallBudgetMilliseconds === null)) {
    throw protocolError("native player-authority macro budget group");
  }
  const nullableProgress = (entry, maximum, label) => {
    if (entry === null) return null;
    const result = safeInteger(entry, label);
    if (maximum === null || result > maximum) throw protocolError(label);
    return result;
  };
  const simulationProgressMilliseconds = nullableProgress(
    source.simulationProgressMilliseconds,
    simulationBudgetMilliseconds,
    "native player-authority macro simulation progress",
  );
  const wallProgressMilliseconds = nullableProgress(
    source.wallProgressMilliseconds,
    wallBudgetMilliseconds,
    "native player-authority macro wall progress",
  );
  if ((simulationProgressMilliseconds === null) !== (wallProgressMilliseconds === null)) {
    throw protocolError("native player-authority macro progress group");
  }
  const pausedReason = oneOf(source.pausedReason, [
    "macro-window-active", "macro-advance-committing", "macro-finish-committing",
    "macro-advance-uncertain", "macro-finish-uncertain", "macro-runtime-faulted",
    "macro-runtime-shutdown",
  ], "native player-authority macro paused reason");
  const phaseShapeIsValid = phase === "macro-active"
    ? !inFlight && currentOperation === null && pausedReason === "macro-window-active"
    : phase === "macro-committing"
      ? currentOperation === "advance" && pausedReason === "macro-advance-committing"
      : phase === "macro-finishing"
        ? currentOperation === "finish" && pausedReason === "macro-finish-committing"
        : phase === "macro-uncertain"
          ? inFlight === (currentOperation !== null) &&
            (pausedReason === "macro-advance-uncertain"
              ? currentOperation === null || currentOperation === "advance"
              : pausedReason === "macro-finish-uncertain" &&
                (currentOperation === null || currentOperation === "finish"))
          : phase === "faulted"
            ? pausedReason === "macro-runtime-faulted"
            : pausedReason === "macro-runtime-shutdown";
  if (!phaseShapeIsValid) throw protocolError("native player-authority macro phase status");
  return {
    schemaVersion: 2,
    statusKind: "macro",
    phase,
    revision,
    acknowledgedSequence,
    nextSequence,
    nextDeadlineMs,
    inFlight,
    currentOperation,
    simulationBudgetMilliseconds,
    wallBudgetMilliseconds,
    simulationProgressMilliseconds,
    wallProgressMilliseconds,
    pausedReason,
  };
}

function normalizePlayerAuthorityState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("native player-authority state");
  }
  if (value.schemaVersion === 1) return normalizePlayerAuthorityV1State(value);
  if (value.schemaVersion === 2) return normalizePlayerAuthorityMacroState(value);
  throw protocolError("native player-authority state schema");
}

function normalizePlayerAuthorityMacroReceipt(value) {
  const source = jsonObject(value, "native player-authority macro receipt");
  const maximumBudget = 30 * 24 * 60 * 60 * 1_000;
  if (source.schemaVersion !== 1 || !["macro-active", "finished"].includes(source.state)) {
    throw protocolError("native player-authority macro receipt identity");
  }
  const revision = safeInteger(source.revision, "native player-authority macro receipt revision");
  if (source.state === "finished") {
    objectWithKeys(
      source,
      ["schemaVersion", "state", "revision"],
      ["recovered"],
      "native player-authority macro finish receipt",
    );
    return {
      schemaVersion: 1,
      state: "finished",
      revision,
      previousRevision: null,
      simulationMilliseconds: null,
      wallMilliseconds: null,
      recovered: Object.hasOwn(source, "recovered")
        ? boolean(source.recovered, "native player-authority macro recovered finish")
        : false,
    };
  }
  const hasBudget = Object.hasOwn(source, "previousRevision") ||
    Object.hasOwn(source, "simulationMilliseconds") || Object.hasOwn(source, "wallMilliseconds");
  if (hasBudget) {
    exactObject(source, [
      "schemaVersion", "state", "previousRevision", "revision", "simulationMilliseconds",
      "wallMilliseconds", "algorithmVersion", "recovered",
    ], "native player-authority macro advance receipt");
    const previousRevision = safeInteger(
      source.previousRevision,
      "native player-authority macro previous revision",
    );
    const simulationMilliseconds = safeInteger(
      source.simulationMilliseconds,
      "native player-authority macro simulation budget",
      1,
    );
    const wallMilliseconds = safeInteger(
      source.wallMilliseconds,
      "native player-authority macro wall budget",
      1,
    );
    if (revision <= previousRevision || simulationMilliseconds > maximumBudget ||
        wallMilliseconds > maximumBudget) {
      throw protocolError("native player-authority macro advance receipt binding");
    }
    logicalId(source.algorithmVersion, "native player-authority macro algorithm", 128);
    return {
      schemaVersion: 1,
      state: "macro-active",
      revision,
      previousRevision,
      simulationMilliseconds,
      wallMilliseconds,
      recovered: boolean(source.recovered, "native player-authority macro recovered advance"),
    };
  }
  exactObject(source, [
    "schemaVersion", "state", "revision", "algorithmVersion", "recovered",
  ], "native player-authority macro startup recovery receipt");
  logicalId(source.algorithmVersion, "native player-authority macro algorithm", 128);
  if (source.recovered !== true) {
    throw protocolError("native player-authority macro startup recovery binding");
  }
  return {
    schemaVersion: 1,
    state: "macro-active",
    revision,
    previousRevision: null,
    simulationMilliseconds: null,
    wallMilliseconds: null,
    recovered: true,
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
  coreFactoryInventoryProjection: normalizeCoreFactoryInventoryProjection,
  coreConstructionInventoryProjection: normalizeCoreConstructionInventoryProjection,
  coreBlueprintWorkspaceProjection: normalizeCoreBlueprintWorkspaceProjection,
  coreBlueprintEnqueueContext: normalizeCoreBlueprintEnqueueContext,
  coreConstructionPlacementContext: normalizeCoreConstructionPlacementContext,
  coreConstructionBeltPlacementContext: normalizeCoreConstructionBeltPlacementContext,
  coreConstructionBeltLaneContext: normalizeCoreConstructionBeltLaneContext,
  coreConstructionBeltRemovalContext: normalizeCoreConstructionBeltRemovalContext,
  coreConstructionRemovalContext: normalizeCoreConstructionRemovalContext,
  coreConstructionStackContext: normalizeCoreConstructionStackContext,
  coreStatisticsProjection: normalizeCoreStatisticsProjection,
  coreTechnologyProjection: normalizeCoreTechnologyProjection,
  coreRecipeWorkspaceProjection: normalizeCoreRecipeWorkspaceProjection,
  coreStarMapOverviewProjection: normalizeCoreStarMapOverviewProjection,
  coreStarMapCatalogProjection: normalizeCoreStarMapCatalogProjection,
  coreStellarIndustryProjection: normalizeCoreStellarIndustryProjection,
  coreStellarIndustryProjectionV2: normalizeCoreStellarIndustryV2Projection,
  coreStellarQuantumProjection: normalizeCoreStellarQuantumProjection,
  coreDysonWorkspaceProjection: normalizeCoreDysonWorkspaceProjection,
  coreCommandPaletteEntitySearchProjection: normalizeCoreCommandPaletteEntitySearchProjection,
  coreCommand: normalizeCoreCommand,
  coreCommandReconcile: normalizeCoreCommandReconcile,
  coreAdvance: normalizeCoreAdvance,
  coreCommit: normalizeCoreCommit,
  coreCheckpoint: normalizeCoreCheckpoint,
  playerAuthorityCheckpoint: normalizePlayerAuthorityCheckpoint,
  coreExport: normalizeCoreExport,
  playerAuthorityExport: normalizePlayerAuthorityExport,
  coreCompare: normalizeCoreCompare,
  coreClose: normalizeCoreClose,
  playerAuthorityState: normalizePlayerAuthorityState,
  playerAuthorityMacroReceipt: normalizePlayerAuthorityMacroReceipt,
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
