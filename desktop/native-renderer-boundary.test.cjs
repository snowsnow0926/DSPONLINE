"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  CORE_COVERAGE_KEYS,
  createRendererNativeError,
  createRendererNativeRejection,
  normalizeRendererNativeResult,
  rendererNativeErrorCode,
  serializeRendererNativeError,
} = require("./native-renderer-boundary.cjs");

const SECRET_PATH = "C:\\Users\\Player\\Documents\\private-save.json";
const SECRET_BODY = '{"state":{"token":"private-save-body"}}';
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function performancePolicy() {
  return {
    schemaVersion: 1,
    requestedPolicy: { mode: "balanced" },
    effectivePolicy: { mode: "balanced", threadSetting: "auto" },
    logicalCpuCount: 16,
    restartRequired: false,
    configurationState: "loaded",
  };
}

function coreSummary(revision = 2) {
  return {
    revision,
    stateVersion: 47,
    mode: "normal",
    activePlanetId: "planet-1",
    elapsedSeconds: 30,
    paused: false,
    entityCount: 1,
    beltCount: 1,
    canonicalSha256: SHA_A,
    canonicalComponents: { base: SHA_A, entities: SHA_B, belts: SHA_C },
    canonicalFields: { base: SHA_A, entities: SHA_B, belts: SHA_C },
    domainSha256: SHA_B,
    catalogSha256: SHA_C,
    registryFingerprint: "builtin:test",
    memory: {
      rawRecordBytes: 1,
      indexedStringBytes: 2,
      inventoryEntryCount: 3,
      topologyIndexBytes: 4,
      estimatedRuntimeBytes: 10,
    },
    coverage: Object.fromEntries(CORE_COVERAGE_KEYS.map((key) => [key, true])),
  };
}

function saveCommit(revision = 2) {
  return {
    slot: "normal-main",
    generation: 1,
    revision,
    rootHash: SHA_A,
    recordCount: 3,
    changedRecords: 3,
    changedBytes: 128,
    totalUncompressedBytes: 256,
    walMaintenancePending: false,
    walBytes: 0,
  };
}

function projectionContext(baseFields = ["paused"]) {
  return { baseFields, entityIds: ["entity-1"], beltIds: ["belt-1"] };
}

function viewportContext(overrides = {}) {
  return {
    baseFields: ["paused"],
    planetId: "home",
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    entityCursor: 0,
    entityLimit: 2,
    beltLimit: 2,
    ...overrides,
  };
}

function statisticsContext(overrides = {}) {
  return {
    minElapsedSeconds: 0,
    maxElapsedSeconds: 10,
    cursor: 0,
    limit: 2,
    planetId: "home",
    itemId: "iron_ore",
    ...overrides,
  };
}

function productionHistorySample() {
  return {
    elapsedSeconds: 10,
    sampleDurationSeconds: 10,
    productionPerMinute: { iron_ore: 60, state: 1 },
    consumptionPerMinute: { coal: 12, body: 2 },
    planetProductionPerMinute: { home: { iron_ore: 60 } },
    planetConsumptionPerMinute: { home: { coal: 12 } },
    inventory: { iron_ore: 100, body: 3 },
    generationKw: 1_000,
    demandKw: 800,
    machineEfficiency: 0.9,
    logisticsEfficiency: 0.8,
    powerEfficiency: 1,
    activeMachines: 2,
    blockedMachines: 0,
  };
}

test("renderer native errors preserve only bounded symbolic codes", () => {
  const raw = Object.assign(new Error(`open ${SECRET_PATH} failed: ${SECRET_BODY}`), {
    code: "NATIVE_V47_IMPORT_JS_COMPATIBILITY_REQUIRED",
    stack: `Error: ${SECRET_BODY}\n    at ${SECRET_PATH}:1:1`,
  });
  const safe = createRendererNativeError(raw, {
    fallbackCode: "NATIVE_CORE_V47_IMPORT_FAILED",
    message: "原生 v47 存档导入失败",
  });

  assert.equal(safe.name, "NativeHostError");
  assert.equal(safe.code, "NATIVE_V47_IMPORT_JS_COMPATIBILITY_REQUIRED");
  assert.match(safe.message, /NATIVE_V47_IMPORT_JS_COMPATIBILITY_REQUIRED/);
  assert.doesNotMatch(safe.message, /private-save|Player|token/);
  assert.equal(Object.hasOwn(safe, "stack"), true);
  assert.doesNotMatch(safe.stack, /private-save-body|private-save\.json/);
  assert.doesNotMatch(safe.stack, /[A-Z]:\\|native-renderer-boundary\.cjs/);
});

