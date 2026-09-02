import { describe, expect, it, vi } from "vitest";

import {
  attachNativeBlueprintCaptureMembershipProof,
  createNativeBlueprintCapturePendingCommand,
  evaluateNativeBlueprintCapturePendingProjection,
  NATIVE_BLUEPRINT_CAPTURE_RECONCILIATION_DELAYS_MS,
  reconcileNativeBlueprintCapturePendingCommand,
  updateNativeBlueprintCapturePendingCommand,
} from "./nativeBlueprintCaptureCommandReconciliation";
import type { NativeBlueprintCaptureContext } from "./nativeBlueprintCaptureContext";
import { createNativeBlueprintCaptureIntentCommand } from "./nativeBlueprintCaptureIntentCommands";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";

const CONTEXT: NativeBlueprintCaptureContext = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  schemaVersion: 1,
  projectionType: "blueprint-capture-context-v1",
  source: "native-core",
  revision: 48,
  stateVersion: 47,
  registryFingerprint: "registry-a",
  request: Object.freeze({
    expectedRevision: 48,
    expectedRegistryFingerprint: "registry-a",
    entityIds: Object.freeze(["entity-z", "entity-a"]),
  }),
  activePlanetId: "planet-a",
  support: Object.freeze({ supported: true, reason: null }),
  expectedBlueprintId: "blueprint_17",
  expectedBlueprintName: "蓝图 08",
  expectedBlueprintRevision: 1,
  limits: Object.freeze({
    selectionEntityIds: 512,
    blueprintEntities: 512,
    blueprintBelts: 1_024,
    opaqueIdBytes: 512,
    projectionBytes: 1_048_576,
  }),
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
  return createNativeBlueprintCapturePendingCommand({
    token: 7,
    source: commandSource,
    command: createNativeBlueprintCaptureIntentCommand(CONTEXT),
    context: CONTEXT,
  });
}

function awaiting() {
  return updateNativeBlueprintCapturePendingCommand(pending(), "awaiting-projection", {
    receipt: receipt(),
  });
}

describe("native blueprint capture reconciliation", () => {
  it("pins the exact ordered marker and rejects derived capture fields", () => {
    expect(pending()).toMatchObject({
      phase: "dispatching",
      activePlanetId: "planet-a",
      entityIds: ["entity-z", "entity-a"],
      expectedBlueprintId: "blueprint_17",
      expectedBlueprintName: "蓝图 08",
      expectedBlueprintRevision: 1,
      receipt: null,
      membershipProof: null,
    });
    for (const [key, value] of [
      ["planetId", "planet-a"],
      ["inventory", { assembler: 1 }],
      ["nextId", 18],
      ["blueprintId", "blueprint_17"],
    ] as const) {
      const forged = createNativeBlueprintCaptureIntentCommand(CONTEXT);
      (forged.topLevelChanges[0].value as Record<string, unknown>)[key] = value;
      expect(() => createNativeBlueprintCapturePendingCommand({
        token: 1, source: source(), command: forged, context: CONTEXT,
      })).toThrow();
    }
    const reordered = createNativeBlueprintCaptureIntentCommand(CONTEXT);
    (reordered.topLevelChanges[0].value as Record<string, unknown>).entityIds = ["entity-a", "entity-z"];
    expect(() => createNativeBlueprintCapturePendingCommand({
      token: 1, source: source(), command: reordered, context: CONTEXT,
    })).toThrow();
  });

  it("uses exactly six read-only receipt attempts and never resends", async () => {
    for (const [outcome, expectedReason] of [
      [{ status: "pending" as const, baseRevision: 48, currentRevision: 48 }, "pending-timeout"],
      [{ status: "unavailable" as const }, "reconciliation-unavailable"],
    ] as const) {
      const reconcile = vi.fn(async () => outcome);
      const commandSource = source(reconcile);
      const waits: number[] = [];
      await expect(reconcileNativeBlueprintCapturePendingCommand({
        pending: updateNativeBlueprintCapturePendingCommand(pending(commandSource), "reconciling"),
        isCurrent: () => true,
        wait: async (milliseconds) => { waits.push(milliseconds); },
      })).resolves.toEqual({ status: "blocked", reason: expectedReason });
      expect(reconcile).toHaveBeenCalledTimes(6);
      expect(commandSource.applyCommand).not.toHaveBeenCalled();
      expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
    }
    expect(NATIVE_BLUEPRINT_CAPTURE_RECONCILIATION_DELAYS_MS)
      .toEqual([0, 100, 250, 500, 1_000, 2_000]);
  });

  it("accepts only exact R+1 empty-ID topology-dirty receipt", async () => {
    await expect(reconcileNativeBlueprintCapturePendingCommand({
      pending: pending(source(vi.fn(async () => ({
        status: "committed" as const,
        receipt: receipt(),
      })))),
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
      await expect(reconcileNativeBlueprintCapturePendingCommand({
        pending: pending(source(vi.fn(async () => ({
          status: "committed" as const,
          receipt: receipt(forged),
        })))),
        isCurrent: () => true,
        wait: async () => undefined,
      })).resolves.toEqual({ status: "blocked", reason: "receipt-invalid" });
    }
  });

  it("confirms only exact present same-revision library membership", () => {
    const withProof = attachNativeBlueprintCaptureMembershipProof(awaiting(), {
      sessionId: "session-a",
      runId: "run-a",
      revision: 49,
      registryFingerprint: "registry-a",
      blueprintId: "blueprint_17",
      present: true,
    });
    expect(evaluateNativeBlueprintCapturePendingProjection(withProof, {
      sessionId: "session-a", runId: "run-a", revision: 49,
    })).toEqual({ status: "confirmed" });
    const absent = attachNativeBlueprintCaptureMembershipProof(awaiting(), {
      sessionId: "session-a",
      runId: "run-a",
      revision: 49,
      registryFingerprint: "registry-a",
      blueprintId: "blueprint_17",
      present: false,
    });
    expect(evaluateNativeBlueprintCapturePendingProjection(absent, {
      sessionId: "session-a", runId: "run-a", revision: 49,
    })).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
  });

  it("retires lineage change, re-reads stale proof and blocks future proof", () => {
    expect(evaluateNativeBlueprintCapturePendingProjection(awaiting(), {
      sessionId: "session-b", runId: "run-b", revision: 1,
    })).toEqual({ status: "lineage-changed" });
    const oldProof = attachNativeBlueprintCaptureMembershipProof(awaiting(), {
      sessionId: "session-a",
      runId: "run-a",
      revision: 49,
      registryFingerprint: "registry-a",
      blueprintId: "blueprint_17",
      present: true,
    });
    expect(evaluateNativeBlueprintCapturePendingProjection(oldProof, {
      sessionId: "session-a", runId: "run-a", revision: 50,
    })).toEqual({ status: "stale-proof" });
    const futureProof = attachNativeBlueprintCaptureMembershipProof(awaiting(), {
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      blueprintId: "blueprint_17",
      present: true,
    });
    expect(evaluateNativeBlueprintCapturePendingProjection(futureProof, {
      sessionId: "session-a", runId: "run-a", revision: 49,
    })).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
  });
});
