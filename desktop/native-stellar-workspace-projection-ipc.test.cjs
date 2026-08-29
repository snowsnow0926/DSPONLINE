"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const root = path.resolve(__dirname, "..");
const limits = Object.freeze({
  requestBytes: 32_768,
  projectionBytes: 1_048_576,
  pageRows: 64,
  labelBytes: 512,
});

function starMapContext() {
  return {
    sessionId: "authority-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "builtin:test",
    cursor: 0,
    limit: 64,
  };
}

function systemRow() {
  return {
    systemId: "helios",
    displayName: "Helios",
    displayNameTruncated: false,
    starTypeName: "G",
    starTypeNameTruncated: false,
    positionX: -12,
    positionY: 18,
    distanceFromOriginLy: 3,
    luminosity: 1.25,
    active: true,
    unlocked: true,
    missionActive: false,
    missionElapsedSeconds: 0,
    missionDurationSeconds: 0,
    surveyProgress: 1,
    firstPlanetId: "home",
    planetCount: 1,
    colonizedPlanetCount: 1,
    entityCount: 4,
    deviceCount: 4,
    beltCount: 3,
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

function starMapProjection() {
  return {
    schemaVersion: 1,
    projectionType: "star-map-overview-v1",
    revision: 7,
    registryFingerprint: "builtin:test",
    stateVersion: 47,
    limits,
    request: {
      expectedRevision: 7,
      expectedRegistryFingerprint: "builtin:test",
      cursor: 0,
      limit: 64,
    },
    activePlanetId: "home",
    activeSystemId: "helios",
    galaxySeed: 42,
    summary: {
      systemCount: 1,
      unlockedSystemCount: 1,
      planetCount: 1,
      colonizedPlanetCount: 1,
      stationCount: 1,
    },
    systems: { cursor: 0, limit: 64, totalCount: 1, nextCursor: null, rows: [systemRow()] },
  };
}

function industryContext() {
  return {
    sessionId: "authority-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "builtin:test",
    systemId: "helios",
    planetId: null,
    planetCursor: 0,
    planetLimit: 64,
    stationCursor: 0,
    stationLimit: 64,
  };
}

function planetRow() {
  return {
    planetId: "home",
    displayName: "Home",
    displayNameTruncated: false,
    systemId: "helios",
    systemDisplayName: "Helios",
    systemDisplayNameTruncated: false,
    kind: "terrestrial",
    orbitIndex: 1,
    simulationOrder: 0,
    systemPositionX: -12,
    systemPositionY: 18,
    active: true,
    discovered: true,
    colonized: true,
    industryRole: "manufacturing",
    entityCount: 4,
    deviceCount: 4,
    beltCount: 3,
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

function stationRow() {
  return {
    stationId: "station-1",
    buildingId: "interstellar_logistics_station",
    buildingLabel: "interstellar_logistics_station",
    buildingLabelTruncated: false,
    planetId: "home",
    planetLabel: "Home",
    planetLabelTruncated: false,
    systemId: "helios",
    positionX: 128,
    positionY: 256,
    stationTier: 1,
    quantumMode: null,
    quantumTransitionActive: false,
    powerFactor: 1,
    congestion: 0.25,
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

function industryProjection() {
  return {
    schemaVersion: 1,
    projectionType: "stellar-industry-v1",
    revision: 7,
    registryFingerprint: "builtin:test",
    stateVersion: 47,
    limits,
    request: {
      expectedRevision: 7,
      expectedRegistryFingerprint: "builtin:test",
      systemId: "helios",
      planetId: null,
      planetCursor: 0,
      planetLimit: 64,
      stationCursor: 0,
      stationLimit: 64,
    },
    activePlanetId: "home",
    activeSystemId: "helios",
    scopeSystemId: "helios",
    scopePlanetId: null,
    truncated: false,
    planets: { cursor: 0, limit: 64, totalCount: 1, nextCursor: null, rows: [planetRow()] },
    stations: { cursor: 0, limit: 64, totalCount: 1, nextCursor: null, rows: [stationRow()] },
  };
}

function industryV2Context() {
  return {
    ...industryContext(),
    routeCursor: 0,
    routeLimit: 64,
    routeFilter: "all",
    query: "",
  };
}

function routeRow() {
  return {
    id: "remote:station-1:0:station-source",
    scope: "remote",
    itemId: "iron_ore",
    itemLabel: "铁矿",
    itemLabelTruncated: false,
    sourceStationId: "station-source",
    sourceStationLabel: "Source · 星际站",
    sourceStationLabelTruncated: false,
    sourceBuildingId: "interstellar_logistics_station",
    sourceBuildingLabel: "星际站",
    sourceSlotIndex: 0,
    sourcePlanetId: "source-world",
    sourcePlanetLabel: "Source",
    sourcePlanetLabelTruncated: false,
    targetStationId: "station-1",
    targetStationLabel: "Home · 星际站",
    targetStationLabelTruncated: false,
    targetBuildingId: "interstellar_logistics_station",
    targetBuildingLabel: "星际站",
    targetSlotIndex: 0,
    targetPlanetId: "home",
    targetPlanetLabel: "Home",
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
    throughputPerMinute: 2500,
    economicsThroughputPerMinute: 2500,
    powerKw: 1000,
    energyMjPerTrip: 12,
    warpersPerTrip: 5,
    warpersPerVessel: 1,
    availableWarpers: 10,
    dispatchStationId: "station-source",
    dispatchPlanetId: "source-world",
    dispatchDirection: "supply-delivery",
    routeKind: "direct",
    routeAvailable: true,
    routePlanningComplete: true,
    routePathLabel: "Source → Home",
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
    sourceCongestion: 0.2,
    targetCongestion: 0.25,
    waypointMaxCongestion: 0,
    routeCongestion: 0.25,
    status: "active",
    statusLabel: "运输中",
  };
}

function industryV2Projection() {
  const base = industryProjection();
  return {
    ...base,
    schemaVersion: 2,
    projectionType: "stellar-industry-v2",
    limits: { ...limits, queryBytes: 512, pathVisits: 200_000 },
    request: {
      ...base.request,
      routeCursor: 0,
      routeLimit: 64,
      routeFilter: "all",
      query: "",
    },
    routeSummary: {
      scopeTotalCount: 1,
      filteredCount: 1,
      activeCount: 1,
      blockedCount: 0,
      remoteCount: 1,
      routePlanningIncompleteCount: 0,
      powerUnprovenCount: 0,
      statusCounts: { active: 1 },
    },
    routes: { cursor: 0, limit: 64, totalCount: 1, nextCursor: null, rows: [routeRow()] },
  };
}

function quantumContext() {
  return {
    sessionId: "authority-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "builtin:test",
    itemCursor: 0,
    itemLimit: 64,
    collectorCursor: 0,
    collectorLimit: 64,
  };
}

function quantumProjection() {
  return {
    schemaVersion: 1,
    projectionType: "stellar-quantum-v1",
    revision: 7,
    registryFingerprint: "builtin:test",
    stateVersion: 47,
    limits: {
      requestBytes: 32_768,
      projectionBytes: 1_048_576,
      pageRows: 64,
      decimalDigits: 256,
    },
    request: {
      expectedRevision: 7,
      expectedRegistryFingerprint: "builtin:test",
      itemCursor: 0,
      itemLimit: 64,
      collectorCursor: 0,
      collectorLimit: 64,
    },
    enabled: true,
    bandwidth: {
      multiplier: 1.21,
      globalUploadPerMinute: 18_150,
      globalDownloadPerMinute: 18_150,
      activeTowerCount: 1,
      activeTowerStacks: 3,
    },
    runtime: {
      boundarySecond: 25,
      globalUploadPerMinute: 18_150,
      globalDownloadPerMinute: 18_150,
      quantumTowerStacks: 3,
      quantumCollectorStacks: 5,
    },
    collectorSummary: {
      totalCount: 2,
      connectedCount: 1,
      pendingCount: 1,
      availableCount: 0,
      connectedStacks: 5,
    },
    truncated: false,
    items: {
      cursor: 0,
      limit: 64,
      totalCount: 2,
      nextCursor: null,
      rows: [
        {
          itemId: "iron_ore",
          inventory: "123456789012345678901234567890",
          capacity: "100000",
          uploaded: "7",
          downloaded: "2",
        },
        {
          itemId: "copper_ore",
          inventory: "0",
          capacity: "10000000000",
          uploaded: "0",
          downloaded: "1",
        },
      ],
    },
    collectors: {
      cursor: 0,
      limit: 64,
      totalCount: 2,
      nextCursor: null,
      rows: [
        {
          collectorId: "collector-connected",
          planetId: "home",
          systemId: "helios",
          machineCount: 5,
          quantumMode: "quantum",
          quantumTransitionActive: false,
          attachmentState: "connected",
        },
        {
          collectorId: "collector-pending",
          planetId: "gas-giant",
          systemId: "helios",
          machineCount: 7,
          quantumMode: "transitioning",
          quantumTransitionActive: true,
          attachmentState: "pending",
        },
      ],
    },
  };
}

test("stellar workspace boundaries bind identity, exact request echo, scope, and page chains", () => {
  const map = normalizeRendererNativeResult(
    "coreStarMapOverviewProjection",
    starMapProjection(),
    starMapContext(),
  );
  assert.equal(map.systems.rows[0].systemId, "helios");
  const industry = normalizeRendererNativeResult(
    "coreStellarIndustryProjection",
    industryProjection(),
    industryContext(),
  );
  assert.equal(industry.planets.rows[0].power.totalItemsPerMinute, 60);
  assert.equal(industry.stations.rows[0].stationId, "station-1");

  for (const invalid of [
    { ...starMapProjection(), revision: 8 },
    { ...starMapProjection(), registryFingerprint: "builtin:other" },
    { ...starMapProjection(), stateVersion: 48 },
    { ...starMapProjection(), request: { ...starMapProjection().request, cursor: 1 } },
    {
      ...starMapProjection(),
      systems: { ...starMapProjection().systems, nextCursor: 1 },
    },
    {
      ...starMapProjection(),
      systems: {
        ...starMapProjection().systems,
        rows: [{ ...systemRow(), displayName: "x".repeat(513) }],
      },
    },
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult("coreStarMapOverviewProjection", invalid, starMapContext()),
      { code: "NATIVE_PROTOCOL_INVALID" },
    );
  }

  for (const invalid of [
    { ...industryProjection(), revision: 8 },
    { ...industryProjection(), scopeSystemId: "other" },
    { ...industryProjection(), truncated: true },
    {
      ...industryProjection(),
      planets: {
        ...industryProjection().planets,
        rows: [{ ...planetRow(), systemId: "other" }],
      },
    },
    {
      ...industryProjection(),
      stations: {
        ...industryProjection().stations,
        rows: [{ ...stationRow(), activeRouteCount: 2 }],
      },
    },
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult("coreStellarIndustryProjection", invalid, industryContext()),
      { code: "NATIVE_PROTOCOL_INVALID" },
    );
  }
});

test("stellar industry v2 binds a complete independently paged route model", () => {
  const result = normalizeRendererNativeResult(
    "coreStellarIndustryProjectionV2",
    industryV2Projection(),
    industryV2Context(),
  );
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.routes.rows[0].routePathLabel, "Source → Home");
  assert.equal(result.routeSummary.activeCount, 1);
  assert.deepEqual(result.routes.rows[0].waypointStationIds, []);

  for (const invalid of [
    { ...industryV2Projection(), projectionType: "stellar-industry-v1" },
    { ...industryV2Projection(), limits: { ...industryV2Projection().limits, queryBytes: 511 } },
    { ...industryV2Projection(), request: { ...industryV2Projection().request, routeCursor: 1 } },
    { ...industryV2Projection(), routeSummary: { ...industryV2Projection().routeSummary, activeCount: 0 } },
    {
      ...industryV2Projection(),
      routes: {
        ...industryV2Projection().routes,
        rows: [{ ...routeRow(), waypointStationIds: ["hub"] }],
      },
    },
    {
      ...industryV2Projection(),
      routes: {
        ...industryV2Projection().routes,
        rows: [{ ...routeRow(), availableVehicles: 6 }],
      },
    },
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult(
        "coreStellarIndustryProjectionV2",
        invalid,
        industryV2Context(),
      ),
      { code: "NATIVE_PROTOCOL_INVALID" },
    );
  }
});

test("stellar quantum projection preserves big integer strings and rejects malformed authority data", () => {
  const result = normalizeRendererNativeResult(
    "coreStellarQuantumProjection",
    quantumProjection(),
    quantumContext(),
  );
  assert.equal(result.items.rows[0].inventory, "123456789012345678901234567890");
  assert.equal(result.collectors.rows[1].attachmentState, "pending");
  assert.equal(result.collectorSummary.connectedStacks, 5);

  for (const invalid of [
    { ...quantumProjection(), revision: 8 },
    { ...quantumProjection(), request: { ...quantumProjection().request, itemCursor: 1 } },
    { ...quantumProjection(), unexpected: true },
    {
      ...quantumProjection(),
      items: {
        ...quantumProjection().items,
        rows: [{ ...quantumProjection().items.rows[0], inventory: "007" }, quantumProjection().items.rows[1]],
      },
    },
    {
      ...quantumProjection(),
      items: {
        ...quantumProjection().items,
        rows: [{ ...quantumProjection().items.rows[0], capacity: "9999" }, quantumProjection().items.rows[1]],
      },
    },
    {
      ...quantumProjection(),
      collectors: {
        ...quantumProjection().collectors,
        rows: [
          quantumProjection().collectors.rows[0],
          { ...quantumProjection().collectors.rows[1], attachmentState: "connected" },
        ],
      },
    },
    {
      ...quantumProjection(),
      collectorSummary: { ...quantumProjection().collectorSummary, connectedCount: 2 },
    },
    { ...quantumProjection(), truncated: true },
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult("coreStellarQuantumProjection", invalid, quantumContext()),
      { code: "NATIVE_PROTOCOL_INVALID" },
    );
  }
});

test("stellar workspace projections use trusted direct IPC and checksummed bounded transfer only", () => {
  const main = readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const preload = readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const host = readFileSync(path.join(root, "desktop", "native-host.cjs"), "utf8");
  const desktop = readFileSync(path.join(root, "src", "desktop.ts"), "utf8");
  const nativeCore = readFileSync(path.join(root, "src", "game", "nativeCore.ts"), "utf8");

  assert.match(main, /desktop:native-core-star-map-overview-projection"[\s\S]*?coreStarMapOverviewProjection[\s\S]*?starMapOverviewProjection\(ownerId, request\)/);
  assert.match(main, /desktop:native-core-stellar-industry-projection"[\s\S]*?coreStellarIndustryProjection[\s\S]*?stellarIndustryProjection\(ownerId, request\)/);
  assert.match(main, /desktop:native-core-stellar-industry-v2-projection"[\s\S]*?coreStellarIndustryProjectionV2[\s\S]*?stellarIndustryProjectionV2\(ownerId, request\)/);
  assert.match(main, /desktop:native-core-stellar-quantum-projection"[\s\S]*?coreStellarQuantumProjection[\s\S]*?stellarQuantumProjection\(ownerId, request\)/);
  assert.match(main, /"star-map-overview-v1"[\s\S]*?nativeStarMapOverviewProjectionResultContext/);
  assert.match(main, /"stellar-industry-v1"[\s\S]*?nativeStellarIndustryProjectionResultContext/);
  assert.match(main, /"stellar-quantum-v1"[\s\S]*?nativeStellarQuantumProjectionResultContext/);
  assert.match(preload, /MAX_STELLAR_PROJECTION_REQUEST_BYTES = 32_768/);
  assert.match(preload, /getNativeCoreStarMapOverviewProjection:[\s\S]*?desktop:native-core-star-map-overview-projection/);
  assert.match(preload, /getNativeCoreStellarIndustryProjection:[\s\S]*?desktop:native-core-stellar-industry-projection/);
  assert.match(preload, /getNativeCoreStellarIndustryV2Projection:[\s\S]*?desktop:native-core-stellar-industry-v2-projection/);
  assert.match(preload, /getNativeCoreStellarQuantumProjection:[\s\S]*?desktop:native-core-stellar-quantum-projection/);
  assert.match(host, /MAX_STELLAR_PROJECTION_PAGE_ROWS = 64[\s\S]*?starMapOverviewProjection\(ownerId, request\)/);
  assert.match(host, /stellarIndustryProjection\(ownerId, request\)[\s\S]*?bounded IPC limit/);
  assert.match(host, /stellarIndustryProjectionV2\(ownerId, request\)[\s\S]*?coreStellarIndustryProjectionV2/);
  assert.match(host, /stellarQuantumProjection\(ownerId, request\)[\s\S]*?coreStellarQuantumProjection/);
  assert.match(desktop, /projectionType:\s*"star-map-overview-v1"/);
  assert.match(desktop, /projectionType:\s*"stellar-industry-v1"/);
  assert.match(desktop, /projectionType:\s*"stellar-industry-v2"/);
  assert.match(desktop, /projectionType:\s*"stellar-quantum-v1"/);
  assert.match(nativeCore, /starMapOverviewProjection\([\s\S]*?decodeNativeCoreProjectionTransfer/);
  assert.match(nativeCore, /stellarIndustryProjection\([\s\S]*?decodeNativeCoreProjectionTransfer/);
  assert.match(nativeCore, /stellarQuantumProjection\([\s\S]*?decodeNativeCoreProjectionTransfer/);
  assert.doesNotMatch(nativeCore, /starMapOverviewProjection\([\s\S]{0,2500}?getNativeCoreProjection\(/);
  assert.doesNotMatch(nativeCore, /stellarIndustryProjection\([\s\S]{0,2500}?getNativeCoreProjection\(/);
  assert.doesNotMatch(nativeCore, /stellarQuantumProjection\([\s\S]{0,2500}?getNativeCoreProjection\(/);
});
