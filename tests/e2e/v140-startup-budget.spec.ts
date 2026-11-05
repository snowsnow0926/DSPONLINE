import { expect, test } from "@playwright/test";
import { workflowTimeoutMs } from "./startup-timeout";

const MEBIBYTE = 1024 * 1024;
const STARTUP_BUDGET = Object.freeze({
  maximumLongTaskMs: 1_000,
  totalLongTaskMs: 2_000,
  peakHeapBytes: 192 * MEBIBYTE,
});

type StartupSample = {
  longTasks: number[];
  peakHeapBytes: number;
  samples: number;
  stop: boolean;
};

declare global {
  interface Window {
    __DSP_STARTUP_BUDGET__?: StartupSample;
  }
}

test("Chinese main-menu startup stays inside long-task and heap budgets", async ({ page }) => {
  test.setTimeout(workflowTimeoutMs(60_000));
  await page.addInitScript(() => {
    const memory = () => (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize ?? 0;
    const sample: StartupSample = {
      longTasks: [],
      peakHeapBytes: memory(),
      samples: 1,
      stop: false,
    };
    window.__DSP_STARTUP_BUDGET__ = sample;
    if (typeof PerformanceObserver !== "undefined") {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) sample.longTasks.push(entry.duration);
        });
        observer.observe({ type: "longtask", buffered: true });
        window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
      } catch {
        // Long Task API is Chromium-only. The heap and resource assertions
        // still run on compatible engines in the nightly browser matrix.
      }
    }
    const takeHeapSample = () => {
      sample.peakHeapBytes = Math.max(sample.peakHeapBytes, memory());
      sample.samples += 1;
      if (!sample.stop) window.setTimeout(takeHeapSample, 25);
    };
    window.setTimeout(takeHeapSample, 0);
    localStorage.setItem("dsp-idle-network.locale.v1", "zh-CN");
  });

  await page.goto("/?menu=1", { waitUntil: "domcontentloaded" });
  const releaseNotes = page.getByRole("dialog", { name: /版本|更新/ });
  if (await releaseNotes.isVisible().catch(() => false)) {
    await releaseNotes.getByRole("button", { name: /关闭|知道了|开始/ }).first().click();
  }
  await expect(page.locator(".start-menu")).toBeVisible();
  await expect(page.locator(".start-menu-footer")).toContainText("模拟核心按需载入");
  await page.waitForTimeout(750);

  const result = await page.evaluate(() => {
    const sample = window.__DSP_STARTUP_BUDGET__;
    if (!sample) throw new Error("startup budget sampler did not initialize");
    sample.stop = true;
    const resources = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => /\.(?:js|css)(?:\?|$)/.test(name));
    return {
      longTaskCount: sample.longTasks.length,
      maximumLongTaskMs: Math.max(0, ...sample.longTasks),
      totalLongTaskMs: sample.longTasks.reduce((sum, value) => sum + value, 0),
      peakHeapBytes: sample.peakHeapBytes,
      samples: sample.samples,
      forbiddenResources: resources.filter((name) => /game-core|FactoryRuntime|flow-vendor|legacyTranslations|storage-/i.test(name)),
    };
  });

  expect(result.samples).toBeGreaterThan(2);
  expect(result.forbiddenResources).toEqual([]);
  expect(result.maximumLongTaskMs).toBeLessThanOrEqual(STARTUP_BUDGET.maximumLongTaskMs);
  expect(result.totalLongTaskMs).toBeLessThanOrEqual(STARTUP_BUDGET.totalLongTaskMs);
  if (result.peakHeapBytes > 0) expect(result.peakHeapBytes).toBeLessThanOrEqual(STARTUP_BUDGET.peakHeapBytes);
  console.info("V140_STARTUP_BUDGET", JSON.stringify({ budget: STARTUP_BUDGET, result }));
});
