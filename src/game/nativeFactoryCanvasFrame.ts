import type {
  DesktopNativeCoreBeltProjection,
  DesktopNativeCoreEntityProjection,
  DesktopNativeCoreViewportProjectionV2Result,
} from "../desktop";
import type { BeltConnection, FactoryEntity, PlanetId } from "./types";
import type { FactorySelectionReadModel, FactoryViewportReadModel } from "./factoryReadModels";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";

const ENTITY_KINDS = new Set(["vein", "machine", "power", "storage", "splitter", "station"]);
const BELT_ROUTE_MODES = new Set(["bezier", "auto", "upper", "lower", "manual"]);
const ENTITY_KEYS = new Set([
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
  "blackHolePaused", "blackHoleActivationConfirmed", "blackHolePorts", "routingCursor", "machineCount",
  "minerCount", "inputs", "outputs", "progress", "utilization", "productionRate",
]);
const BELT_KEYS = new Set([
  "id", "planetId", "source", "target", "itemId", "lanes", "tier", "sorterTier", "progress",
  "priority", "stackSize", "monitorEnabled", "totalTransferred", "congestion", "lastFlow",
  "recentFlowSampleSeconds", "recentFlowTransferred", "recentFlowSampling", "routeMode",
  "routeOffsetY", "targetPortIndex", "elevatorOutputIndex",
]);
const REQUIRED_ENTITY_KEYS = [
  "id", "kind", "planetId", "position", "interactionLocked", "routingCursor", "machineCount",
  "minerCount", "inputs", "outputs", "progress", "utilization", "productionRate",
] as const;
const REQUIRED_BELT_KEYS = [
  "id", "planetId", "source", "target", "itemId", "lanes", "tier", "sorterTier", "progress",
  "priority", "lastFlow",
] as const;
const ENTITY_NUMBER_KEYS = new Set([
  "orbitalCargoProgress", "fuelRemainingMj", "powerOutputKw", "powerInputKw", "powerFactor",
  "storedEnergyMj", "powerPriority", "generationPriority", "resourceRemaining", "resourceCapacity",
  "resourceDepletionRemainder", "stationTier", "stationProgress", "stationTrips", "stationLastTransfer",
  "stationDrones", "stationVessels", "stationWarpers", "stationWarperTarget", "stationHubPriority",
  "stationMinimumLoad", "stationDispatchCursor", "stationCongestion", "proliferatorTier",
  "proliferatorPoints", "routingCursor", "machineCount", "minerCount", "progress", "utilization",
  "productionRate",
]);
const ENTITY_BOOLEAN_KEYS = new Set([
  "interactionLocked", "quantumTarget", "stationWarpEnabled", "stationWarperAutoRefill",
  "stationHubEnabled", "sprayCoaterInstalled", "galacticExporterPaused", "blackHolePaused",
  "blackHoleActivationConfirmed",
]);
const ENTITY_STRING_KEYS = new Set([
  "resourceId", "buildingId", "extractorBuildingId", "recipeId", "targetDysonOrbitId", "storedItemId",
  "orbitalCargoTotalUploaded", "distributionMode", "fuelItemId", "energyMode", "powerGridId", "stationMode",
  "stationOperationMode", "quantumMode", "stationPeerId", "proliferatorMode",
]);
const ENTITY_ARRAY_KEYS = new Set([
  "deliveryItemIds", "deliverySlots", "orbitalCargoPortItems", "elevatorOutputItems", "stationSlots",
  "blackHolePorts",
]);
const ENTITY_RECORD_KEYS = new Set([
  "inputs", "outputs", "proliferatorBonusProgress", "stationLastSupplyPeerBySlot",
]);

