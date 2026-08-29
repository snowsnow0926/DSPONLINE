import type {
  DesktopBridge,
  DesktopNativeCoreStarMapOverviewProjectionRequest,
  DesktopNativeCoreStarMapOverviewProjectionResult,
  DesktopNativeCoreStarMapSystemRow,
  DesktopNativeCoreStellarIndustryPlanetRow,
  DesktopNativeCoreStellarIndustryProjectionRequest,
  DesktopNativeCoreStellarIndustryProjectionResult,
  DesktopNativeCoreStellarIndustryRouteRow,
  DesktopNativeCoreStellarIndustryStationRow,
  DesktopNativeCoreStellarIndustryV2ProjectionRequest,
  DesktopNativeCoreStellarIndustryV2ProjectionResult,
  DesktopNativeCoreStellarQuantumCollectorRow,
  DesktopNativeCoreStellarQuantumItemRow,
  DesktopNativeCoreStellarQuantumProjectionRequest,
  DesktopNativeCoreStellarQuantumProjectionResult,
  DesktopNativeCoreStellarRouteFilter,
} from "../desktop";

export const NATIVE_STELLAR_PAGE_ROWS = 64 as const;
export const NATIVE_STELLAR_ROUTE_QUERY_BYTES = 512 as const;
export const NATIVE_STELLAR_MAX_COMPLETE_PAGES = 128 as const;
export const NATIVE_STELLAR_MAX_SYSTEM_ROWS = 4_096 as const;
export const NATIVE_STELLAR_MAX_PLANET_ROWS = 4_096 as const;
export const NATIVE_STELLAR_MAX_STATION_ROWS = 8_192 as const;
export const NATIVE_STELLAR_MAX_ROUTE_ROWS = 8_192 as const;
export const NATIVE_STELLAR_MAX_QUANTUM_ITEM_ROWS = 4_096 as const;
export const NATIVE_STELLAR_MAX_QUANTUM_COLLECTOR_ROWS = 8_192 as const;
export const NATIVE_STELLAR_OVERVIEW_PAGE_CACHE_ENTRIES = 64 as const;
export const NATIVE_STELLAR_INDUSTRY_PAGE_CACHE_ENTRIES = 192 as const;
export const NATIVE_STELLAR_QUANTUM_PAGE_CACHE_ENTRIES = 192 as const;

export interface NativeStellarProjectionIdentity {
  readonly sessionId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export type NativeStarMapOverviewSelector = Pick<
  DesktopNativeCoreStarMapOverviewProjectionRequest,
  "cursor" | "limit"
>;

/** Base planet/station selector retained for the current untouched App call site. */
export type NativeStellarIndustryBaseSelector = Pick<
  DesktopNativeCoreStellarIndustryProjectionRequest,
  "systemId" | "planetId" | "planetCursor" | "planetLimit" | "stationCursor" | "stationLimit"
>;

export type NativeStellarIndustrySelector = Pick<
  DesktopNativeCoreStellarIndustryV2ProjectionRequest,
  | "systemId"
  | "planetId"
  | "planetCursor"
  | "planetLimit"
  | "stationCursor"
  | "stationLimit"
  | "routeCursor"
  | "routeLimit"
  | "routeFilter"
  | "query"
>;

export type NativeStellarQuantumSelector = Pick<
  DesktopNativeCoreStellarQuantumProjectionRequest,
  "itemCursor" | "itemLimit" | "collectorCursor" | "collectorLimit"
>;

export const DEFAULT_NATIVE_STELLAR_QUANTUM_SELECTOR: NativeStellarQuantumSelector = Object.freeze({
  itemCursor: 0,
  itemLimit: NATIVE_STELLAR_PAGE_ROWS,
  collectorCursor: 0,
  collectorLimit: NATIVE_STELLAR_PAGE_ROWS,
});

export const DEFAULT_NATIVE_STELLAR_ROUTE_SELECTOR = Object.freeze({
  routeCursor: 0,
  routeLimit: NATIVE_STELLAR_PAGE_ROWS,
  routeFilter: "all" as DesktopNativeCoreStellarRouteFilter,
  query: "",
});

export type NativeStellarSourceMode = "player-authority" | "shadow";

export interface NativeStellarWorkspaceSource {
  readonly mode: NativeStellarSourceMode;
  readonly boundIdentity?: NativeStellarProjectionIdentity;
  readVerifiedStarMapOverviewProjection(
    request: NativeStarMapOverviewSelector,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreStarMapOverviewProjectionResult | null>;
  readVerifiedStellarIndustryV2Projection?: (
    request: NativeStellarIndustrySelector,
    expectedRevision: number,
  ) => Promise<DesktopNativeCoreStellarIndustryV2ProjectionResult | null>;
  readVerifiedStellarQuantumProjection?: (
    request: NativeStellarQuantumSelector,
    expectedRevision: number,
  ) => Promise<DesktopNativeCoreStellarQuantumProjectionResult | null>;
  /** Only an explicitly shadow-mode source may expose or use this legacy reader. */
  readVerifiedStellarIndustryProjection?: (
    request: NativeStellarIndustryBaseSelector,
    expectedRevision: number,
  ) => Promise<DesktopNativeCoreStellarIndustryProjectionResult | null>;
}

export interface NativeShadowStellarProjectionReader {
  readVerifiedStarMapOverviewProjection(
    request: NativeStarMapOverviewSelector,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreStarMapOverviewProjectionResult | null>;
  readVerifiedStellarIndustryV2Projection?: (
    request: NativeStellarIndustrySelector,
    expectedRevision: number,
  ) => Promise<DesktopNativeCoreStellarIndustryV2ProjectionResult | null>;
  readVerifiedStellarIndustryProjection?: (
    request: NativeStellarIndustryBaseSelector,
    expectedRevision: number,
  ) => Promise<DesktopNativeCoreStellarIndustryProjectionResult | null>;
  readVerifiedStellarQuantumProjection?: (
    request: NativeStellarQuantumSelector,
    expectedRevision: number,
  ) => Promise<DesktopNativeCoreStellarQuantumProjectionResult | null>;
}

export interface NativeStarMapOverviewFrame extends NativeStellarProjectionIdentity {
  readonly sourceMode: NativeStellarSourceMode;
  /** First verified protocol page, kept for the current workspace compatibility surface. */
  readonly projection: DesktopNativeCoreStarMapOverviewProjectionResult;
  readonly selector: NativeStarMapOverviewSelector;
  readonly systems: readonly DesktopNativeCoreStarMapSystemRow[];
  readonly systemRowsById: ReadonlyMap<string, DesktopNativeCoreStarMapSystemRow>;
}

export interface NativeStellarIndustryFrame extends NativeStellarProjectionIdentity {
  readonly sourceMode: NativeStellarSourceMode;
  readonly sourceVersion: 1 | 2;
  /**
   * A verified v1 page or a v1-compatible base view derived only from the first
   * verified v2 page. It never triggers a v1 player-authority request.
   */
  readonly projection: DesktopNativeCoreStellarIndustryProjectionResult;
  readonly projectionV2: DesktopNativeCoreStellarIndustryV2ProjectionResult | null;
  readonly selector: NativeStellarIndustrySelector;
  readonly planets: readonly DesktopNativeCoreStellarIndustryPlanetRow[];
  readonly stations: readonly DesktopNativeCoreStellarIndustryStationRow[];
  readonly routes: readonly DesktopNativeCoreStellarIndustryRouteRow[] | null;
  readonly routeSummary: DesktopNativeCoreStellarIndustryV2ProjectionResult["routeSummary"] | null;
  readonly planetRowsById: ReadonlyMap<string, DesktopNativeCoreStellarIndustryPlanetRow>;
  readonly stationRowsById: ReadonlyMap<string, DesktopNativeCoreStellarIndustryStationRow>;
  readonly routeRowsById: ReadonlyMap<string, DesktopNativeCoreStellarIndustryRouteRow> | null;
  readonly routeRowsByTargetStationId: ReadonlyMap<string, readonly DesktopNativeCoreStellarIndustryRouteRow[]> | null;
}

export interface NativeStellarQuantumFrame extends NativeStellarProjectionIdentity {
  readonly sourceMode: NativeStellarSourceMode;
  readonly projection: DesktopNativeCoreStellarQuantumProjectionResult;
  readonly selector: NativeStellarQuantumSelector;
  readonly items: readonly DesktopNativeCoreStellarQuantumItemRow[];
  readonly collectors: readonly DesktopNativeCoreStellarQuantumCollectorRow[];
  readonly itemRowsById: ReadonlyMap<string, DesktopNativeCoreStellarQuantumItemRow>;
  readonly collectorRowsById: ReadonlyMap<string, DesktopNativeCoreStellarQuantumCollectorRow>;
  readonly collectorRowsBySystemId: ReadonlyMap<string, readonly DesktopNativeCoreStellarQuantumCollectorRow[]>;
}

interface NativeStellarWorkspaceSection<TFrame> {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly frame: TFrame | null;
}

export interface NativeStellarWorkspaceSnapshot {
  readonly overview: NativeStellarWorkspaceSection<NativeStarMapOverviewFrame>;
  readonly industry: NativeStellarWorkspaceSection<NativeStellarIndustryFrame>;
  readonly quantum: NativeStellarWorkspaceSection<NativeStellarQuantumFrame>;
}

export interface NativeStellarQuantumReadModel extends NativeStellarProjectionIdentity {
  readonly source: "native-core";
  readonly sourceMode: "player-authority";
  readonly enabled: boolean;
  readonly bandwidth: DesktopNativeCoreStellarQuantumProjectionResult["bandwidth"];
  readonly runtime: DesktopNativeCoreStellarQuantumProjectionResult["runtime"];
  readonly collectorSummary: DesktopNativeCoreStellarQuantumProjectionResult["collectorSummary"];
  readonly items: readonly DesktopNativeCoreStellarQuantumItemRow[];
  readonly collectors: readonly DesktopNativeCoreStellarQuantumCollectorRow[];
  readonly itemRowsById: ReadonlyMap<string, DesktopNativeCoreStellarQuantumItemRow>;
  readonly collectorRowsById: ReadonlyMap<string, DesktopNativeCoreStellarQuantumCollectorRow>;
  readonly collectorRowsBySystemId: ReadonlyMap<string, readonly DesktopNativeCoreStellarQuantumCollectorRow[]>;
}

export interface NativeStarMapWorkspaceReadModel extends NativeStellarProjectionIdentity {
  readonly source: "native-core";
  readonly sourceMode: NativeStellarSourceMode;
  readonly activePlanetId: string;
  readonly activeSystemId: string;
  readonly galaxySeed: number;
  readonly summary: DesktopNativeCoreStarMapOverviewProjectionResult["summary"];
  readonly routeSummary: DesktopNativeCoreStellarIndustryV2ProjectionResult["routeSummary"];
  readonly systems: readonly DesktopNativeCoreStarMapSystemRow[];
  readonly planets: readonly DesktopNativeCoreStellarIndustryPlanetRow[];
  readonly stations: readonly DesktopNativeCoreStellarIndustryStationRow[];
  readonly routes: readonly DesktopNativeCoreStellarIndustryRouteRow[];
  readonly systemRowsById: ReadonlyMap<string, DesktopNativeCoreStarMapSystemRow>;
  readonly planetRowsById: ReadonlyMap<string, DesktopNativeCoreStellarIndustryPlanetRow>;
  readonly stationRowsById: ReadonlyMap<string, DesktopNativeCoreStellarIndustryStationRow>;
  readonly routeRowsById: ReadonlyMap<string, DesktopNativeCoreStellarIndustryRouteRow>;
  readonly routeRowsByTargetStationId: ReadonlyMap<string, readonly DesktopNativeCoreStellarIndustryRouteRow[]>;
}

export interface NativeShadowStarMapWorkspaceReadModel extends Omit<
  NativeStarMapWorkspaceReadModel,
  "routeSummary" | "routes" | "routeRowsById" | "routeRowsByTargetStationId"
> {
  readonly routeSummary: DesktopNativeCoreStellarIndustryV2ProjectionResult["routeSummary"] | null;
  readonly routes: readonly DesktopNativeCoreStellarIndustryRouteRow[] | null;
  readonly routeRowsById: ReadonlyMap<string, DesktopNativeCoreStellarIndustryRouteRow> | null;
  readonly routeRowsByTargetStationId: ReadonlyMap<string, readonly DesktopNativeCoreStellarIndustryRouteRow[]> | null;
}

type RefreshResult = "committed" | "superseded" | "unavailable";
type OverviewReadResult = { readonly status: "ready"; readonly frame: NativeStarMapOverviewFrame } |
  { readonly status: "superseded" } | { readonly status: "unavailable" };
type IndustryReadResult = { readonly status: "ready"; readonly frame: NativeStellarIndustryFrame } |
  { readonly status: "superseded" } | { readonly status: "unavailable" };
type QuantumReadResult = { readonly status: "ready"; readonly frame: NativeStellarQuantumFrame } |
  { readonly status: "superseded" } | { readonly status: "unavailable" };

const LOGICAL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const ROUTE_FILTERS = new Set<DesktopNativeCoreStellarRouteFilter>(["all", "remote", "issues"]);
const STELLAR_LIMITS = Object.freeze({
  requestBytes: 32_768,
  projectionBytes: 1_048_576,
  pageRows: NATIVE_STELLAR_PAGE_ROWS,
  labelBytes: 512,
});
const STELLAR_QUANTUM_LIMITS = Object.freeze({
  requestBytes: 32_768,
  projectionBytes: 1_048_576,
  pageRows: NATIVE_STELLAR_PAGE_ROWS,
  decimalDigits: 256,
});
const QUANTUM_CAPACITY_MIN = 10_000;
const QUANTUM_CAPACITY_MAX = 10_000_000_000;
const EMPTY_SNAPSHOT: NativeStellarWorkspaceSnapshot = Object.freeze({
  overview: Object.freeze({ status: "empty", requestedRevision: null, frame: null }),
  industry: Object.freeze({ status: "empty", requestedRevision: null, frame: null }),
  quantum: Object.freeze({ status: "empty", requestedRevision: null, frame: null }),
});

class BoundedLruCache<T> {
  private readonly values = new Map<string, T>();

