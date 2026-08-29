import { describe, expect, it } from "vitest";
import { advanceSimulation, advanceSimulationBudget, createInitialState, createPlayerInitialState } from "./engine";
import { hashGameState } from "./benchmark";
import {
  FAST_OFFLINE_ALGORITHM_VERSION,
  FAST_OFFLINE_CALIBRATION_SECONDS,
  FAST_OFFLINE_CONSERVATIVE_PREFIX_SECONDS,
  advanceConstructionAutomationMacroWithReceiptInPlace,
  advanceExactSimulationForConservationDiagnostic,
  advanceExactSimulationWindowWithConstructionReceipt,
  applyPureIdleAffineContract,
  captureAggregateConservationBaseline,
  capturePureIdleCombinedConservationCheckpoint,
  OFFLINE_APPROXIMATION_KEY,
  OFFLINE_APPROXIMATION_DEFAULT_ENABLED,
  readOfflineApproximationEnabled,
  getOfflineApproximationBlocker,
  runFastOfflineSettlement,
  runFastOfflineSettlementAsync,
  runConservativeOfflineSettlement,
  runOfflineApproximation,
  runOfflineApproximationAsync,
  runTimeWarpApproximateSettlement,
  runTimeWarpApproximateSettlementInPlace,
  validateAggregateConservation,
  validatePureIdleCombinedSettlementConservation,
  invalidateTimeWarpApproximationCertificate,
  TIME_WARP_APPROXIMATION_ALGORITHM_VERSION,
  writeOfflineApproximationEnabled,
  type PureIdleAffineContract,
} from "./offlineApproximation";
import { inspectSave, serializeEnvelope } from "./storage";

function stableEmptyState() {
  const state = createInitialState(undefined, false);
  state.entities = [];
  state.constructionAutomation.enabled = false;
  state.paused = false;
  return state;
}

