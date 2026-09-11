import { expect, test } from "@playwright/test";

const RELEASE_NOTE_ID = "2026-08-11-v1.0.38";

function seedStationUpgradeFixture() {
  return () => {
    const releaseNoteId = "2026-08-11-v1.0.38";
    const entityBase = {
      interactionLocked: false,
      minerCount: 0,
      routingCursor: 0,
      progress: 0,
      utilization: 0,
      productionRate: 0,
      inputs: {},
      outputs: {},
      stationSlots: [],
      stationRoutes: [],
      stationDrones: 0,
      stationVessels: 0,
      stationWarpers: 0,
      stationWarpEnabled: true,
      stationOperationMode: "legacy",
      stationModeTransition: null,
      stationTier: 1,
    };
    const stationMaterials = { titanium_alloy: 10_000, frame_material: 5_000, quantum_chip: 5_000, universe_matrix: 10_000 };
    const state = {
      version: 43,
      nextId: 4,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "v118_home_station", kind: "station", planetId: "home", position: { x: 120, y: 80 }, buildingId: "interstellar_logistics_station", machineCount: 1 },
        { ...entityBase, id: "v118_ashen_station", kind: "station", planetId: "ashen", position: { x: 120, y: 80 }, buildingId: "interstellar_logistics_station", machineCount: 1 },
      ],
      belts: [],
      construction: {},
      constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null, jobs: {} },
      tray: stationMaterials,
      planetTrays: { home: stationMaterials, ashen: stationMaterials },
      planetTrayItemLimits: { home: 1_000_000, ashen: 1_000_000 },
      portableFleet: { logistics_drone: 10, logistics_vessel: 4 },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["interstellar_logistics", "orbital_elevator_engineering", "space_warp"] },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home", "ashen", "frost"], surveyProgressBySystem: { helios: 1 }, missions: [] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30, resourceMode: "finite" },
      paused: true,
    };
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", releaseNoteId);
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  };
}

test("selected interstellar station exposes a working Mk.II upgrade and star map bulk action", async ({ page }) => {
  await page.addInitScript(seedStationUpgradeFixture());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".factory-canvas")).toBeVisible();

  await page.locator('.react-flow__node[data-id="v118_home_station"]').click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.getByRole("button", { name: "升级 Mk.II" })).toBeVisible();
  await expect(inspector.locator(".station-upgrade-status")).toContainText("科技与升级材料均已满足");
  await inspector.getByRole("button", { name: "升级 Mk.II" }).click();
  await expect(inspector.locator(".station-upgrade-status").first()).toContainText("已是 Mk.II");
  await expect(page.getByRole("status")).toContainText("原地升级为 Mk.II");

  await page.locator(".game-header").getByLabel("打开星图").click();
  const starMap = page.locator(".star-map-workspace");
  await expect(starMap).toBeVisible();
  await expect(starMap.getByRole("button", { name: "升级全部星际物流站" })).toBeVisible();
  await expect(starMap.getByRole("button", { name: /一键升级本系物流站/ }).first()).toBeVisible();
  await starMap.getByRole("button", { name: "升级全部星际物流站" }).click({ force: true });
  const confirmation = page.getByRole("alertdialog", { name: "确认批量升级物流站" });
  await expect(confirmation).toContainText("可成功 1 座，跳过 1 座");
  await confirmation.getByRole("button", { name: "确认升级" }).click();
  await expect(page.getByRole("status").filter({ hasText: "批量升级完成" })).toContainText("成功 1 座，跳过 1 座");
});

test("missing technology and materials are shown instead of a silent no-op", async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-11-v1.0.38");
    window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({ version: 1, skipped: true, stepIndex: 5 }));
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state: {
      version: 43, nextId: 2, activePlanetId: "home",
      entities: [{ id: "v118_blocked_station", kind: "station", planetId: "home", position: { x: 120, y: 80 }, interactionLocked: false, buildingId: "interstellar_logistics_station", machineCount: 1, minerCount: 0, routingCursor: 0, progress: 0, utilization: 0, productionRate: 0, inputs: {}, outputs: {}, stationSlots: [], stationRoutes: [], stationTier: 1, stationOperationMode: "legacy", stationModeTransition: null }],
      belts: [], construction: {}, tray: {}, planetTrays: { home: {} }, totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      settings: { theme: "dark", fontScale: 1, simulationSpeed: 1, autosaveIntervalSeconds: 30 }, paused: true,
    }}));
  });
  await page.goto("/");
  await expect(page.locator('.react-flow__node[data-id="v118_blocked_station"]')).toBeVisible();
  await page.locator('.react-flow__node[data-id="v118_blocked_station"]').evaluate((element) => (element as HTMLElement).click());
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.locator(".station-upgrade-status")).toContainText("需要先研究");
  await inspector.getByRole("button", { name: "升级 Mk.II" }).click();
  await expect(page.getByRole("status")).toContainText("需要先研究");
});

test("local development free-build mode permits bulk upgrades without materials", async ({ page }) => {
  await page.addInitScript(seedStationUpgradeFixture());
  await page.addInitScript(() => {
    const key = "dsp-idle-network.save.v1";
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const payload = JSON.parse(raw);
    payload.state.tray = {};
    payload.state.planetTrays = { home: {}, ashen: {} };
    window.localStorage.setItem(key, JSON.stringify(payload));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator('.react-flow__node[data-id="v118_home_station"]').click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.locator(".station-upgrade-status").first()).toContainText("科技与升级材料均已满足");
  await inspector.getByRole("button", { name: "升级 Mk.II" }).click();
  await expect(inspector.locator(".station-upgrade-status").first()).toContainText("已是 Mk.II");
});
