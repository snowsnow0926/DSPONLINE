import { describe, expect, it } from "vitest";

import { createNativeProjectedBlackHolePausedCommand } from "./nativeProjectedBlackHoleCommands";

describe("native projected black-hole pause commands", () => {
  it("submits only revision, entity ID, pause target and explicit activation intent", () => {
    expect(createNativeProjectedBlackHolePausedCommand({
      baseRevision: 81,
      entityId: "black-hole-a",
      paused: false,
      confirmActivation: true,
    })).toEqual({
      protocolVersion: 1,
      baseRevision: 81,
      topLevelChanges: [],
      changedEntities: [{
        id: "black-hole-a",
        changes: [{
          path: ["blackHolePaused", "intent"],
          operation: "set",
          value: { paused: false, confirmActivation: true },
        }],
      }],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("does not copy projected flags, ports or destruction totals into pause and resume intents", () => {
    const command = createNativeProjectedBlackHolePausedCommand({
      baseRevision: 82,
      entityId: "black-hole-a",
      paused: true,
      confirmActivation: false,
    });
    const encoded = JSON.stringify(command);
    expect(encoded).not.toContain("blackHoleActivationConfirmed");
    expect(encoded).not.toContain("blackHolePorts");
    expect(encoded).not.toContain("totalDestroyed");
    expect(command.changedEntities[0].changes[0].value).toEqual({
      paused: true,
      confirmActivation: false,
    });
  });

  it("fails closed for malformed renderer intent", () => {
    for (const input of [
      { baseRevision: -1, entityId: "black-hole-a", paused: true, confirmActivation: false },
      { baseRevision: 1.5, entityId: "black-hole-a", paused: true, confirmActivation: false },
      { baseRevision: 1, entityId: "black hole", paused: true, confirmActivation: false },
      { baseRevision: 1, entityId: "black-hole-a", paused: 1, confirmActivation: false },
      { baseRevision: 1, entityId: "black-hole-a", paused: true, confirmActivation: "yes" },
    ]) {
      expect(() => createNativeProjectedBlackHolePausedCommand(
        input as Parameters<typeof createNativeProjectedBlackHolePausedCommand>[0],
      )).toThrow(TypeError);
    }
  });
});
