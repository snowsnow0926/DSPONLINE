import { describe, expect, it } from "vitest";
import {
  addUnitToEntityGroup,
  DYSON_SHELL_CAPACITY_PER_STRUCTURE,
  DYSON_SHELL_SAIL_POWER_KW,
  DYSON_STRUCTURE_POWER_KW,
  DYSON_ROCKET_LAUNCH_ENERGY_MJ,
  DYSON_SAIL_LAUNCH_ENERGY_MJ,
  RAY_RECEIVER_CAPACITY_KW,
  SOLAR_SAIL_POWER_KW,
  adjustStationDrones,
  adjustStationWarpers,
  adjustStationVessels,
  addCanvasBookmark,
  addCanvasRegion,
  addDysonSwarmOrbit,
  advanceSimulation,
  advanceSimulationBudget,
  advanceSimulationSession,
  applyBeltConfigurationToBelts,
  applyBeltConfigurationToNetwork,
  canExploreStarSystem,
  canColonizePlanet,
  canPlaceBlueprint,
  canQueueBlueprint,
  cancelConstructionQueueEntry,
  cancelCurrentResearch,
  canInstallSprayCoater,
  canUpgradeBelt,
  canUpgradeEntity,
  canUpgradeSorter,
  canConnectBelt,
  canHandcraftRecipe,
  canQueueTechnology,
  canSelectTechnology,
  connectBelt,
  connectBeltWithResult,
  craftConstruction,
  craftConstructionWithUpstream,
  createBlueprint,
  createDysonLayerTemplate,
  createInitialState,
  createSimulationAdvanceSession,
  createPersistentSimulationRuntime,
  advancePersistentSimulationRuntime,
  createStandardDysonLayer,
  dispatchGalacticExport,
  discardConstructionInventory,
  dropCargoToEntity,
  dropCargoToTray,
  exploreStarSystem,
  fillStationFleet,
  fundAllConstructionQueueEntries,
  fundConstructionQueueEntry,
  colonizePlanet,
  getEntityOperatingStatus,
  getEntityRemovalPreview,
  getEntityPowerFactor,
  getAcceptedInputs,
  getBeltCapacity,
  getBeltConnectionCheck,
  getBeltNetworkIds,
  getBlueprintRequirements,
  getBlueprintFleetLoadPreview,
  getConstructionQueueDeficits,
  getConstructionQueueDetails,
  getConstructionCraftNavigation,
  getConstructionAutomationMaterialSeconds,
  getConstructionAutomationStatus,
  getConstructionCenterTraceSample,
  getConstructionQuickCraftPlan,
  getColonizationRequirements,
  getDysonPlanTotals,
  getDysonEngineeringSnapshot,
  getEjectorOrbitTargetStatus,
  getDysonShellCapacity,
  getEntityExtraProductBonus,
  getEntityInputCapacity,
  getEntityItemInputCapacity,
  getEntityOutputCapacity,
  getEntityProliferatorPowerMultiplier,
  getEntityProliferatorSpeedMultiplier,
  getDysonSailAbsorptionMultiplier,
  getGalacticIndustrySnapshot,
  getInterstellarCargoCapacity,
  getInterstellarRouteEconomics,
  getInterstellarTripSeconds,
  hasExactEntityPositionOverlap,
  getLogisticsSpeedMultiplier,
  getMaterialDeliveryItems,
  getMaterialDeliverySlots,
  getMaterialDeliverySlotChangeCheck,
  getMaxConstructionQuickCraftBatches,
  getMaxHandcraftBatches,
  getMiningSpeedMultiplier,
  getVeinConsumptionMultiplier,
  getPlanetaryCargoCapacity,
  getPlanetaryTripSeconds,
  getPlanetTrayItemLimit,
  getRayReceiverCapacityKw,
  getRecursiveHandcraftPlan,
  getRecipeSpeedMultiplier,
  getResourceReserveSnapshot,
  getSprayCoaterInstallCheck,
  getSprayCoaterRemovalRefund,
  getSolarSailLifetimeSeconds,
  getSorterCapacity,
  getStationDroneCapacity,
  getStationFleetDiagnostic,
  getStationBusyVehicleCount,
  getStationSlotCapacity,
  getStationSlots,
  getBuildingStackAdditionCheck,
  getStationWarperRefillSnapshot,
  getTechnologyConstructionRewards,
  handcraftRecipe,
  handcraftRecipeWithUpstream,
  isHandcraftableRecipe,
  isRecursiveManufacturingRecipe,
  installSprayCoater,
  installSprayCoaters,
  installMiner,
  manualMine,
  moveEntityInputToEntity,
  moveEntityInputToTray,
  moveEntityOutputToTray,
  moveTrayItemToEntity,
  moveEntities,
  pickFromEntity,
  pickFromEntityInput,
  placeBuilding,
  placeBlueprint,
  pauseCurrentResearch,
  pasteDysonLayerTemplate,
  processConstructionQueue,
  queueBlueprint,
  queueHandcraftRecipe,
  cancelHandcraftQueueEntry,
  removeEntity,
  removeEntities,
  removeBelt,
  removeBlueprint,
  removeSprayCoater,
  removeBeltNetwork,
  removeCanvasBookmark,
  removeCanvasRegion,
  resizeCanvasRegion,
  removeDysonNode,
  removeDysonSwarmOrbit,
  removeQueuedTechnology,
  refillStationWarpers,
  resumePausedResearch,
  selectInfiniteResearch,
  settleCompletedResearchBoundaries,
  setGalacticDispatchAutomation,
  setGalacticExportEnabled,
  setGalacticMaterialExporterPaused,
  selectTechnology,
  setActivePlanet,
  setPlanetIndustryRole,
  setPlanetTrayItemLimit,
  setActiveDysonSwarmOrbit,
  setBeltPriority,
  setBeltRouteMode,
  setBeltRouteOffsetY,
  setBlueprintRecipeOverride,
  setBlueprintTransform,
  setBeltMonitorEnabled,
  setBeltStackSize,
  setConstructionAutomationTarget,
  setEntityRecipe,
  setEntityPowerGrid,
  setDysonLaunchEnabled,
  setDysonLaunchMode,
  setDysonLaunchThrottle,
  setDysonSwarmOrbit,
  setEjectorTargetOrbit,
  setEjectorTargetOrbitForEntities,
  setRecipeFocus,
  updateCanvasRegion,
  setRecipeFocusMode,
  renameCanvasBookmark,
  renameBlueprint,
  setEntitiesRecipe,
  setEnergyMode,
  setEntitiesInteractionLocked,
  setFuelItem,
  setLogisticsItem,
  setPaused,
  setMaterialDeliverySlot,
  setProliferatorConfiguration,
  setEntitiesProliferatorConfiguration,
  setStationMode,
  setStationFleetTarget,
  setRemoteStationFleetTarget,
  setRemoteStationSlotItem,
  setRemoteBuildingStackTarget,
  adjustRemoteStationWarpers,
  setStationHubConfiguration,
  setStationMinimumLoad,
  setStationSlotItem,
  setStationSlotLimits,
  setStationSlotMinimumLoad,
  setStationSlotMode,
  setStationSlotPriority,
  setStationSlotRoutePolicy,
  setStationSlotWarperBudget,
  setStationWarpEnabled,
  setStationWarperAutoRefill,
  setStationWarperTarget,
  setSplitterMode,
  canQueueHandcraftRecipe,
  upgradeBelt,
  upgradeEntities,
  upgradeEntity,
  upgradeSorter,
  MAX_BUILDING_STACK_COUNT,
} from "./engine";
import { getGalacticExportTarget } from "./endgame";
import { PLANET_LIST, STAR_SYSTEM_LIST, TECHNOLOGY_LIST, getBuilding } from "./content";
import { getPlanetSolarPowerMultiplier, getStarLuminosity } from "./galaxy";

