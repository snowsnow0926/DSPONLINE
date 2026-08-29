import { describe, expect, it } from "vitest";
import type {
  FactoryInspectorSummaryReadModel,
  FactoryMultiSelectionSummaryReadModel,
  NativeFactoryProjectionIdentity,
  SelectedBeltReadModel,
} from "./factoryReadModels";
import { createNativeProjectedBeltPriorityCommand } from "./nativeProjectedBeltCommands";

const identity: NativeFactoryProjectionIdentity = {
  sessionId: "session-a",
  runId: "run-a",
  revision: 73,
  planetId: "planet-a",
};

const belt: SelectedBeltReadModel = {
  beltId: "MOD-线路/β",
  planetId: identity.planetId,
  sourceEntityId: "source-a",
  targetEntityId: "target-a",
  itemId: "MOD-物料/γ",
  lanes: 12,
  tier: 2,
  sorterTier: 2,
  stackSize: 4,
  priority: 1,
  progress: 0.25,
  lastFlow: 3,
  totalTransferred: 44,
  congestion: 0.125,
};

function models(): {
  inspector: FactoryInspectorSummaryReadModel;
  selection: FactoryMultiSelectionSummaryReadModel;
} {
  return {
    inspector: {
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: identity.revision,
      activePlanetId: identity.planetId,
      entity: null,
      belt: { ...belt },
    },
    selection: {
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: identity.revision,
      activePlanetId: identity.planetId,
      projectionIdentity: identity,
      requestedEntityCount: 0,
      requestedBeltCount: 1,
      entityRows: { rows: [], totalCount: 0, truncated: false },
      beltRows: { rows: [{ ...belt }], totalCount: 1, truncated: false },
    },
  };
}

describe("native projected belt commands", () => {
  it("builds only the exact priority leaf from matching native projections", () => {
    const command = createNativeProjectedBeltPriorityCommand({
      commandIdentity: identity,
      ...models(),
      targetPriority: 2,
    });
    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 73,
      topLevelChanges: [],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [{
        id: "MOD-线路/β",
        changes: [{ path: ["priority"], operation: "set", value: 2 }],
      }],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("returns null for an unchanged priority", () => {
    expect(createNativeProjectedBeltPriorityCommand({
      commandIdentity: identity,
      ...models(),
      targetPriority: 1,
    })).toBeNull();
  });

  it("fails closed for stale identity, selection mismatch, truncation, or forged rows", () => {
    const stale = models();
    stale.inspector = { ...stale.inspector, revision: 72 };
    const mismatched = models();
    mismatched.selection = {
      ...mismatched.selection,
      beltRows: {
        ...mismatched.selection.beltRows,
        rows: [{ ...belt, lanes: 13 }],
      },
    };
    const truncated = models();
    truncated.selection = {
      ...truncated.selection,
      beltRows: { ...truncated.selection.beltRows, truncated: true },
    };
    const invalidId = models();
    invalidId.inspector = {
      ...invalidId.inspector,
      belt: { ...belt, beltId: "bad\0id" },
    };
    for (const invalid of [stale, mismatched, truncated, invalidId]) {
      expect(() => createNativeProjectedBeltPriorityCommand({
        commandIdentity: identity,
        ...invalid,
        targetPriority: 0,
      })).toThrow(TypeError);
    }
    expect(() => createNativeProjectedBeltPriorityCommand({
      commandIdentity: identity,
      ...models(),
      targetPriority: 3 as 0,
    })).toThrow(TypeError);
  });
});
