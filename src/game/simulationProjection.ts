import type { BeltConnection, FactoryEntity, GameState, PlanetId } from "./types";
import type { FactoryAlertProjection } from "./alerts";

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
  topLevel: Partial<Omit<GameState, "entities" | "belts">>;
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
  /** Compact exact global alert rows derived in the authoritative Worker. */
  alerts?: FactoryAlertProjection;
}

interface ProjectionFieldBaseline {
  /** Detached structural node. It never retains an authoritative mutable
   * GameState object and is updated in place without per-step JSON strings. */
  kind: "primitive" | "array" | "object";
  value: unknown;
}

interface ProjectionRecordBaseline {
  fields: Map<string, ProjectionFieldBaseline>;
  topologySignature: string;
  seenGeneration: number;
}

export interface SimulationProjectionBaseline {
  kind: "simulation-projection-baseline";
  activePlanetId: PlanetId;
  /** Persistent field snapshots are advanced in place after each successful
   * publication. This removes whole-record stringify/parse churn while still
   * detecting mutations made in place by the authoritative runtime. */
  entitySnapshots: Map<string, ProjectionRecordBaseline>;
  beltSnapshots: Map<string, ProjectionRecordBaseline>;
  generation: number;
  topLevelSnapshots: Map<string, ProjectionFieldBaseline>;
  includesDeferredTopLevel: boolean;
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

const DEFERRED_TOP_LEVEL_PROJECTION_KEYS = new Set<keyof GameState>(["productionHistory", "dysonPlans"]);

/**
 * Force-refresh only the large top-level fields used by statistics and Dyson
 * workspaces. Entity/belt arrays stay authoritative in the Worker and are not
 * cloned, serialized or published to the canvas for this barrier.
 */
export function createDeferredTopLevelSimulationProjection(current: GameState): SimulationProjection {
  const totalProduced = Object.values(current.totalProduced ?? {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  return {
    protocolVersion: 2,
    elapsedSeconds: current.elapsedSeconds,
    activePlanetId: current.activePlanetId,
    changedEntityIds: [],
    changedBeltIds: [],
    changedEntities: [],
    changedBelts: [],
    entityColumns: {},
    beltColumns: {},
    entityRemovedFields: {},
    beltRemovedFields: {},
    topLevel: {
      productionHistory: current.productionHistory,
      dysonPlans: current.dysonPlans,
    },
    removedEntityIds: [],
    removedBeltIds: [],
    topologyChangedEntityIds: [],
    topologyChangedBeltIds: [],
    requiresFullSnapshot: false,
    entityCount: current.entities.length,
    beltCount: current.belts.length,
    inFlightRouteCount: 0,
    totalProduced,
  };
}

/**
 * Publish an exact UI mirror after durable replay without cloning every planet.
 * The Worker remains authoritative for off-planet records; a later planet
 * switch uses this same full-current-planet boundary for that destination.
 */
export function createFullCurrentPlanetSimulationProjection(current: GameState): SimulationProjection {
  return {
    ...createSimulationProjection(null, current, { includeDeferredTopLevel: true }),
    requiresFullSnapshot: true,
  };
}

export interface SimulationProjectionChunk {
  index: number;
  total: number;
  projection: SimulationProjection;
}

/** Split a full-record projection into bounded messages. This is used when a
 * large terminal state is adopted after pure idle: one multi-megabyte
 * structured clone can block the UI even though the authoritative checkpoint
 * itself is transferred zero-copy. */
export function chunkFullRecordSimulationProjection(
  projection: SimulationProjection,
  options: { entityChunkSize?: number; beltChunkSize?: number } = {},
): SimulationProjectionChunk[] {
  if (Object.keys(projection.entityColumns).length > 0 || Object.keys(projection.beltColumns).length > 0 ||
    Object.keys(projection.entityRemovedFields).length > 0 || Object.keys(projection.beltRemovedFields).length > 0 ||
    projection.changedEntityIds.length !== projection.changedEntities.length ||
    projection.changedBeltIds.length !== projection.changedBelts.length) {
    throw new Error("只有完整记录投影可以分块");
  }
  const entityChunkSize = Math.max(1, Math.floor(options.entityChunkSize ?? 64));
  const beltChunkSize = Math.max(1, Math.floor(options.beltChunkSize ?? 128));
  const empty = (overrides: Partial<SimulationProjection> = {}): SimulationProjection => ({
    ...projection,
    changedEntityIds: [],
    changedBeltIds: [],
    changedEntities: [],
    changedBelts: [],
    entityColumns: {},
    beltColumns: {},
    entityRemovedFields: {},
    beltRemovedFields: {},
    topLevel: {},
    removedEntityIds: [],
    removedBeltIds: [],
    topologyChangedEntityIds: [],
    topologyChangedBeltIds: [],
    alerts: undefined,
    ...overrides,
  });
  const chunks: SimulationProjection[] = [empty({
    topLevel: projection.topLevel,
    removedEntityIds: projection.removedEntityIds,
    removedBeltIds: projection.removedBeltIds,
    topologyChangedEntityIds: projection.topologyChangedEntityIds.filter((id) => projection.removedEntityIds.includes(id)),
    topologyChangedBeltIds: projection.topologyChangedBeltIds.filter((id) => projection.removedBeltIds.includes(id)),
  })];
  const topologyEntityIds = new Set(projection.topologyChangedEntityIds);
  const topologyBeltIds = new Set(projection.topologyChangedBeltIds);
  for (let offset = 0; offset < projection.changedEntities.length; offset += entityChunkSize) {
    const changedEntities = projection.changedEntities.slice(offset, offset + entityChunkSize);
    const changedEntityIds = changedEntities.map((entity) => entity.id);
    chunks.push(empty({
      changedEntities,
      changedEntityIds,
      topologyChangedEntityIds: changedEntityIds.filter((id) => topologyEntityIds.has(id)),
    }));
  }
  for (let offset = 0; offset < projection.changedBelts.length; offset += beltChunkSize) {
    const changedBelts = projection.changedBelts.slice(offset, offset + beltChunkSize);
    const changedBeltIds = changedBelts.map((belt) => belt.id);
    chunks.push(empty({
      changedBelts,
      changedBeltIds,
      topologyChangedBeltIds: changedBeltIds.filter((id) => topologyBeltIds.has(id)),
    }));
  }
  if (projection.alerts) chunks[chunks.length - 1] = { ...chunks[chunks.length - 1], alerts: projection.alerts };
  return chunks.map((chunk, index) => ({ index, total: chunks.length, projection: chunk }));
}

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

function topLevelEntries(state: GameState, includeDeferredTopLevel = false): Array<[string, unknown]> {
  return Object.keys(state)
    .filter((key) => !EXCLUDED_TOP_LEVEL_PROJECTION_KEYS.has(key as keyof GameState) ||
      (includeDeferredTopLevel && DEFERRED_TOP_LEVEL_PROJECTION_KEYS.has(key as keyof GameState)))
    .map((key) => [key, (state as unknown as Record<string, unknown>)[key]]);
}

function captureProjectionField(value: unknown): ProjectionFieldBaseline {
  if (Array.isArray(value)) {
    return { kind: "array", value: value.map(captureProjectionField) };
  }
  if (value !== null && typeof value === "object") {
    const fields = new Map<string, ProjectionFieldBaseline>();
    const source = value as Record<string, unknown>;
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) fields.set(key, captureProjectionField(source[key]));
    }
    return { kind: "object", value: fields };
  }
  return { kind: "primitive", value };
}

/** Compare against a detached value snapshot, then advance that snapshot in
 * place. The baseline never retains a mutable GameState child object. */
function advanceProjectionField(baseline: ProjectionFieldBaseline, value: unknown): boolean {
  if (Array.isArray(value)) {
    if (baseline.kind !== "array") {
      const captured = captureProjectionField(value);
      baseline.kind = captured.kind;
      baseline.value = captured.value;
      return true;
    }
    const values = baseline.value as ProjectionFieldBaseline[];
    const previousLength = values.length;
    let changed = previousLength !== value.length;
    if (values.length > value.length) values.length = value.length;
    for (let index = 0; index < value.length; index += 1) {
      if (index >= previousLength) {
        values.push(captureProjectionField(value[index]));
        continue;
      }
      if (advanceProjectionField(values[index], value[index])) changed = true;
    }
    return changed;
  }
  if (value !== null && typeof value === "object") {
    if (baseline.kind !== "object") {
      const captured = captureProjectionField(value);
      baseline.kind = captured.kind;
      baseline.value = captured.value;
      return true;
    }
    const fields = baseline.value as Map<string, ProjectionFieldBaseline>;
    const source = value as Record<string, unknown>;
    let fieldCount = 0;
    let changed = false;
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      fieldCount += 1;
      const field = fields.get(key);
      if (!field) {
        fields.set(key, captureProjectionField(source[key]));
        changed = true;
      } else if (advanceProjectionField(field, source[key])) {
        changed = true;
      }
    }
    if (fieldCount < fields.size) {
      for (const key of fields.keys()) {
        if (!(key in source)) {
          fields.delete(key);
          changed = true;
        }
      }
    }
    return changed;
  }
  const changed = baseline.kind !== "primitive" || !Object.is(baseline.value, value);
  if (changed) {
    baseline.kind = "primitive";
    baseline.value = value;
  }
  return changed;
}