  constructor(private readonly maximumEntries: number) {}

  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.maximumEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  clear(): void {
    this.values.clear();
  }
}

function validLogicalId(value: string | null | undefined, maximum = 256): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum &&
    LOGICAL_ID_PATTERN.test(value);
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string") &&
    expected.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key));
}

function validPage(cursor: number, limit: number): boolean {
  return Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= 0xffff_ffff &&
    Number.isSafeInteger(limit) && limit >= 1 && limit <= NATIVE_STELLAR_PAGE_ROWS;
}

function validNullableLogicalId(value: string | null): boolean {
  return value === null || validLogicalId(value);
}

function validRouteQuery(value: string): boolean {
  return typeof value === "string" && new TextEncoder().encode(value).byteLength <= NATIVE_STELLAR_ROUTE_QUERY_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function identitiesEqual(
  left: NativeStellarProjectionIdentity | undefined,
  right: NativeStellarProjectionIdentity,
): boolean {
  return left?.sessionId === right.sessionId && left.revision === right.revision &&
    left.registryFingerprint === right.registryFingerprint;
}

function identityKey(identity: NativeStellarProjectionIdentity): string {
  return `${identity.sessionId}\u0000${identity.revision}\u0000${identity.registryFingerprint}`;
}

function exactLimits(
  limits: DesktopNativeCoreStarMapOverviewProjectionResult["limits"],
): boolean {
  return limits.requestBytes === STELLAR_LIMITS.requestBytes &&
    limits.projectionBytes === STELLAR_LIMITS.projectionBytes &&
    limits.pageRows === STELLAR_LIMITS.pageRows && limits.labelBytes === STELLAR_LIMITS.labelBytes;
}

function exactV2Limits(
  limits: DesktopNativeCoreStellarIndustryV2ProjectionResult["limits"],
): boolean {
  return exactLimits(limits) && limits.queryBytes === NATIVE_STELLAR_ROUTE_QUERY_BYTES &&
    limits.pathVisits === 200_000;
}

function exactQuantumLimits(
  limits: DesktopNativeCoreStellarQuantumProjectionResult["limits"],
): boolean {
  return limits.requestBytes === STELLAR_QUANTUM_LIMITS.requestBytes &&
    limits.projectionBytes === STELLAR_QUANTUM_LIMITS.projectionBytes &&
    limits.pageRows === STELLAR_QUANTUM_LIMITS.pageRows &&
    limits.decimalDigits === STELLAR_QUANTUM_LIMITS.decimalDigits;
}

function exactPage<Row>(
  page: { cursor: number; limit: number; totalCount: number; nextCursor: number | null; rows: Row[] },
  cursor: number,
  limit: number,
  maximumRows: number,
): boolean {
  if (!validPage(page.cursor, page.limit) || page.cursor !== cursor || page.limit !== limit ||
      !Number.isSafeInteger(page.totalCount) || page.totalCount < cursor || page.totalCount > maximumRows ||
      !Array.isArray(page.rows)) return false;
  const expectedRows = Math.min(limit, page.totalCount - cursor);
  if (page.rows.length !== expectedRows) return false;
  const consumed = cursor + page.rows.length;
  return page.nextCursor === (consumed < page.totalCount ? consumed : null);
}

function canonicalQuantumDecimal(value: string): boolean {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= STELLAR_QUANTUM_LIMITS.decimalDigits && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function quantumCapacity(value: string): boolean {
  if (!canonicalQuantumDecimal(value) || value.length > 11) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= QUANTUM_CAPACITY_MIN && number <= QUANTUM_CAPACITY_MAX;
}

function nonNegativeFinite(value: number, minimum = 0): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactQuantumRequest(
  result: DesktopNativeCoreStellarQuantumProjectionResult,
  revision: number,
  registryFingerprint: string,
  selector: NativeStellarQuantumSelector,
): boolean {
  if (result === null || typeof result !== "object" ||
      !exactKeys(result, [
        "schemaVersion", "projectionType", "revision", "registryFingerprint", "stateVersion",
        "limits", "request", "enabled", "bandwidth", "runtime", "collectorSummary",
        "truncated", "items", "collectors",
      ]) || result.schemaVersion !== 1 || result.projectionType !== "stellar-quantum-v1" ||
      result.stateVersion !== 47 || result.revision !== revision ||
      result.registryFingerprint !== registryFingerprint || !exactQuantumLimits(result.limits) ||
      !exactKeys(result.limits, ["requestBytes", "projectionBytes", "pageRows", "decimalDigits"]) ||
      !exactKeys(result.request, [
        "expectedRevision", "expectedRegistryFingerprint", "itemCursor", "itemLimit",
        "collectorCursor", "collectorLimit",
      ]) || result.request.expectedRevision !== revision ||
      result.request.expectedRegistryFingerprint !== registryFingerprint ||
      result.request.itemCursor !== selector.itemCursor || result.request.itemLimit !== selector.itemLimit ||
      result.request.collectorCursor !== selector.collectorCursor ||
      result.request.collectorLimit !== selector.collectorLimit || typeof result.enabled !== "boolean" ||
      !exactKeys(result.items, ["cursor", "limit", "totalCount", "nextCursor", "rows"]) ||
      !exactKeys(result.collectors, ["cursor", "limit", "totalCount", "nextCursor", "rows"]) ||
      !exactPage(result.items, selector.itemCursor, selector.itemLimit, NATIVE_STELLAR_MAX_QUANTUM_ITEM_ROWS) ||
      !exactPage(
        result.collectors,
        selector.collectorCursor,
        selector.collectorLimit,
        NATIVE_STELLAR_MAX_QUANTUM_COLLECTOR_ROWS,
      )) return false;

  const itemIds = new Set<string>();
  for (const row of result.items.rows) {
    if (row === null || typeof row !== "object" ||
        !exactKeys(row, ["itemId", "inventory", "capacity", "uploaded", "downloaded"]) ||
        !validLogicalId(row.itemId) || itemIds.has(row.itemId) ||
        !canonicalQuantumDecimal(row.inventory) || !quantumCapacity(row.capacity) ||
        !canonicalQuantumDecimal(row.uploaded) || !canonicalQuantumDecimal(row.downloaded)) return false;
    itemIds.add(row.itemId);
  }

  const collectorIds = new Set<string>();
  for (const row of result.collectors.rows) {
    if (row === null || typeof row !== "object" || !exactKeys(row, [
      "collectorId", "planetId", "systemId", "machineCount", "quantumMode",
      "quantumTransitionActive", "attachmentState",
    ]) || !validLogicalId(row.collectorId) || collectorIds.has(row.collectorId) ||
        !validLogicalId(row.planetId) || !validLogicalId(row.systemId) ||
        !nonNegativeSafeInteger(row.machineCount) ||
        !["legacy", "transitioning", "quantum"].includes(row.quantumMode) ||
        typeof row.quantumTransitionActive !== "boolean" ||
        !["available", "pending", "connected", "unavailable"].includes(row.attachmentState)) return false;
    const expectedAttachment = row.quantumMode === "quantum"
      ? "connected"
      : row.quantumMode === "transitioning"
        ? "pending"
        : row.quantumTransitionActive
          ? "unavailable"
          : "available";
    if (row.attachmentState !== expectedAttachment ||
        row.quantumMode === "transitioning" && !row.quantumTransitionActive) return false;
    collectorIds.add(row.collectorId);
  }

  const bandwidth = result.bandwidth;
  if (!exactKeys(bandwidth, [
    "multiplier", "globalUploadPerMinute", "globalDownloadPerMinute", "activeTowerCount",
    "activeTowerStacks",
  ]) || !nonNegativeFinite(bandwidth.multiplier, 1) ||
      !nonNegativeFinite(bandwidth.globalUploadPerMinute) ||
      !nonNegativeFinite(bandwidth.globalDownloadPerMinute) ||
      bandwidth.globalUploadPerMinute !== bandwidth.globalDownloadPerMinute ||
      !nonNegativeSafeInteger(bandwidth.activeTowerCount) ||
      !nonNegativeSafeInteger(bandwidth.activeTowerStacks) ||
      bandwidth.activeTowerCount > bandwidth.activeTowerStacks) return false;

  if (result.runtime !== null) {
    const runtime = result.runtime;
    if (!exactKeys(runtime, [
      "boundarySecond", "globalUploadPerMinute", "globalDownloadPerMinute",
      "quantumTowerStacks", "quantumCollectorStacks",
    ]) || !nonNegativeSafeInteger(runtime.boundarySecond) ||
        !nonNegativeFinite(runtime.globalUploadPerMinute) ||
        !nonNegativeFinite(runtime.globalDownloadPerMinute) ||
        !nonNegativeSafeInteger(runtime.quantumTowerStacks) ||
        !nonNegativeSafeInteger(runtime.quantumCollectorStacks)) return false;
  }

  const summary = result.collectorSummary;
  if (!exactKeys(summary, [
    "totalCount", "connectedCount", "pendingCount", "availableCount", "connectedStacks",
  ]) || !nonNegativeSafeInteger(summary.totalCount) ||
      !nonNegativeSafeInteger(summary.connectedCount) || !nonNegativeSafeInteger(summary.pendingCount) ||
      !nonNegativeSafeInteger(summary.availableCount) || !nonNegativeSafeInteger(summary.connectedStacks) ||
      summary.totalCount !== result.collectors.totalCount ||
      summary.connectedCount + summary.pendingCount + summary.availableCount > summary.totalCount ||
      summary.connectedCount > summary.connectedStacks || typeof result.truncated !== "boolean" ||
      result.truncated !== (result.items.nextCursor !== null || result.collectors.nextCursor !== null)) return false;
  return true;
}

function exactStatusCounts(
  left: DesktopNativeCoreStellarIndustryV2ProjectionResult["routeSummary"]["statusCounts"],
  right: DesktopNativeCoreStellarIndustryV2ProjectionResult["routeSummary"]["statusCounts"],
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) =>
    left[key as keyof typeof left] === right[key as keyof typeof right]);
}

