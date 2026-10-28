import { describe, expect, it } from "vitest";
import { blueprintScaleFixture } from "../../experiments/web-blueprint-scale/fixture";
import { createBlueprint, createInitialState, fundConstructionQueueEntry, getConstructionQueueDetails, placeBlueprint, queueBlueprint } from "./engine";
import { importBlueprintExchange, parseBlueprintExchange, serializeBlueprintExchange } from "./blueprintExchange";
import { BLUEPRINT_EXCHANGE_MAX_EXTERNAL_PORTS } from "./blueprintExchangeLimits";
import { migrateGame } from "./storage";

describe("large Web blueprints", () => {
  it("captures, exchanges and atomically deploys all 4096 nodes and 8192 lines without changing its source", () => {
    const fixture = blueprintScaleFixture(createInitialState());
    const before = JSON.stringify(fixture.state);
    const captured = createBlueprint(fixture.state, [...fixture.entityIds].reverse(), "规模边界");
    const blueprint = captured.blueprints.at(-1)!;
    expect(blueprint.entities).toHaveLength(4096);
    expect(blueprint.belts).toHaveLength(8192);
    expect(blueprint.entities[0].key).toBe("node_1");
    expect(blueprint.entities.at(-1)?.key).toBe("node_4096");
    expect(JSON.stringify(fixture.state)).toBe(before);

    const raw = serializeBlueprintExchange(blueprint);
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(1_048_576);
    const parsed = parseBlueprintExchange(raw);
    expect(parsed.valid).toBe(true);
    const imported = importBlueprintExchange(createInitialState(), parsed.blueprint!);
    if (!imported.ok) throw new Error(imported.reason);
    const funded = { ...imported.state, construction: { ...imported.state.construction, storage_mk1: 4096, conveyor_belt_mk1: 8192 } };
    const source = JSON.stringify(funded);
    const placed = placeBlueprint(funded, imported.blueprintId, { x: 30_000, y: 30_000 });
    expect(placed.entities.length - funded.entities.length).toBe(4096);
    expect(placed.belts.length - funded.belts.length).toBe(8192);
    expect(placed.construction.storage_mk1).toBe(0);
    expect(placed.construction.conveyor_belt_mk1).toBe(0);
    expect(JSON.stringify(funded)).toBe(source);
    const missing = { ...funded, construction: { ...funded.construction, conveyor_belt_mk1: 8191 } };
    expect(placeBlueprint(missing, imported.blueprintId, { x: 30_000, y: 30_000 })).toBe(missing);
  });

  it("keeps the full immutable queue version and spends exactly the required construction stock", () => {
    const fixture = blueprintScaleFixture(createInitialState());
    const captured = createBlueprint(fixture.state, fixture.entityIds, "排队规模");
    const blueprint = captured.blueprints.at(-1)!;
    const queued = queueBlueprint(captured, blueprint.id, { x: 30_000, y: 30_000 });
    expect(queued.constructionQueue).toHaveLength(1);
    expect(queued.blueprintVersions.at(-1)?.definition).toEqual(blueprint);
    const funded = { ...queued, construction: { ...queued.construction, storage_mk1: 4096, conveyor_belt_mk1: 8192 } };
    const result = fundConstructionQueueEntry(funded, queued.constructionQueue[0].id);
    expect(result.constructionQueue).toHaveLength(0);
    expect(result.entities.length - queued.entities.length).toBe(4096);
    expect(result.belts.length - queued.belts.length).toBe(8192);
    expect(result.construction.storage_mk1).toBe(0);
    expect(result.construction.conveyor_belt_mk1).toBe(0);
    expect(queued.blueprintVersions.at(-1)?.definition).toEqual(blueprint);
  });

  it("round-trips 1024 external ports and refuses the next port without truncation", () => {
    const fixture = blueprintScaleFixture(createInitialState(), 2, 1);
    const blueprint = createBlueprint(fixture.state, fixture.entityIds).blueprints.at(-1)!;
    blueprint.externalPorts = Array.from({ length: BLUEPRINT_EXCHANGE_MAX_EXTERNAL_PORTS }, (_, index) => ({
      key: `port_${index}`, entityKey: "node_1", direction: "input" as const,
      itemId: "iron_ingot" as const, offset: { x: index, y: 0 },
    }));
    expect(parseBlueprintExchange(serializeBlueprintExchange(blueprint)).blueprint?.externalPorts).toEqual(blueprint.externalPorts);
    expect(() => serializeBlueprintExchange({ ...blueprint, externalPorts: [...blueprint.externalPorts!, blueprint.externalPorts![0]] }))
      .toThrow(/接口数量/);
  });

  it("counts only the queue's installed station fleet and preserves partial funding", () => {
    const base = createInitialState();
    const blueprint = {
      id: "fleet_blueprint", name: "载具收尾", revision: 1,
      entities: [
        { key: "station", buildingId: "planetary_logistics_station" as const, offset: { x: 0, y: 0 }, machineCount: 1, stationDroneTarget: 3 },
        { key: "storage", buildingId: "storage_mk1" as const, offset: { x: 300, y: 0 }, machineCount: 1 },
      ], belts: [],
    };
    const source = { ...base, blueprints: [blueprint], construction: { ...base.construction, planetary_logistics_station: 1, storage_mk1: 1 }, portableFleet: { logistics_drone: 1, logistics_vessel: 0 } };
    const queued = queueBlueprint(source, blueprint.id, { x: 30_000, y: 30_000 });
    const pending = fundConstructionQueueEntry(queued, queued.constructionQueue[0].id);
    expect(pending.constructionQueue[0].status).toBe("waiting-fleet");
    const installed = pending.entities.find((row) => row.buildingId === "planetary_logistics_station")!;
    const withOtherStation = { ...pending, entities: [...pending.entities, { ...installed, id: "unrelated_station", stationDrones: 50 }] };
    expect(getConstructionQueueDetails(withOtherStation, pending.constructionQueue[0].id).fleet.find((row) => row.itemId === "logistics_drone")?.missing).toBe(2);
    const supplied = { ...withOtherStation, portableFleet: { logistics_drone: 2, logistics_vessel: 0 } };
    const finished = fundConstructionQueueEntry(supplied, pending.constructionQueue[0].id, "fleet");
    expect(finished.constructionQueue).toHaveLength(0);
    expect(finished.entities.find((row) => row.id === installed.id)?.stationDrones).toBe(3);
    expect(finished.entities.find((row) => row.id === "unrelated_station")?.stationDrones).toBe(50);
    expect(finished.portableFleet.logistics_drone).toBe(0);
    expect(installed.stationDrones).toBe(1);
  });

  it("preserves an existing blueprint larger than the new exchange limit when loading a save", () => {
    const fixture = blueprintScaleFixture(createInitialState(), 4_200, 8_300);
    const captured = createBlueprint(fixture.state, fixture.entityIds, "已有大蓝图");
    const blueprint = captured.blueprints.at(-1)!;
    const restored = migrateGame(JSON.parse(JSON.stringify(captured)))!;
    expect(restored).not.toBeNull();
    const loaded = restored.blueprints.find((row) => row.id === blueprint.id)!;
    expect(loaded.entities.map((row) => [row.key, row.buildingId, row.offset, row.machineCount]))
      .toEqual(blueprint.entities.map((row) => [row.key, row.buildingId, row.offset, row.machineCount]));
    expect(loaded.belts.map((row) => [row.key, row.sourceKey, row.targetKey, row.itemId, row.lanes]))
      .toEqual(blueprint.belts.map((row) => [row.key, row.sourceKey, row.targetKey, row.itemId, row.lanes]));
    expect(() => serializeBlueprintExchange(loaded)).toThrow(/设备或线路数量/);
  });
});
