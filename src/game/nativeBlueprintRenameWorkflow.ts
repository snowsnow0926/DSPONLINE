import type {
  NativeBlueprintRenameIdentity,
  NativeBlueprintWorkspaceFrame,
  NativeBlueprintWorkspaceIdentity,
} from "./nativeBlueprintWorkspaceStore";
import {
  nativeBlueprintRenameIdentityMatchesFrame,
  nativeBlueprintRenameLineageMatchesIdentity,
} from "./nativeBlueprintWorkspaceStore";

export type NativeBlueprintRenamePendingPhase =
  | "awaiting-ack"
  | "awaiting-projection"
  | "uncertain"
  | "conflict";

export type NativeBlueprintRenameConflictReason =
  | "lineage-drift"
  | "row-drift"
  | "projection-mismatch"
  | "ack-missing";

export interface NativeBlueprintRenamePendingIdentity extends NativeBlueprintRenameIdentity {
  readonly submissionId: number;
  readonly commandRevision: number;
  readonly targetName: string;
  readonly phase: NativeBlueprintRenamePendingPhase;
  readonly expectedRevision: number | null;
  readonly conflictReason: NativeBlueprintRenameConflictReason | null;
}

export type NativeBlueprintRenameSubmitOutcome = Readonly<
  | {
    status: "accepted";
    submissionId: number;
    commandRevision: number;
  }
  | {
    status: "rejected";
    reason: "closed" | "busy" | "stale" | "invalid" | "gate";
  }
>;

export interface NativeBlueprintRenameResolution extends NativeBlueprintRenameIdentity {
  readonly status: "confirmed" | "definite-failure";
  readonly submissionId: number;
  readonly commandRevision: number;
  readonly targetName: string;
  readonly expectedRevision: number | null;
}

export type NativeBlueprintRenameEditorTargetState =
  | "syncing"
  | "ready"
  | "lineage-conflict"
  | "row-conflict";

export function nativeBlueprintRenameEditorTargetState(
  identity: NativeBlueprintRenameIdentity,
  latestIdentity: NativeBlueprintWorkspaceIdentity | null,
  frame: NativeBlueprintWorkspaceFrame | null,
): NativeBlueprintRenameEditorTargetState {
  if (latestIdentity && !nativeBlueprintRenameLineageMatchesIdentity(identity, latestIdentity)) {
    return "lineage-conflict";
  }
  if (!frame) return "syncing";
  if (!nativeBlueprintRenameLineageMatchesIdentity(identity, frame)) return "lineage-conflict";
  return nativeBlueprintRenameIdentityMatchesFrame(identity, frame) ? "ready" : "row-conflict";
}

export function acknowledgeNativeBlueprintRename(
  pending: NativeBlueprintRenamePendingIdentity,
  submissionId: number,
  receipt: Readonly<{ previousRevision: number; revision: number }>,
): NativeBlueprintRenamePendingIdentity {
  if (pending.submissionId !== submissionId || pending.phase !== "awaiting-ack") return pending;
  if (receipt.previousRevision !== pending.commandRevision ||
      receipt.revision !== pending.commandRevision + 1) {
    return Object.freeze({
      ...pending,
      phase: "conflict" as const,
      expectedRevision: null,
      conflictReason: "projection-mismatch" as const,
    });
  }
  return Object.freeze({
    ...pending,
    phase: "awaiting-projection" as const,
    expectedRevision: receipt.revision,
    conflictReason: null,
  });
}
export function settleNativeBlueprintRenameFailure(
  pending: NativeBlueprintRenamePendingIdentity,
  submissionId: number,
  failure: "definite-failure" | "uncertain",
): Readonly<{
  pending: NativeBlueprintRenamePendingIdentity | null;
  resolution: NativeBlueprintRenameResolution | null;
}> {
  if (pending.submissionId !== submissionId) {
    return Object.freeze({ pending, resolution: null });
  }
  if (failure === "uncertain") {
    return Object.freeze({
      pending: Object.freeze({
        ...pending,
        phase: "uncertain" as const,
        expectedRevision: null,
        conflictReason: null,
      }),
      resolution: null,
    });
  }
  return Object.freeze({
    pending: null,
    resolution: Object.freeze({
      status: "definite-failure" as const,
      submissionId: pending.submissionId,
      commandRevision: pending.commandRevision,
      sessionId: pending.sessionId,
      runId: pending.runId,
      registryFingerprint: pending.registryFingerprint,
      blueprintId: pending.blueprintId,
      currentName: pending.currentName,
      currentRevision: pending.currentRevision,
      targetName: pending.targetName,
      expectedRevision: pending.expectedRevision,
    }),
  });
}

function conflict(
  pending: NativeBlueprintRenamePendingIdentity,
  reason: NativeBlueprintRenameConflictReason,
): NativeBlueprintRenamePendingIdentity {
  if (pending.phase === "conflict" && pending.conflictReason === reason) return pending;
  return Object.freeze({ ...pending, phase: "conflict" as const, conflictReason: reason });
}

export function reconcileNativeBlueprintRename(
  pending: NativeBlueprintRenamePendingIdentity,
  input: Readonly<{
    ownsRuntime: boolean;
    commandPending: boolean;
    activeIdentity: Pick<NativeBlueprintWorkspaceIdentity, "sessionId" | "runId"> | null;
    latestIdentity: NativeBlueprintWorkspaceIdentity | null;
    frame: NativeBlueprintWorkspaceFrame | null;
  }>,
): Readonly<{
  pending: NativeBlueprintRenamePendingIdentity | null;
  resolution: NativeBlueprintRenameResolution | null;
}> {
  if (!input.ownsRuntime || input.activeIdentity && (
    input.activeIdentity.sessionId !== pending.sessionId || input.activeIdentity.runId !== pending.runId
  ) || input.latestIdentity && !nativeBlueprintRenameLineageMatchesIdentity(pending, input.latestIdentity)) {
    return Object.freeze({ pending: conflict(pending, "lineage-drift"), resolution: null });
  }
  if (pending.phase === "uncertain" || pending.phase === "conflict") {
    return Object.freeze({ pending, resolution: null });
  }
  if (pending.phase === "awaiting-ack") {
    return Object.freeze({
      pending: input.commandPending ? pending : conflict(pending, "ack-missing"),
      resolution: null,
    });
  }
  if (pending.expectedRevision === null) {
    return Object.freeze({ pending: conflict(pending, "ack-missing"), resolution: null });
  }
  if (input.commandPending || !input.frame || input.frame.revision < pending.expectedRevision) {
    return Object.freeze({ pending, resolution: null });
  }
  if (!nativeBlueprintRenameLineageMatchesIdentity(pending, input.frame)) {
    return Object.freeze({ pending: conflict(pending, "lineage-drift"), resolution: null });
  }
  const row = input.frame.libraryById.get(pending.blueprintId);
  if (input.frame.selectedBlueprintId !== pending.blueprintId ||
      row?.name !== pending.targetName || row.revision !== pending.currentRevision + 1) {
    return Object.freeze({ pending: conflict(pending, "projection-mismatch"), resolution: null });
  }
  return Object.freeze({
    pending: null,
    resolution: Object.freeze({
      status: "confirmed" as const,
      submissionId: pending.submissionId,
      commandRevision: pending.commandRevision,
      sessionId: pending.sessionId,
      runId: pending.runId,
      registryFingerprint: pending.registryFingerprint,
      blueprintId: pending.blueprintId,
      currentName: pending.currentName,
      currentRevision: pending.currentRevision,
      targetName: pending.targetName,
      expectedRevision: pending.expectedRevision,
    }),
  });
}
