import { expect, test, type Page } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-11-v1.0.38";

async function seedBatchSave(page: Page, options: { offlineSeconds?: number; paused?: boolean; topology?: boolean; bypassMenu?: boolean } = {}) {
  await page.addInitScript(({ offlineSeconds, paused, topology, bypassMenu, releaseNoteId }) => {
    const base = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      routingCursor: 0,
      progress: 0,
      utilization: 0,
      productionRate: 0,
      inputs: {},
      outputs: {},
    };
    const entities = topology ? [
      { ...base, id: "topology-source", kind: "storage", position: { x: -380, y: -80 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", outputs: { iron_ingot: 20 } },
      { ...base, id: "topology-target", kind: "storage", position: { x: 380, y: -80 }, buildingId: "storage_mk1", storedItemId: "iron_ingot" },
      { ...base, id: "locked-smelter", kind: "machine", position: { x: 0, y: 260 }, buildingId: "arc_smelter", recipeId: "iron_ingot", interactionLocked: true, outputs: { steel: 4 } },
    ] : [
      { ...base, id: "offline-iron", kind: "vein", position: { x: -220, y: -80 }, resourceId: "iron_ore", extractorBuildingId: "mining_machine", machineCount: 0, minerCount: 1, outputs: { iron_ore: 0 } },
      { ...base, id: "offline-wind", kind: "power", position: { x: 140, y: -80 }, buildingId: "wind_turbine", machineCount: 3, powerOutputKw: 0 },
    ];
    const belts = topology ? [
      { id: "zero-tick-belt", planetId: "home", source: "topology-source", target: "topology-target", itemId: "iron_ingot", lanes: 3, tier: 1, sorterTier: 1, progress: 0, priority: 1, stackSize: 1, monitorEnabled: false, totalTransferred: 0, congestion: 0, lastFlow: 0, routeMode: "auto" },
      { id: "stale-output-belt", planetId: "home", source: "locked-smelter", target: "topology-target", itemId: "steel", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1, stackSize: 1, monitorEnabled: false, totalTransferred: 0, congestion: 0, lastFlow: 0, routeMode: "auto" },
    ] : [];
    const state = {
      version: 45,
      nextId: 20,
      activePlanetId: "home",
      entities,
      belts,
      tray: { iron_ingot: 20 },
      planetTrays: { home: { iron_ingot: 20 } },
      planetTrayItemLimits: { home: 100_000_000 },
      construction: { conveyor_belt_mk1: 99, wind_turbine: 1 },
      constructionAutomation: { enabled: true, targetStock: { conveyor_belt_mk1: 100 }, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {}, jobs: {} },
      portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["electromagnetism", "basic_smelting", "basic_logistics"] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 600 },
      elapsedSeconds: 120,
      paused,
    };
    if (bypassMenu) window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    else window.sessionStorage.removeItem("dsp-idle-network.test-bypass-menu");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.experimental-approximate-offline.v1", "true");
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({
      savedAt: Date.now() - offlineSeconds * 1_000,
      state,
    }));
  }, {
    offlineSeconds: options.offlineSeconds ?? 0,
    paused: options.paused ?? false,
    topology: options.topology ?? false,
    bypassMenu: options.bypassMenu ?? true,
    releaseNoteId: RELEASE_NOTE_ID,
  });
}

