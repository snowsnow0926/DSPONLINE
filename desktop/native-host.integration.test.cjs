const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  NativeExactRealtimeLeaseRegistry,
  NativeHostClient,
  NativeSaveSessionRegistry,
} = require("./native-host.cjs");
const {
  NativeCoreExactRealtimeRustLeaseStore,
} = require("./native-core-exact-realtime-experiment.cjs");
const {
  deriveExactTickCommandId,
} = require("./native-core-exact-realtime-orchestrator.cjs");
const {
  inspectNativeExactRealtimeStartup,
} = require("./native-exact-realtime-startup-guard.cjs");
const {
  normalizeRendererNativeResult,
} = require("./native-renderer-boundary.cjs");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fnv1aUtf16(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const binaryPath = path.resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");

async function createSyntheticPureIdleFixture(cacheDir) {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: path.resolve("."),
    configFile: false,
    cacheDir,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const [engine, chunkedSaveJournal, contentPacks, nativeCoreCatalog] = await Promise.all([
      vite.ssrLoadModule("/src/game/engine.ts"),
      vite.ssrLoadModule("/src/game/chunkedSaveJournal.ts"),
      vite.ssrLoadModule("/src/game/contentPacks.ts"),
      vite.ssrLoadModule("/src/game/nativeCoreCatalog.ts"),
    ]);
    const state = engine.createInitialState(0x50a7e1d1);
    const vein = state.entities.find((entity) => entity.id === "vein_iron");
    assert.ok(vein, "the anonymous initial state must contain the iron vein");
    state.entities = [vein];
    state.belts = [];
    vein.minerCount = 4;
    vein.extractorBuildingId = "mining_machine";
    vein.outputs = { iron_ore: 0 };
    vein.progress = 0;
    vein.utilization = 0;
    vein.productionRate = 0;
    state.entities.push(
      {
        id: "pure_idle_wind",
        kind: "power",
        planetId: "home",
        powerGridId: "grid-a",
        buildingId: "wind_turbine",
        machineCount: 100_000_000_000_000,
        position: { x: 0, y: -180 },
        inputs: {},
        outputs: {},
        progress: 0,
        utilization: 0,
        productionRate: 0,
        powerInputKw: 0,
        powerOutputKw: 0,
        routingCursor: 0,
      },
      {
        id: "pure_idle_controller",
        kind: "machine",
        planetId: "home",
        powerGridId: "grid-a",
        buildingId: "time_warp_device",
        machineCount: 1,
        position: { x: 160, y: -180 },
        inputs: {},
        outputs: {},
        progress: 0,
        utilization: 0,
        productionRate: 0,
        powerFactor: 1,
        powerInputKw: 0,
        routingCursor: 0,
      },
    );
    state.settings.resourceMode = "infinite";
    state.settings.simulationSpeed = 1;
    state.handcraftQueue = [];
    state.constructionQueue = [];
    state.constructionAutomation.enabled = false;
    state.constructionAutomation.jobs = {};
    state.constructionAutomation.targetStock = {};
    state.exploration.missions = [];
    state.systemSpaceStations = {};
    state.quantumLogisticsNetwork.enabled = false;
    state.quantumLogisticsNetwork.inventory = {};
    state.endgame.activeInfiniteResearchId = null;
    state.endgame.constructionActivity.activityId = null;
    for (const project of Object.values(state.endgame.exportProjects)) project.enabled = false;
    state.timeWarp = {
      ...state.timeWarp,
      controllerEntityId: "pure_idle_controller",
      enabled: true,
      requestedMultiplier: 15,
      effectiveMultiplier: 15,
      pendingSimulationSeconds: 0,
      pendingWallSeconds: 0,
      requiredPowerKw: 10 ** 16,
      allocatedPowerKw: 10 ** 16,
    };

    const runtime = contentPacks.createContentPackRuntimeSnapshot(
      contentPacks.createContentPackRegistry(),
    );
    const journal = chunkedSaveJournal.buildChunkedSaveJournal(state, {
      mode: "normal",
      basePrimaryChecksum: "01234567",
      savedAt: 1,
      retainAllChunks: true,
    });
    const prefix = "dsp-idle-network.internal.v1.chunked.v1.normal.";
    return {
      state: JSON.parse(JSON.stringify(state)),
      registryFingerprint: runtime.fingerprint,
      catalog: nativeCoreCatalog.createNativeCoreCatalog(runtime),
      records: [
        ...[...journal.chunks.entries()].map(([id, value]) => ({
          key: `${prefix}chunk.${encodeURIComponent(id)}`,
          value,
        })),
        { key: `${prefix}manifest`, value: JSON.stringify(journal.manifest) },
      ],
    };
  } finally {
    await vite.close();
  }
}

