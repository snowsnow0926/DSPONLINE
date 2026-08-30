import { describe, expect, it } from "vitest";

import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  NativeFactoryProjectionIdentity,
  NativeStationConfigurationReadModel,
  SelectedEntityReadModel,
} from "./factoryReadModels";
import {
  createNativeProjectedStationScalarCommand,
  createNativeProjectedStationSlotLimitsCommand,
  createNativeProjectedStationSlotMinimumLoadCommand,
  createNativeProjectedStationSlotPriorityCommand,
  createNativeProjectedStationSlotRoutePolicyCommand,
  createNativeProjectedStationSlotWarperBudgetCommand,
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
    expect(createNativeProjectedStationSlotPriorityCommand(binding, 2, 2)).toBeNull();
    expect(createNativeProjectedStationScalarCommand(binding, { field: "stationWarpEnabled", target: true })).toBeNull();
    const command = createNativeProjectedStationScalarCommand(binding, { field: "stationWarperTarget", target: 50 })!;
    const encoded = JSON.stringify(command);
    expect(encoded).not.toContain("stationRoutes");
    expect(encoded).not.toContain("stationWarpers");
    expect(encoded).not.toContain("inputs");
    expect(encoded).not.toContain("outputs");
  });

  it("keeps PLS item/mode/fleet read-only and rejects ILS-only actions", () => {
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
  });
});
