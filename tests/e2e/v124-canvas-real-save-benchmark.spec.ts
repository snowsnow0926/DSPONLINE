import { readFileSync, statSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";

const FIXTURE = process.env.DSP_CANVAS_FIXTURE;
const RUN_BENCHMARK = process.env.DSP_RUN_CANVAS_BENCHMARK === "1";
const SAMPLE_MS = Math.max(2_000, Math.min(30_000, Number.parseInt(process.env.DSP_CANVAS_SAMPLE_MS ?? "6000", 10) || 6_000));
const REQUESTED_STAGES = new Set((process.env.DSP_CANVAS_STAGES ?? "baseline,p1,p2,p3,p4,p5,p6").split(",").map((value) => value.trim()).filter(Boolean));
const REUSE_PAGE = process.env.DSP_CANVAS_REUSE_PAGE !== "0";
const CAPTURE_CPU_PROFILE = process.env.DSP_CANVAS_CPU_PROFILE === "1";
const REQUESTED_SCENARIOS = new Set((process.env.DSP_CANVAS_SCENARIOS ?? "paused-pan,running-pan").split(",").map((value) => value.trim()).filter(Boolean));
const TEST_TIMEOUT_MS = Math.max(30_000, Math.min(1_200_000, Number.parseInt(process.env.DSP_CANVAS_TEST_TIMEOUT_MS ?? "1200000", 10) || 1_200_000));

const ALL_FEATURES = {
  renderProjection: false,
  topologyCache: false,
  extremeVisuals: false,
  nodeLod: false,
  canvasBelts: false,
  viewportCulling: false,
  spatialIndexes: false,
  minimapThrottle: false,
};

const STAGES = [
  { id: "baseline", extreme: false, features: { ...ALL_FEATURES } },
  { id: "p1", extreme: false, features: { ...ALL_FEATURES, renderProjection: true } },
  { id: "p2", extreme: false, features: { ...ALL_FEATURES, renderProjection: true, topologyCache: true } },
  { id: "p3", extreme: true, features: { ...ALL_FEATURES, renderProjection: true, topologyCache: true, extremeVisuals: true } },
  { id: "p4", extreme: true, features: { ...ALL_FEATURES, renderProjection: true, topologyCache: true, extremeVisuals: true, nodeLod: true } },
  { id: "p5", extreme: true, features: { ...ALL_FEATURES, renderProjection: true, topologyCache: true, extremeVisuals: true, nodeLod: true, canvasBelts: true } },
  { id: "p6", extreme: true, features: { ...ALL_FEATURES, renderProjection: true, topologyCache: true, extremeVisuals: true, nodeLod: true, canvasBelts: true, viewportCulling: true, spatialIndexes: true, minimapThrottle: true } },
].filter((stage) => REQUESTED_STAGES.has(stage.id));

const FEATURE_LABELS: Record<keyof typeof ALL_FEATURES, string> = {
  renderProjection: "当前星球轻量快照",
  topologyCache: "拓扑与路线缓存",
  extremeVisuals: "减少动画与普通标签",
  nodeLod: "真正的紧凑节点 LOD",
  canvasBelts: "Canvas 批量线路",
  viewportCulling: "强化视口裁剪",
  spatialIndexes: "对齐与端口空间索引",
  minimapThrottle: "小地图低频快照",
};

type SourceState = Record<string, unknown> & {
  activePlanetId: string;
  entities: Array<{ id: string; planetId: string }>;
  belts: Array<{ id: string; planetId: string }>;
  paused: boolean;
  settings: Record<string, unknown>;
  planetViewports: Record<string, { x: number; y: number; zoom: number }>;
};

function densestPlanet(state: SourceState): { id: string; entities: number; belts: number } {
  const totals = new Map<string, { entities: number; belts: number }>();
  for (const entity of state.entities) {
    const row = totals.get(entity.planetId) ?? { entities: 0, belts: 0 };
    row.entities += 1;
    totals.set(entity.planetId, row);
  }
  for (const belt of state.belts) {
    const row = totals.get(belt.planetId) ?? { entities: 0, belts: 0 };
    row.belts += 1;
    totals.set(belt.planetId, row);
  }
  const [id, value] = [...totals].sort((left, right) =>
    (right[1].belts * 3 + right[1].entities) - (left[1].belts * 3 + left[1].entities))[0];
  return { id, ...value };
}

function metricMap(metrics: Array<{ name: string; value: number }>): Record<string, number> {
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

async function sampleCanvas(page: Page, durationMs: number) {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  if (CAPTURE_CPU_PROFILE) {
    await session.send("Profiler.enable");
    await session.send("Profiler.start");
  }
  const before = metricMap((await session.send("Performance.getMetrics")).metrics);
  const bounds = await page.locator(".factory-canvas .react-flow").boundingBox();
  if (!bounds) throw new Error("画布没有可测量区域");
  const framePromise = page.evaluate(async (sampleDuration) => {
    const durations: number[] = [];
    const longTasks: number[] = [];
    const beltCanvas = document.querySelector<HTMLCanvasElement>("canvas.canvas-belt-layer");
    const initialCanvasDrawCount = Number(beltCanvas?.dataset.drawCount ?? 0);
    const initialCanvasDrawTotalMs = Number(beltCanvas?.dataset.drawTotalMs ?? 0);
    let peakHeap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    const observer = typeof PerformanceObserver === "undefined" ? null : new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) longTasks.push(entry.duration);
    });
    try { observer?.observe({ entryTypes: ["longtask"] }); } catch { /* optional browser metric */ }
    const startedAt = performance.now();
    let previousAt = startedAt;
    await new Promise<void>((resolve) => {
      const frame = (now: number) => {
        durations.push(Math.max(0, now - previousAt));
        previousAt = now;
        peakHeap = Math.max(peakHeap, (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
        if (now - startedAt >= sampleDuration) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    observer?.disconnect();
    const ordered = [...durations].sort((left, right) => left - right);
    const percentile = (ratio: number) => ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))] ?? 0;
    const elapsed = durations.reduce((sum, value) => sum + value, 0);
    const canvas = document.querySelector(".factory-canvas");
    const finalBeltCanvas = document.querySelector<HTMLCanvasElement>("canvas.canvas-belt-layer");
    return {
      frames: durations.length,
      fps: durations.length * 1_000 / Math.max(1, elapsed),
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: ordered.at(-1) ?? 0,
      over50Ms: durations.filter((value) => value >= 50).length,
      over100Ms: durations.filter((value) => value >= 100).length,
      over250Ms: durations.filter((value) => value >= 250).length,
      over500Ms: durations.filter((value) => value >= 500).length,
      longTaskCount: longTasks.length,
      longTaskTotalMs: longTasks.reduce((sum, value) => sum + value, 0),
      longTaskMaxMs: longTasks.reduce((peak, value) => Math.max(peak, value), 0),
      peakHeapBytes: peakHeap,
      domElements: canvas?.querySelectorAll("*").length ?? 0,
      domNodes: canvas?.querySelectorAll(".react-flow__node").length ?? 0,
      domEdges: canvas?.querySelectorAll(".react-flow__edge").length ?? 0,
      detailedEdges: canvas?.querySelectorAll(".factory-edge-visual-layer").length ?? 0,
      canvasDrawCount: Math.max(0, Number(finalBeltCanvas?.dataset.drawCount ?? 0) - initialCanvasDrawCount),
      canvasDrawTotalMs: Math.max(0, Number(finalBeltCanvas?.dataset.drawTotalMs ?? 0) - initialCanvasDrawTotalMs),
      canvasLastDrawMs: Number(finalBeltCanvas?.dataset.lastDrawMs ?? 0),
    };
  }, durationMs);
  const panPromise = (async () => {
    const deadline = Date.now() + durationMs;
    await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
    for (let index = 0; Date.now() < deadline; index += 1) {
      await page.mouse.wheel(index % 2 === 0 ? 7 : -7, index % 4 < 2 ? 3 : -3);
      await page.waitForTimeout(40);
    }
  })();
  const [frame] = await Promise.all([framePromise, panPromise]);
  const cpuProfile = CAPTURE_CPU_PROFILE ? await session.send("Profiler.stop") as {
    profile?: {
      nodes?: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>;
      samples?: number[];
      timeDeltas?: number[];
    };
  } : null;
  const after = metricMap((await session.send("Performance.getMetrics")).metrics);
  await session.detach();
  const cpuHotspots = (() => {
    const profile = cpuProfile?.profile;
    if (!profile?.nodes || !profile.samples || !profile.timeDeltas) return [];
    const durationByNode = new Map<number, number>();
    for (let index = 0; index < profile.samples.length; index += 1) {
      const nodeId = profile.samples[index];
      durationByNode.set(nodeId, (durationByNode.get(nodeId) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1_000);
    }
    const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
    return [...durationByNode]
      .map(([nodeId, durationMs]) => ({ durationMs, node: nodeById.get(nodeId) }))
      .filter((entry) => entry.node)
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 12)
      .map(({ durationMs, node }) => ({
        functionName: node!.callFrame.functionName || "(anonymous)",
        url: node!.callFrame.url.split("/").at(-1) ?? node!.callFrame.url,
        line: node!.callFrame.lineNumber + 1,
        durationMs,
      }));
  })();
  return {
    ...frame,
    taskMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1_000,
    scriptMs: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1_000,
    layoutMs: ((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1_000,
    recalcStyleMs: ((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) * 1_000,
    ...(cpuHotspots.length > 0 ? { cpuHotspots } : {}),
  };
}

async function runStage(browser: Browser, source: SourceState, planetId: string, stage: typeof STAGES[number], paused: boolean) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const state = structuredClone(source);
  state.activePlanetId = planetId;
  state.paused = paused;
  state.settings = { ...state.settings, autosaveIntervalSeconds: 120 };
  state.planetViewports = { ...state.planetViewports, [planetId]: { x: 510, y: 250, zoom: 0.84 } };
  const raw = JSON.stringify({ savedAt: Date.now(), state });
  await page.addInitScript(({ extreme, features }) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.canvas-performance-features.v1", JSON.stringify(features));
    if (extreme) {
      localStorage.setItem("dsp-idle-network.endgame-extreme.v1", "true");
      localStorage.setItem("dsp-idle-network.endgame-extreme-ack.v1", "true");
    } else {
      localStorage.removeItem("dsp-idle-network.endgame-extreme.v1");
    }
  }, { extreme: stage.extreme, features: stage.features });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/version.json");
    await page.evaluate(async ({ saveRaw }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("dsp-idle-network.local-saves", 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("records", "readwrite");
        transaction.objectStore("records").put({
          key: "dsp-idle-network.save.v1",
          value: saveRaw,
          updatedAt: Date.now(),
          bytes: new TextEncoder().encode(saveRaw).byteLength,
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
    }, { saveRaw: raw });
    await page.goto("/");
    await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 90_000 });
    await page.locator(".react-flow__controls-fitview").click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 90_000 });
    await page.waitForTimeout(paused ? 1_500 : 3_000);
    const metrics = await sampleCanvas(page, SAMPLE_MS);
    const flags = await page.locator(".factory-canvas").evaluate((element) => ({
      batch: element.getAttribute("data-batch-renderer") === "true",
      minimap: element.getAttribute("data-minimap-throttled") === "true",
      culling: element.closest(".game-shell")?.getAttribute("data-canvas-viewport-culling") === "true",
    }));
    return { ...metrics, flags, errors };
  } finally {
    await context.close();
  }
}

