import { expect, test, type Page } from "@playwright/test";
import { startupTimeoutMs, workflowTimeoutMs } from "./startup-timeout";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

async function openSaves(page: Page) {
  await page.getByLabel("打开设置", { exact: true }).click();
  const saves = page.getByRole("dialog", { name: "运营中心", exact: true });
  await saves.getByRole("tab", { name: "存档", exact: true }).click();
  return saves;
}

async function exportedEnvelope(page: Page) {
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出压缩存档", exact: true }).click();
  const download = await downloading, path = await download.path();
  if (!path) throw new Error("The isolated fixture did not export");
  const bytes = await readFile(path);
  return JSON.parse((download.suggestedFilename().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

function fixtureChecksum(formatVersion: number, state: unknown) {
  const payload = JSON.stringify({ formatVersion, state });
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) hash = Math.imul(hash ^ payload.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

for (const scenario of [
  { access: "read-only", action: "download", slot: "3" },
  { access: "denied", action: "download", slot: "3" },
  { access: "read-only", action: "conflict", slot: "1" },
] as const) {
test(`cloud slot ${scenario.action} reports unavailable with ${scenario.access} local storage and retries durably`, async ({ page }, testInfo) => {
  test.setTimeout(workflowTimeoutMs(300_000));
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ access }) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    const state = {
      version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      blueprints: Array.from({ length: 12 }, (_, index) => ({ id: `cloud-slot-${index}`, name: `original blueprint ${index}`, revision: 1, rotation: 0, mirror: "none", entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }], belts: [] })),
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0 },
    };
    const blocked = sessionStorage.getItem("cloud-slot-blocked") === "1";
    // Keep IndexedDB unavailable in this disposable context throughout. The
    // healthy baseline really persists to localStorage; later denial cannot
    // introduce an unrelated migration conflict between two storage backends.
    Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("fixture", "InvalidStateError"); } } });
    if (!sessionStorage.getItem("cloud-slot-seeded")) {
      sessionStorage.setItem("cloud-slot-seeded", "1");
      localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-07-v1.3.9");
      localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
      localStorage.setItem("dsp-idle-network.cloud-token.v1", "isolated-cloud-slot-token");
      localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
      localStorage.setItem("dsp-idle-network.slot.1", JSON.stringify({ savedAt: Date.now(), kind: "slot", slot: 1, state: { ...state, tray: { iron_ore: 88 } } }));
    }
    if (!blocked) return;
    if (access === "denied") {
      Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("fixture", "SecurityError"); } });
    } else {
      const local = window.localStorage;
      const nativeSet = Storage.prototype.setItem, nativeRemove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (...args) { if (this === local) throw new DOMException("fixture", "QuotaExceededError"); return Reflect.apply(nativeSet, this, args); };
      Storage.prototype.removeItem = function (...args) { if (this === local) throw new DOMException("fixture", "SecurityError"); return Reflect.apply(nativeRemove, this, args); };
    }
  }, { access: scenario.access });
  const now = Date.now();
  const user = { id: "isolated-cloud-slot", username: "slot_fixture", email: "", displayName: "槽位存储测试", createdAt: now, emailVerified: false, emailVerifiedAt: null, passwordChangedAt: now, leaderboardVisible: false };
  let payload = "", checksum = "", downloads = 0;
  const metadata = () => ({ mode: "normal", slot: scenario.slot, revision: 2, updatedAt: now, size: Buffer.byteLength(payload), checksum: "isolated-slot-server-checksum", summary: { mode: "normal", stateVersion: 47, savedAt: now, elapsedSeconds: 0, activePlanetId: "home", entityCount: 0, completedTechCount: 1, structurePoints: 0, uploadedWhiteMatrix: 0, stateChecksum: checksum, integrity: "valid" } });
  await page.route("**/api/**", (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/health") return fulfill({ ok: true, mailProvider: "disabled" });
    if (path === "/api/auth/login") return fulfill({ user, token: "isolated-cloud-slot-login-token" });
    if (path === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: null, cloudSaves: { main: null, "1": null, "2": null, "3": null, [scenario.slot]: metadata() } });
    if (path === "/api/account/sessions") return fulfill({ sessions: [] });
    if (path === "/api/cloud-save/history") return fulfill({ history: [] });
    if (path === "/api/cloud-save" && request.method() === "GET") { downloads += 1; return fulfill({ cloudSave: { ...metadata(), payload } }); }
    if (path.startsWith("/api/cloud-save") && request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    return fulfill({ error: "isolated cloud slot route unavailable" }, 404);
  });
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: startupTimeoutMs(60_000) });
  await openSaves(page);
  const original = await exportedEnvelope(page);
  const remote = JSON.parse(JSON.stringify(original));
  // Healthy retries need a real manual-slot envelope. A primary payload is
  // intentionally refused by the namespace guard and has its own negative test.
  remote.kind = "slot";
  remote.slot = Number(scenario.slot);
  remote.state.tray.iron_ore = 99;
  remote.state.blueprints = [];
  remote.checksum = fixtureChecksum(remote.formatVersion, remote.state);
  checksum = remote.checksum;
  payload = JSON.stringify(remote);
  await page.evaluate(() => sessionStorage.setItem("cloud-slot-blocked", "1"));
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: startupTimeoutMs(60_000) });
  const notes = page.getByRole("button", { name: "关闭版本更新记录", exact: true });
  if (await notes.isVisible()) await notes.click();
  const pause = page.getByRole("button", { name: "暂停模拟", exact: true });
  if (await pause.isVisible()) await pause.click();
  await expect(page.locator(".local-save-writer-banner--temporary")).toBeVisible();
  await page.getByLabel("打开银河网络", { exact: true }).click();
  let galaxy = page.getByRole("dialog", { name: "银河网络", exact: true, includeHidden: true });
  await expect(galaxy).toBeVisible({ timeout: 60_000 });
  await galaxy.getByRole("tab", { name: "云存档", exact: true }).click();
  if (scenario.access === "denied") {
    await galaxy.getByLabel("用户名或邮箱", { exact: true }).fill("slot_fixture");
    await galaxy.getByLabel("密码", { exact: true }).fill("isolated-fixture-password");
    await galaxy.getByRole("button", { name: "登录云账户", exact: true }).click();
  }
  const row = galaxy.locator(`[data-cloud-slot="${scenario.slot}"]`);
  await row.getByRole("button", { name: scenario.action === "conflict" ? "上传" : "下载", exact: true }).click();
  const conflict = page.getByRole("alertdialog", { name: "本地与云端都有不同进度", exact: true });
  await expect.poll(async () => (await conflict.isVisible()) || (await galaxy.locator(".galaxy-cloud-message").allTextContents()).join(";").length > 0).toBe(true);
  if (await conflict.isVisible()) await conflict.getByRole("button", { name: "使用云端版本", exact: true }).click();
  const feedbackTarget = scenario.action === "conflict" ? conflict.getByRole("status") : galaxy.locator(".galaxy-cloud-message");
  await expect(feedbackTarget).toBeVisible();
  await expect(feedbackTarget).toContainText("无法保存到本机");
  const feedback = (await feedbackTarget.allTextContents()).join(";");
  const localSummary = await row.locator("dd").first().textContent();
  await testInfo.attach("cloud-slot-temporary-outcome", { body: JSON.stringify({ ...scenario, feedback, localSummary, downloads, errors, writes }), contentType: "application/json" });
  expect.soft(feedback).toContain("无法保存到本机");
  expect.soft(downloads).toBe(0);
  if (scenario.action === "download") expect.soft(localSummary).toBe("空槽位");
  if (scenario.access === "read-only") {
    const geometry: Array<{ width: number; height: number; scale: number }> = [];
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      for (const scale of [80, 100, 125, 150, 200]) {
        await page.evaluate((scale) => {
          document.documentElement.dataset.uiFontScale = String(scale);
          document.documentElement.style.setProperty("--ui-font-scale", String(scale / 100));
        }, scale);
        const status = feedbackTarget;
        await status.evaluate((element) => element.scrollIntoView({ block: "start" }));
        await expect.poll(() => status.evaluate((element) => {
          const outer = element.closest('[role="dialog"], [role="alertdialog"]')!.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          const warning = document.querySelector(".local-save-writer-banner--temporary")!.getBoundingClientRect();
          const covered = bounds.left < warning.right && bounds.right > warning.left && bounds.top < warning.bottom && bounds.bottom > warning.top;
          const topElement = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
          return (!covered || element.classList.contains("cloud-save-conflict-feedback")) && topElement === element && element.scrollWidth <= element.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 && bounds.left >= outer.left - 1 && bounds.right <= outer.right + 1;
        }), { message: `cloud storage feedback ${viewport.width}x${viewport.height} ${scale}%` }).toBe(true);
        geometry.push({ ...viewport, scale });
        if (scale === 150) for (const theme of ["dark", "light"]) {
          await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
          await page.screenshot({ path: `artifacts/review-cloud-slot-storage-20261105/${process.env.DSP_REVIEW_CHECK_NAME || "review"}-${scenario.action}-${viewport.width}x${viewport.height}-${theme}.png`, animations: "disabled" });
        }
      }
    }
    await testInfo.attach("cloud-slot-feedback-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      document.documentElement.dataset.uiFontScale = "100";
      document.documentElement.style.setProperty("--ui-font-scale", "1");
      document.documentElement.dataset.theme = "dark";
    });
  }
  if (await conflict.isVisible()) await conflict.getByRole("button", { name: "稍后处理", exact: true }).click();
  await page.evaluate(() => sessionStorage.removeItem("cloud-slot-blocked"));
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: startupTimeoutMs(60_000) });
  let saves = await openSaves(page);
  let preserved = await exportedEnvelope(page);
  const preservedMainOre = preserved.state.tray.iron_ore;
  expect(preserved.state.tray.iron_ore).toBe(42);
  expect(preserved.state.blueprints).toHaveLength(12);
  expect(preserved.state.settings.autosaveIntervalSeconds).toBe(0);
  await saves.getByLabel("载入槽位 1", { exact: true }).click();
  await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("88", { timeout: 60_000 });
  saves = await openSaves(page);
  preserved = await exportedEnvelope(page);
  const preservedSlotOre = preserved.state.tray.iron_ore;
  expect(preserved.state.blueprints).toHaveLength(12);
  expect(preserved.state.research.completedTechIds).toEqual(["electromagnetism"]);
  expect(preserved.state.settings.autosaveIntervalSeconds).toBe(0);
  await page.getByLabel("关闭运营中心", { exact: true }).click();
  await page.getByLabel("打开银河网络", { exact: true }).click();
  galaxy = page.getByRole("dialog", { name: "银河网络", exact: true, includeHidden: true });
  await expect(galaxy).toBeVisible({ timeout: 60_000 });
  await galaxy.getByRole("tab", { name: "云存档", exact: true }).click();
  await galaxy.locator(`[data-cloud-slot="${scenario.slot}"]`).getByRole("button", { name: scenario.action === "conflict" ? "上传" : "下载", exact: true }).click();
  if (scenario.action === "conflict") await conflict.getByRole("button", { name: "使用云端版本", exact: true }).click();
  await expect(galaxy.locator(".galaxy-cloud-message")).toContainText(scenario.action === "conflict" ? "保留云端版本" : "已下载到对应本地槽位", { timeout: 60_000 });
  await galaxy.getByLabel("关闭银河网络", { exact: true }).click();
  saves = await openSaves(page);
  await saves.getByLabel(`载入槽位 ${scenario.slot}`, { exact: true }).click();
  await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("99", { timeout: 60_000 });
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: startupTimeoutMs(60_000) });
  await openSaves(page);
  const retry = await exportedEnvelope(page);
  expect(retry.state.tray.iron_ore).toBe(99);
  expect(retry.state.blueprints).toHaveLength(0);
  expect(retry.state.settings.autosaveIntervalSeconds).toBe(0);
  await testInfo.attach("cloud-slot-durable-retry", { body: JSON.stringify({ ...scenario, preservedMainOre, preservedSlotOre, preservedBlueprints: preserved.state.blueprints.length, preservedAutosave: preserved.state.settings.autosaveIntervalSeconds, retryOre: retry.state.tray.iron_ore, retryBlueprints: retry.state.blueprints.length, retryAutosave: retry.state.settings.autosaveIntervalSeconds, errors, writes }), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});
}
