import { expect, test, type Page } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";

async function seedV112Factory(page: Page, options: { fontScale?: number; theme?: "dark" | "light"; mobileUi?: "legacy" | "next" } = {}) {
  await page.addInitScript(({ fontScale, theme, mobileUi, releaseNoteId }) => {
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
    const stationSlots = [
      { itemId: "iron_ingot", localMode: "supply", remoteMode: "storage", minimumLoad: 0.25, minStock: 0, maxStock: 0, priority: 2, routePolicy: "direct", warperBudget: 1 },
      ...Array.from({ length: 4 }, () => ({ localMode: "storage", remoteMode: "storage", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1, routePolicy: "direct", warperBudget: 1 })),
    ];
    const state = {
      version: 40,
      nextId: 50,
      activePlanetId: "home",
      entities: [
        { ...base, id: "hub", kind: "storage", position: { x: -70, y: 40 }, buildingId: "material_delivery_hub", machineCount: 1, inputs: { deuteron_fuel_rod: 123_456, quantum_chip: 88_888 }, deliveryItemIds: ["deuteron_fuel_rod", "quantum_chip"], deliverySlots: [{ itemId: "deuteron_fuel_rod", mode: "manual" }, { itemId: "quantum_chip", mode: "auto" }, { itemId: null, mode: "auto" }] },
        { ...base, id: "station", kind: "station", position: { x: 360, y: 40 }, buildingId: "planetary_logistics_station", machineCount: 1, stationDrones: 10, stationMode: "supply", stationMinimumLoad: 1, stationSlots },
        { ...base, id: "ejector", kind: "machine", position: { x: 720, y: 40 }, buildingId: "em_rail_ejector", recipeId: "solar_sail_launch", machineCount: 1, inputs: { solar_sail: 5 } },
        { ...base, id: "iron_source", kind: "storage", position: { x: -500, y: -350 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", machineCount: 1, outputs: { iron_ingot: 100 } },
        { ...base, id: "iron_target", kind: "storage", position: { x: -200, y: -350 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", machineCount: 1 },
        { ...base, id: "copper_source", kind: "storage", position: { x: 100, y: -350 }, buildingId: "storage_mk1", storedItemId: "copper_ingot", machineCount: 1, outputs: { copper_ingot: 100 } },
        { ...base, id: "copper_target", kind: "storage", position: { x: 400, y: -350 }, buildingId: "storage_mk1", storedItemId: "copper_ingot", machineCount: 1 },
        { ...base, id: "stone_source", kind: "storage", position: { x: 700, y: -350 }, buildingId: "storage_mk1", storedItemId: "stone", machineCount: 1, outputs: { stone: 100 } },
        { ...base, id: "stone_target", kind: "storage", position: { x: 1000, y: -350 }, buildingId: "storage_mk1", storedItemId: "stone", machineCount: 1 },
      ],
      belts: [
        { id: "iron_line", planetId: "home", source: "iron_source", target: "iron_target", itemId: "iron_ingot", lanes: 1, tier: 1, sorterTier: 1, progress: 0.25, priority: 0, stackSize: 1, monitorEnabled: false, totalTransferred: 111, congestion: 0, lastFlow: 4, routeMode: "auto" },
        { id: "copper_line", planetId: "home", source: "copper_source", target: "copper_target", itemId: "copper_ingot", lanes: 3, tier: 1, sorterTier: 1, progress: 0.75, priority: 2, stackSize: 4, monitorEnabled: true, totalTransferred: 222, congestion: 0, lastFlow: 9, routeMode: "manual", routeOffsetY: 72 },
        { id: "stone_line", planetId: "home", source: "stone_source", target: "stone_target", itemId: "stone", lanes: 1, tier: 1, sorterTier: 1, progress: 0.5, priority: 1, stackSize: 1, monitorEnabled: false, totalTransferred: 333, congestion: 0, lastFlow: 2, routeMode: "bezier" },
      ],
      construction: { conveyor_belt_mk1: 20, material_delivery_hub: 0, planetary_logistics_station: 0, em_rail_ejector: 0 },
      constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {}, jobs: {} },
      blueprints: [],
      tray: {},
      planetTrays: { home: {} },
      planetTrayItemLimits: { home: 1_000_000 },
      portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
      totalProduced: {},
      elapsedSeconds: 1_000,
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["electromagnetism", "basic_logistics", "material_delivery_logistics", "planetary_logistics", "dyson_swarm", "super_magnetic_logistics"] },
      dysonEngineering: {
        launchMode: "balanced",
        launchThrottle: 1,
        launchEnabled: true,
        activeOrbitBySystem: { helios: "dyson_orbit_helios_2" },
        orbitsBySystem: { helios: [
          { id: "dyson_orbit_helios_1", name: "内环轨道", radius: 10_000, inclination: 0, longitude: 0, sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0 },
          { id: "dyson_orbit_helios_2", name: "外环轨道", radius: 28_000, inclination: 30, longitude: 120, sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0 },
        ] },
        absorptionProgressBySystem: { helios: 0 },
        launchEnergySpentMj: 0,
      },
      settings: { theme, fontScale, simulationSpeed: 1, autosaveIntervalSeconds: 30, resourceMode: "finite", beltBufferLimit: 100_000_000 },
      contentPacks: [],
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", mobileUi);
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  }, { fontScale: options.fontScale ?? 1, theme: options.theme ?? "dark", mobileUi: options.mobileUi ?? "legacy", releaseNoteId: RELEASE_NOTE_ID });
}

async function openFactory(page: Page, path = "/") {
  await page.goto(path);
  const release = page.getByRole("button", { name: "我知道了" });
  if (await release.isVisible().catch(() => false)) await release.click();
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.count()) await onboarding.first().click();
  await expect(page.locator(".factory-canvas")).toBeVisible();
  const fitView = page.locator(".react-flow__controls-fitview");
  if (await fitView.isVisible().catch(() => false)) await fitView.click();
}

for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
  test(`delivery hub stays compact with aligned handles at ${Math.round(scale * 100)} percent`, async ({ page }) => {
    await seedV112Factory(page, { fontScale: scale });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFactory(page);
    const hub = page.locator('.react-flow__node[data-id="hub"] .delivery-hub-node');
    await expect(hub).toBeVisible();
    const geometry = await hub.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const handles = [...element.querySelectorAll<HTMLElement>(".factory-handle--input")].map((handle) => {
        const rect = handle.getBoundingClientRect();
        const style = getComputedStyle(handle);
        return { x: rect.x + rect.width / 2, width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
      });
      return { cssWidth: (element as HTMLElement).offsetWidth, height: bounds.height, left: bounds.left, right: bounds.right, handles };
    });
    expect(geometry.cssWidth).toBeLessThanOrEqual(scale === 2 ? 330 : scale >= 1.5 ? 306 : 288);
    expect(geometry.height).toBeLessThan(390);
    expect(geometry.handles).toHaveLength(3);
    for (const handle of geometry.handles) {
      expect(handle.x).toBeGreaterThanOrEqual(geometry.left - 2);
      expect(handle.x).toBeLessThanOrEqual(geometry.right + 2);
      expect(handle.width).toBeGreaterThanOrEqual(18);
      expect(handle.height).toBeGreaterThanOrEqual(18);
    }
    await page.screenshot({ path: `artifacts/qa/v112-delivery-hub-${Math.round(scale * 100)}-1440x900.png`, fullPage: true });
  });
}