function exactRouteSummary(
  left: DesktopNativeCoreStellarIndustryV2ProjectionResult["routeSummary"],
  right: DesktopNativeCoreStellarIndustryV2ProjectionResult["routeSummary"],
): boolean {
  return left.scopeTotalCount === right.scopeTotalCount && left.filteredCount === right.filteredCount &&
    left.activeCount === right.activeCount && left.blockedCount === right.blockedCount &&
    left.remoteCount === right.remoteCount &&
    left.routePlanningIncompleteCount === right.routePlanningIncompleteCount &&
    left.powerUnprovenCount === right.powerUnprovenCount &&
    exactStatusCounts(left.statusCounts, right.statusCounts);
}

function exactOverviewRequest(
  result: DesktopNativeCoreStarMapOverviewProjectionResult,
  revision: number,
  registryFingerprint: string,
  selector: NativeStarMapOverviewSelector,
): boolean {
  return result.schemaVersion === 1 && result.projectionType === "star-map-overview-v1" &&
    result.stateVersion === 47 && result.revision === revision &&
    result.registryFingerprint === registryFingerprint && exactLimits(result.limits) &&
    exactKeys(result.request, ["expectedRevision", "expectedRegistryFingerprint", "cursor", "limit"]) &&
    result.request.expectedRevision === revision &&
    result.request.expectedRegistryFingerprint === registryFingerprint &&
    result.request.cursor === selector.cursor && result.request.limit === selector.limit &&
    exactPage(result.systems, selector.cursor, selector.limit, NATIVE_STELLAR_MAX_SYSTEM_ROWS) &&
    result.systems.totalCount === result.summary.systemCount;
}

function exactIndustryScope(
  scopeSystemId: string | null,
  scopePlanetId: string | null,
  selector: Pick<NativeStellarIndustryBaseSelector, "systemId" | "planetId">,
): boolean {
  return scopePlanetId === selector.planetId &&
    (selector.systemId !== null
      ? scopeSystemId === selector.systemId
      : selector.planetId === null
        ? scopeSystemId === null
        : scopeSystemId !== null);
}

function exactIndustryBaseRequest(
  result: DesktopNativeCoreStellarIndustryProjectionResult,
  revision: number,
  registryFingerprint: string,
  selector: NativeStellarIndustryBaseSelector,
): boolean {
  const anyNext = result.planets.nextCursor !== null || result.stations.nextCursor !== null;
  return result.schemaVersion === 1 && result.projectionType === "stellar-industry-v1" &&
    result.stateVersion === 47 && result.revision === revision &&
    result.registryFingerprint === registryFingerprint && exactLimits(result.limits) &&
    exactKeys(result.request, [
      "expectedRevision", "expectedRegistryFingerprint", "systemId", "planetId",
      "planetCursor", "planetLimit", "stationCursor", "stationLimit",
    ]) &&
    result.request.expectedRevision === revision &&
    result.request.expectedRegistryFingerprint === registryFingerprint &&
    result.request.systemId === selector.systemId && result.request.planetId === selector.planetId &&
    result.request.planetCursor === selector.planetCursor && result.request.planetLimit === selector.planetLimit &&
    result.request.stationCursor === selector.stationCursor && result.request.stationLimit === selector.stationLimit &&
    exactIndustryScope(result.scopeSystemId, result.scopePlanetId, selector) &&
    exactPage(result.planets, selector.planetCursor, selector.planetLimit, NATIVE_STELLAR_MAX_PLANET_ROWS) &&
    exactPage(result.stations, selector.stationCursor, selector.stationLimit, NATIVE_STELLAR_MAX_STATION_ROWS) &&
    result.truncated === anyNext;
}

