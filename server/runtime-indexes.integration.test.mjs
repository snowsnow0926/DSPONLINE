import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCloudServer } from "./index.mjs";
import { computeSaveStateChecksum } from "./save-integrity.mjs";

const ADMIN_TOKEN = "runtime-indexes-test-admin-token-123456789";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function savePayload(elapsedSeconds, whiteMatrix = elapsedSeconds, ironIngot = elapsedSeconds * 2) {
  const state = {
    version: 24,
    elapsedSeconds,
    entities: [],
    totalProduced: { universe_matrix: whiteMatrix, iron_ingot: ironIngot },
    metrics: { generationKw: 1_000, totalItemsPerMinute: 2_000, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  };
  const envelope = { formatVersion: 2, savedAt: elapsedSeconds * 1_000, state };
  return JSON.stringify({ ...envelope, checksum: computeSaveStateChecksum(envelope.formatVersion, state) });
}

async function startServer(databaseFile, options = {}) {
  const server = await createCloudServer({
    databaseFile,
    registrationLimit: 10_000,
    adminToken: ADMIN_TOKEN,
    mailer: null,
    logger: { error() {} },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, options = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    });
    return { response, body: await response.json() };
  };
  return { server, baseUrl, call };
}

async function stopServer(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function register(call, index = 0) {
  const result = await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      username: `scale_user_${String(index).padStart(5, "0")}`,
      password: "strong-pass-123",
      displayName: `规模测试 ${index}`,
    }),
  });
  assert.equal(result.response.status, 201);
  return { ...result.body.user, token: result.body.token };
}

async function uploadMain(call, account, elapsedSeconds, expectedRevision, whiteMatrix = elapsedSeconds, ironIngot = elapsedSeconds * 2) {
  const result = await call("/api/cloud-save?slot=main&mode=normal", {
    method: "PUT",
    headers: { authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ payload: savePayload(elapsedSeconds, whiteMatrix, ironIngot), expectedRevision }),
  });
  assert.equal(result.response.status, 200);
  return result;
}

