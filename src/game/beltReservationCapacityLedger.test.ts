import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceSimulationSession, completeSimulationAdvanceSession, createInitialState,
  createPersistentSimulationRuntime, createSimulationAdvanceSession, getEntityItemInputCapacity,
  getPlanetTrayItemLimit, replacePersistentSimulationRuntimeState,
  type SimulationContractExperiment, type SimulationLookupContext } from "./engine";
import type { BeltInputPortIndex, FactoryEntity, GameState, ItemId } from "./types";

const hash = (state: GameState) => createHash("sha256").update(JSON.stringify(state)).digest("hex");
const legacyReopenedFlows = [
  [0, [100, 100, 100]], [1, [1, 100, 100]],
  [7, [7, 100, 100]], [200, [100, 100, 100]],
] as const;

function storage(id: string, itemId: ItemId): FactoryEntity {
  return { id, kind: "storage", buildingId: "storage_mk1", storedItemId: itemId,
    planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
    inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0,
    routingCursor: 0, machineCount: 1, minerCount: 0 };
}

function fixture(kind: "ordinary" | "tray" | "black-hole"): GameState {
  const state = createInitialState(20_261_029, false);
  state.paused = false;
  state.entities = [];
  state.belts = [];
  const first = storage("target-a", "iron_ore");
  const second = storage("target-b", "iron_ore");
  if (kind === "tray") {
    for (const target of [first, second]) {
      target.buildingId = "material_delivery_hub";
      target.deliverySlots = [{ itemId: "iron_ore", mode: "manual" },
        { itemId: "iron_ore", mode: "manual" }, { itemId: null, mode: "auto" }];
    }
  }
  if (kind === "black-hole") {
    first.buildingId = "micro_black_hole_connector";
    first.blackHolePaused = false;
    first.blackHoleActivationConfirmed = true;
    first.blackHolePorts = ([0, 1, 2] as const).map((index) => ({ index, totalDestroyed: "0" }));
  }
  state.entities.push(first, ...(kind === "tray" ? [second] : []));
  for (let index = 0; index < 3; index++) {
    const itemId: ItemId = kind === "black-hole" && index === 1 ? "copper_ore" : "iron_ore";
    const source = storage(`source-${index}`, itemId);
    state.entities.push(source);
    state.belts.push({ id: `belt-${index}`, source: source.id,
      target: kind === "tray" && index === 1 ? second.id : first.id,
      planetId: "home", itemId, tier: 1, sorterTier: 1, lanes: 1, priority: 1,
      targetPortIndex: kind === "black-hole" ? (index === 2 ? 1 : 0) : index === 0 ? undefined : (index - 1) as BeltInputPortIndex,
      progress: 0, lastFlow: 0, totalTransferred: 0 });
  }
  return state;
}

/** Open capacity again after reservation, making changed reservation ownership
 * observable in authoritative transferred totals instead of hidden by a full
 * target. An omitted legacy allowance means uncapped remaining progress, not
 * zero. These local phase hooks must preserve that existing behavior too. */
function phaseHooks(free: number, kind: "ordinary" | "tray" | "black-hole"): SimulationContractExperiment {
  return {
    beforeInputBelts(state) {
      for (const entity of state.entities) if (entity.id.startsWith("source-")) entity.outputs = {};
    },
    afterInputBelts(state) {
      for (const belt of state.belts) {
        belt.progress = 100;
        state.entities.find((entity) => entity.id === belt.source)!.outputs[belt.itemId] = 100;
      }
      if (kind === "ordinary") {
        const target = state.entities.find((entity) => entity.id === "target-a")!;
        target.inputs.iron_ore = getEntityItemInputCapacity(state, target, "iron_ore") - free;
        target.outputs = {};
      }
      if (kind === "tray") state.tray.iron_ore = getPlanetTrayItemLimit(state, "home") - free;
    },
    beforeOutputBelts(state) {
      if (kind === "ordinary") state.entities.find((entity) => entity.id === "target-a")!.inputs = {};
      if (kind === "tray") state.tray.iron_ore = 0;
    },
  };
}

