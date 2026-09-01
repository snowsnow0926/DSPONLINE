import type {
  DesktopBridge,
  DesktopNativeCoreStarMapCatalogPlanetRow,
  DesktopNativeCoreStarMapCatalogProjectionRequest,
  DesktopNativeCoreStarMapCatalogProjectionResult,
  DesktopNativeCoreStarMapCatalogSystemRow,
} from "../desktop";

// A catalog row may legally carry 64 resource IDs, 64 rare IDs, 64 orbital
// yields and 32 UTF-8 metadata tags. Eight rows keep even that adversarial
// shape below the host's 1 MiB projection envelope; 64 remains the protocol
// maximum for callers that know their rows are smaller.
export const NATIVE_STAR_MAP_CATALOG_PAGE_ROWS = 8 as const;
export const NATIVE_STAR_MAP_CATALOG_MAX_ROWS = 65_536 as const;
export const NATIVE_STAR_MAP_CATALOG_MAX_PAGES = 8_192 as const;

export interface NativeStarMapCatalogIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly registryFingerprint: string;
}

export interface NativeStarMapCatalogSource {
  readonly mode: "player-authority";
  readonly boundIdentity: NativeStarMapCatalogIdentity;
  readVerifiedStarMapCatalogProjection(
    request: Omit<DesktopNativeCoreStarMapCatalogProjectionRequest, "sessionId" | "runId" | "expectedRevision" | "expectedRegistryFingerprint">,
    expectedRevision: number,
  ): Promise<DesktopNativeCoreStarMapCatalogProjectionResult | null>;
}

export interface NativeStarMapCatalogFrame extends NativeStarMapCatalogIdentity {
  readonly source: "native-core";
  readonly sourceMode: "player-authority";
  readonly activePlanetId: string;
  readonly activeSystemId: string;
  readonly galaxySeed: number;
  readonly summary: DesktopNativeCoreStarMapCatalogProjectionResult["summary"];
  readonly metadataTruncated: boolean;
  readonly projection: DesktopNativeCoreStarMapCatalogProjectionResult;
  readonly systems: readonly DesktopNativeCoreStarMapCatalogSystemRow[];
  readonly planets: readonly DesktopNativeCoreStarMapCatalogPlanetRow[];
  readonly systemRowsById: ReadonlyMap<string, DesktopNativeCoreStarMapCatalogSystemRow>;
  readonly planetRowsById: ReadonlyMap<string, DesktopNativeCoreStarMapCatalogPlanetRow>;
  readonly planetRowsBySystemId: ReadonlyMap<string, readonly DesktopNativeCoreStarMapCatalogPlanetRow[]>;
}

export interface NativeStarMapCatalogSnapshot {
  readonly status: "empty" | "loading" | "ready" | "unavailable";
  readonly requestedRevision: number | null;
  readonly frame: NativeStarMapCatalogFrame | null;
}

export type NativeStarMapCatalogRefreshResult = "committed" | "superseded" | "unavailable";

const LOGICAL_ID = /^[A-Za-z0-9_.:-]+$/;
const EMPTY_SNAPSHOT: NativeStarMapCatalogSnapshot = Object.freeze({
  status: "empty",
  requestedRevision: null,
  frame: null,
});

function validLogicalId(value: string, maximumLength = 256): boolean {
  return value.length > 0 && value.length <= maximumLength && LOGICAL_ID.test(value);
}

function validIdentity(identity: NativeStarMapCatalogIdentity): boolean {
  return validLogicalId(identity.sessionId, 128) && validLogicalId(identity.runId, 128) &&
    Number.isSafeInteger(identity.revision) &&
    identity.revision >= 0 && validLogicalId(identity.registryFingerprint);
}

function identityKey(identity: NativeStarMapCatalogIdentity): string {
  return `${identity.sessionId}\u0000${identity.runId}\u0000${identity.revision}\u0000${identity.registryFingerprint}`;
}

function sameScope(left: NativeStarMapCatalogIdentity, right: NativeStarMapCatalogIdentity): boolean {
  return left.sessionId === right.sessionId && left.runId === right.runId &&
    left.registryFingerprint === right.registryFingerprint;
}

function exactIdentity(
  left: NativeStarMapCatalogIdentity,
  right: NativeStarMapCatalogIdentity,
): boolean {
  return sameScope(left, right) && left.revision === right.revision;
}

