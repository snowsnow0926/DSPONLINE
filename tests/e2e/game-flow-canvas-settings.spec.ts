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


test("box selection copies, pastes, moves and upgrades a production blueprint", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBlueprintStageGame(page);
  const source = page.locator(".machine-node").filter({ hasText: "电路板" }).first();
  const target = page.locator(".machine-node").filter({ hasText: "处理器" }).first();

  const boxSelect = async () => {
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await page.getByLabel("框选模式").click();
    const left = Math.min(sourceBox!.x, targetBox!.x) - 12;
    const top = Math.min(sourceBox!.y, targetBox!.y) - 12;
    const right = Math.max(sourceBox!.x + sourceBox!.width, targetBox!.x + targetBox!.width) + 12;
    const bottom = Math.max(sourceBox!.y + sourceBox!.height, targetBox!.y + targetBox!.height) + 12;
    await page.mouse.move(right, bottom);
    await page.mouse.down();
    await page.mouse.move(left, top, { steps: 14 });
    await page.mouse.up();
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
    await expect(page.getByRole("toolbar", { name: "选区操作" })).toContainText("2 节点 · 1 线路");
  };

  await boxSelect();
  await page.getByLabel("复制所选为蓝图").click();
  await expect(page.locator(".blueprint-placement-cursor")).toContainText("蓝图 01");
  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 100 } });
  await expect(page.locator(".machine-node")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.locator(".game-notice")).toContainText("部署完成");

  await page.getByLabel("打开蓝图库").click();
  const library = page.getByRole("dialog", { name: "蓝图与待建施工" });
  await expect(library.locator(".blueprint-card")).toHaveCount(1);
  await expect(library.locator(".blueprint-card")).toContainText("2 设备 · 0 资源锚点 · 1 线路");
  await expect(library.locator(".blueprint-requirements")).toContainText("制造台 Mk.I 0/2");
  const nameInput = library.locator(".blueprint-card input");
  await nameInput.fill("处理器模块");
  await nameInput.press("Enter");
  await expect(nameInput).toHaveValue("处理器模块");
  await page.screenshot({ path: "artifacts/qa/blueprint-library-1440.png", fullPage: true });
  await page.getByLabel("关闭蓝图工作区").click();

  await boxSelect();
  const targetBeforeMove = await target.boundingBox();
  const sourceHeader = source.locator(".factory-node__header");
  const sourceHeaderBox = await sourceHeader.boundingBox();
  await page.mouse.move(sourceHeaderBox!.x + 50, sourceHeaderBox!.y + 18);
  await page.mouse.down();
  await page.mouse.move(sourceHeaderBox!.x + 130, sourceHeaderBox!.y + 68, { steps: 10 });
  await page.mouse.up();
  const targetAfterMove = await target.boundingBox();
  expect(targetAfterMove!.x).toBeGreaterThan(targetBeforeMove!.x + 55);
  expect(targetAfterMove!.y).toBeGreaterThan(targetBeforeMove!.y + 30);

  await page.getByLabel("批量升级所选设备").click();
  await expect(page.locator(".machine-node").filter({ hasText: "制造台 Mk.II" })).toHaveCount(2);
  await page.getByLabel("一键升级所选传送带").click();
  await expect(page.locator(".factory-edge-label--selected")).toContainText("Mk.II");
  await page.screenshot({ path: "artifacts/qa/blueprint-batch-upgrade-1440.png", fullPage: true });

  await page.getByLabel("打开蓝图库").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(library).toBeVisible();
  await expect.poll(async () => library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(library.locator(".blueprint-card input")).toHaveValue("处理器模块");
  await page.screenshot({ path: "artifacts/qa/blueprint-library-390.png", fullPage: true });
});

test("production regions persist visual boundaries without blocking normal canvas tools", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await page.getByLabel("生产区域模式").click();
  await expect(page.locator(".game-shell")).toHaveClass(/game-shell--regioning/);
  const drag = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const bounds = pane.getBoundingClientRect();
    for (let y = bounds.top + 60; y < bounds.bottom - 210; y += 28) {
      for (let x = bounds.left + 60; x < bounds.right - 280; x += 28) {
        if (document.elementFromPoint(x, y) === pane) return { start: { x, y }, end: { x: x + 220, y: y + 150 } };
      }
    }
    return null;
  });
  expect(drag).not.toBeNull();
  await page.mouse.move(drag!.start.x, drag!.start.y);
  await page.mouse.down();
  await page.mouse.move(drag!.end.x, drag!.end.y, { steps: 10 });
  await expect(page.locator(".canvas-region--draft")).toBeVisible();
  await page.mouse.up();

  const region = page.locator(".canvas-region:not(.canvas-region--draft)");
  const editor = page.getByLabel("生产区域设置");
  await expect(region).toHaveCount(1);
  await expect(editor).toBeVisible();
  await editor.getByLabel("区域名称").fill("蓝糖生产区");
  await editor.getByLabel("区域名称").press("Enter");
  const colors = editor.locator('input[type="color"]');
  await colors.nth(0).evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "#334455";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await colors.nth(1).evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "#77CCAA";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(region.locator(".canvas-region__label")).toContainText("蓝糖生产区");
  await expect(region).toHaveCSS("border-color", "rgb(119, 204, 170)");
  const southeastHandle = page.getByLabel("调整右下角：蓝糖生产区");
  await expect(southeastHandle).toBeVisible();
  const regionBeforeResize = await region.boundingBox();
  const resizeHandleBounds = await southeastHandle.boundingBox();
  await page.mouse.move(resizeHandleBounds!.x + resizeHandleBounds!.width / 2, resizeHandleBounds!.y + resizeHandleBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeHandleBounds!.x + resizeHandleBounds!.width / 2 + 90, resizeHandleBounds!.y + resizeHandleBounds!.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await region.boundingBox())!.width).toBeGreaterThan(regionBeforeResize!.width + 60);
  await expect.poll(async () => (await region.boundingBox())!.height).toBeGreaterThan(regionBeforeResize!.height + 35);
  await editor.getByLabel("关闭区域设置").click();
  await expect(editor).toHaveCount(0);
  await region.locator(".canvas-region__label").click();
  await expect(editor).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => editor.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
  })).toBe(true);
  await page.screenshot({ path: "artifacts/qa/canvas-region-editor-390.png", fullPage: true });
  await editor.getByLabel("删除生产区域").click();
  await expect(region).toHaveCount(0);
});

