import type { GameState, BeltConnection, FactoryEntity, PlanetId } from "./types";
import {
  FACTORY_READ_MODEL_LIMITS,
  FACTORY_READ_MODEL_SCHEMA,
  type BoundedReadModelRows,
  type FactoryInspectorSummaryReadModel,
  type FactoryMultiSelectionSummaryReadModel,
  type FactorySelectionToolbarReadModel,
  type ItemQuantityReadModel,
  type SelectedBeltReadModel,
  type SelectedEntityReadModel,
} from "./factoryReadModels";
import type { NativeAuthoritativeFactoryCanvasFrame } from "./nativeFactoryCanvasFrame";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";
import {
  createWebFactoryInspectorSummaryReadModel,
  createWebFactoryMultiSelectionSummaryReadModel,
  createWebFactorySelectionToolbarReadModel,
} from "./webFactoryReadModelAdapter";

const MAX_PINNED_ENTITY_ROWS = 32;
const MAX_PINNED_BELT_ROWS = 64;

export interface FactoryInteractionSelection {
  readonly selectedEntityIds: readonly string[];
  readonly selectedBeltIds: readonly string[];
  readonly primarySelectedBeltId: string | null;
}

export interface NativeFactoryInteractionPinRequest {
  readonly entityIds: readonly string[];
  readonly beltIds: readonly string[];
  readonly truncated: boolean;
}

export interface NativeFactoryInteractionBinding extends FactoryInteractionSelection {
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly revision: number;
  readonly planetId: PlanetId;
  readonly connectionEntityIds: readonly string[];
  readonly requestedPinnedEntityIds: readonly string[];
  readonly requestedPinnedBeltIds: readonly string[];
  readonly requestTruncated: boolean;
}

export interface FactoryInteractionRows {
  readonly source: "native-authoritative" | "web-game-state";
  readonly revision: number | null;
  readonly selectedEntities: readonly FactoryEntity[];
  readonly selectedEntity: FactoryEntity | null;
  readonly selectedBelt: BeltConnection | null;
  readonly selectedBelts: readonly BeltConnection[];
  readonly multiSelectedBelts: readonly BeltConnection[];
  /** One bounded, internally consistent row universe for inspector reads. */
  readonly projectionEntities: readonly FactoryEntity[];
  readonly projectionBelts: readonly BeltConnection[];
  readonly entityById: ReadonlyMap<string, FactoryEntity>;
  readonly beltById: ReadonlyMap<string, BeltConnection>;
  readonly selectionToolbarReadModel: FactorySelectionToolbarReadModel;
  readonly inspectorSummaryReadModel: FactoryInspectorSummaryReadModel;
  readonly multiSelectionSummaryReadModel: FactoryMultiSelectionSummaryReadModel;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length || new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function orderedRows<Row>(
  ids: readonly string[],
  rows: ReadonlyMap<string, Row>,
): Row[] | null {
  const result: Row[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) return null;
    result.push(row);
  }
  return result;
}

function itemRows(record: Readonly<Record<string, number>>): BoundedReadModelRows<ItemQuantityReadModel> | null {
  const rows = Object.entries(record)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([itemId, amount]) => ({ itemId, amount }));
  if (rows.length > FACTORY_READ_MODEL_LIMITS.itemRows) return null;
  return Object.freeze({ rows: Object.freeze(rows), totalCount: rows.length, truncated: false });
}

function selectedEntityRow(entity: FactoryEntity): SelectedEntityReadModel | null {
  const inputItems = itemRows(entity.inputs);
  const outputItems = itemRows(entity.outputs);
  if (!inputItems || !outputItems) return null;
  return Object.freeze({
    entityId: entity.id,
    planetId: entity.planetId,
    kind: entity.kind,
    position: Object.freeze({ ...entity.position }),
    interactionLocked: entity.interactionLocked,
    buildingId: entity.buildingId ?? null,
    resourceId: entity.resourceId ?? null,
    recipeId: entity.recipeId ?? null,
    storedItemId: entity.storedItemId ?? null,
    fuelItemId: entity.fuelItemId ?? null,
    machineCount: entity.machineCount,
    minerCount: entity.minerCount,
    progress: entity.progress,
    utilization: entity.utilization,
    productionRate: entity.productionRate,
    powerFactor: entity.powerFactor ?? null,
    inputItems,
    outputItems,
  });
}

