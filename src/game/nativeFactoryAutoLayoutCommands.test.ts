import { describe, expect, it } from "vitest";

import { createNativeFactoryAutoLayoutCommand } from "./nativeFactoryAutoLayoutCommands";

describe("native factory auto-layout commands", () => {
  it("encodes a whole-planet layout as one coordinate-free semantic intent", () => {
    expect(createNativeFactoryAutoLayoutCommand(42)).toEqual({
      protocolVersion: 1,
      baseRevision: 42,
      topLevelChanges: [{
        path: ["factoryAutoLayout", "intent"],
        operation: "set",
        value: { kind: "apply", scope: "all", entityIds: [] },
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("preserves bounded opaque Unicode IDs for a selected layout", () => {
    const command = createNativeFactoryAutoLayoutCommand(7, ["entity-a", "模组:建筑/甲"]);
    expect(command.topLevelChanges[0]?.value).toEqual({
      kind: "apply",
      scope: "selection",
      entityIds: ["entity-a", "模组:建筑/甲"],
    });
    expect(JSON.stringify(command)).not.toContain("position");
  });

  it("treats an explicitly empty selection like the legacy whole-planet action", () => {
    expect(createNativeFactoryAutoLayoutCommand(1, []).topLevelChanges[0]?.value)
      .toEqual({ kind: "apply", scope: "all", entityIds: [] });
  });

  it("fails closed for stale revisions, duplicate IDs, controls, malformed Unicode, and oversize scopes", () => {
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
      expect(() => createNativeFactoryAutoLayoutCommand(revision)).toThrow(TypeError);
    }
    expect(() => createNativeFactoryAutoLayoutCommand(1, ["a", "a"])).toThrow(TypeError);
    expect(() => createNativeFactoryAutoLayoutCommand(1, ["bad\nentity"])).toThrow(TypeError);
    expect(() => createNativeFactoryAutoLayoutCommand(1, ["\ud800"])).toThrow(TypeError);
    expect(() => createNativeFactoryAutoLayoutCommand(1, ["x".repeat(513)])).toThrow(TypeError);
    expect(() => createNativeFactoryAutoLayoutCommand(
      1,
      Array.from({ length: 4_097 }, (_, index) => `entity-${index}`),
    )).toThrow(TypeError);
    expect(() => createNativeFactoryAutoLayoutCommand(
      1,
      Array.from({ length: 4_000 }, (_, index) => `${index}-${"界".repeat(165)}`),
    )).toThrow(TypeError);
  });
});
