import type { BeltConnection, FactoryEntity, GameState, PlanetId } from "./types";

/** Versioned, UI-only projection carried alongside the authoritative state. */
export interface SimulationProjection {
  protocolVersion: 2;
  elapsedSeconds: number;
  activePlanetId: PlanetId;
  /** Current-planet records only. They are a UI projection, never persisted. */
  changedEntityIds: string[];
  changedBeltIds: string[];
  changedEntities: FactoryEntity[];
  changedBelts: BeltConnection[];
  /**
   * Compact steady-state columnar encoding. A field name is sent once and
   * each row is `[globalRecordIndex, value]`, avoiding repeated ids/keys.
   */
  entityColumns: Record<string, Array<[number, unknown]>>;
  beltColumns: Record<string, Array<[number, unknown]>>;
  entityRemovedFields: Record<string, number[]>;
  beltRemovedFields: Record<string, number[]>;
  /**
   * Runtime-facing top-level fields, excluding the two record arrays and
   * history/planning payloads that are not needed for the default live UI.
   */
  topLevel: Partial<Omit<GameState, "entities" | "belts" | "productionHistory" | "dysonPlans">>;
  removedEntityIds: string[];
  removedBeltIds: string[];
  topologyChangedEntityIds: string[];
  topologyChangedBeltIds: string[];
  /** A planet switch cannot be represented by an incremental render merge. */
  requiresFullSnapshot: boolean;
  entityCount: number;
  beltCount: number;
  inFlightRouteCount: number;
  totalProduced: number;
}

export interface SimulationProjectionBaseline {
  kind: "simulation-projection-baseline";
  activePlanetId: PlanetId;
  entitySignatures: ReadonlyMap<string, string>;
  beltSignatures: ReadonlyMap<string, string>;
  entityTopologySignatures: ReadonlyMap<string, string>;
  beltTopologySignatures: ReadonlyMap<string, string>;
  topLevelSignatures: ReadonlyMap<string, string | undefined>;
}

const EXCLUDED_TOP_LEVEL_PROJECTION_KEYS = new Set<keyof GameState>([
  "entities",
  "belts",
  // These two fields accounted for ~335 KiB per second in the 35 MiB player
  // fixture. They are persisted by checkpoints and can be requested by their
  // dedicated workspaces; neither drives the default factory canvas.
  "productionHistory",
  "dysonPlans",
]);

function isSimulationProjectionBaseline(value: GameState | SimulationProjectionBaseline): value is SimulationProjectionBaseline {
  return "kind" in value && value.kind === "simulation-projection-baseline";
}

function entityTopologySignature(entity: FactoryEntity): string {
  return [entity.planetId, entity.kind, entity.buildingId ?? "", entity.resourceId ?? "", entity.position.x, entity.position.y].join("|");
}

function beltTopologySignature(belt: BeltConnection): string {
  return [
    belt.planetId,
    belt.source,
    belt.target,
    belt.itemId,
    belt.tier,
    belt.lanes,
    belt.stackSize ?? 1,
    belt.priority,
    belt.targetPortIndex ?? "",
    belt.routeMode ?? "auto",
    belt.routeOffsetY ?? 0,
  ].join("|");
}

function entitySignature(entity: GameState["entities"][number]): string {
  return JSON.stringify(entity);
}

function beltSignature(belt: GameState["belts"][number]): string {
  return JSON.stringify(belt);
}

function topLevelEntries(state: GameState): Array<[string, unknown]> {
  return Object.keys(state)
    .filter((key) => !EXCLUDED_TOP_LEVEL_PROJECTION_KEYS.has(key as keyof GameState))
    .map((key) => [key, (state as unknown as Record<string, unknown>)[key]]);
}

export function captureSimulationProjectionBaseline(state: GameState): SimulationProjectionBaseline {
  const entities = state.entities.filter((entity) => entity.planetId === state.activePlanetId);
  const belts = state.belts.filter((belt) => belt.planetId === state.activePlanetId);
  return {
    kind: "simulation-projection-baseline",
    activePlanetId: state.activePlanetId,
    entitySignatures: new Map(entities.map((entity) => [entity.id, entitySignature(entity)])),
    beltSignatures: new Map(belts.map((belt) => [belt.id, beltSignature(belt)])),
    entityTopologySignatures: new Map(entities.map((entity) => [entity.id, entityTopologySignature(entity)])),
    beltTopologySignatures: new Map(belts.map((belt) => [belt.id, beltTopologySignature(belt)])),
    topLevelSignatures: new Map(topLevelEntries(state).map(([key, value]) => [key, JSON.stringify(value)])),
  };
}

