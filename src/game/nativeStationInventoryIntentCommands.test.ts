import { describe, expect, it } from "vitest";
import {
  createNativeStationFleetTargetIntentCommand,
  createNativeStationWarperInventoryIntentCommand,
} from "./nativeStationInventoryIntentCommands";

describe("native station inventory semantic intent commands", () => {
  it("emits one fleet marker without renderer-derived inventory or progress leaves", () => {
    const command = createNativeStationFleetTargetIntentCommand(
      41,
      "station-ils",
      "drone",
      12,
    );
    expect(command.changedEntities).toEqual([{
      id: "station-ils",
      changes: [{
        path: ["stationFleetTarget", "intent"],
        operation: "set",
        value: { kind: "drone", targetCount: 12 },
      }],
    }]);
    expect(command.topLevelChanges).toEqual([]);
    expect(JSON.stringify(command)).not.toContain("portableFleet");
    expect(JSON.stringify(command)).not.toContain("stationProgress");
    expect(JSON.stringify(command)).not.toContain("stationDrones");
  });

  it("emits one signed warper marker without an owning-tray leaf", () => {
    const command = createNativeStationWarperInventoryIntentCommand(
      42,
      "station-ils",
      -4,
    );
    expect(command.changedEntities).toEqual([{
      id: "station-ils",
      changes: [{
        path: ["stationWarperInventory", "intent"],
        operation: "set",
        value: { delta: -4 },
      }],
    }]);
    expect(command.topLevelChanges).toEqual([]);
    expect(JSON.stringify(command)).not.toContain("space_warper");
    expect(JSON.stringify(command)).not.toContain("stationWarpers");
  });

  it("rejects malformed identities, revisions, counts, kinds and zero deltas", () => {
    const invalidFleet = [
      () => createNativeStationFleetTargetIntentCommand(-1, "station-ils", "drone", 1),
      () => createNativeStationFleetTargetIntentCommand(0, "", "drone", 1),
      () => createNativeStationFleetTargetIntentCommand(0, "x\0y", "drone", 1),
      () => createNativeStationFleetTargetIntentCommand(0, "x".repeat(161), "drone", 1),
      () => createNativeStationFleetTargetIntentCommand(0, "station-ils", "ship" as "drone", 1),
      () => createNativeStationFleetTargetIntentCommand(0, "station-ils", "drone", -1),
      () => createNativeStationFleetTargetIntentCommand(
        0,
        "station-ils",
        "drone",
        Number.MAX_SAFE_INTEGER + 1,
      ),
    ];
    for (const create of invalidFleet) expect(create).toThrow(TypeError);

    const invalidWarpers = [
      () => createNativeStationWarperInventoryIntentCommand(0, "", 1),
      () => createNativeStationWarperInventoryIntentCommand(0, "station-ils", 0),
      () => createNativeStationWarperInventoryIntentCommand(0, "station-ils", 1.5),
      () => createNativeStationWarperInventoryIntentCommand(
        0,
        "station-ils",
        Number.MAX_SAFE_INTEGER + 1,
      ),
    ];
    for (const create of invalidWarpers) expect(create).toThrow(TypeError);
  });
});
