import { describe, expect, it, vi } from "vitest";
import type { DesktopNativeCoreConstructionBeltRemovalContextResult } from "../desktop";
import {
  createNativeProjectedOrdinaryBeltRemovalCommand,
  readVerifiedNativeConstructionBeltRemovalContext,
  type NativeConstructionBeltRemovalIdentity,
} from "./nativeConstructionBeltRemoval";

const identity: NativeConstructionBeltRemovalIdentity = Object.freeze({
  sessionId: "session-belt-removal",
  runId: "run-belt-removal",
  revision: 74,
  registryFingerprint: "registry-belt-removal",
});

function context(
  overrides: Partial<DesktopNativeCoreConstructionBeltRemovalContextResult> = {},
): DesktopNativeCoreConstructionBeltRemovalContextResult {
  return {
    schemaVersion: 1,
    projectionType: "construction-belt-removal-context-v1",
    source: "native-core",
    revision: 74,
    stateVersion: 47,
    registryFingerprint: "registry-belt-removal",
    request: {
      expectedRevision: 74,
      expectedRegistryFingerprint: "registry-belt-removal",
      beltId: "mod:传送带/甲",
    },
    activePlanetId: "mod:行星/甲",
    beltId: "mod:传送带/甲",
    planetId: "mod:行星/甲",
    sourceId: "mod:矿机/甲",
    targetId: "mod:仓库/乙",
    tier: 2,
    lanes: 7,
    constructionId: "conveyor_belt_mk2",
    currentConstruction: 11,
    refundAfterRemoval: 18,
    support: { supported: true, reason: null },
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

describe("native ordinary belt removal", () => {
  it("reads exact opaque IDs at the current revision and builds one atomic refund", async () => {
    const value = context();
    const reader = vi.fn(async () => value);
    expect(await readVerifiedNativeConstructionBeltRemovalContext(
      { getNativeCoreConstructionBeltRemovalContext: reader },
      identity,
      { beltId: "mod:传送带/甲" },
    )).toBe(value);
    expect(reader).toHaveBeenCalledWith({
      sessionId: "session-belt-removal",
      expectedRevision: 74,
      expectedRegistryFingerprint: "registry-belt-removal",
      beltId: "mod:传送带/甲",
    });
    expect(createNativeProjectedOrdinaryBeltRemovalCommand(value)).toEqual({
      protocolVersion: 1,
      baseRevision: 74,
      topLevelChanges: [{
        path: ["construction", "conveyor_belt_mk2"],
        operation: "set",
        value: 18,
      }],
      changedEntities: [], addedEntities: [], removedEntityIds: [],
      changedBelts: [], addedBelts: [], removedBeltIds: ["mod:传送带/甲"],
    });
  });

  it.each([
    ["revision drift", context({ revision: 75 })],
    ["fingerprint drift", context({ registryFingerprint: "other" })],
    ["belt substitution", context({ beltId: "mod:传送带/乙" })],
    ["forged refund", context({ refundAfterRemoval: 19 })],
    ["forged material", context({ constructionId: "conveyor_belt_mk1" })],
    ["special smuggling", { ...context(), elevatorOutputIndex: 1 }],
  ])("rejects %s", async (_label, value) => {
    expect(await readVerifiedNativeConstructionBeltRemovalContext(
      { getNativeCoreConstructionBeltRemovalContext: async () => value },
      identity,
      { beltId: "mod:传送带/甲" },
    )).toBeNull();
    expect(createNativeProjectedOrdinaryBeltRemovalCommand(
      value as DesktopNativeCoreConstructionBeltRemovalContextResult,
    )).toBeNull();
  });

  it("preserves an unsupported proof but never builds a command", async () => {
    const value = context({
      support: { supported: false, reason: "unsupported-belt-domain" },
      refundAfterRemoval: null,
    });
    expect(await readVerifiedNativeConstructionBeltRemovalContext(
      { getNativeCoreConstructionBeltRemovalContext: async () => value },
      identity,
      { beltId: "mod:传送带/甲" },
    )).toBe(value);
    expect(createNativeProjectedOrdinaryBeltRemovalCommand(value)).toBeNull();
  });

  it.each(["", "bad\nline", "x".repeat(513)])("fails closed for invalid ID %j", async (beltId) => {
    const reader = vi.fn(async () => context());
    expect(await readVerifiedNativeConstructionBeltRemovalContext(
      { getNativeCoreConstructionBeltRemovalContext: reader }, identity, { beltId },
    )).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });
});
