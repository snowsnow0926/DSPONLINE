import { describe, expect, it } from "vitest";

import { createNativeProjectedManualMineCommand } from "./nativeProjectedManualMiningCommands";

describe("native projected manual mining commands", () => {
  it("submits only the exact revision and vein identity", () => {
    expect(createNativeProjectedManualMineCommand({
      baseRevision: 17,
      entityId: "vein-iron:home/1",
    })).toEqual({
      protocolVersion: 1,
      baseRevision: 17,
      topLevelChanges: [],
      changedEntities: [{
        id: "vein-iron:home/1",
        changes: [{ path: ["manualMine"], operation: "set", value: 1 }],
      }],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("preserves opaque Unicode mod entity IDs", () => {
    expect(createNativeProjectedManualMineCommand({
      baseRevision: 3,
      entityId: "MOD-矿脉/Ω",
    }).changedEntities[0]?.id).toBe("MOD-矿脉/Ω");
  });

  it.each([
    { baseRevision: -1, entityId: "vein" },
    { baseRevision: 1.5, entityId: "vein" },
    { baseRevision: Number.MAX_SAFE_INTEGER, entityId: "vein" },
    { baseRevision: 1, entityId: "" },
    { baseRevision: 1, entityId: "vein\0id" },
    { baseRevision: 1, entityId: "vein\ud800" },
    { baseRevision: 1, entityId: "矿".repeat(171) },
  ])("rejects malformed renderer intent %#", (input) => {
    expect(() => createNativeProjectedManualMineCommand(input)).toThrow();
  });
});
