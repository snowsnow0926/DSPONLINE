"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const root = path.resolve(__dirname, "..");

function context(cursor = 0, limit = 2) {
  return {
    sessionId: "authority-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "builtin:test",
    query: "熔炉",
    cursor,
    limit,
    buildingIds: ["smelter"],
    resourceIds: [],
    planetIds: ["home"],
  };
}

function projection(cursor = 0, limit = 2) {
  const allRows = [
    { entityId: "entity-a", buildingId: "smelter", resourceId: null, planetId: "home", recipeId: "smelt_iron", positionX: 0, positionY: 0 },
    { entityId: "entity-b", buildingId: "smelter", resourceId: null, planetId: "home", recipeId: "smelt_iron", positionX: 40, positionY: -20 },
    { entityId: "entity-c", buildingId: "smelter", resourceId: null, planetId: "home", recipeId: null, positionX: 80, positionY: 20 },
  ];
  const rows = allRows.slice(cursor, cursor + limit);
  const consumed = cursor + rows.length;
  return {
    schemaVersion: 1,
    projectionType: "command-palette-entity-search-v1",
    revision: 7,
    registryFingerprint: "builtin:test",
    limits: {
      queryBytes: 256,
      selectorIds: 256,
      rows: 16,
      requestBytes: 32768,
      projectionBytes: 1048576,
    },
    request: {
      query: "熔炉",
      cursor,
      limit,
      buildingIds: ["smelter"],
      resourceIds: [],
      planetIds: ["home"],
    },
    totalCount: allRows.length,
    rows,
    nextCursor: consumed < allRows.length ? consumed : null,
  };
}

test("command palette entity-search boundary binds identity and a complete cursor page", () => {
  const first = normalizeRendererNativeResult(
    "coreCommandPaletteEntitySearchProjection",
    projection(),
    context(),
  );
  assert.equal(first.rows.length, 2);
  assert.deepEqual([first.rows[1].positionX, first.rows[1].positionY], [40, -20]);
  assert.equal(first.nextCursor, 2);
  const second = normalizeRendererNativeResult(
    "coreCommandPaletteEntitySearchProjection",
    projection(2, 2),
    context(2, 2),
  );
  assert.equal(second.rows[0].entityId, "entity-c");
  assert.equal(second.nextCursor, null);
  assert.throws(
    () => normalizeRendererNativeResult(
      "coreCommandPaletteEntitySearchProjection",
      projection(),
      { ...context(), query: "熔".repeat(86) },
    ),
    { code: "NATIVE_PROTOCOL_INVALID" },
  );

  for (const invalid of [
    { ...projection(), revision: 8 },
    { ...projection(), registryFingerprint: "builtin:other" },
    { ...projection(), request: { ...projection().request, cursor: 1 } },
    { ...projection(), totalCount: 1 },
    { ...projection(), nextCursor: 1 },
    { ...projection(), rows: [projection().rows[0], projection().rows[0]] },
    { ...projection(), rows: [{ ...projection().rows[0], positionX: Number.POSITIVE_INFINITY }, projection().rows[1]] },
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult(
        "coreCommandPaletteEntitySearchProjection",
        invalid,
        context(),
      ),
      { code: "NATIVE_PROTOCOL_INVALID" },
    );
  }
});

test("command palette entity-search is exposed only through bounded direct IPC", () => {
  const main = readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const preload = readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const host = readFileSync(path.join(root, "desktop", "native-host.cjs"), "utf8");
  const desktop = readFileSync(path.join(root, "src", "desktop.ts"), "utf8");
  assert.match(main, /desktop:native-core-command-palette-entity-search"[\s\S]*?coreCommandPaletteEntitySearchProjection[\s\S]*?commandPaletteEntitySearchProjection\(ownerId, request\)/);
  assert.match(main, /"command-palette-entity-search-v1",[\s\S]*?request/);
  assert.match(preload, /getNativeCoreCommandPaletteEntitySearch:[\s\S]*?desktop:native-core-command-palette-entity-search/);
  assert.match(host, /MAX_COMMAND_PALETTE_SEARCH_REQUEST_BYTES = 32_768[\s\S]*?commandPaletteEntitySearchProjection\(ownerId, request\)[\s\S]*?bounded IPC limit/);
  assert.match(desktop, /projectionType: "command-palette-entity-search-v1"/);
});
