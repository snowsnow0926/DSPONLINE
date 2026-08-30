import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { createInitialState } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";
import { selectSettingsCategory } from "./settings-helpers";

async function installTestBootstrap(page: Page) {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    if (new URLSearchParams(window.location.search).get("releaseNotesTest") !== "1") {
      window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-30-v1.2.5");
    }
  });
}

async function dismissOnboarding(page: Page) {
  const control = page.getByRole("button", { name: /^(?:关闭|跳过)启动引导$/ });
  if (await control.count()) await control.first().click();
}

const testsManagingOfflineReport = new Set([
  "offline report summarizes production before entering the factory",
  "running equipment uses semantic animation and reduced motion disables it",
  "command palette navigates workspaces, focuses recipes and preserves keyboard flow",
]);

const testsManagingOnboarding = new Set([
  "progressive onboarding reaches interstellar logistics and locates its blocker",
  "five-step basic onboarding advances only after successful factory commands",
  "manual mining feeds a powered smelter",
]);

test.beforeEach(async ({ page }, testInfo) => {
  await installTestBootstrap(page);
  if (!testsManagingOnboarding.has(testInfo.title)) {
    await page.addInitScript(() => window.localStorage.setItem("dsp-idle-network.onboarding.v1", "dismissed"));
  }
  if (!testsManagingOfflineReport.has(testInfo.title)) {
    const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
    await page.addLocatorHandler(offlineReport, async () => {
      await offlineReport.getByRole("button", { name: "确认结算" }).click({ force: true });
    });
  }
});



async function freshGame(page: Page) {
  await page.goto("/");
  await expect(page.getByTitle("重置当前工厂")).toHaveCount(0);
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".vein-node").filter({ hasText: "铁矿石" })).toBeVisible({ timeout: 15_000 });
}

async function freshDurableGame(page: Page) {
  await page.goto("/?menu=1");
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.getByRole("button", { name: /开始游戏/ }).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toBeVisible({ timeout: 15_000 });
  await expect(shell).toHaveAttribute("data-runtime-recovery", "active", { timeout: 15_000 });
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "false");
  await expect(page.locator(".vein-node").filter({ hasText: "铁矿石" })).toBeVisible({ timeout: 15_000 });
}

async function enableCoarsePointer(page: Page) {
  await page.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => query === "(pointer: coarse)"
      ? {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return true; },
        } as MediaQueryList
      : nativeMatchMedia(query)) as typeof window.matchMedia;
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
  });
}

