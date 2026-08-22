import { describe, expect, it } from "vitest";
import { connectBeltToBatchDraft, connectBeltsAtomically, createBatchBeltConnectionDraft, createInitialState, getBatchBeltConnectionCheck } from "./engine";
import type { GameState } from "./types";

function fixture(): GameState {
  return {
    ...createInitialState(),
    nextId: 10,
    construction: { conveyor_belt_mk1: 10 },
    entities: [
      { id: "source", kind: "storage", buildingId: "storage_mk1", planetId: "home", position: { x: 0, y: 0 }, machineCount: 1, minerCount: 0, inputs: {}, outputs: { iron_ore: 100 }, storedItemId: "iron_ore", progress: 0 },
      { id: "target-a", kind: "storage", buildingId: "storage_mk1", planetId: "home", position: { x: 1, y: 0 }, machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0 },
      { id: "target-b", kind: "storage", buildingId: "storage_mk1", planetId: "home", position: { x: 2, y: 0 }, machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0 },
    ],
    belts: [],
    settings: { ...createInitialState().settings, defaultBeltStackSize: 1, defaultBeltRouteMode: "auto" },
  } as unknown as GameState;
}

describe("atomic batch belt connection", () => {
  it("creates every valid route with one returned state and exact material consumption", () => {
    const before = fixture();
    const result = connectBeltsAtomically(before, [
      { sourceId: "source", targetId: "target-a", itemId: "iron_ore", lanes: 2 },
      { sourceId: "source", targetId: "target-b", itemId: "iron_ore", lanes: 3 },
    ]);
    expect(result.committed).toBe(true);
    expect(result.created).toBe(2);
    expect(result.state.belts).toHaveLength(2);
    expect(result.state.construction.conveyor_belt_mk1).toBe(5);
    expect(before.belts).toHaveLength(0);
    expect(before.construction.conveyor_belt_mk1).toBe(10);
  });

  it("aborts the complete batch when one route is invalid or stock is insufficient", () => {
    const before = fixture();
    const result = connectBeltsAtomically(before, [
      { sourceId: "source", targetId: "target-a", itemId: "iron_ore", lanes: 6 },
      { sourceId: "source", targetId: "target-b", itemId: "iron_ore", lanes: 6 },
    ]);
    expect(result.committed).toBe(false);
    expect(result.state).toBe(before);
    expect(result.state.belts).toHaveLength(0);
    expect(result.state.construction.conveyor_belt_mk1).toBe(10);
    expect(result.failures[0]?.code).toBe("missing-belt");
  });

  it("rejects duplicate endpoints without partially configuring target slots", () => {
    const before = fixture();
    const result = connectBeltsAtomically(before, [
      { sourceId: "source", targetId: "target-a", itemId: "iron_ore" },
      { sourceId: "source", targetId: "target-a", itemId: "iron_ore" },
    ]);
    expect(result.committed).toBe(false);
    expect(result.state).toBe(before);
    expect(before.entities.find((entity) => entity.id === "target-a")?.storedItemId).toBeUndefined();
    expect(result.failures).toEqual([{ index: 1, code: "duplicate", label: "批量预览包含重复线路" }]);
  });

  it("commits 10, 50, 100, 500 and 1,000 routes in one immutable transaction", () => {
    for (const routeCount of [10, 50, 100, 500, 1_000]) {
      const before = fixture();
      before.construction.conveyor_belt_mk1 = routeCount;
      before.entities = [before.entities[0], ...Array.from({ length: routeCount }, (_, index) => ({
        ...before.entities[1],
        id: `target-${index}`,
        position: { x: index + 1, y: 0 },
      }))];
      const result = connectBeltsAtomically(before, Array.from({ length: routeCount }, (_, index) => ({
        sourceId: "source",
        targetId: `target-${index}`,
        itemId: "iron_ore" as const,
      })));
      expect(result).toMatchObject({ committed: true, created: routeCount, skipped: 0, failures: [] });
      expect(result.state.belts).toHaveLength(routeCount);
      expect(result.state.construction.conveyor_belt_mk1).toBe(0);
      expect(before.belts).toHaveLength(0);
      expect(before.construction.conveyor_belt_mk1).toBe(routeCount);
    }
  });

  it("appends a continuous preview to one isolated draft without touching the source", () => {
    const before = fixture();
    before.construction.conveyor_belt_mk1 = 3;
    before.entities = [before.entities[0], ...Array.from({ length: 3 }, (_, index) => ({
      ...before.entities[1],
      id: `target-${index}`,
      position: { x: index + 1, y: 0 },
    }))];
    const draft = createBatchBeltConnectionDraft(before);
    expect(draft).not.toBe(before);
    for (let index = 0; index < 3; index += 1) {
      const request = { sourceId: "source", targetId: `target-${index}`, itemId: "iron_ore" as const };
      expect(getBatchBeltConnectionCheck(draft, request)).toMatchObject({ ok: true });
      const result = connectBeltToBatchDraft(draft, request);
      expect(result.state).toBe(draft);
      expect(result.beltId).toBe(`belt_${10 + index}`);
    }
    expect(draft.belts).toHaveLength(3);
    expect(draft.construction.conveyor_belt_mk1).toBe(0);
    expect(before.belts).toHaveLength(0);
    expect(before.construction.conveyor_belt_mk1).toBe(3);
  });
});
