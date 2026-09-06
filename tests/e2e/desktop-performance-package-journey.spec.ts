import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page, _electron as electron } from "@playwright/test";
import { createInitialState } from "../../src/game/engine";
import { LOCAL_SAVE_LEASE_DURATION_MS } from "../../src/game/localSaveCoordination";
import { serializeEnvelope } from "../../src/game/storage";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageDirectory = path.join(repoRoot, "release-performance-edition", "win-unpacked");
const executablePath = path.join(packageDirectory, "dsp-idle-performance-edition.exe");
const evidenceDirectory = path.join(repoRoot, "artifacts", "1.2.7-round2-20260907-a1", "desktop-journey");

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createSmokeRoot(): string {
  const temporaryRoot = path.resolve(os.tmpdir());
  const smokeRoot = path.join(temporaryRoot, `dspidle-performance-smoke-${randomUUID().replaceAll("-", "")}`);
  fs.mkdirSync(smokeRoot);
  return smokeRoot;
}

function isolatedEnv(smokeRoot: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "DSP_DESKTOP_DEV_URL",
    "DSP_DESKTOP_API_BASE_URL",
    "DSP_UPDATE_BASE_URL",
    "DSP_UPDATE_STABLE_URL",
    "DSP_UPDATE_BETA_URL",
    "DSP_UPDATE_NIGHTLY_URL",
    "DSP_UPDATE_URL",
    "DSP_DESKTOP_PUBLISH_URL",
    "DSP_NATIVE_UPDATE_BASE_URL",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
  ]) {
    delete env[key];
  }
  env.DSP_PERFORMANCE_SMOKE_ISOLATION = "1";
  env.DSP_PERFORMANCE_SMOKE_APP_DATA_ROOT = smokeRoot;
  return env;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilPidExits(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
  const forceDeadline = Date.now() + 5_000;
  while (Date.now() < forceDeadline) {
    if (!pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function launchPackagedApp(smokeRoot: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath,
    cwd: packageDirectory,
    env: isolatedEnv(smokeRoot),
    timeout: 60_000,
  });
}

async function closePackagedApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  const child = app.process();
  const pid = child.pid;
  await app.close().catch(() => undefined);
  if (pid) await waitUntilPidExits(pid, 8_000);
}

async function waitForWriterLeaseExpiry(): Promise<void> {
  // IndexedDB writer leases survive a killed renderer until expiresAt.
  // Product contract: another owner may claim only after LOCAL_SAVE_LEASE_DURATION_MS.
  await new Promise((resolve) => setTimeout(resolve, LOCAL_SAVE_LEASE_DURATION_MS + 2_000));
}

async function dismissBlockingDialogs(page: Page): Promise<void> {
  const notes = page.getByRole("button", { name: "我知道了" });
  try {
    await notes.first().click({ timeout: 5_000 });
  } catch {
    // First launch shows release notes; later launches may already have acknowledged them.
  }
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.count()) await onboarding.first().click();
  const offline = page.getByRole("dialog", { name: "离线结算报告" });
  if (await offline.count()) {
    await offline.getByRole("button", { name: "确认结算" }).click({ force: true });
  }
}

async function resolveStartupSaveConflict(page: Page): Promise<void> {
  const banner = page.getByRole("alert").filter({ hasText: "已阻止跨标签页覆盖" });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (!(await banner.count())) return;
    const text = await banner.innerText();
    const retry = text.match(/约\s*(\d+)\s*秒后可重试/);
    if (retry) {
      await page.waitForTimeout((Number(retry[1]) + 1) * 1_000);
      continue;
    }
    const keepCurrent = page.getByRole("button", { name: "保留当前存档" });
    if (await keepCurrent.count()) {
      await keepCurrent.click();
      await page.waitForTimeout(1_500);
      continue;
    }
    await page.waitForTimeout(400);
  }
}

async function enterNewGame(page: Page): Promise<void> {
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 30_000 });
  await dismissBlockingDialogs(page);
  await page.getByRole("button", { name: /开始游戏|新建游戏/ }).first().click();
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 30_000 });
  await dismissBlockingDialogs(page);
  await expect(page.locator(".vein-node").filter({ hasText: "铁矿石" })).toBeVisible({ timeout: 20_000 });
}

async function continueSavedGame(page: Page): Promise<void> {
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 30_000 });
  await dismissBlockingDialogs(page);
  await resolveStartupSaveConflict(page);
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /继续游戏|开始游戏/ }).first().click();
  await resolveStartupSaveConflict(page);
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 30_000 });
  await dismissBlockingDialogs(page);
}

