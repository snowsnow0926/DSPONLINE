import { describe, expect, it } from "vitest";
import type { FactoryEntity } from "./types";
import {
  canNativeProjectedEnergyExchangerModeChange,
  createNativeProjectedEnergyExchangerModeCommand,
  createNativeProjectedEntityPowerPriorityCommand,
  createNativeProjectedSplitterDistributionModeCommand,
  getNativeProjectedEnergyExchangerMode,
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

  it("builds only one exchanger mode intent and leaves derived refunds to Rust", () => {
    const exchanger = binding({
      entity: entity({
        id: "exchanger-a",
        kind: "power",
        buildingId: "energy_exchanger",
        recipeId: "accumulator_charge",
        powerPriority: undefined,
        energyMode: "charge",
        storedEnergyMj: 0.0001,
        inputs: { accumulator: 2 },
        outputs: { charged_accumulator: 3 },
      }),
    });
    expect(getNativeProjectedEnergyExchangerMode(exchanger)).toBe("charge");
    expect(canNativeProjectedEnergyExchangerModeChange(exchanger)).toBe(true);
    expect(createNativeProjectedEnergyExchangerModeCommand(exchanger, "discharge")).toEqual({
      protocolVersion: 1,
      baseRevision: 73,
      topLevelChanges: [],
      changedEntities: [{
        id: "exchanger-a",
        changes: [{ path: ["energyMode"], operation: "set", value: "discharge" }],
      }],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(createNativeProjectedEnergyExchangerModeCommand(exchanger, "charge")).toBeNull();
  });

  it("fails closed for stored, malformed, locked, foreign and MOD exchanger rows", () => {
    const exchanger = (overrides: Partial<FactoryEntity> = {}) => binding({
      entity: entity({
        id: "exchanger-a",
        kind: "power",
        buildingId: "energy_exchanger",
        recipeId: "accumulator_charge",
        powerPriority: undefined,
        energyMode: "charge",
        storedEnergyMj: 0,
        ...overrides,
      }),
    });
    const stored = exchanger({ storedEnergyMj: 0.00011 });
    expect(getNativeProjectedEnergyExchangerMode(stored)).toBe("charge");
    expect(canNativeProjectedEnergyExchangerModeChange(stored)).toBe(false);
    expect(() => createNativeProjectedEnergyExchangerModeCommand(stored, "discharge"))
      .toThrow(TypeError);

    for (const unsupported of [
      exchanger({ interactionLocked: true }),
      exchanger({ planetId: "ashen" }),
      exchanger({ kind: "machine" }),
      exchanger({ buildingId: "MOD/energy-exchanger" as FactoryEntity["buildingId"] }),
      exchanger({ energyMode: "auto" }),
      exchanger({ energyMode: "invalid" as "charge" }),
      exchanger({ storedEnergyMj: Number.NaN }),
    ]) {
      if (unsupported.entity.storedEnergyMj !== undefined &&
          Number.isNaN(unsupported.entity.storedEnergyMj)) {
        expect(getNativeProjectedEnergyExchangerMode(unsupported)).toBe("charge");
      } else {
        expect(getNativeProjectedEnergyExchangerMode(unsupported)).toBeNull();
      }
      expect(canNativeProjectedEnergyExchangerModeChange(unsupported)).toBe(false);
      expect(() => createNativeProjectedEnergyExchangerModeCommand(unsupported, "discharge"))
        .toThrow(TypeError);
    }
    expect(() => createNativeProjectedEnergyExchangerModeCommand(exchanger(), "auto" as "charge"))
      .toThrow(TypeError);
  });
});
