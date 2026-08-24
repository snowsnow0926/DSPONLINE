import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-24-v1.1.7";

function uiReviewFixture() {
  return ({ releaseNoteId, fontScale }: { releaseNoteId: string; fontScale: number }) => {
    const entityBase = {
      planetId: "home",
      minerCount: 0,
      routingCursor: 0,
      progress: 0.35,
      utilization: 1,
      productionRate: 60,
      inputs: {},
      outputs: {},
    };
    const blueprint = {
      id: "v142-blueprint",
      name: "高字号铁板生产单元",
      revision: 1,
      rotation: 0,
      mirror: "none",
      entities: [{ key: "smelter", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1, recipeId: "iron_ingot" }],
      belts: [],
    };
    const state = {
      version: 46,
      nextId: 50,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "v142-vein", kind: "vein", position: { x: -420, y: -100 }, resourceId: "iron_ore", minerCount: 1, resourceRemaining: 48_000, resourceCapacity: 50_000, outputs: { iron_ore: 80 } },
        { ...entityBase, id: "v142-smelter", kind: "machine", position: { x: -40, y: -100 }, buildingId: "arc_smelter", recipeId: "iron_ingot", machineCount: 2, inputs: { iron_ore: 30 }, outputs: { iron_ingot: 12 } },
        { ...entityBase, id: "v142-storage", kind: "storage", position: { x: 320, y: -100 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", machineCount: 1, inputs: { iron_ingot: 20 }, outputs: { iron_ingot: 60 } },
        { ...entityBase, id: "v142-center", kind: "machine", position: { x: -80, y: 260 }, buildingId: "construction_center", machineCount: 1 },
      ],
      belts: [{ id: "v142-belt", planetId: "home", source: "v142-vein", target: "v142-smelter", itemId: "iron_ore", lanes: 2, tier: 1, sorterTier: 1, progress: .25, priority: 1, stackSize: 1, totalTransferred: 120, lastFlow: 12, congestion: .1 }],
      construction: { arc_smelter: 10, storage_mk1: 4, conveyor_belt_mk1: 100 },
      constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, destroyedByproducts: {}, jobs: {} },
      tray: { iron_ore: 3_000, iron_ingot: 1_000 },
      planetTrays: { home: { iron_ore: 3_000, iron_ingot: 1_000 } },
      planetTrayItemLimits: { home: 100_000_000 },
      portableFleet: { logistics_drone: 0, logistics_vessel: 0 },
      totalProduced: { iron_ingot: 25_000 },
      productionHistory: [],
      blueprints: [blueprint],
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"], surveyProgressBySystem: { helios: 1 }, missions: [] },
      research: {
        selectedTechId: null,
        pausedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["electromagnetism", "basic_smelting", "basic_assembling", "basic_logistics", "construction_automation", "dyson_sphere_program", "dyson_swarm", "dyson_shell"],
      },
      settings: { theme: "dark", fontScale, simulationSpeed: 1, autosaveIntervalSeconds: 120, resourceMode: "finite" },
      paused: true,
    };
    sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  };
}

async function openFactory(page: Page, path = "/", fontScale = 1) {
  await page.addInitScript(uiReviewFixture(), { releaseNoteId: RELEASE_NOTE_ID, fontScale });
  await page.goto(path);
  await expect(page.locator(".game-shell")).toBeVisible();
  await expect(page.locator(".factory-canvas")).toBeVisible();
}

async function runCommand(page: Page, query: string, option: RegExp) {
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "搜索命令" }).fill(query);
  await palette.getByRole("option", { name: option }).first().click();
  await expect(palette).toHaveCount(0);
}