function exactIndustryV2Request(
  result: DesktopNativeCoreStellarIndustryV2ProjectionResult,
  revision: number,
  registryFingerprint: string,
  selector: NativeStellarIndustrySelector,
): boolean {
  const anyNext = result.planets.nextCursor !== null || result.stations.nextCursor !== null ||
    result.routes.nextCursor !== null;
  return result.schemaVersion === 2 && result.projectionType === "stellar-industry-v2" &&
    result.stateVersion === 47 && result.revision === revision &&
    result.registryFingerprint === registryFingerprint && exactV2Limits(result.limits) &&
    exactKeys(result.request, [
      "expectedRevision", "expectedRegistryFingerprint", "systemId", "planetId",
      "planetCursor", "planetLimit", "stationCursor", "stationLimit", "routeCursor",
      "routeLimit", "routeFilter", "query",
    ]) &&
    result.request.expectedRevision === revision &&
    result.request.expectedRegistryFingerprint === registryFingerprint &&
    result.request.systemId === selector.systemId && result.request.planetId === selector.planetId &&
    result.request.planetCursor === selector.planetCursor && result.request.planetLimit === selector.planetLimit &&
    result.request.stationCursor === selector.stationCursor && result.request.stationLimit === selector.stationLimit &&
    result.request.routeCursor === selector.routeCursor && result.request.routeLimit === selector.routeLimit &&
    result.request.routeFilter === selector.routeFilter && result.request.query === selector.query &&
    exactIndustryScope(result.scopeSystemId, result.scopePlanetId, selector) &&
    exactPage(result.planets, selector.planetCursor, selector.planetLimit, NATIVE_STELLAR_MAX_PLANET_ROWS) &&
    exactPage(result.stations, selector.stationCursor, selector.stationLimit, NATIVE_STELLAR_MAX_STATION_ROWS) &&
    exactPage(result.routes, selector.routeCursor, selector.routeLimit, NATIVE_STELLAR_MAX_ROUTE_ROWS) &&
    result.routeSummary.filteredCount === result.routes.totalCount && result.truncated === anyNext;
}

function sameOverviewIdentity(
  first: DesktopNativeCoreStarMapOverviewProjectionResult,
  page: DesktopNativeCoreStarMapOverviewProjectionResult,
): boolean {
  return page.activePlanetId === first.activePlanetId && page.activeSystemId === first.activeSystemId &&
    page.galaxySeed === first.galaxySeed && page.systems.totalCount === first.systems.totalCount &&
    page.summary.systemCount === first.summary.systemCount &&
    page.summary.unlockedSystemCount === first.summary.unlockedSystemCount &&
    page.summary.planetCount === first.summary.planetCount &&
    page.summary.colonizedPlanetCount === first.summary.colonizedPlanetCount &&
    page.summary.stationCount === first.summary.stationCount;
}

type IndustryBaseIdentity = Pick<
  DesktopNativeCoreStellarIndustryProjectionResult,
  "activePlanetId" | "activeSystemId" | "scopeSystemId" | "scopePlanetId" | "planets" | "stations"
>;

function sameIndustryBaseIdentity(
  first: IndustryBaseIdentity,
  page: IndustryBaseIdentity,
): boolean {
  return page.activePlanetId === first.activePlanetId && page.activeSystemId === first.activeSystemId &&
    page.scopeSystemId === first.scopeSystemId && page.scopePlanetId === first.scopePlanetId &&
    page.planets.totalCount === first.planets.totalCount &&
    page.stations.totalCount === first.stations.totalCount;
}

function sameIndustryV2Identity(
  first: DesktopNativeCoreStellarIndustryV2ProjectionResult,
  page: DesktopNativeCoreStellarIndustryV2ProjectionResult,
): boolean {
  return sameIndustryBaseIdentity(first, page) && page.routes.totalCount === first.routes.totalCount &&
    exactRouteSummary(page.routeSummary, first.routeSummary);
}

function sameQuantumIdentity(
  first: DesktopNativeCoreStellarQuantumProjectionResult,
  page: DesktopNativeCoreStellarQuantumProjectionResult,
): boolean {
  const leftRuntime = first.runtime;
  const rightRuntime = page.runtime;
  return page.enabled === first.enabled && page.items.totalCount === first.items.totalCount &&
    page.collectors.totalCount === first.collectors.totalCount &&
    JSON.stringify(page.bandwidth) === JSON.stringify(first.bandwidth) &&
    JSON.stringify(rightRuntime) === JSON.stringify(leftRuntime) &&
    JSON.stringify(page.collectorSummary) === JSON.stringify(first.collectorSummary);
}

function selectorKey(selector: object): string {
  return JSON.stringify(selector);
}

function normalizedIndustrySelector(
  selector: NativeStellarIndustryBaseSelector | NativeStellarIndustrySelector,
): NativeStellarIndustrySelector | null {
  const candidate = {
    ...DEFAULT_NATIVE_STELLAR_ROUTE_SELECTOR,
    ...selector,
  } as NativeStellarIndustrySelector;
  return validNativeStellarIndustrySelector(candidate) ? Object.freeze(candidate) : null;
}

function baseIndustrySelector(selector: NativeStellarIndustrySelector): NativeStellarIndustryBaseSelector {
  return {
    systemId: selector.systemId,
    planetId: selector.planetId,
    planetCursor: selector.planetCursor,
    planetLimit: selector.planetLimit,
    stationCursor: selector.stationCursor,
    stationLimit: selector.stationLimit,
  };
}

function v1ProjectionFromV2(
  projection: DesktopNativeCoreStellarIndustryV2ProjectionResult,
): DesktopNativeCoreStellarIndustryProjectionResult {
  return Object.freeze({
    schemaVersion: 1,
    projectionType: "stellar-industry-v1",
    revision: projection.revision,
    registryFingerprint: projection.registryFingerprint,
    stateVersion: 47,
    limits: Object.freeze({
      requestBytes: projection.limits.requestBytes,
      projectionBytes: projection.limits.projectionBytes,
      pageRows: projection.limits.pageRows,
      labelBytes: projection.limits.labelBytes,
    }),
    request: Object.freeze({
      expectedRevision: projection.request.expectedRevision,
      expectedRegistryFingerprint: projection.request.expectedRegistryFingerprint,
      systemId: projection.request.systemId,
      planetId: projection.request.planetId,
      planetCursor: projection.request.planetCursor,
      planetLimit: projection.request.planetLimit,
      stationCursor: projection.request.stationCursor,
      stationLimit: projection.request.stationLimit,
    }),
    activePlanetId: projection.activePlanetId,
    activeSystemId: projection.activeSystemId,
    scopeSystemId: projection.scopeSystemId,
    scopePlanetId: projection.scopePlanetId,
    truncated: projection.planets.nextCursor !== null || projection.stations.nextCursor !== null,
    planets: projection.planets,
    stations: projection.stations,
  });
}

function exactIdentityFrame(
  frame: NativeStellarProjectionIdentity,
  identity: NativeStellarProjectionIdentity,
): boolean {
  return frame.sessionId === identity.sessionId && frame.revision === identity.revision &&
    frame.registryFingerprint === identity.registryFingerprint;
}

function exactOverviewSelectors(
  left: NativeStarMapOverviewSelector,
  right: NativeStarMapOverviewSelector,
): boolean {
  return left.cursor === right.cursor && left.limit === right.limit;
}

function exactIndustrySelectors(
  left: NativeStellarIndustrySelector,
  right: NativeStellarIndustrySelector,
): boolean {
  return left.systemId === right.systemId && left.planetId === right.planetId &&
    left.planetCursor === right.planetCursor && left.planetLimit === right.planetLimit &&
    left.stationCursor === right.stationCursor && left.stationLimit === right.stationLimit &&
    left.routeCursor === right.routeCursor && left.routeLimit === right.routeLimit &&
    left.routeFilter === right.routeFilter && left.query === right.query;
}

function exactQuantumSelectors(
  left: NativeStellarQuantumSelector,
  right: NativeStellarQuantumSelector,
): boolean {
  return left.itemCursor === right.itemCursor && left.itemLimit === right.itemLimit &&
    left.collectorCursor === right.collectorCursor && left.collectorLimit === right.collectorLimit;
}

function immutableRowsByTargetStation(
  routes: readonly DesktopNativeCoreStellarIndustryRouteRow[],
): ReadonlyMap<string, readonly DesktopNativeCoreStellarIndustryRouteRow[]> {
  const mutable = new Map<string, DesktopNativeCoreStellarIndustryRouteRow[]>();
  for (const route of routes) {
    const rows = mutable.get(route.targetStationId);
    if (rows) rows.push(route);
    else mutable.set(route.targetStationId, [route]);
  }
  return new Map([...mutable].map(([id, rows]) => [id, Object.freeze(rows)]));
}

function immutableCollectorsBySystem(
  collectors: readonly DesktopNativeCoreStellarQuantumCollectorRow[],
): ReadonlyMap<string, readonly DesktopNativeCoreStellarQuantumCollectorRow[]> {
  const mutable = new Map<string, DesktopNativeCoreStellarQuantumCollectorRow[]>();
  for (const collector of collectors) {
    const rows = mutable.get(collector.systemId);
    if (rows) rows.push(collector);
    else mutable.set(collector.systemId, [collector]);
  }
  return new Map([...mutable].map(([id, rows]) => [id, Object.freeze(rows)]));
}

