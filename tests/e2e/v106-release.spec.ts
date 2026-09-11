import { expect, test, type Page } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-11-v1.0.38";

async function seedV106Factory(page: Page, mobileUi: "legacy" | "next" = "legacy") {
  await page.addInitScript(({ releaseNoteId, selectedMobileUi }) => {
    const base = {
      planetId: "home",
      minerCount: 0,
      routingCursor: 0,
      progress: 0,
      utilization: 0,
      productionRate: 0,
      inputs: {},
      outputs: {},
      interactionLocked: false,
    };
    const state = {
      version: 38,
      nextId: 30,
      activePlanetId: "home",
      entities: [
        { ...base, id: "v106_source", kind: "storage", position: { x: -320, y: 0 }, buildingId: "storage_mk1", storedItemId: "iron_ore", machineCount: 1, outputs: { iron_ore: 100_000 } },
        { ...base, id: "v106_smelter", kind: "machine", position: { x: 260, y: 0 }, buildingId: "arc_smelter", recipeId: "iron_ingot", machineCount: 151, inputs: { iron_ore: 2_500 }, outputs: { iron_ingot: 1_200 }, progress: 0.625 },
      ],
      belts: [{ id: "v106_belt", planetId: "home", source: "v106_source", target: "v106_smelter", itemId: "iron_ore", lanes: 64, tier: 3, sorterTier: 3, progress: 0.75, priority: 2, stackSize: 4, monitorEnabled: true, totalTransferred: 12_345, congestion: 0.25, lastFlow: 900, routeMode: "manual", routeOffsetY: 160 }],
      construction: { conveyor_belt_mk3: 5_000, arc_smelter: 200_000 },
      constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: { hydrogen: 17 }, jobs: {} },
      blueprints: [{ id: "v106_mining_blueprint", name: "铁矿采集布局", entities: [], resourceAnchors: [{ key: "resource_1", resourceId: "iron_ore", offset: { x: 0, y: 0 }, extractorBuildingId: "mining_machine", minerCount: 3 }], belts: [], rotation: 0, mirror: "none", recipeOverrides: {} }],
      tray: {},
      planetTrays: { home: {} },
      planetTrayItemLimits: { home: 1_000_000 },
      portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["basic_logistics", "super_magnetic_logistics"] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30, resourceMode: "finite" },
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", selectedMobileUi);
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  }, { releaseNoteId: RELEASE_NOTE_ID, selectedMobileUi: mobileUi });
}

async function openFactory(page: Page, path = "/") {
  await page.goto(path);
  const acknowledgeRelease = page.getByRole("button", { name: "我知道了" });
  if (await acknowledgeRelease.isVisible().catch(() => false)) await acknowledgeRelease.click();
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.count()) await onboarding.first().click();
  await expect(page.locator(".factory-canvas")).toBeVisible();
}

test("desktop exposes 4096 belt lanes, batch unstacking and vein-safe blueprint metadata", async ({ page }) => {
  await seedV106Factory(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);

  await page.locator('.react-flow__edge[data-id="v106_belt"]').evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const inspector = page.locator(".inspector-panel");
  const lanes = inspector.getByLabel("并联线路目标数量");
  await lanes.fill("4096");
  await lanes.blur();
  await expect(lanes).toHaveValue("4096");
  await expect(inspector).toContainText("491520/s");

  await page.locator('.react-flow__node[data-id="v106_smelter"]').click();
  const target = inspector.getByLabel("建筑堆叠目标数量");
  await inspector.getByRole("button", { name: /^快速增加 10,000 台建筑/ }).click();
  await expect(target).toHaveValue("10151");
  await inspector.getByRole("button", { name: "减少 100,000 台建筑", exact: true }).click();
  await expect(target).toHaveValue("1");
  await target.fill("51");
  await target.blur();
  await expect(target).toHaveValue("51");
  await expect(inspector).toContainText("电弧熔炉 ×51");
  await inspector.locator(".entity-stack-batch-remove").getByRole("button", { name: "减少 10 台建筑", exact: true }).click();
  await expect(target).toHaveValue("41");
  await target.fill("1");
  await target.blur();
  await expect(target).toHaveValue("1");
  await expect(page.getByRole("status")).toContainText("电弧熔炉堆叠已调整为 ×1");
  await expect(page.locator('.react-flow__edge[data-id="v106_belt"]')).toHaveCount(1);

  await page.getByLabel("打开蓝图库").click();
  const library = page.getByRole("dialog", { name: "蓝图与待建施工" });
  await expect(library).toContainText("1 资源锚点");
  await expect(library).toContainText("矿脉保持唯一");
  await expect(library).toContainText("不会复制、移动或补充矿脉储量");
  await page.screenshot({ path: "artifacts/qa/v106-desktop-1440x900.png", fullPage: true });
});

test("next mobile batch unstacking keeps 44px targets and fits 200 percent text", async ({ page }) => {
  await seedV106Factory(page, "next");
  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page, "/?mobileUi=next");
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await page.locator('.react-flow__node[data-id="v106_smelter"]').click();
  const mobile = page.locator(".mobile-inspector-sheet");
  await mobile.getByRole("button", { name: /^展开/ }).click();
  const target = mobile.getByLabel("移动端建筑堆叠目标数量");
  await expect(target).toBeVisible();
  const controls = mobile.locator(".mobile-stack-batch-remove button, .mobile-stack-batch-remove input");
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await mobile.getByRole("button", { name: "移动端快速增加 100,000 台建筑", exact: true }).click();
  await expect(mobile.locator(".mobile-stack-batch-remove > header strong")).toContainText("100151");
  await mobile.getByRole("button", { name: "移动端减少 100,000 台建筑", exact: true }).click();
  await expect(mobile.locator(".mobile-stack-batch-remove > header strong")).toContainText("151");
  await target.fill("1");
  await target.blur();
  await expect(target).toHaveValue("1");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v106-mobile-next-font200-390x844.png", fullPage: true });
});

test("classic mobile keeps batch controls reachable at 200 percent text", async ({ page }) => {
  await seedV106Factory(page, "legacy");
  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page);
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await page.locator('.react-flow__node[data-id="v106_smelter"]').click();
  const inspector = page.locator(".inspector-panel");
  const target = inspector.getByLabel("建筑堆叠目标数量");
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  await target.fill("101");
  await target.blur();
  await expect(target).toHaveValue("101");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v106-mobile-classic-font200-390x844.png", fullPage: true });
});
