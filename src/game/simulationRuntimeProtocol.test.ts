import { describe, expect, it } from "vitest";
import { createInitialState, placeBuilding, removeEntity } from "./engine";
import { collectGameStateEditLineage } from "./gameStateEditLineage";
import {
  applySimulationCommandPatch,
  applySimulationCommandPatchMutable,
  createSimulationStateIdentity,
  createSimulationCommandPatch,
  deserializeSimulationStateTransfer,
  serializeSimulationStateCheckpoint,
  serializeSimulationStateForTransfer,
  validateSimulationStateCheckpoint,
  validateSimulationStateTransferIdentity,
} from "./simulationRuntimeProtocol";

describe("authoritative simulation runtime protocol", () => {
  it("transfers an exact state through a transferable UTF-8 buffer", () => {
    const state = createInitialState(14_044);
    state.entities[0].inputs = { iron_ore: 123 };
    const transfer = serializeSimulationStateForTransfer(state);
    expect(transfer.byteLength).toBeGreaterThan(0);
    expect(deserializeSimulationStateTransfer(transfer)).toEqual(state);
  });

  it("keeps native JSON bytes for large record arrays, Unicode boundaries and optional extension fields", () => {
    const state = createInitialState(14_044);
    state.entities = Array.from({ length: 2_000 }, (_, index) => ({
      ...state.entities[0], id: `record-${index}`, inputs: { iron_ore: index },
      extensionText: `${"a".repeat(index % 97)}工厂🌌\ud800\n\"\\`,
      extensionAbsent: undefined,
    }));
    Object.assign(state, {
      extensionMissing: undefined,
      extensionArray: [undefined, , null, -0, NaN, Infinity, { toJSON(key: string) { return `row:${key}`; } }],
      extensionObject: { 2: "numeric key", "a\"b": "escape", empty: {} },
    });
    const expected = new TextEncoder().encode(JSON.stringify(state));
    const transfer = serializeSimulationStateForTransfer(state);
    expect(new Uint8Array(transfer.buffer)).toEqual(expected);
    expect(transfer.byteLength).toBe(expected.byteLength);
    expect(state.entities).toHaveLength(2_000);
    expect(Object.hasOwn(state.entities[0], "extensionAbsent")).toBe(true);
  });

  it("preserves native array and root toJSON handling without invoking them twice", () => {
    const state = createInitialState(14_044);
    let calls = 0;
    Object.assign(state, {
      extensionArray: Object.assign([1, 2], { toJSON(key: string) { calls += 1; return { key, value: 3 }; } }),
    });
    const expected = JSON.stringify(state);
    calls = 0;
    expect(new TextDecoder().decode(serializeSimulationStateForTransfer(state).buffer)).toBe(expected);
    expect(calls).toBe(1);
    Object.assign(state, { toJSON(key: string) { return { key, entities: [], belts: [] }; } });
    expect(new TextDecoder().decode(serializeSimulationStateForTransfer(state).buffer)).toBe(JSON.stringify(state));
  });

  it("still rejects cyclic state and unsupported BigInt rather than emitting partial JSON", () => {
    const state = createInitialState(14_044);
    Object.assign(state, { extensionCycle: state });
    expect(() => serializeSimulationStateForTransfer(state)).toThrow(TypeError);
    delete (state as unknown as Record<string, unknown>).extensionCycle;
    Object.assign(state, { extensionBigInt: 1n });
    expect(() => serializeSimulationStateForTransfer(state)).toThrow(TypeError);
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

  it("validates a bounded Worker identity without decoding the checkpoint body", () => {
    const state = createInitialState(14_046);
    state.elapsedSeconds = 123;
    state.paused = false;
    const transfer = serializeSimulationStateForTransfer(state);
    const identity = createSimulationStateIdentity(state);
    expect(validateSimulationStateTransferIdentity(transfer, identity)).toEqual(identity);
    expect(() => validateSimulationStateTransferIdentity(transfer, { ...identity, entityCount: -1 })).toThrow(/身份/);
    expect(() => validateSimulationStateTransferIdentity({ ...transfer, byteLength: transfer.byteLength + 1 }, identity)).toThrow(/长度/);
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

  it("does not scan shared entity and belt arrays for a top-level-only command", () => {
    const base = createInitialState(14_046);
    let entityIdReads = 0;
    const guardedEntity = { ...base.entities[0] };
    const entityId = guardedEntity.id;
    Object.defineProperty(guardedEntity, "id", {
      configurable: true,
      enumerable: true,
      get() {
        entityIdReads += 1;
        return entityId;
      },
    });
    const entities = [guardedEntity];
    const belts = base.belts;
    const previous = { ...base, entities, belts };
    const current = {
      ...previous,
      planetViewports: {
        ...previous.planetViewports,
        [previous.activePlanetId]: { x: 321, y: 123, zoom: 0.75 },
      },
    };

    const patch = createSimulationCommandPatch(previous, current, 12);

    expect(patch?.topLevelChanges).toEqual([
      { path: ["planetViewports", previous.activePlanetId, "x"], operation: "set", value: 321 },
      { path: ["planetViewports", previous.activePlanetId, "y"], operation: "set", value: 123 },
      { path: ["planetViewports", previous.activePlanetId, "zoom"], operation: "set", value: 0.75 },
    ]);
    expect(patch?.changedEntities).toEqual([]);
    expect(patch?.changedBelts).toEqual([]);
    expect(entityIdReads).toBe(0);
  });

  it("encodes a copy-on-write edit lineage from only its touched record ids", () => {
    const previous = createInitialState(14_046);
    previous.construction.arc_smelter = 10;
    const placed = placeBuilding(previous, "arc_smelter", { x: 700, y: 800 });
    const placedId = placed.entities.at(-1)!.id;
    const lineage = collectGameStateEditLineage(previous, placed);
    expect(lineage?.entityIds).toEqual(new Set([placedId]));
    expect(lineage?.beltIds).toEqual(new Set());

    const placementPatch = createSimulationCommandPatch(previous, placed, 21)!;
    expect(placementPatch.addedEntities).toHaveLength(1);
    expect(placementPatch.addedEntities[0].value.id).toBe(placedId);
    expect(placementPatch.changedEntities).toEqual([]);
    expect(applySimulationCommandPatch(previous, placementPatch)).toEqual(placed);

    const removed = removeEntity(placed, placedId);
    const chained = collectGameStateEditLineage(previous, removed);
    expect(chained?.depth).toBe(2);
    expect(chained?.entityIds).toEqual(new Set([placedId]));
    const chainedPatch = createSimulationCommandPatch(previous, removed, 22)!;
    expect(chainedPatch.addedEntities).toEqual([]);
    expect(chainedPatch.removedEntityIds).toEqual([]);
    expect(applySimulationCommandPatch(previous, chainedPatch)).toEqual(removed);
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

  it("mutates runtime-only leaves in place without invalidating topology indexes", () => {
    const previous = createInitialState(14_044);
    const desired = structuredClone(previous);
    desired.entities[0].progress = 0.75;
    desired.entities[0].inputs.iron_ore = 42;
    const patch = createSimulationCommandPatch(previous, desired, 9)!;
    const authority = structuredClone(previous);
    const entityReference = authority.entities[0];

    const entityById = new Map(authority.entities.map((entity) => [entity.id, entity]));
    const result = applySimulationCommandPatchMutable(authority, patch, { entityById });

    expect(result.topologyDirty).toBe(false);
    expect(result.changedEntityIds).toEqual([entityReference.id]);
    expect(result.state.entities[0]).toBe(entityReference);
    expect(result.state.entities[0].progress).toBe(0.75);
    expect(result.state.entities[0].inputs.iron_ore).toBe(42);
    expect(entityById.get(entityReference.id)).toBe(entityReference);
  });

  it("marks index-sensitive commands dirty while preserving exact patch semantics", () => {
    const previous = createInitialState(14_044);
    const desired = structuredClone(previous);
    desired.entities[0].recipeId = desired.entities[0].recipeId === "iron_ingot" ? "copper_ingot" : "iron_ingot";
    const patch = createSimulationCommandPatch(previous, desired, 3)!;
    const authority = structuredClone(previous);

    const result = applySimulationCommandPatchMutable(authority, patch);

    expect(result.topologyDirty).toBe(true);
    expect(result.state).toEqual(applySimulationCommandPatch(previous, patch));
  });
});
