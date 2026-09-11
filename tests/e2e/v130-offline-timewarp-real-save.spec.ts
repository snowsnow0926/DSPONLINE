import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixturePath = process.env.DSP_REAL_OFFLINE_TIME_WARP_FIXTURE;
const fixtureRoute = "**/__dsp_real_offline_timewarp_fixture.json";
const harnessPath = "/__dsp_worker_harness.html";

test.describe("1.0.34 real-save offline and pure-idle workers", () => {
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

  test("all long offline windows either qualify or return an uncommitted decision without changing the source", async ({ page }) => {
    // Four independent windows each keep their 35s hard gate. Leave enough
    // suite time for four large-save serializations and integrity reloads.
    test.setTimeout(210_000);
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
      const durations = [6_984, 30_171, 7 * 24 * 60 * 60, 30 * 24 * 60 * 60];
      const reports: Array<Record<string, any>> = [];
      for (let index = 0; index < durations.length; index += 1) {
        const seconds = durations[index];
        const phases: string[] = [];
        const heapBefore = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
        const startedAt = performance.now();
        const response = await new Promise<Record<string, any>>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error(`offline Worker exceeded 35 seconds for ${seconds}s`)), 35_000);
          worker.onerror = () => {
            window.clearTimeout(timeout);
            reject(new Error(`offline Worker failed for ${seconds}s`));
          };
          worker.onmessage = (event: MessageEvent<Record<string, any>>) => {
            if (event.data.id !== index + 1) return;
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
            id: index + 1,
            state,
            seconds,
            wallSeconds: seconds,
            registry,
            approximate: true,
            deadlineMs: 30_000,
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
        reports.push({
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
        });
      }
      worker.terminate();
      return {
        reports,
        sourceUnchanged: source === JSON.stringify({
          elapsedSeconds: state.elapsedSeconds,
          savedAt: state.savedAt,
          totalProduced: state.totalProduced,
          dysonSphere: state.dysonSphere,
        }),
      };
    });

    expect(result.sourceUnchanged).toBe(true);
    expect(result.reports).toHaveLength(4);
    console.log(`BROWSER_FAST_OFFLINE ${JSON.stringify(result)}`);
    for (const report of result.reports) {
      expect(report.valid).toBe(true);
      expect(report.criticalFinite).toBe(true);
      expect(report.elapsedAdvance).toBeCloseTo(report.committed ? report.seconds : 0, 3);
      expect(report.approximation).toMatchObject({ mode: "approximate", algorithmVersion: "fast-30s-v2" });
      expect(report.committed ? ["approximate", "bounded-exact"] : ["conservative-preview"]).toContain(report.approximation?.settlementStatus);
      expect(report.workerRoundTripMs).toBeLessThan(35_000);
      expect(report.roundTripMs).toBeLessThan(45_000);
    }
  });

  test("8x, 12x and 16x slices stay under the browser safety timeout and terminate promptly", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(harnessPath);
    const result = await page.evaluate(async () => {
      const loadModule = new Function("specifier", "return import(specifier)") as
        (specifier: string) => Promise<Record<string, (...args: never[]) => unknown>>;
      const storage = await loadModule("/src/game/storage.ts");
      const contentPacks = await loadModule("/src/game/contentPacks.ts");
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
      ];
      const reports: Array<Record<string, any>> = [];
      for (let index = 0; index < slices.length; index += 1) {
        const slice = slices[index];
        const startedAt = performance.now();
        const response = await new Promise<Record<string, any>>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error(`${slice.multiplier}x Worker exceeded 8 seconds`)), 8_000);
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
            simulationSeconds: slice.simulationSeconds,
            wallSeconds: slice.simulationSeconds / slice.multiplier,
            registryFingerprint: registry.fingerprint,
            protocol: "full",
            approximate: true,
          });
        });
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
    expect(result.reports).toHaveLength(3);
    console.log(`BROWSER_TIME_WARP ${JSON.stringify(result)}`);
    for (const report of result.reports) {
      expect(report.criticalFinite).toBe(true);
      expect(report.approximation).toMatchObject({ mode: "approximate", algorithmVersion: "time-warp-short-calibration-v3" });
      expect(report.durationMs).toBeLessThan(8_000);
      expect(report.roundTripMs).toBeLessThan(8_000);
    }
  });
});
