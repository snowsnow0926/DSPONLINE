import {
  FACTORY_READ_MODEL_LIMITS,
  FACTORY_READ_MODEL_SCHEMA,
  type BoundedReadModelRows,
  type FactoryConstructionHeadlineReadModel,
  type FactoryConstructionWorkspaceReadModel,
  type FactoryRunStatusReadModel,
  type FactoryTimeWarpReadModel,
  type PlanetNavigationReadModel,
  type PlanetNavigationRowReadModel,
} from "./factoryReadModels";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";

export interface NativeAuthoritativeFactoryWorkspaceFrame {
  readonly source: "native-authoritative";
  readonly sessionId: string;
  readonly revision: number;
  readonly simulationSpeed: number;
  readonly runStatus: FactoryRunStatusReadModel;
  readonly timeWarp: FactoryTimeWarpReadModel;
  readonly constructionHeadline: FactoryConstructionHeadlineReadModel;
  readonly constructionWorkspace: FactoryConstructionWorkspaceReadModel;
  readonly planetNavigation: PlanetNavigationReadModel;
}

function validTimeWarp(value: FactoryTimeWarpReadModel | undefined, simulationSpeed: number): value is FactoryTimeWarpReadModel {
  return Boolean(value) &&
    (value!.controllerEntityId === null || isOpaqueId(value!.controllerEntityId)) &&
    typeof value!.enabled === "boolean" &&
    Number.isSafeInteger(value!.requestedMultiplier) && value!.requestedMultiplier >= simulationSpeed &&
    Number.isSafeInteger(value!.effectiveMultiplier) && value!.effectiveMultiplier >= simulationSpeed &&
    Number.isFinite(value!.requiredPowerKw) && value!.requiredPowerKw >= 0 &&
    Number.isFinite(value!.allocatedPowerKw) && value!.allocatedPowerKw >= 0 &&
    value!.allocatedPowerKw <= value!.requiredPowerKw;
}

