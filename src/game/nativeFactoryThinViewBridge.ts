import type { FactoryRunStatusReadModel } from "./factoryReadModels";
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

