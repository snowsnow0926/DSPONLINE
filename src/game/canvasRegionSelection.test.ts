import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { enclosedCanvasRegionIds, moveCanvasSelection } from "./canvasRegionSelection";
import { GameStateHistory } from "./gameStateHistory";
import type { CanvasRegion } from "./types";

const region: CanvasRegion = { id: "r1", planetId: "home", name: "钢铁", x: -100, y: -100,
  width: 700, height: 500, fillColor: "#102030", borderColor: "#abcdef" };

describe("production regions in a node selection", () => {
  it("requires the full region in either box direction and filters other planets", () => {
    const regions: CanvasRegion[] = [region, { ...region, id: "r2", planetId: "moon" as CanvasRegion["planetId"] }];
    expect(enclosedCanvasRegionIds(regions, "home", { x: 600, y: 400 }, { x: -100, y: -100 })).toEqual(["r1"]);
    expect(enclosedCanvasRegionIds(regions, "home", { x: -99, y: -100 }, { x: 600, y: 400 })).toEqual([]);
    expect(enclosedCanvasRegionIds(regions, "home", { x: NaN, y: 0 }, { x: 600, y: 400 })).toEqual([]);
  });

  it("moves labels and unlocked nodes in one undo/redo entry without changing inventory or connections", () => {
    const state = createInitialState(129, false);
    state.canvasRegions = [region, { ...region, id: "outside", x: 2000 }];
    const first = state.entities[0];
    first.interactionLocked = false;
    const before = structuredClone(state);
    const moved = moveCanvasSelection(state, [{ id: first.id, position: { x: first.position.x + 20, y: first.position.y - 40 } }],
      [region], { x: 20, y: -40 });
    expect(state).toEqual(before);
    expect(moved.canvasRegions[0]).toEqual({ ...region, x: -80, y: -140 });
    expect(moved.canvasRegions[1]).toBe(state.canvasRegions[1]);
    expect(moved.belts).toBe(state.belts);
    expect(moved.construction).toBe(state.construction);
    expect(moved.entities[0]).toEqual({ ...first, position: { x: first.position.x + 20, y: first.position.y - 40 } });
    const history = new GameStateHistory();
    const committed = history.record(state, moved)!;
    expect(history.snapshot().undoCount).toBe(1);
    const undone = history.undo(committed)!;
    expect(undone.canvasRegions).toEqual(state.canvasRegions);
    expect(undone.entities).toEqual(state.entities);
    expect(history.redo(undone)!.canvasRegions).toEqual(moved.canvasRegions);
  });

  it("does not move a locked selection or apply a stale region gesture", () => {
    const state = createInitialState(129, false);
    state.canvasRegions = [region];
    const entity = state.entities[0];
    const positions = [{ id: entity.id, position: { x: 20, y: 40 } }];
    entity.interactionLocked = true;
    expect(moveCanvasSelection(state, positions, [region], { x: 20, y: 40 })).toBe(state);
    entity.interactionLocked = false;
    expect(moveCanvasSelection(state, positions, [{ ...region, width: 800 }], { x: 20, y: 40 })).toBe(state);
    expect(moveCanvasSelection(state, positions, [region], { x: Infinity, y: 40 })).toBe(state);
    expect(moveCanvasSelection(state, positions, [region], { x: 0, y: 0 })).toBe(state);
  });
});