test("mobile production regions expose touch-sized handles and resize without panning the canvas", async ({ browser }) => {
  const { context, page } = await createTouchPage(browser, { width: 390, height: 844 });
  try {
    await freshGame(page);
    await dismissOnboarding(page);
    await page.getByLabel("生产区域模式").tap();
    const drag = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(".react-flow__pane");
      if (!pane) return null;
      const bounds = pane.getBoundingClientRect();
      for (let y = bounds.top + 90; y < bounds.bottom - 190; y += 24) {
        for (let x = bounds.left + 45; x < bounds.right - 190; x += 24) {
          if (document.elementFromPoint(x, y) === pane) return { start: { x: Math.round(x), y: Math.round(y) }, end: { x: Math.round(x + 145), y: Math.round(y + 105) } };
        }
      }
      return null;
    });
    expect(drag).not.toBeNull();
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...drag!.start, id: 31, radiusX: 5, radiusY: 5, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round((drag!.start.x + drag!.end.x) / 2), y: Math.round((drag!.start.y + drag!.end.y) / 2), id: 31, radiusX: 5, radiusY: 5, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...drag!.end, id: 31, radiusX: 5, radiusY: 5, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    const region = page.locator(".canvas-region:not(.canvas-region--draft)");
    await expect(region).toHaveCount(1);
    const handle = page.getByLabel(/调整右下角/);
    await expect(handle).toBeVisible();
    const handleBounds = await handle.boundingBox();
    expect(handleBounds!.width).toBeGreaterThanOrEqual(28);
    expect(handleBounds!.height).toBeGreaterThanOrEqual(28);
    const before = await region.boundingBox();
    const start = { x: Math.round(handleBounds!.x + handleBounds!.width / 2), y: Math.round(handleBounds!.y + handleBounds!.height / 2) };
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 32, radiusX: 5, radiusY: 5, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + 45, y: start.y + 35, id: 32, radiusX: 5, radiusY: 5, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await region.boundingBox())!.width).toBeGreaterThan(before!.width + 25);
    await expect.poll(async () => (await region.boundingBox())!.height).toBeGreaterThan(before!.height + 18);
  } finally {
    await context.close();
  }
});

test("blueprint transforms, recipe parameters and missing-stock construction queue stay persistent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBlueprintStageGame(page);
  const nodes = page.locator(".machine-node");
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ["Shift"] });
  await page.getByLabel("复制所选为蓝图").click();
  await page.locator(".react-flow__pane").click({ position: { x: 690, y: 120 } });
  await page.getByLabel("打开蓝图库").click();
  const library = page.getByRole("dialog", { name: "蓝图与待建施工" });
  const card = library.locator(".blueprint-card");
  await card.getByRole("button", { name: "90°", exact: true }).click();
  await card.getByRole("button", { name: "水平镜像" }).click();
  await expect(card).toContainText("配方参数");
  await expect(card.getByRole("button", { name: "排队部署" })).toBeEnabled();
  await card.getByRole("button", { name: "排队部署" }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 620, y: 500 }, force: true });
  await expect(page.locator(".game-notice")).toContainText("已加入施工队列");
  await page.getByLabel("打开蓝图库").click();
  await library.getByRole("button", { name: /待建与补足/ }).click();
  const pendingWorkspace = library.locator(".pending-construction-workspace");
  const pendingOrder = pendingWorkspace.locator(".pending-construction-order");
  await expect(pendingWorkspace).toContainText("施工订单");
  await expect(pendingOrder).toContainText("90° · 水平镜像");
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/blueprint-queue-1440.png", fullPage: true });
  await pendingOrder.getByRole("button", { name: "取消并返还" }).click();
  await page.locator(".game-dialog").getByRole("button", { name: "取消并返还" }).click();
  await expect(pendingOrder).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/blueprint-transform-390.png", fullPage: true });
});

test("industrial planner creates a recursive target and remains usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCompleteEnergyGame(page);
  await page.getByLabel("打开生产统计").click();
  const workspace = page.getByRole("dialog", { name: "生产统计" });
  await workspace.getByRole("tab", { name: /规划/ }).click();
  await workspace.getByLabel("目标物品").selectOption("magnetic_coil");
  await workspace.getByLabel("目标产量").fill("120");
  await workspace.getByRole("button", { name: "新建方案" }).click();
  await expect(workspace.locator(".planning-summary-band")).toContainText("理论设备");
  await expect(workspace.locator(".planning-requirements")).toContainText("磁线圈");
  await expect(workspace.locator(".planning-requirements")).toContainText("磁铁");
  await expect(workspace.locator(".planning-requirements")).toContainText("铜块");
  await expect(workspace.locator(".planning-history")).toContainText("等待采样");
  await page.screenshot({ path: "artifacts/qa/production-planner-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspace).toBeVisible();
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/production-planner-390.png", fullPage: true });
});

test("canvas placement supports toolbar and keyboard undo redo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBlueprintStageGame(page);
  await page.getByTitle("部署制造台 Mk.I", { exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 100 } });
  await expect(page.locator(".machine-node")).toHaveCount(3);

  await page.getByLabel("撤销", { exact: true }).click();
  await expect(page.locator(".machine-node")).toHaveCount(2);
  await expect(page.getByLabel("重做")).toBeEnabled();

  await page.keyboard.press("Control+Shift+Z");
  await expect(page.locator(".machine-node")).toHaveCount(3);
  await expect(page.locator(".game-notice")).toContainText("已重做");
});

test("double-click canvas zoom is disabled by default and follows the settings toggle", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  await page.locator(".react-flow__controls-zoomin").click();
  await page.locator(".react-flow__controls-zoomin").click();
  const viewportTransform = () => page.locator(".react-flow__viewport").evaluate((element) => (element as HTMLElement).style.transform);
  const blankPoint = async () => page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const bounds = pane.getBoundingClientRect();
    for (let y = bounds.top + 40; y < bounds.bottom - 40; y += 32) {
      for (let x = bounds.left + 40; x < bounds.right - 40; x += 32) {
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    return null;
  });
  const point = await blankPoint();
  expect(point).not.toBeNull();
  const before = await viewportTransform();
  await page.mouse.dblclick(point!.x, point!.y);
  await page.waitForTimeout(340);
  expect(await viewportTransform()).toBe(before);

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.locator(".settings-category-overview").getByRole("button", { name: "交互与控制" }).click();
  const doubleClickToggle = operations.locator(".setting-row").filter({ hasText: "允许双击缩放" });
  await expect(doubleClickToggle.locator('input[type="checkbox"]')).not.toBeChecked();
  await doubleClickToggle.click();
  await operations.getByLabel("关闭运营中心").click();

  const enabledPoint = await blankPoint();
  expect(enabledPoint).not.toBeNull();
  await page.mouse.dblclick(enabledPoint!.x, enabledPoint!.y);
  await expect.poll(viewportTransform).not.toBe(before);
});

