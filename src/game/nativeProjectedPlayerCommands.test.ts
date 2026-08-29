import { describe, expect, it } from "vitest";
import {
  createNativeProjectedPlanetRoleCommand,
  createNativeProjectedStationLimitsCommand,
  createNativeProjectedStationPriorityCommand,
} from "./nativeProjectedPlayerCommands";

function expectEmptyDomains(command: NonNullable<ReturnType<typeof createNativeProjectedPlanetRoleCommand>>): void {
  expect(command.addedEntities).toEqual([]);
  expect(command.removedEntityIds).toEqual([]);
  expect(command.changedBelts).toEqual([]);
  expect(command.addedBelts).toEqual([]);
  expect(command.removedBeltIds).toEqual([]);
}

describe("native projected player command builders", () => {
  it("builds a planet-role leaf against the exact projected revision", () => {
    const command = createNativeProjectedPlanetRoleCommand({
      baseRevision: 41,
      planetId: "planet-native-only",
      currentRole: "auto",
      targetRole: "mining",
    })!;

    expect(command.protocolVersion).toBe(1);
    expect(command.baseRevision).toBe(41);
    expect(command.topLevelChanges).toEqual([{
      path: ["galaxy", "planetRoles", "planet-native-only"],
      operation: "set",
      value: "mining",
    }]);
    expect(command.changedEntities).toEqual([]);
    expectEmptyDomains(command);
  });

  it("builds 2→0→2 priority commands from two different native frames", () => {
    const lower = createNativeProjectedStationPriorityCommand({
      baseRevision: 90,
      stationId: "station-native-only",
      slotIndex: 3,
      currentPriority: 2,
      targetPriority: 0,
    })!;
    const raise = createNativeProjectedStationPriorityCommand({
      baseRevision: 91,
      stationId: "station-native-only",
      slotIndex: 3,
      currentPriority: 0,
      targetPriority: 2,
    })!;

    expect(lower.baseRevision).toBe(90);
    expect(lower.changedEntities).toEqual([{
      id: "station-native-only",
      changes: [{ path: ["stationSlots", 3, "priority"], operation: "set", value: 0 }],
    }]);
    expect(raise.baseRevision).toBe(91);
    expect(raise.changedEntities[0].changes[0].value).toBe(2);
    expectEmptyDomains(lower);
    expectEmptyDomains(raise);
  });

  it("replays legacy limit clamping and emits the paired minimum when maximum drops", () => {
    const lowerMaximum = createNativeProjectedStationLimitsCommand({
      baseRevision: 12,
      stationId: "station-a",
      slotIndex: 1,
      currentMinStock: 80,
      currentMaxStock: 100,
      requestedMinStock: 80,
      requestedMaxStock: 50.9,
    })!;
    expect(lowerMaximum.changedEntities).toEqual([{
      id: "station-a",
      changes: [
        { path: ["stationSlots", 1, "minStock"], operation: "set", value: 50 },
        { path: ["stationSlots", 1, "maxStock"], operation: "set", value: 50 },
      ],
    }]);

    const clampMinimum = createNativeProjectedStationLimitsCommand({
      baseRevision: 13,
      stationId: "station-a",
      slotIndex: 1,
      currentMinStock: 50,
      currentMaxStock: 0,
      requestedMinStock: 999_999_999,
      requestedMaxStock: 0,
    })!;
    expect(clampMinimum.changedEntities[0].changes).toEqual([{
      path: ["stationSlots", 1, "minStock"],
      operation: "set",
      value: 100_000_000,
    }]);
  });

  it("uses the legacy non-finite fallback and returns null for normalized no-ops", () => {
    expect(createNativeProjectedStationLimitsCommand({
      baseRevision: 7,
      stationId: "station-a",
      slotIndex: 0,
      currentMinStock: 0,
      currentMaxStock: 0,
      requestedMinStock: Number.POSITIVE_INFINITY,
      requestedMaxStock: Number.NaN,
    })).toBeNull();
    expect(createNativeProjectedStationPriorityCommand({
      baseRevision: 7,
      stationId: "station-a",
      slotIndex: 0,
      currentPriority: 1,
      targetPriority: 1,
    })).toBeNull();
    expect(createNativeProjectedPlanetRoleCommand({
      baseRevision: 7,
      planetId: "home",
      currentRole: "research",
      targetRole: "research",
    })).toBeNull();
  });

  it("rejects invalid projection identities and malformed current limits", () => {
    expect(() => createNativeProjectedStationPriorityCommand({
      baseRevision: -1,
      stationId: "station-a",
      slotIndex: 0,
      currentPriority: 2,
      targetPriority: 0,
    })).toThrow(/revision/);
    expect(() => createNativeProjectedStationPriorityCommand({
      baseRevision: 1,
      stationId: "station with spaces",
      slotIndex: 0,
      currentPriority: 2,
      targetPriority: 0,
    })).toThrow(/ID/);
    expect(() => createNativeProjectedStationLimitsCommand({
      baseRevision: 1,
      stationId: "station-a",
      slotIndex: 5,
      currentMinStock: 0,
      currentMaxStock: 0,
      requestedMinStock: 0,
      requestedMaxStock: 0,
    })).toThrow(/槽位/);
    expect(() => createNativeProjectedStationLimitsCommand({
      baseRevision: 1,
      stationId: "station-a",
      slotIndex: 0,
      currentMinStock: 20,
      currentMaxStock: 10,
      requestedMinStock: 0,
      requestedMaxStock: 0,
    })).toThrow(/不一致/);
  });
});
