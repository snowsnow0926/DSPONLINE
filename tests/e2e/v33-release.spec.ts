import { expect, test, type Page } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

const REFRESH_PREFERENCE_KEY = "dsp-idle-network.production-refresh.v1";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
  });
});

async function dismissOnboarding(page: Page) {
  const control = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await control.count()) await control.first().click();
}

async function openDesktopSettings(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await dismissOnboarding(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await expect(operations).toBeVisible();
  await operations.getByRole("tab", { name: "设置" }).click();
  return operations;
}

test("native application settings expose the desktop update lifecycle", async ({ page }) => {
  await page.addInitScript(() => {
    let update = { state: "idle", message: "尚未检查", channel: "stable" };
    const listeners = new Set<(status: typeof update) => void>();
    (window as typeof window & { dspDesktop: unknown }).dspDesktop = {
      isDesktop: true,
      setFontScale: async (scale: number) => ({ scale, zoomFactor: scale }),
      getReleaseInfo: async () => ({ isDesktop: true, platform: "win32", channel: "stable", channelLabel: "稳定版", version: "1.0.0", update }),
      requestApi: async () => ({ ok: true, status: 200, body: "{}", headers: { "content-type": "application/json" } }),
      checkForUpdates: async () => {
        update = { state: "available", message: "发现版本 1.0.1", channel: "stable" };
        listeners.forEach((listener) => listener(update));
        return update;
      },
      downloadUpdate: async () => {
        update = { state: "downloaded", message: "更新已下载，重启后安装", channel: "stable" };
        listeners.forEach((listener) => listener(update));
        return update;
      },
      installUpdate: async () => {
        (window as typeof window & { __nativeInstallAccepted?: boolean }).__nativeInstallAccepted = true;
        return { accepted: true };
      },
      onUpdateStatus: (listener: (status: typeof update) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "游戏设置" }).click();
  const menuRelease = page.locator(".start-menu-native-update");
  await expect(menuRelease).toContainText("桌面应用 · 稳定版 · v1.0.0");
  await expect(menuRelease.getByRole("button", { name: "检查更新" })).toBeVisible();

  const operations = await openDesktopSettings(page);
  const release = operations.locator(".desktop-release-status");
  await expect(release).toContainText("桌面应用 · 稳定版 · v1.0.0");
  await release.getByRole("button", { name: "检查更新" }).click();
  await expect(release).toContainText("发现版本 1.0.1");
  await release.getByRole("button", { name: "下载更新" }).click();
  await expect(release).toContainText("更新已下载，重启后安装");
  await release.getByRole("button", { name: "重启安装" }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __nativeInstallAccepted?: boolean }).__nativeInstallAccepted)).toBe(true);
});

test("production refresh profiles stay device-local and fixed choices are never overridden", async ({ page }) => {
  const operations = await openDesktopSettings(page);
  await selectSettingsCategory(operations, "终局性能", "performance");
  const shell = page.locator(".game-shell");
  const profiles = operations.getByRole("radiogroup", { name: "生产画面刷新频率" });

  await expect(shell).toHaveAttribute("data-production-refresh", "auto");
  await expect(shell).toHaveAttribute("data-production-refresh-ms", "200");
  for (const [name, id, milliseconds] of [
    ["经典流畅", "classic", "100"],
    ["高流畅", "high", "200"],
    ["均衡", "balanced", "500"],
    ["省电", "power-save", "1000"],
    ["低配置", "low-spec", "1500"],
    ["极限省电", "extreme", "3000"],
  ] as const) {
    await profiles.getByRole("radio", { name: new RegExp(`^${name}`) }).click();
    await expect(shell).toHaveAttribute("data-production-refresh", id);
    await expect(shell).toHaveAttribute("data-production-refresh-ms", milliseconds);
  }

  await profiles.getByRole("radio", { name: /^经典流畅/ }).click();
  await page.waitForTimeout(6_500);
  await expect(shell).toHaveAttribute("data-production-refresh-ms", "100");
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), REFRESH_PREFERENCE_KEY)).toBe("classic");

  await operations.getByRole("tab", { name: "存档" }).click();
  await operations.getByRole("button", { name: "立即保存" }).click();
  const persistedSettings = await page.evaluate(() => JSON.parse(window.localStorage.getItem("dsp-idle-network.save.v1")!).state.settings as Record<string, unknown>);
  expect(persistedSettings).not.toHaveProperty("productionRefreshPreference");
  expect(persistedSettings).not.toHaveProperty("productionRefreshIntervalMs");

  await page.reload();
  await dismissOnboarding(page);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-production-refresh", "classic");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-production-refresh-ms", "100");
});

