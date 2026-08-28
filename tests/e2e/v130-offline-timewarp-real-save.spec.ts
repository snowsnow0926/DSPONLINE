import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixturePath = process.env.DSP_REAL_OFFLINE_TIME_WARP_FIXTURE;
const fixtureRoute = "**/__dsp_real_offline_timewarp_fixture.json";
const harnessPath = "/__dsp_worker_harness.html";

test.describe("1.2.3 real-save offline and pure-idle workers", () => {
  test.skip(!fixturePath, "set DSP_REAL_OFFLINE_TIME_WARP_FIXTURE to a read-only save path");

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
      body: "<!doctype html><html><body><main>DSP worker test harness</main></body></html>",
    }));
  });

  test("one 30-day offline settlement commits a valid save without retaining duplicate endgame states", async ({ page }) => {
    // A real player settles one absence window. Running four independent
    // 40+ MiB candidates in one renderer measures cumulative test retention,
    // not the production operation, and can crash Chromium after the first
    // successful result. Keep this gate representative and give the large-save
    // classifier's 90-second transactional deadline room to finish.
    test.setTimeout(180_000);
    await page.goto(harnessPath);
    const result = await page.evaluate(async () => {
      const loadModule = new Function("specifier", "return import(specifier)") as
        (specifier: string) => Promise<Record<string, (...args: never[]) => unknown>>;
      const storage = await loadModule("/src/game/storage.ts");
      const contentPacks = await loadModule("/src/game/contentPacks.ts");
      const saveTransfer = await loadModule("/src/game/saveTransfer.ts");
      const parsed = await fetch("/__dsp_real_offline_timewarp_fixture.json").then((response) => response.json());
      const state = storage.migrateGame(parsed.state ?? parsed) as Record<string, any> | null;
      if (!state) throw new Error("fixture migration failed");
      state.paused = false;
      state.timeWarp.pendingSimulationSeconds = 0;
      state.timeWarp.pendingWallSeconds = 0;
      const source = JSON.stringify({
        elapsedSeconds: state.elapsedSeconds,
        savedAt: state.savedAt,
        totalProduced: state.totalProduced,
        dysonSphere: state.dysonSphere,
      });
      const registry = contentPacks.createContentPackRuntimeSnapshot(contentPacks.loadContentPackRegistry()) as Record<string, unknown>;
      const worker = new Worker(new URL("/src/game/offlineSimulation.worker.ts", window.location.href), {
        type: "module",
        name: "real-save-offline-e2e",
      });
      const seconds = 30 * 24 * 60 * 60;
      const phases: string[] = [];
      const heapBefore = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
      const startedAt = performance.now();
      const response = await new Promise<Record<string, any>>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("offline Worker exceeded 120 seconds")), 120_000);
        worker.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error("offline Worker failed"));
        };
        worker.onmessage = (event: MessageEvent<Record<string, any>>) => {
          if (event.data.id !== 1) return;
          if (event.data.type === "progress") {
            phases.push(String(event.data.phase));
            return;
          }
          window.clearTimeout(timeout);
          if (event.data.type === "complete" || event.data.type === "decision-required") resolve(event.data);
          else reject(new Error(event.data.message ?? event.data.type ?? "offline Worker returned an unknown result"));
        };
        worker.postMessage({
          type: "start",
          id: 1,
          state,
          seconds,
          wallSeconds: seconds,
          registry,
          approximate: true,
          deadlineMs: 90_000,
        });
      });
      const workerRoundTripMs = performance.now() - startedAt;
      const validationStartedAt = performance.now();
      const committed = response.type === "complete";
      const output = (committed ? (() => {
        const raw = saveTransfer.decodeVerifiedSaveTransfer(response.payloadBytes, {
          integrity: "valid",
          stateChecksum: response.summary?.stateChecksum,
          payloadChecksum: response.payloadChecksum,
          byteLength: response.byteLength,
        }) as string;
        return (JSON.parse(raw) as { state: Record<string, any> }).state;
      })() : state) as Record<string, any>;
      const serialized = storage.serializeEnvelope(output) as string;
      const inspection = storage.inspectSave(serialized) as { valid: boolean };
      const report = {
        seconds,
        roundTripMs: performance.now() - startedAt,
        workerRoundTripMs,
        validationMs: performance.now() - validationStartedAt,
        heapBefore,
        heapAfter: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
        approximation: response.approximation,
        committed,
        phases: [...new Set(phases)],
        elapsedAdvance: output.elapsedSeconds - state.elapsedSeconds,
        valid: inspection.valid,
        criticalFinite: [
          output.totalProduced?.universe_matrix ?? 0,
          output.dysonSphere?.totalRocketsLaunched ?? 0,
          output.dysonSphere?.structurePoints ?? 0,
          output.dysonSphere?.generationKw ?? 0,
          output.dysonSwarm?.generationKw ?? 0,
        ].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0),
      };
      worker.terminate();
      return {
        report,
        sourceUnchanged: source === JSON.stringify({
          elapsedSeconds: state.elapsedSeconds,
          savedAt: state.savedAt,
          totalProduced: state.totalProduced,
          dysonSphere: state.dysonSphere,
        }),
      };
    });

    expect(result.sourceUnchanged).toBe(true);
    expect(result.report).toBeTruthy();
    console.log(`BROWSER_FAST_OFFLINE ${JSON.stringify(result)}`);
    const report = result.report;
    expect(report.valid).toBe(true);
    expect(report.criticalFinite).toBe(true);
    expect(report.committed).toBe(true);
    expect(report.elapsedAdvance).toBeCloseTo(report.seconds, 3);
    expect(report.approximation).toMatchObject({
      mode: "approximate",
      algorithmVersion: "fast-30s-v6-final-conservation-gate",
    });
    expect(["approximate", "bounded-exact"]).toContain(report.approximation?.settlementStatus);
    expect(report.workerRoundTripMs).toBeLessThan(120_000);
    expect(report.roundTripMs).toBeLessThan(150_000);
  });

  test("8x, 12x and 16x slices stay under the endgame Worker watchdog and terminate promptly", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(harnessPath);
    const result = await page.evaluate(async () => {
      const loadModule = new Function("specifier", "return import(specifier)") as
        (specifier: string) => Promise<Record<string, (...args: never[]) => unknown>>;
      const storage = await loadModule("/src/game/storage.ts");
      const contentPacks = await loadModule("/src/game/contentPacks.ts");
      const runtimeProtocol = await loadModule("/src/game/simulationRuntimeProtocol.ts");
      const parsed = await fetch("/__dsp_real_offline_timewarp_fixture.json").then((response) => response.json());
      const state = storage.migrateGame(parsed.state ?? parsed) as Record<string, any> | null;
      if (!state) throw new Error("fixture migration failed");
      state.paused = false;
      state.timeWarp.enabled = true;
      state.timeWarp.pendingSimulationSeconds = 0;
      state.timeWarp.pendingWallSeconds = 0;
      const controller = state.entities.find((entity: Record<string, unknown>) => entity.buildingId === "time_warp_device");
      if (controller) state.timeWarp.controllerEntityId = controller.id;
      const sourceCritical = JSON.stringify({
        elapsedSeconds: state.elapsedSeconds,
        totalProduced: state.totalProduced,
        dysonSphere: state.dysonSphere,
      });
      const registry = contentPacks.createContentPackRuntimeSnapshot(contentPacks.loadContentPackRegistry()) as Record<string, unknown>;
      const worker = new Worker(new URL("/src/game/simulation.worker.ts", window.location.href), {
        type: "module",
        name: "real-save-time-warp-e2e",
      });
      const slices = [
        { multiplier: 8, simulationSeconds: 64 },
        { multiplier: 12, simulationSeconds: 96 },
        { multiplier: 16, simulationSeconds: 128 },
        // The second consecutive 16x bucket must reuse the rolling certificate
        // owned by the persistent simulation Worker instead of repeating the
        // exact calibration and validation pair.
        { multiplier: 16, simulationSeconds: 128 },
      ];
      const reports: Array<Record<string, any>> = [];
      state.timeWarp.requestedMultiplier = slices[0].multiplier;
      let clientState = state;
      let acknowledgedRevision = 0;
      for (let index = 0; index < slices.length; index += 1) {
        const slice = slices[index];
        let command: Record<string, any> | undefined;
        if (index > 0 && clientState.timeWarp.requestedMultiplier !== slice.multiplier) {
          const commandView = structuredClone(clientState);
          commandView.timeWarp.requestedMultiplier = slice.multiplier;
          command = runtimeProtocol.createSimulationCommandPatch(
            clientState,
            commandView,
            acknowledgedRevision,
          ) as Record<string, any> | undefined;
          if (!command) throw new Error(`failed to build ${slice.multiplier}x command`);
        }
        const startedAt = performance.now();
        const response = await new Promise<Record<string, any>>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error(`${slice.multiplier}x Worker exceeded 15 seconds`)), 15_000);
          worker.onerror = () => {
            window.clearTimeout(timeout);
            reject(new Error(`${slice.multiplier}x Worker failed`));
          };
          worker.onmessage = (event: MessageEvent<Record<string, any>>) => {
            if (event.data.id !== index + 1) return;
            window.clearTimeout(timeout);
            resolve(event.data);
          };
          worker.postMessage({
            id: index + 1,
            ...(index === 0 ? { state, registry } : {}),
            ...(command ? { command } : {}),
            simulationSeconds: slice.simulationSeconds,
            wallSeconds: slice.simulationSeconds / slice.multiplier,
            registryFingerprint: registry.fingerprint,
            protocol: "full",
            approximate: true,
          });
        });
        clientState = response.state ?? clientState;
        acknowledgedRevision = Number(response.stateRevision ?? acknowledgedRevision);
        reports.push({
          multiplier: slice.multiplier,
          roundTripMs: performance.now() - startedAt,
          durationMs: response.durationMs,
          approximation: response.timeWarpApproximation,
          criticalFinite: [
            response.state?.totalProduced?.universe_matrix ?? 0,
            response.state?.dysonSphere?.totalRocketsLaunched ?? 0,
            response.state?.dysonSphere?.structurePoints ?? 0,
            response.state?.dysonSphere?.generationKw ?? 0,
            response.state?.dysonSwarm?.generationKw ?? 0,
          ].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0),
        });
      }
      let lateMessage = false;
      worker.onmessage = () => { lateMessage = true; };
      worker.postMessage({
        id: 99,
        simulationSeconds: 128,
        wallSeconds: 8,
        registryFingerprint: registry.fingerprint,
        protocol: "full",
        approximate: true,
      });
      const terminateStartedAt = performance.now();
      worker.terminate();
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      return {
        reports,
        terminateMs: performance.now() - terminateStartedAt,
        lateMessage,
        sourceUnchanged: sourceCritical === JSON.stringify({
          elapsedSeconds: state.elapsedSeconds,
          totalProduced: state.totalProduced,
          dysonSphere: state.dysonSphere,
        }),
      };
    });

    expect(result.sourceUnchanged).toBe(true);
    expect(result.lateMessage).toBe(false);
    expect(result.terminateMs).toBeLessThan(1_000);
    expect(result.reports).toHaveLength(4);
    console.log(`BROWSER_TIME_WARP ${JSON.stringify(result)}`);
    for (const report of result.reports) {
      expect(report.criticalFinite).toBe(true);
      expect(report.approximation).toMatchObject({ mode: "approximate", algorithmVersion: "time-warp-rolling-v6-final-conservation-gate" });
      expect(report.durationMs).toBeLessThan(15_000);
      expect(report.roundTripMs).toBeLessThan(15_000);
    }
    expect(result.reports.at(-1)?.approximation).toMatchObject({
      certificateReused: true,
      exactCalibrationSeconds: 0,
    });
  });
});
