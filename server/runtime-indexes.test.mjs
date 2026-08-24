import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RUNTIME_RETENTION_POLICY,
  LeaderboardSnapshotIndex,
  PresenceIndex,
  RuntimeMetricsAggregator,
  applyRuntimeRetentionPolicy,
  auditRetentionClass,
} from "./runtime-indexes.mjs";

const CATEGORIES = ["power", "upload", "white-rate", "dyson", "throughput", "galaxy"];
const METRIC_KEYS = {
  power: "energyGeneratedMj",
  upload: "uploadedWhiteMatrix",
  "white-rate": "peakWhiteMatrixPerMinute",
  dyson: "peakDysonPowerKw",
  throughput: "peakThroughputPerMinute",
  galaxy: "galaxyScore",
};

function normalizeMetrics(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(Object.values(METRIC_KEYS).map((key) => [key, Number.isFinite(source[key]) ? Math.max(0, source[key]) : 0]));
}

function categoryValue(metrics, category) {
  return metrics[METRIC_KEYS[category]] ?? 0;
}

function restricted(data, userId) {
  return data.restricted?.[userId] === true;
}

function syntheticLeaderboardData(count, { seasons = ["season_01"], ties = false } = {}) {
  const data = { users: {}, submissions: {}, restricted: {} };
  for (let index = 0; index < count; index += 1) {
    const userId = `user_${String(index).padStart(5, "0")}`;
    const seasonId = seasons[index % seasons.length];
    const value = ties ? index % 7 : count - index;
    data.users[userId] = { leaderboardVisible: true, privateEmail: `${userId}@invalid.test`, bearerToken: `secret-${userId}` };
    data.submissions[`${seasonId}:${userId}`] = {
      userId,
      accountId: userId,
      displayName: `玩家 ${index}`,
      avatar: "A",
      seasonId,
      submittedAt: index,
      visible: true,
      metrics: {
        energyGeneratedMj: value * 2,
        uploadedWhiteMatrix: value * 3,
        peakWhiteMatrixPerMinute: value * 5,
        peakDysonPowerKw: value * 7,
        peakThroughputPerMinute: value * 11,
        galaxyScore: value * 13,
      },
      verification: { cloudRevision: index + 1, checksum: `private-${userId}` },
      privatePayload: `payload-${userId}`,
    };
  }
  return data;
}

function createLeaderboardIndex(data) {
  return new LeaderboardSnapshotIndex({
    getAuthoritativeData: () => data,
    categories: CATEGORIES,
    normalizeMetrics,
    categoryValue,
    isRestricted: restricted,
  });
}

function referenceEntries(data, category, seasonId) {
  return Object.values(data.submissions)
    .filter((entry) => entry.seasonId === seasonId && entry.visible !== false &&
      data.users[entry.userId]?.leaderboardVisible !== false && !restricted(data, entry.userId))
    .map((entry) => {
      const metrics = normalizeMetrics(entry.metrics);
      return { ...entry, metrics, value: categoryValue(metrics, category), verified: Boolean(entry.verification?.cloudRevision) };
    })
    .sort((left, right) => right.value - left.value || left.userId.localeCompare(right.userId));
}

function shanghaiTimestamp(value) {
  return Date.parse(`${value}+08:00`);
}

test("presence cold rebuild matches the existing full-scan metrics for 1/150/1000/10000 accounts", () => {
  const now = shanghaiTimestamp("2026-08-13T12:00:00");
  for (const count of [1, 150, 1_000, 10_000]) {
    const players = {};
    for (let index = 0; index < count; index += 1) {
      const lastSeenAt = now - index % 240 * 1_000;
      players[`player_${String(index).padStart(5, "0")}`] = {
        firstSeenAt: now - 86_400_000,
        lastSeenAt,
        lastActiveDay: index % 11 === 0 ? "2026-08-12" : "2026-08-13",
      };
    }
    const expected = {
      total: count,
      today: Object.values(players).filter((record) => record.lastActiveDay === "2026-08-13").length,
      online: Object.values(players).filter((record) => record.lastSeenAt >= now - 120_000).length,
      onlineWindowSeconds: 120,
    };
    const index = new PresenceIndex({ onlineWindowMs: 120_000, timeZone: "Asia/Shanghai" });
    assert.deepEqual(index.rebuild(players, now), expected);
    const diagnostics = index.diagnostics();
    assert.equal(diagnostics.rebuildRecordsVisited, count);
    assert.equal(diagnostics.records, count);
  }
});

