import { describe, expect, it } from "vitest";

import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  NativeFactoryProjectionIdentity,
  NativeStationConfigurationReadModel,
  SelectedEntityReadModel,
} from "./factoryReadModels";
import {
  createNativeProjectedStationFleetAdjustmentCommand,
  createNativeProjectedStationScalarCommand,
  createNativeProjectedStationSlotItemCommand,
  createNativeProjectedStationSlotLimitsCommand,
  createNativeProjectedStationSlotMinimumLoadCommand,
  createNativeProjectedStationSlotModeCommand,
  createNativeProjectedStationSlotPriorityCommand,
  createNativeProjectedStationSlotRoutePolicyCommand,
  createNativeProjectedStationSlotWarperBudgetCommand,
  createNativeProjectedStationWarperInventoryAdjustmentCommand,
  selectNativeProjectedStationConfigurationBinding,
} from "./nativeProjectedStationConfigurationCommands";

const identity: NativeFactoryProjectionIdentity = {
  sessionId: "session-a",
  runId: "run-a",
  revision: 41,
  planetId: "home",
};

function configuration(type: "planetary" | "interstellar" = "interstellar"): NativeStationConfigurationReadModel {
  const interstellar = type === "interstellar";
  return {
    schema: "station-configuration-v1",
    registryFingerprint: "7df8cf3a",
    stationType: type,
    itemOptions: {
      rows: [
        { itemId: "copper_ore", name: "铜矿", kind: "solid" },
        { itemId: "iron_ore", name: "铁矿", kind: "solid" },
      ],
      totalCount: 2,
      truncated: false,
      limit: 128,
    },
    stationDrones: 5,
    stationVessels: interstellar ? 2 : null,
    stationWarpers: interstellar ? 1 : null,
    slots: Array.from({ length: 5 }, (_, slotIndex) => ({
      slotIndex,
      itemId: slotIndex === 2 ? "iron_ore" : null,
      localMode: slotIndex === 2 ? "supply" as const : "storage" as const,
      remoteMode: slotIndex === 2 ? "demand" as const : "storage" as const,
      minimumLoad: slotIndex === 2 ? 0.5 as const : 1 as const,
      minStock: slotIndex === 2 ? 20 : 0,
      maxStock: slotIndex === 2 ? 100 : 0,
      priority: slotIndex === 2 ? 2 as const : 1 as const,
      ...(interstellar ? { routePolicy: "relay-preferred" as const, warperBudget: 2 as const } : {}),
    })),
    spaceWarpUnlocked: true,
    stationWarpEnabled: interstellar ? true : null,
    stationWarperAutoRefill: interstellar ? false : null,
    stationWarperTarget: interstellar ? 25 : null,
    stationHubEnabled: interstellar ? false : null,
    stationHubPriority: interstellar ? 1 : null,
  };
}

function station(
  stationConfiguration: NativeStationConfigurationReadModel | null = configuration(),
  overrides: Partial<SelectedEntityReadModel> = {},
): SelectedEntityReadModel {
  return {
    entityId: "station-ils",
    planetId: "home",
    kind: "station",
    position: { x: 1, y: 2 },
    interactionLocked: false,
    buildingId: stationConfiguration?.stationType === "planetary"
      ? "planetary_logistics_station"
      : "interstellar_logistics_station",
    resourceId: null,
    recipeId: null,
    storedItemId: "iron_ore",
    fuelItemId: null,
    machineCount: 1,
    minerCount: 0,
    progress: 0,
    utilization: 1,
    productionRate: 0,
    powerFactor: 1,
    inputItems: { rows: [], totalCount: 0, truncated: false },
    outputItems: { rows: [], totalCount: 0, truncated: false },
    stationConfiguration,
    ...overrides,
  };
}

function models(entity = station(), modelIdentity = identity): {
  inspector: FactoryInspectorSummaryReadModel;
  selection: FactoryMultiSelectionSummaryReadModel;
} {
  return {
    inspector: {
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: modelIdentity.revision,
      activePlanetId: modelIdentity.planetId,
      entity,
      belt: null,
    },
    selection: {
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: modelIdentity.revision,
      activePlanetId: modelIdentity.planetId,
      projectionIdentity: modelIdentity,
      requestedEntityCount: 1,
      requestedBeltCount: 0,
      entityRows: { rows: [entity], totalCount: 1, truncated: false },
      beltRows: { rows: [], totalCount: 0, truncated: false },
    },
  };
}