async function seedSyntheticCheckpoint(sessions, fixture) {
  const transaction = await sessions.begin(1, {
    slot: "normal-main",
    mode: "normal",
    stateVersion: 47,
    baseChecksum: "01234567",
    registryFingerprint: fixture.registryFingerprint,
    revision: 1,
    savedAtMs: 1,
  });
  for (let index = 0; index < fixture.records.length; index += 8) {
    await sessions.write(1, transaction.transactionId, fixture.records.slice(index, index + 8));
  }
  return sessions.commit(1, transaction.transactionId);
}

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
  assert.doesNotThrow(() => normalizeRendererNativeResult("hostHello", hello));
  assert.equal(hello.nativeFormatVersion, 1);
  assert.ok(hello.capabilities.includes("native-save-v1"));
  assert.ok(hello.capabilities.includes("native-save-put-batch-v1"));
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
  const rejected = await sessions.begin(1, { ...request, revision: 0, savedAtMs: 0 });
  await assert.rejects(
    () => client.request({
      operation: "savePutBatch",
      transactionId: rejected.transactionId,
      records: Array.from({ length: 9 }, (_, index) => ({ key: `record-${index}`, value: "{}" })),
    }),
    /batch size/,
  );
  await sessions.abort(1, rejected.transactionId);
  const first = await sessions.begin(1, request);
  assert.doesNotThrow(() => normalizeRendererNativeResult("saveBegin", first));
  await sessions.write(1, first.transactionId, [
    { key: "base", value: "{\"version\":47}" },
    { key: "entities:00000000", value: "[]" },
  ]);
  const firstCommit = await sessions.commit(1, first.transactionId);
  assert.doesNotThrow(() => normalizeRendererNativeResult("saveCommit", firstCommit));
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
    baseRevision: 2,
    revision: 3,
    commandId: "command-3",
    payload: { simulationSeconds: 1 },
  });
  assert.doesNotThrow(() => normalizeRendererNativeResult("walAppend", wal));
  assert.equal(wal.revision, 3);
  const recovery = await client.request({ operation: "saveRecover", slot: "normal-main" });
  assert.doesNotThrow(() => normalizeRendererNativeResult("saveRecovery", recovery));
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
  assert.doesNotThrow(() => normalizeRendererNativeResult("saveRead", readback));
  assert.equal(readback.value, "{\"version\":47}");
});

test("real Rust lease fences normal-main saves, WAL, and compaction across a flag-off restart", {
  skip: !fs.existsSync(binaryPath) ? "release native host has not been built" : false,
  timeout: 30_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-e1-fence-integration-"));
  let client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 10_000 });
  t.after(async () => {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const hello = await client.start("exact-realtime-fence-integration");
  assert.ok(hello.capabilities.includes("native-core-exact-realtime-lease-v2"));
  let sessions = new NativeSaveSessionRegistry(client);
  const normalRequest = {
    slot: "normal-main",
    mode: "normal",
    stateVersion: 47,
    baseChecksum: "01234567",
    registryFingerprint: "builtin:e1-integration",
    revision: 1,
    savedAtMs: 1,
  };
  const first = await sessions.begin(1, normalRequest);
  await sessions.write(1, first.transactionId, [{ key: "base", value: "{}" }]);
  const checkpoint = await sessions.commit(1, first.transactionId);
  const old = await sessions.begin(1, { ...normalRequest, revision: 2, savedAtMs: 2 });
  await sessions.write(1, old.transactionId, [{ key: "base", value: "{\"pending\":true}" }]);

  let leaseStore = new NativeCoreExactRealtimeRustLeaseStore({
    leaseRegistry: new NativeExactRealtimeLeaseRegistry(client),
  });
  assert.equal((await inspectNativeExactRealtimeStartup({ leaseStore, environment: {} })).normalWindowAllowed, true);
  const lease = await leaseStore.prepare({
    runId: "integration-e1-run",
    registryFingerprint: normalRequest.registryFingerprint,
    checkpoint: {
      generation: checkpoint.generation,
      rootHash: checkpoint.rootHash,
      revision: checkpoint.revision,
    },
    proof: {
      revision: checkpoint.revision,
      canonicalSha256: sha256("integration-entry-canonical"),
      domainSha256: sha256("integration-entry-domain"),
    },
    settledDeadlineMs: 1_000,
  });
  assert.equal(lease.phase, "prepared");

  await assert.rejects(
    sessions.begin(1, { ...normalRequest, revision: 2, savedAtMs: 3 }),
    /exact realtime lease/i,
  );
  await assert.rejects(sessions.commit(1, old.transactionId), /exact realtime lease/i);
  await assert.rejects(client.request({
    operation: "walAppend",
    slot: "normal-main",
    baseRevision: 1,
    revision: 2,
    commandId: "raw-normal-main-wal",
    payload: { simulationSeconds: 1 },
  }), /exact realtime lease/i);
  await assert.rejects(
    client.request({ operation: "compact", slot: "normal-main", retainGenerations: 2 }),
    /exact realtime lease/i,
  );

  const speedrun = await sessions.begin(1, {
    ...normalRequest,
    slot: "speedrun-main",
    mode: "speedrun",
    registryFingerprint: "builtin:speedrun-integration",
  });
  await sessions.write(1, speedrun.transactionId, [{ key: "base", value: "{}" }]);
  const speedrunCheckpoint = await sessions.commit(1, speedrun.transactionId);
  const speedrunWal = await client.request({
    operation: "walAppend",
    slot: "speedrun-main",
    baseRevision: speedrunCheckpoint.revision,
    revision: speedrunCheckpoint.revision + 1,
    commandId: "speedrun-wal-after-normal-lease",
    payload: { simulationSeconds: 1 },
  });
  assert.equal(speedrunWal.revision, speedrunCheckpoint.revision + 1);
  assert.equal(
    (await client.request({ operation: "compact", slot: "speedrun-main", retainGenerations: 2 })).removedGenerations,
    0,
  );

  await client.stop();
  client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 10_000 });
  await client.start("exact-realtime-fence-restart");
  sessions = new NativeSaveSessionRegistry(client);
  leaseStore = new NativeCoreExactRealtimeRustLeaseStore({
    leaseRegistry: new NativeExactRealtimeLeaseRegistry(client),
  });
  const restartedGuard = await inspectNativeExactRealtimeStartup({ leaseStore, environment: {} });
  assert.equal(restartedGuard.labRequested, false);
  assert.equal(restartedGuard.leaseState, "valid");
  assert.equal(restartedGuard.normalWindowAllowed, false);
  await assert.rejects(
    sessions.begin(1, { ...normalRequest, revision: 2, savedAtMs: 4 }),
    /exact realtime lease/i,
  );
});