function captureRecordBaseline<T extends { id: string }>(
  record: T,
  topologySignature: (record: T) => string,
  generation: number,
): ProjectionRecordBaseline {
  const fields = new Map<string, ProjectionFieldBaseline>();
  const source = record as unknown as Record<string, unknown>;
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) fields.set(key, captureProjectionField(source[key]));
  }
  return { fields, topologySignature: topologySignature(record), seenGeneration: generation };
}

const ENTITY_TOPOLOGY_FIELDS = new Set(["planetId", "kind", "buildingId", "resourceId", "position"]);
const BELT_TOPOLOGY_FIELDS = new Set([
  "planetId", "source", "target", "itemId", "tier", "lanes", "stackSize", "priority",
  "targetPortIndex", "routeMode", "routeOffsetY",
]);

interface ProjectionRecordReconcileResult<T> {
  changedIds: string[];
  changedRecords: T[];
  removedIds: string[];
  topologyChangedIds: string[];
  columns: Record<string, Array<[number, unknown]>>;
  removedFields: Record<string, number[]>;
}

function reconcileProjectionRecords<T extends { id: string; planetId: PlanetId }>(
  records: readonly T[],
  activePlanetId: PlanetId,
  snapshots: Map<string, ProjectionRecordBaseline>,
  generation: number,
  compact: boolean,
  topologyFields: ReadonlySet<string>,
  topologySignature: (record: T) => string,
): ProjectionRecordReconcileResult<T> {
  const changedIds: string[] = [];
  const changedRecords: T[] = [];
  const topologyChangedIds: string[] = [];
  let columns: Record<string, Array<[number, unknown]>> = {};
  let removedFields: Record<string, number[]> = {};
  let introducedRecord = false;

  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    if (record.planetId !== activePlanetId) continue;
    const existing = snapshots.get(record.id);
    if (!existing) {
      snapshots.set(record.id, captureRecordBaseline(record, topologySignature, generation));
      changedIds.push(record.id);
      changedRecords.push(record);
      topologyChangedIds.push(record.id);
      introducedRecord = true;
      continue;
    }

    existing.seenGeneration = generation;
    const source = record as unknown as Record<string, unknown>;
    let fieldCount = 0;
    let changed = false;
    let topologyCandidate = false;
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      fieldCount += 1;
      const value = source[key];
      const field = existing.fields.get(key);
      const fieldChanged = field ? advanceProjectionField(field, value) : true;
      if (!field) existing.fields.set(key, captureProjectionField(value));
      if (!fieldChanged) continue;
      changed = true;
      if (topologyFields.has(key)) topologyCandidate = true;
      if (compact) (columns[key] ??= []).push([recordIndex, value]);
    }
    if (fieldCount < existing.fields.size) {
      for (const key of existing.fields.keys()) {
        if (key in source) continue;
        existing.fields.delete(key);
        changed = true;
        if (topologyFields.has(key)) topologyCandidate = true;
        if (compact) (removedFields[key] ??= []).push(recordIndex);
      }
    }
    if (!changed) continue;
    changedIds.push(record.id);
    changedRecords.push(record);
    if (topologyCandidate) {
      const nextTopologySignature = topologySignature(record);
      if (existing.topologySignature !== nextTopologySignature) topologyChangedIds.push(record.id);
      existing.topologySignature = nextTopologySignature;
    }
  }

  const removedIds: string[] = [];
  for (const [id, snapshot] of snapshots) {
    if (snapshot.seenGeneration === generation) continue;
    removedIds.push(id);
    snapshots.delete(id);
  }

  // Record insertion/removal changes global array addressing. Publish complete
  // changed records for this rare barrier instead of mixing stale column
  // offsets with topology changes.
  if (!compact || introducedRecord || removedIds.length > 0) {
    columns = {};
    removedFields = {};
  }
  return {
    changedIds,
    changedRecords: compact && !introducedRecord && removedIds.length === 0 ? [] : changedRecords,
    removedIds,
    topologyChangedIds: [...topologyChangedIds, ...removedIds],
    columns,
    removedFields,
  };
}

