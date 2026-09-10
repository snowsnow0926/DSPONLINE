const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const path = require("node:path");
const test = require("node:test");

function installMockHostExit(child) {
  const close = () => { child.emit("exit", 0, null); child.emit("close", 0, null); };
  child.kill = close;
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(parseFrames(Buffer.from(chunk)).frames[0].payload.toString("utf8"));
    if (request.operation === "shutdown") queueMicrotask(close);
  });
}

function stopFixture() {
  const child = new EventEmitter();
  let kills = 0, requests = 0;
  child.kill = () => { kills++; };
  const client = new NativeHostClient({ binaryPath: path.resolve("unused-host"), rootPath: path.resolve("unused-root") });
  client.child = child;
  client.closed = false;
  client.request = async () => { requests++; return { accepted: true }; };
  return { child, client, kills: () => kills, requests: () => requests };
}

test("Host shutdown ACK waits for close and simultaneous stops share one request", async () => {
  const fixture = stopFixture();
  let stopped = false;
  const first = fixture.client.stop().then(() => { stopped = true; });
  const second = fixture.client.stop();
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(fixture.kills(), 0);
  fixture.client.exited = true;
  fixture.child.emit("exit", 0, null);
  await Promise.resolve();
  assert.equal(stopped, false);
  fixture.child.emit("close", 0, null);
  await Promise.all([first, second]);
  assert.equal(stopped, true);
  assert.equal(fixture.requests(), 1);
  assert.equal(fixture.kills(), 0);
});

test("Host shutdown kills only after its deadline and still waits for confirmed close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = stopFixture();
  let stopped = false;
  const stopping = fixture.client.stop().then(() => { stopped = true; });
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(fixture.kills(), 1);
  assert.equal(stopped, false);
  fixture.child.emit("close", null, "SIGTERM");
  await stopping;
  assert.equal(stopped, true);
});

test("an unconfirmed Host stop rejects and cannot silently restart the same client", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = stopFixture();
  const rejected = assert.rejects(fixture.client.stop(), { code: "NATIVE_HOST_STOP_UNCONFIRMED" });
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  t.mock.timers.tick(2_000);
  await rejected;
  assert.equal(fixture.kills(), 1);
  await assert.rejects(fixture.client.start(), { code: "NATIVE_HOST_STOP_UNCONFIRMED" });
});

const {
  CONTROL_RESPONSE_KIND,
  MAX_NATIVE_PROJECTION_TRANSFER_BYTES,
  NATIVE_FACTORY_INVENTORY_CAPABILITY,
  NATIVE_CONSTRUCTION_INVENTORY_CAPABILITY,
  NATIVE_BLUEPRINT_ENQUEUE_CONTEXT_CAPABILITY,
  NATIVE_BLUEPRINT_DIRECT_DEPLOY_CONTEXT_CAPABILITY,
  NATIVE_CONSTRUCTION_PLACEMENT_CONTEXT_CAPABILITY,
  NATIVE_CONSTRUCTION_REMOVAL_CONTEXT_CAPABILITY,
  NATIVE_CONSTRUCTION_STACK_CONTEXT_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_COMMAND_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_COMMAND_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_GATE_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_PAUSE_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
  NATIVE_PLAYER_AUTHORITY_TICK_CAPABILITY,
  NATIVE_OFFLINE_MACRO_CAPABILITY,
  NATIVE_OFFLINE_CANDIDATE_EXPORT_CAPABILITY,
  NATIVE_VIEWPORT_ENTITY_PRESENTATION_CAPABILITY,
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
  normalizeNativeCoreCommitOperation,
  normalizeNativeHostSpawnEnvironment,
  parseFrames,
} = require("./native-host.cjs");
const {
  deriveSystemSpaceStationCommandIdentity,
} = require("./native-system-space-station-intent.cjs");

test("native factory inventory capability matches the Rust host contract", () => {
  assert.equal(NATIVE_FACTORY_INVENTORY_CAPABILITY, "native-core-factory-inventory-v1");
  assert.equal(NATIVE_CONSTRUCTION_INVENTORY_CAPABILITY, "native-core-construction-inventory-v1");
  assert.equal(
    NATIVE_BLUEPRINT_ENQUEUE_CONTEXT_CAPABILITY,
    "native-core-blueprint-enqueue-context-v1",
  );
  assert.equal(
    NATIVE_BLUEPRINT_DIRECT_DEPLOY_CONTEXT_CAPABILITY,
    "native-core-blueprint-direct-deploy-context-v1",
  );
  assert.equal(
    NATIVE_CONSTRUCTION_PLACEMENT_CONTEXT_CAPABILITY,
    "native-core-construction-placement-context-v1",
  );
  assert.equal(
    NATIVE_CONSTRUCTION_REMOVAL_CONTEXT_CAPABILITY,
    "native-core-construction-removal-context-v1",
  );
  assert.equal(
    NATIVE_CONSTRUCTION_STACK_CONTEXT_CAPABILITY,
    "native-core-construction-stack-context-v1",
  );
  assert.equal(NATIVE_OFFLINE_MACRO_CAPABILITY, "native-core-offline-macro-v1");
});

test("native host accepts only an explicit one-x offline macro wire request", () => {
  assert.deepEqual(normalizeNativeCoreCommitOperation({
    commandId: "offline-main-7-600000",
    baseRevision: 7,
    command: null,
    simulationSeconds: 600,
    wallSeconds: 600,
    advanceMode: "offline-macro-v1",
    includeDiagnostics: true,
  }), {
    commandId: "offline-main-7-600000",
    baseRevision: 7,
    command: null,
    simulationSeconds: 600,
    wallSeconds: 600,
    advanceMode: "offline-macro-v1",
    includeDiagnostics: true,
  });
  assert.throws(() => normalizeNativeCoreCommitOperation({
    commandId: "offline-main-7-invalid",
    baseRevision: 7,
    simulationSeconds: 600,
    wallSeconds: 600,
    advanceMode: "offline-macro-v2",
  }), /authoritative operation is invalid/);
});

