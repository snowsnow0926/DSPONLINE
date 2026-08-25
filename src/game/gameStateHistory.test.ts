import { describe, expect, it } from "vitest";
import { createInitialState, placeBuilding, removeEntity } from "./engine";
import { GameStateHistory } from "./gameStateHistory";

describe("GameStateHistory", () => {
  it("stores inverse commands and restores only the edited leaves", () => {
    const initial = createInitialState();
    const edited = { ...initial, paused: !initial.paused };
    const history = new GameStateHistory();
    const canonical = history.record(initial, edited);

    expect(canonical?.paused).toBe(edited.paused);
    expect(canonical?.entities).toBe(initial.entities);
    expect(history.snapshot().undoCount).toBe(1);

    const advanced = { ...canonical!, elapsedSeconds: canonical!.elapsedSeconds + 120 };
    const undone = history.undo(advanced);
    expect(undone?.paused).toBe(initial.paused);
    expect(undone?.elapsedSeconds).toBe(advanced.elapsedSeconds);

    const redone = history.redo(undone!);
    expect(redone?.paused).toBe(edited.paused);
    expect(redone?.elapsedSeconds).toBe(advanced.elapsedSeconds);
  });

  it("reuses unchanged records from a fully cloned engine-style result", () => {
    const initial = createInitialState();
    const changedId = initial.entities[0].id;
    const cloned = structuredClone(initial);
    cloned.entities[0].position.x += 20;
    const history = new GameStateHistory();
    const canonical = history.record(initial, cloned)!;

    expect(canonical.entities[0].id).toBe(changedId);
    expect(canonical.entities[0]).not.toBe(initial.entities[0]);
    expect(canonical.entities[1]).toBe(initial.entities[1]);
    expect(canonical.belts[0]).toBe(initial.belts[0]);
    expect(history.snapshot().estimatedBytes).toBeLessThan(64 * 1024);
  });

  it("enforces count and estimated-byte limits and drops redo immediately", () => {
    const initial = createInitialState();
    const history = new GameStateHistory({ entryLimit: 3, byteLimit: 8 * 1024 });
    let state = initial;
    for (let index = 0; index < 8; index += 1) {
      state = history.record(state, { ...state, elapsedSeconds: state.elapsedSeconds + 1 })!;
    }
    expect(history.snapshot().undoCount).toBeLessThanOrEqual(3);
    state = history.undo(state)!;
    expect(history.canRedo).toBe(true);
    history.record(state, { ...state, elapsedSeconds: state.elapsedSeconds + 10 });
    expect(history.canRedo).toBe(false);
  });

  it("clear releases both bounded stacks", () => {
    const initial = createInitialState();
    const history = new GameStateHistory();
    history.record(initial, { ...initial, paused: !initial.paused });
    history.clear();
    expect(history.snapshot()).toMatchObject({ undoCount: 0, redoCount: 0, estimatedBytes: 0 });
  });

  it("round-trips 1,000 edits without retaining full states or rewinding later simulation time", () => {
    const initial = createInitialState(11_905, false);
    const planetId = initial.activePlanetId;
    const start = initial.planetViewports[planetId];
    const history = new GameStateHistory({ entryLimit: 1_000, byteLimit: 64 * 1024 * 1024 });
    let state = initial;
    for (let index = 1; index <= 1_000; index += 1) {
      state = history.record(state, {
        ...state,
        planetViewports: {
          ...state.planetViewports,
          [planetId]: { ...state.planetViewports[planetId], x: start.x + index },
        },
      })!;
    }
    expect(history.snapshot().undoCount).toBe(1_000);
    state = { ...state, elapsedSeconds: state.elapsedSeconds + 456 };
    for (let index = 0; index < 1_000; index += 1) state = history.undo(state)!;
    expect(state.planetViewports[planetId].x).toBe(start.x);
    expect(state.elapsedSeconds).toBe(initial.elapsedSeconds + 456);
    for (let index = 0; index < 1_000; index += 1) state = history.redo(state)!;
    expect(state.planetViewports[planetId].x).toBe(start.x + 1_000);
    expect(state.elapsedSeconds).toBe(initial.elapsedSeconds + 456);
  });

  it("derives inverse add/remove commands from the forward delta", () => {
    const initial = createInitialState(11_908, false);
    initial.construction.storage_mk1 = 1;
    const history = new GameStateHistory();
    const placed = placeBuilding(initial, "storage_mk1", { x: 90_000, y: 90_000 });
    const canonicalPlaced = history.record(initial, placed)!;
    const placedId = canonicalPlaced.entities.at(-1)!.id;

    expect(history.undo(canonicalPlaced)?.entities.some((entity) => entity.id === placedId)).toBe(false);

    const removalHistory = new GameStateHistory();
    const removed = removeEntity(canonicalPlaced, placedId);
    const canonicalRemoved = removalHistory.record(canonicalPlaced, removed)!;
    const restored = removalHistory.undo(canonicalRemoved)!;
    expect(restored.entities.at(-1)?.id).toBe(placedId);
    expect(restored.construction.storage_mk1).toBe(canonicalPlaced.construction.storage_mk1);
  });
});
