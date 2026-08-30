"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const CONTEXT = Object.freeze({
  sessionId: "authority-session",
  expectedRevision: 17,
  expectedRegistryFingerprint: "builtin:blueprint-test",
  section: "library",
  blueprintId: null,
  cursor: 0,
  limit: 32,
});

const LIMITS = Object.freeze({
  pageRows: 32,
  sourceRows: 4_096,
  detailEntities: 512,
  detailBelts: 1_024,
  detailResourceAnchors: 256,
  detailExternalPorts: 256,
  projectionBytes: 1_048_576,
  opaqueIdBytes: 512,
  nameBytes: 256,
});

function summary(id, name = id, counts = {}) {
  const normalizedCounts = {
    entities: 0,
    belts: 0,
    resourceAnchors: 0,
    externalPorts: 0,
    ...counts,
  };
  return {
    id,
    name,
    revision: 1,
    rotation: 0,
    mirror: "none",
    counts: normalizedCounts,
    detailStatus: normalizedCounts.entities > 512 || normalizedCounts.belts > 1_024 ||
      normalizedCounts.resourceAnchors > 256 || normalizedCounts.externalPorts > 256
      ? "truncated"
      : "candidate",
  };
}

function result(context, rows, counts = { library: rows.length, queue: 0 }, totalCount = rows.length) {
  const nextCursor = context.cursor + rows.length < totalCount ? context.cursor + rows.length : null;
  return {
    schemaVersion: 1,
    projectionType: "blueprint-workspace-v1",
    source: "native-core",
    revision: context.expectedRevision,
    stateVersion: 47,
    registryFingerprint: context.expectedRegistryFingerprint,
    readOnly: true,
    request: {
      expectedRevision: context.expectedRevision,
      expectedRegistryFingerprint: context.expectedRegistryFingerprint,
      section: context.section,
      blueprintId: context.blueprintId,
      cursor: context.cursor,
      limit: 32,
    },
    counts,
    page: {
      cursor: context.cursor,
      limit: 32,
      totalCount,
      rows,
      nextCursor,
      truncated: nextCursor !== null,
    },
    limits: { ...LIMITS },
  };
}

test("blueprint library projection preserves persisted order and accepts bounded Unicode summaries", () => {
  const rows = [summary("z-last", "最后的蓝图 Ω"), summary("a-first", "先展示")];
  const normalized = normalizeRendererNativeResult(
    "coreBlueprintWorkspaceProjection",
    result(CONTEXT, rows),
    CONTEXT,
  );
  assert.deepEqual(normalized.page.rows.map((row) => row.id), ["z-last", "a-first"]);
  assert.equal(normalized.page.rows[0].name, "最后的蓝图 Ω");
  assert.equal(normalized.readOnly, true);
});

test("blueprint detail accepts catalog-backed rows and explicit fail-closed MOD/oversize states", () => {
  const detailContext = { ...CONTEXT, section: "detail", blueprintId: "bp-selected" };
  const selected = summary("bp-selected", "已选择", {
    entities: 1,
    belts: 0,
    resourceAnchors: 0,
    externalPorts: 1,
  });
  const supported = {
    summary: selected,
    status: "supported",
    unsupportedReason: null,
    entities: [{
      key: "entity-1",
      buildingId: "assembler",
      buildingLabel: "组装机",
      offset: { x: -1.5, y: 2 },
      machineCount: 3,
      recipeId: "iron-plate",
      operationEnabledOnDeploy: null,
    }],
    belts: [],
    resourceAnchors: [],
    externalPorts: [{
      key: "port-1",
      entityKey: "entity-1",
      direction: "input",
      itemId: "iron-ore",
      offset: { x: -2, y: 2 },
    }],
  };
  const supportedProjection = result(detailContext, [supported], { library: 1, queue: 0 }, 1);
  assert.equal(normalizeRendererNativeResult(
    "coreBlueprintWorkspaceProjection",
    supportedProjection,
    detailContext,
  ).page.rows[0].status, "supported");

  const unsupported = {
    summary: summary("bp-selected", "MOD 安全摘要"),
    status: "unsupported",
    unsupportedReason: "unproven-catalog-semantics",
    entities: [],
    belts: [],
    resourceAnchors: [],
    externalPorts: [],
  };
  assert.equal(normalizeRendererNativeResult(
    "coreBlueprintWorkspaceProjection",
    result(detailContext, [unsupported], { library: 1, queue: 0 }, 1),
    detailContext,
  ).page.rows[0].status, "unsupported");

  const oversize = {
    ...unsupported,
    summary: summary("bp-selected", "超大蓝图", { entities: 513 }),
    status: "truncated",
    unsupportedReason: "detail-limits-exceeded",
  };
  assert.equal(normalizeRendererNativeResult(
    "coreBlueprintWorkspaceProjection",
    result(detailContext, [oversize], { library: 1, queue: 0 }, 1),
    detailContext,
  ).page.rows[0].status, "truncated");

  const byteOversize = {
    ...unsupported,
    summary: summary("bp-selected", "字节预算截断"),
    status: "truncated",
    unsupportedReason: "projection-byte-budget-exceeded",
  };
  assert.equal(normalizeRendererNativeResult(
    "coreBlueprintWorkspaceProjection",
    result(detailContext, [byteOversize], { library: 1, queue: 0 }, 1),
    detailContext,
  ).page.rows[0].unsupportedReason, "projection-byte-budget-exceeded");
});

