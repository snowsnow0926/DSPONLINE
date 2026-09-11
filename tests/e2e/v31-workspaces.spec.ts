import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
  });
});

async function openFactory(page: Page, viewport = { width: 1440, height: 900 }, query = "/") {
  await page.setViewportSize(viewport);
  await page.goto(query);
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".react-flow__pane")).toBeVisible({ timeout: 15_000 });
}

test("every primary desktop workspace entry toggles its own workspace closed", async ({ page }) => {
  await openFactory(page);
  const cases = [
    { open: "打开设置", close: "设置已打开，再次点击返回工厂", workspace: ".operations-workspace" },
    { open: "打开银河网络", close: "银河网络已打开，再次点击返回工厂", workspace: ".galaxy-workspace" },
    { open: "打开主线任务中心", close: "主线任务已打开，再次点击返回工厂", workspace: ".campaign-workspace" },
    { open: "打开星图", close: "星图已打开，再次点击返回工厂", workspace: ".star-map-workspace" },
    { open: "打开生产统计", close: "生产统计已打开，再次点击返回工厂", workspace: ".statistics-workspace" },
    { open: "打开生产资料库", close: "生产资料库已打开，再次点击返回工厂", workspace: ".recipe-workspace" },
    { open: "打开科技树", close: "科技树已打开，再次点击返回工厂", workspace: ".technology-workspace" },
  ] as const;

  for (const entry of cases) {
    await page.locator(".game-header").getByLabel(entry.open).click();
    await expect(page.locator(entry.workspace)).toBeVisible();
    const active = page.locator(".game-header").getByLabel(entry.close);
    await expect(active).toHaveAttribute("aria-pressed", "true");
    await active.click();
    await expect(page.locator(entry.workspace)).toHaveCount(0);
    await expect(page.locator(".factory-canvas")).toBeVisible();
  }
});

test("theme and technology layout controls apply immediately and sorters stay hidden", async ({ page }) => {
  await openFactory(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByLabel("界面主题").getByRole("button", { name: "亮色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
  await page.screenshot({ path: "artifacts/qa/v31-light-theme-1440.png", fullPage: true });
  await page.locator(".game-header").getByLabel("设置已打开，再次点击返回工厂").click();
  await expect.poll(() => page.locator(".factory-canvas").evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgb(9, 13, 12)");
  await page.screenshot({ path: "artifacts/qa/v31-light-factory-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  await technology.getByRole("button", { name: "精简", exact: true }).click();
  await expect(technology.locator(".technology-tree")).toHaveClass(/technology-tree--compact/);
  await expect(technology.locator(".technology-node").first()).toContainText(/\S+/);
  await page.screenshot({ path: "artifacts/qa/v31-technology-compact-light-1440.png", fullPage: true });
  await page.locator(".game-header").getByLabel("科技树已打开，再次点击返回工厂").click();

  await page.locator(".game-header").getByLabel("打开生产资料库").click();
  const library = page.getByRole("dialog", { name: "生产资料库" });
  await library.getByRole("button", { name: "物流运输", exact: true }).click();
  await expect(library).not.toContainText("分拣器 Mk.I");
  await expect(library).not.toContainText("兼容分拣器施工件");
});

test("settings opens a category overview and returns without changing the selected save", async ({ page }) => {
  await openFactory(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  const overview = operations.locator(".settings-category-overview");
  await expect(overview).toBeVisible();
  await overview.getByRole("button", { name: /存档与云同步/ }).click();
  await expect(overview).toBeHidden();
  await expect(operations.getByRole("button", { name: "返回设置分类" })).toBeVisible();
  await expect(operations.locator(".settings-group[data-settings-category='storage']").first()).toBeVisible();
  await operations.getByRole("button", { name: "返回设置分类" }).click();
  await expect(overview).toBeVisible();
  await expect(page.locator(".game-shell")).toBeVisible();
});

test("each planet restores its last canvas viewport", async ({ page }) => {
  await openFactory(page);
  await page.addInitScript(() => {
    const key = "dsp-idle-network.save.v1";
    const envelope = JSON.parse(window.localStorage.getItem(key)!);
    const state = envelope.state;
    if (!state.research.completedTechIds.includes("interstellar_logistics")) state.research.completedTechIds.push("interstellar_logistics");
    for (const planetId of ["ashen", "giant"]) {
      if (!state.exploration.colonizedPlanetIds.includes(planetId)) state.exploration.colonizedPlanetIds.push(planetId);
    }
    window.localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.reload();
  await expect(page.getByTitle("切换到烬原 II")).toBeEnabled();

  const pan = async (dx: number, dy: number) => {
    const bounds = await page.locator(".react-flow__pane").boundingBox();
    if (!bounds) throw new Error("factory pane is unavailable");
    const x = bounds.x + bounds.width * 0.5;
    const y = bounds.y + bounds.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up({ button: "middle" });
    await page.waitForTimeout(120);
  };
  const transform = () => page.locator(".react-flow__viewport").evaluate((element) => getComputedStyle(element).transform);

  await pan(150, 70);
  const homeViewport = await transform();
  await page.getByTitle(/切换到澄海 I/).click();
  await expect.poll(transform).toBe(homeViewport);
  await page.getByTitle("切换到烬原 II").click();
  await page.waitForTimeout(260);
  await pan(-90, -45);
  const ashenViewport = await transform();
  expect(ashenViewport).not.toBe(homeViewport);
  await page.getByTitle(/切换到澄海 I/).click();
  await expect.poll(transform).toBe(homeViewport);

  await page.getByTitle("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  const savedViewport = await page.evaluate(() => {
    const envelope = JSON.parse(window.localStorage.getItem("dsp-idle-network.save.v1")!);
    return envelope.state.planetViewports.home;
  });
  expect(savedViewport.zoom).toBeGreaterThanOrEqual(0.25);
  expect(Math.abs(savedViewport.x - 510) + Math.abs(savedViewport.y - 250)).toBeGreaterThan(10);
});

test("next mobile navigation closes technology and more when their active buttons are pressed again", async ({ page }) => {
  await openFactory(page, { width: 390, height: 844 }, "/?mobileUi=next");
  await expect(page.locator('.game-shell[data-mobile-shell="true"]')).toBeVisible();

  await page.getByRole("button", { name: "科研", exact: true }).click();
  await expect(page.locator(".mobile-technology")).toBeVisible();
  await page.getByRole("button", { name: "科研", exact: true }).click();
  await expect(page.locator(".mobile-technology")).toHaveCount(0);
  await expect(page.locator('.game-shell[data-mobile-route="factory"]')).toBeVisible();

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.locator(".mobile-next-workspace-hub")).toBeVisible();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.locator(".mobile-next-workspace-hub")).toHaveCount(0);
  await expect(page.locator('.game-shell[data-mobile-route="factory"]')).toBeVisible();
});

test("light theme covers the next mobile shell and factory cards", async ({ page }) => {
  await openFactory(page, { width: 390, height: 844 }, "/?mobileUi=next");
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /游戏设置/ }).click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByLabel("界面主题").getByRole("button", { name: "亮色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "工厂", exact: true }).click();
  await expect(page.locator('.game-shell[data-mobile-route="factory"]')).toBeVisible();
  await expect.poll(() => page.locator(".mobile-next-topbar").evaluate((element) => {
    const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    return channels.reduce((sum, channel) => sum + channel, 0);
  })).toBeGreaterThan(700);
  await page.screenshot({ path: "artifacts/qa/v31-light-mobile-390.png", fullPage: true });
});