test("presence heartbeat uses expiry heap and daily unique increments without scanning every player", () => {
  const start = shanghaiTimestamp("2026-08-13T10:00:00");
  const players = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [
    `player_${index}`,
    { firstSeenAt: start - 1_000, lastSeenAt: start - index % 60 * 1_000, lastActiveDay: "2026-08-13" },
  ]));
  const index = new PresenceIndex({ onlineWindowMs: 120_000 });
  index.rebuild(players, start);
  const before = index.diagnostics();
  const touched = index.heartbeat("player_9999", start + 30_000);
  assert.equal(touched.created, false);
  assert.equal(touched.dayChanged, false);
  assert.equal(touched.dailyUniqueIncrement, 0);
  assert.equal(index.diagnostics().rebuildRecordsVisited, before.rebuildRecordsVisited);
  assert.equal(index.diagnostics().heartbeats, 1);

  const atBoundary = index.metrics(start + 120_000);
  const expectedAtBoundary = Object.entries(players).filter(([playerKey, record]) =>
    (playerKey === "player_9999" ? start + 30_000 : record.lastSeenAt) >= start).length;
  assert.equal(atBoundary.online, expectedAtBoundary, "lastSeenAt exactly on the inclusive window boundary stays online");
  const afterBoundary = index.metrics(start + 120_001);
  assert.equal(afterBoundary.online, 1, "only the refreshed player remains online after all original expiries pass");
  assert.ok(index.diagnostics().expired > 0);
});

test("presence handles Asia/Shanghai day rollover and out-of-order heartbeat clocks safely", () => {
  const beforeMidnight = shanghaiTimestamp("2026-08-13T23:59:59.500");
  const afterMidnight = shanghaiTimestamp("2026-08-14T00:00:00.500");
  const index = new PresenceIndex({ onlineWindowMs: 120_000, timeZone: "Asia/Shanghai" });
  const first = index.heartbeat("player-a", beforeMidnight);
  assert.equal(first.created, true);
  assert.equal(first.dailyUniqueIncrement, 1);
  assert.deepEqual(first.metrics, { total: 1, today: 1, online: 1, onlineWindowSeconds: 120 });
  const next = index.heartbeat("player-a", afterMidnight);
  assert.equal(next.dayChanged, true);
  assert.equal(next.dailyUniqueIncrement, 1);
  assert.equal(next.record.lastActiveDay, "2026-08-14");
  assert.equal(next.metrics.today, 1);
  const stale = index.heartbeat("player-a", beforeMidnight);
  assert.equal(stale.record.lastSeenAt, afterMidnight);
  assert.equal(stale.record.lastActiveDay, "2026-08-14");
  assert.equal(stale.dailyUniqueIncrement, 0);
});

test("leaderboard cold snapshots match the current authoritative sort at 1/150/1000/10000 accounts", () => {
  for (const count of [1, 150, 1_000, 10_000]) {
    const data = syntheticLeaderboardData(count, { ties: true });
    const index = createLeaderboardIndex(data);
    for (const category of CATEGORIES) {
      const expected = referenceEntries(data, category, "season_01");
      const actual = index.getSnapshot(category, "season_01").entries;
      assert.deepEqual(actual.map((entry) => [entry.userId, entry.value]), expected.map((entry) => [entry.userId, entry.value]));
    }
    const metrics = index.metrics();
    assert.equal(metrics.coldRebuilds, 1);
    assert.equal(metrics.indexedUsers, count);
  }
});

test("leaderboard snapshots are stable cache hits until an authorized state transition invalidates the season", () => {
  const data = syntheticLeaderboardData(150);
  const index = createLeaderboardIndex(data);
  const first = index.getSnapshot("galaxy", "season_01");
  const second = index.getSnapshot("galaxy", "season_01");
  assert.equal(first, second);
  assert.equal(index.metrics().hits, 1);
  assert.equal(index.metrics().snapshotBuilds, 1);

  const user = "user_00149";
  data.submissions[`season_01:${user}`].metrics.galaxyScore = 1_000_000;
  assert.equal(index.getSnapshot("galaxy", "season_01"), first, "authoritative mutation is invisible until its transaction emits invalidation");
  index.markSubmissionChanged({ userId: user, seasonId: "season_01" });
  const updated = index.getSnapshot("galaxy", "season_01");
  assert.notEqual(updated, first);
  assert.equal(updated.entries[0].userId, user);

  data.users[user].leaderboardVisible = false;
  index.markVisibilityChanged(user);
  assert.equal(index.getUserRank("galaxy", "season_01", user), null);
  data.users[user].leaderboardVisible = true;
  data.restricted[user] = true;
  index.markRestrictionChanged(user);
  assert.equal(index.getUserRank("galaxy", "season_01", user), null);
  delete data.restricted[user];
  index.markRevalidationChanged(user);
  assert.ok(index.getUserRank("galaxy", "season_01", user));
  assert.deepEqual(index.metrics().invalidationsByReason, {
    submission: 1,
    visibility: 1,
    restriction: 1,
    revalidation: 1,
    account: 0,
    rebuild: 0,
    other: 0,
  });
});

