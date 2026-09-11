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


test("dragging matching ports creates a belt connection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);

  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署电弧熔炉", Math.round(box!.width * 0.62), 260);
  const source = page.locator(".vein-node").filter({ hasText: "铁矿石" }).locator(".factory-handle--output");
  const target = page.locator(".machine-node").filter({ hasText: "铁块" }).locator(".factory-handle--input:not(.factory-handle--auto)");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(sourceBox!.width).toBeGreaterThanOrEqual(14.5);
  expect(targetBox!.width).toBeGreaterThanOrEqual(14.5);
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();

  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator(".game-notice")).toContainText(/铁矿石运输线已建立|成就解锁：物流脉搏/);
  await expect(page.getByText("0.0 / 6 s⁻¹")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/belt-connection-1280.png", fullPage: true });
});

test("technology selection reaches the matrix lab research mode", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  await page.getByLabel("打开科技树").click();
  const firstTechnology = page.locator(".technology-node").filter({ hasText: "电磁矩阵" }).first();
  await firstTechnology.click();
  await expect(page.locator(".research-focus")).toContainText("电磁矩阵");
  await page.screenshot({ path: "artifacts/qa/technology-tree-1280.png", fullPage: true });
  await page.getByLabel("关闭科技树").click();

  const canvas = page.locator(".react-flow__pane");
  const canvasBox = await canvas.boundingBox();
  await placeOnCanvas(page, "部署矩阵研究站", Math.round(canvasBox!.width * 0.63), 270);
  const lab = page.locator(".machine-node").filter({ hasText: "电磁矩阵" });
  await lab.click();
  await chooseRecipe(page, lab, "科研模式");
  await expect(lab).toContainText("科研模式");
  await expect(lab).toContainText("电磁矩阵");
  await page.screenshot({ path: "artifacts/qa/technology-research-1280.png", fullPage: true });
});

test("technology queue accepts a planned chain and cascades removals", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  await page.getByLabel("打开科技树").click();
  await page.locator(".technology-node").filter({ hasText: "电磁矩阵" }).first().click();
  const electromagnetism = page.locator(".technology-node").filter({ has: page.getByText("电磁学", { exact: true }) });
  const basicLogistics = page.locator(".technology-node").filter({ has: page.getByText("基础物流系统", { exact: true }) });
  await electromagnetism.click();
  await basicLogistics.click();
  await expect(page.locator(".research-queue__item")).toHaveCount(2);
  await expect(page.locator(".research-queue")).toContainText("电磁学");
  await expect(page.locator(".research-queue")).toContainText("基础物流系统");

  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.locator(".technology-node--paused")).toContainText("电磁矩阵");
  await expect(page.locator(".research-focus")).toContainText("研究已暂停");
  await expect(page.locator(".research-queue__item")).toHaveCount(2);
  await page.getByRole("button", { name: "继续研究", exact: true }).click();
  await expect(page.locator(".technology-node--active")).toContainText("电磁矩阵");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".research-focus")).toContainText("未选择科技");
  await expect(page.locator(".research-queue__item")).toHaveCount(2);
  await page.locator(".technology-node").filter({ hasText: "电磁矩阵" }).first().click();

  await page.getByLabel("从科研队列移除电磁学").click();
  await expect(page.locator(".research-queue__item")).toHaveCount(0);
  await electromagnetism.click();
  await basicLogistics.click();
  await page.screenshot({ path: "artifacts/qa/technology-queue-1280.png", fullPage: true });
});

test("yellow matrix industry exposes remote resources, chemistry and three-color research", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openYellowStageGame(page);
  const water = page.locator(".vein-node").filter({ hasText: "海洋水源" });
  await expect(water).toHaveCount(1);

  await page.locator(".react-flow__controls-fitview").click();
  await page.getByTitle("部署抽水站").click();
  await water.click();
  await expect(water).toContainText("抽水站 ×1");

  await page.getByTitle("切换到烬原 II").click();
  await expect(page.locator(".planet-transition")).toContainText("烬原 II");
  await page.screenshot({ path: "artifacts/qa/planet-transition-1440.png", fullPage: true });
  await expect(page.locator(".vein-node").filter({ has: page.getByText("硅石", { exact: true }) })).toHaveCount(1);
  await expect(page.locator(".vein-node").filter({ has: page.getByText("钛石", { exact: true }) })).toHaveCount(1);
  await expect(page.locator(".vein-node").filter({ hasText: "硫酸海洋" })).toHaveCount(1);
  await expect(page.locator(".vein-node").filter({ hasText: "海洋水源" })).toHaveCount(0);
  await page.getByTitle("切换到澄海 I").click();

  const chemicalPlant = page.locator(".machine-node").filter({ hasText: "塑料" });
  await chemicalPlant.click();
  await chooseRecipe(page, chemicalPlant, "有机晶体");
  await expect(chemicalPlant).toContainText("有机晶体");
  await expect(chemicalPlant.getByTitle("投入水")).toBeVisible();

  const matrixLab = page.locator(".machine-node").filter({ hasText: "电磁矩阵" });
  await matrixLab.click();
  await chooseRecipe(page, matrixLab, "结构矩阵");
  const structureLab = page.locator(".machine-node").filter({ hasText: "结构矩阵" });
  await expect(structureLab).toContainText("结构矩阵");
  await expect(structureLab.getByTitle("投入金刚石")).toBeVisible();
  await expect(structureLab.getByTitle("投入钛晶石")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/yellow-industry-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  const interstellar = page.locator(".technology-node").filter({ has: page.getByText("星际物流系统", { exact: true }) });
  await interstellar.click();
  await expect(page.locator(".research-focus")).toContainText("星际物流系统");
  await expect(page.locator(".research-cost-list")).toContainText("0/20");
  await page.screenshot({ path: "artifacts/qa/yellow-technology-1440.png", fullPage: true });
});

