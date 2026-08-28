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

test("host startup recovery receipt remains main-only at the renderer boundary", () => {
  const normalized = normalizeRendererNativeResult("hostHello", {
    protocolVersion: 1,
    nativeFormatVersion: 1,
    hostVersion: "1.2.3",
    capabilities: ["native-core-player-authority-startup-recovery-v1"],
    playerAuthorityStartupRecovery: { sessionId: "main-only" },
  });
  assert.deepEqual(normalized, {
    protocolVersion: 1,
    nativeFormatVersion: 1,
    hostVersion: "1.2.3",
    capabilities: ["native-core-player-authority-startup-recovery-v1"],
  });
  assert.equal(Object.hasOwn(normalized, "playerAuthorityStartupRecovery"), false);
});

test("player-authority clock state is exact, bounded and contains no writer identity", () => {
  const state = {
    schemaVersion: 1,
    phase: "active",
    sessionId: "core-restarted-1",
    runId: "player-run-1",
    revision: 11,
    acknowledgedSequence: 4,
    nextSequence: 5,
    nextDeadlineMs: 11_000,
    inFlight: false,
    currentOperation: null,
    queuedCommands: 0,
    lastErrorCode: null,
  };
  assert.deepEqual(normalizeRendererNativeResult("playerAuthorityState", state), state);
  for (const invalid of [
    { ...state, ownerId: "main-player-authority" },
    { ...state, checkpoint: { generation: 8, rootHash: SHA_A, revision: 11 } },
    { ...state, nextSequence: 6 },
    { ...state, sessionId: null },
    { ...state, queuedCommands: 65 },
    { ...state, lastErrorCode: "private-path" },
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult("playerAuthorityState", invalid),
      /native player-authority/i,
    );
  }
});

test("player-authority macro status is an exact scalar-only discriminated union", () => {
  const state = {
    schemaVersion: 2,
    statusKind: "macro",
    phase: "macro-active",
    revision: 13,
    acknowledgedSequence: 6,
    nextSequence: 7,
    nextDeadlineMs: 17_000,
    inFlight: false,
    currentOperation: null,
    simulationBudgetMilliseconds: 60_000,
    wallBudgetMilliseconds: 4_000,
    simulationProgressMilliseconds: 60_000,
    wallProgressMilliseconds: 4_000,
    pausedReason: "macro-window-active",
  };
  assert.deepEqual(normalizeRendererNativeResult("playerAuthorityState", state), state);
  assert.doesNotMatch(JSON.stringify(state), /session|runId|operationId|algorithm|error/i);

  const uncertain = {
    ...state,
    phase: "macro-uncertain",
    inFlight: false,
    simulationProgressMilliseconds: null,
    wallProgressMilliseconds: null,
    pausedReason: "macro-advance-uncertain",
  };
  assert.deepEqual(normalizeRendererNativeResult("playerAuthorityState", uncertain), uncertain);

  for (const valid of [
    {
      ...state,
      phase: "macro-committing",
      inFlight: true,
      currentOperation: "advance",
      simulationProgressMilliseconds: 0,
      wallProgressMilliseconds: 0,
      pausedReason: "macro-advance-committing",
    },
    {
      ...state,
      phase: "macro-finishing",
      inFlight: true,
      currentOperation: "finish",
      pausedReason: "macro-finish-committing",
    },
    {
      ...state,
      phase: "faulted",
      currentOperation: "advance",
      pausedReason: "macro-runtime-faulted",
    },
    {
      ...state,
      phase: "shutdown",
      currentOperation: "finish",
      pausedReason: "macro-runtime-shutdown",
    },
  ]) {
    assert.deepEqual(normalizeRendererNativeResult("playerAuthorityState", valid), valid);
  }

  for (const invalid of [
    { ...state, sessionId: "core-secret" },
    { ...state, runId: "run-secret" },
    { ...state, macroSessionId: "macro-secret" },
    { ...state, operationId: "operation-secret" },
    { ...state, algorithmVersion: "algorithm-secret" },
    { ...state, lastErrorCode: "NATIVE_PRIVATE_ERROR" },
    { ...state, nextSequence: 8 },
    { ...state, phase: "macro-unknown" },
    { ...state, currentOperation: "operation-secret" },
    { ...state, simulationBudgetMilliseconds: null },
    { ...state, simulationBudgetMilliseconds: 0 },
    { ...state, wallBudgetMilliseconds: 30 * 24 * 60 * 60 * 1_000 + 1 },
    { ...state, simulationProgressMilliseconds: 60_001 },
    { ...state, wallProgressMilliseconds: null },
    { ...state, phase: "macro-committing", currentOperation: null, pausedReason: "macro-advance-committing" },
    { ...state, phase: "macro-finishing", currentOperation: "advance", pausedReason: "macro-finish-committing" },
    { ...uncertain, inFlight: true, currentOperation: null },
    { ...uncertain, currentOperation: "finish", pausedReason: "macro-advance-uncertain" },
    { ...state, phase: "shutdown", pausedReason: "macro-runtime-faulted" },
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult("playerAuthorityState", invalid),
      /native player-authority/i,
    );
  }
});

