import { describe, expect, it, vi } from "vitest";

import {
  createNativeBlueprintRecipeOverridePendingCommand,
  evaluateNativeBlueprintRecipeOverridePendingProjection,
  NATIVE_BLUEPRINT_RECIPE_OVERRIDE_RECONCILIATION_DELAYS_MS,
  reconcileNativeBlueprintRecipeOverridePendingCommand,
  updateNativeBlueprintRecipeOverridePendingCommand,
} from "./nativeBlueprintRecipeOverrideCommandReconciliation";
import { createNativeBlueprintRecipeOverrideIntentCommand } from "./nativeBlueprintRecipeOverrideIntentCommands";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import type { NativeBlueprintRecipeOverrideBinding } from "./nativeBlueprintWorkspaceStore";

const TARGET_RECIPE_ID = "recipe:steel";
const BINDING: NativeBlueprintRecipeOverrideBinding = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 48,
  registryFingerprint: "registry-a",
  blueprintId: "mod:opaque/rocket",
  currentRowRevision: 4,
  sourceRecipeId: "recipe:iron-ingot",
  currentTargetRecipeId: "recipe:iron-ingot",
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
  return createNativeBlueprintRecipeOverridePendingCommand({
    token: 7,
    source: commandSource,
    command: createNativeBlueprintRecipeOverrideIntentCommand(
      48,
      BINDING.blueprintId,
      BINDING.sourceRecipeId,
      TARGET_RECIPE_ID,
    ),
    binding: BINDING,
    targetRecipeId: TARGET_RECIPE_ID,
  });
}

function projected(overrides: Partial<NativeBlueprintRecipeOverrideBinding> = {}) {
  return Object.freeze({
    ...BINDING,
    revision: 49,
    currentRowRevision: 5,
    currentTargetRecipeId: TARGET_RECIPE_ID,
    ...overrides,
  });
}