test("malformed Host codes cannot smuggle stderr or paths", () => {
  const raw = Object.assign(new Error(SECRET_BODY), {
    code: `NATIVE_HOST_EXITED\n${SECRET_PATH}`,
  });
  assert.equal(rendererNativeErrorCode(raw, "NATIVE_HOST_START_FAILED"), "NATIVE_HOST_START_FAILED");
  assert.deepEqual(serializeRendererNativeError(raw, {
    fallbackCode: "NATIVE_CORE_PROJECTION_FAILED",
    message: "原生投影请求失败，请重试",
  }), {
    name: "NativeHostError",
    message: "原生投影请求失败，请重试（NATIVE_CORE_PROJECTION_FAILED）",
    code: "NATIVE_CORE_PROJECTION_FAILED",
  });
});

test("syntactically valid but unpublished Host codes also fall back", () => {
  const raw = Object.assign(new Error(SECRET_BODY), {
    code: "NATIVE_C_USERS_PLAYER_PRIVATE_SAVE_JSON",
  });
  assert.equal(rendererNativeErrorCode(raw, "NATIVE_HOST_START_FAILED"), "NATIVE_HOST_START_FAILED");
});

test("Electron invoke rejection is reconstructed from only a published suffix", () => {
  const safe = createRendererNativeRejection(new Error(
    `Error invoking remote method: open ${SECRET_PATH}: ${SECRET_BODY}（NATIVE_CORE_STATUS_FAILED）`,
  ), {
    fallbackCode: "NATIVE_OPERATION_FAILED",
    message: "原生操作失败，请重试",
  });
  assert.equal(safe.code, "NATIVE_CORE_STATUS_FAILED");
  assert.equal(safe.message, "原生操作失败，请重试（NATIVE_CORE_STATUS_FAILED）");
  assert.doesNotMatch(safe.stack, /Player|private-save|token|remote method/);

  const unknown = createRendererNativeRejection(new Error(
    `Error invoking remote method: ${SECRET_PATH}（NATIVE_C_USERS_PLAYER_PRIVATE_SAVE_JSON）`,
  ), {
    fallbackCode: "NATIVE_OPERATION_FAILED",
    message: "原生操作失败，请重试",
  });
  assert.equal(unknown.code, "NATIVE_OPERATION_FAILED");
});

test("AbortError identity remains public without its private message", () => {
  const raw = Object.assign(new Error(`${SECRET_PATH}: renderer disappeared`), {
    name: "AbortError",
    code: "NATIVE_CORE_V47_IMPORT_CANCELLED",
  });
  const safe = serializeRendererNativeError(raw, {
    fallbackCode: "NATIVE_CORE_V47_IMPORT_FAILED",
    message: "原生 v47 存档导入失败",
  });
  assert.equal(safe.name, "AbortError");
  assert.equal(safe.code, "NATIVE_CORE_V47_IMPORT_CANCELLED");
  assert.doesNotMatch(safe.message, /Player|renderer disappeared/);
});

