import { useCallback, useEffect, useRef, useState } from "react";

import {
  asNativeBlueprintImportCommitReceipt,
  attachNativeBlueprintImportMembershipProof,
  clearNativeBlueprintImportMembershipProof,
  createNativeBlueprintImportPendingCommand,
  evaluateNativeBlueprintImportPendingProjection,
  reconcileNativeBlueprintImportPendingCommand,
  updateNativeBlueprintImportPendingCommand,
  type NativeBlueprintImportAuthorityObservation,
  type NativeBlueprintImportBlockedReason,
  type NativeBlueprintImportPendingCommand,
} from "./nativeBlueprintImportCommandReconciliation";
import type { NativeBlueprintImportContext } from "./nativeBlueprintImportContext";
import { prepareNativeBlueprintImportIntentCommand } from "./nativeBlueprintImportIntentCommands";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type { NativeBlueprintWorkspaceSource } from "./nativeBlueprintWorkspaceStore";

interface ReadRef<T> { readonly current: T }
interface MutableBooleanRef { current: boolean }

export interface NativeBlueprintImportConfirmation {
  readonly sessionId: string;
  readonly runId: string;
  readonly registryFingerprint: string;
  readonly previousRevision: number;
  readonly ackRevision: number;
  readonly blueprintId: string;
  readonly blueprintName: string;
  readonly blueprintRevision: 1;
}