test("native offline settlement injects the main clock and rejects renderer-owned time", async () => {
  const calls = [];
  const client = {
    hello: { capabilities: [NATIVE_OFFLINE_MACRO_CAPABILITY] },
    async request(request) {
      calls.push(request);
      if (request.operation === "coreOpen") {
        return { sessionId: "core-offline", authority: "shadow", summary: {} };
      }
      return { settled: true };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  const catalog = {
    protocolVersion: 1,
    registryFingerprint: "builtin:test",
    items: [{ id: "iron_ore", kind: "solid" }],
    buildings: [{
      id: "mining_machine",
      kind: "miner",
      speed: 1,
      inputCapacity: 0,
      outputCapacity: 50,
      powerDemandKw: 1,
      powerGenerationKw: 0,
    }],
    recipes: [],
    belts: [{ tier: 1, speed: 6 }],
  };
  await registry.open(7, {
    slot: "normal-main",
    generation: 3,
    rootHash: "a".repeat(64),
    revision: 9,
    registryFingerprint: "builtin:test",
    catalog,
  });
  const intent = {
    sessionId: "core-offline",
    expectedGeneration: 3,
    expectedRootHash: "a".repeat(64),
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    strategy: "macro-v1",
  };
  await registry.commitOfflineSettlement(7, intent, 123_456);
  assert.deepEqual(calls.at(-1), {
    operation: "coreCommitOfflineSettlement",
    sessionId: "core-offline",
    request: {
      expectedGeneration: 3,
      expectedRootHash: "a".repeat(64),
      expectedRevision: 9,
      expectedRegistryFingerprint: "builtin:test",
      observedNowMs: 123_456,
      strategy: "macro-v1",
    },
  });
  assert.throws(() => registry.commitOfflineSettlement(7, {
    ...intent,
    observedNowMs: 1,
  }, 123_456), /offline settlement intent/);
});

test("native offline candidate keeps clock and export identity main-owned", async () => {
  const calls = [];
  const client = {
    hello: { capabilities: [NATIVE_OFFLINE_CANDIDATE_EXPORT_CAPABILITY] },
    async request(request) {
      calls.push(request);
      if (request.operation === "coreOpen") {
        return { sessionId: "core-offline-candidate", authority: "shadow", summary: {} };
      }
      return { prepared: true };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  const catalog = {
    protocolVersion: 1,
    registryFingerprint: "builtin:test",
    items: [{ id: "iron_ore", kind: "solid" }],
    buildings: [{
      id: "mining_machine", kind: "miner", speed: 1, inputCapacity: 0,
      outputCapacity: 50, powerDemandKw: 1, powerGenerationKw: 0,
    }],
    recipes: [],
    belts: [{ tier: 1, speed: 6 }],
  };
  await registry.open(7, {
    slot: "normal-main", generation: 3, rootHash: "a".repeat(64), revision: 9,
    registryFingerprint: "builtin:test", catalog,
  });
  const intent = {
    sessionId: "core-offline-candidate",
    expectedGeneration: 3,
    expectedRootHash: "a".repeat(64),
    expectedRevision: 9,
    expectedRegistryFingerprint: "builtin:test",
    expectedCanonicalSha256: "b".repeat(64),
    expectedDomainSha256: "c".repeat(64),
    strategy: "macro-v1",
  };
  await registry.prepareOfflineSettlementExport(
    7,
    intent,
    123_456,
    "offlinecandidate123",
  );
  assert.deepEqual(calls.at(-1), {
    operation: "corePrepareOfflineSettlementExport",
    sessionId: "core-offline-candidate",
    request: {
      expectedGeneration: 3,
      expectedRootHash: "a".repeat(64),
      expectedRevision: 9,
      expectedRegistryFingerprint: "builtin:test",
      expectedCanonicalSha256: "b".repeat(64),
      expectedDomainSha256: "c".repeat(64),
      observedNowMs: 123_456,
      strategy: "macro-v1",
      exportId: "offlinecandidate123",
    },
  });
  assert.throws(() => registry.prepareOfflineSettlementExport(7, {
    ...intent,
    observedNowMs: 1,
  }, 123_456, "offlinecandidate123"), /offline candidate intent/);
  assert.throws(() => registry.prepareOfflineSettlementExport(
    7,
    intent,
    123_456,
    "../outside",
  ), /offline candidate intent/);
});

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
  const viewportV2Transfer = encodeNativeProjectionTransfer({
    sessionId: "core-1",
    sequence: 8,
    projectionType: "viewport-v2",
    result: {
      schemaVersion: 2,
      projectionType: "viewport-v2",
      revision: 13,
      planetId: "home",
      entities: [],
      belts: [],
    },
  });
  assert.equal(viewportV2Transfer.header.schemaVersion, 1);
  assert.equal(viewportV2Transfer.header.projectionType, "viewport-v2");
  assert.equal(JSON.parse(viewportV2Transfer.payload).schemaVersion, 2);
  const factoryReadModelTransfer = encodeNativeProjectionTransfer({
    sessionId: "core-1",
    sequence: 9,
    projectionType: "factory-read-model-v1",
    result: {
      schemaVersion: 1,
      projectionType: "factory-read-model-v1",
      revision: 13,
      shell: {},
    },
  });
  assert.equal(factoryReadModelTransfer.header.projectionType, "factory-read-model-v1");
  assert.equal(JSON.parse(factoryReadModelTransfer.payload).schemaVersion, 1);
  const factoryInventoryTransfer = encodeNativeProjectionTransfer({
    sessionId: "core-1",
    sequence: 10,
    projectionType: "factory-inventory-v1",
    result: {
      schemaVersion: 1,
      projectionType: "factory-inventory-v1",
      revision: 13,
      rows: [],
    },
  });
  assert.equal(factoryInventoryTransfer.header.projectionType, "factory-inventory-v1");
  assert.equal(JSON.parse(factoryInventoryTransfer.payload).revision, 13);
  for (const projectionType of [
    "star-map-overview-v1", "star-map-catalog-v1", "stellar-industry-v1", "stellar-industry-v2", "stellar-quantum-v1",
    "dyson-workspace-v1", "system-space-station-workspace-v1",
  ]) {
    const stellarTransfer = encodeNativeProjectionTransfer({
      sessionId: "core-1",
      sequence: 11,
      projectionType,
      result: {
        schemaVersion: projectionType === "stellar-industry-v2" ? 2 : 1,
        projectionType,
        revision: 13,
        registryFingerprint: "builtin:test",
      },
    });
    assert.equal(stellarTransfer.header.projectionType, projectionType);
    assert.equal(JSON.parse(stellarTransfer.payload).registryFingerprint, "builtin:test");
  }
  assert.throws(() => encodeNativeProjectionTransfer({
    sessionId: "core-1",
    sequence: 9,
    projectionType: "viewport-v2",
    result: { schemaVersion: 1, projectionType: "viewport-v2", revision: 13 },
  }), /projection transfer is invalid/);
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

test("save session checks the exact normalized batch against the fixed native filesystem before IPC", async () => {
  const calls = [];
  const budgetCalls = [];
  const client = {
    hello: { capabilities: ["native-save-put-batch-v1"] },
    async request(request) {
      calls.push(request);
      if (request.operation === "saveBegin") return { transactionId: "tx-budget" };
      return { acceptedRecords: request.records.length };
    },
  };
  const targetPath = path.resolve("DSPidle2-Performance-Edition", "native-save-v1", ".native-save-space-probe");
  const registry = new NativeSaveSessionRegistry(client, {
    diskBudgetTargetPath: targetPath,
    diskBudgetCheck(request) {
      budgetCalls.push(request);
      return { allowed: true, checked: true };
    },
  });
  await registry.begin(7, {
    slot: "normal-main",
    mode: "normal",
    stateVersion: 47,
    baseChecksum: "01234567",
    registryFingerprint: "builtin:test",
    revision: 1,
    savedAtMs: 1,
  });
  const records = [
    { key: "base", value: "{\"label\":\"白糖🚀\"}" },
    { key: "entities:00000000", value: "[]" },
  ];
  await registry.write(7, "tx-budget", records);
  assert.deepEqual(budgetCalls, [{ targetPath, payload: JSON.stringify(records) }]);
  assert.deepEqual(calls.map((call) => call.operation), ["saveBegin", "savePutBatch"]);

  const rejected = new NativeSaveSessionRegistry(client, {
    diskBudgetTargetPath: targetPath,
    diskBudgetCheck() { throw Object.assign(new Error("low disk"), { code: "NATIVE_SAVE_DISK_BUDGET_SPACE_INSUFFICIENT" }); },
  });
  await rejected.begin(9, {
    slot: "normal-main",
    mode: "normal",
    stateVersion: 47,
    baseChecksum: "01234567",
    registryFingerprint: "builtin:test",
    revision: 2,
    savedAtMs: 2,
  });
  const beforeRejectedWrite = calls.length;
  await assert.rejects(
    () => rejected.write(9, "tx-budget", [{ key: "base", value: "{}" }]),
    (error) => error.code === "NATIVE_SAVE_DISK_BUDGET_SPACE_INSUFFICIENT",
  );
  assert.equal(calls.length, beforeRejectedWrite);
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
  assert.equal(registry.inspectSession(7, "core-1").registryFingerprint, "builtin:test");
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
  await registry.viewportProjectionV2(7, {
    sessionId: "core-1",
    baseFields: ["paused"],
    planetId: "MOD-星球",
    bounds: { minX: -100, minY: -50, maxX: 100, maxY: 50 },
    entityCursor: 2,
    entityLimit: 64,
    beltCursor: 3,
    beltLimit: 128,
    pinnedEntityIds: ["MOD-建筑"],
    pinnedBeltIds: ["MOD-线路"],
  });
  assert.throws(() => registry.viewportProjectionV2(7, {
    sessionId: "core-1",
    planetId: "home",
    bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    entityLimit: 64,
    beltLimit: 64,
    pinnedEntityIds: ["bad\0id"],
  }), /viewport v2 projection request is invalid/);
  await registry.factoryReadModelProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    selectedEntityIds: ["MOD-建筑"],
    selectedBeltIds: ["MOD-线路"],
  });
  assert.throws(() => registry.factoryReadModelProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    selectedEntityIds: new Array(65).fill("entity"),
  }), /factory read-model projection request is invalid/);
  assert.throws(() => registry.factoryReadModelProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    selectedBeltIds: ["bad\0id"],
  }), /factory read-model projection request is invalid/);
  await registry.recipeWorkspaceProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    itemIds: ["iron_ore"],
    selectedItemId: "iron_ore",
    location: { planetId: "home", cursor: 0, limit: 32 },
  });
  assert.throws(() => registry.recipeWorkspaceProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    itemIds: ["iron_ore", "iron_ore"],
    selectedItemId: "iron_ore",
    location: null,
  }), /recipe workspace projection request is invalid/);
  await registry.starMapOverviewProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    cursor: 0,
    limit: 64,
  });
  assert.throws(() => registry.starMapOverviewProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    cursor: 0,
    limit: 65,
  }), /star-map overview projection request is invalid/);
  await registry.starMapCatalogProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    systemCursor: 0,
    systemLimit: 64,
    planetCursor: 64,
    planetLimit: 32,
  });
  assert.throws(() => registry.starMapCatalogProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    systemCursor: 0,
    systemLimit: 64,
    planetCursor: 0,
    planetLimit: 65,
  }), /star-map catalog projection request is invalid/);
  await registry.stellarIndustryProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    systemId: "helios",
    planetId: null,
    planetCursor: 0,
    planetLimit: 32,
    stationCursor: 64,
    stationLimit: 64,
  });
  assert.throws(() => registry.stellarIndustryProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    systemId: null,
    planetId: null,
    planetCursor: 0,
    planetLimit: 0,
    stationCursor: 0,
    stationLimit: 64,
  }), /stellar industry projection request is invalid/);
  await registry.stellarIndustryProjectionV2(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    systemId: "helios",
    planetId: null,
    planetCursor: 0,
    planetLimit: 32,
    stationCursor: 64,
    stationLimit: 64,
    routeCursor: 128,
    routeLimit: 64,
    routeFilter: "issues",
    query: "warper",
  });
  assert.throws(() => registry.stellarIndustryProjectionV2(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    systemId: null,
    planetId: null,
    planetCursor: 0,
    planetLimit: 64,
    stationCursor: 0,
    stationLimit: 64,
    routeCursor: 0,
    routeLimit: 64,
    routeFilter: "unknown",
    query: "",
  }), /stellar industry v2 projection request is invalid/);
  await registry.stellarQuantumProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    itemCursor: 0,
    itemLimit: 64,
    collectorCursor: 128,
    collectorLimit: 32,
  });
  assert.throws(() => registry.stellarQuantumProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    itemCursor: 0,
    itemLimit: 65,
    collectorCursor: 0,
    collectorLimit: 64,
  }), /stellar quantum projection request is invalid/);
  assert.throws(() => registry.stellarQuantumProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    itemCursor: 0,
    itemLimit: 64,
    collectorCursor: 0,
    collectorLimit: 64,
    unexpected: true,
  }), /stellar quantum projection request is invalid/);
  assert.throws(() => registry.stellarIndustryProjectionV2(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    systemId: null,
    planetId: null,
    planetCursor: 0,
    planetLimit: 64,
    stationCursor: 0,
    stationLimit: 64,
    routeCursor: 0,
    routeLimit: 64,
    routeFilter: "all",
    query: "x".repeat(513),
  }), /stellar industry v2 projection request is invalid/);
  await registry.commandPaletteEntitySearchProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    query: "熔炉",
    cursor: 0,
    limit: 16,
    buildingIds: ["smelter"],
    resourceIds: [],
    planetIds: ["home"],
  });
  assert.throws(() => registry.commandPaletteEntitySearchProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    query: "熔炉",
    cursor: 0,
    limit: 17,
    buildingIds: [],
    resourceIds: [],
    planetIds: [],
  }), /command palette entity-search request is invalid/);
  assert.throws(() => registry.commandPaletteEntitySearchProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    query: "熔炉",
    cursor: 0,
    limit: 16,
    buildingIds: Array.from({ length: 205 }, (_, index) => `mod_${String(index).padStart(3, "0")}_${"x".repeat(150)}`),
    resourceIds: [],
    planetIds: [],
  }), /bounded IPC limit/);
  assert.throws(() => registry.recipeWorkspaceProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    itemIds: [],
    selectedItemId: "iron_ore",
    location: { planetId: "home", cursor: 0, limit: 4_097 },
  }), /recipe workspace projection request is invalid/);
  await registry.factoryInventoryProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    cursor: 256,
    limit: 128,
  });
  assert.throws(() => registry.factoryInventoryProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    cursor: 0,
    limit: 257,
  }), /factory inventory projection request is invalid/);
  assert.throws(() => registry.factoryInventoryProjection(7, {
    sessionId: "core-1",
    expectedRevision: 2,
    cursor: 0,
    limit: 128,
    path: "C:\\secret",
  }), /factory inventory projection request is invalid/);
  assert.throws(() => registry.checkpoint(7, { sessionId: "core-1", savedAtMs: -1 }), /timestamp/);
  await registry.checkpoint(7, { sessionId: "core-1", savedAtMs: 2 });
  await registry.close(7, "core-1");
  assert.throws(() => registry.status(7, "core-1"), /not owned/);
  assert.deepEqual(calls.map((call) => call.operation), [
    "coreOpen", "coreStatus", "coreCommitOperation", "coreViewportProjectionV2",
    "coreFactoryReadModelProjection", "coreRecipeWorkspaceProjection",
    "coreStarMapOverviewProjection", "coreStarMapCatalogProjection", "coreStellarIndustryProjection",
    "coreStellarIndustryProjectionV2", "coreStellarQuantumProjection",
    "coreCommandPaletteEntitySearchProjection", "coreFactoryInventoryProjection",
    "coreCheckpoint", "coreClose",
  ]);
  assert.deepEqual(calls[3], {
    operation: "coreViewportProjectionV2",
    sessionId: "core-1",
    baseFields: ["paused"],
    planetId: "MOD-星球",
    minX: -100,
    minY: -50,
    maxX: 100,
    maxY: 50,
    entityCursor: 2,
    entityLimit: 64,
    beltCursor: 3,
    beltLimit: 128,
    pinnedEntityIds: ["MOD-建筑"],
    pinnedBeltIds: ["MOD-线路"],
  });
  assert.deepEqual(calls[4], {
    operation: "coreFactoryReadModelProjection",
    sessionId: "core-1",
    selectedEntityIds: ["MOD-建筑"],
    selectedBeltIds: ["MOD-线路"],
  });
  assert.deepEqual(calls[5], {
    operation: "coreRecipeWorkspaceProjection",
    sessionId: "core-1",
    expectedRegistryFingerprint: "builtin:test",
    itemIds: ["iron_ore"],
    selectedItemId: "iron_ore",
    locationPlanetId: "home",
    locationCursor: 0,
    locationLimit: 32,
  });
  assert.deepEqual(calls[6], {
    operation: "coreStarMapOverviewProjection",
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    cursor: 0,
    limit: 64,
  });
  assert.deepEqual(calls[7], {
    operation: "coreStarMapCatalogProjection",
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    systemCursor: 0,
    systemLimit: 64,
    planetCursor: 64,
    planetLimit: 32,
  });
  assert.deepEqual(calls[8], {
    operation: "coreStellarIndustryProjection",
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    systemId: "helios",
    planetId: null,
    planetCursor: 0,
    planetLimit: 32,
    stationCursor: 64,
    stationLimit: 64,
  });
  assert.deepEqual(calls[9], {
    operation: "coreStellarIndustryProjectionV2",
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    systemId: "helios",
    planetId: null,
    planetCursor: 0,
    planetLimit: 32,
    stationCursor: 64,
    stationLimit: 64,
    routeCursor: 128,
    routeLimit: 64,
    routeFilter: "issues",
    query: "warper",
  });
  assert.deepEqual(calls[10], {
    operation: "coreStellarQuantumProjection",
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    itemCursor: 0,
    itemLimit: 64,
    collectorCursor: 128,
    collectorLimit: 32,
  });
  assert.deepEqual(calls[11], {
    operation: "coreCommandPaletteEntitySearchProjection",
    sessionId: "core-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
    query: "熔炉",
    cursor: 0,
    limit: 16,
    buildingIds: ["smelter"],
    resourceIds: [],
    planetIds: ["home"],
  });
  assert.deepEqual(calls[12], {
    operation: "coreFactoryInventoryProjection",
    sessionId: "core-1",
    expectedRevision: 2,
    cursor: 256,
    limit: 128,
  });
});

