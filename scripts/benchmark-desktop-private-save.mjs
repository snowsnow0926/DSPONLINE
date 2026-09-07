/** Opt-in private normal-save import/return diagnostic. Keep the two scopes separate.
 * Usage: node scripts/benchmark-desktop-private-save.mjs --fixture <read-only.json>
 *   --package-root <release-performance-edition> --output-dir <new-private-directory>
 *   [--skip-offline] [--source-sha <trusted-40-character-commit>]
 *   [--resume-profile <closed-private-profile> --offline-seconds <seconds>]
 * Raw saves stay in the source file and a fresh private Electron profile. No screenshots,
 * traces, video, console text, response bodies or exception messages are recorded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { _electron as electron } from "@playwright/test";

const require = createRequire(import.meta.url);
const { verifyDesktopBuildEvidence, digestFile } = require("../desktop/desktop-artifact-evidence.cjs");
const { PERFORMANCE_EDITION_IDENTITY: identity } = require("../desktop/performance-edition-identity.cjs");
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === "--skip-offline") args.set(key, true);
  else if (["--fixture", "--package-root", "--output-dir", "--source-sha", "--resume-profile", "--offline-seconds"].includes(key) && process.argv[i + 1]) args.set(key, process.argv[++i]);
  else { console.error("Invalid arguments; see the usage comment in this driver."); process.exit(2); }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, child, page, output, source, liveTimer, outputCreated = false, phase = "preflight";
const report = { scope: args.has("--resume-profile") ? "return" : "import", status: "FAILED", clock: args.has("--skip-offline") ? "real-with-ui-skip" : "page-fixed-source-savedAt", workerEvents: [] };
const mark = value => { phase = value; console.log(JSON.stringify({ phase })); };
async function normalClose() {
  if (report.normalClose) return;
  if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error("unexpected-prior-exit");
  if (page && !page.isClosed()) await page.evaluate(() => { if (window.__dspPrivateOriginalDate) window.Date = window.__dspPrivateOriginalDate; });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  for (let i = 0; i < 250 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (child.exitCode !== 0) throw new Error("normal-close-failed");
  report.normalClose = true;
}
try {
  if (!["--fixture", "--package-root", "--output-dir"].every(key => typeof args.get(key) === "string")) throw new Error("missing-arguments");
  const fixture = path.resolve(args.get("--fixture")), packageRoot = path.resolve(args.get("--package-root"));
  output = path.resolve(args.get("--output-dir"));
  if (output === fixture || output === packageRoot || output.startsWith(packageRoot + path.sep)) throw new Error("invalid-output-location");
  fs.mkdirSync(output, { recursive: false });
  outputCreated = true;
  const sourceSha = args.get("--source-sha") ?? "4b13948c8d6d20165af29fe339ebb762817e35f8";
  const expected = { version: "1.2.7", sourceSha, buildId: `1.2.7+${sourceSha.slice(0, 12)}`, editionId: identity.editionId, channel: "beta" };
  const verified = verifyDesktopBuildEvidence(packageRoot, { expected, identity, requireOffline: true });
  report.package = { ...expected, files: verified.evidence.files.map(({ path: name, sha256, size }) => ({ name, sha256, bytes: size })) };
  source = (() => {
    const stat = fs.statSync(fixture), bytes = fs.readFileSync(fixture);
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.formatVersion !== 2 || value.state?.version !== 47 || value.mode !== 'normal' || value.state.mode !== 'normal' || !Number.isSafeInteger(value.savedAt) || value.savedAt < 0) throw new Error("unsupported-fixture");
    return { bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: createHash("sha256").update(bytes).digest("hex"), savedAt: value.savedAt };
  })();
  report.source = source;
  report.driverSha256 = digestFile(new URL(import.meta.url));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dspidle-performance-smoke-"));
  if (args.has("--resume-profile")) {
    const seedProfile = fs.realpathSync(args.get("--resume-profile"));
    if (path.dirname(seedProfile).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase() || !path.basename(seedProfile).startsWith("dspidle-performance-smoke-")) throw new Error("only-private-test-profiles-may-be-cloned");
    fs.cpSync(seedProfile, profile, { recursive: true, force: false, errorOnExist: true });
    report.seedPrivateProfile = seedProfile;
  }
  report.privateProfile = profile;
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "Path", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "COMSPEC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.DSP_PERFORMANCE_SMOKE_ISOLATION = "1"; env.DSP_PERFORMANCE_SMOKE_APP_DATA_ROOT = profile;
  mark("launch");
  const packageDirectory = path.join(packageRoot, "win-unpacked");
  app = await electron.launch({ executablePath: path.join(packageDirectory, "dsp-idle-performance-edition.exe"), cwd: packageDirectory, env, timeout: 60_000 });
  child = app.process(); // Capture once: process() can throw after Electron has already exited.
  page = await app.firstWindow(); page.setDefaultTimeout(240_000);
  report.rendererErrors = 0; page.on("pageerror", () => report.rendererErrors++);
  if (!/app\.asar\/dist\/index\.html/.test(page.url())) throw new Error("unexpected-entrypoint");
  report.networkPolicy = await app.evaluate(() => globalThis.__dspIsolatedNetworkAudit?.policy);
  if (report.networkPolicy !== "loopback-only-v1") throw new Error("isolation-unavailable");
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
  await page.bringToFront();
  await page.locator(".start-menu").waitFor();
  for (const name of ["我知道了", /^(?:关闭|跳过)启动引导$/]) { const button = page.getByRole("button", { name }); if (await button.isVisible()) await button.click(); }
  await page.evaluate(() => {
    window.__dspPrivateOriginalDate = Date;
    window.__dspPrivateMetrics = { events: [], dropped: 0, longTasks: [] };
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__dspPrivateMetrics.longTasks.push(entry.duration);
    }).observe({ type: 'longtask' });
    window.__DSP_RUNTIME_TRANSITIONS__ = { enabled: true, events: [], active: {}, counters: {} };
    const names = new Set(["save-inspection", "offline-simulation", "save-serialization", "save-snapshot-rewrap", "authoritative-save-persistence", "runtime-recovery-persistence"]);
    const record = (name, direction, data, extra = {}) => {
      const row = { name, direction, at: performance.now(), ...extra };
      for (const key of ["id", "seconds", "wallSeconds", "deadlineMs", "durationMs", "byteLength", "wallClockMs"]) if (Number.isFinite(data?.[key])) row[key] = data[key];
      for (const key of ["type", "phase"]) if (typeof data?.[key] === "string" && /^[a-z-]{1,40}$/.test(data[key])) row[key] = data[key];
      if (typeof data?.summary?.stateChecksum === "string") row.stateChecksum = data.summary.stateChecksum;
      if (data?.inspection) row.inspectionValid = data.inspection.valid === true;
      const proof = data?.result?.proof;
      if (proof) for (const key of ["workerDecodeMs", "idbWriteMs", "backupVerifyMs", "savedAt", "revision"]) if (Number.isFinite(proof[key])) row[key] = proof[key];
      if (data?.result) row.ok = data.result.ok === true;
      if (window.__dspPrivateMetrics.events.length < 2_000) window.__dspPrivateMetrics.events.push(row); else window.__dspPrivateMetrics.dropped++;
    };
    window.Worker = new Proxy(Worker, { construct(Target, args) {
      const worker = Reflect.construct(Target, args), name = args[1]?.name;
      if (names.has(name)) {
        const original = worker.postMessage;
        worker.postMessage = function(...values) { const started = performance.now(); record(name, "send", values[0]); const result = Reflect.apply(original, this, values); record(name, "sent", values[0], { dispatchMs: performance.now() - started }); return result; };
        worker.addEventListener("message", event => record(name, "receive", event.data));
      }
      return worker;
    } });
  });
  liveTimer = setInterval(async () => {
    try {
      const observed = await page.evaluate(() => ({
        recentEvents: window.__dspPrivateMetrics?.events.slice(-6),
        menu: !!document.querySelector('.start-menu'),
        worker: document.querySelector('.game-shell')?.getAttribute('data-simulation-worker'),
        offlineProgress: !!document.querySelector('.start-menu-offline-progress'),
        menuInert: !!document.querySelector('.start-menu')?.closest('[inert], [aria-hidden="true"]'),
        announcement: [...document.querySelectorAll('button')].some(button => button.textContent === '我知道了' && button.getBoundingClientRect().width > 0),
      }));
      fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify({ phase, observed }, null, 2));
    } catch { /* A closing page cannot provide progress. */ }
  }, 15_000);
  let checkpointSavedAt = source.savedAt;
  if (args.has("--resume-profile")) {
    report.seedRevision = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open("dsp-idle-network.local-saves", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("read-failed")); request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error("missing-database")); }; });
      try {
        const value = await new Promise((resolve, reject) => { const request = db.transaction("records", "readonly").objectStore("records").get(`dsp-idle-network.local-save-coordination.v1.revision.${encodeURIComponent("dsp-idle-network.save.v1")}`); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("read-failed")); });
        const revision = JSON.parse(value.value);
        return { revision: revision.revision, savedAt: revision.savedAt, stateChecksum: revision.checksum };
      } finally { db.close(); }
    });
    const seconds = Number(args.get("--offline-seconds"));
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30 * 86400) throw new Error("invalid-offline-duration");
    report.offlineSeconds = seconds;
    checkpointSavedAt = report.seedRevision.savedAt + seconds * 1000;
  }
  if (!args.has("--skip-offline")) await page.clock.setFixedTime(checkpointSavedAt);
  mark(args.has("--resume-profile") ? "continue-game" : "file-selection");
  const started = await page.evaluate(() => performance.now());
  if (args.has("--resume-profile")) {
    await page.getByRole("button", { name: /^恢复最近工厂\s*继续游戏$/ }).click();
  } else {
  await page.getByLabel("选择存档文件", { exact: true }).setInputFiles(fixture);
  mark("file-inspection");
  const confirm = page.getByRole("button", { name: "确认导入并进入", exact: true });
  // Startup notices load asynchronously and may appear during the inspection.
  // Close them through their real UI before querying the inert background.
  const notes = page.getByRole("button", { name: "我知道了", exact: true });
  const intro = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  for (let attempt = 0; attempt < 3; attempt++) {
    await confirm.or(notes).or(intro).first().waitFor({ timeout: 60_000 });
    if (await notes.isVisible()) await notes.click();
    else if (await intro.isVisible()) await intro.click();
    else break;
  }
  await confirm.waitFor({ timeout: 60_000 });
  report.inspectionReadyMs = await page.evaluate(start => performance.now() - start, started);
  mark("import-and-enter");
  await confirm.click();
  }
  if (args.has("--skip-offline")) {
    const shell = page.locator('.game-shell[data-simulation-worker="active"]');
    const choice = page.getByRole("dialog", { name: "选择离线结算方式" });
    const outcome = await Promise.race([shell.waitFor().then(() => "shell"), choice.waitFor().then(() => "choice")]);
    if (outcome === "choice") { await choice.getByRole("button", { name: /放弃离线收益/ }).click(); await page.getByRole("button", { name: "再次确认：收益为 0", exact: true }).click(); }
  }
  const activeShell = page.locator('.game-shell[data-simulation-worker="active"]');
  if (args.has("--resume-profile")) {
    mark("offline-settlement");
    const recovery = page.getByRole("button", { name: "恢复检查点并快速结算", exact: true });
    const fast = page.getByRole("button", { name: /^快速结算/ });
    const decision = page.getByRole("dialog", { name: "快速结算需要玩家选择" })
      .or(page.getByRole("alertdialog", { name: "快速结算需要玩家选择" }));
    for (let attempt = 0; attempt < 3; attempt++) {
      await activeShell.or(recovery).or(fast).or(decision).first().waitFor();
      if (await decision.isVisible()) { report.offlineOutcome = "decision-required"; throw new Error("decision-required"); }
      if (await activeShell.isVisible()) break;
      if (await recovery.isVisible()) { report.checkpointRecoverySelected = true; await recovery.click(); }
      else await fast.click();
    }
  }
  await activeShell.waitFor();
  const settlement = page.getByRole("button", { name: "确认结算", exact: true });
  if (await settlement.isVisible()) await settlement.click();
  await page.getByLabel("打开设置", { exact: true }).click();
  await page.getByRole("dialog", { name: "运营中心" }).waitFor();
  report.importToInteractiveMs = await page.evaluate(start => performance.now() - start, started);
  if (args.has("--resume-profile")) { report.returnToInteractiveMs = report.importToInteractiveMs; delete report.importToInteractiveMs; }
  const metrics = await page.evaluate(() => window.__dspPrivateMetrics);
  report.workerEvents = metrics.events; report.droppedWorkerEvents = metrics.dropped;
  report.mainThreadLongTasks = { count: metrics.longTasks.length, maxMs: Math.max(0, ...metrics.longTasks), totalMs: metrics.longTasks.reduce((total, duration) => total + duration, 0) };
  mark("read-only-persisted-identity");
  report.persisted = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("dsp-idle-network.local-saves", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("read-failed")); request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error("missing-database")); }; });
    try {
      const key = "dsp-idle-network.save.v1", tx = db.transaction("records", "readonly");
      const read = key => new Promise((resolve, reject) => { const request = tx.objectStore("records").get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("read-failed")); });
      const [primary, receipt] = await Promise.all([read(key), read(`dsp-idle-network.local-save-coordination.v1.revision.${encodeURIComponent(key)}`)]);
      if (typeof primary?.value !== "string" || !receipt?.value) throw new Error("missing-primary");
      const revision = JSON.parse(receipt.value);
      const hash = async text => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, "0")).join("");
      const sha256 = await hash(primary.value);
      const keys = await new Promise((resolve, reject) => { const request = db.transaction('records', 'readonly').objectStore('records').getAllKeys(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('read-failed')); });
      const snapshotKey = keys.filter(key => typeof key === 'string' && key.startsWith('dsp-idle-network.save.v1.snapshot.')).sort().at(-1);
      const snapshot = snapshotKey ? await new Promise((resolve, reject) => { const request = db.transaction('records', 'readonly').objectStore('records').get(snapshotKey); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('read-failed')); }) : null;
      const stateText = raw => {
        const prefix = /^\{"formatVersion":2,"kind":"(?:primary|snapshot)"(?:,"reason":"(?:[^"\\]|\\.)*")?,"savedAt":\d+,"mode":"normal","slot":"main","state":/.exec(raw)?.[0];
        const suffix = /,"checksum":"[a-f0-9]{8}"\}$/.exec(raw)?.[0];
        if (!prefix || !suffix) throw new Error('noncanonical-private-boundary');
        return raw.slice(prefix.length, -suffix.length);
      };
      const stateSha256 = await hash(stateText(primary.value));
      const snapshotStateSha256 = snapshot?.value ? await hash(stateText(snapshot.value)) : null;
      return { byteLength: new TextEncoder().encode(primary.value).byteLength, sha256, revision: revision.revision, stateChecksum: revision.checksum, stateSha256, snapshotStateSha256, snapshotMatchesPrimary: stateSha256 === snapshotStateSha256 };
    } finally { db.close(); }
  });
  if (report.scope === 'import' && !report.persisted.snapshotMatchesPrimary) throw new Error('automatic-snapshot-state-mismatch');
  mark("normal-close"); await normalClose();
  if (report.rendererErrors || report.droppedWorkerEvents) throw new Error("diagnostic-gate-failed");
  report.status = "PASS";
} catch {
  report.failurePhase = phase; process.exitCode = 1;
  if (page && !page.isClosed()) try {
    report.failureDiagnostics = await page.evaluate(() => {
      const notice = document.querySelector('.start-menu-message')?.textContent ?? '';
      return { metrics: window.__dspPrivateMetrics, errorNotice: !!document.querySelector('.start-menu-message--error'),
        invalidJson: /JSON/.test(notice), invalidChecksum: /校验失败/.test(notice), fileReadError: /读取失败|无法读取/.test(notice),
        unsafeQuantity: /安全整数|危险转换/.test(notice), missingPacks: /内容包/.test(notice),
        byteLimit: /256 MiB/.test(notice), invalidEncoding: /UTF-8/.test(notice),
        noticeHashInputLength: notice.length, fileSelected: !!document.querySelector('input[type="file"]')?.files?.length,
        menuVisible: !!document.querySelector('.start-menu'), shellPresent: !!document.querySelector('.game-shell') };
    });
  } catch { report.failureDiagnosticsUnavailable = true; }
} finally {
  clearInterval(liveTimer);
  if (child && child.exitCode === null && child.signalCode === null) {
    try { await normalClose(); } catch { spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" }); report.forcedFailureCleanup = true; }
  }
  if (source) {
    try { const fixture = path.resolve(args.get("--fixture")), stat = fs.statSync(fixture); report.sourceUnchanged = stat.size === source.bytes && stat.mtimeMs === source.mtimeMs && digestFile(fixture) === source.sha256; } catch { report.sourceUnchanged = false; }
    if (!report.sourceUnchanged) { report.status = "FAILED"; process.exitCode = 1; }
  }
  if (outputCreated) fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ scope: report.scope, status: report.status, failurePhase: report.failurePhase, inspectionReadyMs: report.inspectionReadyMs, importToInteractiveMs: report.importToInteractiveMs, sourceUnchanged: report.sourceUnchanged, normalClose: report.normalClose }));
}