async function expectShellClearance(page: Page, workspace: Locator, label: string) {
  const geometry = await workspace.evaluate((surface) => {
    const shell = document.querySelector<HTMLElement>(".game-shell")!;
    const header = shell.querySelector<HTMLElement>(".game-header")!;
    const dock = shell.querySelector<HTMLElement>(".construction-dock")!;
    const rect = surface.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const intersection = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return {
      headerOverlap: intersection(rect, headerRect),
      dockOverlap: intersection(rect, dockRect),
      topDelta: rect.top - headerRect.bottom,
      bottomDelta: dockRect.top - rect.bottom,
      shellWidth: shell.getBoundingClientRect().width,
      surfaceWidth: rect.width,
      surfaceHeight: rect.height,
    };
  });
  expect(geometry.headerOverlap, `${label} 与顶栏重叠`).toBe(0);
  expect(geometry.dockOverlap, `${label} 与施工托盘重叠`).toBe(0);
  expect(geometry.topDelta, `${label} 顶部安全区`).toBeGreaterThanOrEqual(-1);
  expect(geometry.bottomDelta, `${label} 底部安全区`).toBeGreaterThanOrEqual(-1);
  expect(geometry.surfaceWidth, `${label} 宽度`).toBeLessThanOrEqual(geometry.shellWidth + 1);
  expect(geometry.surfaceHeight, `${label} 高度`).toBeGreaterThan(80);
}

async function expectNoInteractiveOverlap(scope: Locator, label: string) {
  const overlaps = await scope.locator("button:not([disabled]), input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [role='tab']").evaluateAll((elements) => {
    const visible = elements.flatMap((element, index) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || rect.width < 1 || rect.height < 1
        ? []
        : [{ element, index, rect }];
    });
    const results: Array<{ first: string; second: string; area: number }> = [];
    for (let leftIndex = 0; leftIndex < visible.length; leftIndex += 1) {
      const left = visible[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < visible.length; rightIndex += 1) {
        const right = visible[rightIndex];
        if (left.element.contains(right.element) || right.element.contains(left.element)) continue;
        const width = Math.max(0, Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left));
        const height = Math.max(0, Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top));
        const area = width * height;
        if (area <= 1) continue;
        const describe = (candidate: typeof left) => candidate.element.getAttribute("aria-label")
          ?? candidate.element.getAttribute("title")
          ?? candidate.element.textContent?.trim().slice(0, 48)
          ?? `${candidate.element.tagName.toLowerCase()}#${candidate.index}`;
        results.push({ first: describe(left), second: describe(right), area });
      }
    }
    return results;
  });
  expect(overlaps, `${label} 存在可操作控件遮挡`).toEqual([]);
}

async function expectNoBlockingAxe(page: Page, selector: string, label: string) {
  const surface = page.locator(selector).first();
  await expect(surface).toBeVisible();
  // Axe should inspect the settled workspace. The 170 ms entry fade blends all
  // foreground colors with the canvas while it is in progress and otherwise
  // reports transient contrast values that players never have to read.
  await expect(surface).toHaveCSS("opacity", "1");
  const axe = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(blocking.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.slice(0, 12).map((node) => ({ target: node.target, html: node.html, summary: node.failureSummary })),
  })), label).toEqual([]);
}

async function composeText(input: Locator, value: string) {
  await input.focus();
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.evaluate((element, nextValue) => {
    const inputElement = element as HTMLInputElement | HTMLTextAreaElement;
    const prototype = inputElement instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(inputElement, nextValue);
    inputElement.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertCompositionText", isComposing: true }));
  }, value);
}

async function finishComposition(input: Locator, value: string) {
  await input.evaluate((element, nextValue) => {
    const inputElement = element as HTMLInputElement | HTMLTextAreaElement;
    inputElement.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: nextValue }));
  }, value);
}

function parseColor(value: string): [number, number, number, number] {
  const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
}

function linearChannel(channel: number) {
  const normalized = channel / 255;
  return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
}

function relativeLuminance(color: [number, number, number, number]) {
  return .2126 * linearChannel(color[0]) + .7152 * linearChannel(color[1]) + .0722 * linearChannel(color[2]);
}

function contrastRatio(foreground: [number, number, number, number], background: [number, number, number, number]) {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + .05) / (dark + .05);
}