test("delivery hub remains within portrait and tablet layout bounds at 200 percent", async ({ page }) => {
  await seedV112Factory(page, { fontScale: 2, mobileUi: "next" });
  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page, "/?mobileUi=next");
  const hub = page.locator('.react-flow__node[data-id="hub"] .delivery-hub-node');
  await expect(hub).toBeAttached();
  await expect.poll(() => hub.evaluate((element) => (element as HTMLElement).offsetWidth)).toBeLessThanOrEqual(330);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v112-delivery-hub-200-next-mobile-390x844.png", fullPage: true });
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect.poll(() => hub.evaluate((element) => (element as HTMLElement).offsetWidth)).toBeLessThanOrEqual(330);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v112-delivery-hub-200-tablet-768x1024.png", fullPage: true });
});

test("the first clicked belt remains the explicit sync template and shows an atomic preview report", async ({ page }) => {
  await seedV112Factory(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  await page.getByLabel("打开生产网络总览").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  const copper = statistics.locator(".network-row").filter({ hasText: "铜块" });
  const iron = statistics.locator(".network-row").filter({ hasText: "铁块" });
  const stone = statistics.locator(".network-row").filter({ hasText: "石矿" });
  await copper.locator('input[type="checkbox"]').check();
  await iron.locator('input[type="checkbox"]').check();
  await stone.locator('input[type="checkbox"]').check();
  await expect(copper.getByRole("button", { name: "模板", exact: true })).toBeVisible();
  await statistics.getByRole("button", { name: "同步首条设置" }).click();
  const preview = statistics.locator(".network-sync-preview");
  await expect(preview).toContainText("模板：铜块");
  await expect(preview).toContainText("并联×3");
  await expect(preview).toContainText("货物堆叠×4");
  await expect(preview).toContainText("累计运输量、实时流量、线路进度和在途物资不会改变");
  await preview.getByRole("button", { name: "确认同步" }).click();
  await expect(statistics.locator(".network-sync-report")).toContainText("成功 2 条 · 跳过 0 条 · 失败 0 条");

  await statistics.getByRole("button", { name: "取消全选" }).click();
  await statistics.getByRole("button", { name: "选择当前结果" }).click();
  await expect(statistics.getByText("当前选择没有明确顺序")).toBeVisible();
  await expect(statistics.getByRole("button", { name: "同步首条设置" })).toBeDisabled();
  await iron.getByRole("button", { name: "设为模板" }).click();
  await expect(statistics.getByRole("button", { name: "同步首条设置" })).toBeEnabled();
  await page.screenshot({ path: "artifacts/qa/v112-belt-template-preview-1440x900.png", fullPage: true });
});

test("ejectors migrate to the active orbit and expose persistent target selection on desktop", async ({ page }) => {
  await seedV112Factory(page, { mobileUi: "legacy" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  await page.locator('.react-flow__node[data-id="ejector"] .factory-node__header').click();
  const desktopSelect = page.locator('.inspector-panel select[aria-label="选择太阳帆目标轨道"]');
  await expect(desktopSelect).toBeVisible();
  await expect(desktopSelect).toHaveValue("dyson_orbit_helios_2");
  await desktopSelect.selectOption("dyson_orbit_helios_1");
  await expect(desktopSelect).toHaveValue("dyson_orbit_helios_1");
  await page.screenshot({ path: "artifacts/qa/v112-ejector-orbit-desktop-1440x900.png", fullPage: true });
});

test("next mobile exposes a 44px ejector orbit selector", async ({ page }) => {
  await seedV112Factory(page, { mobileUi: "next" });
  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page, "/?mobileUi=next");
  await page.locator('.react-flow__node[data-id="ejector"]').evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const inspector = page.getByRole("dialog", { name: "电磁轨道弹射器" });
  await expect(inspector).toBeVisible();
  await inspector.getByLabel("展开电磁轨道弹射器").click();
  const mobileOrbit = page.locator(".mobile-ejector-orbit");
  await expect(mobileOrbit).toBeVisible();
  await expect(mobileOrbit.locator("select")).toHaveValue("dyson_orbit_helios_2");
  await mobileOrbit.locator("select").selectOption("dyson_orbit_helios_1");
  const target = await mobileOrbit.locator("select").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(target.width).toBeGreaterThan(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "artifacts/qa/v112-ejector-orbit-next-mobile-390x844.png", fullPage: true });
});

test("light logistics station controls expose hover, selected, focus and configured states", async ({ page }) => {
  await seedV112Factory(page, { theme: "light", fontScale: 2 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  await page.locator('.react-flow__node[data-id="station"] .factory-node__header').click();
  const slot = page.locator(".station-slot").first();
  const selected = slot.getByRole("button", { name: "供应", exact: true }).first();
  const inactive = slot.getByRole("button", { name: "需求", exact: true }).first();
  await expect(slot).toHaveClass(/station-slot--configured/);
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(inactive).toHaveAttribute("aria-pressed", "false");
  const colors = await Promise.all([selected, inactive].map((locator) => locator.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }))));
  expect(colors[0]).not.toEqual(colors[1]);
  await inactive.hover();
  expect(await inactive.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(colors[1].background);
  await selected.focus();
  expect(await selected.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  const diagnosticBackground = await page.locator(".station-fleet-diagnostic > div").first().evaluate((element) =>
    getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? []);
  expect(diagnosticBackground.reduce((sum, channel) => sum + channel, 0)).toBeGreaterThan(600);
  await page.screenshot({ path: "artifacts/qa/v112-light-logistics-selected-200-1440x900.png", fullPage: true });
});

