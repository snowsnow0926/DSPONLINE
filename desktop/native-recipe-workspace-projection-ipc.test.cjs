const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const root = path.resolve(__dirname, "..");

function context(location = null) {
  return {
    sessionId: "authority-1",
    expectedRevision: 7,
    expectedRegistryFingerprint: "builtin:test",
    itemIds: ["iron_ore", "iron_ingot"],
    selectedItemId: "iron_ingot",
    location,
  };
}

function projection(location = null) {
  return {
    schemaVersion: 1,
    projectionType: "recipe-workspace-v1",
    revision: 7,
    registryFingerprint: "builtin:test",
    truncated: false,
    limits: {
      itemRows: 256,
      completedTechRows: 512,
      planetRows: 64,
      profileItemRows: 256,
      colonyCostRows: 32,
      locationRows: 4096,
    },
    counts: { catalogItems: 2, completedTechIds: 1, planetProfiles: 1 },
    request: {
      itemIds: ["iron_ore", "iron_ingot"],
      selectedItemId: "iron_ingot",
      location,
    },
    live: {
      activePlanetId: "home",
      recipeFocus: { itemId: "iron_ingot", mode: "two-level" },
      completedTechIds: ["smelting"],
      beltCount: 12,
      metrics: { generationKw: 10, demandKw: 5, powerFactor: 1 },
      planetProfiles: [{
        planetId: "home",
        climateName: "Temperate",
        starTypeName: "G",
        oceanType: "water",
        windMultiplier: 1,
        solarPowerMultiplier: 1,
        geothermalMultiplier: 1,
        miningMultiplier: 1,
        reserveScale: 1,
        tidalLocked: false,
        resourceIds: { rows: ["iron_ore"], totalCount: 1, truncated: false },
        orbitalYields: { rows: [], totalCount: 0, truncated: false },
        colonyCost: { rows: [], totalCount: 0, truncated: false },
      }],
      dyson: {
        systemId: "helios",
        orbitCount: 0,
        orbitSails: 0,
        completedStructurePoints: 0,
        projectedGenerationKw: 0,
        sailLaunchesPerMinute: 0,
        rocketLaunchesPerMinute: 0,
        receiverLoadKw: 0,
        criticalPhotonPerMinute: 0,
        shellSails: 0,
        shellCapacity: 0,
      },
    },
    itemStocks: [
      { itemId: "iron_ore", amount: 4 },
      { itemId: "iron_ingot", amount: 28 },
    ],
    selectedItem: {
      itemId: "iron_ingot",
      stock: 28,
      productionLocations: [{ planetId: "home", producerCount: 1 }],
    },
    locationPage: location ? {
      planetId: location.planetId,
      cursor: location.cursor,
      totalCount: 1,
      entities: [{ id: "smelter-1", x: 128, y: 256 }],
      nextCursor: null,
    } : null,
  };
}

test("recipe workspace boundary binds revision, registry, selector, cardinality, and location page", () => {
  const normalized = normalizeRendererNativeResult(
    "coreRecipeWorkspaceProjection",
    projection(),
    context(),
  );
  assert.equal(normalized.revision, 7);
  assert.equal(normalized.itemStocks[1].amount, 28);
  assert.equal(normalized.live.beltCount, 12);

  for (const invalid of [
    { ...projection(), revision: 8 },
    { ...projection(), registryFingerprint: "builtin:other" },
    { ...projection(), itemStocks: [...projection().itemStocks].reverse() },
    { ...projection(), counts: { ...projection().counts, completedTechIds: 2 } },
    { ...projection(), truncated: true },
  ]) {
    assert.throws(
      () => normalizeRendererNativeResult("coreRecipeWorkspaceProjection", invalid, context()),
      { code: "NATIVE_PROTOCOL_INVALID" },
    );
  }

  const location = { planetId: "home", cursor: 0, limit: 32 };
  const located = normalizeRendererNativeResult(
    "coreRecipeWorkspaceProjection",
    projection(location),
    context(location),
  );
  assert.deepEqual(located.locationPage.entities, [{ id: "smelter-1", x: 128, y: 256 }]);
  assert.throws(
    () => normalizeRendererNativeResult(
      "coreRecipeWorkspaceProjection",
      { ...projection(location), locationPage: { ...projection(location).locationPage, nextCursor: 1 } },
      context(location),
    ),
    { code: "NATIVE_PROTOCOL_INVALID" },
  );
});

test("recipe workspace projection is routed through direct and checksummed IPC", () => {
  const main = readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const preload = readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const desktop = readFileSync(path.join(root, "src", "desktop.ts"), "utf8");
  const nativeCore = readFileSync(path.join(root, "src", "game", "nativeCore.ts"), "utf8");
  assert.match(main, /desktop:native-core-recipe-workspace-projection"[\s\S]*?coreRecipeWorkspaceProjection[\s\S]*?recipeWorkspaceProjection\(ownerId, request\)/);
  assert.match(main, /"recipe-workspace-v1"[\s\S]*?nativeRecipeWorkspaceProjectionResultContext/);
  assert.match(preload, /getNativeCoreRecipeWorkspaceProjection:[\s\S]*?desktop:native-core-recipe-workspace-projection/);
  assert.match(desktop, /projectionType:\s*"recipe-workspace-v1"/);
  assert.match(nativeCore, /recipeWorkspaceProjection\([\s\S]*?projectionType:\s*"recipe-workspace-v1"[\s\S]*?decodeNativeCoreProjectionTransfer/);
});
