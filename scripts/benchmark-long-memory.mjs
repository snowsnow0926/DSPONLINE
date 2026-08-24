import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

/**
 * Read-only long-running memory stress harness for a real player save.
 *
 * The browser loads the save through the same import UI a player uses.  The
 * optional operation scenario then runs the real engine commands in an
 * isolated page copy while the authoritative simulation Worker continues in
 * the background.  No state is written back to the supplied fixture.
 */

const execFileAsync = promisify(execFile);
const args = new Map(process.argv.slice(2).map((argument) => {
  const index = argument.indexOf("=");
  return index < 0
    ? [argument.replace(/^--/, ""), "true"]
    : [argument.slice(2, index), argument.slice(index + 1)];
}));
const savePath = resolve(args.get("save") ?? "C:/Users/WINDOWS/Downloads/dsp-idle-save-2026-08-24 (1).json/dsp-idle-save-2026-08-24 (1).json");
const url = args.get("url") ?? "http://127.0.0.1:4320";
const durationSeconds = Math.max(10, Math.floor(Number(args.get("duration") ?? 60)));
const sampleSeconds = Math.max(1, Number(args.get("sample") ?? 2));
const warmupSeconds = Math.max(0, Number(args.get("warmup") ?? 5));
const operationEverySeconds = Math.max(5, Number(args.get("operation-every") ?? 15));
const operationRounds = Math.max(1, Math.min(100, Math.floor(Number(args.get("operation-rounds") ?? 20))));
const scenario = args.get("scenario") ?? "pure";
const label = (args.get("label") ?? `${scenario}-${durationSeconds}s`).replace(/[^a-zA-Z0-9_-]/g, "-");
const outputPath = resolve(args.get("output") ?? `artifacts/performance/${label}.json`);
const executablePath = resolve(args.get("browser") ?? "C:/Program Files/Google/Chrome/Application/chrome.exe");

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function browserProcessMemory(profileDirectory) {
  const escaped = profileDirectory.replaceAll("'", "''");
  const script = `
    $rows = Get-CimInstance Win32_Process | Where-Object { $_.Name -notmatch 'powershell' -and $_.CommandLine -like '*${escaped}*' }
    $result = foreach ($row in $rows) {
      $process = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
      if (-not $process) { continue }
      $role = if ($row.CommandLine -match '--type=([^ ]+)') { $Matches[1] } else { 'browser' }
      [PSCustomObject]@{ pid = $row.ProcessId; role = $role; workingSetBytes = [int64]$process.WorkingSet64; privateBytes = [int64]$process.PrivateMemorySize64 }
    }
    @($result) | ConvertTo-Json -Compress
  `;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim() || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function visible(locator) {
  try { return await locator.isVisible(); } catch { return false; }
}

async function waitForImportedFactory(page) {
  const shell = page.locator(".game-shell");
  const choice = page.getByRole("dialog", { name: "选择离线结算方式" });
  const skip = page.getByRole("button", { name: /保守跳过本次收益/ });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await visible(choice)) {
      const abandon = choice.getByRole("button", { name: /放弃离线收益/ });
      if (await visible(abandon)) {
        await abandon.click();
        const confirmation = page.getByRole("alertdialog", { name: "快速结算需要玩家选择" });
        if (await visible(confirmation)) await confirmation.getByRole("button", { name: /再次确认：收益为 0/ }).click();
      }
    }
    if (await visible(skip)) {
      await skip.click();
      const confirmation = page.getByRole("button", { name: /再次确认.*收益为 0/ });
      if (await visible(confirmation)) await confirmation.click();
    }
    if (await visible(shell)) break;
    await delay(500);
  }
  await shell.waitFor({ state: "visible", timeout: 30_000 });
  const settlement = page.getByRole("button", { name: "确认结算" });
  if (await visible(settlement)) {
    await settlement.click();
    await settlement.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => undefined);
  }
  const resume = page.getByLabel("继续模拟");
  if (await visible(resume)) await resume.click();
  await shell.waitFor({ state: "visible", timeout: 30_000 });
  return shell;
}

