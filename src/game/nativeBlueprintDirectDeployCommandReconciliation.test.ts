import { describe, expect, it, vi } from "vitest";

import {
  createNativeBlueprintDirectDeployPendingCommand,
  evaluateNativeBlueprintDirectDeployTopology,
  NATIVE_BLUEPRINT_DIRECT_DEPLOY_RECONCILIATION_DELAYS_MS,
  reconcileNativeBlueprintDirectDeployPendingCommand,
  updateNativeBlueprintDirectDeployPendingCommand,
} from "./nativeBlueprintDirectDeployCommandReconciliation";
import type { NativeBlueprintDirectDeployContext } from "./nativeBlueprintDirectDeployContext";
import { createNativeBlueprintDirectDeployIntentCommand } from "./nativeBlueprintDirectDeployIntentCommands";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";

const CONTEXT: NativeBlueprintDirectDeployContext = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  schemaVersion: 1,
  projectionType: "blueprint-direct-deploy-context-v1",
  source: "native-core",
  revision: 48,
  stateVersion: 47,
  registryFingerprint: "registry-a",
  request: Object.freeze({
    expectedRevision: 48,
    expectedRegistryFingerprint: "registry-a",
    blueprintId: "ordinary-alpha",
    blueprintRevision: 3,
    position: Object.freeze({ x: 12.5, y: -7 }),
  }),
  activePlanetId: "planet-a",
  support: Object.freeze({ supported: true, reason: null }),
  limits: Object.freeze({ projectionBytes: 1_048_576 }),
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
  return createNativeBlueprintDirectDeployPendingCommand({
    token: 7,
    source: commandSource,
    command: createNativeBlueprintDirectDeployIntentCommand(CONTEXT),
    context: CONTEXT,
  });
}

describe("native blueprint direct deploy reconciliation", () => {
  it("pins the exact marker and rejects any renderer-owned derived deploy field", () => {
    expect(pending()).toMatchObject({
      phase: "dispatching",
      blueprintId: "ordinary-alpha",
      blueprintRevision: 3,
      activePlanetId: "planet-a",
      position: { x: 12.5, y: -7 },
      receipt: null,
    });
    for (const [key, value] of [
      ["planetId", "planet-a"],
      ["inventory", { assembler: 1 }],
      ["nextId", 17],
      ["rotation", 90],
      ["allowOverlap", false],
    ] as const) {
      const forged = createNativeBlueprintDirectDeployIntentCommand(CONTEXT);
      (forged.topLevelChanges[0].value as Record<string, unknown>)[key] = value;
      expect(() => createNativeBlueprintDirectDeployPendingCommand({
        token: 1,
        source: source(),
        command: forged,
        context: CONTEXT,
      })).toThrow();
    }
  });

  it("uses exactly six read-only attempts, never resends, and distinguishes all-pending/unavailable", async () => {
    for (const [outcome, expectedReason] of [
      [{ status: "pending" as const, baseRevision: 48, currentRevision: 48 }, "pending-timeout"],
      [{ status: "unavailable" as const }, "reconciliation-unavailable"],
    ] as const) {
      const reconcile = vi.fn(async () => outcome);
      const commandSource = source(reconcile);
      const waits: number[] = [];
      const result = await reconcileNativeBlueprintDirectDeployPendingCommand({
        pending: updateNativeBlueprintDirectDeployPendingCommand(pending(commandSource), "reconciling"),
        isCurrent: () => true,
        wait: async (milliseconds) => { waits.push(milliseconds); },
      });
      expect(result).toEqual({ status: "blocked", reason: expectedReason });
      expect(reconcile).toHaveBeenCalledTimes(6);
      expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
      expect(commandSource.applyCommand).not.toHaveBeenCalled();
    }
    expect(NATIVE_BLUEPRINT_DIRECT_DEPLOY_RECONCILIATION_DELAYS_MS)
      .toEqual([0, 100, 250, 500, 1_000, 2_000]);
  });

  it("accepts only the exact R+1 empty-id topology-dirty receipt", async () => {
    const valid = source(vi.fn(async () => ({
      status: "committed" as const,
      receipt: receipt(),
    })));
    await expect(reconcileNativeBlueprintDirectDeployPendingCommand({
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
      await expect(reconcileNativeBlueprintDirectDeployPendingCommand({
        pending: pending(source(vi.fn(async () => ({
          status: "committed" as const,
          receipt: receipt(forged),
        })))),
        isCurrent: () => true,
        wait: async () => undefined,
      })).resolves.toEqual({ status: "blocked", reason: "receipt-invalid" });
    }
  });

  it("unlocks only proven non-commit and fails closed for conflict or cancellation", async () => {
    await expect(reconcileNativeBlueprintDirectDeployPendingCommand({
      pending: pending(source(vi.fn(async () => ({
        status: "not-committed" as const, baseRevision: 48, currentRevision: 48,
      })))),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "not-committed" });
    await expect(reconcileNativeBlueprintDirectDeployPendingCommand({
      pending: pending(source(vi.fn(async () => ({
        status: "conflict" as const, baseRevision: 48, currentRevision: 49,
      })))),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "blocked", reason: "conflict" });
    await expect(reconcileNativeBlueprintDirectDeployPendingCommand({
      pending: pending(),
      isCurrent: () => false,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "cancelled" });
  });

  it("confirms ACK at any newer same-lineage/registry topology even after active planet changes", () => {
    const awaiting = updateNativeBlueprintDirectDeployPendingCommand(
      pending(),
      "awaiting-topology",
      { receipt: receipt() },
    );
    expect(evaluateNativeBlueprintDirectDeployTopology(awaiting, null))
      .toEqual({ status: "waiting" });
    expect(evaluateNativeBlueprintDirectDeployTopology(awaiting, {
      source: "native-authoritative",
      sessionId: "session-a",
      runId: "run-a",
      revision: 48,
      registryFingerprint: "registry-a",
      activePlanetId: "planet-a",
    })).toEqual({ status: "waiting" });
    expect(evaluateNativeBlueprintDirectDeployTopology(awaiting, {
      source: "native-authoritative",
      sessionId: "session-a",
      runId: "run-a",
      revision: 50,
      registryFingerprint: "registry-a",
      activePlanetId: "planet-b",
    })).toEqual({ status: "confirmed" });
  });

  it("retires on lineage change and blocks malformed or registry-mismatched topology", () => {
    const awaiting = updateNativeBlueprintDirectDeployPendingCommand(
      pending(),
      "awaiting-topology",
      { receipt: receipt() },
    );
    expect(evaluateNativeBlueprintDirectDeployTopology(awaiting, {
      source: "native-authoritative",
      sessionId: "session-b",
      runId: "run-b",
      revision: 1,
      registryFingerprint: "registry-b",
      activePlanetId: "planet-b",
    })).toEqual({ status: "lineage-changed" });
    expect(evaluateNativeBlueprintDirectDeployTopology(awaiting, {
      source: "native-authoritative",
      sessionId: "session-a",
      runId: "run-a",
      revision: 49,
      registryFingerprint: "registry-b",
      activePlanetId: "planet-a",
    })).toEqual({ status: "blocked", reason: "receipt-topology-mismatch" });
    expect(evaluateNativeBlueprintDirectDeployTopology(awaiting, {
      source: "native-authoritative",
      sessionId: "bad session",
      runId: "run-a",
      revision: 49,
      registryFingerprint: "registry-a",
      activePlanetId: "planet-a",
    })).toEqual({ status: "blocked", reason: "receipt-topology-mismatch" });
  });
});
