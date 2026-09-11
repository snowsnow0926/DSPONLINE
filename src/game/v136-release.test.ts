import { describe, expect, it } from "vitest";
import { FUEL_ENERGY_MJ, getFuelItemIdsForBuilding } from "./content";
import {
  adjustStationDrones,
  advancePersistentSimulationRuntime,
  advanceSimulation,
  advanceSimulationBudget,
  connectBeltWithResult,
  createInitialState,
  createPersistentSimulationRuntime,
  createSimulationPlanetPhaseLookup,
  createSimulationLookupContext,
  createSimulationAdvanceSession,
  createSimulationProfiler,
  advanceSimulationSession,
  completeSimulationAdvanceSession,
  getBlueprintPlacementPreview,
  getBeltConnectionCheck,
  getEntityCycleRatePerSimulationSecond,
  getEntityOperatingStatus,
  placeBlueprint,
  placeBuilding,
  queueBlueprint,
  setFuelItem,
  setLogisticsItem,
  setStationMode,
} from "./engine";
import { hashGameState } from "./benchmark";
import type { BeltConnection, BlueprintDefinition, FactoryEntity, GameState } from "./types";

function storageLineFixture(stock: number) {
  let state = createInitialState();
  state.construction.storage_mk1 = 2;
  state.construction.conveyor_belt_mk1 = stock;
  state = placeBuilding(state, "storage_mk1", { x: 0, y: 0 });
  state = placeBuilding(state, "storage_mk1", { x: 300, y: 0 });
  const [source, target] = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
  source.storedItemId = "iron_ingot";
  target.storedItemId = "iron_ingot";
  return { state, source, target };
}

function laneBlueprint(): BlueprintDefinition {
  return {
    id: "v136-lane-blueprint",
    name: "默认并联蓝图",
    entities: [
      { key: "source", buildingId: "storage_mk1", offset: { x: 0, y: 0 }, machineCount: 1, storedItemId: "iron_ingot" },
      { key: "target", buildingId: "storage_mk1", offset: { x: 300, y: 0 }, machineCount: 1, storedItemId: "iron_ingot" },
    ],
    belts: [{ key: "line", sourceKey: "source", targetKey: "target", itemId: "iron_ingot", lanes: 1, tier: 1, sorterTier: 1, priority: 1 }],
  };
}

function fireIcePlant(): { state: GameState; plant: FactoryEntity } {
  let state = createInitialState();
  state.construction.thermal_power_plant = 1;
  state = placeBuilding(state, "thermal_power_plant", { x: 0, y: 0 });
  const plant = state.entities.find((entity) => entity.buildingId === "thermal_power_plant")!;
  state = setFuelItem(state, plant.id, "fire_ice");
  const configured = state.entities.find((entity) => entity.id === plant.id)!;
  configured.inputs.fire_ice = 2;
  const iron = state.entities.find((entity) => entity.kind === "vein" && entity.resourceId === "iron_ore")!;
  iron.minerCount = 1;
  iron.extractorBuildingId = "mining_machine";
  return { state, plant: configured };
}