test("native command change receipts are stable ordered and duplicate-free", () => {
  const receipt = {
    previousRevision: 17,
    revision: 18,
    changedEntityIds: ["entity-a", "entity-z"],
    changedBeltIds: ["belt-a"],
    topologyDirty: false,
  };
  assert.deepEqual(normalizeRendererNativeResult("coreCommand", receipt), receipt);
  assert.deepEqual(
    normalizeRendererNativeResult("coreCommand", {
      ...receipt,
      changedEntityIds: ["MOD-物品/Ω"],
    }).changedEntityIds,
    ["MOD-物品/Ω"],
  );
  for (const invalid of [
    { ...receipt, changedEntityIds: ["entity-z", "entity-a"] },
    { ...receipt, changedEntityIds: ["entity-a", "entity-a"] },
    { ...receipt, changedBeltIds: ["belt-a", "belt-a"] },
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult("coreCommand", invalid),
      /native changed/i,
    );
  }
});

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

function viewportV2Context(overrides = {}) {
  return {
    sessionId: "session-viewport-v2",
    expectedRevision: 7,
    baseFields: ["paused"],
    planetId: "mod:星球/Ω",
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    entityCursor: 1,
    entityLimit: 1,
    beltCursor: 0,
    beltLimit: 1,
    pinnedEntityIds: ["mod:节点/Ω [selected]"],
    pinnedBeltIds: ["mod:线路/β #pinned"],
    ...overrides,
  };
}

function viewportV2Projection(overrides = {}) {
  const planetId = "mod:星球/Ω";
  return {
    schemaVersion: 2,
    projectionType: "viewport-v2",
    revision: 7,
    planetId,
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    base: { paused: false },
    entities: [
      {
        id: "mod:节点/Ω [selected]", kind: "vein", planetId,
        position: { x: 20, y: 20 }, interactionLocked: false,
        routingCursor: 0, machineCount: 0, minerCount: 1,
        inputs: {}, outputs: { "mod:物品/铁矿 Ω": 2 },
        progress: 0, utilization: 1, productionRate: 1,
      },
      {
        id: "mod:节点/可见", kind: "vein", planetId,
        position: { x: 2, y: 3 }, interactionLocked: false,
        routingCursor: 0, machineCount: 0, minerCount: 1,
        inputs: {}, outputs: { "mod:物品/铁矿 Ω": 1 },
        progress: 0, utilization: 1, productionRate: 1,
      },
    ],
    belts: [
      {
        id: "mod:线路/β #pinned", planetId, source: "mod:节点/Ω [selected]",
        target: "mod:节点/远端", itemId: "mod:物品/铁矿 Ω", lanes: 1,
        tier: 1, sorterTier: 1, progress: 0, priority: 1,
      },
      {
        id: "mod:线路/可见", planetId, source: "mod:节点/可见",
        target: "mod:节点/远端", itemId: "mod:物品/铁矿 Ω", lanes: 1,
        tier: 1, sorterTier: 1, progress: 0, priority: 1,
      },
    ],
    pinnedEntityIds: ["mod:节点/Ω [selected]"],
    pinnedBeltIds: ["mod:线路/β #pinned"],
    nextEntityCursor: 2,
    nextBeltCursor: 1,
    planetTotals: { entities: 4, belts: 3 },
    viewportTotals: { entities: 3, belts: 2 },
    worldBounds: { minX: -5, minY: -5, maxX: 30, maxY: 30 },
    minimap: {
      bounds: { minX: -5, minY: -5, maxX: 30, maxY: 30 },
      entityCount: 4,
      beltCount: 3,
      occupiedCellCount: 2,
      cellSize: 512,
    },
    broadQueryFallback: false,
    ...overrides,
  };
}

