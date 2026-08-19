import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { createCanvasRenderSnapshot, reconcileCanvasRenderSnapshot } from "./canvasRenderSnapshot";
import { createSimulationProjection, mergeSimulationProjections } from "./simulationProjection";

describe("planet-scoped canvas render snapshots", () => {
  it("keeps the authoritative state intact while excluding other planets from the canvas", () => {
    const state = createInitialState();
    const foreign = { ...structuredClone(state.entities[0]), id: "foreign", planetId: "ashen" as const };
    state.entities.push(foreign);
    const snapshot = createCanvasRenderSnapshot(state);
    expect(snapshot.game).not.toBe(state);
    expect(snapshot.game.entities.some((entity) => entity.id === foreign.id)).toBe(false);
    expect(state.entities.some((entity) => entity.id === foreign.id)).toBe(true);
  });

  it("updates runtime records without invalidating topology or unchanged node references", () => {
    const previousState = createInitialState();
    const cache = createCanvasRenderSnapshot(previousState);
    const changed = cache.game.entities[0];
    const unchanged = cache.game.entities[1];
    const entityArray = cache.game.entities;
    const entityIndex = cache.entityById;
    const current = structuredClone(previousState);
    current.entities[0].progress += 0.25;
    const projection = createSimulationProjection(previousState, current);
    const result = reconcileCanvasRenderSnapshot(cache, current, projection);
    expect(result.fullRebuild).toBe(false);
    expect(result.topologyChanged).toBe(false);
    expect(result.snapshot.topologyRevision).toBe(cache.topologyRevision);
    expect(result.snapshot.game.entities).toBe(entityArray);
    expect(result.snapshot.entityById).toBe(entityIndex);
    expect(result.snapshot.entityById.get(changed.id)).toBe(changed);
    expect(result.snapshot.entityById.get(unchanged.id)).toBe(unchanged);
    expect(result.snapshot.entityById.get(current.entities[0].id)?.progress).toBe(current.entities[0].progress);
    expect(result.snapshot.entityById.get(current.entities[0].id)).not.toBe(current.entities[0]);
    expect(previousState.entities[0].progress).not.toBe(current.entities[0].progress);
  });

  it("removes stale optional fields while reusing only render-owned wrappers", () => {
    const previousState = createInitialState();
    previousState.entities[0].fuelItemId = "coal";
    const cache = createCanvasRenderSnapshot(previousState);
    const wrapper = cache.game.entities[0];
    const current = structuredClone(previousState);
    delete current.entities[0].fuelItemId;

    const result = reconcileCanvasRenderSnapshot(cache, current, null, { force: true });

    expect(result.snapshot.game.entities[0]).toBe(wrapper);
    expect("fuelItemId" in result.snapshot.game.entities[0]).toBe(false);
    expect(previousState.entities[0].fuelItemId).toBe("coal");
    expect(result.snapshot.recordCache.entityCount).toBe(result.snapshot.game.entities.length);
    expect(result.snapshot.recordCache.beltCount).toBe(result.snapshot.game.belts.length);
  });

  it("invalidates topology exactly when a node moves or a line is added", () => {
    const previousState = createInitialState();
    const cache = createCanvasRenderSnapshot(previousState);
    const moved = structuredClone(previousState);
    moved.entities[0].position.x += 40;
    const result = reconcileCanvasRenderSnapshot(cache, moved, createSimulationProjection(previousState, moved));
    expect(result.topologyChanged).toBe(true);
    expect(result.snapshot.topologyRevision).toBe(cache.topologyRevision + 1);
  });

  it("does not invalidate topology for a forced settings/runtime publication", () => {
    const previous = createInitialState();
    const cache = createCanvasRenderSnapshot(previous);
    const current = structuredClone(previous);
    current.settings.reducedMotion = !current.settings.reducedMotion;
    current.entities[0].progress += 0.25;
    const result = reconcileCanvasRenderSnapshot(cache, current, null, { force: true });
    expect(result.fullRebuild).toBe(true);
    expect(result.topologyChanged).toBe(false);
    expect(result.snapshot.topologyRevision).toBe(cache.topologyRevision);
  });

  it("merges intermediate worker projections and keeps the newest record", () => {
    const initial = createInitialState();
    const second = structuredClone(initial);
    second.entities[0].progress = 0.25;
    const third = structuredClone(second);
    third.entities[0].progress = 0.75;
    third.entities[1].progress = 0.5;
    const merged = mergeSimulationProjections(
      createSimulationProjection(initial, second),
      createSimulationProjection(second, third),
    );
    expect(merged.changedEntities.find((entity) => entity.id === third.entities[0].id)?.progress).toBe(0.75);
    expect(merged.changedEntityIds).toContain(third.entities[1].id);
  });

  it("offers an explicit full-state compatibility fallback", () => {
    const state = createInitialState();
    const result = reconcileCanvasRenderSnapshot(null, state, null, { enabled: false });
    expect(result.snapshot.game).toBe(state);
    expect(result.fullRebuild).toBe(true);
  });
});
