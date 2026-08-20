import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

import { createCloudServer, inspectDecodedCloudSaveUpload } from "./index.mjs";
import { computeSaveStateChecksum } from "./save-integrity.mjs";
import {
  buildPublicStationSnapshot,
  stationProjectionFromState,
  validateOrbitalStationGameState,
} from "./station-profile.mjs";

const ADMIN_TOKEN = "station-admin-secret-1234567890-abcdef";
const PASSWORD = "station-pass-123";

function createOrbitalStation() {
  return {
    stateVersion: 1,
    status: "operational",
    construction: {
      costRevision: 1,
      stageRequirements: [
        {
          stageId: "core",
          costs: [
            { itemId: "titanium_alloy", amount: "200000" }, { itemId: "frame_material", amount: "100000" },
            { itemId: "processor", amount: "200000" }, { itemId: "universe_matrix", amount: "20000" },
          ],
          fleetCosts: {},
          delivered: { titanium_alloy: "200000", frame_material: "100000", processor: "200000", universe_matrix: "20000" },
          deliveredFleet: {},
        },
        {
          stageId: "dock",
          costs: [
            { itemId: "quantum_chip", amount: "100000" }, { itemId: "particle_container", amount: "200000" },
            { itemId: "space_warper", amount: "20000" },
          ],
          fleetCosts: { logistics_vessel: 200 },
          delivered: { quantum_chip: "100000", particle_container: "200000", space_warper: "20000" },
          deliveredFleet: { logistics_vessel: 200 },
        },
        {
          stageId: "showcase",
          costs: [
            { itemId: "titanium_glass", amount: "300000" }, { itemId: "particle_broadband", amount: "200000" },
            { itemId: "plastic", amount: "500000" }, { itemId: "universe_matrix", amount: "50000" },
          ],
          fleetCosts: {},
          delivered: { titanium_glass: "300000", particle_broadband: "200000", plastic: "500000", universe_matrix: "50000" },
          deliveredFleet: {},
        },
      ],
    },
    viewport: { x: 0, y: 0, zoom: 0.72 },
    contractBoard: {
      rulesVersion: 1,
      taskDay: 0,
      lastConfirmedWallClockMs: 0,
      offers: [],
      accepted: [],
      history: [],
      settledIds: [],
      featuredContractId: null,
    },
    economy: { orbitalMarks: "150", stationReputation: "0", unlockedDecorationIds: ["cargo_crate"] },
    layout: {
      themeId: "orbital_teal",
      placements: [{ id: "decor_test", decorationId: "cargo_crate", x: -460, y: -280, rotation: 0, layer: 1, variant: 0 }],
      featuredAchievementIds: ["first_manual_mine"],
    },
    profile: {
      title: "轨道白糖港",
      motto: "把生产线延伸到群星。",
      featuredMetricKeys: ["total-generation", "universe-matrix-produced"],
    },
    totals: { completedContracts: 12, exportedByItem: { processor: "24000" } },
  };
}