test("planet navigation exposes independent factories and a live interstellar route", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInterstellarGame(page);
  await expect(page.locator(".tray-row").filter({ hasText: "铁矿石" })).toBeVisible();
  await expect(page.locator(".tray-row").filter({ hasText: "钛石" })).toHaveCount(0);
  await expect(page.locator(".construction-item").filter({ hasText: "星际物流站" })).toHaveCount(1);
  const homeStation = page.locator(".station-node");
  await expect(homeStation).toContainText("供应");
  await expect(homeStation).toContainText("运输船航程");

  await page.getByTitle("切换到烬原 II").click();
  await expect(page.locator(".tray-row").filter({ hasText: "钛石" })).toBeVisible();
  await expect(page.locator(".tray-row").filter({ hasText: "铁矿石" })).toHaveCount(0);
  await expect(page.locator(".brand-lockup")).toContainText("DSP极简网络");
  await expect(page.locator(".vein-node").filter({ hasText: "钛石" })).toBeVisible();
  await expect(page.locator(".vein-node").filter({ hasText: "原油" })).toHaveCount(0);
  const demandStation = page.locator(".station-node");
  await expect(demandStation).toContainText("需求");
  await expect(demandStation).toContainText("1/10 舰队");
  await expect.poll(async () => Number(await demandStation.getByTitle("拿取钛块").locator("strong").textContent())).toBe(100);
  await demandStation.click();
  await expect(page.locator(".station-inspector")).toContainText("澄海 I");
  await expect(page.locator(".station-inspector")).toContainText("最近运量");
  await expect(page.locator(".station-inspector")).toContainText("100");
  await expect(page.locator(".station-fleet-control .station-fleet-summary strong")).toContainText("1 / 10");
  await expect(page.getByRole("button", { name: "100%", exact: true })).toHaveClass(/active/);
  await page.screenshot({ path: "artifacts/qa/interstellar-logistics-1440.png", fullPage: true });
});

