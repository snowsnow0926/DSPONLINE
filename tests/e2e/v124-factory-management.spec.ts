import { expect, test, type Page } from "@playwright/test";

interface FixtureOptions {
  fontScale?: number;
  storageStock?: number;
  mobileUi?: "legacy" | "next";
}

async function seedManagementFixture(page: Page, options: FixtureOptions = {}) {
  await page.addInitScript(({ fontScale, storageStock, mobileUi }) => {
    const base = {
      interactionLocked: false,
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
      powerGridId: "grid-a",
      powerPriority: 2,
    };
    const emptySlot = () => ({
      localMode: "storage",
      remoteMode: "storage",
      minimumLoad: 1,
      minStock: 0,
      maxStock: 0,
      priority: 1,
      routePolicy: "direct",
      warperBudget: 2,
    });
    const state = {
      version: 45,
      nextId: 200,
      activePlanetId: "home",
      entities: [
        { ...base, id: "stack_limit", kind: "storage", planetId: "home", position: { x: -620, y: -360 }, buildingId: "storage_mk1", machineCount: 100_000_000, storedItemId: "iron_ingot" },
        { ...base, id: "stack_history", kind: "storage", planetId: "home", position: { x: -240, y: -360 }, buildingId: "storage_mk1", machineCount: 100_000_001, storedItemId: "copper_ingot" },
        { ...base, id: "delete_source", kind: "storage", planetId: "home", position: { x: -620, y: 260 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", outputs: { iron_ingot: 30 } },
        { ...base, id: "delete_target", kind: "storage", planetId: "home", position: { x: -220, y: 260 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", inputs: { iron_ingot: 4 } },
        { ...base, id: "belt_source", kind: "storage", planetId: "home", position: { x: 160, y: -300 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", outputs: { iron_ingot: 50 } },
        { ...base, id: "belt_target", kind: "machine", planetId: "home", position: { x: 580, y: -300 }, buildingId: "assembling_machine_mk1", recipeId: "gear" },
        { ...base, id: "smelter", kind: "machine", planetId: "home", position: { x: 120, y: 230 }, buildingId: "arc_smelter", recipeId: "iron_ingot", outputs: { iron_ingot: 8 } },
        {
          ...base,
          id: "remote_station",
          kind: "station",
          planetId: "ashen",
          position: { x: 120, y: 80 },
          buildingId: "interstellar_logistics_station",
          inputs: { iron_ingot: 7 },
          outputs: { iron_ingot: 11 },
          stationSlots: [
            { ...emptySlot(), itemId: "iron_ingot", localMode: "demand", remoteMode: "supply", minimumLoad: 0.5 },
            emptySlot(), emptySlot(), emptySlot(), emptySlot(),
          ],
          stationRoutes: [],
          stationDrones: 0,
          stationVessels: 0,
          stationWarpers: 0,
          stationWarpEnabled: true,
          stationWarperAutoRefill: false,
          stationWarperTarget: 50,
          stationTier: 2,
          stationOperationMode: "legacy",
          stationModeTransition: null,
          quantumMode: "legacy",
          quantumTransition: null,
        },
        {
          ...base,
          id: "collector",
          kind: "station",
          planetId: "giant",
          position: { x: 120, y: 80 },
          buildingId: "orbital_collector",
          machineCount: 10,
          storedItemId: "hydrogen",
          outputs: { hydrogen: 100 },
          stationRoutes: [],
          quantumMode: "legacy",
          quantumTransition: null,
        },
      ],
      belts: [{
        id: "delete_belt",
        planetId: "home",
        source: "delete_source",
        target: "delete_target",
        itemId: "iron_ingot",
        lanes: 1,
        tier: 1,
        sorterTier: 1,
        progress: 0,
        priority: 1,
        stackSize: 1,
        monitorEnabled: false,
        totalTransferred: 0,
        congestion: 0,
        lastFlow: 0,
        routeMode: "auto",
      }],
      construction: {
        storage_mk1: storageStock,
        conveyor_belt_mk1: 4,
        assembling_machine_mk1: 0,
        arc_smelter: 0,
      },
      constructionAutomation: { enabled: false, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {}, jobs: {} },
      tray: { space_warper: 0 },
      planetTrays: {
        home: { space_warper: 0 },
        ashen: { space_warper: 20 },
        giant: {},
      },
      planetTrayItemLimits: { home: 100_000_000, ashen: 100_000_000, giant: 100_000_000 },
      portableFleet: { logistics_drone: 8, logistics_vessel: 4 },
      totalProduced: {},
      research: {
        selectedTechId: null,
        pausedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["basic_logistics", "basic_assembling", "smelting_purification", "storage_system", "interstellar_logistics", "space_warp", "quantum_logistics_network"],
      },
      exploration: {
        unlockedSystemIds: ["helios"],
        colonizedPlanetIds: ["home", "ashen", "giant"],
        surveyProgressBySystem: { helios: 1 },
        missions: [],
      },
      settings: { theme: "dark", fontScale, simulationSpeed: 1, autosaveIntervalSeconds: 120, resourceMode: "finite" },
      blueprints: [],
      constructionQueue: [],
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
    window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    if (mobileUi) window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", mobileUi);
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  }, {
    fontScale: options.fontScale ?? 1,
    storageStock: options.storageStock ?? 10,
    mobileUi: options.mobileUi ?? "legacy",
  });
}

async function openFixture(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator(".game-shell")).toBeVisible();
  const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
  if (await offlineReport.count()) await offlineReport.getByRole("button", { name: "确认结算" }).click();
}

async function dragConnect(page: Page) {
  const source = page.locator('.react-flow__node[data-id="belt_source"] .factory-handle--output');
  const target = page.locator('.react-flow__node[data-id="belt_target"] .factory-handle--input:not(.factory-handle--auto)');
  const [sourceBox, targetBox] = await Promise.all([source.boundingBox(), target.boundingBox()]);
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 10 });
  await page.mouse.up();
}

function blueprintFile(name: string, machineCount = 1) {
  return {
    name: `${name}.dspblueprint.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      blueprint: {
        id: name,
        name,
        entities: [{ key: "node_1", buildingId: "storage_mk1", offset: { x: 0, y: 0 }, machineCount }],
        belts: [],
      },
    })),
  };
}

test("one-hundred-million additions are blocked while a historical safe stack survives a save reload", async ({ page }) => {
  await seedManagementFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page);
  await page.locator(".react-flow__controls-fitview").click();

  await page.locator('.react-flow__node[data-id="stack_limit"] .factory-node__header').click();
  const inspector = page.locator(".inspector-panel");
  const target = inspector.getByLabel("建筑堆叠目标数量");
  await expect(target).toHaveValue("100000000");
  await expect(inspector.locator(".entity-stack-target-shortcuts").getByRole("button", { name: /^快速增加 1 台建筑/ })).toBeDisabled();
  await expect(inspector.locator(".entity-stack-target-shortcuts").getByRole("button", { name: /^快速增加 100,000 台建筑/ })).toBeDisabled();
  await target.fill("100000001");
  await target.blur();
  await expect(inspector.getByRole("alert")).toContainText("1 至 100,000,000");
  await expect(inspector.getByRole("alert")).toContainText("历史超限数量只允许降低");

  await page.locator('.react-flow__node[data-id="stack_history"] .factory-node__header').click();
  await expect(inspector.getByLabel("建筑堆叠目标数量")).toHaveValue("100000001");
  await page.getByLabel("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.locator('.react-flow__node[data-id="stack_history"]')).toBeVisible();
  await page.locator('.react-flow__node[data-id="stack_history"] .factory-node__header').click();
  await expect(page.locator(".inspector-panel").getByLabel("建筑堆叠目标数量")).toHaveValue("100000001");
});

test("logistics management searches and edits a remote station without changing the active planet", async ({ page }) => {
  await seedManagementFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "物流管理" }).click();
  const manager = operations.getByTestId("logistics-management");
  await manager.getByLabel("搜索物流塔").fill("remote_station");
  const station = manager.locator('[data-station-id="remote_station"]');
  await expect(station).toBeVisible();
  await station.locator(".logistics-station-summary").click();

  const droneInput = station.locator(".logistics-station-settings label").filter({ hasText: "运输机" }).locator("input");
  await droneInput.fill("3");
  await droneInput.press("Enter");
  await expect(droneInput).toHaveValue("3");

  const itemSelect = station.locator(".logistics-slot-editor").first().locator("select").first();
  await itemSelect.selectOption("copper_ingot");
  let dialog = page.locator(".game-dialog");
  await expect(dialog).toContainText("原槽位缓存会退回该行星物资托盘");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(itemSelect).toHaveValue("iron_ingot");

  await itemSelect.selectOption("copper_ingot");
  dialog = page.locator(".game-dialog");
  await dialog.getByRole("button", { name: "确认修改" }).click();
  await expect(itemSelect).toHaveValue("copper_ingot");
  await expect(page.getByRole("status")).toContainText("已远程修改");

  await manager.getByLabel("搜索物流塔").fill("");
  await manager.getByLabel("物流塔类型筛选").selectOption("collector");
  await expect(manager.locator(".settings-state")).toContainText("物流节点 1/2");
  await operations.getByLabel("关闭运营中心").click();
  await expect(page.locator(".planet-navigator button.active")).toContainText("澄海 I");

  await page.getByLabel("打开设置").click();
  const reopened = page.getByRole("dialog", { name: "运营中心" });
  await reopened.getByRole("tab", { name: "物流管理" }).click();
  await expect(reopened.getByLabel("物流塔类型筛选")).toHaveValue("collector");
});

test("new and parallel belt connections select the exact affected line in the inspector", async ({ page }) => {
  await seedManagementFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page);
  await page.locator(".react-flow__controls-fitview").click();

  await dragConnect(page);
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
  const inspector = page.locator(".inspector-panel");
  await expect(inspector).toContainText("铁块运输线");
  await expect(inspector.getByLabel("并联线路目标数量")).toHaveValue("1");

  await dragConnect(page);
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
  await expect(inspector.getByLabel("并联线路目标数量")).toHaveValue("2");
});

test("selection toolbar recycle mode supports single and shift multi-select with exact refunds", async ({ page }) => {
  await seedManagementFixture(page, { storageStock: 0 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.getByLabel("框选模式").click();

  await page.locator('.react-flow__node[data-id="delete_source"] .factory-node__header').click();
  const toolbar = page.getByRole("toolbar", { name: "选区操作" });
  await expect(toolbar).toContainText("1 节点");
  await page.locator('.react-flow__node[data-id="delete_target"] .factory-node__header').click({ modifiers: ["Shift"] });
  await expect(toolbar).toContainText("2 节点 · 1 线路");
  await toolbar.getByLabel("批量回收所选设备与线路").click();

  const dialog = page.locator(".game-dialog");
  await expect(dialog).toContainText("2 个建筑节点");
  await expect(dialog).toContainText("1 条相关传送带");
  await expect(dialog).toContainText("小型储物仓 ×2");
  await dialog.getByRole("button", { name: "确认回收" }).click();
  await expect(page.locator('.react-flow__node[data-id="delete_source"], .react-flow__node[data-id="delete_target"]')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge[data-id="delete_belt"]')).toHaveCount(0);
  await expect(page.locator(".construction-item").filter({ hasText: "小型储物仓" }).locator("strong")).toHaveText("×2");
});

test("item hover actions remain interactive across the portal and open locate and codex flows", async ({ page }) => {
  await seedManagementFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page);
  await page.locator(".react-flow__controls-fitview").click();
  const reference = page.locator('.react-flow__node[data-id="smelter"] .item-reference').filter({ hasText: "铁块" }).first();
  await reference.hover();
  let card = page.getByRole("dialog", { name: "铁块快捷操作" });
  await expect(card).toBeVisible();
  await card.hover();
  await page.waitForTimeout(220);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "定位铁块生产线" }).click();
  await expect(page.getByRole("status")).toContainText("已定位");

  await reference.hover();
  card = page.getByRole("dialog", { name: "铁块快捷操作" });
  await card.getByRole("button", { name: "打开铁块图鉴" }).click();
  const codex = page.getByRole("dialog", { name: "生产资料库" });
  await expect(codex.locator(".recipe-item-header").getByText("铁块", { exact: true })).toBeVisible();
});

test.describe("touch and responsive management", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("mobile logistics controls remain reachable at 200 percent in portrait and landscape", async ({ page }) => {
    await seedManagementFixture(page, { fontScale: 2, mobileUi: "next" });
    await openFixture(page, "/?mobileUi=next");
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: /物流管理/ }).click();
    const operations = page.getByRole("dialog", { name: "运营中心" });
    const manager = operations.getByTestId("logistics-management");
    await expect(manager).toBeVisible();
    await expect.poll(() => manager.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await manager.getByLabel("搜索物流塔").fill("remote_station");
    await manager.locator('[data-station-id="remote_station"] .logistics-station-summary').click();
    const sizes = await manager.locator(".logistics-management-filters input, .logistics-management-filters select, .logistics-tree-toggle, .logistics-station-summary, .logistics-station-settings input:not([type=checkbox]), .logistics-warper-stepper button, .logistics-slot-editor input, .logistics-slot-editor select").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44);

    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => operations.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });

  test("touch long press opens item actions without dismissing the portal", async ({ page }) => {
    await seedManagementFixture(page, { mobileUi: "legacy" });
    await openFixture(page, "/?mobileUi=legacy");
    await page.locator(".react-flow__controls-fitview").evaluate((element: HTMLElement) => element.click());
    const reference = page.locator('.react-flow__node[data-id="smelter"] .item-reference').filter({ hasText: "铁块" }).first();
    await reference.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 7, button: 0 });
    await page.waitForTimeout(460);
    await reference.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 7, button: 0 });
    const card = page.getByRole("dialog", { name: "铁块快捷操作" });
    await expect(card).toBeVisible();
    const actions = await card.locator(".item-hover-actions button").evaluateAll((buttons) => buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }));
    for (const action of actions) {
      expect(action.width).toBeGreaterThanOrEqual(44);
      expect(action.height).toBeGreaterThanOrEqual(44);
    }
  });

  for (const scenario of [
    { name: "classic portrait", path: "/?mobileUi=legacy", mobileUi: "legacy" as const, viewport: { width: 390, height: 844 } },
    { name: "next landscape", path: "/?mobileUi=next", mobileUi: "next" as const, viewport: { width: 844, height: 390 } },
  ]) {
    test(`mobile blueprint import is visible and usable in ${scenario.name} at 200 percent`, async ({ page }) => {
      await seedManagementFixture(page, { fontScale: 2, mobileUi: scenario.mobileUi });
      await page.setViewportSize(scenario.viewport);
      await openFixture(page, scenario.path);
      if (scenario.mobileUi === "next") {
        await page.getByRole("button", { name: "更多", exact: true }).click();
        await page.getByRole("button", { name: /蓝图库/ }).click();
      } else {
        await page.getByLabel("打开蓝图库").click();
      }
      const workspace = page.getByRole("dialog", { name: "蓝图与待建施工" });
      const importButton = workspace.getByRole("button", { name: "导入蓝图" });
      await expect(importButton).toBeVisible();
      await expect(importButton).toContainText("导入蓝图");

      const chooserPromise = page.waitForEvent("filechooser");
      await importButton.click();
      const chooser = await chooserPromise;
      await chooser.setFiles({
        name: "invalid-blueprint.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ type: "dsp-idle-blueprint", formatVersion: 99, blueprint: {} })),
      });
      await expect(workspace.locator(".blueprint-import-panel")).toContainText(/版本|格式/);

      await workspace.getByLabel("选择要导入的蓝图文件").setInputFiles(blueprintFile(`手机导入-${scenario.name}`));
      await expect(workspace.locator(".blueprint-import-panel")).toContainText("1 个建筑 · 0 条传送带");
      await expect(workspace.getByLabel(`手机导入-${scenario.name}名称`)).toHaveValue(`手机导入-${scenario.name}`);
      await expect.poll(() => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    });
  }
});
