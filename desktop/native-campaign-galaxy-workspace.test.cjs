"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const context = Object.freeze({
  sessionId: "core-main-1",
  runId: "run-main-2",
  expectedRevision: 41,
  expectedRegistryFingerprint: "builtin:test",
});

function campaignProjection() {
  return {
    schemaVersion: 1,
    projectionType: "campaign-workspace-v1",
    source: "native-core",
    stateVersion: 47,
    sessionId: context.sessionId,
    runId: context.runId,
    revision: context.expectedRevision,
    registryFingerprint: context.expectedRegistryFingerprint,
    truncated: false,
    limits: { chapters: 16, tasks: 64, payloadBytes: 262144 },
    counts: { chapters: 1, tasks: 2, completedTasks: 1 },
    activeChapterId: "foundation",
    activeTaskId: "smelt_iron",
    chapters: [{
      id: "foundation",
      completedCount: 1,
      totalCount: 2,
      complete: false,
      tasks: [{
        id: "mine_first_ore",
        track: "main",
        status: "complete",
        progress: { current: 1, target: 1 },
        locator: { kind: "item", targetId: "iron_ore" },
      }, {
        id: "smelt_iron",
        track: "main",
        status: "active",
        progress: { current: 2, target: 4 },
        locator: { kind: "item", targetId: "iron_ingot" },
      }],
    }],
  };
}

function galaxyProjection() {
  return {
    schemaVersion: 1,
    projectionType: "galaxy-account-workspace-v1",
    source: "native-core",
    stateVersion: 47,
    sessionId: context.sessionId,
    runId: context.runId,
    revision: context.expectedRevision,
    registryFingerprint: context.expectedRegistryFingerprint,
    truncated: false,
    limits: { payloadBytes: 65536, decimalDigits: 256 },
    game: { mode: "normal", elapsedSeconds: "3600", difficulty: "standard" },
    production: {
      totalProduced: "999999999999999999999999",
      universeMatrixProduced: "10",
      generationKw: "300",
      throughputPerMinute: "400",
    },
    progress: {
      campaignCompleted: 5,
      campaignTotal: 32,
      researchCompleted: 7,
      exploredSystems: 2,
      colonizedPlanets: 3,
      galacticScore: "800",
    },
    dyson: { powerKw: "900", structurePoints: "10", rocketsLaunched: "10", sailsLaunched: "20" },
    cloudCompatibility: {
      gameStateVersion: 47,
      envelopeVersion: 2,
      cloudSchemaVersion: 8,
      exportSupported: true,
      restoreIntoActiveAuthority: false,
      importIntoActiveAuthority: false,
      overwriteActiveAuthority: false,
    },
  };
}

test("campaign and Galaxy projections accept only exact bounded lineage atoms", () => {
  const campaign = normalizeRendererNativeResult("coreCampaignWorkspaceProjection", campaignProjection(), context);
  const galaxy = normalizeRendererNativeResult("coreGalaxyAccountWorkspaceProjection", galaxyProjection(), context);
  assert.equal(campaign.chapters[0].tasks[1].progress.current, 2);
  assert.equal(galaxy.production.totalProduced, "999999999999999999999999");
  for (const value of [campaign, galaxy]) {
    const encoded = JSON.stringify(value);
    for (const forbidden of ["entities", "belts", "inventory", "inputs", "outputs", "tray"]) {
      assert.equal(encoded.includes(forbidden), false, `leaked ${forbidden}`);
    }
  }
});

test("stale run same-revision ABA, registry drift and truncation fail closed", () => {
  for (const base of [campaignProjection(), galaxyProjection()]) {
    const kind = base.projectionType === "campaign-workspace-v1"
      ? "coreCampaignWorkspaceProjection"
      : "coreGalaxyAccountWorkspaceProjection";
    assert.throws(() => normalizeRendererNativeResult(kind, { ...base, runId: "old-run" }, context), /identity binding is invalid/);
    assert.throws(() => normalizeRendererNativeResult(kind, { ...base, revision: 40 }, context), /identity binding is invalid/);
    assert.throws(() => normalizeRendererNativeResult(kind, { ...base, registryFingerprint: "old:catalog" }, context), /identity binding is invalid/);
    assert.throws(() => normalizeRendererNativeResult(kind, { ...base, truncated: true }, context), /complete atom/);
    assert.throws(() => normalizeRendererNativeResult(kind, { ...base, gameState: {} }, context), /projection is invalid/);
  }
});

test("counts decimals and active-authority persistence compatibility are closed", () => {
  const duplicate = campaignProjection();
  duplicate.chapters[0].tasks[1].id = "mine_first_ore";
  assert.throws(() => normalizeRendererNativeResult("coreCampaignWorkspaceProjection", duplicate, context), /invalid/);
  const countDrift = campaignProjection();
  countDrift.counts.tasks = 3;
  assert.throws(() => normalizeRendererNativeResult("coreCampaignWorkspaceProjection", countDrift, context), /counts binding/);
  const oversized = galaxyProjection();
  oversized.production.totalProduced = "9".repeat(257);
  assert.throws(() => normalizeRendererNativeResult("coreGalaxyAccountWorkspaceProjection", oversized, context), /invalid/);
  const unsafe = galaxyProjection();
  unsafe.progress.exploredSystems = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => normalizeRendererNativeResult("coreGalaxyAccountWorkspaceProjection", unsafe, context), /invalid/);
  const difficulty = galaxyProjection();
  difficulty.game.difficulty = "d".repeat(65);
  assert.throws(() => normalizeRendererNativeResult("coreGalaxyAccountWorkspaceProjection", difficulty, context), /invalid/);
  const restore = galaxyProjection();
  restore.cloudCompatibility.restoreIntoActiveAuthority = true;
  assert.throws(() => normalizeRendererNativeResult("coreGalaxyAccountWorkspaceProjection", restore, context), /compatibility binding/);
});

test("Host preload App and native pages expose projections without a renderer GameState", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  const preload = readFileSync("desktop/preload.cjs", "utf8");
  const host = readFileSync("desktop/native-host.cjs", "utf8");
  const broker = readFileSync("desktop/native-player-authority-projection-broker.cjs", "utf8");
  const app = readFileSync("src/App.tsx", "utf8");
  const campaign = readFileSync("src/components/NativeCampaignWorkspace.tsx", "utf8");
  const galaxy = readFileSync("src/components/NativeGalaxyWorkspace.tsx", "utf8");
  for (const route of ["campaign-workspace", "galaxy-account-workspace"]) {
    assert.match(main, new RegExp(`desktop:native-core-${route}-projection`));
  }
  assert.match(preload, /getNativeCoreCampaignWorkspaceProjection/);
  assert.match(preload, /getNativeCoreGalaxyAccountWorkspaceProjection/);
  assert.match(host, /coreCampaignWorkspaceProjection/);
  assert.match(host, /coreGalaxyAccountWorkspaceProjection/);
  assert.match(broker, /EXACT_LINEAGE_WORKSPACE_PROJECTIONS/);
  assert.match(app, /<NativeCampaignWorkspace/);
  assert.match(app, /<NativeGalaxyWorkspace/);
  assert.doesNotMatch(campaign, /GameState|\bgame\s*:/);
  assert.doesNotMatch(galaxy, /GameState|exportGame|downloadCloudSave|restoreCloudSaveRevision|inspectSave/);
});
