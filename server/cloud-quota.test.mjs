import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cloudQuotaRecords,
  cloudQuotaSnapshot,
  normalizeCloudQuotaPolicy,
  planCloudSaveUpload,
} from "./cloud-quota.mjs";

function save(revision, size = 100, checksum = (size * 1_000 + revision).toString(16).padStart(64, "0")) {
  return { revision, size, checksum, updatedAt: revision };
}

function fixture() {
  return {
    users: { user_a: { id: "user_a" } },
    cloudSaves: { user_a: save(3) },
    cloudSaveHistory: { user_a: [save(1), save(2), save(3)] },
    cloudSaveSlots: { user_a: { "1": save(1, 120) } },
    cloudSaveSlotHistory: { user_a: { "1": [save(1, 120)] } },
    cloudSavesByMode: { user_a: { speedrun: save(2, 80) } },
    cloudSaveHistoryByMode: { user_a: { speedrun: [save(1, 80), save(2, 80)] } },
    cloudSaveSlotsByMode: {},
    cloudSaveSlotHistoryByMode: {},
  };
}

test("counts normal and speedrun slots once and reports logical versus unique bytes", () => {
  const data = fixture();
  data.cloudSaveHistory.user_a[1].checksum = data.cloudSaveHistory.user_a[0].checksum;
  const records = cloudQuotaRecords(data, "user_a");
  assert.equal(records.length, 6);
  const snapshot = cloudQuotaSnapshot(data, "user_a", {
    revisionBytes: 1_000,
    slotBytes: 1_000,
    modeBytes: 2_000,
    accountBytes: 3_000,
    historyRevisions: 20,
  });
  assert.equal(snapshot.usage.logicalBytes, 580);
  assert.equal(snapshot.usage.uniquePayloadBytes, 480);
  assert.equal(snapshot.usage.modes.normal.slots.main.revisionCount, 3);
  assert.equal(snapshot.usage.modes.speedrun.slots.main.revisionCount, 2);
});

test("prunes only the oldest target-slot revisions and keeps the latest adjacent revision", () => {
  const data = fixture();
  const plan = planCloudSaveUpload(data, "user_a", "normal", "main", { size: 250, checksum: "f".repeat(64) }, {
    revisionBytes: 300,
    slotBytes: 350,
    modeBytes: 700,
    accountBytes: 1_000,
    historyRevisions: 3,
  });
  assert.equal(plan.accepted, true);
  assert.deepEqual(plan.prune.revisions, [1, 2]);
  assert.equal(plan.projected.slotLogicalBytes, 350);
  assert.equal(plan.projected.slotRevisionCount, 2);
  assert.equal(plan.prune.revisions.includes(3), false);
  assert.equal(data.cloudSaveHistory.user_a.length, 3, "planning must be read-only");
});

test("accepts exact boundaries and rejects an impossible account limit without cross-slot deletion", () => {
  const data = fixture();
  const exact = planCloudSaveUpload(data, "user_a", "normal", "1", { size: 180 }, {
    revisionBytes: 300,
    slotBytes: 300,
    modeBytes: 600,
    accountBytes: 840,
    historyRevisions: 20,
  });
  assert.equal(exact.accepted, true);
  assert.equal(exact.projected.slotLogicalBytes, 300);
  const rejected = planCloudSaveUpload(data, "user_a", "normal", "main", { size: 250 }, {
    revisionBytes: 300,
    slotBytes: 400,
    modeBytes: 500,
    accountBytes: 500,
    historyRevisions: 20,
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "accountBytes");
  assert.deepEqual(rejected.prune.revisions, [1, 2]);
  assert.equal(rejected.prune.revisions.includes(3), false);
});

test("normalizes unsafe configuration while preserving explicit test limits", () => {
  const normalized = normalizeCloudQuotaPolicy({ revisionBytes: 2_000, slotBytes: 3_000, modeBytes: 4_000, accountBytes: 5_000, historyRevisions: 3 });
  assert.deepEqual(normalized, { revisionBytes: 2_000, slotBytes: 3_000, modeBytes: 4_000, accountBytes: 5_000, historyRevisions: 3 });
  const safe = normalizeCloudQuotaPolicy({ revisionBytes: -1, slotBytes: 1, modeBytes: 1, accountBytes: 1, historyRevisions: 1 });
  assert.ok(safe.revisionBytes > 30 * 1024 * 1024);
  assert.ok(safe.accountBytes >= safe.modeBytes && safe.modeBytes >= safe.slotBytes);
  assert.equal(safe.historyRevisions, 20);
});

test("keeps the public single-revision quota aligned with the 96 MiB transfer boundary", () => {
  const normalized = normalizeCloudQuotaPolicy();
  assert.equal(normalized.revisionBytes, 96 * 1024 * 1024 - 1024);
  assert.ok(normalized.slotBytes >= normalized.revisionBytes);
});