test("startup status publishes only stable fields and drops internal lease diagnostics", () => {
  const status = normalizeRendererNativeResult("nativeStatus", {
    available: false,
    state: "unavailable",
    message: "Windows 原生性能服务启动失败；已完成本地权威租约安全检查",
    errorCode: "NATIVE_HOST_START_FAILED",
    capabilities: [],
    exactRealtime: {
      message: `lease failed at ${SECRET_PATH}`,
      stderr: SECRET_BODY,
    },
    performancePolicy: performancePolicy(),
  });
  assert.deepEqual(Object.keys(status).sort(), [
    "available", "capabilities", "errorCode", "message", "performancePolicy", "state",
  ]);
  assert.equal(Object.hasOwn(status, "exactRealtime"), false);
  assert.doesNotMatch(JSON.stringify(status), /Player|private-save|token|stderr/);
  assert.throws(() => normalizeRendererNativeResult("nativeStatus", {
    available: false,
    state: "unavailable",
    message: "Windows 原生性能服务不可用",
    capabilities: [],
    stderr: SECRET_BODY,
  }), /native renderer status is invalid/);
});

test("v47 import and export receipts use exact Host key sets", () => {
  const imported = {
    sessionId: "core-7",
    authority: "shadow",
    checkpoint: saveCommit(2),
    import: {
      formatVersion: 2,
      stateVersion: 47,
      kind: "primary",
      envelopeSlot: "main",
      mode: "normal",
      savedAtMs: 1_000,
      stateChecksum: "1234abcd",
      sourceSha256: SHA_C,
      sourceByteLength: 1024,
      entityCount: 1,
      beltCount: 1,
    },
    summary: coreSummary(2),
  };
  const normalizedImport = normalizeRendererNativeResult("coreImport", imported);
  assert.deepEqual(Object.keys(normalizedImport), ["sessionId", "authority", "checkpoint", "import", "summary"]);
  assert.notEqual(normalizedImport, imported);
  assert.throws(() => normalizeRendererNativeResult("coreImport", {
    ...imported,
    sourcePath: SECRET_PATH,
  }), /native v47 import result is invalid/);
  assert.throws(() => normalizeRendererNativeResult("coreImport", {
    ...imported,
    checkpoint: { ...imported.checkpoint, stderr: SECRET_BODY },
  }), /native save commit result is invalid/);

  const exported = {
    exportId: "export-7",
    mode: "normal",
    result: {
      revision: 2,
      savedAtMs: 1_000,
      byteLength: 2048,
      envelopeSha256: SHA_B,
      stateChecksum: "1234abcd",
    },
  };
  assert.deepEqual(Object.keys(normalizeRendererNativeResult("coreExport", exported)), ["exportId", "mode", "result"]);
  assert.throws(() => normalizeRendererNativeResult("coreExport", {
    ...exported,
    sourcePath: SECRET_PATH,
  }), /native core v47 export result is invalid/);
  assert.throws(() => normalizeRendererNativeResult("coreExport", {
    ...exported,
    result: { ...exported.result, hostStderr: SECRET_BODY },
  }), /native v47 export proof is invalid/);
});

