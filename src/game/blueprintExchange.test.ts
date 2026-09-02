import { describe, expect, it } from "vitest";
import { MAX_BELT_LANES, MAX_BUILDING_STACK_COUNT, createBlueprint, createInitialState, installMiner, placeBlueprint, placeBuilding, setLogisticsItem, setStationHubConfiguration, setStationSlotRoutePolicy, setStationSlotWarperBudget, setStationWarperAutoRefill, setStationWarperTarget } from "./engine";
import {
  BLUEPRINT_EXCHANGE_MAX_BELTS,
  BLUEPRINT_EXCHANGE_MAX_BYTES,
  BLUEPRINT_EXCHANGE_MAX_ENTITIES,
  BLUEPRINT_LIBRARY_MAX_ROWS,
  importBlueprintExchange,
  parseBlueprintExchange,
  serializeBlueprintExchange,
} from "./blueprintExchange";
import type { BlueprintDefinition, GameState } from "./types";

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
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error(imported.reason);
    expect(imported.state.blueprints).toHaveLength(2);
    expect(imported.state.blueprints[1]).toMatchObject({ name: "交换测试 2", entities: [{ buildingId: "arc_smelter" }] });
    expect(imported.state.blueprints[1].id).not.toBe(original.id);
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

  it("rejects duplicate JSON fields, malformed exportedAt values, and v1 anchors that would be discarded", () => {
    expect(parseBlueprintExchange('{"type":"dsp-idle-blueprint","type":"other","formatVersion":2,"blueprint":{}}').issues)
      .toEqual(["蓝图文件包含重复的 JSON 字段"]);
    expect(parseBlueprintExchange(JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      exportedAt: "2026-09-01T00:00:00Z",
      blueprint: { name: "时间", entities: [{ key: "node_1", buildingId: "storage_mk1", offset: { x: 0, y: 0 }, machineCount: 1 }], belts: [] },
    })).issues).toEqual(["蓝图文件 exportedAt 必须是精确的 UTC ISO 时间"]);
    expect(parseBlueprintExchange(JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 1,
      blueprint: {
        name: "旧锚点",
        entities: [],
        resourceAnchors: [{ key: "resource_1", resourceId: "iron_ore", extractorBuildingId: "mining_machine", offset: { x: 0, y: 0 }, minerCount: 1 }],
        belts: [],
      },
    })).issues).toEqual(["v1 蓝图不能包含资源锚点"]);
  });

  it("accepts the shared 512 entity and 1024 belt boundary and rejects the next row", () => {
    const entities = Array.from({ length: BLUEPRINT_EXCHANGE_MAX_ENTITIES }, (_, index) => ({
      key: `node_${index + 1}`,
      buildingId: "storage_mk1",
      offset: { x: index, y: 0 },
      machineCount: 1,
    }));
    const belts = Array.from({ length: BLUEPRINT_EXCHANGE_MAX_BELTS }, (_, index) => ({
      key: `line_${index + 1}`,
      sourceKey: `node_${index % BLUEPRINT_EXCHANGE_MAX_ENTITIES + 1}`,
      targetKey: `node_${(index + 1) % BLUEPRINT_EXCHANGE_MAX_ENTITIES + 1}`,
      itemId: "iron_ingot",
      lanes: 1,
      tier: 1,
      priority: 0,
    }));
    const envelope = {
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      blueprint: { name: "边界蓝图", entities, belts },
    };

    expect(parseBlueprintExchange(JSON.stringify(envelope)).valid).toBe(true);
    expect(parseBlueprintExchange(JSON.stringify({
      ...envelope,
      blueprint: { ...envelope.blueprint, entities: [...entities, entities[0]] },
    })).issues[0]).toContain("数量");
    expect(parseBlueprintExchange(JSON.stringify({
      ...envelope,
      blueprint: { ...envelope.blueprint, belts: [...belts, belts[0]] },
    })).issues[0]).toContain("数量");

    const blueprint: BlueprintDefinition = {
      id: "blueprint_boundary",
      name: "边界蓝图",
      entities: entities as BlueprintDefinition["entities"],
      belts: belts.map((belt) => ({ ...belt, sorterTier: belt.tier })) as BlueprintDefinition["belts"],
      recipeOverrides: {},
    };
    expect(parseBlueprintExchange(serializeBlueprintExchange(blueprint)).valid).toBe(true);
    expect(() => serializeBlueprintExchange({ ...blueprint, entities: [...blueprint.entities, blueprint.entities[0]] }))
      .toThrow(/设备或线路数量/);
    expect(() => serializeBlueprintExchange({ ...blueprint, belts: [...blueprint.belts, blueprint.belts[0]] }))
      .toThrow(/设备或线路数量/);
  });

  it("preflights an oversized array before reading or cloning its entries", () => {
    const entities: BlueprintDefinition["entities"] = [];
    entities.length = BLUEPRINT_EXCHANGE_MAX_ENTITIES + 1;
    Object.defineProperty(entities, 0, { get: () => { throw new Error("entry was accessed"); } });
    expect(() => serializeBlueprintExchange({
      id: "blueprint_oversized",
      name: "超限",
      entities,
      belts: [],
      recipeOverrides: {},
    })).toThrow(/设备或线路数量/);
  });

  it("serializes only canonical fields and rejects invalid names before stringifying", () => {
    const blueprint = {
      id: "blueprint_canonical",
      name: "x".repeat(48),
      entities: [{ key: "node_1", buildingId: "storage_mk1", offset: { x: 0, y: 0 }, machineCount: 1, unknownRuntimeCache: { cyclic: null } }],
      belts: [],
      recipeOverrides: {},
      unknownRootCache: "must-not-export",
    } as unknown as BlueprintDefinition & { unknownRootCache: string };
    (blueprint.entities[0] as unknown as { unknownRuntimeCache: { cyclic: unknown } }).unknownRuntimeCache.cyclic = blueprint;
    const raw = serializeBlueprintExchange(blueprint);
    expect(raw).not.toContain("unknownRootCache");
    expect(raw).not.toContain("unknownRuntimeCache");
    expect(parseBlueprintExchange(raw).valid).toBe(true);
    expect(() => serializeBlueprintExchange({ ...blueprint, name: "x".repeat(49) })).toThrow(/48/);
    expect(() => serializeBlueprintExchange({ ...blueprint, name: "bad\ud800" })).toThrow(/Unicode/);
  });

  it("enforces the one MiB UTF-8 boundary and rejects lone UTF-16 surrogates", () => {
    const compact = JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      blueprint: {
        name: "字节边界",
        entities: [{ key: "node_1", buildingId: "storage_mk1", offset: { x: 0, y: 0 }, machineCount: 1 }],
        belts: [],
      },
    });
    const exact = `${compact}${" ".repeat(
      BLUEPRINT_EXCHANGE_MAX_BYTES - new TextEncoder().encode(compact).byteLength,
    )}`;
    expect(new TextEncoder().encode(exact)).toHaveLength(BLUEPRINT_EXCHANGE_MAX_BYTES);
    expect(parseBlueprintExchange(exact).valid).toBe(true);
    expect(parseBlueprintExchange(`${exact} `).issues).toEqual(["蓝图文件超过 1 MiB 安全上限"]);
    expect(parseBlueprintExchange(`${compact}\ud800`).issues).toEqual(["蓝图文件包含无效 Unicode 字符"]);
    expect(parseBlueprintExchange(JSON.stringify({
      type: "dsp-idle-blueprint",
      formatVersion: 2,
      blueprint: {
        name: "\ud800",
        entities: [{ key: "node_1", buildingId: "storage_mk1", offset: { x: 0, y: 0 }, machineCount: 1 }],
        belts: [],
      },
    })).valid).toBe(false);
  });

  it("refuses a full 64-row library without evicting data or advancing the allocator", () => {
    let state = createInitialState();
    state = placeBuilding(state, "arc_smelter", { x: 120, y: 80 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = createBlueprint(state, [smelter.id], "容量蓝图");
    const source = state.blueprints[0];
    state = {
      ...state,
      nextId: 10_000,
      blueprints: Array.from({ length: BLUEPRINT_LIBRARY_MAX_ROWS }, (_, index) => ({
        ...source,
        id: `blueprint_full_${index}`,
        name: `容量蓝图 ${index}`,
      })),
    };
    const before = JSON.stringify(state);
    const result = importBlueprintExchange(state, source);
    expect(result).toEqual({ ok: false, reason: "library-full" });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("terminates long-name collision suffixes without splitting a surrogate pair", () => {
    let state = createInitialState();
    state = placeBuilding(state, "arc_smelter", { x: 120, y: 80 });
    const smelter = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = createBlueprint(state, [smelter.id], "来源");
    const source = { ...state.blueprints[0], name: `${"x".repeat(46)}😀` };
    state = {
      ...state,
      nextId: 5_000,
      blueprints: [
        { ...source, id: "blueprint_existing_1" },
        { ...source, id: "blueprint_existing_2", name: `${"x".repeat(46)} 2` },
      ],
    };
    const imported = importBlueprintExchange(state, source);
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error(imported.reason);
    expect(imported.state.blueprints).toHaveLength(3);
    expect(imported.state.blueprints[2].name).toBe(`${"x".repeat(46)} 3`);
    expect(imported.state.blueprints[2].name.length).toBeLessThanOrEqual(48);
    expect(imported.state.blueprints[2].name).not.toContain("�");
  });

  it.each([
    ["entity id", (state: GameState, id: string) => { state.entities[0].id = id; }],
    ["belt id", (state: GameState, id: string) => { state.belts.push({ id, source: state.entities[0].id, target: state.entities[1].id, itemId: "iron_ingot", lanes: 1, tier: 1, sorterTier: 1, priority: 0, progress: 0, lastFlow: 0, planetId: state.activePlanetId }); }],
    ["version id", (state: GameState, id: string) => { state.blueprintVersions.push({ id, blueprintId: "other_blueprint", revision: 1, definition: state.blueprints[0] }); }],
    ["version blueprintId", (state: GameState, id: string) => { state.blueprintVersions.push({ id: "blueprint_version_other", blueprintId: id, revision: 1, definition: state.blueprints[0] }); }],
    ["queue id", (state: GameState, id: string) => { state.constructionQueue.push({ id, blueprintId: "other_blueprint", blueprintName: "排队", planetId: state.activePlanetId, position: { x: 0, y: 0 }, rotation: 0, mirror: "none", queuedAt: 0 }); }],
    ["queue blueprintId", (state: GameState, id: string) => { state.constructionQueue.push({ id: "construction_other", blueprintId: id, blueprintName: "排队", planetId: state.activePlanetId, position: { x: 0, y: 0 }, rotation: 0, mirror: "none", queuedAt: 0 }); }],
  ])("rejects allocator collision with %s without mutating state", (_label, collide) => {
    let state = createInitialState();
    state = placeBuilding(state, "arc_smelter", { x: 120, y: 80 });
    state = placeBuilding(state, "storage_mk1", { x: 420, y: 80 });
    const sourceEntity = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = createBlueprint(state, [sourceEntity.id], "冲突来源");
    state.nextId = 50_000;
    const importedId = `blueprint_${state.nextId}`;
    collide(state, importedId);
    const before = JSON.stringify(state);
    expect(importBlueprintExchange(state, state.blueprints[0])).toEqual({ ok: false, reason: "id-collision" });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("reports invalid and exhausted allocators without advancing nextId or the library", () => {
    let state = createInitialState();
    state = placeBuilding(state, "arc_smelter", { x: 120, y: 80 });
    const sourceEntity = state.entities.find((entity) => entity.buildingId === "arc_smelter")!;
    state = createBlueprint(state, [sourceEntity.id], "分配来源");
    const blueprint = state.blueprints[0];

    for (const [nextId, reason] of [[Number.NaN, "invalid-next-id"], [-1, "invalid-next-id"], [Number.MAX_SAFE_INTEGER, "allocator-exhausted"]] as const) {
      const candidate = { ...state, nextId };
      const beforeBlueprints = candidate.blueprints;
      expect(importBlueprintExchange(candidate, blueprint)).toEqual({ ok: false, reason });
      expect(candidate.nextId).toBe(nextId);
      expect(candidate.blueprints).toBe(beforeBlueprints);
    }
  });
});
