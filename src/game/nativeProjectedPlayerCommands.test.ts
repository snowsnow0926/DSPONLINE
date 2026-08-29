import { describe, expect, it } from "vitest";
import {
  createNativeProjectedInteractionLockCommand,
  createNativeProjectedInteractionLockCommandFromReadModels,
  createNativeProjectedPlanetRoleCommand,
  createNativeProjectedStationLimitsCommand,
  createNativeProjectedStationMinimumLoadCommand,
  createNativeProjectedStationPriorityCommand,
  createNativeProjectedStationRoutePolicyCommand,
  createNativeProjectedStationWarperBudgetCommand,
  type NativeProjectedInteractionLockCommandInput,
} from "./nativeProjectedPlayerCommands";
import type {
  FactoryMultiSelectionSummaryReadModel,
  FactorySelectionToolbarReadModel,
  NativeFactoryProjectionIdentity,
  SelectedEntityReadModel,
} from "./factoryReadModels";

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

  const selectedEntity = (entityId: string, interactionLocked: boolean, planetId = "home"): SelectedEntityReadModel => ({
    entityId,
    planetId,
    kind: "machine",
    position: { x: 0, y: 0 },
    interactionLocked,
    buildingId: "arc_smelter",
    resourceId: null,
    recipeId: "iron_ingot",
    storedItemId: null,
    fuelItemId: null,
    machineCount: 1,
    minerCount: 0,
    progress: 0,
    utilization: 1,
    productionRate: 60,
    powerFactor: 1,
    inputItems: { rows: [], totalCount: 0, truncated: false },
    outputItems: { rows: [], totalCount: 0, truncated: false },
  });

  const lockReadModels = (identity: NativeFactoryProjectionIdentity) => {
    const entityRows = {
      rows: [selectedEntity("selected-a", false, identity.planetId)],
      totalCount: 1,
      truncated: false,
    } as const;
    const toolbar: FactorySelectionToolbarReadModel = {
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: identity.revision,
      activePlanetId: identity.planetId,
      projectionIdentity: identity,
      selectedCount: 1,
      selectedBeltCount: 0,
      canLock: true,
      canUnlock: false,
    };
    const selection: FactoryMultiSelectionSummaryReadModel = {
      schema: "factory-read-model-v1",
      source: "native-core",
      revision: identity.revision,
      activePlanetId: identity.planetId,
      projectionIdentity: identity,
      requestedEntityCount: 1,
      requestedBeltCount: 0,
      entityRows,
      beltRows: { rows: [], totalCount: 0, truncated: false },
    };
    return { toolbar, selection };
  };

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

  it("builds minimum-load commands with the legacy mirror only for the projected primary slot", () => {
    const primary = createNativeProjectedStationMinimumLoadCommand({
      baseRevision: 92,
      stationId: "station-primary",
      slotIndex: 1,
      currentMinimumLoad: 0.5,
      targetMinimumLoad: 0.1,
      primarySlot: true,
    })!;
    expect(primary.changedEntities).toEqual([{
      id: "station-primary",
      changes: [
        { path: ["stationSlots", 1, "minimumLoad"], operation: "set", value: 0.1 },
        { path: ["stationMinimumLoad"], operation: "set", value: 0.1 },
      ],
    }]);

    const secondary = createNativeProjectedStationMinimumLoadCommand({
      baseRevision: 93,
      stationId: "station-secondary",
      slotIndex: 3,
      currentMinimumLoad: 0.25,
      targetMinimumLoad: 1,
      primarySlot: false,
    })!;
    expect(secondary.changedEntities[0].changes).toEqual([
      { path: ["stationSlots", 3, "minimumLoad"], operation: "set", value: 1 },
    ]);
    expectEmptyDomains(primary);
    expectEmptyDomains(secondary);
  });

  it("builds interstellar route policy and normalized warper-budget leaves", () => {
    const policy = createNativeProjectedStationRoutePolicyCommand({
      baseRevision: 94,
      stationId: "station-ils",
      slotIndex: 2,
      currentRoutePolicy: "relay-preferred",
      targetRoutePolicy: "relay-required",
    })!;
    expect(policy.changedEntities[0].changes).toEqual([{
      path: ["stationSlots", 2, "routePolicy"],
      operation: "set",
      value: "relay-required",
    }]);

    const budget = createNativeProjectedStationWarperBudgetCommand({
      baseRevision: 95,
      stationId: "station-ils",
      slotIndex: 2,
      currentWarperBudget: 2,
      requestedWarperBudget: 9.75,
    })!;
    expect(budget.changedEntities[0].changes).toEqual([{
      path: ["stationSlots", 2, "warperBudget"],
      operation: "set",
      value: 4,
    }]);
    expectEmptyDomains(policy);
    expectEmptyDomains(budget);
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
    expect(createNativeProjectedStationMinimumLoadCommand({
      baseRevision: 7,
      stationId: "station-a",
      slotIndex: 0,
      currentMinimumLoad: 0.5,
      targetMinimumLoad: 0.5,
      primarySlot: true,
    })).toBeNull();
    expect(createNativeProjectedStationRoutePolicyCommand({
      baseRevision: 7,
      stationId: "station-a",
      slotIndex: 0,
      currentRoutePolicy: "direct",
      targetRoutePolicy: "direct",
    })).toBeNull();
    expect(createNativeProjectedStationWarperBudgetCommand({
      baseRevision: 7,
      stationId: "station-a",
      slotIndex: 0,
      currentWarperBudget: 4,
      requestedWarperBudget: 10,
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

  it("admits lock rows only for the exact live session/run/revision/planet identity", () => {
    const projectionIdentity = {
      sessionId: "session-a",
      runId: "run-a",
      revision: 44,
      planetId: "home",
    } as const;
    const models = lockReadModels(projectionIdentity);
    expect(createNativeProjectedInteractionLockCommandFromReadModels({
      commandIdentity: projectionIdentity,
      ...models,
      targetInteractionLocked: true,
    })?.changedEntities.map((row) => row.id)).toEqual(["selected-a"]);

    const sameRevisionMismatches: NativeFactoryProjectionIdentity[] = [
      { ...projectionIdentity, sessionId: "session-b" },
      { ...projectionIdentity, runId: "run-b" },
      { ...projectionIdentity, planetId: "ashen" },
    ];
    for (const commandIdentity of sameRevisionMismatches) {
      expect(() => createNativeProjectedInteractionLockCommandFromReadModels({
        commandIdentity,
        ...models,
        targetInteractionLocked: true,
      })).toThrow(/identity/);
    }
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