export function validNativeStarMapOverviewSelector(selector: NativeStarMapOverviewSelector): boolean {
  return validPage(selector.cursor, selector.limit);
}

export function validNativeStellarIndustryBaseSelector(selector: NativeStellarIndustryBaseSelector): boolean {
  return validNullableLogicalId(selector.systemId) && validNullableLogicalId(selector.planetId) &&
    validPage(selector.planetCursor, selector.planetLimit) &&
    validPage(selector.stationCursor, selector.stationLimit);
}

export function validNativeStellarIndustrySelector(selector: NativeStellarIndustrySelector): boolean {
  return validNativeStellarIndustryBaseSelector(selector) &&
    validPage(selector.routeCursor, selector.routeLimit) && ROUTE_FILTERS.has(selector.routeFilter) &&
    validRouteQuery(selector.query);
}

export function validNativeStellarQuantumSelector(selector: NativeStellarQuantumSelector): boolean {
  return validPage(selector.itemCursor, selector.itemLimit) &&
    validPage(selector.collectorCursor, selector.collectorLimit);
}

function validCompleteOverviewSelector(selector: NativeStarMapOverviewSelector): boolean {
  return validNativeStarMapOverviewSelector(selector) && selector.cursor === 0;
}

function validCompleteIndustrySelector(selector: NativeStellarIndustrySelector): boolean {
  return validNativeStellarIndustrySelector(selector) && selector.planetCursor === 0 &&
    selector.stationCursor === 0 && selector.routeCursor === 0;
}

function validCompleteQuantumSelector(selector: NativeStellarQuantumSelector): boolean {
  return validNativeStellarQuantumSelector(selector) && selector.itemCursor === 0 &&
    selector.collectorCursor === 0;
}

export function createNativePlayerAuthorityStellarProjectionSource(
  bridge: Pick<
    DesktopBridge,
    "getNativeCoreStarMapOverviewProjection" | "getNativeCoreStellarIndustryV2Projection" |
    "getNativeCoreStellarQuantumProjection"
  > | null,
  identity: NativeStellarProjectionIdentity,
): NativeStellarWorkspaceSource | null {
  const readOverview = bridge?.getNativeCoreStarMapOverviewProjection;
  const readIndustryV2 = bridge?.getNativeCoreStellarIndustryV2Projection;
  const readQuantum = bridge?.getNativeCoreStellarQuantumProjection;
  if (!validLogicalId(identity.sessionId, 128) || !validRevision(identity.revision) ||
      !validLogicalId(identity.registryFingerprint) || typeof readOverview !== "function" ||
      typeof readIndustryV2 !== "function") return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    mode: "player-authority" as const,
    boundIdentity,
    async readVerifiedStarMapOverviewProjection(
      selector: NativeStarMapOverviewSelector,
      expectedRevision: number,
    ) {
      if (expectedRevision !== boundIdentity.revision || !validNativeStarMapOverviewSelector(selector)) return null;
      try {
        const result = await readOverview({
          sessionId: boundIdentity.sessionId,
          expectedRevision,
          expectedRegistryFingerprint: boundIdentity.registryFingerprint,
          ...selector,
        });
        return exactOverviewRequest(result, expectedRevision, boundIdentity.registryFingerprint, selector)
          ? result
          : null;
      } catch {
        return null;
      }
    },
    async readVerifiedStellarIndustryV2Projection(
      selector: NativeStellarIndustrySelector,
      expectedRevision: number,
    ) {
      if (expectedRevision !== boundIdentity.revision || !validNativeStellarIndustrySelector(selector)) return null;
      try {
        const result = await readIndustryV2({
          sessionId: boundIdentity.sessionId,
          expectedRevision,
          expectedRegistryFingerprint: boundIdentity.registryFingerprint,
          ...selector,
        });
        return exactIndustryV2Request(result, expectedRevision, boundIdentity.registryFingerprint, selector)
          ? result
          : null;
      } catch {
        return null;
      }
    },
    ...(typeof readQuantum === "function" ? {
      async readVerifiedStellarQuantumProjection(
        selector: NativeStellarQuantumSelector,
        expectedRevision: number,
      ) {
        if (expectedRevision !== boundIdentity.revision || !validNativeStellarQuantumSelector(selector)) return null;
        try {
          const result = await readQuantum({
            sessionId: boundIdentity.sessionId,
            expectedRevision,
            expectedRegistryFingerprint: boundIdentity.registryFingerprint,
            ...selector,
          });
          return exactQuantumRequest(result, expectedRevision, boundIdentity.registryFingerprint, selector)
            ? result
            : null;
        } catch {
          return null;
        }
      },
    } : {}),
  });
}

/** Explicit adapter for the JavaScript-authoritative shadow controller. */
export function createNativeShadowStellarProjectionSource(
  reader: NativeShadowStellarProjectionReader | null,
): NativeStellarWorkspaceSource | null {
  if (!reader || typeof reader.readVerifiedStarMapOverviewProjection !== "function" ||
      typeof reader.readVerifiedStellarIndustryV2Projection !== "function" &&
      typeof reader.readVerifiedStellarIndustryProjection !== "function") return null;
  return Object.freeze({
    mode: "shadow" as const,
    readVerifiedStarMapOverviewProjection: (request: NativeStarMapOverviewSelector, revision: number) =>
      reader.readVerifiedStarMapOverviewProjection(request, revision),
    readVerifiedStellarIndustryV2Projection: typeof reader.readVerifiedStellarIndustryV2Projection === "function"
      ? (request: NativeStellarIndustrySelector, revision: number) =>
          reader.readVerifiedStellarIndustryV2Projection!(request, revision)
      : undefined,
    readVerifiedStellarIndustryProjection: typeof reader.readVerifiedStellarIndustryProjection === "function"
      ? (request: NativeStellarIndustryBaseSelector, revision: number) =>
          reader.readVerifiedStellarIndustryProjection!(request, revision)
      : undefined,
    readVerifiedStellarQuantumProjection: typeof reader.readVerifiedStellarQuantumProjection === "function"
      ? (request: NativeStellarQuantumSelector, revision: number) =>
          reader.readVerifiedStellarQuantumProjection!(request, revision)
      : undefined,
  });
}

function selectFrames(
  snapshot: NativeStellarWorkspaceSnapshot,
  identity: NativeStellarProjectionIdentity,
): { overview: NativeStarMapOverviewFrame; industry: NativeStellarIndustryFrame } | null {
  const overview = snapshot.overview.frame;
  const industry = snapshot.industry.frame;
  if (snapshot.overview.status !== "ready" || snapshot.industry.status !== "ready" ||
      !overview || !industry || !exactIdentityFrame(overview, identity) ||
      !exactIdentityFrame(industry, identity) || overview.sourceMode !== industry.sourceMode ||
      overview.projection.activePlanetId !== industry.projection.activePlanetId ||
      overview.projection.activeSystemId !== industry.projection.activeSystemId) return null;
  return { overview, industry };
}

/** Player-authority selector: v2 is mandatory and no GameState/v1 fallback exists. */
export function selectNativeStarMapWorkspaceReadModel(
  snapshot: NativeStellarWorkspaceSnapshot,
  identity: NativeStellarProjectionIdentity,
  expectedIndustrySelector?: NativeStellarIndustryBaseSelector | NativeStellarIndustrySelector,
): NativeStarMapWorkspaceReadModel | null {
  const frames = selectFrames(snapshot, identity);
  const expected = expectedIndustrySelector ? normalizedIndustrySelector(expectedIndustrySelector) : null;
  if (!frames || frames.overview.sourceMode !== "player-authority" ||
      frames.industry.sourceMode !== "player-authority" || frames.industry.sourceVersion !== 2 ||
      !frames.industry.routes || !frames.industry.routeSummary || !frames.industry.routeRowsById ||
      !frames.industry.routeRowsByTargetStationId || expectedIndustrySelector &&
      (!expected || !exactIndustrySelectors(frames.industry.selector, expected))) return null;
  return Object.freeze({
    source: "native-core" as const,
    sourceMode: "player-authority" as const,
    ...identity,
    activePlanetId: frames.overview.projection.activePlanetId,
    activeSystemId: frames.overview.projection.activeSystemId,
    galaxySeed: frames.overview.projection.galaxySeed,
    summary: frames.overview.projection.summary,
    routeSummary: frames.industry.routeSummary,
    systems: frames.overview.systems,
    planets: frames.industry.planets,
    stations: frames.industry.stations,
    routes: frames.industry.routes,
    systemRowsById: frames.overview.systemRowsById,
    planetRowsById: frames.industry.planetRowsById,
    stationRowsById: frames.industry.stationRowsById,
    routeRowsById: frames.industry.routeRowsById,
    routeRowsByTargetStationId: frames.industry.routeRowsByTargetStationId,
  });
}

