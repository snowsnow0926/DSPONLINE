import type {
  DesktopNativeCoreCommandPaletteEntitySearchResult,
  DesktopNativeCoreCommandPaletteEntitySearchRow,
} from "../desktop";
import { BUILDINGS, ITEMS, PLANET_LIST, RECIPES } from "./content";
import type { BuildingId, GameState, ItemId, PlanetId, RecipeId } from "./types";

export const COMMAND_PALETTE_ENTITY_SEARCH_LIMITS = Object.freeze({
  queryBytes: 256,
  selectorIds: 256,
  rows: 16,
  requestBytes: 32_768,
  projectionBytes: 1_048_576,
} as const);

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const encoder = new TextEncoder();

export interface CommandPaletteEntitySearchCatalog {
  readonly buildings: readonly { readonly id: string; readonly name: string }[];
  readonly resources: readonly { readonly id: string; readonly name: string }[];
  readonly planets: readonly { readonly id: string; readonly name: string }[];
}

export interface CommandPaletteEntitySearchSelector {
  readonly query: string;
  readonly cursor: number;
  readonly limit: number;
  readonly buildingIds: readonly string[];
  readonly resourceIds: readonly string[];
  readonly planetIds: readonly string[];
  readonly truncated: boolean;
}

export interface CommandPaletteEntitySearchReadModelRow {
  readonly entityId: string;
  readonly buildingId: BuildingId | null;
  readonly resourceId: ItemId | null;
  readonly planetId: PlanetId;
  readonly recipeId: RecipeId | null;
  readonly positionX: number;
  readonly positionY: number;
}

export interface CommandPaletteEntitySearchReadModel {
  readonly schema: "command-palette-entity-search-read-model-v1";
  readonly source: "native-core";
  readonly sessionId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly query: string;
  readonly cursor: number;
  readonly limit: number;
  readonly totalCount: number;
  readonly rows: readonly CommandPaletteEntitySearchReadModelRow[];
  readonly nextCursor: number | null;
}

export interface CommandPaletteNativeEntityTarget {
  readonly sessionId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
  readonly planetId: PlanetId;
  readonly label: string;
  readonly positionX: number;
  readonly positionY: number;
}

export interface CommandPaletteNativeEntityFocusPlan {
  readonly planetId: PlanetId;
  readonly changePlanet: boolean;
  readonly centerX: number;
  readonly centerY: number;
  readonly duration: number;
}

export interface NativeCommandPaletteEntitySearchFrame {
  readonly sessionId: string;
  readonly revision: number;
  readonly selector: CommandPaletteEntitySearchSelector;
  readonly projection: DesktopNativeCoreCommandPaletteEntitySearchResult;
}

export interface NativeCommandPaletteEntitySearchBinding {
  readonly enabled: boolean;
  readonly sessionId: string | null;
  readonly expectedRevision: number;
  readonly expectedRegistryFingerprint: string;
  readonly selector: CommandPaletteEntitySearchSelector;
}

function currentCatalog(): CommandPaletteEntitySearchCatalog {
  return {
    buildings: Object.values(BUILDINGS),
    resources: Object.values(ITEMS),
    planets: PLANET_LIST,
  };
}

function validLogicalId(value: string, maximum = 160): boolean {
  return value.length >= 1 && value.length <= maximum && LOGICAL_ID_PATTERN.test(value);
}

