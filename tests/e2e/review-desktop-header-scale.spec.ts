import { expect, test } from "@playwright/test";
import { workflowTimeoutMs } from "./startup-timeout";

test("desktop header keeps metric text inside the shell at all supported font scales", async ({ page }, testInfo) => {
  test.setTimeout(workflowTimeoutMs(180_000));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-11-05-v1.3.8");
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 47, entities: [], belts: [], construction: {}, tray: { iron_ore: 42 }, paused: true,
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["electromagnetism"] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 0 },
    } }));
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"disposable desktop geometry fixture"}' }));
  await page.goto("/?mobileUi=legacy");
  await expect(page.locator(".factory-canvas")).toBeVisible({ timeout: 60_000 });
  const samples = [];
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    for (const scale of [80, 100, 125, 150, 200]) {
      await page.evaluate((scale) => {
        document.documentElement.dataset.uiFontScale = String(scale);
        document.documentElement.style.setProperty("--ui-font-scale", String(scale / 100));
      }, scale);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const sample = await page.locator(".header-metrics").evaluate((metrics) => {
        const header = metrics.closest("header")!.getBoundingClientRect();
        const outer = metrics.getBoundingClientRect();
        const text = Array.from(metrics.querySelectorAll("span, strong")).map((element) => {
          const box = element.closest(".header-metrics > div")!.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(element);
          const bounds = range.getBoundingClientRect();
          return { text: element.textContent, top: bounds.top, bottom: bounds.bottom, cellTop: box.top, cellBottom: box.bottom,
            fits: bounds.top >= Math.max(header.top, outer.top, box.top) - 1 && bounds.bottom <= Math.min(header.bottom, outer.top + metrics.clientHeight, box.bottom) + 1 };
        });
        return { headerHeight: header.height, metricHeight: outer.height, metricClientHeight: metrics.clientHeight,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, text };
      });
      samples.push({ ...viewport, scale, ...sample });
      expect.soft(sample.text.every((value) => value.fits), `${viewport.width} ${scale}% metric text fits vertically`).toBe(true);
      expect.soft(sample.horizontalOverflow, `${viewport.width} ${scale}% document width`).toBe(false);
      const reachable = [];
      for (const cell of await page.locator(".header-metrics > div").all()) {
        const hit = await cell.evaluate((element) => {
          element.scrollIntoView({ block: "nearest", inline: "nearest" });
          const metrics = element.parentElement!.getBoundingClientRect();
          const value = element.querySelector("strong")!;
          const range = document.createRange(); range.selectNodeContents(value);
          const box = range.getBoundingClientRect();
          const target = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
          return box.left >= metrics.left - 1 && box.right <= metrics.right + 1 && box.top >= metrics.top - 1
            && box.bottom <= metrics.bottom + 1 && Boolean(target && element.contains(target));
        });
        reachable.push(hit);
      }
      Object.assign(samples[samples.length - 1], { reachable });
      expect.soft(reachable.every(Boolean), `${viewport.width} ${scale}% all four metric values can be reached`).toBe(true);
      await page.locator(".header-metrics").evaluate((element) => { element.scrollLeft = 0; });
      if (scale === 200) for (const theme of ["dark", "light"]) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await page.screenshot({ path: `artifacts/review-storage-drafts-20261105/${process.env.DSP_REVIEW_CHECK_NAME || "header"}-${viewport.width}-${theme}.png`, animations: "disabled" });
      }
    }
  }
  await testInfo.attach("desktop-header-text-ranges", { body: JSON.stringify(samples), contentType: "application/json" });
  await testInfo.attach("desktop-header-errors", { body: JSON.stringify(errors), contentType: "application/json" });
  expect(errors).toEqual([]);
});
