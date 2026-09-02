export interface NativeAuthorityInteractionEpoch {
  readonly ownsRuntime: boolean;
  readonly epoch: number;
}

export function createNativeAuthorityInteractionEpoch(ownsRuntime: boolean): NativeAuthorityInteractionEpoch {
  return { ownsRuntime, epoch: 0 };
}

export function reconcileNativeAuthorityInteractionEpoch(
  current: NativeAuthorityInteractionEpoch,
  ownsRuntime: boolean,
): NativeAuthorityInteractionEpoch {
  return current.ownsRuntime === ownsRuntime
    ? current
    : { ownsRuntime, epoch: current.epoch + 1 };
}

export function canResumeLegacyInteractionAfterAwait(
  startedEpoch: number,
  current: NativeAuthorityInteractionEpoch,
): boolean {
  return !current.ownsRuntime && current.epoch === startedEpoch;
}
