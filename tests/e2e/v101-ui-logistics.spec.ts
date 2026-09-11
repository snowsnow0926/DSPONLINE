import { expect, test, type Page } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-11-v1.0.38";

async function seedUiState(page: Page, options: { theme?: "dark" | "light"; fontScale?: number; paused?: boolean } = {}) {
  await page.addInitScript(({ theme, fontScale, paused, releaseNoteId }) => {
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
    const state = {
      version: 34,
      nextId: 6,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "wind", kind: "power", position: { x: -280, y: -180 }, buildingId: "wind_turbine", machineCount: 20 },
        { ...entityBase, id: "smelter", kind: "machine", position: { x: 40, y: -180 }, buildingId: "arc_smelter", recipeId: "magnet", machineCount: 1, progress: 0.22, inputs: { iron_ore: 10_000 } },
        { ...entityBase, id: "storage", kind: "storage", position: { x: -250, y: 170 }, buildingId: "storage_mk1", storedItemId: "plane_filter", machineCount: 10, inputs: { plane_filter: 12_345 }, outputs: { plane_filter: 98_765 } },
        { ...entityBase, id: "tank", kind: "storage", position: { x: 120, y: 170 }, buildingId: "storage_tank", storedItemId: "sulfuric_acid", machineCount: 10, inputs: { sulfuric_acid: 45_678 }, outputs: { sulfuric_acid: 76_543 } },
      ],
      belts: [],
      construction: { arc_smelter: 2, plane_smelter: 2, spray_coater: 2 },
      tray: { iron_ore: 100_000, space_warper: 100 },
      planetTrays: { home: { iron_ore: 100_000, space_warper: 100 } },
      planetTrayItemLimits: { home: 1_000_000 },
      totalProduced: {},
      research: {
        selectedTechId: null,
        pausedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["electromagnetism", "proliferator_1", "plane_smelting"],
      },
      settings: {
        theme,
        fontScale,
        simulationSpeed: 1,
        autosaveIntervalSeconds: 30,
      },
      paused,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.production-refresh.v1", "classic");
    if (window.sessionStorage.getItem("dsp-idle-network.v101-fixture-seeded") !== "1") {
      window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
      window.sessionStorage.setItem("dsp-idle-network.v101-fixture-seeded", "1");
    }
  }, {
    theme: options.theme ?? "dark",
    fontScale: options.fontScale ?? 1,
    paused: options.paused ?? true,
    releaseNoteId: RELEASE_NOTE_ID,
  });
}

async function dismissOnboarding(page: Page) {
  const close = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await close.count()) await close.first().click();
}

async function openGame(page: Page, path = "/") {
  await page.goto(path);
  await dismissOnboarding(page);
  await expect(page.locator(".factory-canvas")).toBeVisible();
}

