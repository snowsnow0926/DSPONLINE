import { describe, expect, it } from "vitest";
import { createInitialState, setPaused } from "./engine";
import { applySimulationProjectionToState, captureSimulationProjectionBaseline, chunkFullRecordSimulationProjection, createDeferredTopLevelSimulationProjection, createFullCurrentPlanetSimulationProjection, createSimulationProjection, createSimulationProjectionStateIndex } from "./simulationProjection";

describe("simulation projection", () => {
  it("reports only changed runtime ids while preserving aggregate counts", () => {
    const previous = createInitialState();
    const current = structuredClone(previous);
    current.elapsedSeconds = 10;
    current.entities[0].progress = 0.25;
    const projection = createSimulationProjection(previous, current);
    expect(projection.protocolVersion).toBe(2);
    expect(projection.changedEntityIds).toContain(current.entities[0].id);
    expect(projection.changedBeltIds).toEqual([]);
    expect(projection.entityCount).toBe(current.entities.length);
    expect(projection.beltCount).toBe(current.belts.length);
    expect(projection.changedEntities[0]).toMatchObject({ id: current.entities[0].id, progress: 0.25 });
    expect(projection.requiresFullSnapshot).toBe(false);
    expect(projection.topLevel.elapsedSeconds).toBe(10);
  });

  it("detects in-place persistent runtime mutation from a pre-step baseline", () => {
    const current = createInitialState();
    const baseline = captureSimulationProjectionBaseline(current);
    current.entities[0].progress = 0.875;
    const projection = createSimulationProjection(baseline, current);
    expect(projection.changedEntityIds).toContain(current.entities[0].id);
    expect(projection.topologyChangedEntityIds).not.toContain(current.entities[0].id);
  });

  it("applies active records and live aggregates without overwriting deferred history fields", () => {
    const previous = createInitialState();
    const current = structuredClone(previous);
    current.elapsedSeconds = 12;
    current.totalProduced.iron_ore = 321;
    current.productionHistory = [{
      elapsedSeconds: 12,
      productionPerMinute: { iron_ore: 999 },
      consumptionPerMinute: {},
      inventory: {},
      generationKw: 0,
      demandKw: 0,
    }];
    current.dysonPlans = { ...current.dysonPlans };
    current.entities[0].progress = 0.625;
    const projection = createSimulationProjection(previous, current);
    expect(projection.topLevel).not.toHaveProperty("productionHistory");
    expect(projection.topLevel).not.toHaveProperty("dysonPlans");
    const applied = applySimulationProjectionToState(previous, projection).state;
    expect(applied.elapsedSeconds).toBe(12);
    expect(applied.totalProduced.iron_ore).toBe(321);
    expect(applied.entities[0].progress).toBe(0.625);
    expect(applied.productionHistory).toBe(previous.productionHistory);
  });

  it("detects in-place top-level mutation from the pre-step baseline", () => {
    const current = createInitialState();
    const baseline = captureSimulationProjectionBaseline(current);
    current.totalProduced.iron_ore = 77;
    const projection = createSimulationProjection(baseline, current);
    expect(projection.topLevel.totalProduced?.iron_ore).toBe(77);
  });

  it("preserves the optimistic UI identity when a zero-time Worker ack repeats the same pause state", () => {
    const running = createInitialState();
    const paused = setPaused(running, true);
    const index = createSimulationProjectionStateIndex(paused);
    const workerProjection = structuredClone(createSimulationProjection(running, paused, { compact: true }));

    const applied = applySimulationProjectionToState(paused, workerProjection, index);

    expect(workerProjection.changedEntityIds).toEqual([]);
    expect(workerProjection.changedBeltIds).toEqual([]);
    expect(workerProjection.topLevel.paused).toBe(true);
    expect(applied.state).toBe(paused);
    expect(applied.index).toBe(index);
  });

  it("preserves identity for structurally equal projected command objects but applies real changes", () => {
    const state = createInitialState();
    const echoed = createSimulationProjection(state, state);
    echoed.topLevel = { settings: structuredClone(state.settings) };
    expect(applySimulationProjectionToState(state, echoed).state).toBe(state);

    const changed = structuredClone(echoed);
    changed.topLevel.settings = { ...state.settings, reducedMotion: !state.settings.reducedMotion };
    const applied = applySimulationProjectionToState(state, changed).state;
    expect(applied).not.toBe(state);
    expect(applied.settings.reducedMotion).toBe(!state.settings.reducedMotion);
  });

  it("round-trips the compact columnar encoding without full changed records", () => {
    const previous = createInitialState();
    const current = structuredClone(previous);
    current.elapsedSeconds = 3;
    current.entities[0].progress = 0.375;
    current.entities[0].outputs.iron_ore = 4;
    const projection = createSimulationProjection(previous, current, { compact: true });
    expect(projection.changedEntities).toEqual([]);
    expect(projection.entityColumns.progress).toEqual([[0, 0.375]]);
    expect(applySimulationProjectionToState(previous, projection).state).toEqual(current);
  });

  it("publishes every unchanged record after an active-planet switch", () => {
    const previous = createInitialState();
    const frostEntity = { ...structuredClone(previous.entities[0]), id: "frost-static-node", planetId: "frost" as const };
    previous.entities.push(frostEntity);
    const current = structuredClone(previous);
    current.activePlanetId = "frost";
    const projection = createSimulationProjection(previous, current, { compact: true });
    const frostEntityIds = current.entities
      .filter((entity) => entity.planetId === "frost")
      .map((entity) => entity.id);
    expect(projection.requiresFullSnapshot).toBe(true);
    expect(projection.changedEntityIds).toEqual(frostEntityIds);
    expect(projection.changedEntities.map((entity) => entity.id)).toEqual(frostEntityIds);
    expect(projection.changedEntityIds).toContain(frostEntity.id);
    const applied = applySimulationProjectionToState(previous, projection).state;
    expect(applied.activePlanetId).toBe("frost");
    expect(applied.entities.find((entity) => entity.id === frostEntity.id)).toEqual(frostEntity);
  });

  it("includes deferred history and Dyson plans only for an explicit live workspace scope", () => {
    const previous = createInitialState();
    const current = structuredClone(previous);
    current.productionHistory = [{
      elapsedSeconds: 10,
      productionPerMinute: { iron_ore: 6 },
      consumptionPerMinute: {},
      inventory: {},
      generationKw: 0,
      demandKw: 0,
    }];
    current.dysonPlans.helios.structurePoints = 123;
    const defaultProjection = createSimulationProjection(previous, current, { compact: true });
    const workspaceProjection = createSimulationProjection(previous, current, {
      compact: true,
      includeDeferredTopLevel: true,
    });
    expect(defaultProjection.topLevel).not.toHaveProperty("productionHistory");
    expect(defaultProjection.topLevel).not.toHaveProperty("dysonPlans");
    expect(workspaceProjection.topLevel.productionHistory).toEqual(current.productionHistory);
    expect(workspaceProjection.topLevel.dysonPlans?.helios.structurePoints).toBe(123);
  });

  it("force-refreshes deferred workspaces without publishing any entity or belt record", () => {
    const stale = createInitialState();
    const authoritative = structuredClone(stale);
    authoritative.productionHistory = [{
      elapsedSeconds: 33,
      productionPerMinute: { iron_ore: 44 },
      consumptionPerMinute: {},
      inventory: {},
      generationKw: 0,
      demandKw: 0,
    }];
    authoritative.dysonPlans.helios.structurePoints = 987;
    authoritative.entities[0].progress = 0.875;
    const projection = createDeferredTopLevelSimulationProjection(authoritative);
    expect(projection.changedEntities).toEqual([]);
    expect(projection.changedBelts).toEqual([]);
    expect(Object.keys(projection.topLevel).sort()).toEqual(["dysonPlans", "productionHistory"]);
    const applied = applySimulationProjectionToState(stale, projection).state;
    expect(applied.productionHistory).toEqual(authoritative.productionHistory);
    expect(applied.dysonPlans).toEqual(authoritative.dysonPlans);
    expect(applied.entities).toBe(stale.entities);
    expect(applied.entities[0].progress).toBe(stale.entities[0].progress);
  });

  it("publishes an exact current planet and deferred top level after durable replay", () => {
    const authoritative = createInitialState();
    const frostEntity = { ...structuredClone(authoritative.entities[0]), id: "frost-recovered-node", planetId: "frost" as const };
    authoritative.entities.push(frostEntity);
    authoritative.activePlanetId = "frost";
    authoritative.entities.find((entity) => entity.id === frostEntity.id)!.progress = 0.875;
    authoritative.entities.find((entity) => entity.planetId === "home")!.progress = 0.75;
    authoritative.productionHistory = [{
      elapsedSeconds: 42,
      productionPerMinute: { iron_ore: 99 },
      consumptionPerMinute: {},
      inventory: {},
      generationKw: 0,
      demandKw: 0,
    }];
    const stale = structuredClone(authoritative);
    stale.activePlanetId = "home";
    stale.entities.find((entity) => entity.id === frostEntity.id)!.progress = 0;
    stale.entities.find((entity) => entity.planetId === "home")!.progress = 0.125;
    stale.productionHistory = [];

    const projection = createFullCurrentPlanetSimulationProjection(authoritative);
    const applied = applySimulationProjectionToState(stale, projection).state;
    expect(projection.requiresFullSnapshot).toBe(true);
    expect(projection.changedEntityIds).toContain(frostEntity.id);
    expect(projection.changedEntityIds).not.toContain(authoritative.entities.find((entity) => entity.planetId === "home")!.id);
    expect(applied.activePlanetId).toBe("frost");
    expect(applied.entities.find((entity) => entity.id === frostEntity.id)?.progress).toBe(0.875);
    expect(applied.entities.find((entity) => entity.planetId === "home")?.progress).toBe(0.125);
    expect(applied.productionHistory).toEqual(authoritative.productionHistory);
    expect(applied.dysonPlans).toEqual(authoritative.dysonPlans);
  });

  it("streams a full durable-replay projection in bounded ordered chunks", () => {
    const authoritative = createInitialState();
    const template = structuredClone(authoritative.entities[0]);
    for (let index = 0; index < 9; index += 1) {
      authoritative.entities.push({ ...structuredClone(template), id: `chunk-entity-${index}`, progress: index / 10 });
    }
    const stale = structuredClone(authoritative);
    for (const entity of stale.entities) entity.progress = 0;
    authoritative.elapsedSeconds = 77;
    authoritative.productionHistory = [{
      elapsedSeconds: 77,
      productionPerMinute: { iron_ore: 12 },
      consumptionPerMinute: {},
      inventory: {},
      generationKw: 0,
      demandKw: 0,
    }];
    const projection = createFullCurrentPlanetSimulationProjection(authoritative);
    const chunks = chunkFullRecordSimulationProjection(projection, { entityChunkSize: 3, beltChunkSize: 2 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every((chunk) => chunk.total === chunks.length)).toBe(true);
    expect(chunks.slice(1).every((chunk) => Object.keys(chunk.projection.topLevel).length === 0)).toBe(true);
    expect(chunks.every((chunk) => chunk.projection.changedEntities.length <= 3)).toBe(true);
    expect(chunks.every((chunk) => chunk.projection.changedBelts.length <= 2)).toBe(true);
    const applied = chunks.reduce((current, chunk) =>
      applySimulationProjectionToState(current, chunk.projection).state, stale);
    expect(applied.elapsedSeconds).toBe(77);
    expect(applied.entities).toEqual(authoritative.entities);
    expect(applied.belts).toEqual(authoritative.belts);
    expect(applied.productionHistory).toEqual(authoritative.productionHistory);
  });
});