export interface NativeAuthoritativeFactoryCanvasFrame {
  readonly source: "native-authoritative";
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly planetId: PlanetId;
  readonly bounds: DesktopNativeCoreViewportProjectionV2Result["bounds"];
  readonly worldBounds: DesktopNativeCoreViewportProjectionV2Result["worldBounds"];
  readonly planetTotals: DesktopNativeCoreViewportProjectionV2Result["planetTotals"];
  readonly viewportTotals: DesktopNativeCoreViewportProjectionV2Result["viewportTotals"];
  /** Full native records for every viewport row and explicit pin. */
  readonly entities: readonly FactoryEntity[];
  /** Only endpoint-closed rows are renderable; cross-boundary rows remain represented by viewportTotals. */
  readonly belts: readonly BeltConnection[];
  /** Every projected row, including pinned and cross-boundary belts, for bounded inspectors/connection reads. */
  readonly projectedBelts: readonly BeltConnection[];
  readonly entityById: ReadonlyMap<string, FactoryEntity>;
  readonly beltById: ReadonlyMap<string, BeltConnection>;
  readonly omittedCrossBoundaryBeltCount: number;
  readonly viewportReadModel: FactoryViewportReadModel;
  /** Same-revision Rust selection projection; inspectors never reconstruct semantic config from viewport JSON. */
  readonly factorySelection: FactorySelectionReadModel;
}

export interface NativeAuthoritativeFactoryCanvasBinding {
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly expectedRevision: number;
  readonly planetId: PlanetId;
  readonly bounds: DesktopNativeCoreViewportProjectionV2Result["bounds"];
  readonly requestedPinnedEntityIds: readonly string[];
  readonly requestedPinnedBeltIds: readonly string[];
  readonly requestTruncated: boolean;
}

export interface FactoryCanvasRows {
  readonly source: "native-authoritative" | "web-game-state";
  readonly revision: number | null;
  readonly entities: readonly FactoryEntity[];
  readonly belts: readonly BeltConnection[];
  readonly entityById: ReadonlyMap<string, FactoryEntity>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function finiteNumber(value: unknown, minimum = Number.NEGATIVE_INFINITY): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

function exactBounds(
  left: DesktopNativeCoreViewportProjectionV2Result["bounds"],
  right: DesktopNativeCoreViewportProjectionV2Result["bounds"],
): boolean {
  return left.minX === right.minX && left.minY === right.minY &&
    left.maxX === right.maxX && left.maxY === right.maxY;
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length || new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function isJsonProjectionValue(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth >= 12 || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.length <= 16_384 && value.every((entry) => isJsonProjectionValue(entry, depth + 1, seen));
  if (!isRecord(value) || Reflect.ownKeys(value).length > 8_192) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && key.length <= 512 &&
    isJsonProjectionValue(value[key], depth + 1, seen));
}

function isQuantityRecord(value: unknown): boolean {
  return isRecord(value) && Reflect.ownKeys(value).every((key) => typeof key === "string" &&
    nonEmptyString(key) && finiteNumber(value[key], 0));
}

function normalizeEntity(
  value: DesktopNativeCoreEntityProjection,
  planetId: PlanetId,
): FactoryEntity | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ENTITY_KEYS) || !hasRequiredKeys(value, REQUIRED_ENTITY_KEYS) ||
    !nonEmptyString(value.id) || !ENTITY_KINDS.has(value.kind as string) || value.planetId !== planetId ||
    !isRecord(value.position) || Reflect.ownKeys(value.position).length !== 2 ||
    !Object.hasOwn(value.position, "x") || !Object.hasOwn(value.position, "y") ||
    !finiteNumber(value.position.x) || !finiteNumber(value.position.y) ||
    !isQuantityRecord(value.inputs) || !isQuantityRecord(value.outputs) || !isJsonProjectionValue(value)) return null;
  const record: Record<string, unknown> = value;
  for (const key of ENTITY_NUMBER_KEYS) {
    if (Object.hasOwn(record, key) && !finiteNumber(record[key], 0)) return null;
  }
  for (const key of ENTITY_BOOLEAN_KEYS) {
    if (Object.hasOwn(record, key) && typeof record[key] !== "boolean") return null;
  }
  for (const key of ENTITY_STRING_KEYS) {
    if (Object.hasOwn(record, key) && !nonEmptyString(record[key])) return null;
  }
  for (const key of ENTITY_ARRAY_KEYS) {
    if (Object.hasOwn(record, key) && !Array.isArray(record[key])) return null;
  }
  for (const key of ENTITY_RECORD_KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    if (key === "stationLastSupplyPeerBySlot") {
      const entry = record[key];
      if (!isRecord(entry) || !Object.values(entry).every(nonEmptyString)) return null;
    } else if (!isQuantityRecord(record[key])) return null;
  }
  for (const key of ["orbitalCargoBinding", "stationModeTransition", "quantumTransition"] as const) {
    const entry = value[key];
    if (entry !== undefined && entry !== null && !isRecord(entry)) return null;
  }
  return Object.freeze({
    ...value,
    position: Object.freeze({ x: value.position.x as number, y: value.position.y as number }),
  }) as FactoryEntity;
}

