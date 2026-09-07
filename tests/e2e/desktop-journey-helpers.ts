import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type ElectronApplication, type Page, _electron as electron } from "@playwright/test";
import { connectBelt, createInitialState, placeBuilding, setEntityRecipe } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";
import { inspectSaveEnvelopeChecksum } from "../../src/game/saveEnvelopeIntegrity";

export const runDirectory = process.env.DSP_DESKTOP_JOURNEY_RUN_DIR!;
if (!runDirectory) throw new Error("BLOCKED: missing verified package run context");
export const run = JSON.parse(fs.readFileSync(path.join(runDirectory, "run-context.json"), "utf8"));
export const marker = "Round3 固定合成工厂 271828";
export const records: unknown[] = [];
const children = new WeakMap<ElectronApplication, ReturnType<ElectronApplication["process"]>>();
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixtureEnvelope() {
  let state = createInitialState();
  state.paused = true;
  state.settings.autosaveIntervalSeconds = 0;
  state.galaxy.planetMetadata.home = { customName: marker, note: "Synthetic; no real player data", tags: ["round3"] };
  state.tray.iron_ore = 12345;
  state.planetTrays.home = { ...state.tray };
  state.construction.arc_smelter = 8;
  state.construction.wind_turbine = 8;
  state.construction.conveyor_belt_mk1 = 20;
  state = placeBuilding(state, "arc_smelter", { x: 800, y: 300 });
  const machine = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
  state = setEntityRecipe(state, machine.id, "iron_ingot");
  state = connectBelt(state, "vein_iron", machine.id, "iron_ore");
  return serializeEnvelope(state, 1788739200000);
}
export const fixture = fixtureEnvelope();

export function productionFixture() {
  const state = inspectSaveEnvelopeChecksum(fixture).state! as any;
  state.entities = state.entities.filter((entity: any) => entity.kind === "vein");
  state.entities.find((entity: any) => entity.id === "vein_iron").outputs = { iron_ore: 50 };
  state.belts = [];
  return serializeEnvelope(state, 1788739200000);
}

export function factoryContent(raw: string) {
  const inspected = inspectSaveEnvelopeChecksum(raw);
  expect(inspected.status).toBe("valid");
  expect(inspected.formatVersion).toBe(2);
  const state = inspected.state!;
  expect(state.version).toBe(47);
  // Paused gameplay content is exact. Envelope timestamps, window layout and
  // recovery journals are separate lifecycle metadata, never inventory.
  return Object.fromEntries(["version", "mode", "activePlanetId", "entities", "belts", "tray", "planetTrays", "construction", "research", "galaxy", "dysonSphere", "dysonSwarm", "totalProduced", "elapsedSeconds", "constructionQueue", "handcraftQueue"].map((key) => [key, state[key]]));
}

export function profile() { return fs.mkdtempSync(path.join(os.tmpdir(), "dspidle-performance-smoke-")); }
export async function launch(profileRoot: string) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "Path", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "COMSPEC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.DSP_PERFORMANCE_SMOKE_ISOLATION = "1";
  env.DSP_PERFORMANCE_SMOKE_APP_DATA_ROOT = profileRoot;
  const app = await electron.launch({ executablePath: path.join(run.packageDirectory, "dsp-idle-performance-edition.exe"), cwd: run.packageDirectory, env, timeout: 60000 });
  children.set(app, app.process());
  try {
  const page = await app.firstWindow();
  page.on("console", (message) => { if (message.type() === "error") records.push({ event: "renderer-error", message: message.text() }); });
  expect(page.url()).toMatch(/app\.asar\/dist\/index\.html/);
  await expect(page.locator("html")).toHaveAttribute("data-app-platform", "desktop");
  expect(await page.evaluate(() => typeof (window as any).dspDesktop?.confirmClose)).toBe("function");
  records.push({ event: "launch", pid: app.process().pid, profileRoot, buildId: run.expected.buildId, url: page.url() });
  page.on("pageerror", (error) => records.push({ event: "pageerror", message: error.message }));
  app.process().stderr?.on("data", (bytes) => fs.appendFileSync(path.join(runDirectory, "electron-stderr.log"), bytes));
  expect(await app.evaluate(() => (globalThis as any).__dspIsolatedNetworkAudit?.policy)).toBe("loopback-only-v1");
  return { app, page };
  } catch (error) { await forceKill(app, "failure-cleanup"); throw error; }
}

async function dismissIntro(page: Page) {
  await expect(page.locator(".start-menu").or(page.locator(".game-shell"))).toBeVisible({ timeout: 30000 });
  const notes = page.getByRole("button", { name: "我知道了" });
  if (await notes.isVisible().catch(() => false)) await notes.click();
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.isVisible().catch(() => false)) await onboarding.click();
}
export async function enterNew(page: Page) {
  await dismissIntro(page);
  await page.getByRole("button", { name: /开始游戏|新建游戏/ }).first().click();
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 30000 });
  await dismissIntro(page);
}
export async function continueExisting(page: Page) {
  await dismissIntro(page);
  const conflict = page.getByRole("alert").filter({ hasText: "已阻止跨标签页覆盖" });
  await expect(conflict).toHaveCount(0);
  await page.getByRole("button", { name: /^恢复最近工厂\s*继续游戏$/ }).click();
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 30000 });
  await expect(conflict).toHaveCount(0);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-paused", "true");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-native-authority-mode", "unbound");
}
export async function saveTab(page: Page) {
  const operations = page.getByRole("dialog", { name: "运营中心" });
  if (!(await operations.isVisible())) await page.getByLabel("打开设置", { exact: true }).click();
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档", exact: true }).click();
  return operations;
}

