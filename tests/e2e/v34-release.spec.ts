import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
  });
});

async function dismissOnboarding(page: Page) {
  const control = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await control.count()) await control.first().click();
}

async function seedMegastructureSave(page: Page, fontScale = 1) {
  await page.addInitScript((scale) => {
    const state = {
      version: 33,
      nextId: 100,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: { micro_black_hole_connector: 1, time_warp_device: 1 },
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      settings: { fontScale: scale, simulationSpeed: 1, autosaveIntervalSeconds: 30 },
      research: {
        selectedTechId: null,
        pausedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["universe_matrix", "artificial_star", "micro_black_hole_containment", "time_warp_engineering"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  }, fontScale);
}

test("desktop construction closes the micro-black-hole and time-warp interaction loop", async ({ page }) => {
  await seedMegastructureSave(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await dismissOnboarding(page);

  const blackHoleDock = page.locator(".construction-item-shell").filter({ hasText: "微型黑洞连接装置" });
  const timeWarpDock = page.locator(".construction-item-shell").filter({ hasText: "时间扭曲装置" });
  await expect(blackHoleDock).toBeVisible();
  await expect(timeWarpDock).toBeVisible();

  await blackHoleDock.locator(".construction-item").click();
  await page.locator(".react-flow__pane").click({ position: { x: 650, y: 360 } });
  const blackHole = page.locator(".react-flow__node").filter({ hasText: "微型黑洞连接装置" });
  await expect(blackHole).toContainText("已暂停");
  await blackHole.locator(".factory-node__header").click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector).toContainText("输入物资将被永久销毁且无法找回");
  await expect(inspector.locator(".black-hole-port-list > div")).toHaveCount(3);

  await inspector.getByRole("button", { name: "启动微型黑洞" }).click();
  await page.locator(".game-dialog").getByRole("button", { name: "继续确认" }).click();
  await page.locator(".game-dialog").getByRole("button", { name: "确认启动" }).click();
  await expect(inspector.getByRole("button", { name: "暂停销毁" })).toBeVisible();

  await timeWarpDock.locator(".construction-item").click();
  await page.locator(".react-flow__pane").click({ position: { x: 1050, y: 360 } });
  const timeWarp = page.locator(".react-flow__node").filter({ hasText: "时间扭曲装置" });
  await timeWarp.locator(".factory-node__header").click();
  await expect(inspector).toContainText("当前主控");
  await expect(inspector.getByLabel("时间扭曲请求倍率")).toBeVisible();
  const exactPower = inspector.locator(".power-value").first();
  await expect(exactPower).toHaveAttribute("aria-label", / kW$/);
  await exactPower.click();
  const exactPowerTooltip = page.getByRole("tooltip").filter({ hasText: "kW" });
  await expect(exactPowerTooltip).toBeVisible();
  await inspector.getByRole("button", { name: "倍率加一" }).click();
  await expect(inspector.getByLabel("时间扭曲请求倍率").locator("input")).toHaveValue("6");
  await expect(exactPowerTooltip).toBeHidden();
  await expect(inspector).toContainText("离线收益与活动时钟始终使用真实时间");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator(".react-flow__pane").hover({ position: { x: 24, y: 24 } });
  const nodePower = timeWarp.locator(".power-value").first();
  await expect.poll(() => nodePower.evaluate((element) => !element.matches(":hover"))).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v100-megastructures-desktop-1920x1080.png", fullPage: true });
});

test("next mobile construction finds both v1.0 megastructures at 200 percent font", async ({ page }) => {
  await seedMegastructureSave(page, 2);
  for (const gate of [
    { width: 390, height: 844, shot: "mobile-390-font-200" },
    { width: 430, height: 932, shot: "mobile-430-font-200" },
    { width: 844, height: 390, shot: "mobile-844x390-font-200" },
    { width: 768, height: 1024, shot: "tablet-768x1024-font-200" },
  ]) {
    await page.setViewportSize({ width: gate.width, height: gate.height });
    await page.goto("/?mobileUi=next");
    await dismissOnboarding(page);
    await page.getByRole("button", { name: "建造", exact: true }).click();
    const build = page.getByRole("dialog", { name: "建造" });
    await build.getByRole("button", { name: "展开建造" }).click();
    const search = build.getByLabel("搜索建造项目");
    await search.fill("微型黑洞");
    await expect(build).toContainText("微型黑洞连接装置");
    await search.fill("时间扭曲");
    const result = build.getByRole("button", { name: /时间扭曲装置.*施工库存/ });
    await result.scrollIntoViewIfNeeded();
    await expect(result).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/qa/v100-megastructures-${gate.shot}.png`, fullPage: true });
  }
});

test("Dyson command bar stays reachable across desktop height and font gates", async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      version: 14,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: {},
      planetTrays: { home: {}, frost: {} },
      totalProduced: {},
      settings: { fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30 },
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["dyson_sphere_program", "dyson_shell", "dyson_swarm"] },
      exploration: { unlockedSystemIds: ["helios", "borealis"] },
      blueprints: [],
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });

  for (const gate of [
    { width: 1920, height: 1080, fontScale: "100", shot: "desktop-1920x1080" },
    { width: 1536, height: 864, fontScale: "125", shot: "desktop-1536x864-font-125" },
    { width: 1280, height: 720, fontScale: "150", shot: "desktop-1280x720-font-150" },
    { width: 1024, height: 768, fontScale: "125", shot: "tablet-1024x768-font-125" },
    { width: 960, height: 540, fontScale: "200", shot: "desktop-960x540-font-200" },
  ]) {
    await page.setViewportSize({ width: gate.width, height: gate.height });
    await page.goto("/");
    await dismissOnboarding(page);
    await page.evaluate((fontScale) => {
      document.documentElement.dataset.uiFontScale = fontScale;
    }, gate.fontScale);
    const directEntry = page.getByRole("button", { name: "打开戴森球规划", exact: true });
    try {
      await directEntry.click({ timeout: 5_000 });
    } catch {
      await page.getByLabel("更多工作区").click();
      await page.getByRole("menuitem", { name: "戴森球规划" }).click();
    }
    const planner = page.getByRole("dialog", { name: "戴森球规划" });
    const plannerBox = await planner.boundingBox();
    expect(plannerBox).not.toBeNull();
    for (const name of ["复制当前壳层设计", "粘贴壳层副本", "保存主存档", "关闭戴森球规划"]) {
      const button = planner.getByLabel(name);
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(plannerBox!.x);
      expect(box!.y).toBeGreaterThanOrEqual(plannerBox!.y);
      expect(box!.x + box!.width).toBeLessThanOrEqual(plannerBox!.x + plannerBox!.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(plannerBox!.y + plannerBox!.height + 1);
    }
    await planner.getByLabel("保存主存档").click();
    await expect(planner.locator(".dyson-planner-save-feedback")).toBeVisible();
    await page.screenshot({ path: `artifacts/qa/v100-dyson-${gate.shot}.png`, fullPage: true });
    await planner.getByLabel("关闭戴森球规划").click();
  }
});
