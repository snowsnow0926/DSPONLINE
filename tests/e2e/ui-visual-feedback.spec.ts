import { expect, test, type Locator, type Page } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";
const VISUAL_FIXTURE_SESSION_KEY = "dsp-idle-network.ui-visual-fixture-seeded.v1";

async function seedVisualFactory(page: Page, options: { fontScale?: number; extreme?: boolean } = {}) {
  await page.addInitScript(({ fontScale, extreme, releaseNoteId, fixtureSessionKey }) => {
    const base = {
      planetId: "home",
      minerCount: 0,
      routingCursor: 0,
      progress: 0.35,
      utilization: 0,
      productionRate: 0,
      inputs: {},
      outputs: {},
    };
    const state = {
      version: 35,
      nextId: 20,
      activePlanetId: "home",
      entities: [
        { ...base, id: "visual-iron", kind: "vein", position: { x: -420, y: -120 }, resourceId: "iron_ore", machineCount: 0, minerCount: 1, resourceRemaining: 48_000, resourceCapacity: 50_000, outputs: { iron_ore: 80 } },
        { ...base, id: "visual-smelter", kind: "machine", position: { x: -80, y: -120 }, buildingId: "arc_smelter", recipeId: "iron_ingot", machineCount: 2, inputs: { iron_ore: 30 } },
        { ...base, id: "visual-storage", kind: "storage", position: { x: 260, y: -120 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", machineCount: 3, inputs: { iron_ingot: 20 }, outputs: { iron_ingot: 60 } },
        { ...base, id: "visual-wind", kind: "power", position: { x: -120, y: 220 }, buildingId: "wind_turbine", machineCount: 8 },
      ],
      belts: [
        { id: "visual-belt", planetId: "home", source: "visual-iron", target: "visual-smelter", itemId: "iron_ore", lanes: 2, tier: 1, sorterTier: 1, progress: 0.25, priority: 1, stackSize: 2, monitorEnabled: true, totalTransferred: 120, congestion: 0.1, lastFlow: 12 },
      ],
      construction: { arc_smelter: 3, storage_mk1: 2, wind_turbine: 2, conveyor_belt_mk1: 30 },
      tray: { iron_ore: 3_000, copper_ore: 1_200, stone: 800, iron_ingot: 250 },
      planetTrays: { home: { iron_ore: 3_000, copper_ore: 1_200, stone: 800, iron_ingot: 250 } },
      planetTrayItemLimits: { home: 1_000_000 },
      totalProduced: {},
      manualMined: 1,
      achievements: { unlockedIds: [] },
      research: {
        selectedTechId: null,
        pausedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["electromagnetism", "basic_smelting", "proliferator_1"],
      },
      exploration: {
        unlockedSystemIds: ["helios"],
        colonizedPlanetIds: ["home"],
        missions: [],
        surveyProgressBySystem: { helios: 1 },
      },
      settings: {
        theme: "light",
        fontScale,
        simulationSpeed: 1,
        autosaveIntervalSeconds: 30,
        resourceMode: "finite",
      },
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    if (window.localStorage.getItem("dsp-idle-network.ui.theme.v1") == null) window.localStorage.setItem("dsp-idle-network.ui.theme.v1", "light");
    if (window.localStorage.getItem("dsp-idle-network.ui.show-run-log.v1") == null) window.localStorage.setItem("dsp-idle-network.ui.show-run-log.v1", "true");
    window.localStorage.setItem("dsp-idle-network.production-refresh.v1", "classic");
    // Feed the legacy compatibility ingress once. The app migrates this value
    // into its authoritative local save store; re-seeding during page.reload()
    // would correctly look like a second writer and trigger conflict recovery.
    if (window.sessionStorage.getItem(fixtureSessionKey) !== "1") {
      window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
      window.sessionStorage.setItem(fixtureSessionKey, "1");
    }
    if (extreme) {
      window.localStorage.setItem("dsp-idle-network.endgame-extreme.v1", "true");
      window.localStorage.setItem("dsp-idle-network.ui.canvas-detail.v1", "minimal");
    }
  }, { fontScale: options.fontScale ?? 1, extreme: options.extreme ?? false, releaseNoteId: RELEASE_NOTE_ID, fixtureSessionKey: VISUAL_FIXTURE_SESSION_KEY });
}

async function openFactory(page: Page) {
  await page.goto("/");
  const releaseNotes = page.locator(".release-notes-backdrop");
  if (await releaseNotes.isVisible().catch(() => false)) await releaseNotes.locator(".release-notes-footer button").click();
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  await expect(page.locator(".factory-canvas")).toBeVisible();
  await page.locator(".onboarding-coach").waitFor({ state: "visible", timeout: 1_000 }).catch(() => undefined);
  if (await onboarding.isVisible().catch(() => false)) await onboarding.first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
}

function luminance(value: string): number {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  return channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

async function expectLightSurface(locator: Locator, minimum = 205) {
  await expect(locator).toBeVisible();
  expect(luminance(await locator.evaluate((element) => getComputedStyle(element).backgroundColor))).toBeGreaterThan(minimum);
}

async function assertEndgameSettingsGeometry(page: Page) {
  const group = page.locator(".settings-endgame-extreme");
  await expect(group).toBeVisible();
  const geometry = await group.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>(".setting-row")].map((row) => {
      const rowBounds = row.getBoundingClientRect();
      const labelBounds = row.querySelector<HTMLElement>("span")?.getBoundingClientRect();
      return {
        left: rowBounds.left,
        right: rowBounds.right,
        width: rowBounds.width,
        labelWidth: labelBounds?.width ?? 0,
      };
    });
    return {
      width: bounds.width,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      rows,
    };
  });
  expect(geometry.rows.length).toBeGreaterThanOrEqual(9);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  for (const row of geometry.rows) {
    expect(row.width).toBeGreaterThan(geometry.width * 0.9);
    expect(row.labelWidth).toBeGreaterThan(Math.min(110, geometry.width * 0.32));
  }
}

test("large-font settings stay in one readable column across desktop and mobile", async ({ page }) => {
  await seedVisualFactory(page, { fontScale: 2 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".settings-category-overview").getByRole("button", { name: /终局性能/ }).click();

  for (const scale of [80, 100, 125, 150, 200]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.uiFontScale = String(value);
      document.documentElement.style.setProperty("--ui-font-scale", String(value / 100));
    }, scale);
    await assertEndgameSettingsGeometry(page);
  }
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/A1-settings-large-font-after.png", fullPage: true });

  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await assertEndgameSettingsGeometry(page);
    await expect.poll(() => operations.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    if (viewport.width === 1024 && viewport.height === 768) {
      await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/A1-settings-tablet-200-after.png", fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/A2-settings-large-font-after.png", fullPage: true });
});

