import { expect, test, type Page } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

const RELEASE_NOTE_ID = "2026-08-11-v1.0.38";
const BELT_LANES_KEY = "dsp-idle-network.ui.default-belt-lanes.v1";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((releaseNoteId) => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
  }, RELEASE_NOTE_ID);
  const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
  await page.addLocatorHandler(offlineReport, async () => {
    await offlineReport.getByRole("button", { name: "确认结算" }).click();
  });
});

async function openSettings(page: Page, mode: "desktop" | "legacy" | "next", viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(mode === "next" ? "/?mobileUi=next" : "/");
  await expect(page.locator(".game-shell")).toBeVisible();
  if (mode === "next") {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.locator("button:visible").filter({ hasText: "游戏设置" }).first().click();
  } else if (mode === "legacy") {
    await page.getByRole("button", { name: "更多工作区" }).click();
    await page.getByRole("menuitem", { name: "设置" }).click();
  } else {
    await page.getByLabel("打开设置").click();
  }
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await expect(operations).toBeVisible();
  return operations;
}

function denseFactorySeed(options: { canvasFailure?: boolean } = {}) {
  return ({ releaseNoteId, canvasFailure }: { releaseNoteId: string; canvasFailure: boolean }) => {
    if (canvasFailure) {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args: Parameters<HTMLCanvasElement["getContext"]>) {
        if (this.classList.contains("canvas-belt-layer")) return null;
        return original.apply(this, args as never);
      } as typeof HTMLCanvasElement.prototype.getContext;
    }
    const entities = Array.from({ length: 80 }, (_, index) => ({
      id: `v136-machine-${index}`,
      kind: "machine",
      planetId: "home",
      position: { x: (index % 10) * 310, y: Math.floor(index / 10) * 220 },
      interactionLocked: false,
      buildingId: "arc_smelter",
      recipeId: index < 40 ? "iron_ingot" : "steel",
      machineCount: 10,
      minerCount: 0,
      inputs: { iron_ore: 600 },
      outputs: { iron_ingot: 600 },
      progress: 0.4,
      utilization: 1,
      productionRate: 600,
    }));
    const belts = Array.from({ length: 1_600 }, (_, index) => ({
      id: `v136-belt-${String(index).padStart(4, "0")}`,
      planetId: "home",
      source: `v136-machine-${index % 40}`,
      target: `v136-machine-${40 + ((index * 7 + 1) % 40)}`,
      itemId: "iron_ingot",
      lanes: 2,
      tier: 1,
      sorterTier: 1,
      stackSize: 1,
      progress: (index % 10) / 10,
      priority: 1,
      totalTransferred: index * 20,
      lastFlow: index % 3 === 0 ? 12 : 4,
      congestion: 0.2,
    }));
    const state = {
      version: 46,
      nextId: 1,
      activePlanetId: "home",
      entities,
      belts,
      construction: {},
      tray: {},
      planetTrays: { home: {} },
      planetTrayItemLimits: { home: 1_000_000 },
      totalProduced: {},
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"], surveyProgressBySystem: { helios: 1 }, missions: [] },
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 120 },
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.removeItem("dsp-idle-network.endgame-extreme.v1");
    window.localStorage.removeItem("dsp-idle-network.canvas-performance-features.v1");
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  };
}