function createV47State() {
  return {
    version: 47,
    mode: "normal",
    elapsedSeconds: 86_400,
    entities: [
      { id: "storage", kind: "storage", buildingId: "storage_mk1" },
      {
        id: "terminal",
        kind: "storage",
        buildingId: "orbital_cargo_terminal",
        planetId: "home",
        machineCount: 1,
        orbitalCargoPortItems: [null, null, null, "processor"],
        orbitalCargoBinding: null,
        orbitalCargoProgress: 0,
        orbitalCargoTotalUploaded: "0",
      },
    ],
    belts: [{ id: "belt", source: "storage", target: "terminal", itemId: "processor", targetPortIndex: 3 }],
    settings: {
      productionBufferLimit: 1_000_000,
      logisticsBufferLimit: 1_000_000,
      beltBufferLimit: 100_000_000,
      proliferatorBufferLimit: 600,
    },
    contentPacks: [],
    galaxy: { planetMetadata: {}, systemMetadata: {} },
    quantumLogisticsNetwork: { enabled: false, inventory: {}, routingCursors: {}, itemCapacities: {}, uploadRoutingCursors: {} },
    constructionAutomation: { destroyedByproducts: {} },
    blueprints: [],
    blueprintVersions: [],
    constructionQueue: [],
    dysonPlans: {},
    timeWarp: {
      controllerEntityId: null,
      enabled: false,
      requestedMultiplier: 5,
      effectiveMultiplier: 1,
      pendingSimulationSeconds: 0,
      pendingWallSeconds: 0,
      requiredPowerKw: 0,
      allocatedPowerKw: 0,
    },
    endgame: {
      infiniteResearch: Object.fromEntries([
        "matrix_compression", "vein_utilization", "galactic_logistics", "stellar_harnessing", "continuum_simulation",
      ].map((id) => [id, { level: 0, progress: "0" }])),
    },
    orbitalStation: createOrbitalStation(),
    totalProduced: { universe_matrix: 100, processor: 24_000 },
    metrics: { generationKw: 5_000, totalItemsPerMinute: 1_000, rayGenerationKw: 0 },
    planetMetrics: { home: { totalItemsPerMinute: 1_000 } },
    activePlanetId: "home",
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
    dysonSwarm: { generationKw: 0, totalLaunched: 20 },
    dysonSphere: { generationKw: 0, totalRocketsLaunched: 5 },
    achievements: { unlockedIds: ["first_manual_mine"] },
  };
}

function createPayload(state, savedAt = 123_456) {
  const envelope = { formatVersion: 2, savedAt, mode: state.mode, state };
  return JSON.stringify({ ...envelope, checksum: computeSaveStateChecksum(envelope.formatVersion, state) });
}