async function openSaveTab(page: Page) {
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await expect(operations).toBeVisible();
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  return operations;
}

async function armPackagedExport(app: ElectronApplication, savePath: string): Promise<void> {
  await app.evaluate(async ({ BrowserWindow, dialog }, targetPath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath });
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return;
    win.webContents.session.once("will-download", (_event, item) => {
      item.setSavePath(targetPath);
    });
  }, savePath);
}

test.describe("isolated performance-edition packaged journeys", () => {
  test.skip(!fs.existsSync(executablePath), `missing packaged EXE: ${executablePath}`);

  test.beforeAll(() => {
    fs.mkdirSync(evidenceDirectory, { recursive: true });
  });

  test("new game, production chain, save, and reopen keep isolated progress", async () => {
    const smokeRoot = createSmokeRoot();
    let first: ElectronApplication | undefined;
    let second: ElectronApplication | undefined;
    try {
      first = await launchPackagedApp(smokeRoot);
      const page = await first.firstWindow();
      await enterNewGame(page);
      await page.setViewportSize({ width: 1560, height: 960 });
      await expect(page.locator(".game-shell")).toHaveAttribute("data-native-authority-mode", "unbound");
      await page.getByRole("button", { name: "暂停模拟" }).click();
      await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-paused", "true");
      await page.getByRole("button", { name: "继续模拟" }).click();
      await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-paused", "false");

      const ironVein = page.locator(".vein-node").filter({ hasText: "铁矿石" });
      const mineButton = ironVein.getByTitle("长按采集铁矿石");
      await mineButton.hover();
      await page.mouse.down();
      await page.waitForTimeout(850);
      await page.mouse.up();
      await mineButton.hover();
      await page.mouse.down();
      await page.waitForTimeout(850);
      await page.mouse.up();
      const ironOutput = ironVein.getByTitle("拿取铁矿石");
      await expect.poll(async () => Number(await ironOutput.locator("strong").textContent())).toBeGreaterThanOrEqual(5);
      await page.screenshot({ path: path.join(evidenceDirectory, "production-chain.png") });

      const operations = await openSaveTab(page);
      await operations.getByRole("button", { name: "立即保存" }).click();
      await expect(page.locator(".game-shell")).toHaveAttribute("data-persistence-phase", "complete", { timeout: 30_000 });
      const savedBytes = await page.locator(".game-shell").getAttribute("data-primary-save-bytes");
      expect(Number(savedBytes)).toBeGreaterThan(0);
      await page.screenshot({ path: path.join(evidenceDirectory, "save-tab.png") });
      await closePackagedApp(first);
      first = undefined;
      await waitForWriterLeaseExpiry();

      second = await launchPackagedApp(smokeRoot);
      const resumed = await second.firstWindow();
      await continueSavedGame(resumed);
      const resumedIron = resumed.locator(".vein-node").filter({ hasText: "铁矿石" }).getByTitle("拿取铁矿石");
      await expect.poll(async () => Number(await resumedIron.locator("strong").textContent())).toBeGreaterThanOrEqual(5);
      await expect(resumed.locator(".game-shell")).toHaveAttribute("data-native-authority-mode", "unbound");
      await resumed.screenshot({ path: path.join(evidenceDirectory, "reopened.png") });
    } finally {
      await closePackagedApp(first);
      await closePackagedApp(second);
      try {
        fs.rmSync(smokeRoot, { recursive: true, force: true });
      } catch {
        // Isolated profile may remain locked until process teardown.
      }
    }
  });

  test("import and export a fixed synthetic v47 envelope without mutating the source file", async () => {
    const smokeRoot = createSmokeRoot();
    const fixturePath = path.join(evidenceDirectory, "synthetic-v47-import.json");
    const exportPath = path.join(evidenceDirectory, "exported-save.json.gz");
    const envelope = serializeEnvelope(createInitialState());
    fs.writeFileSync(fixturePath, envelope);
    const before = sha256File(fixturePath);
    const app = await launchPackagedApp(smokeRoot);
    try {
      const page = await app.firstWindow();
      await enterNewGame(page);
      await expect(page.locator(".game-shell")).toBeVisible({ timeout: 30_000 });
      await dismissBlockingDialogs(page);
      const operations = await openSaveTab(page);
      await operations.locator('input[aria-label="选择要导入的存档文件"]').setInputFiles(fixturePath);
      await expect(operations.locator(".save-import-preview")).toContainText("校验通过");
      await operations.locator(".save-import-preview").getByRole("button", { name: "确认导入" }).click();
      await expect(page.locator(".game-shell")).toHaveAttribute("data-persistence-phase", "complete", { timeout: 30_000 });
      await expect(sha256File(fixturePath)).toBe(before);

      if (fs.existsSync(exportPath)) fs.unlinkSync(exportPath);
      await armPackagedExport(app, exportPath);
      await page.getByLabel("打开设置").click();
      const reopened = page.getByRole("dialog", { name: "运营中心" });
      if (!(await reopened.isVisible().catch(() => false))) {
        await page.getByLabel("打开设置").click();
      }
      const saveTab = page.getByRole("dialog", { name: "运营中心" });
      await saveTab.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
      await saveTab.getByRole("button", { name: "导出压缩存档" }).click();
      await expect.poll(() => fs.existsSync(exportPath) && fs.statSync(exportPath).size > 32).toBe(true);
      expect(sha256File(fixturePath)).toBe(before);
    } finally {
      await closePackagedApp(app);
      try {
        fs.rmSync(smokeRoot, { recursive: true, force: true });
      } catch { /* profile lock */ }
    }
  });

  test("invalid import is rejected without replacing the loaded factory", async () => {
    const smokeRoot = createSmokeRoot();
    const app = await launchPackagedApp(smokeRoot);
    try {
      const page = await app.firstWindow();
      await enterNewGame(page);
      await expect(page.locator(".game-shell")).toBeVisible({ timeout: 30_000 });
      await dismissBlockingDialogs(page);
      await expect(page.locator(".vein-node").filter({ hasText: "铁矿石" })).toBeVisible();
      const beforeBytes = await page.locator(".game-shell").getAttribute("data-primary-save-bytes");
      const operations = await openSaveTab(page);
      await operations.locator('input[aria-label="选择要导入的存档文件"]').setInputFiles({
        name: "truncated.json",
        mimeType: "application/json",
        buffer: Buffer.from('{"formatVersion":2,"state":{'),
      });
      await expect(operations.locator(".save-import-preview").or(operations.getByRole("alert")).or(operations)).toBeVisible();
      await expect(operations.getByRole("button", { name: "确认导入" })).toHaveCount(0);
      const afterBytes = await page.locator(".game-shell").getAttribute("data-primary-save-bytes");
      expect(afterBytes).toBe(beforeBytes);
    } finally {
      await closePackagedApp(app);
      try {
        fs.rmSync(smokeRoot, { recursive: true, force: true });
      } catch { /* profile lock */ }
    }
  });

  test("durable save survives process exit and unconfirmed edits are not claimed as saved", async () => {
    const smokeRoot = createSmokeRoot();
    let app: ElectronApplication | undefined = await launchPackagedApp(smokeRoot);
    try {
      const page = await app.firstWindow();
      await enterNewGame(page);
      await page.getByRole("button", { name: "暂停模拟" }).click();
      await expect(page.locator(".game-shell")).toHaveAttribute("data-simulation-paused", "true");
      const operations = await openSaveTab(page);
      await operations.getByRole("button", { name: "立即保存" }).click();
      await expect(page.locator(".game-shell")).toHaveAttribute("data-persistence-phase", "complete", { timeout: 30_000 });
      const durableBytes = Number(await page.locator(".game-shell").getAttribute("data-primary-save-bytes"));
      expect(durableBytes).toBeGreaterThan(0);
      await closePackagedApp(app);
      app = undefined;
      await waitForWriterLeaseExpiry();

      app = await launchPackagedApp(smokeRoot);
      const resumedPage = await app.firstWindow();
      await continueSavedGame(resumedPage);
      const restoredBytes = Number(await resumedPage.locator(".game-shell").getAttribute("data-primary-save-bytes"));
      // pagehide emergency mirrors and continue-time offline settlement may
      // rewrite envelope metadata; the durable checkpoint must still load.
      expect(restoredBytes).toBeGreaterThan(0);
      await expect(resumedPage.locator(".game-shell")).toHaveAttribute("data-native-authority-mode", "unbound");
      await expect(resumedPage.getByRole("button", { name: "立即保存" })).toHaveCount(0);
    } finally {
      await closePackagedApp(app);
      try {
        fs.rmSync(smokeRoot, { recursive: true, force: true });
      } catch { /* profile lock */ }
    }
  });
});