function selectedBeltRow(belt: BeltConnection): SelectedBeltReadModel {
  return Object.freeze({
    beltId: belt.id,
    planetId: belt.planetId,
    sourceEntityId: belt.source,
    targetEntityId: belt.target,
    itemId: belt.itemId,
    lanes: belt.lanes,
    tier: belt.tier,
    sorterTier: belt.sorterTier,
    stackSize: belt.stackSize ?? null,
    priority: belt.priority,
    progress: belt.progress,
    lastFlow: belt.lastFlow,
    totalTransferred: belt.totalTransferred ?? null,
    congestion: belt.congestion ?? null,
  });
}

function allSelectedBeltIds(selection: FactoryInteractionSelection): string[] {
  return uniqueIds(selection.primarySelectedBeltId
    ? [selection.primarySelectedBeltId, ...selection.selectedBeltIds]
    : selection.selectedBeltIds);
}

/**
 * Adds selection, connection endpoints and already-proven related rows to one
 * deterministic bounded pin request. Hitting a cap is fail-closed: callers may
 * send the prefix, but must mark the whole native interaction atom unavailable.
 */
export function createNativeFactoryInteractionPinRequest(input: {
  readonly selectedEntityIds: readonly string[];
  readonly selectedBeltIds: readonly string[];
  readonly primarySelectedBeltId: string | null;
  readonly connectionEntityIds: readonly (string | null | undefined)[];
  readonly relatedEntityIds?: readonly string[];
}): NativeFactoryInteractionPinRequest {
  const entityCandidates = uniqueIds([
    ...input.selectedEntityIds,
    ...input.connectionEntityIds.filter(isOpaqueId),
    ...(input.relatedEntityIds ?? []),
  ]);
  const beltCandidates = allSelectedBeltIds(input);
  const malformed = entityCandidates.some((id) => !isOpaqueId(id)) || beltCandidates.some((id) => !isOpaqueId(id));
  return Object.freeze({
    entityIds: Object.freeze(entityCandidates.slice(0, MAX_PINNED_ENTITY_ROWS)),
    beltIds: Object.freeze(beltCandidates.slice(0, MAX_PINNED_BELT_ROWS)),
    truncated: malformed || entityCandidates.length > MAX_PINNED_ENTITY_ROWS || beltCandidates.length > MAX_PINNED_BELT_ROWS,
  });
}

/**
 * The first selected-belt frame carries stable endpoint IDs in the bounded
 * factory selection model. A second viewport request can pin those endpoints,
 * without consulting the Web GameState arrays or teaching renderer code to
 * infer authority from an old/mismatched session.
 */
export function selectNativeFactorySelectionRelatedEntityIds(
  snapshot: NativeFactoryThinViewSnapshot,
  binding: Readonly<{
    sessionId: string | null;
    revision: number;
    planetId: PlanetId;
    selectedEntityIds: readonly string[];
    selectedBeltIds: readonly string[];
  }>,
): readonly string[] {
  if (!isOpaqueId(binding.sessionId) || !Number.isSafeInteger(binding.revision) || binding.revision < 0 ||
    new Set(binding.selectedEntityIds).size !== binding.selectedEntityIds.length ||
    new Set(binding.selectedBeltIds).size !== binding.selectedBeltIds.length) return Object.freeze([]);
  const frame = snapshot.status === "ready" && snapshot.requestedRevision === binding.revision
    ? snapshot.frame
    : null;
  const selection = frame?.factory.selection;
  if (!frame || !selection || frame.authoritySessionId !== binding.sessionId || frame.revision !== binding.revision ||
    frame.planetId !== binding.planetId || frame.factory.revision !== binding.revision ||
    frame.factory.shell.source !== "native-core" || frame.factory.shell.activePlanetId !== binding.planetId ||
    selection.activePlanetId !== binding.planetId || selection.entityRows.truncated || selection.beltRows.truncated ||
    selection.requestedEntityCount !== binding.selectedEntityIds.length ||
    selection.requestedBeltCount !== binding.selectedBeltIds.length ||
    selection.entityRows.totalCount !== selection.entityRows.rows.length ||
    selection.beltRows.totalCount !== selection.beltRows.rows.length ||
    selection.entityRows.rows.length !== binding.selectedEntityIds.length ||
    selection.beltRows.rows.length !== binding.selectedBeltIds.length ||
    selection.entityRows.rows.some((row, index) => row.entityId !== binding.selectedEntityIds[index]) ||
    selection.beltRows.rows.some((row, index) => row.beltId !== binding.selectedBeltIds[index] ||
      row.planetId !== binding.planetId || !isOpaqueId(row.sourceEntityId) || !isOpaqueId(row.targetEntityId))) {
    return Object.freeze([]);
  }
  return Object.freeze(uniqueIds(selection.beltRows.rows.flatMap((row) => [row.sourceEntityId, row.targetEntityId])));
}