async function createTouchPage(browser: Browser, viewport: { width: number; height: number }) {
  const requestedPort = process.env.DSP_E2E_PORT ?? "4319";
  const context = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${requestedPort}`,
    hasTouch: true,
    isMobile: true,
    viewport,
  });
  const page = await context.newPage();
  await installTestBootstrap(page);
  await enableCoarsePointer(page);
  return { context, page };
}

async function placeOnCanvas(page: Page, title: string, x: number, y: number) {
  await page.getByTitle(title).click();
  const canvas = page.locator(".react-flow__pane");
  await canvas.click({ position: { x, y } });
}

async function chooseRecipe(page: Page, scope: Locator, recipeName: string) {
  await scope.locator(".catalog-picker-trigger").click();
  const dialog = page.getByRole("dialog", { name: "配方选择面板" });
  await expect(dialog).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport && viewport.width >= 900 && !(viewport.height < 560 && viewport.width < 1100)) {
    await expect(dialog.getByLabel("搜索配方")).toBeFocused();
  }
  await dialog.locator(".recipe-catalog-grid > button").filter({ hasText: recipeName }).first().click();
}

async function chooseItem(page: Page, scope: Locator, itemName: string) {
  await scope.locator(".catalog-picker-trigger").click();
  const dialog = page.getByRole("dialog", { name: "物品选择面板" });
  await expect(dialog).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport && viewport.width >= 900 && !(viewport.height < 560 && viewport.width < 1100)) {
    await expect(dialog.getByLabel("搜索物品")).toBeFocused();
  }
  await dialog.locator(".item-catalog-grid > button").filter({ hasText: itemName }).first().click();
}

async function openSeededGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 2,
      entities: [],
      belts: [],
      construction: {
        thermal_power_plant: 1,
        storage_mk1: 1,
        splitter_4way: 1,
        storage_tank: 1,
        oil_extractor: 1,
        oil_refinery: 1,
      },
      tray: { coal: 5 },
      totalProduced: {},
      research: { selectedTechId: null, progressByTech: {}, completedTechIds: ["basic_logistics", "thermal_power", "high_efficiency_plasma_control"] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openDisabledHammerGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 28,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: { iron_ore: 1 },
      planetTrays: { home: { iron_ore: 1 } },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"], missions: [], surveyProgressBySystem: { helios: 1 } },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openYellowStageGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 3,
      nextId: 3,
      entities: [
        {
          id: "entity_1",
          kind: "machine",
          position: { x: 160, y: -250 },
          buildingId: "chemical_plant",
          recipeId: "plastic",
          machineCount: 1,
          minerCount: 0,
          inputs: {},
          outputs: {},
          progress: 0,
          routingCursor: 0,
          utilization: 0,
          productionRate: 0,
        },
        {
          id: "entity_2",
          kind: "machine",
          position: { x: 160, y: 120 },
          buildingId: "matrix_lab",
          recipeId: "electromagnetic_matrix",
          machineCount: 1,
          minerCount: 0,
          inputs: {},
          outputs: {},
          progress: 0,
          routingCursor: 0,
          utilization: 0,
          productionRate: 0,
        },
      ],
      belts: [],
      construction: { water_pump: 1, chemical_plant: 0 },
      tray: {},
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: [
          "electromagnetic_matrix",
          "electromagnetism",
          "automatic_metallurgy",
          "basic_assembling",
          "basic_logistics",
          "high_speed_logistics",
          "thermal_power",
          "high_efficiency_plasma_control",
          "energy_matrix",
          "xray_cracking",
          "high_strength_crystal",
          "basic_chemical_engineering",
          "polymer_chemistry",
          "structure_matrix",
          "titanium_alloy",
          "processor",
          "planetary_logistics",
        ],
      },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openInterstellarGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      minerCount: 0,
      inputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 5,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "home_wind", kind: "power", planetId: "home", position: { x: 180, y: -180 }, buildingId: "wind_turbine", machineCount: 4, outputs: {} },
        { ...entityBase, id: "home_station", kind: "station", planetId: "home", position: { x: 180, y: 80 }, buildingId: "interstellar_logistics_station", machineCount: 1, storedItemId: "titanium_ingot", stationMode: "supply", stationProgress: 0.97, stationTrips: 0, stationLastTransfer: 0, stationVessels: 0, stationMinimumLoad: 1, outputs: { titanium_ingot: 140 } },
        { ...entityBase, id: "ashen_wind", kind: "power", planetId: "ashen", position: { x: 180, y: -180 }, buildingId: "wind_turbine", machineCount: 4, outputs: {} },
        { ...entityBase, id: "ashen_station", kind: "station", planetId: "ashen", position: { x: 180, y: 80 }, buildingId: "interstellar_logistics_station", machineCount: 1, storedItemId: "titanium_ingot", stationMode: "demand", stationProgress: 0.97, stationTrips: 0, stationLastTransfer: 0, stationVessels: 1, stationMinimumLoad: 1, outputs: {} },
      ],
      belts: [],
      construction: {},
      tray: { iron_ore: 3 },
      planetTrays: { home: { iron_ore: 3 }, ashen: { titanium_ore: 4 } },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["interstellar_logistics"] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openPurpleStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 5,
      nextId: 6,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "purple_wind", kind: "power", position: { x: 170, y: -430 }, buildingId: "wind_turbine", machineCount: 8 },
        { ...entityBase, id: "purple_chemical", kind: "machine", position: { x: 170, y: -250 }, buildingId: "chemical_plant", recipeId: "graphene" },
        { ...entityBase, id: "purple_smelter", kind: "machine", position: { x: 470, y: -250 }, buildingId: "arc_smelter", recipeId: "crystal_silicon" },
        { ...entityBase, id: "purple_assembler", kind: "machine", position: { x: 170, y: 80 }, buildingId: "assembling_machine_mk1", recipeId: "particle_broadband" },
        { ...entityBase, id: "purple_lab", kind: "machine", position: { x: 470, y: 20 }, buildingId: "matrix_lab", recipeId: "information_matrix" },
      ],
      belts: [],
      construction: {},
      tray: { information_matrix: 7 },
      planetTrays: { home: { information_matrix: 7 }, ashen: {} },
      totalProduced: { information_matrix: 7 },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["nanomaterials", "information_matrix", "interstellar_logistics"],
      },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openGreenStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 5,
      nextId: 6,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "green_wind", kind: "power", position: { x: 170, y: -440 }, buildingId: "wind_turbine", machineCount: 50 },
        { ...entityBase, id: "green_collider", kind: "machine", position: { x: 170, y: -250 }, buildingId: "miniature_particle_collider", recipeId: "deuterium" },
        { ...entityBase, id: "green_thermal", kind: "power", position: { x: 470, y: -250 }, buildingId: "thermal_power_plant", fuelItemId: "deuteron_fuel_rod", inputs: { deuteron_fuel_rod: 1 }, fuelRemainingMj: 0, powerOutputKw: 0 },
        { ...entityBase, id: "green_assembler", kind: "machine", position: { x: 170, y: 110 }, buildingId: "assembling_machine_mk1", recipeId: "quantum_chip" },
        { ...entityBase, id: "green_lab", kind: "machine", position: { x: 470, y: 20 }, buildingId: "matrix_lab", recipeId: "gravity_matrix" },
      ],
      belts: [],
      construction: {},
      tray: { gravity_matrix: 7 },
      planetTrays: { home: { gravity_matrix: 7 }, ashen: {} },
      totalProduced: { gravity_matrix: 7 },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["miniature_particle_collider", "quantum_chip", "gravity_matrix", "research_speed_1"],
      },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openWhiteStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 6,
      nextId: 7,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "white_wind", kind: "power", position: { x: 120, y: -500 }, buildingId: "wind_turbine", machineCount: 50 },
        { ...entityBase, id: "white_ejector", kind: "machine", position: { x: 120, y: -260 }, buildingId: "em_rail_ejector", recipeId: "solar_sail_launch", inputs: { solar_sail: 2 } },
        { ...entityBase, id: "white_receiver", kind: "machine", position: { x: 430, y: -260 }, buildingId: "ray_receiver", recipeId: "critical_photon", outputs: { critical_photon: 2 }, powerOutputKw: 6000 },
        { ...entityBase, id: "white_collider", kind: "machine", position: { x: 120, y: 110 }, buildingId: "miniature_particle_collider", recipeId: "antimatter" },
        { ...entityBase, id: "white_assembler", kind: "machine", position: { x: 430, y: 110 }, buildingId: "assembling_machine_mk1", recipeId: "antimatter_fuel_rod" },
        { ...entityBase, id: "white_lab", kind: "machine", position: { x: 740, y: 20 }, buildingId: "matrix_lab", recipeId: "universe_matrix" },
      ],
      belts: [],
      construction: { em_rail_ejector: 1, ray_receiver: 1 },
      tray: { universe_matrix: 7 },
      planetTrays: { home: { universe_matrix: 7 }, ashen: {} },
      totalProduced: { critical_photon: 2, antimatter: 5, antimatter_fuel_rod: 1, universe_matrix: 7 },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: [
          "gravity_matrix",
          "research_speed_1",
          "research_speed_2",
          "dyson_swarm",
          "ray_receiver",
          "antimatter",
          "universe_matrix",
        ],
      },
      dysonSwarm: {
        sailsInOrbit: 400,
        totalLaunched: 420,
        totalExpired: 20,
        decayProgress: 0,
        generationKw: 14400,
        receiverLoadKw: 6000,
      },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openDysonSphereStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 7,
      nextId: 7,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "sphere_wind", kind: "power", position: { x: 100, y: -500 }, buildingId: "wind_turbine", machineCount: 60 },
        { ...entityBase, id: "sphere_receiver", kind: "machine", position: { x: 400, y: -500 }, buildingId: "ray_receiver", recipeId: "ray_power", powerOutputKw: 6000 },
        { ...entityBase, id: "sphere_frame", kind: "machine", position: { x: 100, y: -190 }, buildingId: "assembling_machine_mk1", recipeId: "frame_material" },
        { ...entityBase, id: "sphere_component", kind: "machine", position: { x: 400, y: -190 }, buildingId: "assembling_machine_mk1", recipeId: "dyson_sphere_component" },
        { ...entityBase, id: "sphere_rocket", kind: "machine", position: { x: -170, y: 180 }, buildingId: "assembling_machine_mk1", recipeId: "small_carrier_rocket" },
        { ...entityBase, id: "sphere_silo", kind: "machine", position: { x: 130, y: 180 }, buildingId: "vertical_launching_silo", recipeId: "carrier_rocket_launch" },
      ],
      belts: [],
      construction: { vertical_launching_silo: 1 },
      tray: { frame_material: 5, dyson_sphere_component: 3, small_carrier_rocket: 2 },
      planetTrays: { home: { frame_material: 5, dyson_sphere_component: 3, small_carrier_rocket: 2 }, ashen: {} },
      totalProduced: { frame_material: 5, dyson_sphere_component: 3, small_carrier_rocket: 2 },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: [
          "universe_matrix",
          "dyson_swarm",
          "ray_receiver",
          "dyson_sphere_program",
          "vertical_launching_silo",
        ],
      },
      dysonSwarm: {
        sailsInOrbit: 0,
        totalLaunched: 400,
        totalExpired: 100,
        decayProgress: 0,
        generationKw: 0,
        receiverLoadKw: 6000,
      },
      dysonSphere: {
        structurePoints: 30,
        totalRocketsLaunched: 30,
        shellSails: 300,
        totalSailsAbsorbed: 300,
        absorptionProgress: 0,
        generationKw: 39600,
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openEndgameStageGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 22,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: {
        universe_matrix: 2_200,
        solar_sail: 6_000,
        small_carrier_rocket: 1_200,
        antimatter_fuel_rod: 600,
      },
      planetTrays: {
        home: {
          universe_matrix: 2_200,
          solar_sail: 6_000,
          small_carrier_rocket: 1_200,
          antimatter_fuel_rod: 600,
        },
        ashen: {},
      },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["universe_matrix"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openHandcraftGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 7,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: {
        iron_ore: 2,
        copper_ore: 2,
        stone: 2,
        magnet: 20,
        copper_ingot: 10,
        iron_ingot: 20,
        carbon_nanotube: 4,
        titanium_alloy: 1,
        high_purity_silicon: 1,
      },
      planetTrays: {
        home: { iron_ore: 2, copper_ore: 2, stone: 2, magnet: 20, copper_ingot: 10, iron_ingot: 20, carbon_nanotube: 4, titanium_alloy: 1, high_purity_silicon: 1 },
        ashen: {},
      },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["dyson_sphere_program"],
      },
      dysonSwarm: { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0, receiverLoadKw: 0 },
      dysonSphere: { structurePoints: 0, totalRocketsLaunched: 0, shellSails: 0, totalSailsAbsorbed: 0, absorptionProgress: 0, generationKw: 0 },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openUpgradeStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0.4,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 8,
      nextId: 3,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "upgrade_storage", kind: "storage", position: { x: -120, y: 0 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", outputs: { iron_ingot: 20 } },
        { ...entityBase, id: "upgrade_assembler", kind: "machine", position: { x: 260, y: 0 }, buildingId: "assembling_machine_mk1", recipeId: "gear", inputs: { iron_ingot: 3 }, outputs: { gear: 2 } },
      ],
      belts: [{ id: "upgrade_belt", planetId: "home", source: "upgrade_storage", target: "upgrade_assembler", itemId: "iron_ingot", lanes: 1, tier: 1, progress: 0.5, priority: 0, lastFlow: 3 }],
      construction: { assembling_machine_mk2: 1, conveyor_belt_mk2: 1 },
      tray: {},
      planetTrays: { home: {}, ashen: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["high_speed_assembling", "high_speed_logistics"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openResearchLineRegressionGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 8,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "research_wind", kind: "power", position: { x: -360, y: -230 }, buildingId: "wind_turbine", machineCount: 2 },
        { ...entityBase, id: "blue_storage", kind: "storage", position: { x: -300, y: -20 }, buildingId: "storage_mk1", storedItemId: "electromagnetic_matrix" },
        { ...entityBase, id: "red_storage", kind: "storage", position: { x: -300, y: 240 }, buildingId: "storage_mk1", storedItemId: "energy_matrix" },
        { ...entityBase, id: "research_lab", kind: "machine", position: { x: 180, y: 80 }, buildingId: "matrix_lab", recipeId: "matrix_research", inputs: { energy_matrix: 1 }, progress: 0.98 },
      ],
      belts: [
        { id: "blue_research_belt", planetId: "home", source: "blue_storage", target: "research_lab", itemId: "electromagnetic_matrix", lanes: 1, tier: 1, progress: 0, priority: 0, lastFlow: 0 },
        { id: "red_research_belt", planetId: "home", source: "red_storage", target: "research_lab", itemId: "energy_matrix", lanes: 1, tier: 1, progress: 0, priority: 0, lastFlow: 0 },
      ],
      construction: {},
      tray: {},
      planetTrays: { home: {}, ashen: {} },
      totalProduced: {},
      research: {
        selectedTechId: "xray_cracking",
        queuedTechIds: [],
        progressByTech: { xray_cracking: { electromagnetic_matrix: 10, energy_matrix: 9 } },
        completedTechIds: ["electromagnetic_matrix", "energy_matrix"],
      },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openHandCarryGame(page: Page) {
  await page.addInitScript(() => {
    const state = {
      version: 8,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: { titanium_ingot: 40 },
      planetTrays: { home: { titanium_ingot: 40 }, ashen: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openProliferatorStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      minerCount: 0,
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 9,
      nextId: 4,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "spray_wind", kind: "power", position: { x: -260, y: -820 }, buildingId: "wind_turbine", machineCount: 3, inputs: {}, outputs: {} },
        { ...entityBase, id: "spray_storage", kind: "storage", position: { x: -260, y: -560 }, buildingId: "storage_mk1", storedItemId: "proliferator_mk3", machineCount: 1, inputs: {}, outputs: { proliferator_mk3: 5 } },
        { ...entityBase, id: "spray_assembler", kind: "machine", position: { x: 180, y: -560 }, buildingId: "assembling_machine_mk1", recipeId: "gear", machineCount: 1, inputs: { iron_ingot: 20 }, outputs: {} },
      ],
      belts: [],
      construction: { spray_coater: 1, conveyor_belt_mk1: 1 },
      tray: {},
      planetTrays: { home: {}, ashen: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["proliferator_1", "proliferator_2", "proliferator_3"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openChemicalRoutingGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 10,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "plastic_source", kind: "machine", position: { x: 250, y: -430 }, buildingId: "chemical_plant", recipeId: "plastic", outputs: { plastic: 20 } },
        { ...entityBase, id: "oil_source", kind: "machine", position: { x: 250, y: -150 }, buildingId: "oil_refinery", recipeId: "plasma_refining", outputs: { refined_oil: 20 } },
        { ...entityBase, id: "water_source", kind: "vein", position: { x: 250, y: 130 }, resourceId: "water", outputs: { water: 20 } },
        { ...entityBase, id: "organic_chemical", kind: "machine", position: { x: 720, y: -150 }, buildingId: "chemical_plant", recipeId: "plastic", outputs: {} },
      ],
      belts: [],
      construction: { conveyor_belt_mk1: 3 },
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["high_efficiency_plasma_control", "basic_chemical_engineering", "polymer_chemistry"] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openDysonPlannerGame(page: Page) {
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
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["dyson_sphere_program", "dyson_shell", "dyson_swarm"],
      },
      exploration: { unlockedSystemIds: ["helios", "borealis"] },
      blueprints: [],
      dysonSwarm: { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0, receiverLoadKw: 0 },
      dysonSphere: { structurePoints: 32, totalRocketsLaunched: 32, shellSails: 0, totalSailsAbsorbed: 0, absorptionProgress: 0, generationKw: 30_720 },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openTechnologyUpgradeGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 15,
      nextId: 3,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "upgrade_station", kind: "station", position: { x: -180, y: 0 }, buildingId: "planetary_logistics_station", storedItemId: "processor", stationMode: "demand", stationDrones: 1, stationVessels: 0, stationProgress: 0, stationTrips: 0, stationLastTransfer: 0, stationMinimumLoad: 0.5 },
        { ...entityBase, id: "upgrade_receiver", kind: "machine", position: { x: 280, y: 0 }, buildingId: "ray_receiver", recipeId: "ray_power", powerOutputKw: 0 },
      ],
      belts: [],
      construction: {},
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {}, frost: {}, boreal_giant: {}, magnetar: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: [
          "mining_speed_1", "mining_speed_2", "mining_speed_3",
          "research_speed_1", "research_speed_2", "research_speed_3",
          "logistics_engine_1", "logistics_engine_2",
          "logistics_capacity_1", "logistics_capacity_2",
          "solar_sail_life_1", "solar_sail_life_2",
          "ray_transmission_1", "ray_transmission_2", "dyson_absorption_1",
          "planetary_logistics", "ray_receiver", "dyson_swarm", "dyson_shell",
        ],
      },
      exploration: { unlockedSystemIds: ["helios"] },
      blueprints: [],
      dysonSwarm: { sailsInOrbit: 0, totalLaunched: 0, totalExpired: 0, decayProgress: 0, generationKw: 0, receiverLoadKw: 0 },
      dysonSphere: { structurePoints: 0, totalRocketsLaunched: 0, shellSails: 0, totalSailsAbsorbed: 0, absorptionProgress: 0, generationKw: 0 },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openCompleteLogisticsGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 10,
      nextId: 9,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "logistics_wind", kind: "power", planetId: "home", position: { x: -420, y: -500 }, buildingId: "wind_turbine", machineCount: 10 },
        { ...entityBase, id: "local_supply", kind: "station", planetId: "home", position: { x: -380, y: -170 }, buildingId: "planetary_logistics_station", storedItemId: "iron_ingot", stationMode: "supply", stationProgress: 0.96, stationTrips: 0, stationLastTransfer: 0, stationDrones: 0, stationMinimumLoad: 0.5, outputs: { iron_ingot: 100 } },
        { ...entityBase, id: "local_demand", kind: "station", planetId: "home", position: { x: 10, y: -170 }, buildingId: "planetary_logistics_station", storedItemId: "iron_ingot", stationMode: "demand", stationProgress: 0.96, stationTrips: 0, stationLastTransfer: 0, stationDrones: 2, stationMinimumLoad: 0.5 },
        { ...entityBase, id: "hydrogen_demand", kind: "station", planetId: "home", position: { x: 400, y: -170 }, buildingId: "interstellar_logistics_station", storedItemId: "hydrogen", stationMode: "demand", stationProgress: 0.98, stationTrips: 0, stationLastTransfer: 0, stationVessels: 1, stationWarpers: 2, stationWarpEnabled: true, stationMinimumLoad: 0.1 },
        { ...entityBase, id: "sorter_storage", kind: "storage", planetId: "home", position: { x: -210, y: 240 }, buildingId: "storage_mk1", storedItemId: "iron_ore", outputs: { iron_ore: 20 } },
        { ...entityBase, id: "sorter_smelter", kind: "machine", planetId: "home", position: { x: 190, y: 240 }, buildingId: "arc_smelter", recipeId: "iron_ingot" },
        { ...entityBase, id: "ashen_station", kind: "station", planetId: "ashen", position: { x: 0, y: 0 }, buildingId: "interstellar_logistics_station", stationProgress: 0, stationTrips: 0, stationLastTransfer: 0, stationDrones: 0, stationVessels: 0, stationWarpers: 0 },
        { ...entityBase, id: "giant_collector", kind: "station", planetId: "giant", position: { x: 0, y: 0 }, buildingId: "orbital_collector", storedItemId: "hydrogen", stationMode: "supply", stationProgress: 0, stationTrips: 0, stationLastTransfer: 0, outputs: { hydrogen: 100 } },
      ],
      belts: [{ id: "sorter_demo", planetId: "home", source: "sorter_storage", target: "sorter_smelter", itemId: "iron_ore", lanes: 1, tier: 2, sorterTier: 1, progress: 0, priority: 0, lastFlow: 0 }],
      construction: { sorter_mk2: 1 },
      tray: { space_warper: 1, logistics_drone: 3, logistics_vessel: 2 },
      planetTrays: { home: { space_warper: 1, logistics_drone: 3, logistics_vessel: 2 }, ashen: {}, giant: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["planetary_logistics", "interstellar_logistics", "space_warp", "high_speed_logistics"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openCompleteEnergyGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
      powerInputKw: 0,
      powerOutputKw: 0,
    };
    const emptyMetrics = {
      generationKw: 0,
      demandKw: 0,
      powerFactor: 1,
      windGenerationKw: 0,
      solarGenerationKw: 0,
      geothermalGenerationKw: 0,
      thermalGenerationKw: 0,
      fusionGenerationKw: 0,
      artificialStarGenerationKw: 0,
      rayGenerationKw: 0,
      storageDischargeKw: 0,
      storageChargeKw: 0,
      storedEnergyMj: 0,
      storageCapacityMj: 0,
      fuelReserveSeconds: 0,
      totalItemsPerMinute: 0,
    };
    const homeMetrics = {
      ...emptyMetrics,
      generationKw: 88620,
      demandKw: 20000,
      solarGenerationKw: 720,
      fusionGenerationKw: 3324,
      artificialStarGenerationKw: 15956,
      storedEnergyMj: 45,
      storageCapacityMj: 180,
      fuelReserveSeconds: 61,
    };
    const state = {
      version: 11,
      nextId: 8,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "energy_solar", kind: "power", planetId: "home", position: { x: 320, y: -500 }, buildingId: "solar_panel", machineCount: 2, powerOutputKw: 720, utilization: 1 },
        { ...entityBase, id: "energy_accumulator", kind: "power", planetId: "home", position: { x: 680, y: -500 }, buildingId: "accumulator", storedEnergyMj: 45, energyMode: "auto", progress: 0.5 },
        { ...entityBase, id: "energy_exchanger", kind: "power", planetId: "home", position: { x: 1040, y: -500 }, buildingId: "energy_exchanger", recipeId: "accumulator_charge", energyMode: "charge", storedEnergyMj: 0, inputs: { accumulator: 1 } },
        { ...entityBase, id: "energy_fusion", kind: "power", planetId: "home", position: { x: 520, y: -100 }, buildingId: "mini_fusion_power_plant", fuelItemId: "deuteron_fuel_rod", fuelRemainingMj: 200, inputs: { deuteron_fuel_rod: 1 }, powerOutputKw: 3324, utilization: 0.2216 },
        { ...entityBase, id: "energy_star", kind: "power", planetId: "home", position: { x: 900, y: -100 }, buildingId: "artificial_star", fuelItemId: "antimatter_fuel_rod", fuelRemainingMj: 3600, inputs: { antimatter_fuel_rod: 1 }, powerOutputKw: 15956, utilization: 0.2216 },
        { ...entityBase, id: "ashen_solar", kind: "power", planetId: "ashen", position: { x: 520, y: -320 }, buildingId: "solar_panel", powerOutputKw: 540, utilization: 1 },
        { ...entityBase, id: "ashen_geothermal", kind: "power", planetId: "ashen", position: { x: 900, y: -320 }, buildingId: "geothermal_power_station", powerOutputKw: 4800, utilization: 1 },
      ],
      belts: [],
      construction: { solar_panel: 1, geothermal_power_station: 1, thermal_power_plant: 1, mini_fusion_power_plant: 1, artificial_star: 1, accumulator: 1, energy_exchanger: 1 },
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {} },
      totalProduced: {},
      metrics: homeMetrics,
      planetMetrics: {
        home: homeMetrics,
        ashen: { ...emptyMetrics, generationKw: 5340, solarGenerationKw: 540, geothermalGenerationKw: 4800 },
        giant: emptyMetrics,
      },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["solar_energy", "energy_storage", "geothermal_power", "miniature_particle_collider", "fusion_power", "antimatter", "artificial_star"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openRareResourceStageGame(page: Page) {
  await page.addInitScript(() => {
    const entityBase = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 12,
      nextId: 9,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "rare_wind", kind: "power", position: { x: 300, y: -620 }, buildingId: "wind_turbine", machineCount: 20, powerOutputKw: 6000 },
        { ...entityBase, id: "rare_fractionator", kind: "machine", position: { x: 300, y: -300 }, buildingId: "fractionator", recipeId: "deuterium_fractionation", inputs: { hydrogen: 20 } },
        { ...entityBase, id: "rare_chemical", kind: "machine", position: { x: 650, y: -300 }, buildingId: "chemical_plant", recipeId: "graphene_from_fire_ice", inputs: { fire_ice: 4 } },
        { ...entityBase, id: "rare_quantum", kind: "machine", position: { x: 1000, y: -300 }, buildingId: "quantum_chemical_plant", recipeId: "carbon_nanotube_from_spiniform", inputs: { spiniform_stalagmite_crystal: 12 } },
        { ...entityBase, id: "rare_smelter", kind: "machine", position: { x: 300, y: 90 }, buildingId: "arc_smelter", recipeId: "diamond_from_kimberlite", inputs: { kimberlite_ore: 2 } },
        { ...entityBase, id: "rare_assembler", kind: "machine", position: { x: 650, y: 90 }, buildingId: "assembling_machine_mk1", recipeId: "particle_container_from_unipolar", inputs: { unipolar_magnet: 20, copper_ingot: 4 } },
        { ...entityBase, id: "rare_thermal", kind: "power", position: { x: 1000, y: 90 }, buildingId: "thermal_power_plant", fuelItemId: "hydrogen_fuel_rod", fuelRemainingMj: 27, inputs: { hydrogen_fuel_rod: 2 }, powerInputKw: 0, powerOutputKw: 0 },
        { ...entityBase, id: "rare_collector", kind: "station", planetId: "giant", position: { x: 0, y: 0 }, buildingId: "orbital_collector", storedItemId: "fire_ice", stationMode: "supply", stationProgress: 0, stationTrips: 0, stationLastTransfer: 0, outputs: { fire_ice: 25 } },
      ],
      belts: [],
      construction: { quantum_chemical_plant: 1, fractionator: 1, conveyor_belt_mk1: 6 },
      tray: { hydrogen_fuel_rod: 2 },
      planetTrays: { home: { hydrogen_fuel_rod: 2 }, ashen: {}, giant: {} },
      totalProduced: { hydrogen_fuel_rod: 2, fire_ice: 25 },
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["fractionation", "nanomaterials", "quantum_chip", "interstellar_logistics", "rare_resource_utilization", "gravity_matrix", "quantum_chemical_engineering"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openStellarExplorationGame(page: Page, advancedOnboarding = false) {
  await page.addInitScript((withAdvancedOnboarding) => {
    const entityBase = {
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 13,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...entityBase, id: "stellar_home_wind", kind: "power", planetId: "home", position: { x: -300, y: -220 }, buildingId: "wind_turbine", machineCount: 4 },
        { ...entityBase, id: "stellar_demand", kind: "station", planetId: "home", position: { x: 160, y: -100 }, buildingId: "interstellar_logistics_station", storedItemId: "optical_grating_crystal", stationMode: "demand", stationProgress: 0.96, stationTrips: 0, stationLastTransfer: 0, stationVessels: 1, stationWarpers: 1, stationWarpEnabled: true, stationMinimumLoad: 0.1 },
        { ...entityBase, id: "stellar_frost_wind", kind: "power", planetId: "frost", position: { x: -300, y: -220 }, buildingId: "wind_turbine", machineCount: 4 },
        { ...entityBase, id: "stellar_supply", kind: "station", planetId: "frost", position: { x: 160, y: -100 }, buildingId: "interstellar_logistics_station", storedItemId: "optical_grating_crystal", stationMode: "supply", stationProgress: 0.96, stationTrips: 0, stationLastTransfer: 0, stationVessels: 0, stationWarpers: 0, stationWarpEnabled: true, stationMinimumLoad: 0.1, outputs: { optical_grating_crystal: 20 } },
        ...(withAdvancedOnboarding ? [
          { ...entityBase, id: "onboarding_iron", kind: "vein", planetId: "home", position: { x: -520, y: 220 }, resourceId: "iron_ore", minerCount: 1, outputs: { iron_ore: 0 } },
          { ...entityBase, id: "onboarding_smelter", kind: "machine", planetId: "home", position: { x: -160, y: 220 }, buildingId: "arc_smelter", recipeId: "iron_ingot" },
        ] : []),
      ],
      belts: withAdvancedOnboarding ? [{ id: "onboarding_belt", planetId: "home", source: "onboarding_iron", target: "onboarding_smelter", itemId: "iron_ore", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, lastFlow: 0 }] : [],
      construction: {},
      tray: { space_warper: 7, information_matrix: 10, gravity_matrix: 20, titanium_ingot: 12 },
      planetTrays: { home: { space_warper: 7, information_matrix: 10, gravity_matrix: 20, titanium_ingot: 12 }, ashen: {}, giant: {}, frost: {}, boreal_giant: {}, magnetar: {} },
      totalProduced: withAdvancedOnboarding ? { electromagnetic_matrix: 1, refined_oil: 1, plastic: 1, energy_matrix: 1, structure_matrix: 1 } : {},
      manualMined: withAdvancedOnboarding ? 1 : 0,
      research: {
        selectedTechId: withAdvancedOnboarding ? "electromagnetic_matrix" : null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["space_warp", "rare_resource_utilization", "stellar_exploration"],
      },
      exploration: { unlockedSystemIds: ["helios"] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
    if (withAdvancedOnboarding) {
      window.localStorage.setItem("dsp-idle-network.basic-onboarding.v1", JSON.stringify({
        version: 1,
        completedEvents: ["cargo-stowed", "construction-crafted", "building-placed", "building-stacked", "belt-connected", "research-selected"],
        skipped: false,
      }));
    }
  }, advancedOnboarding);
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openBlueprintStageGame(page: Page) {
  const entityBase = {
    planetId: "home",
    machineCount: 1,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  };
  const state = {
    version: 14,
    nextId: 4,
    activePlanetId: "home",
    entities: [
      { ...entityBase, id: "blueprint_source", kind: "machine", position: { x: -300, y: -120 }, buildingId: "assembling_machine_mk1", recipeId: "circuit_board", outputs: { circuit_board: 12 } },
      { ...entityBase, id: "blueprint_target", kind: "machine", position: { x: 80, y: -120 }, buildingId: "assembling_machine_mk1", recipeId: "processor" },
    ],
    belts: [{ id: "blueprint_line", planetId: "home", source: "blueprint_source", target: "blueprint_target", itemId: "circuit_board", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, lastFlow: 0 }],
    construction: { assembling_machine_mk1: 2, assembling_machine_mk2: 2, conveyor_belt_mk1: 1, conveyor_belt_mk2: 2 },
    tray: {},
    planetTrays: { home: {}, ashen: {}, giant: {}, frost: {}, boreal_giant: {}, magnetar: {} },
    totalProduced: {},
    research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["processor", "high_speed_assembling", "high_speed_logistics"] },
    exploration: { unlockedSystemIds: ["helios"] },
    blueprints: [],
    paused: true,
  };
  // This helper is reused several times in one browser context. IndexedDB is
  // authoritative after the first navigation, so persist the normalized legacy
  // fixture through the same verified path used by the game instead of relying
  // on a later localStorage init script.
  await page.goto("/?menu=1");
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.evaluate(async (legacyState) => {
    const storage = await import("/src/game/storage.ts");
    const normalized = storage.importGame(JSON.stringify({ savedAt: Date.now(), state: legacyState }));
    if (!normalized) throw new Error("failed to normalize blueprint fixture");
    const result = await storage.saveGameVerified(normalized);
    if (!result.success) throw new Error(result.message);
  }, state);
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
  await expect(page.locator(".machine-node")).toHaveCount(2);
}

async function openStressStageGame(page: Page) {
  await page.addInitScript(() => {
    const entities = Array.from({ length: 500 }, (_, index) => ({
      id: `stress_device_${index}`,
      kind: "storage",
      planetId: "home",
      position: { x: index % 25 * 280 - 700, y: Math.floor(index / 25) * 220 - 360 },
      buildingId: "storage_mk1",
      storedItemId: "iron_ingot",
      machineCount: 1,
      minerCount: 0,
      inputs: { iron_ingot: 0 },
      outputs: { iron_ingot: index % 2 === 0 ? 1_000 : 0 },
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    }));
    const belts = Array.from({ length: 1_000 }, (_, index) => ({
      id: `stress_belt_${index}`,
      planetId: "home",
      source: `stress_device_${index % 500}`,
      target: `stress_device_${(index + 1) % 500}`,
      itemId: "iron_ingot",
      lanes: 1,
      tier: 1,
      sorterTier: 1,
      progress: 0,
      priority: index % 2,
      lastFlow: 0,
    }));
    const state = {
      version: 18,
      nextId: 2_000,
      activePlanetId: "home",
      entities,
      belts,
      construction: { wind_turbine: 1 },
      tray: {},
      planetTrays: { home: {}, ashen: {}, giant: {}, frost: {}, boreal_giant: {}, magnetar: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      exploration: { unlockedSystemIds: ["helios"] },
      blueprints: [],
      paused: false,
      settings: { simulationSpeed: 1, performanceMode: true, reducedMotion: true, soundEnabled: false, autosaveIntervalSeconds: 300 },
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openOperationsStageGame(page: Page, route = "/") {
  await page.addInitScript(() => {
    const seedMarker = "dsp-idle-network.e2e.operations-stage-seeded.v1";
    if (window.sessionStorage.getItem(seedMarker) === "1") return;
    window.sessionStorage.setItem(seedMarker, "1");
    if (window.localStorage.getItem("dsp-idle-network.save.v1")) return;
    const state = {
      version: 16,
      nextId: 2,
      activePlanetId: "home",
      entities: [{
        id: "operations_iron",
        kind: "vein",
        planetId: "home",
        position: { x: -220, y: -80 },
        resourceId: "iron_ore",
        extractorBuildingId: "mining_machine",
        machineCount: 0,
        minerCount: 1,
        inputs: {},
        outputs: { iron_ore: 0 },
        progress: 0,
        routingCursor: 0,
        utilization: 0,
        productionRate: 0,
      }],
      belts: [],
      construction: {},
      tray: {},
      totalProduced: { electromagnetic_matrix: 1 },
      manualMined: 1,
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      exploration: { unlockedSystemIds: ["helios"] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now() + 60_000, state }));
  });
  await page.goto(route);
  if (new URL(route, "http://localhost").searchParams.get("menu") === "1") {
    await expect(page.locator(".start-menu")).toBeVisible();
  } else {
    await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
  }
}

async function openConstructionAutomationGame(page: Page) {
  await page.addInitScript(() => {
    const base = {
      planetId: "home",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
      powerGridId: "grid-a",
    };
    const state = {
      version: 26,
      nextId: 4,
      activePlanetId: "home",
      entities: [
        { ...base, id: "automation_wind", kind: "power", position: { x: -420, y: -220 }, buildingId: "wind_turbine", machineCount: 60 },
        { ...base, id: "automation_center", kind: "machine", position: { x: 0, y: -120 }, buildingId: "construction_center" },
        {
          ...base,
          id: "delivery_hub",
          kind: "storage",
          position: { x: 420, y: 100 },
          buildingId: "material_delivery_hub",
          deliveryItemIds: ["iron_ingot", "copper_ingot", "stone_brick"],
          inputs: { iron_ingot: 5, copper_ingot: 5, stone_brick: 5 },
        },
      ],
      belts: [],
      construction: { wind_turbine: 0, construction_center: 0, material_delivery_hub: 0, arc_smelter: 0 },
      tray: { iron_ingot: 8, stone_brick: 4, circuit_board: 8, magnetic_coil: 4 },
      planetTrays: { home: { iron_ingot: 8, stone_brick: 4, circuit_board: 8, magnetic_coil: 4 } },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["electromagnetic_matrix", "energy_matrix", "structure_matrix", "information_matrix", "construction_automation", "material_delivery_logistics"],
      },
      constructionAutomation: { enabled: true, targetStock: {}, cursor: 0, totalCrafted: 0, lastCraftedId: null },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home"] },
      paused: false,
      settings: { simulationSpeed: 1, performanceMode: false, reducedMotion: false, soundEnabled: false, autosaveIntervalSeconds: 300, fontScale: 1 },
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openCampaignEndgameStageGame(page: Page) {
  await page.addInitScript(() => {
    const completedTaskIds = [
      "mine_first_ore", "smelt_iron", "deploy_miner", "lay_first_belt", "deploy_matrix_lab", "produce_blue_matrix",
      "refine_oil", "produce_plastic", "produce_red_matrix", "deploy_planetary_station", "complete_planetary_trip",
      "produce_structure_matrix", "unlock_borealis", "deploy_interstellar_station", "complete_interstellar_trip",
      "produce_information_matrix", "produce_gravity_matrix", "produce_universe_matrix", "launch_solar_sail",
      "launch_carrier_rocket", "build_dyson_structure", "absorb_shell_sail", "side_storage", "side_stable_power",
      "side_belt_upgrade", "side_rare_resource", "side_spray_coater", "side_blueprint",
    ];
    const state = {
      version: 23,
      nextId: 1,
      activePlanetId: "home",
      entities: [],
      belts: [],
      construction: {},
      tray: { universe_matrix: 250 },
      planetTrays: { home: { universe_matrix: 250 } },
      totalProduced: { universe_matrix: 250 },
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["universe_matrix"] },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home", "ashen", "giant"], missions: [], surveyProgressBySystem: { helios: 1 } },
      campaign: { activeChapterId: "dyson_program", activeTaskId: "absorb_shell_sail", completedTaskIds, rewardedTaskIds: completedTaskIds },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openTitaniumRoutingGame(page: Page) {
  await page.addInitScript(() => {
    const base = { planetId: "home", machineCount: 1, minerCount: 0, inputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 };
    const state = {
      version: 23,
      nextId: 8,
      activePlanetId: "home",
      entities: [
        { ...base, id: "titanium_source", kind: "machine", position: { x: 650, y: -300 }, buildingId: "arc_smelter", recipeId: "titanium_ingot", outputs: { titanium_ingot: 20 } },
        { ...base, id: "steel_source", kind: "machine", position: { x: 650, y: 0 }, buildingId: "arc_smelter", recipeId: "steel", outputs: { steel: 20 } },
        { ...base, id: "acid_source", kind: "machine", position: { x: 650, y: 300 }, buildingId: "chemical_plant", recipeId: "sulfuric_acid", outputs: { sulfuric_acid: 20 } },
        { ...base, id: "alloy_target", kind: "machine", position: { x: 1100, y: 0 }, buildingId: "arc_smelter", recipeId: "titanium_alloy", outputs: {} },
        { ...base, id: "routing_wind", kind: "power", position: { x: 900, y: -360 }, buildingId: "wind_turbine", machineCount: 8, outputs: {} },
      ],
      belts: [],
      construction: { conveyor_belt_mk1: 3 },
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["automatic_metallurgy", "high_strength_crystal", "high_efficiency_plasma_control", "basic_chemical_engineering", "titanium_alloy"] },
      exploration: { unlockedSystemIds: ["helios"], colonizedPlanetIds: ["home", "ashen", "giant"], missions: [], surveyProgressBySystem: { helios: 1 } },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openMultiSlotStationRoutingGame(page: Page) {
  await page.addInitScript(() => {
    const slot = (itemId: string) => ({ itemId, localMode: "storage", remoteMode: "supply", minimumLoad: 1, minStock: 0, maxStock: 0, priority: 1 });
    const base = { planetId: "home", machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 };
    const state = {
      version: 23,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        {
          ...base,
          id: "multi_station",
          kind: "station",
          position: { x: 0, y: -120 },
          buildingId: "interstellar_logistics_station",
          storedItemId: "steel",
          stationSlots: [slot("steel"), slot("titanium_ingot"), slot("sulfuric_acid")],
          outputs: { steel: 20, titanium_ingot: 20, sulfuric_acid: 20 },
          stationVessels: 0,
          stationWarpers: 0,
          stationProgress: 0,
          stationTrips: 0,
        },
        { ...base, id: "multi_alloy", kind: "machine", position: { x: 420, y: -160 }, buildingId: "arc_smelter", recipeId: "titanium_alloy" },
        { ...base, id: "multi_chemical", kind: "machine", position: { x: 420, y: 180 }, buildingId: "chemical_plant", recipeId: "graphene" },
      ],
      belts: [],
      construction: { conveyor_belt_mk1: 3, conveyor_belt_mk2: 2, conveyor_belt_mk3: 1 },
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: {
        selectedTechId: null,
        queuedTechIds: [],
        progressByTech: {},
        completedTechIds: ["automatic_metallurgy", "high_strength_crystal", "basic_chemical_engineering", "energy_matrix", "nanomaterials", "titanium_alloy", "high_speed_logistics", "super_magnetic_logistics"],
      },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openEdgeOverlapGame(page: Page) {
  await page.addInitScript(() => {
    const base = { planetId: "home", machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 };
    const state = {
      version: 23,
      nextId: 5,
      activePlanetId: "home",
      entities: [
        { ...base, id: "overlap_source", kind: "machine", position: { x: 0, y: 0 }, buildingId: "arc_smelter", recipeId: "iron_ingot", outputs: { iron_ingot: 20 } },
        { ...base, id: "overlap_blocker", kind: "machine", position: { x: 380, y: 0 }, buildingId: "arc_smelter", recipeId: "copper_ingot" },
        { ...base, id: "overlap_target", kind: "machine", position: { x: 760, y: 0 }, buildingId: "assembling_machine_mk1", recipeId: "gear" },
      ],
      belts: [{ id: "overlap_belt", planetId: "home", source: "overlap_source", target: "overlap_target", itemId: "iron_ingot", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, stackSize: 1, monitorEnabled: false, totalTransferred: 0, congestion: 0, lastFlow: 0 }],
      construction: {},
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["automatic_metallurgy", "basic_assembling"] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openBeltNetworkGame(page: Page) {
  const base = { planetId: "home", machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 };
  const storageEntity = (id: string, x: number, outputs: Record<string, number> = {}) => ({
    ...base,
    id,
    kind: "storage",
    position: { x, y: 0 },
    buildingId: "storage_mk1",
    storedItemId: "iron_ingot",
    outputs,
  });
  const belt = (id: string, source: string, target: string) => ({
    id,
    planetId: "home",
    source,
    target,
    itemId: "iron_ingot",
    lanes: 1,
    tier: 1,
    sorterTier: 1,
    progress: 0,
    priority: 0,
    stackSize: 1,
    monitorEnabled: false,
    totalTransferred: 0,
    congestion: 0,
    lastFlow: 0,
    routeMode: "auto",
  });
  const state = {
    version: 23,
    nextId: 8,
    activePlanetId: "home",
    entities: [
      storageEntity("network_source", -420, { iron_ingot: 40 }),
      storageEntity("network_buffer", 0, { iron_ingot: 10 }),
      storageEntity("network_sink", 420),
      { ...base, id: "network_unrelated", kind: "power", position: { x: 0, y: 360 }, buildingId: "wind_turbine", powerOutputKw: 0 },
    ],
    belts: [belt("network_belt_1", "network_source", "network_buffer"), belt("network_belt_2", "network_buffer", "network_sink")],
    construction: { conveyor_belt_mk1: 0 },
    tray: {},
    planetTrays: { home: {} },
    totalProduced: {},
    research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["basic_logistics"] },
    paused: true,
  };
  await page.goto("/?menu=1");
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.evaluate(async (legacyState) => {
    const storage = await import("/src/game/storage.ts");
    const normalized = storage.importGame(JSON.stringify({ savedAt: Date.now(), state: legacyState }));
    if (!normalized) throw new Error("failed to normalize belt network fixture");
    const result = await storage.saveGameVerified(normalized);
    if (!result.success) throw new Error(result.message);
  }, state);
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}

async function openOfflineStageGame(page: Page) {
  await page.addInitScript(() => {
    const base = {
      planetId: "home",
      inputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    };
    const state = {
      version: 16,
      nextId: 3,
      activePlanetId: "home",
      entities: [
        { ...base, id: "offline_iron", kind: "vein", position: { x: -220, y: -80 }, resourceId: "iron_ore", extractorBuildingId: "mining_machine", machineCount: 0, minerCount: 1, outputs: { iron_ore: 0 } },
        { ...base, id: "offline_wind", kind: "power", position: { x: 120, y: -80 }, buildingId: "wind_turbine", machineCount: 3, minerCount: 0, outputs: {}, powerOutputKw: 0 },
      ],
      belts: [],
      construction: {},
      tray: {},
      totalProduced: {},
      manualMined: 0,
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      exploration: { unlockedSystemIds: ["helios"] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now() - 6_000, state }));
  });
  await page.goto("/");
  await expect(page.getByText("DSP极简网络", { exact: true })).toBeVisible();
}


test("start menu gates simulation and exposes saves, cloud, import and settings", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const presenceIds: string[] = [];
  await page.route("**/api/presence", async (route) => {
    const body = route.request().postDataJSON() as { playerId?: string };
    if (body.playerId) presenceIds.push(body.playerId);
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true }) });
  });
  await page.goto("/?menu=1");

  await expect(page.locator(".start-menu")).toBeVisible();
  await expect(page.getByRole("heading", { name: "DSP极简网络" })).toBeVisible();
  await expect(page.getByRole("button", { name: /开始游戏/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "加载存档" })).toBeVisible();
  await expect(page.getByRole("button", { name: "登录与云存档" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导入存档" })).toBeVisible();
  await expect(page.locator(".start-menu-project-note")).toContainText("本项目为免费个人作品，仅供交流与学习使用");
  await expect(page.locator(".start-menu-project-note")).toContainText("购买并游玩《戴森球计划》");
  await expect(page.locator(".start-menu-project-note")).toContainText("匿名标识统计游玩与在线人数");
  await expect(page.locator(".start-menu-project-note")).toContainText("1076757280");
  await expect(page.locator(".game-shell")).toHaveCount(0);
  expect(presenceIds).toHaveLength(0);
  await page.screenshot({ path: "artifacts/qa/player-presence-notice-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.locator(".start-menu-project-note").scrollIntoViewIfNeeded();
  await expect(page.locator(".start-menu-project-note")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/player-presence-notice-390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "游戏设置" }).click();
  await expect(page.locator(".start-menu-settings")).toBeVisible();
  await expect(page.locator(".start-menu-community")).toContainText("1076757280");
  await page.locator(".start-menu-settings").getByRole("button", { name: "125%" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-font-scale"))).toBe("1.25");

  await page.getByRole("button", { name: /开始游戏/ }).click();
  await expect(page.locator(".game-shell")).toBeVisible();
  await expect(page.locator(".vein-node").filter({ hasText: "铁矿石" })).toBeVisible();
  await expect.poll(() => presenceIds.length).toBe(1);
  expect(presenceIds[0]).toMatch(/^player_[A-Za-z0-9_-]{16,}$/);

  await page.getByTitle("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  await expect(page.getByRole("button", { name: /继续游戏/ })).toBeVisible();
  await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(page.locator(".game-shell")).toBeVisible({ timeout: 15_000 });
  expect(presenceIds).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.player-id.v1"))).toBe(presenceIds[0]);
});

test("cancelling long offline advancement returns to the menu and preserves the pending interval", async ({ page }) => {
  const state = createInitialState(44_094);
  state.paused = false;
  const raw = serializeEnvelope(state, Date.now() - 7 * 24 * 60 * 60 * 1_000);
  await page.addInitScript(({ saveRaw }) => {
    window.localStorage.setItem("dsp-idle-network.save.v1", saveRaw);
  }, { saveRaw: raw });
  await page.goto("/?menu=1");
  const original = await page.evaluate(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    if (!raw) throw new Error("missing offline save");
    const state = (JSON.parse(raw) as { state: { elapsedSeconds?: number; totalProduced?: Record<string, number> } }).state;
    return { elapsedSeconds: state.elapsedSeconds ?? 0, totalProduced: state.totalProduced ?? {} };
  });
  await expect.poll(() => page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.initializeLocalSaveStore();
    await store.reloadLocalSaveCache();
    return store.getPrimaryLocalSaveRecoveryIdentity("normal") !== null;
  }), { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => {
    class HangingOfflineWorker extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage() { /* wait until the user cancels */ }
      terminate() { /* no process was spawned */ }
    }
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        if (String(args[0]).includes("offlineSimulation.worker")) {
          return new HangingOfflineWorker() as unknown as Worker;
        }
        return Reflect.construct(target, args) as Worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  });
  await page.getByRole("button", { name: /继续游戏/ }).click();
  const choice = page.getByRole("dialog", { name: "选择离线结算方式" });
  await expect(choice).toBeVisible();
  await choice.getByRole("button", { name: /精确结算/ }).click();
  const progress = page.getByRole("dialog", { name: "正在进行离线运算" });
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("完成并验证后才会一次性保存");
  await progress.getByRole("button", { name: "取消计算并返回" }).click();
  await expect(progress).toHaveCount(0);
  await expect(page.locator(".start-menu")).toBeVisible();
  await expect(page.locator(".game-shell")).toHaveCount(0);
  await expect(page.getByText(/原存档、savedAt 和离线时长均未修改/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const raw = window.localStorage.getItem("dsp-idle-network.save.v1");
    if (!raw) return null;
    const state = (JSON.parse(raw) as { state: { elapsedSeconds?: number; totalProduced?: Record<string, number> } }).state;
    return { elapsedSeconds: state.elapsedSeconds ?? 0, totalProduced: state.totalProduced ?? {} };
  })).toEqual(original);
  await page.getByRole("button", { name: /继续游戏/ }).click();
  await expect(choice).toBeVisible();
  await choice.getByRole("button", { name: /精确结算/ }).click();
  await expect(progress).toContainText("604,800 模拟秒");
  await progress.getByRole("button", { name: "取消计算并返回" }).click();
  await expect(page.locator(".start-menu")).toBeVisible();
});

test("dated release notes appear once and remain available from both settings screens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1&releaseNotesTest=1");

  const releaseNotes = page.locator(".release-notes-dialog");
  await expect(releaseNotes).toBeVisible();
  await expect(releaseNotes).toHaveAttribute("aria-label", "纯挂机连续运行、无回档恢复与蓝图布局修复");
  await expect(releaseNotes.locator(".release-notes-version strong")).toHaveText("1.2.5");
  await expect(releaseNotes.locator(".release-notes-scroll li")).toHaveCount(6);
  await expect(releaseNotes).toContainText("守恒纯挂机改为终局产出独立边界");
  await expect(releaseNotes).toContainText("产率复制挂机也会推进建筑制造");
  await expect(releaseNotes).toContainText("模拟 Worker 故障可原地恢复");
  await expect(releaseNotes).toContainText("后台保护不再自动把存档回退");
  await expect(releaseNotes).toContainText("存档与服务器格式保持兼容");

  await releaseNotes.getByRole("button", { name: "查看历史版本" }).click();
  const releaseHistory = releaseNotes.getByRole("navigation", { name: "版本列表" });
  await expect(releaseHistory).toBeVisible();
  await releaseNotes.getByRole("button", { name: "下一页版本" }).click();
  await releaseNotes.getByRole("button", { name: "下一页版本" }).click();
  await releaseNotes.getByRole("button", { name: "下一页版本" }).click();
  await releaseNotes.getByRole("button", { name: "下一页版本" }).click();
  await releaseNotes.getByRole("button", { name: "下一页版本" }).click();
  await releaseHistory.getByRole("button", { name: /1\.0\.42 · 界面适配、存档恢复与规则更新/ }).click();
  await expect(releaseNotes).toHaveAttribute("aria-label", "界面适配、存档恢复与规则更新");
  await expect(releaseNotes.locator(".release-notes-version strong")).toHaveText("1.0.42");
  await expect(releaseNotes.locator(".release-notes-scroll li")).toHaveCount(10);
  await expect(releaseNotes).toContainText("工作区跟随真实顶栏与托盘");
  await expect(releaseNotes).toContainText("手机命令跳转一次完成");
  await expect(releaseNotes).toContainText("背景失活与焦点边界统一");
  await expect(releaseNotes).toContainText("窄屏、高字号和触控操作收口");
  await expect(releaseNotes).toContainText("中文输入与页面草稿更稳定");
  await expect(releaseNotes).toContainText("版本信息与回归夹具一致");
  await expect(releaseNotes).toContainText("35 MiB 首存不再误判跨标签冲突");
  await expect(releaseNotes).toContainText("未提交时间扭曲预算可安全恢复");
  await expect(releaseNotes).toContainText("增产剂缓存上限扩展");
  await expect(releaseNotes).toContainText("无限矿物速通可进入正式榜");
  await page.screenshot({ path: "artifacts/qa/release-notes-2026-08-14-v142-history-1440.png", fullPage: true });
  await releaseNotes.getByRole("button", { name: "查看历史版本" }).click();
  await releaseNotes.getByRole("button", { name: "返回当前版本" }).click();
  await expect(releaseNotes).toHaveAttribute("aria-label", "纯挂机连续运行、无回档恢复与蓝图布局修复");
  await expect(releaseNotes.locator(".release-notes-version strong")).toHaveText("1.2.5");
  await expect(releaseNotes.locator(".release-notes-scroll li")).toHaveCount(6);
  await page.screenshot({ path: "artifacts/qa/release-notes-2026-08-27-v123-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await releaseNotes.locator(".release-notes-scroll li").last().scrollIntoViewIfNeeded();
  await expect.poll(async () => releaseNotes.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/release-notes-2026-08-27-v123-390.png", fullPage: true });

  await page.setViewportSize({ width: 360, height: 480 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await releaseNotes.locator(".release-notes-scroll").evaluate((element) => { element.scrollTop = 0; });
  const controlsFitViewport = async () => releaseNotes.evaluate((dialog) => {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const close = dialog.querySelector<HTMLButtonElement>(".release-notes-header > button")?.getBoundingClientRect();
    const confirm = dialog.querySelector<HTMLButtonElement>(".release-notes-footer > button")?.getBoundingClientRect();
    return Boolean(close && confirm && close.top >= 0 && close.bottom <= viewportHeight && confirm.top >= 0 && confirm.bottom <= viewportHeight);
  });
  await expect.poll(controlsFitViewport).toBe(true);
  await expect.poll(() => releaseNotes.evaluate((dialog) => {
    const scroll = dialog.querySelector<HTMLElement>(".release-notes-scroll")?.getBoundingClientRect();
    const summary = dialog.querySelector<HTMLElement>(".release-notes-summary")?.getBoundingClientRect();
    const firstItem = dialog.querySelector<HTMLElement>(".release-notes-scroll li")?.getBoundingClientRect();
    const footer = dialog.querySelector<HTMLElement>(".release-notes-footer")?.getBoundingClientRect();
    return Boolean(scroll && summary && firstItem && footer && summary.bottom <= firstItem.top + 1 && scroll.bottom <= footer.top + 1);
  })).toBe(true);
  await expect.poll(() => releaseNotes.locator(".release-notes-scroll").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/release-notes-2026-08-27-v123-360x480-font200.png", fullPage: true });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await releaseNotes.getByRole("button", { name: "我知道了" }).click();
  await expect(releaseNotes).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.release-notes.seen.v1"))).toBe("2026-08-30-v1.2.5");
  await page.reload();
  await expect(releaseNotes).toHaveCount(0);

  await page.getByRole("button", { name: "游戏设置" }).click();
  await page.getByRole("button", { name: "查看2026年8月30日版本更新记录" }).click();
  await expect(releaseNotes).toBeVisible();
  await expect(releaseNotes).toHaveAttribute("aria-label", "纯挂机连续运行、无回档恢复与蓝图布局修复");
  await expect(releaseNotes.locator(".release-notes-version strong")).toHaveText("1.2.5");
  await expect(releaseNotes.locator(".release-notes-scroll li")).toHaveCount(6);
  await releaseNotes.getByLabel("关闭版本更新记录").click();

  await page.locator(".start-menu-primary").click();
  await page.getByTitle("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".settings-category-overview").getByRole("button", { name: /教程、版本与其他/ }).click();
  await expect(operations.getByRole("button", { name: "查看版本更新记录" })).toBeVisible();
  await operations.getByRole("button", { name: "查看版本更新记录" }).click();
  await expect(releaseNotes).toBeVisible();
  await expect(releaseNotes).toHaveAttribute("aria-label", "纯挂机连续运行、无回档恢复与蓝图布局修复");
  await expect(releaseNotes.locator(".release-notes-version strong")).toHaveText("1.2.5");
  await expect(releaseNotes.locator(".release-notes-scroll li")).toHaveCount(6);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => releaseNotes.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/release-notes-2026-08-27-v123-844x390.png", fullPage: true });
  await releaseNotes.getByLabel("关闭版本更新记录").click();
  await expect(operations).toBeVisible();
});

test("protected operations dashboard renders visit, event and service metrics", async ({ page }) => {
  const generatedAt = Date.now();
  await page.route("**/api/admin/metrics?*", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer admin-test-token");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt,
        timeZone: "Asia/Shanghai",
        schemaVersion: 4,
        uptimeSeconds: 7200,
        storage: "sqlite",
        runtime: { requests: 320, errors: 0, rateLimited: 2, cloudConflicts: 1, p50LatencyMs: 4.2, p95LatencyMs: 18.6 },
        accounts: { users: 12, activeSessions: 4, cloudSaves: 9, submissions: 3 },
        players: { total: 48, today: 7, online: 2, onlineWindowSeconds: 120 },
        analytics: {
          today: "2026-07-22",
          totalVisitors: 56,
          retainedSessions: 20,
          range: { days: 7, uniqueVisitors: 20, sessions: 28, pageViews: 44, gameStarts: 19, activeSeconds: 14400 },
          lifetime: { uniqueVisitors: 56, sessions: 81, pageViews: 130, gameStarts: 48, activeSeconds: 58000 },
          events: [{ name: "page_view", count: 44 }, { name: "game_enter", count: 19 }, { name: "open_technology", count: 8 }],
          performance: {
            pageLoad: { samples: 20, fast: 11, acceptable: 6, slow: 2, verySlow: 1, p75Band: "1.5-3 秒" },
            lcp: { samples: 18, good: 12, needsImprovement: 4, poor: 2, p75Band: "2.5-4 秒" },
            transfer: { samples: 20, light: 14, medium: 5, heavy: 1, p75Band: "1-3 MB" },
          },
          daily: [
            { day: "2026-07-21", uniqueVisitors: 9, sessions: 12, pageViews: 20, gameStarts: 8, activeSeconds: 6000, events: {}, clients: { "desktop-web": 8 }, sources: { direct: 12 } },
            { day: "2026-07-22", uniqueVisitors: 11, sessions: 16, pageViews: 24, gameStarts: 11, activeSeconds: 8400, events: {}, clients: { "mobile-web": 9 }, sources: { community: 7 } },
          ],
        },
        reports: { feedback: 4, clientErrors: 1 },
        audit: { entries: 2, recent: [{ action: "account.password_changed", occurredAt: generatedAt - 500, clientType: "desktop-web" }] },
        backups: {
          configured: true,
          lastSuccessAt: generatedAt - 1000,
          lastErrorAt: null,
          state: "ready",
          dailyWindow: "02:00-03:00",
          offsite: { configured: true, ok: true, state: "ready", completedAt: generatedAt - 2000, transported: true, transport: "scp" },
          restoreDrill: { configured: true, ok: true, state: "ready", completedAt: generatedAt - 3000 },
        },
        infrastructure: {
          configured: true,
          ok: true,
          state: "ready",
          checkedAt: generatedAt - 500,
          endpoints: [{ url: "https://dsponline.cn/api/health", ok: true, status: 200, latencyMs: 18, contentEncoding: "gzip" }],
          disk: { ok: true, freeBytes: 20 * 1024 ** 3, totalBytes: 40 * 1024 ** 3, freeRatio: 0.5 },
          tls: { configured: true, ok: true, expiresAt: generatedAt + 60 * 86400000, daysRemaining: 60 },
        },
        governance: {
          sqlite: { layoutVersion: 2, databaseBytes: 2 * 1024 ** 3, walBytes: 4 * 1024 ** 2, appStateBytes: 512 * 1024, cloudPayloadBytes: 1.5 * 1024 ** 3, cloudPayloadRows: 120, averageRevisionsPerAccount: 10 },
          historyPrune: { runs: 2, payloadsRemoved: 9, metadataRemoved: 9, lastRunAt: generatedAt - 5000 },
          disk: { warning80Percent: false, protection90Percent: false },
        },
        daily: [],
      }),
    });
  });
  await page.setViewportSize({ width: 1366, height: 820 });
  await page.goto("/admin");
  await expect(page.getByText("运营数据后台", { exact: true })).toBeVisible();
  await page.getByLabel("管理员凭据").fill("admin-test-token");
  await page.getByRole("button", { name: "进入后台" }).click();
  await expect(page.getByText("今日访客 UV")).toBeVisible();
  await expect(page.locator(".admin-kpi-grid")).toContainText("11");
  await expect(page.locator(".admin-kpi-grid")).toContainText("24");
  await expect(page.locator(".admin-events-panel")).toContainText("打开科技树");
  await expect(page.locator(".admin-service-panel")).toContainText("12");
  await expect(page.locator(".admin-service-panel")).toContainText("异地加密备份");
  await expect(page.locator(".admin-service-panel")).toContainText("20.0 GB · 50%");
  await expect(page.locator(".admin-performance-panel")).toContainText("页面加载 P75");
  await expect(page.locator(".admin-performance-panel")).toContainText("1.5-3 秒");
  await expect(page.locator(".admin-audit-panel")).toContainText("修改密码");
  await expect(page.locator(".admin-governance-panel")).toContainText("2.00 GiB");
  await expect(page.locator(".admin-account-panel")).toContainText("精确账号 ID");
  await page.screenshot({ path: "artifacts/qa/admin-dashboard-1366.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".admin-kpi-grid")).toBeVisible();
  const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasOverflow).toBe(false);
  await page.screenshot({ path: "artifacts/qa/admin-dashboard-390.png", fullPage: true });
});

test("anonymous analytics batches an allowlisted page view without save data", async ({ page }) => {
  const batches: Array<Record<string, unknown>> = [];
  await page.route("**/api/analytics", async (route) => {
    batches.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true, duplicate: false, day: "2026-07-22" }) });
  });
  await page.goto("/");
  await expect.poll(() => batches.length).toBeGreaterThan(0);
  const batch = batches[0] as { playerId: string; sessionId: string; events: Array<{ name: string; count: number }> };
  expect(batch.playerId).toMatch(/^player_[A-Za-z0-9_-]+$/);
  expect(batch.sessionId).toMatch(/^session_[a-z0-9]+$/);
  expect(batch.events).toContainEqual({ name: "page_view", count: 1 });
  expect(JSON.stringify(batch)).not.toContain("entities");
  expect(JSON.stringify(batch)).not.toContain("inventory");
});

test("cloud account security exposes verification, password and device controls", async ({ page }) => {
  const requests: string[] = [];
  let user = {
    id: "user_e2e",
    username: "pilot_e2e",
    email: "pilot@example.com",
    displayName: "测试工程师",
    createdAt: Date.now() - 1000,
    emailVerified: false,
    emailVerifiedAt: null,
    passwordChangedAt: Date.now() - 1000,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${pathname}`);
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, mailProvider: "custom" });
    if (pathname === "/api/auth/login") return fulfill({ token: "e2e-cloud-token", user });
    if (pathname === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: null });
    if (pathname === "/api/account/sessions") return fulfill({ sessions: [
      { id: "session_current", deviceName: "Chrome 桌面浏览器", clientType: "desktop-web", createdAt: Date.now() - 1000, lastSeenAt: Date.now(), expiresAt: Date.now() + 100000, current: true },
      { id: "session_mobile", deviceName: "测试手机", clientType: "mobile-web", createdAt: Date.now() - 2000, lastSeenAt: Date.now() - 500, expiresAt: Date.now() + 100000, current: false },
    ] });
    if (pathname === "/api/account/security-events") return fulfill({ events: [
      { deviceHash: "1234567890abcdef", regionHash: "fedcba0987654321", occurredAt: Date.now(), clientType: "desktop-web" },
    ] });
    if (pathname === "/api/auth/resend-verification") return fulfill({ sent: true }, 202);
    if (pathname === "/api/account/email") {
      const body = request.postDataJSON() as { email: string };
      user = { ...user, email: body.email, emailVerified: false, emailVerifiedAt: null };
      return fulfill({ sent: true, user }, 202);
    }
    if (pathname === "/api/account/password") return fulfill({ changed: true, user: { ...user, passwordChangedAt: Date.now() } });
    if (pathname === "/api/account/sessions/revoke") return fulfill({ revoked: true, currentSessionRevoked: false });
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();
  await page.getByLabel("用户名或邮箱").fill("pilot@example.com");
  await page.getByLabel("密码", { exact: true }).fill("strong-pass-123");
  await page.getByRole("button", { name: "登录云账户" }).click();

  const security = page.getByRole("region", { name: "云账号安全" });
  await expect(security).toBeVisible();
  await expect(security).toContainText("邮箱等待验证");
  await security.getByRole("button", { name: "重发" }).click();
  await expect(security).toContainText("验证邮件已发送");
  await expect(security).toContainText("Chrome 桌面浏览器");
  await expect(security).toContainText("测试手机");
  await security.getByText("最近登录安全记录", { exact: true }).click();
  await expect(security).toContainText("设备 123456");
  await expect(page.getByRole("region", { name: "按模式管理云存档" }).locator("article")).toHaveCount(3);

  await security.getByText("更换待验证邮箱", { exact: true }).click();
  await security.getByLabel("邮箱地址").fill("new-pilot@example.com");
  await security.getByRole("button", { name: "绑定并发送验证邮件" }).click();
  await expect(security).toContainText("new-pilot@example.com");
  expect(requests).toContain("POST /api/account/email");

  await security.getByText("修改密码", { exact: true }).click();
  await security.getByLabel("当前密码").fill("strong-pass-123");
  await security.getByLabel("新密码", { exact: true }).fill("changed-pass-456");
  await security.getByLabel("确认新密码").fill("changed-pass-456");
  await security.getByRole("button", { name: "确认修改" }).click();
  await expect(security).toContainText("密码已修改");
  expect(requests).toContain("POST /api/auth/resend-verification");
  expect(requests).toContain("POST /api/account/password");

  await page.screenshot({ path: "artifacts/qa/cloud-account-security-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await security.scrollIntoViewIfNeeded();
  await expect.poll(async () => security.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/cloud-account-security-390.png", fullPage: true });
});

test("cloud save divergence requires an explicit keep-local or use-cloud choice", async ({ page }) => {
  const user = {
    id: "user_conflict",
    username: "conflict_pilot",
    email: "conflict@example.com",
    displayName: "冲突测试工程师",
    createdAt: Date.now() - 1000,
    emailVerified: true,
    emailVerifiedAt: Date.now() - 900,
    passwordChangedAt: Date.now() - 1000,
  };
  const remoteSummary = {
    stateVersion: 24,
    savedAt: Date.now() - 5000,
    elapsedSeconds: 7200,
    activePlanetId: "ashen",
    entityCount: 42,
    completedTechCount: 12,
    structurePoints: 0,
    uploadedWhiteMatrix: 0,
    stateChecksum: "remote-state",
  };
  let cloudSave = { revision: 2, updatedAt: Date.now() - 5000, size: 2048, checksum: "remote-cloud", summary: remoteSummary };
  let overwriteExpectedRevision: number | null = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true });
    if (pathname === "/api/auth/login") return fulfill({ token: "conflict-cloud-token", user });
    if (pathname === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave });
    if (pathname === "/api/account/sessions") return fulfill({ sessions: [] });
    if (pathname === "/api/cloud-save" && request.method() === "PUT") {
      const contentType = request.headers()["content-type"]?.split(";", 1)[0];
      const directPayload = contentType === "application/vnd.dspidle.save+json";
      const legacyBody = directPayload ? null : request.postDataJSON() as { payload: string; expectedRevision: number };
      const uploadedPayload = directPayload ? request.postData() ?? "" : legacyBody!.payload;
      overwriteExpectedRevision = directPayload
        ? Number(request.headers()["x-dsp-expected-revision"])
        : legacyBody!.expectedRevision;
      const envelope = JSON.parse(uploadedPayload) as { checksum?: string; savedAt?: number; state?: { elapsedSeconds?: number; entities?: unknown[]; research?: { completedTechIds?: unknown[] } } };
      cloudSave = {
        revision: 3,
        updatedAt: Date.now(),
        size: uploadedPayload.length,
        checksum: "local-cloud",
        summary: {
          ...remoteSummary,
          savedAt: envelope.savedAt ?? Date.now(),
          elapsedSeconds: envelope.state?.elapsedSeconds ?? 0,
          entityCount: envelope.state?.entities?.length ?? 0,
          completedTechCount: envelope.state?.research?.completedTechIds?.length ?? 0,
          stateChecksum: envelope.checksum ?? null,
        },
      };
      return fulfill({ cloudSave });
    }
    return fulfill({ accepted: true });
  });

  await page.goto("/?menu=1");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  await page.getByTitle("保存并返回主菜单").click();
  await page.getByRole("button", { name: "登录与云存档" }).click();
  await expect(page.getByRole("button", { name: "注册", exact: true })).toBeEnabled();
  await page.getByLabel("用户名或邮箱").fill("conflict@example.com");
  await page.getByLabel("密码", { exact: true }).fill("strong-pass-123");
  await page.getByRole("button", { name: "登录云账户" }).click();
  await expect(page.getByText("需要选择保留版本", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "上传本地存档" }).click();
  const dialog = page.getByRole("alertdialog", { name: /本地与云端都有不同进度/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("当前本地工厂");
  await expect(dialog).toContainText("云端工厂");
  await expect(dialog).toContainText("普通模式 · 主存档");
  await expect(dialog.getByRole("button", { name: "导出本地副本" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "导出云端副本" })).toBeVisible();
  await expect(dialog).toContainText("42");
  await dialog.getByRole("button", { name: "保留本地并新建云修订" }).click();
  await expect(dialog).toHaveCount(0);
  expect(overwriteExpectedRevision).toBe(2);
  await expect(page.locator(".start-menu-message")).toContainText("修订 3");
});

