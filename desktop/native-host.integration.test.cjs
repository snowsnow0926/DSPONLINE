const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { NativeHostClient, NativeSaveSessionRegistry } = require("./native-host.cjs");

const binaryPath = path.resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");

test("Electron client commits, recovers, deduplicates and appends WAL through the real Rust host", {
  skip: !fs.existsSync(binaryPath) ? "release native host has not been built" : false,
  timeout: 30_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-host-integration-"));
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 10_000 });
  t.after(async () => {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const hello = await client.start("integration-test");
  assert.equal(hello.nativeFormatVersion, 1);
  assert.ok(hello.capabilities.includes("native-save-v1"));
  const sessions = new NativeSaveSessionRegistry(client);
  const request = {
    slot: "normal-main",
    mode: "normal",
    stateVersion: 47,
    baseChecksum: "01234567",
    registryFingerprint: "01234567",
    revision: 1,
    savedAtMs: 1,
  };
  const first = await sessions.begin(1, request);
  await sessions.write(1, first.transactionId, [
    { key: "base", value: "{\"version\":47}" },
    { key: "entities:00000000", value: "[]" },
  ]);
  const firstCommit = await sessions.commit(1, first.transactionId);
  assert.equal(firstCommit.changedRecords, 2);
  const second = await sessions.begin(1, { ...request, revision: 2, savedAtMs: 2 });
  await sessions.write(1, second.transactionId, [
    { key: "base", value: "{\"version\":47}" },
    { key: "entities:00000000", value: "[]" },
  ]);
  const secondCommit = await sessions.commit(1, second.transactionId);
  assert.equal(secondCommit.changedRecords, 0);
  assert.equal(secondCommit.changedBytes, 0);
  const wal = await client.request({
    operation: "walAppend",
    slot: "normal-main",
    revision: 3,
    commandId: "command-3",
    payload: { simulationSeconds: 1 },
  });
  assert.equal(wal.revision, 3);
  const recovery = await client.request({ operation: "saveRecover", slot: "normal-main" });
  assert.equal(recovery.generation, 2);
  assert.equal(recovery.revision, 2);
  assert.equal(recovery.walLastRevision, 3);
  assert.deepEqual(recovery.recordKeys, ["base", "entities:00000000"]);
  const readback = await client.request({
    operation: "saveRead",
    slot: "normal-main",
    key: "base",
    generation: recovery.generation,
    rootHash: recovery.rootHash,
  });
  assert.equal(readback.value, "{\"version\":47}");
});
