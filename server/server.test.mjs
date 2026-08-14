import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import { cleanupExpiredAuthRecords, createCloudServer, createRateLimiter } from "./index.mjs";
import { metricDay } from "./analytics.mjs";
import { computeSaveStateChecksum } from "./save-integrity.mjs";
import { aggregateGalacticFactoryMetric } from "./galactic-metrics.mjs";

let directory;
let server;
let baseUrl;
let token;
let mailbox;
let offsiteBackupStatusFile;
let restoreDrillStatusFile;
let nodeHealthStatusFile;
const adminToken = "test-admin-secret-1234567890-abcdef";
const historicalUniqueMegastructureFixturePath = process.env.DSP_HISTORICAL_UNIQUE_MEGASTRUCTURE_FIXTURE;
const galacticThroughputFixturePath = process.env.DSP_GALACTIC_THROUGHPUT_FIXTURE;
function createSavePayload(state, savedAt = 123456) {
  const envelope = { formatVersion: 2, savedAt, state };
  return JSON.stringify({ ...envelope, checksum: computeSaveStateChecksum(envelope.formatVersion, state) });
}

function createModeSavePayload(state, mode, savedAt = 123456) {
  const markedState = { ...state, mode };
  const envelope = { formatVersion: 2, savedAt, mode, state: markedState };
  return JSON.stringify({ ...envelope, checksum: computeSaveStateChecksum(envelope.formatVersion, markedState) });
}

function mutateSavePayload(payload, mutate) {
  const parsed = JSON.parse(payload);
  mutate(parsed.state);
  return createSavePayload(parsed.state, parsed.savedAt);
}

const cloudPayload = createSavePayload({
    version: 24,
    elapsedSeconds: 1_000_000,
    entities: [],
    totalProduced: { universe_matrix: 10 },
    metrics: { generationKw: 1_000, totalItemsPerMinute: 0, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
});

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-"));
  offsiteBackupStatusFile = path.join(directory, "offsite-status.json");
  restoreDrillStatusFile = path.join(directory, "restore-status.json");
  nodeHealthStatusFile = path.join(directory, "node-health-status.json");
  await writeFile(offsiteBackupStatusFile, JSON.stringify({ ok: true, completedAt: 100, durationMs: 20, transported: true, transport: "local", schemaVersion: 5, artifact: "cloud-test.sqlite.dspbak" }));
  await writeFile(restoreDrillStatusFile, JSON.stringify({ ok: true, completedAt: 200, durationMs: 30, restoredSchemaVersion: 5, artifact: "cloud-test.sqlite.dspbak" }));
  await writeFile(nodeHealthStatusFile, JSON.stringify({ ok: true, checkedAt: 300, failedChecks: [], endpoints: [{ url: "https://dsponline.cn/api/health", ok: true, status: 200, latencyMs: 12.5, contentEncoding: "gzip" }], disk: { ok: true, freeBytes: 80, totalBytes: 100, freeRatio: 0.8 }, tls: { configured: true, ok: true, expiresAt: 1000, daysRemaining: 60 } }));
  mailbox = [];
  server = await createCloudServer({
    databaseFile: path.join(directory, "cloud.sqlite"),
    adminToken,
    offsiteBackupStatusFile,
    restoreDrillStatusFile,
    nodeHealthStatusFile,
    registrationLimit: 100,
    allowedOrigin: "https://dsponline.cn,https://localhost",
    mailer: async (message) => { mailbox.push(message); return true; },
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  return { response, body: await response.json() };
}

test("cleans only expired and orphaned authentication records", () => {
  const now = 10_000;
  const data = {
    users: { active_user: { id: "active_user" } },
    sessions: {
      active_session: { userId: "active_user", expiresAt: now + 1 },
      expired_session: { userId: "active_user", expiresAt: now },
      orphaned_session: { userId: "missing_user", expiresAt: now + 1_000 },
    },
    emailVerifications: {
      active_verification: { userId: "active_user", expiresAt: now + 1 },
      expired_verification: { userId: "active_user", expiresAt: now - 1 },
    },
    passwordResets: {
      active_reset: { userId: "active_user", expiresAt: now + 1 },
      invalid_reset: { userId: "active_user", expiresAt: Number.NaN },
    },
  };

  assert.deepEqual(cleanupExpiredAuthRecords(data, now), {
    sessions: 2,
    emailVerifications: 1,
    passwordResets: 1,
    total: 4,
  });
  assert.deepEqual(Object.keys(data.sessions), ["active_session"]);
  assert.deepEqual(Object.keys(data.emailVerifications), ["active_verification"]);
  assert.deepEqual(Object.keys(data.passwordResets), ["active_reset"]);
});

test("rate limiter reclaims expired buckets without resetting active keys", () => {
  let now = 1_000;
  const rateLimit = createRateLimiter(() => now);
  assert.equal(rateLimit("short", 1, 100), true);
  assert.equal(rateLimit("short", 1, 100), false);
  assert.equal(rateLimit("long", 1, 1_000), true);
  now = 1_101;
  assert.equal(rateLimit.cleanup(), 1);
  assert.equal(rateLimit("short", 1, 100), true);
  assert.equal(rateLimit("long", 1, 1_000), false);
  now = 2_001;
  assert.equal(rateLimit.cleanup(), 2);
  assert.equal(rateLimit("long", 1, 1_000), true);
});

test("isolates normal and speedrun cloud saves by mode and slot", async () => {
  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "ModePilot", password: "strong-pass-123", displayName: "模式测试员" }),
  });
  assert.equal(registered.response.status, 201);
  const headers = { authorization: `Bearer ${registered.body.token}` };
  const baseState = {
    version: 24,
    elapsedSeconds: 100,
    entities: [],
    totalProduced: { universe_matrix: 10 },
    metrics: { generationKw: 1_000, totalItemsPerMinute: 0, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  };
  const normalPayload = createModeSavePayload(baseState, "normal", 1);
  const speedrunPayload = createModeSavePayload(baseState, "speedrun", 2);
  const normal = await request("/api/cloud-save?slot=1", { method: "PUT", headers, body: JSON.stringify({ payload: normalPayload, expectedRevision: 0 }) });
  const speedrun = await request("/api/cloud-save?slot=1&mode=speedrun", { method: "PUT", headers, body: JSON.stringify({ payload: speedrunPayload, expectedRevision: 0 }) });
  assert.equal(normal.response.status, 200);
  assert.equal(speedrun.response.status, 200);
  assert.equal(normal.body.cloudSave.revision, 1);
  assert.equal(speedrun.body.cloudSave.revision, 1);
  assert.equal(speedrun.body.cloudSave.mode, "speedrun");

  const normalLoaded = await request("/api/cloud-save?slot=1", { headers });
  const speedrunLoaded = await request("/api/cloud-save?slot=1&mode=speedrun", { headers });
  assert.equal(normalLoaded.body.cloudSave.payload, normalPayload);
  assert.equal(speedrunLoaded.body.cloudSave.payload, speedrunPayload);
  const account = await request("/api/account", { headers });
  assert.equal(account.body.cloudSavesByMode.normal["1"].revision, 1);
  assert.equal(account.body.cloudSavesByMode.speedrun["1"].revision, 1);

  const normalPayload2 = createModeSavePayload({ ...baseState, elapsedSeconds: 200 }, "normal", 3);
  const speedrunPayload2 = createModeSavePayload({ ...baseState, elapsedSeconds: 300 }, "speedrun", 4);
  assert.equal((await request("/api/cloud-save?slot=1", { method: "PUT", headers, body: JSON.stringify({ payload: normalPayload2, expectedRevision: 1 }) })).body.cloudSave.revision, 2);
  assert.equal((await request("/api/cloud-save?slot=1&mode=speedrun", { method: "PUT", headers, body: JSON.stringify({ payload: speedrunPayload2, expectedRevision: 1 }) })).body.cloudSave.revision, 2);
  const normalHistory = await request("/api/cloud-save/history?slot=1", { headers });
  const speedrunHistory = await request("/api/cloud-save/history?slot=1&mode=speedrun", { headers });
  assert.deepEqual(normalHistory.body.history.map((entry) => entry.revision), [2, 1]);
  assert.deepEqual(speedrunHistory.body.history.map((entry) => entry.revision), [2, 1]);
  assert.ok(normalHistory.body.history.every((entry) => entry.mode === "normal"));
  assert.ok(speedrunHistory.body.history.every((entry) => entry.mode === "speedrun"));

  const restoredSpeedrun = await request("/api/cloud-save/restore?slot=1&mode=speedrun", {
    method: "POST",
    headers,
    body: JSON.stringify({ revision: 1, expectedRevision: 2 }),
  });
  assert.equal(restoredSpeedrun.body.cloudSave.revision, 3);
  assert.equal((await request("/api/cloud-save?slot=1", { headers })).body.cloudSave.revision, 2);
  const staleNormalDevice = await request("/api/cloud-save?slot=1", {
    method: "PUT",
    headers,
    body: JSON.stringify({ payload: normalPayload, expectedRevision: 1 }),
  });
  assert.equal(staleNormalDevice.response.status, 409);
  assert.equal((await request("/api/cloud-save?slot=1&mode=speedrun", { headers })).body.cloudSave.revision, 3);

  const mismatch = await request("/api/cloud-save?slot=2&mode=speedrun", {
    method: "PUT",
    headers,
    body: JSON.stringify({ payload: normalPayload, expectedRevision: 0 }),
  });
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.body.code, "SAVE_MODE_MISMATCH");

  const wrongDelete = await request("/api/cloud-save?slot=1", {
    method: "DELETE",
    headers,
    body: JSON.stringify({ expectedRevision: 2, confirmation: "DELETE_CLOUD_SAVE:speedrun:1" }),
  });
  assert.equal(wrongDelete.response.status, 400);
  const deletedNormal = await request("/api/cloud-save?slot=1", {
    method: "DELETE",
    headers,
    body: JSON.stringify({ expectedRevision: 2, confirmation: "DELETE_CLOUD_SAVE:normal:1" }),
  });
  assert.equal(deletedNormal.response.status, 200);
  assert.equal((await request("/api/cloud-save?slot=1", { headers })).body.cloudSave, null);
  assert.equal((await request("/api/cloud-save?slot=1&mode=speedrun", { headers })).body.cloudSave.revision, 3);

  const recreatedNormal = await request("/api/cloud-save?slot=1", {
    method: "PUT",
    headers,
    body: JSON.stringify({ payload: normalPayload, expectedRevision: 0 }),
  });
  assert.equal(recreatedNormal.body.cloudSave.revision, 1);
  const deletedSpeedrun = await request("/api/cloud-save?slot=1&mode=speedrun", {
    method: "DELETE",
    headers,
    body: JSON.stringify({ expectedRevision: 3, confirmation: "DELETE_CLOUD_SAVE:speedrun:1" }),
  });
  assert.equal(deletedSpeedrun.response.status, 200);
  assert.equal((await request("/api/cloud-save?slot=1&mode=speedrun", { headers })).body.cloudSave, null);
  assert.equal((await request("/api/cloud-save?slot=1", { headers })).body.cloudSave.payload, normalPayload);
  const rows = server.store.database.prepare("SELECT slot, count(*) AS count FROM cloud_save_payloads WHERE user_id = ? AND slot IN ('1', 'speedrun:1') GROUP BY slot ORDER BY slot").all(registered.body.user.id);
  assert.deepEqual(rows, [{ slot: "1", count: 1 }]);
});

test("migrates and reopens same-revision normal and speedrun payload rows without collision", async () => {
  const migrationDirectory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-mode-migration-"));
  const dataFile = path.join(migrationDirectory, "cloud.json");
  const databaseFile = path.join(migrationDirectory, "cloud.sqlite");
  const userId = "mode_migration_user";
  const baseState = {
    version: 24,
    elapsedSeconds: 10,
    entities: [],
    totalProduced: { universe_matrix: 0 },
    metrics: { generationKw: 0, totalItemsPerMinute: 0, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  };
  const normalPayload = createModeSavePayload(baseState, "normal", 10);
  const speedrunPayload = createModeSavePayload({ ...baseState, elapsedSeconds: 20 }, "speedrun", 20);
  const saveRecord = (payload, updatedAt) => ({
    revision: 1,
    payload,
    checksum: createHash("sha256").update(payload).digest("hex"),
    size: Buffer.byteLength(payload),
    updatedAt,
  });
  const normal = saveRecord(normalPayload, 10);
  const speedrun = saveRecord(speedrunPayload, 20);
  await writeFile(dataFile, JSON.stringify({
    schemaVersion: 7,
    users: { [userId]: { id: userId, username: "mode_migration", displayName: "模式迁移", createdAt: 1 } },
    cloudSaves: { [userId]: normal },
    cloudSaveHistory: { [userId]: [normal] },
    cloudSavesByMode: { [userId]: { speedrun } },
    cloudSaveHistoryByMode: { [userId]: { speedrun: [speedrun] } },
  }));

  let migratedServer;
  let reopenedServer;
  try {
    migratedServer = await createCloudServer({ dataFile, databaseFile, historyPruneIntervalMs: 0, logger: { error() {} } });
    await new Promise((resolve) => migratedServer.listen(0, "127.0.0.1", resolve));
    assert.equal(migratedServer.store.readCloudSavePayload(userId, "main", 1), normalPayload);
    assert.equal(migratedServer.store.readCloudSavePayload(userId, "speedrun:main", 1), speedrunPayload);
    await new Promise((resolve) => migratedServer.close(resolve));
    migratedServer = null;

    reopenedServer = await createCloudServer({ databaseFile, historyPruneIntervalMs: 0, logger: { error() {} } });
    await new Promise((resolve) => reopenedServer.listen(0, "127.0.0.1", resolve));
    assert.equal(reopenedServer.store.readCloudSavePayload(userId, "main", 1), normalPayload);
    assert.equal(reopenedServer.store.readCloudSavePayload(userId, "speedrun:main", 1), speedrunPayload);
    const rows = reopenedServer.store.database.prepare("SELECT slot, payload FROM cloud_save_payloads WHERE user_id = ? ORDER BY slot").all(userId);
    assert.deepEqual(rows, [
      { slot: "main", payload: normalPayload },
      { slot: "speedrun:main", payload: speedrunPayload },
    ]);
  } finally {
    if (migratedServer) await new Promise((resolve) => migratedServer.close(resolve));
    if (reopenedServer) await new Promise((resolve) => reopenedServer.close(resolve));
    await rm(migrationDirectory, { recursive: true, force: true });
  }
});

test("rejects ordinary and forbidden saves while accepting an eligible speedrun submission", async () => {
  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "speedrun_guard", password: "strong-pass-789", displayName: "速通校验员" }),
  });
  assert.equal(registered.response.status, 201);
  const headers = { authorization: `Bearer ${registered.body.token}` };
  const baseState = {
    version: 24,
    elapsedSeconds: 300,
    entities: [],
    settings: { resourceMode: "finite", difficulty: "standard" },
    research: { completedTechIds: [] },
    dysonSphere: { totalRocketsLaunched: 0 },
    totalProduced: { universe_matrix: 1_000_000 },
    metrics: { generationKw: 1_000, totalItemsPerMinute: 0, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  };
  const normalPayload = createModeSavePayload(baseState, "normal", Date.now() - 1_000);
  const normalUpload = await request("/api/cloud-save", {
    method: "PUT",
    headers,
    body: JSON.stringify({ payload: normalPayload, expectedRevision: 0 }),
  });
  assert.equal(normalUpload.response.status, 200);
  const ordinaryAttempt = await request("/api/speedrun/submit", {
    method: "POST",
    headers,
    body: JSON.stringify({
      targetId: "white_matrix_1m",
      seasonId: "season_01",
      rulesetVersion: "speedrun-v1",
      factoryId: "ordinary_factory_cannot_rank",
      elapsedSeconds: 300,
      saveRevision: normalUpload.body.cloudSave.revision,
      saveHash: normalUpload.body.cloudSave.checksum,
      clientVersion: "1.0.35",
    }),
  });
  assert.equal(ordinaryAttempt.response.status, 409);
  assert.equal(ordinaryAttempt.body.code, "SPEEDRUN_SAVE_MISSING");

  const factoryId = "speedrun_guard_factory_0001";
  const speedrunState = {
    ...baseState,
    settings: { ...baseState.settings, resourceMode: "infinite" },
    speedrun: {
      enabled: true,
      mode: "speedrun",
      rulesetVersion: "speedrun-v1",
      seasonId: "season_01",
      startedAt: Date.now() - 10 * 60_000,
      elapsedActiveSeconds: 300,
      baseline: { completedTechIds: [], rocketsLaunched: 0, whiteMatrixProduced: 0 },
      milestones: {
        all_technologies: { completed: false },
        dyson_rockets_10000: { completed: false },
        white_matrix_1m: { completed: true, completedAtSeconds: 300 },
      },
      eligible: true,
      factoryId,
    },
  };
  const speedrunPayload = createModeSavePayload(speedrunState, "speedrun", Date.now());
  const speedrunUpload = await request("/api/cloud-save?mode=speedrun", {
    method: "PUT",
    headers,
    body: JSON.stringify({ payload: speedrunPayload, expectedRevision: 0 }),
  });
  assert.equal(speedrunUpload.response.status, 200, JSON.stringify(speedrunUpload.body));
  const submissionBody = {
    targetId: "white_matrix_1m",
    seasonId: "season_01",
    rulesetVersion: "speedrun-v1",
    factoryId,
    elapsedSeconds: 300,
    saveRevision: speedrunUpload.body.cloudSave.revision,
    saveHash: speedrunUpload.body.cloudSave.checksum,
    clientVersion: "1.0.35",
  };
  const accepted = await request("/api/speedrun/submit", { method: "POST", headers, body: JSON.stringify(submissionBody) });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.verified, true);
  assert.equal(accepted.body.entry.resourceMode, "infinite");
  assert.equal(Object.hasOwn(accepted.body.entry, "factoryId"), false, "public submit response must not expose the private factory identity");
  assert.equal(accepted.body.entry.userId, accepted.body.entry.publicId);
  const repeated = await request("/api/speedrun/submit", { method: "POST", headers, body: JSON.stringify(submissionBody) });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.idempotent, true);
  const publicInfiniteBoard = await request("/api/speedrun/leaderboard?targetId=white_matrix_1m&seasonId=season_01");
  assert.equal(publicInfiniteBoard.response.status, 200);
  assert.equal(publicInfiniteBoard.body.entries.find((entry) => entry.publicId === accepted.body.entry.publicId)?.resourceMode, "infinite");

  const forbiddenPayload = createModeSavePayload({ ...speedrunState, experimentalSettlement: true }, "speedrun", Date.now() + 1);
  const forbiddenUpload = await request("/api/cloud-save?mode=speedrun", {
    method: "PUT",
    headers,
    body: JSON.stringify({ payload: forbiddenPayload, expectedRevision: 1 }),
  });
  assert.equal(forbiddenUpload.response.status, 200);
  const forbidden = await request("/api/speedrun/submit", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...submissionBody, saveRevision: 2, saveHash: forbiddenUpload.body.cloudSave.checksum }),
  });
  assert.equal(forbidden.response.status, 422);
  assert.equal(forbidden.body.code, "SPEEDRUN_FORBIDDEN_STATE");
});

