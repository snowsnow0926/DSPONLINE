import { describe, expect, it, vi } from "vitest";

import {
  createNativeConstructionQueueFundPendingCommand,
  evaluateNativeConstructionQueueFundPendingProjection,
  NATIVE_CONSTRUCTION_QUEUE_FUND_RECONCILIATION_DELAYS_MS,
  reconcileNativeConstructionQueueFundPendingCommand,
  updateNativeConstructionQueueFundPendingCommand,
} from "./nativeConstructionQueueFundCommandReconciliation";
import { createNativeConstructionQueueFundIntentCommand } from "./nativeConstructionQueueFundIntentCommands";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeConstructionQueueFundBinding,
} from "./nativeBlueprintWorkspaceStore";

const BINDING: NativeConstructionQueueFundBinding = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  revision: 48,
  registryFingerprint: "registry-a",
  queueEntryId: "queue-target",
  queueTotalCount: 2,
  queuePageCursor: 0,
  initialStatus: "pending-materials",
  initialReservedConstructionTotal: 3,
  initialReservedFleetTotal: 2,
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
  return createNativeConstructionQueueFundPendingCommand({
    token: 7,
    scope: "all",
    source: commandSource,
    command: createNativeConstructionQueueFundIntentCommand(48, BINDING.queueEntryId, "all"),
    binding: BINDING,
  });
}

function projected(
  revision: number,
  totals: { construction: number; fleet: number } = { construction: 4, fleet: 2 },
  overrides: Partial<NativeBlueprintWorkspaceFrame> = {},
): NativeBlueprintWorkspaceFrame {
  const target = {
    id: BINDING.queueEntryId,
    blueprintId: "blueprint-a",
    blueprintVersionId: "version-a",
    blueprintRevision: 1,
    blueprintName: "测试蓝图",
    planetId: "planet-a",
    planetName: "母星",
    position: { x: 1, y: 2 },
    rotation: 0 as const,
    mirror: "none" as const,
    queuedAt: 10,
    status: "pending-materials" as const,
    counts: { entities: 1, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    semanticStatus: "catalog-backed" as const,
    reservedConstructionTotal: totals.construction,
    reservedFleetTotal: totals.fleet,
    placedEntityCount: 0,
    actionable: false as const,
  };
  return {
    source: "native-core",
    readOnly: true,
    sessionId: "session-a",
    runId: "run-a",
    revision,
    registryFingerprint: "registry-a",
    selectedBlueprintId: null,
    library: [],
    libraryById: new Map(),
    libraryPage: { cursor: 0, totalCount: 0, nextCursor: null },
    detail: null,
    queue: [target],
    queuePage: { cursor: 0, totalCount: 2, nextCursor: null },
    ...overrides,
  };
}

describe("native construction queue fund reconciliation", () => {
  it("pins the exact fund marker and rejects renderer inventory payloads", () => {
    const forged = createNativeConstructionQueueFundIntentCommand(48, BINDING.queueEntryId, "all");
    (forged.topLevelChanges[0].value as Record<string, unknown>).reservedConstruction = { belt: 99 };
    expect(() => createNativeConstructionQueueFundPendingCommand({
      token: 1,
      scope: "all",
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
    const result = await reconcileNativeConstructionQueueFundPendingCommand({
      pending: updateNativeConstructionQueueFundPendingCommand(pending(commandSource), "reconciling"),
      isCurrent: () => true,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect(result).toEqual({ status: "blocked", reason: "pending-timeout" });
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([100, 250, 500, 1_000, 2_000]);
    expect(commandSource.applyCommand).not.toHaveBeenCalled();
    expect(NATIVE_CONSTRUCTION_QUEUE_FUND_RECONCILIATION_DELAYS_MS)
      .toEqual([0, 100, 250, 500, 1_000, 2_000]);
  });

  it("accepts only R+1 empty dirty IDs with topology invalidation", async () => {
    const valid = source(vi.fn(async () => ({ status: "committed" as const, receipt: receipt() })));
    await expect(reconcileNativeConstructionQueueFundPendingCommand({
      pending: pending(valid),
      isCurrent: () => true,
      wait: async () => undefined,
    })).resolves.toEqual({ status: "committed", receipt: receipt() });
    for (const forged of [
      { revision: 50 }, { previousRevision: 47 }, { changedEntityIds: ["entity-a"] },
      { changedBeltIds: ["belt-a"] }, { topologyDirty: false },
    ]) {
      await expect(reconcileNativeConstructionQueueFundPendingCommand({
        pending: pending(source(vi.fn(async () => ({
          status: "committed" as const,
          receipt: receipt(forged),
        })))),
        isCurrent: () => true,
        wait: async () => undefined,
      })).resolves.toEqual({ status: "blocked", reason: "receipt-invalid" });
    }
  });

  it("waits below R+1 and confirms totals changed at R+1 or any later revision", () => {
    const awaiting = updateNativeConstructionQueueFundPendingCommand(pending(), "awaiting-projection", {
      receipt: receipt(),
    });
    expect(evaluateNativeConstructionQueueFundPendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 48 },
      projected(48),
    )).toEqual({ status: "waiting" });
    for (const revision of [49, 50, 57]) {
      expect(evaluateNativeConstructionQueueFundPendingProjection(
        awaiting,
        { sessionId: "session-a", runId: "run-a", revision },
        projected(revision),
      )).toEqual({ status: "confirmed" });
    }
    expect(evaluateNativeConstructionQueueFundPendingProjection(
      awaiting,
      { sessionId: "session-a", runId: "run-a", revision: 50 },
      projected(50, { construction: 1, fleet: 2 }),
    )).toEqual({ status: "confirmed" });
  });

  it("blocks unchanged totals, page drift, missing rows, and changed semantics", () => {
    const awaiting = updateNativeConstructionQueueFundPendingCommand(pending(), "awaiting-projection", {
      receipt: receipt(),
    });
    const authority = { sessionId: "session-a", runId: "run-a", revision: 49 };
    expect(evaluateNativeConstructionQueueFundPendingProjection(
      awaiting, authority, projected(49, { construction: 3, fleet: 2 }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
    expect(evaluateNativeConstructionQueueFundPendingProjection(
      awaiting, authority, projected(49, undefined, {
        queuePage: { cursor: 32, totalCount: 2, nextCursor: null },
      }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
    expect(evaluateNativeConstructionQueueFundPendingProjection(
      awaiting, authority, projected(49, undefined, { queue: [] }),
    )).toEqual({ status: "blocked", reason: "receipt-projection-mismatch" });
    expect(evaluateNativeConstructionQueueFundPendingProjection(
      awaiting,
      { sessionId: "other", runId: "other", revision: 1 },
      null,
    )).toEqual({ status: "lineage-changed" });
  });
});

