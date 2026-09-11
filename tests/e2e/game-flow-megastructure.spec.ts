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


test("the production workspace fits a medium desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await freshGame(page);
  await expect(page.locator(".factory-canvas")).toBeVisible();
  await expect(page.locator(".tray-row").filter({ hasText: "铁矿石" })).toContainText("100");
  await expect(page.locator(".tray-row").filter({ hasText: "铜矿石" })).toContainText("100");
  await expect(page.locator(".tray-row").filter({ hasText: "石矿" })).toContainText("100");
  await expect(page.getByTitle("完成星际物流系统科技后开放")).toHaveCount(2);
  await expect(page.getByTitle("部署风力涡轮机")).toBeVisible();
  await expect(page.getByRole("tab", { name: "基础制造" })).toBeVisible();
  const smelter = page.locator(".construction-item-shell").filter({ hasText: "电弧熔炉" });
  await expect(smelter.getByLabel("制造电弧熔炉")).toHaveClass(/construction-item-craft--upstream/);
  await smelter.getByLabel("制造电弧熔炉").click();
  await expect(smelter.locator(".construction-item > strong")).toHaveText("×4");
  await expect(page.locator(".interaction-burst")).toContainText("已消耗");
  await page.screenshot({ path: "artifacts/qa/factory-network-1280.png", fullPage: true });
});

test("a gray construction hammer opens the true raw-resource shortage instead of an unrelated recipe", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDisabledHammerGame(page);
  const smelter = page.locator(".construction-item-shell").filter({ hasText: "电弧熔炉" });
  const hammer = smelter.getByLabel("制造电弧熔炉");
  await expect(hammer).toHaveClass(/construction-item-craft--disabled/);
  await expect(hammer).toHaveCSS("color", "rgb(101, 112, 107)");
  await hammer.click();
  const library = page.getByRole("dialog", { name: "生产资料库" });
  await expect(library).toBeVisible();
  await expect(library).toContainText("铁矿石");
  await expect(page.locator(".game-notice")).toContainText("铁矿石属于原始资源");
});

test("construction automation and three-input delivery stay usable across desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openConstructionAutomationGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const hub = page.locator(".logistics-node").filter({ hasText: "物资配送枢纽" });
  await expect(hub.locator(".delivery-hub-target")).toHaveCount(3);
  await expect(hub).toContainText("3/3 接口");
  await expect(page.locator(".tray-row").filter({ hasText: "铜块" })).toContainText("5");

  const center = page.locator(".machine-node").filter({ hasText: "建筑制造中心" });
  await expect(center).toHaveClass(/factory-node--megastructure/);
  await expect(center.locator(".construction-center-core")).toContainText("行星建筑制造阵列 Mk.I");
  for (const scale of [80, 100, 125, 150, 200]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.uiFontScale = String(value);
      document.documentElement.style.setProperty("--ui-font-scale", String(value / 100));
    }, scale);
    const centerBounds = await center.boundingBox();
    const ordinaryBounds = await page.locator(".power-node").boundingBox();
    expect(centerBounds!.width, `${scale}% megastructure width`).toBeGreaterThanOrEqual(ordinaryBounds!.width * 1.9);
    expect(centerBounds!.height, `${scale}% megastructure height`).toBeGreaterThanOrEqual(ordinaryBounds!.height * 1.65);
    await expect(center.evaluate((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).resolves.toBe(true);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });
  await page.locator(".react-flow__controls-fitview").click();
  await page.screenshot({ path: "artifacts/qa/construction-center-node-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await page.locator(".react-flow__controls-fitview").click();
  await expect(center.locator(".construction-center-core")).toContainText("行星建筑制造阵列 Mk.I");
  await expect(center.evaluate((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).resolves.toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-center-node-390-font200.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });
  await page.locator(".react-flow__controls-fitview").click();
  await center.click();
  await page.locator(".construction-center-open").click();
  const workspace = page.getByRole("dialog", { name: "建筑制造中心" });
  await expect(workspace).toBeVisible();
  const smelterTarget = workspace.getByRole("textbox", { name: "电弧熔炉目标库存", exact: true });
  await smelterTarget.fill("2");
  await expect(smelterTarget).toHaveValue("2");
  await expect(workspace.locator(".construction-center-status")).toContainText("澄海 I");
  await expect.poll(async () => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-center-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspace.getByLabel("关闭建筑制造中心")).toBeVisible();
  await expect.poll(async () => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-center-390.png", fullPage: true });

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(workspace.getByLabel("关闭建筑制造中心")).toBeVisible();
  await expect.poll(async () => workspace.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/construction-center-844x390.png", fullPage: true });
});

test("starter kit and logistics controls are available on the production canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededGame(page);

  await expect(page.getByTitle("部署风力涡轮机")).toContainText("×3");
  await expect(page.getByTitle("部署采矿机")).toContainText("×2");
  await expect(page.getByTitle("部署电弧熔炉")).toContainText("×3");
  await expect(page.getByTitle("部署制造台 Mk.I", { exact: true })).toContainText("×3");
  await expect(page.getByTitle("部署矩阵研究站")).toContainText("×2");
  await expect(page.getByTitle("选择传送带 Mk.I连接节点端口", { exact: true })).toContainText("×10");
  await expect(page.locator(".vein-node").filter({ hasText: "原油" })).toBeVisible();

  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署小型储物仓", Math.round(box!.width * 0.7), 210);
  const storage = page.locator(".logistics-node").filter({ hasText: "小型储物仓" });
  await storage.click();
  const storageInspector = page.locator(".inspector-panel .inspector-content");
  await expect(storageInspector).toContainText("小型储物仓");
  await chooseItem(page, storageInspector.locator(".recipe-select"), "铁矿石");
  await expect(storage).toContainText("铁矿石");
  await expect(storage.locator(".factory-handle--input")).toHaveCount(1);
  await expect(storage.locator('[data-handleid="in:iron_ore"]')).toHaveCount(1);
  await expect(storage.locator(".factory-handle--input.factory-handle--auto")).toHaveCount(0);
  await expect(storage.locator(".factory-handle--output")).toHaveCount(1);
  await expect(storage.locator(".factory-node__header strong")).toHaveText("小型储物仓");
  await expect(storage.locator(".node-io__label")).toHaveText(["输入", "输出"]);
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await expect.poll(() => storage.evaluate((element) => {
    const name = element.querySelector<HTMLElement>(".factory-node__header strong");
    const columns = [...element.querySelectorAll<HTMLElement>(".node-io__column")].map((column) => column.getBoundingClientRect());
    const separated = columns.length === 2 && (columns[0].right <= columns[1].left + 1 || columns[0].bottom <= columns[1].top + 1);
    return Boolean(name && name.textContent === "小型储物仓" && name.scrollHeight <= name.clientHeight + 1 && separated);
  })).toBe(true);
  await page.screenshot({ path: "artifacts/qa/storage-mk1-font-200-1440.png", fullPage: true });
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });

  await placeOnCanvas(page, "部署储液罐", Math.round(box!.width * 0.42), 450);
  const tank = page.locator(".logistics-node").filter({ hasText: "储液罐" });
  await tank.locator(".factory-node__header").click();
  await chooseItem(page, page.locator(".inspector-panel .inspector-content").locator(".recipe-select"), "水");
  await expect(tank.locator(".factory-node__header strong")).toHaveText("储液罐");
  await expect(tank.locator(".node-io__label")).toHaveText(["输入", "输出"]);
  await expect(tank).toContainText("水");
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "200";
    document.documentElement.style.setProperty("--ui-font-scale", "2");
  });
  await expect.poll(() => tank.evaluate((element) => {
    const name = element.querySelector<HTMLElement>(".factory-node__header strong");
    const columns = [...element.querySelectorAll<HTMLElement>(".node-io__column")].map((column) => column.getBoundingClientRect());
    const separated = columns.length === 2 && (columns[0].right <= columns[1].left + 1 || columns[0].bottom <= columns[1].top + 1);
    return Boolean(name && name.textContent === "储液罐" && name.scrollHeight <= name.clientHeight + 1 && separated);
  })).toBe(true);
  await page.evaluate(() => {
    document.documentElement.dataset.uiFontScale = "100";
    document.documentElement.style.setProperty("--ui-font-scale", "1");
  });

  await placeOnCanvas(page, "部署四向分流器", Math.round(box!.width * 0.7), 450);
  const splitter = page.locator(".logistics-node").filter({ hasText: "四向分流器" });
  await splitter.locator(".factory-node__header").click({ position: { x: 24, y: 18 } });
  const splitterInspector = page.locator(".inspector-panel .inspector-content");
  await expect(splitterInspector).toContainText("四向分流器");
  await chooseItem(page, splitterInspector.locator(".recipe-select"), "铁矿石");
  await page.getByRole("button", { name: "优先线路" }).click();
  await expect(splitter).toContainText("优先分流");

  await page.getByTitle("部署原油萃取站").click();
  const oilVein = page.locator(".vein-node").filter({ hasText: "原油" });
  await oilVein.click();
  await expect(oilVein).toContainText("×1");
  await oilVein.click();
  await page.locator(".inspector-panel").getByRole("button", { name: "回收全部采矿机 ×1" }).click();
  await expect(oilVein).toContainText("×0");
  await expect(page.getByTitle("部署原油萃取站")).toContainText("×1");
  await page.screenshot({ path: "artifacts/qa/logistics-oil-1440.png", fullPage: true });
});

