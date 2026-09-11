import type { OfflineComplexityReport } from "./offlineComplexityTypes";
import type { DeferredLoadedGame } from "./storage";

/** Short-lived identity binding for the immutable state displayed by one menu prompt. */
export interface OfflineComplexityBinding {
  readonly source: DeferredLoadedGame;
  readonly state: DeferredLoadedGame["state"];
  readonly savedAt: number;
  readonly offlineSeconds: number;
  readonly recovery: DeferredLoadedGame["recovery"];
  readonly recoverySource: NonNullable<DeferredLoadedGame["recovery"]>["source"] | undefined;
  readonly runtimeRecoveryCandidate: DeferredLoadedGame["runtimeRecoveryCandidate"];
  readonly report: OfflineComplexityReport;
}

export function bindOfflineComplexity(source: DeferredLoadedGame, report: OfflineComplexityReport): OfflineComplexityBinding {
  return {
    source,
    state: source.state,
    savedAt: source.savedAt,
    offlineSeconds: source.offlineSeconds,
    recovery: source.recovery,
    recoverySource: source.recovery?.source,
    runtimeRecoveryCandidate: source.runtimeRecoveryCandidate,
    report,
  };
}

/** Undefined delegates to the normal classifier; never reuse across a restored or reloaded source. */
export function matchingOfflineComplexity(
  source: DeferredLoadedGame,
  binding?: OfflineComplexityBinding,
): OfflineComplexityReport | undefined {
  return binding?.source === source && binding.state === source.state && binding.savedAt === source.savedAt &&
    binding.offlineSeconds === source.offlineSeconds && binding.recovery === source.recovery &&
    binding.recoverySource === source.recovery?.source && binding.runtimeRecoveryCandidate === source.runtimeRecoveryCandidate
    ? binding.report
    : undefined;
}