test("blueprint pagination deterministically clamps a stale offset to the last legal page", () => {
  const staleCursorContext = { ...CONTEXT, cursor: 4_096 };
  const value = result(
    staleCursorContext,
    [summary("bp-32"), summary("bp-33"), summary("bp-34")],
    { library: 35, queue: 0 },
    35,
  );
  value.page.cursor = 32;
  const normalized = normalizeRendererNativeResult(
    "coreBlueprintWorkspaceProjection",
    value,
    staleCursorContext,
  );
  assert.equal(normalized.request.cursor, 4_096);
  assert.equal(normalized.page.cursor, 32);
  assert.deepEqual(normalized.page.rows.map((row) => row.id), ["bp-32", "bp-33", "bp-34"]);
});

test("blueprint normalizer rejects forged detail and queue semantic combinations", () => {
  const detailContext = { ...CONTEXT, section: "detail", blueprintId: "bp-forged" };
  const detailSummary = summary("bp-forged", "Forged", { entities: 1 });
  const supported = {
    summary: detailSummary,
    status: "supported",
    unsupportedReason: null,
    entities: [{
      key: "entity-1",
      buildingId: "assembler",
      buildingLabel: "assembler",
      offset: { x: 0, y: 0 },
      machineCount: 1,
      recipeId: null,
      operationEnabledOnDeploy: null,
    }],
    belts: [],
    resourceAnchors: [],
    externalPorts: [],
  };
  const invalidDetails = [
    { ...supported, entities: [{ ...supported.entities[0], machineCount: 100_000_001 }] },
    { ...supported, entities: [{ ...supported.entities[0], operationEnabledOnDeploy: true }] },
    {
      ...supported,
      summary: summary("bp-forged", "Forged", { entities: 0, belts: 1 }),
      entities: [],
      belts: [{
        key: "belt-1", sourceKey: "missing", targetKey: "missing", itemId: "ore", lanes: 1, tier: 256,
      }],
    },
    {
      ...supported,
      summary: summary("bp-forged", "Oversize", { entities: 513 }),
      status: "unsupported",
      unsupportedReason: "unproven-catalog-semantics",
      entities: [],
    },
  ];
  for (const forged of invalidDetails) {
    assert.throws(
      () => normalizeRendererNativeResult(
        "coreBlueprintWorkspaceProjection",
        result(detailContext, [forged], { library: 1, queue: 0 }, 1),
        detailContext,
      ),
      /native blueprint workspace/i,
    );
  }

  const queueContext = { ...CONTEXT, section: "queue" };
  const queueRow = {
    id: "queue-1",
    blueprintId: "bp-forged",
    blueprintVersionId: "version-1",
    blueprintRevision: 1,
    blueprintName: "Queue",
    planetId: "home",
    planetName: "Home",
    position: { x: 0, y: 0 },
    rotation: 0,
    mirror: "none",
    queuedAt: 1,
    status: "pending-materials",
    counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    semanticStatus: "catalog-backed",
    reservedConstructionTotal: 0,
    reservedFleetTotal: 0,
    placedEntityCount: 0,
    actionable: false,
  };
  const invalidQueueRows = [
    { ...queueRow, counts: null },
    { ...queueRow, semanticStatus: "truncated" },
    { ...queueRow, counts: { ...queueRow.counts, entities: 513 }, semanticStatus: "unsupported" },
    { ...queueRow, queuedAt: -1 },
    { ...queueRow, placedEntityCount: 2 },
  ];
  for (const forged of invalidQueueRows) {
    assert.throws(
      () => normalizeRendererNativeResult(
        "coreBlueprintWorkspaceProjection",
        result(queueContext, [forged], { library: 1, queue: 1 }, 1),
        queueContext,
      ),
      /native blueprint workspace/i,
    );
  }
});