function factoryReadModelContext(overrides = {}) {
  return {
    sessionId: "session-factory-read-model",
    expectedRevision: 7,
    selectedEntityIds: ["MOD-建筑", "missing"],
    selectedBeltIds: ["MOD-线路"],
    ...overrides,
  };
}

function factoryReadModelProjection(overrides = {}) {
  const rows = (entries, totalCount = entries.length) => ({
    rows: entries,
    totalCount,
    truncated: totalCount > entries.length,
  });
  return {
    schemaVersion: 1,
    projectionType: "factory-read-model-v1",
    revision: 7,
    shell: {
      schema: "factory-read-model-v1",
      source: "native-core",
      stateVersion: 47,
      mode: "normal",
      activePlanetId: "MOD-星球",
      paused: false,
      elapsedSeconds: 123,
      simulationSpeed: 4,
      entityCount: 2,
      beltCount: 1,
      activePlanetEntityCount: 2,
      activePlanetBeltCount: 1,
      constructionQueueCount: 1,
    },
    planetNavigation: {
      schema: "factory-read-model-v1",
      activePlanetId: "MOD-星球",
      planets: rows([{
        planetId: "MOD-星球",
        systemId: "MOD-恒星系",
        displayName: "测试家园 Ω",
        code: "MOD-星球",
        active: true,
        discovered: true,
        colonized: true,
        role: "industry",
        entityCount: 2,
        deviceCount: 7,
        beltCount: 1,
        constructionQueueCount: 1,
        powerFactor: 0.75,
      }]),
    },
    selection: {
      schema: "factory-read-model-v1",
      activePlanetId: "MOD-星球",
      requestedEntityCount: 2,
      requestedBeltCount: 1,
      entityRows: rows([{
        entityId: "MOD-建筑",
        planetId: "MOD-星球",
        kind: "storage",
        position: { x: -5, y: 6 },
        interactionLocked: false,
        buildingId: "MOD-仓库",
        resourceId: null,
        recipeId: null,
        storedItemId: "MOD-物品/Ω",
        fuelItemId: null,
        machineCount: 1,
        minerCount: 0,
        progress: 0,
        utilization: 0.5,
        productionRate: 1,
        powerFactor: null,
        inputItems: rows([{ itemId: "MOD-物品/Ω", amount: 4 }]),
        outputItems: rows([]),
      }]),
      beltRows: rows([{
        beltId: "MOD-线路",
        planetId: "MOD-星球",
        sourceEntityId: "MOD-建筑",
        targetEntityId: "sink",
        itemId: "MOD-物品/Ω",
        lanes: 1,
        tier: 1,
        sorterTier: 1,
        stackSize: null,
        priority: 1,
        progress: 0,
        lastFlow: 2,
        totalTransferred: null,
        congestion: null,
      }]),
    },
    construction: {
      schema: "factory-read-model-v1",
      activePlanetId: "MOD-星球",
      queue: rows([{
        queueId: "queue-1",
        blueprintId: "bp-1",
        blueprintVersionId: null,
        blueprintRevision: null,
        blueprintName: "测试蓝图",
        planetId: "MOD-星球",
        queuedAt: 2,
        status: "pending-materials",
        rotation: 0,
        mirror: "none",
        placedEntityCount: 1,
        reservedConstruction: rows([{ constructionId: "MOD-仓库", amount: 2 }]),
        reservedFleet: rows([{ itemId: "MOD-物品/Ω", amount: 3 }]),
      }]),
      automation: {
        enabled: true,
        quantumSourceEnabled: true,
        totalCrafted: 7,
        lastCraftedId: "MOD-仓库",
        targets: rows([{ targetId: "MOD-仓库", amount: 10 }]),
        jobs: rows([{
          entityId: "MOD-建筑",
          constructionId: "MOD-仓库",
          stepIndex: 1,
          stepCount: 2,
          elapsedSeconds: 0.5,
          inventory: rows([{ itemId: "MOD-物品/Ω", amount: 4 }]),
        }]),
        destroyedByproducts: rows([{ itemId: "MOD-副产物", amount: 1 }]),
      },
    },
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
    beltScheduler: {
      routeCount: 155_746,
      groupCount: 78_025,
      activeQueueEnabled: true,
      initializationGroupChecks: 0,
      selectionGroupChecks: 12_345,
      carriedActiveGroups: 4_115,
      transferPasses: 2,
      reservationPasses: 1,
      fullScanPasses: 0,
      transferRouteChecks: 16_000,
      reservationRouteChecks: 8_000,
      reservationAllowanceEntries: 7_900,
      reservationCreditEntries: 4_000,
      stableRoutesSkipped: 443_238,
      wakeCount: 20,
      sleepCount: 12,
      changedBeltRecords: 1_024,
      writeBackPatchRecords: 1_024,
      writeBackWorkers: 1,
    },
  });
  assert.equal(advanced.reason, "native-domain-unavailable");
  assert.equal(advanced.beltScheduler.initializationGroupChecks, 0);
  assert.equal(advanced.beltScheduler.selectionGroupChecks, 12_345);
  assert.equal(advanced.beltScheduler.carriedActiveGroups, 4_115);
  assert.doesNotMatch(JSON.stringify(advanced), /Player|private-save|token/);

  const macroAdvanced = normalizeRendererNativeResult("coreAdvance", {
    supported: true,
    exactScope: "pure-idle-macro-v10",
    changed: true,
    previousRevision: 2,
    revision: 5,
    algorithmVersion: "native-pure-idle-macro-v10-three-window-strict-freeze-v1",
    exactCalibrationSeconds: 30,
    approximatedSeconds: 30,
  });
  assert.equal(macroAdvanced.exactScope, "pure-idle-macro-v10");

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

