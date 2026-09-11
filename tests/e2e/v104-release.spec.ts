import { expect, test, type Page } from "@playwright/test";
import { migrateGame, serializeEnvelope } from "../../src/game/storage";

const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";

function createV104LegacyState(endgame = false) {
  const entityBase = {
    planetId: "home",
    minerCount: 0,
    routingCursor: 0,
    progress: 0,
    utilization: 0,
    productionRate: 0,
    inputs: {},
    outputs: {},
  };
  const completedTechIds = [
    "electromagnetism",
    "basic_smelting",
    "basic_assembling",
    "basic_logistics",
    "construction_automation",
    "construction_capacity_1",
    "construction_capacity_2",
    ...(endgame ? ["universe_matrix"] : []),
  ];
  return {
    version: 36,
    nextId: 20,
    activePlanetId: "home",
    entities: [
      { ...entityBase, id: "v104_source", kind: "storage", position: { x: -240, y: 0 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", machineCount: 1, outputs: { iron_ingot: 500 } },
      { ...entityBase, id: "v104_target", kind: "machine", position: { x: 260, y: 0 }, buildingId: "assembling_machine_mk1", recipeId: "gear", machineCount: 1, inputs: { iron_ingot: 20 } },
      { ...entityBase, id: "v104_center", kind: "machine", position: { x: 20, y: 260 }, buildingId: "construction_center", machineCount: 1 },
    ],
    belts: [{ id: "v104_belt", planetId: "home", source: "v104_source", target: "v104_target", itemId: "iron_ingot", lanes: 2, tier: 2, sorterTier: 2, progress: 0.625, priority: 2, stackSize: 1, monitorEnabled: true, totalTransferred: 9_876, congestion: 0.25, lastFlow: 12, routeMode: "upper" }],
    construction: { conveyor_belt_mk2: 3, arc_smelter: 120_000, construction_center: 0 },
    constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, jobs: {} },
    tray: { iron_ingot: 1_000, stone_brick: 1_000, circuit_board: 1_000, magnetic_coil: 1_000 },
    planetTrays: { home: { iron_ingot: 1_000, stone_brick: 1_000, circuit_board: 1_000, magnetic_coil: 1_000 } },
    planetTrayItemLimits: { home: 1_000_000 },
    portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
    totalProduced: {},
    research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds },
    settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30, resourceMode: "finite" },
    paused: true,
  };
}

async function seedV104Factory(page: Page, options: { endgame?: boolean; mobileUi?: "legacy" | "next"; durable?: boolean } = {}) {
  const legacyState = createV104LegacyState(options.endgame ?? false);
  const migratedState = options.durable ? migrateGame({ ...legacyState, mode: "normal" }) : null;
  if (options.durable && !migratedState) throw new Error("v104 legacy fixture did not migrate");
  const initialSaveRaw = options.durable
    ? serializeEnvelope(migratedState!, Date.now(), "primary", undefined, undefined, "main")
    : JSON.stringify({ savedAt: Date.now(), state: legacyState });
  await page.addInitScript(({ releaseNoteId, mobileUi, useDurableStartup, initialSaveRaw }) => {
    if (!useDurableStartup) window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", mobileUi);
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", initialSaveRaw);
  }, {
    releaseNoteId: RELEASE_NOTE_ID,
    mobileUi: options.mobileUi ?? "legacy",
    useDurableStartup: options.durable ?? false,
    initialSaveRaw,
  });
}

async function openFactory(page: Page, path = "/") {
  await page.goto(path);
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.count()) await onboarding.first().click();
  await expect(page.locator(".factory-canvas")).toBeVisible();
}

async function openDurableFactory(page: Page, path = "/?menu=1") {
  await page.goto(path);
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.getByRole("button", { name: "进入工厂", exact: true }).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 15_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 15_000 });
  await expect(page.locator(".factory-canvas")).toBeVisible();
}

