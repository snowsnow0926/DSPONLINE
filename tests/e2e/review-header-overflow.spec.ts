import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }, testInfo) => {
  const errors = pageErrors.get(page) ?? [];
  await testInfo.attach("overflow-page-errors", { body: JSON.stringify(errors), contentType: "application/json" });
  expect(errors).toEqual([]);
});

async function openLegacyFactory(page: Page) {
  page.setDefaultTimeout(30_000);
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-04-v1.3.7");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0 },
    } }));
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated menu focus review"}' }));
  await page.goto("/?mobileUi=legacy");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "更多工作区", exact: true })).toBeVisible();
}

test("legacy overflow keyboard navigation and dismissal", async ({ page }) => {
  await openLegacyFactory(page);
  const trigger = page.getByRole("button", { name: "更多工作区", exact: true });
  await trigger.focus(); await trigger.press("ArrowDown");
  const menu = page.getByRole("menu");
  await expect.soft(menu).toBeVisible({ timeout: 2_000 });
  if (!await menu.isVisible()) await trigger.click();
  const items = menu.getByRole("menuitem");
  await expect.soft(items.first()).toBeFocused({ timeout: 2_000 });
  await items.first().focus(); await page.keyboard.press("End");
  await expect.soft(items.last()).toBeFocused({ timeout: 2_000 });
  await items.last().focus(); await page.keyboard.press("ArrowDown");
  await expect.soft(items.first()).toBeFocused({ timeout: 2_000 });
  await page.keyboard.press("Escape");
  await expect.soft(menu).toBeHidden({ timeout: 2_000 });
  await expect.soft(trigger).toBeFocused({ timeout: 2_000 });
});

test("legacy overflow action returns focus to its persistent opener", async ({ page }) => {
  await openLegacyFactory(page);
  const trigger = page.getByRole("button", { name: "更多工作区", exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "运营中心", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused({ timeout: 2_000 });
});

test("legacy overflow outside pointer closes without reclaiming focus", async ({ page }) => {
  await openLegacyFactory(page);
  await page.getByRole("button", { name: "更多工作区", exact: true }).click();
  const canvas = await page.locator(".factory-canvas").boundingBox();
  const menu = await page.getByRole("menu").boundingBox();
  if (!canvas || !menu) throw new Error("The isolated menu or factory is not rendered");
  const point = { x: canvas.x + 8, y: canvas.y + canvas.height / 2 };
  expect(point.x < menu.x || point.x > menu.x + menu.width || point.y < menu.y || point.y > menu.y + menu.height).toBe(true);
  await page.mouse.click(point.x, point.y);
  await expect.soft(page.getByRole("menu")).toBeHidden({ timeout: 2_000 });
  await expect.soft(page.getByRole("button", { name: "更多工作区", exact: true })).not.toBeFocused({ timeout: 2_000 });
});

test("legacy overflow Escape closes only the menu above an active workspace", async ({ page }) => {
  await openLegacyFactory(page);
  const trigger = page.getByRole("button", { name: "更多工作区", exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const workspace = page.getByRole("dialog", { name: "运营中心", exact: true });
  await expect(workspace).toBeVisible();
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "设置", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect.soft(workspace).toBeVisible({ timeout: 2_000 });
  await expect.soft(menu).toBeHidden({ timeout: 2_000 });
  await expect.soft(trigger).toBeFocused({ timeout: 2_000 });
});

test("legacy overflow Tab leaves the popup and closes it", async ({ page }) => {
  await openLegacyFactory(page);
  await page.getByRole("button", { name: "更多工作区", exact: true }).click();
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem").first().focus();
  await page.keyboard.press("Tab");
  await expect.soft(menu).toBeHidden({ timeout: 2_000 });
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="menu"]')))).toBe(false);
});

test("legacy overflow Space activation does not also toggle simulation", async ({ page }, testInfo) => {
  await openLegacyFactory(page);
  const pause = page.locator('.header-actions > button[aria-keyshortcuts="Space"]');
  await expect(pause).toHaveAttribute("aria-label", "继续模拟");
  await page.getByRole("button", { name: "更多工作区", exact: true }).click();
  const settings = page.getByRole("menuitem", { name: "设置", exact: true });
  await settings.focus();
  await settings.press("Space");
  await testInfo.attach("menu-space-outcome", { body: JSON.stringify({ pauseLabel: await pause.getAttribute("aria-label"), workspaceVisible: await page.getByRole("dialog", { name: "运营中心", exact: true }).isVisible() }), contentType: "application/json" });
  await expect.soft(pause).toHaveAttribute("aria-label", "继续模拟", { timeout: 2_000 });
  await expect(page.getByRole("dialog", { name: "运营中心", exact: true })).toBeVisible();
  await expect(pause).toHaveAttribute("aria-label", "继续模拟");
});

test("legacy overflow fits the compact viewport at every supported text scale", async ({ page }, testInfo) => {
  await openLegacyFactory(page);
  const samples = [];
  for (const viewport of [{ width: 700, height: 700 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    for (const scale of [80, 100, 125, 150, 200]) {
      await page.evaluate((scale) => {
        document.documentElement.dataset.uiFontScale = String(scale);
        document.documentElement.style.setProperty("--ui-font-scale", String(scale / 100));
      }, scale);
      const trigger = page.getByRole("button", { name: "更多工作区", exact: true });
      if (await page.getByRole("menu").isVisible()) await trigger.click();
      await trigger.click();
      const menu = page.getByRole("menu");
      const last = menu.getByRole("menuitem").last();
      await last.focus();
      const sample = await last.evaluate((item) => {
        const bounds = item.getBoundingClientRect();
        const menu = item.closest('[role="menu"]')!;
        const outer = menu.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return { menuTop: outer.top, menuBottom: outer.bottom, itemBottom: bounds.bottom,
          fits: outer.top >= 0 && outer.bottom <= innerHeight && outer.left >= 0 && outer.right <= innerWidth,
          reachable: bounds.top >= 0 && bounds.bottom <= innerHeight && Boolean(hit && item.contains(hit)),
          noHorizontalScroll: menu.scrollWidth <= menu.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 };
      });
      samples.push({ ...viewport, scale, ...sample });
      expect.soft(sample.fits, `menu fits ${viewport.width}x${viewport.height} ${scale}%`).toBe(true);
      expect.soft(sample.reachable, `last action reachable ${viewport.width}x${viewport.height} ${scale}%`).toBe(true);
      expect.soft(sample.noHorizontalScroll).toBe(true);
      if (scale === 150) for (const theme of ["dark", "light"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await page.screenshot({ path: `artifacts/review-header-overflow-20261105/${process.env.DSP_REVIEW_CHECK_NAME || "review"}-${viewport.width}x${viewport.height}-${theme}.png`, animations: "disabled" });
      }
    }
  }
  await testInfo.attach("overflow-viewport-geometry", { body: JSON.stringify(samples), contentType: "application/json" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("button", { name: "更多工作区", exact: true })).toBeHidden();
  await expect.soft(page.getByRole("menu")).toBeHidden({ timeout: 2_000 });
  await expect(page.getByRole("button", { name: "打开设置", exact: true })).toBeVisible();
  await page.screenshot({ path: `artifacts/review-header-overflow-20261105/${process.env.DSP_REVIEW_CHECK_NAME || "review"}-1440x900-desktop.png`, animations: "disabled" });
});
