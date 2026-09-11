import { expect, test, type Page } from "@playwright/test";

const MOBILE_UI_KEY = "dsp-idle-network.mobile-ui.v1";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
  });
});

async function openNextMobile(page: Page, viewport = { width: 390, height: 844 }) {
  await page.setViewportSize(viewport);
  await page.goto("/?mobileUi=next");
  await expect(page.locator('.game-shell[data-mobile-shell="true"]')).toBeVisible();
  await expect(page.locator(".mobile-next-topbar")).toBeVisible();
  await expect(page.locator(".mobile-next-bottom-nav")).toBeVisible();
}

async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    vertical: document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1,
  }))).toEqual({ horizontal: true, vertical: true });
}

async function expectPrimaryTargets(page: Page) {
  const result = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>(".mobile-next-topbar button, .mobile-next-bottom-nav button, .mobile-next-tools-command")]
      .filter((element) => getComputedStyle(element).display !== "none");
    return controls.map((element) => {
      const rect = element.getBoundingClientRect();
      return { label: element.getAttribute("aria-label") ?? element.textContent?.trim(), width: rect.width, height: rect.height };
    });
  });
  expect(result.length).toBeGreaterThanOrEqual(8);
  for (const target of result) {
    expect(target.width, `${target.label} width`).toBeGreaterThanOrEqual(44);
    expect(target.height, `${target.label} height`).toBeGreaterThanOrEqual(44);
  }
}

async function expectCanvasCommandsClearOfTeachingCard(page: Page) {
  const overlap = await page.evaluate(() => {
    const tool = document.querySelector<HTMLElement>(".mobile-next-tools-command");
    const coach = document.querySelector<HTMLElement>(".onboarding-coach");
    if (!tool || !coach || getComputedStyle(tool).display === "none" || getComputedStyle(coach).display === "none") return false;
    const a = tool.getBoundingClientRect();
    const b = coach.getBoundingClientRect();
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  });
  expect(overlap).toBe(false);
}

async function getClickableCanvasNode(page: Page) {
  await page.getByRole("button", { name: "打开画布工具" }).click();
  await page.getByRole("dialog", { name: "画布工具" }).getByRole("button", { name: "定位全部" }).click();

  const nodes = page.locator(".react-flow__node");
  await expect.poll(() => nodes.evaluateAll((elements) => elements.findIndex((element) => {
    const rect = element.getBoundingClientRect();
    const canvas = element.closest(".factory-canvas")?.getBoundingClientRect();
    if (!canvas || rect.width === 0 || rect.height === 0) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const insideCanvas = x >= canvas.left && x <= canvas.right && y >= canvas.top && y <= canvas.bottom;
    return insideCanvas && document.elementFromPoint(x, y)?.closest(".react-flow__node") === element;
  }))).toBeGreaterThanOrEqual(0);

  const index = await nodes.evaluateAll((elements) => elements.findIndex((element) => {
    const rect = element.getBoundingClientRect();
    const canvas = element.closest(".factory-canvas")?.getBoundingClientRect();
    if (!canvas || rect.width === 0 || rect.height === 0) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const insideCanvas = x >= canvas.left && x <= canvas.right && y >= canvas.top && y <= canvas.bottom;
    return insideCanvas && document.elementFromPoint(x, y)?.closest(".react-flow__node") === element;
  }));
  return nodes.nth(index);
}

