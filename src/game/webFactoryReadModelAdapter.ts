import { PLANETS } from "./content";
import type { PlanetDefinition, PlanetDisplayMetadata, PlanetId, GameState } from "./types";
import {
  FACTORY_READ_MODEL_LIMITS,
  FACTORY_READ_MODEL_SCHEMA,
  type BoundedReadModelRows,
  type ConstructionJobReadModel,
  type ConstructionQueueRowReadModel,
  type ConstructionReservationReadModel,
  type ConstructionSummaryReadModel,
  type ConstructionTargetReadModel,
  type FactoryConstructionHeadlineReadModel,
  type FactoryConstructionWorkspaceReadModel,
  type FactoryInspectorSummaryReadModel,
  type FactoryMultiSelectionSummaryReadModel,
  type FactoryReadModelBundle,
  type FactoryReadModelRequest,
  type FactoryRunStatusReadModel,
  type FactorySelectionToolbarReadModel,
  type FactorySelectionReadModel,
  type FactoryShellReadModel,
  type FactoryViewportBeltReadModel,
  type FactoryViewportReadModel,
  type FactoryViewportReadModelRequest,
  type ItemQuantityReadModel,
  type PlanetNavigationReadModel,
  type PlanetNavigationRowReadModel,
  type SelectedBeltReadModel,
  type SelectedEntityReadModel,
} from "./factoryReadModels";

type NumericRecord = Readonly<Record<string, number | undefined>>;

function compareOpaqueIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedRows<Row>(rows: readonly Row[], totalCount: number, limit: number): BoundedReadModelRows<Row> {
  const bounded = rows.length > limit ? rows.slice(0, limit) : [...rows];
  return {
    rows: bounded,
    totalCount,
    truncated: totalCount > bounded.length,
  };
}

function numericRecordRows(record: NumericRecord | undefined, limit: number): BoundedReadModelRows<ItemQuantityReadModel> {
  const rows = Object.entries(record ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort(([left], [right]) => compareOpaqueIds(left, right))
    .map(([itemId, amount]) => ({ itemId, amount }));
  return boundedRows(rows, rows.length, limit);
}

function uniquePrefix(ids: readonly string[] | undefined, limit: number): string[] {
  if (!ids?.length) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= limit) break;
  }
  return result;
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

interface PlanetCounts {
  readonly entityCounts: ReadonlyMap<string, number>;
  readonly deviceCounts: ReadonlyMap<string, number>;
  readonly beltCounts: ReadonlyMap<string, number>;
  readonly queueCounts: ReadonlyMap<string, number>;
}

function collectPlanetCounts(state: GameState): PlanetCounts {
  const entityCounts = new Map<string, number>();
  const deviceCounts = new Map<string, number>();
  const beltCounts = new Map<string, number>();
  const queueCounts = new Map<string, number>();
  for (const entity of state.entities) {
    incrementCount(entityCounts, entity.planetId);
    deviceCounts.set(
      entity.planetId,
      (deviceCounts.get(entity.planetId) ?? 0) + entity.machineCount + entity.minerCount,
    );
  }
  for (const belt of state.belts) incrementCount(beltCounts, belt.planetId);
  for (const entry of state.constructionQueue) incrementCount(queueCounts, entry.planetId);
  return { entityCounts, deviceCounts, beltCounts, queueCounts };
}

export function createFactoryShellReadModel(state: GameState, counts = collectPlanetCounts(state)): FactoryShellReadModel {
  return {
    schema: FACTORY_READ_MODEL_SCHEMA,
    source: "web-game-state",
    stateVersion: state.version,
    mode: state.mode,
    activePlanetId: state.activePlanetId,
    paused: state.paused,
    elapsedSeconds: state.elapsedSeconds,
    simulationSpeed: state.settings.simulationSpeed,
    timeWarp: {
      controllerEntityId: state.timeWarp.controllerEntityId,
      enabled: state.timeWarp.enabled,
      requestedMultiplier: state.timeWarp.requestedMultiplier,
      effectiveMultiplier: state.timeWarp.effectiveMultiplier,
      requiredPowerKw: state.timeWarp.requiredPowerKw,
      allocatedPowerKw: state.timeWarp.allocatedPowerKw,
    },
    entityCount: state.entities.length,
    beltCount: state.belts.length,
    activePlanetEntityCount: counts.entityCounts.get(state.activePlanetId) ?? 0,
    activePlanetBeltCount: counts.beltCounts.get(state.activePlanetId) ?? 0,
    constructionQueueCount: state.constructionQueue.length,
  };
}