test("save/open/advance/checkpoint/compare receipts fail closed on Host-only fields", () => {
  assert.deepEqual(normalizeRendererNativeResult("saveRead", {
    slot: "normal-main",
    generation: 1,
    rootHash: SHA_A,
    key: "模组区块:$metadata",
    value: "{}",
  }).key, "模组区块:$metadata");
  assert.throws(() => normalizeRendererNativeResult("saveRead", {
    slot: "normal-main",
    generation: 1,
    rootHash: SHA_A,
    key: "../private-save.json",
    value: "{}",
  }), /native read key is invalid/);

  const opened = {
    sessionId: "core-7",
    authority: "shadow",
    checkpointRevision: 2,
    replayedWalEntries: 0,
    replayedRevision: 2,
    summary: coreSummary(2),
  };
  assert.deepEqual(Object.keys(normalizeRendererNativeResult("coreOpen", opened)), [
    "sessionId", "authority", "checkpointRevision", "replayedWalEntries", "replayedRevision", "summary",
  ]);
  assert.throws(() => normalizeRendererNativeResult("coreOpen", { ...opened, hostPath: SECRET_PATH }), /native core open result is invalid/);

  const advanced = normalizeRendererNativeResult("coreAdvance", {
    supported: true,
    exactScope: "pure-idle-conservative-v2",
    changed: true,
    previousRevision: 1,
    revision: 2,
    reason: `internal settlement failed at ${SECRET_PATH}: ${SECRET_BODY}`,
    algorithmVersion: "native-pure-idle-conservative-v4",
    exactCalibrationSeconds: 30,
    approximatedSeconds: 3_570,
  });
  assert.equal(advanced.reason, "native-domain-unavailable");
  assert.doesNotMatch(JSON.stringify(advanced), /Player|private-save|token/);

  const checkpoint = {
    checkpoint: saveCommit(2),
    summary: coreSummary(2),
    encodedRecords: 3,
    reusedRecords: 0,
  };
  assert.deepEqual(Object.keys(normalizeRendererNativeResult("coreCheckpoint", checkpoint)), [
    "checkpoint", "summary", "encodedRecords", "reusedRecords",
  ]);
  assert.throws(() => normalizeRendererNativeResult("coreCheckpoint", { ...checkpoint, stderr: SECRET_BODY }), /native core checkpoint result is invalid/);

  const compared = {
    matches: true,
    revisionMatches: true,
    canonicalMatches: true,
    domainMatches: true,
    promotionBlocked: true,
    summary: coreSummary(2),
  };
  assert.deepEqual(Object.keys(normalizeRendererNativeResult("coreCompare", compared)), [
    "matches", "revisionMatches", "canonicalMatches", "domainMatches", "promotionBlocked", "summary",
  ]);
  assert.throws(() => normalizeRendererNativeResult("coreCompare", { ...compared, stderr: SECRET_BODY }), /native core comparison result is invalid/);
});

