import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { createCloudServer, inspectDecodedCloudSaveUpload } from "./index.mjs";
import { UploadInspectionScheduler } from "./upload-inspection-scheduler.mjs";
import { computeSaveStateChecksum } from "./save-integrity.mjs";

function baseState(overrides = {}) {
  return {
    version: 24,
    elapsedSeconds: 100,
    entities: [],
    totalProduced: { universe_matrix: 4 },
    metrics: { generationKw: 200, totalItemsPerMinute: 30 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
    ...overrides,
  };
}

function payloadFor(state, mode = "normal") {
  const marked = { ...state, mode };
  const envelope = { formatVersion: 2, savedAt: 123_456, mode, state: marked };
  return JSON.stringify({ ...envelope, checksum: computeSaveStateChecksum(2, marked) });
}

function directDescriptor(payload, overrides = {}) {
  return {
    direct: true,
    expectedRevision: 0,
    requestId: "inspection-test-request",
    declaredOriginalBytes: Buffer.byteLength(payload),
    encoding: "",
    expandedLimit: 68 * 1024 * 1024,
    payloadLimit: 33_553_408,
    ...overrides,
  };
}

async function startServer(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-upload-inspection-"));
  const server = await createCloudServer({
    databaseFile: path.join(directory, "cloud.sqlite"),
    registrationLimit: 100,
    mailer: null,
    logger: { error() {} },
    adminToken: "upload-inspection-admin-1234567890abcdef",
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    directory,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function register(baseUrl, username) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "strong-pass-123", displayName: username }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test("one authoritative payload parse supplies integrity, mode, summary, and leaderboard projection", () => {
  const normal = payloadFor(baseState());
  let parses = 0;
  const inspected = inspectDecodedCloudSaveUpload(Buffer.from(normal), directDescriptor(normal), {
    parseJson(text) {
      parses += 1;
      return JSON.parse(text);
    },
  });
  assert.equal(parses, 1);
  assert.equal(inspected.payloadParseCount, 1);
  assert.equal(inspected.validPayload, true);
  assert.equal(inspected.integrity.valid, true);
  assert.equal(inspected.payloadMode, "normal");
  assert.equal(inspected.summary.elapsedSeconds, 100);
  assert.equal(inspected.leaderboardProjection.totalProduced.universe_matrix, 4);
  assert.equal(inspected.payload, normal);
  assert.equal(inspected.payloadChecksum, createHash("sha256").update(normal).digest("hex"));

  const legacyBody = JSON.stringify({ payload: normal, expectedRevision: 0 });
  parses = 0;
  const legacy = inspectDecodedCloudSaveUpload(Buffer.from(legacyBody), {
    ...directDescriptor(normal),
    direct: false,
    requestId: null,
    declaredOriginalBytes: null,
  }, {
    parseJson(text) {
      parses += 1;
      return JSON.parse(text);
    },
  });
  assert.equal(parses, 2, "legacy transport requires one wrapper parse and one authoritative payload parse");
  assert.equal(legacy.payloadParseCount, 1);
  assert.equal(legacy.payload, normal);

  const corrupted = JSON.parse(normal);
  corrupted.state.elapsedSeconds += 1;
  const corruptedText = JSON.stringify(corrupted);
  const invalid = inspectDecodedCloudSaveUpload(Buffer.from(corruptedText), directDescriptor(corruptedText));
  assert.equal(invalid.validPayload, false);
  assert.equal(invalid.integrity.valid, false);
  assert.equal(invalid.summary.integrity, "invalid");
  assert.equal(invalid.payloadChecksum, null);
});

test("invalid and mode-mismatched payloads never enter the atomic mutation queue", async (t) => {
  const phases = [];
  const running = await startServer({
    persistenceFaultInjector: ({ phase, operation }) => phases.push(`${operation ?? "unknown"}:${phase}`),
  });
  t.after(() => running.close());
  const account = await register(running.baseUrl, "inspection_reject");
  phases.length = 0;
  const malformed = await fetch(`${running.baseUrl}/api/cloud-save?mode=normal`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${account.token}`,
      "content-type": "application/vnd.dspidle.save+json",
      "x-dsp-expected-revision": "0",
    },
    body: "not-json",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "SAVE_FORMAT_INVALID");
  const speedrun = payloadFor(baseState(), "speedrun");
  const mismatch = await fetch(`${running.baseUrl}/api/cloud-save?mode=normal`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${account.token}`,
      "content-type": "application/vnd.dspidle.save+json",
      "x-dsp-expected-revision": "0",
    },
    body: speedrun,
  });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).code, "SAVE_MODE_MISMATCH");
  assert.deepEqual(phases, []);
});

