"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const context = Object.freeze({
  sessionId: "core-dyson",
  expectedRevision: 17,
  expectedRegistryFingerprint: "builtin:test",
  selectedSystemId: "mod:星系/Ω🚀",
  systemCursor: 0,
  systemLimit: 8,
  layerCursor: 0,
  layerLimit: 8,
  orbitCursor: 0,
  orbitLimit: 8,
  nodeCursor: 0,
  nodeLimit: 8,
  frameCursor: 0,
  frameLimit: 8,
  shellCursor: 0,
  shellLimit: 8,
});

function engineering(overrides = {}) {
  return {
    launchMode: "balanced",
    launchThrottle: 0.5,
    launchEnabled: true,
    orbitCount: 1,
    orbitSails: 30,
    queuedSails: 12,
    queuedRockets: 6,
    sailLaunchesPerMinute: 10,
    rocketLaunchesPerMinute: 3,
    launchEnergyPerSailMj: 21.6,
    launchEnergyPerRocketMj: 108,
    launchEnergyPerMinuteMj: 540,
    rayGenerationKw: 5_000,
    receiverCapacityKw: 19_800,
    operationalReceiverCapacityKw: 19_800,
    receiverLoadKw: 5_000,
    theoreticalReceptionRate: 1,
    receiverUtilization: 0.2525,
    dysonPowerUtilization: 0.153,
    configuredReceiverCount: 2,
    blockedReceiverCount: 0,
    criticalPhotonPerMinute: 20,
    antimatterPerMinute: 4,
    feedbackGenerationKw: 25_000,
    plannedStructurePoints: 20,
    completedStructurePoints: 20,
    remainingStructurePoints: 0,
    shellCapacity: 10,
    shellSails: 5,
    projectedGenerationKw: 32_604,
    ...overrides,
  };
}

function systemRow(overrides = {}) {
  return {
    systemId: "mod:星系/Ω🚀",
    displayName: "模组星系 🚀",
    displayNameTruncated: false,
    starProfile: {
      available: false,
      starTypeName: "mod:星系/Ω🚀",
      starTypeNameTruncated: false,
      luminosity: 1,
      radiusMultiplier: 1,
    },
    unlocked: true,
    active: true,
    activeLayerId: "layer:主层/一",
    activeOrbitId: "orbit:轨道/一",
    structurePoints: 20,
    shellSails: 5,
    totals: {
      layerCount: 1,
      nodeCount: 2,
      frameCount: 1,
      shellCount: 1,
      plannedStructurePoints: 20,
      completedStructurePoints: 20,
      sailCapacity: 10,
      absorbedSails: 5,
    },
    orbitCount: 1,
    orbitSails: 30,
    projectedGenerationKw: 32_604,
    engineering: engineering(),
    ...overrides,
  };
}

function page(rows) {
  return { cursor: 0, limit: 8, totalCount: rows.length, nextCursor: null, rows };
}

function projection() {
  const selectedSystem = systemRow();
  return {
    schemaVersion: 1,
    projectionType: "dyson-workspace-v1",
    revision: 17,
    registryFingerprint: "builtin:test",
    stateVersion: 47,
    limits: {
      requestBytes: 32_768,
      projectionBytes: 1_048_576,
      pageRows: 64,
      totalRows: 65_536,
      idBytes: 1_024,
      labelBytes: 512,
    },
    request: {
      expectedRevision: 17,
      expectedRegistryFingerprint: "builtin:test",
      selectedSystemId: "mod:星系/Ω🚀",
      systemCursor: 0,
      systemLimit: 8,
      layerCursor: 0,
      layerLimit: 8,
      orbitCursor: 0,
      orbitLimit: 8,
      nodeCursor: 0,
      nodeLimit: 8,
      frameCursor: 0,
      frameLimit: 8,
      shellCursor: 0,
      shellLimit: 8,
    },
    activePlanetId: "mod:星球/家园",
    activeSystemId: "mod:星系/Ω🚀",
    selectedSystemId: "mod:星系/Ω🚀",
    technology: { programReady: true, shellReady: true, swarmReady: true },
    global: {
      sphere: {
        structurePoints: 20,
        totalRocketsLaunched: 25,
        shellSails: 5,
        totalSailsAbsorbed: 5,
        generationKw: 19_640,
      },
      swarm: {
        sailsInOrbit: 30,
        totalLaunched: 42,
        totalExpired: 7,
        generationKw: 2_904,
        receiverLoadKw: 5_000,
      },
      launch: { mode: "balanced", throttle: 0.5, enabled: true, energySpentMj: 4_321 },
    },
    summary: {
      systemCount: 1,
      unlockedSystemCount: 1,
      layerCount: 1,
      orbitCount: 1,
      nodeCount: 2,
      frameCount: 1,
      shellCount: 1,
    },
    selectedSystem,
    systems: page([selectedSystem]),
    layers: page([{
      layerId: "layer:主层/一",
      name: "主层 Ω",
      nameTruncated: false,
      radius: 10_000,
      inclination: 15,
      longitude: 45,
      structureAllocationFloor: 3,
      shellAllocationFloor: 2,
      nodeCount: 2,
      frameCount: 1,
      shellCount: 1,
      plannedStructurePoints: 20,
      completedStructurePoints: 20,
      sailCapacity: 10,
      absorbedSails: 5,
    }]),
    orbits: page([{
      orbitId: "orbit:轨道/一",
      name: "轨道一 🚀",
      nameTruncated: false,
      radius: 12_000,
      inclination: -5,
      longitude: 90,
      sailsInOrbit: 30,
      totalLaunched: 42,
      totalExpired: 7,
      decayProgress: 0.25,
      generationKw: 2_904,
    }]),
    nodes: page([
      { layerId: "layer:主层/一", nodeId: "node:a", angle: 0, requiredStructurePoints: 5, completedStructurePoints: 5 },
      { layerId: "layer:主层/一", nodeId: "node:b", angle: 180, requiredStructurePoints: 5, completedStructurePoints: 5 },
    ]),
    frames: page([{
      layerId: "layer:主层/一",
      frameId: "frame:a-b",
      sourceNodeId: "node:a",
      targetNodeId: "node:b",
      requiredStructurePoints: 10,
      completedStructurePoints: 10,
    }]),
    shells: page([{
      layerId: "layer:主层/一",
      shellId: "shell:a-b",
      sourceNodeId: "node:a",
      targetNodeId: "node:b",
      boundaryFrameCount: 1,
      active: true,
      sailCapacity: 10,
      absorbedSails: 5,
    }]),
  };
}

