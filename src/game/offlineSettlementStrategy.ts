import type { OfflineApproximationResult } from "./offlineApproximation";
import type { OfflineComplexityReport } from "./offlineComplexityTypes";
import { FAST_OFFLINE_CALIBRATION_SECONDS } from "./offlineSettlementConstants";

export const OFFLINE_SETTLEMENT_PREFERENCE_KEY = "dsp-idle-network.offline-settlement-preference.v1";
const LEGACY_OFFLINE_APPROXIMATION_KEY = "dsp-idle-network.experimental-approximate-offline.v1";

export type OfflineSettlementPreference = "ask" | "exact" | "skip";
export type OfflineSettlementChoice = "fast" | "exact" | "skip";
export type OfflineSettlementFailureKind =
  | "timeout"
  | "worker-error"
  | "memory-risk"
  | "calibration-unstable"
  | "boundary-validation"
  | "invalid-source"
  | "cancelled"
  | "contract-rejected"
  | "unknown";

export type OfflineWorkerSettlementStrategy = "fast" | "conservative-preview" | "exact" | "invalid-source";

export function normalizeOfflineSettlementPreference(value: unknown): OfflineSettlementPreference {
  return value === "exact" || value === "skip" ? value : "ask";
}

export function readOfflineSettlementPreference(storage?: Pick<Storage, "getItem">): OfflineSettlementPreference {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!target) return "ask";
    const value = target.getItem(OFFLINE_SETTLEMENT_PREFERENCE_KEY);
    if (value !== null) return normalizeOfflineSettlementPreference(value);
    return target.getItem(LEGACY_OFFLINE_APPROXIMATION_KEY) === "false" ? "exact" : "ask";
  } catch {
    return "ask";
  }
}

export function writeOfflineSettlementPreference(preference: OfflineSettlementPreference): void {
  if (typeof window === "undefined") return;
  try {
    const normalized = normalizeOfflineSettlementPreference(preference);
    window.localStorage.setItem(OFFLINE_SETTLEMENT_PREFERENCE_KEY, normalized);
    window.localStorage.setItem(LEGACY_OFFLINE_APPROXIMATION_KEY, String(normalized !== "exact"));
  } catch { /* device preference */ }
}

function formatEstimateRange(lowerSeconds: number, upperSeconds: number): string {
  const lower = Math.max(1, Math.ceil(lowerSeconds));
  const upper = Math.max(lower + 1, Math.ceil(upperSeconds));
  if (upper < 60) return `${lower}～${upper} 秒`;
  if (lower < 60) return `${lower} 秒～${Math.ceil(upper / 60)} 分钟`;
  if (upper < 3_600) return `${Math.ceil(lower / 60)}～${Math.ceil(upper / 60)} 分钟`;
  if (lower < 3_600) return `${Math.ceil(lower / 60)} 分钟～${Math.ceil(upper / 3_600)} 小时`;
  return `${Math.ceil(lower / 3_600)}～${Math.ceil(upper / 3_600)} 小时`;
}

/**
 * A deliberately broad pre-run estimate. Exact settlement cost depends on
 * factory topology and cache boundaries, so this value is presentation-only:
 * it never changes the Worker deadline, checkpoint, or settlement result.
 */
export function estimateOfflineExactDurationLabel(seconds: number, complexity?: OfflineComplexityReport): string {
  const simulatedHours = Math.max(1 / 60, Math.max(0, seconds) / 3_600);
  const profile = complexity?.profile ?? "volatile-endgame";
  const perHourRange: Record<OfflineComplexityReport["profile"], [number, number]> = {
    simple: [1, 15],
    "stable-endgame": [10, 120],
    "volatile-endgame": [30, 300],
    complex: [60, 900],
  };
  const deviceFactor = complexity?.device.deviceClass === "low-memory"
    ? 2.5
    : complexity?.device.deviceClass === "constrained" ? 1.5 : 1;
  const [lowerPerHour, upperPerHour] = perHourRange[profile];
  return formatEstimateRange(lowerPerHour * simulatedHours * deviceFactor, upperPerHour * simulatedHours * deviceFactor);
}

export function offlineSettlementChoiceDescription(choice: OfflineSettlementChoice, seconds: number, complexity?: OfflineComplexityReport): string {
  const duration = Math.max(0, Math.floor(seconds)).toLocaleString("zh-CN");
  if (choice === "fast") return `快速结算 ${duration} 个模拟秒；目标约 30 秒，受限设备最多约 60 秒，失败后仍可再次快速尝试。`;
  if (choice === "exact") return `逐步执行 ${duration} 个模拟秒；粗略预计 ${estimateOfflineExactDurationLabel(seconds, complexity)}，运行后动态校正，可能明显超过 60 秒，可随时安全取消。`;
  return `放弃这 ${duration} 秒的生产、科研与戴森收益；需要二次确认，同一区间之后不会重复结算。`;
}

export function classifyOfflineSettlementFailure(reason: string | undefined): OfflineSettlementFailureKind {
  const normalized = (reason ?? "").toLowerCase();
  if (/取消|cancel|abort/.test(normalized)) return "cancelled";
  if (/内存|memory|low-memory/.test(normalized)) return "memory-risk";
  if (/超时|时间上限|deadline|timeout/.test(normalized)) return "timeout";
  if (/worker|线程|崩溃|异常|无法启动/.test(normalized)) return "worker-error";
  if (/非法数值|无效源|源存档|invalid-source/.test(normalized)) return "invalid-source";
  if (/尾验|验证|边界|容量/.test(normalized)) return "boundary-validation";
  if (/校准|账本/.test(normalized)) return "calibration-unstable";
  if (/合同|不满足|不可用/.test(normalized)) return "contract-rejected";
  return "unknown";
}

export interface OfflineWorkerSettlementRequestShape {
  approximate: boolean;
  conservativeOnly: boolean;
  speedrun: boolean;
  seconds: number;
}

/**
 * Keeps the Worker fallback policy independent from the simulation formulas.
 * Ordinary fast settlement may degrade to conservative macro work, but it may
 * never turn a declined contract into an unbounded exact replay.
 */
export function selectInitialOfflineWorkerStrategy(
  request: OfflineWorkerSettlementRequestShape,
): OfflineWorkerSettlementStrategy {
  if (request.conservativeOnly && !request.speedrun) return "conservative-preview";
  if (request.approximate && !request.speedrun && request.seconds > FAST_OFFLINE_CALIBRATION_SECONDS) return "fast";
  return "exact";
}

export function selectOfflineWorkerStrategyAfterFastResult(
  request: OfflineWorkerSettlementRequestShape,
  result: OfflineApproximationResult,
): OfflineWorkerSettlementStrategy {
  if (result.status === "invalid-source") return "invalid-source";
  if (result.status === "approximate" || result.status === "conservative" || result.status === "bounded-exact") {
    return result.status === "conservative" ? "conservative-preview" : result.status === "bounded-exact" ? "exact" : "fast";
  }
  return request.speedrun ? "exact" : "conservative-preview";
}