test("construction cards craft in place and Ctrl-click chains building placement", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededGame(page);
  await page.getByTitle("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const state = storage.loadGame().state;
    state.tray = { iron_ingot: 20, stone_brick: 10, gear: 10, magnetic_coil: 10 };
    state.planetTrays = { ...state.planetTrays, home: state.tray };
    state.research.completedTechIds = [...new Set([...state.research.completedTechIds, "thermal_power"])] as typeof state.research.completedTechIds;
    state.construction.thermal_power_plant = 0;
    const result = await storage.saveGameVerified(state);
    if (!result.success) throw new Error(result.message);
  });
  await page.reload();
  const craftButton = page.getByLabel("制造火力发电厂");
  await expect(craftButton).toBeEnabled();
  await expect(craftButton).toHaveAttribute("data-craft-state", "direct");
  await craftButton.click();
  await expect(page.locator(".construction-item-shell").filter({ hasText: "火力发电厂" })).toContainText("×1");
  await expect(page.locator(".interaction-burst").filter({ hasText: "已消耗" })).toBeVisible();
  await craftButton.click();
  await expect(craftButton).toBeEnabled();
  await expect(craftButton).toHaveClass(/construction-item-craft--disabled/);
  await expect(craftButton).toHaveAttribute("data-craft-state", "blocked");
  await expect(craftButton).toHaveAttribute("title", /铁矿石 0\/10（缺 10）/);
  await page.screenshot({ path: "artifacts/qa/construction-shortcuts-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/qa/construction-shortcuts-390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  await openBlueprintStageGame(page);
  await page.getByTitle("部署制造台 Mk.I", { exact: true }).click();
  const emptyPanePoints = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return [] as Array<{ x: number; y: number }>;
    const rect = pane.getBoundingClientRect();
    const points: Array<{ x: number; y: number }> = [];
    for (let y = rect.top + 150; y < rect.bottom - 180; y += 35) {
      for (let x = rect.left + 170; x < rect.right - 260; x += 45) {
        const target = document.elementFromPoint(x, y);
        if (target instanceof Element && target.closest(".react-flow__pane") && !target.closest(".react-flow__minimap, .react-flow__controls, .react-flow__node")) points.push({ x, y });
      }
    }
    return points;
  });
  expect(emptyPanePoints.length).toBeGreaterThan(1);
  await page.keyboard.down("Control");
  await page.mouse.click(emptyPanePoints[0].x, emptyPanePoints[0].y);
  await expect(page.getByTitle("部署制造台 Mk.I", { exact: true })).toHaveClass(/construction-item--active/);
  await expect(page.locator(".continuous-placement-indicator")).toContainText("连续扩建");
  const secondPoint = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    for (let y = rect.bottom - 230; y > rect.top + 160; y -= 40) {
      for (let x = rect.right - 300; x > rect.left + 180; x -= 50) {
        const target = document.elementFromPoint(x, y);
        if (target instanceof Element && target.closest(".react-flow__pane") && !target.closest(".react-flow__minimap, .react-flow__controls, .react-flow__node")) return { x, y };
      }
    }
    return null;
  });
  expect(secondPoint).not.toBeNull();
  await page.mouse.click(secondPoint!.x, secondPoint!.y);
  await page.keyboard.up("Control");
  await expect(page.locator(".machine-node")).toHaveCount(3);
  await expect(page.locator(".machine-node").filter({ hasText: "×2" })).toHaveCount(1);
  await expect(page.getByTitle("部署制造台 Mk.I", { exact: true })).not.toHaveClass(/construction-item--active/);
  await expect(page.locator(".game-notice")).toContainText(/连续扩建|材料不足/);

  await openBlueprintStageGame(page);
  const sourceAssembler = page.locator('.react-flow__node[data-id="blueprint_source"] .machine-node');
  await page.getByLabel("批量部署数量").getByRole("button", { name: "×2" }).click();
  await page.getByTitle("部署制造台 Mk.I ×2", { exact: true }).click();
  await page.keyboard.down("Control");
  await sourceAssembler.click();
  await page.keyboard.up("Control");
  await expect(sourceAssembler).toContainText("×2");
  await expect(page.getByTitle("部署制造台 Mk.I", { exact: true })).not.toHaveClass(/construction-item--active/);

  await sourceAssembler.locator(".factory-node__header").click();
  const quickAdd = page.getByRole("button", { name: /快速增加 1 台建筑，剩余 1/ });
  await expect(quickAdd).toBeEnabled();
  await quickAdd.click();
  await expect(sourceAssembler).toContainText("×3");
  await expect(page.getByRole("button", { name: /^快速增加 1 台建筑，剩余 0$/ })).toBeDisabled();
  const batchReduction = page.locator(".entity-stack-batch-remove");
  await batchReduction.getByRole("button", { name: "减少 1 台建筑" }).click();
  await expect(sourceAssembler).toContainText("×2");
  await expect(quickAdd).toBeEnabled();
  await batchReduction.getByRole("button", { name: "减少 1 台建筑" }).click();
  await expect(sourceAssembler).toContainText("×1");
  await page.locator(".inspector-panel").getByRole("button", { name: "回收设备" }).click();
  await page.locator(".game-dialog").getByRole("button", { name: "确认回收" }).click();
  await expect(sourceAssembler).toHaveCount(0);
});

test("auto layout has a dedicated one-step position undo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBlueprintStageGame(page);
  const source = page.locator('.react-flow__node[data-id="blueprint_source"]');
  const target = page.locator('.react-flow__node[data-id="blueprint_target"]');
  const before = await Promise.all([source, target].map((node) => node.evaluate((element) => (element as HTMLElement).style.transform)));

  await page.getByLabel("自动整理当前行星布局").click();
  await expect(page.getByLabel("撤销最近一次自动整理")).toBeEnabled();
  await expect.poll(async () => JSON.stringify(await Promise.all([source, target].map((node) => node.evaluate((element) => (element as HTMLElement).style.transform))))).not.toBe(JSON.stringify(before));

  await page.getByLabel("撤销最近一次自动整理").click();
  await expect.poll(async () => Promise.all([source, target].map((node) => node.evaluate((element) => (element as HTMLElement).style.transform)))).toEqual(before);
  await expect(page.getByLabel("撤销最近一次自动整理")).toBeDisabled();
});

