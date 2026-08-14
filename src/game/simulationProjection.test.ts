import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { applySimulationProjectionToState, captureSimulationProjectionBaseline, createSimulationProjection } from "./simulationProjection";

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
});