test("authorizes the Android WebView origin and rejects unknown origins", async () => {
  const android = await request("/api/health", { headers: { origin: "https://localhost" } });
  assert.equal(android.response.status, 200);
  assert.equal(android.response.headers.get("access-control-allow-origin"), "https://localhost");

  const preflight = await fetch(`${baseUrl}/api/cloud-save`, {
    method: "OPTIONS",
    headers: {
      origin: "https://localhost",
      "access-control-request-method": "PUT",
      "access-control-request-headers": "authorization,content-type,content-encoding,x-dsp-expected-revision,x-dsp-request-id,x-dsp-save-original-bytes,x-dsp-save-compressed-bytes",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://localhost");
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /PUT/);
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /DELETE/);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /x-dsp-expected-revision/i);
  assert.match(preflight.headers.get("vary") ?? "", /Origin/);

  const unknown = await request("/api/health", { headers: { origin: "https://attacker.invalid" } });
  assert.equal(unknown.response.status, 403);
  assert.equal(unknown.response.headers.get("access-control-allow-origin"), null);
});

test("registers by username, requires a main cloud save for ranking and verifies a bound email", async () => {
  const health = await request("/api/health");
  assert.equal(health.body.mailProvider, "custom");
  assert.equal(health.body.schemaVersion, 7);
  assert.equal(health.body.storageLayoutVersion, 2);
  const registered = await request("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "Pilot_One", password: "strong-pass-123", displayName: "测试工程师" }) });
  assert.equal(registered.response.status, 201);
  assert.ok(registered.body.token);
  assert.equal(registered.body.user.username, "pilot_one");
  assert.equal(registered.body.user.email, "");
  assert.equal(registered.body.user.emailVerified, false);
  assert.equal(registered.body.user.leaderboardVisible, true);
  token = registered.body.token;

  const anonymousLeaderboard = await request("/api/leaderboard", {
    method: "POST",
    body: JSON.stringify({ seasonId: "season_01", metrics: { energyGeneratedMj: 1 } }),
  });
  assert.equal(anonymousLeaderboard.response.status, 401);

  const blockedLeaderboard = await request("/api/leaderboard", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ seasonId: "season_01", metrics: { energyGeneratedMj: 1 } }),
  });
  assert.equal(blockedLeaderboard.response.status, 409);
  assert.match(blockedLeaderboard.body.error, /主云存档/);

  const duplicate = await request("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "PILOT_ONE", password: "strong-pass-123", displayName: "另一位工程师" }) });
  assert.equal(duplicate.response.status, 409);

  const bound = await request("/api/account/email", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ email: "pilot@example.com" }),
  });
  assert.equal(bound.response.status, 202);
  const verification = mailbox.find((message) => message.kind === "verify" && message.email === "pilot@example.com");
  assert.ok(verification?.actionToken);
  const verified = await request("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verification.actionToken }) });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.user.emailVerified, true);
  const reused = await request("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verification.actionToken }) });
  assert.equal(reused.response.status, 400);
});