test("projection receipts are request-bound, cloned, and reject nested Host diagnostics", () => {
  const entity = {
    id: "entity-1",
    kind: "station",
    planetId: "home",
    position: { x: 1, y: 2 },
    interactionLocked: false,
    stationRoutes: [{ id: "route-1", slotIndex: 0, peerId: "peer-1", itemId: "iron_ore", scope: "local", cargo: 1, vehicleCount: 1, progress: 0, duration: 1, requiresWarp: false }],
    routingCursor: 0,
    machineCount: 1,
    minerCount: 0,
    inputs: { state: 1 },
    outputs: { body: 2 },
    progress: 0,
    utilization: 1,
    productionRate: 0,
  };
  const belt = {
    id: "belt-1", planetId: "home", source: "entity-1", target: "entity-2", itemId: "iron_ore",
    lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1, lastFlow: 0,
  };
  const raw = { revision: 2, base: { paused: false }, entities: [entity], belts: [belt] };
  const normalized = normalizeRendererNativeResult("coreProjection", raw, projectionContext());
  assert.deepEqual(normalized, raw);
  assert.notEqual(normalized.base, raw.base);
  assert.notEqual(normalized.entities[0], raw.entities[0]);
  assert.notEqual(normalized.entities[0].stationRoutes, raw.entities[0].stationRoutes);
  assert.deepEqual(normalized.entities[0].inputs, { state: 1 });
  assert.deepEqual(normalized.entities[0].outputs, { body: 2 });

  const rejectsProtocol = (value, context = projectionContext()) => assert.throws(
    () => normalizeRendererNativeResult("coreProjection", value, context),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejectsProtocol({ ...raw, base: { paused: false, elapsedSeconds: 10 } });
  rejectsProtocol({ ...raw, base: { paused: { entities: [], belts: [] } } });
  rejectsProtocol({ ...raw, entities: [{ ...entity, sourcePath: SECRET_PATH }] });
  rejectsProtocol({ ...raw, entities: [{ ...entity, stationRoutes: [{ ...entity.stationRoutes[0], stderr: SECRET_BODY }] }] });
  rejectsProtocol({ ...raw, entities: [{ ...entity, inputs: { state: { path: SECRET_PATH } } }] });
  rejectsProtocol({ ...raw, belts: [{ ...belt, congestion: { rawBody: SECRET_BODY } }] });
  rejectsProtocol(raw, { baseFields: ["entities"], entityIds: ["entity-1"], beltIds: ["belt-1"] });
  rejectsProtocol(raw, { baseFields: ["paused"], entityIds: ["other-entity"], beltIds: ["belt-1"] });
});

test("viewport and statistics projections use bounded formal schemas", () => {
  const viewport = {
    schemaVersion: 1,
    projectionType: "viewport-v1",
    revision: 2,
    planetId: "home",
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    base: { paused: false },
    entities: [{ id: "entity-1", kind: "vein", planetId: "home", position: { x: 1, y: 2 }, interactionLocked: false, routingCursor: 0, machineCount: 0, minerCount: 1, inputs: { state: 1 }, outputs: { body: 2 }, progress: 0, utilization: 1, productionRate: 1 }],
    belts: [],
    nextEntityCursor: null,
    truncatedBelts: false,
  };
  assert.doesNotThrow(() => normalizeRendererNativeResult("coreViewportProjection", viewport, viewportContext()));
  assert.throws(() => normalizeRendererNativeResult("coreViewportProjection", {
    ...viewport,
    entities: [{ ...viewport.entities[0], outputs: { iron_ore: { filePath: SECRET_PATH } } }],
  }, viewportContext()), (error) => error?.code === "NATIVE_PROTOCOL_INVALID");

  const rejectsViewport = (value, context = viewportContext()) => assert.throws(
    () => normalizeRendererNativeResult("coreViewportProjection", value, context),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejectsViewport({ ...viewport, planetId: "other" });
  rejectsViewport({ ...viewport, bounds: { ...viewport.bounds, maxX: 11 } });
  rejectsViewport({ ...viewport, entities: [...viewport.entities, { ...viewport.entities[0], id: "entity-2" }] }, viewportContext({ entityLimit: 1 }));
  rejectsViewport({ ...viewport, entities: [{ ...viewport.entities[0], planetId: "other" }] });
  rejectsViewport({ ...viewport, entities: [{ ...viewport.entities[0], position: { x: 11, y: 2 } }] });
  rejectsViewport({ ...viewport, entities: [{ ...viewport.entities[0], position: { x: 1, y: 2, path: SECRET_PATH } }] });
  rejectsViewport({ ...viewport, belts: [{ id: "belt-1", planetId: "other", source: "entity-1", target: "entity-2", itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1 }] });
  rejectsViewport({ ...viewport, belts: [{ id: "belt-1", planetId: "home", source: "entity-1", target: "entity-2", itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1 }] }, viewportContext({ beltLimit: 0 }));
  rejectsViewport({ ...viewport, nextEntityCursor: 9 }, viewportContext({ entityCursor: 3 }));

  const statistics = {
    schemaVersion: 1,
    projectionType: "statistics-v1",
    revision: 2,
    window: { minElapsedSeconds: 0, maxElapsedSeconds: 10 },
    filters: { planetId: "home", itemId: "iron_ore" },
    samples: [productionHistorySample()],
    nextCursor: null,
  };
  const normalized = normalizeRendererNativeResult("coreStatisticsProjection", statistics, statisticsContext());
  assert.deepEqual(normalized, statistics);
  assert.notEqual(normalized.samples[0], statistics.samples[0]);
  assert.equal(normalized.samples[0].productionPerMinute.state, 1);
  assert.equal(normalized.samples[0].inventory.body, 3);
  assert.throws(() => normalizeRendererNativeResult("coreStatisticsProjection", {
    ...statistics,
    samples: [{ ...productionHistorySample(), stderr: SECRET_BODY }],
  }, statisticsContext()), (error) => error?.code === "NATIVE_PROTOCOL_INVALID");
  assert.throws(() => normalizeRendererNativeResult("coreStatisticsProjection", {
    ...statistics,
    samples: [{ ...productionHistorySample(), productionPerMinute: { iron_ore: "60" } }],
  }, statisticsContext()), (error) => error?.code === "NATIVE_PROTOCOL_INVALID");
  assert.throws(() => normalizeRendererNativeResult("coreStatisticsProjection", {
    ...statistics,
    samples: [{ ...productionHistorySample(), planetProductionPerMinute: { home: { state: { path: SECRET_PATH } } } }],
  }, statisticsContext()), (error) => error?.code === "NATIVE_PROTOCOL_INVALID");

  const rejectsStatistics = (value, context = statisticsContext()) => assert.throws(
    () => normalizeRendererNativeResult("coreStatisticsProjection", value, context),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejectsStatistics({ ...statistics, window: { minElapsedSeconds: 0, maxElapsedSeconds: 11 } });
  rejectsStatistics({ ...statistics, filters: { planetId: "other", itemId: "iron_ore" } });
  rejectsStatistics({ ...statistics, filters: { planetId: "home", itemId: null } });
  rejectsStatistics({ ...statistics, samples: [productionHistorySample(), productionHistorySample()] }, statisticsContext({ limit: 1 }));
  rejectsStatistics({ ...statistics, samples: [{ ...productionHistorySample(), elapsedSeconds: 11 }] });
  rejectsStatistics({ ...statistics, nextCursor: 9 }, statisticsContext({ cursor: 3 }));
});

test("Electron main uses the dedicated native renderer boundary", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  assert.match(source, /errorCode: rendererNativeErrorCode\(error, "NATIVE_HOST_START_FAILED"\)/);
  assert.doesNotMatch(source, /Windows 原生性能服务启动失败：\$\{error/);
  assert.match(source, /desktop:native-core-import-v47[\s\S]*?createRendererNativeError\(error,[\s\S]*?NATIVE_CORE_V47_IMPORT_FAILED/);
  assert.match(source, /desktop:native-core-export-v47[\s\S]*?createRendererNativeError\(error,[\s\S]*?NATIVE_CORE_V47_EXPORT_FAILED/);
  assert.match(source, /desktop:native-core-projection-transfer[\s\S]*?\.catch\(\(error\) => postNativeProjectionTransferError\(port, error\)\)/);
  assert.doesNotMatch(source, /desktop:native-core-projection-transfer[\s\S]*?\.catch\(\(error\) => postTransferError\(port, error\)\)/);
  assert.match(source, /function nativeViewportProjectionResultContext[\s\S]*?planetId:\s*request\?\.planetId[\s\S]*?bounds:\s*request\?\.bounds[\s\S]*?entityCursor:[\s\S]*?entityLimit:[\s\S]*?beltLimit:/);
  assert.match(source, /function nativeStatisticsProjectionResultContext[\s\S]*?minElapsedSeconds:[\s\S]*?maxElapsedSeconds:[\s\S]*?cursor:[\s\S]*?limit:[\s\S]*?planetId:[\s\S]*?itemId:/);
  assert.match(source, /desktop:native-core-projection"[\s\S]*?resultContext:\s*nativeCoreProjectionResultContext\(request\)/);
  assert.match(source, /desktop:native-core-viewport-projection"[\s\S]*?resultContext:\s*nativeViewportProjectionResultContext\(request\)/);
  assert.match(source, /desktop:native-core-statistics-projection"[\s\S]*?resultContext:\s*nativeStatisticsProjectionResultContext\(request\)/);
  assert.match(source, /desktop:native-core-projection-transfer[\s\S]*?nativeViewportProjectionResultContext\(request\.payload\)[\s\S]*?nativeStatisticsProjectionResultContext\(request\.payload\)/);
  assert.match(source, /desktop:native-core-status[\s\S]*?runRendererNativeOperation\("coreSummary"/);
  assert.match(preload, /function invokeNative[\s\S]*?createRendererNativeRejection\(error, options\)/);
  assert.doesNotMatch(preload, /ipcRenderer\.invoke\("desktop:(?:native|set-native)/);

  const mainChannels = [...source.matchAll(/ipcMain\.handle\("(desktop:(?:native|set-native)[^"]+)"/g)]
    .map((match) => match[1]);
  const preloadChannels = [...preload.matchAll(/invokeNative\("(desktop:(?:native|set-native)[^"]+)"/g)]
    .map((match) => match[1]);
  assert.equal(mainChannels.length, 24);
  assert.deepEqual(new Set(preloadChannels), new Set(mainChannels));
});