test("finite resource nodes, inspector and reserve statistics use the same depletion model", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const iron = page.locator(".vein-node").filter({ hasText: "铁矿石" }).first();
  await expect(iron.locator(".factory-node__header > small")).not.toHaveText("∞");
  await expect(iron.locator(".vein-reserve")).toContainText("储量");
  await iron.click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector).toContainText("有限资源矿脉");
  await expect(inspector).toContainText("剩余储量");
  await expect(inspector).toContainText("初始总量");
  await expect(inspector).toContainText("剩余比例");
  await page.getByLabel("打开生产统计").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await statistics.getByRole("tab", { name: "电力" }).click();
  await expect(statistics).toContainText("资源储量统计");
  await expect(statistics.locator(".resource-reserve-ledger")).toContainText("有限资源");
  await page.screenshot({ path: "artifacts/qa/finite-resource-reserve-1440.png", fullPage: true });
});

test("thermal power accepts fuel and responds to mining demand", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededGame(page);
  const canvas = page.locator(".react-flow__pane");
  const box = await canvas.boundingBox();
  await placeOnCanvas(page, "部署火力发电厂", Math.round(box!.width * 0.7), 210);
  const plant = page.locator(".thermal-node");
  await plant.click();
  await plant.locator(".node-inline-select select").selectOption("coal");

  await page.locator(".tray-row").filter({ hasText: "煤矿" }).click();
  await plant.getByTitle("投入煤矿").click();
  const ironVein = page.locator(".vein-node").filter({ hasText: "铁矿石" });
  await page.getByTitle("部署采矿机").click();
  await ironVein.click();

  await expect.poll(async () => plant.textContent()).toContain("燃烧发电中");
  await expect.poll(async () => Number((await plant.locator(".power-output .power-value").first().getAttribute("aria-label"))?.replace(/[^\d.-]/g, ""))).toBeGreaterThan(0);
  await page.screenshot({ path: "artifacts/qa/thermal-power-1440.png", fullPage: true });
});

test("spray coating closes the Mk.III proliferator logistics and extra-output loop", async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openProliferatorStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const assembler = page.locator(".machine-node").filter({ hasText: "齿轮" });
  await assembler.click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.locator(".proliferator-control")).toContainText("模块未安装");
  await inspector.getByRole("button", { name: "安装喷涂模块" }).click();
  await inspector.locator(".proliferator-tier").getByRole("button", { name: "Mk.III" }).click();
  await inspector.locator(".proliferator-mode").getByRole("button", { name: "增产" }).click();
  await expect(assembler.locator(".proliferator-readout")).toContainText("额外产出 · Mk.III");
  await expect(assembler.getByTitle("投入增产剂 Mk.III")).toBeVisible();

  const storage = page.locator(".logistics-node").filter({ hasText: "增产剂 Mk.III" });
  const source = storage.locator(".factory-handle--output");
  const target = assembler.locator(".node-port--input").filter({ hasText: "增产剂 Mk.III" }).locator(".factory-handle--input");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await page.getByLabel("继续模拟").click();
  const gearOutput = assembler.getByTitle("拿取齿轮");
  await expect.poll(async () => Number(await gearOutput.locator("strong").textContent()), { timeout: 12_000 }).toBeGreaterThanOrEqual(5);
  await expect.poll(async () => Number(await gearOutput.locator("strong").textContent()) % 1).toBe(0);
  await expect(assembler.locator(".proliferator-readout strong")).not.toHaveText("0 点");
  await page.locator(".react-flow__controls-zoomin").click();
  await page.locator(".react-flow__controls-zoomin").click();
  await page.screenshot({ path: "artifacts/qa/proliferator-loop-1440.png", fullPage: true });

  await page.getByLabel("打开生产统计").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await expect(statistics.locator(".statistics-row").filter({ hasText: "增产剂 Mk.III" })).toBeVisible();
  await expect(statistics.locator(".statistics-row").filter({ hasText: "齿轮" })).toBeVisible();
  await statistics.getByLabel("关闭生产统计").click();

  await assembler.click();
  await expect(inspector.locator(".proliferator-control")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  if (!await inspector.locator(".proliferator-control").isVisible()) {
    await page.getByLabel("打开检查器").click();
  }
  await expect(inspector.locator(".proliferator-control")).toBeVisible();
  await inspector.locator(".proliferator-control").scrollIntoViewIfNeeded();
  await expect.poll(async () => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/proliferator-loop-390.png", fullPage: true });
});

test("a chemical plant accepts plastic, refined oil and water transport lines together", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChemicalRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const chemical = page.locator('.react-flow__node[data-id="organic_chemical"] .machine-node');
  await chemical.click();
  await chooseRecipe(page, chemical, "有机晶体");
  await expect(chemical).toContainText("有机晶体");
  await expect(chemical.getByTitle("投入塑料")).toBeVisible();
  await expect(chemical.getByTitle("投入精炼油")).toBeVisible();
  await expect(chemical.getByTitle("投入水")).toBeVisible();

  const connect = async (sourceId: string, itemText: string, expectedEdges: number) => {
    const source = page.locator(`.react-flow__node[data-id="${sourceId}"]`).locator(".node-port").filter({ hasText: itemText }).locator(".factory-handle--output");
    const target = chemical.locator(".node-port--input").filter({ hasText: itemText }).locator(".factory-handle--input");
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2, { steps: 12 });
    await page.waitForTimeout(600);
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge")).toHaveCount(expectedEdges);
  };

  await connect("plastic_source", "塑料", 1);
  await connect("oil_source", "精炼油", 2);
  await connect("water_source", "水", 3);
  await expect(page.locator(".factory-edge--active")).toHaveCount(3);
  await expect.poll(async () => page.locator(".factory-edge--active .react-flow__edge-path").first().evaluate((element) => getComputedStyle(element).animationName)).toContain("factory-belt-flow");
  const layerZIndexes = await page.evaluate(() => Object.fromEntries([
    ["edgeHitLayer", ".react-flow__edges"],
    ["visibleEdges", ".factory-edge-visual-layer"],
    ["labels", ".react-flow__edgelabel-renderer"],
    ["nodes", ".react-flow__nodes"],
  ].map(([key, selector]) => [key, Number.parseInt(getComputedStyle(document.querySelector(selector)!).zIndex || "0", 10)])));
  expect(layerZIndexes.edgeHitLayer).toBeLessThan(layerZIndexes.nodes);
  expect(layerZIndexes.visibleEdges).toBeLessThan(layerZIndexes.nodes);
  expect(layerZIndexes.labels).toBeLessThan(layerZIndexes.nodes);
  await expect(page.getByTitle("选择传送带 Mk.I连接节点端口", { exact: true })).toContainText("×0");
  await page.screenshot({ path: "artifacts/qa/chemical-three-input-routing-1440.png", fullPage: true });
});