test("opens cloud saves and verified leaderboard submissions without a mail provider", async () => {
  const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "dsp-no-mail-"));
  let isolatedServer;
  try {
    isolatedServer = await createCloudServer({ databaseFile: path.join(isolatedDirectory, "cloud.sqlite"), registrationLimit: 1, mailer: null, logger: { error() {} } });
    await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
    const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
    const isolatedRequest = async (route, options = {}) => {
      const response = await fetch(`${isolatedBaseUrl}${route}`, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers || {}) },
      });
      return { response, body: await response.json() };
    };
    const health = await isolatedRequest("/api/health");
    assert.equal(health.body.mailProvider, "disabled");
    assert.equal(health.body.schemaVersion, 7);
    const registered = await isolatedRequest("/api/auth/register", {
      method: "POST",
      headers: { "x-forwarded-for": "spoofed-a, 203.0.113.42" },
      body: JSON.stringify({ username: "no_mail_pilot", password: "strong-pass-123", displayName: "邮件未配置" }),
    });
    assert.equal(registered.response.status, 201);
    assert.equal(registered.body.user.email, "");
    assert.equal(registered.body.user.emailVerified, false);
    assert.equal(registered.body.mailAvailable, false);
    const rateLimited = await isolatedRequest("/api/auth/register", {
      method: "POST",
      headers: { "x-forwarded-for": "spoofed-b, 203.0.113.42" },
      body: JSON.stringify({ username: "second_pilot", password: "strong-pass-123", displayName: "第二位工程师" }),
    });
    assert.equal(rateLimited.response.status, 429);
    assert.equal(rateLimited.body.code, "REGISTRATION_RATE_LIMITED");
    const isolatedToken = registered.body.token;
    const headers = { authorization: `Bearer ${isolatedToken}` };

    for (const slot of ["main", "1", "2", "3"]) {
      const suffix = slot === "main" ? "" : `?slot=${slot}`;
      const saved = await isolatedRequest(`/api/cloud-save${suffix}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ payload: cloudPayload, expectedRevision: 0 }),
      });
      assert.equal(saved.response.status, 200);
      assert.equal(saved.body.cloudSave.revision, 1);
      assert.equal(saved.body.cloudSave.slot, slot);
    }
    const autoRanked = await isolatedRequest("/api/leaderboard?category=galaxy&seasonId=season_01");
    assert.equal(autoRanked.body.entries.length, 1);
    assert.equal(autoRanked.body.entries[0].metrics.uploadedWhiteMatrix, 10);
    assert.equal(autoRanked.body.entries[0].verified, true);
    const second = await isolatedRequest("/api/cloud-save", {
      method: "PUT",
      headers,
      body: JSON.stringify({ payload: mutateSavePayload(cloudPayload, (state) => { state.totalProduced.universe_matrix = 12; }), expectedRevision: 1 }),
    });
    assert.equal(second.body.cloudSave.revision, 2);
    const history = await isolatedRequest("/api/cloud-save/history", { headers });
    assert.deepEqual(history.body.history.map((entry) => entry.revision), [2, 1]);
    const restored = await isolatedRequest("/api/cloud-save/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: 1, expectedRevision: 2 }),
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.cloudSave.revision, 3);
    const account = await isolatedRequest("/api/account", { headers });
    assert.equal(account.body.cloudSaves.main.revision, 3);
    assert.equal(account.body.cloudSaves["1"].revision, 1);
    assert.equal(account.body.cloudSaves["2"].revision, 1);
    assert.equal(account.body.cloudSaves["3"].revision, 1);

    const submittedLeaderboard = await isolatedRequest("/api/leaderboard", {
      method: "POST",
      headers,
      body: JSON.stringify({ seasonId: "season_01", metrics: { energyGeneratedMj: 1 } }),
    });
    assert.equal(submittedLeaderboard.response.status, 200);
    assert.equal(submittedLeaderboard.body.verified, true);
    assert.equal(submittedLeaderboard.body.submission.verification.cloudRevision, 3);
    assert.equal(submittedLeaderboard.body.submission.metrics.uploadedWhiteMatrix, 12);

    const loggedIn = await isolatedRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ identifier: "NO_MAIL_PILOT", password: "strong-pass-123" }),
    });
    assert.equal(loggedIn.response.status, 200);
    assert.equal(loggedIn.body.user.username, "no_mail_pilot");
  } finally {
    if (isolatedServer?.listening) await new Promise((resolve) => isolatedServer.close(resolve));
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("calculates a verified white-matrix per-minute peak from adjacent main saves", async () => {
  const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "dsp-white-rate-"));
  let isolatedServer;
  try {
    isolatedServer = await createCloudServer({ databaseFile: path.join(isolatedDirectory, "cloud.sqlite"), registrationLimit: 2, mailer: null, logger: { error() {} } });
    await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
    const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
    const isolatedRequest = async (route, options = {}) => {
      const response = await fetch(`${isolatedBaseUrl}${route}`, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers || {}) },
      });
      return { response, body: await response.json() };
    };
    const registered = await isolatedRequest("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: "white_rate_pilot", password: "strong-pass-123", displayName: "白糖速率测试" }),
    });
    assert.equal(registered.response.status, 201);
    const headers = { authorization: `Bearer ${registered.body.token}` };
    const saveAt = (elapsedSeconds, whiteMatrix) => createSavePayload({
      version: 24,
      elapsedSeconds,
      entities: [],
      totalProduced: { universe_matrix: whiteMatrix },
      metrics: { generationKw: 1_000, totalItemsPerMinute: 0, rayGenerationKw: 0 },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
    }, elapsedSeconds * 10);
    const put = async (payload, expectedRevision) => isolatedRequest("/api/cloud-save", {
      method: "PUT",
      headers,
      body: JSON.stringify({ payload, expectedRevision }),
    });
    const rate = async () => {
      const ranking = await isolatedRequest("/api/leaderboard?category=white-rate&seasonId=season_01");
      return ranking.body.entries.find((entry) => entry.userId === registered.body.user.leaderboardPublicId)?.metrics.peakWhiteMatrixPerMinute ?? 0;
    };

    assert.equal((await put(saveAt(1_000, 1_000), 0)).response.status, 200);
    assert.equal(await rate(), 0);
    assert.equal((await put(saveAt(1_059, 1_590), 1)).response.status, 200);
    assert.equal(await rate(), 0, "a window shorter than 60 simulation seconds is ignored");
    assert.equal((await put(saveAt(1_120, 2_200), 2)).response.status, 200);
    assert.equal(await rate(), 600);
    assert.equal((await put(saveAt(1_180, 2_800), 3)).response.status, 200);
    assert.equal(await rate(), 600);
    assert.equal((await put(saveAt(1_240, 2_700), 4)).response.status, 200);
    assert.equal(await rate(), 600, "negative production deltas do not reduce the peak");
    assert.equal((await put(saveAt(1_300, 3_960), 5)).response.status, 200);
    assert.equal(await rate(), 1_260);

    const submissionKey = `season_01:${registered.body.user.id}`;
    delete isolatedServer.store.data.submissions[submissionKey].metrics.peakWhiteMatrixPerMinute;
    await isolatedServer.store.persist();
    assert.equal(await rate(), 0, "old records without the new metric normalize to zero");
    const refreshed = await isolatedRequest("/api/leaderboard", { method: "POST", headers, body: JSON.stringify({ seasonId: "season_01" }) });
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.body.submission.metrics.peakWhiteMatrixPerMinute, 1_260);

    const restored = await isolatedRequest("/api/cloud-save/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: 2, expectedRevision: 6 }),
    });
    assert.equal(restored.response.status, 200);
    assert.equal(await rate(), 1_260, "a rollback revision cannot erase the historical peak");
  } finally {
    if (isolatedServer?.listening) await new Promise((resolve) => isolatedServer.close(resolve));
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("keeps the public Top 100 compatible while /leaderboard/me returns private rank, window, and account status", async () => {
  const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "dsp-leaderboard-self-"));
  let isolatedServer;
  try {
    isolatedServer = await createCloudServer({ databaseFile: path.join(isolatedDirectory, "cloud.sqlite"), registrationLimit: 2, mailer: null, logger: { error() {} } });
    await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
    const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
    const isolatedRequest = async (route, options = {}) => {
      const response = await fetch(`${isolatedBaseUrl}${route}`, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers || {}) },
      });
      return { response, body: await response.json() };
    };
    const registered = await isolatedRequest("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: "self_rank_pilot", password: "strong-pass-123", displayName: "本人排名测试" }),
    });
    assert.equal(registered.response.status, 201);
    const userId = registered.body.user.id;
    const headers = { authorization: `Bearer ${registered.body.token}` };
    const saveAt = (elapsedSeconds, whiteMatrix, ironIngot) => createSavePayload({
      version: 24,
      elapsedSeconds,
      entities: [],
      totalProduced: { universe_matrix: whiteMatrix, iron_ingot: ironIngot },
      metrics: { generationKw: 1_000, totalItemsPerMinute: 2_000, rayGenerationKw: 0 },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
    }, elapsedSeconds * 10);
    const speedrunAt = (elapsedSeconds, whiteMatrix, ironIngot) => createModeSavePayload({
      version: 24,
      elapsedSeconds,
      entities: [],
      totalProduced: { universe_matrix: whiteMatrix, iron_ingot: ironIngot },
      metrics: { generationKw: 1_000, totalItemsPerMinute: 2_000, rayGenerationKw: 0 },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
    }, "speedrun", elapsedSeconds * 10);
    const put = (route, payload, expectedRevision) => isolatedRequest(route, {
      method: "PUT",
      headers,
      body: JSON.stringify({ payload, expectedRevision }),
    });
    const ranking = (category, authenticated = false) => isolatedRequest(`/api/leaderboard?category=${category}&seasonId=season_01`, { headers: authenticated ? headers : {} });
    const me = (category, authenticated = true) => isolatedRequest(`/api/leaderboard/me?category=${category}&seasonId=season_01`, { headers: authenticated ? headers : {} });

    assert.equal((await me("throughput", false)).response.status, 401);
    let own = await me("throughput");
    assert.equal(own.body.status, "missing_main_save");
    assert.equal(own.body.entry, null);
    assert.equal(own.body.serverMetrics, null);
    assert.equal(own.body.latestWindowState, null);

    assert.equal((await put("/api/cloud-save?slot=1&mode=normal", saveAt(900, 10, 10), 0)).response.status, 200);
    assert.equal((await put("/api/cloud-save?slot=main&mode=speedrun", speedrunAt(950, 20, 20), 0)).response.status, 200);
    own = await me("throughput");
    assert.equal(own.body.status, "missing_main_save", "speedrun main and normal manual slots must not create a normal galaxy rank");

    assert.equal((await put("/api/cloud-save", saveAt(1_000, 100, 100), 0)).response.status, 200);
    let white = await me("white-rate");
    own = await me("throughput");
    assert.equal(white.body.status, "missing_adjacent_revision");
    assert.equal(white.body.latestWindowState.value, null);
    assert.equal(white.body.latestWindowState.observedSeconds, 0);
    assert.equal(own.body.status, "missing_adjacent_revision");
    assert.equal(own.body.latestWindowState.value, null);
    assert.equal(own.body.latestCloudRevision, 1);

    assert.equal((await put("/api/cloud-save", saveAt(1_059, 200, 200), 1)).response.status, 200);
    white = await me("white-rate");
    own = await me("throughput");
    for (const response of [white, own]) {
      assert.equal(response.body.status, "interval_too_short");
      assert.equal(response.body.latestWindowState.observedSeconds, 59);
      assert.equal(response.body.latestWindowState.remainingSeconds, 1);
      assert.equal(response.body.latestWindowState.value, null);
    }

    assert.equal((await put("/api/cloud-save", saveAt(1_059, 200, 200), 2)).response.status, 200);
    white = await me("white-rate");
    own = await me("throughput");
    assert.equal(white.body.status, "elapsed_not_increasing");
    assert.equal(white.body.latestWindowState.observedSeconds, 0);
    assert.equal(own.body.status, "elapsed_not_increasing");
    assert.equal(own.body.latestWindowState.observedSeconds, 0);

    assert.equal((await put("/api/cloud-save", saveAt(1_119, 200, 800), 3)).response.status, 200);
    white = await me("white-rate");
    own = await me("throughput");
    assert.equal(white.body.status, "valid_zero_production");
    assert.equal(white.body.latestWindowState.valid, true);
    assert.equal(white.body.latestWindowState.value, 0);
    assert.equal(white.body.latestWindowState.productionDelta, 0);
    assert.equal(white.body.latestWindowState.observedSeconds, 60);
    assert.equal(own.body.status, "ranked");
    assert.equal(own.body.latestWindowState.value, 600);
    assert.equal(own.body.latestWindowState.productionDelta, 600);

    assert.equal((await put("/api/cloud-save", saveAt(1_179, 800, 800), 4)).response.status, 200);
    white = await me("white-rate");
    own = await me("throughput");
    assert.equal(white.body.status, "ranked");
    assert.equal(white.body.latestWindowState.value, 600);
    assert.equal(own.body.status, "ranked");
    assert.equal(own.body.latestWindowState.value, 600, "white-matrix production is part of actual total throughput");
    assert.equal(own.body.latestCloudRevision, 5);

    assert.equal((await put("/api/cloud-save?slot=1&mode=normal", saveAt(9_999, 900_000, 900_000), 1)).response.status, 200);
    assert.equal((await put("/api/cloud-save?slot=main&mode=speedrun", speedrunAt(9_999, 900_000, 900_000), 1)).response.status, 200);
    own = await me("throughput");
    assert.equal(own.body.latestCloudRevision, 5, "normal manual and speedrun main revisions must not replace the ordinary main window");
    assert.equal(own.body.latestWindowState.fromRevision, 4);
    assert.equal(own.body.latestWindowState.toRevision, 5);
    assert.equal(own.body.serverMetrics.peakThroughputPerMinute, 600);

    const ownSubmissionKey = `season_01:${userId}`;
    const ownSubmission = isolatedServer.store.data.submissions[ownSubmissionKey];
    assert.equal(Object.hasOwn(ownSubmission.verification, "windowDiagnosticsVersion"), false);
    assert.equal(Object.hasOwn(ownSubmission.verification, "windows"), false);
    assert.equal(Object.hasOwn(ownSubmission.verification, "whiteMatrixWindow"), false);
    for (let index = 0; index < 149; index += 1) {
      const syntheticUserId = `synthetic_rank_${String(index).padStart(3, "0")}`;
      isolatedServer.store.data.users[syntheticUserId] = {
        ...registered.body.user,
        id: syntheticUserId,
        username: syntheticUserId,
        displayName: `合成排名 ${index}`,
        leaderboardVisible: true,
      };
      isolatedServer.store.data.submissions[`season_01:${syntheticUserId}`] = {
        ...ownSubmission,
        userId: syntheticUserId,
        accountId: syntheticUserId,
        displayName: `合成排名 ${index}`,
        metrics: { ...ownSubmission.metrics, peakThroughputPerMinute: 10_000 + index },
      };
    }
    const cloudSaveBeforeRead = structuredClone(isolatedServer.store.data.cloudSaves[userId]);
    const submissionBeforeRead = structuredClone(isolatedServer.store.data.submissions[ownSubmissionKey]);
    const outsideTop = await ranking("throughput", true);
    assert.equal(outsideTop.response.status, 200);
    assert.equal(outsideTop.body.entries.length, 100);
    assert.equal(outsideTop.body.entries.some((entry) => entry.userId === userId), false);
    for (const privateField of ["status", "entry", "rank", "totalEntries", "serverMetrics", "latestWindowState"]) {
      assert.equal(Object.hasOwn(outsideTop.body, privateField), false, `public leaderboard must not expose private field ${privateField}`);
    }
    own = await me("throughput");
    assert.equal(own.response.status, 200);
    assert.match(own.response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(own.body.status, "ranked");
    assert.equal(own.body.entry.userId, registered.body.user.leaderboardPublicId);
    assert.notEqual(own.body.entry.userId, userId, "authenticated leaderboard responses also use the stable public alias");
    assert.equal(own.body.rank, 150);
    assert.equal(own.body.entry.rank, 150);
    assert.equal(own.body.totalEntries, 150);
    assert.equal(own.body.serverMetrics.peakThroughputPerMinute, 600);
    assert.equal(own.body.mode, "normal");
    assert.equal(own.body.slot, "main");
    assert.deepEqual(isolatedServer.store.data.cloudSaves[userId], cloudSaveBeforeRead, "/me must not rewrite the cloud save");
    assert.deepEqual(isolatedServer.store.data.submissions[ownSubmissionKey], submissionBeforeRead, "/me must not rewrite the existing submission");

    const hidden = await isolatedRequest("/api/leaderboard/visibility", { method: "POST", headers, body: JSON.stringify({ visible: false }) });
    assert.equal(hidden.response.status, 200);
    own = await me("throughput");
    assert.equal(own.body.status, "hidden");
    assert.equal(own.body.entry, null);
    assert.equal(own.body.rank, null);
    const visible = await isolatedRequest("/api/leaderboard/visibility", { method: "POST", headers, body: JSON.stringify({ visible: true }) });
    assert.equal(visible.response.status, 200);

    isolatedServer.store.data.accountControls[userId] = { leaderboardResumeAfterRevisionByMode: { normal: 5 } };
    own = await me("throughput");
    assert.equal(own.body.status, "revalidation_required");
    assert.equal(own.body.reviewResumeAfterRevision, 5);
    assert.equal(own.body.entry, null);

    isolatedServer.store.data.leaderboardModeration[userId] = { status: "blocked", reasonCode: "SAVE_DATA_INTEGRITY", source: "synthetic-test", createdAt: Date.now() };
    own = await me("throughput");
    assert.equal(own.body.status, "restricted");
    assert.equal(own.body.entry, null);
    assert.equal(own.body.rank, null);
  } finally {
    if (isolatedServer?.listening) await new Promise((resolve) => isolatedServer.close(resolve));
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("backfills existing main cloud saves when the service starts", async () => {
  const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "dsp-leaderboard-backfill-"));
  const databaseFile = path.join(isolatedDirectory, "cloud.sqlite");
  let isolatedServer;
  try {
    isolatedServer = await createCloudServer({ databaseFile, registrationLimit: 10, mailer: null, logger: { error() {} } });
    await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
    let isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
    const registeredResponse = await fetch(`${isolatedBaseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "backfill_pilot", password: "strong-pass-123", displayName: "回填工程师" }),
    });
    const registered = await registeredResponse.json();
    const savedResponse = await fetch(`${isolatedBaseUrl}/api/cloud-save`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${registered.token}` },
      body: JSON.stringify({ payload: cloudPayload, expectedRevision: 0 }),
    });
    assert.equal(savedResponse.status, 200);
    delete isolatedServer.store.data.submissions[`season_01:${registered.user.id}`];
    await isolatedServer.store.persist();
    await new Promise((resolve) => isolatedServer.close(resolve));

    isolatedServer = await createCloudServer({ databaseFile, registrationLimit: 10, mailer: null, logger: { error() {} } });
    assert.equal(isolatedServer.leaderboardBackfill.created, 1);
    await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
    isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
    const rankingResponse = await fetch(`${isolatedBaseUrl}/api/leaderboard?category=galaxy&seasonId=season_01`);
    const ranking = await rankingResponse.json();
    assert.equal(ranking.entries.length, 1);
    assert.equal(ranking.entries[0].displayName, "回填工程师");
  } finally {
    if (isolatedServer?.listening) await new Promise((resolve) => isolatedServer.close(resolve));
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("keeps leaderboard-restricted accounts out of every ranking path without touching cloud saves", async () => {
  const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "dsp-leaderboard-restricted-"));
  const databaseFile = path.join(isolatedDirectory, "cloud.sqlite");
  let isolatedServer;
  try {
    const start = async () => {
      isolatedServer = await createCloudServer({ databaseFile, registrationLimit: 10, mailer: null, logger: { error() {} } });
      await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${isolatedServer.address().port}`;
      const call = async (route, options = {}) => {
        const response = await fetch(`${origin}${route}`, {
          ...options,
          headers: { "content-type": "application/json", ...(options.headers || {}) },
        });
        return { response, body: await response.json() };
      };
      return { origin, call };
    };
    let runtime = await start();
    const registered = await runtime.call("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: "restricted_pilot", password: "strong-pass-123", displayName: "同名工程师" }),
    });
    const restrictedToken = registered.body.token;
    const restrictedUserId = registered.body.user.id;
    const headers = { authorization: `Bearer ${restrictedToken}` };
    const anomalousPayload = mutateSavePayload(cloudPayload, (state) => {
      state.entities = [{ id: "vein_fixture", kind: "vein", machineCount: 1, minerCount: 0 }];
    });
    const uploaded = await runtime.call("/api/cloud-save", {
      method: "PUT",
      headers,
      body: JSON.stringify({ payload: anomalousPayload, expectedRevision: 0 }),
    });
    assert.equal(uploaded.response.status, 200);
    assert.equal(uploaded.body.cloudSave.revision, 1);

    const ordinary = await runtime.call("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: "same_name_pilot", password: "strong-pass-456", displayName: "同名工程师" }),
    });
    const ordinaryHeaders = { authorization: `Bearer ${ordinary.body.token}` };
    assert.equal((await runtime.call("/api/cloud-save", {
      method: "PUT",
      headers: ordinaryHeaders,
      body: JSON.stringify({ payload: cloudPayload, expectedRevision: 0 }),
    })).response.status, 200);

    isolatedServer.store.data.leaderboardModeration[restrictedUserId] = {
      status: "blocked",
      reasonCode: "SAVE_DATA_INTEGRITY",
      source: "test-readonly-audit",
      createdAt: 100,
    };
    await isolatedServer.store.persist();

    for (const category of ["galaxy", "power", "upload", "dyson", "throughput"]) {
      const ranking = await runtime.call(`/api/leaderboard?category=${category}&seasonId=season_01`);
      assert.equal(ranking.body.entries.some((entry) => entry.userId === restrictedUserId), false);
      assert.equal(ranking.body.entries.some((entry) => entry.userId === ordinary.body.user.leaderboardPublicId), true);
    }
    const refresh = await runtime.call("/api/leaderboard", {
      method: "POST",
      headers,
      body: JSON.stringify({ seasonId: "season_01" }),
    });
    assert.equal(refresh.response.status, 403);
    assert.equal(refresh.body.code, "LEADERBOARD_RESTRICTED");
    const visibility = await runtime.call("/api/leaderboard/visibility", {
      method: "POST",
      headers,
      body: JSON.stringify({ visible: true }),
    });
    assert.equal(visibility.response.status, 403);
    assert.equal(visibility.body.code, "LEADERBOARD_RESTRICTED");

    const secondUpload = await runtime.call("/api/cloud-save", {
      method: "PUT",
      headers,
      body: JSON.stringify({ payload: anomalousPayload, expectedRevision: 1 }),
    });
    assert.equal(secondUpload.response.status, 200);
    assert.equal(secondUpload.body.cloudSave.revision, 2);
    const restored = await runtime.call("/api/cloud-save/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: 1, expectedRevision: 2 }),
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.cloudSave.revision, 3);
    const loaded = await runtime.call("/api/cloud-save", { headers });
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.body.cloudSave.revision, 3);
    const account = await runtime.call("/api/account", { headers });
    assert.equal(account.response.status, 200);
    assert.equal(Object.hasOwn(account.body, "leaderboardModeration"), false);
    assert.equal(Object.hasOwn(account.body.user, "leaderboardModeration"), false);

    await new Promise((resolve) => isolatedServer.close(resolve));
    runtime = await start();
    assert.equal(isolatedServer.leaderboardBackfill.created, 0);
    assert.equal(isolatedServer.store.data.leaderboardModeration[restrictedUserId].status, "blocked");
    for (const category of ["galaxy", "power", "upload", "dyson", "throughput"]) {
      const ranking = await runtime.call(`/api/leaderboard?category=${category}&seasonId=season_01`);
      assert.equal(ranking.body.entries.some((entry) => entry.userId === restrictedUserId), false);
    }

    const deleted = await runtime.call("/api/account/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "strong-pass-123", confirmation: "DELETE" }),
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(isolatedServer.store.data.leaderboardModeration[restrictedUserId], undefined);
  } finally {
    if (isolatedServer?.listening) await new Promise((resolve) => isolatedServer.close(resolve));
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("manages sessions and supports password change and reset", async () => {
  const secondLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "pilot@example.com", password: "strong-pass-123", deviceName: "测试手机" }),
  });
  assert.equal(secondLogin.response.status, 200);
  const secondToken = secondLogin.body.token;
  const invalidCurrentPassword = await request("/api/account/password", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword: "definitely-wrong", newPassword: "new-password-value" }),
  });
  assert.equal(invalidCurrentPassword.response.status, 401);
  assert.equal(invalidCurrentPassword.body.code, "CURRENT_PASSWORD_INVALID");
  const sessionStillValid = await request("/api/account", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(sessionStillValid.response.status, 200);

  const expiredSession = await request("/api/account", { headers: { authorization: "Bearer synthetic_expired_session_token_value_000000" } });
  assert.equal(expiredSession.response.status, 401);
  assert.equal(expiredSession.body.code, "SESSION_EXPIRED");

  const sessions = await request("/api/account/sessions", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(sessions.response.status, 200);
  assert.equal(sessions.body.sessions.length, 2);
  assert.equal(sessions.body.sessions.some((session) => session.deviceName === "测试手机" && !session.current), true);

  const secondSession = sessions.body.sessions.find((session) => session.deviceName === "测试手机");
  const revoked = await request("/api/account/sessions/revoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: secondSession.id }),
  });
  assert.equal(revoked.response.status, 200);
  const revokedAccount = await request("/api/account", { headers: { authorization: `Bearer ${secondToken}` } });
  assert.equal(revokedAccount.response.status, 401);

  const wrongPassword = await request("/api/account/password", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "changed-pass-456" }),
  });
  assert.equal(wrongPassword.response.status, 401);
  const changed = await request("/api/account/password", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword: "strong-pass-123", newPassword: "changed-pass-456" }),
  });
  assert.equal(changed.response.status, 200);
  const oldLogin = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "pilot@example.com", password: "strong-pass-123" }) });
  assert.equal(oldLogin.response.status, 401);

  const forgot = await request("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: "pilot@example.com" }) });
  assert.equal(forgot.response.status, 202);
  const resetMessage = [...mailbox].reverse().find((message) => message.kind === "reset" && message.email === "pilot@example.com");
  assert.ok(resetMessage?.actionToken);
  const previousToken = token;
  const reset = await request("/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token: resetMessage.actionToken, password: "reset-pass-789", deviceName: "重置后的设备" }),
  });
  assert.equal(reset.response.status, 200);
  assert.ok(reset.body.token);
  token = reset.body.token;
  const previousSession = await request("/api/account", { headers: { authorization: `Bearer ${previousToken}` } });
  assert.equal(previousSession.response.status, 401);
});

