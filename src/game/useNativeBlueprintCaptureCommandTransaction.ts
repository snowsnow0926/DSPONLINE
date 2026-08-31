import { useCallback, useEffect, useRef, useState } from "react";

import {
  asNativeBlueprintCaptureCommitReceipt,
  attachNativeBlueprintCaptureMembershipProof,
  clearNativeBlueprintCaptureMembershipProof,
  createNativeBlueprintCapturePendingCommand,
  evaluateNativeBlueprintCapturePendingProjection,
  reconcileNativeBlueprintCapturePendingCommand,
  updateNativeBlueprintCapturePendingCommand,
  type NativeBlueprintCaptureAuthorityObservation,
  type NativeBlueprintCaptureBlockedReason,
  type NativeBlueprintCapturePendingCommand,
} from "./nativeBlueprintCaptureCommandReconciliation";
import type { NativeBlueprintCaptureContext } from "./nativeBlueprintCaptureContext";
import { prepareNativeBlueprintCaptureIntentCommand } from "./nativeBlueprintCaptureIntentCommands";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintDirectDeploySelectionBinding,
  NativeBlueprintWorkspaceSource,
} from "./nativeBlueprintWorkspaceStore";

interface ReadRef<T> {
  readonly current: T;
}

interface MutableBooleanRef {
  current: boolean;
}