test("command palette navigates workspaces, focuses recipes and preserves keyboard flow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededGame(page);
  const offlineReport = page.getByRole("dialog", { name: "离线结算报告" });
  await offlineReport.waitFor({ state: "visible", timeout: 1_000 }).catch(() => undefined);
  if (await offlineReport.isVisible()) {
    await offlineReport.getByRole("button", { name: "确认结算" }).click();
    await expect(offlineReport).toBeHidden();
  }
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible({ timeout: 15_000 });
  await palette.getByLabel("搜索命令").fill("暂停模拟");
  await palette.getByLabel("搜索命令").press("Enter");
  await expect(page.locator(".canvas-status")).toContainText("模拟暂停");
  await expect(page.locator(".interaction-event-feed")).toContainText("模拟已暂停");

  await page.keyboard.press("Control+K");
  await palette.getByLabel("搜索命令").fill("处理器");
  await palette.getByLabel("搜索命令").press("Enter");
  const recipes = page.getByRole("dialog", { name: "生产资料库" });
  await expect(recipes).toBeVisible();
  await expect(recipes.locator(".recipe-item-header")).toContainText("处理器");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+K");
  await expect(palette).toBeVisible();
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/command-palette-390.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("operations center diagnoses equipment and records achievement progress", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/health", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
  await page.route("**/api/public-status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      timeZone: "Asia/Shanghai",
      today: "2026-07-22",
      uptimeSeconds: 3600,
      players: { total: 128, today: 23, online: 7, onlineWindowSeconds: 120 },
    }),
  }));
  await openOperationsStageGame(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await expect(operations).toBeVisible();
  await operations.locator(".operations-tabs").getByRole("tab", { name: /警报/ }).click();

  const minerAlert = operations.locator(".alert-row").filter({ hasText: "铁矿石" });
  await expect(minerAlert).toContainText("电网断电");
  await expect(minerAlert).toContainText("澄海 I");
  await page.screenshot({ path: "artifacts/qa/operations-alerts-1440.png", fullPage: true });

  await minerAlert.click();
  await expect(operations).not.toBeVisible();
  const selectedMiner = page.locator('.react-flow__node[data-id="operations_iron"] .factory-node');
  await expect(selectedMiner).toHaveClass(/factory-node--selected/);
  await expect(page.locator(".inspector-panel")).toContainText("电网断电");
  await expect.poll(async () => {
    const nodeBounds = await selectedMiner.boundingBox();
    const canvasBounds = await page.locator(".factory-canvas").boundingBox();
    if (!nodeBounds || !canvasBounds) return false;
    const nodeCenter = nodeBounds.x + nodeBounds.width / 2;
    const canvasCenter = canvasBounds.x + canvasBounds.width / 2;
    return Math.abs(nodeCenter - canvasCenter) < 90;
  }).toBe(true);

  await page.getByLabel("打开设置").click();
  await operations.locator(".operations-tabs").getByRole("tab", { name: /成就/ }).click();
  await expect(operations.locator(".achievement-row").filter({ hasText: "第一镐" })).toHaveClass(/achievement-row--complete/);
  await expect(operations.locator(".achievement-row").filter({ hasText: "自动化开端" })).toHaveClass(/achievement-row--complete/);
  await expect(operations.locator(".achievement-row").filter({ hasText: "蓝色火花" })).toHaveClass(/achievement-row--complete/);

  await operations.locator(".operations-tabs").getByRole("tab", { name: "诊断反馈" }).click();
  const playerMetrics = operations.locator(".support-status-grid");
  await expect(playerMetrics).toContainText("今日进入工厂");
  await expect(playerMetrics).toContainText("23");
  await expect(playerMetrics).toContainText("累计游玩玩家");
  await expect(playerMetrics).toContainText("128");
  await expect(playerMetrics).toContainText("当前在线游玩");
  await expect(playerMetrics).toContainText("7");
  await expect(playerMetrics).toContainText("120 秒内活跃");
  await expect(operations.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/snowsnow0926/DSPONLINE");
  await page.screenshot({ path: "artifacts/qa/player-metrics-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => operations.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/player-metrics-390.png", fullPage: true });
});

test("operations settings and local save slots persist across reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperationsStageGame(page, "/?storageMigration=production");
  await page.getByLabel("打开设置").click();
  let operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.locator(".settings-category-overview").getByRole("button", { name: "画面与主题" }).click();
  await expect(operations.locator(".settings-community")).toContainText("1076757280");
  const fontScale = operations.getByLabel("字体大小");
  await expect(fontScale.getByRole("button")).toHaveText(["80%", "100%", "125%", "150%", "200%"]);
  await expect(fontScale.getByRole("button", { name: "100%" })).toHaveAttribute("aria-pressed", "true");
  const fillsViewport = () => page.evaluate(() => {
    const root = document.querySelector("#root")?.getBoundingClientRect();
    const shell = document.querySelector(".game-shell")?.getBoundingClientRect();
    return Boolean(root && shell && Math.abs(root.width - window.innerWidth) < 1 && Math.abs(root.height - window.innerHeight) < 1 && Math.abs(shell.width - window.innerWidth) < 1 && Math.abs(shell.height - window.innerHeight) < 1);
  });
  await fontScale.getByRole("button", { name: "125%" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-font-scale"))).toBe("1.25");
  await expect.poll(fillsViewport).toBe(true);
  await fontScale.getByRole("button", { name: "150%" }).click();
  await expect.poll(fillsViewport).toBe(true);
  await fontScale.getByRole("button", { name: "200%" }).click();
  await expect.poll(fillsViewport).toBe(true);
  await expect.poll(async () => operations.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await fontScale.getByRole("button", { name: "125%" }).click();
  await operations.getByRole("button", { name: "4×" }).click();
  await operations.locator(".settings-category-tabs").getByRole("button", { name: "交互与控制" }).click();
  await operations.locator(".setting-row").filter({ hasText: "性能模式" }).click();
  await operations.locator(".setting-row").filter({ hasText: "减少动态效果" }).click();
  await operations.locator(".setting-row").filter({ hasText: "操作音效" }).click();
  await operations.locator(".setting-row").filter({ hasText: "允许双击缩放" }).click();
  await operations.locator(".settings-category-tabs").getByRole("button", { name: "存档与云同步" }).click();
  await operations.getByRole("button", { name: "30 秒" }).click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-performance-mode", "true");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-reduced-motion", "true");

  await page.waitForTimeout(2_000);
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  const beforeManualSave = await page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    return {
      raw: await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1"),
      revision: store.getPrimaryLocalSaveRevision(),
    };
  });
  expect(beforeManualSave.raw).not.toBeNull();
  await operations.getByRole("button", { name: "立即保存" }).click();
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-persistence-kind", "manual");
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "false");
  const afterManualSave = await page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    await store.flushLocalSaveWrites();
    const raw = await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1");
    if (!raw) throw new Error("authoritative primary save is missing");
    return {
      elapsedSeconds: JSON.parse(raw).state.elapsedSeconds as number,
      revision: store.getPrimaryLocalSaveRevision(),
      backup: await store.readPersistedLocalSaveValue("dsp-idle-network.save.v1.backup"),
    };
  });
  expect(afterManualSave.elapsedSeconds).toBeGreaterThan(1.5);
  expect(afterManualSave.revision).toBe(beforeManualSave.revision + 1);
  expect(afterManualSave.backup).toBe(beforeManualSave.raw);

  await operations.getByLabel("保存到槽位 1").click();
  await expect(operations.locator(".save-slot").filter({ hasText: "本地槽位 1" })).toHaveClass(/save-slot--occupied/);
  const downloadPromise = page.waitForEvent("download");
  await operations.getByRole("button", { name: "导出 JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^dsp-idle-save-.*\.json$/);
  await page.screenshot({ path: "artifacts/qa/operations-saves-1440.png", fullPage: true });
  await operations.getByLabel("删除槽位 1").click();
  const deleteDialog = page.getByRole("dialog", { name: "删除本地槽位 1" });
  await expect(deleteDialog).toContainText("第一次确认");
  await deleteDialog.getByRole("button", { name: /继续确认/ }).click();
  const finalDeleteDialog = page.getByRole("alertdialog", { name: "删除本地槽位 1" });
  await expect(finalDeleteDialog).toContainText("第二次确认");
  const backgroundSlot = page.locator(".operations-workspace .save-slot").filter({ hasText: "本地槽位 1" });
  await expect(backgroundSlot).toHaveClass(/save-slot--occupied/);
  await finalDeleteDialog.getByRole("button", { name: /确认永久删除/ }).click();
  await expect(finalDeleteDialog).toHaveCount(0);
  await expect(backgroundSlot).not.toHaveClass(/save-slot--occupied/);

  await page.reload();
  await expect(page.locator(".local-save-writer-banner--conflict")).toHaveCount(0);
  await expect(page.locator(".game-shell")).toHaveAttribute("data-performance-mode", "true");
  await expect(page.locator(".game-shell")).toHaveAttribute("data-reduced-motion", "true");
  await page.getByLabel("打开设置").click();
  operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.locator(".settings-category-tabs").getByRole("button", { name: "画面与主题" }).click();
  await expect(operations.getByLabel("字体大小").getByRole("button", { name: "125%" })).toHaveAttribute("aria-pressed", "true");
  await operations.locator(".settings-category-tabs").getByRole("button", { name: "交互与控制" }).click();
  await expect(operations.locator(".setting-row").filter({ hasText: "性能模式" }).locator('input[type="checkbox"]')).toBeChecked();
  await expect(operations.locator(".setting-row").filter({ hasText: "减少动态效果" }).locator('input[type="checkbox"]')).toBeChecked();
  await expect(operations.locator(".setting-row").filter({ hasText: "操作音效" }).locator('input[type="checkbox"]')).toBeChecked();
  await expect(operations.locator(".setting-row").filter({ hasText: "允许双击缩放" }).locator('input[type="checkbox"]')).toBeChecked();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => operations.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/operations-settings-390.png", fullPage: true });
});