test("Rust host opens a verified v47 checkpoint as an owner-bound native shadow", {
  skip: !fs.existsSync(binaryPath) ? "release native host has not been built" : false,
  timeout: 30_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-core-integration-"));
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 10_000 });
  t.after(async () => {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const hello = await client.start("integration-test");
  assert.doesNotThrow(() => normalizeRendererNativeResult("hostHello", hello));
  assert.ok(hello.capabilities.includes("native-core-shadow-v1"));
  assert.ok(hello.capabilities.includes("native-core-projection-v1"));
  assert.ok(hello.capabilities.includes("native-core-viewport-projection-v1"));
  assert.ok(hello.capabilities.includes("native-core-statistics-projection-v1"));
  assert.ok(hello.capabilities.includes("native-core-v47-stream-export-v1"));
  const base = JSON.stringify({
    version: 47, mode: "normal", activePlanetId: "home", elapsedSeconds: 2, paused: false,
    productionHistory: [
      { elapsedSeconds: 1, sampleDurationSeconds: 1, productionPerMinute: { iron_ore: 60 }, consumptionPerMinute: {}, inventory: { iron_ore: 3 }, planetProductionPerMinute: { home: { iron_ore: 60 } }, planetConsumptionPerMinute: { home: {} }, generationKw: 0, demandKw: 0 },
      { elapsedSeconds: 2, sampleDurationSeconds: 1, productionPerMinute: { iron_ore: 120 }, consumptionPerMinute: {}, inventory: { iron_ore: 5 }, planetProductionPerMinute: { home: { iron_ore: 120 } }, planetConsumptionPerMinute: { home: {} }, generationKw: 0, demandKw: 0 },
    ],
  });
  const entities = JSON.stringify([{ id: "vein", kind: "vein", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false, resourceId: "iron_ore", machineCount: 0, minerCount: 2, inputs: {}, outputs: { iron_ore: 3 }, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0 }]);
  const belts = JSON.stringify([{ id: "belt", planetId: "home", source: "vein", target: "sink", itemId: "iron_ore", lanes: 1, tier: 1, priority: 1, progress: 0, lastFlow: 0 }]);
  const chunks = [
    { id: "base", kind: "base", offset: 0, count: 1, checksum: fnv1a(base), bytes: Buffer.byteLength(base) },
    { id: "entities:00000000", kind: "entities", offset: 0, count: 1, checksum: fnv1a(entities), bytes: Buffer.byteLength(entities) },
    { id: "belts:00000000", kind: "belts", offset: 0, count: 1, checksum: fnv1a(belts), bytes: Buffer.byteLength(belts) },
  ];
  const manifest = JSON.stringify({
    formatVersion: 1, envelopeFormatVersion: 2, mode: "normal", slot: "main", stateVersion: 47, savedAt: 1,
    basePrimaryChecksum: "01234567", chunkRootChecksum: "01234567", totalBytes: Buffer.byteLength(base) + Buffer.byteLength(entities) + Buffer.byteLength(belts),
    entityCount: 1, beltCount: 1, chunks,
  });
  const prefix = "dsp-idle-network.internal.v1.chunked.v1.normal.";
  const sessions = new NativeSaveSessionRegistry(client);
  const started = await sessions.begin(1, {
    slot: "normal-main", mode: "normal", stateVersion: 47, baseChecksum: "01234567", registryFingerprint: "builtin:test", revision: 1, savedAtMs: 1,
  });
  await sessions.write(1, started.transactionId, [
    { key: `${prefix}manifest`, value: manifest },
    { key: `${prefix}chunk.base`, value: base },
    { key: `${prefix}chunk.entities%3A00000000`, value: entities },
    { key: `${prefix}chunk.belts%3A00000000`, value: belts },
  ]);
  const commit = await sessions.commit(1, started.transactionId);
  const pauseCommand = {
    protocolVersion: 1,
    baseRevision: 1,
    topLevelChanges: [{ path: ["paused"], operation: "set", value: true }],
    changedEntities: [], addedEntities: [], removedEntityIds: [], changedBelts: [], addedBelts: [], removedBeltIds: [],
  };
  await client.request({
    operation: "walAppend",
    slot: "normal-main",
    baseRevision: 1,
    revision: 2,
    commandId: "pause-and-advance-2",
    payload: {
      kind: "stable-operation-v1",
      baseStateRevision: 1,
      resultStateRevision: 2,
      command: pauseCommand,
      simulationSeconds: 1,
      wallSeconds: 1,
      approximate: false,
      registry: { fingerprint: "builtin:test" },
    },
  });
  const coreOpenRequest = {
    operation: "coreOpen",
    slot: "normal-main",
    generation: commit.generation,
    rootHash: commit.rootHash,
    revision: commit.revision,
    registryFingerprint: "builtin:test",
    catalog: {
      protocolVersion: 1,
      registryFingerprint: "builtin:test",
      planets: [{
        id: "home",
        systemId: "helios",
        kind: "terrestrial",
        orbitIndex: 1,
        simulationOrder: 0,
        orbitalYields: {},
      }],
      items: [{ id: "iron_ore", kind: "solid" }],
      buildings: [{ id: "mining_machine", kind: "miner", speed: 1, inputCapacity: 0, outputCapacity: 50, powerDemandKw: 1, powerGenerationKw: 0 }],
      recipes: [],
      belts: [{ tier: 1, speed: 6 }],
    },
  };
  let opened = await client.request(coreOpenRequest);
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreOpen", opened));
  assert.equal(opened.authority, "shadow");
  assert.equal(opened.checkpointRevision, 1);
  assert.equal(opened.replayedWalEntries, 1);
  assert.equal(opened.replayedRevision, 2);
  assert.equal(opened.summary.revision, 2);
  assert.equal(opened.summary.entityCount, 1);
  assert.equal(opened.summary.beltCount, 1);
  assert.equal(opened.summary.paused, true);
  assert.equal(opened.summary.coverage.authorityEligible, false);
  const projection = await client.request({
    operation: "coreProjection",
    sessionId: opened.sessionId,
    baseFields: ["paused", "elapsedSeconds"],
    entityIds: ["vein"],
    beltIds: ["belt"],
  });
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreProjection", projection, {
    baseFields: ["paused", "elapsedSeconds"], entityIds: ["vein"], beltIds: ["belt"],
  }));
  assert.deepEqual(projection.base, { paused: true, elapsedSeconds: 2 });
  assert.deepEqual(projection.entities, [JSON.parse(entities)[0]]);
  assert.deepEqual(projection.belts, [JSON.parse(belts)[0]]);
  const viewportProjection = await client.request({
    operation: "coreViewportProjection",
    sessionId: opened.sessionId,
    baseFields: ["paused"],
    planetId: "home",
    minX: -10,
    minY: -10,
    maxX: 10,
    maxY: 10,
    entityCursor: 0,
    entityLimit: 16,
    beltLimit: 32,
  });
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreViewportProjection", viewportProjection, {
    baseFields: ["paused"],
    planetId: "home",
    bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
    entityCursor: 0,
    entityLimit: 16,
    beltLimit: 32,
  }));
  assert.equal(viewportProjection.projectionType, "viewport-v1");
  assert.equal(viewportProjection.revision, 2);
  assert.deepEqual(viewportProjection.entities.map((entity) => entity.id), ["vein"]);
  assert.deepEqual(viewportProjection.belts.map((belt) => belt.id), ["belt"]);
  assert.equal(viewportProjection.nextEntityCursor, null);
  const statisticsProjection = await client.request({
    operation: "coreStatisticsProjection",
    sessionId: opened.sessionId,
    minElapsedSeconds: 0,
    maxElapsedSeconds: 2,
    cursor: 0,
    limit: 1,
    planetId: "home",
    itemId: "iron_ore",
  });
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreStatisticsProjection", statisticsProjection, {
    minElapsedSeconds: 0,
    maxElapsedSeconds: 2,
    cursor: 0,
    limit: 1,
    planetId: "home",
    itemId: "iron_ore",
  }));
  assert.equal(statisticsProjection.projectionType, "statistics-v1");
  assert.equal(statisticsProjection.revision, 2);
  assert.equal(statisticsProjection.samples.length, 1);
  assert.equal(statisticsProjection.samples[0].productionPerMinute.iron_ore, 60);
  assert.equal(statisticsProjection.nextCursor, 1);
  await assert.rejects(
    client.request({
      operation: "coreProjection",
      sessionId: opened.sessionId,
      baseFields: ["entities"],
      entityIds: [],
      beltIds: [],
    }),
    /unbounded collection/,
  );
  const authorityRequest = {
    operation: "coreCommitOperation",
    sessionId: opened.sessionId,
    request: {
      commandId: "authority-unpause-3",
      baseRevision: 2,
      command: {
        protocolVersion: 1,
        baseRevision: 2,
        topLevelChanges: [{ path: ["paused"], operation: "set", value: false }],
        changedEntities: [], addedEntities: [], removedEntityIds: [], changedBelts: [], addedBelts: [], removedBeltIds: [],
      },
      simulationSeconds: 0,
      wallSeconds: 0,
      includeDiagnostics: false,
    },
  };
  const applied = await client.request(authorityRequest);
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreCommit", applied));
  assert.deepEqual(
    { revision: applied.revision, currentRevision: applied.currentRevision, duplicate: applied.duplicate },
    { revision: 3, currentRevision: 3, duplicate: false },
  );
  const duplicate = await client.request(authorityRequest);
  assert.deepEqual(
    { revision: duplicate.revision, currentRevision: duplicate.currentRevision, duplicate: duplicate.duplicate },
    { revision: 3, currentRevision: 3, duplicate: true },
  );
  await assert.rejects(
    client.request({
      ...authorityRequest,
      request: { ...authorityRequest.request, simulationSeconds: 1 },
    }),
    /idempotency key conflicts/,
  );
  const status = await client.request({ operation: "coreStatus", sessionId: opened.sessionId });
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreSummary", status));
  assert.equal(status.paused, false);
  const firstClose = await client.request({ operation: "coreClose", sessionId: opened.sessionId });
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreClose", firstClose));
  assert.equal(firstClose.closed, true);

  // Reopening from the old generation replays both durable operations and
  // lands on the exact accepted revision instead of an older checkpoint.
  opened = await client.request(coreOpenRequest);
  assert.equal(opened.replayedWalEntries, 2);
  assert.equal(opened.replayedRevision, 3);
  assert.equal(opened.summary.paused, false);
  const nativeCheckpoint = await client.request({
    operation: "coreCheckpoint",
    sessionId: opened.sessionId,
    savedAtMs: 2,
  });
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreCheckpoint", nativeCheckpoint));
  assert.equal(nativeCheckpoint.checkpoint.generation, 2);
  assert.equal(nativeCheckpoint.checkpoint.revision, 3);
  // The first checkpoint after opening the legacy v1 fixture performs the
  // private manifest-v2 upgrade: five bounded base domains, entity/belt pages,
  // and the manifest are written with SHA-256 metadata; the legacy monolithic
  // base record is removed. Legacy v1 pages cannot be reused because they had
  // no per-page SHA proof.
  assert.equal(nativeCheckpoint.checkpoint.recordCount, 8);
  assert.equal(nativeCheckpoint.checkpoint.changedRecords, 7);
  assert.equal(nativeCheckpoint.encodedRecords, 8);
  assert.equal(nativeCheckpoint.reusedRecords, 0);
  assert.equal(nativeCheckpoint.summary.revision, 3);
  const metadataOnlyCheckpoint = await client.request({
    operation: "coreCheckpoint",
    sessionId: opened.sessionId,
    savedAtMs: 3,
  });
  assert.equal(metadataOnlyCheckpoint.checkpoint.generation, 3);
  assert.equal(metadataOnlyCheckpoint.checkpoint.revision, 3);
  assert.equal(metadataOnlyCheckpoint.checkpoint.recordCount, 8);
  assert.equal(metadataOnlyCheckpoint.checkpoint.changedRecords, 1);
  assert.equal(metadataOnlyCheckpoint.encodedRecords, 1);
  assert.equal(metadataOnlyCheckpoint.reusedRecords, 7);
  const exported = await client.request({
    operation: "coreExportV47",
    sessionId: opened.sessionId,
    exportId: "integration-v47",
    savedAtMs: 4,
  });
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreExport", exported));
  const exportPath = path.join(root, "exports", "integration-v47.json");
  const exportRaw = fs.readFileSync(exportPath, "utf8");
  const exportEnvelope = JSON.parse(exportRaw);
  assert.equal(exported.result.revision, 3);
  assert.equal(exported.result.byteLength, Buffer.byteLength(exportRaw));
  assert.equal(exportEnvelope.state.version, 47);
  assert.equal(exportEnvelope.state.paused, false);
  assert.equal(exportEnvelope.checksum, fnv1aUtf16(JSON.stringify({ formatVersion: 2, state: exportEnvelope.state })));
  assert.equal((await client.request({ operation: "coreClose", sessionId: opened.sessionId })).closed, true);
  opened = await client.request({
    ...coreOpenRequest,
    generation: metadataOnlyCheckpoint.checkpoint.generation,
    rootHash: metadataOnlyCheckpoint.checkpoint.rootHash,
    revision: metadataOnlyCheckpoint.checkpoint.revision,
  });
  assert.equal(opened.replayedWalEntries, 0);
  assert.equal(opened.replayedRevision, 3);
  assert.equal(opened.summary.paused, false);
  const unsupportedAdvance = await client.request({
    operation: "coreAdvance",
    sessionId: opened.sessionId,
    request: { baseRevision: 3, simulationSeconds: 1, wallSeconds: 1 },
  });
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreAdvance", unsupportedAdvance));
  assert.equal(unsupportedAdvance.supported, false);
  assert.equal(unsupportedAdvance.revision, 3);
  const repaused = await client.request({
    operation: "coreApplyCommand",
    sessionId: opened.sessionId,
    command: { ...pauseCommand, baseRevision: 3 },
  });
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreCommand", repaused));
  assert.equal(repaused.revision, 4);
  const pausedAdvance = await client.request({
    operation: "coreAdvance",
    sessionId: opened.sessionId,
    request: { baseRevision: 4, simulationSeconds: 1, wallSeconds: 1 },
  });
  assert.equal(pausedAdvance.supported, true);
  assert.equal(pausedAdvance.changed, false);
  assert.equal(pausedAdvance.revision, 4);
  assert.equal((await client.request({ operation: "coreClose", sessionId: opened.sessionId })).closed, true);
});