test("follow-system theme resolves both light and dark without changing save state", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.ui.theme.v1", "system"));
  await seedVisualFactory(page);
  await openFactory(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.ui.theme.v1"))).toBe("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.ui.theme.v1"))).toBe("system");
});

test("explicit light theme persists through menu, re-entry and reload", async ({ page }) => {
  await seedVisualFactory(page);
  await openFactory(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByLabel("界面主题").getByRole("button", { name: "亮色" }).click();
  await operations.locator(".settings-category-overview").getByRole("button", { name: /统计与运行记录/ }).click();
  const runLogSetting = operations.locator(".setting-row").filter({ hasText: "显示运行记录" });
  const runLogToggle = runLogSetting.getByRole("checkbox");
  await expect(runLogSetting).toBeVisible();
  await runLogSetting.click();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.ui.show-run-log.v1"))).toBe("false");
  await page.getByRole("button", { name: "关闭运营中心" }).click();
  await expect(page.locator(".interaction-event-feed")).toHaveCount(0);
  await page.getByTitle("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.ui.theme.v1"))).toBe("light");
  await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.locator(".factory-canvas")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator(".factory-canvas")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".interaction-event-feed")).toHaveCount(0);
  await page.getByLabel("打开设置").click();
  await expect(operations.locator(".operations-settings")).toHaveAttribute("data-settings-category", "statistics");
  await expect(runLogToggle).not.toBeChecked();
});

