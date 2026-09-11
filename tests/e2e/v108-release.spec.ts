import { expect, test, type Page } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";

async function seedV108Factory(page: Page, options: { mobileUi?: "legacy" | "next"; theme?: "dark" | "light"; fontScale?: number } = {}) {
  await page.addInitScript(({ releaseNoteId, mobileUi, theme, fontScale }) => {
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
      version: 39,
      nextId: 20,
      activePlanetId: "home",
      entities: [
        { ...base, id: "v108_source", kind: "storage", position: { x: -300, y: 0 }, buildingId: "storage_mk1", storedItemId: "iron_ore", machineCount: 1, outputs: { iron_ore: 1_000 } },
        { ...base, id: "v108_hub", kind: "storage", position: { x: 120, y: 0 }, buildingId: "material_delivery_hub", machineCount: 1, inputs: { iron_ore: 4 }, deliveryItemIds: ["iron_ore"], deliverySlots: [{ itemId: "iron_ore", mode: "auto" }, { itemId: null, mode: "auto" }, { itemId: null, mode: "auto" }] },
      ],
      belts: [{ id: "v108_delivery_line", planetId: "home", source: "v108_source", target: "v108_hub", itemId: "iron_ore", lanes: 2, tier: 1, sorterTier: 1, progress: 0, priority: 0, stackSize: 1, monitorEnabled: false, totalTransferred: 0, congestion: 0, lastFlow: 0, routeMode: "auto", targetPortIndex: 0 }],
      construction: { conveyor_belt_mk1: 5, storage_mk1: 0, material_delivery_hub: 0, arc_smelter: 2 },
      constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {}, jobs: {} },
      blueprints: [],
      tray: { iron_ore: 100, copper_ore: 100, stone: 100 },
      planetTrays: { home: { iron_ore: 100, copper_ore: 100, stone: 100 } },
      planetTrayItemLimits: { home: 1_000_000 },
      portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
      totalProduced: {},
      elapsedSeconds: 12_143,
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["electromagnetism", "basic_logistics", "material_delivery_logistics"] },
      settings: { theme, fontScale, simulationSpeed: 1, autosaveIntervalSeconds: 30, resourceMode: "finite" },
      paused: false,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", mobileUi);
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  }, {
    releaseNoteId: RELEASE_NOTE_ID,
    mobileUi: options.mobileUi ?? "legacy",
    theme: options.theme ?? "dark",
    fontScale: options.fontScale ?? 1,
  });
}

async function openFactory(page: Page, path = "/") {
  const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
  await page.addLocatorHandler(offlineReport, async () => {
    await offlineReport.getByRole("button", { name: "确认结算" }).click({ force: true });
  });
  await page.goto(path);
  const acknowledgeRelease = page.getByRole("button", { name: "我知道了" });
  if (await acknowledgeRelease.isVisible().catch(() => false)) await acknowledgeRelease.click();
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.count()) await onboarding.first().click();
  await expect(page.locator(".factory-canvas")).toBeVisible();
}

function checksum(formatVersion: number, state: unknown): string {
  const payload = JSON.stringify({ formatVersion, state });
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

test("structurally complete checksum failures show real progress and require two-step rescue", async ({ page }) => {
  await page.addInitScript((releaseNoteId) => window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId), RELEASE_NOTE_ID);
  await page.goto("/");
  const state = {
    version: 38,
    nextId: 2,
    activePlanetId: "home",
    entities: [{ id: "rescue-storage", kind: "storage", planetId: "home", position: { x: 0, y: 0 }, buildingId: "storage_mk1", machineCount: 1, minerCount: 0, inputs: {}, outputs: { iron_ingot: 42 }, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0, interactionLocked: false }],
    belts: [],
    elapsedSeconds: 12_143,
    constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {}, jobs: {} },
    blueprints: [],
    research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["electromagnetism", "basic_logistics"] },
    settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30, resourceMode: "finite" },
  };
  const raw = JSON.stringify({ formatVersion: 2, kind: "primary", savedAt: Date.now(), state, checksum: "27ca23f8" });
  await page.getByLabel("选择存档文件").setInputFiles({ name: "damaged-save.json", mimeType: "application/json", buffer: Buffer.from(raw) });
  const result = page.locator(".start-menu-import-result");
  await expect(result).toContainText("存档结构完整，可受控救援");
  await expect(result).toContainText("3 小时 22 分");
  await expect(result).not.toContainText("运行时间0 分钟");
  await result.getByRole("button", { name: "救援此存档" }).click();
  await expect(result.getByRole("button", { name: "再次确认并救援" })).toBeVisible();
  const download = page.waitForEvent("download");
  await result.getByRole("button", { name: "再次确认并救援" }).click();
  expect((await download).suggestedFilename()).toContain("rescue-backup");
  await expect(page.locator(".factory-canvas")).toBeVisible();
  const integrity = await page.evaluate(() => {
    const rawSave = window.localStorage.getItem("dsp-idle-network.save.v1")!;
    const parsed = JSON.parse(rawSave);
    return { formatVersion: parsed.formatVersion, version: parsed.state.version, checksum: parsed.checksum, state: parsed.state };
  });
  expect(integrity.version).toBe(47);
  expect(integrity.checksum).toBe(checksum(integrity.formatVersion, integrity.state));
});

