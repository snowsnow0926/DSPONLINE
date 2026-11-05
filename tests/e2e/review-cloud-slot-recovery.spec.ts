import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

test.use({ hasTouch: true, isMobile: true });

async function openSaves(page: Page) {
  await page.getByLabel("打开设置", { exact: true }).click();
  const saves = page.getByRole("dialog", { name: "运营中心", exact: true });
  await saves.getByRole("tab", { name: "存档", exact: true }).click();
  return saves;
}
async function exportedEnvelope(page: Page) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出压缩存档", exact: true }).click();
  const download = await pending, path = await download.path();
  if (!path) throw new Error("Missing isolated recovery fixture export");
  const bytes = await readFile(path);
  return JSON.parse((download.suggestedFilename().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}
function checksum(formatVersion: number, state: unknown) {
  const raw = JSON.stringify({ formatVersion, state });
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

for (const { denySnapshot, backend } of [
  { denySnapshot: false, backend: "local-storage" },
  { denySnapshot: true, backend: "local-storage" },
  { denySnapshot: false, backend: "indexeddb" },
] as const) test(`cloud slot conflict ${denySnapshot ? "refuses replacement if the promised recovery point fails" : "keeps the actual prior slot as a usable recovery point"} with ${backend}`, async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [], writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ denySnapshot, backend }) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    if (backend === "local-storage") Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("fixture", "InvalidStateError"); } } });
    if (!sessionStorage.getItem("slot-recovery-seeded")) {
      sessionStorage.setItem("slot-recovery-seeded", "1");
      localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-05-v1.3.8");
      localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
      localStorage.setItem("dsp-idle-network.cloud-token.v1", "isolated-slot-recovery-token");
      const state = { version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
        research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
        blueprints: Array.from({ length: 12 }, (_, index) => ({ id: `recovery-${index}`, name: `original blueprint ${index}`, revision: 1, rotation: 0, mirror: "none", entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }], belts: [] })),
        settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0 } };
      localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
      localStorage.setItem("dsp-idle-network.slot.1", JSON.stringify({ savedAt: Date.now(), kind: "slot", slot: 1, state: { ...state, tray: { iron_ore: 88 } } }));
    }
    if (!denySnapshot) return;
    const local = window.localStorage, original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === local && sessionStorage.getItem("slot-recovery-allow") !== "1" && key.startsWith("dsp-idle-network.save.v1.snapshot.")) {
        const attempts = Number(sessionStorage.getItem("slot-recovery-denied") || "0");
        sessionStorage.setItem("slot-recovery-denied", String(attempts + 1));
        throw new DOMException("isolated snapshot write denial", "QuotaExceededError");
      }
      return Reflect.apply(original, this, [key, value]);
    };
  }, { denySnapshot, backend });
  const now = Date.now();
  const user = { id: "isolated-slot-recovery", username: "recovery_fixture", email: "", displayName: "恢复点测试", createdAt: now, emailVerified: false, emailVerifiedAt: null, passwordChangedAt: now, leaderboardVisible: false };
  let payload = "", stateChecksum = "", downloads = 0;
  const metadata = () => ({ mode: "normal", slot: "1", revision: 2, updatedAt: now, size: Buffer.byteLength(payload), checksum: "isolated-server-checksum", summary: { mode: "normal", stateVersion: 47, savedAt: now, elapsedSeconds: 0, activePlanetId: "home", entityCount: 0, completedTechCount: 1, structurePoints: 0, uploadedWhiteMatrix: 0, stateChecksum, integrity: "valid" } });
  await page.route("**/api/**", (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/health") return fulfill({ ok: true, mailProvider: "disabled" });
    if (path === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: null, cloudSaves: { main: null, "1": payload ? metadata() : null, "2": null, "3": null } });
    if (path === "/api/account/sessions") return fulfill({ sessions: [] });
    if (path === "/api/cloud-save/history") return fulfill({ history: [] });
    if (path === "/api/cloud-save" && request.method() === "GET") { downloads++; return fulfill({ cloudSave: { ...metadata(), payload } }); }
    if (path.startsWith("/api/cloud-save") && request.method() !== "GET") writes.push(`${request.method()} ${path}`);
    return fulfill({ error: "isolated slot recovery route unavailable" }, 404);
  });
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  let saves = await openSaves(page);
  const backendLabel = saves.locator(".save-storage-usage > header > small");
  await expect(backendLabel).toHaveText(backend === "indexeddb" ? "IndexedDB" : "兼容存储");
  const observedBackend = await backendLabel.textContent();
  const original = await exportedEnvelope(page);
  expect(original.state.tray.iron_ore).toBe(42);
  expect(original.state.settings.autosaveIntervalSeconds).toBe(0);
  expect(await saves.locator(".save-snapshot-row").count()).toBe(0);
  const remote = JSON.parse(JSON.stringify(original));
  remote.kind = "slot"; remote.slot = 1; remote.state.tray.iron_ore = 99; remote.state.blueprints = [];
  stateChecksum = remote.checksum = checksum(remote.formatVersion, remote.state);
  payload = JSON.stringify(remote);
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("打开银河网络", { exact: true }).click();
  const galaxy = page.getByRole("dialog", { name: "银河网络", exact: true });
  await galaxy.getByRole("tab", { name: "云存档", exact: true }).click();
  await galaxy.locator('[data-cloud-slot="1"]').getByRole("button", { name: "上传", exact: true }).click();
  const conflict = page.getByRole("alertdialog", { name: "本地与云端都有不同进度", exact: true });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText("另一份会保留为恢复点");
  const attemptsBefore = await page.evaluate(() => Number(sessionStorage.getItem("slot-recovery-denied") || "0"));
  await conflict.getByRole("button", { name: "使用云端版本", exact: true }).click();
  await expect.poll(async () => !await conflict.isVisible() || /快照/.test((await conflict.getByRole("status").allTextContents()).join(";")), { timeout: 60_000 }).toBe(true);
  const feedback = (await page.locator(".galaxy-cloud-message, .cloud-save-conflict-feedback").allTextContents()).join(";");
  const attempts = (await page.evaluate(() => Number(sessionStorage.getItem("slot-recovery-denied") || "0"))) - attemptsBefore;
  if (denySnapshot) {
    await expect(conflict).toBeVisible();
    await expect(conflict.getByRole("status")).toBeVisible();
    expect.soft(feedback).toMatch(/快照/);
    expect.soft(attempts).toBeGreaterThan(0);
    const geometry = [];
    const status = conflict.getByRole("status");
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      for (const scale of [80, 100, 125, 150, 200]) {
        await page.evaluate((scale) => {
          document.documentElement.dataset.uiFontScale = String(scale);
          document.documentElement.style.setProperty("--ui-font-scale", String(scale / 100));
        }, scale);
        await status.evaluate((element) => element.scrollIntoView({ block: "center" }));
        await expect.poll(() => status.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const outer = element.closest('[role="alertdialog"]')!.getBoundingClientRect();
          return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) === element &&
            element.scrollWidth <= element.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 &&
            bounds.left >= outer.left - 1 && bounds.right <= outer.right + 1;
        }), { message: `slot recovery feedback ${viewport.width}x${viewport.height} ${scale}%` }).toBe(true);
        const retry = conflict.getByRole("button", { name: "使用云端版本", exact: true });
        await expect(retry).toBeEnabled();
        await retry.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
        await expect.poll(() => retry.evaluate((element) => {
          const bounds = element.getBoundingClientRect(), hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
          return bounds.top >= 0 && bounds.bottom <= innerHeight && Boolean(hit && element.contains(hit));
        }), { message: `slot retry target ${viewport.width}x${viewport.height} ${scale}%` }).toBe(true);
        geometry.push({ ...viewport, scale });
        await status.evaluate((element) => element.scrollIntoView({ block: "center" }));
        if (scale === 150) for (const theme of ["dark", "light"]) {
          await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
          await page.screenshot({ path: `artifacts/review-cloud-slot-recovery-20261105/${process.env.DSP_REVIEW_CHECK_NAME || "review"}-${viewport.width}x${viewport.height}-${theme}.png`, animations: "disabled" });
        }
      }
    }
    await testInfo.attach("slot-recovery-feedback-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      document.documentElement.dataset.uiFontScale = "100";
      document.documentElement.style.setProperty("--ui-font-scale", "1");
      document.documentElement.dataset.theme = "dark";
    });
  }
  if (await conflict.isVisible()) await conflict.getByRole("button", { name: "稍后处理", exact: true }).click();
  await galaxy.getByLabel("关闭银河网络", { exact: true }).click();
  saves = await openSaves(page);
  const slotRecovery = saves.locator(".save-snapshot-row").filter({ hasText: /恢复.*云.*槽位/ });
  await expect.soft(slotRecovery).toHaveCount(denySnapshot ? 0 : 1, { timeout: 5_000 });
  const preservedMain = await exportedEnvelope(page);
  expect(preservedMain.state.tray.iron_ore).toBe(42);
  const snapshotLabels = await saves.locator(".save-snapshot-row").allTextContents();
  const recoveryCount = await slotRecovery.count();
  expect.soft(recoveryCount).toBe(denySnapshot ? 0 : 1);
  // Only now load slot 1. Loading 88 into main earlier would hide a missing slot recovery point.
  await saves.getByLabel("载入槽位 1", { exact: true }).click();
  await expect.poll(() => page.locator('.tray-row[title="拿取铁矿石"] strong').textContent(), { timeout: 60_000 }).toMatch(/^(88|99)$/);
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  saves = await openSaves(page);
  const replaced = await exportedEnvelope(page);
  expect.soft(replaced.state.tray.iron_ore).toBe(denySnapshot ? 88 : 99);
  expect.soft(replaced.state.blueprints).toHaveLength(denySnapshot ? 12 : 0);
  expect(replaced.state.settings.autosaveIntervalSeconds).toBe(0);
  if (!denySnapshot && recoveryCount === 1) {
    await saves.locator(".save-snapshot-row").filter({ hasText: /恢复.*云.*槽位/ }).getByRole("button", { name: /^回滚到快照 / }).click();
    await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("88", { timeout: 60_000 });
    await page.reload();
    await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
    await openSaves(page);
    const rollback = await exportedEnvelope(page);
    expect(rollback.state.tray.iron_ore).toBe(88);
    expect(rollback.state.blueprints).toHaveLength(12);
    expect(rollback.state.research.completedTechIds).toEqual(["electromagnetism"]);
    expect(rollback.state.settings.autosaveIntervalSeconds).toBe(0);
  }
  let retryResult: { slotOre: number; rollbackOre: number; rollbackBlueprints: number; autosave: number } | null = null;
  if (denySnapshot) {
    await page.getByLabel("关闭运营中心", { exact: true }).click();
    await page.evaluate(() => sessionStorage.setItem("slot-recovery-allow", "1"));
    await page.getByLabel("打开银河网络", { exact: true }).click();
    const retryGalaxy = page.getByRole("dialog", { name: "银河网络", exact: true });
    await retryGalaxy.getByRole("tab", { name: "云存档", exact: true }).click();
    await retryGalaxy.locator('[data-cloud-slot="1"]').getByRole("button", { name: "上传", exact: true }).click();
    await conflict.getByRole("button", { name: "使用云端版本", exact: true }).click();
    await expect(conflict).toBeHidden({ timeout: 60_000 });
    await retryGalaxy.getByLabel("关闭银河网络", { exact: true }).click();
    saves = await openSaves(page);
    await expect(saves.locator(".save-snapshot-row").filter({ hasText: /恢复.*云.*槽位/ })).toHaveCount(1);
    await saves.getByLabel("载入槽位 1", { exact: true }).click();
    await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("99", { timeout: 60_000 });
    saves = await openSaves(page);
    const retrySlot = await exportedEnvelope(page);
    expect(retrySlot.state.tray.iron_ore).toBe(99);
    expect(retrySlot.state.blueprints).toHaveLength(0);
    await saves.locator(".save-snapshot-row").filter({ hasText: /恢复.*云.*槽位/ }).getByRole("button", { name: /^回滚到快照 / }).click();
    await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("88", { timeout: 60_000 });
    await page.reload();
    await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
    await openSaves(page);
    const rollback = await exportedEnvelope(page);
    expect(rollback.state.tray.iron_ore).toBe(88);
    expect(rollback.state.blueprints).toHaveLength(12);
    expect(rollback.state.research.completedTechIds).toEqual(["electromagnetism"]);
    expect(rollback.state.settings.autosaveIntervalSeconds).toBe(0);
    retryResult = { slotOre: retrySlot.state.tray.iron_ore, rollbackOre: rollback.state.tray.iron_ore,
      rollbackBlueprints: rollback.state.blueprints.length, autosave: rollback.state.settings.autosaveIntervalSeconds };
  }
  await testInfo.attach("slot-conflict-recovery-outcome", { body: JSON.stringify({ denySnapshot, backend, observedBackend, feedback, attemptsBefore, attempts, recoveryCount, snapshotLabels, mainOre: preservedMain.state.tray.iron_ore, slotOre: replaced.state.tray.iron_ore, slotBlueprints: replaced.state.blueprints.length, autosave: replaced.state.settings.autosaveIntervalSeconds, retryResult, downloads, errors, writes }), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});
