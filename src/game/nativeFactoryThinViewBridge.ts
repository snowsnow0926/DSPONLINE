import type {
  FactoryConstructionHeadlineReadModel,
  FactoryRunStatusReadModel,
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
