import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
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
const checkpointEverySeconds = Math.max(0, Number(args.get("checkpoint-every") ?? 60));
const heapProfileEnabled = args.get("heap-profile") === "true";
const heapSnapshotEnabled = args.get("heap-snapshot") === "true";
const scenario = args.get("scenario") ?? "pure";
const autoPauseArgument = args.get("auto-pause");
const requestedAutoPause = autoPauseArgument === undefined ? null : autoPauseArgument !== "false";
const label = (args.get("label") ?? `${scenario}-${durationSeconds}s`).replace(/[^a-zA-Z0-9_-]/g, "-");
const outputPath = resolve(args.get("output") ?? `artifacts/performance/${label}.json`);
const executablePath = resolve(args.get("browser") ?? "C:/Program Files/Google/Chrome/Application/chrome.exe");

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function summarizeHeapSamplingProfile(profile, limit = 50) {
  const totals = new Map();
  const visit = (node) => {
    if (!node) return;
    const frame = node.callFrame ?? {};
    const key = `${frame.functionName || "(anonymous)"}|${frame.url || "(unknown)"}|${Number(frame.lineNumber ?? -1) + 1}|${Number(frame.columnNumber ?? -1) + 1}`;
    const current = totals.get(key) ?? {
      functionName: frame.functionName || "(anonymous)",
      url: frame.url || "(unknown)",
      line: Number(frame.lineNumber ?? -1) + 1,
      column: Number(frame.columnNumber ?? -1) + 1,
      sampledLiveBytes: 0,
    };
    current.sampledLiveBytes += Number(node.selfSize ?? 0);
    totals.set(key, current);
    for (const child of node.children ?? []) visit(child);
  };
  visit(profile?.head);
  return [...totals.values()]
    .sort((left, right) => right.sampledLiveBytes - left.sampledLiveBytes)
    .slice(0, limit);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function commandOutput(file, commandArgs) {
  try {
    const { stdout } = await execFileAsync(file, commandArgs, { maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function windowsMachineEvidence() {
  const script = `
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $system = Get-CimInstance Win32_ComputerSystem
    $page = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object { [PSCustomObject]@{ name = $_.Name; allocatedMiB = [int64]$_.AllocatedBaseSize; currentMiB = [int64]$_.CurrentUsage; peakMiB = [int64]$_.PeakUsage } })
    [PSCustomObject]@{
      caption = $os.Caption
      version = $os.Version
      buildNumber = $os.BuildNumber
      cpu = $cpu.Name
      logicalProcessors = [int]$cpu.NumberOfLogicalProcessors
      physicalMemoryBytes = [int64]$system.TotalPhysicalMemory
      pageFiles = $page
    } | ConvertTo-Json -Compress -Depth 4
  `;
  const raw = await commandOutput("powershell.exe", ["-NoProfile", "-Command", script]);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function linearSlopeBytesPerMinute(samples) {
  const points = samples
    .map((sample) => [Number(sample.elapsedSeconds), Number(sample.bytes)])
    .filter(([seconds, bytes]) => Number.isFinite(seconds) && Number.isFinite(bytes));
  if (points.length < 2) return null;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const denominator = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  if (denominator <= 0) return null;
  const bytesPerSecond = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0) / denominator;
  return Math.round(bytesPerSecond * 60);
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * Math.max(0, Math.min(1, probability));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return Math.round(sorted[lower]);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
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
    const productionHarness = globalThis.__DSP_PERFORMANCE_HARNESS__;
    if (productionHarness?.runEngineOperations) return productionHarness.runEngineOperations(count);
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

async function triggerAutosave(page) {
  const trigger = await page.evaluate(() => {
    const tracker = globalThis.__dspRealSaveAutosaveTracker;
    if (!tracker || typeof tracker.autosaveHandler !== "function") return { triggered: false, marker: performance.now() };
    const marker = performance.now();
    tracker.autosaveHandler();
    return { triggered: true, marker };
  });
  if (!trigger.triggered) return { triggered: false, completed: false };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const completed = await page.evaluate((marker) => {
      const events = globalThis.__DSP_RUNTIME_TRANSITIONS__?.events ?? [];
      return events.some((event) => event.startedAt >= marker && event.phase === "persistence-phase" &&
        event.detail?.kind === "autosave" && event.detail.phase === "complete");
    }, trigger.marker);
    if (completed) {
      const chunkedSave = await page.evaluate(() =>
        globalThis.__DSP_PERFORMANCE_HARNESS__?.getLastChunkedSaveMetrics?.() ?? null);
      return { triggered: true, completed: true, chunkedSave };
    }
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
  const [fixtureStat, fixtureSha256, gitSha, machine] = await Promise.all([
    stat(savePath),
    sha256File(savePath),
    commandOutput("git", ["rev-parse", "HEAD"]),
    windowsMachineEvidence(),
  ]);
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
  browser = context.browser();
  const page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(({ autoPause }) => {
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-27-v1.2.2");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.ui.large-save-autosave-throttle.v1", "false");
    if (autoPause !== null) localStorage.setItem("dsp-idle-network.ui.memory-auto-pause.v1", String(autoPause));
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
  }, { autoPause: requestedAutoPause });
  await page.goto(`${url.replace(/\/$/, "")}/?menu=1&dspPerformanceHarness=1`, { waitUntil: "domcontentloaded", timeout: 120_000 });
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
  if (heapProfileEnabled) {
    await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32_768, includeObjectsCollectedByMajorGC: false });
  }
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
        localSaveRawCacheSize: Number(document.querySelector(".game-shell")?.getAttribute("data-local-save-raw-cache-size") ?? -1),
        memorySampleCount: globalThis.__DSP_MEMORY_SAMPLES__?.length ?? 0,
        serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
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
  let nextCheckpointAt = checkpointEverySeconds > 0 ? checkpointEverySeconds * 1_000 : Number.POSITIVE_INFINITY;
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
        const saveResult = await triggerAutosave(page);
        operationResults.push({ kind: "autosave", elapsedSeconds: Number(((Date.now() - startedAt) / 1_000).toFixed(2)), result: saveResult });
      }
      nextOperationAt += operationEverySeconds * 1_000;
    }
    if (elapsed >= nextCheckpointAt) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(`${outputPath}.partial.json`, `${JSON.stringify({
        schemaVersion: 2,
        partial: true,
        label,
        scenario,
        elapsedSeconds: Number((elapsed / 1_000).toFixed(2)),
        targetDurationSeconds: durationSeconds,
        fixture: { path: savePath, bytes: fixtureStat.size, sha256: fixtureSha256 },
        build: { gitSha },
        environment: { browserVersion: browser?.version() ?? null, machine },
        pageErrors,
        operationResults,
        processSamples,
      }, null, 2)}\n`, "utf8");
      nextCheckpointAt += checkpointEverySeconds * 1_000;
    }
    await delay(250);
  }
  await sample("end");
  processSampling = false;
  await processSampler;
  await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
  await delay(500);
  await sample("post-gc");
  let heapSnapshotPath = null;
  if (heapSnapshotEnabled) {
    heapSnapshotPath = `${outputPath}.heapsnapshot`;
    await mkdir(dirname(heapSnapshotPath), { recursive: true });
    const snapshotStream = createWriteStream(heapSnapshotPath, { encoding: "utf8" });
    const onSnapshotChunk = ({ chunk }) => snapshotStream.write(chunk);
    cdp.on("HeapProfiler.addHeapSnapshotChunk", onSnapshotChunk);
    try {
      await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: true });
    } finally {
      cdp.off("HeapProfiler.addHeapSnapshotChunk", onSnapshotChunk);
      await new Promise((resolveSnapshot, rejectSnapshot) => {
        snapshotStream.on("error", rejectSnapshot);
        snapshotStream.end(resolveSnapshot);
      });
    }
  }
  const heapSamplingProfile = heapProfileEnabled
    ? await cdp.send("HeapProfiler.stopSampling").then((result) => summarizeHeapSamplingProfile(result.profile)).catch(() => [])
    : [];
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
  const sampledMemorySeries = processSamples
    .filter((entry) => entry.kind !== "process" && Number.isFinite(entry.elapsedSeconds))
    .map((entry) => ({
      elapsedSeconds: entry.elapsedSeconds,
      aggregatePrivateBytes: Number(entry.processTotals?.privateBytes ?? 0),
      rendererPrivateBytes: Math.max(0, ...(entry.processes ?? [])
        .filter((row) => String(row.role).toLowerCase().includes("renderer"))
        .map((row) => Number(row.privateBytes ?? 0))),
    }));
  const steadyStateStartSeconds = durationSeconds / 2;
  const steadyStateMemorySeries = sampledMemorySeries.filter((entry) => entry.elapsedSeconds >= steadyStateStartSeconds);
  const finalState = await page.evaluate(() => {
    const diagnostics = globalThis.__DSP_RUNTIME_TRANSITIONS__;
    const retentionDiagnostics = globalThis.__DSP_RUNTIME_RETENTION__;
    const phaseStats = {};
    for (const event of diagnostics?.events ?? []) {
      const current = phaseStats[event.phase] ?? { count: 0, totalMs: 0, maxMs: 0 };
      current.count += 1;
      current.totalMs += Number(event.durationMs ?? 0);
      current.maxMs = Math.max(current.maxMs, Number(event.durationMs ?? 0));
      phaseStats[event.phase] = current;
    }
    return {
      worker: document.querySelector(".game-shell")?.getAttribute("data-simulation-worker") ?? "unknown",
      paused: document.querySelector(".game-shell")?.getAttribute("data-simulation-paused") ?? "unknown",
      localSaveRawCacheSize: Number(document.querySelector(".game-shell")?.getAttribute("data-local-save-raw-cache-size") ?? -1),
      events: diagnostics?.events?.slice(-20) ?? [],
      runtimeDiagnostics: {
        retainedEventCount: diagnostics?.events?.length ?? 0,
        counters: diagnostics?.counters ?? {},
        phaseStats,
      },
      runtimeRetention: Object.fromEntries(Object.entries(retentionDiagnostics?.groups ?? {}).map(([label, group]) => {
        const alive = group.entries.flatMap((entry) => {
          const value = entry.reference.deref();
          return value ? [{ sequence: entry.sequence, value }] : [];
        });
        return [label, {
          totalTracked: group.totalTracked,
          retainedWindow: group.entries.length,
          aliveReferences: alive.length,
          aliveDistinctObjects: new Set(alive.map((entry) => entry.value)).size,
          oldestAliveSequence: alive[0]?.sequence ?? null,
          newestAliveSequence: alive.at(-1)?.sequence ?? null,
        }];
      })),
      serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
      memoryGuard: {
        autoPauseEnabled: localStorage.getItem("dsp-idle-network.ui.memory-auto-pause.v1") !== "false",
        thresholdMiB: localStorage.getItem("dsp-idle-network.ui.memory-auto-pause-threshold-mib.v1"),
      },
    };
  });
  const applicationVersion = await page.evaluate(async () => {
    const response = await fetch(`/version.json?benchmark=${Date.now()}`, { cache: "no-store" });
    return response.ok ? response.json() : null;
  }).catch(() => null);
  const report = {
    schemaVersion: 2,
    label,
    scenario,
    url,
    executablePath,
    fixture: { path: savePath, bytes: fixtureStat.size, sha256: fixtureSha256 },
    build: { gitSha, applicationVersion },
    environment: {
      node: process.version,
      browserVersion: browser?.version() ?? null,
      userAgent: await page.evaluate(() => navigator.userAgent),
      machine,
      serviceWorkerControlled: finalState.serviceWorkerControlled,
      memoryGuard: finalState.memoryGuard,
    },
    durationSeconds,
    warmupSeconds,
    sampleSeconds,
    operationEverySeconds,
    operationRounds,
    requestedAutoPause,
    heapProfileEnabled,
    heapSnapshotEnabled,
    heapSnapshotPath,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    pageErrors,
    operationResults,
    peaks: {
      cdpHeapUsedBytes: cdpHeapPeak,
      pagePerformanceMemoryUsedBytes: pageHeapPeak,
      rendererWorkingSetBytes: rendererPeak("workingSetBytes"),
      rendererPrivateBytes: rendererPeak("privateBytes"),
      aggregateWorkingSetBytes: aggregateProcessPeak("workingSetBytes"),
      aggregatePrivateBytes: aggregateProcessPeak("privateBytes"),
      browserProcessWorkingSetBytes: aggregateProcessPeak("workingSetBytes"),
      browserProcessPrivateBytes: aggregateProcessPeak("privateBytes"),
      // Kept for compatibility with the first draft of this harness. These
      // are the largest single process, not an aggregate across Chrome.
      allBrowserProcessWorkingSetBytes: processPeak("workingSetBytes"),
      allBrowserProcessPrivateBytes: processPeak("privateBytes"),
    },
    trends: {
      aggregatePrivateBytesPerMinute: linearSlopeBytesPerMinute(sampledMemorySeries.map((entry) => ({ elapsedSeconds: entry.elapsedSeconds, bytes: entry.aggregatePrivateBytes }))),
      rendererPrivateBytesPerMinute: linearSlopeBytesPerMinute(sampledMemorySeries.map((entry) => ({ elapsedSeconds: entry.elapsedSeconds, bytes: entry.rendererPrivateBytes }))),
      steadyStateStartSeconds,
      steadyAggregatePrivateBytesPerMinute: linearSlopeBytesPerMinute(steadyStateMemorySeries.map((entry) => ({ elapsedSeconds: entry.elapsedSeconds, bytes: entry.aggregatePrivateBytes }))),
      steadyRendererPrivateBytesPerMinute: linearSlopeBytesPerMinute(steadyStateMemorySeries.map((entry) => ({ elapsedSeconds: entry.elapsedSeconds, bytes: entry.rendererPrivateBytes }))),
      firstAggregatePrivateBytes: sampledMemorySeries.at(0)?.aggregatePrivateBytes ?? null,
      lastAggregatePrivateBytes: sampledMemorySeries.at(-1)?.aggregatePrivateBytes ?? null,
      postGcAggregatePrivateBytes: processSamples.at(-1)?.processTotals?.privateBytes ?? null,
    },
    steadyState: {
      startSeconds: steadyStateStartSeconds,
      sampleCount: steadyStateMemorySeries.length,
      aggregatePrivateBytesP50: quantile(steadyStateMemorySeries.map((entry) => entry.aggregatePrivateBytes), 0.5),
      aggregatePrivateBytesP95: quantile(steadyStateMemorySeries.map((entry) => entry.aggregatePrivateBytes), 0.95),
      rendererPrivateBytesP50: quantile(steadyStateMemorySeries.map((entry) => entry.rendererPrivateBytes), 0.5),
      rendererPrivateBytesP95: quantile(steadyStateMemorySeries.map((entry) => entry.rendererPrivateBytes), 0.95),
    },
    ...(heapProfileEnabled ? { heapSamplingProfile } : {}),
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