test("binds and verifies email for legacy accounts and only resets verified addresses", async () => {
  const created = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "legacy_pilot", password: "legacy-pass-123", displayName: "旧账号工程师" }),
  });
  assert.equal(created.response.status, 201);
  const legacyToken = created.body.token;

  const resetCountBeforeBinding = mailbox.filter((message) => message.kind === "reset" && message.email === "bound@example.com").length;
  const bound = await request("/api/account/email", {
    method: "POST",
    headers: { authorization: `Bearer ${legacyToken}` },
    body: JSON.stringify({ email: "bound@example.com" }),
  });
  assert.equal(bound.response.status, 202);
  assert.equal(bound.body.user.email, "bound@example.com");
  assert.equal(bound.body.user.emailVerified, false);

  const unverifiedForgot = await request("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: "bound@example.com" }) });
  assert.equal(unverifiedForgot.response.status, 202);
  assert.equal(mailbox.filter((message) => message.kind === "reset" && message.email === "bound@example.com").length, resetCountBeforeBinding);

  const verification = [...mailbox].reverse().find((message) => message.kind === "verify" && message.email === "bound@example.com");
  assert.ok(verification?.actionToken);
  const verified = await request("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token: verification.actionToken }) });
  assert.equal(verified.body.user.emailVerified, true);
  const verifiedForgot = await request("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: "bound@example.com" }) });
  assert.equal(verifiedForgot.response.status, 202);
  assert.equal(mailbox.filter((message) => message.kind === "reset" && message.email === "bound@example.com").length, resetCountBeforeBinding + 1);
});

test("deduplicates anonymous players and reports total, daily and online counts", async () => {
  const invalid = await request("/api/presence", { method: "POST", body: JSON.stringify({ playerId: "short" }) });
  assert.equal(invalid.response.status, 400);

  const firstId = "player_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const secondId = "player_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const first = await request("/api/presence", { method: "POST", body: JSON.stringify({ playerId: firstId }) });
  const repeated = await request("/api/presence", { method: "POST", body: JSON.stringify({ playerId: firstId }) });
  const second = await request("/api/presence", { method: "POST", body: JSON.stringify({ playerId: secondId }) });
  assert.equal(first.response.status, 202);
  assert.equal(repeated.body.players.total, 1);
  assert.equal(second.body.players.total, 2);

  const status = await request("/api/public-status");
  const metrics = await request("/api/admin/metrics", { headers: { authorization: `Bearer ${adminToken}` } });
  const today = metricDay();
  assert.deepEqual(status.body.players, { total: 2, today: 2, online: 2, onlineWindowSeconds: 120 });
  assert.equal(metrics.body.daily.find((entry) => entry.day === today).players, 2);
  assert.equal(Object.keys(server.store.data.players).every((key) => /^[a-f0-9]{64}$/.test(key)), true);
  assert.equal(JSON.stringify(server.store.data.players).includes(firstId), false);

  const oversized = await request("/api/presence", {
    method: "POST",
    body: JSON.stringify({ playerId: firstId, padding: "x".repeat(32 * 1024 * 1024) }),
  });
  assert.equal(oversized.response.status, 413);
  for (let index = 0; index < 5; index += 1) {
    const accepted = await request("/api/presence", { method: "POST", body: JSON.stringify({ playerId: firstId }) });
    assert.equal(accepted.response.status, 202);
  }
  const limited = await request("/api/presence", { method: "POST", body: JSON.stringify({ playerId: firstId }) });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get("retry-after"), "60");
});