test("default new-belt lanes validate, persist on the device, and stay out of GameState", async ({ page }) => {
  let operations = await openSettings(page, "desktop", { width: 1440, height: 900 });
  await selectSettingsCategory(operations, "交互与控制", "interaction");
  const setting = operations.locator(".settings-belt-lanes");
  await expect(setting).toContainText("1 / 4,096");
  await expect(setting.getByLabel("新建传送带默认并联数量").getByRole("button", { name: "×1" })).toHaveAttribute("aria-pressed", "true");

  await setting.getByRole("button", { name: "自定义" }).click();
  const input = setting.getByLabel("新建传送带默认并联数量自定义值");
  for (const [raw, message] of [
    ["", "请输入默认并联数量"],
    ["0", "不能低于 1"],
    ["-1", "不能为负数"],
    ["1.5", "只接受整数"],
    ["1e3", "不接受指数格式"],
    ["4097", "不能高于 4096"],
  ] as const) {
    await input.fill(raw);
    await setting.getByRole("button", { name: "应用" }).click();
    await expect(setting.getByRole("alert")).toContainText(message);
  }
  await input.fill("4096");
  await setting.getByRole("button", { name: "应用" }).click();
  await expect(setting).toContainText("4,096 / 4,096");
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), BELT_LANES_KEY)).toBe("4096");
  expect(await page.evaluate(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    return raw ? JSON.parse(raw).state?.defaultBeltLanes : undefined;
  })).toBeUndefined();

  await page.reload();
  await expect(page.locator(".game-shell")).toBeVisible();
  operations = await openSettings(page, "desktop", { width: 1440, height: 900 });
  await selectSettingsCategory(operations, "交互与控制", "interaction");
  await expect(operations.locator(".settings-belt-lanes")).toContainText("4,096 / 4,096");
  await operations.locator(".settings-belt-lanes").getByRole("button", { name: "恢复默认 ×1" }).click();
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), BELT_LANES_KEY)).toBe("1");
});

test("belt-lane controls fit desktop, classic/new mobile, portrait/landscape, and all font scales", async ({ page }) => {
  test.setTimeout(120_000);
  const configurations = [
    ["desktop", { width: 1440, height: 900 }],
    ["legacy", { width: 390, height: 844 }],
    ["legacy", { width: 740, height: 390 }],
    ["next", { width: 390, height: 844 }],
    ["next", { width: 740, height: 390 }],
  ] as const;
  for (const [mode, viewport] of configurations) {
    const operations = await openSettings(page, mode, viewport);
    for (const scale of [80, 100, 125, 150, 200] as const) {
      await selectSettingsCategory(operations, "画面与主题", "visual");
      await operations.getByLabel("字体大小").getByRole("button", { name: `${scale}%` }).click();
      await selectSettingsCategory(operations, "交互与控制", "interaction");
      const setting = operations.locator(".settings-belt-lanes");
      await expect(setting.getByLabel("新建传送带默认并联数量").getByRole("button", { name: "×1" })).toBeVisible();
      await expect(setting.getByRole("button", { name: "自定义" })).toBeVisible();
      await expect.poll(async () => operations.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      if (mode !== "desktop") {
        const sizes = await setting.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
        expect(sizes.every((height) => height >= 40)).toBe(true);
      }
    }
  }
});

test("dense planets auto-enable Canvas hit testing without extreme mode and promote only the interacted belt", async ({ page }) => {
  await page.addInitScript(denseFactorySeed(), { releaseNoteId: RELEASE_NOTE_ID, canvasFailure: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const shell = page.locator(".game-shell");
  const factory = page.locator(".factory-canvas");
  await expect(shell).toHaveAttribute("data-endgame-extreme", "false");
  await expect(shell).toHaveAttribute("data-canvas-auto-dense", "true");
  await expect(factory).toHaveAttribute("data-batch-renderer", "true");
  await expect(page.locator("canvas.canvas-belt-layer")).toHaveAttribute("data-segments", "1600");
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);

  const source = await page.locator('.react-flow__node[data-id="v136-machine-0"]').boundingBox();
  expect(source).not.toBeNull();
  const hit = { x: source!.x + source!.width + 8, y: source!.y + source!.height / 2 };
  await page.mouse.move(hit.x, hit.y);
  await expect.poll(() => page.locator(".react-flow__edge").count()).toBeGreaterThan(0);
  expect(await page.locator(".react-flow__edge").count()).toBeLessThan(10);
  await page.mouse.click(hit.x, hit.y);
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
});

test("automatic dense mode falls back to complete React Flow edges when Canvas is unavailable", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(denseFactorySeed({ canvasFailure: true }), { releaseNoteId: RELEASE_NOTE_ID, canvasFailure: true });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-canvas-auto-dense", "true");
  await expect(page.locator(".factory-canvas")).toHaveAttribute("data-batch-renderer", "false");
  await expect(page.locator("canvas.canvas-belt-layer")).toHaveCount(0);
  expect(await page.locator(".react-flow__edge").count()).toBeGreaterThan(100);
  expect(await page.locator(".factory-edge-visual-layer").count()).toBe(await page.locator(".react-flow__edge").count());
});
