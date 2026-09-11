import { expect, test, type Page } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";

async function seedReleaseFactory(page: Page, options: { theme?: "dark" | "light"; locale?: "zh-CN" | "en"; paused?: boolean; mobileUi?: "legacy" | "next" } = {}) {
  await page.addInitScript(({ releaseNoteId, theme, locale, paused, mobileUi }) => {
    // Keep this development fixture on the freshly built bundle instead of a
    // service-worker cache from an earlier focused run.
    void globalThis.caches?.keys().then((keys) => Promise.all(keys.map((key) => globalThis.caches!.delete(key))));
    void navigator.serviceWorker?.getRegistrations().then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())));
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
      version: 35,
      nextId: 20,
      activePlanetId: "home",
      entities: [
        {
          ...entityBase,
          id: "vein_iron",
          kind: "vein",
          position: { x: -420, y: -120 },
          resourceId: "iron_ore",
          machineCount: 0,
          minerCount: 1,
          resourceRemaining: 0,
          resourceCapacity: 50_000,
          outputs: { iron_ore: 80 },
        },
        {
          ...entityBase,
          id: "smelter-a",
          kind: "machine",
          position: { x: -100, y: -120 },
          buildingId: "arc_smelter",
          recipeId: "iron_ingot",
          machineCount: 1,
          sprayCoaterInstalled: true,
          proliferatorTier: 1,
          proliferatorMode: "extra",
          proliferatorPoints: 2,
          inputs: { iron_ore: 30, proliferator_mk1: 3 },
        },
        {
          ...entityBase,
          id: "smelter-b",
          kind: "machine",
          position: { x: 180, y: -120 },
          buildingId: "arc_smelter",
          recipeId: "iron_ingot",
          machineCount: 2,
          inputs: { iron_ore: 30 },
        },
        {
          ...entityBase,
          id: "storage",
          kind: "storage",
          position: { x: -260, y: 220 },
          buildingId: "storage_mk1",
          storedItemId: "particle_broadband",
          machineCount: 12,
          inputs: { particle_broadband: 12_345 },
          outputs: { particle_broadband: 98_765 },
        },
        {
          ...entityBase,
          id: "tank",
          kind: "storage",
          position: { x: 130, y: 220 },
          buildingId: "storage_tank",
          storedItemId: "sulfuric_acid",
          machineCount: 12,
          inputs: { sulfuric_acid: 45_678 },
          outputs: { sulfuric_acid: 76_543 },
        },
        {
          ...entityBase,
          id: "wind",
          kind: "power",
          position: { x: 460, y: 200 },
          buildingId: "wind_turbine",
          machineCount: 4,
        },
      ],
      belts: [
        { id: "ore-belt-a", planetId: "home", source: "vein_iron", target: "smelter-a", itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1, lastFlow: 0 },
        { id: "ore-belt-b", planetId: "home", source: "vein_iron", target: "smelter-b", itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1, lastFlow: 0 },
      ],
      construction: { arc_smelter: 2, storage_mk1: 2, storage_tank: 2, spray_coater: 0, conveyor_belt_mk1: 10 },
      tray: {
        iron_ore: 36,
        titanium_ingot: 12,
        sulfuric_acid: 24,
        processor: 10,
        plasma_exciter: 4,
        copper_ore: 200,
        stone: 200,
      },
      planetTrays: {
        home: {
          iron_ore: 36,
          titanium_ingot: 12,
          sulfuric_acid: 24,
          processor: 10,
          plasma_exciter: 4,
          copper_ore: 200,
          stone: 200,
        },
      },
      planetTrayItemLimits: { home: 1_000_000 },
      totalProduced: {},
      research: {
        selectedTechId: null,
        pausedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: [
          "electromagnetism",
          "basic_smelting",
          "high_efficiency_plasma_control",
          "titanium_alloy",
          "interstellar_logistics",
          "proliferator_1",
        ],
      },
      settings: {
        theme,
        fontScale: 1,
        simulationSpeed: 1,
        autosaveIntervalSeconds: 30,
        resourceMode: "finite",
      },
      paused,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.locale.v1", locale);
    window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", mobileUi);
    window.localStorage.setItem("dsp-idle-network.production-refresh.v1", "classic");
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  }, {
    releaseNoteId: RELEASE_NOTE_ID,
    theme: options.theme ?? "dark",
    locale: options.locale ?? "zh-CN",
    paused: options.paused ?? true,
    mobileUi: options.mobileUi ?? "legacy",
  });
}

async function dismissOnboarding(page: Page) {
  const close = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await close.count()) await close.first().click();
}

