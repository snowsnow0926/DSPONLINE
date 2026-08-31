import { useCallback, useEffect, useRef, useState } from "react";

import {
  asNativeConstructionQueueFundCommitReceipt,
  createNativeConstructionQueueFundPendingCommand,
  evaluateNativeConstructionQueueFundPendingProjection,
  reconcileNativeConstructionQueueFundPendingCommand,
  updateNativeConstructionQueueFundPendingCommand,
  type NativeConstructionQueueFundAuthorityObservation,
  type NativeConstructionQueueFundBlockedReason,
  type NativeConstructionQueueFundPendingCommand,
} from "./nativeConstructionQueueFundCommandReconciliation";
import { prepareNativeConstructionQueueFundIntentCommand } from "./nativeConstructionQueueFundIntentCommands";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeConstructionQueueFundBinding,
  NativeConstructionQueueFundScope,
} from "./nativeBlueprintWorkspaceStore";

interface ReadRef<T> {
  readonly current: T;
}

interface MutableBooleanRef {
  current: boolean;
}

export interface NativeConstructionQueueFundCommandTransactionOptions {
  readonly authority: NativeConstructionQueueFundAuthorityObservation | null;
  readonly frame: NativeBlueprintWorkspaceFrame | null;
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

export interface NativeConstructionQueueFundCommandTransaction {
  readonly pending: NativeConstructionQueueFundPendingCommand | null;
  readonly commit: (
    binding: NativeConstructionQueueFundBinding,
    scope: NativeConstructionQueueFundScope,
  ) => boolean;
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

/** Sends one reservation marker once; uncertain transport is reconciled read-only. */
export function useNativeConstructionQueueFundCommandTransaction(
  options: NativeConstructionQueueFundCommandTransactionOptions,
): NativeConstructionQueueFundCommandTransaction {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tokenRef = useRef(0);
  const pendingRef = useRef<NativeConstructionQueueFundPendingCommand | null>(null);
  const [pending, setPending] = useState<NativeConstructionQueueFundPendingCommand | null>(null);

  const publishPending = useCallback((next: NativeConstructionQueueFundPendingCommand | null): void => {
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
    currentPending: NativeConstructionQueueFundPendingCommand,
    reason: NativeConstructionQueueFundBlockedReason,
    notice: string,
  ): void => {
    if (pendingRef.current?.token !== currentPending.token) return;
    publishPending(updateNativeConstructionQueueFundPendingCommand(currentPending, "blocked", {
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
    currentPending: NativeConstructionQueueFundPendingCommand,
  ): Promise<void> => {
    const result = await reconcileNativeConstructionQueueFundPendingCommand({
      pending: currentPending,
      isCurrent: () => pendingRef.current?.token === currentPending.token,
      wait: optionsRef.current.wait ?? defaultWait,
    });
    if (pendingRef.current?.token !== currentPending.token || result.status === "cancelled") return;
    if (result.status === "not-committed") {
      finishPending(currentPending.token, "Rust 已确认这次施工领料没有提交；界面已安全解锁");
      refreshProjection(null, null);
      return;
    }
    if (result.status === "committed") {
      const awaitingProjection = updateNativeConstructionQueueFundPendingCommand(
        currentPending,
        "awaiting-projection",
        { receipt: result.receipt },
      );
      publishPending(awaitingProjection);
      optionsRef.current.setNotice("Rust 已确认施工领料提交；正在等待 R+1 队列行投影");
      refreshProjection(
        currentPending.token,
        "施工领料已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
      return;
    }
    const notice = result.reason === "conflict"
      ? "施工领料对账发现 revision 冲突；操作保持锁定且不会自动重发"
      : result.reason === "pending-timeout"
        ? "施工领料在六次有界只读对账后仍未定案；操作保持锁定且不会自动重发"
        : result.reason === "reconciliation-unavailable"
          ? "施工领料对账接口暂不可用；操作保持锁定且不会自动重发"
          : "施工领料回执无法证明与原命令一致；操作保持锁定且不会自动重发";
    blockPending(currentPending, result.reason, notice);
  }, [blockPending, finishPending, publishPending, refreshProjection]);

  const handleDispatchFailure = useCallback((
    initialPending: NativeConstructionQueueFundPendingCommand,
    error: unknown,
  ): void => {
    if (pendingRef.current?.token !== initialPending.token) return;
    if (isProvenPreDispatchFailure(error)) {
      finishPending(initialPending.token, "施工领料命令在发送前失败；存档未改变，界面已安全解锁");
      return;
    }
    const reconciling = updateNativeConstructionQueueFundPendingCommand(initialPending, "reconciling");
    publishPending(reconciling);
    optionsRef.current.setNotice(
      "施工领料结果暂时不确定；正在六次有界只读对账，期间绝不会重发命令",
    );
    void reconcileTransport(reconciling);
  }, [finishPending, publishPending, reconcileTransport]);

  const commit = useCallback((
    binding: NativeConstructionQueueFundBinding,
    scope: NativeConstructionQueueFundScope,
  ): boolean => {
    const current = optionsRef.current;
    if (current.rejectPlayerStateEdit()) return false;
    if (!current.authorityOwnedRef.current || current.commandInFlightRef.current || pendingRef.current) {
      current.setNotice("Windows 原生权威正在确认上一项操作；本次施工领料未提交");
      return false;
    }
    const source = current.commandSourceRef.current?.source ?? null;
    let command: ReturnType<typeof prepareNativeConstructionQueueFundIntentCommand>;
    try {
      command = prepareNativeConstructionQueueFundIntentCommand(
        binding,
        scope,
        current.frame,
        source,
      );
    } catch {
      current.setNotice("施工领料参数或 revision 已到安全上限；本次领料未提交");
      return false;
    }
    if (!source || !command) {
      current.setNotice("施工队列行或命令 source 已过期；本次领料未提交");
      return false;
    }
    if (tokenRef.current >= Number.MAX_SAFE_INTEGER) {
      current.setNotice("施工领料事务序列已耗尽；本次领料未提交");
      return false;
    }
    tokenRef.current += 1;
    let initialPending: NativeConstructionQueueFundPendingCommand;
    try {
      initialPending = createNativeConstructionQueueFundPendingCommand({
        token: tokenRef.current,
        scope,
        source,
        command,
        binding,
      });
    } catch {
      current.setNotice("施工领料命令未通过精确事务边界；本次领料未提交");
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
      let awaitingProjection: NativeConstructionQueueFundPendingCommand;
      try {
        awaitingProjection = updateNativeConstructionQueueFundPendingCommand(
          initialPending,
          "awaiting-projection",
          { receipt: asNativeConstructionQueueFundCommitReceipt(initialPending, receipt) },
        );
      } catch {
        blockPending(
          initialPending,
          "receipt-invalid",
          "施工领料已发送但回执与命令不一致；操作保持锁定且不会自动重发",
        );
        return;
      }
      publishPending(awaitingProjection);
      optionsRef.current.setNotice("Rust 已提交施工领料；正在等待同 lineage 的 R+1 队列行投影");
      refreshProjection(
        initialPending.token,
        "施工领料已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
    }).catch((error: unknown) => handleDispatchFailure(initialPending, error));
    return true;
  }, [blockPending, handleDispatchFailure, publishPending, refreshProjection]);

  useEffect(() => {
    const currentPending = pendingRef.current;
    if (!currentPending) return;
    const result = evaluateNativeConstructionQueueFundPendingProjection(
      currentPending,
      options.authority,
      options.frame,
    );
    if (result.status === "lineage-changed") {
      finishPending(
        currentPending.token,
        "原生权威已进入新的 session/run；旧施工领料事务已安全结束，且不会在新 lineage 重发",
      );
      return;
    }
    if (currentPending.phase === "blocked") return;
    if (result.status === "confirmed") {
      finishPending(currentPending.token, "施工领料已由 Rust 权威 R+1 队列行精确确认");
      return;
    }
    if (result.status === "blocked") {
      blockPending(
        currentPending,
        result.reason,
        "同 lineage R+1 施工队列投影无法证明领料结果；操作保持锁定且不会自动重发",
      );
    }
  }, [blockPending, finishPending, options.authority, options.frame, pending]);

  return { pending, commit };
}