async function startServer(databaseFile) {
  const server = await createCloudServer({
    databaseFile,
    adminToken: ADMIN_TOKEN,
    registrationLimit: 100,
    historyPruneIntervalMs: 0,
    backupIntervalMs: 0,
    mailer: null,
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(server) {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function register(baseUrl, username, displayName) {
  const result = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, displayName, password: PASSWORD }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return { id: result.body.user.id, headers: { authorization: `Bearer ${result.body.token}` } };
}

test("v47 station validation and public projection enforce four ports and a strict allowlist", () => {
  const state = createV47State();
  assert.equal(validateOrbitalStationGameState(state), true);
  const payload = createPayload(state);
  const inspection = inspectDecodedCloudSaveUpload(Buffer.from(JSON.stringify({ payload, expectedRevision: 0 })), {
    direct: false,
    payloadLimit: 5_000_000,
  });
  assert.equal(inspection.validPayload, true);
  assert.equal(inspection.stationProjection.status, "operational");

  const snapshot = buildPublicStationSnapshot({
    user: { id: "account_secret", displayName: "公开工程师" },
    projection: stationProjectionFromState(state),
    sourceRevision: 7,
    publishedAt: 1_000,
    leaderboardMetrics: { energyGeneratedMj: 123, peakThroughputPerMinute: 456 },
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "aggregateMetrics", "metricStatus", "metrics", "owner", "profile", "publicId", "publishedAt", "schema", "station",
  ]);
  const encoded = JSON.stringify(snapshot);
  for (const secret of ["account_secret", "inventory", "exportedByItem", "entities", "totalProduced", "cloudSave"]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  assert.equal(snapshot.station.placements.length, 1);
  const contentPackState = structuredClone(state);
  contentPackState.contentPacks = [{ id: "sample_pack", version: "1.0.0" }];
  contentPackState.orbitalStation.layout.placements.push({
    id: "pack_decor_1", decorationId: "pack_banner", x: -500, y: -300, rotation: 0, layer: 1, variant: 0,
  });
  assert.equal(validateOrbitalStationGameState(contentPackState), true);
  const contentPackSnapshot = buildPublicStationSnapshot({
    user: { id: "content_pack_account", displayName: "内容包工程师" },
    projection: stationProjectionFromState(contentPackState),
    sourceRevision: 1,
  });
  assert.equal(contentPackSnapshot.metricStatus, "content-pack-unverified");
  assert.deepEqual(contentPackSnapshot.station.placements.map((placement) => placement.decorationId), ["cargo_crate"]);

  const badPorts = structuredClone(state);
  badPorts.entities[1].orbitalCargoPortItems.pop();
  assert.equal(validateOrbitalStationGameState(badPorts), false);
  const forgedCost = structuredClone(state);
  forgedCost.orbitalStation.construction.stageRequirements[0].costs[0].amount = "1";
  assert.equal(validateOrbitalStationGameState(forgedCost), false);
  const unfinishedOperational = structuredClone(state);
  unfinishedOperational.orbitalStation.construction.stageRequirements[2].delivered = {};
  assert.equal(validateOrbitalStationGameState(unfinishedOperational), false);
  const duplicateTerminal = structuredClone(state);
  duplicateTerminal.entities.push({ ...structuredClone(state.entities[1]), id: "terminal_2" });
  assert.equal(validateOrbitalStationGameState(duplicateTerminal), false);
  const maliciousProfile = structuredClone(state);
  maliciousProfile.orbitalStation.profile.title = "<script>bad</script>";
  assert.equal(validateOrbitalStationGameState(maliciousProfile), false);
  const invalidPlacement = structuredClone(state);
  invalidPlacement.orbitalStation.layout.placements[0].x = 5_000;
  assert.equal(validateOrbitalStationGameState(invalidPlacement), false);
  const multiOriginTemplate = structuredClone(state);
  multiOriginTemplate.orbitalStation.contractBoard.offers = [{
    id: "station-contract-v1-1-1-0-multi-origin",
    templateId: "multi-origin",
    slot: 0,
    title: "多行星协同出口",
    summary: "由两颗指定行星完成配额。",
    taskDay: 0,
    expiresAtTaskDay: 3,
    special: false,
    difficulty: "P2",
    status: "offered",
    requirements: [{ itemId: "processor", amount: "100", delivered: "0", channel: "terminal", weight: 3, sourcePlanetIds: ["home"] }],
    rewards: { baseMarks: "1", baseReputation: "1", completionMarks: "1", completionReputation: "1" },
  }];
  assert.equal(validateOrbitalStationGameState(multiOriginTemplate), true);
  const legacySettledReoffer = structuredClone(multiOriginTemplate);
  const reoffer = legacySettledReoffer.orbitalStation.contractBoard.offers[0];
  const settled = structuredClone(reoffer);
  settled.status = "settled";
  settled.requirements.forEach((requirement) => { requirement.delivered = requirement.amount; });
  settled.settlementId = `station-settlement:${settled.id}:completed`;
  settled.settlementReason = "completed";
  settled.settledAtTaskDay = settled.taskDay;
  settled.completionBasisPoints = 10_000;
  legacySettledReoffer.orbitalStation.contractBoard.history = [settled];
  legacySettledReoffer.orbitalStation.contractBoard.settledIds = [settled.id];
  assert.equal(validateOrbitalStationGameState(legacySettledReoffer), true);
  const legacyPayload = createPayload(legacySettledReoffer);
  const legacyInspection = inspectDecodedCloudSaveUpload(Buffer.from(legacyPayload), {
    direct: true,
    expectedRevision: 0,
    requestId: null,
    declaredOriginalBytes: Buffer.byteLength(legacyPayload),
    payloadLimit: 5_000_000,
  });
  assert.equal(legacyInspection.validPayload, true);

  const missingSettlementFence = structuredClone(legacySettledReoffer);
  missingSettlementFence.orbitalStation.contractBoard.settledIds = [];
  assert.equal(validateOrbitalStationGameState(missingSettlementFence), false);
  const forgedSettledReoffer = structuredClone(legacySettledReoffer);
  forgedSettledReoffer.orbitalStation.contractBoard.offers[0].rewards.baseMarks = "2";
  assert.equal(validateOrbitalStationGameState(forgedSettledReoffer), false);
  const acceptedHistoryCollision = structuredClone(legacySettledReoffer);
  acceptedHistoryCollision.orbitalStation.contractBoard.offers = [];
  acceptedHistoryCollision.orbitalStation.contractBoard.accepted = [{
    ...structuredClone(reoffer),
    status: "accepted",
    acceptedAtTaskDay: reoffer.taskDay,
  }];
  assert.equal(validateOrbitalStationGameState(acceptedHistoryCollision), false);
  const forgedAchievement = structuredClone(state);
  forgedAchievement.orbitalStation.layout.featuredAchievementIds = ["six_matrix_mastery"];
  assert.equal(validateOrbitalStationGameState(forgedAchievement), false);
});

test("public station lifecycle keeps privacy separate from rankings and persists social state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-station-profile-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  let running;
  try {
    running = await startServer(databaseFile);
    const owner = await register(running.baseUrl, "station_owner", "空间站主人");
    const visitor = await register(running.baseUrl, "station_visitor", "空间站访客");
    const payload = createPayload(createV47State());
    const uploaded = await request(running.baseUrl, "/api/cloud-save", {
      method: "PUT",
      headers: owner.headers,
      body: JSON.stringify({ payload, expectedRevision: 0 }),
    });
    assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.body));

    const mine = await request(running.baseUrl, "/api/station/me", { headers: owner.headers });
    assert.equal(mine.response.status, 200);
    assert.equal(mine.body.published, true);
    assert.equal(mine.body.visibility, "public");
    assert.equal(mine.body.sourceRevision, 1);
    const publicId = mine.body.publicId;
    assert.match(publicId, /^station_[a-f0-9]{32}$/);

    const publicPage = await request(running.baseUrl, `/api/stations/${publicId}`);
    assert.equal(publicPage.response.status, 200);
    assert.equal(publicPage.body.snapshot.publicId, publicId);
    assert.equal(publicPage.body.social.favoriteCount, 0);
    const publicBodyText = JSON.stringify(publicPage.body);
    for (const secret of [owner.id, "station_owner", "payload", "checksum", "email", "token", "orbitalMarks"]) {
      assert.equal(publicBodyText.includes(secret), false, secret);
    }

    const clientSnapshotRejected = await request(running.baseUrl, "/api/station/publish", {
      method: "POST",
      headers: owner.headers,
      body: JSON.stringify({ snapshot: { forged: true } }),
    });
    assert.equal(clientSnapshotRejected.response.status, 400);
    assert.equal(clientSnapshotRejected.body.code, "STATION_CLIENT_SNAPSHOT_FORBIDDEN");

    const manualOnly = await register(running.baseUrl, "station_manual_only", "手动槽测试");
    const manualUpload = await request(running.baseUrl, "/api/cloud-save?slot=1", {
      method: "PUT",
      headers: manualOnly.headers,
      body: JSON.stringify({ payload, expectedRevision: 0 }),
    });
    assert.equal(manualUpload.response.status, 200);
    const manualPublish = await request(running.baseUrl, "/api/station/publish", {
      method: "POST",
      headers: manualOnly.headers,
      body: "{}",
    });
    assert.equal(manualPublish.response.status, 409);
    assert.equal(manualPublish.body.code, "STATION_MAIN_SAVE_REQUIRED");

    const speedrunOnly = await register(running.baseUrl, "station_speedrun_only", "速通槽测试");
    const speedrunState = createV47State();
    speedrunState.version = 46;
    speedrunState.mode = "speedrun";
    speedrunState.entities = speedrunState.entities.filter((entity) => entity.buildingId !== "orbital_cargo_terminal");
    speedrunState.belts = [];
    delete speedrunState.orbitalStation;
    const speedrunUpload = await request(running.baseUrl, "/api/cloud-save?mode=speedrun", {
      method: "PUT",
      headers: speedrunOnly.headers,
      body: JSON.stringify({ payload: createPayload(speedrunState), expectedRevision: 0 }),
    });
    assert.equal(speedrunUpload.response.status, 200, JSON.stringify(speedrunUpload.body));
    const speedrunPublish = await request(running.baseUrl, "/api/station/publish", {
      method: "POST",
      headers: speedrunOnly.headers,
      body: "{}",
    });
    assert.equal(speedrunPublish.response.status, 409);
    assert.equal(speedrunPublish.body.code, "STATION_MAIN_SAVE_REQUIRED");

    const downgraded = await register(running.baseUrl, "station_downgraded", "旧版覆盖测试");
    const firstCurrentUpload = await request(running.baseUrl, "/api/cloud-save", {
      method: "PUT",
      headers: downgraded.headers,
      body: JSON.stringify({ payload, expectedRevision: 0 }),
    });
    assert.equal(firstCurrentUpload.response.status, 200);
    const downgradedPublicId = (await request(running.baseUrl, "/api/station/me", { headers: downgraded.headers })).body.publicId;
    assert.match(downgradedPublicId, /^station_[a-f0-9]{32}$/);
    const v46Replacement = createV47State();
    v46Replacement.version = 46;
    v46Replacement.entities = v46Replacement.entities.filter((entity) => entity.buildingId !== "orbital_cargo_terminal");
    v46Replacement.belts = [];
    delete v46Replacement.orbitalStation;
    const replacedByOldMain = await request(running.baseUrl, "/api/cloud-save", {
      method: "PUT",
      headers: downgraded.headers,
      body: JSON.stringify({ payload: createPayload(v46Replacement), expectedRevision: 1 }),
    });
    assert.equal(replacedByOldMain.response.status, 200);
    assert.equal((await request(running.baseUrl, `/api/stations/${downgradedPublicId}`)).response.status, 404);
    assert.equal((await request(running.baseUrl, "/api/station/me", { headers: downgraded.headers })).body.published, false);
    assert.equal((await request(running.baseUrl, "/api/account/delete", {
      method: "POST",
      headers: downgraded.headers,
      body: JSON.stringify({ password: PASSWORD, confirmation: "DELETE" }),
    })).response.status, 200);

    let ranking = await request(running.baseUrl, "/api/leaderboard?category=galaxy&seasonId=season_01");
    assert.equal(ranking.response.status, 200);
    assert.equal(ranking.body.entries.find((entry) => entry.displayName === "空间站主人")?.stationPublicId, publicId);

    const hidden = await request(running.baseUrl, "/api/station/visibility", {
      method: "POST",
      headers: owner.headers,
      body: JSON.stringify({ visibility: "private" }),
    });
    assert.equal(hidden.response.status, 200);
    assert.equal(hidden.body.visibility, "private");
    assert.equal((await request(running.baseUrl, `/api/stations/${publicId}`)).response.status, 404);
    ranking = await request(running.baseUrl, "/api/leaderboard?category=galaxy&seasonId=season_01");
    assert.equal(ranking.body.entries.find((entry) => entry.displayName === "空间站主人")?.stationPublicId, undefined);
    assert.equal(ranking.body.entries.some((entry) => entry.displayName === "空间站主人"), true);

    const restoredVisibility = await request(running.baseUrl, "/api/station/visibility", {
      method: "POST",
      headers: owner.headers,
      body: JSON.stringify({ visibility: "public" }),
    });
    assert.equal(restoredVisibility.response.status, 200);
    assert.equal(restoredVisibility.body.publicId, publicId);

    const favorite = await request(running.baseUrl, `/api/stations/${publicId}/favorite`, {
      method: "POST",
      headers: visitor.headers,
      body: "{}",
    });
    assert.equal(favorite.response.status, 200);
    assert.equal(favorite.body.social.favoriteCount, 1);
    const repeatedFavorite = await request(running.baseUrl, `/api/stations/${publicId}/favorite`, {
      method: "POST",
      headers: visitor.headers,
      body: "{}",
    });
    assert.equal(repeatedFavorite.body.social.favoriteCount, 1);
    const unfavorite = await request(running.baseUrl, `/api/stations/${publicId}/favorite`, {
      method: "DELETE",
      headers: visitor.headers,
    });
    assert.equal(unfavorite.response.status, 200);
    assert.equal(unfavorite.body.social.favoriteCount, 0);
    const repeatedUnfavorite = await request(running.baseUrl, `/api/stations/${publicId}/favorite`, {
      method: "DELETE",
      headers: visitor.headers,
    });
    assert.equal(repeatedUnfavorite.body.social.favoriteCount, 0);
    const restoredFavorite = await request(running.baseUrl, `/api/stations/${publicId}/favorite`, {
      method: "POST",
      headers: visitor.headers,
      body: "{}",
    });
    assert.equal(restoredFavorite.body.social.favoriteCount, 1);
    const signal = await request(running.baseUrl, `/api/stations/${publicId}/signal`, {
      method: "POST",
      headers: visitor.headers,
      body: JSON.stringify({ signalId: "spectacular" }),
    });
    assert.equal(signal.response.status, 200);
    assert.equal(signal.body.social.signals.spectacular, 1);
    const changedSignal = await request(running.baseUrl, `/api/stations/${publicId}/signal`, {
      method: "POST",
      headers: visitor.headers,
      body: JSON.stringify({ signalId: "layout" }),
    });
    assert.equal(changedSignal.body.social.signals.spectacular, 0);
    assert.equal(changedSignal.body.social.signals.layout, 1);
    for (let index = 0; index < 18; index += 1) {
      const repeatedSignal = await request(running.baseUrl, `/api/stations/${publicId}/signal`, {
        method: "POST",
        headers: visitor.headers,
        body: JSON.stringify({ signalId: "layout" }),
      });
      assert.equal(repeatedSignal.response.status, 200);
    }
    const rateLimitedSignal = await request(running.baseUrl, `/api/stations/${publicId}/signal`, {
      method: "POST",
      headers: visitor.headers,
      body: JSON.stringify({ signalId: "layout" }),
    });
    assert.equal(rateLimitedSignal.response.status, 429);
    assert.equal(rateLimitedSignal.body.code, "STATION_SOCIAL_RATE_LIMITED");
    const selfFavorite = await request(running.baseUrl, `/api/stations/${publicId}/favorite`, {
      method: "POST",
      headers: owner.headers,
      body: "{}",
    });
    assert.equal(selfFavorite.response.status, 409);

    const stationTables = ["station_profiles", "station_favorites", "station_signals", "station_moderation"];
    for (const table of stationTables) {
      assert.equal(running.server.store.database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1);
    }
    assert.equal(running.server.store.database.prepare("SELECT count(*) AS count FROM station_profiles").get().count, 1);
    assert.equal(running.server.store.database.prepare("SELECT count(*) AS count FROM station_favorites").get().count, 1);
    assert.equal(running.server.store.database.prepare("SELECT count(*) AS count FROM station_signals").get().count, 1);
    const appState = JSON.parse(running.server.store.database.prepare("SELECT payload FROM app_state WHERE id = 1").get().payload);
    for (const key of ["stationProfiles", "stationFavorites", "stationSignals", "stationModeration"]) {
      assert.equal(Object.hasOwn(appState, key), false, key);
    }

    const withdrawn = await request(running.baseUrl, "/api/admin/account/action", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ accountId: owner.id, action: "withdraw-station", confirmation: `CONFIRM:withdraw-station:${owner.id}`, reason: "test-review" }),
    });
    assert.equal(withdrawn.response.status, 200);
    assert.equal((await request(running.baseUrl, `/api/stations/${publicId}`)).response.status, 404);
    const restored = await request(running.baseUrl, "/api/admin/account/action", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ accountId: owner.id, action: "restore-station", confirmation: `CONFIRM:restore-station:${owner.id}` }),
    });
    assert.equal(restored.response.status, 200);
    assert.equal((await request(running.baseUrl, `/api/stations/${publicId}`)).response.status, 200);

    await stopServer(running.server);
    running = await startServer(databaseFile);
    const afterRestart = await request(running.baseUrl, `/api/stations/${publicId}`, { headers: visitor.headers });
    assert.equal(afterRestart.response.status, 200);
    assert.equal(afterRestart.body.social.favoriteCount, 1);
    assert.equal(afterRestart.body.social.viewerSignal, "layout");

    const deletedVisitor = await request(running.baseUrl, "/api/account/delete", {
      method: "POST",
      headers: visitor.headers,
      body: JSON.stringify({ password: PASSWORD, confirmation: "DELETE" }),
    });
    assert.equal(deletedVisitor.response.status, 200);
    assert.equal(running.server.store.database.prepare("SELECT count(*) AS count FROM station_favorites").get().count, 0);
    assert.equal(running.server.store.database.prepare("SELECT count(*) AS count FROM station_signals").get().count, 0);

    const deletedMainSave = await request(running.baseUrl, "/api/cloud-save", {
      method: "DELETE",
      headers: owner.headers,
      body: JSON.stringify({ expectedRevision: 1, confirmation: "DELETE_CLOUD_SAVE:normal:main" }),
    });
    assert.equal(deletedMainSave.response.status, 200);
    assert.equal((await request(running.baseUrl, `/api/stations/${publicId}`)).response.status, 404);
    assert.equal(running.server.store.database.prepare("SELECT snapshot_json AS snapshotJson FROM station_profiles WHERE user_id = ?").get(owner.id).snapshotJson, null);

    const deletedOwner = await request(running.baseUrl, "/api/account/delete", {
      method: "POST",
      headers: owner.headers,
      body: JSON.stringify({ password: PASSWORD, confirmation: "DELETE" }),
    });
    assert.equal(deletedOwner.response.status, 200);
    assert.equal(running.server.store.database.prepare("SELECT count(*) AS count FROM station_profiles").get().count, 0);
    assert.equal((await request(running.baseUrl, `/api/stations/${publicId}`)).response.status, 404);
  } finally {
    await stopServer(running?.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite layout v2 to v3 creates station tables without rewriting cloud payload rows", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-station-layout-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  let running;
  try {
    running = await startServer(databaseFile);
    const owner = await register(running.baseUrl, "station_layout_owner", "迁移测试站主");
    const payload = createPayload(createV47State());
    const upload = await request(running.baseUrl, "/api/cloud-save", {
      method: "PUT",
      headers: owner.headers,
      body: JSON.stringify({ payload, expectedRevision: 0 }),
    });
    assert.equal(upload.response.status, 200, JSON.stringify(upload.body));
    await stopServer(running.server);
    running = null;

    const database = new Database(databaseFile);
    const payloadRowsBefore = database.prepare("SELECT user_id, slot, revision, payload FROM cloud_save_payloads ORDER BY user_id, slot, revision").all();
    const blobRowsBefore = database.prepare("SELECT checksum, size_bytes, payload FROM cloud_save_payload_blobs ORDER BY checksum").all();
    const appStateRow = database.prepare("SELECT payload FROM app_state WHERE id = 1").get();
    const appState = JSON.parse(appStateRow.payload);
    appState.schemaVersion = 7;
    appState.storageLayoutVersion = 2;
    database.prepare("UPDATE app_state SET payload = ? WHERE id = 1").run(JSON.stringify(appState));
    database.exec("DROP TABLE station_favorites; DROP TABLE station_signals; DROP TABLE station_moderation; DROP TABLE station_profiles;");
    database.close();

    running = await startServer(databaseFile);
    assert.equal(running.server.store.data.schemaVersion, 8);
    assert.equal(running.server.store.data.storageLayoutVersion, 3);
    assert.deepEqual(
      running.server.store.database.prepare("SELECT user_id, slot, revision, payload FROM cloud_save_payloads ORDER BY user_id, slot, revision").all(),
      payloadRowsBefore,
    );
    assert.deepEqual(
      running.server.store.database.prepare("SELECT checksum, size_bytes, payload FROM cloud_save_payload_blobs ORDER BY checksum").all(),
      blobRowsBefore,
    );
    for (const table of ["station_profiles", "station_favorites", "station_signals", "station_moderation"]) {
      assert.equal(running.server.store.database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1);
    }
  } finally {
    await stopServer(running?.server);
    await rm(directory, { recursive: true, force: true });
  }
});