test("a second titanium alloy input line transfers after the first line", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTitaniumRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const target = page.locator('.react-flow__node[data-id="alloy_target"] .machine-node');
  const connect = async (sourceId: string, itemText: string, expectedEdges: number) => {
    const source = page.locator(`.react-flow__node[data-id="${sourceId}"]`).locator(".node-port").filter({ hasText: itemText }).locator(".factory-handle--output");
    const input = target.locator(".node-port--input").filter({ hasText: itemText }).locator(".factory-handle--input");
    const sourceBox = await source.boundingBox();
    const inputBox = await input.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(inputBox!.x + inputBox!.width / 2, inputBox!.y + inputBox!.height / 2, { steps: 12 });
    await page.waitForTimeout(400);
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge")).toHaveCount(expectedEdges);
  };
  await connect("steel_source", "钢材", 1);
  await connect("titanium_source", "钛块", 2);
  await connect("acid_source", "硫酸", 3);
  await page.waitForTimeout(2_500);
  await expect.poll(async () => Number(await target.locator(".node-port--input").filter({ hasText: "钛块" }).locator("strong").textContent()), { timeout: 8_000 }).toBeGreaterThan(0);
  await expect.poll(async () => Number(await target.locator(".node-port--input").filter({ hasText: "钢材" }).locator("strong").textContent()), { timeout: 8_000 }).toBeGreaterThan(0);
  await expect.poll(async () => Number(await target.locator(".node-port--input").filter({ hasText: "硫酸" }).locator("strong").textContent()), { timeout: 8_000 }).toBeGreaterThan(0);
});

test("rapid consecutive belt drags keep the second connection instead of using stale stock", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTitaniumRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const target = page.locator('.react-flow__node[data-id="alloy_target"] .machine-node');
  const dragConnection = async (sourceId: string, itemText: string) => {
    const source = page.locator(`.react-flow__node[data-id="${sourceId}"]`).locator(".node-port").filter({ hasText: itemText }).locator(".factory-handle--output");
    const input = target.locator(".node-port--input").filter({ hasText: itemText }).locator(".factory-handle--input");
    const sourceBox = await source.boundingBox();
    const inputBox = await input.boundingBox();
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(inputBox!.x + inputBox!.width / 2, inputBox!.y + inputBox!.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  await dragConnection("steel_source", "钢材");
  await dragConnection("titanium_source", "钛块");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.getByRole("status")).not.toContainText("运输线未建立");
});

test("multi-slot station outputs connect beyond the first slot and expose belt feedback", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMultiSlotStationRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const station = page.locator('.react-flow__node[data-id="multi_station"]');
  const alloy = page.locator('.react-flow__node[data-id="multi_alloy"]');
  const chemical = page.locator('.react-flow__node[data-id="multi_chemical"]');
  await expect(station.locator(".factory-handle--output")).toHaveCount(3);
  await expect(station.getByTitle("拿取钛块")).toBeVisible();
  await expect(station.getByTitle("拿取硫酸")).toBeVisible();

  const dragConnection = async (sourceNode: Locator, itemText: string, targetNode: Locator, expectedEdges: number, inspectGhost = false, targetItemText = itemText) => {
    const source = sourceNode.locator(".node-port").filter({ hasText: itemText }).locator(".factory-handle--output");
    const target = targetNode.locator(".node-port").filter({ hasText: targetItemText }).locator(".factory-handle--input");
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await page.mouse.down();
    if (inspectGhost) {
      await page.mouse.move(sourceBox!.x + 70, sourceBox!.y - 55, { steps: 6 });
      const preview = page.locator(".factory-connection-preview");
      await expect(preview).toHaveClass(/factory-connection-preview--pending/);
      await expect(preview.locator(".factory-connection-preview__path")).toHaveCSS("stroke", "rgb(121, 217, 202)");
    }
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
    const expectedTone = itemText === targetItemText ? "valid" : "invalid";
    const expectedColor = expectedTone === "valid" ? "rgb(141, 224, 169)" : "rgb(239, 155, 143)";
    const preview = page.locator(".factory-connection-preview");
    await expect(preview).toHaveClass(new RegExp(`factory-connection-preview--${expectedTone}`));
    await expect(preview.locator(".factory-connection-preview__path")).toHaveCSS("stroke", expectedColor);
    if (inspectGhost) await page.screenshot({ path: "artifacts/qa/connection-preview-valid-1440.png", fullPage: true });
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge")).toHaveCount(expectedEdges);
  };

  await dragConnection(station, "钛块", alloy, 1, true);
  await expect(page.locator(".factory-edge-label > span")).toHaveText(["Mk.III"]);
  await dragConnection(station, "硫酸", chemical, 2);
  await expect(page.locator(".factory-edge-label > span")).toHaveText(["Mk.III", "Mk.II"]);
  await expect(page.getByRole("status")).toContainText("硫酸运输线已建立");

  // A mismatched release must leave an explicit failure instead of silently
  // discarding the drag.
  await dragConnection(station, "钛块", chemical, 2, false, "硫酸");
  await expect(page.getByRole("status")).toContainText("运输线未建立");
});

test("automatic belt selection reuses an existing parallel line tier", async ({ page }) => {
  await page.addInitScript(() => {
    const base = { planetId: "home", machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0 };
    const state = {
      version: 23,
      nextId: 4,
      activePlanetId: "home",
      entities: [
        { ...base, id: "parallel_source", kind: "storage", position: { x: 0, y: 0 }, buildingId: "storage_mk1", storedItemId: "iron_ingot", outputs: { iron_ingot: 20 } },
        { ...base, id: "parallel_target", kind: "machine", position: { x: 460, y: 0 }, buildingId: "assembling_machine_mk1", recipeId: "gear" },
      ],
      belts: [{ id: "parallel_belt", planetId: "home", source: "parallel_source", target: "parallel_target", itemId: "iron_ingot", lanes: 1, tier: 2, sorterTier: 1, progress: 0, priority: 0, stackSize: 1, monitorEnabled: false, totalTransferred: 0, congestion: 0, lastFlow: 0 }],
      construction: { conveyor_belt_mk1: 5, conveyor_belt_mk2: 1, conveyor_belt_mk3: 2 },
      tray: {},
      planetTrays: { home: {} },
      totalProduced: {},
      research: { selectedTechId: null, queuedTechIds: [], progressByTech: {}, completedTechIds: ["basic_assembling", "basic_logistics", "high_speed_logistics", "super_magnetic_logistics"] },
      paused: true,
    };
    window.localStorage.setItem("dsp-idle-network.save.v1", JSON.stringify({ savedAt: Date.now(), state }));
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator(".react-flow__controls-fitview").click();
  await expect(page.locator(".dock-belt-auto")).toHaveClass(/active/);
  const source = page.locator('.react-flow__node[data-id="parallel_source"] .factory-handle--output');
  const target = page.locator('.react-flow__node[data-id="parallel_target"] .factory-handle--input');
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.getByRole("status")).toContainText("Mk.II");
  await expect(page.locator(".factory-edge-label")).toContainText("Mk.II");
});

test("a single port click arms a live connection preview and reveals automatic targets", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMultiSlotStationRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const station = page.locator('.react-flow__node[data-id="multi_station"]');
  const alloy = page.locator('.react-flow__node[data-id="multi_alloy"]');
  const chemical = page.locator('.react-flow__node[data-id="multi_chemical"]');
  const source = station.locator(".node-port").filter({ hasText: "钛块" }).locator(".factory-handle--output");
  const validTarget = alloy.locator(".node-port--input").filter({ hasText: "钛块" }).locator(".factory-handle--input");
  const invalidTarget = chemical.locator(".node-port--input").filter({ hasText: "硫酸" }).locator(".factory-handle--input");

  await expect(page.locator(".factory-handle--auto")).toHaveCount(0);
  await source.click();
  const clickPreview = page.locator(".factory-click-connection-preview");
  await expect(clickPreview).toBeVisible();
  await expect(clickPreview.locator(".factory-connection-preview")).toHaveClass(/factory-connection-preview--pending/);
  await expect(page.getByText("自动选择配方", { exact: true })).toHaveCount(2);
  await expect(station).toHaveClass(/factory-flow-node--connection-origin/);
  await expect(alloy).toHaveClass(/factory-flow-node--connection-candidate/);
  await expect(chemical).not.toHaveClass(/factory-flow-node--connection-candidate/);

  const blankPoint = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) return null;
    const bounds = pane.getBoundingClientRect();
    for (let y = bounds.top + 30; y < bounds.bottom - 30; y += 24) {
      for (let x = bounds.left + 30; x < bounds.right - 30; x += 24) {
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    return null;
  });
  expect(blankPoint).not.toBeNull();
  await page.mouse.click(blankPoint!.x, blankPoint!.y);
  await expect(clickPreview).toHaveCount(0);
  await expect(page.locator(".factory-flow-node--connection-origin, .factory-flow-node--connection-candidate")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("已取消运输线连接");

  await source.click();
  await expect(clickPreview).toBeVisible();

  const invalidBox = await invalidTarget.boundingBox();
  expect(invalidBox).not.toBeNull();
  await page.mouse.move(invalidBox!.x + invalidBox!.width / 2, invalidBox!.y + invalidBox!.height / 2, { steps: 8 });
  await expect(clickPreview.locator(".factory-connection-preview")).toHaveClass(/factory-connection-preview--invalid/);

  const targetBox = await validTarget.boundingBox();
  expect(targetBox).not.toBeNull();
  const targetPoint = { x: targetBox!.x + targetBox!.width / 2, y: targetBox!.y + targetBox!.height / 2 };
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 });
  await expect(clickPreview.locator(".factory-connection-preview")).toHaveClass(/factory-connection-preview--valid/);
  await expect.poll(async () => Number(await clickPreview.locator(".factory-connection-preview__target").getAttribute("cx"))).toBeCloseTo(targetPoint.x, 0);
  await page.mouse.click(targetPoint.x, targetPoint.y);

  await expect(clickPreview).toHaveCount(0);
  await expect(page.locator(".factory-handle--auto")).toHaveCount(0);
  await expect(page.locator(".factory-flow-node--connection-origin, .factory-flow-node--connection-candidate")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.getByRole("status")).toContainText(/钛块运输线已建立|成就解锁：物流脉搏/);
});