test("next mobile shell is opt-in, persists across desktop width and keeps the legacy fallback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator('.game-shell[data-mobile-ui="legacy"]')).toBeVisible();
  await expect(page.locator(".mobile-next-topbar")).toHaveCount(0);
  await expect(page.locator(".game-header")).toBeVisible();
  await expect(page.locator(".construction-dock")).toBeVisible();

  await page.getByRole("button", { name: "体验新版手机界面" }).first().click();
  await expect(page.locator('.game-shell[data-mobile-shell="true"]')).toBeVisible();
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), MOBILE_UI_KEY)).toBe("next");
  expect(new URL(page.url()).searchParams.get("mobileUi")).toBe("next");

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /切换经典手机界面/ }).click();
  await expect(page.locator('.game-shell[data-mobile-ui="legacy"]')).toBeVisible();
  await expect(page.locator(".mobile-next-topbar")).toHaveCount(0);
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), MOBILE_UI_KEY)).toBe("legacy");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?mobileUi=next");
  await expect(page.locator('.game-shell[data-mobile-ui="next"][data-mobile-shell="true"][data-compact-layout="desktop"]')).toBeVisible();
  await expect(page.locator(".game-header")).toBeHidden();
  await expect(page.locator(".mobile-next-topbar")).toBeVisible();
  await expect(page.locator(".construction-dock")).toBeHidden();
  await page.screenshot({ path: "artifacts/qa/mobile-next-desktop-1440.png", fullPage: true });
});

test("top bar, five-item navigation and phase-two sheets keep every primary path reachable", async ({ page }) => {
  await openNextMobile(page);
  await expectNoDocumentOverflow(page);
  await expectPrimaryTargets(page);
  await expectCanvasCommandsClearOfTeachingCard(page);
  await expect.poll(() => page.locator(".factory-canvas").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(720);
  const necessaryFontSizes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
    ".mobile-next-topbar strong, .mobile-next-topbar small, .mobile-next-power span, .mobile-next-bottom-nav span",
  )].filter((element) => getComputedStyle(element).display !== "none").map((element) => Number.parseFloat(getComputedStyle(element).fontSize)));
  expect(Math.min(...necessaryFontSizes)).toBeGreaterThanOrEqual(12);
  await page.screenshot({ path: "artifacts/qa/mobile-next-portrait-390.png", fullPage: true });

  await page.getByRole("button", { name: /切换行星，当前/ }).click();
  await expect(page.getByRole("dialog", { name: "切换行星" })).toBeVisible();
  await expect(page.getByRole("button", { name: /打开星图与行星探索/ })).toBeVisible();
  await page.getByRole("button", { name: "关闭切换行星" }).last().click();

  await page.getByRole("button", { name: "打开画布工具" }).click();
  const tools = page.getByRole("dialog", { name: "画布工具" });
  await expect(tools.getByRole("button", { name: /逐点多选/ })).toBeVisible();
  await expect(tools.getByRole("button", { name: /蓝图库/ })).toBeVisible();
  await tools.getByRole("button", { name: "关闭画布工具" }).click();

  await page.getByRole("button", { name: "建造", exact: true }).click();
  const buildSheet = page.getByRole("dialog", { name: "建造" });
  await expect(buildSheet).toBeVisible();
  await expect(page.locator(".construction-dock")).not.toBeVisible();
  const buildTargets = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".mobile-build-sheet button, .mobile-build-sheet input")]
    .filter((element) => getComputedStyle(element).display !== "none")
    .map((element) => ({ label: element.getAttribute("aria-label") ?? element.textContent?.trim(), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
  expect(buildTargets.length).toBeGreaterThan(0);
  for (const target of buildTargets) {
    expect(target.width, `${target.label} width`).toBeGreaterThanOrEqual(44);
    expect(target.height, `${target.label} height`).toBeGreaterThanOrEqual(44);
  }
  await buildSheet.getByRole("button", { name: "关闭建造" }).click();
  await expect(page.locator(".construction-dock")).not.toBeVisible();

  await page.getByRole("button", { name: "物资", exact: true }).click();
  const inventorySheet = page.getByRole("dialog", { name: "物资" });
  await expect(inventorySheet).toBeVisible();
  await expect(page.locator(".resource-rail")).not.toBeVisible();
  await inventorySheet.getByRole("button", { name: "关闭物资" }).click();

  await page.getByRole("button", { name: "科研", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "科技树" })).toBeVisible();
  await expect(page.locator(".mobile-next-topbar--workspace")).toContainText("科技树");
  await expect.poll(() => page.locator(".game-workspace").evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
  await expect(page.locator(".construction-dock")).not.toBeVisible();
  await expect(page.locator(".onboarding-coach")).not.toBeVisible();
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();
  await expect(page.getByRole("dialog", { name: "科技树" })).toHaveCount(0);

  await page.getByRole("button", { name: "更多", exact: true }).click();
  const hub = page.getByRole("dialog", { name: "更多工作区" });
  await expect(hub.getByRole("button", { name: /生产管理/ })).toBeVisible();
  await expect(hub.getByRole("button", { name: /存档管理/ })).toBeVisible();
  await expect(hub.getByRole("button", { name: /^账号/ })).toBeVisible();
  await expect(hub.getByRole("button", { name: /游戏设置/ })).toBeVisible();
  await expect(hub.getByRole("button", { name: /保存并返回主菜单/ })).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/mobile-next-hub-390.png", fullPage: true });

  await hub.getByRole("button", { name: /游戏设置/ }).click();
  await expect(page.getByRole("dialog", { name: "运营中心" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "设置" })).toHaveAttribute("aria-selected", "true");
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();
  await expect(page.getByRole("dialog", { name: "运营中心" })).toHaveCount(0);

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /保存并返回主菜单/ }).click();
  await expect(page.getByRole("alertdialog", { name: "保存并返回主菜单" })).toBeVisible();
  await page.getByRole("button", { name: "继续游戏" }).click();
  await expect(page.locator(".game-shell")).toBeVisible();
});