export interface NativeBlueprintCaptureCommandTransactionOptions {
  readonly authority: NativeBlueprintCaptureAuthorityObservation | null;
  readonly membershipSource: NativeBlueprintWorkspaceSource | null;
  readonly authorityOwnedRef: ReadRef<boolean>;
  readonly commandInFlightRef: MutableBooleanRef;
  readonly commandSourceRef: ReadRef<Readonly<{ source: NativePlayerAuthorityCommandSource }> | null>;
  readonly setCommandPending: (pending: boolean) => void;
  readonly rejectPlayerStateEdit: () => boolean;
  readonly refreshAuthority: () => Promise<void> | undefined;
  readonly setNotice: (notice: string) => void;
  readonly onConfirmed: (selection: NativeBlueprintDirectDeploySelectionBinding) => void;
  /** Test seam only; production uses a bounded browser timer. */
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface NativeBlueprintCaptureCommandTransaction {
  readonly pending: NativeBlueprintCapturePendingCommand | null;
  readonly commit: (context: NativeBlueprintCaptureContext) => boolean;
}

export const NATIVE_BLUEPRINT_CAPTURE_MEMBERSHIP_RETRY_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function isProvenPreDispatchFailure(error: unknown): error is NativePlayerAuthorityCommandSourceError {
  return error instanceof NativePlayerAuthorityCommandSourceError && error.commandId === null;
}

/**
 * Dispatches one Rust-owned capture marker exactly once. Unknown transport
 * outcomes reconcile read-only; durable completion additionally requires the
 * exact Rust library ID to exist at the current authority revision.
 */
export function useNativeBlueprintCaptureCommandTransaction(
  options: NativeBlueprintCaptureCommandTransactionOptions,
): NativeBlueprintCaptureCommandTransaction {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tokenRef = useRef(0);
  const membershipFlightRef = useRef<Readonly<{ key: string }> | null>(null);
  const membershipAttemptRef = useRef<{
    token: number;
    revision: number;
    attempts: number;
  } | null>(null);
  const pendingRef = useRef<NativeBlueprintCapturePendingCommand | null>(null);
  const [pending, setPending] = useState<NativeBlueprintCapturePendingCommand | null>(null);
  const [membershipRetryEpoch, setMembershipRetryEpoch] = useState(0);

  const publishPending = useCallback((next: NativeBlueprintCapturePendingCommand | null): void => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const finishPending = useCallback((token: number, notice: string): boolean => {
    if (pendingRef.current?.token !== token) return false;
    publishPending(null);
    membershipFlightRef.current = null;
    membershipAttemptRef.current = null;
    const current = optionsRef.current;
    current.commandInFlightRef.current = false;
    current.setCommandPending(false);
    current.setNotice(notice);
    return true;
  }, [publishPending]);

  const finishConfirmed = useCallback((currentPending: NativeBlueprintCapturePendingCommand): void => {
    const binding = Object.freeze({
      sessionId: currentPending.sessionId,
      runId: currentPending.runId,
      registryFingerprint: currentPending.registryFingerprint,
      blueprintId: currentPending.expectedBlueprintId,
      blueprintName: currentPending.expectedBlueprintName,
      currentRowRevision: currentPending.expectedBlueprintRevision,
    });
    if (!finishPending(currentPending.token, "蓝图已由 Rust 捕获并通过权威蓝图库成员证明")) return;
    try {
      optionsRef.current.onConfirmed(binding);
    } catch {
      optionsRef.current.setNotice("蓝图已安全捕获，但进入直接部署定位失败；可从蓝图库重新选择");
    }
  }, [finishPending]);

  const blockPending = useCallback((
    currentPending: NativeBlueprintCapturePendingCommand,
    reason: NativeBlueprintCaptureBlockedReason,
    notice: string,
  ): void => {
    if (pendingRef.current?.token !== currentPending.token) return;
    membershipFlightRef.current = null;
    membershipAttemptRef.current = null;
    publishPending(updateNativeBlueprintCapturePendingCommand(currentPending, "blocked", {
      blockedReason: reason,
    }));
    optionsRef.current.setNotice(notice);
  }, [publishPending]);

  const refreshProjection = useCallback((token: number | null, failureNotice: string | null): void => {
    let refresh: Promise<void> | undefined;
    try {
      refresh = optionsRef.current.refreshAuthority();
    } catch {
      if (failureNotice && token !== null && pendingRef.current?.token === token) {
        optionsRef.current.setNotice(failureNotice);
      }
      return;
    }
    if (!refresh) return;
    void refresh.catch(() => {
      if (failureNotice && token !== null && pendingRef.current?.token === token) {
        optionsRef.current.setNotice(failureNotice);
      }
    });
  }, []);

  const reconcileTransport = useCallback(async (
    currentPending: NativeBlueprintCapturePendingCommand,
  ): Promise<void> => {
    const result = await reconcileNativeBlueprintCapturePendingCommand({
      pending: currentPending,
      isCurrent: () => pendingRef.current?.token === currentPending.token,
      wait: optionsRef.current.wait ?? defaultWait,
    });
    if (pendingRef.current?.token !== currentPending.token || result.status === "cancelled") return;
    if (result.status === "not-committed") {
      finishPending(currentPending.token, "Rust 已确认这次蓝图捕获没有提交；界面已安全解锁");
      refreshProjection(null, null);
      return;
    }
    if (result.status === "committed") {
      const awaitingProjection = updateNativeBlueprintCapturePendingCommand(
        currentPending,
        "awaiting-projection",
        { receipt: result.receipt },
      );
      publishPending(awaitingProjection);
      optionsRef.current.setNotice("Rust 已确认蓝图捕获；正在读取同 lineage 的精确蓝图库成员证明");
      refreshProjection(
        currentPending.token,
        "蓝图捕获已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
      return;
    }
    const notice = result.reason === "conflict"
      ? "原生蓝图捕获对账发现 revision 冲突；操作保持锁定且不会自动重发"
      : result.reason === "pending-timeout"
        ? "原生蓝图捕获在六次有界只读对账后仍未定案；操作保持锁定且不会自动重发"
        : result.reason === "reconciliation-unavailable"
          ? "原生蓝图捕获对账接口暂不可用；操作保持锁定且不会自动重发"
          : "原生蓝图捕获回执无法证明与原命令一致；操作保持锁定且不会自动重发";
    blockPending(currentPending, result.reason, notice);
  }, [blockPending, finishPending, publishPending, refreshProjection]);

  const handleDispatchFailure = useCallback((
    initialPending: NativeBlueprintCapturePendingCommand,
    error: unknown,
  ): void => {
    if (pendingRef.current?.token !== initialPending.token) return;
    if (isProvenPreDispatchFailure(error)) {
      finishPending(initialPending.token, "蓝图捕获命令在发送前失败；存档未改变，界面已安全解锁");
      return;
    }
    const reconciling = updateNativeBlueprintCapturePendingCommand(initialPending, "reconciling");
    publishPending(reconciling);
    optionsRef.current.setNotice(
      "蓝图捕获结果暂时不确定；正在六次有界只读对账，期间绝不会重发命令",
    );
    void reconcileTransport(reconciling);
  }, [finishPending, publishPending, reconcileTransport]);

  const commit = useCallback((context: NativeBlueprintCaptureContext): boolean => {
    const current = optionsRef.current;
    if (current.rejectPlayerStateEdit()) return false;
    if (!current.authorityOwnedRef.current || current.commandInFlightRef.current || pendingRef.current) {
      current.setNotice("Windows 原生权威正在确认上一项操作；本次蓝图捕获未提交");
      return false;
    }
    const source = current.commandSourceRef.current?.source ?? null;
    const authority = current.authority;
    const membershipSource = current.membershipSource;
    let command: ReturnType<typeof prepareNativeBlueprintCaptureIntentCommand>;
    try {
      command = prepareNativeBlueprintCaptureIntentCommand(context, source);
    } catch {
      current.setNotice("原生蓝图捕获参数或 revision 已到安全上限；本次操作未提交");
      return false;
    }
    if (!source || !command || !authority || !membershipSource ||
        authority.sessionId !== context.sessionId || authority.runId !== context.runId ||
        authority.revision !== context.revision ||
        membershipSource.boundIdentity.sessionId !== context.sessionId ||
        membershipSource.boundIdentity.runId !== context.runId ||
        membershipSource.boundIdentity.revision !== context.revision ||
        membershipSource.boundIdentity.registryFingerprint !== context.registryFingerprint) {
      current.setNotice("蓝图捕获凭证、权威 revision 或命令 source 已过期；本次操作未提交");
      return false;
    }
    if (tokenRef.current >= Number.MAX_SAFE_INTEGER) {
      current.setNotice("蓝图捕获事务序列已耗尽；本次操作未提交");
      return false;
    }
    tokenRef.current += 1;
    let initialPending: NativeBlueprintCapturePendingCommand;
    try {
      initialPending = createNativeBlueprintCapturePendingCommand({
        token: tokenRef.current,
        source,
        command,
        context,
      });
    } catch {
      current.setNotice("蓝图捕获命令未通过精确事务边界；本次操作未提交");
      return false;
    }
    publishPending(initialPending);
    membershipFlightRef.current = null;
    membershipAttemptRef.current = null;
    current.commandInFlightRef.current = true;
    current.setCommandPending(true);
    let dispatch: ReturnType<NativePlayerAuthorityCommandSource["applyCommand"]>;
    try {
      dispatch = initialPending.source.applyCommand(initialPending.command);
    } catch (error) {
      handleDispatchFailure(initialPending, error);
      return true;
    }
    void dispatch.then((receipt) => {
      if (pendingRef.current?.token !== initialPending.token) return;
      let awaitingProjection: NativeBlueprintCapturePendingCommand;
      try {
        awaitingProjection = updateNativeBlueprintCapturePendingCommand(
          initialPending,
          "awaiting-projection",
          { receipt: asNativeBlueprintCaptureCommitReceipt(initialPending, receipt) },
        );
      } catch {
        blockPending(
          initialPending,
          "receipt-invalid",
          "蓝图捕获已发送但回执与命令不一致；操作保持锁定且不会自动重发",
        );
        return;
      }
      publishPending(awaitingProjection);
      optionsRef.current.setNotice("Rust 已提交蓝图捕获；正在等待同 lineage 的精确蓝图库成员证明");
      refreshProjection(
        initialPending.token,
        "蓝图捕获已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
    }).catch((error: unknown) => handleDispatchFailure(initialPending, error));
    return true;
  }, [blockPending, handleDispatchFailure, publishPending, refreshProjection]);

  useEffect(() => {
    const currentPending = pendingRef.current;
    if (!currentPending) return;
    const result = evaluateNativeBlueprintCapturePendingProjection(currentPending, options.authority);
    if (result.status === "lineage-changed") {
      finishPending(
        currentPending.token,
        "原生权威已进入新的 session/run；旧蓝图捕获事务已安全结束，且不会在新 lineage 重发",
      );
      return;
    }
    if (currentPending.phase === "blocked") return;
    if (result.status === "stale-proof") {
      membershipFlightRef.current = null;
      try {
        publishPending(clearNativeBlueprintCaptureMembershipProof(currentPending));
        optionsRef.current.setNotice("权威 revision 已前进；正在按最新 revision 重新读取蓝图库成员证明");
      } catch {
        blockPending(
          currentPending,
          "receipt-projection-mismatch",
          "旧蓝图库成员证明无法安全退役；操作保持锁定且不会自动重发",
        );
      }
      return;
    }
    if (result.status === "confirmed") {
      finishConfirmed(currentPending);
      return;
    }
    if (result.status === "blocked" && currentPending.blockedReason !== result.reason) {
      blockPending(
        currentPending,
        result.reason,
        "同 lineage 蓝图库成员证明与已提交捕获不一致；操作保持锁定且不会自动重发",
      );
      return;
    }
    if (currentPending.phase !== "awaiting-projection" || currentPending.receipt === null ||
        currentPending.membershipProof !== null || !options.authority) return;
    const source = options.membershipSource;
    if (!source || source.boundIdentity.sessionId !== currentPending.sessionId ||
        source.boundIdentity.runId !== currentPending.runId ||
        source.boundIdentity.revision !== options.authority.revision ||
        source.boundIdentity.revision < currentPending.receipt.revision) return;
    if (source.boundIdentity.registryFingerprint !== currentPending.registryFingerprint) {
      blockPending(
        currentPending,
        "receipt-projection-mismatch",
        "同 lineage 蓝图库成员源的 registry 已变化；操作保持锁定且不会自动重发",
      );
      return;
    }
    const flightKey = `${currentPending.token}\0${source.boundIdentity.revision}\0${currentPending.expectedBlueprintId}`;
    if (membershipFlightRef.current?.key === flightKey) return;
    let attemptState = membershipAttemptRef.current;
    if (!attemptState || attemptState.token !== currentPending.token ||
        attemptState.revision !== source.boundIdentity.revision) {
      attemptState = { token: currentPending.token, revision: source.boundIdentity.revision, attempts: 0 };
      membershipAttemptRef.current = attemptState;
    }
    if (attemptState.attempts >= NATIVE_BLUEPRINT_CAPTURE_MEMBERSHIP_RETRY_DELAYS_MS.length) {
      blockPending(
        currentPending,
        "receipt-projection-mismatch",
        "蓝图库成员证明在六次有界只读重试后仍不可用；操作保持锁定且不会自动重发",
      );
      return;
    }
    const delay = NATIVE_BLUEPRINT_CAPTURE_MEMBERSHIP_RETRY_DELAYS_MS[attemptState.attempts];
    attemptState.attempts += 1;
    membershipFlightRef.current = { key: flightKey };
    const requestIsStillCurrent = (): boolean => {
      const latest = pendingRef.current;
      const latestOptions = optionsRef.current;
      return Boolean(latest && latest.token === currentPending.token && latest.membershipProof === null &&
        latest.phase === "awaiting-projection" && latestOptions.membershipSource &&
        latestOptions.authority &&
        latestOptions.authority.sessionId === source.boundIdentity.sessionId &&
        latestOptions.authority.runId === source.boundIdentity.runId &&
        latestOptions.authority.revision === source.boundIdentity.revision &&
        latestOptions.membershipSource.boundIdentity.sessionId === source.boundIdentity.sessionId &&
        latestOptions.membershipSource.boundIdentity.runId === source.boundIdentity.runId &&
        latestOptions.membershipSource.boundIdentity.revision === source.boundIdentity.revision &&
        latestOptions.membershipSource.boundIdentity.registryFingerprint ===
          source.boundIdentity.registryFingerprint && source.boundIdentity.sessionId === latest.sessionId &&
        source.boundIdentity.runId === latest.runId &&
        source.boundIdentity.registryFingerprint === latest.registryFingerprint);
    };
    const discardRetiredFlight = (): void => {
      if (membershipFlightRef.current?.key === flightKey) membershipFlightRef.current = null;
    };
    const retryUnavailableMembership = (latest: NativeBlueprintCapturePendingCommand): void => {
      discardRetiredFlight();
      const attempts = membershipAttemptRef.current;
      if (!attempts || attempts.token !== latest.token ||
          attempts.revision !== source.boundIdentity.revision ||
          attempts.attempts >= NATIVE_BLUEPRINT_CAPTURE_MEMBERSHIP_RETRY_DELAYS_MS.length) {
        blockPending(
          latest,
          "receipt-projection-mismatch",
          "蓝图库成员证明在六次有界只读重试后仍不可用；操作保持锁定且不会自动重发",
        );
        return;
      }
      optionsRef.current.setNotice(
        "蓝图库成员证明遇到 revision 漂移或暂时不可用；正在有界只读重试，绝不会重发捕获命令",
      );
      refreshProjection(
        latest.token,
        "蓝图捕获已确认，但权威 revision 刷新暂时失败；只读证明仍保持有界重试",
      );
      setMembershipRetryEpoch((epoch) => epoch >= Number.MAX_SAFE_INTEGER ? 0 : epoch + 1);
    };
    void (async () => {
      if (delay > 0) await (optionsRef.current.wait ?? defaultWait)(delay);
      if (!requestIsStillCurrent()) {
        discardRetiredFlight();
        return null;
      }
      const readMembership = source.readVerifiedLibraryMembership;
      return typeof readMembership === "function"
        ? readMembership(currentPending.expectedBlueprintId)
        : null;
    })().then((proof) => {
      if (!requestIsStillCurrent()) {
        discardRetiredFlight();
        return;
      }
      const latest = pendingRef.current!;
      if (!proof) {
        retryUnavailableMembership(latest);
        return;
      }
      try {
        publishPending(attachNativeBlueprintCaptureMembershipProof(latest, proof));
      } catch {
        blockPending(
          latest,
          "receipt-projection-mismatch",
          "蓝图库的全库成员证明与捕获事务不一致；操作保持锁定且不会自动重发",
        );
      }
    }).catch(() => {
      if (!requestIsStillCurrent()) {
        discardRetiredFlight();
        return;
      }
      const latest = pendingRef.current!;
      if (latest.membershipProof === null) retryUnavailableMembership(latest);
    });
  }, [
    blockPending,
    finishConfirmed,
    finishPending,
    membershipRetryEpoch,
    options.authority,
    options.membershipSource,
    pending,
    publishPending,
    refreshProjection,
  ]);

  return { pending, commit };
}
