import { describe, expect, it, vi } from "vitest";

import {
  createNativeBlueprintTransformPendingCommand,
  evaluateNativeBlueprintTransformPendingProjection,
  NATIVE_BLUEPRINT_TRANSFORM_RECONCILIATION_DELAYS_MS,
  reconcileNativeBlueprintTransformPendingCommand,
  updateNativeBlueprintTransformPendingCommand,
} from "./nativeBlueprintTransformCommandReconciliation";
import { createNativeBlueprintTransformIntentCommand } from "./nativeBlueprintTransformIntentCommands";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import type { NativeBlueprintTransformBinding } from "./nativeBlueprintWorkspaceStore";

const BINDING: NativeBlueprintTransformBinding = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 48,
  registryFingerprint: "registry-a",
  blueprintId: "mod:opaque/rocket",
  currentRowRevision: 4,
  currentRotation: 90,
  currentMirror: "horizontal",
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
  return createNativeBlueprintTransformPendingCommand({
    token: 7,
    source: commandSource,
    command: createNativeBlueprintTransformIntentCommand(
      48,
      BINDING.blueprintId,
      180,
      "none",
    ),
    binding: BINDING,
    targetRotation: 180,
    targetMirror: "none",
  });
}

function projected(overrides: Partial<NativeBlueprintTransformBinding> = {}) {
  return Object.freeze({
    ...BINDING,
    revision: 49,
    currentRowRevision: 5,
    currentRotation: 180 as const,
    currentMirror: "none" as const,
    ...overrides,
  });
}

describe("native blueprint transform command reconciliation", () => {
  it("pins the exact four-key marker and rejects rename or forged command shapes", () => {
    expect(pending()).toMatchObject({
      phase: "dispatching",
      targetRotation: 180,
      targetMirror: "none",
      receipt: null,
    });
    const rename = createNativeBlueprintTransformIntentCommand(48, BINDING.blueprintId, 180, "none");
    rename.topLevelChanges[0].value = {
      kind: "rename",
      id: BINDING.blueprintId,
      name: "forged",
    };
    expect(() => createNativeBlueprintTransformPendingCommand({
      token: 1,
      source: source(),
      command: rename,
      binding: BINDING,
      targetRotation: 180,
      targetMirror: "none",
    })).toThrow();
    const extra = createNativeBlueprintTransformIntentCommand(48, BINDING.blueprintId, 180, "none");
    (extra.topLevelChanges[0].value as Record<string, unknown>).extra = true;
    expect(() => createNativeBlueprintTransformPendingCommand({
      token: 1,
      source: source(),
      command: extra,
      binding: BINDING,
      targetRotation: 180,
      targetMirror: "none",
    })).toThrow();
  });

  it("uses exactly six read-only attempts and never invokes mutation during timeout", async () => {
    const reconcile = vi.fn(async () => ({
      status: "pending" as const,
      baseRevision: 48,
      currentRevision: 48,
    }));
    const commandSource = source(reconcile);
    const current = pending(commandSource);
    const waits: number[] = [];
    const result = await reconcileNativeBlueprintTransformPendingCommand({
      pending: updateNativeBlueprintTransformPendingCommand(current, "reconciling"),
      isCurrent: () => true,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(result).toEqual({ status: "blocked", reason: "pending-timeout" });
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
    expect(commandSource.applyCommand).not.toHaveBeenCalled();
    expect(NATIVE_BLUEPRINT_TRANSFORM_RECONCILIATION_DELAYS_MS).toEqual([
      0, 100, 250, 500, 1_000, 2_000,
    ]);
  });

  it("accepts only the compact empty-ID topology-dirty receipt", async () => {
    const validSource = source(vi.fn(async () => ({
      status: "committed" as const,
      receipt: receipt(),
    })));
    await expect(reconcileNativeBlueprintTransformPendingCommand({
      pending: pending(validSource),
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
      const invalidSource = source(vi.fn(async () => ({
        status: "committed" as const,
        receipt: receipt(forged),
      })));
      await expect(reconcileNativeBlueprintTransformPendingCommand({
        pending: pending(invalidSource),
        isCurrent: () => true,
        wait: async () => undefined,
      })).resolves.toEqual({ status: "blocked", reason: "receipt-invalid" });
    }
  });

  it("unlocks only a proven non-commit while conflict and unavailable remain blocked", async () => {
    const notCommitted = source(vi.fn(async () => ({
      status: "not-committed" as const,
      baseRevision: 48,
      currentRevision: 48,
    })));
    await expect(reconcileNativeBlueprintTransformPendingCommand({
      pending: pending(notCommitted),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "not-committed" });

    const conflict = source(vi.fn(async () => ({
      status: "conflict" as const,
      baseRevision: 48,
      currentRevision: 50,
    })));
    await expect(reconcileNativeBlueprintTransformPendingCommand({
      pending: pending(conflict),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "blocked", reason: "conflict" });

    const unavailable = source(vi.fn(async () => ({
      status: "unavailable" as const,
      baseRevision: 48,
      currentRevision: null,
    })));
    await expect(reconcileNativeBlueprintTransformPendingCommand({
      pending: pending(unavailable),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "blocked", reason: "reconciliation-unavailable" });
  });

  it("waits for authority and frame, then confirms only old row revision plus one and the exact target pair", () => {
    const awaiting = updateNativeBlueprintTransformPendingCommand(pending(), "awaiting-projection", {
      receipt: receipt(),
    });
    expect(evaluateNativeBlueprintTransformPendingProjection(awaiting, null, null))
      .toEqual({ status: "waiting" });
    expect(evaluateNativeBlueprintTransformPendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 49 }),
    )).toEqual({ status: "waiting" });
    expect(evaluateNativeBlueprintTransformPendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 50 }),
    )).toEqual({ status: "confirmed" });
    expect(evaluateNativeBlueprintTransformPendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 50, currentRowRevision: 6 }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
    expect(evaluateNativeBlueprintTransformPendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 50, currentMirror: "horizontal" }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
  });

  it("ends only on explicit session/run handoff, not registry or row drift", () => {
    const awaiting = updateNativeBlueprintTransformPendingCommand(pending(), "awaiting-projection", {
      receipt: receipt(),
    });
    expect(evaluateNativeBlueprintTransformPendingProjection(
      awaiting,
      { sessionId: "session-b", runId: "run-b", revision: 0 },
      null,
    )).toEqual({ status: "lineage-changed" });
    expect(evaluateNativeBlueprintTransformPendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 49 },
      projected({ registryFingerprint: "registry-b" }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
  });
});