test("desktop inspector adjusts existing belt lanes with clear inventory and limit feedback", async ({ page }) => {
  await seedV104Factory(page, { durable: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDurableFactory(page);
  await page.locator('.react-flow__edge[data-id="v104_belt"]').evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  const inspector = page.locator(".inspector-panel");
  const input = inspector.getByLabel("并联线路目标数量");
  const laneControl = inspector.locator(".belt-lane-control");
  const readStock = async () => Number(/库存\s*(\d+)/.exec(await laneControl.innerText())?.[1] ?? -1);
  await expect(input).toHaveValue("2");
  const initialStock = await readStock();
  await inspector.getByRole("button", { name: "增加一条并联线路" }).click();
  await expect(input).toHaveValue("3");
  await expect.poll(readStock).toBe(initialStock - 1);
  await expect(inspector.locator(".metric-ledger")).toContainText("36/s");

  await input.fill("5");
  await input.blur();
  await expect(input).toHaveValue("5");
  await expect.poll(readStock).toBe(initialStock - 3);
  await expect(inspector.locator(".metric-ledger")).toContainText("60/s");

  const remainingStock = await readStock();
  await input.fill(String(5 + remainingStock + 1));
  await input.blur();
  await expect(inspector.getByRole("alert")).toContainText("缺少传送带 Mk.II");
  await inspector.getByRole("button", { name: "减少一条并联线路" }).click();
  await expect(input).toHaveValue("4");
  await expect.poll(readStock).toBe(remainingStock + 1);
  await page.screenshot({ path: "artifacts/qa/v104-belt-lanes-desktop-1440x900.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await openDurableFactory(page, "/?menu=1&mobileUi=next");
  await page.locator('.react-flow__edge[data-id="v104_belt"]').evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.getByRole("button", { name: "展开铁块运输线" }).click();
  const mobileControl = page.locator(".mobile-belt-lane-control");
  await expect(mobileControl).toBeVisible();
  await expect(mobileControl.getByLabel("并联线路目标数量")).toHaveValue("4");
  for (const button of await mobileControl.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: "artifacts/qa/v104-belt-lanes-mobile-390x844.png", fullPage: true });
});

test("next mobile technology lists all infinite research and exposes real prerequisites", async ({ page }) => {
  await seedV104Factory(page, { endgame: true, mobileUi: "next" });
  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page, "/?mobileUi=next");
  await page.getByRole("button", { name: "科研", exact: true }).click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  const infinite = technology.locator(".mobile-infinite-research-list button");
  await expect(infinite).toHaveCount(5);
  await expect(technology.locator(".mobile-infinite-research-list")).toContainText("矩阵压缩");
  await technology.getByRole("button", { name: "进行中" }).click();
  await expect(technology).toContainText("当前筛选下没有科技");
  await technology.getByRole("button", { name: "清除筛选" }).click();
  await expect(technology.locator(".mobile-infinite-research-list button")).toHaveCount(5);
  const allInfinite = technology.locator(".mobile-infinite-research-list button");
  await allInfinite.first().click();
  await technology.getByRole("button", { name: "开始无限研究" }).click();
  await expect(technology.getByRole("button", { name: "正在研究" })).toBeDisabled();
  await page.screenshot({ path: "artifacts/qa/v104-infinite-tech-mobile-390x844.png", fullPage: true });
});

test("construction center accepts 100,000,000 targets, presets and mobile 200 percent text", async ({ page }) => {
  await seedV104Factory(page, { endgame: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  await page.getByLabel("打开建筑制造中心").click();
  const center = page.getByRole("dialog", { name: "建筑制造中心" });
  await expect(center.locator(".construction-center-header")).toContainText("库存上限1亿");
  const row = center.locator(".construction-center-row").filter({ hasText: "电弧熔炉" });
  const target = row.getByRole("textbox", { name: "电弧熔炉目标库存" });
  await target.fill("100000000");
  await target.blur();
  await expect(target).toHaveValue("100000000");
  await expect(row.getByLabel("电弧熔炉常用目标库存")).toHaveValue("100000000");

  await target.fill("100000001");
  await target.blur();
  await expect(row.getByRole("alert")).toContainText("当前科技上限为 100,000,000");
  await page.screenshot({ path: "artifacts/qa/v104-construction-center-desktop-1440x900.png", fullPage: true });
  await row.getByLabel("电弧熔炉常用目标库存").selectOption("100000000");
  await expect(row.getByRole("alert")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await expect(center).toBeVisible();
  await page.waitForTimeout(1_000);
  await row.scrollIntoViewIfNeeded();
  for (const control of await row.locator("button, input, select").all()) {
    const box = await control.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v104-construction-center-font-200-390x844.png", fullPage: true });
});

