import { useCallback, useEffect, useRef, useState } from "react";

import {
  asNativeConstructionQueueDeployCommitReceipt,
  attachNativeConstructionQueueDeployMembershipProof,
  clearNativeConstructionQueueDeployMembershipProof,
  createNativeConstructionQueueDeployPendingCommand,
  evaluateNativeConstructionQueueDeployPendingProjection,
  reconcileNativeConstructionQueueDeployPendingCommand,
  updateNativeConstructionQueueDeployPendingCommand,
  type NativeConstructionQueueDeployAuthorityObservation,
  type NativeConstructionQueueDeployBlockedReason,
  type NativeConstructionQueueDeployPendingCommand,
} from "./nativeConstructionQueueDeployCommandReconciliation";
import { prepareNativeConstructionQueueDeployIntentCommand } from "./nativeConstructionQueueDeployIntentCommands";
import {
  NativePlayerAuthorityCommandSourceError,
  type NativePlayerAuthorityCommandSource,
} from "./nativePlayerAuthorityCommandSource";
import type {
  NativeBlueprintWorkspaceFrame,
  NativeBlueprintWorkspaceSource,
  NativeConstructionQueueDeployBinding,
} from "./nativeBlueprintWorkspaceStore";

interface ReadRef<T> {
  readonly current: T;
}

interface MutableBooleanRef {
  current: boolean;
}

export interface NativeConstructionQueueDeployCommandTransactionOptions {
  readonly authority: NativeConstructionQueueDeployAuthorityObservation | null;
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
  /** Test seam only; production uses bounded browser timers. */
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface NativeConstructionQueueDeployCommandTransaction {
  readonly pending: NativeConstructionQueueDeployPendingCommand | null;
  readonly commit: (binding: NativeConstructionQueueDeployBinding) => boolean;
}

export const NATIVE_CONSTRUCTION_QUEUE_DEPLOY_MEMBERSHIP_RETRY_DELAYS_MS = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
] as const);

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

