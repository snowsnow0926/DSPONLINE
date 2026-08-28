import { describe, expect, it } from "vitest";
import { createInitialState } from "./engine";
import { createPureIdleAffineCalibration } from "./offlineApproximation";
import type { FactoryEntity, GameState } from "./types";

function machine(
  id: string,
  recipeId: FactoryEntity["recipeId"],
  inputs: FactoryEntity["inputs"],
): FactoryEntity {
  return {
    id,
    kind: "machine",
    planetId: "home",
    position: { x: 0, y: 0 },
    interactionLocked: false,
    buildingId: "arc_smelter",
    recipeId,
    powerGridId: "grid-a",
    machineCount: 1,
    minerCount: 0,
    inputs,
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  };
}

function finitePrefilledGraphitePowerChain(): GameState {
  const state = createInitialState(undefined, false);
  state.paused = false;
  state.settings.resourceMode = "finite";
  if (!state.research.completedTechIds.includes("energy_matrix")) {
    state.research.completedTechIds.push("energy_matrix");
  }
  state.entities = [
    {
      id: "finite-graphite-generator",
      kind: "power",
      planetId: "home",
      position: { x: 100, y: 0 },
      interactionLocked: false,
      buildingId: "thermal_power_plant",
      powerGridId: "grid-a",
      machineCount: 1,
      minerCount: 0,
      fuelItemId: "energetic_graphite",
      fuelRemainingMj: 0,
      inputs: { energetic_graphite: 10 },
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    },
    // Sixty coal powers the sampled producer for all three ten-second windows,
    // but it is still a finite prefilling and therefore cannot fund an endless
    // affine tail.
    machine("finite-graphite-producer", "energetic_graphite", { coal: 60 }),
    ...Array.from({ length: 5 }, (_, index) =>
      machine(`finite-graphite-load-${index}`, "iron_ingot", { iron_ore: 10_000 })),
  ];
  state.belts = [{
    id: "finite-graphite-feed",
    planetId: "home",
    source: "finite-graphite-producer",
    target: "finite-graphite-generator",
    itemId: "energetic_graphite",
    lanes: 4,
    tier: 3,
    sorterTier: 3,
    progress: 0,
    priority: 1,
    totalTransferred: 0,
    lastFlow: 0,
  }];
  return state;
}

describe("generic affine fuel sustainability certificate", () => {
  it("does not turn a connected recipe producer with finite prefilled inputs into an endless power tail", () => {
    const source = finitePrefilledGraphitePowerChain();
    const calibration = createPureIdleAffineCalibration(source, 30);

    expect(calibration).not.toBeNull();
    if (!calibration) return;
    expect(calibration.calibratedState.totalProduced.energetic_graphite ?? 0).toBeGreaterThan(0);
    expect(calibration.calibratedState.entities.find((entity) =>
      entity.id === "finite-graphite-producer")?.inputs.coal).toBeLessThan(60);
    expect({
      sustainable: calibration.powerTail.fuelDebits[0]?.sustainable,
      maximumSimulationSeconds: calibration.powerTail.maximumSimulationSeconds,
      steadyFactor: calibration.contract.steadyStateFactorsByItem?.energetic_graphite,
    }).toEqual({
      sustainable: false,
      maximumSimulationSeconds: expect.any(Number),
      steadyFactor: undefined,
    });
  });
});
