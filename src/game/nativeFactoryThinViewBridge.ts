import type {
  BoundedReadModelRows,
  ConstructionJobReadModel,
  ConstructionQueueRowReadModel,
  ConstructionReservationReadModel,
  ConstructionTargetReadModel,
  FactoryConstructionHeadlineReadModel,
  FactoryConstructionWorkspaceReadModel,
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  FactoryRunStatusReadModel,
  FactorySelectionToolbarReadModel,
  ItemQuantityReadModel,
  PlanetNavigationReadModel,
  PlanetNavigationRowReadModel,
  SelectedBeltReadModel,
  SelectedEntityReadModel,
} from "./factoryReadModels";
import { FACTORY_READ_MODEL_LIMITS } from "./factoryReadModels";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";

/**
 * Chooses a native run-state chip only from a complete, current atomic frame.
 * Any loading, stale, superseded, mismatched or unavailable native frame keeps
 * the existing Web read model visible with no semantic downgrade.
 */
export function selectFactoryRunStatusReadModel(
  web: FactoryRunStatusReadModel,
  native: NativeFactoryThinViewSnapshot,
  expectedRevision: number,
): FactoryRunStatusReadModel {
  const frame = native.status === "ready" && native.requestedRevision === expectedRevision
    ? native.frame
    : null;
  const shell = frame?.factory.shell;
  if (!frame || frame.revision !== expectedRevision || !shell ||
    shell.source !== "native-core" || shell.activePlanetId !== web.activePlanetId ||
    shell.paused !== web.paused) {
    return web;
  }
  return Object.freeze({
    schema: "factory-read-model-v1",
    source: "native-core",
    revision: expectedRevision,
    activePlanetId: shell.activePlanetId,
    paused: shell.paused,
  });
}

export interface FactorySelectionToolbarNativeBinding {
  /** Exact ordered, de-duplicated IDs sent with the atomic native request. */
  readonly requestedEntityIds: readonly string[];
  readonly requestedBeltIds: readonly string[];
  /** True when the unbounded request could not fit in the native contract. */
  readonly requestTruncated: boolean;
  /** Raw toolbar selections used by the legacy Web/PWA presentation. */
  readonly selectedEntityIds: readonly string[];
  readonly selectedBeltIds: readonly string[];
}

export interface FactoryInspectorNativeBinding {
  /** Exact ordered, de-duplicated IDs carried by the atomic native request. */
  readonly requestedEntityIds: readonly string[];
  readonly requestedBeltIds: readonly string[];
  /** True when either original request exceeded its native row cap. */
  readonly requestTruncated: boolean;
}