describe("factory simulation", () => {
  it("applies difficulty presets to production, mining and logistics multipliers", () => {
    const relaxed = createInitialState();
    relaxed.settings.difficulty = "relaxed";
    const hard = createInitialState();
    hard.settings.difficulty = "hard";
    expect(getRecipeSpeedMultiplier(relaxed, "iron_ingot")).toBeCloseTo(1.15, 5);
    expect(getMiningSpeedMultiplier(relaxed)).toBeCloseTo(1.15, 5);
    expect(getLogisticsSpeedMultiplier(relaxed)).toBeCloseTo(1.1, 5);
    expect(getRecipeSpeedMultiplier(hard, "iron_ingot")).toBeCloseTo(0.85, 5);
    expect(getMiningSpeedMultiplier(hard)).toBeCloseTo(0.85, 5);
    expect(getLogisticsSpeedMultiplier(hard)).toBeCloseTo(0.9, 5);
  });

  it("keeps the complete technology graph valid, acyclic and tier ordered", () => {
    const technologies = new Map(TECHNOLOGY_LIST.map((technology) => [technology.id, technology]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (techId: string) => {
      if (visited.has(techId)) return;
      expect(visiting.has(techId), `technology cycle at ${techId}`).toBe(false);
      visiting.add(techId);
      const technology = technologies.get(techId as typeof TECHNOLOGY_LIST[number]["id"])!;
      expect(technology).toBeDefined();
      expect(technology.costs.every((cost) => Number.isInteger(cost.amount) && cost.amount > 0)).toBe(true);
      for (const prerequisiteId of technology.prerequisites) {
        const prerequisite = technologies.get(prerequisiteId);
        expect(prerequisite, `${techId} prerequisite ${prerequisiteId}`).toBeDefined();
        expect(prerequisite!.tier).toBeLessThanOrEqual(technology.tier);
        visit(prerequisiteId);
      }
      visiting.delete(techId);
      visited.add(techId);
    };
    for (const technology of TECHNOLOGY_LIST) visit(technology.id);
    expect(visited.size).toBe(TECHNOLOGY_LIST.length);
  });

  it("starts with the requested construction kit and a seeded eight-system ecology catalog", () => {
    const state = createInitialState();
    expect(state.construction).toMatchObject({
      wind_turbine: 3,
      mining_machine: 2,
      arc_smelter: 3,
      assembling_machine_mk1: 3,
      matrix_lab: 2,
      conveyor_belt_mk1: 10,
    });
    expect(state.tray).toMatchObject({ iron_ore: 100, copper_ore: 100, stone: 100 });
    expect(state.exploration.colonizedPlanetIds).toEqual(["home"]);
    expect(setActivePlanet(state, "ashen")).toBe(state);
    expect(STAR_SYSTEM_LIST).toHaveLength(8);
    expect(PLANET_LIST).toHaveLength(22);
    expect(new Set(Object.values(state.galaxy.profiles).map((profile) => profile.templateId)).size).toBeGreaterThanOrEqual(12);
    expect(state.entities.filter((entity) => entity.kind === "vein")).toHaveLength(106);
    expect(state.entities.filter((entity) => entity.kind === "vein").map((entity) => entity.resourceId)).toEqual(expect.arrayContaining([
      "kimberlite_ore",
      "fractal_silicon",
      "optical_grating_crystal",
      "organic_crystal",
      "spiniform_stalagmite_crystal",
      "unipolar_magnet",
    ]));
    expect(state.entities.filter((entity) => entity.kind === "vein" && entity.planetId === "home")).toHaveLength(6);
    expect(state.entities.filter((entity) => entity.kind === "vein" && entity.planetId === "ashen")).toHaveLength(10);
    expect(state.entities.filter((entity) => entity.kind === "vein" && entity.planetId === "frost")).toHaveLength(7);
    expect(state.entities.filter((entity) => entity.kind === "vein" && entity.planetId === "magnetar")).toHaveLength(5);
    expect(state.planetMetrics.giant.powerFactor).toBe(1);
    expect(state.planetMetrics.boreal_giant.powerFactor).toBe(1);
    expect(state.planetMetrics.azure_giant.powerFactor).toBe(1);
    expect(state.exploration.unlockedSystemIds).toEqual(["helios"]);
    expect(state.entities.map((entity) => entity.resourceId)).toEqual(expect.arrayContaining(["silicon_ore", "titanium_ore", "water", "sulfuric_acid"]));
  });

  it("advances a non-default seeded galaxy deterministically", () => {
    let state = createInitialState(8_675_309, false);
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -180 }, 2);
    state = installMiner(state, "vein_iron", 1);
    const replay = structuredClone(state);

    expect(advanceSimulation(replay, 95.5)).toEqual(advanceSimulation(state, 95.5));
  });

  it("quick-crafts a construction item from unlocked upstream raw materials atomically", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("electromagnetism");
    const plan = getConstructionQuickCraftPlan(state, "wind_turbine");
    expect(plan).toMatchObject({ status: "upstream", possible: true, usesUpstream: true });
    expect(plan.consumedItems).toEqual(expect.arrayContaining([
      { itemId: "iron_ore", amount: 11 },
      { itemId: "copper_ore", amount: 2 },
    ]));
    const previousCount = state.construction.wind_turbine ?? 0;
    state = craftConstructionWithUpstream(state, "wind_turbine");
    expect(state.construction.wind_turbine).toBe(previousCount + 1);
    expect(state.tray).toMatchObject({ iron_ore: 89, copper_ore: 98, magnetic_coil: 1 });

    const blocked = createInitialState();
    blocked.research.completedTechIds.push("electromagnetism");
    blocked.tray.copper_ore = 0;
    expect(getConstructionQuickCraftPlan(blocked, "wind_turbine")).toMatchObject({ status: "blocked", possible: false });
    expect(craftConstructionWithUpstream(blocked, "wind_turbine")).toBe(blocked);
  });

  it("plans and commits multi-batch construction atomically with actual output amounts", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("electromagnetism", "basic_logistics");
    const initialWind = state.construction.wind_turbine ?? 0;
    const plan = getConstructionQuickCraftPlan(state, "wind_turbine", 3);
    expect(plan).toMatchObject({ possible: true, batches: 3, outputAmount: 3 });
    const crafted = craftConstructionWithUpstream(state, "wind_turbine", 3);
    expect(crafted.construction.wind_turbine).toBe(initialWind + 3);
    expect(crafted.tray).toEqual(expect.objectContaining(Object.fromEntries(
      plan.consumedItems.map(({ itemId, amount }) => [itemId, (state.tray[itemId] ?? 0) - amount]),
    )));

    state.tray.iron_ingot = 20;
    state.tray.gear = 10;
    const beltsBefore = state.construction.conveyor_belt_mk1 ?? 0;
    const fourBatches = craftConstruction(state, "conveyor_belt_mk1", 4);
    expect(fourBatches.construction.conveyor_belt_mk1).toBe(beltsBefore + 12);
    expect(fourBatches.tray).toMatchObject({ iron_ingot: 12, gear: 6 });

    const insufficient = createInitialState();
    insufficient.research.completedTechIds.push("basic_logistics");
    insufficient.tray.iron_ingot = 3;
    insufficient.tray.gear = 1;
    const snapshot = structuredClone(insufficient);
    expect(craftConstruction(insufficient, "conveyor_belt_mk1", 2)).toBe(insufficient);
    expect(insufficient).toEqual(snapshot);
  });

  it("calculates maximum construction and handcraft batches without partial crafting", () => {
    const construction = createInitialState();
    construction.research.completedTechIds.push("electromagnetism");
    const maximum = getMaxConstructionQuickCraftBatches(construction, "wind_turbine");
    expect(maximum).toBeGreaterThan(0);
    expect(getConstructionQuickCraftPlan(construction, "wind_turbine", maximum).possible).toBe(true);
    if (maximum < 100_000) {
      expect(getConstructionQuickCraftPlan(construction, "wind_turbine", maximum + 1).possible).toBe(false);
    }

    const handcraft = createInitialState();
    handcraft.tray.iron_ingot = 17;
    expect(getMaxHandcraftBatches(handcraft, "gear")).toBe(17);
    const crafted = handcraftRecipe(handcraft, "gear", 17);
    expect(crafted.tray.iron_ingot).toBe(0);
    expect(crafted.tray.gear).toBe(17);
  });

  it("keeps refinery loops out of direct handcraft while allowing plasma refining upstream", () => {
    expect(isHandcraftableRecipe("plasma_refining")).toBe(false);
    expect(isRecursiveManufacturingRecipe("plasma_refining")).toBe(true);
    expect(isRecursiveManufacturingRecipe("xray_cracking")).toBe(false);
    expect(isRecursiveManufacturingRecipe("reforming_refine")).toBe(false);

    const state = createInitialState();
    state.research.completedTechIds.push("high_efficiency_plasma_control", "basic_chemical_engineering");
    state.tray = { crude_oil: 2, energetic_graphite: 1 };
    state.planetTrays.home = state.tray;
    const directSnapshot = structuredClone(state);
    expect(handcraftRecipe(state, "plasma_refining")).toBe(state);
    expect(state).toEqual(directSnapshot);

    const plan = getRecursiveHandcraftPlan(state, "plastic");
    expect(plan.possible).toBe(true);
    expect(plan.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipeId: "plasma_refining", itemId: "refined_oil" }),
    ]));
    const crafted = handcraftRecipeWithUpstream(state, "plastic");
    expect(crafted.tray).toMatchObject({ crude_oil: 0, energetic_graphite: 0, hydrogen: 1, plastic: 1 });
    expect(crafted.totalProduced).toMatchObject({ refined_oil: 2, hydrogen: 1, plastic: 1 });
  });

  it("quick-crafts an oil-chain building from crude oil and preserves refinery hydrogen", () => {
    const state = createInitialState();
    state.research.completedTechIds.push(
      "high_efficiency_plasma_control",
      "basic_chemical_engineering",
      "titanium_alloy",
      "geothermal_power",
    );
    state.tray = {
      crude_oil: 24,
      stone: 32,
      water: 16,
      titanium_ingot: 8,
      steel: 23,
      processor: 4,
    };
    state.planetTrays.home = state.tray;

    const plan = getConstructionQuickCraftPlan(state, "geothermal_power_station");
    expect(plan).toMatchObject({ possible: true, status: "upstream" });
    expect(plan.recipeDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipeId: "plasma_refining", itemId: "refined_oil" }),
    ]));
    const crafted = craftConstructionWithUpstream(state, "geothermal_power_station");
    expect(crafted.construction.geothermal_power_station).toBe(1);
    expect(crafted.tray.crude_oil).toBe(0);
    expect(crafted.tray.hydrogen).toBe(12);
  });

  it("classifies the quick-build hammer from only the active planet tray", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("electromagnetism");
    state.exploration.colonizedPlanetIds.push("ashen");
    expect(getConstructionQuickCraftPlan(state, "wind_turbine").status).toBe("upstream");

    state = setActivePlanet(state, "ashen");
    expect(state.tray).toEqual({});
    expect(getConstructionQuickCraftPlan(state, "wind_turbine")).toMatchObject({ status: "blocked", possible: false });
    expect(craftConstructionWithUpstream(state, "wind_turbine")).toBe(state);

    state = setActivePlanet(state, "home");
    expect(getConstructionQuickCraftPlan(state, "wind_turbine").status).toBe("upstream");
  });

  it("resolves a disabled construction hammer to a craftable upstream item or an explicit blocker", () => {
    const upstream = createInitialState();
    upstream.tray = { iron_ore: 1 };
    expect(getConstructionCraftNavigation(upstream, "arc_smelter")).toEqual({
      status: "raw-shortage",
      itemId: "iron_ore",
      current: 1,
      required: 4,
    });

    upstream.tray = { iron_ore: 16, copper_ore: 6, stone: 2 };
    expect(getConstructionCraftNavigation(upstream, "arc_smelter")).toEqual({ status: "target", itemId: "iron_ingot", recipeId: "iron_ingot" });

    const rawBlocked = createInitialState();
    rawBlocked.tray = {};
    expect(getConstructionCraftNavigation(rawBlocked, "arc_smelter")).toEqual({
      status: "raw-shortage",
      itemId: "iron_ore",
      current: 0,
      required: 4,
    });

    expect(getConstructionCraftNavigation(createInitialState(), "conveyor_belt_mk1")).toMatchObject({
      status: "technology",
      technologyName: "基础物流系统",
    });
  });

  it("recovers an arbitrary number of installed extractors without removing the vein, buffers or belts", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("basic_logistics");
    state = installMiner(state, "vein_iron", 2);
    state.construction.storage_mk1 = 1;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    state = setLogisticsItem(state, storage.id, "iron_ore");
    state = connectBelt(state, "vein_iron", storage.id, "iron_ore");
    const before = state.entities.find((entity) => entity.id === "vein_iron")!;
    before.outputs.iron_ore = 17;
    before.resourceCapacity = 240_000;
    before.resourceRemaining = 230_000;
    state.belts[0].progress = 0.65;
    const constructionBefore = state.construction.mining_machine ?? 0;

    state = removeEntity(state, "vein_iron", 1);
    expect(state.entities.find((entity) => entity.id === "vein_iron")).toMatchObject({
      minerCount: 1,
      outputs: { iron_ore: 17 },
      resourceCapacity: 240_000,
      resourceRemaining: 230_000,
    });
    expect(state.construction.mining_machine).toBe(constructionBefore + 1);
    expect(state.belts).toEqual([expect.objectContaining({ source: "vein_iron", target: storage.id, progress: 0.65 })]);

    state = removeEntity(state, "vein_iron");
    expect(state.entities.find((entity) => entity.id === "vein_iron")).toMatchObject({
      minerCount: 0,
      outputs: { iron_ore: 17 },
      utilization: 0,
      productionRate: 0,
    });
    expect(state.construction.mining_machine).toBe(constructionBefore + 2);
    expect(state.belts).toHaveLength(1);
  });

  it("removes one stacked building at a time without touching buffers, progress or connected belts", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("basic_logistics");
    state.construction.arc_smelter = 3;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "arc_smelter", { x: 220, y: 0 }, 3);
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = connectBelt(state, "vein_iron", smelter.id, "iron_ore");
    const target = state.entities.find((entity) => entity.id === smelter.id)!;
    target.inputs.iron_ore = 7;
    target.outputs.iron_ingot = 5;
    target.progress = 0.625;
    state.belts[0].progress = 0.75;

    state = removeEntity(state, smelter.id, 1);
    expect(state.entities.find((entity) => entity.id === smelter.id)).toMatchObject({
      machineCount: 2,
      inputs: { iron_ore: 7 },
      outputs: { iron_ingot: 5 },
      progress: 0.625,
    });
    expect(state.construction.arc_smelter).toBe(1);
    expect(state.belts).toEqual([expect.objectContaining({ progress: 0.75 })]);

    state = removeEntity(state, smelter.id, 1);
    expect(state.entities.find((entity) => entity.id === smelter.id)?.machineCount).toBe(1);
    expect(state.construction.arc_smelter).toBe(2);
    expect(state.belts).toHaveLength(1);

    state = removeEntity(state, smelter.id, 1);
    expect(state.entities.some((entity) => entity.id === smelter.id)).toBe(false);
    expect(state.construction.arc_smelter).toBe(3);
    expect(state.construction.conveyor_belt_mk1).toBe(1);
    expect(state.belts).toHaveLength(0);
    expect(state.tray).toMatchObject({ iron_ore: 107, iron_ingot: 5 });
  });

  it("scales every stacked buffer and preserves over-capacity stock after reducing a group", () => {
    let state = createInitialState();
    state.construction.arc_smelter = 3;
    state.construction.thermal_power_plant = 2;
    state.construction.interstellar_logistics_station = 3;
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 }, 3);
    state = placeBuilding(state, "thermal_power_plant", { x: 260, y: 0 }, 2);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 520, y: 0 }, 3);
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    const generator = state.entities.find((entity) => entity.buildingId === "thermal_power_plant")!;
    const station = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;

    expect(getEntityInputCapacity(state, smelter)).toBe(getBuilding("arc_smelter").inputCapacity * 3);
    expect(getEntityOutputCapacity(state, smelter)).toBe(getBuilding("arc_smelter").outputCapacity * 3);
    expect(getEntityInputCapacity(state, generator)).toBe(getBuilding("thermal_power_plant").inputCapacity * 2);
    expect(getStationSlotCapacity(state, station, getStationSlots(station)[0])).toBe(getBuilding("interstellar_logistics_station").outputCapacity * 3);

    smelter.inputs.iron_ore = getEntityInputCapacity(state, smelter);
    const trayBefore = state.tray.iron_ore;
    state = removeEntity(state, smelter.id, 1);
    const reduced = state.entities.find((entity) => entity.id === smelter.id)!;
    expect(reduced.machineCount).toBe(2);
    expect(reduced.inputs.iron_ore).toBe(getBuilding("arc_smelter").inputCapacity * 3);
    expect(getEntityInputCapacity(state, reduced)).toBe(getBuilding("arc_smelter").inputCapacity * 2);
    state = moveTrayItemToEntity(state, reduced.id, "iron_ore");
    expect(state.tray.iron_ore).toBe(trayBefore);
    expect(state.entities.find((entity) => entity.id === reduced.id)?.inputs.iron_ore).toBe(getBuilding("arc_smelter").inputCapacity * 3);
  });

  it("applies independent production and logistics buffer limits per item and per station slot", () => {
    let state = createInitialState();
    state.construction.arc_smelter = 1;
    state.construction.storage_mk1 = 1;
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 260, y: 0 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: 520, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const station = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    smelter.machineCount = 10_000;
    storage.machineCount = 10_000;
    station.machineCount = 10_000;
    state.settings.productionBufferLimit = 10_000;
    state.settings.logisticsBufferLimit = 100_000;

    expect(getEntityInputCapacity(state, smelter)).toBe(10_000);
    expect(getEntityOutputCapacity(state, smelter)).toBe(10_000);
    expect(getEntityInputCapacity(state, storage)).toBe(100_000);
    expect(getEntityOutputCapacity(state, storage)).toBe(100_000);

    const slots = getStationSlots(station);
    slots[0].maxStock = 25_000;
    slots[1].maxStock = 0;
    slots[2].maxStock = 200_000;
    expect(getStationSlotCapacity(state, station, slots[0])).toBe(25_000);
    expect(getStationSlotCapacity(state, station, slots[1])).toBe(100_000);
    expect(getStationSlotCapacity(state, station, slots[2])).toBe(100_000);

    state.settings.productionBufferLimit = 1_000_000;
    expect(getEntityOutputCapacity(state, storage)).toBe(100_000);
    state.settings.logisticsBufferLimit = 10_000;
    expect(getEntityOutputCapacity(state, smelter)).toBe(1_000_000);
  });

  it("treats every recipe input and output as an independent capped buffer", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("titanium_alloy");
    state.construction.chemical_plant = 1;
    state = placeBuilding(state, "chemical_plant", { x: 0, y: 0 });
    const chemical = state.entities.find((entity) => entity.buildingId === "chemical_plant")!;
    chemical.machineCount = 10_000;
    state = setEntityRecipe(state, chemical.id, "sulfuric_acid");
    state.settings.productionBufferLimit = 1_000;
    state.tray.refined_oil = 1_000;
    state.tray.stone = 1_000;
    state.tray.water = 1_000;

    for (const itemId of ["refined_oil", "stone", "water"] as const) {
      state = moveTrayItemToEntity(state, chemical.id, itemId);
    }
    expect(state.entities.find((entity) => entity.id === chemical.id)?.inputs).toMatchObject({
      refined_oil: 1_000,
      stone: 1_000,
      water: 1_000,
    });
    expect(Object.values(state.entities.find((entity) => entity.id === chemical.id)!.inputs)
      .reduce((sum, amount) => sum + (amount ?? 0), 0)).toBe(3_000);

    const current = state.entities.find((entity) => entity.id === chemical.id)!;
    current.outputs.sulfuric_acid = 1_000;
    current.outputs.hydrogen = 1_000;
    expect(current.outputs.sulfuric_acid).toBe(getEntityOutputCapacity(state, current));
    expect(current.outputs.hydrogen).toBe(getEntityOutputCapacity(state, current));
  });

  it("combines station manual limits with the logistics limit and treats zero as rated capacity", () => {
    let state = createInitialState();
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const station = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    station.machineCount = 200_000;
    state.settings.logisticsBufferLimit = 100_000;
    state = setStationSlotItem(state, station.id, 0, "iron_ingot");
    state = setStationSlotLimits(state, station.id, 0, 0, 25_000);
    let current = state.entities.find((entity) => entity.id === station.id)!;
    expect(getStationSlotCapacity(state, current, getStationSlots(current)[0])).toBe(25_000);
    expect(getEntityItemInputCapacity(state, current, "iron_ingot")).toBe(25_000);
    state.tray.iron_ingot = 100_000;
    state = moveTrayItemToEntity(state, station.id, "iron_ingot");
    current = state.entities.find((entity) => entity.id === station.id)!;
    expect(current.inputs.iron_ingot).toBe(25_000);
    expect(state.tray.iron_ingot).toBe(75_000);

    state = setStationSlotLimits(state, station.id, 0, 0, 0);
    current = state.entities.find((entity) => entity.id === station.id)!;
    expect(getStationSlotCapacity(state, current, getStationSlots(current)[0])).toBe(100_000);
    state = moveTrayItemToEntity(state, station.id, "iron_ingot");
    expect(state.entities.find((entity) => entity.id === station.id)?.inputs.iron_ingot).toBe(100_000);
    expect(state.tray.iron_ingot).toBe(0);

    state = setStationSlotLimits(state, station.id, 0, 0, 50_000_000);
    current = state.entities.find((entity) => entity.id === station.id)!;
    expect(getStationSlotCapacity(state, current, getStationSlots(current)[0])).toBe(100_000);
  });

  it("preserves excess stock after lowering a limit and resumes input after raising it", () => {
    let state = createInitialState();
    state.construction.storage_mk1 = 2;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 300, y: 0 });
    const [source, target] = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    source.storedItemId = "iron_ingot";
    target.storedItemId = "iron_ingot";
    source.machineCount = 20;
    target.machineCount = 20;
    source.outputs.iron_ingot = 2_000;
    target.inputs.iron_ingot = 1_200;
    target.outputs.iron_ingot = 1_200;
    state.settings.logisticsBufferLimit = 1_000;
    state = connectBelt(state, source.id, target.id, "iron_ingot");

    const lowered = advanceSimulation(state, 2);
    expect(lowered.entities.find((entity) => entity.id === target.id)?.inputs.iron_ingot).toBe(1_200);
    expect(lowered.entities.find((entity) => entity.id === target.id)?.outputs.iron_ingot).toBe(1_200);
    expect(lowered.entities.find((entity) => entity.id === source.id)?.outputs.iron_ingot).toBe(2_000);

    lowered.settings.logisticsBufferLimit = 10_000;
    const raised = advanceSimulation(lowered, 2);
    const raisedTarget = raised.entities.find((entity) => entity.id === target.id)!;
    expect((raisedTarget.inputs.iron_ingot ?? 0) + (raisedTarget.outputs.iron_ingot ?? 0)).toBeGreaterThan(2_400);
    expect(raised.entities.find((entity) => entity.id === source.id)?.outputs.iron_ingot).toBeLessThan(2_000);
  });

  it("lets already dispatched station cargo arrive above a newly lowered slot limit", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 1;
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: -300, y: 0 });
    state.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = 100;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const [source, demand] = state.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station");
    demand.outputs.iron_ingot = 1_000;
    demand.stationRoutes = [{ id: "buffer_in_flight", slotIndex: 0, peerId: source.id, itemId: "iron_ingot", scope: "local", cargo: 100, vehicleCount: 1, progress: 0.99, duration: 1, requiresWarp: false, vehicleStationId: demand.id }];
    source.outputs.iron_ingot = 100;
    state.settings.logisticsBufferLimit = 1_000;

    const arrived = advanceSimulation(state, 1);
    expect(arrived.entities.find((entity) => entity.id === demand.id)?.outputs.iron_ingot).toBe(1_100);
    expect(arrived.entities.find((entity) => entity.id === source.id)?.outputs.iron_ingot).toBe(0);
    expect(arrived.entities.find((entity) => entity.id === demand.id)?.stationRoutes).toEqual([]);
  });

  it("uses the production limit for solid miners, oil extractors and water pumps", () => {
    const state = createInitialState();
    state.settings.productionBufferLimit = 1_000;
    for (const entity of state.entities.filter((candidate) => candidate.planetId === "home" && ["iron_ore", "crude_oil", "water"].includes(candidate.resourceId ?? ""))) {
      entity.minerCount = 10_000;
      entity.extractorBuildingId = entity.resourceId === "crude_oil" ? "oil_extractor" : entity.resourceId === "water" ? "water_pump" : "mining_machine";
      expect(getEntityOutputCapacity(state, entity)).toBe(1_000);
    }
  });

  it("uses unlocked defaults only for newly created belts and preserves parallel line parameters", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_speed_logistics", "super_magnetic_logistics");
    state.construction.storage_mk1 = 2;
    state.construction.conveyor_belt_mk1 = 2;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 300, y: 0 });
    const [source, target] = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    source.storedItemId = "iron_ingot";
    target.storedItemId = "iron_ingot";
    state.settings.defaultBeltStackSize = 4;
    state.settings.defaultBeltRouteMode = "upper";
    state = connectBelt(state, source.id, target.id, "iron_ingot");
    expect(state.belts[0]).toMatchObject({ lanes: 1, stackSize: 4, routeMode: "upper" });

    state.settings.defaultBeltStackSize = 1;
    state.settings.defaultBeltRouteMode = "lower";
    state = connectBelt(state, source.id, target.id, "iron_ingot");
    expect(state.belts[0]).toMatchObject({ lanes: 2, stackSize: 4, routeMode: "upper" });

    const locked = createInitialState();
    locked.settings.defaultBeltStackSize = 4;
    locked.construction.storage_mk1 = 2;
    locked.construction.conveyor_belt_mk1 = 1;
    const withSource = placeBuilding(locked, "storage_mk1", { x: 0, y: 0 });
    const withTarget = placeBuilding(withSource, "storage_mk1", { x: 300, y: 0 });
    const [lockedSource, lockedTarget] = withTarget.entities.filter((entity) => entity.buildingId === "storage_mk1");
    lockedSource.storedItemId = "iron_ingot";
    lockedTarget.storedItemId = "iron_ingot";
    const connected = connectBelt(withTarget, lockedSource.id, lockedTarget.id, "iron_ingot");
    expect(connected.belts[0].stackSize).toBe(1);
  });

  it("unlocks the two local destination planets and grants buildings when interstellar logistics completes", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("energy_matrix", "high_speed_logistics");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -180 }, 2);
    state = placeBuilding(state, "matrix_lab", { x: 260, y: 0 });
    const lab = state.entities.find((entity) => entity.buildingId === "matrix_lab")!;
    state = setEntityRecipe(state, lab.id, "matrix_research");
    expect(getAcceptedInputs(state.entities.find((entity) => entity.id === lab.id)!, state)).toEqual([
      "electromagnetic_matrix",
      "energy_matrix",
      "structure_matrix",
      "information_matrix",
      "gravity_matrix",
      "universe_matrix",
    ]);
    state = selectTechnology(state, "interstellar_logistics");
    state.entities.find((entity) => entity.id === lab.id)!.inputs = { electromagnetic_matrix: 20, energy_matrix: 20 };
    state = advanceSimulation(state, 130);

    expect(state.research.completedTechIds).toContain("interstellar_logistics");
    expect(state.exploration.colonizedPlanetIds).toEqual(expect.arrayContaining(["home", "ashen", "giant"]));
    expect(state.construction.interstellar_logistics_station).toBe(2);
    expect(setActivePlanet(state, "ashen").activePlanetId).toBe("ashen");
  });

  it("locks remote systems until exploration consumes the required supplies", () => {
    let state = createInitialState();
    expect(setActivePlanet(state, "frost")).toBe(state);
    expect(canExploreStarSystem(state, "borealis")).toBe(false);

    state.research.completedTechIds.push("stellar_exploration");
    state.tray.space_warper = 7;
    state.tray.information_matrix = 10;
    state.tray.gravity_matrix = 20;
    expect(canExploreStarSystem(state, "borealis")).toBe(true);
    state = exploreStarSystem(state, "borealis");
    expect(state.exploration.unlockedSystemIds).toEqual(["helios", "borealis"]);
    expect(state.tray.space_warper).toBe(5);
    expect(state.tray.information_matrix).toBe(0);
    expect(canExploreStarSystem(state, "neutron")).toBe(true);
    state = exploreStarSystem(state, "neutron");
    expect(state.exploration.unlockedSystemIds).toEqual(["helios", "borealis", "neutron"]);
    expect(state.tray.space_warper).toBe(0);
    expect(state.tray.gravity_matrix).toBe(0);
    state = setActivePlanet(state, "frost");
    expect(state.activePlanetId).toBe("frost");
    expect(setActivePlanet(state, "magnetar").activePlanetId).toBe("magnetar");
  });

  it("captures configured nodes and internal logistics as a deployable blueprint", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_speed_logistics", "interstellar_logistics");
    state.construction.storage_mk1 = 4;
    state.construction.conveyor_belt_mk2 = 2;
    state = placeBuilding(state, "storage_mk1", { x: 100, y: 80 });
    state = placeBuilding(state, "storage_mk1", { x: 460, y: 220 });
    const [source, target] = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    state = setLogisticsItem(state, source.id, "iron_ingot");
    state = setLogisticsItem(state, target.id, "iron_ingot");
    state.entities.find((entity) => entity.id === source.id)!.outputs.iron_ingot = 80;
    state = connectBelt(state, source.id, target.id, "iron_ingot", 2);
    state = upgradeSorter(state, state.belts[0].id);
    state = createBlueprint(state, [source.id, target.id], "铁块缓存链");

    const blueprint = state.blueprints[0];
    expect(blueprint).toMatchObject({ name: "铁块缓存链" });
    expect(blueprint.entities).toHaveLength(2);
    expect(blueprint.entities.map((entity) => entity.offset)).toEqual([{ x: 0, y: 0 }, { x: 360, y: 140 }]);
    expect(blueprint.belts).toEqual([expect.objectContaining({ itemId: "iron_ingot", tier: 2, sorterTier: 2, lanes: 1 })]);
    expect(getBlueprintRequirements(blueprint)).toEqual(expect.arrayContaining([
      { constructionId: "storage_mk1", amount: 2 },
      { constructionId: "conveyor_belt_mk2", amount: 1 },
    ]));

    state = setActivePlanet(state, "ashen");
    expect(canPlaceBlueprint(state, blueprint.id)).toBe(true);
    state = placeBlueprint(state, blueprint.id, { x: -200, y: -100 });
    const copies = state.entities.filter((entity) => entity.planetId === "ashen" && entity.buildingId === "storage_mk1");
    expect(copies).toHaveLength(2);
    expect(copies.map((entity) => entity.position)).toEqual([{ x: -200, y: -100 }, { x: 160, y: 40 }]);
    expect(copies.every((entity) => entity.storedItemId === "iron_ingot" && (entity.outputs.iron_ingot ?? 0) === 0)).toBe(true);
    expect(state.belts.filter((belt) => belt.planetId === "ashen")).toEqual([
      expect.objectContaining({ itemId: "iron_ingot", tier: 2, sorterTier: 2 }),
    ]);
    expect(state.construction).toMatchObject({ storage_mk1: 0, conveyor_belt_mk2: 0 });
  });

  it("moves and upgrades a multi-node selection in one command", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_speed_assembling");
    state.construction.assembling_machine_mk2 = 2;
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 300, y: 0 });
    const assemblers = state.entities.filter((entity) => entity.buildingId === "assembling_machine_mk1");
    state = moveEntities(state, [
      { id: assemblers[0].id, position: { x: 50, y: 90 } },
      { id: assemblers[1].id, position: { x: 350, y: 90 } },
    ]);
    state = upgradeEntities(state, assemblers.map((entity) => entity.id));
    expect(state.entities.filter((entity) => assemblers.some((selected) => selected.id === entity.id))).toEqual([
      expect.objectContaining({ buildingId: "assembling_machine_mk2", position: { x: 50, y: 90 } }),
      expect.objectContaining({ buildingId: "assembling_machine_mk2", position: { x: 350, y: 90 } }),
    ]);
    expect(state.construction.assembling_machine_mk2).toBe(0);
  });

  it("mines manually and feeds a compatible machine", () => {
    let state = createInitialState();
    state = manualMine(state, "vein_iron", 4);
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = pickFromEntity(state, "vein_iron", "iron_ore", 4);
    state = dropCargoToEntity(state, smelter.id);

    expect(state.cargo).toBeNull();
    expect(state.entities.find((entity) => entity.id === smelter.id)?.inputs.iron_ore).toBe(4);
  });

  it("runs a powered smelter with the original early recipe ratio", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 300, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    smelter.inputs.iron_ore = 3;

    state = advanceSimulation(state, 3);
    const result = state.entities.find((entity) => entity.id === smelter.id)!;
    expect(result.outputs.iron_ingot).toBe(2);
    expect(result.inputs.iron_ore).toBe(1);
    expect(result.progress).toBeCloseTo(0.5, 3);
    expect(state.metrics.powerFactor).toBeCloseTo(0.8333, 3);
  });

  it("moves items over a belt and preserves belt throughput", () => {
    let state = createInitialState();
    state.construction.mining_machine = 1;
    state.construction.conveyor_belt_mk1 = 1;
    state = installMiner(state, "vein_iron");
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state.entities.find((entity) => entity.id === "vein_iron")!.outputs.iron_ore = 10;
    state = connectBelt(state, "vein_iron", smelter.id, "iron_ore");
    state = advanceSimulation(state, 1);

    expect(state.entities.find((entity) => entity.id === smelter.id)?.inputs.iron_ore).toBe(6);
    expect(state.belts[0].lastFlow).toBe(6);
  });

  it("returns buffered items and belts when a recipe changes", () => {
    let state = createInitialState();
    state.tray.iron_ore = 0;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    smelter.inputs.iron_ore = 3;
    state = connectBelt(state, "vein_iron", smelter.id, "iron_ore");
    state = setEntityRecipe(state, smelter.id, "copper_ingot");

    expect(state.tray.iron_ore).toBe(3);
    expect(state.belts).toHaveLength(0);
    expect(state.construction.conveyor_belt_mk1).toBe(1);
  });

  it("keeps item inventories integer while internal progress remains continuous", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 4;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 300, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    smelter.inputs.iron_ore = 7;
    state = advanceSimulation(state, 2.35);
    const result = state.entities.find((entity) => entity.id === smelter.id)!;

    expect(Number.isInteger(result.inputs.iron_ore)).toBe(true);
    expect(Number.isInteger(result.outputs.iron_ingot)).toBe(true);
    expect(result.progress).toBeGreaterThan(0);
    expect(result.progress).toBeLessThan(1);
  });

  it("consumes whole electromagnetic matrices to complete research", () => {
    let state = createInitialState();
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = placeBuilding(state, "matrix_lab", { x: 300, y: 0 });
    const lab = state.entities.find((entity) => entity.buildingId === "matrix_lab")!;
    state = setEntityRecipe(state, lab.id, "matrix_research");
    expect(canSelectTechnology(state, "electromagnetic_matrix")).toBe(true);
    expect(canSelectTechnology(state, "electromagnetism")).toBe(false);
    state = selectTechnology(state, "electromagnetic_matrix");
    state.entities.find((entity) => entity.id === lab.id)!.inputs.electromagnetic_matrix = 3;
    state = advanceSimulation(state, 15);

    expect(state.research.completedTechIds).toContain("electromagnetic_matrix");
    expect(state.research.progressByTech.electromagnetic_matrix).toEqual({ electromagnetic_matrix: 3 });
    expect(state.research.selectedTechId).toBeNull();
    expect(state.entities.find((entity) => entity.id === lab.id)?.inputs.electromagnetic_matrix).toBe(0);
    expect(state.construction.matrix_lab).toBe(3);
    expect(canSelectTechnology(state, "electromagnetism")).toBe(true);
  });

  it("repairs a full finite research boundary before a zero-cycle lab can deadlock", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("antimatter");
    state.research.selectedTechId = "universe_matrix";
    state.research.queuedTechIds = ["micro_black_hole_containment"];
    state.research.progressByTech.universe_matrix = {
      electromagnetic_matrix: 100,
      energy_matrix: 100,
      structure_matrix: 100,
      information_matrix: 100,
      gravity_matrix: 100,
    };
    const repaired = settleCompletedResearchBoundaries(state);
    expect(repaired).not.toBe(state);
    expect(repaired.research.completedTechIds).toContain("universe_matrix");
    expect(repaired.research.selectedTechId).toBe("micro_black_hole_containment");
    expect(repaired.research.progressByTech.universe_matrix).toEqual({
      electromagnetic_matrix: 100,
      energy_matrix: 100,
      structure_matrix: 100,
      information_matrix: 100,
      gravity_matrix: 100,
    });
    const repeated = settleCompletedResearchBoundaries(repaired);
    expect(repeated).toBe(repaired);
    expect(repeated.construction.galactic_material_exporter).toBe(1);
  });

  it("normalizes an overfilled research boundary without granting twice", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("antimatter");
    state.research.selectedTechId = "universe_matrix";
    state.research.progressByTech.universe_matrix = {
      electromagnetic_matrix: 101,
      energy_matrix: 101,
      structure_matrix: 101,
      information_matrix: 101,
      gravity_matrix: 101,
    };
    state = settleCompletedResearchBoundaries(state);
    expect(state.research.completedTechIds.filter((id) => id === "universe_matrix")).toHaveLength(1);
    expect(state.research.progressByTech.universe_matrix).toEqual({
      electromagnetic_matrix: 100,
      energy_matrix: 100,
      structure_matrix: 100,
      information_matrix: 100,
      gravity_matrix: 100,
    });
  });

  it("extracts crude oil only after installing an oil extractor", () => {
    let state = createInitialState();
    state.construction.oil_extractor = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 100 });
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 200 });
    state = installMiner(state, "vein_oil");
    state = advanceSimulation(state, 2);

    const oil = state.entities.find((entity) => entity.id === "vein_oil")!;
    expect(oil.extractorBuildingId).toBe("oil_extractor");
    expect(oil.outputs.crude_oil).toBe(2);
    expect(state.construction.oil_extractor).toBe(0);
  });

  it("uses a water pump for the ocean source and keeps water non-manual", () => {
    let state = createInitialState();
    state.construction.water_pump = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = installMiner(state, "vein_water");
    const beforeManual = state;
    state = manualMine(state, "vein_water", 5);
    expect(state).toBe(beforeManual);
    state = advanceSimulation(state, 1.1);

    const water = state.entities.find((entity) => entity.id === "vein_water")!;
    expect(water.extractorBuildingId).toBe("water_pump");
    expect(water.outputs.water).toBe(1);
    expect(state.construction.water_pump).toBe(0);
  });

  it("uses a water pump to extract the ashen sulfuric ocean", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.water_pump = 1;
    state.construction.wind_turbine = 1;
    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = installMiner(state, "ashen_sulfuric");
    state = advanceSimulation(state, 1.1);

    const sulfuricOcean = state.entities.find((entity) => entity.id === "ashen_sulfuric")!;
    expect(sulfuricOcean.extractorBuildingId).toBe("water_pump");
    expect(sulfuricOcean.outputs.sulfuric_acid).toBe(1);
  });

  it("runs the silicon, titanium, chemical and structure matrix recipes", () => {
    let state = createInitialState();
    state.research.completedTechIds.push(
      "high_strength_crystal",
      "basic_chemical_engineering",
      "polymer_chemistry",
      "structure_matrix",
    );
    state.construction.wind_turbine = 3;
    state.construction.chemical_plant = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 3);
    state = placeBuilding(state, "arc_smelter", { x: 250, y: 0 });
    state = placeBuilding(state, "chemical_plant", { x: 500, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 750, y: 0 });
    state = placeBuilding(state, "matrix_lab", { x: 1000, y: 0 });
    const smelterId = state.entities.find((entity) => entity.buildingId === "arc_smelter")!.id;
    const chemicalId = state.entities.find((entity) => entity.buildingId === "chemical_plant")!.id;
    const assemblerId = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;
    const labId = state.entities.find((entity) => entity.buildingId === "matrix_lab")!.id;

    state = setEntityRecipe(state, smelterId, "high_purity_silicon");
    state.entities.find((entity) => entity.id === smelterId)!.inputs.silicon_ore = 2;
    state = advanceSimulation(state, 2.1);
    expect(state.entities.find((entity) => entity.id === smelterId)?.outputs.high_purity_silicon).toBe(1);

    state = setEntityRecipe(state, smelterId, "titanium_ingot");
    state.entities.find((entity) => entity.id === smelterId)!.inputs.titanium_ore = 6;
    state = advanceSimulation(state, 6.1);
    expect(state.entities.find((entity) => entity.id === smelterId)?.outputs.titanium_ingot).toBe(3);

    state = setEntityRecipe(state, smelterId, "diamond");
    state.entities.find((entity) => entity.id === smelterId)!.inputs.energetic_graphite = 1;
    state = advanceSimulation(state, 2.1);
    expect(state.entities.find((entity) => entity.id === smelterId)?.outputs.diamond).toBe(1);

    state = setEntityRecipe(state, chemicalId, "plastic");
    const chemical = state.entities.find((entity) => entity.id === chemicalId)!;
    chemical.inputs.refined_oil = 4;
    chemical.inputs.energetic_graphite = 2;
    state = advanceSimulation(state, 6.1);
    expect(state.entities.find((entity) => entity.id === chemicalId)?.outputs.plastic).toBe(2);

    state = setEntityRecipe(state, chemicalId, "organic_crystal");
    const organicPlant = state.entities.find((entity) => entity.id === chemicalId)!;
    organicPlant.inputs.plastic = 2;
    organicPlant.inputs.refined_oil = 1;
    organicPlant.inputs.water = 1;
    state = advanceSimulation(state, 6.1);
    expect(state.entities.find((entity) => entity.id === chemicalId)?.outputs.organic_crystal).toBe(1);

    state = setEntityRecipe(state, assemblerId, "titanium_crystal");
    const assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.titanium_ingot = 3;
    assembler.inputs.organic_crystal = 1;
    state = advanceSimulation(state, 5.5);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.titanium_crystal).toBe(1);

    state = setEntityRecipe(state, labId, "structure_matrix");
    const lab = state.entities.find((entity) => entity.id === labId)!;
    lab.inputs.diamond = 1;
    lab.inputs.titanium_crystal = 1;
    state = advanceSimulation(state, 8.1);
    expect(state.entities.find((entity) => entity.id === labId)?.outputs.structure_matrix).toBe(1);
    expect(state.totalProduced.structure_matrix).toBe(1);
  });

  it("runs the sulfuric acid, titanium alloy, processor and vessel recipes", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("titanium_alloy", "processor", "interstellar_logistics");
    state.construction.wind_turbine = 6;
    state.construction.chemical_plant = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 6);
    state = placeBuilding(state, "chemical_plant", { x: 250, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 500, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 750, y: 0 });
    const chemicalId = state.entities.find((entity) => entity.buildingId === "chemical_plant")!.id;
    const smelterId = state.entities.find((entity) => entity.buildingId === "arc_smelter")!.id;
    const assemblerId = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;

    state = setEntityRecipe(state, chemicalId, "sulfuric_acid");
    const chemical = state.entities.find((entity) => entity.id === chemicalId)!;
    chemical.inputs.refined_oil = 6;
    chemical.inputs.stone = 8;
    chemical.inputs.water = 4;
    state = advanceSimulation(state, 6.1);
    expect(state.entities.find((entity) => entity.id === chemicalId)?.outputs.sulfuric_acid).toBe(4);

    state = setEntityRecipe(state, smelterId, "titanium_alloy");
    const smelter = state.entities.find((entity) => entity.id === smelterId)!;
    smelter.inputs.titanium_ingot = 4;
    smelter.inputs.steel = 4;
    smelter.inputs.sulfuric_acid = 8;
    state = advanceSimulation(state, 12.1);
    expect(state.entities.find((entity) => entity.id === smelterId)?.outputs.titanium_alloy).toBe(4);

    state = setEntityRecipe(state, assemblerId, "microcrystalline_component");
    let assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.high_purity_silicon = 2;
    assembler.inputs.copper_ingot = 1;
    state = advanceSimulation(state, 2.8);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.microcrystalline_component).toBe(1);

    state = setEntityRecipe(state, assemblerId, "processor");
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.circuit_board = 2;
    assembler.inputs.microcrystalline_component = 2;
    state = advanceSimulation(state, 4.1);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.processor).toBe(1);

    state = setEntityRecipe(state, assemblerId, "logistics_vessel");
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.titanium_alloy = 10;
    assembler.inputs.processor = 10;
    assembler.inputs.plasma_exciter = 4;
    state = advanceSimulation(state, 10.8);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.logistics_vessel).toBe(1);
  });

  it("runs the graphene, nanotube, particle broadband and information matrix recipes", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("nanomaterials", "information_matrix");
    state.construction.wind_turbine = 9;
    state.construction.chemical_plant = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 9);
    state = placeBuilding(state, "chemical_plant", { x: 250, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 500, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 750, y: 0 });
    state = placeBuilding(state, "matrix_lab", { x: 1000, y: 0 });
    const chemicalId = state.entities.find((entity) => entity.buildingId === "chemical_plant")!.id;
    const smelterId = state.entities.find((entity) => entity.buildingId === "arc_smelter")!.id;
    const assemblerId = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;
    const labId = state.entities.find((entity) => entity.buildingId === "matrix_lab")!.id;

    state = setEntityRecipe(state, chemicalId, "graphene");
    let chemical = state.entities.find((entity) => entity.id === chemicalId)!;
    chemical.inputs.energetic_graphite = 3;
    chemical.inputs.sulfuric_acid = 1;
    state = advanceSimulation(state, 3.1);
    expect(state.entities.find((entity) => entity.id === chemicalId)?.outputs.graphene).toBe(2);

    state = setEntityRecipe(state, chemicalId, "carbon_nanotube");
    chemical = state.entities.find((entity) => entity.id === chemicalId)!;
    chemical.inputs.graphene = 3;
    chemical.inputs.titanium_ingot = 1;
    state = advanceSimulation(state, 4.1);
    expect(state.entities.find((entity) => entity.id === chemicalId)?.outputs.carbon_nanotube).toBe(2);

    state = setEntityRecipe(state, smelterId, "crystal_silicon");
    const smelter = state.entities.find((entity) => entity.id === smelterId)!;
    smelter.inputs.high_purity_silicon = 2;
    state = advanceSimulation(state, 4.1);
    expect(state.entities.find((entity) => entity.id === smelterId)?.outputs.crystal_silicon).toBe(2);

    state = setEntityRecipe(state, assemblerId, "particle_broadband");
    const assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.carbon_nanotube = 2;
    assembler.inputs.crystal_silicon = 2;
    assembler.inputs.plastic = 1;
    state = advanceSimulation(state, 10.8);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.particle_broadband).toBe(1);

    state = setEntityRecipe(state, labId, "information_matrix");
    const lab = state.entities.find((entity) => entity.id === labId)!;
    lab.inputs.particle_broadband = 2;
    lab.inputs.processor = 2;
    state = advanceSimulation(state, 10.1);
    expect(state.entities.find((entity) => entity.id === labId)?.outputs.information_matrix).toBe(1);
    expect(state.totalProduced.information_matrix).toBe(1);
  });

  it("runs the electromagnetic drive, deuterium and fuel rod chain", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("basic_logistics", "high_speed_logistics", "miniature_particle_collider");
    state.construction.wind_turbine = 50;
    state.construction.miniature_particle_collider = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 50);
    state = placeBuilding(state, "miniature_particle_collider", { x: 250, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 500, y: 0 });
    const colliderId = state.entities.find((entity) => entity.buildingId === "miniature_particle_collider")!.id;
    const assemblerId = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;

    state = setEntityRecipe(state, assemblerId, "electric_motor");
    let assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.iron_ingot = 2;
    assembler.inputs.gear = 1;
    assembler.inputs.magnetic_coil = 1;
    state = advanceSimulation(state, 2.8);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.electric_motor).toBe(1);

    state = setEntityRecipe(state, assemblerId, "electromagnetic_turbine");
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.electric_motor = 2;
    assembler.inputs.magnetic_coil = 2;
    state = advanceSimulation(state, 2.8);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.electromagnetic_turbine).toBe(1);

    state = setEntityRecipe(state, assemblerId, "super_magnetic_ring");
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.electromagnetic_turbine = 2;
    assembler.inputs.magnet = 3;
    assembler.inputs.energetic_graphite = 1;
    state = advanceSimulation(state, 4.1);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.super_magnetic_ring).toBe(1);

    state = setEntityRecipe(state, colliderId, "deuterium");
    const collider = state.entities.find((entity) => entity.id === colliderId)!;
    collider.inputs.hydrogen = 10;
    state = advanceSimulation(state, 5.1);
    expect(state.entities.find((entity) => entity.id === colliderId)?.outputs.deuterium).toBe(5);

    state = setEntityRecipe(state, assemblerId, "deuteron_fuel_rod");
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.titanium_alloy = 1;
    assembler.inputs.deuterium = 20;
    assembler.inputs.super_magnetic_ring = 1;
    state = advanceSimulation(state, 8.1);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.deuteron_fuel_rod).toBe(2);

    let fuelState = createInitialState();
    fuelState.construction.thermal_power_plant = 1;
    fuelState = placeBuilding(fuelState, "thermal_power_plant", { x: 0, y: 0 });
    fuelState = placeBuilding(fuelState, "arc_smelter", { x: 300, y: 0 });
    const plantId = fuelState.entities.find((entity) => entity.buildingId === "thermal_power_plant")!.id;
    fuelState = setFuelItem(fuelState, plantId, "deuteron_fuel_rod");
    fuelState.entities.find((entity) => entity.id === plantId)!.inputs.deuteron_fuel_rod = 1;
    fuelState.entities.find((entity) => entity.buildingId === "arc_smelter")!.inputs.iron_ore = 1;
    fuelState = advanceSimulation(fuelState, 1);
    expect(fuelState.entities.find((entity) => entity.id === plantId)?.fuelItemId).toBe("deuteron_fuel_rod");
    expect(fuelState.entities.find((entity) => entity.id === plantId)?.fuelRemainingMj).toBeGreaterThan(599);
  });

  it("runs the quantum chip, strange matter and gravity matrix chain", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("miniature_particle_collider", "quantum_chip", "gravity_matrix");
    state.construction.wind_turbine = 50;
    state.construction.miniature_particle_collider = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 50);
    state = placeBuilding(state, "miniature_particle_collider", { x: 250, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 500, y: 0 });
    state = placeBuilding(state, "matrix_lab", { x: 750, y: 0 });
    const colliderId = state.entities.find((entity) => entity.buildingId === "miniature_particle_collider")!.id;
    const assemblerId = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;
    const labId = state.entities.find((entity) => entity.buildingId === "matrix_lab")!.id;

    state = setEntityRecipe(state, assemblerId, "titanium_glass");
    let assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.glass = 2;
    assembler.inputs.titanium_ingot = 2;
    assembler.inputs.water = 2;
    state = advanceSimulation(state, 6.8);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.titanium_glass).toBe(2);

    state = setEntityRecipe(state, assemblerId, "casimir_crystal");
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.titanium_crystal = 1;
    assembler.inputs.graphene = 2;
    assembler.inputs.hydrogen = 12;
    state = advanceSimulation(state, 5.5);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.casimir_crystal).toBe(1);

    state = setEntityRecipe(state, assemblerId, "plane_filter");
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.casimir_crystal = 1;
    assembler.inputs.titanium_glass = 2;
    state = advanceSimulation(state, 16.1);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.plane_filter).toBe(1);

    state = setEntityRecipe(state, assemblerId, "quantum_chip");
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.processor = 2;
    assembler.inputs.plane_filter = 2;
    state = advanceSimulation(state, 8.1);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.quantum_chip).toBe(1);

    state = setEntityRecipe(state, colliderId, "strange_matter");
    const collider = state.entities.find((entity) => entity.id === colliderId)!;
    collider.inputs.particle_container = 2;
    collider.inputs.iron_ingot = 2;
    collider.inputs.deuterium = 10;
    state = advanceSimulation(state, 8.1);
    expect(state.entities.find((entity) => entity.id === colliderId)?.outputs.strange_matter).toBe(1);

    state = setEntityRecipe(state, assemblerId, "graviton_lens");
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.diamond = 4;
    assembler.inputs.strange_matter = 1;
    state = advanceSimulation(state, 8.1);
    expect(state.entities.find((entity) => entity.id === assemblerId)?.outputs.graviton_lens).toBe(1);

    state = setEntityRecipe(state, labId, "gravity_matrix");
    const lab = state.entities.find((entity) => entity.id === labId)!;
    lab.inputs.graviton_lens = 1;
    lab.inputs.quantum_chip = 1;
    state = advanceSimulation(state, 24.1);
    expect(state.entities.find((entity) => entity.id === labId)?.outputs.gravity_matrix).toBe(2);
    expect(state.totalProduced.gravity_matrix).toBe(2);
  });

  it("consumes four and five matrix colors across both research speed upgrades", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("information_matrix");
    state.construction.wind_turbine = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
    state = placeBuilding(state, "matrix_lab", { x: 300, y: 0 });
    const labId = state.entities.find((entity) => entity.buildingId === "matrix_lab")!.id;
    state = setEntityRecipe(state, labId, "matrix_research");
    state = selectTechnology(state, "research_speed_1");
    state.research.progressByTech.research_speed_1 = {
      electromagnetic_matrix: 19,
      energy_matrix: 19,
      structure_matrix: 19,
      information_matrix: 19,
    };
    const lab = state.entities.find((entity) => entity.id === labId)!;
    lab.inputs.electromagnetic_matrix = 1;
    lab.inputs.energy_matrix = 1;
    lab.inputs.structure_matrix = 1;
    lab.inputs.information_matrix = 1;
    state = advanceSimulation(state, 13);

    expect(state.research.completedTechIds).toContain("research_speed_1");
    expect(state.research.progressByTech.research_speed_1).toEqual({
      electromagnetic_matrix: 20,
      energy_matrix: 20,
      structure_matrix: 20,
      information_matrix: 20,
    });
    expect(getRecipeSpeedMultiplier(state, "matrix_research")).toBe(1.25);

    state.research.completedTechIds.push("gravity_matrix");
    state = selectTechnology(state, "research_speed_2");
    state.research.progressByTech.research_speed_2 = {
      electromagnetic_matrix: 19,
      energy_matrix: 19,
      structure_matrix: 19,
      information_matrix: 19,
      gravity_matrix: 19,
    };
    const upgradedLab = state.entities.find((entity) => entity.id === labId)!;
    upgradedLab.inputs.electromagnetic_matrix = 1;
    upgradedLab.inputs.energy_matrix = 1;
    upgradedLab.inputs.structure_matrix = 1;
    upgradedLab.inputs.information_matrix = 1;
    upgradedLab.inputs.gravity_matrix = 1;
    state = advanceSimulation(state, 12.1);
    expect(state.research.completedTechIds).toContain("research_speed_2");
    expect(state.research.progressByTech.research_speed_2).toEqual({
      electromagnetic_matrix: 20,
      energy_matrix: 20,
      structure_matrix: 20,
      information_matrix: 20,
      gravity_matrix: 20,
    });
    expect(getRecipeSpeedMultiplier(state, "matrix_research")).toBe(1.5);
  });

  it("consumes blue and red matrices for interstellar logistics research", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("energy_matrix", "high_speed_logistics");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
    state = placeBuilding(state, "matrix_lab", { x: 300, y: 0 });
    const lab = state.entities.find((entity) => entity.buildingId === "matrix_lab")!;
    state = setEntityRecipe(state, lab.id, "matrix_research");
    state = selectTechnology(state, "interstellar_logistics");
    const researchLab = state.entities.find((entity) => entity.id === lab.id)!;
    researchLab.inputs.electromagnetic_matrix = 20;
    researchLab.inputs.energy_matrix = 20;
    state = advanceSimulation(state, 130);

    expect(state.research.completedTechIds).toContain("interstellar_logistics");
    expect(state.research.progressByTech.interstellar_logistics).toEqual({
      electromagnetic_matrix: 20,
      energy_matrix: 20,
    });
    expect(state.entities.find((entity) => entity.id === lab.id)?.inputs).toMatchObject({
      electromagnetic_matrix: 0,
      energy_matrix: 0,
    });
  });

  it("stops a multi-output refinery when either output is full", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_efficiency_plasma_control");
    state.construction.wind_turbine = 4;
    state.construction.oil_refinery = 1;
    for (let index = 0; index < 4; index += 1) {
      state = placeBuilding(state, "wind_turbine", { x: index * 100, y: 0 });
    }
    state = placeBuilding(state, "oil_refinery", { x: 0, y: 200 });
    const refinery = state.entities.find((entity) => entity.buildingId === "oil_refinery")!;
    refinery.inputs.crude_oil = 10;
    refinery.outputs.hydrogen = 240;

    state = advanceSimulation(state, 20);
    const result = state.entities.find((entity) => entity.id === refinery.id)!;
    expect(result.inputs.crude_oil).toBe(10);
    expect(result.outputs.refined_oil ?? 0).toBe(0);
    expect(result.outputs.hydrogen).toBe(240);
  });

  it("passes items through storage into a downstream machine", () => {
    let state = createInitialState();
    state.construction.storage_mk1 = 1;
    state.construction.conveyor_belt_mk1 = 2;
    state = placeBuilding(state, "storage_mk1", { x: -100, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 200, y: 0 });
    const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = setLogisticsItem(state, storage.id, "iron_ore");
    state.entities.find((entity) => entity.id === "vein_iron")!.outputs.iron_ore = 12;
    state = connectBelt(state, "vein_iron", storage.id, "iron_ore");
    state = connectBelt(state, storage.id, smelter.id, "iron_ore");
    state = advanceSimulation(state, 2);

    expect(state.entities.find((entity) => entity.id === smelter.id)?.inputs.iron_ore).toBe(6);
  });

  it("rejects a belt whose source or target no longer matches the selected item", () => {
    const state = createInitialState();
    expect(canConnectBelt(state, "vein_iron", "vein_copper", "iron_ore")).toBe(false);
  });

  it("never auto-detects a new recipe for a locked machine", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_efficiency_plasma_control", "reforming_refine");
    state.construction.storage_mk1 = 1;
    state.construction.oil_refinery = 1;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "storage_mk1", { x: -200, y: 0 });
    state = placeBuilding(state, "oil_refinery", { x: 200, y: 0 });
    const source = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const refinery = state.entities.find((entity) => entity.buildingId === "oil_refinery")!;
    state = setLogisticsItem(state, source.id, "coal");
    state.entities.find((entity) => entity.id === source.id)!.outputs.coal = 10;
    state = setEntitiesInteractionLocked(state, [refinery.id], true);

    const check = getBeltConnectionCheck(state, source.id, refinery.id, "coal");
    const connected = connectBelt(state, source.id, refinery.id, "coal");

    expect(check).toMatchObject({ ok: false, code: "invalid-target" });
    expect(connected).toBe(state);
    expect(state.entities.find((entity) => entity.id === refinery.id)?.recipeId).toBe("plasma_refining");
  });

  it("refuses auto recipe detection when an existing output line conflicts", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_efficiency_plasma_control", "reforming_refine");
    state.construction.storage_mk1 = 2;
    state.construction.oil_refinery = 1;
    state.construction.conveyor_belt_mk1 = 2;
    state = placeBuilding(state, "storage_mk1", { x: -200, y: 0 });
    state = placeBuilding(state, "oil_refinery", { x: 100, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 400, y: 0 });
    const [source, output] = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    const refinery = state.entities.find((entity) => entity.buildingId === "oil_refinery")!;
    state = setLogisticsItem(state, source.id, "coal");
    state = setLogisticsItem(state, output.id, "hydrogen");
    state.entities.find((entity) => entity.id === source.id)!.outputs.coal = 10;
    const outputBeltId = "existing-hydrogen-output";
    state.belts.push({
      id: outputBeltId, planetId: "home", source: refinery.id, target: output.id, itemId: "hydrogen",
      lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1, lastFlow: 0, totalTransferred: 0, congestion: 0,
    });

    expect(getBeltConnectionCheck(state, source.id, refinery.id, "coal")).toMatchObject({ ok: false, code: "invalid-target" });
    expect(connectBelt(state, source.id, refinery.id, "coal")).toBe(state);
    expect(state.entities.find((entity) => entity.id === refinery.id)?.recipeId).toBe("plasma_refining");
    expect(state.belts.map((belt) => belt.id)).toEqual([outputBeltId]);

    state = removeBelt(state, outputBeltId);
    state = connectBelt(state, source.id, refinery.id, "coal");
    expect(state.entities.find((entity) => entity.id === refinery.id)?.recipeId).toBe("reforming_refine");
    expect(state.belts).toHaveLength(1);
  });

  it("connects every input line of a three-material chemical recipe", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("polymer_chemistry");
    state.construction.chemical_plant = 1;
    state.construction.storage_mk1 = 1;
    state.construction.storage_tank = 2;
    state.construction.conveyor_belt_mk1 = 3;
    state = placeBuilding(state, "storage_mk1", { x: -300, y: -180 });
    state = placeBuilding(state, "storage_tank", { x: -300, y: 0 });
    state = placeBuilding(state, "storage_tank", { x: -300, y: 180 });
    state = placeBuilding(state, "chemical_plant", { x: 200, y: 0 });
    const plasticStorage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const [oilTank, waterTank] = state.entities.filter((entity) => entity.buildingId === "storage_tank");
    const chemical = state.entities.find((entity) => entity.buildingId === "chemical_plant")!;
    state = setLogisticsItem(state, plasticStorage.id, "plastic");
    state = setLogisticsItem(state, oilTank.id, "refined_oil");
    state = setLogisticsItem(state, waterTank.id, "water");
    state = setEntityRecipe(state, chemical.id, "organic_crystal");
    state.entities.find((entity) => entity.id === plasticStorage.id)!.outputs.plastic = 10;
    state.entities.find((entity) => entity.id === oilTank.id)!.outputs.refined_oil = 10;
    state.entities.find((entity) => entity.id === waterTank.id)!.outputs.water = 10;

    state = connectBelt(state, plasticStorage.id, chemical.id, "plastic");
    state = connectBelt(state, oilTank.id, chemical.id, "refined_oil");
    state = connectBelt(state, waterTank.id, chemical.id, "water");

    expect(state.belts.map((belt) => belt.itemId)).toEqual(["plastic", "refined_oil", "water"]);
    expect(state.belts.every((belt) => belt.sorterTier === 1)).toBe(true);
    state = advanceSimulation(state, 1);
    expect(state.entities.find((entity) => entity.id === chemical.id)?.inputs).toMatchObject({
      plastic: 6,
      refined_oil: 6,
      water: 6,
    });
  });

  it("connects and transfers every configured output slot from a logistics station", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_strength_crystal", "basic_chemical_engineering", "titanium_alloy");
    state.construction.interstellar_logistics_station = 1;
    state.construction.arc_smelter = 1;
    state.construction.conveyor_belt_mk1 = 3;
    state = placeBuilding(state, "interstellar_logistics_station", { x: -300, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 240, y: 0 });
    const station = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    const alloy = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = setStationSlotItem(state, station.id, 0, "steel");
    state = setStationSlotItem(state, station.id, 1, "titanium_ingot");
    state = setStationSlotItem(state, station.id, 2, "sulfuric_acid");
    state = setEntityRecipe(state, alloy.id, "titanium_alloy");
    const stationAfterConfig = state.entities.find((entity) => entity.id === station.id)!;
    stationAfterConfig.outputs.steel = 20;
    stationAfterConfig.outputs.titanium_ingot = 20;
    stationAfterConfig.outputs.sulfuric_acid = 20;

    state = connectBelt(state, station.id, alloy.id, "steel");
    state = connectBelt(state, station.id, alloy.id, "titanium_ingot");
    state = connectBelt(state, station.id, alloy.id, "sulfuric_acid");

    expect(state.belts.map((belt) => belt.itemId)).toEqual(["steel", "titanium_ingot", "sulfuric_acid"]);
    expect(state.construction.conveyor_belt_mk1).toBe(0);
    state = advanceSimulation(state, 1);
    expect(state.entities.find((entity) => entity.id === alloy.id)?.inputs).toMatchObject({
      steel: 6,
      titanium_ingot: 6,
      sulfuric_acid: 6,
    });
  });

  it("applies routing configuration to and removes a continuous belt network", () => {
    let state = createInitialState();
    state.construction.storage_mk1 = 1;
    state.construction.arc_smelter = 1;
    state.construction.conveyor_belt_mk1 = 2;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 400, y: 0 });
    const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = setLogisticsItem(state, storage.id, "iron_ore");
    state = connectBelt(state, "vein_iron", storage.id, "iron_ore");
    state = connectBelt(state, storage.id, smelter.id, "iron_ore");
    state = setBeltPriority(state, state.belts[0].id, 2);
    state = setBeltMonitorEnabled(state, state.belts[0].id, true);
    state = setBeltRouteMode(state, state.belts[0].id, "upper");
    state = applyBeltConfigurationToNetwork(state, state.belts[0].id);

    expect(state.belts).toHaveLength(2);
    expect(state.belts.every((belt) => belt.priority === 2 && belt.monitorEnabled && belt.routeMode === "upper")).toBe(true);
    state = removeBeltNetwork(state, state.belts[0].id);
    expect(state.belts).toHaveLength(0);
    expect(state.construction.conveyor_belt_mk1).toBe(2);
  });

  it("persists manual route control points and manages deterministic canvas bookmarks", () => {
    let state = createInitialState();
    state.construction.arc_smelter = 1;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "arc_smelter", { x: 300, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = connectBelt(state, "vein_iron", smelter.id, "iron_ore");
    state = setBeltRouteOffsetY(state, state.belts[0].id, 720);
    expect(state.belts[0]).toMatchObject({ routeMode: "manual", routeOffsetY: 600 });

    state = addCanvasBookmark(state, "home", { x: 123.4, y: -88.8, zoom: 0.873 }, "炼铁区");
    expect(state.canvasBookmarks).toEqual([expect.objectContaining({
      name: "炼铁区",
      planetId: "home",
      viewport: { x: 123, y: -89, zoom: 0.87 },
    })]);
    const bookmarkId = state.canvasBookmarks[0].id;
    state = renameCanvasBookmark(state, bookmarkId, "高炉主线");
    expect(state.canvasBookmarks[0].name).toBe("高炉主线");
    state = removeCanvasBookmark(state, bookmarkId);
    expect(state.canvasBookmarks).toEqual([]);
  });

  it("creates, edits and removes visual production regions without affecting factory entities", () => {
    let state = createInitialState();
    const entitySnapshot = structuredClone(state.entities);
    state = addCanvasRegion(state, "home", { x: -120, y: 80, width: 640, height: 360 }, "冶炼区");
    expect(state.canvasRegions).toEqual([expect.objectContaining({
      name: "冶炼区",
      planetId: "home",
      x: -120,
      y: 80,
      width: 640,
      height: 360,
      fillColor: "#2C6B66",
      borderColor: "#67C7B5",
    })]);
    const regionId = state.canvasRegions[0].id;
    state = updateCanvasRegion(state, regionId, { name: "基础冶炼", fillColor: "#123456", borderColor: "#ABCDEF" });
    expect(state.canvasRegions[0]).toMatchObject({ name: "基础冶炼", fillColor: "#123456", borderColor: "#ABCDEF" });
    state = resizeCanvasRegion(state, regionId, { x: -240, y: 40, width: 920, height: 520 });
    expect(state.canvasRegions[0]).toMatchObject({
      name: "基础冶炼",
      x: -240,
      y: 40,
      width: 920,
      height: 520,
      fillColor: "#123456",
      borderColor: "#ABCDEF",
    });
    state = resizeCanvasRegion(state, regionId, { x: 12, y: 18, width: 1, height: 2 });
    expect(state.canvasRegions[0]).toMatchObject({ x: 12, y: 18, width: 40, height: 40 });
    expect(addCanvasRegion(state, "home", { x: 0, y: 0, width: 20, height: 20 })).toBe(state);
    expect(state.entities).toEqual(entitySnapshot);
    state = removeCanvasRegion(state, regionId);
    expect(state.canvasRegions).toEqual([]);
  });

  const makeSplitterNetwork = (priorities: Array<0 | 1 | 2>, output: number, mode: "balanced" | "priority") => {
    let state = createInitialState();
    state.construction.splitter_4way = 1;
    state.construction.conveyor_belt_mk1 = priorities.length;
    state = placeBuilding(state, "splitter_4way", { x: -100, y: 0 });
    for (let index = 0; index < priorities.length; index += 1) {
      state = placeBuilding(state, "arc_smelter", { x: 200, y: (index - 1) * 100 });
    }
    const splitter = state.entities.find((entity) => entity.buildingId === "splitter_4way")!;
    const smelters = state.entities.filter((entity) => entity.buildingId === "arc_smelter");
    state = setLogisticsItem(state, splitter.id, "iron_ore");
    state.entities.find((entity) => entity.id === splitter.id)!.outputs.iron_ore = output;
    state = setSplitterMode(state, splitter.id, mode);
    for (const [index, smelter] of smelters.entries()) {
      state = connectBelt(state, splitter.id, smelter.id, "iron_ore");
      const belt = state.belts.find((candidate) => candidate.source === splitter.id && candidate.target === smelter.id)!;
      state = setBeltPriority(state, belt.id, priorities[index]);
    }
    return { state, splitter, smelters };
  };

  it("splits balanced output fairly and sends priority output to high lines first", () => {
    const makeNetwork = (priority: boolean) => {
      const network = makeSplitterNetwork(priority ? [2, 0] : [0, 0], 6, priority ? "priority" : "balanced");
      return { ...network, state: advanceSimulation(network.state, 1) };
    };

    const balanced = makeNetwork(false);
    expect(balanced.state.entities.find((entity) => entity.id === balanced.smelters[0].id)?.inputs.iron_ore).toBe(3);
    expect(balanced.state.entities.find((entity) => entity.id === balanced.smelters[1].id)?.inputs.iron_ore).toBe(3);

    const prioritized = makeNetwork(true);
    expect(prioritized.state.entities.find((entity) => entity.id === prioritized.smelters[0].id)?.inputs.iron_ore).toBe(6);
    expect(prioritized.state.entities.find((entity) => entity.id === prioritized.smelters[1].id)?.inputs.iron_ore ?? 0).toBe(0);
    expect(prioritized.state.belts.find((belt) => belt.target === prioritized.smelters[0].id)?.totalTransferred).toBe(6);
  });

  it("orders splitter priority output from high to standard to low", () => {
    const network = makeSplitterNetwork([2, 1, 0], 0, "priority");
    const lineCapacity = Math.floor(getBeltCapacity(network.state.belts[0]));
    network.state.entities.find((entity) => entity.id === network.splitter.id)!.outputs.iron_ore = lineCapacity + 1;
    const advanced = advanceSimulation(network.state, 1);
    const received = network.smelters.map((smelter) => advanced.entities.find((entity) => entity.id === smelter.id)?.inputs.iron_ore ?? 0);

    expect(received).toEqual([lineCapacity, 1, 0]);
  });

  it("round robins equal priority outputs and falls back after a high line blocks", () => {
    const equal = makeSplitterNetwork([2, 2, 2], 5, "priority");
    const balancedHigh = advanceSimulation(equal.state, 1);
    const equalReceived = equal.smelters.map((smelter) => balancedHigh.entities.find((entity) => entity.id === smelter.id)?.inputs.iron_ore ?? 0);
    expect(equalReceived).toEqual([2, 2, 1]);

    const fallback = makeSplitterNetwork([2, 1, 0], 0, "priority");
    const lineCapacity = Math.floor(getBeltCapacity(fallback.state.belts[0]));
    fallback.state.entities.find((entity) => entity.id === fallback.splitter.id)!.outputs.iron_ore = lineCapacity + 1;
    const highTarget = fallback.state.entities.find((entity) => entity.id === fallback.smelters[0].id)!;
    highTarget.inputs.iron_ore = getBuilding("arc_smelter").inputCapacity;
    const advanced = advanceSimulation(fallback.state, 1);
    const fallbackReceived = fallback.smelters.map((smelter) => advanced.entities.find((entity) => entity.id === smelter.id)?.inputs.iron_ore ?? 0);

    expect(fallbackReceived).toEqual([getBuilding("arc_smelter").inputCapacity, lineCapacity, 1]);
  });

  const makeHighThroughputMiningFanout = () => {
    let state = createInitialState();
    state.settings.resourceMode = "infinite";
    state.settings.productionBufferLimit = 1_000_000;
    state.settings.logisticsBufferLimit = 100_000_000;
    state.settings.beltBufferLimit = 100_000_000;
    state.construction.wind_turbine = 1;
    state.construction.storage_mk1 = 3;
    state.construction.conveyor_belt_mk1 = 3;
    state = placeBuilding(state, "wind_turbine", { x: -700, y: -500 });
    for (let index = 0; index < 3; index += 1) state = placeBuilding(state, "storage_mk1", { x: 300, y: index * 140 });
    const generator = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
    generator.machineCount = 4_000_000;
    const source = state.entities.find((entity) => entity.id === "vein_iron")!;
    source.minerCount = 2_000_000;
    source.outputs.iron_ore = 1_000_000;
    const targets = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    for (const target of targets) {
      state.entities.find((entity) => entity.id === target.id)!.machineCount = 100_000;
      state = setLogisticsItem(state, target.id, "iron_ore");
      state = connectBelt(state, source.id, target.id, "iron_ore");
      const belt = state.belts.find((candidate) => candidate.target === target.id)!;
      belt.tier = 3;
      belt.sorterTier = 3;
      belt.lanes = 4_096;
      belt.stackSize = 4;
      belt.priority = 1;
    }
    return { state, sourceId: source.id, targetIds: targets.map((target) => target.id) };
  };

  it("fairly fills three ordinary outputs without using the source cache as a throughput ceiling", () => {
    const network = makeHighThroughputMiningFanout();
    const advanced = advanceSimulation(network.state, 1);
    const received = network.targetIds.map((id) => advanced.entities.find((entity) => entity.id === id)?.inputs.iron_ore ?? 0);
    const expectedPerLine = getBeltCapacity(advanced.belts[0]);
    expect(received).toEqual([expectedPerLine, expectedPerLine, expectedPerLine]);
    expect(received.reduce((sum, amount) => sum + amount, 0)).toBe(expectedPerLine * 3);
  });

  it("round robins limited ordinary output while preserving explicit priority order", () => {
    const fair = makeHighThroughputMiningFanout();
    const fairSource = fair.state.entities.find((entity) => entity.id === fair.sourceId)!;
    fairSource.minerCount = 0;
    fairSource.outputs.iron_ore = 5;
    for (const belt of fair.state.belts) {
      belt.tier = 1;
      belt.lanes = 1;
      belt.stackSize = 1;
    }
    const fairResult = advanceSimulation(fair.state, 1);
    expect(fair.targetIds.map((id) => fairResult.entities.find((entity) => entity.id === id)?.inputs.iron_ore ?? 0)).toEqual([2, 2, 1]);

    const prioritized = makeHighThroughputMiningFanout();
    const prioritizedSource = prioritized.state.entities.find((entity) => entity.id === prioritized.sourceId)!;
    prioritizedSource.minerCount = 0;
    const lineCapacity = getBeltCapacity(prioritized.state.belts[0]);
    prioritizedSource.outputs.iron_ore = lineCapacity * 2;
    prioritized.state.belts.forEach((belt, index) => { belt.priority = [0, 1, 2][index] as 0 | 1 | 2; });
    const priorityResult = advanceSimulation(prioritized.state, 1);
    expect(prioritized.targetIds.map((id) => priorityResult.entities.find((entity) => entity.id === id)?.inputs.iron_ore ?? 0)).toEqual([0, lineCapacity, lineCapacity]);
  });

  it("keeps belt settlement equivalent for 10-second and 30-second offline steps", () => {
    for (const [totalSeconds, expectedStep] of [[9 * 60 * 60, 10], [24 * 60 * 60, 30]] as const) {
      const network = makeHighThroughputMiningFanout();
      const session = createSimulationAdvanceSession(network.state, totalSeconds);
      expect(session.stepSize).toBe(expectedStep);
      advanceSimulationSession(session, 1);
      const segmented = advanceSimulation(network.state, expectedStep);
      const snapshot = (state: typeof network.state) => ({
        source: state.entities.find((entity) => entity.id === network.sourceId)?.outputs.iron_ore ?? 0,
        targets: network.targetIds.map((id) => {
          const target = state.entities.find((entity) => entity.id === id)!;
          return (target.inputs.iron_ore ?? 0) + (target.outputs.iron_ore ?? 0);
        }),
        transferred: state.belts.map((belt) => belt.totalTransferred ?? 0),
      });
      expect(snapshot(session.state)).toEqual(snapshot(segmented));
    }
  });

  it("treats pause as a hard simulation boundary", () => {
    let state = createInitialState();
    state.timeWarp.pendingSimulationSeconds = 12.5;
    state.timeWarp.pendingWallSeconds = 4.5;
    const paused = setPaused(state, true);
    expect(paused.paused).toBe(true);
    expect(paused.timeWarp.pendingSimulationSeconds).toBe(0);
    expect(paused.timeWarp.pendingWallSeconds).toBe(0);
    const resumed = setPaused(paused, false);
    const advanced = advanceSimulation(resumed, 0);
    expect(advanced.elapsedSeconds).toBe(0);
    const stillPaused = advanceSimulationBudget(paused, 30, 30);
    expect(stillPaused.elapsedSeconds).toBe(0);
  });

  it("consumes both blue and red matrices for mixed research", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("energy_matrix");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = placeBuilding(state, "wind_turbine", { x: 100, y: 0 });
    state = placeBuilding(state, "matrix_lab", { x: 300, y: 0 });
    const lab = state.entities.find((entity) => entity.buildingId === "matrix_lab")!;
    state = setEntityRecipe(state, lab.id, "matrix_research");
    state = selectTechnology(state, "xray_cracking");
    const researchLab = state.entities.find((entity) => entity.id === lab.id)!;
    researchLab.inputs.electromagnetic_matrix = 10;
    researchLab.inputs.energy_matrix = 10;
    state = advanceSimulation(state, 65);

    expect(state.research.completedTechIds).toContain("xray_cracking");
    expect(state.research.progressByTech.xray_cracking).toEqual({
      electromagnetic_matrix: 10,
      energy_matrix: 10,
    });
    expect(state.entities.find((entity) => entity.id === lab.id)?.inputs.electromagnetic_matrix).toBe(0);
    expect(state.entities.find((entity) => entity.id === lab.id)?.inputs.energy_matrix).toBe(0);
  });

  it("burns integer fuel only when thermal power is needed", () => {
    let state = createInitialState();
    state.construction.thermal_power_plant = 1;
    state = placeBuilding(state, "thermal_power_plant", { x: 0, y: 0 });
    const plant = state.entities.find((entity) => entity.buildingId === "thermal_power_plant")!;
    state = setFuelItem(state, plant.id, "coal");
    state.entities.find((entity) => entity.id === plant.id)!.inputs.coal = 2;
    state = advanceSimulation(state, 5);

    let result = state.entities.find((entity) => entity.id === plant.id)!;
    expect(result.inputs.coal).toBe(2);
    expect(result.fuelRemainingMj).toBe(0);
    expect(result.powerOutputKw).toBe(0);
    expect(getEntityOperatingStatus(state, result).code).toBe("grid-standby");

    state = placeBuilding(state, "arc_smelter", { x: 300, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    smelter.inputs.iron_ore = 3;
    state = advanceSimulation(state, 1);
    result = state.entities.find((entity) => entity.id === plant.id)!;

    expect(result.inputs.coal).toBe(1);
    expect(result.fuelRemainingMj).toBeCloseTo(2.25, 4);
    expect(result.powerOutputKw).toBe(360);
    expect(state.metrics.thermalGenerationKw).toBe(360);
    expect(state.metrics.powerFactor).toBe(1);
    expect(state.metrics.fuelReserveSeconds).toBeGreaterThan(1);
  });

  it("uses wind before thermal generation and preserves queued fuel", () => {
    let state = createInitialState();
    state.construction.thermal_power_plant = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = placeBuilding(state, "wind_turbine", { x: 100, y: 0 });
    state = placeBuilding(state, "thermal_power_plant", { x: 200, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 400, y: 0 });
    const plant = state.entities.find((entity) => entity.buildingId === "thermal_power_plant")!;
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = setFuelItem(state, plant.id, "coal");
    state.entities.find((entity) => entity.id === plant.id)!.inputs.coal = 2;
    state.entities.find((entity) => entity.id === smelter.id)!.inputs.iron_ore = 2;
    state = advanceSimulation(state, 1);

    const result = state.entities.find((entity) => entity.id === plant.id)!;
    expect(result.inputs.coal).toBe(2);
    expect(result.powerOutputKw).toBe(0);
    expect(state.metrics.windGenerationKw).toBe(600);
    expect(state.metrics.thermalGenerationKw).toBe(0);
  });

  it("reports actionable stop reasons for production machines", () => {
    let state = createInitialState();
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    expect(getEntityOperatingStatus(state, smelter).label).toBe("缺少铁矿石");

    smelter.inputs.iron_ore = 1;
    state = advanceSimulation(state, 0.2);
    expect(getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === smelter.id)!).code).toBe("no-power");

    const blocked = state.entities.find((entity) => entity.id === smelter.id)!;
    blocked.outputs.iron_ingot = 120;
    expect(getEntityOperatingStatus(state, blocked).label).toBe("输出堵塞：铁块");
  });

  it("takes raw materials back from an input slot or moves them to another machine", () => {
    let state = createInitialState();
    state.tray.iron_ore = 0;
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 300, y: 0 });
    const [source, target] = state.entities.filter((entity) => entity.buildingId === "arc_smelter");
    source.inputs.iron_ore = 8;

    state = pickFromEntityInput(state, source.id, "iron_ore", 3);
    expect(state.cargo).toMatchObject({ itemId: "iron_ore", amount: 3, origin: { kind: "node-input", id: source.id } });
    expect(state.entities.find((entity) => entity.id === source.id)?.inputs.iron_ore).toBe(5);

    state = moveEntityInputToEntity(state, source.id, target.id, "iron_ore");
    expect(state.entities.find((entity) => entity.id === source.id)?.inputs.iron_ore).toBe(0);
    expect(state.entities.find((entity) => entity.id === target.id)?.inputs.iron_ore).toBe(5);

    state = moveEntityInputToTray(state, target.id, "iron_ore");
    expect(state.entities.find((entity) => entity.id === target.id)?.inputs.iron_ore).toBe(0);
    expect(state.tray.iron_ore).toBe(5);
  });

  it("places and installs exact building batches", () => {
    let state = createInitialState();
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
    const wind = state.entities.find((entity) => entity.buildingId === "wind_turbine")!;
    expect(wind.machineCount).toBe(2);
    expect(state.construction.wind_turbine).toBe(1);

    const unchanged = placeBuilding(state, "arc_smelter", { x: 200, y: 0 }, 5);
    expect(unchanged).toBe(state);
    expect(unchanged.entities.filter((entity) => entity.buildingId === "arc_smelter")).toHaveLength(0);

    state = installMiner(state, "vein_iron", 2);
    expect(state.entities.find((entity) => entity.id === "vein_iron")?.minerCount).toBe(2);
    expect(state.construction.mining_machine).toBe(0);
  });

  it("adds one unit to existing machine and miner groups from construction stock", () => {
    let state = createInitialState();
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    expect(assembler.machineCount).toBe(1);
    expect(state.construction.assembling_machine_mk1).toBe(2);

    state = addUnitToEntityGroup(state, assembler.id);
    expect(state.entities.find((entity) => entity.id === assembler.id)?.machineCount).toBe(2);
    expect(state.construction.assembling_machine_mk1).toBe(1);

    state = addUnitToEntityGroup(state, "vein_iron");
    expect(state.entities.find((entity) => entity.id === "vein_iron")?.minerCount).toBe(1);
    expect(state.construction.mining_machine).toBe(1);

    const withoutStock = {
      ...state,
      construction: { ...state.construction, assembling_machine_mk1: 0 },
    };
    expect(addUnitToEntityGroup(withoutStock, assembler.id)).toBe(withoutStock);
  });

  it("discards one construction stack without touching automation, tasks or placed entities", () => {
    let state = createInitialState();
    state = setConstructionAutomationTarget(state, "conveyor_belt_mk1", 100);
    state.construction.conveyor_belt_mk1 = 99;
    const original = state;
    const entityIds = state.entities.map((entity) => entity.id);
    const queue = structuredClone(state.constructionQueue);

    state = discardConstructionInventory(state, "conveyor_belt_mk1");

    expect(state).not.toBe(original);
    expect(original.construction.conveyor_belt_mk1).toBe(99);
    expect(state.construction.conveyor_belt_mk1).toBe(0);
    expect(state.constructionAutomation.targetStock.conveyor_belt_mk1).toBe(100);
    expect(state.constructionQueue).toEqual(queue);
    expect(state.entities.map((entity) => entity.id)).toEqual(entityIds);
    expect(discardConstructionInventory(state, "conveyor_belt_mk1")).toBe(state);
  });

  it("queues a prerequisite chain and automatically advances research", () => {
    let state = createInitialState();
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = placeBuilding(state, "wind_turbine", { x: 100, y: 0 });
    state = placeBuilding(state, "matrix_lab", { x: 300, y: 0 });
    const lab = state.entities.find((entity) => entity.buildingId === "matrix_lab")!;
    state = setEntityRecipe(state, lab.id, "matrix_research");

    expect(canQueueTechnology(state, "electromagnetic_matrix")).toBe(true);
    state = selectTechnology(state, "electromagnetic_matrix");
    expect(canQueueTechnology(state, "electromagnetism")).toBe(true);
    state = selectTechnology(state, "electromagnetism");
    expect(canQueueTechnology(state, "basic_logistics")).toBe(true);
    state = selectTechnology(state, "basic_logistics");
    expect(state.research.queuedTechIds).toEqual(["electromagnetism", "basic_logistics"]);

    state.entities.find((entity) => entity.id === lab.id)!.inputs.electromagnetic_matrix = 16;
    state = advanceSimulation(state, 24);
    expect(state.research.completedTechIds).toEqual(expect.arrayContaining(["electromagnetic_matrix", "electromagnetism"]));
    expect(state.research.selectedTechId).toBe("basic_logistics");
    expect(state.research.queuedTechIds).toEqual([]);

    state = advanceSimulation(state, 24);
    expect(state.research.completedTechIds).toContain("basic_logistics");
    expect(state.research.selectedTechId).toBeNull();
  });

  it("pauses or cancels active research without losing invested matrices", () => {
    let state = createInitialState();
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
    state = placeBuilding(state, "matrix_lab", { x: 300, y: 0 });
    const labId = state.entities.find((entity) => entity.buildingId === "matrix_lab")!.id;
    state = setEntityRecipe(state, labId, "matrix_research");
    state = selectTechnology(state, "electromagnetic_matrix");
    state = selectTechnology(state, "electromagnetism");
    state.entities.find((entity) => entity.id === labId)!.inputs.electromagnetic_matrix = 8;
    state = advanceSimulation(state, 5);
    const invested = state.research.progressByTech.electromagnetic_matrix?.electromagnetic_matrix ?? 0;
    const remainingInput = state.entities.find((entity) => entity.id === labId)!.inputs.electromagnetic_matrix ?? 0;
    expect(invested).toBeGreaterThan(0);

    state = pauseCurrentResearch(state);
    expect(state.research).toMatchObject({ selectedTechId: null, pausedTechId: "electromagnetic_matrix", queuedTechIds: ["electromagnetism"] });
    state = advanceSimulation(state, 30);
    expect(state.research.progressByTech.electromagnetic_matrix?.electromagnetic_matrix).toBe(invested);
    expect(state.entities.find((entity) => entity.id === labId)!.inputs.electromagnetic_matrix).toBe(remainingInput);
    expect(state.research.selectedTechId).toBeNull();

    state = resumePausedResearch(state);
    expect(state.research).toMatchObject({ selectedTechId: "electromagnetic_matrix", pausedTechId: null });
    state = cancelCurrentResearch(state);
    expect(state.research).toMatchObject({ selectedTechId: null, pausedTechId: null, queuedTechIds: ["electromagnetism"] });
    expect(state.research.progressByTech.electromagnetic_matrix?.electromagnetic_matrix).toBe(invested);
    state = advanceSimulation(state, 30);
    expect(state.research.selectedTechId).toBeNull();
    expect(state.research.queuedTechIds).toEqual(["electromagnetism"]);
    state = selectTechnology(state, "electromagnetic_matrix");
    expect(state.research.selectedTechId).toBe("electromagnetic_matrix");
    expect(state.research.progressByTech.electromagnetic_matrix?.electromagnetic_matrix).toBe(invested);
  });

  it("starts the first currently researchable queued technology after cancellation", () => {
    const source = createInitialState();
    source.research.completedTechIds = ["electromagnetic_matrix"];
    source.research.selectedTechId = "thermal_power";
    source.research.queuedTechIds = ["electromagnetism", "basic_logistics"];

    const next = cancelCurrentResearch(source);

    expect(next.research.selectedTechId).toBe("electromagnetism");
    expect(next.research.queuedTechIds).toEqual(["basic_logistics"]);
    expect(source.research.selectedTechId).toBe("thermal_power");
  });

  it("keeps blocked queued research in order while starting a later valid item", () => {
    const source = createInitialState();
    source.research.completedTechIds = ["electromagnetic_matrix"];
    source.research.selectedTechId = "thermal_power";
    source.research.queuedTechIds = ["basic_logistics", "electromagnetism"];

    const next = cancelCurrentResearch(source);

    expect(next.research.selectedTechId).toBe("electromagnetism");
    expect(next.research.queuedTechIds).toEqual(["basic_logistics"]);
  });

  it("stays idle only when every queued technology is currently blocked", () => {
    const source = createInitialState();
    source.research.selectedTechId = "electromagnetic_matrix";
    source.research.queuedTechIds = ["basic_logistics"];

    const next = cancelCurrentResearch(source);

    expect(next.research.selectedTechId).toBeNull();
    expect(next.research.queuedTechIds).toEqual(["basic_logistics"]);
  });

  it("can leave infinite research and start a valid finite queue item", () => {
    const source = createInitialState();
    source.research.completedTechIds = ["electromagnetic_matrix"];
    source.research.queuedTechIds = ["electromagnetism"];
    source.endgame.activeInfiniteResearchId = "matrix_compression";

    const next = cancelCurrentResearch(source);

    expect(next.endgame.activeInfiniteResearchId).toBeNull();
    expect(next.research.selectedTechId).toBe("electromagnetism");
    expect(next.research.queuedTechIds).toEqual([]);
  });

  it("removes queued technologies that lose a queued prerequisite", () => {
    let state = createInitialState();
    state = selectTechnology(state, "electromagnetic_matrix");
    state = selectTechnology(state, "electromagnetism");
    state = selectTechnology(state, "basic_logistics");
    state = removeQueuedTechnology(state, "electromagnetism");
    expect(state.research.queuedTechIds).toEqual([]);
  });

  it("keeps planetary power grids independent", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.wind_turbine = 3;
    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    smelter.inputs.iron_ore = 2;
    state = setActivePlanet(state, "home");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = advanceSimulation(state, 2.1);

    expect(state.entities.find((entity) => entity.id === smelter.id)?.outputs.iron_ingot ?? 0).toBe(0);
    expect(state.planetMetrics.home.generationKw).toBe(300);
    expect(state.planetMetrics.ashen.generationKw).toBe(0);
    expect(state.planetMetrics.ashen.powerFactor).toBe(0);

    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "wind_turbine", { x: 200, y: 0 }, 2);
    state = advanceSimulation(state, 1.1);
    expect(state.entities.find((entity) => entity.id === smelter.id)?.outputs.iron_ingot).toBe(1);
    expect(state.planetMetrics.ashen.generationKw).toBe(600);
  });

  it("keeps a fully supplied miner's device power factor synchronized with its grid", () => {
    let state = createInitialState();
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
    state = installMiner(state, "vein_iron", 1);
    state = advanceSimulation(state, 1);
    let miner = state.entities.find((entity) => entity.id === "vein_iron")!;
    expect(state.powerGridMetrics.home[miner.powerGridId ?? "grid-a"].powerFactor).toBe(1);
    expect(miner.powerFactor).toBe(1);
    expect(getEntityPowerFactor(state, miner)).toBe(1);
    expect(miner.utilization).toBe(1);

    miner.outputs.iron_ore = 10_000;
    state = advanceSimulation(state, 1);
    miner = state.entities.find((entity) => entity.id === "vein_iron")!;
    expect(state.powerGridMetrics.home[miner.powerGridId ?? "grid-a"].powerFactor).toBe(1);
    expect(getEntityPowerFactor(state, miner)).toBe(1);
    expect(miner.utilization).toBe(0);
  });

  it("keeps trays local while hand-carrying one stack between planets", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.tray.titanium_ingot = 5;
    state.cargo = { itemId: "iron_ingot", amount: 3, origin: { kind: "tray" } };
    state = setActivePlanet(state, "ashen");

    expect(state.cargo).toMatchObject({ itemId: "iron_ingot", amount: 3 });
    expect(state.tray.titanium_ingot ?? 0).toBe(0);
    expect(state.planetTrays.home).toMatchObject({ titanium_ingot: 5 });
    expect(state.planetTrays.home.iron_ingot ?? 0).toBe(0);
    state = dropCargoToTray(state);
    expect(state.cargo).toBeNull();
    expect(state.tray.iron_ingot).toBe(3);
    state.tray.coal = 2;
    state = setActivePlanet(state, "home");
    expect(state.tray).toMatchObject({ titanium_ingot: 5 });
    expect(state.tray.iron_ingot ?? 0).toBe(0);
    expect(state.tray.coal ?? 0).toBe(0);
    expect(state.planetTrays.ashen).toMatchObject({ coal: 2, iron_ingot: 3 });
  });

  it("ships integer cargo between paired interstellar stations", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.wind_turbine = 8;
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const supplyId = state.entities.find((entity) => entity.kind === "station")!.id;
    state = setLogisticsItem(state, supplyId, "titanium_ingot");
    state.entities.find((entity) => entity.id === supplyId)!.outputs.titanium_ingot = 140;

    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const demandId = state.entities.find((entity) => entity.kind === "station" && entity.id !== supplyId)!.id;
    state = setLogisticsItem(state, demandId, "titanium_ingot");
    state = setStationMode(state, demandId, "demand");
    expect(getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === demandId)!).code).toBe("missing-vessel");
    state.portableFleet.logistics_vessel = 1;
    state = adjustStationVessels(state, demandId, 1);
    const expectedTripSeconds = getInterstellarRouteEconomics(
      state,
      state.entities.find((entity) => entity.id === supplyId)!,
      state.entities.find((entity) => entity.id === demandId)!,
      1,
    ).durationSeconds;
    state = advanceSimulation(state, 15);

    expect(state.entities.find((entity) => entity.id === demandId)?.outputs.titanium_ingot ?? 0).toBe(0);
    expect(state.entities.find((entity) => entity.id === demandId)?.stationProgress).toBeCloseTo(15 / expectedTripSeconds, 3);
    expect(state.entities.find((entity) => entity.id === demandId)?.stationRoutes?.[0]).toMatchObject({ requiresWarp: false, warpersPerVessel: 0 });
    expect(state.entities.find((entity) => entity.id === demandId)?.stationWarpers ?? 0).toBe(0);

    state = advanceSimulation(state, Math.ceil(expectedTripSeconds - 15) + 1);
    const supply = state.entities.find((entity) => entity.id === supplyId)!;
    const demand = state.entities.find((entity) => entity.id === demandId)!;
    expect(supply.outputs.titanium_ingot).toBe(40);
    expect(demand.outputs.titanium_ingot).toBe(100);
    expect(demand.stationTrips).toBe(1);
    expect(demand.stationLastTransfer).toBe(100);
    expect(Number.isInteger(demand.outputs.titanium_ingot)).toBe(true);
  });

  it("keeps same-system supply-owned vessel routes free of warper reservation and consumption", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics", "space_warp");
    state.exploration.colonizedPlanetIds.push("ashen");
    state.construction.wind_turbine = 8;
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const supply = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, supply.id, "processor");
    state.entities.find((entity) => entity.id === supply.id)!.outputs.processor = 100;
    state.portableFleet.logistics_vessel = 1;
    state.tray.space_warper = 3;
    state = adjustStationVessels(state, supply.id, 1);
    state = adjustStationWarpers(state, supply.id, 3);

    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const demand = state.entities.find((entity) => entity.planetId === "ashen" && entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, demand.id, "processor");
    state = setStationMode(state, demand.id, "demand");
    state = advanceSimulation(state, 0.1);

    const route = state.entities.find((entity) => entity.id === demand.id)?.stationRoutes?.[0];
    expect(route).toMatchObject({ vehicleStationId: supply.id, requiresWarp: false, warpersPerVessel: 0 });
    expect(state.entities.find((entity) => entity.id === supply.id)?.stationWarpers).toBe(3);
  });

  it("preserves legacy station progress when dispatching the first migrated route", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.wind_turbine = 8;
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const supplyId = state.entities.find((entity) => entity.kind === "station")!.id;
    state = setLogisticsItem(state, supplyId, "titanium_ingot");
    state.entities.find((entity) => entity.id === supplyId)!.outputs.titanium_ingot = 100;

    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const demandId = state.entities.find((entity) => entity.kind === "station" && entity.id !== supplyId)!.id;
    state = setLogisticsItem(state, demandId, "titanium_ingot");
    state = setStationMode(state, demandId, "demand");
    state.portableFleet.logistics_vessel = 1;
    state = adjustStationVessels(state, demandId, 1);
    state.entities.find((entity) => entity.id === demandId)!.stationProgress = 0.99;

    state = advanceSimulation(state, 1);

    const demand = state.entities.find((entity) => entity.id === demandId)!;
    expect(demand.outputs.titanium_ingot).toBe(100);
    expect(demand.stationTrips).toBe(1);
    expect(demand.stationRoutes).toEqual([]);
  });

  it("uses a warper and the warp flight time for cargo sent between star systems", () => {
    let state = createInitialState();
    state.exploration.unlockedSystemIds.push("borealis");
    state.research.completedTechIds.push("space_warp");
    state.construction.wind_turbine = 8;
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const supplyId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!.id;
    state = setLogisticsItem(state, supplyId, "optical_grating_crystal");
    state.entities.find((entity) => entity.id === supplyId)!.outputs.optical_grating_crystal = 100;

    state = setActivePlanet(state, "frost");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const demandId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station" && entity.id !== supplyId)!.id;
    state = setLogisticsItem(state, demandId, "optical_grating_crystal");
    state = setStationMode(state, demandId, "demand");
    state.portableFleet.logistics_vessel = 1;
    state.tray.space_warper = 1;
    state = adjustStationVessels(state, demandId, 1);
    state = adjustStationWarpers(state, demandId, 1);

    state = advanceSimulation(state, 11.5);
    expect(state.entities.find((entity) => entity.id === demandId)?.outputs.optical_grating_crystal ?? 0).toBe(0);
    state = advanceSimulation(state, 0.6);
    const demand = state.entities.find((entity) => entity.id === demandId)!;
    expect(demand.outputs.optical_grating_crystal).toBe(100);
    expect(demand.stationWarpers).toBe(0);
    expect(demand.stationTrips).toBe(1);
  });

  it("routes long-haul cargo through a powered hub within the per-vessel warper budget", () => {
    let state = createInitialState();
    state.exploration.unlockedSystemIds.push("aurora", "sirius");
    state.exploration.colonizedPlanetIds.push("verdant", "crystal");
    state.research.completedTechIds.push("space_warp");
    state.construction.wind_turbine = 60;
    state.construction.interstellar_logistics_station = 3;

    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 20);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const supplyId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!.id;
    state = setLogisticsItem(state, supplyId, "processor");
    state.entities.find((entity) => entity.id === supplyId)!.outputs.processor = 100;

    state = setActivePlanet(state, "verdant");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 20);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const hubId = state.entities.find((entity) => entity.planetId === "verdant" && entity.buildingId === "interstellar_logistics_station")!.id;

    state = setActivePlanet(state, "crystal");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 20);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const demandId = state.entities.find((entity) => entity.planetId === "crystal" && entity.buildingId === "interstellar_logistics_station")!.id;
    state = setLogisticsItem(state, demandId, "processor");
    state = setStationMode(state, demandId, "demand");
    state = setStationSlotRoutePolicy(state, demandId, 0, "relay-required");
    state = setStationSlotWarperBudget(state, demandId, 0, 2);
    state.portableFleet.logistics_vessel = 1;
    state.tray.space_warper = 2;
    state = adjustStationVessels(state, demandId, 1);
    state = adjustStationWarpers(state, demandId, 2);

    expect(getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === demandId)!).code).toBe("missing-hub");
    state = setStationHubConfiguration(state, hubId, true, 2);
    const economics = getInterstellarRouteEconomics(
      state,
      state.entities.find((entity) => entity.id === supplyId)!,
      state.entities.find((entity) => entity.id === demandId)!,
      1,
      { routePolicy: "relay-required", warperBudget: 2 },
    );
    expect(economics).toMatchObject({ routeAvailable: true, routeKind: "relay", waypointStationIds: [hubId], hopCount: 2, warpersPerVessel: 2 });

    state = advanceSimulation(state, 0.1);
    const activeRoute = state.entities.find((entity) => entity.id === demandId)!.stationRoutes?.[0];
    expect(activeRoute).toMatchObject({ waypointStationIds: [hubId], warpersPerVessel: 2 });
    expect(state.entities.find((entity) => entity.id === demandId)?.stationWarpers).toBe(0);
    state.entities.find((entity) => entity.id === demandId)!.stationWarpers = 50;
    const cancelled = removeEntity(state, hubId);
    expect(cancelled.entities.find((entity) => entity.id === demandId)?.stationRoutes).toEqual([]);
    expect(cancelled.entities.find((entity) => entity.id === demandId)?.stationWarpers).toBe(50);
    expect(cancelled.tray.space_warper).toBe(2);
    state = advanceSimulation(state, economics.durationSeconds + 1);
    expect(state.entities.find((entity) => entity.id === demandId)?.outputs.processor).toBe(100);
  });

  it("respects minimum vessel loads, dispatches multiple vessels and returns the fleet", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.wind_turbine = 8;
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const supplyId = state.entities.find((entity) => entity.kind === "station")!.id;
    state = setLogisticsItem(state, supplyId, "processor");
    state.entities.find((entity) => entity.id === supplyId)!.outputs.processor = 40;

    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const demandId = state.entities.find((entity) => entity.kind === "station" && entity.id !== supplyId)!.id;
    state = setLogisticsItem(state, demandId, "processor");
    state = setStationMode(state, demandId, "demand");
    state.portableFleet.logistics_vessel = 3;
    state = adjustStationVessels(state, demandId, 10);
    expect(state.entities.find((entity) => entity.id === demandId)?.stationVessels).toBe(3);
    expect(getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === demandId)!).code).toBe("waiting-load");

    state = setStationMinimumLoad(state, demandId, 0.5);
    state.entities.find((entity) => entity.id === supplyId)!.outputs.processor = 250;
    state = advanceSimulation(state, 31);
    const demand = state.entities.find((entity) => entity.id === demandId)!;
    expect(demand.outputs.processor).toBe(250);
    expect(demand.stationTrips).toBe(3);
    expect(demand.stationLastTransfer).toBe(250);

    state = removeEntity(state, demandId);
    expect(state.portableFleet.logistics_vessel).toBe(3);
  });

  it("manufactures an interstellar station only after its advanced logistics technology", () => {
    let state = createInitialState();
    state.tray = { steel: 30, titanium_alloy: 40, processor: 20 };
    expect(craftConstruction(state, "interstellar_logistics_station")).toBe(state);
    state.research.completedTechIds.push("interstellar_logistics");
    state = craftConstruction(state, "interstellar_logistics_station");
    expect(state.construction.interstellar_logistics_station).toBe(1);
    expect(state.tray).toMatchObject({ steel: 0, titanium_alloy: 0, processor: 0 });
  });

  it("manufactures a particle collider only after its information-era technology", () => {
    let state = createInitialState();
    state.tray = { titanium_alloy: 20, processor: 20, super_magnetic_ring: 20, graphene: 20 };
    expect(craftConstruction(state, "miniature_particle_collider")).toBe(state);
    state.research.completedTechIds.push("miniature_particle_collider");
    state = craftConstruction(state, "miniature_particle_collider");
    expect(state.construction.miniature_particle_collider).toBe(1);
    expect(state.tray).toMatchObject({ titanium_alloy: 0, processor: 0, super_magnetic_ring: 0, graphene: 0 });
  });

  it("launches whole solar sails and decays the Dyson swarm in integer units", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_swarm");
    state.construction.wind_turbine = 6;
    state.construction.em_rail_ejector = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 6);
    state = placeBuilding(state, "em_rail_ejector", { x: 300, y: 0 });
    const ejector = state.entities.find((entity) => entity.buildingId === "em_rail_ejector")!;
    state = setEntityRecipe(state, ejector.id, "solar_sail_launch");
    state.entities.find((entity) => entity.id === ejector.id)!.inputs.solar_sail = 3;
    state = advanceSimulation(state, 36);

    expect(state.dysonSwarm.sailsInOrbit).toBe(3);
    expect(state.dysonSwarm.totalLaunched).toBe(3);
    expect(state.dysonSwarm.generationKw).toBe(3 * SOLAR_SAIL_POWER_KW);
    expect(Number.isInteger(state.dysonSwarm.sailsInOrbit)).toBe(true);
    expect(state.entities.find((entity) => entity.id === ejector.id)?.inputs.solar_sail).toBe(0);

    state.dysonSwarm.sailsInOrbit = 10;
    state.dysonSwarm.totalLaunched = 10;
    state.dysonSwarm.totalExpired = 0;
    state.dysonSwarm.decayProgress = 0;
    state = advanceSimulation(state, 120);
    expect(state.dysonSwarm.sailsInOrbit).toBe(9);
    expect(state.dysonSwarm.totalExpired).toBe(1);
    expect(state.dysonSwarm.generationKw).toBe(9 * SOLAR_SAIL_POWER_KW);
    expect(Number.isInteger(state.dysonSwarm.totalExpired)).toBe(true);
  });

  it("throttles and pauses Dyson launches while tracking per-launch energy cost", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_swarm");
    state.construction.wind_turbine = 8;
    state.construction.em_rail_ejector = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 8);
    state = placeBuilding(state, "em_rail_ejector", { x: 300, y: 0 });
    const ejector = state.entities.find((entity) => entity.buildingId === "em_rail_ejector")!;
    state = setEntityRecipe(state, ejector.id, "solar_sail_launch");
    state.entities.find((entity) => entity.id === ejector.id)!.inputs.solar_sail = 4;

    state = setDysonLaunchMode(state, "sphere");
    state = advanceSimulation(state, 24);
    expect(state.dysonSwarm.sailsInOrbit).toBe(0);
    expect(getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === ejector.id)!)).toMatchObject({ code: "launch-paused" });

    state = setDysonLaunchMode(state, "balanced");
    state = setDysonLaunchThrottle(state, 0.25);
    state = advanceSimulation(state, 48);
    expect(state.dysonSwarm.sailsInOrbit).toBe(1);
    expect(state.dysonEngineering.orbitsBySystem.helios[0].sailsInOrbit).toBe(1);
    expect(state.dysonEngineering.launchEnergySpentMj).toBe(DYSON_SAIL_LAUNCH_ENERGY_MJ);
    expect(getDysonEngineeringSnapshot(state, "helios")).toMatchObject({
      launchThrottle: 0.25,
      sailLaunchesPerMinute: 1.25,
      launchEnergyPerSailMj: DYSON_SAIL_LAUNCH_ENERGY_MJ,
      launchEnergyPerRocketMj: DYSON_ROCKET_LAUNCH_ENERGY_MJ,
    });

    state = setDysonLaunchEnabled(state, false);
    state = advanceSimulation(state, 48);
    expect(state.dysonSwarm.sailsInOrbit).toBe(1);
    expect(state.entities.find((entity) => entity.id === ejector.id)?.inputs.solar_sail).toBe(3);
  });

  it("keeps solar-sail orbits and ray reception inside their star system", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_swarm", "ray_receiver");
    state.exploration.unlockedSystemIds.push("borealis");
    state = setActivePlanet(state, "frost");
    state.construction.wind_turbine = 8;
    state.construction.em_rail_ejector = 1;
    state.construction.ray_receiver = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 8);
    state = placeBuilding(state, "em_rail_ejector", { x: 300, y: 0 });
    state = placeBuilding(state, "ray_receiver", { x: 600, y: 0 });
    const ejector = state.entities.find((entity) => entity.planetId === "frost" && entity.buildingId === "em_rail_ejector")!;
    state.entities.find((entity) => entity.id === ejector.id)!.inputs.solar_sail = 2;

    state = addDysonSwarmOrbit(state, "borealis");
    const activeOrbitId = state.dysonEngineering.activeOrbitBySystem.borealis!;
    state = setDysonSwarmOrbit(state, "borealis", activeOrbitId, { radius: 28_000, inclination: 31, longitude: 122 });
    state = setEjectorTargetOrbit(state, ejector.id, activeOrbitId);
    state = advanceSimulation(state, 24);
    expect(state.dysonEngineering.orbitsBySystem.borealis.find((orbit) => orbit.id === activeOrbitId)).toMatchObject({
      radius: 28_000,
      inclination: 31,
      longitude: 122,
      sailsInOrbit: 2,
    });
    state = advanceSimulation(state, 0.1);
    expect(state.planetMetrics.frost.rayGenerationKw).toBe(2 * SOLAR_SAIL_POWER_KW * getStarLuminosity(state, "borealis"));

    state = setActivePlanet(state, "home");
    state = placeBuilding(state, "ray_receiver", { x: 300, y: 0 });
    state = advanceSimulation(state, 0.1);
    expect(state.planetMetrics.home.rayGenerationKw).toBe(0);
    expect(state.planetMetrics.frost.rayGenerationKw).toBe(2 * SOLAR_SAIL_POWER_KW * getStarLuminosity(state, "borealis"));
    expect(getDysonEngineeringSnapshot(state, "borealis")).toMatchObject({ orbitCount: 2, orbitSails: 2 });

    state = setActiveDysonSwarmOrbit(state, "borealis", state.dysonEngineering.orbitsBySystem.borealis[0].id);
    state = removeDysonSwarmOrbit(state, "borealis", activeOrbitId);
    expect(state.dysonEngineering.orbitsBySystem.borealis).toHaveLength(1);
    expect(state.dysonEngineering.orbitsBySystem.borealis[0].sailsInOrbit).toBe(2);
  });

  it("keeps explicit ejector orbit targets stable, blocks deleted targets, and round-trips them through blueprints", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_swarm");
    state.construction.wind_turbine = 12;
    state.construction.em_rail_ejector = 4;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 12);
    state = addDysonSwarmOrbit(state, "helios");
    const targetOrbitId = state.dysonEngineering.activeOrbitBySystem.helios!;
    state = setActiveDysonSwarmOrbit(state, "helios", state.dysonEngineering.orbitsBySystem.helios[0].id);
    state = placeBuilding(state, "em_rail_ejector", { x: 300, y: 0 });
    state = placeBuilding(state, "em_rail_ejector", { x: 300, y: 180 });
    const ejectors = state.entities.filter((entity) => entity.buildingId === "em_rail_ejector");
    state = setEjectorTargetOrbitForEntities(state, ejectors.map((entity) => entity.id), targetOrbitId);
    expect(ejectors.every((entity) => entity.targetDysonOrbitId !== targetOrbitId)).toBe(true);
    expect(state.entities.filter((entity) => entity.buildingId === "em_rail_ejector").every((entity) => entity.targetDysonOrbitId === targetOrbitId)).toBe(true);

    const firstId = ejectors[0].id;
    state.entities.find((entity) => entity.id === firstId)!.inputs.solar_sail = 2;
    state = advanceSimulation(state, 24);
    expect(state.dysonEngineering.orbitsBySystem.helios.find((orbit) => orbit.id === targetOrbitId)?.sailsInOrbit).toBe(2);

    state = createBlueprint(state, [firstId], "定轨弹射器");
    expect(state.blueprints.at(-1)?.entities[0].targetDysonOrbitId).toBe(targetOrbitId);
    state = removeDysonSwarmOrbit(state, "helios", targetOrbitId);
    const blockedBefore = state.entities.find((entity) => entity.id === firstId)!;
    blockedBefore.inputs.solar_sail = 3;
    blockedBefore.progress = 0.625;
    const launchedBefore = state.dysonSwarm.totalLaunched;
    const deterministicInput = structuredClone(state);
    state = advanceSimulation(state, 60);
    expect(advanceSimulation(deterministicInput, 60)).toEqual(state);
    const blockedAfter = state.entities.find((entity) => entity.id === firstId)!;
    expect(blockedAfter.inputs.solar_sail).toBe(3);
    expect(blockedAfter.progress).toBe(0.625);
    expect(state.dysonSwarm.totalLaunched).toBe(launchedBefore);
    expect(getEjectorOrbitTargetStatus(state, blockedAfter)).toMatchObject({ valid: false, reason: "missing-orbit" });
    expect(getEntityOperatingStatus(state, blockedAfter)).toMatchObject({ code: "missing-dyson-orbit", tone: "blocked" });

    state.construction.em_rail_ejector = 1;
    const blueprintId = state.blueprints.at(-1)!.id;
    state = placeBlueprint(state, blueprintId, { x: 700, y: 0 });
    const pasted = state.entities.filter((entity) => entity.buildingId === "em_rail_ejector").at(-1)!;
    expect(pasted.targetDysonOrbitId).toBe(targetOrbitId);
    expect(getEjectorOrbitTargetStatus(state, pasted).reason).toBe("missing-orbit");
  });

  it("scales solar panels and each independent Dyson plan by its host star luminosity", () => {
    let state = createInitialState();
    state.exploration.unlockedSystemIds.push("borealis");
    state.exploration.colonizedPlanetIds.push("frost");
    state.construction.solar_panel = 2;
    state = placeBuilding(state, "solar_panel", { x: 0, y: 0 });
    state = setActivePlanet(state, "frost");
    state = placeBuilding(state, "solar_panel", { x: 0, y: 0 });
    state = advanceSimulation(state, 0.1);

    const rated = getBuilding("solar_panel").powerGenerationKw!;
    expect(state.planetMetrics.home.solarGenerationKw).toBe(rated * getPlanetSolarPowerMultiplier(state, "home"));
    expect(state.planetMetrics.frost.solarGenerationKw).toBe(rated * getPlanetSolarPowerMultiplier(state, "frost"));

    state.dysonPlans.helios.structurePoints = 10;
    state.dysonPlans.borealis.structurePoints = 10;
    const helios = getDysonEngineeringSnapshot(state, "helios").projectedGenerationKw;
    const borealis = getDysonEngineeringSnapshot(state, "borealis").projectedGenerationKw;
    expect(borealis / helios).toBeCloseTo(getStarLuminosity(state, "borealis") / getStarLuminosity(state, "helios"), 2);
  });

  it("extends solar-sail lifetime through both orbital endurance upgrades", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_swarm", "solar_sail_life_1", "solar_sail_life_2");
    state.dysonSwarm.sailsInOrbit = 10;
    state.dysonSwarm.totalLaunched = 10;

    expect(getSolarSailLifetimeSeconds(state)).toBe(2400);
    state = advanceSimulation(state, 120);
    expect(state.dysonSwarm.sailsInOrbit).toBe(10);
    expect(state.dysonSwarm.totalExpired).toBe(0);
    state = advanceSimulation(state, 120);
    expect(state.dysonSwarm.sailsInOrbit).toBe(9);
    expect(state.dysonSwarm.totalExpired).toBe(1);
  });

  it("shares one Dyson swarm across planets without duplicating receiver power", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("ray_receiver", "interstellar_logistics");
    state.construction.ray_receiver = 2;
    state = placeBuilding(state, "ray_receiver", { x: 0, y: 0 });
    const homeReceiver = state.entities.find((entity) => entity.buildingId === "ray_receiver")!;
    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "ray_receiver", { x: 0, y: 0 });
    const ashenReceiver = state.entities.find((entity) => entity.buildingId === "ray_receiver" && entity.id !== homeReceiver.id)!;
    state.dysonSwarm.sailsInOrbit = 100;
    state.dysonSwarm.totalLaunched = 100;
    state = advanceSimulation(state, 1);

    expect(state.dysonSwarm.generationKw).toBe(8800);
    expect(state.dysonSwarm.receiverLoadKw).toBe(8800);
    expect(state.planetMetrics.home.rayGenerationKw).toBe(4400);
    expect(state.planetMetrics.ashen.rayGenerationKw).toBe(4400);
    expect(state.entities.find((entity) => entity.id === homeReceiver.id)?.powerOutputKw).toBe(4400);
    expect(state.entities.find((entity) => entity.id === ashenReceiver.id)?.powerOutputKw).toBe(4400);
    expect(state.dysonSwarm.receiverLoadKw).toBeLessThanOrEqual(RAY_RECEIVER_CAPACITY_KW * 2);
  });

  it("switches a ray receiver between continuous power and integer critical photons", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("ray_receiver");
    state.construction.ray_receiver = 1;
    state = placeBuilding(state, "ray_receiver", { x: 0, y: 0 });
    const receiver = state.entities.find((entity) => entity.buildingId === "ray_receiver")!;
    expect(getEntityOperatingStatus(state, receiver).code).toBe("missing-dyson-swarm");

    state.dysonSwarm.sailsInOrbit = 200;
    state.dysonSwarm.totalLaunched = 200;
    state = setEntityRecipe(state, receiver.id, "critical_photon");
    state = advanceSimulation(state, 10.1);
    const photonReceiver = state.entities.find((entity) => entity.id === receiver.id)!;
    expect(photonReceiver.outputs.critical_photon).toBe(1);
    expect(Number.isInteger(photonReceiver.outputs.critical_photon)).toBe(true);
    expect(photonReceiver.powerOutputKw).toBe(RAY_RECEIVER_CAPACITY_KW);

    state = setEntityRecipe(state, receiver.id, "ray_power");
    expect(state.entities.find((entity) => entity.id === receiver.id)?.powerOutputKw).toBe(0);
    state = advanceSimulation(state, 0.1);
    const powerReceiver = state.entities.find((entity) => entity.id === receiver.id)!;
    expect(state.planetMetrics.home.rayGenerationKw).toBe(RAY_RECEIVER_CAPACITY_KW);
    expect(getEntityOperatingStatus(state, powerReceiver).code).toBe("running");
  });

  it("raises each ray receiver to twelve megawatts after both transmission upgrades", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("ray_receiver", "ray_transmission_1", "ray_transmission_2");
    state.construction.ray_receiver = 1;
    state = placeBuilding(state, "ray_receiver", { x: 0, y: 0 });
    state.dysonSphere.structurePoints = 13;
    state.dysonSphere.totalRocketsLaunched = 13;
    state = advanceSimulation(state, 0.1);

    expect(getRayReceiverCapacityKw(state)).toBe(12_000);
    expect(state.dysonSwarm.receiverLoadKw).toBe(12_000);
    expect(state.planetMetrics.home.rayGenerationKw).toBe(12_000);
    expect(state.entities.find((entity) => entity.buildingId === "ray_receiver")?.powerOutputKw).toBe(12_000);
  });

  it("runs mass-energy conversion, antimatter fuel and universe matrix recipes", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("antimatter", "universe_matrix");
    state.construction.wind_turbine = 50;
    state.construction.miniature_particle_collider = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 50);
    state = placeBuilding(state, "miniature_particle_collider", { x: 250, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 500, y: 0 });
    state = placeBuilding(state, "matrix_lab", { x: 750, y: 0 });
    const collider = state.entities.find((entity) => entity.buildingId === "miniature_particle_collider")!;
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    const lab = state.entities.find((entity) => entity.buildingId === "matrix_lab")!;

    state = setEntityRecipe(state, collider.id, "antimatter");
    state.entities.find((entity) => entity.id === collider.id)!.inputs.critical_photon = 2;
    state = advanceSimulation(state, 2.1);
    expect(state.entities.find((entity) => entity.id === collider.id)?.outputs).toMatchObject({ hydrogen: 2, antimatter: 2 });

    state = setEntityRecipe(state, assembler.id, "antimatter_fuel_rod");
    Object.assign(state.entities.find((entity) => entity.id === assembler.id)!.inputs, {
      antimatter: 10,
      hydrogen: 10,
      annihilation_constraint_sphere: 1,
      titanium_alloy: 1,
    });
    state = advanceSimulation(state, 16.1);
    expect(state.entities.find((entity) => entity.id === assembler.id)?.outputs.antimatter_fuel_rod).toBe(2);

    state = setEntityRecipe(state, lab.id, "universe_matrix");
    Object.assign(state.entities.find((entity) => entity.id === lab.id)!.inputs, {
      electromagnetic_matrix: 1,
      energy_matrix: 1,
      structure_matrix: 1,
      information_matrix: 1,
      gravity_matrix: 1,
      antimatter: 1,
    });
    state = advanceSimulation(state, 15.1);
    expect(state.entities.find((entity) => entity.id === lab.id)?.outputs.universe_matrix).toBe(1);
    expect(state.totalProduced.universe_matrix).toBe(1);
  });

  it("completes six-color research and raises lab speed to 1.75x", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("universe_matrix", "research_speed_1", "research_speed_2");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
    state = placeBuilding(state, "matrix_lab", { x: 300, y: 0 });
    const lab = state.entities.find((entity) => entity.buildingId === "matrix_lab")!;
    state = setEntityRecipe(state, lab.id, "matrix_research");
    state = selectTechnology(state, "research_speed_3");
    Object.assign(state.entities.find((entity) => entity.id === lab.id)!.inputs, {
      electromagnetic_matrix: 30,
      energy_matrix: 30,
      structure_matrix: 30,
      information_matrix: 30,
      gravity_matrix: 30,
      universe_matrix: 30,
    });
    state = advanceSimulation(state, 370);

    expect(state.research.completedTechIds).toContain("research_speed_3");
    expect(state.research.progressByTech.research_speed_3).toEqual({
      electromagnetic_matrix: 30,
      energy_matrix: 30,
      structure_matrix: 30,
      information_matrix: 30,
      gravity_matrix: 30,
      universe_matrix: 30,
    });
    expect(getRecipeSpeedMultiplier(state, "matrix_research")).toBe(1.75);
  });

  it("manufactures late Dyson components and launches whole carrier rockets", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_sphere_program", "vertical_launching_silo");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 300, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;

    state = setEntityRecipe(state, assembler.id, "frame_material");
    Object.assign(state.entities.find((entity) => entity.id === assembler.id)!.inputs, {
      carbon_nanotube: 4,
      titanium_alloy: 1,
      high_purity_silicon: 1,
    });
    state = advanceSimulation(state, 8);
    expect(state.entities.find((entity) => entity.id === assembler.id)?.outputs.frame_material).toBe(1);

    state = setEntityRecipe(state, assembler.id, "dyson_sphere_component");
    Object.assign(state.entities.find((entity) => entity.id === assembler.id)!.inputs, {
      frame_material: 3,
      solar_sail: 3,
      processor: 3,
    });
    state = advanceSimulation(state, 10.7);
    expect(state.entities.find((entity) => entity.id === assembler.id)?.outputs.dyson_sphere_component).toBe(1);

    state = setEntityRecipe(state, assembler.id, "small_carrier_rocket");
    Object.assign(state.entities.find((entity) => entity.id === assembler.id)!.inputs, {
      dyson_sphere_component: 2,
      deuteron_fuel_rod: 4,
      quantum_chip: 2,
    });
    state = advanceSimulation(state, 8);
    expect(state.entities.find((entity) => entity.id === assembler.id)?.outputs.small_carrier_rocket).toBe(1);
    expect(state.totalProduced.small_carrier_rocket).toBe(1);

    state.construction.wind_turbine = 60;
    state.construction.vertical_launching_silo = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 200 }, 60);
    state = placeBuilding(state, "vertical_launching_silo", { x: 600, y: 0 });
    const silo = state.entities.find((entity) => entity.buildingId === "vertical_launching_silo")!;
    state.entities.find((entity) => entity.id === silo.id)!.inputs.small_carrier_rocket = 1;
    state = advanceSimulation(state, 6);

    expect(state.entities.find((entity) => entity.id === silo.id)?.inputs.small_carrier_rocket).toBe(0);
    expect(state.dysonSphere.structurePoints).toBe(1);
    expect(state.dysonSphere.totalRocketsLaunched).toBe(1);
    expect(state.dysonSphere.generationKw).toBe(DYSON_STRUCTURE_POWER_KW);
    expect(Number.isInteger(state.dysonSphere.structurePoints)).toBe(true);
  });

  it("manufactures a vertical silo only after its late-game technology", () => {
    let state = createInitialState();
    state.tray = {
      steel: 80,
      titanium_alloy: 80,
      frame_material: 30,
      graviton_lens: 20,
      quantum_chip: 10,
    };
    expect(craftConstruction(state, "vertical_launching_silo")).toBe(state);
    state.research.completedTechIds.push("vertical_launching_silo");
    state = craftConstruction(state, "vertical_launching_silo");
    expect(state.construction.vertical_launching_silo).toBe(1);
    expect(state.tray).toMatchObject({
      steel: 0,
      titanium_alloy: 0,
      frame_material: 0,
      graviton_lens: 0,
      quantum_chip: 0,
    });
  });

  it("creates an eight-node standard Dyson layer with closed frames and shell sectors", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_sphere_program", "dyson_shell");
    state = createStandardDysonLayer(state, "helios");

    const layer = state.dysonPlans.helios.layers[0];
    expect(layer.nodes).toHaveLength(8);
    expect(layer.frames).toHaveLength(8);
    expect(layer.shells).toHaveLength(8);
    expect(getDysonPlanTotals(state.dysonPlans.helios)).toMatchObject({
      layerCount: 1,
      nodeCount: 8,
      frameCount: 8,
      shellCount: 8,
      plannedStructure: 16,
      completedStructure: 0,
      sailCapacity: 0,
    });
  });

  it("copies a Dyson shell design into another system without copying progress or IDs", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_sphere_program", "dyson_shell");
    state.exploration.unlockedSystemIds.push("borealis");
    state = createStandardDysonLayer(state, "helios");
    const source = state.dysonPlans.helios.layers[0];
    const template = createDysonLayerTemplate(source);
    const result = pasteDysonLayerTemplate(state, "borealis", template);

    expect(result.error).toBeUndefined();
    expect(result.state).not.toBe(state);
    const pasted = result.state.dysonPlans.borealis.layers[0];
    expect(pasted.name).toBe(`${source.name} 副本`);
    expect(pasted.nodes).toHaveLength(source.nodes.length);
    expect(pasted.frames).toHaveLength(source.frames.length);
    expect(pasted.shells).toHaveLength(source.shells.length);
    expect(pasted.nodes.every((node) => node.completedStructurePoints === 0)).toBe(true);
    expect(pasted.frames.every((frame) => frame.completedStructurePoints === 0)).toBe(true);
    expect(pasted.shells.every((shell) => shell.absorbedSails === 0)).toBe(true);
    expect(new Set([...source.nodes, ...source.frames, ...source.shells].map((entry) => entry.id)).size +
      new Set([...pasted.nodes, ...pasted.frames, ...pasted.shells].map((entry) => entry.id)).size).toBe(
      new Set([...source.nodes, ...source.frames, ...source.shells, ...pasted.nodes, ...pasted.frames, ...pasted.shells].map((entry) => entry.id)).size,
    );
    expect(state.dysonPlans.borealis.layers).toHaveLength(0);
  });

  it("pastes over historical target surplus without assigning that surplus to the copy", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_sphere_program", "dyson_shell");
    state.exploration.unlockedSystemIds.push("borealis");
    state = createStandardDysonLayer(state, "helios");
    state.dysonPlans.borealis.structurePoints = 1;
    const result = pasteDysonLayerTemplate(state, "borealis", createDysonLayerTemplate(state.dysonPlans.helios.layers[0]));
    expect(result.error).toBeUndefined();
    const pasted = result.state.dysonPlans.borealis.layers[0];
    expect(pasted.structureAllocationFloor).toBe(1);
    expect(pasted.shellAllocationFloor).toBe(0);
    expect(pasted.nodes.every((node) => node.completedStructurePoints === 0)).toBe(true);
    expect(pasted.frames.every((frame) => frame.completedStructurePoints === 0)).toBe(true);

    result.state.dysonPlans.borealis.structurePoints = 2;
    const advanced = advanceSimulation(result.state, 0.1);
    expect(getDysonPlanTotals(advanced.dysonPlans.borealis).completedStructure).toBe(1);
  });

  it("allocates legacy structure into the first planned layer and activates only completed frames", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_sphere_program", "dyson_shell");
    state.dysonSphere.structurePoints = 8;
    state.dysonSphere.totalRocketsLaunched = 8;
    state = createStandardDysonLayer(state, "helios");

    let layer = state.dysonPlans.helios.layers[0];
    expect(layer.nodes.every((node) => node.completedStructurePoints === node.requiredStructurePoints)).toBe(true);
    expect(layer.frames.every((frame) => frame.completedStructurePoints === 0)).toBe(true);
    expect(getDysonShellCapacity(state)).toBe(0);
    expect(getDysonPlanTotals(state.dysonPlans.helios).sailCapacity).toBe(0);

    state.dysonPlans.helios.structurePoints = 16;
    state.dysonSphere.structurePoints = 16;
    state = advanceSimulation(state, 0.1);
    layer = state.dysonPlans.helios.layers[0];
    expect(layer.frames.every((frame) => frame.completedStructurePoints === frame.requiredStructurePoints)).toBe(true);
    expect(getDysonShellCapacity(state)).toBe(320);
  });

  it("assigns launched rockets to the silo's star system without changing other plans", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_sphere_program", "vertical_launching_silo");
    state.exploration.unlockedSystemIds.push("borealis");
    state = setActivePlanet(state, "frost");
    state.construction.wind_turbine = 100;
    state.construction.vertical_launching_silo = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 100);
    state = placeBuilding(state, "vertical_launching_silo", { x: 300, y: 0 });
    const silo = state.entities.find((entity) => entity.buildingId === "vertical_launching_silo")!;
    state.entities.find((entity) => entity.id === silo.id)!.inputs.small_carrier_rocket = 1;
    state = advanceSimulation(state, 6);

    expect(state.dysonPlans.borealis.structurePoints).toBe(1);
    expect(state.dysonPlans.helios.structurePoints).toBe(0);
    expect(state.dysonPlans.neutron.structurePoints).toBe(0);
    expect(state.dysonSphere.structurePoints).toBe(1);
  });

  it("caps shell absorption at completed planned capacity and removes dependent geometry with a node", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_sphere_program", "dyson_shell");
    state.dysonSphere.structurePoints = 16;
    state.dysonSphere.totalRocketsLaunched = 16;
    state.dysonSwarm.sailsInOrbit = 500;
    state.dysonSwarm.totalLaunched = 500;
    state = createStandardDysonLayer(state, "helios");
    state = advanceSimulation(state, 240);

    expect(state.dysonPlans.helios.shellSails).toBe(320);
    expect(state.dysonSphere.shellSails).toBe(320);
    expect(getDysonPlanTotals(state.dysonPlans.helios).sailCapacity).toBe(320);

    const layer = state.dysonPlans.helios.layers[0];
    state = removeDysonNode(state, "helios", layer.id, layer.nodes[0].id);
    const reduced = state.dysonPlans.helios.layers[0];
    expect(reduced.nodes).toHaveLength(7);
    expect(reduced.frames).toHaveLength(6);
    expect(reduced.shells).toHaveLength(6);
    expect(getDysonShellCapacity(state)).toBe(240);
  });

  it("doubles planned shell absorption after the terminal efficiency upgrade", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_sphere_program", "dyson_shell", "dyson_absorption_1");
    state.dysonSphere.structurePoints = 16;
    state.dysonSphere.totalRocketsLaunched = 16;
    state.dysonSwarm.sailsInOrbit = 100;
    state.dysonSwarm.totalLaunched = 100;
    state = createStandardDysonLayer(state, "helios");

    expect(getDysonSailAbsorptionMultiplier(state)).toBe(2);
    state = advanceSimulation(state, 5);
    expect(state.dysonPlans.helios.shellSails).toBe(16);
    expect(state.dysonSphere.totalSailsAbsorbed).toBe(16);
  });

  it("handcrafts assembler recipes in whole batches", () => {
    let state = createInitialState();
    state.tray.iron_ingot = 8;
    state = handcraftRecipe(state, "gear", 5);
    expect(state.tray.iron_ingot).toBe(3);
    expect(state.tray.gear).toBe(5);
    expect(state.totalProduced.gear).toBe(5);
    expect(Number.isInteger(state.tray.gear)).toBe(true);

    state.tray.copper_ingot = 2;
    state = handcraftRecipe(state, "circuit_board", 1);
    expect(state.tray.iron_ingot).toBe(1);
    expect(state.tray.copper_ingot).toBe(1);
    expect(state.tray.circuit_board).toBe(2);
  });

  it("runs a deterministic handcraft queue and waits without consuming missing inputs", () => {
    let state = createInitialState();
    state.paused = false;
    state.tray.iron_ingot = 2;
    expect(canQueueHandcraftRecipe(state, "gear")).toBe(true);
    state = queueHandcraftRecipe(state, "gear", 2);
    expect(state.handcraftQueue[0]).toMatchObject({ recipeId: "gear", batchesTotal: 2, batchesRemaining: 2, progress: 0 });

    state = advanceSimulation(state, 0.5);
    expect(state.tray.iron_ingot).toBe(1);
    expect(state.tray.gear ?? 0).toBe(0);
    expect(state.handcraftQueue[0].progress).toBeCloseTo(0.5);
    state = advanceSimulation(state, 1.5);
    expect(state.tray.gear).toBe(2);
    expect(state.handcraftQueue).toEqual([]);

    state = queueHandcraftRecipe(state, "gear", 1);
    state = advanceSimulation(state, 2);
    expect(state.handcraftQueue[0]).toMatchObject({ batchesRemaining: 1, progress: 0 });
    const entryId = state.handcraftQueue[0].id;
    state = cancelHandcraftQueueEntry(state, entryId);
    expect(state.handcraftQueue).toEqual([]);
  });

  it("handcrafts basic smelting while keeping facility-only and locked recipes out", () => {
    let state = createInitialState();
    state.tray.iron_ore = 3;
    state = handcraftRecipe(state, "iron_ingot", 2);
    expect(state.tray.iron_ore).toBe(1);
    expect(state.tray.iron_ingot).toBe(2);
    expect(handcraftRecipe(state, "critical_photon", 1)).toBe(state);

    state.tray.carbon_nanotube = 4;
    state.tray.titanium_alloy = 1;
    state.tray.high_purity_silicon = 1;
    expect(handcraftRecipe(state, "frame_material", 1)).toBe(state);
    state.research.completedTechIds.push("dyson_sphere_program");
    state = handcraftRecipe(state, "frame_material", 1);
    expect(state.tray.frame_material).toBe(1);
    expect(state.tray.carbon_nanotube).toBe(0);
  });

  it("unlocks electric motors and turbines before particle collider technology", () => {
    let state = createInitialState();
    state.tray.iron_ingot = 2;
    state.tray.gear = 1;
    state.tray.magnetic_coil = 3;

    expect(canHandcraftRecipe(state, "electric_motor")).toBe(false);
    state.research.completedTechIds.push("basic_logistics");
    expect(canHandcraftRecipe(state, "electric_motor")).toBe(true);
    state = handcraftRecipe(state, "electric_motor", 1);
    state.tray.electric_motor = 2;

    expect(canHandcraftRecipe(state, "electromagnetic_turbine")).toBe(false);
    state.research.completedTechIds.push("high_speed_logistics");
    expect(canHandcraftRecipe(state, "electromagnetic_turbine")).toBe(true);
    expect(state.research.completedTechIds).not.toContain("miniature_particle_collider");
  });

  it("handcrafts unlocked logistics vehicles and space warpers", () => {
    let state = createInitialState();
    state.tray.steel = 5;
    state.tray.processor = 12;
    state.tray.electromagnetic_turbine = 2;
    state.tray.titanium_alloy = 10;
    state.tray.plasma_exciter = 4;
    state.tray.graviton_lens = 2;

    expect(handcraftRecipe(state, "logistics_drone", 1)).toBe(state);
    state.research.completedTechIds.push("planetary_logistics", "interstellar_logistics", "space_warp");
    state = handcraftRecipe(state, "logistics_drone", 1);
    state = handcraftRecipe(state, "logistics_vessel", 1);
    state = handcraftRecipe(state, "space_warper", 2);

    expect(state.portableFleet).toEqual({ logistics_drone: 1, logistics_vessel: 1 });
    expect(state.tray).toMatchObject({
      space_warper: 2,
      steel: 0,
      processor: 0,
      electromagnetic_turbine: 0,
      titanium_alloy: 0,
      plasma_exciter: 0,
      graviton_lens: 0,
    });
  });

  it("recursively manufactures a logistics vessel atomically and stores it in the portable fleet", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_efficiency_plasma_control", "titanium_alloy", "interstellar_logistics");
    state.tray = {
      iron_ore: 36,
      titanium_ingot: 12,
      sulfuric_acid: 24,
      processor: 10,
      plasma_exciter: 4,
    };
    state.planetTrays.home = state.tray;

    const plan = getRecursiveHandcraftPlan(state, "logistics_vessel", 1);
    expect(plan.possible).toBe(true);
    expect(plan.decisions.map((decision) => decision.recipeId)).toEqual(expect.arrayContaining(["iron_ingot", "steel", "titanium_alloy", "logistics_vessel"]));
    const crafted = handcraftRecipeWithUpstream(state, "logistics_vessel", 1);
    expect(crafted.portableFleet.logistics_vessel).toBe(1);
    expect(crafted.tray.logistics_vessel).toBeUndefined();
    expect(crafted.tray.iron_ore).toBe(0);

    state.tray.iron_ore = 35;
    const before = JSON.stringify(state);
    expect(handcraftRecipeWithUpstream(state, "logistics_vessel", 1)).toBe(state);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("finishes recursive orbital-collector handcraft when hydrogen is already above the tray soft limit", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("orbital_collection", "rare_resource_utilization");
    state.planetTrayItemLimits.home = 100_000_000;
    state.tray = {
      hydrogen: 101_000_000,
      titanium_alloy: 40,
      super_magnetic_ring: 20,
      fire_ice: 20,
    };
    state.planetTrays.home = state.tray;

    const plan = getConstructionQuickCraftPlan(state, "orbital_collector");
    expect(plan).toMatchObject({ possible: true, status: "upstream" });
    const crafted = craftConstructionWithUpstream(state, "orbital_collector");
    expect(crafted).not.toBe(state);
    expect(crafted.construction.orbital_collector).toBe(1);
    expect(crafted.tray.hydrogen).toBe(101_000_010);
    expect(crafted.tray.fire_ice).toBe(0);
    expect(crafted.planetTrayItemLimits.home).toBe(100_000_000);
  });

  it("stores manufactured and cursor-carried logistics vehicles in the portable fleet across planets", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state = placeBuilding(state, "assembling_machine_mk1", { x: 100, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    assembler.outputs.logistics_vessel = 2;

    state = moveEntityOutputToTray(state, assembler.id, "logistics_vessel");
    expect(state.entities.find((entity) => entity.id === assembler.id)?.outputs.logistics_vessel).toBe(0);
    expect(state.portableFleet.logistics_vessel).toBe(2);
    expect(state.tray.logistics_vessel).toBeUndefined();

    state.cargo = { itemId: "logistics_drone", amount: 3, origin: { kind: "node-output", id: assembler.id } };
    state = dropCargoToTray(state);
    expect(state.portableFleet.logistics_drone).toBe(3);
    expect(state.cargo).toBeNull();

    state = setActivePlanet(state, "ashen");
    expect(state.portableFleet).toEqual({ logistics_drone: 3, logistics_vessel: 2 });
  });

  it("absorbs orbiting sails into a capped permanent shell before they decay", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_shell");
    state.dysonSwarm.sailsInOrbit = 10;
    state.dysonSwarm.totalLaunched = 10;
    state.dysonSphere.structurePoints = 2;
    state = advanceSimulation(state, 5);

    expect(state.dysonSwarm.sailsInOrbit).toBe(9);
    expect(state.dysonSwarm.totalExpired).toBe(0);
    expect(state.dysonSphere.shellSails).toBe(1);
    expect(state.dysonSphere.totalSailsAbsorbed).toBe(1);
    expect(state.dysonSphere.generationKw).toBe(2 * DYSON_STRUCTURE_POWER_KW + DYSON_SHELL_SAIL_POWER_KW);
    expect(state.dysonSphere.shellSails).toBeLessThanOrEqual(
      state.dysonSphere.structurePoints * DYSON_SHELL_CAPACITY_PER_STRUCTURE,
    );
    expect(Number.isInteger(state.dysonSphere.shellSails)).toBe(true);
  });

  it("absorbs sails into the shell belonging to the same star system", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("dyson_shell");
    state.dysonPlans.helios.structurePoints = 10;
    state.dysonPlans.borealis.structurePoints = 20;
    const heliosOrbit = state.dysonEngineering.orbitsBySystem.helios[0];
    const borealisOrbit = state.dysonEngineering.orbitsBySystem.borealis[0];
    heliosOrbit.sailsInOrbit = 8;
    heliosOrbit.totalLaunched = 8;
    borealisOrbit.sailsInOrbit = 12;
    borealisOrbit.totalLaunched = 12;
    state.dysonSwarm.sailsInOrbit = 20;
    state.dysonSwarm.totalLaunched = 20;

    state = advanceSimulation(state, 10);

    expect(state.dysonPlans.helios.shellSails).toBe(8);
    expect(state.dysonPlans.borealis.shellSails).toBe(12);
    expect(state.dysonEngineering.orbitsBySystem.helios[0].sailsInOrbit).toBe(0);
    expect(state.dysonEngineering.orbitsBySystem.borealis[0].sailsInOrbit).toBe(0);
    expect(state.dysonSphere.totalSailsAbsorbed).toBe(20);
    expect(state.dysonSphere.shellSails).toBe(20);
  });

  it("powers ray receivers from the permanent sphere when the Dyson cloud is empty", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("ray_receiver");
    state.construction.ray_receiver = 1;
    state = placeBuilding(state, "ray_receiver", { x: 0, y: 0 });
    const receiver = state.entities.find((entity) => entity.buildingId === "ray_receiver")!;
    state.dysonSphere.structurePoints = 7;
    state = advanceSimulation(state, 0.1);

    expect(state.dysonSwarm.sailsInOrbit).toBe(0);
    expect(state.dysonSphere.generationKw).toBe(7 * DYSON_STRUCTURE_POWER_KW);
    expect(state.planetMetrics.home.rayGenerationKw).toBe(RAY_RECEIVER_CAPACITY_KW);
    expect(state.dysonSwarm.receiverLoadKw).toBe(RAY_RECEIVER_CAPACITY_KW);
    expect(getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === receiver.id)!)).toMatchObject({
      code: "running",
      tone: "running",
    });
  });

  it("separates theoretical reception, receiver utilization and Dyson power utilization", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("ray_receiver");
    state.construction.ray_receiver = 2;
    state = placeBuilding(state, "ray_receiver", { x: 0, y: 0 });
    state = placeBuilding(state, "ray_receiver", { x: 280, y: 0 });
    const [powerReceiver, photonReceiver] = state.entities.filter((entity) => entity.buildingId === "ray_receiver");
    state = setEntityRecipe(state, photonReceiver.id, "critical_photon");
    state.entities.find((entity) => entity.id === photonReceiver.id)!.outputs.critical_photon = getEntityOutputCapacity(state, photonReceiver);
    state.dysonSphere.structurePoints = 7;
    state = advanceSimulation(state, 0.1);

    const blocked = getDysonEngineeringSnapshot(state, "helios");
    expect(blocked.configuredReceiverCount).toBe(2);
    expect(blocked.blockedReceiverCount).toBe(1);
    expect(blocked.theoreticalReceptionRate).toBeGreaterThan(0);
    expect(blocked.theoreticalReceptionRate).toBeLessThan(1);
    expect(blocked.receiverUtilization).toBe(1);
    expect(blocked.dysonPowerUtilization).toBeLessThan(1);
    expect(getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === photonReceiver.id)!)).toMatchObject({ code: "output-blocked" });

    state.entities.find((entity) => entity.id === photonReceiver.id)!.outputs.critical_photon = 0;
    state = advanceSimulation(state, 0.1);
    const flowing = getDysonEngineeringSnapshot(state, "helios");
    expect(flowing.blockedReceiverCount).toBe(0);
    expect(flowing.theoreticalReceptionRate).toBe(blocked.theoreticalReceptionRate);
    expect(flowing.receiverUtilization).toBeCloseTo(flowing.theoreticalReceptionRate, 3);
    expect(flowing.dysonPowerUtilization).toBe(1);
    expect(state.entities.find((entity) => entity.id === powerReceiver.id)?.powerOutputKw).toBeGreaterThan(0);
  });

  it("upgrades an assembler group in place without losing its recipe, buffers or identity", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_speed_assembling");
    state.construction.assembling_machine_mk2 = 2;
    state = placeBuilding(state, "assembling_machine_mk1", { x: 120, y: 80 }, 2);
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    assembler.inputs.iron_ingot = 4;
    assembler.outputs.gear = 2;
    assembler.progress = 0.625;

    expect(canUpgradeEntity(state, assembler.id)).toBe(true);
    const upgraded = upgradeEntity(state, assembler.id);
    const result = upgraded.entities.find((entity) => entity.id === assembler.id)!;
    expect(result).toMatchObject({
      id: assembler.id,
      buildingId: "assembling_machine_mk2",
      recipeId: "gear",
      machineCount: 2,
      position: { x: 120, y: 80 },
      inputs: { iron_ingot: 4 },
      outputs: { gear: 2 },
      progress: 0.625,
    });
    expect(upgraded.construction.assembling_machine_mk2).toBe(0);
    expect(upgraded.construction.assembling_machine_mk1).toBe(3);
    expect(setEntityRecipe(upgraded, assembler.id, "circuit_board").entities.find((entity) => entity.id === assembler.id)?.recipeId).toBe("circuit_board");
  });

  it("keeps equipment unchanged when an upgrade is locked or the whole group cannot be replaced", () => {
    let state = createInitialState();
    state.construction.assembling_machine_mk2 = 2;
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 }, 2);
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    expect(canUpgradeEntity(state, assembler.id)).toBe(false);
    expect(upgradeEntity(state, assembler.id)).toBe(state);

    state.research.completedTechIds.push("high_speed_assembling");
    state.construction.assembling_machine_mk2 = 1;
    expect(canUpgradeEntity(state, assembler.id)).toBe(false);
    expect(upgradeEntity(state, assembler.id)).toBe(state);
  });

  it("crafts Mk.II production and logistics equipment from the unlocked material sink", () => {
    let state = createInitialState();
    state.tray = { steel: 8, gear: 9, circuit_board: 8, magnetic_coil: 6, iron_ingot: 2 };
    expect(craftConstruction(state, "assembling_machine_mk2")).toBe(state);
    expect(craftConstruction(state, "conveyor_belt_mk2")).toBe(state);

    state.research.completedTechIds.push("high_speed_assembling", "high_speed_logistics");
    state = craftConstruction(state, "assembling_machine_mk2");
    state = craftConstruction(state, "conveyor_belt_mk2");
    expect(state.construction.assembling_machine_mk2).toBe(1);
    expect(state.construction.conveyor_belt_mk2).toBe(3);
    expect(state.tray).toMatchObject({ steel: 0, gear: 0, circuit_board: 0, magnetic_coil: 0, iron_ingot: 0 });
  });

  it("upgrades every lane of a belt and applies tier throughput while preserving the connection", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_speed_logistics");
    state.construction.mining_machine = 1;
    state.construction.conveyor_belt_mk1 = 2;
    state.construction.conveyor_belt_mk2 = 2;
    state = installMiner(state, "vein_iron");
    state = placeBuilding(state, "arc_smelter", { x: 200, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = connectBelt(state, "vein_iron", smelter.id, "iron_ore", 1);
    state = connectBelt(state, "vein_iron", smelter.id, "iron_ore", 1);
    const belt = state.belts[0];
    belt.progress = 0.75;
    state = setBeltPriority(state, belt.id, 1);

    expect(getBeltCapacity(state.belts[0])).toBe(12);
    expect(canUpgradeBelt(state, belt.id)).toBe(true);
    const upgraded = upgradeBelt(state, belt.id);
    expect(upgraded.belts[0]).toMatchObject({ id: belt.id, tier: 2, lanes: 2, progress: 0.75, priority: 1 });
    expect(getBeltCapacity(upgraded.belts[0])).toBe(24);
    expect(upgraded.construction.conveyor_belt_mk2).toBe(0);
    expect(upgraded.construction.conveyor_belt_mk1).toBe(2);
  });

  it("applies high-efficiency mining to solid extraction without changing fluid extractors", () => {
    let base = createInitialState();
    base.construction.mining_machine = 1;
    base.construction.wind_turbine = 2;
    base = installMiner(base, "vein_iron");
    base = placeBuilding(base, "wind_turbine", { x: 0, y: 0 }, 2);
    const upgradedSeed = structuredClone(base);
    const tierTwoSeed = structuredClone(base);
    const tierThreeSeed = structuredClone(base);

    base = advanceSimulation(base, 4);
    upgradedSeed.research.completedTechIds.push("mining_speed_1");
    const upgraded = advanceSimulation(upgradedSeed, 4);
    tierTwoSeed.research.completedTechIds.push("mining_speed_1", "mining_speed_2");
    const tierTwo = advanceSimulation(tierTwoSeed, 4);
    tierThreeSeed.research.completedTechIds.push("mining_speed_1", "mining_speed_2", "mining_speed_3");
    const tierThree = advanceSimulation(tierThreeSeed, 4);
    expect(getMiningSpeedMultiplier(base)).toBe(1);
    expect(getMiningSpeedMultiplier(upgraded)).toBe(1.5);
    expect(getMiningSpeedMultiplier(tierTwo)).toBe(2);
    expect(getMiningSpeedMultiplier(tierThree)).toBe(3);
    expect(base.entities.find((entity) => entity.id === "vein_iron")?.outputs.iron_ore).toBe(2);
    expect(upgraded.entities.find((entity) => entity.id === "vein_iron")?.outputs.iron_ore).toBe(3);
    expect(tierTwo.entities.find((entity) => entity.id === "vein_iron")?.outputs.iron_ore).toBe(4);
    expect(tierThree.entities.find((entity) => entity.id === "vein_iron")?.outputs.iron_ore).toBe(6);

    let fluid = createInitialState();
    fluid.research.completedTechIds.push("mining_speed_1", "mining_speed_2", "mining_speed_3");
    fluid.construction.water_pump = 1;
    fluid.construction.wind_turbine = 1;
    fluid = installMiner(fluid, "vein_water");
    fluid = placeBuilding(fluid, "wind_turbine", { x: 0, y: 0 });
    fluid = advanceSimulation(fluid, 3);
    expect(fluid.entities.find((entity) => entity.id === "vein_water")?.outputs.water).toBe(3);
    expect(fluid.entities.find((entity) => entity.id === "vein_water")?.productionRate).toBe(60);
  });

  it("locks spray-coater installation and losslessly removes the module from an existing building", () => {
    let state = createInitialState();
    state.construction.spray_coater = 1;
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;

    expect(canInstallSprayCoater(state, assembler.id)).toBe(false);
    expect(installSprayCoater(state, assembler.id)).toBe(state);

    state.research.completedTechIds.push("proliferator_1");
    expect(canInstallSprayCoater(state, assembler.id)).toBe(true);
    state = installSprayCoater(state, assembler.id);
    expect(state.entities.find((entity) => entity.id === assembler.id)).toMatchObject({
      sprayCoaterInstalled: true,
      proliferatorTier: 1,
      proliferatorMode: "normal",
      proliferatorPoints: 0,
    });
    expect(state.construction.spray_coater).toBe(0);
    const installed = state.entities.find((entity) => entity.id === assembler.id)!;
    installed.inputs.proliferator_mk1 = 3;
    installed.proliferatorPoints = 2;
    state.belts.push({ id: "spray_line", planetId: "home", source: "vein_coal", target: assembler.id, itemId: "proliferator_mk1", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 1, lastFlow: 0 });
    expect(getSprayCoaterRemovalRefund(state, assembler.id)).toMatchObject({
      sprayCoaters: 1,
      proliferatorItemId: "proliferator_mk1",
      proliferatorItems: 4,
      bufferedProliferatorItems: 3,
      recoveredPointItems: 1,
      remainingSprayPoints: 2,
    });
    state = removeSprayCoater(state, assembler.id);
    expect(state.construction.spray_coater).toBe(1);
    expect(state.tray.proliferator_mk1).toBe(4);
    expect(state.belts.some((belt) => belt.id === "spray_line")).toBe(false);
    expect(state.entities.find((entity) => entity.id === assembler.id)).toMatchObject({ sprayCoaterInstalled: false, proliferatorPoints: 0 });
  });

  it("diagnoses spray-coater installation and installs two smelters in sequence", () => {
    let state = createInitialState();
    state.construction.arc_smelter = 2;
    state.construction.spray_coater = 2;
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 280, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 560, y: 0 });
    const [graphiteSmelter, diamondSmelter] = state.entities.filter((entity) => entity.buildingId === "arc_smelter");

    expect(getSprayCoaterInstallCheck(state, graphiteSmelter.id)).toMatchObject({ code: "technology-locked", ready: false });
    state.research.completedTechIds.push("proliferator_1", "energy_matrix", "high_strength_crystal");
    graphiteSmelter.recipeId = undefined;
    expect(getSprayCoaterInstallCheck(state, graphiteSmelter.id)).toMatchObject({ code: "recipe-missing", ready: false });
    state = setEntityRecipe(state, graphiteSmelter.id, "energetic_graphite");
    state = setEntityRecipe(state, diamondSmelter.id, "diamond");

    expect(getSprayCoaterInstallCheck(state, graphiteSmelter.id)).toMatchObject({ code: "ready", ready: true });
    state = installSprayCoater(state, graphiteSmelter.id);
    expect(getSprayCoaterInstallCheck(state, graphiteSmelter.id)).toMatchObject({ code: "already-installed", ready: false });
    expect(getSprayCoaterInstallCheck(state, diamondSmelter.id)).toMatchObject({ code: "ready", ready: true });
    state = installSprayCoater(state, diamondSmelter.id);

    expect(state.entities.filter((entity) => [graphiteSmelter.id, diamondSmelter.id].includes(entity.id))
      .every((entity) => entity.sprayCoaterInstalled)).toBe(true);
    expect(state.construction.spray_coater).toBe(0);

    const third = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    expect(getSprayCoaterInstallCheck(state, third.id)).toMatchObject({ code: "stock-empty", ready: false });
  });

  it("applies recipe and proliferator settings to a compatible multi-selection", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("proliferator_1", "proliferator_2");
    state.construction.assembling_machine_mk1 = 2;
    state.construction.spray_coater = 2;
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 300, y: 0 });
    const entityIds = state.entities
      .filter((entity) => entity.buildingId === "assembling_machine_mk1")
      .map((entity) => entity.id);

    state = setEntitiesRecipe(state, entityIds, "circuit_board");
    expect(state.entities.filter((entity) => entityIds.includes(entity.id)).every((entity) => entity.recipeId === "circuit_board")).toBe(true);

    state = installSprayCoaters(state, entityIds);
    expect(state.entities.filter((entity) => entityIds.includes(entity.id)).every((entity) => entity.sprayCoaterInstalled)).toBe(true);
    expect(state.construction.spray_coater).toBe(0);

    state = setEntitiesProliferatorConfiguration(state, entityIds, 2, "speed");
    expect(state.entities.filter((entity) => entityIds.includes(entity.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ proliferatorTier: 2, proliferatorMode: "speed" }),
      expect.objectContaining({ proliferatorTier: 2, proliferatorMode: "speed" }),
    ]));
  });

  it("consumes spray points and accumulates only whole extra products", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("proliferator_1");
    state.construction.spray_coater = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
    state = placeBuilding(state, "assembling_machine_mk1", { x: 240, y: 0 });
    const assemblerId = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;
    state = installSprayCoater(state, assemblerId);
    state = setProliferatorConfiguration(state, assemblerId, 1, "extra");
    const assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.iron_ingot = 12;
    assembler.inputs.proliferator_mk1 = 1;

    state = advanceSimulation(state, 10.7);
    let result = state.entities.find((entity) => entity.id === assemblerId)!;
    expect(result.outputs.gear).toBe(9);
    expect(result.inputs.proliferator_mk1).toBe(0);
    expect(result.proliferatorPoints).toBe(4);
    expect(result.proliferatorBonusProgress?.gear).toBe(0);

    state = advanceSimulation(state, 5.4);
    result = state.entities.find((entity) => entity.id === assemblerId)!;
    expect(result.outputs.gear).toBe(13);
    expect(result.proliferatorPoints).toBe(0);
    expect(result.proliferatorBonusProgress?.gear).toBe(0.5);
    expect(Number.isInteger(result.outputs.gear ?? 0)).toBe(true);
    result.inputs.iron_ingot = 1;
    expect(getEntityOperatingStatus(state, result)).toMatchObject({ code: "missing-proliferator", tone: "warning" });
  });

  it("continues at the base rate after proliferator points are exhausted and resumes automatically", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("proliferator_1");
    state.construction.spray_coater = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
    state = placeBuilding(state, "assembling_machine_mk1", { x: 240, y: 0 });
    const assemblerId = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;
    state = installSprayCoater(state, assemblerId);
    state = setProliferatorConfiguration(state, assemblerId, 1, "speed");
    let assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.iron_ingot = 20;

    state = advanceSimulation(state, 2.1);
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    expect(assembler.outputs.gear).toBeGreaterThan(0);
    expect(getEntityOperatingStatus(state, assembler)).toMatchObject({ code: "missing-proliferator", tone: "warning" });
    const baseOutput = assembler.outputs.gear ?? 0;
    const baseProductionRate = assembler.productionRate;

    assembler.inputs.proliferator_mk1 = 1;
    state = advanceSimulation(state, 2.1);
    assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    expect((assembler.outputs.gear ?? 0) - baseOutput).toBeGreaterThanOrEqual(2);
    expect(assembler.productionRate).toBeGreaterThan(baseProductionRate);
    expect(assembler.inputs.proliferator_mk1).toBe(0);
  });

  it("limits only the selected proliferator item with the dedicated per-entity setting", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("proliferator_1");
    state.construction.spray_coater = 1;
    state.construction.assembling_machine_mk1 = 1_000_000;
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 }, 1_000_000);
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    state = installSprayCoater(state, assembler.id);
    state.settings.productionBufferLimit = 100_000_000;
    state.settings.proliferatorBufferLimit = 120;
    const installed = state.entities.find((entity) => entity.id === assembler.id)!;
    const ordinaryInputCapacity = getEntityItemInputCapacity(state, installed, "iron_ingot");

    expect(getEntityItemInputCapacity(state, installed, "proliferator_mk1")).toBe(120);
    expect(getEntityItemInputCapacity(state, installed, "iron_ingot")).toBeGreaterThan(120);
    installed.inputs.proliferator_mk1 = 200;
    state.settings.proliferatorBufferLimit = 100_000_000;
    expect(getEntityItemInputCapacity(state, installed, "proliferator_mk1")).toBe(100_000_000);
    expect(installed.inputs.proliferator_mk1).toBe(200);
    expect(getEntityItemInputCapacity(state, installed, "iron_ingot")).toBe(ordinaryInputCapacity);
  });

  it("applies Mk.III speed and power multipliers to an active production node", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("proliferator_1", "proliferator_2", "proliferator_3");
    state.construction.spray_coater = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 3);
    state = placeBuilding(state, "assembling_machine_mk1", { x: 240, y: 0 });
    const assemblerId = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;
    state = installSprayCoater(state, assemblerId);
    state = setProliferatorConfiguration(state, assemblerId, 3, "speed");
    const assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.iron_ingot = 10;
    assembler.inputs.proliferator_mk3 = 1;

    expect(getEntityProliferatorSpeedMultiplier(assembler)).toBe(2);
    expect(getEntityProliferatorPowerMultiplier(assembler)).toBe(2.5);
    expect(getEntityExtraProductBonus(assembler)).toBe(0);
    state = advanceSimulation(state, 1);

    const result = state.entities.find((entity) => entity.id === assemblerId)!;
    expect(result.outputs.gear).toBe(1);
    expect(result.progress).toBe(0.5);
    expect(result.proliferatorPoints).toBe(59);
    expect(state.metrics.demandKw).toBe(675);
  });

  it("refunds the previous proliferator input and belt when changing tiers", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("proliferator_1", "proliferator_2");
    state.construction.spray_coater = 1;
    state.construction.assembling_machine_mk1 = 2;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 240, y: 0 });
    const [source, target] = state.entities.filter((entity) => entity.buildingId === "assembling_machine_mk1");
    state = setEntityRecipe(state, source.id, "proliferator_mk1");
    state = installSprayCoater(state, target.id);
    state.entities.find((entity) => entity.id === target.id)!.inputs.proliferator_mk1 = 3;
    state = connectBelt(state, source.id, target.id, "proliferator_mk1");
    expect(state.belts).toHaveLength(1);
    expect(state.construction.conveyor_belt_mk1).toBe(0);

    state = setProliferatorConfiguration(state, target.id, 2, "extra");
    const result = state.entities.find((entity) => entity.id === target.id)!;
    expect(result.proliferatorTier).toBe(2);
    expect(result.inputs.proliferator_mk1).toBe(0);
    expect(state.tray.proliferator_mk1).toBe(3);
    expect(state.belts).toHaveLength(0);
    expect(state.construction.conveyor_belt_mk1).toBe(1);
  });

  it("clears fractional extra-product progress when the recipe changes", () => {
    let state = createInitialState();
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    assembler.proliferatorBonusProgress = { gear: 0.875 };
    state = setEntityRecipe(state, assembler.id, "circuit_board");
    expect(state.entities.find((entity) => entity.id === assembler.id)?.proliferatorBonusProgress).toEqual({});
  });

  it("uses the final output slot when an extra product has not accumulated yet", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("proliferator_1");
    state.construction.spray_coater = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
    state = placeBuilding(state, "assembling_machine_mk1", { x: 240, y: 0 });
    const assemblerId = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!.id;
    state = installSprayCoater(state, assemblerId);
    state = setProliferatorConfiguration(state, assemblerId, 1, "extra");
    const assembler = state.entities.find((entity) => entity.id === assemblerId)!;
    assembler.inputs.iron_ingot = 1;
    assembler.inputs.proliferator_mk1 = 1;
    assembler.outputs.gear = 119;

    state = advanceSimulation(state, 1.4);
    const result = state.entities.find((entity) => entity.id === assemblerId)!;
    expect(result.outputs.gear).toBe(120);
    expect(result.proliferatorBonusProgress?.gear).toBe(0.125);
    expect(getEntityOperatingStatus(state, result).code).toBe("output-blocked");
  });

  it("dispatches demand-side drones between planetary logistics stations", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 4;
    state.construction.planetary_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 4);
    state = placeBuilding(state, "planetary_logistics_station", { x: -200, y: 0 });
    state = placeBuilding(state, "planetary_logistics_station", { x: 300, y: 0 });
    const [supply, demand] = state.entities.filter((entity) => entity.buildingId === "planetary_logistics_station");
    state = setLogisticsItem(state, supply.id, "iron_ingot");
    state = setLogisticsItem(state, demand.id, "iron_ingot");
    state = setStationMode(state, demand.id, "demand");
    state = setStationMinimumLoad(state, demand.id, 0.5);
    state.entities.find((entity) => entity.id === supply.id)!.outputs.iron_ingot = 100;
    state.portableFleet.logistics_drone = 2;
    state = adjustStationDrones(state, demand.id, 2);

    expect(getStationDroneCapacity(state.entities.find((entity) => entity.id === demand.id)!)).toBe(50);
    expect(state.portableFleet.logistics_drone).toBe(0);
    state = advanceSimulation(state, 8.1);

    expect(state.entities.find((entity) => entity.id === supply.id)?.outputs.iron_ingot).toBe(50);
    expect(state.entities.find((entity) => entity.id === demand.id)?.outputs.iron_ingot).toBe(50);
    expect(state.entities.find((entity) => entity.id === demand.id)?.stationTrips).toBe(2);
    expect(getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === demand.id)!)).toMatchObject({ code: "running" });
  });

  it("dispatches supply-side drones and returns them to their owning station", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 4;
    state.construction.planetary_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 4);
    state = placeBuilding(state, "planetary_logistics_station", { x: -200, y: 0 });
    state = placeBuilding(state, "planetary_logistics_station", { x: 300, y: 0 });
    const [supply, demand] = state.entities.filter((entity) => entity.buildingId === "planetary_logistics_station");
    state = setLogisticsItem(state, supply.id, "iron_ingot");
    state = setLogisticsItem(state, demand.id, "iron_ingot");
    state = setStationMode(state, demand.id, "demand");
    state = setStationMinimumLoad(state, demand.id, 1);
    state.entities.find((entity) => entity.id === supply.id)!.outputs.iron_ingot = 25;
    state.portableFleet.logistics_drone = 1;
    state = adjustStationDrones(state, supply.id, 1);

    state = advanceSimulation(state, 0.1);
    const activeDemand = state.entities.find((entity) => entity.id === demand.id)!;
    expect(activeDemand.stationRoutes).toEqual([
      expect.objectContaining({ peerId: supply.id, vehicleStationId: supply.id, vehicleCount: 1 }),
    ]);
    expect(getStationBusyVehicleCount(state, supply.id, "local")).toBe(1);
    expect(getStationBusyVehicleCount(state, demand.id, "local")).toBe(0);

    state = advanceSimulation(state, getPlanetaryTripSeconds(state));
    expect(state.entities.find((entity) => entity.id === demand.id)?.outputs.iron_ingot).toBe(25);
    expect(getStationBusyVehicleCount(state, supply.id, "local")).toBe(0);
    state = adjustStationDrones(state, supply.id, -1);
    expect(state.portableFleet.logistics_drone).toBe(1);
  });

  it("uses the vehicle owner's slot minimum load for supply-side and demand-side dispatch", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 4;
    state.construction.planetary_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 4);
    state = placeBuilding(state, "planetary_logistics_station", { x: -200, y: 0 });
    state = placeBuilding(state, "planetary_logistics_station", { x: 300, y: 0 });
    const [supply, demand] = state.entities.filter((entity) => entity.buildingId === "planetary_logistics_station");
    state = setLogisticsItem(state, supply.id, "iron_ingot");
    state = setLogisticsItem(state, demand.id, "iron_ingot");
    state = setStationMode(state, demand.id, "demand");
    state = setStationMinimumLoad(state, supply.id, 0.1);
    state = setStationMinimumLoad(state, demand.id, 1);
    state.entities.find((entity) => entity.id === supply.id)!.outputs.iron_ingot = 12;
    state.portableFleet.logistics_drone = 2;
    state = adjustStationDrones(state, supply.id, 1);
    state = adjustStationDrones(state, demand.id, 1);

    state = advanceSimulation(state, 0.1);
    const routes = state.entities.find((entity) => entity.id === demand.id)?.stationRoutes ?? [];
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ vehicleStationId: supply.id, cargo: 12 });
    expect(getStationBusyVehicleCount(state, supply.id, "local")).toBe(1);
    expect(getStationBusyVehicleCount(state, demand.id, "local")).toBe(0);
  });

  it("fills station drone and vessel berths atomically from the portable fleet", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const station = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    station.machineCount = 2;
    state.portableFleet = { logistics_drone: 200, logistics_vessel: 7 };

    const drones = fillStationFleet(state, station.id, "drone");
    expect(drones.loaded).toBe(drones.capacity);
    expect(drones.shortfall).toBe(0);
    expect(state.entities.find((entity) => entity.id === station.id)?.stationDrones).toBe(0);
    expect(drones.state.entities.find((entity) => entity.id === station.id)?.stationDrones).toBe(drones.capacity);
    expect(drones.state.portableFleet.logistics_drone).toBe(200 - drones.capacity);

    const vessels = fillStationFleet(drones.state, station.id, "vessel");
    expect(vessels.loaded).toBe(7);
    expect(vessels.shortfall).toBe(vessels.capacity - 7);
    expect(vessels.state.entities.find((entity) => entity.id === station.id)?.stationVessels).toBe(7);
    expect(vessels.state.portableFleet.logistics_vessel).toBe(0);
  });

  it("sets station fleet targets by difference and refuses to unload busy vehicles", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const station = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    state.portableFleet = { logistics_drone: 10, logistics_vessel: 10 };

    const drones = setStationFleetTarget(state, station.id, "drone", 7);
    expect(drones).toMatchObject({ current: 0, final: 7, loaded: 7, unloaded: 0, shortfall: 0 });
    const vessels = setStationFleetTarget(drones.state, station.id, "vessel", 4);
    expect(vessels).toMatchObject({ final: 4, loaded: 4, shortfall: 0 });
    const unloaded = setStationFleetTarget(vessels.state, station.id, "drone", 2);
    expect(unloaded).toMatchObject({ final: 2, loaded: 0, unloaded: 5 });
    expect(unloaded.state.portableFleet).toEqual({ logistics_drone: 8, logistics_vessel: 6 });

    const activeStation = unloaded.state.entities.find((entity) => entity.id === station.id)!;
    activeStation.stationRoutes = [{ id: "busy", slotIndex: 0, peerId: station.id, itemId: "iron_ingot", scope: "local", cargo: 1, vehicleCount: 2, progress: 0.5, duration: 10, requiresWarp: false, vehicleStationId: station.id }];
    const blocked = setStationFleetTarget(unloaded.state, station.id, "drone", 0);
    expect(blocked).toMatchObject({ final: 2, busy: 2, reason: "busy-vehicles" });
    expect(blocked.state).toBe(unloaded.state);
  });

  it("uses both station fleets without reserving a vehicle or cargo twice", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 4;
    state.construction.planetary_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 4);
    state = placeBuilding(state, "planetary_logistics_station", { x: -200, y: 0 });
    state = placeBuilding(state, "planetary_logistics_station", { x: 300, y: 0 });
    const [supply, demand] = state.entities.filter((entity) => entity.buildingId === "planetary_logistics_station");
    state = setLogisticsItem(state, supply.id, "copper_ingot");
    state = setLogisticsItem(state, demand.id, "copper_ingot");
    state = setStationMode(state, demand.id, "demand");
    state = setStationMinimumLoad(state, demand.id, 1);
    state.entities.find((entity) => entity.id === supply.id)!.outputs.copper_ingot = 50;
    state.portableFleet.logistics_drone = 2;
    state = adjustStationDrones(state, demand.id, 1);
    state = adjustStationDrones(state, supply.id, 1);

    state = advanceSimulation(state, 0.1);
    const routes = state.entities.find((entity) => entity.id === demand.id)!.stationRoutes ?? [];
    expect(routes).toHaveLength(2);
    expect(routes.map((route) => route.vehicleStationId)).toEqual([demand.id, supply.id]);
    expect(routes.reduce((sum, route) => sum + route.cargo, 0)).toBe(50);
    expect(getStationBusyVehicleCount(state, demand.id, "local")).toBe(1);
    expect(getStationBusyVehicleCount(state, supply.id, "local")).toBe(1);

    state = advanceSimulation(state, getPlanetaryTripSeconds(state));
    expect(state.entities.find((entity) => entity.id === demand.id)?.outputs.copper_ingot).toBe(50);
    expect(state.entities.find((entity) => entity.id === supply.id)?.outputs.copper_ingot).toBe(0);
    expect(getStationBusyVehicleCount(state, demand.id, "local")).toBe(0);
    expect(getStationBusyVehicleCount(state, supply.id, "local")).toBe(0);
  });

  it("dispatches five-slot station cargo independently by item and priority", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 4;
    state.construction.planetary_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 4);
    state = placeBuilding(state, "planetary_logistics_station", { x: -200, y: 0 });
    state = placeBuilding(state, "planetary_logistics_station", { x: 300, y: 0 });
    const [supply, demand] = state.entities.filter((entity) => entity.buildingId === "planetary_logistics_station");
    state = setStationSlotItem(state, supply.id, 0, "iron_ingot");
    state = setStationSlotItem(state, supply.id, 1, "copper_ingot");
    state = setStationSlotItem(state, demand.id, 0, "iron_ingot");
    state = setStationSlotItem(state, demand.id, 1, "copper_ingot");
    state = setStationSlotMode(state, demand.id, 0, "local", "demand");
    state = setStationSlotMode(state, demand.id, 1, "local", "demand");
    state = setStationSlotMinimumLoad(state, demand.id, 0, 1);
    state = setStationSlotMinimumLoad(state, demand.id, 1, 1);
    state = setStationSlotPriority(state, demand.id, 1, 2);
    state.entities.find((entity) => entity.id === supply.id)!.outputs = { iron_ingot: 25, copper_ingot: 25 };
    state.portableFleet.logistics_drone = 2;
    state = adjustStationDrones(state, demand.id, 2);

    state = advanceSimulation(state, 8.1);
    const result = state.entities.find((entity) => entity.id === demand.id)!;
    expect(getStationSlots(result)).toHaveLength(5);
    expect(result.outputs).toMatchObject({ iron_ingot: 25, copper_ingot: 25 });
    expect(result.stationTrips).toBe(2);
    expect(result.stationRoutes).toHaveLength(0);
  });

  it("copies monitored stacked-belt settings across a connected network", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_speed_logistics", "super_magnetic_logistics");
    state.belts = [
      { id: "stack_a", planetId: "home", source: "a", target: "b", itemId: "iron_ingot", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, lastFlow: 0 },
      { id: "stack_b", planetId: "home", source: "b", target: "c", itemId: "iron_ingot", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, lastFlow: 0 },
    ];
    state.construction.conveyor_belt_mk1 = 2;
    state.belts[0].lanes = 3;
    state.belts[1].progress = 0.75;
    state.belts[1].totalTransferred = 12;
    state.belts[1].lastFlow = 7.5;
    state = setBeltStackSize(state, "stack_a", 4);
    state = setBeltPriority(state, "stack_a", 2);
    state = setBeltMonitorEnabled(state, "stack_a", true);
    state = setBeltRouteMode(state, "stack_a", "manual");
    state = setBeltRouteOffsetY(state, "stack_a", 64);
    const applied = applyBeltConfigurationToBelts(state, "stack_a", ["stack_b"]);
    expect(applied).toMatchObject({ applied: 1, skipped: 0, failed: 0 });
    state = applied.state;

    expect(getBeltCapacity(state.belts[0])).toBe(72);
    expect(getBeltNetworkIds(state, "stack_a")).toEqual(["stack_a", "stack_b"]);
    expect(state.belts[1]).toMatchObject({ lanes: 3, stackSize: 4, priority: 2, monitorEnabled: true, routeMode: "manual", routeOffsetY: 64, progress: 0.75, totalTransferred: 12, lastFlow: 7.5 });
    expect(state.construction.conveyor_belt_mk1).toBe(0);
    expect(applyBeltConfigurationToBelts(state, "stack_a", ["stack_b"])).toMatchObject({ applied: 0, skipped: 1, failed: 0 });

    const blocked = applyBeltConfigurationToBelts({ ...state, construction: { ...state.construction, conveyor_belt_mk1: 0 }, belts: state.belts.map((belt) => belt.id === "stack_b" ? { ...belt, lanes: 1 } : belt) }, "stack_a", ["stack_b"]);
    expect(blocked.error).toContain("缺少传送带");
    expect(blocked).toMatchObject({ applied: 0, skipped: 0, failed: 1 });
    expect(blocked.state.belts.find((belt) => belt.id === "stack_b")?.lanes).toBe(1);
  });

  it("records station fleet targets in blueprints and partially loads from the portable fleet", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const source = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    source.stationDrones = 12;
    source.stationVessels = 3;
    state = createBlueprint(state, [source.id], "载具目标蓝图");
    const blueprint = state.blueprints[0];
    expect(blueprint.entities[0]).toMatchObject({ stationDroneTarget: 12, stationVesselTarget: 3 });
    state.portableFleet = { logistics_drone: 5, logistics_vessel: 2 };
    expect(getBlueprintFleetLoadPreview(state, blueprint.id)).toEqual({
      drones: { target: 12, loaded: 5, shortfall: 7 },
      vessels: { target: 3, loaded: 2, shortfall: 1 },
    });
    state = placeBlueprint(state, blueprint.id, { x: 500, y: 500 });
    const placed = state.entities.find((entity) => entity.id !== source.id && entity.buildingId === "interstellar_logistics_station")!;
    expect(placed).toMatchObject({ stationDrones: 5, stationVessels: 2, stationRoutes: [] });
    expect(state.portableFleet).toEqual({ logistics_drone: 0, logistics_vessel: 0 });
  });

  it("rotates, mirrors and parameterizes blueprint deployment while preserving external ports", () => {
    let state = createInitialState();
    state = placeBuilding(state, "assembling_machine_mk1", { x: 100, y: 100 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 300, y: 200 });
    const assemblers = state.entities.filter((entity) => entity.buildingId === "assembling_machine_mk1");
    state.belts.push({ id: "external_line", planetId: "home", source: assemblers[0].id, target: "vein_iron", itemId: "gear", lanes: 1, tier: 1, sorterTier: 1, progress: 0, priority: 0, lastFlow: 0 });
    state = createBlueprint(state, assemblers.map((entity) => entity.id), "旋转模板");
    const blueprintId = state.blueprints[0].id;
    expect(state.blueprints[0].externalPorts).toHaveLength(1);
    state = setBlueprintTransform(state, blueprintId, 90, "horizontal");
    state = setBlueprintRecipeOverride(state, blueprintId, "gear", "circuit_board");
    state.construction.assembling_machine_mk1 = 2;
    state = placeBlueprint(state, blueprintId, { x: 1000, y: 1000 });

    const deployed = state.entities.filter((entity) => entity.id.startsWith("entity_") && !assemblers.some((original) => original.id === entity.id));
    expect(deployed.map((entity) => entity.position)).toEqual(expect.arrayContaining([{ x: 1000, y: 1000 }, { x: 900, y: 800 }]));
    expect(deployed.every((entity) => entity.recipeId === "circuit_board")).toBe(true);
  });

  it("queues a missing-material blueprint and deploys it when construction stock arrives", () => {
    let state = createInitialState();
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    state = createBlueprint(state, [assembler.id], "待建制造台");
    const blueprintId = state.blueprints[0].id;
    state.construction.assembling_machine_mk1 = 0;
    state = queueBlueprint(state, blueprintId, { x: 720, y: 360 });
    const orderId = state.constructionQueue[0].id;
    expect(getConstructionQueueDeficits(state, orderId)[0]).toMatchObject({ constructionId: "assembling_machine_mk1", missing: 1 });
    state.construction.assembling_machine_mk1 = 1;
    state = processConstructionQueue(state);
    expect(state.constructionQueue).toEqual([]);
    expect(state.entities.some((entity) => entity.position.x === 720 && entity.position.y === 360)).toBe(true);

    state = queueBlueprint({ ...state, construction: { ...state.construction, assembling_machine_mk1: 0 } }, blueprintId, { x: 900, y: 360 });
    const pendingId = state.constructionQueue[0].id;
    state = cancelConstructionQueueEntry(state, pendingId);
    expect(state.constructionQueue).toEqual([]);
  });

  it("keeps exact-overlap placement safe by default and preserves explicit immediate, queued and drag intent", () => {
    let state = createInitialState();
    state.construction.assembling_machine_mk1 = 3;
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const source = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    state = createBlueprint(state, [source.id], "匿名重叠蓝图");
    const blueprintId = state.blueprints[0].id;

    expect(canQueueBlueprint(state, blueprintId, state.activePlanetId, { x: 0, y: 0 })).toBe(false);
    expect(queueBlueprint(state, blueprintId, { x: 0, y: 0 })).toBe(state);
    expect(canQueueBlueprint(state, blueprintId, state.activePlanetId, { x: 0, y: 0 }, { allowExactOverlap: true })).toBe(true);
    expect(hasExactEntityPositionOverlap(state, [{ id: source.id, position: { ...source.position } }])).toBe(false);

    const immediate = placeBlueprint(state, blueprintId, { x: 0, y: 0 }, { allowExactOverlap: true });
    expect(immediate.entities.filter((entity) => Math.round(entity.position.x) === 0 && Math.round(entity.position.y) === 0)).toHaveLength(2);

    const shortage = { ...state, construction: { ...state.construction, assembling_machine_mk1: 0 } };
    let queued = queueBlueprint(shortage, blueprintId, { x: 0, y: 0 }, { allowExactOverlap: true });
    queued = queueBlueprint(queued, blueprintId, { x: 0, y: 0 }, { allowExactOverlap: true });
    expect(queued.constructionQueue).toHaveLength(2);
    expect(queued.constructionQueue.every((entry) => entry.allowExactOverlap === true)).toBe(true);
    expect(queued.constructionQueue.every((entry) => getConstructionQueueDetails(queued, entry.id).compatible)).toBe(true);
    queued.construction.assembling_machine_mk1 = 2;
    queued = processConstructionQueue(queued);
    expect(queued.constructionQueue).toEqual([]);
    expect(queued.entities.filter((entity) => Math.round(entity.position.x) === 0 && Math.round(entity.position.y) === 0)).toHaveLength(3);

    // 1.0.43's v46 loader ignores unknown queue keys. Model that rollback by
    // dropping the opt-in while retaining a partially reserved order: the old
    // client must block the overlap and let cancellation conserve inventory.
    let rollbackQueue = queueBlueprint(shortage, blueprintId, { x: 0, y: 0 }, { allowExactOverlap: true });
    const rollbackEntry = rollbackQueue.constructionQueue[0];
    rollbackEntry.allowExactOverlap = undefined;
    rollbackEntry.reservedConstruction ??= {};
    rollbackEntry.reservedConstruction.assembling_machine_mk1 = 1;
    const rollbackTotalBefore = (rollbackQueue.construction.assembling_machine_mk1 ?? 0) +
      (rollbackEntry.reservedConstruction.assembling_machine_mk1 ?? 0);
    const rollbackEntities = structuredClone(rollbackQueue.entities);
    expect(getConstructionQueueDetails(rollbackQueue, rollbackEntry.id).compatible).toBe(false);
    rollbackQueue = cancelConstructionQueueEntry(rollbackQueue, rollbackEntry.id);
    expect(rollbackQueue.constructionQueue).toEqual([]);
    expect(rollbackQueue.entities).toEqual(rollbackEntities);
    expect(rollbackQueue.construction.assembling_machine_mk1).toBe(rollbackTotalBefore);

    const secondId = immediate.entities.find((entity) => entity.id !== source.id && entity.buildingId === "assembling_machine_mk1")!.id;
    expect(hasExactEntityPositionOverlap(immediate, [{ id: secondId, position: { x: 0, y: 0 } }])).toBe(true);
    expect(hasExactEntityPositionOverlap(immediate, [{ id: source.id, position: { ...source.position } }])).toBe(true);
    expect(hasExactEntityPositionOverlap(immediate, [
      { id: source.id, position: { x: 400, y: 0 } },
      { id: secondId, position: { x: 640, y: 0 } },
    ])).toBe(false);
    expect(hasExactEntityPositionOverlap(immediate, [
      { id: source.id, position: { x: 400, y: 0 } },
      { id: secondId, position: { x: 400.4, y: 0 } },
    ])).toBe(true);
  });

  it("reserves blueprint materials across repeated funding and refunds them exactly on cancellation", () => {
    let state = createInitialState();
    state.construction.storage_mk1 = 2;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 240, y: 0 });
    const storages = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    state = setLogisticsItem(state, storages[0].id, "gear");
    state = setLogisticsItem(state, storages[1].id, "gear");
    state = connectBelt(state, storages[0].id, storages[1].id, "gear");
    state = createBlueprint(state, storages.map((entity) => entity.id), "分批补足蓝图");
    const blueprintId = state.blueprints[0].id;
    state.construction.storage_mk1 = 1;
    state.construction.conveyor_belt_mk1 = 0;
    state = queueBlueprint(state, blueprintId, { x: 800, y: 500 });
    const orderId = state.constructionQueue[0].id;

    state = fundConstructionQueueEntry(state, orderId, "construction");
    expect(state.constructionQueue[0].reservedConstruction).toEqual({ storage_mk1: 1, conveyor_belt_mk1: 0 });
    expect(state.construction.storage_mk1).toBe(0);
    expect(state.entities.filter((entity) => entity.position.y === 500)).toHaveLength(0);

    state.construction.conveyor_belt_mk1 = 1;
    state = fundConstructionQueueEntry(state, orderId, "construction");
    expect(state.constructionQueue[0].reservedConstruction).toEqual({ storage_mk1: 1, conveyor_belt_mk1: 1 });
    state = cancelConstructionQueueEntry(state, orderId);
    expect(state.constructionQueue).toEqual([]);
    expect(state.construction.storage_mk1).toBe(1);
    expect(state.construction.conveyor_belt_mk1).toBe(1);
    expect(state.blueprintVersions).toEqual([]);
  });

  it("keeps queued blueprint revisions immutable after library edits or deletion", () => {
    let state = createInitialState();
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    state = createBlueprint(state, [assembler.id], "不可变版本");
    const blueprintId = state.blueprints[0].id;
    state.construction.assembling_machine_mk1 = 0;
    state = queueBlueprint(state, blueprintId, { x: 900, y: 600 });
    const orderId = state.constructionQueue[0].id;
    const versionId = state.constructionQueue[0].blueprintVersionId;

    state = renameBlueprint(state, blueprintId, "已修改蓝图");
    state = setBlueprintTransform(state, blueprintId, 90, "horizontal");
    state = removeBlueprint(state, blueprintId);
    expect(state.blueprints).toEqual([]);
    expect(getConstructionQueueDetails(state, orderId).blueprint).toMatchObject({ name: "不可变版本", rotation: 0, mirror: "none" });
    expect(state.blueprintVersions[0].id).toBe(versionId);

    state.construction.assembling_machine_mk1 = 1;
    state = fundConstructionQueueEntry(state, orderId, "construction");
    expect(state.entities.some((entity) => entity.position.x === 900 && entity.position.y === 600)).toBe(true);
    expect(state.constructionQueue).toEqual([]);
    expect(state.blueprintVersions).toEqual([]);
  });

  it("keeps fleet optional during construction and installs it later without touching unreserved vehicles", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const source = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    source.stationDrones = 5;
    source.stationVessels = 3;
    state = createBlueprint(state, [source.id], "载具后补蓝图");
    const blueprintId = state.blueprints[0].id;
    state.construction.interstellar_logistics_station = 1;
    state.portableFleet = { logistics_drone: 20, logistics_vessel: 20 };
    state = queueBlueprint(state, blueprintId, { x: 700, y: 700 });
    const orderId = state.constructionQueue[0].id;

    state = fundConstructionQueueEntry(state, orderId, "construction");
    const placed = state.entities.find((entity) => entity.position.x === 700 && entity.position.y === 700)!;
    expect(placed).toMatchObject({ stationDrones: 0, stationVessels: 0 });
    expect(state.portableFleet).toEqual({ logistics_drone: 20, logistics_vessel: 20 });
    expect(state.constructionQueue[0]).toMatchObject({ status: "waiting-fleet", reservedConstruction: {}, reservedFleet: {} });

    state = fundConstructionQueueEntry(state, orderId, "fleet");
    expect(state.entities.find((entity) => entity.id === placed.id)).toMatchObject({ stationDrones: 5, stationVessels: 3 });
    expect(state.portableFleet).toEqual({ logistics_drone: 15, logistics_vessel: 17 });
    expect(state.constructionQueue).toEqual([]);
  });

  it("funds competing construction orders in stable creation order without duplicate placement", () => {
    let state = createInitialState();
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    state = createBlueprint(state, [assembler.id], "竞争订单");
    const blueprintId = state.blueprints[0].id;
    state.construction.assembling_machine_mk1 = 0;
    state = queueBlueprint(state, blueprintId, { x: 700, y: 300 });
    state = queueBlueprint(state, blueprintId, { x: 900, y: 300 });
    const [firstOrder, secondOrder] = state.constructionQueue.map((entry) => entry.id);

    state.construction.assembling_machine_mk1 = 1;
    state = fundAllConstructionQueueEntries(state);
    expect(state.entities.some((entity) => entity.position.x === 700 && entity.position.y === 300)).toBe(true);
    expect(state.entities.some((entity) => entity.position.x === 900 && entity.position.y === 300)).toBe(false);
    expect(state.constructionQueue.map((entry) => entry.id)).toEqual([secondOrder]);
    expect(state.constructionQueue.some((entry) => entry.id === firstOrder)).toBe(false);

    state.construction.assembling_machine_mk1 = 1;
    state = fundAllConstructionQueueEntries(state);
    expect(state.entities.filter((entity) => entity.position.y === 300)).toHaveLength(2);
    expect(state.constructionQueue).toEqual([]);
    expect(state.construction.assembling_machine_mk1).toBe(0);
  });

  it("blocks a queued deployment if its position becomes occupied and cancels fleet follow-up when its tower is removed", () => {
    let state = createInitialState();
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    state = createBlueprint(state, [assembler.id], "重叠保护");
    const blueprintId = state.blueprints[0].id;
    state.construction.assembling_machine_mk1 = 0;
    state = queueBlueprint(state, blueprintId, { x: 800, y: 200 });
    const orderId = state.constructionQueue[0].id;
    state.construction.assembling_machine_mk1 = 2;
    state = placeBuilding(state, "assembling_machine_mk1", { x: 800, y: 200 });
    const unchanged = fundConstructionQueueEntry(state, orderId, "construction");
    expect(unchanged).toBe(state);
    expect(getConstructionQueueDetails(state, orderId)).toMatchObject({ compatible: false, blockedReason: "放置位置、行星或资源锚点已不兼容" });
    state = cancelConstructionQueueEntry(state, orderId);

    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 500 });
    const source = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    source.stationDrones = 2;
    state = createBlueprint(state, [source.id], "拆塔取消补足");
    const stationBlueprintId = state.blueprints.at(-1)!.id;
    state.construction.interstellar_logistics_station = 1;
    state.portableFleet.logistics_drone = 0;
    state = queueBlueprint(state, stationBlueprintId, { x: 600, y: 600 });
    const fleetOrderId = state.constructionQueue[0].id;
    state = fundConstructionQueueEntry(state, fleetOrderId, "construction");
    const placedTower = state.entities.find((entity) => entity.position.x === 600 && entity.position.y === 600)!;
    expect(state.constructionQueue[0].status).toBe("waiting-fleet");
    state = removeEntity(state, placedTower.id);
    expect(state.constructionQueue).toEqual([]);
    expect(state.blueprintVersions).toEqual([]);
  });

  it("applies logistics engine and cargo upgrades to real station dispatches", () => {
    let state = createInitialState();
    state.research.completedTechIds.push(
      "logistics_engine_1",
      "logistics_engine_2",
      "logistics_capacity_1",
      "logistics_capacity_2",
    );
    state.construction.wind_turbine = 4;
    state.construction.planetary_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 4);
    state = placeBuilding(state, "planetary_logistics_station", { x: -200, y: 0 });
    state = placeBuilding(state, "planetary_logistics_station", { x: 300, y: 0 });
    const [supply, demand] = state.entities.filter((entity) => entity.buildingId === "planetary_logistics_station");
    state = setLogisticsItem(state, supply.id, "processor");
    state = setLogisticsItem(state, demand.id, "processor");
    state = setStationMode(state, demand.id, "demand");
    state = setStationMinimumLoad(state, demand.id, 1);
    state.entities.find((entity) => entity.id === supply.id)!.outputs.processor = 100;
    state.portableFleet.logistics_drone = 1;
    state = adjustStationDrones(state, demand.id, 1);

    expect(getLogisticsSpeedMultiplier(state)).toBe(2);
    expect(getPlanetaryCargoCapacity(state)).toBe(50);
    expect(getInterstellarCargoCapacity(state)).toBe(200);
    expect(getPlanetaryTripSeconds(state)).toBe(4);
    expect(getInterstellarTripSeconds(state)).toBe(15);
    expect(getInterstellarTripSeconds(state, true)).toBe(6);
    state = advanceSimulation(state, 4.1);

    expect(state.entities.find((entity) => entity.id === supply.id)?.outputs.processor).toBe(50);
    expect(state.entities.find((entity) => entity.id === demand.id)?.outputs.processor).toBe(50);
    expect(state.entities.find((entity) => entity.id === demand.id)?.stationLastTransfer).toBe(50);
  });

  it("collects gas-giant hydrogen and supplies an interstellar demand station", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.orbital_collector = 1;
    state.construction.interstellar_logistics_station = 1;
    state.construction.wind_turbine = 4;
    state = setActivePlanet(state, "giant");
    state = placeBuilding(state, "orbital_collector", { x: 0, y: 0 });
    const collectorId = state.entities.find((entity) => entity.buildingId === "orbital_collector")!.id;
    state = setActivePlanet(state, "home");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const stationId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!.id;
    state = setLogisticsItem(state, stationId, "hydrogen");
    state = setStationMode(state, stationId, "demand");
    state = setStationMinimumLoad(state, stationId, 0.1);
    state.portableFleet.logistics_vessel = 1;
    state = adjustStationVessels(state, stationId, 1);
    const expectedTripSeconds = getInterstellarRouteEconomics(
      state,
      state.entities.find((entity) => entity.id === collectorId)!,
      state.entities.find((entity) => entity.id === stationId)!,
      1,
    ).durationSeconds;
    state = advanceSimulation(state, Math.ceil(expectedTripSeconds) + 12);

    const collector = state.entities.find((entity) => entity.id === collectorId)!;
    const station = state.entities.find((entity) => entity.id === stationId)!;
    expect(state.totalProduced.hydrogen).toBeGreaterThan(40);
    expect(station.outputs.hydrogen).toBeGreaterThanOrEqual(10);
    expect(collector.outputs.hydrogen).toBeLessThan(40);
    expect(station.stationTrips).toBe(1);
    expect(Number.isInteger(station.outputs.hydrogen ?? 0)).toBe(true);
  });

  it("treats orbital collectors as self-powered and reports a saturated vessel fleet without false power alarms", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.orbital_collector = 1;
    state.construction.interstellar_logistics_station = 1;
    state.construction.wind_turbine = 80;
    state = setActivePlanet(state, "giant");
    state = placeBuilding(state, "orbital_collector", { x: 0, y: 0 });
    const collectorId = state.entities.find((entity) => entity.buildingId === "orbital_collector")!.id;
    state.entities.find((entity) => entity.id === collectorId)!.outputs.hydrogen = 10_000;
    state = setActivePlanet(state, "home");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 80);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const stationId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!.id;
    state = setLogisticsItem(state, stationId, "hydrogen");
    state = setStationMode(state, stationId, "demand");
    state = setStationMinimumLoad(state, stationId, 0.1);
    state.portableFleet.logistics_vessel = 10;
    state = adjustStationVessels(state, stationId, 10);
    expect(getEntityPowerFactor(state, state.entities.find((entity) => entity.id === collectorId)!)).toBe(1);

    state = advanceSimulation(state, 0.1);
    expect(getStationFleetDiagnostic(state, stationId)?.vessels).toMatchObject({ installed: 10, busy: 10, available: 0, blockerCode: "all-busy" });
    expect(state.entities.find((entity) => entity.id === stationId)?.stationRoutes?.every((route) => !route.requiresWarp && (route.warpersPerVessel ?? 0) === 0)).toBe(true);
    for (let second = 0; second < 45; second += 1) {
      const status = getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === stationId)!);
      expect(["no-power", "low-power"]).not.toContain(status.code);
      state = advanceSimulation(state, 1);
    }
    expect(state.entities.find((entity) => entity.id === stationId)?.stationTrips).toBe(10);
  });

  it("loads, toggles and refunds a station warper reserve", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("space_warp");
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const stationId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!.id;
    state.tray.space_warper = 3;
    state = adjustStationWarpers(state, stationId, 2);
    expect(state.entities.find((entity) => entity.id === stationId)?.stationWarpers).toBe(2);
    expect(state.tray.space_warper).toBe(1);
    state = setStationWarpEnabled(state, stationId, false);
    expect(state.entities.find((entity) => entity.id === stationId)?.stationWarpEnabled).toBe(false);
    state = removeEntity(state, stationId);
    expect(state.tray.space_warper).toBe(3);
  });

  it("auto-refills interstellar stations only from their own planet tray without double spending", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("space_warp");
    state.exploration.colonizedPlanetIds.push("ashen");
    state.construction.interstellar_logistics_station = 3;
    state = placeBuilding(state, "interstellar_logistics_station", { x: -180, y: 0 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: 180, y: 0 });
    const homeStations = state.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station");
    for (const station of homeStations) {
      state = setStationWarperTarget(state, station.id, 5);
      state = setStationWarperAutoRefill(state, station.id, true);
    }
    state.tray.space_warper = 7;

    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const remoteStation = state.entities.find((entity) => entity.planetId === "ashen" && entity.buildingId === "interstellar_logistics_station")!;
    state = setStationWarperTarget(state, remoteStation.id, 3);
    state = setStationWarperAutoRefill(state, remoteStation.id, true);
    state.tray.space_warper = 3;
    state = setActivePlanet(state, "home");

    state = advanceSimulation(state, 1);
    expect(state.entities.find((entity) => entity.id === homeStations[0].id)?.stationWarpers).toBe(5);
    expect(state.entities.find((entity) => entity.id === homeStations[1].id)?.stationWarpers).toBe(2);
    expect(state.entities.find((entity) => entity.id === remoteStation.id)?.stationWarpers).toBe(3);
    expect(state.tray.space_warper).toBe(0);
    expect(state.planetTrays.ashen.space_warper).toBe(0);

    state.planetTrays.ashen.space_warper = 4;
    state = advanceSimulation(state, 1);
    expect(state.entities.find((entity) => entity.id === homeStations[1].id)?.stationWarpers).toBe(2);
    expect(state.entities.find((entity) => entity.id === remoteStation.id)?.stationWarpers).toBe(3);
    expect(state.planetTrays.ashen.space_warper).toBe(4);
  });

  it("deducts and refunds warp fuel from a supply-owned interstellar vessel", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics", "space_warp");
    state.exploration.unlockedSystemIds.push("borealis");
    state.exploration.colonizedPlanetIds.push("frost");
    state.construction.wind_turbine = 8;
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: -160, y: -180 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const supply = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, supply.id, "processor");
    state.entities.find((entity) => entity.id === supply.id)!.outputs.processor = 100;
    state.portableFleet.logistics_vessel = 1;
    state.tray.space_warper = 4;
    state = adjustStationVessels(state, supply.id, 1);
    state = adjustStationWarpers(state, supply.id, 4);

    state = setActivePlanet(state, "frost");
    state = placeBuilding(state, "wind_turbine", { x: -160, y: -180 }, 4);
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const demand = state.entities.find((entity) => entity.planetId === "frost" && entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, demand.id, "processor");
    state = setStationSlotMode(state, demand.id, 0, "remote", "demand");
    state = setStationSlotMinimumLoad(state, demand.id, 0, 1);

    state = advanceSimulation(state, 0.1);
    const route = state.entities.find((entity) => entity.id === demand.id)!.stationRoutes?.[0]!;
    const warpersPerVessel = route.warpersPerVessel ?? 0;
    expect(route).toMatchObject({ vehicleStationId: supply.id, requiresWarp: true, vehicleCount: 1 });
    expect(state.entities.find((entity) => entity.id === supply.id)?.stationWarpers).toBe(4 - warpersPerVessel);

    state = setStationSlotMode(state, demand.id, 0, "remote", "storage");
    expect(state.entities.find((entity) => entity.id === demand.id)?.stationRoutes).toEqual([]);
    expect(state.entities.find((entity) => entity.id === supply.id)?.stationWarpers).toBe(4);
  });

  it("auto-configures each remaining logistics slot and reports a full station precisely", () => {
    let state = createInitialState();
    state.construction.planetary_logistics_station = 1;
    state.construction.storage_mk1 = 6;
    state.construction.conveyor_belt_mk1 = 6;
    state = placeBuilding(state, "planetary_logistics_station", { x: 0, y: 0 });
    const station = state.entities.find((entity) => entity.buildingId === "planetary_logistics_station")!;
    const itemIds = ["iron_ingot", "copper_ingot", "stone_brick", "steel", "gear", "circuit_board"] as const;
    const sources = itemIds.map((itemId, index) => {
      state = placeBuilding(state, "storage_mk1", { x: -320, y: -240 + index * 96 });
      const source = state.entities.filter((entity) => entity.buildingId === "storage_mk1").at(-1)!;
      state = setLogisticsItem(state, source.id, itemId);
      state.entities.find((entity) => entity.id === source.id)!.outputs[itemId] = 1;
      return source.id;
    });

    for (let index = 0; index < 5; index += 1) {
      expect(getBeltConnectionCheck(state, sources[index], station.id, itemIds[index])).toMatchObject({ ok: true, code: "ready" });
      state = connectBelt(state, sources[index], station.id, itemIds[index]);
    }
    expect(getStationSlots(state.entities.find((entity) => entity.id === station.id)!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "iron_ingot" }),
      expect.objectContaining({ itemId: "copper_ingot" }),
      expect.objectContaining({ itemId: "stone_brick" }),
      expect.objectContaining({ itemId: "steel" }),
      expect.objectContaining({ itemId: "gear" }),
    ]));
    expect(getBeltConnectionCheck(state, sources[5], station.id, itemIds[5])).toEqual({
      ok: false,
      code: "station-slots-full",
      label: "物流站没有可用空槽",
    });
  });

  it("treats legacy sorter upgrades as no-ops because belts now transfer directly", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("high_speed_logistics");
    state.construction.conveyor_belt_mk1 = 2;
    state.construction.sorter_mk2 = 2;
    state = placeBuilding(state, "arc_smelter", { x: 200, y: 0 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = connectBelt(state, "vein_iron", smelter.id, "iron_ore");
    state = connectBelt(state, "vein_iron", smelter.id, "iron_ore");
    const beltId = state.belts[0].id;
    expect(getBeltCapacity(state.belts[0])).toBe(12);
    expect(getSorterCapacity(state.belts[0])).toBe(12);
    expect(canUpgradeSorter(state, beltId)).toBe(false);
    state = upgradeSorter(state, beltId);
    expect(state.belts[0]).toMatchObject({ tier: 1, sorterTier: 1, lanes: 2 });
    expect(getBeltCapacity(state.belts[0])).toBe(12);
    expect(state.construction.sorter_mk2).toBe(2);
  });

  it("restricts gas-giant construction to orbital collectors", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.wind_turbine = 1;
    state.construction.orbital_collector = 1;
    state = setActivePlanet(state, "giant");
    const unchanged = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    expect(unchanged).toBe(state);
    state = placeBuilding(state, "orbital_collector", { x: 0, y: 0 });
    expect(state.entities.filter((entity) => entity.planetId === "giant")).toHaveLength(1);
    expect(state.construction.orbital_collector).toBe(0);
  });

  it("applies planetary solar output and restricts geothermal plants to the lava planet", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.solar_panel = 2;
    state.construction.geothermal_power_station = 2;
    state = placeBuilding(state, "solar_panel", { x: 0, y: 0 });
    expect(placeBuilding(state, "geothermal_power_station", { x: 200, y: 0 })).toBe(state);
    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "solar_panel", { x: 0, y: 0 });
    state = placeBuilding(state, "geothermal_power_station", { x: 200, y: 0 });
    state = advanceSimulation(state, 1);

    expect(state.planetMetrics.home.solarGenerationKw).toBe(360);
    expect(state.planetMetrics.home.geothermalGenerationKw).toBe(0);
    expect(state.planetMetrics.ashen.solarGenerationKw).toBe(540);
    expect(state.planetMetrics.ashen.geothermalGenerationKw).toBe(4800);
  });

  it("charges stationary accumulators from surplus and discharges them into a grid deficit", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 2;
    state.construction.accumulator = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 2);
    state = placeBuilding(state, "accumulator", { x: 220, y: 0 });
    state = advanceSimulation(state, 10);
    let accumulator = state.entities.find((entity) => entity.buildingId === "accumulator")!;
    expect(accumulator.storedEnergyMj).toBeCloseTo(6, 4);
    expect(state.metrics.storageChargeKw).toBe(600);

    state = installMiner(state, "vein_iron", 2);
    state = advanceSimulation(state, 5);
    accumulator = state.entities.find((entity) => entity.buildingId === "accumulator")!;
    expect(accumulator.storedEnergyMj).toBeCloseTo(4.8, 4);
    expect(state.metrics.storageDischargeKw).toBe(240);
    expect(state.metrics.powerFactor).toBe(1);
  });

  it("dispatches fusion and artificial-star generators with their dedicated fuel", () => {
    let state = createInitialState();
    state.construction.mini_fusion_power_plant = 1;
    state.construction.artificial_star = 1;
    state = placeBuilding(state, "mini_fusion_power_plant", { x: 0, y: 0 });
    state = placeBuilding(state, "artificial_star", { x: 220, y: 0 });
    const fusion = state.entities.find((entity) => entity.buildingId === "mini_fusion_power_plant")!;
    const star = state.entities.find((entity) => entity.buildingId === "artificial_star")!;
    expect(setFuelItem(state, fusion.id, "coal")).toBe(state);
    state = setFuelItem(state, fusion.id, "deuteron_fuel_rod");
    state = setFuelItem(state, star.id, "antimatter_fuel_rod");
    state.entities.find((entity) => entity.id === fusion.id)!.inputs.deuteron_fuel_rod = 1;
    state.entities.find((entity) => entity.id === star.id)!.inputs.antimatter_fuel_rod = 1;
    state = installMiner(state, "vein_iron", 2);
    state = advanceSimulation(state, 1);

    expect(state.metrics.fusionGenerationKw).toBeGreaterThan(0);
    expect(state.metrics.artificialStarGenerationKw).toBeGreaterThan(0);
    expect(state.metrics.fusionGenerationKw + state.metrics.artificialStarGenerationKw).toBe(840);
    expect(state.entities.find((entity) => entity.id === fusion.id)?.fuelRemainingMj).toBeGreaterThan(0);
    expect(state.entities.find((entity) => entity.id === star.id)?.fuelRemainingMj).toBeGreaterThan(0);
  });

  it("charges and discharges transportable accumulators through an energy exchanger", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 150;
    state.construction.energy_exchanger = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 }, 150);
    state = placeBuilding(state, "energy_exchanger", { x: 260, y: 0 });
    const exchangerId = state.entities.find((entity) => entity.buildingId === "energy_exchanger")!.id;
    state.entities.find((entity) => entity.id === exchangerId)!.inputs.accumulator = 1;
    state = advanceSimulation(state, 1);
    expect(state.entities.find((entity) => entity.id === exchangerId)?.storedEnergyMj).toBe(45);
    expect(setEnergyMode(state, exchangerId, "discharge")).toBe(state);
    state = advanceSimulation(state, 1);
    let exchanger = state.entities.find((entity) => entity.id === exchangerId)!;
    expect(exchanger.outputs.charged_accumulator).toBe(1);
    expect(exchanger.storedEnergyMj).toBe(0);

    state = setEnergyMode(state, exchangerId, "discharge");
    expect(state.tray.charged_accumulator).toBe(1);
    state.tray.charged_accumulator = 0;
    state.entities.find((entity) => entity.id === exchangerId)!.inputs.charged_accumulator = 1;
    state.entities.find((entity) => entity.buildingId === "wind_turbine")!.machineCount = 0;
    state = installMiner(state, "vein_iron", 2);
    state = advanceSimulation(state, 108);
    exchanger = state.entities.find((entity) => entity.id === exchangerId)!;
    expect(exchanger.inputs.charged_accumulator).toBe(0);
    expect(exchanger.outputs.accumulator).toBe(1);
    expect(exchanger.storedEnergyMj).toBe(0);
  });

  it("fractionates hydrogen into deuterium while returning the remaining hydrogen", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("fractionation");
    state.construction.wind_turbine = 3;
    state.construction.fractionator = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 3);
    state = placeBuilding(state, "fractionator", { x: 0, y: 0 });
    const fractionator = state.entities.find((entity) => entity.buildingId === "fractionator")!;
    fractionator.inputs.hydrogen = 20;
    state = advanceSimulation(state, 2);

    const result = state.entities.find((entity) => entity.id === fractionator.id)!;
    expect(result.inputs.hydrogen).toBe(0);
    expect(result.outputs).toMatchObject({ hydrogen: 18, deuterium: 2 });
    expect(result.productionRate).toBe(600);
  });

  it("manufactures hydrogen fuel rods and burns them in thermal power plants", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("fractionation");
    state.construction.wind_turbine = 1;
    state.construction.assembling_machine_mk1 = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 0, y: 0 });
    const assembler = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    state = setEntityRecipe(state, assembler.id, "hydrogen_fuel_rod");
    state.entities.find((entity) => entity.id === assembler.id)!.inputs = { titanium_ingot: 1, hydrogen: 10 };
    state = advanceSimulation(state, 8);
    expect(state.entities.find((entity) => entity.id === assembler.id)?.outputs.hydrogen_fuel_rod).toBe(2);

    state.construction.thermal_power_plant = 1;
    state = placeBuilding(state, "thermal_power_plant", { x: 250, y: 0 });
    const thermal = state.entities.find((entity) => entity.buildingId === "thermal_power_plant")!;
    state = setFuelItem(state, thermal.id, "hydrogen_fuel_rod");
    expect(state.entities.find((entity) => entity.id === thermal.id)?.fuelItemId).toBe("hydrogen_fuel_rod");
  });

  it("runs every rare-resource alternative recipe", () => {
    const cases = [
      { buildingId: "chemical_plant", recipeId: "graphene_from_fire_ice", inputs: { fire_ice: 2 }, outputs: { graphene: 2, hydrogen: 1 }, seconds: 2 },
      { buildingId: "arc_smelter", recipeId: "diamond_from_kimberlite", inputs: { kimberlite_ore: 1 }, outputs: { diamond: 2 }, seconds: 1.5 },
      { buildingId: "arc_smelter", recipeId: "crystal_silicon_from_fractal", inputs: { fractal_silicon: 1 }, outputs: { crystal_silicon: 2 }, seconds: 1.5 },
      { buildingId: "assembling_machine_mk1", recipeId: "photon_combiner_from_grating", inputs: { optical_grating_crystal: 1, circuit_board: 1 }, outputs: { photon_combiner: 1 }, seconds: 4 },
      { buildingId: "assembling_machine_mk1", recipeId: "casimir_crystal_advanced", inputs: { optical_grating_crystal: 4, graphene: 2, hydrogen: 12 }, outputs: { casimir_crystal: 1 }, seconds: 6 },
      { buildingId: "chemical_plant", recipeId: "carbon_nanotube_from_spiniform", inputs: { spiniform_stalagmite_crystal: 6 }, outputs: { carbon_nanotube: 2 }, seconds: 4 },
      { buildingId: "assembling_machine_mk1", recipeId: "particle_container_from_unipolar", inputs: { unipolar_magnet: 10, copper_ingot: 2 }, outputs: { particle_container: 1 }, seconds: 6 },
    ] as const;

    for (const definition of cases) {
      let state = createInitialState();
      state.research.completedTechIds.push("rare_resource_utilization");
      state.construction.wind_turbine = 8;
      state.construction[definition.buildingId] = 1;
      state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 8);
      state = placeBuilding(state, definition.buildingId, { x: 0, y: 0 });
      const machine = state.entities.find((entity) => entity.buildingId === definition.buildingId)!;
      state = setEntityRecipe(state, machine.id, definition.recipeId);
      state.entities.find((entity) => entity.id === machine.id)!.inputs = { ...definition.inputs };
      state = advanceSimulation(state, definition.seconds);
      expect(state.entities.find((entity) => entity.id === machine.id)?.outputs, definition.recipeId).toMatchObject(definition.outputs);
    }
  });

  it("upgrades a chemical plant in place and doubles its recipe speed", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("polymer_chemistry", "quantum_chemical_engineering");
    state.construction.wind_turbine = 8;
    state.construction.chemical_plant = 1;
    state.construction.quantum_chemical_plant = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -200 }, 8);
    state = placeBuilding(state, "chemical_plant", { x: 0, y: 0 });
    const chemical = state.entities.find((entity) => entity.buildingId === "chemical_plant")!;
    state = setEntityRecipe(state, chemical.id, "organic_crystal");
    state.entities.find((entity) => entity.id === chemical.id)!.inputs = { plastic: 2, refined_oil: 1, water: 1 };
    expect(canUpgradeEntity(state, chemical.id)).toBe(true);
    state = upgradeEntity(state, chemical.id);
    state = advanceSimulation(state, 3);

    expect(state.entities.find((entity) => entity.id === chemical.id)).toMatchObject({
      buildingId: "quantum_chemical_plant",
      recipeId: "organic_crystal",
      outputs: { organic_crystal: 1 },
    });
  });

  it("collects fire ice from a gas giant orbital collector", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.orbital_collector = 1;
    state = setActivePlanet(state, "giant");
    state = placeBuilding(state, "orbital_collector", { x: 0, y: 0 });
    const collector = state.entities.find((entity) => entity.buildingId === "orbital_collector")!;
    state = setLogisticsItem(state, collector.id, "fire_ice");
    state = advanceSimulation(state, 2);

    expect(state.entities.find((entity) => entity.id === collector.id)).toMatchObject({
      storedItemId: "fire_ice",
      outputs: { fire_ice: 1 },
      productionRate: 30,
    });
  });

  it("auto-configures three delivery-hub inputs and drains every delivered item into the local tray", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("basic_logistics", "material_delivery_logistics");
    state.construction.storage_mk1 = 3;
    state.construction.material_delivery_hub = 1;
    state.construction.conveyor_belt_mk1 = 3;
    state = placeBuilding(state, "storage_mk1", { x: -420, y: -160 });
    state = placeBuilding(state, "storage_mk1", { x: -420, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: -420, y: 160 });
    state = placeBuilding(state, "material_delivery_hub", { x: 0, y: 0 });
    const sources = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    const hub = state.entities.find((entity) => entity.buildingId === "material_delivery_hub")!;
    const itemIds = ["iron_ingot", "copper_ingot", "stone_brick"] as const;
    for (let index = 0; index < sources.length; index += 1) {
      state = setLogisticsItem(state, sources[index].id, itemIds[index]);
      state.entities.find((entity) => entity.id === sources[index].id)!.outputs[itemIds[index]] = 5;
      state = connectBelt(state, sources[index].id, hub.id, itemIds[index]);
    }
    expect(getMaterialDeliveryItems(state.entities.find((entity) => entity.id === hub.id)!)).toEqual(itemIds);
    state = advanceSimulation(state, 2);
    expect(state.tray).toMatchObject({ iron_ingot: 5, copper_ingot: 5, stone_brick: 5 });
    expect(state.entities.find((entity) => entity.id === hub.id)?.inputs).toMatchObject({ iron_ingot: 0, copper_ingot: 0, stone_brick: 0 });
  });

  it("reconfigures one delivery-hub port with confirmation while preserving every other line and buffered item", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("basic_logistics", "material_delivery_logistics");
    state.construction.storage_mk1 = 2;
    state.construction.material_delivery_hub = 1;
    state.construction.conveyor_belt_mk1 = 2;
    state = placeBuilding(state, "storage_mk1", { x: -320, y: -100 });
    state = placeBuilding(state, "storage_mk1", { x: -320, y: 100 });
    state = placeBuilding(state, "material_delivery_hub", { x: 0, y: 0 });
    const [ironSource, copperSource] = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    const hub = state.entities.find((entity) => entity.buildingId === "material_delivery_hub")!;
    state = setLogisticsItem(state, ironSource.id, "iron_ingot");
    state = setLogisticsItem(state, copperSource.id, "copper_ingot");
    state = connectBelt(state, ironSource.id, hub.id, "iron_ingot", 1, 0);
    state = connectBelt(state, copperSource.id, hub.id, "copper_ingot", 1, 1);
    state.entities.find((entity) => entity.id === hub.id)!.inputs.iron_ingot = 7;

    const check = getMaterialDeliverySlotChangeCheck(state, hub.id, 0, "manual", "stone_brick");
    expect(check).toMatchObject({ ok: true, requiresDisconnect: true, connectedBelts: 1, bufferedItems: 7 });
    expect(setMaterialDeliverySlot(state, hub.id, 0, "manual", "stone_brick")).toBe(state);

    const stockBefore = state.construction.conveyor_belt_mk1 ?? 0;
    state = setMaterialDeliverySlot(state, hub.id, 0, "manual", "stone_brick", true);
    const changedHub = state.entities.find((entity) => entity.id === hub.id)!;
    expect(getMaterialDeliverySlots(changedHub)).toEqual([
      { itemId: "stone_brick", mode: "manual" },
      { itemId: "copper_ingot", mode: "auto" },
      { itemId: null, mode: "auto" },
    ]);
    expect(state.belts).toHaveLength(1);
    expect(state.belts[0]).toMatchObject({ target: hub.id, itemId: "copper_ingot", targetPortIndex: 1 });
    expect(state.construction.conveyor_belt_mk1).toBe(stockBefore + 1);
    expect(state.tray.iron_ingot).toBe(7);
    expect(changedHub.inputs.iron_ingot).toBeUndefined();

    state = setMaterialDeliverySlot(state, hub.id, 0, "disabled");
    expect(getMaterialDeliverySlots(state.entities.find((entity) => entity.id === hub.id)!)[0]).toEqual({ itemId: null, mode: "disabled" });
    state = setMaterialDeliverySlot(state, hub.id, 0, "auto");
    expect(getMaterialDeliverySlots(state.entities.find((entity) => entity.id === hub.id)!)[0]).toEqual({ itemId: null, mode: "auto" });
  });

  it("treats the delivery hub as tray-backed pass-through above its 900-item building buffer", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("basic_logistics", "material_delivery_logistics", "super_magnetic_logistics");
    state.construction.storage_mk1 = 1;
    state.construction.material_delivery_hub = 1;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "storage_mk1", { x: -320, y: 0 });
    state = placeBuilding(state, "material_delivery_hub", { x: 0, y: 0 });
    const source = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const hub = state.entities.find((entity) => entity.buildingId === "material_delivery_hub")!;
    state = setLogisticsItem(state, source.id, "iron_ingot");
    state.entities.find((entity) => entity.id === source.id)!.outputs.iron_ingot = 6_000;
    state = connectBelt(state, source.id, hub.id, "iron_ingot");
    const belt = state.belts[0];
    belt.tier = 3;
    belt.sorterTier = 3;
    belt.lanes = 64;
    belt.stackSize = 4;
    state = setPlanetTrayItemLimit(state, "home", 5_000);

    state = advanceSimulation(state, 10);
    expect(state.tray.iron_ingot).toBe(5_000);
    expect(state.entities.find((entity) => entity.id === source.id)?.outputs.iron_ingot).toBe(1_000);
    expect(state.entities.find((entity) => entity.id === hub.id)?.inputs.iron_ingot ?? 0).toBe(0);
    expect(getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === hub.id)!)).toMatchObject({ code: "output-blocked" });
  });

  it("defaults delivery-hub inputs below ordinary lines and preserves a manual priority override", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("basic_logistics", "material_delivery_logistics");
    state.construction.storage_mk1 = 1;
    state.construction.arc_smelter = 1;
    state.construction.material_delivery_hub = 1;
    state.construction.conveyor_belt_mk1 = 2;
    state = placeBuilding(state, "storage_mk1", { x: -320, y: 0 });
    state = placeBuilding(state, "arc_smelter", { x: 0, y: -160 });
    state = placeBuilding(state, "material_delivery_hub", { x: 0, y: 160 });
    const source = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const ordinaryTarget = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    const hub = state.entities.find((entity) => entity.buildingId === "material_delivery_hub")!;
    state = setLogisticsItem(state, source.id, "iron_ore");
    state.entities.find((entity) => entity.id === source.id)!.outputs.iron_ore = 2;
    state.entities.find((entity) => entity.id === ordinaryTarget.id)!.inputs.iron_ore = getBuilding("arc_smelter").inputCapacity - 1;
    state = connectBelt(state, source.id, ordinaryTarget.id, "iron_ore");
    state = connectBelt(state, source.id, hub.id, "iron_ore");
    const ordinaryBelt = state.belts.find((belt) => belt.target === ordinaryTarget.id)!;
    const hubBelt = state.belts.find((belt) => belt.target === hub.id)!;
    expect(ordinaryBelt.priority).toBe(1);
    expect(hubBelt.priority).toBe(0);

    state = advanceSimulation(state, 1);
    expect({
      ordinaryInput: state.entities.find((entity) => entity.id === ordinaryTarget.id)?.inputs.iron_ore,
      hubInput: state.entities.find((entity) => entity.id === hub.id)?.inputs.iron_ore,
      sourceOutput: state.entities.find((entity) => entity.id === source.id)?.outputs.iron_ore,
      tray: state.tray.iron_ore,
    }).toEqual({ ordinaryInput: getBuilding("arc_smelter").inputCapacity, hubInput: 0, sourceOutput: 0, tray: 101 });

    state = setBeltPriority(state, hubBelt.id, 2);
    state.entities.find((entity) => entity.id === ordinaryTarget.id)!.inputs.iron_ore = getBuilding("arc_smelter").inputCapacity - 1;
    state.entities.find((entity) => entity.id === source.id)!.outputs.iron_ore = 1;
    state = advanceSimulation(state, 1);
    expect(state.belts.find((belt) => belt.id === hubBelt.id)?.priority).toBe(2);
    expect(state.entities.find((entity) => entity.id === ordinaryTarget.id)?.inputs.iron_ore).toBe(getBuilding("arc_smelter").inputCapacity - 1);
    expect(state.entities.find((entity) => entity.id === hub.id)?.inputs.iron_ore).toBe(0);
    expect(state.tray.iron_ore).toBe(102);
  });

  it("runs the construction center from its own planet tray and preserves long-step cycle throughput", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("construction_automation");
    state.construction.wind_turbine = 80;
    state.construction.construction_center = 1;
    state.construction.arc_smelter = 0;
    state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 80);
    state = placeBuilding(state, "construction_center", { x: 120, y: 0 });
    state.tray.iron_ingot = 8;
    state.tray.stone_brick = 4;
    state.tray.circuit_board = 8;
    state.tray.magnetic_coil = 4;
    state = setConstructionAutomationTarget(state, "arc_smelter", 2);
    state = advanceSimulation(state, 10);

    expect(state.construction.arc_smelter).toBe(2);
    expect(state.constructionAutomation).toMatchObject({ totalCrafted: 2, lastCraftedId: "arc_smelter" });
    expect(state.tray).toMatchObject({ iron_ingot: 0, stone_brick: 0, circuit_board: 0, magnetic_coil: 0 });
  });

  it("lets the construction center maintain logistics-vessel stock", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("construction_automation", "interstellar_logistics");
    state.construction.wind_turbine = 80;
    state.construction.construction_center = 1;
    state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 80);
    state = placeBuilding(state, "construction_center", { x: 120, y: 0 });
    state.tray = { titanium_alloy: 10, processor: 10, plasma_exciter: 4 };
    state.planetTrays.home = state.tray;
    state = setConstructionAutomationTarget(state, "logistics_vessel", 1);
    state = advanceSimulation(state, 2);

    expect(state.portableFleet.logistics_vessel).toBe(1);
    expect(state.constructionAutomation).toMatchObject({ totalCrafted: 1, lastCraftedId: "logistics_vessel" });
    expect(state.constructionAutomation.jobs).toEqual({});
  });

  it("recursively processes construction intermediates but never creates missing raw resources", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("construction_automation");
    state.construction.wind_turbine = 80;
    state.construction.construction_center = 1;
    state.construction.arc_smelter = 0;
    state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 80);
    state = placeBuilding(state, "construction_center", { x: 120, y: 0 });
    const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
    state.tray = { iron_ore: 100, copper_ore: 100, stone: 100 };
    state.planetTrays.home = state.tray;
    state = setConstructionAutomationTarget(state, "arc_smelter", 1);

    state = advanceSimulation(state, 8);
    expect(state.construction.arc_smelter).toBe(1);
    expect(state.constructionAutomation.totalCrafted).toBe(1);
    expect((state.totalProduced.iron_ingot ?? 0) + (state.totalProduced.circuit_board ?? 0)).toBeGreaterThan(0);
    expect(getConstructionAutomationStatus(state, center.id).stage).toBe("目标库存已满足");

    let blocked = createInitialState();
    blocked.research.completedTechIds.push("construction_automation");
    blocked.construction.wind_turbine = 80;
    blocked.construction.construction_center = 1;
    blocked.construction.arc_smelter = 0;
    blocked = placeBuilding(blocked, "wind_turbine", { x: -200, y: -180 }, 80);
    blocked = placeBuilding(blocked, "construction_center", { x: 120, y: 0 });
    const blockedCenter = blocked.entities.find((entity) => entity.buildingId === "construction_center")!;
    blocked.tray = {};
    blocked.planetTrays.home = blocked.tray;
    blocked = setConstructionAutomationTarget(blocked, "arc_smelter", 1);
    blocked = advanceSimulation(blocked, 20);
    const status = getConstructionAutomationStatus(blocked, blockedCenter.id);
    expect(blocked.construction.arc_smelter).toBe(0);
    expect(status).toMatchObject({ stage: "等待材料", blockerReason: "raw-shortage" });
    expect(status.missingItemId).toBeDefined();
  });

  it("continues from iron ore through iron ingots and steel for construction-center targets", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("construction_automation", "high_efficiency_plasma_control");
    state.construction.wind_turbine = 80;
    state.construction.construction_center = 1;
    state.construction.oil_extractor = 0;
    state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 80);
    state = placeBuilding(state, "construction_center", { x: 120, y: 0 });
    state.tray = { iron_ore: 36, stone_brick: 12, circuit_board: 6, plasma_exciter: 4 };
    state.planetTrays.home = state.tray;
    state = setConstructionAutomationTarget(state, "oil_extractor", 1);
    state = advanceSimulation(state, 12);

    expect(state.construction.oil_extractor).toBe(1);
    expect(state.tray.iron_ore).toBe(0);
    expect(state.totalProduced.steel).toBe(12);
  });

  it("invalidates a blocked construction-center oil plan when crude oil is added", () => {
    let state = createInitialState();
    state.research.completedTechIds.push(
      "construction_automation",
      "high_efficiency_plasma_control",
      "basic_chemical_engineering",
      "titanium_alloy",
      "geothermal_power",
    );
    state.construction.wind_turbine = 80;
    state.construction.construction_center = 1;
    state.construction.geothermal_power_station = 0;
    state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 80);
    state = placeBuilding(state, "construction_center", { x: 120, y: 0 });
    const centerId = state.entities.find((entity) => entity.buildingId === "construction_center")!.id;
    state.tray = {
      stone: 32,
      water: 16,
      titanium_ingot: 8,
      steel: 23,
      processor: 4,
    };
    state.planetTrays.home = state.tray;
    state = setConstructionAutomationTarget(state, "geothermal_power_station", 1);

    state = advanceSimulation(state, 1);
    expect(getConstructionAutomationStatus(state, centerId)).toMatchObject({
      stage: "等待材料",
      blockerReason: "raw-shortage",
      missingItemId: "crude_oil",
    });
    expect(state.construction.geothermal_power_station).toBe(0);

    state.tray.crude_oil = 24;
    state.planetTrays.home = state.tray;
    state = advanceSimulation(state, 15);
    expect(state.construction.geothermal_power_station).toBe(1);
    expect(state.tray.crude_oil).toBe(0);
    expect(state.tray.hydrogen).toBe(12);
    expect(getConstructionAutomationStatus(state, centerId).stage).toBe("目标库存已满足");
  });

  it("settles optional construction-center WIP without blocking and refunds required WIP when cancelled", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("construction_automation");
    state.construction.wind_turbine = 80;
    state.construction.construction_center = 1;
    state.construction.arc_smelter = 0;
    state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 80);
    state = placeBuilding(state, "construction_center", { x: 120, y: 0 });
    const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
    state.tray.iron_ore = 1;
    state.constructionAutomation.targetStock.arc_smelter = 1;
    state.constructionAutomation.jobs[center.id] = {
      constructionId: "arc_smelter",
      steps: [{ kind: "material", recipeId: "iron_ingot", batches: 1, outputItemId: "iron_ingot", outputAmount: 1 }, { kind: "building", constructionId: "arc_smelter" }],
      stepIndex: 0,
      elapsedSeconds: 0.1,
      inventory: { stone: 1_000_000 },
    };

    expect(getConstructionAutomationStatus(state, center.id)).toMatchObject({ stage: "加工 铁块", blockerReason: undefined });
    const advanced = advanceSimulation(state, 1);
    expect(advanced.tray.iron_ore).toBe(0);
    expect(advanced.tray.stone).toBe(1_000_000);
    expect(advanced.constructionAutomation.jobs[center.id].inventory).toEqual({ iron_ingot: 1 });
    expect(advanced.constructionAutomation.destroyedByproducts.stone).toBe(100);

    const cancelled = setConstructionAutomationTarget(advanced, "arc_smelter", 0);
    expect(cancelled.constructionAutomation.jobs[center.id]).toBeUndefined();
    expect(cancelled.tray.iron_ingot).toBe(1);
    expect(cancelled.tray.stone).toBe(1_000_000);
  });

  it("keeps required construction-center WIP above the legacy one-million limit and resumes atomically", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("construction_automation", "high_efficiency_plasma_control");
    state.construction.wind_turbine = 80;
    state.construction.construction_center = 1;
    state.construction.oil_extractor = 0;
    state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 80);
    state = placeBuilding(state, "construction_center", { x: 120, y: 0 });
    const center = state.entities.find((entity) => entity.buildingId === "construction_center")!;
    state.tray = {
      iron_ore: 1_080_000,
      stone_brick: 12,
      circuit_board: 6,
      plasma_exciter: 4,
    };
    state.planetTrays.home = state.tray;
    state.constructionAutomation.targetStock.oil_extractor = 1;
    state.constructionAutomation.jobs[center.id] = {
      constructionId: "oil_extractor",
      steps: [
        { kind: "material", recipeId: "iron_ingot", batches: 1_080_000, outputItemId: "iron_ingot", outputAmount: 1_080_000 },
        { kind: "material", recipeId: "steel", batches: 360_000, outputItemId: "steel", outputAmount: 360_000 },
        { kind: "building", constructionId: "oil_extractor" },
      ],
      stepIndex: 0,
      elapsedSeconds: 108_000,
      inventory: {},
    };

    state = advanceSimulation(state, 1);
    expect(state.constructionAutomation.jobs[center.id]).toMatchObject({
      stepIndex: 1,
      elapsedSeconds: 1,
      inventory: { iron_ingot: 1_080_000 },
    });
    expect(state.tray.iron_ore).toBe(0);
    expect(getConstructionAutomationStatus(state, center.id)).toMatchObject({
      stage: "加工 钢材",
      blockerReason: undefined,
      wipCount: 1_080_000,
      wipItems: [{ itemId: "iron_ingot", amount: 1_080_000 }],
    });

    state.constructionAutomation.enabled = false;
    const pausedJob = structuredClone(state.constructionAutomation.jobs[center.id]);
    state = advanceSimulation(state, 60);
    expect(state.constructionAutomation.jobs[center.id]).toEqual(pausedJob);
    expect(getConstructionAutomationStatus(state, center.id)).toMatchObject({ stage: "自动制造已暂停", blockerReason: "paused" });

    state.constructionAutomation.enabled = true;
    state.paused = true;
    state = advanceSimulation(state, 60);
    expect(state.constructionAutomation.jobs[center.id]).toEqual(pausedJob);
    expect(getConstructionAutomationStatus(state, center.id)).toMatchObject({ stage: "游戏已暂停", blockerReason: "paused" });
    state.paused = false;
    const generators = state.entities.filter((entity) => entity.buildingId === "wind_turbine");
    state.entities = state.entities.filter((entity) => entity.buildingId !== "wind_turbine");
    const unpoweredJob = structuredClone(state.constructionAutomation.jobs[center.id]);
    state = advanceSimulation(state, 60);
    expect(state.constructionAutomation.jobs[center.id]).toEqual(unpoweredJob);
    expect(getConstructionAutomationStatus(state, center.id)).toMatchObject({ stage: "等待供电", blockerReason: "no-power" });
    state.entities.push(...generators);
    state.tray.steel = getPlanetTrayItemLimit(state, "home");
    state.constructionAutomation.jobs[center.id].elapsedSeconds = 36_000;
    const completionInput = structuredClone(state);
    let chunked = structuredClone(state);
    state = advanceSimulation(completionInput, 10);
    for (let second = 0; second < 10; second += 1) chunked = advanceSimulation(chunked, 1);

    expect(state.construction.oil_extractor).toBe(1);
    expect(state.constructionAutomation.jobs[center.id]).toBeUndefined();
    expect(state.constructionAutomation.totalCrafted).toBe(1);
    expect(state.constructionAutomation.destroyedByproducts.steel).toBe(359_988);
    expect(state.tray.steel).toBe(getPlanetTrayItemLimit(state, "home"));
    expect(state.totalProduced).toMatchObject({ iron_ingot: 1_080_000, steel: 360_000 });
    expect(getConstructionAutomationStatus(state, center.id)).toMatchObject({
      stage: "目标库存已满足",
      destroyedByproductItems: [{ itemId: "steel", amount: 359_988 }],
    });
    expect(chunked.construction).toEqual(state.construction);
    expect(chunked.constructionAutomation).toEqual(state.constructionAutomation);
    expect(chunked.tray).toEqual(state.tray);
    expect(chunked.totalProduced).toEqual(state.totalProduced);

    const settled = advanceSimulation(state, 100);
    expect(settled.construction.oil_extractor).toBe(1);
    expect(settled.constructionAutomation.totalCrafted).toBe(1);
    expect(settled.constructionAutomation.destroyedByproducts.steel).toBe(359_988);
  });

  it("applies construction-center speed upgrades to material and final stages", () => {
    const base = createInitialState();
    expect(getConstructionAutomationMaterialSeconds(base)).toBeCloseTo(0.1, 6);
    base.research.completedTechIds.push("construction_capacity_1");
    expect(getConstructionAutomationMaterialSeconds(base)).toBeCloseTo(0.05, 6);
    base.research.completedTechIds.push("construction_capacity_2");
    expect(getConstructionAutomationMaterialSeconds(base)).toBeCloseTo(0.02, 6);
  });

  it("keeps per-planet tray limits independent and preserves stock when a limit is lowered", () => {
    let state = createInitialState();
    state.tray.iron_ore = 1_500;
    state = setPlanetTrayItemLimit(state, "home", 1_000);
    state = setPlanetTrayItemLimit(state, "ashen", 12_000);

    expect(getPlanetTrayItemLimit(state, "home")).toBe(1_000);
    expect(getPlanetTrayItemLimit(state, "ashen")).toBe(12_000);
    expect(state.tray.iron_ore).toBe(1_500);
    expect(state.planetTrayItemLimits.giant).toBe(1_000_000);
  });

  it("lets a manual cursor return overflow while node and delivery-hub automation respect the tray limit", () => {
    let state = createInitialState();
    state = setPlanetTrayItemLimit(state, "home", 1_000);
    state.tray.iron_ore = 995;
    state.cargo = { itemId: "iron_ore", amount: 20, origin: { kind: "tray" } };
    state = dropCargoToTray(state);
    expect(state.tray.iron_ore).toBe(1_015);
    expect(state.cargo).toBeNull();

    state.construction.storage_mk1 = 1;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    storage.storedItemId = "iron_ingot";
    storage.outputs.iron_ingot = 12;
    state.tray.iron_ingot = 997;
    state = moveEntityOutputToTray(state, storage.id, "iron_ingot");
    expect(state.tray.iron_ingot).toBe(1_000);
    expect(state.entities.find((entity) => entity.id === storage.id)?.outputs.iron_ingot).toBe(9);

    state.research.completedTechIds.push("material_delivery_logistics");
    state.construction.material_delivery_hub = 1;
    state = placeBuilding(state, "material_delivery_hub", { x: 320, y: 0 });
    const hub = state.entities.find((entity) => entity.buildingId === "material_delivery_hub")!;
    state = setMaterialDeliverySlot(state, hub.id, 0, "manual", "copper_ingot");
    state.entities.find((entity) => entity.id === hub.id)!.inputs.copper_ingot = 8;
    state.tray.copper_ingot = 999;
    state = advanceSimulation(state, 1);
    expect(state.tray.copper_ingot).toBe(1_000);
    expect(state.entities.find((entity) => entity.id === hub.id)?.inputs.copper_ingot).toBe(7);
  });

  it("does not consume handcraft inputs when the produced stack has reached its tray limit", () => {
    let state = createInitialState();
    state = setPlanetTrayItemLimit(state, "home", 1_000);
    state.tray.iron_ingot = 10;
    state.tray.gear = 1_000;

    const blocked = handcraftRecipe(state, "gear", 1);
    expect(blocked).toBe(state);
    expect(blocked.tray.iron_ingot).toBe(10);
    expect(blocked.tray.gear).toBe(1_000);
  });

  it("excludes megastructures while retaining ordinary technology construction rewards", () => {
    expect(getTechnologyConstructionRewards("construction_automation")).not.toContain("construction_center");
    expect(getTechnologyConstructionRewards("material_delivery_logistics")).toContain("material_delivery_hub");
  });

  it("keeps a focused recipe chain in the save and supports both expansion modes", () => {
    let state = createInitialState();
    state = setRecipeFocus(state, "processor");
    state = setRecipeFocusMode(state, "full");
    expect(state.recipeFocus).toEqual({ itemId: "processor", mode: "full", position: { x: 24, y: 72 } });
    state = setRecipeFocus(state, null);
    expect(state.recipeFocus.itemId).toBeNull();
  });

  it("requires a colony outpost for secondary worlds and consumes its portable cost", () => {
    let state = createInitialState();
    state.exploration.unlockedSystemIds.push("borealis");
    state.tray.titanium_alloy = 10;
    state.portableFleet.logistics_drone = 5;
    expect(getColonizationRequirements(state, "boreal_giant")).toMatchObject({
      status: "ready",
      sourcePlanetId: "home",
      costs: expect.arrayContaining([
        expect.objectContaining({ itemId: "logistics_drone", current: 5, required: 5, missing: 0, source: "portable-fleet" }),
      ]),
    });
    expect(canColonizePlanet(state, "boreal_giant")).toBe(true);
    state = colonizePlanet(state, "boreal_giant");
    expect(state.exploration.colonizedPlanetIds).toContain("boreal_giant");
    expect(state.tray.titanium_alloy).toBe(0);
    expect(state.portableFleet.logistics_drone).toBe(0);
    expect(setActivePlanet(state, "boreal_giant").activePlanetId).toBe("boreal_giant");
  });

  it("validates all colony materials before deducting tray stock or portable vehicles", () => {
    const state = createInitialState();
    state.exploration.unlockedSystemIds.push("borealis");
    state.tray.titanium_alloy = 10;
    state.portableFleet.logistics_drone = 4;

    const requirements = getColonizationRequirements(state, "boreal_giant");
    expect(requirements).toMatchObject({ status: "materials" });
    expect(requirements.reason).toContain("物流运输机缺 1");
    const blocked = colonizePlanet(state, "boreal_giant");
    expect(blocked).toBe(state);
    expect(blocked.tray.titanium_alloy).toBe(10);
    expect(blocked.portableFleet.logistics_drone).toBe(4);
  });

  it("counts and consumes idle logistics vessels from the portable fleet for colonization", () => {
    let state = createInitialState();
    state.exploration.unlockedSystemIds.push("aurora");
    const requirements = getColonizationRequirements(state, "aurora_giant");
    const vesselCost = requirements.costs.find((cost) => cost.itemId === "logistics_vessel");
    expect(vesselCost).toMatchObject({ source: "portable-fleet", current: 0, required: 2, missing: 2 });
    state.tray.titanium_alloy = 16;
    state.portableFleet.logistics_vessel = 2;

    state = colonizePlanet(state, "aurora_giant");

    expect(state.exploration.colonizedPlanetIds).toContain("aurora_giant");
    expect(state.tray.titanium_alloy).toBe(0);
    expect(state.portableFleet.logistics_vessel).toBe(0);
  });

  it("lets the player return a complete cursor stack above the tray limit", () => {
    let state = createInitialState();
    state = setPlanetTrayItemLimit(state, "home", 1_000);
    state.tray.iron_ingot = 1_000;
    state.cargo = { itemId: "iron_ingot", amount: 100, origin: { kind: "node-output", id: "machine-1" } };

    state = dropCargoToTray(state);

    expect(state.tray.iron_ingot).toBe(1_100);
    expect(state.cargo).toBeNull();
  });

  it("reports technology, prerequisite-system and material colonization blockers separately", () => {
    const state = createInitialState();
    expect(getColonizationRequirements(state, "dune")).toMatchObject({ status: "technology" });
    state.research.completedTechIds.push("stellar_exploration");
    expect(getColonizationRequirements(state, "dune")).toMatchObject({ status: "prerequisite-system" });
    state.exploration.unlockedSystemIds.push("aurora", "ember");
    expect(getColonizationRequirements(state, "cinder")).toMatchObject({ status: "materials" });
  });

  it("uses star distance and planet roles in the global industry layer", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics", "space_warp", "stellar_exploration");
    state.exploration.unlockedSystemIds.push("borealis");
    state.exploration.colonizedPlanetIds.push("frost");
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "interstellar_logistics_station", { x: -180, y: 0 });
    state = setActivePlanet(state, "frost");
    state = placeBuilding(state, "interstellar_logistics_station", { x: 180, y: 0 });
    const homeStation = state.entities.find((entity) => entity.planetId === "home" && entity.buildingId === "interstellar_logistics_station")!;
    const frostStation = state.entities.find((entity) => entity.planetId === "frost" && entity.buildingId === "interstellar_logistics_station")!;
    const local = getInterstellarRouteEconomics(state, homeStation, homeStation, 1);
    const remote = getInterstellarRouteEconomics(state, frostStation, homeStation, 1);
    expect(local.requiresWarp).toBe(false);
    expect(remote.requiresWarp).toBe(true);
    expect(remote.distanceLy).toBeCloseTo(4.2, 1);
    expect(remote.warpersPerTrip).toBe(1);
    expect(remote.durationSeconds).toBeLessThan(local.durationSeconds);
    const homeProbe = state.entities.find((entity) => entity.id === "vein_iron")!;
    const ashenProbe = state.entities.find((entity) => entity.id === "ashen_iron")!;
    const giantProbe = { ...ashenProbe, id: "giant_probe", planetId: "giant" as const };
    const neighboringOrbit = getInterstellarRouteEconomics(state, homeProbe, ashenProbe, 1);
    const distantOrbit = getInterstellarRouteEconomics(state, homeProbe, giantProbe, 1);
    expect(neighboringOrbit.orbitSpan).toBe(1);
    expect(distantOrbit.orbitSpan).toBe(2);
    expect(distantOrbit.durationSeconds).toBeGreaterThan(neighboringOrbit.durationSeconds);
    state = setPlanetIndustryRole(state, "frost", "chemical");
    expect(state.galaxy.planetRoles.frost).toBe("chemical");
  });

  it("applies a planet specialization to real machine cycle speed", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics");
    state.construction.wind_turbine = 12;
    state.construction.arc_smelter = 2;
    state = placeBuilding(state, "wind_turbine", { x: -200, y: -200 }, 6);
    state = placeBuilding(state, "arc_smelter", { x: 100, y: 0 });
    const homeSmelter = state.entities.find((entity) => entity.planetId === "home" && entity.buildingId === "arc_smelter")!;
    state = setEntityRecipe(state, homeSmelter.id, "iron_ingot");
    state.entities.find((entity) => entity.id === homeSmelter.id)!.inputs.iron_ore = 30;

    state = setActivePlanet(state, "ashen");
    state = placeBuilding(state, "wind_turbine", { x: -200, y: -200 }, 6);
    state = placeBuilding(state, "arc_smelter", { x: 100, y: 0 });
    const ashenSmelter = state.entities.find((entity) => entity.planetId === "ashen" && entity.buildingId === "arc_smelter")!;
    state = setEntityRecipe(state, ashenSmelter.id, "iron_ingot");
    state.entities.find((entity) => entity.id === ashenSmelter.id)!.inputs.iron_ore = 30;

    state = advanceSimulation(state, 10);
    expect(state.entities.find((entity) => entity.id === homeSmelter.id)?.outputs.iron_ingot).toBe(10);
    expect(state.entities.find((entity) => entity.id === ashenSmelter.id)?.outputs.iron_ingot).toBe(11);
  });

  it("isolates a device in a separate power grid and reports coverage loss", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 1;
    state.construction.assembling_machine_mk1 = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: 0 });
    state = placeBuilding(state, "assembling_machine_mk1", { x: 2_000, y: 0 });
    const machine = state.entities.find((entity) => entity.buildingId === "assembling_machine_mk1")!;
    state = setEntityRecipe(state, machine.id, "gear");
    state.entities.find((entity) => entity.id === machine.id)!.inputs.iron_ingot = 1;
    state = advanceSimulation(state, 2);
    expect(state.entities.find((entity) => entity.id === machine.id)?.outputs.gear).toBe(1);
    state = setEntityPowerGrid(state, machine.id, "grid-b");
    state.entities.find((entity) => entity.id === machine.id)!.inputs.iron_ingot = 2;
    state = advanceSimulation(state, 1);
    expect(state.metrics.powerFactor).toBe(0);
    expect(getEntityOperatingStatus(state, state.entities.find((entity) => entity.id === machine.id)!)).toMatchObject({ code: "no-power" });
  });

  it("depletes finite solid veins while infinite mode preserves extraction", () => {
    let state = createInitialState();
    const vein = state.entities.find((entity) => entity.id === "vein_iron")!;
    const before = vein.resourceRemaining!;
    state = manualMine(state, vein.id, 3);
    expect(state.entities.find((entity) => entity.id === vein.id)?.resourceRemaining).toBe(before - 3);
    state.settings.resourceMode = "infinite";
    const infiniteBefore = state.entities.find((entity) => entity.id === vein.id)?.resourceRemaining;
    state = manualMine(state, vein.id, 3);
    expect(state.entities.find((entity) => entity.id === vein.id)?.resourceRemaining).toBe(infiniteBefore);
  });

  it("reduces solid vein consumption by ten percent per level and becomes lossless at level ten", () => {
    let state = createInitialState();
    state.endgame.infiniteResearch.vein_utilization.level = 1;
    expect(getVeinConsumptionMultiplier(state)).toBe(0.9);
    state.construction.wind_turbine = 2;
    state.construction.mining_machine = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -180 }, 2);
    state = installMiner(state, "vein_iron");
    const vein = state.entities.find((entity) => entity.id === "vein_iron")!;
    vein.resourceCapacity = 100;
    vein.resourceRemaining = 100;
    vein.resourceDepletionRemainder = 0;
    vein.outputs.iron_ore = 0;

    let chunked = JSON.parse(JSON.stringify(state)) as typeof state;
    state = advanceSimulation(state, 20);
    for (let second = 0; second < 20; second += 1) chunked = advanceSimulation(chunked, 1);
    expect(state.entities.find((entity) => entity.id === vein.id)).toMatchObject({
      outputs: { iron_ore: 11 },
      resourceRemaining: 91,
      resourceDepletionRemainder: 9,
    });
    expect(chunked.entities.find((entity) => entity.id === vein.id)).toMatchObject({
      outputs: { iron_ore: 11 },
      resourceRemaining: 91,
      resourceDepletionRemainder: 9,
    });

    const almostDepleted = state.entities.find((entity) => entity.id === vein.id)!;
    almostDepleted.outputs.iron_ore = 0;
    almostDepleted.progress = 0;
    almostDepleted.resourceRemaining = 1;
    almostDepleted.resourceDepletionRemainder = 9;
    state = advanceSimulation(state, 20);
    expect(state.entities.find((entity) => entity.id === vein.id)?.outputs.iron_ore).toBe(0);
    expect(getResourceReserveSnapshot(state, state.entities.find((entity) => entity.id === vein.id)!)).toMatchObject({
      infinite: false,
      exhausted: true,
    });

    state.endgame.infiniteResearch.vein_utilization.level = 10;
    expect(getVeinConsumptionMultiplier(state)).toBe(0);
    state = advanceSimulation(state, 20);
    expect(state.entities.find((entity) => entity.id === vein.id)).toMatchObject({
      outputs: { iron_ore: 20 },
      resourceRemaining: 1,
      resourceDepletionRemainder: 9,
    });
    expect(getResourceReserveSnapshot(state, state.entities.find((entity) => entity.id === vein.id)!)).toMatchObject({
      infinite: true,
      exhausted: false,
    });
  });

  it("applies vein utilization to manual mining without changing integer material conservation", () => {
    let state = createInitialState();
    state.endgame.infiniteResearch.vein_utilization.level = 1;
    const vein = state.entities.find((entity) => entity.id === "vein_iron")!;
    vein.resourceRemaining = 20;
    vein.resourceCapacity = 20;
    state = manualMine(state, vein.id, 11);
    expect(state.entities.find((entity) => entity.id === vein.id)).toMatchObject({
      outputs: { iron_ore: 11 },
      resourceRemaining: 11,
      resourceDepletionRemainder: 9,
    });

    state.endgame.infiniteResearch.vein_utilization.level = 10;
    const before = state.entities.find((entity) => entity.id === vein.id)!.resourceRemaining;
    state = manualMine(state, vein.id, 5);
    expect(state.entities.find((entity) => entity.id === vein.id)?.resourceRemaining).toBe(before);
  });

  it("reports one reserve snapshot for finite, depleted and genuinely infinite resources", () => {
    const state = createInitialState();
    const iron = state.entities.find((entity) => entity.id === "vein_iron")!;
    iron.resourceRemaining = Math.floor((iron.resourceCapacity ?? 0) / 2);
    expect(getResourceReserveSnapshot(state, iron)).toMatchObject({
      infinite: false,
      exhausted: false,
      remaining: iron.resourceRemaining,
      capacity: iron.resourceCapacity,
      remainingPercent: 50,
    });

    iron.resourceRemaining = 0;
    expect(getResourceReserveSnapshot(state, iron)).toMatchObject({ infinite: false, exhausted: true, remainingPercent: 0 });
    expect(getEntityOperatingStatus(state, iron)).toMatchObject({ code: "resource-depleted", label: "资源已枯竭" });
    const ocean = state.entities.find((entity) => entity.id === "vein_water")!;
    expect(getResourceReserveSnapshot(state, ocean)).toMatchObject({ infinite: true, exhausted: false });
  });

  it("runs repeatable endgame research with universe matrices and keeps looping", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("universe_matrix");
    state.construction.wind_turbine = 4;
    state.construction.matrix_lab = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -180 }, 4);
    state = placeBuilding(state, "matrix_lab", { x: 0, y: 0 });
    state = selectInfiniteResearch(state, "matrix_compression");
    expect(state.endgame.activeInfiniteResearchId).toBe("matrix_compression");
    const labId = state.entities.find((entity) => entity.buildingId === "matrix_lab")!.id;
    state = setEntityRecipe(state, labId, "matrix_research");
    const lab = state.entities.find((entity) => entity.id === labId)!;
    const cost = 250;
    lab.inputs.universe_matrix = cost + 1;
    state = advanceSimulation(state, 800);
    expect(state.endgame.infiniteResearch.matrix_compression.level).toBeGreaterThanOrEqual(1);
    expect(state.endgame.activeInfiniteResearchId).toBe("matrix_compression");
    expect(BigInt(state.endgame.infiniteResearch.matrix_compression.progress)).toBeGreaterThanOrEqual(0n);
    expect(getRecipeSpeedMultiplier(state, "iron_ingot")).toBeGreaterThan(1);
  });

  it("dispatches a mega export from network buffers while respecting its reserve", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("universe_matrix");
    state.endgame.exportInputMode = "legacy-network";
    state.tray.universe_matrix = 2_000;
    state = setGalacticExportEnabled(state, "universe_archive", true);
    state = setGalacticDispatchAutomation(state, false);
    const before = state.tray.universe_matrix ?? 0;
    state = dispatchGalacticExport(state, "universe_archive", 1_000);
    expect(before - (state.tray.universe_matrix ?? 0)).toBe(1_000);
    expect(state.endgame.exportProjects.universe_archive.totalDelivered).toBe(1_000);
    expect(state.endgame.galacticCredits).toBeGreaterThan(0);
    expect(getGalacticExportTarget("universe_archive", state.endgame.exportProjects.universe_archive.level)).toBeGreaterThan(0);
    expect(getGalacticIndustrySnapshot(state).totalExported).toBe(1_000);
    expect(state.tray.universe_matrix).toBeGreaterThanOrEqual(120);
  });

  it("uses four dedicated exporter inputs and records one atomic local activity batch", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("universe_matrix");
    state.construction.wind_turbine = 100;
    state.construction.galactic_material_exporter = 1;
    state = placeBuilding(state, "wind_turbine", { x: -300, y: 0 }, 100);
    state = placeBuilding(state, "galactic_material_exporter", { x: 0, y: 0 });
    const exporter = state.entities.find((entity) => entity.buildingId === "galactic_material_exporter")!;
    expect(getAcceptedInputs(exporter)).toEqual(["universe_matrix", "solar_sail", "small_carrier_rocket", "antimatter_fuel_rod"]);
    expect(exporter.galacticExporterPaused).toBe(true);
    expect(state.endgame.exportInputMode).toBe("building");
    exporter.inputs.universe_matrix = 25;
    state = setGalacticMaterialExporterPaused(state, exporter.id, false);
    state = advanceSimulation(state, 1);
    expect(state.entities.find((entity) => entity.id === exporter.id)?.inputs.universe_matrix).toBe(25);
    state.endgame.constructionActivity = {
      activityId: "activity-test",
      participantId: "participant-test",
      configRevision: "r1",
      startsAtMs: 1_000,
      endsAtMs: 10_000,
      serverTimeAnchorMs: 2_000,
      activityClockMs: 2_000,
      personalTargets: { universe_matrix: 1_000_000, solar_sail: 1_000_000, small_carrier_rocket: 1_000_000, antimatter_fuel_rod: 1_000_000 },
      globalTargets: { universe_matrix: 10_000_000, solar_sail: 10_000_000, small_carrier_rocket: 10_000_000, antimatter_fuel_rod: 10_000_000 },
      personalDelivered: { universe_matrix: 0, solar_sail: 0, small_carrier_rocket: 0, antimatter_fuel_rod: 0 },
      pendingBatches: {},
      nextBatchSequence: 0,
    };
    state = advanceSimulation(state, 1);
    expect(state.entities.find((entity) => entity.id === exporter.id)?.inputs.universe_matrix).toBe(0);
    expect(state.endgame.exportProjects.universe_archive.totalDelivered).toBe(25);
    expect(state.endgame.constructionActivity.personalDelivered.universe_matrix).toBe(25);
    expect(state.endgame.constructionActivity.pendingBatches.universe_matrix).toMatchObject({
      itemId: "universe_matrix",
      amount: 25,
      sequence: 0,
    });
  });

  it("manufactures and deploys the galactic material exporter after universe matrix research", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("universe_matrix");
    state.construction.galactic_material_exporter = 0;
    state.tray.universe_matrix = 1_000;
    state.tray.small_carrier_rocket = 500;
    state.tray.frame_material = 1_000;
    state.tray.quantum_chip = 1_000;

    const plan = getConstructionQuickCraftPlan(state, "galactic_material_exporter");
    expect(plan).toMatchObject({ possible: true, outputAmount: 1, status: "direct" });
    state = craftConstructionWithUpstream(state, "galactic_material_exporter");
    expect(state.construction.galactic_material_exporter).toBe(1);
    expect(state.tray.universe_matrix).toBe(0);
    state = placeBuilding(state, "galactic_material_exporter", { x: 120, y: 80 });
    expect(state.construction.galactic_material_exporter).toBe(0);
    expect(state.entities.find((entity) => entity.buildingId === "galactic_material_exporter")).toMatchObject({
      position: { x: 120, y: 80 },
      galacticExporterPaused: true,
    });
  });

  it("does not select an infinite research project after its effective level cap", () => {
    const state = createInitialState();
    state.research.completedTechIds.push("universe_matrix");
    state.endgame.infiniteResearch.matrix_compression.level = 1_000;
    state.endgame.infiniteResearch.continuum_simulation.level = 23;
    expect(selectInfiniteResearch(state, "matrix_compression")).toBe(state);
    expect(selectInfiniteResearch(state, "continuum_simulation")).toBe(state);
  });

  it("continues beyond the legacy eight-hour offline window with bounded stepping", () => {
    const state = advanceSimulation(createInitialState(), 9 * 60 * 60);
    expect(state.elapsedSeconds).toBe(9 * 60 * 60);
  });

  it("locks only player interaction while preserving simulation state and unlocks explicitly", () => {
    let state = createInitialState();
    state.construction.arc_smelter = 2;
    state = placeBuilding(state, "arc_smelter", { x: 0, y: 0 });
    const entity = state.entities.find((candidate) => candidate.buildingId === "arc_smelter")!;
    entity.inputs.iron_ore = 20;
    state = setEntitiesInteractionLocked(state, [entity.id, entity.id, "missing"], true);
    const locked = state.entities.find((candidate) => candidate.id === entity.id)!;
    expect(locked.interactionLocked).toBe(true);
    expect(moveEntities(state, [{ id: entity.id, position: { x: 500, y: 500 } }])).toBe(state);
    expect(removeEntity(state, entity.id)).toBe(state);
    expect(upgradeEntity(state, entity.id)).toBe(state);
    const simulated = advanceSimulation(state, 1);
    expect(simulated.entities.find((candidate) => candidate.id === entity.id)?.inputs.iron_ore).toBeLessThanOrEqual(20);
    state = setEntitiesInteractionLocked(simulated, [entity.id], false);
    expect(state.entities.find((candidate) => candidate.id === entity.id)?.interactionLocked).toBe(false);
  });

  it("refills a station warper bay from input, unreserved output, then its planet tray", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics", "space_warp");
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: 300, y: 0 });
    const [source, demand] = state.entities.filter((entity) => entity.buildingId === "interstellar_logistics_station");
    source.stationWarperAutoRefill = true;
    source.stationWarperTarget = 6;
    source.inputs.space_warper = 3;
    source.outputs.space_warper = 5;
    demand.stationRoutes = [{ id: "reserved-warper-route", slotIndex: 0, peerId: source.id, itemId: "space_warper", scope: "remote", cargo: 4, vehicleCount: 1, progress: 0.5, duration: 10, requiresWarp: false, vehicleStationId: demand.id }];
    state.tray.space_warper = 10;

    expect(getStationWarperRefillSnapshot(state, source.id)).toMatchObject({ inputAvailable: 3, outputStored: 5, outputReserved: 4, outputAvailable: 1, trayAvailable: 10 });
    refillStationWarpers(state);
    expect(source.stationWarpers).toBe(6);
    expect(source.inputs.space_warper).toBe(0);
    expect(source.outputs.space_warper).toBe(4);
    expect(state.tray.space_warper).toBe(8);
  });

  it("dispatches every available vessel without a hidden twenty-vessel ceiling", () => {
    const createFleetScenario = (warpers: number) => {
      let state = createInitialState();
      state.research.completedTechIds.push("interstellar_logistics", "space_warp");
      state.exploration.unlockedSystemIds.push("aurora", "sirius");
      state.exploration.colonizedPlanetIds.push("verdant", "crystal");
      state.construction.wind_turbine = 60;
      state.construction.interstellar_logistics_station = 15;
      state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 20);
      state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 }, 5);
      const supply = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
      state = setStationSlotItem(state, supply.id, 0, "processor");
      state.entities.find((entity) => entity.id === supply.id)!.outputs.processor = 5_000;
      state.entities.find((entity) => entity.id === supply.id)!.stationVessels = 50;
      state.entities.find((entity) => entity.id === supply.id)!.stationWarpers = warpers;

      state = setActivePlanet(state, "verdant");
      state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 20);
      state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 }, 5);
      const hub = state.entities.find((entity) => entity.planetId === "verdant" && entity.buildingId === "interstellar_logistics_station")!;
      state = setStationHubConfiguration(state, hub.id, true, 2);

      state = setActivePlanet(state, "crystal");
      state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 20);
      state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 }, 5);
      const demand = state.entities.find((entity) => entity.planetId === "crystal" && entity.buildingId === "interstellar_logistics_station")!;
      state = setStationSlotItem(state, demand.id, 0, "processor");
      state = setStationSlotMode(state, demand.id, 0, "remote", "demand");
      state = setStationSlotMinimumLoad(state, demand.id, 0, 0.1);
      state = setStationSlotRoutePolicy(state, demand.id, 0, "relay-required");
      state = setStationSlotWarperBudget(state, demand.id, 0, 2);
      return { state, supplyId: supply.id, demandId: demand.id };
    };

    const full = createFleetScenario(200);
    let state = advanceSimulation(full.state, 0.1);
    const routes = state.entities.find((entity) => entity.id === full.demandId)?.stationRoutes ?? [];
    expect(routes.reduce((sum, route) => sum + route.vehicleCount, 0)).toBe(50);
    expect(routes.every((route) => route.warpersPerVessel === 2 && route.waypointStationIds?.length === 1)).toBe(true);
    expect(getStationBusyVehicleCount(state, full.supplyId, "remote")).toBe(50);
    expect(state.entities.find((entity) => entity.id === full.supplyId)?.stationWarpers).toBe(100);

    const limited = createFleetScenario(40);
    state = advanceSimulation(limited.state, 0.1);
    const limitedRoutes = state.entities.find((entity) => entity.id === limited.demandId)?.stationRoutes ?? [];
    expect(limitedRoutes.reduce((sum, route) => sum + route.vehicleCount, 0)).toBe(20);
    expect(limitedRoutes.every((route) => route.warpersPerVessel === 2 && route.waypointStationIds?.length === 1)).toBe(true);
    expect(getStationBusyVehicleCount(state, limited.supplyId, "remote")).toBe(20);
    expect(state.entities.find((entity) => entity.id === limited.supplyId)?.stationWarpers).toBe(0);
    expect(getStationFleetDiagnostic(state, limited.supplyId)?.vessels).toMatchObject({
      installed: 50,
      busy: 20,
      available: 0,
      blocked: 30,
      blockerCode: "missing-warper",
    });
  });

  it("settles long construction-center work without the former 128-iteration truncation", () => {
    const createFactory = () => {
      let state = createInitialState(55_001);
      state.research.completedTechIds.push("construction_automation", "construction_capacity_1");
      state.construction.wind_turbine = 80;
      state.construction.construction_center = 1;
      state.construction.arc_smelter = 0;
      state = placeBuilding(state, "wind_turbine", { x: -200, y: -180 }, 80);
      state = placeBuilding(state, "construction_center", { x: 120, y: 0 });
      state.tray.iron_ingot = 2_000;
      state.tray.stone_brick = 1_000;
      state.tray.circuit_board = 2_000;
      state.tray.magnetic_coil = 1_000;
      return setConstructionAutomationTarget(state, "arc_smelter", 500);
    };
    const singleChunk = advanceSimulation(createFactory(), 600);
    let oneSecondChunks = createFactory();
    const centerId = oneSecondChunks.entities.find((entity) => entity.buildingId === "construction_center")!.id;
    const trace = [];
    for (let second = 1; second <= 600; second += 1) {
      oneSecondChunks = advanceSimulation(oneSecondChunks, 1);
      trace.push(getConstructionCenterTraceSample(oneSecondChunks, centerId, second, 0, 0)!);
    }
    expect(singleChunk.construction.arc_smelter).toBeGreaterThan(128);
    expect(singleChunk.construction.arc_smelter).toBe(oneSecondChunks.construction.arc_smelter);
    expect(singleChunk.tray).toMatchObject(oneSecondChunks.tray);
    expect(singleChunk.constructionAutomation.totalCrafted).toBe(oneSecondChunks.constructionAutomation.totalCrafted);
    expect(trace).toHaveLength(600);
    expect(trace.every((sample) => sample.guardHitCount === 0 && sample.simulationSecond === sample.wallSecond)).toBe(true);
    for (let end = 30; end < trace.length; end += 30) {
      expect(trace[end].completedBuildings - trace[end - 30].completedBuildings).toBeGreaterThanOrEqual(5);
    }

    const fourXBudget = advanceSimulation(createFactory(), 2_400);
    let backgroundChunks = createFactory();
    for (let elapsed = 0; elapsed < 2_400;) {
      const chunk = Math.min(2_400 - elapsed, elapsed % 90 === 0 ? 30 : 60);
      backgroundChunks = advanceSimulation(backgroundChunks, chunk);
      elapsed += chunk;
    }
    expect(backgroundChunks.construction.arc_smelter).toBe(fourXBudget.construction.arc_smelter);
    expect(backgroundChunks.tray).toEqual(fourXBudget.tray);
    expect(backgroundChunks.constructionAutomation).toEqual(fourXBudget.constructionAutomation);

    let saveLoadSplit = advanceSimulation(createFactory(), 300);
    saveLoadSplit = JSON.parse(JSON.stringify(saveLoadSplit)) as typeof saveLoadSplit;
    saveLoadSplit = advanceSimulation(saveLoadSplit, 300);
    expect(saveLoadSplit.construction.arc_smelter).toBe(singleChunk.construction.arc_smelter);
    expect(saveLoadSplit.tray).toEqual(singleChunk.tray);
    expect(saveLoadSplit.constructionAutomation).toEqual(singleChunk.constructionAutomation);
  });

  it("keeps Mk.II transport equivalent across non-integer worker request tails", () => {
    const createLine = () => {
      let state = createInitialState();
      state.construction.storage_mk1 = 2;
      state.construction.conveyor_belt_mk2 = 1;
      state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
      state = placeBuilding(state, "storage_mk1", { x: 300, y: 0 });
      const [source, target] = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
      source.storedItemId = "silicon_ore";
      target.storedItemId = "silicon_ore";
      source.machineCount = 100;
      target.machineCount = 100;
      source.outputs.silicon_ore = 10_000;
      return connectBelt(state, source.id, target.id, "silicon_ore", 2);
    };
    let integer = createLine();
    for (let second = 0; second < 60; second += 1) integer = advanceSimulation(integer, 1);
    let tailed = createLine();
    for (let pair = 0; pair < 30; pair += 1) {
      tailed = advanceSimulation(tailed, 1.02);
      tailed = advanceSimulation(tailed, 0.98);
    }
    expect(integer.belts[0].totalTransferred).toBe(720);
    expect(tailed.belts[0].totalTransferred).toBe(integer.belts[0].totalTransferred);
    expect(tailed.belts[0].progress).toBeCloseTo(integer.belts[0].progress, 5);
    expect(tailed.belts[0].lastFlow).not.toBe(9.6);
  });

  it("keeps the persistent worker runtime equivalent to cloned simulation chunks", () => {
    const source = createInitialState(42_042);
    const runtime = createPersistentSimulationRuntime(structuredClone(source));
    let persistent = runtime.state;
    let cloned = structuredClone(source);
    for (const seconds of [1, 1, 2, 0.5, 3]) {
      persistent = advancePersistentSimulationRuntime(runtime, seconds, seconds).state;
      cloned = advanceSimulation(cloned, seconds);
    }
    expect(JSON.parse(JSON.stringify(persistent))).toEqual(JSON.parse(JSON.stringify(cloned)));
  });

  it("commits a million-unit blueprint atomically and refuses shortages", () => {
    const state = createInitialState();
    const blueprint = {
      id: "blueprint_huge_fixture",
      name: "百万熔炉夹具",
      entities: [{ key: "node_1", buildingId: "arc_smelter" as const, offset: { x: 0, y: 0 }, machineCount: 1_000_000 }],
      belts: [],
    };
    const stocked = { ...state, blueprints: [blueprint], construction: { ...state.construction, arc_smelter: 1_000_000 } };
    const deployed = placeBlueprint(stocked, blueprint.id, { x: 120, y: 120 });
    expect(deployed).not.toBe(stocked);
    expect(deployed.construction.arc_smelter).toBe(0);
    expect(deployed.entities.at(-1)).toMatchObject({ buildingId: "arc_smelter", machineCount: 1_000_000 });
    const shortage = { ...stocked, construction: { ...stocked.construction, arc_smelter: 999_999 } };
    expect(placeBlueprint(shortage, blueprint.id, { x: 120, y: 120 })).toBe(shortage);
    expect(shortage.construction.arc_smelter).toBe(999_999);
  });

  it("caps every new building stack at one hundred million while preserving reducible historical stacks", () => {
    let state = createInitialState();
    state.construction.storage_mk1 = MAX_BUILDING_STACK_COUNT;
    state = placeBuilding(state, "storage_mk1", { x: 120, y: 80 }, MAX_BUILDING_STACK_COUNT);
    const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    expect(storage.machineCount).toBe(MAX_BUILDING_STACK_COUNT);
    expect(state.construction.storage_mk1).toBe(0);

    state.construction.storage_mk1 = 1;
    expect(addUnitToEntityGroup(state, storage.id)).toBe(state);
    expect(getBuildingStackAdditionCheck(MAX_BUILDING_STACK_COUNT, 1, "储物仓")).toMatchObject({ ok: false, code: "stack-limit" });

    storage.machineCount = MAX_BUILDING_STACK_COUNT + 1;
    const historical = state;
    expect(addUnitToEntityGroup(historical, storage.id)).toBe(historical);
    const reduced = removeEntity(historical, storage.id, 1);
    expect(reduced.entities.find((entity) => entity.id === storage.id)?.machineCount).toBe(MAX_BUILDING_STACK_COUNT);
    expect(reduced.construction.storage_mk1).toBe(2);

    const unsafeRefund = {
      ...reduced,
      construction: { ...reduced.construction, storage_mk1: Number.MAX_SAFE_INTEGER },
    };
    const beforeEntity = unsafeRefund.entities.find((entity) => entity.id === storage.id);
    expect(removeEntity(unsafeRefund, storage.id, 1)).toBe(unsafeRefund);
    expect(unsafeRefund.entities.find((entity) => entity.id === storage.id)).toBe(beforeEntity);
    expect(getEntityRemovalPreview(unsafeRefund, [storage.id]).refundSafe).toBe(false);

    const invalidBatch = { ...reduced, construction: { ...reduced.construction, storage_mk1: MAX_BUILDING_STACK_COUNT + 1 } };
    expect(placeBuilding(invalidBatch, "storage_mk1", { x: 420, y: 80 }, MAX_BUILDING_STACK_COUNT + 1)).toBe(invalidBatch);
    expect(invalidBatch.construction.storage_mk1).toBe(MAX_BUILDING_STACK_COUNT + 1);
  });

  it("returns the exact affected belt id for new and parallel connections", () => {
    let state = createInitialState();
    state.construction.storage_mk1 = 1;
    state.construction.material_delivery_hub = 1;
    state.construction.conveyor_belt_mk1 = 4;
    state.construction.conveyor_belt_mk2 = 1;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "material_delivery_hub", { x: 320, y: 0 });
    const source = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    const target = state.entities.find((entity) => entity.buildingId === "material_delivery_hub")!;
    source.storedItemId = "iron_ingot";
    source.outputs.iron_ingot = 100;

    const first = connectBeltWithResult(state, source.id, target.id, "iron_ingot", 1, 0);
    expect(first).toMatchObject({ created: true, beltId: expect.any(String) });
    const parallel = connectBeltWithResult(first.state, source.id, target.id, "iron_ingot", 1, 0);
    expect(parallel.beltId).toBe(first.beltId);
    expect(parallel.created).toBe(false);
    expect(parallel.state.belts.find((belt) => belt.id === first.beltId)?.lanes).toBe(2);

    const otherPort = connectBeltWithResult(parallel.state, source.id, target.id, "iron_ingot", 1, 1);
    expect(otherPort.created).toBe(true);
    expect(otherPort.beltId).not.toBe(first.beltId);
    expect(otherPort.state.belts.find((belt) => belt.id === otherPort.beltId)).toMatchObject({
      source: source.id,
      target: target.id,
      itemId: "iron_ingot",
      targetPortIndex: 1,
      tier: 1,
    });
    const wrongTier = connectBeltWithResult(otherPort.state, source.id, target.id, "iron_ingot", 2, 1);
    expect(wrongTier).toMatchObject({ state: otherPort.state, beltId: null, created: false });
  });

  it("edits a remote station without switching planets and preserves refunds and fleet inventory", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics", "space_warp");
    state.exploration.colonizedPlanetIds.push("ashen");
    state.construction.interstellar_logistics_station = 3;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 200, y: 0 });
    const stationId = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!.id;
    state = setStationSlotItem(state, stationId, 0, "iron_ingot");
    const station = state.entities.find((entity) => entity.id === stationId)!;
    station.inputs.iron_ingot = 7;
    station.outputs.iron_ingot = 11;
    state.portableFleet.logistics_drone = 5;
    state.tray.space_warper = 12;
    state = setActivePlanet(state, "ashen");

    const changed = setRemoteStationSlotItem(state, stationId, 0, "copper_ingot");
    expect(changed.activePlanetId).toBe("ashen");
    expect(getStationSlots(changed.entities.find((entity) => entity.id === stationId)!)[0].itemId).toBe("copper_ingot");
    expect(changed.planetTrays.home.iron_ingot).toBe(18);
    expect(changed.tray.iron_ingot ?? 0).toBe(0);

    let configured = setStationSlotMode(changed, stationId, 0, "local", "demand");
    configured = setStationSlotMode(configured, stationId, 0, "remote", "demand");
    configured = setStationSlotMinimumLoad(configured, stationId, 0, 0.5);
    configured = setStationSlotLimits(configured, stationId, 0, 10, 200);
    configured = setStationSlotPriority(configured, stationId, 0, 2);
    configured = setStationWarpEnabled(configured, stationId, false);
    configured = setStationWarperAutoRefill(configured, stationId, true);
    configured = setStationWarperTarget(configured, stationId, 25);
    const configuredStation = configured.entities.find((entity) => entity.id === stationId)!;
    expect(configured.activePlanetId).toBe("ashen");
    expect(getStationSlots(configuredStation)[0]).toMatchObject({
      itemId: "copper_ingot",
      localMode: "demand",
      remoteMode: "demand",
      minimumLoad: 0.5,
      minStock: 10,
      maxStock: 200,
      priority: 2,
    });
    expect(configuredStation).toMatchObject({ stationWarpEnabled: false, stationWarperAutoRefill: true, stationWarperTarget: 25 });

    const fleet = setRemoteStationFleetTarget(configured, stationId, "drone", 3);
    expect(fleet.state.activePlanetId).toBe("ashen");
    expect(fleet.final).toBe(3);
    expect(fleet.state.portableFleet.logistics_drone).toBe(2);
    const warped = adjustRemoteStationWarpers(fleet.state, stationId, 5);
    expect(warped.activePlanetId).toBe("ashen");
    expect(warped.entities.find((entity) => entity.id === stationId)?.stationWarpers).toBe(5);
    expect(warped.planetTrays.home.space_warper).toBe(7);

    const stacked = setRemoteBuildingStackTarget(warped, stationId, 2);
    expect(stacked.activePlanetId).toBe("ashen");
    expect(stacked.entities.find((entity) => entity.id === stationId)?.machineCount).toBe(2);
    expect(stacked.construction.interstellar_logistics_station).toBe(1);
  });

  it("previews and removes selected entities through the shared removal commands", () => {
    let state = createInitialState();
    state.construction.storage_mk1 = 2;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: 300, y: 0 });
    const [source, target] = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    source.storedItemId = "iron_ingot";
    source.outputs.iron_ingot = 3;
    target.storedItemId = "iron_ingot";
    state = connectBelt(state, source.id, target.id, "iron_ingot");
    const preview = getEntityRemovalPreview(state, [source.id, target.id]);
    expect(preview).toMatchObject({ entityCount: 2, buildingCount: 2, relatedBeltCount: 1 });
    expect(preview.returns).toEqual(expect.arrayContaining([
      { constructionId: "storage_mk1", amount: 2 },
      { constructionId: "conveyor_belt_mk1", amount: 1 },
    ]));

    const removed = removeEntities(state, [source.id, target.id]);
    expect(removed.entities.some((entity) => entity.id === source.id || entity.id === target.id)).toBe(false);
    expect(removed.belts).toHaveLength(0);
    expect(removed.construction.storage_mk1).toBe(2);
    expect(removed.construction.conveyor_belt_mk1).toBe(1);
    expect(removeBelt(removed, "missing-belt")).toBe(removed);
  });
});
