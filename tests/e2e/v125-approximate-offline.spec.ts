import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

const REAL_FIXTURE = process.env.DSP_APPROXIMATE_OFFLINE_FIXTURE;

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-03-v1.0.24"));
});

test("approximate offline experiment is a local, default-off preference", async ({ page }) => {
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "游戏设置" }).click();
  const row = page.locator("label.start-menu-toggle").filter({ hasText: "近似离线结算（实验）" });
  const toggle = row.locator("input[type=checkbox]");
  await expect(toggle).not.toBeChecked();
  await row.click();
  await expect(toggle).toBeChecked();
  expect(await page.evaluate(() => window.localStorage.getItem("dsp-idle-network.approximate-offline-experiment.v1"))).toBe("1");

  await page.reload();
  await page.getByRole("button", { name: "游戏设置" }).click();
  await expect(page.locator("label.start-menu-toggle").filter({ hasText: "近似离线结算（实验）" }).locator("input")).toBeChecked();
});

test("offline Worker macro-settles a safe 30-day state without blocking the page", async ({ page }) => {
  await page.goto("/?menu=1");
  const result = await page.evaluate(async () => {
    const [{ createInitialState }, { hashGameState }, { runOfflineSettlementInWorker }] = await Promise.all([
      import("/src/game/engine.ts"),
      import("/src/game/benchmark.ts"),
      import("/src/game/offlineSimulation.ts"),
    ]);
    const state = createInitialState();
    state.entities = [];
    state.belts = [];
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
    Object.values(state.endgame.exportProjects).forEach((project) => { project.enabled = false; });
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
    const sourceHash = hashGameState(state);
    const longTasks: Array<{ startTime: number; duration: number }> = [];
    const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => longTasks.push({ startTime: entry.startTime, duration: entry.duration })));
    const startedAt = performance.now();
    observer.observe({ type: "longtask" });
    const settled = await runOfflineSettlementInWorker(state, 30 * 24 * 60 * 60, { approximate: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    return {
      elapsedMs: performance.now() - startedAt,
      diagnostics: settled.diagnostics,
      sourceUnchanged: hashGameState(state) === sourceHash,
      elapsedSeconds: settled.state.elapsedSeconds,
      maxLongTaskMs: Math.max(0, ...longTasks.map((entry) => entry.duration)),
    };
  });

  expect(result.diagnostics.mode).toBe("approximate");
  expect(result.diagnostics.approximateSeconds).toBeGreaterThan(29 * 24 * 60 * 60);
  expect(result.diagnostics.conservationVerified).toBe(true);
  expect(result.sourceUnchanged).toBe(true);
  expect(result.elapsedSeconds).toBe(30 * 24 * 60 * 60);
  expect(result.maxLongTaskMs).toBeLessThan(200);
});

test("cancelling an exact fallback leaves the source state unchanged", async ({ page }) => {
  await page.goto("/?menu=1");
  const result = await page.evaluate(async () => {
    const [{ createInitialState }, { hashGameState }, { runOfflineSettlementInWorker }] = await Promise.all([
      import("/src/game/engine.ts"),
      import("/src/game/benchmark.ts"),
      import("/src/game/offlineSimulation.ts"),
    ]);
    const state = createInitialState();
    state.paused = false;
    state.endgame.activeInfiniteResearchId = "matrix_compression";
    const sourceHash = hashGameState(state);
    const controller = new AbortController();
    let errorName = "";
    try {
      await runOfflineSettlementInWorker(state, 30 * 24 * 60 * 60, {
        approximate: true,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      });
    } catch (error) {
      errorName = error instanceof Error ? error.name : "unknown";
    }
    return { errorName, sourceUnchanged: hashGameState(state) === sourceHash };
  });

  expect(result).toEqual({ errorName: "AbortError", sourceUnchanged: true });
});

test("a real terminal save falls back inside the Worker without blocking the page", async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!REAL_FIXTURE || !existsSync(REAL_FIXTURE), "设置 DSP_APPROXIMATE_OFFLINE_FIXTURE 后运行真实终局存档测试");
  await page.goto("/?menu=1");
  const raw = readFileSync(REAL_FIXTURE!, "utf8");
  const result = await page.evaluate(async (saveRaw) => {
    const [{ inspectSave }, { advanceSimulation }, { hashGameState }, { runOfflineSettlementInWorker }] = await Promise.all([
      import("/src/game/storage.ts"),
      import("/src/game/engine.ts"),
      import("/src/game/benchmark.ts"),
      import("/src/game/offlineSimulation.ts"),
    ]);
    const inspectionLongTasks: Array<{ startTime: number; duration: number }> = [];
    const inspectionObserver = new PerformanceObserver((list) => list.getEntries().forEach((entry) => inspectionLongTasks.push({ startTime: entry.startTime, duration: entry.duration })));
    const inspectionStartedAt = performance.now();
    inspectionObserver.observe({ type: "longtask" });
    const inspection = inspectSave(saveRaw);
    if (!inspection.valid || !inspection.state) throw new Error(inspection.issues[0] ?? "fixture invalid");
    const inspectionMs = performance.now() - inspectionStartedAt;
    await new Promise((resolve) => setTimeout(resolve, 0));
    inspectionObserver.disconnect();
    const state = inspection.state;
    state.paused = false;
    const sourceHash = hashGameState(state);
    const exactHash = hashGameState(advanceSimulation(state, 10));
    const longTasks: Array<{ startTime: number; duration: number }> = [];
    const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => longTasks.push({ startTime: entry.startTime, duration: entry.duration })));
    const startedAt = performance.now();
    observer.observe({ type: "longtask" });
    const settled = await runOfflineSettlementInWorker(state, 10, { approximate: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    return {
      elapsedMs: performance.now() - startedAt,
      diagnostics: settled.diagnostics,
      stateHash: hashGameState(settled.state),
      exactHash,
      sourceUnchanged: hashGameState(state) === sourceHash,
      inspectionMs,
      inspectionLongTasks,
      maxInspectionLongTaskMs: Math.max(0, ...inspectionLongTasks.map((entry) => entry.duration)),
      longTasks,
      maxLongTaskMs: Math.max(0, ...longTasks.map((entry) => entry.duration)),
      transport: settled.diagnostics.transport,
    };
  }, raw);

  expect(result.diagnostics).toMatchObject({ mode: "exact", fellBack: true, approximateSeconds: 0 });
  expect(result.diagnostics.fallbackReason).toBeTruthy();
  expect(result.sourceUnchanged).toBe(true);
  expect(result.stateHash).toMatch(/^[0-9a-f]{8}$/);
  expect(result.stateHash).toBe(result.exactHash);
  expect(result.transport?.inputBytes).toBeGreaterThan(5 * 1024 * 1024);
  expect(result.transport?.outputBytes).toBeGreaterThan(5 * 1024 * 1024);
  expect(result.transport?.mainThreadEncodeMs).toBeLessThan(200);
  expect(result.transport?.mainThreadDecodeMs).toBeLessThan(200);
  console.info("approximate-offline-real-worker", JSON.stringify(result));
  expect(result.maxLongTaskMs).toBeLessThan(200);
});