function appendRecordColumns<T extends { id: string }>(
  previous: T,
  current: T,
  index: number,
  columns: Record<string, Array<[number, unknown]>>,
  removedFields: Record<string, number[]>,
): void {
  const before = previous as unknown as Record<string, unknown>;
  const after = current as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) {
      (removedFields[key] ??= []).push(index);
      continue;
    }
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      (columns[key] ??= []).push([index, after[key]]);
    }
  }
}

export function createSimulationProjection(
  previous: GameState | SimulationProjectionBaseline | null,
  current: GameState,
  options: { compact?: boolean } = {},
): SimulationProjection {
  // Projection work is bounded by the visible planet. Other planets remain in
  // the authoritative state and are rebuilt once if the player switches to them.
  const baseline = previous ? isSimulationProjectionBaseline(previous) ? previous : captureSimulationProjectionBaseline(previous) : null;
  const previousEntities = baseline?.entitySignatures ?? new Map<string, string>();
  const previousBelts = baseline?.beltSignatures ?? new Map<string, string>();
  const currentPlanetEntities = current.entities.filter((entity) => entity.planetId === current.activePlanetId);
  const currentPlanetBelts = current.belts.filter((belt) => belt.planetId === current.activePlanetId);
  const changedEntities = currentPlanetEntities.filter((entity) => previousEntities.get(entity.id) !== entitySignature(entity));
  const changedBelts = currentPlanetBelts.filter((belt) => previousBelts.get(belt.id) !== beltSignature(belt));
  const currentEntityIds = new Set(currentPlanetEntities.map((entity) => entity.id));
  const currentBeltIds = new Set(currentPlanetBelts.map((belt) => belt.id));
  const removedEntityIds = [...previousEntities.keys()].filter((id) => !currentEntityIds.has(id));
  const removedBeltIds = [...previousBelts.keys()].filter((id) => !currentBeltIds.has(id));
  const compactEntities = Boolean(options.compact && removedEntityIds.length === 0 && changedEntities.every((entity) => previousEntities.has(entity.id)));
  const compactBelts = Boolean(options.compact && removedBeltIds.length === 0 && changedBelts.every((belt) => previousBelts.has(belt.id)));
  const entityColumns: SimulationProjection["entityColumns"] = {};
  const beltColumns: SimulationProjection["beltColumns"] = {};
  const entityRemovedFields: SimulationProjection["entityRemovedFields"] = {};
  const beltRemovedFields: SimulationProjection["beltRemovedFields"] = {};
  if (compactEntities) {
    const indexById = new Map(current.entities.map((entity, index) => [entity.id, index]));
    for (const entity of changedEntities) {
      appendRecordColumns(
        JSON.parse(previousEntities.get(entity.id)!) as FactoryEntity,
        entity,
        indexById.get(entity.id)!,
        entityColumns,
        entityRemovedFields,
      );
    }
  }
  if (compactBelts) {
    const indexById = new Map(current.belts.map((belt, index) => [belt.id, index]));
    for (const belt of changedBelts) {
      appendRecordColumns(
        JSON.parse(previousBelts.get(belt.id)!) as BeltConnection,
        belt,
        indexById.get(belt.id)!,
        beltColumns,
        beltRemovedFields,
      );
    }
  }
  const topLevel = {} as SimulationProjection["topLevel"];
  for (const [key, value] of topLevelEntries(current)) {
    if (!baseline || baseline.topLevelSignatures.get(key) !== JSON.stringify(value)) {
      (topLevel as Record<string, unknown>)[key] = value;
    }
  }
  const topologyChangedEntityIds = changedEntities
    .filter((entity) => baseline?.entityTopologySignatures.get(entity.id) !== entityTopologySignature(entity))
    .map((entity) => entity.id);
  const topologyChangedBeltIds = changedBelts
    .filter((belt) => baseline?.beltTopologySignatures.get(belt.id) !== beltTopologySignature(belt))
    .map((belt) => belt.id);
  const totalProduced = Object.values(current.totalProduced ?? {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  return {
    protocolVersion: 2,
    elapsedSeconds: current.elapsedSeconds,
    activePlanetId: current.activePlanetId,
    changedEntityIds: changedEntities.map((entity) => entity.id),
    changedBeltIds: changedBelts.map((belt) => belt.id),
    changedEntities: compactEntities ? [] : changedEntities,
    changedBelts: compactBelts ? [] : changedBelts,
    entityColumns,
    beltColumns,
    entityRemovedFields,
    beltRemovedFields,
    topLevel,
    removedEntityIds,
    removedBeltIds,
    topologyChangedEntityIds: [...topologyChangedEntityIds, ...removedEntityIds],
    topologyChangedBeltIds: [...topologyChangedBeltIds, ...removedBeltIds],
    requiresFullSnapshot: Boolean(previous && previous.activePlanetId !== current.activePlanetId),
    entityCount: current.entities.length,
    beltCount: current.belts.length,
    inFlightRouteCount: current.entities.reduce((sum, entity) => sum + (entity.stationRoutes?.length ?? 0), 0),
    totalProduced,
  };
}

function mergeRecords<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
  removedIds: readonly string[],
): T[] {
  const records = new Map(previous.map((record) => [record.id, record]));
  for (const id of removedIds) records.delete(id);
  for (const record of next) records.set(record.id, record);
  return [...records.values()];
}

function mergeIds(previous: readonly string[], next: readonly string[], removedIds: readonly string[] = []): string[] {
  const ids = new Set(previous);
  for (const id of removedIds) ids.delete(id);
  for (const id of next) ids.add(id);
  return [...ids];
}

/** Accumulates low-frequency canvas publications without dropping intermediate Worker changes. */
export function mergeSimulationProjections(
  previous: SimulationProjection | null,
  next: SimulationProjection,
): SimulationProjection {
  if (!previous || previous.activePlanetId !== next.activePlanetId || previous.protocolVersion !== next.protocolVersion) {
    return { ...next, requiresFullSnapshot: next.requiresFullSnapshot || Boolean(previous && previous.activePlanetId !== next.activePlanetId) };
  }
  const changedEntities = mergeRecords(previous.changedEntities, next.changedEntities, next.removedEntityIds);
  const changedBelts = mergeRecords(previous.changedBelts, next.changedBelts, next.removedBeltIds);
  return {
    ...next,
    topLevel: { ...previous.topLevel, ...next.topLevel },
    changedEntities,
    changedBelts,
    entityColumns: mergeProjectionColumns(previous.entityColumns, next.entityColumns),
    beltColumns: mergeProjectionColumns(previous.beltColumns, next.beltColumns),
    entityRemovedFields: mergeRemovedFieldColumns(previous.entityRemovedFields, next.entityRemovedFields),
    beltRemovedFields: mergeRemovedFieldColumns(previous.beltRemovedFields, next.beltRemovedFields),
    changedEntityIds: mergeIds(previous.changedEntityIds, next.changedEntityIds, next.removedEntityIds),
    changedBeltIds: mergeIds(previous.changedBeltIds, next.changedBeltIds, next.removedBeltIds),
    removedEntityIds: mergeIds(previous.removedEntityIds, next.removedEntityIds, next.changedEntityIds),
    removedBeltIds: mergeIds(previous.removedBeltIds, next.removedBeltIds, next.changedBeltIds),
    topologyChangedEntityIds: mergeIds(previous.topologyChangedEntityIds, next.topologyChangedEntityIds),
    topologyChangedBeltIds: mergeIds(previous.topologyChangedBeltIds, next.topologyChangedBeltIds),
    requiresFullSnapshot: previous.requiresFullSnapshot || next.requiresFullSnapshot,
  };
}

function mergeProjectionColumns(
  previous: SimulationProjection["entityColumns"],
  next: SimulationProjection["entityColumns"],
): SimulationProjection["entityColumns"] {
  const merged: SimulationProjection["entityColumns"] = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const values = new Map<number, unknown>(previous[key] ?? []);
    for (const [index, value] of next[key] ?? []) values.set(index, value);
    merged[key] = [...values];
  }
  return merged;
}

