import { describe, expect, it } from "vitest";
import { createInitialState, placeBuilding, setActivePlanet, setLogisticsItem, setStationHubConfiguration, setStationSlotLimits, setStationSlotMode, setStationSlotRoutePolicy, setStationSlotWarperBudget } from "./engine";
import { getPlanetIndustrySummaries, getRoutePathLabel, getStellarRouteSnapshots } from "./stellarIndustry";

describe("stellar industry selectors", () => {
  it("builds a cross-system route snapshot from the same station slots used by simulation", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics", "stellar_exploration", "space_warp");
    state.exploration.unlockedSystemIds.push("borealis");
    state.exploration.colonizedPlanetIds.push("frost");
    state.construction.wind_turbine = 2;
    state.construction.interstellar_logistics_station = 2;
    state = placeBuilding(state, "wind_turbine", { x: -180, y: -180 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: -180, y: 0 });
    const source = state.entities.find((entity) => entity.planetId === "home" && entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, source.id, "titanium_ingot");
    state = setStationSlotMode(state, source.id, 0, "remote", "supply");
    state.entities.find((entity) => entity.id === source.id)!.outputs.titanium_ingot = 250;
    state = setActivePlanet(state, "frost");
    state = placeBuilding(state, "wind_turbine", { x: 180, y: -180 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: 180, y: 0 });
    const target = state.entities.find((entity) => entity.planetId === "frost" && entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, target.id, "titanium_ingot");
    state = setStationSlotMode(state, target.id, 0, "remote", "demand");
    state.entities.find((entity) => entity.id === target.id)!.stationVessels = 2;
    state = setStationSlotLimits(state, target.id, 0, 0, 320);

    const routes = getStellarRouteSnapshots(state);
    expect(routes).toHaveLength(1);
    const route = routes.find((candidate) => candidate.scope === "remote")!;
    expect(route.sourceStationId).toBe(source.id);
    expect(route.targetStationId).toBe(target.id);
    expect(route.distanceLy).toBeCloseTo(4.2, 1);
    expect(route.warpersPerTrip).toBe(2);
    expect(route.targetLimit).toBe(320);
    expect(route.status).toBe("missing-warper");

    state.entities.find((entity) => entity.id === target.id)!.stationWarpers = 2;
    const ready = getStellarRouteSnapshots(state).find((candidate) => candidate.scope === "remote")!;
    expect(ready.status).toBe("ready");
    const summary = getPlanetIndustrySummaries(state).find((planet) => planet.planetId === "frost")!;
    expect(summary.configuredImports).toBeGreaterThan(0);
    expect(summary.roleLabel).toContain("物流");
    expect(summary.recommendedRole).toBe("chemical");
  });

  it("treats a powered supply station fleet and its warpers as a ready outbound route", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics", "stellar_exploration", "space_warp");
    state.exploration.unlockedSystemIds.push("borealis");
    state.exploration.colonizedPlanetIds.push("frost");
    state.construction.wind_turbine = 2;
    state.construction.interstellar_logistics_station = 2;

    state = placeBuilding(state, "wind_turbine", { x: -180, y: -180 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: -180, y: 0 });
    const source = state.entities.find((entity) => entity.planetId === "home" && entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, source.id, "titanium_ingot");
    state = setStationSlotMode(state, source.id, 0, "remote", "supply");
    Object.assign(state.entities.find((entity) => entity.id === source.id)!, {
      stationVessels: 2,
      stationWarpEnabled: true,
      stationWarpers: 2,
      outputs: { titanium_ingot: 250 },
    });

    state = setActivePlanet(state, "frost");
    state = placeBuilding(state, "wind_turbine", { x: 180, y: -180 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: 180, y: 0 });
    const target = state.entities.find((entity) => entity.planetId === "frost" && entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, target.id, "titanium_ingot");
    state = setStationSlotMode(state, target.id, 0, "remote", "demand");

    const route = getStellarRouteSnapshots(state).find((candidate) => candidate.scope === "remote")!;
    expect(route).toMatchObject({
      sourceStationId: source.id,
      targetStationId: target.id,
      installedVehicles: 2,
      availableWarpers: 2,
      status: "ready",
    });
  });

  it("names relay waypoints and reports an unpowered hub before dispatch", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics", "stellar_exploration", "space_warp");
    state.exploration.unlockedSystemIds.push("aurora", "sirius");
    state.exploration.colonizedPlanetIds.push("verdant", "crystal");
    state.construction.wind_turbine = 3;
    state.construction.interstellar_logistics_station = 3;

    state = placeBuilding(state, "wind_turbine", { x: 0, y: -180 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const source = state.entities.find((entity) => entity.planetId === "home" && entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, source.id, "processor");
    state = setStationSlotMode(state, source.id, 0, "remote", "supply");
    state.entities.find((entity) => entity.id === source.id)!.outputs.processor = 100;

    state = setActivePlanet(state, "verdant");
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const hub = state.entities.find((entity) => entity.planetId === "verdant" && entity.buildingId === "interstellar_logistics_station")!;
    state = setStationHubConfiguration(state, hub.id, true, 2);

    state = setActivePlanet(state, "crystal");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -180 });
    state = placeBuilding(state, "interstellar_logistics_station", { x: 0, y: 0 });
    const target = state.entities.find((entity) => entity.planetId === "crystal" && entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, target.id, "processor");
    state = setStationSlotMode(state, target.id, 0, "remote", "demand");
    state = setStationSlotRoutePolicy(state, target.id, 0, "relay-required");
    state = setStationSlotWarperBudget(state, target.id, 0, 2);
    state.entities.find((entity) => entity.id === target.id)!.stationVessels = 1;
    state.entities.find((entity) => entity.id === target.id)!.stationWarpers = 2;

    let route = getStellarRouteSnapshots(state)[0];
    expect(route).toMatchObject({ routeKind: "relay", waypointStationIds: [hub.id], status: "no-power" });
    expect(getRoutePathLabel(route, state)).toBe("赫利俄斯 → 曙光庭 → 天狼工域");

    state = setActivePlanet(state, "verdant");
    state = placeBuilding(state, "wind_turbine", { x: 0, y: -180 });
    route = getStellarRouteSnapshots(state)[0];
    expect(route.status).toBe("ready");
  });
});
