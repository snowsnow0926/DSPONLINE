import type { SimulationProjection } from "./simulationProjection";
import type { BeltConnection, FactoryEntity, GameState, PlanetId } from "./types";

function synchronizeRenderRecord<T extends { id: string }>(target: T, source: T): T {
  const writable = target as unknown as Record<string, unknown>;
  const incoming = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(writable)) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) delete writable[key];
  }
  Object.assign(target, source);
  return target;
}

interface CachedRecordProjection<T> {
  records: T[];
  byId: ReadonlyMap<string, T>;
}

/**
 * Owns the mutable records used only by the canvas renderer. React can retain
 * interrupted render trees, so each publication must point those trees at the
 * same bounded set of wrappers instead of retaining another complete runtime
 * projection. Authoritative GameState records are copied before any mutation.
 */
export class CanvasRenderRecordCache {
  private readonly entityById = new Map<string, FactoryEntity>();
  private readonly beltById = new Map<string, BeltConnection>();

  private synchronizeAll<T extends { id: string }>(
    cache: Map<string, T>,
    source: readonly T[],
    previous: readonly T[] | null,
  ): CachedRecordProjection<T> {
    const activeIds = new Set<string>();
    const next = new Array<T>(source.length);
    let orderStable = Boolean(previous && previous.length === source.length);
    for (let index = 0; index < source.length; index += 1) {
      const incoming = source[index];
      activeIds.add(incoming.id);
      const cached = cache.get(incoming.id);
      const projected = cached
        ? synchronizeRenderRecord(cached, incoming)
        : { ...incoming };
      if (!cached) cache.set(incoming.id, projected);
      next[index] = projected;
      if (orderStable && previous![index] !== projected) orderStable = false;
    }
    for (const id of cache.keys()) {
      if (!activeIds.has(id)) cache.delete(id);
    }
    return {
      records: orderStable ? previous as T[] : next,
      byId: cache,
    };
  }

  private synchronizeChanges<T extends { id: string }>(
    cache: Map<string, T>,
    previous: readonly T[],
    changed: readonly T[],
    removedIds: readonly string[],
  ): CachedRecordProjection<T> {
    let membershipChanged = removedIds.length > 0;
    const added: T[] = [];
    for (const incoming of changed) {
      const cached = cache.get(incoming.id);
      if (cached) {
        synchronizeRenderRecord(cached, incoming);
      } else {
        const projected = { ...incoming };
        cache.set(incoming.id, projected);
        added.push(projected);
        membershipChanged = true;
      }
    }
    if (!membershipChanged) return { records: previous as T[], byId: cache };

    const removed = new Set(removedIds);
    for (const id of removed) cache.delete(id);
    const next = previous.filter((record) => !removed.has(record.id));
    next.push(...added);
    return { records: next, byId: cache };
  }

  replaceAll(
    entities: readonly FactoryEntity[],
    belts: readonly BeltConnection[],
    previous?: Pick<CanvasRenderSnapshot, "game"> | null,
  ): { entities: CachedRecordProjection<FactoryEntity>; belts: CachedRecordProjection<BeltConnection> } {
    return {
      entities: this.synchronizeAll(this.entityById, entities, previous?.game.entities ?? null),
      belts: this.synchronizeAll(this.beltById, belts, previous?.game.belts ?? null),
    };
  }

  applyChanges(
    previous: CanvasRenderSnapshot,
    changedEntities: readonly FactoryEntity[],
    removedEntityIds: readonly string[],
    changedBelts: readonly BeltConnection[],
    removedBeltIds: readonly string[],
  ): { entities: CachedRecordProjection<FactoryEntity>; belts: CachedRecordProjection<BeltConnection> } {
    return {
      entities: this.synchronizeChanges(this.entityById, previous.game.entities, changedEntities, removedEntityIds),
      belts: this.synchronizeChanges(this.beltById, previous.game.belts, changedBelts, removedBeltIds),
    };
  }

  get entityCount(): number {
    return this.entityById.size;
  }

  get beltCount(): number {
    return this.beltById.size;
  }
}

export interface CanvasRenderSnapshot {
  /** A shallow, read-only GameState view whose entity/belt arrays contain only the active planet. */
  game: GameState;
  planetId: PlanetId;
  entityById: ReadonlyMap<string, FactoryEntity>;
  beltById: ReadonlyMap<string, BeltConnection>;
  topologyRevision: number;
  runtimeRevision: number;
  /** Internal bounded cache shared by all render versions in this canvas session. */
  recordCache: CanvasRenderRecordCache;
}

export interface CanvasRenderSnapshotResult {
  snapshot: CanvasRenderSnapshot;
  fullRebuild: boolean;
  topologyChanged: boolean;
  changedEntityCount: number;
  changedBeltCount: number;
}

function activeEntities(state: GameState, planetId: PlanetId): FactoryEntity[] {
  return state.entities.filter((entity) => entity.planetId === planetId);
}

function activeBelts(state: GameState, planetId: PlanetId): BeltConnection[] {
  return state.belts.filter((belt) => belt.planetId === planetId);
}

function createScopedGame(state: GameState, planetId: PlanetId, entities: FactoryEntity[], belts: BeltConnection[]): GameState {
  return { ...state, activePlanetId: planetId, entities, belts };
}