/** Dispatches one Rust-owned deploy marker exactly once, then proves queue absence read-only. */
export function useNativeConstructionQueueDeployCommandTransaction(
  options: NativeConstructionQueueDeployCommandTransactionOptions,
): NativeConstructionQueueDeployCommandTransaction {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tokenRef = useRef(0);
  const membershipFlightRef = useRef<Readonly<{ key: string }> | null>(null);
  const membershipAttemptRef = useRef<{
    token: number;
    revision: number;
    attempts: number;
  } | null>(null);
  const pendingRef = useRef<NativeConstructionQueueDeployPendingCommand | null>(null);
  const [pending, setPending] = useState<NativeConstructionQueueDeployPendingCommand | null>(null);
  const [membershipRetryEpoch, setMembershipRetryEpoch] = useState(0);

  const publishPending = useCallback((next: NativeConstructionQueueDeployPendingCommand | null): void => {
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

  const blockPending = useCallback((
    currentPending: NativeConstructionQueueDeployPendingCommand,
    reason: NativeConstructionQueueDeployBlockedReason,
    notice: string,
  ): void => {
    if (pendingRef.current?.token !== currentPending.token) return;
    membershipFlightRef.current = null;
    membershipAttemptRef.current = null;
    publishPending(updateNativeConstructionQueueDeployPendingCommand(currentPending, "blocked", {
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
    currentPending: NativeConstructionQueueDeployPendingCommand,
  ): Promise<void> => {
    const result = await reconcileNativeConstructionQueueDeployPendingCommand({
      pending: currentPending,
      isCurrent: () => pendingRef.current?.token === currentPending.token,
      wait: optionsRef.current.wait ?? defaultWait,
    });
    if (pendingRef.current?.token !== currentPending.token || result.status === "cancelled") return;
    if (result.status === "not-committed") {
      finishPending(currentPending.token, "Rust 已确认这次开始建造没有提交；界面已安全解锁");
      refreshProjection(null, null);
      return;
    }
    if (result.status === "committed") {
      const awaitingProjection = updateNativeConstructionQueueDeployPendingCommand(
        currentPending,
        "awaiting-projection",
        { receipt: result.receipt },
      );
      publishPending(awaitingProjection);
      optionsRef.current.setNotice("Rust 已确认开始建造提交；正在读取同 lineage 的精确队列缺席证明");
      refreshProjection(
        currentPending.token,
        "施工部署已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
      return;
    }
    const notice = result.reason === "conflict"
      ? "施工部署对账发现 revision 冲突；操作保持锁定且不会自动重发"
      : result.reason === "pending-timeout"
        ? "施工部署在六次有界只读对账后仍未定案；操作保持锁定且不会自动重发"
        : result.reason === "reconciliation-unavailable"
          ? "施工部署对账接口暂不可用；操作保持锁定且不会自动重发"
          : "施工部署回执无法证明与原命令一致；操作保持锁定且不会自动重发";
    blockPending(currentPending, result.reason, notice);
  }, [blockPending, finishPending, publishPending, refreshProjection]);

  const handleDispatchFailure = useCallback((
    initialPending: NativeConstructionQueueDeployPendingCommand,
    error: unknown,
  ): void => {
    if (pendingRef.current?.token !== initialPending.token) return;
    if (isProvenPreDispatchFailure(error)) {
      finishPending(initialPending.token, "开始建造命令在发送前失败；存档未改变，界面已安全解锁");
      return;
    }
    const reconciling = updateNativeConstructionQueueDeployPendingCommand(initialPending, "reconciling");
    publishPending(reconciling);
    optionsRef.current.setNotice(
      "施工部署结果暂时不确定；正在六次有界只读对账，期间绝不会重发命令",
    );
    void reconcileTransport(reconciling);
  }, [finishPending, publishPending, reconcileTransport]);

  const commit = useCallback((binding: NativeConstructionQueueDeployBinding): boolean => {
    const current = optionsRef.current;
    if (current.rejectPlayerStateEdit()) return false;
    if (!current.authorityOwnedRef.current || current.commandInFlightRef.current || pendingRef.current) {
      current.setNotice("Windows 原生权威正在确认上一项操作；本次开始建造未提交");
      return false;
    }
    const source = current.commandSourceRef.current?.source ?? null;
    const authority = current.authority;
    const membershipSource = current.membershipSource;
    let command: ReturnType<typeof prepareNativeConstructionQueueDeployIntentCommand>;
    try {
      command = prepareNativeConstructionQueueDeployIntentCommand(binding, current.frame, source);
    } catch {
      current.setNotice("施工部署参数或 revision 已到安全上限；本次开始建造未提交");
      return false;
    }
    if (!source || !command || !authority || !membershipSource ||
        authority.sessionId !== binding.sessionId || authority.runId !== binding.runId ||
        authority.revision !== binding.revision ||
        membershipSource.boundIdentity.sessionId !== binding.sessionId ||
        membershipSource.boundIdentity.runId !== binding.runId ||
        membershipSource.boundIdentity.revision !== binding.revision ||
        membershipSource.boundIdentity.registryFingerprint !== binding.registryFingerprint) {
      current.setNotice("施工队列行、权威 revision 或命令 source 已过期；本次开始建造未提交");
      return false;
    }
    if (tokenRef.current >= Number.MAX_SAFE_INTEGER) {
      current.setNotice("施工部署事务序列已耗尽；本次开始建造未提交");
      return false;
    }
    tokenRef.current += 1;
    let initialPending: NativeConstructionQueueDeployPendingCommand;
    try {
      initialPending = createNativeConstructionQueueDeployPendingCommand({
        token: tokenRef.current,
        source,
        command,
        binding,
      });
    } catch {
      current.setNotice("施工部署命令未通过精确事务边界；本次开始建造未提交");
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
      let awaitingProjection: NativeConstructionQueueDeployPendingCommand;
      try {
        awaitingProjection = updateNativeConstructionQueueDeployPendingCommand(
          initialPending,
          "awaiting-projection",
          { receipt: asNativeConstructionQueueDeployCommitReceipt(initialPending, receipt) },
        );
      } catch {
        blockPending(
          initialPending,
          "receipt-invalid",
          "施工部署已发送但回执与命令不一致；操作保持锁定且不会自动重发",
        );
        return;
      }
      publishPending(awaitingProjection);
      optionsRef.current.setNotice("Rust 已提交开始建造；正在等待同 lineage 的精确队列缺席证明");
      refreshProjection(
        initialPending.token,
        "施工部署已确认，但权威投影刷新暂时失败；操作继续锁定且不会重复提交",
      );
    }).catch((error: unknown) => handleDispatchFailure(initialPending, error));
    return true;
  }, [blockPending, handleDispatchFailure, publishPending, refreshProjection]);

  useEffect(() => {
    const currentPending = pendingRef.current;
    if (!currentPending) return;
    const result = evaluateNativeConstructionQueueDeployPendingProjection(
      currentPending,
      options.authority,
    );
    if (result.status === "lineage-changed") {
      finishPending(
        currentPending.token,
        "原生权威已进入新的 session/run；旧施工部署事务已安全结束，且不会在新 lineage 重发",
      );
      return;
    }
    if (currentPending.phase === "blocked") return;
    if (result.status === "stale-proof") {
      membershipFlightRef.current = null;
      try {
        publishPending(clearNativeConstructionQueueDeployMembershipProof(currentPending));
        optionsRef.current.setNotice("权威 revision 已前进；正在按最新 revision 重新读取队列缺席证明");
      } catch {
        blockPending(
          currentPending,
          "receipt-projection-mismatch",
          "旧施工部署成员证明无法安全退役；操作保持锁定且不会自动重发",
        );
      }
      return;
    }
    if (result.status === "confirmed") {
      finishPending(currentPending.token, "开始建造已由 Rust 权威队列缺席证明精确确认");
      return;
    }
    if (result.status === "blocked" && currentPending.blockedReason !== result.reason) {
      blockPending(
        currentPending,
        result.reason,
        "同 lineage 队列成员证明与已提交施工部署不一致；操作保持锁定且不会自动重发",
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
        "同 lineage 施工部署成员源的 registry 已变化；操作保持锁定且不会自动重发",
      );
      return;
    }
    const flightKey = `${currentPending.token}\0${source.boundIdentity.revision}\0${currentPending.queueEntryId}`;
    if (membershipFlightRef.current?.key === flightKey) return;
    let attemptState = membershipAttemptRef.current;
    if (!attemptState || attemptState.token !== currentPending.token ||
        attemptState.revision !== source.boundIdentity.revision) {
      attemptState = { token: currentPending.token, revision: source.boundIdentity.revision, attempts: 0 };
      membershipAttemptRef.current = attemptState;
    }
    if (attemptState.attempts >= NATIVE_CONSTRUCTION_QUEUE_DEPLOY_MEMBERSHIP_RETRY_DELAYS_MS.length) {
      blockPending(
        currentPending,
        "receipt-projection-mismatch",
        "施工部署成员证明在六次有界只读重试后仍不可用；操作保持锁定且不会自动重发",
      );
      return;
    }
    const delay = NATIVE_CONSTRUCTION_QUEUE_DEPLOY_MEMBERSHIP_RETRY_DELAYS_MS[attemptState.attempts];
    attemptState.attempts += 1;
    membershipFlightRef.current = { key: flightKey };
    const requestIsStillCurrent = (): boolean => {
      const latest = pendingRef.current;
      const latestOptions = optionsRef.current;
      return Boolean(latest && latest.token === currentPending.token &&
        latest.membershipProof === null && latest.phase === "awaiting-projection" &&
        latestOptions.membershipSource && latestOptions.authority &&
        latestOptions.authority.sessionId === source.boundIdentity.sessionId &&
        latestOptions.authority.runId === source.boundIdentity.runId &&
        latestOptions.authority.revision === source.boundIdentity.revision &&
        latestOptions.membershipSource.boundIdentity.sessionId === source.boundIdentity.sessionId &&
        latestOptions.membershipSource.boundIdentity.runId === source.boundIdentity.runId &&
        latestOptions.membershipSource.boundIdentity.revision === source.boundIdentity.revision &&
        latestOptions.membershipSource.boundIdentity.registryFingerprint ===
          source.boundIdentity.registryFingerprint &&
        source.boundIdentity.sessionId === latest.sessionId &&
        source.boundIdentity.runId === latest.runId &&
        source.boundIdentity.registryFingerprint === latest.registryFingerprint);
    };
    const discardRetiredFlight = (): void => {
      if (membershipFlightRef.current?.key === flightKey) membershipFlightRef.current = null;
    };
    const retryUnavailableMembership = (latest: NativeConstructionQueueDeployPendingCommand): void => {
      discardRetiredFlight();
      const attempts = membershipAttemptRef.current;
      if (!attempts || attempts.token !== latest.token ||
          attempts.revision !== source.boundIdentity.revision ||
          attempts.attempts >= NATIVE_CONSTRUCTION_QUEUE_DEPLOY_MEMBERSHIP_RETRY_DELAYS_MS.length) {
        blockPending(
          latest,
          "receipt-projection-mismatch",
          "施工部署成员证明在六次有界只读重试后仍不可用；操作保持锁定且不会自动重发",
        );
        return;
      }
      optionsRef.current.setNotice(
        "施工部署成员证明遇到 revision 漂移或暂时不可用；正在有界只读重试，绝不会重发命令",
      );
      refreshProjection(
        latest.token,
        "施工部署已确认，但权威 revision 刷新暂时失败；只读证明仍保持有界重试",
      );
      setMembershipRetryEpoch((epoch) => epoch >= Number.MAX_SAFE_INTEGER ? 0 : epoch + 1);
    };
    void (async () => {
      if (delay > 0) await (optionsRef.current.wait ?? defaultWait)(delay);
      if (!requestIsStillCurrent()) {
        discardRetiredFlight();
        return null;
      }
      return source.readVerifiedQueueMembership(currentPending.queueEntryId);
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
        publishPending(attachNativeConstructionQueueDeployMembershipProof(latest, proof));
      } catch {
        blockPending(
          latest,
          "receipt-projection-mismatch",
          "施工部署的全队列成员证明与事务不一致；操作保持锁定且不会自动重发",
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