test("streamed cloud download escapes arbitrary payload strings without changing parsed bytes", async (t) => {
  const running = await startServer({ uploadInspectionWorkerThresholdBytes: 64 * 1024 });
  t.after(() => running.close());
  const account = await register(running.baseUrl, "inspection_stream");
  const payload = payloadFor(baseState({
    padding: `${"stream-\\\"\n\r\t".repeat(15_000)}😀尾`,
  }), "normal");
  const upload = await fetch(`${running.baseUrl}/api/cloud-save?mode=normal&slot=3`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${account.token}`,
      "content-type": "application/vnd.dspidle.save+json",
      "x-dsp-expected-revision": "0",
    },
    body: payload,
  });
  assert.equal(upload.status, 200, await upload.text());
  const downloaded = await fetch(`${running.baseUrl}/api/cloud-save?mode=normal&slot=3`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  assert.equal(downloaded.headers.get("content-length"), null);
  const body = await downloaded.json();
  assert.equal(body.cloudSave.payload, payload);
  assert.equal(body.cloudSave.checksum, createHash("sha256").update(payload).digest("hex"));
  assert.equal(body.mode, "normal");
  assert.equal(body.slot, "3");
});

test("scheduler is FIFO, bounded, cancellable, and returns Retry-After when saturated", async () => {
  const scheduler = new UploadInspectionScheduler({
    inspectInline: () => ({}),
    concurrency: 1,
    queueLimit: 1,
    workerThresholdBytes: 64 * 1024,
  });
  const order = [];
  let releaseFirst;
  const first = scheduler.run(async () => {
    order.push("first-start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    order.push("first-end");
  });
  const second = scheduler.run(async () => { order.push("second"); });
  await assert.rejects(
    scheduler.run(async () => { order.push("third"); }),
    (error) => error.code === "UPLOAD_INSPECTION_BUSY" && error.statusCode === 503 && error.retryAfterSeconds === 1,
  );
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);

  let releaseActive;
  const active = scheduler.run(() => new Promise((resolve) => { releaseActive = resolve; }));
  const abortController = new AbortController();
  const queued = scheduler.run(async () => {}, { signal: abortController.signal });
  abortController.abort();
  await assert.rejects(queued, (error) => error.code === "UPLOAD_CANCELLED");
  releaseActive();
  await active;
  scheduler.close();
});

test("scheduler bounds concurrent expanded bytes independently from request count", async () => {
  const scheduler = new UploadInspectionScheduler({
    inspectInline: () => ({}),
    concurrency: 3,
    queueLimit: 4,
    workerThresholdBytes: 64 * 1024,
    maximumConcurrentExpandedBytes: 96 * 1024 * 1024,
  });
  const order = [];
  let releaseFirst;
  const first = scheduler.run(async () => {
    order.push("64-start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    order.push("64-end");
  }, { expandedBytes: 64 * 1024 * 1024 });
  const second = scheduler.run(async () => { order.push("64-second"); }, { expandedBytes: 64 * 1024 * 1024 });
  const small = scheduler.run(async () => { order.push("32-small"); }, { expandedBytes: 32 * 1024 * 1024 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["64-start", "32-small"], "a fitting request may run without exceeding the byte budget");
  assert.equal(scheduler.snapshot().maxActiveExpandedBytes, 96 * 1024 * 1024);
  releaseFirst();
  await Promise.all([first, second, small]);
  assert.deepEqual(order, ["64-start", "32-small", "64-end", "64-second"]);
  assert.equal(scheduler.snapshot().activeExpandedBytes, 0);
  scheduler.close();
});

test("gzip inspection rejects expanded bodies at the descriptor cap without a huge fixture", async () => {
  const scheduler = new UploadInspectionScheduler({
    inspectInline: inspectDecodedCloudSaveUpload,
    workerThresholdBytes: 64 * 1024,
  });
  const expandedLimit = 128 * 1024;
  const compressed = gzipSync(Buffer.alloc(expandedLimit + 1, 0x78));
  await assert.rejects(
    scheduler.inspect(compressed, {
      ...directDescriptor("x"),
      encoding: "gzip",
      declaredOriginalBytes: null,
      expandedLimit,
      payloadLimit: expandedLimit,
    }),
    (error) => error.code === "REQUEST_EXPANDED_BODY_TOO_LARGE"
      && error.statusCode === 413
      && error.expandedLimitBytes === expandedLimit
      && error.expandedBytesAtLeast === true,
  );
  scheduler.close();
});

test("large direct raw and gzip uploads use workers and preserve payload, checksum, revision, mode, and slot", async (t) => {
  const running = await startServer({ uploadInspectionWorkerThresholdBytes: 64 * 1024 });
  t.after(() => running.close());
  const account = await register(running.baseUrl, "inspection_worker");
  const padding = "upload-worker-data-".repeat(80_000);
  const normal = payloadFor(baseState({ padding, elapsedSeconds: 120 }), "normal");
  const speedrun = payloadFor(baseState({ padding, elapsedSeconds: 240, speedrun: {
    enabled: true,
    mode: "speedrun",
    factoryId: "inspection-speedrun-factory",
  } }), "speedrun");
  const upload = async (route, payload, compressed) => {
    const response = await fetch(`${running.baseUrl}${route}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${account.token}`,
        "content-type": "application/vnd.dspidle.save+json",
        "x-dsp-expected-revision": "0",
        "x-dsp-save-original-bytes": String(Buffer.byteLength(payload)),
        ...(compressed ? { "content-encoding": "gzip" } : {}),
      },
      body: compressed ? gzipSync(Buffer.from(payload)) : payload,
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const normalResult = await upload("/api/cloud-save?mode=normal", normal, false);
  const speedrunResult = await upload("/api/cloud-save?mode=speedrun&slot=2", speedrun, true);
  assert.equal(normalResult.cloudSave.revision, 1);
  assert.equal(speedrunResult.cloudSave.revision, 1);
  for (const [route, expected, mode, slot] of [
    ["/api/cloud-save?mode=normal", normal, "normal", "main"],
    ["/api/cloud-save?mode=speedrun&slot=2", speedrun, "speedrun", "2"],
  ]) {
    const response = await fetch(`${running.baseUrl}${route}`, { headers: { authorization: `Bearer ${account.token}` } });
    const body = await response.json();
    assert.equal(body.cloudSave.payload, expected);
    assert.equal(body.cloudSave.checksum, createHash("sha256").update(expected).digest("hex"));
    assert.equal(body.cloudSave.mode, mode);
    assert.equal(body.cloudSave.slot, slot);
  }
  const metrics = running.server.uploadInspections.snapshot();
  assert.equal(metrics.workerRuns, 2);
  assert.equal(metrics.inlineRuns, 0);
  assert.equal(metrics.completed, 2);
});

test("worker leaderboard projection matches the legacy full-state result across adjacent revisions", async (t) => {
  const running = await startServer({ uploadInspectionWorkerThresholdBytes: 64 * 1024 });
  t.after(() => running.close());
  const account = await register(running.baseUrl, "inspection_ranking");
  const padding = "ranking-worker-data-".repeat(70_000);
  const firstState = baseState({
    padding,
    elapsedSeconds: 100,
    totalProduced: { universe_matrix: 10, iron_ingot: 100 },
    metrics: { generationKw: 1_000, totalItemsPerMinute: 30 },
    planetMetrics: { home: { totalItemsPerMinute: 40 }, mars: { totalItemsPerMinute: 60 } },
    activePlanetId: "home",
    dysonSwarm: { generationKw: 500 },
    dysonSphere: { generationKw: 1_500 },
  });
  const secondState = {
    ...firstState,
    elapsedSeconds: 160,
    totalProduced: { universe_matrix: 70, iron_ingot: 400 },
  };
  const first = payloadFor(firstState, "normal");
  const second = payloadFor(secondState, "normal");
  for (const [payload, expectedRevision] of [[first, 0], [second, 1]]) {
    const response = await fetch(`${running.baseUrl}/api/cloud-save?mode=normal`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${account.token}`,
        "content-type": "application/vnd.dspidle.save+json",
        "content-encoding": "gzip",
        "x-dsp-expected-revision": String(expectedRevision),
      },
      body: gzipSync(Buffer.from(payload)),
    });
    assert.equal(response.status, 200, await response.text());
  }
  const through = await fetch(`${running.baseUrl}/api/leaderboard/me?category=throughput&seasonId=season_01`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  const throughput = await through.json();
  assert.equal(through.status, 200);
  assert.equal(throughput.status, "ranked");
  assert.equal(throughput.serverMetrics.peakThroughputPerMinute, 360);
  assert.equal(throughput.serverMetrics.theoreticalPeakThroughputPerMinute, 100);
  assert.equal(throughput.serverMetrics.activePlanetThroughputPerMinute, 40);
  assert.equal(throughput.serverMetrics.peakDysonPowerKw, 2_000);
  const white = await fetch(`${running.baseUrl}/api/leaderboard/me?category=white-rate&seasonId=season_01`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  const whiteRate = await white.json();
  assert.equal(white.status, 200);
  assert.equal(whiteRate.status, "ranked");
  assert.equal(whiteRate.serverMetrics.peakWhiteMatrixPerMinute, 60);
  assert.equal(running.server.uploadInspections.snapshot().workerRuns, 2);
  const metrics = await fetch(`${running.baseUrl}/api/admin/metrics`, {
    headers: { authorization: "Bearer upload-inspection-admin-1234567890abcdef" },
  });
  const metricsBody = await metrics.json();
  assert.equal(metrics.status, 200);
  assert.equal(metricsBody.runtime.uploadInspections.workerRuns, 2);
  assert.equal(metricsBody.runtime.uploadInspections.maxExpandedBytes, Buffer.byteLength(second));
  assert.equal(JSON.stringify(metricsBody.runtime.uploadInspections).includes(padding), false);
});

