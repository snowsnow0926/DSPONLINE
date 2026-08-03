import { describe, expect, it } from "vitest";
import {
  MAX_BELT_LANES,
  createInitialState,
  getBeltCapacity,
  getBeltLaneAdjustmentCheck,
  getConstructionAutomationStockLimit,
  setBeltLaneCount,
  setConstructionAutomationTarget,
} from "./engine";
import { migrateGame } from "./storage";
import type { BeltConnection, GameState } from "./types";

function addTestBelt(state: GameState, overrides: Partial<BeltConnection> = {}): BeltConnection {
  const belt: BeltConnection = {
    id: "v104_belt",
    planetId: "home",
    source: "v104_source",
    target: "v104_target",
    itemId: "iron_ingot",
    lanes: 2,
    tier: 2,
    sorterTier: 2,
    progress: 0.625,
    priority: 2,
    stackSize: 2,
    monitorEnabled: true,
    totalTransferred: 9_876,
    congestion: 0.35,
    lastFlow: 17.5,
    routeMode: "manual",
    routeOffsetY: 180,
    ...overrides,
  };
  state.belts.push(belt);
  return belt;
}

describe("V1.04 belt bundles", () => {
  it("atomically consumes and refunds same-tier belts while preserving route and cargo state", () => {
    const state = createInitialState(10_104);
    const original = addTestBelt(state);
    state.construction.conveyor_belt_mk2 = 5;

    const increased = setBeltLaneCount(state, original.id, 4);
    const increasedBelt = increased.belts.find((belt) => belt.id === original.id)!;
    expect(increased.construction.conveyor_belt_mk2).toBe(3);
    expect(getBeltCapacity(increasedBelt)).toBe(96);
    expect(increasedBelt).toMatchObject({
      lanes: 4,
      tier: 2,
      sorterTier: 2,
      progress: 0.625,
      priority: 2,
      stackSize: 2,
      monitorEnabled: true,
      totalTransferred: 9_876,
      congestion: 0.35,
      lastFlow: 17.5,
      routeMode: "manual",
      routeOffsetY: 180,
      source: "v104_source",
      target: "v104_target",
    });

    const reduced = setBeltLaneCount(increased, original.id, 1);
    const reducedBelt = reduced.belts.find((belt) => belt.id === original.id)!;
    expect(reduced.construction.conveyor_belt_mk2).toBe(6);
    expect(getBeltCapacity(reducedBelt)).toBe(24);
    expect(reducedBelt.progress).toBe(0.625);
    expect(reducedBelt.totalTransferred).toBe(9_876);
  });

  it("returns explicit failures for invalid, unavailable and maximum requests", () => {
    const state = createInitialState(10_105);
    const belt = addTestBelt(state);
    state.construction.conveyor_belt_mk2 = 1;

    expect(getBeltLaneAdjustmentCheck(state, belt.id, 2.5)).toMatchObject({ ok: false, code: "invalid-count" });
    expect(getBeltLaneAdjustmentCheck(state, belt.id, 0)).toMatchObject({ ok: false, code: "minimum" });
    expect(getBeltLaneAdjustmentCheck(state, belt.id, 4)).toMatchObject({ ok: false, code: "missing-construction" });
    expect(getBeltLaneAdjustmentCheck(state, belt.id, MAX_BELT_LANES + 1)).toMatchObject({ ok: false, code: "maximum" });
    expect(setBeltLaneCount(state, belt.id, 4)).toBe(state);
    expect(state.construction.conveyor_belt_mk2).toBe(1);
    expect(state.belts[0].lanes).toBe(2);
  });

  it("lets grandfathered over-limit bundles reduce without silently deleting lanes", () => {
    const state = createInitialState(10_106);
    const belt = addTestBelt(state, { lanes: MAX_BELT_LANES + 3 });
    state.construction.conveyor_belt_mk2 = 0;

    const reduced = setBeltLaneCount(state, belt.id, MAX_BELT_LANES + 2);
    expect(reduced.belts[0].lanes).toBe(MAX_BELT_LANES + 2);
    expect(reduced.construction.conveyor_belt_mk2).toBe(1);
    expect(setBeltLaneCount(reduced, belt.id, MAX_BELT_LANES + 3)).toBe(reduced);
  });
});

describe("construction-center target compatibility", () => {
  it("keeps the existing technology progression and raises the final limit to 100,000,000", () => {
    const state = createInitialState(10_107);
    expect(getConstructionAutomationStockLimit(state)).toBe(100);
    state.research.completedTechIds.push("construction_capacity_1");
    expect(getConstructionAutomationStockLimit(state)).toBe(500);
    state.research.completedTechIds.push("construction_capacity_2");
    expect(getConstructionAutomationStockLimit(state)).toBe(100_000_000);

    const configured = setConstructionAutomationTarget(state, "arc_smelter", 100_000_000);
    expect(configured.constructionAutomation.targetStock.arc_smelter).toBe(100_000_000);
    expect(setConstructionAutomationTarget(configured, "arc_smelter", 100_000_001)).toBe(configured);
    expect(setConstructionAutomationTarget(configured, "arc_smelter", 12.5)).toBe(configured);
  });

  it("preserves oversized existing stock when the target is lowered and survives save normalization", () => {
    const state = createInitialState(10_108);
    state.research.completedTechIds.push("construction_capacity_1", "construction_capacity_2");
    state.construction.arc_smelter = 120_000;
    const configured = setConstructionAutomationTarget(state, "arc_smelter", 100_000);
    const lowered = setConstructionAutomationTarget(configured, "arc_smelter", 10_000);
    expect(lowered.construction.arc_smelter).toBe(120_000);
    expect(lowered.constructionAutomation.targetStock.arc_smelter).toBe(10_000);

    const reloaded = migrateGame(JSON.parse(JSON.stringify(configured)));
    expect(reloaded).not.toBeNull();
    expect(reloaded!.version).toBe(46);
    expect(reloaded!.constructionAutomation.targetStock.arc_smelter).toBe(100_000);
    expect(reloaded!.construction.arc_smelter).toBe(120_000);
  });
});
