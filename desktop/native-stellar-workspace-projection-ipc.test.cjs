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

test("stellar workspace projections use trusted direct IPC and checksummed bounded transfer only", () => {
  const main = readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const preload = readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const host = readFileSync(path.join(root, "desktop", "native-host.cjs"), "utf8");
  const desktop = readFileSync(path.join(root, "src", "desktop.ts"), "utf8");
  const nativeCore = readFileSync(path.join(root, "src", "game", "nativeCore.ts"), "utf8");

  assert.match(main, /desktop:native-core-star-map-overview-projection"[\s\S]*?coreStarMapOverviewProjection[\s\S]*?starMapOverviewProjection\(ownerId, request\)/);
  assert.match(main, /desktop:native-core-stellar-industry-projection"[\s\S]*?coreStellarIndustryProjection[\s\S]*?stellarIndustryProjection\(ownerId, request\)/);
  assert.match(main, /"star-map-overview-v1"[\s\S]*?nativeStarMapOverviewProjectionResultContext/);
  assert.match(main, /"stellar-industry-v1"[\s\S]*?nativeStellarIndustryProjectionResultContext/);
  assert.match(preload, /MAX_STELLAR_PROJECTION_REQUEST_BYTES = 32_768/);
  assert.match(preload, /getNativeCoreStarMapOverviewProjection:[\s\S]*?desktop:native-core-star-map-overview-projection/);
  assert.match(preload, /getNativeCoreStellarIndustryProjection:[\s\S]*?desktop:native-core-stellar-industry-projection/);
  assert.match(host, /MAX_STELLAR_PROJECTION_PAGE_ROWS = 64[\s\S]*?starMapOverviewProjection\(ownerId, request\)/);
  assert.match(host, /stellarIndustryProjection\(ownerId, request\)[\s\S]*?bounded IPC limit/);
  assert.match(desktop, /projectionType:\s*"star-map-overview-v1"/);
  assert.match(desktop, /projectionType:\s*"stellar-industry-v1"/);
  assert.match(nativeCore, /starMapOverviewProjection\([\s\S]*?decodeNativeCoreProjectionTransfer/);
  assert.match(nativeCore, /stellarIndustryProjection\([\s\S]*?decodeNativeCoreProjectionTransfer/);
  assert.doesNotMatch(nativeCore, /starMapOverviewProjection\([\s\S]{0,2500}?getNativeCoreProjection\(/);
  assert.doesNotMatch(nativeCore, /stellarIndustryProjection\([\s\S]{0,2500}?getNativeCoreProjection\(/);
});
