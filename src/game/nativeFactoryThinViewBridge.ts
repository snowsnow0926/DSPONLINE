import type {
  FactoryConstructionHeadlineReadModel,
  FactoryRunStatusReadModel,
  PlanetNavigationReadModel,
  PlanetNavigationRowReadModel,
} from "./factoryReadModels";
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