function mergeRemovedFieldColumns(
  previous: SimulationProjection["entityRemovedFields"],
  next: SimulationProjection["entityRemovedFields"],
): SimulationProjection["entityRemovedFields"] {
  return Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(next)])].map((key) => [
    key,
    [...new Set([...(previous[key] ?? []), ...(next[key] ?? [])])],
  ]));
}

export interface SimulationProjectionStateIndex {
  entities: readonly FactoryEntity[];
  belts: readonly BeltConnection[];
  entityIndexById: Map<string, number>;
  beltIndexById: Map<string, number>;
}

export function createSimulationProjectionStateIndex(state: GameState): SimulationProjectionStateIndex {
  return {
    entities: state.entities,
    belts: state.belts,
    entityIndexById: new Map(state.entities.map((entity, index) => [entity.id, index])),
    beltIndexById: new Map(state.belts.map((belt, index) => [belt.id, index])),
  };
}

function applyProjectedRecords<T extends { id: string }>(
  previous: readonly T[],
  changed: readonly T[],
  columns: Record<string, Array<[number, unknown]>>,
  removedFields: Record<string, number[]>,
  removedIds: readonly string[],
  indexById: ReadonlyMap<string, number>,
): { records: T[]; indexById: Map<string, number> } {
  const hasColumns = Object.keys(columns).length > 0 || Object.keys(removedFields).length > 0;
  if (changed.length === 0 && !hasColumns && removedIds.length === 0) return { records: previous as T[], indexById: new Map(indexById) };
  if (removedIds.length > 0) {
    const removed = new Set(removedIds);
    const changedById = new Map(changed.map((record) => [record.id, record]));
    const records = previous.flatMap((record) => removed.has(record.id) ? [] : [changedById.get(record.id) ?? record]);
    const existing = new Set(records.map((record) => record.id));
    for (const record of changed) if (!existing.has(record.id)) records.push(record);
    return { records, indexById: new Map(records.map((record, index) => [record.id, index])) };
  }
  const records = [...previous];
  const nextIndex = new Map(indexById);
  for (const record of changed) {
    const index = nextIndex.get(record.id);
    if (index === undefined) {
      nextIndex.set(record.id, records.length);
      records.push(record);
    } else {
      records[index] = record;
    }
  }
  const cloned = new Set<number>();
  const writable = (index: number): Record<string, unknown> | null => {
    if (index < 0 || index >= records.length) return null;
    if (!cloned.has(index)) {
      records[index] = { ...records[index] };
      cloned.add(index);
    }
    return records[index] as unknown as Record<string, unknown>;
  };
  for (const [field, values] of Object.entries(columns)) {
    for (const [index, value] of values) {
      const record = writable(index);
      if (record) record[field] = value;
    }
  }
  for (const [field, indices] of Object.entries(removedFields)) {
    for (const index of indices) {
      const record = writable(index);
      if (record) delete record[field];
    }
  }
  return { records, indexById: nextIndex };
}

