import { expect, test } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

function seedDensePausedFactory() {
  return () => {
    const entities = Array.from({ length: 80 }, (_, index) => ({
      id: `canvas-machine-${index}`,
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
    const belts = Array.from({ length: 720 }, (_, index) => ({
      id: `canvas-belt-${index}`,
      planetId: "home",
      source: `canvas-machine-${index % 40}`,
      target: `canvas-machine-${40 + ((index * 7 + 1) % 40)}`,
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
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.endgame-extreme.v1", "true");
    window.localStorage.setItem("dsp-idle-network.endgame-extreme-ack.v1", "true");
    window.localStorage.removeItem("dsp-idle-network.canvas-performance-features.v1");
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  };
}

test("extreme canvas uses true node LOD, batch lines and independent SVG fallback", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.addInitScript(seedDensePausedFactory());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const shell = page.locator(".game-shell");
  const canvas = page.locator(".factory-canvas");
  await expect(shell).toHaveAttribute("data-endgame-extreme", "true");
  await expect(canvas).toHaveAttribute("data-batch-renderer", "true");
  await expect(canvas).toHaveAttribute("data-minimap-throttled", "true");
  await expect(page.locator("canvas.canvas-belt-layer")).toBeVisible();
  await expect(page.locator(".canvas-minimap-snapshot canvas")).toBeVisible();
  await expect(page.locator(".factory-node-lod--medium").first()).toBeVisible();

  const batch = await page.locator("canvas.canvas-belt-layer").evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    const context = canvasElement.getContext("2d");
    const cssWidth = Number.parseFloat(canvasElement.style.width) || canvasElement.clientWidth || canvasElement.width;
    const cssHeight = Number.parseFloat(canvasElement.style.height) || canvasElement.clientHeight || canvasElement.height;
    const scaleX = canvasElement.width / Math.max(1, cssWidth);
    const scaleY = canvasElement.height / Math.max(1, cssHeight);
    const visibleX = Math.max(0, Math.round(-(Number.parseFloat(canvasElement.style.left) || 0) * scaleX));
    const visibleY = Math.max(0, Math.round(-(Number.parseFloat(canvasElement.style.top) || 0) * scaleY));
    const pixels = context?.getImageData(
      visibleX,
      visibleY,
      Math.min(canvasElement.width - visibleX, Math.round(700 * scaleX)),
      Math.min(canvasElement.height - visibleY, Math.round(500 * scaleY)),
    ).data;
    let coloredPixels = 0;
    if (pixels) for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) coloredPixels += 1;
    return { segments: Number(canvasElement.dataset.segments ?? 0), coloredPixels };
  });
  expect(batch.segments).toBeGreaterThan(100);
  expect(batch.coloredPixels).toBeGreaterThan(50);
  expect(await page.locator(".react-flow__edge").count()).toBeLessThan(20);
  expect(batch.segments).toBeGreaterThan(await page.locator(".react-flow__edge").count());

  const firstNode = page.locator(".react-flow__node").first();
  await firstNode.click();
  await expect(firstNode).toHaveClass(/selected/);
  await expect(firstNode.locator(".factory-node-lod")).toHaveCount(0);
  await expect(firstNode.locator(".machine-node")).toBeVisible();
  const viewportBefore = await page.locator(".react-flow__viewport").getAttribute("style");

  await page.getByLabel("打开设置").click();
  const operations = page.locator(".operations-workspace");
  await expect(operations).toBeVisible();
  await selectSettingsCategory(operations, "终局性能", "performance");
  const canvasFeature = operations.locator("label.setting-row").filter({ hasText: "Canvas 批量线路" });
  await canvasFeature.getByRole("checkbox").evaluate((input: HTMLInputElement) => input.click());
  await page.getByLabel("设置已打开，再次点击返回工厂").click();

  await expect(canvas).toHaveAttribute("data-batch-renderer", "false");
  await expect(page.locator("canvas.canvas-belt-layer")).toHaveCount(0);
  expect(await page.locator(".factory-edge-visual-layer").count()).toBe(await page.locator(".react-flow__edge").count());
  await expect(firstNode).toHaveClass(/selected/);
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(viewportBefore);
  expect(runtimeErrors).toEqual([]);
});

test("turning extreme mode off restores full visuals without writing a GameState field", async ({ page }) => {
  await page.addInitScript(seedDensePausedFactory());
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.locator(".react-flow__node").first().click();
  const viewportBefore = await page.locator(".react-flow__viewport").getAttribute("style");

  await page.getByLabel("打开设置").click();
  const operations = page.locator(".operations-workspace");
  await selectSettingsCategory(operations, "终局性能", "performance");
  const extremeToggle = operations.locator("label.setting-row").filter({ hasText: "终局优化·极限模式" });
  await extremeToggle.getByRole("checkbox").evaluate((input: HTMLInputElement) => input.click());
  await page.getByLabel("设置已打开，再次点击返回工厂").click();

  await expect(page.locator(".game-shell")).toHaveAttribute("data-endgame-extreme", "false");
  await expect(page.locator(".factory-node-lod")).toHaveCount(0);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(viewportBefore);
  const persisted = await page.evaluate(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    return raw ? JSON.parse(raw).state?.endgameExtremeMode : "missing";
  });
  expect(persisted).toBeUndefined();
});

test("performance monitoring samples paused canvas percentiles and render attribution on demand", async ({ page }) => {
  await page.addInitScript(seedDensePausedFactory());
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.getByLabel("打开设置").click();
  await page.getByRole("tab", { name: "性能" }).click();
  await page.getByRole("button", { name: "开始采样" }).click();
  await page.waitForTimeout(1_300);
  const panel = page.locator(".performance-monitor-panel");
  await expect(panel).toContainText("帧耗时 P50 / P95");
  await expect(panel).toContainText("Worker 状态传输");
  await expect(panel).toContainText("画布快照");
  await expect(panel).toContainText("React Flow 对象");
  await expect(panel).toContainText("实际 DOM");
  await expect(panel).toContainText("终局·极限模式");
  const values = await panel.locator(".performance-kpi-grid article").evaluateAll((articles) => articles.map((article) => article.textContent ?? ""));
  expect(values.some((value) => /React Flow 对象.*(?:8\d|9\d|[1-9]\d{2,}) 节点/s.test(value))).toBe(true);
  await page.getByRole("button", { name: "停止采样" }).click();
});

test("minimap throttle can independently fall back without resetting the viewport", async ({ page }) => {
  await page.addInitScript(seedDensePausedFactory());
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  const minimapCanvas = page.locator(".canvas-minimap-snapshot canvas");
  await expect(minimapCanvas).toBeVisible();
  const drawsBeforePan = Number(await minimapCanvas.getAttribute("data-draw-count"));
  const pane = page.locator(".react-flow__pane");
  const bounds = await pane.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + 24, bounds!.y + 24);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 120, bounds!.y + 84, { steps: 12 });
  expect(Number(await minimapCanvas.getAttribute("data-draw-count"))).toBe(drawsBeforePan);
  await page.mouse.up();
  await expect.poll(async () => Number(await minimapCanvas.getAttribute("data-draw-count"))).toBeGreaterThan(drawsBeforePan);
  const viewportAfterPan = await page.locator(".react-flow__viewport").getAttribute("style");

  await page.getByLabel("打开设置").click();
  const operations = page.locator(".operations-workspace");
  await selectSettingsCategory(operations, "终局性能", "performance");
  const minimapFeature = operations.locator("label.setting-row").filter({ hasText: "小地图低频快照" });
  await minimapFeature.getByRole("checkbox").evaluate((input: HTMLInputElement) => input.click());
  await page.getByLabel("设置已打开，再次点击返回工厂").click();

  await expect(page.locator(".factory-canvas")).toHaveAttribute("data-minimap-throttled", "false");
  await expect(page.locator(".canvas-minimap-snapshot")).toHaveCount(0);
  await expect(page.locator(".react-flow__minimap-svg")).toBeVisible();
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(viewportAfterPan);
});

test("canvas failures automatically restore the complete React Flow renderers", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args: Parameters<HTMLCanvasElement["getContext"]>) {
      if (this.classList.contains("canvas-belt-layer") || this.parentElement?.classList.contains("canvas-minimap-snapshot")) return null;
      return original.apply(this, args as never);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.addInitScript(seedDensePausedFactory());
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");

  const canvas = page.locator(".factory-canvas");
  await expect(canvas).toHaveAttribute("data-batch-renderer", "false");
  await expect(canvas).toHaveAttribute("data-minimap-throttled", "false");
  await expect(page.locator("canvas.canvas-belt-layer")).toHaveCount(0);
  await expect(page.locator(".canvas-minimap-snapshot")).toHaveCount(0);
  await expect(page.locator(".react-flow__minimap-svg")).toBeVisible();
  expect(await page.locator(".factory-edge-visual-layer").count()).toBe(await page.locator(".react-flow__edge").count());
});
