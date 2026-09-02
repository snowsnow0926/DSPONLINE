import { describe, expect, it, vi } from "vitest";

import {
  attachNativeConstructionQueueDeployMembershipProof,
  clearNativeConstructionQueueDeployMembershipProof,
  createNativeConstructionQueueDeployPendingCommand,
  evaluateNativeConstructionQueueDeployPendingProjection,
  NATIVE_CONSTRUCTION_QUEUE_DEPLOY_RECONCILIATION_DELAYS_MS,
  reconcileNativeConstructionQueueDeployPendingCommand,
  updateNativeConstructionQueueDeployPendingCommand,
} from "./nativeConstructionQueueDeployCommandReconciliation";
import { createNativeConstructionQueueDeployIntentCommand } from "./nativeConstructionQueueDeployIntentCommands";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import type { NativeConstructionQueueDeployBinding } from "./nativeBlueprintWorkspaceStore";

const BINDING: NativeConstructionQueueDeployBinding = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 48,
  registryFingerprint: "registry-a",
  queueEntryId: "construction_7",
  queueTotalCount: 2,
  queuePageCursor: 0,
  blueprintRevision: 3,
  status: "pending-materials",
  semanticStatus: "catalog-backed",
  counts: Object.freeze({ entities: 2, belts: 1, resourceAnchors: 0, externalPorts: 0 }),
  actionable: true,
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
  return createNativeConstructionQueueDeployPendingCommand({
    token: 7,
    source: commandSource,
    command: createNativeConstructionQueueDeployIntentCommand(48, BINDING.queueEntryId),
    binding: BINDING,
  });
}

describe("native construction queue deploy reconciliation", () => {
  it("pins the exact deploy marker and rejects renderer topology or blueprint payloads", () => {
    expect(pending()).toMatchObject({ phase: "dispatching", receipt: null, membershipProof: null });
    for (const forgedKey of ["blueprintId", "entityIds", "inventory", "nextId"]) {
      const forged = createNativeConstructionQueueDeployIntentCommand(48, BINDING.queueEntryId);
      (forged.topLevelChanges[0].value as Record<string, unknown>)[forgedKey] = "forged";
      expect(() => createNativeConstructionQueueDeployPendingCommand({
        token: 1,
        source: source(),
        command: forged,
        binding: BINDING,
      })).toThrow();
    }
  });

  it("uses exactly six read-only receipt attempts without resending mutation", async () => {
    const reconcile = vi.fn(async () => ({
      status: "pending" as const,
      baseRevision: 48,
      currentRevision: 48,
    }));
    const commandSource = source(reconcile);
    const waits: number[] = [];
    await expect(reconcileNativeConstructionQueueDeployPendingCommand({
      pending: updateNativeConstructionQueueDeployPendingCommand(pending(commandSource), "reconciling"),
      isCurrent: () => true,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    })).resolves.toEqual({ status: "blocked", reason: "pending-timeout" });
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(commandSource.applyCommand).not.toHaveBeenCalled();
    expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
    expect(NATIVE_CONSTRUCTION_QUEUE_DEPLOY_RECONCILIATION_DELAYS_MS)
      .toEqual([0, 100, 250, 500, 1_000, 2_000]);
  });

  it("accepts only a consecutive marker-only topology-dirty receipt", async () => {
    const valid = source(vi.fn(async () => ({
      status: "committed" as const,
      receipt: receipt(),
    })));
    await expect(reconcileNativeConstructionQueueDeployPendingCommand({
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
      { extra: true },
    ]) {
      const invalid = source(vi.fn(async () => ({
        status: "committed" as const,
        receipt: receipt(forged),
      })));
      await expect(reconcileNativeConstructionQueueDeployPendingCommand({
        pending: pending(invalid),
        isCurrent: () => true,
        wait: async () => undefined,
      })).resolves.toEqual({ status: "blocked", reason: "receipt-invalid" });
    }
  });

  it("confirms only exact same-lineage absence at the current authority revision", () => {
    const awaiting = updateNativeConstructionQueueDeployPendingCommand(pending(), "awaiting-projection", {
      receipt: receipt(),
    });
    expect(evaluateNativeConstructionQueueDeployPendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 49 },
    )).toEqual({ status: "waiting" });

    const absent = attachNativeConstructionQueueDeployMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      queueEntryId: "construction_7",
      present: false,
    });
    expect(evaluateNativeConstructionQueueDeployPendingProjection(
      absent,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
    )).toEqual({ status: "confirmed" });
    expect(evaluateNativeConstructionQueueDeployPendingProjection(
      absent,
      { sessionId: "session-a", runId: "run-a", revision: 51 },
    )).toEqual({ status: "stale-proof" });
    expect(clearNativeConstructionQueueDeployMembershipProof(absent).membershipProof).toBeNull();

    const present = attachNativeConstructionQueueDeployMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      queueEntryId: "construction_7",
      present: true,
    });
    expect(evaluateNativeConstructionQueueDeployPendingProjection(
      present,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
    expect(evaluateNativeConstructionQueueDeployPendingProjection(
      awaiting,
      { sessionId: "other-session", runId: "other-run", revision: 1 },
    )).toEqual({ status: "lineage-changed" });
  });

  it("rejects foreign registry, queue ID, future proof, or pre-receipt revision", () => {
    const awaiting = updateNativeConstructionQueueDeployPendingCommand(pending(), "awaiting-projection", {
      receipt: receipt(),
    });
    for (const proof of [
      { revision: 49, registryFingerprint: "registry-b", queueEntryId: "construction_7" },
      { revision: 49, registryFingerprint: "registry-a", queueEntryId: "other" },
      { revision: 48, registryFingerprint: "registry-a", queueEntryId: "construction_7" },
    ]) {
      expect(() => attachNativeConstructionQueueDeployMembershipProof(awaiting, {
        sessionId: "session-a",
        runId: "run-a",
        present: false,
        ...proof,
      })).toThrow();
    }
    const future = attachNativeConstructionQueueDeployMembershipProof(awaiting, {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      queueEntryId: "construction_7",
      present: false,
    });
    expect(evaluateNativeConstructionQueueDeployPendingProjection(
      future,
      { sessionId: "session-a", runId: "run-a", revision: 49 },
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
  });
});
