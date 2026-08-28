import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import { createInitialState } from "./engine";
import {
  advanceConstructionAutomationMacroWithReceiptInPlace,
  capturePureIdleCombinedConservationCheckpoint,
  createPureIdleLightweightCalibration,
  validatePureIdleCombinedSettlementConservation,
  type PureIdleAffineContract,
  type PureIdleCombinedConservationCheckpoint,
  type PureIdleConstructionPowerCertificate,
} from "./offlineApproximation";
import { getQuantumBandwidthSummary, QUANTUM_SETTLEMENT_SECONDS } from "./quantumLogisticsNetwork";
import { advancePureIdleMacroSession, createPureIdleMacroSession } from "./pureIdleMacro";
import type { FactoryEntity, GameState } from "./types";

function quantumConstructionFixture(centerCount = 1, target = 200): GameState {
  const state = createInitialState(20_260_828, false);
  state.entities = [];
  state.belts = [];
  state.timeWarp.controllerEntityId = null;
  state.tray = {};
  state.planetTrays.home = state.tray;
  state.research.completedTechIds = [...new Set([
    ...state.research.completedTechIds,
    "construction_automation" as const,
  ])];
  state.construction.arc_smelter = 0;
  state.constructionAutomation.enabled = true;
  state.constructionAutomation.quantumSourceEnabled = true;
  state.constructionAutomation.targetStock = { arc_smelter: target };
  state.constructionAutomation.jobs = {};
  delete state.constructionAutomation.quantumMaterialBuffer;
  state.quantumLogisticsNetwork.enabled = true;
  state.quantumLogisticsNetwork.inventory = {
    iron_ore: "1000000",
    copper_ore: "1000000",
    stone: "1000000",
  };
  const centers: FactoryEntity[] = Array.from({ length: centerCount }, (_, index) => ({
    id: `macro-quantum-center-${index}`,
    kind: "machine",
    planetId: "home",
    position: { x: index * 40, y: 0 },
    interactionLocked: false,
    buildingId: "construction_center",
    inputs: {},
    outputs: {},
    progress: 0,
    utilization: 0,
    productionRate: 0,
    routingCursor: 0,
    machineCount: 10,
    minerCount: 0,
  }));
  state.entities.push(
    ...centers,
    {
      id: "macro-quantum-tower",
      kind: "station",
      planetId: "home",
      position: { x: 200, y: 0 },
      interactionLocked: false,
      buildingId: "interstellar_logistics_station",
      stationTier: 2,
      quantumMode: "quantum",
      stationSlots: [],
      stationRoutes: [],
      inputs: {},
      outputs: {},
      progress: 0,
      utilization: 0,
      productionRate: 0,
      routingCursor: 0,
      machineCount: 1,
      minerCount: 0,
    },
    {
      id: "macro-quantum-wind",
      kind: "power",
      planetId: "home",
      position: { x: 240, y: 0 },
      interactionLocked: false,
      buildingId: "wind_turbine",
      inputs: {},
      outputs: {},
      progress: 0,
      utilization: 0,
      productionRate: 0,
      routingCursor: 0,
      machineCount: 100_000,
      minerCount: 0,
    },
  );
  return state;
}

function enableQuantumConstructionTimeWarp(state: GameState, multiplier = 12): void {
  state.entities.push({
    id: "macro-quantum-warp",
    kind: "machine",
    planetId: "home",
    position: { x: 280, y: 0 },
    interactionLocked: false,
    buildingId: "time_warp_device",
    inputs: {},
    outputs: {},
    progress: 0,
    utilization: 0,
    productionRate: 0,
    routingCursor: 0,
    machineCount: 1,
    minerCount: 0,
  });
  state.timeWarp = {
    ...state.timeWarp,
    enabled: true,
    controllerEntityId: "macro-quantum-warp",
    requestedMultiplier: multiplier,
    effectiveMultiplier: multiplier,
    pendingSimulationSeconds: 0,
    pendingWallSeconds: 0,
  };
}

interface PreparedQuantumConstruction {
  source: GameState;
  state: GameState;
  contract: PureIdleAffineContract;
  certificate: PureIdleConstructionPowerCertificate;
  checkpoint: PureIdleCombinedConservationCheckpoint;
}

