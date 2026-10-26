import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createCloudServer } from "./index.mjs";
import { computeSaveStateChecksum } from "./save-integrity.mjs";

const playerId = (id) => `presence_atomic_player_${String(id).padStart(32, "0")}`;
const hash = (id) => createHash("sha256").update(`player:${playerId(id)}`).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function fixture(options = {}, json = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-presence-atomic-"));
  const file = path.join(directory, json ? "cloud.json" : "cloud.sqlite");
  const open = async () => {
    const server = await createCloudServer({
      ...(json ? { dataFile: file, databaseFile: "" } : { databaseFile: file }),
      backupDirectory: "", backupIntervalMs: 0, historyPruneIntervalMs: 0,
      registrationLimit: 100, logger: { error() {} }, ...options,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, init = {}) => {
      const response = await fetch(base + route, { ...init, headers: { "content-type": "application/json", ...init.headers } });
      return { status: response.status, body: await response.json() };
    };
    return { server, base, call, ping: (id, init = {}) => call("/api/presence", {
      method: "POST", body: JSON.stringify({ playerId: playerId(id) }),
      headers: { "x-forwarded-for": `192.0.2.${Number(id) % 250 + 1}`, ...init.headers }, ...init,
    }) };
  };
  let running = await open();
  return {
    file, get running() { return running; },
    async restart() { if (running.server.listening) await running.server.shutdown(); running = await open(); },
    async close() { if (running.server.listening) await running.server.shutdown(); await rm(directory, { recursive: true, force: true }); },
  };
}

function rows(file) {
  const db = new Database(file, { readonly: true });
  try {
    return {
      app: db.prepare("SELECT payload, updated_at FROM app_state WHERE id=1").get(),
      runtime: db.prepare("SELECT namespace, record_key, payload FROM runtime_state_records ORDER BY namespace, record_key").all(),
    };
  } finally { db.close(); }
}

test("SQLite heartbeat never traverses unrelated account metadata and keeps earlier snapshots intact", async () => {
  const f = await fixture();
  const { server, ping } = f.running;
  const before = server.store._data;
  const beforeRows = rows(f.file).app;
  Object.defineProperty(before.users, "unrelated", { configurable: true, enumerable: true, get() { throw new Error("unrelated account metadata was traversed"); } });
  try {
    const result = await ping(1);
    assert.equal(result.status, 202);
    assert.deepEqual(result.body.players.total, 1);
    assert.equal(before.players[hash(1)], undefined, "a published heartbeat must not mutate an earlier snapshot");
    assert.equal(server.store._data.users, before.users);
    assert.deepEqual(rows(f.file).app, beforeRows);
  } finally { delete before.users.unrelated; await f.close(); }
});

test("a slow or abandoned heartbeat body cannot hold the mutation queue", async () => {
  const f = await fixture();
  const slow = http.request(`${f.running.base}/api/presence`, { method: "POST", headers: { "content-type": "application/json", "content-length": "1000" } });
  slow.on("error", () => {});
  slow.write('{"playerId":"');
  try {
    await pause(30);
    const pending = f.running.ping(2);
    const result = await Promise.race([pending, pause(700).then(() => null)]);
    slow.destroy();
    await pending;
    assert.equal(result?.status, 202, "a complete heartbeat must not wait for another request's unfinished body");
    assert.equal(Object.keys(f.running.server.store.data.players).length, 1);
  } finally { slow.destroy(); await f.close(); }
});

test("concurrent duplicate heartbeats, day rollover and restart preserve counts", async (t) => {
  let now = Date.parse("2026-10-25T15:59:59.000Z");
  t.mock.method(Date, "now", () => now);
  const f = await fixture();
  try {
    const first = await Promise.all(Array.from({ length: 24 }, (_, i) => f.running.ping(i % 6)));
    assert.ok(first.every((r) => r.status === 202), JSON.stringify(first.filter((r) => r.status !== 202)));
    // Request-array order is not commit order under concurrent HTTP sockets.
    assert.equal((await f.running.call("/api/public-status")).body.players.total, 6);
    assert.equal(f.running.server.store.data.dailyMetrics["2026-10-25"].requests, 24);
    assert.equal(f.running.server.store.data.dailyMetrics["2026-10-25"].players, 6);
    const earliest = f.running.server.store.data.players[hash(0)].firstSeenAt;
    now += 2000;
    await Promise.all(Array.from({ length: 18 }, (_, i) => f.running.ping(i % 6)));
    assert.equal(f.running.server.store.data.dailyMetrics["2026-10-26"].players, 6);
    assert.equal(f.running.server.store.data.dailyMetrics["2026-10-26"].requests, 18);
    assert.equal(f.running.server.store.data.players[hash(0)].firstSeenAt, earliest);
    await f.restart();
    const status = await f.running.call("/api/public-status");
    assert.deepEqual([status.body.players.total, status.body.players.today, status.body.players.online], [6, 6, 6]);
    assert.equal(f.running.server.store.data.dailyMetrics["2026-10-26"].requests, 18);
  } finally { await f.close(); }
});

for (const phase of ["before-sqlite-transaction", "after-runtime-upserts", "after-runtime-metadata", "after-app-state-write"]) {
  test(`heartbeat failure at ${phase} rolls back SQL, memory and index together`, async () => {
    let fail = false;
    const f = await fixture({ persistenceFaultInjector(event) {
      if (fail && event.phase === phase && event.operation.startsWith("presence.")) {
        const error = new Error("synthetic presence failure"); error.code = "SQLITE_IOERR_TEST"; throw error;
      }
    } });
    try {
      assert.equal((await f.running.ping(1)).status, 202);
      const before = rows(f.file);
      const oldData = f.running.server.store._data;
      const generation = f.running.server.store.commitGeneration;
      fail = true;
      assert.equal((await f.running.ping(2)).status, 500);
      assert.equal((await f.running.ping(1)).status, 500);
      assert.deepEqual(rows(f.file), before);
      assert.equal(f.running.server.store._data, oldData);
      assert.equal(f.running.server.store.commitGeneration, generation);
      assert.equal(f.running.server.presenceIndex.metrics(Date.now()).total, 1);
      assert.equal((await f.running.call("/api/ready")).status, 503);
      fail = false;
      assert.equal((await f.running.ping(2)).status, 202);
      assert.equal((await f.running.call("/api/ready")).status, 200);
      await f.restart();
      assert.equal((await f.running.call("/api/public-status")).body.players.total, 2);
    } finally { await f.close(); }
  });
}

test("queued cancelled heartbeats are discarded and accepted writes drain before shutdown", async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  try {
    const blocker = f.running.server.store.runAtomic(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const aborter = new AbortController();
    const cancelled = f.running.ping(10, { signal: aborter.signal }).catch(() => null);
    await pause(40);
    aborter.abort(); await cancelled; await pause(20);
    const accepted = f.running.ping(11);
    await pause(30);
    release.resolve(); await blocker;
    assert.equal((await accepted).status, 202);
    assert.equal(f.running.server.store.data.players[hash(10)], undefined);
    assert.ok(f.running.server.store.data.players[hash(11)]);
    const queued = Array.from({ length: 8 }, (_, i) => f.running.ping(20 + i));
    assert.ok((await Promise.all(queued)).every((r) => r.status === 202));
    await f.restart();
    assert.equal(Object.keys(f.running.server.store.data.players).length, 9);
  } finally { release.resolve(); await f.close(); }
});

test("heartbeats serialize with cloud uploads without overwriting saves or counters", async () => {
  const f = await fixture();
  try {
    const account = await f.running.call("/api/auth/register", { method: "POST", body: JSON.stringify({ username: "PresenceCloud", password: "presence-pass-123", displayName: "Presence Cloud" }) });
    assert.equal(account.status, 201);
    const state = { version: 24, elapsedSeconds: 100, entities: [], totalProduced: { universe_matrix: 3 }, metrics: { generationKw: 0, totalItemsPerMinute: 0, rayGenerationKw: 0 }, exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] } };
    const payload = JSON.stringify({ formatVersion: 2, state, checksum: computeSaveStateChecksum(2, state) });
    const headers = { authorization: `Bearer ${account.body.token}` };
    const results = await Promise.all([
      f.running.call("/api/cloud-save?slot=main", { method: "PUT", headers, body: JSON.stringify({ payload, expectedRevision: 0 }) }),
      ...Array.from({ length: 12 }, (_, i) => f.running.ping(i)),
    ]);
    assert.equal(results[0].status, 200);
    assert.ok(results.slice(1).every((r) => r.status === 202), JSON.stringify(results.filter((r) => r.status !== 202 && r.status !== 200)));
    await f.restart();
    const saved = await f.running.call("/api/cloud-save?slot=main", { headers });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.cloudSave.payload, payload);
    assert.equal(saved.body.cloudSave.revision, 1);
    assert.equal((await f.running.call("/api/public-status")).body.players.total, 12);
  } finally { await f.close(); }
});

