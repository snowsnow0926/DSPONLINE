import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { CurrentMainPayloadAuditIndex } from "./current-main-payload-audit.mjs";
import { auditCurrentMainCloudPayloadResolution, initializeCloudPayloadStore, writeCloudPayload } from "./cloud-payload-store.mjs";
import { createCloudServer } from "./index.mjs";

const hash = (body) => createHash("sha256").update(body).digest("hex");
const save = (id, revision = 1) => {
  const payload = JSON.stringify({ marker: id, revision });
  return { payload, revision, checksum: hash(payload), size: Buffer.byteLength(payload), updatedAt: Date.now() };
};

function instrument(database) {
  const reads = [];
  let failFor = null;
  const prepare = database.prepare.bind(database);
  database.prepare = (sql) => {
    const statement = prepare(sql);
    if (/FROM cloud_save_payloads\s/.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const id = args.length === 4 ? args[2] : args[0];
        reads.push(id);
        if (id === failFor) throw new Error("synthetic audit read failure");
        return get(...args);
      };
    }
    return statement;
  };
  return { reads, fail(id) { failFor = id; } };
}

function fixture(count = 16) {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE cloud_save_payloads (user_id TEXT NOT NULL, slot TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(user_id,slot,revision)) WITHOUT ROWID");
  initializeCloudPayloadStore(database);
  const data = { users: {}, cloudSaves: {} };
  database.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `user_${i}`;
      data.users[id] = { id };
      data.cloudSaves[id] = save(id);
      writeCloudPayload(database, { userId: id, slot: "main", ...data.cloudSaves[id] });
    }
  })();
  const calls = instrument(database);
  const index = new CurrentMainPayloadAuditIndex(database);
  index.refresh(data);
  calls.reads.length = 0;
  return { database, data, index, calls };
}

test("one changed main among 512 accounts never re-reads unrelated payload rows", () => {
  const f = fixture(512);
  try {
    const changed = save("user_7", 2);
    f.database.transaction(() => writeCloudPayload(f.database, { userId: "user_7", slot: "main", ...changed }))();
    f.calls.reads.length = 0;
    f.data.cloudSaves.user_7 = changed;
    const result = f.index.refresh(f.data, { forceUserIds: ["user_7"] });
    assert.deepEqual(f.calls.reads, ["user_7"]);
    assert.equal(result.checked, 512);
    assert.equal(result.resolvable, 512);
    assert.deepEqual(result, auditCurrentMainCloudPayloadResolution(f.database, f.data));
  } finally { f.database.close(); }
});

test("unchanged metadata copies and new unrelated accounts require no payload reads", () => {
  const f = fixture();
  try {
    const copied = structuredClone(f.data);
    copied.users.new_account = { id: "new_account" };
    assert.equal(f.index.refresh(copied).resolvable, 16);
    assert.deepEqual(f.calls.reads, []);
  } finally { f.database.close(); }
});

test("forced same-revision deletion and repair update aggregate readiness", () => {
  const f = fixture();
  try {
    f.database.prepare("DELETE FROM cloud_save_payloads WHERE user_id='user_3'").run();
    const missing = f.index.refresh(f.data, { forceUserIds: ["user_3"] });
    assert.equal(missing.missingPayloadRows, 1);
    assert.equal(missing.resolvable, 15);
    f.database.transaction(() => writeCloudPayload(f.database, { userId: "user_3", slot: "main", ...f.data.cloudSaves.user_3 }))();
    const repaired = f.index.refresh(f.data, { forceUserIds: ["user_3"] });
    assert.equal(repaired.missingPayloadRows, 0);
    assert.equal(repaired.resolvable, 16);
  } finally { f.database.close(); }
});

test("owner removal, malformed metadata and main removal preserve exact counters", () => {
  const f = fixture();
  try {
    delete f.data.users.user_1;
    f.data.cloudSaves.user_2 = { revision: -1 };
    delete f.data.cloudSaves.user_3;
    const result = f.index.refresh(f.data);
    assert.deepEqual(result, auditCurrentMainCloudPayloadResolution(f.database, f.data));
    assert.equal(result.checked, 15);
    assert.equal(result.orphanedMetadata, 1);
    assert.equal(result.invalidMetadata, 1);
    assert.equal(result.resolvable, 13);
    f.data.users.user_1 = { id: "user_1" };
    assert.equal(f.index.refresh(f.data).orphanedMetadata, 0);
  } finally { f.database.close(); }
});

