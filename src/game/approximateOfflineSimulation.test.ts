import { afterEach, describe, expect, it, vi } from "vitest";
import { hashGameState } from "./benchmark";
import {
  advanceSimulation,
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  createInitialState,
  createSimulationAdvanceSession,
  placeBuilding,
} from "./engine";
import {
  inspectApproximateOfflineEligibility,
  runApproximateOfflineSettlement,
} from "./approximateOfflineSimulation";
import {
  APPROXIMATE_OFFLINE_EXPERIMENT_STORAGE_KEY,
  isApproximateOfflineExperimentEnabled,
  setApproximateOfflineExperimentEnabled,
} from "./offlineExperiment";
import type { GameState } from "./types";
import { finalizeDeferredOfflineGame } from "./storage";

function disableDynamicGlobalSystems(state: GameState): void {
  state.paused = false;
  state.contentPacks = [];
  state.research.selectedTechId = null;
  state.research.queuedTechIds = [];
  state.research.progressByTech = {};
  state.exploration.missions = [];
  state.handcraftQueue = [];
  state.constructionQueue = [];
  state.constructionAutomation.enabled = false;
  state.constructionAutomation.jobs = {};
  state.timeWarp.enabled = false;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  state.endgame.activeInfiniteResearchId = null;
  state.endgame.autoResearch = false;
  state.endgame.autoDispatch = false;
  for (const project of Object.values(state.endgame.exportProjects)) project.enabled = false;
  state.endgame.constructionActivity.activityId = null;
  state.endgame.constructionActivity.pendingBatches = {};
  state.dysonSwarm = { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0, receiverLoadKw: 0 };
  state.dysonSphere = { structurePoints: 0, totalRocketsLaunched: 0, shellSails: 0, totalSailsAbsorbed: 0, absorptionProgress: 0, generationKw: 0 };
  state.dysonEngineering.launchEnabled = false;
  state.galacticHubNetwork.fleetBusy = 0;
  state.galacticHubNetwork.fleetReturns = [];
  state.galacticHubNetwork.warpers = "0";
  state.quantumLogisticsNetwork.enabled = false;
  state.quantumLogisticsNetwork.inventory = {};
  state.quantumLogisticsNetwork.runtimeFlow = undefined;
  state.systemSpaceStations = {};
}

function createStableProductionState(): GameState {
  let state = createInitialState();
  disableDynamicGlobalSystems(state);
  state.construction.wind_turbine = 2;
  state.construction.arc_smelter = 1;
  state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
  state = placeBuilding(state, "arc_smelter", { x: 300, y: 0 });
  state.entities = state.entities.filter((entity) => entity.buildingId === "wind_turbine" || entity.buildingId === "arc_smelter");
  const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
  smelter.inputs.iron_ore = 35;
  smelter.outputs.iron_ingot = 0;
  return state;
}

function createStableIdleState(): GameState {
  const state = createInitialState();
  disableDynamicGlobalSystems(state);
  state.entities = [];
  state.belts = [];
  return state;
}

