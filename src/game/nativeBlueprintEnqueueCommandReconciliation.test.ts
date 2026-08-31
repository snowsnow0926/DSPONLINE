import { describe, expect, it, vi } from "vitest";

import {
  attachNativeBlueprintEnqueueMembershipProof,
  clearNativeBlueprintEnqueueMembershipProof,
  createNativeBlueprintEnqueuePendingCommand,
  evaluateNativeBlueprintEnqueuePendingProjection,
  NATIVE_BLUEPRINT_ENQUEUE_RECONCILIATION_DELAYS_MS,
  reconcileNativeBlueprintEnqueuePendingCommand,
  updateNativeBlueprintEnqueuePendingCommand,
} from "./nativeBlueprintEnqueueCommandReconciliation";
import type { NativeBlueprintEnqueueContext } from "./nativeBlueprintEnqueueContext";
import { createNativeBlueprintEnqueueIntentCommand } from "./nativeBlueprintEnqueueIntentCommands";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";

const CONTEXT: NativeBlueprintEnqueueContext = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  schemaVersion: 1,
  projectionType: "blueprint-enqueue-context-v1",
  source: "native-core",
  revision: 48,
  stateVersion: 47,
  registryFingerprint: "registry-a",
  request: Object.freeze({
    expectedRevision: 48,
    expectedRegistryFingerprint: "registry-a",
    blueprintId: "blueprint-a",
    blueprintRevision: 3,
  }),
  activePlanetId: "planet-a",
  support: Object.freeze({ supported: true, reason: null }),
  expectedQueueId: "construction_17",
  limits: Object.freeze({ projectionBytes: 1_048_576 }),
});

const POSITION = Object.freeze({ x: 12.5, y: -7 });

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    previousRevision: 48,
    revision: 49,
    changedEntityIds: [],
    changedBeltIds: [],
    topologyDirty: true,
    ...overrides,
  };
}

function source(
  reconcileCommand: NativePlayerAuthorityCommandSource["reconcileCommand"] = vi.fn(async () => ({
    status: "pending" as const,
    baseRevision: 48,
    currentRevision: 48,
  })),
): NativePlayerAuthorityCommandSource {
  return Object.freeze({
    sessionId: "session-a",
    runId: "run-a",
    baseRevision: 48,
    applyCommand: vi.fn(),
    reconcileCommand,
  });
}

function pending(commandSource = source()) {
  return createNativeBlueprintEnqueuePendingCommand({
    token: 7,
    source: commandSource,
    command: createNativeBlueprintEnqueueIntentCommand(CONTEXT, POSITION),
    context: CONTEXT,
    position: POSITION,
  });
}

