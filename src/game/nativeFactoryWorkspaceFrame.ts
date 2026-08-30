import {
  FACTORY_READ_MODEL_LIMITS,
  FACTORY_READ_MODEL_SCHEMA,
  type BoundedReadModelRows,
  type FactoryConstructionHeadlineReadModel,
  type FactoryConstructionWorkspaceReadModel,
  type FactoryRunStatusReadModel,
  type FactoryTimeWarpReadModel,
  type NativeConstructionCenterQuantityRows,
  type NativeConstructionCenterWorkspaceReadModel,
  type PlanetNavigationReadModel,
  type PlanetNavigationRowReadModel,
} from "./factoryReadModels";
import type { NativeFactoryThinViewSnapshot } from "./nativeFactoryThinViewStore";

export interface NativeAuthoritativeFactoryWorkspaceFrame {
  readonly source: "native-authoritative";
  readonly sessionId: string;
  readonly runId: string;
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
  readonly runId: string | null;
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

function isBoundedRows<Row>(value: unknown, limit: number): value is BoundedReadModelRows<Row> {
  if (!value || typeof value !== "object" || !Array.isArray((value as BoundedReadModelRows<Row>).rows)) return false;
  const rows = value as BoundedReadModelRows<Row>;
  return rows.rows.length <= limit && Number.isSafeInteger(rows.totalCount) && rows.totalCount >= rows.rows.length &&
    rows.truncated === (rows.totalCount > rows.rows.length);
}

function validNamedQuantities(
  value: NativeConstructionCenterQuantityRows<{ readonly itemId: string; readonly name: string; readonly amount: number }>,
  limit: number,
): boolean {
  if (!isBoundedRows(value, limit) || !Number.isSafeInteger(value.totalAmount) || value.totalAmount < 0) return false;
  let visibleTotal = 0;
  const ids = new Set<string>();
  for (const row of value.rows) {
    if (!isOpaqueId(row.itemId) || ids.has(row.itemId) || typeof row.name !== "string" || row.name.length < 1 ||
      row.name.length > 256 || !Number.isSafeInteger(row.amount) || row.amount < 0) return false;
    ids.add(row.itemId);
    visibleTotal += row.amount;
    if (!Number.isSafeInteger(visibleTotal)) return false;
  }
  return value.totalAmount >= visibleTotal && (value.truncated || value.totalAmount === visibleTotal);
}

function validNativeConstructionCenterWorkspace(
  model: NativeConstructionCenterWorkspaceReadModel,
  activePlanetId: string,
): boolean {
  if (model.schema !== "construction-center-workspace-v1" || model.registryFingerprint !== "7df8cf3a" ||
    model.readOnly !== true || model.activePlanetId !== activePlanetId || typeof model.activePlanetName !== "string" ||
    model.activePlanetName.length < 1 || model.activePlanetName.length > 256 || typeof model.paused !== "boolean" ||
    typeof model.enabled !== "boolean" || typeof model.quantumSourceEnabled !== "boolean" ||
    typeof model.quantumNetworkEnabled !== "boolean" || !Number.isSafeInteger(model.totalCrafted) || model.totalCrafted < 0 ||
    !Number.isSafeInteger(model.stockLimit) || model.stockLimit < 1 || !Number.isFinite(model.cycleSeconds) ||
    model.cycleSeconds <= 0 || !Number.isFinite(model.materialSeconds) || model.materialSeconds <= 0 ||
    Math.abs(model.materialSeconds - model.cycleSeconds / 50) > Number.EPSILON ||
    model.limits.targetRows !== FACTORY_READ_MODEL_LIMITS.constructionTargetRows ||
    model.limits.centerRows !== FACTORY_READ_MODEL_LIMITS.constructionCenterRows ||
    model.limits.jobRows !== FACTORY_READ_MODEL_LIMITS.constructionJobRows ||
    model.limits.materialRows !== FACTORY_READ_MODEL_LIMITS.constructionMaterialRows ||
    model.limits.quantumBufferRows !== FACTORY_READ_MODEL_LIMITS.constructionQuantumBufferRows ||
    model.limits.destroyedByproductRows !== FACTORY_READ_MODEL_LIMITS.constructionDestroyedByproductRows ||
    model.limits.costRowsPerTarget !== FACTORY_READ_MODEL_LIMITS.constructionCostRows ||
    model.limits.projectionBytes !== 1_048_576 ||
    !isBoundedRows(model.targets, FACTORY_READ_MODEL_LIMITS.constructionTargetRows) ||
    !isBoundedRows(model.centers, FACTORY_READ_MODEL_LIMITS.constructionCenterRows) ||
    !isBoundedRows(model.jobs, FACTORY_READ_MODEL_LIMITS.constructionJobRows) ||
    !validNamedQuantities(model.materials, FACTORY_READ_MODEL_LIMITS.constructionMaterialRows) ||
    !validNamedQuantities(model.destroyedByproducts, FACTORY_READ_MODEL_LIMITS.constructionDestroyedByproductRows)) return false;
  const targetIds = new Set<string>();
  for (const target of model.targets.rows) {
    if (!isOpaqueId(target.targetId) || targetIds.has(target.targetId) || typeof target.name !== "string" ||
      target.name.length < 1 || target.name.length > 256 || !["building", "fleet"].includes(target.kind) ||
      !["power", "production", "logistics", "dyson"].includes(target.category) ||
      !Number.isSafeInteger(target.target) || target.target < 0 || !Number.isSafeInteger(target.currentStock) ||
      target.currentStock < 0 || typeof target.unlocked !== "boolean" || !Number.isSafeInteger(target.outputAmount) ||
      target.outputAmount < 1 || (target.requiredTechId === null) !== (target.requiredTechName === null) ||
      target.requiredTechId !== null && !isOpaqueId(target.requiredTechId) ||
      target.requiredTechName !== null && (target.requiredTechName.length < 1 || target.requiredTechName.length > 256) ||
      !isBoundedRows(target.costs, FACTORY_READ_MODEL_LIMITS.constructionCostRows) ||
      target.costs.rows.some((cost) => !isOpaqueId(cost.itemId) || typeof cost.name !== "string" ||
        cost.name.length < 1 || cost.name.length > 256 || !Number.isSafeInteger(cost.amount) || cost.amount < 1)) return false;
    targetIds.add(target.targetId);
  }
  if ((model.lastCraftedId === null) !== (model.lastCraftedName === null) ||
    model.lastCraftedId !== null && (!isOpaqueId(model.lastCraftedId) || !model.targets.truncated && !targetIds.has(model.lastCraftedId)) ||
    model.lastCraftedName !== null && (model.lastCraftedName.length < 1 || model.lastCraftedName.length > 256)) return false;
  const centerIds = new Set<string>();
  for (const center of model.centers.rows) {
    if (!isOpaqueId(center.entityId) || centerIds.has(center.entityId) || center.planetId !== activePlanetId ||
      center.planetName !== model.activePlanetName || !Number.isSafeInteger(center.machineCount) || center.machineCount < 0 ||
      !["game-paused", "automation-paused", "working", "idle"].includes(center.status)) return false;
    centerIds.add(center.entityId);
  }
  const jobIds = new Set<string>();
  for (const job of model.jobs.rows) {
    if (!isOpaqueId(job.entityId) || jobIds.has(job.entityId) || !model.centers.truncated && !centerIds.has(job.entityId) ||
      !isOpaqueId(job.targetId) || !model.targets.truncated && !targetIds.has(job.targetId) ||
      typeof job.targetName !== "string" || job.targetName.length < 1 || job.targetName.length > 256 ||
      !Number.isSafeInteger(job.stepIndex) || !Number.isSafeInteger(job.stepCount) || job.stepIndex < 0 ||
      job.stepIndex > job.stepCount || !Number.isFinite(job.elapsedSeconds) || job.elapsedSeconds < 0 ||
      !validNamedQuantities(job.inventory, FACTORY_READ_MODEL_LIMITS.constructionMaterialRows)) return false;
    jobIds.add(job.entityId);
  }
  if (!isBoundedRows(model.quantumBuffer, FACTORY_READ_MODEL_LIMITS.constructionQuantumBufferRows) ||
    !Number.isSafeInteger(model.quantumBuffer.totalAmount) || model.quantumBuffer.totalAmount < 0) return false;
  let quantumVisible = 0;
  const quantumIds = new Set<string>();
  for (const row of model.quantumBuffer.rows) {
    const id = `${row.entityId}\0${row.itemId}`;
    if (!isOpaqueId(row.entityId) || !model.centers.truncated && !centerIds.has(row.entityId) || !isOpaqueId(row.itemId) ||
      quantumIds.has(id) || typeof row.name !== "string" || row.name.length < 1 || row.name.length > 256 ||
      !Number.isSafeInteger(row.amount) || row.amount < 0) return false;
    quantumIds.add(id);
    quantumVisible += row.amount;
    if (!Number.isSafeInteger(quantumVisible)) return false;
  }
  return model.quantumBuffer.totalAmount >= quantumVisible &&
    (model.quantumBuffer.truncated || model.quantumBuffer.totalAmount === quantumVisible);
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
    !isCompleteRows(model.automation.destroyedByproducts, FACTORY_READ_MODEL_LIMITS.itemRows) ||
    model.nativeCenterWorkspace !== null && !validNativeConstructionCenterWorkspace(model.nativeCenterWorkspace, model.activePlanetId)) return false;
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
  if (!binding.enabled || !isOpaqueId(binding.sessionId) || !isOpaqueId(binding.runId) || !isOpaqueId(binding.activePlanetId) ||
    !Number.isSafeInteger(binding.expectedRevision) || binding.expectedRevision < 0 ||
    snapshot.status !== "ready" || snapshot.requestedRevision !== binding.expectedRevision) return null;
  const frame = snapshot.frame;
  const factory = frame?.factory;
  const shell = factory?.shell;
  const navigation = factory?.planetNavigation;
  const construction = factory?.construction;
  if (!frame || frame.authoritySessionId !== binding.sessionId || frame.authorityRunId !== binding.runId ||
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
    runId: binding.runId,
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