test("authority workspace run lineage is validated at the host boundary and never forwarded into Rust schemas", async () => {
  const catalog = {
    protocolVersion: 1,
    registryFingerprint: "builtin:test",
    items: [{ id: "iron_ore", kind: "solid" }],
    buildings: [{ id: "mining_machine", kind: "miner", speed: 1, inputCapacity: 0, outputCapacity: 50, powerDemandKw: 1, powerGenerationKw: 0 }],
    recipes: [],
    belts: [{ tier: 1, speed: 6 }],
  };
  const calls = [];
  const client = { async request(request) {
    calls.push(request);
    if (request.operation === "coreOpen") return { sessionId: "core-lineage", authority: "shadow", summary: {} };
    return { revision: 2 };
  } };
  const registry = new NativeCoreSessionRegistry(client);
  await registry.open(7, {
    slot: "normal-main",
    generation: 1,
    rootHash: "a".repeat(64),
    revision: 1,
    registryFingerprint: "builtin:test",
    catalog,
  });
  const base = {
    sessionId: "core-lineage",
    runId: "run-lineage-1",
    expectedRevision: 2,
    expectedRegistryFingerprint: "builtin:test",
  };
  await registry.factoryInventoryProjection(7, { ...base, cursor: 0, limit: 256 });
  await registry.constructionInventoryProjection(7, { ...base, cursor: 0, limit: 256 });
  await registry.blueprintWorkspaceProjection(7, {
    ...base,
    section: "library",
    blueprintId: null,
    queueEntryId: null,
    cursor: 0,
    limit: 32,
  });
  await registry.starMapOverviewProjection(7, { ...base, cursor: 0, limit: 64 });
  await registry.stellarIndustryProjectionV2(7, {
    ...base,
    systemId: null,
    planetId: null,
    planetCursor: 0,
    planetLimit: 64,
    stationCursor: 0,
    stationLimit: 64,
    routeCursor: 0,
    routeLimit: 64,
    routeFilter: "all",
    query: "",
  });
  await registry.stellarQuantumProjection(7, {
    ...base,
    itemCursor: 0,
    itemLimit: 64,
    collectorCursor: 0,
    collectorLimit: 64,
  });
  await registry.commandPaletteEntitySearchProjection(7, {
    ...base,
    query: "熔炉",
    cursor: 0,
    limit: 16,
    buildingIds: ["mining_machine"],
    resourceIds: ["iron_ore"],
    planetIds: [],
  });
  for (const request of calls.slice(1)) {
    assert.equal(Object.hasOwn(request, "runId"), false);
  }
  assert.throws(() => registry.factoryInventoryProjection(7, {
    sessionId: "core-lineage",
    runId: "run-lineage-1",
    expectedRevision: 2,
    cursor: 0,
    limit: 256,
  }), /factory inventory projection request is invalid/);
  assert.throws(() => registry.commandPaletteEntitySearchProjection(7, {
    ...base,
    runId: "bad run",
    query: "熔炉",
    cursor: 0,
    limit: 16,
    buildingIds: [],
    resourceIds: [],
    planetIds: [],
  }), /command palette entity-search request is invalid/);
});