test("persists player totals across a restart and expires stale online players", async () => {
  const restartDirectory = await mkdtemp(path.join(tmpdir(), "dsp-presence-"));
  const databaseFile = path.join(restartDirectory, "cloud.sqlite");
  let restartServer;
  try {
    restartServer = await createCloudServer({ databaseFile, playerOnlineWindowMs: 500, adminToken, logger: { error() {} } });
    await new Promise((resolve) => restartServer.listen(0, "127.0.0.1", resolve));
    let restartBaseUrl = `http://127.0.0.1:${restartServer.address().port}`;
    await fetch(`${restartBaseUrl}/api/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: "player_cccccccccccccccccccccccccccccccc" }),
    });
    await new Promise((resolve) => restartServer.close(resolve));

    restartServer = await createCloudServer({ databaseFile, playerOnlineWindowMs: 500, adminToken, logger: { error() {} } });
    await new Promise((resolve) => restartServer.listen(0, "127.0.0.1", resolve));
    restartBaseUrl = `http://127.0.0.1:${restartServer.address().port}`;
    const restored = await fetch(`${restartBaseUrl}/api/public-status`).then((response) => response.json());
    assert.equal(restored.players.total, 1);
    assert.equal(restored.players.online, 1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const expired = await fetch(`${restartBaseUrl}/api/public-status`).then((response) => response.json());
    assert.equal(expired.players.total, 1);
    assert.equal(expired.players.online, 0);
  } finally {
    if (restartServer?.listening) await new Promise((resolve) => restartServer.close(resolve));
    await rm(restartDirectory, { recursive: true, force: true });
  }
});

test("backup startup grace prevents a recovered API from immediately copying its database", async () => {
  const restartDirectory = await mkdtemp(path.join(tmpdir(), "dsp-backup-startup-grace-"));
  const backupDirectory = path.join(restartDirectory, "backups");
  await mkdir(backupDirectory, { recursive: true });
  let restartServer;
  try {
    restartServer = await createCloudServer({
      databaseFile: path.join(restartDirectory, "cloud.sqlite"),
      backupDirectory,
      backupIntervalMs: 0,
      backupStartupGraceMs: 60_000,
      historyPruneIntervalMs: 0,
      logger: { error() {} },
    });
    await new Promise((resolve) => restartServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await readdir(backupDirectory), []);
  } finally {
    if (restartServer?.listening) await new Promise((resolve) => restartServer.close(resolve));
    await rm(restartDirectory, { recursive: true, force: true });
  }
});

test("protects detailed metrics and aggregates privacy-safe visits and events", async () => {
  const publicStatus = await request("/api/public-status");
  assert.equal(publicStatus.response.status, 200);
  assert.equal("accounts" in publicStatus.body, false);
  const unauthorized = await request("/api/metrics");
  assert.equal(unauthorized.response.status, 401);

  const playerId = "player_dddddddddddddddddddddddddddddddd";
  const sessionId = "session_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const batch = {
    playerId,
    sessionId,
    sequence: 1,
    activeSeconds: 24,
    client: "desktop-web",
    source: "direct",
    events: [
      { name: "page_view", count: 1 },
      { name: "game_enter", count: 1 },
      { name: "open_recipes", count: 2 },
      { name: "perf_load_lt_1500", count: 1 },
      { name: "perf_lcp_lt_2500", count: 1 },
      { name: "perf_transfer_lt_1mb", count: 1 },
    ],
  };
  const accepted = await request("/api/analytics", { method: "POST", body: JSON.stringify(batch) });
  const duplicate = await request("/api/analytics", { method: "POST", body: JSON.stringify(batch) });
  assert.equal(accepted.response.status, 202);
  assert.equal(duplicate.body.duplicate, true);
  const rejected = await request("/api/analytics", { method: "POST", body: JSON.stringify({ ...batch, sequence: 2, events: [{ name: "raw_click_text", count: 1 }] }) });
  assert.equal(rejected.response.status, 400);

  const metrics = await request("/api/admin/metrics?days=7", { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(metrics.response.status, 200);
  assert.equal(metrics.body.timeZone, "Asia/Shanghai");
  assert.equal(metrics.body.analytics.range.pageViews, 1);
  assert.equal(metrics.body.analytics.range.gameStarts, 1);
  assert.equal(metrics.body.analytics.range.activeSeconds, 24);
  assert.equal(metrics.body.analytics.events.find((event) => event.name === "open_recipes").count, 2);
  assert.equal(metrics.body.analytics.performance.pageLoad.p75Band, "<1.5 秒");
  assert.equal(metrics.body.analytics.performance.lcp.samples, 1);
  assert.equal(metrics.body.analytics.performance.transfer.light, 1);
  assert.equal(metrics.body.backups.offsite.transported, true);
  assert.equal(metrics.body.backups.offsite.completedAt, 100);
  assert.equal(metrics.body.backups.restoreDrill.ok, true);
  assert.equal(metrics.body.infrastructure.endpoints[0].latencyMs, 12.5);
  assert.equal(metrics.body.infrastructure.disk.freeRatio, 0.8);
  assert.equal(metrics.body.audit.entries > 0, true);
  assert.equal(metrics.body.audit.recent.some((entry) => entry.action === "account.password_reset"), true);
  assert.equal(JSON.stringify(metrics.body.audit).includes("pilot@example.com"), false);
  assert.equal(JSON.stringify(server.store.data.analytics).includes(playerId), false);
  assert.equal(JSON.stringify(server.store.data.analytics).includes(sessionId), false);
});

test("migrates schema v3 data to v7 without losing accounts, saves or players", async () => {
  const migrationDirectory = await mkdtemp(path.join(tmpdir(), "dsp-schema-v3-"));
  const dataFile = path.join(migrationDirectory, "cloud.json");
  const playerHash = "a".repeat(64);
  const legacyPassword = "legacy-email-pass-123";
  const legacySalt = "00112233445566778899aabbccddeeff";
  const legacy = {
    schemaVersion: 3,
    users: { user_legacy: { id: "user_legacy", email: "legacy@example.com", displayName: "旧工程师", createdAt: 1, passwordSalt: legacySalt, passwordHash: scryptSync(legacyPassword, legacySalt, 64).toString("hex") } },
    sessions: {},
    cloudSaves: { user_legacy: { revision: 1, payload: cloudPayload, checksum: "checksum", size: cloudPayload.length, updatedAt: 2 } },
    cloudSaveHistory: {},
    submissions: {},
    players: { [playerHash]: { firstSeenAt: 1, lastSeenAt: 2, lastActiveDay: "2026-07-21" } },
    feedback: [],
    errors: [],
    dailyMetrics: { "2026-07-21": { requests: 3, errors: 0, feedback: 0, leaderboardSubmissions: 0, cloudUploads: 1, players: 1 } },
  };
  await writeFile(dataFile, JSON.stringify(legacy));
  let migrationServer;
  try {
    migrationServer = await createCloudServer({ dataFile, databaseFile: "", adminToken, logger: { error() {} } });
    await new Promise((resolve) => migrationServer.listen(0, "127.0.0.1", resolve));
    assert.equal(migrationServer.store.data.schemaVersion, 7);
    assert.equal(migrationServer.store.data.users.user_legacy.email, "legacy@example.com");
    assert.match(migrationServer.store.data.users.user_legacy.username, /^pilot_[a-f0-9]{12}$/);
    assert.equal(migrationServer.store.data.users.user_legacy.emailVerifiedAt, 1);
    assert.equal(migrationServer.store.data.users.user_legacy.passwordChangedAt, 1);
    assert.equal(migrationServer.store.data.cloudSaves.user_legacy.revision, 1);
    assert.deepEqual(migrationServer.store.data.cloudSaveSlots, {});
    assert.deepEqual(migrationServer.store.data.cloudSaveSlotHistory, {});
    assert.equal(migrationServer.store.data.players[playerHash].lastActiveDay, "2026-07-21");
    assert.deepEqual(migrationServer.store.data.analytics, { visitors: {}, sessions: {}, daily: {} });
    const migratedUsername = migrationServer.store.data.users.user_legacy.username;
    const migrationBaseUrl = `http://127.0.0.1:${migrationServer.address().port}`;
    const legacyLoginResponse = await fetch(`${migrationBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "LEGACY@example.com", password: legacyPassword }),
    });
    const legacyLogin = await legacyLoginResponse.json();
    assert.equal(legacyLoginResponse.status, 200);
    assert.equal(legacyLogin.user.username, migratedUsername);
    await migrationServer.store.persist();
    await new Promise((resolve) => migrationServer.close(resolve));

    migrationServer = await createCloudServer({ dataFile, databaseFile: "", adminToken, logger: { error() {} } });
    await new Promise((resolve) => migrationServer.listen(0, "127.0.0.1", resolve));
    assert.equal(migrationServer.store.data.schemaVersion, 7);
    assert.equal(migrationServer.store.data.users.user_legacy.username, migratedUsername);
    assert.equal(migrationServer.store.data.cloudSaveHistory.user_legacy.length, 1);
  } finally {
    if (migrationServer?.listening) await new Promise((resolve) => migrationServer.close(resolve));
    await rm(migrationDirectory, { recursive: true, force: true });
  }
});

test("splits legacy SQLite cloud payloads from app metadata without losing revisions", async () => {
  const migrationDirectory = await mkdtemp(path.join(tmpdir(), "dsp-sqlite-payload-layout-"));
  const databaseFile = path.join(migrationDirectory, "cloud.sqlite");
  const largePayload = JSON.stringify({
    ...JSON.parse(cloudPayload),
    diagnosticsPadding: "x".repeat(2 * 1024 * 1024),
  });
  const save = { revision: 1, payload: largePayload, checksum: "legacy-checksum", size: Buffer.byteLength(largePayload), updatedAt: 2 };
  const legacy = {
    schemaVersion: 7,
    users: {},
    sessions: {},
    cloudSaves: { user_legacy: save },
    cloudSaveHistory: { user_legacy: [save] },
    cloudSaveSlots: {},
    cloudSaveSlotHistory: {},
    submissions: {},
    players: {},
    feedback: [],
    errors: [],
    dailyMetrics: {},
    analytics: { visitors: {}, sessions: {}, daily: {} },
  };
  const legacyDatabase = new Database(databaseFile);
  legacyDatabase.exec("CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  legacyDatabase.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, 1)").run(JSON.stringify(legacy));
  legacyDatabase.close();

  let migrationServer;
  try {
    migrationServer = await createCloudServer({ databaseFile, logger: { error() {} } });
    await new Promise((resolve) => migrationServer.listen(0, "127.0.0.1", resolve));
    assert.equal(migrationServer.store.data.storageLayoutVersion, 2);
    assert.equal(migrationServer.store.data.cloudSaves.user_legacy.payload, undefined);
    assert.equal(migrationServer.store.data.cloudSaves.user_legacy.summary.stateVersion, 24);
    assert.equal(migrationServer.store.readCloudSavePayload("user_legacy", "main", 1), largePayload);
    assert.equal(migrationServer.store.database.prepare("SELECT count(*) AS count FROM cloud_save_payloads").get().count, 1);
    const compactState = JSON.parse(migrationServer.store.database.prepare("SELECT payload FROM app_state WHERE id = 1").get().payload);
    assert.equal(compactState.cloudSaves.user_legacy.payload, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(compactState)) < Buffer.byteLength(largePayload) / 100);
    migrationServer.store.data.dailyMetrics["2026-07-24"] = { requests: 1 };
    await migrationServer.store.persist();
    assert.equal(migrationServer.store.database.prepare("SELECT length(payload) AS size FROM cloud_save_payloads WHERE user_id = ? AND slot = ? AND revision = ?").get("user_legacy", "main", 1).size, largePayload.length);
    await new Promise((resolve) => migrationServer.close(resolve));

    migrationServer = await createCloudServer({ databaseFile, logger: { error() {} } });
    await new Promise((resolve) => migrationServer.listen(0, "127.0.0.1", resolve));
    assert.equal(migrationServer.store.data.cloudSaveHistory.user_legacy.length, 1);
    assert.equal(migrationServer.store.readCloudSavePayload("user_legacy", "main", 1), largePayload);
  } finally {
    if (migrationServer?.listening) await new Promise((resolve) => migrationServer.close(resolve));
    await rm(migrationDirectory, { recursive: true, force: true });
  }
});

test("prunes detached SQLite payload rows with the twenty-revision history window", async () => {
  const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-history-prune-"));
  let isolatedServer;
  try {
    isolatedServer = await createCloudServer({ databaseFile: path.join(isolatedDirectory, "cloud.sqlite"), registrationLimit: 100, mailer: null, logger: { error() {} } });
    await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
    const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
    const registerResponse = await fetch(`${isolatedBaseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "history_pilot", password: "strong-pass-123", displayName: "历史清理测试" }),
    });
    const registered = await registerResponse.json();
    assert.equal(registerResponse.status, 201);
    const unrelatedLarge = JSON.stringify({ directLegacy: "x".repeat(8 * 1024 * 1024) });
    const unrelatedCorruptChecksum = createHash("sha256").update("original").digest("hex");
    isolatedServer.store.database.prepare("INSERT INTO cloud_save_payloads VALUES (?, ?, ?, ?)")
      .run("unrelated_large", "main", 1, unrelatedLarge);
    isolatedServer.store.database.prepare("INSERT INTO cloud_save_payloads VALUES (?, ?, ?, ?)")
      .run("unrelated_corrupt", "main", 1, "\u001eDSPIDLE-CLOUD-PAYLOAD-ALIAS/V1/malformed");
    isolatedServer.store.database.prepare("INSERT INTO cloud_save_payload_blobs (checksum, size_bytes, payload) VALUES (?, ?, ?)")
      .run(unrelatedCorruptChecksum, Buffer.byteLength("tampered"), "tampered");
    const uploadedChecksums = [];
    for (let revision = 1; revision <= 21; revision += 1) {
      const payload = mutateSavePayload(cloudPayload, (state) => { state.totalProduced.universe_matrix = revision; });
      uploadedChecksums.push(createHash("sha256").update(payload).digest("hex"));
      const response = await fetch(`${isolatedBaseUrl}/api/cloud-save`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${registered.token}` },
        body: JSON.stringify({ payload, expectedRevision: revision - 1 }),
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(isolatedServer.store.data.cloudSaveHistory[registered.user.id].map((save) => save.revision), Array.from({ length: 20 }, (_, index) => index + 2));
    const rows = isolatedServer.store.database.prepare("SELECT revision FROM cloud_save_payloads WHERE user_id = ? AND slot = 'main' ORDER BY revision").all(registered.user.id);
    assert.deepEqual(rows.map((row) => row.revision), Array.from({ length: 20 }, (_, index) => index + 2));
    assert.equal(isolatedServer.store.database.prepare("SELECT count(*) AS count FROM cloud_save_payload_blobs WHERE checksum = ?").get(uploadedChecksums[0]).count, 0);
    assert.equal(isolatedServer.store.database.prepare("SELECT payload FROM cloud_save_payload_blobs WHERE checksum = ?").get(unrelatedCorruptChecksum).payload, "tampered");
    assert.equal(isolatedServer.store.database.prepare("SELECT length(payload) AS size FROM cloud_save_payloads WHERE user_id = 'unrelated_large'").get().size, unrelatedLarge.length);
    assert.equal(isolatedServer.store.database.prepare("SELECT payload FROM cloud_save_payloads WHERE user_id = 'unrelated_corrupt'").get().payload, "\u001eDSPIDLE-CLOUD-PAYLOAD-ALIAS/V1/malformed");
  } finally {
    if (isolatedServer?.listening) await new Promise((resolve) => isolatedServer.close(resolve));
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("rejects a structurally complete cloud save whose internal checksum is stale", async () => {
  const corrupted = JSON.parse(cloudPayload);
  corrupted.state.elapsedSeconds = 12_143;
  const rejected = await request("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ payload: JSON.stringify(corrupted), expectedRevision: 0 }),
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.code, "SAVE_INTEGRITY_INVALID");
  assert.equal(rejected.body.summary.elapsedSeconds, 12_143);
  assert.equal(rejected.body.summary.integrity, "invalid");
});

test("reports cloud save format and size failures separately", async () => {
  const malformed = await request("/api/cloud-save", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: "not-json", expectedRevision: 0 }) });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.code, "SAVE_FORMAT_INVALID");
  const oversized = "x".repeat(64 * 1024 * 1024);
  const tooLarge = await request("/api/cloud-save", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: oversized, expectedRevision: 0 }) });
  assert.equal(tooLarge.response.status, 413);
  assert.equal(tooLarge.body.code, "SAVE_SIZE_TOO_LARGE");
  assert.match(tooLarge.body.error, /体积过大/);
  assert.ok(tooLarge.body.originalBytes > tooLarge.body.payloadLimitBytes);
  assert.equal(tooLarge.body.expandedBytes, tooLarge.body.originalBytes);
  assert.ok(tooLarge.body.overBytes > 0);
});

test("accepts gzip cloud saves and rejects invalid or expanded gzip bodies", async () => {
  const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-gzip-"));
  let isolatedServer;
  try {
    isolatedServer = await createCloudServer({ databaseFile: path.join(isolatedDirectory, "cloud.sqlite"), registrationLimit: 10, mailer: null, logger: { error() {} } });
    await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
    const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
    const registeredResponse = await fetch(`${isolatedBaseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "gzip_pilot", password: "strong-pass-123", displayName: "压缩上传测试" }),
    });
    const registered = await registeredResponse.json();
    const isolatedRequest = async (route, options = {}) => {
      const response = await fetch(`${isolatedBaseUrl}${route}`, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
      return { response, body: await response.json() };
    };
  const base = JSON.parse(cloudPayload);
  const largeState = { ...base.state, padding: "repeated-cloud-save-data-".repeat(20_000) };
  const largePayload = createSavePayload(largeState);
  const compressedBody = gzipSync(Buffer.from(JSON.stringify({ payload: largePayload, expectedRevision: 0 })));
  const uploaded = await isolatedRequest("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.token}`, "content-encoding": "gzip", "content-type": "application/json" },
    body: compressedBody,
  });
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.body.cloudSave.revision, 1);

  const invalidEncoding = await isolatedRequest("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.token}`, "content-encoding": "gzip", "content-type": "application/json" },
    body: Buffer.from("not-gzip"),
  });
  assert.equal(invalidEncoding.response.status, 400);
  assert.equal(invalidEncoding.body.code, "REQUEST_ENCODING_INVALID");

  const rawFallback = await isolatedRequest("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.token}` },
    body: JSON.stringify({ payload: largePayload, expectedRevision: 1 }),
  });
  assert.equal(rawFallback.response.status, 200);
  assert.equal(rawFallback.body.cloudSave.revision, 2);

  const expandedState = { ...base.state, padding: "x".repeat(64 * 1024 * 1024) };
  const expandedBody = gzipSync(Buffer.from(JSON.stringify({ payload: createSavePayload(expandedState), expectedRevision: 2 })));
  const expanded = await isolatedRequest("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.token}`, "content-encoding": "gzip", "content-type": "application/json" },
    body: expandedBody,
  });
  assert.equal(expanded.response.status, 413);
  assert.equal(expanded.body.code, "SAVE_SIZE_TOO_LARGE");

  const decompressionBomb = await isolatedRequest("/api/cloud-save", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${registered.token}`,
      "content-encoding": "gzip",
      "content-type": "application/vnd.dspidle.save+json",
      "x-dsp-expected-revision": "2",
    },
    body: gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 0x78)),
  });
  assert.equal(decompressionBomb.response.status, 413);
  assert.equal(decompressionBomb.body.code, "REQUEST_EXPANDED_BODY_TOO_LARGE");
  assert.equal(decompressionBomb.body.expandedLimitBytes, 64 * 1024 * 1024);
  assert.ok(decompressionBomb.body.compressedBytes > 0);
  assert.equal(decompressionBomb.body.expandedBytesAtLeast, true);
  assert.ok(decompressionBomb.body.expandedBytes > decompressionBomb.body.expandedLimitBytes);
  } finally {
    if (isolatedServer?.listening) await new Promise((resolve) => isolatedServer.close(resolve));
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("accepts direct cloud payload bodies across modes and slots without rewriting bytes", async () => {
  const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-direct-body-"));
  const databaseFile = path.join(isolatedDirectory, "cloud.sqlite");
  let directServer;
  let directBaseUrl;
  const start = async () => {
    directServer = await createCloudServer({ databaseFile, registrationLimit: 10, mailer: null, logger: { error() {} } });
    await new Promise((resolve) => directServer.listen(0, "127.0.0.1", resolve));
    directBaseUrl = `http://127.0.0.1:${directServer.address().port}`;
  };
  try {
    await start();
    const registeredResponse = await fetch(`${directBaseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "direct_body_pilot", password: "strong-pass-123", displayName: "正文上传测试" }),
    });
    const registered = await registeredResponse.json();
    const normal = createModeSavePayload({ ...JSON.parse(cloudPayload).state, elapsedSeconds: 111 }, "normal", 111_000);
    const speedrun = createModeSavePayload({ ...JSON.parse(cloudPayload).state, elapsedSeconds: 222, speedrun: { rulesetVersion: "speedrun-v1", factoryId: "direct-speedrun", startedAtMs: 1, activeElapsedSeconds: 222, pausedAtMs: null, completedAtSeconds: null, milestones: { all_technologies: null, dyson_rockets_10000: null, white_matrix_1m: null } } }, "speedrun", 222_000);
    const upload = async (payload, route, expectedRevision, gzip = false) => {
      const body = gzip ? gzipSync(Buffer.from(payload)) : payload;
      const response = await fetch(`${directBaseUrl}${route}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${registered.token}`,
          "content-type": "application/vnd.dspidle.save+json",
          "x-dsp-expected-revision": String(expectedRevision),
          "x-dsp-request-id": `direct-${expectedRevision}-${gzip}`,
          ...(gzip ? { "content-encoding": "gzip" } : {}),
        },
        body,
      });
      return { response, body: await response.json() };
    };
    assert.equal((await upload(normal, "/api/cloud-save?mode=normal", 0)).response.status, 200);
    assert.equal((await upload(speedrun, "/api/cloud-save?slot=2&mode=speedrun", 0, true)).response.status, 200);
    const badRevision = await fetch(`${directBaseUrl}/api/cloud-save?mode=normal`, {
      method: "PUT",
      headers: { authorization: `Bearer ${registered.token}`, "content-type": "application/vnd.dspidle.save+json", "x-dsp-expected-revision": "-1" },
      body: normal,
    });
    assert.equal(badRevision.status, 400);
    assert.equal((await badRevision.json()).code, "EXPECTED_REVISION_INVALID");
    const invalidUtf8 = await fetch(`${directBaseUrl}/api/cloud-save?mode=normal`, {
      method: "PUT",
      headers: { authorization: `Bearer ${registered.token}`, "content-type": "application/vnd.dspidle.save+json", "x-dsp-expected-revision": "1" },
      body: Buffer.from([0xc3, 0x28]),
    });
    assert.equal(invalidUtf8.status, 400);
    assert.equal((await invalidUtf8.json()).code, "REQUEST_FORMAT_INVALID");

    const revisionBeforeInvalidBodies = (await (await fetch(`${directBaseUrl}/api/cloud-save?mode=normal`, {
      headers: { authorization: `Bearer ${registered.token}` },
    })).json()).cloudSave.revision;
    const historyBeforeInvalidBodies = (await (await fetch(`${directBaseUrl}/api/cloud-save/history?mode=normal`, {
      headers: { authorization: `Bearer ${registered.token}` },
    })).json()).history.length;
    const directHeaders = {
      authorization: `Bearer ${registered.token}`,
      "content-type": "application/vnd.dspidle.save+json",
      "x-dsp-expected-revision": String(revisionBeforeInvalidBodies),
    };
    const bomPayload = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(normal)]);
    for (const body of [bomPayload, gzipSync(bomPayload)]) {
      const response = await fetch(`${directBaseUrl}/api/cloud-save?mode=normal`, {
        method: "PUT",
        headers: { ...directHeaders, ...(body === bomPayload ? {} : { "content-encoding": "gzip" }) },
        body,
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "REQUEST_FORMAT_INVALID");
    }
    const legacyPrefix = Buffer.from(`{"payload":${JSON.stringify(normal)},"expectedRevision":${revisionBeforeInvalidBodies},"note":"`);
    const invalidLegacy = Buffer.concat([legacyPrefix, Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    for (const body of [invalidLegacy, gzipSync(invalidLegacy)]) {
      const response = await fetch(`${directBaseUrl}/api/cloud-save?mode=normal`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${registered.token}`,
          "content-type": "application/json",
          ...(body === invalidLegacy ? {} : { "content-encoding": "gzip" }),
        },
        body,
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "REQUEST_FORMAT_INVALID");
    }
    const unchangedAfterInvalidBodies = await (await fetch(`${directBaseUrl}/api/cloud-save?mode=normal`, {
      headers: { authorization: `Bearer ${registered.token}` },
    })).json();
    const historyAfterInvalidBodies = await (await fetch(`${directBaseUrl}/api/cloud-save/history?mode=normal`, {
      headers: { authorization: `Bearer ${registered.token}` },
    })).json();
    assert.equal(unchangedAfterInvalidBodies.cloudSave.revision, revisionBeforeInvalidBodies);
    assert.equal(unchangedAfterInvalidBodies.cloudSave.payload, normal);
    assert.equal(historyAfterInvalidBodies.history.length, historyBeforeInvalidBodies);

    for (const [route, expected] of [["/api/cloud-save?mode=normal", normal], ["/api/cloud-save?slot=2&mode=speedrun", speedrun]]) {
      const downloaded = await fetch(`${directBaseUrl}${route}`, { headers: { authorization: `Bearer ${registered.token}` } });
      assert.equal((await downloaded.json()).cloudSave.payload, expected);
    }
    await new Promise((resolve) => directServer.close(resolve));
    await start();
    const downloadedAfterRestart = await fetch(`${directBaseUrl}/api/cloud-save?slot=2&mode=speedrun`, { headers: { authorization: `Bearer ${registered.token}` } });
    assert.equal((await downloadedAfterRestart.json()).cloudSave.payload, speedrun);
  } finally {
    if (directServer?.listening) await new Promise((resolve) => directServer.close(resolve));
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("accepts 30 MiB direct raw, direct gzip, and worst-case escaped legacy uploads", async () => {
  const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-legacy-30m-"));
  let isolatedServer;
  try {
    isolatedServer = await createCloudServer({ databaseFile: path.join(isolatedDirectory, "cloud.sqlite"), registrationLimit: 10, mailer: null, logger: { error() {} } });
    await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
    const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
    const registeredResponse = await fetch(`${isolatedBaseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "legacy_30m_pilot", password: "strong-pass-123", displayName: "旧协议极限测试" }),
    });
    const registered = await registeredResponse.json();
    const base = JSON.parse(cloudPayload).state;
    const targetPayloadBytes = 30 * 1024 * 1024;
    let padding = "\\\"".repeat(Math.ceil((targetPayloadBytes - cloudPayload.length) / 4));
    let payload = createSavePayload({ ...base, padding });
    while (Buffer.byteLength(payload) > targetPayloadBytes) {
      padding = padding.slice(0, Math.max(0, padding.length - Math.ceil((Buffer.byteLength(payload) - targetPayloadBytes) / 2)));
      payload = createSavePayload({ ...base, padding });
    }
    while (Buffer.byteLength(payload) < targetPayloadBytes - 16) {
      padding += "x";
      payload = createSavePayload({ ...base, padding });
    }
    assert.ok(Buffer.byteLength(payload) <= targetPayloadBytes);
    assert.ok(Buffer.byteLength(payload) >= targetPayloadBytes - 16);
    const expectedChecksum = createHash("sha256").update(payload).digest("hex");
    const directUpload = async (slot, body, gzip = false) => {
      const response = await fetch(`${isolatedBaseUrl}/api/cloud-save?slot=${slot}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${registered.token}`,
          "content-type": "application/vnd.dspidle.save+json",
          "x-dsp-expected-revision": "0",
          "x-dsp-save-original-bytes": String(Buffer.byteLength(payload)),
          ...(gzip ? { "content-encoding": "gzip" } : {}),
        },
        body,
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.cloudSave.revision, 1);
      assert.equal(result.cloudSave.size, Buffer.byteLength(payload));
      assert.equal(result.cloudSave.checksum, expectedChecksum);
    };
    await directUpload("1", payload);
    await directUpload("2", gzipSync(Buffer.from(payload)), true);
    const legacyRequest = JSON.stringify({ payload, expectedRevision: 0 });
    assert.ok(Buffer.byteLength(legacyRequest) > 32 * 1024 * 1024);
    assert.ok(Buffer.byteLength(legacyRequest) <= 65 * 1024 * 1024);
    const response = await fetch(`${isolatedBaseUrl}/api/cloud-save`, {
      method: "PUT",
      headers: { authorization: `Bearer ${registered.token}`, "content-type": "application/json" },
      body: legacyRequest,
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.cloudSave.size, Buffer.byteLength(payload));
    assert.equal(body.cloudSave.checksum, expectedChecksum);
    for (const slot of ["main", "1", "2"]) {
      const route = slot === "main" ? "/api/cloud-save" : `/api/cloud-save?slot=${slot}`;
      const downloaded = await fetch(`${isolatedBaseUrl}${route}`, { headers: { authorization: `Bearer ${registered.token}` } });
      const downloadedBody = await downloaded.json();
      assert.equal(downloaded.status, 200);
      assert.equal(downloadedBody.cloudSave.payload, payload);
      assert.equal(downloadedBody.cloudSave.checksum, expectedChecksum);
      assert.equal(downloadedBody.cloudSave.size, Buffer.byteLength(payload));
    }
  } finally {
    if (isolatedServer?.listening) await new Promise((resolve) => isolatedServer.close(resolve));
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("stores revisioned cloud saves and detects conflicts", async () => {
  const saved = await request("/api/cloud-save", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: cloudPayload, expectedRevision: 0 }) });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.cloudSave.revision, 1);
  assert.equal(saved.body.cloudSave.summary.stateVersion, 24);
  assert.equal(saved.body.cloudSave.summary.savedAt, 123456);
  assert.equal(saved.body.cloudSave.summary.completedTechCount, 0);
  assert.equal(saved.body.cloudSave.summary.stateChecksum, JSON.parse(cloudPayload).checksum);
  assert.equal(saved.body.cloudSave.summary.integrity, "valid");
  const conflict = await request("/api/cloud-save", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: cloudPayload, expectedRevision: 0 }) });
  assert.equal(conflict.response.status, 409);

  const secondPayload = mutateSavePayload(cloudPayload, (state) => { state.totalProduced.universe_matrix = 12; });
  const second = await request("/api/cloud-save", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: secondPayload, expectedRevision: 1 }) });
  assert.equal(second.body.cloudSave.revision, 2);
  const history = await request("/api/cloud-save/history", { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(history.body.history.map((entry) => entry.revision), [2, 1]);
  const restored = await request("/api/cloud-save/restore", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ revision: 1, expectedRevision: 2 }) });
  assert.equal(restored.body.cloudSave.revision, 3);
  assert.equal(restored.body.cloudSave.restoredFromRevision, 1);
  const loaded = await request("/api/cloud-save", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(loaded.body.cloudSave.payload, cloudPayload);

  const exported = await request("/api/account/export", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(exported.response.status, 200);
  assert.equal(exported.body.user.email, "pilot@example.com");
  assert.equal(exported.body.cloudSave.revision, 3);
  assert.deepEqual(exported.body.cloudSaveHistory.map((entry) => entry.revision), [3, 2, 1]);
});