describe("native projected station configuration commands", () => {
  it("selects one exact Rust row and emits only minimal semantic station leaves", () => {
    const binding = selectNativeProjectedStationConfigurationBinding({
      commandIdentity: identity,
      ...models(),
    })!;
    expect(binding.configuration.slots).toHaveLength(5);
    expect(createNativeProjectedStationSlotModeCommand(binding, 2, "remote", "supply")?.changedEntities)
      .toEqual([{ id: "station-ils", changes: [{
        path: ["stationSlotMode", "intent"],
        operation: "set",
        value: { slotIndex: 2, scope: "remote", mode: "supply" },
      }] }]);
    expect(createNativeProjectedStationSlotItemCommand(binding, 2, "copper_ore")?.changedEntities)
      .toEqual([{ id: "station-ils", changes: [{
        path: ["stationSlotItem", "intent"],
        operation: "set",
        value: { slotIndex: 2, itemId: "copper_ore" },
      }] }]);
    expect(createNativeProjectedStationSlotPriorityCommand(binding, 2, 0)?.changedEntities[0].changes)
      .toEqual([{ path: ["stationSlots", 2, "priority"], operation: "set", value: 0 }]);
    expect(createNativeProjectedStationSlotMinimumLoadCommand(binding, 2, 0.25)?.changedEntities[0].changes)
      .toEqual([
        { path: ["stationSlots", 2, "minimumLoad"], operation: "set", value: 0.25 },
        { path: ["stationMinimumLoad"], operation: "set", value: 0.25 },
      ]);
    expect(createNativeProjectedStationSlotMinimumLoadCommand(binding, 0, 0.25)?.changedEntities[0].changes)
      .toEqual([{ path: ["stationSlots", 0, "minimumLoad"], operation: "set", value: 0.25 }]);
    expect(createNativeProjectedStationSlotLimitsCommand(binding, 2, 90, 50)?.changedEntities[0].changes)
      .toEqual([
        { path: ["stationSlots", 2, "minStock"], operation: "set", value: 50 },
        { path: ["stationSlots", 2, "maxStock"], operation: "set", value: 50 },
      ]);
    expect(createNativeProjectedStationSlotRoutePolicyCommand(binding, 2, "relay-required")?.changedEntities[0].changes[0].path)
      .toEqual(["stationSlots", 2, "routePolicy"]);
    expect(createNativeProjectedStationSlotWarperBudgetCommand(binding, 2, 4)?.changedEntities[0].changes[0].value)
      .toBe(4);
    expect(createNativeProjectedStationScalarCommand(binding, { field: "stationHubEnabled", target: true })?.changedEntities)
      .toEqual([{ id: "station-ils", changes: [{ path: ["stationHubEnabled"], operation: "set", value: true }] }]);
  });

  it("returns no-op only for the projected current value and never emits material/route ledgers", () => {
    const binding = selectNativeProjectedStationConfigurationBinding({ commandIdentity: identity, ...models() })!;
    expect(createNativeProjectedStationSlotModeCommand(binding, 2, "local", "supply")).toBeNull();
    expect(createNativeProjectedStationSlotItemCommand(binding, 2, "iron_ore")).toBeNull();
    expect(createNativeProjectedStationSlotPriorityCommand(binding, 2, 2)).toBeNull();
    expect(createNativeProjectedStationScalarCommand(binding, { field: "stationWarpEnabled", target: true })).toBeNull();
    const command = createNativeProjectedStationScalarCommand(binding, { field: "stationWarperTarget", target: 50 })!;
    const encoded = JSON.stringify(command);
    expect(encoded).not.toContain("stationRoutes");
    expect(encoded).not.toContain("stationWarpers");
    expect(encoded).not.toContain("inputs");
    expect(encoded).not.toContain("outputs");
  });

  it("emits only bounded fleet and warper semantic markers from the Rust projection", () => {
    const binding = selectNativeProjectedStationConfigurationBinding({ commandIdentity: identity, ...models() })!;
    const drone = createNativeProjectedStationFleetAdjustmentCommand(binding, "drone", 10)!;
    expect(drone.changedEntities).toEqual([{
      id: "station-ils",
      changes: [{
        path: ["stationFleetTarget", "intent"],
        operation: "set",
        value: { kind: "drone", targetCount: 15 },
      }],
    }]);
    expect(createNativeProjectedStationFleetAdjustmentCommand(binding, "drone", -10)?.changedEntities[0].changes[0].value)
      .toEqual({ kind: "drone", targetCount: 0 });
    expect(createNativeProjectedStationFleetAdjustmentCommand(binding, "vessel", "capacity")?.changedEntities[0].changes[0].value)
      .toEqual({ kind: "vessel", targetCount: 10 });

    const warpers = createNativeProjectedStationWarperInventoryAdjustmentCommand(binding, 10)!;
    expect(warpers.changedEntities).toEqual([{
      id: "station-ils",
      changes: [{
        path: ["stationWarperInventory", "intent"],
        operation: "set",
        value: { delta: 10 },
      }],
    }]);
    expect(createNativeProjectedStationWarperInventoryAdjustmentCommand(binding, "zero")?.changedEntities[0].changes[0].value)
      .toEqual({ delta: -1 });
    expect(createNativeProjectedStationWarperInventoryAdjustmentCommand(binding, "capacity")?.changedEntities[0].changes[0].value)
      .toEqual({ delta: 49 });

    const nearCapacityConfiguration = {
      ...configuration(),
      stationDrones: 45,
      stationWarpers: 45,
    };
    const nearCapacityEntity = station(nearCapacityConfiguration);
    const nearCapacity = selectNativeProjectedStationConfigurationBinding({
      commandIdentity: identity,
      ...models(nearCapacityEntity),
    })!;
    expect(createNativeProjectedStationFleetAdjustmentCommand(nearCapacity, "drone", 10)?.changedEntities[0].changes[0].value)
      .toEqual({ kind: "drone", targetCount: 55 });
    expect(createNativeProjectedStationWarperInventoryAdjustmentCommand(nearCapacity, 10)?.changedEntities[0].changes[0].value)
      .toEqual({ delta: 10 });

    const encoded = JSON.stringify([drone, warpers]);
    expect(encoded).not.toContain("stationDrones");
    expect(encoded).not.toContain("stationVessels");
    expect(encoded).not.toContain("stationWarpers");
    expect(encoded).not.toContain("portableFleet");
    expect(encoded).not.toContain("space_warper");
  });

  it("fails without mutating the projected row and converges only from a newer ACK projection", () => {
    const projected = models();
    const binding = selectNativeProjectedStationConfigurationBinding({ commandIdentity: identity, ...projected })!;
    const before = JSON.stringify(projected);
    expect(() => createNativeProjectedStationFleetAdjustmentCommand(binding, "invalid" as "drone", 1))
      .toThrow(/舰队类型/);
    expect(() => createNativeProjectedStationWarperInventoryAdjustmentCommand(binding, 0 as 1))
      .toThrow(/数量调整/);
    expect(JSON.stringify(projected)).toBe(before);
    expect(createNativeProjectedStationFleetAdjustmentCommand(binding, "drone", 1)?.changedEntities[0].changes[0].value)
      .toEqual({ kind: "drone", targetCount: 6 });
    expect(binding.configuration.stationDrones).toBe(5);
    const itemIntent = createNativeProjectedStationSlotItemCommand(binding, 2, "copper_ore")!;
    expect(itemIntent.changedEntities[0]?.changes[0]?.value).toEqual({ slotIndex: 2, itemId: "copper_ore" });
    expect(binding.configuration.slots[2].itemId).toBe("iron_ore");

    const acknowledgedBase = configuration();
    const acknowledgedConfiguration = {
      ...acknowledgedBase,
      stationDrones: 6,
      slots: acknowledgedBase.slots.map((slot) => slot.slotIndex === 2
        ? { ...slot, itemId: "copper_ore" }
        : slot),
    };
    const acknowledgedIdentity = { ...identity, revision: 42 };
    const acknowledgedEntity = station(acknowledgedConfiguration);
    const acknowledged = selectNativeProjectedStationConfigurationBinding({
      commandIdentity: acknowledgedIdentity,
      ...models(acknowledgedEntity, acknowledgedIdentity),
    })!;
    expect(acknowledged.configuration.stationDrones).toBe(6);
    expect(acknowledged.configuration.slots[2].itemId).toBe("copper_ore");
    expect(createNativeProjectedStationFleetAdjustmentCommand(acknowledged, "drone", 1)?.changedEntities[0].changes[0].value)
      .toEqual({ kind: "drone", targetCount: 7 });
  });

  it("keeps PLS item/mode directions bounded and rejects ILS-only actions", () => {
    const projected = station(configuration("planetary"), {
      entityId: "station-pls",
      buildingId: "planetary_logistics_station",
    });
    const binding = selectNativeProjectedStationConfigurationBinding({
      commandIdentity: identity,
      ...models(projected),
    })!;
    expect(binding.configuration.stationDrones).toBe(5);
    expect(() => createNativeProjectedStationSlotRoutePolicyCommand(binding, 2, "direct")).toThrow(/行星物流站/);
    expect(() => createNativeProjectedStationScalarCommand(binding, { field: "stationHubEnabled", target: true }))
      .toThrow(/行星物流站/);
    expect(() => createNativeProjectedStationFleetAdjustmentCommand(binding, "vessel", 1))
      .toThrow(/运输船/);
    expect(() => createNativeProjectedStationWarperInventoryAdjustmentCommand(binding, 1))
      .toThrow(/站内翘曲器/);
  });

  it("fails closed for stale/session/run/planet/MOD/malformed/selection-drift rows", () => {
    const staleIdentities: NativeFactoryProjectionIdentity[] = [
      { ...identity, sessionId: "session-b" },
      { ...identity, runId: "run-b" },
      { ...identity, revision: 42 },
      { ...identity, planetId: "ashen" },
    ];
    for (const commandIdentity of staleIdentities) {
      expect(selectNativeProjectedStationConfigurationBinding({ commandIdentity, ...models() })).toBeNull();
    }
    expect(selectNativeProjectedStationConfigurationBinding({ commandIdentity: identity, ...models(station(null)) }))
      .toBeNull();
    const forgedModConfiguration = {
      ...configuration(),
      registryFingerprint: "MOD/forged",
    } as unknown as NativeStationConfigurationReadModel;
    expect(selectNativeProjectedStationConfigurationBinding({
      commandIdentity: identity,
      ...models(station(forgedModConfiguration)),
    })).toBeNull();
    const malformed = configuration();
    const shortSlots = { ...malformed, slots: malformed.slots.slice(0, 4) } as NativeStationConfigurationReadModel;
    expect(selectNativeProjectedStationConfigurationBinding({
      commandIdentity: identity,
      ...models(station(shortSlots)),
    })).toBeNull();
    const exact = models();
    const drift = {
      ...exact,
      selection: {
        ...exact.selection,
        entityRows: {
          rows: [station(configuration(), { entityId: "other-station" })],
          totalCount: 1,
          truncated: false,
        },
      },
    };
    expect(selectNativeProjectedStationConfigurationBinding({ commandIdentity: identity, ...drift })).toBeNull();
  });

  it("keeps a configured item outside a truncated page clearable but never reassignable", () => {
    const rows = Array.from({ length: 128 }, (_, index) => ({
      itemId: `item_${String(index).padStart(3, "0")}`,
      name: `物品 ${index}`,
      kind: "solid" as const,
    }));
    const base = configuration();
    const truncatedConfiguration: NativeStationConfigurationReadModel = {
      ...base,
      itemOptions: { rows, totalCount: 129, truncated: true, limit: 128 },
      slots: base.slots.map((slot) => slot.slotIndex === 2
        ? { ...slot, itemId: "zz_current" }
        : slot),
    };
    const binding = selectNativeProjectedStationConfigurationBinding({
      commandIdentity: identity,
      ...models(station(truncatedConfiguration)),
    })!;
    expect(createNativeProjectedStationSlotItemCommand(binding, 2, null)?.changedEntities[0]?.changes[0]?.value)
      .toEqual({ slotIndex: 2, itemId: null });
    expect(createNativeProjectedStationSlotItemCommand(binding, 2, "zz_current")).toBeNull();
    expect(() => createNativeProjectedStationSlotItemCommand(binding, 0, "zz_current"))
      .toThrow(/有界 Rust 目录/);
  });

  it("blocks locked, out-of-range and warp-tech-forged commands before IPC", () => {
    const lockedEntity = station(configuration(), { interactionLocked: true });
    const locked = selectNativeProjectedStationConfigurationBinding({
      commandIdentity: identity,
      ...models(lockedEntity),
    })!;
    expect(() => createNativeProjectedStationSlotPriorityCommand(locked, 2, 0)).toThrow(/不可写/);
    const projected = configuration();
    const noWarp = station({ ...projected, spaceWarpUnlocked: false });
    const binding = selectNativeProjectedStationConfigurationBinding({
      commandIdentity: identity,
      ...models(noWarp),
    })!;
    expect(() => createNativeProjectedStationScalarCommand(binding, {
      field: "stationWarperAutoRefill",
      target: true,
    })).toThrow(/科技/);
    expect(() => createNativeProjectedStationScalarCommand(binding, {
      field: "stationWarperTarget",
      target: 51,
    })).toThrow(/目标/);
    expect(() => createNativeProjectedStationWarperInventoryAdjustmentCommand(binding, 1))
      .toThrow(/科技/);
  });
});
