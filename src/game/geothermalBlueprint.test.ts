import { describe, expect, it } from "vitest";
import { createInitialState, createBlueprint, fundConstructionQueueEntry, getConstructionQueueDetails, placeBuilding, queueBlueprint } from "./engine";

function ashenState() {
  const state = createInitialState();
  state.activePlanetId = "ashen";
  state.exploration.colonizedPlanetIds = [...new Set([...state.exploration.colonizedPlanetIds, "ashen" as const])];
  return state;
}

describe("geothermal blueprint construction", () => {
  it("funds a 100-station stack atomically on a geothermal planet", () => {
    let state = ashenState();
    state.construction.geothermal_power_station = 100;
    state = placeBuilding(state, "geothermal_power_station", { x: 0, y: 0 }, 100);
    const source = state.entities.find((entity) => entity.buildingId === "geothermal_power_station")!;
    state = createBlueprint(state, [source.id], "批量地热");
    const blueprintId = state.blueprints[0].id;
    state.construction.geothermal_power_station = 100;
    state = queueBlueprint(state, blueprintId, { x: 600, y: 300 });
    expect(state.constructionQueue).toHaveLength(1);
    const entryId = state.constructionQueue[0].id;
    expect(getConstructionQueueDetails(state, entryId)).toMatchObject({ compatible: true, status: "pending-materials" });
    expect(getConstructionQueueDetails(state, entryId).requirements).toEqual([
      expect.objectContaining({ constructionId: "geothermal_power_station", total: 100, missing: 100, available: 100 }),
    ]);
    const funded = fundConstructionQueueEntry(state, entryId, "all");
    expect(funded.constructionQueue).toEqual([]);
    expect(funded.entities.find((entity) => entity.position.x === 600 && entity.position.y === 300)).toMatchObject({
      buildingId: "geothermal_power_station",
      machineCount: 100,
      planetId: "ashen",
    });
    expect(funded.construction.geothermal_power_station).toBe(0);
  });

  it("keeps a geothermal order blocked when its target is a non-geothermal planet", () => {
    let state = ashenState();
    state.construction.geothermal_power_station = 1;
    state = placeBuilding(state, "geothermal_power_station", { x: 0, y: 0 });
    const source = state.entities.find((entity) => entity.buildingId === "geothermal_power_station")!;
    state = createBlueprint(state, [source.id], "地热限制");
    const blueprintId = state.blueprints[0].id;
    state.construction.geothermal_power_station = 1;
    state = queueBlueprint(state, blueprintId, { x: 600, y: 300 });
    const entryId = state.constructionQueue[0].id;
    state.constructionQueue[0].planetId = "home";
    const before = structuredClone(state);
    const details = getConstructionQueueDetails(state, entryId);
    expect(details.compatible).toBe(false);
    expect(details.blockedReason).toContain("地热");
    expect(fundConstructionQueueEntry(state, entryId, "all")).toEqual(before);
  });
});