test("browser back, interface back and root exit confirmation share one mobile stack", async ({ page }) => {
  await openNextMobile(page);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "更多工作区" })).toBeVisible();
  await page.getByRole("button", { name: "命令面板" }).click();
  await expect(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole("dialog", { name: "命令面板" })).toHaveCount(0);
  await expect(page.getByRole("alertdialog", { name: "保存并返回主菜单" })).toHaveCount(0);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "更多工作区" })).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole("dialog", { name: "更多工作区" })).toHaveCount(0);
  await expect(page.locator('.game-shell[data-mobile-route="factory"]')).toBeVisible();

  await page.getByRole("button", { name: "建造", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "建造" })).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.getByRole("dialog", { name: "建造" })).toHaveCount(0);

  await page.evaluate(() => window.history.back());
  const exit = page.getByRole("alertdialog", { name: "保存并返回主菜单" });
  await expect(exit).toBeVisible();
  await exit.getByRole("button", { name: "继续游戏" }).click();
  await expect(exit).toHaveCount(0);
});

test("orientation changes preserve world center, selection, inspector sheet and workspace route", async ({ page }) => {
  await openNextMobile(page);
  const node = await getClickableCanvasNode(page);
  await node.click();
  await expect(node).toHaveClass(/selected/);
  await expect(page.locator('.game-shell[data-mobile-overlay="inspector"][data-mobile-sheet-snap="peek"]')).toBeVisible();
  await expect(page.locator(".mobile-inspector-sheet")).toBeVisible();

  const worldCenter = () => page.locator(".factory-canvas").evaluate((canvas) => {
    const viewport = canvas.querySelector<HTMLElement>(".react-flow__viewport")!;
    const transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const bounds = canvas.getBoundingClientRect();
    return { x: (bounds.width / 2 - transform.m41) / transform.a, y: (bounds.height / 2 - transform.m42) / transform.d, zoom: transform.a };
  });
  const before = await worldCenter();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('.game-shell[data-compact-layout="compact-landscape"]')).toBeVisible();
  await expect(page.locator('.game-shell[data-mobile-overlay="inspector"]')).toBeVisible();
  await expect(node).toHaveClass(/selected/);
  await expect.poll(worldCenter).toMatchObject({ zoom: before.zoom });
  const after = await worldCenter();
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(2);
  await page.locator(".mobile-next-sheet").getByRole("button", { name: /^关闭/ }).click();
  await page.screenshot({ path: "artifacts/qa/mobile-next-landscape-844x390.png", fullPage: true });

  await page.getByRole("button", { name: "科研", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog", { name: "科技树" })).toBeVisible();
  await expect(page.locator('.game-shell[data-mobile-route="workspace"]')).toBeVisible();
});

test("node summary snaps peek to half and full while browser back unwinds one level", async ({ page }) => {
  await openNextMobile(page);
  const node = await getClickableCanvasNode(page);
  await node.click();
  await expect(page.locator('.game-shell[data-mobile-sheet-snap="peek"]')).toBeVisible();
  const inspector = page.locator(".mobile-inspector-sheet");
  await expect(inspector).toBeVisible();
  await inspector.getByRole("button", { name: /^展开/ }).click();
  await expect(page.locator('.game-shell[data-mobile-sheet-snap="half"]')).toBeVisible();
  await expect(inspector.getByRole("button", { name: "完整设置" })).toBeVisible();
  await inspector.getByRole("button", { name: "完整设置" }).click();
  await expect(page.locator('.game-shell[data-mobile-sheet-snap="full"]')).toBeVisible();
  await expect(page.locator(".inspector-panel")).toBeVisible();
  await page.locator(".inspector-panel").getByRole("tab", { name: "基础制造" }).click();
  await expect(page.locator(".inspector-panel").getByRole("tab", { name: "基础制造" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".mobile-next-bottom-nav button")).toHaveCount(5);
  for (const button of await page.locator(".mobile-next-bottom-nav button").all()) await expect(button).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/mobile-stage2-inspector-full-390.png", fullPage: true });

  await page.evaluate(() => window.history.back());
  await expect(page.locator('.game-shell[data-mobile-sheet-snap="half"]')).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.locator('.game-shell[data-mobile-sheet-snap="peek"]')).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.locator('.game-shell[data-mobile-overlay="none"]')).toBeVisible();
});