async function runEngineOperations(page, rounds) {
  return page.evaluate(async ({ rounds: count }) => {
    const [storage, localStore, engine] = await Promise.all([
      import("/src/game/storage.ts"),
      import("/src/game/localSaveStore.ts"),
      import("/src/game/engine.ts"),
    ]);
    const raw = await localStore.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    const inspection = raw ? storage.inspectSave(raw) : null;
    if (!inspection?.state) throw new Error("真实存档未能从 IndexedDB 读取");
    let state = storage.migrateGame(inspection.state);
    if (!state) throw new Error("真实存档迁移失败");
    const original = { entities: state.entities.length, belts: state.belts.length, blueprints: state.blueprints.length };
    // Prefer a normal production building so this scenario really exercises
    // placement/removal instead of accidentally selecting a unique
    // megastructure that the save already contains.  The coordinates are
    // deliberately outside the existing layout; the engine command itself
    // does not perform canvas collision validation.
    const preferredBuildingIds = ["arc_smelter", "assembling_machine_mk1", "storage_mk1"];
    const buildingId = preferredBuildingIds.find((candidate) => state.entities.some((entity) =>
      entity.planetId === state.activePlanetId && entity.buildingId === candidate && !entity.interactionLocked)) ??
      state.entities.find((entity) => entity.buildingId && entity.kind !== "vein" && !entity.interactionLocked)?.buildingId;
    const building = state.entities.find((entity) => entity.planetId === state.activePlanetId &&
      entity.buildingId === buildingId && !entity.interactionLocked);
    const anchor = state.entities
      .filter((entity) => entity.planetId === state.activePlanetId)
      .reduce((current, entity) => ({
        x: Math.max(current.x, Math.abs(entity.position.x)),
        y: Math.max(current.y, Math.abs(entity.position.y)),
      }), { x: 0, y: 0 });
    const placementOrigin = { x: anchor.x + 10_000, y: anchor.y + 10_000 };
    let placed = 0;
    let removed = 0;
    let reconnected = 0;
    let blueprinted = 0;
    if (buildingId) state.construction[buildingId] = Math.max(1_000_000, Math.floor(state.construction[buildingId] ?? 0));
    for (let index = 0; index < count && buildingId; index += 1) {
      const before = state;
      const next = engine.placeBuilding(state, buildingId, {
        x: placementOrigin.x + (index % 10) * 12,
        y: placementOrigin.y + Math.floor(index / 10) * 12,
      });
      if (next === before) continue;
      state = next;
      const created = state.entities.at(-1)?.id;
      if (!created) continue;
      placed += 1;
      const removedState = engine.removeEntity(state, created);
      if (removedState !== state) {
        state = removedState;
        removed += 1;
      }
      state.construction[buildingId] = Math.max(1_000_000, Math.floor(state.construction[buildingId] ?? 0));
    }
    const beltCandidates = state.belts.slice(0, Math.min(count, state.belts.length)).map((belt) => ({ ...belt }));
    for (const belt of beltCandidates) {
      const removedState = engine.removeBelt(state, belt.id);
      if (removedState === state) continue;
      state = removedState;
      const constructionId = belt.tier === 3 ? "conveyor_belt_mk3" : belt.tier === 2 ? "conveyor_belt_mk2" : "conveyor_belt_mk1";
      state.construction[constructionId] = Math.max(1_000_000, Math.floor(state.construction[constructionId] ?? 0));
      const result = engine.connectBeltWithResult(state, belt.source, belt.target, belt.itemId, belt.tier, belt.targetPortIndex, belt.lanes);
      if (result.created) {
        state = result.state;
        reconnected += 1;
      }
    }
    const blueprintEntityIds = state.entities
      .filter((entity) => entity.planetId === state.activePlanetId && entity.buildingId && !entity.interactionLocked)
      .slice(0, Math.min(24, count + 4))
      .map((entity) => entity.id);
    if (blueprintEntityIds.length > 0) {
      const next = engine.createBlueprint(state, blueprintEntityIds, "memory-stress");
      if (next !== state) {
        state = next;
        blueprinted += 1;
        const createdBlueprint = state.blueprints.at(-1);
        if (createdBlueprint) state = engine.removeBlueprint(state, createdBlueprint.id);
      }
    }
    return {
      original,
      final: { entities: state.entities.length, belts: state.belts.length, blueprints: state.blueprints.length },
      buildingId: buildingId ?? null,
      placementOrigin,
      placed,
      removed,
      reconnected,
      blueprinted,
    };
  }, { rounds });
}

async function triggerAutosave(page, expectedCompleted) {
  const triggered = await page.evaluate(() => {
    const tracker = globalThis.__dspRealSaveAutosaveTracker;
    if (!tracker || typeof tracker.autosaveHandler !== "function") return false;
    tracker.autosaveHandler();
    return true;
  });
  if (!triggered) return { triggered: false, completed: false };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const completed = await page.evaluate((minimum) => {
      const events = globalThis.__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
      return events.filter((event) => event.phase === "persistence-phase" && event.detail?.kind === "autosave" && event.detail.phase === "complete").length;
    }, expectedCompleted);
    if (completed >= expectedCompleted) return { triggered: true, completed: true };
    await delay(500);
  }
  return { triggered: true, completed: false };
}

const profileDirectory = await mkdtemp(resolve(tmpdir(), `dspidle-long-memory-${label}-`));
let context;
let browser;
let processSampling = true;
const processSamples = [];
const operationResults = [];
const pageErrors = [];

