import { chromium } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const options = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split(/=(.*)/s, 2)));
const base = new URL(options.url ?? "http://127.0.0.1:4375");
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") throw new Error("This fixture writer only runs on localhost");
const action = options.action ?? "slot";
if (!["slot", "snapshot"].includes(action)) throw new Error("Unknown save action");
if (options.transport && !["raw", "gzip"].includes(options.transport)) throw new Error("Unknown transport experiment");
if (options.hash && options.profile) throw new Error("Hash verification closes the profiled page; run it separately");
const output = resolve(options.output ?? "artifacts/web-save-checkpoints");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true,
  args: options.diagnostic ? ["--enable-logging", `--log-file=${resolve(output, `${options.name ?? action}.chrome.log`)}`] : [],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
let page;
let profiler;
const pageErrors = [];
const processSamples = [];
const bounded = (promise, milliseconds = 5000) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error("diagnostic timeout")), milliseconds)),
]);
async function sampleProcesses(stage) {
  if (!options.diagnostic) return;
  try {
    const session = await bounded(browser.newBrowserCDPSession());
    const { processInfo } = await bounded(session.send("SystemInfo.getProcessInfo"));
    const ids = processInfo.filter((item) => item.type === "renderer").map((item) => item.id);
    const memory = process.platform === "win32" && ids.length ? JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`], { encoding: "utf8" }) || "null") : null;
    processSamples.push({ stage, processInfo, memory });
    await session.detach();
    await writeFile(resolve(output, `${options.name ?? action}-processes.json`), JSON.stringify(processSamples, null, 2));
  } catch { /* diagnostics must not change the save result */ }
}
context.on("page", (created) => {
  created.setDefaultTimeout(Number(options.timeout ?? 120_000));
  created.on("pageerror", (error) => { pageErrors.push(error.message); console.log(`Page error: ${error.message}`); });
  created.on("crash", () => { pageErrors.push("Isolated page crashed"); console.log("Isolated page crashed"); });
});
try {
  await context.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated performance run"}' }));
  await context.addInitScript(({ captureWorkerTimings, transportExperiment }) => {
    if (location.hostname !== "127.0.0.1") return;
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-10-26-v1.3.1");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    const trace = { active: false, startedAt: 0, calls: [], frames: [], tasks: [], phases: [] };
    globalThis.__SAVE_CHECKPOINT_TRACE__ = trace;
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        const name = options?.name ?? String(url).split("/").at(-1);
        const experimentUrl = transportExperiment && name === "authoritative-save-serialization"
          ? URL.createObjectURL(new Blob([
              `import ${JSON.stringify(new URL(url, location.href).href)};\n`,
              transportExperiment === "raw" ? "globalThis.CompressionStream = undefined;" : "",
            ], { type: "text/javascript" })) : null;
        super(experimentUrl ?? url, options);
        if (experimentUrl) this.addEventListener("message", () => URL.revokeObjectURL(experimentUrl), { once: true });
        if (captureWorkerTimings && (name === "authoritative-save-serialization" || name === "authoritative-save-persistence")) {
          this.addEventListener("message", (event) => {
            if (!trace.active) return;
            const data = event.data;
            const proof = data?.result?.proof;
            // Retain only scalar diagnostics, never returned payload buffers.
            trace.phases.push({ name, atMs: performance.now() - trace.startedAt, type: data?.type,
              stage: data?.progress?.stage, durationMs: data?.durationMs,
              compressionDurationMs: data?.compressionDurationMs,
              rawBytes: data?.proof?.byteLength, transferredBytes: data?.proof?.storedByteLength,
              workerDecodeMs: proof?.workerDecodeMs, idbWriteMs: proof?.idbWriteMs,
              backupVerifyMs: proof?.backupVerifyMs });
          });
        }
        const original = this.postMessage.bind(this);
        this.postMessage = (message, transfers = []) => {
          const started = performance.now();
          try { return original(message, transfers); }
          finally {
            if (trace.active) trace.calls.push({ name, type: message?.type ?? "serialize",
              duration: performance.now() - started, entities: message?.state?.entities?.length ?? null,
              transferred: Array.isArray(transfers) ? transfers.length : null,
              ...(captureWorkerTimings ? { atMs: started - trace.startedAt } : {}) });
          }
        };
      }
    };
    let last = performance.now();
    function frame() {
      const now = performance.now();
      if (trace.active) trace.frames.push(now - last);
      last = now;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    new PerformanceObserver((list) => {
      if (trace.active) for (const entry of list.getEntries()) trace.tasks.push(entry.duration);
    }).observe({ type: "longtask" });
  }, { captureWorkerTimings: Boolean(options["worker-timings"]), transportExperiment: options.transport ?? null });
  page = await context.newPage();
  console.log("Preparing isolated IndexedDB save");
  await page.goto(new URL("/icon.svg", base).href);
  const seeded = await page.evaluate(async () => {
    await import("/@vite/env");
    const storage = await import("/src/game/storage.ts");
    const store = await import("/src/game/localSaveStore.ts");
    await store.initializeLocalSaveStore();
    const state = (await (await fetch("/__save_performance_fixture__")).json()).state;
    state.paused = true;
    state.timeWarp.enabled = false;
    state.timeWarp.pendingSimulationSeconds = 0;
    state.timeWarp.pendingWallSeconds = 0;
    state.settings.autosaveIntervalSeconds = 0;
    const result = await storage.saveGameVerified(state, undefined, undefined, { preferWorkerProof: true });
    if (!result.success) throw new Error(result.message);
    return { entities: state.entities.length, belts: state.belts.length, checksum: store.getLocalSaveCatalog("dsp-idle-network.save.v1")?.stateChecksum };
  });
  await sampleProcesses("seed complete");
  const sessionEntries = await page.evaluate(() => {
    // Preserve the same document-transition marker as a real same-tab reload.
    // The preparation realm is then destroyed before measuring the game.
    window.dispatchEvent(new Event("beforeunload"));
    return Object.entries(sessionStorage);
  });
  await page.close();
  page = await context.newPage();
  await page.addInitScript((entries) => { for (const [key, value] of entries) sessionStorage.setItem(key, value); }, sessionEntries);
  console.log(`Loading actual game: ${seeded.entities} entities, ${seeded.belts} belts`);
  if (options.profile) {
    profiler = await page.context().newCDPSession(page);
    await profiler.send("Profiler.enable");
    await profiler.send("Profiler.start");
  }
  const gameUrl = new URL("/?factory=1&storageMigration=production", base);
  if (options.production) gameUrl.searchParams.set("performanceProduction", "1");
  await page.goto(gameUrl.href, { waitUntil: "domcontentloaded" });
  await page.locator(".game-shell").waitFor();
  console.log("Factory shell mounted");
  await sampleProcesses("factory mounted");
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.count()) await onboarding.first().click();
  await page.getByLabel("打开设置", { exact: true }).click({ noWaitAfter: true });
  console.log("Settings click dispatched");
  await sampleProcesses("settings click");
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档", exact: true }).click();
  console.log("Save workspace ready");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const trace = globalThis.__SAVE_CHECKPOINT_TRACE__;
    trace.calls = []; trace.frames = []; trace.tasks = []; trace.phases = [];
    trace.startedAt = performance.now(); trace.active = true;
  });
  console.log(`Measuring ${action} action`);
  if (action === "slot") {
    await operations.getByLabel("保存到槽位 1", { exact: true }).click({ noWaitAfter: true });
    await operations.locator(".save-slot--occupied").filter({ hasText: "本地槽位 1" }).waitFor();
  } else {
    await operations.getByRole("button", { name: "创建快照", exact: true }).click({ noWaitAfter: true });
    await operations.locator(".save-snapshot-row").filter({ hasText: "手动快照" }).waitFor();
  }
  const result = await page.evaluate(async (action) => {
    const trace = globalThis.__SAVE_CHECKPOINT_TRACE__;
    trace.active = false;
    const durationMs = performance.now() - trace.startedAt;
    // Read only small durable sidecars. Importing the development store here
    // would create a second writer module alongside the production bundle.
    const request = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const db = await request(indexedDB.open("dsp-idle-network.local-saves"));
    const keys = await request(db.transaction("records").objectStore("records").getAllKeys());
    const key = action === "slot" ? "dsp-idle-network.slot.1" : keys.find((key) => key.startsWith("dsp-idle-network.save.v1.snapshot.") && !key.endsWith(".sequence"));
    const readCatalog = async (key) => {
      const record = await request(db.transaction("records").objectStore("records").get(`dsp-idle-network.local-save.catalog.v1.${encodeURIComponent(key)}`));
      return record ? JSON.parse(record.value) : null;
    };
    const catalog = key ? await readCatalog(key) : null;
    const primary = await readCatalog("dsp-idle-network.save.v1");
    db.close();
    return { durationMs, maxFrameGapMs: Math.max(0, ...trace.frames),
      longTasks: trace.tasks, workerCalls: trace.calls, phaseTimings: trace.phases, catalog,
      primary, shell: {
        worker: document.querySelector(".game-shell")?.getAttribute("data-simulation-worker"),
      }, appAssets: [...document.querySelectorAll('script[type="module"][src]')].map((script) => script.getAttribute("src")) };
  }, action);
  if (result.catalog?.integrity !== "valid" || result.catalog.entityCount !== seeded.entities || result.catalog.beltCount !== seeded.belts) throw new Error("Missing or invalid durable auxiliary-save catalog");
  if (result.primary?.stateChecksum !== seeded.checksum) throw new Error("Auxiliary save changed the primary save");
  await sampleProcesses("save complete");
  if (options.hash) {
    // Verify the complete persisted state only after measuring and destroying
    // the factory page. This extra parse must not inflate its timing or peak.
    await page.close();
    page = await context.newPage();
    await page.goto(new URL("/icon.svg", base).href);
    result.stateVerification = await page.evaluate(async (key) => {
      const request = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const db = await request(indexedDB.open("dsp-idle-network.local-saves"));
      const record = await request(db.transaction("records").objectStore("records").get(key));
      db.close();
      const state = JSON.parse(record.value).state;
      const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((v) => v.toString(16).padStart(2, "0")).join("");
      const canonicalJson = (value) => JSON.stringify(value, (_key, item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const sorted = Object.create(null);
        for (const key of Object.keys(item).sort()) sorted[key] = item[key];
        return sorted;
      });
      const encoder = new TextEncoder();
      const bytes = encoder.encode(JSON.stringify(state));
      const digest = await sha256(bytes);
      const fields = {};
      for (const key of Object.keys(state).sort()) fields[key] = await sha256(encoder.encode(canonicalJson(state[key])));
      return { stateBytes: bytes.byteLength, sha256: digest,
        canonicalFieldsSha256: await sha256(encoder.encode(JSON.stringify(fields))), fields };
    }, result.catalog.key);
  }
  await writeFile(resolve(output, `${options.name ?? action}.json`), JSON.stringify({ action, transportExperiment: options.transport ?? null, browser: await browser.version(), seeded, ...result }, null, 2) + "\n");
  console.log(JSON.stringify({ action, durationMs: result.durationMs, maxFrameGapMs: result.maxFrameGapMs,
    workerCalls: result.workerCalls, checksum: result.catalog?.stateChecksum }, null, 2));
} catch (error) {
  let processInfo;
  try {
    const browserCdp = await bounded(browser.newBrowserCDPSession());
    const info = await bounded(browserCdp.send("SystemInfo.getProcessInfo"));
    processInfo = info.processInfo;
    const ids = processInfo.filter((item) => item.type === "renderer").map((item) => item.id);
    if (process.platform === "win32" && ids.length) processInfo = { cpu: processInfo,
      memory: JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
        `Get-Process -Id ${ids.join(",")} | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`], { encoding: "utf8" })) };
  } catch { /* keep the original timeout */ }
  if (profiler) {
    // Only after this isolated test has failed: interrupt its stuck script to
    // retrieve a profile before destroying the temporary browser context.
    try { await bounded(profiler.send("Runtime.terminateExecution")); } catch { /* best effort */ }
    try {
      const capture = await bounded(profiler.send("Profiler.stop"));
      await writeFile(resolve(output, `${options.name ?? action}.cpuprofile`), JSON.stringify(capture.profile));
      profiler = null;
    } catch { /* final cleanup retries */ }
  }
  let state;
  try { state = await bounded(page.evaluate(() => ({ text: document.body.innerText.slice(0, 1000),
    loading: document.querySelectorAll(".workspace-loading").length, shell: document.querySelectorAll(".game-shell").length }))); }
  catch { state = { unavailable: true }; }
  await writeFile(resolve(output, `${options.name ?? action}-failure.json`), JSON.stringify({ error: String(error), pageErrors, processInfo, state }, null, 2));
  throw error;
} finally {
  if (profiler) {
    try {
      const capture = await bounded(profiler.send("Profiler.stop"));
      await writeFile(resolve(output, `${options.name ?? action}.cpuprofile`), JSON.stringify(capture.profile));
    } catch { /* preserve the primary failure */ }
  }
  await browser.close();
}
