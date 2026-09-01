import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLeaderboardMaterialSnapshot,
  evaluateLeaderboardIntegrity,
  LEADERBOARD_INTEGRITY_COMPATIBLE_GAME_STATE_VERSIONS,
  LEADERBOARD_INTEGRITY_VERSION,
} from "./leaderboard-integrity.mjs";

function materialState({ version = 47, rocketStock = 0, sailStock = 0, rocketProduced = 0, sailProduced = 0 } = {}) {
  return {
    version,
    elapsedSeconds: 100,
    activePlanetId: "home",
    tray: { small_carrier_rocket: rocketStock, solar_sail: sailStock },
    planetTrays: { home: { small_carrier_rocket: rocketStock, solar_sail: sailStock } },
    entities: [{ id: "factory", inputs: {}, outputs: {}, stationRoutes: [] }],
    construction: {},
    constructionQueue: [],
    constructionAutomation: { jobs: {}, destroyedByproducts: {} },
    portableFleet: {},
    cargo: null,
    quantumLogisticsNetwork: { inventory: {} },
    systemSpaceStations: {},
    totalProduced: { small_carrier_rocket: rocketProduced, solar_sail: sailProduced },
    endgame: {
      exportProjects: {
        carrier_rocket_fleet: { totalDelivered: 0 },
        solar_sail_array: { totalDelivered: 0 },
      },
      constructionActivity: {
        personalDelivered: { small_carrier_rocket: 0, solar_sail: 0 },
        pendingBatches: {},
      },
    },
    orbitalStation: { totals: { exportedByItem: {} } },
    dysonSphere: { totalRocketsLaunched: 0, structurePoints: 0, shellSails: 0, totalSailsAbsorbed: 0 },
    dysonSwarm: { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0 },
    dysonPlans: { helios: { structurePoints: 0, shellSails: 0 } },
    dysonEngineering: {
      orbitsBySystem: { helios: [{ id: "orbit", sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0 }] },
    },
  };
}

test("freezes only high-confidence cumulative or time rollback evidence", () => {
  const previous = { version: 46, elapsedSeconds: 100, entities: [{}], totalProduced: { iron_ingot: 1_000 } };
  assert.equal(evaluateLeaderboardIntegrity({ ...previous, elapsedSeconds: 99 }, previous).freeze, true);
  assert.equal(evaluateLeaderboardIntegrity({ ...previous, elapsedSeconds: 101, totalProduced: { iron_ingot: 999 } }, previous).freeze, true);
  assert.equal(evaluateLeaderboardIntegrity({ ...previous, elapsedSeconds: 101, totalProduced: { iron_ingot: 1_001 } }, previous).freeze, false);
});

test("does not apply v46 monotonic assumptions to legacy save versions", () => {
  const result = evaluateLeaderboardIntegrity(
    { version: 24, elapsedSeconds: 120, totalProduced: { universe_matrix: 900 }, entities: [] },
    { version: 24, elapsedSeconds: 100, totalProduced: { universe_matrix: 1_000 }, entities: [] },
  );
  assert.equal(result.freeze, false);
});

test("flags impossible current saves without applying a theoretical production cap", () => {
  const impossible = evaluateLeaderboardIntegrity({ version: 46, elapsedSeconds: 10_000, entities: [], totalProduced: { universe_matrix: 1_000_000_000_000 } });
  assert.equal(impossible.freeze, true);
  assert.ok(impossible.findings.some((finding) => finding.code === "EXTREME_PRODUCTION_WITHOUT_ENTITIES"));
  const terminal = evaluateLeaderboardIntegrity({ version: 46, elapsedSeconds: 10_000, entities: [{ id: "factory" }], totalProduced: { universe_matrix: Number.MAX_VALUE } });
  assert.equal(terminal.freeze, false);
});

test("explicitly supports v46 and v47 while leaving future versions opt-in", () => {
  assert.equal(LEADERBOARD_INTEGRITY_VERSION, "leaderboard-integrity-v3");
  assert.deepEqual(LEADERBOARD_INTEGRITY_COMPATIBLE_GAME_STATE_VERSIONS, [46, 47]);
  const unsupported = evaluateLeaderboardIntegrity({ version: 48, totalProduced: {}, entities: [{}] });
  assert.equal(unsupported.freeze, false);
  assert.equal(unsupported.verification, "unverifiable");
  assert.ok(unsupported.findings.some((finding) => finding.code === "STATE_VERSION_UNSUPPORTED"));
});

test("accepts adjacent v47 rocket launches funded by production plus old inventory", () => {
  const previous = materialState({ rocketStock: 100, rocketProduced: 1_000 });
  const current = structuredClone(previous);
  current.elapsedSeconds = 110;
  current.tray.small_carrier_rocket = 40;
  current.planetTrays.home.small_carrier_rocket = 40;
  current.totalProduced.small_carrier_rocket = 1_010;
  current.dysonSphere.totalRocketsLaunched = 70;
  current.dysonSphere.structurePoints = 70;
  current.dysonPlans.helios.structurePoints = 70;

  const result = evaluateLeaderboardIntegrity(current, previous);
  assert.equal(result.verification, "verified");
  assert.equal(result.freeze, false);
});

