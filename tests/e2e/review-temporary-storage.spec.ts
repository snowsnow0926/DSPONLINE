import { expect, test } from "@playwright/test";
import { workflowTimeoutMs } from "./startup-timeout";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

for (const failureMode of ["denied-access", "read-only-quota", "healthy"] as const) {
test(`temporary storage warns only when needed, keeps export usable, and preserves the original durable save (${failureMode})`, async ({ page }, testInfo) => {
  test.setTimeout(workflowTimeoutMs(180_000));
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((mode) => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    if (sessionStorage.getItem("review-temporary-storage") === "1" && mode !== "healthy") {
      const database = window.indexedDB;
      Object.defineProperty(window, "indexedDB", { configurable: true, value: new Proxy(database, { get(target, key) {
        if (key === "open") return () => { throw new DOMException("isolated database denial", "InvalidStateError"); };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } }) });
      if (mode === "read-only-quota") {
        const storage = window.localStorage;
        Object.defineProperty(window, "localStorage", { configurable: true, value: new Proxy(storage, { get(target, key) {
          if (key === "setItem" || key === "removeItem" || key === "clear") return () => { throw new DOMException("isolated write denial", "QuotaExceededError"); };
          const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
        } }) });
      } else Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("isolated storage denial", "SecurityError"); } });
      return;
    }
    if (sessionStorage.getItem("review-temporary-seeded") === "1") return;
    sessionStorage.setItem("review-temporary-seeded", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-05-v1.3.8");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      blueprints: [{ id: "durable-original", name: "原始蓝图", revision: 1, rotation: 0, mirror: "none", entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }], belts: [] }],
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0, resourceMode: "finite" },
    } }));
  }, failureMode);
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated temporary-storage review"}' }));
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  const ore = page.locator('.tray-row[title="拿取铁矿石"] strong');
  await expect(ore).toHaveText("42");
  await expect(page.locator(".local-save-writer-banner--temporary")).toHaveCount(0);
  const original = await page.evaluate(async () => {
    const { loadGame } = await import("/src/game/storage.ts"); const game = loadGame().state;
    return { ore: game.tray.iron_ore, autosave: game.settings.autosaveIntervalSeconds, research: game.research.completedTechIds, blueprint: game.blueprints.find((blueprint) => blueprint.id === "durable-original")?.name };
  });
  expect(original).toEqual({ ore: 42, autosave: 0, research: ["electromagnetism"], blueprint: "原始蓝图" });
  await page.evaluate(async (mode) => {
    if (mode === "read-only-quota") {
      const { readPersistedLocalSaveValue } = await import("/src/game/localSaveStore.ts");
      const raw = await readPersistedLocalSaveValue("dsp-idle-network.save.v1");
      if (!raw) throw new Error("missing original fixture");
      localStorage.setItem("dsp-idle-network.save.v1", raw);
    }
    sessionStorage.setItem("review-temporary-storage", "1");
  }, failureMode);
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  const releaseClose = page.getByRole("button", { name: "关闭版本更新记录" });
  if (await releaseClose.isVisible()) await releaseClose.click();
  const pause = page.getByRole("button", { name: "暂停模拟", exact: true });
  if (await pause.isVisible()) await pause.click();
  const store = await page.evaluate(async () => {
    const { getLocalSaveBackend, getLocalSaveWriterStatus } = await import("/src/game/localSaveStore.ts");
    return { backend: getLocalSaveBackend(), role: getLocalSaveWriterStatus().role };
  });
  expect(store).toEqual({ backend: failureMode === "healthy" ? "indexeddb" : "memory", role: "primary" });
  const warned = await page.getByRole("alert").filter({ hasText: /临时运行|临时进度|无法保存到本机/ }).isVisible();
  const temporaryOreText = await ore.count() ? await ore.textContent() : "0";
  expect(temporaryOreText).toMatch(/^\d+$/);
  await page.getByLabel("打开设置", { exact: true }).click();
  const operations = page.getByRole("dialog", { name: "运营中心", exact: true });
  await operations.getByRole("tab", { name: "存档", exact: true }).click();
  await page.evaluate(() => {
    window.__temporarySaveMessages = [];
    const sample = () => { const text = document.querySelector(".game-notice")?.textContent?.trim(); if (text && !window.__temporarySaveMessages.includes(text)) window.__temporarySaveMessages.push(text); };
    window.__temporarySaveObserver = new MutationObserver(sample);
    window.__temporarySaveObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await operations.getByRole("button", { name: "立即保存", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__temporarySaveMessages.join(";")), { timeout: 60_000 }).toMatch(/主存档已保存|主存档未变化|存档已验证完成|无法保存到本机|当前进度尚未保存|本地存储当前不可用/);
  const messages: string[] = await page.evaluate(() => { window.__temporarySaveObserver.disconnect(); return window.__temporarySaveMessages; });
  const downloaded = page.waitForEvent("download");
  await operations.getByRole("button", { name: "导出压缩存档", exact: true }).click();
  const download = await downloaded;
  const directory = resolve("artifacts/review-temporary-storage-20261105"); await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${process.env.DSP_REVIEW_CHECK_NAME || "review"}-${failureMode}-${download.suggestedFilename()}`);
  await download.saveAs(file);
  const bytes = await readFile(file);
  const exported = JSON.parse((download.suggestedFilename().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
  expect(exported.state.version).toBe(47);
  expect(exported.state.paused).toBe(true);
  expect(exported.state.tray.iron_ore ?? 0).toBe(Number(temporaryOreText));
  await page.evaluate(() => sessionStorage.removeItem("review-temporary-storage"));
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await expect(ore).toHaveText("42");
  const restored = await page.evaluate(async () => {
    const { loadGame } = await import("/src/game/storage.ts"); const game = loadGame().state;
    return { ore: game.tray.iron_ore, autosave: game.settings.autosaveIntervalSeconds, research: game.research.completedTechIds, blueprint: game.blueprints.find((blueprint) => blueprint.id === "durable-original")?.name };
  });
  await testInfo.attach("temporary-storage-outcome", { body: JSON.stringify({ store, warned, messages, exportBytes: bytes.length, temporaryOre: temporaryOreText, original, restored, errors }), contentType: "application/json" });
  expect(restored).toEqual(original); expect(errors).toEqual([]);
  expect.soft(warned).toBe(failureMode !== "healthy");
  expect.soft(messages.some((message) => /主存档已保存|主存档未变化|存档已验证完成/.test(message))).toBe(failureMode === "healthy");
  expect.soft(messages.some((message) => /无法保存到本机|当前进度尚未保存|本地存储当前不可用/.test(message))).toBe(failureMode !== "healthy");
});
}