test("tray management selects filtered-out items and deletes half only after confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await dismissOnboarding(page);
  await page.getByLabel("管理当前行星物资").click();
  const manager = page.getByRole("dialog", { name: "管理当前行星物资托盘" });
  await expect(manager).toBeVisible();

  await manager.getByLabel("搜索托盘物资").fill("铁矿");
  await expect(manager.locator(".tray-management__list > button")).toHaveCount(1);
  await manager.getByRole("button", { name: /全选/ }).click();
  await expect(manager).toContainText("已选择 3 / 全部 3 种");
  await manager.getByRole("button", { name: "删除一半" }).click();

  const confirmation = page.getByRole("alertdialog", { name: "确认删除托盘物资" });
  await expect(confirmation).toContainText("删除 3 种物资");
  await expect(confirmation).toContainText("共 150 件");
  await confirmation.getByRole("button", { name: "确认删除" }).click();
  await manager.getByLabel("搜索托盘物资").fill("");
  await expect(manager.locator(".tray-management__list > button")).toHaveCount(3);
  await expect(manager.locator(".tray-management__list > button small")).toHaveText(["50", "50", "50"]);

  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await expect.poll(() => manager.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const targetSizes = await manager.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  expect(targetSizes.every((height) => height >= 44)).toBe(true);
  await manager.screenshot({ path: "artifacts/qa/v090-tray-management-font-200.png" });
});

test("refresh controls remain usable in classic and next mobile shells at 200 percent font", async ({ page }) => {
  for (const mode of ["legacy", "next"] as const) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mode === "next" ? "/?mobileUi=next" : "/");
    await dismissOnboarding(page);
    if (mode === "next") {
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await page.getByRole("button", { name: /游戏设置/ }).click();
    } else {
      await page.getByRole("button", { name: "更多工作区" }).click();
      await page.getByRole("menuitem", { name: "设置" }).click();
    }
    const operations = page.getByRole("dialog", { name: "运营中心" });
    await operations.getByRole("tab", { name: "设置" }).click();
    await selectSettingsCategory(operations, "画面与主题", "visual");
    await operations.getByLabel("字体大小").getByRole("button", { name: "200%" }).click();
    await selectSettingsCategory(operations, "终局性能", "performance");
    const refresh = operations.getByRole("radiogroup", { name: "生产画面刷新频率" });
    await refresh.scrollIntoViewIfNeeded();
    await expect(refresh.getByRole("radio")).toHaveCount(7);
    const bounds = await refresh.getByRole("radio").evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    expect(bounds.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
    await expect.poll(() => operations.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await operations.screenshot({ path: `artifacts/qa/v090-refresh-${mode}-font-200.png` });
  }
});

test("explicit next mobile shell survives tablet layout and fullscreen resize events without losing search", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/?mobileUi=next");
  await dismissOnboarding(page);
  const shell = page.locator('.game-shell[data-mobile-shell="true"]');
  await expect(shell).toHaveAttribute("data-compact-layout", "desktop");

  await page.getByRole("button", { name: "建造", exact: true }).click();
  const buildSheet = page.getByRole("dialog", { name: "建造" });
  const search = buildSheet.getByLabel("搜索建造项目");
  await search.fill("喷涂");
  await search.focus();
  await search.evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 2));

  for (const viewport of [
    { width: 768, height: 1024, mode: "medium" },
    { width: 844, height: 390, mode: "compact-landscape" },
    { width: 1024, height: 768, mode: "desktop" },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("orientationchange"));
      window.dispatchEvent(new Event("resize"));
      window.visualViewport?.dispatchEvent(new Event("resize"));
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    await expect(shell).toHaveAttribute("data-mobile-shell", "true");
    await expect(shell).toHaveAttribute("data-compact-layout", viewport.mode);
    await expect(search).toHaveValue("喷涂");
    await expect(buildSheet).toBeVisible();
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v090-next-shell-tablet-landscape.png", fullPage: true });
});