test("statistics projection accepts the exact host window bound with player-authority lineage metadata", async () => {
  const calls = [];
  const client = { request(request) {
    calls.push(request);
    return Promise.resolve({ schemaVersion: 1, projectionType: "statistics-v1", revision: 17 });
  } };
  const registry = new NativeCoreSessionRegistry(client);
  registry.sessions.set("core-main-1", {
    ownerId: "main-player-authority",
    slot: "normal-main",
    registryFingerprint: "7df8cf3a",
    ownerEpoch: 2,
    state: "owned",
    inFlight: 0,
  });
  const maximumElapsedSeconds = 30 * 24 * 60 * 60 * 10_000;
  await registry.statisticsProjection("main-player-authority", {
    sessionId: "core-main-1",
    runId: "run-1",
    expectedRevision: 17,
    expectedRegistryFingerprint: "7df8cf3a",
    minElapsedSeconds: 0,
    maxElapsedSeconds: maximumElapsedSeconds,
    cursor: 0,
    limit: 512,
  });
  assert.deepEqual(calls, [{
    operation: "coreStatisticsProjection",
    sessionId: "core-main-1",
    minElapsedSeconds: 0,
    maxElapsedSeconds: maximumElapsedSeconds,
    cursor: 0,
    limit: 512,
  }]);
  assert.throws(() => registry.statisticsProjection("main-player-authority", {
    sessionId: "core-main-1",
    expectedRevision: 17,
    minElapsedSeconds: 0,
    maxElapsedSeconds: maximumElapsedSeconds + 1,
    cursor: 0,
    limit: 512,
  }), /statistics projection request is invalid/);
});

test("viewport v2 entity presentation is capability-gated and forwarded only when requested", async () => {
  const catalog = {
    protocolVersion: 1,
    registryFingerprint: "builtin:test",
    items: [{ id: "iron_ore", kind: "solid" }],
    buildings: [{
      id: "mining_machine",
      kind: "miner",
      speed: 1,
      inputCapacity: 0,
      outputCapacity: 50,
      powerDemandKw: 1,
      powerGenerationKw: 0,
    }],
    recipes: [],
    belts: [{ tier: 1, speed: 6 }],
  };
  const calls = [];
  const client = {
    hello: { capabilities: [] },
    async request(request) {
      calls.push(request);
      if (request.operation === "coreOpen") {
        return { sessionId: "core-presentation", authority: "shadow", summary: {} };
      }
      return { revision: 1 };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  await registry.open(9, {
    slot: "normal-main",
    generation: 1,
    rootHash: "a".repeat(64),
    revision: 1,
    registryFingerprint: "builtin:test",
    catalog,
  });
  const request = {
    sessionId: "core-presentation",
    planetId: "planet-a",
    bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    entityLimit: 64,
    beltLimit: 64,
    entityPresentationVersion: 1,
  };

  assert.throws(
    () => registry.viewportProjectionV2(9, request),
    (error) => error?.code === "NATIVE_CORE_CAPABILITY_MISSING",
  );
  assert.equal(calls.some((call) => call.operation === "coreViewportProjectionV2"), false);

  client.hello.capabilities.push(NATIVE_VIEWPORT_ENTITY_PRESENTATION_CAPABILITY);
  await registry.viewportProjectionV2(9, request);
  assert.deepEqual(calls.at(-1), {
    operation: "coreViewportProjectionV2",
    sessionId: "core-presentation",
    baseFields: [],
    planetId: "planet-a",
    minX: -1,
    minY: -1,
    maxX: 1,
    maxY: 1,
    entityCursor: 0,
    entityLimit: 64,
    beltCursor: 0,
    beltLimit: 64,
    pinnedEntityIds: [],
    pinnedBeltIds: [],
    entityPresentationVersion: 1,
  });
});

test("core registry forwards an exact blueprint selector and rejects ambiguous IDs or cursors", async () => {
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    request(request) {
      calls.push(request);
      return Promise.resolve({ schemaVersion: 1, projectionType: "blueprint-workspace-v1", revision: 8 });
    },
  });
  registry.sessions.set("core-blueprint", {
    ownerId: 7, slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  const request = {
    sessionId: "core-blueprint",
    expectedRevision: 8,
    expectedRegistryFingerprint: "builtin:test",
    section: "detail",
    blueprintId: "mod:蓝图/Ω🚀",
    queueEntryId: null,
    cursor: 0,
    limit: 32,
  };
  await registry.blueprintWorkspaceProjection(7, request);
  const stalePageRequest = {
    ...request,
    section: "library",
    blueprintId: null,
    cursor: 4_096,
  };
  await registry.blueprintWorkspaceProjection(7, stalePageRequest);
  const membershipRequest = {
    ...request,
    section: "queue-membership",
    blueprintId: null,
    queueEntryId: "queue-across-page",
  };
  await registry.blueprintWorkspaceProjection(7, membershipRequest);
  assert.deepEqual(calls, [
    { operation: "coreBlueprintWorkspaceProjection", ...request },
    { operation: "coreBlueprintWorkspaceProjection", ...stalePageRequest },
    { operation: "coreBlueprintWorkspaceProjection", ...membershipRequest },
  ]);
  for (const invalid of [
    { ...request, blueprintId: "bad\nidentifier" },
    { ...request, blueprintId: "\ud800" },
    { ...request, cursor: 1 },
    { ...request, section: "library" },
    { ...membershipRequest, queueEntryId: null },
    { ...membershipRequest, blueprintId: "ambiguous" },
    { ...request, section: "library", blueprintId: null, cursor: 4_097 },
    { ...request, unexpected: true },
  ]) {
    assert.throws(
      () => registry.blueprintWorkspaceProjection(7, invalid),
      /blueprint workspace projection request is invalid/,
    );
  }
});

test("core registry forwards exact bounded Dyson workspace page selectors and rejects malformed UTF-8 IDs", async () => {
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    request(request) {
      calls.push(request);
      return Promise.resolve({ schemaVersion: 1, projectionType: "dyson-workspace-v1", revision: 8 });
    },
  });
  registry.sessions.set("core-dyson", {
    ownerId: 7, slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  const request = {
    sessionId: "core-dyson",
    runId: "run-dyson-1",
    expectedRevision: 8,
    expectedRegistryFingerprint: "builtin:test",
    selectedSystemId: "mod:星系/Ω🚀",
    systemCursor: 1,
    systemLimit: 2,
    layerCursor: 3,
    layerLimit: 4,
    orbitCursor: 5,
    orbitLimit: 6,
    nodeCursor: 7,
    nodeLimit: 8,
    frameCursor: 9,
    frameLimit: 10,
    shellCursor: 11,
    shellLimit: 12,
  };
  await registry.dysonWorkspaceProjection(7, request);
  const { runId: _rendererLineage, ...nativeRequest } = request;
  assert.deepEqual(calls, [{ operation: "coreDysonWorkspaceProjection", ...nativeRequest }]);
  assert.throws(
    () => registry.dysonWorkspaceProjection(7, { ...request, selectedSystemId: "bad\nidentifier" }),
    /Dyson workspace projection request is invalid/,
  );
  assert.throws(
    () => registry.dysonWorkspaceProjection(7, { ...request, selectedSystemId: "\ud800" }),
    /Dyson workspace projection request is invalid/,
  );
  assert.throws(
    () => registry.dysonWorkspaceProjection(7, { ...request, shellLimit: 65 }),
    /Dyson workspace projection request is invalid/,
  );
  assert.throws(
    () => registry.dysonWorkspaceProjection(7, { ...request, unexpected: true }),
    /Dyson workspace projection request is invalid/,
  );
  assert.throws(
    () => registry.dysonWorkspaceProjection(7, { ...request, runId: "bad run" }),
    /Dyson workspace projection request is invalid/,
  );
});

test("core registry validates renderer lineage tags and never forwards them into Rust projection schemas", async () => {
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    request(request) {
      calls.push(request);
      return Promise.resolve({ schemaVersion: 1, revision: 8 });
    },
  });
  registry.sessions.set("core-lineage", {
    ownerId: 7,
    slot: "normal-main",
    registryFingerprint: "builtin:test",
    ownerEpoch: 1,
    state: "owned",
    inFlight: 0,
  });

  await registry.technologyProjection(7, {
    sessionId: "core-lineage",
    runId: "run-lineage-1",
    expectedRevision: 8,
    expectedRegistryFingerprint: "builtin:test",
  });
  await registry.recipeWorkspaceProjection(7, {
    sessionId: "core-lineage",
    runId: "run-lineage-1",
    expectedRevision: 8,
    expectedRegistryFingerprint: "builtin:test",
    itemIds: ["iron_ore"],
    selectedItemId: "iron_ore",
    location: null,
  });

  assert.deepEqual(calls, [
    { operation: "coreTechnologyProjection", sessionId: "core-lineage" },
    {
      operation: "coreRecipeWorkspaceProjection",
      sessionId: "core-lineage",
      expectedRegistryFingerprint: "builtin:test",
      itemIds: ["iron_ore"],
      selectedItemId: "iron_ore",
    },
  ]);
  assert.throws(() => registry.technologyProjection(7, {
    sessionId: "core-lineage",
    runId: "run-lineage-1",
    expectedRevision: 8,
  }), /technology projection request is invalid/);
  assert.throws(() => registry.technologyProjection(7, {
    sessionId: "core-lineage",
    expectedRevision: 8,
    expectedRegistryFingerprint: "builtin:test",
  }), /technology projection request is invalid/);
  assert.throws(() => registry.recipeWorkspaceProjection(7, {
    sessionId: "core-lineage",
    runId: "bad run",
    expectedRevision: 8,
    expectedRegistryFingerprint: "builtin:test",
    itemIds: ["iron_ore"],
    selectedItemId: "iron_ore",
    location: null,
  }), /recipe workspace projection request is invalid/);
});