test("cloud upload can abandon offline settlement and continue with the saved factory", async ({ page }) => {
  const user = {
    id: "user_upload_skip_offline",
    username: "upload_skip_offline",
    email: "upload-skip@example.com",
    displayName: "上传取消离线测试",
    createdAt: Date.now() - 1000,
    emailVerified: true,
    emailVerifiedAt: Date.now() - 900,
    passwordChangedAt: Date.now() - 1000,
  };
  let uploadedPayload: string | null = null;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7 });
    if (pathname === "/api/auth/login") return fulfill({ token: "upload-skip-token", user });
    if (pathname === "/api/account" && request.method() === "GET") return fulfill({ user, cloudSave: null, cloudSaves: { main: null, "1": null, "2": null, "3": null } });
    if (pathname === "/api/account/sessions") return fulfill({ sessions: [] });
    if (pathname === "/api/cloud-save" && request.method() === "PUT") {
      const contentType = request.headers()["content-type"]?.split(";", 1)[0];
      const directPayload = contentType === "application/vnd.dspidle.save+json";
      const legacyBody = directPayload ? null : request.postDataJSON() as { payload: string };
      uploadedPayload = directPayload ? request.postData() ?? "" : legacyBody!.payload;
      const envelope = JSON.parse(uploadedPayload) as { checksum?: string; savedAt?: number; state?: { elapsedSeconds?: number; entities?: unknown[]; research?: { completedTechIds?: unknown[] } } };
      return fulfill({ cloudSave: {
        revision: 1,
        updatedAt: Date.now(),
        size: uploadedPayload.length,
        checksum: envelope.checksum ?? "upload-skip-checksum",
        summary: {
          stateVersion: 46,
          savedAt: envelope.savedAt ?? Date.now(),
          elapsedSeconds: envelope.state?.elapsedSeconds ?? 0,
          activePlanetId: "home",
          entityCount: envelope.state?.entities?.length ?? 0,
          completedTechCount: envelope.state?.research?.completedTechIds?.length ?? 0,
          structurePoints: 0,
          uploadedWhiteMatrix: 0,
          stateChecksum: envelope.checksum ?? null,
        },
      } });
    }
    return fulfill({ accepted: true });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "CompressionStream", { configurable: true, value: undefined });
    const entities = Array.from({ length: 500 }, (_, index) => ({
      id: `upload_skip_${index}`,
      kind: "storage",
      planetId: "home",
      position: { x: index % 25 * 260, y: Math.floor(index / 25) * 190 },
      buildingId: "storage_mk1",
      storedItemId: "iron_ingot",
      machineCount: 1,
      minerCount: 0,
      inputs: {},
      outputs: { iron_ingot: index % 3 },
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    }));
    const state = {
      version: 31,
      nextId: 501,
      activePlanetId: "home",
      entities,
      belts: [],
      construction: {},
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, pausedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: [] },
      paused: false,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now() - 7 * 24 * 60 * 60 * 1_000, state }));
  });

  await page.goto("/?menu=1");
  await page.getByRole("button", { name: "登录与云存档" }).click();
  await page.getByLabel("用户名或邮箱").fill("upload-skip@example.com");
  await page.getByLabel("密码", { exact: true }).fill("strong-pass-123");
  await page.getByRole("button", { name: "登录云账户" }).click();
  await page.getByRole("button", { name: "上传本地存档" }).click();
  const skipButton = page.getByRole("button", { name: "跳过离线并继续上传" });
  await expect(skipButton).toBeVisible();
  await skipButton.click();
  await expect(page.locator(".start-menu-message")).toContainText("云存档已更新到修订 1", { timeout: 30_000 });
  expect(uploadedPayload).not.toBeNull();
  const uploaded = JSON.parse(uploadedPayload!) as { state?: { elapsedSeconds?: number; totalProduced?: Record<string, number> } };
  expect(uploaded.state?.elapsedSeconds).toBe(0);
  expect(uploaded.state?.totalProduced).toEqual({});
});