test("failed primary saves stay visible and never report false success", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    const runtime = window as typeof window & {
      __dspAuthoritativeSaveFault?: { enabled: boolean; remainingFailures: number; interceptedFailures: number };
    };
    runtime.__dspAuthoritativeSaveFault = { enabled: false, remainingFailures: 0, interceptedFailures: 0 };
    const NativeWorker = window.Worker;
    const WrappedWorker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        if (!String(args[0]).includes("authoritativeSavePersistence.worker")) return worker;
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: Record<string, unknown>, transferOrOptions?: Transferable[] | StructuredSerializeOptions) => {
          const fault = runtime.__dspAuthoritativeSaveFault;
          if (fault?.enabled && fault.remainingFailures > 0 && message.type === "commit" &&
            message.key === "dsp-idle-network.save.v1" && message.payload instanceof ArrayBuffer) {
            fault.remainingFailures -= 1;
            fault.interceptedFailures += 1;
            const response = {
              id: message.id,
              type: "result",
              result: {
                ok: false,
                reason: "quota",
                message: "synthetic quota",
                retryable: true,
                degraded: true,
              },
              sourcePayloadTransfer: message.payload,
            };
            queueMicrotask(() => worker.dispatchEvent(new MessageEvent("message", { data: response })));
            return;
          }
          if (transferOrOptions === undefined) nativePostMessage(message);
          else nativePostMessage(message, transferOrOptions);
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: WrappedWorker });
  });
  await freshDurableGame(page);
  const shell = page.locator(".game-shell");
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  const readDurablePrimary = () => page.evaluate(async () => {
    const store = await import("/src/game/localSaveStore.ts");
    const { localSaveCatalogRecordKey } = await import("/src/game/localSaveCatalog.ts");
    const { localSaveRevisionKey, parseLocalSaveRevision } = await import("/src/game/localSaveCoordination.ts");
    const key = "dsp-idle-network.save.v1";
    await store.flushLocalSaveWrites();
    await store.reloadLocalSaveCache();
    const revision = parseLocalSaveRevision(await store.readPersistedLocalSaveValue(localSaveRevisionKey(key)));
    const catalog = await store.readPersistedLocalSaveValue(localSaveCatalogRecordKey(key));
    return {
      raw: await store.readPersistedLocalSaveValue(key),
      revision: revision?.revision ?? 0,
      catalog,
    };
  });
  const before = await readDurablePrimary();
  expect(before.raw).not.toBeNull();
  await page.evaluate(() => {
    const fault = (window as typeof window & {
      __dspAuthoritativeSaveFault?: { enabled: boolean; remainingFailures: number; interceptedFailures: number };
    }).__dspAuthoritativeSaveFault;
    if (!fault) throw new Error("authoritative save fault control is missing");
    fault.enabled = true;
    fault.remainingFailures = 2;
  });

  await operations.getByRole("button", { name: "立即保存" }).click();
  const warning = page.getByRole("alert").filter({ hasText: "本地存储空间不足，当前进度尚未保存" });
  await expect(warning).toBeVisible();
  await expect(shell).toHaveAttribute("data-persistence-kind", "manual");
  await expect(shell).toHaveAttribute("data-persistence-phase", "failed", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "false");
  await expect(page.locator(".game-notice")).not.toContainText("主存档已保存");
  expect(await page.evaluate(() => {
    const fault = (window as typeof window & {
      __dspAuthoritativeSaveFault?: { enabled: boolean; remainingFailures: number; interceptedFailures: number };
    }).__dspAuthoritativeSaveFault;
    return fault ? { remainingFailures: fault.remainingFailures, interceptedFailures: fault.interceptedFailures } : null;
  })).toEqual({ remainingFailures: 0, interceptedFailures: 2 });
  const afterFailure = await readDurablePrimary();
  expect(afterFailure).toEqual(before);
  const downloadPromise = page.waitForEvent("download");
  await warning.getByRole("button", { name: "立即导出当前进度" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^dsp-idle-save-\d{4}-\d{2}-\d{2}\.json$/);

  await page.evaluate(() => {
    const fault = (window as typeof window & {
      __dspAuthoritativeSaveFault?: { enabled: boolean; remainingFailures: number; interceptedFailures: number };
    }).__dspAuthoritativeSaveFault;
    if (!fault) throw new Error("authoritative save fault control is missing");
    fault.enabled = false;
  });
  await operations.getByRole("button", { name: "立即保存" }).click();
  await expect(shell).toHaveAttribute("data-persistence-kind", "manual");
  await expect(shell).toHaveAttribute("data-persistence-phase", "complete", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-primary-save-edit-lock", "false", { timeout: 15_000 });
  await expect(warning).toBeHidden();
  const afterRetry = await readDurablePrimary();
  expect(afterRetry.revision).toBe(before.revision + 1);
});