test("core registry forwards exact bounded system-space-station selectors and lineage", async () => {
  const calls = [];
  const registry = new NativeCoreSessionRegistry({
    request(request) {
      calls.push(request);
      return Promise.resolve({
        schemaVersion: 1,
        projectionType: "system-space-station-workspace-v1",
        revision: 8,
      });
    },
  });
  registry.sessions.set("core-station", {
    ownerId: 7, slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  const request = {
    sessionId: "core-station",
    runId: "run-station-1",
    expectedRevision: 8,
    expectedRegistryFingerprint: "builtin:test",
    systemId: "mod:星系/Ω🚀",
    requirementCursor: 1,
    requirementLimit: 2,
    inventoryCursor: 3,
    inventoryLimit: 4,
    trayCursor: 5,
    trayLimit: 6,
    stationCursor: 7,
    stationLimit: 8,
  };
  await registry.systemSpaceStationWorkspaceProjection(7, request);
  assert.deepEqual(calls, [{ operation: "coreSystemSpaceStationWorkspaceProjection", ...request }]);
  for (const invalid of [
    { ...request, runId: "bad\nrun" },
    { ...request, systemId: "bad\nidentifier" },
    { ...request, stationLimit: 65 },
    { ...request, unexpected: true },
  ]) {
    assert.throws(
      () => registry.systemSpaceStationWorkspaceProjection(7, invalid),
      /system-space-station workspace projection request is invalid/,
    );
  }
});

test("core owner transfer is atomic against in-flight requests and epoch-protected against ABA", async () => {
  let registry;
  const pendingStatus = {};
  pendingStatus.promise = new Promise((resolve) => { pendingStatus.resolve = resolve; });
  let reentrantTransferError = null;
  const client = {
    request(request) {
      if (request.operation === "coreStatus") {
        try {
          registry.transferOwner(7, "main-player-authority", {
            sessionId: "core-1",
            expectedSlot: "normal-main",
            expectedOwnerEpoch: 1,
          });
        } catch (error) {
          reentrantTransferError = error;
        }
        return pendingStatus.promise;
      }
      return Promise.resolve({});
    },
  };
  registry = new NativeCoreSessionRegistry(client);
  registry.sessions.set("core-1", {
    ownerId: 7, slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });

  const status = registry.status(7, "core-1");
  assert.equal(reentrantTransferError?.code, "NATIVE_CORE_SESSION_BUSY");
  assert.equal(registry.inspectSession(7, "core-1").inFlight, 1);
  assert.throws(() => registry.transferOwner(7, "main-player-authority", {
    sessionId: "core-1", expectedSlot: "normal-main", expectedOwnerEpoch: 1,
  }), (error) => error.code === "NATIVE_CORE_SESSION_BUSY");

  pendingStatus.resolve({ revision: 4 });
  await status;
  const receipt = registry.transferOwner(7, "main-player-authority", {
    sessionId: "core-1", expectedSlot: "normal-main", expectedOwnerEpoch: 1,
  });
  assert.deepEqual(receipt, {
    kind: "native-core-session-owner-transfer-v1",
    sessionId: "core-1",
    previousOwnerId: 7,
    ownerId: "main-player-authority",
    slot: "normal-main",
    previousOwnerEpoch: 1,
    ownerEpoch: 2,
    inFlight: 0,
  });
  assert.throws(() => registry.status(7, "core-1"), (error) => error.code === "NATIVE_CORE_SESSION_INVALID");
  assert.throws(() => registry.transferOwner("main-player-authority", "next-owner", {
    sessionId: "core-1", expectedSlot: "normal-main", expectedOwnerEpoch: 1,
  }), (error) => error.code === "NATIVE_CORE_SESSION_TRANSFER_INVALID");
  assert.equal(registry.inspectSession("main-player-authority", "core-1").ownerEpoch, 2);
});

test("core registry fails closed on in-flight counter exhaustion and forced owner teardown", async () => {
  const closeGate = {};
  closeGate.promise = new Promise((resolve) => { closeGate.resolve = resolve; });
  const client = {
    request(request) {
      return request.operation === "coreClose" ? closeGate.promise : Promise.resolve({ revision: 1 });
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  const session = {
    ownerId: 7, slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: Number.MAX_SAFE_INTEGER,
  };
  registry.sessions.set("core-1", session);
  assert.throws(() => registry.status(7, "core-1"), (error) => error.code === "NATIVE_CORE_SESSION_BUSY");

  session.inFlight = 1;
  const closing = registry.closeOwner(7);
  assert.equal(session.state, "closing");
  assert.throws(() => registry.inspectSession(7, "core-1"), (error) => error.code === "NATIVE_CORE_SESSION_INVALID");
  closeGate.resolve({ closed: true });
  await closing;

  const throwingRegistry = new NativeCoreSessionRegistry({
    request() { throw new Error("synchronous host failure"); },
  });
  throwingRegistry.sessions.set("core-2", {
    ownerId: 8, slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  assert.throws(() => throwingRegistry.status(8, "core-2"), /synchronous host failure/);
  assert.equal(throwingRegistry.inspectSession(8, "core-2").inFlight, 0);
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
  assert.equal(registry.inspectSession(7, "core-import-1").registryFingerprint, "builtin:test");
  assert.equal(calls[0].sourcePath, sourcePath);
  assert.throws(() => registry.status(8, "core-import-1"), /not owned/);
  await registry.close(7, "core-import-1");
});

test("player authority prepare and activate are main-owned, capability-gated, and proof-free", async () => {
  const calls = [];
  const client = {
    hello: { capabilities: [NATIVE_PLAYER_AUTHORITY_GATE_CAPABILITY] },
    async request(request) {
      calls.push(request);
      return { lease: { phase: request.operation === "corePreparePlayerAuthority" ? "prepared" : "active" }, summary: {} };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  registry.sessions.set("core-1", {
    ownerId: "main-authority", slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  const expectedCheckpoint = { generation: 3, rootHash: "a".repeat(64), revision: 7 };

  await registry.preparePlayerAuthority("main-authority", {
    sessionId: "core-1",
    runId: "player-run-1",
    expectedCheckpoint,
    settledDeadlineMs: 10_000,
  });
  await registry.activatePlayerAuthority("main-authority", {
    sessionId: "core-1",
    runId: "player-run-1",
    expectedCheckpoint,
  });

  assert.deepEqual(calls, [
    {
      operation: "corePreparePlayerAuthority",
      sessionId: "core-1",
      request: { runId: "player-run-1", expectedCheckpoint, settledDeadlineMs: 10_000 },
    },
    {
      operation: "coreActivatePlayerAuthority",
      sessionId: "core-1",
      request: { runId: "player-run-1", expectedCheckpoint },
    },
  ]);
  assert.throws(() => registry.preparePlayerAuthority("renderer-owner", {
    sessionId: "core-1", runId: "player-run-1", expectedCheckpoint, settledDeadlineMs: 10_000,
  }), /not owned/);
  assert.throws(() => registry.preparePlayerAuthority("main-authority", {
    sessionId: "core-1", runId: "player-run-1", expectedCheckpoint, settledDeadlineMs: 10_000,
    proof: { revision: 7, canonicalSha256: "b".repeat(64), domainSha256: "c".repeat(64) },
  }), /invalid/);
  assert.throws(() => registry.activatePlayerAuthority("main-authority", {
    sessionId: "core-1", runId: "player-run-1", expectedCheckpoint: { ...expectedCheckpoint, rootHash: "not-a-hash" },
  }), /checkpoint is invalid/);

  const oldClient = { hello: { capabilities: [] }, async request() { throw new Error("must not call host"); } };
  const oldRegistry = new NativeCoreSessionRegistry(oldClient);
  oldRegistry.sessions.set("core-1", {
    ownerId: "main-authority", slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  assert.throws(() => oldRegistry.preparePlayerAuthority("main-authority", {
    sessionId: "core-1", runId: "player-run-1", expectedCheckpoint, settledDeadlineMs: 10_000,
  }), (error) => {
    assert.equal(error.code, "NATIVE_CORE_PLAYER_AUTHORITY_GATE_UNAVAILABLE");
    return true;
  });
});

test("player authority tick is main-owned, final-sequence-keyed, and rejects caller state proofs", async () => {
  const calls = [];
  const client = {
    hello: { capabilities: [NATIVE_PLAYER_AUTHORITY_TICK_CAPABILITY] },
    async request(request) {
      calls.push(request);
      return { sequence: request.request.sequence, revision: request.request.sequence, duplicate: false };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  registry.sessions.set("core-1", {
    ownerId: "main-authority", slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });

  await registry.commitPlayerAuthorityTick("main-authority", {
    sessionId: "core-1",
    runId: "player-run-1",
    sequence: 30,
  });
  assert.deepEqual(calls, [{
    operation: "coreCommitPlayerAuthorityTick",
    sessionId: "core-1",
    request: { runId: "player-run-1", sequence: 30 },
  }]);

  for (const field of ["baseRevision", "registryFingerprint", "proof", "checkpoint", "commandId"]) {
    assert.throws(() => registry.commitPlayerAuthorityTick("main-authority", {
      sessionId: "core-1", runId: "player-run-1", sequence: 9, [field]: "caller-controlled",
    }), /invalid/);
  }
  assert.throws(() => registry.commitPlayerAuthorityTick("renderer-owner", {
    sessionId: "core-1", runId: "player-run-1", sequence: 9,
  }), /not owned/);

  const oldClient = { hello: { capabilities: [] }, async request() { throw new Error("must not call host"); } };
  const oldRegistry = new NativeCoreSessionRegistry(oldClient);
  oldRegistry.sessions.set("core-1", {
    ownerId: "main-authority", slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  assert.throws(() => oldRegistry.commitPlayerAuthorityTick("main-authority", {
    sessionId: "core-1", runId: "player-run-1", sequence: 1,
  }), (error) => {
    assert.equal(error.code, "NATIVE_CORE_PLAYER_AUTHORITY_TICK_UNAVAILABLE");
    return true;
  });
});

test("player authority commands are capability-gated, main-owned, and exact-revision only", async () => {
  const calls = [];
  const client = {
    hello: { capabilities: [NATIVE_PLAYER_AUTHORITY_COMMAND_CAPABILITY] },
    async request(request) {
      calls.push(request);
      if (request.operation === "coreRecoverPlayerAuthorityCommand") return { duplicate: true };
      return { commandId: request.request.commandId, revision: request.request.baseRevision + 1 };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  registry.sessions.set("core-1", {
    ownerId: "main-player-authority", slot: "normal-main", ownerEpoch: 2, state: "owned", inFlight: 0,
  });
  const command = {
    protocolVersion: 1,
    baseRevision: 7,
    topLevelChanges: [{ path: ["playerCommandProbe"], operation: "set", value: 1 }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
  await registry.commitPlayerAuthorityCommand("main-player-authority", {
    sessionId: "core-1",
    runId: "player-run-1",
    commandId: "player-command-1",
    baseRevision: 7,
    command,
  });
  assert.deepEqual(calls, [{
    operation: "coreCommitPlayerAuthorityCommand",
    sessionId: "core-1",
    request: {
      runId: "player-run-1",
      commandId: "player-command-1",
      baseRevision: 7,
      command,
    },
  }]);
  assert.throws(() => registry.commitPlayerAuthorityCommand(7, {
    sessionId: "core-1", runId: "player-run-1", commandId: "player-command-1",
    baseRevision: 7, command,
  }), (error) => error.code === "NATIVE_CORE_SESSION_INVALID");
  assert.throws(() => registry.commitPlayerAuthorityCommand("main-player-authority", {
    sessionId: "core-1", runId: "player-run-1", commandId: "player-command-2",
    baseRevision: 8, command,
  }), /command revision is invalid/);
  assert.throws(() => registry.commitPlayerAuthorityCommand("main-player-authority", {
    sessionId: "core-1", runId: "player-run-1", commandId: "player-command-extra",
    baseRevision: 7, command: { ...command, rendererProof: true },
  }), /command patch is invalid/);
  await registry.recoverPlayerAuthorityCommand("main-player-authority", { sessionId: "core-1" });
  assert.deepEqual(calls.at(-1), {
    operation: "coreRecoverPlayerAuthorityCommand",
    sessionId: "core-1",
  });

  const rendererOwned = new NativeCoreSessionRegistry(client);
  rendererOwned.sessions.set("core-renderer", {
    ownerId: "renderer-7", slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  assert.throws(() => rendererOwned.commitPlayerAuthorityCommand("renderer-7", {
    sessionId: "core-renderer", runId: "player-run-1", commandId: "renderer-command",
    baseRevision: 7, command,
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_OWNER_REQUIRED");
  assert.throws(() => rendererOwned.recoverPlayerAuthorityCommand("renderer-7", {
    sessionId: "core-renderer",
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_OWNER_REQUIRED");

  const oldRegistry = new NativeCoreSessionRegistry({
    hello: { capabilities: [] },
    request() { throw new Error("must not call host"); },
  });
  oldRegistry.sessions.set("core-1", {
    ownerId: "main-player-authority", slot: "normal-main", ownerEpoch: 2, state: "owned", inFlight: 0,
  });
  assert.throws(() => oldRegistry.commitPlayerAuthorityCommand("main-player-authority", {
    sessionId: "core-1", runId: "player-run-1", commandId: "player-command-1",
    baseRevision: 7, command,
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_COMMAND_UNAVAILABLE");
});

test("system-space-station authority command derives exact intent identity before Host commit", async () => {
  const calls = [];
  const client = {
    hello: { capabilities: [NATIVE_PLAYER_AUTHORITY_SYSTEM_SPACE_STATION_COMMAND_CAPABILITY] },
    async request(request) {
      calls.push(request);
      return { commandId: request.request.commandId, revision: request.request.baseRevision + 1 };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  registry.sessions.set("core-1", {
    ownerId: "main-player-authority", slot: "normal-main", ownerEpoch: 2, state: "owned", inFlight: 0,
  });
  const intent = { type: "module-target", systemId: "helios", module: "energy", target: 3 };
  const identity = deriveSystemSpaceStationCommandIdentity({
    sessionId: "core-1",
    runId: "player-run-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "7df8cf3a",
    expectedSystemId: "helios",
    intent,
  });
  await registry.commitPlayerAuthoritySystemSpaceStationCommand("main-player-authority", {
    sessionId: "core-1",
    runId: "player-run-1",
    commandId: identity.commandId,
    baseRevision: 7,
    expectedRegistryFingerprint: "7df8cf3a",
    expectedSystemId: "helios",
    intent,
  });
  assert.deepEqual(calls, [{
    operation: "coreCommitPlayerAuthoritySystemSpaceStationCommand",
    sessionId: "core-1",
    request: {
      runId: "player-run-1",
      commandId: identity.commandId,
      baseRevision: 7,
      expectedRegistryFingerprint: "7df8cf3a",
      expectedSystemId: "helios",
      intent,
    },
  }]);
  assert.throws(() => registry.commitPlayerAuthoritySystemSpaceStationCommand(
    "main-player-authority",
    {
      sessionId: "core-1",
      runId: "player-run-1",
      commandId: identity.commandId,
      baseRevision: 7,
      expectedRegistryFingerprint: "7df8cf3a",
      expectedSystemId: "helios",
      intent: { ...intent, target: 4 },
    },
  ), /command ID conflicts/);
  assert.throws(() => registry.commitPlayerAuthoritySystemSpaceStationCommand(
    "main-player-authority",
    {
      sessionId: "core-1",
      runId: "player-run-1",
      commandId: identity.commandId,
      baseRevision: 7,
      expectedRegistryFingerprint: "7df8cf3a",
      expectedSystemId: "helios",
      intent,
      command: {},
    },
  ), /request is invalid/);
});

test("player pause lifecycle is capability-gated, main-owned, and carries an exact clock anchor", async () => {
  const calls = [];
  const client = {
    hello: { capabilities: [NATIVE_PLAYER_AUTHORITY_PAUSE_CAPABILITY] },
    async request(request) {
      calls.push(request);
      return { targetPaused: request.request.targetPaused };
    },
  };
  const registry = new NativeCoreSessionRegistry(client);
  registry.sessions.set("core-pause-1", {
    ownerId: "main-player-authority", slot: "normal-main", ownerEpoch: 1,
    state: "owned", inFlight: 0,
  });
  await registry.commitPlayerAuthorityPause("main-player-authority", {
    sessionId: "core-pause-1",
    runId: "player-run-pause-1",
    baseRevision: 17,
    targetPaused: true,
    settledDeadlineMs: 25_000,
  });
  assert.deepEqual(calls, [{
    operation: "coreCommitPlayerAuthorityPause",
    sessionId: "core-pause-1",
    request: {
      runId: "player-run-pause-1",
      baseRevision: 17,
      targetPaused: true,
      settledDeadlineMs: 25_000,
    },
  }]);
  assert.throws(() => registry.commitPlayerAuthorityPause("main-player-authority", {
    sessionId: "core-pause-1", runId: "player-run-pause-1", baseRevision: 18,
    targetPaused: false, settledDeadlineMs: 26_000, sequence: 9,
  }), /invalid/);

  const rendererOwned = new NativeCoreSessionRegistry(client);
  rendererOwned.sessions.set("core-renderer", {
    ownerId: "renderer-7", slot: "normal-main", ownerEpoch: 1, state: "owned", inFlight: 0,
  });
  assert.throws(() => rendererOwned.commitPlayerAuthorityPause("renderer-7", {
    sessionId: "core-renderer", runId: "player-run-pause-1", baseRevision: 17,
    targetPaused: true, settledDeadlineMs: 25_000,
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_OWNER_REQUIRED");

  const oldRegistry = new NativeCoreSessionRegistry({
    hello: { capabilities: [] },
    request() { throw new Error("must not call host"); },
  });
  oldRegistry.sessions.set("core-pause-1", {
    ownerId: "main-player-authority", slot: "normal-main", ownerEpoch: 1,
    state: "owned", inFlight: 0,
  });
  assert.throws(() => oldRegistry.commitPlayerAuthorityPause("main-player-authority", {
    sessionId: "core-pause-1", runId: "player-run-pause-1", baseRevision: 17,
    targetPaused: true, settledDeadlineMs: 25_000,
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_PAUSE_UNAVAILABLE");
});

test("startup recovery receipt is strictly adopted once as a main-owned Rust session", () => {
  const receipt = {
    schemaVersion: 1,
    kind: NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
    ownerId: "main-player-authority",
    sessionId: "core-restarted-1",
    runId: "player-run-1",
    registryFingerprint: "builtin:test",
    revision: 11,
    entryCheckpoint: { generation: 3, rootHash: "e".repeat(64), revision: 7 },
    checkpoint: { generation: 8, rootHash: "a".repeat(64), revision: 11 },
    acknowledgedSequence: 30,
    nextSequence: 31,
    settledDeadlineMs: 40_000,
    nextDeadlineMs: 41_000,
    commandId: null,
    commandBaseRevision: null,
    changedEntityIds: [],
    changedBeltIds: [],
    topologyDirty: false,
    paused: false,
    summary: {
      revision: 11,
      stateVersion: 47,
      mode: "normal",
      paused: false,
      registryFingerprint: "builtin:test",
      canonicalSha256: "b".repeat(64),
      domainSha256: "c".repeat(64),
      coverage: { authorityEligible: true },
    },
  };
  const registry = new NativeCoreSessionRegistry({
    hello: {
      capabilities: [NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY],
      playerAuthorityStartupRecovery: receipt,
    },
    request() { throw new Error("startup adoption must not call the Host"); },
  });
  const owned = registry.inspectSession("main-player-authority", "core-restarted-1");
  assert.equal(owned.slot, "normal-main");
  assert.equal(owned.registryFingerprint, "builtin:test");
  assert.equal(owned.ownerEpoch, 1);
  assert.equal(owned.inFlight, 0);
  assert.throws(
    () => registry.inspectSession("renderer-7", "core-restarted-1"),
    (error) => error.code === "NATIVE_CORE_SESSION_INVALID",
  );
  assert.throws(
    () => registry.commitPlayerAuthorityTick("renderer-7", {
      sessionId: "core-restarted-1",
      runId: "player-run-1",
      sequence: 5,
    }),
    (error) => error.code === "NATIVE_CORE_SESSION_INVALID",
  );
  const commandReceipt = {
    ...receipt,
    sessionId: "core-restarted-command",
    commandId: "durable-command-4",
    commandBaseRevision: 10,
    changedEntityIds: ["entity-a", "entity-z"],
    changedBeltIds: ["belt-a"],
    topologyDirty: false,
  };
  const commandRegistry = new NativeCoreSessionRegistry({
    hello: {
      capabilities: [NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY],
      playerAuthorityStartupRecovery: commandReceipt,
    },
    request() { throw new Error("command startup adoption must not call the Host"); },
  });
  const adoptedCommand = commandRegistry.takePlayerAuthorityStartupRecovery(
    "main-player-authority",
  );
  assert.deepEqual(adoptedCommand.changedEntityIds, ["entity-a", "entity-z"]);
  assert.deepEqual(adoptedCommand.changedBeltIds, ["belt-a"]);
  assert.equal(adoptedCommand.topologyDirty, false);
  const pausedReceipt = {
    ...receipt,
    sessionId: "core-restarted-paused",
    paused: true,
    summary: { ...receipt.summary, paused: true },
  };
  const pausedRegistry = new NativeCoreSessionRegistry({
    hello: {
      capabilities: [NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY],
      playerAuthorityStartupRecovery: pausedReceipt,
    },
    request() { throw new Error("paused startup adoption must not call the Host"); },
  });
  assert.equal(
    pausedRegistry.takePlayerAuthorityStartupRecovery("main-player-authority").paused,
    true,
  );
  assert.throws(() => new NativeCoreSessionRegistry({
    hello: {
      capabilities: [NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY],
      playerAuthorityStartupRecovery: {
        ...pausedReceipt,
        summary: { ...pausedReceipt.summary, paused: false },
      },
    },
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
  assert.throws(() => new NativeCoreSessionRegistry({
    hello: {
      capabilities: [NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY],
      playerAuthorityStartupRecovery: {
        ...commandReceipt,
        changedEntityIds: ["entity-z", "entity-a"],
      },
    },
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");

  const cleanupReceipt = {
    ...receipt,
    sessionId: "core-restarted-finished-macro",
    pendingMacroCleanupSessionId: "macro-session-finished",
    pendingMacroCleanupRevision: 9,
  };
  const cleanupRegistry = new NativeCoreSessionRegistry({
    hello: {
      capabilities: [NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY],
      playerAuthorityStartupRecovery: cleanupReceipt,
    },
    request() { throw new Error("finished macro cleanup adoption must not call the Host"); },
  });
  const adoptedCleanup = cleanupRegistry.takePlayerAuthorityStartupRecovery(
    "main-player-authority",
  );
  assert.equal(adoptedCleanup.sessionId, "core-restarted-finished-macro");
  assert.equal(adoptedCleanup.runId, "player-run-1");
  assert.equal(adoptedCleanup.revision, 11);
  assert.equal(adoptedCleanup.pendingMacroCleanupSessionId, "macro-session-finished");
  assert.equal(adoptedCleanup.pendingMacroCleanupRevision, 9);
  for (const invalidCleanup of [
    { pendingMacroCleanupSessionId: "macro-session-finished" },
    { pendingMacroCleanupRevision: 9 },
    {
      pendingMacroCleanupSessionId: "macro-session-finished",
      pendingMacroCleanupRevision: 12,
    },
    {
      pendingMacroCleanupSessionId: "macro-session-finished",
      pendingMacroCleanupRevision: 6,
    },
  ]) {
    assert.throws(() => new NativeCoreSessionRegistry({
      hello: {
        capabilities: [NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY],
        playerAuthorityStartupRecovery: {
          ...receipt,
          sessionId: "core-restarted-invalid-cleanup",
          ...invalidCleanup,
        },
      },
    }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
  }
  assert.throws(() => new NativeCoreSessionRegistry({
    hello: {
      capabilities: [
        NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY,
        NATIVE_PLAYER_AUTHORITY_MACRO_ADVANCE_CAPABILITY,
      ],
      playerAuthorityStartupRecovery: {
        ...cleanupReceipt,
        sessionId: "core-restarted-cleanup-and-active-macro",
        macroSessionId: "macro-session-active",
        recoveredMacroOperationId: "macro-operation-active",
        macroAlgorithmVersion: "pure-idle-macro-v10",
        macroSimulationMilliseconds: 60_000,
        macroWallMilliseconds: 4_000,
      },
    },
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
  receipt.summary.revision = 999;
  const adopted = registry.takePlayerAuthorityStartupRecovery("main-player-authority");
  assert.equal(adopted.summary.revision, 11);
  assert.equal(adopted.acknowledgedSequence, 30);
  assert.equal(adopted.nextSequence, 31);
  assert.equal(adopted.nextDeadlineMs, 41_000);
  assert.deepEqual(adopted.entryCheckpoint, {
    generation: 3,
    rootHash: "e".repeat(64),
    revision: 7,
  });
  assert.equal(registry.takePlayerAuthorityStartupRecovery("main-player-authority"), null);

  const initialReceipt = {
    ...receipt,
    sessionId: "core-restarted-initial",
    revision: 0,
    entryCheckpoint: { ...receipt.entryCheckpoint, revision: 0 },
    checkpoint: { ...receipt.checkpoint, revision: 0 },
    acknowledgedSequence: 0,
    nextSequence: 1,
    summary: { ...receipt.summary, revision: 0 },
  };
  const initialRegistry = new NativeCoreSessionRegistry({
    hello: {
      capabilities: [NATIVE_PLAYER_AUTHORITY_STARTUP_RECOVERY_CAPABILITY],
      playerAuthorityStartupRecovery: initialReceipt,
    },
    request() { throw new Error("initial startup adoption must not call the Host"); },
  });
  assert.equal(
    initialRegistry.takePlayerAuthorityStartupRecovery("main-player-authority").nextSequence,
    1,
  );

  assert.throws(() => new NativeCoreSessionRegistry({
    hello: { capabilities: [], playerAuthorityStartupRecovery: receipt },
  }), (error) => error.code === "NATIVE_CORE_PLAYER_AUTHORITY_STARTUP_RECOVERY_INVALID");
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
  installMockHostExit(child);
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

test("structured profile request is bound to its response frame and ignores late stderr records", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  installMockHostExit(child);
  child.stdin.on("data", (chunk) => {
    const requestFrame = parseFrames(Buffer.from(chunk)).frames[0];
    const request = JSON.parse(requestFrame.payload.toString("utf8"));
    let value = request.operation === "hello"
      ? { protocolVersion: 1, nativeFormatVersion: 1, hostVersion: "test", capabilities: [] }
      : { stopped: true };
    if (request.operation === "coreAdvance") {
      const operationBinding = {
        protocol: "native-core-advance-profile-v1",
        requestId: requestFrame.requestId,
        sessionIdSha256: createHash("sha256").update(request.sessionId, "utf8").digest("hex"),
        baseRevision: request.request.baseRevision,
        expectedMeasuredRevision: 12,
        profilePurpose: request.profilePurpose,
      };
      const record = request.profilePurpose === "quantum-oactive-shape-v1"
        ? {
            schemaVersion: 2,
            recordType: "quantum-oactive-shape",
            instrumentationVersion: "quantum-oactive-profile-v1",
            workScope: "shape-proxy-only-not-time-or-speedup",
            activeScanCalls: 84,
            networkParseSelectedRows: 12,
            networkParseTotalRows: 120,
            networkWriteDirtyRows: 12,
            networkWriteTotalRows: 120,
            zeroNormalizationRows: 2,
            linearOrderRows: 12,
            fullSortRows: 0,
            sortComparisons: 0,
            perItemFanout: [],
            operationBinding,
          }
        : {
            schemaVersion: 2,
            recordType: "local-dispatch-timing",
            instrumentationVersion: "local-dispatch-profile-v3",
            measurementScope: "production-dispatch-only-observer-excluded",
            stageDurationNs: 100,
            operationBinding,
          };
      const records = request.sessionId === "session-response-duplicate"
        ? [record, record]
        : [record];
      value = {
        supported: true,
        revision: 12,
        ...(request.sessionId === "session-response-missing" ? {} : { profileEvidence: {
          protocol: "native-core-advance-profile-response-v1",
          requestId: requestFrame.requestId,
          overflowed: request.sessionId === "session-response-overflow",
          records,
        } }),
      };
      setTimeout(() => child.stderr.write(`DSP_NATIVE_CORE_PROFILE_RECORD\t${JSON.stringify(record)}\n`), 20);
    }
    child.stdout.write(encodeFrame({
      requestId: requestFrame.requestId,
      kind: CONTROL_RESPONSE_KIND,
      payload: Buffer.from(JSON.stringify({ ok: true, value }), "utf8"),
    }));
  });
  const client = new NativeHostClient({
    binaryPath: process.platform === "win32" ? "C:\\test\\dsp-native-host.exe" : "/test/dsp-native-host",
    rootPath: process.platform === "win32" ? "C:\\test\\native-data" : "/test/native-data",
    spawnProcess: () => child,
  });
  await client.start("test");
  const result = await client.requestWithStructuredProfileEvidence({
    operation: "coreAdvance",
    profilePurpose: "local-dispatch-timing-v1",
    sessionId: "session-delayed-duplicate",
    request: { baseRevision: 11, simulationSeconds: 1, wallSeconds: 1, includeDiagnostics: false },
  });
  assert.equal(result.value.revision, 12);
  assert.equal(Object.hasOwn(result.value, "profileEvidence"), false);
  assert.equal(result.operationBinding.requestId, 2);
  assert.equal(result.operationBinding.baseRevision, 11);
  assert.equal(result.operationBinding.measuredRevision, 12);
  assert.equal(result.profileChannel.responseBound, true);
  assert.equal(result.profileChannel.quiescent, true);
  assert.equal(result.profileChannel.timedOut, false);
  assert.equal(result.profileChannel.records.length, 1);
  assert.ok(result.operationDurationNs > 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(result.profileChannel.records.length, 1);

  const quantum = await client.requestWithStructuredProfileEvidence({
    operation: "coreAdvance",
    profilePurpose: "quantum-oactive-shape-v1",
    sessionId: "session-quantum-response-bound",
    request: { baseRevision: 11, simulationSeconds: 60, wallSeconds: 60, includeDiagnostics: false },
  });
  assert.equal(quantum.value.revision, 12);
  assert.equal(quantum.operationBinding.profilePurpose, "quantum-oactive-shape-v1");
  assert.equal(quantum.profileChannel.responseBound, true);
  assert.equal(quantum.profileChannel.records.length, 1);
  assert.equal(quantum.profileChannel.records[0].record.recordType, "quantum-oactive-shape");

  for (const [sessionId, expected] of [
    ["session-response-missing", { responseBound: false, malformedCount: 1, dropped: false, records: 0 }],
    ["session-response-overflow", { responseBound: true, malformedCount: 0, dropped: true, records: 1 }],
    ["session-response-duplicate", { responseBound: true, malformedCount: 0, dropped: false, records: 2 }],
  ]) {
    const invalid = await client.requestWithStructuredProfileEvidence({
      operation: "coreAdvance",
      profilePurpose: "local-dispatch-timing-v1",
      sessionId,
      request: { baseRevision: 11, simulationSeconds: 1, wallSeconds: 1, includeDiagnostics: false },
    });
    assert.equal(invalid.profileChannel.responseBound, expected.responseBound);
    assert.equal(invalid.profileChannel.malformedCount, expected.malformedCount);
    assert.equal(invalid.profileChannel.dropped, expected.dropped);
    assert.equal(invalid.profileChannel.records.length, expected.records);
  }
  await client.stop();
});
