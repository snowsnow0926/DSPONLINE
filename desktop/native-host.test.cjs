const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  CONTROL_RESPONSE_KIND,
  MAX_NATIVE_PROJECTION_TRANSFER_BYTES,
  NativeHostClient,
  NativeCoreSessionRegistry,
  NativeSaveSessionRegistry,
  crc32,
  encodeNativeProjectionTransfer,
  encodeFrame,
  normalizeNativeSaveBegin,
  normalizeNativeSaveRecords,
  normalizeNativeCoreOpen,
  normalizeNativeCoreImport,
  normalizeNativeHostSpawnEnvironment,
  parseFrames,
} = require("./native-host.cjs");

test("native frame codec survives arbitrary stream boundaries", () => {
  const first = encodeFrame({ requestId: 1, payload: Buffer.from("one") });
  const second = encodeFrame({ requestId: 2, kind: CONTROL_RESPONSE_KIND, payload: Buffer.from("two") });
  const combined = Buffer.concat([first, second]);
  const partial = parseFrames(combined.subarray(0, first.byteLength + 5));
  assert.equal(partial.frames.length, 1);
  const completed = parseFrames(Buffer.concat([partial.remaining, combined.subarray(first.byteLength + 5)]));
  assert.equal(completed.frames.length, 1);
  assert.equal(completed.frames[0].payload.toString(), "two");
  assert.equal(completed.remaining.byteLength, 0);
});

