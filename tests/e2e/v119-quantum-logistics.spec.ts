import { expect, test } from "@playwright/test";

function seedQuantumFixture() {
  return () => {
    const station = {
      id: "v119_quantum_station",
      kind: "station",
      planetId: "home",
      position: { x: 120, y: 80 },
      interactionLocked: false,
      buildingId: "interstellar_logistics_station",
      machineCount: 1,
      minerCount: 0,
      routingCursor: 0,
      progress: 0,
      utilization: 0,
      productionRate: 0,
      inputs: {},
      outputs: {},
      stationSlots: [
        { itemId: "iron_ore", localMode: "storage", remoteMode: "demand", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 },
        ...Array.from({ length: 4 }, () => ({ localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 2 })),
      ],
      stationRoutes: [],
      stationTier: 2,
      stationOperationMode: "legacy",
      stationModeTransition: null,
      quantumMode: "legacy",
      quantumTransition: null,
    };
    const collector = {
      id: "v119_quantum_collector",
      kind: "station",
      planetId: "giant",
      position: { x: 120, y: 80 },
      interactionLocked: false,
      buildingId: "orbital_collector",
      machineCount: 10,
      minerCount: 0,
      routingCursor: 0,
      progress: 0,
      utilization: 0,
      productionRate: 0,
      inputs: {},
      outputs: { hydrogen: 100 },
      storedItemId: "hydrogen",
      stationRoutes: [],
    };
    const state = {
      version: 44,
      nextId: 2,
      activePlanetId: "home",
      entities: [station, collector],
      belts: [],
      construction: {},
      constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, jobs: {} },
      tray: {},
      planetTrays: { home: {}, giant: {} },
      planetTrayItemLimits: { home: 1_000_000, giant: 1_000_000 },
      portableFleet: { logistics_drone: 0, logistics_vessel: 1 },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["interstellar_logistics", "space_warp", "quantum_logistics_network"] },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"], surveyProgressBySystem: { helios: 1 }, missions: [] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30, resourceMode: "finite" },
      quantumLogisticsNetwork: { enabled: true, inventory: {}, routingCursors: {} },
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  };
}

test("upgraded station exposes independent quantum attachment action", async ({ page }) => {
  await page.addInitScript(seedQuantumFixture());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator('.react-flow__node[data-id="v119_quantum_station"]')).toBeVisible();
  await page.locator('.react-flow__node[data-id="v119_quantum_station"]').click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.getByRole("button", { name: "接入量子网络" })).toBeVisible();
  await inspector.getByRole("button", { name: "接入量子网络" }).click();
  await expect(inspector.locator(".quantum-network-control")).toContainText("交接中");
  await expect(page.getByRole("status")).toContainText("量子网络接入");
});

test("star map exposes a one-click quantum switch for all eligible stations", async ({ page }) => {
  await page.addInitScript(seedQuantumFixture());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".game-header").getByLabel("打开星图").click();
  const starMap = page.locator(".star-map-workspace");
  const bulk = starMap.getByRole("button", { name: /一键切换全部量子物流站/ });
  await expect(bulk).toBeVisible();
  await expect(bulk).toBeEnabled();
  await bulk.click();
  await expect(page.getByRole("status").filter({ hasText: "量子物流切换完成" })).toContainText("成功 1 座，跳过 0 座");
});

test("v44 saves expose collector controls and strict quantum inventory capacities", async ({ page }) => {
  await page.addInitScript(seedQuantumFixture());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".game-header").getByLabel("打开星图").click();
  const starMap = page.locator(".star-map-workspace");
  await starMap.getByRole("tab", { name: "量子库存" }).click();
  const console = starMap.getByRole("region", { name: "量子空间库存" });
  await expect(console).toBeVisible();
  const collectorButton = console.getByRole("button", { name: /全部采集器接入/ });
  await expect(collectorButton).toBeEnabled();
  await collectorButton.click();
  await expect(page.getByRole("status").filter({ hasText: "量子采集切换完成" })).toContainText("成功 1 台，跳过 0 台");

  await console.getByLabel("搜索量子库存物品").fill("铁矿石");
  const row = console.locator(".quantum-inventory-row").filter({ hasText: "铁矿石" });
  await expect(row.getByRole("button", { name: "100亿" })).toHaveClass(/active/);
  const input = row.getByLabel("铁矿石自定义量子容量");
  await input.fill("1e6");
  await row.getByRole("button", { name: "应用" }).click();
  await expect(row.getByRole("alert")).toContainText("不支持小数、负数或指数格式");
  await input.fill("10000");
  await row.getByRole("button", { name: "应用" }).click();
  await expect(row.getByRole("button", { name: "1万" })).toHaveClass(/active/);
});

test("quantum inventory remains reachable on next mobile UI at 200 percent text", async ({ page }) => {
  await page.addInitScript(seedQuantumFixture());
  await page.addInitScript(() => {
    window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", "next");
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    if (!raw) return;
    const save = JSON.parse(raw);
    save.state.settings.fontScale = 2;
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify(save));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?mobileUi=next");

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /星图与星际工业/ }).click();
  const starMap = page.getByRole("dialog", { name: "星图" });
  await starMap.getByRole("tab", { name: "量子库存" }).click();

  const console = starMap.getByRole("region", { name: "量子空间库存" });
  await expect(console).toBeVisible();
  await console.getByLabel("搜索量子库存物品").fill("铁矿石");
  const row = console.locator(".quantum-inventory-row").filter({ hasText: "铁矿石" });
  await expect(row.getByRole("button", { name: "1万" })).toBeVisible();
  await expect(row.getByLabel("铁矿石自定义量子容量")).toBeVisible();
  await expect.poll(() => starMap.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v119-quantum-inventory-mobile-200.png", fullPage: true });
});
