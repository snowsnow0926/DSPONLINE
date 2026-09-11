import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { createInitialState } from "../../src/game/engine";
import { serializeEnvelope } from "../../src/game/storage";
import { selectSettingsCategory } from "./settings-helpers";

async function installTestBootstrap(page: Page) {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("dsp-idle-network.test-bypass-menu", "1");
    if (new URLSearchParams(window.location.search).get("releaseNotesTest") !== "1") {
      window.localStorage.setItem("dsp-idle-network.release-notes.seen.v1", "2026-08-17-v1.0.46");
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


test("campaign center shows chapter progress, deficits and direct recipe navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await page.getByLabel("打开主线任务中心").first().click();
  const campaign = page.getByRole("dialog", { name: "主线任务中心" });
  await expect(campaign).toBeVisible();
  await expect(campaign).toContainText("母星点火");
  await expect(campaign).toContainText("采集第一份矿石");
  await expect(campaign.locator(".campaign-deficits").first()).toContainText("缺少");
  await campaign.getByRole("button", { name: "查看铁矿石配方" }).click();
  const recipes = page.getByRole("dialog", { name: "生产资料库" });
  await expect(recipes).toBeVisible();
  await expect(recipes.locator(".recipe-item-header")).toContainText("铁矿石");
  await recipes.getByLabel("关闭生产资料库").click();
  await page.getByLabel("打开主线任务中心").first().click();
  await expect(page.getByRole("dialog", { name: "主线任务中心" })).toBeVisible();
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/campaign-center-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => campaign.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/campaign-center-390.png", fullPage: true });
});

test("campaign migration preserves legacy inventory while restoring task progress", async ({ page }) => {
  await freshGame(page);
  await page.getByTitle("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const localStore = await import("/src/game/localSaveStore.ts");
    const raw = await localStore.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    if (!raw) throw new Error("missing primary save");
    const envelope = JSON.parse(raw);
    envelope.state.version = 17;
    envelope.state.paused = true;
    envelope.state.manualMined = 1;
    delete envelope.state.campaign;
    delete envelope.checksum;
    delete envelope.formatVersion;
    localStore.setLocalSaveValue("dsp-idle-network.save.v1", JSON.stringify(envelope));
    await localStore.flushLocalSaveWrites();
    if (!storage.loadGame().state) throw new Error("legacy migration failed");
  });
  await page.reload();
  await page.getByLabel("打开主线任务中心").first().click();
  const campaign = page.getByRole("dialog", { name: "主线任务中心" });
  await expect(campaign).toContainText("铸造基础铁块");
  await expect(page.locator(".construction-item").filter({ hasText: "传送带 Mk.I" }).first()).toContainText("×10");
});