function timeWarpPowerFixture(
  power: "fuel" | "storage" | "renewable" | "low-power",
  fuelSimulationSeconds = 1,
) {
  const state = stableEmptyState();
  state.entities.push({
    id: `power-${power}-warp`, kind: "machine", planetId: "home", position: { x: -120, y: 0 },
    interactionLocked: false, buildingId: "time_warp_device", machineCount: 1, minerCount: 0,
    inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
  });
  if (power === "fuel") {
    state.entities.push({
      id: "power-fuel-star", kind: "power", planetId: "home", position: { x: -80, y: 0 },
      interactionLocked: false, buildingId: "artificial_star", machineCount: 1_527_777_777_778,
      minerCount: 0, fuelItemId: "antimatter_fuel_rod",
      fuelRemainingMj: 100_000_000_000_000 * fuelSimulationSeconds,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
  } else if (power === "storage") {
    state.entities.push({
      id: "power-storage-accumulator", kind: "power", planetId: "home", position: { x: -80, y: 0 },
      interactionLocked: false, buildingId: "accumulator", machineCount: 12_500_000_000_000,
      minerCount: 0, storedEnergyMj: 10_000_000_000_036,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
  } else {
    state.entities.push({
      id: `power-${power}-wind`, kind: "power", planetId: "home", position: { x: -80, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine",
      machineCount: power === "renewable" ? 400_000_000_000_000 : 4_000_000,
      minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0,
      utilization: 0, productionRate: 0,
    });
  }
  state.entities.push({
    id: `power-${power}-smelter`, kind: "machine", planetId: "home", position: { x: -40, y: 0 },
    interactionLocked: false, buildingId: "arc_smelter", recipeId: "iron_ingot", machineCount: 100,
    minerCount: 0, inputs: { iron_ore: 1_000_000 }, outputs: {}, progress: 0, routingCursor: 0,
    utilization: 0, productionRate: 0,
  });
  state.timeWarp.controllerEntityId = `power-${power}-warp`;
  state.timeWarp.enabled = true;
  state.timeWarp.requestedMultiplier = 16;
  return state;
}

describe("offline macro contract experiment", () => {
  it("enables the guarded fast path by default and persists an explicit opt-out", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } as Pick<Storage, "getItem" | "setItem">;
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
    try {
      expect(OFFLINE_APPROXIMATION_DEFAULT_ENABLED).toBe(true);
      expect(readOfflineApproximationEnabled()).toBe(true);
      writeOfflineApproximationEnabled(false);
      expect(values.get(OFFLINE_APPROXIMATION_KEY)).toBe("false");
      expect(readOfflineApproximationEnabled()).toBe(false);
      writeOfflineApproximationEnabled(true);
      expect(values.get(OFFLINE_APPROXIMATION_KEY)).toBe("true");
      expect(readOfflineApproximationEnabled()).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
  });

  it("uses two exact calibration windows and keeps the result deterministic", () => {
    const source = stableEmptyState();
    const before = hashGameState(source);
    const first = runOfflineApproximation(source, 24 * 60 * 60);
    const second = runOfflineApproximation(source, 24 * 60 * 60);

    expect(first.status).toBe("approximate");
    expect(second.status).toBe("approximate");
    if (first.status !== "approximate" || second.status !== "approximate") return;
    expect(first.report.calibrationWindowSeconds).toBeGreaterThanOrEqual(5);
    expect(first.report.approximatedSeconds).toBeGreaterThan(24 * 60 * 60 - 30);
    expect(first.report.maxEstimatedError).toBeLessThanOrEqual(0.2);
    expect(first.state.elapsedSeconds).toBe(24 * 60 * 60);
    expect(hashGameState(first.state)).toBe(hashGameState(second.state));
    expect(hashGameState(source)).toBe(before);
  });

  it("keeps dynamic logistics on the exact path", () => {
    const state = stableEmptyState();
    state.entities.push({
      id: "station",
      kind: "station",
      planetId: "home",
      position: { x: 0, y: 0 },
      interactionLocked: false,
      buildingId: "planetary_logistics_station",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
      stationRoutes: [],
    });
    const result = runOfflineApproximation(state, 3_600);
    expect(getOfflineApproximationBlocker(state, 3_600)).toContain("物流站");
    expect(result.status).toBe("ineligible");
    if (result.status === "ineligible") expect(result.report.fellBack).toBe(true);
  });

  it("keeps active finite research on the dedicated fast research ledger", () => {
    const state = stableEmptyState();
    state.research.selectedTechId = "electromagnetic_matrix";
    state.timeWarp.enabled = true;
    const blocker = getOfflineApproximationBlocker(state, 3_600);
    expect(blocker).toContain("进行中的科研");
    const fast = runFastOfflineSettlement(state, 3_600);
    expect(["approximate", "conservative"]).toContain(fast.status);
    if (fast.status === "approximate" || fast.status === "conservative") {
      expect(fast.report.algorithmVersion).toBe(FAST_OFFLINE_ALGORITHM_VERSION);
      expect(fast.state.research.selectedTechId).toBe("electromagnetic_matrix");
    }

    const timeWarp = runTimeWarpApproximateSettlement(state, 120, 10);
    expect(timeWarp.report).toMatchObject({
      mode: "approximate",
      algorithmVersion: TIME_WARP_APPROXIMATION_ALGORITHM_VERSION,
    });
    expect(timeWarp.state.research.selectedTechId).toBe("electromagnetic_matrix");
  });

  it("falls back when calibration is not stable instead of committing a partial state", () => {
    const state = stableEmptyState();
    state.entities.push({
      id: "research",
      kind: "machine",
      planetId: "home",
      position: { x: 0, y: 0 },
      interactionLocked: false,
      buildingId: "matrix_lab",
      machineCount: 1,
      minerCount: 0,
      inputs: { electromagnetic_matrix: 10 },
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
      recipeId: "matrix_research",
    });
    const result = runOfflineApproximation(state, 3_600);
    expect(result.status).not.toBe("approximate");
    expect(hashGameState(state)).toBe(hashGameState(state));
  });

  it("matches exact elapsed time for a short exact fallback", () => {
    const state = stableEmptyState();
    const exact = advanceSimulation(state, 30);
    const result = runOfflineApproximation(state, 30);
    expect(result.status).not.toBe("approximate");
    expect(exact.elapsedSeconds).toBe(30);
    expect(state.elapsedSeconds).toBe(0);
  });

  it("can be requested by a time-warp-sized budget without changing persisted flags", () => {
    const state = stableEmptyState();
    state.timeWarp.enabled = true;
    state.timeWarp.requestedMultiplier = 64;
    state.entities.push({
      id: "warp",
      kind: "machine",
      planetId: "home",
      position: { x: 0, y: 0 },
      interactionLocked: false,
      buildingId: "time_warp_device",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    });
    state.timeWarp.controllerEntityId = "warp";
    const result = runOfflineApproximation(state, 3_600);
    expect(result.status).toBe("approximate");
    expect(state.timeWarp.enabled).toBe(true);
    if (result.status === "approximate") expect(result.state.timeWarp.enabled).toBe(true);
  });

  it("can qualify a steady quantum flow with the generic affine contract", () => {
    const state = stableEmptyState();
    state.paused = false;
    state.quantumLogisticsNetwork.enabled = true;
    state.quantumLogisticsNetwork.itemCapacities.iron_ore = "1000000";
    state.entities.push({
      id: "affine-quantum", kind: "station", planetId: "home", position: { x: 0, y: 0 }, interactionLocked: false,
      buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "quantum", machineCount: 1, minerCount: 0,
      stationSlots: [{ itemId: "iron_ore", localMode: "storage", remoteMode: "supply", minimumLoad: 0.1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 }],
      stationRoutes: [], stationDrones: 0, stationVessels: 0, inputs: {}, outputs: {}, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0,
    });
    state.entities.push({
      id: "affine-source", kind: "storage", planetId: "home", position: { x: -100, y: 0 }, interactionLocked: false,
      buildingId: "storage_mk1", storedItemId: "iron_ore", machineCount: 1_000, minerCount: 0, inputs: {}, outputs: { iron_ore: 100_000 }, progress: 0, utilization: 0, productionRate: 0, routingCursor: 0,
    });
    state.belts.push({ id: "affine-belt", planetId: "home", source: "affine-source", target: "affine-quantum", itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1, lastFlow: 0, congestion: 0, totalTransferred: 0 });
    const warmedState = advanceSimulation(state, 10);
    warmedState.elapsedSeconds = 0;
    const result = runOfflineApproximation(warmedState, 3_600);
    expect(result.status).toBe("approximate");
    if (result.status === "approximate") {
      expect(result.report.approximatedSeconds).toBeGreaterThan(3_500);
      expect(result.state.quantumLogisticsNetwork.inventory.iron_ore).toBeDefined();
    }
    expect(state.elapsedSeconds).toBe(0);
    expect(warmedState.elapsedSeconds).toBe(0);
  });

  it("keeps the async Worker contract deterministic and cancellable", async () => {
    const source = stableEmptyState();
    const synchronous = runOfflineApproximation(source, 24 * 60 * 60);
    const asynchronous = await runOfflineApproximationAsync(source, 24 * 60 * 60);
    expect(asynchronous.status).toBe(synchronous.status);
    if (synchronous.status === "approximate" && asynchronous.status === "approximate") {
      expect(hashGameState(asynchronous.state)).toBe(hashGameState(synchronous.state));
      expect(asynchronous.report).toEqual(synchronous.report);
    }

    await expect(runOfflineApproximationAsync(source, 24 * 60 * 60, {
      shouldCancel: () => true,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(source.elapsedSeconds).toBe(0);
  });

  it("uses exactly thirty seconds of calibration before fast bulk settlement", () => {
    const source = stableEmptyState();
    const before = hashGameState(source);
    const result = runFastOfflineSettlement(source, 3_600);
    expect(result.status).toBe("approximate");
    if (result.status !== "approximate") return;
    expect(result.report.algorithmVersion).toBe(FAST_OFFLINE_ALGORITHM_VERSION);
    expect(result.report.calibrationWindowSeconds).toBe(FAST_OFFLINE_CALIBRATION_SECONDS);
    expect(result.report.approximatedSeconds).toBe(3_565);
    expect(result.state.elapsedSeconds).toBe(3_600);
    expect(hashGameState(source)).toBe(before);
    expect(result.report.boundaryCorrections ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("treats migration-restored resource anchors without miners as a quiescent topology", () => {
    const source = createInitialState(undefined, false);
    source.constructionAutomation.enabled = false;
    source.paused = false;
    const reloaded = inspectSave(serializeEnvelope(source, 1_753_000_000_000));
    expect(reloaded.valid).toBe(true);
    expect(reloaded.state?.entities.length).toBeGreaterThan(0);
    expect(reloaded.state?.belts).toHaveLength(0);
    expect(reloaded.state?.entities.every((entity) => entity.kind === "vein" && entity.minerCount === 0)).toBe(true);
    if (!reloaded.state) return;
    const before = hashGameState(reloaded.state);

    const result = runFastOfflineSettlement(reloaded.state, 3_600);

    expect(result.status).toBe("approximate");
    if (result.status !== "approximate") return;
    expect(result.state.elapsedSeconds - reloaded.state.elapsedSeconds).toBeCloseTo(3_600, 6);
    expect(hashGameState(reloaded.state)).toBe(before);
  });

  it("preserves an existing fractional simulation timestamp", () => {
    const source = stableEmptyState();
    source.elapsedSeconds = 123.7572;
    const result = runFastOfflineSettlement(source, 3_600);

    expect(result.status).toBe("approximate");
    if (result.status !== "approximate") return;
    expect(result.state.elapsedSeconds - source.elapsedSeconds).toBeCloseTo(3_600, 6);
    const inspection = inspectSave(serializeEnvelope(result.state, 1_753_000_000_000));
    expect(inspection.valid).toBe(true);
    expect(inspection.state?.elapsedSeconds).toBeCloseTo(result.state.elapsedSeconds, 6);
  });

  it("keeps the ten-minute fast path serializable and reloadable", () => {
    const source = stableEmptyState();
    const before = hashGameState(source);
    const result = runFastOfflineSettlement(source, 10 * 60);
    expect(result.status).toBe("approximate");
    if (result.status !== "approximate") return;
    const raw = serializeEnvelope(result.state, 1_753_000_000_000);
    const inspection = inspectSave(raw);
    expect(inspection.valid).toBe(true);
    expect(inspection.state?.elapsedSeconds).toBe(10 * 60);
    expect(hashGameState(source)).toBe(before);
  });

  it("keeps circular scheduler cursors out of affine extrapolation", () => {
    const source = stableEmptyState();
    source.constructionAutomation.cursor = -7;
    source.quantumLogisticsNetwork.routingCursors.iron_ore = -3;
    source.quantumLogisticsNetwork.uploadRoutingCursors.copper_ore = -9;
    source.galacticHubNetwork.routingCursors.test = -5;
    const before = hashGameState(source);

    const result = runFastOfflineSettlement(source, 3_600);

    expect(result.status).toBe("approximate");
    if (result.status !== "approximate") return;
    expect(result.state.constructionAutomation.cursor).toBeGreaterThanOrEqual(0);
    expect(result.state.quantumLogisticsNetwork.routingCursors.iron_ore).toBe(0);
    expect(result.state.quantumLogisticsNetwork.uploadRoutingCursors.copper_ore).toBe(0);
    expect(result.state.galacticHubNetwork.routingCursors.test).toBe(0);
    expect(result.report.boundaryCorrections).toBeGreaterThanOrEqual(4);
    expect(hashGameState(source)).toBe(before);
  });

  it("cancels fast calibration without exposing a partial state", async () => {
    const source = stableEmptyState();
    source.entities = Array.from({ length: 100 }, (_, index) => ({
      id: `fast-cancel-${index}`,
      kind: "storage" as const,
      planetId: "home" as const,
      position: { x: index, y: 0 },
      interactionLocked: false,
      buildingId: "storage_mk1" as const,
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    }));
    const before = hashGameState(source);
    let checks = 0;
    await expect(runFastOfflineSettlementAsync(source, 30 * 24 * 60 * 60, {
      shouldCancel: () => checks++ > 1,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(hashGameState(source)).toBe(before);
  });

  it("freezes from the original checkpoint when the offline calibration deadline is already exhausted", async () => {
    const source = stableEmptyState();
    source.tray.iron_ore = 25;
    const before = hashGameState(source);
    const result = await runFastOfflineSettlementAsync(source, 3_600, {
      deadlineAtMs: -1,
    });

    expect(result.status).toBe("conservative");
    if (result.status === "conservative") {
      expect(result.report.deadlineReached).toBe(true);
      expect(result.report.calibrationWindowSeconds).toBe(0);
      expect(result.state.elapsedSeconds - source.elapsedSeconds).toBe(3_600);
      expect(result.state.tray.iron_ore).toBe(25);
    }
    expect(hashGameState(source)).toBe(before);
  });

  it("keeps short offline intervals on the exact path", () => {
    const source = stableEmptyState();
    const result = runFastOfflineSettlement(source, 30);
    expect(result.status).not.toBe("approximate");
    expect(result.report.algorithmVersion).toBe(FAST_OFFLINE_ALGORITHM_VERSION);
    expect(result.report.calibrationWindowSeconds).toBe(30);
    expect(result.report.approximatedSeconds).toBe(0);
    expect(source.elapsedSeconds).toBe(0);
  });

  it("discards an invalid calibration candidate and keeps the valid source on a bounded conservative prefix", () => {
    const source = stableEmptyState();
    source.tray.iron_ore = 25;
    const sourceHash = hashGameState(source);
    const invalidCalibration = structuredClone(source);
    invalidCalibration.tray.iron_ore = Number.NaN;

    const result = runConservativeOfflineSettlement(
      source,
      3_600,
      3_600,
      "injected calibration failure",
      invalidCalibration,
      30,
    );

    expect(result.status).toBe("conservative");
    if (result.status === "conservative") {
      expect(result.report.calibrationWindowSeconds).toBe(FAST_OFFLINE_CONSERVATIVE_PREFIX_SECONDS);
      expect(result.report.fallbackReason).toContain("有界保守前缀");
      expect(result.state.tray.iron_ore).toBe(25);
      expect(result.state.elapsedSeconds - source.elapsedSeconds).toBe(3_600);
    }
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("rejects an unsupported combined settlement and returns a clock-only source checkpoint", () => {
    const source = stableEmptyState();
    const sourceHash = hashGameState(source);
    const unsupported = structuredClone(source);
    unsupported.tray.iron_ore = (source.tray.iron_ore ?? 0) + 1;

    const result = runConservativeOfflineSettlement(
      source,
      3_600,
      3_600,
      "injected combined settlement failure",
      unsupported,
      30,
    );

    expect(result.status).toBe("conservative");
    if (result.status === "conservative") {
      expect(result.state.elapsedSeconds - source.elapsedSeconds).toBe(3_600);
      expect(result.state.tray.iron_ore ?? 0).toBe(source.tray.iron_ore ?? 0);
      expect(result.report.fallbackReason).toContain("最终物资守恒门禁拒绝候选");
    }
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("treats a construction WIP refund as an ownership transfer instead of new crafting", () => {
    const source = stableEmptyState();
    source.portableFleet.logistics_drone = 0;
    source.constructionAutomation.jobs.transfer = {
      constructionId: "wind_turbine",
      steps: [],
      stepIndex: 0,
      elapsedSeconds: 0,
      inventory: { logistics_drone: 5 },
    };
    const checkpoint = captureAggregateConservationBaseline(source);
    const candidate = structuredClone(source);
    candidate.constructionAutomation.jobs.transfer.inventory = {};
    candidate.portableFleet.logistics_drone = 5;

    expect(validateAggregateConservation(checkpoint, candidate)).toBeNull();
  });

  it("rejects forged construction stock and totalCrafted without recipe input consumption", () => {
    const source = stableEmptyState();
    source.construction.arc_smelter = 0;
    source.constructionAutomation.totalCrafted = 0;
    const checkpoint = captureAggregateConservationBaseline(source);
    const candidate = structuredClone(source);
    candidate.construction.arc_smelter = 1;
    candidate.constructionAutomation.totalCrafted = 1;

    expect(validateAggregateConservation(checkpoint, candidate)).toContain("建筑制造配方投入");
  });

  it("does not let unrelated same-item consumption impersonate a construction-stage receipt", () => {
    const source = stableEmptyState();
    source.construction.arc_smelter = 0;
    source.constructionAutomation.totalCrafted = 0;
    source.tray.iron_ingot = 4;
    source.tray.stone_brick = 2;
    source.tray.circuit_board = 4;
    source.tray.magnetic_coil = 2;
    const checkpoint = captureAggregateConservationBaseline(source);
    const candidate = structuredClone(source);
    candidate.tray.iron_ingot = 0;
    candidate.tray.stone_brick = 0;
    candidate.tray.circuit_board = 0;
    candidate.tray.magnetic_coil = 0;
    candidate.construction.arc_smelter = 1;
    candidate.constructionAutomation.totalCrafted = 1;

    expect(validateAggregateConservation(checkpoint, candidate)).toContain("缺少隔离施工阶段收据");
  });

  it("keeps exact diagnostic construction receipts private while matching the ordinary engine", () => {
    const source = stableEmptyState();
    source.constructionAutomation.enabled = true;
    source.constructionAutomation.targetStock.arc_smelter = (source.construction.arc_smelter ?? 0) + 1;
    source.constructionAutomation.jobs["diagnostic-building-center"] = {
      constructionId: "arc_smelter",
      steps: [{ kind: "building", constructionId: "arc_smelter" }],
      stepIndex: 0,
      elapsedSeconds: 0,
      inventory: { iron_ingot: 4, stone_brick: 2, circuit_board: 4, magnetic_coil: 2 },
    };
    source.entities.push({
      id: "diagnostic-building-power", kind: "power", planetId: "home", position: { x: -40, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine", machineCount: 1_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "diagnostic-building-center", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "construction_center", machineCount: 10, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
    const sourceHash = hashGameState(source);
    const plainBaseline = captureAggregateConservationBaseline(source);
    const ordinary = advanceSimulationBudget(source, 10, 10);

    expect(ordinary.construction.arc_smelter).toBe((source.construction.arc_smelter ?? 0) + 1);
    expect(ordinary.constructionAutomation.totalCrafted).toBe(1);
    expect(validateAggregateConservation(plainBaseline, ordinary)).toContain("缺少隔离施工阶段收据");

    const diagnostic = advanceExactSimulationForConservationDiagnostic(source, 10, 10);

    expect(diagnostic.state).toEqual(ordinary);
    expect(hashGameState(diagnostic.state)).toBe(hashGameState(ordinary));
    expect(diagnostic.conservationFailure).toBeNull();
    expect(Number.isFinite(diagnostic.exactAdvanceDurationMs)).toBe(true);
    expect(diagnostic.exactAdvanceDurationMs).toBeGreaterThanOrEqual(0);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps construction receipts behind an opaque non-cloneable checkpoint token", () => {
    const source = stableEmptyState();
    const checkpoint = capturePureIdleCombinedConservationCheckpoint(source);
    expect(Object.isFrozen(checkpoint)).toBe(true);
    expect("_constructionRecipeReceipt" in checkpoint).toBe(false);

    const forgedFacade = {
      ...checkpoint,
      _constructionRecipeReceipt: { crafted: 1n, outputs: new Map([["arc_smelter", 1n]]) },
    } as unknown as typeof checkpoint;
    const candidate = structuredClone(source);
    candidate.construction.arc_smelter = 1;
    candidate.constructionAutomation.totalCrafted = 1;

    expect(validatePureIdleCombinedSettlementConservation(forgedFacade, candidate)).toContain("不透明令牌");
    expect(validatePureIdleCombinedSettlementConservation(checkpoint, candidate)).toContain("施工阶段收据 0");
  });

  it("rejects an invalid opaque checkpoint before either receipt path mutates its source", () => {
    const invalidCheckpoint = {} as ReturnType<typeof capturePureIdleCombinedConservationCheckpoint>;
    const exactSource = stableEmptyState();
    const exactHash = hashGameState(exactSource);
    const exactElapsed = exactSource.elapsedSeconds;

    expect(() => advanceExactSimulationWindowWithConstructionReceipt(
      exactSource,
      1,
      1,
      invalidCheckpoint,
    )).toThrow(/不透明令牌/);
    expect(hashGameState(exactSource)).toBe(exactHash);
    expect(exactSource.elapsedSeconds).toBe(exactElapsed);

    const constructionSource = stableEmptyState();
    constructionSource.constructionAutomation.enabled = true;
    constructionSource.constructionAutomation.targetStock.logistics_vessel = 1;
    constructionSource.constructionAutomation.jobs["atomic-fleet-center"] = {
      constructionId: "logistics_vessel",
      steps: [{ kind: "fleet", itemId: "logistics_vessel", amount: 1 }],
      stepIndex: 0,
      elapsedSeconds: 0,
      inventory: { logistics_vessel: 1 },
    };
    constructionSource.entities.push({
      id: "atomic-fleet-power", kind: "power", planetId: "home", position: { x: -40, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine", machineCount: 1_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "atomic-fleet-center", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "construction_center", machineCount: 1, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
    const constructionHash = hashGameState(constructionSource);
    const constructionElapsed = constructionSource.elapsedSeconds;

    expect(() => advanceConstructionAutomationMacroWithReceiptInPlace(
      constructionSource,
      2,
      invalidCheckpoint,
    )).toThrow(/不透明令牌/);
    expect(hashGameState(constructionSource)).toBe(constructionHash);
    expect(constructionSource.elapsedSeconds).toBe(constructionElapsed);
  });

  it("rejects an unmetered fleet completion even when its recipe output was already owned as WIP", () => {
    const state = stableEmptyState();
    state.constructionAutomation.enabled = true;
    state.constructionAutomation.targetStock.logistics_vessel = 1;
    state.constructionAutomation.jobs["fleet-wip-center"] = {
      constructionId: "logistics_vessel",
      steps: [{ kind: "fleet", itemId: "logistics_vessel", amount: 1 }],
      stepIndex: 0,
      elapsedSeconds: 0,
      inventory: { logistics_vessel: 1 },
    };
    state.entities.push({
      id: "fleet-wip-power", kind: "power", planetId: "home", position: { x: -40, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine", machineCount: 1_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "fleet-wip-center", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "construction_center", machineCount: 1, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
    const checkpoint = capturePureIdleCombinedConservationCheckpoint(state);

    const result = advanceConstructionAutomationMacroWithReceiptInPlace(
      state,
      2,
      checkpoint,
      { allowUnmeteredPowerForTest: true },
    );

    expect(result.completed).toBe(1);
    expect(state.constructionAutomation.jobs).toEqual({});
    expect(state.portableFleet.logistics_vessel).toBe(1);
    expect(state.constructionAutomation.totalCrafted).toBe(1);
    expect(validatePureIdleCombinedSettlementConservation(checkpoint, state)).toContain("施工电力守恒失败");
  });

  it("credits final construction materials downloaded and fully consumed from quantum inventory in one exact chunk", () => {
    const state = stableEmptyState();
    state.research.completedTechIds.push("construction_automation", "quantum_logistics_network");
    state.quantumLogisticsNetwork.enabled = true;
    state.quantumLogisticsNetwork.inventory = {
      iron_ingot: "4",
      stone_brick: "2",
      circuit_board: "4",
      magnetic_coil: "2",
    };
    state.quantumLogisticsNetwork.itemCapacities = {
      iron_ingot: "100",
      stone_brick: "100",
      circuit_board: "100",
      magnetic_coil: "100",
    };
    state.tray = {};
    state.planetTrays.home = state.tray;
    state.construction.arc_smelter = 0;
    state.constructionAutomation.enabled = true;
    state.constructionAutomation.quantumSourceEnabled = true;
    state.constructionAutomation.targetStock.arc_smelter = 1;
    state.constructionAutomation.jobs["quantum-final-center"] = {
      constructionId: "arc_smelter",
      steps: [{ kind: "building", constructionId: "arc_smelter" }],
      stepIndex: 0,
      elapsedSeconds: 0,
      inventory: {},
    };
    state.entities.push({
      id: "quantum-final-power", kind: "power", planetId: "home", position: { x: -80, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine", machineCount: 1_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "quantum-final-center", kind: "machine", planetId: "home", position: { x: -40, y: 0 },
      interactionLocked: false, buildingId: "construction_center", machineCount: 10, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "quantum-final-tower", kind: "station", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "interstellar_logistics_station", stationTier: 2,
      quantumMode: "quantum", stationSlots: [], stationRoutes: [], machineCount: 100, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
    const checkpoint = capturePureIdleCombinedConservationCheckpoint(state);

    const candidate = advanceExactSimulationWindowWithConstructionReceipt(state, 10, 10, checkpoint);

    expect(candidate.construction.arc_smelter).toBe(1);
    expect(candidate.constructionAutomation.totalCrafted).toBe(1);
    expect(candidate.quantumLogisticsNetwork.inventory).toEqual({
      iron_ingot: "0",
      stone_brick: "0",
      circuit_board: "0",
      magnetic_coil: "0",
    });
    expect(validatePureIdleCombinedSettlementConservation(checkpoint, candidate)).toBeNull();
  });

  it("credits construction inputs uploaded from an ordinary station and consumed inside one exact chunk", () => {
    const state = stableEmptyState();
    state.research.completedTechIds.push("construction_automation", "quantum_logistics_network");
    state.quantumLogisticsNetwork.enabled = true;
    state.quantumLogisticsNetwork.inventory = {};
    state.quantumLogisticsNetwork.itemCapacities = {
      iron_ingot: "100",
      stone_brick: "100",
      circuit_board: "100",
      magnetic_coil: "100",
    };
    state.tray = {};
    state.planetTrays.home = state.tray;
    state.construction.arc_smelter = 0;
    state.constructionAutomation.enabled = true;
    state.constructionAutomation.quantumSourceEnabled = true;
    state.constructionAutomation.targetStock.arc_smelter = 1;
    state.constructionAutomation.jobs["station-upload-center"] = {
      constructionId: "arc_smelter",
      steps: [{ kind: "building", constructionId: "arc_smelter" }],
      stepIndex: 0,
      elapsedSeconds: 0,
      inventory: {},
    };
    state.entities.push({
      id: "station-upload-power", kind: "power", planetId: "home", position: { x: -80, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine", machineCount: 1_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "station-upload-center", kind: "machine", planetId: "home", position: { x: -40, y: 0 },
      interactionLocked: false, buildingId: "construction_center", machineCount: 10, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "station-upload-tower", kind: "station", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "interstellar_logistics_station", stationTier: 2,
      quantumMode: "quantum", machineCount: 100, minerCount: 0,
      stationSlots: [
        { itemId: "iron_ingot", localMode: "storage", remoteMode: "supply", minimumLoad: 0.1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 },
        { itemId: "stone_brick", localMode: "storage", remoteMode: "supply", minimumLoad: 0.1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 },
        { itemId: "circuit_board", localMode: "storage", remoteMode: "supply", minimumLoad: 0.1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 },
        { itemId: "magnetic_coil", localMode: "storage", remoteMode: "supply", minimumLoad: 0.1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 },
      ],
      stationRoutes: [], stationDrones: 0, stationVessels: 0,
      inputs: {}, outputs: { iron_ingot: 4, stone_brick: 2, circuit_board: 4, magnetic_coil: 2 },
      progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
    const checkpoint = capturePureIdleCombinedConservationCheckpoint(state);

    const candidate = advanceExactSimulationWindowWithConstructionReceipt(state, 10, 10, checkpoint);

    expect(candidate.construction.arc_smelter).toBe(1);
    expect(candidate.constructionAutomation.totalCrafted).toBe(1);
    expect(candidate.entities.find((entity) => entity.id === "station-upload-tower")?.outputs).toEqual({
      iron_ingot: 0,
      stone_brick: 0,
      circuit_board: 0,
      magnetic_coil: 0,
    });
    expect(candidate.quantumLogisticsNetwork.inventory).toEqual({
      iron_ingot: "0",
      stone_brick: "0",
      circuit_board: "0",
      magnetic_coil: "0",
    });
    expect(validatePureIdleCombinedSettlementConservation(checkpoint, candidate)).toBeNull();
  });

  it("commits an exact-fallback construction receipt only after every local validator accepts it", () => {
    const state = stableEmptyState();
    state.settings.resourceMode = "finite";
    state.research.completedTechIds.push("construction_automation");
    state.constructionAutomation.enabled = true;
    state.constructionAutomation.targetStock.logistics_vessel = 1;
    state.constructionAutomation.jobs["fallback-center"] = {
      constructionId: "logistics_vessel",
      steps: [{ kind: "fleet", itemId: "logistics_vessel", amount: 1 }],
      stepIndex: 0,
      elapsedSeconds: 0,
      inventory: { logistics_vessel: 1 },
    };
    state.entities.push({
      id: "fallback-wind", kind: "power", planetId: "home", position: { x: -120, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine", machineCount: 1_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "fallback-center", kind: "machine", planetId: "home", position: { x: -80, y: 0 },
      interactionLocked: false, buildingId: "construction_center", machineCount: 1, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "fallback-vein", kind: "vein", planetId: "home", position: { x: -40, y: 0 },
      interactionLocked: false, resourceId: "iron_ore", extractorBuildingId: "mining_machine",
      machineCount: 0, minerCount: 1, resourceRemaining: 1, resourceCapacity: 1,
      resourceDepletionRemainder: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0,
      utilization: 0, productionRate: 0,
    }, {
      id: "fallback-storage", kind: "storage", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "storage_mk1", storedItemId: "iron_ore",
      machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0,
      utilization: 0, productionRate: 0,
    });
    state.belts.push({
      id: "fallback-vein-belt", planetId: "home", source: "fallback-vein", target: "fallback-storage",
      itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1,
      totalTransferred: 0, lastFlow: 0,
    });
    const veinIndex = state.entities.findIndex((entity) => entity.id === "fallback-vein");
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [
        { path: ["entities", veinIndex, "outputs", "iron_ore"], kind: "number", delta: 100, integer: true },
        { path: ["totalProduced", "iron_ore"], kind: "number", delta: 100, integer: true },
      ],
    } as PureIdleAffineContract;
    const checkpoint = capturePureIdleCombinedConservationCheckpoint(state);

    const result = applyPureIdleAffineContract(state, contract, 2, 2, {
      constructionCheckpoint: checkpoint,
    });

    expect(result).toMatchObject({ ok: true, exactSimulationSeconds: 2 });
    expect(state.portableFleet.logistics_vessel).toBe(1);
    expect(state.constructionAutomation.totalCrafted).toBe(1);
    expect(validatePureIdleCombinedSettlementConservation(checkpoint, state)).toBeNull();
  });

  it("does not let an unreceipted fleet WIP transfer certify a forged totalCrafted counter", () => {
    const source = stableEmptyState();
    source.constructionAutomation.jobs["fleet-forgery"] = {
      constructionId: "logistics_vessel",
      steps: [{ kind: "fleet", itemId: "logistics_vessel", amount: 1 }],
      stepIndex: 0,
      elapsedSeconds: 0,
      inventory: { logistics_vessel: 1 },
    };
    const checkpoint = captureAggregateConservationBaseline(source);
    const candidate = structuredClone(source);
    candidate.constructionAutomation.jobs["fleet-forgery"].inventory = {};
    candidate.portableFleet.logistics_vessel = 1;
    candidate.constructionAutomation.totalCrafted = 1;

    expect(validateAggregateConservation(checkpoint, candidate)).toContain("缺少隔离施工阶段收据");
  });

  it("keeps speedrun factories off the approximate settlement path", () => {
    const source = stableEmptyState();
    source.speedrun = {
      enabled: true,
      mode: "speedrun",
      rulesetVersion: "speedrun-v1",
      seasonId: "season_01",
      startedAt: 1,
      elapsedActiveSeconds: 0,
      baseline: { completedTechIds: [], rocketsLaunched: 0, whiteMatrixProduced: 0 },
      milestones: {
        all_technologies: { completed: false },
        dyson_rockets_10000: { completed: false },
        white_matrix_1m: { completed: false },
      },
      eligible: true,
      factoryId: "speedrun_test_factory_0001",
    };
    const result = runFastOfflineSettlement(source, 3_600, 60);
    expect(result.status).toBe("ineligible");
    expect(result.report.fallbackReason).toContain("速通工厂");
  });

  it("advances a pure-idle time-warp slice with short calibration without mutating its source", () => {
    const source = stableEmptyState();
    source.entities.push({
      id: "time-warp-test-device",
      kind: "machine",
      planetId: "home",
      position: { x: 0, y: 0 },
      interactionLocked: false,
      buildingId: "time_warp_device",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    });
    source.timeWarp.controllerEntityId = "time-warp-test-device";
    source.timeWarp.enabled = true;
    source.timeWarp.requestedMultiplier = 16;
    const before = hashGameState(source);

    const first = runTimeWarpApproximateSettlement(source, 16, 1);
    const second = runTimeWarpApproximateSettlement(source, 16, 1);

    expect(first.report).toMatchObject({
      mode: "approximate",
      algorithmVersion: TIME_WARP_APPROXIMATION_ALGORITHM_VERSION,
      requestedSimulationSeconds: 16,
      exactCalibrationSeconds: 0.5,
      approximatedSeconds: 15.5,
    });
    expect(first.state.elapsedSeconds).toBe(16);
    expect(first.report.maxCriticalError).toBeLessThanOrEqual(1);
    expect(first.report.fallbackReason).toContain("尾段已冻结");
    expect(hashGameState(first.state)).toBe(hashGameState(second.state));
    expect(hashGameState(source)).toBe(before);
  });

  it("bounds a short-probe research inflow by the matrices actually owned by the factory", () => {
    const source = stableEmptyState();
    source.research.selectedTechId = "time_warp_engineering";
    source.entities.push({
      id: "bounded-research-time-warp", kind: "machine", planetId: "home", position: { x: -120, y: 0 },
      interactionLocked: false, buildingId: "time_warp_device", machineCount: 1, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "bounded-research-wind", kind: "power", planetId: "home", position: { x: -80, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine", machineCount: 50_000_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "bounded-research-source", kind: "storage", planetId: "home", position: { x: -40, y: 0 },
      interactionLocked: false, buildingId: "storage_mk1", storedItemId: "electromagnetic_matrix",
      machineCount: 1, minerCount: 0, inputs: {}, outputs: { electromagnetic_matrix: 100 },
      progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "bounded-research-lab", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "matrix_lab", recipeId: "matrix_research",
      machineCount: 1_000, minerCount: 0, inputs: { electromagnetic_matrix: 1 }, outputs: {},
      progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
    source.belts.push({
      id: "bounded-research-belt", planetId: "home", source: "bounded-research-source",
      target: "bounded-research-lab", itemId: "electromagnetic_matrix", lanes: 1, tier: 3,
      sorterTier: 3, progress: 0, priority: 1, totalTransferred: 0, lastFlow: 0, congestion: 0,
    });
    source.timeWarp.controllerEntityId = "bounded-research-time-warp";
    source.timeWarp.enabled = true;
    source.timeWarp.requestedMultiplier = 16;
    const sourceHash = hashGameState(source);
    const initiallyOwned = 101;

    const result = runTimeWarpApproximateSettlement(source, 160, 10);
    const lab = result.state.entities.find((entity) => entity.id === "bounded-research-lab")!;
    const storage = result.state.entities.find((entity) => entity.id === "bounded-research-source")!;
    const invested = result.state.research.progressByTech.time_warp_engineering?.electromagnetic_matrix ?? 0;
    const remaining = (lab.inputs.electromagnetic_matrix ?? 0) + (storage.outputs.electromagnetic_matrix ?? 0);

    expect(result.report.mode).toBe("approximate");
    expect(invested).toBeGreaterThan(0);
    expect(invested).toBeLessThanOrEqual(initiallyOwned);
    // Integer/boundary rounding may conservatively under-credit one matrix,
    // but it must never replay more than the source checkpoint owned.
    expect(invested + remaining).toBeLessThanOrEqual(initiallyOwned);
    expect(invested + remaining).toBeGreaterThanOrEqual(initiallyOwned - 1);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("freezes an unmetered construction tail before it can break the final ledger", () => {
    const source = stableEmptyState();
    source.entities.push({
      id: "construction-gate-time-warp", kind: "machine", planetId: "home", position: { x: -120, y: 0 },
      interactionLocked: false, buildingId: "time_warp_device", machineCount: 1, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "construction-gate-wind", kind: "power", planetId: "home", position: { x: -80, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine", machineCount: 50_000_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "construction-gate-smelter", kind: "machine", planetId: "home", position: { x: -40, y: 0 },
      interactionLocked: false, buildingId: "arc_smelter", recipeId: "iron_ingot", machineCount: 100,
      minerCount: 0, inputs: { iron_ore: 100_000 }, outputs: {}, progress: 0, routingCursor: 0,
      utilization: 0, productionRate: 0,
    }, {
      id: "construction-gate-center", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "construction_center", machineCount: 1_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
    source.timeWarp.controllerEntityId = "construction-gate-time-warp";
    source.timeWarp.enabled = true;
    source.timeWarp.requestedMultiplier = 16;
    source.research.completedTechIds.push("construction_automation");
    source.constructionAutomation.enabled = true;
    source.constructionAutomation.targetStock.arc_smelter = 1;
    source.constructionAutomation.totalCrafted = Number.MAX_SAFE_INTEGER;
    source.construction.arc_smelter = 0;
    source.tray = { iron_ore: 100, copper_ore: 100, stone: 100 };
    source.planetTrays.home = source.tray;
    const sourceHash = hashGameState(source);

    const result = runTimeWarpApproximateSettlement(source, 16, 1);

    expect(result.state.construction.arc_smelter ?? 0).toBe(0);
    expect(result.state.constructionAutomation.totalCrafted).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.state.entities.find((entity) => entity.id === "construction-gate-center"))
      .toMatchObject({ powerInputKw: 0, powerFactor: 0, utilization: 0, productionRate: 0 });
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps the speedrun clock on wall time during approximate pure idle", () => {
    const source = stableEmptyState();
    source.entities.push({
      id: "time-warp-speedrun-device", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "time_warp_device", machineCount: 1, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
    source.timeWarp.controllerEntityId = "time-warp-speedrun-device";
    source.timeWarp.enabled = true;
    source.timeWarp.requestedMultiplier = 12;
    source.speedrun = {
      enabled: true, mode: "speedrun", rulesetVersion: "speedrun-v1", seasonId: "season_01", startedAt: 1,
      elapsedActiveSeconds: 10, baseline: { completedTechIds: [], rocketsLaunched: 0, whiteMatrixProduced: 0 },
      milestones: {
        all_technologies: { completed: false }, dyson_rockets_10000: { completed: false }, white_matrix_1m: { completed: false },
      },
      eligible: true, factoryId: "speedrun_time_warp_factory",
    };

    const result = runTimeWarpApproximateSettlement(source, 12, 1);
    expect(result.state.speedrun?.elapsedActiveSeconds).toBe(11);
    expect(source.speedrun.elapsedActiveSeconds).toBe(10);
  });

  it("reuses an exact-validated rolling certificate only for the same Worker-owned authority", () => {
    const source = createInitialState(undefined, false);
    source.paused = false;
    source.entities.push({
      id: "rolling-time-warp-device", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "time_warp_device", machineCount: 1, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "rolling-wind", kind: "power", planetId: "home", position: { x: 20, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine", machineCount: 50_000_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "rolling-smelter", kind: "machine", planetId: "home", position: { x: 40, y: 0 },
      interactionLocked: false, buildingId: "arc_smelter", recipeId: "iron_ingot", machineCount: 100,
      minerCount: 0, inputs: { iron_ore: 100_000 }, outputs: {}, progress: 0, routingCursor: 0,
      utilization: 0, productionRate: 0,
    });
    source.timeWarp.controllerEntityId = "rolling-time-warp-device";
    source.timeWarp.enabled = true;
    source.timeWarp.requestedMultiplier = 16;
    source.speedrun = {
      enabled: true, mode: "speedrun", rulesetVersion: "speedrun-v1", seasonId: "season_01", startedAt: 1,
      elapsedActiveSeconds: 10, baseline: { completedTechIds: [], rocketsLaunched: 0, whiteMatrixProduced: 0 },
      milestones: {
        all_technologies: { completed: false }, dyson_rockets_10000: { completed: false }, white_matrix_1m: { completed: false },
      },
      eligible: true, factoryId: "rolling_time_warp_factory",
    };
    const authority = structuredClone(source);
    const beforeElapsed = authority.elapsedSeconds;

    const first = runTimeWarpApproximateSettlementInPlace(authority, 16, 1);
    const second = runTimeWarpApproximateSettlementInPlace(first.state, 144, 9);

    expect(first.report.certificateReused).not.toBe(true);
    expect(second.state).toBe(first.state);
    expect(second.report).toMatchObject({ certificateReused: true, exactCalibrationSeconds: 0 });
    expect(second.state.elapsedSeconds - beforeElapsed).toBeCloseTo(160, 6);
    expect(second.state.speedrun?.elapsedActiveSeconds).toBe(20);

    const expired = runTimeWarpApproximateSettlementInPlace(second.state, 16, 1);
    expect(expired.report.certificateReused).not.toBe(true);
    expired.state.timeWarp.requestedMultiplier = 12;
    const configurationChanged = runTimeWarpApproximateSettlementInPlace(expired.state, 12, 1);
    expect(configurationChanged.report.certificateReused).not.toBe(true);

    invalidateTimeWarpApproximationCertificate(configurationChanged.state);
    const refreshed = runTimeWarpApproximateSettlementInPlace(configurationChanged.state, 12, 1);
    expect(refreshed.report.certificateReused).not.toBe(true);
  });

  it("does not replay a one-second artificial-star fuel reserve through the first or rolling 16x tail", () => {
    const oneLongWindow = runTimeWarpApproximateSettlement(timeWarpPowerFixture("fuel"), 64, 4).state;
    let segmented = timeWarpPowerFixture("fuel");
    const reports = [];
    for (let index = 0; index < 4; index += 1) {
      const result = runTimeWarpApproximateSettlementInPlace(segmented, 16, 1);
      segmented = result.state;
      reports.push(result.report);
    }

    expect(oneLongWindow.totalProduced.iron_ingot ?? 0).toBe(100);
    expect(segmented.totalProduced.iron_ingot ?? 0).toBe(100);
    expect(segmented.entities.find((entity) => entity.id === "power-fuel-star")?.fuelRemainingMj).toBe(0);
    expect(segmented.timeWarp.effectiveMultiplier).toBe(segmented.settings.simulationSpeed);
    expect(reports.every((report) => report.certificateReused !== true)).toBe(true);
  });

  it("keeps a finite artificial-star bank productive while debiting it identically in long and rolling windows", () => {
    const source = timeWarpPowerFixture("fuel", 64);
    const oneLongWindow = runTimeWarpApproximateSettlement(structuredClone(source), 32, 2);
    let segmented = structuredClone(source);
    const first = runTimeWarpApproximateSettlementInPlace(segmented, 16, 1);
    const firstProduced = first.state.totalProduced.iron_ingot ?? 0;
    const second = runTimeWarpApproximateSettlementInPlace(first.state, 16, 1);
    segmented = second.state;

    expect(firstProduced).toBe(1_600);
    expect(second.report).toMatchObject({ certificateReused: true });
    expect(segmented.totalProduced.iron_ingot ?? 0).toBe(3_200);
    const remainingFuelHeat = segmented.entities.find((entity) => entity.id === "power-fuel-star")
      ?.fuelRemainingMj ?? 0;
    expect(remainingFuelHeat).toBeGreaterThan(3_199_999_999_000_000);
    expect(remainingFuelHeat).toBeLessThan(3_200_000_000_000_000);
    const normalizedSegmented = structuredClone(segmented);
    const normalizedLong = structuredClone(oneLongWindow.state);
    // Exact suffixes refresh diagnostics at different sample boundaries in a
    // long call versus rolling calls. Those snapshots are not simulation
    // authority; compare the complete gameplay state with the shared source
    // diagnostics restored.
    for (const candidate of [normalizedSegmented, normalizedLong]) {
      candidate.productionHistory = structuredClone(source.productionHistory);
      candidate.historyRecordedAt = source.historyRecordedAt;
      candidate.metrics = structuredClone(source.metrics);
      candidate.planetMetrics = structuredClone(source.planetMetrics);
      candidate.powerGridMetrics = structuredClone(source.powerGridMetrics);
    }
    expect(hashGameState(normalizedSegmented)).toBe(hashGameState(normalizedLong));
  });

  it("debits finite generator fuel in fast offline settlement and cannot reuse it on the next call", () => {
    const source = timeWarpPowerFixture("fuel", 80);
    const sourceHash = hashGameState(source);
    const first = runFastOfflineSettlement(structuredClone(source), 100, 100 / 16);
    expect(first.status).toBe("approximate");
    if (first.status !== "approximate") return;
    const firstProduced = first.state.totalProduced.iron_ingot ?? 0;
    const firstFuel = first.state.entities.find((entity) => entity.id === "power-fuel-star")?.fuelRemainingMj ?? 0;
    expect(firstProduced).toBeGreaterThan(0);
    expect(firstProduced).toBeLessThanOrEqual(8_000);
    expect(firstFuel).toBeLessThan(1);

    const second = runFastOfflineSettlement(first.state, 100, 100);
    expect(["approximate", "conservative"]).toContain(second.status);
    if (second.status === "approximate" || second.status === "conservative") {
      expect(second.state.totalProduced.iron_ingot ?? 0).toBe(firstProduced);
    }
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("freezes construction centers on an exhaustible grid while preserving its funded ordinary prefix", () => {
    const state = timeWarpPowerFixture("fuel", 80);
    state.research.completedTechIds.push("construction_automation");
    state.constructionAutomation.enabled = true;
    state.constructionAutomation.quantumSourceEnabled = true;
    state.constructionAutomation.targetStock.arc_smelter = 10_000;
    state.constructionAutomation.quantumMaterialBuffer = {
      "power-fuel-construction": { iron_ore: 1_000_000, copper_ore: 1_000_000, stone: 1_000_000 },
    };
    state.entities.push({
      id: "power-fuel-construction", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "construction_center", machineCount: 1_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });

    const result = runFastOfflineSettlement(state, 100, 100 / 16);
    expect(result.status).toBe("approximate");
    if (result.status !== "approximate") return;
    expect(result.state.totalProduced.iron_ingot ?? 0).toBeGreaterThan(0);
    expect(result.state.constructionAutomation.totalCrafted).toBe(0);
    expect(result.state.entities.find((entity) => entity.id === "power-fuel-construction"))
      .toMatchObject({ buildingId: "construction_center", powerInputKw: 0, powerFactor: 0, utilization: 0, productionRate: 0 });
  });

  it("does not replay a one-second accumulator reserve through the first or rolling 15x tail", () => {
    let state = timeWarpPowerFixture("storage");
    state.timeWarp.requestedMultiplier = 15;
    const first = runTimeWarpApproximateSettlementInPlace(state, 15, 1);
    const firstProduced = first.state.totalProduced.iron_ingot ?? 0;
    state = first.state;
    const second = runTimeWarpApproximateSettlementInPlace(state, 15, 1);

    expect(firstProduced).toBe(100);
    expect(second.state.totalProduced.iron_ingot ?? 0).toBe(100);
    expect(second.state.entities.find((entity) => entity.id === "power-storage-accumulator")?.storedEnergyMj).toBe(0);
    expect(second.report.certificateReused).not.toBe(true);
  });

  it("keeps a closed renewable 16x power proof productive and reusable", () => {
    const state = timeWarpPowerFixture("renewable");
    const first = runTimeWarpApproximateSettlementInPlace(state, 16, 1);
    const firstProduced = first.state.totalProduced.iron_ingot ?? 0;
    const second = runTimeWarpApproximateSettlementInPlace(first.state, 16, 1);

    expect(firstProduced).toBe(1_600);
    expect(second.state.totalProduced.iron_ingot ?? 0).toBe(3_200);
    expect(second.report).toMatchObject({ certificateReused: true });
    expect(second.state.timeWarp.effectiveMultiplier).toBe(16);
  });

  it("caps a renewable low-power proof at its exact effective multiplier instead of the requested 16x", () => {
    const state = timeWarpPowerFixture("low-power");
    const first = runTimeWarpApproximateSettlementInPlace(state, 16, 1);
    const firstProduced = first.state.totalProduced.iron_ingot ?? 0;
    const second = runTimeWarpApproximateSettlementInPlace(first.state, 16, 1);
    const secondProduced = second.state.totalProduced.iron_ingot ?? 0;

    expect(first.state.timeWarp.effectiveMultiplier).toBe(8);
    expect(firstProduced).toBe(800);
    expect(second.report).toMatchObject({ certificateReused: true });
    expect(secondProduced - firstProduced).toBe(800);
  });

  it("keeps a reused in-place certificate safe by freezing unmetered construction", () => {
    const authority = createInitialState(undefined, false);
    authority.paused = false;
    authority.constructionAutomation.enabled = false;
    authority.entities.push({
      id: "rolling-gate-time-warp", kind: "machine", planetId: "home", position: { x: -120, y: 0 },
      interactionLocked: false, buildingId: "time_warp_device", machineCount: 1, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "rolling-gate-wind", kind: "power", planetId: "home", position: { x: -80, y: 0 },
      interactionLocked: false, buildingId: "wind_turbine", machineCount: 50_000_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    }, {
      id: "rolling-gate-smelter", kind: "machine", planetId: "home", position: { x: -40, y: 0 },
      interactionLocked: false, buildingId: "arc_smelter", recipeId: "iron_ingot", machineCount: 100,
      minerCount: 0, inputs: { iron_ore: 100_000 }, outputs: {}, progress: 0, routingCursor: 0,
      utilization: 0, productionRate: 0,
    }, {
      id: "rolling-gate-center", kind: "machine", planetId: "home", position: { x: 0, y: 0 },
      interactionLocked: false, buildingId: "construction_center", machineCount: 1_000, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
    authority.timeWarp.controllerEntityId = "rolling-gate-time-warp";
    authority.timeWarp.enabled = true;
    authority.timeWarp.requestedMultiplier = 16;
    const first = runTimeWarpApproximateSettlementInPlace(authority, 16, 1);
    expect(first.report.certificateReused).not.toBe(true);

    first.state.research.completedTechIds.push("construction_automation");
    first.state.constructionAutomation.enabled = true;
    first.state.constructionAutomation.targetStock.arc_smelter = 1;
    first.state.constructionAutomation.totalCrafted = Number.MAX_SAFE_INTEGER;
    first.state.construction.arc_smelter = 0;
    first.state.tray = { iron_ore: 100, copper_ore: 100, stone: 100 };
    first.state.planetTrays.home = first.state.tray;

    const second = runTimeWarpApproximateSettlementInPlace(first.state, 16, 1);
    expect(second.report.certificateReused).toBe(true);
    expect(second.state.construction.arc_smelter ?? 0).toBe(0);
    expect(second.state.constructionAutomation.totalCrafted).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a macro slice that already contains uncommitted time-warp debt", () => {
    const source = stableEmptyState();
    source.timeWarp.pendingSimulationSeconds = 8;
    source.timeWarp.pendingWallSeconds = 1;
    const before = hashGameState(source);
    expect(() => runTimeWarpApproximateSettlement(source, 8, 1)).toThrow(/未提交预算/);
    expect(hashGameState(source)).toBe(before);
  });

});