test("cursor cargo hand-carries a titanium stack between planets", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openHandCarryGame(page);
  await page.locator(".tray-row").filter({ hasText: "钛块" }).click();
  await expect(page.locator(".cargo-block")).toContainText("手提星际载荷");
  await expect(page.locator(".cargo-slot")).toContainText("钛块");
  await expect(page.locator(".cargo-slot")).toContainText("×40");
  await expect(page.locator(".cargo-block")).toHaveClass(/rail-block--cargo-drop/);
  await expect(page.locator(".tray-block")).toHaveClass(/rail-block--cargo-drop/);
  await expect(page.locator(".mobile-toggle--cargo")).toHaveCount(1);

  await page.getByTitle("切换到烬原 II").click();
  await expect(page.locator(".cargo-slot")).toContainText("钛块");
  await expect(page.getByRole("status")).toContainText("托钛天王：钛块 ×40 已抵达烬原 II");
  await page.screenshot({ path: "artifacts/qa/hand-carry-titanium-1280.png", fullPage: true });
  await expect(page.locator(".planet-transition")).toBeHidden({ timeout: 3_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("打开物资托盘").click();
  await expect(page.locator(".cargo-slot")).toContainText("钛块");
  await expect.poll(async () => Math.round((await page.locator(".resource-rail").boundingBox())?.x ?? -999)).toBe(0);
  await expect.poll(async () => Math.round((await page.locator(".resource-rail").boundingBox())?.width ?? 0)).toBeGreaterThan(300);
  await expect.poll(async () => Math.round((await page.locator(".inspector-panel").boundingBox())?.x ?? 0)).toBeGreaterThanOrEqual(390);
  await page.screenshot({ path: "artifacts/qa/hand-carry-titanium-390.png", fullPage: true });
  await page.locator(".cargo-slot").click();
  await expect(page.locator(".tray-row").filter({ hasText: "钛块" })).toContainText("40");

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.getByTitle("切换到澄海 I").click();
  await expect(page.locator(".tray-row").filter({ hasText: "钛块" })).toHaveCount(0);
  await page.getByTitle("切换到烬原 II").click();
  await expect(page.locator(".tray-row").filter({ hasText: "钛块" })).toContainText("40");
});

test("purple matrix industry exposes its full recipe and four-color research loop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPurpleStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const chemical = page.locator(".machine-node").filter({ hasText: "石墨烯" });
  await expect(chemical.getByTitle("投入高能石墨")).toBeVisible();
  await expect(chemical.getByTitle("投入硫酸")).toBeVisible();
  await chemical.click();
  await chooseRecipe(page, chemical, "碳纳米管");
  await expect(chemical).toContainText("碳纳米管");
  await expect(chemical.getByTitle("投入钛块")).toBeVisible();

  const smelter = page.locator(".machine-node").filter({ hasText: "晶格硅" });
  await expect(smelter.getByTitle("投入高纯硅块")).toBeVisible();
  const assembler = page.locator(".machine-node").filter({ hasText: "粒子宽带" });
  await expect(assembler.getByTitle("投入碳纳米管")).toBeVisible();
  await expect(assembler.getByTitle("投入晶格硅")).toBeVisible();
  await expect(assembler.getByTitle("投入塑料")).toBeVisible();
  const lab = page.locator(".machine-node").filter({ hasText: "信息矩阵" });
  await expect(lab.getByTitle("投入粒子宽带")).toBeVisible();
  await expect(lab.getByTitle("投入处理器")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/purple-industry-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  await expect(page.locator(".matrix-stock").filter({ hasText: "Inf" })).toContainText("7");
  const researchSpeed = page.locator(".technology-node").filter({ has: page.getByText("科研速度 I", { exact: true }) });
  await researchSpeed.click();
  await expect(page.locator(".research-focus")).toContainText("科研速度 I");
  await expect(page.locator(".research-cost-list > span")).toHaveCount(4);
  await page.screenshot({ path: "artifacts/qa/purple-technology-1440.png", fullPage: true });
});

test("green matrix industry exposes particle collision, dense fuel and five-color research", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGreenStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  await expect(page.locator(".construction-item").filter({ hasText: "微型粒子对撞机" })).toHaveCount(1);

  const thermal = page.locator(".power-node").filter({ hasText: "火力发电厂" });
  await thermal.click();
  await expect(page.locator(".inspector-content")).toContainText("氘核燃料棒");
  await expect(page.locator(".inspector-content")).toContainText("600 MJ");

  const collider = page.locator(".machine-node").filter({ has: page.getByText("对撞机", { exact: true }) }).filter({ hasText: "氘富集" });
  await expect(collider.getByTitle("投入氢")).toBeVisible();
  await expect(collider.getByTitle("拿取氘")).toBeVisible();
  await collider.click();
  await chooseRecipe(page, collider, "奇异物质");
  const strangeCollider = page.locator(".machine-node").filter({ has: page.getByText("对撞机", { exact: true }) }).filter({ hasText: "奇异物质" });
  await expect(strangeCollider.getByTitle("投入粒子容器")).toBeVisible();
  await expect(strangeCollider.getByTitle("投入氘")).toBeVisible();

  const assembler = page.locator(".machine-node").filter({ has: page.getByText("制造台", { exact: true }) }).filter({ hasText: "量子芯片" });
  await expect(assembler.getByTitle("投入处理器")).toBeVisible();
  await expect(assembler.getByTitle("投入位面过滤器")).toBeVisible();
  await assembler.click();
  await chooseRecipe(page, assembler, "引力透镜");
  const lensAssembler = page.locator(".machine-node").filter({ has: page.getByText("制造台", { exact: true }) }).filter({ hasText: "引力透镜" });
  await expect(lensAssembler.getByTitle("投入金刚石")).toBeVisible();
  await expect(lensAssembler.getByTitle("投入奇异物质")).toBeVisible();

  const lab = page.locator(".machine-node").filter({ hasText: "引力矩阵" });
  await expect(lab.getByTitle("投入引力透镜")).toBeVisible();
  await expect(lab.getByTitle("投入量子芯片")).toBeVisible();
  await strangeCollider.click();
  await page.screenshot({ path: "artifacts/qa/green-industry-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  await expect(page.locator(".matrix-stock").filter({ hasText: "Grv" })).toContainText("7");
  const researchSpeed = page.locator(".technology-node").filter({ has: page.getByText("科研速度 II", { exact: true }) });
  await researchSpeed.click();
  await expect(page.locator(".research-focus")).toContainText("科研速度 II");
  await expect(page.locator(".research-cost-list > span")).toHaveCount(5);
  await page.screenshot({ path: "artifacts/qa/green-technology-1440.png", fullPage: true });
});

test("Dyson swarm closes the critical photon, antimatter and universe matrix loop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWhiteStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  await expect(page.locator(".dyson-block")).toContainText("在轨太阳帆");
  await expect(page.locator(".dyson-block .dyson-load > strong .power-value > span:first-child")).toHaveText("6 MW");
  await expect(page.locator(".dyson-block")).toContainText("理论接收");
  await expect(page.locator(".dyson-block")).toContainText("接收站利用");
  await expect(page.locator(".dyson-block")).toContainText("功率利用");
  await expect(page.locator(".construction-item").filter({ hasText: "电磁轨道弹射器" })).toHaveCount(1);
  await expect(page.locator(".construction-item").filter({ hasText: "射线接收站" })).toHaveCount(1);

  const ejector = page.locator(".machine-node").filter({ hasText: "太阳帆发射" });
  await expect(ejector.getByTitle("取出太阳帆")).toBeVisible();
  await expect(ejector).toContainText("累计");

  const receiver = page.locator(".machine-node").filter({ hasText: "戴森系统接收设施" });
  await expect(receiver.getByTitle("拿取临界光子")).toBeVisible();
  await receiver.click();
  await chooseRecipe(page, receiver, "电力接收");
  await expect(receiver.locator(".ray-reception")).toContainText("连续接收");
  await expect(receiver.locator(".ray-reception .power-value > span:first-child")).toHaveText("6 MW");
  await expect(receiver).toContainText("接收");
  await expect(receiver).not.toContainText("NaN");

  const collider = page.locator(".machine-node").filter({ hasText: "质能转换" });
  await expect(collider.getByTitle("投入临界光子")).toBeVisible();
  await expect(collider.getByTitle("拿取反物质")).toBeVisible();
  const fuelAssembler = page.locator(".machine-node").filter({ hasText: "反物质燃料棒" });
  await expect(fuelAssembler.getByTitle("投入反物质")).toBeVisible();
  await expect(fuelAssembler.getByTitle("投入湮灭约束球")).toBeVisible();
  const whiteLab = page.locator(".machine-node").filter({ hasText: "宇宙矩阵" });
  await expect(whiteLab.getByTitle("投入引力矩阵")).toBeVisible();
  await expect(whiteLab.getByTitle("投入反物质")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/white-industry-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  await expect(page.locator(".matrix-stock").filter({ hasText: "Uni" })).toContainText("7");
  const researchSpeed = page.locator(".technology-node").filter({ has: page.getByText("科研速度 III", { exact: true }) });
  await researchSpeed.click();
  await expect(page.locator(".research-focus")).toContainText("科研速度 III");
  await expect(page.locator(".research-cost-list > span")).toHaveCount(6);
  await page.screenshot({ path: "artifacts/qa/white-technology-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".matrix-stock")).toHaveCount(6);
  await expect(page.getByText("科研速度 III", { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/white-technology-390.png", fullPage: true });
});

test("carrier rockets turn the Dyson cloud into a permanent sphere", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDysonSphereStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const dyson = page.locator(".dyson-block");
  await expect(dyson).toContainText("永久结构运行");
  await expect(dyson).toContainText("30点");
  await expect(dyson).toContainText("300 / 1,200");
  await expect(dyson.locator(".dyson-load > span .power-value > span:first-child")).toHaveText("55.2 MW");
  await expect(dyson).toContainText("总功率");
  await expect(dyson).toContainText("运载火箭 30");
  await expect(dyson).toContainText("永久吸附 300");
  await expect(page.locator(".construction-item").filter({ hasText: "垂直发射井" })).toHaveCount(1);

  const frame = page.locator(".machine-node").filter({ hasText: "框架材料" });
  await expect(frame.getByTitle("投入碳纳米管")).toBeVisible();
  await expect(frame.getByTitle("投入钛合金")).toBeVisible();
  const component = page.locator(".machine-node").filter({ hasText: "戴森球组件" });
  await expect(component.getByTitle("投入框架材料")).toBeVisible();
  await expect(component.getByTitle("投入太阳帆")).toBeVisible();
  const rocket = page.locator(".machine-node").filter({ hasText: "小型运载火箭" });
  await expect(rocket.getByTitle("投入戴森球组件")).toBeVisible();
  await expect(rocket.getByTitle("投入氘核燃料棒")).toBeVisible();

  const silo = page.locator(".machine-node").filter({ hasText: "戴森球建造设施" });
  await expect(silo.getByTitle("投入小型运载火箭")).toBeVisible();
  await page.locator(".tray-row").filter({ hasText: "小型运载火箭" }).click();
  await expect(silo).toHaveClass(/factory-node--accepts-cargo/);
  await silo.getByTitle("投入小型运载火箭").evaluate((element: HTMLButtonElement) => element.click());
  await expect(silo.getByTitle("取出小型运载火箭")).toBeVisible();
  await expect(silo).toContainText("结构 30 点");
  await expect(silo).toContainText("累计 30 枚");
  await silo.locator(".factory-node__header").click({ force: true });
  await expect(page.locator(".inspector-content")).toContainText("永久结构点");
  await expect(page.locator(".inspector-content")).toContainText("18 MW");
  await page.screenshot({ path: "artifacts/qa/dyson-sphere-industry-1440.png", fullPage: true });

  await page.getByLabel("打开科技树").click();
  const shellTechnology = page.locator(".technology-node").filter({ has: page.getByText("戴森壳面", { exact: true }) });
  await shellTechnology.click();
  await expect(page.locator(".research-focus")).toContainText("戴森壳面");
  await expect(page.locator(".research-cost-list > span")).toHaveCount(6);
  await page.screenshot({ path: "artifacts/qa/dyson-sphere-technology-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("关闭科技树").click();
  await page.getByLabel("打开物资托盘").click();
  await expect(page.locator(".dyson-block")).toBeVisible();
  await expect(page.locator(".dyson-block")).toContainText("300 / 1,200");
  await expect.poll(async () => Math.round((await page.locator(".resource-rail").boundingBox())?.x ?? -999)).toBe(0);
  await page.screenshot({ path: "artifacts/qa/dyson-sphere-resources-390.png", fullPage: true });
});

test("basic fabrication handcrafts unlocked material recipes in a compact grid", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHandcraftGame(page);
  await page.getByRole("tab", { name: "基础制造" }).click();
  await expect(page.getByLabel("搜索建筑制造")).toBeVisible();
  const constructionSearch = page.getByLabel("搜索建筑制造");
  for (const search of ["风力", "熔炉", "采矿", "研究站"]) {
    await constructionSearch.fill(search);
    await constructionSearch.press("Enter");
  }
  await constructionSearch.fill("");
  await constructionSearch.click();
  const constructionHistory = page.getByLabel("建筑制造最近搜索");
  await expect(constructionHistory).toBeVisible();
  await expect(constructionHistory.locator(".fabricator-search-history-options > button")).toHaveText(["研究站", "采矿", "熔炉"]);
  await expect(constructionHistory).not.toContainText("风力");
  await constructionHistory.getByRole("button", { name: "熔炉", exact: true }).click();
  await expect(constructionSearch).toHaveValue("熔炉");
  const stickyTools = page.locator(".fabricator-sticky-tools");
  const stickyY = (await stickyTools.boundingBox())!.y;
  await page.locator(".inspector-panel").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => page.locator(".inspector-panel").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => Math.abs(((await stickyTools.boundingBox())?.y ?? -999) - stickyY)).toBeLessThan(2);
  const smelterRow = page.locator(".fabricator-row").filter({ hasText: "电弧熔炉" });
  await expect(smelterRow).toHaveCount(1);
  await smelterRow.getByLabel("手工制造石材").click();
  await expect(page.getByRole("button", { name: "物品手工" })).toHaveClass(/active/);
  await expect(page.getByLabel("搜索手工配方")).toHaveValue("石材");
  await expect(page.locator('[data-output-item="stone_brick"]')).toHaveClass(/fabricator-row--focused/);
  await expect(page.locator(".fabricator-list")).toHaveClass(/fabricator-list--compact/);
  await page.getByLabel("搜索手工配方").fill("铁块");
  const ironRow = page.locator(".handcraft-row").filter({ hasText: "铁块" });
  await expect(ironRow).toContainText("熔炉");
  await ironRow.getByTitle("立即手工制造铁块").click();
  await expect(page.locator(".tray-row").filter({ hasText: "铁块" })).toContainText("21");
  await page.getByLabel("搜索手工配方").fill("磁线圈");

  const coilRow = page.locator('[data-output-item="magnetic_coil"]');
  await expect(coilRow).toHaveCount(1);
  await page.getByLabel("手工制造批次数量").fill("5");
  await page.getByLabel("手工制造批次数量").press("Enter");
  await expect(coilRow).toContainText("20/10");
  await expect(coilRow).toContainText("10/5");
  await coilRow.getByTitle("手工制造磁线圈").click();
  await expect(page.locator(".tray-row").filter({ hasText: "磁线圈" })).toContainText("10");

  await page.getByLabel("手工制造批次数量").fill("1");
  await page.getByLabel("手工制造批次数量").press("Enter");
  await page.getByLabel("搜索手工配方").fill("框架材料");
  const frameRow = page.locator(".handcraft-row").filter({ hasText: "框架材料" });
  await expect(frameRow.getByTitle("手工制造框架材料")).toBeEnabled();
  await frameRow.getByTitle("手工制造框架材料").click();
  await expect(page.locator(".tray-row").filter({ hasText: "框架材料" })).toContainText("1");
  const handcraftSearch = page.getByLabel("搜索手工配方");
  const missingNanotube = frameRow.getByRole("button", { name: "手工制造碳纳米管" });
  await expect(missingNanotube).toBeVisible();
  await missingNanotube.click();
  await expect(handcraftSearch).toHaveValue("碳纳米管");
  const nanotubeRecipes = page.locator('[data-output-item="carbon_nanotube"]');
  await expect(nanotubeRecipes).toHaveCount(2);
  await expect(nanotubeRecipes.first()).toHaveClass(/fabricator-row--focused/);
  await expect(nanotubeRecipes.last()).toHaveClass(/fabricator-row--focused/);
  await handcraftSearch.click();
  const handcraftHistory = page.getByLabel("物品手工最近搜索");
  await expect(handcraftHistory).toBeVisible();
  await expect(handcraftHistory.locator(".fabricator-search-history-options > button")).toHaveText(["框架材料", "磁线圈", "铁块"]);
  await expect(handcraftHistory).not.toContainText("采矿");
  await expect.poll(() => page.evaluate(() => {
    const history = JSON.parse(window.localStorage.getItem("dsp-idle-network.fabricator-search-history.v1") ?? "{}");
    return JSON.stringify(history.items ?? []);
  })).toBe(JSON.stringify(["框架材料", "磁线圈", "铁块"]));
  await page.screenshot({ path: "artifacts/qa/fabricator-search-history-1440.png", fullPage: true });
  await handcraftSearch.press("Escape");

  await page.locator(".tray-row").filter({ hasText: "磁线圈" }).locator(".item-reference--tray").first().hover();
  await expect(page.locator(".item-hover-card")).toContainText("磁铁 ×2 + 铜块 ×1");
  await expect(page.locator(".item-hover-card")).toContainText("用途");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("打开检查器").click();
  await expect(page.locator(".inspector-panel")).toBeVisible();
  await handcraftSearch.click();
  await expect(handcraftHistory).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/fabricator-search-history-390.png", fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(handcraftHistory).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/fabricator-search-history-844x390.png", fullPage: true });

  await page.getByRole("tab", { name: "检查器" }).click();
  await page.getByRole("tab", { name: "基础制造" }).click();
  const restoredConstructionSearch = page.getByLabel("搜索建筑制造");
  await restoredConstructionSearch.click();
  await expect(page.getByLabel("建筑制造最近搜索").locator(".fabricator-search-history-options > button")).toHaveText(["熔炉", "研究站", "采矿"]);
  await page.getByRole("button", { name: "物品手工" }).click();
  await page.getByLabel("搜索手工配方").click();
  await expect(page.getByLabel("物品手工最近搜索").locator(".fabricator-search-history-options > button")).toHaveText(["碳纳米管", "框架材料", "磁线圈"]);
});

test("handcraft queue exposes progress, waits on inventory and keeps recipe rates visible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHandcraftGame(page);
  await page.getByRole("tab", { name: "基础制造" }).click();
  await page.getByRole("button", { name: "物品手工" }).click();
  await page.getByLabel("搜索手工配方").fill("齿轮");
  const gearRow = page.locator(".handcraft-row").filter({ hasText: "齿轮" });
  await gearRow.getByLabel("排队制造齿轮").click();
  await expect(page.locator(".handcraft-queue")).toContainText("齿轮");
  await expect(page.locator(".handcraft-queue").getByRole("progressbar")).toBeVisible();
  await expect.poll(async () => Number(await page.locator(".tray-row").filter({ hasText: "齿轮" }).locator("strong").textContent()), { timeout: 6_000 }).toBeGreaterThan(0);
  await page.getByLabel("打开生产资料库").click();
  const codex = page.getByRole("dialog", { name: "生产资料库" });
  await expect(codex).toContainText("数据");
  await codex.getByLabel("搜索配方物品").fill("处理器");
  await codex.locator(".recipe-index > button").filter({ hasText: "处理器" }).click();
  await expect(codex.locator(".recipe-method").filter({ hasText: "处理器" }).first()).toContainText("/min");
  await page.screenshot({ path: "artifacts/qa/handcraft-queue-rates-1440.png", fullPage: true });
});

test("recipe codex searches sources and traverses production chains", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHandcraftGame(page);
  await page.getByLabel("打开生产资料库").click();
  const workspace = page.getByRole("dialog", { name: "生产资料库" });
  await expect(workspace).toBeVisible();

  await workspace.getByLabel("搜索配方物品").fill("硫酸");
  await workspace.locator(".recipe-index > button").filter({ hasText: "硫酸" }).click();
  await expect(workspace.locator(".recipe-item-header")).toContainText("硫酸");
  await expect(workspace.locator(".recipe-method--source")).toContainText("硫酸海洋抽取");
  await expect(workspace.locator(".recipe-method--source")).toContainText("烬原 II");
  const sulfuricRecipe = workspace.locator(".recipe-section").first().locator(".recipe-method:not(.recipe-method--source)");
  await expect(sulfuricRecipe).toContainText("硫酸");
  await expect(sulfuricRecipe).toContainText("化工厂");
  const downstream = workspace.locator(".recipe-relations > div").last();
  await expect(downstream).toContainText("钛合金");
  await expect(downstream).toContainText("石墨烯");

  await workspace.getByLabel("搜索配方物品").fill("小型运载火箭");
  await workspace.locator(".recipe-index > button").filter({ hasText: "小型运载火箭" }).click();
  await expect(workspace.locator(".recipe-item-header")).toContainText("小型运载火箭");
  const rocketRecipe = workspace.locator(".recipe-method").filter({ hasText: "小型运载火箭" }).first();
  await expect(rocketRecipe).toContainText("戴森球组件");
  await expect(rocketRecipe).toContainText("氘核燃料棒");
  await expect(rocketRecipe).toContainText("量子芯片");
  await expect(workspace.locator(".recipe-method").filter({ hasText: "运载火箭发射" })).toContainText("戴森球永久结构点");

  await workspace.getByRole("button", { name: "固定到主界面" }).click();
  await workspace.getByLabel("关闭生产资料库").click();
  const focusedChain = page.locator(".recipe-focus-panel");
  await expect(focusedChain).toContainText("小型运载火箭");
  await focusedChain.getByRole("button", { name: /完整/ }).click();
  await expect(focusedChain).toContainText("完整上游链");
  await focusedChain.getByLabel("取消聚焦材料").click();
  await expect(focusedChain).toHaveCount(0);

  await page.getByLabel("打开生产资料库").click();
  const reopenedWorkspace = page.getByRole("dialog", { name: "生产资料库" });
  await expect(reopenedWorkspace).toBeVisible();
  await reopenedWorkspace.getByLabel("搜索配方物品").fill("小型运载火箭");
  await reopenedWorkspace.locator(".recipe-index > button").filter({ hasText: "小型运载火箭" }).click();
  await reopenedWorkspace.locator(".recipe-item-header .item-reference").hover();
  await expect(page.locator(".item-hover-card")).toContainText("制造台");
  await expect(page.locator(".item-hover-card")).toContainText("1 项生产配方");
  await page.screenshot({ path: "artifacts/qa/recipe-codex-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspace.locator(".recipe-item-header")).toBeVisible();
  await expect.poll(async () => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/recipe-codex-390.png", fullPage: true });
});

test("production library links buildings, recipes, technologies and authoritative logistics rates", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHandcraftGame(page);
  await page.getByLabel("打开生产资料库").click();
  const library = page.getByRole("dialog", { name: "生产资料库" });
  await library.getByRole("button", { name: "建筑设施", exact: true }).click();
  await library.locator(".codex-search input").fill("制造台 Mk.I");
  await library.getByRole("button", { name: /^制造台 Mk\.I / }).click();
  const building = library.locator(".codex-building-detail");
  await expect(building).toContainText("基础速度");
  await expect(building).toContainText("输入缓存");
  await expect(building).toContainText("额定耗电");
  await expect(building).toContainText("制造材料");
  await expect(building.locator(".codex-recipe-row").first()).toContainText("单次产出 / 每分钟");
  await expect(building.locator(".codex-recipe-row").first()).toContainText("/min");
  await page.screenshot({ path: "artifacts/qa/production-library-building-1440.png", fullPage: true });

  await library.getByRole("button", { name: "物流运输", exact: true }).click();
  const belts = library.locator(".codex-belt-grid");
  await expect(belts).toContainText("6 件/秒");
  await expect(belts).toContainText("12 件/秒");
  await expect(belts).toContainText("30 件/秒");
  await expect(belts).toContainText("4 层");
  for (const section of ["电力与能源", "星球与资源", "戴森工程", "科研与机制"]) {
    await library.getByRole("button", { name: section, exact: true }).click();
    await expect(library.locator(".codex-overview, .codex-master-detail").first()).toBeVisible();
  }
  await expect.poll(() => library.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("production equipment and belt lanes upgrade in place without losing the network", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openUpgradeStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  await page.getByRole("button", { name: "继续模拟" }).click();
  await expect(page.locator(".factory-cargo-packet").first()).toBeVisible();

  const assembler = page.locator(".machine-node").filter({ hasText: "齿轮" });
  await assembler.locator(".factory-node__header").click();
  await expect(page.getByTitle("升级为制造台 Mk.II")).toBeEnabled();
  await page.getByTitle("升级为制造台 Mk.II").click();
  await expect(assembler).toContainText("制造台 Mk.II");
  await expect(page.locator(".inspector-identity")).toContainText("制造台 Mk.II ×1");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await page.locator(".react-flow__edge").evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(page.locator(".inspector-content")).toContainText("传送带等级");
  await expect(page.getByTitle("升级为传送带 Mk.II")).toBeEnabled();
  await page.getByTitle("升级为传送带 Mk.II").click();
  await expect(page.locator(".inspector-content")).toContainText("Mk.II");
  await expect(page.locator(".inspector-content")).toContainText("12/s");
  await expect(page.locator(".react-flow__edge-text")).toContainText("Mk.II");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/equipment-upgrade-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".equipment-upgrade--belt")).toBeVisible();
  await expect(page.locator(".inspector-panel").evaluate((element) => element.scrollWidth <= element.clientWidth)).resolves.toBe(true);
  await page.screenshot({ path: "artifacts/qa/equipment-upgrade-390.png", fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "基础制造" }).click();
  await expect(page.locator(".fabricator-row").filter({ hasText: "位面熔炉" })).toHaveCount(1);
  await expect(page.locator(".fabricator-row").filter({ hasText: "制造台 Mk.III" })).toHaveCount(1);
  await expect(page.locator(".fabricator-row").filter({ hasText: "传送带 Mk.III" })).toHaveCount(1);

  await page.getByLabel("打开科技树").click();
  for (const technology of ["高速装配工艺", "高速物流系统", "高效采矿 I", "位面冶金", "量子打印技术", "超级磁场物流"]) {
    await expect(page.locator(".technology-node").filter({ has: page.getByText(technology, { exact: true }) })).toHaveCount(1);
  }
  await page.screenshot({ path: "artifacts/qa/industry-upgrade-technologies-1440.png", fullPage: true });
});

test("completed matrix research keeps connected color ports while the lab moves", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 820 });
  await openResearchLineRegressionGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const lab = page.locator(".machine-node").filter({ hasText: "科研模式" });
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(lab.getByTitle("投入电磁矩阵")).toBeVisible();
  await expect(lab.getByTitle("投入能量矩阵")).toBeVisible();
  await expect(lab).toContainText("未选择科技", { timeout: 5000 });

  const header = lab.locator(".factory-node__header");
  const bounds = await header.boundingBox();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2 + 150, bounds!.y + bounds!.height / 2 - 100, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(lab.getByTitle("投入电磁矩阵")).toBeVisible();
  await expect(lab.getByTitle("投入能量矩阵")).toBeVisible();
  await page.locator(".react-flow__controls-fitview").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "artifacts/qa/research-lines-persist-1280.png" });
});

