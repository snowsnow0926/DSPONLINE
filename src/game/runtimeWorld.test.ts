import { describe, expect, it, vi } from "vitest";
import {
  advancePersistentSimulationRuntime,
  advancePersistentSimulationRuntimeResumable,
  applyPersistentSimulationRuntimeCommand,
  createInitialState,
  createPersistentSimulationRuntime,
  createSimulationProfiler,
} from "./engine";
import {
  applyRuntimeWorldCommand,
  commitRuntimeWorldProjection,
  createRuntimeWorld,
  replaceRuntimeWorldState,
  resolveRuntimeWorldSlot,
  RuntimeWorldDirtyBitset,
  runtimeWorldJournalSince,
} from "./runtimeWorld";
import { applySimulationProjectionToState } from "./simulationProjection";
import { createSimulationCommandPatch } from "./simulationRuntimeProtocol";
import type { GameState } from "./types";

function command(previous: GameState, current: GameState, revision = 1) {
  const patch = createSimulationCommandPatch(previous, current, revision);
  expect(patch).not.toBeNull();
  return patch!;
}

describe("RuntimeWorld 2 stable adapter", () => {
  it("uses a growable exact dirty bitset", () => {
    const dirty = new RuntimeWorldDirtyBitset();
    dirty.mark(0);
    dirty.mark(31);
    dirty.mark(32);
    dirty.mark(1_024);
    dirty.mark(32);
    expect(dirty.size).toBe(4);
    expect(dirty.values()).toEqual([0, 31, 32, 1_024]);
    expect(dirty.has(33)).toBe(false);
    dirty.clear();
    expect(dirty.values()).toEqual([]);
  });

  it("invalidates stale slot references when a freed slot is reused", () => {
    const initial = createInitialState();
    const world = createRuntimeWorld(initial);
    const removed = initial.entities[0];
    const reference = {
      index: world.entities.byId.get(removed.id)!,
      generation: world.entities.slots[world.entities.byId.get(removed.id)!].generation,
    };
    const without = { ...initial, entities: initial.entities.slice(1) };
    replaceRuntimeWorldState(world, without);
    expect(resolveRuntimeWorldSlot(world.entities, reference)).toBeUndefined();

    const replacement = { ...structuredClone(removed), id: "runtimeworld-replacement" };
    replaceRuntimeWorldState(world, { ...without, entities: [replacement, ...without.entities] });
    expect(resolveRuntimeWorldSlot(world.entities, reference)).toBeUndefined();
    const replacementIndex = world.entities.byId.get(replacement.id)!;
    expect(replacementIndex).toBe(reference.index);
    expect(world.entities.slots[replacementIndex].generation).toBeGreaterThan(reference.generation);
  });

  it("keeps all lookup identities for a top-level presentation command", () => {
    const runtime = createPersistentSimulationRuntime(createInitialState());
    const previous = runtime.state;
    const lookup = runtime.lookup;
    const entityArray = previous.entities;
    const beltArray = previous.belts;
    const desired = {
      ...previous,
      planetViewports: {
        ...previous.planetViewports,
        [previous.activePlanetId]: {
          ...previous.planetViewports[previous.activePlanetId],
          x: previous.planetViewports[previous.activePlanetId].x + 17,
        },
      },
    };
    const result = applyPersistentSimulationRuntimeCommand(runtime, command(previous, desired));
    expect(result.cacheRebuilt).toBe(false);
    expect(runtime.lookup).toBe(lookup);
    expect(runtime.state.entities).toBe(entityArray);
    expect(runtime.state.belts).toBe(beltArray);
    expect(runtime.state).toEqual(desired);
  });

  it("updates one stable entity slot without rebuilding the lookup", () => {
    const runtime = createPersistentSimulationRuntime(createInitialState());
    const previous = runtime.state;
    const entity = previous.entities[0];
    const lookup = runtime.lookup;
    const desired = {
      ...previous,
      entities: previous.entities.map((candidate) => candidate.id === entity.id
        ? { ...candidate, interactionLocked: !candidate.interactionLocked }
        : candidate),
    };
    const result = applyPersistentSimulationRuntimeCommand(runtime, command(previous, desired));
    expect(result.cacheRebuilt).toBe(false);
    expect(runtime.lookup).toBe(lookup);
    expect(runtime.state.entities[0]).toBe(entity);
    expect(runtime.lookup?.entityById.get(entity.id)).toBe(entity);
    expect(entity.interactionLocked).toBe(desired.entities[0].interactionLocked);
    expect(runtime.world.entityDirty.size).toBe(1);
  });

  it("rebuilds only at an explicit power-grid invalidation boundary", () => {
    const runtime = createPersistentSimulationRuntime(createInitialState());
    const previous = runtime.state;
    const lookup = runtime.lookup;
    const desired = {
      ...previous,
      entities: previous.entities.map((entity, index) => index === 0
        ? { ...entity, powerGridId: "runtimeworld-grid" }
        : entity),
    } as GameState;
    const profiler = createSimulationProfiler();
    const result = applyPersistentSimulationRuntimeCommand(runtime, command(previous, desired), profiler);
    expect(result.cacheRebuilt).toBe(true);
    expect(result.invalidatedDomains).toEqual(expect.arrayContaining(["power", "production"]));
    expect(runtime.lookup).not.toBe(lookup);
    expect(profiler.compileMs).toBeGreaterThanOrEqual(0);
    expect(profiler.commandApplyMs).toBeGreaterThanOrEqual(0);
    expect(profiler.domainInvalidationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not invoke the M0 timing clock when diagnostics are off", () => {
    const initial = createInitialState();
    const world = createRuntimeWorld(initial);
    const desired = { ...initial, paused: !initial.paused };
    const clock = vi.spyOn(performance, "now");
    applyRuntimeWorldCommand(world, command(initial, desired));
    expect(clock).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it("derives an exact compact projection from journal candidates", () => {
    const initial = createInitialState();
    const world = createRuntimeWorld(initial);
    const current = structuredClone(initial);
    current.elapsedSeconds += 1;
    current.entities[0].progress = 0.625;
    current.entities[0].outputs.iron_ore = 9;
    const committed = commitRuntimeWorldProjection(world, current, {
      compact: true,
      compareWithProjectionV2: true,
    }, createSimulationProfiler());
    expect(committed.diagnostics).toMatchObject({
      source: "journal",
      comparedWithProjectionV2: true,
      matchedProjectionV2: true,
      candidateEntityCount: 1,
    });
    expect(committed.projection).toEqual(committed.journalProjection);
    expect(applySimulationProjectionToState(initial, committed.projection).state).toEqual(current);
    expect(world.entityDirty.size).toBe(0);
    expect(world.committedRevision).toBe(1);
  });

  it("publishes every destination record on an active-planet switch", () => {
    const initial = createInitialState();
    const destination = {
      ...structuredClone(initial.entities[0]),
      id: "runtimeworld-frost-node",
      planetId: "frost" as const,
    };
    initial.entities.push(destination);
    const world = createRuntimeWorld(initial);
    const current = { ...initial, activePlanetId: "frost" as const };
    const committed = commitRuntimeWorldProjection(world, current, {
      compact: true,
      compareWithProjectionV2: true,
    });
    expect(committed.diagnostics.matchedProjectionV2).toBe(true);
    expect(committed.projection.requiresFullSnapshot).toBe(true);
    expect(committed.projection.changedEntityIds).toContain(destination.id);
  });

  it("keeps a bounded sequenced change journal", () => {
    const initial = createInitialState();
    const world = createRuntimeWorld(initial, { maximumJournalEntries: 128 });
    for (let index = 0; index < 70; index += 1) {
      const previous = world.state;
      const current = { ...previous, paused: !previous.paused };
      applyRuntimeWorldCommand(world, command(previous, current, index));
    }
    expect(world.journal.entries).toHaveLength(128);
    expect(world.journal.droppedEntries).toBeGreaterThan(0);
    const tail = runtimeWorldJournalSince(world, world.journal.sequence - 3);
    expect(tail.map((entry) => entry.sequence)).toEqual([
      world.journal.sequence - 2,
      world.journal.sequence - 1,
      world.journal.sequence,
    ]);
  });

  it("continues only at exact engine boundaries and matches the monolithic oracle", async () => {
    const source = createInitialState();
    const legacy = createPersistentSimulationRuntime(structuredClone(source));
    const resumable = createPersistentSimulationRuntime(structuredClone(source));
    const expected = advancePersistentSimulationRuntime(legacy, 4, 4).state;
    let clockValue = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => {
      clockValue += 2;
      return clockValue;
    });
    const yielded: number[] = [];
    const actual = await advancePersistentSimulationRuntimeResumable(resumable, 4, 4, undefined, {
      maximumSliceMs: 1,
      yieldControl: async () => { yielded.push(actualBoundaryCount(resumable.state)); },
    });
    clock.mockRestore();
    expect(actual.state).toEqual(expected);
    expect(actual.safeBoundaryCount).toBe(4);
    expect(actual.yieldedBoundaryCount).toBe(3);
    expect(yielded).toHaveLength(3);
    expect(actual.maximumUnyieldedMs).toBeGreaterThan(0);
  });
});

function actualBoundaryCount(state: GameState): number {
  return Math.max(0, Math.floor(state.elapsedSeconds));
}