test("concurrent large uploads are admitted FIFO with bounded workers and persist independently", async (t) => {
  const running = await startServer({
    uploadInspectionConcurrency: 2,
    uploadInspectionQueueLimit: 8,
    uploadInspectionWorkerThresholdBytes: 64 * 1024,
  });
  t.after(() => running.close());
  const account = await register(running.baseUrl, "inspection_parallel");
  const padding = "parallel-worker-data-".repeat(70_000);
  const routes = [
    "/api/cloud-save?mode=normal",
    "/api/cloud-save?mode=normal&slot=1",
    "/api/cloud-save?mode=normal&slot=2",
    "/api/cloud-save?mode=normal&slot=3",
  ];
  const responses = await Promise.all(routes.map(async (route, index) => {
    const payload = payloadFor(baseState({ padding, elapsedSeconds: 1_000 + index }), "normal");
    const response = await fetch(`${running.baseUrl}${route}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${account.token}`,
        "content-type": "application/vnd.dspidle.save+json",
        "content-encoding": "gzip",
        "x-dsp-expected-revision": "0",
      },
      body: gzipSync(Buffer.from(payload)),
    });
    return { response, body: await response.json(), payload };
  }));
  for (const result of responses) {
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.cloudSave.checksum, createHash("sha256").update(result.payload).digest("hex"));
  }
  const metrics = running.server.uploadInspections.snapshot();
  assert.equal(metrics.workerRuns, 4);
  assert.ok(metrics.maxQueued >= 1);
  assert.equal(metrics.active, 0);
  assert.equal(metrics.queued, 0);
});

