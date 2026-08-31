import { useCallback, useEffect, useRef, useState } from "react";

import {
  asNativeBlueprintRecipeOverrideCommitReceipt,
  createNativeBlueprintRecipeOverridePendingCommand,
  evaluateNativeBlueprintRecipeOverridePendingProjection,
  reconcileNativeBlueprintRecipeOverridePendingCommand,
  updateNativeBlueprintRecipeOverridePendingCommand,
  type NativeBlueprintRecipeOverrideAuthorityObservation,
  type NativeBlueprintRecipeOverrideBlockedReason,
  type NativeBlueprintRecipeOverridePendingCommand,
} from "./nativeBlueprintRecipeOverrideCommandReconciliation";
import {
  prepareNativeBlueprintRecipeOverrideIntentCommand,
} from "./nativeBlueprintRecipeOverrideIntentCommands";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import {
  nativeBlueprintRecipeOverrideBindingMatchesFrame,
  selectNativeBlueprintRecipeOverrideProjectionBinding,
  type NativeBlueprintRecipeOverrideBinding,
  type NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";

interface ReadRef<T> {
  readonly current: T;
}

interface MutableBooleanRef {
  current: boolean;
}

export interface NativeBlueprintRecipeOverrideCommandTransactionOptions {
  readonly authority: NativeBlueprintRecipeOverrideAuthorityObservation | null;
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

export interface NativeBlueprintRecipeOverrideCommandTransaction {
  readonly pending: NativeBlueprintRecipeOverridePendingCommand | null;
  readonly commit: (
    binding: NativeBlueprintRecipeOverrideBinding,
    targetRecipeId: string,
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

/**
 * One-shot renderer lifecycle for a Rust-owned blueprint recipe target. A
 * transport failure can only trigger six bounded read-only receipt lookups;
 * the mutation itself is never resent. Uncertain results remain locked until
 * the authority explicitly enters another session/run.
 */
export function useNativeBlueprintRecipeOverrideCommandTransaction(
  options: NativeBlueprintRecipeOverrideCommandTransactionOptions,
): NativeBlueprintRecipeOverrideCommandTransaction {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tokenRef = useRef(0);
  const pendingRef = useRef<NativeBlueprintRecipeOverridePendingCommand | null>(null);
  const [pending, setPending] = useState<NativeBlueprintRecipeOverridePendingCommand | null>(null);

  const publishPending = useCallback((
    next: NativeBlueprintRecipeOverridePendingCommand | null,
  ): void => {
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
    currentPending: NativeBlueprintRecipeOverridePendingCommand,
    reason: NativeBlueprintRecipeOverrideBlockedReason,
    notice: string,
  ): void => {
    if (pendingRef.current?.token !== currentPending.token) return;
    publishPending(updateNativeBlueprintRecipeOverridePendingCommand(currentPending, "blocked", {
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
    currentPending: NativeBlueprintRecipeOverridePendingCommand,
  ): Promise<void> => {
    const result = await reconcileNativeBlueprintRecipeOverridePendingCommand({
      pending: currentPending,
      isCurrent: () => pendingRef.current?.token === currentPending.token,
      wait: optionsRef.current.wait ?? defaultWait,
    });
    if (pendingRef.current?.token !== currentPending.token || result.status === "cancelled") return;
    if (result.status === "not-committed") {
      finishPending(currentPending.token, "Rust 已确认这次蓝图配方覆盖没有提交；界面已安全解锁");
      refreshProjection(null, null);
      return;
    }
    if (result.status === "committed") {
      const awaitingProjection = updateNativeBlueprintRecipeOverridePendingCommand(
        currentPending,
        "awaiting-projection",
        { receipt: result.receipt },
      );
      publishPending(awaitingProjection);
      optionsRef.current.setNotice(
        "Rust 已确认蓝图配方覆盖提交；正在等待不早于回执 revision 的同 lineage 目标投影",
      );
      refreshProjection(
        currentPending.token,
        "蓝图配方覆盖提交已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
      return;
    }
    const notice = result.reason === "conflict"
      ? "原生蓝图配方覆盖对账发现 revision 冲突；操作保持锁定且不会自动重发"
      : result.reason === "pending-timeout"
        ? "原生蓝图配方覆盖在六次有界只读对账后仍未定案；操作保持锁定且不会自动重发"
        : result.reason === "reconciliation-unavailable"
          ? "原生蓝图配方覆盖对账接口暂不可用；操作保持锁定且不会自动重发"
          : "原生蓝图配方覆盖回执无法证明与原命令一致；操作保持锁定且不会自动重发";
    blockPending(currentPending, result.reason, notice);
  }, [blockPending, finishPending, publishPending, refreshProjection]);

  const handleDispatchFailure = useCallback((
    initialPending: NativeBlueprintRecipeOverridePendingCommand,
    error: unknown,
  ): void => {
    if (pendingRef.current?.token !== initialPending.token) return;
    if (isProvenPreDispatchFailure(error)) {
      finishPending(
        initialPending.token,
        "原生蓝图配方覆盖命令在发送前失败；存档未改变，界面已安全解锁",
      );
      return;
    }
    const reconciling = updateNativeBlueprintRecipeOverridePendingCommand(
      initialPending,
      "reconciling",
    );
    publishPending(reconciling);
    optionsRef.current.setNotice(
      "原生蓝图配方覆盖结果暂时不确定；正在六次有界只读对账，期间绝不会重发命令",
    );
    void reconcileTransport(reconciling);
  }, [finishPending, publishPending, reconcileTransport]);

  const commit = useCallback((
    binding: NativeBlueprintRecipeOverrideBinding,
    targetRecipeId: string,
  ): boolean => {
    const current = optionsRef.current;
    if (current.rejectPlayerStateEdit()) return false;
    if (!current.authorityOwnedRef.current || current.commandInFlightRef.current || pendingRef.current) {
      current.setNotice("Windows 原生权威正在确认上一项操作；本次蓝图配方覆盖未提交");
      return false;
    }
    const source = current.commandSourceRef.current?.source ?? null;
    let command: ReturnType<typeof prepareNativeBlueprintRecipeOverrideIntentCommand>;
    try {
      command = prepareNativeBlueprintRecipeOverrideIntentCommand(
        binding,
        targetRecipeId,
        current.frame,
        source,
      );
    } catch {
      current.setNotice("原生蓝图配方覆盖参数或 revision 已到安全上限；本次操作未提交");
      return false;
    }
    if (!source || !command ||
        !nativeBlueprintRecipeOverrideBindingMatchesFrame(binding, current.frame)) {
      current.setNotice("原生蓝图选中行、配方目标或命令 source 已过期；本次操作未提交");
      return false;
    }
    if (tokenRef.current >= Number.MAX_SAFE_INTEGER) {
      current.setNotice("原生蓝图配方覆盖事务序列已耗尽；本次操作未提交");
      return false;
    }
    tokenRef.current += 1;
    let initialPending: NativeBlueprintRecipeOverridePendingCommand;
    try {
      initialPending = createNativeBlueprintRecipeOverridePendingCommand({
        token: tokenRef.current,
        source,
        command,
        binding,
        targetRecipeId,
      });
    } catch {
      current.setNotice("原生蓝图配方覆盖命令未通过精确事务边界；本次操作未提交");
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
      let awaitingProjection: NativeBlueprintRecipeOverridePendingCommand;
      try {
        awaitingProjection = updateNativeBlueprintRecipeOverridePendingCommand(
          initialPending,
          "awaiting-projection",
          { receipt: asNativeBlueprintRecipeOverrideCommitReceipt(initialPending, receipt) },
        );
      } catch {
        blockPending(
          initialPending,
          "receipt-invalid",
          "原生蓝图配方覆盖已发送但回执与命令不一致；操作保持锁定且不会自动重发",
        );
        return;
      }
      publishPending(awaitingProjection);
      optionsRef.current.setNotice(
        "Rust 已提交蓝图配方覆盖；正在等待同 lineage 的精确目标状态投影",
      );
      refreshProjection(
        initialPending.token,
        "蓝图配方覆盖提交已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
    }).catch((error: unknown) => handleDispatchFailure(initialPending, error));
    return true;
  }, [blockPending, handleDispatchFailure, publishPending, refreshProjection]);

  useEffect(() => {
    const currentPending = pendingRef.current;
    if (!currentPending) return;
    const projection = selectNativeBlueprintRecipeOverrideProjectionBinding(
      options.frame,
      currentPending.sourceRecipeId,
    );
    const result = evaluateNativeBlueprintRecipeOverridePendingProjection(
      currentPending,
      options.authority,
      projection,
    );
    if (result.status === "lineage-changed") {
      finishPending(
        currentPending.token,
        "原生权威已进入新的 session/run；旧蓝图配方覆盖事务已安全结束，且不会在新 lineage 重发",
      );
      return;
    }
    if (currentPending.phase === "blocked") return;
    if (result.status === "confirmed") {
      finishPending(currentPending.token, "蓝图配方目标已由 Rust 权威投影精确确认");
      return;
    }
    if (result.status === "blocked" && currentPending.blockedReason !== result.reason) {
      blockPending(
        currentPending,
        result.reason,
        "同 lineage 蓝图投影与已提交配方目标不一致；操作保持锁定且不会自动重发",
      );
    }
  }, [blockPending, finishPending, options.authority, options.frame, pending]);

  return { pending, commit };
}
