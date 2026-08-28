import { describe, expect, it, vi } from "vitest";
import type {
  DesktopBridge,
  DesktopNativeCoreStarMapOverviewProjectionResult,
  DesktopNativeCoreStarMapSystemRow,
  DesktopNativeCoreStellarIndustryPlanetRow,
  DesktopNativeCoreStellarIndustryProjectionResult,
  DesktopNativeCoreStellarIndustryRouteRow,
  DesktopNativeCoreStellarIndustryStationRow,
  DesktopNativeCoreStellarIndustryV2ProjectionResult,
} from "../desktop";
import {
  DEFAULT_NATIVE_STELLAR_ROUTE_SELECTOR,
  NATIVE_STELLAR_INDUSTRY_PAGE_CACHE_ENTRIES,
  NATIVE_STELLAR_PAGE_ROWS,
  NativeStellarWorkspaceStore,
  createNativePlayerAuthorityStellarProjectionSource,
  createNativeShadowStellarProjectionSource,
  selectNativeShadowStarMapWorkspaceReadModel,
  selectNativeStarMapWorkspaceReadModel,
  validNativeStarMapOverviewSelector,
  validNativeStellarIndustryBaseSelector,
  validNativeStellarIndustrySelector,
  type NativeStarMapOverviewSelector,
  type NativeStellarIndustryBaseSelector,
  type NativeStellarIndustrySelector,
  type NativeStellarProjectionIdentity,
  type NativeStellarWorkspaceSource,
} from "./nativeStellarWorkspaceStore";

const IDENTITY: NativeStellarProjectionIdentity = Object.freeze({
  sessionId: "authority-session-1",
  revision: 17,
  registryFingerprint: "registry-fingerprint-1",
});
const NEXT_IDENTITY: NativeStellarProjectionIdentity = Object.freeze({ ...IDENTITY, revision: 18 });
const OVERVIEW_SELECTOR = Object.freeze({ cursor: 0, limit: 1 });
const INDUSTRY_BASE_SELECTOR = Object.freeze({
  systemId: null,
  planetId: null,
  planetCursor: 0,
  planetLimit: 1,
  stationCursor: 0,
  stationLimit: 1,
});
const INDUSTRY_SELECTOR: NativeStellarIndustrySelector = Object.freeze({
  ...INDUSTRY_BASE_SELECTOR,
  routeCursor: 0,
  routeLimit: 1,
  routeFilter: "all",
  query: "",
});
const LIMITS = Object.freeze({
  requestBytes: 32_768 as const,
  projectionBytes: 1_048_576 as const,
  pageRows: 64 as const,
  labelBytes: 512 as const,
});

function systemRow(index: number): DesktopNativeCoreStarMapSystemRow {
  return {
    systemId: `system-${index}`,
    displayName: `System ${index}`,
    displayNameTruncated: false,
    starTypeName: "G",
    starTypeNameTruncated: false,
    positionX: index,
    positionY: index,
    distanceFromOriginLy: index,
    luminosity: 1,
    active: index === 0,
    unlocked: true,
    missionActive: false,
    missionElapsedSeconds: 0,
    missionDurationSeconds: 0,
    surveyProgress: 1,
    firstPlanetId: `planet-${index}`,
    planetCount: 1,
    colonizedPlanetCount: 1,
    entityCount: 1,
    deviceCount: 1,
    beltCount: 0,
    stationCount: 1,
    interstellarStationCount: 1,
    orbitalCollectorCount: 0,
    legacyStationCount: 1,
    quantumStationCount: 0,
    quantumAttachableCount: 0,
    configuredImportSlotCount: 1,
    configuredExportSlotCount: 1,
    routeCount: 1,
    activeRouteCount: 1,
    generationKw: 10,
    demandKw: 5,
    powerFactor: 1,
  };
}