test("a reverse input connection highlights producing cards and Escape clears every candidate", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMultiSlotStationRoutingGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const station = page.locator('.react-flow__node[data-id="multi_station"]');
  const alloy = page.locator('.react-flow__node[data-id="multi_alloy"]');
  const chemical = page.locator('.react-flow__node[data-id="multi_chemical"]');
  const target = alloy.locator(".node-port--input").filter({ hasText: "钛块" }).locator(".factory-handle--input");

  await target.click();
  await expect(page.locator(".factory-click-connection-preview")).toBeVisible();
  await expect(alloy).toHaveClass(/factory-flow-node--connection-origin/);
  await expect(station).toHaveClass(/factory-flow-node--connection-candidate/);
  await expect(chemical).not.toHaveClass(/factory-flow-node--connection-candidate/);

  await page.keyboard.press("Escape");
  await expect(page.locator(".factory-click-connection-preview")).toHaveCount(0);
  await expect(page.locator(".factory-flow-node--connection-origin, .factory-flow-node--connection-candidate")).toHaveCount(0);
});

test("a building card owns clicks where a belt passes behind it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEdgeOverlapGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const sourceHandle = page.locator('.react-flow__node[data-id="overlap_source"] .factory-handle--output');
  const targetHandle = page.locator('.react-flow__node[data-id="overlap_target"] [data-handleid="in:iron_ingot"]');
  const blocker = page.locator('.react-flow__node[data-id="overlap_blocker"]');
  const sourceBox = await sourceHandle.boundingBox();
  const targetBox = await targetHandle.boundingBox();
  const blockerBox = await blocker.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(blockerBox).not.toBeNull();
  const point = {
    x: blockerBox!.x + blockerBox!.width / 2,
    y: (sourceBox!.y + sourceBox!.height / 2 + targetBox!.y + targetBox!.height / 2) / 2,
  };
  expect(point.y).toBeGreaterThan(blockerBox!.y);
  expect(point.y).toBeLessThan(blockerBox!.y + blockerBox!.height);
  await expect.poll(async () => page.evaluate(({ x, y }) =>
    document.elementsFromPoint(x, y).some((element) => element.closest('.react-flow__node[data-id="overlap_blocker"]')), point)).toBe(true);
  await page.mouse.click(point.x, point.y);
  await expect(blocker).toHaveClass(/selected/);
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(0);
});

