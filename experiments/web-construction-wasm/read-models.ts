import { createWebFactoryInteractionRows } from "../../src/game/nativeFactoryInteractionFrame";
import {
  createFactorySelectionReadModel,
  createWebFactorySelectionToolbarReadModel,
  createWebFactoryViewportReadModel,
} from "../../src/game/webFactoryReadModelAdapter";
import type { GameState } from "../../src/game/types";

async function fingerprint(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return { bytes: bytes.length, sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}

// Read-only, localhost-only fixed fixture. Hashing/setup is outside query timing.
// Full returned records/maps are hashed; projection arrays must retain the exact
// source references, and the complete input state is hashed before and after.
async function runReadModelsProbe() {
  const state = (await (await fetch("/prepared.json")).json()).state as GameState;
  const before = await fingerprint(state);
  const entities = state.entities.filter((row) => row.planetId === state.activePlanetId);
  const belts = state.belts.filter((row) => row.planetId === state.activePlanetId);
  if (entities.length < 3 || belts.length < 3) throw Error("Read-model fixture requires populated active-planet arrays");
  const first = entities[0], last = entities.at(-1)!;
  const firstBelt = belts[0], lastBelt = belts.at(-1)!;
  const foreignEntity = state.entities.find((row) => row.planetId !== state.activePlanetId)?.id ?? "missing-foreign-entity";
  const foreignBelt = state.belts.find((row) => row.planetId !== state.activePlanetId)?.id ?? "missing-foreign-belt";
  const selections: [string, Parameters<typeof createWebFactoryInteractionRows>[1]][] = [
    ["empty", { selectedEntityIds: [], selectedBeltIds: [], primarySelectedBeltId: null }],
    ["entity", { selectedEntityIds: [last.id], selectedBeltIds: [], primarySelectedBeltId: null }],
    ["belt", { selectedEntityIds: [], selectedBeltIds: [lastBelt.id], primarySelectedBeltId: lastBelt.id }],
    ["primary-only", { selectedEntityIds: [], selectedBeltIds: [], primarySelectedBeltId: lastBelt.id }],
    ["duplicates", { selectedEntityIds: [last.id, first.id, last.id], selectedBeltIds: [lastBelt.id, firstBelt.id, lastBelt.id], primarySelectedBeltId: firstBelt.id }],
    ["missing-foreign", { selectedEntityIds: ["missing-entity", foreignEntity], selectedBeltIds: [foreignBelt, "missing-belt"], primarySelectedBeltId: foreignBelt }],
  ];
  const queries: [string, () => unknown][] = [];
  for (const [name, selection] of selections) {
    queries.push([`interaction/${name}`, () => {
      const { projectionEntities, projectionBelts, entityById, beltById, ...result } = createWebFactoryInteractionRows(state, selection);
      if (projectionEntities !== state.entities || projectionBelts !== state.belts) throw Error("Projection universe changed");
      return { ...result, entityById: [...entityById], beltById: [...beltById] };
    }]);
    queries.push([`toolbar/${name}`, () => createWebFactorySelectionToolbarReadModel(state, selection.selectedEntityIds, selection.selectedBeltIds)]);
    queries.push([`selection/${name}`, () => createFactorySelectionReadModel(state, selection)]);
  }
  const bounds = { minX: first.position.x - 400, minY: first.position.y - 400, maxX: first.position.x + 400, maxY: first.position.y + 400 };
  const viewportRequests: [string, Parameters<typeof createWebFactoryViewportReadModel>[1]][] = [
    ["unpinned", { planetId: state.activePlanetId, bounds, pinnedEntityIds: [], pinnedBeltIds: [] }],
    ["pinned", { planetId: state.activePlanetId, bounds, pinnedEntityIds: [last.id], pinnedBeltIds: [lastBelt.id] }],
    ["duplicates-missing-foreign", { planetId: state.activePlanetId, bounds, pinnedEntityIds: [last.id, foreignEntity, "missing-entity", last.id], pinnedBeltIds: [lastBelt.id, "missing-belt", foreignBelt, lastBelt.id] }],
    ["empty-viewport", { planetId: state.activePlanetId, bounds: { minX: 1e12, minY: 1e12, maxX: 1e12 + 1, maxY: 1e12 + 1 }, pinnedEntityIds: [], pinnedBeltIds: [] }],
    ["all-visible", { planetId: state.activePlanetId, bounds: { minX: -1e12, minY: -1e12, maxX: 1e12, maxY: 1e12 }, pinnedEntityIds: [last.id, first.id], pinnedBeltIds: [lastBelt.id, firstBelt.id] }],
  ];
  for (const [name, request] of viewportRequests) queries.push([`viewport/${name}`, () => createWebFactoryViewportReadModel(state, request)]);
  const reports = [];
  for (const [name, query] of queries) {
    const milliseconds = [];
    let result: unknown;
    for (let index = 0; index < 7; index++) {
      const started = performance.now(); result = query();
      const elapsed = performance.now() - started;
      if (index >= 2) milliseconds.push(elapsed);
    }
    reports.push({ name, milliseconds, medianMs: [...milliseconds].sort((a, b) => a - b)[2], result: await fingerprint(result) });
  }
  const after = await fingerprint(state);
  if (before.sha256 !== after.sha256) throw Error("Read-model queries mutated the complete source state");
  return { entityCount: state.entities.length, beltCount: state.belts.length, before, after, reports,
    completeResults: await fingerprint(reports.map(({ name, result }) => ({ name, result }))) };
}

Object.assign(globalThis, { runReadModelsProbe });
