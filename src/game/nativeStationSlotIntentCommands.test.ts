import { describe, expect, it } from "vitest";
import {
  createNativeStationSlotItemIntentCommand,
  createNativeStationSlotModeIntentCommand,
} from "./nativeStationSlotIntentCommands";

describe("native station slot semantic intent commands", () => {
  it("emits one exact mode marker without renderer-derived route or mirror leaves", () => {
    const command = createNativeStationSlotModeIntentCommand(
      51,
      "station-ils",
      3,
      "remote",
      "demand",
    );
    expect(command.changedEntities).toEqual([{
      id: "station-ils",
      changes: [{
        path: ["stationSlotMode", "intent"],
        operation: "set",
        value: { slotIndex: 3, scope: "remote", mode: "demand" },
      }],
    }]);
    expect(command.topLevelChanges).toEqual([]);
    expect(command.removedBeltIds).toEqual([]);
    expect(JSON.stringify(command)).not.toContain("stationRoutes");
    expect(JSON.stringify(command)).not.toContain("stationProgress");
    expect(JSON.stringify(command)).not.toContain("stationMode\"");
  });

  it("emits item assignment and explicit-null clear markers only", () => {
    const assigned = createNativeStationSlotItemIntentCommand(
      52,
      "station-pls",
      1,
      "iron_ore",
    );
    const cleared = createNativeStationSlotItemIntentCommand(
      53,
      "station-pls",
      1,
      null,
    );
    expect(assigned.changedEntities[0]?.changes).toEqual([{
      path: ["stationSlotItem", "intent"],
      operation: "set",
      value: { slotIndex: 1, itemId: "iron_ore" },
    }]);
    expect(cleared.changedEntities[0]?.changes).toEqual([{
      path: ["stationSlotItem", "intent"],
      operation: "set",
      value: { slotIndex: 1, itemId: null },
    }]);
    for (const command of [assigned, cleared]) {
      expect(command.topLevelChanges).toEqual([]);
      expect(command.removedBeltIds).toEqual([]);
      expect(JSON.stringify(command)).not.toContain("portableFleet");
      expect(JSON.stringify(command)).not.toContain("planetTrays");
      expect(JSON.stringify(command)).not.toContain("stationSlots");
    }
  });

  it("rejects malformed revisions, identities, slot indexes, modes and items", () => {
    const invalid = [
      () => createNativeStationSlotModeIntentCommand(-1, "station-ils", 0, "local", "supply"),
      () => createNativeStationSlotModeIntentCommand(0, "", 0, "local", "supply"),
      () => createNativeStationSlotModeIntentCommand(0, "x\0y", 0, "local", "supply"),
      () => createNativeStationSlotModeIntentCommand(0, "x".repeat(161), 0, "local", "supply"),
      () => createNativeStationSlotModeIntentCommand(0, "station-ils", -1, "local", "supply"),
      () => createNativeStationSlotModeIntentCommand(0, "station-ils", 5, "local", "supply"),
      () => createNativeStationSlotModeIntentCommand(0, "station-ils", 1.5, "local", "supply"),
      () => createNativeStationSlotModeIntentCommand(
        0,
        "station-ils",
        0,
        "planet" as "local",
        "supply",
      ),
      () => createNativeStationSlotModeIntentCommand(
        0,
        "station-ils",
        0,
        "local",
        "export" as "supply",
      ),
      () => createNativeStationSlotItemIntentCommand(0, "station-ils", 0, ""),
      () => createNativeStationSlotItemIntentCommand(0, "station-ils", 0, "x\0y"),
      () => createNativeStationSlotItemIntentCommand(0, "station-ils", 0, "x".repeat(161)),
    ];
    for (const create of invalid) expect(create).toThrow(TypeError);
  });
});
