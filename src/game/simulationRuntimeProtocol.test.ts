import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import {
  applySimulationCommandPatch,
  createSimulationCommandPatch,
  deserializeSimulationStateTransfer,
  serializeSimulationStateForTransfer,
} from "./simulationRuntimeProtocol";

describe("authoritative simulation runtime protocol", () => {
  it("transfers an exact state through a transferable UTF-8 buffer", () => {
    const state = createInitialState(14_044);
    state.entities[0].inputs = { iron_ore: 123 };
    const transfer = serializeSimulationStateForTransfer(state);
    expect(transfer.byteLength).toBeGreaterThan(0);
    expect(deserializeSimulationStateTransfer(transfer)).toEqual(state);
  });

  it("round-trips player commands without carrying unchanged runtime fields", () => {
    const previous = createInitialState(14_044);
    const current = structuredClone(previous);
    current.paused = !current.paused;
    current.entities[0].inputs = { ...current.entities[0].inputs, iron_ore: 25 };
    current.entities[0].interactionLocked = true;
    const patch = createSimulationCommandPatch(previous, current, 7);
    expect(patch).not.toBeNull();
    expect(patch?.baseRevision).toBe(7);
    expect(applySimulationCommandPatch(previous, patch!)).toEqual(current);
  });

  it("preserves concurrent Worker leaves that a stale UI command did not touch", () => {
    const uiBaseline = createInitialState(14_044);
    uiBaseline.entities[0].inputs = { iron_ore: 10, copper_ore: 5 };
    const uiAfterCommand = structuredClone(uiBaseline);
    uiAfterCommand.entities[0].interactionLocked = true;
    uiAfterCommand.entities[0].inputs.iron_ore = 8;
    const workerCurrent = structuredClone(uiBaseline);
    workerCurrent.entities[0].progress = 0.75;
    workerCurrent.entities[0].inputs.copper_ore = 99;

    const patch = createSimulationCommandPatch(uiBaseline, uiAfterCommand, 11)!;
    const applied = applySimulationCommandPatch(workerCurrent, patch);
    expect(applied.entities[0].interactionLocked).toBe(true);
    expect(applied.entities[0].inputs.iron_ore).toBe(8);
    expect(applied.entities[0].inputs.copper_ore).toBe(99);
    expect(applied.entities[0].progress).toBe(0.75);
  });

  it("preserves record order across additions and removals", () => {
    const previous = createInitialState(14_044);
    const current = structuredClone(previous);
    const removed = current.entities.shift()!;
    current.entities.splice(1, 0, { ...removed, id: "inserted-runtime-command" });
    const patch = createSimulationCommandPatch(previous, current, 4)!;
    const applied = applySimulationCommandPatch(previous, patch);
    expect(applied.entities).toEqual(current.entities);
  });
});