function exactProjectionRequest(
  projection: DesktopNativeCoreStarMapCatalogProjectionResult,
  identity: NativeStarMapCatalogIdentity,
  request: Omit<DesktopNativeCoreStarMapCatalogProjectionRequest, "sessionId" | "expectedRevision" | "expectedRegistryFingerprint">,
): boolean {
  return projection.schemaVersion === 1 && projection.projectionType === "star-map-catalog-v1" &&
    projection.stateVersion === 47 && projection.revision === identity.revision &&
    projection.registryFingerprint === identity.registryFingerprint &&
    projection.request.expectedRevision === identity.revision &&
    projection.request.expectedRegistryFingerprint === identity.registryFingerprint &&
    projection.request.systemCursor === request.systemCursor &&
    projection.request.systemLimit === request.systemLimit &&
    projection.request.planetCursor === request.planetCursor &&
    projection.request.planetLimit === request.planetLimit &&
    projection.systems.cursor === request.systemCursor &&
    projection.systems.limit === request.systemLimit &&
    projection.planets.cursor === request.planetCursor &&
    projection.planets.limit === request.planetLimit;
}

function sameHeader(
  left: DesktopNativeCoreStarMapCatalogProjectionResult,
  right: DesktopNativeCoreStarMapCatalogProjectionResult,
): boolean {
  return left.revision === right.revision && left.registryFingerprint === right.registryFingerprint &&
    left.activePlanetId === right.activePlanetId && left.activeSystemId === right.activeSystemId &&
    left.galaxySeed === right.galaxySeed && left.summary.systemCount === right.summary.systemCount &&
    left.summary.unlockedSystemCount === right.summary.unlockedSystemCount &&
    left.summary.planetCount === right.summary.planetCount &&
    left.summary.colonizedPlanetCount === right.summary.colonizedPlanetCount;
}

function nestedMetadataTruncated(row: DesktopNativeCoreStarMapCatalogPlanetRow): boolean {
  return row.displayNameTruncated || row.systemDisplayNameTruncated || row.metadata.noteTruncated ||
    row.metadata.tagTextTruncated ||
    row.metadata.tags.truncated || row.profile.climateNameTruncated ||
    row.profile.specializationNameTruncated || row.profile.resourceIds.truncated ||
    row.profile.rareResourceIds.truncated || row.profile.orbitalYields.truncated;
}

function completeFrame(
  identity: NativeStarMapCatalogIdentity,
  first: DesktopNativeCoreStarMapCatalogProjectionResult,
  systems: DesktopNativeCoreStarMapCatalogSystemRow[],
  planets: DesktopNativeCoreStarMapCatalogPlanetRow[],
): NativeStarMapCatalogFrame | null {
  if (systems.length !== first.summary.systemCount || planets.length !== first.summary.planetCount ||
      systems.length > NATIVE_STAR_MAP_CATALOG_MAX_ROWS ||
      planets.length > NATIVE_STAR_MAP_CATALOG_MAX_ROWS) return null;
  const systemRowsById = new Map<string, DesktopNativeCoreStarMapCatalogSystemRow>();
  const planetRowsById = new Map<string, DesktopNativeCoreStarMapCatalogPlanetRow>();
  const grouped = new Map<string, DesktopNativeCoreStarMapCatalogPlanetRow[]>();
  let activeSystems = 0;
  let activePlanets = 0;
  let discoveredSystems = 0;
  let colonizedPlanets = 0;
  for (const system of systems) {
    if (systemRowsById.has(system.systemId)) return null;
    systemRowsById.set(system.systemId, system);
    if (system.active) {
      activeSystems += 1;
      if (system.systemId !== first.activeSystemId) return null;
    }
    if (system.discovered) discoveredSystems += 1;
  }
  for (const planet of planets) {
    if (planetRowsById.has(planet.planetId) || !systemRowsById.has(planet.systemId)) return null;
    planetRowsById.set(planet.planetId, planet);
    const rows = grouped.get(planet.systemId) ?? [];
    rows.push(planet);
    grouped.set(planet.systemId, rows);
    if (planet.active) {
      activePlanets += 1;
      if (planet.planetId !== first.activePlanetId || planet.systemId !== first.activeSystemId) return null;
    }
    if (planet.colonized) colonizedPlanets += 1;
  }
  if (activeSystems !== 1 || activePlanets !== 1 || discoveredSystems !== first.summary.unlockedSystemCount ||
      colonizedPlanets !== first.summary.colonizedPlanetCount) return null;
  for (const system of systems) {
    const rows = grouped.get(system.systemId) ?? [];
    if (rows.length !== system.planetCount || rows[0]?.planetId !== system.firstPlanetId ||
        rows.filter((planet) => planet.colonized).length !== system.colonizedPlanetCount) return null;
  }
  const immutableGroups = new Map<string, readonly DesktopNativeCoreStarMapCatalogPlanetRow[]>(
    [...grouped].map(([systemId, rows]) => [systemId, Object.freeze([...rows])]),
  );
  return Object.freeze({
    source: "native-core" as const,
    sourceMode: "player-authority" as const,
    ...identity,
    activePlanetId: first.activePlanetId,
    activeSystemId: first.activeSystemId,
    galaxySeed: first.galaxySeed,
    summary: Object.freeze({ ...first.summary }),
    metadataTruncated: systems.some((system) => system.displayNameTruncated || system.starTypeNameTruncated) ||
      planets.some(nestedMetadataTruncated),
    projection: first,
    systems: Object.freeze([...systems]),
    planets: Object.freeze([...planets]),
    systemRowsById,
    planetRowsById,
    planetRowsBySystemId: immutableGroups,
  });
}

