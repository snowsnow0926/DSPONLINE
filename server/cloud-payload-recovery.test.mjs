import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createCloudServer } from "./index.mjs";
import {
  CLOUD_PAYLOAD_BLOB_TABLE,
  auditCurrentMainCloudPayloadResolution,
  initializeCloudPayloadStore,
  readCloudPayload,
  writeCloudPayload,
} from "./cloud-payload-store.mjs";
import {
  applyCloudPayloadBodyRecovery,
  applyCloudPayloadAliasRecovery,
  previewCloudPayloadBodyRecovery,
  previewCloudPayloadAliasRecovery,
} from "./cloud-payload-recovery.mjs";
import { computeSaveStateChecksum } from "./save-integrity.mjs";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createPayload(marker, mode = "normal") {
  const state = {
    version: 47,
    mode,
    entities: [],
    totalProduced: { universe_matrix: 0 },
    marker,
  };
  return JSON.stringify({
    formatVersion: 2,
    savedAt: 123_456,
    state,
    checksum: computeSaveStateChecksum(2, state),
  });
}

function createLegacyNormalPayload(marker) {
  const state = {
    version: 46,
    entities: [],
    totalProduced: { universe_matrix: 0 },
    marker,
  };
  return JSON.stringify({
    formatVersion: 2,
    savedAt: 123_456,
    state,
    checksum: computeSaveStateChecksum(2, state),
  });
}

function metadata(payload, revision) {
  return { revision, checksum: sha256(payload), size: Buffer.byteLength(payload), updatedAt: revision };
}

function user(id) {
  return { id, username: `user_${id}`, displayName: `User ${id}`, createdAt: 1 };
}

