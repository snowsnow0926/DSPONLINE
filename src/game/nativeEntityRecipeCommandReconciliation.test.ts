import { describe, expect, it, vi } from "vitest";

import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import {
  asNativeEntityRecipeCommitReceipt,
  createNativeEntityRecipePendingCommand,
  evaluateNativeEntityRecipePendingProjection,
  NATIVE_ENTITY_RECIPE_RECONCILIATION_DELAYS_MS,
  reconcileNativeEntityRecipePendingCommand,
  updateNativeEntityRecipePendingCommand,
} from "./nativeEntityRecipeCommandReconciliation";
import type { NativeProjectedEntityRecipeBinding } from "./nativeProjectedEntityRecipeCommands";
import {
  SIMULATION_RUNTIME_PROTOCOL_VERSION,
  type SimulationCommandPatch,
} from "./simulationRuntimeProtocol";

function recipeCommand(baseRevision = 10): SimulationCommandPatch {
  return {
    protocolVersion: SIMULATION_RUNTIME_PROTOCOL_VERSION,
    baseRevision,
    topLevelChanges: [{
      path: ["entityRecipe", "intent"],
      operation: "set",
      value: { entityId: "machine-1", targetRecipeId: "iron_ingot" },
    }],
    changedEntities: [],
    addedEntities: [],
    removedEntityIds: [],
    changedBelts: [],
    addedBelts: [],
    removedBeltIds: [],
  };
}

function binding(revision = 10, recipeId: string | null = "magnet"): NativeProjectedEntityRecipeBinding {
  return {
    sessionId: "session-1",
    runId: "run-1",
    revision,
    registryFingerprint: "7df8cf3a",
    activePlanetId: "planet-1",
    entity: {
      id: "machine-1",
      kind: "machine",
      planetId: "planet-1",
      buildingId: "arc_smelter",
      recipeId,
    },
  } as unknown as NativeProjectedEntityRecipeBinding;
}

function source(outcomes: unknown[]): NativePlayerAuthorityCommandSource & {
  applyCommand: ReturnType<typeof vi.fn>;
  reconcileCommand: ReturnType<typeof vi.fn>;
} {
  return {
    sessionId: "session-1",
    runId: "run-1",
    baseRevision: 10,
    applyCommand: vi.fn(),
    reconcileCommand: vi.fn(async () => outcomes.shift()),
  } as unknown as NativePlayerAuthorityCommandSource & {
    applyCommand: ReturnType<typeof vi.fn>;
    reconcileCommand: ReturnType<typeof vi.fn>;
  };
}

function receipt() {
  return {
    previousRevision: 10,
    revision: 11,
    changedEntityIds: ["machine-1"],
    changedBeltIds: [],
    topologyDirty: true,
  } as const;
}

function pending(commandSource: NativePlayerAuthorityCommandSource) {
  return createNativeEntityRecipePendingCommand({
    token: 1,
    source: commandSource,
    command: recipeCommand(),
    binding: binding(),
    targetRecipeId: "iron_ingot",
  });
}

