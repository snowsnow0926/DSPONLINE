import { describe, expect, it } from "vitest";
import {
  advanceSimulation,
  advanceSimulationBudget,
  createInitialState,
  createSimulationProfiler,
  SIMULATION_LOGISTICS_EXCLUSIVE_PHASE_KEYS,
} from "./engine";
import { hashGameState } from "./benchmark";
import type { BeltConnection, FactoryEntity } from "./types";

function createStressFactory() {
  const state = createInitialState();
  const entities: FactoryEntity[] = Array.from({ length: 500 }, (_, index) => ({
    id: `stress_device_${index}`,
    kind: "storage",
    planetId: "home",
    position: { x: index % 25 * 280, y: Math.floor(index / 25) * 220 },
    interactionLocked: false,
    buildingId: "storage_mk1",
    machineCount: 1,
    minerCount: 0,
    inputs: { iron_ingot: 0 },
    outputs: { iron_ingot: index < 250 ? 1_000 : 0 },
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
    storedItemId: "iron_ingot",
  }));
  const belts: BeltConnection[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `stress_belt_${index}`,
    planetId: "home",
    source: `stress_device_${index % 250}`,
    target: `stress_device_${250 + index % 250}`,
    itemId: "iron_ingot",
    lanes: 1,
    tier: 1,
    sorterTier: 1,
    progress: 0,
    priority: index % 2 as 0 | 1,
    lastFlow: 0,
  }));
  state.entities = entities;
  state.belts = belts;
  state.paused = false;
  return state;
}

describe("large factory performance", () => {
  it("advances 500 devices and 1000 transport lines without degrading state", () => {
    let state = createStressFactory();
    const started = performance.now();
    for (let tick = 0; tick < 10; tick += 1) state = advanceSimulation(state, 0.1);
    const duration = performance.now() - started;

    expect(state.entities).toHaveLength(500);
    expect(state.belts).toHaveLength(1_000);
    expect(state.belts.some((belt) => belt.lastFlow > 0)).toBe(true);
    expect(state.entities.every((entity) => Number.isInteger(entity.inputs.iron_ingot ?? 0) && Number.isInteger(entity.outputs.iron_ingot ?? 0))).toBe(true);
    expect(duration).toBeLessThan(2_000);
  });

  it("keeps simulation output identical when opt-in phase profiling is enabled", () => {
    const initial = createStressFactory();
    const profiler = createSimulationProfiler();
    const profiled = advanceSimulationBudget(initial, 10, 10, profiler);
    const ordinary = advanceSimulationBudget(initial, 10, 10);

    expect(hashGameState(profiled)).toBe(hashGameState(ordinary));
    expect(Object.values(profiler).every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(profiler.copyStateMs + profiler.beltsMs + profiler.logisticsMs).toBeGreaterThan(0);
  });

  it("reconciles logistics wall time from mutually exclusive phases", () => {
    const profiler = createSimulationProfiler();
    advanceSimulationBudget(createStressFactory(), 10, 10, profiler);

    expect(new Set(SIMULATION_LOGISTICS_EXCLUSIVE_PHASE_KEYS).size)
      .toBe(SIMULATION_LOGISTICS_EXCLUSIVE_PHASE_KEYS.length);
    const attributedMs = SIMULATION_LOGISTICS_EXCLUSIVE_PHASE_KEYS.reduce(
      (total, key) => total + profiler[key],
      0,
    );
    expect(profiler.logisticsMs).toBeGreaterThan(0);
    expect(attributedMs).toBeCloseTo(profiler.logisticsMs, 8);
    expect(attributedMs / profiler.logisticsMs).toBeGreaterThanOrEqual(0.95);
  });
});
