import { describe, expect, it } from "vitest";
import { advanceSimulation, createInitialState, createPlayerInitialState } from "./engine";
import { hashGameState } from "./benchmark";
import {
  FAST_OFFLINE_ALGORITHM_VERSION,
  FAST_OFFLINE_CALIBRATION_SECONDS,
  FAST_OFFLINE_CONSERVATIVE_PREFIX_SECONDS,
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
  TIME_WARP_APPROXIMATION_ALGORITHM_VERSION,
  writeOfflineApproximationEnabled,
} from "./offlineApproximation";
import { inspectSave, serializeEnvelope } from "./storage";

function stableEmptyState() {
  const state = createInitialState(undefined, false);
  state.entities = [];
  state.constructionAutomation.enabled = false;
  state.paused = false;
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
      expect(fast.report.algorithmVersion).toBe("fast-30s-v2");
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
      exactCalibrationSeconds: 1,
      approximatedSeconds: 15,
    });
    expect(first.state.elapsedSeconds).toBe(16);
    expect(first.report.maxCriticalError).toBe(1);
    expect(first.report.fallbackReason).toContain("未证明尾段已冻结");
    expect(hashGameState(first.state)).toBe(hashGameState(second.state));
    expect(hashGameState(source)).toBe(before);
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

  it("rejects a macro slice that already contains uncommitted time-warp debt", () => {
    const source = stableEmptyState();
    source.timeWarp.pendingSimulationSeconds = 8;
    source.timeWarp.pendingWallSeconds = 1;
    const before = hashGameState(source);
    expect(() => runTimeWarpApproximateSettlement(source, 8, 1)).toThrow(/未提交预算/);
    expect(hashGameState(source)).toBe(before);
  });

});
