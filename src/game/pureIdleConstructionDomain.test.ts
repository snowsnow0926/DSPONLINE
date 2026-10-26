import { describe, expect, it } from "vitest";
import { TECHNOLOGIES } from "./content";
import { hashGameState } from "./benchmark";
import { createInitialState, placeBuilding, advanceSimulation,
  createConstructionAutomationMacroRuntime, getConstructionAutomationMacroCenters } from "./engine";
import { advanceConstructionAutomationMacroWithReceiptInPlace, advancePureIdleConstructionDomainInPlace,
  capturePureIdleCombinedConservationCheckpoint, issuePureIdleConstructionRuntimePowerCertificate,
  validatePureIdleCombinedSettlementConservation, type PureIdleAffineContract } from "./offlineApproximation";
import type { TechId } from "./types";
import { createPureIdleMacroSession, createPureIdleMacroSessionAsync, advancePureIdleMacroSession,
  summarizePureIdleMacroSession } from "./pureIdleMacro";

function fixture() {
  let state = createInitialState(20261026, false);
  state.research.completedTechIds = Object.keys(TECHNOLOGIES) as TechId[];
  state.construction.wind_turbine = 10_000;
  state = placeBuilding(state, "wind_turbine", { x: -200, y: 0 }, 10_000);
  state.construction.construction_center = 10;
  state = placeBuilding(state, "construction_center", { x: 0, y: 0 }, 10);
  state.constructionAutomation.enabled = true;
  state.constructionAutomation.targetStock = { arc_smelter: 100_000 };
  state.construction.arc_smelter = 0;
  state.tray = { iron_ore: 1_000_000, stone: 1_000_000, copper_ore: 1_000_000 };
  state.planetTrays.home = state.tray;
  state.timeWarp.enabled = true;
  state = advanceSimulation(state, 0.1);
  return state;
}
const contract = (): PureIdleAffineContract => ({ deltas: [], calibrationSeconds: 30, calibrationWallSeconds: 30 });

