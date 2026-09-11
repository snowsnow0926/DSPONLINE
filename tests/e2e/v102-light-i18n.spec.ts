import { expect, test, type Page } from "@playwright/test";
import { selectSettingsCategory } from "./settings-helpers";

const RELEASE_NOTE_ID = "2026-08-11-v1.0.38";

async function seedEnglishFactory(page: Page, mobileUi: "legacy" | "next" = "next") {
  await page.addInitScript(({ releaseNoteId, mobileUi }) => {
    const base = { planetId: "home", minerCount: 0, routingCursor: 0, progress: 0.38, utilization: 0, productionRate: 0, inputs: {}, outputs: {} };
    const state = {
      version: 34,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...base, id: "wind", kind: "power", position: { x: -240, y: -140 }, buildingId: "wind_turbine", machineCount: 4 },
        { ...base, id: "smelter", kind: "machine", position: { x: 60, y: -140 }, buildingId: "arc_smelter", recipeId: "iron_ingot", machineCount: 2, inputs: { iron_ore: 80 } },
        { ...base, id: "storage", kind: "storage", position: { x: -120, y: 170 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", machineCount: 1, inputs: { iron_ingot: 20 }, outputs: { iron_ingot: 40 } },
      ],
      belts: [],
      construction: { arc_smelter: 2, storage_mk1: 2 },
      tray: { iron_ore: 1000, copper_ore: 1000, stone: 1000 },
      planetTrays: { home: { iron_ore: 1000, copper_ore: 1000, stone: 1000 } },
      planetTrayItemLimits: { home: 1_000_000 },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["electromagnetism"] },
      settings: { theme: "light", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30 },
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.locale.v1", "en");
    window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", mobileUi);
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  }, { releaseNoteId: RELEASE_NOTE_ID, mobileUi });
}

async function closeOnboarding(page: Page) {
  const coach = page.locator(".onboarding-coach");
  if (await coach.count()) await coach.locator("button").last().click();
}

function luminance(rgb: string): number {
  const channels = rgb.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  return channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

async function visibleHanStrings(locator: ReturnType<Page["locator"]>): Promise<string[]> {
  return locator.evaluate((root) => {
    const isVisible = (element: Element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
    };
    const values: Array<string | null | undefined> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      if (current.parentElement && isVisible(current.parentElement)) values.push(current.nodeValue?.trim());
      current = walker.nextNode();
    }
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (isVisible(element)) values.push(element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("placeholder"));
    }
    return values
      .filter((value): value is string => Boolean(value && /[\u3400-\u9fff]/.test(value)))
      .filter((value, index, all) => all.indexOf(value) === index);
  });
}

test("English query and start-menu setting persist as a device preference", async ({ page }) => {
  await page.addInitScript((releaseNoteId) => {
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
  }, RELEASE_NOTE_ID);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1&lang=en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("DSP Idle Network", { exact: true }).first()).toBeVisible();
  const language = page.locator(".start-menu-language-prominent");
  await expect(language).toBeVisible();
  await expect(language.getByRole("button", { name: "English", exact: true })).toHaveAttribute("aria-pressed", "true");
  await language.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.locale.v1"))).toBe("zh-CN");
  expect(await page.evaluate(() => window.localStorage.getItem("dsp-idle-network.save.v1"))).toBeNull();
});

test("English light factory and lazy workspaces stay readable on desktop", async ({ page }) => {
  await seedEnglishFactory(page, "legacy");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?factory=1&lang=en&mobileUi=legacy");
  await closeOnboarding(page);
  await expect(page.locator(".factory-canvas")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('.react-flow__node[data-id="smelter"]')).toContainText("Smelter");
  await page.getByLabel("Open Production Library").click();
  const codex = page.getByRole("dialog", { name: "Production Library" });
  await expect(codex).toBeVisible();
  await expect(codex.getByText("Iron Ore", { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(350);
  const codexColor = await codex.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(luminance(codexColor)).toBeGreaterThan(205);
  expect(await visibleHanStrings(codex)).toEqual([]);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v102-english-light-desktop.png", fullPage: true });
});

test("English light release notes are localized and persist dismissal", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("dsp-idle-network.locale.v1", "en");
    window.localStorage.removeItem("dsp-idle-network.release-notes.seen.v1");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?menu=1&lang=en");
  const dialog = page.getByRole("dialog", { name: "Endgame Performance, Leaner Saves & Vein Expansion" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("1.0.38");
  expect(await visibleHanStrings(dialog)).toEqual([]);
  await dialog.getByRole("button", { name: "Got it" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.release-notes.seen.v1"))).toBe(RELEASE_NOTE_ID);
});

test("English light primary workspaces use opaque light surfaces", async ({ page }) => {
  test.setTimeout(60_000);
  await seedEnglishFactory(page, "legacy");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?factory=1&lang=en&mobileUi=legacy");
  await closeOnboarding(page);
  const workspaces = [
    ["Open Production Statistics", ".statistics-workspace"],
    ["Open Technology Tree", ".technology-workspace"],
    ["Open Star Map", ".star-map-workspace"],
    ["Open Galactic Network", ".galaxy-workspace"],
    ["Open Campaign Center", ".campaign-workspace"],
    ["Open Settings", ".operations-workspace"],
    ["Open Dyson Sphere Planning", ".dyson-planner-workspace"],
  ] as const;
  for (const [label, selector] of workspaces) {
    await page.getByLabel(label).first().click();
    const workspace = page.locator(selector);
    await expect(workspace).toBeVisible();
    await page.waitForTimeout(350);
    expect(luminance(await workspace.evaluate((element) => getComputedStyle(element).backgroundColor))).toBeGreaterThan(205);
    expect(await visibleHanStrings(workspace)).toEqual([]);
    if (selector === ".star-map-workspace") {
      await workspace.getByRole("tab", { name: "Quantum Inventory" }).click();
      await expect(workspace.getByRole("region", { name: "Quantum-space Inventory" })).toBeVisible();
      expect(await visibleHanStrings(workspace)).toEqual([]);
    }
    await page.keyboard.press("Escape");
    await expect(workspace).toHaveCount(0);
  }
});

test("English light next-mobile shell keeps navigation and settings reachable", async ({ page }) => {
  await seedEnglishFactory(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?factory=1&lang=en&mobileUi=next");
  await closeOnboarding(page);
  const nav = page.locator(".mobile-next-bottom-nav");
  for (const label of ["Factory", "Build", "Materials", "Research", "More"]) await expect(nav.getByRole("button", { name: label, exact: true })).toBeVisible();
  for (const label of ["Build", "Materials", "Research"]) {
    await nav.getByRole("button", { name: label, exact: true }).click();
    await page.waitForTimeout(150);
    expect(await visibleHanStrings(page.locator("body"))).toEqual([]);
  }
  await nav.getByRole("button", { name: "More", exact: true }).click();
  const hub = page.getByRole("dialog", { name: "More workspaces" });
  await expect(hub).toBeVisible();
  expect(luminance(await hub.evaluate((element) => getComputedStyle(element).backgroundColor))).toBeGreaterThan(205);
  await hub.getByRole("button", { name: /Game Settings/ }).click();
  const operations = page.getByRole("dialog", { name: "Operations Center" });
  await selectSettingsCategory(operations, "Appearance & Theme", "visual");
  await expect(operations.getByLabel("Language")).toBeVisible();
  expect(await visibleHanStrings(operations)).toEqual([]);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v102-english-light-mobile-390x844.png", fullPage: true });
});