test("viewport v2 binds independent pages and preserves bounded opaque selections", () => {
  const projection = viewportV2Projection();
  const context = viewportV2Context();
  const normalized = normalizeRendererNativeResult("coreViewportProjectionV2", projection, context);
  assert.deepEqual(normalized, projection);
  assert.notEqual(normalized, projection);
  assert.notEqual(normalized.entities[0], projection.entities[0]);
  assert.notEqual(normalized.entities[0].outputs, projection.entities[0].outputs);
  assert.equal(normalized.entities[0].outputs["mod:物品/铁矿 Ω"], 2);
  assert.deepEqual(normalized.pinnedEntityIds, ["mod:节点/Ω [selected]"]);
  assert.deepEqual(normalized.pinnedBeltIds, ["mod:线路/β #pinned"]);
  assert.equal(normalized.nextEntityCursor, 2);
  assert.equal(normalized.nextBeltCursor, 1);

  const rejectsViewportV2 = (value, requestContext = context) => assert.throws(
    () => normalizeRendererNativeResult("coreViewportProjectionV2", value, requestContext),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );

  // Session and revision are mandatory request selectors even though only the
  // revision is echoed in the bounded projection body.
  rejectsViewportV2(projection, viewportV2Context({ sessionId: "bad session" }));
  rejectsViewportV2(projection, viewportV2Context({ expectedRevision: 8 }));
  rejectsViewportV2(projection, { ...context, unexpected: true });
  rejectsViewportV2({ ...projection, revision: 8 });

  // Entity and belt pages advance independently and are both derived from
  // their own cursor plus total, never from the other returned array length.
  rejectsViewportV2({ ...projection, nextEntityCursor: 1 });
  rejectsViewportV2({ ...projection, nextBeltCursor: null });
  rejectsViewportV2({ ...projection, viewportTotals: { entities: 1, belts: 2 } });
  rejectsViewportV2({ ...projection, viewportTotals: { entities: 3, belts: 4 } });
  rejectsViewportV2({ ...projection, entities: [] });
  rejectsViewportV2({ ...projection, belts: [...projection.belts, { ...projection.belts[1], id: "mod:线路/额外" }] });

  // Only a resolved, explicitly requested pinned selection may be outside the
  // requested viewport, and every returned pin must have a matching record.
  rejectsViewportV2({ ...projection, pinnedEntityIds: ["mod:节点/未请求"] });
  rejectsViewportV2({ ...projection, pinnedBeltIds: ["mod:线路/未请求"] });
  rejectsViewportV2({ ...projection, entities: projection.entities.slice(1) });
  rejectsViewportV2({ ...projection, belts: projection.belts.slice(1) });
  rejectsViewportV2({
    ...projection,
    entities: projection.entities.map((entity) => entity.id === "mod:节点/可见"
      ? { ...entity, position: { x: 11, y: 3 } }
      : entity),
  });
  rejectsViewportV2({
    ...projection,
    pinnedEntityIds: [],
    entities: projection.entities,
  }, viewportV2Context({ pinnedEntityIds: [] }));

  // Totals, world bounds and minimap are a closed read-model description.
  rejectsViewportV2({ ...projection, planetTotals: { entities: 4, belts: 1 } });
  rejectsViewportV2({ ...projection, worldBounds: { minX: -5, minY: -5, maxX: 10, maxY: 10 } });
  rejectsViewportV2({ ...projection, minimap: { ...projection.minimap, entityCount: 5 } });
  rejectsViewportV2({ ...projection, minimap: { ...projection.minimap, occupiedCellCount: 5 } });
  rejectsViewportV2({ ...projection, minimap: { ...projection.minimap, cellSize: 256 } });
  rejectsViewportV2({ ...projection, broadQueryFallback: "false" });

  // Opaque MOD identifiers are UTF-8 byte bounded and may contain Unicode,
  // spaces and slashes, but never NUL or malformed surrogate halves.
  rejectsViewportV2({
    ...projection,
    entities: [{ ...projection.entities[0], id: "mod:\0bad" }, projection.entities[1]],
  });
  rejectsViewportV2(projection, viewportV2Context({ planetId: "界".repeat(342) }));
  rejectsViewportV2({
    ...projection,
    entities: [{ ...projection.entities[0], id: "mod:\ud800" }, projection.entities[1]],
  });
  rejectsViewportV2(projection, viewportV2Context({
    pinnedEntityIds: ["mod:节点/Ω [selected]", "mod:节点/Ω [selected]"],
  }));

  // The renderer boundary independently retains the core's 1 MiB payload
  // contract before cloning nested projection data.
  rejectsViewportV2({
    ...projection,
    base: { paused: false, payload: new Array(16_384).fill("x".repeat(64)) },
  }, viewportV2Context({ baseFields: ["paused", "payload"] }));
});