/**
 * Constant-time Web/PWA adapter for the visible run-state chip. Keeping this
 * separate from the complete bundle avoids scanning every entity and belt on
 * each running-frame publication while preserving the same read-model schema.
 */
export function createWebFactoryRunStatusReadModel(state: GameState): FactoryRunStatusReadModel {
  return {
    schema: FACTORY_READ_MODEL_SCHEMA,
    source: "web-game-state",
    revision: null,
    activePlanetId: state.activePlanetId,
    paused: state.paused,
  };
}

/**
 * Web/PWA fallback for the visible desktop selection toolbar.
 *
 * Preserve the legacy UI semantics exactly: the node badge reflects the raw
 * React selection list, while belt and lock actions include only records that
 * still exist on the active planet. Native selection rows are intentionally
 * selected in a separate fail-closed bridge.
 */
export function createWebFactorySelectionToolbarReadModel(
  state: GameState,
  selectedEntityIds: readonly string[],
  selectedBeltIds: readonly string[],
): FactorySelectionToolbarReadModel {
  const selectedEntityIdSet = new Set(selectedEntityIds);
  const selectedBeltIdSet = new Set(selectedBeltIds);
  let selectedBeltCount = 0;
  let canLock = false;
  let canUnlock = false;
  for (const entity of state.entities) {
    if (entity.planetId !== state.activePlanetId || !selectedEntityIdSet.has(entity.id)) continue;
    if (entity.interactionLocked) canUnlock = true;
    else canLock = true;
  }
  for (const belt of state.belts) {
    if (belt.planetId === state.activePlanetId && selectedBeltIdSet.has(belt.id)) selectedBeltCount += 1;
  }
  return {
    schema: FACTORY_READ_MODEL_SCHEMA,
    source: "web-game-state",
    revision: null,
    activePlanetId: state.activePlanetId,
    projectionIdentity: null,
    selectedCount: selectedEntityIds.length,
    selectedBeltCount,
    canLock,
    canUnlock,
  };
}

/** Constant-time Web/PWA projection for the blueprint construction headline. */
export function createWebFactoryConstructionHeadlineReadModel(
  state: GameState,
): FactoryConstructionHeadlineReadModel {
  const planetId = state.activePlanetId;
  const definition = (PLANETS as Readonly<Record<string, PlanetDefinition | undefined>>)[planetId];
  return {
    schema: FACTORY_READ_MODEL_SCHEMA,
    source: "web-game-state",
    revision: null,
    activePlanetId: planetId,
    activePlanetDisplayName: definition?.name || planetId,
    constructionQueueCount: state.constructionQueue.length,
  };
}

