const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { resolveFixedNativeSaveRootPath, NATIVE_SAVE_DIRECTORY_NAME } = require("./native-exact-realtime-startup-guard.cjs");
const { PERFORMANCE_EDITION_IDENTITY, STABLE_IDENTITY } = require("./performance-edition-identity.cjs");

const {
  MAX_NATIVE_OFFLINE_EXPORT_BYTES,
  normalizeNativeOfflineStartupIntent,
  streamNativeOfflineStartupCandidate,
} = require("./native-offline-startup-transfer.cjs");

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function intent(overrides = {}) {
  return {
    sessionId: "core-session-7",
    expectedGeneration: 3,
    expectedRootHash: SHA_A,
    expectedRevision: 9,
    expectedRegistryFingerprint: "registry-7",
    expectedCanonicalSha256: SHA_A,
    expectedDomainSha256: SHA_B,
    strategy: "macro-v1",
    ...overrides,
  };
}

class AcknowledgingPort extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.started = false;
    this.closed = false;
  }

  start() { this.started = true; }

  close() {
    this.closed = true;
    this.emit("close");
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.chunk instanceof Uint8Array) {
      queueMicrotask(() => this.emit("message", { data: { ack: message.offset } }));
    } else if (message.end === true && typeof message.envelopeSha256 === "string") {
      queueMicrotask(() => this.emit("message", {
        data: { completeAck: message.envelopeSha256 },
      }));
    } else if (message.end === true && message.envelopeSha256 === null) {
      queueMicrotask(() => this.emit("message", { data: { completeAck: null } }));
    }
  }
}

