import { expect, test, type Locator, type Page } from "@playwright/test";

const fontScales = [0.8, 1, 1.25, 1.5, 2];
const devices = [
  { name: "portrait", width: 390, height: 844, touch: true },
  { name: "landscape", width: 844, height: 390, touch: true },
  { name: "desktop", width: 1280, height: 540, touch: false },
];

async function swipe(page: Page, surface: Locator, direction: "up" | "down") {
  const box = (await surface.boundingBox())!;
  const viewport = page.viewportSize()!;
  const top = Math.max(box.y, 0) + 20;
  const bottom = Math.min(box.y + box.height, viewport.height) - 20;
  const start = direction === "up" ? bottom : top;
  const end = direction === "up" ? top : bottom;
  const x = Math.min(box.x + box.width * 0.7, viewport.width - 12);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: start, id: 1 }] });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x, y: start + (end - start) * step / 8, id: 1 }],
      });
      await page.waitForTimeout(25);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}

async function isHittable(target: Locator) {
  return target.evaluate(element => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return box.top >= 0 && box.bottom <= innerHeight && element.contains(document.elementFromPoint(x, y));
  });
}

for (const device of devices) {
  test.describe(device.name, () => {
    test.use({ viewport: { width: device.width, height: device.height }, hasTouch: device.touch });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-13-v1.3.13");
        localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
      });
      await page.route("**/api/**", route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
    });

    test("new game remains reachable by scrolling at every font scale", async ({ page }) => {
      test.setTimeout(90_000);
      await page.goto("/?menu=1");
      await page.getByRole("button", { name: "新建游戏", exact: true }).click();
      await expect(page.locator(".start-menu-new")).toBeVisible();
      const start = page.getByRole("button", { name: "开始新游戏", exact: true });
      const menu = page.locator(".start-menu");
      for (const scale of fontScales) {
        await page.evaluate(scale => {
          document.documentElement.style.setProperty("--ui-font-scale", String(scale));
          document.documentElement.dataset.uiFontScale = String(Math.round(scale * 100));
          document.querySelector(".start-menu")!.scrollTop = 0;
          document.querySelector(".start-menu-workspace")!.scrollTop = 0;
        }, scale);
        for (let attempt = 0; attempt < 8 && !await isHittable(start); attempt++) {
          if (device.touch) await swipe(page, menu, "up");
          else {
            await page.mouse.move(device.width * 0.7, device.height - 30);
            await page.mouse.wheel(0, 400);
          }
        }
        await expect.poll(() => isHittable(start), { message: `${device.name}, scale ${scale}` }).toBe(true);
        if (scale === 1 || scale === 2) await page.screenshot({ path: `artifacts/mobile-feedback-20261113/menu-${device.name}-${scale}.png` });
      }
      if (device.touch) await start.tap();
      else await start.click();
      await expect(page.locator(".game-shell")).toBeVisible({ timeout: 30_000 });
    });

    test("categorized recipe and item lists scroll independently of their fixed controls", async ({ page }) => {
      test.setTimeout(120_000);
      await page.route("**/__catalog_probe__", route => route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>',
      }));
      for (const kind of ["recipe", "item"]) {
        await page.goto("/__catalog_probe__");
        await page.evaluate(async kind => {
          const refresh = await import("/@react-refresh");
          refresh.default.injectIntoGlobalHook(window);
          window.$RefreshReg$ = () => {};
          window.$RefreshSig$ = () => type => type;
          window.__vite_plugin_react_preamble_installed__ = true;
          const probe = await import("/tests/fixtures/recipeCatalogProbe.ts");
          if (kind === "recipe") probe.mountRecipeCatalog(() => {}, true);
          else probe.mountItemCatalog(() => {});
        }, kind);
        for (const scale of fontScales) {
          await page.evaluate(scale => {
            document.documentElement.style.setProperty("--ui-font-scale", String(scale));
            document.documentElement.dataset.uiFontScale = String(Math.round(scale * 100));
          }, scale);
          await page.getByRole("button", { name: kind === "recipe" ? "选择当前配方" : "选择物品", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: kind === "recipe" ? "配方选择面板" : "物品选择面板" });
          const grid = dialog.locator(`.${kind}-catalog-grid`);
          const filter = dialog.getByRole("combobox", { name: "筛选内容分类" });
          await expect.poll(() => filter.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(30);
          await expect.poll(() => filter.evaluate(element => {
            const grid = element.closest(".catalog-picker")!.querySelector(".recipe-catalog-grid, .item-catalog-grid")!;
            return element.getBoundingClientRect().bottom <= grid.getBoundingClientRect().top;
          })).toBe(true);
          await expect.poll(() => grid.evaluate(element => element.clientHeight)).toBeGreaterThan(60);
          const before = await grid.evaluate(element => element.scrollTop);
          if (device.touch) await swipe(page, grid, "up");
          else {
            const box = (await grid.boundingBox())!;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, 500);
          }
          await expect.poll(() => grid.evaluate(element => element.scrollTop)).toBeGreaterThan(before + 30);
          await expect(filter).toBeInViewport({ ratio: 1 });
          await expect(dialog.locator("header > button")).toBeInViewport({ ratio: 1 });
          expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
          if (device.touch) {
            const lower = await grid.evaluate(element => element.scrollTop);
            await swipe(page, grid, "down");
            await expect.poll(() => grid.evaluate(element => element.scrollTop)).toBeLessThan(lower - 30);
          }
          if (scale === 1 || scale === 2) await page.screenshot({ path: `artifacts/mobile-feedback-20261113/${kind}-${device.name}-${scale}.png` });
          const allCount = await grid.locator(":scope > button").count();
          await filter.selectOption("industry");
          await expect(filter).toHaveValue("industry");
          await expect.poll(() => grid.locator(":scope > button").count()).toBeLessThan(allCount);
          await dialog.locator("header > button").click();
        }
      }
    });

    test("canvas detail status stays below the planet navigation", async ({ page }) => {
      await page.addInitScript(() => sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1"));
      await page.goto("/?mobileUi=legacy");
      await expect(page.locator(".game-shell")).toBeVisible();
      const status = page.getByRole("group", { name: "画布自适应细节状态" });
      for (const scale of fontScales) {
        await page.evaluate(scale => {
          document.documentElement.style.setProperty("--ui-font-scale", String(scale));
          document.documentElement.dataset.uiFontScale = String(Math.round(scale * 100));
        }, scale);
        await expect.poll(() => status.evaluate(element => {
          const badge = element.getBoundingClientRect();
          const navigation = document.querySelector(".planet-navigator")!.getBoundingClientRect();
          const flow = document.querySelector(".factory-canvas > .react-flow")!.getBoundingClientRect();
          const tools = document.querySelector(".canvas-selection-tools")!.getBoundingClientRect();
          const overlapsTools = badge.left < tools.right && badge.right > tools.left
            && badge.top < tools.bottom && badge.bottom > tools.top;
          return badge.top >= navigation.bottom && badge.top >= flow.top && badge.bottom <= flow.bottom && !overlapsTools;
        }), { message: `${device.name}, scale ${scale}` }).toBe(true);
        await page.getByRole("button", { name: "折叠行星切换", exact: true }).click();
        await page.getByRole("button", { name: "展开行星切换", exact: true }).click();
        if (scale === 1 || scale === 2) await page.screenshot({ path: `artifacts/mobile-feedback-20261113/canvas-${device.name}-${scale}.png` });
      }
    });

    if (device.touch) {
      test("next mobile canvas detail status stays clear of touch tools", async ({ page }) => {
        await page.addInitScript(() => sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1"));
        await page.goto("/?mobileUi=next");
        await expect(page.locator('.game-shell[data-mobile-shell="true"]')).toBeVisible();
        const status = page.getByRole("group", { name: "画布自适应细节状态" });
        for (const scale of fontScales) {
          await page.evaluate(scale => {
            document.documentElement.style.setProperty("--ui-font-scale", String(scale));
            document.documentElement.dataset.uiFontScale = String(Math.round(scale * 100));
          }, scale);
          await expect.poll(() => status.evaluate(element => {
            const badge = element.getBoundingClientRect();
            const tools = document.querySelector(".mobile-next-tools-command")!.getBoundingClientRect();
            const flow = document.querySelector(".factory-canvas > .react-flow")!.getBoundingClientRect();
            return badge.top >= tools.bottom && badge.bottom <= flow.bottom;
          })).toBe(true);
        }
        await page.getByRole("button", { name: "打开画布工具", exact: true }).tap();
        await expect(page.getByRole("dialog", { name: "画布工具", exact: true })).toBeVisible();
      });
    }
  });
}