export function createPlanetNavigationReadModel(state: GameState, counts = collectPlanetCounts(state)): PlanetNavigationReadModel {
  const definitions = PLANETS as Readonly<Record<string, PlanetDefinition | undefined>>;
  const officialIds = Object.keys(PLANETS);
  const officialOrder = new Map(officialIds.map((id, index) => [id, index] as const));
  const candidateIds = new Set<string>(officialIds);
  candidateIds.add(state.activePlanetId);
  for (const id of Object.keys(state.galaxy.profiles)) candidateIds.add(id);
  for (const id of state.exploration.colonizedPlanetIds) candidateIds.add(id);
  for (const id of counts.entityCounts.keys()) candidateIds.add(id);
  for (const id of counts.beltCounts.keys()) candidateIds.add(id);
  for (const id of counts.queueCounts.keys()) candidateIds.add(id);

  const unlockedSystems = new Set<string>(state.exploration.unlockedSystemIds);
  const colonizedPlanets = new Set<string>(state.exploration.colonizedPlanetIds);
  const metadata = state.galaxy.planetMetadata as Readonly<Record<string, PlanetDisplayMetadata | undefined>>;
  const roles = state.galaxy.planetRoles as Readonly<Record<string, string | undefined>>;
  const rows: PlanetNavigationRowReadModel[] = [...candidateIds]
    .sort((left, right) => {
      const leftOrder = officialOrder.get(left);
      const rightOrder = officialOrder.get(right);
      if (leftOrder !== undefined || rightOrder !== undefined) {
        if (leftOrder === undefined) return 1;
        if (rightOrder === undefined) return -1;
        return leftOrder - rightOrder;
      }
      return compareOpaqueIds(left, right);
    })
    .map((planetId) => {
      const definition = definitions[planetId];
      const customName = metadata[planetId]?.customName;
      return {
        planetId,
        systemId: definition?.systemId ?? null,
        displayName: customName || definition?.name || planetId,
        code: definition?.code ?? planetId,
        active: planetId === state.activePlanetId,
        discovered: planetId === state.activePlanetId || Boolean(definition && unlockedSystems.has(definition.systemId)),
        colonized: colonizedPlanets.has(planetId),
        role: roles[planetId] ?? null,
        entityCount: counts.entityCounts.get(planetId) ?? 0,
        deviceCount: counts.deviceCounts.get(planetId) ?? 0,
        beltCount: counts.beltCounts.get(planetId) ?? 0,
        constructionQueueCount: counts.queueCounts.get(planetId) ?? 0,
        powerFactor: state.planetMetrics[planetId as PlanetId]?.powerFactor ?? 1,
      };
    });
  return {
    schema: FACTORY_READ_MODEL_SCHEMA,
    activePlanetId: state.activePlanetId,
    planets: boundedRows(rows, rows.length, FACTORY_READ_MODEL_LIMITS.planetRows),
  };
}

function selectedEntityRow(entity: GameState["entities"][number]): SelectedEntityReadModel {
  return {
    entityId: entity.id,
    planetId: entity.planetId,
    kind: entity.kind,
    position: { x: entity.position.x, y: entity.position.y },
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
    inputItems: numericRecordRows(entity.inputs as NumericRecord, FACTORY_READ_MODEL_LIMITS.itemRows),
    outputItems: numericRecordRows(entity.outputs as NumericRecord, FACTORY_READ_MODEL_LIMITS.itemRows),
    stationConfiguration: null,
  };
}

function selectedBeltRow(belt: GameState["belts"][number]): SelectedBeltReadModel {
  return {
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
  };
}

/**
 * Web/PWA fallback for the mobile and desktop inspectors' live display fields.
 *
 * The caller already owns the selected records, so this adapter performs no
 * factory-wide lookup. Entity display takes precedence over a belt exactly as
 * the existing mobile inspector does. Interactive controls continue receiving
 * the original GameState records separately.
 */
export function createWebFactoryInspectorSummaryReadModel(
  state: GameState,
  selectedEntity: GameState["entities"][number] | null,
  selectedBelt: GameState["belts"][number] | null,
): FactoryInspectorSummaryReadModel {
  const entity = selectedEntity?.planetId === state.activePlanetId
    ? selectedEntityRow(selectedEntity)
    : null;
  const belt = !entity && selectedBelt?.planetId === state.activePlanetId
    ? selectedBeltRow(selectedBelt)
    : null;
  return {
    schema: FACTORY_READ_MODEL_SCHEMA,
    source: "web-game-state",
    revision: null,
    activePlanetId: state.activePlanetId,
    entity,
    belt,
  };
}

/**
 * Web fallback and semantic reference for the desktop multi-selection summary.
 * The caller supplies its already-selected records, avoiding another scan of a
 * potentially huge factory. Rows retain the exact ordered native request IDs.
 */