export function createNativePlayerAuthorityStarMapCatalogSource(
  bridge: Pick<DesktopBridge, "getNativeCoreStarMapCatalogProjection"> | null,
  identity: NativeStarMapCatalogIdentity,
): NativeStarMapCatalogSource | null {
  const reader = bridge?.getNativeCoreStarMapCatalogProjection;
  if (typeof reader !== "function" || !validIdentity(identity)) return null;
  const boundIdentity = Object.freeze({ ...identity });
  return Object.freeze({
    mode: "player-authority" as const,
    boundIdentity,
    async readVerifiedStarMapCatalogProjection(
      request: Omit<DesktopNativeCoreStarMapCatalogProjectionRequest, "sessionId" | "runId" | "expectedRevision" | "expectedRegistryFingerprint">,
      expectedRevision: number,
    ) {
      if (expectedRevision !== boundIdentity.revision ||
          !Number.isSafeInteger(request.systemCursor) || request.systemCursor < 0 ||
          request.systemCursor > 0xffff_ffff || !Number.isSafeInteger(request.planetCursor) ||
          request.planetCursor < 0 || request.planetCursor > 0xffff_ffff ||
          !Number.isSafeInteger(request.systemLimit) || request.systemLimit < 1 ||
          request.systemLimit > 64 || !Number.isSafeInteger(request.planetLimit) ||
          request.planetLimit < 1 || request.planetLimit > 64) return null;
      try {
        const projection = await reader({
          sessionId: boundIdentity.sessionId,
          runId: boundIdentity.runId,
          expectedRevision,
          expectedRegistryFingerprint: boundIdentity.registryFingerprint,
          ...request,
        });
        return exactProjectionRequest(projection, boundIdentity, request) ? projection : null;
      } catch {
        return null;
      }
    },
  });
}

export function selectNativeStarMapCatalogFrame(
  snapshot: NativeStarMapCatalogSnapshot,
  identity: NativeStarMapCatalogIdentity,
): NativeStarMapCatalogFrame | null {
  const frame = snapshot.frame;
  if (!frame || !sameScope(frame, identity) || frame.revision > identity.revision ||
      snapshot.requestedRevision !== null && identity.revision < snapshot.requestedRevision) return null;
  if (snapshot.status === "ready" && exactIdentity(frame, identity)) return frame;
  return snapshot.status === "ready" || snapshot.status === "loading" || snapshot.status === "unavailable"
    ? frame
    : null;
}