test("galactic exporter is deployable and opens the active local construction task", async ({ page }) => {
  const now = Date.now();
  await page.route("**/api/public-status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        timeZone: "Asia/Shanghai",
        today: "2026-07-24",
        uptimeSeconds: 1,
        players: { total: 1, today: 1, online: 1, onlineWindowSeconds: 120 },
        activity: {
          enabled: true,
          status: "active",
          openEnded: true,
          serverNow: now,
          id: "union-station-v091-test",
          revision: "v091-test",
          startsAtMs: now - 4 * 24 * 60 * 60 * 1_000,
          endsAtMs: now - 24 * 60 * 60 * 1_000,
          personalTargets: { universe_matrix: 1_000_000, solar_sail: 1_000_000, small_carrier_rocket: 1_000_000, antimatter_fuel_rod: 1_000_000 },
          globalTargets: { universe_matrix: 1_000_000_000, solar_sail: 1_000_000_000, small_carrier_rocket: 1_000_000_000, antimatter_fuel_rod: 1_000_000_000 },
          globalDelivered: { universe_matrix: 10_000, solar_sail: 20_000, small_carrier_rocket: 30_000, antimatter_fuel_rod: 40_000 },
        },
      }),
    });
  });
  await page.addInitScript(() => {
    const state = {
      version: 31,
      nextId: 10,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: { galactic_material_exporter: 1 },
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["universe_matrix"] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await dismissOnboarding(page);
  const exporterDock = page.locator(".construction-item-shell").filter({ hasText: "超大型物资出口" });
  await expect(exporterDock).toBeVisible();
  await expect(exporterDock.locator(".construction-item")).toContainText("×1");
  await exporterDock.locator(".construction-item").click();
  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 330 } });

  const exporter = page.locator('.react-flow__node').filter({ hasText: "超大型物资出口" });
  await expect(exporter).toBeVisible();
  await exporter.locator(".factory-node__header").click();
  const task = page.getByRole("dialog", { name: "生产统计" });
  await expect(task).toBeVisible();
  await expect(task.getByRole("tab", { name: /银河/ })).toHaveAttribute("aria-selected", "true");
  await expect(task.locator(".galactic-activity")).toContainText("本地已记录");
  await expect(task.locator(".galactic-activity")).toContainText("全服模拟");
  await expect(task.locator(".galactic-activity")).toContainText("10亿");
  await expect(task.locator(".galactic-activity")).toContainText("长期开放");
  await expect(task.getByRole("button", { name: "开始提交任务 1" })).toBeVisible();
  await task.screenshot({ path: "artifacts/qa/v091-galactic-activity-desktop.png" });

  await task.getByRole("button", { name: "开始提交任务 1" }).click();
  await expect(task.getByRole("button", { name: "暂停提交 1" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?mobileUi=next");
  await dismissOnboarding(page);
  await page.getByRole("button", { name: "建造", exact: true }).click();
  const buildSheet = page.getByRole("dialog", { name: "建造" });
  await buildSheet.getByLabel("搜索建造项目").fill("超大型物资出口");
  const mobileExporterCard = buildSheet.locator(".mobile-build-card").filter({ hasText: "超大型物资出口" });
  await expect(mobileExporterCard).toBeVisible();
  await expect.poll(() => buildSheet.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await buildSheet.screenshot({ path: "artifacts/qa/v091-galactic-exporter-mobile.png" });
  await mobileExporterCard.click();
  await expect(buildSheet).toHaveCount(0);
  await page.locator(".react-flow__pane").click({ position: { x: 34, y: 220 } });
  const mobileExporter = page.locator('.react-flow__node').filter({ hasText: "超大型物资出口" });
  await expect(mobileExporter).toBeVisible();
  await mobileExporter.locator(".factory-node__header").click();
  const mobileTask = page.getByRole("dialog", { name: "生产统计" });
  await expect(mobileTask).toContainText("宇宙联合空间站巨构建设任务");
  const activityControls = mobileTask.locator(".galactic-exporter-command button");
  await expect(activityControls).toHaveCount(2);
  expect((await activityControls.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))).every((height) => height >= 44)).toBe(true);
  await expect.poll(() => mobileTask.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await mobileTask.screenshot({ path: "artifacts/qa/v091-galactic-activity-mobile.png" });
});

test("large quantities expose exact values on desktop and mobile without triggering the parent action", async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      version: 31,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: { iron_ore: 1_234_567_890 },
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await dismissOnboarding(page);
  const desktopValue = page.locator(".tray-row").filter({ hasText: "铁矿石" }).locator(".quantity-value");
  await expect(desktopValue.locator(":scope > span").first()).toHaveText("12.3亿");
  await expect(desktopValue).toHaveAttribute("aria-label", "1,234,567,890");
  await desktopValue.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "1,234,567,890" })).toBeVisible();
  await expect(page.locator(".cargo-slot")).toContainText("空载");

  await page.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => query === "(pointer: coarse)"
      ? { matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true } as MediaQueryList
      : nativeMatchMedia(query);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?mobileUi=next");
  await dismissOnboarding(page);
  await page.getByRole("button", { name: "物资", exact: true }).click();
  const mobileValue = page.locator(".mobile-inventory-list > button").filter({ hasText: "铁矿石" }).locator(".quantity-value");
  await expect(mobileValue.locator(":scope > span").first()).toHaveText("12.3亿");
  await mobileValue.click();
  await expect(page.getByRole("tooltip").filter({ hasText: "1,234,567,890" })).toBeVisible();
  await expect(page.locator(".mobile-cargo-slot")).toContainText("当前空载");
});