test("continuous belt networks diagnose, reroute, focus, synchronize and recycle as one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBeltNetworkGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const edges = page.locator(".react-flow__edge");
  await expect(edges).toHaveCount(2);
  await page.getByLabel("打开生产网络总览").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await expect(statistics.getByRole("tab", { name: /网络/ })).toHaveAttribute("aria-selected", "true");
  await expect(statistics.locator(".network-row")).toHaveCount(1);
  await statistics.getByLabel("吞吐热力图").check();
  await expect(page.locator(".game-shell")).toHaveAttribute("data-network-heatmap", "true");
  await statistics.locator(".network-row input[type=checkbox]").check();
  await statistics.getByLabel("批量线路路由").selectOption("lower");
  await statistics.getByRole("button", { name: "批量改道" }).click();
  await statistics.getByLabel("画布书签名称").fill("铁块主干");
  await statistics.getByLabel("保存当前画布视角").click();
  await expect(statistics.getByLabel("铁块主干名称")).toHaveValue("铁块主干");
  await page.screenshot({ path: "artifacts/qa/network-overview-3-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => statistics.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(statistics.locator(".network-row")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/network-overview-3-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await statistics.getByLabel("定位铁块网络").click();
  await expect(statistics).toHaveCount(0);

  await edges.first().evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const inspector = page.locator(".inspector-panel");
  await expect(inspector.locator(".belt-network-diagnostic")).toContainText("连续网络诊断");
  await expect(inspector.locator(".belt-network-diagnostic")).toContainText("线路 2");

  const beforePath = await page.locator(".factory-edge-visual-path").first().getAttribute("d");
  await inspector.getByRole("button", { name: "手动", exact: true }).click();
  await inspector.locator(".belt-route-offset input").fill("240");
  await expect(inspector.locator(".belt-route-offset output")).toHaveText("240");
  const manualPath = await page.locator(".factory-edge-visual-path").first().getAttribute("d");
  expect(manualPath).not.toBe(beforePath);
  await inspector.getByRole("button", { name: "上绕", exact: true }).click();
  const afterPath = await page.locator(".factory-edge-visual-path").first().getAttribute("d");
  expect(afterPath).not.toBe(manualPath);
  await inspector.getByRole("button", { name: "高", exact: true }).click();
  await inspector.getByRole("button", { name: "设置应用整网" }).click();

  await edges.nth(1).evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(inspector.getByRole("button", { name: "上绕", exact: true })).toHaveClass(/active/);
  await expect(inspector.getByRole("button", { name: "高", exact: true })).toHaveClass(/active/);
  await inspector.getByRole("button", { name: "聚焦上下游" }).click();
  await expect(page.locator('.react-flow__node[data-id="network_unrelated"]')).toHaveClass(/factory-flow-node--network-dim/);
  await expect(page.locator(".network-focus-indicator")).toContainText("2 线路");
  await page.screenshot({ path: "artifacts/qa/belt-network-3-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  if (!await page.locator(".game-shell").evaluate((element) => element.classList.contains("mobile-panel--inspector"))) {
    await page.getByLabel("打开检查器").click();
  }
  await expect(inspector.locator(".belt-network-diagnostic")).toBeVisible();
  await expect.poll(async () => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/belt-network-3-mobile.png", fullPage: true });
  await inspector.getByRole("button", { name: "回收整条网络 ×2" }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.getByTitle("选择传送带 Mk.I连接节点端口")).toContainText("×4");
});

test("Dyson planner builds independent orbital layers across unlocked star systems", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDysonPlannerGame(page);
  await page.getByTitle("打开戴森球规划").click();
  const planner = page.getByRole("dialog", { name: "戴森球规划" });
  await expect(planner).toBeVisible();
  await expect(planner.getByTitle("规划赫利俄斯戴森球")).toBeVisible();
  await expect(planner.getByTitle("规划北冕座戴森球")).toBeVisible();

  await planner.getByTitle("新建八节点闭合标准壳层").click();
  const summary = planner.locator(".dyson-stage-summary");
  await expect(summary.locator("span").filter({ hasText: "节点" })).toContainText("8");
  await expect(summary.locator("span").filter({ hasText: "框架" })).toContainText("8");
  await expect(summary.locator("span").filter({ hasText: "壳面" })).toContainText("8");
  await expect(planner.locator(".dyson-layer-list > button")).toHaveCount(1);

  const shellInspector = planner.locator(".dyson-layer-inspector");
  const radius = shellInspector.locator(":scope > .dyson-orbit-control").filter({ hasText: "轨道半径" });
  const inclination = shellInspector.locator(":scope > .dyson-orbit-control").filter({ hasText: "轨道倾角" });
  const longitude = shellInspector.locator(":scope > .dyson-orbit-control").filter({ hasText: "升交点经度" });
  await radius.locator("input").fill("20000");
  await inclination.locator("input").fill("37");
  await longitude.locator("input").fill("124");
  await expect(radius).toContainText("20,000 m");
  await expect(inclination).toContainText("37°");
  await expect(longitude).toContainText("124°");

  await planner.getByTitle("规划北冕座戴森球").click();
  await expect(planner.locator(".dyson-layer-list > button")).toHaveCount(0);
  await planner.getByTitle("新建八节点闭合标准壳层").click();
  await expect(planner.locator(".dyson-layer-list > button")).toHaveCount(1);
  await expect(planner.locator(".dyson-layer-inspector > header")).toContainText("标准壳层 1");

  await planner.getByTitle("规划赫利俄斯戴森球").click();
  await expect(radius.locator("input")).toHaveValue("20000");
  await expect(inclination.locator("input")).toHaveValue("37");
  await expect(longitude.locator("input")).toHaveValue("124");
  await expect(planner.locator(".dyson-orbit-node")).toHaveCount(8);

  const swarmInspector = planner.locator(".dyson-swarm-orbit-inspector");
  await expect(planner.locator(".dyson-swarm-orbit-list > button")).toHaveCount(1);
  await planner.getByText("新增太阳帆轨道", { exact: true }).click();
  await expect(planner.locator(".dyson-swarm-orbit-list > button")).toHaveCount(2);
  const swarmRadius = swarmInspector.locator(".dyson-orbit-control").filter({ hasText: "轨道半径" });
  const swarmInclination = swarmInspector.locator(".dyson-orbit-control").filter({ hasText: "轨道倾角" });
  const swarmLongitude = swarmInspector.locator(".dyson-orbit-control").filter({ hasText: "升交点经度" });
  await swarmRadius.locator("input").fill("28000");
  await swarmInclination.locator("input").fill("31");
  await swarmLongitude.locator("input").fill("122");
  await expect(swarmRadius).toContainText("28,000 m");
  await expect(swarmInclination).toContainText("31°");
  await expect(swarmLongitude).toContainText("122°");
  await planner.getByText("太阳帆", { exact: true }).click();
  await planner.getByText("50%", { exact: true }).click();
  await expect(planner.locator(".dyson-launch-mode button.active")).toHaveText("太阳帆");
  await expect(planner.locator(".dyson-launch-throttle button.active")).toHaveText("50%");
  const launchToggle = planner.getByRole("button", { name: "暂停戴森发射" });
  await expect(launchToggle).toHaveCount(1);
  await launchToggle.click();
  await expect(planner.getByRole("button", { name: "启用戴森发射" })).toHaveCount(1);
  await expect(planner.locator(".dyson-engineering-ledger")).toContainText("发射能耗");
  await page.screenshot({ path: "artifacts/qa/dyson-planner-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await planner.locator(".dyson-orbit-stage").scrollIntoViewIfNeeded();
  await expect.poll(async () => planner.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(planner.locator(".dyson-orbit-canvas")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/dyson-planner-390.png", fullPage: true });
});

test("galactic industry console runs infinite research and mega exports", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEndgameStageGame(page);
  await page.getByLabel("打开生产统计").click();
  const statistics = page.getByRole("dialog", { name: "生产统计" });
  await statistics.getByRole("tab", { name: /银河/ }).click();
  await expect(statistics.locator(".galactic-summary-grid")).toContainText("银河评分");
  await expect(statistics.locator(".galactic-industry")).toContainText("银河物资出口");
  await expect(statistics.locator(".infinite-research-list > button")).toHaveCount(5);

  await statistics.locator(".infinite-research-list > button").filter({ hasText: "矩阵压缩" }).click();
  await expect(statistics.locator(".infinite-research-list > button.active")).toContainText("矩阵压缩");
  const archive = statistics.locator(".export-project-list > article").filter({ hasText: "宇宙矩阵档案" });
  await archive.getByRole("button", { name: /启用宇宙矩阵档案/ }).click();
  await archive.getByRole("button", { name: "P3" }).click();
  await archive.locator('button[title="立即装运一批物资"]').click();
  await expect(archive).toHaveClass(/active/);
  await expect(archive.locator(".export-project-progress")).toContainText("120");
  await page.screenshot({ path: "artifacts/qa/galactic-industry-1440.png", fullPage: true });

  await statistics.getByLabel("关闭生产统计").click();
  await page.getByLabel("打开科技树").click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  await technology.getByLabel("展开科研详情").click();
  await expect(technology.locator(".infinite-research-console")).toContainText("矩阵压缩");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => technology.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/galactic-industry-390.png", fullPage: true });
});

test("technology upgrades expose balanced global effects in research and equipment views", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTechnologyUpgradeGame(page);
  await page.getByLabel("打开科技树").click();
  const technology = page.getByRole("dialog", { name: "科技树" });
  await technology.getByLabel("展开科研详情").click();
  const upgrades = technology.getByLabel("全局科技升级效果");
  await expect(upgrades).toContainText("固体采矿3.00×");
  await expect(upgrades).toContainText("科研吞吐1.75×");
  await expect(upgrades).toContainText("物流航速2.00×");
  await expect(upgrades).toContainText("机 / 船载荷50 / 200");
  await expect(upgrades).toContainText("太阳帆寿命40 min");
  await expect(upgrades).toContainText("单站接收12 MW");
  await expect(upgrades).toContainText("壳面吸附2.00×");
  await expect(technology.locator(".technology-node").filter({ hasText: "壳面吸附效率" })).toHaveClass(/technology-node--complete/);
  await page.screenshot({ path: "artifacts/qa/technology-upgrades-1440.png", fullPage: true });

  await page.getByLabel("关闭科技树").click();
  await page.locator('.react-flow__node[data-id="upgrade_station"] .station-node').evaluate((element: HTMLElement) => element.click());
  const inspector = page.locator(".inspector-panel");
  await expect(inspector).toContainText("单机载荷50 件/架");
  await expect(inspector).toContainText("最低启航货量25 件/架");
  await expect(inspector).toContainText("额定航程4.0 秒");
  await page.locator('.react-flow__node[data-id="upgrade_receiver"] .machine-node').evaluate((element: HTMLElement) => element.click());
  await expect(inspector).toContainText("额定接收12 MW");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("更多工作区").click();
  await page.getByRole("menuitem", { name: "科技树" }).click();
  await technology.getByLabel("展开科研详情").click();
  await expect(upgrades).toBeVisible();
  await expect.poll(async () => technology.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "artifacts/qa/technology-upgrades-390.png", fullPage: true });
});

test("planetary drones, orbital collection, station warpers and direct belt logistics form a complete logistics layer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCompleteLogisticsGame(page);
  await expect(page.getByLabel("随身物流运输船，当前 2")).toHaveCount(1);
  await page.getByTitle("切换到烬原 II").click();
  await page.locator(".react-flow__controls-fitview").click();
  const ashenStation = page.locator(".station-node").filter({ hasText: "星际物流站" });
  await ashenStation.click();
  await expect(page.locator(".inspector-panel")).toContainText("随身 2");
  await page.getByLabel("物流运输船目标数量").fill("1");
  await page.getByLabel("物流运输船目标数量").blur();
  await expect(page.locator(".inspector-panel").locator(".station-fleet-control .station-fleet-summary strong")).toContainText("1 / 10");
  await expect(page.getByLabel("随身物流运输船，当前 1")).toHaveCount(1);
  await expect(page.locator(".planet-transition")).toHaveCount(0);
  await page.locator(".construction-items").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await page.screenshot({ path: "artifacts/qa/portable-fleet-ashen-1440.png", fullPage: true });
  await page.getByTitle("切换到澄海 I").click();
  await page.locator(".react-flow__controls-fitview").click();

  const localDemand = page.locator(".station-node").filter({ hasText: "行星物流站" }).filter({ hasText: "需求" });
  await localDemand.click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector).toContainText("运输机泊位");
  await expect(inspector.locator(".station-fleet-summary strong")).toContainText("2 / 50");
  await page.getByLabel("继续模拟").click();
  await expect.poll(async () => Number(await localDemand.getByTitle("拿取铁块").locator("strong").textContent()), { timeout: 4_000 }).toBeGreaterThanOrEqual(50);

  const hydrogenDemand = page.locator(".station-node").filter({ hasText: "星际物流站" });
  await hydrogenDemand.click();
  await expect(inspector).toContainText("翘曲器仓");
  await expect(inspector).toContainText("2 / 50");
  await inspector.getByLabel("目标库存").fill("5");
  await inspector.getByLabel("目标库存").blur();
  await inspector.getByLabel("自动补充专用翘曲器仓").click();
  await expect.poll(async () => inspector.locator(".station-warper-control .station-fleet-stepper strong").textContent(), { timeout: 4_000 }).toContain("3 / 50");
  await expect(inspector).toContainText("塔内物流槽与本星球托盘均缺少空间翘曲器");
  await expect.poll(async () => Number(await hydrogenDemand.getByTitle("拿取氢").locator("strong").textContent()), { timeout: 4_000 }).toBeGreaterThanOrEqual(10);
  await page.screenshot({ path: "artifacts/qa/complete-logistics-home-1440.png", fullPage: true });

  await page.locator(".react-flow__edge").evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(inspector).toContainText("传送带等级");
  await expect(inspector).toContainText("线路上限");
  await expect(inspector).toContainText("12/s");
  await expect(inspector).not.toContainText("分拣器等级");

  await page.getByTitle("切换到苍岚 III").click();
  const collector = page.locator(".station-node").filter({ hasText: "轨道采集器" });
  await collector.click();
  await expect(inspector).toContainText("气态巨星轨道设施");
  await expect(inspector).toContainText("采集资源");
  await expect(inspector).toContainText("轨道采集氢中");
  await page.screenshot({ path: "artifacts/qa/orbital-collector-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inspector).toBeVisible();
  await expect.poll(async () => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByLabel("行星切换").locator("button:not(.planet-navigator__toggle)")).toHaveCount(3);
  await page.screenshot({ path: "artifacts/qa/orbital-collector-390.png", fullPage: true });
});

test("multi-slot stations and monitored stacked lines stay operable on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCompleteLogisticsGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  const demand = page.locator(".station-node").filter({ hasText: "行星物流站" }).filter({ hasText: "需求" });
  await demand.click();
  const inspector = page.locator(".station-inspector");
  const slots = inspector.locator(".station-slot");
  await expect(slots).toHaveCount(5);
  await expect(slots.nth(1).getByRole("button", { name: "选择槽位 2 物资" })).toBeVisible();
  await expect(slots.nth(0)).not.toContainText("航路");
  await expect(slots.nth(0)).not.toContainText("翘曲预算");
  await expect(slots.nth(0)).not.toContainText("保留");
  await chooseItem(page, slots.nth(1), "铜块");
  await slots.nth(1).getByRole("button", { name: "需求", exact: true }).click();
  await slots.nth(1).getByRole("button", { name: "25%", exact: true }).click();
  await expect(inspector).toContainText("已配置槽位2 / 5");
  await page.screenshot({ path: "artifacts/qa/logistics-slots-1440.png", fullPage: true });

  await page.locator(".react-flow__edge").evaluate((element: SVGGElement) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const beltInspector = page.locator(".inspector-panel");
  await beltInspector.getByRole("button", { name: "×2", exact: true }).click();
  await beltInspector.getByRole("button", { name: "高", exact: true }).click();
  await beltInspector.getByLabel("启用线路流量监测").check();
  await expect(beltInspector).toContainText("货物堆叠×2");
  await expect(beltInspector).toContainText("累计运输");

  await page.setViewportSize({ width: 390, height: 844 });
  await demand.evaluate((element: HTMLElement) => element.click());
  await expect(inspector).toBeVisible();
  await expect.poll(async () => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await slots.nth(1).locator(".catalog-picker-trigger").click();
  const mobileItemPicker = page.getByRole("dialog", { name: "物品选择面板" });
  await expect(mobileItemPicker.getByLabel("搜索物品")).not.toBeFocused();
  await mobileItemPicker.getByRole("button", { name: "关闭物品选择" }).click();
  await page.screenshot({ path: "artifacts/qa/logistics-slots-390.png", fullPage: true });
});

test("renewables, storage, fusion and artificial stars form a complete energy layer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCompleteEnergyGame(page);
  await page.locator(".react-flow__controls-fitview").click();
  for (const building of ["太阳能板", "地热发电站", "微型聚变发电站", "人造恒星", "蓄电器", "能量枢纽"]) {
    await expect(page.locator(".construction-item").filter({ hasText: building })).toHaveCount(1);
  }

  const accumulator = page.locator(".power-node").filter({ hasText: "蓄电器" }).filter({ hasNotText: "能量枢纽" });
  await accumulator.click();
  await expect(page.locator(".energy-inspector")).toContainText("45.00 / 90 MJ");
  await expect(page.locator(".energy-meter")).toHaveAttribute("aria-valuenow", "50");

  const exchanger = page.locator(".power-node").filter({ hasText: "能量枢纽" });
  await exchanger.click();
  const inspector = page.locator(".energy-inspector");
  await expect(inspector).toContainText("蓄电器 → 蓄电器（满）");
  await inspector.getByRole("button", { name: "放电", exact: true }).click();
  await expect(inspector).toContainText("蓄电器（满） → 蓄电器");
  await expect(exchanger.getByTitle("投入蓄电器（满）")).toBeVisible();
  await expect(exchanger.getByTitle("拿取蓄电器")).toBeVisible();

  const fusion = page.locator(".power-node").filter({ hasText: "微型聚变发电站" });
  await fusion.click();
  await expect(page.locator(".inspector-content select option")).toHaveCount(2);
  await expect(page.locator(".inspector-content select")).toHaveValue("deuteron_fuel_rod");
  const star = page.locator(".power-node").filter({ hasText: "人造恒星" });
  await star.click();
  await expect(page.locator(".inspector-content select")).toHaveValue("antimatter_fuel_rod");
  await page.screenshot({ path: "artifacts/qa/complete-energy-home-1440.png", fullPage: true });

  await page.getByLabel("打开生产统计").click();
  await page.getByRole("tab", { name: "电力" }).click();
  const powerStatistics = page.locator(".statistics-power");
  await expect(powerStatistics).toContainText("太阳能容量");
  await expect(powerStatistics).toContainText("地热容量");
  await expect(powerStatistics).toContainText("聚变出力");
  await expect(powerStatistics).toContainText("人造恒星");
  await expect(powerStatistics).toContainText("储能水平");
  await page.screenshot({ path: "artifacts/qa/complete-energy-statistics-1440.png", fullPage: true });
  await page.getByLabel("关闭生产统计").click();

  await page.getByLabel("打开科技树").click();
  for (const technology of ["太阳能收集", "能量储存", "地热发电", "可控核聚变", "人造恒星"]) {
    await expect(page.locator(".technology-node").filter({ has: page.getByText(technology, { exact: true }) })).toHaveCount(1);
  }
  await page.getByLabel("关闭科技树").click();

  await page.getByTitle("切换到烬原 II").click();
  await page.locator(".react-flow__controls-fitview").click();
  const geothermal = page.locator(".power-node").filter({ hasText: "地热发电站" });
  await expect(geothermal).toBeVisible();
  await expect(page.locator(".power-node").filter({ hasText: "太阳能板" }).locator(".power-output")).toContainText("540 kW");
  await geothermal.click();
  await page.screenshot({ path: "artifacts/qa/complete-energy-1440.png", fullPage: true });

  await page.getByTitle("切换到澄海 I").click();
  await page.locator(".react-flow__controls-fitview").click();
  await exchanger.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".inspector-panel")).toBeVisible();
  await expect(page.locator(".energy-inspector")).toContainText("能量枢纽");
  await expect(page.locator(".energy-inspector")).toContainText("蓄电器（满） → 蓄电器");
  await expect.poll(async () => page.locator(".inspector-panel").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(async () => {
    const box = await page.locator(".inspector-panel").boundingBox();
    return box ? Math.ceil(box.x + box.width) : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(390);
  await expect(page.locator(".game-notice")).toBeHidden({ timeout: 6_000 });
  await page.screenshot({ path: "artifacts/qa/complete-energy-390.png", fullPage: true });
});

test("rare resources, fractionation and quantum chemistry expose every alternative chain", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRareResourceStageGame(page);
  await page.locator(".react-flow__controls-fitview").click();

  const fractionator = page.locator(".machine-node").filter({ hasText: "分馏塔" });
  await expect(fractionator.getByTitle("取出氢")).toBeVisible();
  await expect(fractionator.getByTitle("拿取氢")).toBeVisible();
  await expect(fractionator.getByTitle("拿取氘")).toBeVisible();

  const chemical = page.locator(".machine-node").filter({ hasText: "可燃冰裂解" });
  await expect(chemical.getByTitle("取出可燃冰")).toBeVisible();
  await expect(chemical.getByTitle("拿取石墨烯")).toBeVisible();
  await chemical.click();
  const inspector = page.locator(".inspector-content");
  await expect(inspector.getByTitle("升级为量子化工厂")).toBeVisible();
  await inspector.getByTitle("升级为量子化工厂").click();
  await expect(chemical).toContainText("量子化工厂");
  await expect(chemical).toContainText("可燃冰裂解");

  const thermal = page.locator(".power-node").filter({ hasText: "火力发电厂" });
  await thermal.click();
  await expect(page.locator(".inspector-content select")).toHaveValue("hydrogen_fuel_rod");
  await expect(page.locator(".inspector-content select option").filter({ hasText: "氢燃料棒" })).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/rare-alternatives-home-1440.png", fullPage: true });

  await page.getByLabel("打开生产资料库").click();
  const codex = page.getByRole("dialog", { name: "生产资料库" });
  await codex.getByLabel("搜索配方物品").fill("石墨烯");
  await codex.locator(".recipe-index > button").filter({ hasText: "石墨烯" }).click();
  await expect(codex.locator(".recipe-method").filter({ hasText: "可燃冰裂解" })).toContainText("可燃冰");
  await expect(codex.locator(".recipe-method").filter({ hasText: "石墨烯" }).first()).toContainText("化工厂");
  await codex.getByLabel("搜索配方物品").fill("有机晶体");
  await codex.locator(".recipe-index > button").filter({ hasText: "有机晶体" }).click();
  await expect(codex.locator(".recipe-method--source")).toContainText("烬原 II");
  await expect(codex.locator(".recipe-section").first().locator(".recipe-method:not(.recipe-method--source)").filter({ hasText: "有机晶体" })).toContainText("塑料");
  await page.screenshot({ path: "artifacts/qa/rare-recipe-codex-1440.png", fullPage: true });
  await page.getByLabel("关闭生产资料库").click();

  await page.getByLabel("打开科技树").click();
  for (const technology of ["流体分馏", "稀有资源利用", "量子化工"]) {
    await expect(page.locator(".technology-node").filter({ has: page.getByText(technology, { exact: true }) })).toHaveCount(1);
  }
  await page.getByLabel("关闭科技树").click();

  await page.getByTitle("切换到烬原 II").click();
  await page.locator(".react-flow__controls-fitview").click();
  for (const resource of ["金伯利矿石", "分形硅石", "有机晶体"]) {
    await expect(page.locator(".vein-node").filter({ hasText: resource })).toHaveCount(1);
  }

  await page.getByLabel("打开星图").click();
  await page.getByRole("dialog", { name: "星图" }).locator(".star-system-card").filter({ has: page.getByText("北冕座", { exact: true }) }).getByRole("button", { name: /霜原 I/ }).click();
  await page.locator(".react-flow__controls-fitview").click();
  for (const resource of ["光栅石", "刺笋结晶", "可燃冰"]) {
    await expect(page.locator(".vein-node").filter({ hasText: resource })).toHaveCount(1);
  }
  await page.screenshot({ path: "artifacts/qa/rare-resource-field-1440.png", fullPage: true });

  await page.getByLabel("打开星图").click();
  await page.getByRole("dialog", { name: "星图" }).locator(".star-system-card").filter({ hasText: "赫卡忒" }).getByRole("button", { name: /极夜 I/ }).click();
  await page.locator(".react-flow__controls-fitview").click();
  await expect(page.locator(".vein-node").filter({ hasText: "单极磁石" })).toHaveCount(1);

  await page.getByLabel("打开星图").click();
  await page.getByRole("dialog", { name: "星图" }).locator(".star-system-card").filter({ hasText: "赫利俄斯" }).getByRole("button", { name: /苍岚 III/ }).click();
  const collector = page.locator(".station-node").filter({ hasText: "轨道采集器" });
  await collector.click();
  await expect(page.locator(".station-inspector .catalog-picker-trigger")).toContainText("可燃冰");
  await expect(page.locator(".station-inspector").getByLabel("选择采集资源")).toBeVisible();
  await expect(collector.getByTitle("拿取可燃冰")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".station-inspector .catalog-picker-trigger")).toContainText("可燃冰");
  await expect.poll(async () => {
    const box = await page.locator(".inspector-panel").boundingBox();
    return box ? Math.ceil(box.x + box.width) : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(390);
  await expect(page.locator(".game-notice")).toBeHidden({ timeout: 6_000 });
  await page.screenshot({ path: "artifacts/qa/rare-orbital-collector-390.png", fullPage: true });
});

test("stellar exploration unlocks remote planets and enables a warped logistics route", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStellarExplorationGame(page);
  await page.getByTitle("拿取钛块").click();
  await expect(page.locator(".cargo-slot")).toContainText("钛块");

  await page.getByLabel("打开星图").click();
  const starMap = page.getByRole("dialog", { name: "星图" });
  await expect(starMap.locator(".star-system-card")).toHaveCount(8);
  await expect(starMap.locator(".star-planet-list > button")).toHaveCount(22);
  await expect(starMap.locator(".star-system-card").filter({ has: page.getByText("蔚蓝王座", { exact: true }) })).toContainText("L☉");
  const borealis = starMap.locator(".star-system-card").filter({ has: page.getByText("北冕座", { exact: true }) });
  const neutron = starMap.locator(".star-system-card").filter({ has: page.getByText("赫卡忒", { exact: true }) });
  await expect(borealis).toContainText("未勘探");
  const borealGiant = borealis.getByRole("button", { name: /青冥 II/ });
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("殖民前哨需求");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("材料取自“澄海 I”物资托盘");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("运输载具取自随身载具栏");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("当前行星托盘");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("随身载具");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText("北冕座");
  await expect(neutron.getByRole("button", { name: "勘探赫卡忒" })).toBeDisabled();

  await borealis.getByRole("button", { name: "勘探北冕座" }).click();
  await expect(borealis).toContainText("已发现");
  await expect(borealGiant.locator(".planet-colony-requirements")).toContainText(/材料不足|材料满足/);
  await expect(neutron.getByRole("button", { name: "勘探赫卡忒" })).toBeEnabled();
  await neutron.getByRole("button", { name: "勘探赫卡忒" }).click();
  await expect(neutron).toContainText("已发现");
  await page.screenshot({ path: "artifacts/qa/stellar-map-1440.png", fullPage: true });

  await borealis.getByRole("button", { name: /霜原 I/ }).click();
  await expect(page.locator(".canvas-status")).toContainText("霜原 I");
  await expect(page.locator(".vein-node").filter({ hasText: "光栅石" })).toBeVisible();
  await expect(page.locator(".cargo-slot")).toContainText("钛块");
  await expect(page.locator(".game-notice")).toContainText("托钛天王");

  await page.getByLabel("继续模拟").click();
  const supply = page.locator(".station-node").filter({ hasText: "星际物流站" });
  await supply.click();
  const tripRow = page.locator(".station-inspector .metric-ledger > div").filter({ hasText: "完成航次" });
  await expect(tripRow).toContainText("1", { timeout: 3_000 });
  await expect(page.locator(".station-inspector")).toContainText("跨恒星");
  await page.screenshot({ path: "artifacts/qa/stellar-frost-route-1440.png", fullPage: true });

  await page.getByLabel("打开星图").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(starMap).toBeVisible();
  await expect(starMap.locator(".star-map-route").evaluate((element) => element.scrollWidth <= element.clientWidth)).resolves.toBe(true);
  await expect(starMap.locator(".star-system-card")).toHaveCount(8);
  await expect(starMap.locator(".star-planet-list > button")).toHaveCount(22);
  await page.screenshot({ path: "artifacts/qa/stellar-map-390.png", fullPage: true });
});

test("star map industrial console exposes global routes, planet roles and quick diagnostics", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStellarExplorationGame(page);
  await page.getByLabel("打开星图").click();
  const starMap = page.getByRole("dialog", { name: "星图" });
  const ashenProfile = starMap.getByRole("button", { name: /烬原 II/ });
  await expect(ashenProfile).toContainText("高热冶金");
  await expect(ashenProfile.locator(".star-planet-traits")).toContainText("矿储 115%");
  await expect(ashenProfile.locator(".star-planet-traits")).toContainText("光 150%");
  await expect(ashenProfile.locator(".star-planet-traits")).toContainText("地热 100%");
  await expect(ashenProfile.locator(".star-planet-traits")).toContainText("航程 105%");
  await starMap.getByRole("tab", { name: "星际工业" }).click();
  const industry = starMap.locator(".stellar-industry");
  await expect(industry).toBeVisible();
  await expect(industry).toContainText("全局航线表");
  await expect(industry.locator(".stellar-route-row")).toHaveCount(1);
  await expect(industry.locator(".stellar-route-row")).toContainText("光栅石");
  await expect(industry.locator(".stellar-route-row")).toContainText("翘曲");
  await expect(industry.locator(".stellar-route-row")).toContainText("路径");
  await expect(industry.locator(".stellar-route-row")).toContainText("策略");
  const frostIndustry = industry.locator(".stellar-planet-row").filter({ has: page.getByText("霜原 I", { exact: true }) });
  await expect(frostIndustry.locator(".stellar-planet-metrics")).toContainText("宜 化工基地");
  await page.screenshot({ path: "artifacts/qa/stellar-industry-1440.png", fullPage: true });

  await starMap.getByRole("tab", { name: "星图探索" }).click();
  const borealis = starMap.locator(".star-system-card").filter({ has: page.getByText("北冕座", { exact: true }) });
  await borealis.getByRole("button", { name: "勘探北冕座" }).click();
  await starMap.getByRole("tab", { name: "星际工业" }).click();
  await expect(industry.locator(".stellar-route-row")).toContainText("等待发船");

  const frostRole = industry.getByLabel("霜原 I工业角色");
  await frostRole.selectOption("chemical");
  await expect(frostRole).toHaveValue("chemical");
  await industry.getByRole("button", { name: /定位光栅石需求站/ }).click();
  await expect(page.locator(".canvas-status")).toContainText("澄海 I");
  await expect(page.locator(".station-inspector")).toBeVisible();

  await page.getByLabel("打开星图").click();
  await starMap.getByRole("tab", { name: "星际工业" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(starMap.locator(".stellar-industry")).toBeVisible();
  await expect(starMap.locator(".stellar-route-row")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/stellar-industry-390.png", fullPage: true });
});

test("stellar workspaces stay usable at 150 percent font scale on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStellarExplorationGame(page);
  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await operations.locator(".settings-category-overview").getByRole("button", { name: "画面与主题" }).click();
  await operations.getByLabel("字体大小").getByRole("button", { name: "150%" }).click();
  await operations.getByLabel("关闭运营中心").click();

  await page.getByLabel("打开星图").click();
  const starMap = page.getByRole("dialog", { name: "星图" });
  await expect(starMap.getByLabel("关闭星图")).toBeVisible();
  await expect(starMap.locator(".star-system-card")).toHaveCount(8);
  await expect(starMap.locator(".star-system-card").evaluateAll((cards) => cards.every((card) => card.scrollHeight <= card.clientHeight + 1))).resolves.toBe(true);
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/stellar-map-150-1440.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const box = await starMap.boundingBox();
    return box ? Math.ceil(box.x + box.width) : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(390);
  await expect(starMap.getByLabel("关闭星图")).toBeVisible();
  await starMap.getByRole("tab", { name: "星际工业" }).click();
  await expect(starMap.locator(".stellar-route-row")).toHaveCount(1);
  await page.screenshot({ path: "artifacts/qa/stellar-industry-150-390.png", fullPage: true });

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(starMap.getByLabel("关闭星图")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/stellar-industry-150-844x390.png", fullPage: true });
  await starMap.getByLabel("关闭星图").click();

  await page.getByLabel("打开物资托盘").click();
  await page.getByTitle("打开戴森球规划").click();
  const planner = page.getByRole("dialog", { name: "戴森球规划" });
  await expect(planner.getByLabel("关闭戴森球规划")).toBeVisible();
  await expect(planner.locator(".dyson-system-tabs button")).toHaveCount(1);
  await page.waitForTimeout(220);
  await page.screenshot({ path: "artifacts/qa/dyson-planner-150-844x390.png", fullPage: true });
});

test("interstellar station exposes relay hub and compact per-slot controls on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStellarExplorationGame(page);
  const station = page.locator(".station-node").filter({ hasText: "星际物流站" });
  await station.click();
  const inspector = page.locator(".station-inspector");
  await inspector.getByLabel("中转物流枢纽").check();
  await inspector.getByLabel("枢纽优先级").selectOption("2");
  const slot = inspector.locator('[data-station-slot-index="0"]');
  await slot.locator(".station-slot-scope").first().getByRole("button", { name: "需求", exact: true }).click();
  await slot.getByLabel("槽位 1 优先级").selectOption("2");
  await slot.getByLabel("槽位 1 库存上限").fill("2500");
  await slot.getByLabel("槽位 1 库存上限").blur();
  await expect(inspector.getByLabel("中转物流枢纽")).toBeChecked();
  await expect(inspector.getByLabel("枢纽优先级")).toHaveValue("2");
  await expect(slot.locator(".station-slot-scope").first().getByRole("button", { name: "需求", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(slot.getByLabel("槽位 1 优先级")).toHaveValue("2");
  await expect(slot.getByLabel("槽位 1 库存上限")).toHaveValue("2500");
  await expect(inspector.getByLabel("航路")).toHaveCount(0);
  await expect(inspector.getByLabel("翘曲预算")).toHaveCount(0);

  await page.getByLabel("打开设置").click();
  const operations = page.getByRole("dialog", { name: "运营中心" });
  await operations.locator(".operations-tabs").getByRole("tab", { name: "设置" }).click();
  await selectSettingsCategory(operations, "画面与主题", "visual");
  await operations.getByLabel("字体大小").getByRole("button", { name: "150%" }).click();
  await operations.getByLabel("关闭运营中心").click();
  await page.setViewportSize({ width: 390, height: 844 });
  if (!await page.locator(".game-shell").evaluate((element) => element.classList.contains("mobile-panel--inspector"))) {
    await page.getByLabel("打开检查器").click();
  }
  await expect(inspector.getByLabel("中转物流枢纽")).toBeVisible();
  await expect.poll(async () => inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await slot.getByLabel("槽位 1 优先级").scrollIntoViewIfNeeded();
  await expect(slot.getByLabel("槽位 1 优先级")).toBeVisible();
  await expect(slot.getByLabel("槽位 1 库存上限")).toBeVisible();
  await page.screenshot({ path: "artifacts/qa/interstellar-relay-controls-150-390.png", fullPage: true });
});
