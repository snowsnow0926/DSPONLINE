import { chromium } from "@playwright/test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const options = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)));
const idbOperations = options["idb-operations"] === "1";
const startupBufferGc = options["startup-buffer-gc"] === "1";
const startupWorkerHeaps = options["startup-worker-heaps"] === "1";
const base = new URL(options.url ?? "http://127.0.0.1:4375");
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") throw new Error("Only isolated loopback tests are allowed");
const supply = options.supply ?? "stock";
if (!["stock", "tray", "quantum"].includes(supply)) throw new Error("Unknown material variant");
const seconds = Number(options.seconds ?? 30);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120) throw new Error("Invalid observation window");
const postStopSeconds = Number(options["post-stop-seconds"] ?? 0);
if (!Number.isFinite(postStopSeconds) || postStopSeconds < 0 || postStopSeconds > 10) throw new Error("Invalid post-stop observation window");
const allProcessMemory = options["all-process-memory"] === "1";
const workerHeapMemory = options["worker-heaps"] === "1";
const workerHeapGc = options["worker-heap-gc"] === "1";
if (workerHeapGc && !workerHeapMemory) throw new Error("--worker-heap-gc requires --worker-heaps; diagnostic only");
const postStopMemoryTail = options["post-stop-memory-tail"] === "1";
const postStopHeapGc = options["post-stop-heap-gc"] === "1";
if (postStopMemoryTail && !workerHeapMemory) throw new Error("--post-stop-memory-tail requires --worker-heaps; diagnostic only");
if (postStopHeapGc && (!postStopMemoryTail || workerHeapGc)) throw new Error("--post-stop-heap-gc requires a memory tail and no earlier forced GC");
const mainHeapAllocations = options["main-heap-allocations"] === "1";
if (mainHeapAllocations && !workerHeapMemory) throw new Error("--main-heap-allocations requires --worker-heaps; diagnostic only");
const mainHeapSnapshot = options["main-heap-snapshot"] === "1";
if (mainHeapSnapshot && (!workerHeapMemory || !workerHeapGc)) throw new Error("--main-heap-snapshot requires --worker-heaps and --worker-heap-gc; private diagnostic only");
const runtimeRetention = mainHeapSnapshot || options["runtime-retention"] === "1";
if (runtimeRetention && (!workerHeapMemory || !workerHeapGc)) throw new Error("--runtime-retention requires --worker-heaps and --worker-heap-gc; diagnostic only");
const runtimeTransitions = options["runtime-transitions"] === "1";
const styleReadDiagnostics = options["style-read-diagnostics"] === "1";
const handoffProgress = options["handoff-progress"] === "1";
const profilePhase = options["profile-phase"] ?? "all";
if (!["all", "starting", "stopping"].includes(profilePhase)) throw new Error("Invalid profiler phase");
const timelinePhase = options.timeline ?? null;
if (timelinePhase !== null && timelinePhase !== "stopping") throw new Error("Only --timeline=stopping is supported");
if (timelinePhase && options.profile) throw new Error("Capture CPU sampling and browser timeline in separate diagnostic runs");
const backgroundPresentationExperiment = options["background-experiment"] ?? null;
if (backgroundPresentationExperiment !== null && backgroundPresentationExperiment !== "opacity-inert") {
  throw new Error("Unknown isolated background presentation experiment");
}
const output = resolve(options.output ?? "artifacts/web-live-runtime");
const name = options.name ?? `live-${supply}`;
if (!/^[a-z0-9-]+$/i.test(name)) throw new Error("Invalid evidence name");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
let page;
let profiler;
let profilerTimeline;
let allocationSession;
let mainHeapSnapshotResult;
let timelineSession, timelineComplete, timelineTiming;
let primaryFailed = false;
const errors = [];
const processSamples = [];
const heapSamples = [];
const retentionSamples = [];
const startupBufferSamples = [];
const bounded = (promise, ms = 5000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error("diagnostic timeout")), ms))]);

async function capturePrivateMainHeap(session, stage) {
  const file = `${name}-private-main.heapsnapshot`;
  const stream = createWriteStream(resolve(output, file), { flags: "wx" });
  let bytes = 0, truncated = false, streamError, captureError;
  const closed = new Promise(resolve => stream.once("close", resolve));
  stream.on("error", error => { streamError = error; });
  const onChunk = ({ chunk }) => {
    if (truncated || streamError) return;
    const size = Buffer.byteLength(chunk);
    if (bytes + size > 4 * 1024 * 1024 * 1024 || stream.writableLength > 16 * 1024 * 1024) {
      truncated = true; return;
    }
    bytes += size;
    stream.write(chunk);
  };
  session.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    await session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false, exposeInternals: false });
  } catch (error) { captureError = String(error); }
  finally {
    session.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    stream.end();
    await closed;
  }
  mainHeapSnapshotResult = { stage, file, bytes, private: true, complete: !truncated && !streamError && !captureError,
    truncated, ...(streamError ? { streamError: String(streamError) } : {}), ...(captureError ? { captureError } : {}) };
  await writeFile(resolve(output, `${name}-private-main-metadata.json`), JSON.stringify(mainHeapSnapshotResult, null, 2));
  if (!mainHeapSnapshotResult.complete) throw Error("Private main heap snapshot incomplete; retain metadata and exclude from analysis");
}

