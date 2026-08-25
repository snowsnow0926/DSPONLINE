import { describe, expect, it } from "vitest";
import {
  PERSISTENT_SIMULATION_DIRTY_ID_LIMIT,
  advancePersistentSimulationRuntime,
  clearPersistentSimulationRuntimeDirty,
  createInitialState,
  createPersistentSimulationRuntime,
  markPersistentSimulationRuntimeDirty,
} from "./engine";

describe("persistent simulation runtime indexes", () => {
  it("keeps stable ID indexes while paused without retaining the full simulation lookup", () => {
    const state = createInitialState(11_903, false);
    state.paused = true;
    const runtime = createPersistentSimulationRuntime(state);

    expect(runtime.lookup).toBeUndefined();
    expect(runtime.records.entityById.get(state.entities[0].id)).toBe(state.entities[0]);
    expect(runtime.records.beltById.size).toBe(state.belts.length);
  });

  it("bounds dirty record identities and exposes an explicit lifecycle release", () => {
    const state = createInitialState(11_904, false);
    state.paused = false;
    const runtime = createPersistentSimulationRuntime(state);
    markPersistentSimulationRuntimeDirty(runtime, {
      entityIds: Array.from({ length: PERSISTENT_SIMULATION_DIRTY_ID_LIMIT + 1 }, (_, index) => `entity-${index}`),
      planetIds: [state.activePlanetId],
    });

    expect(runtime.dirty.overflowed).toBe(true);
    expect(runtime.dirty.entityIds.size).toBe(0);
    expect(runtime.dirty.beltIds.size).toBe(0);
    clearPersistentSimulationRuntimeDirty(runtime);
    expect(runtime.dirty).toMatchObject({ overflowed: false, topologyRevision: 0 });
    expect(runtime.dirty.planetIds.size).toBe(0);

    markPersistentSimulationRuntimeDirty(runtime, { entityIds: [state.entities[0].id] });
    advancePersistentSimulationRuntime(runtime, 0, 0);
    expect(runtime.dirty.entityIds.size).toBe(0);
  });
});