function createDatabase(databasePath) {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE cloud_save_payloads (
      user_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (user_id, slot, revision)
    ) WITHOUT ROWID;
  `);
  initializeCloudPayloadStore(database);
  return database;
}

function writePayload(database, userId, revision, payload) {
  database.transaction(() => {
    writeCloudPayload(database, { userId, slot: "main", revision, payload });
  })();
}

function writeAppState(database, data) {
  database.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, 1)").run(JSON.stringify(data));
}

function recoveryFixture(databasePath) {
  const database = createDatabase(databasePath);
  const history = createPayload("history");
  const current = createPayload("current");
  const existing = createPayload("existing");
  const speedrun = createPayload("speedrun", "speedrun");
  const invalidEnvelope = JSON.stringify({ formatVersion: 2, state: { mode: "normal" }, checksum: "00000000" });
  const checksumMismatch = createPayload("checksum-mismatch-a");
  const checksumMismatchReplacement = createPayload("checksum-mismatch-b");
  const blobMetadataMismatch = createPayload("blob-metadata-mismatch");
  const missingHistory = createPayload("missing-history");
  for (const [userId, revision, payload] of [
    ["recoverable", 1, history],
    ["recoverable", 2, current],
    ["existing", 1, existing],
    ["speedrun", 1, speedrun],
    ["invalid-envelope", 1, invalidEnvelope],
    ["checksum-mismatch", 1, checksumMismatch],
    ["blob-metadata-mismatch", 1, blobMetadataMismatch],
    ["missing-history", 1, missingHistory],
  ]) {
    writePayload(database, userId, revision, payload);
  }
  for (const [userId, revision] of [
    ["recoverable", 1],
    ["recoverable", 2],
    ["speedrun", 1],
    ["invalid-envelope", 1],
    ["checksum-mismatch", 1],
    ["blob-metadata-mismatch", 1],
    ["missing-history", 1],
  ]) {
    database.prepare("DELETE FROM cloud_save_payloads WHERE user_id = ? AND slot = 'main' AND revision = ?").run(userId, revision);
  }
  database.prepare("UPDATE cloud_save_payloads SET payload = ? WHERE user_id = 'existing' AND slot = 'main' AND revision = 1")
    .run("existing row must not be overwritten");
  database.prepare(`UPDATE ${CLOUD_PAYLOAD_BLOB_TABLE} SET payload = ? WHERE checksum = ?`)
    .run(checksumMismatchReplacement, sha256(checksumMismatch));
  const records = {
    history: metadata(history, 1),
    current: metadata(current, 2),
    existing: metadata(existing, 1),
    speedrun: metadata(speedrun, 1),
    invalidEnvelope: metadata(invalidEnvelope, 1),
    checksumMismatch: metadata(checksumMismatch, 1),
    blobMetadataMismatch: { ...metadata(blobMetadataMismatch, 1), size: Buffer.byteLength(blobMetadataMismatch) + 1 },
    missingHistory: metadata(missingHistory, 1),
  };
  const users = Object.fromEntries([
    "recoverable",
    "existing",
    "speedrun",
    "invalid-envelope",
    "checksum-mismatch",
    "blob-metadata-mismatch",
    "missing-history",
  ].map((id) => [id, user(id)]));
  writeAppState(database, {
    schemaVersion: 8,
    storageLayoutVersion: 3,
    users,
    cloudSaves: {
      recoverable: records.current,
      existing: records.existing,
      "missing-history": records.missingHistory,
    },
    cloudSaveHistory: {
      recoverable: [records.history, records.current],
      existing: [records.existing],
      speedrun: [records.speedrun],
      "invalid-envelope": [records.invalidEnvelope],
      "checksum-mismatch": [records.checksumMismatch],
      "blob-metadata-mismatch": [records.blobMetadataMismatch],
    },
  });
  return { database, history, current };
}

test("recovers only fully verified missing aliases and never overwrites existing rows", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-payload-recovery-"));
  const productionPath = path.join(directory, "cloud.sqlite");
  const backupPath = path.join(directory, "backup.sqlite");
  const staleBackupPath = path.join(directory, "stale-backup.sqlite");
  const { database, history, current } = recoveryFixture(productionPath);
  try {
    const beforeAppState = database.prepare("SELECT payload FROM app_state WHERE id = 1").get().payload;
    const beforeExisting = database.prepare("SELECT payload FROM cloud_save_payloads WHERE user_id = 'existing' AND slot = 'main' AND revision = 1").get().payload;
    const preview = previewCloudPayloadAliasRecovery(database);
    assert.equal(preview.eligible, true);
    assert.equal(preview.candidateAliases, 2);
    assert.equal(preview.currentMainCandidateAliases, 1);
    assert.equal(preview.summary.currentMain.checked, 3);
    assert.equal(preview.summary.currentMain.missingMatchingHistory, 1);
    assert.equal(preview.summary.currentMain.existingRows, 1);
    assert.equal(preview.summary.rejected.nonNormalMode, 1);
    assert.equal(preview.summary.rejected.envelopeInvalid, 1);
    assert.equal(preview.summary.rejected.checksumMismatch, 1);
    assert.equal(preview.summary.rejected.blobMetadataMismatch, 1);
    assert.equal(preview.summary.history.existingRows, 1);

    await database.backup(backupPath);
    await database.backup(staleBackupPath);
    const staleBackupWrite = new Database(staleBackupPath);
    staleBackupWrite.prepare("UPDATE app_state SET payload = ? WHERE id = 1").run("{}");
    staleBackupWrite.close();
    const staleBackup = new Database(staleBackupPath, { readonly: true, fileMustExist: true });
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      assert.throws(
        () => applyCloudPayloadAliasRecovery(database, backup, { confirmation: preview.confirmation }),
        /停止云服务/,
      );
      assert.throws(
        () => applyCloudPayloadAliasRecovery(database, staleBackup, {
          confirmation: preview.confirmation,
          serviceStopped: true,
        }),
        (error) => error?.code === "CLOUD_PAYLOAD_RECOVERY_BACKUP_MISMATCH",
      );
      assert.equal(database.prepare("SELECT count(*) AS count FROM cloud_save_payloads WHERE user_id = 'recoverable' AND slot = 'main' AND revision IN (1, 2)").get().count, 0);
      const applied = applyCloudPayloadAliasRecovery(database, backup, {
        confirmation: preview.confirmation,
        serviceStopped: true,
      });
      assert.equal(applied.applied, true);
      assert.equal(applied.insertedAliases, 2);
      assert.equal(applied.currentMainAliases, 1);
      assert.equal(readCloudPayload(database, { userId: "recoverable", slot: "main", revision: 1 }), history);
      assert.equal(readCloudPayload(database, { userId: "recoverable", slot: "main", revision: 2 }), current);
      assert.equal(database.prepare("SELECT payload FROM cloud_save_payloads WHERE user_id = 'existing' AND slot = 'main' AND revision = 1").get().payload, beforeExisting);
      assert.equal(database.prepare("SELECT payload FROM app_state WHERE id = 1").get().payload, beforeAppState);
      const duplicate = applyCloudPayloadAliasRecovery(database, backup, { serviceStopped: true });
      assert.equal(duplicate.applied, false);
      assert.equal(duplicate.idempotent, true);
    } finally {
      staleBackup.close();
      backup.close();
    }
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores only missing current-main rows from a verified pre-incident body source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-payload-body-recovery-"));
  const productionPath = path.join(directory, "production.sqlite");
  const sourcePath = path.join(directory, "pre-incident.sqlite");
  const backupPath = path.join(directory, "stopped-production.sqlite");
  const production = createDatabase(productionPath);
  const source = createDatabase(sourcePath);
  const legacyNormal = createLegacyNormalPayload("legacy-normal");
  const localBlob = createPayload("local-blob");
  const existing = createPayload("existing");
  const sourceSpeedrun = createPayload("source-speedrun", "speedrun");
  const sourceInvalid = JSON.stringify({ formatVersion: 2, state: { entities: [], mode: "normal" }, checksum: "00000000" });
  const records = {
    legacy: metadata(legacyNormal, 1),
    local: metadata(localBlob, 1),
    existing: metadata(existing, 1),
    speedrun: metadata(sourceSpeedrun, 1),
    invalid: metadata(sourceInvalid, 1),
  };
  const users = Object.fromEntries(Object.keys(records).map((id) => [id, user(id)]));
  const productionState = {
    schemaVersion: 7,
    storageLayoutVersion: 2,
    users,
    cloudSaves: {
      legacy: records.legacy,
      local: records.local,
      existing: records.existing,
      speedrun: records.speedrun,
      invalid: records.invalid,
    },
    cloudSaveHistory: {
      legacy: [records.legacy],
      local: [records.local],
      existing: [records.existing],
      speedrun: [records.speedrun],
      invalid: [records.invalid],
    },
  };
  try {
    source.prepare("INSERT INTO cloud_save_payloads (user_id, slot, revision, payload) VALUES (?, 'main', ?, ?)")
      .run("legacy", 1, legacyNormal);
    source.prepare("INSERT INTO cloud_save_payloads (user_id, slot, revision, payload) VALUES (?, 'main', ?, ?)")
      .run("speedrun", 1, sourceSpeedrun);
    source.prepare("INSERT INTO cloud_save_payloads (user_id, slot, revision, payload) VALUES (?, 'main', ?, ?)")
      .run("invalid", 1, sourceInvalid);
    writeAppState(source, { schemaVersion: 8, storageLayoutVersion: 3, users: {}, cloudSaves: {}, cloudSaveHistory: {} });

    writePayload(production, "local", 1, localBlob);
    production.prepare("DELETE FROM cloud_save_payloads WHERE user_id = 'local' AND slot = 'main' AND revision = 1").run();
    writePayload(production, "existing", 1, existing);
    writeAppState(production, productionState);
    const beforeState = production.prepare("SELECT payload FROM app_state WHERE id = 1").get().payload;
    const beforeExisting = production.prepare("SELECT payload FROM cloud_save_payloads WHERE user_id = 'existing' AND slot = 'main' AND revision = 1").get().payload;
    const preview = previewCloudPayloadBodyRecovery(production, source, {
      currentOnly: true,
      bodySourceSha256: "a".repeat(64),
    });
    assert.equal(preview.eligible, true);
    assert.equal(preview.candidateRows, 2);
    assert.equal(preview.currentMainCandidateRows, 2);
    assert.equal(preview.currentMainBodyRestoreRows, 1);
    assert.equal(preview.summary.currentMain.existingRows, 1);
    assert.equal(preview.summary.rejected.nonNormalMode, 1);
    assert.equal(preview.summary.rejected.envelopeInvalid, 1);
    await production.backup(backupPath);
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      assert.throws(
        () => applyCloudPayloadBodyRecovery(production, backup, source, {
          confirmation: preview.confirmation,
          currentOnly: true,
          bodySourceSha256: "a".repeat(64),
        }),
        (error) => error?.code === "CLOUD_PAYLOAD_RECOVERY_SERVICE_RUNNING",
      );
      const applied = applyCloudPayloadBodyRecovery(production, backup, source, {
        confirmation: preview.confirmation,
        serviceStopped: true,
        currentOnly: true,
        bodySourceSha256: "a".repeat(64),
      });
      assert.equal(applied.applied, true);
      assert.equal(applied.insertedRows, 2);
      assert.equal(applied.insertedBlobs, 1);
      assert.equal(applied.currentMainRows, 2);
      assert.equal(applied.currentMainBodyRestoreRows, 1);
      assert.equal(readCloudPayload(production, { userId: "legacy", slot: "main", revision: 1 }), legacyNormal);
      assert.equal(readCloudPayload(production, { userId: "local", slot: "main", revision: 1 }), localBlob);
      assert.equal(production.prepare("SELECT payload FROM cloud_save_payloads WHERE user_id = 'existing' AND slot = 'main' AND revision = 1").get().payload, beforeExisting);
      assert.equal(production.prepare("SELECT payload FROM app_state WHERE id = 1").get().payload, beforeState);
      const duplicate = applyCloudPayloadBodyRecovery(production, backup, source, {
        serviceStopped: true,
        currentOnly: true,
        bodySourceSha256: "a".repeat(64),
      });
      assert.equal(duplicate.applied, false);
      assert.equal(duplicate.idempotent, true);
    } finally {
      backup.close();
    }
  } finally {
    source.close();
    production.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a body-recovery preview after a newer current save changes app_state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-payload-body-stale-"));
  const productionPath = path.join(directory, "production.sqlite");
  const sourcePath = path.join(directory, "source.sqlite");
  const backupPath = path.join(directory, "backup.sqlite");
  const production = createDatabase(productionPath);
  const source = createDatabase(sourcePath);
  const original = createLegacyNormalPayload("original");
  const newer = createPayload("newer");
  const originalMetadata = metadata(original, 1);
  try {
    source.prepare("INSERT INTO cloud_save_payloads (user_id, slot, revision, payload) VALUES (?, 'main', ?, ?)")
      .run("target", 1, original);
    writeAppState(source, { schemaVersion: 8, storageLayoutVersion: 3, users: {}, cloudSaves: {}, cloudSaveHistory: {} });
    writeAppState(production, {
      schemaVersion: 7,
      users: { target: user("target") },
      cloudSaves: { target: originalMetadata },
      cloudSaveHistory: { target: [originalMetadata] },
    });
    const preview = previewCloudPayloadBodyRecovery(production, source, {
      currentOnly: true,
      bodySourceSha256: "b".repeat(64),
    });
    await production.backup(backupPath);
    const state = JSON.parse(production.prepare("SELECT payload FROM app_state WHERE id = 1").get().payload);
    const next = metadata(newer, 2);
    state.cloudSaves.target = next;
    state.cloudSaveHistory.target.push(next);
    writePayload(production, "target", 2, newer);
    production.prepare("UPDATE app_state SET payload = ?, updated_at = 2 WHERE id = 1").run(JSON.stringify(state));
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      assert.throws(
        () => applyCloudPayloadBodyRecovery(production, backup, source, {
          confirmation: preview.confirmation,
          serviceStopped: true,
          currentOnly: true,
          bodySourceSha256: "b".repeat(64),
        }),
        (error) => error?.code === "CLOUD_PAYLOAD_RECOVERY_CONFIRMATION_INVALID",
      );
      assert.equal(readCloudPayload(production, { userId: "target", slot: "main", revision: 2 }), newer);
      assert.equal(production.prepare("SELECT count(*) AS count FROM cloud_save_payloads WHERE user_id = 'target' AND slot = 'main' AND revision = 1").get().count, 0);
    } finally {
      backup.close();
    }
  } finally {
    source.close();
    production.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a stale recovery preview after a newer current-main save arrives", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-payload-stale-preview-"));
  const productionPath = path.join(directory, "cloud.sqlite");
  const { database } = recoveryFixture(productionPath);
  try {
    const preview = previewCloudPayloadAliasRecovery(database);
    const newer = createPayload("newer-current");
    writePayload(database, "recoverable", 3, newer);
    const state = JSON.parse(database.prepare("SELECT payload FROM app_state WHERE id = 1").get().payload);
    state.cloudSaves.recoverable = metadata(newer, 3);
    state.cloudSaveHistory.recoverable.push(metadata(newer, 3));
    database.prepare("UPDATE app_state SET payload = ?, updated_at = 2 WHERE id = 1").run(JSON.stringify(state));

    assert.throws(
      () => applyCloudPayloadAliasRecovery(database, null, {
        confirmation: preview.confirmation,
        serviceStopped: true,
      }),
      (error) => error?.code === "CLOUD_PAYLOAD_RECOVERY_CONFIRMATION_INVALID",
    );
    assert.equal(readCloudPayload(database, { userId: "recoverable", slot: "main", revision: 3 }), newer);
    assert.equal(database.prepare("SELECT count(*) AS count FROM cloud_save_payloads WHERE user_id = 'recoverable' AND slot = 'main' AND revision IN (1, 2)").get().count, 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses legacy layout migration when either payload table already has data", async () => {
  for (const scenario of ["payload", "blob"]) {
    const directory = await mkdtemp(path.join(tmpdir(), `dsp-cloud-migration-${scenario}-`));
    const databasePath = path.join(directory, "cloud.sqlite");
    const database = createDatabase(databasePath);
    const legacyState = JSON.stringify({ schemaVersion: 7, users: {}, cloudSaves: {}, cloudSaveHistory: {} });
    database.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, 1)").run(legacyState);
    if (scenario === "payload") {
      database.prepare("INSERT INTO cloud_save_payloads (user_id, slot, revision, payload) VALUES ('protected', 'main', 1, 'do-not-delete')").run();
    } else {
      database.prepare(`INSERT INTO ${CLOUD_PAYLOAD_BLOB_TABLE} (checksum, size_bytes, payload) VALUES (?, 1, 'x')`).run("a".repeat(64));
    }
    database.close();
    try {
      await assert.rejects(
        () => createCloudServer({ databaseFile: databasePath, logger: { error() {} } }),
        (error) => error?.code === "CLOUD_PAYLOAD_LEGACY_MIGRATION_DELETE_BLOCKED",
      );
      const after = new Database(databasePath, { readonly: true });
      try {
        assert.equal(after.prepare("SELECT payload FROM app_state WHERE id = 1").get().payload, legacyState);
        const payloadRows = after.prepare("SELECT count(*) AS count FROM cloud_save_payloads").get().count;
        const blobRows = after.prepare(`SELECT count(*) AS count FROM ${CLOUD_PAYLOAD_BLOB_TABLE}`).get().count;
        assert.equal(payloadRows, scenario === "payload" ? 1 : 0);
        assert.equal(blobRows, scenario === "blob" ? 1 : 0);
      } finally {
        after.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("ready reports aggregate current-main payload resolution without exposing save data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-ready-payload-audit-"));
  const databasePath = path.join(directory, "cloud.sqlite");
  const database = createDatabase(databasePath);
  const present = createPayload("present");
  const missing = createPayload("missing");
  writePayload(database, "present", 1, present);
  writePayload(database, "missing", 1, missing);
  database.prepare("DELETE FROM cloud_save_payloads WHERE user_id = 'missing' AND slot = 'main' AND revision = 1").run();
  writeAppState(database, {
    schemaVersion: 8,
    storageLayoutVersion: 3,
    users: { present: user("present"), missing: user("missing") },
    cloudSaves: { present: metadata(present, 1), missing: metadata(missing, 1) },
    cloudSaveHistory: {},
  });
  database.close();
  let server;
  try {
    server = await createCloudServer({ databaseFile: databasePath, logger: { error() {} } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ready`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.currentMainPayloads && {
      available: body.currentMainPayloads.available,
      checked: body.currentMainPayloads.checked,
      resolvable: body.currentMainPayloads.resolvable,
      unresolvable: body.currentMainPayloads.unresolvable,
      missingPayloadRows: body.currentMainPayloads.missingPayloadRows,
    }, {
      available: true,
      checked: 2,
      resolvable: 1,
      unresolvable: 1,
      missingPayloadRows: 1,
    });
    assert.equal(JSON.stringify(body.currentMainPayloads).includes(present), false);
    assert.equal(JSON.stringify(body.currentMainPayloads).includes(sha256(present)), false);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed payload changes audit only affected owners and preserve the full audit result", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-cloud-incremental-main-audit-"));
  const databasePath = path.join(directory, "cloud.sqlite");
  const database = createDatabase(databasePath);
  const left = createPayload("left");
  const right = createPayload("unrelated-legacy-" + "x".repeat(2 * 1024 * 1024));
  const missing = createPayload("missing");
  writePayload(database, "left", 1, left);
  database.prepare("INSERT INTO cloud_save_payloads (user_id, slot, revision, payload) VALUES ('right', 'main', 1, ?)").run(right);
  writeAppState(database, {
    schemaVersion: 8, storageLayoutVersion: 3,
    users: { left: user("left"), right: user("right"), missing: user("missing") },
    cloudSaves: { left: metadata(left, 1), right: metadata(right, 1), missing: metadata(missing, 1) },
    cloudSaveHistory: {},
  });
  database.close();
  let server;
  try {
    server = await createCloudServer({ databaseFile: databasePath, logger: { error() {} } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const store = server.store;
    const prepare = store.database.prepare.bind(store.database);
    const auditedOwners = [];
    store.database.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.includes("AS storageType") && sql.includes("slot = 'main' AND revision = ?")) {
        return { get(...args) { auditedOwners.push(args[2]); return statement.get(...args); } };
      }
      return statement;
    };
    const verifyOracle = () => {
      const observed = { ...store.currentMainPayloadStatus() };
      delete observed.available; delete observed.checkedAt;
      store.database.prepare = prepare;
      assert.deepEqual(observed, auditCurrentMainCloudPayloadResolution(store.database, store._data));
    };
    const changed = createPayload("left-revision-2");
    await store.mutate((draft) => {
      draft.data.cloudSaves.left = draft.stageCloudSavePayload("left", "main", { ...metadata(changed, 2), payload: changed });
    });
    assert.deepEqual(auditedOwners, ["left"], "a small upload must not read another owner's large legacy body");
    assert.equal(store.currentMainPayloadStatus().missingPayloadRows, 1);
    verifyOracle();

    await store.mutate((draft) => draft.discardCloudSavePayload("left", "main", 2));
    assert.equal(store.currentMainPayloadStatus().missingPayloadRows, 2);
    verifyOracle();

    await store.mutate((draft) => {
      draft.data.cloudSaves.left = draft.stageCloudSavePayload("left", "main", { ...metadata(changed, 2), payload: changed });
      draft.discardUserCloudSavePayloads("right");
      delete draft.data.cloudSaves.right;
      delete draft.data.users.right;
    });
    assert.equal(store.currentMainPayloadStatus().checked, 2);
    assert.equal(store.currentMainPayloadStatus().resolvable, 1);
    verifyOracle();

    const before = { ...store.currentMainPayloadStatus() };
    store.faultInjector = ({ phase }) => { if (phase === "after-app-state-write") throw new Error("test rollback"); };
    await assert.rejects(store.mutate((draft) => draft.discardCloudSavePayload("left", "main", 2)), /test rollback/);
    assert.deepEqual(store.currentMainPayloadStatus(), before, "failed transactions cannot publish audit changes");
    verifyOracle();
    store.faultInjector = null;
    const originalAudit = store.refreshCurrentMainPayloadAudit;
    let presenceAuditCalls = 0;
    store.refreshCurrentMainPayloadAudit = function (...args) { presenceAuditCalls += 1; return originalAudit.apply(this, args); };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/presence`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: "incremental_audit_presence_fixture" }),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).players.total, 1);
    assert.equal(presenceAuditCalls, 0);
    assert.deepEqual(store.currentMainPayloadStatus(), before);
    store.refreshCurrentMainPayloadAudit = originalAudit;
    await new Promise((resolve) => server.close(resolve));
    server = await createCloudServer({ databaseFile: databasePath, logger: { error() {} } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    assert.equal(server.store.currentMainPayloadStatus().checked, 2);
    assert.equal(server.store.currentMainPayloadStatus().missingPayloadRows, 1);
    assert.equal(Object.keys(server.store.data.players).length, 1);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