try {
  const fixtureStat = await readFile(savePath);
  context = await chromium.launchPersistentContext(profileDirectory, {
    executablePath,
    headless: true,
    args: [
      "--js-flags=--expose-gc",
      "--enable-precise-memory-info",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-24-v1.1.7");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.ui.large-save-autosave-throttle.v1", "false");
    globalThis.__DSP_RUNTIME_TRANSITIONS__ = { enabled: true, events: [], active: {}, counters: {} };
    const tracker = { autosaveHandler: null };
    globalThis.__dspRealSaveAutosaveTracker = tracker;
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler, timeout, ...rest) => {
      if (timeout === 30_000) {
        tracker.autosaveHandler = handler;
        return 0;
      }
      return nativeSetInterval(handler, timeout, ...rest);
    });
    globalThis.__DSP_MEMORY_SAMPLES__ = [];
    const sampleMemory = () => {
      const memory = performance.memory;
      globalThis.__DSP_MEMORY_SAMPLES__.push({
        atMs: performance.now(),
        usedBytes: memory?.usedJSHeapSize ?? null,
        totalBytes: memory?.totalJSHeapSize ?? null,
        limitBytes: memory?.jsHeapSizeLimit ?? null,
      });
    };
    globalThis.__DSP_MEMORY_SAMPLE_TIMER__ = window.setInterval(sampleMemory, 250);
  });
  await page.goto(`${url.replace(/\/$/, "")}/?menu=1`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByLabel("选择存档文件").setInputFiles(savePath);
  const enter = page.getByRole("button", { name: "确认导入并进入" });
  await enter.waitFor({ state: "visible", timeout: 120_000 });
  await enter.click();
  const shell = await waitForImportedFactory(page);
  await shell.waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('.game-shell[data-simulation-worker="active"]').waitFor({ state: "attached", timeout: 90_000 });
  if ((await shell.getAttribute("data-simulation-paused")) === "true") {
    const resume = page.getByLabel("继续模拟");
    if (await visible(resume)) await resume.click();
  }

  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  await cdp.send("Memory.enable").catch(() => undefined);
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  await delay(warmupSeconds * 1_000);
  await page.evaluate(() => { globalThis.__DSP_MEMORY_SAMPLES__ = []; });
  const startedAt = Date.now();
  const sample = async (kind = "interval") => {
    const [heap, performanceResult, dom, processes, application] = await Promise.all([
      cdp.send("Runtime.getHeapUsage").catch(() => ({ usedSize: 0, totalSize: 0, embedderHeapUsedSize: 0 })),
      cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] })),
      cdp.send("Memory.getDOMCounters").catch(() => ({ nodes: 0, documents: 0, jsEventListeners: 0 })),
      browserProcessMemory(profileDirectory),
      page.evaluate(() => ({
        worker: document.querySelector(".game-shell")?.getAttribute("data-simulation-worker") ?? "unknown",
        paused: document.querySelector(".game-shell")?.getAttribute("data-simulation-paused") ?? "unknown",
        persistencePhase: document.querySelector(".game-shell")?.getAttribute("data-persistence-phase") ?? null,
        workerCount: globalThis.__DSP_MEMORY_SAMPLES__?.length ?? 0,
      })),
    ]);
    const metrics = Object.fromEntries((performanceResult.metrics ?? []).map((entry) => [entry.name, entry.value]));
    const processTotals = processes.reduce((totals, row) => ({
      workingSetBytes: totals.workingSetBytes + Number(row.workingSetBytes ?? 0),
      privateBytes: totals.privateBytes + Number(row.privateBytes ?? 0),
    }), { workingSetBytes: 0, privateBytes: 0 });
    processSamples.push({
      kind,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1_000).toFixed(2)),
      heap: { usedBytes: heap.usedSize, totalBytes: heap.totalSize, embedderBytes: heap.embedderHeapUsedSize },
      performance: {
        jsHeapUsedBytes: metrics.JSHeapUsedSize ?? null,
        jsHeapTotalBytes: metrics.JSHeapTotalSize ?? null,
        taskDurationSeconds: metrics.TaskDuration ?? null,
        nodes: metrics.Nodes ?? null,
        documents: metrics.Documents ?? null,
        listeners: metrics.JSEventListeners ?? null,
      },
      dom,
      processes,
      processTotals,
      application,
    });
  };
  await sample("start");
  const processSampler = (async () => {
    while (processSampling) {
      const rows = await browserProcessMemory(profileDirectory);
      const processTotals = rows.reduce((totals, row) => ({
        workingSetBytes: totals.workingSetBytes + Number(row.workingSetBytes ?? 0),
        privateBytes: totals.privateBytes + Number(row.privateBytes ?? 0),
      }), { workingSetBytes: 0, privateBytes: 0 });
      processSamples.push({ kind: "process", elapsedSeconds: Number(((Date.now() - startedAt) / 1_000).toFixed(2)), processes: rows, processTotals });
      await delay(1_000);
    }
  })();

  let nextSampleAt = sampleSeconds * 1_000;
  let nextOperationAt = operationEverySeconds * 1_000;
  let autosaveCount = 0;
  const deadline = startedAt + durationSeconds * 1_000;
  while (Date.now() < deadline) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= nextSampleAt) {
      await sample("interval");
      nextSampleAt += sampleSeconds * 1_000;
    }
    if (scenario !== "pure" && elapsed >= nextOperationAt) {
      if (scenario.includes("operations")) {
        const operationStartedAt = Date.now();
        const result = await runEngineOperations(page, operationRounds);
        operationResults.push({ kind: "engine-operations", elapsedSeconds: Number(((Date.now() - startedAt) / 1_000).toFixed(2)), durationMs: Date.now() - operationStartedAt, result });
      }
      if (scenario.includes("save")) {
        autosaveCount += 1;
        const saveResult = await triggerAutosave(page, autosaveCount);
        operationResults.push({ kind: "autosave", elapsedSeconds: Number(((Date.now() - startedAt) / 1_000).toFixed(2)), result: saveResult });
      }
      nextOperationAt += operationEverySeconds * 1_000;
    }
    await delay(250);
  }
  await sample("end");
  processSampling = false;
  await processSampler;
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  await delay(500);
  await sample("post-gc");
  const pageMemorySamples = await page.evaluate(() => {
    window.clearInterval(globalThis.__DSP_MEMORY_SAMPLE_TIMER__);
    return globalThis.__DSP_MEMORY_SAMPLES__ ?? [];
  });
  const allProcessRows = processSamples.flatMap((entry) => entry.processes ?? []);
  const processPeak = (field) => Math.max(0, ...processSamples.flatMap((entry) => entry.processes ?? []).map((row) => Number(row[field] ?? 0)));
  const aggregateProcessPeak = (field) => Math.max(0, ...processSamples.map((entry) => Number(entry.processTotals?.[field] ??
    (entry.processes ?? []).reduce((total, row) => total + Number(row[field] ?? 0), 0))));
  const rendererPeak = (field) => Math.max(0, ...processSamples
    .flatMap((entry) => entry.processes ?? [])
    .filter((row) => String(row.role).toLowerCase().includes("renderer"))
    .map((row) => Number(row[field] ?? 0)));
  const cdpHeapPeak = Math.max(0, ...processSamples.filter((entry) => entry.heap).map((entry) => Number(entry.heap.usedBytes ?? 0)));
  const pageHeapPeak = Math.max(0, ...pageMemorySamples.map((entry) => Number(entry.usedBytes ?? 0)));
  const finalState = await page.evaluate(() => ({
    worker: document.querySelector(".game-shell")?.getAttribute("data-simulation-worker") ?? "unknown",
    paused: document.querySelector(".game-shell")?.getAttribute("data-simulation-paused") ?? "unknown",
    events: globalThis.__DSP_RUNTIME_TRANSITIONS__?.events?.slice(-20) ?? [],
  }));
  const report = {
    schemaVersion: 1,
    label,
    scenario,
    url,
    executablePath,
    fixture: { path: savePath, bytes: fixtureStat.byteLength },
    durationSeconds,
    warmupSeconds,
    sampleSeconds,
    operationEverySeconds,
    operationRounds,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    pageErrors,
    operationResults,
    peaks: {
      cdpHeapUsedBytes: cdpHeapPeak,
      pagePerformanceMemoryUsedBytes: pageHeapPeak,
      rendererWorkingSetBytes: rendererPeak("workingSetBytes"),
      rendererPrivateBytes: rendererPeak("privateBytes"),
      browserProcessWorkingSetBytes: aggregateProcessPeak("workingSetBytes"),
      browserProcessPrivateBytes: aggregateProcessPeak("privateBytes"),
      // Kept for compatibility with the first draft of this harness. These
      // are the largest single process, not an aggregate across Chrome.
      allBrowserProcessWorkingSetBytes: processPeak("workingSetBytes"),
      allBrowserProcessPrivateBytes: processPeak("privateBytes"),
    },
    finalState,
    pageMemorySamples,
    processSamples,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, label, scenario, peaks: report.peaks, operationResults, pageErrors, finalState })}\n`);
} finally {
  processSampling = false;
  if (browser) await browser.close().catch(() => undefined);
  else await context?.close().catch(() => undefined);
  if (profileDirectory.startsWith(resolve(tmpdir(), "dspidle-long-memory-"))) {
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