export interface NativeAuthoritativeFactoryWorkspaceBinding {
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly expectedRevision: number;
  readonly activePlanetId: string;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

function isCompleteRows<Row>(value: unknown, limit: number): value is BoundedReadModelRows<Row> {
  if (!value || typeof value !== "object" || !Array.isArray((value as BoundedReadModelRows<Row>).rows)) return false;
  const rows = value as BoundedReadModelRows<Row>;
  return rows.truncated === false && Number.isSafeInteger(rows.totalCount) &&
    rows.totalCount === rows.rows.length && rows.rows.length <= limit;
}

function validPlanetNavigation(model: PlanetNavigationReadModel, activePlanetId: string): boolean {
  if (model.schema !== FACTORY_READ_MODEL_SCHEMA || model.activePlanetId !== activePlanetId ||
    !isCompleteRows<PlanetNavigationRowReadModel>(model.planets, FACTORY_READ_MODEL_LIMITS.planetRows)) return false;
  const ids = new Set<string>();
  let activeRows = 0;
  for (const row of model.planets.rows) {
    if (!isOpaqueId(row.planetId) || ids.has(row.planetId) ||
      row.systemId !== null && !isOpaqueId(row.systemId) ||
      typeof row.displayName !== "string" || row.displayName.length > 512 ||
      typeof row.code !== "string" || row.code.length > 512 ||
      typeof row.active !== "boolean" || typeof row.discovered !== "boolean" ||
      typeof row.colonized !== "boolean" || row.role !== null && !isOpaqueId(row.role) ||
      !Number.isSafeInteger(row.entityCount) || row.entityCount < 0 ||
      !Number.isSafeInteger(row.deviceCount) || row.deviceCount < 0 ||
      !Number.isSafeInteger(row.beltCount) || row.beltCount < 0 ||
      !Number.isSafeInteger(row.constructionQueueCount) || row.constructionQueueCount < 0 ||
      !Number.isFinite(row.powerFactor) || row.powerFactor < 0) return false;
    ids.add(row.planetId);
    if (row.active) {
      activeRows += 1;
      if (row.planetId !== activePlanetId) return false;
    }
  }
  return activeRows === 1;
}

function validConstruction(model: FactoryConstructionWorkspaceReadModel): boolean {
  if (model.schema !== FACTORY_READ_MODEL_SCHEMA ||
    !isCompleteRows(model.queue, FACTORY_READ_MODEL_LIMITS.constructionQueueRows) ||
    !isCompleteRows(model.automation.targets, FACTORY_READ_MODEL_LIMITS.constructionTargetRows) ||
    !isCompleteRows(model.automation.jobs, FACTORY_READ_MODEL_LIMITS.constructionJobRows) ||
    !isCompleteRows(model.automation.destroyedByproducts, FACTORY_READ_MODEL_LIMITS.itemRows)) return false;
  if (model.queue.rows.some((row) =>
    !isCompleteRows(row.reservedConstruction, FACTORY_READ_MODEL_LIMITS.constructionReservationRows) ||
    !isCompleteRows(row.reservedFleet, FACTORY_READ_MODEL_LIMITS.constructionReservationRows))) return false;
  if (model.automation.jobs.rows.some((row) =>
    !isCompleteRows(row.inventory, FACTORY_READ_MODEL_LIMITS.itemRows))) return false;
  return new Set(model.queue.rows.map((row) => row.queueId)).size === model.queue.rows.length &&
    new Set(model.automation.targets.rows.map((row) => row.targetId)).size === model.automation.targets.rows.length &&
    new Set(model.automation.jobs.rows.map((row) => row.entityId)).size === model.automation.jobs.rows.length;
}

/**
 * Selects the non-canvas factory shell directly from an exact main-owned Rust
 * authority atom. Unlike the JS-shadow selectors, this path intentionally has
 * no GameState oracle: requiring one would recreate the large renderer mirror
 * that the player-authority thin UI is meant to remove.
 */
export function selectNativeAuthoritativeFactoryWorkspaceFrame(
  snapshot: NativeFactoryThinViewSnapshot,
  binding: NativeAuthoritativeFactoryWorkspaceBinding,
): NativeAuthoritativeFactoryWorkspaceFrame | null {
  if (!binding.enabled || !isOpaqueId(binding.sessionId) || !isOpaqueId(binding.activePlanetId) ||
    !Number.isSafeInteger(binding.expectedRevision) || binding.expectedRevision < 0 ||
    snapshot.status !== "ready" || snapshot.requestedRevision !== binding.expectedRevision) return null;
  const frame = snapshot.frame;
  const factory = frame?.factory;
  const shell = factory?.shell;
  const navigation = factory?.planetNavigation;
  const construction = factory?.construction;
  if (!frame || frame.authoritySessionId !== binding.sessionId ||
    frame.revision !== binding.expectedRevision || frame.planetId !== binding.activePlanetId ||
    !factory || factory.schemaVersion !== 1 || factory.projectionType !== "factory-read-model-v1" ||
    factory.revision !== binding.expectedRevision || !shell || shell.schema !== FACTORY_READ_MODEL_SCHEMA ||
    shell.source !== "native-core" || shell.stateVersion !== 47 || shell.mode !== "normal" ||
    !Number.isSafeInteger(shell.simulationSpeed) || shell.simulationSpeed < 1 ||
    !validTimeWarp(shell.timeWarp, shell.simulationSpeed) ||
    shell.activePlanetId !== binding.activePlanetId || !navigation || !construction ||
    construction.activePlanetId !== binding.activePlanetId ||
    shell.constructionQueueCount !== construction.queue.totalCount ||
    !validPlanetNavigation(navigation, binding.activePlanetId) || !validConstruction({
      ...construction,
      source: "native-core",
      revision: binding.expectedRevision,
    })) return null;
  const activePlanet = navigation.planets.rows.find((row) => row.planetId === binding.activePlanetId);
  if (!activePlanet?.active || activePlanet.constructionQueueCount > shell.constructionQueueCount) return null;

  return Object.freeze({
    source: "native-authoritative",
    sessionId: binding.sessionId,
    revision: binding.expectedRevision,
    simulationSpeed: shell.simulationSpeed,
    runStatus: Object.freeze({
      schema: FACTORY_READ_MODEL_SCHEMA,
      source: "native-core",
      revision: binding.expectedRevision,
      activePlanetId: binding.activePlanetId,
      paused: shell.paused,
    }),
    timeWarp: Object.freeze({ ...shell.timeWarp }),
    constructionHeadline: Object.freeze({
      schema: FACTORY_READ_MODEL_SCHEMA,
      source: "native-core",
      revision: binding.expectedRevision,
      activePlanetId: binding.activePlanetId,
      activePlanetDisplayName: activePlanet.displayName,
      constructionQueueCount: shell.constructionQueueCount,
    }),
    constructionWorkspace: Object.freeze({
      ...construction,
      source: "native-core",
      revision: binding.expectedRevision,
    }),
    planetNavigation: navigation,
  });
}