function normalizedQuery(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function selectorRequestBytes(
  query: string,
  cursor: number,
  limit: number,
  buildingIds: readonly string[],
  resourceIds: readonly string[],
  planetIds: readonly string[],
): number {
  return encoder.encode(JSON.stringify({
    operation: "coreCommandPaletteEntitySearchProjection",
    sessionId: "s".repeat(128),
    expectedRevision: Number.MAX_SAFE_INTEGER,
    expectedRegistryFingerprint: "f".repeat(256),
    query,
    cursor,
    limit,
    buildingIds,
    resourceIds,
    planetIds,
  })).byteLength;
}

export function createCommandPaletteEntitySearchSelector(
  rawQuery: string,
  cursor = 0,
  limit = COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.rows,
  catalog: CommandPaletteEntitySearchCatalog = currentCatalog(),
): CommandPaletteEntitySearchSelector {
  const query = normalizedQuery(rawQuery);
  const buildingIds: string[] = [];
  const resourceIds: string[] = [];
  const planetIds: string[] = [];
  let selectorCount = 0;
  let truncated = query.length < 2 || encoder.encode(query).byteLength > COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.queryBytes ||
    /[\u0000-\u001f\u007f]/.test(query) ||
    !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) ||
    limit < 1 || limit > COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.rows;
  const collect = (
    values: readonly { readonly id: string; readonly name: string }[],
    output: string[],
  ) => {
    const seen = new Set<string>();
    for (const value of values) {
      if (!validLogicalId(value.id)) {
        truncated = true;
        return;
      }
      if (!value.name.toLocaleLowerCase("zh-CN").includes(query)) continue;
      if (seen.has(value.id)) {
        truncated = true;
        return;
      }
      seen.add(value.id);
      selectorCount += 1;
      if (selectorCount > COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.selectorIds) {
        truncated = true;
        return;
      }
      output.push(value.id);
    }
    output.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  };
  if (!truncated) {
    collect(catalog.buildings, buildingIds);
    if (!truncated) collect(catalog.resources, resourceIds);
    if (!truncated) collect(catalog.planets, planetIds);
  }
  if (selectorRequestBytes(query, cursor, limit, buildingIds, resourceIds, planetIds) >
      COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.requestBytes) {
    truncated = true;
  }
  return Object.freeze({
    query,
    cursor,
    limit,
    buildingIds: Object.freeze(buildingIds),
    resourceIds: Object.freeze(resourceIds),
    planetIds: Object.freeze(planetIds),
    truncated,
  });
}

export function validCommandPaletteEntitySearchSelector(
  selector: CommandPaletteEntitySearchSelector,
): boolean {
  if (selector.truncated || selector.query.length < 2 ||
      encoder.encode(selector.query).byteLength > COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.queryBytes ||
      selector.query !== normalizedQuery(selector.query) ||
      /[\u0000-\u001f\u007f]/.test(selector.query) ||
      !Number.isSafeInteger(selector.cursor) || selector.cursor < 0 ||
      !Number.isSafeInteger(selector.limit) || selector.limit < 1 ||
      selector.limit > COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.rows) return false;
  const arrays = [selector.buildingIds, selector.resourceIds, selector.planetIds];
  if (arrays.reduce((sum, values) => sum + values.length, 0) > COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.selectorIds) return false;
  return arrays.every((values) => values.every((id, index) =>
    validLogicalId(id) && (index === 0 || values[index - 1] < id))) &&
    selectorRequestBytes(
      selector.query,
      selector.cursor,
      selector.limit,
      selector.buildingIds,
      selector.resourceIds,
      selector.planetIds,
    ) <= COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.requestBytes;
}

export function commandPaletteEntitySearchSelectorsEqual(
  left: CommandPaletteEntitySearchSelector,
  right: CommandPaletteEntitySearchSelector,
): boolean {
  return left.query === right.query && left.cursor === right.cursor && left.limit === right.limit &&
    left.truncated === right.truncated &&
    left.buildingIds.length === right.buildingIds.length &&
    left.resourceIds.length === right.resourceIds.length &&
    left.planetIds.length === right.planetIds.length &&
    left.buildingIds.every((id, index) => id === right.buildingIds[index]) &&
    left.resourceIds.every((id, index) => id === right.resourceIds[index]) &&
    left.planetIds.every((id, index) => id === right.planetIds[index]);
}

function exactIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function knownRow(row: DesktopNativeCoreCommandPaletteEntitySearchRow): boolean {
  return (row.buildingId === null || Object.hasOwn(BUILDINGS, row.buildingId)) &&
    (row.resourceId === null || Object.hasOwn(ITEMS, row.resourceId)) &&
    PLANET_LIST.some((planet) => planet.id === row.planetId) &&
    (row.recipeId === null || Object.hasOwn(RECIPES, row.recipeId)) &&
    Number.isFinite(row.positionX) && Math.abs(row.positionX) <= 10_000_000 &&
    Number.isFinite(row.positionY) && Math.abs(row.positionY) <= 10_000_000;
}

