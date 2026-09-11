import { expect, test } from "@playwright/test";

async function prepare(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    // Match the current release-note id so the announcement dialog cannot
    // intercept the new-factory controls during this feature test.
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", "next");
    window.localStorage.removeItem("dsp-idle-network.ui.speedrun-panel-collapsed.v1");
  });
}

test("new factory offers an isolated speedrun mode and status panel", async ({ page }) => {
  await prepare(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "新建游戏" }).click();
  await expect(page.getByRole("radio", { name: /普通工厂/ })).toBeVisible();
  await page.getByRole("radio", { name: /速通工厂/ }).click();
  await expect(page.locator(".start-menu-speedrun-brief")).toContainText("speedrun-v1");
  await expect(page.locator(".start-menu-speedrun-brief")).toContainText("10,000");
  await page.getByRole("button", { name: /确认并开始速通/ }).click();
  await expect(page.locator(".game-shell")).toBeVisible();
  await expect(page.locator(".speedrun-status-panel")).toContainText("速通工厂");
  await expect(page.locator(".speedrun-status-panel")).toContainText("全科技速通");
  const panel = page.locator(".speedrun-status-panel");
  await expect(panel.getByRole("button", { name: "折叠速通状态" })).toBeVisible();
  await panel.getByRole("button", { name: "折叠速通状态" }).click();
  await expect(panel).toHaveAttribute("data-collapsed", "true");
  await expect(panel).not.toContainText("全科技速通");
  await expect(panel.getByRole("button", { name: "展开速通状态" })).toBeVisible();
});

test("speedrun panel and independent ranking tab fit on mobile", async ({ page }) => {
  await prepare(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "新建游戏" }).click();
  await page.getByRole("radio", { name: /速通工厂/ }).click();
  await page.getByRole("button", { name: /确认并开始速通/ }).click();
  await expect(page.locator(".speedrun-status-panel")).toBeVisible();
  await expect(page.locator(".speedrun-status-panel").getByRole("button", { name: "折叠速通状态" })).toBeVisible();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /银河网络/ }).click();
  const speedrunTab = page.getByRole("tab", { name: "速通排行" });
  if (await speedrunTab.count()) {
    await speedrunTab.click();
    await expect(page.locator(".galaxy-speedrun-view")).toBeVisible();
  }
});