async function dismissReleaseNotes(page: Page) {
  const backdrop = page.locator(".release-notes-backdrop");
  await backdrop.waitFor({ state: "attached", timeout: 1_500 }).catch(() => undefined);
  if (await backdrop.isVisible().catch(() => false)) await backdrop.locator(".release-notes-footer button").click();
}

async function openGame(page: Page, path = "/") {
  await page.goto(path);
  await dismissReleaseNotes(page);
  await dismissOnboarding(page);
  await expect(page.locator(".factory-canvas")).toBeVisible();
}

async function setFontScale(page: Page, scale: 80 | 100 | 125 | 150 | 200) {
  await page.evaluate((value) => {
    document.documentElement.dataset.uiFontScale = String(value);
    document.documentElement.style.setProperty("--ui-font-scale", String(value / 100));
  }, scale);
}

async function openHeaderWorkspace(page: Page, directLabel: string, menuLabel: RegExp) {
  const direct = page.getByLabel(directLabel);
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return;
  }
  await page.getByRole("button", { name: /^(?:更多工作区|More workspaces)$/ }).click();
  await page.getByRole("menuitem", { name: menuLabel }).click();
}

test("Harmony-style IME composition survives simulation refreshes and orientation changes", async ({ page }) => {
  await seedReleaseFactory(page, { paused: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await openGame(page, "/?mobileUi=next");
  await page.getByRole("button", { name: "建造", exact: true }).click();
  const build = page.getByRole("dialog", { name: "建造" });
  await build.getByRole("tab", { name: "载具" }).click();
  const search = build.getByLabel("搜索建造项目");

  await search.dispatchEvent("compositionstart", { data: "" });
  await search.fill("物流运输船");
  await search.dispatchEvent("compositionupdate", { data: "物流运输船" });
  await page.waitForTimeout(1_200);
  await expect(search).toHaveValue("物流运输船");
  await search.dispatchEvent("compositionend", { data: "物流运输船" });
  await expect(build.locator(".mobile-build-card").filter({ hasText: "物流运输船" })).toHaveCount(1);

  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(700);
  await expect(search).toHaveValue("物流运输船");
  await search.fill("logistics_vessel");
  await page.waitForTimeout(700);
  await expect(search).toHaveValue("logistics_vessel");
  await page.screenshot({ path: "artifacts/qa/v103-harmony-search-landscape-844x390.png", fullPage: true });

  await build.getByRole("button", { name: "关闭建造" }).click();
  await page.getByRole("button", { name: "建造", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "建造" }).getByLabel("搜索建造项目")).toHaveValue("");
});

test("star-map search and metadata drafts survive simulation refresh, responsive remounts and workspace reopen", async ({ page }) => {
  await seedReleaseFactory(page, { paused: false });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openGame(page);
  await page.getByLabel("打开星图").click();
  let starMap = page.getByRole("dialog", { name: "星图" });
  const search = starMap.getByLabel("搜索星球资料");
  await search.dispatchEvent("compositionstart", { data: "" });
  await search.fill("绿糖出口");
  await search.dispatchEvent("compositionupdate", { data: "绿糖出口" });
  const metadata = starMap.locator(".stellar-metadata-manager");
  await metadata.locator("summary").click();
  const note = metadata.getByLabel("备注");
  await note.dispatchEvent("compositionstart", { data: "" });
  await note.fill("量子物流中转与绿糖出口");
  await note.dispatchEvent("compositionupdate", { data: "量子物流中转与绿糖出口" });

  await page.waitForTimeout(1_200);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(search).toHaveValue("绿糖出口");
  await expect(note).toHaveValue("量子物流中转与绿糖出口");
  await search.dispatchEvent("compositionend", { data: "绿糖出口" });
  await note.dispatchEvent("compositionend", { data: "量子物流中转与绿糖出口" });

  await starMap.getByLabel("关闭星图").click();
  await openHeaderWorkspace(page, "打开星图", /^星图$/);
  starMap = page.getByRole("dialog", { name: "星图" });
  await expect(starMap.getByLabel("搜索星球资料")).toHaveValue("绿糖出口");
  await starMap.locator(".stellar-metadata-manager summary").click();
  await expect(starMap.locator(".stellar-metadata-manager").getByLabel("备注")).toHaveValue("量子物流中转与绿糖出口");
});

test("production codex locates every producer, highlights upstream belts and clears cleanly", async ({ page }) => {
  await seedReleaseFactory(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openGame(page);
  await openHeaderWorkspace(page, "打开生产资料库", /^生产资料库$/);
  const codex = page.getByRole("dialog", { name: "生产资料库" });
  await codex.locator(".recipe-index > button").filter({ hasText: "铁块" }).click();
  await codex.getByRole("button", { name: /定位产线/ }).click();

  const indicator = page.locator(".production-line-focus-indicator");
  await expect(indicator).toContainText("2 个生产节点");
  await expect(page.locator('.react-flow__node[data-id="smelter-a"]')).toHaveClass(/factory-flow-node--network-focus/);
  await expect(page.locator('.react-flow__node[data-id="smelter-b"]')).toHaveClass(/factory-flow-node--network-focus/);
  await expect(page.locator('.react-flow__node[data-id="vein_iron"]')).toHaveClass(/factory-flow-node--network-focus/);
  await expect(page.locator('.react-flow__node[data-id="wind"]')).toHaveClass(/factory-flow-node--network-dim/);
  for (const button of await indicator.locator("button").all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await indicator.getByRole("button", { name: "下一个生产节点" }).click();
  await expect(indicator).toContainText("2/2");
  await page.screenshot({ path: "artifacts/qa/v103-production-locator-desktop-1920x1080.png", fullPage: true });
  await indicator.getByRole("button", { name: "清除产线高亮" }).click();
  await expect(indicator).toHaveCount(0);

  await page.getByRole("button", { name: "折叠物资侧栏" }).click();
  await expect(page.locator(".game-shell")).toHaveClass(/sidebar-left-collapsed/);
  const collapsed = await page.locator(".resource-rail").evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: element.getBoundingClientRect().width, visibility: style.visibility, background: style.backgroundColor, border: style.borderWidth };
  });
  expect(collapsed.width).toBe(0);
  expect(collapsed.visibility).toBe("hidden");
  expect(collapsed.border).toBe("0px");
  expect(collapsed.background).toBe("rgba(0, 0, 0, 0)");
  await page.getByRole("button", { name: "展开物资侧栏" }).click();
  await expect(page.locator(".resource-rail")).toBeVisible();
});

