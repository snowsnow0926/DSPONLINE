import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { buildFactoryEdgeRouteCenters, reconcileFactoryCanvasTopology } from "./canvasTopology";

describe("factory canvas topology", () => {
  it("reuses topology when only runtime telemetry changes", () => {
    const state = createInitialState();
    const entities = state.entities.filter((entity) => entity.planetId === state.activePlanetId);
    const previous = reconcileFactoryCanvasTopology(null, state.activePlanetId, entities, []);
    const changedTelemetry = entities.map((entity) => ({ ...entity, progress: entity.progress + 0.5, outputs: { ...entity.outputs, iron_ore: 42 } }));
    const next = reconcileFactoryCanvasTopology(previous, state.activePlanetId, changedTelemetry, []);
    expect(next).toBe(previous);
  });

  it("skips full signatures when an explicit topology revision is unchanged", () => {
    const state = createInitialState();
    const entities = state.entities.filter((entity) => entity.planetId === state.activePlanetId);
    const previous = reconcileFactoryCanvasTopology(null, state.activePlanetId, entities, [], 7);
    const runtimeOnly = entities.map((entity) => ({ ...entity, progress: entity.progress + 1 }));
    expect(reconcileFactoryCanvasTopology(previous, state.activePlanetId, runtimeOnly, [], 7)).toBe(previous);
    expect(reconcileFactoryCanvasTopology(previous, state.activePlanetId, runtimeOnly, [], 8)).not.toBe(previous);
  });

  it("rebuilds stable occupancy and route geometry after topology changes", () => {
    const state = createInitialState();
    const [source, target, blocker] = state.entities.slice(0, 3);
    source.position = { x: 0, y: 0 };
    target.position = { x: 900, y: 0 };
    blocker.position = { x: 420, y: 0 };
    const belt = {
      id: "belt_canvas_cache",
      planetId: state.activePlanetId,
      source: source.id,
      target: target.id,
      itemId: source.resourceId ?? "iron_ore",
      tier: 1 as const,
      sorterTier: 1 as const,
      lanes: 4,
      stackSize: 2 as const,
      priority: 1 as const,
      routeMode: "auto" as const,
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    };
    const topology = reconcileFactoryCanvasTopology(null, state.activePlanetId, [source, target, blocker], [belt]);
    expect(topology.occupancy.output.get(source.id)?.[belt.itemId]).toBe(4);
    expect(topology.connectedInputsByTarget.get(target.id)).toEqual([belt.itemId]);
    const centers = buildFactoryEdgeRouteCenters(topology, [
      { id: source.id, x: 0, y: 0, width: 256, height: 180 },
      { id: target.id, x: 900, y: 0, width: 256, height: 180 },
      { id: blocker.id, x: 420, y: 0, width: 256, height: 180 },
    ], false);
    expect(centers.get(belt.id)).toBeLessThan(0);
    const moved = [{ ...source, position: { x: 20, y: 0 } }, target, blocker];
    const next = reconcileFactoryCanvasTopology(topology, state.activePlanetId, moved, [belt]);
    expect(next).not.toBe(topology);
    expect(next.entities.find((entity) => entity.id === source.id)).toMatchObject({ x: 20, y: 0 });
    expect(topology.entities.find((entity) => entity.id === source.id)).toMatchObject({ x: 0, y: 0 });
  });

  it("publishes connection counts immediately from topology before any cargo tick", () => {
    const state = createInitialState();
    const [source, target] = state.entities.slice(0, 2);
    const empty = reconcileFactoryCanvasTopology(null, state.activePlanetId, [source, target], []);
    expect(empty.occupancy.output.get(source.id)).toBeUndefined();

    const belt = {
      id: "zero-tick-line",
      planetId: state.activePlanetId,
      source: source.id,
      target: target.id,
      itemId: source.resourceId ?? "iron_ore" as const,
      tier: 1 as const,
      sorterTier: 1 as const,
      lanes: 3,
      priority: 1 as const,
      progress: 0,
      totalTransferred: 0,
      lastFlow: 0,
      congestion: 0,
    };
    const connected = reconcileFactoryCanvasTopology(empty, state.activePlanetId, [source, target], [belt]);

    expect(connected.occupancy.output.get(source.id)?.[belt.itemId]).toBe(3);
    expect(connected.occupancy.input.get(target.id)?.[belt.itemId]).toBe(3);
    expect(connected.connectedInputsByTarget.get(target.id)).toEqual([belt.itemId]);
  });
});