test("font scaling keeps rendered belt endpoints attached to their handles", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEdgeOverlapGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".settings-category-overview").getByRole("button", { name: "画面与主题" }).click();
  const fontScale = operations.getByLabel("字体大小");
  const endpointDistances = () => page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>(".factory-edge-visual-path");
    const source = document.querySelector<HTMLElement>('.react-flow__node[data-id="overlap_source"] .factory-handle--output');
    const target = document.querySelector<HTMLElement>('.react-flow__node[data-id="overlap_target"] [data-handleid="in:iron_ingot"]');
    const matrix = path?.getScreenCTM();
    if (!path || !source || !target || !matrix) return [999, 999];
    const start = path.getPointAtLength(0).matrixTransform(matrix);
    const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const sourceCenter = { x: sourceBounds.left + sourceBounds.width / 2, y: sourceBounds.top + sourceBounds.height / 2 };
    const targetCenter = { x: targetBounds.left + targetBounds.width / 2, y: targetBounds.top + targetBounds.height / 2 };
    return [Math.hypot(start.x - sourceCenter.x, start.y - sourceCenter.y), Math.hypot(end.x - targetCenter.x, end.y - targetCenter.y)];
  });

  for (const scale of ["125%", "150%", "200%"] as const) {
    await fontScale.getByRole("button", { name: scale }).click();
    await expect.poll(async () => Math.max(...await endpointDistances())).toBeLessThan(10);
  }
});

test("save preview, snapshots, content-pack validation and simulation diagnostics stay recoverable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOperationsStageGame(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();
  await operations.getByRole("button", { name: "立即保存" }).click();
  await operations.getByRole("button", { name: "创建快照" }).click();
  await expect(operations.locator(".save-snapshot-row").first()).toBeVisible();

  const savedRaw = await page.evaluate(() => window.localStorage.getItem("dsp-idle-network.save.v1"));
  expect(savedRaw).toContain("checksum");
  await operations.locator('input[aria-label="选择要导入的存档文件"]').setInputFiles({
    name: "preview.json",
    mimeType: "application/json",
    buffer: Buffer.from(savedRaw!, "utf8"),
  });
  await expect(operations.locator(".save-import-preview")).toBeVisible();
  await expect(operations.locator(".save-import-preview")).toContainText("校验通过");
  await operations.locator(".save-import-preview").getByRole("button", { name: "确认导入" }).click();
  await expect(operations.locator(".save-import-preview")).toBeHidden({ timeout: 1_000 });
  await expect(page.locator(".game-shell")).toHaveAttribute("data-persistence-phase", "complete", { timeout: 30_000 });
  await expect.poll(async () => page.evaluate(async () => {
    const localStore = await import("/src/game/localSaveStore.ts");
    return {
      role: localStore.getLocalSaveWriterStatus().role,
      conflicts: await localStore.getLocalSaveConflicts(),
    };
  }), { timeout: 5_000 }).toEqual({ role: "primary", conflicts: [] });
  await expect(operations).toBeHidden({ timeout: 30_000 });
  await page.getByLabel("打开设置").click();
  const reopenedOperations = page.getByRole("dialog", { name: "运营中心" });
  await expect(reopenedOperations).toBeVisible();
  await reopenedOperations.locator(".operations-tabs").getByRole("tab", { name: "存档" }).click();

  const packRaw = JSON.stringify({
    formatVersion: 1,
    id: "qa_pack",
    name: "QA 内容包",
    version: "0.1.0",
    items: [{ id: "qa_crystal", name: "QA 晶体", symbol: "Q", kind: "solid", description: "内容包回归物品" }],
  });
  await reopenedOperations.locator('input[aria-label="选择内容包文件"]').setInputFiles({
    name: "pack.json",
    mimeType: "application/json",
    buffer: Buffer.from(packRaw, "utf8"),
  });
  await expect(reopenedOperations.locator(".content-pack-result--valid")).toContainText("内容包校验通过");

  await reopenedOperations.locator(".operations-tabs").getByRole("tab", { name: "内容包" }).click();
  await reopenedOperations.locator('input[aria-label="选择要注册的内容包"]').setInputFiles({
    name: "pack.json",
    mimeType: "application/json",
    buffer: Buffer.from(packRaw, "utf8"),
  });
  await expect(reopenedOperations.locator(".content-pack-registration--valid")).toContainText("QA 内容包");
  await reopenedOperations.getByRole("button", { name: "注册并启用" }).click();
  await expect(reopenedOperations.locator(".content-pack-card--enabled")).toContainText("QA 内容包");

  await page.reload();
  await page.getByLabel("打开设置").click();
  const persistedOperations = page.getByRole("dialog", { name: "运营中心" });
  await persistedOperations.locator(".operations-tabs").getByRole("tab", { name: "内容包" }).click();
  await expect(persistedOperations.locator(".content-pack-card--enabled")).toContainText("QA 内容包");

  await persistedOperations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(persistedOperations, "统计与运行记录", "statistics");
  await persistedOperations.getByRole("button", { name: "运行 60 秒基准" }).click();
  await expect(page.locator(".game-notice")).toContainText("自动性能报告通过");
  await expect(persistedOperations.locator(".automatic-performance-report")).toContainText("确定性");
  await page.screenshot({ path: "artifacts/qa/save-recovery-1440.png", fullPage: true });
});

test("offline report summarizes production before entering the factory", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOfflineStageGame(page);
  const report = page.getByRole("dialog", { name: "离线结算报告" });
  await expect(report).toBeVisible();
  await expect(report.locator(".offline-runtime")).toContainText("秒");
  await expect(report.locator(".offline-production-list")).toContainText("铁矿石");
  await expect(report.locator(".offline-production-list").getByText(/^\+\d+/).first()).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/offline-report-1440.png", fullPage: true });
  await report.getByRole("button", { name: "确认结算" }).click();
  await expect(report).not.toBeVisible();
});

test("running equipment uses semantic animation and reduced motion disables it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openOfflineStageGame(page);
  await page.getByRole("dialog", { name: "离线结算报告" }).getByRole("button", { name: "确认结算" }).click();
  await page.locator(".react-flow__controls-fitview").click();
  const runningNode = page.locator(".factory-node--status-running").first();
  await expect(runningNode).toBeVisible();
  await expect(runningNode.locator(".work-cycle--active")).toBeVisible();
  await expect.poll(async () => runningNode.evaluate((element) => getComputedStyle(element, "::after").animationName)).toContain("factory-node-scan");
  await expect.poll(async () => runningNode.locator(".work-cycle--active > i").evaluate((element) => getComputedStyle(element, "::after").animationName)).toContain("factory-cycle-sheen");
  await page.screenshot({ path: "artifacts/qa/animation-feedback-1440.png", fullPage: true });

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(operations, "交互与控制", "interaction");
  await operations.locator(".setting-row").filter({ hasText: "减少动态效果" }).click();
  await operations.getByLabel("关闭运营中心").click();
  const durationMs = await runningNode.evaluate((element) => {
    const value = getComputedStyle(element, "::after").animationDuration;
    return value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
  });
  expect(durationMs).toBeLessThanOrEqual(0.02);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".react-flow__controls-fitview").click();
  await expect(page.locator(".factory-canvas").evaluate((element) => element.scrollWidth <= element.clientWidth)).resolves.toBe(true);
  await page.screenshot({ path: "artifacts/qa/animation-feedback-390.png", fullPage: true });
});