describe("isolated construction ledger", () => {
  it("reports completed construction without promising the next bucket's supply", () => {
    const state = fixture();
    state.paused = false; state.timeWarp.enabled = true;
    const session = createPureIdleMacroSession(state, "extreme", { forceConservativeReason: "progress status test" });
    advancePureIdleMacroSession(session, session.settledWallSeconds + 1);
    const summary = summarizePureIdleMacroSession(session).construction!;
    expect(summary.completedLastBucket).toBeGreaterThan(0);
    expect(["progress", "compute"]).toContain(summary.state);
  });
  it.each([false, true])("preserves the real quantum delivery boundary with competing demand=%s", (competing) => {
    const narrow = fixture();
    narrow.construction.arc_smelter = 0;
    narrow.constructionAutomation.jobs = {};
    narrow.tray = {};
    narrow.planetTrays.home = narrow.tray;
    narrow.quantumLogisticsNetwork.enabled = true;
    narrow.quantumLogisticsNetwork.inventory = { iron_ore: "1000000", copper_ore: "1000000", stone: "1000000" };
    narrow.constructionAutomation.quantumSourceEnabled = true;
    narrow.entities.push({ ...structuredClone(narrow.entities[0]), id: "quantum-source", kind: "station",
      buildingId: "interstellar_logistics_station", stationTier: 2, quantumMode: "quantum", machineCount: 1,
      inputs: {}, outputs: {}, stationRoutes: [], stationSlots: competing ? [{
        itemId: "iron_ore", localMode: "storage", remoteMode: "demand", minimumLoad: 1,
        minStock: 0, maxStock: 10000, priority: 1, routePolicy: "relay-preferred", warperBudget: 2,
      }] : [],
    });
    const full = structuredClone(narrow);
    const fullContract = contract();
    const checkpoint = capturePureIdleCombinedConservationCheckpoint(full, { constructionReplaySeconds: 10 });
    advanceConstructionAutomationMacroWithReceiptInPlace(full, 10, checkpoint, {
      contract: fullContract, powerCertificate: issuePureIdleConstructionRuntimePowerCertificate(full, fullContract),
    });
    const narrowContract = contract();
    advancePureIdleConstructionDomainInPlace(narrow, 10, {
      runtime: createConstructionAutomationMacroRuntime(), contract: narrowContract,
      powerCertificate: issuePureIdleConstructionRuntimePowerCertificate(narrow, narrowContract),
    });
    expect(validatePureIdleCombinedSettlementConservation(checkpoint, full)).toBeNull();
    expect(hashGameState(narrow)).toBe(hashGameState(full));
    if (competing) expect(narrow.construction.arc_smelter).toBe(0);
    else expect(narrow.construction.arc_smelter).toBeGreaterThan(0);
  });

  it("does not present outstanding targets as complete when no center exists", () => {
    const state = fixture();
    state.paused = false;
    state.timeWarp.enabled = true;
    state.entities = state.entities.filter((entity) => entity.buildingId !== "construction_center");
    const session = createPureIdleMacroSession(state, "extreme", { forceConservativeReason: "status test" });
    expect(summarizePureIdleMacroSession(session).construction?.state).toBe("missing-center");
  });
  it.each([false, true])("keeps async calibration identical with owned state=%s", async (consumeCalibrationState) => {
    const source = fixture();
    source.paused = false;
    source.timeWarp.enabled = true;
    const options = { consumeCalibrationState, forceConservativeReason: "parity test" };
    const sync = createPureIdleMacroSession(structuredClone(source), "extreme", options);
    const observed: number[] = [];
    const asyncSession = await createPureIdleMacroSessionAsync(structuredClone(source), "extreme", {
      ...options, onCalibrationProgress: (seconds) => observed.push(seconds),
    });
    expect(observed).toEqual([10, 20, 30]);
    expect(hashGameState(asyncSession.candidate)).toBe(hashGameState(sync.candidate));
    expect(asyncSession.contract).toEqual(sync.contract);
    const target = sync.settledWallSeconds + 10;
    advancePureIdleMacroSession(sync, target);
    advancePureIdleMacroSession(asyncSession, target);
    expect(hashGameState(asyncSession.candidate)).toBe(hashGameState(sync.candidate));
    expect(summarizePureIdleMacroSession(asyncSession).construction).toEqual(summarizePureIdleMacroSession(sync).construction);
  });

  it("cancels an async calibration before another window and preserves the caller's inventories", async () => {
    const source = fixture();
    source.timeWarp.enabled = true;
    const before = structuredClone(source.tray);
    let cancel = false;
    await expect(createPureIdleMacroSessionAsync(source, "extreme", {
      forceConservativeReason: "cancellation test", shouldCancel: () => cancel,
      onCalibrationProgress: () => { cancel = true; },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(source.tray).toEqual(before);
  });
  it.each([1, 10, 128, 320])("matches the full world ledger for %s seconds", (seconds) => {
    const narrow = fixture();
    const full = structuredClone(narrow);
    const narrowContract = contract();
    const fullContract = contract();
    const fullCheckpoint = capturePureIdleCombinedConservationCheckpoint(full, { constructionReplaySeconds: seconds });
    advanceConstructionAutomationMacroWithReceiptInPlace(full, seconds, fullCheckpoint, {
      contract: fullContract, powerCertificate: issuePureIdleConstructionRuntimePowerCertificate(full, fullContract),
    });
    expect(validatePureIdleCombinedSettlementConservation(fullCheckpoint, full)).toBeNull();
    const result = advancePureIdleConstructionDomainInPlace(narrow, seconds, {
      runtime: createConstructionAutomationMacroRuntime(), contract: narrowContract,
      powerCertificate: issuePureIdleConstructionRuntimePowerCertificate(narrow, narrowContract),
    });
    expect(result.completed).toBeGreaterThan(0);
    expect(hashGameState(narrow)).toBe(hashGameState(full));
  });

  it("does not traverse unrelated machine inventories in a construction-only transaction", () => {
    const state = fixture();
    const unrelated = structuredClone(state.entities[0]);
    unrelated.id = "unrelated-store";
    Object.defineProperty(unrelated, "inputs", { get: () => { throw new Error("unrelated inventory traversed"); } });
    state.entities.push(unrelated);
    const ledger = contract();
    const certificate = issuePureIdleConstructionRuntimePowerCertificate(state, ledger);
    expect(() => advancePureIdleConstructionDomainInPlace(state, 10, {
      runtime: createConstructionAutomationMacroRuntime(), contract: ledger, powerCertificate: certificate,
    })).not.toThrow();
  });

  it("rejects invalid construction-owned amounts and does not grant work without a valid power certificate", () => {
    const state = fixture();
    expect(advancePureIdleConstructionDomainInPlace(state, 10, { contract: contract() }).completed).toBe(0);
    expect(state.construction.arc_smelter).toBe(0);
    expect(state.entities.find((entity) => entity.buildingId === "construction_center")?.powerFactor).toBe(0);
    state.tray.iron_ore = Number.NaN;
    expect(() => advancePureIdleConstructionDomainInPlace(state, 10, { contract: contract() })).toThrow(/基线无效/);
  });

  it("refreshes the center directory after replacing the state topology", () => {
    const state = fixture();
    const runtime = createConstructionAutomationMacroRuntime();
    expect(getConstructionAutomationMacroCenters(state, runtime)).toHaveLength(1);
    state.entities = state.entities.filter((entity) => entity.buildingId !== "construction_center");
    expect(getConstructionAutomationMacroCenters(state, runtime)).toHaveLength(0);
  });
});