test("release history supports direct paging and technology wheel stays horizontal", async ({ page }) => {
  await seedVisualFactory(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);

  await page.getByLabel("打开科技树").click();
  const technologyTree = page.locator(".technology-tree");
  const wheelBaseline = await technologyTree.evaluate((element) => {
    element.scrollLeft = 0;
    element.scrollTop = Math.min(24, Math.max(0, element.scrollHeight - element.clientHeight));
    return {
      top: element.scrollTop,
      pageTop: window.scrollY,
      horizontallyScrollable: element.scrollWidth > element.clientWidth,
    };
  });
  expect(wheelBaseline.horizontallyScrollable).toBe(true);
  await technologyTree.dispatchEvent("wheel", { deltaX: 0, deltaY: 180, bubbles: true, cancelable: true });
  await expect.poll(() => technologyTree.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(() => technologyTree.evaluate((element) => element.scrollTop)).toBe(wheelBaseline.top);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(wheelBaseline.pageTop);
  await page.getByLabel("科技树已打开，再次点击返回工厂").click();

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".settings-category-overview").getByRole("button", { name: /教程、版本与其他/ }).click();
  await operations.locator(".settings-release-notes > button").click();
  const releaseDialog = page.locator(".release-notes-dialog");
  await releaseDialog.getByRole("button", { name: "查看历史版本" }).click();
  await expect(releaseDialog.locator(".release-notes-history-list > button")).toHaveCount(3);
  const pageSelect = releaseDialog.getByLabel("跳转页码");
  const oldestPage = await pageSelect.locator("option").last().getAttribute("value");
  expect(oldestPage).not.toBeNull();
  await pageSelect.selectOption(oldestPage!);
  await expect(releaseDialog.locator(".release-notes-history-list")).toContainText("1.0.0");
  await releaseDialog.locator(".release-notes-history-list").getByRole("button", { name: /1\.0\.0/ }).click();
  const releaseHeading = releaseDialog.getByRole("heading", { name: "公开测试版首发" });
  await expect(releaseHeading).toBeVisible();
  expect(luminance(await releaseHeading.evaluate((element) => getComputedStyle(element).color))).toBeLessThan(160);
  await expectLightSurface(releaseDialog.locator(".release-notes-scroll li > i").first(), 205);
  await releaseDialog.getByRole("button", { name: "查看历史版本" }).click();
  await expect(pageSelect).toHaveValue(oldestPage!);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => releaseDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/G1-release-history-pagination-after.png", fullPage: true });
});

test("light theme uses semantic surfaces for settings, saves, factory and inspector", async ({ page }) => {
  await seedVisualFactory(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);

  const achievement = page.locator(".game-notice--achievement");
  await expect(achievement).toBeVisible({ timeout: 5_000 });
  await expectLightSurface(achievement, 210);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B9-achievement-toast-after.png", fullPage: true });
  await expectLightSurface(page.locator(".interaction-event-feed"), 210);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B10-run-log-after.png", fullPage: true });

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".settings-category-overview").getByRole("button", { name: /教程、版本与其他/ }).click();
  for (const surface of await operations.locator(".settings-release-notes > button, .settings-tutorial-entry > button, .settings-community > div").all()) await expectLightSurface(surface, 205);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B1-settings-cards-after.png", fullPage: true });
  await operations.locator(".settings-category-tabs").getByRole("button", { name: "统计与运行记录" }).click();
  await expectLightSurface(operations.locator(".settings-diagnostics > button"), 205);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B1-settings-diagnostics-after.png", fullPage: true });

  await operations.getByRole("tab", { name: "存档" }).click();
  for (const action of await operations.locator(".save-primary-actions button").all()) await expectLightSurface(action, 205);
  await expectLightSurface(operations.locator(".save-slot").first(), 205);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B2-save-management-after.png", fullPage: true });
  await page.getByRole("button", { name: "关闭运营中心" }).click();

  await expectLightSurface(page.locator(".campaign-summary-block"), 205);
  await expectLightSurface(page.locator(".campaign-summary-command"), 205);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B4-current-task-after.png", fullPage: true });
  await expectLightSurface(page.locator(".planet-navigator > button.locked").first(), 195);
  await expectLightSurface(page.locator(".sidebar-edge-toggle--left"), 205);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B5-planet-switcher-after.png", fullPage: true });

  const hammers = page.locator(".construction-item-craft");
  expect(await hammers.count()).toBeGreaterThan(0);
  for (const hammer of await hammers.all()) await expectLightSurface(hammer, 190);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B6-construction-hammers-after.png", fullPage: true });

  await page.getByTitle("部署风力涡轮机", { exact: true }).click();
  const paneBounds = await page.locator(".react-flow__pane").boundingBox();
  expect(paneBounds).not.toBeNull();
  await page.keyboard.down("Control");
  await page.mouse.move(paneBounds!.x + paneBounds!.width * 0.72, paneBounds!.y + paneBounds!.height * 0.3);
  await expectLightSurface(page.locator(".building-placement-cursor"), 205);
  await expectLightSurface(page.locator(".continuous-placement-indicator"), 205);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B13-construction-overlays-after.png", fullPage: true });
  await page.keyboard.up("Control");
  await page.keyboard.press("Escape");

  const trayRow = page.locator(".tray-row").first();
  const trayBounds = await trayRow.boundingBox();
  expect(trayBounds).not.toBeNull();
  await page.mouse.move(trayBounds!.x + 2, trayBounds!.y + trayBounds!.height / 2);
  await expect(page.locator(".item-hover-card")).toBeHidden();
  await trayRow.locator(".item-reference--tray").first().hover();
  await expectLightSurface(page.locator(".item-hover-card"), 220);
  await expect(page.locator(".item-hover-card").getByRole("button", { name: /打开.*图鉴/ })).toBeVisible();
  await page.locator(".item-hover-card").hover();
  await page.waitForTimeout(250);
  await expect(page.locator(".item-hover-card")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B3-item-hover-card-after.png", fullPage: true });
  await page.mouse.move(700, 400);

  await page.locator('.react-flow__node[data-id="visual-smelter"]').evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
  });
  const selectedNode = page.locator('.react-flow__node[data-id="visual-smelter"] .factory-node');
  await expect(selectedNode).toHaveClass(/factory-node--selected/);
  const selectedVisuals = await selectedNode.evaluate((element) => {
    const badge = getComputedStyle(element, "::before");
    return { background: getComputedStyle(element).backgroundColor, badgeTop: badge.top, badgeContent: badge.content };
  });
  expect(luminance(selectedVisuals.background)).toBeGreaterThan(185);
  expect(selectedVisuals.badgeTop).toBe("3px");
  expect(selectedVisuals.badgeContent).toContain("已选中");
  await expectLightSurface(selectedNode.locator(".work-cycle"), 205);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B12-selected-node-after.png", fullPage: true });
  const powerNetwork = page.locator(".power-network-control");
  await expectLightSurface(powerNetwork, 205);
  await powerNetwork.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B7-inspector-power-after.png", fullPage: true });
  await expectLightSurface(page.locator(".entity-stack-target-control"), 205);
  await expectLightSurface(page.locator(".danger-command").first(), 205);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B7-B12-B14-inspector-selection-actions-after.png", fullPage: true });
  await expectLightSurface(page.locator(".selection-toolbar"), 205);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B8-selection-action-bar-after.png", fullPage: true });

  await page.locator('.react-flow__edge[data-id="visual-belt"]').evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const routing = page.locator(".belt-routing-controls");
  await expect(routing).toBeVisible();
  await routing.scrollIntoViewIfNeeded();
  await expectLightSurface(page.locator(".belt-network-diagnostic"), 205);
  const activeOption = routing.locator(".segmented-control button.active").first();
  const inactiveOption = routing.locator(".segmented-control button:not(.active)").first();
  await expectLightSurface(activeOption, 205);
  expect(await activeOption.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(await inactiveOption.evaluate((element) => getComputedStyle(element).backgroundColor));
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B15-segmented-selection-after.png", fullPage: true });

  await page.locator(".tray-row").first().click();
  await expectLightSurface(page.locator(".cargo-slot--loaded"), 205);
  await expectLightSurface(page.locator(".cargo-cursor"), 205);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/B11-carried-cargo-tray-after.png", fullPage: true });
});

