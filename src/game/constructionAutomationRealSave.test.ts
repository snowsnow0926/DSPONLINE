import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { describe, expect, it } from "vitest";
import { advanceConstructionAutomationMacroInPlace, advanceSimulation, getConstructionAutomationStatus } from "./engine";
import {
  runTimeWarpApproximateSettlement,
  TIME_WARP_APPROXIMATION_ALGORITHM_VERSION,
} from "./offlineApproximation";
import { inspectSave, migrateGame, serializeEnvelope } from "./storage";

const fixturePath = process.env.DSP_CONSTRUCTION_AUTOMATION_FIXTURE;
const recoveryFixturePath = process.env.DSP_CONSTRUCTION_RECOVERY_FIXTURE;

describe("construction automation real-save recovery", () => {
  // Stress saves need not contain a blocked persisted job; recovery needs
  // its own explicitly supplied fixture with that precondition.
  it.skipIf(!recoveryFixturePath)("repairs a depleted persisted intermediate without modifying the fixture", { timeout: 120_000 }, () => {
    const sourceRaw = readFileSync(recoveryFixturePath!, "utf8");
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
    expect(createHash("sha256").update(readFileSync(recoveryFixturePath!, "utf8")).digest("hex")).toBe(sourceSha256);
  });

  it.skipIf(!fixturePath)("profiles one endgame construction-only tail and one 8x time-warp slice", { timeout: 180_000 }, async () => {
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
    const cpu = process.env.DSP_CONSTRUCTION_CPU_PROFILE === "1" ? new Session() : undefined;
    if (cpu) {
      cpu.connect();
      await new Promise<void>((resolve, reject) => cpu.post("Profiler.enable", (error) => error ? reject(error) : resolve()));
    }
    const startCpu = async () => {
      if (cpu) await new Promise<void>((resolve, reject) => cpu.post("Profiler.start", (error) => error ? reject(error) : resolve()));
    };
    const stopCpu = async (name: string) => {
      if (!cpu) return;
      await new Promise<void>((resolve, reject) => cpu.post("Profiler.stop", (error, result) => {
        if (error) return reject(error);
        const directory = process.env.DSP_CONSTRUCTION_PROFILE_DIR ?? "artifacts/endgame-deep-20261026";
        mkdirSync(directory, { recursive: true });
        writeFileSync(`${directory}/${name}.cpuprofile`, JSON.stringify(result.profile));
        resolve();
      }));
    };
    await startCpu();
    const constructionStartedAt = performance.now();
    const construction = advanceConstructionAutomationMacroInPlace(constructionCandidate, 64);
    const constructionMs = performance.now() - constructionStartedAt;
    await stopCpu("construction-only");
    await startCpu();
    const timeWarpStartedAt = performance.now();
    const timeWarp = runTimeWarpApproximateSettlement(source!, 64, 8);
    const timeWarpMs = performance.now() - timeWarpStartedAt;
    await stopCpu("time-warp");
    cpu?.disconnect();
    expect(timeWarp.state.elapsedSeconds - source!.elapsedSeconds).toBeCloseTo(64, 6);
    expect(timeWarp.report.algorithmVersion).toBe(TIME_WARP_APPROXIMATION_ALGORITHM_VERSION);
    const serialized = serializeEnvelope(timeWarp.state, 1_800_000_000_000);
    expect(inspectSave(serialized).valid).toBe(true);
    console.log(`REAL_TIME_WARP_PROFILE ${JSON.stringify({ constructionMs, construction, timeWarpMs,
      report: timeWarp.report, persistedSha256: createHash("sha256").update(serialized).digest("hex") })}`);
    expect(createHash("sha256").update(readFileSync(fixturePath!, "utf8")).digest("hex")).toBe(sourceSha256);
  });

});