function createEmptySimulationProjectionBaseline(activePlanetId: PlanetId): SimulationProjectionBaseline {
  return {
    kind: "simulation-projection-baseline",
    activePlanetId,
    entitySnapshots: new Map(),
    beltSnapshots: new Map(),
    generation: 0,
    topLevelSnapshots: new Map(),
    includesDeferredTopLevel: false,
  };
}

export function captureSimulationProjectionBaseline(
  state: GameState,
  options: { includeDeferredTopLevel?: boolean } = {},
): SimulationProjectionBaseline {
  const baseline = createEmptySimulationProjectionBaseline(state.activePlanetId);
  baseline.generation = 1;
  for (const entity of state.entities) {
    if (entity.planetId === state.activePlanetId) {
      baseline.entitySnapshots.set(entity.id, captureRecordBaseline(entity, entityTopologySignature, baseline.generation));
    }
  }
  for (const belt of state.belts) {
    if (belt.planetId === state.activePlanetId) {
      baseline.beltSnapshots.set(belt.id, captureRecordBaseline(belt, beltTopologySignature, baseline.generation));
    }
  }
  for (const [key, value] of topLevelEntries(state, options.includeDeferredTopLevel)) {
    baseline.topLevelSnapshots.set(key, captureProjectionField(value));
  }
  baseline.includesDeferredTopLevel = options.includeDeferredTopLevel === true;
  return baseline;
}

