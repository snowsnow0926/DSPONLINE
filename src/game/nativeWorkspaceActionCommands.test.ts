import { describe, expect, it } from "vitest";
import { createNativeWorkspaceActionCommand } from "./nativeWorkspaceActionCommands";

describe("native workspace action commands", () => {
  it("encodes only the bounded semantic intent", () => {
    expect(createNativeWorkspaceActionCommand(41, {
      kind: "quantum-attach",
      entityIds: ["station-b", "station-a"],
    })).toEqual({
      protocolVersion: 1,
      baseRevision: 41,
      topLevelChanges: [{
        path: ["workspaceAction", "intent"],
        operation: "set",
        value: { kind: "quantum-attach", entityIds: ["station-b", "station-a"] },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("rejects duplicate scopes, malformed text and unsafe geometry", () => {
    expect(() => createNativeWorkspaceActionCommand(1, {
      kind: "quantum-attach",
      entityIds: ["same", "same"],
    })).toThrow(TypeError);
    expect(() => createNativeWorkspaceActionCommand(1, {
      kind: "handcraft-enqueue",
      recipeId: "bad\nrecipe",
      batches: 1,
    })).toThrow(TypeError);
    expect(() => createNativeWorkspaceActionCommand(1, {
      kind: "region-add",
      planetId: "home",
      x: 0,
      y: 0,
      width: 39,
      height: 100,
    })).toThrow(TypeError);
  });

  it("keeps destructive actions free of renderer-authored refunds", () => {
    const command = createNativeWorkspaceActionCommand(9, {
      kind: "spray-detach",
      entityId: "assembler-1",
    });
    const body = JSON.stringify(command);
    expect(body).not.toContain("refund");
    expect(body).not.toContain("construction");
    expect(body).not.toContain("proliferatorPoints");
    expect(createNativeWorkspaceActionCommand(9, {
      kind: "tray-discard",
      itemId: "iron_ore",
      amount: 125,
    }).topLevelChanges[0]?.value).toEqual({ kind: "tray-discard", itemId: "iron_ore", amount: 125 });
  });

  it("encodes star-map writes as compact semantic intents", () => {
    const metadata = createNativeWorkspaceActionCommand(12, {
      kind: "planet-metadata",
      planetId: "boreal_giant",
      customName: "氘气中转站",
      note: "只保存玩家输入，不携带库存副本",
      tags: ["轨采", "量子"],
    });
    expect(metadata.topLevelChanges[0]?.value).toEqual({
      kind: "planet-metadata",
      planetId: "boreal_giant",
      customName: "氘气中转站",
      note: "只保存玩家输入，不携带库存副本",
      tags: ["轨采", "量子"],
    });
    expect(createNativeWorkspaceActionCommand(12, {
      kind: "system-explore",
      systemId: "borealis",
    }).topLevelChanges[0]?.value).toEqual({ kind: "system-explore", systemId: "borealis" });
    expect(createNativeWorkspaceActionCommand(12, {
      kind: "planet-colonize",
      planetId: "frost",
    }).topLevelChanges[0]?.value).toEqual({ kind: "planet-colonize", planetId: "frost" });
    expect(createNativeWorkspaceActionCommand(12, {
      kind: "station-upgrade-scope",
      systemId: "borealis",
    }).topLevelChanges[0]?.value).toEqual({ kind: "station-upgrade-scope", systemId: "borealis" });
    expect(createNativeWorkspaceActionCommand(12, {
      kind: "quantum-attach-scope",
      systemId: null,
    }).topLevelChanges[0]?.value).toEqual({ kind: "quantum-attach-scope", systemId: null });
  });

  it("rejects malformed star-map metadata before IPC", () => {
    expect(() => createNativeWorkspaceActionCommand(1, {
      kind: "system-rename",
      systemId: "helios",
      name: "bad\u0000name",
    })).toThrow(TypeError);
    expect(() => createNativeWorkspaceActionCommand(1, {
      kind: "planet-metadata",
      planetId: "home",
      customName: "",
      note: "",
      tags: Array.from({ length: 9 }, (_, index) => `tag-${index}`),
    })).toThrow(TypeError);
  });
});