function rgbLuminance(value: string): number {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  return channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

test("exact-value tooltip and classic progress share one visible value", async ({ page }) => {
  await seedUiState(page, { paused: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGame(page);

  const smelter = page.locator('.react-flow__node[data-id="smelter"]');
  const power = page.locator('.react-flow__node[data-id="wind"] .power-value').first();
  const tooltip = page.locator('.quantity-value__tooltip').filter({ hasText: "5,760 kW" });
  await expect(power).toBeVisible();
  await expect(tooltip).toBeHidden();
  await expect(async () => {
    await power.hover();
    await expect(tooltip).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator(".quantity-value__tooltip:visible")).toHaveCount(1);
  await page.mouse.move(4, 4);
  await expect(tooltip).toBeHidden();
  await power.click();
  await power.focus();
  await expect(tooltip).toBeVisible();
  await page.locator(".react-flow__pane").click({ position: { x: 15, y: 15 } });
  await expect(tooltip).toBeHidden();

  const cycle = smelter.locator(".work-cycle[role='progressbar']");
  const samples: Array<{ aria: number; text: number; fill: number }> = [];
  for (let index = 0; index < 18; index += 1) {
    await page.waitForTimeout(100);
    samples.push(await cycle.evaluate((element) => {
      const aria = Number(element.getAttribute("aria-valuenow"));
      const text = Number(element.querySelector("strong")?.textContent?.match(/\d+/)?.[0] ?? Number.NaN);
      const transform = (element.querySelector("i") as HTMLElement | null)?.style.transform ?? "scaleX(0)";
      return { aria, text, fill: Number(transform.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0) * 100 };
    }));
  }
  for (const sample of samples) {
    expect(sample.text).toBe(sample.aria);
    expect(Math.abs(sample.fill - sample.aria)).toBeLessThanOrEqual(1.1);
  }
  const illegalDrops = samples.slice(1).filter((sample, index) => {
    const previous = samples[index];
    const drop = previous.aria - sample.aria;
    const clearCycleWrap = drop >= 50;
    return drop > 1 && !clearCycleWrap;
  });
  expect(illegalDrops).toHaveLength(0);
  await page.screenshot({ path: "artifacts/qa/v101-progress-tooltip-dark-1440x900.png", fullPage: true });
});

test("building lock persists, protects commands and turns a body drag into canvas pan", async ({ page }) => {
  await seedUiState(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGame(page);
  let smelter = page.locator('.react-flow__node[data-id="smelter"]');
  await smelter.locator(".factory-node__header").click();
  await page.getByLabel("锁定所选建筑").click();
  await expect(smelter.locator(".factory-node--locked")).toBeVisible();
  await expect(page.locator(".inspector-lock-banner")).toContainText("建筑已锁定");
  await expect(page.locator(".inspector-lockable")).toHaveAttribute("disabled", "");

  const beforeViewport = await page.locator(".react-flow__viewport").getAttribute("style");
  const box = await smelter.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(box!.height - 20, 82));
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 90, box!.y + Math.min(box!.height - 20, 82) + 35, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.locator(".react-flow__viewport").getAttribute("style")).not.toBe(beforeViewport);

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => page.evaluate(() => {
    const payload = JSON.parse(window.localStorage.getItem("dsp-idle-network.save.v1") ?? "{}");
    return payload.state?.entities?.find((entity: { id: string }) => entity.id === "smelter")?.interactionLocked;
  })).toBe(true);
  await page.reload();
  await dismissOnboarding(page);
  smelter = page.locator('.react-flow__node[data-id="smelter"]');
  await expect(smelter.locator(".factory-node--locked")).toBeVisible();
  await smelter.locator(".factory-node__header").click();
  await page.locator(".inspector-lock-banner").getByRole("button", { name: "解锁" }).click();
  await expect(smelter.locator(".factory-node--locked")).toHaveCount(0);
});

test("inspector order and collapse are local preferences and survive reload", async ({ page }) => {
  await seedUiState(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGame(page);
  const selectSmelter = async () => page.locator('.react-flow__node[data-id="smelter"] .factory-node__header').click();
  await selectSmelter();
  await page.getByRole("button", { name: "检查器布局" }).click();
  const powerRow = page.locator('[data-inspector-layout-row="power"]');
  const powerGrip = powerRow.locator(".inspector-layout-grip");
  await powerGrip.focus();
  for (let index = 0; index < 4; index += 1) await page.keyboard.press("Alt+ArrowUp");
  const recipeRow = page.locator('[data-inspector-layout-row="recipe"]');
  await recipeRow.getByRole("button", { name: "折叠" }).click();
  const collapsedRecipe = page.locator('[data-inspector-section="recipe"]');
  await expect(collapsedRecipe).toBeVisible();
  await expect(collapsedRecipe).toHaveAttribute("aria-label", "配方与主要模式");
  await expect(collapsedRecipe.getByRole("button")).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem("dsp-idle-network.inspector-layout.v1") ?? "{}"))).toMatchObject({
    version: 1,
    order: ["power", "recipe", "stack", "upgrade", "proliferator"],
    collapsed: ["recipe"],
  });
  await page.reload();
  await dismissOnboarding(page);
  await selectSmelter();
  await expect(page.locator('[data-inspector-section="recipe"]')).toBeVisible();
  const powerOrder = await page.locator('[data-inspector-section="power"]').evaluate((element) => getComputedStyle(element).order);
  const stackOrder = await page.locator('[data-inspector-section="stack"]').evaluate((element) => getComputedStyle(element).order);
  expect(Number(powerOrder)).toBeLessThan(Number(stackOrder));
  await page.getByRole("button", { name: "检查器布局" }).click();
  await page.getByRole("button", { name: "恢复默认" }).click();
  const resetPowerGrip = page.locator('[data-inspector-layout-row="power"] .inspector-layout-grip');
  const resetRecipeRow = page.locator('[data-inspector-layout-row="recipe"]');
  const [powerBox, recipeBox] = await Promise.all([resetPowerGrip.boundingBox(), resetRecipeRow.boundingBox()]);
  expect(powerBox).not.toBeNull();
  expect(recipeBox).not.toBeNull();
  await page.mouse.move(powerBox!.x + powerBox!.width / 2, powerBox!.y + powerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(recipeBox!.x + 12, recipeBox!.y + recipeBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => JSON.parse(window.localStorage.getItem("dsp-idle-network.inspector-layout.v1") ?? "{}").order?.[0])).toBe("power");
});