test("presence heartbeats and reads stay incremental and rebuild exactly from SQLite", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-runtime-presence-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  let running;
  try {
    running = await startServer(databaseFile, { playerOnlineWindowMs: 500 });
    for (let index = 0; index < 150; index += 1) {
      const result = await running.call("/api/presence", {
        method: "POST",
        headers: { "x-forwarded-for": `198.51.100.${index % 250}` },
        body: JSON.stringify({ playerId: `scale_player_${String(index).padStart(40, "0")}` }),
      });
      assert.equal(result.response.status, 202);
    }
    const before = running.server.presenceIndex.diagnostics();
    const repeat = await running.call("/api/presence", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.250" },
      body: JSON.stringify({ playerId: `scale_player_${String(0).padStart(40, "0")}` }),
    });
    assert.equal(repeat.body.players.total, 150);
    const after = running.server.presenceIndex.diagnostics();
    assert.equal(after.rebuilds, before.rebuilds);
    assert.equal(after.rebuildRecordsVisited, before.rebuildRecordsVisited);
    assert.equal(after.heartbeats, before.heartbeats + 1);
    const statusBefore = (await running.call("/api/public-status")).body.players;
    await stopServer(running.server);
    running = null;
    running = await startServer(databaseFile, { playerOnlineWindowMs: 500 });
    const statusAfter = (await running.call("/api/public-status")).body.players;
    assert.deepEqual({ total: statusAfter.total, today: statusAfter.today }, { total: statusBefore.total, today: statusBefore.today });
    assert.equal(running.server.presenceIndex.diagnostics().records, 150);
  } finally {
    await stopServer(running?.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("public Top 100 and authenticated /me share one snapshot across committed invalidations and restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-runtime-leaderboard-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  let running;
  try {
    running = await startServer(databaseFile);
    const account = await register(running.call);
    await uploadMain(running.call, account, 1_000, 0, 100, 100);
    await uploadMain(running.call, account, 1_060, 1, 160, 160);
    const ownKey = `season_01:${account.id}`;
    const ownSubmission = running.server.store.data.submissions[ownKey];
    for (let index = 0; index < 149; index += 1) {
      const userId = `synthetic_scale_${String(index).padStart(3, "0")}`;
      running.server.store.data.users[userId] = {
        ...account,
        id: userId,
        username: userId.slice(0, 24),
        displayName: `合成规模 ${index}`,
        leaderboardVisible: true,
      };
      running.server.store.data.submissions[`season_01:${userId}`] = {
        ...ownSubmission,
        userId,
        accountId: userId,
        displayName: `合成规模 ${index}`,
        metrics: { ...ownSubmission.metrics, peakThroughputPerMinute: 10_000 + index },
      };
    }
    await running.server.store.persist({ operation: "runtime-indexes.synthetic-seed" });
    const publicBefore = await running.call("/api/leaderboard?category=throughput&seasonId=season_01");
    assert.equal(publicBefore.body.entries.length, 100);
    assert.equal(Object.hasOwn(publicBefore.body.entries[0], "verification"), false,
      "the cached public projection must omit private revision/checksum verification internals");
    const metricsAfterColdBuild = running.server.leaderboardIndex.metrics();
    const publicCached = await running.call("/api/leaderboard?category=throughput&seasonId=season_01");
    assert.deepEqual(publicCached.body.entries, publicBefore.body.entries,
      "a cache hit must return the complete cold-build DTO unchanged");
    assert.equal(running.server.leaderboardIndex.metrics().snapshotBuilds, metricsAfterColdBuild.snapshotBuilds);
    const metricsAfterPublic = running.server.leaderboardIndex.metrics();
    const meBefore = await running.call("/api/leaderboard/me?category=throughput&seasonId=season_01", {
      headers: { authorization: `Bearer ${account.token}` },
    });
    assert.equal(meBefore.body.rank, 150);
    assert.equal(meBefore.body.totalEntries, 150);
    assert.equal(running.server.leaderboardIndex.metrics().snapshotBuilds, metricsAfterPublic.snapshotBuilds);

    const hidden = await running.call("/api/leaderboard/visibility", {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}` },
      body: JSON.stringify({ visible: false }),
    });
    assert.equal(hidden.response.status, 200);
    assert.equal((await running.call("/api/leaderboard/me?category=throughput&seasonId=season_01", {
      headers: { authorization: `Bearer ${account.token}` },
    })).body.status, "hidden");
    const visible = await running.call("/api/leaderboard/visibility", {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}` },
      body: JSON.stringify({ visible: true }),
    });
    assert.equal(visible.response.status, 200);
    const publicRestored = await running.call("/api/leaderboard?category=throughput&seasonId=season_01");
    const meRestored = await running.call("/api/leaderboard/me?category=throughput&seasonId=season_01", {
      headers: { authorization: `Bearer ${account.token}` },
    });
    assert.equal(meRestored.body.rank, 150);
    const expectedPublic = structuredClone(publicRestored.body.entries);
    const expectedMe = { status: meRestored.body.status, rank: meRestored.body.rank, totalEntries: meRestored.body.totalEntries, value: meRestored.body.entry.value };
    await stopServer(running.server);
    running = null;
    running = await startServer(databaseFile);
    const publicAfter = await running.call("/api/leaderboard?category=throughput&seasonId=season_01");
    const meAfter = await running.call("/api/leaderboard/me?category=throughput&seasonId=season_01", {
      headers: { authorization: `Bearer ${account.token}` },
    });
    assert.deepEqual(publicAfter.body.entries, expectedPublic);
    assert.deepEqual({ status: meAfter.body.status, rank: meAfter.body.rank, totalEntries: meAfter.body.totalEntries, value: meAfter.body.entry.value }, expectedMe);
  } finally {
    await stopServer(running?.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed SQLite mutations never publish presence or leaderboard cache events", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-runtime-failure-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  let failPresence = false;
  let running;
  try {
    running = await startServer(databaseFile, {
      persistenceFaultInjector({ phase, operation }) {
        if (failPresence && phase === "before-sqlite-transaction" && operation === "presence.update") {
          const error = new Error("synthetic sqlite failure");
          error.code = "SQLITE_IOERR_TEST";
          throw error;
        }
      },
    });
    const beforePresence = running.server.presenceIndex.diagnostics();
    failPresence = true;
    const failed = await running.call("/api/presence", {
      method: "POST",
      body: JSON.stringify({ playerId: "failed_presence_player_0000000000000000" }),
    });
    assert.equal(failed.response.status, 500);
    const afterPresence = running.server.presenceIndex.diagnostics();
    assert.equal(afterPresence.records, beforePresence.records);
    assert.equal(afterPresence.heartbeats, beforePresence.heartbeats);

    failPresence = false;
    const account = await register(running.call, 1);
    await uploadMain(running.call, account, 1_000, 0);
    await uploadMain(running.call, account, 1_060, 1);
    await running.call("/api/leaderboard?category=galaxy&seasonId=season_01");
    const cacheBefore = running.server.leaderboardIndex.metrics();
    const originalCommit = running.server.store.commitCandidate.bind(running.server.store);
    running.server.store.commitCandidate = async (_candidate, _mutation, context) => {
      if (context.operation === "leaderboard.refresh") {
        const error = new Error("synthetic refresh failure");
        error.code = "SQLITE_IOERR_TEST";
        throw error;
      }
      return originalCommit(_candidate, _mutation, context);
    };
    const refresh = await running.call("/api/leaderboard", {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}` },
      body: JSON.stringify({ seasonId: "season_01" }),
    });
    assert.equal(refresh.response.status, 500);
    assert.equal(running.server.leaderboardIndex.metrics().invalidations, cacheBefore.invalidations);
    const publicAfter = await running.call("/api/leaderboard?category=galaxy&seasonId=season_01");
    assert.equal(publicAfter.body.entries.some((entry) => entry.displayName === account.displayName), true);
  } finally {
    await stopServer(running?.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("server close waits for response-ended request cleanup before closing SQLite", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-runtime-request-drain-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  let running;
  let closePromise;
  const releaseRequestTail = deferred();
  try {
    running = await startServer(databaseFile);
    const enteredRequestTail = deferred();
    const originalRunAtomic = running.server.store.runAtomic.bind(running.server.store);
    let pauseNextRequest = true;
    running.server.store.runAtomic = async (...args) => {
      const result = await originalRunAtomic(...args);
      if (pauseNextRequest) {
        pauseNextRequest = false;
        enteredRequestTail.resolve();
        await releaseRequestTail.promise;
      }
      return result;
    };

    let storeClosed = false;
    const originalStoreClose = running.server.store.close.bind(running.server.store);
    running.server.store.close = () => {
      storeClosed = true;
      return originalStoreClose();
    };

    // Use an ordinary atomic route: presence now commits its narrow delta
    // before producing the response, outside the generic runAtomic wrapper.
    const request = running.call("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ kind: "feedback", message: "Synthetic request drain regression" }),
    });
    await enteredRequestTail.promise;
    assert.equal((await request).response.status, 202);

    const nativeCloseEvent = new Promise((resolve) => running.server.once("close", resolve));
    let closeResolved = false;
    closePromise = new Promise((resolve, reject) => {
      running.server.close((error) => error ? reject(error) : resolve());
    }).then(() => { closeResolved = true; });
    await nativeCloseEvent;
    assert.equal(storeClosed, false, "SQLite must remain open while an accepted request is in its async tail");
    assert.equal(closeResolved, false);

    releaseRequestTail.resolve();
    await closePromise;
    assert.equal(storeClosed, true);
    assert.equal(closeResolved, true);
  } finally {
    releaseRequestTail.resolve();
    if (closePromise) await Promise.allSettled([closePromise]);
    await stopServer(running?.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("admin scale metrics stay fixed-cardinality and omit account identifiers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-runtime-metrics-"));
  let running;
  try {
    running = await startServer(path.join(directory, "cloud.sqlite"));
    const account = await register(running.call, 2);
    await uploadMain(running.call, account, 1_000, 0);
    const result = await running.call("/api/admin/metrics", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(result.response.status, 200);
    assert.equal(typeof result.body.runtime.scale.requests.total, "number");
    assert.equal(typeof result.body.runtime.scale.sqlite.commitDurationMs.count, "number");
    assert.equal(typeof result.body.runtime.scale.cache.leaderboard.hitRatio, "number");
    assert.equal(result.body.runtime.scale.requests.latencyMs.buckets.length, 13);
    const serialized = JSON.stringify(result.body.runtime.scale);
    assert.equal(serialized.includes(account.id), false);
    assert.equal(serialized.includes(account.username), false);
    assert.equal(serialized.includes(account.token), false);
  } finally {
    await stopServer(running?.server);
    await rm(directory, { recursive: true, force: true });
  }
});