test("production statistics exposes item flow, power demand and bottlenecks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署电弧熔炉", Math.round(box!.width * 0.84), 80);
  await page.getByLabel("打开生产统计").click();
  const workspace = page.getByRole("dialog", { name: "生产统计" });
  await expect(workspace).toBeVisible();
  await expect(workspace.locator(".statistics-row").filter({ hasText: "铁矿石" })).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/production-flow-statistics-1280.png", fullPage: true });
  await workspace.getByLabel("筛选统计物品").fill("铁矿石");
  await expect(workspace.locator(".statistics-row")).toHaveCount(1);

  await workspace.getByRole("tab", { name: "电力" }).click();
  await expect(workspace.locator(".consumer-row").filter({ hasText: "电弧熔炉" })).toContainText("360 kW");
  await workspace.getByRole("tab", { name: /瓶颈/ }).click();
  await expect(workspace.locator(".issue-row").filter({ hasText: "电弧熔炉" })).toContainText("缺少铁矿石");
  await page.screenshot({ path: "artifacts/qa/production-statistics-1280.png", fullPage: true });
});

test("production statistics remains usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freshGame(page);
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "生产统计" }).click();
  const workspace = page.getByRole("dialog", { name: "生产统计" });
  await expect(workspace.getByRole("tab", { name: "生产" })).toBeVisible();
  await expect(workspace.locator(".statistics-filter")).toBeVisible();
  await workspace.getByLabel("筛选统计物品").fill("不存在的物品");
  const emptyState = workspace.locator(".statistics-empty");
  await expect(emptyState).toContainText("没有符合条件的物品");
  await expect.poll(async () => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => emptyState.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  })).toBe(true);
  await page.screenshot({ path: "artifacts/qa/mobile-statistics-390.png", fullPage: true });
  await workspace.getByRole("tab", { name: /瓶颈/ }).click();
  await expect(workspace.locator(".statistics-empty")).toContainText("生产网络运行正常");
});

