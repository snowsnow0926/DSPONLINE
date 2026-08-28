import type {
  FactoryConstructionHeadlineReadModel,
  FactoryRunStatusReadModel,
  FactorySelectionToolbarReadModel,
  PlanetNavigationReadModel,
  PlanetNavigationRowReadModel,
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