/**
 * Applies a Worker projection to the UI mirror in O(changed records). The
 * arrays are shallow-cloned, while a persistent id index avoids scanning a
 * 100k-record save every publication.
 */
export function applySimulationProjectionToState(
  state: GameState,
  projection: SimulationProjection,
  previousIndex?: SimulationProjectionStateIndex,
): { state: GameState; index: SimulationProjectionStateIndex } {
  const index = previousIndex && previousIndex.entities === state.entities && previousIndex.belts === state.belts
    ? previousIndex
    : createSimulationProjectionStateIndex(state);
  // On a planet switch, removed ids belong to the formerly active planet and
  // must remain in the global UI mirror. The new active planet arrives as a
  // complete changed-record snapshot.
  const removedEntityIds = projection.requiresFullSnapshot ? [] : projection.removedEntityIds;
  const removedBeltIds = projection.requiresFullSnapshot ? [] : projection.removedBeltIds;
  const entities = applyProjectedRecords(state.entities, projection.changedEntities, projection.entityColumns, projection.entityRemovedFields, removedEntityIds, index.entityIndexById);
  const belts = applyProjectedRecords(state.belts, projection.changedBelts, projection.beltColumns, projection.beltRemovedFields, removedBeltIds, index.beltIndexById);
  const next = {
    ...state,
    ...projection.topLevel,
    elapsedSeconds: projection.elapsedSeconds,
    activePlanetId: projection.activePlanetId,
    entities: entities.records,
    belts: belts.records,
  } as GameState;
  return {
    state: next,
    index: {
      entities: next.entities,
      belts: next.belts,
      entityIndexById: entities.indexById,
      beltIndexById: belts.indexById,
    },
  };
}

/** Converts a compact Worker projection into the full changed records expected by the canvas cache. */
export function hydrateSimulationProjection(
  projection: SimulationProjection,
  state: GameState,
  index: SimulationProjectionStateIndex,
): SimulationProjection {
  if (Object.keys(projection.entityColumns).length === 0 && Object.keys(projection.beltColumns).length === 0) return projection;
  const changedEntities = projection.changedEntityIds.flatMap((id) => {
    const recordIndex = index.entityIndexById.get(id);
    return recordIndex === undefined ? [] : [state.entities[recordIndex]];
  });
  const changedBelts = projection.changedBeltIds.flatMap((id) => {
    const recordIndex = index.beltIndexById.get(id);
    return recordIndex === undefined ? [] : [state.belts[recordIndex]];
  });
  return {
    ...projection,
    changedEntities,
    changedBelts,
    entityColumns: {},
    beltColumns: {},
    entityRemovedFields: {},
    beltRemovedFields: {},
  };
}