test("mobile build selection exposes 44px stepper, explicit continuous placement and layout mode", async ({ page }) => {
  await openNextMobile(page);
  await page.getByRole("button", { name: "建造", exact: true }).click();
  const build = page.getByRole("dialog", { name: "建造" });
  const deployable = build.locator(".mobile-build-card:not([disabled])").first();
  await expect(deployable).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/mobile-stage2-build-390.png", fullPage: true });
  await deployable.click();
  const placement = page.getByRole("toolbar", { name: "建筑放置状态" });
  await expect(placement).toBeVisible();
  const stepperTargets = await placement.locator("button").evaluateAll((buttons) => buttons.map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
  for (const target of stepperTargets) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
  }
  await placement.getByRole("button", { name: "增加放置数量" }).click();
  await expect(placement).toContainText("2");
  await placement.getByRole("checkbox", { name: "连续" }).check();
  await expect(placement.getByRole("checkbox", { name: "连续" })).toBeChecked();
  await placement.getByRole("button", { name: /取消/ }).click();
  await expect(placement).toHaveCount(0);

  await page.getByRole("button", { name: "打开画布工具" }).click();
  await page.getByRole("dialog", { name: "画布工具" }).getByRole("button", { name: "移动节点" }).click();
  await expect(page.locator('.game-shell[data-mobile-canvas-mode="layout"]')).toBeVisible();
  await expect(page.getByText("布局模式", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.locator('.game-shell[data-mobile-canvas-mode="browse"]')).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/mobile-stage2-factory-390.png", fullPage: true });
});

test("next mobile manufacturing finds the install-only spray module by player aliases", async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      version: 31,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["proliferator_1"] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await openNextMobile(page);
  await page.getByRole("button", { name: "建造", exact: true }).click();
  const build = page.getByRole("dialog", { name: "建造" });
  await build.getByRole("tab", { name: "制造" }).click();
  const search = build.getByLabel("搜索建造项目");
  for (const term of ["喷涂机", "喷涂模块", "喷涂", "增产"]) {
    await search.fill(term);
    await expect(build.locator(".mobile-build-card").filter({ hasText: "喷涂机" })).toHaveCount(1);
  }
});

