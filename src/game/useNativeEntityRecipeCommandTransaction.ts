import { useCallback, useEffect, useRef, useState } from "react";

import { RECIPES } from "./content";
import {
  createNativeEntityRecipePendingCommand,
  evaluateNativeEntityRecipePendingProjection,
  reconcileNativeEntityRecipePendingCommand,
  updateNativeEntityRecipePendingCommand,
  asNativeEntityRecipeCommitReceipt,
  type NativeEntityRecipeAuthorityObservation,
  type NativeEntityRecipePendingCommand,
  type NativeEntityRecipeReconciliationBlockedReason,
} from "./nativeEntityRecipeCommandReconciliation";
import {
  createNativeProjectedEntityRecipeCommand,
  type NativeProjectedEntityRecipeBinding,
} from "./nativeProjectedEntityRecipeCommands";
import type { NativePlayerAuthorityCommandSource } from "./nativePlayerAuthorityCommandSource";
import {
  NativePlayerAuthorityCommandSourceError,
} from "./nativePlayerAuthorityCommandSource";
import type { RecipeId } from "./types";

interface ReadRef<T> {
  readonly current: T;
}

interface MutableBooleanRef {
  current: boolean;
}

export interface NativeEntityRecipeCommandTransactionOptions {
  readonly authority: NativeEntityRecipeAuthorityObservation | null;
  readonly projection: NativeProjectedEntityRecipeBinding | null;
  readonly authorityOwnedRef: ReadRef<boolean>;
  readonly commandInFlightRef: MutableBooleanRef;
  readonly commandSourceRef: ReadRef<Readonly<{
    source: NativePlayerAuthorityCommandSource;
  }> | null>;
  readonly setCommandPending: (pending: boolean) => void;
  readonly rejectPlayerStateEdit: () => boolean;
  readonly invalidateProjection: () => void;
  readonly refreshAuthority: () => Promise<void> | undefined;
  readonly setNotice: (notice: string) => void;
  /** Test seam only; production uses a bounded browser timer. */
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface NativeEntityRecipeCommandTransaction {
  readonly pending: NativeEntityRecipePendingCommand | null;
  readonly commit: (
    binding: NativeProjectedEntityRecipeBinding,
    targetRecipeId: RecipeId,
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
  // The production source assigns its renderer-local command ID immediately
  // before invoking the desktop bridge and attaches that ID to every error
  // after that point. Its only null-ID transport uncertainty is a failed
  // preflight clock read, before applyNativeCoreCommand can run. Unknown
  // implementations/errors are therefore never safe to classify by the
  // absence of an ad-hoc `commandId` property alone.
  return error instanceof NativePlayerAuthorityCommandSourceError && error.commandId === null;
}

/**
 * Owns the complete renderer lifecycle for one destructive recipe transition.
 *
 * The initial mutation is dispatched exactly once. Any outcome after dispatch
 * is resolved only through the source's read-only reconciliation API and an
 * exact same-lineage authoritative projection. Keeping this lifecycle in one
 * hook makes the real App wiring behavior-testable instead of relying on
 * source-text assertions around several unrelated callbacks and effects.
 */
export function useNativeEntityRecipeCommandTransaction(
  options: NativeEntityRecipeCommandTransactionOptions,
): NativeEntityRecipeCommandTransaction {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tokenRef = useRef(0);
  const pendingRef = useRef<NativeEntityRecipePendingCommand | null>(null);
  const [pending, setPending] = useState<NativeEntityRecipePendingCommand | null>(null);

  const publishPending = useCallback((next: NativeEntityRecipePendingCommand | null): void => {
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
    currentPending: NativeEntityRecipePendingCommand,
    reason: NativeEntityRecipeReconciliationBlockedReason,
    notice: string,
  ): void => {
    if (pendingRef.current?.token !== currentPending.token) return;
    publishPending(updateNativeEntityRecipePendingCommand(currentPending, "blocked", {
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
    currentPending: NativeEntityRecipePendingCommand,
  ): Promise<void> => {
    const result = await reconcileNativeEntityRecipePendingCommand({
      pending: currentPending,
      isCurrent: () => pendingRef.current?.token === currentPending.token,
      wait: optionsRef.current.wait ?? defaultWait,
    });
    if (pendingRef.current?.token !== currentPending.token || result.status === "cancelled") return;
    if (result.status === "not-committed") {
      finishPending(
        currentPending.token,
        "Rust 已确认这次建筑配方命令没有提交；界面已安全解锁",
      );
      // Non-commit is already proven by the read-only receipt. A failed UI
      // refresh does not make the mutation uncertain again.
      refreshProjection(null, null);
      return;
    }
    if (result.status === "committed") {
      const awaitingProjection = updateNativeEntityRecipePendingCommand(
        currentPending,
        "awaiting-projection",
        { receipt: result.receipt },
      );
      publishPending(awaitingProjection);
      optionsRef.current.invalidateProjection();
      optionsRef.current.setNotice(
        "Rust 已确认配方命令提交；正在等待不早于回执 revision 的同 lineage 建筑投影，期间不会重复提交",
      );
      refreshProjection(
        currentPending.token,
        "配方提交已确认，但权威投影刷新暂时失败；建筑操作继续锁定且不会重复提交",
      );
      return;
    }
    const notice = result.reason === "conflict"
      ? "原生配方命令对账发现冲突；为防止重复扣料，建筑操作保持锁定，请启动新的原生 session 后再操作"
      : result.reason === "pending-timeout"
        ? "原生配方命令在有界只读对账后仍未定案；为防止双提交，建筑操作保持锁定且不会自动重发"
        : result.reason === "reconciliation-unavailable"
          ? "原生配方命令对账接口暂时不可用；为防止双提交，建筑操作保持锁定且不会自动重发"
          : "原生配方命令回执无法证明与原命令一致；为保护库存，建筑操作保持锁定且不会自动重发";
    blockPending(currentPending, result.reason, notice);
  }, [blockPending, finishPending, publishPending, refreshProjection]);

  const handleDispatchFailure = useCallback((
    initialPending: NativeEntityRecipePendingCommand,
    error: unknown,
  ): void => {
    if (pendingRef.current?.token !== initialPending.token) return;
    if (isProvenPreDispatchFailure(error)) {
      finishPending(
        initialPending.token,
        "原生建筑配方命令在发送前失败；存档未改变，界面已安全解锁",
      );
      return;
    }
    const reconciling = updateNativeEntityRecipePendingCommand(initialPending, "reconciling");
    publishPending(reconciling);
    optionsRef.current.setNotice(
      "原生建筑配方命令结果暂时不确定；正在只读对账，期间保持锁定且绝不会重发命令",
    );
    void reconcileTransport(reconciling);
  }, [finishPending, publishPending, reconcileTransport]);

  const commit = useCallback((
    binding: NativeProjectedEntityRecipeBinding,
    targetRecipeId: RecipeId,
  ): boolean => {
    const current = optionsRef.current;
    if (current.rejectPlayerStateEdit()) return false;
    if (!current.authorityOwnedRef.current || current.commandInFlightRef.current || pendingRef.current) {
      current.setNotice("Windows 原生权威正在确认上一项操作；本次配方未提交");
      return false;
    }
    const source = current.commandSourceRef.current?.source ?? null;
    if (!source || source.sessionId !== binding.sessionId || source.runId !== binding.runId ||
        source.baseRevision !== binding.revision) {
      current.setNotice("原生建筑配方投影与命令 source 已过期；本次配方未提交");
      return false;
    }
    let command;
    try {
      command = createNativeProjectedEntityRecipeCommand(binding, targetRecipeId);
    } catch {
      current.setNotice("原生建筑配方目录未通过同 revision 完整性校验；存档未改变");
      return false;
    }
    if (!command) return false;
    if (tokenRef.current >= Number.MAX_SAFE_INTEGER) {
      current.setNotice("原生建筑配方事务序列已耗尽；本次配方未提交");
      return false;
    }
    tokenRef.current += 1;
    let initialPending: NativeEntityRecipePendingCommand;
    try {
      initialPending = createNativeEntityRecipePendingCommand({
        token: tokenRef.current,
        source,
        command,
        binding,
        targetRecipeId,
      });
    } catch {
      current.setNotice("原生建筑配方命令未通过精确事务边界校验；本次配方未提交");
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
      let awaitingProjection: NativeEntityRecipePendingCommand;
      try {
        awaitingProjection = updateNativeEntityRecipePendingCommand(
          initialPending,
          "awaiting-projection",
          { receipt: asNativeEntityRecipeCommitReceipt(initialPending, receipt) },
        );
      } catch {
        blockPending(
          initialPending,
          "receipt-invalid",
          "原生配方命令已发送但回执无法证明与原命令一致；为保护库存，建筑操作保持锁定且不会自动重发",
        );
        return;
      }
      publishPending(awaitingProjection);
      optionsRef.current.invalidateProjection();
      optionsRef.current.setNotice(
        "Rust 已提交建筑配方命令；正在等待不早于回执 revision 的同 lineage 目标配方投影",
      );
      refreshProjection(
        initialPending.token,
        "配方提交已确认，但权威投影刷新暂时失败；建筑操作继续锁定且不会重复提交",
      );
    }).catch((error: unknown) => handleDispatchFailure(initialPending, error));
    return true;
  }, [blockPending, handleDispatchFailure, publishPending, refreshProjection]);

  useEffect(() => {
    const currentPending = pendingRef.current;
    if (!currentPending) return;
    const result = evaluateNativeEntityRecipePendingProjection(
      currentPending,
      options.authority,
      options.projection,
    );
    if (result.status === "lineage-changed") {
      finishPending(
        currentPending.token,
        "原生权威已进入新的 session/run；旧配方事务已安全结束，且不会在新 lineage 重发",
      );
      return;
    }
    // A contradiction or unprovable transport result is terminal for this
    // lineage. A later projection must not silently turn that blocked command
    // back into success; only an explicit session/run handoff can retire it.
    if (currentPending.phase === "blocked") return;
    if (result.status === "confirmed") {
      finishPending(
        currentPending.token,
        `已由 Rust 将当前建筑配方切换为${RECIPES[currentPending.targetRecipeId]?.name ?? currentPending.targetRecipeId}`,
      );
      return;
    }
    if (result.status === "blocked" && currentPending.blockedReason !== result.reason) {
      blockPending(
        currentPending,
        result.reason,
        "不早于配方命令回执 revision 的同 lineage 建筑投影与目标配方不一致；为保护库存，建筑操作保持锁定",
      );
    }
  }, [blockPending, finishPending, options.authority, options.projection, pending]);

  return { pending, commit };
}