function step(state: GameState, flat: boolean, contractExperiment: SimulationContractExperiment,
  lookup?: SimulationLookupContext) {
  const session = createSimulationAdvanceSession(state, 1, {
    mutateState: true, lookup, forceFlatRouteOracle: flat, contractExperiment,
  });
  advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
  return { state: completeSimulationAdvanceSession(session), lookup: session.lookup };
}

function compare(state: GameState, hooks: SimulationContractExperiment, lookup?: SimulationLookupContext) {
  const reference = step(structuredClone(state), true, hooks);
  const actual = step(state, false, hooks, lookup);
  expect(actual.state).toStrictEqual(reference.state);
  expect(hash(actual.state)).toBe(hash(reference.state));
  return actual;
}

describe("belt output reservation capacity ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(legacyReopenedFlows)("shares ordinary target capacity across ports with %i units free", (free, flows) => {
    const actual = compare(fixture("ordinary"), phaseHooks(free, "ordinary"));
    expect(actual.state.belts.map((belt) => belt.totalTransferred)).toEqual(flows);
  });

  it.each(legacyReopenedFlows)("shares a planet tray across hubs and ports with %i units free", (free, flows) => {
    const actual = compare(fixture("tray"), phaseHooks(free, "tray"));
    expect(actual.state.belts.map((belt) => belt.totalTransferred)).toEqual(flows);
    expect(actual.state.tray.iron_ore).toBe(flows.reduce((sum, amount) => sum + amount, 0));
  });

  it.each([false, true])("preserves black-hole port and item accounting when paused=%s", (paused) => {
    const source = fixture("black-hole");
    source.entities[0].blackHolePaused = paused;
    const actual = compare(source, phaseHooks(0, "black-hole"));
    expect(actual.state.belts.reduce((sum, belt) => sum + belt.totalTransferred!, 0)).toBe(paused ? 0 : 300);
    // One port can destroy both items; a separate port has its own counter.
    expect(actual.state.entities[0].blackHolePorts?.map((port) => port.totalDestroyed)).toEqual(
      paused ? ["0", "0", "0"] : ["200", "100", "0"]);
  });

  it.each([false, true])("keeps persisted order with reversed=%s and mixed priorities", (reverse) => {
    const source = fixture("ordinary");
    source.belts[0].priority = 0;
    source.belts[1].priority = 2;
    if (reverse) source.belts.reverse();
    const actual = compare(source, phaseHooks(7, "ordinary"));
    expect(actual.state.belts.find((belt) => belt.totalTransferred === 7)?.id).toBe(reverse ? "belt-2" : "belt-0");
  });

  it("refreshes a reused ledger through full, empty and newly available capacity", () => {
    let actual = fixture("ordinary");
    let lookup: SimulationLookupContext | undefined;
    for (const free of [7, 0, 1, 200, 0, 9]) {
      const result = compare(actual, phaseHooks(free, "ordinary"), lookup);
      if (lookup) expect(result.lookup).toBe(lookup);
      actual = result.state;
      lookup = result.lookup;
    }
    expect(actual.belts.reduce((sum, belt) => sum + belt.totalTransferred!, 0)).toBe(1517);
    expect(lookup!.beltRuntime.reservationTargetCapacityLedgers.length)
      .toBeLessThanOrEqual(lookup!.beltRuntime.reservationTargetCapacityGroupCount);
  });

  it("rebuilds capacity ownership after immutable topology edits", () => {
    const runtime = createPersistentSimulationRuntime(fixture("ordinary"));
    const original = compare(runtime.state, phaseHooks(7, "ordinary"), runtime.lookup);
    const state = { ...original.state, entities: [...original.state.entities].reverse(),
      belts: [...original.state.belts].reverse() };
    replacePersistentSimulationRuntimeState(runtime, state);
    const result = compare(runtime.state, phaseHooks(9, "ordinary"), runtime.lookup);
    expect(result.lookup).not.toBe(original.lookup);
    expect(result.state.belts.reduce((sum, belt) => sum + belt.totalTransferred!, 0)).toBe(416);
  });
});