describe("1.0.36 belt defaults and fuel support", () => {
  it("creates all requested lanes atomically and reports an exact shortage", () => {
    const fixture = storageLineFixture(8);
    const result = connectBeltWithResult(fixture.state, fixture.source.id, fixture.target.id, "iron_ingot", 1, undefined, 4);
    expect(result.state.belts).toEqual([expect.objectContaining({ lanes: 4 })]);
    expect(result.state.construction.conveyor_belt_mk1).toBe(4);

    const parallel = connectBeltWithResult(result.state, fixture.source.id, fixture.target.id, "iron_ingot", 1, undefined, 4);
    expect(parallel.state.belts[0].lanes).toBe(8);
    expect(parallel.state.construction.conveyor_belt_mk1).toBe(0);

    const shortage = storageLineFixture(3);
    expect(getBeltConnectionCheck(shortage.state, shortage.source.id, shortage.target.id, "iron_ingot", 1, undefined, 4)).toMatchObject({
      ok: false,
      code: "missing-belt",
      label: expect.stringContaining("需要 4，现有 3"),
    });
    expect(connectBeltWithResult(shortage.state, shortage.source.id, shortage.target.id, "iron_ingot", 1, undefined, 4).state).toBe(shortage.state);
    expect(shortage.state.belts).toEqual([]);
    expect(shortage.state.construction.conveyor_belt_mk1).toBe(3);
  });

  it("applies the lane preference to direct and queued blueprints with matching material previews", () => {
    const blueprint = laneBlueprint();
    const source = createInitialState();
    source.blueprints = [blueprint];
    source.construction.storage_mk1 = 2;
    source.construction.conveyor_belt_mk1 = 4;
    const preview = getBlueprintPlacementPreview(source, blueprint.id, { x: 600, y: 0 }, { minimumBeltLanes: 4 });
    expect(preview.requirements).toEqual(expect.arrayContaining([
      { constructionId: "conveyor_belt_mk1", amount: 4 },
    ]));
    const deployed = placeBlueprint(source, blueprint.id, { x: 600, y: 0 }, { minimumBeltLanes: 4 });
    expect(deployed.belts.at(-1)?.lanes).toBe(4);
    expect(deployed.construction.conveyor_belt_mk1).toBe(0);

    const shortage = { ...source, construction: { ...source.construction, conveyor_belt_mk1: 3 } };
    expect(placeBlueprint(shortage, blueprint.id, { x: 600, y: 0 }, { minimumBeltLanes: 4 })).toBe(shortage);

    const queued = queueBlueprint({ ...source, construction: { ...source.construction, conveyor_belt_mk1: 0 } }, blueprint.id, { x: 900, y: 0 }, { minimumBeltLanes: 4 });
    expect(queued.blueprintVersions?.find((version) => version.id.includes(":lanes-4"))?.definition.belts[0].lanes).toBe(4);
    expect(queued.blueprints[0].belts[0].lanes).toBe(1);
  });

  it.each([1, 4, 12, 60, 600, 3_600, 86_400])("keeps indexed belt settlement identical to the full oracle for %s seconds", (seconds) => {
    const fixture = storageLineFixture(4);
    fixture.source.outputs.iron_ingot = 100_000;
    const connected = connectBeltWithResult(fixture.state, fixture.source.id, fixture.target.id, "iron_ingot", 1, undefined, 4).state;
    const run = (indexedLogistics: boolean) => {
      const session = createSimulationAdvanceSession(structuredClone(connected), seconds, { indexedLogistics });
      advanceSimulationSession(session, Number.MAX_SAFE_INTEGER);
      return completeSimulationAdvanceSession(session);
    };
    const indexed = run(true);
    const oracle = run(false);
    expect(hashGameState(indexed)).toBe(hashGameState(oracle));
    expect(indexed).toEqual(oracle);
    expect(indexed.entities.find((entity) => entity.id === fixture.target.id)?.inputs.iron_ingot).toBe(
      oracle.entities.find((entity) => entity.id === fixture.target.id)?.inputs.iron_ingot,
    );
    expect(indexed.belts[0]).toEqual(oracle.belts[0]);
  }, 30_000);

  it("burns fire ice through the existing thermal, statistics and time-budget path", () => {
    expect(FUEL_ENERGY_MJ.fire_ice).toBe(4.8);
    expect(getFuelItemIdsForBuilding("thermal_power_plant")).toContain("fire_ice");
    const fixture = fireIcePlant();
    const exact = advanceSimulation(fixture.state, 4);
    const budgeted = advanceSimulationBudget(fixture.state, 4, 1);
    const exactPlant = exact.entities.find((entity) => entity.id === fixture.plant.id)!;
    expect(exactPlant.fuelItemId).toBe("fire_ice");
    expect(exactPlant.inputs.fire_ice).toBeLessThan(2);
    expect(exact.metrics.thermalGenerationKw).toBeGreaterThan(0);
    expect(hashGameState(budgeted)).toBe(hashGameState(exact));
  });

  it("keeps every legacy thermal fuel, supports mixed plants, and stops cleanly when fire ice is exhausted", () => {
    expect(getFuelItemIdsForBuilding("thermal_power_plant")).toEqual(expect.arrayContaining([
      "coal", "crude_oil", "energetic_graphite", "refined_oil", "hydrogen", "hydrogen_fuel_rod",
      "deuteron_fuel_rod", "antimatter_fuel_rod", "fire_ice",
    ]));
    let state = createInitialState();
    state.construction.thermal_power_plant = 2;
    state = placeBuilding(state, "thermal_power_plant", { x: 0, y: 0 });
    state = placeBuilding(state, "thermal_power_plant", { x: 260, y: 0 });
    const [fireIce, coal] = state.entities.filter((entity) => entity.buildingId === "thermal_power_plant");
    state = setFuelItem(state, fireIce.id, "fire_ice");
    state = setFuelItem(state, coal.id, "coal");
    const configuredFireIce = state.entities.find((entity) => entity.id === fireIce.id)!;
    const configuredCoal = state.entities.find((entity) => entity.id === coal.id)!;
    configuredFireIce.inputs.fire_ice = 2;
    configuredCoal.inputs.coal = 2;
    for (const vein of state.entities.filter((entity) => entity.kind === "vein").slice(0, 3)) {
      vein.minerCount = 10_000;
      vein.extractorBuildingId = "mining_machine";
    }
    const running = advanceSimulation(state, 2);
    expect(running.entities.find((entity) => entity.id === fireIce.id)?.inputs.fire_ice).toBeLessThan(2);
    expect(running.entities.find((entity) => entity.id === coal.id)?.inputs.coal).toBeLessThan(2);
    expect(running.metrics.thermalGenerationKw).toBeGreaterThan(0);

    const exhausted = structuredClone(state);
    const exhaustedPlant = exhausted.entities.find((entity) => entity.id === fireIce.id)!;
    exhaustedPlant.inputs.fire_ice = 0;
    exhaustedPlant.fuelRemainingMj = 0;
    const afterExhaustion = advanceSimulation(exhausted, 2);
    const stoppedPlant = afterExhaustion.entities.find((entity) => entity.id === fireIce.id)!;
    expect(stoppedPlant.inputs.fire_ice).toBe(0);
    expect(stoppedPlant.fuelRemainingMj).toBe(0);
    expect(stoppedPlant.powerOutputKw).toBe(0);
  });
});

