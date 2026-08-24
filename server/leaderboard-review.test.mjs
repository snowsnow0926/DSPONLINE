import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveLeaderboardReview,
  clearLeaderboardReview,
  getLeaderboardReview,
  isLeaderboardReviewApproved,
  leaderboardReviewFingerprint,
  leaderboardReviewReport,
  normalizeLeaderboardReviewQueue,
  pendingLeaderboardReviewEntries,
  publicLeaderboardReviewRecord,
  queueLeaderboardReview,
} from "./leaderboard-review.mjs";

const findings = [{ code: "EXTREME_PRODUCTION_WITHOUT_ENTITIES", severity: "freeze" }];

function dataFixture() {
  return {
    users: {
      target: { id: "target", username: "target", displayName: "Target" },
    },
    submissions: {
      "season_01:target": {
        userId: "target",
        verification: { cloudRevision: 12 },
        metrics: { peakWhiteMatrixPerMinute: 1234 },
      },
    },
    leaderboardReviewQueue: {},
  };
}

test("queues an integrity finding without creating a restriction and deduplicates the same revision", () => {
  const data = dataFixture();
  const first = queueLeaderboardReview(data, "target", {
    source: "leaderboard-integrity-v1",
    revision: 12,
    checksum: "a".repeat(64),
    findings,
    now: 100,
  });
  assert.equal(first.changed, true);
  assert.equal(first.status, "pending");
  assert.equal(data.leaderboardModeration, undefined);
  const second = queueLeaderboardReview(data, "target", {
    source: "leaderboard-integrity-v1",
    revision: 12,
    checksum: "a".repeat(64),
    findings,
    now: 200,
  });
  assert.equal(second.changed, false);
  assert.equal(getLeaderboardReview(data, "target").occurrences, 1);
  assert.deepEqual(pendingLeaderboardReviewEntries(data).map((entry) => entry.userId), ["target"]);
});

test("a newer finding reopens an approved review and approval is revision-bound", () => {
  const data = dataFixture();
  queueLeaderboardReview(data, "target", {
    source: "leaderboard-integrity-v1",
    revision: 12,
    findings,
    now: 100,
  });
  const fingerprint = leaderboardReviewFingerprint(findings);
  const approved = approveLeaderboardReview(data, "target", { revision: 12, fingerprint, now: 150 });
  assert.equal(approved.status, "approved");
  assert.equal(isLeaderboardReviewApproved(data, "target", { revision: 12, fingerprint }), true);
  assert.equal(pendingLeaderboardReviewEntries(data).length, 0);
  queueLeaderboardReview(data, "target", {
    source: "leaderboard-integrity-v1",
    revision: 13,
    findings,
    now: 200,
  });
  assert.equal(getLeaderboardReview(data, "target").status, "pending");
  assert.equal(getLeaderboardReview(data, "target").occurrences, 2);
});

test("normalizes only account-bound pending and approved records", () => {
  const normalized = normalizeLeaderboardReviewQueue({
    target: {
      status: "pending",
      reasonCode: "SAVE_DATA_INTEGRITY",
      source: "leaderboard-integrity-v1",
      detectedRevision: 2,
      firstDetectedAt: 1,
      lastDetectedAt: 2,
      findings,
    },
    unknown: {
      status: "pending",
      reasonCode: "SAVE_DATA_INTEGRITY",
      source: "leaderboard-integrity-v1",
      detectedRevision: 2,
      findings,
    },
    invalid: {
      status: "blocked",
      reasonCode: "SAVE_DATA_INTEGRITY",
      source: "leaderboard-integrity-v1",
      detectedRevision: 2,
      findings,
    },
  }, { target: { id: "target" } });
  assert.deepEqual(Object.keys(normalized), ["target"]);
  assert.equal(normalized.target.status, "pending");
});

test("report is admin-safe and clearing a review is idempotent", () => {
  const data = dataFixture();
  queueLeaderboardReview(data, "target", {
    source: "leaderboard-integrity-v1",
    revision: 12,
    checksum: "b".repeat(64),
    findings,
    now: 100,
  });
  const record = publicLeaderboardReviewRecord(data, "target");
  assert.equal(record.detectedChecksumPrefix, "bbbbbbbbbbbb");
  assert.equal(record.detectedChecksum, undefined);
  assert.equal(leaderboardReviewReport(data).pendingCount, 1);
  assert.equal(clearLeaderboardReview(data, "target"), true);
  assert.equal(clearLeaderboardReview(data, "target"), false);
});
