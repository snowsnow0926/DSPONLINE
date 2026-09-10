import { describe, expect, it } from "vitest";
import { createNativeProjectedLogisticsItemCommand, getNativeProjectedLogisticsItemConfiguration } from "./nativeProjectedLogisticsItemCommands";
import type { NativeProjectedEntityRecipeBinding } from "./nativeProjectedEntityRecipeCommands";

function binding(): NativeProjectedEntityRecipeBinding {
  return { sessionId: "s", runId: "r", revision: 8, registryFingerprint: "7df8cf3a", activePlanetId: "home",
    entity: { id: "storage", planetId: "home", kind: "storage", buildingId: "storage_mk1",
      position: { x: 0, y: 0 }, machineCount: 1, minerCount: 0, inputs: {}, outputs: {},
      progress: 0, utilization: 0, productionRate: 0, interactionLocked: false, routingCursor: 0 } };
}

describe("native logistics selection", () => {
  it("only offers compatible items and leaves refunds to Rust", () => {
    const value = binding();
    const choices = getNativeProjectedLogisticsItemConfiguration(value)!.options.map(item => item.id);
    expect(choices).toContain("iron_ingot");
    expect(choices).toContain("electromagnetic_matrix");
    expect(choices).not.toContain("water");
    expect(createNativeProjectedLogisticsItemCommand(value, "iron_ingot")).toEqual({
      protocolVersion: 1, baseRevision: 8,
      topLevelChanges: [{ path: ["entityLogisticsItem", "intent"], operation: "set",
        value: { entityId: "storage", targetItemId: "iron_ingot" } }],
      changedEntities: [], addedEntities: [], removedEntityIds: [], changedBelts: [], addedBelts: [], removedBeltIds: [],
    });
    value.entity.storedItemId = "iron_ingot";
    expect(createNativeProjectedLogisticsItemCommand(value, "iron_ingot")).toBeNull();
    expect(() => createNativeProjectedLogisticsItemCommand(value, "water")).toThrow();
  });

  it("filters tanks, and rejects stale, foreign, locked or unsupported projections", () => {
    const tank = binding();
    tank.entity.buildingId = "storage_tank";
    const choices = getNativeProjectedLogisticsItemConfiguration(tank)!.options.map(item => item.id);
    expect(choices).toContain("water");
    expect(choices).not.toContain("iron_ingot");
    for (const change of [
      (value: NativeProjectedEntityRecipeBinding) => ({ ...value, revision: -1 }),
      (value: NativeProjectedEntityRecipeBinding) => ({ ...value, registryFingerprint: "custom" }),
      (value: NativeProjectedEntityRecipeBinding) => ({ ...value, activePlanetId: "ashen" as const }),
      (value: NativeProjectedEntityRecipeBinding) => ({ ...value, entity: { ...value.entity, interactionLocked: true } }),
      (value: NativeProjectedEntityRecipeBinding) => ({ ...value, entity: { ...value.entity, buildingId: "material_delivery_hub" as const } }),
    ]) expect(getNativeProjectedLogisticsItemConfiguration(change(binding()))).toBeNull();
  });
});