test("technology, recipes and star map use route-backed mobile list and detail views", async ({ page }) => {
  await openNextMobile(page);
  await page.getByRole("button", { name: "科研", exact: true }).click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  await expect(technology.locator(".mobile-tech-list")).toBeVisible();
  await technology.getByRole("button", { name: "全部", exact: true }).click();
  await technology.locator(".mobile-workspace-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await technology.locator(".mobile-tech-list button").last().click();
  await expect(page.locator('.game-shell[data-mobile-subview^="infinite:"]')).toBeVisible();
  await expect(technology.locator(".mobile-technology-detail")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/mobile-stage3-technology-detail-390.png", fullPage: true });
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回科技树列表/ }).click();
  await expect(page.locator('.game-shell[data-mobile-subview="none"]')).toBeVisible();
  await expect.poll(() => technology.locator(".mobile-workspace-scroll").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /生产资料库/ }).click();
  const recipes = page.getByRole("dialog", { name: "生产资料库" });
  await expect(recipes.locator(".recipe-index")).toBeVisible();
  await recipes.locator(".recipe-index > button").first().click();
  await expect(page.locator('.game-shell[data-mobile-subview^="item:"]')).toBeVisible();
  await expect(recipes.locator(".recipe-detail")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/mobile-stage3-recipe-detail-390.png", fullPage: true });
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回生产资料库列表/ }).click();

  await recipes.getByRole("button", { name: "建筑设施" }).click();
  const buildingIndex = recipes.locator(".codex-index");
  await expect(buildingIndex).toBeVisible();
  await buildingIndex.getByRole("button", { name: /太阳能板/ }).click();
  await expect(page.locator('.game-shell[data-mobile-subview^="building:"]')).toBeVisible();
  await expect(recipes.locator(".codex-building-detail")).toContainText("基础速度");
  await expect(recipes.locator(".codex-building-detail")).toContainText("制造材料");
  await expect(recipes.locator(".codex-building-detail")).toContainText("解锁科技");
  await page.screenshot({ path: "artifacts/qa/mobile-stage7-building-codex-390.png", fullPage: true });
  await recipes.locator(".codex-building-detail .codex-item-button").first().click();
  await expect(page.locator('.game-shell[data-mobile-subview^="item:"]')).toBeVisible();
  await expect(recipes.locator(".recipe-detail")).toBeVisible();
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回生产资料库列表/ }).click();

  await recipes.getByRole("button", { name: "物流运输", exact: true }).click();
  await expect(recipes.locator(".codex-belt-grid")).toContainText("传送带 Mk.I");
  await expect(recipes.locator(".codex-belt-grid")).toContainText("6 件/秒");
  await expect(recipes.locator(".codex-belt-grid")).toContainText("12 件/秒");
  await expect(recipes.locator(".codex-belt-grid")).toContainText("30 件/秒");
  await expect.poll(() => recipes.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(() => recipes.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/mobile-stage7-library-844x390.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /生产统计/ }).click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await expect(statistics.locator(".mobile-statistics-overview")).toBeVisible();
  await expect.poll(() => statistics.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/mobile-stage3-statistics-390.png", fullPage: true });
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /星图与星际工业/ }).click();
  const starMap = page.getByRole("dialog", { name: "星图" });
  await expect(starMap.locator(".mobile-star-system-list")).toBeVisible();
  await starMap.locator(".mobile-star-system-list__row > button").first().click();
  await expect(page.locator('.game-shell[data-mobile-subview^="system:"]')).toBeVisible();
  await starMap.locator(".mobile-system-planets > button").first().click();
  await expect(page.locator('.game-shell[data-mobile-subview^="planet:"]')).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(page.locator('.game-shell[data-mobile-subview^="system:"]')).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/mobile-stage3-star-system-390.png", fullPage: true });
});