/** Proves that the selected belt's same-item connected component is complete in the bounded projection. */
function selectedBeltNetworkIsClosed(
  selectedBelt: BeltConnection,
  entityById: ReadonlyMap<string, FactoryEntity>,
  belts: readonly BeltConnection[],
): boolean {
  if (!entityById.has(selectedBelt.source) || !entityById.has(selectedBelt.target)) return false;
  const adjacent = new Map<string, BeltConnection[]>();
  for (const belt of belts) {
    if (belt.planetId !== selectedBelt.planetId || belt.itemId !== selectedBelt.itemId) continue;
    for (const entityId of [belt.source, belt.target]) {
      const rows = adjacent.get(entityId) ?? [];
      rows.push(belt);
      adjacent.set(entityId, rows);
    }
  }
  const visitedEntities = new Set<string>([selectedBelt.source, selectedBelt.target]);
  const visitedBelts = new Set<string>();
  const queue = [...visitedEntities];
  while (queue.length > 0) {
    const entityId = queue.shift()!;
    for (const belt of adjacent.get(entityId) ?? []) {
      if (visitedBelts.has(belt.id)) continue;
      visitedBelts.add(belt.id);
      if (!entityById.has(belt.source) || !entityById.has(belt.target)) return false;
      for (const endpoint of [belt.source, belt.target]) {
        if (!visitedEntities.has(endpoint)) {
          visitedEntities.add(endpoint);
          queue.push(endpoint);
        }
      }
    }
  }
  return visitedBelts.has(selectedBelt.id);
}

function createNativeModels(
  frame: NativeAuthoritativeFactoryCanvasFrame,
  binding: NativeFactoryInteractionBinding,
  selectedEntities: readonly FactoryEntity[],
  selectedBelt: BeltConnection | null,
  selectedBelts: readonly BeltConnection[],
  multiSelectedBelts: readonly BeltConnection[],
): Pick<FactoryInteractionRows, "selectionToolbarReadModel" | "inspectorSummaryReadModel" | "multiSelectionSummaryReadModel"> | null {
  const entityRows: SelectedEntityReadModel[] = [];
  for (const entity of selectedEntities) {
    const row = selectedEntityRow(entity);
    if (!row) return null;
    entityRows.push(row);
  }
  const multiBeltRows = multiSelectedBelts.map(selectedBeltRow);
  const inspectorEntity = selectedEntities.length === 1 ? entityRows[0] ?? null : null;
  const inspectorBelt = inspectorEntity ? null : selectedBelt ? selectedBeltRow(selectedBelt) : null;
  return {
    selectionToolbarReadModel: Object.freeze({
      schema: FACTORY_READ_MODEL_SCHEMA,
      source: "native-core",
      revision: frame.revision,
      activePlanetId: frame.planetId,
      selectedCount: binding.selectedEntityIds.length,
      selectedBeltCount: selectedBelts.length,
      canLock: selectedEntities.some((entity) => !entity.interactionLocked),
      canUnlock: selectedEntities.some((entity) => entity.interactionLocked),
    }),
    inspectorSummaryReadModel: Object.freeze({
      schema: FACTORY_READ_MODEL_SCHEMA,
      source: "native-core",
      revision: frame.revision,
      activePlanetId: frame.planetId,
      entity: inspectorEntity,
      belt: inspectorBelt,
    }),
    multiSelectionSummaryReadModel: Object.freeze({
      schema: FACTORY_READ_MODEL_SCHEMA,
      source: "native-core",
      revision: frame.revision,
      activePlanetId: frame.planetId,
      requestedEntityCount: binding.selectedEntityIds.length,
      requestedBeltCount: multiSelectedBelts.length,
      entityRows: Object.freeze({ rows: Object.freeze(entityRows), totalCount: entityRows.length, truncated: false }),
      beltRows: Object.freeze({ rows: Object.freeze(multiBeltRows), totalCount: multiBeltRows.length, truncated: false }),
    }),
  };
}

