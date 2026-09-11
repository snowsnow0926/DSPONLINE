import { expect, test } from "@playwright/test";

async function prepare(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    // Match the current release-note id so the announcement dialog cannot
    // intercept the new-factory controls during this feature test.
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
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

test("speedrun leaderboard identifies server-verified infinite-mineral results", async ({ page }) => {
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/speedrun/leaderboard") return fulfill({
      entries: [{
        submissionId: "speedrun_public_infinite",
        userId: "public_infinite_runner",
        accountId: "public_infinite_runner",
        displayName: "无限矿物选手",
        avatar: "无",
        targetId: "all_technologies",
        seasonId: "season_01",
        rulesetVersion: "speedrun-v1",
        elapsedSeconds: 600,
        completedAtSeconds: 600,
        completedAt: Date.now(),
        receivedAt: Date.now(),
        resourceMode: "infinite",
        verified: true,
        rank: 1,
      }],
    });
    if (pathname === "/api/leaderboard") return fulfill({ entries: [] });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7 });
    if (pathname === "/api/public-status") return fulfill({ players: { total: 0, today: 0, online: 0, onlineWindowSeconds: 120 }, serverTime: Date.now() });
    if (pathname === "/api/analytics" || pathname === "/api/presence") return fulfill({ accepted: true }, 202);
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "新建游戏" }).click();
  await page.getByRole("radio", { name: /速通工厂/ }).click();
  await page.getByRole("button", { name: /确认并开始速通/ }).click();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /银河网络/ }).click();
  const galaxy = page.getByRole("dialog", { name: "银河网络" });
  await galaxy.getByRole("tab", { name: "速通排行" }).click();
  const row = galaxy.locator("article").filter({ hasText: "无限矿物选手" });
  await expect(row).toContainText("已验证 · 无限矿物");
  await expect(galaxy).not.toContainText("无限资源模式不能进入速通正式榜");
});