export function createCommandPaletteNativeEntityFocusPlan(
  game: Pick<GameState, "activePlanetId" | "settings">,
  target: CommandPaletteNativeEntityTarget,
  authority: { readonly sessionId: string | null; readonly revision: number | null } | null,
  currentRegistryFingerprint: string,
): CommandPaletteNativeEntityFocusPlan | null {
  if (!authority || !authority.sessionId || authority.sessionId !== target.sessionId ||
      authority.revision !== target.revision ||
      currentRegistryFingerprint !== target.registryFingerprint ||
      !Number.isFinite(target.positionX) || Math.abs(target.positionX) > 10_000_000 ||
      !Number.isFinite(target.positionY) || Math.abs(target.positionY) > 10_000_000) return null;
  return Object.freeze({
    planetId: target.planetId,
    changePlanet: game.activePlanetId !== target.planetId,
    centerX: target.positionX + 128,
    centerY: target.positionY + 90,
    duration: game.settings.reducedMotion ? 0 : 260,
  });
}

export function selectNativeCommandPaletteEntitySearchReadModel(
  frame: NativeCommandPaletteEntitySearchFrame | null,
  binding: NativeCommandPaletteEntitySearchBinding,
): CommandPaletteEntitySearchReadModel | null {
  if (!frame || !binding.enabled || !binding.sessionId || binding.selector.truncated ||
      frame.sessionId !== binding.sessionId || frame.revision !== binding.expectedRevision ||
      frame.projection.revision !== binding.expectedRevision ||
      frame.projection.registryFingerprint !== binding.expectedRegistryFingerprint ||
      !commandPaletteEntitySearchSelectorsEqual(frame.selector, binding.selector)) return null;
  const projection = frame.projection;
  if (projection.schemaVersion !== 1 || projection.projectionType !== "command-palette-entity-search-v1" ||
      projection.limits.queryBytes !== COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.queryBytes ||
      projection.limits.selectorIds !== COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.selectorIds ||
      projection.limits.rows !== COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.rows ||
      projection.limits.requestBytes !== COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.requestBytes ||
      projection.limits.projectionBytes !== COMMAND_PALETTE_ENTITY_SEARCH_LIMITS.projectionBytes ||
      projection.request.query !== binding.selector.query ||
      projection.request.cursor !== binding.selector.cursor ||
      projection.request.limit !== binding.selector.limit ||
      !exactIds(projection.request.buildingIds, binding.selector.buildingIds) ||
      !exactIds(projection.request.resourceIds, binding.selector.resourceIds) ||
      !exactIds(projection.request.planetIds, binding.selector.planetIds) ||
      projection.rows.length !== Math.min(projection.request.limit, projection.totalCount - projection.request.cursor) ||
      projection.rows.some((row) => !knownRow(row)) ||
      new Set(projection.rows.map((row) => row.entityId)).size !== projection.rows.length) return null;
  const consumed = projection.request.cursor + projection.rows.length;
  if (projection.request.cursor > projection.totalCount ||
      projection.nextCursor !== (consumed < projection.totalCount ? consumed : null)) return null;
  return Object.freeze({
    schema: "command-palette-entity-search-read-model-v1",
    source: "native-core",
    sessionId: frame.sessionId,
    revision: projection.revision,
    registryFingerprint: projection.registryFingerprint,
    query: projection.request.query,
    cursor: projection.request.cursor,
    limit: projection.request.limit,
    totalCount: projection.totalCount,
    rows: Object.freeze(projection.rows.map((row) => Object.freeze({
      entityId: row.entityId,
      buildingId: row.buildingId as BuildingId | null,
      resourceId: row.resourceId as ItemId | null,
      planetId: row.planetId as PlanetId,
      recipeId: row.recipeId as RecipeId | null,
      positionX: row.positionX,
      positionY: row.positionY,
    }))),
    nextCursor: projection.nextCursor,
  });
}
