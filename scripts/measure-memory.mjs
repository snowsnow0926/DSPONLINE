import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);
const argumentsByName = new Map(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf("=");
  return separator < 0 ? [argument.replace(/^--/, ""), "true"] : [argument.slice(2, separator), argument.slice(separator + 1)];
}));
const executablePath = resolve(argumentsByName.get("browser") ?? "C:/Program Files/Google/Chrome/Application/chrome.exe");
const saveArgument = argumentsByName.get("save");
if (!saveArgument) throw new Error("--save=<path> is required; the source save is always treated as read-only");
const savePath = resolve(saveArgument);
const url = argumentsByName.get("url") ?? "http://127.0.0.1:4318/";
const durationSeconds = Math.max(10, Number(argumentsByName.get("duration") ?? 1_800));
const intervalSeconds = Math.max(5, Math.min(durationSeconds, Number(argumentsByName.get("interval") ?? 300)));
const warmupSeconds = Math.max(0, Number(argumentsByName.get("warmup") ?? 10));
const commandRecords = Math.max(1, Math.min(1_000, Math.floor(Number(argumentsByName.get("command-records") ?? 1_000))));
const label = (argumentsByName.get("label") ?? basename(executablePath, ".exe")).replace(/[^a-zA-Z0-9_-]/g, "-");
const outputPath = resolve(argumentsByName.get("output") ?? `artifacts/performance/memory-${label}-${Date.now()}.json`);
const traceOutputPath = resolve(argumentsByName.get("trace-output") ?? outputPath.replace(/\.json$/i, ".trace.json.gz"));
const disableWorker = argumentsByName.get("disable-worker") === "true";
const manualCdp = argumentsByName.get("manual-cdp") !== "false";
const traceEnabled = argumentsByName.get("trace") !== "false";

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function metricMap(metrics) {
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

function sumByProcessRole(processes) {
  const totals = {};
  for (const process of processes) {
    const current = totals[process.role] ?? { count: 0, workingSetBytes: 0, privateBytes: 0 };
    current.count += 1;
    current.workingSetBytes += process.workingSetBytes;
    current.privateBytes += process.privateBytes;
    totals[process.role] = current;
  }
  return totals;
}

function linearSlope(points) {
  if (points.length < 2) return 0;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (denominator <= 0) return 0;
  return points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
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

async function websocketCommand(webSocketDebuggerUrl, method, params = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      socket.close();
      rejectCommand(new Error(`${method} timed out`));
    }, 5_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) rejectCommand(new Error(message.error.message ?? `${method} failed`));
      else resolveCommand(message.result ?? {});
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectCommand(new Error(`${method} websocket failed`));
    });
  });
}

async function targetHeapUsage(debuggingPort) {
  if (!debuggingPort) return [];
  try {
    const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
    if (!response.ok) return [];
    const targets = await response.json();
    const relevant = targets.filter((target) =>
      ["page", "worker", "service_worker", "shared_worker"].includes(target.type) && target.webSocketDebuggerUrl);
    return await Promise.all(relevant.map(async (target) => {
      try {
        const heap = await websocketCommand(target.webSocketDebuggerUrl, "Runtime.getHeapUsage");
        return {
          id: target.id,
          type: target.type,
          role: target.type === "worker" && String(target.url).includes("simulation.worker") ? "simulation-worker" : target.type,
          url: target.url,
          usedBytes: heap.usedSize,
          totalBytes: heap.totalSize,
        };
      } catch {
        return { id: target.id, type: target.type, role: target.type, url: target.url, error: "heap-unavailable" };
      }
    }));
  } catch {
    return [];
  }
}

async function readTraceStream(cdp, handle) {
  const chunks = [];
  while (true) {
    const part = await cdp.send("IO.read", { handle });
    chunks.push(part.base64Encoded ? Buffer.from(part.data, "base64") : Buffer.from(part.data));
    if (part.eof) break;
  }
  await cdp.send("IO.close", { handle }).catch(() => undefined);
  return Buffer.concat(chunks);
}

const sourceRaw = await readFile(savePath, "utf8");
const sourceStat = await stat(savePath);
const sourceSha256 = sha256(sourceRaw);
const sourceEnvelope = JSON.parse(sourceRaw);
const sourceState = sourceEnvelope.state ?? sourceEnvelope;
sourceEnvelope.savedAt = Date.now();
const isolatedSave = JSON.stringify(sourceEnvelope);
const autosaveIntervalMs = Math.max(1, Number(sourceState.settings?.autosaveIntervalSeconds ?? 30)) * 1_000;