test("production management traces devices and supports cross-surface batch controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署电弧熔炉", Math.round(box!.width * 0.82), 90);
  await page.getByLabel("打开生产统计").click();
  const workspace = page.getByRole("dialog", { name: "生产统计" });
  await workspace.getByRole("tab", { name: "管理" }).click();
  await expect(workspace.locator(".production-management-summary")).toContainText("全星球设备");
  const smelter = workspace.locator(".production-management-row").filter({ hasText: "电弧熔炉" });
  await expect(smelter).toContainText("未连接输入线路");
  await smelter.locator('input[type="checkbox"]').check();
  await workspace.getByLabel("选择当前配方").click();
  const picker = page.getByRole("dialog", { name: "配方选择面板" });
  await picker.locator(".recipe-catalog-grid > button").filter({ hasText: "铜块" }).click();
  await workspace.getByRole("button", { name: "应用兼容设备" }).click();
  await expect(smelter).toContainText("铜块");
  await smelter.getByText("展开物料路径").click();
  await expect(smelter).toContainText("原料源");
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/production-management-1440.png", fullPage: true });

  await workspace.getByLabel("定位电弧熔炉").click();
  await expect(workspace).toHaveCount(0);
  await expect(page.locator(".inspector-panel")).toContainText("电弧熔炉");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "生产统计" }).click();
  const mobileWorkspace = page.getByRole("dialog", { name: "生产统计" });
  await mobileWorkspace.getByRole("tab", { name: "管理" }).click();
  await expect(mobileWorkspace.locator(".production-management-row")).toBeVisible();
  await mobileWorkspace.locator(".production-management-row").filter({ hasText: "电弧熔炉" }).locator('input[type="checkbox"]').check();
  await mobileWorkspace.getByLabel("选择当前配方").click();
  const mobileRecipePicker = page.getByRole("dialog", { name: "配方选择面板" });
  await expect(mobileRecipePicker).toBeVisible();
  await expect(mobileRecipePicker.getByLabel("搜索配方")).not.toBeFocused();
  await mobileRecipePicker.getByRole("button", { name: "关闭配方选择" }).click();
  for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
    await page.evaluate((value) => document.documentElement.style.setProperty("--ui-font-scale", String(value)), scale);
    await expect.poll(async () => mobileWorkspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-font-scale", "1"));
  await expect.poll(async () => mobileWorkspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/production-management-390.png", fullPage: true });

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(mobileWorkspace.locator(".production-management-row")).toBeVisible();
  await expect.poll(async () => mobileWorkspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/production-management-844x390.png", fullPage: true });
});
