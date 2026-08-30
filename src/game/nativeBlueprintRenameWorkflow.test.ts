import { describe, expect, it } from "vitest";
import type {
  NativeBlueprintRenameIdentity,
  NativeBlueprintWorkspaceFrame,
  NativeBlueprintWorkspaceIdentity,
} from "./nativeBlueprintWorkspaceStore";
import {
  acknowledgeNativeBlueprintRename,
  nativeBlueprintRenameEditorTargetState,
  reconcileNativeBlueprintRename,
  settleNativeBlueprintRenameFailure,
  type NativeBlueprintRenamePendingIdentity,
} from "./nativeBlueprintRenameWorkflow";

const IDENTITY: NativeBlueprintRenameIdentity = Object.freeze({
  sessionId: "session-a",
  runId: "run-a",
  registryFingerprint: "registry-a",
  blueprintId: "blueprint-a",
  currentName: "原名",
  currentRevision: 4,
});

function workspaceIdentity(revision: number): NativeBlueprintWorkspaceIdentity {
  return Object.freeze({
    sessionId: IDENTITY.sessionId,
    runId: IDENTITY.runId,
    revision,
    registryFingerprint: IDENTITY.registryFingerprint,
  });
}

function frame(
  revision: number,
  name = IDENTITY.currentName,
  rowRevision = IDENTITY.currentRevision,
  overrides: Partial<NativeBlueprintWorkspaceFrame> = {},
): NativeBlueprintWorkspaceFrame {
  const row = Object.freeze({
    id: IDENTITY.blueprintId,
    name,
    revision: rowRevision,
    rotation: 0 as const,
    mirror: "none" as const,
    counts: { entities: 0, belts: 0, resourceAnchors: 0, externalPorts: 0 },
    detailStatus: "candidate" as const,
  });
  return {
    source: "native-core",
    readOnly: true,
    ...workspaceIdentity(revision),
    selectedBlueprintId: row.id,
    library: [row],
    libraryById: new Map([[row.id, row]]),
    libraryPage: { cursor: 0, totalCount: 1, nextCursor: null },
    detail: null,
    queue: [],
    queuePage: { cursor: 0, totalCount: 0, nextCursor: null },
    ...overrides,
  };
}

function pending(): NativeBlueprintRenamePendingIdentity {
  return Object.freeze({
    ...IDENTITY,
    submissionId: 7,
    commandRevision: 47,
    targetName: "新名",
    phase: "awaiting-ack",
    expectedRevision: null,
    conflictReason: null,
  });
}

const ACTIVE = Object.freeze({ sessionId: IDENTITY.sessionId, runId: IDENTITY.runId });

