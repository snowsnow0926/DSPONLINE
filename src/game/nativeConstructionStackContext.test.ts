import { describe, expect, it, vi } from "vitest";
import {
  createNativeProjectedOrdinaryBuildingStackCommand,
  readVerifiedNativeConstructionStackContext,
  type NativeConstructionStackContext,
  type NativeConstructionStackIdentity,
} from "./nativeConstructionStackContext";

const identity: NativeConstructionStackIdentity = Object.freeze({
  sessionId: "session-stack",
  runId: "run-stack",
  revision: 71,
  registryFingerprint: "builtin-v47",
});

function stackContext(
  overrides: Partial<NativeConstructionStackContext> = {},
): NativeConstructionStackContext {
  return {
    schemaVersion: 1,
    projectionType: "construction-stack-context-v1",
    source: "native-core",
    sessionId: "session-stack",
    revision: 71,
    stateVersion: 47,
    registryFingerprint: "builtin-v47",
    request: {
      sessionId: "session-stack",
      expectedRevision: 71,
      expectedRegistryFingerprint: "builtin-v47",
      entityId: "实体/MOD-一号",
      targetCount: 15,
    },
    activePlanetId: "planet-mediterranean",
    entityId: "实体/MOD-一号",
    buildingId: "mod:聚变供电塔",
    currentCount: 5,
    targetCount: 15,
    currentConstruction: 20,
    constructionAfter: 10,
    support: { supported: true, reason: null },
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

describe("native construction stack boundary", () => {
  it("reads only an exact same-session and same-revision Rust proof", async () => {
    const value = stackContext();
    const reader = vi.fn(async () => value);
    expect(await readVerifiedNativeConstructionStackContext(
      { getNativeCoreConstructionStackContext: reader }, identity, "实体/MOD-一号", 15,
    )).toBe(value);
    expect(reader).toHaveBeenCalledWith({
      sessionId: "session-stack",
      expectedRevision: 71,
      expectedRegistryFingerprint: "builtin-v47",
      entityId: "实体/MOD-一号",
      targetCount: 15,
    });
  });

  it("builds the exact atomic inventory debit and stack target", () => {
    expect(createNativeProjectedOrdinaryBuildingStackCommand(stackContext())).toEqual({
      protocolVersion: 1,
      baseRevision: 71,
      topLevelChanges: [{
        path: ["construction", "mod:聚变供电塔"],
        operation: "set",
        value: 10,
      }],
      changedEntities: [{
        id: "实体/MOD-一号",
        changes: [{ path: ["machineCount"], operation: "set", value: 15 }],
      }],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("preserves a safe historical-overlimit decrease and exact refund", () => {
    const value = stackContext({
      request: { ...stackContext().request, targetCount: 120_000_000 },
      currentCount: 150_000_000,
      targetCount: 120_000_000,
      currentConstruction: 3,
      constructionAfter: 30_000_003,
    });
    expect(createNativeProjectedOrdinaryBuildingStackCommand(value)?.changedEntities[0])
      .toEqual({
        id: "实体/MOD-一号",
        changes: [{ path: ["machineCount"], operation: "set", value: 120_000_000 }],
      });
  });

  it("returns explicit unsupported results but never builds their command", async () => {
    const value = stackContext({
      constructionAfter: null,
      support: { supported: false, reason: "catalog-incomplete" },
    });
    expect(await readVerifiedNativeConstructionStackContext(
      { getNativeCoreConstructionStackContext: async () => value },
      identity,
      "实体/MOD-一号",
      15,
    )).toBe(value);
    expect(createNativeProjectedOrdinaryBuildingStackCommand(value)).toBeNull();
  });

  it.each([
    ["wrong session", stackContext({ sessionId: "other-session" })],
    ["stale revision", stackContext({ revision: 70 })],
    ["wrong echoed target", stackContext({
      request: { ...stackContext().request, targetCount: 16 },
    })],
    ["invented debit", stackContext({ constructionAfter: 11 })],
    ["unknown reason", stackContext({
      constructionAfter: null,
      support: { supported: false, reason: "invented" as never },
    })],
  ])("fails closed for %s", async (_label, value) => {
    expect(await readVerifiedNativeConstructionStackContext(
      { getNativeCoreConstructionStackContext: async () => value },
      identity,
      "实体/MOD-一号",
      15,
    )).toBeNull();
  });

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not issue an invalid target %s",
    async (targetCount) => {
      const reader = vi.fn();
      expect(await readVerifiedNativeConstructionStackContext(
        { getNativeCoreConstructionStackContext: reader },
        identity,
        "实体/MOD-一号",
        targetCount,
      )).toBeNull();
      expect(reader).not.toHaveBeenCalled();
    },
  );
});