function hasUniqueIds(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

function hasExactOrderedIds<Row>(
  rows: readonly Row[],
  ids: readonly string[],
  readId: (row: Row) => string,
): boolean {
  return rows.length === ids.length && rows.every((row, index) => readId(row) === ids[index]);
}

/**
 * Selects the real canvas selection-toolbar values from the existing atomic
 * factory selection projection. The complete GameState remains authoritative
 * for upgrades, blueprint eligibility and command execution.
 *
 * The controller/store already binds both projection reads to one native
 * session and request token. This final selector additionally requires the
 * exact revision, active planet, complete ordered request IDs and equality of
 * every field that the toolbar can render. Any cap, truncation, missing row or
 * semantic disagreement retains the Web/PWA model.
 */
export function selectFactorySelectionToolbarReadModel(
  web: FactorySelectionToolbarReadModel,
  native: NativeFactoryThinViewSnapshot,
  expectedRevision: number,
  binding: FactorySelectionToolbarNativeBinding,
): FactorySelectionToolbarReadModel {
  if (binding.requestTruncated ||
    binding.selectedEntityIds.length > FACTORY_READ_MODEL_LIMITS.selectedEntityRows ||
    binding.selectedBeltIds.length > FACTORY_READ_MODEL_LIMITS.selectedBeltRows ||
    binding.requestedEntityIds.length > FACTORY_READ_MODEL_LIMITS.selectedEntityRows ||
    binding.requestedBeltIds.length > FACTORY_READ_MODEL_LIMITS.selectedBeltRows ||
    !hasUniqueIds(binding.selectedEntityIds) || !hasUniqueIds(binding.selectedBeltIds) ||
    !hasUniqueIds(binding.requestedEntityIds) || !hasUniqueIds(binding.requestedBeltIds) ||
    !hasExactOrderedIds(binding.requestedEntityIds, binding.selectedEntityIds, (id) => id)) {
    return web;
  }
  const frame = native.status === "ready" && native.requestedRevision === expectedRevision
    ? native.frame
    : null;
  const factory = frame?.factory;
  const selection = factory?.selection;
  if (!frame || frame.revision !== expectedRevision || frame.planetId !== web.activePlanetId ||
    !factory || factory.revision !== expectedRevision || factory.shell.source !== "native-core" ||
    factory.shell.activePlanetId !== web.activePlanetId || selection?.schema !== web.schema ||
    selection.activePlanetId !== web.activePlanetId || selection.entityRows.truncated ||
    selection.beltRows.truncated || selection.requestedEntityCount !== binding.requestedEntityIds.length ||
    selection.requestedBeltCount !== binding.requestedBeltIds.length ||
    selection.entityRows.totalCount !== selection.entityRows.rows.length ||
    selection.beltRows.totalCount !== selection.beltRows.rows.length ||
    !hasExactOrderedIds(selection.entityRows.rows, binding.requestedEntityIds, (row) => row.entityId) ||
    !hasExactOrderedIds(selection.beltRows.rows, binding.requestedBeltIds, (row) => row.beltId)) {
    return web;
  }

  const selectedBeltIds = new Set(binding.selectedBeltIds);
  const activeEntityRows = selection.entityRows.rows.filter((row) => row.planetId === web.activePlanetId);
  const selectedCount = selection.requestedEntityCount;
  const selectedBeltCount = selection.beltRows.rows.reduce(
    (count, row) => count + (row.planetId === web.activePlanetId && selectedBeltIds.has(row.beltId) ? 1 : 0),
    0,
  );
  const canLock = activeEntityRows.some((row) => !row.interactionLocked);
  const canUnlock = activeEntityRows.some((row) => row.interactionLocked);
  if (selectedCount !== web.selectedCount || selectedBeltCount !== web.selectedBeltCount ||
    canLock !== web.canLock || canUnlock !== web.canUnlock) {
    return web;
  }
  return Object.freeze({
    ...web,
    source: "native-core",
    revision: expectedRevision,
  });
}

function hasCompleteItemRows(rows: SelectedEntityReadModel["inputItems"]): boolean {
  return !rows.truncated && rows.totalCount === rows.rows.length &&
    rows.rows.length <= FACTORY_READ_MODEL_LIMITS.itemRows;
}

function sameItemRows(
  web: SelectedEntityReadModel["inputItems"],
  native: SelectedEntityReadModel["inputItems"],
): boolean {
  if (!hasCompleteItemRows(web) || !hasCompleteItemRows(native) ||
    web.rows.length !== native.rows.length) {
    return false;
  }
  return native.rows.every((row: ItemQuantityReadModel, index) => {
    const webRow = web.rows[index];
    return webRow?.itemId === row.itemId && webRow.amount === row.amount;
  });
}

function sameSelectedEntityRow(web: SelectedEntityReadModel, native: SelectedEntityReadModel): boolean {
  return native.entityId === web.entityId && native.planetId === web.planetId &&
    native.kind === web.kind && native.position.x === web.position.x && native.position.y === web.position.y &&
    native.interactionLocked === web.interactionLocked && native.buildingId === web.buildingId &&
    native.resourceId === web.resourceId && native.recipeId === web.recipeId &&
    native.storedItemId === web.storedItemId && native.fuelItemId === web.fuelItemId &&
    native.machineCount === web.machineCount && native.minerCount === web.minerCount &&
    native.progress === web.progress && native.utilization === web.utilization &&
    native.productionRate === web.productionRate && native.powerFactor === web.powerFactor &&
    sameItemRows(web.inputItems, native.inputItems) && sameItemRows(web.outputItems, native.outputItems);
}

function sameSelectedBeltRow(web: SelectedBeltReadModel, native: SelectedBeltReadModel): boolean {
  return native.beltId === web.beltId && native.planetId === web.planetId &&
    native.sourceEntityId === web.sourceEntityId && native.targetEntityId === web.targetEntityId &&
    native.itemId === web.itemId && native.lanes === web.lanes && native.tier === web.tier &&
    native.sorterTier === web.sorterTier && native.stackSize === web.stackSize &&
    native.priority === web.priority && native.progress === web.progress &&
    native.lastFlow === web.lastFlow && native.totalTransferred === web.totalTransferred &&
    native.congestion === web.congestion;
}

/**
 * Selects only the mobile/desktop inspectors' live display fields from a complete
 * atomic native selection. GameState remains the source for every action,
 * eligibility check and specialized inspector control.
 */
export function selectFactoryInspectorSummaryReadModel(
  web: FactoryInspectorSummaryReadModel,
  native: NativeFactoryThinViewSnapshot,
  expectedRevision: number,
  binding: FactoryInspectorNativeBinding,
): FactoryInspectorSummaryReadModel {
  if (binding.requestTruncated ||
    binding.requestedEntityIds.length > FACTORY_READ_MODEL_LIMITS.selectedEntityRows ||
    binding.requestedBeltIds.length > FACTORY_READ_MODEL_LIMITS.selectedBeltRows ||
    !hasUniqueIds(binding.requestedEntityIds) || !hasUniqueIds(binding.requestedBeltIds) ||
    Boolean(web.entity) === Boolean(web.belt) ||
    web.entity?.planetId !== undefined && web.entity.planetId !== web.activePlanetId ||
    web.belt?.planetId !== undefined && web.belt.planetId !== web.activePlanetId) {
    return web;
  }

  const frame = native.status === "ready" && native.requestedRevision === expectedRevision
    ? native.frame
    : null;
  const factory = frame?.factory;
  const selection = factory?.selection;
  if (!frame || frame.revision !== expectedRevision || frame.planetId !== web.activePlanetId ||
    !factory || factory.revision !== expectedRevision || factory.shell.source !== "native-core" ||
    factory.shell.activePlanetId !== web.activePlanetId || selection?.schema !== web.schema ||
    selection.activePlanetId !== web.activePlanetId || selection.entityRows.truncated ||
    selection.beltRows.truncated ||
    selection.requestedEntityCount !== binding.requestedEntityIds.length ||
    selection.requestedBeltCount !== binding.requestedBeltIds.length ||
    selection.entityRows.totalCount !== selection.entityRows.rows.length ||
    selection.beltRows.totalCount !== selection.beltRows.rows.length ||
    !hasExactOrderedIds(selection.entityRows.rows, binding.requestedEntityIds, (row) => row.entityId) ||
    !hasExactOrderedIds(selection.beltRows.rows, binding.requestedBeltIds, (row) => row.beltId)) {
    return web;
  }

  if (web.entity) {
    const entity = selection.entityRows.rows.find((row) => row.entityId === web.entity?.entityId);
    if (!entity || !binding.requestedEntityIds.includes(web.entity.entityId) ||
      !sameSelectedEntityRow(web.entity, entity)) {
      return web;
    }
    return Object.freeze({ ...web, source: "native-core", revision: expectedRevision, entity });
  }

  const webBelt = web.belt!;
  const belt = selection.beltRows.rows.find((row) => row.beltId === webBelt.beltId);
  if (!belt || !binding.requestedBeltIds.includes(webBelt.beltId) ||
    !sameSelectedBeltRow(webBelt, belt)) {
    return web;
  }
  return Object.freeze({ ...web, source: "native-core", revision: expectedRevision, belt });
}

/**
 * Selects complete native rows for the desktop multi-selection summary only.
 * The store binds the frame to one native session/request token; this selector
 * additionally proves exact revision, planet, request order, row completeness
 * and every row semantic before any native aggregate becomes visible.
 */
export function selectFactoryMultiSelectionSummaryReadModel(
  web: FactoryMultiSelectionSummaryReadModel,
  native: NativeFactoryThinViewSnapshot,
  expectedRevision: number,
  binding: FactoryInspectorNativeBinding,
): FactoryMultiSelectionSummaryReadModel {
  const webEntities = web.entityRows;
  const webBelts = web.beltRows;
  if (web.source !== "web-game-state" || web.revision !== null || binding.requestTruncated ||
    binding.requestedEntityIds.length > FACTORY_READ_MODEL_LIMITS.selectedEntityRows ||
    binding.requestedBeltIds.length > FACTORY_READ_MODEL_LIMITS.selectedBeltRows ||
    !hasUniqueIds(binding.requestedEntityIds) || !hasUniqueIds(binding.requestedBeltIds) ||
    web.requestedEntityCount !== binding.requestedEntityIds.length ||
    web.requestedBeltCount !== binding.requestedBeltIds.length ||
    webEntities.truncated || webBelts.truncated ||
    webEntities.totalCount !== webEntities.rows.length || webBelts.totalCount !== webBelts.rows.length ||
    !hasExactOrderedIds(webEntities.rows, binding.requestedEntityIds, (row) => row.entityId) ||
    !hasExactOrderedIds(webBelts.rows, binding.requestedBeltIds, (row) => row.beltId) ||
    webEntities.rows.some((row) => row.planetId !== web.activePlanetId || row.powerFactor === null ||
      !hasCompleteItemRows(row.inputItems) || !hasCompleteItemRows(row.outputItems)) ||
    webBelts.rows.some((row) => row.planetId !== web.activePlanetId ||
      row.totalTransferred === null || row.congestion === null)) {
    return web;
  }

  const frame = native.status === "ready" && native.requestedRevision === expectedRevision
    ? native.frame
    : null;
  const factory = frame?.factory;
  const selection = factory?.selection;
  if (!frame || frame.revision !== expectedRevision || frame.planetId !== web.activePlanetId ||
    !factory || factory.revision !== expectedRevision || factory.shell.source !== "native-core" ||
    factory.shell.activePlanetId !== web.activePlanetId || selection?.schema !== web.schema ||
    selection.activePlanetId !== web.activePlanetId || selection.entityRows.truncated ||
    selection.beltRows.truncated ||
    selection.requestedEntityCount !== binding.requestedEntityIds.length ||
    selection.requestedBeltCount !== binding.requestedBeltIds.length ||
    selection.entityRows.totalCount !== selection.entityRows.rows.length ||
    selection.beltRows.totalCount !== selection.beltRows.rows.length ||
    !hasExactOrderedIds(selection.entityRows.rows, binding.requestedEntityIds, (row) => row.entityId) ||
    !hasExactOrderedIds(selection.beltRows.rows, binding.requestedBeltIds, (row) => row.beltId) ||
    selection.entityRows.rows.some((row, index) => row.planetId !== web.activePlanetId ||
      row.powerFactor === null || !sameSelectedEntityRow(webEntities.rows[index]!, row)) ||
    selection.beltRows.rows.some((row, index) => row.planetId !== web.activePlanetId ||
      row.totalTransferred === null || row.congestion === null || !sameSelectedBeltRow(webBelts.rows[index]!, row))) {
    return web;
  }

  return Object.freeze({
    ...web,
    source: "native-core",
    revision: expectedRevision,
    entityRows: selection.entityRows,
    beltRows: selection.beltRows,
  });
}

/**
 * Selects the blueprint construction headline from the exact atomic native
 * frame only when every visible value agrees with the Web authority view.
 */
export function selectFactoryConstructionHeadlineReadModel(
  web: FactoryConstructionHeadlineReadModel,
  native: NativeFactoryThinViewSnapshot,
  expectedRevision: number,
): FactoryConstructionHeadlineReadModel {
  const frame = native.status === "ready" && native.requestedRevision === expectedRevision
    ? native.frame
    : null;
  const factory = frame?.factory;
  const shell = factory?.shell;
  const navigation = factory?.planetNavigation;
  const construction = factory?.construction;
  const activePlanet = navigation?.planets.rows.find((row) => row.planetId === web.activePlanetId);
  if (!frame || frame.revision !== expectedRevision || frame.planetId !== web.activePlanetId ||
    !factory || factory.revision !== expectedRevision || !shell || shell.source !== "native-core" ||
    shell.activePlanetId !== web.activePlanetId || navigation?.activePlanetId !== web.activePlanetId ||
    construction?.activePlanetId !== web.activePlanetId || !activePlanet?.active ||
    shell.constructionQueueCount !== web.constructionQueueCount ||
    construction.queue.totalCount !== web.constructionQueueCount) {
    return web;
  }
  return Object.freeze({
    schema: web.schema,
    source: "native-core",
    revision: expectedRevision,
    activePlanetId: web.activePlanetId,
    activePlanetDisplayName: web.activePlanetDisplayName,
    constructionQueueCount: shell.constructionQueueCount,
  });
}

function completeBoundedRows<Row>(rows: BoundedReadModelRows<Row>, limit: number): boolean {
  return !rows.truncated && rows.totalCount === rows.rows.length && rows.rows.length <= limit;
}

function sameConstructionReservationRows(
  web: BoundedReadModelRows<ConstructionReservationReadModel>,
  native: BoundedReadModelRows<ConstructionReservationReadModel>,
): boolean {
  return completeBoundedRows(web, FACTORY_READ_MODEL_LIMITS.constructionReservationRows) &&
    completeBoundedRows(native, FACTORY_READ_MODEL_LIMITS.constructionReservationRows) &&
    web.rows.length === native.rows.length && native.rows.every((row, index) => {
      const expected = web.rows[index];
      return expected?.constructionId === row.constructionId && expected.amount === row.amount;
    });
}

function sameConstructionQueueRows(
  web: BoundedReadModelRows<ConstructionQueueRowReadModel>,
  native: BoundedReadModelRows<ConstructionQueueRowReadModel>,
): boolean {
  return completeBoundedRows(web, FACTORY_READ_MODEL_LIMITS.constructionQueueRows) &&
    completeBoundedRows(native, FACTORY_READ_MODEL_LIMITS.constructionQueueRows) &&
    web.rows.length === native.rows.length && native.rows.every((row, index) => {
      const expected = web.rows[index];
      return expected?.queueId === row.queueId && expected.blueprintId === row.blueprintId &&
        expected.blueprintVersionId === row.blueprintVersionId &&
        expected.blueprintRevision === row.blueprintRevision &&
        expected.blueprintName === row.blueprintName && expected.planetId === row.planetId &&
        expected.queuedAt === row.queuedAt && expected.status === row.status &&
        expected.rotation === row.rotation && expected.mirror === row.mirror &&
        expected.placedEntityCount === row.placedEntityCount &&
        sameConstructionReservationRows(expected.reservedConstruction, row.reservedConstruction) &&
        sameItemRows(expected.reservedFleet, row.reservedFleet);
    });
}

function sameConstructionTargetRows(
  web: BoundedReadModelRows<ConstructionTargetReadModel>,
  native: BoundedReadModelRows<ConstructionTargetReadModel>,
): boolean {
  return completeBoundedRows(web, FACTORY_READ_MODEL_LIMITS.constructionTargetRows) &&
    completeBoundedRows(native, FACTORY_READ_MODEL_LIMITS.constructionTargetRows) &&
    web.rows.length === native.rows.length && native.rows.every((row, index) => {
      const expected = web.rows[index];
      return expected?.targetId === row.targetId && expected.amount === row.amount;
    });
}

function sameConstructionJobRows(
  web: BoundedReadModelRows<ConstructionJobReadModel>,
  native: BoundedReadModelRows<ConstructionJobReadModel>,
): boolean {
  return completeBoundedRows(web, FACTORY_READ_MODEL_LIMITS.constructionJobRows) &&
    completeBoundedRows(native, FACTORY_READ_MODEL_LIMITS.constructionJobRows) &&
    web.rows.length === native.rows.length && native.rows.every((row, index) => {
      const expected = web.rows[index];
      return expected?.entityId === row.entityId && expected.constructionId === row.constructionId &&
        expected.stepIndex === row.stepIndex && expected.stepCount === row.stepCount &&
        expected.elapsedSeconds === row.elapsedSeconds && sameItemRows(expected.inventory, row.inventory);
    });
}

/**
 * Selects the construction-center and pending-blueprint display projection only
 * when the complete bounded native payload is semantically identical to the
 * same GameState revision. Any stale frame, cap, nested truncation, missing row
 * or field drift keeps the complete Web model, rather than mixing revisions.
 */
export function selectFactoryConstructionWorkspaceReadModel(
  web: FactoryConstructionWorkspaceReadModel,
  native: NativeFactoryThinViewSnapshot,
  expectedRevision: number,
): FactoryConstructionWorkspaceReadModel {
  const frame = native.status === "ready" && native.requestedRevision === expectedRevision
    ? native.frame
    : null;
  const factory = frame?.factory;
  const shell = factory?.shell;
  const model = factory?.construction;
  if (web.source !== "web-game-state" || web.revision !== null ||
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
    !frame || frame.revision !== expectedRevision || frame.planetId !== web.activePlanetId ||
    !factory || factory.revision !== expectedRevision || !shell || shell.source !== "native-core" ||
    shell.activePlanetId !== web.activePlanetId || model?.schema !== web.schema ||
    model.activePlanetId !== web.activePlanetId || shell.constructionQueueCount !== web.queue.totalCount ||
    shell.constructionQueueCount !== model.queue.totalCount ||
    model.automation.enabled !== web.automation.enabled ||
    model.automation.quantumSourceEnabled !== web.automation.quantumSourceEnabled ||
    model.automation.totalCrafted !== web.automation.totalCrafted ||
    model.automation.lastCraftedId !== web.automation.lastCraftedId ||
    !sameConstructionQueueRows(web.queue, model.queue) ||
    !sameConstructionTargetRows(web.automation.targets, model.automation.targets) ||
    !sameConstructionJobRows(web.automation.jobs, model.automation.jobs) ||
    !sameItemRows(web.automation.destroyedByproducts, model.automation.destroyedByproducts)) {
    return web;
  }
  return Object.freeze({
    ...model,
    source: "native-core",
    revision: expectedRevision,
  });
}

function samePlanetRow(
  web: PlanetNavigationRowReadModel,
  native: PlanetNavigationRowReadModel,
): boolean {
  return native.planetId === web.planetId && native.systemId === web.systemId &&
    native.displayName === web.displayName && native.active === web.active &&
    native.discovered === web.discovered && native.colonized === web.colonized &&
    native.role === web.role && native.entityCount === web.entityCount &&
    native.deviceCount === web.deviceCount && native.beltCount === web.beltCount &&
    native.constructionQueueCount === web.constructionQueueCount &&
    native.powerFactor === web.powerFactor;
}

/**
 * Selects the bounded native planet navigator only after every dynamic value
 * agrees with the current Web authority. The public catalog still owns the
 * short display code until the native catalog protocol carries that field, so
 * it is copied from the matching bounded Web row rather than from GameState.
 */
export function selectFactoryPlanetNavigationReadModel(
  web: PlanetNavigationReadModel,
  native: NativeFactoryThinViewSnapshot,
  expectedRevision: number,
): PlanetNavigationReadModel {
  const frame = native.status === "ready" && native.requestedRevision === expectedRevision
    ? native.frame
    : null;
  const model = frame?.factory.planetNavigation;
  if (!frame || frame.revision !== expectedRevision || !model ||
    model.activePlanetId !== web.activePlanetId ||
    model.planets.totalCount !== web.planets.totalCount ||
    model.planets.truncated !== web.planets.truncated ||
    model.planets.rows.length !== web.planets.rows.length) {
    return web;
  }
  const webById = new Map(web.planets.rows.map((row) => [row.planetId, row] as const));
  const rows = model.planets.rows.map((row) => {
    const webRow = webById.get(row.planetId);
    return webRow && samePlanetRow(webRow, row) ? Object.freeze({ ...row, code: webRow.code }) : null;
  });
  if (rows.some((row) => row === null)) return web;
  return Object.freeze({
    schema: model.schema,
    activePlanetId: model.activePlanetId,
    planets: Object.freeze({
      rows: Object.freeze(rows as PlanetNavigationRowReadModel[]),
      totalCount: model.planets.totalCount,
      truncated: model.planets.truncated,
    }),
  });
}