function prepareQuantumConstruction(source = quantumConstructionFixture()): PreparedQuantumConstruction {
  const calibrated = createPureIdleLightweightCalibration(
    structuredClone(source),
    30,
    { isolateConstructionAutomation: true },
  );
  if (!calibrated) throw new Error("quantum construction calibration failed");
  return {
    source,
    state: calibrated.calibratedState,
    contract: calibrated.contract,
    certificate: calibrated.constructionPowerCertificate,
    checkpoint: capturePureIdleCombinedConservationCheckpoint(calibrated.calibratedState),
  };
}

function settlePrepared(prepared: PreparedQuantumConstruction, segments: readonly number[]): GameState {
  for (const seconds of segments) {
    prepared.state.elapsedSeconds += seconds;
    advanceConstructionAutomationMacroWithReceiptInPlace(
      prepared.state,
      seconds,
      prepared.checkpoint,
      { powerCertificate: prepared.certificate, contract: prepared.contract },
    );
  }
  expect(validatePureIdleCombinedSettlementConservation(prepared.checkpoint, prepared.state)).toBeNull();
  return prepared.state;
}

function quantumInventoryTotal(state: GameState): bigint {
  return Object.values(state.quantumLogisticsNetwork.inventory)
    .reduce((sum, amount) => sum + BigInt(amount), 0n);
}

function constructionQuantumBufferTotal(state: GameState): number {
  return Object.values(state.constructionAutomation.quantumMaterialBuffer ?? {})
    .flatMap((store) => Object.values(store))
    .reduce((sum, amount) => sum + Math.max(0, Math.floor(amount ?? 0)), 0);
}

function constructionQuantumSnapshot(state: GameState): unknown {
  return {
    crafted: state.constructionAutomation.totalCrafted,
    arcSmelters: state.construction.arc_smelter,
    jobs: state.constructionAutomation.jobs,
    buffer: state.constructionAutomation.quantumMaterialBuffer,
    inventory: state.quantumLogisticsNetwork.inventory,
    routingCursors: state.quantumLogisticsNetwork.routingCursors,
    centers: state.entities
      .filter((entity) => entity.buildingId === "construction_center")
      .map(({ id, progress, utilization, productionRate, powerFactor, powerInputKw }) => ({
        id, progress, utilization, productionRate, powerFactor, powerInputKw,
      })),
  };
}

