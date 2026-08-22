import { expect, test } from "@playwright/test";

test("production Web build keeps anonymous cloud health online", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, mailProvider: "disabled" }),
  }));
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "web-platform-cloudfix");
  });
  await page.goto("/?menu=1");
  const nodeState = page.locator(".start-menu-node-state");
  await expect(nodeState).toContainText("云端未登录", { timeout: 15_000 });
  await expect(nodeState).not.toContainText("云端离线");
});
