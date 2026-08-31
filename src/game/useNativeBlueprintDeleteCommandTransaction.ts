import { useCallback, useEffect, useRef, useState } from "react";

import {
  asNativeBlueprintDeleteCommitReceipt,
  createNativeBlueprintDeletePendingCommand,
  evaluateNativeBlueprintDeletePendingProjection,
  reconcileNativeBlueprintDeletePendingCommand,
  updateNativeBlueprintDeletePendingCommand,
  type NativeBlueprintDeleteAuthorityObservation,
  type NativeBlueprintDeleteBlockedReason,
  type NativeBlueprintDeletePendingCommand,
} from "./nativeBlueprintDeleteCommandReconciliation";
import { prepareNativeBlueprintDeleteIntentCommand } from "./nativeBlueprintDeleteIntentCommands";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintDeleteBinding,
  NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";

interface ReadRef<T> {
  readonly current: T;
}

interface MutableBooleanRef {
  current: boolean;
}

export interface NativeBlueprintDeleteCommandTransactionOptions {
  readonly authority: NativeBlueprintDeleteAuthorityObservation | null;
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

export interface NativeBlueprintDeleteCommandTransaction {
  readonly pending: NativeBlueprintDeletePendingCommand | null;
  readonly commit: (binding: NativeBlueprintDeleteBinding) => boolean;
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
 * Sends one Rust-owned deletion once. Unknown transport outcomes use only the
 * read-only reconciliation endpoint, then wait for an exact absence projection.
 */
export function useNativeBlueprintDeleteCommandTransaction(
  options: NativeBlueprintDeleteCommandTransactionOptions,
): NativeBlueprintDeleteCommandTransaction {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tokenRef = useRef(0);
  const pendingRef = useRef<NativeBlueprintDeletePendingCommand | null>(null);
  const [pending, setPending] = useState<NativeBlueprintDeletePendingCommand | null>(null);

  const publishPending = useCallback((next: NativeBlueprintDeletePendingCommand | null): void => {
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
    currentPending: NativeBlueprintDeletePendingCommand,
    reason: NativeBlueprintDeleteBlockedReason,
    notice: string,
  ): void => {
    if (pendingRef.current?.token !== currentPending.token) return;
    publishPending(updateNativeBlueprintDeletePendingCommand(currentPending, "blocked", {
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
    currentPending: NativeBlueprintDeletePendingCommand,
  ): Promise<void> => {
    const result = await reconcileNativeBlueprintDeletePendingCommand({
      pending: currentPending,
      isCurrent: () => pendingRef.current?.token === currentPending.token,
      wait: optionsRef.current.wait ?? defaultWait,
    });
    if (pendingRef.current?.token !== currentPending.token || result.status === "cancelled") return;
    if (result.status === "not-committed") {
      finishPending(currentPending.token, "Rust 已确认这次蓝图删除没有提交；界面已安全解锁");
      refreshProjection(null, null);
      return;
    }
    if (result.status === "committed") {
      const awaitingProjection = updateNativeBlueprintDeletePendingCommand(
        currentPending,
        "awaiting-projection",
        { receipt: result.receipt },
      );
      publishPending(awaitingProjection);
      optionsRef.current.setNotice(
        "Rust 已确认蓝图删除提交；正在等待不早于回执 revision 的同 lineage 缺席投影",
      );
      refreshProjection(
        currentPending.token,
        "蓝图删除提交已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
      return;
    }
    const notice = result.reason === "conflict"
      ? "原生蓝图删除对账发现 revision 冲突；操作保持锁定且不会自动重发"
      : result.reason === "pending-timeout"
        ? "原生蓝图删除在六次有界只读对账后仍未定案；操作保持锁定且不会自动重发"
        : result.reason === "reconciliation-unavailable"
          ? "原生蓝图删除对账接口暂不可用；操作保持锁定且不会自动重发"
          : "原生蓝图删除回执无法证明与原命令一致；操作保持锁定且不会自动重发";
    blockPending(currentPending, result.reason, notice);
  }, [blockPending, finishPending, publishPending, refreshProjection]);

  const handleDispatchFailure = useCallback((
    initialPending: NativeBlueprintDeletePendingCommand,
    error: unknown,
  ): void => {
    if (pendingRef.current?.token !== initialPending.token) return;
    if (isProvenPreDispatchFailure(error)) {
      finishPending(initialPending.token, "原生蓝图删除命令在发送前失败；存档未改变，界面已安全解锁");
      return;
    }
    const reconciling = updateNativeBlueprintDeletePendingCommand(initialPending, "reconciling");
    publishPending(reconciling);
    optionsRef.current.setNotice(
      "原生蓝图删除结果暂时不确定；正在六次有界只读对账，期间绝不会重发命令",
    );
    void reconcileTransport(reconciling);
  }, [finishPending, publishPending, reconcileTransport]);

  const commit = useCallback((binding: NativeBlueprintDeleteBinding): boolean => {
    const current = optionsRef.current;
    if (current.rejectPlayerStateEdit()) return false;
    if (!current.authorityOwnedRef.current || current.commandInFlightRef.current || pendingRef.current) {
      current.setNotice("Windows 原生权威正在确认上一项操作；本次蓝图删除未提交");
      return false;
    }
    const source = current.commandSourceRef.current?.source ?? null;
    let command: ReturnType<typeof prepareNativeBlueprintDeleteIntentCommand>;
    try {
      command = prepareNativeBlueprintDeleteIntentCommand(binding, current.frame, source);
    } catch {
      current.setNotice("原生蓝图删除参数或 revision 已到安全上限；本次删除未提交");
      return false;
    }
    if (!source || !command) {
      current.setNotice("原生蓝图选中行或命令 source 已过期；本次删除未提交");
      return false;
    }
    if (tokenRef.current >= Number.MAX_SAFE_INTEGER) {
      current.setNotice("原生蓝图删除事务序列已耗尽；本次删除未提交");
      return false;
    }
    tokenRef.current += 1;
    let initialPending: NativeBlueprintDeletePendingCommand;
    try {
      initialPending = createNativeBlueprintDeletePendingCommand({
        token: tokenRef.current,
        source,
        command,
        binding,
      });
    } catch {
      current.setNotice("原生蓝图删除命令未通过精确事务边界；本次删除未提交");
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
      let awaitingProjection: NativeBlueprintDeletePendingCommand;
      try {
        awaitingProjection = updateNativeBlueprintDeletePendingCommand(
          initialPending,
          "awaiting-projection",
          { receipt: asNativeBlueprintDeleteCommitReceipt(initialPending, receipt) },
        );
      } catch {
        blockPending(
          initialPending,
          "receipt-invalid",
          "原生蓝图删除已发送但回执与命令不一致；操作保持锁定且不会自动重发",
        );
        return;
      }
      publishPending(awaitingProjection);
      optionsRef.current.setNotice(
        "Rust 已提交蓝图删除；正在等待同 lineage 的精确缺席投影",
      );
      refreshProjection(
        initialPending.token,
        "蓝图删除提交已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
    }).catch((error: unknown) => handleDispatchFailure(initialPending, error));
    return true;
  }, [blockPending, handleDispatchFailure, publishPending, refreshProjection]);

  useEffect(() => {
    const currentPending = pendingRef.current;
    if (!currentPending) return;
    const result = evaluateNativeBlueprintDeletePendingProjection(
      currentPending,
      options.authority,
      options.frame,
    );
    if (result.status === "lineage-changed") {
      finishPending(
        currentPending.token,
        "原生权威已进入新的 session/run；旧蓝图删除事务已安全结束，且不会在新 lineage 重发",
      );
      return;
    }
    if (currentPending.phase === "blocked") return;
    if (result.status === "confirmed") {
      finishPending(currentPending.token, "蓝图删除已由 Rust 权威缺席投影精确确认");
      return;
    }
    if (result.status === "blocked" && currentPending.blockedReason !== result.reason) {
      blockPending(
        currentPending,
        result.reason,
        "同 lineage 蓝图投影与已提交删除结果不一致；操作保持锁定且不会自动重发",
      );
    }
  }, [blockPending, finishPending, options.authority, options.frame, pending]);

  return { pending, commit };
}
