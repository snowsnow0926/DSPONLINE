import { describe, expect, it } from "vitest";

import { createNativeProjectedQuantumItemCapacityCommand } from "./nativeProjectedQuantumCommands";

describe("native projected quantum commands", () => {
  it("builds one canonical capacity leaf against the projected revision", () => {
    const command = createNativeProjectedQuantumItemCapacityCommand({
      baseRevision: 61,
      itemId: "iron_ore",
      currentCapacity: "100000",
      targetCapacity: "1000000",
    });
    expect(command).toEqual({
      protocolVersion: 1,
      baseRevision: 61,
      topLevelChanges: [{
        path: ["quantumLogisticsNetwork", "itemCapacities", "iron_ore"],
        operation: "set",
        value: "1000000",
      }],
      changedEntities: [],
      addedEntities: [],
      removedEntityIds: [],
      changedBelts: [],
      addedBelts: [],
      removedBeltIds: [],
    });
  });

  it("returns null for an exact projected no-op", () => {
    expect(createNativeProjectedQuantumItemCapacityCommand({
      baseRevision: 61,
      itemId: "iron_ore",
      currentCapacity: "10000000000",
      targetCapacity: "10000000000",
    })).toBeNull();
  });

  it.each([
    { field: "baseRevision", value: -1 },
    { field: "baseRevision", value: Number.MAX_SAFE_INTEGER + 1 },
    { field: "itemId", value: "iron ore" },
    { field: "itemId", value: `item-${"x".repeat(260)}` },
    { field: "currentCapacity", value: "010000" },
    { field: "currentCapacity", value: "9999" },
    { field: "targetCapacity", value: "10000000001" },
    { field: "targetCapacity", value: "1e6" },
    { field: "targetCapacity", value: "-1" },
    { field: "targetCapacity", value: 100_000 },
  ])("rejects malformed projected input: $field=$value", ({ field, value }) => {
    const input = {
      baseRevision: 61,
      itemId: "iron_ore",
      currentCapacity: "100000",
      targetCapacity: "1000000",
      [field]: value,
    };
    expect(() => createNativeProjectedQuantumItemCapacityCommand(
      input as Parameters<typeof createNativeProjectedQuantumItemCapacityCommand>[0],
    )).toThrow();
  });
});