test("failed reads publish no partial counter or signature changes", () => {
  const f = fixture();
  try {
    const previous = f.index.summary;
    const records = f.index.records;
    f.calls.fail("user_8");
    assert.throws(() => f.index.refresh(f.data, { forceUserIds: ["user_3", "user_8"] }), /synthetic audit read failure/);
    assert.equal(f.index.summary, previous);
    assert.equal(f.index.records, records);
    f.calls.fail(null);
    assert.deepEqual(f.index.refresh(f.data, { forceUserIds: ["user_8"] }), previous);
  } finally { f.database.close(); }
});

test("explicit full refresh detects out-of-band changes and retains aggregate-only output", () => {
  const f = fixture();
  try {
    f.database.prepare("DELETE FROM cloud_save_payloads WHERE user_id='user_0'").run();
    const result = f.index.refresh(f.data, { full: true });
    assert.equal(f.calls.reads.length, 16);
    assert.equal(result.missingPayloadRows, 1);
    assert.equal(JSON.stringify(result).includes("user_"), false);
    assert.ok(Object.values(result).every((value) => Number.isInteger(value) && value >= 0));
  } finally { f.database.close(); }
});

test("incremental results match full audits through alias corruption and missing blobs", () => {
  const f = fixture();
  try {
    const refresh = () => {
      const result = f.index.refresh(f.data, { forceUserIds: ["user_2"] });
      assert.deepEqual(result, auditCurrentMainCloudPayloadResolution(f.database, f.data));
      return result;
    };
    f.database.prepare("UPDATE cloud_save_payloads SET payload=? WHERE user_id='user_2'").run("\u001eDSPIDLE-CLOUD-PAYLOAD-ALIAS/V1/broken");
    assert.equal(refresh().invalidPayloadRows, 1);
    f.database.transaction(() => writeCloudPayload(f.database, { userId: "user_2", slot: "main", ...f.data.cloudSaves.user_2 }))();
    assert.equal(refresh().unresolvable, 0);
    f.database.prepare("DELETE FROM cloud_save_payload_blobs WHERE checksum=?").run(f.data.cloudSaves.user_2.checksum);
    assert.equal(refresh().missingBlobs, 1);
    f.database.transaction(() => writeCloudPayload(f.database, { userId: "user_2", slot: "main", ...f.data.cloudSaves.user_2 }))();
    assert.equal(refresh().unresolvable, 0);
    f.data.cloudSaves.user_2 = { ...f.data.cloudSaves.user_2, size: f.data.cloudSaves.user_2.size + 1 };
    assert.equal(refresh().metadataMismatches, 1);
  } finally { f.database.close(); }
});

test("real cloud-store commits audit only affected mains and keep failed writes unpublished", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-main-audit-"));
  let fail = false;
  const server = await createCloudServer({ databaseFile: path.join(directory, "cloud.sqlite"), backupDirectory: "", historyPruneIntervalMs: 0, logger: { error() {} }, persistenceFaultInjector(event) {
    if (fail && event.phase === "after-app-state-write") throw new Error("synthetic commit failure");
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = server.store;
  try {
    await store.mutate((draft) => {
      for (let i = 0; i < 64; i++) {
        const id = `user_${i}`;
        draft.data.users[id] = { id };
        draft.data.cloudSaves[id] = draft.stageCloudSavePayload(id, "main", save(id));
      }
    }, { operation: "audit-fixture" });
    assert.equal(store.currentMainPayloadStatus().resolvable, 64);
    const calls = instrument(store.database);
    const update = () => store.mutate((draft) => {
      draft.data.cloudSaves.user_7 = draft.stageCloudSavePayload("user_7", "main", save("user_7", 2));
    }, { operation: "audit-single-main" });
    const before = store.currentMainPayloadStatus();
    fail = true;
    await assert.rejects(update(), /synthetic commit failure/);
    assert.equal(store.currentMainPayloadStatus(), before);
    fail = false;
    calls.reads.length = 0;
    await update();
    assert.deepEqual([...new Set(calls.reads)], ["user_7"]);
    assert.equal(store.currentMainPayloadStatus().available, true);
    assert.equal(store.currentMainPayloadStatus().resolvable, 64);
  } finally {
    fail = false;
    await server.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