async function sampleHeaps(stage, collectGarbage = workerHeapGc) {
  const session = await browser.newBrowserCDPSession();
  const workers = [];
  let main;
  try {
    const pageSession = await context.newCDPSession(page);
    try {
      if (collectGarbage) await pageSession.send("HeapProfiler.collectGarbage");
      main = await pageSession.send("Runtime.getHeapUsage");
      if (mainHeapSnapshot && stage === "normal simulation warmed") await capturePrivateMainHeap(pageSession, stage);
    } finally { await pageSession.detach(); }
    if (allocationSession) {
      const { profile } = await allocationSession.send("HeapProfiler.getSamplingProfile");
      await writeFile(resolve(output, `${name}-allocations-${stage.replace(/[^a-z0-9]+/gi, "-")}.json`), JSON.stringify(profile));
    }
    if (runtimeRetention) {
      const groups = await page.evaluate(() => Object.fromEntries(Object.entries(globalThis.__DSP_RUNTIME_RETENTION__?.groups ?? {}).map(([label, group]) => {
        const alive = new Set();
        for (const entry of group.entries) {
          const value = entry.reference.deref();
          if (value) alive.add(value);
        }
        return [label, { totalTracked: group.totalTracked, retainedEntries: group.entries.length, uniqueAlive: alive.size }];
      })));
      retentionSamples.push({ stage, groups });
      await writeFile(resolve(output, `${name}-retention.json`), JSON.stringify(retentionSamples, null, 2));
    }
    const { targetInfos } = await session.send("Target.getTargets");
    for (const target of targetInfos.filter((item) => item.type === "worker" && item.url.startsWith(base.origin + "/"))) {
      let sessionId;
      let listener;
      try {
        ({ sessionId } = await session.send("Target.attachToTarget", { targetId: target.targetId, flatten: false }));
        const requestWorker = async (id, method) => {
          const response = new Promise((resolve, reject) => {
            listener = (event) => {
              if (event.sessionId !== sessionId) return;
              const message = JSON.parse(event.message);
              if (message.id === id) message.error ? reject(new Error(message.error.message)) : resolve(message.result);
            };
            session.on("Target.receivedMessageFromTarget", listener);
          });
          try {
            const [result] = await Promise.all([bounded(response, collectGarbage ? 10000 : 3000), session.send("Target.sendMessageToTarget", {
              sessionId, message: JSON.stringify({ id, method }),
            })]);
            return result;
          } finally { session.off("Target.receivedMessageFromTarget", listener); listener = undefined; }
        };
        if (collectGarbage) await requestWorker(2, "HeapProfiler.collectGarbage");
        const usage = await requestWorker(1, "Runtime.getHeapUsage");
        workers.push({ script: new URL(target.url).pathname.split("/").at(-1), ...usage });
      } catch (error) {
        workers.push({ script: new URL(target.url).pathname.split("/").at(-1), error: String(error) });
      } finally {
        if (listener) session.off("Target.receivedMessageFromTarget", listener);
        if (sessionId) await session.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    }
    heapSamples.push({ stage, ...(collectGarbage ? { forcedGc: true } : {}), main, workers });
  } finally { await session.detach(); }
}

async function sampleProcesses(stage) {
  try {
    const session = await bounded(browser.newBrowserCDPSession());
    const { processInfo } = await bounded(session.send("SystemInfo.getProcessInfo"));
    const rendererIds = new Set(processInfo.filter((item) => item.type === "renderer").map((item) => item.id));
    const ids = processInfo.filter((item) => Number.isSafeInteger(item.id) && item.id > 0 && (allProcessMemory || rendererIds.has(item.id))).map((item) => item.id);
    const sampled = process.platform === "win32" && ids.length ? JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`], { encoding: "utf8" }) || "null") : null;
    const rows = sampled ? Array.isArray(sampled) ? sampled : [sampled] : [];
    const rendererRows = rows.filter((row) => rendererIds.has(row.Id));
    const memory = rendererRows.length === 1 ? rendererRows[0] : rendererRows.length ? rendererRows : null;
    processSamples.push({ stage, processInfo, memory, ...(allProcessMemory ? { allProcessMemory: rows,
      sampledBrowserWorkingSetBytes: rows.reduce((sum, row) => sum + row.WorkingSet64, 0),
      sampledBrowserPrivateBytes: rows.reduce((sum, row) => sum + row.PrivateMemorySize64, 0) } : {}) });
    await session.detach();
    await writeFile(resolve(output, `${name}-processes.json`), JSON.stringify(processSamples, null, 2));
    if (workerHeapMemory) {
      await sampleHeaps(stage);
      await writeFile(resolve(output, `${name}-heaps.json`), JSON.stringify(heapSamples, null, 2));
    }
  } catch { /* process sampling must not change the game outcome */ }
}

try {
  if (startupWorkerHeaps) await context.exposeBinding("__probeStartupWorkers", async () => {
    await sampleHeaps("before-macro-initialize");
    await writeFile(resolve(output, `${name}-heaps.json`), JSON.stringify(heapSamples, null, 2));
  });
  if (startupBufferGc) await context.exposeBinding("__probeStartupBuffer", async ({ page }, stage) => {
    const session = await context.newCDPSession(page);
    try {
      await session.send("HeapProfiler.collectGarbage");
      const usage = await session.send("Runtime.getHeapUsage");
      startupBufferSamples.push({ stage, forcedGc: true, ...usage });
    } catch (error) {
      startupBufferSamples.push({ stage, error: String(error) });
      throw error;
    } finally { await session.detach(); }
  });
  await context.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated runtime test"}' }));
  await context.addInitScript(({ profileSteps, idbOperations, startupBufferGc, startupWorkerHeaps, runtimeRetention, runtimeTransitions, styleReadDiagnostics, handoffProgress }) => {
    if (location.hostname !== "127.0.0.1") return;
    if (runtimeRetention) globalThis.__DSP_RUNTIME_TRANSITIONS__ = { enabled: true, events: [], active: {} };
    if (runtimeTransitions && !globalThis.__DSP_RUNTIME_TRANSITIONS__) {
      globalThis.__DSP_RUNTIME_TRANSITIONS__ = { enabled: true, events: [], active: {} };
    }
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-10-27-v1.3.2");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    const trace = { active: false, phase: "idle", startedAt: 0, lastElapsed: 0, frames: [], tasks: [], sends: [], events: [] };
    globalThis.__LIVE_RUNTIME_TRACE__ = trace;
    if (handoffProgress) { trace.handoff = []; trace.handoffCapped = false; }
    if (styleReadDiagnostics) {
      trace.styleReads = [];
      const getComputedStyle = window.getComputedStyle;
      window.getComputedStyle = function (element, ...args) {
        if (!trace.active || !["stopping", "post-stop"].includes(trace.phase)) {
          return Reflect.apply(getComputedStyle, this, [element, ...args]);
        }
        const start = performance.now();
        const style = Reflect.apply(getComputedStyle, this, [element, ...args]);
        // Style objects are lazy. Read the same two properties as the modal's
        // focus guard before ending the diagnostic interval.
        const display = style.display, visibility = style.visibility;
        const duration = performance.now() - start;
        if (duration >= 1 && trace.styleReads.length < 200) trace.styleReads.push({
          phase: trace.phase, at: start - trace.startedAt, duration,
          tag: element.tagName, body: element === document.body,
          tabIndex: element.tabIndex, hasTabindex: element.hasAttribute("tabindex"),
          connected: element.isConnected, display, visibility,
          backgroundHidden: document.querySelector(".game-shell")?.classList.contains("game-shell--pure-idle") ?? null,
        });
        return style;
      };
    }
    if (idbOperations) {
      trace.idb = [];
      const record = (operation, start, duration, store, database, ok) => {
        if (trace.active && trace.idb.length < 2000) trace.idb.push({
          operation, phase: trace.phase, at: start - trace.startedAt,
          duration, store, database, ok,
        });
      };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const start = performance.now(); let ok = false;
        try { const result = Reflect.apply(put, this, args); ok = true; return result; }
        finally { record("put", start, performance.now() - start, this.name, this.transaction.db.name, ok); }
      };
      const result = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result");
      trace.idbResultGetterObserved = Boolean(result?.configurable && result.get);
      if (trace.idbResultGetterObserved) Object.defineProperty(IDBRequest.prototype, "result", {
        ...result,
        get() {
          const start = performance.now(); let ok = false;
          try { const value = Reflect.apply(result.get, this, []); ok = true; return value; }
          finally {
            const duration = performance.now() - start;
            const source = this.source?.objectStore ?? this.source;
            record("result", start, duration, source?.name ?? null, source?.transaction?.db?.name ?? null, ok);
          }
        },
      });
    }
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, workerOptions) {
        super(url, workerOptions);
        const name = workerOptions?.name ?? String(url).split("/").at(-1);
        if (trace.active) trace.events.push({ name, phase: trace.phase,
          at: performance.now() - trace.startedAt, type: "worker-created" });
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          if (trace.active) trace.events.push({ name, phase: trace.phase,
            at: performance.now() - trace.startedAt, type: "worker-terminated" });
          terminate();
        };
        const send = this.postMessage.bind(this);
        this.postMessage = (request, transfers = []) => {
          const start = performance.now();
          try {
            if (startupWorkerHeaps && name === "pure-idle-macro" && request.type === "initialize") {
              // Diagnostic only: capture the Workers that remain after the
              // primary commit, before the macro Worker allocates its graph.
              void globalThis.__probeStartupWorkers().then(() => send(request, transfers));
              return;
            }
            if (startupBufferGc && name === "pure-idle-checkpoint-owner" && request.type === "recovery-serialize") {
              // Diagnostic only: stop at the real serialization boundary and
              // collect the page heap before allowing the Worker to continue.
              // Never use this run for latency or unforced memory comparisons.
              void globalThis.__probeStartupBuffer("before-owner-serialization").catch(() => {}).then(() => send(request, transfers));
              return;
            }
            return send(profileSteps && name === "factory-simulation" && request.kind === "advance"
              ? { ...request, profile: true } : request, transfers);
          }
          finally {
            if (trace.active) trace.sends.push({ name, phase: trace.phase, at: start - trace.startedAt,
              type: request?.type ?? request?.kind ?? "serialize", duration: performance.now() - start,
              targetWallSeconds: request?.targetWallSeconds, simulationSeconds: request?.simulationSeconds,
              wallSeconds: request?.wallSeconds, entities: request?.state?.entities?.length });
          }
        };
        if (name === "pure-idle-macro") this.addEventListener("message", ({ data }) => {
          if (!trace.active) return;
          const summary = data.summary;
          trace.events.push({ name, phase: trace.phase, at: performance.now() - trace.startedAt,
            type: data.type, operation: data.operation, stage: data.phase, durationMs: data.durationMs,
            wallClockMs: data.wallClockMs, code: data.code,
            ...(summary ? { summary: { phase: summary.phase, mode: summary.mode,
              settledWallSeconds: summary.settledWallSeconds, settledSimulationSeconds: summary.settledSimulationSeconds,
              actualMultiplier: summary.actualMultiplier, validationFailures: summary.validationFailures,
              computationDurationMs: summary.computationDurationMs, construction: summary.construction } } : {}) });
        });
        if (name === "factory-simulation") this.addEventListener("message", (event) => {
          if (!trace.active) return;
          const data = event.data;
          const elapsed = data.projection?.elapsedSeconds ?? data.deferredElapsedSeconds ?? data.state?.elapsedSeconds;
          if (Number.isFinite(elapsed)) trace.lastElapsed = elapsed;
          trace.events.push({ name, phase: trace.phase, at: performance.now() - trace.startedAt,
            type: "factory-response", durationMs: data.durationMs, elapsed, protocol: data.protocol,
            deferred: data.projectionDeferred, changed: data.changed,
            profiler: data.profiler,
            error: data.runtimeError?.message });
        });
        if (handoffProgress && ["canonical-terminal-decoder", "authoritative-save-persistence",
          "authoritative-save-serialization", "pure-idle-checkpoint-owner", "pure-idle-macro"].includes(name)) {
          this.addEventListener("message", ({ data }) => {
            if (!trace.active) return;
            if (trace.handoff.length >= 2000) { trace.handoffCapped = true; return; }
            const row = { name, phase: trace.phase, at: performance.now() - trace.startedAt };
            const numeric = (label, value) => { if (typeof value === "number" && Number.isFinite(value)) row[label] = value; };
            const tag = (label, value) => { if (typeof value === "string" && /^[a-z0-9-]{1,80}$/.test(value)) row[label] = value; };
            tag("type", data.type); tag("stage", data.progress?.stage ?? data.phase);
            tag("collection", data.collection);
            numeric("durationMs", data.durationMs); numeric("compressionDurationMs", data.compressionDurationMs);
            numeric("byteLength", data.byteLength); numeric("bytes", data.progress?.bytes);
            numeric("entityCount", data.entityCount); numeric("beltCount", data.beltCount);
            numeric("recordCount", Array.isArray(data.records) ? data.records.length : undefined);
            const proof = data.result?.proof ?? data.proof;
            numeric("proofByteLength", proof?.byteLength); numeric("storedByteLength", proof?.storedByteLength);
            numeric("workerDecodeMs", proof?.workerDecodeMs); numeric("idbWriteMs", proof?.idbWriteMs);
            numeric("backupVerifyMs", proof?.backupVerifyMs); numeric("totalBytesWritten", proof?.totalBytesWritten);
            tag("transportEncoding", proof?.transportEncoding);
            if (typeof data.result?.ok === "boolean") row.ok = data.result.ok;
            if (typeof data.error === "string" || data.type === "error") row.failed = true;
            trace.handoff.push(row);
          });
        }
      }
    };
    let last = performance.now();
    function frame() {
      const now = performance.now();
      if (trace.active) trace.frames.push({ phase: trace.phase, at: now - trace.startedAt, gap: now - last });
      last = now;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    new PerformanceObserver((list) => {
      if (trace.active) for (const entry of list.getEntries()) trace.tasks.push({ phase: trace.phase, at: entry.startTime - trace.startedAt, duration: entry.duration });
    }).observe({ type: "longtask" });
  }, { profileSteps: Boolean(options["engine-profile"]), idbOperations, startupBufferGc, startupWorkerHeaps, runtimeRetention, runtimeTransitions, styleReadDiagnostics, handoffProgress });
  context.on("page", (opened) => {
    opened.setDefaultTimeout(120_000);
    opened.on("pageerror", (error) => { errors.push(error.message); console.log(`Page error: ${error.message}`); });
    opened.on("crash", () => { errors.push("isolated renderer crashed"); console.log("Isolated renderer crashed"); });
  });
  page = await context.newPage();
  if (backgroundPresentationExperiment) await context.addInitScript(() => {
    // Isolated presentation experiment only. Production assets and state are
    // untouched. Inert preserves keyboard/assistive-technology exclusion;
    // opacity alone would leave hidden controls focusable.
    const install = () => {
      if (!document.head || !document.body) return;
      const style = document.createElement("style");
      style.textContent = ".game-shell--pure-idle > *:not(.time-warp-idle-overlay){visibility:visible!important;opacity:0!important}";
      document.head.append(style);
      const discover = new MutationObserver(bind);
      function bind() {
        const root = document.querySelector(".game-shell[data-factory-canvas-source]");
        if (!root) return;
        discover.disconnect();
        const retained = new Map();
        const sync = () => {
          if (root.classList.contains("game-shell--pure-idle")) {
            for (const child of root.children) {
              if (child.classList.contains("time-warp-idle-overlay")) continue;
              if (!retained.has(child)) retained.set(child, child.getAttribute("inert"));
              child.setAttribute("inert", "");
            }
          } else {
            for (const [child, previous] of retained) {
              if (previous === null) child.removeAttribute("inert");
              else child.setAttribute("inert", previous);
            }
            retained.clear();
          }
        };
        new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["class"], childList: true });
        sync();
      }
      discover.observe(document.body, { childList: true, subtree: true });
      bind();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
    else install();
  });
  await page.goto(new URL("/icon.svg", base).href);
  console.log("Preparing isolated large-save runtime");
  const seeded = await page.evaluate(async (supply) => {
    await import("/@vite/env");
    const engine = await import("/src/game/engine.ts");
    const content = await import("/src/game/content.ts");
    const storage = await import("/src/game/storage.ts");
    const store = await import("/src/game/localSaveStore.ts");
    let state = (await (await fetch("/__save_performance_fixture__")).json()).state;
    const centers = state.entities.filter((entity) => entity.buildingId === "construction_center");
    const controller = state.entities.find((entity) => entity.id === state.timeWarp.controllerEntityId && entity.buildingId === "time_warp_device")
      ?? state.entities.find((entity) => entity.buildingId === "time_warp_device");
    if (!controller) throw Error("No time-warp controller in the fixture");
    if (supply !== "stock") for (const planet of new Set(centers.map((center) => center.planetId))) {
      const tray = state.planetTrays[planet] = {};
      if (supply === "tray") for (const item of Object.keys(content.ITEMS)) tray[item] = 1_000_000_000;
    }
    if (supply === "quantum") {
      if (!state.quantumLogisticsNetwork.enabled) throw Error("Fixture has no enabled quantum network");
      for (const item of Object.keys(content.ITEMS)) state.quantumLogisticsNetwork.inventory[item] = "1000000000";
    }
    state.tray = state.planetTrays[state.activePlanetId] ?? {};
    state.constructionAutomation.enabled = true;
    state.paused = false;
    const runtime = engine.createPersistentSimulationRuntime(state);
    engine.advancePersistentSimulationRuntime(runtime, 0.1, 0.1);
    state = runtime.state;
    state.paused = true;
    state.timeWarp.enabled = false;
    state.timeWarp.requestedMultiplier = 8;
    state.timeWarp.pendingSimulationSeconds = 0;
    state.timeWarp.pendingWallSeconds = 0;
    state.timeWarp.controllerEntityId = controller.id;
    state.activePlanetId = controller.planetId;
    state.tray = state.planetTrays[state.activePlanetId] ?? {};
    state.planetViewports[state.activePlanetId] = { x: 400 - controller.position.x * 0.5, y: 250 - controller.position.y * 0.5, zoom: 0.5 };
    state.settings.autosaveIntervalSeconds = 0;
    engine.refreshTimeWarpPowerSnapshotInPlace(state);
    await store.initializeLocalSaveStore();
    const saved = await storage.saveGameVerified(state, undefined, undefined, { preferWorkerProof: true });
    if (!saved.success) throw Error(saved.message);
    window.dispatchEvent(new Event("beforeunload"));
    return { controllerId: controller.id, planetId: controller.planetId, entities: state.entities.length,
      belts: state.belts.length, centers: centers.length, quantum: state.quantumLogisticsNetwork.enabled,
      elapsedSeconds: state.elapsedSeconds,
      backupSettings: Object.fromEntries(Object.entries(state.settings).filter(([key]) => /backup|snapshot/i.test(key))),
      sessionEntries: Object.entries(sessionStorage), sourcePrimaryChecksum: store.getLocalSaveCatalog("dsp-idle-network.save.v1")?.stateChecksum };
  }, supply);
  await page.close();
  page = await context.newPage();
  await page.addInitScript((entries) => { for (const [key, value] of entries) sessionStorage.setItem(key, value); }, seeded.sessionEntries);
  delete seeded.sessionEntries;
  if (mainHeapAllocations) {
    allocationSession = await context.newCDPSession(page);
    // Live allocation stacks only. Sampling/GC runs are diagnostics and must
    // never be used as uninstrumented latency or memory qualification.
    await allocationSession.send("HeapProfiler.startSampling", { samplingInterval: 65536 });
  }
  await page.goto(new URL("/?factory=1&storageMigration=production&performanceProduction=1", base).href, { waitUntil: "domcontentloaded" });
  await page.locator('.game-shell[data-simulation-worker="active"]').waitFor();
  console.log("Factory ready; selecting time-warp controller");
  const node = page.locator(`.react-flow__node[data-id="${seeded.controllerId}"]`);
  if (await node.count()) await node.evaluate((element) => element.click());
  else await page.locator(".react-flow__pane").click({ position: { x: 430, y: 270 } });
  await page.locator(".time-warp-inspector").waitFor();
  const start = page.getByRole("button", { name: "开始产率复制挂机", exact: true });
  await start.waitFor();
  await sampleProcesses("factory mounted");
  if (options.profile && profilePhase === "all") {
    profiler = await context.newCDPSession(page);
    await profiler.send("Profiler.enable");
    await profiler.send("Profiler.start");
  }
  await page.evaluate((elapsed) => { const trace = globalThis.__LIVE_RUNTIME_TRACE__; trace.startedAt = performance.now(); trace.phase = "warmup"; trace.lastElapsed = elapsed; trace.active = true; }, seeded.elapsedSeconds);
  // Persisted saves intentionally omit live production-history samples. Earn
  // the replication window through the normal authoritative timeline.
  const warmupTarget = seeded.elapsedSeconds + 40;
  const warmupStarted = Date.now();
  let warmup;
  console.log("Accumulating the live production-rate window");
  await page.getByRole("button", { name: "继续模拟", exact: true }).click({ noWaitAfter: true });
  while (Date.now() - warmupStarted < 180_000) {
    await page.waitForFunction((target) => globalThis.__LIVE_RUNTIME_TRACE__.lastElapsed >= target, warmupTarget, { timeout: 10_000 }).catch(() => undefined);
    const progress = await bounded(page.evaluate(() => ({ elapsed: globalThis.__LIVE_RUNTIME_TRACE__.lastElapsed,
      responses: globalThis.__LIVE_RUNTIME_TRACE__.events.length, notice: document.querySelector(".game-notice")?.textContent })));
    console.log(JSON.stringify({ warmupSimulationSeconds: progress.elapsed - seeded.elapsedSeconds, wallSeconds: (Date.now() - warmupStarted) / 1000, responses: progress.responses, notice: progress.notice }));
    if (progress.elapsed >= warmupTarget) {
      warmup = { wallMs: Date.now() - warmupStarted, simulationSeconds: progress.elapsed - seeded.elapsedSeconds };
      break;
    }
  }
  if (await page.evaluate((target) => globalThis.__LIVE_RUNTIME_TRACE__.lastElapsed < target, warmupTarget)) throw Error("Real timeline could not fill the replication window within 180 seconds");
  await page.getByRole("button", { name: "暂停模拟", exact: true }).click({ noWaitAfter: true });
  await page.locator('.game-shell[data-simulation-paused="true"]').waitFor();
  // Manual pause discards unsubmitted normal-play debt at the next scheduler
  // tick. Let that established rule run before comparing macro transitions.
  if (!options["retain-debt"]) await page.waitForTimeout(1_500);
  await sampleProcesses("normal simulation warmed");
  if (options.profile && profilePhase === "starting") {
    profiler = await context.newCDPSession(page);
    await profiler.send("Profiler.enable");
    const beforeMs = await page.evaluate(() => performance.now() - globalThis.__LIVE_RUNTIME_TRACE__.startedAt);
    await profiler.send("Profiler.start");
    const afterMs = await page.evaluate(() => performance.now() - globalThis.__LIVE_RUNTIME_TRACE__.startedAt);
    profilerTimeline = { phase: profilePhase, startTraceBeforeMs: beforeMs, startTraceAfterMs: afterMs };
  }
  await page.evaluate(() => { globalThis.__LIVE_RUNTIME_TRACE__.phase = "starting"; });
  console.log("Starting replication through the real UI");
  const startStartedAt = Date.now();
  await start.click({ noWaitAfter: true });
  console.log("Replication click dispatched");
  const overlay = page.getByRole("dialog", { name: "纯挂机", exact: true });
  let statusInFlight = false;
  const statusTimer = setInterval(async () => {
    if (statusInFlight) return;
    statusInFlight = true;
    try {
      console.log(JSON.stringify({ startupStatus: await bounded(page.evaluate(() => ({
        inspector: document.querySelector(".time-warp-inspector")?.textContent?.slice(-1000),
        overlay: document.querySelector(".time-warp-idle-overlay")?.textContent?.slice(0, 300),
        persistence: document.querySelector(".game-shell")?.getAttribute("data-persistence-phase"),
        events: globalThis.__LIVE_RUNTIME_TRACE__.events.slice(-3),
      }))) }));
    } catch { console.log("Startup diagnostics could not reach the renderer"); }
    finally { statusInFlight = false; }
  }, 10_000);
  try {
    await overlay.waitFor();
    await page.waitForFunction(() => globalThis.__LIVE_RUNTIME_TRACE__.events.some((event) => event.type === "ready"));
  } finally { clearInterval(statusTimer); }
  const startMs = Date.now() - startStartedAt;
  if (profiler && profilePhase === "starting") {
    const beforeMs = await page.evaluate(() => performance.now() - globalThis.__LIVE_RUNTIME_TRACE__.startedAt);
    const capture = await profiler.send("Profiler.stop");
    const afterMs = await page.evaluate(() => performance.now() - globalThis.__LIVE_RUNTIME_TRACE__.startedAt);
    profilerTimeline = { ...profilerTimeline, stopTraceBeforeMs: beforeMs, stopTraceAfterMs: afterMs };
    await writeFile(resolve(output, `${name}.cpuprofile`), JSON.stringify(capture.profile));
    await writeFile(resolve(output, `${name}-profile-timeline.json`), JSON.stringify(profilerTimeline, null, 2));
    await profiler.detach();
    profiler = undefined;
  }
  if (backgroundPresentationExperiment) await page.evaluate(() => {
    const root = document.querySelector(".game-shell[data-factory-canvas-source]");
    const overlay = root?.querySelector(".time-warp-idle-overlay");
    const background = [...(root?.children ?? [])].filter((child) => !child.classList.contains("time-warp-idle-overlay"));
    if (!overlay || background.length === 0 || overlay.closest("[inert]")) throw Error("Experimental modal is missing or inert");
    if (background.some((child) => !child.hasAttribute("inert") || getComputedStyle(child).opacity !== "0")) {
      throw Error("Presentation experiment did not apply to the actual frozen production page");
    }
  });
  await sampleProcesses("replication ready");
  await page.evaluate(() => { globalThis.__LIVE_RUNTIME_TRACE__.phase = "running"; });
  console.log(`Observing ${seconds} seconds of active replication`);
  await page.waitForTimeout(seconds * 1000);
  const visibleSummary = (await overlay.innerText()).slice(0, 5000);
  await sampleProcesses("replication running");
  const geometryBeforeStop = await page.evaluate(() => {
    const canvas = document.querySelector(".canvas-belt-layer__topology");
    return canvas ? { builds: canvas.getAttribute("data-hit-index-builds"), reuses: canvas.getAttribute("data-hit-index-reuses") } : null;
  });
  const beforeStop = await page.evaluate(() => globalThis.__LIVE_RUNTIME_TRACE__);
  await writeFile(resolve(output, `${name}-prestop.json`), JSON.stringify({ browser: await browser.version(), supply, seeded, trace: beforeStop, processSamples }));
  await page.evaluate(() => { globalThis.__LIVE_RUNTIME_TRACE__.phase = "stopping"; });
  if (timelinePhase) {
    timelineSession = await browser.newBrowserCDPSession();
    timelineComplete = new Promise((resolve) => timelineSession.once("Tracing.tracingComplete", resolve));
    const beforeMs = await page.evaluate(() => performance.now() - globalThis.__LIVE_RUNTIME_TRACE__.startedAt);
    await timelineSession.send("Tracing.start", {
      transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none",
      traceConfig: { recordMode: "recordUntilFull", traceBufferSizeInKb: 65_536,
        enableSampling: false, includedCategories: ["devtools.timeline", "blink.user_timing", "v8"] },
    });
    const afterMs = await page.evaluate(() => {
      performance.mark("dsp-stop-trace-begin");
      return performance.now() - globalThis.__LIVE_RUNTIME_TRACE__.startedAt;
    });
    timelineTiming = { phase: timelinePhase, startTraceBeforeMs: beforeMs, startTraceAfterMs: afterMs };
  }
  if (options.profile && profilePhase === "stopping") {
    profiler = await context.newCDPSession(page);
    await profiler.send("Profiler.enable");
    const beforeMs = await page.evaluate(() => performance.now() - globalThis.__LIVE_RUNTIME_TRACE__.startedAt);
    await profiler.send("Profiler.start");
    const afterMs = await page.evaluate(() => performance.now() - globalThis.__LIVE_RUNTIME_TRACE__.startedAt);
    profilerTimeline = { phase: profilePhase, startTraceBeforeMs: beforeMs, startTraceAfterMs: afterMs };
  }
  const stopStarted = Date.now();
  console.log("Stopping replication and committing the verified checkpoint");
  await overlay.getByRole("button", { name: "停止并结算纯挂机", exact: true }).click({ noWaitAfter: true });
  await overlay.waitFor({ state: "hidden" });
  const stopMs = Date.now() - stopStarted;
  const stopCompletedAt = Date.now();
  if (backgroundPresentationExperiment) await page.evaluate(() => {
    const root = document.querySelector(".game-shell[data-factory-canvas-source]");
    if (!root || [...root.children].some((child) => child.hasAttribute("inert"))) {
      throw Error("Experimental background focus exclusion was not restored");
    }
  });
  if (postStopSeconds > 0) {
    await page.evaluate(() => { globalThis.__LIVE_RUNTIME_TRACE__.phase = "post-stop"; });
    await page.waitForTimeout(postStopSeconds * 1000);
  }
  if (timelineSession) await page.evaluate(() => performance.mark("dsp-stop-trace-finish"));
  const trace = await page.evaluate(() => { const trace = globalThis.__LIVE_RUNTIME_TRACE__; trace.active = false; return trace; });
  const runtimeTransitionEvidence = runtimeTransitions
    ? await page.evaluate(() => globalThis.__DSP_RUNTIME_TRANSITIONS__ ?? null)
    : null;
  const geometryAfterStop = await page.evaluate(() => {
    const canvas = document.querySelector(".canvas-belt-layer__topology");
    return canvas ? { builds: canvas.getAttribute("data-hit-index-builds"), reuses: canvas.getAttribute("data-hit-index-reuses") } : null;
  });
  await sampleProcesses("replication stopped");
  const readDurable = () => page.evaluate(async () => {
    const request = (operation) => new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
    });
    const db = await request(indexedDB.open("dsp-idle-network.local-saves"));
    const record = await request(db.transaction("records").objectStore("records").get(
      `dsp-idle-network.local-save.catalog.v1.${encodeURIComponent("dsp-idle-network.save.v1")}`));
    db.close();
    return { catalog: record ? JSON.parse(record.value) : null,
      paused: document.querySelector(".game-shell")?.getAttribute("data-simulation-paused") };
  });
  const durable = await readDurable();
  if (durable.catalog?.integrity !== "valid" || durable.catalog.entityCount !== seeded.entities ||
    durable.catalog.beltCount !== seeded.belts || durable.paused !== "true") throw Error("Invalid terminal checkpoint or pause restoration");
  if (durable.catalog.settings) {
    if (durable.catalog.settings.autosaveIntervalSeconds !== 0) throw Error("Automatic saving preference changed");
    for (const [key, value] of Object.entries(seeded.backupSettings)) {
      if (JSON.stringify(durable.catalog.settings[key]) !== JSON.stringify(value)) throw Error(`Backup preference changed: ${key}`);
    }
  }
  if (postStopMemoryTail) {
    for (const seconds of [10, 30]) {
      await page.waitForTimeout(Math.max(0, seconds * 1000 - (Date.now() - stopCompletedAt)));
      await sampleProcesses(`replication stopped +${seconds}s`);
      if (seconds === 10 && postStopHeapGc) {
        await sampleHeaps("replication stopped diagnostic GC", true);
        await sampleProcesses("replication stopped after diagnostic GC");
      }
      const after = await readDurable();
      if (JSON.stringify(after) !== JSON.stringify(durable)) throw Error("Diagnostic memory tail changed the primary catalog or pause state");
    }
    const expectedHeaps = 5 + (startupWorkerHeaps ? 1 : 0) + 2 + (postStopHeapGc ? 2 : 0);
    if (heapSamples.length !== expectedHeaps || heapSamples.some(row => !row.main || row.workers.some(worker => worker.error))) {
      throw Error("Diagnostic memory-tail heap evidence incomplete");
    }
  }
  if (errors.length) throw Error(errors.join("\n"));
  if (startupBufferGc && (startupBufferSamples.length !== 1 || startupBufferSamples[0].error)) {
    throw Error("Startup buffer GC diagnostic did not capture its exact boundary");
  }
  if (startupWorkerHeaps && heapSamples.filter(sample => sample.stage === "before-macro-initialize").length !== 1) {
    throw Error("Startup Worker diagnostic did not capture its exact boundary");
  }
  if (mainHeapSnapshot && !mainHeapSnapshotResult?.complete) throw Error("Private main heap snapshot did not complete");
  if (runtimeRetention && retentionSamples.length !== (startupWorkerHeaps ? 6 : 5) + (postStopMemoryTail ? 2 : 0)) throw Error("Runtime retention diagnostic stages incomplete");
  if (handoffProgress) {
    if (!trace.handoff?.length || trace.handoffCapped) throw Error("Handoff progress diagnostic missing or truncated");
    for (const phase of ["starting", "stopping"]) {
      const rows = trace.handoff.filter((row) => row.phase === phase);
      if (!rows.some((row) => Number.isFinite(row.durationMs) && Number.isFinite(row.compressionDurationMs)) ||
        !rows.some((row) => row.name === "authoritative-save-persistence" && row.ok === true &&
          Number.isFinite(row.workerDecodeMs) && Number.isFinite(row.idbWriteMs) && Number.isFinite(row.backupVerifyMs)) ||
        rows.some((row) => row.failed || row.ok === false)) {
        throw Error(`Handoff progress diagnostic incomplete or failed: ${phase}`);
      }
    }
  }
  const evidence = { browser: await browser.version(), supply, observationSeconds: seconds,
    profiled: Boolean(options.profile) || Boolean(timelinePhase) || workerHeapMemory || postStopMemoryTail || postStopHeapGc || workerHeapGc || mainHeapAllocations || mainHeapSnapshot || runtimeRetention || runtimeTransitions || styleReadDiagnostics || handoffProgress,
    profilePhase, timelinePhase, backgroundPresentationExperiment,
    postStopObservationSeconds: postStopSeconds, postStopMemoryTail, postStopHeapGc, allProcessMemory, workerHeapMemory, workerHeapGc, mainHeapAllocations, mainHeapSnapshot, mainHeapSnapshotResult, runtimeRetention, retentionSamples, runtimeTransitions, runtimeTransitionEvidence, heapSamples,
    engineProfiled: Boolean(options["engine-profile"]), idbOperations, startupBufferGc, startupBufferSamples, startupWorkerHeaps,
    retainedNormalDebt: Boolean(options["retain-debt"]), styleReadDiagnostics, handoffProgress,
    seeded, warmup, startMs, stopMs, visibleSummary, trace, processSamples, durable, geometryBeforeStop, geometryAfterStop };
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ supply, stopMs, events: trace.events.filter((event) => event.summary),
    runningMaxFrameGap: Math.max(0, ...trace.frames.filter((frame) => frame.phase === "running").map((frame) => frame.gap)) }, null, 2));
} catch (error) {
  primaryFailed = true;
  let diagnostic;
  try { diagnostic = await bounded(page.evaluate(() => ({ text: document.body.innerText.slice(0, 5000),
    notice: document.querySelector(".game-notice")?.textContent,
    inspector: document.querySelector(".time-warp-inspector")?.textContent,
    trace: globalThis.__LIVE_RUNTIME_TRACE__ }))); } catch { diagnostic = null; }
  await writeFile(resolve(output, `${name}-failure.json`), JSON.stringify({ error: String(error), errors, diagnostic }, null, 2));
  try { await bounded(page.screenshot({ path: resolve(output, `${name}-failure.png`) })); } catch { /* renderer may be unavailable */ }
  throw error;
} finally {
  let timelineFailure;
  let profilerFailure;
  if (timelineSession) {
    try {
      await bounded(timelineSession.send("Tracing.end"), 10_000);
      const complete = await bounded(timelineComplete, 10_000);
      if (complete.dataLossOccurred || !complete.stream) throw Error("Browser timeline lost events or returned no stream");
      const path = resolve(output, `${name}-timeline.json`);
      await writeFile(path, "");
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await bounded(timelineSession.send("IO.read", { handle: complete.stream, size: 1_048_576 }), 10_000);
          const data = chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : Buffer.from(chunk.data);
          bytes += data.length;
          if (bytes > 128 * 1_048_576) throw Error("Browser timeline exceeded diagnostic size limit");
          await appendFile(path, data);
          if (chunk.eof) break;
        }
      } finally { await bounded(timelineSession.send("IO.close", { handle: complete.stream })); }
      await writeFile(resolve(output, `${name}-timeline-metadata.json`), JSON.stringify({ ...timelineTiming, bytes,
        dataLossOccurred: complete.dataLossOccurred, scope: "Diagnostic timeline only; not unprofiled performance qualification" }, null, 2));
    } catch (error) {
      timelineFailure = error;
      await writeFile(resolve(output, `${name}-timeline-error.json`), JSON.stringify({ error: String(error) }));
    }
  }
  if (profiler) {
    try {
      const beforeMs = await bounded(page.evaluate(() => performance.now() - globalThis.__LIVE_RUNTIME_TRACE__.startedAt));
      const capture = await bounded(profiler.send("Profiler.stop"));
      const afterMs = await bounded(page.evaluate(() => performance.now() - globalThis.__LIVE_RUNTIME_TRACE__.startedAt));
      profilerTimeline = { ...profilerTimeline, phase: profilePhase, stopTraceBeforeMs: beforeMs, stopTraceAfterMs: afterMs };
      await writeFile(resolve(output, `${name}.cpuprofile`), JSON.stringify(capture.profile));
    } catch (error) {
      profilerFailure = error;
      await writeFile(resolve(output, `${name}-profile-error.json`), JSON.stringify({ error: String(error) }));
    }
    if (profilerTimeline) await writeFile(resolve(output, `${name}-profile-timeline.json`), JSON.stringify(profilerTimeline, null, 2));
  }
  if (allocationSession) await allocationSession.detach().catch(() => {});
  await browser.close();
  if (timelineFailure && !primaryFailed) throw timelineFailure;
  if (profilerFailure && !primaryFailed) throw profilerFailure;
}
