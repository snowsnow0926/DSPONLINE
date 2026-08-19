import { describe, expect, it } from "vitest";
import { addUnitToEntityGroup, advanceSimulation, connectBelt, createInitialState, placeBuilding, setEntityRecipe, setLogisticsItem } from "./engine";
import { applyBeltFlowObservations, BELT_FLOW_WINDOW_SECONDS, BeltFlowProjectionCache, BeltFlowSampler } from "./beltFlow";
import { diagnoseBelt } from "./network";

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
  it("reuses render-only belt records without mutating source snapshots", () => {
    const cache = new BeltFlowProjectionCache();
    const first = stateWithBelt();
    const firstView = cache.project(first, new Map([[first.belts[0].id, {
      flowPerSecond: 3,
      sampleSeconds: 1,
      transferred: 3,
      sampling: true,
    }]]));
    const projected = firstView.belts[0];
    expect(projected).not.toBe(first.belts[0]);
    expect(projected.lastFlow).toBe(3);
    expect(first.belts[0].lastFlow).toBe(0);

    const second = { ...first, belts: [{ ...first.belts[0], totalTransferred: 12, lastFlow: 12 }] };
    const secondView = cache.project(second, new Map([[second.belts[0].id, {
      flowPerSecond: 6,
      sampleSeconds: 2,
      transferred: 12,
      sampling: true,
    }]]));
    expect(secondView.belts[0]).toBe(projected);
    expect(secondView.belts[0]).toMatchObject({ lastFlow: 6, totalTransferred: 12 });
    expect(second.belts[0].lastFlow).toBe(12);

    cache.project({ ...second, belts: [] }, new Map());
    expect(cache.size).toBe(0);
  });

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