test("storage ports and tray deletion controls stay reachable across font and mobile matrices", async ({ page }) => {
  await seedReleaseFactory(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openGame(page);

  for (const scale of [80, 100, 125, 150, 200] as const) {
    await setFontScale(page, scale);
    for (const id of ["storage", "tank"]) {
      const geometry = await page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((element) => {
        const card = element.querySelector<HTMLElement>(".factory-node")!;
        const cardBox = card.getBoundingClientRect();
        const input = element.querySelector<HTMLElement>(".factory-handle--input")?.getBoundingClientRect();
        const output = element.querySelector<HTMLElement>(".factory-handle--output")?.getBoundingClientRect();
        const labels = [...element.querySelectorAll<HTMLElement>(".item-badge strong, .node-io__column > span")];
        return input && output ? {
          inputDelta: Math.abs(input.left + input.width / 2 - cardBox.left),
          outputDelta: Math.abs(output.left + output.width / 2 - cardBox.right),
          clipped: labels.some((label) => label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1),
        } : null;
      });
      expect(geometry).not.toBeNull();
      expect(geometry!.inputDelta, `${id} ${scale}% input handle`).toBeLessThanOrEqual(20);
      expect(geometry!.outputDelta, `${id} ${scale}% output handle`).toBeLessThanOrEqual(20);
      expect(geometry!.clipped, `${id} ${scale}% labels`).toBe(false);
    }
  }
  await page.screenshot({ path: "artifacts/qa/v103-storage-font-200-desktop-1920x1080.png", fullPage: true });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/?mobileUi=next");
  await dismissReleaseNotes(page);
  await dismissOnboarding(page);
  await setFontScale(page, 200);
  await page.getByRole("button", { name: "物资", exact: true }).click();
  await page.getByRole("dialog", { name: "物资" }).getByRole("button", { name: "管理", exact: true }).click();
  const tray = page.getByRole("dialog", { name: "管理当前行星物资托盘" });
  await tray.getByRole("button", { name: "全选" }).click();
  const actions = tray.locator(":scope > footer button");
  await expect(actions).toHaveCount(3);
  for (const action of await actions.all()) {
    await expect(action).toBeVisible();
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(568);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: "artifacts/qa/v103-tray-delete-font-200-320x568.png", fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  for (const action of await actions.all()) {
    await expect(action).toBeVisible();
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(390);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: "artifacts/qa/v103-tray-delete-font-200-844x390.png", fullPage: true });
});

test("depleted-resource shortcut and spray removal preserve reachable recovery actions", async ({ page }) => {
  await seedReleaseFactory(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openGame(page);

  const vein = page.locator('.react-flow__node[data-id="vein_iron"]');
  await expect(vein.locator(".vein-node--depleted")).toBeVisible();
  await vein.click();
  await page.getByRole("button", { name: /矿脉已枯竭/ }).click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await selectSettingsCategory(operations, "存档与云同步", "storage");
  const infinite = operations.getByLabel("资源模式").getByRole("button", { name: "无限矿脉" });
  await infinite.click();
  await page.locator(".game-dialog").getByRole("button", { name: "确认切换" }).click();
  await expect(infinite).toHaveClass(/active/);
  await page.keyboard.press("Escape");

  await page.locator('.react-flow__node[data-id="smelter-a"]').click();
  const removal = page.getByRole("button", { name: "拆卸喷涂模块" });
  await expect(removal).toContainText("增产剂 Mk.I ×4");
  await removal.click();
  await page.locator(".game-dialog").getByRole("button", { name: "确认拆卸" }).click();
  await expect(page.getByRole("button", { name: "拆卸喷涂模块" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: /喷涂模块已拆卸并返还/ })).toBeVisible();

  await page.locator('.react-flow__edge[data-id="ore-belt-b"]').evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const laneInput = page.locator(".inspector-panel").getByLabel("并联线路目标数量");
  await laneInput.fill("2");
  await laneInput.blur();
  await expect(laneInput).toHaveValue("2");
  await page.screenshot({ path: "artifacts/qa/v103-resource-spray-actions-desktop-1920x1080.png", fullPage: true });
});

test("logistics vessels recursively quick-craft into the portable fleet", async ({ page }) => {
  await seedReleaseFactory(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openGame(page, "/?mobileUi=next");
  await page.getByRole("button", { name: "建造", exact: true }).click();
  const build = page.getByRole("dialog", { name: "建造" });
  await build.getByRole("tab", { name: "载具" }).click();
  const vessel = build.locator(".mobile-build-card").filter({ hasText: "物流运输船" });
  await expect(vessel).toBeEnabled();
  await expect(vessel).toContainText("递归加工");
  await vessel.click();
  await expect(vessel).toContainText("已有 ×1");
  await page.screenshot({ path: "artifacts/qa/v103-recursive-vessel-mobile-390x844.png", fullPage: true });
});

test("new production-location surfaces remain English in light mode", async ({ page }) => {
  await seedReleaseFactory(page, { theme: "light", locale: "en" });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openGame(page, "/?lang=en");
  await openHeaderWorkspace(page, "Open Production Library", /^Production Library$/);
  const codex = page.getByRole("dialog", { name: "Production Library" });
  await codex.locator(".recipe-index > button").filter({ hasText: "Iron Ingot" }).click();
  await codex.getByRole("button", { name: /Locate Production Line/ }).click();
  const indicator = page.locator(".production-line-focus-indicator");
  await expect(indicator).toContainText("Production Line Locator");
  const visibleText = await indicator.innerText();
  expect(visibleText).not.toMatch(/[\u3400-\u9fff]/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "artifacts/qa/v103-production-locator-english-light-1920x1080.png", fullPage: true });
});

test("next-version selection, line finder, planet statistics and local settings stay reachable", async ({ page }) => {
  await seedReleaseFactory(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openGame(page);

  const lineFinder = page.getByTestId("line-find-toggle");
  await lineFinder.click();
  await page.locator('.react-flow__node[data-id="smelter-a"]').click();
  await expect(page.locator('.react-flow__node[data-id="smelter-a"]')).toHaveClass(/factory-flow-node--line-find-center/);
  await lineFinder.click();

  await openHeaderWorkspace(page, "打开生产统计", /^生产统计$/);
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  const planetSelect = statistics.getByLabel("选择统计星球");
  await expect(planetSelect).toHaveValue("all");
  await planetSelect.selectOption("home");
  await expect(statistics.locator('[data-planet-scope="home"]')).toBeVisible();
  await statistics.getByRole("button", { name: "关闭生产统计" }).click();

  await openHeaderWorkspace(page, "打开设置", /^运营中心$/);
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(operations, "存档与云同步", "storage");
  await expect(operations.getByRole("button", { name: "10 分钟" })).toBeVisible();
  await expect(operations.getByRole("button", { name: "关闭", exact: true })).toBeVisible();
  await selectSettingsCategory(operations, "交互与控制", "interaction");
  await operations.getByText("寻线模式默认开启").click();
  await page.getByRole("button", { name: "关闭运营中心" }).click();
  await expect(page.locator(".factory-canvas")).toBeVisible();
});

