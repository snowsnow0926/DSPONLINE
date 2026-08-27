import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashGameState } from "./benchmark";
import { validatePureIdleTerminalMaterialConservation } from "./offlineApproximation";
import {
  createPureIdleMacroSession,
  finalizePureIdleMacroCandidate,
  PURE_IDLE_MACRO_ALGORITHM_VERSION,
} from "./pureIdleMacro";
import { inspectSave, migrateGame, serializeEnvelope } from "./storage";

const fixturePath = process.env.DSP_V120_REAL_PURE_IDLE_FIXTURE;
const realSaveDescribe = fixturePath ? describe : describe.skip;

/**
 * Opt-in, read-only release gate for a private large save. The path is supplied
 * by the release operator and is never persisted in the repository:
 *
 *   DSP_V120_REAL_PURE_IDLE_FIXTURE=<path> npx vitest run src/game/pureIdleMacroRealSave.test.ts
 */
realSaveDescribe("1.2.3 real-save multi-system event-ledger pure-idle gate", () => {
  it("extrapolates ordinary production and funded multi-system rockets without mutating the source", { timeout: 180_000 }, () => {
    const testStartedAt = performance.now();
    const beforeStat = statSync(fixturePath!);
    const sourceRaw = readFileSync(fixturePath!, "utf8");
    const sourceFileHash = createHash("sha256").update(sourceRaw, "utf8").digest("hex");
    const inspection = inspectSave(sourceRaw);
    expect(inspection).toMatchObject({ valid: true, checksum: "valid", formatVersion: 2, stateVersion: 47 });
    const migrated = migrateGame(inspection.state);
    expect(migrated).not.toBeNull();

    const checkpoint = structuredClone(migrated!);
    checkpoint.paused = false;
    checkpoint.timeWarp.enabled = true;
    checkpoint.timeWarp.requestedMultiplier = 15;
    checkpoint.timeWarp.pendingSimulationSeconds = 0;
    checkpoint.timeWarp.pendingWallSeconds = 0;
    const controller = checkpoint.entities.find((entity) => entity.buildingId === "time_warp_device");
    expect(controller).toBeDefined();
    checkpoint.timeWarp.controllerEntityId = controller!.id;
    const checkpointHash = hashGameState(checkpoint);

    const calibrationStartedAt = performance.now();
    const session = createPureIdleMacroSession(structuredClone(checkpoint), "extreme", {
      forceConservativeReason: "1.2.3 real-save event-ledger development gate",
      // Match the production Worker: the incoming graph is already isolated
      // by postMessage, so calibration consumes it instead of cloning again.
      consumeCalibrationState: true,
    });
    const calibrationFinishedAt = performance.now();
    const calibrated = session.candidate;
    expect(session.calibrationCheckpoint).toBeUndefined();
    expect(session.settledSimulationSeconds).toBe(30);
    const calibratedWhiteDelta = (calibrated.totalProduced.universe_matrix ?? 0) -
      (checkpoint.totalProduced.universe_matrix ?? 0);
    const calibratedRocketDelta = calibrated.dysonSphere.totalRocketsLaunched -
      checkpoint.dysonSphere.totalRocketsLaunched;
    const calibratedRocketPlanDeltas = Object.fromEntries(Object.entries(calibrated.dysonPlans)
      .map(([systemId, plan]) => [
        systemId,
        plan.structurePoints - checkpoint.dysonPlans[systemId as keyof typeof checkpoint.dysonPlans].structurePoints,
      ] as const)
      .filter(([, delta]) => delta > 0));
    expect(Object.keys(calibratedRocketPlanDeltas).length).toBeGreaterThan(1);
    expect(session.rocketLedger).toBeDefined();
    expect(calibratedWhiteDelta).toBeGreaterThan(0);
    const targetWallSeconds = 10 * 60;
    const result = finalizePureIdleMacroCandidate(session, targetWallSeconds);
    const settlementFinishedAt = performance.now();
    const finalWhiteDelta = (result.state.totalProduced.universe_matrix ?? 0) -
      (checkpoint.totalProduced.universe_matrix ?? 0);
    const whiteLine = result.summary.terminalLines.find((line) => line.id === "white-matrix");
    const rocketLine = result.summary.terminalLines.find((line) => line.id === "dyson-rockets");
    const sailLine = result.summary.terminalLines.find((line) => line.id === "solar-sails");

    expect(result.summary).toMatchObject({
      algorithmVersion: PURE_IDLE_MACRO_ALGORITHM_VERSION,
      conservativeOnly: true,
      calibrationWindowsCompleted: 3,
      contractVersion: 1,
      settledWallSeconds: targetWallSeconds,
    });
    const finalRocketDelta = result.state.dysonSphere.totalRocketsLaunched -
      checkpoint.dysonSphere.totalRocketsLaunched;
    console.info("[pure-idle-v8-multisystem-rocket-ledger-real-save-settlement]", JSON.stringify({
      contractDeltas: session.contract.deltas.length,
      rocketLedger: session.rocketLedger,
      rocketBoundarySeconds: session.contract.maximumSimulationSecondsByItem?.small_carrier_rocket,
      calibratedRocketPlanDeltas,
      finalWhiteDelta,
      calibratedWhiteDelta,
      lastValidationReason: result.summary.lastValidationReason,
      degradedReason: result.summary.degradedReason,
      boundaryCorrections: result.summary.boundaryCorrections,
      steadyStateItemCount: Object.keys(session.contract.steadyStateFactorsByItem ?? {}).length,
      universeMatrixSteadyFactor: session.contract.steadyStateFactorsByItem?.universe_matrix,
      minimumEfficiency: result.summary.minimumEfficiency,
    }));
    expect(result.summary.actualMultiplier).toBeGreaterThanOrEqual(1);
    expect(finalWhiteDelta).toBeGreaterThan(calibratedWhiteDelta);
    expect(finalRocketDelta).toBeGreaterThan(calibratedRocketDelta);
    expect(session.contract.steadyStateFactorsByItem?.universe_matrix).toBeGreaterThan(0);
    expect(session.contract.maximumSimulationSecondsByItem?.universe_matrix).toBeUndefined();
    expect(whiteLine?.efficiency).toBeGreaterThan(0);
    expect(whiteLine?.sustainableRatePerMinute).toBeGreaterThan(0);
    expect(rocketLine?.efficiency).toBeGreaterThan(0);
    expect(sailLine?.efficiency).toBeNull();
    expect(result.summary.minimumEfficiency).toBeGreaterThan(0);
    for (const systemId of Object.keys(calibratedRocketPlanDeltas) as Array<keyof typeof checkpoint.dysonPlans>) {
      expect(result.state.dysonPlans[systemId].structurePoints - checkpoint.dysonPlans[systemId].structurePoints)
        .toBeGreaterThan(calibratedRocketPlanDeltas[systemId]);
    }
    expect(validatePureIdleTerminalMaterialConservation(checkpoint, result.state)).toBeNull();
    expect(result.state.dysonSphere.structurePoints - checkpoint.dysonSphere.structurePoints)
      .toBe(result.state.dysonSphere.totalRocketsLaunched - checkpoint.dysonSphere.totalRocketsLaunched);
    expect(hashGameState(checkpoint)).toBe(checkpointHash);

    const serializationStartedAt = performance.now();
    const reloaded = inspectSave(serializeEnvelope(result.state));
    const serializationFinishedAt = performance.now();
    expect(reloaded).toMatchObject({ valid: true, checksum: "valid", formatVersion: 2, stateVersion: 47 });
    expect(validatePureIdleTerminalMaterialConservation(checkpoint, reloaded.state!)).toBeNull();

    const afterStat = statSync(fixturePath!);
    const afterRaw = readFileSync(fixturePath!, "utf8");
    expect({
      size: afterStat.size,
      mtimeMs: afterStat.mtimeMs,
      hash: createHash("sha256").update(afterRaw, "utf8").digest("hex"),
    }).toEqual({ size: beforeStat.size, mtimeMs: beforeStat.mtimeMs, hash: sourceFileHash });
    console.info("[pure-idle-v8-multisystem-rocket-ledger-real-save]", JSON.stringify({
      sourceBytes: beforeStat.size,
      entityCount: checkpoint.entities.length,
      beltCount: checkpoint.belts.length,
      targetWallSeconds,
      actualMultiplier: result.summary.actualMultiplier,
      calibratedWhiteDelta,
      finalWhiteDelta,
      calibratedRocketDelta,
      finalRocketDelta,
      calibrationMs: Math.round(calibrationFinishedAt - calibrationStartedAt),
      settlementMs: Math.round(settlementFinishedAt - calibrationFinishedAt),
      serializationAndReloadMs: Math.round(serializationFinishedAt - serializationStartedAt),
      totalTestMs: Math.round(performance.now() - testStartedAt),
      heapUsedMiBAtEnd: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    }));
  });
});