function planetRow(index: number): DesktopNativeCoreStellarIndustryPlanetRow {
  return {
    planetId: `planet-${index}`,
    displayName: `Planet ${index}`,
    displayNameTruncated: false,
    systemId: `system-${index}`,
    systemDisplayName: `System ${index}`,
    systemDisplayNameTruncated: false,
    kind: "terrestrial",
    orbitIndex: 1,
    simulationOrder: index,
    systemPositionX: index,
    systemPositionY: index,
    active: index === 0,
    discovered: true,
    colonized: true,
    industryRole: "manufacturing",
    entityCount: 1,
    deviceCount: 1,
    beltCount: 0,
    stationCount: 1,
    interstellarStationCount: 1,
    orbitalCollectorCount: 0,
    legacyStationCount: 1,
    quantumStationCount: 0,
    quantumAttachableCount: 0,
    configuredImportSlotCount: 1,
    configuredExportSlotCount: 1,
    routeCount: 1,
    activeRouteCount: 1,
    congestedStationId: null,
    power: { generationKw: 10, demandKw: 5, powerFactor: 1, totalItemsPerMinute: 60 },
    profile: {
      climateName: "Temperate",
      climateNameTruncated: false,
      oceanType: "water",
      specialization: null,
      specializationName: "",
      specializationNameTruncated: false,
      tidalLocked: false,
      windMultiplier: 1,
      solarMultiplier: 1,
      geothermalMultiplier: 1,
      miningMultiplier: 1,
      orbitalYieldMultiplier: 1,
      reserveScale: 1,
      travelTimeMultiplier: 1,
    },
  };
}

function stationRow(index: number): DesktopNativeCoreStellarIndustryStationRow {
  return {
    stationId: `station-${index}`,
    buildingId: "interstellar_logistics_station",
    buildingLabel: "Interstellar station",
    buildingLabelTruncated: false,
    planetId: `planet-${index}`,
    planetLabel: `Planet ${index}`,
    planetLabelTruncated: false,
    systemId: `system-${index}`,
    positionX: index,
    positionY: index,
    stationTier: 1,
    quantumMode: null,
    quantumTransitionActive: false,
    powerFactor: 1,
    congestion: 0,
    installedDrones: 10,
    installedVessels: 2,
    availableWarpers: 4,
    slotCount: 2,
    configuredImportSlotCount: 1,
    configuredExportSlotCount: 1,
    routeCount: 1,
    activeRouteCount: 1,
  };
}

function routeRow(index: number): DesktopNativeCoreStellarIndustryRouteRow {
  return {
    id: `route-${index}`,
    scope: "remote",
    itemId: "iron_ore",
    itemLabel: "Iron ore",
    itemLabelTruncated: false,
    sourceStationId: `source-station-${index}`,
    sourceStationLabel: "Source station",
    sourceStationLabelTruncated: false,
    sourceBuildingId: "interstellar_logistics_station",
    sourceBuildingLabel: "Interstellar station",
    sourceSlotIndex: 0,
    sourcePlanetId: `source-planet-${index}`,
    sourcePlanetLabel: "Source planet",
    sourcePlanetLabelTruncated: false,
    targetStationId: `station-${index}`,
    targetStationLabel: "Target station",
    targetStationLabelTruncated: false,
    targetBuildingId: "interstellar_logistics_station",
    targetBuildingLabel: "Interstellar station",
    targetSlotIndex: 0,
    targetPlanetId: `planet-${index}`,
    targetPlanetLabel: `Planet ${index}`,
    targetPlanetLabelTruncated: false,
    sourceStock: 450,
    sourceReserve: 50,
    sourceSlotMinStock: 50,
    sourceSlotMaxStock: 500,
    targetStock: 25,
    targetLimit: 200,
    targetFree: 125,
    targetSlotMinStock: 10,
    targetSlotMaxStock: 200,
    minimumLoad: 0.5,
    minimumCargo: 50,
    priority: 2,
    installedVehicles: 5,
    installedVehicleCapacity: 500,
    availableVehicles: 4,
    activeVehicles: 1,
    activeRouteCount: 1,
    activeCargo: 50,
    activeRouteItemConsistent: true,
    distanceLy: 3,
    orbitSpan: 2,
    durationSeconds: 12,
    cargoPerTrip: 500,
    throughputPerMinute: 2_500,
    economicsThroughputPerMinute: 2_500,
    powerKw: 1_000,
    energyMjPerTrip: 12,
    warpersPerTrip: 5,
    warpersPerVessel: 1,
    availableWarpers: 10,
    dispatchStationId: `source-station-${index}`,
    dispatchPlanetId: `source-planet-${index}`,
    dispatchDirection: "supply-delivery",
    routeKind: "direct",
    routeAvailable: true,
    routePlanningComplete: true,
    routePathLabel: "Source → Target",
    routePathLabelTruncated: false,
    waypointStationIds: [],
    waypointPlanetIds: [],
    waypointStationLabels: [],
    hopCount: 1,
    maxLegDistanceLy: 3,
    routePolicy: "direct",
    warperBudget: 2,
    requiresWarp: true,
    warpVehicleReady: true,
    localVehiclePowerReady: true,
    sourcePowerFactor: 1,
    targetPowerFactor: 1,
    routePowerReady: true,
    powerProofComplete: true,
    sourceCongestion: 0,
    targetCongestion: 0,
    waypointMaxCongestion: 0,
    routeCongestion: 0,
    status: "active",
    statusLabel: "Active",
  };
}

