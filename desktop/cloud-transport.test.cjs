const test = require("node:test");
const assert = require("node:assert/strict");
const {
  contract,
  exactArrayBuffer,
  exactUint8Array,
  normalizeRequestHeaders,
  requestBodyLimit,
  requestTimeoutMs,
  validRequestId,
} = require("./cloud-transport.cjs");

test("desktop cloud transport covers legacy 30 MiB raw and guaranteed 64 MiB compressed saves", () => {
  assert.equal(contract.guaranteedSavePayloadBytes, 64 * 1024 * 1024);
  assert.equal(contract.rawFallbackSafeLimitBytes, 30 * 1024 * 1024);
  assert.equal(requestBodyLimit({ "content-type": contract.directPayloadContentType }), contract.requestCompressedLimitBytes);
  assert.equal(requestBodyLimit({ "content-type": "application/json" }), contract.legacyJsonRequestLimitBytes);
  assert.ok(contract.singleSaveResponseLimitBytes > contract.guaranteedSavePayloadBytes * 2);
  assert.ok(contract.requestCompressedLimitBytes > contract.guaranteedSavePayloadBytes);
});

test("desktop cloud transport scales and caps timeouts", () => {
  assert.equal(requestTimeoutMs(0, 0), contract.baseTimeoutMs);
  assert.equal(requestTimeoutMs(30 * 1024 * 1024, 0), 60_000);
  assert.equal(requestTimeoutMs(48 * 1024 * 1024, 0), 87_000);
  assert.equal(requestTimeoutMs(96 * 1024 * 1024, 0), 159_000);
  assert.equal(requestTimeoutMs(1, 1, 1), contract.baseTimeoutMs + contract.timeoutPerMibMs);
  assert.equal(requestTimeoutMs(1, 1, 999_999), contract.maximumTimeoutMs);
  assert.equal(requestTimeoutMs(120 * 1024 * 1024, 0, 1), contract.maximumTimeoutMs);
});

test("desktop cloud transport allows only bounded cloud headers", () => {
  assert.deepEqual(normalizeRequestHeaders({
    Authorization: "Bearer test",
    "Content-Encoding": "gzip",
    "X-Dsp-Expected-Revision": "4",
    Cookie: "secret",
    "X-Unknown": "ignored",
  }), {
    authorization: "Bearer test",
    "content-encoding": "gzip",
    "x-dsp-expected-revision": "4",
  });
});

test("desktop cloud transport validates ids and exact buffers", () => {
  assert.equal(validRequestId("cloud_12345678"), true);
  assert.equal(validRequestId("bad"), false);
  const source = new Uint8Array([0, 1, 2, 3]);
  assert.deepEqual([...new Uint8Array(exactArrayBuffer(source.subarray(1, 3)))], [1, 2]);
  assert.deepEqual([...exactUint8Array(source.subarray(1, 3))], [1, 2]);
});