test("leaderboard invalidation is season-scoped and a cold restart rebuilds the same business result", () => {
  const data = syntheticLeaderboardData(1_000, { seasons: ["season_00", "season_01"], ties: true });
  const index = createLeaderboardIndex(data);
  const oldSeason = index.getSnapshot("throughput", "season_00");
  const currentSeason = index.getSnapshot("throughput", "season_01");
  const target = currentSeason.entries.at(-1).userId;
  data.submissions[`season_01:${target}`].metrics.peakThroughputPerMinute = 99_000_000;
  index.markSubmissionChanged({ userId: target, seasonId: "season_01" });
  assert.equal(index.getSnapshot("throughput", "season_00"), oldSeason);
  const refreshed = index.getSnapshot("throughput", "season_01");
  assert.notEqual(refreshed, currentSeason);
  assert.equal(refreshed.entries[0].userId, target);

  const restarted = createLeaderboardIndex(data);
  assert.deepEqual(
    restarted.getSnapshot("throughput", "season_01").entries.map((entry) => [entry.userId, entry.value]),
    refreshed.entries.map((entry) => [entry.userId, entry.value]),
  );
});

test("public Top 100 and authenticated /me rank share one snapshot, including rank 150", () => {
  const data = syntheticLeaderboardData(150);
  const index = createLeaderboardIndex(data);
  const publicPage = index.getPublicPage("galaxy", "season_01", {
    limit: 100,
    project: (entry, rank) => ({ publicId: `public_${entry.userId.slice(5)}`, displayName: entry.displayName, value: entry.value, rank }),
  });
  assert.equal(publicPage.entries.length, 100);
  assert.equal(publicPage.totalEntries, 150);
  assert.equal(publicPage.entries[0].rank, 1);
  assert.equal(publicPage.entries.at(-1).rank, 100);
  const own = index.getUserEntry("galaxy", "season_01", "user_00149");
  assert.equal(own.rank, 150);
  assert.equal(own.value, (publicPage.totalEntries - own.rank + 1) * 13);
  assert.equal(index.getUserRank("galaxy", "season_01", publicPage.entries[42].publicId.replace("public_", "user_")), 43);
});

test("public leaderboard projector receives no private account container and can produce a privacy-safe shape", () => {
  const data = syntheticLeaderboardData(150);
  const index = createLeaderboardIndex(data);
  assert.throws(() => index.getPublicPage("galaxy", "season_01"), /projector/);
  const result = index.getPublicPage("galaxy", "season_01", {
    project: (entry, rank) => ({ rank, displayName: entry.displayName, score: entry.value }),
  });
  const serialized = JSON.stringify(result);
  for (const privateMarker of ["privateEmail", "bearerToken", "privatePayload", "checksum", "verification", "accountId", "userId"]) {
    assert.equal(serialized.includes(privateMarker), false, `${privateMarker} must stay outside the projected public response`);
  }
  assert.equal(result.entries.length, 100);
});

