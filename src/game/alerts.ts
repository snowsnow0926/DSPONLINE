import { ITEMS, getBuilding, getPlanet, getRecipe } from "./content";
import { getEntityOperatingStatus, type SimulationLookupContext } from "./engine";
import type { EntityOperatingStatus, FactoryEntity, GameState, PlanetId } from "./types";

export type FactoryAlertSeverity = "critical" | "warning";

export interface FactoryAlert {
  id: string;
  severity: FactoryAlertSeverity;
  statusCode: EntityOperatingStatus["code"];
  entityId: string;
  planetId: PlanetId;
  title: string;
  reason: string;
  location: string;
}

const CRITICAL_CODES = new Set<EntityOperatingStatus["code"]>([
  "no-power",
  "missing-fuel",
  "no-fuel-selected",
  "missing-vessel",
  "missing-drone",
  "missing-warper",
  "missing-hub",
  "missing-route",
  "missing-research",
  "missing-recipe",
]);

function entityTitle(entity: FactoryEntity): string {
  if (entity.kind === "vein" && entity.resourceId) {
    const extractor = entity.extractorBuildingId ? getBuilding(entity.extractorBuildingId).shortName : "采矿点";
    return `${extractor} · ${ITEMS[entity.resourceId].name}`;
  }
  const building = entity.buildingId ? getBuilding(entity.buildingId).shortName : "未知设备";
  const recipe = getRecipe(entity.recipeId);
  return recipe ? `${building} · ${recipe.name}` : building;
}

export interface FactoryAlertOptions {
  /** Build titles and locations only while the alert list is visible. */
  details?: boolean;
  /** Reuse the runtime's linear indexes instead of rescanning the whole save for every entity. */
  lookup?: SimulationLookupContext;
}

/**
 * Worker-owned compact alert projection. Codes and labels are dictionary
 * encoded once while each alert row keeps the stable entity/planet identity
 * and two small dictionary indices. Stable ids prevent a pending topology
 * command from making an accepted Worker row point at a different entity.
 */
export interface FactoryAlertProjection {
  signature: string;
  codes: EntityOperatingStatus["code"][];
  labels: string[];
  rows: Array<[entityId: string, planetId: PlanetId, codeIndex: number, labelIndex: number]>;
}

export const EMPTY_FACTORY_ALERT_PROJECTION: FactoryAlertProjection = {
  signature: "0:811c9dc5",
  codes: [],
  labels: [],
  rows: [],
};

export interface FactoryAlertMembership {
  planetId: PlanetId;
  entityIds: ReadonlySet<string>;
  criticalEntityIds: ReadonlySet<string>;
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/**
 * Project the alert rows down to the only identity data consumed by Canvas.
 * Status labels may change every simulation publication; returning the prior
 * sets when membership is exact prevents those label-only updates from
 * invalidating stack geometry and every React Flow node.
 */
export function reconcileFactoryAlertMembership(
  previous: FactoryAlertMembership | null,
  projection: FactoryAlertProjection,
  planetId: PlanetId,
): FactoryAlertMembership {
  const entityIds = new Set<string>();
  const criticalEntityIds = new Set<string>();
  for (const [entityId, rowPlanetId, codeIndex] of projection.rows) {
    if (rowPlanetId !== planetId) continue;
    entityIds.add(entityId);
    const code = projection.codes[codeIndex];
    if (code && isCriticalFactoryAlertCode(code)) criticalEntityIds.add(entityId);
  }
  if (previous?.planetId === planetId && sameStringSet(previous.entityIds, entityIds) &&
    sameStringSet(previous.criticalEntityIds, criticalEntityIds)) return previous;
  return { planetId, entityIds, criticalEntityIds };
}

export function isCriticalFactoryAlertCode(code: EntityOperatingStatus["code"]): boolean {
  return CRITICAL_CODES.has(code);
}

function mixProjectionHash(hash: number, value: number | string): number {
  const text = String(value);
  let next = hash >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    next ^= text.charCodeAt(index);
    next = Math.imul(next, 0x01000193) >>> 0;
  }
  return next;
}