describe("native blueprint rename reconciliation", () => {
  it("keeps editor identity stable across global revisions and distinguishes lineage from row drift", () => {
    expect(nativeBlueprintRenameEditorTargetState(IDENTITY, workspaceIdentity(48), null)).toBe("syncing");
    expect(nativeBlueprintRenameEditorTargetState(IDENTITY, workspaceIdentity(48), frame(48))).toBe("ready");
    expect(nativeBlueprintRenameEditorTargetState(
      IDENTITY,
      { ...workspaceIdentity(48), runId: "other-run" },
      null,
    )).toBe("lineage-conflict");
    expect(nativeBlueprintRenameEditorTargetState(
      IDENTITY,
      workspaceIdentity(48),
      frame(48, "他处已改名", 5),
    )).toBe("row-conflict");
  });

  it("waits through ACK-before-projection and confirms only the exact target row", () => {
    const acknowledged = acknowledgeNativeBlueprintRename(
      pending(),
      7,
      { previousRevision: 47, revision: 48 },
    );
    expect(acknowledged.phase).toBe("awaiting-projection");
    expect(reconcileNativeBlueprintRename(acknowledged, {
      ownsRuntime: true,
      commandPending: false,
      activeIdentity: ACTIVE,
      latestIdentity: workspaceIdentity(48),
      frame: frame(47),
    })).toEqual({ pending: acknowledged, resolution: null });
    const confirmed = reconcileNativeBlueprintRename(acknowledged, {
      ownsRuntime: true,
      commandPending: false,
      activeIdentity: ACTIVE,
      latestIdentity: workspaceIdentity(48),
      frame: frame(48, "新名", 5),
    });
    expect(confirmed.pending).toBeNull();
    expect(confirmed.resolution).toMatchObject({
      status: "confirmed",
      submissionId: 7,
      commandRevision: 47,
      targetName: "新名",
      expectedRevision: 48,
    });
  });

  it("locks on an invalid durable receipt or a new projection with the wrong row", () => {
    const invalidAck = acknowledgeNativeBlueprintRename(
      pending(),
      7,
      { previousRevision: 46, revision: 48 },
    );
    expect(invalidAck).toMatchObject({ phase: "conflict", conflictReason: "projection-mismatch" });

    const acknowledged = acknowledgeNativeBlueprintRename(
      pending(),
      7,
      { previousRevision: 47, revision: 48 },
    );
    const wrongProjection = reconcileNativeBlueprintRename(acknowledged, {
      ownsRuntime: true,
      commandPending: false,
      activeIdentity: ACTIVE,
      latestIdentity: workspaceIdentity(48),
      frame: frame(48, "错误名称", 5),
    });
    expect(wrongProjection.pending).toMatchObject({
      phase: "conflict",
      conflictReason: "projection-mismatch",
    });
    expect(wrongProjection.resolution).toBeNull();
  });

  it("fails closed when the active or projected lineage drifts", () => {
    const acknowledged = acknowledgeNativeBlueprintRename(
      pending(),
      7,
      { previousRevision: 47, revision: 48 },
    );
    const result = reconcileNativeBlueprintRename(acknowledged, {
      ownsRuntime: true,
      commandPending: false,
      activeIdentity: { sessionId: IDENTITY.sessionId, runId: "other-run" },
      latestIdentity: { ...workspaceIdentity(48), registryFingerprint: "other-registry" },
      frame: null,
    });
    expect(result.pending).toMatchObject({ phase: "conflict", conflictReason: "lineage-drift" });
    expect(result.resolution).toBeNull();
  });

  it("holds the exact pending identity across a temporary authority handoff", () => {
    const acknowledged = acknowledgeNativeBlueprintRename(
      pending(),
      7,
      { previousRevision: 47, revision: 48 },
    );
    const held = reconcileNativeBlueprintRename(acknowledged, {
      ownsRuntime: false,
      commandPending: false,
      activeIdentity: null,
      latestIdentity: null,
      frame: null,
    });
    expect(held).toEqual({ pending: acknowledged, resolution: null });
  });

  it("restores the stable draft identity after a definite pre-ACK failure", () => {
    const result = settleNativeBlueprintRenameFailure(pending(), 7, "definite-failure");
    expect(result.pending).toBeNull();
    expect(result.resolution).toEqual({
      ...IDENTITY,
      status: "definite-failure",
      submissionId: 7,
      commandRevision: 47,
      targetName: "新名",
      expectedRevision: null,
    });
  });

  it("retains uncertain submissions for reconciliation without inventing an ACK", () => {
    const uncertain = settleNativeBlueprintRenameFailure(pending(), 7, "uncertain");
    expect(uncertain.resolution).toBeNull();
    expect(uncertain.pending).toMatchObject({ phase: "uncertain", expectedRevision: null });
    const reconciled = reconcileNativeBlueprintRename(uncertain.pending!, {
      ownsRuntime: true,
      commandPending: false,
      activeIdentity: ACTIVE,
      latestIdentity: workspaceIdentity(48),
      frame: frame(48, "新名", 5),
    });
    expect(reconciled.pending).toBe(uncertain.pending);
    expect(reconciled.resolution).toBeNull();
  });

  it("accepts an exact durable receipt discovered by read-only uncertain reconciliation", () => {
    const uncertain = settleNativeBlueprintRenameFailure(pending(), 7, "uncertain").pending!;
    const acknowledged = acknowledgeNativeBlueprintRename(
      uncertain,
      7,
      { previousRevision: 47, revision: 48 },
    );
    expect(acknowledged).toMatchObject({
      phase: "awaiting-projection",
      expectedRevision: 48,
      conflictReason: null,
    });
    expect(reconcileNativeBlueprintRename(acknowledged, {
      ownsRuntime: true,
      commandPending: false,
      activeIdentity: ACTIVE,
      latestIdentity: workspaceIdentity(48),
      frame: frame(48, "新名", 5),
    }).resolution).toMatchObject({ status: "confirmed", submissionId: 7 });
  });
});