test("extreme refresh keeps true inventory snapshots while the production bar interpolates smoothly", async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      version: 14,
      nextId: 3,
      activePlanetId: "home",
      entities: [
        {
          id: "refresh_smelter",
          kind: "machine",
          planetId: "home",
          position: { x: 0, y: 0 },
          buildingId: "arc_smelter",
          recipeId: "iron_ingot",
          machineCount: 1,
          minerCount: 0,
          inputs: { iron_ore: 100 },
          outputs: {},
          progress: 0.25,
          routingCursor: 0,
          utilization: 1,
          productionRate: 60,
        },
        {
          id: "refresh_wind",
          kind: "power",
          planetId: "home",
          position: { x: -320, y: 0 },
          buildingId: "wind_turbine",
          machineCount: 1,
          minerCount: 0,
          inputs: {},
          outputs: {},
          progress: 0,
          routingCursor: 0,
          utilization: 1,
          productionRate: 0,
        },
      ],
      belts: [],
      construction: {},
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      blueprints: [],
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
    window.localStorage.setItem("dsp-idle-network.production-refresh.v1", "extreme");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await dismissOnboarding(page);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-production-refresh-ms", "3000");
  const node = page.locator('.react-flow__node[data-id="refresh_smelter"]');
  const cycle = node.locator(".work-cycle--interpolated");
  const progress = cycle.locator(":scope > i");
  await expect(progress).toHaveCSS("animation-name", "none");
  const inputValue = node.locator(".node-io__column").filter({ hasText: "输入" }).locator(".item-badge strong");
  const beforeInventory = await inputValue.textContent();
  const readProgress = () => cycle.evaluate((element) => {
    const aria = Number(element.getAttribute("aria-valuenow"));
    const text = Number(element.querySelector("strong")?.textContent?.match(/\d+/)?.[0] ?? Number.NaN);
    const transform = (element.querySelector("i") as HTMLElement | null)?.style.transform ?? "scaleX(0)";
    return { aria, text, fill: Number(transform.match(/scaleX\(([^)]+)\)/)?.[1] ?? 0) * 100 };
  });
  const beforeProgress = await readProgress();
  await page.waitForTimeout(350);
  const afterProgress = await readProgress();
  await expect(inputValue).toHaveText(beforeInventory ?? "");
  expect(afterProgress.text).toBe(afterProgress.aria);
  expect(Math.abs(afterProgress.fill - afterProgress.aria)).toBeLessThanOrEqual(1.1);
  expect(afterProgress.aria).not.toBe(beforeProgress.aria);
  await node.locator(".factory-node__header").click();
  await expect(node).toHaveClass(/selected/);
  await expect.poll(async () => inputValue.textContent(), { timeout: 2_500 }).not.toBe(beforeInventory);
});

test("Dyson layer copy and paste uses UI clipboard without copying construction progress", async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      version: 14,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {}, frost: {}, boreal_giant: {}, magnetar: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["dyson_sphere_program", "dyson_shell", "dyson_swarm"] },
      exploration: { unlockedSystemIds: ["helios", "borealis"] },
      blueprints: [],
      dysonSwarm: { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0, receiverLoadKw: 0 },
      dysonSphere: { structurePoints: 32, totalRocketsLaunched: 32, shellSails: 0, totalSailsAbsorbed: 0, absorptionProgress: 0, generationKw: 30_720 },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await dismissOnboarding(page);
  await page.getByTitle("打开戴森球规划").click();
  const planner = page.getByRole("dialog", { name: "戴森球规划" });
  await planner.getByTitle("新建八节点闭合标准壳层").click();
  const sourceInspector = planner.locator(".dyson-layer-inspector");
  await sourceInspector.locator(":scope > .dyson-orbit-control").filter({ hasText: "轨道半径" }).locator("input").fill("20000");
  await planner.getByRole("button", { name: "复制当前壳层设计", exact: true }).click();

  await planner.getByTitle("规划北冕座戴森球").click();
  await planner.getByRole("button", { name: "粘贴壳层副本", exact: true }).click();
  await expect(planner.locator(".dyson-layer-list > button")).toHaveCount(1);
  await expect(planner.locator(".dyson-layer-inspector > header")).toContainText("副本");
  await expect(planner.locator(".dyson-layer-inspector > .dyson-orbit-control").filter({ hasText: "轨道半径" })).toContainText("20,000 m");
  const pastedProgress = planner.locator(".dyson-stage-summary").locator("span").filter({ hasText: "施工" }).locator(".quantity-value");
  await expect(pastedProgress).toHaveCount(2);
  await expect(pastedProgress.nth(0)).toHaveAttribute("aria-label", "0");
  await expect(pastedProgress.nth(1)).toHaveAttribute("aria-label", "24");
  await page.screenshot({ path: "artifacts/qa/v090-dyson-layer-copy.png", fullPage: true });
});
