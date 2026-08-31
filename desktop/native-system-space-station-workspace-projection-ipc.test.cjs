"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const context = Object.freeze({
  sessionId: "core-station",
  runId: "run-station-1",
  expectedRevision: 23,
  expectedRegistryFingerprint: "builtin:test",
  systemId: "mod:system/Ω🚀",
  requirementCursor: 0,
  requirementLimit: 8,
  inventoryCursor: 0,
  inventoryLimit: 8,
  trayCursor: 0,
  trayLimit: 8,
  stationCursor: 0,
  stationLimit: 8,
});

function page(rows) {
  return { cursor: 0, limit: 8, totalCount: rows.length, nextCursor: null, rows };
}

function outputTargets() {
  return Array.from({ length: 5 }, (_, portIndex) => ({
    portIndex,
    itemId: portIndex === 0 ? "mod:item/rocket" : null,
    itemName: portIndex === 0 ? "小型运载火箭" : "",
    itemNameTruncated: false,
  }));
}

function projection() {
  return {
    schemaVersion: 1,
    projectionType: "system-space-station-workspace-v1",
    source: "native-core",
    sessionId: context.sessionId,
    runId: context.runId,
    revision: context.expectedRevision,
    registryFingerprint: context.expectedRegistryFingerprint,
    stateVersion: 47,
    limits: {
      requestBytes: 32_768,
      projectionBytes: 1_048_576,
      pageRows: 64,
      totalRows: 65_536,
      idBytes: 512,
      labelBytes: 512,
      decimalDigits: 256,
    },
    request: { ...context },
    system: {
      systemId: context.systemId,
      displayName: "测试星系 Ω",
      displayNameTruncated: false,
      planetCount: 2,
      activePlanetId: "mod:planet/home",
      activePlanetInSystem: true,
      unlocked: true,
    },
    technology: {
      constructionReady: true,
      moduleAssemblyReady: true,
      autonomousConstructionReady: true,
      orbitalBusReady: true,
    },
    station: {
      persisted: true,
      status: "building",
      costRevision: 1,
      costMultiplierBasisPoints: 10_000,
      phaseIndex: 0,
      canStartConstruction: false,
      launcherPresent: true,
      modules: { backbone: 2, energy: 1, interstellar: 1 },
      progress: {
        basisPoints: 2_500,
        deliveredAmount: "25",
        requiredAmount: "100",
        constructionBufferAmount: "3",
      },
      inventoryAmount: "42",
    },
    hubNetwork: {
      fleetInstalled: 10,
      fleetBusy: 2,
      fleetReturnCount: 4,
      warpers: "100",
      warperTarget: "500",
    },
    summary: {
      requirementCount: 1,
      inventoryItemCount: 1,
      trayMaterialCount: 1,
      trayAvailableAmount: "12",
      interstellarStationCount: 1,
      mk1StationCount: 0,
      mk2StationCount: 1,
      elevatorStationCount: 1,
      transitioningStationCount: 0,
    },
    requirements: page([{
      requirementIndex: 0,
      phaseName: "基座阶段",
      itemId: "mod:item/titanium",
      itemName: "钛块",
      itemNameTruncated: false,
      baseAmount: 100,
      requiredAmount: "100",
      deliveredAmount: "25",
      constructionBufferAmount: "3",
      complete: false,
      current: true,
    }]),
    sharedInventory: page([{
      itemId: "mod:item/rocket",
      itemName: "小型运载火箭",
      itemNameTruncated: false,
      amount: "42",
      policy: { interstellarEnabled: true, reserve: "10", target: "100" },
    }]),
    trayMaterials: page([{
      planetId: "mod:planet/home",
      planetName: "家园",
      planetNameTruncated: false,
      activePlanet: true,
      itemId: "mod:item/titanium",
      itemName: "钛块",
      itemNameTruncated: false,
      amount: 12,
      constructionMaterial: true,
    }]),
    interstellarStations: page([{
      entityId: "mod:entity/station-1",
      planetId: "mod:planet/home",
      planetName: "家园",
      planetNameTruncated: false,
      machineCount: 1,
      stationTier: 2,
      operationMode: "elevator",
      modeTransition: null,
      effectiveTargetMode: "elevator",
      outputTargets: outputTargets(),
      outputConfigurationEnabled: true,
    }]),
  };
}

test("system-space-station boundary accepts one exact bounded four-page projection", () => {
  const result = normalizeRendererNativeResult(
    "coreSystemSpaceStationWorkspaceProjection",
    projection(),
    context,
  );
  assert.equal(result.system.displayName, "测试星系 Ω");
  assert.equal(result.station.modules.backbone, 2);
  assert.equal(result.requirements.rows[0].requiredAmount, "100");
  assert.equal(result.interstellarStations.rows[0].outputTargets.length, 5);
  assert.deepEqual(result.request, context);
});

test("system-space-station boundary rejects lineage drift, page drift and extra state", () => {
  const stale = projection();
  stale.runId = "run-station-2";
  assert.throws(
    () => normalizeRendererNativeResult("coreSystemSpaceStationWorkspaceProjection", stale, context),
    /identity binding is invalid/,
  );
  const pageDrift = projection();
  pageDrift.sharedInventory.cursor = 1;
  assert.throws(
    () => normalizeRendererNativeResult("coreSystemSpaceStationWorkspaceProjection", pageDrift, context),
    /shared inventory binding is invalid/,
  );
  const extra = projection();
  extra.gameState = {};
  assert.throws(
    () => normalizeRendererNativeResult("coreSystemSpaceStationWorkspaceProjection", extra, context),
    /projection is invalid/,
  );
});

test("system-space-station boundary rejects malformed counts, ports and byte budgets", () => {
  const summary = projection();
  summary.summary.mk1StationCount = 1;
  assert.throws(
    () => normalizeRendererNativeResult("coreSystemSpaceStationWorkspaceProjection", summary, context),
    /summary binding is invalid/,
  );
  const ports = projection();
  ports.interstellarStations.rows[0].outputTargets[1].portIndex = 4;
  assert.throws(
    () => normalizeRendererNativeResult("coreSystemSpaceStationWorkspaceProjection", ports, context),
    /portIndex is invalid/,
  );
  const oversized = projection();
  oversized.system.displayName = "界".repeat(400_000);
  assert.throws(
    () => normalizeRendererNativeResult("coreSystemSpaceStationWorkspaceProjection", oversized, context),
    /byte budget is invalid/,
  );
});

test("desktop direct and transfer routes never request a renderer GameState", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  const host = readFileSync("desktop/native-host.cjs", "utf8");
  const rustHost = readFileSync("native/dsp-native-host/src/main.rs", "utf8");
  assert.match(main, /desktop:native-core-system-space-station-workspace-projection/);
  assert.match(main, /"system-space-station-workspace-v1"/);
  assert.match(main, /nativeCoreSessions\.systemSpaceStationWorkspaceProjection/);
  assert.match(preload, /getNativeCoreSystemSpaceStationWorkspaceProjection/);
  assert.match(host, /operation: "coreSystemSpaceStationWorkspaceProjection"/);
  assert.match(rustHost, /native-core-system-space-station-workspace-projection-v1/);
  assert.match(rustHost, /ControlRequest::CoreSystemSpaceStationWorkspaceProjection/);
  assert.doesNotMatch(host, /systemSpaceStationWorkspaceProjection[\s\S]{0,2000}GameState/);
});