describe("1.0.36 runtime indexes", () => {
  it("skips a proven dormant belt cohort and wakes it when its source changes", () => {
    const state = createInitialState();
    state.entities = [];
    state.belts = [];
    for (let index = 0; index < 80; index += 1) {
      const source: FactoryEntity = {
        id: `source-${index}`, kind: "storage", planetId: "home", position: { x: 0, y: index * 10 }, interactionLocked: false,
        buildingId: "storage_mk1", storedItemId: "iron_ingot", machineCount: 1, minerCount: 0, inputs: {}, outputs: {}, progress: 0,
        routingCursor: 0, utilization: 0, productionRate: 0,
      };
      const target: FactoryEntity = { ...structuredClone(source), id: `target-${index}`, position: { x: 300, y: index * 10 } };
      const belt: BeltConnection = {
        id: `belt-${index}`, planetId: "home", source: source.id, target: target.id, itemId: "iron_ingot", lanes: 1, tier: 1,
        sorterTier: 1, progress: 0, priority: 1, lastFlow: 0, congestion: 0, totalTransferred: 0,
      };
      state.entities.push(source, target);
      state.belts.push(belt);
    }
    const lookup = createSimulationLookupContext(state);
    expect(lookup.beltRuntime.activeQueueEnabled).toBe(true);
    expect(lookup.beltRuntime.initiallyDormantRouteCount).toBe(80);

    const runtime = createPersistentSimulationRuntime(structuredClone(state));
    const profiler = createSimulationProfiler();
    advancePersistentSimulationRuntime(runtime, 1, 1, profiler);
    expect(profiler.beltStableRoutesSkipped).toBeGreaterThanOrEqual(160);
    expect(runtime.state.belts.every((belt) => (belt.totalTransferred ?? 0) === 0)).toBe(true);

    runtime.state.entities.find((entity) => entity.id === "source-0")!.outputs.iron_ingot = 10;
    advancePersistentSimulationRuntime(runtime, 1, 1);
    expect(runtime.state.entities.find((entity) => entity.id === "target-0")?.inputs.iron_ingot).toBeGreaterThan(0);
  });

  it("reuses an unchanged blocked logistics slot without changing dispatch state", () => {
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
    state.portableFleet.logistics_drone = 1;
    state = adjustStationDrones(state, demand.id, 1);
    const runtime = createPersistentSimulationRuntime(state);
    advancePersistentSimulationRuntime(runtime, 1, 1);
    const profiler = createSimulationProfiler();
    advancePersistentSimulationRuntime(runtime, 1, 1, profiler);
    expect(profiler.dispatchBlockedCacheHits).toBeGreaterThan(0);
    expect(runtime.state.entities.find((entity) => entity.id === demand.id)?.stationRoutes).toEqual([]);
  });

  it("keeps dense-canvas indexed status and cycle projections identical to the scan oracle", () => {
    let state = createInitialState();
    state.construction.wind_turbine = 4;
    state.construction.storage_mk1 = 2;
    state.construction.planetary_logistics_station = 2;
    state.construction.conveyor_belt_mk1 = 1;
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -240 }, 4);
    state = placeBuilding(state, "storage_mk1", { x: -400, y: 0 });
    state = placeBuilding(state, "storage_mk1", { x: -100, y: 0 });
    const storages = state.entities.filter((entity) => entity.buildingId === "storage_mk1");
    storages[0].storedItemId = "iron_ingot";
    storages[1].storedItemId = "iron_ingot";
    storages[0].outputs.iron_ingot = 20;
    state = connectBeltWithResult(state, storages[0].id, storages[1].id, "iron_ingot").state;
    state = placeBuilding(state, "planetary_logistics_station", { x: 240, y: 0 });
    state = placeBuilding(state, "planetary_logistics_station", { x: 540, y: 0 });
    const [supply, demand] = state.entities.filter((entity) => entity.buildingId === "planetary_logistics_station");
    state = setLogisticsItem(state, supply.id, "iron_ingot");
    state = setLogisticsItem(state, demand.id, "iron_ingot");
    state = setStationMode(state, demand.id, "demand");
    const lookup = createSimulationPlanetPhaseLookup(state);
    for (const entity of state.entities) {
      expect(getEntityOperatingStatus(state, entity, lookup)).toEqual(getEntityOperatingStatus(state, entity));
      expect(getEntityCycleRatePerSimulationSecond(state, entity, lookup)).toBe(
        getEntityCycleRatePerSimulationSecond(state, entity),
      );
    }
  });
});
