import { expect, test, type Page } from "@playwright/test";

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
  });
});

async function seedFactory(page: Page) {
  // The app migrates the primary save to IndexedDB before mounting. Seed the
  // fixture before boot so the same path is exercised as a real fresh browser.
  await page.goto("/version.json");
  await page.evaluate(async () => {
    const { createInitialState, placeBuilding } = await import("/src/game/engine.ts");
    let state = createInitialState(27_101, false);
    state.paused = true;
    state.construction.arc_smelter = 12;
    state.construction.conveyor_belt_mk1 = 12;
    state = placeBuilding(state, "arc_smelter", { x: -80, y: -100 });
    state = placeBuilding(state, "arc_smelter", { x: 80, y: -100 });
    const raw = JSON.stringify({ savedAt: Date.now(), state });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dsp-idle-network.local-saves", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) request.result.createObjectStore("records", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      transaction.objectStore("records").put({
        key: "dsp-idle-network.save.v1",
        value: raw,
        updatedAt: Date.now(),
        bytes: new TextEncoder().encode(raw).byteLength,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
  await page.goto("/");
  await expect(page.locator(".game-shell")).toBeVisible();
}

test("connection point preference changes visual scale and hit configuration", async ({ page }) => {
  await seedFactory(page);
  await page.getByLabel("打开设置").click();
  const settings = page.getByRole("dialog", { name: "运营中心" });
  await settings.locator(".settings-category-tabs").getByRole("button", { name: "交互与控制", exact: true }).click();
  await expect(settings.getByRole("button", { name: "放大 50%", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "放大 50%", exact: true }).click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-connection-point-size", "large50");
  await expect.poll(() => page.locator(".react-flow__node .factory-handle").first().evaluate((element) => getComputedStyle(element).width)).toBe("27px");
});

test("desktop mixed selection exposes atomic batch increase controls", async ({ page }) => {
  await seedFactory(page);
  await page.getByLabel("框选模式").click();
  const nodes = page.locator('.react-flow__node').filter({ hasText: "熔炉" });
  await expect(nodes).toHaveCount(2);
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ["Shift"] });
  const toolbar = page.locator(".selection-toolbar");
  await expect(toolbar).toBeVisible();
  await toolbar.locator('button[title="批量增加 1"]').click();
  await expect(page.locator(".game-dialog")).toContainText("批量增加");
  await page.getByRole("button", { name: "批量增加" }).click();
  await expect(page.locator(".game-notice, .interaction-burst")).toContainText(/已批量增加/);
});

test("next mobile selection keeps multiple nodes selected after a canvas refresh", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", "next"));
  await seedFactory(page);
  await page.getByLabel("打开画布工具").click();
  await page.getByRole("button", { name: "逐点多选" }).click();
  // The mobile shell hides React Flow's visual controls; invoke fit-view
  // through the existing control so both seeded nodes receive a touch target.
  await page.locator(".react-flow__controls-fitview").evaluate((element) => (element as HTMLButtonElement).click());
  await page.waitForTimeout(120);
  const nodes = page.locator('.react-flow__node').filter({ hasText: "熔炉" });
  await nodes.nth(0).tap();
  await nodes.nth(1).tap();
  await expect(page.locator(".mobile-mode-status--select")).toContainText("2 节点");
  await page.waitForTimeout(400);
  await expect(page.locator(".mobile-mode-status--select")).toContainText("2 节点");
});
