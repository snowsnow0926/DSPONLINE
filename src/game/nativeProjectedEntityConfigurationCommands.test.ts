import { describe, expect, it } from "vitest";
import type { FactoryEntity } from "./types";
import {
  createNativeProjectedEntityPowerPriorityCommand,
  createNativeProjectedSplitterDistributionModeCommand,
  getNativeProjectedPowerPriority,
  getNativeProjectedSplitterDistributionMode,
  type NativeProjectedEntityConfigurationBinding,
} from "./nativeProjectedEntityConfigurationCommands";

function entity(overrides: Partial<FactoryEntity> = {}): FactoryEntity {
  return {
    id: "smelter-a",
    kind: "machine",
    planetId: "home",
    position: { x: 1, y: 2 },
    interactionLocked: false,
    buildingId: "arc_smelter",
    recipeId: "iron_ingot",
    powerPriority: 2,
    routingCursor: 0,
    machineCount: 1,
    minerCount: 0,
    inputs: {},
    outputs: {},
    progress: 0,
    utilization: 0,
    productionRate: 0,
    ...overrides,
  };
}

function binding(overrides: Partial<NativeProjectedEntityConfigurationBinding> = {}): NativeProjectedEntityConfigurationBinding {
  return {
    sessionId: "session-a",
    runId: "run-a",
    revision: 73,
    activePlanetId: "home",
    entity: entity(),
    ...overrides,
  };
}

describe("native projected entity configuration commands", () => {
  it("builds only one exact power-priority leaf from the pinned Rust row", () => {
    expect(createNativeProjectedEntityPowerPriorityCommand(binding(), 3)).toEqual({
      protocolVersion: 1,
      baseRevision: 73,
      topLevelChanges: [],
      changedEntities: [{
        id: "smelter-a",
        changes: [{ path: ["powerPriority"], operation: "set", value: 3 }],
      }],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(createNativeProjectedEntityPowerPriorityCommand(binding(), 2)).toBeNull();
  });

  it("uses persisted defaults without emitting a redundant canonicalization command", () => {
    const legacyPower = binding({ entity: entity({ powerPriority: undefined }) });
    expect(getNativeProjectedPowerPriority(legacyPower)).toBe(2);
    expect(createNativeProjectedEntityPowerPriorityCommand(legacyPower, 2)).toBeNull();

    const legacySplitter = binding({
      entity: entity({
        id: "splitter-a",
        kind: "splitter",
        buildingId: "splitter_4way",
        recipeId: undefined,
        powerPriority: undefined,
        distributionMode: undefined,
      }),
    });
    expect(getNativeProjectedSplitterDistributionMode(legacySplitter)).toBe("balanced");
    expect(createNativeProjectedSplitterDistributionModeCommand(legacySplitter, "priority"))
      .toMatchObject({
        baseRevision: 73,
        changedEntities: [{
          id: "splitter-a",
          changes: [{ path: ["distributionMode"], operation: "set", value: "priority" }],
        }],
      });
  });

  it("fails closed for stale identity, locked/foreign rows, station and MOD targets", () => {
    const rows = [
      binding({ sessionId: "bad session" }),
      binding({ revision: -1 }),
      binding({ entity: entity({ interactionLocked: true }) }),
      binding({ entity: entity({ planetId: "ashen" }) }),
      binding({ entity: entity({ kind: "station", buildingId: "planetary_logistics_station" }) }),
      binding({ entity: entity({ buildingId: "MOD/custom-machine" as FactoryEntity["buildingId"] }) }),
      binding({ entity: entity({ powerPriority: 4 as 1 }) }),
    ];
    for (const row of rows) {
      expect(getNativeProjectedPowerPriority(row)).toBeNull();
      expect(() => createNativeProjectedEntityPowerPriorityCommand(row, 1)).toThrow(TypeError);
    }
    expect(() => createNativeProjectedEntityPowerPriorityCommand(binding(), 4 as 1)).toThrow(TypeError);
  });

  it("opens splitter mode only for a valid built-in splitter", () => {
    const splitter = binding({
      entity: entity({
        id: "splitter-a",
        kind: "splitter",
        buildingId: "splitter_4way",
        recipeId: undefined,
        distributionMode: "priority",
      }),
    });
    expect(getNativeProjectedSplitterDistributionMode(splitter)).toBe("priority");
    expect(createNativeProjectedSplitterDistributionModeCommand(splitter, "priority")).toBeNull();
    for (const unsupported of [
      binding(),
      binding({ entity: entity({ kind: "splitter", buildingId: "MOD/custom-splitter" as FactoryEntity["buildingId"] }) }),
      binding({ entity: entity({ kind: "splitter", buildingId: "splitter_4way", distributionMode: "random" as "balanced" }) }),
    ]) {
      expect(getNativeProjectedSplitterDistributionMode(unsupported)).toBeNull();
      expect(() => createNativeProjectedSplitterDistributionModeCommand(unsupported, "balanced"))
        .toThrow(TypeError);
    }
    expect(() => createNativeProjectedSplitterDistributionModeCommand(splitter, "random" as "balanced"))
      .toThrow(TypeError);
  });
});
