import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  createApiHandoffProxy,
  requestRequiresWriter,
  writeApiProxyState,
} from "./api-handoff-proxy.mjs";

let directory;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dsp-api-handoff-proxy-"));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function getText(url, options = {}) {
  const target = new URL(url);
  const body = options.body === undefined ? null : Buffer.from(String(options.body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      agent: false,
      headers: body ? { "content-length": String(body.byteLength) } : {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.once("error", reject);
    });
    request.setTimeout(15_000, () => request.destroy(new Error(
      `test request timed out: ${options.method ?? "GET"} ${target.pathname}${target.search}`,
    )));
    request.once("error", reject);
    request.end(body);
  });
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}

async function reservePort() {
  const server = createNetServer();
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function consumeRequest(request) {
  if (request.readableEnded) return;
  request.resume();
  await once(request, "end");
}

async function waitForRequestBody(request) {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  if (!request.readableEnded) await once(request, "end");
  return Buffer.concat(chunks).toString("utf8");
}

test("classifies writer routes without treating ordinary reads as mutations", () => {
  assert.equal(requestRequiresWriter("GET", "/api/health"), false);
  assert.equal(requestRequiresWriter("HEAD", "/api/leaderboard"), false);
  assert.equal(requestRequiresWriter("OPTIONS", "/api/cloud-save"), false);
  assert.equal(requestRequiresWriter("GET", "/api/account/export"), true);
  assert.equal(requestRequiresWriter("POST", "/api/account/import/archive"), true);
  assert.equal(requestRequiresWriter("PUT", "/api/cloud-save"), true);
});

test("holds requests during writer handoff and switches upstream without 502 or 504", async () => {
  let releaseOldUpload;
  const oldUploadGate = new Promise((resolve) => { releaseOldUpload = resolve; });
  let markOldUploadReceived;
  const oldUploadReceived = new Promise((resolve) => { markOldUploadReceived = resolve; });
  const oldServer = http.createServer(async (request, response) => {
    const body = await waitForRequestBody(request);
    if (request.url === "/api/cloud-save") {
      markOldUploadReceived(body);
      await oldUploadGate;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("old");
  });
  const newServer = http.createServer(async (request, response) => {
    await consumeRequest(request);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("new");
  });
  const oldPort = await listen(oldServer);
  const newPort = await listen(newServer);
  const stateFile = path.join(directory, "proxy-state.json");
  const statusFile = path.join(directory, "proxy-status.json");
  await writeApiProxyState(stateFile, {
    version: 1,
    generation: 1,
    mode: "forward",
    changedAt: Date.now(),
    upstream: { host: "127.0.0.1", port: oldPort, slot: "blue", releaseId: "old" },
  });
  const proxyPort = await reservePort();
  const proxy = createApiHandoffProxy({ stateFile, statusFile, port: proxyPort, pollIntervalMs: 10, maximumHoldMs: 5_000 });
  await proxy.start();
  try {
    const baseUrl = `http://127.0.0.1:${proxyPort}`;
    const upload = getText(`${baseUrl}/api/cloud-save`, { method: "PUT", body: "payload" });
    assert.equal(await oldUploadReceived, "payload");
    await writeApiProxyState(stateFile, {
      version: 1,
      generation: 2,
      mode: "drain",
      changedAt: Date.now(),
      upstream: { host: "127.0.0.1", port: oldPort, slot: "blue", releaseId: "old" },
    });
    await proxy.applyState();
    // A periodic state read may already be in flight, in which case the
    // explicit applyState call returns before the new generation is visible.
    await waitUntil(() => proxy.status().generation === 2 && proxy.status().mode === "drain");
    const queuedWrite = getText(`${baseUrl}/api/cloud-save`, { method: "PUT", body: "queued" });
    const read = await getText(`${baseUrl}/api/health`);
    assert.deepEqual(read, { status: 200, body: "old" });
    await waitUntil(() => proxy.status().queuedWriterRequests === 1);
    releaseOldUpload();
    assert.deepEqual(await upload, { status: 200, body: "old" });

    await writeApiProxyState(stateFile, {
      version: 1,
      generation: 3,
      mode: "hold",
      changedAt: Date.now(),
      upstream: { host: "127.0.0.1", port: oldPort, slot: "blue", releaseId: "old" },
    });
    await proxy.applyState();
    await waitUntil(() => proxy.status().generation === 3 && proxy.status().mode === "hold");
    const heldRead = getText(`${baseUrl}/api/health`);
    await waitUntil(() => proxy.status().queuedRequests === 2);
    await writeApiProxyState(stateFile, {
      version: 1,
      generation: 4,
      mode: "forward",
      changedAt: Date.now(),
      upstream: { host: "127.0.0.1", port: newPort, slot: "green", releaseId: "new" },
    });
    await proxy.applyState();
    await waitUntil(() => proxy.status().generation === 4 && proxy.status().mode === "forward");
    assert.deepEqual(await queuedWrite, { status: 200, body: "new" });
    assert.deepEqual(await heldRead, { status: 200, body: "new" });
    assert.equal(proxy.status().failedRequests, 0);
    assert.equal(proxy.status().rejectedRequests, 0);
  } finally {
    await proxy.close();
    await Promise.all([close(oldServer), close(newServer)]);
  }
});

test("retries one stale reused socket for a bodyless read but never retries a writer", async () => {
  const requestsBySocket = new WeakMap();
  let resetRead = false;
  let writeAttempts = 0;
  const upstream = http.createServer(async (request, response) => {
    const count = (requestsBySocket.get(request.socket) ?? 0) + 1;
    requestsBySocket.set(request.socket, count);
    await consumeRequest(request);
    if (request.url === "/api/health" && count === 2 && !resetRead) {
      resetRead = true;
      request.socket.destroy();
      return;
    }
    if (request.url === "/api/cloud-save") {
      writeAttempts += 1;
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("healthy");
  });
  const upstreamPort = await listen(upstream);
  const stateFile = path.join(directory, "stale-socket-state.json");
  const statusFile = path.join(directory, "stale-socket-status.json");
  await writeApiProxyState(stateFile, {
    version: 1,
    generation: 1,
    mode: "forward",
    changedAt: Date.now(),
    upstream: { host: "127.0.0.1", port: upstreamPort, slot: "blue", releaseId: "stale-socket" },
  });
  const proxyPort = await reservePort();
  const warnings = [];
  const proxy = createApiHandoffProxy({
    stateFile,
    statusFile,
    port: proxyPort,
    pollIntervalMs: 10,
    maximumHoldMs: 5_000,
    logger: { error() {}, warn(message, details) { warnings.push({ message, details }); } },
  });
  await proxy.start();
  try {
    const baseUrl = `http://127.0.0.1:${proxyPort}`;
    assert.deepEqual(await getText(`${baseUrl}/api/health`), { status: 200, body: "healthy" });
    assert.deepEqual(await getText(`${baseUrl}/api/health`), { status: 200, body: "healthy" });
    assert.equal(proxy.status().retriedRequests, 1);
    assert.equal(proxy.status().failedRequests, 0);
    assert.equal(warnings.length, 1);

    const write = await getText(`${baseUrl}/api/cloud-save`, { method: "PUT", body: "single-attempt" });
    assert.equal(write.status, 503);
    assert.equal(writeAttempts, 1);
    assert.equal(proxy.status().retriedRequests, 1);
    assert.equal(proxy.status().failedRequests, 1);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test("continuous synthetic traffic observes no 502 or 504 across a hold and upstream switch", async () => {
  const oldServer = http.createServer((_request, response) => setTimeout(() => response.end("old"), 4));
  const newServer = http.createServer((_request, response) => setTimeout(() => response.end("new"), 4));
  const oldPort = await listen(oldServer);
  const newPort = await listen(newServer);
  const stateFile = path.join(directory, "continuous-state.json");
  const statusFile = path.join(directory, "continuous-status.json");
  await writeApiProxyState(stateFile, {
    version: 1,
    generation: 1,
    mode: "forward",
    changedAt: Date.now(),
    upstream: { host: "127.0.0.1", port: oldPort, slot: "blue", releaseId: "old" },
  });
  const proxyPort = await reservePort();
  const proxy = createApiHandoffProxy({ stateFile, statusFile, port: proxyPort, pollIntervalMs: 10, maximumHoldMs: 5_000 });
  await proxy.start();
  const statuses = [];
  let running = true;
  const traffic = (async () => {
    while (running) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/health`, { signal: AbortSignal.timeout(5_000) });
      statuses.push(response.status);
      await response.arrayBuffer();
    }
  })();
  try {
    await waitUntil(() => statuses.length >= 10);
    await writeApiProxyState(stateFile, {
      version: 1,
      generation: 2,
      mode: "hold",
      changedAt: Date.now(),
      upstream: { host: "127.0.0.1", port: oldPort, slot: "blue", releaseId: "old" },
    });
    await proxy.applyState();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeApiProxyState(stateFile, {
      version: 1,
      generation: 3,
      mode: "forward",
      changedAt: Date.now(),
      upstream: { host: "127.0.0.1", port: newPort, slot: "green", releaseId: "new" },
    });
    await proxy.applyState();
    await waitUntil(() => statuses.length >= 30);
  } finally {
    running = false;
    await traffic;
    await proxy.close();
    await Promise.all([close(oldServer), close(newServer)]);
  }
  assert.ok(statuses.length >= 30);
  assert.deepEqual([...new Set(statuses)], [200]);
  assert.equal(statuses.filter((status) => status === 502 || status === 504).length, 0);
});