test("queues evidence when a v47 revision creates rocket and structure growth without a material source", () => {
  const previous = materialState({ rocketStock: 1, rocketProduced: 1_000 });
  const current = structuredClone(previous);
  current.elapsedSeconds = 110;
  current.tray.small_carrier_rocket = 0;
  current.planetTrays.home.small_carrier_rocket = 0;
  current.totalProduced.small_carrier_rocket = 1_010;
  current.dysonSphere.totalRocketsLaunched = 70;
  current.dysonSphere.structurePoints = 70;
  current.dysonPlans.helios.structurePoints = 70;

  const result = evaluateLeaderboardIntegrity(current, previous);
  assert.equal(result.freeze, true);
  assert.ok(result.findings.some((finding) => finding.code === "ROCKET_MATERIAL_SOURCE_EXCEEDED"));
});

test("checks solar-sail launch, orbit, expiry and shell absorption as one closed flow", () => {
  const previous = materialState({ sailStock: 20, sailProduced: 100 });
  const current = structuredClone(previous);
  current.elapsedSeconds = 110;
  current.tray.solar_sail = 10;
  current.planetTrays.home.solar_sail = 10;
  current.dysonSwarm.totalLaunched = 10;
  current.dysonSwarm.sailsInOrbit = 6;
  current.dysonSwarm.totalExpired = 1;
  current.dysonSphere.totalSailsAbsorbed = 3;
  current.dysonSphere.shellSails = 3;
  current.dysonPlans.helios.shellSails = 3;
  current.dysonEngineering.orbitsBySystem.helios[0].totalLaunched = 10;
  current.dysonEngineering.orbitsBySystem.helios[0].sailsInOrbit = 6;
  current.dysonEngineering.orbitsBySystem.helios[0].totalExpired = 1;
  assert.equal(evaluateLeaderboardIntegrity(current, previous).freeze, false);

  current.dysonSwarm.sailsInOrbit = 7;
  const invalid = evaluateLeaderboardIntegrity(current, previous);
  assert.equal(invalid.freeze, true);
  assert.ok(invalid.findings.some((finding) => finding.code === "SOLAR_SAIL_FLOW_MISMATCH"));
});

test("counts Galactic activity delivery once while treating personal and pending fields as mirrors", () => {
  for (const fixture of [
    { itemId: "small_carrier_rocket", projectId: "carrier_rocket_fleet", producedKey: "rocketProduced" },
    { itemId: "solar_sail", projectId: "solar_sail_array", producedKey: "sailProduced" },
  ]) {
    const previous = materialState({ [fixture.producedKey]: 100 });
    const current = structuredClone(previous);
    current.elapsedSeconds += 10;
    current.totalProduced[fixture.itemId] += 10;
    current.endgame.exportProjects[fixture.projectId].totalDelivered = 10;
    current.endgame.constructionActivity.personalDelivered[fixture.itemId] = 10;
    current.endgame.constructionActivity.pendingBatches[fixture.itemId] = {
      id: `activity:participant:${fixture.itemId}:0`,
      itemId: fixture.itemId,
      amount: 10,
      sequence: 0,
      firstDeliveredAtMs: 1_000,
      lastDeliveredAtMs: 10_000,
    };

    const snapshot = createLeaderboardMaterialSnapshot(current);
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.stock[fixture.itemId], "0");
    assert.equal(snapshot.knownConsumed[fixture.itemId], "10");
    const result = evaluateLeaderboardIntegrity(current, previous);
    assert.equal(result.verification, "verified");
    assert.equal(result.freeze, false);
    const projection = {
      version: current.version,
      elapsedSeconds: current.elapsedSeconds,
      totalProduced: current.totalProduced,
      entities: [true],
      leaderboardMaterialSnapshot: snapshot,
    };
    const projected = evaluateLeaderboardIntegrity(projection, previous, { trustCurrentMaterialSnapshot: true });
    assert.equal(projected.verification, "verified");
    assert.equal(projected.freeze, false);
  }
});

test("still freezes an unfunded Galactic activity project delivery", () => {
  const previous = materialState();
  const current = structuredClone(previous);
  current.elapsedSeconds += 10;
  current.endgame.exportProjects.carrier_rocket_fleet.totalDelivered = 10;
  current.endgame.constructionActivity.personalDelivered.small_carrier_rocket = 10;
  current.endgame.constructionActivity.pendingBatches.small_carrier_rocket = {
    id: "activity:participant:small_carrier_rocket:0",
    itemId: "small_carrier_rocket",
    amount: 10,
    sequence: 0,
    firstDeliveredAtMs: 1_000,
    lastDeliveredAtMs: 10_000,
  };

  const result = evaluateLeaderboardIntegrity(current, previous);
  assert.equal(result.freeze, true);
  assert.ok(result.findings.some((finding) => finding.code === "ROCKET_MATERIAL_SOURCE_EXCEEDED"));
});

