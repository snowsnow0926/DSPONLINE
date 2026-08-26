const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  CONTROL_RESPONSE_KIND,
  NativeSaveSessionRegistry,
  crc32,
  encodeFrame,
  normalizeNativeSaveBegin,
  normalizeNativeSaveRecords,
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

test("mock child primitives remain compatible with client event expectations", () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  assert.equal(typeof child.stdout.on, "function");
});

