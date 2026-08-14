import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { applySimulationStateDelta, createSimulationStateDelta, shouldUseSimulationDelta } from "./simulationDelta";

describe("experimental simulation delta protocol", () => {
  it("round-trips changed runtime records and top-level state without changing order", () => {
    const previous = createInitialState();
    const current = structuredClone(previous);
    current.elapsedSeconds = 42;
    current.entities[0].progress = 0.75;
    const delta = createSimulationStateDelta(previous, current, 7, 8);
    const applied = applySimulationStateDelta(previous, delta);
    expect(applied).toEqual(current);
    expect(applied.entities.map((entity) => entity.id)).toEqual(current.entities.map((entity) => entity.id));
  });

  it("reports removals and additions without duplicating records", () => {
    const previous = createInitialState();
    const current = structuredClone(previous);
    const removed = current.entities.shift()!;
    current.entities.push({ ...removed, id: "new-entity", progress: 0.2 });
    const delta = createSimulationStateDelta(previous, current, 1, 2);
    const applied = applySimulationStateDelta(previous, delta);
    expect(applied.entities.some((entity) => entity.id === removed.id)).toBe(false);
    expect(applied.entities.filter((entity) => entity.id === "new-entity")).toHaveLength(1);
  });

  it("never duplicates entity or belt arrays inside top-level fields", () => {
    const previous = createInitialState();
    const current = structuredClone(previous);
    current.entities[0].progress = 0.5;
    const delta = createSimulationStateDelta(previous, current, 2, 3);
    expect(delta.topLevel).not.toHaveProperty("entities");
    expect(delta.topLevel).not.toHaveProperty("belts");
  });

  it("detects mutations when callers capture an alias-safe pre-step snapshot", () => {
    const runtime = createInitialState();
    const previous = structuredClone(runtime);
    runtime.entities[0].progress = 0.875;
    const delta = createSimulationStateDelta(previous, runtime, 3, 4);
    expect(delta.changedEntities.map((entity) => entity.id)).toContain(runtime.entities[0].id);
  });

  it("rejects a delta when changing most records would be larger than full state", () => {
    const previous = createInitialState();
    previous.entities = Array.from({ length: 96 }, (_, index) => ({
      ...previous.entities[0],
      id: `entity_${index}`,
      position: { x: index, y: -index },
      inputs: { iron_ore: index + 1 },
      outputs: { iron_ingot: index + 2 },
    }));
    const current = structuredClone(previous);
    current.entities = current.entities.map((entity, index) => ({
      ...entity,
      inputs: { iron_ore: index + 10, copper_ore: index + 20 },
      outputs: { iron_ingot: index + 30, copper_ingot: index + 40 },
      statusMessage: `changed-${index}-${"x".repeat(80)}`,
    }));
    current.totalProduced = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`custom_${index}`, index + 1]),
    ) as typeof current.totalProduced;
    const delta = createSimulationStateDelta(previous, current, 10, 11);
    const oversized = {
      ...delta,
      changedEntities: Array.from({ length: 1_000 }, (_, index) => ({
        ...current.entities[0],
        id: `duplicate_${index}`,
        statusMessage: "x".repeat(200),
      })),
    };
    expect(shouldUseSimulationDelta(current, oversized)).toBe(false);
  });
});
