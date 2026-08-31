import { describe, expect, it } from "vitest";
import {
  createNativeProjectedEntityRecipeCommand,
  getNativeProjectedEntityRecipeConfiguration,
  type NativeProjectedEntityRecipeBinding,
} from "./nativeProjectedEntityRecipeCommands";
import type { FactoryEntity } from "./types";

function entity(overrides: Partial<FactoryEntity> = {}): FactoryEntity {
  return {
    id: "smelter-a",
    kind: "machine",
    planetId: "home",
    position: { x: 1, y: 2 },
    interactionLocked: false,
    buildingId: "arc_smelter",
    recipeId: "iron_ingot",
    routingCursor: 0,
    machineCount: 1,
    minerCount: 0,
    inputs: { iron_ore: 3 },
    outputs: { iron_ingot: 2 },
    progress: 0.5,
    utilization: 1,
    productionRate: 60,
    ...overrides,
  };
}

function binding(
  overrides: Partial<NativeProjectedEntityRecipeBinding> = {},
): NativeProjectedEntityRecipeBinding {
  return {
    sessionId: "session-a",
    runId: "run-a",
    revision: 73,
    registryFingerprint: "7df8cf3a",
    activePlanetId: "home",
    entity: entity(),
    ...overrides,
  };
}

describe("native projected entity recipe commands", () => {
  it("derives only the built-in recipe family and emits one exact semantic marker", () => {
    const configuration = getNativeProjectedEntityRecipeConfiguration(binding());
    expect(configuration?.currentRecipeId).toBe("iron_ingot");
    expect(configuration?.options.map((option) => option.recipeId)).toContain("copper_ingot");
    expect(configuration?.options.map((option) => option.recipeId)).not.toContain("circuit_board");
    expect(createNativeProjectedEntityRecipeCommand(binding(), "copper_ingot")).toEqual({
      protocolVersion: 1,
      baseRevision: 73,
      topLevelChanges: [{
        path: ["entityRecipe", "intent"],
        operation: "set",
        value: { entityId: "smelter-a", targetRecipeId: "copper_ingot" },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
    expect(createNativeProjectedEntityRecipeCommand(binding(), "iron_ingot")).toBeNull();
  });

  it("accepts built-in upgrade families but leaves technology authorization to Rust", () => {
    const upgraded = binding({
      entity: entity({ buildingId: "plane_smelter", recipeId: "iron_ingot" }),
    });
    expect(getNativeProjectedEntityRecipeConfiguration(upgraded)?.options
      .map((option) => option.recipeId)).toContain("diamond_from_kimberlite");
    expect(createNativeProjectedEntityRecipeCommand(upgraded, "diamond_from_kimberlite"))
      .toMatchObject({
        baseRevision: 73,
        topLevelChanges: [{
          value: { entityId: "smelter-a", targetRecipeId: "diamond_from_kimberlite" },
        }],
      });
  });

  it("fails closed for MOD, stale, locked, foreign, opaque-current and unsupported rows", () => {
    const unsupported = [
      binding({ registryFingerprint: "MOD/forged" }),
      binding({ sessionId: "bad session" }),
      binding({ revision: -1 }),
      binding({ entity: entity({ interactionLocked: true }) }),
      binding({ entity: entity({ planetId: "ashen" }) }),
      binding({ entity: entity({ kind: "power" }) }),
      binding({ entity: entity({ buildingId: "ray_receiver" }) }),
      binding({ entity: entity({ buildingId: "spray_coater", recipeId: undefined }) }),
      binding({ entity: entity({ buildingId: "MOD/custom-machine" as FactoryEntity["buildingId"] }) }),
      binding({ entity: entity({ recipeId: "MOD/custom-recipe" as FactoryEntity["recipeId"] }) }),
    ];
    for (const value of unsupported) {
      expect(getNativeProjectedEntityRecipeConfiguration(value)).toBeNull();
      expect(() => createNativeProjectedEntityRecipeCommand(value, "copper_ingot"))
        .toThrow(TypeError);
    }
    expect(() => createNativeProjectedEntityRecipeCommand(binding(), "circuit_board"))
      .toThrow(TypeError);
  });
});
