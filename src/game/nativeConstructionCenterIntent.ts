import type { NativeConstructionCenterWorkspaceFrame } from "./nativeConstructionCenterWorkspace";

export type NativeConstructionCenterIntentKind =
  | "enabled"
  | "quantumSupplyEnabled"
  | "targetStock"
  | "otherNativeCommand";

export interface NativeConstructionCenterFrameIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: number;
  readonly activePlanetId: string;
}

export interface NativeConstructionCenterPendingIdentity extends NativeConstructionCenterFrameIdentity {
  readonly kind: NativeConstructionCenterIntentKind;
  readonly targetId: string | null;
  /** Null until the durable ACK is known; then the projection revision to await. */
  readonly expectedRevision: number | null;
}

export interface NativeConstructionCenterTargetStockSubmission extends NativeConstructionCenterFrameIdentity {
  readonly targetId: string;
  readonly target: number;
  /** Required only for a decrease and bound to the same projected target. */
  readonly confirmedDecreaseFrom: number | null;
}

export interface NativeConstructionCenterTargetStockConfirmation {
  readonly identity: NativeConstructionCenterFrameIdentity;
  readonly targetId: string;
  readonly targetName: string;
  readonly previousTarget: number;
  readonly target: number;
  readonly currentStock: number;
  readonly cancelsJobsAndRefunds: boolean;
}

export type NativeConstructionCenterTargetStockEvaluation =
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "ready"; readonly submission: NativeConstructionCenterTargetStockSubmission }
  | { readonly status: "confirmation-required"; readonly confirmation: NativeConstructionCenterTargetStockConfirmation };

export type NativeConstructionCenterTargetDraftResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string };

const TARGET_PRESETS = [0, 100, 500, 2_000, 10_000, 100_000, 100_000_000] as const;

export function nativeConstructionCenterFrameIdentity(
  frame: NativeConstructionCenterWorkspaceFrame,
): NativeConstructionCenterFrameIdentity {
  return Object.freeze({
    sessionId: frame.sessionId,
    runId: frame.runId,
    revision: frame.revision,
    activePlanetId: frame.activePlanetId,
  });
}

export function nativeConstructionCenterIdentityMatchesFrame(
  identity: NativeConstructionCenterFrameIdentity,
  frame: NativeConstructionCenterWorkspaceFrame | null,
): boolean {
  return Boolean(frame) && identity.sessionId === frame!.sessionId && identity.runId === frame!.runId &&
    identity.revision === frame!.revision && identity.activePlanetId === frame!.activePlanetId;
}

export function nativeConstructionCenterIdentityKey(
  identity: NativeConstructionCenterFrameIdentity | null,
): string {
  return identity
    ? JSON.stringify([identity.sessionId, identity.runId, identity.revision, identity.activePlanetId])
    : "unavailable";
}

export function nativeConstructionCenterPendingKey(
  pending: NativeConstructionCenterPendingIdentity | null,
): string {
  return pending
    ? JSON.stringify([
      pending.sessionId,
      pending.runId,
      pending.revision,
      pending.activePlanetId,
      pending.kind,
      pending.targetId,
      pending.expectedRevision,
    ])
    : "idle";
}

export function nativeConstructionCenterTargetPresets(stockLimit: number): readonly number[] {
  if (!Number.isSafeInteger(stockLimit) || stockLimit < 1) return Object.freeze([]);
  return Object.freeze([...new Set([
    ...TARGET_PRESETS.filter((value) => value <= stockLimit),
    stockLimit,
  ])].sort((left, right) => left - right));
}

export function parseNativeConstructionCenterTargetDraft(
  draft: string,
  stockLimit: number,
): NativeConstructionCenterTargetDraftResult {
  const normalized = draft.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    return { ok: false, message: "请输入不带符号、小数或前导零的十进制整数" };
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, message: "目标数量超出安全整数范围" };
  }
  if (!Number.isSafeInteger(stockLimit) || stockLimit < 1 || value > stockLimit) {
    return { ok: false, message: `当前投影库存上限为 ${stockLimit.toLocaleString("zh-CN")}` };
  }
  return { ok: true, value };
}

export function evaluateNativeConstructionCenterTargetStock(
  frame: NativeConstructionCenterWorkspaceFrame | null,
  pending: NativeConstructionCenterPendingIdentity | null,
  targetId: string,
  target: number,
): NativeConstructionCenterTargetStockEvaluation {
  if (!frame || frame.workspace.writeAvailable !== true || pending) {
    return { status: "rejected", message: "原生权威投影不可用或已有命令待确认" };
  }
  const row = frame.workspace.targets.rows.find((candidate) => candidate.targetId === targetId);
  if (!row || !row.unlocked) {
    return { status: "rejected", message: "目标不在同 revision 的已解锁 Rust 目录中" };
  }
  if (!Number.isSafeInteger(target) || target < 0 || target > frame.workspace.stockLimit) {
    return { status: "rejected", message: "目标超出同 revision 库存上限" };
  }
  if (target === row.target) {
    return { status: "rejected", message: "目标库存没有变化" };
  }
  const identity = nativeConstructionCenterFrameIdentity(frame);
  if (target < row.target) {
    return {
      status: "confirmation-required",
      confirmation: Object.freeze({
        identity,
        targetId: row.targetId,
        targetName: row.name,
        previousTarget: row.target,
        target,
        currentStock: row.currentStock,
        cancelsJobsAndRefunds: target <= row.currentStock,
      }),
    };
  }
  return {
    status: "ready",
    submission: Object.freeze({
      ...identity,
      targetId: row.targetId,
      target,
      confirmedDecreaseFrom: null,
    }),
  };
}

export function confirmNativeConstructionCenterTargetStock(
  frame: NativeConstructionCenterWorkspaceFrame | null,
  pending: NativeConstructionCenterPendingIdentity | null,
  confirmation: NativeConstructionCenterTargetStockConfirmation,
): NativeConstructionCenterTargetStockSubmission | null {
  if (!nativeConstructionCenterIdentityMatchesFrame(confirmation.identity, frame) || !frame ||
      frame.workspace.writeAvailable !== true || pending) return null;
  const row = frame.workspace.targets.rows.find((candidate) => candidate.targetId === confirmation.targetId);
  if (!row || !row.unlocked || row.target !== confirmation.previousTarget ||
    confirmation.target < 0 || confirmation.target >= row.target ||
    confirmation.target > frame.workspace.stockLimit) return null;
  return Object.freeze({
    ...confirmation.identity,
    targetId: confirmation.targetId,
    target: confirmation.target,
    confirmedDecreaseFrom: confirmation.previousTarget,
  });
}
