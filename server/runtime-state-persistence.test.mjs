import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  RUNTIME_STATE_NAMESPACES,
  RUNTIME_STATE_RECORDS_TABLE,
  RuntimeStatePersistenceError,
  SqliteRuntimeStatePersistence,
  createRuntimeStatePersistencePlan,
  mergeRuntimeStatePersistencePlans,
  runtimeAppStateFingerprint,
} from "./runtime-state-persistence.mjs";

const PLAYER_A = "a".repeat(64);
const PLAYER_B = "b".repeat(64);
const VISITOR_A = "c".repeat(64);
const SESSION_A = "d".repeat(64);
const SESSION_B = "e".repeat(64);

function runtimeFixture() {
  return {
    players: {
      [PLAYER_A]: { firstSeenAt: 100, lastSeenAt: 150, lastActiveDay: "2026-08-13" },
    },
    dailyMetrics: {
      "2026-08-13": {
        requests: 4,
        errors: 0,
        feedback: 0,
        leaderboardSubmissions: 0,
        cloudUploads: 0,
        players: 1,
        playersEstimate: 3,
        playersEstimateObserved: 1,
        playersEstimateMeta: {
          version: 1,
          method: "analytics-uv-presence-ratio-v1",
          planHash: "b".repeat(64),
          status: "full-day-projection",
          confidence: "low",
        },
      },
    },
    analytics: {
      visitors: {
        [VISITOR_A]: { firstSeenAt: 100, lastSeenAt: 150, lastActiveDay: "2026-08-13" },
      },
      sessions: {
        [SESSION_A]: {
          visitorHash: VISITOR_A,
          firstSeenAt: 100,
          lastSeenAt: 150,
          lastActiveDay: "2026-08-13",
          lastSequence: 1,
          client: "desktop-web",
          source: "direct",
        },
      },
      daily: {
        "2026-08-13": {
          uniqueVisitors: 1,
          sessions: 1,
          pageViews: 1,
          gameStarts: 0,
          activeSeconds: 10,
          events: { page_view: 1 },
          clients: { "desktop-web": 1 },
          sources: { direct: 1 },
        },
      },
    },
  };
}

function databaseWithAppState(payload = JSON.stringify({ marker: "unchanged" }), updatedAt = 77, file = ":memory:") {
  const database = new Database(file);
  database.exec("CREATE TABLE app_state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  database.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, ?)").run(payload, updatedAt);
  return database;
}

function appStateRow(database) {
  return database.prepare("SELECT payload, updated_at AS updatedAt FROM app_state WHERE id = 1").get();
}

test("seeds legacy app_state runtime records once and hydrates the same authoritative state", () => {
  const database = databaseWithAppState();
  try {
    const seed = runtimeFixture();
    const appState = appStateRow(database);
    const persistence = new SqliteRuntimeStatePersistence(database, { nowProvider: () => 1_000 });
    const initialized = persistence.initialize(seed, {
      appStateUpdatedAt: appState.updatedAt,
      appStateFingerprint: runtimeAppStateFingerprint(appState.payload),
    });
    assert.deepEqual(initialized, { initialized: true, seededRecords: 5, version: 1 });
    assert.deepEqual(persistence.hydrateState({ users: { preserved: true }, players: { stale: true } }), {
      users: { preserved: true },
      ...seed,
    });
    assert.equal(persistence.hydrateState({}).dailyMetrics["2026-08-13"].playersEstimate, 3);
    assert.equal(persistence.hydrateState({}).dailyMetrics["2026-08-13"].playersEstimateMeta.method, "analytics-uv-presence-ratio-v1");

    const second = new SqliteRuntimeStatePersistence(database, { nowProvider: () => 2_000 });
    assert.deepEqual(second.initialize({ players: { [PLAYER_B]: { firstSeenAt: 2_000 } } }, {
      appStateUpdatedAt: appState.updatedAt,
      appStateFingerprint: runtimeAppStateFingerprint(appState.payload),
    }), {
      initialized: false,
      seededRecords: 0,
      version: 1,
    });
    assert.deepEqual(second.readRuntimeState(), seed);
  } finally {
    database.close();
  }
});