test("factory read model is strictly bounded and revision-bound before renderer delivery", () => {
  const projection = factoryReadModelProjection();
  const context = factoryReadModelContext();
  const normalized = normalizeRendererNativeResult("coreFactoryReadModelProjection", projection, context);
  assert.deepEqual(normalized, projection);
  assert.notEqual(normalized, projection);
  assert.notEqual(normalized.selection.entityRows.rows[0], projection.selection.entityRows.rows[0]);
  assert.equal(normalized.shell.source, "native-core");
  assert.equal(normalized.selection.entityRows.rows[0].inputItems.rows[0].itemId, "MOD-物品/Ω");

  const rejects = (value, requestContext = context) => assert.throws(
    () => normalizeRendererNativeResult("coreFactoryReadModelProjection", value, requestContext),
    (error) => error?.code === "NATIVE_PROTOCOL_INVALID",
  );
  rejects(projection, factoryReadModelContext({ sessionId: "bad session" }));
  rejects(projection, factoryReadModelContext({ expectedRevision: 8 }));
  rejects(projection, factoryReadModelContext({ selectedEntityIds: new Array(65).fill("entity") }));
  rejects({ ...projection, revision: 8 });
  rejects({ ...projection, shell: { ...projection.shell, source: "web-game-state" } });
  rejects({ ...projection, shell: { ...projection.shell, path: SECRET_PATH } });
  rejects({
    ...projection,
    selection: {
      ...projection.selection,
      entityRows: {
        ...projection.selection.entityRows,
        rows: [{ ...projection.selection.entityRows.rows[0], entityId: "not-requested" }],
      },
    },
  });
  rejects({
    ...projection,
    selection: {
      ...projection.selection,
      entityRows: {
        ...projection.selection.entityRows,
        rows: [{
          ...projection.selection.entityRows.rows[0],
          inputItems: {
            rows: [
              { itemId: "MOD-物品/Ω", amount: 1 },
              { itemId: "MOD-物品/Ω", amount: 2 },
            ],
            totalCount: 2,
            truncated: false,
          },
        }],
      },
    },
  });
  rejects({
    ...projection,
    selection: { ...projection.selection, requestedEntityCount: 1 },
  });
  rejects({
    ...projection,
    construction: {
      ...projection.construction,
      queue: { ...projection.construction.queue, truncated: true },
    },
  });
  rejects({ ...projection, shell: { ...projection.shell, constructionQueueCount: 2 } });
  rejects({
    ...projection,
    selection: {
      ...projection.selection,
      entityRows: {
        ...projection.selection.entityRows,
        rows: [{
          ...projection.selection.entityRows.rows[0],
          inputItems: { rows: [{ itemId: "MOD-物品/Ω", amount: { body: SECRET_BODY } }], totalCount: 1, truncated: false },
        }],
      },
    },
  });
  rejects({
    ...projection,
    construction: {
      ...projection.construction,
      queue: {
        ...projection.construction.queue,
        rows: [{ ...projection.construction.queue.rows[0], blueprintName: "x".repeat(1_048_576) }],
      },
    },
  });
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
  assert.match(source, /function nativeViewportProjectionV2ResultContext[\s\S]*?sessionId:\s*request\?\.sessionId[\s\S]*?expectedRevision:\s*request\?\.expectedRevision[\s\S]*?planetId:\s*request\?\.planetId[\s\S]*?entityCursor:[\s\S]*?entityLimit:[\s\S]*?beltCursor:[\s\S]*?beltLimit:[\s\S]*?pinnedEntityIds:[\s\S]*?pinnedBeltIds:/);
  assert.match(source, /function nativeFactoryReadModelResultContext[\s\S]*?sessionId:\s*request\?\.sessionId[\s\S]*?expectedRevision:\s*request\?\.expectedRevision[\s\S]*?selectedEntityIds:[\s\S]*?selectedBeltIds:/);
  assert.match(source, /function nativeStatisticsProjectionResultContext[\s\S]*?minElapsedSeconds:[\s\S]*?maxElapsedSeconds:[\s\S]*?cursor:[\s\S]*?limit:[\s\S]*?planetId:[\s\S]*?itemId:/);
  assert.match(source, /function nativeTechnologyProjectionResultContext[\s\S]*?sessionId:\s*request\?\.sessionId[\s\S]*?expectedRevision:\s*request\?\.expectedRevision/);
  assert.match(source, /desktop:native-core-projection"[\s\S]*?resultContext:\s*nativeCoreProjectionResultContext\(request\)/);
  assert.match(source, /desktop:native-core-viewport-projection"[\s\S]*?resultContext:\s*nativeViewportProjectionResultContext\(request\)/);
  assert.match(source, /desktop:native-core-viewport-projection-v2"[\s\S]*?runRendererNativeOperation\("coreViewportProjectionV2"[\s\S]*?resultContext:\s*nativeViewportProjectionV2ResultContext\(request\)/);
  assert.match(source, /desktop:native-core-factory-read-model"[\s\S]*?runRendererNativeOperation\("coreFactoryReadModelProjection"[\s\S]*?resultContext:\s*nativeFactoryReadModelResultContext\(request\)/);
  assert.match(source, /desktop:native-core-statistics-projection"[\s\S]*?resultContext:\s*nativeStatisticsProjectionResultContext\(request\)/);
  assert.match(source, /desktop:native-core-technology-projection"[\s\S]*?resultContext:\s*nativeTechnologyProjectionResultContext\(request\)/);
  assert.match(source, /desktop:native-core-projection-transfer[\s\S]*?nativeViewportProjectionResultContext\(request\.payload\)[\s\S]*?nativeViewportProjectionV2ResultContext\(normalizedRequest\)[\s\S]*?nativeFactoryReadModelResultContext\(normalizedRequest\)[\s\S]*?nativeStatisticsProjectionResultContext\(request\.payload\)[\s\S]*?nativeTechnologyProjectionResultContext\(normalizedRequest\)/);
  assert.match(source, /desktop:native-core-status[\s\S]*?runRendererNativeOperation\("coreSummary"/);
  assert.match(source, /desktop:native-player-authority-state"[\s\S]*?runRendererNativeOperation\("playerAuthorityState"/);
  assert.match(source, /onTransition:\s*publishNativePlayerAuthorityState/);
  assert.match(source, /webContents\.send\("desktop:native-player-authority-state-changed", state\)/);
  assert.match(preload, /function invokeNative[\s\S]*?createRendererNativeRejection\(error, options\)/);
  assert.doesNotMatch(preload, /ipcRenderer\.invoke\("desktop:(?:native|set-native)/);

  const mainChannels = [...source.matchAll(/ipcMain\.handle\("(desktop:(?:native|set-native)[^"]+)"/g)]
    .map((match) => match[1]);
  const preloadChannels = [...preload.matchAll(/invokeNative\("(desktop:(?:native|set-native)[^"]+)"/g)]
    .map((match) => match[1]);
  assert.equal(mainChannels.length, 33);
  assert.deepEqual(new Set(preloadChannels), new Set(mainChannels));
});
