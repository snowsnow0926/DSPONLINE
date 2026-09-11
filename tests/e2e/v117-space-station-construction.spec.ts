import { expect, test } from "@playwright/test";

function installStationTrayFixture() {
  return () => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({
      savedAt: Date.now(),
      state: {
        version: 42,
        nextId: 1,
        activePlanetId: "home",
        entities: [],
        belts: [],
        construction: { space_station_construction_launcher: 1 },
        tray: {},
        planetTrays: { home: {} },
        totalProduced: {},
        settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30 },
        research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["system_space_station_engineering"] },
        paused: true,
      },
    }));
  };
}

test("space station construction launcher appears in desktop and mobile construction trays", async ({ page }) => {
  await page.addInitScript(installStationTrayFixture());
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  const desktopLauncher = page.locator("button.construction-item").filter({ hasText: "空间站施工发射平台" });
  await expect(desktopLauncher).toBeVisible();
  await page.getByRole("combobox", { name: "施工托盘分类" }).selectOption("logistics");
  await expect(desktopLauncher).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?mobileUi=next");
  await page.getByRole("button", { name: "建造" }).click();
  await expect(page.locator("button.mobile-build-card").filter({ hasText: "空间站施工发射平台" })).toBeVisible();
});

test("star map no longer exposes the deprecated space-station and elevator entry", async ({ page }) => {
  await page.addInitScript(() => {
    const entityBase = { interactionLocked: false, minerCount: 0, routingCursor: 0, progress: 0, utilization: 0, productionRate: 0, inputs: {}, outputs: {} };
    const state = {
      version: 43,
      nextId: 2,
      activePlanetId: "home",
      entities: [{ ...entityBase, id: "v117_launcher", kind: "machine", planetId: "home", position: { x: 120, y: 80 }, buildingId: "space_station_construction_launcher", machineCount: 1 }],
      belts: [], construction: {}, tray: {}, planetTrays: { home: {} }, planetTrayItemLimits: { home: 1_000_000 }, totalProduced: {},
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home", "ashen", "frost"], surveyProgressBySystem: { helios: 1 }, missions: [] },
      systemSpaceStations: { helios: { systemId: "helios", status: "not-started", costRevision: 0, costMultiplierBasisPoints: 10_000, phaseIndex: 0, delivered: {}, constructionBuffer: {}, inventory: {}, itemPolicies: {}, modules: { backbone: 0, energy: 0, interstellar: 0 }, routingCursors: {}, viewport: { x: 0, y: 0, zoom: 0.85 }, decorations: [] } },
      galacticHubNetwork: { fleetInstalled: 0, fleetBusy: 0, fleetReturns: [], warpers: "0", warperTarget: "0", routingCursors: {} },
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["system_space_station_engineering"] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30 }, paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".game-header").getByLabel("打开星图").click();
  const starMap = page.locator(".star-map-workspace");
  await expect(starMap.getByRole("button", { name: "空间站与太空电梯" })).toHaveCount(0);
  await expect(starMap).not.toContainText("空间站与太空电梯");
});