test("real Rust host permits only the lease-owned pending core commit and exact checkpoint ACK", {
  skip: !fs.existsSync(binaryPath) ? "release native host has not been built" : false,
  timeout: 60_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-e1-core-fence-"));
  const fixture = await createSyntheticPureIdleFixture(path.join(root, "vite-cache"));
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 30_000 });
  t.after(async () => {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const hello = await client.start("exact-realtime-core-fence");
  assert.ok(hello.capabilities.includes("native-core-exact-realtime-lease-v2"));
  assert.ok(hello.capabilities.includes("native-core-exact-realtime-writer-fence-v1"));
  const checkpoint = await seedSyntheticCheckpoint(new NativeSaveSessionRegistry(client), fixture);
  const opened = await client.request({
    operation: "coreOpen",
    slot: "normal-main",
    generation: checkpoint.generation,
    rootHash: checkpoint.rootHash,
    revision: checkpoint.revision,
    registryFingerprint: fixture.registryFingerprint,
    catalog: fixture.catalog,
  });
  assert.equal(opened.authority, "shadow");
  assert.equal(opened.summary.coverage.authorityEligible, false);
  const runId = "integration-e1-core-run";
  const leaseStore = new NativeCoreExactRealtimeRustLeaseStore({
    leaseRegistry: new NativeExactRealtimeLeaseRegistry(client),
  });
  const prepared = await leaseStore.prepare({
    runId,
    registryFingerprint: fixture.registryFingerprint,
    checkpoint: {
      generation: checkpoint.generation,
      rootHash: checkpoint.rootHash,
      revision: checkpoint.revision,
    },
    proof: {
      revision: opened.summary.revision,
      canonicalSha256: opened.summary.canonicalSha256,
      domainSha256: opened.summary.domainSha256,
    },
    settledDeadlineMs: 1_000,
  });
  await leaseStore.activate({ runId, registryFingerprint: fixture.registryFingerprint });

  const genericCommit = {
    operation: "coreCommitOperation",
    sessionId: opened.sessionId,
    request: {
      commandId: "generic-commit-during-e1",
      baseRevision: opened.summary.revision,
      command: null,
      simulationSeconds: 1,
      wallSeconds: 1,
      advanceMode: "exact",
      includeDiagnostics: true,
    },
  };
  await assert.rejects(client.request(genericCommit), /exact realtime lease/i);
  await assert.rejects(client.request({
    operation: "coreCheckpoint",
    sessionId: opened.sessionId,
    savedAtMs: 2,
  }), /exact realtime lease/i);

  const sequence = 1;
  const commandId = deriveExactTickCommandId(runId, sequence);
  const settledDeadlineMs = 2_000;
  await leaseStore.stageExactTick({
    runId,
    registryFingerprint: fixture.registryFingerprint,
    sequence,
    commandId,
    baseRevision: prepared.acknowledged.revision,
    expectedRevision: prepared.acknowledged.revision + 1,
    simulationSeconds: 1,
    wallSeconds: 1,
    settledDeadlineMs,
  });
  await assert.rejects(client.request({
    ...genericCommit,
    request: {
      ...genericCommit.request,
      commandId,
      baseRevision: prepared.acknowledged.revision,
    },
  }), /exact realtime lease/i);
  const exactCommit = await client.request({
    operation: "coreCommitOperationExactRealtime",
    sessionId: opened.sessionId,
    request: {
      runId,
      registryFingerprint: fixture.registryFingerprint,
    },
  });
  assert.equal(exactCommit.duplicate, false);
  assert.equal(exactCommit.revision, prepared.acknowledged.revision + 1);
  const acknowledged = await client.request({
    operation: "coreCheckpointAcknowledgeExactRealtime",
    sessionId: opened.sessionId,
    request: {
      runId,
      registryFingerprint: fixture.registryFingerprint,
      sequence,
      commandId,
      settledDeadlineMs,
    },
  });
  assert.equal(acknowledged.summary.revision, exactCommit.revision);
  assert.equal(acknowledged.lease.pendingTick, null);
  assert.equal(acknowledged.lease.acknowledged.revision, exactCommit.revision);
  await assert.rejects(client.request({
    operation: "coreCheckpoint",
    sessionId: opened.sessionId,
    savedAtMs: 3,
  }), /exact realtime lease/i);
  assert.equal((await client.request({ operation: "coreStatus", sessionId: opened.sessionId })).revision, exactCommit.revision);
  assert.equal((await client.request({ operation: "coreClose", sessionId: opened.sessionId })).closed, true);
});