test("galaxy endgame campaign routes into the console and difficulty controls stay accessible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCampaignEndgameStageGame(page);
  await page.getByLabel("打开主线任务中心").first().click();
  const campaign = page.getByRole("dialog", { name: "主线任务中心" });
  await expect(campaign).toContainText("银河终局");
  await expect(campaign).toContainText("启动无限科研");
  await campaign.getByRole("button", { name: "打开银河工业控制台" }).first().click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await expect(statistics).toBeVisible();
  await expect(statistics.getByRole("tab", { name: /银河/ })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Escape");
  await expect(statistics).toHaveCount(0);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(operations, "教程、版本与其他", "other");
  await expect(operations).toContainText("工业难度");
  await operations.getByRole("button", { name: "高压" }).click();
  await expect(operations.getByRole("button", { name: "高压" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Space");
  await expect(page.getByLabel("暂停模拟")).toBeVisible();
});

test("galaxy network edits local accounts while browsing the public ranking anonymously", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/leaderboard") return fulfill({ entries: [] });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7 });
    if (pathname === "/api/public-status") return fulfill({ players: { total: 0, today: 0, online: 0, onlineWindowSeconds: 120 }, serverTime: Date.now() });
    if (pathname === "/api/analytics" || pathname === "/api/presence") return fulfill({ accepted: true }, 202);
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });
  await freshGame(page);
  await page.getByLabel("打开银河网络").click();
  const galaxy = page.getByRole("dialog", { name: "银河网络" });
  await expect(galaxy).toBeVisible();
  await expect(galaxy).toContainText("服务端真实玩家排行榜");
  await expect(galaxy).toContainText("本季还没有可公开展示的玩家排名");

  await expect(galaxy.getByRole("button", { name: "登录后刷新排名" })).toBeDisabled();
  await expect(galaxy).toContainText("访客可查看真实玩家排名");

  await galaxy.getByRole("tab", { name: "账户" }).click();
  await galaxy.getByLabel("账户显示名称").fill("赫利俄斯试验局");
  await galaxy.getByRole("button", { name: "保存名称" }).click();
  await expect(galaxy).toContainText("赫利俄斯试验局");
  await galaxy.locator(".galaxy-avatar-picker").getByRole("button", { name: "D", exact: true }).click();
  await galaxy.locator(".galaxy-privacy-setting").click();
  await expect(galaxy).toContainText("已退出排行榜");
  await galaxy.getByRole("tab", { name: "银河排行" }).click();
  await expect(galaxy.getByRole("button", { name: "已退出公开排行榜" })).toBeDisabled();
  await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.leaderboard.v1") ?? "")).not.toContain("acct_");

  await galaxy.getByRole("tab", { name: "账户" }).click();
  await galaxy.getByLabel("新账户名称").fill("北辰备用身份");
  await galaxy.getByLabel("创建本地账户").click();
  await expect(galaxy.locator(".galaxy-account-list")).toContainText("北辰备用身份");
  await page.screenshot({ path: "artifacts/qa/galaxy-account-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await galaxy.getByRole("tab", { name: "银河排行" }).click();
  await expect.poll(async () => galaxy.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(galaxy.locator(".galaxy-category-tabs")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/galaxy-ranking-390.png", fullPage: true });
});

test("galaxy rankings are public to visitors and refresh from the main cloud save", async ({ page }) => {
  let refreshRequest: Record<string, unknown> | null = null;
  let leaderboardVisible = true;
  const serverMetrics = {
    energyGeneratedMj: 1_500_000_000,
    uploadedWhiteMatrix: 400_000,
    peakWhiteMatrixPerMinute: 12_000,
    peakGenerationKw: 2_300_000,
    peakThroughputPerMinute: 150_000,
    theoreticalPeakThroughputPerMinute: 700_000,
    activePlanetThroughputPerMinute: 50_000,
    galacticThroughputPerMinute: 600_000,
    nominalThroughputMetricVersion: "galactic-planet-sum-v1",
    throughputMetricVersion: "settled-total-produced-v1",
    throughputWindowSeconds: 60,
    peakDysonPowerKw: 1_500_000,
    exploredSystems: 2,
    colonizedPlanets: 4,
    galaxyScore: 6_635_517,
  };
  const cloudUser = {
    id: "user_unverified_ranker",
    username: "unverified_ranker",
    email: "",
    displayName: "矩阵档案局",
    createdAt: 1,
    emailVerified: false,
    emailVerifiedAt: null,
    passwordChangedAt: 1,
    leaderboardVisible: true,
  };
  const cloudSave = {
    revision: 1,
    updatedAt: Date.now(),
    size: 2048,
    checksum: "ranker-cloud-save",
    summary: { stateVersion: 34, savedAt: Date.now(), elapsedSeconds: 1000, activePlanetId: "home", entityCount: 1, completedTechCount: 1, structurePoints: 0, uploadedWhiteMatrix: 400_000, stateChecksum: "ranker-state" },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7, mailProvider: "disabled" });
    if (pathname === "/api/account") return fulfill({ user: cloudUser, cloudSave, cloudSaves: { main: cloudSave, "1": null, "2": null, "3": null } });
    if (pathname === "/api/leaderboard/visibility") {
      leaderboardVisible = (request.postDataJSON() as { visible: boolean }).visible;
      cloudUser.leaderboardVisible = leaderboardVisible;
      return fulfill({ visible: leaderboardVisible, user: cloudUser, autoJoined: leaderboardVisible });
    }
    if (pathname === "/api/leaderboard/me") {
      const category = new URL(request.url()).searchParams.get("category");
      const value = category === "power" ? serverMetrics.energyGeneratedMj : category === "upload" ? serverMetrics.uploadedWhiteMatrix : category === "white-rate" ? serverMetrics.peakWhiteMatrixPerMinute : category === "dyson" ? serverMetrics.peakDysonPowerKw : category === "throughput" ? serverMetrics.peakThroughputPerMinute : serverMetrics.galaxyScore;
      const entry = { userId: cloudUser.id, accountId: cloudUser.id, displayName: cloudUser.displayName, avatar: "矩", seasonId: "season_01", metrics: serverMetrics, submittedAt: Date.now(), value, verified: true, rank: 1 };
      const latestWindowState = category === "white-rate" || category === "throughput"
        ? { status: "ranked", valid: true, value, metricVersion: category === "white-rate" ? "settled-universe-matrix-v1" : "settled-total-produced-v1", requiredSeconds: 60, observedSeconds: 60, remainingSeconds: 0, productionDelta: value, fromRevision: 1, toRevision: 2 }
        : null;
      return fulfill({ status: leaderboardVisible ? "ranked" : "hidden", entry: leaderboardVisible ? entry : null, rank: leaderboardVisible ? 1 : null, totalEntries: leaderboardVisible ? 1 : 0, serverMetrics: leaderboardVisible ? serverMetrics : null, latestWindowState: leaderboardVisible ? latestWindowState : null, mode: "normal", slot: "main", latestCloudRevision: 2, reviewResumeAfterRevision: null });
    }
    if (pathname === "/api/leaderboard" && request.method() === "POST") {
      refreshRequest = request.postDataJSON() as Record<string, unknown>;
      return fulfill({ verified: true });
    }
    if (pathname === "/api/leaderboard") {
      const category = new URL(request.url()).searchParams.get("category");
      const value = category === "power" ? serverMetrics.energyGeneratedMj : category === "upload" ? serverMetrics.uploadedWhiteMatrix : category === "white-rate" ? serverMetrics.peakWhiteMatrixPerMinute : category === "dyson" ? serverMetrics.peakDysonPowerKw : category === "throughput" ? serverMetrics.peakThroughputPerMinute : serverMetrics.galaxyScore;
      return fulfill({ entries: leaderboardVisible ? [{ userId: cloudUser.id, accountId: cloudUser.id, displayName: cloudUser.displayName, avatar: "矩", seasonId: "season_01", metrics: serverMetrics, submittedAt: Date.now(), value, verified: true, rank: 1 }] : [] });
    }
    if (pathname === "/api/public-status") return fulfill({ players: { total: 1, today: 1, online: 1, onlineWindowSeconds: 120 }, serverTime: Date.now() });
    if (pathname === "/api/analytics") return fulfill({ accepted: true }, 202);
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });
  await page.addInitScript(() => {
    const accountId = "acct_qa_ranker";
    window.localStorage.setItem("dsp-idle-network.account.v1", JSON.stringify({
      version: 1,
      activeAccountId: accountId,
      accounts: {
        [accountId]: {
          profile: { id: accountId, displayName: "矩阵档案局", avatar: "F", privacy: "public", createdAt: 1, updatedAt: 1 },
          ledger: {
            energyGeneratedMj: 1_500_000_000,
            uploadedWhiteMatrix: 400_000,
            peakGenerationKw: 2_300_000,
            peakThroughputPerMinute: 150_000,
            peakDysonPowerKw: 1_500_000,
            exploredSystems: 2,
            colonizedPlanets: 4,
            lastGameElapsedSeconds: 0,
            lastWhiteMatrixTotal: 0,
            lastSyncedAt: Date.now(),
          },
        },
      },
    }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("打开银河网络").click();
  let galaxy = page.getByRole("dialog", { name: "银河网络" });
  await expect(galaxy).toContainText("真实玩家");
  await expect(galaxy).toContainText("矩阵档案局");
  await expect(galaxy).toContainText("访客可查看真实玩家排名");

  await page.evaluate(() => window.localStorage.setItem("dsp-idle-network.cloud-token.v1", "unverified-ranker-token"));
  await page.reload();
  await page.getByLabel("打开银河网络").click();
  galaxy = page.getByRole("dialog", { name: "银河网络" });
  await galaxy.getByRole("tab", { name: /白矩阵上传/ }).click();
  const localRow = galaxy.locator(".galaxy-rank-row--local");
  await expect(localRow).toContainText("矩阵档案局");
  await expect(localRow.locator(".galaxy-rank-value")).toContainText("40万");
  await galaxy.getByRole("button", { name: "立即刷新排名" }).click();
  await expect(galaxy.getByRole("button", { name: "排名已刷新" })).toBeVisible();
  await expect(localRow).toContainText("主云存档计算");
  expect(refreshRequest).toEqual({ seasonId: "season_01" });

  await galaxy.getByRole("tab", { name: /白糖产量/ }).click();
  await expect(localRow.locator(".galaxy-rank-value")).toContainText("1.2万");
  await expect(galaxy).toContainText("白糖产量峰值");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("实际结算吞吐15万");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("当前星球理论速率5万");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("全星区理论速率60万");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("全星区理论峰值70万");

  await galaxy.getByRole("tab", { name: /累计发电/ }).click();
  await expect(localRow.locator(".galaxy-rank-value")).toContainText("15亿");
  await galaxy.locator(".galaxy-leaderboard-visibility input").click();
  await expect(galaxy.locator(".galaxy-leaderboard-visibility input")).not.toBeChecked();
  await expect(galaxy).toContainText("本季还没有可公开展示的玩家排名");
  await expect(galaxy.getByRole("button", { name: "已退出公开排行榜" })).toBeDisabled();
  await galaxy.locator(".galaxy-leaderboard-visibility input").click();
  await expect(galaxy.locator(".galaxy-leaderboard-visibility input")).toBeChecked();
  await expect(galaxy.locator(".galaxy-rank-row--local")).toContainText("矩阵档案局");
  expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem("dsp-idle-network.leaderboard.v1") ?? "[]"))).toEqual([]);
  await page.screenshot({ path: "artifacts/qa/galaxy-power-1440.png", fullPage: true });
});

test("galaxy ranking identifies the signed-in account outside the top 100 and explains zero or pending server windows", async ({ page }) => {
  const cloudUser = {
    id: "user_leaderboard_self_1040",
    username: "leaderboard_self_1040",
    email: "",
    displayName: "作者",
    createdAt: 1,
    emailVerified: false,
    emailVerifiedAt: null,
    passwordChangedAt: 1,
    leaderboardVisible: true,
  };
  const cloudSave = {
    revision: 2,
    updatedAt: Date.now(),
    size: 2048,
    checksum: "leaderboard-self-cloud-save",
    summary: { stateVersion: 46, savedAt: Date.now(), elapsedSeconds: 1_059, activePlanetId: "home", entityCount: 1, completedTechCount: 1, structurePoints: 0, uploadedWhiteMatrix: 0, stateChecksum: "leaderboard-self-state" },
  };
  const baseMetrics = {
    energyGeneratedMj: 1_000,
    uploadedWhiteMatrix: 0,
    peakWhiteMatrixPerMinute: 0,
    peakGenerationKw: 1_000,
    peakThroughputPerMinute: 0,
    theoreticalPeakThroughputPerMinute: 20_000_000_000,
    activePlanetThroughputPerMinute: 10_000_000_000,
    galacticThroughputPerMinute: 20_000_000_000,
    nominalThroughputMetricVersion: "galactic-planet-sum-v1",
    throughputMetricVersion: "settled-total-produced-v1",
    throughputWindowSeconds: 0,
    peakDysonPowerKw: 0,
    exploredSystems: 1,
    colonizedPlanets: 1,
    galaxyScore: 1_000,
  };
  const publicLeaderboardAuthorization: Array<string | null> = [];
  const privateLeaderboardAuthorization: Array<string | null> = [];
  let whiteWindowReady = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const fulfill = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/health") return fulfill({ ok: true, schemaVersion: 7, mailProvider: "disabled" });
    if (pathname === "/api/account") return fulfill({ user: cloudUser, cloudSave, cloudSaves: { main: cloudSave, "1": null, "2": null, "3": null } });
    if (pathname === "/api/leaderboard/me") {
      privateLeaderboardAuthorization.push(request.headers().authorization ?? null);
      const category = url.searchParams.get("category");
      const selfValue = category === "throughput" || category === "white-rate" ? 0 : baseMetrics.galaxyScore;
      const selfEntry = { userId: cloudUser.id, accountId: cloudUser.id, displayName: cloudUser.displayName, avatar: "作", seasonId: "season_01", metrics: baseMetrics, submittedAt: Date.now(), value: selfValue, verified: true, rank: 137 };
      const latestWindowState = category === "throughput"
        ? { status: "interval_too_short", valid: false, value: null, metricVersion: "settled-total-produced-v1", requiredSeconds: 60, observedSeconds: 59, remainingSeconds: 1, productionDelta: null, fromRevision: 1, toRevision: 2 }
        : category === "white-rate"
          ? whiteWindowReady
            ? { status: "valid_zero_production", valid: true, value: 0, metricVersion: "settled-universe-matrix-v1", requiredSeconds: 60, observedSeconds: 60, remainingSeconds: 0, productionDelta: 0, fromRevision: 1, toRevision: 2 }
            : { status: "missing_adjacent_revision", valid: false, value: null, metricVersion: "settled-universe-matrix-v1", requiredSeconds: 60, observedSeconds: 0, remainingSeconds: 60, productionDelta: null, fromRevision: null, toRevision: 2 }
          : null;
      return fulfill({ status: latestWindowState?.status ?? "ranked", entry: selfEntry, rank: 137, totalEntries: 200, serverMetrics: baseMetrics, latestWindowState, mode: "normal", slot: "main", latestCloudRevision: 2, reviewResumeAfterRevision: null });
    }
    if (pathname === "/api/leaderboard") {
      publicLeaderboardAuthorization.push(request.headers().authorization ?? null);
      const category = url.searchParams.get("category");
      const selfValue = category === "throughput" || category === "white-rate" ? 0 : baseMetrics.galaxyScore;
      const selfEntry = { userId: cloudUser.id, accountId: cloudUser.id, displayName: cloudUser.displayName, avatar: "作", seasonId: "season_01", metrics: baseMetrics, submittedAt: Date.now(), value: selfValue, verified: true, rank: 137 };
      const publicEntry = { ...selfEntry, userId: "other-player", accountId: "other-player", displayName: "其他工程师", avatar: "其", rank: 1, value: selfValue + 10_000 };
      return fulfill({ entries: [publicEntry] });
    }
    if (pathname === "/api/public-status") return fulfill({ players: { total: 2, today: 2, online: 1, onlineWindowSeconds: 120 }, serverTime: Date.now() });
    if (pathname === "/api/analytics") return fulfill({ accepted: true }, 202);
    return fulfill({ error: `unmocked ${pathname}` }, 404);
  });
  await page.addInitScript(() => {
    const accountId = "local-profile-id-differs-from-cloud-user";
    window.localStorage.setItem("dsp-idle-network.cloud-token.v1", "leaderboard-self-token");
    window.localStorage.setItem("dsp-idle-network.account.v1", JSON.stringify({
      version: 1,
      activeAccountId: accountId,
      accounts: {
        [accountId]: {
          profile: { id: accountId, displayName: "本地作者档案", avatar: "本", privacy: "public", createdAt: 1, updatedAt: 1 },
          ledger: {
            energyGeneratedMj: 1_000,
            uploadedWhiteMatrix: 0,
            peakWhiteMatrixPerMinute: 0,
            peakGenerationKw: 1_000,
            peakThroughputPerMinute: 20_000_000_000,
            peakActualThroughputPerMinute: 19_600_000_000,
            peakDysonPowerKw: 0,
            exploredSystems: 1,
            colonizedPlanets: 1,
            lastGameElapsedSeconds: 0,
            lastWhiteMatrixTotal: 0,
            lastSyncedAt: Date.now(),
          },
        },
      },
    }));
  });

  await page.goto("/");
  await page.getByLabel("打开银河网络").click();
  const galaxy = page.getByRole("dialog", { name: "银河网络" });
  await expect(galaxy.locator(".galaxy-summary-band")).toContainText("#137 · Top 100 外");
  await expect(galaxy.locator(".galaxy-summary-band")).toContainText("完整榜共 200 条");
  await expect(galaxy.locator(".galaxy-rank-row--local")).toContainText("作者");
  await expect(galaxy.locator(".galaxy-rank-row--local")).toContainText("当前账户");

  await galaxy.getByRole("tab", { name: /实际结算吞吐/ }).click();
  await expect(galaxy.locator(".galaxy-summary-band")).toContainText("#137 · Top 100 外");
  await expect(galaxy.locator(".galaxy-summary-band")).toContainText("实际结算吞吐--");
  await expect(galaxy).toContainText("统计窗口已观察 59 个模拟秒，还需 1 秒");
  await expect(galaxy).toContainText("本地 60 秒最佳为 196亿/min");
  await expect(galaxy).toContainText("本地值不会计入服务器排行榜");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("服务器实际结算吞吐--");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText(/本地 60 秒实际结算吞吐最佳196亿\s*\/min/);

  await galaxy.getByRole("tab", { name: /白糖产量/ }).click();
  await expect(galaxy.locator(".galaxy-summary-band")).toContainText("#137 · Top 100 外");
  await expect(galaxy.locator(".galaxy-summary-band")).toContainText("白糖产量--");
  await expect(galaxy).toContainText("缺少相邻普通主云修订");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("服务器白糖产量峰值--");

  whiteWindowReady = true;
  await galaxy.getByRole("tab", { name: /银河综合/ }).click();
  await expect(galaxy.locator(".galaxy-summary-band")).toContainText("银河综合");
  await galaxy.getByRole("tab", { name: /白糖产量/ }).click();
  await expect(galaxy).toContainText("有效窗口，当前无产出");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("服务器白糖产量峰值0.0 /min");
  await expect(galaxy.locator(".galaxy-upload-panel")).toContainText("本地 60 秒白糖最佳-- 本地尚未记录");
  expect(publicLeaderboardAuthorization.length).toBeGreaterThan(0);
  expect(publicLeaderboardAuthorization.every((value) => value === null)).toBe(true);
  expect(privateLeaderboardAuthorization.length).toBeGreaterThan(0);
  expect(privateLeaderboardAuthorization.every((value) => value === "Bearer leaderboard-self-token")).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => galaxy.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(galaxy.locator(".galaxy-summary-band")).toContainText("#137 · Top 100 外");
});