test("username registration and login preserve every local save without automatic cloud restore", async ({ page }) => {
  const user = {
    id: "user_local_save_guard",
    username: "local_save_guard",
    email: "",
    displayName: "本地存档守护测试",
    createdAt: Date.now(),
    emailVerified: false,
    emailVerifiedAt: null,
    passwordChangedAt: Date.now(),
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7, mailProvider: "disabled" });
    if (pathname === "/api/auth/register") return fulfill({ token: "local-save-register-token", user, mailAvailable: false }, 201);
    if (pathname === "/api/auth/login") return fulfill({ token: "local-save-login-token", user });
    if (pathname === "/api/auth/logout") return fulfill({ ok: true });
    if (pathname === "/api/account") return fulfill({ user, cloudSave: null, cloudSaves: { main: null, "1": null, "2": null, "3": null } });
    if (pathname === "/api/account/sessions") return fulfill({ sessions: [] });
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });

  await page.goto("/?menu=1");
  await page.getByRole("button", { name: /开始游戏/ }).click();
  await page.getByTitle("保存并返回主菜单").click();
  const before = await page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.initializeLocalSaveStore();
    await store.flushLocalSaveWrites();
    const comparable = (raw: string | null) => {
      if (!raw) return null;
      const { savedAt: _savedAt, ...envelope } = JSON.parse(raw) as Record<string, unknown>;
      return envelope;
    };
    const main = await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    if (!main) throw new Error("missing local main save");
    const keys = [
      "dsp-idle-network.save.v1",
      "dsp-idle-network.slot.1",
      "dsp-idle-network.slot.2",
      "dsp-idle-network.slot.3",
    ];
    for (const key of keys.slice(1)) store.setLocalSaveValue(key, main);
    await store.flushLocalSaveWrites();
    return Promise.all(keys.map(async (key) => comparable(await store.readPersistedLocalSaveValue(key))));
  });
  await page.reload();
  await page.getByRole("button", { name: "登录与云存档" }).click();
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await page.getByLabel("显示名称").fill("本地存档守护测试");
  await page.getByLabel("用户名", { exact: true }).fill("local_save_guard");
  await page.getByLabel("密码", { exact: true }).fill("strong-pass-123");
  await page.getByRole("button", { name: "创建云账户" }).click();
  await expect(page.locator(".start-menu-message")).toContainText("云存档与自动同步已开放");
  await expect(page.getByRole("button", { name: "上传本地存档" })).toBeEnabled();
  await page.getByLabel("退出云账户").click();
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByLabel("用户名或邮箱").fill("local_save_guard");
  await page.getByLabel("密码", { exact: true }).fill("strong-pass-123");
  await page.getByRole("button", { name: "登录云账户" }).click();
  await expect(page.locator(".start-menu-message")).toContainText("本地存档保持不变");
  const after = await page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.initializeLocalSaveStore();
    await store.flushLocalSaveWrites();
    const comparable = (raw: string | null) => {
      if (!raw) return null;
      const { savedAt: _savedAt, ...envelope } = JSON.parse(raw) as Record<string, unknown>;
      return envelope;
    };
    const keys = [
      "dsp-idle-network.save.v1",
      "dsp-idle-network.slot.1",
      "dsp-idle-network.slot.2",
      "dsp-idle-network.slot.3",
    ];
    return Promise.all(keys.map(async (key) => comparable(await store.readPersistedLocalSaveValue(key))));
  });
  expect(after).toEqual(before);
});
