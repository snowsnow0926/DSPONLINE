export interface NativePlayerAuthorityHandoffIdentity {
  readonly handoffId: string;
  readonly sessionId: string;
  readonly runId: string;
}

export interface NativePlayerAuthorityPreTransferState extends NativePlayerAuthorityHandoffIdentity {
  readonly phase: "prepared" | "browser-fenced" | "native-active";
}

export interface NativePlayerAuthorityCancelRequest extends NativePlayerAuthorityHandoffIdentity {
  readonly releaseAuthorized: boolean;
  readonly browserFenceAcquired: boolean;
}

export type NativePlayerAuthorityCancelDisposition =
  | "cancel-current-prepare"
  | "already-cancelled"
  | "reject";

function sameIdentity(
  left: NativePlayerAuthorityHandoffIdentity,
  right: NativePlayerAuthorityHandoffIdentity,
): boolean {
  return left.handoffId === right.handoffId && left.sessionId === right.sessionId &&
    left.runId === right.runId;
}

/**
 * Pure ACK-loss policy for the only reversible handoff phase. Once a browser
 * fence may exist, or once main may own Rust, cancel must fail closed.
 */
export function classifyNativePlayerAuthorityPreTransferCancel(input: {
  readonly request: NativePlayerAuthorityCancelRequest;
  readonly current: NativePlayerAuthorityPreTransferState | null;
  readonly lastCancelled: NativePlayerAuthorityHandoffIdentity | null;
}): NativePlayerAuthorityCancelDisposition {
  if (input.request.releaseAuthorized !== true || input.request.browserFenceAcquired !== false) {
    return "reject";
  }
  if (input.current && sameIdentity(input.request, input.current)) {
    return input.current.phase === "prepared" ? "cancel-current-prepare" : "reject";
  }
  return input.lastCancelled && sameIdentity(input.request, input.lastCancelled)
    ? "already-cancelled"
    : "reject";
}
