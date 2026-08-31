"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const context = {
  sessionId: "core-main-1", runId: "run-1", expectedRevision: 17,
  expectedRegistryFingerprint: "7df8cf3a",
};
function projection() {
  return {
    schemaVersion: 1, projectionType: "operations-workspace-v1", source: "native-core",
    sessionId: "core-main-1", runId: "run-1", revision: 17,
    registryFingerprint: "7df8cf3a", stateVersion: 47, truncated: false,
    settings: {
      simulationSpeed: 1, technologyLayout: "standard", defaultBeltRouteMode: "auto",
      productionBufferLimit: 1000, logisticsBufferLimit: 1000,
      beltBufferLimit: 1000, proliferatorBufferLimit: 1,
    },
    summary: {
      paused: false, elapsedSeconds: 10, entityCount: 1, beltCount: 0,
      activePlanetId: "home", activePlanetEntityCount: 1,
      activePlanetBeltCount: 0, constructionQueueCount: 0,
    },
    alerts: {
      status: "complete", totalCount: 1, criticalCount: 1, warningCount: 0,
      rows: [{
        entityId: "entity-1", planetId: "home", buildingId: "arc_smelter",
        recipeId: "iron_ingot", resourceId: null, severity: "critical",
        code: "no-power", label: "无供电",
      }],
    },
    limits: { alertRows: 1024, projectionBytes: 524288 },
  };
}

test("operations boundary accepts a complete same-lineage atom", () => {
  const value = normalizeRendererNativeResult("coreOperationsWorkspaceProjection", projection(), context);
  assert.equal(value.revision, 17);
  assert.equal(value.alerts.rows.length, 1);
});

test("operations boundary rejects extra keys, truncation, drift and partial overflow truth", () => {
  const cases = [];
  cases.push({ ...projection(), extra: true });
  cases.push({ ...projection(), truncated: true });
  cases.push({ ...projection(), runId: "run-2" });
  cases.push({ ...projection(), alerts: { ...projection().alerts, totalCount: 2 } });
  cases.push({
    ...projection(),
    alerts: { ...projection().alerts, status: "overflow", totalCount: 1025, criticalCount: 1025, rows: projection().alerts.rows },
  });
  cases.push({
    ...projection(),
    alerts: { status: "overflow", totalCount: 1, criticalCount: 1, warningCount: 0, rows: [] },
  });
  for (const value of cases) {
    assert.throws(() => normalizeRendererNativeResult("coreOperationsWorkspaceProjection", value, context),
      (error) => error.code === "NATIVE_PROTOCOL_INVALID");
  }
});

test("operations overflow is accepted only with empty rows and a proven count beyond the cap", () => {
  const value = projection();
  value.summary.entityCount = 2000;
  value.summary.activePlanetEntityCount = 1;
  value.alerts = { status: "overflow", totalCount: 1025, criticalCount: 1025, warningCount: 0, rows: [] };
  const normalized = normalizeRendererNativeResult("coreOperationsWorkspaceProjection", value, context);
  assert.equal(normalized.alerts.status, "overflow");
  assert.deepEqual(normalized.alerts.rows, []);
});
