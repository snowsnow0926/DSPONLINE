import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import {
  applySimulationCommandPatch,
  createSimulationCommandPatch,
  deserializeSimulationStateTransfer,
  serializeSimulationStateCheckpoint,
  serializeSimulationStateForTransfer,
  validateSimulationStateCheckpoint,
} from "./simulationRuntimeProtocol";

describe("authoritative simulation runtime protocol", () => {
  it("transfers an exact state through a transferable UTF-8 buffer", () => {
    const state = createInitialState(14_044);
    state.entities[0].inputs = { iron_ore: 123 };
    const transfer = serializeSimulationStateForTransfer(state);
    expect(transfer.byteLength).toBeGreaterThan(0);
    expect(deserializeSimulationStateTransfer(transfer)).toEqual(state);
  });

  it("creates a JSON-canonical checkpoint mirror and validates its transfer envelope", () => {
    const state = createInitialState(14_044) as ReturnType<typeof createInitialState> & { optionalDebug?: string };
    state.optionalDebug = undefined;
    const { checkpoint, checkpointState } = serializeSimulationStateCheckpoint(state);
    expect(validateSimulationStateCheckpoint(checkpoint, checkpointState)).toEqual(JSON.parse(JSON.stringify(state)));
    expect("optionalDebug" in checkpointState).toBe(false);
    expect(() => validateSimulationStateCheckpoint({ ...checkpoint, protocolVersion: 99 as 1 }, checkpointState)).toThrow(/协议/);
    expect(() => validateSimulationStateCheckpoint({ ...checkpoint, byteLength: checkpoint.byteLength + 1 }, checkpointState)).toThrow(/长度/);
    expect(() => validateSimulationStateCheckpoint(checkpoint, undefined)).toThrow(/结构/);
    expect(() => validateSimulationStateCheckpoint(checkpoint, { entities: [], belts: null })).toThrow(/结构/);
  });

  it("sanitizes legacy null production-history samples at transfer and checkpoint boundaries", () => {
    const state = createInitialState(14_044);
    const validSample = {
      elapsedSeconds: 1,
      sampleDurationSeconds: 1,
      productionPerMinute: { iron_ore: 60 },
      consumptionPerMinute: {},
      inventory: {},
      generationKw: 0,
      demandKw: 0,
    };
    state.productionHistory = [null as never, validSample];

    const transferred = deserializeSimulationStateTransfer(serializeSimulationStateForTransfer(state));
    const checkpoint = serializeSimulationStateCheckpoint(state);
    expect(transferred.productionHistory).toEqual([validSample]);
    expect(validateSimulationStateCheckpoint(checkpoint.checkpoint, checkpoint.checkpointState).productionHistory)
      .toEqual([validSample]);
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

  it("never writes runtime-owned production history through UI or legacy durable commands", () => {
    const workerCurrent = createInitialState(14_044);
    workerCurrent.productionHistory = [{
      elapsedSeconds: 12,
      sampleDurationSeconds: 1,
      productionPerMinute: { iron_ore: 60 },
      consumptionPerMinute: {},
      inventory: {},
      generationKw: 0,
      demandKw: 0,
    }];
    workerCurrent.historyRecordedAt = 12;
    const staleUi = structuredClone(workerCurrent);
    staleUi.paused = !staleUi.paused;
    staleUi.productionHistory = [undefined as never];
    staleUi.historyRecordedAt = 0;

    const patch = createSimulationCommandPatch(workerCurrent, staleUi, 9)!;
    expect(patch.topLevelChanges.some((change) =>
      change.path[0] === "productionHistory" || change.path[0] === "historyRecordedAt")).toBe(false);

    const legacyCanonicalPatch = JSON.parse(JSON.stringify({
      ...patch,
      topLevelChanges: [
        ...patch.topLevelChanges,
        { path: ["productionHistory", 0], operation: "set", value: undefined },
        { path: ["historyRecordedAt"], operation: "set", value: 0 },
      ],
    })) as typeof patch;
    const applied = applySimulationCommandPatch(workerCurrent, legacyCanonicalPatch);
    expect(applied.paused).toBe(staleUi.paused);
    expect(applied.productionHistory).toEqual(workerCurrent.productionHistory);
    expect(applied.historyRecordedAt).toBe(12);
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
