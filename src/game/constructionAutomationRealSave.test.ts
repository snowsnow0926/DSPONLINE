import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advanceConstructionAutomationMacroInPlace, advanceSimulation, getConstructionAutomationStatus } from "./engine";
import { runTimeWarpApproximateSettlement } from "./offlineApproximation";
import { inspectSave, migrateGame, serializeEnvelope } from "./storage";

const fixturePath = process.env.DSP_CONSTRUCTION_AUTOMATION_FIXTURE;

describe.skipIf(!fixturePath)("construction automation real-save recovery", () => {
  it("repairs a depleted persisted intermediate without modifying the fixture", { timeout: 120_000 }, () => {
    const sourceRaw = readFileSync(fixturePath!, "utf8");
    const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
    const parsed = JSON.parse(sourceRaw) as { state?: unknown } & Record<string, unknown>;
    const state = migrateGame(parsed.state ?? parsed);
    expect(state).not.toBeNull();

    const runtime = state!;
    runtime.paused = false;
    const jobEntry = Object.entries(runtime.constructionAutomation.jobs).find(([, job]) => {
      const step = job.steps[job.stepIndex];
      return step?.kind === "building" || step?.kind === "material";
    });
    expect(jobEntry).toBeDefined();
    const [centerId, job] = jobEntry!;
    const statusBefore = getConstructionAutomationStatus(runtime, centerId);
    expect(statusBefore.blockerReason).toBe("raw-shortage");
    expect(statusBefore.stage).toContain("等待材料");
    const craftedBefore = runtime.construction[job.constructionId] ?? 0;

    const advanced = advanceSimulation(runtime, 3);
    const craftedAfter = advanced.construction[job.constructionId] ?? 0;
    const statusAfter = getConstructionAutomationStatus(advanced, centerId);
    expect(craftedAfter).toBeGreaterThan(craftedBefore);
    expect(statusAfter.missingItemId).not.toBe(statusBefore.missingItemId);

    const serialized = serializeEnvelope(advanced);
    expect(inspectSave(serialized).valid).toBe(true);
    expect(createHash("sha256").update(readFileSync(fixturePath!, "utf8")).digest("hex")).toBe(sourceSha256);
  });

  it("profiles one endgame construction-only tail and one 8x time-warp slice", { timeout: 180_000 }, () => {
    const sourceRaw = readFileSync(fixturePath!, "utf8");
    const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
    const parsed = JSON.parse(sourceRaw) as { state?: unknown } & Record<string, unknown>;
    const source = migrateGame(parsed.state ?? parsed);
    expect(source).not.toBeNull();
    source!.paused = false;
    source!.timeWarp.enabled = true;
    source!.timeWarp.pendingSimulationSeconds = 0;
    source!.timeWarp.pendingWallSeconds = 0;
    const controller = source!.entities.find((entity) => entity.buildingId === "time_warp_device");
    if (controller) source!.timeWarp.controllerEntityId = controller.id;

    const constructionCandidate = structuredClone(source!);
    const constructionStartedAt = performance.now();
    const construction = advanceConstructionAutomationMacroInPlace(constructionCandidate, 64);
    const constructionMs = performance.now() - constructionStartedAt;
    const timeWarpStartedAt = performance.now();
    const timeWarp = runTimeWarpApproximateSettlement(source!, 64, 8);
    const timeWarpMs = performance.now() - timeWarpStartedAt;
    console.log(`REAL_TIME_WARP_PROFILE ${JSON.stringify({ constructionMs, construction, timeWarpMs, report: timeWarp.report })}`);

    expect(timeWarp.state.elapsedSeconds - source!.elapsedSeconds).toBeCloseTo(64, 6);
    expect(timeWarp.report.algorithmVersion).toBe("time-warp-rolling-v5");
    expect(inspectSave(serializeEnvelope(timeWarp.state)).valid).toBe(true);
    expect(createHash("sha256").update(readFileSync(fixturePath!, "utf8")).digest("hex")).toBe(sourceSha256);
  });

});
