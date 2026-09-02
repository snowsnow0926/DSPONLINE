import { useCallback, useEffect, useRef, useState } from "react";

import {
  attachNativeConstructionQueueCancelMembershipProof,
  asNativeConstructionQueueCancelCommitReceipt,
  createNativeConstructionQueueCancelPendingCommand,
  evaluateNativeConstructionQueueCancelPendingProjection,
  reconcileNativeConstructionQueueCancelPendingCommand,
  updateNativeConstructionQueueCancelPendingCommand,
  type NativeConstructionQueueCancelAuthorityObservation,
  type NativeConstructionQueueCancelBlockedReason,
  type NativeConstructionQueueCancelPendingCommand,
} from "./nativeConstructionQueueCancelCommandReconciliation";
import { prepareNativeConstructionQueueCancelIntentCommand } from "./nativeConstructionQueueCancelIntentCommands";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeBlueprintWorkspaceSource,
  NativeConstructionQueueCancelBinding,
} from "./nativeBlueprintWorkspaceStore";

interface ReadRef<T> {
  readonly current: T;
}

interface MutableBooleanRef {
  current: boolean;
}

export interface NativeConstructionQueueCancelCommandTransactionOptions {
  readonly authority: NativeConstructionQueueCancelAuthorityObservation | null;
  readonly frame: NativeBlueprintWorkspaceFrame | null;
  readonly membershipSource: NativeBlueprintWorkspaceSource | null;
  readonly authorityOwnedRef: ReadRef<boolean>;
  readonly commandInFlightRef: MutableBooleanRef;
  readonly commandSourceRef: ReadRef<Readonly<{
    source: NativePlayerAuthorityCommandSource;
  }> | null>;
  readonly setCommandPending: (pending: boolean) => void;
  readonly rejectPlayerStateEdit: () => boolean;
  readonly refreshAuthority: () => Promise<void> | undefined;
  readonly setNotice: (notice: string) => void;
  /** Test seam only; production uses a bounded browser timer. */
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface NativeConstructionQueueCancelCommandTransaction {
  readonly pending: NativeConstructionQueueCancelPendingCommand | null;
  readonly commit: (binding: NativeConstructionQueueCancelBinding) => boolean;
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function isProvenPreDispatchFailure(
  error: unknown,
): error is NativePlayerAuthorityCommandSourceError {
  return error instanceof NativePlayerAuthorityCommandSourceError && error.commandId === null;
}

/**
 * Sends one Rust-owned cancellation once. Unknown transport outcomes use only
 * bounded read-only reconciliation before an exact queue-absence projection.
 */
export function useNativeConstructionQueueCancelCommandTransaction(
  options: NativeConstructionQueueCancelCommandTransactionOptions,
): NativeConstructionQueueCancelCommandTransaction {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tokenRef = useRef(0);
  const membershipFlightRef = useRef<Readonly<{
    key: string;
    source: NativeBlueprintWorkspaceSource;
  }> | null>(null);
  const pendingRef = useRef<NativeConstructionQueueCancelPendingCommand | null>(null);
  const [pending, setPending] = useState<NativeConstructionQueueCancelPendingCommand | null>(null);

  const publishPending = useCallback((next: NativeConstructionQueueCancelPendingCommand | null): void => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const finishPending = useCallback((token: number, notice: string): boolean => {
    if (pendingRef.current?.token !== token) return false;
    publishPending(null);
    const current = optionsRef.current;
    current.commandInFlightRef.current = false;
    current.setCommandPending(false);
    current.setNotice(notice);
    return true;
  }, [publishPending]);

  const blockPending = useCallback((
    currentPending: NativeConstructionQueueCancelPendingCommand,
    reason: NativeConstructionQueueCancelBlockedReason,
    notice: string,
  ): void => {
    if (pendingRef.current?.token !== currentPending.token) return;
    publishPending(updateNativeConstructionQueueCancelPendingCommand(currentPending, "blocked", {
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
    currentPending: NativeConstructionQueueCancelPendingCommand,
  ): Promise<void> => {
    const result = await reconcileNativeConstructionQueueCancelPendingCommand({
      pending: currentPending,
      isCurrent: () => pendingRef.current?.token === currentPending.token,
      wait: optionsRef.current.wait ?? defaultWait,
    });
    if (pendingRef.current?.token !== currentPending.token || result.status === "cancelled") return;
    if (result.status === "not-committed") {
      finishPending(currentPending.token, "Rust 已确认这次施工取消没有提交；界面已安全解锁");
      refreshProjection(null, null);
      return;
    }
    if (result.status === "committed") {
      const awaitingProjection = updateNativeConstructionQueueCancelPendingCommand(
        currentPending,
        "awaiting-projection",
        { receipt: result.receipt },
      );
      publishPending(awaitingProjection);
      optionsRef.current.setNotice(
        "Rust 已确认施工取消和完整退款提交；正在等待同 lineage 的队列缺席投影",
      );
      refreshProjection(
        currentPending.token,
        "施工取消已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
      return;
    }
    const notice = result.reason === "conflict"
      ? "施工取消对账发现 revision 冲突；操作保持锁定且不会自动重发"
      : result.reason === "pending-timeout"
        ? "施工取消在六次有界只读对账后仍未定案；操作保持锁定且不会自动重发"
        : result.reason === "reconciliation-unavailable"
          ? "施工取消对账接口暂不可用；操作保持锁定且不会自动重发"
          : "施工取消回执无法证明与原命令一致；操作保持锁定且不会自动重发";
    blockPending(currentPending, result.reason, notice);
  }, [blockPending, finishPending, publishPending, refreshProjection]);

  const handleDispatchFailure = useCallback((
    initialPending: NativeConstructionQueueCancelPendingCommand,
    error: unknown,
  ): void => {
    if (pendingRef.current?.token !== initialPending.token) return;
    if (isProvenPreDispatchFailure(error)) {
      finishPending(initialPending.token, "施工取消命令在发送前失败；存档未改变，界面已安全解锁");
      return;
    }
    const reconciling = updateNativeConstructionQueueCancelPendingCommand(initialPending, "reconciling");
    publishPending(reconciling);
    optionsRef.current.setNotice(
      "施工取消结果暂时不确定；正在六次有界只读对账，期间绝不会重发命令",
    );
    void reconcileTransport(reconciling);
  }, [finishPending, publishPending, reconcileTransport]);

  const commit = useCallback((binding: NativeConstructionQueueCancelBinding): boolean => {
    const current = optionsRef.current;
    if (current.rejectPlayerStateEdit()) return false;
    if (!current.authorityOwnedRef.current || current.commandInFlightRef.current || pendingRef.current) {
      current.setNotice("Windows 原生权威正在确认上一项操作；本次施工取消未提交");
      return false;
    }
    const source = current.commandSourceRef.current?.source ?? null;
    let command: ReturnType<typeof prepareNativeConstructionQueueCancelIntentCommand>;
    try {
      command = prepareNativeConstructionQueueCancelIntentCommand(binding, current.frame, source);
    } catch {
      current.setNotice("施工取消参数或 revision 已到安全上限；本次取消未提交");
      return false;
    }
    if (!source || !command) {
      current.setNotice("施工队列行或命令 source 已过期；本次取消未提交");
      return false;
    }
    if (tokenRef.current >= Number.MAX_SAFE_INTEGER) {
      current.setNotice("施工取消事务序列已耗尽；本次取消未提交");
      return false;
    }
    tokenRef.current += 1;
    let initialPending: NativeConstructionQueueCancelPendingCommand;
    try {
      initialPending = createNativeConstructionQueueCancelPendingCommand({
        token: tokenRef.current,
        source,
        command,
        binding,
      });
    } catch {
      current.setNotice("施工取消命令未通过精确事务边界；本次取消未提交");
      return false;
    }
    publishPending(initialPending);
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
      let awaitingProjection: NativeConstructionQueueCancelPendingCommand;
      try {
        awaitingProjection = updateNativeConstructionQueueCancelPendingCommand(
          initialPending,
          "awaiting-projection",
          { receipt: asNativeConstructionQueueCancelCommitReceipt(initialPending, receipt) },
        );
      } catch {
        blockPending(
          initialPending,
          "receipt-invalid",
          "施工取消已发送但回执与命令不一致；操作保持锁定且不会自动重发",
        );
        return;
      }
      publishPending(awaitingProjection);
      optionsRef.current.setNotice(
        "Rust 已提交施工取消和完整退款；正在等待同 lineage 的精确缺席投影",
      );
      refreshProjection(
        initialPending.token,
        "施工取消已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
    }).catch((error: unknown) => handleDispatchFailure(initialPending, error));
    return true;
  }, [blockPending, handleDispatchFailure, publishPending, refreshProjection]);

  useEffect(() => {
    const currentPending = pendingRef.current;
    if (!currentPending) return;
    const result = evaluateNativeConstructionQueueCancelPendingProjection(
      currentPending,
      options.authority,
      options.frame,
    );
    if (result.status === "lineage-changed") {
      finishPending(
        currentPending.token,
        "原生权威已进入新的 session/run；旧施工取消事务已安全结束，且不会在新 lineage 重发",
      );
      return;
    }
    if (currentPending.phase === "blocked") return;
    if (result.status === "confirmed") {
      finishPending(currentPending.token, "施工取消和完整退款已由 Rust 权威缺席投影精确确认");
      return;
    }
    if (result.status === "blocked" && currentPending.blockedReason !== result.reason) {
      blockPending(
        currentPending,
        result.reason,
        "同 lineage 施工队列投影与已提交取消结果不一致；操作保持锁定且不会自动重发",
      );
      return;
    }
    if (currentPending.phase !== "awaiting-projection" || currentPending.receipt === null ||
        currentPending.membershipProof !== null || !options.authority || !options.frame) return;
    const source = options.membershipSource;
    if (!source || source.boundIdentity.sessionId !== currentPending.sessionId ||
        source.boundIdentity.runId !== currentPending.runId ||
        source.boundIdentity.registryFingerprint !== currentPending.registryFingerprint ||
        source.boundIdentity.revision !== options.authority.revision ||
        source.boundIdentity.revision !== options.frame.revision ||
        source.boundIdentity.revision < currentPending.receipt.revision) return;
    const flightKey = `${currentPending.token}\0${source.boundIdentity.revision}\0${currentPending.queueEntryId}`;
    if (membershipFlightRef.current?.key === flightKey &&
        membershipFlightRef.current.source === source) return;
    membershipFlightRef.current = { key: flightKey, source };
    const requestIsStillCurrent = (): boolean => {
      const latest = pendingRef.current;
      const latestOptions = optionsRef.current;
      return Boolean(latest && latest.token === currentPending.token &&
        latest.membershipProof === null && latest.phase === "awaiting-projection" &&
        latestOptions.membershipSource === source && latestOptions.authority && latestOptions.frame &&
        latestOptions.authority.sessionId === source.boundIdentity.sessionId &&
        latestOptions.authority.runId === source.boundIdentity.runId &&
        latestOptions.authority.revision === source.boundIdentity.revision &&
        latestOptions.frame.sessionId === source.boundIdentity.sessionId &&
        latestOptions.frame.runId === source.boundIdentity.runId &&
        latestOptions.frame.revision === source.boundIdentity.revision &&
        latestOptions.frame.registryFingerprint === source.boundIdentity.registryFingerprint);
    };
    const discardRetiredFlight = (): void => {
      if (membershipFlightRef.current?.key === flightKey &&
          membershipFlightRef.current.source === source) membershipFlightRef.current = null;
    };
    void source.readVerifiedQueueMembership(currentPending.queueEntryId).then((proof) => {
      if (!requestIsStillCurrent()) {
        discardRetiredFlight();
        return;
      }
      const latest = pendingRef.current!;
      if (!proof) {
        blockPending(
          latest,
          "receipt-projection-mismatch",
          "施工取消的全队列成员证明不可用；操作保持锁定且不会自动重发",
        );
        return;
      }
      try {
        publishPending(attachNativeConstructionQueueCancelMembershipProof(latest, proof));
      } catch {
        blockPending(
          latest,
          "receipt-projection-mismatch",
          "施工取消的全队列成员证明与事务不一致；操作保持锁定且不会自动重发",
        );
      }
    }).catch(() => {
      if (!requestIsStillCurrent()) {
        discardRetiredFlight();
        return;
      }
      const latest = pendingRef.current!;
      if (latest.membershipProof === null) {
        blockPending(
          latest,
          "receipt-projection-mismatch",
          "施工取消的全队列成员证明读取失败；操作保持锁定且不会自动重发",
        );
      }
    });
  }, [
    blockPending,
    finishPending,
    options.authority,
    options.frame,
    options.membershipSource,
    pending,
    publishPending,
  ]);

  return { pending, commit };
}
