import { expect, test } from "@playwright/test";

for (const device of [
  { name: "portrait", width: 390, height: 844, touch: true },
  { name: "landscape", width: 844, height: 390, touch: true },
  { name: "desktop", width: 1280, height: 820, touch: false },
]) {
  test.describe(device.name, () => {
    test.use({ viewport: { width: device.width, height: device.height }, hasTouch: device.touch });
    test("recipe cards keep their content, counts and scrolling at every font scale", async ({ page }) => {
      await page.route("**/__catalog_probe__", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' }));
      await page.goto("/__catalog_probe__");
      await page.evaluate(async () => {
        const refresh = await import("/@react-refresh");
        refresh.default.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        const { mountRecipeCatalog } = await import("/tests/fixtures/recipeCatalogProbe.ts");
        window.__catalogSelection = null;
        mountRecipeCatalog(id => { window.__catalogSelection = id; });
      });
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await page.evaluate(scale => document.documentElement.style.setProperty("--ui-font-scale", String(scale)), scale);
        await page.getByLabel("选择当前配方", { exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "配方选择面板" });
        const grid = dialog.locator(".recipe-catalog-grid");
        await expect(dialog).toBeVisible();
        await expect.poll(() => grid.locator(":scope > button").count()).toBeGreaterThan(30);
        if (device.touch) await expect(dialog.getByLabel("搜索配方", { exact: true })).not.toBeFocused();
        const geometry = await dialog.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const grid = element.querySelector<HTMLElement>(".recipe-catalog-grid")!;
          const cards = [...grid.querySelectorAll<HTMLButtonElement>(":scope > button")];
          return {
            inViewport: bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1,
            horizontalOverflow: element.scrollWidth > element.clientWidth + 1 || grid.scrollWidth > grid.clientWidth + 1,
            scrolls: grid.scrollHeight > grid.clientHeight && grid.clientHeight > 60,
            invalidCards: cards.flatMap((card, index) => {
              const box = card.getBoundingClientRect(), heading = card.querySelector("header")!.getBoundingClientRect();
              const materials = card.querySelector(":scope > div")!.getBoundingClientRect();
              const badges = [...card.querySelectorAll("i > b")];
              const clippedGlyph = [...card.querySelectorAll<HTMLElement>(".item-glyph")].some(glyph => glyph.scrollWidth > glyph.clientWidth + 1 || glyph.scrollHeight > glyph.clientHeight + 1);
              const clippedBadge = badges.some(badge => {
                const rect = badge.getBoundingClientRect(), group = badge.parentElement!.parentElement!.getBoundingClientRect();
                return rect.right > group.right + 1 || rect.bottom > group.bottom + 1 || rect.right > box.right - 1;
              });
              return box.height < 83.5 || heading.bottom > materials.top + 1 || materials.bottom > box.bottom - 1 || clippedBadge || clippedGlyph
                ? [{ index, height: box.height, overlap: heading.bottom - materials.top, overflow: materials.bottom - box.bottom, clippedBadge, clippedGlyph }] : [];
            }),
          };
        });
        expect(geometry, `Device ${device.name}, scale ${scale}`).toEqual({ inViewport: true, horizontalOverflow: false, scrolls: true, invalidCards: [] });
        if (scale === 1 || scale === 2) await page.screenshot({ path: `artifacts/qa/recipe-catalog-${device.name}-${scale}-top.png` });
        await grid.evaluate(element => { element.scrollTop = element.scrollHeight; });
        const last = grid.locator(":scope > button").last();
        await expect(last).toBeInViewport();
        await expect(dialog.getByRole("button", { name: "关闭配方选择" })).toBeInViewport();
        await page.screenshot({ path: `artifacts/qa/recipe-catalog-${device.name}-${scale}.png` });
        await dialog.getByRole("button", { name: "关闭配方选择" }).click();
      }
      await page.getByLabel("选择当前配方", { exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "配方选择面板" });
      await dialog.getByLabel("搜索配方", { exact: true }).fill("磁线圈");
      await dialog.locator(".recipe-catalog-grid > button").first().click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.__catalogSelection)).toBe("magnetic_coil");
    });
  });
}