test("delivery-hub ports reset independently and the performance monitor samples only on demand", async ({ page }) => {
  await seedV108Factory(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  await page.locator('.react-flow__node[data-id="v108_hub"]').click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.locator(".delivery-hub-slot")).toHaveCount(3);
  const firstPort = inspector.locator(".delivery-hub-slot").first();
  await expect(firstPort).toContainText("自动识别已绑定");
  await firstPort.getByRole("button", { name: "清空接口" }).click();
  await page.locator(".game-dialog").getByRole("button", { name: "断开并重置" }).click();
  await expect(firstPort).toContainText("已清空");
  await expect(page.locator('.react-flow__edge[data-id="v108_delivery_line"]')).toHaveCount(0);
  await expect(inspector.locator(".delivery-hub-slot").nth(1)).toContainText("等待自动识别");

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "性能" }).click();
  await expect(operations).toContainText("监控已关闭");
  await operations.getByRole("button", { name: "开始采样" }).click();
  await expect(operations).toContainText("正在采样");
  await expect.poll(async () => operations.locator(".performance-kpi-grid article").count(), { timeout: 8_000 }).toBeGreaterThanOrEqual(15);
  await expect(operations.locator(".performance-phase-list > div")).toHaveCount(10);
  await expect(operations).toContainText("建筑生产与采集");
  await expect(operations).toContainText("量子物流");
  await operations.getByRole("button", { name: "停止采样" }).click();
  await expect(operations).toContainText("监控已关闭");
  await page.screenshot({ path: "artifacts/qa/v108-performance-desktop-1440x900.png", fullPage: true });
});

test("light fabrication names remain readable and next-mobile delivery controls keep 44px targets at 200 percent", async ({ page }) => {
  await seedV108Factory(page, { theme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator(".inspector-panel").getByRole("tab", { name: "基础制造" }).click();
  const readable = await page.locator(".construction-item > span").first().evaluate((element) => {
    const parse = (value: string) => (value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0]).map((channel) => {
      const normalized = channel / 255;
      return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
    });
    const luminance = (channels: number[]) => channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    const style = getComputedStyle(element);
    const foreground = luminance(parse(style.color));
    const background = luminance(parse(getComputedStyle(element.closest(".construction-item")!).backgroundColor));
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
  });
  expect(readable).toBeGreaterThanOrEqual(4.5);
  await page.getByLabel("基础制造模式").getByRole("button", { name: "物品手工" }).click();
  const handcraftReadable = await page.locator(".fabricator-row header strong").first().evaluate((element) => {
    const parse = (value: string) => (value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0]).map((channel) => {
      const normalized = channel / 255;
      return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
    });
    const luminance = (channels: number[]) => channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    const foreground = luminance(parse(getComputedStyle(element).color));
    const background = luminance(parse(getComputedStyle(element.closest(".fabricator-row")!).backgroundColor));
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
  });
  expect(handcraftReadable).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: "artifacts/qa/v108-light-fabrication-1440x900.png", fullPage: true });
});

test("next-mobile delivery controls remain reachable at 200 percent text", async ({ page }) => {
  await seedV108Factory(page, { mobileUi: "next", fontScale: 2 });
  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page, "/?mobileUi=next");
  const unexpectedExit = page.getByRole("alertdialog", { name: "保存并返回主菜单" });
  if (await unexpectedExit.count()) {
    await unexpectedExit.getByRole("button", { name: "继续游戏" }).click({ force: true });
    await expect(unexpectedExit).toHaveCount(0);
  }
  await page.locator('.react-flow__node[data-id="v108_hub"]').click();
  const sheet = page.locator(".mobile-inspector-sheet");
  await sheet.getByRole("button", { name: /^展开/ }).click();
  const controls = sheet.locator(".mobile-delivery-slot-controls");
  await expect(controls).toBeVisible();
  for (const control of await controls.locator("button").all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v108-mobile-delivery-font200-390x844.png", fullPage: true });
});

test("classic-mobile delivery ports remain reachable at 200 percent text", async ({ page }) => {
  await seedV108Factory(page, { mobileUi: "legacy", fontScale: 2 });
  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page, "/?mobileUi=legacy");
  await page.locator('.react-flow__node[data-id="v108_hub"]').click();
  const shell = page.locator(".game-shell");
  if (!await shell.evaluate((element) => element.classList.contains("mobile-panel--inspector"))) {
    await page.getByLabel("打开检查器").click();
  }
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.locator(".delivery-hub-slot")).toHaveCount(3);
  const controls = inspector.locator(".delivery-hub-slot-actions").first();
  await controls.scrollIntoViewIfNeeded();
  for (const control of await controls.locator("button").all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await expect.poll(() => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v108-classic-mobile-delivery-font200-390x844.png", fullPage: true });
});

