import { describe, expect, it, vi } from "vitest";
import {
  createNativeProjectedOrdinaryBuildingRemovalCommand,
  readVerifiedNativeConstructionRemovalContext,
  type NativeConstructionRemovalContext,
  type NativeConstructionRemovalIdentity,
} from "./nativeConstructionRemoval";

const identity: NativeConstructionRemovalIdentity = Object.freeze({
  sessionId: "session-removal",
  runId: "run-removal",
  revision: 51,
  registryFingerprint: "builtin-v47",
});

function removalContext(
  overrides: Partial<NativeConstructionRemovalContext> = {},
): NativeConstructionRemovalContext {
  return {
    schemaVersion: 1,
    projectionType: "construction-removal-context-v1",
    source: "native-core",
    revision: 51,
    stateVersion: 47,
    registryFingerprint: "builtin-v47",
    request: {
      expectedRevision: 51,
      expectedRegistryFingerprint: "builtin-v47",
      entityId: "实体/MOD-一号",
    },
    activePlanetId: "planet-mediterranean",
    entityId: "实体/MOD-一号",
    buildingId: "mod:聚变供电塔",
    machineCount: 2,
    currentConstruction: 4,
    refundAfterRemoval: 6,
    support: { supported: true, reason: null },
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

describe("native construction removal boundary", () => {
  it("reads only an exact same-revision Rust removal capability", async () => {
    const value = removalContext();
    const reader = vi.fn(async () => value);
    const result = await readVerifiedNativeConstructionRemovalContext(
      { getNativeCoreConstructionRemovalContext: reader },
      identity,
      "实体/MOD-一号",
    );
    expect(result).toBe(value);
    expect(reader).toHaveBeenCalledWith({
      sessionId: "session-removal",
      expectedRevision: 51,
      expectedRegistryFingerprint: "builtin-v47",
      entityId: "实体/MOD-一号",
    });
  });

  it("builds the exact atomic refund and entity removal", () => {
    expect(createNativeProjectedOrdinaryBuildingRemovalCommand(removalContext())).toEqual({
      protocolVersion: 1,
      baseRevision: 51,
      topLevelChanges: [{
        path: ["construction", "mod:聚变供电塔"],
        operation: "set",
        value: 6,
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: ["实体/MOD-一号"],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("preserves explicit unsupported reasons without constructing a command", async () => {
    const value = removalContext({
      refundAfterRemoval: null,
      support: { supported: false, reason: "incident-belt" },
    });
    expect(await readVerifiedNativeConstructionRemovalContext(
      { getNativeCoreConstructionRemovalContext: async () => value },
      identity,
      "实体/MOD-一号",
    )).toBe(value);
    expect(createNativeProjectedOrdinaryBuildingRemovalCommand(value)).toBeNull();
  });

  it.each([
    ["stale revision", removalContext({ revision: 50 })],
    ["wrong echoed entity", removalContext({
      request: {
        expectedRevision: 51,
        expectedRegistryFingerprint: "builtin-v47",
        entityId: "other",
      },
    })],
    ["invented refund", removalContext({ refundAfterRemoval: 7 })],
    ["unknown reason", removalContext({
      refundAfterRemoval: null,
      support: { supported: false, reason: "invented" as never },
    })],
  ])("fails closed for %s", async (_label, value) => {
    expect(await readVerifiedNativeConstructionRemovalContext(
      { getNativeCoreConstructionRemovalContext: async () => value },
      identity,
      "实体/MOD-一号",
    )).toBeNull();
  });
});