export function createWebFactoryMultiSelectionSummaryReadModel(
  state: GameState,
  selectedEntities: readonly GameState["entities"][number][],
  selectedBelts: readonly GameState["belts"][number][],
  request: Pick<FactoryReadModelRequest, "selectedEntityIds" | "selectedBeltIds">,
): FactoryMultiSelectionSummaryReadModel {
  const requestedEntityIds = request.selectedEntityIds ?? [];
  const requestedBeltIds = request.selectedBeltIds ?? [];
  const entityIds = uniquePrefix(requestedEntityIds, FACTORY_READ_MODEL_LIMITS.selectedEntityRows);
  const beltIds = uniquePrefix(requestedBeltIds, FACTORY_READ_MODEL_LIMITS.selectedBeltRows);
  const entitiesById = new Map(selectedEntities
    .filter((entity) => entity.planetId === state.activePlanetId)
    .map((entity) => [entity.id, entity] as const));
  const beltsById = new Map(selectedBelts
    .filter((belt) => belt.planetId === state.activePlanetId)
    .map((belt) => [belt.id, belt] as const));
  const entityRows = entityIds.flatMap((id) => {
    const entity = entitiesById.get(id);
    return entity ? [selectedEntityRow(entity)] : [];
  });
  const beltRows = beltIds.flatMap((id) => {
    const belt = beltsById.get(id);
    return belt ? [selectedBeltRow(belt)] : [];
  });
  return {
    schema: FACTORY_READ_MODEL_SCHEMA,
    source: "web-game-state",
    revision: null,
    activePlanetId: state.activePlanetId,
    projectionIdentity: null,
    requestedEntityCount: requestedEntityIds.length,
    requestedBeltCount: requestedBeltIds.length,
    entityRows: {
      rows: entityRows,
      totalCount: entityRows.length,
      truncated: requestedEntityIds.length > entityIds.length,
    },
    beltRows: {
      rows: beltRows,
      totalCount: beltRows.length,
      truncated: requestedBeltIds.length > beltIds.length,
    },
  };
}

export function createFactorySelectionReadModel(
  state: GameState,
  request: FactoryReadModelRequest = {},
): FactorySelectionReadModel {
  const entityIds = uniquePrefix(request.selectedEntityIds, FACTORY_READ_MODEL_LIMITS.selectedEntityRows);
  const beltIds = uniquePrefix(request.selectedBeltIds, FACTORY_READ_MODEL_LIMITS.selectedBeltRows);
  const requestedEntityIds = new Set(entityIds);
  const requestedBeltIds = new Set(beltIds);
  const entitiesById = new Map(state.entities
    .filter((entity) => requestedEntityIds.has(entity.id))
    .map((entity) => [entity.id, entity] as const));
  const beltsById = new Map(state.belts
    .filter((belt) => requestedBeltIds.has(belt.id))
    .map((belt) => [belt.id, belt] as const));
  const entityRows = entityIds.flatMap((id) => {
    const entity = entitiesById.get(id);
    return entity ? [selectedEntityRow(entity)] : [];
  });
  const beltRows = beltIds.flatMap((id) => {
    const belt = beltsById.get(id);
    return belt ? [selectedBeltRow(belt)] : [];
  });
  const entityRowModel = boundedRows(entityRows, entityRows.length, FACTORY_READ_MODEL_LIMITS.selectedEntityRows);
  const beltRowModel = boundedRows(beltRows, beltRows.length, FACTORY_READ_MODEL_LIMITS.selectedBeltRows);
  return {
    schema: FACTORY_READ_MODEL_SCHEMA,
    activePlanetId: state.activePlanetId,
    requestedEntityCount: request.selectedEntityIds?.length ?? 0,
    requestedBeltCount: request.selectedBeltIds?.length ?? 0,
    entityRows: request.selectedEntityIds && request.selectedEntityIds.length > entityIds.length
      ? { ...entityRowModel, truncated: true }
      : entityRowModel,
    beltRows: request.selectedBeltIds && request.selectedBeltIds.length > beltIds.length
      ? { ...beltRowModel, truncated: true }
      : beltRowModel,
  };
}

