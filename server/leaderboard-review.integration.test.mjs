import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCloudServer } from "./index.mjs";
import { computeSaveStateChecksum } from "./save-integrity.mjs";

const ADMIN_TOKEN = "synthetic-admin-token-leaderboard-review-123456";

function createState({ anomalous = false, elapsedSeconds = 600 } = {}) {
  return {
    version: 46,
    mode: "normal",
    elapsedSeconds,
    entities: anomalous ? [] : [{ id: "storage", kind: "storage", buildingId: "storage_mk1" }],
    belts: [{ id: "belt", source: "storage", target: "storage", itemId: "iron_ore" }],
    settings: {
      productionBufferLimit: 1_000_000,
      logisticsBufferLimit: 1_000_000,
      beltBufferLimit: 100_000_000,
      proliferatorBufferLimit: 600,
    },
    contentPacks: [],
    galaxy: { planetMetadata: {}, systemMetadata: {} },
    quantumLogisticsNetwork: {
      enabled: false,
      inventory: {},
      routingCursors: {},
      itemCapacities: {},
      uploadRoutingCursors: {},
    },
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
        "matrix_compression",
        "vein_utilization",
        "galactic_logistics",
        "stellar_harnessing",
        "continuum_simulation",
      ].map((id) => [id, { level: 0, progress: "0" }])),
    },
    totalProduced: anomalous ? { universe_matrix: 1_000_000_000_000 } : { universe_matrix: 1 },
    metrics: { generationKw: 0, totalItemsPerMinute: 0, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  };
}

function payloadFor(state, savedAt) {
  const envelope = { formatVersion: 2, savedAt, mode: "normal", state };
  return JSON.stringify({ ...envelope, checksum: computeSaveStateChecksum(envelope.formatVersion, state) });
}

async function startServer(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-leaderboard-review-integration-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  const server = await createCloudServer({
    databaseFile,
    adminToken: ADMIN_TOKEN,
    registrationLimit: 100,
    historyPruneIntervalMs: 0,
    backupIntervalMs: 0,
    mailer: null,
    logger: { error() {} },
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function register(baseUrl, username) {
  const result = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password: "synthetic-pass-123", displayName: "待复核账号" }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return { accountId: result.body.user.id, headers: { authorization: `Bearer ${result.body.token}` } };
}

async function upload(baseUrl, headers, payload, expectedRevision) {
  return request(baseUrl, "/api/cloud-save", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      payload,
      expectedRevision,
      payloadChecksum: createHash("sha256").update(payload).digest("hex"),
      payloadSize: Buffer.byteLength(payload),
    }),
  });
}

function adminHeaders() {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

test("integrity anomalies are queued without automatic restriction or submission removal", async (t) => {
  const { baseUrl } = await startServer(t);
  const account = await register(baseUrl, "review_queue_keep");
  const first = await upload(baseUrl, account.headers, payloadFor(createState(), 100), 0);
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  const before = await request(baseUrl, "/api/leaderboard/me?category=galaxy", { headers: account.headers });
  assert.equal(before.response.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.status, "ranked", JSON.stringify(before.body));

  const anomalous = await upload(baseUrl, account.headers, payloadFor(createState({ anomalous: true, elapsedSeconds: 700 }), 200), 1);
  assert.equal(anomalous.response.status, 200, JSON.stringify(anomalous.body));
  assert.deepEqual(anomalous.body.leaderboard, { status: "review_pending", automaticRestriction: false });

  const report = await request(baseUrl, "/api/admin/leaderboard/reviews", { headers: adminHeaders() });
  assert.equal(report.response.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.pendingCount, 1);
  assert.equal(report.body.entries[0].accountId, account.accountId);
  assert.equal(report.body.policy.automaticRestriction, false);

  const after = await request(baseUrl, "/api/admin/account?accountId=" + encodeURIComponent(account.accountId), { headers: adminHeaders() });
  assert.equal(after.body.account.leaderboardRestricted, false);
  assert.equal(after.body.account.leaderboardReview.status, "pending");
  const retained = await request(baseUrl, "/api/leaderboard/me?category=galaxy", { headers: account.headers });
  assert.equal(retained.body.status, "ranked", JSON.stringify(retained.body));
  assert.equal(retained.body.latestCloudRevision, 2);

  const restricted = await request(baseUrl, "/api/admin/account/action", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      accountId: account.accountId,
      action: "restrict-leaderboard",
      confirmation: `CONFIRM:restrict-leaderboard:${account.accountId}`,
    }),
  });
  assert.equal(restricted.response.status, 200, JSON.stringify(restricted.body));
  assert.equal(restricted.body.account.leaderboardRestricted, true);
  assert.equal(restricted.body.account.leaderboardReview, null);
  const removed = await request(baseUrl, "/api/leaderboard/me?category=galaxy", { headers: account.headers });
  assert.equal(removed.body.status, "restricted", JSON.stringify(removed.body));
});

test("an admin approval is bound to the reviewed revision and republishes it", async (t) => {
  const { baseUrl } = await startServer(t);
  const account = await register(baseUrl, "review_queue_approve");
  assert.equal((await upload(baseUrl, account.headers, payloadFor(createState(), 300), 0)).response.status, 200);
  const anomalous = await upload(baseUrl, account.headers, payloadFor(createState({ anomalous: true, elapsedSeconds: 700 }), 400), 1);
  assert.equal(anomalous.response.status, 200);

  const approved = await request(baseUrl, "/api/admin/account/action", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      accountId: account.accountId,
      action: "approve-leaderboard-review",
      confirmation: `CONFIRM:approve-leaderboard-review:${account.accountId}`,
    }),
  });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.account.leaderboardRestricted, false);
  assert.equal(approved.body.account.leaderboardReview.status, "approved");
  const published = await request(baseUrl, "/api/leaderboard/me?category=galaxy", { headers: account.headers });
  assert.equal(published.body.status, "ranked", JSON.stringify(published.body));
  assert.equal(published.body.latestCloudRevision, 2);
});
