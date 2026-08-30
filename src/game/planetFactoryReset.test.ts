import { describe, expect, it } from "vitest";
import {
  createInitialState,
  getPlanetFactoryResetPreview,
  installMiner,
  placeBuilding,
  resetPlanetFactory,
  setActivePlanet,
} from "./engine";
import { migrateGame } from "./storage";

describe("planet factory reset", () => {
  it("destroys only the selected factory while preserving depletion and global progression", () => {
    let state = createInitialState();
    state.exploration.colonizedPlanetIds.push("ashen");
    state.construction.interstellar_logistics_station = 2;
    state.construction.time_warp_device = 1;
    state.construction.construction_center = 1;
    state.construction.mining_machine = 1;

    state = placeBuilding(state, "interstellar_logistics_station", { x: 100, y: 100 });
    state = placeBuilding(state, "time_warp_device", { x: 220, y: 100 });
    state = placeBuilding(state, "construction_center", { x: 340, y: 100 });
    state = installMiner(state, "vein_iron");
    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "interstellar_logistics_station", { x: 100, y: 100 });

    const homeStation = state.entities.find((entity) => entity.planetId === "home" && entity.buildingId === "interstellar_logistics_station")!;
    const remoteStation = state.entities.find((entity) => entity.planetId === "ashen" && entity.buildingId === "interstellar_logistics_station")!;
    const constructionCenter = state.entities.find((entity) => entity.planetId === "home" && entity.buildingId === "construction_center")!;
    const homeIron = state.entities.find((entity) => entity.id === "vein_iron")!;
    homeIron.resourceRemaining = Math.max(0, (homeIron.resourceRemaining ?? 1_000) - 321);
    homeIron.resourceDepletionRemainder = 7;
    homeIron.inputs.coal = 4;
    homeIron.outputs.iron_ore = 12;
    homeIron.progress = 0.75;
    homeIron.utilization = 0.8;
    homeIron.productionRate = 22;
    homeIron.interactionLocked = true;
    const reserveBefore = {
      remaining: homeIron.resourceRemaining,
      capacity: homeIron.resourceCapacity,
      remainder: homeIron.resourceDepletionRemainder,
    };

    homeStation.stationRoutes = [{
      id: "route-home-remote",
      slotIndex: 0,
      peerId: remoteStation.id,
      itemId: "iron_ore",
      scope: "remote",
      cargo: 25,
      vehicleCount: 1,
      progress: 0.4,
      duration: 10,
      requiresWarp: true,
      warpersPerVessel: 1,
      vehicleStationId: remoteStation.id,
      waypointStationIds: [],
    }];
    homeStation.stationProgress = 0.4;
    remoteStation.stationWarpers = 3;
    remoteStation.stationPeerId = homeStation.id;
    remoteStation.stationLastSupplyPeerBySlot = { "0:remote": homeStation.id, "1:remote": remoteStation.id };
    remoteStation.quantumTransition = {
      targetMode: "quantum",
      startedAtSecond: 10,
      boundarySecond: 20,
      bridges: [{
        id: "bridge-home-remote",
        itemId: "iron_ore",
        sourceStationId: homeStation.id,
        targetStationId: remoteStation.id,
        cargo: "9",
        remainingCargo: "9",
        arriveAtSecond: 20,
      }],
    };

    state.belts.push({
      id: "belt-home",
      planetId: "home",
      source: homeIron.id,
      target: homeStation.id,
      itemId: "iron_ore",
      lanes: 1,
      tier: 1,
      sorterTier: 1,
      progress: 0.2,
      priority: 1,
      lastFlow: 8,
    }, {
      id: "belt-remote",
      planetId: "ashen",
      source: remoteStation.id,
      target: remoteStation.id,
      itemId: "iron_ore",
      lanes: 1,
      tier: 1,
      sorterTier: 1,
      progress: 0,
      priority: 1,
      lastFlow: 0,
    });
    state.planetTrays.home = { iron_ore: 100, universe_matrix: 42 };
    state.tray = { iron_ore: 77 };
    state.planetTrays.ashen = { ...state.tray };
    state.cargo = { itemId: "iron_ore", amount: 5, origin: { kind: "node-output", id: homeStation.id } };
    state.constructionAutomation.jobs[constructionCenter.id] = {
      constructionId: "wind_turbine",
      steps: [{ kind: "building", constructionId: "wind_turbine" }],
      stepIndex: 0,
      elapsedSeconds: 0.5,
      inventory: { iron_ingot: 4 },
    };
    state.constructionAutomation.quantumMaterialBuffer = { [constructionCenter.id]: { copper_ingot: 6 } };
    state.blueprintVersions = [{
      id: "home-version",
      blueprintId: "home-blueprint",
      revision: 1,
      definition: { id: "home-blueprint", name: "home", revision: 1, entities: [], belts: [] },
    }, {
      id: "remote-version",
      blueprintId: "remote-blueprint",
      revision: 1,
      definition: { id: "remote-blueprint", name: "remote", revision: 1, entities: [], belts: [] },
    }];
    state.constructionQueue = [{
      id: "queue-home",
      blueprintId: "home-blueprint",
      blueprintVersionId: "home-version",
      blueprintRevision: 1,
      blueprintName: "home",
      planetId: "home",
      position: { x: 0, y: 0 },
      rotation: 0,
      mirror: "none",
      queuedAt: 1,
      reservedConstruction: { wind_turbine: 1 },
      reservedFleet: {},
      placedEntityIdsByKey: { station: homeStation.id },
    }, {
      id: "queue-remote",
      blueprintId: "remote-blueprint",
      blueprintVersionId: "remote-version",
      blueprintRevision: 1,
      blueprintName: "remote",
      planetId: "ashen",
      position: { x: 0, y: 0 },
      rotation: 0,
      mirror: "none",
      queuedAt: 2,
      reservedConstruction: {},
      reservedFleet: {},
      placedEntityIdsByKey: {},
    }];
    state.handcraftQueue = [{ id: "craft-home", recipeId: "iron_ingot", planetId: "home", batchesTotal: 2, batchesRemaining: 1, progress: 0.5, queuedAt: 1 }];
    state.productionPlans = [{ id: "plan-home", name: "home", itemId: "iron_ingot", targetPerMinute: 60, planetId: "home", recipeSelections: {}, createdAt: 1 }, { id: "plan-all", name: "all", itemId: "copper_ingot", targetPerMinute: 60, planetId: "all", recipeSelections: {}, createdAt: 2 }];
    state.productionHistory = [{
      elapsedSeconds: 10,
      productionPerMinute: { iron_ore: 60 },
      consumptionPerMinute: {},
      planetProductionPerMinute: { home: { iron_ore: 60 } },
      planetConsumptionPerMinute: { home: {} },
      inventory: { iron_ore: 100 },
      generationKw: 10,
      demandKw: 5,
    }];
    state.historyRecordedAt = 10;
    state.elapsedSeconds = 30;
    state.canvasBookmarks = [{ id: "bookmark-home", name: "home", planetId: "home", viewport: { x: 1, y: 2, zoom: 1 }, createdAtSeconds: 1 }, { id: "bookmark-remote", name: "remote", planetId: "ashen", viewport: { x: 3, y: 4, zoom: 1 }, createdAtSeconds: 2 }];
    state.canvasRegions = [{ id: "region-home", name: "home", planetId: "home", x: 0, y: 0, width: 100, height: 100, fillColor: "#000", borderColor: "#fff" }];
    state.planetViewports.home = { x: 99, y: 101, zoom: 1.2 };
    state.planetMetrics.home.demandKw = 999;
    state.powerGridMetrics.home["grid-a"].connectedEntities = 4;
    state.timeWarp.enabled = true;
    state.timeWarp.pendingSimulationSeconds = 120;
    state.timeWarp.pendingWallSeconds = 8;
    state.timeWarp.requiredPowerKw = 1_000;
    state.timeWarp.allocatedPowerKw = 1_000;
    state.research.completedTechIds.push("electromagnetism");
    state.dysonSphere.structurePoints = 123;
    state.quantumLogisticsNetwork.inventory.iron_ore = "456";
    state.galaxy.planetMetadata.home = { customName: "母星工厂", note: "保留", tags: ["主基地"] };
    state.totalProduced.iron_ore = 987_654;

    const constructionBefore = structuredClone(state.construction);
    const portableFleetBefore = structuredClone(state.portableFleet);
    const researchBefore = structuredClone(state.research);
    const dysonBefore = structuredClone(state.dysonSphere);
    const quantumBefore = structuredClone(state.quantumLogisticsNetwork);
    const metadataBefore = structuredClone(state.galaxy.planetMetadata.home);
    const originalEntityCount = state.entities.length;
    const preview = getPlanetFactoryResetPreview(state, "home");
    expect(preview).toMatchObject({ allowed: true, hasFactoryData: true, entityRecords: 3, buildingUnits: 3, extractorUnits: 1, beltConnections: 1, stationRoutes: 1 });

    const reset = resetPlanetFactory(state, "home");

    expect(reset).not.toBe(state);
    expect(state.entities).toHaveLength(originalEntityCount);
    expect(homeStation.stationRoutes).toHaveLength(1);
    expect(reset.entities.filter((entity) => entity.planetId === "home").every((entity) => entity.kind === "vein")).toBe(true);
    const resetIron = reset.entities.find((entity) => entity.id === "vein_iron")!;
    expect({
      remaining: resetIron.resourceRemaining,
      capacity: resetIron.resourceCapacity,
      remainder: resetIron.resourceDepletionRemainder,
    }).toEqual(reserveBefore);
    expect(resetIron).toMatchObject({ interactionLocked: false, minerCount: 0, machineCount: 0, inputs: {}, outputs: { iron_ore: 0 }, progress: 0, utilization: 0, productionRate: 0 });
    expect(resetIron.extractorBuildingId).toBeUndefined();
    expect(reset.belts.map((belt) => belt.id)).toEqual(["belt-remote"]);
    expect(reset.planetTrays.home).toEqual({});
    expect(reset.tray).toEqual({ iron_ore: 77 });
    const resetRemoteStation = reset.entities.find((entity) => entity.id === remoteStation.id)!;
    expect(resetRemoteStation.stationWarpers).toBe(4);
    expect(resetRemoteStation.stationPeerId).toBeUndefined();
    expect(resetRemoteStation.stationLastSupplyPeerBySlot).toEqual({ "1:remote": remoteStation.id });
    expect(resetRemoteStation.quantumTransition?.bridges).toEqual([]);
    expect(reset.cargo).toEqual({ itemId: "iron_ore", amount: 5, origin: undefined });
    expect(reset.constructionAutomation.jobs).toEqual({});
    expect(reset.constructionAutomation.quantumMaterialBuffer).toEqual({});
    expect(reset.constructionQueue.map((entry) => entry.id)).toEqual(["queue-remote"]);
    expect(reset.blueprintVersions.map((version) => version.id)).toEqual(["remote-version"]);
    expect(reset.handcraftQueue).toEqual([]);
    expect(reset.productionPlans.map((plan) => plan.id)).toEqual(["plan-all"]);
    expect(reset.productionHistory).toEqual([]);
    expect(reset.historyRecordedAt).toBe(30);
    expect(reset.canvasBookmarks.map((bookmark) => bookmark.id)).toEqual(["bookmark-remote"]);
    expect(reset.canvasRegions).toEqual([]);
    expect(reset.planetViewports.home).toEqual({ x: 510, y: 250, zoom: 0.84 });
    expect(reset.planetMetrics.home).toMatchObject({ demandKw: 0, generationKw: 0, powerFactor: 1 });
    expect(reset.powerGridMetrics.home["grid-a"]).toMatchObject({ connectedEntities: 0, disconnectedEntities: 0, generatorCount: 0, powerFactor: 1 });
    expect(reset.timeWarp).toMatchObject({ controllerEntityId: null, enabled: false, pendingSimulationSeconds: 0, pendingWallSeconds: 0, requiredPowerKw: 0, allocatedPowerKw: 0 });
    expect(reset.construction).toEqual(constructionBefore);
    expect(reset.portableFleet).toEqual(portableFleetBefore);
    expect(reset.research).toEqual(researchBefore);
    expect(reset.dysonSphere).toEqual(dysonBefore);
    expect(reset.quantumLogisticsNetwork).toEqual(quantumBefore);
    expect(reset.galaxy.planetMetadata.home).toEqual(metadataBefore);
    expect(reset.totalProduced.iron_ore).toBe(987_654);
    expect(migrateGame(JSON.parse(JSON.stringify(reset)))).not.toBeNull();
  });

  it("refuses unknown, uncolonized, and already-empty planets", () => {
    const initial = createInitialState();
    expect(getPlanetFactoryResetPreview(initial, "ashen")).toMatchObject({ allowed: false, hasFactoryData: false });
    expect(resetPlanetFactory(initial, "ashen")).toBe(initial);

    const colonized = structuredClone(initial);
    colonized.exploration.colonizedPlanetIds.push("ashen");
    expect(getPlanetFactoryResetPreview(colonized, "ashen")).toMatchObject({ allowed: true, hasFactoryData: false });
    expect(resetPlanetFactory(colonized, "ashen")).toBe(colonized);
  });
});