async function temporaryNativeRoot(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsp-native-offline-transfer-"));
  await fs.promises.mkdir(path.join(root, "exports"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return root;
}

function preparedResult(exportId, payload, overrides = {}) {
  return {
    prepared: true,
    strategy: "macro-v1",
    sourceSavedAtMs: 1_000,
    settledAtMs: 61_000,
    settledSeconds: 60,
    sourceSummary: { revision: 9 },
    advance: {
      supported: true,
      exactScope: "offline-state-proven",
      algorithmVersion: "native-offline-macro-v1-closed-ledger-one-shot-v3-state-parity",
      exactCalibrationSeconds: 30,
      approximatedSeconds: 30,
      previousRevision: 9,
      revision: 10,
    },
    candidateSummary: { revision: 10 },
    export: {
      exportId,
      mode: "normal",
      result: {
        revision: 10,
        savedAtMs: 61_000,
        byteLength: payload.byteLength,
        envelopeSha256: createHash("sha256").update(payload).digest("hex"),
        stateChecksum: "1234abcd",
      },
    },
    ...overrides,
  };
}

test("native offline startup transfer streams exact acknowledged chunks and deletes only its candidate", async (t) => {
  const root = await temporaryNativeRoot(t);
  const exportId = "offlinecandidatefixed";
  const payload = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
  const candidatePath = path.join(root, "exports", `${exportId}.json`);
  const siblingPath = path.join(root, "exports", "keep.json");
  const port = new AcknowledgingPort();
  let forwarded = null;
  const registry = {
    async prepareOfflineSettlementExport(ownerId, request, observedNowMs, actualExportId) {
      forwarded = { ownerId, request, observedNowMs, exportId: actualExportId };
      await fs.promises.writeFile(candidatePath, payload);
      await fs.promises.writeFile(siblingPath, "keep");
      return preparedResult(actualExportId, payload);
    },
  };
  const result = await streamNativeOfflineStartupCandidate({
    registry,
    ownerId: 17,
    request: intent(),
    observedNowMs: 61_999,
    nativeRootPath: root,
    port,
    normalizeResult: (value) => value,
    createExportId: () => exportId,
  });

  assert.equal(result.prepared, true);
  assert.equal(port.started, true);
  assert.equal(port.closed, false, "the IPC owner closes the port after publishing any safe error");
  assert.deepEqual(forwarded, {
    ownerId: 17,
    request: intent(),
    observedNowMs: 61_999,
    exportId,
  });
  const chunks = port.messages.filter((message) => message.chunk instanceof Uint8Array);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((message) => message.offset), [1_048_576, 2_097_152, payload.byteLength]);
  assert.deepEqual(
    Buffer.concat(chunks.map((message) => Buffer.from(message.chunk))),
    payload,
  );
  assert.equal(port.messages.at(-1).envelopeSha256, createHash("sha256").update(payload).digest("hex"));
  await assert.rejects(fs.promises.stat(candidatePath), { code: "ENOENT" });
  assert.equal(await fs.promises.readFile(siblingPath, "utf8"), "keep");
});

test("native offline startup transfer publishes an unavailable receipt without creating a payload", async (t) => {
  const root = await temporaryNativeRoot(t);
  const port = new AcknowledgingPort();
  const unavailable = {
    prepared: false,
    strategy: "macro-v1",
    sourceSavedAtMs: 1_000,
    settledAtMs: 1_000,
    settledSeconds: 0,
    sourceSummary: { revision: 9 },
    reason: "interval-too-short",
  };
  const result = await streamNativeOfflineStartupCandidate({
    registry: { prepareOfflineSettlementExport: async () => unavailable },
    ownerId: 1,
    request: intent(),
    observedNowMs: 1_500,
    nativeRootPath: root,
    port,
    normalizeResult: (value) => value,
    createExportId: () => "offlinecandidateempty",
  });
  assert.deepEqual(result, unavailable);
  assert.deepEqual(port.messages, [
    { start: unavailable, payloadByteLength: 0 },
    { end: true, totalBytes: 0, envelopeSha256: null },
  ]);
  assert.deepEqual(await fs.promises.readdir(path.join(root, "exports")), []);
});

test("native offline startup transfer rejects proof drift and removes the exact candidate", async (t) => {
  const root = await temporaryNativeRoot(t);
  const exportId = "offlinecandidatecorrupt";
  const payload = Buffer.from("candidate-body", "utf8");
  const candidatePath = path.join(root, "exports", `${exportId}.json`);
  const port = new AcknowledgingPort();
  await assert.rejects(streamNativeOfflineStartupCandidate({
    registry: {
      async prepareOfflineSettlementExport() {
        await fs.promises.writeFile(candidatePath, payload);
        return preparedResult(exportId, payload, {
          export: {
            ...preparedResult(exportId, payload).export,
            result: {
              ...preparedResult(exportId, payload).export.result,
              envelopeSha256: SHA_A,
            },
          },
        });
      },
    },
    ownerId: 1,
    request: intent(),
    observedNowMs: 61_000,
    nativeRootPath: root,
    port,
    normalizeResult: (value) => value,
    createExportId: () => exportId,
  }), /stream verification failed/);
  await assert.rejects(fs.promises.stat(candidatePath), { code: "ENOENT" });
});

test("native offline startup transfer rejects a Host export identity drift", async (t) => {
  const root = await temporaryNativeRoot(t);
  const exportId = "offlinecandidatefixed";
  const payload = Buffer.from("candidate-body", "utf8");
  const candidatePath = path.join(root, "exports", `${exportId}.json`);
  await assert.rejects(streamNativeOfflineStartupCandidate({
    registry: {
      async prepareOfflineSettlementExport() {
        await fs.promises.writeFile(candidatePath, payload);
        return preparedResult("differentcandidate", payload);
      },
    },
    ownerId: 1,
    request: intent(),
    observedNowMs: 61_000,
    nativeRootPath: root,
    port: new AcknowledgingPort(),
    normalizeResult: (value) => value,
    createExportId: () => exportId,
  }), /export proof is invalid/);
  await assert.rejects(fs.promises.stat(candidatePath), { code: "ENOENT" });
});

test("native offline startup intent rejects renderer clocks, paths, export IDs, and oversized identities", () => {
  assert.deepEqual(normalizeNativeOfflineStartupIntent(intent()), intent());
  for (const extra of [
    { observedNowMs: 1 },
    { exportId: "forged" },
    { exportPath: "C:\\private.json" },
  ]) {
    assert.throws(() => normalizeNativeOfflineStartupIntent({ ...intent(), ...extra }), /intent is invalid/);
  }
  assert.throws(() => normalizeNativeOfflineStartupIntent(intent({ expectedGeneration: 0 })), /intent is invalid/);
  assert.throws(() => normalizeNativeOfflineStartupIntent(intent({ expectedCanonicalSha256: "A".repeat(64) })), /intent is invalid/);
  assert.throws(() => normalizeNativeOfflineStartupIntent(intent({ sessionId: "x".repeat(129) })), /intent is invalid/);
  assert.equal(MAX_NATIVE_OFFLINE_EXPORT_BYTES, 256 * 1024 * 1024);
});

test("Electron main keeps native offline startup time and export identity outside renderer IPC", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /require\("\.\/native-offline-startup-transfer\.cjs"\)/);
  assert.match(main, /ipcMain\.on\("desktop:native-offline-startup-transfer"/);
  const start = main.indexOf('ipcMain.on("desktop:native-offline-startup-transfer"');
  const end = main.indexOf('ipcMain.handle("desktop:native-core-apply-command"', start);
  const block = main.slice(start, end);
  assert.match(block, /observedNowMs:\s*sampleNativeOfflineStartupWallClock\(\)/);
  assert.match(block, /normalizeRendererNativeResult\(\s*"coreOfflineCandidateExport"/);
  assert.doesNotMatch(block, /request\.observedNowMs/);
  assert.doesNotMatch(block, /request\.exportId/);
});

for (const identity of [PERFORMANCE_EDITION_IDENTITY, STABLE_IDENTITY]) {
  test(`actual main offline handler uses the ${identity.editionId} save root`, async () => {
    const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    const start = main.indexOf('ipcMain.on("desktop:native-offline-startup-transfer"');
    const end = main.indexOf('ipcMain.handle("desktop:native-core-apply-command"', start);
    assert.ok(start >= 0 && end > start);
    const userDataPath = path.join(os.tmpdir(), "dsp-offline-handler-test", identity.userDataDirectoryName);
    const request = intent();
    const port = new EventEmitter();
    const registry = {};
    const calls = [];
    const errors = [];
    let listener;
    let complete;
    const closed = new Promise((resolve) => { complete = resolve; });
    vm.runInNewContext(main.slice(start, end), {
      ipcMain: { on(channel, handler) {
        assert.equal(channel, "desktop:native-offline-startup-transfer");
        listener = handler;
      } },
      requireTrustedNativeSender: () => 17,
      nativeCoreSessions: registry,
      sampleNativeOfflineStartupWallClock: () => 61_999,
      desktopRuntimeIdentity: { userDataPath, userDataDirectoryName: identity.userDataDirectoryName },
      path,
      resolveFixedNativeSaveRootPath,
      streamNativeOfflineStartupCandidate: async (options) => { calls.push(options); },
      normalizeRendererNativeResult: (_kind, value) => value,
      postNativeOfflineStartupTransferError: (_port, error) => { errors.push(error.message); },
      closeTransferPort: (actualPort) => { assert.equal(actualPort, port); complete(); },
    });
    listener({ ports: [port] }, request);
    await closed;
    assert.deepEqual(errors, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].nativeRootPath, path.join(userDataPath, NATIVE_SAVE_DIRECTORY_NAME));
    assert.equal(calls[0].registry, registry);
    assert.equal(calls[0].request, request);
    assert.equal(calls[0].observedNowMs, 61_999);
    assert.equal(calls[0].ownerId, 17);
    assert.equal(calls[0].port, port);
  });
}