export function createFactoryAlertProjection(
  state: GameState,
  lookup?: SimulationLookupContext,
): FactoryAlertProjection {
  if (state.paused) return EMPTY_FACTORY_ALERT_PROJECTION;
  const codes: EntityOperatingStatus["code"][] = [];
  const labels: string[] = [];
  const codeIndex = new Map<EntityOperatingStatus["code"], number>();
  const labelIndex = new Map<string, number>();
  const rows: FactoryAlertProjection["rows"] = [];
  let hash = 0x811c9dc5;
  for (let entityIndex = 0; entityIndex < state.entities.length; entityIndex += 1) {
    const entity = state.entities[entityIndex];
    if (entity.kind === "vein" && entity.minerCount < 1) continue;
    const status = getEntityOperatingStatus(state, entity, lookup);
    if (status.tone !== "warning" && status.tone !== "blocked") continue;
    let resolvedCodeIndex = codeIndex.get(status.code);
    if (resolvedCodeIndex === undefined) {
      resolvedCodeIndex = codes.length;
      codeIndex.set(status.code, resolvedCodeIndex);
      codes.push(status.code);
    }
    let resolvedLabelIndex = labelIndex.get(status.label);
    if (resolvedLabelIndex === undefined) {
      resolvedLabelIndex = labels.length;
      labelIndex.set(status.label, resolvedLabelIndex);
      labels.push(status.label);
    }
    rows.push([entity.id, entity.planetId, resolvedCodeIndex, resolvedLabelIndex]);
    hash = mixProjectionHash(hash, entity.id);
    hash = mixProjectionHash(hash, entity.planetId);
    hash = mixProjectionHash(hash, status.code);
    hash = mixProjectionHash(hash, status.label);
  }
  return {
    signature: `${rows.length}:${hash.toString(16).padStart(8, "0")}`,
    codes,
    labels,
    rows,
  };
}

function sortFactoryAlerts(alerts: FactoryAlert[]): FactoryAlert[] {
  return alerts.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "critical" ? -1 : 1;
    if (left.planetId !== right.planetId) return left.planetId.localeCompare(right.planetId);
    return left.title.localeCompare(right.title, "zh-CN");
  });
}

export function materializeFactoryAlerts(state: GameState, projection: FactoryAlertProjection): FactoryAlert[] {
  const entityById = new Map(state.entities.map((entity) => [entity.id, entity]));
  return sortFactoryAlerts(projection.rows.flatMap(([entityId, planetId, codeIndex, labelIndex]) => {
    const entity = entityById.get(entityId);
    const statusCode = projection.codes[codeIndex];
    const reason = projection.labels[labelIndex];
    if (!entity || entity.planetId !== planetId || !statusCode || reason === undefined) return [];
    return [{
      id: `${entity.id}:${statusCode}`,
      severity: isCriticalFactoryAlertCode(statusCode) ? "critical" : "warning",
      statusCode,
      entityId: entity.id,
      planetId: entity.planetId,
      title: entityTitle(entity),
      reason,
      location: `${getPlanet(entity.planetId).name} · ${getPlanet(entity.planetId).code}`,
    } satisfies FactoryAlert];
  }));
}

export function getFactoryAlerts(state: GameState, options: FactoryAlertOptions = {}): FactoryAlert[] {
  if (state.paused) return [];
  const details = options.details !== false;
  return sortFactoryAlerts(state.entities.flatMap((entity): FactoryAlert[] => {
    if (entity.kind === "vein" && entity.minerCount < 1) return [];
    const status = getEntityOperatingStatus(state, entity, options.lookup);
    if (status.tone !== "warning" && status.tone !== "blocked") return [];
    return [{
      id: `${entity.id}:${status.code}`,
      severity: CRITICAL_CODES.has(status.code) ? "critical" : "warning",
      statusCode: status.code,
      entityId: entity.id,
      planetId: entity.planetId,
      title: details ? entityTitle(entity) : "",
      reason: details ? status.label : "",
      location: details ? `${getPlanet(entity.planetId).name} · ${getPlanet(entity.planetId).code}` : "",
    }];
  }));
}