test("saturated HTTP upload inspection returns Retry-After before reading another large body", async (t) => {
  const running = await startServer({
    uploadInspectionConcurrency: 1,
    uploadInspectionQueueLimit: 1,
    uploadInspectionWorkerThresholdBytes: 64 * 1024,
  });
  t.after(() => running.close());
  const account = await register(running.baseUrl, "inspection_busy");
  const payload = payloadFor(baseState({ padding: "busy-worker-data-".repeat(70_000) }), "normal");
  let releaseFirst;
  const first = running.server.uploadInspections.run(() => new Promise((resolve) => { releaseFirst = resolve; }));
  const queued = running.server.uploadInspections.run(async () => {});
  const response = await fetch(`${running.baseUrl}/api/cloud-save?mode=normal`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${account.token}`,
      "content-type": "application/vnd.dspidle.save+json",
      "content-encoding": "gzip",
      "x-dsp-expected-revision": "0",
    },
    body: gzipSync(Buffer.from(payload)),
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal(body.code, "UPLOAD_INSPECTION_BUSY");
  releaseFirst();
  await Promise.all([first, queued]);
  const cloud = await fetch(`${running.baseUrl}/api/cloud-save?mode=normal`, { headers: { authorization: `Bearer ${account.token}` } });
  assert.equal((await cloud.json()).cloudSave, null);
});

test("server shutdown cancels an in-flight large body before it creates a revision", async (t) => {
  const running = await startServer({
    uploadInspectionConcurrency: 1,
    uploadInspectionQueueLimit: 2,
    uploadInspectionWorkerThresholdBytes: 64 * 1024,
  });
  t.after(() => running.close());
  const account = await register(running.baseUrl, "inspection_shutdown");
  const payload = payloadFor(baseState({ padding: "shutdown-worker-data-".repeat(70_000) }), "normal");
  let releaseBlocker;
  const blocker = running.server.uploadInspections.run(() => new Promise((resolve) => { releaseBlocker = resolve; }));
  const upload = fetch(`${running.baseUrl}/api/cloud-save?mode=normal`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${account.token}`,
      "content-type": "application/vnd.dspidle.save+json",
      "content-encoding": "gzip",
      "x-dsp-expected-revision": "0",
    },
    body: gzipSync(Buffer.from(payload)),
  });
  while (running.server.uploadInspections.snapshot().queued < 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const closed = running.server.shutdown();
  const response = await upload;
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "SERVER_SHUTTING_DOWN");
  releaseBlocker();
  await blocker;
  await closed;
  const database = new (await import("better-sqlite3")).default(path.join(running.directory, "cloud.sqlite"), { readonly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM cloud_save_payloads").get().count, 0);
  } finally {
    database.close();
  }
});
