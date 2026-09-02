import { describe, expect, it, vi } from "vitest";
import type { DesktopNativeCoreConstructionBeltLaneContextResult } from "../desktop";
import {
  createNativeProjectedOrdinaryBeltLaneCommand,
  readVerifiedNativeConstructionBeltLaneContext,
  type NativeConstructionBeltLaneIdentity,
} from "./nativeConstructionBeltLane";

const identity: NativeConstructionBeltLaneIdentity = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 17,
  registryFingerprint: "registry:test",
});

function context(
  overrides: Partial<DesktopNativeCoreConstructionBeltLaneContextResult> = {},
): DesktopNativeCoreConstructionBeltLaneContextResult {
  return {
    schemaVersion: 1,
    projectionType: "construction-belt-lane-context-v1",
    source: "native-core",
    revision: 17,
    stateVersion: 47,
    registryFingerprint: "registry:test",
    request: {
      expectedRevision: 17,
      expectedRegistryFingerprint: "registry:test",
      beltId: "MOD/线路-一",
      targetLanes: 6,
    },
    activePlanetId: "home",
    beltId: "MOD/线路-一",
    planetId: "home",
    sourceId: "MOD/源-一",
    targetId: "MOD/目标-二",
    itemId: "mod_item",
    tier: 1,
    currentLanes: 4,
    targetLanes: 6,
    constructionId: "conveyor_belt_mk1",
    currentConstruction: 7,
    laneDelta: 2,
    constructionAfterAdjustment: 5,
    support: { supported: true, reason: null },
    limits: { maxPlayerLanes: 4096, projectionBytes: 1_048_576 },
    ...overrides,
  };
}

describe("native ordinary belt lane context", () => {
  it("reads a fresh opaque-ID context and builds only the exact atomic command", async () => {
    const reader = vi.fn(async () => context());
    const value = await readVerifiedNativeConstructionBeltLaneContext(
      { getNativeCoreConstructionBeltLaneContext: reader },
      identity,
      { beltId: "MOD/线路-一", targetLanes: 6 },
    );
    expect(reader).toHaveBeenCalledWith({
      sessionId: "session-a",
      expectedRevision: 17,
      expectedRegistryFingerprint: "registry:test",
      beltId: "MOD/线路-一",
      targetLanes: 6,
    });
    expect(createNativeProjectedOrdinaryBeltLaneCommand(value!)).toEqual({
      protocolVersion: 1,
      baseRevision: 17,
      topLevelChanges: [{ path: ["construction", "conveyor_belt_mk1"], operation: "set", value: 5 }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [{ id: "MOD/线路-一", changes: [{ path: ["lanes"], operation: "set", value: 6 }] }],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("accepts an exact reduction and preserves refund arithmetic", async () => {
    const reduced = context({
      request: { ...context().request, targetLanes: 2 },
      targetLanes: 2,
      laneDelta: -2,
      constructionAfterAdjustment: 9,
    });
    const value = await readVerifiedNativeConstructionBeltLaneContext(
      { getNativeCoreConstructionBeltLaneContext: async () => reduced },
      identity,
      { beltId: "MOD/线路-一", targetLanes: 2 },
    );
    expect(value?.laneDelta).toBe(-2);
    expect(createNativeProjectedOrdinaryBeltLaneCommand(value!)?.topLevelChanges[0].value).toBe(9);
  });

  it.each([
    { revision: 18 },
    { registryFingerprint: "other" },
    { beltId: "forged" },
    { targetLanes: 7 },
    { laneDelta: 3 },
    { constructionAfterAdjustment: 6 },
    { constructionId: "conveyor_belt_mk2" as const },
    { limits: { maxPlayerLanes: 4095 as 4096, projectionBytes: 1_048_576 as const } },
  ])("rejects forged projection field %#", async (override) => {
    const value = context(override as Partial<DesktopNativeCoreConstructionBeltLaneContextResult>);
    expect(await readVerifiedNativeConstructionBeltLaneContext(
      { getNativeCoreConstructionBeltLaneContext: async () => value },
      identity,
      { beltId: "MOD/线路-一", targetLanes: 6 },
    )).toBeNull();
  });

  it("keeps unsupported responses non-authoritative", async () => {
    const unsupported = context({
      laneDelta: null,
      constructionAfterAdjustment: null,
      support: { supported: false, reason: "insufficient-construction" },
    });
    const value = await readVerifiedNativeConstructionBeltLaneContext(
      { getNativeCoreConstructionBeltLaneContext: async () => unsupported },
      identity,
      { beltId: "MOD/线路-一", targetLanes: 6 },
    );
    expect(value?.support.supported).toBe(false);
    expect(createNativeProjectedOrdinaryBeltLaneCommand(value!)).toBeNull();
  });
});