export interface NativeBlueprintImportCommandTransactionOptions {
  readonly authority: NativeBlueprintImportAuthorityObservation | null;
  readonly membershipSource: NativeBlueprintWorkspaceSource | null;
  readonly authorityOwnedRef: ReadRef<boolean>;
  readonly commandInFlightRef: MutableBooleanRef;
  readonly commandSourceRef: ReadRef<Readonly<{ source: NativePlayerAuthorityCommandSource }> | null>;
  readonly setCommandPending: (pending: boolean) => void;
  readonly rejectPlayerStateEdit: () => boolean;
  readonly refreshAuthority: () => Promise<void> | undefined;
  readonly setNotice: (notice: string) => void;
  readonly onConfirmed: (confirmation: NativeBlueprintImportConfirmation) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface NativeBlueprintImportCommandTransaction {
  readonly pending: NativeBlueprintImportPendingCommand | null;
  readonly commit: (context: NativeBlueprintImportContext) => boolean;
}

export const NATIVE_BLUEPRINT_IMPORT_MEMBERSHIP_RETRY_DELAYS_MS = Object.freeze([
  0, 100, 250, 500, 1_000, 2_000,
] as const);

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function isProvenPreDispatchFailure(error: unknown): error is NativePlayerAuthorityCommandSourceError {
  return error instanceof NativePlayerAuthorityCommandSourceError && error.commandId === null;
}

export function useNativeBlueprintImportCommandTransaction(
  options: NativeBlueprintImportCommandTransactionOptions,
): NativeBlueprintImportCommandTransaction {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tokenRef = useRef(0);
  const pendingRef = useRef<NativeBlueprintImportPendingCommand | null>(null);
  const membershipFlightRef = useRef<string | null>(null);
  const membershipAttemptsRef = useRef<{
    token: number;
    revision: number;
    attempts: number;
  } | null>(null);
  const [pending, setPending] = useState<NativeBlueprintImportPendingCommand | null>(null);
  const [retryEpoch, setRetryEpoch] = useState(0);

  const publishPending = useCallback((next: NativeBlueprintImportPendingCommand | null): void => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const finishPending = useCallback((token: number, notice: string): boolean => {
    if (pendingRef.current?.token !== token) return false;
    publishPending(null);
    membershipFlightRef.current = null;
    membershipAttemptsRef.current = null;
    const current = optionsRef.current;
    current.commandInFlightRef.current = false;
    current.setCommandPending(false);
    current.setNotice(notice);
    return true;
  }, [publishPending]);

  const blockPending = useCallback((
    currentPending: NativeBlueprintImportPendingCommand,
    reason: NativeBlueprintImportBlockedReason,
    notice: string,
  ): void => {
    if (pendingRef.current?.token !== currentPending.token) return;
    membershipFlightRef.current = null;
    membershipAttemptsRef.current = null;
    publishPending(updateNativeBlueprintImportPendingCommand(currentPending, "blocked", {
      blockedReason: reason,
    }));
    optionsRef.current.setNotice(notice);
  }, [publishPending]);

  const finishConfirmed = useCallback((currentPending: NativeBlueprintImportPendingCommand): void => {
    const receipt = currentPending.receipt;
    if (!receipt) {
      blockPending(
        currentPending,
        "receipt-projection-mismatch",
        "蓝图库成员证明缺少对应提交回执；保持锁定且不会清除导入草稿",
      );
      return;
    }
    const confirmation = Object.freeze({
      sessionId: currentPending.sessionId,
      runId: currentPending.runId,
      registryFingerprint: currentPending.registryFingerprint,
      previousRevision: receipt.previousRevision,
      ackRevision: receipt.revision,
      blueprintId: currentPending.expectedBlueprintId,
      blueprintName: currentPending.expectedBlueprintName,
      blueprintRevision: 1 as const,
    });
    if (!finishPending(currentPending.token, `已由 Rust 导入${currentPending.expectedBlueprintName}并证明蓝图库成员`)) return;
    try {
      optionsRef.current.onConfirmed(confirmation);
    } catch {
      optionsRef.current.setNotice("蓝图已安全导入，但选中新蓝图失败；可重新打开蓝图库");
    }
  }, [blockPending, finishPending]);

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
    currentPending: NativeBlueprintImportPendingCommand,
  ): Promise<void> => {
    const result = await reconcileNativeBlueprintImportPendingCommand({
      pending: currentPending,
      isCurrent: () => pendingRef.current?.token === currentPending.token,
      wait: optionsRef.current.wait ?? defaultWait,
    });
    if (pendingRef.current?.token !== currentPending.token || result.status === "cancelled") return;
    if (result.status === "not-committed") {
      finishPending(currentPending.token, "Rust 已确认这次蓝图导入没有提交；界面已安全解锁");
      refreshProjection(null, null);
      return;
    }
    if (result.status === "committed") {
      publishPending(updateNativeBlueprintImportPendingCommand(
        currentPending,
        "awaiting-projection",
        { receipt: result.receipt },
      ));
      optionsRef.current.setNotice("Rust 已确认蓝图导入；正在读取精确蓝图库成员证明");
      refreshProjection(currentPending.token, "蓝图导入已确认，但权威投影刷新失败；仍保持锁定且不会重发");
      return;
    }
    blockPending(
      currentPending,
      result.reason,
      "原生蓝图导入在六次有界只读对账后仍无法证明；操作保持锁定且绝不重发",
    );
  }, [blockPending, finishPending, publishPending, refreshProjection]);

  const handleDispatchFailure = useCallback((
    initialPending: NativeBlueprintImportPendingCommand,
    error: unknown,
  ): void => {
    if (pendingRef.current?.token !== initialPending.token) return;
    if (isProvenPreDispatchFailure(error)) {
      finishPending(initialPending.token, "蓝图导入命令在发送前失败；存档未改变，界面已解锁");
      return;
    }
    const reconciling = updateNativeBlueprintImportPendingCommand(initialPending, "reconciling");
    publishPending(reconciling);
    optionsRef.current.setNotice("蓝图导入结果暂时不确定；正在六次有界只读对账，绝不重发");
    void reconcileTransport(reconciling);
  }, [finishPending, publishPending, reconcileTransport]);