const profileDirectory = await mkdtemp(join(tmpdir(), `dspidle-memory-${label}-`));
let context;
let browser;
let browserProcess;
let debuggingPort = null;
let traceActive = false;
let traceCompletion = null;
let cdp = null;
const samples = [];
const processBursts = [];
const lifecycleStartedAt = Date.now();

try {
  if (manualCdp) {
    debuggingPort = 9_500 + Math.floor(Math.random() * 300);
    browserProcess = spawn(executablePath, [
      `--remote-debugging-port=${debuggingPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDirectory}`,
      "--headless=new",
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--js-flags=--expose-gc",
      "about:blank",
    ], { windowsHide: true, stdio: "ignore" });
    let endpoint;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/version`);
        if (response.ok) {
          endpoint = (await response.json()).webSocketDebuggerUrl;
          break;
        }
      } catch {
        // The isolated browser is still starting.
      }
      await delay(200);
    }
    if (!endpoint) throw new Error("isolated Chrome did not expose a CDP endpoint");
    browser = await chromium.connectOverCDP(endpoint);
    context = browser.contexts()[0];
  } else {
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath,
      headless: true,
      args: ["--js-flags=--expose-gc", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
      viewport: { width: 1440, height: 900 },
    });
  }
  const page = context.pages()[0] ?? await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ withoutWorker, expectedAutosaveIntervalMs }) => {
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.ui.factory-alerts.v1", "false");
    window.localStorage.setItem("dsp-idle-network.canvas-performance-features.v1", JSON.stringify({ renderProjection: true, topologyCache: true, extremeVisuals: true, nodeLod: true, canvasBelts: true, viewportCulling: true, spatialIndexes: true, minimapThrottle: true }));
    window.__DSP_RUNTIME_TRANSITIONS__ = { enabled: true, events: [], active: {}, counters: {} };
    const tracker = { commands: [], autosaveHandler: null };
    Object.defineProperty(window, "__runtimeWorldMemory", { configurable: true, value: tracker });
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler, timeout, ...args) => {
      if (timeout === expectedAutosaveIntervalMs && typeof handler === "function" && !tracker.autosaveHandler) tracker.autosaveHandler = handler;
      return nativeSetInterval(handler, timeout, ...args);
    });
    if (withoutWorker) {
      Object.defineProperty(window, "Worker", { configurable: true, value: undefined });
      return;
    }
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args);
        if (!String(args[0]).includes("simulation.worker") || args[1]?.name !== "factory-simulation") return worker;
        const byId = new Map();
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = (message, transferOrOptions) => {
          if (message?.kind === "advance" && message.command) {
            const command = message.command;
            const trace = {
              id: Number(message.id),
              submittedAt: performance.now(),
              entityRecords: (command.changedEntities?.length ?? 0) + (command.addedEntities?.length ?? 0) + (command.removedEntityIds?.length ?? 0),
              beltRecords: (command.changedBelts?.length ?? 0) + (command.addedBelts?.length ?? 0) + (command.removedBeltIds?.length ?? 0),
            };
            tracker.commands.push(trace);
            byId.set(trace.id, trace);
          }
          if (transferOrOptions === undefined) nativePostMessage(message);
          else nativePostMessage(message, transferOrOptions);
        };
        worker.addEventListener("message", (event) => {
          const trace = byId.get(Number(event.data?.id));
          if (!trace) return;
          trace.responseAt = performance.now();
          trace.workerDurationMs = event.data.durationMs;
          byId.delete(trace.id);
          requestAnimationFrame(() => requestAnimationFrame((paintedAt) => { trace.secondPaintedAt = paintedAt; }));
        });
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  }, { withoutWorker: disableWorker, expectedAutosaveIntervalMs: autosaveIntervalMs });

  cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  const browserVersion = await cdp.send("Browser.getVersion");

  const captureProcesses = async (phase) => {
    const processes = await browserProcessMemory(profileDirectory);
    processBursts.push({ phase, elapsedSeconds: (Date.now() - lifecycleStartedAt) / 1_000, totals: sumByProcessRole(processes) });
  };
  const withProcessBurst = async (phase, operation) => {
    let stopped = false;
    const monitor = (async () => {
      while (!stopped) {
        await captureProcesses(phase);
        if (!stopped) await delay(500);
      }
    })();
    try {
      return await operation();
    } finally {
      stopped = true;
      await monitor;
      await captureProcesses(phase);
    }
  };
  const sample = async (phase, { forceGc = false } = {}) => {
    if (forceGc) {
      await cdp.send("HeapProfiler.collectGarbage");
      await delay(300);
    }
    const [performanceResult, heap, dom, processes, application, targets] = await Promise.all([
      cdp.send("Performance.getMetrics"), cdp.send("Runtime.getHeapUsage"), cdp.send("Memory.getDOMCounters"),
      browserProcessMemory(profileDirectory),
      page.evaluate(() => ({
        entityCount: document.querySelectorAll(".react-flow__node").length,
        edgeCount: document.querySelectorAll(".react-flow__edge").length,
        workerActive: document.querySelector(".game-shell")?.getAttribute("data-simulation-worker") ?? "unknown",
        paused: document.querySelector(".game-shell")?.getAttribute("data-simulation-paused") ?? "unknown",
        rawCacheSize: Number(document.querySelector(".game-shell")?.getAttribute("data-local-save-raw-cache-size") ?? -1),
        visibility: document.visibilityState,
      })).catch(() => ({ entityCount: 0, edgeCount: 0, workerActive: "unavailable", paused: "unknown", rawCacheSize: -1, visibility: "unknown" })),
      targetHeapUsage(debuggingPort),
    ]);
    application.workerCount = page.workers().length;
    const performance = metricMap(performanceResult.metrics);
    const entry = {
      phase,
      elapsedSeconds: Math.round((Date.now() - lifecycleStartedAt) / 100) / 10,
      forcedGc: forceGc,
      heap: { usedBytes: heap.usedSize, totalBytes: heap.totalSize },
      dom,
      performance: {
        jsHeapUsedBytes: performance.JSHeapUsedSize ?? null,
        jsHeapTotalBytes: performance.JSHeapTotalSize ?? null,
        nodeCount: performance.Nodes ?? null,
        documentCount: performance.Documents ?? null,
        listenerCount: performance.JSEventListeners ?? null,
        taskDurationSeconds: performance.TaskDuration ?? null,
      },
      application,
      processTotals: sumByProcessRole(processes),
      processes,
      targets,
    };
    samples.push(entry);
    process.stdout.write(`MEMORY_STAGE ${JSON.stringify({ phase, elapsedSeconds: entry.elapsedSeconds, heapUsedBytes: entry.heap.usedBytes, processTotals: entry.processTotals })}\n`);
    return entry;
  };

  await sample("browser-start");
  if (traceEnabled) {
    traceCompletion = new Promise((resolveTrace) => cdp.once("Tracing.tracingComplete", resolveTrace));
    await cdp.send("Tracing.start", { categories: "devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline.frame", options: "sampling-frequency=10000", transferMode: "ReturnAsStream" });
    traceActive = true;
  }

  await withProcessBurst("load", async () => {
    const entryUrl = new URL(url);
    entryUrl.searchParams.set("storageMigration", "production");
    await page.goto(entryUrl.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
    const seeded = await page.evaluate(async (saveRaw) => {
      const database = await new Promise((resolveDatabase, rejectDatabase) => {
        const request = indexedDB.open("dsp-idle-network.local-saves", 2);
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" }); };
        request.onsuccess = () => resolveDatabase(request.result);
        request.onerror = () => rejectDatabase(request.error);
      });
      const transaction = database.transaction("records", "readwrite");
      transaction.objectStore("records").put({ key: "dsp-idle-network.save.v1", value: saveRaw, bytes: new Blob([saveRaw]).size, updatedAt: Date.now() });
      await new Promise((resolveWrite, rejectWrite) => {
        transaction.oncomplete = resolveWrite;
        transaction.onabort = () => rejectWrite(transaction.error);
        transaction.onerror = () => rejectWrite(transaction.error);
      });
      const request = database.transaction("records", "readonly").objectStore("records").get("dsp-idle-network.save.v1");
      const persisted = await new Promise((resolveRead, rejectRead) => {
        request.onsuccess = () => resolveRead(typeof request.result?.value === "string" ? request.result.value : null);
        request.onerror = () => rejectRead(request.error);
      });
      database.close();
      return persisted === saveRaw;
    }, isolatedSave);
    if (!seeded) throw new Error("isolated IndexedDB seed did not read back exactly");
    await page.reload({ waitUntil: "domcontentloaded" });
    const continueGame = page.getByRole("button", { name: /继续游戏/ });
    await continueGame.waitFor({ state: "visible", timeout: 60_000 });
    await continueGame.click();
    await page.locator(".game-shell").waitFor({ state: "visible", timeout: 180_000 });
    await page.locator(`.game-shell[data-simulation-worker="${disableWorker ? "fallback" : "active"}"]`).waitFor({ state: "attached", timeout: 180_000 });
    await page.locator('.game-shell[data-local-save-raw-cache-size="0"]').waitFor({ state: "attached", timeout: 180_000 });
  });
  await sample("load-active");

  const resume = page.getByLabel("继续模拟");
  if (await resume.isVisible()) await resume.dispatchEvent("click");
  await page.locator('.game-shell[data-simulation-paused="false"]').waitFor({ state: "attached", timeout: 30_000 });
  if (warmupSeconds > 0) await delay(warmupSeconds * 1_000);
  await sample("steady-run");

  const runCommand = async (command, domain) => {
    const before = await page.evaluate(() => window.__runtimeWorldMemory?.commands.length ?? 0);
    const dispatch = await page.evaluate((request) => {
      if (!window.__DSP_RUNTIMEWORLD_BENCHMARK__) throw new Error("diagnostic command bridge is unavailable");
      return window.__DSP_RUNTIMEWORLD_BENCHMARK__.execute(request);
    }, command);
    await page.waitForFunction(({ count, expectedDomain, minimum }) => {
      const commands = window.__runtimeWorldMemory?.commands.slice(count) ?? [];
      return commands.some((trace) => trace.secondPaintedAt !== undefined && (expectedDomain === "entity" ? trace.entityRecords : trace.beltRecords) >= minimum);
    }, { count: before, expectedDomain: domain, minimum: command.count }, { timeout: 30_000 });
    return dispatch;
  };
  const commandResults = await withProcessBurst("command", async () => ({
    entity: await runCommand({ kind: "entity-lock", count: commandRecords, locked: true }, "entity"),
    belt: await runCommand({ kind: "belt-route", count: commandRecords, routeMode: "lower" }, "belt"),
  }));
  await sample("command-complete");

  const autosaveBefore = await page.evaluate(() => window.__DSP_RUNTIME_TRANSITIONS__?.events.filter((event) => event.phase === "persistence-phase" && event.detail?.kind === "autosave" && event.detail?.phase === "complete").length ?? 0);
  const saveMode = await withProcessBurst("save", async () => {
    const triggered = await page.evaluate(() => {
      const handler = window.__runtimeWorldMemory?.autosaveHandler;
      if (typeof handler !== "function") return false;
      handler();
      return true;
    });
    if (triggered) {
      await page.waitForFunction((before) => (window.__DSP_RUNTIME_TRANSITIONS__?.events.filter((event) => event.phase === "persistence-phase" && event.detail?.kind === "autosave" && event.detail?.phase === "complete").length ?? 0) > before, autosaveBefore, { timeout: 180_000 });
      return "autosave";
    }
    await page.getByLabel("打开设置").dispatchEvent("click");
    const operations = page.getByRole("dialog", { name: "运营中心" });
    await operations.waitFor({ state: "visible", timeout: 30_000 });
    await operations.getByRole("tab", { name: "存档" }).dispatchEvent("click");
    await operations.getByRole("button", { name: "立即保存" }).dispatchEvent("click");
    await page.locator('.game-shell[data-persistence-kind="manual"][data-persistence-phase="complete"]').waitFor({ state: "attached", timeout: 180_000 });
    return "manual-fallback";
  });
  await page.locator('.game-shell[data-local-save-raw-cache-size="0"]').waitFor({ state: "attached", timeout: 180_000 });
  await sample("save-complete");
  const postSaveGc = await sample("post-save-gc", { forceGc: true });

  let trace = null;
  if (traceActive) {
    await cdp.send("Tracing.end");
    const completion = await traceCompletion;
    traceActive = false;
    const traceBytes = await readTraceStream(cdp, completion.stream);
    const compressed = gzipSync(traceBytes, { level: 9 });
    await mkdir(dirname(traceOutputPath), { recursive: true });
    await writeFile(traceOutputPath, compressed);
    trace = {
      outputPath: traceOutputPath,
      bytes: traceBytes.byteLength,
      gzipBytes: compressed.byteLength,
      sha256: sha256(compressed),
      dataLossOccurred: completion.dataLossOccurred === true,
      containsExactSavePrefix: traceBytes.includes(Buffer.from(isolatedSave.slice(0, Math.min(1_024, isolatedSave.length)))),
    };
  }

  const trendStartedAt = Date.now();
  while ((Date.now() - trendStartedAt) / 1_000 < durationSeconds) {
    await delay(Math.min(intervalSeconds * 1_000, Math.max(0, durationSeconds * 1_000 - (Date.now() - trendStartedAt))));
    await sample("trend");
  }
  await sample("trend-end");
  const finalGc = await sample("trend-end-gc", { forceGc: true });

  const finalRaw = await readFile(savePath, "utf8");
  const finalStat = await stat(savePath);
  const sourceUnchanged = sha256(finalRaw) === sourceSha256 && finalStat.size === sourceStat.size && finalStat.mtimeMs === sourceStat.mtimeMs;
  const trendSamples = samples.filter((entry) => entry.phase === "trend" || entry.phase === "trend-end" || entry.phase === "trend-end-gc");
  const roleNames = [...new Set(samples.flatMap((entry) => Object.keys(entry.processTotals)))];
  const processRoleDeltas = Object.fromEntries(roleNames.map((role) => [role, {
    workingSetBytes: (finalGc.processTotals[role]?.workingSetBytes ?? 0) - (postSaveGc.processTotals[role]?.workingSetBytes ?? 0),
    privateBytes: (finalGc.processTotals[role]?.privateBytes ?? 0) - (postSaveGc.processTotals[role]?.privateBytes ?? 0),
    trendWorkingSetSlopeBytesPerSecond: linearSlope(trendSamples.map((entry) => ({ x: entry.elapsedSeconds, y: entry.processTotals[role]?.workingSetBytes ?? 0 }))),
  }]));
  const rolePeaks = {};
  for (const burst of processBursts) {
    for (const [role, totals] of Object.entries(burst.totals)) {
      const key = `${burst.phase}:${role}`;
      const current = rolePeaks[key] ?? { workingSetBytes: 0, privateBytes: 0 };
      current.workingSetBytes = Math.max(current.workingSetBytes, totals.workingSetBytes);
      current.privateBytes = Math.max(current.privateBytes, totals.privateBytes);
      rolePeaks[key] = current;
    }
  }
  const report = {
    schemaVersion: 2,
    label,
    browserVersion,
    url,
    source: { bytes: sourceStat.size, sha256: sourceSha256, mtimeMs: sourceStat.mtimeMs, gameStateVersion: sourceState.version ?? null, entities: sourceState.entities?.length ?? 0, belts: sourceState.belts?.length ?? 0, unchanged: sourceUnchanged },
    isolatedSaveBytes: Buffer.byteLength(isolatedSave),
    durationSeconds,
    intervalSeconds,
    warmupSeconds,
    commandRecords,
    disableWorker,
    manualCdp,
    saveMode,
    commandResults,
    trace,
    startedAt: new Date(lifecycleStartedAt).toISOString(),
    completedAt: new Date().toISOString(),
    summary: {
      forcedGcHeapStartBytes: postSaveGc.heap.usedBytes,
      forcedGcHeapEndBytes: finalGc.heap.usedBytes,
      forcedGcHeapDeltaBytes: finalGc.heap.usedBytes - postSaveGc.heap.usedBytes,
      domNodeDelta: finalGc.dom.nodes - postSaveGc.dom.nodes,
      listenerDelta: (finalGc.performance.listenerCount ?? 0) - (postSaveGc.performance.listenerCount ?? 0),
      processRoleDeltas,
      rolePeaks,
      sampleCount: samples.length,
      sourceUnchanged,
    },
    samples,
    processBursts,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`MEMORY_REPORT ${JSON.stringify({ outputPath, traceOutputPath: trace?.outputPath ?? null, summary: report.summary })}\n`);
  if (!sourceUnchanged) throw new Error("source save changed during memory measurement");
  if (trace?.containsExactSavePrefix) throw new Error("CPU trace unexpectedly contains the exact save prefix");
} finally {
  if (traceActive && cdp) await cdp.send("Tracing.end").catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  else await context?.close().catch(() => undefined);
  browserProcess?.kill();
  const resolvedTempPrefix = resolve(tmpdir(), "dspidle-memory-");
  if (resolve(profileDirectory).startsWith(resolvedTempPrefix)) await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
}