function firstDifference(left: unknown, right: unknown, path = "state"): string | null {
  if (Object.is(left, right)) return null;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return `${path}: ${String(left)} !== ${String(right)}`;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return `${path}.length`;
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}.${index}`);
      if (difference) return difference;
    }
    return null;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort()) {
    const difference = firstDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("approximate offline experiment", () => {
  it("keeps the experiment preference local and disabled by default", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });

    expect(isApproximateOfflineExperimentEnabled()).toBe(false);
    setApproximateOfflineExperimentEnabled(true);
    expect(values.get(APPROXIMATE_OFFLINE_EXPERIMENT_STORAGE_KEY)).toBe("1");
    expect(isApproximateOfflineExperimentEnabled()).toBe(true);
    setApproximateOfflineExperimentEnabled(false);
    expect(isApproximateOfflineExperimentEnabled()).toBe(false);
  });

  it("uses measured stable throughput and stays within the exact result", async () => {
    const state = createStableProductionState();
    const originalHash = hashGameState(state);
    const exact = advanceSimulation(state, 30);
    const approximate = await runApproximateOfflineSettlement(state, 30);
    const exactSmelter = exact.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    const approximateSmelter = approximate.state.entities.find((entity) => entity.buildingId === "arc_smelter")!;

    expect(approximate.diagnostics.mode, JSON.stringify(approximate.diagnostics)).toBe("approximate");
    expect(approximate.diagnostics.approximateSeconds).toBeGreaterThanOrEqual(10);
    expect(approximate.diagnostics.maximumEstimatedError).toBeLessThanOrEqual(0.1);
    expect(approximate.diagnostics.conservationVerified).toBe(true);
    expect(approximateSmelter.inputs.iron_ore).toBe(exactSmelter.inputs.iron_ore);
    expect(approximateSmelter.outputs.iron_ingot).toBe(exactSmelter.outputs.iron_ingot);
    expect(approximate.state.totalProduced.iron_ingot).toBe(exact.totalProduced.iron_ingot);
    expect(hashGameState(state)).toBe(originalHash);
  });

  for (const seconds of [10, 60, 600, 3_600, 86_400, 30 * 86_400]) {
    it(`matches whole and segmented exact settlement for a stable idle ${seconds}-second interval`, async () => {
      const state = createStableIdleState();
      const originalHash = hashGameState(state);
      const exact = advanceSimulation(state, seconds);
      const session = createSimulationAdvanceSession(state, seconds);
      while (session.remainingSeconds > 0) advanceSimulationSession(session, 7);
      const segmented = completeSimulationAdvanceSession(session);
      const first = await runApproximateOfflineSettlement(state, seconds);
      const second = await runApproximateOfflineSettlement(state, seconds);

      expect(hashGameState(segmented)).toBe(hashGameState(exact));
      expect(hashGameState(first.state), firstDifference(exact, first.state) ?? "unknown difference").toBe(hashGameState(exact));
      expect(hashGameState(second.state)).toBe(hashGameState(exact));
      expect(first.diagnostics.conservationVerified).toBe(true);
      if (seconds >= 60) {
        expect(first.diagnostics.mode).toBe("approximate");
        expect(first.diagnostics.approximateSeconds).toBeGreaterThanOrEqual(seconds - 15);
      }
      expect(hashGameState(state)).toBe(originalHash);
    }, 30_000);
  }

  it("carries settlement diagnostics into the offline report without changing the save schema", async () => {
    const state = createStableProductionState();
    const result = await runApproximateOfflineSettlement(state, 30);
    const loaded = {
      state,
      savedAt: Date.now() - 30_000,
      offlineSeconds: 30,
      offlineReport: null,
    };
    const finalized = finalizeDeferredOfflineGame(loaded, result.state, result.diagnostics);

    expect(finalized.state.version).toBe(46);
    expect(finalized.offlineReport?.settlement).toEqual(result.diagnostics);
    expect(finalized.offlineReport?.settlement).toMatchObject({
      mode: "approximate",
      incomplete: false,
      conservationVerified: true,
    });
  });

  it("falls back from the untouched source when a high-risk logistics state is present", async () => {
    const state = createStableProductionState();
    state.entities[0].stationRoutes = [{
      id: "route_1",
      slotIndex: 0,
      peerId: "peer",
      itemId: "iron_ingot",
      scope: "remote",
      cargo: 10,
      vehicleCount: 1,
      progress: 0.5,
      duration: 10,
      requiresWarp: false,
    }];
    const originalHash = hashGameState(state);
    const exact = advanceSimulation(state, 60);
    const result = await runApproximateOfflineSettlement(state, 60);

    expect(inspectApproximateOfflineEligibility(state)).toMatchObject({ eligible: false });
    expect(result.diagnostics).toMatchObject({ mode: "exact", fellBack: true, approximateSeconds: 0 });
    expect(result.diagnostics.fallbackReason).toContain("物流");
    expect(hashGameState(result.state)).toBe(hashGameState(exact));
    expect(hashGameState(state)).toBe(originalHash);
  });

  it("cancels between Worker chunks and leaves the original state unchanged", async () => {
    const state = createStableProductionState();
    state.endgame.activeInfiniteResearchId = "matrix_compression";
    const originalHash = hashGameState(state);
    let cancelled = false;

    await expect(runApproximateOfflineSettlement(state, 24 * 60 * 60, {
      shouldCancel: () => cancelled,
      onProgress: () => { cancelled = true; },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(hashGameState(state)).toBe(originalHash);
  });
});
