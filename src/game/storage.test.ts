/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addCanvasBookmark, addCanvasRegion, addDysonSwarmOrbit, connectBelt, createBlueprint, createInitialState, createStandardDysonLayer, installMiner, pauseCurrentResearch, placeBuilding, queueBlueprint, queueHandcraftRecipe, resizeCanvasRegion, selectTechnology, setActivePlanet, setBeltRouteOffsetY, setBlueprintTransform, setDysonLaunchMode, setDysonLaunchThrottle, setDysonSwarmOrbit, setFuelItem, setLogisticsItem, setPlanetTrayItemLimit, setStationHubConfiguration, setStationSlotMode, setStationSlotRoutePolicy, setStationSlotWarperBudget, setStationWarperAutoRefill, setStationWarperTarget } from "./engine";
import { createProductionPlan } from "./planning";
import { clearGameSlot, exportGame, exportGameSlot, getSaveSlotSummaries, getSaveSnapshotSummaries, importGame, inspectSave, loadGame, loadGameSlot, loadSaveSnapshot, migrateGame, saveGame, saveGameSnapshot, saveGameSlot } from "./storage";
import { getOfflineSimulationLimitSeconds } from "./endgame";

const SAVE_KEY = "dsp-idle-network.save.v1";

describe("game storage", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("round-trips a v17 multi-planet research save", () => {
    const state = createInitialState();
    state.research.selectedTechId = "electromagnetic_matrix";
    state.research.queuedTechIds = ["electromagnetism"];
    state.tray.iron_ore = 7;
    state.planetTrays.ashen.titanium_ore = 9;
    saveGame(state);

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.activePlanetId).toBe("home");
    expect(loaded.planetMetrics.ashen.powerFactor).toBe(1);
    expect(loaded.research.selectedTechId).toBe("electromagnetic_matrix");
    expect(loaded.research.queuedTechIds).toEqual(["electromagnetism"]);
    expect(loaded.tray.iron_ore).toBe(7);
    expect(loaded.planetTrays.ashen.titanium_ore).toBe(9);
  });

  it("round-trips v30 state while defaulting v27 fields safely", () => {
    let state = createInitialState();
    state.settings.allowDoubleClickZoom = true;
    state = selectTechnology(state, "electromagnetic_matrix");
    state.research.progressByTech.electromagnetic_matrix = { electromagnetic_matrix: 2 };
    state = pauseCurrentResearch(state);
    state = addCanvasRegion(state, "home", { x: 40, y: 80, width: 520, height: 280 }, "蓝糖区", "#224466", "#88CCAA");
    state = resizeCanvasRegion(state, state.canvasRegions[0].id, { x: -60, y: 30, width: 780, height: 440 });
    state = setPlanetTrayItemLimit(state, "home", 42_000);
    state = setPlanetTrayItemLimit(state, "ashen", 88_000);
    saveGame(state);

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.settings.allowDoubleClickZoom).toBe(true);
    expect(loaded.research).toMatchObject({ selectedTechId: null, pausedTechId: "electromagnetic_matrix" });
    expect(loaded.research.progressByTech.electromagnetic_matrix).toEqual({ electromagnetic_matrix: 2 });
    expect(loaded.canvasRegions).toEqual([expect.objectContaining({
      name: "蓝糖区",
      planetId: "home",
      x: -60,
      y: 30,
      width: 780,
      height: 440,
      fillColor: "#224466",
      borderColor: "#88CCAA",
    })]);
    expect(loaded.planetTrayItemLimits).toMatchObject({ home: 42_000, ashen: 88_000 });

    const legacy = JSON.parse(JSON.stringify(loaded));
    legacy.version = 27;
    delete legacy.settings.allowDoubleClickZoom;
    delete legacy.research.pausedTechId;
    delete legacy.canvasRegions;
    delete legacy.planetTrayItemLimits;
    legacy.tray.iron_ore = 1_200_000;
    legacy.planetTrays.home = { ...legacy.tray };
    const migrated = migrateGame(legacy)!;
    expect(migrated.version).toBe(31);
    expect(migrated.settings.allowDoubleClickZoom).toBe(false);
    expect(migrated.research.pausedTechId).toBeNull();
    expect(migrated.canvasRegions).toEqual([]);
    expect(migrated.planetTrayItemLimits.home).toBe(1_000_000);
    expect(migrated.tray.iron_ore).toBe(1_200_000);
    expect(migrated.research.progressByTech.electromagnetic_matrix).toEqual({ electromagnetic_matrix: 2 });
  });

  it("migrates v28 saves to guaranteed external-system oil exactly once without overwriting existing wells", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState(918_273, false))) as Record<string, any>;
    legacy.version = 28;
    legacy.settings.resourceMode = "finite";
    const guaranteedPlanets = ["pelagic", "dune", "prairie"];
    legacy.entities = legacy.entities.filter((entity: { planetId: string; resourceId?: string }) =>
      !guaranteedPlanets.includes(entity.planetId) || entity.resourceId !== "crude_oil");
    for (const planetId of guaranteedPlanets) {
      legacy.galaxy.profiles[planetId].resourceIds = legacy.galaxy.profiles[planetId].resourceIds.filter((itemId: string) => itemId !== "crude_oil");
    }

    const migrated = migrateGame(legacy)!;
    const wells = guaranteedPlanets.map((planetId) => migrated.entities.find((entity) =>
      entity.id === `vein_${planetId}_crude_oil`)!);
    expect(migrated.version).toBe(31);
    expect(wells.every((well) => well?.resourceId === "crude_oil")).toBe(true);
    expect(guaranteedPlanets.every((planetId) => migrated.galaxy.profiles[planetId as keyof typeof migrated.galaxy.profiles].resourceIds.includes("crude_oil"))).toBe(true);
    expect(wells[1].resourceCapacity).toBeGreaterThan(wells[2].resourceCapacity ?? 0);
    expect(wells[2].resourceCapacity).toBeGreaterThan(wells[0].resourceCapacity ?? 0);

    const repeated = migrateGame(JSON.parse(JSON.stringify(migrated)))!;
    for (const planetId of guaranteedPlanets) {
      expect(repeated.entities.filter((entity) => entity.planetId === planetId && entity.resourceId === "crude_oil")).toHaveLength(1);
    }

    const customLegacy = JSON.parse(JSON.stringify(createInitialState())) as Record<string, any>;
    customLegacy.version = 28;
    const customWell = customLegacy.entities.find((entity: { id: string }) => entity.id === "vein_dune_crude_oil");
    customWell.id = "legacy_dune_oil_well";
    customWell.resourceCapacity = 12_345;
    customWell.resourceRemaining = 6_789;
    const preserved = migrateGame(customLegacy)!;
    expect(preserved.entities.filter((entity) => entity.planetId === "dune" && entity.resourceId === "crude_oil")).toEqual([
      expect.objectContaining({ id: "legacy_dune_oil_well", resourceCapacity: 12_345, resourceRemaining: 6_789 }),
    ]);
  });

  it("migrates v29 station refill defaults without rewriting existing belt priorities", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("basic_logistics", "material_delivery_logistics", "space_warp");
    state.construction.interstellar_logistics_station = 1;
    state.construction.material_delivery_hub = 1;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: -240, y: 0 });
    state = placeBuilding(state, "material_delivery_hub", { x: 240, y: 0 });
    const station = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    const hub = state.entities.find((entity) => entity.buildingId === "material_delivery_hub")!;
    state = setStationWarperTarget(state, station.id, 37);
    state = setStationWarperAutoRefill(state, station.id, true);
    state = connectBelt(state, "vein_iron", hub.id, "iron_ore");
    state.belts[0].priority = 2;

    const roundTripped = migrateGame(JSON.parse(JSON.stringify(state)))!;
    expect(roundTripped.version).toBe(31);
    expect(roundTripped.entities.find((entity) => entity.id === station.id)).toMatchObject({
      stationWarperAutoRefill: true,
      stationWarperTarget: 37,
    });
    expect(roundTripped.belts[0].priority).toBe(2);

    const legacy = JSON.parse(JSON.stringify(state));
    legacy.version = 29;
    delete legacy.entities.find((entity: { id: string }) => entity.id === station.id).stationWarperAutoRefill;
    delete legacy.entities.find((entity: { id: string }) => entity.id === station.id).stationWarperTarget;
    const migrated = migrateGame(legacy)!;
    expect(migrated.version).toBe(31);
    expect(migrated.entities.find((entity) => entity.id === station.id)).toMatchObject({
      stationWarperAutoRefill: false,
      stationWarperTarget: 50,
    });
    expect(migrated.belts[0].priority).toBe(2);
  });

  it("migrates v30 sorter stock and v31 preferences without losing route ownership or planet viewports", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState())) as Record<string, any>;
    legacy.version = 30;
    legacy.construction.conveyor_belt_mk1 = 4;
    legacy.construction.conveyor_belt_mk2 = 5;
    legacy.construction.conveyor_belt_mk3 = 6;
    legacy.construction.sorter_mk1 = 2;
    legacy.construction.sorter_mk2 = 3;
    legacy.construction.sorter_mk3 = 7;
    delete legacy.settings.theme;
    delete legacy.settings.technologyLayout;
    delete legacy.planetViewports;
    delete legacy.constructionAutomation.jobs;

    const migrated = migrateGame(legacy)!;
    expect(migrated.version).toBe(31);
    expect(migrated.construction).toMatchObject({
      conveyor_belt_mk1: 6,
      conveyor_belt_mk2: 8,
      conveyor_belt_mk3: 13,
      sorter_mk1: 0,
      sorter_mk2: 0,
      sorter_mk3: 0,
    });
    expect(migrated.settings).toMatchObject({ theme: "dark", technologyLayout: "standard" });
    expect(migrated.planetViewports.home).toEqual({ x: 510, y: 250, zoom: 0.84 });
    expect(migrated.planetViewports.frost).toEqual({ x: 510, y: 250, zoom: 0.84 });
    expect(migrated.constructionAutomation.jobs).toEqual({});

    migrated.settings.theme = "light";
    migrated.settings.technologyLayout = "compact";
    migrated.planetViewports.home = { x: -123.45, y: 678.91, zoom: 1.234 };
    migrated.construction.planetary_logistics_station = 2;
    let v31 = placeBuilding(migrated, "planetary_logistics_station", { x: -200, y: 0 });
    v31 = placeBuilding(v31, "planetary_logistics_station", { x: 200, y: 0 });
    const stations = v31.entities.filter((entity) => entity.buildingId === "planetary_logistics_station");
    stations[1].stationRoutes = [{
      id: "route_v31_owner",
      slotIndex: 0,
      peerId: stations[0].id,
      itemId: "iron_ingot",
      scope: "local",
      cargo: 25,
      vehicleCount: 1,
      progress: 0.25,
      duration: 8,
      requiresWarp: false,
      vehicleStationId: stations[0].id,
    }];

    const roundTrip = migrateGame(JSON.parse(JSON.stringify(v31)))!;
    expect(roundTrip.settings).toMatchObject({ theme: "light", technologyLayout: "compact" });
    expect(roundTrip.planetViewports.home).toEqual({ x: -123.45, y: 678.91, zoom: 1.234 });
    expect(roundTrip.entities.find((entity) => entity.id === stations[1].id)?.stationRoutes?.[0]).toMatchObject({
      id: "route_v31_owner",
      vehicleStationId: stations[0].id,
      cargo: 25,
    });
  });

  it("migrates a real v24-shaped seeded galaxy without changing existing player state", () => {
    let source = createInitialState(987_654, false);
    source.research.completedTechIds.push("basic_logistics", "interstellar_logistics", "space_warp");
    source.construction.storage_mk1 = 2;
    source.construction.conveyor_belt_mk1 = 1;
    source.construction.interstellar_logistics_station = 2;
    source = placeBuilding(source, "storage_mk1", { x: 0, y: 0 });
    source = placeBuilding(source, "storage_mk1", { x: 320, y: 0 });
    const warehouses = source.entities.filter((entity) => entity.buildingId === "storage_mk1");
    source = setLogisticsItem(source, warehouses[0].id, "iron_ingot");
    source = setLogisticsItem(source, warehouses[1].id, "iron_ingot");
    source = connectBelt(source, warehouses[0].id, warehouses[1].id, "iron_ingot");
    source = createBlueprint(source, warehouses.map((entity) => entity.id), "v24 铁块仓储");
    source = placeBuilding(source, "interstellar_logistics_station", { x: 640, y: 0 });
    const routeSource = source.entities.find((entity) => entity.planetId === "home" && entity.buildingId === "interstellar_logistics_station")!;
    source = setLogisticsItem(source, routeSource.id, "processor");
    source.exploration.unlockedSystemIds.push("borealis");
    source.exploration.colonizedPlanetIds.push("frost");
    source = setActivePlanet(source, "frost");
    source = placeBuilding(source, "interstellar_logistics_station", { x: 0, y: 0 });
    const routeTarget = source.entities.find((entity) => entity.planetId === "frost" && entity.buildingId === "interstellar_logistics_station")!;
    source = setLogisticsItem(source, routeTarget.id, "processor");
    source = setStationSlotMode(source, routeTarget.id, 0, "remote", "demand");
    source.entities.find((entity) => entity.id === routeTarget.id)!.stationRoutes = [{
      id: "route_v24",
      slotIndex: 0,
      peerId: routeSource.id,
      itemId: "processor",
      scope: "remote",
      cargo: 50,
      vehicleCount: 1,
      progress: 0.5,
      duration: 12,
      requiresWarp: true,
    }];
    const legacy = JSON.parse(JSON.stringify(source));
    const oldPlanetIds = new Set(["home", "ashen", "giant", "frost", "boreal_giant", "magnetar"]);
    const oldSystemIds = new Set(["helios", "borealis", "neutron"]);
    legacy.version = 24;
    legacy.entities = legacy.entities.filter((entity: { planetId: string }) => oldPlanetIds.has(entity.planetId));
    const originalEntityIds = legacy.entities.map((entity: { id: string }) => entity.id);
    for (const key of ["planetTrays", "planetMetrics", "powerGridMetrics"]) {
      legacy[key] = Object.fromEntries(Object.entries(legacy[key]).filter(([planetId]) => oldPlanetIds.has(planetId)));
    }
    legacy.galaxy.profiles = Object.fromEntries(Object.entries(legacy.galaxy.profiles).filter(([planetId]) => oldPlanetIds.has(planetId)));
    legacy.galaxy.planetRoles = Object.fromEntries(Object.entries(legacy.galaxy.planetRoles).filter(([planetId]) => oldPlanetIds.has(planetId)));
    delete legacy.galaxy.systemProfiles;
    legacy.dysonPlans = Object.fromEntries(Object.entries(legacy.dysonPlans).filter(([systemId]) => oldSystemIds.has(systemId)));
    legacy.dysonEngineering.orbitsBySystem = Object.fromEntries(Object.entries(legacy.dysonEngineering.orbitsBySystem).filter(([systemId]) => oldSystemIds.has(systemId)));
    legacy.dysonEngineering.activeOrbitBySystem = Object.fromEntries(Object.entries(legacy.dysonEngineering.activeOrbitBySystem).filter(([systemId]) => oldSystemIds.has(systemId)));
    legacy.dysonEngineering.absorptionProgressBySystem = Object.fromEntries(Object.entries(legacy.dysonEngineering.absorptionProgressBySystem).filter(([systemId]) => oldSystemIds.has(systemId)));
    legacy.tray.iron_ingot = 321;
    legacy.galaxy.profiles.ashen.miningMultiplier = 0.77;
    legacy.dysonPlans.helios.structurePoints = 7;

    const migrated = migrateGame(legacy)!;

    expect(migrated.version).toBe(31);
    expect(migrated.galaxy.seed).toBe(987_654);
    expect(migrated.tray.iron_ingot).toBe(321);
    expect(migrated.galaxy.profiles.ashen.miningMultiplier).toBe(0.77);
    expect(migrated.dysonPlans.helios.structurePoints).toBe(7);
    expect(migrated.research.completedTechIds).toEqual(expect.arrayContaining(["basic_logistics", "interstellar_logistics", "space_warp"]));
    expect(migrated.belts).toEqual([expect.objectContaining({ source: warehouses[0].id, target: warehouses[1].id, itemId: "iron_ingot" })]);
    expect(migrated.blueprints).toEqual([expect.objectContaining({ name: "v24 铁块仓储" })]);
    expect(migrated.entities.find((entity) => entity.id === routeTarget.id)?.stationRoutes).toEqual([
      expect.objectContaining({ id: "route_v24", peerId: routeSource.id, cargo: 50, progress: 0.5, warpersPerVessel: 1 }),
    ]);
    expect(Object.keys(migrated.galaxy.profiles)).toHaveLength(22);
    expect(Object.keys(migrated.galaxy.systemProfiles)).toHaveLength(8);
    expect(originalEntityIds.every((id: string) => migrated.entities.some((entity) => entity.id === id))).toBe(true);
    expect(migrated.entities.filter((entity) => entity.kind === "vein").length).toBeGreaterThan(28);
  });

  it("migrates v25 factories to v31 without reissuing starter stock or losing local-planet access", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState())) as Record<string, any>;
    legacy.version = 25;
    delete legacy.constructionAutomation;
    legacy.tray = { iron_ore: 37, processor: 4 };
    legacy.planetTrays.home = { ...legacy.tray };
    legacy.settings.fontScale = 2;
    legacy.research.completedTechIds.push("interstellar_logistics");
    legacy.exploration.colonizedPlanetIds = ["home"];

    const migrated = migrateGame(legacy)!;
    expect(migrated.version).toBe(31);
    expect(migrated.tray).toEqual({ iron_ore: 37, processor: 4 });
    expect(migrated.settings.fontScale).toBe(2);
    expect(migrated.constructionAutomation).toEqual({
      enabled: true,
      targetStock: {},
      cursor: 0,
      totalCrafted: 0,
      lastCraftedId: null,
      jobs: {},
    });
    expect(migrated.exploration.colonizedPlanetIds).toEqual(expect.arrayContaining(["home", "ashen", "giant"]));
  });

  it("round-trips relay hubs, route budgets and in-flight waypoint data", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics", "space_warp");
    state.exploration.unlockedSystemIds.push("aurora", "sirius");
    state.exploration.colonizedPlanetIds.push("verdant", "crystal");
    state.construction.interstellar_logistics_station = 3;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const source = state.entities.find((entity) => entity.planetId === "home" && entity.buildingId === "interstellar_logistics_station")!;
    state = setActivePlanet(state, "verdant");
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const hub = state.entities.find((entity) => entity.planetId === "verdant" && entity.buildingId === "interstellar_logistics_station")!;
    state = setStationHubConfiguration(state, hub.id, true, 2);
    state = setActivePlanet(state, "crystal");
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const target = state.entities.find((entity) => entity.planetId === "crystal" && entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, target.id, "processor");
    state = setStationSlotRoutePolicy(state, target.id, 0, "relay-required");
    state = setStationSlotWarperBudget(state, target.id, 0, 3);
    state.entities.find((entity) => entity.id === target.id)!.stationRoutes = [{
      id: "route_persisted",
      slotIndex: 0,
      peerId: source.id,
      itemId: "processor",
      scope: "remote",
      cargo: 100,
      vehicleCount: 1,
      progress: 0.4,
      duration: 24,
      requiresWarp: true,
      waypointStationIds: [hub.id],
      distanceLy: 20.4,
      warpersPerVessel: 2,
    }];

    saveGame(state);
    const loaded = loadGame().state;
    expect(loaded.entities.find((entity) => entity.id === hub.id)).toMatchObject({ stationHubEnabled: true, stationHubPriority: 2 });
    expect(loaded.entities.find((entity) => entity.id === target.id)?.stationSlots?.[0]).toMatchObject({ routePolicy: "relay-required", warperBudget: 3 });
    expect(loaded.entities.find((entity) => entity.id === target.id)?.stationRoutes?.[0]).toMatchObject({
      id: "route_persisted",
      waypointStationIds: [hub.id],
      distanceLy: 20.4,
      warpersPerVessel: 2,
    });
  });

  it("round-trips planet industry roles and defaults them for legacy saves", () => {
    const state = createInitialState();
    state.galaxy.planetRoles.home = "manufacturing";
    state.galaxy.profiles.home.windMultiplier = 1.37;
    state.galaxy.profiles.home.reserveScale = 0.83;
    saveGame(state);
    const restored = loadGame().state.galaxy;
    expect(restored.planetRoles.home).toBe("manufacturing");
    expect(restored.profiles).toEqual(state.galaxy.profiles);

    const legacy = JSON.parse(JSON.stringify(state));
    legacy.version = 22;
    delete legacy.galaxy.planetRoles;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));
    expect(loadGame().state.galaxy.planetRoles).toMatchObject({ home: "auto", frost: "auto" });
  });

  it("migrates v23 spare logistics vehicles from every planet tray into the portable fleet", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState()));
    legacy.version = 23;
    delete legacy.portableFleet;
    legacy.tray.logistics_drone = 2;
    legacy.tray.logistics_vessel = 1;
    legacy.planetTrays.home = { ...legacy.tray };
    legacy.planetTrays.ashen.logistics_drone = 3;
    legacy.planetTrays.ashen.logistics_vessel = 4;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.portableFleet).toEqual({ logistics_drone: 5, logistics_vessel: 5 });
    expect(loaded.tray.logistics_drone).toBeUndefined();
    expect(loaded.tray.logistics_vessel).toBeUndefined();
    expect(loaded.planetTrays.ashen.logistics_drone).toBeUndefined();
    expect(loaded.planetTrays.ashen.logistics_vessel).toBeUndefined();
  });

  it("migrates v16 saves with persistent settings and achievement defaults", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState()));
    legacy.version = 16;
    delete legacy.settings;
    delete legacy.achievements;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.settings).toEqual({
      simulationSpeed: 1,
      fontScale: 1,
      theme: "dark",
      technologyLayout: "standard",
      performanceMode: false,
      reducedMotion: false,
      soundEnabled: false,
      allowDoubleClickZoom: false,
      beltHeatmapEnabled: false,
      autosaveIntervalSeconds: 30,
      resourceMode: "infinite",
      difficulty: "standard",
    });
    expect(loaded.achievements.unlockedIds).toEqual([]);
  });

  it("round-trips v17 settings and filters unknown achievement ids", () => {
    const state = createInitialState();
    state.settings = {
      simulationSpeed: 4,
      fontScale: 1.5,
      theme: "dark",
      technologyLayout: "standard",
      performanceMode: true,
      reducedMotion: true,
      soundEnabled: true,
      allowDoubleClickZoom: true,
      beltHeatmapEnabled: true,
      autosaveIntervalSeconds: 30,
      resourceMode: "infinite",
      difficulty: "standard",
    };
    state.achievements.unlockedIds = ["first_manual_mine", "dyson_swarm_online"];
    const serialized = JSON.parse(exportGame(state));
    serialized.state.achievements.unlockedIds.push("unknown_achievement");

    const imported = importGame(JSON.stringify(serialized));
    expect(imported?.settings).toEqual(state.settings);
    expect(imported?.achievements.unlockedIds).toEqual(["first_manual_mine", "dyson_swarm_online"]);
    expect(importGame("not-json")).toBeNull();
  });

  it("round-trips v22 Dyson launch controls and independent swarm orbits", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_swarm");
    state = addDysonSwarmOrbit(state, "helios");
    const orbitId = state.dysonEngineering.activeOrbitBySystem.helios!;
    state = setDysonSwarmOrbit(state, "helios", orbitId, { radius: 31_500, inclination: -27, longitude: 213 });
    state = setDysonLaunchMode(state, "swarm");
    state = setDysonLaunchThrottle(state, 0.75);
    state.dysonEngineering.launchEnergySpentMj = 321.6;
    saveGame(state);

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.dysonEngineering).toMatchObject({
      launchMode: "swarm",
      launchThrottle: 0.75,
      launchEnabled: true,
      launchEnergySpentMj: 321.6,
    });
    expect(loaded.dysonEngineering.orbitsBySystem.helios).toHaveLength(2);
    expect(loaded.dysonEngineering.orbitsBySystem.helios.find((orbit) => orbit.id === orbitId)).toMatchObject({
      radius: 31_500,
      inclination: -27,
      longitude: 213,
    });
  });

  it("migrates the aggregate v21 Dyson swarm into the first Helios orbit", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState()));
    legacy.version = 21;
    delete legacy.dysonEngineering;
    legacy.dysonSwarm = {
      sailsInOrbit: 12,
      totalLaunched: 18,
      totalExpired: 4,
      decayProgress: 0.25,
      generationKw: 432,
      receiverLoadKw: 0,
    };
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.dysonEngineering.orbitsBySystem.helios[0]).toMatchObject({
      sailsInOrbit: 12,
      totalLaunched: 18,
      totalExpired: 4,
      decayProgress: 0.25,
      generationKw: 432,
    });
    expect(loaded.dysonEngineering.activeOrbitBySystem.helios).toBe(loaded.dysonEngineering.orbitsBySystem.helios[0].id);
  });

  it("reports exact offline production deltas", () => {
    let state = createInitialState();
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = installMiner(state, "vein_iron", 1);
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now() - 5_000, state }));

    const loaded = loadGame();
    expect(loaded.offlineSeconds).toBeGreaterThanOrEqual(4);
    expect(loaded.offlineReport).not.toBeNull();
    expect(loaded.offlineReport?.produced).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "iron_ore", amount: expect.any(Number) }),
    ]));
    expect(loaded.offlineReport?.produced.find((item) => item.itemId === "iron_ore")?.amount).toBeGreaterThan(0);
  });

  it("grants a returning-player supply once after 72 offline hours", () => {
    const state = createInitialState();
    const savedAt = Date.now() - 80 * 60 * 60 * 1000;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt, state }));

    const first = loadGame();
    expect(first.offlineReport?.returningReward).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "iron_ore", amount: expect.any(Number) }),
      expect.objectContaining({ itemId: "copper_ore", amount: expect.any(Number) }),
    ]));
    expect(first.state.tray.iron_ore).toBeGreaterThanOrEqual(240);

    const second = loadGame();
    expect(second.offlineReport?.returningReward ?? []).toHaveLength(0);
  }, 15_000);

  it("does not overfill or mark a returning reward claimed when tray capacity is unavailable", () => {
    const state = createInitialState();
    state.planetTrayItemLimits.home = 1_000;
    state.tray.iron_ore = 900;
    const savedAt = Date.now() - 80 * 60 * 60 * 1000;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt, state }));

    const loaded = loadGame();
    expect(loaded.state.tray.iron_ore).toBe(900);
    expect(loaded.offlineReport?.returningReward ?? []).toHaveLength(0);
    expect(window.localStorage.getItem(`dsp-idle-network.returning-reward.${Math.floor(savedAt)}`)).toBeNull();
  }, 15_000);

  it("saves, loads, summarizes and clears three independent local slots", () => {
    const first = createInitialState();
    first.elapsedSeconds = 120;
    first.research.completedTechIds.push("electromagnetic_matrix");
    saveGameSlot(1, first);
    expect(exportGameSlot(1)).not.toBeNull();

    const second = createInitialState();
    second.elapsedSeconds = 360;
    second.dysonSphere.structurePoints = 4;
    saveGameSlot(2, second);

    expect(getSaveSlotSummaries()).toEqual([
      expect.objectContaining({ slotId: 1, elapsedSeconds: 120, completedTechCount: 1 }),
      expect.objectContaining({ slotId: 2, elapsedSeconds: 360, structurePoints: 4 }),
    ]);
    expect(loadGameSlot(1)?.state.elapsedSeconds).toBeGreaterThanOrEqual(120);
    clearGameSlot(1);
    expect(loadGameSlot(1)).toBeNull();
    expect(exportGameSlot(1)).toBeNull();
    expect(getSaveSlotSummaries().map((slot) => slot.slotId)).toEqual([2]);
  });

  it("migrates v15 research and Dyson plans into the v17 operations model", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_sphere_program", "dyson_shell", "mining_speed_1");
    state.dysonSphere.structurePoints = 16;
    state = createStandardDysonLayer(state, "helios");
    const legacy = JSON.parse(JSON.stringify(state));
    legacy.version = 15;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.research.completedTechIds).toEqual(expect.arrayContaining(["dyson_sphere_program", "dyson_shell", "mining_speed_1"]));
    expect(loaded.dysonPlans.helios.layers[0]).toMatchObject({
      name: "标准壳层 1",
      nodes: expect.arrayContaining([expect.objectContaining({ completedStructurePoints: 1 })]),
    });
    expect(loaded.dysonPlans.helios.structurePoints).toBe(16);
  });

  it("migrates v1 fractional inventories into the integer research model", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState()));
    legacy.version = 1;
    delete legacy.activePlanetId;
    delete legacy.planetMetrics;
    delete legacy.research;
    legacy.tray.iron_ore = 4.9;
    legacy.entities[0].outputs.iron_ore = 3.8;
    for (const entity of legacy.entities) {
      delete entity.progress;
      delete entity.planetId;
    }
    legacy.construction.matrix_lab = 0;
    legacy.construction.conveyor_belt_mk1 = 0;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.tray.iron_ore).toBe(4);
    expect(loaded.entities[0].outputs.iron_ore).toBe(3);
    expect(loaded.entities.every((entity) => entity.progress === 0)).toBe(true);
    expect(loaded.research.completedTechIds).toEqual([]);
    expect(loaded.research.queuedTechIds).toEqual([]);
    expect(loaded.construction.wind_turbine).toBe(3);
    expect(loaded.construction.mining_machine).toBe(2);
    expect(loaded.construction.arc_smelter).toBe(3);
    expect(loaded.construction.assembling_machine_mk1).toBe(3);
    expect(loaded.construction.matrix_lab).toBe(2);
    expect(loaded.construction.conveyor_belt_mk1).toBe(10);
    expect(loaded.entities.some((entity) => entity.resourceId === "coal")).toBe(true);
    expect(loaded.entities.some((entity) => entity.resourceId === "crude_oil")).toBe(true);
    expect(loaded.entities.some((entity) => entity.resourceId === "silicon_ore")).toBe(true);
    expect(loaded.entities.some((entity) => entity.resourceId === "titanium_ore")).toBe(true);
    expect(loaded.entities.some((entity) => entity.resourceId === "water")).toBe(true);
    expect(loaded.entities.some((entity) => entity.resourceId === "sulfuric_acid")).toBe(true);
    expect(loaded.entities.filter((entity) => entity.planetId === "home" && entity.kind === "vein")).toHaveLength(6);
    expect(loaded.entities.filter((entity) => entity.planetId === "ashen" && entity.kind === "vein")).toHaveLength(10);
    expect(loaded.entities.filter((entity) => entity.planetId === "frost" && entity.kind === "vein")).toHaveLength(7);
    expect(loaded.entities.filter((entity) => entity.planetId === "magnetar" && entity.kind === "vein")).toHaveLength(5);
  });

  it("migrates numeric research progress and tops up around deployed starter equipment", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState()));
    legacy.version = 2;
    legacy.research.progressByTech = { electromagnetic_matrix: 2 };
    delete legacy.construction.wind_turbine;
    delete legacy.construction.mining_machine;
    legacy.construction.arc_smelter = 0;
    legacy.construction.assembling_machine_mk1 = 0;
    legacy.construction.matrix_lab = 0;
    legacy.construction.conveyor_belt_mk1 = 0;
    legacy.entities.push({
      id: "legacy_wind",
      kind: "power",
      position: { x: 0, y: 0 },
      buildingId: "wind_turbine",
      machineCount: 2,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      utilization: 0,
      productionRate: 0,
    });
    legacy.entities.find((entity: { id: string }) => entity.id === "vein_iron").minerCount = 1;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.research.progressByTech.electromagnetic_matrix).toEqual({ electromagnetic_matrix: 2 });
    expect(loaded.construction.wind_turbine).toBe(1);
    expect(loaded.construction.mining_machine).toBe(1);
    expect(loaded.construction.arc_smelter).toBe(3);
    expect(loaded.construction.assembling_machine_mk1).toBe(3);
    expect(loaded.construction.matrix_lab).toBe(2);
    expect(loaded.construction.conveyor_belt_mk1).toBe(10);
    expect(loaded.entities.find((entity) => entity.id === "legacy_wind")?.routingCursor).toBe(0);
  });

  it("round-trips thermal fuel configuration and chamber energy", () => {
    let state = createInitialState();
    state.construction.thermal_power_plant = 1;
    state = placeBuilding(state, "thermal_power_plant", { x: 10, y: 20 });
    const plant = state.entities.find((entity) => entity.buildingId === "thermal_power_plant")!;
    state = setFuelItem(state, plant.id, "hydrogen");
    const configured = state.entities.find((entity) => entity.id === plant.id)!;
    configured.inputs.hydrogen = 4;
    configured.fuelRemainingMj = 3.25;
    saveGame(state);

    const loaded = loadGame().state.entities.find((entity) => entity.id === plant.id)!;
    expect(loaded.fuelItemId).toBe("hydrogen");
    expect(loaded.inputs.hydrogen).toBe(4);
    expect(loaded.fuelRemainingMj).toBe(3.25);
  });

  it("round-trips information matrices and purple research state", () => {
    const state = createInitialState();
    state.tray.information_matrix = 7;
    state.research.completedTechIds.push("information_matrix");
    state.research.selectedTechId = "research_speed_1";
    state.research.progressByTech.research_speed_1 = { information_matrix: 3 };
    saveGame(state);

    const loaded = loadGame().state;
    expect(loaded.tray.information_matrix).toBe(7);
    expect(loaded.research.completedTechIds).toContain("information_matrix");
    expect(loaded.research.selectedTechId).toBe("research_speed_1");
    expect(loaded.research.progressByTech.research_speed_1).toEqual({ information_matrix: 3 });
  });

  it("round-trips gravity matrices, collider construction and green research state", () => {
    const state = createInitialState();
    state.tray.gravity_matrix = 5;
    state.construction.miniature_particle_collider = 2;
    state.research.completedTechIds.push("gravity_matrix", "research_speed_1");
    state.research.selectedTechId = "research_speed_2";
    state.research.progressByTech.research_speed_2 = { gravity_matrix: 4 };
    saveGame(state);

    const loaded = loadGame().state;
    expect(loaded.tray.gravity_matrix).toBe(5);
    expect(loaded.construction.miniature_particle_collider).toBe(2);
    expect(loaded.research.completedTechIds).toContain("gravity_matrix");
    expect(loaded.research.selectedTechId).toBe("research_speed_2");
    expect(loaded.research.progressByTech.research_speed_2).toEqual({ gravity_matrix: 4 });
  });

  it("migrates v4 stations with a compatibility vessel and full minimum load", () => {
    let current = createInitialState();
    current.construction.interstellar_logistics_station = 1;
    current = placeBuilding(current, "interstellar_logistics_station", { x: 10, y: 20 });
    const legacy = JSON.parse(JSON.stringify(current));
    legacy.version = 4;
    const legacyStation = legacy.entities.find((entity: { kind: string }) => entity.kind === "station");
    delete legacyStation.stationVessels;
    delete legacyStation.stationMinimumLoad;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    const station = loaded.entities.find((entity) => entity.kind === "station")!;
    expect(loaded.version).toBe(31);
    expect(station.stationVessels).toBe(1);
    expect(station.stationMinimumLoad).toBe(1);
  });

  it("migrates the legacy remote zone into the ashen planet", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState()));
    legacy.version = 3;
    delete legacy.activePlanetId;
    delete legacy.planetMetrics;
    delete legacy.planetTrays;
    legacy.entities = legacy.entities.filter((entity: { id: string }) => !entity.id.startsWith("ashen_"));
    for (const entity of legacy.entities) {
      delete entity.planetId;
      if (["vein_silicon", "vein_titanium", "vein_water"].includes(entity.id)) entity.position.x = -790;
    }
    legacy.entities.push({
      id: "legacy_remote_smelter",
      kind: "machine",
      position: { x: -760, y: 40 },
      buildingId: "arc_smelter",
      recipeId: "titanium_ingot",
      machineCount: 1,
      minerCount: 0,
      inputs: { titanium_ore: 3 },
      outputs: {},
      progress: 0.5,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    });
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    const silicon = loaded.entities.find((entity) => entity.id === "vein_silicon")!;
    const water = loaded.entities.find((entity) => entity.id === "vein_water")!;
    const smelter = loaded.entities.find((entity) => entity.id === "legacy_remote_smelter")!;
    expect(silicon).toMatchObject({ planetId: "ashen", position: { x: -150 } });
    expect(water).toMatchObject({ planetId: "home", position: { x: -150 } });
    expect(smelter).toMatchObject({ planetId: "ashen", position: { x: -120 }, inputs: { titanium_ore: 3 }, progress: 0.5 });
  });

  it("migrates v5 saves with an empty Dyson swarm and new construction slots", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState()));
    legacy.version = 5;
    delete legacy.dysonSwarm;
    delete legacy.construction.em_rail_ejector;
    delete legacy.construction.ray_receiver;
    delete legacy.metrics.rayGenerationKw;
    delete legacy.planetMetrics.home.rayGenerationKw;
    delete legacy.planetMetrics.ashen.rayGenerationKw;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.dysonSwarm).toEqual({
      sailsInOrbit: 0,
      totalLaunched: 0,
      totalExpired: 0,
      decayProgress: 0,
      generationKw: 0,
      receiverLoadKw: 0,
    });
    expect(loaded.construction.em_rail_ejector).toBe(0);
    expect(loaded.construction.ray_receiver).toBe(0);
    expect(loaded.construction.vertical_launching_silo).toBe(0);
    expect(loaded.dysonSphere).toEqual({
      structurePoints: 0,
      totalRocketsLaunched: 0,
      shellSails: 0,
      totalSailsAbsorbed: 0,
      absorptionProgress: 0,
      generationKw: 0,
    });
    expect(loaded.metrics.rayGenerationKw).toBe(0);
  });

  it("migrates v6 Dyson swarm counters with an empty permanent sphere", () => {
    const saved = JSON.parse(JSON.stringify(createInitialState()));
    saved.version = 6;
    delete saved.dysonSphere;
    delete saved.construction.vertical_launching_silo;
    saved.dysonSwarm = {
      sailsInOrbit: 12.9,
      totalLaunched: 1,
      totalExpired: 2.8,
      decayProgress: 3.75,
      generationKw: 999999,
      receiverLoadKw: 999999,
    };
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: saved }));

    const loaded = loadGame().state;
    expect(loaded.dysonSwarm).toEqual({
      sailsInOrbit: 12,
      totalLaunched: 14,
      totalExpired: 2,
      decayProgress: 0.75,
      generationKw: 432,
      receiverLoadKw: 432,
    });
    expect(loaded.dysonSphere).toEqual({
      structurePoints: 0,
      totalRocketsLaunched: 0,
      shellSails: 0,
      totalSailsAbsorbed: 0,
      absorptionProgress: 0,
      generationKw: 0,
    });
  });

  it("sanitizes v8 Dyson sphere capacity and recomputes total receiver power", () => {
    const saved = JSON.parse(JSON.stringify(createInitialState()));
    saved.version = 8;
    saved.dysonSwarm = {
      sailsInOrbit: 12.9,
      totalLaunched: 1,
      totalExpired: 2.8,
      decayProgress: 3.75,
      generationKw: 999999,
      receiverLoadKw: 999999,
    };
    saved.dysonSphere = {
      structurePoints: 3.9,
      totalRocketsLaunched: 1,
      shellSails: 100,
      totalSailsAbsorbed: 2,
      absorptionProgress: 2.25,
      generationKw: 999999,
    };
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: saved }));

    const loaded = loadGame().state;
    expect(loaded.dysonSphere).toEqual({
      structurePoints: 3,
      totalRocketsLaunched: 3,
      shellSails: 60,
      totalSailsAbsorbed: 60,
      absorptionProgress: 0.25,
      generationKw: 5040,
    });
    expect(loaded.dysonSwarm).toEqual({
      sailsInOrbit: 12,
      totalLaunched: 74,
      totalExpired: 2,
      decayProgress: 0.75,
      generationKw: 432,
      receiverLoadKw: 5472,
    });
  });

  it("migrates v7 belts to Mk.I and initializes every upgrade construction slot", () => {
    let current = createInitialState();
    current = placeBuilding(current, "arc_smelter", { x: 100, y: 0 });
    const smelter = current.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    const legacy = JSON.parse(JSON.stringify(current));
    legacy.version = 7;
    delete legacy.construction.plane_smelter;
    delete legacy.construction.assembling_machine_mk2;
    delete legacy.construction.assembling_machine_mk3;
    delete legacy.construction.conveyor_belt_mk2;
    delete legacy.construction.conveyor_belt_mk3;
    legacy.belts = [{
      id: "legacy_belt",
      planetId: "home",
      source: "vein_iron",
      target: smelter.id,
      itemId: "iron_ore",
      lanes: 1,
      tier: 3,
      progress: 0.5,
      priority: 0,
      lastFlow: 2,
    }];
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.belts[0]).toMatchObject({ id: "legacy_belt", tier: 1, progress: 0.5 });
    expect(loaded.construction).toMatchObject({
      plane_smelter: 0,
      assembling_machine_mk2: 0,
      assembling_machine_mk3: 0,
      conveyor_belt_mk2: 0,
      conveyor_belt_mk3: 0,
    });
  });

  it("round-trips v8 high-tier equipment and belt levels without starter replenishment", () => {
    let state = createInitialState();
    state.construction.assembling_machine_mk2 = 1;
    state = placeBuilding(state, "assembling_machine_mk2", { x: 100, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk2")!;
    state.construction.conveyor_belt_mk1 = 2;
    state.belts.push({
      id: "belt_mk2",
      planetId: "home",
      source: "vein_iron",
      target: assembler.id,
      itemId: "iron_ore",
      lanes: 1,
      tier: 2,
      sorterTier: 1,
      progress: 0.25,
      priority: 0,
      lastFlow: 4,
    });
    saveGame(state);

    const loaded = loadGame().state;
    expect(loaded.entities.find((entity) => entity.id === assembler.id)?.buildingId).toBe("assembling_machine_mk2");
    expect(loaded.belts[0]).toMatchObject({ id: "belt_mk2", tier: 2, progress: 0.25 });
    expect(loaded.construction.conveyor_belt_mk1).toBe(2);
  });

  it("migrates v8 production nodes into a consistent empty proliferator state", () => {
    let current = createInitialState();
    current = placeBuilding(current, "assembling_machine_mk1", { x: 100, y: 0 });
    const legacy = JSON.parse(JSON.stringify(current));
    legacy.version = 8;
    delete legacy.construction.spray_coater;
    const assembler = legacy.entities.find((entity: { buildingId?: string }) => entity.buildingId === "assembling_machine_mk1");
    delete assembler.sprayCoaterInstalled;
    delete assembler.proliferatorTier;
    delete assembler.proliferatorMode;
    delete assembler.proliferatorPoints;
    delete assembler.proliferatorBonusProgress;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    const migrated = loaded.entities.find((entity) => entity.id === assembler.id)!;
    expect(loaded.version).toBe(31);
    expect(loaded.construction.spray_coater).toBe(0);
    expect(migrated).toMatchObject({ sprayCoaterInstalled: false, proliferatorPoints: 0, proliferatorBonusProgress: {} });
    expect(migrated.proliferatorTier).toBeUndefined();
    expect(migrated.proliferatorMode).toBeUndefined();
  });

  it("sanitizes malformed v9 proliferator module fields", () => {
    let current = createInitialState();
    current = placeBuilding(current, "assembling_machine_mk1", { x: 100, y: 0 });
    const saved = JSON.parse(JSON.stringify(current));
    const assembler = saved.entities.find((entity: { buildingId?: string }) => entity.buildingId === "assembling_machine_mk1");
    assembler.sprayCoaterInstalled = true;
    assembler.proliferatorTier = 99;
    assembler.proliferatorMode = "invalid";
    assembler.proliferatorPoints = 3.9;
    assembler.proliferatorBonusProgress = { gear: 2.75 };
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: saved }));

    const migrated = loadGame().state.entities.find((entity) => entity.id === assembler.id)!;
    expect(migrated).toMatchObject({
      sprayCoaterInstalled: true,
      proliferatorTier: 1,
      proliferatorMode: "normal",
      proliferatorPoints: 3,
      proliferatorBonusProgress: { gear: 0.75 },
    });
  });

  it("migrates v9 belts and planet records into the v10 logistics model", () => {
    let current = createInitialState();
    current = placeBuilding(current, "arc_smelter", { x: 100, y: 0 });
    const smelter = current.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    current.belts.push({
      id: "v9_belt",
      planetId: "home",
      source: "vein_iron",
      target: smelter.id,
      itemId: "iron_ore",
      lanes: 1,
      tier: 2,
      sorterTier: 1,
      progress: 0.25,
      priority: 0,
      lastFlow: 3,
    });
    const legacy = JSON.parse(JSON.stringify(current));
    legacy.version = 9;
    delete legacy.belts[0].sorterTier;
    delete legacy.planetTrays.giant;
    delete legacy.planetMetrics.giant;
    delete legacy.construction.planetary_logistics_station;
    delete legacy.construction.orbital_collector;
    delete legacy.construction.sorter_mk1;
    delete legacy.construction.sorter_mk2;
    delete legacy.construction.sorter_mk3;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.belts[0]).toMatchObject({ id: "v9_belt", tier: 2, sorterTier: 2, progress: 0.25 });
    expect(loaded.planetTrays.giant).toEqual({});
    expect(loaded.planetMetrics.giant.powerFactor).toBe(1);
    expect(loaded.construction).toMatchObject({
      planetary_logistics_station: 0,
      orbital_collector: 0,
      sorter_mk1: 0,
      sorter_mk2: 0,
      sorter_mk3: 0,
    });
  });

  it("round-trips planetary fleets, warpers and a gas-giant collector", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.planetary_logistics_station = 1;
    state.construction.interstellar_logistics_station = 1;
    state.construction.orbital_collector = 1;
    state = placeBuilding(state, "planetary_logistics_station", { x: 0, y: 0 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    state.entities.find((entity) => entity.buildingId === "planetary_logistics_station")!.stationDrones = 7;
    const interstellar = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    interstellar.stationVessels = 3;
    interstellar.stationWarpers = 4;
    interstellar.stationWarpEnabled = false;
    state = setActivePlanet(state, "giant");
    state = placeBuilding(state, "orbital_collector", { x: 0, y: 0 });
    state.tray.deuterium = 9;
    saveGame(state);

    const loaded = loadGame().state;
    expect(loaded.activePlanetId).toBe("giant");
    expect(loaded.tray.deuterium).toBe(9);
    expect(loaded.entities.find((entity) => entity.buildingId === "planetary_logistics_station")?.stationDrones).toBe(7);
    expect(loaded.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")).toMatchObject({
      stationVessels: 3,
      stationWarpers: 4,
      stationWarpEnabled: false,
    });
    expect(loaded.entities.find((entity) => entity.buildingId === "orbital_collector")).toMatchObject({
      planetId: "giant",
      storedItemId: "hydrogen",
      stationMode: "supply",
    });
  });

  it("migrates v10 power records into the current energy model", () => {
    let current = createInitialState();
    current.construction.thermal_power_plant = 1;
    current = placeBuilding(current, "thermal_power_plant", { x: 0, y: 0 });
    const legacy = JSON.parse(JSON.stringify(current));
    legacy.version = 10;
    for (const buildingId of ["solar_panel", "geothermal_power_station", "mini_fusion_power_plant", "artificial_star", "accumulator", "energy_exchanger"]) {
      delete legacy.construction[buildingId];
    }
    for (const metrics of Object.values(legacy.planetMetrics) as Array<Record<string, unknown>>) {
      for (const field of ["solarGenerationKw", "geothermalGenerationKw", "fusionGenerationKw", "artificialStarGenerationKw", "storageDischargeKw", "storageChargeKw", "storedEnergyMj", "storageCapacityMj"]) {
        delete metrics[field];
      }
    }
    delete legacy.entities.find((entity: { buildingId?: string }) => entity.buildingId === "thermal_power_plant").powerInputKw;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.construction).toMatchObject({
      solar_panel: 0,
      geothermal_power_station: 0,
      mini_fusion_power_plant: 0,
      artificial_star: 0,
      accumulator: 0,
      energy_exchanger: 0,
    });
    expect(loaded.planetMetrics.home).toMatchObject({
      solarGenerationKw: 0,
      geothermalGenerationKw: 0,
      fusionGenerationKw: 0,
      artificialStarGenerationKw: 0,
      storageDischargeKw: 0,
      storageChargeKw: 0,
      storedEnergyMj: 0,
      storageCapacityMj: 0,
    });
    expect(loaded.entities.find((entity) => entity.buildingId === "thermal_power_plant")?.powerInputKw).toBe(0);
  });

  it("round-trips stationary and transportable energy storage state", () => {
    let state = createInitialState();
    state.construction.accumulator = 1;
    state.construction.energy_exchanger = 1;
    state = placeBuilding(state, "accumulator", { x: 0, y: 0 });
    state = placeBuilding(state, "energy_exchanger", { x: 300, y: 0 });
    const accumulator = state.entities.find((entity) => entity.buildingId === "accumulator")!;
    accumulator.storedEnergyMj = 55.5;
    accumulator.powerInputKw = 450;
    const exchanger = state.entities.find((entity) => entity.buildingId === "energy_exchanger")!;
    exchanger.energyMode = "discharge";
    exchanger.recipeId = "accumulator_discharge";
    exchanger.storedEnergyMj = 30;
    exchanger.inputs.charged_accumulator = 2;
    exchanger.outputs.accumulator = 1;
    saveGame(state);

    const loaded = loadGame().state;
    expect(loaded.entities.find((entity) => entity.buildingId === "accumulator")).toMatchObject({
      storedEnergyMj: 55.5,
      energyMode: "auto",
      powerInputKw: 450,
    });
    expect(loaded.entities.find((entity) => entity.buildingId === "energy_exchanger")).toMatchObject({
      storedEnergyMj: 30,
      energyMode: "discharge",
      recipeId: "accumulator_discharge",
      inputs: { charged_accumulator: 2 },
      outputs: { accumulator: 1 },
    });
  });

  it("migrates v11 saves with every rare source and new production slot", () => {
    const current = createInitialState();
    const legacy = JSON.parse(JSON.stringify(current));
    legacy.version = 11;
    const rareItems = ["optical_grating_crystal", "kimberlite_ore", "fractal_silicon", "organic_crystal", "spiniform_stalagmite_crystal", "unipolar_magnet"];
    legacy.entities = legacy.entities.filter((entity: { resourceId?: string }) => !rareItems.includes(entity.resourceId ?? ""));
    delete legacy.construction.quantum_chemical_plant;
    delete legacy.construction.fractionator;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.entities.filter((entity) => entity.kind === "vein").map((entity) => entity.resourceId)).toEqual(expect.arrayContaining(rareItems));
    expect(loaded.construction).toMatchObject({ quantum_chemical_plant: 0, fractionator: 0 });
  });

  it("round-trips an orbital collector configured for fire ice", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.orbital_collector = 1;
    state = setActivePlanet(state, "giant");
    state = placeBuilding(state, "orbital_collector", { x: 0, y: 0 });
    const collector = state.entities.find((entity) => entity.buildingId === "orbital_collector")!;
    state = setLogisticsItem(state, collector.id, "fire_ice");
    state.entities.find((entity) => entity.id === collector.id)!.outputs.fire_ice = 25;
    saveGame(state);

    expect(loadGame().state.entities.find((entity) => entity.id === collector.id)).toMatchObject({
      storedItemId: "fire_ice",
      outputs: { fire_ice: 25 },
    });
  });

  it("round-trips v14 blueprints and initializes an empty library for v13 saves", () => {
    let state = createInitialState();
    state.construction.storage_mk1 = 1;
    state = placeBuilding(state, "storage_mk1", { x: 120, y: 80 });
    const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    state = setLogisticsItem(state, storage.id, "processor");
    state = createBlueprint(state, [storage.id], "处理器缓存");
    saveGame(state);

    let loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.blueprints).toEqual([
      expect.objectContaining({
        name: "处理器缓存",
        entities: [expect.objectContaining({ buildingId: "storage_mk1", storedItemId: "processor", offset: { x: 0, y: 0 } })],
        belts: [],
      }),
    ]);

    const legacy = JSON.parse(JSON.stringify(state));
    legacy.version = 13;
    delete legacy.blueprints;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));
    loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.blueprints).toEqual([]);
  });

  it("round-trips belt routing and defaults missing legacy routes to automatic avoidance", () => {
    let state = createInitialState();
    state.construction.storage_mk1 = 2;
    state = placeBuilding(state, "storage_mk1", { x: 120, y: 80 });
    state = placeBuilding(state, "storage_mk1", { x: 520, y: 80 });
    const [source, target] = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    state = setLogisticsItem(state, source.id, "iron_ingot");
    state = setLogisticsItem(state, target.id, "iron_ingot");
    state.entities.find((entity) => entity.id === source.id)!.outputs.iron_ingot = 20;
    state = connectBelt(state, source.id, target.id, "iron_ingot");
    state = setBeltRouteOffsetY(state, state.belts[0].id, -180);
    state = createBlueprint(state, [source.id, target.id], "上绕缓存链");
    state = addCanvasBookmark(state, "home", { x: 240, y: -120, zoom: 0.75 }, "缓存区");
    state.settings.beltHeatmapEnabled = true;
    saveGame(state);

    let loaded = loadGame().state;
    expect(loaded.belts[0]).toMatchObject({ routeMode: "manual", routeOffsetY: -180 });
    expect(loaded.blueprints[0].belts[0]).toMatchObject({ routeMode: "manual", routeOffsetY: -180 });
    expect(loaded.canvasBookmarks[0]).toMatchObject({ name: "缓存区", viewport: { x: 240, y: -120, zoom: 0.75 } });
    expect(loaded.settings.beltHeatmapEnabled).toBe(true);

    const legacy = JSON.parse(JSON.stringify(state));
    legacy.version = 22;
    delete legacy.belts[0].routeMode;
    delete legacy.belts[0].routeOffsetY;
    delete legacy.blueprints[0].belts[0].routeMode;
    delete legacy.blueprints[0].belts[0].routeOffsetY;
    delete legacy.canvasBookmarks;
    delete legacy.settings.beltHeatmapEnabled;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));
    loaded = loadGame().state;
    expect(loaded.belts[0].routeMode).toBe("auto");
    expect(loaded.blueprints[0].belts[0].routeMode).toBe("auto");
    expect(loaded.canvasBookmarks).toEqual([]);
    expect(loaded.settings.beltHeatmapEnabled).toBe(false);
  });

  it("round-trips a paused handcraft queue without losing its planet affinity", () => {
    let state = createInitialState();
    state.tray.iron_ingot = 3;
    state = queueHandcraftRecipe(state, "gear", 3);
    saveGame(state);
    const loaded = loadGame().state;
    expect(loaded.handcraftQueue).toEqual([
      expect.objectContaining({ recipeId: "gear", planetId: "home", batchesTotal: 3, batchesRemaining: 3, progress: 0 }),
    ]);
  });

  it("migrates the legacy v14 Dyson sphere totals into the Helios system plan", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState()));
    legacy.version = 14;
    legacy.dysonSphere = {
      structurePoints: 7,
      totalRocketsLaunched: 9,
      shellSails: 11,
      totalSailsAbsorbed: 13,
      absorptionProgress: 0.4,
      generationKw: 0,
    };
    delete legacy.dysonPlans;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.dysonPlans.helios).toMatchObject({
      systemId: "helios",
      activeLayerId: null,
      structurePoints: 7,
      shellSails: 11,
      layers: [],
    });
    expect(loaded.dysonPlans.borealis).toMatchObject({ structurePoints: 0, shellSails: 0, layers: [] });
    expect(loaded.dysonPlans.neutron).toMatchObject({ structurePoints: 0, shellSails: 0, layers: [] });
    expect(loaded.dysonSphere).toMatchObject({ structurePoints: 7, shellSails: 11, totalRocketsLaunched: 9, totalSailsAbsorbed: 13 });
  });

  it("round-trips independent v17 Dyson layers across multiple star systems", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_sphere_program", "dyson_shell");
    state.exploration.unlockedSystemIds.push("borealis");
    state = createStandardDysonLayer(state, "helios");
    state = createStandardDysonLayer(state, "borealis");
    state.dysonPlans.helios.structurePoints = 16;
    state.dysonPlans.helios.shellSails = 20;
    state.dysonPlans.helios.layers[0].nodes[0].completedStructurePoints = 1;
    state.dysonPlans.helios.layers[0].frames[0].completedStructurePoints = 1;
    state.dysonPlans.helios.layers[0].shells[0].absorbedSails = 20;
    state.dysonPlans.borealis.structurePoints = 9;
    state.dysonPlans.borealis.layers[0].inclination = 37;
    state.dysonPlans.borealis.layers[0].longitude = 124;
    state.dysonSphere.structurePoints = 25;
    state.dysonSphere.shellSails = 20;
    saveGame(state);

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.dysonPlans.helios.layers[0]).toMatchObject({
      name: "标准壳层 1",
      nodes: expect.arrayContaining([expect.objectContaining({ completedStructurePoints: 1 })]),
      frames: expect.arrayContaining([expect.objectContaining({ completedStructurePoints: 1 })]),
      shells: expect.arrayContaining([expect.objectContaining({ absorbedSails: 20 })]),
    });
    expect(loaded.dysonPlans.helios).toMatchObject({ structurePoints: 16, shellSails: 20 });
    expect(loaded.dysonPlans.borealis).toMatchObject({ structurePoints: 9, shellSails: 0 });
    expect(loaded.dysonPlans.borealis.layers[0]).toMatchObject({ inclination: 37, longitude: 124 });
    expect(loaded.dysonPlans.neutron.layers).toEqual([]);
  });

  it("migrates v12 rare nodes and exploration access into the multi-system save", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState()));
    legacy.version = 12;
    delete legacy.exploration;
    delete legacy.planetTrays.frost;
    delete legacy.planetTrays.boreal_giant;
    delete legacy.planetTrays.magnetar;
    delete legacy.planetMetrics.frost;
    delete legacy.planetMetrics.boreal_giant;
    delete legacy.planetMetrics.magnetar;
    const optical = legacy.entities.find((entity: { id: string }) => entity.id === "vein_optical_grating");
    const spiniform = legacy.entities.find((entity: { id: string }) => entity.id === "ashen_spiniform");
    const unipolar = legacy.entities.find((entity: { id: string }) => entity.id === "ashen_unipolar");
    optical.planetId = "home";
    optical.minerCount = 1;
    optical.outputs.optical_grating_crystal = 18;
    spiniform.planetId = "ashen";
    unipolar.planetId = "ashen";
    legacy.research.completedTechIds.push("rare_resource_utilization");
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.exploration.unlockedSystemIds).toEqual(["helios", "borealis", "neutron"]);
    expect(loaded.planetTrays).toMatchObject({ frost: {}, boreal_giant: {}, magnetar: {} });
    expect(loaded.entities.find((entity) => entity.id === "vein_optical_grating")).toMatchObject({
      planetId: "frost",
      minerCount: 1,
      outputs: { optical_grating_crystal: 18 },
    });
    expect(loaded.entities.find((entity) => entity.id === "ashen_spiniform")?.planetId).toBe("frost");
    expect(loaded.entities.find((entity) => entity.id === "ashen_unipolar")?.planetId).toBe("magnetar");
    expect(loaded.planetMetrics.magnetar.powerFactor).toBe(1);
  });

  it("migrates v18 single-slot stations and belts into the v19 logistics model", () => {
    let current = createInitialState();
    current.construction.planetary_logistics_station = 1;
    current = placeBuilding(current, "planetary_logistics_station", { x: 120, y: 80 });
    const station = current.entities.find((entity) => entity.buildingId === "planetary_logistics_station")!;
    current = setLogisticsItem(current, station.id, "processor");
    const legacy = JSON.parse(JSON.stringify(current));
    legacy.version = 18;
    const legacyStation = legacy.entities.find((entity: { id: string }) => entity.id === station.id);
    delete legacyStation.stationSlots;
    delete legacyStation.stationRoutes;
    legacyStation.stationMode = "demand";
    legacy.belts.push({ id: "v18_line", planetId: "home", source: "vein_iron", target: station.id, itemId: "processor", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1, lastFlow: 0 });
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));

    const loaded = loadGame().state;
    const migratedStation = loaded.entities.find((entity) => entity.id === station.id)!;
    expect(loaded.version).toBe(31);
    expect(migratedStation.stationSlots).toHaveLength(5);
    expect(migratedStation.stationSlots?.[0]).toMatchObject({ itemId: "processor", localMode: "demand", minimumLoad: 1 });
    expect(migratedStation.stationRoutes).toEqual([]);
    expect(loaded.belts[0]).toMatchObject({ stackSize: 1, monitorEnabled: false, totalTransferred: 0, congestion: 0 });
  });

  it("round-trips transformed blueprint queues and plans without persisting runtime history", () => {
    let state = createInitialState();
    state = placeBuilding(state, "assembling_machine_mk1", { x: 100, y: 100 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    state = createBlueprint(state, [assembler.id], "排队模板");
    const blueprintId = state.blueprints[0].id;
    state = setBlueprintTransform(state, blueprintId, 270, "horizontal");
    state.construction.assembling_machine_mk1 = 0;
    state = queueBlueprint(state, blueprintId, { x: 640, y: 320 });
    state = createProductionPlan(state, "magnetic_coil", 90, "home");
    state.productionHistory = [{
      elapsedSeconds: 20,
      productionPerMinute: { magnetic_coil: 30 },
      consumptionPerMinute: { copper_ingot: 15 },
      inventory: { magnetic_coil: 12 },
      generationKw: 1200,
      demandKw: 720,
    }];
    state.historyRecordedAt = 20;
    const result = saveGame(state);

    const loaded = loadGame().state;
    expect(result.success).toBe(true);
    expect(loaded.blueprints[0]).toMatchObject({ rotation: 270, mirror: "horizontal" });
    expect(loaded.constructionQueue[0]).toMatchObject({ blueprintId, position: { x: 640, y: 320 }, rotation: 270, mirror: "horizontal" });
    expect(loaded.productionPlans[0]).toMatchObject({ itemId: "magnetic_coil", targetPerMinute: 90, planetId: "home" });
    expect(loaded.productionHistory).toEqual([]);
    expect(state.productionHistory[0]).toMatchObject({ elapsedSeconds: 20, productionPerMinute: { magnetic_coil: 30 } });
    expect(JSON.parse(window.localStorage.getItem(SAVE_KEY)!).state.productionHistory).toEqual([]);
    expect(loaded.historyRecordedAt).toBe(20);
  });

  it("migrates legacy saves into the endgame protocol and round-trips its controls", () => {
    const legacy = JSON.parse(JSON.stringify(createInitialState()));
    legacy.version = 22;
    delete legacy.endgame;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: legacy }));
    let loaded = loadGame().state;
    expect(loaded.version).toBe(31);
    expect(loaded.endgame.activeInfiniteResearchId).toBeNull();
    expect(loaded.endgame.exportProjects.universe_archive.level).toBe(0);

    loaded.research.completedTechIds.push("universe_matrix");
    loaded.endgame.activeInfiniteResearchId = "continuum_simulation";
    loaded.endgame.infiniteResearch.continuum_simulation.level = 3;
    loaded.endgame.exportProjects.universe_archive.enabled = true;
    loaded.endgame.galacticCredits = 42_000;
    saveGame(loaded);
    const roundTrip = loadGame().state;
    expect(roundTrip.endgame).toMatchObject({
      activeInfiniteResearchId: "continuum_simulation",
      galacticCredits: 42_000,
    });
    expect(getOfflineSimulationLimitSeconds(roundTrip)).toBe(10 * 24 * 60 * 60);
  });

  it("detects tampering and keeps a valid automatic snapshot for recovery", () => {
    const state = createInitialState();
    state.elapsedSeconds = 44;
    saveGame(state);
    const raw = JSON.parse(window.localStorage.getItem(SAVE_KEY)!);
    raw.state.elapsedSeconds = 999;
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(raw));
    const inspection = inspectSave(JSON.stringify(raw));
    expect(inspection.valid).toBe(false);
    expect(inspection.issues[0]).toContain("完整性校验失败");
    const loaded = loadGame();
    expect(loaded.recovery?.source).toBe("snapshot");
    expect(loaded.state.elapsedSeconds).toBe(44);
  });

  it("keeps manual snapshots while trimming automatic snapshots to two", () => {
    const states = Array.from({ length: 4 }, (_, index) => {
      const state = createInitialState();
      state.elapsedSeconds = (index + 1) * 300;
      return state;
    });
    states.forEach((state) => saveGameSnapshot(state, "自动快照"));
    states.forEach((state) => saveGameSnapshot(state, "测试快照"));
    const summaries = getSaveSnapshotSummaries();
    expect(summaries.filter((snapshot) => snapshot.reason === "自动快照")).toHaveLength(2);
    expect(summaries.filter((snapshot) => snapshot.reason === "测试快照")).toHaveLength(4);
    expect(summaries[0].reason).toBe("测试快照");
    expect(loadSaveSnapshot(summaries[0].id)?.elapsedSeconds).toBe(1_200);
  });

  it("cleans only automatic snapshots and retries the primary write once after a quota error", () => {
    const state = createInitialState();
    const automaticEnvelope = JSON.parse(exportGame(state));
    automaticEnvelope.kind = "snapshot";
    automaticEnvelope.reason = "自动快照";
    for (let index = 1; index <= 5; index += 1) {
      automaticEnvelope.savedAt = index;
      window.localStorage.setItem(`${SAVE_KEY}.snapshot.${index}-1`, JSON.stringify(automaticEnvelope));
    }
    saveGameSnapshot(state, "玩家手动快照");
    saveGameSlot(1, state);

    const nativeSetItem = Storage.prototype.setItem;
    let primaryAttempts = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === SAVE_KEY) {
        primaryAttempts += 1;
        if (primaryAttempts === 1) throw new DOMException("quota", "QuotaExceededError");
      }
      nativeSetItem.call(this, key, value);
    });

    const result = saveGame(state);
    const snapshots = getSaveSnapshotSummaries();
    expect(result).toMatchObject({ success: true, removedAutomaticSnapshots: 5 });
    expect(primaryAttempts).toBe(2);
    expect(snapshots.some((snapshot) => snapshot.reason === "玩家手动快照")).toBe(true);
    expect(getSaveSlotSummaries().map((slot) => slot.slotId)).toContain(1);
    expect(inspectSave(window.localStorage.getItem(SAVE_KEY)!).valid).toBe(true);
  });

  it("keeps only the newest legacy history-heavy automatic snapshot on the first save", () => {
    const state = createInitialState();
    state.elapsedSeconds = 3;
    const historySample = {
      elapsedSeconds: 1,
      productionPerMinute: { iron_ingot: 60 },
      consumptionPerMinute: { iron_ore: 60 },
      inventory: { iron_ingot: 100 },
      generationKw: 300,
      demandKw: 180,
    };
    for (let index = 1; index <= 3; index += 1) {
      const legacy = JSON.parse(JSON.stringify(state));
      legacy.elapsedSeconds = index;
      legacy.productionHistory = [historySample];
      window.localStorage.setItem(`${SAVE_KEY}.snapshot.${index}-1`, JSON.stringify({
        kind: "snapshot",
        savedAt: index,
        state: legacy,
      }));
    }
    saveGameSnapshot(state, "玩家手动快照");

    const result = saveGame(state);
    const snapshots = getSaveSnapshotSummaries();
    expect(result).toMatchObject({ success: true, removedAutomaticSnapshots: 2 });
    expect(snapshots.filter((snapshot) => snapshot.reason === "自动快照")).toHaveLength(1);
    expect(snapshots.find((snapshot) => snapshot.reason === "自动快照")?.savedAt).toBe(3);
    expect(snapshots.some((snapshot) => snapshot.reason === "玩家手动快照")).toBe(true);
  });

  it("rescues a first save with five large snapshots under a five MiB quota", () => {
    const state = createInitialState();
    state.elapsedSeconds = 1_500;
    const padding = "x".repeat(650 * 1024);
    for (let index = 1; index <= 5; index += 1) {
      const legacy = JSON.parse(JSON.stringify(state));
      legacy.productionHistory = [{
        elapsedSeconds: index * 300,
        productionPerMinute: {},
        consumptionPerMinute: {},
        inventory: {},
        generationKw: 0,
        demandKw: 0,
        padding,
      }];
      window.localStorage.setItem(`${SAVE_KEY}.snapshot.${index}-1`, JSON.stringify({
        kind: "snapshot",
        savedAt: index,
        state: legacy,
      }));
    }
    window.localStorage.setItem(`${SAVE_KEY}.snapshot.manual-1`, JSON.stringify({
      kind: "snapshot",
      reason: "玩家手动快照",
      savedAt: 10,
      state,
    }));
    saveGameSlot(1, state);
    const storageBytes = () => Object.keys(window.localStorage).reduce((total, key) =>
      total + key.length + (window.localStorage.getItem(key)?.length ?? 0), 0);
    const beforeBytes = storageBytes();
    const quotaBytes = 5 * 1024 * 1024;
    expect(beforeBytes).toBeLessThan(quotaBytes);

    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      const existingBytes = (this.getItem(key)?.length ?? 0) + key.length;
      const nextBytes = storageBytes() - existingBytes + key.length + value.length;
      if (nextBytes > quotaBytes) throw new DOMException("quota", "QuotaExceededError");
      nativeSetItem.call(this, key, value);
    });

    const result = saveGame(state);
    const snapshots = getSaveSnapshotSummaries();
    expect(result).toMatchObject({ success: true, removedAutomaticSnapshots: 4 });
    expect(storageBytes()).toBeLessThan(beforeBytes);
    expect(snapshots.filter((snapshot) => snapshot.reason === "自动快照")).toHaveLength(1);
    expect(snapshots.some((snapshot) => snapshot.reason === "玩家手动快照")).toBe(true);
    expect(getSaveSlotSummaries().map((slot) => slot.slotId)).toContain(1);
  });

  it("returns a verification failure instead of reporting a false save success", () => {
    const state = createInitialState();
    const nativeGetItem = Storage.prototype.getItem;
    let primaryReads = 0;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (key === SAVE_KEY) {
        primaryReads += 1;
        if (primaryReads === 2) return null;
      }
      return nativeGetItem.call(this, key);
    });

    expect(saveGame(state)).toMatchObject({
      success: false,
      code: "verification",
    });
  });

  it("keeps local save storage bounded across one thousand saves", () => {
    const state = createInitialState();
    let allSaved = true;
    for (let index = 0; index < 1_000; index += 1) {
      state.elapsedSeconds = index;
      allSaved = saveGame(state).success && allSaved;
    }
    const saveKeys = Object.keys(window.localStorage).filter((key) => key.startsWith(SAVE_KEY));
    expect(allSaved).toBe(true);
    expect(saveKeys.length).toBeLessThanOrEqual(5);
    expect(getSaveSnapshotSummaries().filter((snapshot) => snapshot.reason === "自动快照")).toHaveLength(2);
  }, 20_000);
});
