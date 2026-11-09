import { expect, test } from "@playwright/test";
import { workflowTimeoutMs } from "./startup-timeout";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

test("frozen public UI rejects volatile saving, exports current progress and preserves the old save", async ({ page }) => {
  test.setTimeout(workflowTimeoutMs(180_000));
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    if (sessionStorage.getItem("artifact-temporary") === "1") {
      Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("fixture", "InvalidStateError"); } } });
      Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("fixture", "SecurityError"); } });
      return;
    }
    if (sessionStorage.getItem("artifact-seeded") === "1") return;
    sessionStorage.setItem("artifact-seeded", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-09-v1.3.11");
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 47, entities: [], belts: [], tray: { iron_ore: 42 }, construction: {}, paused: true,
      research: { completedTechIds: ["electromagnetism"], selectedTechId: null, progressByTech: {} },
      blueprints: [{ id: "artifact-original", name: "成品原始蓝图", revision: 1, rotation: 0, mirror: "none", entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }], belts: [] }],
      settings: { autosaveIntervalSeconds: 0, theme: "dark", simulationSpeed: 1, fontScale: 1 },
    } }));
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated artifact QA"}' }));
  await page.goto("/"); await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  const ore = page.locator('.tray-row[title="拿取铁矿石"] strong'); await expect(ore).toHaveText("42");
  await page.evaluate(() => sessionStorage.setItem("artifact-temporary", "1")); await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  const closeNotes = page.getByRole("button", { name: "关闭版本更新记录" }); if (await closeNotes.isVisible()) await closeNotes.click();
  const pause = page.getByRole("button", { name: "暂停模拟", exact: true }); if (await pause.isVisible()) await pause.click();
  await expect(page.locator(".local-save-writer-banner--temporary")).toContainText("当前为临时运行");
  const temporaryOre = Number(await ore.textContent());
  async function openSaves() {
    await page.getByLabel("打开设置", { exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "运营中心", exact: true });
    await dialog.getByRole("tab", { name: "存档", exact: true }).click(); return dialog;
  }
  async function exportCurrent(dialog, phase: string) {
    const pending = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "导出压缩存档", exact: true }).click();
    const download = await pending; const directory = resolve("artifacts/review-temporary-storage-20261105"); await mkdir(directory, { recursive: true });
    const path = resolve(directory, `${process.env.DSP_REVIEW_CHECK_NAME}-${phase}-${download.suggestedFilename()}`); await download.saveAs(path);
    const bytes = await readFile(path); return JSON.parse((download.suggestedFilename().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8")).state;
  }
  const temporaryDialog = await openSaves();
  await temporaryDialog.getByRole("button", { name: "立即保存", exact: true }).click();
  await expect(page.locator(".game-notice")).toContainText("无法保存到本机");
  const temporary = await exportCurrent(temporaryDialog, "temporary");
  expect(temporary.version).toBe(47); expect(temporary.paused).toBe(true); expect(temporary.tray.iron_ore ?? 0).toBe(temporaryOre);
  await page.evaluate(() => sessionStorage.removeItem("artifact-temporary")); await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 }); await expect(ore).toHaveText("42");
  await expect(page.locator(".local-save-writer-banner--temporary")).toHaveCount(0);
  const restored = await exportCurrent(await openSaves(), "restored");
  expect(restored.tray.iron_ore).toBe(42); expect(restored.settings.autosaveIntervalSeconds).toBe(0);
  expect(restored.research.completedTechIds).toContain("electromagnetism");
  expect(restored.blueprints.find((entry) => entry.id === "artifact-original")?.name).toBe("成品原始蓝图");
  expect(errors).toEqual([]);
});