/** Player-authority Quantum console selector. It never reads or accepts a renderer GameState fallback. */
export function selectNativePlayerAuthorityStellarQuantumReadModel(
  snapshot: NativeStellarWorkspaceSnapshot,
  identity: NativeStellarProjectionIdentity,
  expectedSelector: NativeStellarQuantumSelector = DEFAULT_NATIVE_STELLAR_QUANTUM_SELECTOR,
): NativeStellarQuantumReadModel | null {
  const frame = snapshot.quantum.frame;
  if (snapshot.quantum.status !== "ready" || !frame || frame.sourceMode !== "player-authority" ||
      !exactIdentityFrame(frame, identity) || !validCompleteQuantumSelector(expectedSelector) ||
      !exactQuantumSelectors(frame.selector, expectedSelector)) return null;
  return Object.freeze({
    source: "native-core" as const,
    sourceMode: "player-authority" as const,
    ...identity,
    enabled: frame.projection.enabled,
    bandwidth: frame.projection.bandwidth,
    runtime: frame.projection.runtime,
    collectorSummary: frame.projection.collectorSummary,
    items: frame.items,
    collectors: frame.collectors,
    itemRowsById: frame.itemRowsById,
    collectorRowsById: frame.collectorRowsById,
    collectorRowsBySystemId: frame.collectorRowsBySystemId,
  });
}

/** Shadow-only compatibility selector. A legacy v1 frame explicitly has no route model. */
export function selectNativeShadowStarMapWorkspaceReadModel(
  snapshot: NativeStellarWorkspaceSnapshot,
  identity: NativeStellarProjectionIdentity,
): NativeShadowStarMapWorkspaceReadModel | null {
  const frames = selectFrames(snapshot, identity);
  if (!frames || frames.overview.sourceMode !== "shadow" || frames.industry.sourceMode !== "shadow") return null;
  return Object.freeze({
    source: "native-core" as const,
    sourceMode: "shadow" as const,
    ...identity,
    activePlanetId: frames.overview.projection.activePlanetId,
    activeSystemId: frames.overview.projection.activeSystemId,
    galaxySeed: frames.overview.projection.galaxySeed,
    summary: frames.overview.projection.summary,
    routeSummary: frames.industry.routeSummary,
    systems: frames.overview.systems,
    planets: frames.industry.planets,
    stations: frames.industry.stations,
    routes: frames.industry.routes,
    systemRowsById: frames.overview.systemRowsById,
    planetRowsById: frames.industry.planetRowsById,
    stationRowsById: frames.industry.stationRowsById,
    routeRowsById: frames.industry.routeRowsById,
    routeRowsByTargetStationId: frames.industry.routeRowsByTargetStationId,
  });
}