test("blueprint normalizer rejects stale identity, stale selection, malformed continuation, and unknown fields", () => {
  const row = summary("bp-selected");
  const valid = result(CONTEXT, [row]);
  for (const [value, context] of [
    [{ ...valid, revision: 18 }, CONTEXT],
    [valid, { ...CONTEXT, expectedRevision: 18 }],
    [valid, { ...CONTEXT, cursor: 1 }],
    [valid, { ...CONTEXT, cursor: 4_097 }],
    [valid, { ...CONTEXT, section: "queue" }],
    [{ ...valid, request: { ...valid.request, blueprintId: "other" } }, CONTEXT],
    [{ ...valid, request: { ...valid.request, cursor: 1 } }, CONTEXT],
    [{ ...valid, page: { ...valid.page, nextCursor: 1, truncated: true } }, CONTEXT],
    [{ ...valid, legacyGameState: { blueprints: [] } }, CONTEXT],
    [{ ...valid, page: { ...valid.page, rows: [{ ...row, unknownPayload: "secret" }] } }, CONTEXT],
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult("coreBlueprintWorkspaceProjection", value, context),
      /native blueprint workspace/i,
    );
  }
});

test("blueprint normalizer rejects duplicate page IDs and a malicious projection above one MiB", () => {
  assert.throws(
    () => normalizeRendererNativeResult(
      "coreBlueprintWorkspaceProjection",
      result(CONTEXT, [summary("duplicate"), summary("duplicate")]),
      CONTEXT,
    ),
    /duplicate page ID/i,
  );

  const detailContext = { ...CONTEXT, section: "detail", blueprintId: "bp-huge" };
  const repeated = "x".repeat(500);
  const entities = Array.from({ length: 512 }, (_, index) => ({
    key: `entity-${index}-${repeated}`,
    buildingId: `building-${index}-${repeated}`,
    buildingLabel: "名".repeat(80),
    offset: { x: index, y: -index },
    machineCount: 1,
    recipeId: `recipe-${index}-${repeated}`,
    operationEnabledOnDeploy: null,
  }));
  const belts = Array.from({ length: 1_024 }, (_, index) => ({
    key: `belt-${index}-${repeated}`,
    sourceKey: `entity-${index % 512}-${repeated}`,
    targetKey: `entity-${(index + 1) % 512}-${repeated}`,
    itemId: `item-${index}-${repeated}`,
    lanes: 1,
    tier: 1,
  }));
  const hugeSummary = summary("bp-huge", "Huge", { entities: entities.length, belts: belts.length });
  const hugeDetail = {
    summary: hugeSummary,
    status: "supported",
    unsupportedReason: null,
    entities,
    belts,
    resourceAnchors: [],
    externalPorts: [],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(hugeDetail), "utf8") > 1_048_576);
  assert.throws(
    () => normalizeRendererNativeResult(
      "coreBlueprintWorkspaceProjection",
      result(detailContext, [hugeDetail], { library: 1, queue: 0 }, 1),
      detailContext,
    ),
    /byte budget/i,
  );
});

test("blueprint projection is wired through host, broker, IPC, preload, transfer, and typed client", () => {
  const files = {
    host: readFileSync("desktop/native-host.cjs", "utf8"),
    broker: readFileSync("desktop/native-player-authority-projection-broker.cjs", "utf8"),
    main: readFileSync("desktop/main.cjs", "utf8"),
    preload: readFileSync("desktop/preload.cjs", "utf8"),
    client: readFileSync("src/game/nativeCore.ts", "utf8"),
    protocol: readFileSync("native/dsp-native-host/src/protocol.rs", "utf8"),
  };
  assert.match(files.host, /native-core-blueprint-workspace-v1/);
  assert.match(files.host, /blueprintWorkspaceProjection/);
  assert.match(files.broker, /"blueprint-workspace-v1": "blueprintWorkspaceProjection"/);
  assert.match(files.main, /desktop:native-core-blueprint-workspace/);
  assert.match(files.main, /coreBlueprintWorkspaceProjection/);
  assert.match(files.preload, /getNativeCoreBlueprintWorkspace/);
  assert.match(files.preload, /blueprint-workspace-v1/);
  assert.match(files.client, /blueprint-workspace-v1/);
  assert.match(files.client, /getNativeCoreBlueprintWorkspace/);
  assert.match(files.protocol, /CoreBlueprintWorkspaceProjection/);
});
