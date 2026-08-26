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
realSaveDescribe("1.2.0 real-save conservative pure-idle conservation gate", () => {
  it("keeps the unproven tail frozen, reloadable, and source-file exact", { timeout: 180_000 }, () => {
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

    const session = createPureIdleMacroSession(structuredClone(checkpoint), "extreme", {
      forceConservativeReason: "1.2.0 real-save conservation release gate",
    });
    const result = finalizePureIdleMacroCandidate(session, 30);

    expect(result.summary).toMatchObject({
      algorithmVersion: PURE_IDLE_MACRO_ALGORITHM_VERSION,
      conservativeOnly: true,
      settledWallSeconds: 30,
    });
    expect(result.summary.actualMultiplier).toBeGreaterThanOrEqual(1);
    expect(validatePureIdleTerminalMaterialConservation(checkpoint, result.state)).toBeNull();
    expect(result.state.dysonSphere.structurePoints - checkpoint.dysonSphere.structurePoints)
      .toBe(result.state.dysonSphere.totalRocketsLaunched - checkpoint.dysonSphere.totalRocketsLaunched);
    expect(hashGameState(checkpoint)).toBe(checkpointHash);

    const reloaded = inspectSave(serializeEnvelope(result.state));
    expect(reloaded).toMatchObject({ valid: true, checksum: "valid", formatVersion: 2, stateVersion: 47 });
    expect(validatePureIdleTerminalMaterialConservation(checkpoint, reloaded.state!)).toBeNull();

    const afterStat = statSync(fixturePath!);
    const afterRaw = readFileSync(fixturePath!, "utf8");
    expect({
      size: afterStat.size,
      mtimeMs: afterStat.mtimeMs,
      hash: createHash("sha256").update(afterRaw, "utf8").digest("hex"),
    }).toEqual({ size: beforeStat.size, mtimeMs: beforeStat.mtimeMs, hash: sourceFileHash });
  });
});
