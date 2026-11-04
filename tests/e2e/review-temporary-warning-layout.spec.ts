import { expect, test } from "@playwright/test";
test.use({ hasTouch: true, isMobile: true });

test("temporary warning keeps navigation clear across orientation, themes and font scales", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("isolated layout fixture", "InvalidStateError"); } } });
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("isolated layout fixture", "SecurityError"); } });
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated layout fixture"}' }));
  await page.goto("/?mobileUi=next");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  const closeNotes = page.getByRole("button", { name: "关闭版本更新记录" });
  if (await closeNotes.isVisible()) await closeNotes.click();
  const pause = page.getByRole("button", { name: /^暂停/ }).first();
  if (await pause.isVisible()) await pause.click();
  const banner = page.locator(".local-save-writer-banner--temporary");
  await expect(banner).toBeVisible();
  for (const view of [{ name: "portrait", width: 390, height: 844 }, { name: "landscape", width: 844, height: 390 }, { name: "desktop-width", width: 1280, height: 800 }]) {
    await page.setViewportSize({ width: view.width, height: view.height });
    for (const scale of [80, 100, 125, 150, 200]) {
      await page.evaluate((scale) => {
        document.documentElement.dataset.uiFontScale = String(scale);
        document.documentElement.style.setProperty("--ui-font-scale", String(scale / 100));
      }, scale);
      await expect.poll(() => banner.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const navigation = [...document.querySelectorAll<HTMLElement>(".mobile-next-topbar, .mobile-next-bottom-nav, .game-header")]
          .filter((control) => getComputedStyle(control).display !== "none").map((control) => control.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight);
        const overlaps = navigation.some((rect) => box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top);
        if (overlaps) element.setAttribute("data-test-nav-overlap", JSON.stringify({
          banner: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
          navigation: navigation.map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })),
        }));
        return { inViewport: box.top >= -1 && box.left >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1, navigationClear: !overlaps, noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1 };
      }), { message: `${view.name} ${scale}%` }).toEqual({ inViewport: true, navigationClear: true, noHorizontalOverflow: true });
      if (scale === 150) for (const theme of ["dark", "light"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await page.screenshot({ path: `artifacts/review-temporary-storage-20261105/${process.env.DSP_REVIEW_CHECK_NAME || "layout"}-${view.name}-${theme}.png`, animations: "disabled" });
      }
    }
  }
});
