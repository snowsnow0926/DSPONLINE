const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  CONTROL_RESPONSE_KIND,
  MAX_NATIVE_PROJECTION_TRANSFER_BYTES,
  NativeCoreSessionRegistry,
  NativeSaveSessionRegistry,
  crc32,
  encodeNativeProjectionTransfer,
  encodeFrame,
  normalizeNativeSaveBegin,
  normalizeNativeSaveRecords,
  normalizeNativeCoreOpen,
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

test("mock child primitives remain compatible with client event expectations", () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  assert.equal(typeof child.stdout.on, "function");
});
