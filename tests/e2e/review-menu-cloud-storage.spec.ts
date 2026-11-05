import { expect, test, type Page } from "@playwright/test";
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
  { access: "read-only", action: "download", slot: "main" },
] as const) {
test(`menu cloud ${scenario.slot} recovery reports unavailable with read-only storage and retries durably`, async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ access }: { access: string }) => {
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
      localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-04-v1.3.7");
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
    if (path === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: scenario.slot === "main" ? metadata() : null, cloudSaves: { main: null, "1": null, "2": null, "3": null, [scenario.slot]: metadata() } });
    if (path === "/api/account/sessions") return fulfill({ sessions: [] });
    if (path === "/api/cloud-save/history") return fulfill({ history: [] });
    if (path === "/api/cloud-save" && request.method() === "GET") { downloads += 1; return fulfill({ cloudSave: { ...metadata(), payload } }); }
    if (path.startsWith("/api/cloud-save") && request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    return fulfill({ error: "isolated cloud slot route unavailable" }, 404);
  });
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await openSaves(page);
  const original = await exportedEnvelope(page);
  const remote = JSON.parse(JSON.stringify(original));
  remote.state.tray.iron_ore = 99;
  remote.state.blueprints = [];
  if (scenario.slot !== "main") {
    remote.kind = "slot";
    remote.slot = Number(scenario.slot);
  }
  remote.checksum = fixtureChecksum(remote.formatVersion, remote.state);
  checksum = remote.checksum;
  payload = JSON.stringify(remote);
  await page.evaluate(() => sessionStorage.setItem("cloud-slot-blocked", "1"));
  await page.goto("/?menu=1");
  await expect(page.locator(".start-menu")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".local-save-writer-banner--temporary")).toBeVisible();
  await page.getByRole("button", { name: "登录与云存档", exact: true }).click();
  let panel = page.getByRole("region", { name: "按模式管理云存档", exact: true });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const row = panel.locator(`[data-cloud-slot="${scenario.slot}"]`);
  await row.getByRole("button", { name: scenario.slot === "main" ? "恢复到本机" : "下载", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: /^确认(覆盖|恢复)$/ }).click();
  const feedbackTarget = panel.getByRole("status");
  await expect(feedbackTarget).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(() => feedbackTarget.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const warning = document.querySelector(".local-save-writer-banner--temporary")!.getBoundingClientRect();
    const covered = bounds.left < warning.right && bounds.right > warning.left && bounds.top < warning.bottom && bounds.bottom > warning.top;
    return !covered && bounds.top >= 0 && bounds.bottom <= innerHeight && document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) === element;
  }), { message: "the restore failure must be visible before any manual scrolling" }).toBe(true);
  const feedback = (await feedbackTarget.allTextContents()).join(";");
  const localSummary = await row.locator("dd").first().textContent();
  await testInfo.attach("menu-cloud-temporary-outcome", { body: JSON.stringify({ ...scenario, feedback, localSummary, downloads, errors, writes }), contentType: "application/json" });
  expect.soft(feedback).toContain("无法保存到本机");
  expect.soft(downloads).toBe(0);
  if (scenario.slot === "3") expect.soft(localSummary).toBe("空槽位");
  if (scenario.slot === "3") {
    const geometry: Array<{ width: number; height: number; scale: number }> = [];
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      for (const scale of [80, 100, 125, 150, 200]) {
        await page.evaluate((scale) => {
          document.documentElement.dataset.uiFontScale = String(scale);
          document.documentElement.style.setProperty("--ui-font-scale", String(scale / 100));
        }, scale);
        await feedbackTarget.evaluate((element) => element.scrollIntoView({ block: "center" }));
        await expect.poll(() => feedbackTarget.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const outer = element.closest(".start-menu")!.getBoundingClientRect();
          const warning = document.querySelector(".local-save-writer-banner--temporary")!.getBoundingClientRect();
          const covered = bounds.left < warning.right && bounds.right > warning.left && bounds.top < warning.bottom && bounds.bottom > warning.top;
          return !covered && document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) === element && element.scrollWidth <= element.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 && bounds.left >= outer.left - 1 && bounds.right <= outer.right + 1;
        }), { message: `menu cloud feedback ${viewport.width}x${viewport.height} ${scale}%` }).toBe(true);
        geometry.push({ ...viewport, scale });
        if (scale === 150) for (const theme of ["dark", "light"]) {
          await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
          await page.screenshot({ path: `artifacts/review-menu-cloud-storage-20261105/${process.env.DSP_REVIEW_CHECK_NAME || "review"}-${viewport.width}x${viewport.height}-${theme}.png`, animations: "disabled" });
        }
      }
    }
    await testInfo.attach("menu-cloud-feedback-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      document.documentElement.dataset.uiFontScale = "100";
      document.documentElement.style.setProperty("--ui-font-scale", "1");
      document.documentElement.dataset.theme = "dark";
    });
  }
  await page.evaluate(() => sessionStorage.removeItem("cloud-slot-blocked"));
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
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
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档", exact: true }).click();
  panel = page.getByRole("region", { name: "按模式管理云存档", exact: true });
  await panel.locator(`[data-cloud-slot="${scenario.slot}"]`).getByRole("button", { name: scenario.slot === "main" ? "恢复到本机" : "下载", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: /^确认(覆盖|恢复)$/ }).click();
  await expect(panel.getByRole("status")).toContainText("已恢复到本机", { timeout: 60_000 });
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  if (scenario.slot !== "main") {
    saves = await openSaves(page);
    await saves.getByLabel(`载入槽位 ${scenario.slot}`, { exact: true }).click();
  }
  await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("99", { timeout: 60_000 });
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await openSaves(page);
  const retry = await exportedEnvelope(page);
  expect(retry.state.tray.iron_ore).toBe(99);
  expect(retry.state.blueprints).toHaveLength(0);
  expect(retry.state.settings.autosaveIntervalSeconds).toBe(0);
  await testInfo.attach("menu-cloud-durable-retry", { body: JSON.stringify({ ...scenario, preservedMainOre, preservedSlotOre, preservedBlueprints: preserved.state.blueprints.length, preservedAutosave: preserved.state.settings.autosaveIntervalSeconds, retryOre: retry.state.tray.iron_ore, retryBlueprints: retry.state.blueprints.length, retryAutosave: retry.state.settings.autosaveIntervalSeconds, errors, writes }), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});
}