async function applyStage(page: Page, stage: typeof STAGES[number]) {
  await page.getByLabel("打开设置").click();
  const operations = page.locator(".operations-workspace");
  await expect(operations).toBeVisible();
  for (const [id, label] of Object.entries(FEATURE_LABELS) as Array<[keyof typeof ALL_FEATURES, string]>) {
    const checkbox = operations.locator("label.setting-row").filter({ hasText: label }).getByRole("checkbox");
    if (await checkbox.isChecked() !== stage.features[id]) await checkbox.evaluate((input: HTMLInputElement) => input.click());
  }
  const extreme = operations.locator("label.setting-row").filter({ hasText: "终局优化·极限模式" }).getByRole("checkbox");
  if (await extreme.isChecked() !== stage.extreme) {
    await extreme.evaluate((input: HTMLInputElement) => input.click());
    if (stage.extreme) await page.getByRole("button", { name: "开启极限模式" }).click();
  }
  await page.getByLabel("设置已打开，再次点击返回工厂").click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-endgame-extreme", stage.extreme ? "true" : "false");
}

async function runStagesOnOnePage(browser: Browser, source: SourceState, planetId: string) {
  const initialStage = STAGES[0] ?? { id: "baseline", extreme: false, features: { ...ALL_FEATURES } };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const state = structuredClone(source);
  state.activePlanetId = planetId;
  state.paused = true;
  state.settings = { ...state.settings, autosaveIntervalSeconds: 120 };
  state.planetViewports = { ...state.planetViewports, [planetId]: { x: 510, y: 250, zoom: 0.84 } };
  const raw = JSON.stringify({ savedAt: Date.now(), state });
  await page.addInitScript(({ features, extreme }) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.canvas-performance-features.v1", JSON.stringify(features));
    if (extreme) localStorage.setItem("dsp-idle-network.endgame-extreme.v1", "true");
    else localStorage.removeItem("dsp-idle-network.endgame-extreme.v1");
    localStorage.setItem("dsp-idle-network.endgame-extreme-ack.v1", "true");
  }, { features: initialStage.features, extreme: initialStage.extreme });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    console.log("CANVAS_STEP", "seed-indexeddb");
    await page.goto("/version.json");
    await page.evaluate(async ({ saveRaw }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("dsp-idle-network.local-saves", 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("records", "readwrite");
        transaction.objectStore("records").put({ key: "dsp-idle-network.save.v1", value: saveRaw, updatedAt: Date.now(), bytes: new TextEncoder().encode(saveRaw).byteLength });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
    }, { saveRaw: raw });
    console.log("CANVAS_STEP", "open-game");
    await page.goto("/");
    await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 120_000 });
    console.log("CANVAS_STEP", "fit-view");
    await page.locator(".react-flow__controls-fitview").click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 120_000 });
    console.log("CANVAS_STEP", "canvas-ready");
    const results: Array<Record<string, unknown>> = [];
    let appliedStage = initialStage;
    for (const scenario of (["paused-pan", "running-pan"] as const).filter((value) => REQUESTED_SCENARIOS.has(value))) {
      if (appliedStage.id !== initialStage.id) {
        await applyStage(page, initialStage);
        appliedStage = initialStage;
      }
      const pauseButton = page.getByLabel(scenario === "paused-pan" ? "暂停模拟" : "继续模拟");
      if (await pauseButton.count()) await pauseButton.click();
      await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-paused", scenario === "paused-pan" ? "true" : "false");
      for (const stage of STAGES) {
        if (stage.id !== appliedStage.id) {
          console.log("CANVAS_STEP", `${scenario}:${stage.id}:apply`);
          await applyStage(page, stage);
          appliedStage = stage;
        }
        await page.waitForTimeout(scenario === "paused-pan" ? 800 : 1_500);
        console.log("CANVAS_STEP", `${scenario}:${stage.id}:sample`);
        const metrics = await sampleCanvas(page, SAMPLE_MS);
        const flags = await page.locator(".factory-canvas").evaluate((element) => ({
          batch: element.getAttribute("data-batch-renderer") === "true",
          minimap: element.getAttribute("data-minimap-throttled") === "true",
          culling: element.closest(".game-shell")?.getAttribute("data-canvas-viewport-culling") === "true",
        }));
        results.push({ stage: stage.id, scenario, ...metrics, flags });
        console.log("CANVAS_STEP", `${scenario}:${stage.id}:done`);
      }
    }
    return { results, errors };
  } finally {
    await context.close();
  }
}