describe("native entity recipe command reconciliation", () => {
  it("pins one exact immutable command and the exact source/lineage", () => {
    const commandSource = source([]);
    const transaction = pending(commandSource);
    expect(transaction.source).toBe(commandSource);
    expect(transaction.command).toEqual(recipeCommand());
    expect(Object.isFrozen(transaction.command)).toBe(true);
    expect(Object.isFrozen(transaction.command.topLevelChanges)).toBe(true);
    expect(transaction).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      baseRevision: 10,
      entityId: "machine-1",
      targetRecipeId: "iron_ingot",
      phase: "dispatching",
    });
    expect(() => createNativeEntityRecipePendingCommand({
      token: 2,
      source: commandSource,
      command: { ...recipeCommand(), removedBeltIds: ["belt-1"] },
      binding: binding(),
      targetRecipeId: "iron_ingot",
    })).toThrow(/单意图补丁/);
  });

  it("performs bounded read-only reconciliation and keeps the same command object", async () => {
    const commandSource = source([
      { status: "pending", baseRevision: 10, currentRevision: 10 },
      { status: "unavailable" },
      { status: "committed", receipt: receipt() },
    ]);
    const transaction = pending(commandSource);
    const wait = vi.fn(async (_milliseconds: number) => undefined);
    const result = await reconcileNativeEntityRecipePendingCommand({
      pending: updateNativeEntityRecipePendingCommand(transaction, "reconciling"),
      isCurrent: () => true,
      wait,
    });
    expect(result).toEqual({ status: "committed", receipt: receipt() });
    expect(commandSource.applyCommand).not.toHaveBeenCalled();
    expect(commandSource.reconcileCommand).toHaveBeenCalledTimes(3);
    for (const [command] of commandSource.reconcileCommand.mock.calls as unknown[][]) {
      expect(command).toBe(transaction.command);
    }
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 250]);
  });

  it("unlocks only a proven not-committed result and blocks conflicts", async () => {
    const notCommittedSource = source([{
      status: "not-committed",
      baseRevision: 10,
      currentRevision: 10,
    }]);
    await expect(reconcileNativeEntityRecipePendingCommand({
      pending: pending(notCommittedSource),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "not-committed" });

    const conflictSource = source([{
      status: "conflict",
      baseRevision: 10,
      currentRevision: 11,
    }]);
    await expect(reconcileNativeEntityRecipePendingCommand({
      pending: pending(conflictSource),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "blocked", reason: "conflict" });
  });

  it("stops after the fixed retry budget and never resends the mutation", async () => {
    const commandSource = source(Array.from(
      { length: NATIVE_ENTITY_RECIPE_RECONCILIATION_DELAYS_MS.length },
      () => ({ status: "pending", baseRevision: 10, currentRevision: 10 }),
    ));
    await expect(reconcileNativeEntityRecipePendingCommand({
      pending: pending(commandSource),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "blocked", reason: "pending-timeout" });
    expect(commandSource.reconcileCommand).toHaveBeenCalledTimes(6);
    expect(commandSource.applyCommand).not.toHaveBeenCalled();
  });

  it("cancels stale reconciliation after an explicit lineage handoff", async () => {
    const commandSource = source([
      { status: "pending", baseRevision: 10, currentRevision: 10 },
      { status: "committed", receipt: receipt() },
    ]);
    let current = true;
    const result = await reconcileNativeEntityRecipePendingCommand({
      pending: pending(commandSource),
      isCurrent: () => current,
      wait: async () => { current = false; },
    });
    expect(result).toEqual({ status: "cancelled" });
    expect(commandSource.reconcileCommand).toHaveBeenCalledTimes(1);
  });

  it("requires the exact receipt revision and target recipe projection", () => {
    const transaction = updateNativeEntityRecipePendingCommand(
      pending(source([])),
      "awaiting-projection",
      { receipt: asNativeEntityRecipeCommitReceipt(pending(source([])), {
        commandId: "renderer-local-a-1",
        ...receipt(),
      }) },
    );
    expect(evaluateNativeEntityRecipePendingProjection(transaction, {
      sessionId: "session-1",
      runId: "run-1",
      revision: 10,
    }, null)).toEqual({ status: "waiting" });
    expect(evaluateNativeEntityRecipePendingProjection(transaction, {
      sessionId: "session-1",
      runId: "run-1",
      revision: 11,
    }, binding(11, "iron_ingot"))).toEqual({ status: "confirmed" });
    expect(evaluateNativeEntityRecipePendingProjection(transaction, {
      sessionId: "session-1",
      runId: "run-1",
      revision: 11,
    }, binding(11, "magnet"))).toEqual({
      status: "blocked",
      reason: "receipt-projection-mismatch",
    });
    expect(evaluateNativeEntityRecipePendingProjection(transaction, {
      sessionId: "session-1",
      runId: "run-1",
      revision: 12,
    }, binding(12, "iron_ingot"))).toEqual({
      status: "confirmed",
    });
    expect(evaluateNativeEntityRecipePendingProjection(transaction, {
      sessionId: "session-2",
      runId: "run-2",
      revision: 0,
    }, null)).toEqual({ status: "lineage-changed" });
  });
});
