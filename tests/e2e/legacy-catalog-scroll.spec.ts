import { expect, test, type Locator, type Page } from "@playwright/test";

async function scrollList(page: Page, grid: Locator, direction: "up" | "down", browserName: string) {
  const box = (await grid.boundingBox())!;
  const top = Math.max(0, box.y) + 16;
  const bottom = Math.min(page.viewportSize()!.height, box.y + box.height) - 16;
  const x = box.x + box.width * 0.7;
  if (browserName !== "chromium") {
    await page.mouse.move(x, (top + bottom) / 2);
    await page.mouse.wheel(0, direction === "up" ? 500 : -500);
    return;
  }
  const session = await page.context().newCDPSession(page);
  try {
    const start = direction === "up" ? bottom : top;
    const end = direction === "up" ? top : bottom;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: start, id: 1 }] });
    for (let step = 1; step <= 10; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: start + (end - start) * step / 10, id: 1 }] });
      await page.waitForTimeout(25);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}

for (const viewport of [{ width: 390, height: 700 }, { width: 844, height: 390 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true });
    for (const kind of ["recipe", "item"] as const) {
      test(`${kind} catalog keeps native scrolling when CSS inset is unsupported`, async ({ page, browserName }) => {
        test.setTimeout(90_000);
        // Strip the unsupported shorthand before the browser parses each
        // stylesheet, preserving any independent physical-edge fallbacks.
        await page.route(/\.css(?:\?.*)?$/, async route => {
          const response = await route.fetch();
          const body = (await response.text()).replace(/(?<![-\w])inset\s*:\s*[^;]+;/g, "");
          await route.fulfill({ response, body });
        });
        await page.route("**/__catalog_probe__", route => route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>',
        }));
        await page.goto("/__catalog_probe__");
        await page.evaluate(async kind => {
          const refresh = await import("/@react-refresh");
          refresh.default.injectIntoGlobalHook(window);
          window.$RefreshReg$ = () => {};
          window.$RefreshSig$ = () => type => type;
          window.__vite_plugin_react_preamble_installed__ = true;
          const probe = await import("/tests/fixtures/recipeCatalogProbe.ts");
          if (kind === "recipe") probe.mountRecipeCatalog(() => {});
          else probe.mountItemCatalog(() => {});
        }, kind);
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await page.evaluate(scale => {
            document.documentElement.style.setProperty("--ui-font-scale", String(scale));
            document.documentElement.dataset.uiFontScale = String(Math.round(scale * 100));
          }, scale);
          await page.getByRole("button", { name: kind === "recipe" ? "选择当前配方" : "选择物品", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: kind === "recipe" ? "配方选择面板" : "物品选择面板" });
          const grid = dialog.locator(`.${kind}-catalog-grid`);
          const close = dialog.locator("header > button");
          await expect.poll(() => dialog.evaluate(element => element.closest(".accessible-dialog-portal")!.getBoundingClientRect().height)).toBe(viewport.height);
          await expect(close).toBeInViewport({ ratio: 1 });
          const before = await grid.evaluate(element => element.scrollTop);
          await scrollList(page, grid, "up", browserName);
          await expect.poll(() => grid.evaluate(element => element.scrollTop)).toBeGreaterThan(before + 30);
          const lower = await grid.evaluate(element => element.scrollTop);
          await scrollList(page, grid, "down", browserName);
          await expect.poll(() => grid.evaluate(element => element.scrollTop)).toBeLessThan(lower - 30);
          await expect(close).toBeInViewport({ ratio: 1 });
          expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
          await close.click();
          await expect(dialog).toBeHidden();
        }
      });
    }
  });
}
