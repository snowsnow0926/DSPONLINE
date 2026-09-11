import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixturePath = process.env.DSP_PLAYER_TIME_WARP_FIXTURE;
const fixtureRoute = "**/__dsp_player_time_warp_fixture.json";
const harnessPath = "/__dsp_player_time_warp_harness.html";

test.describe("1.0.38 player-save pure-idle regression", () => {
  test.skip(!fixturePath, "set DSP_PLAYER_TIME_WARP_FIXTURE to a read-only exported save");

  test.beforeEach(async ({ page }) => {
    const raw = readFileSync(fixturePath!, "utf8");
    await page.route(fixtureRoute, (route) => route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: raw,
    }));
    await page.route(`**${harnessPath}`, (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><body><main>DSP player save pure-idle harness</main></body></html>",
    }));
  });

  test("compares the recorded run with exact and macro settlement without changing the source", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(harnessPath);
    const result = await page.evaluate(async () => {
      const benchmark = await import("/src/game/benchmark.ts");
      const contentPacks = await import("/src/game/contentPacks.ts");
      const engine = await import("/src/game/engine.ts");
      const macro = await import("/src/game/pureIdleMacroClient.ts");
      const offline = await import("/src/game/offlineSimulation.ts");
      const recovery = await import("/src/game/pureIdleRecovery.ts");
      const storage = await import("/src/game/storage.ts");
      const parsed = await fetch("/__dsp_player_time_warp_fixture.json").then((response) => response.json());
      const state = storage.migrateGame(parsed.state ?? parsed) as Record<string, any> | null;
      if (!state) throw new Error("fixture migration failed");
      const controller = state.entities.find((entity: Record<string, unknown>) =>
        entity.id === state.timeWarp.controllerEntityId && entity.buildingId === "time_warp_device")
        ?? state.entities.find((entity: Record<string, unknown>) => entity.buildingId === "time_warp_device");
      if (!controller?.id) throw new Error("fixture has no time-warp controller");
      const recordedWallSeconds = Number(state.idleSettlement?.currentRunElapsed ?? 0);
      const recordedProduction = structuredClone(state.idleSettlement?.currentRunProduction ?? {});
      if (!(recordedWallSeconds > 0)) throw new Error("fixture has no completed pure-idle run");

      state.paused = false;
      state.speedrun = undefined;
      state.timeWarp.controllerEntityId = controller.id;
      state.timeWarp.enabled = true;
      state.timeWarp.pendingSimulationSeconds = 0;
      state.timeWarp.pendingWallSeconds = 0;
      const sourceHash = benchmark.hashGameState(state);
      const registry = contentPacks.createContentPackRuntimeSnapshot(contentPacks.createContentPackRegistry());
      const baselineProduced = structuredClone(state.totalProduced);
      const calibrationSlices: Array<Record<string, number>> = [structuredClone(state.totalProduced)];
      let calibrationState = structuredClone(state);
      for (let index = 0; index < 3; index += 1) {
        calibrationState = engine.advanceSimulation(calibrationState, 10);
        calibrationSlices.push(structuredClone(calibrationState.totalProduced));
      }
      const calibrationItems = new Set(calibrationSlices.flatMap((slice) => Object.keys(slice)));
      const calibrationRateDrift = [...calibrationItems].map((itemId) => {
        const first = (calibrationSlices[1][itemId] ?? 0) - (calibrationSlices[0][itemId] ?? 0);
        const second = (calibrationSlices[2][itemId] ?? 0) - (calibrationSlices[1][itemId] ?? 0);
        const third = (calibrationSlices[3][itemId] ?? 0) - (calibrationSlices[2][itemId] ?? 0);
        return {
          itemId,
          first,
          second,
          third,
          tailDrift: Math.abs(third - second) / Math.max(1, Math.abs(third), Math.abs(second)),
        };
      }).sort((left, right) => right.tailDrift - left.tailDrift);

      const runMacro = async (source: Record<string, any>, wallSeconds: number) => {
        const client = new macro.PureIdleMacroClient();
        try {
          const initialized = await client.initialize(structuredClone(source), "extreme", registry);
          const finalized = await client.finalize(wallSeconds);
          return { initialized, finalized };
        } finally {
          client.close();
        }
      };

      const horizonReports: Array<Record<string, any>> = [];
      let shortMacro: Awaited<ReturnType<typeof runMacro>> | null = null;
      let shortExact: Record<string, any> | null = null;
      for (const wallSeconds of [35 / 12, 40 / 12, 5, 10, 30]) {
        const candidate = await runMacro(state, wallSeconds);
        const simulationSeconds = candidate.finalized.summary.settledSimulationSeconds;
        const exact = engine.advanceSimulation(structuredClone(state), simulationSeconds);
        const candidateDelta = Object.fromEntries(Object.keys(candidate.finalized.state.totalProduced).map((itemId) => [
          itemId,
          Math.max(0, Math.floor((candidate.finalized.state.totalProduced[itemId] ?? 0) - (baselineProduced[itemId] ?? 0))),
        ]));
        const exactDelta = Object.fromEntries(Object.keys(exact.totalProduced).map((itemId) => [
          itemId,
          Math.max(0, Math.floor((exact.totalProduced[itemId] ?? 0) - (baselineProduced[itemId] ?? 0))),
        ]));
        const horizonItems = new Set([...Object.keys(candidateDelta), ...Object.keys(exactDelta)]);
        const errors = [...horizonItems].map((itemId) => Math.abs((candidateDelta[itemId] ?? 0) - (exactDelta[itemId] ?? 0)) /
          Math.max(1, Math.abs(candidateDelta[itemId] ?? 0), Math.abs(exactDelta[itemId] ?? 0)));
        horizonReports.push({
          wallSeconds,
          simulationSeconds,
          maximumError: Math.max(0, ...errors),
          whiteMatrixError: Math.abs((candidateDelta.universe_matrix ?? 0) - (exactDelta.universe_matrix ?? 0)) /
            Math.max(1, candidateDelta.universe_matrix ?? 0, exactDelta.universe_matrix ?? 0),
        });
        if (wallSeconds === 30) {
          shortMacro = candidate;
          shortExact = exact;
        }
      }
      if (!shortMacro || !shortExact) throw new Error("short comparison was not produced");
      const shortSimulationSeconds = shortMacro.finalized.summary.settledSimulationSeconds;
      const startedAtMs = 1_000_000;
      const settledWallSeconds = shortMacro.finalized.summary.settledWallSeconds;
      const unattendedStartedAtMs = recovery.getPureIdleUnattendedBackgroundStartedAt({
        startedAtMs,
        settledWallSeconds,
        summary: shortMacro.finalized.summary,
      }, startedAtMs + recordedWallSeconds * 1_000, 60);
      if (unattendedStartedAtMs === null) throw new Error("overnight suspension was not detected");
      const routingPlan = recovery.capPureIdleBackgroundPlan(
        recovery.getPureIdleBackgroundPlan({ startedAtMs, backgroundStartedAtMs: unattendedStartedAtMs }, startedAtMs + recordedWallSeconds * 1_000),
        settledWallSeconds,
        60,
      );
      const offlineReplay = await offline.runOfflineSimulationInWorkerDetailed(
        structuredClone(state),
        recordedWallSeconds * shortMacro.initialized.actualMultiplier,
        {
          approximate: true,
          wallSeconds: recordedWallSeconds,
          deadlineMs: 30_000,
        },
      );

      const delta = (after: Record<string, number>, before: Record<string, number>) =>
        Object.fromEntries(new Set([...Object.keys(before), ...Object.keys(after)]).values().map((itemId) => [
          itemId,
          Math.max(0, Math.floor((after[itemId] ?? 0) - (before[itemId] ?? 0))),
        ]));
      const shortMacroDelta = delta(shortMacro.finalized.state.totalProduced, baselineProduced);
      const shortExactDelta = delta(shortExact.totalProduced, baselineProduced);
      const offlineDelta = offlineReplay.status === "complete"
        ? delta(offlineReplay.state.totalProduced, baselineProduced)
        : {};
      const relative = (left: number, right: number) => Math.abs(left - right) / Math.max(1, Math.abs(left), Math.abs(right));
      const itemIds = new Set([...Object.keys(shortMacroDelta), ...Object.keys(shortExactDelta)]);
      const shortErrors = [...itemIds].map((itemId) => ({
        itemId,
        macro: shortMacroDelta[itemId] ?? 0,
        exact: shortExactDelta[itemId] ?? 0,
        error: relative(shortMacroDelta[itemId] ?? 0, shortExactDelta[itemId] ?? 0),
      })).sort((left, right) => right.error - left.error);
      return {
        sourceUnchanged: benchmark.hashGameState(state) === sourceHash,
        recordedWallSeconds,
        requestedMultiplier: state.timeWarp.requestedMultiplier,
        initializedMultiplier: shortMacro.initialized.actualMultiplier,
        finalMultiplier: shortMacro.finalized.summary.actualMultiplier,
        settlementMode: shortMacro.initialized.settlementMode,
        shortSimulationSeconds,
        calibrationLargestDrifts: calibrationRateDrift.slice(0, 12),
        horizonReports,
        shortMaximumError: shortErrors[0]?.error ?? 0,
        shortLargestErrors: shortErrors.slice(0, 12),
        routingPlan,
        offlineReplay: {
          status: offlineReplay.status,
          approximation: offlineReplay.approximation,
          whiteMatrix: offlineDelta.universe_matrix ?? 0,
        },
        whiteMatrix: {
          recorded: recordedProduction.universe_matrix ?? 0,
          shortMacro: shortMacroDelta.universe_matrix ?? 0,
          shortExact: shortExactDelta.universe_matrix ?? 0,
        },
        valid: storage.inspectSave(storage.serializeEnvelope(shortMacro.finalized.state)).valid,
      };
    });

    console.log(`PLAYER_PURE_IDLE_DIAGNOSTIC ${JSON.stringify(result)}`);
    expect(result.sourceUnchanged).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.recordedWallSeconds).toBeGreaterThan(0);
    expect(result.initializedMultiplier).toBeGreaterThanOrEqual(1);
    expect(result.finalMultiplier).toBeGreaterThanOrEqual(1);
    expect(result.settlementMode).toBe("bounded-exact");
    expect(result.shortSimulationSeconds).toBeGreaterThanOrEqual(30);
    expect(result.shortMaximumError).toBe(0);
    expect(result.horizonReports.every((report) => report.maximumError === 0)).toBe(true);
    expect(result.routingPlan.highWallSeconds).toBeLessThanOrEqual(90);
    expect(result.routingPlan.normalOfflineSeconds).toBeGreaterThan(0);
  });
});