test("star map yields immediately to every primary workspace on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  const starMap = page.getByRole("dialog", { name: "星图" });

  for (const target of [
    { opener: "打开生产统计", dialog: "生产统计" },
    { opener: "打开生产资料库", dialog: "生产资料库" },
    { opener: "打开科技树", dialog: "科技树" },
  ] as const) {
    await page.getByLabel("打开星图").click();
    await expect(starMap).toBeVisible();
    await page.getByLabel(target.opener).click();
    await expect(starMap).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: target.dialog })).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "星图" }).click();
  await expect(starMap).toBeVisible();
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "生产资料库" }).click();
  await expect(starMap).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "生产资料库" })).toBeVisible();
});

test("all font scales keep the header and both construction-dock modes inside desktop and phone viewports", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await dismissOnboarding(page);

  const scales = [80, 100, 125, 150, 200] as const;
  const viewports = [
    { width: 1440, height: 900, name: "desktop" },
    { width: 390, height: 844, name: "portrait" },
    { width: 844, height: 390, name: "landscape" },
  ] as const;
  const layoutFits = () => page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".game-header");
    const dock = document.querySelector<HTMLElement>(".construction-dock");
    const itemsViewport = document.querySelector<HTMLElement>(".construction-items");
    if (!header || !dock || !itemsViewport) return { ok: false, reason: "missing shell" };
    const headerBox = header.getBoundingClientRect();
    const dockBox = dock.getBoundingClientRect();
    const itemsBox = itemsViewport.getBoundingClientRect();
    const visibleItems = [...dock.querySelectorAll<HTMLElement>(".construction-item")].filter((item) => {
      const box = item.getBoundingClientRect();
      return box.right > 0 && box.left < innerWidth && box.bottom > dockBox.top && box.top < dockBox.bottom;
    });
    const itemVerticalFit = visibleItems.every((item) => {
      const box = item.getBoundingClientRect();
      return box.top >= dockBox.top - 1 && box.bottom <= dockBox.bottom + 1;
    });
    const clickable = visibleItems.filter((item) => {
      const box = item.getBoundingClientRect();
      const center = box.left + box.width / 2;
      return center >= itemsBox.left && center <= itemsBox.right;
    }).every((item) => {
      const box = item.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.max(1, Math.min(innerWidth - 1, box.left + box.width / 2)), Math.max(1, Math.min(innerHeight - 1, box.top + box.height / 2)));
      return Boolean(hit?.closest(".construction-item, .construction-item-craft"));
    });
    const metricOverlap = [...header.querySelectorAll<HTMLElement>(".header-metrics > div")].some((metric) => {
      const label = metric.querySelector<HTMLElement>(":scope > span")?.getBoundingClientRect();
      const value = metric.querySelector<HTMLElement>(":scope > strong")?.getBoundingClientRect();
      if (!label || !value || getComputedStyle(metric).display === "none") return false;
      return label.bottom > value.top + 3;
    });
    const shellFit = headerBox.top >= -1 && headerBox.bottom <= innerHeight + 1 && dockBox.top >= -1 && dockBox.bottom <= innerHeight + 1;
    return {
      ok: shellFit && itemVerticalFit && clickable && !metricOverlap && visibleItems.length > 0 && document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      shellFit,
      itemVerticalFit,
      clickable,
      metricOverlap,
      visibleItems: visibleItems.length,
      dock: { top: dockBox.top, bottom: dockBox.bottom, height: dockBox.height },
      items: visibleItems.map((item) => { const box = item.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height }; }),
    };
  });

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const compact of [false, true]) {
      const dock = page.locator(".construction-dock");
      const active = await dock.evaluate((element) => element.classList.contains("construction-dock--compact"));
      if (active !== compact) await page.getByLabel(compact ? "开启施工托盘精简模式" : "关闭施工托盘精简模式").click();
      for (const scale of scales) {
        await page.evaluate((value) => {
          document.documentElement.dataset.uiFontScale = String(value);
          document.documentElement.style.setProperty("--ui-font-scale", String(value / 100));
        }, scale);
        await page.waitForTimeout(60);
        const outcome = await layoutFits();
        expect(outcome, `${viewport.name} ${compact ? "compact" : "standard"} ${scale}%: ${JSON.stringify(outcome)}`).toMatchObject({ ok: true });
        if (scale === 200) await page.screenshot({ path: `artifacts/qa/font-200-${viewport.name}-${compact ? "compact" : "standard"}.png`, fullPage: true });
      }
    }
  }
});

