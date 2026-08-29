import { describe, expect, it } from "vitest";
import {
  createNativeProjectedInteractionLockCommand,
  createNativeProjectedPlanetRoleCommand,
  createNativeProjectedStationLimitsCommand,
  createNativeProjectedStationPriorityCommand,
  type NativeProjectedInteractionLockCommandInput,
} from "./nativeProjectedPlayerCommands";

function expectEmptyDomains(command: NonNullable<ReturnType<typeof createNativeProjectedPlanetRoleCommand>>): void {
  expect(command.addedEntities).toEqual([]);
  expect(command.removedEntityIds).toEqual([]);
  expect(command.changedBelts).toEqual([]);
  expect(command.addedBelts).toEqual([]);
  expect(command.removedBeltIds).toEqual([]);
}

describe("native projected player command builders", () => {
  const interactionRows = (
    rows: Array<{ entityId: string; interactionLocked: boolean }>,
    options: { totalCount?: number; truncated?: boolean } = {},
  ): NativeProjectedInteractionLockCommandInput["entityRows"] => ({
    rows,
    totalCount: options.totalCount ?? rows.length,
    truncated: options.truncated ?? false,
  });

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

  it("builds one shared interaction-lock batch in bounded projection order", () => {
    const command = createNativeProjectedInteractionLockCommand({
      baseRevision: 44,
      entityRows: interactionRows([
        { entityId: "selected-z", interactionLocked: false },
        { entityId: "selected-a", interactionLocked: true },
        { entityId: "selected-m", interactionLocked: false },
      ]),
      targetInteractionLocked: true,
    })!;

    expect(command.baseRevision).toBe(44);
    expect(command.changedEntities).toEqual([
      {
        id: "selected-z",
        changes: [{ path: ["interactionLocked"], operation: "set", value: true }],
      },
      {
        id: "selected-m",
        changes: [{ path: ["interactionLocked"], operation: "set", value: true }],
      },
    ]);
    expect(command.topLevelChanges).toEqual([]);
    expectEmptyDomains(command);
  });

  it("emits only changed unlock rows and returns null for empty or unchanged selections", () => {
    const command = createNativeProjectedInteractionLockCommand({
      baseRevision: 45,
      entityRows: interactionRows([
        { entityId: "already-unlocked", interactionLocked: false },
        { entityId: "locked-second", interactionLocked: true },
        { entityId: "locked-third", interactionLocked: true },
      ]),
      targetInteractionLocked: false,
    })!;
    expect(command.changedEntities.map((row) => row.id)).toEqual(["locked-second", "locked-third"]);
    expect(command.changedEntities.every((row) => row.changes[0]?.value === false)).toBe(true);

    expect(createNativeProjectedInteractionLockCommand({
      baseRevision: 46,
      entityRows: interactionRows([]),
      targetInteractionLocked: true,
    })).toBeNull();
    expect(createNativeProjectedInteractionLockCommand({
      baseRevision: 46,
      entityRows: interactionRows([
        { entityId: "locked-a", interactionLocked: true },
        { entityId: "locked-b", interactionLocked: true },
      ]),
      targetInteractionLocked: true,
    })).toBeNull();
  });

  it("fails closed for stale, truncated, duplicate, oversized, or non-boolean lock rows", () => {
    const oversized = Array.from({ length: 65 }, (_, index) => ({
      entityId: `selected-${index}`,
      interactionLocked: false,
    }));
    const cases: NativeProjectedInteractionLockCommandInput[] = [
      {
        baseRevision: 1,
        entityRows: interactionRows([{ entityId: "selected-a", interactionLocked: false }], {
          truncated: true,
        }),
        targetInteractionLocked: true,
      },
      {
        baseRevision: 1,
        entityRows: interactionRows([{ entityId: "selected-a", interactionLocked: false }], {
          totalCount: 2,
        }),
        targetInteractionLocked: true,
      },
      {
        baseRevision: 1,
        entityRows: interactionRows([
          { entityId: "duplicate", interactionLocked: false },
          { entityId: "duplicate", interactionLocked: true },
        ]),
        targetInteractionLocked: true,
      },
      {
        baseRevision: 1,
        entityRows: interactionRows(oversized),
        targetInteractionLocked: true,
      },
      {
        baseRevision: 1,
        entityRows: interactionRows([{ entityId: "bad entity", interactionLocked: false }]),
        targetInteractionLocked: true,
      },
      {
        baseRevision: 1,
        entityRows: interactionRows([{
          entityId: "selected-a",
          interactionLocked: 0 as unknown as boolean,
        }]),
        targetInteractionLocked: true,
      },
      {
        baseRevision: 1,
        entityRows: interactionRows([{ entityId: "selected-a", interactionLocked: false }]),
        targetInteractionLocked: "true" as unknown as boolean,
      },
    ];
    for (const input of cases) {
      expect(() => createNativeProjectedInteractionLockCommand(input)).toThrow(TypeError);
    }
    expect(() => createNativeProjectedInteractionLockCommand({
      baseRevision: -1,
      entityRows: interactionRows([{ entityId: "selected-a", interactionLocked: false }]),
      targetInteractionLocked: true,
    })).toThrow(/revision/);
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