export async function boundary(page: Page) {
  return page.evaluate(async () => {
    const key = "dsp-idle-network.save.v1";
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error("Missing existing save database")); };
    });
    try {
      const transaction = db.transaction("records", "readonly");
      const read = (name: string) => new Promise<any>((resolve, reject) => {
        const request = transaction.objectStore("records").get(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [primary, revision, lease] = await Promise.all([read(key), read(`dsp-idle-network.local-save-coordination.v1.revision.${encodeURIComponent(key)}`), read("dsp-idle-network.local-save-coordination.v1.writer-lease")]);
      return { raw: primary?.value as string | undefined, revision: revision ? JSON.parse(revision.value) : null, lease: lease ? JSON.parse(lease.value) : null };
    } finally { db.close(); }
  });
}
export async function saveAndVerify(page: Page) {
  const before = await boundary(page);
  const operations = await saveTab(page);
  await operations.getByRole("button", { name: "立即保存", exact: true }).click();
  await expect.poll(async () => (await boundary(page)).revision?.revision ?? 0, { timeout: 30000 }).toBeGreaterThan(before.revision?.revision ?? 0);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-persistence-phase", "complete", { timeout: 30000 });
  const saved = await boundary(page);
  assertSaveReceipt(before, saved);
  records.push({ event: "durable-save", revision: saved.revision, rawSha256: sha256(saved.raw!) });
  return saved;
}
export function assertSaveReceipt(before: { revision: any }, saved: { raw?: string; revision: any }) {
  expect(saved.revision.revision).toBeGreaterThan(before.revision?.revision ?? 0);
  expect(saved.raw).toBeTruthy();
  const inspected = inspectSaveEnvelopeChecksum(saved.raw!);
  expect(inspected.status).toBe("valid");
  expect(saved.revision.checksum).toBe(inspected.recordedChecksum);
}

// Delay the real persistence Worker before dispatch. Releasing calls the
// original postMessage with its original payload/transfers; no fake save ACK.
export async function holdNextPersistenceCommit(page: Page) {
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    const control = { held: 0, release: null as (() => void) | null };
    (window as any).__dspHeldCommit = control;
    Worker.prototype.postMessage = function(message: any, options?: any) {
      if (message?.type === "commit" && message.payload instanceof ArrayBuffer && control.held === 0) {
        control.held++;
        control.release = () => { Worker.prototype.postMessage = original; original.call(this, message, options); };
        return;
      }
      return original.call(this, message, options);
    };
  });
}
export async function importFixture(page: Page, label: string, raw = fixture, compressedSource?: string) {
  const input = path.join(runDirectory, `${label}.json${compressedSource ? ".gz" : ""}`);
  fs.writeFileSync(input, compressedSource ? fs.readFileSync(compressedSource) : raw, { flag: "wx" });
  const digest = sha256(fs.readFileSync(input));
  const operations = await saveTab(page);
  await operations.getByLabel("选择要导入的存档文件").setInputFiles(input);
  await expect(operations.locator(".save-import-preview")).toContainText("校验通过", { timeout: 30000 });
  await operations.locator(".save-import-preview").getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-paused", "true", { timeout: 30000 });
  await expect(page.getByText(marker, { exact: true }).first()).toBeVisible();
  const saved = await saveAndVerify(page);
  expect(factoryContent(saved.raw!)).toEqual(factoryContent(raw));
  expect(sha256(fs.readFileSync(input))).toBe(digest);
  return saved;
}
async function waitExit(app: ElectronApplication, mode: string) {
  const child = children.get(app)!;
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${mode} did not exit in 25 seconds`)), 25000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  records.push({ event: "exit", mode, pid: child.pid, code: child.exitCode, signal: child.signalCode });
  if (mode === "normal-window-close" && child.exitCode !== 0) throw new Error(`Normal close exited with ${child.exitCode}/${child.signalCode}`);
}
export async function normalClose(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitExit(app, "normal-window-close");
}
export async function forceKill(app: ElectronApplication, mode = "intentional-crash") {
  const child = children.get(app)!;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (mode !== "failure-cleanup") throw new Error("Process exited before intentional crash");
    return;
  }
  if (mode === "failure-cleanup") {
    try { await app.windows()[0]?.screenshot({ path: path.join(runDirectory, `failure-${child.pid}.png`), timeout: 3000 }); }
    catch { records.push({ event: "failure-screenshot-unavailable", pid: child.pid }); }
  }
  const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Failed to kill task PID ${child.pid}: ${result.status}`);
  await waitExit(app, mode);
}