test("Dyson workspace boundary accepts one exact bounded UTF-8/MOD projection", () => {
  const normalized = normalizeRendererNativeResult("coreDysonWorkspaceProjection", projection(), context);
  assert.equal(normalized.selectedSystemId, "mod:星系/Ω🚀");
  assert.equal(normalized.selectedSystem.engineering.queuedRockets, 6);
  assert.equal(normalized.layers.rows[0].name, "主层 Ω");
  assert.equal(normalized.nodes.totalCount, 2);
  assert.deepEqual(normalized.request, projection().request);
});

test("Dyson workspace boundary rejects stale identity, page drift, unknown fields and malformed IDs", () => {
  const stale = projection();
  stale.revision = 18;
  assert.throws(
    () => normalizeRendererNativeResult("coreDysonWorkspaceProjection", stale, context),
    /identity binding is invalid/,
  );
  const pageDrift = projection();
  pageDrift.nodes.cursor = 1;
  assert.throws(
    () => normalizeRendererNativeResult("coreDysonWorkspaceProjection", pageDrift, context),
    /nodes binding is invalid/,
  );
  const extra = projection();
  extra.rawState = {};
  assert.throws(
    () => normalizeRendererNativeResult("coreDysonWorkspaceProjection", extra, context),
    /projection is invalid/,
  );
  for (const systemId of ["bad\nidentifier", "\ud800"]) {
    const malformed = projection();
    malformed.selectedSystemId = systemId;
    malformed.request.selectedSystemId = systemId;
    malformed.selectedSystem.systemId = systemId;
    malformed.systems.rows[0].systemId = systemId;
    assert.throws(
      () => normalizeRendererNativeResult(
        "coreDysonWorkspaceProjection",
        malformed,
        { ...context, selectedSystemId: systemId },
      ),
      /is invalid/,
    );
  }
});

test("Dyson workspace boundary rejects inconsistent flow, geometry and output budgets", () => {
  const material = projection();
  material.global.swarm.totalLaunched = 41;
  assert.throws(
    () => normalizeRendererNativeResult("coreDysonWorkspaceProjection", material, context),
    /global conservation is invalid/,
  );
  const geometry = projection();
  geometry.layers.rows[0].longitude = 360;
  assert.throws(
    () => normalizeRendererNativeResult("coreDysonWorkspaceProjection", geometry, context),
    /layers.rows\[0\] binding is invalid/,
  );
  const oversized = projection();
  oversized.selectedSystem.displayName = "界".repeat(400_000);
  oversized.systems.rows[0].displayName = oversized.selectedSystem.displayName;
  assert.throws(
    () => normalizeRendererNativeResult("coreDysonWorkspaceProjection", oversized, context),
    /byte budget is invalid/,
  );
});

test("desktop direct and transfer paths route Dyson reads without a renderer GameState fallback", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  const host = readFileSync("desktop/native-host.cjs", "utf8");
  const rustHost = readFileSync("native/dsp-native-host/src/main.rs", "utf8");
  assert.match(main, /desktop:native-core-dyson-workspace-projection/);
  assert.match(main, /nativePlayerAuthorityProjectionBroker\.read\(ownerId, "dyson-workspace-v1", request\)/);
  assert.match(main, /nativeCoreSessions\.dysonWorkspaceProjection\(ownerId, normalizedRequest\)/);
  assert.match(preload, /getNativeCoreDysonWorkspaceProjection/);
  assert.match(preload, /"dyson-workspace-v1"/);
  assert.match(host, /operation: "coreDysonWorkspaceProjection"/);
  assert.match(rustHost, /native-core-dyson-workspace-projection-v1/);
  assert.match(rustHost, /ControlRequest::CoreDysonWorkspaceProjection/);
  assert.doesNotMatch(host, /GameState/);
});