/**
 * Selects every row used by selection/inspect/connect as one native atom.
 * It has no Web argument: any missing pin, incomplete belt network, session or
 * revision mismatch returns null so the caller can invoke one complete fallback.
 */
export function selectNativeAuthoritativeFactoryInteractionRows(
  frame: NativeAuthoritativeFactoryCanvasFrame | null,
  binding: NativeFactoryInteractionBinding,
): FactoryInteractionRows | null {
  if (!frame || !binding.enabled || binding.requestTruncated || !isOpaqueId(binding.sessionId) ||
    frame.sessionId !== binding.sessionId || frame.revision !== binding.revision || frame.planetId !== binding.planetId ||
    binding.selectedEntityIds.length > MAX_PINNED_ENTITY_ROWS || binding.selectedBeltIds.length > MAX_PINNED_BELT_ROWS ||
    new Set(binding.selectedEntityIds).size !== binding.selectedEntityIds.length ||
    new Set(binding.selectedBeltIds).size !== binding.selectedBeltIds.length ||
    new Set(binding.connectionEntityIds).size !== binding.connectionEntityIds.length ||
    !sameIdSet(frame.viewportReadModel.pinnedEntityIds, binding.requestedPinnedEntityIds) ||
    !sameIdSet(frame.viewportReadModel.pinnedBeltIds, binding.requestedPinnedBeltIds)) return null;

  const selectedBeltIds = allSelectedBeltIds(binding);
  if (binding.selectedEntityIds.some((id) => !binding.requestedPinnedEntityIds.includes(id)) ||
    binding.connectionEntityIds.some((id) => !binding.requestedPinnedEntityIds.includes(id)) ||
    selectedBeltIds.some((id) => !binding.requestedPinnedBeltIds.includes(id))) return null;
  const selectedEntities = orderedRows(binding.selectedEntityIds, frame.entityById);
  const allBelts = orderedRows(selectedBeltIds, frame.beltById);
  const toolbarBelts = orderedRows(binding.selectedBeltIds, frame.beltById);
  if (!selectedEntities || !allBelts || !toolbarBelts ||
    selectedEntities.some((entity) => entity.planetId !== binding.planetId) ||
    allBelts.some((belt) => belt.planetId !== binding.planetId) ||
    binding.connectionEntityIds.some((id) => !frame.entityById.has(id))) return null;

  const selectedEntity = selectedEntities.length === 1 ? selectedEntities[0] : null;
  const selectedBelt = binding.primarySelectedBeltId
    ? frame.beltById.get(binding.primarySelectedBeltId) ?? null
    : null;
  if (selectedEntity?.stationPeerId && !frame.entityById.has(selectedEntity.stationPeerId)) return null;
  if (!selectedEntity && selectedBelt &&
    !selectedBeltNetworkIsClosed(selectedBelt, frame.entityById, frame.projectedBelts)) return null;
  const multiSelectedBelts = selectedEntities.length > 1 ? allBelts : [];
  const models = createNativeModels(frame, binding, selectedEntities, selectedBelt, toolbarBelts, multiSelectedBelts);
  if (!models) return null;
  return Object.freeze({
    source: "native-authoritative",
    revision: frame.revision,
    selectedEntities: Object.freeze(selectedEntities),
    selectedEntity,
    selectedBelt,
    selectedBelts: Object.freeze(toolbarBelts),
    multiSelectedBelts: Object.freeze(multiSelectedBelts),
    projectionEntities: frame.entities,
    projectionBelts: frame.projectedBelts,
    entityById: frame.entityById,
    beltById: frame.beltById,
    ...models,
  });
}

