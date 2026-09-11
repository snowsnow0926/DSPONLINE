import { expect, test } from "@playwright/test";

function seedInteractionFixture() {
  return () => {
    const entityBase = {
      kind: "machine",
      planetId: "home",
      interactionLocked: false,
      buildingId: "arc_smelter",
      recipeId: "iron_ingot",
      machineCount: 1,
      minerCount: 0,
      routingCursor: 0,
      progress: 0,
      utilization: 0,
      productionRate: 0,
      inputs: {},
      outputs: {},
    };
    const productionHistory = Array.from({ length: 60 }, (_, index) => ({
      elapsedSeconds: index + 1,
      sampleDurationSeconds: 1,
      productionPerMinute: { iron_ingot: 600, copper_ingot: 1_200 },
      consumptionPerMinute: { iron_ore: 300, copper_ore: 240 },
      planetProductionPerMinute: {
        home: { iron_ingot: 400, copper_ingot: 800 },
        ashen: { iron_ingot: 200, copper_ingot: 400 },
      },
      planetConsumptionPerMinute: {
        home: { iron_ore: 200, copper_ore: 160 },
        ashen: { iron_ore: 100, copper_ore: 80 },
      },
      inventory: {},
      generationKw: 0,
      demandKw: 0,
      machineEfficiency: 0,
      logisticsEfficiency: 0,
      powerEfficiency: 1,
      activeMachines: 0,
      blockedMachines: 0,
    }));
    const state = {
      version: 45,
      nextId: 20,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "align-a", position: { x: 0, y: 0 } },
        { ...entityBase, id: "align-b", position: { x: -280, y: 230 } },
      ],
      belts: [],
      tray: {},
      planetTrays: { home: {} },
      planetTrayItemLimits: { home: 100_000_000 },
      construction: {},
      constructionAutomation: { enabled: false, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {}, jobs: {} },
      portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
      totalProduced: { iron_ingot: 12_345, copper_ingot: 67_890 },
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["electromagnetism", "basic_smelting"] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30 },
      productionHistory,
      historyRecordedAt: 60,
      elapsedSeconds: 60,
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  };
}

test("production statistics keep catalog order, sortable columns, and exact rolling windows", async ({ page }) => {
  await page.addInitScript(seedInteractionFixture());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("打开生产统计").click();

  const workspace = page.getByRole("dialog", { name: "生产统计" });
  await workspace.getByRole("button", { name: "生产中" }).click();
  const rows = workspace.locator(".statistics-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("铁块");
  await expect(rows.nth(1)).toContainText("铜块");

  await workspace.getByRole("button", { name: "生产 /1min" }).click();
  await expect(rows.nth(0)).toContainText("铜块");
  await workspace.getByRole("button", { name: "生产 /1min" }).click();
  await expect(rows.nth(0)).toContainText("铁块");

  await expect(workspace.getByRole("img", { name: "铁块生产和消耗趋势" })).toBeVisible();
  await workspace.getByRole("button", { name: "过去 10 分钟" }).click();
  await expect(rows.nth(0)).toContainText("6,000");
  await expect(rows.nth(1)).toContainText("1.2万");
  await expect(rows.nth(0)).toContainText("铁块");

  await workspace.getByRole("button", { name: "累计总产量" }).click();
  await expect(workspace.locator(".production-history-total")).toContainText("1.23万");
  await workspace.getByLabel("选择统计星球").selectOption("ashen");
  await workspace.getByRole("button", { name: "过去 1 分钟" }).click();
  await expect(rows.nth(0)).toContainText("200");
  await expect(rows.nth(1)).toContainText("400");
});

test("mobile production history has a real vertical scroll container above navigation", async ({ page }) => {
  await page.addInitScript(seedInteractionFixture());
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto("/");
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "生产统计" }).click();

  const workspace = page.getByRole("dialog", { name: "生产统计" });
  const content = workspace.locator(".statistics-content");
  await expect(workspace.getByRole("button", { name: "过去 1 分钟" })).toBeVisible();
  await expect.poll(() => content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => content.evaluate((element) => element.scrollTop > 0)).toBe(true);
  await expect.poll(() => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("dragging near another building shows alignment guides and clears them on release", async ({ page }) => {
  await page.addInitScript(seedInteractionFixture());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const target = page.locator('.react-flow__node[data-id="align-a"]');
  const moving = page.locator('.react-flow__node[data-id="align-b"]');
  const movingHeader = moving.locator(".factory-node__header");
  await movingHeader.click();
  await expect(moving).toHaveClass(/selected/);
  const targetBox = await target.boundingBox();
  const movingNodeBox = await moving.boundingBox();
  const movingBox = await movingHeader.boundingBox();
  expect(targetBox).not.toBeNull();
  expect(movingNodeBox).not.toBeNull();
  expect(movingBox).not.toBeNull();

  const startX = movingBox!.x + movingBox!.width / 2;
  const startY = movingBox!.y + movingBox!.height / 2;
  const alignDeltaY = targetBox!.y + targetBox!.height / 2 - (movingNodeBox!.y + movingNodeBox!.height / 2);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 40, startY + alignDeltaY, { steps: 12 });
  await expect(page.locator(".alignment-guide--horizontal")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".alignment-guide")).toHaveCount(0);
});