test("presence heartbeat upserts only the dirty player and service day without rewriting app_state", () => {
  const largePayload = JSON.stringify({ marker: "app-state", padding: "x".repeat(2 * 1024 * 1024) });
  const database = databaseWithAppState(largePayload, 91);
  try {
    const before = runtimeFixture();
    const after = structuredClone(before);
    after.players[PLAYER_A].lastSeenAt = 300;
    after.dailyMetrics["2026-08-13"].requests += 1;
    const persistence = new SqliteRuntimeStatePersistence(database, { nowProvider: () => 300 });
    persistence.initialize(before);
    const originalAppState = appStateRow(database);
    const plan = createRuntimeStatePersistencePlan(before, after, {
      operation: "presence.touch",
      runtimeIndexEvents: [{ type: "presence", playerHash: PLAYER_A, seenAt: 300 }],
    });

    assert.equal(plan.canSkipAppState, true);
    assert.equal(plan.scannedRecords, 2);
    assert.deepEqual(plan.upserts.map(({ namespace, key }) => [namespace, key]).sort(), [
      [RUNTIME_STATE_NAMESPACES.player, PLAYER_A],
      [RUNTIME_STATE_NAMESPACES.serviceDaily, "2026-08-13"],
    ].sort());
    assert.deepEqual(persistence.commitPlan(plan, { operation: "presence.touch" }), { upserted: 2, deleted: 0 });
    assert.deepEqual(appStateRow(database), originalAppState);
    assert.deepEqual(persistence.readRuntimeState(), after);
  } finally {
    database.close();
  }
});

test("analytics delta persists visitor/session/day changes and expired-session deletion", () => {
  const database = databaseWithAppState();
  try {
    const before = runtimeFixture();
    before.analytics.sessions[SESSION_B] = {
      visitorHash: VISITOR_A,
      firstSeenAt: 1,
      lastSeenAt: 2,
      lastActiveDay: "2026-07-01",
      lastSequence: 1,
      client: "mobile-web",
      source: "search",
    };
    const after = structuredClone(before);
    after.analytics.visitors[VISITOR_A].lastSeenAt = 500;
    after.analytics.sessions[SESSION_A].lastSeenAt = 500;
    after.analytics.sessions[SESSION_A].lastSequence = 2;
    delete after.analytics.sessions[SESSION_B];
    after.analytics.daily["2026-08-13"].pageViews += 2;
    after.analytics.daily["2026-08-13"].events.page_view += 2;
    after.dailyMetrics["2026-08-13"].requests += 1;

    const persistence = new SqliteRuntimeStatePersistence(database, { nowProvider: () => 500 });
    persistence.initialize(before);
    const appStateBefore = appStateRow(database);
    const plan = createRuntimeStatePersistencePlan(before, after, { operation: "analytics.record" });
    assert.equal(plan.canSkipAppState, true);
    assert.deepEqual(plan.deletes, [{ namespace: RUNTIME_STATE_NAMESPACES.analyticsSession, key: SESSION_B }]);
    assert.equal(plan.upserts.length, 4);
    persistence.commitPlan(plan);

    assert.deepEqual(appStateRow(database), appStateBefore);
    assert.deepEqual(persistence.readRuntimeState(), after);
  } finally {
    database.close();
  }
});

test("merged heartbeat batch keeps only the final operation for each SQLite row", () => {
  const firstBefore = runtimeFixture();
  const firstAfter = structuredClone(firstBefore);
  firstAfter.players[PLAYER_A].lastSeenAt = 200;
  firstAfter.dailyMetrics["2026-08-13"].requests = 5;
  const secondAfter = structuredClone(firstAfter);
  secondAfter.players[PLAYER_A].lastSeenAt = 250;
  secondAfter.dailyMetrics["2026-08-13"].requests = 6;
  const plans = [
    createRuntimeStatePersistencePlan(firstBefore, firstAfter, {
      operation: "presence.touch",
      runtimeIndexEvents: [{ type: "presence", playerHash: PLAYER_A }],
    }),
    createRuntimeStatePersistencePlan(firstAfter, secondAfter, {
      operation: "presence.touch",
      runtimeIndexEvents: [{ type: "presence", playerHash: PLAYER_A }],
    }),
  ];
  const merged = mergeRuntimeStatePersistencePlans(plans);
  assert.equal(merged.upserts.length, 2);
  assert.equal(merged.canSkipAppState, true);

  const database = databaseWithAppState();
  try {
    const persistence = new SqliteRuntimeStatePersistence(database);
    persistence.initialize(firstBefore);
    const result = persistence.commitPlans(plans, { operation: "presence.batch" });
    assert.equal(result.upserted, 2);
    assert.deepEqual(persistence.readRuntimeState(), secondAfter);
    assert.equal(persistence.diagnostics().batches, 1);
  } finally {
    database.close();
  }
});

