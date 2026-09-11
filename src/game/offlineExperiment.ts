export const APPROXIMATE_OFFLINE_EXPERIMENT_STORAGE_KEY = "dsp-idle-network.approximate-offline-experiment.v1";

export type OfflineSettlementMode = "exact" | "approximate";

export type OfflineSettlementPhase =
  | "preflight"
  | "calibration"
  | "macro"
  | "verification"
  | "fallback-exact"
  | "exact";

export interface OfflineSettlementDiagnostics {
  mode: OfflineSettlementMode;
  calibrationWindowSeconds: number;
  approximateSeconds: number;
  attemptedApproximateSeconds: number;
  exactSeconds: number;
  maximumEstimatedError: number;
  fellBack: boolean;
  fallbackReason?: string;
  calculationMs: number;
  incomplete: boolean;
  conservationVerified: boolean;
  softTimeoutExceeded: boolean;
  workerMessageCount: number;
  transport?: OfflineSettlementTransportDiagnostics;
}

export interface OfflineSettlementTransportDiagnostics {
  inputBytes: number;
  outputBytes: number;
  mainThreadEncodeMs: number;
  workerDecodeMs: number;
  workerCalculationMs: number;
  workerEncodeMs: number;
  mainThreadDecodeMs: number;
}

export interface OfflineSettlementProgress {
  phase: OfflineSettlementPhase;
  completedSeconds: number;
  totalSeconds: number;
  progress: number;
  approximateSeconds: number;
  estimatedError: number;
}

export function isApproximateOfflineExperimentEnabled(): boolean {
  try {
    return window.localStorage.getItem(APPROXIMATE_OFFLINE_EXPERIMENT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setApproximateOfflineExperimentEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(APPROXIMATE_OFFLINE_EXPERIMENT_STORAGE_KEY, "1");
    else window.localStorage.removeItem(APPROXIMATE_OFFLINE_EXPERIMENT_STORAGE_KEY);
  } catch {
    // This preference is optional and never belongs to GameState.
  }
}

export function offlineSettlementPhaseLabel(phase: OfflineSettlementPhase, locale: "zh-CN" | "en" = "zh-CN"): string {
  if (locale === "en") {
    if (phase === "preflight") return "Safety preflight";
    if (phase === "calibration") return "Exact calibration";
    if (phase === "macro") return "Macro settlement";
    if (phase === "verification") return "Exact verification";
    if (phase === "fallback-exact") return "Exact fallback";
    return "Exact settlement";
  }
  if (phase === "preflight") return "安全检查";
  if (phase === "calibration") return "精确校准";
  if (phase === "macro") return "宏观结算";
  if (phase === "verification") return "精确复核";
  if (phase === "fallback-exact") return "精确回退";
  return "精确结算";
}
