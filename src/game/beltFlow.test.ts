import { describe, expect, it } from "vitest";
import { addUnitToEntityGroup, advanceSimulation, connectBelt, createInitialState, placeBuilding, setEntityRecipe, setLogisticsItem } from "./engine";
import { applyBeltFlowObservations, BELT_FLOW_WINDOW_SECONDS, BeltFlowSampler } from "./beltFlow";
import { diagnoseBelt } from "./network";
import type { PlanetId } from "./types";

function stateWithBelt() {
  const state = createInitialState();
  state.belts = [{
    id: "belt_flow_test",
    planetId: "home",
    source: "source",
    target: "target",
    itemId: "iron_ore",
    lanes: 1,
    tier: 2,
    sorterTier: 2,
    progress: 0,
    priority: 1,
    lastFlow: 0,
    totalTransferred: 0,
  }];
  state.elapsedSeconds = 0;
  return state;
}

describe("BeltFlowSampler", () => {
  it("derives a stable five-simulation-second rate from totalTransferred", () => {
    const sampler = new BeltFlowSampler();
    const state = stateWithBelt();
    sampler.sample(state);
    for (let second = 1; second <= 8; second += 1) {
      state.elapsedSeconds = second;
      state.belts[0].totalTransferred = second * 12;
      state.belts[0].lastFlow = second % 2 ? 12 : 9.6;
      const observation = sampler.sample(state).get(state.belts[0].id)!;
      expect(observation.flowPerSecond).toBe(12);
      expect(observation.sampleSeconds).toBe(Math.min(second, BELT_FLOW_WINDOW_SECONDS));
    }
  });

  it("reports indexes requiring projection onto the sampled state", () => {
    const sampler = new BeltFlowSampler();
    const state = stateWithBelt();
    const observations = sampler.sample(state);
    expect(sampler.consumeProjectionIndexes()).toEqual([0]);
    const projected = applyBeltFlowObservations(state, observations);
    sampler.sample(projected);
    expect(sampler.consumeProjectionIndexes()).toEqual([]);
    state.elapsedSeconds = 1;
    state.belts[0].totalTransferred = 12;
    sampler.sample(state);
    expect(sampler.consumeProjectionIndexes()).toEqual([0]);
  });

  it("reapplies stable five-second flow to fresh authoritative publications", () => {
    const sampler = new BeltFlowSampler();
    const initial = stateWithBelt();
    sampler.sample(initial);
    sampler.consumeProjectionIndexes();
    for (let second = 1; second <= 12; second += 1) {
      const state = {
        ...initial,
        elapsedSeconds: second,
        belts: [{ ...initial.belts[0], totalTransferred: second * 12, lastFlow: 9.6 }],
      };
      const untouched = structuredClone(state);
      const observations = sampler.sample(state);
      const observed = applyBeltFlowObservations(state, observations, "home", sampler.consumeProjectionIndexes());
      expect(observed).toEqual(applyBeltFlowObservations(state, observations, "home"));
      expect(observed.belts[0]).toMatchObject({
        lastFlow: 12,
        recentFlowSampleSeconds: Math.min(second, BELT_FLOW_WINDOW_SECONDS),
        recentFlowTransferred: Math.min(second, BELT_FLOW_WINDOW_SECONDS) * 12,
        recentFlowSampling: second < BELT_FLOW_WINDOW_SECONDS,
      });
      expect(state).toEqual(untouched);
    }
  });

  it("restores each missing or stale display field even when the observation is unchanged", () => {
    const sampler = new BeltFlowSampler();
    const initial = stateWithBelt();
    sampler.sample(initial);
    sampler.consumeProjectionIndexes();
    const state = { ...initial, elapsedSeconds: 5, belts: [{
      ...initial.belts[0], totalTransferred: 60, lastFlow: 12,
      recentFlowSampleSeconds: 5, recentFlowTransferred: 60, recentFlowSampling: false,
    }] };
    sampler.sample(state);
    sampler.consumeProjectionIndexes();
    for (const changedField of [
      { lastFlow: 9.6 },
      { recentFlowSampleSeconds: undefined },
      { recentFlowTransferred: 0 },
      { recentFlowSampling: true },
    ]) {
      const fresh = { ...state, belts: [{ ...state.belts[0], ...changedField }] };
      const untouched = structuredClone(fresh);
      const observations = sampler.sample(fresh);
      const observed = applyBeltFlowObservations(fresh, observations, "home", sampler.consumeProjectionIndexes());
      expect(observed.belts).toEqual(state.belts);
      expect(fresh).toEqual(untouched);
    }
  });

  it("projects current indexes after topology changes and planet switches", () => {
    const sampler = new BeltFlowSampler();
    const initial = stateWithBelt();
    initial.belts.push({ ...initial.belts[0], id: "second_home" },
      { ...initial.belts[0], id: "other_planet", planetId: "ashen" });
    const publish = (second: number, indexes: number[], planetId: PlanetId) => {
      const state = { ...initial, elapsedSeconds: second, belts: indexes.map((index) => ({
        ...initial.belts[index], totalTransferred: second * (index + 1) * 7, lastFlow: 3,
      })) };
      const untouched = structuredClone(state);
      const observations = sampler.sample(state, { planetId });
      const observed = applyBeltFlowObservations(state, observations, planetId, sampler.consumeProjectionIndexes());
      expect(observed).toEqual(applyBeltFlowObservations(state, observations, planetId));
      expect(state).toEqual(untouched);
      for (let index = 0; index < state.belts.length; index += 1) {
        if (state.belts[index].planetId !== planetId) expect(observed.belts[index]).toBe(state.belts[index]);
      }
      return observed;
    };
    publish(0, [0, 1, 2], "home");
    publish(5, [0, 1, 2], "home");
    expect(publish(6, [1, 2, 0], "home").belts.map((belt) => belt.lastFlow)).toEqual([14, 3, 7]);
    publish(7, [2, 0], "home");
    publish(8, [0, 2, 1], "home");
    publish(9, [0, 2, 1], "ashen");
    expect(publish(10, [0, 2, 1], "ashen").belts[1].lastFlow).toBe(21);
    publish(11, [0, 2, 1], "home");
    sampler.reset();
    expect(publish(1, [0, 2, 1], "home").belts[0].recentFlowSampleSeconds).toBe(0);
  });

  it("interpolates a coarse publish interval without changing the measured rate", () => {
    const sampler = new BeltFlowSampler();
    const state = stateWithBelt();
    sampler.sample(state);
    state.elapsedSeconds = 3;
    state.belts[0].totalTransferred = 36;
    sampler.sample(state);
    state.elapsedSeconds = 6;
    state.belts[0].totalTransferred = 72;
    const observation = sampler.sample(state).get(state.belts[0].id)!;
    expect(observation.sampleSeconds).toBe(5);
    expect(observation.flowPerSecond).toBe(12);
    expect(observation.transferred).toBe(60);
  });

  it("resets safely when a save load moves elapsed time or counters backwards", () => {
    const sampler = new BeltFlowSampler();
    const state = stateWithBelt();
    sampler.sample(state);
    state.elapsedSeconds = 5;
    state.belts[0].totalTransferred = 60;
    sampler.sample(state);
    state.elapsedSeconds = 1;
    state.belts[0].totalTransferred = 3;
    state.belts[0].lastFlow = 3;
    const observations = sampler.sample(state);
    const view = applyBeltFlowObservations(state, observations);
    expect(view.belts[0]).toMatchObject({
      lastFlow: 3,
      recentFlowSampleSeconds: 0,
      recentFlowTransferred: 0,
      recentFlowSampling: true,
    });
    expect(state.belts[0].recentFlowSampleSeconds).toBeUndefined();
  });

  it("reuses the state and untouched belt records when displayed flow values do not change", () => {
    const state = stateWithBelt();
    state.belts.push({ ...state.belts[0], id: "belt_flow_untouched", planetId: "home",
      recentFlowSampleSeconds: 0, recentFlowTransferred: 0, recentFlowSampling: false });
    const observations = new Map([
      ["belt_flow_test", { flowPerSecond: 2, sampleSeconds: 5, transferred: 10, sampling: false }],
      ["belt_flow_untouched", { flowPerSecond: 0, sampleSeconds: 0, transferred: 0, sampling: false }],
    ]);
    const first = applyBeltFlowObservations(state, observations);
    expect(first).not.toBe(state);
    expect(first.belts[1]).toBe(state.belts[1]);
    const same = applyBeltFlowObservations(first, observations);
    expect(same).toBe(first);
    expect(same.belts).toBe(first.belts);
  });

  function siliconLine(prefillTarget = false) {
    let state = createInitialState(12_345);
    state.research.completedTechIds.push("high_strength_crystal", "high_speed_logistics");
    state.construction.wind_turbine = 80;
    state.construction.arc_smelter = 11;
    state.construction.storage_mk1 = 1;
    state.construction.conveyor_belt_mk2 = 2;
    state = placeBuilding(state, "wind_turbine", { x: -300, y: -300 }, 80);
    state = placeBuilding(state, "arc_smelter", { x: 300, y: 0 }, 10);
    const smelterId = state.entities.find((entity) => entity.buildingId === "arc_smelter")!.id;
    state = addUnitToEntityGroup(state, smelterId);
    state = setEntityRecipe(state, smelterId, "high_purity_silicon");
    state = placeBuilding(state, "storage_mk1", { x: 650, y: 0 });
    const sinkId = state.entities.find((entity) => entity.buildingId === "storage_mk1")!.id;
    state.entities.find((entity) => entity.id === sinkId)!.machineCount = 100;
    state = setLogisticsItem(state, sinkId, "high_purity_silicon");
    const vein = state.entities.find((entity) => entity.id === "vein_iron")!;
    vein.resourceId = "silicon_ore";
    vein.minerCount = 20;
    vein.inputs = {};
    vein.outputs = { silicon_ore: 500 };
    vein.resourceCapacity = 1_000_000;
    vein.resourceRemaining = 1_000_000;
    state.galaxy.profiles.home!.miningMultiplier = 16 / 15;
    if (prefillTarget) state.entities.find((entity) => entity.id === smelterId)!.inputs.silicon_ore = 1_320;
    state = connectBelt(state, vein.id, smelterId, "silicon_ore", 2);
    state = connectBelt(state, smelterId, sinkId, "high_purity_silicon", 2);
    return { state, veinId: vein.id, smelterId };
  }

  it("keeps the recorded Mk.II topology at 12/s for 60 and 300 simulated seconds", () => {
    const sixtyFixture = siliconLine();
    const fixture = siliconLine();
    const sixty = advanceSimulation(sixtyFixture.state, 60);
    const threeHundred = advanceSimulation(fixture.state, 300);
    expect(sixty.belts[0].totalTransferred).toBe(720);
    expect(threeHundred.belts[0].totalTransferred).toBe(3_600);
    expect(threeHundred.entities.find((entity) => entity.id === fixture.veinId)?.productionRate).toBe(640);
    expect((threeHundred.entities.find((entity) => entity.id === fixture.veinId)?.outputs.silicon_ore ?? 0) +
      (threeHundred.belts[0].totalTransferred ?? 0)).toBe(500 + 3_200);
  });

  it("distinguishes the 11/s downstream stage from the long-run 10.6667/s upstream limit", () => {
    const downstreamFixture = siliconLine(true);
    let downstream = advanceSimulation(downstreamFixture.state, 1);
    const downstreamSampler = new BeltFlowSampler();
    downstreamSampler.sample(downstream);
    const downstreamStart = downstream.belts[0].totalTransferred ?? 0;
    downstream = advanceSimulation(downstream, 120);
    const downstreamDelta = (downstream.belts[0].totalTransferred ?? 0) - downstreamStart;
    const downstreamView = applyBeltFlowObservations(downstream, downstreamSampler.sample(downstream));
    expect(downstreamDelta).toBe(1_320);
    expect(downstreamView.belts[0].lastFlow).toBe(11);
    expect(diagnoseBelt(downstreamView, downstreamView.belts[0])).toMatchObject({ limitingFactor: "downstream" });

    const upstreamFixture = siliconLine();
    let upstream = advanceSimulation(upstreamFixture.state, 1_500);
    const upstreamSampler = new BeltFlowSampler();
    upstreamSampler.sample(upstream);
    const upstreamStart = upstream.belts[0].totalTransferred ?? 0;
    upstream = advanceSimulation(upstream, 300);
    const upstreamDelta = (upstream.belts[0].totalTransferred ?? 0) - upstreamStart;
    const upstreamView = applyBeltFlowObservations(upstream, upstreamSampler.sample(upstream));
    const smelter = upstream.entities.find((entity) => entity.id === upstreamFixture.smelterId)!;
    expect(upstreamDelta).toBe(3_200);
    expect(upstreamView.belts[0].lastFlow).toBeCloseTo(10.6667, 3);
    expect(diagnoseBelt(upstreamView, upstreamView.belts[0])).toMatchObject({ limitingFactor: "upstream" });
    expect((upstream.belts[0].totalTransferred ?? 0)).toBe(500 + 30 * 640);
    expect((smelter.inputs.silicon_ore ?? 0) + (upstream.totalProduced.high_purity_silicon ?? 0) * 2)
      .toBe(upstream.belts[0].totalTransferred ?? 0);
  });
});