const SYSTEM_ROWS = Object.freeze([systemRow(0), systemRow(1)]);
const PLANET_ROWS = Object.freeze([planetRow(0), planetRow(1)]);
const STATION_ROWS = Object.freeze([stationRow(0), stationRow(1)]);
const ROUTE_ROWS = Object.freeze([routeRow(0), routeRow(1)]);

function page<Row>(rows: readonly Row[], cursor: number, limit: number) {
  const selected = rows.slice(cursor, cursor + limit);
  const consumed = cursor + selected.length;
  return {
    cursor,
    limit,
    totalCount: rows.length,
    nextCursor: consumed < rows.length ? consumed : null,
    rows: selected,
  };
}

function overview(
  selector: NativeStarMapOverviewSelector,
  identity: NativeStellarProjectionIdentity = IDENTITY,
  rows: readonly DesktopNativeCoreStarMapSystemRow[] = SYSTEM_ROWS,
): DesktopNativeCoreStarMapOverviewProjectionResult {
  return {
    schemaVersion: 1,
    projectionType: "star-map-overview-v1",
    revision: identity.revision,
    registryFingerprint: identity.registryFingerprint,
    stateVersion: 47,
    limits: LIMITS,
    request: {
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      ...selector,
    },
    activePlanetId: "planet-0",
    activeSystemId: "system-0",
    galaxySeed: 42,
    summary: {
      systemCount: rows.length,
      unlockedSystemCount: rows.length,
      planetCount: rows.length,
      colonizedPlanetCount: rows.length,
      stationCount: rows.length,
    },
    systems: page(rows, selector.cursor, selector.limit),
  };
}

function industryV2(
  selector: NativeStellarIndustrySelector,
  identity: NativeStellarProjectionIdentity = IDENTITY,
  overrides: Partial<DesktopNativeCoreStellarIndustryV2ProjectionResult> = {},
): DesktopNativeCoreStellarIndustryV2ProjectionResult {
  const planets = page(PLANET_ROWS, selector.planetCursor, selector.planetLimit);
  const stations = page(STATION_ROWS, selector.stationCursor, selector.stationLimit);
  const routes = page(ROUTE_ROWS, selector.routeCursor, selector.routeLimit);
  return {
    schemaVersion: 2,
    projectionType: "stellar-industry-v2",
    revision: identity.revision,
    registryFingerprint: identity.registryFingerprint,
    stateVersion: 47,
    limits: { ...LIMITS, queryBytes: 512, pathVisits: 200_000 },
    request: {
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      ...selector,
    },
    activePlanetId: "planet-0",
    activeSystemId: "system-0",
    scopeSystemId: selector.systemId,
    scopePlanetId: selector.planetId,
    truncated: planets.nextCursor !== null || stations.nextCursor !== null || routes.nextCursor !== null,
    planets,
    stations,
    routeSummary: {
      scopeTotalCount: ROUTE_ROWS.length,
      filteredCount: ROUTE_ROWS.length,
      activeCount: ROUTE_ROWS.length,
      blockedCount: 0,
      remoteCount: ROUTE_ROWS.length,
      routePlanningIncompleteCount: 0,
      powerUnprovenCount: 0,
      statusCounts: { active: ROUTE_ROWS.length },
    },
    routes,
    ...overrides,
  };
}