test("every remaining stage-three workspace is opaque, reachable and horizontally contained", async ({ page }) => {
  await openNextMobile(page);
  const cases = [
    { action: /蓝图库/, dialog: "蓝图与待建施工" },
    { action: /戴森规划/, dialog: "戴森球规划" },
    { action: /主线任务/, dialog: "主线任务中心" },
    { action: /银河网络/, dialog: "银河网络" },
    { action: /警报与成就/, dialog: "运营中心" },
    { action: /存档管理/, dialog: "运营中心" },
    { action: /^账号/, dialog: "银河网络" },
  ];
  for (const entry of cases) {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: entry.action }).click();
    const workspace = page.getByRole("dialog", { name: entry.dialog });
    await expect(workspace).toBeVisible();
    await expect.poll(() => workspace.evaluate((element) => {
      const background = getComputedStyle(element).backgroundColor;
      const match = background.match(/[\d.]+/g)?.map(Number) ?? [];
      const alpha = match.length >= 4 ? match[3] : 1;
      return { contained: element.scrollWidth <= element.clientWidth + 1, opaque: alpha >= .99 && Number(getComputedStyle(element).opacity) >= .99 };
    })).toEqual({ contained: true, opaque: true });
    await expect(page.locator(".game-workspace")).toHaveCSS("visibility", "hidden");
    await expect(page.locator(".construction-dock")).not.toBeVisible();
    await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();
    await expect(workspace).toHaveCount(0);
  }

  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  for (const entry of [{ action: /生产资料库/, dialog: "生产资料库" }, { action: /戴森规划/, dialog: "戴森球规划" }, { action: /主线任务/, dialog: "主线任务中心" }, { action: /银河网络/, dialog: "银河网络" }, { action: /游戏设置/, dialog: "运营中心" }]) {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: entry.action }).click();
    const workspace = page.getByRole("dialog", { name: entry.dialog });
    await expect(workspace).toBeVisible();
    await expectNoDocumentOverflow(page);
    await expect.poll(() => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();
  }
});

test("target viewports and all font scales keep the next shell usable without overflow", async ({ page }) => {
  await openNextMobile(page);
  const viewports = [
    { width: 320, height: 568, mode: "compact-portrait" },
    { width: 360, height: 640, mode: "compact-portrait" },
    { width: 390, height: 844, mode: "compact-portrait" },
    { width: 430, height: 932, mode: "compact-portrait" },
    { width: 844, height: 390, mode: "compact-landscape" },
    { width: 768, height: 1024, mode: "medium" },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect(page.locator(`.game-shell[data-compact-layout="${viewport.mode}"]`)).toBeVisible();
    await expectNoDocumentOverflow(page);
    await expectPrimaryTargets(page);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const scale of [80, 100, 125, 150, 200]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.uiFontScale = String(value);
      document.documentElement.style.setProperty("--ui-font-scale", String(value / 100));
    }, scale);
    await expectNoDocumentOverflow(page);
    await expectPrimaryTargets(page);
    await expectCanvasCommandsClearOfTeachingCard(page);
    const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".mobile-next-topbar button, .mobile-next-bottom-nav button")].some((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1));
    expect(clipped, `${scale}% mobile shell controls`).toBe(false);
    if (scale === 200) {
      await page.screenshot({ path: "artifacts/qa/mobile-next-font-200-390.png", fullPage: true });
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await expectNoDocumentOverflow(page);
      const workspaceTopbarClipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".mobile-next-topbar button, .mobile-next-topbar strong")]
        .some((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1));
      expect(workspaceTopbarClipped).toBe(false);
      await page.screenshot({ path: "artifacts/qa/mobile-next-font-200-hub-390.png", fullPage: true });
      await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();

      await page.getByRole("button", { name: "建造", exact: true }).click();
      const sheetClearance = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>(".mobile-build-sheet .mobile-next-sheet__handle");
        const content = document.querySelector<HTMLElement>(".mobile-build-sheet .mobile-next-sheet__content");
        if (!header || !content) return -1;
        return content.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
      });
      expect(sheetClearance).toBeGreaterThanOrEqual(-1);
      const constructionControlsClipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".mobile-build-sheet button")]
        .filter((element) => getComputedStyle(element).display !== "none")
        .some((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1));
      expect(constructionControlsClipped).toBe(false);
      await page.screenshot({ path: "artifacts/qa/mobile-next-font-200-build-390.png", fullPage: true });
      await page.getByRole("dialog", { name: "建造" }).getByRole("button", { name: "关闭建造" }).click();

      await page.setViewportSize({ width: 320, height: 568 });
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await expectNoDocumentOverflow(page);
      const narrowTopbarClipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".mobile-next-topbar button, .mobile-next-topbar strong")]
        .some((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1));
      expect(narrowTopbarClipped).toBe(false);
    }
  }
});