test("coarse-pointer edge dragging stops moving the canvas immediately after release", async ({ browser }) => {
  const { context, page } = await createTouchPage(browser, { width: 390, height: 844 });
  try {
    await freshGame(page);
    await dismissOnboarding(page);
    await page.locator(".react-flow__controls-fitview").click();
    const node = page.locator(".vein-node").filter({ hasText: "铁矿石" });
    const nodeBox = await node.boundingBox();
    const paneBox = await page.locator(".react-flow__pane").boundingBox();
    expect(nodeBox).not.toBeNull();
    expect(paneBox).not.toBeNull();
    const readTransform = () => page.locator(".react-flow__viewport").evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f, zoom: matrix.a };
    });
    const before = await readTransform();
    const session = await context.newCDPSession(page);
    const start = { x: Math.round(nodeBox!.x + nodeBox!.width / 2), y: Math.round(nodeBox!.y + nodeBox!.height / 2) };
    const edge = { x: Math.round(paneBox!.x + paneBox!.width - 3), y: start.y };
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
    for (let step = 1; step <= 5; step += 1) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(start.x + (edge.x - start.x) * step / 5), y: edge.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
      await page.waitForTimeout(35);
    }
    await page.waitForTimeout(240);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const released = await readTransform();
    await page.waitForTimeout(450);
    const settled = await readTransform();
    expect(Math.hypot(released.x - before.x, released.y - before.y)).toBeLessThan(3);
    expect(Math.hypot(settled.x - released.x, settled.y - released.y)).toBeLessThan(0.5);
  } finally {
    await context.close();
  }
});