function industryV1(
  selector: NativeStellarIndustryBaseSelector,
  identity: NativeStellarProjectionIdentity = IDENTITY,
): DesktopNativeCoreStellarIndustryProjectionResult {
  const planets = page(PLANET_ROWS, selector.planetCursor, selector.planetLimit);
  const stations = page(STATION_ROWS, selector.stationCursor, selector.stationLimit);
  return {
    schemaVersion: 1,
    projectionType: "stellar-industry-v1",
    revision: identity.revision,
    registryFingerprint: identity.registryFingerprint,
    stateVersion: 47,
    limits: LIMITS,
    request: {
      expectedRevision: identity.revision,
      expectedRegistryFingerprint: identity.registryFingerprint,
      ...selector,
    },
    activePlanetId: "planet-0",
    activeSystemId: "system-0",
    scopeSystemId: selector.systemId,
    scopePlanetId: selector.planetId,
    truncated: planets.nextCursor !== null || stations.nextCursor !== null,
    planets,
    stations,
  };
}

function playerSource(
  identity: NativeStellarProjectionIdentity = IDENTITY,
  overrides: Partial<NativeStellarWorkspaceSource> = {},
): NativeStellarWorkspaceSource {
  return {
    mode: "player-authority",
    boundIdentity: identity,
    readVerifiedStarMapOverviewProjection: vi.fn(async (selector) => overview(selector, identity)),
    readVerifiedStellarIndustryV2Projection: vi.fn(async (selector) => industryV2(selector, identity)),
    ...overrides,
  };
}