test("retention policy keeps day windows across leap-day/time-zone boundaries and does not mutate source", () => {
  const now = shanghaiTimestamp("2028-03-01T00:30:00");
  const source = {
    dailyMetrics: {
      "2028-02-27": { requests: 1 },
      "2028-02-28": {
        requests: 2,
        players: 4,
        playersEstimate: 9,
        playersEstimateObserved: 4,
        playersEstimateMeta: {
          version: 1,
          method: "analytics-uv-presence-ratio-v1",
          planHash: "a".repeat(64),
          status: "full-day-projection",
          confidence: "low",
        },
      },
      "2028-02-29": { requests: 3 },
      "2028-03-01": { requests: 4 },
      invalid: { requests: 999 },
    },
    analytics: {
      visitors: {}, sessions: {},
      daily: {
        "2028-02-28": { pageViews: 2 },
        "2028-02-29": { pageViews: 3 },
        "2028-03-01": { pageViews: 4 },
      },
    },
    errors: [], auditLog: [],
  };
  const original = structuredClone(source);
  const result = applyRuntimeRetentionPolicy(source, {
    now,
    timeZone: "Asia/Shanghai",
    policy: { ...DEFAULT_RUNTIME_RETENTION_POLICY, dailyMetricsDays: 3, analyticsDailyDays: 2 },
  });
  assert.deepEqual(Object.keys(result.retained.dailyMetrics), ["2028-02-28", "2028-02-29", "2028-03-01"]);
  assert.deepEqual(Object.keys(result.retained.analytics.daily), ["2028-02-29", "2028-03-01"]);
  assert.deepEqual(result.retained.dailyMetrics["2028-02-28"], source.dailyMetrics["2028-02-28"]);
  assert.deepEqual(source, original);
  assert.equal(result.report.today, "2028-03-01");
});