test("native frame corruption is rejected", () => {
  const frame = encodeFrame({ requestId: 1, payload: Buffer.from("payload") });
  frame[frame.length - 1] ^= 0xff;
  assert.throws(() => parseFrames(frame), /checksum/);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("native projection transfer carries bounded identity and SHA-256 metadata", () => {
  const transfer = encodeNativeProjectionTransfer({
    sessionId: "core-1",
    sequence: 7,
    projectionType: "viewport-v1",
    result: {
      schemaVersion: 1,
      projectionType: "viewport-v1",
      revision: 12,
      entities: [{ id: "entity-1" }],
      belts: [],
    },
  });
  assert.deepEqual(transfer.header, {
    schemaVersion: 1,
    sessionId: "core-1",
    revision: 12,
    sequence: 7,
    projectionType: "viewport-v1",
    payloadLength: transfer.payload.byteLength,
    sha256: require("node:crypto").createHash("sha256").update(transfer.payload).digest("hex"),
  });
  assert.equal(JSON.parse(transfer.payload).revision, 12);
  assert.throws(() => encodeNativeProjectionTransfer({
    sessionId: "core-1",
    sequence: 8,
    projectionType: "statistics-v1",
    result: {
      schemaVersion: 1,
      projectionType: "statistics-v1",
      revision: 12,
      samples: [{ payload: "x".repeat(MAX_NATIVE_PROJECTION_TRANSFER_BYTES) }],
    },
  }), /transferable block limit/);
});

test("renderer requests cannot provide paths or oversized batches", () => {
  const valid = normalizeNativeSaveBegin({
    slot: "normal-main",
    mode: "normal",
    stateVersion: 47,
    baseChecksum: "01234567",
    registryFingerprint: "builtin:test",
    revision: 1,
    savedAtMs: 1,
  });
  assert.equal(valid.operation, "saveBegin");
  assert.throws(() => normalizeNativeSaveBegin({ ...valid, slot: "../outside" }), /slot/);
  assert.throws(() => normalizeNativeSaveRecords([{ key: "../outside", value: "x" }]), /key/);
  assert.throws(() => normalizeNativeSaveRecords(new Array(9).fill({ key: "base", value: "x" })), /batch/);
  assert.throws(() => normalizeNativeSaveRecords([
    { key: "base", value: "first" },
    { key: "base", value: "second" },
  ]), /repeats a record key/);
});

test("session registry binds transactions to one renderer", async () => {
  const calls = [];
  const client = {
    async request(request) {
      calls.push(request);
      if (request.operation === "saveBegin") return { transactionId: "tx-1" };
      if (request.operation === "saveCommit") return { generation: 1 };
      return { accepted: true };
    },
  };
  const registry = new NativeSaveSessionRegistry(client);
  await registry.begin(7, {
    slot: "normal-main",
    mode: "normal",
    stateVersion: 47,
    baseChecksum: "01234567",
    registryFingerprint: "builtin:test",
    revision: 1,
    savedAtMs: 1,
  });
  await assert.rejects(() => registry.write(8, "tx-1", [{ key: "base", value: "{}" }]), /not owned/);
  await registry.write(7, "tx-1", [{ key: "base", value: "{}" }]);
  assert.equal((await registry.commit(7, "tx-1")).generation, 1);
  await assert.rejects(() => registry.commit(7, "tx-1"), /not owned/);
  assert.deepEqual(calls.map((call) => call.operation), ["saveBegin", "savePut", "saveCommit"]);
});

test("save session batches bounded records when the Rust host advertises support", async () => {
  const calls = [];
  const client = {
    hello: { capabilities: ["native-save-v1", "native-save-put-batch-v1"] },
    async request(request) {
      calls.push(request);
      if (request.operation === "saveBegin") return { transactionId: "tx-batch" };
      if (request.operation === "savePutBatch") return { acceptedRecords: request.records.length };
      return { generation: 1 };
    },
  };
  const registry = new NativeSaveSessionRegistry(client);
  await registry.begin(7, {
    slot: "normal-main",
    mode: "normal",
    stateVersion: 47,
    baseChecksum: "01234567",
    registryFingerprint: "builtin:test",
    revision: 1,
    savedAtMs: 1,
  });
  const receipt = await registry.write(7, "tx-batch", [
    { key: "base", value: "{}" },
    { key: "entities:00000000", value: "[]" },
  ]);
  assert.deepEqual(receipt, { acceptedRecords: 2 });
  assert.deepEqual(calls.map((call) => call.operation), ["saveBegin", "savePutBatch"]);
  assert.deepEqual(calls[1].records, [
    { key: "base", value: "{}" },
    { key: "entities:00000000", value: "[]" },
  ]);
});

test("save session rejects an incomplete native batch receipt", async () => {
  const client = {
    hello: { capabilities: ["native-save-put-batch-v1"] },
    async request(request) {
      if (request.operation === "saveBegin") return { transactionId: "tx-bad-batch" };
      return { acceptedRecords: 0 };
    },
  };
  const registry = new NativeSaveSessionRegistry(client);
  await registry.begin(7, {
    slot: "normal-main",
    mode: "normal",
    stateVersion: 47,
    baseChecksum: "01234567",
    registryFingerprint: "builtin:test",
    revision: 1,
    savedAtMs: 1,
  });
  await assert.rejects(
    () => registry.write(7, "tx-bad-batch", [{ key: "base", value: "{}" }]),
    /invalid save batch receipt/,
  );
});

test("core registry validates bounded catalogs and binds shadow sessions to one renderer", async () => {
  const catalog = {
    protocolVersion: 1,
    registryFingerprint: "builtin:test",
    items: [{ id: "iron_ore", kind: "solid" }],
    buildings: [{ id: "mining_machine", kind: "miner", speed: 1, inputCapacity: 0, outputCapacity: 50, powerDemandKw: 1, powerGenerationKw: 0 }],
    recipes: [],
    belts: [{ tier: 1, speed: 6 }],
  };
  assert.equal(normalizeNativeCoreOpen({
    slot: "normal-main",
    generation: 1,
    rootHash: "a".repeat(64),
    revision: 1,
    registryFingerprint: "builtin:test",
    catalog,
  }).operation, "coreOpen");
  assert.throws(() => normalizeNativeCoreOpen({
    slot: "../outside", generation: 1, rootHash: "a".repeat(64), revision: 1, registryFingerprint: "builtin:test", catalog,
  }), /slot/);
  const calls = [];
  const client = { async request(request) {
    calls.push(request);
    if (request.operation === "coreOpen") return { sessionId: "core-1", authority: "shadow", summary: {} };
    return { revision: 2 };
  } };
  const registry = new NativeCoreSessionRegistry(client);
  await registry.open(7, { slot: "normal-main", generation: 1, rootHash: "a".repeat(64), revision: 1, registryFingerprint: "builtin:test", catalog });
  assert.throws(() => registry.status(8, "core-1"), /not owned/);
  await registry.status(7, "core-1");
  assert.throws(() => registry.advance(7, { sessionId: "core-1", baseRevision: 1, simulationSeconds: -1, wallSeconds: 1 }), /advance/);
  assert.throws(() => registry.commitOperation(7, {
    sessionId: "core-1", commandId: "authority-2", baseRevision: 1,
    simulationSeconds: 0, wallSeconds: 0,
  }), /empty/);
  await registry.commitOperation(7, {
    sessionId: "core-1", commandId: "authority-2", baseRevision: 1,
    simulationSeconds: 1, wallSeconds: 1,
  });
  assert.throws(() => registry.checkpoint(7, { sessionId: "core-1", savedAtMs: -1 }), /timestamp/);
  await registry.checkpoint(7, { sessionId: "core-1", savedAtMs: 2 });
  await registry.close(7, "core-1");
  assert.throws(() => registry.status(7, "core-1"), /not owned/);
  assert.deepEqual(calls.map((call) => call.operation), [
    "coreOpen", "coreStatus", "coreCommitOperation", "coreCheckpoint", "coreClose",
  ]);
});

test("v47 import keeps the selected path outside the renderer request and owner-binds the new session", async () => {
  const catalog = {
    protocolVersion: 1,
    registryFingerprint: "builtin:test",
    items: [{ id: "iron_ore", kind: "solid" }],
    buildings: [{ id: "mining_machine", kind: "miner", speed: 1, inputCapacity: 0, outputCapacity: 50, powerDemandKw: 1, powerGenerationKw: 0 }],
    recipes: [],
    belts: [{ tier: 1, speed: 6 }],
  };
  const sourcePath = process.platform === "win32" ? "C:\\selected\\save.json" : "/selected/save.json";
  const normalized = normalizeNativeCoreImport({ registryFingerprint: "builtin:test", catalog }, sourcePath);
  assert.equal(normalized.operation, "coreImportV47");
  assert.equal(normalized.sourcePath, sourcePath);
  assert.throws(() => normalizeNativeCoreImport({
    registryFingerprint: "builtin:test", catalog, sourcePath,
  }, sourcePath), /request is invalid/);
  assert.throws(() => normalizeNativeCoreImport({ registryFingerprint: "builtin:test", catalog }, "relative.json"), /source/);

  const calls = [];
  const client = {
    hello: { capabilities: ["native-core-v47-stream-import-v1"] },
    async request(request) {
      calls.push(request);
      if (request.operation === "coreImportV47") {
        return {
          sessionId: "core-import-1",
          authority: "shadow",
          checkpoint: { generation: 2 },
          import: { mode: "normal" },
          summary: { mode: "normal" },
        };
      }
      return { revision: 1 };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  const imported = await registry.importV47(7, { registryFingerprint: "builtin:test", catalog }, sourcePath);
  assert.equal(imported.sessionId, "core-import-1");
  assert.equal(calls[0].sourcePath, sourcePath);
  assert.throws(() => registry.status(8, "core-import-1"), /not owned/);
  await registry.close(7, "core-import-1");
});

test("v47 import closes an unowned host session when its receipt is malformed", async () => {
  const catalog = {
    protocolVersion: 1,
    registryFingerprint: "builtin:test",
    items: [{ id: "iron_ore", kind: "solid" }],
    buildings: [], recipes: [], belts: [],
  };
  const sourcePath = process.platform === "win32" ? "C:\\selected\\save.json" : "/selected/save.json";
  const calls = [];
  const client = {
    hello: { capabilities: ["native-core-v47-stream-import-v1"] },
    async request(request) {
      calls.push(request);
      if (request.operation === "coreImportV47") {
        return {
          sessionId: "core-import-invalid",
          authority: "unexpected-authority",
          checkpoint: { generation: 1 },
          import: { mode: "normal" },
          summary: { mode: "normal" },
        };
      }
      return { closed: true };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  await assert.rejects(
    registry.importV47(7, { registryFingerprint: "builtin:test", catalog }, sourcePath),
    /invalid imported core session/,
  );
  assert.deepEqual(calls.map((request) => request.operation), ["coreImportV47", "coreClose"]);
  assert.equal(calls[1].sessionId, "core-import-invalid");
  assert.equal(registry.sessions.size, 0);
});

test("mock child primitives remain compatible with client event expectations", () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  assert.equal(typeof child.stdout.on, "function");
});

test("native host spawn inherits the parent environment and accepts only bounded performance settings", async () => {
  assert.deepEqual(
    normalizeNativeHostSpawnEnvironment({
      DSP_NATIVE_CORE_THREADS: 4,
      DSP_NATIVE_CORE_SYNC_RECORD_DROP: "1",
    }),
    {
      DSP_NATIVE_CORE_THREADS: "4",
      DSP_NATIVE_CORE_SYNC_RECORD_DROP: "1",
    },
  );
  assert.throws(() => normalizeNativeHostSpawnEnvironment({ PATH: "C:\\attacker" }), /unsupported field/);
  assert.throws(() => normalizeNativeHostSpawnEnvironment({ DSP_NATIVE_CORE_THREADS: "16" }), /thread setting/);
  assert.throws(
    () => normalizeNativeHostSpawnEnvironment({ DSP_NATIVE_CORE_SYNC_RECORD_DROP: "true" }),
    /record-drop setting/,
  );

  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("exit", 0, null);
  child.stdin.on("data", (chunk) => {
    const requestFrame = parseFrames(Buffer.from(chunk)).frames[0];
    const request = JSON.parse(requestFrame.payload.toString("utf8"));
    const value = request.operation === "hello"
      ? { protocolVersion: 1, nativeFormatVersion: 1, hostVersion: "test", capabilities: [] }
      : { stopped: true };
    child.stdout.write(encodeFrame({
      requestId: requestFrame.requestId,
      kind: CONTROL_RESPONSE_KIND,
      payload: Buffer.from(JSON.stringify({ ok: true, value }), "utf8"),
    }));
  });
  let spawnOptions = null;
  const client = new NativeHostClient({
    binaryPath: process.platform === "win32" ? "C:\\test\\dsp-native-host.exe" : "/test/dsp-native-host",
    rootPath: process.platform === "win32" ? "C:\\test\\native-data" : "/test/native-data",
    spawnEnvironment: {
      DSP_NATIVE_CORE_THREADS: "8",
      DSP_NATIVE_CORE_SYNC_RECORD_DROP: "1",
    },
    spawnProcess: (_binaryPath, _arguments, options) => {
      spawnOptions = options;
      return child;
    },
  });
  await client.start("test");
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.windowsHide, true);
  assert.equal(spawnOptions.env.DSP_NATIVE_CORE_THREADS, "8");
  assert.equal(spawnOptions.env.DSP_NATIVE_CORE_SYNC_RECORD_DROP, "1");
  for (const expectedKey of ["systemroot", "comspec", "path"]) {
    const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === expectedKey);
    if (key) assert.equal(spawnOptions.env[key], process.env[key]);
  }
  await client.stop();
});
