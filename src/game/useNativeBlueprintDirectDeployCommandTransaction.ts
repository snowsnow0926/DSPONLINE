import { useCallback, useEffect, useRef, useState } from "react";

import {
  asNativeBlueprintDirectDeployCommitReceipt,
  createNativeBlueprintDirectDeployPendingCommand,
  evaluateNativeBlueprintDirectDeployTopology,
  reconcileNativeBlueprintDirectDeployPendingCommand,
  updateNativeBlueprintDirectDeployPendingCommand,
  type NativeBlueprintDirectDeployAuthorityObservation,
  type NativeBlueprintDirectDeployBlockedReason,
  type NativeBlueprintDirectDeployPendingCommand,
  type NativeBlueprintDirectDeployTopologyObservation,
} from "./nativeBlueprintDirectDeployCommandReconciliation";
import type { NativeBlueprintDirectDeployContext } from "./nativeBlueprintDirectDeployContext";
import { prepareNativeBlueprintDirectDeployIntentCommand } from "./nativeBlueprintDirectDeployIntentCommands";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";

interface ReadRef<T> {
  readonly current: T;
}

interface MutableBooleanRef {
  current: boolean;
}

export interface NativeBlueprintDirectDeployCommandTransactionOptions {
  readonly authority: NativeBlueprintDirectDeployAuthorityObservation | null;
  readonly topology: NativeBlueprintDirectDeployTopologyObservation | null;
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

export interface NativeBlueprintDirectDeployCommandTransaction {
  readonly pending: NativeBlueprintDirectDeployPendingCommand | null;
  readonly commit: (context: NativeBlueprintDirectDeployContext) => boolean;
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
 * Dispatches exactly one Rust-owned direct-deploy marker. Unknown transport
 * outcomes perform six read-only receipt lookups and never resend. A durable
 * receipt releases only after the same authority lineage/registry publishes a
 * native factory topology revision at or beyond the ACK.
 */
export function useNativeBlueprintDirectDeployCommandTransaction(
  options: NativeBlueprintDirectDeployCommandTransactionOptions,
): NativeBlueprintDirectDeployCommandTransaction {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tokenRef = useRef(0);
  const pendingRef = useRef<NativeBlueprintDirectDeployPendingCommand | null>(null);
  const [pending, setPending] = useState<NativeBlueprintDirectDeployPendingCommand | null>(null);

  const publishPending = useCallback((next: NativeBlueprintDirectDeployPendingCommand | null): void => {
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
    currentPending: NativeBlueprintDirectDeployPendingCommand,
    reason: NativeBlueprintDirectDeployBlockedReason,
    notice: string,
  ): void => {
    if (pendingRef.current?.token !== currentPending.token) return;
    publishPending(updateNativeBlueprintDirectDeployPendingCommand(currentPending, "blocked", {
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
    currentPending: NativeBlueprintDirectDeployPendingCommand,
  ): Promise<void> => {
    const result = await reconcileNativeBlueprintDirectDeployPendingCommand({
      pending: currentPending,
      isCurrent: () => pendingRef.current?.token === currentPending.token,
      wait: optionsRef.current.wait ?? defaultWait,
    });
    if (pendingRef.current?.token !== currentPending.token || result.status === "cancelled") return;
    if (result.status === "not-committed") {
      finishPending(currentPending.token, "Rust 已确认这次蓝图直接部署没有提交；界面已安全解锁");
      refreshProjection(null, null);
      return;
    }
    if (result.status === "committed") {
      const awaitingTopology = updateNativeBlueprintDirectDeployPendingCommand(
        currentPending,
        "awaiting-topology",
        { receipt: result.receipt },
      );
      publishPending(awaitingTopology);
      optionsRef.current.setNotice(
        "Rust 已确认蓝图直接部署；正在等待同 lineage 的原生工厂拓扑 revision",
      );
      refreshProjection(
        currentPending.token,
        "蓝图直接部署已确认，但权威拓扑刷新暂时失败；操作继续锁定且不会重复提交",
      );
      return;
    }
    const notice = result.reason === "conflict"
      ? "蓝图直接部署对账发现 revision 冲突；操作保持锁定且不会自动重发"
      : result.reason === "pending-timeout"
        ? "蓝图直接部署在六次有界只读对账后仍未定案；操作保持锁定且不会自动重发"
        : result.reason === "reconciliation-unavailable"
          ? "蓝图直接部署对账接口暂不可用；操作保持锁定且不会自动重发"
          : "蓝图直接部署回执无法证明与原命令一致；操作保持锁定且不会自动重发";
    blockPending(currentPending, result.reason, notice);
  }, [blockPending, finishPending, publishPending, refreshProjection]);

  const handleDispatchFailure = useCallback((
    initialPending: NativeBlueprintDirectDeployPendingCommand,
    error: unknown,
  ): void => {
    if (pendingRef.current?.token !== initialPending.token) return;
    if (isProvenPreDispatchFailure(error)) {
      finishPending(
        initialPending.token,
        "蓝图直接部署命令在发送前失败；存档未改变，界面已安全解锁",
      );
      return;
    }
    const reconciling = updateNativeBlueprintDirectDeployPendingCommand(
      initialPending,
      "reconciling",
    );
    publishPending(reconciling);
    optionsRef.current.setNotice(
      "蓝图直接部署结果暂时不确定；正在六次有界只读对账，期间绝不会重发命令",
    );
    void reconcileTransport(reconciling);
  }, [finishPending, publishPending, reconcileTransport]);

  const commit = useCallback((context: NativeBlueprintDirectDeployContext): boolean => {
    const current = optionsRef.current;
    if (current.rejectPlayerStateEdit()) return false;
    if (!current.authorityOwnedRef.current || current.commandInFlightRef.current || pendingRef.current) {
      current.setNotice("Windows 原生权威正在确认上一项操作；本次蓝图直接部署未提交");
      return false;
    }
    const source = current.commandSourceRef.current?.source ?? null;
    const authority = current.authority;
    let command: ReturnType<typeof prepareNativeBlueprintDirectDeployIntentCommand>;
    try {
      command = prepareNativeBlueprintDirectDeployIntentCommand(context, source);
    } catch {
      current.setNotice("蓝图直接部署参数或 revision 已到安全上限；本次操作未提交");
      return false;
    }
    if (!source || !command || !authority ||
        authority.sessionId !== context.sessionId || authority.runId !== context.runId ||
        authority.revision !== context.revision) {
      current.setNotice("蓝图直接部署凭证、权威 revision 或命令 source 已过期；本次操作未提交");
      return false;
    }
    if (tokenRef.current >= Number.MAX_SAFE_INTEGER) {
      current.setNotice("蓝图直接部署事务序列已耗尽；本次操作未提交");
      return false;
    }
    tokenRef.current += 1;
    let initialPending: NativeBlueprintDirectDeployPendingCommand;
    try {
      initialPending = createNativeBlueprintDirectDeployPendingCommand({
        token: tokenRef.current,
        source,
        command,
        context,
      });
    } catch {
      current.setNotice("蓝图直接部署命令未通过精确事务边界；本次操作未提交");
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
      let awaitingTopology: NativeBlueprintDirectDeployPendingCommand;
      try {
        awaitingTopology = updateNativeBlueprintDirectDeployPendingCommand(
          initialPending,
          "awaiting-topology",
          { receipt: asNativeBlueprintDirectDeployCommitReceipt(initialPending, receipt) },
        );
      } catch {
        blockPending(
          initialPending,
          "receipt-invalid",
          "蓝图直接部署已发送但回执与命令不一致；操作保持锁定且不会自动重发",
        );
        return;
      }
      publishPending(awaitingTopology);
      optionsRef.current.setNotice(
        "Rust 已提交蓝图直接部署；正在等待同 lineage 的原生工厂拓扑 revision",
      );
      refreshProjection(
        initialPending.token,
        "蓝图直接部署已确认，但权威拓扑刷新暂时失败；操作继续锁定且不会重复提交",
      );
    }).catch((error: unknown) => handleDispatchFailure(initialPending, error));
    return true;
  }, [blockPending, handleDispatchFailure, publishPending, refreshProjection]);

  useEffect(() => {
    const currentPending = pendingRef.current;
    if (!currentPending) return;
    const result = evaluateNativeBlueprintDirectDeployTopology(currentPending, options.topology);
    if (result.status === "lineage-changed") {
      finishPending(
        currentPending.token,
        "原生权威已进入新的 session/run；旧蓝图直接部署事务已安全结束，且不会在新 lineage 重发",
      );
      return;
    }
    if (currentPending.phase === "blocked") return;
    if (result.status === "confirmed") {
      finishPending(currentPending.token, "蓝图直接部署已由 Rust 原生工厂拓扑 revision 确认");
      return;
    }
    if (result.status === "blocked") {
      blockPending(
        currentPending,
        result.reason,
        "原生工厂拓扑身份与已提交蓝图直接部署不一致；操作保持锁定且不会自动重发",
      );
    }
  }, [blockPending, finishPending, options.topology, pending]);

  return { pending, commit };
}
