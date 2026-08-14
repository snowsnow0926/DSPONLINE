import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createCloudServer } from "./index.mjs";
import { computeSaveStateChecksum } from "./save-integrity.mjs";

function createV46State(mode = "normal") {
  return {
    version: 46,
    mode,
    elapsedSeconds: 600,
    entities: [
      { id: "storage", kind: "storage", buildingId: "storage_mk1" },
      {
        id: "station",
        kind: "station",
        buildingId: "interstellar_logistics_station",
        quantumMode: "legacy",
        stationSlots: [
          { itemId: "iron_ore", localMode: "supply", minimumLoad: 0.25, minStock: 10, priority: 2, routePolicy: "direct", warperBudget: 4 },
          {},
          { itemId: "copper_ore", remoteMode: "supply" },
        ],
      },
    ],
    belts: [{ id: "belt", source: "storage", target: "storage", itemId: "iron_ore" }],
    settings: {
      productionBufferLimit: 1_000_000,
      logisticsBufferLimit: 1_000_000,
      beltBufferLimit: 100_000_000,
      proliferatorBufferLimit: 600,
    },
    contentPacks: [],
    galaxy: { planetMetadata: {}, systemMetadata: {} },
    quantumLogisticsNetwork: {
      enabled: false,
      inventory: {},
      routingCursors: {},
      itemCapacities: {},
      uploadRoutingCursors: {},
    },
    constructionAutomation: { destroyedByproducts: {} },
    blueprints: [],
    blueprintVersions: [],
    constructionQueue: [],
    dysonPlans: {},
    timeWarp: {
      controllerEntityId: null,
      enabled: false,
      requestedMultiplier: 5,
      effectiveMultiplier: 1,
      pendingSimulationSeconds: 0,
      pendingWallSeconds: 0,
      requiredPowerKw: 0,
      allocatedPowerKw: 0,
    },
    endgame: {
      infiniteResearch: Object.fromEntries([
        "matrix_compression",
        "vein_utilization",
        "galactic_logistics",
        "stellar_harnessing",
        "continuum_simulation",
      ].map((id) => [id, { level: 0, progress: "0" }])),
    },
    totalProduced: {},
    metrics: { generationKw: 0, totalItemsPerMinute: 0, rayGenerationKw: 0 },
    exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
  };
}

function createPayload(state, savedAt = 123_456) {
  const envelope = { formatVersion: 2, savedAt, mode: state.mode, state };
  return JSON.stringify({
    ...envelope,
    checksum: computeSaveStateChecksum(envelope.formatVersion, state),
  });
}

function createDenseV45Payload() {
  const state = createV46State("normal");
  state.version = 45;
  state.entities = state.entities.slice(0, 1);
  state.entities[0].interactionLocked = false;
  Object.assign(state.belts[0], { lanes: 1, tier: 1, progress: 0 });
  delete state.blueprintVersions;
  delete state.constructionQueue;
  return createPayload(state, 45);
}