describe("native blueprint enqueue reconciliation", () => {
  it("pins the exact enqueue marker and rejects renderer-owned derived fields", () => {
    expect(pending()).toMatchObject({
      phase: "dispatching",
      expectedQueueId: "construction_17",
      receipt: null,
    });
    for (const [key, value] of [
      ["queueId", "construction_17"],
      ["activePlanetId", "planet-a"],
      ["rotation", 90],
      ["allowOverlap", false],
    ] as const) {
      const forged = createNativeBlueprintEnqueueIntentCommand(CONTEXT, POSITION);
      (forged.topLevelChanges[0].value as Record<string, unknown>)[key] = value;
      expect(() => createNativeBlueprintEnqueuePendingCommand({
        token: 1,
        source: source(),
        command: forged,
        context: CONTEXT,
        position: POSITION,
      })).toThrow();
    }
  });

  it("uses exactly six read-only attempts and never resends the mutation", async () => {
    const reconcile = vi.fn(async () => ({
      status: "pending" as const,
      baseRevision: 48,
      currentRevision: 48,
    }));
    const commandSource = source(reconcile);
    const waits: number[] = [];
    const result = await reconcileNativeBlueprintEnqueuePendingCommand({
      pending: updateNativeBlueprintEnqueuePendingCommand(pending(commandSource), "reconciling"),
      isCurrent: () => true,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(result).toEqual({ status: "blocked", reason: "pending-timeout" });
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
    expect(commandSource.applyCommand).not.toHaveBeenCalled();
    expect(NATIVE_BLUEPRINT_ENQUEUE_RECONCILIATION_DELAYS_MS)
      .toEqual([0, 100, 250, 500, 1_000, 2_000]);
  });

  it("accepts only the exact R+1 empty topology-dirty acknowledgement", async () => {
    const valid = source(vi.fn(async () => ({
      status: "committed" as const,
      receipt: receipt(),
    })));
    await expect(reconcileNativeBlueprintEnqueuePendingCommand({
      pending: pending(valid),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "committed", receipt: receipt() });

    for (const forged of [
      { changedEntityIds: ["entity-a"] },
      { changedBeltIds: ["belt-a"] },
      { topologyDirty: false },
      { previousRevision: 47 },
      { revision: 50 },
      { unexpected: true },
    ]) {
      const invalid = source(vi.fn(async () => ({
        status: "committed" as const,
        receipt: receipt(forged),
      })));
      await expect(reconcileNativeBlueprintEnqueuePendingCommand({
        pending: pending(invalid),
        isCurrent: () => true,
        wait: async () => undefined,
      })).resolves.toEqual({ status: "blocked", reason: "receipt-invalid" });
    }
  });

  it("unlocks only proven non-commit and fails closed for conflicts or unavailable proof", async () => {
    for (const [outcome, expected] of [
      [{ status: "not-committed" as const, baseRevision: 48, currentRevision: 48 }, { status: "not-committed" }],
      [{ status: "conflict" as const, baseRevision: 48, currentRevision: 50 }, { status: "blocked", reason: "conflict" }],
      [{ status: "unavailable" as const }, { status: "blocked", reason: "reconciliation-unavailable" }],
    ] as const) {
      await expect(reconcileNativeBlueprintEnqueuePendingCommand({
        pending: pending(source(vi.fn(async () => outcome))),
        isCurrent: () => true,
        wait: async () => undefined,
      })).resolves.toEqual(expected);
    }
  });

  it("confirms only exact same-lineage membership presence at the current authority revision", () => {
    const awaiting = updateNativeBlueprintEnqueuePendingCommand(pending(), "awaiting-projection", {
      receipt: receipt(),
    });
    expect(evaluateNativeBlueprintEnqueuePendingProjection(awaiting, null))
      .toEqual({ status: "waiting" });
    expect(evaluateNativeBlueprintEnqueuePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
    )).toEqual({ status: "waiting" });

    const presentAt50 = attachNativeBlueprintEnqueueMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      queueEntryId: "construction_17",
      present: true,
    });
    expect(evaluateNativeBlueprintEnqueuePendingProjection(
      presentAt50,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
    )).toEqual({ status: "confirmed" });
    expect(evaluateNativeBlueprintEnqueuePendingProjection(
      presentAt50,
      { sessionId: "session-a", runId: "run-a", revision: 51 },
    )).toEqual({ status: "stale-proof" });
    const cleared = clearNativeBlueprintEnqueueMembershipProof(presentAt50);
    expect(cleared.membershipProof).toBeNull();
    expect(evaluateNativeBlueprintEnqueuePendingProjection(
      cleared,
      { sessionId: "session-a", runId: "run-a", revision: 51 },
    )).toEqual({ status: "waiting" });

    const absentAt50 = attachNativeBlueprintEnqueueMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      queueEntryId: "construction_17",
      present: false,
    });
    expect(evaluateNativeBlueprintEnqueuePendingProjection(
      absentAt50,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });

    expect(() => attachNativeBlueprintEnqueueMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      queueEntryId: "construction_18",
      present: true,
    })).toThrow();
    expect(() => attachNativeBlueprintEnqueueMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      queueEntryId: "construction_17",
      present: true,
      extra: true,
    } as never)).toThrow();
    expect(evaluateNativeBlueprintEnqueuePendingProjection(
      awaiting,
      { sessionId: "session-new", runId: "run-new", revision: 1 },
    )).toEqual({ status: "lineage-changed" });
  });
});