test("all desktop workspaces use dynamic header and dock safe areas at every font scale", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  const workspaces = [
    ["主线任务", /打开主线任务/, ".campaign-workspace"],
    ["生产资料库", /打开生产资料库/, ".recipe-workspace"],
    ["科技树", /打开科技树/, ".technology-workspace"],
    ["蓝图库", /打开蓝图库/, ".blueprint-workspace"],
    ["星图", /打开星图与星际工业/, ".star-map-workspace"],
    ["生产统计", /打开生产统计/, ".statistics-workspace"],
    ["运营中心", /打开运营中心/, ".operations-workspace"],
    ["银河网络", /打开银河网络/, ".galaxy-workspace"],
    ["戴森规划", /打开戴森规划/, ".dyson-planner-workspace"],
  ] as const;

  for (const scale of [80, 100, 125, 150, 200]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.uiFontScale = String(value);
      document.documentElement.style.setProperty("--ui-font-scale", String(value / 100));
    }, scale);
    for (const [label, command, selector] of workspaces) {
      await runCommand(page, label, command);
      const workspace = page.locator(selector);
      await expect(workspace).toBeVisible();
      await expectShellClearance(page, workspace, `${label} ${scale}%`);
      await page.keyboard.press("Escape");
      await expect(workspace).toHaveCount(0);
    }
    await page.getByLabel("打开建筑制造中心").click();
    const center = page.locator(".construction-center-workspace");
    await expect(center).toBeVisible();
    await expectShellClearance(page, center, `建筑制造中心 ${scale}%`);
    await page.keyboard.press("Escape");
  }

  for (const viewport of [{ width: 960, height: 540 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await runCommand(page, "生产统计", /打开生产统计/);
    await expectShellClearance(page, page.locator(".statistics-workspace"), `生产统计 ${viewport.width}x${viewport.height}`);
    await page.keyboard.press("Escape");
  }
});

test("workspace modal semantics inert the factory, retain nested portals and restore focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  const trigger = page.getByLabel("打开生产资料库");
  await trigger.focus();
  await trigger.click();
  const workspace = page.getByRole("dialog", { name: "生产资料库" });
  await expect(workspace).toBeVisible();
  await expect(page.locator(".game-workspace")).toHaveAttribute("inert", "");
  await expect(page.locator(".game-workspace")).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => workspace.evaluate((surface) => surface.contains(document.activeElement))).toBe(true);

  const item = workspace.locator(".item-reference").first();
  await item.hover();
  const hover = page.locator(".item-hover-card");
  await expect(hover).toBeVisible();
  const portalButton = hover.getByRole("button").first();
  if (await portalButton.count()) {
    await portalButton.focus();
    await expect(portalButton).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveCount(0);
  await expect(page.locator(".game-workspace")).not.toHaveAttribute("inert", "");
  await expect(trigger).toBeFocused();
});

test("statistics uses one explicit trend command and has no serious axe violations", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  await page.getByLabel("打开生产统计").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await statistics.getByRole("tab", { name: "生产" }).click();
  await expect(statistics.locator(".statistics-row").first()).toBeVisible();
  await expect(statistics.locator(".statistics-row[role='button']")).toHaveCount(0);
  const firstRow = statistics.locator(".statistics-row").first();
  await expect(firstRow.locator(".statistics-trend-command")).toHaveCount(1);
  await firstRow.locator(".statistics-trend-command").focus();
  await expect(firstRow.locator(".statistics-trend-command")).toBeFocused();
  const axe = await new AxeBuilder({ page }).include(".statistics-workspace").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(blocking.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }))).toEqual([]);
});

