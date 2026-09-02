import { describe, expect, it, vi } from "vitest";
import type { DesktopNativeCoreConstructionBeltPlacementContextResult } from "../desktop";
import {
  createNativeProjectedOrdinaryBeltPlacementCommand,
  readVerifiedNativeConstructionBeltPlacementContext,
  type NativeConstructionBeltPlacementIdentity,
} from "./nativeConstructionBeltPlacement";

const identity: NativeConstructionBeltPlacementIdentity = Object.freeze({
  sessionId: "session-belt-placement",
  runId: "run-belt-placement",
  revision: 73,
  registryFingerprint: "modded-v47-deadbeef",
});

function beltContext(
  overrides: Partial<DesktopNativeCoreConstructionBeltPlacementContextResult> = {},
): DesktopNativeCoreConstructionBeltPlacementContextResult {
  return {
    schemaVersion: 1,
    projectionType: "construction-belt-placement-context-v1",
    source: "native-core",
    revision: 73,
    stateVersion: 47,
    registryFingerprint: "modded-v47-deadbeef",
    request: {
      expectedRevision: 73,
      expectedRegistryFingerprint: "modded-v47-deadbeef",
      sourceId: "mod:机器/甲",
      targetId: "mod:仓库/乙",
      itemId: "mod:item/opaque-1",
      tier: 3,
      lanes: 64,
    },
    activePlanetId: "mod:planet/远星-1",
    constructionId: "conveyor_belt_mk3",
    available: 100,
    appendBeltIndex: 57,
    nextBeltId: "belt_304",
    support: { supported: true, reason: null },
    placement: {
      remainingConstruction: 36,
      nextIdAfterPlacement: 305,
      beltTemplate: {
        id: "belt_304",
        planetId: "mod:planet/远星-1",
        source: "mod:机器/甲",
        target: "mod:仓库/乙",
        itemId: "mod:item/opaque-1",
        lanes: 64,
        tier: 3,
        sorterTier: 3,
        progress: 0,
        priority: 1,
        stackSize: 4,
        monitorEnabled: false,
        totalTransferred: 0,
        congestion: 0,
        lastFlow: 0,
        routeMode: "auto",
      },
    },
    limits: { projectionBytes: 1_048_576 },
    ...overrides,
  };
}

describe("native ordinary belt placement boundary", () => {
  it("reads an exact same-revision context with opaque MOD endpoint and item IDs", async () => {
    const value = beltContext();
    const reader = vi.fn(async () => value);
    const result = await readVerifiedNativeConstructionBeltPlacementContext(
      { getNativeCoreConstructionBeltPlacementContext: reader },
      identity,
      {
        sourceId: "mod:机器/甲",
        targetId: "mod:仓库/乙",
        itemId: "mod:item/opaque-1",
        tier: 3,
        lanes: 64,
      },
    );

    expect(result).toBe(value);
    expect(reader).toHaveBeenCalledWith({
      sessionId: "session-belt-placement",
      expectedRevision: 73,
      expectedRegistryFingerprint: "modded-v47-deadbeef",
      sourceId: "mod:机器/甲",
      targetId: "mod:仓库/乙",
      itemId: "mod:item/opaque-1",
      tier: 3,
      lanes: 64,
    });
  });

  it("builds only the exact construction debit, next ID, and appended belt", () => {
    expect(createNativeProjectedOrdinaryBeltPlacementCommand(beltContext())).toEqual({
      protocolVersion: 1,
      baseRevision: 73,
      topLevelChanges: [
        { path: ["construction", "conveyor_belt_mk3"], operation: "set", value: 36 },
        { path: ["nextId"], operation: "set", value: 305 },
      ],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [{ index: 57, value: beltContext().placement!.beltTemplate }],
      removedBeltIds: [],
    });
  });

  it("preserves explicit unsupported results without constructing a command", async () => {
    const value = beltContext({
      constructionId: null,
      available: null,
      appendBeltIndex: null,
      nextBeltId: null,
      support: { supported: false, reason: "unsupported-belt-tier" },
      placement: null,
    });
    expect(await readVerifiedNativeConstructionBeltPlacementContext(
      { getNativeCoreConstructionBeltPlacementContext: async () => value },
      identity,
      value.request,
    )).toBe(value);
    expect(createNativeProjectedOrdinaryBeltPlacementCommand(value)).toBeNull();
  });

  it.each([
    ["stale revision", beltContext({ revision: 72 })],
    ["wrong echoed item", beltContext({
      request: { ...beltContext().request, itemId: "mod:item/other" },
    })],
    ["incorrect inventory debit", beltContext({
      placement: { ...beltContext().placement!, remainingConstruction: 35 },
    })],
    ["incorrect next ID", beltContext({
      placement: { ...beltContext().placement!, nextIdAfterPlacement: 306 },
    })],
    ["special port smuggling", beltContext({
      placement: {
        ...beltContext().placement!,
        beltTemplate: {
          ...beltContext().placement!.beltTemplate,
          targetPortIndex: 1,
        },
      } as DesktopNativeCoreConstructionBeltPlacementContextResult["placement"],
    })],
    ["manual route", beltContext({
      placement: {
        ...beltContext().placement!,
        beltTemplate: {
          ...beltContext().placement!.beltTemplate,
          routeMode: "manual",
        },
      } as unknown as DesktopNativeCoreConstructionBeltPlacementContextResult["placement"],
    })],
    ["invented flow", beltContext({
      placement: {
        ...beltContext().placement!,
        beltTemplate: {
          ...beltContext().placement!.beltTemplate,
          lastFlow: 1,
        },
      } as unknown as DesktopNativeCoreConstructionBeltPlacementContextResult["placement"],
    })],
  ])("fails closed for %s", async (_label, value) => {
    const request = beltContext().request;
    expect(await readVerifiedNativeConstructionBeltPlacementContext(
      { getNativeCoreConstructionBeltPlacementContext: async () => value },
      identity,
      request,
    )).toBeNull();
  });

  it.each([
    { tier: 4, lanes: 1 },
    { tier: 1, lanes: 0 },
    { tier: 1, lanes: 4097 },
  ])("does not admit unsupported renderer requests: %j", async ({ tier, lanes }) => {
    expect(await readVerifiedNativeConstructionBeltPlacementContext(
      { getNativeCoreConstructionBeltPlacementContext: async () => beltContext() },
      identity,
      {
        sourceId: "mod:机器/甲",
        targetId: "mod:仓库/乙",
        itemId: "mod:item/opaque-1",
        tier,
        lanes,
      },
    )).toBeNull();
  });
});