test("runtime delta joins a caller-owned app_state transaction and rolls back atomically", () => {
  const database = databaseWithAppState();
  try {
    const before = runtimeFixture();
    const after = structuredClone(before);
    after.players[PLAYER_A].lastSeenAt = 900;
    after.dailyMetrics["2026-08-13"].requests += 1;
    const persistence = new SqliteRuntimeStatePersistence(database);
    persistence.initialize(before);
    const plan = createRuntimeStatePersistencePlan(before, after, {
      operation: "presence.touch",
      runtimeIndexEvents: [{ type: "presence", playerHash: PLAYER_A }],
    });
    const originalAppState = appStateRow(database);

    assert.throws(() => database.transaction(() => {
      database.prepare("UPDATE app_state SET payload = ?, updated_at = ? WHERE id = 1").run("changed", 999);
      persistence.applyPlanInTransaction(plan);
      throw new Error("synthetic app-state failure");
    })(), /synthetic app-state failure/);
    assert.deepEqual(appStateRow(database), originalAppState);
    assert.deepEqual(persistence.readRuntimeState(), before);

    database.transaction(() => {
      database.prepare("UPDATE app_state SET payload = ?, updated_at = ? WHERE id = 1").run("changed", 999);
      persistence.applyPlanInTransaction(plan, { synchronizeAppState: true });
    })();
    persistence.observeCommitted(plan, { upserted: 2, deleted: 0 });
    assert.deepEqual(appStateRow(database), { payload: "changed", updatedAt: 999 });
    assert.deepEqual(persistence.readRuntimeState(), after);
  } finally {
    database.close();
  }
});

test("ordinary app_state commits can atomically reconcile and advance the rollback guard", () => {
  const database = databaseWithAppState(JSON.stringify({ generation: 1 }), 10);
  try {
    const before = runtimeFixture();
    const after = structuredClone(before);
    after.players[PLAYER_A].lastSeenAt = 1_500;
    after.dailyMetrics["2026-08-13"].requests += 1;
    const persistence = new SqliteRuntimeStatePersistence(database);
    persistence.initialize(before, {
      appStateUpdatedAt: 10,
      appStateFingerprint: runtimeAppStateFingerprint(JSON.stringify({ generation: 1 })),
    });
    const plan = createRuntimeStatePersistencePlan(before, after, { operation: "account.update" });
    assert.equal(plan.kind, "reconcile");
    assert.equal(plan.canSkipAppState, false);
    database.transaction(() => {
      database.prepare("UPDATE app_state SET payload = ?, updated_at = ? WHERE id = 1").run(JSON.stringify({ generation: 2 }), 11);
      persistence.applyPlanInTransaction(plan, { synchronizeAppState: true });
    })();

    const restarted = new SqliteRuntimeStatePersistence(database);
    assert.deepEqual(restarted.initialize({ players: { stale: true } }, {
      appStateUpdatedAt: 11,
      appStateFingerprint: runtimeAppStateFingerprint(JSON.stringify({ generation: 2 })),
    }), { initialized: false, seededRecords: 0, version: 1 });
    assert.deepEqual(restarted.readRuntimeState(), after);
  } finally {
    database.close();
  }
});

test("fault injection leaves every runtime row unchanged and reports a failed commit", () => {
  const database = databaseWithAppState();
  try {
    const before = runtimeFixture();
    const after = structuredClone(before);
    after.players[PLAYER_A].lastSeenAt = 700;
    after.dailyMetrics["2026-08-13"].requests += 1;
    const persistence = new SqliteRuntimeStatePersistence(database, {
      faultInjector({ phase }) {
        if (phase === "after-runtime-upserts") throw new Error("synthetic runtime failure");
      },
    });
    persistence.initialize(before);
    const plan = createRuntimeStatePersistencePlan(before, after, {
      operation: "presence.touch",
      runtimeIndexEvents: [{ type: "presence", playerHash: PLAYER_A }],
    });
    assert.throws(() => persistence.commitPlan(plan), /synthetic runtime failure/);
    assert.deepEqual(persistence.readRuntimeState(), before);
    assert.equal(persistence.diagnostics().failures, 1);
  } finally {
    database.close();
  }
});