test("keeps main and three manual cloud slots revisioned independently", async () => {
  const slotOne = await request("/api/cloud-save?slot=1", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: cloudPayload, expectedRevision: 0 }) });
  const slotTwo = await request("/api/cloud-save?slot=2", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: mutateSavePayload(cloudPayload, (state) => { state.totalProduced.universe_matrix = 11; }), expectedRevision: 0 }) });
  assert.equal(slotOne.body.cloudSave.slot, "1");
  assert.equal(slotOne.body.cloudSave.revision, 1);
  assert.equal(slotTwo.body.cloudSave.slot, "2");
  assert.equal(slotTwo.body.cloudSave.revision, 1);

  const slotOneSecond = await request("/api/cloud-save?slot=1", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: mutateSavePayload(cloudPayload, (state) => { state.totalProduced.universe_matrix = 15; }), expectedRevision: 1 }) });
  assert.equal(slotOneSecond.body.cloudSave.revision, 2);
  const slotOneConflict = await request("/api/cloud-save?slot=1", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: cloudPayload, expectedRevision: 1 }) });
  assert.equal(slotOneConflict.response.status, 409);
  assert.equal(slotOneConflict.body.cloudSave.slot, "1");

  const account = await request("/api/account", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(account.body.cloudSaves.main.revision, 3);
  assert.equal(account.body.cloudSaves["1"].revision, 2);
  assert.equal(account.body.cloudSaves["2"].revision, 1);
  assert.equal(account.body.cloudSaves["3"], null);
  const history = await request("/api/cloud-save/history?slot=1", { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(history.body.history.map((entry) => entry.revision), [2, 1]);
  const main = await request("/api/cloud-save", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(main.body.cloudSave.revision, 3);
  const invalid = await request("/api/cloud-save?slot=invalid", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(invalid.response.status, 400);
});

test("round-trips a historical stacked unique megastructure through raw and gzip cloud slots", {
  skip: !historicalUniqueMegastructureFixturePath,
}, async () => {
  const payload = await readFile(historicalUniqueMegastructureFixturePath, "utf8");
  const source = JSON.parse(payload);
  const sourceStack = source.state?.entities?.find((entity) =>
    entity.buildingId === "time_warp_device" && entity.machineCount === 3);
  assert.ok(sourceStack, "fixture must contain the historical three-device time-warp stack");

  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "historical_stack", password: "strong-pass-123", displayName: "历史堆叠测试" }),
  });
  assert.equal(registered.response.status, 201);
  const headers = { authorization: `Bearer ${registered.body.token}` };
  const slots = [
    { route: "/api/cloud-save", gzip: false },
    { route: "/api/cloud-save?slot=1", gzip: true },
    { route: "/api/cloud-save?slot=2", gzip: false },
    { route: "/api/cloud-save?slot=3", gzip: true },
  ];
  for (const slot of slots) {
    const body = JSON.stringify({ payload, expectedRevision: 0 });
    const uploaded = await request(slot.route, {
      method: "PUT",
      headers: { ...headers, ...(slot.gzip ? { "content-encoding": "gzip" } : {}) },
      body: slot.gzip ? gzipSync(Buffer.from(body)) : body,
    });
    assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.cloudSave.revision, 1);

    const downloaded = await request(slot.route, { headers });
    assert.equal(downloaded.response.status, 200);
    assert.equal(downloaded.body.cloudSave.payload, payload);
    const roundTripped = JSON.parse(downloaded.body.cloudSave.payload);
    assert.equal(roundTripped.state.entities.find((entity) => entity.id === sourceStack.id)?.machineCount, 3);
  }
});

test("validates v32 gameplay buffer limits before accepting cloud saves", async () => {
  const payloadFor = (productionBufferLimit, logisticsBufferLimit) => createSavePayload({
      version: 32,
      entities: [],
      settings: { productionBufferLimit, logisticsBufferLimit },
  });
  for (const payload of [
    payloadFor(999, 1_000_000),
    payloadFor(1_000_000.5, 1_000_000),
    payloadFor(1_000_000, 100_000_001),
    createSavePayload({ version: 32, entities: [], settings: {} }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload, expectedRevision: 0 }) });
    assert.equal(rejected.response.status, 400);
  }
  const accepted = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: payloadFor(1_000, 100_000_000), expectedRevision: 0 }) });
  assert.equal(accepted.response.status, 200);
});

test("validates v33 proliferator and exact infinite research fields while accepting v32", async () => {
  const research = (overrides = {}) => Object.fromEntries([
    ["matrix_compression", 1_000],
    ["vein_utilization", 1_000],
    ["galactic_logistics", 1_000],
    ["stellar_harnessing", 1_000],
    ["continuum_simulation", 23],
  ].map(([id]) => [id, { level: 0, progress: "0", ...(overrides[id] ?? {}) }]));
  const payloadFor = ({ proliferatorBufferLimit = 600, infiniteResearch = research() } = {}) => createSavePayload({
      version: 33,
      entities: [],
      settings: { productionBufferLimit: 1_000_000, logisticsBufferLimit: 1_000_000, proliferatorBufferLimit },
      endgame: { infiniteResearch },
  });
  const invalidPayloads = [
    payloadFor({ proliferatorBufferLimit: 0 }),
    payloadFor({ proliferatorBufferLimit: 100_000_001 }),
    payloadFor({ infiniteResearch: research({ matrix_compression: { level: 1_001 } }) }),
    payloadFor({ infiniteResearch: research({ continuum_simulation: { level: 24 } }) }),
    payloadFor({ infiniteResearch: research({ matrix_compression: { progress: "01" } }) }),
    payloadFor({ infiniteResearch: research({ matrix_compression: { progress: `1${"0".repeat(64)}` } }) }),
    payloadFor({ infiniteResearch: research({ matrix_compression: { level: 5, historicalLevel: 4 } }) }),
  ];
  for (const payload of invalidPayloads) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload, expectedRevision: 1 }) });
    assert.equal(rejected.response.status, 400);
  }
  const valid = payloadFor({
    proliferatorBufferLimit: 100_000_000,
    infiniteResearch: research({ matrix_compression: { level: 1_000, historicalLevel: 1_125, progress: "31441647386989570364354250" } }),
  });
  const accepted = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: valid, expectedRevision: 1 }) });
  assert.equal(accepted.response.status, 200);
});