for (const scenario of [
  { name: "exact", seconds: 6, label: "精确结算", viewport: { width: 1280, height: 720 } },
  { name: "fallback", seconds: 33, label: "已确认跳过收益", viewport: { width: 1024, height: 768 } },
  { name: "approximate", seconds: 120, label: "近似宏观结算（实验）", viewport: { width: 390, height: 844 } },
] as const) {
  test(`offline report renders the ${scenario.name} settlement state without overflow`, async ({ page }) => {
    await seedBatchSave(page, { offlineSeconds: scenario.seconds, bypassMenu: false });
    await page.setViewportSize(scenario.viewport);
    await page.goto("/?menu=1");
    await page.getByRole("button", { name: /继续游戏/ }).click();

    if (scenario.name === "fallback") {
      const decision = page.getByRole("dialog", { name: "快速结算需要玩家选择" });
      await expect(decision).toBeVisible({ timeout: 20_000 });
      await expect(decision).toContainText("实际提交时间0 秒");
      await decision.getByRole("button", { name: "保守跳过本次收益" }).click();
      await decision.getByRole("button", { name: "再次确认：收益为 0" }).click();
    }

    const report = page.getByRole("dialog", { name: "离线结算报告" });
    await expect(report).toBeVisible({ timeout: 20_000 });
    await expect(report.locator(".offline-report-method > header strong")).toHaveText(scenario.label);
    await expect(report.locator(".offline-report-method")).toContainText("精确校准");
    await expect(report.locator(".offline-report-method")).toContainText("宏观覆盖");
    await expect(report.locator(".offline-report-method")).toContainText("估计最大误差");
    if (scenario.name === "fallback") {
      await expect(report.locator(".offline-report-warning")).toBeVisible();
      const submittedText = await report.locator(".offline-runtime").textContent();
      const submittedSeconds = Number(submittedText?.match(/实际提交\s*(\d+)\s*秒/)?.[1] ?? Number.NaN);
      expect(submittedSeconds).toBeGreaterThanOrEqual(33);
      expect(submittedSeconds).toBeLessThan(43);
      await expect(report).toContainText("收益为 0");
    }
    else await expect(report.locator(".offline-report-warning")).toHaveCount(0);
    await expect.poll(() => report.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(report.getByRole("button", { name: "确认结算" })).toBeVisible();
  });
}

test("mobile construction inventory deletion reuses the guarded confirmation", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await seedBatchSave(page, { paused: true });
  await page.goto("/?mobileUi=next");

  await page.getByRole("button", { name: "建造" }).click();
  const build = page.getByRole("dialog", { name: "建造" });
  await build.getByRole("tab", { name: "删除" }).click();
  await build.getByLabel("搜索建造项目").fill("传送带 Mk.I");
  const beltStock = build.locator(".mobile-build-card--discard").filter({ hasText: "传送带 Mk.I" }).first();
  await expect(beltStock).toBeVisible();
  const stockText = await beltStock.textContent();
  const displayedAmount = stockText?.match(/当前 ×([\d,.万亿]+)/)?.[1];
  expect(displayedAmount).toBeTruthy();
  await beltStock.click();

  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText(`施工托盘中的传送带 Mk.I ×${displayedAmount}`);
  await expect(confirmation).toContainText("建筑制造中心仍保留目标 100");
  await confirmation.getByRole("button", { name: "永久删除" }).click();
  await expect(build.locator(".mobile-build-card--discard").filter({ hasText: "传送带 Mk.I" }).first()).toBeDisabled();
  await expect(build.locator(".mobile-build-card--discard").filter({ hasText: "传送带 Mk.I" }).first()).toContainText("当前 ×0");
  await expect(page.locator(".game-notice")).toContainText("画布建筑和制造目标未改变");
  await context.close();
});

test("zero-tick belt counts and locked machine ports come from topology", async ({ page }) => {
  await seedBatchSave(page, { paused: true, topology: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator(".react-flow__controls-fitview").click();

  const source = page.locator('.react-flow__node[data-id="topology-source"]');
  const target = page.locator('.react-flow__node[data-id="topology-target"]');
  const locked = page.locator('.react-flow__node[data-id="locked-smelter"]');
  await expect(source.getByTitle("3 条输出线路")).toHaveText("3");
  await expect(target.getByTitle("3 条输入线路")).toHaveText("3");
  await expect(locked.locator(".factory-handle--output")).toHaveCount(1);
  await expect(locked).not.toContainText("钢材");
});

test("item hover details can be disabled and stay disabled after reload", async ({ page }) => {
  await seedBatchSave(page, { paused: true, topology: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  const itemReference = page.locator(".tray-row .item-reference").first();
  await itemReference.hover();
  await expect(page.locator(".item-hover-card")).toBeVisible();
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.locator(".settings-category-overview").getByRole("button", { name: /交互与控制/ }).click();
  const toggleRow = operations.locator("label.setting-row").filter({ hasText: "显示物品悬浮信息" });
  const toggle = operations.getByRole("checkbox", { name: /显示物品悬浮信息/ });
  await expect(toggle).toBeChecked();
  await toggleRow.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.ui.show-item-hover.v1"))).toBe("false");
  await operations.getByLabel("关闭运营中心").click();
  await itemReference.hover();
  await expect(page.locator(".item-hover-card")).toHaveCount(0);

  await page.reload();
  await page.locator(".tray-row .item-reference").first().hover();
  await expect(page.locator(".item-hover-card")).toHaveCount(0);
});