async function startServer(databaseFile) {
  const server = await createCloudServer({
    databaseFile,
    historyPruneIntervalMs: 0,
    registrationLimit: 100,
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function stopServer(server) {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function register(baseUrl, username) {
  const registered = await request(baseUrl, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password: "synthetic-pass-123", displayName: "合成测试账号" }),
  });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
  return {
    accountId: registered.body.user.id,
    headers: { authorization: `Bearer ${registered.body.token}` },
  };
}

test("v46 sparse defaults upload unchanged across modes, slots, history, restore, and restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-v46-sparse-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  let running;
  try {
    running = await startServer(databaseFile);
    const { headers } = await register(running.baseUrl, "sparse_v46_modes");
    const payloads = {
      normalMain: createPayload(createV46State("normal"), 101),
      normalManual: createPayload(createV46State("normal"), 102),
      speedrunMain: createPayload(createV46State("speedrun"), 103),
      speedrunManual: createPayload(createV46State("speedrun"), 104),
    };
    const uploads = [
      ["/api/cloud-save", payloads.normalMain],
      ["/api/cloud-save?slot=1", payloads.normalManual],
      ["/api/cloud-save?mode=speedrun", payloads.speedrunMain],
      ["/api/cloud-save?mode=speedrun&slot=1", payloads.speedrunManual],
    ];

    for (const [route, payload] of uploads) {
      const uploaded = await request(running.baseUrl, route, {
        method: "PUT",
        headers,
        body: JSON.stringify({ payload, expectedRevision: 0 }),
      });
      assert.equal(uploaded.response.status, 200, `${route}: ${JSON.stringify(uploaded.body)}`);
      assert.equal(uploaded.body.cloudSave.revision, 1);
      assert.equal(uploaded.body.cloudSave.checksum, createHash("sha256").update(payload).digest("hex"));
    }

    for (const [route, payload] of uploads) {
      const downloaded = await request(running.baseUrl, route, { headers });
      assert.equal(downloaded.response.status, 200);
      assert.equal(downloaded.body.cloudSave.payload, payload);
      assert.equal(JSON.parse(downloaded.body.cloudSave.payload).checksum, JSON.parse(payload).checksum);
    }

    const normalRevision2 = createPayload({ ...createV46State("normal"), elapsedSeconds: 1_200 }, 105);
    const revision2 = await request(running.baseUrl, "/api/cloud-save", {
      method: "PUT",
      headers,
      body: JSON.stringify({ payload: normalRevision2, expectedRevision: 1 }),
    });
    assert.equal(revision2.response.status, 200, JSON.stringify(revision2.body));
    const history = await request(running.baseUrl, "/api/cloud-save/history", { headers });
    assert.deepEqual(history.body.history.map((entry) => entry.revision), [2, 1]);
    const restored = await request(running.baseUrl, "/api/cloud-save/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: 1, expectedRevision: 2 }),
    });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.cloudSave.revision, 3);
    assert.equal((await request(running.baseUrl, "/api/cloud-save", { headers })).body.cloudSave.payload, payloads.normalMain);
    assert.equal((await request(running.baseUrl, "/api/cloud-save?mode=speedrun", { headers })).body.cloudSave.payload, payloads.speedrunMain);

    await stopServer(running.server);
    running = await startServer(databaseFile);
    assert.equal((await request(running.baseUrl, "/api/cloud-save", { headers })).body.cloudSave.payload, payloads.normalMain);
    assert.equal((await request(running.baseUrl, "/api/cloud-save?mode=speedrun", { headers })).body.cloudSave.payload, payloads.speedrunMain);
    assert.deepEqual(
      (await request(running.baseUrl, "/api/cloud-save/history", { headers })).body.history.map((entry) => entry.revision),
      [3, 2, 1],
    );
  } finally {
    await stopServer(running?.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a sparse v46 payload above the old 32 MiB ceiling round-trips, restores, and survives restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-v46-large-33m-"));
  const databaseFile = path.join(directory, "cloud.sqlite");
  let running;
  try {
    running = await startServer(databaseFile);
    const { headers } = await register(running.baseUrl, "sparse_v46_large_33m");
    const state = createV46State("normal");
    state.padding = "large-v46-save-".repeat(2_360_000);
    const payload = createPayload(state, 201);
    const payloadBytes = Buffer.byteLength(payload);
    assert.ok(payloadBytes > 32 * 1024 * 1024, `expected >32 MiB, got ${payloadBytes}`);
    assert.ok(payloadBytes < 48 * 1024 * 1024, `expected <48 MiB, got ${payloadBytes}`);
    const checksum = createHash("sha256").update(payload).digest("hex");
    const upload = await fetch(`${running.baseUrl}/api/cloud-save`, {
      method: "PUT",
      headers: {
        ...headers,
        "content-type": "application/vnd.dspidle.save+json",
        "content-encoding": "gzip",
        "x-dsp-expected-revision": "0",
        "x-dsp-save-original-bytes": String(payloadBytes),
      },
      body: gzipSync(Buffer.from(payload)),
    });
    const uploaded = await upload.json();
    assert.equal(upload.status, 200, JSON.stringify(uploaded));
    assert.equal(uploaded.cloudSave.size, payloadBytes);
    assert.equal(uploaded.cloudSave.checksum, checksum);

    const secondPayload = createPayload({ ...state, elapsedSeconds: 660 }, 202);
    const second = await fetch(`${running.baseUrl}/api/cloud-save`, {
      method: "PUT",
      headers: {
        ...headers,
        "content-type": "application/vnd.dspidle.save+json",
        "content-encoding": "gzip",
        "x-dsp-expected-revision": "1",
        "x-dsp-save-original-bytes": String(Buffer.byteLength(secondPayload)),
      },
      body: gzipSync(Buffer.from(secondPayload)),
    });
    assert.equal(second.status, 200, await second.text());
    const restored = await request(running.baseUrl, "/api/cloud-save/restore", {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: 1, expectedRevision: 2 }),
    });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.cloudSave.revision, 3);
    const downloaded = await request(running.baseUrl, "/api/cloud-save", { headers });
    assert.equal(downloaded.body.cloudSave.payload, payload);
    assert.equal(downloaded.body.cloudSave.checksum, checksum);

    await stopServer(running.server);
    running = await startServer(databaseFile);
    const afterRestart = await request(running.baseUrl, "/api/cloud-save", { headers });
    assert.equal(afterRestart.body.cloudSave.payload, payload);
    assert.equal(afterRestart.body.cloudSave.checksum, checksum);
    assert.deepEqual((await request(running.baseUrl, "/api/cloud-save/history", { headers })).body.history.map((entry) => entry.revision), [3, 2, 1]);
  } finally {
    await stopServer(running?.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("v46 sparse defaults reject explicit invalid values while v45 dense saves remain valid", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsp-v46-sparse-invalid-"));
  let running;
  try {
    running = await startServer(path.join(directory, "cloud.sqlite"));
    const { headers } = await register(running.baseUrl, "sparse_v46_invalid");
    const invalidCases = [
      ["lanes null", (state) => { state.belts[0].lanes = null; }],
      ["lanes string", (state) => { state.belts[0].lanes = "1"; }],
      ["lanes zero", (state) => { state.belts[0].lanes = 0; }],
      ["lanes negative", (state) => { state.belts[0].lanes = -1; }],
      ["lanes overflow", (state) => { state.belts[0].lanes = 4_097; }],
      ["tier null", (state) => { state.belts[0].tier = null; }],
      ["tier string", (state) => { state.belts[0].tier = "1"; }],
      ["tier zero", (state) => { state.belts[0].tier = 0; }],
      ["tier negative", (state) => { state.belts[0].tier = -1; }],
      ["tier overflow", (state) => { state.belts[0].tier = 33; }],
      ["progress null", (state) => { state.belts[0].progress = null; }],
      ["progress string", (state) => { state.belts[0].progress = "0"; }],
      ["progress negative", (state) => { state.belts[0].progress = -1; }],
      ["progress overflow", (state) => { state.belts[0].progress = 100_000_001; }],
      ["interaction lock null", (state) => { state.entities[0].interactionLocked = null; }],
      ["interaction lock string", (state) => { state.entities[0].interactionLocked = "false"; }],
      ["station slots not array", (state) => { state.entities[1].stationSlots = {}; }],
      ["station slots too many", (state) => { state.entities[1].stationSlots = Array.from({ length: 6 }, () => ({})); }],
      ["station slot null", (state) => { state.entities[1].stationSlots[1] = null; }],
      ["station local mode null", (state) => { state.entities[1].stationSlots[1].localMode = null; }],
      ["station minimum load invalid", (state) => { state.entities[1].stationSlots[1].minimumLoad = 0.2; }],
      ["station min stock overflow", (state) => { state.entities[1].stationSlots[1].minStock = 100_000_001; }],
      ["station priority invalid", (state) => { state.entities[1].stationSlots[1].priority = 3; }],
      ["station route policy invalid", (state) => { state.entities[1].stationSlots[1].routePolicy = "auto"; }],
      ["station warper budget invalid", (state) => { state.entities[1].stationSlots[1].warperBudget = 5; }],
    ];
    for (const [name, mutate] of invalidCases) {
      const state = createV46State("normal");
      mutate(state);
      const rejected = await request(running.baseUrl, "/api/cloud-save?slot=2", {
        method: "PUT",
        headers,
        body: JSON.stringify({ payload: createPayload(state), expectedRevision: 0 }),
      });
      assert.equal(rejected.response.status, 400, `${name}: ${JSON.stringify(rejected.body)}`);
      assert.equal(rejected.body.code, "SAVE_FORMAT_INVALID", name);
    }

    const invalidJsonWithNaN = createPayload(createV46State("normal")).replace(
      '"belts":[{"id":"belt"',
      '"belts":[{"lanes":NaN,"id":"belt"',
    );
    const rejectedNaN = await request(running.baseUrl, "/api/cloud-save?slot=2", {
      method: "PUT",
      headers,
      body: JSON.stringify({ payload: invalidJsonWithNaN, expectedRevision: 0 }),
    });
    assert.equal(rejectedNaN.response.status, 400);
    assert.equal(rejectedNaN.body.code, "SAVE_FORMAT_INVALID");

    const explicitProgressZero = createV46State("normal");
    Object.assign(explicitProgressZero.belts[0], { progress: 0 });
    const acceptedProgressZero = await request(running.baseUrl, "/api/cloud-save?slot=2", {
      method: "PUT",
      headers,
      body: JSON.stringify({ payload: createPayload(explicitProgressZero), expectedRevision: 0 }),
    });
    assert.equal(acceptedProgressZero.response.status, 200, JSON.stringify(acceptedProgressZero.body));

    const acceptedDenseV45 = await request(running.baseUrl, "/api/cloud-save?slot=3", {
      method: "PUT",
      headers,
      body: JSON.stringify({ payload: createDenseV45Payload(), expectedRevision: 0 }),
    });
    assert.equal(acceptedDenseV45.response.status, 200, JSON.stringify(acceptedDenseV45.body));
  } finally {
    await stopServer(running?.server);
    await rm(directory, { recursive: true, force: true });
  }
});
