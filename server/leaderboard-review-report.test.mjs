import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  readLeaderboardReviewReport,
  writeLeaderboardReviewReport,
} from "./leaderboard-review-report.mjs";

function reviewRecord() {
  return {
    status: "pending",
    reasonCode: "SAVE_DATA_INTEGRITY",
    source: "leaderboard-integrity-v4",
    mode: "normal",
    firstDetectedAt: 1_000,
    lastDetectedAt: 2_000,
    detectedRevision: 7,
    detectedChecksum: "a".repeat(64),
    occurrences: 2,
    findings: [{ code: "EXTREME_PRODUCTION_WITHOUT_ENTITIES", severity: "freeze" }],
    fingerprint: "b".repeat(64),
  };
}

test("readLeaderboardReviewReport reads the queue without exposing full checksums", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-review-report-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  const database = new Database(databaseFile);
  database.exec("CREATE TABLE app_state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  database.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, ?)").run(JSON.stringify({
    schemaVersion: 8,
    storageLayoutVersion: 3,
    users: { user_123: { id: "user_123", username: "pilot", displayName: "复核账号" } },
    leaderboardReviewQueue: { user_123: reviewRecord() },
    submissions: {
      "season:user_123": {
        userId: "user_123",
        verification: { cloudRevision: 6, checksum: "c".repeat(64) },
        metrics: { peakWhiteMatrixPerMinute: 123 },
      },
    },
  }), 3_000);
  database.close();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const report = readLeaderboardReviewReport({ databaseFile, generatedAt: 4_000 });
  assert.equal(report.pendingCount, 1);
  assert.equal(report.entries[0].accountId, "user_123");
  assert.equal(report.entries[0].detectedChecksumPrefix, "a".repeat(12));
  assert.equal(Object.hasOwn(report.entries[0], "detectedChecksum"), false);
  assert.equal(report.policy.automaticRestriction, false);
  assert.equal(report.database.updatedAt, 3_000);
});

test("writeLeaderboardReviewReport atomically writes a dated report and latest pointer", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-review-report-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await writeLeaderboardReviewReport({
    report: { generatedAt: Date.UTC(2026, 7, 21, 14, 0, 0), pendingCount: 0, entries: [] },
    outputDirectory: directory,
  });
  assert.ok(result.output.endsWith(".json"));
  assert.ok(result.latest.endsWith("leaderboard-review-latest.json"));
  assert.deepEqual(JSON.parse(await readFile(result.latest, "utf8")), { generatedAt: Date.UTC(2026, 7, 21, 14, 0, 0), pendingCount: 0, entries: [] });
});

test("writeLeaderboardReviewReport prunes only dated reports beyond retention", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-review-report-retain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = { generatedAt: Date.UTC(2026, 7, 21, 14, 0, 0), pendingCount: 0, entries: [] };
  const second = { generatedAt: Date.UTC(2026, 7, 21, 15, 0, 0), pendingCount: 1, entries: [{ fingerprint: "f" }] };
  await writeLeaderboardReviewReport({ report: first, outputDirectory: directory, retain: 30 });
  await writeLeaderboardReviewReport({ report: second, outputDirectory: directory, retain: 1 });
  const files = (await readdir(directory)).sort();
  assert.deepEqual(files, [
    "leaderboard-review-2026-08-21T150000Z.json",
    "leaderboard-review-latest.json",
  ]);
});