test("extreme LOD compact labels and side panels preserve selection", async ({ page }) => {
  await seedVisualFactory(page, { extreme: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  const compactSmelter = page.locator('.react-flow__node[data-id="visual-smelter"] .factory-node-compact');
  await expect(compactSmelter).toBeVisible();
  await expect(compactSmelter).toHaveAttribute("data-node-lod", "compact");
  await expect(compactSmelter).toHaveAttribute("title", "电弧熔炉 ×2");
  await expect(compactSmelter).toHaveAttribute("aria-label", /电弧熔炉/);
  await expect(compactSmelter.locator("strong")).toHaveText("熔炉");
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/E1-endgame-node-title-after.png", fullPage: true });

  await page.locator('.react-flow__node[data-id="visual-smelter"]').evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await page.getByRole("button", { name: "边缘按钮：收起左侧物资面板" }).click();
  await page.getByRole("button", { name: "边缘按钮：收起右侧检查器面板" }).click();
  await expect(page.locator(".game-shell")).toHaveClass(/sidebar-left-collapsed/);
  await expect(page.locator(".game-shell")).toHaveClass(/sidebar-right-collapsed/);
  await expect(page.locator('.react-flow__node[data-id="visual-smelter"] .factory-node')).toHaveClass(/factory-node--selected/);
  await expect.poll(async () => (await page.evaluate(() => JSON.parse(window.localStorage.getItem("dsp-idle-network.sidebar-preferences.v1") ?? "{}"))).left).toBe(true);
  await page.screenshot({ path: "artifacts/qa/ui-2026-08-04/F1-side-panels-collapsed-after.png", fullPage: true });

  await page.getByRole("button", { name: "边缘按钮：展开左侧物资面板" }).click();
  await page.getByRole("button", { name: "边缘按钮：展开右侧检查器面板" }).click();
  await expect(page.locator(".inspector-panel")).toContainText("熔炉");
  await expect(page.locator('.react-flow__node[data-id="visual-smelter"] .factory-node')).toHaveClass(/factory-node--selected/);
});