function normalizeBelt(
  value: DesktopNativeCoreBeltProjection,
  planetId: PlanetId,
): BeltConnection | null {
  if (!isRecord(value) || !hasOnlyKeys(value, BELT_KEYS) || !hasRequiredKeys(value, REQUIRED_BELT_KEYS) ||
    !nonEmptyString(value.id) || value.planetId !== planetId || !nonEmptyString(value.source) ||
    !nonEmptyString(value.target) || !nonEmptyString(value.itemId) || !finiteNumber(value.lanes, 1) ||
    !Number.isSafeInteger(value.tier) || (value.tier as number) < 0 || !Number.isSafeInteger(value.sorterTier) ||
    (value.sorterTier as number) < 1 || (value.sorterTier as number) > 3 || !finiteNumber(value.progress, 0) ||
    !Number.isSafeInteger(value.priority) || (value.priority as number) < 0 || (value.priority as number) > 2 ||
    !finiteNumber(value.lastFlow, 0) || !isJsonProjectionValue(value)) return null;
  for (const key of ["stackSize", "totalTransferred", "congestion", "recentFlowSampleSeconds", "recentFlowTransferred", "routeOffsetY"] as const) {
    if (Object.hasOwn(value, key) && !finiteNumber(value[key], key === "routeOffsetY" ? Number.NEGATIVE_INFINITY : 0)) return null;
  }
  for (const key of ["monitorEnabled", "recentFlowSampling"] as const) {
    if (Object.hasOwn(value, key) && typeof value[key] !== "boolean") return null;
  }
  if (value.routeMode !== undefined && !BELT_ROUTE_MODES.has(value.routeMode)) return null;
  if (value.targetPortIndex !== undefined && (!Number.isSafeInteger(value.targetPortIndex) || value.targetPortIndex < 0 || value.targetPortIndex > 2)) return null;
  if (value.elevatorOutputIndex !== undefined && (!Number.isSafeInteger(value.elevatorOutputIndex) || value.elevatorOutputIndex < 0 || value.elevatorOutputIndex > 4)) return null;
  return Object.freeze({ ...value }) as BeltConnection;
}

/**
 * Select a renderer-only native canvas frame. The function has no Web oracle
 * parameter by design: a valid frame is consumed without touching the large
 * GameState arrays, while every identity/schema failure returns null so the
 * caller can switch the complete canvas atomically to its Web fallback.
 */