test("semantic text colors meet 4.5 to 1 in light and dark themes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((nextTheme) => {
      localStorage.setItem("dsp-idle-network.ui.theme.v1", nextTheme);
      window.dispatchEvent(new StorageEvent("storage", { key: "dsp-idle-network.ui.theme.v1", newValue: nextTheme }));
    }, theme);
    if (await page.locator("html").getAttribute("data-theme") !== theme) {
      await page.getByLabel("打开设置").click();
      const settings = page.getByRole("dialog", { name: "运营中心" });
      await settings.locator(".settings-category-overview").getByRole("button", { name: /画面与主题/ }).click();
      await settings.getByLabel("界面主题").getByRole("button", { name: theme === "light" ? "亮色" : "深色" }).click();
      await page.keyboard.press("Escape");
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const vein = page.locator(".vein-reserve").first();
    await expect(vein).toBeVisible();
    const samples = [vein];
    await page.getByLabel("打开生产统计").click();
    const statistics = page.getByRole("dialog", { name: "生产统计" });
    await statistics.getByRole("tab", { name: "生产" }).click();
    samples.push(statistics.locator(".statistics-sample-status"), statistics.locator(".statistics-title span").first(), statistics.locator(".rate-positive").first());
    for (const sample of samples) {
      await expect(sample).toBeVisible();
      const colors = await sample.evaluate((element) => {
        const foreground = getComputedStyle(element).color;
        let current: Element | null = element;
        let background = "rgba(0, 0, 0, 0)";
        while (current) {
          const candidate = getComputedStyle(current).backgroundColor;
          if (!candidate.endsWith(", 0)") && candidate !== "rgba(0, 0, 0, 0)" && candidate !== "transparent") {
            background = candidate;
            break;
          }
          current = current.parentElement;
        }
        return { foreground, background };
      });
      const ratio = contrastRatio(parseColor(colors.foreground), parseColor(colors.background));
      expect(ratio, `${theme}: ${await sample.evaluate((element) => element.className)} ${colors.foreground} / ${colors.background}`).toBeGreaterThanOrEqual(4.5);
    }
    await page.keyboard.press("Escape");
  }
});

test("axe passes representative dark, light, 200 percent and mobile workspaces", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((nextTheme) => {
      document.documentElement.dataset.theme = nextTheme;
      document.documentElement.style.colorScheme = nextTheme;
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await runCommand(page, "生产资料库", /打开生产资料库/);
    await expect(page.locator(".recipe-workspace")).toBeVisible();
    await expectNoBlockingAxe(page, ".recipe-workspace", `${theme} 资料库 Axe`);
    await page.keyboard.press("Escape");
    await expect(page.locator(".recipe-workspace")).toBeHidden();
  }

  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await page.getByLabel("打开生产统计").click();
  await expectNoBlockingAxe(page, ".statistics-workspace", "200% 统计 Axe");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?mobileUi=next");
  await expect(page.locator(".game-shell[data-mobile-shell='true']")).toBeVisible();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /生产资料库/ }).click();
  await expectNoBlockingAxe(page, ".mobile-recipe", "移动资料库 Axe");
});

test("200 percent mobile layouts keep full labels, 44px targets and scrollable action bars", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page, "/?mobileUi=next", 2);

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /生产统计/ }).click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await statistics.getByRole("tab", { name: "生产" }).click();
  const windows = statistics.locator(".statistics-window-control button");
  await expect(windows).toHaveText(["过去 1 分钟", "过去 10 分钟", "过去 1 小时", "累计总产量"]);
  for (const button of await windows.all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /生产资料库/ }).click();
  const library = page.getByRole("dialog", { name: "生产资料库" });
  const categories = library.locator(".codex-section-nav");
  await expect(categories).toBeVisible();
  expect(await categories.evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(true);
  for (const button of await categories.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await library.getByRole("button", { name: "天然资源", exact: true }).click();
  await library.locator(".recipe-index button").first().click();
  const planetLabels = library.locator(".recipe-source-planets > span");
  await expect(planetLabels.first()).toBeVisible();
  for (const label of await planetLabels.all()) {
    expect(await label.evaluate((element) => getComputedStyle(element).whiteSpace === "nowrap" && element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回生产资料库列表/ }).click();
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /蓝图库/ }).click();
  const blueprints = page.getByRole("dialog", { name: "蓝图与待建施工" });
  await blueprints.locator(".mobile-blueprint-open").first().click();
  for (const button of await blueprints.locator(".blueprint-card > footer button").all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回蓝图库列表/ }).click();
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();

  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /戴森规划/ }).click();
  const planner = page.getByRole("dialog", { name: "戴森球规划" });
  const summary = planner.locator(".dyson-stage-summary");
  await expect(summary).toBeVisible();
  for (const label of await summary.locator("span").all()) {
    expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && getComputedStyle(element).whiteSpace === "nowrap")).toBe(true);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});

