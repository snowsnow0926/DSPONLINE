import { describe, expect, it, vi } from "vitest";
import {
  createNativeProjectedOrdinaryBuildingPlacementCommand,
  readVerifiedNativeConstructionPlacementContext,
  type NativeConstructionPlacementContext,
  type NativeConstructionPlacementIdentity,
} from "./nativeConstructionPlacement";

const identity: NativeConstructionPlacementIdentity = Object.freeze({
  sessionId: "session-placement",
  runId: "run-placement",
  revision: 41,
  registryFingerprint: "builtin-v47",
});

function placementContext(
  overrides: Partial<NativeConstructionPlacementContext> = {},
): NativeConstructionPlacementContext {
  return {
    schemaVersion: 1,
    projectionType: "construction-placement-context-v1",
    source: "native-core",
    revision: 41,
    stateVersion: 47,
    registryFingerprint: "builtin-v47",
    request: {
      expectedRevision: 41,
      expectedRegistryFingerprint: "builtin-v47",
      buildingId: "arc_smelter",
    },
    activePlanetId: "planet-mediterranean",
    available: 7,
    appendEntityIndex: 93,
    nextEntityId: "entity_104",
    support: { supported: true, reason: null },
    placement: {
      remainingConstruction: 6,
      nextIdAfterPlacement: 105,
      entityTemplate: {
        id: "entity_104",
        kind: "machine",
        planetId: "planet-mediterranean",
        interactionLocked: false,
        buildingId: "arc_smelter",
        powerGridId: "grid-a",
        powerPriority: 2,
        machineCount: 1,
        minerCount: 0,
        inputs: {},
        outputs: {},
        progress: 0,
        routingCursor: 0,
        utilization: 0,
        productionRate: 0,
        recipeId: "iron_ingot",
      },
    },
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

describe("native construction placement boundary", () => {
  it("reads only an exact same-revision Rust placement capability", async () => {
    const value = placementContext();
    const reader = vi.fn(async () => value);
    const result = await readVerifiedNativeConstructionPlacementContext(
      { getNativeCoreConstructionPlacementContext: reader },
      identity,
      "arc_smelter",
    );

    expect(result).toBe(value);
    expect(reader).toHaveBeenCalledWith({
      sessionId: "session-placement",
      expectedRevision: 41,
      expectedRegistryFingerprint: "builtin-v47",
      buildingId: "arc_smelter",
    });
  });

  it("builds the exact atomic debit, next ID, and one appended entity", () => {
    const command = createNativeProjectedOrdinaryBuildingPlacementCommand(
      placementContext(),
      { x: 480.5, y: -128.25 },
    );

    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 41,
      topLevelChanges: [
        { path: ["construction", "arc_smelter"], operation: "set", value: 6 },
        { path: ["nextId"], operation: "set", value: 105 },
      ],
      changedEntities: [],
      addedEntities: [{
        index: 93,
        value: {
          ...placementContext().placement!.entityTemplate,
          position: { x: 480.5, y: -128.25 },
        },
      }],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("accepts canonical power and MOD templates without renderer defaults", async () => {
    const value = placementContext({
      request: {
        expectedRevision: 41,
        expectedRegistryFingerprint: "builtin-v47",
        buildingId: "mod:聚变供电塔",
      },
      nextEntityId: "entity_9007199254740989",
      placement: {
        remainingConstruction: 6,
        nextIdAfterPlacement: 9_007_199_254_740_990,
        entityTemplate: {
          id: "entity_9007199254740989",
          kind: "power",
          planetId: "planet-mediterranean",
          interactionLocked: false,
          buildingId: "mod:聚变供电塔",
          powerGridId: "grid-a",
          powerPriority: 2,
          machineCount: 1,
          minerCount: 0,
          inputs: {},
          outputs: {},
          progress: 0,
          routingCursor: 0,
          utilization: 0,
          productionRate: 0,
          generationPriority: 1,
          powerOutputKw: 0,
          powerInputKw: 0,
          fuelRemainingMj: 0,
        },
      },
    });
    const result = await readVerifiedNativeConstructionPlacementContext(
      { getNativeCoreConstructionPlacementContext: async () => value },
      identity,
      "mod:聚变供电塔",
    );
    expect(result).toBe(value);
  });

  it("preserves an explicit unsupported reason without constructing a command", async () => {
    const value = placementContext({
      support: { supported: false, reason: "unsupported-building-domain" },
      placement: null,
    });
    const result = await readVerifiedNativeConstructionPlacementContext(
      { getNativeCoreConstructionPlacementContext: async () => value },
      identity,
      "arc_smelter",
    );
    expect(result).toBe(value);
    expect(createNativeProjectedOrdinaryBuildingPlacementCommand(value, { x: 1, y: 2 })).toBeNull();
  });

  it.each([
    ["stale revision", placementContext({ revision: 40 })],
    ["wrong echoed building", placementContext({
      request: {
        expectedRevision: 41,
        expectedRegistryFingerprint: "builtin-v47",
        buildingId: "assembling_machine_mk1",
      },
    })],
    ["invented template field", placementContext({
      placement: {
        remainingConstruction: 6,
        nextIdAfterPlacement: 105,
        entityTemplate: {
          ...placementContext().placement!.entityTemplate,
          hiddenInventory: { iron_ore: 1 },
        },
      },
    })],
    ["template position controlled by host", placementContext({
      placement: {
        remainingConstruction: 6,
        nextIdAfterPlacement: 105,
        entityTemplate: {
          ...placementContext().placement!.entityTemplate,
          position: { x: 1, y: 2 },
        },
      },
    })],
    ["incorrect debit", placementContext({
      placement: {
        ...placementContext().placement!,
        remainingConstruction: 5,
      },
    })],
  ])("fails closed for %s", async (_label, value) => {
    expect(await readVerifiedNativeConstructionPlacementContext(
      { getNativeCoreConstructionPlacementContext: async () => value },
      identity,
      "arc_smelter",
    )).toBeNull();
  });

  it.each([
    { x: Number.NaN, y: 0 },
    { x: 0, y: Number.POSITIVE_INFINITY },
  ])("rejects non-finite renderer coordinates: %j", (position) => {
    expect(createNativeProjectedOrdinaryBuildingPlacementCommand(
      placementContext(),
      position,
    )).toBeNull();
  });
});