test("light lazy workspaces, storage geometry and 100M tray remain usable at 200 percent", async ({ page }) => {
  await seedUiState(page, { theme: "light", fontScale: 2 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGame(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  for (const name of ["小型储物仓", "储液罐"]) {
    const node = page.locator(".react-flow__node").filter({ hasText: name });
    await expect(node).toContainText(name);
    await expect(node).toContainText("输入");
    await expect(node).toContainText("输出");
    const geometry = await node.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const input = element.querySelector(".factory-handle--input")?.getBoundingClientRect();
      const output = element.querySelector(".factory-handle--output")?.getBoundingClientRect();
      return input && output ? {
        inputDelta: Math.abs(input.left + input.width / 2 - box.left),
        outputDelta: Math.abs(output.left + output.width / 2 - box.right),
      } : null;
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.inputDelta).toBeLessThanOrEqual(20);
    expect(geometry!.outputDelta).toBeLessThanOrEqual(20);
  }

  await page.getByLabel("管理当前行星物资").click();
  const trayDialog = page.getByRole("dialog", { name: "管理当前行星物资托盘" });
  await trayDialog.getByRole("button", { name: "1亿", exact: true }).click();
  await expect(trayDialog.getByLabel("自定义每种物资库存上限")).toHaveValue("100000000");
  await trayDialog.getByRole("button", { name: "关闭物资管理" }).click();

  await page.getByLabel("打开生产资料库").click();
  const codex = page.getByRole("dialog", { name: "生产资料库" });
  await codex.locator(".codex-section-nav").getByRole("button", { name: /建筑设施/ }).click();
  const colors = await codex.locator(".codex-index").evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color };
  });
  expect(rgbLuminance(colors.background)).toBeGreaterThan(210);
  expect(rgbLuminance(colors.color)).toBeLessThan(130);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v101-light-storage-codex-font-200-1440x900.png", fullPage: true });
});

test("next mobile light shell keeps lazy surfaces themed in portrait and landscape", async ({ page }) => {
  await seedUiState(page, { theme: "light", fontScale: 2 });
  for (const viewport of [
    { width: 390, height: 844, shot: "portrait" },
    { width: 844, height: 390, shot: "landscape" },
  ]) {
    await page.setViewportSize(viewport);
    await openGame(page, "/?mobileUi=next");
    const navButtons = page.locator(".mobile-next-bottom-nav button");
    for (let index = 0; index < await navButtons.count(); index += 1) {
      const box = await navButtons.nth(index).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "更多", exact: true }).click();
    const hub = page.locator(".mobile-next-workspace-hub");
    const hubBackground = await hub.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(rgbLuminance(hubBackground)).toBeGreaterThan(210);
    await hub.getByRole("button", { name: /生产资料库/ }).first().click();
    const codex = page.getByRole("dialog", { name: "生产资料库" });
    await expect(codex).toBeVisible();
    await expect(codex.locator(".recipe-index > button").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/qa/v101-mobile-light-font-200-${viewport.shot}.png`, fullPage: true });
  }
});

test("dark light dark switching and the classic mobile tablet matrix stay bounded", async ({ page }) => {
  await seedUiState(page, { theme: "dark", fontScale: 1 });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openGame(page);

  const setVisualFontScale = async (scale: number) => page.evaluate((nextScale) => {
    document.documentElement.dataset.uiFontScale = String(Math.round(nextScale * 100));
    document.documentElement.style.setProperty("--ui-font-scale", String(nextScale));
  }, scale);
  const assertBounded = async () => expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  ))).toBe(true);

  await page.getByLabel("打开生产资料库").click();
  let codex = page.getByRole("dialog", { name: "生产资料库" });
  await expect(codex).toBeVisible();
  for (const scale of [0.8, 1, 1.5, 2]) {
    await setVisualFontScale(scale);
    await assertBounded();
    await page.screenshot({ path: `artifacts/qa/v101-desktop-dark-font-${Math.round(scale * 100)}-1920x1080.png`, fullPage: true });
  }
  await page.keyboard.press("Escape");

  await page.getByTitle("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByLabel("界面主题").getByRole("button", { name: "亮色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Escape");
  await page.getByLabel("打开生产资料库").click();
  codex = page.getByRole("dialog", { name: "生产资料库" });
  for (const scale of [0.8, 1, 1.5, 2]) {
    await setVisualFontScale(scale);
    await assertBounded();
    await page.screenshot({ path: `artifacts/qa/v101-desktop-light-font-${Math.round(scale * 100)}-1920x1080.png`, fullPage: true });
  }
  await page.keyboard.press("Escape");

  await page.getByTitle("打开设置").click();
  await operations.getByLabel("界面主题").getByRole("button", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Escape");
  await setVisualFontScale(1);
  await page.screenshot({ path: "artifacts/qa/v101-desktop-dark-return-1920x1080.png", fullPage: true });

  for (const viewport of [
    { width: 390, height: 844, name: "classic-mobile" },
    { width: 768, height: 1024, name: "tablet" },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/?mobileUi=legacy");
    await dismissOnboarding(page);
    await expect(page.locator(".factory-canvas")).toBeVisible();
    await setVisualFontScale(2);
    await assertBounded();
    await page.screenshot({ path: `artifacts/qa/v101-${viewport.name}-dark-font-200-${viewport.width}x${viewport.height}.png`, fullPage: true });
  }
});
