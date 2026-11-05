import { expect, test, type Locator, type Page } from "@playwright/test";
import { createInitialState } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";

async function openFabricator(page: Page, mobile: boolean) {
  const offlineReport = page.getByRole("dialog", { name: "离线结算报告", exact: true });
  await page.addLocatorHandler(offlineReport, async () => {
    await offlineReport.getByRole("button", { name: "确认结算", exact: true }).click();
    await expect(offlineReport).toBeHidden();
  });
  const game = createInitialState();
  game.paused = false;
  game.settings.autosaveIntervalSeconds = 0;
  game.settings.reducedMotion = true;
  game.tray.iron_ingot = 100;
  game.tray.copper_ingot = 100;
  game.tray.magnet = 100;
  game.planetTrays.home = game.tray;
  game.entities.find((entity) => entity.id === "vein_iron")!.minerCount = 1;
  await page.addInitScript((save) => {
    localStorage.setItem("dsp-idle-network.save.v1", save);
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-05-v1.3.8");
  }, serializeEnvelope(game));
  await page.goto(`/?mobileUi=${mobile ? "next" : "legacy"}`);
  await expect(page.locator(".game-shell")).toBeVisible();
  if (mobile) {
    await page.getByRole("button", { name: "打开画布工具", exact: true }).click();
    await page.getByRole("dialog", { name: "画布工具" }).getByRole("button", { name: "定位全部", exact: true }).click();
    await page.locator('.react-flow__node[data-id="vein_iron"]').click();
    const summary = page.locator(".mobile-inspector-sheet");
    await summary.getByRole("button", { name: /^展开/ }).click();
    await summary.getByRole("button", { name: "完整设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "完整检查器", exact: true })).toBeVisible();
  }
  await page.locator(".inspector-panel").getByRole("tab", { name: "基础制造", exact: true }).click();
  await page.getByRole("button", { name: "物品手工", exact: true }).click();
  await page.getByRole("button", { name: "详细列表", exact: true }).click();
  return page.getByRole("textbox", { name: "搜索手工配方", exact: true });
}

async function beginNativeComposition(input: Locator, value: string) {
  await input.focus();
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.evaluate((element, text) => {
    const field = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.setSelectionRange(0, text.length);
    // The native pre-edit buffer is present, but input has not arrived yet.
    field.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
  }, value);
}

async function finishNativeComposition(input: Locator, value: string) {
  await input.evaluate((element, text) => {
    const field = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }, value);
}

for (const screen of [
  { name: "desktop", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "portrait", viewport: { width: 390, height: 844 }, mobile: true },
  { name: "landscape", viewport: { width: 844, height: 390 }, mobile: true },
]) {
  test.describe(screen.name, () => {
    test.use({ viewport: screen.viewport, hasTouch: screen.mobile, isMobile: screen.mobile });
    test("fabricator search preserves native IME text through running simulation and keyboard resize", async ({ page }) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const input = await openFabricator(page, screen.mobile);
      const originalInput = await input.elementHandle();
      for (const scale of [0.8, 1, 1.25, 1.5]) {
        await page.evaluate((value) => document.documentElement.style.setProperty("--ui-font-scale", String(value)), scale);
        await input.fill("");
        await beginNativeComposition(input, "dian");
        await page.waitForTimeout(1_200);
        await expect(input).toHaveValue("dian");
        await expect(input).toBeFocused();
        expect(await input.evaluate((element) => [
          (element as HTMLInputElement).selectionStart,
          (element as HTMLInputElement).selectionEnd,
        ])).toEqual([0, 4]);
        expect(await originalInput!.evaluate((element) => element.isConnected)).toBe(true);
        await finishNativeComposition(input, "电路板");
        await expect(input).toHaveValue("电路板");
        await expect(page.locator('[data-output-item="circuit_board"]')).toBeVisible();
        await input.press("Enter");

        await input.fill("");
        await beginNativeComposition(input, "ci");
        await page.setViewportSize({ ...screen.viewport, height: Math.min(420, Math.round(screen.viewport.height * 0.6)) });
        await page.evaluate(() => {
          window.visualViewport?.dispatchEvent(new Event("resize"));
          window.dispatchEvent(new Event("orientationchange"));
        });
        await page.waitForTimeout(700);
        await expect(input).toHaveValue("ci");
        await expect(input).toBeFocused();
        await finishNativeComposition(input, "磁线圈");
        await page.setViewportSize(screen.viewport);
        await expect(page.locator('[data-output-item="magnetic_coil"]')).toBeVisible();
        await input.press("Enter");
        await input.fill("");
        await input.click();
        const history = page.getByLabel("物品手工最近搜索", { exact: true });
        const popupBox = (await history.boundingBox())!;
        const panelBox = (await page.locator(".inspector-panel").boundingBox())!;
        const usableTop = screen.mobile
          ? Math.max(panelBox.y, await page.getByRole("dialog", { name: "完整检查器", exact: true }).locator("header").evaluate((element) => element.getBoundingClientRect().bottom))
          : panelBox.y;
        expect(popupBox.y).toBeGreaterThanOrEqual(usableTop - 1);
        expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
        await history.getByRole("button", { name: "电路板", exact: true }).click();
        await expect(input).toHaveValue("电路板");
        await expect(page.locator('[data-output-item="circuit_board"]')).toBeVisible();
        await page.screenshot({ path: `artifacts/qa/fabricator-search-${screen.name}-${scale}.png`, fullPage: true });
      }
      await input.fill("");
      await input.pressSequentially("abc");
      await page.waitForTimeout(700);
      await expect(input).toHaveValue("abc");
      await expect(page.locator(".fabricator-empty")).toContainText("没有符合条件");
      await input.fill("");
      await expect(page.locator(".handcraft-row")).not.toHaveCount(0);
      await input.click();
      await page.getByRole("button", { name: "清除物品手工搜索历史", exact: true }).click();
      await expect(page.getByLabel("物品手工最近搜索", { exact: true })).toHaveCount(0);
      if (screen.name === "landscape") {
        const maxButton = (await page.getByRole("button", { name: "最大", exact: true }).boundingBox())!;
        const panel = (await page.locator(".inspector-panel").boundingBox())!;
        expect(maxButton.y + maxButton.height).toBeLessThanOrEqual(panel.y + panel.height + 1);
      }
      expect(errors).toEqual([]);
    });
  });
}