test("full reconciliation applies retention deletions and survives a SQLite restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-runtime-state-restart-"));
  const file = path.join(directory, "runtime.sqlite");
  let database = databaseWithAppState(JSON.stringify({ marker: "unchanged" }), 77, file);
  const before = runtimeFixture();
  before.players[PLAYER_B] = { firstSeenAt: 1, lastSeenAt: 2, lastActiveDay: "2026-01-01" };
  before.dailyMetrics["2026-01-01"] = { requests: 1, errors: 0, feedback: 0, leaderboardSubmissions: 0, cloudUploads: 0, players: 1 };
  before.analytics.daily["2026-01-01"] = {
    uniqueVisitors: 0, sessions: 0, pageViews: 1, gameStarts: 0, activeSeconds: 0,
    events: { page_view: 1 }, clients: {}, sources: {},
  };
  const retained = structuredClone(before);
  delete retained.players[PLAYER_B];
  delete retained.dailyMetrics["2026-01-01"];
  delete retained.analytics.daily["2026-01-01"];
  try {
    const first = new SqliteRuntimeStatePersistence(database);
    first.initialize(before);
    const plan = createRuntimeStatePersistencePlan(before, retained, {
      operation: "periodic.cleanup",
      reconcileAll: true,
    });
    assert.equal(plan.canSkipAppState, false);
    assert.equal(plan.deletes.length, 3);
    assert.throws(
      () => first.commitPlan(plan),
      (error) => error instanceof RuntimeStatePersistenceError && error.code === "RUNTIME_STATE_APP_STATE_REQUIRED",
    );
    database.transaction(() => {
      database.prepare("UPDATE app_state SET payload = ?, updated_at = ? WHERE id = 1").run(JSON.stringify({ retained: true }), 78);
      first.applyPlanInTransaction(plan, { synchronizeAppState: true });
    })();

    database.close();
    database = new Database(file);
    const restarted = new SqliteRuntimeStatePersistence(database);
    restarted.initialize(retained, {
      appStateUpdatedAt: 78,
      appStateFingerprint: runtimeAppStateFingerprint(JSON.stringify({ retained: true })),
    });
    assert.deepEqual(restarted.readRuntimeState(), retained);
    assert.deepEqual(restarted.diagnostics({ includeRowCounts: true }).rows, {
      analytics_daily: 1,
      analytics_session: 1,
      analytics_visitor: 1,
      player: 1,
      service_daily: 1,
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a changed app_state fingerprint atomically reseeds stale runtime rows for rollback safety", () => {
  const database = databaseWithAppState(JSON.stringify({ generation: 1 }), 100);
  try {
    const original = runtimeFixture();
    const persistence = new SqliteRuntimeStatePersistence(database, { nowProvider: () => 100 });
    persistence.initialize(original, {
      appStateUpdatedAt: 100,
      appStateFingerprint: runtimeAppStateFingerprint(JSON.stringify({ generation: 1 })),
    });

    const newer = structuredClone(original);
    newer.players[PLAYER_A].lastSeenAt = 999;
    newer.dailyMetrics["2026-08-13"].requests = 99;
    database.prepare("UPDATE app_state SET payload = ?, updated_at = ? WHERE id = 1").run(JSON.stringify({ generation: 2 }), 100);
    const restarted = new SqliteRuntimeStatePersistence(database, { nowProvider: () => 200 });
    assert.deepEqual(restarted.initialize(newer, {
      appStateUpdatedAt: 100,
      appStateFingerprint: runtimeAppStateFingerprint(JSON.stringify({ generation: 2 })),
    }), {
      initialized: false,
      reseeded: true,
      seededRecords: 5,
      version: 1,
    });
    assert.deepEqual(restarted.readRuntimeState(), newer);
  } finally {
    database.close();
  }
});

test("rejects unsafe keys, oversized records, missing dirty events and out-of-transaction writes", () => {
  const before = runtimeFixture();
  const after = structuredClone(before);
  after.players[PLAYER_A].lastSeenAt += 1;
  assert.throws(
    () => createRuntimeStatePersistencePlan(before, after, { operation: "presence.touch" }),
    (error) => error instanceof RuntimeStatePersistenceError && error.code === "RUNTIME_STATE_EVENT_REQUIRED",
  );
  after.analytics.daily["2026-08-13"].events = { huge: "x".repeat(70 * 1024) };
  assert.throws(
    () => createRuntimeStatePersistencePlan(before, after, { operation: "analytics.record" }),
    (error) => error instanceof RuntimeStatePersistenceError && error.code === "RUNTIME_STATE_RECORD_TOO_LARGE",
  );

  const database = databaseWithAppState();
  try {
    const persistence = new SqliteRuntimeStatePersistence(database);
    persistence.initialize(before);
    assert.throws(
      () => persistence.applyPlanInTransaction({ version: 1, upserts: [], deletes: [] }),
      (error) => error instanceof RuntimeStatePersistenceError && error.code === "RUNTIME_STATE_TRANSACTION_REQUIRED",
    );
    database.prepare(`UPDATE ${RUNTIME_STATE_RECORDS_TABLE} SET payload = 'null' WHERE namespace = ? LIMIT 1`).run(RUNTIME_STATE_NAMESPACES.player);
    assert.throws(
      () => persistence.readRuntimeState(),
      (error) => error instanceof RuntimeStatePersistenceError && error.code === "RUNTIME_STATE_ROW_INVALID",
    );
  } finally {
    database.close();
  }
});
