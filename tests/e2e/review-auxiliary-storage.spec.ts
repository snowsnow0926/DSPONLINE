import { expect, test, type Page } from "@playwright/test";
import { workflowTimeoutMs } from "./startup-timeout";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

async function openSaves(page: Page) {
  await page.getByLabel("打开设置", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "运营中心", exact: true });
  await dialog.getByRole("tab", { name: "存档", exact: true }).click();
  return dialog;
}

async function exportedSummary(page: Page) {
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出压缩存档", exact: true }).click();
  const download = await downloaded;
  const path = await download.path();
  if (!path) throw new Error("The isolated fixture export did not produce a file");
  const bytes = await readFile(path);
  const { state } = JSON.parse((download.suggestedFilename().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
  return {
    ore: state.tray.iron_ore,
    research: state.research.completedTechIds,
    autosave: state.settings.autosaveIntervalSeconds,
  };
}

for (const action of ["slot", "snapshot"] as const) {
  test(`auxiliary writes report unavailable and keep original ${action} intact in temporary storage`, async ({ page }, testInfo) => {
    test.setTimeout(workflowTimeoutMs(180_000));
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
      if (sessionStorage.getItem("auxiliary-temporary") === "1") {
        Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("fixture", "InvalidStateError"); } } });
        Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("fixture", "SecurityError"); } }); return;
      }
      if (sessionStorage.getItem("auxiliary-seeded") === "1") return;
      sessionStorage.setItem("auxiliary-seeded", "1");
      localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-14-v1.3.14");
      localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
        version: 47, entities: [], belts: [], tray: { iron_ore: 42 }, construction: {}, paused: true,
        research: { completedTechIds: ["electromagnetism"], selectedTechId: null, progressByTech: {} },
        settings: { autosaveIntervalSeconds: 0, theme: "dark", fontScale: 1, simulationSpeed: 1 },
      } }));
    });
    await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated auxiliary save review"}' }));
    await page.goto("/"); await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
    const ore = page.locator('.tray-row[title="拿取铁矿石"] strong'); await expect(ore).toHaveText("42");
    let dialog = await openSaves(page);
    await dialog.getByLabel("保存到槽位 1", { exact: true }).click();
    await expect(dialog.locator(".save-slot--occupied")).toHaveCount(1);
    await expect(dialog.locator(".save-slot--occupied")).toContainText("科技 1");
    await dialog.getByRole("button", { name: "创建快照", exact: true }).click();
    await expect(dialog.locator(".save-snapshot-row").filter({ has: page.getByRole("checkbox", { name: "选择快照 手动快照", exact: true }) })).toHaveCount(1);
    await expect(dialog.locator(".save-snapshot-row").filter({ has: page.getByRole("checkbox", { name: "选择快照 手动快照", exact: true }) })).toContainText("科技 1");
    const original = await exportedSummary(page);
    expect(original).toEqual({ ore: 42, research: ["electromagnetism"], autosave: 0 });
    const originalSlot = await dialog.locator(".save-slot--occupied").innerText();
    const originalSnapshot = await dialog.locator(".save-snapshot-row").filter({ has: page.getByRole("checkbox", { name: "选择快照 手动快照", exact: true }) }).innerText();
    await page.evaluate(() => sessionStorage.setItem("auxiliary-temporary", "1")); await page.reload();
    await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
    const closeNotes = page.getByRole("button", { name: "关闭版本更新记录" }); if (await closeNotes.isVisible()) await closeNotes.click();
    const pause = page.getByRole("button", { name: "暂停模拟", exact: true }); if (await pause.isVisible()) await pause.click();
    await expect(page.locator(".local-save-writer-banner--temporary")).toBeVisible();
    dialog = await openSaves(page);
    await expect(dialog.locator(".save-slot--occupied")).toHaveCount(0);
    await expect(dialog.locator(".save-snapshot-row")).toHaveCount(0);
    await (action === "slot" ? dialog.getByLabel("保存到槽位 1", { exact: true }) : dialog.getByRole("button", { name: "创建快照", exact: true })).click();
    await expect.poll(async () => {
      const created = await dialog.locator(action === "slot" ? ".save-slot--occupied" : ".save-snapshot-row").count();
      const notice = (await page.locator(".game-notice").allTextContents()).join(";");
      return created > 0 || /失败|不可|无法|不足/.test(notice) || errors.length > 0;
    }, { timeout: 60_000 }).toBe(true);
    const created = await dialog.locator(action === "slot" ? ".save-slot--occupied" : ".save-snapshot-row").count();
    const notice = (await page.locator(".game-notice").allTextContents()).join(";");
    await testInfo.attach("temporary-auxiliary-outcome", { body: JSON.stringify({ action, created, notice, errors }), contentType: "application/json" });
    await page.evaluate(() => sessionStorage.removeItem("auxiliary-temporary")); await page.reload();
    await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 }); await expect(ore).toHaveText("42");
    dialog = await openSaves(page);
    await expect(dialog.locator(".save-slot--occupied")).toHaveCount(1);
    await expect(dialog.locator(".save-slot--occupied")).toContainText("科技 1");
    await expect(dialog.locator(".save-snapshot-row").filter({ has: page.getByRole("checkbox", { name: "选择快照 手动快照", exact: true }) })).toHaveCount(1);
    await expect(dialog.locator(".save-snapshot-row").filter({ has: page.getByRole("checkbox", { name: "选择快照 手动快照", exact: true }) })).toContainText("科技 1");
    expect(await dialog.locator(".save-slot--occupied").innerText()).toBe(originalSlot);
    expect(await dialog.locator(".save-snapshot-row").filter({ has: page.getByRole("checkbox", { name: "选择快照 手动快照", exact: true }) }).innerText()).toBe(originalSnapshot);
    expect(await exportedSummary(page)).toEqual(original);
    expect.soft(created).toBe(0);
    expect.soft(notice).toContain("无法保存到本机");
    expect.soft(errors).toEqual([]);
  });
}