test("high-scale controls do not geometrically overlap in representative workspaces", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 960, height: 540 });
  await openFactory(page, "/", 2);
  await runCommand(page, "生产统计", /打开生产统计/);
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await statistics.getByRole("tab", { name: "生产" }).click();
  await expectNoInteractiveOverlap(statistics.locator(".statistics-toolbar"), "统计工具栏");
  await page.keyboard.press("Escape");

  await runCommand(page, "生产资料库", /打开生产资料库/);
  const recipe = page.getByRole("dialog", { name: "生产资料库" });
  await expectNoInteractiveOverlap(recipe.locator(".recipe-toolbar"), "资料库工具栏");
  await expectNoInteractiveOverlap(recipe.locator(".codex-section-nav"), "资料库分类栏");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?mobileUi=next");
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /蓝图库/ }).click();
  const blueprints = page.getByRole("dialog", { name: "蓝图与待建施工" });
  await blueprints.locator(".mobile-blueprint-open").first().click();
  await expectNoInteractiveOverlap(blueprints.locator(".blueprint-card > footer"), "手机蓝图操作栏");
});

test("real text fields preserve Chinese composition through responsive events and isolate passwords", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page, "/?mobileUi=next");

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /蓝图库/ }).click();
  const blueprints = page.getByRole("dialog", { name: "蓝图与待建施工" });
  await blueprints.locator(".mobile-blueprint-open").first().click();
  let blueprintName = blueprints.getByLabel(/高字号铁板生产单元名称/);
  await composeText(blueprintName, "量子物流蓝图");
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => {
    window.dispatchEvent(new Event("orientationchange"));
    window.dispatchEvent(new Event("resize"));
    window.visualViewport?.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  await expect(blueprintName).toHaveValue("量子物流蓝图");
  blueprintName = blueprints.locator(".blueprint-card input").first();
  await finishComposition(blueprintName, "量子物流蓝图");
  await expect(blueprintName).toHaveValue("量子物流蓝图");
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回蓝图库列表/ }).click();
  await blueprints.locator(".mobile-blueprint-open").first().click();
  await expect(blueprints.getByLabel(/量子物流蓝图名称/)).toHaveValue("量子物流蓝图");
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回蓝图库列表/ }).click();
  await page.locator(".mobile-next-topbar").getByRole("button", { name: /返回工厂/ }).click();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?mobileUi=legacy");
  await expect(page.locator(".game-header")).toBeVisible();
  await page.getByLabel("打开生产统计").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await statistics.getByRole("tab", { name: "网络", exact: true }).click();
  const bookmarkName = statistics.getByLabel("画布书签名称");
  await composeText(bookmarkName, "母星物流视角");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  await expect(bookmarkName).toHaveValue("母星物流视角");
  await finishComposition(bookmarkName, "母星物流视角");
  await expect(bookmarkName).toHaveValue("母星物流视角");
  await page.keyboard.press("Escape");

  await page.goto("/?menu=1");
  const password = page.locator('input[type="password"]').first();
  if (await password.count()) {
    await password.fill("never-share-this-password");
    expect(await page.evaluate(() => ({
      local: Object.values(localStorage).some((value) => value.includes("never-share-this-password")),
      session: Object.values(sessionStorage).some((value) => value.includes("never-share-this-password")),
    }))).toEqual({ local: false, session: false });
  }
});

