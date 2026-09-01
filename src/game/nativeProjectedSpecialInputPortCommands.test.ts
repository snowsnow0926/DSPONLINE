import { describe, expect, it } from "vitest";
import type { FactoryEntity } from "./types";
import type { NativeProjectedEntityConfigurationBinding } from "./nativeProjectedEntityConfigurationCommands";
import {
  createConfirmedNativeMaterialDeliverySlotCommand,
  createConfirmedNativeOrbitalCargoPortClearCommand,
  getNativeProjectedMaterialDeliveryConfiguration,
  getNativeProjectedOrbitalCargoConfiguration,
} from "./nativeProjectedSpecialInputPortCommands";

function entity(overrides: Partial<FactoryEntity> = {}): FactoryEntity {
  return {
    id: "delivery-a",
    kind: "storage",
    planetId: "home",
    position: { x: 1, y: 2 },
    interactionLocked: false,
    buildingId: "material_delivery_hub",
    machineCount: 1,
    minerCount: 0,
    inputs: { iron_ore: 7 },
    outputs: {},
    progress: 0,
    routingCursor: 0,
    utilization: 0,
    productionRate: 0,
    deliverySlots: [
      { itemId: "iron_ore", mode: "manual" },
      { itemId: null, mode: "auto" },
      { itemId: null, mode: "disabled" },
    ],
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

describe("native projected special input port commands", () => {
  it("builds one compact confirmed material-delivery marker", () => {
    expect(createConfirmedNativeMaterialDeliverySlotCommand(binding(), 0, "manual", "copper_ore"))
      .toEqual({
        protocolVersion: 1,
        baseRevision: 73,
        topLevelChanges: [],
        changedEntities: [{
          id: "delivery-a",
          changes: [{
            path: ["materialDeliverySlot", "intent"],
            operation: "set",
            value: { slotIndex: 0, mode: "manual", itemId: "copper_ore", confirmed: true },
          }],
        }],
        addedEntities: [],
        removedEntityIds: [],
        changedBelts: [],
        addedBelts: [],
        removedBeltIds: [],
      });
    expect(createConfirmedNativeMaterialDeliverySlotCommand(binding(), 0, "manual", "iron_ore"))
      .toBeNull();
  });

  it("builds one compact confirmed orbital clear marker", () => {
    const terminal = binding({
      entity: entity({
        id: "terminal-a",
        buildingId: "orbital_cargo_terminal",
        deliverySlots: undefined,
        orbitalCargoPortItems: ["iron_ore", null, "copper_ore", null],
      }),
    });
    expect(getNativeProjectedOrbitalCargoConfiguration(terminal)?.portItems)
      .toEqual(["iron_ore", null, "copper_ore", null]);
    expect(createConfirmedNativeOrbitalCargoPortClearCommand(terminal, 0)).toMatchObject({
      baseRevision: 73,
      changedEntities: [{
        id: "terminal-a",
        changes: [{
          path: ["orbitalCargoPort", "clearIntent"],
          operation: "set",
          value: { portIndex: 0, confirmed: true },
        }],
      }],
    });
    expect(createConfirmedNativeOrbitalCargoPortClearCommand(terminal, 1)).toBeNull();
  });

  it("fails closed for malformed, locked, foreign, MOD and illegal targets", () => {
    for (const unsupported of [
      binding({ sessionId: "bad session" }),
      binding({ revision: -1 }),
      binding({ entity: entity({ interactionLocked: true }) }),
      binding({ entity: entity({ planetId: "away" as FactoryEntity["planetId"] }) }),
      binding({ entity: entity({ buildingId: "MOD/delivery" as FactoryEntity["buildingId"] }) }),
      binding({ entity: entity({ deliverySlots: [{ itemId: "iron_ore", mode: "manual" }] }) }),
      binding({ entity: entity({ deliverySlots: [
        { itemId: null, mode: "manual" },
        { itemId: null, mode: "auto" },
        { itemId: null, mode: "disabled" },
      ] }) }),
    ]) {
      expect(getNativeProjectedMaterialDeliveryConfiguration(unsupported)).toBeNull();
      expect(() => createConfirmedNativeMaterialDeliverySlotCommand(unsupported, 0, "auto", null))
        .toThrow(TypeError);
    }
    expect(() => createConfirmedNativeMaterialDeliverySlotCommand(binding(), 3, "auto", null))
      .toThrow(TypeError);
    expect(() => createConfirmedNativeMaterialDeliverySlotCommand(binding(), 0, "manual", null))
      .toThrow(TypeError);
    expect(() => createConfirmedNativeMaterialDeliverySlotCommand(binding(), 0, "auto", "iron_ore"))
      .toThrow(TypeError);
  });

  it("rejects malformed terminal port arrays rather than publishing a partial view", () => {
    for (const ports of [
      ["iron_ore", null],
      ["iron_ore", null, "missing", null],
    ]) {
      const terminal = binding({
        entity: entity({
          buildingId: "orbital_cargo_terminal",
          deliverySlots: undefined,
          orbitalCargoPortItems: ports as FactoryEntity["orbitalCargoPortItems"],
        }),
      });
      expect(getNativeProjectedOrbitalCargoConfiguration(terminal)).toBeNull();
      expect(() => createConfirmedNativeOrbitalCargoPortClearCommand(terminal, 0)).toThrow(TypeError);
    }
  });
});