test("validates v34 time warp and accepts Android v35 through current v46 saves", async () => {
  const research = Object.fromEntries([
    ["matrix_compression", 1_000],
    ["vein_utilization", 1_000],
    ["galactic_logistics", 1_000],
    ["stellar_harnessing", 1_000],
    ["continuum_simulation", 23],
  ].map(([id]) => [id, { level: 0, progress: "0" }]));
  const baseState = {
    version: 34,
    settings: { productionBufferLimit: 1_000_000, logisticsBufferLimit: 1_000_000, proliferatorBufferLimit: 600 },
    entities: [
      { id: "black-hole", buildingId: "micro_black_hole_connector", machineCount: 1, blackHolePaused: true, blackHoleActivationConfirmed: false, blackHolePorts: [0, 1, 2].map((index) => ({ index, totalDestroyed: "0" })) },
      { id: "time-warp", buildingId: "time_warp_device", machineCount: 1 },
      { id: "source", buildingId: "storage_mk1", machineCount: 1 },
    ],
    belts: [{ id: "belt-1", source: "source", target: "black-hole", targetPortIndex: 0 }],
    dysonPlans: { helios: { layers: [{ structureAllocationFloor: 0, shellAllocationFloor: 0 }] } },
    timeWarp: { controllerEntityId: "time-warp", enabled: true, requestedMultiplier: 5, effectiveMultiplier: 4, pendingSimulationSeconds: 0, pendingWallSeconds: 0, requiredPowerKw: 100_000, allocatedPowerKw: 100_000 },
    endgame: { infiniteResearch: research },
  };
  const payloadFor = (mutate = () => {}) => {
    const state = structuredClone(baseState);
    mutate(state);
    return createSavePayload(state);
  };
  const invalidPayloads = [
    payloadFor((state) => { state.timeWarp.requestedMultiplier = 4; }),
    payloadFor((state) => { state.timeWarp.pendingSimulationSeconds = 30 * 24 * 60 * 60 + 1; }),
    payloadFor((state) => { state.timeWarp.controllerEntityId = "missing"; }),
    payloadFor((state) => { state.dysonPlans.helios.layers[0].structureAllocationFloor = -1; }),
    payloadFor((state) => { state.entities[0].blackHolePorts[0].totalDestroyed = "01"; }),
    payloadFor((state) => { state.entities[0].machineCount = 0; }),
    payloadFor((state) => { state.entities[1].machineCount = 0; }),
    payloadFor((state) => { state.entities[0].machineCount = 1.5; }),
    payloadFor((state) => { state.entities[1].machineCount = Number.MAX_SAFE_INTEGER + 1; }),
    payloadFor((state) => { state.belts.push({ id: "belt-2", source: "source", target: "black-hole", targetPortIndex: 0 }); }),
    payloadFor((state) => { state.belts[0].targetPortIndex = 3; }),
  ];
  for (const payload of invalidPayloads) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload, expectedRevision: 2 }) });
    assert.equal(rejected.response.status, 400);
  }
  const historicalStackPayload = payloadFor((state) => {
    state.entities[0].machineCount = 2;
    state.entities[1].machineCount = 3;
  });
  const accepted = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: historicalStackPayload, expectedRevision: 2 }) });
  assert.equal(accepted.response.status, 200);

  const v35Payload = payloadFor((state) => {
    state.version = 35;
    state.planetTrayItemLimits = { home: 100_000_000, extension_planet: 1_000 };
    for (const entity of state.entities) entity.interactionLocked = false;
    state.entities[2].interactionLocked = true;
  });
  const acceptedV35 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v35Payload, expectedRevision: 3 }) });
  assert.equal(acceptedV35.response.status, 200);
  for (const invalid of [
    payloadFor((state) => { state.version = 35; state.entities.forEach((entity) => { entity.interactionLocked = false; }); state.entities[0].interactionLocked = "false"; }),
    payloadFor((state) => { state.planetTrayItemLimits = { home: 100_000_001 }; }),
    payloadFor((state) => { state.planetTrayItemLimits = { home: 1_000.5 }; }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalid, expectedRevision: 4 }) });
    assert.equal(rejected.response.status, 400);
  }
  const v36Payload = payloadFor((state) => {
    state.version = 36;
    state.planetTrayItemLimits = { home: 100_000_000 };
    for (const entity of state.entities) entity.interactionLocked = false;
    state.constructionAutomation = {
      enabled: true,
      targetStock: { logistics_vessel: 4 },
      cursor: 0,
      totalCrafted: 0,
      lastCraftedId: null,
      jobs: {},
    };
  });
  const acceptedV36 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v36Payload, expectedRevision: 4 }) });
  assert.equal(acceptedV36.response.status, 200);
  const v37Payload = payloadFor((state) => {
    state.version = 37;
    state.planetTrayItemLimits = { home: 100_000_000 };
    for (const entity of state.entities) entity.interactionLocked = false;
    state.entities.push({ id: "vein", kind: "vein", resourceId: "iron_ore", interactionLocked: false, resourceDepletionRemainder: 9 });
  });
  const acceptedV37 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v37Payload, expectedRevision: 5 }) });
  assert.equal(acceptedV37.response.status, 200);
  const invalidV37 = payloadFor((state) => {
    state.version = 37;
    state.entities.push({ id: "vein", kind: "vein", resourceId: "iron_ore", interactionLocked: false, resourceDepletionRemainder: 10 });
  });
  const rejectedV37 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalidV37, expectedRevision: 6 }) });
  assert.equal(rejectedV37.response.status, 400);

  const v38Payload = payloadFor((state) => {
    state.version = 38;
    state.planetTrayItemLimits = { home: 100_000_000 };
    for (const entity of state.entities) entity.interactionLocked = false;
    state.belts[0].lanes = 4_096;
    state.constructionAutomation = {
      enabled: true,
      targetStock: {},
      cursor: 0,
      totalCrafted: 0,
      lastCraftedId: null,
      destroyedByproducts: { hydrogen: 17 },
      jobs: {},
    };
    state.blueprints = [{
      id: "blueprint_1",
      name: "采矿布局",
      entities: [{ key: "node_1" }],
      resourceAnchors: [{ key: "resource_1", resourceId: "iron_ore", extractorBuildingId: "mining_machine", minerCount: 3, offset: { x: 0, y: 0 } }],
      belts: [{ key: "line_1", sourceKey: "resource_1", targetKey: "node_1", lanes: 4_096 }],
    }];
  });
  const acceptedV38 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v38Payload, expectedRevision: 6 }) });
  assert.equal(acceptedV38.response.status, 200);
  for (const invalid of [
    payloadFor((state) => { const parsed = JSON.parse(v38Payload); Object.assign(state, parsed.state); state.belts[0].lanes = 4_097; }),
    payloadFor((state) => { const parsed = JSON.parse(v38Payload); Object.assign(state, parsed.state); state.constructionAutomation.destroyedByproducts.hydrogen = -1; }),
    payloadFor((state) => { const parsed = JSON.parse(v38Payload); Object.assign(state, parsed.state); state.blueprints[0].resourceAnchors[0].minerCount = 0; }),
    payloadFor((state) => { const parsed = JSON.parse(v38Payload); Object.assign(state, parsed.state); state.blueprints[0].belts[0].lanes = 4_097; }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalid, expectedRevision: 7 }) });
    assert.equal(rejected.response.status, 400);
  }

  const v39PayloadFor = (mutate = () => {}) => payloadFor((state) => {
    const parsed = JSON.parse(v38Payload);
    Object.assign(state, parsed.state);
    state.version = 39;
    state.entities.push({
      id: "delivery-hub",
      buildingId: "material_delivery_hub",
      machineCount: 1,
      interactionLocked: false,
      deliveryItemIds: ["iron_ore"],
      deliverySlots: [
        { itemId: "iron_ore", mode: "auto" },
        { itemId: "copper_ore", mode: "manual" },
        { itemId: null, mode: "disabled" },
      ],
    });
    state.belts.push({ id: "delivery-line", source: "source", target: "delivery-hub", itemId: "iron_ore", lanes: 1, targetPortIndex: 0 });
    mutate(state);
  });
  for (const invalid of [
    v39PayloadFor((state) => { state.entities.at(-1).deliverySlots.pop(); }),
    v39PayloadFor((state) => { state.entities.at(-1).deliverySlots[1].itemId = null; }),
    v39PayloadFor((state) => { state.entities.at(-1).deliverySlots[2] = { itemId: "stone", mode: "disabled" }; }),
    v39PayloadFor((state) => { state.belts.at(-1).targetPortIndex = 2; }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalid, expectedRevision: 7 }) });
    assert.equal(rejected.response.status, 400);
  }
  const acceptedV39 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v39PayloadFor(), expectedRevision: 7 }) });
  assert.equal(acceptedV39.response.status, 200);

  const v40PayloadFor = (mutate = () => {}) => payloadFor((state) => {
    Object.assign(state, JSON.parse(v39PayloadFor()).state);
    state.version = 40;
    state.settings.beltBufferLimit = 100_000_000;
    state.contentPacks = [];
    for (const belt of state.belts) {
      belt.tier ??= 1;
      belt.progress ??= 0;
    }
    mutate(state);
  });
  for (const invalid of [
    v40PayloadFor((state) => { state.settings.beltBufferLimit = 100_000_001; }),
    v40PayloadFor((state) => { state.belts[0].progress = 100_000_001; }),
    v40PayloadFor((state) => { state.belts[0].tier = 33; }),
    v40PayloadFor((state) => { state.contentPacks = [{ id: "Invalid-Pack", version: "1.0.0" }]; }),
    v40PayloadFor((state) => { state.contentPacks = [{ id: "factory_pack", version: "latest" }]; }),
    v40PayloadFor((state) => { state.contentPacks = [{ id: "factory_pack", version: `1.0.0-${"a".repeat(40)}` }]; }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalid, expectedRevision: 8 }) });
    assert.equal(rejected.response.status, 400);
  }
  const acceptedV40 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v40PayloadFor(), expectedRevision: 8 }) });
  assert.equal(acceptedV40.response.status, 200);

  const v41PayloadFor = (mutate = () => {}) => payloadFor((state) => {
    Object.assign(state, JSON.parse(v40PayloadFor()).state);
    state.version = 41;
    state.entities.push({
      id: "rail-ejector",
      kind: "machine",
      planetId: "home",
      buildingId: "em_rail_ejector",
      machineCount: 1,
      interactionLocked: false,
      targetDysonOrbitId: "dyson_orbit_helios_1",
    });
    state.blueprints.push({
      id: "ejector-blueprint",
      name: "定轨弹射器",
      entities: [{ key: "ejector", buildingId: "em_rail_ejector", targetDysonOrbitId: "dyson_orbit_helios_1" }],
      belts: [],
    });
    mutate(state);
  });
  for (const invalid of [
    v41PayloadFor((state) => { delete state.entities.at(-1).targetDysonOrbitId; }),
    v41PayloadFor((state) => { state.entities.at(-1).targetDysonOrbitId = "x".repeat(161); }),
    v41PayloadFor((state) => { state.blueprints.at(-1).entities[0].targetDysonOrbitId = "x".repeat(161); }),
    v41PayloadFor((state) => { state.blueprints.at(-1).entities[0].buildingId = "storage_mk1"; }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalid, expectedRevision: 9 }) });
    assert.equal(rejected.response.status, 400);
  }
  const acceptedV41 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v41PayloadFor(), expectedRevision: 9 }) });
  assert.equal(acceptedV41.response.status, 200);

  const v42PayloadFor = (mutate = () => {}) => payloadFor((state) => {
    Object.assign(state, JSON.parse(v41PayloadFor()).state);
    state.version = 42;
    state.galaxy = {
      planetMetadata: { home: { customName: "母星生产区", note: "主产线", tags: ["出口"] } },
      systemMetadata: { helios: { customName: "曙光庭" } },
    };
    mutate(state);
  });
  for (const invalid of [
    v42PayloadFor((state) => { state.galaxy.planetMetadata.home.tags = Array(9).fill("tag"); }),
    v42PayloadFor((state) => { state.galaxy.planetMetadata.home.note = "x".repeat(241); }),
    v42PayloadFor((state) => { state.galaxy.systemMetadata.helios.customName = ""; }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalid, expectedRevision: 10 }) });
    assert.equal(rejected.response.status, 400);
  }
  const acceptedV42 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v42PayloadFor(), expectedRevision: 10 }) });
  assert.equal(acceptedV42.response.status, 200);

  const v43PayloadFor = (mutate = () => {}) => payloadFor((state) => {
    Object.assign(state, JSON.parse(v42PayloadFor()).state);
    state.version = 43;
    state.systemSpaceStations = {
      helios: {
        systemId: "helios",
        status: "operational",
        costRevision: 1,
        costMultiplierBasisPoints: 10_000,
        phaseIndex: 16,
        delivered: { titanium_alloy: "1000000" },
        inventory: { iron_ingot: "100000000000000000000" },
        itemPolicies: { iron_ingot: { interstellarEnabled: true, reserve: "0", target: "1000" } },
        modules: { backbone: 0, energy: 0, interstellar: 1 },
        routingCursors: { iron_ingot: 3 },
        viewport: { x: 0, y: 0, zoom: 0.85 },
        decorations: [],
      },
    };
    state.galacticHubNetwork = { fleetInstalled: 10, fleetBusy: 2, fleetReturns: [{ routeKey: "helios->borealis:iron_ingot", returnAtSecond: 30, vesselCount: 2 }], warpers: "100000000000000000000", warperTarget: "200", routingCursors: {} };
    mutate(state);
  });
  const acceptedV43 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v43PayloadFor(), expectedRevision: 11 }) });
  assert.equal(acceptedV43.response.status, 200);
  for (const invalid of [
    v43PayloadFor((state) => { state.systemSpaceStations.helios.inventory.iron_ingot = "01"; }),
    v43PayloadFor((state) => { state.galacticHubNetwork.fleetReturns[0].vesselCount = 0; }),
    v43PayloadFor((state) => { state.belts[0].elevatorOutputIndex = 5; }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalid, expectedRevision: 12 }) });
    assert.equal(rejected.response.status, 400);
  }

  const v44PayloadFor = (mutate = () => {}) => payloadFor((state) => {
    Object.assign(state, JSON.parse(v42PayloadFor()).state);
    state.version = 44;
    state.quantumLogisticsNetwork = {
      enabled: true,
      inventory: { iron_ore: "123" },
      routingCursors: { iron_ore: 2 },
    };
    state.entities.push({
      id: "quantum-tower",
      buildingId: "interstellar_logistics_station",
      machineCount: 1,
      interactionLocked: false,
      quantumMode: "quantum",
      quantumTransition: null,
    });
    mutate(state);
  });
  const acceptedV44 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v44PayloadFor(), expectedRevision: 12 }) });
  assert.equal(acceptedV44.response.status, 200, JSON.stringify(acceptedV44.body));
  for (const invalid of [
    v44PayloadFor((state) => { state.quantumLogisticsNetwork.inventory.iron_ore = "01"; }),
    v44PayloadFor((state) => { state.quantumLogisticsNetwork.routingCursors.iron_ore = -1; }),
    v44PayloadFor((state) => { state.entities.at(-1).quantumMode = "instant"; }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalid, expectedRevision: 13 }) });
    assert.equal(rejected.response.status, 400);
  }

  const v45PayloadFor = (mutate = () => {}) => payloadFor((state) => {
    Object.assign(state, JSON.parse(v44PayloadFor()).state);
    state.version = 45;
    state.quantumLogisticsNetwork.itemCapacities = { iron_ore: "10000000000" };
    state.quantumLogisticsNetwork.uploadRoutingCursors = { iron_ore: 1 };
    state.entities.push({
      id: "quantum-collector",
      buildingId: "orbital_collector",
      machineCount: 10,
      interactionLocked: false,
      quantumMode: "legacy",
      quantumTransition: null,
    });
    mutate(state);
  });
  const acceptedV45 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v45PayloadFor(), expectedRevision: 13 }) });
  assert.equal(acceptedV45.response.status, 200, JSON.stringify(acceptedV45.body));
  for (const invalid of [
    v45PayloadFor((state) => { state.quantumLogisticsNetwork.itemCapacities.iron_ore = "9999"; }),
    v45PayloadFor((state) => { state.quantumLogisticsNetwork.itemCapacities.iron_ore = "10000000001"; }),
    v45PayloadFor((state) => { state.quantumLogisticsNetwork.itemCapacities.iron_ore = "1e6"; }),
    v45PayloadFor((state) => { state.quantumLogisticsNetwork.uploadRoutingCursors.iron_ore = -1; }),
    v45PayloadFor((state) => { state.quantumLogisticsNetwork.runtimeFlow = {}; }),
    v45PayloadFor((state) => { delete state.entities.at(-1).quantumMode; }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalid, expectedRevision: 14 }) });
    assert.equal(rejected.response.status, 400);
  }

  const v46PayloadFor = (mutate = () => {}) => payloadFor((state) => {
    Object.assign(state, JSON.parse(v45PayloadFor()).state);
    state.version = 46;
    const definition = {
      id: "queued_factory",
      name: "待建工厂",
      revision: 3,
      entities: [{ key: "storage", buildingId: "storage_mk1", offset: { x: 0, y: 0 }, machineCount: 400_000 }],
      resourceAnchors: [],
      belts: [],
      externalPorts: [],
      rotation: 0,
      mirror: "none",
      recipeOverrides: {},
    };
    state.blueprints = [structuredClone(definition)];
    state.blueprintVersions = [{ id: "queued_factory@3", blueprintId: "queued_factory", revision: 3, definition: structuredClone(definition) }];
    state.constructionQueue = [{
      id: "construction_1",
      blueprintId: "queued_factory",
      blueprintVersionId: "queued_factory@3",
      blueprintRevision: 3,
      blueprintName: "待建工厂",
      planetId: "home",
      position: { x: 100, y: 200 },
      rotation: 0,
      mirror: "none",
      queuedAt: 123,
      status: "pending-materials",
      reservedConstruction: { storage_mk1: 120_000 },
      reservedFleet: {},
      placedEntityIdsByKey: {},
    }];
    mutate(state);
  });
  const acceptedV46 = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: v46PayloadFor(), expectedRevision: 14 }) });
  assert.equal(acceptedV46.response.status, 200, JSON.stringify(acceptedV46.body));
  const legacyQuantumTarget = v46PayloadFor((state) => {
    state.blueprints[0].entities[0].quantumTarget = false;
    state.blueprintVersions[0].definition.entities[0].quantumTarget = false;
  });
  const acceptedLegacyQuantumTarget = await request("/api/cloud-save?slot=3", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ payload: legacyQuantumTarget, expectedRevision: 15 }),
  });
  assert.equal(acceptedLegacyQuantumTarget.response.status, 200, JSON.stringify(acceptedLegacyQuantumTarget.body));
  const historicalOversizedStacks = v46PayloadFor((state) => {
    state.entities[2].machineCount = 100_000_001;
    state.blueprints[0].entities[0].machineCount = 100_000_002;
    state.blueprintVersions[0].definition.entities[0].machineCount = 100_000_003;
  });
  const acceptedHistoricalOversizedStacks = await request("/api/cloud-save?slot=3", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ payload: historicalOversizedStacks, expectedRevision: 16 }),
  });
  assert.equal(acceptedHistoricalOversizedStacks.response.status, 200, JSON.stringify(acceptedHistoricalOversizedStacks.body));
  const exactOverlapQueueIntent = v46PayloadFor((state) => {
    state.constructionQueue[0].allowExactOverlap = true;
  });
  const acceptedExactOverlapQueueIntent = await request("/api/cloud-save?slot=3", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ payload: exactOverlapQueueIntent, expectedRevision: 17 }),
  });
  assert.equal(acceptedExactOverlapQueueIntent.response.status, 200, JSON.stringify(acceptedExactOverlapQueueIntent.body));
  for (const invalid of [
    v46PayloadFor((state) => { state.entities[2].machineCount = Number.MAX_SAFE_INTEGER + 1; }),
    v46PayloadFor((state) => { state.blueprints[0].entities[0].machineCount = Number.MAX_SAFE_INTEGER + 1; }),
    v46PayloadFor((state) => { state.blueprints[0].entities[0].quantumTarget = true; }),
    v46PayloadFor((state) => { state.constructionQueue[0].blueprintVersionId = "missing@1"; }),
    v46PayloadFor((state) => { state.constructionQueue[0].reservedConstruction.storage_mk1 = -1; }),
    v46PayloadFor((state) => { state.constructionQueue[0].status = "waiting-fleet"; state.constructionQueue[0].buildingCompletedAt = 123; }),
  ]) {
    const rejected = await request("/api/cloud-save?slot=3", { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ payload: invalid, expectedRevision: 18 }) });
    assert.equal(rejected.response.status, 400);
  }
});

