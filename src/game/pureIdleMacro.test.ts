import { describe, expect, it } from "vitest";
import { createContentPackRegistry } from "./contentPacks";
import { createInitialState } from "./engine";
import { hashGameState } from "./benchmark";
import {
  applyPureIdleMacroFinalState,
  advancePureIdleMacroSession,
  createConservativePureIdleMacroSession,
  createPureIdleMacroSession,
  PURE_IDLE_MACRO_ALGORITHM_VERSION,
  PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS,
  PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS,
} from "./pureIdleMacro";
import { finalizePureIdleMacroSession } from "./pureIdleMacroValidation";
import {
  advanceConstructionAutomationMacroWithReceiptInPlace,
  advanceExactSimulationWindow,
  applyPureIdleAffineContract,
  applyPureIdleLightweightContractInPlace,
  captureAggregateConservationBaseline,
  capturePureIdleCombinedConservationCheckpoint,
  createPureIdleLightweightCalibration,
  reconcilePureIdleLightweightMaterialDeltas,
  runFastOfflineSettlement,
  validateAggregateConservation,
  validatePureIdleCombinedSettlementConservation,
  validatePureIdleTerminalMaterialConservation,
  type PureIdleAffineContract,
} from "./offlineApproximation";
import { inspectSave, serializeEnvelope } from "./storage";
import type { GameState } from "./types";

function pureIdleState(): GameState {
  const state = createInitialState(undefined, false);
  state.entities = [{
    id: "pure-idle-controller",
    kind: "machine",
    planetId: "home",
    position: { x: 0, y: 0 },
    interactionLocked: false,
    buildingId: "time_warp_device",
    machineCount: 1,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  }];
  state.belts = [];
  state.constructionAutomation.enabled = false;
  state.paused = false;
  state.timeWarp.controllerEntityId = "pure-idle-controller";
  state.timeWarp.enabled = true;
  state.timeWarp.effectiveMultiplier = state.settings.simulationSpeed;
  state.timeWarp.pendingSimulationSeconds = 0;
  state.timeWarp.pendingWallSeconds = 0;
  return state;
}