test("retention aggregates expired raw errors by bounded category without retaining diagnostics or messages", () => {
  const now = shanghaiTimestamp("2026-08-13T12:00:00");
  const day = 86_400_000;
  const source = {
    dailyMetrics: {},
    analytics: { visitors: {}, sessions: {}, daily: {} },
    errors: [
      { receivedAt: now - 45 * day, kind: "cloud-upload", message: "secret-token", diagnostics: { email: "private@example.com" } },
      { receivedAt: now - 40 * day, kind: "react-render", message: "private-player-message" },
      { receivedAt: now - day, kind: "client-error", message: "recent-message" },
    ],
    errorSummaries: { "2026-07-01": { total: 2, kinds: { "totally-custom-private-kind": 2 } } },
    auditLog: [],
  };
  const result = applyRuntimeRetentionPolicy(source, { now });
  assert.equal(result.retained.errors.length, 1);
  const serialized = JSON.stringify(result.retained.errorSummaries);
  for (const secret of ["secret-token", "private@example.com", "private-player-message", "totally-custom-private-kind"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serialized, /cloud/);
  assert.match(serialized, /render/);
  assert.match(serialized, /other/);
});

test("ordinary and security audit retention use independent age/count limits", () => {
  const now = shanghaiTimestamp("2026-08-13T12:00:00");
  const day = 86_400_000;
  const auditLog = [
    ...Array.from({ length: 5 }, (_, index) => ({ action: `cloud.save_${index}`, occurredAt: now - index * day })),
    ...Array.from({ length: 5 }, (_, index) => ({ action: `account.password_changed`, occurredAt: now - index * 100 * day, marker: `security-${index}` })),
  ];
  const result = applyRuntimeRetentionPolicy({
    dailyMetrics: {}, analytics: { visitors: {}, sessions: {}, daily: {} }, errors: [], auditLog,
  }, {
    now,
    policy: {
      ...DEFAULT_RUNTIME_RETENTION_POLICY,
      ordinaryAuditDays: 3,
      ordinaryAuditLimit: 2,
      securityAuditDays: 500,
      securityAuditLimit: 4,
    },
  });
  assert.equal(result.report.retained.ordinaryAudit, 2);
  assert.equal(result.report.retained.securityAudit, 4);
  assert.equal(result.retained.auditLog.filter((entry) => entry.marker?.startsWith("security-")).length, 4);
  assert.equal(auditRetentionClass("leaderboard.integrity_frozen"), "security");
  assert.equal(auditRetentionClass("admin.account_restrict_leaderboard"), "security");
  assert.equal(auditRetentionClass("cloud.save_deleted"), "ordinary");
});

test("retention expires visitor/session identities separately and reports deterministic counts", () => {
  const now = shanghaiTimestamp("2026-08-13T12:00:00");
  const day = 86_400_000;
  const result = applyRuntimeRetentionPolicy({
    dailyMetrics: {},
    analytics: {
      visitors: {
        recent: { lastSeenAt: now - 10 * day },
        old: { lastSeenAt: now - 200 * day },
      },
      sessions: {
        recent: { lastSeenAt: now - 10 * day },
        old: { lastSeenAt: now - 31 * day },
      },
      daily: {},
    },
    errors: [], auditLog: [],
  }, { now });
  assert.deepEqual(Object.keys(result.retained.analytics.visitors), ["recent"]);
  assert.deepEqual(Object.keys(result.retained.analytics.sessions), ["recent"]);
  assert.equal(result.report.removed.visitors, 1);
  assert.equal(result.report.removed.sessions, 1);
});

test("runtime metrics expose fixed-cardinality latency/event-loop/memory/sqlite/upload/archive/cache aggregates only", () => {
  const metrics = new RuntimeMetricsAggregator();
  metrics.observeRequest({ durationMs: 4, statusCode: 200, route: "/api/private/user-1", token: "secret" });
  metrics.observeRequest({ durationMs: 1_200, statusCode: 500, error: new Error("private@example.com") });
  metrics.observeRequest({ durationMs: 45, statusCode: 429 });
  metrics.observeEventLoopDelay(12);
  metrics.observeEventLoopDelay(120);
  metrics.sampleMemory({ rss: 1_000, heapUsed: 600, heapTotal: 800, external: 20, arrayBuffers: 10, privatePath: "C:\\secret" });
  metrics.sampleMemory({ rss: 1_200, heapUsed: 550, heapTotal: 900, external: 30, arrayBuffers: 15 });
  metrics.observeSqliteCommit({ durationMs: 8, ok: true, queueDepth: 2, databasePath: "/private/cloud.sqlite" });
  metrics.observeSqliteCommit({ durationMs: 30, ok: false, errorCategory: "io", queueDepth: 4, message: "private body" });
  metrics.observeUploadSnapshot({
    active: 2, queued: 3, maxQueued: 7, completed: 10, failed: 1, maxExpandedBytes: 30 * 1024 * 1024,
    rejectionReasons: { saveFormatInvalid: 4, "private-user-reason": 99 },
  });
  metrics.observeArchiveTask({ operation: "export", status: "completed", durationMs: 500, bytes: 10_000, active: 1, filename: "private.zip" });
  metrics.observeArchiveTask({ operation: "import", status: "cancelled", durationMs: 100, bytes: 5_000 });
  metrics.observeLeaderboardCache({ hits: 9, misses: 1, snapshotBuilds: 1, invalidations: 2, liveSnapshots: 6, indexedEntries: 1_000, userId: "private-user" });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.requests.total, 3);
  assert.equal(snapshot.requests.errors, 1);
  assert.equal(snapshot.requests.rateLimited, 1);
  assert.equal(snapshot.requests.latencyMs.count, 3);
  assert.equal(snapshot.eventLoop.delayMs.count, 2);
  assert.equal(snapshot.memory.latest.rssBytes, 1_200);
  assert.equal(snapshot.memory.peak.heapUsedBytes, 600);
  assert.equal(snapshot.sqlite.commits, 1);
  assert.equal(snapshot.sqlite.failures, 1);
  assert.equal(snapshot.sqlite.errors.io, 1);
  assert.equal(snapshot.upload.rejectionReasons.saveFormatInvalid, 4);
  assert.equal(snapshot.upload.rejectionReasons.other, 99);
  assert.equal(snapshot.archive.export.completed, 1);
  assert.equal(snapshot.archive.import.cancelled, 1);
  assert.equal(snapshot.cache.leaderboard.hitRatio, 0.9);
  const serialized = JSON.stringify(snapshot);
  for (const privateMarker of ["secret", "private", "userId", "token", "checksum", "filename", "route", "databasePath", "message"]) {
    assert.equal(serialized.includes(privateMarker), false, `${privateMarker} must not enter operational metrics`);
  }
});

test("runtime metric snapshots are detached and histogram memory stays bounded", () => {
  const metrics = new RuntimeMetricsAggregator();
  for (let index = 0; index < 100_000; index += 1) metrics.observeRequest({ durationMs: index % 20_000, statusCode: 200 });
  const first = metrics.snapshot();
  assert.equal(first.requests.latencyMs.count, 100_000);
  assert.equal(first.requests.latencyMs.buckets.length, 13);
  first.requests.status["2xx"] = 0;
  first.requests.latencyMs.buckets[0].count = 0;
  const second = metrics.snapshot();
  assert.equal(second.requests.status["2xx"], 100_000);
  assert.ok(second.requests.latencyMs.buckets[0].count > 0);
});

test("invalid time zones and unknown leaderboard keys fail closed", () => {
  assert.throws(() => new PresenceIndex({ timeZone: "Not/A-Time-Zone" }), RangeError);
  const data = syntheticLeaderboardData(1);
  const index = createLeaderboardIndex(data);
  assert.throws(() => index.getSnapshot("private-category", "season_01"), /category/);
  assert.throws(() => index.getSnapshot("galaxy", ""), /season/);
});