test("accepts declarative content-pack cloud saves but excludes them from official ranking", async () => {
  const registered = await request("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "modded_pilot", password: "strong-pass-456", displayName: "内容包玩家" }) });
  assert.equal(registered.response.status, 201);
  const modToken = registered.body.token;
  const payload = createSavePayload({
    version: 40,
    elapsedSeconds: 7_200,
    entities: [],
    belts: [],
    settings: { productionBufferLimit: 1_000_000, logisticsBufferLimit: 1_000_000, beltBufferLimit: 100_000_000, proliferatorBufferLimit: 600 },
    contentPacks: [{ id: "community_factory", version: "1.2.3" }],
    totalProduced: { universe_matrix: 999 },
    constructionAutomation: { destroyedByproducts: {} },
    blueprints: [],
    dysonPlans: {},
    timeWarp: { controllerEntityId: null, enabled: false, requestedMultiplier: 5, effectiveMultiplier: 1, pendingSimulationSeconds: 0, pendingWallSeconds: 0, requiredPowerKw: 0, allocatedPowerKw: 0 },
    endgame: { infiniteResearch: Object.fromEntries(["matrix_compression", "vein_utilization", "galactic_logistics", "stellar_harnessing", "continuum_simulation"].map((id) => [id, { level: 0, progress: "0" }])) },
  });
  const uploaded = await request("/api/cloud-save", { method: "PUT", headers: { authorization: `Bearer ${modToken}` }, body: JSON.stringify({ payload, expectedRevision: 0 }) });
  assert.equal(uploaded.response.status, 200);
  const refreshed = await request("/api/leaderboard", { method: "POST", headers: { authorization: `Bearer ${modToken}` }, body: JSON.stringify({ seasonId: "season_01" }) });
  assert.equal(refreshed.response.status, 422);
  assert.match(refreshed.body.error, /内容包/);
  const leaderboard = await request("/api/leaderboard?category=galaxy&seasonId=season_01");
  assert.equal(leaderboard.body.entries.some((entry) => entry.displayName === "内容包玩家"), false);
});

test("recalculates leaderboard score on the server", async () => {
  const refreshed = await request("/api/leaderboard", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ seasonId: "season_01", metrics: { energyGeneratedMj: 1_000_000, uploadedWhiteMatrix: 1_000_000 } }),
  });
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.submission.metrics.uploadedWhiteMatrix, 12);
  assert.equal(refreshed.body.submission.metrics.galaxyScore, 12_145);

  const hidden = await request("/api/leaderboard/visibility", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ visible: false }),
  });
  assert.equal(hidden.response.status, 200);
  assert.equal(hidden.body.user.leaderboardVisible, false);
  let ranking = await request("/api/leaderboard?category=galaxy&seasonId=season_01");
  assert.equal(ranking.body.entries.some((entry) => entry.userId === hidden.body.user.leaderboardPublicId), false);

  const fourthPayload = mutateSavePayload(cloudPayload, (state) => { state.totalProduced.universe_matrix = 20; });
  const uploadedWhileHidden = await request("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ payload: fourthPayload, expectedRevision: 3 }),
  });
  assert.equal(uploadedWhileHidden.response.status, 200);
  ranking = await request("/api/leaderboard?category=galaxy&seasonId=season_01");
  assert.equal(ranking.body.entries.some((entry) => entry.userId === hidden.body.user.leaderboardPublicId), false);

  const visible = await request("/api/leaderboard/visibility", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ visible: true }),
  });
  assert.equal(visible.response.status, 200);
  assert.equal(visible.body.autoJoined, true);
  assert.equal(visible.body.submission.metrics.uploadedWhiteMatrix, 20);
  ranking = await request("/api/leaderboard?category=galaxy&seasonId=season_01");
  assert.equal(ranking.body.entries[0].verified, true);
});

test("keeps server-derived leaderboard values above the former metric cap", async () => {
  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "uncapped_rank", password: "rank-pass-123", displayName: "超大工厂" }),
  });
  assert.equal(registered.response.status, 201);
  const payload = createSavePayload({
    version: 24,
    elapsedSeconds: 1_000,
    entities: [],
    totalProduced: { universe_matrix: 10 },
    metrics: { generationKw: 2_500_000_000_000_000, totalItemsPerMinute: 1_500_000_000_000_000, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  });
  const uploaded = await request("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.body.token}` },
    body: JSON.stringify({ payload, expectedRevision: 0 }),
  });
  assert.equal(uploaded.response.status, 200);
  let ranking = await request("/api/leaderboard?category=throughput&seasonId=season_01");
  let entry = ranking.body.entries.find((candidate) => candidate.displayName === "超大工厂");
  assert.equal(entry.metrics.energyGeneratedMj, 2_500_000_000_000_000);
  assert.equal(entry.metrics.peakThroughputPerMinute, 0);
  assert.equal(entry.metrics.theoreticalPeakThroughputPerMinute, 1_500_000_000_000_000);
  assert.equal(Object.hasOwn(entry, "verification"), false, "public leaderboard must omit private verification internals");

  const nextPayload = mutateSavePayload(payload, (state) => {
    state.elapsedSeconds += 60;
    state.totalProduced.iron_ingot = 1_500_000_000_000_000;
  });
  assert.equal((await request("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.body.token}` },
    body: JSON.stringify({ payload: nextPayload, expectedRevision: 1 }),
  })).response.status, 200);
  ranking = await request("/api/leaderboard?category=throughput&seasonId=season_01");
  entry = ranking.body.entries.find((candidate) => candidate.displayName === "超大工厂");
  assert.equal(entry.metrics.peakThroughputPerMinute, 1_500_000_000_000_000);
  assert.equal(entry.metrics.theoreticalPeakThroughputPerMinute, 1_500_000_000_000_000);
  assert.equal(Object.hasOwn(entry, "verification"), false);
});

test("uses all explicit planet metrics for nominal throughput regardless of the active planet", async () => {
  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "galactic_nominal", password: "rank-pass-123", displayName: "全星区口径" }),
  });
  const headers = { authorization: `Bearer ${registered.body.token}` };
  const payload = createSavePayload({
    version: 24,
    elapsedSeconds: 1_000,
    activePlanetId: "home",
    entities: [],
    totalProduced: { iron_ingot: 1_000 },
    metrics: { generationKw: 1_000, totalItemsPerMinute: 100, rayGenerationKw: 0 },
    planetMetrics: {
      home: { generationKw: 1_000, totalItemsPerMinute: 100, rayGenerationKw: 0 },
      ashen: { generationKw: 2_000, totalItemsPerMinute: 200, rayGenerationKw: 0 },
      abyss: { generationKw: 3_000, totalItemsPerMinute: 300, rayGenerationKw: 0 },
    },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home", "ashen", "abyss"] },
  });
  assert.equal((await request("/api/cloud-save", {
    method: "PUT", headers, body: JSON.stringify({ payload, expectedRevision: 0 }),
  })).response.status, 200);

  let ranking = await request("/api/leaderboard?category=throughput&seasonId=season_01");
  let entry = ranking.body.entries.find((candidate) => candidate.userId === registered.body.user.leaderboardPublicId);
  assert.equal(entry.metrics.peakThroughputPerMinute, 0);
  assert.equal(entry.metrics.theoreticalPeakThroughputPerMinute, 600);
  assert.equal(entry.metrics.activePlanetThroughputPerMinute, 100);
  assert.equal(entry.metrics.galacticThroughputPerMinute, 600);
  assert.equal(entry.metrics.nominalThroughputMetricVersion, "galactic-planet-sum-v1");
  assert.equal(Object.hasOwn(entry, "verification"), false);

  const switchedPayload = mutateSavePayload(payload, (state) => {
    state.elapsedSeconds += 60;
    state.activePlanetId = "abyss";
    state.metrics = { ...state.planetMetrics.abyss };
  });
  assert.equal((await request("/api/cloud-save", {
    method: "PUT", headers, body: JSON.stringify({ payload: switchedPayload, expectedRevision: 1 }),
  })).response.status, 200);
  ranking = await request("/api/leaderboard?category=throughput&seasonId=season_01");
  entry = ranking.body.entries.find((candidate) => candidate.userId === registered.body.user.leaderboardPublicId);
  assert.equal(entry.metrics.peakThroughputPerMinute, 0);
  assert.equal(entry.metrics.theoreticalPeakThroughputPerMinute, 600);
  assert.equal(entry.metrics.activePlanetThroughputPerMinute, 300);
  assert.equal(entry.metrics.galacticThroughputPerMinute, 600);
});

test("marks root-only nominal throughput as a legacy active-planet fallback", async () => {
  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "legacy_nominal", password: "rank-pass-123", displayName: "旧口径存档" }),
  });
  const payload = createSavePayload({
    version: 24,
    elapsedSeconds: 1_000,
    entities: [],
    totalProduced: {},
    metrics: { generationKw: 1_000, totalItemsPerMinute: 450, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  });
  assert.equal((await request("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.body.token}` },
    body: JSON.stringify({ payload, expectedRevision: 0 }),
  })).response.status, 200);
  const ranking = await request("/api/leaderboard?category=throughput&seasonId=season_01");
  const entry = ranking.body.entries.find((candidate) => candidate.userId === registered.body.user.leaderboardPublicId);
  assert.equal(entry.metrics.theoreticalPeakThroughputPerMinute, 450);
  assert.equal(entry.metrics.activePlanetThroughputPerMinute, 450);
  assert.equal(entry.metrics.galacticThroughputPerMinute, 450);
  assert.equal(entry.metrics.nominalThroughputMetricVersion, "legacy-active-planet-v1");
  assert.equal(Object.hasOwn(entry, "verification"), false);
});

test("verifies the optional 19 MiB galactic-throughput fixture without modifying it", {
  skip: !galacticThroughputFixturePath,
}, async () => {
  const sourceBefore = await readFile(galacticThroughputFixturePath);
  const sourceHash = createHash("sha256").update(sourceBefore).digest("hex");
  const payload = sourceBefore.toString("utf8");
  const parsed = JSON.parse(payload);
  const nominal = aggregateGalacticFactoryMetric(parsed.state, "totalItemsPerMinute");
  assert.ok(Math.abs(nominal.activePlanetValue - 14_503_564_442.41) < 1);
  assert.ok(Math.abs(nominal.galacticValue - 189_651_877_333.02) < 1);
  assert.equal(nominal.metricVersion, "galactic-planet-sum-v1");
  assert.equal(nominal.planetCount, 22);

  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "fixture_nominal", password: "rank-pass-123", displayName: "真实夹具口径" }),
  });
  assert.equal((await request("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.body.token}` },
    body: JSON.stringify({ payload, expectedRevision: 0 }),
  })).response.status, 200);
  const ranking = await request("/api/leaderboard?category=throughput&seasonId=season_01");
  const entry = ranking.body.entries.find((candidate) => candidate.userId === registered.body.user.leaderboardPublicId);
  assert.ok(Math.abs(entry.metrics.activePlanetThroughputPerMinute - nominal.activePlanetValue) < 1);
  assert.ok(Math.abs(entry.metrics.galacticThroughputPerMinute - nominal.galacticValue) < 1);
  assert.ok(Math.abs(entry.metrics.theoreticalPeakThroughputPerMinute - nominal.galacticValue) < 1);
  assert.equal(entry.metrics.peakThroughputPerMinute, 0);

  const sourceAfter = await readFile(galacticThroughputFixturePath);
  assert.equal(createHash("sha256").update(sourceAfter).digest("hex"), sourceHash);
});

test("does not merge a legacy nominal throughput peak into the v2 settled-production metric", async () => {
  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "throughput_v2_rank", password: "rank-pass-123", displayName: "实际吞吐测试" }),
  });
  const headers = { authorization: `Bearer ${registered.body.token}` };
  const first = createSavePayload({
    version: 24,
    elapsedSeconds: 1_000,
    entities: [],
    totalProduced: { iron_ingot: 1_000 },
    metrics: { generationKw: 1_000, totalItemsPerMinute: 9_000_000, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  });
  assert.equal((await request("/api/cloud-save", { method: "PUT", headers, body: JSON.stringify({ payload: first, expectedRevision: 0 }) })).response.status, 200);
  const key = `season_01:${registered.body.user.id}`;
  server.store.data.submissions[key].metrics.peakThroughputPerMinute = 8_000_000;
  server.store.data.submissions[key].verification.strategy = "main-cloud-save-v1";
  await server.store.persist();

  const second = mutateSavePayload(first, (state) => {
    state.elapsedSeconds = 1_060;
    state.totalProduced.iron_ingot = 1_600;
  });
  assert.equal((await request("/api/cloud-save", { method: "PUT", headers, body: JSON.stringify({ payload: second, expectedRevision: 1 }) })).response.status, 200);
  const submission = server.store.data.submissions[key];
  assert.equal(submission.verification.strategy, "main-cloud-save-v2");
  assert.equal(submission.metrics.peakThroughputPerMinute, 600);
  assert.equal(submission.metrics.theoreticalPeakThroughputPerMinute, 9_000_000);
  assert.equal(submission.legacyMetrics.peakThroughputPerMinute, 8_000_000);
});

test("saturates extreme leaderboard totals instead of wrapping them to zero", async () => {
  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "saturated_rank", password: "rank-pass-123", displayName: "极限工厂" }),
  });
  const payload = createSavePayload({
    version: 24,
    elapsedSeconds: Number.MAX_VALUE,
    entities: [],
    totalProduced: { universe_matrix: Number.MAX_VALUE },
    metrics: { generationKw: Number.MAX_VALUE, totalItemsPerMinute: Number.MAX_VALUE, rayGenerationKw: 0 },
    dysonSwarm: { generationKw: Number.MAX_VALUE },
    dysonSphere: { generationKw: Number.MAX_VALUE },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  });
  const uploaded = await request("/api/cloud-save", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.body.token}` },
    body: JSON.stringify({ payload, expectedRevision: 0 }),
  });
  assert.equal(uploaded.response.status, 200);
  const ranking = await request("/api/leaderboard?category=dyson&seasonId=season_01");
  const entry = ranking.body.entries.find((candidate) => candidate.displayName === "极限工厂");
  assert.equal(entry.metrics.energyGeneratedMj, Number.MAX_VALUE);
  assert.equal(entry.metrics.peakDysonPowerKw, Number.MAX_VALUE);
  assert.equal(entry.metrics.galaxyScore, Number.MAX_VALUE);
});

test("deletes an account and all directly owned cloud data", async () => {
  const created = await request("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "delete_pilot", password: "delete-pass-123", displayName: "待注销工程师" }) });
  assert.equal(created.response.status, 201);
  const deleteToken = created.body.token;
  const deletePayload = mutateSavePayload(cloudPayload, (state) => { state.totalProduced.universe_matrix = 424_242; });
  const deletePayloadChecksum = createHash("sha256").update(deletePayload).digest("hex");
  const saved = await request("/api/cloud-save", { method: "PUT", headers: { authorization: `Bearer ${deleteToken}` }, body: JSON.stringify({ payload: deletePayload, expectedRevision: 0 }) });
  assert.equal(saved.response.status, 200);
  const manualSaved = await request("/api/cloud-save?slot=1", { method: "PUT", headers: { authorization: `Bearer ${deleteToken}` }, body: JSON.stringify({ payload: deletePayload, expectedRevision: 0 }) });
  assert.equal(manualSaved.response.status, 200);

  const rejected = await request("/api/account/delete", {
    method: "POST",
    headers: { authorization: `Bearer ${deleteToken}` },
    body: JSON.stringify({ password: "delete-pass-123", confirmation: "wrong" }),
  });
  assert.equal(rejected.response.status, 400);
  const deleted = await request("/api/account/delete", {
    method: "POST",
    headers: { authorization: `Bearer ${deleteToken}` },
    body: JSON.stringify({ password: "delete-pass-123", confirmation: "DELETE" }),
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(Object.values(server.store.data.users).some((user) => user.username === "delete_pilot"), false);
  assert.equal(server.store.data.cloudSaves[created.body.user.id], undefined);
  assert.equal(server.store.data.cloudSaveSlots[created.body.user.id], undefined);
  assert.equal(server.store.database.prepare("SELECT count(*) AS count FROM cloud_save_payloads WHERE user_id = ?").get(created.body.user.id).count, 0);
  assert.equal(server.store.database.prepare("SELECT count(*) AS count FROM cloud_save_payload_blobs WHERE checksum = ?").get(deletePayloadChecksum).count, 0);
  const expired = await request("/api/account", { headers: { authorization: `Bearer ${deleteToken}` } });
  assert.equal(expired.response.status, 401);
});