export class NativeStellarWorkspaceStore {
  private snapshot: NativeStellarWorkspaceSnapshot = EMPTY_SNAPSHOT;
  private overviewToken = 0;
  private industryToken = 0;
  private quantumToken = 0;
  private cacheIdentity: string | null = null;
  private overviewFlight: { key: string; promise: Promise<RefreshResult> } | null = null;
  private industryFlight: { key: string; promise: Promise<RefreshResult> } | null = null;
  private quantumFlight: { key: string; promise: Promise<RefreshResult> } | null = null;
  private readonly overviewPageCache = new BoundedLruCache<DesktopNativeCoreStarMapOverviewProjectionResult>(
    NATIVE_STELLAR_OVERVIEW_PAGE_CACHE_ENTRIES,
  );
  private readonly industryV2PageCache = new BoundedLruCache<DesktopNativeCoreStellarIndustryV2ProjectionResult>(
    NATIVE_STELLAR_INDUSTRY_PAGE_CACHE_ENTRIES,
  );
  private readonly industryV1PageCache = new BoundedLruCache<DesktopNativeCoreStellarIndustryProjectionResult>(
    NATIVE_STELLAR_INDUSTRY_PAGE_CACHE_ENTRIES,
  );
  private readonly quantumPageCache = new BoundedLruCache<DesktopNativeCoreStellarQuantumProjectionResult>(
    NATIVE_STELLAR_QUANTUM_PAGE_CACHE_ENTRIES,
  );
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeStellarWorkspaceSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.overviewToken += 1;
    this.industryToken += 1;
    this.quantumToken += 1;
    this.overviewFlight = null;
    this.industryFlight = null;
    this.quantumFlight = null;
    this.cacheIdentity = null;
    this.clearPageCaches();
    this.publish(EMPTY_SNAPSHOT);
  }

  refreshOverview(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    selector: NativeStarMapOverviewSelector,
  ): Promise<RefreshResult> {
    if (!this.validSourceIdentity(source, identity) || !validCompleteOverviewSelector(selector)) {
      this.invalidateOverview();
      return Promise.resolve("unavailable");
    }
    this.prepareIdentity(identity);
    const key = `${source.mode}\u0000${identityKey(identity)}\u0000${selectorKey(selector)}`;
    if (this.overviewFlight?.key === key) return this.overviewFlight.promise;
    const current = this.snapshot.overview.frame;
    if (this.snapshot.overview.status === "ready" && current && current.sourceMode === source.mode &&
        exactIdentityFrame(current, identity) && exactOverviewSelectors(current.selector, selector)) {
      return Promise.resolve("committed");
    }

    const token = ++this.overviewToken;
    const previous = current;
    this.publish(Object.freeze({
      ...this.snapshot,
      overview: Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previous }),
    }));
    const promise = this.performOverviewRefresh(source, identity, selector, token, previous);
    this.overviewFlight = { key, promise };
    void promise.finally(() => {
      if (this.overviewFlight?.promise === promise) this.overviewFlight = null;
    });
    return promise;
  }

  refreshIndustry(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    rawSelector: NativeStellarIndustryBaseSelector | NativeStellarIndustrySelector,
  ): Promise<RefreshResult> {
    const selector = normalizedIndustrySelector(rawSelector);
    if (!selector || !this.validSourceIdentity(source, identity) || !validCompleteIndustrySelector(selector) ||
        source.mode === "player-authority" && typeof source.readVerifiedStellarIndustryV2Projection !== "function" ||
        source.mode === "shadow" && typeof source.readVerifiedStellarIndustryV2Projection !== "function" &&
        (typeof source.readVerifiedStellarIndustryProjection !== "function" ||
          selector.routeFilter !== "all" || selector.query !== "")) {
      this.invalidateIndustry();
      return Promise.resolve("unavailable");
    }
    this.prepareIdentity(identity);
    const version = typeof source.readVerifiedStellarIndustryV2Projection === "function" ? 2 : 1;
    const key = `${source.mode}\u0000v${version}\u0000${identityKey(identity)}\u0000${selectorKey(selector)}`;
    if (this.industryFlight?.key === key) return this.industryFlight.promise;
    const current = this.snapshot.industry.frame;
    if (this.snapshot.industry.status === "ready" && current && current.sourceMode === source.mode &&
        current.sourceVersion === version && exactIdentityFrame(current, identity) &&
        exactIndustrySelectors(current.selector, selector)) return Promise.resolve("committed");

    const token = ++this.industryToken;
    const previous = current;
    this.publish(Object.freeze({
      ...this.snapshot,
      industry: Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previous }),
    }));
    const promise = this.performIndustryRefresh(source, identity, selector, token, previous);
    this.industryFlight = { key, promise };
    void promise.finally(() => {
      if (this.industryFlight?.promise === promise) this.industryFlight = null;
    });
    return promise;
  }

  refreshQuantum(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    selector: NativeStellarQuantumSelector = DEFAULT_NATIVE_STELLAR_QUANTUM_SELECTOR,
  ): Promise<RefreshResult> {
    if (!this.validSourceIdentity(source, identity) || !validCompleteQuantumSelector(selector) ||
        typeof source.readVerifiedStellarQuantumProjection !== "function") {
      this.invalidateQuantum();
      return Promise.resolve("unavailable");
    }
    this.prepareIdentity(identity);
    const key = `${source.mode}\u0000${identityKey(identity)}\u0000${selectorKey(selector)}`;
    if (this.quantumFlight?.key === key) return this.quantumFlight.promise;
    const current = this.snapshot.quantum.frame;
    if (this.snapshot.quantum.status === "ready" && current && current.sourceMode === source.mode &&
        exactIdentityFrame(current, identity) && exactQuantumSelectors(current.selector, selector)) {
      return Promise.resolve("committed");
    }

    const token = ++this.quantumToken;
    const previous = current;
    this.publish(Object.freeze({
      ...this.snapshot,
      quantum: Object.freeze({ status: "loading", requestedRevision: identity.revision, frame: previous }),
    }));
    const promise = this.performQuantumRefresh(source, identity, selector, token, previous);
    this.quantumFlight = { key, promise };
    void promise.finally(() => {
      if (this.quantumFlight?.promise === promise) this.quantumFlight = null;
    });
    return promise;
  }

  private async performOverviewRefresh(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    selector: NativeStarMapOverviewSelector,
    token: number,
    previous: NativeStarMapOverviewFrame | null,
  ): Promise<RefreshResult> {
    let result: OverviewReadResult;
    try {
      result = await this.readCompleteOverview(source, identity, selector, token);
    } catch {
      result = { status: "unavailable" };
    }
    if (result.status === "superseded" || token !== this.overviewToken) return "superseded";
    if (result.status === "unavailable") {
      this.publish(Object.freeze({
        ...this.snapshot,
        overview: Object.freeze({ status: "unavailable", requestedRevision: identity.revision, frame: previous }),
      }));
      return "unavailable";
    }
    this.publish(Object.freeze({
      ...this.snapshot,
      overview: Object.freeze({ status: "ready", requestedRevision: identity.revision, frame: result.frame }),
    }));
    return "committed";
  }

  private async performIndustryRefresh(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    selector: NativeStellarIndustrySelector,
    token: number,
    previous: NativeStellarIndustryFrame | null,
  ): Promise<RefreshResult> {
    let result: IndustryReadResult;
    try {
      result = typeof source.readVerifiedStellarIndustryV2Projection === "function"
        ? await this.readCompleteIndustryV2(source, identity, selector, token)
        : await this.readCompleteIndustryV1(source, identity, selector, token);
    } catch {
      result = { status: "unavailable" };
    }
    if (result.status === "superseded" || token !== this.industryToken) return "superseded";
    if (result.status === "unavailable") {
      this.publish(Object.freeze({
        ...this.snapshot,
        industry: Object.freeze({ status: "unavailable", requestedRevision: identity.revision, frame: previous }),
      }));
      return "unavailable";
    }
    this.publish(Object.freeze({
      ...this.snapshot,
      industry: Object.freeze({ status: "ready", requestedRevision: identity.revision, frame: result.frame }),
    }));
    return "committed";
  }

  private async performQuantumRefresh(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    selector: NativeStellarQuantumSelector,
    token: number,
    previous: NativeStellarQuantumFrame | null,
  ): Promise<RefreshResult> {
    let result: QuantumReadResult;
    try {
      result = await this.readCompleteQuantum(source, identity, selector, token);
    } catch {
      result = { status: "unavailable" };
    }
    if (result.status === "superseded" || token !== this.quantumToken) return "superseded";
    if (result.status === "unavailable") {
      this.publish(Object.freeze({
        ...this.snapshot,
        quantum: Object.freeze({ status: "unavailable", requestedRevision: identity.revision, frame: previous }),
      }));
      return "unavailable";
    }
    this.publish(Object.freeze({
      ...this.snapshot,
      quantum: Object.freeze({ status: "ready", requestedRevision: identity.revision, frame: result.frame }),
    }));
    return "committed";
  }

  private async readCompleteOverview(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    initial: NativeStarMapOverviewSelector,
    token: number,
  ): Promise<OverviewReadResult> {
    let cursor = initial.cursor;
    let first: DesktopNativeCoreStarMapOverviewProjectionResult | null = null;
    const rows: DesktopNativeCoreStarMapSystemRow[] = [];
    const ids = new Set<string>();
    for (let pageIndex = 0; pageIndex < NATIVE_STELLAR_MAX_COMPLETE_PAGES; pageIndex += 1) {
      if (token !== this.overviewToken) return { status: "superseded" };
      const pageSelector = { cursor, limit: initial.limit };
      const key = `${source.mode}\u0000${identityKey(identity)}\u0000${selectorKey(pageSelector)}`;
      let page = this.overviewPageCache.get(key);
      if (!page) {
        page = await source.readVerifiedStarMapOverviewProjection(pageSelector, identity.revision) ?? undefined;
        if (token !== this.overviewToken) return { status: "superseded" };
        if (!page || !exactOverviewRequest(page, identity.revision, identity.registryFingerprint, pageSelector)) {
          return { status: "unavailable" };
        }
        this.overviewPageCache.set(key, page);
      }
      if (!first) {
        first = page;
        if (Math.ceil(page.systems.totalCount / initial.limit) > NATIVE_STELLAR_MAX_COMPLETE_PAGES) {
          return { status: "unavailable" };
        }
      } else if (!sameOverviewIdentity(first, page)) {
        return { status: "unavailable" };
      }
      for (const row of page.systems.rows) {
        if (!validLogicalId(row.systemId) || ids.has(row.systemId)) return { status: "unavailable" };
        ids.add(row.systemId);
        rows.push(row);
      }
      if (page.systems.nextCursor === null) {
        if (!first || rows.length !== page.systems.totalCount) return { status: "unavailable" };
        const systems = Object.freeze(rows);
        return {
          status: "ready",
          frame: Object.freeze({
            ...identity,
            sourceMode: source.mode,
            projection: first,
            selector: Object.freeze({ ...initial }),
            systems,
            systemRowsById: new Map(systems.map((row) => [row.systemId, row])),
          }),
        };
      }
      cursor = page.systems.nextCursor;
    }
    return { status: "unavailable" };
  }

  private async readCompleteIndustryV2(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    initial: NativeStellarIndustrySelector,
    token: number,
  ): Promise<IndustryReadResult> {
    const read = source.readVerifiedStellarIndustryV2Projection;
    if (!read) return { status: "unavailable" };
    let planetCursor = initial.planetCursor;
    let stationCursor = initial.stationCursor;
    let routeCursor = initial.routeCursor;
    let first: DesktopNativeCoreStellarIndustryV2ProjectionResult | null = null;
    const planets: DesktopNativeCoreStellarIndustryPlanetRow[] = [];
    const stations: DesktopNativeCoreStellarIndustryStationRow[] = [];
    const routes: DesktopNativeCoreStellarIndustryRouteRow[] = [];
    const planetIds = new Set<string>();
    const stationIds = new Set<string>();
    const routeIds = new Set<string>();

    for (let pageIndex = 0; pageIndex < NATIVE_STELLAR_MAX_COMPLETE_PAGES; pageIndex += 1) {
      if (token !== this.industryToken) return { status: "superseded" };
      const pageSelector = {
        ...initial,
        planetCursor,
        stationCursor,
        routeCursor,
      };
      const key = `v2\u0000${source.mode}\u0000${identityKey(identity)}\u0000${selectorKey(pageSelector)}`;
      let page = this.industryV2PageCache.get(key);
      if (!page) {
        page = await read(pageSelector, identity.revision) ?? undefined;
        if (token !== this.industryToken) return { status: "superseded" };
        if (!page || !exactIndustryV2Request(page, identity.revision, identity.registryFingerprint, pageSelector)) {
          return { status: "unavailable" };
        }
        this.industryV2PageCache.set(key, page);
      }
      if (!first) {
        first = page;
        const pageCount = Math.max(
          Math.ceil(page.planets.totalCount / initial.planetLimit),
          Math.ceil(page.stations.totalCount / initial.stationLimit),
          Math.ceil(page.routes.totalCount / initial.routeLimit),
        );
        if (pageCount > NATIVE_STELLAR_MAX_COMPLETE_PAGES) return { status: "unavailable" };
      } else if (!sameIndustryV2Identity(first, page)) {
        return { status: "unavailable" };
      }
      for (const row of page.planets.rows) {
        if (!validLogicalId(row.planetId) || planetIds.has(row.planetId)) return { status: "unavailable" };
        planetIds.add(row.planetId);
        planets.push(row);
      }
      for (const row of page.stations.rows) {
        if (!validLogicalId(row.stationId) || stationIds.has(row.stationId)) return { status: "unavailable" };
        stationIds.add(row.stationId);
        stations.push(row);
      }
      for (const row of page.routes.rows) {
        if (!validLogicalId(row.id) || routeIds.has(row.id)) return { status: "unavailable" };
        routeIds.add(row.id);
        routes.push(row);
      }
      const planetsDone = page.planets.nextCursor === null;
      const stationsDone = page.stations.nextCursor === null;
      const routesDone = page.routes.nextCursor === null;
      if (planetsDone && stationsDone && routesDone) {
        if (!first || planets.length !== page.planets.totalCount || stations.length !== page.stations.totalCount ||
            routes.length !== page.routes.totalCount) return { status: "unavailable" };
        const frozenPlanets = Object.freeze(planets);
        const frozenStations = Object.freeze(stations);
        const frozenRoutes = Object.freeze(routes);
        return {
          status: "ready",
          frame: Object.freeze({
            ...identity,
            sourceMode: source.mode,
            sourceVersion: 2,
            projection: v1ProjectionFromV2(first),
            projectionV2: first,
            selector: Object.freeze({ ...initial }),
            planets: frozenPlanets,
            stations: frozenStations,
            routes: frozenRoutes,
            routeSummary: first.routeSummary,
            planetRowsById: new Map(frozenPlanets.map((row) => [row.planetId, row])),
            stationRowsById: new Map(frozenStations.map((row) => [row.stationId, row])),
            routeRowsById: new Map(frozenRoutes.map((row) => [row.id, row])),
            routeRowsByTargetStationId: immutableRowsByTargetStation(frozenRoutes),
          }),
        };
      }
      planetCursor = page.planets.nextCursor ?? page.planets.totalCount;
      stationCursor = page.stations.nextCursor ?? page.stations.totalCount;
      routeCursor = page.routes.nextCursor ?? page.routes.totalCount;
    }
    return { status: "unavailable" };
  }

  private async readCompleteIndustryV1(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    initial: NativeStellarIndustrySelector,
    token: number,
  ): Promise<IndustryReadResult> {
    const read = source.mode === "shadow" ? source.readVerifiedStellarIndustryProjection : undefined;
    if (!read || initial.routeFilter !== "all" || initial.query !== "") return { status: "unavailable" };
    let planetCursor = initial.planetCursor;
    let stationCursor = initial.stationCursor;
    let first: DesktopNativeCoreStellarIndustryProjectionResult | null = null;
    const planets: DesktopNativeCoreStellarIndustryPlanetRow[] = [];
    const stations: DesktopNativeCoreStellarIndustryStationRow[] = [];
    const planetIds = new Set<string>();
    const stationIds = new Set<string>();
    for (let pageIndex = 0; pageIndex < NATIVE_STELLAR_MAX_COMPLETE_PAGES; pageIndex += 1) {
      if (token !== this.industryToken) return { status: "superseded" };
      const pageSelector = { ...baseIndustrySelector(initial), planetCursor, stationCursor };
      const key = `v1\u0000shadow\u0000${identityKey(identity)}\u0000${selectorKey(pageSelector)}`;
      let page = this.industryV1PageCache.get(key);
      if (!page) {
        page = await read(pageSelector, identity.revision) ?? undefined;
        if (token !== this.industryToken) return { status: "superseded" };
        if (!page || !exactIndustryBaseRequest(page, identity.revision, identity.registryFingerprint, pageSelector)) {
          return { status: "unavailable" };
        }
        this.industryV1PageCache.set(key, page);
      }
      if (!first) {
        first = page;
        const pageCount = Math.max(
          Math.ceil(page.planets.totalCount / initial.planetLimit),
          Math.ceil(page.stations.totalCount / initial.stationLimit),
        );
        if (pageCount > NATIVE_STELLAR_MAX_COMPLETE_PAGES) return { status: "unavailable" };
      } else if (!sameIndustryBaseIdentity(first, page)) {
        return { status: "unavailable" };
      }
      for (const row of page.planets.rows) {
        if (!validLogicalId(row.planetId) || planetIds.has(row.planetId)) return { status: "unavailable" };
        planetIds.add(row.planetId);
        planets.push(row);
      }
      for (const row of page.stations.rows) {
        if (!validLogicalId(row.stationId) || stationIds.has(row.stationId)) return { status: "unavailable" };
        stationIds.add(row.stationId);
        stations.push(row);
      }
      if (page.planets.nextCursor === null && page.stations.nextCursor === null) {
        if (!first || planets.length !== page.planets.totalCount || stations.length !== page.stations.totalCount) {
          return { status: "unavailable" };
        }
        const frozenPlanets = Object.freeze(planets);
        const frozenStations = Object.freeze(stations);
        return {
          status: "ready",
          frame: Object.freeze({
            ...identity,
            sourceMode: "shadow",
            sourceVersion: 1,
            projection: first,
            projectionV2: null,
            selector: Object.freeze({ ...initial }),
            planets: frozenPlanets,
            stations: frozenStations,
            routes: null,
            routeSummary: null,
            planetRowsById: new Map(frozenPlanets.map((row) => [row.planetId, row])),
            stationRowsById: new Map(frozenStations.map((row) => [row.stationId, row])),
            routeRowsById: null,
            routeRowsByTargetStationId: null,
          }),
        };
      }
      planetCursor = page.planets.nextCursor ?? page.planets.totalCount;
      stationCursor = page.stations.nextCursor ?? page.stations.totalCount;
    }
    return { status: "unavailable" };
  }

  private async readCompleteQuantum(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
    initial: NativeStellarQuantumSelector,
    token: number,
  ): Promise<QuantumReadResult> {
    const read = source.readVerifiedStellarQuantumProjection;
    if (!read) return { status: "unavailable" };
    let itemCursor = initial.itemCursor;
    let collectorCursor = initial.collectorCursor;
    let first: DesktopNativeCoreStellarQuantumProjectionResult | null = null;
    const items: DesktopNativeCoreStellarQuantumItemRow[] = [];
    const collectors: DesktopNativeCoreStellarQuantumCollectorRow[] = [];
    const itemIds = new Set<string>();
    const collectorIds = new Set<string>();
    for (let pageIndex = 0; pageIndex < NATIVE_STELLAR_MAX_COMPLETE_PAGES; pageIndex += 1) {
      if (token !== this.quantumToken) return { status: "superseded" };
      const pageSelector = { ...initial, itemCursor, collectorCursor };
      const key = `${source.mode}\u0000${identityKey(identity)}\u0000${selectorKey(pageSelector)}`;
      let page = this.quantumPageCache.get(key);
      if (!page) {
        page = await read(pageSelector, identity.revision) ?? undefined;
        if (token !== this.quantumToken) return { status: "superseded" };
        if (!page || !exactQuantumRequest(page, identity.revision, identity.registryFingerprint, pageSelector)) {
          return { status: "unavailable" };
        }
        this.quantumPageCache.set(key, page);
      }
      if (!first) {
        first = page;
        const pageCount = Math.max(
          Math.ceil(page.items.totalCount / initial.itemLimit),
          Math.ceil(page.collectors.totalCount / initial.collectorLimit),
        );
        if (pageCount > NATIVE_STELLAR_MAX_COMPLETE_PAGES) return { status: "unavailable" };
      } else if (!sameQuantumIdentity(first, page)) {
        return { status: "unavailable" };
      }
      for (const row of page.items.rows) {
        if (itemIds.has(row.itemId)) return { status: "unavailable" };
        itemIds.add(row.itemId);
        items.push(row);
      }
      for (const row of page.collectors.rows) {
        if (collectorIds.has(row.collectorId)) return { status: "unavailable" };
        collectorIds.add(row.collectorId);
        collectors.push(row);
      }
      const itemsDone = page.items.nextCursor === null;
      const collectorsDone = page.collectors.nextCursor === null;
      if (itemsDone && collectorsDone) {
        if (!first || items.length !== page.items.totalCount || collectors.length !== page.collectors.totalCount) {
          return { status: "unavailable" };
        }
        let connectedCount = 0;
        let pendingCount = 0;
        let availableCount = 0;
        let connectedStacks = 0;
        for (const collector of collectors) {
          if (collector.attachmentState === "connected") {
            connectedCount += 1;
            connectedStacks += collector.machineCount;
          } else if (collector.attachmentState === "pending") {
            pendingCount += 1;
          } else if (collector.attachmentState === "available") {
            availableCount += 1;
          }
          if (!Number.isSafeInteger(connectedStacks)) return { status: "unavailable" };
        }
        const summary = first.collectorSummary;
        if (summary.totalCount !== collectors.length || summary.connectedCount !== connectedCount ||
            summary.pendingCount !== pendingCount || summary.availableCount !== availableCount ||
            summary.connectedStacks !== connectedStacks) return { status: "unavailable" };
        const frozenItems = Object.freeze(items);
        const frozenCollectors = Object.freeze(collectors);
        return {
          status: "ready",
          frame: Object.freeze({
            ...identity,
            sourceMode: source.mode,
            projection: first,
            selector: Object.freeze({ ...initial }),
            items: frozenItems,
            collectors: frozenCollectors,
            itemRowsById: new Map(frozenItems.map((row) => [row.itemId, row])),
            collectorRowsById: new Map(frozenCollectors.map((row) => [row.collectorId, row])),
            collectorRowsBySystemId: immutableCollectorsBySystem(frozenCollectors),
          }),
        };
      }
      itemCursor = page.items.nextCursor ?? page.items.totalCount;
      collectorCursor = page.collectors.nextCursor ?? page.collectors.totalCount;
    }
    return { status: "unavailable" };
  }

  private validSourceIdentity(
    source: NativeStellarWorkspaceSource,
    identity: NativeStellarProjectionIdentity,
  ): boolean {
    return (source.mode === "player-authority" || source.mode === "shadow") &&
      validLogicalId(identity.sessionId, 128) && validRevision(identity.revision) &&
      validLogicalId(identity.registryFingerprint) &&
      (source.mode !== "player-authority" || identitiesEqual(source.boundIdentity, identity));
  }

  private prepareIdentity(identity: NativeStellarProjectionIdentity): void {
    const key = identityKey(identity);
    if (this.cacheIdentity === key) return;
    this.cacheIdentity = key;
    this.overviewToken += 1;
    this.industryToken += 1;
    this.quantumToken += 1;
    this.overviewFlight = null;
    this.industryFlight = null;
    this.quantumFlight = null;
    this.clearPageCaches();
    this.publish(EMPTY_SNAPSHOT);
  }

  private clearPageCaches(): void {
    this.overviewPageCache.clear();
    this.industryV2PageCache.clear();
    this.industryV1PageCache.clear();
    this.quantumPageCache.clear();
  }

  private invalidateOverview(): void {
    this.overviewToken += 1;
    this.overviewFlight = null;
    this.publish(Object.freeze({
      ...this.snapshot,
      overview: Object.freeze({ status: "unavailable", requestedRevision: null, frame: null }),
    }));
  }

  private invalidateIndustry(): void {
    this.industryToken += 1;
    this.industryFlight = null;
    this.publish(Object.freeze({
      ...this.snapshot,
      industry: Object.freeze({ status: "unavailable", requestedRevision: null, frame: null }),
    }));
  }

  private invalidateQuantum(): void {
    this.quantumToken += 1;
    this.quantumFlight = null;
    this.publish(Object.freeze({
      ...this.snapshot,
      quantum: Object.freeze({ status: "unavailable", requestedRevision: null, frame: null }),
    }));
  }

  private publish(next: NativeStellarWorkspaceSnapshot): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