function addWindGeneration(state: GameState, machineCount: number): void {
  state.entities.push({
    id: `pure-idle-wind-${machineCount}`,
    kind: "power",
    planetId: "home",
    position: { x: -100, y: 0 },
    interactionLocked: false,
    buildingId: "wind_turbine",
    machineCount,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
}

function addProductiveSmelter(state: GameState, machineCount = 1_000): void {
  addWindGeneration(state, 50_000_000);
  state.entities.push({
    id: "pure-idle-smelter",
    kind: "machine",
    planetId: "home",
    position: { x: 100, y: 0 },
    interactionLocked: false,
    buildingId: "arc_smelter",
    recipeId: "iron_ingot",
    machineCount,
    minerCount: 0,
    inputs: { iron_ore: machineCount * 100 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
}

function addFiniteArtificialStarSmelter(state: GameState, fuelSimulationSeconds: number): void {
  state.timeWarp.requestedMultiplier = 16;
  const totalFuelHeatMj = 100_000_000_000_000 * fuelSimulationSeconds;
  const queuedFuelRods = Math.floor(totalFuelHeatMj / 7_200);
  const loadedFuelHeatMj = totalFuelHeatMj - queuedFuelRods * 7_200;
  state.entities.push({
    id: "pure-idle-finite-star",
    kind: "power",
    planetId: "home",
    position: { x: -100, y: 0 },
    interactionLocked: false,
    buildingId: "artificial_star",
    machineCount: 1_527_777_777_778,
    minerCount: 0,
    fuelItemId: "antimatter_fuel_rod",
    fuelRemainingMj: loadedFuelHeatMj,
    inputs: { antimatter_fuel_rod: queuedFuelRods },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  }, {
    id: "pure-idle-smelter",
    kind: "machine",
    planetId: "home",
    position: { x: 100, y: 0 },
    interactionLocked: false,
    buildingId: "arc_smelter",
    recipeId: "iron_ingot",
    machineCount: 100,
    minerCount: 0,
    inputs: { iron_ore: 1_000_000 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
}

function addSustainableArtificialStarSmelter(state: GameState): void {
  state.settings.resourceMode = "infinite";
  state.timeWarp.requestedMultiplier = 16;
  // Renewable generation deliberately leaves a tiny (< 0.000001%) gap at
  // the 1e17 kW 16x threshold. The artificial star is nevertheless essential:
  // removing its fuel drops the discrete time-warp multiplier.
  addWindGeneration(state, 347_222_222_172_362);
  state.entities.push({
    id: "pure-idle-sustainable-star",
    kind: "power",
    planetId: "home",
    position: { x: -120, y: 0 },
    interactionLocked: false,
    buildingId: "artificial_star",
    machineCount: 1_000,
    minerCount: 0,
    fuelItemId: "antimatter_fuel_rod",
    fuelRemainingMj: 3_600,
    inputs: { antimatter_fuel_rod: 100 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  }, {
    id: "pure-idle-sustainable-fuel",
    kind: "vein",
    planetId: "home",
    position: { x: -200, y: -40 },
    interactionLocked: false,
    resourceId: "antimatter_fuel_rod",
    extractorBuildingId: "mining_machine",
    powerGridId: "grid-a",
    powerPriority: 2,
    machineCount: 0,
    minerCount: 10,
    inputs: {},
    outputs: { antimatter_fuel_rod: 100 },
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  }, {
    id: "pure-idle-smelter",
    kind: "machine",
    planetId: "home",
    position: { x: 100, y: 0 },
    interactionLocked: false,
    buildingId: "arc_smelter",
    recipeId: "iron_ingot",
    machineCount: 100,
    minerCount: 0,
    inputs: { iron_ore: 1_000_000 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
  state.belts.push({
    id: "pure-idle-sustainable-fuel-feed",
    planetId: "home",
    source: "pure-idle-sustainable-fuel",
    target: "pure-idle-sustainable-star",
    itemId: "antimatter_fuel_rod",
    lanes: 4_096,
    tier: 3,
    sorterTier: 3,
    progress: 0,
    priority: 1,
    totalTransferred: 0,
    lastFlow: 0,
  });
}

function addRecipeArtificialStarFuelChain(state: GameState, options: {
  connectStar?: boolean;
  sustainableInputs?: boolean;
} = {}): void {
  const connectStar = options.connectStar ?? true;
  const sustainableInputs = options.sustainableInputs ?? true;
  state.settings.resourceMode = "infinite";
  state.galaxy.profiles.home.windMultiplier = 1;
  state.timeWarp.requestedMultiplier = 5;
  if (!state.research.completedTechIds.includes("antimatter")) {
    state.research.completedTechIds.push("antimatter");
  }
  // Leave a measured 71.5 MW gap after the four input miners and fuel
  // assembler. One artificial star must cover it to retain the requested 5x.
  addWindGeneration(state, 3_160);
  const recipeInputs = [
    "antimatter",
    "hydrogen",
    "annihilation_constraint_sphere",
    "titanium_alloy",
  ] as const;
  if (sustainableInputs) {
    for (const [index, itemId] of recipeInputs.entries()) {
      state.entities.push({
        id: `pure-idle-recipe-fuel-source-${itemId}`,
        kind: "vein",
        planetId: "home",
        position: { x: -300, y: index * 30 },
        interactionLocked: false,
        resourceId: itemId,
        extractorBuildingId: "mining_machine",
        powerGridId: "grid-a",
        powerPriority: 2,
        machineCount: 0,
        minerCount: 10,
        inputs: {},
        outputs: { [itemId]: 0 },
        progress: 0,
        routingCursor: 0,
        utilization: 0,
        productionRate: 0,
      });
      state.belts.push({
        id: `pure-idle-recipe-fuel-input-${itemId}`,
        planetId: "home",
        source: `pure-idle-recipe-fuel-source-${itemId}`,
        target: "pure-idle-recipe-fuel-producer",
        itemId,
        lanes: 1,
        tier: 3,
        sorterTier: 3,
        progress: 0,
        priority: 1,
        totalTransferred: 0,
        lastFlow: 0,
      });
    }
  }
  state.entities.push({
    id: "pure-idle-recipe-fuel-producer",
    kind: "machine",
    planetId: "home",
    position: { x: -160, y: 0 },
    interactionLocked: false,
    buildingId: "assembling_machine_mk1",
    recipeId: "antimatter_fuel_rod",
    powerGridId: "grid-a",
    powerPriority: 2,
    machineCount: 10,
    minerCount: 0,
    inputs: {
      antimatter: 1_000,
      hydrogen: 1_000,
      annihilation_constraint_sphere: 1_000,
      titanium_alloy: 1_000,
    },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  }, {
    id: "pure-idle-recipe-fuel-relay",
    kind: "splitter",
    planetId: "home",
    position: { x: -80, y: 0 },
    interactionLocked: false,
    buildingId: "splitter_4way",
    storedItemId: "antimatter_fuel_rod",
    machineCount: 10,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  }, {
    id: "pure-idle-recipe-fuel-star",
    kind: "power",
    planetId: "home",
    position: { x: 0, y: 0 },
    interactionLocked: false,
    buildingId: "artificial_star",
    powerGridId: "grid-a",
    powerPriority: 2,
    machineCount: 1,
    minerCount: 0,
    fuelItemId: "antimatter_fuel_rod",
    fuelRemainingMj: 3_600,
    inputs: { antimatter_fuel_rod: 10 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
  state.belts.push({
    id: "pure-idle-recipe-fuel-to-relay",
    planetId: "home",
    source: "pure-idle-recipe-fuel-producer",
    target: "pure-idle-recipe-fuel-relay",
    itemId: "antimatter_fuel_rod",
    lanes: 1,
    tier: 3,
    sorterTier: 3,
    progress: 0,
    priority: 1,
    totalTransferred: 0,
    lastFlow: 0,
  });
  if (connectStar) {
    state.belts.push({
      id: "pure-idle-recipe-fuel-relay-to-star",
      planetId: "home",
      source: "pure-idle-recipe-fuel-relay",
      target: "pure-idle-recipe-fuel-star",
      itemId: "antimatter_fuel_rod",
      lanes: 1,
      tier: 3,
      sorterTier: 3,
      progress: 0,
      priority: 1,
      totalTransferred: 0,
      lastFlow: 0,
    });
  }
}

function addInfiniteIronSupply(state: GameState): void {
  state.settings.resourceMode = "infinite";
  state.entities.push({
    id: "pure-idle-infinite-iron",
    kind: "vein",
    planetId: "home",
    position: { x: -200, y: 0 },
    interactionLocked: false,
    resourceId: "iron_ore",
    extractorBuildingId: "mining_machine",
    powerGridId: "grid-a",
    powerPriority: 2,
    machineCount: 0,
    minerCount: 1_000,
    inputs: {},
    outputs: { iron_ore: 1_000 },
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
  state.belts.push({
    id: "pure-idle-infinite-iron-feed",
    planetId: "home",
    source: "pure-idle-infinite-iron",
    target: "pure-idle-smelter",
    itemId: "iron_ore",
    lanes: 1,
    tier: 3,
    sorterTier: 3,
    progress: 0,
    priority: 1,
    totalTransferred: 0,
    lastFlow: 0,
  });
}

function addRecursiveConstructionCenter(state: GameState, target = 100): void {
  addWindGeneration(state, 50_000_000);
  if (!state.research.completedTechIds.includes("construction_automation")) {
    state.research.completedTechIds.push("construction_automation");
  }
  state.constructionAutomation.enabled = true;
  state.constructionAutomation.targetStock.arc_smelter = target;
  state.construction.arc_smelter = 0;
  state.tray = { iron_ore: target * 20, copper_ore: target * 10, stone: target * 10 };
  state.planetTrays.home = state.tray;
  state.entities.push({
    id: "pure-idle-construction-center",
    kind: "machine",
    planetId: "home",
    position: { x: 0, y: 0 },
    interactionLocked: false,
    buildingId: "construction_center",
    machineCount: 1_000,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
}

function addJointConstructionPowerFixture(state: GameState, options: {
  target?: number;
  centerCount?: number;
  centerGrid?: "grid-a" | "grid-b" | "grid-c";
  wind?: number;
  smelters?: number;
  otherGridWind?: number;
  idleExhaustibles?: boolean;
} = {}): void {
  const target = options.target ?? 12;
  const centerCount = options.centerCount ?? 1;
  const centerGrid = options.centerGrid ?? "grid-b";
  const controller = state.entities.find((entity) => entity.id === "pure-idle-controller")!;
  controller.powerGridId = "grid-c";
  state.galaxy.profiles.home.windMultiplier = 1;
  state.settings.simulationSpeed = 4;
  state.timeWarp.requestedMultiplier = 8;
  if (!state.research.completedTechIds.includes("construction_automation")) {
    state.research.completedTechIds.push("construction_automation");
  }
  state.constructionAutomation.enabled = true;
  state.constructionAutomation.targetStock.arc_smelter = target;
  state.construction.arc_smelter = 0;
  state.tray = {
    iron_ingot: target * 4,
    stone_brick: target * 2,
    circuit_board: target * 4,
    magnetic_coil: target * 2,
  };
  state.planetTrays.home = state.tray;
  const pushWind = (id: string, gridId: "grid-a" | "grid-b" | "grid-c", machineCount: number) => {
    if (machineCount <= 0) return;
    state.entities.push({
      id, kind: "power", planetId: "home", position: { x: -100, y: 0 }, interactionLocked: false,
      buildingId: "wind_turbine", powerGridId: gridId, machineCount, minerCount: 0,
      inputs: {}, outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
  };
  pushWind("joint-wind", centerGrid, options.wind ?? 80);
  pushWind("joint-other-wind", centerGrid === "grid-a" ? "grid-b" : "grid-a", options.otherGridWind ?? 0);
  if ((options.smelters ?? 20) > 0) {
    state.entities.push({
      id: "joint-load", kind: "machine", planetId: "home", position: { x: 100, y: 0 },
      interactionLocked: false, buildingId: "arc_smelter", recipeId: "iron_ingot",
      powerGridId: centerGrid, machineCount: options.smelters ?? 20, minerCount: 0,
      inputs: { iron_ore: 1_000_000 }, outputs: {}, progress: 0, routingCursor: 0,
      utilization: 0, productionRate: 0,
    });
  }
  for (let index = 0; index < centerCount; index += 1) {
    state.entities.push({
      id: `joint-center-${index}`, kind: "machine", planetId: "home", position: { x: index * 20, y: 40 },
      interactionLocked: false, buildingId: "construction_center", powerGridId: centerGrid,
      machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0, routingCursor: 0,
      utilization: 0, productionRate: 0,
    });
  }
  if (options.idleExhaustibles) {
    state.entities.push({
      id: "joint-idle-star", kind: "power", planetId: "home", position: { x: -140, y: 0 },
      interactionLocked: false, buildingId: "artificial_star", powerGridId: centerGrid,
      machineCount: 1, minerCount: 0, fuelItemId: "antimatter_fuel_rod", fuelRemainingMj: 3_600,
      inputs: { antimatter_fuel_rod: 1 }, outputs: {}, progress: 0, routingCursor: 0,
      utilization: 0, productionRate: 0, powerOutputKw: 0,
    }, {
      id: "joint-full-acc", kind: "power", planetId: "home", position: { x: -160, y: 0 },
      interactionLocked: false, buildingId: "accumulator", powerGridId: centerGrid,
      machineCount: 1, minerCount: 0, storedEnergyMj: 90, inputs: {}, outputs: {}, progress: 0,
      routingCursor: 0, utilization: 0, productionRate: 0, powerOutputKw: 0, powerInputKw: 0,
    });
  }
}

function addSlowProductiveAssembler(state: GameState): void {
  addWindGeneration(state, 50_000_000);
  if (!state.research.completedTechIds.includes("antimatter")) state.research.completedTechIds.push("antimatter");
  state.entities.push({
    id: "pure-idle-slow-assembler",
    kind: "machine",
    planetId: "home",
    position: { x: 100, y: 100 },
    interactionLocked: false,
    buildingId: "assembling_machine_mk1",
    recipeId: "annihilation_constraint_sphere",
    machineCount: 1,
    minerCount: 0,
    inputs: { particle_container: 10_000, processor: 10_000 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
}

function addPrefilledResearchLabWithoutUpstream(state: GameState, amount = 500): void {
  addWindGeneration(state, 50_000_000);
  state.research.selectedTechId = "time_warp_engineering";
  state.entities.push({
    id: "prefilled-research-lab",
    kind: "machine",
    planetId: "home",
    position: { x: 160, y: 80 },
    interactionLocked: false,
    buildingId: "matrix_lab",
    recipeId: "matrix_research",
    machineCount: 1,
    minerCount: 0,
    inputs: { electromagnetic_matrix: amount },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
}

function addPartiallySuppliedResearchChain(state: GameState): void {
  state.settings.resourceMode = "infinite";
  addWindGeneration(state, 1_000_000_000);
  const machine = (
    id: string,
    buildingId: GameState["entities"][number]["buildingId"],
    recipeId: GameState["entities"][number]["recipeId"],
    machineCount: number,
    inputs: GameState["entities"][number]["inputs"],
  ): GameState["entities"][number] => ({
    id,
    kind: "machine",
    planetId: "home",
    position: { x: state.entities.length * 40, y: 120 },
    interactionLocked: false,
    buildingId,
    recipeId,
    machineCount,
    minerCount: 0,
    inputs,
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
  state.entities.push({
    id: "steady-research-iron-vein",
    kind: "vein",
    planetId: "home",
    position: { x: -400, y: 120 },
    interactionLocked: false,
    resourceId: "iron_ore",
    extractorBuildingId: "mining_machine",
    machineCount: 0,
    minerCount: 1_000,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  }, {
    id: "steady-research-copper-vein",
    kind: "vein",
    planetId: "home",
    position: { x: -360, y: 120 },
    interactionLocked: false,
    resourceId: "copper_ore",
    extractorBuildingId: "mining_machine",
    machineCount: 0,
    minerCount: 1_000,
    inputs: {},
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  },
  machine("steady-research-magnet", "arc_smelter", "magnet", 100, { iron_ore: 1_000_000 }),
  machine("steady-research-iron", "arc_smelter", "iron_ingot", 100, { iron_ore: 1_000_000 }),
  machine("steady-research-copper", "arc_smelter", "copper_ingot", 100, { copper_ore: 1_000_000 }),
  // One coil assembler intentionally supplies less than the matrix labs use.
  // Its own inputs remain sustainably supplied by the high-rate upstream.
  machine("steady-research-coil", "assembling_machine_mk1", "magnetic_coil", 1, {
    magnet: 1_000_000,
    copper_ingot: 1_000_000,
  }),
  machine("steady-research-board", "assembling_machine_mk1", "circuit_board", 20, {
    iron_ingot: 1_000_000,
    copper_ingot: 1_000_000,
  }),
  machine("steady-research-matrix", "matrix_lab", "electromagnetic_matrix", 12, {
    magnetic_coil: 1_000_000,
    circuit_board: 1_000_000,
  }),
  machine("steady-research-consumer", "matrix_lab", "matrix_research", 1, {
    electromagnetic_matrix: 1_000,
  }));
  state.research.selectedTechId = "high_efficiency_plasma_control";
}

function addRocketConservationFixture(state: GameState, prefilledRockets = 1_000_000): void {
  addWindGeneration(state, 1_000_000_000_000_000);
  if (!state.research.completedTechIds.includes("vertical_launching_silo")) {
    state.research.completedTechIds.push("vertical_launching_silo");
  }
  state.dysonEngineering.launchEnabled = true;
  state.dysonEngineering.launchMode = "sphere";
  state.dysonEngineering.launchThrottle = 1;
  state.entities.push({
    id: "slow-rocket-producer",
    kind: "machine",
    planetId: "home",
    position: { x: 100, y: 0 },
    interactionLocked: false,
    buildingId: "assembling_machine_mk1",
    recipeId: "small_carrier_rocket",
    machineCount: 6,
    minerCount: 0,
    inputs: { dyson_sphere_component: 10_000, deuteron_fuel_rod: 20_000, quantum_chip: 10_000 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  }, {
    id: "prefilled-rocket-silo",
    kind: "machine",
    planetId: "home",
    position: { x: 200, y: 0 },
    interactionLocked: false,
    buildingId: "vertical_launching_silo",
    recipeId: "carrier_rocket_launch",
    machineCount: 1_000_000,
    minerCount: 0,
    inputs: { small_carrier_rocket: prefilledRockets },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
  });
  state.belts.push({
    id: "slow-rocket-feed",
    planetId: "home",
    source: "slow-rocket-producer",
    target: "prefilled-rocket-silo",
    itemId: "small_carrier_rocket",
    lanes: 1,
    tier: 1,
    sorterTier: 1,
    progress: 0,
    priority: 1,
    totalTransferred: 0,
    lastFlow: 0,
  });
}

function addSolarSailConservationFixture(state: GameState, prefilledSails = 1_000): void {
  addWindGeneration(state, 1_000_000_000_000_000);
  if (!state.research.completedTechIds.includes("dyson_swarm")) {
    state.research.completedTechIds.push("dyson_swarm");
  }
  state.dysonEngineering.launchEnabled = true;
  state.dysonEngineering.launchMode = "swarm";
  state.dysonEngineering.launchThrottle = 1;
  state.entities.push({
    id: "prefilled-sail-ejector",
    kind: "machine",
    planetId: "home",
    position: { x: 300, y: 0 },
    interactionLocked: false,
    buildingId: "em_rail_ejector",
    recipeId: "solar_sail_launch",
    machineCount: 1_000,
    minerCount: 0,
    inputs: { solar_sail: prefilledSails },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
    targetDysonOrbitId: "dyson_orbit_helios_1",
  });
}

function addSecondRocketSystemFixture(state: GameState, prefilledRockets = 1_000_000): void {
  const wind = state.entities.find((entity) => entity.id.startsWith("pure-idle-wind-"));
  const producer = state.entities.find((entity) => entity.id === "slow-rocket-producer");
  const silo = state.entities.find((entity) => entity.id === "prefilled-rocket-silo");
  const feed = state.belts.find((belt) => belt.id === "slow-rocket-feed");
  if (!wind || !producer || !silo || !feed) throw new Error("primary rocket fixture is incomplete");
  producer.machineCount = 600;
  producer.inputs = {
    dyson_sphere_component: 1_000_000_000,
    deuteron_fuel_rod: 2_000_000_000,
    quantum_chip: 1_000_000_000,
  };
  state.entities.push({
    ...structuredClone(wind),
    id: "borealis-rocket-wind",
    planetId: "frost",
  }, {
    ...structuredClone(producer),
    id: "borealis-rocket-producer",
    planetId: "frost",
  }, {
    ...structuredClone(silo),
    id: "borealis-rocket-silo",
    planetId: "frost",
    inputs: { small_carrier_rocket: prefilledRockets },
  });
  state.belts.push({
    ...structuredClone(feed),
    id: "borealis-rocket-feed",
    planetId: "frost",
    source: "borealis-rocket-producer",
    target: "borealis-rocket-silo",
  });
}

describe("pure idle macro session", () => {
  it("binds stop settlement, completed research, and the original pause intent before serialization", () => {
    const baseline = pureIdleState();
    baseline.idleSettlement = {
      currentRunStartedAt: 1_000,
      currentRunElapsed: 30,
      lastSettledAt: 30,
      totalIdleTime: 40,
      currentRunProduction: { iron_ore: 2 },
      totalProduction: { iron_ore: 7 },
    };
    baseline.totalProduced.iron_ore = 10;
    const candidate = structuredClone(baseline);
    candidate.totalProduced.iron_ore = 18;
    candidate.research.completedTechIds.push("antimatter");
    candidate.research.selectedTechId = "universe_matrix";
    candidate.research.queuedTechIds = ["micro_black_hole_containment"];
    candidate.research.progressByTech.universe_matrix = {
      electromagnetic_matrix: 100,
      energy_matrix: 100,
      structure_matrix: 100,
      information_matrix: 100,
      gravity_matrix: 100,
    };
    candidate.paused = false;
    candidate.timeWarp.pendingSimulationSeconds = 12;
    candidate.timeWarp.pendingWallSeconds = 3;

    const finalized = applyPureIdleMacroFinalState(candidate, 90, {
      startedPaused: true,
      baselineIdleSettlement: baseline.idleSettlement,
      baselineTotalProduced: baseline.totalProduced,
    });

    expect(finalized).not.toBe(candidate);
    expect(candidate.research.completedTechIds).not.toContain("universe_matrix");
    expect(finalized.research.completedTechIds).toContain("universe_matrix");
    expect(finalized.research.selectedTechId).toBe("micro_black_hole_containment");
    expect(finalized.paused).toBe(true);
    expect(finalized.timeWarp).toMatchObject({ pendingSimulationSeconds: 0, pendingWallSeconds: 0 });
    expect(finalized.idleSettlement).toMatchObject({
      currentRunStartedAt: null,
      currentRunElapsed: 90,
      lastSettledAt: 90,
      totalIdleTime: 100,
      currentRunProduction: { iron_ore: 8 },
      totalProduction: { iron_ore: 13 },
    });
  });

  it("uses three fixed calibration windows and advances only committed wall time", () => {
    const source = pureIdleState();
    const before = hashGameState(source);
    const session = createPureIdleMacroSession(structuredClone(source), "stable");

    const summary = advancePureIdleMacroSession(session, 90);

    expect(summary.algorithmVersion).toBe(PURE_IDLE_MACRO_ALGORITHM_VERSION);
    expect(summary.calibrationWindowsCompleted).toBe(3);
    expect(summary.settledWallSeconds).toBe(90);
    expect(summary.settledSimulationSeconds).toBe(90 * source.settings.simulationSpeed);
    expect(session.candidate.elapsedSeconds - source.elapsedSeconds).toBeCloseTo(summary.settledSimulationSeconds, 6);
    expect(hashGameState(source)).toBe(before);
  });

  it("refreshes a stale stopped multiplier to the requested 9x power allocation", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    source.timeWarp.effectiveMultiplier = 1;
    addWindGeneration(source, 50_000_000);

    const session = createPureIdleMacroSession(structuredClone(source), "extreme");
    const summary = advancePureIdleMacroSession(session, 30);

    expect(summary.requestedMultiplier).toBe(9);
    expect(summary.powerLimitedMultiplier).toBe(9);
    expect(summary.actualMultiplier).toBe(9);
    expect(summary.settledSimulationSeconds).toBe(270);
  });

  it("keeps an interaction-locked controller powered during macro startup", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    source.timeWarp.effectiveMultiplier = 1;
    const controller = source.entities.find((entity) => entity.id === source.timeWarp.controllerEntityId)!;
    controller.interactionLocked = true;
    addWindGeneration(source, 50_000_000);

    const summary = advancePureIdleMacroSession(
      createPureIdleMacroSession(structuredClone(source), "extreme"),
      30,
    );

    expect(summary.powerLimitedMultiplier).toBe(9);
    expect(summary.actualMultiplier).toBe(9);
    expect(summary.settledSimulationSeconds).toBe(270);
  });

  it("uses the highest power-supported 7x multiplier instead of the stale value", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    source.timeWarp.effectiveMultiplier = 1;
    addWindGeneration(source, 1_000_000);

    const summary = advancePureIdleMacroSession(
      createPureIdleMacroSession(structuredClone(source), "extreme"),
      30,
    );

    expect(summary.powerLimitedMultiplier).toBe(7);
    expect(summary.settledSimulationSeconds).toBe(210);
  });

  it("is deterministic across incremental and one-target settlement", () => {
    const source = pureIdleState();
    const incremental = createPureIdleMacroSession(structuredClone(source), "stable");
    advancePureIdleMacroSession(incremental, 30);
    advancePureIdleMacroSession(incremental, 60);
    advancePureIdleMacroSession(incremental, 90);

    const single = createPureIdleMacroSession(structuredClone(source), "stable");
    advancePureIdleMacroSession(single, 90);

    expect(hashGameState(incremental.candidate)).toBe(hashGameState(single.candidate));
    expect(incremental.settledSimulationSeconds).toBe(single.settledSimulationSeconds);
  });

  it("runs fixed shadow validation only in stable mode", () => {
    const source = pureIdleState();
    const stable = createPureIdleMacroSession(structuredClone(source), "stable");
    const extreme = createPureIdleMacroSession(structuredClone(source), "extreme");

    const stableSummary = advancePureIdleMacroSession(stable, PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS);
    const extremeSummary = advancePureIdleMacroSession(extreme, PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS * 2);

    expect(stableSummary.validationCount + stableSummary.validationFailures).toBe(1);
    expect(stableSummary.nextValidationAtWallSeconds).toBe(PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS * 2);
    expect(extremeSummary.validationCount).toBe(0);
    expect(extremeSummary.validationFailures).toBe(0);
    expect(extremeSummary.nextValidationAtWallSeconds).toBeNull();
  });

  it("drops a stale rocket ledger and starts a fresh remainder epoch after stable shadow validation", () => {
    const rocketSource = pureIdleState();
    rocketSource.settings.simulationSpeed = 4;
    rocketSource.timeWarp.requestedMultiplier = 15;
    addRocketConservationFixture(rocketSource, 0);
    const rocketSession = createConservativePureIdleMacroSession(
      structuredClone(rocketSource),
      "stable",
      "shadow validation rocket epoch regression",
    );
    expect(rocketSession.rocketLedger).toBeDefined();

    const stable = createPureIdleMacroSession(structuredClone(pureIdleState()), "stable");
    stable.rocketLedger = rocketSession.rocketLedger;
    stable.rocketLaunchRemaindersBySystem = { helios: 0.75 };
    stable.nextValidationAtWallSeconds = stable.settledWallSeconds;
    // Enter the public settlement path without advancing a rocket bucket. The
    // pending construction second is harmless for this fixture, but allows
    // the due stable validation to run at the current wall-clock boundary.
    stable.pendingConstructionSimulationSeconds = 1;

    const summary = advancePureIdleMacroSession(stable, stable.settledWallSeconds);

    expect(summary.validationCount).toBe(1);
    expect(summary.validationFailures).toBe(0);
    expect(stable.rocketLedger).toBeUndefined();
    expect(stable.rocketLaunchRemaindersBySystem).toEqual({});
  });

  it("reports current terminal efficiency against the immutable calibration rate", () => {
    const session = createPureIdleMacroSession(structuredClone(pureIdleState()), "stable");
    session.calibrationRate.whiteMatrixProduced = 10;
    session.currentRate.whiteMatrixProduced = 5;
    const line = (advancePureIdleMacroSession(session, 0).terminalLines).find((entry) => entry.id === "white-matrix");
    expect(line).toMatchObject({ calibrationRatePerMinute: 600, sustainableRatePerMinute: 300, efficiency: 0.5 });
  });

  it("never extrapolates in-flight route cargo or route progress", () => {
    const source = pureIdleState();
    source.entities[0].stationRoutes = [{
      id: "pure-idle-route",
      slotIndex: 0,
      peerId: "remote-station",
      itemId: "iron_ore",
      scope: "remote",
      cargo: 240,
      vehicleCount: 2,
      progress: 0.25,
      duration: 10_000,
      requiresWarp: false,
    }];
    const session = createPureIdleMacroSession(structuredClone(source), "extreme");

    advancePureIdleMacroSession(session, 24 * 60 * 60);

    const route = session.candidate.entities[0].stationRoutes?.[0];
    expect(route?.cargo).toBe(240);
    expect(route?.progress).toBe(0.25);
  });

  it("rejects a forged contract that attempts to mutate transport progress", () => {
    const state = pureIdleState();
    state.entities[0].stationRoutes = [{
      id: "forged-route",
      slotIndex: 0,
      peerId: "remote-station",
      itemId: "iron_ore",
      scope: "remote",
      cargo: 24,
      vehicleCount: 1,
      progress: 0.5,
      duration: 60,
      requiresWarp: false,
    }];
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [{ path: ["entities", 0, "stationRoutes", 0, "cargo"], kind: "number", delta: -24, integer: true }],
    } as PureIdleAffineContract;

    const result = applyPureIdleAffineContract(state, contract, 1, 1);

    expect(result.ok).toBe(false);
    expect(result.failure).toContain("瞬时字段");
    expect(state.entities[0].stationRoutes?.[0]?.cargo).toBe(24);
  });

  it("round-trips the final candidate through the formal save migration gate", () => {
    const source = pureIdleState();
    const session = createPureIdleMacroSession(structuredClone(source), "extreme");

    const result = finalizePureIdleMacroSession(session, 7 * 24 * 60 * 60, createContentPackRegistry());

    expect(result.state.version).toBe(47);
    expect(result.state.timeWarp.enabled).toBe(false);
    expect(result.state.timeWarp.pendingSimulationSeconds).toBe(0);
    expect(result.state.timeWarp.pendingWallSeconds).toBe(0);
    expect(result.rawBytes).toBeGreaterThan(0);
    expect(result.summary.settledWallSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("rejects an already-negative in-flight route instead of clamping it", () => {
    const source = pureIdleState();
    source.entities[0].stationRoutes = [{
      id: "invalid-route",
      slotIndex: 0,
      peerId: "remote-station",
      itemId: "iron_ore",
      scope: "remote",
      cargo: -1,
      vehicleCount: 1,
      progress: 0.5,
      duration: 60,
      requiresWarp: false,
    }];

    expect(() => createPureIdleMacroSession(structuredClone(source), "stable")).toThrow(/校准|合同/);
    expect(source.entities[0].stationRoutes?.[0].cargo).toBe(-1);
  });

  it("starts macro sessions while finite or infinite research is active", () => {
    const finite = pureIdleState();
    finite.research.selectedTechId = "electromagnetic_matrix";
    const finiteSummary = advancePureIdleMacroSession(
      createPureIdleMacroSession(structuredClone(finite), "stable"),
      0,
    );
    expect(finiteSummary.research).toMatchObject({ kind: "finite", id: "electromagnetic_matrix" });

    const infinite = pureIdleState();
    infinite.research.completedTechIds.push("universe_matrix");
    infinite.endgame.activeInfiniteResearchId = "matrix_compression";
    const infiniteSummary = advancePureIdleMacroSession(
      createPureIdleMacroSession(structuredClone(infinite), "stable"),
      0,
    );
    expect(infiniteSummary.research).toMatchObject({ kind: "infinite", id: "matrix_compression", level: 0 });
  });

  it("rejects a macro bucket that creates inventory without matching production", () => {
    const state = pureIdleState();
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [{ path: ["tray", "iron_ore"], kind: "number", delta: 10, integer: true }],
    } as PureIdleAffineContract;

    const result = applyPureIdleAffineContract(state, contract, 1, 1);
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("物资守恒失败");
  });

  it("accepts a macro bucket whose aggregate stock increase matches production", () => {
    const state = pureIdleState();
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [
        { path: ["tray", "iron_ore"], kind: "number", delta: 10, integer: true },
        { path: ["totalProduced", "iron_ore"], kind: "number", delta: 10, integer: true },
      ],
    } as PureIdleAffineContract;

    const result = applyPureIdleAffineContract(state, contract, 1, 1);
    expect(result).toMatchObject({ ok: true });
    expect(state.tray.iron_ore).toBe(110);
    expect(state.totalProduced.iron_ore).toBe(10);
  });

  it("counts a Galactic activity delivery once and treats pending batches as an ACK outbox", () => {
    const source = pureIdleState();
    source.tray.universe_matrix = 10;
    const baseline = captureAggregateConservationBaseline(source);
    expect(baseline.totals.get("universe_matrix")).toBe(10n);

    const delivered = structuredClone(source);
    delivered.tray.universe_matrix = 0;
    delivered.endgame.exportProjects.universe_archive.totalDelivered = 10;
    delivered.endgame.totalExported = 10;
    delivered.endgame.constructionActivity.personalDelivered.universe_matrix = 10;
    delivered.endgame.constructionActivity.pendingBatches.universe_matrix = {
      id: "activity:participant:universe_matrix:0",
      itemId: "universe_matrix",
      amount: 10,
      sequence: 0,
      firstDeliveredAtMs: 1_000,
      lastDeliveredAtMs: 1_000,
    };

    expect(validateAggregateConservation(baseline, delivered)).toBeNull();
    const deliveredBaseline = captureAggregateConservationBaseline(delivered);
    expect(deliveredBaseline.totals.get("universe_matrix") ?? 0n).toBe(0n);

    const acknowledged = structuredClone(delivered);
    acknowledged.endgame.constructionActivity.pendingBatches = {};
    expect(validateAggregateConservation(deliveredBaseline, acknowledged)).toBeNull();
  });

  it("ignores activity-only personal and outbox mirrors in the combined terminal ledger", () => {
    const source = pureIdleState();
    const checkpoint = capturePureIdleCombinedConservationCheckpoint(source);
    const synchronized = structuredClone(source);
    synchronized.endgame.constructionActivity.personalDelivered.small_carrier_rocket = 50;
    synchronized.endgame.constructionActivity.pendingBatches.small_carrier_rocket = {
      id: "activity:participant:small_carrier_rocket:0",
      itemId: "small_carrier_rocket",
      amount: 50,
      sequence: 0,
      firstDeliveredAtMs: 2_000,
      lastDeliveredAtMs: 2_000,
    };

    expect(validatePureIdleCombinedSettlementConservation(checkpoint, synchronized)).toBeNull();
  });

  it("accepts rocket and sail launch sinks funded by interval-start inventory", () => {
    const source = pureIdleState();
    source.tray.small_carrier_rocket = 3;
    source.tray.solar_sail = 4;
    const baseline = captureAggregateConservationBaseline(source);
    const launched = structuredClone(source);
    launched.tray.small_carrier_rocket = 0;
    launched.tray.solar_sail = 0;
    launched.dysonSphere.totalRocketsLaunched += 3;
    launched.dysonSwarm.totalLaunched += 4;

    expect(validateAggregateConservation(baseline, launched)).toBeNull();
  });

  it.each([
    ["rocket launch", (state: GameState) => { state.dysonSphere.totalRocketsLaunched += 1; }],
    ["solar-sail launch", (state: GameState) => { state.dysonSwarm.totalLaunched += 1; }],
    ["Galactic export", (state: GameState) => { state.endgame.exportProjects.universe_archive.totalDelivered += 1; }],
  ] as const)("rejects an unfunded physical %s sink in the aggregate ledger", (_label, mutate) => {
    const source = pureIdleState();
    source.tray.small_carrier_rocket = 0;
    source.tray.solar_sail = 0;
    source.tray.universe_matrix = 0;
    const candidate = structuredClone(source);
    mutate(candidate);

    expect(validateAggregateConservation(captureAggregateConservationBaseline(source), candidate))
      .toContain("超过生产、奖励与库存来源");
  });

  it("applies the closed lightweight contract without cloning the full state", () => {
    const source = pureIdleState();
    source.entities[0].inputs.iron_ore = 100;
    const contract = {
      calibrationSeconds: 10,
      calibrationWallSeconds: 10,
      deltas: [
        { path: ["entities", 0, "inputs", "iron_ore"], kind: "number", delta: -10, integer: true },
        { path: ["totalProduced", "iron_ingot"], kind: "number", delta: 10, integer: true },
      ],
    } as PureIdleAffineContract;
    const expected = structuredClone(source);
    const actual = structuredClone(source);

    expect(applyPureIdleAffineContract(expected, contract, 10, 10)).toMatchObject({ ok: true });
    expect(applyPureIdleLightweightContractInPlace(actual, contract, 10, 10)).toMatchObject({ ok: true });
    expect(hashGameState(actual)).toBe(hashGameState(expected));
  });

  it("rolls back every primitive and remainder when an in-place bucket overflows", () => {
    const state = pureIdleState();
    state.entities[0].inputs.iron_ore = 100;
    state.totalProduced.iron_ingot = Number.MAX_SAFE_INTEGER - 5;
    const before = hashGameState(state);
    const integerRemainders = { retained: 0.25 };
    const contract = {
      calibrationSeconds: 10,
      calibrationWallSeconds: 10,
      deltas: [
        { path: ["entities", 0, "inputs", "iron_ore"], kind: "number", delta: -10, integer: true },
        { path: ["totalProduced", "iron_ingot"], kind: "number", delta: 10, integer: true },
      ],
    } as PureIdleAffineContract;

    const result = applyPureIdleLightweightContractInPlace(state, contract, 10, 10, { integerRemainders });

    expect(result).toMatchObject({ ok: false });
    expect(result.failure).toContain("超过安全整数");
    expect(hashGameState(state)).toBe(before);
    expect(integerRemainders).toEqual({ retained: 0.25 });
  });

  it("turns an unmatched sampled replenishment into balanced transfer and finite consumption", () => {
    const state = pureIdleState();
    state.tray.coal = 100;
    state.entities[0].inputs.coal = 100;
    const contract = reconcilePureIdleLightweightMaterialDeltas({
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [
        { path: ["tray", "coal"], kind: "number", delta: 100, integer: true },
        { path: ["entities", 0, "inputs", "coal"], kind: "number", delta: -40, integer: true },
      ],
    });

    const result = applyPureIdleAffineContract(state, contract, 1, 1, { allowExactFallback: false });

    expect(result).toMatchObject({ ok: true });
    expect(state.tray.coal).toBe(140);
    expect(state.entities[0].inputs.coal).toBe(60);
    expect((state.tray.coal ?? 0) + (state.entities[0].inputs.coal ?? 0)).toBe(200);
  });

  it("keeps the 30-second lightweight calibration isolated until wall time reaches its checkpoint", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    addWindGeneration(source, 50_000_000);
    const sourceHash = hashGameState(source);
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "injected repeated Worker crash",
    );

    expect(session.calibrationCheckpoint).toBeDefined();
    expect(session.candidate.elapsedSeconds).toBe(source.elapsedSeconds);
    expect(session.calibrationCheckpoint!.candidate.elapsedSeconds - source.elapsedSeconds).toBeCloseTo(
      PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS,
      6,
    );
    expect(session.lastValidationReason).toContain("已精确结算 30 秒");

    const summary = advancePureIdleMacroSession(session, 30 * 24 * 60 * 60);
    const finalized = finalizePureIdleMacroSession(session, 30 * 24 * 60 * 60, createContentPackRegistry());

    expect(summary).toMatchObject({
      phase: "conservative",
      conservativeOnly: true,
      calibrationWindowsCompleted: 3,
      settledWallSeconds: 30 * 24 * 60 * 60,
      settledSimulationSeconds: 9 * 30 * 24 * 60 * 60,
    });
    expect(summary.degradedReason).toContain("injected repeated Worker crash");
    expect(finalized.state.elapsedSeconds - source.elapsedSeconds).toBe(9 * 30 * 24 * 60 * 60);
    expect(finalized.state.tray).toEqual(source.tray);
    expect(finalized.state.entities.find((entity) => entity.id === "pure-idle-controller")).toMatchObject({
      buildingId: "time_warp_device",
      machineCount: 1,
    });
    expect(finalized.state.entities.find((entity) => entity.id === "pure-idle-wind-50000000")).toMatchObject({
      buildingId: "wind_turbine",
      machineCount: 50_000_000,
    });
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("uses the 30-second lightweight sample to extrapolate ordinary production", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    addProductiveSmelter(source);
    const sourceHash = hashGameState(source);
    const baselineProduced = source.totalProduced.iron_ingot ?? 0;
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "large-save memory guard",
    );

    const prefixProduced = session.calibrationCheckpoint!.candidate.totalProduced.iron_ingot ?? 0;
    expect(session.contractVersion).toBe(1);
    expect(session.calibrationWindowsCompleted).toBe(3);
    expect(session.contract.deltas.length).toBeGreaterThan(0);
    expect(prefixProduced).toBeGreaterThan(baselineProduced);

    const summary = advancePureIdleMacroSession(session, 60);
    const finalized = finalizePureIdleMacroSession(session, 60, createContentPackRegistry());
    expect(summary.phase).toBe("conservative");
    expect(summary.actualMultiplier).toBe(9);
    expect(finalized.state.elapsedSeconds - source.elapsedSeconds).toBe(9 * 60);
    expect(finalized.state.totalProduced.iron_ingot ?? 0).toBeGreaterThan(prefixProduced);
    expect(finalized.state.entities.find((entity) => entity.id === "pure-idle-smelter")!.inputs.iron_ore).toBeGreaterThanOrEqual(0);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("detects a slow production cycle that a one-second probe reports as zero", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addSlowProductiveAssembler(source);
    const oneSecond = advanceExactSimulationWindow(structuredClone(source), 1, 1 / 8);
    expect(oneSecond.totalProduced.annihilation_constraint_sphere ?? 0).toBe(0);

    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "large-save memory guard",
    );
    const calibrated = session.calibrationCheckpoint!.candidate.totalProduced.annihilation_constraint_sphere ?? 0;
    expect(calibrated).toBeGreaterThan(0);

    advancePureIdleMacroSession(session, 60);

    expect(session.candidate.totalProduced.annihilation_constraint_sphere ?? 0).toBeGreaterThan(calibrated);
  });

  it("does not reuse a finite cached ingredient after the 30-second sample", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addSlowProductiveAssembler(source);
    const assembler = source.entities.find((entity) => entity.id === "pure-idle-slow-assembler")!;
    assembler.inputs.particle_container = 2;
    assembler.inputs.processor = 2;

    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "large-save memory guard",
    );
    advancePureIdleMacroSession(session, 60);

    expect(session.candidate.totalProduced.annihilation_constraint_sphere ?? 0).toBe(2);
    expect(session.candidate.entities.find((entity) => entity.id === assembler.id)!.inputs)
      .toMatchObject({ particle_container: 0, processor: 0 });
  });

  it("freezes prefilled research after the exact prefix when no matrix input has a steady certificate", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addPrefilledResearchLabWithoutUpstream(source);
    const sourceHash = hashGameState(source);
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "prefilled research without sustainable upstream",
    );
    const prefix = session.calibrationCheckpoint!.candidate;
    const prefixProgress = prefix.research.progressByTech.time_warp_engineering?.electromagnetic_matrix ?? 0;
    const prefixInput = prefix.entities.find((entity) => entity.id === "prefilled-research-lab")!
      .inputs.electromagnetic_matrix ?? 0;

    expect(prefixProgress).toBeGreaterThan(0);
    expect(prefixInput).toBeLessThan(500);
    expect(session.researchLedger.unitsPerWindow).toBe(0n);

    advancePureIdleMacroSession(session, 60 * 60);

    expect(session.candidate.research.progressByTech.time_warp_engineering?.electromagnetic_matrix ?? 0)
      .toBe(prefixProgress);
    expect(session.candidate.entities.find((entity) => entity.id === "prefilled-research-lab")!
      .inputs.electromagnetic_matrix ?? 0).toBe(prefixInput);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("applies a fractional steady research factor exactly once", () => {
    const source = pureIdleState();
    addPartiallySuppliedResearchChain(source);
    const sourceProgress = source.research.progressByTech.high_efficiency_plasma_control
      ?.electromagnetic_matrix ?? 0;

    const calibration = createPureIdleLightweightCalibration(source, 30, {
      isolateConstructionAutomation: true,
    });

    expect(calibration).not.toBeNull();
    if (!calibration) return;
    const factor = calibration.contract.steadyStateFactorsByItem?.electromagnetic_matrix ?? 0;
    const calibratedProgress = calibration.calibratedState.research.progressByTech.high_efficiency_plasma_control
      ?.electromagnetic_matrix ?? 0;
    const observedInvestment = BigInt(calibratedProgress - sourceProgress);
    const scaledFactor = BigInt(Math.floor(factor * 1_000_000));
    const onceScaled = observedInvestment * scaledFactor / 1_000_000n;
    const twiceScaled = onceScaled * scaledFactor / 1_000_000n;

    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeLessThan(1);
    expect(observedInvestment).toBeGreaterThan(0n);
    expect(onceScaled).toBeGreaterThan(twiceScaled);
    expect(calibration.researchLedger.unitsPerWindow).toBe(onceScaled);
    expect(calibration.researchLedger.observedUnits).toBe(onceScaled);
  });

  it("rejects a combined pure-idle candidate that gains unsupported inventory after its checkpoint", () => {
    const source = pureIdleState();
    const sourceHash = hashGameState(source);
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "combined conservation rejection regression",
    );
    advancePureIdleMacroSession(session, 30);
    session.candidate.tray.iron_ore = (session.candidate.tray.iron_ore ?? 0) + 1;

    expect(() => advancePureIdleMacroSession(session, 31)).toThrow(/最终物资守恒门禁拒绝候选/);
    expect(session.phase).toBe("failed");
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps an infinite closed supply chain productive after its transient caches would have expired", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addProductiveSmelter(source, 100);
    addInfiniteIronSupply(source);
    advanceExactSimulationWindow(source, 60, 4);
    const sourceHash = hashGameState(source);
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "steady-flow certificate regression",
    );
    const segmented = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "steady-flow certificate segmented regression",
    );
    const prefixProduced = session.calibrationCheckpoint!.candidate.totalProduced.iron_ingot ?? 0;

    const summary = advancePureIdleMacroSession(session, 24 * 60 * 60);
    advancePureIdleMacroSession(segmented, 102);
    advancePureIdleMacroSession(segmented, 10 * 60);
    advancePureIdleMacroSession(segmented, 24 * 60 * 60);

    expect(session.contract.steadyStateFactorsByItem?.iron_ingot).toBeGreaterThan(0);
    expect(session.contract.maximumSimulationSecondsByItem?.iron_ingot).toBeUndefined();
    expect(session.candidate.totalProduced.iron_ingot ?? 0).toBeGreaterThan(prefixProduced);
    expect(summary.minimumEfficiency === null || summary.minimumEfficiency > 0).toBe(true);
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(session.candidate));
    expect(validatePureIdleTerminalMaterialConservation(source, session.candidate)).toBeNull();
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps compact conservative counters deterministic across idle boundaries", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 9;
    addProductiveSmelter(source, 1_000);
    const incremental = createConservativePureIdleMacroSession(structuredClone(source), "stable", "memory guard");
    advancePureIdleMacroSession(incremental, 60 * 60);
    advancePureIdleMacroSession(incremental, 2 * 60 * 60);

    const single = createConservativePureIdleMacroSession(structuredClone(source), "stable", "memory guard");
    advancePureIdleMacroSession(single, 2 * 60 * 60);

    expect(hashGameState(incremental.candidate)).toBe(hashGameState(single.candidate));
    expect(incremental.conservativeIntegerRemainders).toEqual(single.conservativeIntegerRemainders);
    expect(incremental.conservativeDecimalRemainders).toEqual(single.conservativeDecimalRemainders);
    expect(incremental.conservativeRemainingSimulationSecondsByItem)
      .toEqual(single.conservativeRemainingSimulationSecondsByItem);
    expect(incremental.researchRemainder).toBe(single.researchRemainder);
  });

  it("uses and debits a finite artificial-star reserve beyond the 30-second prefix without replaying it", () => {
    const source = pureIdleState();
    addFiniteArtificialStarSmelter(source, 100);
    const sourceHash = hashGameState(source);
    const single = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "finite fuel power horizon",
    );
    const segmented = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "finite fuel power horizon",
    );

    advancePureIdleMacroSession(single, 10);
    advancePureIdleMacroSession(segmented, 5);
    advancePureIdleMacroSession(segmented, 10);
    const producedAtExhaustion = single.candidate.totalProduced.iron_ingot ?? 0;
    const singleAtTenHash = hashGameState(single.candidate);
    advancePureIdleMacroSession(single, 11);

    expect(single.powerTail.fuelDebits).toMatchObject([{
      entityId: "pure-idle-finite-star",
      fuelItemId: "antimatter_fuel_rod",
      sustainable: false,
    }]);
    expect(producedAtExhaustion).toBe(10_000);
    expect(single.candidate.totalProduced.iron_ingot ?? 0).toBe(producedAtExhaustion);
    expect(single.candidate.entities.find((entity) => entity.id === "pure-idle-finite-star")?.fuelRemainingMj)
      .toBe(0);
    expect(single.powerBoundaryRecalibrations).toBe(0);
    expect(single.calibrationWindowsCompleted).toBe(3);
    expect(hashGameState(segmented.candidate)).toBe(singleAtTenHash);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("freezes quantum construction when finite generation cannot issue a renewable headroom certificate", () => {
    const source = pureIdleState();
    addFiniteArtificialStarSmelter(source, 40);
    source.research.completedTechIds.push("construction_automation");
    source.construction.arc_smelter = 0;
    source.constructionAutomation.enabled = true;
    source.constructionAutomation.quantumSourceEnabled = true;
    source.constructionAutomation.targetStock.arc_smelter = 1_000_000;
    source.constructionAutomation.quantumMaterialBuffer = {
      "pure-idle-quantum-center": {
        iron_ore: 1_000_000_000,
        copper_ore: 1_000_000_000,
        stone: 1_000_000_000,
      },
    };
    source.entities.push({
      id: "pure-idle-quantum-center",
      kind: "machine",
      planetId: "home",
      position: { x: 160, y: 0 },
      interactionLocked: false,
      buildingId: "construction_center",
      machineCount: 1_000,
      minerCount: 0,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    });
    const sourceHash = hashGameState(source);
    const session = createPureIdleMacroSession(structuredClone(source), "extreme");
    const calibratedCrafted = session.calibrationCheckpoint!.candidate.constructionAutomation.totalCrafted;

    // The ordinary factory may consume its finite 40-second power horizon,
    // but isolated construction receives no renewable-headroom certificate
    // and therefore cannot borrow that same finite fuel a second time.
    advancePureIdleMacroSession(session, 4);
    const craftedAtFuelExhaustion = session.candidate.constructionAutomation.totalCrafted;
    advancePureIdleMacroSession(session, 5);

    expect(session.conservativeOnly).toBe(false);
    expect(craftedAtFuelExhaustion).toBe(calibratedCrafted);
    expect(session.candidate.constructionAutomation.totalCrafted)
      .toBe(calibratedCrafted);
    expect(session.actualMultiplier).toBeLessThan(16);
    expect(session.powerRemainingSimulationSeconds).toBe(0);
    expect(session.candidate.entities.find((entity) => entity.id === "pure-idle-finite-star")?.fuelRemainingMj)
      .toBeLessThan(7_200);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps the normal affine session productive for a proven continuous fuel flow", () => {
    const source = pureIdleState();
    addSustainableArtificialStarSmelter(source);
    advanceExactSimulationWindow(source, 60, 60 / 16);
    const sourceHash = hashGameState(source);
    const single = createPureIdleMacroSession(structuredClone(source), "extreme");
    const segmented = createPureIdleMacroSession(structuredClone(source), "extreme");
    const calibrated = single.calibrationCheckpoint!.candidate;
    const calibratedStar = calibrated.entities.find((entity) => entity.id === "pure-idle-sustainable-star")!;
    const calibratedFuelBank = (calibratedStar.fuelRemainingMj ?? 0) +
      (calibratedStar.inputs.antimatter_fuel_rod ?? 0) * 7_200;
    const calibratedFuelProduced = calibrated.totalProduced.antimatter_fuel_rod ?? 0;

    advancePureIdleMacroSession(single, 60);
    advancePureIdleMacroSession(segmented, 20);
    advancePureIdleMacroSession(segmented, 40);
    advancePureIdleMacroSession(segmented, 60);

    const finalStar = single.candidate.entities.find((entity) => entity.id === "pure-idle-sustainable-star")!;
    const finalFuelBank = (finalStar.fuelRemainingMj ?? 0) +
      (finalStar.inputs.antimatter_fuel_rod ?? 0) * 7_200;
    expect(single.powerTail.fuelDebits).toMatchObject([{
      entityId: "pure-idle-sustainable-star",
      fuelItemId: "antimatter_fuel_rod",
      sustainable: true,
    }]);
    expect(single.powerTail.maximumSimulationSeconds).toBeNull();
    expect(single.contract.steadyStateFactorsByItem?.antimatter_fuel_rod).toBe(1);
    expect(single.candidate.totalProduced.antimatter_fuel_rod ?? 0).toBeGreaterThan(calibratedFuelProduced);
    // The generic affine normalizer stores sub-MJ fuel heat as a safe integer;
    // one normalization may conservatively discard less than 1 MJ.
    expect(Math.abs(finalFuelBank - calibratedFuelBank)).toBeLessThan(1);
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps a continuously produced fuel flow closed, bank-steady, and segment deterministic", () => {
    const source = pureIdleState();
    addSustainableArtificialStarSmelter(source);
    // Enter a stable fuel-routing phase before taking the immutable source
    // checkpoint used by both settlement shapes.
    advanceExactSimulationWindow(source, 60, 60 / 16);
    const sourceHash = hashGameState(source);
    const single = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "sustainable fuel-flow power certificate",
    );
    const segmented = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "sustainable fuel-flow power certificate",
    );
    const calibrated = single.calibrationCheckpoint!.candidate;
    const calibratedStar = calibrated.entities.find((entity) => entity.id === "pure-idle-sustainable-star")!;
    const calibratedFuelProduced = calibrated.totalProduced.antimatter_fuel_rod ?? 0;
    const calibratedFuelBank = (calibratedStar.fuelRemainingMj ?? 0) +
      (calibratedStar.inputs.antimatter_fuel_rod ?? 0) * 7_200;

    advancePureIdleMacroSession(single, 60);
    advancePureIdleMacroSession(segmented, 20);
    advancePureIdleMacroSession(segmented, 40);
    advancePureIdleMacroSession(segmented, 60);

    const finalStar = single.candidate.entities.find((entity) => entity.id === "pure-idle-sustainable-star")!;
    const finalFuelBank = (finalStar.fuelRemainingMj ?? 0) +
      (finalStar.inputs.antimatter_fuel_rod ?? 0) * 7_200;
    expect(single.powerTail.fuelDebits).toMatchObject([{
      entityId: "pure-idle-sustainable-star",
      fuelItemId: "antimatter_fuel_rod",
      sustainable: true,
    }]);
    expect(single.powerTail.maximumSimulationSeconds).toBeNull();
    expect(single.contract.steadyStateFactorsByItem?.antimatter_fuel_rod).toBeGreaterThan(0);
    // The credited cumulative fuel production is paired with generator
    // consumption inside the closed flow; it must not accumulate as free
    // generator inventory when the specialized input delta is stripped.
    expect(single.candidate.totalProduced.antimatter_fuel_rod ?? 0).toBeGreaterThan(calibratedFuelProduced);
    expect(finalFuelBank).toBeCloseTo(calibratedFuelBank, 6);
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("certifies a fractional recipe-fuel flow through a relay when its credited rate covers total burn", () => {
    const source = pureIdleState();
    addRecipeArtificialStarFuelChain(source);
    // Settle the belt/relay phase before both sessions take their immutable
    // source checkpoint. The following contract still comes only from 3x10s.
    advanceExactSimulationWindow(source, 60, 12);
    const sourceHash = hashGameState(source);
    const single = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "connected recipe fuel ledger",
    );
    const segmented = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "connected recipe fuel ledger",
    );
    const factor = single.contract.steadyStateFactorsByItem?.antimatter_fuel_rod ?? 0;
    const fuelProduction = single.contract.deltas.find((delta) =>
      delta.path[0] === "totalProduced" && delta.path[1] === "antimatter_fuel_rod");
    const creditedFuelPerSimulationSecond = fuelProduction?.kind === "number"
      ? Number(fuelProduction.delta) / single.contract.calibrationSeconds
      : 0;
    const requiredFuelPerSimulationSecond = single.powerTail.fuelDebits.reduce((sum, debit) =>
      sum + debit.thermalMjPerSimulationSecond / 7_200, 0);
    const calibratedStar = single.calibrationCheckpoint!.candidate.entities.find((entity) =>
      entity.id === "pure-idle-recipe-fuel-star")!;
    const calibratedStarBank = (calibratedStar.fuelRemainingMj ?? 0) +
      (calibratedStar.inputs.antimatter_fuel_rod ?? 0) * 7_200;

    expect(single.actualMultiplier).toBe(5);
    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeLessThan(1);
    expect(creditedFuelPerSimulationSecond).toBeGreaterThanOrEqual(requiredFuelPerSimulationSecond);
    expect(single.powerTail.fuelDebits).toMatchObject([{
      entityId: "pure-idle-recipe-fuel-star",
      fuelItemId: "antimatter_fuel_rod",
      sustainable: true,
    }]);
    expect(single.powerTail.maximumSimulationSeconds).toBeNull();

    advancePureIdleMacroSession(single, 2 * 60 * 60);
    advancePureIdleMacroSession(segmented, 60);
    advancePureIdleMacroSession(segmented, 60 * 60);
    advancePureIdleMacroSession(segmented, 2 * 60 * 60);

    const finalStar = single.candidate.entities.find((entity) => entity.id === "pure-idle-recipe-fuel-star")!;
    const finalStarBank = (finalStar.fuelRemainingMj ?? 0) +
      (finalStar.inputs.antimatter_fuel_rod ?? 0) * 7_200;
    expect(finalStarBank).toBeCloseTo(calibratedStarBank, 6);
    expect(single.powerBoundaryRecalibrations).toBe(0);
    expect(single.calibrationWindowsCompleted).toBe(3);
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it.each([
    ["disconnected global recipe output", { connectStar: false, sustainableInputs: true }],
    ["finite prefilled recipe inputs", { connectStar: true, sustainableInputs: false }],
  ] as const)("keeps %s on a finite power bank and never recalibrates it", (_label, options) => {
    const source = pureIdleState();
    addRecipeArtificialStarFuelChain(source, options);
    advanceExactSimulationWindow(source, 60, 12);
    const sourceHash = hashGameState(source);
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "unproven recipe fuel ledger",
    );
    const prefixFuelProduced = (session.calibrationCheckpoint!.candidate.totalProduced.antimatter_fuel_rod ?? 0) -
      (source.totalProduced.antimatter_fuel_rod ?? 0);

    expect(prefixFuelProduced).toBeGreaterThan(0);
    expect(session.powerTail.fuelDebits).toMatchObject([{
      entityId: "pure-idle-recipe-fuel-star",
      fuelItemId: "antimatter_fuel_rod",
      sustainable: false,
    }]);
    expect(session.powerTail.maximumSimulationSeconds).not.toBeNull();

    advancePureIdleMacroSession(session, 1_000);
    const producedAtBoundary = session.candidate.totalProduced.antimatter_fuel_rod ?? 0;
    advancePureIdleMacroSession(session, 1_100);

    const star = session.candidate.entities.find((entity) => entity.id === "pure-idle-recipe-fuel-star")!;
    expect((star.fuelRemainingMj ?? 0) + (star.inputs.antimatter_fuel_rod ?? 0) * 7_200).toBe(0);
    expect(session.candidate.totalProduced.antimatter_fuel_rod ?? 0).toBe(producedAtBoundary);
    expect(session.powerRemainingSimulationSeconds).toBe(0);
    expect(session.powerBoundaryRecalibrations).toBe(0);
    expect(session.calibrationWindowsCompleted).toBe(3);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("does not certify a finite upstream fuel cache as an endless local generator supply", () => {
    const source = pureIdleState();
    addSustainableArtificialStarSmelter(source);
    source.settings.resourceMode = "finite";
    const fuelSource = source.entities.find((entity) => entity.id === "pure-idle-sustainable-fuel")!;
    fuelSource.resourceRemaining = 1_000_000_000;
    advanceExactSimulationWindow(source, 60, 60 / 16);

    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "extreme",
      "finite upstream fuel must retain a physical horizon",
    );

    expect(session.powerTail.fuelDebits).toMatchObject([{
      entityId: "pure-idle-sustainable-star",
      fuelItemId: "antimatter_fuel_rod",
      sustainable: false,
    }]);
    expect(session.powerTail.maximumSimulationSeconds).not.toBeNull();
  });

  it("does not treat a fully charged but idle accumulator as active exhaustible dispatch", () => {
    const source = pureIdleState();
    source.timeWarp.requestedMultiplier = 8;
    addProductiveSmelter(source, 100);
    source.entities.push({
      id: "pure-idle-idle-accumulator",
      kind: "power",
      planetId: "home",
      position: { x: -160, y: 0 },
      interactionLocked: false,
      buildingId: "accumulator",
      machineCount: 1_000,
      minerCount: 0,
      storedEnergyMj: 90_000,
      inputs: {},
      outputs: {},
      progress: 0,
      routingCursor: 0,
      utilization: 0,
      productionRate: 0,
    });
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "idle storage must not block renewable proof",
    );
    const prefixProduced = session.calibrationCheckpoint!.candidate.totalProduced.iron_ingot ?? 0;

    advancePureIdleMacroSession(session, 60);

    expect(session.powerTail.storageDispatchDetected).toBe(false);
    expect(session.powerTail.rejectionReason).toBeUndefined();
    expect(session.powerTail.maximumSimulationSeconds).toBeNull();
    expect(session.candidate.totalProduced.iron_ingot ?? 0).toBeGreaterThan(prefixProduced);
  });

  it("advances recursive construction only after the isolated calibration issues a joint power grant", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addRecursiveConstructionCenter(source, 100);
    const sourceHash = hashGameState(source);

    const single = createConservativePureIdleMacroSession(structuredClone(source), "stable", "large-save memory guard");
    expect(single.calibrationCheckpoint!.candidate.construction.arc_smelter).toBe(0);
    advancePureIdleMacroSession(single, 60);

    const segmented = createConservativePureIdleMacroSession(structuredClone(source), "stable", "large-save memory guard");
    advancePureIdleMacroSession(segmented, 15);
    advancePureIdleMacroSession(segmented, 30);
    advancePureIdleMacroSession(segmented, 60);

    expect(single.candidate.construction.arc_smelter).toBe(100);
    expect(single.candidate.constructionAutomation.jobs).toEqual({});
    expect(single.candidate.constructionAutomation.totalCrafted).toBeGreaterThanOrEqual(100);
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(Object.values(single.candidate.tray).every((amount) => (amount ?? 0) >= 0)).toBe(true);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("uses only same-grid renewable headroom and stays deterministic across partial calibration boundaries", () => {
    const source = pureIdleState();
    addJointConstructionPowerFixture(source, { target: 12, wind: 80, smelters: 20, otherGridWind: 1 });
    const sourceHash = hashGameState(source);

    const single = createConservativePureIdleMacroSession(structuredClone(source), "stable", "joint grid proof");
    advancePureIdleMacroSession(single, 60);
    const segmented = createConservativePureIdleMacroSession(structuredClone(source), "stable", "joint grid proof");
    advancePureIdleMacroSession(segmented, 17);
    advancePureIdleMacroSession(segmented, 43);
    advancePureIdleMacroSession(segmented, 60);

    expect(single.candidate.construction.arc_smelter).toBe(12);
    expect(single.candidate.constructionAutomation.totalCrafted).toBe(12);
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("does not borrow renewable construction power across grids", () => {
    const source = pureIdleState();
    addJointConstructionPowerFixture(source, {
      target: 12,
      wind: 0,
      smelters: 0,
      otherGridWind: 1_000,
    });
    const beforeTray = structuredClone(source.tray);
    const session = createConservativePureIdleMacroSession(structuredClone(source), "stable", "no cross-grid power");

    advancePureIdleMacroSession(session, 60);

    expect(session.candidate.construction.arc_smelter).toBe(0);
    expect(session.candidate.constructionAutomation.totalCrafted).toBe(0);
    expect(session.candidate.tray).toEqual(beforeTray);
  });

  it("freezes a grid whose ordinary demand consumes its complete renewable floor", () => {
    const source = pureIdleState();
    addJointConstructionPowerFixture(source, {
      target: 12,
      wind: 60,
      smelters: 50,
      idleExhaustibles: true,
    });
    const starBefore = structuredClone(source.entities.find((entity) => entity.id === "joint-idle-star"));
    const accumulatorBefore = structuredClone(source.entities.find((entity) => entity.id === "joint-full-acc"));
    const session = createConservativePureIdleMacroSession(structuredClone(source), "stable", "ordinary load floor");

    advancePureIdleMacroSession(session, 60);

    const star = session.candidate.entities.find((entity) => entity.id === "joint-idle-star")!;
    const accumulator = session.candidate.entities.find((entity) => entity.id === "joint-full-acc")!;
    expect(session.candidate.construction.arc_smelter).toBe(0);
    expect(star.fuelRemainingMj).toBe(starBefore?.fuelRemainingMj);
    expect(star.inputs.antimatter_fuel_rod).toBe(starBefore?.inputs.antimatter_fuel_rod);
    expect(accumulator.storedEnergyMj).toBe(accumulatorBefore?.storedEnergyMj);
  });

  it("allows renewable headroom beside idle exhaustibles without dispatching or draining them", () => {
    const source = pureIdleState();
    addJointConstructionPowerFixture(source, {
      target: 12,
      wind: 80,
      smelters: 20,
      idleExhaustibles: true,
    });
    const session = createConservativePureIdleMacroSession(structuredClone(source), "stable", "idle exhaustibles");

    advancePureIdleMacroSession(session, 60);

    const star = session.candidate.entities.find((entity) => entity.id === "joint-idle-star")!;
    const accumulator = session.candidate.entities.find((entity) => entity.id === "joint-full-acc")!;
    expect(session.candidate.construction.arc_smelter).toBe(12);
    expect(star.fuelRemainingMj).toBe(3_600);
    expect(star.inputs.antimatter_fuel_rod).toBe(1);
    expect(star.powerOutputKw ?? 0).toBe(0);
    expect(accumulator.storedEnergyMj).toBe(90);
    expect(accumulator.powerOutputKw ?? 0).toBe(0);
    expect(accumulator.powerInputKw ?? 0).toBe(0);
  });

  it("caps two construction centers to one grid's certified energy and keeps bucket segmentation deterministic", () => {
    const source = pureIdleState();
    addJointConstructionPowerFixture(source, {
      target: 100,
      centerCount: 2,
      wind: 40,
      smelters: 0,
    });
    const settle = (segments: number[]) => {
      const calibration = createPureIdleLightweightCalibration(
        structuredClone(source),
        30 / 4,
        { isolateConstructionAutomation: true },
      )!;
      const checkpoint = capturePureIdleCombinedConservationCheckpoint(calibration.calibratedState);
      for (const seconds of segments) {
        advanceConstructionAutomationMacroWithReceiptInPlace(
          calibration.calibratedState,
          seconds,
          checkpoint,
          {
            powerCertificate: calibration.constructionPowerCertificate,
            contract: calibration.contract,
          },
        );
      }
      expect(validatePureIdleCombinedSettlementConservation(
        checkpoint,
        calibration.calibratedState,
      )).toBeNull();
      return calibration.calibratedState;
    };

    const single = settle([10]);
    const segmented = settle([5, 5]);
    expect(single.construction.arc_smelter).toBe(2);
    expect(single.constructionAutomation.totalCrafted).toBe(2);
    expect(hashGameState(segmented)).toBe(hashGameState(single));
  });

  it("fails closed when a certificate is paired with a different contract or center grid", () => {
    const source = pureIdleState();
    addJointConstructionPowerFixture(source, { target: 12, wind: 80, smelters: 20 });
    const contractCalibration = createPureIdleLightweightCalibration(
      structuredClone(source),
      30 / 4,
      { isolateConstructionAutomation: true },
    )!;
    // Keep the certificate-authorized state graph so this branch isolates the
    // contract identity check instead of failing earlier on array identity.
    const contractMismatch = contractCalibration.calibratedState;
    const contractCheckpoint = capturePureIdleCombinedConservationCheckpoint(contractMismatch);
    advanceConstructionAutomationMacroWithReceiptInPlace(
      contractMismatch,
      60,
      contractCheckpoint,
      {
        powerCertificate: contractCalibration.constructionPowerCertificate,
        contract: { ...contractCalibration.contract },
      },
    );
    expect(contractMismatch.construction.arc_smelter).toBe(0);
    expect(validatePureIdleCombinedSettlementConservation(contractCheckpoint, contractMismatch)).toBeNull();

    // Use an independent accepted calibration graph so this branch reaches
    // the center/grid topology check without polluting another certificate.
    const gridCalibration = createPureIdleLightweightCalibration(
      structuredClone(source),
      30 / 4,
      { isolateConstructionAutomation: true },
    )!;
    const gridMismatch = gridCalibration.calibratedState;
    gridMismatch.entities.find((entity) => entity.id === "joint-center-0")!.powerGridId = "grid-a";
    const gridCheckpoint = capturePureIdleCombinedConservationCheckpoint(gridMismatch);
    advanceConstructionAutomationMacroWithReceiptInPlace(
      gridMismatch,
      60,
      gridCheckpoint,
      {
        powerCertificate: gridCalibration.constructionPowerCertificate,
        contract: gridCalibration.contract,
      },
    );
    expect(gridMismatch.construction.arc_smelter).toBe(0);
    expect(validatePureIdleCombinedSettlementConservation(gridCheckpoint, gridMismatch)).toBeNull();
  });

  it("never lets a zero-stack construction center work in exact or certified macro simulation", () => {
    const source = pureIdleState();
    addJointConstructionPowerFixture(source, { target: 12, wind: 80, smelters: 0 });
    source.entities.find((entity) => entity.id === "joint-center-0")!.machineCount = 0;

    const exact = advanceExactSimulationWindow(structuredClone(source), 60, 60);
    const exactCenter = exact.entities.find((entity) => entity.id === "joint-center-0")!;
    expect(exact.construction.arc_smelter).toBe(0);
    expect(exact.constructionAutomation.totalCrafted).toBe(0);
    expect(exactCenter.powerFactor).toBe(0);

    const macro = createConservativePureIdleMacroSession(structuredClone(source), "stable", "zero stack");
    advancePureIdleMacroSession(macro, 60);
    const macroCenter = macro.candidate.entities.find((entity) => entity.id === "joint-center-0")!;
    expect(macro.candidate.construction.arc_smelter).toBe(0);
    expect(macro.candidate.constructionAutomation.totalCrafted).toBe(0);
    expect(macroCenter.powerFactor).toBe(0);
  });

  it("freezes construction for the bucket when macro research completes after power certification", () => {
    const source = pureIdleState();
    addJointConstructionPowerFixture(source, { target: 12, wind: 80, smelters: 0 });
    source.research.completedTechIds.push("gravity_matrix");
    source.research.selectedTechId = "construction_capacity_1";
    source.entities.push({
      id: "joint-research-boundary", kind: "machine", planetId: "home", position: { x: 160, y: 80 },
      interactionLocked: false, buildingId: "matrix_lab", recipeId: "matrix_research",
      powerGridId: "grid-b", machineCount: 1, minerCount: 0,
      inputs: {
        electromagnetic_matrix: 150,
        energy_matrix: 150,
        structure_matrix: 150,
        information_matrix: 150,
        gravity_matrix: 150,
      },
      outputs: {}, progress: 0, routingCursor: 0, utilization: 0, productionRate: 0,
    });
    const session = createPureIdleMacroSession(source, "stable");
    expect(session.candidate.research.completedTechIds).not.toContain("construction_capacity_1");
    expect(session.constructionPowerCertificate).toBeDefined();
    // The finite lab cache is deliberately not a sustainable-flow proof, so
    // production calibration freezes it. Inject only the sampled-work budget
    // here to exercise the same-bucket research boundary deterministically;
    // all matrices still come from the candidate's real calibrated inventory.
    session.researchLedger = {
      unitsPerWindow: 1_000n,
      windowSeconds: 30,
      observedUnits: 1_000n,
      inflowPerWindow: {},
    };

    advancePureIdleMacroSession(session, 60);

    expect(session.candidate.research.completedTechIds).toContain("construction_capacity_1");
    expect(session.constructionPowerCertificate).toBeUndefined();
    expect(session.candidate.construction.arc_smelter).toBe(0);
  });

  it("refreshes the joint power certificate across the ten-minute shadow validation", () => {
    const source = pureIdleState();
    addJointConstructionPowerFixture(source, { target: 100, wind: 2, smelters: 0 });
    const single = createPureIdleMacroSession(structuredClone(source), "stable");
    const segmented = createPureIdleMacroSession(structuredClone(source), "stable");

    advancePureIdleMacroSession(single, 900);
    advancePureIdleMacroSession(segmented, PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS);
    const craftedAtValidation = segmented.candidate.constructionAutomation.totalCrafted;
    expect(segmented.validationCount).toBe(1);
    expect(segmented.constructionPowerCertificate).toBeDefined();
    advancePureIdleMacroSession(segmented, 900);

    expect(segmented.candidate.constructionAutomation.totalCrafted).toBeGreaterThan(craftedAtValidation);
    expect(segmented.contractVersion).toBe(single.contractVersion);
    // Shadow calibration records diagnostic history at the point each caller
    // crosses the boundary, so the complete save hash is intentionally not a
    // segmentation oracle here. The construction material domain must match.
    expect(segmented.candidate.constructionAutomation).toEqual(single.candidate.constructionAutomation);
    expect(segmented.candidate.construction).toEqual(single.candidate.construction);
    expect(segmented.candidate.tray).toEqual(single.candidate.tray);
    expect(segmented.candidate.entities.filter((entity) => entity.buildingId === "construction_center"))
      .toEqual(single.candidate.entities.filter((entity) => entity.buildingId === "construction_center"));
  });

  it("consumes a Worker-owned calibration graph without changing the 60-second result", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addProductiveSmelter(source, 1_000);
    addRecursiveConstructionCenter(source, 100);
    const sourceHash = hashGameState(source);

    const retained = createPureIdleMacroSession(structuredClone(source), "stable", {
      forceConservativeReason: "retained checkpoint reference",
    });
    const consumed = createPureIdleMacroSession(structuredClone(source), "stable", {
      forceConservativeReason: "Worker-owned checkpoint",
      consumeCalibrationState: true,
    });

    expect(consumed.calibrationCheckpoint).toBeUndefined();
    expect(consumed.settledSimulationSeconds).toBe(PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS);
    expect(consumed.settledWallSeconds).toBeCloseTo(PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS / 8, 9);
    expect(consumed.pendingConstructionSimulationSeconds).toBe(PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS);
    expect(hashGameState(consumed.candidate)).toBe(hashGameState(retained.calibrationCheckpoint!.candidate));

    advancePureIdleMacroSession(retained, 60);
    advancePureIdleMacroSession(consumed, 60);

    expect(hashGameState(consumed.candidate)).toBe(hashGameState(retained.candidate));
    expect(consumed.pendingConstructionSimulationSeconds).toBe(0);
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("does not duplicate prefilled silo launches when low-rate production cannot fund a conservative tail", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addRocketConservationFixture(source);
    const producer = source.entities.find((entity) => entity.id === "slow-rocket-producer")!;
    producer.machineCount = 0;
    producer.inputs = {};
    const sourceHash = hashGameState(source);
    const initialRockets = source.entities.find((entity) => entity.id === "prefilled-rocket-silo")!.inputs.small_carrier_rocket ?? 0;
    const session = createConservativePureIdleMacroSession(structuredClone(source), "stable", "forced conservative regression");
    const exactPrefixLaunches = session.calibrationCheckpoint!.candidate.dysonSphere.totalRocketsLaunched -
      source.dysonSphere.totalRocketsLaunched;

    advancePureIdleMacroSession(session, 30);
    const finalized = finalizePureIdleMacroSession(session, 30, createContentPackRegistry()).state;
    const launches = finalized.dysonSphere.totalRocketsLaunched - source.dysonSphere.totalRocketsLaunched;
    const produced = (finalized.totalProduced.small_carrier_rocket ?? 0) - (source.totalProduced.small_carrier_rocket ?? 0);
    const endingRockets = finalized.entities.find((entity) => entity.id === "prefilled-rocket-silo")!.inputs.small_carrier_rocket ?? 0;

    expect(session.actualMultiplier).toBe(15);
    expect(exactPrefixLaunches).toBeGreaterThan(0);
    expect(launches).toBe(exactPrefixLaunches);
    expect(launches).toBeLessThanOrEqual(produced + initialRockets - endingRockets);
    expect(validatePureIdleTerminalMaterialConservation(source, finalized)).toBeNull();
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("does not affine-extrapolate prefilled solar-sail launches in the generic pure-idle path", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addSolarSailConservationFixture(source);
    const sourceHash = hashGameState(source);
    const initialSails = source.entities.find((entity) => entity.id === "prefilled-sail-ejector")!
      .inputs.solar_sail ?? 0;
    const session = createPureIdleMacroSession(structuredClone(source), "stable");
    const exactPrefixLaunches = session.calibrationCheckpoint!.candidate.dysonSwarm.totalLaunched -
      source.dysonSwarm.totalLaunched;

    advancePureIdleMacroSession(session, 60);
    const launches = session.candidate.dysonSwarm.totalLaunched - source.dysonSwarm.totalLaunched;
    const endingSails = session.candidate.entities.find((entity) => entity.id === "prefilled-sail-ejector")!
      .inputs.solar_sail ?? 0;

    expect(session.conservativeOnly).toBe(false);
    expect(exactPrefixLaunches).toBeGreaterThan(0);
    // The exact prefix may consume known stock; the unproven affine tail must
    // not copy the sampled ejector result a second time.
    expect(launches).toBe(exactPrefixLaunches);
    expect(launches).toBeLessThanOrEqual(initialSails - endingSails);
    expect(session.degradedReason).toBeUndefined();
    expect(validatePureIdleTerminalMaterialConservation(source, session.candidate)).toBeNull();
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps the ordinary small-save rocket tail deterministic across segmented affine buckets", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addRocketConservationFixture(source, 0);
    const sourceHash = hashGameState(source);
    const single = createPureIdleMacroSession(structuredClone(source), "stable");
    const segmented = createPureIdleMacroSession(structuredClone(source), "stable");

    expect(single.conservativeOnly).toBe(false);
    expect(single.rocketLedger).toBeUndefined();
    advancePureIdleMacroSession(single, 60);
    advancePureIdleMacroSession(segmented, 7);
    advancePureIdleMacroSession(segmented, 19);
    advancePureIdleMacroSession(segmented, 60);

    const launched = single.candidate.dysonSphere.totalRocketsLaunched -
      source.dysonSphere.totalRocketsLaunched;
    const produced = (single.candidate.totalProduced.small_carrier_rocket ?? 0) -
      (source.totalProduced.small_carrier_rocket ?? 0);
    expect(launched).toBeGreaterThan(0);
    expect(produced).toBeGreaterThanOrEqual(launched);
    expect(validatePureIdleTerminalMaterialConservation(source, single.candidate)).toBeNull();
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("continues a stable single-system rocket line only when sampled manufacture funds every launch", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addRocketConservationFixture(source, 0);
    const sourceHash = hashGameState(source);
    const single = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "closed rocket event-domain regression",
    );
    const segmented = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "closed rocket event-domain regression",
    );
    const exactPrefixLaunches = single.calibrationCheckpoint!.candidate.dysonSphere.totalRocketsLaunched -
      source.dysonSphere.totalRocketsLaunched;

    expect(single.rocketLedger).toBeDefined();
    advancePureIdleMacroSession(single, 60);
    advancePureIdleMacroSession(segmented, 19);
    advancePureIdleMacroSession(segmented, 60);

    const launches = single.candidate.dysonSphere.totalRocketsLaunched - source.dysonSphere.totalRocketsLaunched;
    const produced = (single.candidate.totalProduced.small_carrier_rocket ?? 0) -
      (source.totalProduced.small_carrier_rocket ?? 0);
    expect(launches).toBeGreaterThan(exactPrefixLaunches);
    expect(produced).toBeGreaterThanOrEqual(launches);
    expect(validatePureIdleTerminalMaterialConservation(source, single.candidate)).toBeNull();
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps a stable multi-system rocket ledger deterministic across segmented macro buckets", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addRocketConservationFixture(source, 0);
    addSecondRocketSystemFixture(source, 0);
    advanceExactSimulationWindow(source, 30, 2);
    const sourceHash = hashGameState(source);
    const single = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "multi-system closed rocket event-domain regression",
    );
    const segmented = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "multi-system closed rocket event-domain regression",
    );

    expect(single.rocketLedger, single.degradedReason).toBeDefined();
    expect(Object.keys(single.rocketLedger?.launchesBySystemPerWindow ?? {}).sort())
      .toEqual(["borealis", "helios"]);
    const prefix = single.calibrationCheckpoint!.candidate;
    const prefixHelios = prefix.dysonPlans.helios.structurePoints - source.dysonPlans.helios.structurePoints;
    const prefixBorealis = prefix.dysonPlans.borealis.structurePoints - source.dysonPlans.borealis.structurePoints;

    advancePureIdleMacroSession(single, 60);
    advancePureIdleMacroSession(segmented, 7);
    advancePureIdleMacroSession(segmented, 19);
    advancePureIdleMacroSession(segmented, 60);

    expect(single.candidate.dysonPlans.helios.structurePoints - source.dysonPlans.helios.structurePoints)
      .toBeGreaterThan(prefixHelios);
    expect(single.candidate.dysonPlans.borealis.structurePoints - source.dysonPlans.borealis.structurePoints)
      .toBeGreaterThan(prefixBorealis);
    expect(validatePureIdleTerminalMaterialConservation(source, single.candidate)).toBeNull();
    expect(hashGameState(segmented.candidate)).toBe(hashGameState(single.candidate));
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("uses the same closed multi-system rocket ledger during fast offline settlement", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.enabled = false;
    source.timeWarp.requestedMultiplier = 1;
    addRocketConservationFixture(source, 0);
    addSecondRocketSystemFixture(source, 0);
    advanceExactSimulationWindow(source, 30, 30);
    const sourceHash = hashGameState(source);

    const result = runFastOfflineSettlement(source, 10 * 60);

    expect(result.status).toBe("approximate");
    if (result.status !== "approximate") return;
    expect(result.state.dysonSphere.totalRocketsLaunched - source.dysonSphere.totalRocketsLaunched)
      .toBeGreaterThan(200);
    expect(result.state.dysonPlans.helios.structurePoints - source.dysonPlans.helios.structurePoints)
      .toBeGreaterThan(0);
    expect(result.state.dysonPlans.borealis.structurePoints - source.dysonPlans.borealis.structurePoints)
      .toBeGreaterThan(0);
    expect(validatePureIdleTerminalMaterialConservation(source, result.state)).toBeNull();
    expect(hashGameState(source)).toBe(sourceHash);
  });

  it("keeps the terminal material ledger closed after serialization, inspectSave and reload", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 15;
    addRocketConservationFixture(source);
    const session = createConservativePureIdleMacroSession(
      structuredClone(source),
      "stable",
      "forced conservative reload regression",
    );
    const finalized = finalizePureIdleMacroSession(session, 10 * 60, createContentPackRegistry()).state;
    const raw = serializeEnvelope(finalized, 1_788_000_000_000);
    const inspection = inspectSave(raw);

    expect(inspection).toMatchObject({ valid: true, checksum: "valid", stateVersion: 47 });
    expect(inspection.state).toBeDefined();
    expect(validatePureIdleTerminalMaterialConservation(source, inspection.state!)).toBeNull();
  });

  it.each([8, 12, 15, 16] as const)(
    "keeps %ix conservative settlement deterministic for one long call and segmented calls in finite/infinite modes",
    (multiplier) => {
      for (const resourceMode of ["finite", "infinite"] as const) {
        const source = pureIdleState();
        source.settings.simulationSpeed = 4;
        source.settings.resourceMode = resourceMode;
        source.timeWarp.requestedMultiplier = multiplier;
        addRocketConservationFixture(source, 250_000);

        const segmented = createConservativePureIdleMacroSession(structuredClone(source), "stable", "forced conservative regression");
        advancePureIdleMacroSession(segmented, 7);
        advancePureIdleMacroSession(segmented, 19);
        advancePureIdleMacroSession(segmented, 60);

        const single = createConservativePureIdleMacroSession(structuredClone(source), "stable", "forced conservative regression");
        advancePureIdleMacroSession(single, 60);

        expect(segmented.actualMultiplier).toBe(multiplier);
        expect(single.actualMultiplier).toBe(multiplier);
        expect(hashGameState(segmented.candidate), `${multiplier}x ${resourceMode}`).toBe(hashGameState(single.candidate));
        expect(validatePureIdleTerminalMaterialConservation(source, single.candidate)).toBeNull();
      }
    },
  );

  it("closes multi-system rocket, sail, absorption and orbit counters before accepting a candidate", () => {
    const before = pureIdleState();
    const after = structuredClone(before);
    before.tray.small_carrier_rocket = 4;
    before.tray.solar_sail = 5;
    after.tray.small_carrier_rocket = 0;
    after.tray.solar_sail = 0;
    const systems = Object.keys(after.dysonPlans);
    const targetSystem = (systems[1] ?? systems[0]) as keyof GameState["dysonPlans"];
    const orbit = after.dysonEngineering.orbitsBySystem[targetSystem]?.[0];
    expect(orbit).toBeDefined();

    after.dysonSphere.totalRocketsLaunched += 4;
    after.dysonSphere.structurePoints += 4;
    after.dysonPlans[targetSystem].structurePoints += 4;
    after.dysonSwarm.totalLaunched += 5;
    after.dysonSwarm.sailsInOrbit += 3;
    after.dysonSphere.totalSailsAbsorbed += 2;
    after.dysonSphere.shellSails += 2;
    after.dysonPlans[targetSystem].shellSails += 2;
    orbit!.totalLaunched += 5;
    orbit!.sailsInOrbit += 3;

    expect(validatePureIdleTerminalMaterialConservation(before, after)).toBeNull();
    after.dysonPlans[targetSystem].structurePoints += 1;
    expect(validatePureIdleTerminalMaterialConservation(before, after)).toContain("各恒星系结构增量");
  });

  it("rejects a candidate that copies rocket and structure counters without consuming their material", () => {
    const before = pureIdleState();
    const after = structuredClone(before);
    before.tray.small_carrier_rocket = 1;
    after.tray.small_carrier_rocket = 0;
    after.dysonSphere.totalRocketsLaunched += 100;
    after.dysonSphere.structurePoints += 100;
    after.dysonPlans.helios.structurePoints += 100;

    expect(validatePureIdleTerminalMaterialConservation(before, after)).toContain("超过生产与库存来源");
  });

  it("discards an unfunded affine terminal candidate without changing the source hash", () => {
    const state = pureIdleState();
    const sourceHash = hashGameState(state);
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [
        { path: ["dysonSphere", "totalRocketsLaunched"], kind: "number", delta: 10, integer: true },
        { path: ["dysonSphere", "structurePoints"], kind: "number", delta: 10, integer: true },
        { path: ["dysonPlans", "helios", "structurePoints"], kind: "number", delta: 10, integer: true },
      ],
    } as PureIdleAffineContract;

    const result = applyPureIdleAffineContract(state, contract, 1, 1, { allowExactFallback: false });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("物资守恒失败");
    expect(result.failure).toContain("small_carrier_rocket");
    expect(hashGameState(state)).toBe(sourceHash);
  });

  it("rejects unfunded galactic delivery counters even when inventory itself does not grow", () => {
    const state = pureIdleState();
    const sourceHash = hashGameState(state);
    const contract = {
      calibrationSeconds: 1,
      calibrationWallSeconds: 1,
      deltas: [
        { path: ["endgame", "exportProjects", "universe_archive", "totalDelivered"], kind: "number", delta: 10, integer: true },
        { path: ["endgame", "totalExported"], kind: "number", delta: 10, integer: true },
      ],
    } as PureIdleAffineContract;

    const result = applyPureIdleAffineContract(state, contract, 1, 1, { allowExactFallback: false });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("出口/销毁/交付");
    expect(hashGameState(state)).toBe(sourceHash);
  });

  it.each(["inventory-exhausted", "output-blocked", "no-power", "production-stopped"])(
    "freezes the conservative tail at the last exact checkpoint for %s",
    (condition) => {
      const source = pureIdleState();
      source.settings.simulationSpeed = 4;
      source.timeWarp.requestedMultiplier = 8;
      addProductiveSmelter(source, 1_000);
      const smelter = source.entities.find((entity) => entity.id === "pure-idle-smelter")!;
      if (condition === "inventory-exhausted") smelter.inputs.iron_ore = 1;
      if (condition === "output-blocked") smelter.outputs.iron_ingot = source.settings.productionBufferLimit;
      if (condition === "production-stopped") smelter.inputs.iron_ore = 0;
      if (condition === "no-power") source.entities = source.entities.filter((entity) => entity.kind !== "power");
      const session = createConservativePureIdleMacroSession(structuredClone(source), "stable", "forced conservative boundary");
      const prefixProduced = session.calibrationCheckpoint!.candidate.totalProduced.iron_ingot ?? 0;
      advancePureIdleMacroSession(session, 60 * 60);
      expect(session.candidate.totalProduced.iron_ingot ?? 0).toBe(prefixProduced);
      expect(validatePureIdleTerminalMaterialConservation(source, session.candidate)).toBeNull();
    },
  );

  it("keeps low-power production productive at the measured 30-second rate", () => {
    const source = pureIdleState();
    source.settings.simulationSpeed = 4;
    source.timeWarp.requestedMultiplier = 8;
    addProductiveSmelter(source, 1_000);
    const wind = source.entities.find((entity) => entity.kind === "power");
    if (wind) wind.machineCount = 1;
    const session = createConservativePureIdleMacroSession(structuredClone(source), "stable", "forced conservative low-power");
    const prefixProduced = session.calibrationCheckpoint!.candidate.totalProduced.iron_ingot ?? 0;

    advancePureIdleMacroSession(session, 60);

    expect(session.candidate.totalProduced.iron_ingot ?? 0).toBeGreaterThan(prefixProduced);
    expect(validatePureIdleTerminalMaterialConservation(source, session.candidate)).toBeNull();
  });

  it("honours cancellation before mutating a macro boundary", () => {
    const session = createPureIdleMacroSession(structuredClone(pureIdleState()), "extreme");
    const before = hashGameState(session.candidate);

    expect(() => advancePureIdleMacroSession(session, 24 * 60 * 60, {
      shouldCancel: () => true,
    })).toThrowError(/取消/);
    expect(hashGameState(session.candidate)).toBe(before);
    expect(session.settledWallSeconds).toBe(0);
  });

  it("honours an expired deadline before calibration starts", () => {
    expect(() => createPureIdleMacroSession(structuredClone(pureIdleState()), "stable", {
      deadlineAtMs: -1,
    })).toThrowError(/现实时间上限/);
  });
});
