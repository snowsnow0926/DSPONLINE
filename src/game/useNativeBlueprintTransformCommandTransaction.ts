import { useCallback, useEffect, useRef, useState } from "react";

import {
  asNativeBlueprintTransformCommitReceipt,
  createNativeBlueprintTransformPendingCommand,
  evaluateNativeBlueprintTransformPendingProjection,
  reconcileNativeBlueprintTransformPendingCommand,
  updateNativeBlueprintTransformPendingCommand,
  type NativeBlueprintTransformAuthorityObservation,
  type NativeBlueprintTransformBlockedReason,
  type NativeBlueprintTransformPendingCommand,
} from "./nativeBlueprintTransformCommandReconciliation";
import {
  prepareNativeBlueprintTransformIntentCommand,
} from "./nativeBlueprintTransformIntentCommands";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintMirror,
  NativeBlueprintRotation,
  NativeBlueprintTransformBinding,
  NativeBlueprintWorkspaceFrame,
} from "./nativeBlueprintWorkspaceStore";

interface ReadRef<T> {
  readonly current: T;
}

interface MutableBooleanRef {
  current: boolean;
}

export interface NativeBlueprintTransformCommandTransactionOptions {
  readonly authority: NativeBlueprintTransformAuthorityObservation | null;
  readonly projection: NativeBlueprintTransformBinding | null;
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

export interface NativeBlueprintTransformCommandTransaction {
  readonly pending: NativeBlueprintTransformPendingCommand | null;
  readonly commit: (
    binding: NativeBlueprintTransformBinding,
    rotation: NativeBlueprintRotation,
    mirror: NativeBlueprintMirror,
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
 * Real renderer lifecycle for one Rust-owned blueprint transform. It sends the
 * mutation once, then uses only bounded read-only reconciliation and exact
 * target projection confirmation. Any unprovable result stays locked for the
 * current lineage; only a new session/run retires that uncertainty.
 */
export function useNativeBlueprintTransformCommandTransaction(
  options: NativeBlueprintTransformCommandTransactionOptions,
): NativeBlueprintTransformCommandTransaction {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tokenRef = useRef(0);
  const pendingRef = useRef<NativeBlueprintTransformPendingCommand | null>(null);
  const [pending, setPending] = useState<NativeBlueprintTransformPendingCommand | null>(null);

  const publishPending = useCallback((next: NativeBlueprintTransformPendingCommand | null): void => {
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
    currentPending: NativeBlueprintTransformPendingCommand,
    reason: NativeBlueprintTransformBlockedReason,
    notice: string,
  ): void => {
    if (pendingRef.current?.token !== currentPending.token) return;
    publishPending(updateNativeBlueprintTransformPendingCommand(currentPending, "blocked", {
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
    currentPending: NativeBlueprintTransformPendingCommand,
  ): Promise<void> => {
    const result = await reconcileNativeBlueprintTransformPendingCommand({
      pending: currentPending,
      isCurrent: () => pendingRef.current?.token === currentPending.token,
      wait: optionsRef.current.wait ?? defaultWait,
    });
    if (pendingRef.current?.token !== currentPending.token || result.status === "cancelled") return;
    if (result.status === "not-committed") {
      finishPending(currentPending.token, "Rust 已确认这次蓝图变换没有提交；界面已安全解锁");
      refreshProjection(null, null);
      return;
    }
    if (result.status === "committed") {
      const awaitingProjection = updateNativeBlueprintTransformPendingCommand(
        currentPending,
        "awaiting-projection",
        { receipt: result.receipt },
      );
      publishPending(awaitingProjection);
      optionsRef.current.setNotice(
        "Rust 已确认蓝图变换提交；正在等待不早于回执 revision 的同 lineage 目标投影",
      );
      refreshProjection(
        currentPending.token,
        "蓝图变换提交已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
      return;
    }
    const notice = result.reason === "conflict"
      ? "原生蓝图变换对账发现 revision 冲突；操作保持锁定且不会自动重发"
      : result.reason === "pending-timeout"
        ? "原生蓝图变换在六次有界只读对账后仍未定案；操作保持锁定且不会自动重发"
        : result.reason === "reconciliation-unavailable"
          ? "原生蓝图变换对账接口暂不可用；操作保持锁定且不会自动重发"
          : "原生蓝图变换回执无法证明与原命令一致；操作保持锁定且不会自动重发";
    blockPending(currentPending, result.reason, notice);
  }, [blockPending, finishPending, publishPending, refreshProjection]);

  const handleDispatchFailure = useCallback((
    initialPending: NativeBlueprintTransformPendingCommand,
    error: unknown,
  ): void => {
    if (pendingRef.current?.token !== initialPending.token) return;
    if (isProvenPreDispatchFailure(error)) {
      finishPending(initialPending.token, "原生蓝图变换命令在发送前失败；存档未改变，界面已安全解锁");
      return;
    }
    const reconciling = updateNativeBlueprintTransformPendingCommand(initialPending, "reconciling");
    publishPending(reconciling);
    optionsRef.current.setNotice(
      "原生蓝图变换结果暂时不确定；正在六次有界只读对账，期间绝不会重发命令",
    );
    void reconcileTransport(reconciling);
  }, [finishPending, publishPending, reconcileTransport]);

  const commit = useCallback((
    binding: NativeBlueprintTransformBinding,
    rotation: NativeBlueprintRotation,
    mirror: NativeBlueprintMirror,
  ): boolean => {
    const current = optionsRef.current;
    if (current.rejectPlayerStateEdit()) return false;
    if (!current.authorityOwnedRef.current || current.commandInFlightRef.current || pendingRef.current) {
      current.setNotice("Windows 原生权威正在确认上一项操作；本次蓝图变换未提交");
      return false;
    }
    const source = current.commandSourceRef.current?.source ?? null;
    let command: ReturnType<typeof prepareNativeBlueprintTransformIntentCommand>;
    try {
      command = prepareNativeBlueprintTransformIntentCommand(
        binding,
        rotation,
        mirror,
        current.frame,
        source,
      );
    } catch {
      current.setNotice("原生蓝图变换参数或 revision 已到安全上限；本次变换未提交");
      return false;
    }
    if (!source || !command || !current.projection ||
        current.projection.sessionId !== binding.sessionId ||
        current.projection.runId !== binding.runId ||
        current.projection.revision !== binding.revision ||
        current.projection.registryFingerprint !== binding.registryFingerprint ||
        current.projection.blueprintId !== binding.blueprintId ||
        current.projection.currentRowRevision !== binding.currentRowRevision ||
        current.projection.currentRotation !== binding.currentRotation ||
        current.projection.currentMirror !== binding.currentMirror) {
      current.setNotice("原生蓝图选中行、目标或命令 source 已过期；本次变换未提交");
      return false;
    }
    if (tokenRef.current >= Number.MAX_SAFE_INTEGER) {
      current.setNotice("原生蓝图变换事务序列已耗尽；本次变换未提交");
      return false;
    }
    tokenRef.current += 1;
    let initialPending: NativeBlueprintTransformPendingCommand;
    try {
      initialPending = createNativeBlueprintTransformPendingCommand({
        token: tokenRef.current,
        source,
        command,
        binding,
        targetRotation: rotation,
        targetMirror: mirror,
      });
    } catch {
      current.setNotice("原生蓝图变换命令未通过精确事务边界；本次变换未提交");
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
      let awaitingProjection: NativeBlueprintTransformPendingCommand;
      try {
        awaitingProjection = updateNativeBlueprintTransformPendingCommand(
          initialPending,
          "awaiting-projection",
          { receipt: asNativeBlueprintTransformCommitReceipt(initialPending, receipt) },
        );
      } catch {
        blockPending(
          initialPending,
          "receipt-invalid",
          "原生蓝图变换已发送但回执与命令不一致；操作保持锁定且不会自动重发",
        );
        return;
      }
      publishPending(awaitingProjection);
      optionsRef.current.setNotice(
        "Rust 已提交蓝图变换；正在等待同 lineage 的精确目标状态投影",
      );
      refreshProjection(
        initialPending.token,
        "蓝图变换提交已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
    }).catch((error: unknown) => handleDispatchFailure(initialPending, error));
    return true;
  }, [blockPending, handleDispatchFailure, publishPending, refreshProjection]);

  useEffect(() => {
    const currentPending = pendingRef.current;
    if (!currentPending) return;
    const result = evaluateNativeBlueprintTransformPendingProjection(
      currentPending,
      options.authority,
      options.projection,
    );
    if (result.status === "lineage-changed") {
      finishPending(
        currentPending.token,
        "原生权威已进入新的 session/run；旧蓝图变换事务已安全结束，且不会在新 lineage 重发",
      );
      return;
    }
    if (currentPending.phase === "blocked") return;
    if (result.status === "confirmed") {
      finishPending(currentPending.token, "蓝图方向已由 Rust 权威目标投影精确确认");
      return;
    }
    if (result.status === "blocked" && currentPending.blockedReason !== result.reason) {
      blockPending(
        currentPending,
        result.reason,
        "同 lineage 蓝图投影与已提交目标方向不一致；操作保持锁定且不会自动重发",
      );
    }
  }, [blockPending, finishPending, options.authority, options.projection, pending]);

  return { pending, commit };
}