describe("bounded quantum construction replay", () => {
  it("keeps 60 seconds equal to 17+43 and 20+20+20 without replaying the whole factory", () => {
    const source = quantumConstructionFixture(2, 1_000);
    const sourceHash = hashGameState(source);
    const single = settlePrepared(prepareQuantumConstruction(structuredClone(source)), [60]);
    const split = settlePrepared(prepareQuantumConstruction(structuredClone(source)), [17, 43]);
    const thirds = settlePrepared(prepareQuantumConstruction(structuredClone(source)), [20, 20, 20]);

    expect(single.construction.arc_smelter).toBeGreaterThan(0);
    expect(hashGameState(split)).toBe(hashGameState(single));
    expect(hashGameState(thirds)).toBe(hashGameState(single));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps the public pure-idle session deterministic across absolute target calls", () => {
    const source = quantumConstructionFixture(2, 1_000);
    enableQuantumConstructionTimeWarp(source);
    const sourceHash = hashGameState(source);
    const single = createPureIdleMacroSession(structuredClone(source), "extreme");
    const segmented = createPureIdleMacroSession(structuredClone(source), "extreme");

    advancePureIdleMacroSession(single, 10);
    advancePureIdleMacroSession(segmented, 3);
    advancePureIdleMacroSession(segmented, 10);

    expect(single.candidate.construction.arc_smelter).toBeGreaterThan(0);
    expect(constructionQuantumSnapshot(segmented.candidate))
      .toEqual(constructionQuantumSnapshot(single.candidate));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("credits quantum replay only for adopted non-initial calibration seconds", () => {
    const source = quantumConstructionFixture(1, 1_000_000);
    enableQuantumConstructionTimeWarp(source);
    const session = createPureIdleMacroSession(structuredClone(source), "stable");
    const initialCheckpoint = session.calibrationCheckpoint;
    expect(initialCheckpoint).toBeDefined();
    if (!initialCheckpoint) return;

    const initialEnd = initialCheckpoint.baseWallSeconds + initialCheckpoint.wallSeconds;
    advancePureIdleMacroSession(session, initialEnd);
    const inventoryAfterInitialReplay = quantumInventoryTotal(session.candidate);
    expect(inventoryAfterInitialReplay).toBeLessThan(quantumInventoryTotal(source));

    // The first exact checkpoint owns the original 30-second replay budget;
    // adopting it must not grant a second copy of the same interval.
    advancePureIdleMacroSession(session, initialEnd + initialCheckpoint.wallSeconds);
    expect(quantumInventoryTotal(session.candidate)).toBe(inventoryAfterInitialReplay);

    session.nextValidationAtWallSeconds = session.settledWallSeconds + (1 / session.actualMultiplier);
    advancePureIdleMacroSession(session, session.nextValidationAtWallSeconds);
    const laterCheckpoint = session.calibrationCheckpoint;
    expect(session.validationCount).toBe(1);
    expect(laterCheckpoint?.baseWallSeconds).toBeGreaterThan(0);
    if (!laterCheckpoint) return;
    const inventoryBeforeLaterReplay = quantumInventoryTotal(session.candidate);

    const laterMidpoint = laterCheckpoint.baseWallSeconds + laterCheckpoint.wallSeconds / 2;
    const laterEnd = laterCheckpoint.baseWallSeconds + laterCheckpoint.wallSeconds;
    advancePureIdleMacroSession(session, laterMidpoint);
    const inventoryAfterFirstHalf = quantumInventoryTotal(session.candidate);
    expect(inventoryAfterFirstHalf).toBeLessThan(inventoryBeforeLaterReplay);

    advancePureIdleMacroSession(session, laterEnd);
    const inventoryAfterLaterReplay = quantumInventoryTotal(session.candidate);
    expect(inventoryAfterLaterReplay).toBeLessThan(inventoryAfterFirstHalf);
    expect(session.calibrationCheckpoint).toBeUndefined();

    // Both adopted halves consumed their own 15-second credits. No hidden
    // full-window grant may remain for an unrelated later macro interval.
    advancePureIdleMacroSession(session, laterEnd + laterCheckpoint.wallSeconds);
    expect(quantumInventoryTotal(session.candidate)).toBe(inventoryAfterLaterReplay);
  });

  it("shares one global download budget between two centers without copying warehouse material", () => {
    const prepared = prepareQuantumConstruction(quantumConstructionFixture(2, 1_000));
    const beforeInventory = quantumInventoryTotal(prepared.state);
    const level = prepared.state.endgame.infiniteResearch.galactic_logistics?.level ?? 0;
    const bandwidth = getQuantumBandwidthSummary(prepared.state.entities, level);
    const downloadPerBoundary = Math.floor(
      bandwidth.globalDownloadPerMinute * QUANTUM_SETTLEMENT_SECONDS / 60,
    );

    settlePrepared(prepared, [60]);

    const afterInventory = quantumInventoryTotal(prepared.state);
    expect(beforeInventory - afterInventory).toBeGreaterThan(0n);
    expect(beforeInventory - afterInventory).toBeLessThanOrEqual(BigInt(downloadPerBoundary * 6));
    expect(prepared.state.construction.arc_smelter).toBeGreaterThan(0);
    expect(Object.values(prepared.state.quantumLogisticsNetwork.routingCursors)
      .every((cursor) => Number.isSafeInteger(cursor) && cursor >= 0)).toBe(true);
  });

  it("delivers only at an absolute five-second boundary and consumes it in the following interval", () => {
    const prepared = prepareQuantumConstruction(quantumConstructionFixture(1, 1_000));
    const inventoryAtStart = quantumInventoryTotal(prepared.state);

    settlePrepared(prepared, [3]);
    expect(quantumInventoryTotal(prepared.state)).toBe(inventoryAtStart);
    expect(constructionQuantumBufferTotal(prepared.state)).toBe(0);
    expect(prepared.state.constructionAutomation.totalCrafted).toBe(0);

    settlePrepared(prepared, [2]);
    const deliveredAtBoundary = inventoryAtStart - quantumInventoryTotal(prepared.state);
    expect(deliveredAtBoundary).toBeGreaterThan(0n);
    expect(constructionQuantumBufferTotal(prepared.state)).toBe(Number(deliveredAtBoundary));
    expect(prepared.state.constructionAutomation.totalCrafted).toBe(0);

    settlePrepared(prepared, [5]);
    expect(prepared.state.constructionAutomation.totalCrafted).toBeGreaterThan(0);
  });

  it("accepts a bandwidth-limited partial delivery instead of starving a large center", () => {
    const source = quantumConstructionFixture(1, 1_000_000);
    source.entities.find((entity) => entity.id === "macro-quantum-center-0")!.machineCount = 100_000;
    source.entities.find((entity) => entity.id === "macro-quantum-wind")!.machineCount = 10_000_000;
    const prepared = prepareQuantumConstruction(source);
    const level = prepared.state.endgame.infiniteResearch.galactic_logistics?.level ?? 0;
    const cap = Math.floor(
      getQuantumBandwidthSummary(prepared.state.entities, level).globalDownloadPerMinute *
      QUANTUM_SETTLEMENT_SECONDS / 60,
    );
    const before = quantumInventoryTotal(prepared.state);

    settlePrepared(prepared, [5]);

    expect(before - quantumInventoryTotal(prepared.state)).toBe(BigInt(cap));
    expect(constructionQuantumBufferTotal(prepared.state)).toBe(cap);
    expect(prepared.state.constructionAutomation.totalCrafted).toBe(0);
  });

  it("stops after warehouse depletion without replaying the long empty tail", () => {
    const source = quantumConstructionFixture(2, 1_000_000);
    source.quantumLogisticsNetwork.inventory = {
      iron_ore: "120",
      copper_ore: "80",
      stone: "40",
    };
    const prepared = prepareQuantumConstruction(source);
    const startedAt = performance.now();

    settlePrepared(prepared, [1_000_000]);
    const inventoryAfter = structuredClone(prepared.state.quantumLogisticsNetwork.inventory);
    const bufferAfter = structuredClone(prepared.state.constructionAutomation.quantumMaterialBuffer);
    const craftedAfter = prepared.state.constructionAutomation.totalCrafted;
    settlePrepared(prepared, [1_000_000]);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(Object.values(prepared.state.quantumLogisticsNetwork.inventory)
      .every((amount) => BigInt(amount) >= 0n)).toBe(true);
    expect(prepared.state.quantumLogisticsNetwork.inventory).toEqual(inventoryAfter);
    expect(prepared.state.constructionAutomation.quantumMaterialBuffer).toEqual(bufferAfter);
    expect(prepared.state.constructionAutomation.totalCrafted).toBe(craftedAfter);
  });

  it("continues consuming already-owned center buffers after the download replay budget ends", () => {
    const prepared = prepareQuantumConstruction(quantumConstructionFixture(1, 1_000_000));

    settlePrepared(prepared, [30]);
    const inventoryAfterReplay = structuredClone(prepared.state.quantumLogisticsNetwork.inventory);
    const craftedAfterReplay = prepared.state.constructionAutomation.totalCrafted;
    expect(constructionQuantumBufferTotal(prepared.state)).toBeGreaterThan(0);

    settlePrepared(prepared, [30]);

    expect(prepared.state.quantumLogisticsNetwork.inventory).toEqual(inventoryAfterReplay);
    expect(prepared.state.constructionAutomation.totalCrafted).toBeGreaterThan(craftedAfterReplay);
  });

  it("does not claim bandwidth when an ordinary quantum demand endpoint competes", () => {
    const source = quantumConstructionFixture(1, 100);
    const tower = source.entities.find((entity) => entity.id === "macro-quantum-tower")!;
    tower.stationSlots = [{
      itemId: "iron_ore",
      localMode: "storage",
      remoteMode: "demand",
      minimumLoad: 1,
      minStock: 0,
      maxStock: 10_000,
      priority: 1,
      routePolicy: "relay-preferred",
      warperBudget: 2,
    }];
    const prepared = prepareQuantumConstruction(source);
    const inventoryBefore = structuredClone(prepared.state.quantumLogisticsNetwork.inventory);

    settlePrepared(prepared, [600]);

    expect(prepared.state.construction.arc_smelter).toBe(0);
    expect(prepared.state.quantumLogisticsNetwork.inventory).toEqual(inventoryBefore);
  });

  it("freezes an empty warehouse long window in bounded time and keeps the source hash unchanged", () => {
    const source = quantumConstructionFixture(2, 1_000_000);
    source.quantumLogisticsNetwork.inventory = {};
    const sourceHash = hashGameState(source);
    const prepared = prepareQuantumConstruction(structuredClone(source));
    const startedAt = performance.now();

    settlePrepared(prepared, [1_000_000]);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(prepared.state.construction.arc_smelter).toBe(0);
    expect(Object.values(prepared.state.quantumLogisticsNetwork.inventory)
      .every((amount) => BigInt(amount) === 0n)).toBe(true);
    expect(hashGameState(source)).toBe(sourceHash);
  });
});
