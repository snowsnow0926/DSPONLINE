import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const options = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)));
const base = new URL(options.url ?? "http://127.0.0.1:4375");
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") throw new Error("Only isolated loopback tests are allowed");
const supply = options.supply ?? "stock";
if (!["stock", "tray", "quantum"].includes(supply)) throw new Error("Unknown material variant");
const seconds = Number(options.seconds ?? 30);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120) throw new Error("Invalid observation window");
const output = resolve(options.output ?? "artifacts/web-live-runtime");
const name = options.name ?? `live-${supply}`;
if (!/^[a-z0-9-]+$/i.test(name)) throw new Error("Invalid evidence name");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
let page;
let profiler;
const errors = [];
const processSamples = [];
const bounded = (promise, ms = 5000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error("diagnostic timeout")), ms))]);

async function sampleProcesses(stage) {
  try {
    const session = await bounded(browser.newBrowserCDPSession());
    const { processInfo } = await bounded(session.send("SystemInfo.getProcessInfo"));
    const ids = processInfo.filter((item) => item.type === "renderer").map((item) => item.id);
    const memory = process.platform === "win32" && ids.length ? JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`], { encoding: "utf8" }) || "null") : null;
    processSamples.push({ stage, processInfo, memory });
    await session.detach();
    await writeFile(resolve(output, `${name}-processes.json`), JSON.stringify(processSamples, null, 2));
  } catch { /* process sampling must not change the game outcome */ }
}

try {
  await context.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated runtime test"}' }));
  await context.addInitScript(({ profileSteps }) => {
    if (location.hostname !== "127.0.0.1") return;
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-10-26-v1.3.1");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    const trace = { active: false, phase: "idle", startedAt: 0, lastElapsed: 0, frames: [], tasks: [], sends: [], events: [] };
    globalThis.__LIVE_RUNTIME_TRACE__ = trace;
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, workerOptions) {
        super(url, workerOptions);
        const name = workerOptions?.name ?? String(url).split("/").at(-1);
        const send = this.postMessage.bind(this);
        this.postMessage = (request, transfers = []) => {
          const start = performance.now();
          try { return send(profileSteps && name === "factory-simulation" && request.kind === "advance"
            ? { ...request, profile: true } : request, transfers); }
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
  }, { profileSteps: Boolean(options["engine-profile"]) });
  context.on("page", (opened) => {
    opened.setDefaultTimeout(120_000);
    opened.on("pageerror", (error) => { errors.push(error.message); console.log(`Page error: ${error.message}`); });
    opened.on("crash", () => { errors.push("isolated renderer crashed"); console.log("Isolated renderer crashed"); });
  });
  page = await context.newPage();
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
  if (options.profile) {
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
  await page.evaluate(() => { globalThis.__LIVE_RUNTIME_TRACE__.phase = "starting"; });
  console.log("Starting replication through the real UI");
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
  await sampleProcesses("replication ready");
  await page.evaluate(() => { globalThis.__LIVE_RUNTIME_TRACE__.phase = "running"; });
  console.log(`Observing ${seconds} seconds of active replication`);
  await page.waitForTimeout(seconds * 1000);
  const visibleSummary = (await overlay.innerText()).slice(0, 5000);
  await sampleProcesses("replication running");
  const beforeStop = await page.evaluate(() => globalThis.__LIVE_RUNTIME_TRACE__);
  await writeFile(resolve(output, `${name}-prestop.json`), JSON.stringify({ browser: await browser.version(), supply, seeded, trace: beforeStop, processSamples }));
  await page.evaluate(() => { globalThis.__LIVE_RUNTIME_TRACE__.phase = "stopping"; });
  const stopStarted = Date.now();
  console.log("Stopping replication and committing the verified checkpoint");
  await overlay.getByRole("button", { name: "停止并结算纯挂机", exact: true }).click({ noWaitAfter: true });
  await overlay.waitFor({ state: "hidden" });
  const stopMs = Date.now() - stopStarted;
  const trace = await page.evaluate(() => { const trace = globalThis.__LIVE_RUNTIME_TRACE__; trace.active = false; return trace; });
  await sampleProcesses("replication stopped");
  const durable = await page.evaluate(async () => {
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
  if (durable.catalog?.integrity !== "valid" || durable.catalog.entityCount !== seeded.entities ||
    durable.catalog.beltCount !== seeded.belts || durable.paused !== "true") throw Error("Invalid terminal checkpoint or pause restoration");
  if (durable.catalog.settings) {
    if (durable.catalog.settings.autosaveIntervalSeconds !== 0) throw Error("Automatic saving preference changed");
    for (const [key, value] of Object.entries(seeded.backupSettings)) {
      if (JSON.stringify(durable.catalog.settings[key]) !== JSON.stringify(value)) throw Error(`Backup preference changed: ${key}`);
    }
  }
  if (errors.length) throw Error(errors.join("\n"));
  const evidence = { browser: await browser.version(), supply, observationSeconds: seconds, profiled: Boolean(options.profile),
    engineProfiled: Boolean(options["engine-profile"]),
    retainedNormalDebt: Boolean(options["retain-debt"]),
    seeded, warmup, stopMs, visibleSummary, trace, processSamples, durable };
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ supply, stopMs, events: trace.events.filter((event) => event.summary),
    runningMaxFrameGap: Math.max(0, ...trace.frames.filter((frame) => frame.phase === "running").map((frame) => frame.gap)) }, null, 2));
} catch (error) {
  let diagnostic;
  try { diagnostic = await bounded(page.evaluate(() => ({ text: document.body.innerText.slice(0, 5000),
    notice: document.querySelector(".game-notice")?.textContent,
    inspector: document.querySelector(".time-warp-inspector")?.textContent,
    trace: globalThis.__LIVE_RUNTIME_TRACE__ }))); } catch { diagnostic = null; }
  await writeFile(resolve(output, `${name}-failure.json`), JSON.stringify({ error: String(error), errors, diagnostic }, null, 2));
  try { await bounded(page.screenshot({ path: resolve(output, `${name}-failure.png`) })); } catch { /* renderer may be unavailable */ }
  throw error;
} finally {
  if (profiler) {
    try { const capture = await bounded(profiler.send("Profiler.stop")); await writeFile(resolve(output, `${name}.cpuprofile`), JSON.stringify(capture.profile)); } catch { /* keep primary outcome */ }
  }
  await browser.close();
}
