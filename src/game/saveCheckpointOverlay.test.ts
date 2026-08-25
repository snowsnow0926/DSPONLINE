import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { applyAuthoritativeSaveCheckpointOverlay } from "./saveCheckpointOverlay";

describe("authoritative save checkpoint overlay", () => {
  it("applies bounded viewport and debt leaves without mutating authority", () => {
    const state = createInitialState(1_159, false);
    const previousViewport = state.planetViewports[state.activePlanetId];
    const next = applyAuthoritativeSaveCheckpointOverlay(state, {
      planetViewports: [{ planetId: state.activePlanetId, viewport: { x: 12, y: 34, zoom: 0.75 } }],
      timeWarp: { pendingSimulationSeconds: 5, pendingWallSeconds: 2 },
    });
    expect(next).not.toBe(state);
    expect(next.planetViewports[state.activePlanetId]).toEqual({ x: 12, y: 34, zoom: 0.75 });
    expect(state.planetViewports[state.activePlanetId]).toBe(previousViewport);
    expect(next.timeWarp).toMatchObject({ pendingSimulationSeconds: 5, pendingWallSeconds: 2 });
    expect(state.timeWarp.pendingSimulationSeconds).not.toBe(5);
  });

  it("rejects unknown planets and unbounded time debt", () => {
    const state = createInitialState(1_160, false);
    expect(() => applyAuthoritativeSaveCheckpointOverlay(state, {
      planetViewports: [{ planetId: "missing" as typeof state.activePlanetId, viewport: { x: 0, y: 0, zoom: 1 } }],
    })).toThrow(/viewport/);
    expect(() => applyAuthoritativeSaveCheckpointOverlay(state, {
      timeWarp: { pendingSimulationSeconds: Number.POSITIVE_INFINITY, pendingWallSeconds: 0 },
    })).toThrow(/time warp/);
  });
});
