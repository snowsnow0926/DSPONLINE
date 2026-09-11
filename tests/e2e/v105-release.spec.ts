import { expect, test, type Page } from "@playwright/test";
import { migrateGame, serializeEnvelope } from "../../src/game/storage";

const RELEASE_NOTE_ID = "2026-08-17-v1.0.46";

function createV105LegacyState() {
  const base = {
    planetId: "home",
    minerCount: 0,
    routingCursor: 0,
    progress: 0,
    utilization: 0,
    productionRate: 0,
    inputs: {},
    outputs: {},
  };
  return {
    version: 37,
    nextId: 20,
    activePlanetId: "home",
    entities: [
      {
        ...base,
        id: "v105_station",
        kind: "station",
        position: { x: 120, y: 80 },
        buildingId: "interstellar_logistics_station",
        machineCount: 1,
        stationMode: "supply",
        stationDrones: 2,
        stationVessels: 1,
        stationWarpers: 0,
        stationWarpEnabled: true,
        stationRoutes: [],
      },
      { ...base, id: "v105_smelter", kind: "machine", position: { x: -260, y: -120 }, buildingId: "arc_smelter", recipeId: "iron_ingot", machineCount: 1 },
    ],
    belts: [],
    construction: {},
    constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, jobs: {} },
    tray: {},
    planetTrays: { home: {} },
    planetTrayItemLimits: { home: 1_000_000 },
    portableFleet: { logistics_drone: 10, logistics_vessel: 4 },
    totalProduced: {},
    research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["interstellar_logistics", "space_warp"] },
    settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30, resourceMode: "finite" },
    paused: true,
  };
}

async function seedV105Factory(page: Page, mobileUi: "legacy" | "next" = "legacy", durable = false) {
  const legacyState = createV105LegacyState();
  const migratedState = durable ? migrateGame({ ...legacyState, mode: "normal" }) : null;
  if (durable && !migratedState) throw new Error("v105 legacy fixture did not migrate");
  const saveRaw = durable
    ? serializeEnvelope(migratedState!, Date.now(), "primary", undefined, undefined, "main")
    : JSON.stringify({ savedAt: Date.now(), state: legacyState });
  await page.addInitScript(({ releaseNoteId, selectedMobileUi, useDurableStartup, initialSaveRaw }) => {
    if (!useDurableStartup) window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    if (window.sessionStorage.getItem("dsp-idle-network.v105-e2e-seeded") !== "1") {
      window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
      window.localStorage.setItem("dsp-idle-network.mobile-ui.v1", selectedMobileUi);
      window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
      window.localStorage.setItem("dsp-idle-network.save.v1", initialSaveRaw);
      window.sessionStorage.setItem("dsp-idle-network.v105-e2e-seeded", "1");
    }
  }, { releaseNoteId: RELEASE_NOTE_ID, selectedMobileUi: mobileUi, useDurableStartup: durable, initialSaveRaw: saveRaw });
}

async function openFactory(page: Page, path = "/") {
  await page.goto(path);
  const acknowledgeRelease = page.getByRole("button", { name: "我知道了" });
  await acknowledgeRelease.waitFor({ state: "visible", timeout: 1_000 }).catch(() => undefined);
  if (await acknowledgeRelease.isVisible().catch(() => false)) await acknowledgeRelease.click();
  const onboarding = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await onboarding.count()) await onboarding.first().click();
  await expect(page.locator(".factory-canvas")).toBeVisible();
}

async function openDurableFactory(page: Page) {
  await page.goto("/?menu=1");
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.getByRole("button", { name: "进入工厂", exact: true }).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 15_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 15_000 });
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "false");
  await expect(page.locator(".factory-canvas")).toBeVisible();
}

test("station fleet targets accept direct quantities and remain usable on next mobile UI", async ({ page }) => {
  await seedV105Factory(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFactory(page);
  await page.locator('.react-flow__node[data-id="v105_station"]').click();
  const inspector = page.locator(".inspector-panel");
  const drones = inspector.getByLabel("物流运输机目标数量");
  const vessels = inspector.getByLabel("物流运输船目标数量");
  await drones.fill("7");
  await drones.blur();
  await expect(drones).toHaveValue("7");
  await vessels.fill("5");
  await vessels.blur();
  await expect(vessels).toHaveValue("5");
  await inspector.locator(".station-local-fleet-control").getByRole("button", { name: "一键填满" }).click();
  await expect(drones).toHaveValue("12");
  await page.screenshot({ path: "artifacts/qa/v105-station-fleet-desktop-1440x900.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await openFactory(page, "/?mobileUi=next");
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await page.locator('.react-flow__node[data-id="v105_station"]').click();
  const mobileInspector = page.locator(".mobile-inspector-sheet");
  await expect(mobileInspector).toBeVisible();
  await mobileInspector.getByRole("button", { name: /^展开/ }).click();
  await mobileInspector.getByRole("button", { name: "完整设置" }).click();
  const mobileInput = page.getByLabel("物流运输机目标数量");
  await expect(mobileInput).toBeVisible();
  for (const control of await mobileInput.locator("xpath=..").locator("button, input").all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/v105-station-fleet-mobile-font-200-390x844.png", fullPage: true });
});

test("dragged building coordinates survive an immediate page refresh without drift", async ({ page }) => {
  await seedV105Factory(page, "legacy", true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDurableFactory(page);
  const node = page.locator('.react-flow__node[data-id="v105_smelter"]');
  const before = await node.boundingBox();
  expect(before).not.toBeNull();
  const dragX = before!.x + before!.width / 2;
  const dragY = before!.y + Math.min(before!.height - 20, 82);
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.move(dragX + 120, dragY + 60, { steps: 12 });
  await page.mouse.up();
  const moved = await node.boundingBox();
  expect(moved).not.toBeNull();
  expect(moved!.x).toBeGreaterThan(before!.x + 80);

  await page.reload();
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.getByRole("button", { name: "进入工厂", exact: true }).click();
  const reloadedShell = page.locator(".game-shell");
  await expect(reloadedShell).toBeVisible({ timeout: 15_000 });
  await expect(reloadedShell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 15_000 });
  await expect(reloadedShell).toHaveAttribute("data-primary-save-edit-lock", "false");
  await expect(page.locator(".factory-canvas")).toBeVisible();
  const restored = await page.locator('.react-flow__node[data-id="v105_smelter"]').boundingBox();
  expect(restored).not.toBeNull();
  expect(restored!.x).toBeCloseTo(moved!.x, 0);
  expect(restored!.y).toBeCloseTo(moved!.y, 0);
  await page.screenshot({ path: "artifacts/qa/v105-position-refresh-desktop-1440x900.png", fullPage: true });
});