describe("native stellar workspace projection sources", () => {
  it("binds player authority to v2 and never accepts a v1-only desktop bridge", async () => {
    const getOverview = vi.fn(async (request) => overview({
      cursor: request.cursor,
      limit: request.limit,
    }, IDENTITY));
    const getIndustryV2 = vi.fn(async (request) => industryV2({
      systemId: request.systemId,
      planetId: request.planetId,
      planetCursor: request.planetCursor,
      planetLimit: request.planetLimit,
      stationCursor: request.stationCursor,
      stationLimit: request.stationLimit,
      routeCursor: request.routeCursor,
      routeLimit: request.routeLimit,
      routeFilter: request.routeFilter,
      query: request.query,
    }, IDENTITY));
    const getIndustryV1 = vi.fn();
    const bridge = {
      getNativeCoreStarMapOverviewProjection: getOverview,
      getNativeCoreStellarIndustryV2Projection: getIndustryV2,
      getNativeCoreStellarIndustryProjection: getIndustryV1,
    } as unknown as Pick<
      DesktopBridge,
      "getNativeCoreStarMapOverviewProjection" | "getNativeCoreStellarIndustryV2Projection"
    >;
    const source = createNativePlayerAuthorityStellarProjectionSource(bridge, IDENTITY);
    expect(source).not.toBeNull();

    await expect(source!.readVerifiedStarMapOverviewProjection(
      OVERVIEW_SELECTOR,
      IDENTITY.revision,
    )).resolves.toEqual(overview(OVERVIEW_SELECTOR));
    await expect(source!.readVerifiedStellarIndustryV2Projection!(
      INDUSTRY_SELECTOR,
      IDENTITY.revision,
    )).resolves.toEqual(industryV2(INDUSTRY_SELECTOR));
    expect(getIndustryV2).toHaveBeenCalledWith({
      sessionId: IDENTITY.sessionId,
      expectedRevision: IDENTITY.revision,
      expectedRegistryFingerprint: IDENTITY.registryFingerprint,
      ...INDUSTRY_SELECTOR,
    });
    expect(getIndustryV1).not.toHaveBeenCalled();

    const legacyOnly = createNativePlayerAuthorityStellarProjectionSource({
      getNativeCoreStarMapOverviewProjection: getOverview,
    }, IDENTITY);
    expect(legacyOnly).toBeNull();
  });

  it("fails closed for forged identity, echoed request, page chain, and transport errors", async () => {
    const forged = createNativePlayerAuthorityStellarProjectionSource({
      getNativeCoreStarMapOverviewProjection: vi.fn(async (request) => ({
        ...overview(request),
        registryFingerprint: "forged",
      })),
      getNativeCoreStellarIndustryV2Projection: vi.fn(async (request) => ({
        ...industryV2(request),
        request: { ...industryV2(request).request, routeCursor: request.routeCursor + 1 },
      })),
    }, IDENTITY)!;
    await expect(forged.readVerifiedStarMapOverviewProjection(
      OVERVIEW_SELECTOR,
      IDENTITY.revision,
    )).resolves.toBeNull();
    await expect(forged.readVerifiedStellarIndustryV2Projection!(
      INDUSTRY_SELECTOR,
      IDENTITY.revision,
    )).resolves.toBeNull();
    await expect(forged.readVerifiedStarMapOverviewProjection(
      OVERVIEW_SELECTOR,
      IDENTITY.revision + 1,
    )).resolves.toBeNull();

    const broken = createNativePlayerAuthorityStellarProjectionSource({
      getNativeCoreStarMapOverviewProjection: vi.fn(async () => { throw new Error("lost"); }),
      getNativeCoreStellarIndustryV2Projection: vi.fn(async () => { throw new Error("lost"); }),
    }, IDENTITY)!;
    await expect(broken.readVerifiedStarMapOverviewProjection(
      OVERVIEW_SELECTOR,
      IDENTITY.revision,
    )).resolves.toBeNull();
  });

  it("adapts the controller explicitly as shadow and prefers v2 when both versions exist", async () => {
    const v1 = vi.fn(async (selector) => industryV1(selector));
    const v2 = vi.fn(async (selector) => industryV2(selector));
    const shadow = createNativeShadowStellarProjectionSource({
      readVerifiedStarMapOverviewProjection: vi.fn(async (selector) => overview(selector)),
      readVerifiedStellarIndustryProjection: v1,
      readVerifiedStellarIndustryV2Projection: v2,
    })!;
    const store = new NativeStellarWorkspaceStore();
    await expect(store.refreshIndustry(shadow, IDENTITY, INDUSTRY_SELECTOR)).resolves.toBe("committed");
    expect(store.getSnapshot().industry.frame?.sourceVersion).toBe(2);
    expect(v2).toHaveBeenCalledTimes(2);
    expect(v1).not.toHaveBeenCalled();
  });
});

