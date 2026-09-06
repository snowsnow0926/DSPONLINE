import { describe, expect, it } from "vitest";
import { MAX_BELT_LANES, MAX_BUILDING_STACK_COUNT, createBlueprint, createInitialState, installMiner, placeBlueprint, placeBuilding, setLogisticsItem, setStationHubConfiguration, setStationSlotRoutePolicy, setStationSlotWarperBudget, setStationWarperAutoRefill, setStationWarperTarget } from "./engine";
import { MAX_BLUEPRINT_EXCHANGE_BELTS, importBlueprintExchange, parseBlueprintExchange, serializeBlueprintExchange, validateBlueprintExchange } from "./blueprintExchange";

describe("blueprint exchange", () => {
  it("round-trips a valid blueprint and assigns a safe local id on import", () => {
    let state = createInitialState();
    state = placeBuilding(state, "arc_smelter", { x: 120, y: 80 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = createBlueprint(state, [smelter.id], "交换测试");
    const original = state.blueprints[0];

    const result = parseBlueprintExchange(serializeBlueprintExchange(original));
    expect(result.valid).toBe(true);
    const imported = importBlueprintExchange(state, result.blueprint!);
    expect(imported.blueprints).toHaveLength(2);
    expect(imported.blueprints[1]).toMatchObject({ name: "交换测试 2", entities: [{ buildingId: "arc_smelter" }] });
    expect(imported.blueprints[1].id).not.toBe(original.id);
  });

  it("round-trips high stack counts without truncating blueprint production", () => {
    const raw = JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      blueprint: {
        id: "high_stack",
        name: "高堆叠往返",
        entities: [
          { key: "node_1", buildingId: "ray_receiver", offset: { x: 0, y: 0 }, machineCount: 400_000 },
          { key: "node_2", buildingId: "storage_mk1", offset: { x: 240, y: 0 }, machineCount: 10_240 },
        ],
        belts: [{ key: "line_1", sourceKey: "node_1", targetKey: "node_2", itemId: "critical_photon", lanes: 1, tier: 3, priority: 0 }],
      },
    });
    const parsed = parseBlueprintExchange(raw);
    expect(parsed.valid).toBe(true);
    expect(parsed.blueprint?.entities.map((entity) => entity.machineCount)).toEqual([400_000, 10_240]);
    const reparsed = parseBlueprintExchange(serializeBlueprintExchange(parsed.blueprint!));
    expect(reparsed.valid).toBe(true);
    expect(reparsed.blueprint?.entities.map((entity) => entity.machineCount)).toEqual([400_000, 10_240]);
  });

  it("accepts exporter-sized blueprints beyond the legacy 512-line guard", () => {
    const belts = Array.from({ length: 513 }, (_, index) => ({
      key: `line_${index + 1}`,
      sourceKey: "node_1",
      targetKey: "node_2",
      itemId: "iron_ingot",
      lanes: 1,
      tier: 1,
      priority: 0,
    }));
    const parsed = parseBlueprintExchange(JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      blueprint: {
        name: "高线路数交换",
        entities: [
          { key: "node_1", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 1 },
          { key: "node_2", buildingId: "storage_mk1", offset: { x: 240, y: 0 }, machineCount: 1 },
        ],
        belts,
      },
    }));
    expect(MAX_BLUEPRINT_EXCHANGE_BELTS).toBeGreaterThan(513);
    expect(parsed.valid).toBe(true);
    expect(parsed.blueprint?.belts).toHaveLength(513);
  });

  it("reports the exchange belt budget when it is exceeded", () => {
    const result = validateBlueprintExchange({
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      blueprint: {
        name: "超限线路",
        entities: [{ key: "node_1", buildingId: "storage_mk1", offset: { x: 0, y: 0 }, machineCount: 1 }],
        belts: new Array(MAX_BLUEPRINT_EXCHANGE_BELTS + 1),
      },
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([expect.stringContaining(`超出允许上限 ${MAX_BLUEPRINT_EXCHANGE_BELTS}`)]);
  });

  it("reports an exact invalid machineCount once and suppresses dependent belt endpoint noise", () => {
    const result = parseBlueprintExchange(JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      blueprint: {
        name: "非法堆叠",
        entities: [
          { key: "node_bad", buildingId: "arc_smelter", offset: { x: 0, y: 0 }, machineCount: 100_000_001 },
          { key: "node_ok", buildingId: "storage_mk1", offset: { x: 200, y: 0 }, machineCount: 1 },
        ],
        belts: [{ key: "line_1", sourceKey: "node_bad", targetKey: "node_ok", itemId: "iron_ingot", lanes: 1, tier: 1, priority: 0 }],
      },
    }));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([expect.stringMatching(/machineCount=100000001.*1～100000000/)]);
  });

  it("reports the unsupported exchange format version explicitly", () => {
    const result = parseBlueprintExchange(JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 99,
      blueprint: {},
    }));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(["蓝图格式版本 formatVersion=99 不受支持，当前支持 v1～v2"]);
  });

  it("accepts the exact building and resource-anchor stack limit and preserves it on exchange round-trip", () => {
    const raw = JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      blueprint: {
        id: "stack_limit_boundary",
        name: "堆叠上限边界",
        entities: [{ key: "node_1", buildingId: "storage_mk1", offset: { x: 240, y: 0 }, machineCount: MAX_BUILDING_STACK_COUNT }],
        resourceAnchors: [{
          key: "resource_1",
          resourceId: "iron_ore",
          extractorBuildingId: "mining_machine",
          offset: { x: 0, y: 0 },
          minerCount: MAX_BUILDING_STACK_COUNT,
        }],
        belts: [],
      },
    });
    const parsed = parseBlueprintExchange(raw);
    expect(parsed.valid).toBe(true);
    expect(parsed.blueprint?.entities[0].machineCount).toBe(MAX_BUILDING_STACK_COUNT);
    expect(parsed.blueprint?.resourceAnchors?.[0].minerCount).toBe(MAX_BUILDING_STACK_COUNT);
    const roundTrip = parseBlueprintExchange(serializeBlueprintExchange(parsed.blueprint!));
    expect(roundTrip.valid).toBe(true);
    expect(roundTrip.blueprint?.entities[0].machineCount).toBe(MAX_BUILDING_STACK_COUNT);
    expect(roundTrip.blueprint?.resourceAnchors?.[0].minerCount).toBe(MAX_BUILDING_STACK_COUNT);
  });

  it("rejects exchange files that reference content missing from the active catalog", () => {
    const result = parseBlueprintExchange(JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 1,
      blueprint: {
        name: "损坏蓝图",
        entities: [{ key: "node_1", buildingId: "missing_machine", offset: { x: 0, y: 0 }, machineCount: 1 }],
        belts: [],
      },
    }));
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain("设备");
  });

  it("preserves relay hub and per-slot routing configuration", () => {
    let state = createInitialState();
    state.research.completedTechIds.push("interstellar_logistics", "space_warp");
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 120, y: 80 });
    const station = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    state = setLogisticsItem(state, station.id, "processor");
    state = setStationHubConfiguration(state, station.id, true, 2);
    state = setStationSlotRoutePolicy(state, station.id, 0, "relay-required");
    state = setStationSlotWarperBudget(state, station.id, 0, 3);
    state = setStationWarperTarget(state, station.id, 35);
    state = setStationWarperAutoRefill(state, station.id, true);
    state = createBlueprint(state, [station.id], "中转枢纽");

    const parsed = parseBlueprintExchange(serializeBlueprintExchange(state.blueprints[0]));
    expect(parsed.valid).toBe(true);
    expect(parsed.blueprint?.entities[0]).toMatchObject({
      stationHubEnabled: true,
      stationHubPriority: 2,
      stationWarperAutoRefill: true,
      stationWarperTarget: 35,
      stationSlots: expect.arrayContaining([expect.objectContaining({ itemId: "processor", routePolicy: "relay-required", warperBudget: 3 })]),
    });
  });

  it("round-trips Mk.II elevator mode and stable output-port assignments", () => {
    let state = createInitialState();
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 120, y: 80 });
    const station = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    station.stationTier = 2;
    station.stationOperationMode = "elevator";
    station.elevatorOutputItems = ["processor", null, "iron_ingot", null, null];
    state = createBlueprint(state, [station.id], "电梯站蓝图");
    const parsed = parseBlueprintExchange(serializeBlueprintExchange(state.blueprints[0]));
    expect(parsed.valid).toBe(true);
    expect(parsed.blueprint?.entities[0]).toMatchObject({ stationTier: 2, stationOperationMode: "elevator", elevatorOutputItems: ["processor", null, "iron_ingot", null, null] });
  });

  it("round-trips the planned quantum attachment state for Mk.II stations", () => {
    let state = createInitialState();
    state.construction.interstellar_logistics_station = 1;
    state = placeBuilding(state, "interstellar_logistics_station", { x: 120, y: 80 });
    const station = state.entities.find((entity) => entity.buildingId === "interstellar_logistics_station")!;
    station.stationTier = 2;
    station.quantumMode = "quantum";
    state = createBlueprint(state, [station.id], "量子站蓝图");
    const parsed = parseBlueprintExchange(serializeBlueprintExchange(state.blueprints[0]));
    expect(parsed.valid).toBe(true);
    expect(parsed.blueprint?.entities[0]).toMatchObject({ stationTier: 2, quantumTarget: true });
  });

  it("round-trips and applies the micro black hole deploy intent without copying runtime counters", () => {
    let state = createInitialState();
    state.construction.micro_black_hole_connector = 2;
    state = placeBuilding(state, "micro_black_hole_connector", { x: 120, y: 80 });
    const source = state.entities.find((entity) => entity.buildingId === "micro_black_hole_connector")!;
    source.blackHolePaused = false;
    source.blackHoleActivationConfirmed = true;
    source.blackHolePorts![0].totalDestroyed = "123";
    state = createBlueprint(state, [source.id], "自动黑洞");
    const raw = serializeBlueprintExchange(state.blueprints[0]);
    const parsed = parseBlueprintExchange(raw);
    expect(parsed.valid).toBe(true);
    expect(parsed.blueprint?.entities[0]).toMatchObject({ operationEnabledOnDeploy: true });

    state.construction.micro_black_hole_connector = 1;
    state = { ...state, blueprints: [parsed.blueprint!] };
    const deployed = placeBlueprint(state, parsed.blueprint!.id, { x: 600, y: 80 });
    const placed = deployed.entities.filter((entity) => entity.buildingId === "micro_black_hole_connector").at(-1)!;
    expect(placed.blackHolePaused).toBe(false);
    expect(placed.blackHoleActivationConfirmed).toBe(true);
    expect(placed.blackHolePorts?.[0].totalDestroyed).toBe("0");
  });

  it("round-trips v2 mining anchors and the raised belt-lane limit", () => {
    let state = createInitialState(10_607);
    state.construction.mining_machine = 2;
    state.construction.storage_mk1 = 1;
    const vein = state.entities.find((entity) => entity.id === "vein_iron")!;
    state = installMiner(state, vein.id, 2);
    state = placeBuilding(state, "storage_mk1", { x: vein.position.x + 280, y: vein.position.y });
    const storage = state.entities.find((entity) => entity.buildingId === "storage_mk1")!;
    state = createBlueprint(state, [vein.id, storage.id], "采矿锚点交换");
    state.blueprints[0].belts.push({
      key: "line_high_capacity",
      sourceKey: state.blueprints[0].resourceAnchors![0].key,
      targetKey: state.blueprints[0].entities[0].key,
      itemId: "iron_ore",
      lanes: MAX_BELT_LANES,
      tier: 3,
      sorterTier: 3,
      priority: 0,
    });

    const raw = serializeBlueprintExchange(state.blueprints[0]);
    expect(JSON.parse(raw).formatVersion).toBe(2);
    const parsed = parseBlueprintExchange(raw);
    expect(parsed.valid).toBe(true);
    expect(parsed.blueprint?.resourceAnchors).toEqual([expect.objectContaining({ resourceId: "iron_ore", minerCount: 2 })]);
    expect(parsed.blueprint?.belts[0].lanes).toBe(MAX_BELT_LANES);
  });

  it("keeps accepting legacy v1 exchange files without resource anchors", () => {
    let state = createInitialState(10_608);
    state = placeBuilding(state, "arc_smelter", { x: 120, y: 80 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = createBlueprint(state, [smelter.id], "旧版交换");
    const legacy = JSON.parse(serializeBlueprintExchange(state.blueprints[0]));
    legacy.formatVersion = 1;
    delete legacy.blueprint.resourceAnchors;
    const parsed = parseBlueprintExchange(JSON.stringify(legacy));
    expect(parsed.valid).toBe(true);
    expect(parsed.blueprint?.entities[0].buildingId).toBe("arc_smelter");
  });
});