describe("native blueprint recipe override command reconciliation", () => {
  it("pins the exact four-key marker and rejects another intent or forged shape", () => {
    expect(pending()).toMatchObject({
      phase: "dispatching",
      targetRecipeId: TARGET_RECIPE_ID,
      receipt: null,
    });
    const wrongKind = createNativeBlueprintRecipeOverrideIntentCommand(
      48,
      BINDING.blueprintId,
      BINDING.sourceRecipeId,
      TARGET_RECIPE_ID,
    );
    wrongKind.topLevelChanges[0].value = {
      kind: "transform",
      id: BINDING.blueprintId,
      rotation: 90,
      mirror: "none",
    };
    expect(() => createNativeBlueprintRecipeOverridePendingCommand({
      token: 1,
      source: source(),
      command: wrongKind,
      binding: BINDING,
      targetRecipeId: TARGET_RECIPE_ID,
    })).toThrow();
    const extra = createNativeBlueprintRecipeOverrideIntentCommand(
      48,
      BINDING.blueprintId,
      BINDING.sourceRecipeId,
      TARGET_RECIPE_ID,
    );
    (extra.topLevelChanges[0].value as Record<string, unknown>).extra = true;
    expect(() => createNativeBlueprintRecipeOverridePendingCommand({
      token: 1,
      source: source(),
      command: extra,
      binding: BINDING,
      targetRecipeId: TARGET_RECIPE_ID,
    })).toThrow();
    const wrongSource = createNativeBlueprintRecipeOverrideIntentCommand(
      48,
      BINDING.blueprintId,
      "recipe:copper-ingot",
      TARGET_RECIPE_ID,
    );
    expect(() => createNativeBlueprintRecipeOverridePendingCommand({
      token: 1,
      source: source(),
      command: wrongSource,
      binding: BINDING,
      targetRecipeId: TARGET_RECIPE_ID,
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
    const result = await reconcileNativeBlueprintRecipeOverridePendingCommand({
      pending: updateNativeBlueprintRecipeOverridePendingCommand(current, "reconciling"),
      isCurrent: () => true,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(result).toEqual({ status: "blocked", reason: "pending-timeout" });
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
    expect(commandSource.applyCommand).not.toHaveBeenCalled();
    expect(NATIVE_BLUEPRINT_RECIPE_OVERRIDE_RECONCILIATION_DELAYS_MS).toEqual([
      0, 100, 250, 500, 1_000, 2_000,
    ]);
  });

  it("accepts only previousRevision, revision plus one, empty IDs and topologyDirty true", async () => {
    const validSource = source(vi.fn(async () => ({
      status: "committed" as const,
      receipt: receipt(),
    })));
    await expect(reconcileNativeBlueprintRecipeOverridePendingCommand({
      pending: pending(validSource),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "committed", receipt: receipt() });

    for (const forged of [
      { changedEntityIds: ["entity-a"] },
      { changedBeltIds: ["belt-a"] },
      { changedEntityIds: "" },
      { changedBeltIds: "" },
      { topologyDirty: false },
      { previousRevision: 47 },
      { revision: 50 },
    ]) {
      const invalidSource = source(vi.fn(async () => ({
        status: "committed" as const,
        receipt: receipt(forged),
      })));
      await expect(reconcileNativeBlueprintRecipeOverridePendingCommand({
        pending: pending(invalidSource),
        isCurrent: () => true,
        wait: async () => undefined,
      })).resolves.toEqual({ status: "blocked", reason: "receipt-invalid" });
    }
  });

  it("unlocks only a proven non-commit while conflict and unavailable stay locked", async () => {
    const notCommitted = source(vi.fn(async () => ({
      status: "not-committed" as const,
      baseRevision: 48,
      currentRevision: 48,
    })));
    await expect(reconcileNativeBlueprintRecipeOverridePendingCommand({
      pending: pending(notCommitted),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "not-committed" });

    const conflict = source(vi.fn(async () => ({
      status: "conflict" as const,
      baseRevision: 48,
      currentRevision: 50,
    })));
    await expect(reconcileNativeBlueprintRecipeOverridePendingCommand({
      pending: pending(conflict),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "blocked", reason: "conflict" });

    const unavailable = source(vi.fn(async () => ({
      status: "unavailable" as const,
      baseRevision: 48,
      currentRevision: null,
    })));
    await expect(reconcileNativeBlueprintRecipeOverridePendingCommand({
      pending: pending(unavailable),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "blocked", reason: "reconciliation-unavailable" });
  });

  it("confirms only the same source at old row revision plus one and the exact target", () => {
    const awaiting = updateNativeBlueprintRecipeOverridePendingCommand(
      pending(),
      "awaiting-projection",
      { receipt: receipt() },
    );
    expect(evaluateNativeBlueprintRecipeOverridePendingProjection(awaiting, null, null))
      .toEqual({ status: "waiting" });
    expect(evaluateNativeBlueprintRecipeOverridePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 49 }),
    )).toEqual({ status: "waiting" });
    expect(evaluateNativeBlueprintRecipeOverridePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 50 }),
    )).toEqual({ status: "confirmed" });
    for (const drift of [
      { currentRowRevision: 6 },
      { currentTargetRecipeId: BINDING.currentTargetRecipeId },
      { sourceRecipeId: "recipe:copper-ingot" },
      { blueprintId: "blueprint-b" },
      { registryFingerprint: "registry-b" },
    ]) {
      expect(evaluateNativeBlueprintRecipeOverridePendingProjection(
        awaiting,
        { sessionId: "session-a", runId: "run-a", revision: 50 },
        projected({ revision: 50, ...drift }),
      )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
    }
  });

  it("retires only on explicit session/run handoff", () => {
    const awaiting = updateNativeBlueprintRecipeOverridePendingCommand(
      pending(),
      "awaiting-projection",
      { receipt: receipt() },
    );
    expect(evaluateNativeBlueprintRecipeOverridePendingProjection(
      awaiting,
      { sessionId: "session-b", runId: "run-b", revision: 0 },
      null,
    )).toEqual({ status: "lineage-changed" });
    expect(evaluateNativeBlueprintRecipeOverridePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 49 },
      projected({ registryFingerprint: "registry-b" }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
  });
});
