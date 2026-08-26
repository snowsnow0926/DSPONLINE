const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { NativeHostClient, NativeSaveSessionRegistry } = require("./native-host.cjs");

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const binaryPath = path.resolve("native", "target", "release", process.platform === "win32" ? "dsp-native-host.exe" : "dsp-native-host");

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
  assert.equal(hello.nativeFormatVersion, 1);
  assert.ok(hello.capabilities.includes("native-save-v1"));
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
  const first = await sessions.begin(1, request);
  await sessions.write(1, first.transactionId, [
    { key: "base", value: "{\"version\":47}" },
    { key: "entities:00000000", value: "[]" },
  ]);
  const firstCommit = await sessions.commit(1, first.transactionId);
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
  assert.equal(wal.revision, 3);
  const recovery = await client.request({ operation: "saveRecover", slot: "normal-main" });
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
  assert.equal(readback.value, "{\"version\":47}");
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
  assert.ok(hello.capabilities.includes("native-core-shadow-v1"));
  assert.ok(hello.capabilities.includes("native-core-projection-v1"));
  const base = JSON.stringify({ version: 47, mode: "normal", activePlanetId: "home", elapsedSeconds: 0, paused: false });
  const entities = JSON.stringify([{ id: "vein", kind: "vein", planetId: "home", resourceId: "iron_ore", minerCount: 2, inputs: {}, outputs: { iron_ore: 3 }, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0 }]);
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
  const opened = await client.request({
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
  });
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
  assert.deepEqual(projection.base, { paused: true, elapsedSeconds: 0 });
  assert.deepEqual(projection.entities, [JSON.parse(entities)[0]]);
  assert.deepEqual(projection.belts, [JSON.parse(belts)[0]]);
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
  const applied = await client.request({
    operation: "coreApplyCommand",
    sessionId: opened.sessionId,
    command: {
      protocolVersion: 1,
      baseRevision: 2,
      topLevelChanges: [{ path: ["paused"], operation: "set", value: false }],
      changedEntities: [], addedEntities: [], removedEntityIds: [], changedBelts: [], addedBelts: [], removedBeltIds: [],
    },
  });
  assert.equal(applied.revision, 3);
  assert.equal((await client.request({ operation: "coreStatus", sessionId: opened.sessionId })).paused, false);
  const unsupportedAdvance = await client.request({
    operation: "coreAdvance",
    sessionId: opened.sessionId,
    request: { baseRevision: 3, simulationSeconds: 1, wallSeconds: 1 },
  });
  assert.equal(unsupportedAdvance.supported, false);
  assert.equal(unsupportedAdvance.revision, 3);
  const repaused = await client.request({
    operation: "coreApplyCommand",
    sessionId: opened.sessionId,
    command: { ...pauseCommand, baseRevision: 3 },
  });
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