  const commit = useCallback((context: NativeBlueprintImportContext): boolean => {
    const current = optionsRef.current;
    if (current.rejectPlayerStateEdit()) return false;
    if (!current.authorityOwnedRef.current || current.commandInFlightRef.current || pendingRef.current) {
      current.setNotice("Windows 原生权威正在确认上一项操作；本次蓝图导入未提交");
      return false;
    }
    const source = current.commandSourceRef.current?.source ?? null;
    const authority = current.authority;
    const membershipSource = current.membershipSource;
    const command = prepareNativeBlueprintImportIntentCommand(context, source);
    if (!source || !command || !authority || !membershipSource ||
        authority.sessionId !== context.sessionId || authority.runId !== context.runId ||
        authority.revision !== context.revision ||
        membershipSource.boundIdentity.sessionId !== context.sessionId ||
        membershipSource.boundIdentity.runId !== context.runId ||
        membershipSource.boundIdentity.revision !== context.revision ||
        membershipSource.boundIdentity.registryFingerprint !== context.registryFingerprint) {
      current.setNotice("蓝图导入凭证、权威 revision 或命令 source 已过期；本次未提交");
      return false;
    }
    if (tokenRef.current >= Number.MAX_SAFE_INTEGER) return false;
    tokenRef.current += 1;
    let initialPending: NativeBlueprintImportPendingCommand;
    try {
      initialPending = createNativeBlueprintImportPendingCommand({
        token: tokenRef.current,
        source,
        command,
        context,
      });
    } catch {
      current.setNotice("蓝图导入命令未通过精确事务边界；本次未提交");
      return false;
    }
    publishPending(initialPending);
    membershipFlightRef.current = null;
    membershipAttemptsRef.current = null;
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
      try {
        publishPending(updateNativeBlueprintImportPendingCommand(
          initialPending,
          "awaiting-projection",
          { receipt: asNativeBlueprintImportCommitReceipt(initialPending, receipt) },
        ));
      } catch {
        blockPending(initialPending, "receipt-invalid", "蓝图导入已发送但回执不匹配；保持锁定且不会重发");
        return;
      }
      optionsRef.current.setNotice("Rust 已提交蓝图导入；等待精确蓝图库成员证明");
      refreshProjection(initialPending.token, null);
    }).catch((error: unknown) => handleDispatchFailure(initialPending, error));
    return true;
  }, [blockPending, handleDispatchFailure, publishPending, refreshProjection]);

  useEffect(() => {
    const currentPending = pendingRef.current;
    if (!currentPending) return;
    const result = evaluateNativeBlueprintImportPendingProjection(currentPending, options.authority);
    if (result.status === "lineage-changed") {
      finishPending(currentPending.token, "原生权威已进入新 session/run；旧蓝图导入事务已安全退役");
      return;
    }
    if (currentPending.phase === "blocked") return;
    if (result.status === "stale-proof") {
      membershipFlightRef.current = null;
      try {
        publishPending(clearNativeBlueprintImportMembershipProof(currentPending));
      } catch {
        blockPending(currentPending, "receipt-projection-mismatch", "旧蓝图库成员证明无法安全退役；保持锁定");
      }
      return;
    }
    if (result.status === "confirmed") {
      finishConfirmed(currentPending);
      return;
    }
    if (result.status === "blocked") {
      blockPending(currentPending, result.reason, "同 lineage 蓝图库成员证明与导入回执不一致；保持锁定");
      return;
    }
    if (currentPending.phase !== "awaiting-projection" || !currentPending.receipt ||
        currentPending.membershipProof || !options.authority) return;
    const source = options.membershipSource;
    if (!source || source.boundIdentity.sessionId !== currentPending.sessionId ||
        source.boundIdentity.runId !== currentPending.runId ||
        source.boundIdentity.revision !== options.authority.revision ||
        source.boundIdentity.revision < currentPending.receipt.revision) return;
    if (source.boundIdentity.registryFingerprint !== currentPending.registryFingerprint) {
      blockPending(currentPending, "receipt-projection-mismatch", "同 lineage 蓝图库成员源 registry 已变化；保持锁定");
      return;
    }
    const flightKey = `${currentPending.token}\0${source.boundIdentity.revision}\0${currentPending.expectedBlueprintId}`;
    if (membershipFlightRef.current === flightKey) return;
    let attempts = membershipAttemptsRef.current;
    if (!attempts || attempts.token !== currentPending.token ||
        attempts.revision !== source.boundIdentity.revision) {
      attempts = { token: currentPending.token, revision: source.boundIdentity.revision, attempts: 0 };
      membershipAttemptsRef.current = attempts;
    }
    if (attempts.attempts >= NATIVE_BLUEPRINT_IMPORT_MEMBERSHIP_RETRY_DELAYS_MS.length) {
      blockPending(currentPending, "receipt-projection-mismatch", "蓝图库成员证明六次有界读取后仍不可用；保持锁定");
      return;
    }
    const delay = NATIVE_BLUEPRINT_IMPORT_MEMBERSHIP_RETRY_DELAYS_MS[attempts.attempts];
    attempts.attempts += 1;
    membershipFlightRef.current = flightKey;
    const requestIsCurrent = (): boolean => {
      const latest = pendingRef.current;
      const latestOptions = optionsRef.current;
      return Boolean(latest && latest.token === currentPending.token &&
        latest.phase === "awaiting-projection" && latest.membershipProof === null &&
        latestOptions.authority?.sessionId === source.boundIdentity.sessionId &&
        latestOptions.authority.runId === source.boundIdentity.runId &&
        latestOptions.authority.revision === source.boundIdentity.revision &&
        latestOptions.membershipSource?.boundIdentity.sessionId === source.boundIdentity.sessionId &&
        latestOptions.membershipSource.boundIdentity.runId === source.boundIdentity.runId &&
        latestOptions.membershipSource.boundIdentity.revision === source.boundIdentity.revision &&
        latestOptions.membershipSource.boundIdentity.registryFingerprint === source.boundIdentity.registryFingerprint);
    };
    const releaseFlight = () => {
      if (membershipFlightRef.current === flightKey) membershipFlightRef.current = null;
    };
    const retry = () => {
      releaseFlight();
      const latest = pendingRef.current;
      const currentAttempts = membershipAttemptsRef.current;
      if (!latest || !currentAttempts || currentAttempts.attempts >=
          NATIVE_BLUEPRINT_IMPORT_MEMBERSHIP_RETRY_DELAYS_MS.length) {
        if (latest) blockPending(latest, "receipt-projection-mismatch", "蓝图库成员证明六次有界读取后仍不可用；保持锁定");
        return;
      }
      refreshProjection(latest.token, null);
      setRetryEpoch((epoch) => epoch >= Number.MAX_SAFE_INTEGER ? 0 : epoch + 1);
    };
    void (async () => {
      if (delay > 0) await (optionsRef.current.wait ?? defaultWait)(delay);
      if (!requestIsCurrent()) return null;
      const readMembership = source.readVerifiedLibraryMembership;
      return typeof readMembership === "function"
        ? readMembership(currentPending.expectedBlueprintId)
        : null;
    })().then((proof) => {
      if (!requestIsCurrent()) {
        releaseFlight();
        return;
      }
      const latest = pendingRef.current!;
      if (!proof) {
        retry();
        return;
      }
      try {
        publishPending(attachNativeBlueprintImportMembershipProof(latest, proof));
      } catch {
        blockPending(latest, "receipt-projection-mismatch", "蓝图库成员证明与导入事务不一致；保持锁定");
      }
    }).catch(() => {
      if (requestIsCurrent()) retry();
      else releaseFlight();
    });
  }, [
    blockPending,
    finishConfirmed,
    finishPending,
    options.authority,
    options.membershipSource,
    pending,
    publishPending,
    refreshProjection,
    retryEpoch,
  ]);

  return { pending, commit };
}