test("release notes preserve close and acknowledge actions at 360 by 480 and 200 percent", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 });
  await page.addInitScript(() => {
    localStorage.removeItem("dsp-idle-network.release-notes.seen.v1");
    localStorage.setItem("dsp-idle-network.ui.font-scale.v1", "2");
  });
  await page.goto("/?menu=1");
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  const dialog = page.locator(".release-notes-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-label", "云存档合同修复与 Mod 建筑托盘");
  await expect(dialog.locator(".release-notes-version strong")).toHaveText("1.1.7");
  await expect(dialog.locator(".release-notes-scroll li")).toHaveCount(6);
  await expect(dialog).toContainText("空间站合同 ID 冲突可自愈");
  await expect(dialog).toContainText("云端校验保留兼容边界");
  await expect(dialog).toContainText("自定义建筑进入部署托盘");
  await expect(dialog).toContainText("Mod 扩展边界保持可验证");
  await expect(dialog).toContainText("旧存档与 1.1.6 可继续读取");
  const close = dialog.getByRole("button", { name: /关闭/ }).first();
  const acknowledge = dialog.getByRole("button", { name: /我知道了|开始/ }).last();
  for (const action of [close, acknowledge]) {
    await expect(action).toBeVisible();
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  const body = dialog.locator(".release-notes-scroll");
  const bodyBox = await body.boundingBox();
  expect(bodyBox).not.toBeNull();
  expect(bodyBox!.height).toBeGreaterThan(80);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("coarse-pointer primary targets and the construction-center canvas node remain operable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page, "/?mobileUi=next", 2);
  await page.getByRole("button", { name: "打开画布工具" }).click();
  await page.getByRole("dialog", { name: "画布工具" }).getByRole("button", { name: "定位全部" }).click();

  const node = page.locator('.react-flow__node[data-id="v142-center"]');
  await expect(node).toBeVisible();
  expect(await page.locator(".game-shell").evaluate((shell) => ({
    mobile: shell.getAttribute("data-mobile-shell"),
    fontScale: getComputedStyle(document.documentElement).getPropertyValue("--ui-font-scale"),
  }))).toEqual({ mobile: "true", fontScale: "2" });
  expect(await node.locator(".factory-node").getAttribute("data-node-lod")).toBeNull();
  const nodeBox = await node.boundingBox();
  expect(nodeBox).not.toBeNull();
  expect(nodeBox!.width).toBeGreaterThanOrEqual(160);
  expect(nodeBox!.height).toBeGreaterThanOrEqual(94);
  await node.click();
  await expect(page.locator('.game-shell[data-mobile-overlay="inspector"]')).toBeVisible();
  await page.locator(".mobile-next-sheet").getByRole("button", { name: /^关闭/ }).click();

  await page.reload();
  await expect(page.locator(".game-shell")).toBeVisible();
  await expect(page.locator(".factory-canvas")).toBeVisible();
  await page.locator('.react-flow__node[data-id="v142-vein"]').click();
  const miningTarget = page.locator(".mobile-inspector-peek-open");
  await expect(miningTarget).toBeVisible();
  const miningTargetBox = await miningTarget.boundingBox();
  expect(miningTargetBox).not.toBeNull();
  expect(miningTargetBox!.width, "移动端矿脉操作入口 width").toBeGreaterThanOrEqual(44);
  expect(miningTargetBox!.height, "移动端矿脉操作入口 height").toBeGreaterThanOrEqual(44);
  await page.locator(".mobile-next-sheet").getByRole("button", { name: /^关闭/ }).click();

  const targets = await page.locator([
    ".mobile-next-topbar button",
    ".mobile-next-bottom-nav button",
    ".mobile-next-tools-command",
    ".sidebar-edge-toggle--left",
    ".sidebar-edge-toggle--right",
    ".tray-management-trigger",
  ].join(",")).evaluateAll((elements) => elements.filter((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }).map((element) => {
    const rect = element.getBoundingClientRect();
    return { label: element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent?.trim(), width: rect.width, height: rect.height };
  }));
  expect(targets.length).toBeGreaterThanOrEqual(8);
  for (const target of targets) {
    expect(target.width, `${target.label} width`).toBeGreaterThanOrEqual(44);
    expect(target.height, `${target.label} height`).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: /生产资料库/ }).click();
  const search = page.getByRole("dialog", { name: "生产资料库" }).getByRole("textbox", { name: /搜索/ }).first();
  const searchBox = await search.locator("xpath=..").boundingBox();
  expect(searchBox).not.toBeNull();
  expect(searchBox!.height).toBeGreaterThanOrEqual(44);
});