test("placement preview, selection focus and keyboard recycle keep canvas work direct", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await page.getByTitle("部署风力涡轮机").click();
  const canvas = page.locator(".react-flow__pane");
  const canvasBounds = await canvas.boundingBox();
  await page.mouse.move(canvasBounds!.x + canvasBounds!.width * 0.72, canvasBounds!.y + 230);
  const preview = page.locator(".building-placement-cursor");
  await expect(preview).toContainText("风力涡轮机");
  await expect(preview).toContainText("×1");
  await page.screenshot({ path: "artifacts/qa/interaction-placement-1440.png", fullPage: true });

  await canvas.click({ position: { x: Math.round(canvasBounds!.width * 0.72), y: 230 } });
  await expect(preview).not.toBeVisible();
  const turbine = page.locator(".power-node").filter({ hasText: "风力涡轮机" });
  await turbine.click();
  await page.getByLabel("定位到所选设备").click();
  await expect.poll(async () => {
    const nodeBounds = await turbine.boundingBox();
    const visibleCanvas = await page.locator(".factory-canvas").boundingBox();
    if (!nodeBounds || !visibleCanvas) return false;
    return Math.abs(nodeBounds.x + nodeBounds.width / 2 - (visibleCanvas.x + visibleCanvas.width / 2)) < 90;
  }).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("toolbar", { name: "选区操作" })).toBeVisible();
  await page.getByLabel("打开检查器").click();
  await expect.poll(async () => page.locator(".inspector-panel").evaluate((element) =>
    element.getBoundingClientRect().left >= window.innerWidth - 1)).toBe(true);
  await page.getByLabel("定位到所选设备").click();
  await expect.poll(async () => {
    const bounds = await turbine.boundingBox();
    return Boolean(bounds && Math.abs(bounds.x + bounds.width / 2 - 195) < 70);
  }).toBe(true);
  await expect.poll(async () => page.evaluate(() => [
    ".game-header",
    '[role="toolbar"][aria-label="选区操作"]',
    ".construction-dock",
  ].filter((selector) => {
    const bounds = document.querySelector(selector)?.getBoundingClientRect();
    return !bounds || bounds.left < -1 || bounds.right > window.innerWidth + 1;
  }))).toEqual([]);
  await page.screenshot({ path: "artifacts/qa/interaction-selection-390.png", fullPage: true });
  await page.keyboard.press("Delete");
  await expect(turbine).not.toBeVisible();
  await expect(page.getByTitle("部署风力涡轮机")).toContainText("×3");
  await expect(page.locator(".game-notice")).toContainText("已回收 1 个设备与 0 条运输线");
});

test("large workspaces load on demand with polished desktop and mobile hierarchy", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let technologyModuleRequested = false;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/src/components/TechnologyWorkspace.tsx")) {
      technologyModuleRequested = true;
    }
  });
  await openTechnologyUpgradeGame(page);
  expect(technologyModuleRequested).toBe(false);

  await page.getByLabel("打开科技树").click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  await expect(technology).toBeVisible();
  await technology.getByLabel("展开科研详情").click();
  await expect.poll(() => technologyModuleRequested).toBe(true);
  await expect(technology.locator(".technology-upgrade-overview")).toBeVisible();
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/frontend-polish-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => technology.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(technology.locator(".technology-upgrade-overview")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/frontend-polish-390.png", fullPage: true });
});

test("construction dock hides locked equipment until its technology is completed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await expect(page.getByTitle("部署风力涡轮机")).toBeVisible();
  await expect(page.getByTitle("部署电弧熔炉")).toBeVisible();
  await expect(page.getByTitle("部署太阳能板")).toHaveCount(0);
  await expect(page.getByTitle("部署位面熔炉")).toHaveCount(0);
  await expect(page.getByTitle("部署制造台 Mk.II", { exact: true })).toHaveCount(0);

  await page.getByTitle("保存并返回主菜单").click();
  await expect(page.locator(".start-menu")).toBeVisible();
  await page.evaluate(async () => {
    const storage = await import("/src/game/storage.ts");
    const state = storage.loadGame().state;
    state.research.completedTechIds = [...new Set([...state.research.completedTechIds, "solar_energy"])] as typeof state.research.completedTechIds;
    const result = await storage.saveGameVerified(state);
    if (!result.success) throw new Error(result.message);
  });
  await page.reload();
  await expect(page.getByTitle("部署太阳能板")).toBeVisible();
});