function sameEntityTopology(previous: readonly FactoryEntity[], next: readonly FactoryEntity[]): boolean {
  if (previous.length !== next.length) return false;
  const byId = new Map(previous.map((entity) => [entity.id, entity]));
  return next.every((entity) => {
    const before = byId.get(entity.id);
    return Boolean(before && before.planetId === entity.planetId && before.kind === entity.kind &&
      before.buildingId === entity.buildingId && before.resourceId === entity.resourceId &&
      before.position.x === entity.position.x && before.position.y === entity.position.y &&
      before.interactionLocked === entity.interactionLocked);
  });
}

function sameBeltTopology(previous: readonly BeltConnection[], next: readonly BeltConnection[]): boolean {
  if (previous.length !== next.length) return false;
  const byId = new Map(previous.map((belt) => [belt.id, belt]));
  return next.every((belt) => {
    const before = byId.get(belt.id);
    return Boolean(before && before.planetId === belt.planetId && before.source === belt.source && before.target === belt.target &&
      before.itemId === belt.itemId && before.tier === belt.tier && before.lanes === belt.lanes &&
      (before.stackSize ?? 1) === (belt.stackSize ?? 1) && before.priority === belt.priority &&
      before.targetPortIndex === belt.targetPortIndex && (before.routeMode ?? "auto") === (belt.routeMode ?? "auto") &&
      (before.routeOffsetY ?? 0) === (belt.routeOffsetY ?? 0));
  });
}

export function createCanvasRenderSnapshot(
  state: GameState,
  planetId: PlanetId = state.activePlanetId,
  recordCache = new CanvasRenderRecordCache(),
): CanvasRenderSnapshot {
  const sourceEntities = activeEntities(state, planetId);
  const sourceBelts = activeBelts(state, planetId);
  const projected = recordCache.replaceAll(sourceEntities, sourceBelts);
  return {
    game: createScopedGame(state, planetId, projected.entities.records, projected.belts.records),
    planetId,
    entityById: projected.entities.byId,
    beltById: projected.belts.byId,
    topologyRevision: 1,
    runtimeRevision: 1,
    recordCache,
  };
}

/**
 * Publishes a lightweight render-only view. Incremental projection records are
 * never used as gameplay input and cannot be written back to the authoritative state.
 */
export function reconcileCanvasRenderSnapshot(
  previous: CanvasRenderSnapshot | null,
  state: GameState,
  projection: SimulationProjection | null,
  options: { force?: boolean; enabled?: boolean } = {},
): CanvasRenderSnapshotResult {
  const enabled = options.enabled !== false;
  const planetId = state.activePlanetId;
  const mustRebuild = !previous || options.force || !enabled || !projection || projection.protocolVersion !== 2 ||
    projection.requiresFullSnapshot || previous.planetId !== planetId || projection.activePlanetId !== planetId;
  if (mustRebuild) {
    if (!enabled) {
      const entities = activeEntities(state, planetId);
      const belts = activeBelts(state, planetId);
      return {
        snapshot: {
          game: state,
          planetId,
          entityById: new Map(entities.map((entity) => [entity.id, entity])),
          beltById: new Map(belts.map((belt) => [belt.id, belt])),
          topologyRevision: (previous?.topologyRevision ?? 0) + 1,
          runtimeRevision: (previous?.runtimeRevision ?? 0) + 1,
          recordCache: previous?.recordCache ?? new CanvasRenderRecordCache(),
        },
        fullRebuild: true,
        topologyChanged: true,
        changedEntityCount: entities.length,
        changedBeltCount: belts.length,
      };
    }
    const sourceEntities = activeEntities(state, planetId);
    const sourceBelts = activeBelts(state, planetId);
    const topologyChanged = !previous || previous.planetId !== planetId ||
      !sameEntityTopology(previous.game.entities, sourceEntities) || !sameBeltTopology(previous.game.belts, sourceBelts);
    const recordCache = previous?.recordCache ?? new CanvasRenderRecordCache();
    const projected = recordCache.replaceAll(sourceEntities, sourceBelts, previous);
    const next: CanvasRenderSnapshot = {
      game: createScopedGame(state, planetId, projected.entities.records, projected.belts.records),
      planetId,
      entityById: projected.entities.byId,
      beltById: projected.belts.byId,
      topologyRevision: (previous?.topologyRevision ?? 1) + (previous && topologyChanged ? 1 : 0),
      runtimeRevision: (previous?.runtimeRevision ?? 0) + 1,
      recordCache,
    };
    return {
      snapshot: next,
      fullRebuild: true,
      topologyChanged,
      changedEntityCount: next.game.entities.length,
      changedBeltCount: next.game.belts.length,
    };
  }

  const topologyChanged = projection.topologyChangedEntityIds.length > 0 || projection.topologyChangedBeltIds.length > 0;
  const projected = topologyChanged
    ? previous.recordCache.replaceAll(activeEntities(state, planetId), activeBelts(state, planetId), previous)
    : previous.recordCache.applyChanges(
      previous,
      projection.changedEntities,
      projection.removedEntityIds,
      projection.changedBelts,
      projection.removedBeltIds,
    );
  return {
    snapshot: {
      game: createScopedGame(state, planetId, projected.entities.records, projected.belts.records),
      planetId,
      entityById: projected.entities.byId,
      beltById: projected.belts.byId,
      topologyRevision: previous.topologyRevision + (topologyChanged ? 1 : 0),
      runtimeRevision: previous.runtimeRevision + 1,
      recordCache: previous.recordCache,
    },
    fullRebuild: false,
    topologyChanged,
    changedEntityCount: projection.changedEntities.length + projection.removedEntityIds.length,
    changedBeltCount: projection.changedBelts.length + projection.removedBeltIds.length,
  };
}
