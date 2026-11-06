import { expect, test, type Page } from "@playwright/test";
import { workflowTimeoutMs } from "./startup-timeout";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

async function openSaves(page: Page) {
  const direct = page.getByLabel("打开设置", { exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await page.getByRole("button", { name: "更多工作区", exact: true }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  }
  const panel = page.getByRole("dialog", { name: "运营中心", exact: true });
  await panel.getByRole("tab", { name: "存档", exact: true }).click();
  return panel;
}

async function exportedEnvelope(page: Page) {
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出压缩存档", exact: true }).click();
  const download = await downloaded;
  const path = await download.path();
  if (!path) throw new Error("Missing isolated export");
  const bytes = await readFile(path);
  return JSON.parse((download.suggestedFilename().endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

for (const touch of [false, true]) {
test.describe(touch ? "phone" : "desktop", () => {
test.use({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: touch, isMobile: touch });
test("cancelled rescue keeps the original factory when its earlier snapshot completes", async ({ page }, testInfo) => {
  test.setTimeout(workflowTimeoutMs(240_000));
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  const backups: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("download", (download) => { if (download.suggestedFilename().includes("rescue-backup")) backups.push(download.suggestedFilename()); });
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    if (sessionStorage.getItem("rescue-cancellation-seeded")) return;
    sessionStorage.setItem("rescue-cancellation-seeded", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-07-v1.3.9");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      blueprints: Array.from({ length: 12 }, (_, index) => ({ id: `cancel-original-${index}`, name: `original blueprint ${index}`, revision: 1, rotation: 0, mirror: "none", entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }], belts: [] })),
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0 },
    } }));
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated rescue cancellation review"}' }));
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  let panel = await openSaves(page);
  const envelope = await exportedEnvelope(page);
  expect(envelope.state.blueprints).toHaveLength(12);
  envelope.state.tray.iron_ore = 99;
  envelope.state.blueprints = [];
  const raw = JSON.stringify(envelope);
  await page.evaluate(() => {
    const nativePost = Worker.prototype.postMessage;
    const gate = { pending: false, released: false, automaticRelease: false, release: () => {} };
    Object.defineProperty(window, "__rescueGate", { configurable: true, value: gate });
    Worker.prototype.postMessage = function (this: Worker, ...args) {
      const message = args[0];
      if (!gate.pending && message?.kind === "snapshot" && message.reason === "救援外部存档前") {
        gate.pending = true;
        let timer = 0;
        gate.release = () => {
          if (gate.released) return;
          gate.released = true;
          clearTimeout(timer);
          Worker.prototype.postMessage = nativePost;
          Reflect.apply(nativePost, this, args);
        };
        timer = window.setTimeout(() => { gate.automaticRelease = true; gate.release(); }, 60_000);
        return;
      }
      Reflect.apply(nativePost, this, args);
    };
  });
  await panel.getByLabel("选择要导入的存档文件", { exact: true }).setInputFiles({ name: "cancel-damaged.json", mimeType: "application/json", buffer: Buffer.from(raw) });
  const preview = panel.getByRole("region", { name: "存档导入预览", exact: true });
  await preview.getByRole("button", { name: "救援此存档", exact: true }).click();
  const backup = page.waitForEvent("download");
  await preview.getByRole("button", { name: "再次确认并救援", exact: true }).click();
  expect((await backup).suggestedFilename()).toContain("rescue-backup");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __rescueGate: { pending: boolean } }).__rescueGate.pending), { timeout: 60_000 }).toBe(true);
  await expect(panel.locator(".operations-saves")).toHaveAttribute("aria-busy", "true");
  await expect(preview.getByRole("button", { name: "正在准备救援…", exact: true })).toBeDisabled();
  expect((await page.locator(".game-notice").allTextContents()).join(";")).not.toMatch(/二次确认|存档已验证完成/);
  await expect(panel.getByRole("button", { name: "导入存档", exact: true })).toBeDisabled();
  expect(backups).toHaveLength(1);
  const views = touch ? [
    { name: "phone-portrait", width: 390, height: 844 },
    { name: "phone-landscape", width: 844, height: 390 },
    { name: "touch-wide", width: 1280, height: 800 },
  ] : [{ name: "desktop", width: 1440, height: 900 }];
  for (const view of views) {
    await page.setViewportSize({ width: view.width, height: view.height });
    for (const scale of [80, 100, 125, 150, 200]) {
      await page.evaluate((scale) => {
        document.documentElement.dataset.uiFontScale = String(scale);
        document.documentElement.style.setProperty("--ui-font-scale", String(scale / 100));
      }, scale);
      const status = panel.locator('.operations-saves > .file-import-feedback[role="status"]');
      await status.scrollIntoViewIfNeeded();
      await expect.poll(() => status.evaluate((element) => {
        const panel = element.closest('[role="dialog"]') as HTMLElement;
        const bounds = element.getBoundingClientRect();
        const outer = panel.getBoundingClientRect();
        return panel.scrollWidth <= panel.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 && bounds.left >= outer.left - 1 && bounds.right <= outer.right + 1;
      }), { message: `${view.name} ${scale}%` }).toBe(true);
      if (scale === 150) for (const theme of ["dark", "light"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        const contrast = await preview.locator(".save-preview-metrics strong").evaluateAll((values) => values.map((value) => {
          const luminance = (color: string) => {
            const rgb = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((value) => {
              const channel = value / 255;
              return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
            });
            return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
          };
          const color = getComputedStyle(value).color;
          const background = getComputedStyle(value.closest("span")!).backgroundColor;
          const textLuminance = luminance(color), backgroundLuminance = luminance(background);
          return { color, background, ratio: (Math.max(textLuminance, backgroundLuminance) + .05) / (Math.min(textLuminance, backgroundLuminance) + .05) };
        }));
        await testInfo.attach(`${view.name}-${theme}-metric-contrast`, { body: JSON.stringify(contrast), contentType: "application/json" });
        expect(contrast).toHaveLength(4);
        for (const metric of contrast) expect(metric.ratio).toBeGreaterThanOrEqual(4.5);
        await preview.locator(".save-preview-metrics").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `artifacts/review-rescue-lifetime-20261105/${process.env.DSP_REVIEW_CHECK_NAME || "review"}-${view.name}-${theme}.png`, animations: "disabled" });
      }
    }
  }
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
    document.documentElement.dataset.theme = "dark";
  });
  await preview.getByRole("button", { name: "取消", exact: true }).click();
  await expect(preview).toBeHidden();
  await page.evaluate(() => (window as unknown as { __rescueGate: { release(): void } }).__rescueGate.release());
  await expect(panel.locator(".operations-saves")).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
  await expect.poll(async () => (await page.locator(".game-notice").allTextContents()).join(";"), { timeout: 60_000 }).toMatch(/救援完成|取消.*救援|救援.*取消/);
  const notice = (await page.locator(".game-notice").allTextContents()).join(";");
  const gate = await page.evaluate(() => { const gate = (window as unknown as { __rescueGate: { pending: boolean; released: boolean; automaticRelease: boolean } }).__rescueGate; return { pending: gate.pending, released: gate.released, automaticRelease: gate.automaticRelease }; });
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  panel = await openSaves(page);
  const persisted = await exportedEnvelope(page);
  await testInfo.attach("cancelled-rescue-outcome", { body: JSON.stringify({ notice, gate, ore: persisted.state.tray.iron_ore, blueprints: persisted.state.blueprints.length, autosave: persisted.state.settings.autosaveIntervalSeconds, errors }), contentType: "application/json" });
  expect.soft(notice).not.toContain("救援完成");
  expect.soft(persisted.state.tray.iron_ore).toBe(42);
  expect.soft(persisted.state.blueprints).toHaveLength(12);
  expect(persisted.state.settings.autosaveIntervalSeconds).toBe(0);
  expect(gate.automaticRelease).toBe(false);
  await panel.getByLabel("选择要导入的存档文件", { exact: true }).setInputFiles({ name: "cancel-damaged.json", mimeType: "application/json", buffer: Buffer.from(raw) });
  const retry = panel.getByRole("region", { name: "存档导入预览", exact: true });
  await retry.getByRole("button", { name: "救援此存档", exact: true }).click();
  const retryBackup = page.waitForEvent("download");
  await retry.getByRole("button", { name: "再次确认并救援", exact: true }).click();
  expect((await retryBackup).suggestedFilename()).toContain("rescue-backup");
  await expect.poll(async () => (await page.locator(".game-notice").allTextContents()).join(";"), { timeout: 60_000 }).toMatch(/救援完成/);
  await expect(page.locator('.tray-row[title="拿取铁矿石"] strong')).toHaveText("99");
  expect(backups).toHaveLength(2);
  expect(errors).toEqual([]);
});
});
}