test("does not reinterpret activity batch acknowledgement as an inventory movement", () => {
  const previous = materialState({ rocketProduced: 10 });
  previous.endgame.exportProjects.carrier_rocket_fleet.totalDelivered = 10;
  previous.endgame.constructionActivity.personalDelivered.small_carrier_rocket = 10;
  previous.endgame.constructionActivity.pendingBatches.small_carrier_rocket = {
    id: "activity:participant:small_carrier_rocket:0",
    itemId: "small_carrier_rocket",
    amount: 10,
    sequence: 0,
    firstDeliveredAtMs: 1_000,
    lastDeliveredAtMs: 10_000,
  };
  const current = structuredClone(previous);
  current.elapsedSeconds += 1;
  current.endgame.constructionActivity.pendingBatches = {};

  const result = evaluateLeaderboardIntegrity(current, previous);
  assert.equal(result.verification, "verified");
  assert.equal(result.freeze, false);
});

test("keeps activity mirrors out of the material verdict and counts non-activity exports", () => {
  const mirrorPrevious = materialState();
  const mirrorCurrent = structuredClone(mirrorPrevious);
  mirrorCurrent.elapsedSeconds += 1;
  mirrorCurrent.endgame.constructionActivity.personalDelivered.small_carrier_rocket = 50;
  mirrorCurrent.endgame.constructionActivity.pendingBatches.small_carrier_rocket = {
    id: "activity:participant:small_carrier_rocket:0",
    itemId: "small_carrier_rocket",
    amount: 50,
    sequence: 0,
    firstDeliveredAtMs: 1_000,
    lastDeliveredAtMs: 1_000,
  };
  assert.equal(evaluateLeaderboardIntegrity(mirrorCurrent, mirrorPrevious).freeze, false);

  const exportPrevious = materialState({ rocketProduced: 100 });
  const exportCurrent = structuredClone(exportPrevious);
  exportCurrent.elapsedSeconds += 1;
  exportCurrent.totalProduced.small_carrier_rocket = 110;
  exportCurrent.endgame.exportProjects.carrier_rocket_fleet.totalDelivered = 10;
  assert.equal(evaluateLeaderboardIntegrity(exportCurrent, exportPrevious).freeze, false);
});

test("does not let Dyson launch and Galactic export spend the same produced material twice", () => {
  const previous = materialState({ rocketProduced: 100 });
  const current = structuredClone(previous);
  current.elapsedSeconds += 10;
  current.totalProduced.small_carrier_rocket = 115;
  current.endgame.exportProjects.carrier_rocket_fleet.totalDelivered = 10;
  current.dysonSphere.totalRocketsLaunched = 10;
  current.dysonSphere.structurePoints = 10;
  current.dysonPlans.helios.structurePoints = 10;

  const result = evaluateLeaderboardIntegrity(current, previous);
  assert.equal(result.freeze, true);
  assert.ok(result.findings.some((finding) => finding.code === "ROCKET_MATERIAL_SOURCE_EXCEEDED"));
});

test("uses the compact upload projection without copying full entities", () => {
  const previous = materialState({ rocketStock: 5 });
  const current = structuredClone(previous);
  current.elapsedSeconds += 1;
  const projection = {
    version: 47,
    elapsedSeconds: current.elapsedSeconds,
    totalProduced: current.totalProduced,
    entities: [true],
    leaderboardMaterialSnapshot: createLeaderboardMaterialSnapshot(current),
  };
  const result = evaluateLeaderboardIntegrity(projection, previous, { trustCurrentMaterialSnapshot: true });
  assert.equal(result.verification, "verified");
  assert.equal(result.freeze, false);
});

test("never trusts a material snapshot embedded by a player save", () => {
  const previous = materialState({ rocketStock: 1, rocketProduced: 10 });
  const current = structuredClone(previous);
  current.elapsedSeconds += 1;
  current.tray.small_carrier_rocket = 0;
  current.planetTrays.home.small_carrier_rocket = 0;
  current.dysonSphere.totalRocketsLaunched = 100;
  current.dysonSphere.structurePoints = 100;
  current.dysonPlans.helios.structurePoints = 100;
  current.leaderboardMaterialSnapshot = createLeaderboardMaterialSnapshot(previous);

  const result = evaluateLeaderboardIntegrity(current, previous);
  assert.equal(result.freeze, true);
  assert.ok(result.findings.some((finding) => finding.code === "ROCKET_MATERIAL_SOURCE_EXCEEDED"));
});

test("marks first revisions and incomplete legacy ledgers unverifiable without freezing", () => {
  const first = evaluateLeaderboardIntegrity(materialState(), null);
  assert.equal(first.freeze, false);
  assert.equal(first.verification, "unverifiable");
  assert.ok(first.findings.some((finding) => finding.code === "ADJACENT_REVISION_UNAVAILABLE"));

  const incomplete = evaluateLeaderboardIntegrity(
    { version: 47, elapsedSeconds: 2, totalProduced: {}, entities: [{}] },
    { version: 46, elapsedSeconds: 1, totalProduced: {}, entities: [{}] },
  );
  assert.equal(incomplete.freeze, false);
  assert.equal(incomplete.verification, "unverifiable");
  assert.ok(incomplete.findings.some((finding) => finding.code === "MATERIAL_LEDGER_UNAVAILABLE"));
});
