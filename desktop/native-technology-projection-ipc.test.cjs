const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { normalizeRendererNativeResult } = require("./native-renderer-boundary.cjs");

const root = path.resolve(__dirname, "..");

function projection(revision = 7) {
  return {
    schemaVersion: 1,
    projectionType: "technology-v1",
    revision,
    truncated: false,
    limits: { techRows: 512, progressItemsPerTech: 16, infiniteRows: 8 },
    counts: { completedTechIds: 1, queuedTechIds: 0, progressTechs: 1, infiniteResearch: 5 },
    selectedTechId: "electromagnetism",
    pausedTechId: null,
    completedTechIds: ["electromagnetic_matrix"],
    queuedTechIds: [],
    progressByTech: [{
      techId: "electromagnetism",
      totalCount: 1,
      truncated: false,
      items: [{ itemId: "electromagnetic_matrix", amount: 3 }],
    }],
    activeInfiniteResearchId: null,
    autoResearch: false,
    infiniteResearch: [
      "matrix_compression", "vein_utilization", "galactic_logistics", "stellar_harnessing", "continuum_simulation",
    ].map((researchId) => ({ researchId, level: 0, historicalLevel: null, progress: "0" })),
    settings: { technologyLayout: "standard", fontScale: 1, difficulty: "standard" },
    matrixStock: {
      electromagnetic_matrix: 4,
      energy_matrix: 0,
      structure_matrix: 0,
      information_matrix: 0,
      gravity_matrix: 0,
      universe_matrix: 0,
    },
  };
}

test("technology projection boundary binds revision and validates the complete bounded block", () => {
  const context = { sessionId: "authority-1", expectedRevision: 7 };
  const normalized = normalizeRendererNativeResult("coreTechnologyProjection", projection(), context);
  assert.equal(normalized.revision, 7);
  assert.equal(normalized.matrixStock.electromagnetic_matrix, 4);
  assert.throws(
    () => normalizeRendererNativeResult("coreTechnologyProjection", projection(8), context),
    { code: "NATIVE_PROTOCOL_INVALID" },
  );
  assert.throws(
    () => normalizeRendererNativeResult("coreTechnologyProjection", {
      ...projection(),
      counts: { ...projection().counts, progressTechs: 2 },
    }, context),
    { code: "NATIVE_PROTOCOL_INVALID" },
  );
  assert.throws(
    () => normalizeRendererNativeResult("coreTechnologyProjection", {
      ...projection(),
      progressByTech: [{ ...projection().progressByTech[0], items: Array.from({ length: 17 }, (_, index) => ({ itemId: `item-${index}`, amount: 1 })) }],
    }, context),
    { code: "NATIVE_PROTOCOL_INVALID" },
  );
});
test("technology projection is routed through direct and checksummed transfer IPC", () => {
  const main = readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const preload = readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const desktop = readFileSync(path.join(root, "src", "desktop.ts"), "utf8");
  const nativeCore = readFileSync(path.join(root, "src", "game", "nativeCore.ts"), "utf8");
  assert.match(main, /desktop:native-core-technology-projection"[\s\S]*?coreTechnologyProjection[\s\S]*?technologyProjection\(ownerId, request\)/);
  assert.match(main, /"technology-v1"[\s\S]*?nativeTechnologyProjectionResultContext/);
  assert.match(preload, /getNativeCoreTechnologyProjection:[\s\S]*?desktop:native-core-technology-projection/);
  assert.match(desktop, /projectionType: "technology-v1"/);
  assert.match(nativeCore, /technologyProjection\([\s\S]*?projectionType: "technology-v1"[\s\S]*?decodeNativeCoreProjectionTransfer/);
});