test("profiles staged canvas optimizations on an explicitly supplied local real save", async ({ browser }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  test.skip(!FIXTURE || !RUN_BENCHMARK, "设置 DSP_CANVAS_FIXTURE 与 DSP_RUN_CANVAS_BENCHMARK=1 后运行真实画布基准");
  const envelope = JSON.parse(readFileSync(FIXTURE!, "utf8")) as { state?: SourceState } & SourceState;
  const source = structuredClone((envelope.state ?? envelope) as SourceState);
  const planet = densestPlanet(source);
  const results: Array<Record<string, unknown>> = [];
  if (REUSE_PAGE) {
    const shared = await runStagesOnOnePage(browser, source, planet.id);
    expect(shared.errors).toEqual([]);
    results.push(...shared.results);
  } else {
    for (const paused of [true, false]) {
      for (const stage of STAGES) {
        const metrics = await runStage(browser, source, planet.id, stage, paused);
        expect(metrics.errors).toEqual([]);
        results.push({ stage: stage.id, scenario: paused ? "paused-pan" : "running-pan", ...metrics });
      }
    }
  }
  console.log("CANVAS_BENCHMARK", JSON.stringify({
    fixtureBytes: statSync(FIXTURE!).size,
    totalEntities: source.entities.length,
    totalBelts: source.belts.length,
    planet,
    sampleMs: SAMPLE_MS,
    results,
  }));
});