/** One-pass Web/PWA fallback; no repeated find/filter per inspector model. */
export function createWebFactoryInteractionRows(
  state: GameState,
  selection: FactoryInteractionSelection,
): FactoryInteractionRows {
  const entityIds = new Set(selection.selectedEntityIds);
  const beltIds = allSelectedBeltIds(selection);
  const requestedBelts = new Set(beltIds);
  const entityById = new Map<string, FactoryEntity>();
  const beltById = new Map<string, BeltConnection>();
  for (const entity of state.entities) {
    if (entity.planetId === state.activePlanetId && entityIds.has(entity.id)) entityById.set(entity.id, entity);
  }
  for (const belt of state.belts) {
    if (belt.planetId === state.activePlanetId && requestedBelts.has(belt.id)) beltById.set(belt.id, belt);
  }
  const selectedEntities = selection.selectedEntityIds.flatMap((id) => {
    const entity = entityById.get(id);
    return entity ? [entity] : [];
  });
  const selectedEntity = selectedEntities.length === 1 ? selectedEntities[0] : null;
  const selectedBelt = selection.primarySelectedBeltId
    ? beltById.get(selection.primarySelectedBeltId) ?? null
    : null;
  const selectedBelts = selection.selectedBeltIds.flatMap((id) => {
    const belt = beltById.get(id);
    return belt ? [belt] : [];
  });
  const multiSelectedBelts = selectedEntities.length > 1
    ? beltIds.flatMap((id) => {
        const belt = beltById.get(id);
        return belt ? [belt] : [];
      })
    : [];
  return {
    source: "web-game-state",
    revision: null,
    selectedEntities,
    selectedEntity,
    selectedBelt,
    selectedBelts,
    multiSelectedBelts,
    projectionEntities: state.entities,
    projectionBelts: state.belts,
    entityById,
    beltById,
    selectionToolbarReadModel: createWebFactorySelectionToolbarReadModel(
      state,
      selection.selectedEntityIds,
      selection.selectedBeltIds,
    ),
    inspectorSummaryReadModel: createWebFactoryInspectorSummaryReadModel(state, selectedEntity, selectedBelt),
    multiSelectionSummaryReadModel: createWebFactoryMultiSelectionSummaryReadModel(
      state,
      selectedEntities,
      multiSelectedBelts,
      { selectedEntityIds: selection.selectedEntityIds, selectedBeltIds: beltIds },
    ),
  };
}

/** Native-first lazy switch; a valid native atom never evaluates the large Web arrays. */
export function selectFactoryInteractionRows(
  native: FactoryInteractionRows | null,
  createWebRows: () => FactoryInteractionRows,
): FactoryInteractionRows {
  return native ?? createWebRows();
}

/**
 * Rebinds only the entity/belt row universe for high-frequency connection
 * previews. Missing endpoints return the untouched Web state; commands still
 * execute against the real authority state and revalidate on commit.
 */
export function selectFactoryConnectionReadState(
  webState: GameState,
  frame: NativeAuthoritativeFactoryCanvasFrame | null,
  binding: Readonly<{
    sessionId: string | null;
    revision: number;
    planetId: PlanetId;
  }>,
  sourceEntityId: string | null | undefined,
  targetEntityId: string | null | undefined,
): GameState {
  if (!frame || !isOpaqueId(binding.sessionId) || !Number.isSafeInteger(binding.revision) || binding.revision < 0 ||
    frame.sessionId !== binding.sessionId || frame.revision !== binding.revision || frame.planetId !== binding.planetId ||
    !sourceEntityId || !targetEntityId ||
    !frame.entityById.has(sourceEntityId) || !frame.entityById.has(targetEntityId)) return webState;
  return {
    ...webState,
    entities: frame.entities as FactoryEntity[],
    belts: frame.projectedBelts as BeltConnection[],
  };
}
