import { describe, expect, it, vi } from "vitest";

import {
  createNativeBlueprintDeletePendingCommand,
  evaluateNativeBlueprintDeletePendingProjection,
  NATIVE_BLUEPRINT_DELETE_RECONCILIATION_DELAYS_MS,
  reconcileNativeBlueprintDeletePendingCommand,
  updateNativeBlueprintDeletePendingCommand,
} from "./nativeBlueprintDeleteCommandReconciliation";
import { createNativeBlueprintDeleteIntentCommand } from "./nativeBlueprintDeleteIntentCommands";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintDeleteBinding,
  NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";

const BINDING: NativeBlueprintDeleteBinding = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 48,
  registryFingerprint: "registry-a",
  blueprintId: "mod:opaque/rocket",
  currentRowRevision: 4,
  libraryTotalCount: 2,
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
  return createNativeBlueprintDeletePendingCommand({
    token: 7,
    source: commandSource,
    command: createNativeBlueprintDeleteIntentCommand(48, BINDING.blueprintId, 4),
    binding: BINDING,
  });
}

function projected(overrides: Partial<NativeBlueprintWorkspaceFrame> = {}): NativeBlueprintWorkspaceFrame {
  const other = {
    id: "other-blueprint",
    name: "保留蓝图",
    revision: 2,
    rotation: 0 as const,
    mirror: "none" as const,
    counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    detailStatus: "candidate" as const,
  };
  return {
    source: "native-core",
    readOnly: true,
    sessionId: "session-a",
    runId: "run-a",
    revision: 49,
    registryFingerprint: "registry-a",
    selectedBlueprintId: null,
    library: [other],
    libraryById: new Map([[other.id, other]]),
    libraryPage: { cursor: 0, totalCount: 1, nextCursor: null },
    detail: null,
    queue: [],
    queuePage: { cursor: 0, totalCount: 1, nextCursor: null },
    ...overrides,
  };
}

describe("native blueprint delete command reconciliation", () => {
  it("pins the exact three-key marker and rejects forged command shapes", () => {
    expect(pending()).toMatchObject({ phase: "dispatching", receipt: null });
    const wrongKind = createNativeBlueprintDeleteIntentCommand(48, BINDING.blueprintId, 4);
    wrongKind.topLevelChanges[0].value = {
      kind: "rename",
      id: BINDING.blueprintId,
      name: "forged",
    };
    expect(() => createNativeBlueprintDeletePendingCommand({
      token: 1,
      source: source(),
      command: wrongKind,
      binding: BINDING,
    })).toThrow();
    const extra = createNativeBlueprintDeleteIntentCommand(48, BINDING.blueprintId, 4);
    (extra.topLevelChanges[0].value as Record<string, unknown>).extra = true;
    expect(() => createNativeBlueprintDeletePendingCommand({
      token: 1,
      source: source(),
      command: extra,
      binding: BINDING,
    })).toThrow();
  });

  it("uses exactly six read-only attempts and never invokes mutation during timeout", async () => {
    const reconcile = vi.fn(async () => ({
      status: "pending" as const,
      baseRevision: 48,
      currentRevision: 48,
    }));
    const commandSource = source(reconcile);
    const waits: number[] = [];
    const result = await reconcileNativeBlueprintDeletePendingCommand({
      pending: updateNativeBlueprintDeletePendingCommand(pending(commandSource), "reconciling"),
      isCurrent: () => true,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(result).toEqual({ status: "blocked", reason: "pending-timeout" });
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
    expect(commandSource.applyCommand).not.toHaveBeenCalled();
    expect(NATIVE_BLUEPRINT_DELETE_RECONCILIATION_DELAYS_MS)
      .toEqual([0, 100, 250, 500, 1_000, 2_000]);
  });

  it("accepts only the compact empty-ID topology-dirty receipt", async () => {
    const validSource = source(vi.fn(async () => ({
      status: "committed" as const,
      receipt: receipt(),
    })));
    await expect(reconcileNativeBlueprintDeletePendingCommand({
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
      await expect(reconcileNativeBlueprintDeletePendingCommand({
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
    await expect(reconcileNativeBlueprintDeletePendingCommand({
      pending: pending(notCommitted),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "not-committed" });

    const conflict = source(vi.fn(async () => ({
      status: "conflict" as const,
      baseRevision: 48,
      currentRevision: 50,
    })));
    await expect(reconcileNativeBlueprintDeletePendingCommand({
      pending: pending(conflict),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "blocked", reason: "conflict" });

    const unavailable = source(vi.fn(async () => ({ status: "unavailable" as const })));
    await expect(reconcileNativeBlueprintDeletePendingCommand({
      pending: pending(unavailable),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "blocked", reason: "reconciliation-unavailable" });
  });

  it("confirms only an exact same-lineage deletion projection, even after later ticks", () => {
    const awaiting = updateNativeBlueprintDeletePendingCommand(pending(), "awaiting-projection", {
      receipt: receipt(),
    });
    expect(evaluateNativeBlueprintDeletePendingProjection(awaiting, null, null))
      .toEqual({ status: "waiting" });
    expect(evaluateNativeBlueprintDeletePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 49 }),
    )).toEqual({ status: "waiting" });
    expect(evaluateNativeBlueprintDeletePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 50 }),
    )).toEqual({ status: "confirmed" });
    expect(evaluateNativeBlueprintDeletePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 50, libraryPage: { cursor: 0, totalCount: 2, nextCursor: null } }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
    expect(evaluateNativeBlueprintDeletePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected({ revision: 50, queuePage: { cursor: 0, totalCount: 0, nextCursor: null } }),
    )).toEqual({ status: "confirmed" });
  });

  it("blocks selection/registry drift and retires only an explicit session/run handoff", () => {
    const awaiting = updateNativeBlueprintDeletePendingCommand(pending(), "awaiting-projection", {
      receipt: receipt(),
    });
    expect(evaluateNativeBlueprintDeletePendingProjection(
      awaiting,
      { sessionId: "session-b", runId: "run-b", revision: 0 },
      null,
    )).toEqual({ status: "lineage-changed" });
    expect(evaluateNativeBlueprintDeletePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 49 },
      projected({ registryFingerprint: "registry-b" }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
    expect(evaluateNativeBlueprintDeletePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 49 },
      projected({ selectedBlueprintId: "other-blueprint" }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
    const target = {
      id: BINDING.blueprintId,
      name: "目标仍存在",
      revision: 4,
      rotation: 90 as const,
      mirror: "horizontal" as const,
      counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
      detailStatus: "candidate" as const,
    };
    expect(evaluateNativeBlueprintDeletePendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 49 },
      projected({ libraryById: new Map([[target.id, target]]) }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
  });
});
