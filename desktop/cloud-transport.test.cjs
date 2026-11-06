const test = require("node:test");
const assert = require("node:assert/strict");
const {
  contract,
  exactArrayBuffer,
  exactUint8Array,
  normalizeRequestHeaders,
  normalizeTransferRequestHeaders,
  requestBodyLimit,
  requestTimeoutMs,
  validRequestId,
} = require("./cloud-transport.cjs");
const { validatePackagedTransferContract } = require("./package-contract.cjs");

test("desktop cloud transport covers legacy raw fallback and the 256 MiB save boundary", () => {
  assert.equal(contract.guaranteedSavePayloadBytes, 96 * 1024 * 1024);
  assert.equal(contract.savePayloadLimitBytes, 256 * 1024 * 1024);
  assert.equal(contract.rawFallbackSafeLimitBytes, 30 * 1024 * 1024);
  assert.equal(requestBodyLimit({ "content-type": contract.directPayloadContentType }), contract.requestCompressedLimitBytes);
  assert.equal(requestBodyLimit({ "content-type": "application/json" }), contract.legacyJsonRequestLimitBytes);
  assert.ok(contract.singleSaveResponseLimitBytes > contract.guaranteedSavePayloadBytes * 2);
  assert.ok(contract.requestCompressedLimitBytes > contract.guaranteedSavePayloadBytes);
});

test("desktop packaging accepts only the complete frozen 256 MiB transfer contract", () => {
  assert.equal(validatePackagedTransferContract(contract, contract), true);
  assert.throws(() => validatePackagedTransferContract({
    ...contract,
    guaranteedSavePayloadBytes: 64 * 1024 * 1024,
  }, contract), /冻结源码不一致/);
  const legacy = {
    ...contract,
    guaranteedSavePayloadBytes: 64 * 1024 * 1024,
    maximumTimeoutMs: 120_000,
  };
  assert.throws(() => validatePackagedTransferContract(legacy, legacy), /大存档云传输契约/);
});

test("desktop cloud transport scales and caps timeouts", () => {
  assert.equal(requestTimeoutMs(0, 0), contract.baseTimeoutMs);
  assert.equal(requestTimeoutMs(30 * 1024 * 1024, 0), 60_000);
  assert.equal(requestTimeoutMs(48 * 1024 * 1024, 0), 87_000);
  assert.equal(requestTimeoutMs(96 * 1024 * 1024, 0), 159_000);
  assert.equal(requestTimeoutMs(256 * 1024 * 1024, 0), 399_000);
  assert.equal(requestTimeoutMs(1, 1, 1), contract.baseTimeoutMs + contract.timeoutPerMibMs);
  assert.equal(requestTimeoutMs(1, 1, 999_999), contract.maximumTimeoutMs);
  assert.equal(requestTimeoutMs(400 * 1024 * 1024, 0, 1), contract.maximumTimeoutMs);
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

test("desktop cloud reads keep the IPC request ID out of HTTP headers", async () => {
  const { bodyCapabilityForRoute } = await import("../server/http-route-policy.mjs");
  const { inspectHttpRequest } = await import("../server/http-security.mjs");
  for (const path of ["/cloud-save", "/cloud-save?slotId=1", "/cloud-save?mode=speedrun", "/account", "/account/export/archive"]) {
    const headers = normalizeTransferRequestHeaders({ method: "GET", path, requestId: "download_12345678", headers: { authorization: "Bearer test", "x-dsp-save-mode": "speedrun" } });
    assert.equal(headers[contract.requestIdHeader], undefined, path);
    assert.equal(headers["x-dsp-save-mode"], "speedrun");
    const allowed = bodyCapabilityForRoute("GET", `/api${path.split("?")[0]}`).allowedCustomHeaders;
    assert.deepEqual(Object.keys(headers).filter((name) => name.startsWith("x-dsp-") && !allowed.includes(name)), []);
    const bodyCapability = bodyCapabilityForRoute("GET", `/api${path.split("?")[0]}`);
    assert.throws(() => inspectHttpRequest({ method: "GET", headers: { ...headers, [contract.requestIdHeader]: "download_12345678" } }, { bodyCapability }), (error) => error.code === "DSP_HEADER_NOT_ALLOWED");
    assert.doesNotThrow(() => inspectHttpRequest({ method: "GET", headers }, { bodyCapability }));
  }
});

test("only a direct cloud upload receives the transfer idempotency header", () => {
  const request = { method: "PUT", path: "/cloud-save?slotId=2", requestId: "upload_12345678", headers: { "content-type": contract.directPayloadContentType, [contract.expectedRevisionHeader]: "7" } };
  assert.equal(normalizeTransferRequestHeaders(request)[contract.requestIdHeader], request.requestId);
  for (const change of [{ method: "POST" }, { path: "/account" }, { headers: { "content-type": "application/json" } }]) {
    assert.equal(normalizeTransferRequestHeaders({ ...request, ...change })[contract.requestIdHeader], undefined);
  }
});