export function createSimulationProjectionWithBaseline(
  previous: GameState | SimulationProjectionBaseline | null,
  current: GameState,
  options: { compact?: boolean; includeDeferredTopLevel?: boolean } = {},
): { projection: SimulationProjection; baseline: SimulationProjectionBaseline } {
  // Projection work is bounded by the visible planet. Other planets remain in
  // the authoritative state and are rebuilt once if the player switches to them.
  // A supplied baseline is deliberately consumed and advanced: the Worker is
  // its sole owner, so persistent snapshots do not allocate a replacement Map
  // and thousands of complete JSON record strings every simulated second.
  const baseline = previous ? isSimulationProjectionBaseline(previous)
    ? previous
    : captureSimulationProjectionBaseline(previous, options)
    : createEmptySimulationProjectionBaseline(current.activePlanetId);
  const previousActivePlanetId = baseline.activePlanetId;
  baseline.generation += 1;
  const entities = reconcileProjectionRecords(
    current.entities,
    current.activePlanetId,
    baseline.entitySnapshots,
    baseline.generation,
    options.compact === true,
    ENTITY_TOPOLOGY_FIELDS,
    entityTopologySignature,
  );
  const belts = reconcileProjectionRecords(
    current.belts,
    current.activePlanetId,
    baseline.beltSnapshots,
    baseline.generation,
    options.compact === true,
    BELT_TOPOLOGY_FIELDS,
    beltTopologySignature,
  );
  const topLevel = {} as SimulationProjection["topLevel"];
  const projectedTopLevelEntries = topLevelEntries(current, options.includeDeferredTopLevel);
  const projectedTopLevelKeys = new Set(projectedTopLevelEntries.map(([key]) => key));
  for (const [key, value] of projectedTopLevelEntries) {
    const snapshot = baseline.topLevelSnapshots.get(key);
    if (!snapshot) {
      baseline.topLevelSnapshots.set(key, captureProjectionField(value));
      (topLevel as Record<string, unknown>)[key] = value;
    } else if (advanceProjectionField(snapshot, value)) {
      (topLevel as Record<string, unknown>)[key] = value;
    }
  }
  for (const key of baseline.topLevelSnapshots.keys()) {
    if (!projectedTopLevelKeys.has(key)) baseline.topLevelSnapshots.delete(key);
  }
  baseline.activePlanetId = current.activePlanetId;
  baseline.includesDeferredTopLevel = options.includeDeferredTopLevel === true;
  const totalProduced = Object.values(current.totalProduced ?? {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  const projection: SimulationProjection = {
    protocolVersion: 2,
    elapsedSeconds: current.elapsedSeconds,
    activePlanetId: current.activePlanetId,
    changedEntityIds: entities.changedIds,
    changedBeltIds: belts.changedIds,
    changedEntities: entities.changedRecords,
    changedBelts: belts.changedRecords,
    entityColumns: entities.columns,
    beltColumns: belts.columns,
    entityRemovedFields: entities.removedFields,
    beltRemovedFields: belts.removedFields,
    topLevel,
    removedEntityIds: entities.removedIds,
    removedBeltIds: belts.removedIds,
    topologyChangedEntityIds: entities.topologyChangedIds,
    topologyChangedBeltIds: belts.topologyChangedIds,
    requiresFullSnapshot: Boolean(previous && previousActivePlanetId !== current.activePlanetId),
    entityCount: current.entities.length,
    beltCount: current.belts.length,
    inFlightRouteCount: current.entities.reduce((sum, entity) => sum + (entity.stationRoutes?.length ?? 0), 0),
    totalProduced,
  };
  return { projection, baseline };
}

export function createSimulationProjection(
  previous: GameState | SimulationProjectionBaseline | null,
  current: GameState,
  options: { compact?: boolean; includeDeferredTopLevel?: boolean } = {},
): SimulationProjection {
  return createSimulationProjectionWithBaseline(previous, current, options).projection;
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
}

export function createSimulationProjectionStateIndex(state: GameState): SimulationProjectionStateIndex {
  return {
    entities: state.entities,
    belts: state.belts,
  };
}

function applyProjectedRecords<T extends { id: string }>(
  previous: readonly T[],
  changed: readonly T[],
  columns: Record<string, Array<[number, unknown]>>,
  removedFields: Record<string, number[]>,
  removedIds: readonly string[],
): T[] {
  const hasColumns = Object.keys(columns).length > 0 || Object.keys(removedFields).length > 0;
  if (changed.length === 0 && !hasColumns && removedIds.length === 0) {
    return previous as T[];
  }
  if (removedIds.length > 0) {
    const removed = new Set(removedIds);
    const changedById = new Map(changed.map((record) => [record.id, record]));
    const records = previous.flatMap((record) => removed.has(record.id) ? [] : [changedById.get(record.id) ?? record]);
    const existing = new Set(records.map((record) => record.id));
    for (const record of changed) if (!existing.has(record.id)) records.push(record);
    return records;
  }
  const records = [...previous];
  // Steady-state compact projections contain only global array indexes and do
  // not enter this branch. Build an id map only for the rare topology/full-
  // planet publication, then release it with this call.
  let transientIndex: Map<string, number> | null = null;
  for (const record of changed) {
    if (!transientIndex) {
      transientIndex = new Map<string, number>();
      for (let index = 0; index < previous.length; index += 1) transientIndex.set(previous[index].id, index);
    }
    const index = transientIndex.get(record.id);
    if (index === undefined) {
      transientIndex.set(record.id, records.length);
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
  return records;
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
  const entities = applyProjectedRecords(state.entities, projection.changedEntities, projection.entityColumns, projection.entityRemovedFields, removedEntityIds);
  const belts = applyProjectedRecords(state.belts, projection.changedBelts, projection.beltColumns, projection.beltRemovedFields, removedBeltIds);
  const next = {
    ...state,
    ...projection.topLevel,
    elapsedSeconds: projection.elapsedSeconds,
    activePlanetId: projection.activePlanetId,
    entities,
    belts,
  } as GameState;
  return {
    state: next,
    index: {
      entities: next.entities,
      belts: next.belts,
    },
  };
}

function projectedColumnIndexes(
  columns: Record<string, Array<[number, unknown]>>,
  removedFields: Record<string, number[]>,
): number[] {
  const indexes = new Set<number>();
  for (const values of Object.values(columns)) for (const [index] of values) indexes.add(index);
  for (const values of Object.values(removedFields)) for (const index of values) indexes.add(index);
  return [...indexes];
}

/** Converts a compact Worker projection into the full changed records expected by the canvas cache. */
export function hydrateSimulationProjection(
  projection: SimulationProjection,
  state: GameState,
  _index: SimulationProjectionStateIndex,
): SimulationProjection {
  if (Object.keys(projection.entityColumns).length === 0 && Object.keys(projection.beltColumns).length === 0 &&
    Object.keys(projection.entityRemovedFields).length === 0 && Object.keys(projection.beltRemovedFields).length === 0) return projection;
  const entityIndexes = projectedColumnIndexes(projection.entityColumns, projection.entityRemovedFields);
  const beltIndexes = projectedColumnIndexes(projection.beltColumns, projection.beltRemovedFields);
  const changedEntities = entityIndexes.length > 0
    ? entityIndexes.flatMap((recordIndex) => state.entities[recordIndex] ? [state.entities[recordIndex]] : [])
    : projection.changedEntities;
  const changedBelts = beltIndexes.length > 0
    ? beltIndexes.flatMap((recordIndex) => state.belts[recordIndex] ? [state.belts[recordIndex]] : [])
    : projection.changedBelts;
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
