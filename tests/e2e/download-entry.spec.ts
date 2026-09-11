import { expect, test } from "@playwright/test";

test("web main menu exposes the Shanghai client download entry", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46"));
  await page.goto("/");
  const download = page.getByRole("link", { name: /客户端下载/ });
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute("href", "https://download.dsponline.cn/");
  await expect(download).toHaveAttribute("target", "_blank");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => download.evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeGreaterThanOrEqual(44);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/download-entry-390x844.png", fullPage: true });
});