test("JSON storage retains its atomic heartbeat and restart behavior", async () => {
  const f = await fixture({}, true);
  try {
    assert.equal((await f.running.ping(1)).status, 202);
    assert.equal((await f.running.ping(1)).body.players.total, 1);
    await f.restart();
    assert.equal((await f.running.call("/api/public-status")).body.players.total, 1);
  } finally { await f.close(); }
});

test("shutdown drains already queued heartbeat commits before closing SQLite", async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  let closing;
  try {
    const blocker = f.running.server.store.enqueueWrite(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const pending = Array.from({ length: 8 }, (_, i) => f.running.ping(i));
    await pause(60);
    closing = f.running.server.shutdown();
    let closed = false;
    void closing.then(() => { closed = true; });
    await pause(20);
    assert.equal(closed, false);
    release.resolve();
    await blocker;
    assert.ok((await Promise.all(pending)).every((r) => r.status === 202));
    await closing;
    await f.restart();
    assert.equal(Object.keys(f.running.server.store.data.players).length, 8);
  } finally { release.resolve(); if (closing) await closing; await f.close(); }
});

test("invalid, oversized and rate-limited heartbeats do not write player rows", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.running.call("/api/presence", { method: "POST", body: JSON.stringify({ playerId: "invalid" }) })).status, 400);
    assert.equal((await f.running.call("/api/presence", { method: "POST", body: JSON.stringify({ playerId: "x".repeat(5000) }) })).status, 413);
    for (let i = 0; i < 10; i += 1) assert.equal((await f.running.ping(1)).status, 202);
    assert.equal((await f.running.ping(1)).status, 429);
    assert.equal(Object.keys(f.running.server.store.data.players).length, 1);
    assert.equal(rows(f.file).runtime.filter((r) => r.namespace === "player").length, 1);
  } finally { await f.close(); }
});

test("a stale ordinary draft cannot overwrite a committed heartbeat", async () => {
  const f = await fixture();
  try {
    const stale = f.running.server.store.createStandaloneMutation();
    stale.data.feedback.push({ id: "stale", message: "must not publish" });
    assert.equal((await f.running.ping(1)).status, 202);
    await assert.rejects(f.running.server.store.commitMutation(stale, { operation: "stale-test" }), { code: "STATE_WRITE_CONFLICT" });
    assert.equal(f.running.server.store.data.feedback.length, 0);
    assert.ok(f.running.server.store.data.players[hash(1)]);
    assert.equal((await f.running.call("/api/ready")).status, 200);
    await f.restart();
    assert.equal((await f.running.call("/api/public-status")).body.players.total, 1);
  } finally { await f.close(); }
});