export class NativeStarMapCatalogStore {
  private snapshot: NativeStarMapCatalogSnapshot = EMPTY_SNAPSHOT;
  private token = 0;
  private currentIdentityKey: string | null = null;
  private flight: { key: string; promise: Promise<NativeStarMapCatalogRefreshResult> } | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NativeStarMapCatalogSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.token += 1;
    this.currentIdentityKey = null;
    this.flight = null;
    this.publish(EMPTY_SNAPSHOT);
  }

  refresh(
    source: NativeStarMapCatalogSource,
    identity: NativeStarMapCatalogIdentity,
  ): Promise<NativeStarMapCatalogRefreshResult> {
    if (!validIdentity(identity) || !exactIdentity(source.boundIdentity, identity)) {
      this.invalidate();
      return Promise.resolve("unavailable");
    }
    const key = identityKey(identity);
    if (this.flight?.key === key) return this.flight.promise;
    if (this.snapshot.status === "ready" && this.snapshot.frame &&
        exactIdentity(this.snapshot.frame, identity)) return Promise.resolve("committed");
    const token = ++this.token;
    this.currentIdentityKey = key;
    const previous = this.snapshot.frame && sameScope(this.snapshot.frame, identity) &&
        this.snapshot.frame.revision <= identity.revision &&
        identity.revision >= (this.snapshot.requestedRevision ?? this.snapshot.frame.revision)
      ? this.snapshot.frame
      : null;
    this.publish(Object.freeze({
      status: "loading",
      requestedRevision: identity.revision,
      frame: previous,
    }));
    const promise = this.performRefresh(source, identity, token, previous);
    this.flight = { key, promise };
    void promise.finally(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    return promise;
  }

  private async performRefresh(
    source: NativeStarMapCatalogSource,
    identity: NativeStarMapCatalogIdentity,
    token: number,
    previous: NativeStarMapCatalogFrame | null,
  ): Promise<NativeStarMapCatalogRefreshResult> {
    let systemCursor = 0;
    let planetCursor = 0;
    let first: DesktopNativeCoreStarMapCatalogProjectionResult | null = null;
    const systems: DesktopNativeCoreStarMapCatalogSystemRow[] = [];
    const planets: DesktopNativeCoreStarMapCatalogPlanetRow[] = [];
    for (let pageIndex = 0; pageIndex < NATIVE_STAR_MAP_CATALOG_MAX_PAGES; pageIndex += 1) {
      const request = {
        systemCursor,
        systemLimit: NATIVE_STAR_MAP_CATALOG_PAGE_ROWS,
        planetCursor,
        planetLimit: NATIVE_STAR_MAP_CATALOG_PAGE_ROWS,
      } as const;
      const projection = await source.readVerifiedStarMapCatalogProjection(request, identity.revision);
      if (token !== this.token) return "superseded";
      if (!projection || !exactProjectionRequest(projection, identity, request) ||
          first && !sameHeader(first, projection)) {
        return this.fail(identity, token, previous);
      }
      first ??= projection;
      systems.push(...projection.systems.rows);
      planets.push(...projection.planets.rows);
      if (systems.length > NATIVE_STAR_MAP_CATALOG_MAX_ROWS ||
          planets.length > NATIVE_STAR_MAP_CATALOG_MAX_ROWS) {
        return this.fail(identity, token, previous);
      }
      const nextSystemCursor = projection.systems.nextCursor;
      const nextPlanetCursor = projection.planets.nextCursor;
      if (nextSystemCursor === null && nextPlanetCursor === null) {
        const frame = completeFrame(identity, first, systems, planets);
        if (!frame) return this.fail(identity, token, previous);
        if (token !== this.token) return "superseded";
        this.publish(Object.freeze({
          status: "ready",
          requestedRevision: identity.revision,
          frame,
        }));
        return "committed";
      }
      const nextSystem = nextSystemCursor ?? projection.systems.totalCount;
      const nextPlanet = nextPlanetCursor ?? projection.planets.totalCount;
      if (nextSystem === systemCursor && nextPlanet === planetCursor) {
        return this.fail(identity, token, previous);
      }
      systemCursor = nextSystem;
      planetCursor = nextPlanet;
    }
    return this.fail(identity, token, previous);
  }

  private fail(
    identity: NativeStarMapCatalogIdentity,
    token: number,
    previous: NativeStarMapCatalogFrame | null,
  ): NativeStarMapCatalogRefreshResult {
    if (token !== this.token) return "superseded";
    this.publish(Object.freeze({
      status: "unavailable",
      requestedRevision: identity.revision,
      frame: previous,
    }));
    return "unavailable";
  }

  private invalidate(): void {
    this.token += 1;
    this.flight = null;
    this.currentIdentityKey = null;
    this.publish(Object.freeze({ status: "unavailable", requestedRevision: null, frame: null }));
  }

  private publish(snapshot: NativeStarMapCatalogSnapshot): void {
    if (this.snapshot === snapshot) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