test("planet tray limits edit independently and small storage ports stay separated at 200 percent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInterstellarGame(page);
  const limitInput = page.locator(".tray-limit-control input");
  await limitInput.fill("2500");
  await limitInput.blur();
  await expect(limitInput).toHaveValue("2500");
  await page.getByTitle("切换到烬原 II").click();
  await expect(limitInput).toHaveValue("1000000");
  await limitInput.fill("5000");
  await limitInput.blur();
  await page.getByTitle("切换到澄海 I").click();
  await expect(limitInput).toHaveValue("2500");

  await page.reload();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBeltNetworkGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  const storage = page.locator('.react-flow__node[data-id="network_buffer"] .storage-buffer-node');
  const laneGeometry = () => storage.locator(".logistics-slot-row").evaluate((row) => {
    const columns = [...row.querySelectorAll<HTMLElement>(":scope > .node-io__column")];
    if (columns.length !== 2) return { columns: columns.length, separated: false, withinCard: false };
    const input = columns[0].getBoundingClientRect();
    const output = columns[1].getBoundingClientRect();
    const article = row.closest<HTMLElement>(".storage-buffer-node")?.getBoundingClientRect();
    const separated = input.right <= output.left + 1 || input.bottom <= output.top + 1;
    const withinCard = Boolean(article
      && input.left >= article.left - 1
      && input.right <= article.right + 1
      && output.left >= article.left - 1
      && output.right <= article.right + 1);
    return {
      columns: columns.length,
      separated,
      withinCard,
      article: article && { left: article.left, right: article.right },
      input: { left: input.left, right: input.right, top: input.top, bottom: input.bottom },
      output: { left: output.left, right: output.right, top: output.top, bottom: output.bottom },
    };
  });
  await expect.poll(async () => (await laneGeometry()).columns).toBe(2);
  const desktopGeometry = await laneGeometry();
  expect(desktopGeometry, JSON.stringify(desktopGeometry)).toMatchObject({ columns: 2, separated: true, withinCard: true });
  await page.screenshot({ path: "artifacts/qa/storage-ports-font-200-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".react-flow__controls-fitview").click();
  await expect.poll(async () => (await laneGeometry()).columns).toBe(2);
  const portraitGeometry = await laneGeometry();
  expect(portraitGeometry, JSON.stringify(portraitGeometry)).toMatchObject({ columns: 2, separated: true, withinCard: true });
  await page.screenshot({ path: "artifacts/qa/storage-ports-font-200-portrait.png", fullPage: true });
});
