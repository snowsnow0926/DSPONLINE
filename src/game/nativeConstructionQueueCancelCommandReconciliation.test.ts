import { describe, expect, it, vi } from "vitest";

import {
  attachNativeConstructionQueueCancelMembershipProof,
  createNativeConstructionQueueCancelPendingCommand,
  evaluateNativeConstructionQueueCancelPendingProjection,
  NATIVE_CONSTRUCTION_QUEUE_CANCEL_RECONCILIATION_DELAYS_MS,
  reconcileNativeConstructionQueueCancelPendingCommand,
  updateNativeConstructionQueueCancelPendingCommand,
} from "./nativeConstructionQueueCancelCommandReconciliation";
import { createNativeConstructionQueueCancelIntentCommand } from "./nativeConstructionQueueCancelIntentCommands";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeConstructionQueueCancelBinding,
} from "./nativeBlueprintWorkspaceStore";

const BINDING: NativeConstructionQueueCancelBinding = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 48,
  registryFingerprint: "registry-a",
  queueEntryId: "queue-target",
  queueTotalCount: 2,
});

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
  return createNativeConstructionQueueCancelPendingCommand({
    token: 7,
    source: commandSource,
    command: createNativeConstructionQueueCancelIntentCommand(48, BINDING.queueEntryId),
    binding: BINDING,
  });
}

function projected(overrides: Partial<NativeBlueprintWorkspaceFrame> = {}): NativeBlueprintWorkspaceFrame {
  const other = {
    id: "queue-other",
    blueprintId: "blueprint-other",
    blueprintVersionId: "version-other",
    blueprintRevision: 2,
    blueprintName: "保留订单",
    planetId: "planet-a",
    planetName: "母星",
    position: { x: 0, y: 0 },
    rotation: 0 as const,
    mirror: "none" as const,
    queuedAt: 1,
    status: "pending-materials" as const,
    counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    semanticStatus: "catalog-backed" as const,
    reservedConstructionTotal: 0,
    reservedFleetTotal: 0,
    placedEntityCount: 0,
    actionable: false as const,
  };
  return {
    source: "native-core",
    readOnly: true,
    sessionId: "session-a",
    runId: "run-a",
    revision: 49,
    registryFingerprint: "registry-a",
    selectedBlueprintId: null,
    library: [],
    libraryById: new Map(),
    libraryPage: { cursor: 0, totalCount: 0, nextCursor: null },
    detail: null,
    queue: [other],
    queuePage: { cursor: 0, totalCount: 1, nextCursor: null },
    ...overrides,
  };
}

describe("native construction queue cancel reconciliation", () => {
  it("pins the exact three-key marker and rejects renderer refund payloads", () => {
    expect(pending()).toMatchObject({ phase: "dispatching", receipt: null });
    const forged = createNativeConstructionQueueCancelIntentCommand(48, BINDING.queueEntryId);
    (forged.topLevelChanges[0].value as Record<string, unknown>).reservedConstruction = {
      conveyor_belt_mk1: 999,
    };
    expect(() => createNativeConstructionQueueCancelPendingCommand({
      token: 1,
      source: source(),
      command: forged,
      binding: BINDING,
    })).toThrow();
  });

  it("uses exactly six read-only attempts and never resends mutation", async () => {
    const reconcile = vi.fn(async () => ({
      status: "pending" as const,
      baseRevision: 48,
      currentRevision: 48,
    }));
    const commandSource = source(reconcile);
    const waits: number[] = [];
    const result = await reconcileNativeConstructionQueueCancelPendingCommand({
      pending: updateNativeConstructionQueueCancelPendingCommand(pending(commandSource), "reconciling"),
      isCurrent: () => true,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(result).toEqual({ status: "blocked", reason: "pending-timeout" });
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
    expect(commandSource.applyCommand).not.toHaveBeenCalled();
    expect(NATIVE_CONSTRUCTION_QUEUE_CANCEL_RECONCILIATION_DELAYS_MS)
      .toEqual([0, 100, 250, 500, 1_000, 2_000]);
  });

  it("accepts only the exact compact topology-dirty receipt", async () => {
    const valid = source(vi.fn(async () => ({
      status: "committed" as const,
      receipt: receipt(),
    })));
    await expect(reconcileNativeConstructionQueueCancelPendingCommand({
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
    ]) {
      const invalid = source(vi.fn(async () => ({
        status: "committed" as const,
        receipt: receipt(forged),
      })));
      await expect(reconcileNativeConstructionQueueCancelPendingCommand({
        pending: pending(invalid),
        isCurrent: () => true,
        wait: async () => undefined,
      })).resolves.toEqual({ status: "blocked", reason: "receipt-invalid" });
    }
  });

  it("unlocks only proven non-commit and fails closed for conflict/unavailable", async () => {
    for (const [outcome, expected] of [
      [{ status: "not-committed" as const, baseRevision: 48, currentRevision: 48 }, { status: "not-committed" }],
      [{ status: "conflict" as const, baseRevision: 48, currentRevision: 50 }, { status: "blocked", reason: "conflict" }],
      [{ status: "unavailable" as const }, { status: "blocked", reason: "reconciliation-unavailable" }],
    ] as const) {
      await expect(reconcileNativeConstructionQueueCancelPendingCommand({
        pending: pending(source(vi.fn(async () => outcome))),
        isCurrent: () => true,
        wait: async () => undefined,
      })).resolves.toEqual(expected);
    }
  });

  it("confirms only a target-bound same-revision global absence proof", () => {
    const awaiting = updateNativeConstructionQueueCancelPendingCommand(pending(), "awaiting-projection", {
      receipt: receipt(),
    });
    expect(evaluateNativeConstructionQueueCancelPendingProjection(awaiting, null, null))
      .toEqual({ status: "waiting" });
    expect(evaluateNativeConstructionQueueCancelPendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 50 }),
    )).toEqual({ status: "waiting" });
    const absentAt50 = attachNativeConstructionQueueCancelMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      queueEntryId: "queue-target",
      present: false,
    });
    // Another order may complete after the cancellation ACK; total-count deltas are not proof.
    expect(evaluateNativeConstructionQueueCancelPendingProjection(
      absentAt50,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({
        revision: 50,
        queue: [],
        queuePage: { cursor: 0, totalCount: 0, nextCursor: null },
      }),
    )).toEqual({ status: "confirmed" });

    // A target can move outside the visible 32-row page and must not be mistaken for absence.
    const presentAcrossPage = attachNativeConstructionQueueCancelMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      queueEntryId: "queue-target",
      present: true,
    });
    expect(evaluateNativeConstructionQueueCancelPendingProjection(
      presentAcrossPage,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({
        revision: 50,
        queue: Array.from({ length: 32 }, (_, index) => ({
          ...projected().queue[0],
          id: `queue-visible-${index}`,
        })),
        queuePage: { cursor: 0, totalCount: 40, nextCursor: 32 },
      }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });

    const staleProof = attachNativeConstructionQueueCancelMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 49,
      registryFingerprint: "registry-a",
      queueEntryId: "queue-target",
      present: false,
    });
    expect(evaluateNativeConstructionQueueCancelPendingProjection(
      staleProof,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 50 }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
    expect(() => attachNativeConstructionQueueCancelMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      queueEntryId: "queue-other",
      present: false,
    })).toThrow();
    expect(evaluateNativeConstructionQueueCancelPendingProjection(
      awaiting,
      { sessionId: "session-new", runId: "run-new", revision: 1 },
      null,
    )).toEqual({ status: "lineage-changed" });
  });
});