export function selectNativeAuthoritativeFactoryCanvasFrame(
  snapshot: NativeFactoryThinViewSnapshot,
  binding: NativeAuthoritativeFactoryCanvasBinding,
): NativeAuthoritativeFactoryCanvasFrame | null {
  if (!binding.enabled || binding.requestTruncated || !nonEmptyString(binding.sessionId) ||
    !nonEmptyString(binding.runId) ||
    !Number.isSafeInteger(binding.expectedRevision) || binding.expectedRevision < 0 ||
    binding.requestedPinnedEntityIds.length > 32 || binding.requestedPinnedBeltIds.length > 64 ||
    new Set(binding.requestedPinnedEntityIds).size !== binding.requestedPinnedEntityIds.length ||
    new Set(binding.requestedPinnedBeltIds).size !== binding.requestedPinnedBeltIds.length) return null;
  const frame = snapshot.status === "ready" && snapshot.requestedRevision === binding.expectedRevision
    ? snapshot.frame
    : null;
  const viewport = frame?.viewport;
  const shell = frame?.factory.shell;
  const factorySelection = frame?.factory.selection;
  if (!frame || frame.authoritySessionId !== binding.sessionId || frame.authorityRunId !== binding.runId ||
    frame.revision !== binding.expectedRevision ||
    frame.planetId !== binding.planetId || !viewport || viewport.schemaVersion !== 2 ||
    viewport.projectionType !== "viewport-v2" || viewport.revision !== binding.expectedRevision ||
    viewport.planetId !== binding.planetId || viewport.nextEntityCursor !== null ||
    viewport.nextBeltCursor !== null || !exactBounds(viewport.bounds, binding.bounds) ||
    !sameIdSet(viewport.pinnedEntityIds, binding.requestedPinnedEntityIds) ||
    !sameIdSet(viewport.pinnedBeltIds, binding.requestedPinnedBeltIds) ||
    Reflect.ownKeys(viewport.base).length !== 0 || !shell || shell.source !== "native-core" ||
    frame.factory.revision !== binding.expectedRevision || !factorySelection ||
    factorySelection.schema !== "factory-read-model-v1" || factorySelection.activePlanetId !== binding.planetId ||
    shell.activePlanetId !== binding.planetId || viewport.planetTotals.entities < viewport.viewportTotals.entities ||
    viewport.planetTotals.belts < viewport.viewportTotals.belts) return null;

  const entityById = new Map<string, FactoryEntity>();
  for (const row of viewport.entities) {
    const entity = normalizeEntity(row, binding.planetId);
    if (!entity || entityById.has(entity.id)) return null;
    entityById.set(entity.id, entity);
  }
  const visibleEntityIds = new Set([...entityById.values()].filter((entity) =>
    entity.position.x >= viewport.bounds.minX && entity.position.x <= viewport.bounds.maxX &&
    entity.position.y >= viewport.bounds.minY && entity.position.y <= viewport.bounds.maxY).map((entity) => entity.id));
  if (visibleEntityIds.size !== viewport.viewportTotals.entities ||
    binding.requestedPinnedEntityIds.some((id) => !entityById.has(id))) return null;

  const projectedBeltById = new Map<string, BeltConnection>();
  for (const row of viewport.belts) {
    const belt = normalizeBelt(row, binding.planetId);
    if (!belt || projectedBeltById.has(belt.id)) return null;
    projectedBeltById.set(belt.id, belt);
  }
  const beltSourceEntityIds = new Set([...visibleEntityIds, ...binding.requestedPinnedEntityIds]);
  const ordinaryBeltCount = [...projectedBeltById.values()].reduce((count, belt) =>
    count + (beltSourceEntityIds.has(belt.source) || beltSourceEntityIds.has(belt.target) ? 1 : 0), 0);
  if (ordinaryBeltCount !== viewport.viewportTotals.belts ||
    binding.requestedPinnedBeltIds.some((id) => !projectedBeltById.has(id))) return null;
  const expectedEntityRows = viewport.viewportTotals.entities + binding.requestedPinnedEntityIds.reduce(
    (count, id) => count + (visibleEntityIds.has(id) ? 0 : 1), 0);
  const expectedBeltRows = viewport.viewportTotals.belts + binding.requestedPinnedBeltIds.reduce((count, id) => {
    const belt = projectedBeltById.get(id);
    return count + (belt && (beltSourceEntityIds.has(belt.source) || beltSourceEntityIds.has(belt.target)) ? 0 : 1);
  }, 0);
  if (entityById.size !== expectedEntityRows || projectedBeltById.size !== expectedBeltRows) return null;

  const belts = [...projectedBeltById.values()].filter((belt) =>
    entityById.has(belt.source) && entityById.has(belt.target));
  const viewportReadModel: FactoryViewportReadModel = Object.freeze({
    schema: "factory-viewport-read-model-v1",
    source: "native-core",
    revision: binding.expectedRevision,
    planetId: binding.planetId,
    bounds: Object.freeze({ ...viewport.bounds }),
    pinnedEntityIds: Object.freeze([...viewport.pinnedEntityIds]),
    pinnedBeltIds: Object.freeze([...viewport.pinnedBeltIds]),
    planetTotals: Object.freeze({ ...viewport.planetTotals }),
    viewportTotals: Object.freeze({ ...viewport.viewportTotals }),
    worldBounds: Object.freeze({ ...viewport.worldBounds }),
    entities: Object.freeze([...entityById.values()].map((entity) => Object.freeze({
      id: entity.id,
      kind: entity.kind,
      buildingId: entity.buildingId ?? null,
      x: entity.position.x,
      y: entity.position.y,
    }))),
    belts: Object.freeze([...projectedBeltById.values()].map((belt) => Object.freeze({
      id: belt.id,
      planetId: belt.planetId,
      source: belt.source,
      target: belt.target,
      itemId: belt.itemId,
      lanes: belt.lanes,
      tier: belt.tier,
      stackSize: belt.stackSize ?? 1,
      priority: belt.priority,
      targetPortIndex: belt.targetPortIndex ?? null,
      routeMode: belt.routeMode ?? "auto",
      routeOffsetY: belt.routeOffsetY ?? 0,
    }))),
    broadQueryFallback: viewport.broadQueryFallback,
  });
  return Object.freeze({
    source: "native-authoritative",
    sessionId: binding.sessionId,
    runId: binding.runId,
    revision: binding.expectedRevision,
    planetId: binding.planetId,
    bounds: Object.freeze({ ...viewport.bounds }),
    worldBounds: Object.freeze({ ...viewport.worldBounds }),
    planetTotals: Object.freeze({ ...viewport.planetTotals }),
    viewportTotals: Object.freeze({ ...viewport.viewportTotals }),
    entities: Object.freeze([...entityById.values()]),
    belts: Object.freeze(belts),
    projectedBelts: Object.freeze([...projectedBeltById.values()]),
    entityById,
    beltById: projectedBeltById,
    omittedCrossBoundaryBeltCount: projectedBeltById.size - belts.length,
    viewportReadModel,
    factorySelection,
  });
}