describe("NativeStellarWorkspaceStore v2 pages", () => {
  it("assembles complete bounded pages and exposes indexed StarMapWorkspace rows", async () => {
    const source = playerSource();
    const store = new NativeStellarWorkspaceStore();
    await expect(Promise.all([
      store.refreshOverview(source, IDENTITY, OVERVIEW_SELECTOR),
      store.refreshIndustry(source, IDENTITY, INDUSTRY_SELECTOR),
    ])).resolves.toEqual(["committed", "committed"]);

    const snapshot = store.getSnapshot();
    expect(snapshot.overview).toMatchObject({ status: "ready", requestedRevision: 17 });
    expect(snapshot.overview.frame?.systems.map((row) => row.systemId)).toEqual(["system-0", "system-1"]);
    expect(snapshot.industry).toMatchObject({ status: "ready", requestedRevision: 17 });
    expect(snapshot.industry.frame).toMatchObject({ sourceMode: "player-authority", sourceVersion: 2 });
    expect(snapshot.industry.frame?.projection).toMatchObject({
      schemaVersion: 1,
      projectionType: "stellar-industry-v1",
    });
    expect(snapshot.industry.frame?.projectionV2).toMatchObject({
      schemaVersion: 2,
      projectionType: "stellar-industry-v2",
    });
    expect(snapshot.industry.frame?.routes?.map((row) => row.id)).toEqual(["route-0", "route-1"]);
    expect(snapshot.industry.frame?.planetRowsById.get("planet-1")?.displayName).toBe("Planet 1");
    expect(snapshot.industry.frame?.routeRowsByTargetStationId?.get("station-1")?.[0]?.id).toBe("route-1");

    const model = selectNativeStarMapWorkspaceReadModel(snapshot, IDENTITY, INDUSTRY_SELECTOR);
    expect(model).not.toBeNull();
    expect(model?.systems).toHaveLength(2);
    expect(model?.planets).toHaveLength(2);
    expect(model?.stations).toHaveLength(2);
    expect(model?.routes).toHaveLength(2);
    expect(selectNativeStarMapWorkspaceReadModel(snapshot, NEXT_IDENTITY)).toBeNull();
    expect(source.readVerifiedStarMapOverviewProjection).toHaveBeenCalledTimes(2);
    expect(source.readVerifiedStellarIndustryV2Projection).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-page metadata drift and duplicate row identities", async () => {
    const read = vi.fn(async (selector: NativeStellarIndustrySelector) => {
      const result = industryV2(selector);
      if (selector.routeCursor === 1) {
        return {
          ...result,
          routeSummary: { ...result.routeSummary, activeCount: result.routeSummary.activeCount - 1 },
        };
      }
      return result;
    });
    const store = new NativeStellarWorkspaceStore();
    await expect(store.refreshIndustry(playerSource(IDENTITY, {
      readVerifiedStellarIndustryV2Projection: read,
    }), IDENTITY, INDUSTRY_SELECTOR)).resolves.toBe("unavailable");
    expect(store.getSnapshot().industry).toMatchObject({ status: "unavailable", frame: null });

    const duplicateRead = vi.fn(async (selector: NativeStarMapOverviewSelector) => {
      const result = overview(selector);
      return selector.cursor === 1
        ? { ...result, systems: { ...result.systems, rows: [systemRow(0)] } }
        : result;
    });
    await expect(store.refreshOverview(playerSource(IDENTITY, {
      readVerifiedStarMapOverviewProjection: duplicateRead,
    }), IDENTITY, OVERVIEW_SELECTOR)).resolves.toBe("unavailable");
  });

  it("cancels an old page chain when a newer identity starts", async () => {
    let releaseOld!: (value: DesktopNativeCoreStarMapOverviewProjectionResult) => void;
    const oldRead = vi.fn((selector: NativeStarMapOverviewSelector) => new Promise<DesktopNativeCoreStarMapOverviewProjectionResult>((resolve) => {
      releaseOld = resolve;
    }));
    const store = new NativeStellarWorkspaceStore();
    const oldRequest = store.refreshOverview(playerSource(IDENTITY, {
      readVerifiedStarMapOverviewProjection: oldRead,
    }), IDENTITY, OVERVIEW_SELECTOR);
    await expect(store.refreshOverview(playerSource(NEXT_IDENTITY), NEXT_IDENTITY, OVERVIEW_SELECTOR)).resolves.toBe("committed");
    releaseOld(overview(OVERVIEW_SELECTOR));
    await expect(oldRequest).resolves.toBe("superseded");
    expect(oldRead).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().overview.frame?.revision).toBe(NEXT_IDENTITY.revision);
  });

  it("single-flights duplicate requests and keeps only the newest selector observable", async () => {
    let releaseOld!: (value: DesktopNativeCoreStarMapOverviewProjectionResult) => void;
    const read = vi.fn((selector: NativeStarMapOverviewSelector) => selector.limit === 2
      ? new Promise<DesktopNativeCoreStarMapOverviewProjectionResult>((resolve) => {
          releaseOld = resolve;
        })
      : Promise.resolve(overview(selector)));
    const source = playerSource(IDENTITY, { readVerifiedStarMapOverviewProjection: read });
    const store = new NativeStellarWorkspaceStore();
    const first = store.refreshOverview(source, IDENTITY, { cursor: 0, limit: 2 });
    const duplicate = store.refreshOverview(source, IDENTITY, { cursor: 0, limit: 2 });
    expect(first).toBe(duplicate);
    expect(read).toHaveBeenCalledTimes(1);

    const latest = store.refreshOverview(source, IDENTITY, { cursor: 0, limit: 1 });
    await expect(latest).resolves.toBe("committed");
    expect(store.getSnapshot().overview.frame?.selector).toEqual({ cursor: 0, limit: 1 });

    releaseOld(overview({ cursor: 0, limit: 2 }));
    await expect(first).resolves.toBe("superseded");
    await expect(duplicate).resolves.toBe("superseded");
    expect(store.getSnapshot().overview.frame?.selector).toEqual({ cursor: 0, limit: 1 });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("bounds the v2 page cache with LRU eviction", async () => {
    const read = vi.fn(async (selector: NativeStellarIndustrySelector) => industryV2({
      ...selector,
      planetLimit: NATIVE_STELLAR_PAGE_ROWS,
      stationLimit: NATIVE_STELLAR_PAGE_ROWS,
      routeLimit: NATIVE_STELLAR_PAGE_ROWS,
    }));
    const source = playerSource(IDENTITY, {
      readVerifiedStellarIndustryV2Projection: vi.fn(async (selector) => {
        const result = await read(selector);
        return {
          ...result,
          request: { ...result.request, ...selector },
          planets: page(PLANET_ROWS, selector.planetCursor, selector.planetLimit),
          stations: page(STATION_ROWS, selector.stationCursor, selector.stationLimit),
          routes: page(ROUTE_ROWS, selector.routeCursor, selector.routeLimit),
          truncated: false,
        };
      }),
    });
    const store = new NativeStellarWorkspaceStore();
    const selector = {
      ...INDUSTRY_SELECTOR,
      planetLimit: NATIVE_STELLAR_PAGE_ROWS,
      stationLimit: NATIVE_STELLAR_PAGE_ROWS,
      routeLimit: NATIVE_STELLAR_PAGE_ROWS,
    };
    for (let index = 0; index <= NATIVE_STELLAR_INDUSTRY_PAGE_CACHE_ENTRIES; index += 1) {
      await expect(store.refreshIndustry(source, IDENTITY, { ...selector, query: `query-${index}` }))
        .resolves.toBe("committed");
    }
    await expect(store.refreshIndustry(source, IDENTITY, { ...selector, query: "query-0" }))
      .resolves.toBe("committed");
    expect(source.readVerifiedStellarIndustryV2Projection)
      .toHaveBeenCalledTimes(NATIVE_STELLAR_INDUSTRY_PAGE_CACHE_ENTRIES + 2);
  });
});

describe("stellar authority fallback and selectors", () => {
  it("allows legacy v1 only through an explicit shadow source", async () => {
    const v1 = vi.fn(async (selector) => industryV1(selector));
    const shadow = createNativeShadowStellarProjectionSource({
      readVerifiedStarMapOverviewProjection: vi.fn(async (selector) => overview(selector)),
      readVerifiedStellarIndustryProjection: v1,
    })!;
    const store = new NativeStellarWorkspaceStore();
    await expect(Promise.all([
      store.refreshOverview(shadow, IDENTITY, OVERVIEW_SELECTOR),
      store.refreshIndustry(shadow, IDENTITY, INDUSTRY_BASE_SELECTOR),
    ])).resolves.toEqual(["committed", "committed"]);
    expect(store.getSnapshot().industry.frame).toMatchObject({ sourceMode: "shadow", sourceVersion: 1 });
    expect(store.getSnapshot().industry.frame?.routes).toBeNull();
    expect(selectNativeStarMapWorkspaceReadModel(store.getSnapshot(), IDENTITY)).toBeNull();
    expect(selectNativeShadowStarMapWorkspaceReadModel(store.getSnapshot(), IDENTITY)?.routes).toBeNull();
    expect(v1).toHaveBeenCalledTimes(2);
  });

  it("fails closed for player authority instead of using an available v1 reader", async () => {
    const v1 = vi.fn(async (selector) => industryV1(selector));
    const source: NativeStellarWorkspaceSource = {
      mode: "player-authority",
      boundIdentity: IDENTITY,
      readVerifiedStarMapOverviewProjection: vi.fn(async (selector) => overview(selector)),
      readVerifiedStellarIndustryProjection: v1,
    };
    const store = new NativeStellarWorkspaceStore();
    await expect(store.refreshIndustry(source, IDENTITY, INDUSTRY_BASE_SELECTOR)).resolves.toBe("unavailable");
    expect(v1).not.toHaveBeenCalled();
    expect(store.getSnapshot().industry.frame).toBeNull();
  });

  it("does not fall back to v1 when an explicit shadow v2 read fails", async () => {
    const v1 = vi.fn(async (selector) => industryV1(selector));
    const shadow = createNativeShadowStellarProjectionSource({
      readVerifiedStarMapOverviewProjection: vi.fn(async (selector) => overview(selector)),
      readVerifiedStellarIndustryV2Projection: vi.fn(async () => null),
      readVerifiedStellarIndustryProjection: v1,
    })!;
    const store = new NativeStellarWorkspaceStore();
    await expect(store.refreshIndustry(shadow, IDENTITY, INDUSTRY_SELECTOR)).resolves.toBe("unavailable");
    expect(v1).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs, nonzero initial cursors, filters, and UTF-8 query overflow before reading", async () => {
    const source = playerSource();
    const store = new NativeStellarWorkspaceStore();
    await expect(store.refreshOverview(source, IDENTITY, { cursor: 1, limit: 1 })).resolves.toBe("unavailable");
    await expect(store.refreshIndustry(source, IDENTITY, {
      ...INDUSTRY_SELECTOR,
      systemId: "system with spaces",
    })).resolves.toBe("unavailable");
    await expect(store.refreshIndustry(source, IDENTITY, {
      ...INDUSTRY_SELECTOR,
      routeCursor: 1,
    })).resolves.toBe("unavailable");
    await expect(store.refreshIndustry(source, IDENTITY, {
      ...INDUSTRY_SELECTOR,
      query: "界".repeat(171),
    })).resolves.toBe("unavailable");
    await expect(store.refreshIndustry(source, IDENTITY, {
      ...INDUSTRY_SELECTOR,
      query: "bad\nquery",
    })).resolves.toBe("unavailable");
    expect(source.readVerifiedStarMapOverviewProjection).not.toHaveBeenCalled();
    expect(source.readVerifiedStellarIndustryV2Projection).not.toHaveBeenCalled();
  });

  it("validates base and v2 selectors independently", () => {
    expect(validNativeStarMapOverviewSelector({ cursor: 0, limit: 64 })).toBe(true);
    expect(validNativeStarMapOverviewSelector({ cursor: 0, limit: 0 })).toBe(false);
    expect(validNativeStellarIndustryBaseSelector(INDUSTRY_BASE_SELECTOR)).toBe(true);
    expect(validNativeStellarIndustrySelector(INDUSTRY_SELECTOR)).toBe(true);
    expect(validNativeStellarIndustrySelector({
      ...INDUSTRY_SELECTOR,
      routeFilter: "invalid" as "all",
    })).toBe(false);
    expect(DEFAULT_NATIVE_STELLAR_ROUTE_SELECTOR).toEqual({
      routeCursor: 0,
      routeLimit: 64,
      routeFilter: "all",
      query: "",
    });
  });
});