test("pure-idle conservative host operations preserve credit, WAL atomicity and v47 export", {
  skip: !fs.existsSync(binaryPath) ? "release native host has not been built" : false,
  timeout: 60_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-native-pure-idle-host-"));
  const fixture = await createSyntheticPureIdleFixture(path.join(root, "vite-cache"));
  const client = new NativeHostClient({ binaryPath, rootPath: root, requestTimeoutMs: 30_000 });
  t.after(async () => {
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const hello = await client.start("pure-idle-host-contract");
  assert.ok(hello.capabilities.includes("native-core-shadow-v1"));
  const sessions = new NativeSaveSessionRegistry(client);
  const seeded = await seedSyntheticCheckpoint(sessions, fixture);
  const openCheckpoint = (checkpoint) => client.request({
    operation: "coreOpen",
    slot: "normal-main",
    generation: checkpoint.generation,
    rootHash: checkpoint.rootHash,
    revision: checkpoint.revision,
    registryFingerprint: fixture.registryFingerprint,
    catalog: fixture.catalog,
  });
  const project = (sessionId) => client.request({
    operation: "coreProjection",
    sessionId,
    baseFields: ["elapsedSeconds", "totalProduced", "timeWarp"],
    entityIds: ["vein_iron"],
    beltIds: [],
  });

  let opened = await openCheckpoint(seeded);
  const beforePrefix = await project(opened.sessionId);
  assert.equal(beforePrefix.entities[0].outputs.iron_ore, 0);
  const beforeExactBudgetFailures = await client.request({
    operation: "coreStatus",
    sessionId: opened.sessionId,
  });
  const recoveryBeforeExactBudgetFailures = await client.request({
    operation: "saveRecover",
    slot: "normal-main",
  });
  for (const [simulationSeconds, wallSeconds, reason] of [
    [15, 0, "pure-idle-wall-budget-empty"],
    [12, 1, "pure-idle-power-multiplier-changed"],
  ]) {
    const rejected = await client.request({
      operation: "coreAdvance",
      sessionId: opened.sessionId,
      request: {
        baseRevision: 1,
        simulationSeconds,
        wallSeconds,
        advanceMode: "pure-idle-conservative-v2",
        includeDiagnostics: true,
      },
    });
    assert.equal(rejected.supported, false);
    assert.equal(rejected.reason, reason);
    assert.equal(rejected.revision, 1);
  }
  const afterExactBudgetFailures = await client.request({
    operation: "coreStatus",
    sessionId: opened.sessionId,
  });
  const recoveryAfterExactBudgetFailures = await client.request({
    operation: "saveRecover",
    slot: "normal-main",
  });
  assert.equal(afterExactBudgetFailures.revision, beforeExactBudgetFailures.revision);
  assert.equal(
    afterExactBudgetFailures.canonicalSha256,
    beforeExactBudgetFailures.canonicalSha256,
  );
  assert.equal(
    recoveryAfterExactBudgetFailures.walEntryCount,
    recoveryBeforeExactBudgetFailures.walEntryCount,
  );
  assert.equal(
    recoveryAfterExactBudgetFailures.walLastRevision,
    recoveryBeforeExactBudgetFailures.walLastRevision,
  );
  const prefix = await client.request({
    operation: "coreAdvance",
    sessionId: opened.sessionId,
    request: {
      baseRevision: 1,
      simulationSeconds: 15,
      wallSeconds: 1,
      advanceMode: "pure-idle-conservative-v2",
      includeDiagnostics: true,
    },
  });
  assert.equal(prefix.supported, true);
  assert.equal(prefix.exactScope, "pure-idle-bounded-exact");
  assert.equal(prefix.exactCalibrationSeconds, 15);
  assert.equal(prefix.approximatedSeconds, 0);
  assert.match(prefix.algorithmVersion, /^native-pure-idle-conservative-v4-/);
  assert.equal(prefix.revision, 2);
  const afterPrefix = await project(opened.sessionId);
  assert.ok(afterPrefix.entities[0].outputs.iron_ore > 0);
  assert.ok(afterPrefix.base.totalProduced.iron_ore > 0);
  assert.equal(afterPrefix.base.timeWarp.effectiveMultiplier, 15);

  const beforeInvalid = await client.request({ operation: "coreStatus", sessionId: opened.sessionId });
  await assert.rejects(
    client.request({
      operation: "coreAdvance",
      sessionId: opened.sessionId,
      request: {
        baseRevision: 2,
        simulationSeconds: 30 * 24 * 60 * 60 + 1,
        wallSeconds: 1,
        advanceMode: "pure-idle-conservative-v2",
        includeDiagnostics: true,
      },
    }),
    /pure-idle advance budget is invalid/,
  );
  const afterInvalid = await client.request({ operation: "coreStatus", sessionId: opened.sessionId });
  assert.equal(afterInvalid.revision, beforeInvalid.revision);
  assert.equal(afterInvalid.canonicalSha256, beforeInvalid.canonicalSha256);

  const prefixCheckpoint = await client.request({
    operation: "coreCheckpoint",
    sessionId: opened.sessionId,
    savedAtMs: 2,
  });
  assert.equal(prefixCheckpoint.checkpoint.revision, 2);
  assert.equal((await client.request({ operation: "coreClose", sessionId: opened.sessionId })).closed, true);
  opened = await openCheckpoint(prefixCheckpoint.checkpoint);
  assert.equal(opened.replayedWalEntries, 0);
  assert.equal(opened.summary.revision, 2);
  assert.equal(opened.summary.canonicalSha256, beforeInvalid.canonicalSha256);
  const afterPrefixReopen = await project(opened.sessionId);
  assert.deepEqual(afterPrefixReopen, afterPrefix);

  const recoveryBeforeFailure = await client.request({ operation: "saveRecover", slot: "normal-main" });
  const statusBeforeFailure = await client.request({ operation: "coreStatus", sessionId: opened.sessionId });
  await assert.rejects(
    client.request({
      operation: "coreCommitOperation",
      sessionId: opened.sessionId,
      request: {
        commandId: "pure-idle-invalid-multiplier",
        baseRevision: 2,
        command: null,
        simulationSeconds: 60,
        wallSeconds: 3,
        advanceMode: "pure-idle-conservative-v2",
        includeDiagnostics: true,
      },
    }),
    /unsupported domain: pure-idle-power-multiplier-changed/,
  );
  const recoveryAfterFailure = await client.request({ operation: "saveRecover", slot: "normal-main" });
  assert.equal(recoveryAfterFailure.walEntryCount, recoveryBeforeFailure.walEntryCount);
  assert.equal(recoveryAfterFailure.walLastRevision, recoveryBeforeFailure.walLastRevision);
  const statusAfterFailure = await client.request({ operation: "coreStatus", sessionId: opened.sessionId });
  assert.equal(statusAfterFailure.revision, statusBeforeFailure.revision);
  assert.equal(statusAfterFailure.canonicalSha256, statusBeforeFailure.canonicalSha256);

  const beforeDurableOutput = afterPrefixReopen.entities[0].outputs.iron_ore;
  const durable = await client.request({
    operation: "coreCommitOperation",
    sessionId: opened.sessionId,
    request: {
      commandId: "pure-idle-final-prefix",
      baseRevision: 2,
      command: null,
      simulationSeconds: 15,
      wallSeconds: 1,
      advanceMode: "pure-idle-conservative-v2",
      includeDiagnostics: true,
    },
  });
  assert.equal(durable.duplicate, false);
  assert.equal(durable.revision, 3);
  const afterDurable = await project(opened.sessionId);
  assert.ok(
    afterDurable.entities[0].outputs.iron_ore > beforeDurableOutput,
    "the failed durable candidate must not consume the remaining exact-prefix credit",
  );
  const recoveryAfterDurable = await client.request({ operation: "saveRecover", slot: "normal-main" });
  assert.equal(recoveryAfterDurable.walEntryCount, 1);
  assert.equal(recoveryAfterDurable.walLastRevision, 3);

  const durableCheckpoint = await client.request({
    operation: "coreCheckpoint",
    sessionId: opened.sessionId,
    savedAtMs: 3,
  });
  assert.equal(durableCheckpoint.checkpoint.revision, 3);
  const durableHash = durable.summary.canonicalSha256;
  assert.equal((await client.request({ operation: "coreClose", sessionId: opened.sessionId })).closed, true);
  opened = await openCheckpoint(durableCheckpoint.checkpoint);
  assert.equal(opened.replayedWalEntries, 0);
  assert.equal(opened.summary.revision, 3);
  assert.equal(opened.summary.canonicalSha256, durableHash);
  const afterDurableReopen = await project(opened.sessionId);
  assert.deepEqual(afterDurableReopen, afterDurable);

  const exported = await client.request({
    operation: "coreExportV47",
    sessionId: opened.sessionId,
    exportId: "pure-idle-v47",
    savedAtMs: 4,
  });
  const exportPath = path.join(root, "exports", "pure-idle-v47.json");
  const exportRaw = fs.readFileSync(exportPath, "utf8");
  const envelope = JSON.parse(exportRaw);
  const exportedVein = envelope.state.entities.find((entity) => entity.id === "vein_iron");
  assert.equal(exported.result.revision, 3);
  assert.equal(exported.result.byteLength, Buffer.byteLength(exportRaw));
  assert.equal(envelope.state.version, 47);
  assert.equal(envelope.state.elapsedSeconds, afterDurableReopen.base.elapsedSeconds);
  assert.equal(exportedVein.outputs.iron_ore, afterDurableReopen.entities[0].outputs.iron_ore);
  assert.equal(Object.hasOwn(envelope.state, "pureIdleSession"), false);
  const stateStart = exportRaw.indexOf("\"state\":") + "\"state\":".length;
  const stateEnd = exportRaw.lastIndexOf(",\"checksum\":");
  const checksumInput = `{\"formatVersion\":2,\"state\":${exportRaw.slice(stateStart, stateEnd)}}`;
  assert.equal(envelope.checksum, fnv1aUtf16(checksumInput));

  const exhausted = await client.request({
    operation: "coreAdvance",
    sessionId: opened.sessionId,
    request: {
      baseRevision: 3,
      simulationSeconds: 15,
      wallSeconds: 1,
      advanceMode: "pure-idle-conservative-v2",
      includeDiagnostics: true,
    },
  });
  assert.equal(exhausted.supported, true);
  assert.equal(exhausted.exactCalibrationSeconds, 0);
  assert.equal(exhausted.approximatedSeconds, 15);
  assert.equal((await project(opened.sessionId)).entities[0].outputs.iron_ore, exportedVein.outputs.iron_ore);
  assert.equal((await client.request({ operation: "coreClose", sessionId: opened.sessionId })).closed, true);
});