function constructionReservationRows(record: NumericRecord | undefined): BoundedReadModelRows<ConstructionReservationReadModel> {
  const rows = Object.entries(record ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort(([left], [right]) => compareOpaqueIds(left, right))
    .map(([constructionId, amount]) => ({ constructionId, amount }));
  return boundedRows(rows, rows.length, FACTORY_READ_MODEL_LIMITS.constructionReservationRows);
}

function constructionQueueRows(state: GameState): BoundedReadModelRows<ConstructionQueueRowReadModel> {
  const rows = [...state.constructionQueue]
    .sort((left, right) => left.queuedAt - right.queuedAt || compareOpaqueIds(left.id, right.id))
    .map((entry): ConstructionQueueRowReadModel => ({
      queueId: entry.id,
      blueprintId: entry.blueprintId,
      blueprintVersionId: entry.blueprintVersionId ?? null,
      blueprintRevision: entry.blueprintRevision ?? null,
      blueprintName: entry.blueprintName,
      planetId: entry.planetId,
      queuedAt: entry.queuedAt,
      status: entry.status ?? "pending-materials",
      rotation: entry.rotation,
      mirror: entry.mirror,
      placedEntityCount: Object.keys(entry.placedEntityIdsByKey ?? {}).length,
      reservedConstruction: constructionReservationRows(entry.reservedConstruction as NumericRecord | undefined),
      reservedFleet: numericRecordRows(entry.reservedFleet as NumericRecord | undefined, FACTORY_READ_MODEL_LIMITS.constructionReservationRows),
    }));
  return boundedRows(rows, rows.length, FACTORY_READ_MODEL_LIMITS.constructionQueueRows);
}

function constructionTargetRows(state: GameState): BoundedReadModelRows<ConstructionTargetReadModel> {
  const rows = Object.entries(state.constructionAutomation.targetStock as NumericRecord)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort(([left], [right]) => compareOpaqueIds(left, right))
    .map(([targetId, amount]) => ({ targetId, amount }));
  return boundedRows(rows, rows.length, FACTORY_READ_MODEL_LIMITS.constructionTargetRows);
}

function constructionJobRows(state: GameState): BoundedReadModelRows<ConstructionJobReadModel> {
  const rows = Object.entries(state.constructionAutomation.jobs)
    .sort(([left], [right]) => compareOpaqueIds(left, right))
    .map(([entityId, job]): ConstructionJobReadModel => ({
      entityId,
      constructionId: job.constructionId,
      stepIndex: job.stepIndex,
      stepCount: job.steps.length,
      elapsedSeconds: job.elapsedSeconds,
      inventory: numericRecordRows(job.inventory as NumericRecord, FACTORY_READ_MODEL_LIMITS.itemRows),
    }));
  return boundedRows(rows, rows.length, FACTORY_READ_MODEL_LIMITS.constructionJobRows);
}

export function createConstructionSummaryReadModel(state: GameState): ConstructionSummaryReadModel {
  return {
    schema: FACTORY_READ_MODEL_SCHEMA,
    activePlanetId: state.activePlanetId,
    queue: constructionQueueRows(state),
    automation: {
      enabled: state.constructionAutomation.enabled,
      quantumSourceEnabled: state.constructionAutomation.quantumSourceEnabled === true,
      totalCrafted: state.constructionAutomation.totalCrafted,
      lastCraftedId: state.constructionAutomation.lastCraftedId ?? null,
      targets: constructionTargetRows(state),
      jobs: constructionJobRows(state),
      destroyedByproducts: numericRecordRows(
        state.constructionAutomation.destroyedByproducts as NumericRecord,
        FACTORY_READ_MODEL_LIMITS.itemRows,
      ),
    },
  };
}

/**
 * Full Web/PWA fallback for the construction-center and pending-blueprint
 * read-only display. Commands and eligibility checks continue to use
 * GameState directly in the owning workspaces.
 */
export function createWebFactoryConstructionWorkspaceReadModel(
  state: GameState,
): FactoryConstructionWorkspaceReadModel {
  return {
    ...createConstructionSummaryReadModel(state),
    source: "web-game-state",
    revision: null,
  };
}

function viewportPointInside(
  position: Readonly<{ x: number; y: number }>,
  bounds: FactoryViewportReadModelRequest["bounds"],
): boolean {
  return position.x >= bounds.minX && position.x <= bounds.maxX &&
    position.y >= bounds.minY && position.y <= bounds.maxY;
}

function viewportWorldBounds(
  entities: readonly GameState["entities"][number][],
): FactoryViewportReadModel["worldBounds"] {
  if (entities.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = entities[0].position.x;
  let minY = entities[0].position.y;
  let maxX = minX;
  let maxY = minY;
  for (let index = 1; index < entities.length; index += 1) {
    const position = entities[index].position;
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x);
    maxY = Math.max(maxY, position.y);
  }
  return { minX, minY, maxX, maxY };
}

function viewportBeltRow(belt: GameState["belts"][number]): FactoryViewportBeltReadModel {
  return {
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
  };
}

/** Complete Web fallback and same-revision semantic oracle for viewport-v2. */
export function createWebFactoryViewportReadModel(
  state: GameState,
  request: FactoryViewportReadModelRequest,
): FactoryViewportReadModel {
  const planetEntities = state.entities.filter((entity) => entity.planetId === request.planetId);
  const planetBelts = state.belts.filter((belt) => belt.planetId === request.planetId);
  const entityById = new Map(planetEntities.map((entity) => [entity.id, entity] as const));
  const beltById = new Map(planetBelts.map((belt) => [belt.id, belt] as const));
  const visibleEntityIds = new Set(planetEntities
    .filter((entity) => viewportPointInside(entity.position, request.bounds))
    .map((entity) => entity.id));
  const pinnedEntityIds = request.pinnedEntityIds.filter((id) => entityById.has(id));
  const pinnedBeltIds = request.pinnedBeltIds.filter((id) => beltById.has(id));
  const beltSourceEntityIds = new Set([...visibleEntityIds, ...pinnedEntityIds]);
  const ordinaryBelts = planetBelts.filter((belt) =>
    beltSourceEntityIds.has(belt.source) || beltSourceEntityIds.has(belt.target));
  const ordinaryBeltIds = new Set(ordinaryBelts.map((belt) => belt.id));
  return {
    schema: "factory-viewport-read-model-v1",
    source: "web-game-state",
    revision: null,
    planetId: request.planetId,
    bounds: { ...request.bounds },
    pinnedEntityIds,
    pinnedBeltIds,
    planetTotals: { entities: planetEntities.length, belts: planetBelts.length },
    viewportTotals: { entities: visibleEntityIds.size, belts: ordinaryBelts.length },
    worldBounds: viewportWorldBounds(planetEntities),
    entities: planetEntities
      .filter((entity) => visibleEntityIds.has(entity.id) || pinnedEntityIds.includes(entity.id))
      .map((entity) => ({
        id: entity.id,
        kind: entity.kind,
        buildingId: entity.buildingId ?? null,
        x: entity.position.x,
        y: entity.position.y,
      })),
    belts: planetBelts
      .filter((belt) => ordinaryBeltIds.has(belt.id) || pinnedBeltIds.includes(belt.id))
      .map(viewportBeltRow),
    broadQueryFallback: false,
  };
}

/** Pure Web/PWA fallback until the same contracts are supplied by native projection channels. */
export function createWebFactoryReadModels(
  state: GameState,
  request: FactoryReadModelRequest = {},
): FactoryReadModelBundle {
  const counts = collectPlanetCounts(state);
  return {
    shell: createFactoryShellReadModel(state, counts),
    planetNavigation: createPlanetNavigationReadModel(state, counts),
    selection: createFactorySelectionReadModel(state, request),
    construction: createConstructionSummaryReadModel(state),
  };
}