/** Lazy fallback keeps native-authoritative canvas selection O(viewport rows). */
export function selectFactoryCanvasRows(
  nativeFrame: NativeAuthoritativeFactoryCanvasFrame | null,
  createWebRows: () => Pick<FactoryCanvasRows, "entities" | "belts" | "entityById">,
): FactoryCanvasRows {
  if (nativeFrame) return {
    source: nativeFrame.source,
    revision: nativeFrame.revision,
    entities: nativeFrame.entities,
    belts: nativeFrame.belts,
    entityById: nativeFrame.entityById,
  };
  const web = createWebRows();
  return { source: "web-game-state", revision: null, ...web };
}

export function collectCanvasSelectionBeltIds(
  belts: readonly Pick<BeltConnection, "id" | "source" | "target">[],
  selectedNodeIds: readonly string[],
  explicitlySelectedBeltIds: readonly string[],
): string[] {
  const nodeIds = new Set(selectedNodeIds);
  const result = new Set(explicitlySelectedBeltIds);
  for (const belt of belts) {
    if (nodeIds.has(belt.source) && nodeIds.has(belt.target)) result.add(belt.id);
  }
  return [...result];
}

export function collectCanvasDragMembers(
  entityById: ReadonlyMap<string, FactoryEntity>,
  selectedEntityIds: readonly string[],
): Array<{ id: string; position: { x: number; y: number } }> {
  const result: Array<{ id: string; position: { x: number; y: number } }> = [];
  for (const id of selectedEntityIds) {
    const entity = entityById.get(id);
    if (!entity || entity.interactionLocked) continue;
    result.push({ id: entity.id, position: { ...entity.position } });
  }
  return result;
}