test("workspace hierarchy filters construction, collapses rails and adapts detail level", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  const canvas = page.locator(".factory-canvas");
  const canvasBefore = await canvas.boundingBox();

  const category = page.getByLabel("施工托盘分类");
  await expect(category).toHaveValue("all");
  await category.selectOption("power");
  await expect(page.getByTitle("部署风力涡轮机")).toBeVisible();
  await expect(page.getByTitle("部署电弧熔炉")).toHaveCount(0);
  await category.selectOption("all");

  await page.getByLabel("开启施工托盘精简模式").click();
  await expect(page.locator(".construction-dock")).toHaveClass(/construction-dock--compact/);
  await expect.poll(() => page.locator(".construction-items").evaluate((element) => getComputedStyle(element).gridTemplateRows.split(" ").length)).toBe(2);
  const compactItem = page.locator(".construction-item").first();
  const compactLabel = compactItem.locator(":scope > span");
  const compactCount = compactItem.locator(":scope > strong");
  await expect.poll(() => compactLabel.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(10);
  await expect(compactCount).toHaveCSS("position", "absolute");
  await expect.poll(() => compactCount.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBeLessThanOrEqual(0.2);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("dsp-idle-network.construction-compact.v1"))).toBe("true");
  await page.screenshot({ path: "artifacts/qa/construction-compact-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(220);
  await expect.poll(() => compactLabel.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(9);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-compact-390.png", fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(220);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-compact-844x390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(220);

  await page.getByLabel("折叠物资侧栏").click();
  await expect(page.locator(".resource-rail")).toBeHidden();
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(canvasBefore!.width + 180);
  await page.getByLabel("展开物资侧栏").click();
  await expect(page.locator(".resource-rail")).toBeVisible();

  const vein = page.locator(".vein-node").first();
  const nodeHeight = await vein.evaluate((element) => (element as HTMLElement).offsetHeight);
  for (let index = 0; index < 4; index += 1) await page.locator(".react-flow__controls-zoomout").click();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-zoom-lod", "compact");
  await expect(vein.locator(".manual-mine")).toHaveCSS("opacity", "0.12");
  await expect.poll(async () => vein.evaluate((element) => (element as HTMLElement).offsetHeight)).toBe(nodeHeight);

  await page.getByLabel("打开主线任务中心").first().click();
  const firstChapter = page.locator(".campaign-chapter").first();
  await firstChapter.locator(".campaign-chapter-header").click();
  await expect(firstChapter.locator(".campaign-chapter-header")).toHaveAttribute("aria-expanded", "false");
  await expect(firstChapter.locator(".campaign-task-list")).toHaveCount(0);
});

test("canvas overlays fold and horizontal surfaces support direct panning", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);

  const contextMenuPolicy = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".factory-canvas")!;
    const input = document.querySelector<HTMLInputElement>(".tray-limit-control input")!;
    const canvasEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    const inputEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    canvas.dispatchEvent(canvasEvent);
    input.dispatchEvent(inputEvent);
    return { canvasPrevented: canvasEvent.defaultPrevented, inputPrevented: inputEvent.defaultPrevented };
  });
  expect(contextMenuPolicy).toEqual({ canvasPrevented: true, inputPrevented: false });

  await page.getByLabel("折叠行星切换").click();
  await expect(page.getByLabel("展开行星切换")).toBeVisible();
  await expect(page.locator(".planet-navigator button")).toHaveCount(1);
  await page.getByLabel("展开行星切换").click();

  await page.getByLabel("折叠画布工具").click();
  await expect(page.getByLabel("指针模式")).toHaveCount(0);
  await page.getByLabel("展开画布工具").click();
  await expect(page.getByLabel("指针模式")).toBeVisible();

  await expect(page.locator(".react-flow__minimap")).toBeVisible();
  await page.getByLabel("折叠小地图").click();
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await page.getByLabel("展开小地图").click();

  const constructionItems = page.locator(".construction-items");
  await constructionItems.evaluate((element) => { element.scrollLeft = 0; });
  await constructionItems.dispatchEvent("wheel", { deltaY: 720, deltaX: 0 });
  await expect.poll(() => constructionItems.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await constructionItems.evaluate((element) => { element.scrollLeft = 0; });
  const dockBox = await constructionItems.boundingBox();
  await page.mouse.move(dockBox!.x + dockBox!.width - 40, dockBox!.y + dockBox!.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(dockBox!.x + dockBox!.width - 320, dockBox!.y + dockBox!.height / 2, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => constructionItems.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  await page.getByLabel("打开科技树").click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  await expect(technology.getByLabel("展开科研详情")).toBeVisible();
  await expect(technology.locator(".technology-upgrade-overview")).toHaveCount(0);
  const technologyTree = technology.locator(".technology-tree");
  const scrollParentsBefore = await technology.evaluate((element) => ({
    dialog: element.scrollTop,
    document: document.scrollingElement?.scrollTop ?? 0,
  }));
  await technologyTree.evaluate((element) => { element.scrollLeft = 0; element.scrollTop = 0; });
  await technologyTree.dispatchEvent("wheel", { deltaY: 760, deltaX: 0 });
  await expect.poll(() => technologyTree.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(technologyTree.evaluate((element) => element.scrollTop)).resolves.toBe(0);
  await technologyTree.dispatchEvent("wheel", { deltaY: 420, deltaX: 260 });
  await technologyTree.dispatchEvent("wheel", { deltaY: 420, deltaX: -180 });
  await expect(technologyTree.evaluate((element) => element.scrollTop)).resolves.toBe(0);
  await expect(technology.evaluate((element) => ({ dialog: element.scrollTop, document: document.scrollingElement?.scrollTop ?? 0 }))).resolves.toEqual(scrollParentsBefore);
  await technologyTree.evaluate((element) => { element.scrollLeft = element.scrollWidth; element.scrollTop = 0; });
  for (let index = 0; index < 3; index += 1) await technologyTree.dispatchEvent("wheel", { deltaY: 900, deltaX: 240 });
  await expect(technologyTree.evaluate((element) => element.scrollTop)).resolves.toBe(0);
  await expect(technology.evaluate((element) => ({ dialog: element.scrollTop, document: document.scrollingElement?.scrollTop ?? 0 }))).resolves.toEqual(scrollParentsBefore);
  await technologyTree.evaluate((element) => { element.scrollLeft = 0; });
  const treeBox = await technologyTree.boundingBox();
  await page.mouse.move(treeBox!.x + treeBox!.width - 40, treeBox!.y + 70);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(treeBox!.x + treeBox!.width - 320, treeBox!.y + 70, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => technologyTree.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await technology.getByLabel("展开科研详情").click();
  await expect(technology.locator(".technology-upgrade-overview")).toBeVisible();
});

test("sub-360 header moves workspaces into an overflow menu", async ({ page }) => {
  await page.setViewportSize({ width: 350, height: 760 });
  await freshGame(page);
  await expect(page.getByLabel("更多工作区")).toBeVisible();
  await expect(page.getByLabel("打开科技树")).toBeHidden();
  await page.getByLabel("更多工作区").click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "科技树" }).click();
  await expect(page.getByRole("dialog", { name: "科技树" })).toBeVisible();
});

test("performance mode keeps a 500-device 1000-line factory responsive", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStressStageGame(page);
  const shell = page.locator(".game-shell");
  await expect(shell).toHaveAttribute("data-performance-mode", "true");
  await expect.poll(async () => shell.getAttribute("data-simulation-worker")).toBe("active");

  const renderedNodes = await page.locator(".react-flow__node").count();
  expect(renderedNodes).toBeGreaterThan(0);
  expect(renderedNodes).toBeLessThan(120);
  const frameLatency = await page.evaluate(() => new Promise<number>((resolve) => {
    const started = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
  }));
  expect(frameLatency).toBeLessThan(500);

  const blankPoint = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    for (let y = rect.top + 24; y < rect.bottom - 24; y += 24) {
      for (let x = rect.left + 24; x < rect.right - 24; x += 24) {
        const elements = document.elementsFromPoint(x, y);
        const blocked = elements.some((element) => element.closest(".react-flow__node, .react-flow__controls, .react-flow__minimap, .react-flow__panel"));
        if (!blocked && elements.includes(pane)) return { x, y };
      }
    }
    return null;
  });
  expect(blankPoint).not.toBeNull();
  await page.getByTitle("部署风力涡轮机").click();
  await page.mouse.click(blankPoint!.x, blankPoint!.y);
  await expect(page.locator(".power-node")).toHaveCount(1);
  await page.waitForTimeout(650);
  await expect(page.locator(".power-node")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/stress-factory-1440.png", fullPage: true });
});
