import {
  getEffectiveSimulationMultiplier,
  refreshDysonGenerationSnapshot,
  refreshTimeWarpPowerSnapshotInPlace,
} from "./engine";
import {
  advanceExactSimulationWindow,
  applyPureIdleAffineContract,
  createPureIdleAffineCalibration,
  type PureIdleAffineContract,
} from "./offlineApproximation";
import {
  advanceResearchMacroInPlace,
  captureResearchMacroStatus,
  type ResearchMacroLedger,
  type ResearchMacroStatus,
} from "./researchMacro";
import type { GameState, ItemId } from "./types";

export const PURE_IDLE_MACRO_ALGORITHM_VERSION = "pure-idle-macro-v3";
export const PURE_IDLE_MACRO_BUCKET_WALL_SECONDS = 30;
export const PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS = 10 * 60;
export const PURE_IDLE_MACRO_CALIBRATION_SECONDS = 30;
export const PURE_IDLE_MACRO_OPERATION_DEADLINE_MS = 30_000;

export type PureIdleMacroMode = "stable" | "extreme";
export type PureIdleMacroPhase =
  | "preparing-power"
  | "calibrating"
  | "running"
  | "conservative"
  | "research-boundary"
  | "validating"
  | "finalizing"
  | "recovering"
  | "failed";

export interface PureIdleTerminalSnapshot {
  dysonGenerationKw: number;
  whiteMatrixProduced: number;
  rocketsLaunched: number;
  sailsAbsorbed: number;
  structurePoints: number;
  shellSails: number;
  sailsInOrbit: number;
  activityDelivered: Record<string, number>;
}

export interface PureIdleRateSnapshot {
  dysonGenerationKw: number;
  whiteMatrixProduced: number;
  rocketsLaunched: number;
  sailsAbsorbed: number;
  structurePoints: number;
  shellSails: number;
  sailsInOrbit: number;
  activityDelivered: Record<string, number>;
}

export interface PureIdleLineStatus {
  id: string;
  label: string;
  itemId?: ItemId;
  calibrationRatePerMinute: number;
  sustainableRatePerMinute: number;
  efficiency: number | null;
  reason: string;
}

export interface PureIdleMacroSummary {
  phase: PureIdleMacroPhase;
  mode: PureIdleMacroMode;
  algorithmVersion: string;
  settledWallSeconds: number;
  settledSimulationSeconds: number;
  requestedMultiplier: number;
  powerLimitedMultiplier: number;
  actualMultiplier: number;
  calibrationWindowsCompleted: number;
  contractVersion: number;
  validationCount: number;
  validationFailures: number;
  lastValidationDurationMs: number;
  lastValidationDeviation: number;
  lastValidationReason?: string;
  nextValidationAtWallSeconds: number | null;
  boundaryCorrections: number;
  baseline: PureIdleTerminalSnapshot;
  current: PureIdleTerminalSnapshot;
  ratePerSimulationSecond: PureIdleRateSnapshot;
  terminalLines: PureIdleLineStatus[];
  minimumEfficiency: number | null;
  limitingReason: string;
  research: ResearchMacroStatus;
  baselineResearch: ResearchMacroStatus;
  degradedReason?: string;
  computationDurationMs: number;
  conservativeOnly: boolean;
}

export interface PureIdleMacroSession {
  mode: PureIdleMacroMode;
  phase: PureIdleMacroPhase;
  candidate: GameState;
  contract: PureIdleAffineContract;
  researchLedger: ResearchMacroLedger;
  researchRemainder: bigint;
  researchInflowRemainders: ResearchMacroApplicationRemainders;
  baseline: PureIdleTerminalSnapshot;
  baselineResearch: ResearchMacroStatus;
  calibrationRate: PureIdleRateSnapshot;
  /** Latest measured rate used for interpolation and efficiency display. */
  currentRate: PureIdleRateSnapshot;
  settledWallSeconds: number;
  settledSimulationSeconds: number;
  contractVersion: number;
  validationCount: number;
  validationFailures: number;
  lastValidationDurationMs: number;
  lastValidationDeviation: number;
  lastValidationReason?: string;
  nextValidationAtWallSeconds: number | null;
  boundaryCorrections: number;
  calibrationWindowsCompleted: number;
  actualMultiplier: number;
  degradedReason?: string;
  computationDurationMs: number;
  conservativeOnly: boolean;
  /**
   * Exact one-shot prefix produced by calibration. It is consumed when the
   * wall clock crosses the calibration boundary and then released.
   */
  calibrationCheckpoint?: {
    baseWallSeconds: number;
    baseSimulationSeconds: number;
    wallSeconds: number;
    simulationSeconds: number;
    candidate: GameState;
  };
}

export interface PureIdleMacroOperationOptions {
  deadlineAtMs?: number;
  shouldCancel?: () => boolean;
  forceConservativeReason?: string;
}

export class PureIdleMacroDeadlineError extends Error {
  constructor() {
    super("纯挂机计算达到现实时间上限");
    this.name = "PureIdleMacroDeadlineError";
  }
}

function macroNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function throwIfMacroInterrupted(options: PureIdleMacroOperationOptions): void {
  if (options.shouldCancel?.()) throw new DOMException("纯挂机计算已取消", "AbortError");
  if (options.deadlineAtMs !== undefined && macroNow() >= options.deadlineAtMs) {
    throw new PureIdleMacroDeadlineError();
  }
}

type ResearchMacroApplicationRemainders = Parameters<typeof advanceResearchMacroInPlace>[4];

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonNegative(value: unknown): number {
  return Math.max(0, finite(value));
}

export function capturePureIdleTerminalSnapshot(state: GameState): PureIdleTerminalSnapshot {
  const activityDelivered: Record<string, number> = {};
  for (const [itemId, amount] of Object.entries(state.endgame.constructionActivity.personalDelivered)) {
    activityDelivered[itemId] = Math.max(0, Math.floor(finite(amount)));
  }
  return {
    dysonGenerationKw: nonNegative(state.dysonSphere.generationKw) + nonNegative(state.dysonSwarm.generationKw),
    whiteMatrixProduced: Math.max(0, Math.floor(finite(state.totalProduced.universe_matrix))),
    rocketsLaunched: Math.max(0, Math.floor(finite(state.dysonSphere.totalRocketsLaunched))),
    sailsAbsorbed: Math.max(0, Math.floor(finite(state.dysonSphere.totalSailsAbsorbed))),
    structurePoints: Math.max(0, Math.floor(finite(state.dysonSphere.structurePoints))),
    shellSails: Math.max(0, Math.floor(finite(state.dysonSphere.shellSails))),
    sailsInOrbit: Math.max(0, Math.floor(finite(state.dysonSwarm.sailsInOrbit))),
    activityDelivered,
  };
}

function rateBetween(
  start: PureIdleTerminalSnapshot,
  end: PureIdleTerminalSnapshot,
  seconds: number,
): PureIdleRateSnapshot {
  const divisor = Math.max(1e-9, seconds);
  const activityDelivered: Record<string, number> = {};
  const activityIds = new Set([...Object.keys(start.activityDelivered), ...Object.keys(end.activityDelivered)]);
  for (const itemId of activityIds) {
    activityDelivered[itemId] = (finite(end.activityDelivered[itemId]) - finite(start.activityDelivered[itemId])) / divisor;
  }
  return {
    dysonGenerationKw: (end.dysonGenerationKw - start.dysonGenerationKw) / divisor,
    whiteMatrixProduced: (end.whiteMatrixProduced - start.whiteMatrixProduced) / divisor,
    rocketsLaunched: (end.rocketsLaunched - start.rocketsLaunched) / divisor,
    sailsAbsorbed: (end.sailsAbsorbed - start.sailsAbsorbed) / divisor,
    structurePoints: (end.structurePoints - start.structurePoints) / divisor,
    shellSails: (end.shellSails - start.shellSails) / divisor,
    sailsInOrbit: (end.sailsInOrbit - start.sailsInOrbit) / divisor,
    activityDelivered,
  };
}

function cloneRate(rate: PureIdleRateSnapshot): PureIdleRateSnapshot {
  return { ...rate, activityDelivered: { ...rate.activityDelivered } };
}

function relativeDifference(left: number, right: number): number {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) / scale;
}

function maximumRateDeviation(left: PureIdleRateSnapshot, right: PureIdleRateSnapshot): number {
  let maximum = Math.max(
    relativeDifference(left.dysonGenerationKw, right.dysonGenerationKw),
    relativeDifference(left.whiteMatrixProduced, right.whiteMatrixProduced),
    relativeDifference(left.rocketsLaunched, right.rocketsLaunched),
    relativeDifference(left.sailsAbsorbed, right.sailsAbsorbed),
    relativeDifference(left.structurePoints, right.structurePoints),
    relativeDifference(left.shellSails, right.shellSails),
    relativeDifference(left.sailsInOrbit, right.sailsInOrbit),
  );
  const ids = new Set([...Object.keys(left.activityDelivered), ...Object.keys(right.activityDelivered)]);
  for (const id of ids) maximum = Math.max(maximum, relativeDifference(finite(left.activityDelivered[id]), finite(right.activityDelivered[id])));
  return maximum;
}

function line(
  id: string,
  label: string,
  rate: number,
  currentRate: number,
  boundaryCorrections: number,
  itemId?: ItemId,
): PureIdleLineStatus {
  const calibrationRatePerMinute = Math.max(0, rate * 60);
  const sustainableRatePerMinute = Math.max(0, currentRate * 60);
  const efficiency = calibrationRatePerMinute <= 1e-9
    ? null
    : Math.max(0, Math.min(1, sustainableRatePerMinute / calibrationRatePerMinute));
  return {
    id,
    label,
    ...(itemId ? { itemId } : {}),
    calibrationRatePerMinute,
    sustainableRatePerMinute,
    efficiency,
    reason: efficiency === null
      ? "启动校准期间未运行"
      : boundaryCorrections > 0
        ? "库存或容量边界已执行安全修正"
        : efficiency >= 0.9
          ? "供给稳定"
          : "影子校准检测到产线速率下降",
  };
}

function terminalLines(session: PureIdleMacroSession): PureIdleLineStatus[] {
  const currentRate = session.currentRate;
  return [
    line("white-matrix", "白矩阵", session.calibrationRate.whiteMatrixProduced, currentRate.whiteMatrixProduced, session.boundaryCorrections, "universe_matrix"),
    line("dyson-rockets", "小型运载火箭", session.calibrationRate.rocketsLaunched, currentRate.rocketsLaunched, session.boundaryCorrections, "small_carrier_rocket"),
    line("solar-sails", "太阳帆吸收", session.calibrationRate.sailsAbsorbed, currentRate.sailsAbsorbed, session.boundaryCorrections, "solar_sail"),
    line("dyson-structure", "戴森结构点", session.calibrationRate.structurePoints, currentRate.structurePoints, session.boundaryCorrections),
  ];
}

export function summarizePureIdleMacroSession(session: PureIdleMacroSession): PureIdleMacroSummary {
  const lines = terminalLines(session);
  const running = lines.filter((entry): entry is PureIdleLineStatus & { efficiency: number } => entry.efficiency !== null);
  const minimum = running.length > 0 ? Math.min(...running.map((entry) => entry.efficiency)) : null;
  const limiting = minimum === null
    ? "终局产线尚未在校准窗口运行"
    : lines.find((entry) => entry.efficiency === minimum)?.reason ?? "供给稳定";
  return {
    phase: session.phase,
    mode: session.mode,
    algorithmVersion: PURE_IDLE_MACRO_ALGORITHM_VERSION,
    settledWallSeconds: session.settledWallSeconds,
    settledSimulationSeconds: session.settledSimulationSeconds,
    requestedMultiplier: session.candidate.timeWarp.requestedMultiplier,
    powerLimitedMultiplier: session.actualMultiplier,
    actualMultiplier: session.actualMultiplier,
    calibrationWindowsCompleted: session.calibrationWindowsCompleted,
    contractVersion: session.contractVersion,
    validationCount: session.validationCount,
    validationFailures: session.validationFailures,
    lastValidationDurationMs: session.lastValidationDurationMs,
    lastValidationDeviation: session.lastValidationDeviation,
    ...(session.lastValidationReason ? { lastValidationReason: session.lastValidationReason } : {}),
    nextValidationAtWallSeconds: session.nextValidationAtWallSeconds,
    boundaryCorrections: session.boundaryCorrections,
    baseline: session.baseline,
    current: capturePureIdleTerminalSnapshot(session.candidate),
    ratePerSimulationSecond: session.currentRate,
    terminalLines: lines,
    minimumEfficiency: minimum,
    limitingReason: limiting,
    research: captureResearchMacroStatus(session.candidate),
    baselineResearch: session.baselineResearch,
    ...(session.degradedReason ? { degradedReason: session.degradedReason } : {}),
    computationDurationMs: session.computationDurationMs,
    conservativeOnly: session.conservativeOnly,
  };
}

function calibrate(state: GameState): {
  contract: PureIdleAffineContract;
  researchLedger: ResearchMacroLedger;
  rate: PureIdleRateSnapshot;
  calibratedState: GameState;
  calibrationWallSeconds: number;
} {
  const multiplier = Math.max(1, getEffectiveSimulationMultiplier(state));
  const result = createPureIdleAffineCalibration(state, PURE_IDLE_MACRO_CALIBRATION_SECONDS / multiplier);
  if (!result) throw new Error("30 秒校准没有形成可用的守恒合同");
  refreshDysonGenerationSnapshot(result.calibratedState);
  return {
    contract: result.contract,
    researchLedger: result.researchLedger,
    rate: rateBetween(
      capturePureIdleTerminalSnapshot(state),
      capturePureIdleTerminalSnapshot(result.calibratedState),
      PURE_IDLE_MACRO_CALIBRATION_SECONDS,
    ),
    calibratedState: result.calibratedState,
    calibrationWallSeconds: result.calibrationWallSeconds,
  };
}

/** Consumes an isolated Worker-owned state. The main-thread source is never mutated. */
export function createConservativePureIdleMacroSession(
  state: GameState,
  mode: PureIdleMacroMode,
  reason: string,
): PureIdleMacroSession {
  if (!state.timeWarp.enabled || state.paused) throw new Error("纯挂机保守会话要求已启用且未暂停的时间扭曲状态");
  if (state.speedrun?.enabled) throw new Error("速通工厂必须继续使用独立的精确时间规则");
  refreshTimeWarpPowerSnapshotInPlace(state);
  const baseline = capturePureIdleTerminalSnapshot(state);
  const baselineResearch = captureResearchMacroStatus(state);
  const actualMultiplier = Math.max(1, getEffectiveSimulationMultiplier(state));
  const emptyRate: PureIdleRateSnapshot = {
    dysonGenerationKw: 0,
    whiteMatrixProduced: 0,
    rocketsLaunched: 0,
    sailsAbsorbed: 0,
    structurePoints: 0,
    shellSails: 0,
    sailsInOrbit: 0,
    activityDelivered: {},
  };
  return {
    mode,
    phase: "conservative",
    candidate: state,
    contract: {
      deltas: [],
      calibrationSeconds: PURE_IDLE_MACRO_CALIBRATION_SECONDS,
      calibrationWallSeconds: PURE_IDLE_MACRO_CALIBRATION_SECONDS / actualMultiplier,
    },
    researchLedger: { unitsPerWindow: 0n, windowSeconds: PURE_IDLE_MACRO_CALIBRATION_SECONDS, observedUnits: 0n, inflowPerWindow: {} },
    researchRemainder: 0n,
    researchInflowRemainders: {},
    baseline,
    baselineResearch,
    calibrationRate: cloneRate(emptyRate),
    currentRate: cloneRate(emptyRate),
    settledWallSeconds: 0,
    settledSimulationSeconds: 0,
    contractVersion: 0,
    validationCount: 0,
    validationFailures: 1,
    lastValidationDurationMs: 0,
    lastValidationDeviation: 1,
    lastValidationReason: `已切换零校准保守宏观：${reason}`,
    nextValidationAtWallSeconds: null,
    boundaryCorrections: 0,
    calibrationWindowsCompleted: 0,
    actualMultiplier,
    degradedReason: reason,
    computationDurationMs: 0,
    conservativeOnly: true,
  };
}

export function createPureIdleMacroSession(
  state: GameState,
  mode: PureIdleMacroMode,
  options: PureIdleMacroOperationOptions = {},
): PureIdleMacroSession {
  if (!state.timeWarp.enabled || state.paused) throw new Error("纯挂机校准要求已启用且未暂停的时间扭曲状态");
  if (state.speedrun?.enabled) throw new Error("速通工厂必须继续使用独立的精确时间规则");
  if (state.timeWarp.pendingSimulationSeconds > 1e-6 || state.timeWarp.pendingWallSeconds > 1e-6) {
    throw new Error("纯挂机检查点仍包含未提交模拟预算");
  }
  throwIfMacroInterrupted(options);
  if (options.forceConservativeReason) {
    return createConservativePureIdleMacroSession(state, mode, options.forceConservativeReason);
  }
  refreshTimeWarpPowerSnapshotInPlace(state);
  const baseline = capturePureIdleTerminalSnapshot(state);
  const baselineResearch = captureResearchMacroStatus(state);
  const calibrated = calibrate(state);
  throwIfMacroInterrupted(options);
  return {
    mode,
    phase: "running",
    candidate: state,
    contract: calibrated.contract,
    researchLedger: calibrated.researchLedger,
    researchRemainder: 0n,
    researchInflowRemainders: {},
    baseline,
    baselineResearch,
    calibrationRate: cloneRate(calibrated.rate),
    currentRate: cloneRate(calibrated.rate),
    settledWallSeconds: 0,
    settledSimulationSeconds: 0,
    contractVersion: 1,
    validationCount: 0,
    validationFailures: 0,
    lastValidationDurationMs: 0,
    lastValidationDeviation: 0,
    nextValidationAtWallSeconds: mode === "stable" ? PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS : null,
    boundaryCorrections: 0,
    calibrationWindowsCompleted: 3,
    actualMultiplier: Math.max(1, getEffectiveSimulationMultiplier(state)),
    computationDurationMs: 0,
    conservativeOnly: false,
    calibrationCheckpoint: {
      baseWallSeconds: 0,
      baseSimulationSeconds: 0,
      wallSeconds: calibrated.calibrationWallSeconds,
      simulationSeconds: PURE_IDLE_MACRO_CALIBRATION_SECONDS,
      candidate: calibrated.calibratedState,
    },
  };
}

function runShadowValidation(session: PureIdleMacroSession, options: PureIdleMacroOperationOptions): void {
  const startedAt = performance.now();
  session.phase = "validating";
  try {
    throwIfMacroInterrupted(options);
    refreshTimeWarpPowerSnapshotInPlace(session.candidate);
    session.actualMultiplier = Math.max(1, getEffectiveSimulationMultiplier(session.candidate));
    const next = calibrate(session.candidate);
    throwIfMacroInterrupted(options);
    const deviation = maximumRateDeviation(session.currentRate, next.rate);
    session.currentRate = next.rate;
    session.researchLedger = next.researchLedger;
    session.researchRemainder = 0n;
    session.researchInflowRemainders = {};
    session.lastValidationDeviation = deviation;
    session.validationCount += 1;
    session.calibrationCheckpoint = {
      baseWallSeconds: session.settledWallSeconds,
      baseSimulationSeconds: session.settledSimulationSeconds,
      wallSeconds: next.calibrationWallSeconds,
      simulationSeconds: PURE_IDLE_MACRO_CALIBRATION_SECONDS,
      candidate: next.calibratedState,
    };
    if (deviation >= 0.15) {
      session.contract = next.contract;
      session.contractVersion += 1;
      session.lastValidationReason = deviation >= 0.3
        ? "产线变化超过 30%，未来宏观合同已替换"
        : "产线变化超过 15%，未来宏观合同已校正";
    } else {
      session.lastValidationReason = "产线偏差低于 15%，继续使用当前合同";
    }
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "PureIdleMacroDeadlineError")) {
      throw error;
    }
    session.validationFailures += 1;
    session.lastValidationReason = error instanceof Error ? error.message : "影子校验失败，继续使用上一份合同";
  } finally {
    session.lastValidationDurationMs = Math.max(0, performance.now() - startedAt);
    session.computationDurationMs = session.lastValidationDurationMs;
    session.phase = session.degradedReason ? "conservative" : "running";
  }
}

export function advancePureIdleMacroSession(
  session: PureIdleMacroSession,
  targetWallSeconds: number,
  options: PureIdleMacroOperationOptions = {},
): PureIdleMacroSummary {
  throwIfMacroInterrupted(options);
  if (!Number.isFinite(targetWallSeconds) || targetWallSeconds < session.settledWallSeconds) {
    throw new Error("纯挂机目标墙钟时间无效或发生倒退");
  }
  if (session.settledWallSeconds + 1e-9 < targetWallSeconds) {
    const operationStartedAt = macroNow();
    // Live orchestration calls this at each 30-second boundary. A tab that
    // slept or reloaded can arrive with days of debt; applying one equivalent
    // affine window keeps recovery cost independent of wall-clock duration.
    let exactSimulationSeconds = 0;
    let macroWallSeconds = targetWallSeconds - session.settledWallSeconds;
    const checkpoint = session.calibrationCheckpoint;
    if (checkpoint && checkpoint.baseWallSeconds <= session.settledWallSeconds + 1e-9) {
      const checkpointEndWallSeconds = checkpoint.baseWallSeconds + checkpoint.wallSeconds;
      const checkpointEndSimulationSeconds = checkpoint.baseSimulationSeconds + checkpoint.simulationSeconds;
      if (session.settledWallSeconds < checkpointEndWallSeconds - 1e-9) {
        if (targetWallSeconds < checkpointEndWallSeconds - 1e-9) {
          const exactWallSeconds = targetWallSeconds - session.settledWallSeconds;
          exactSimulationSeconds = exactWallSeconds * checkpoint.simulationSeconds / checkpoint.wallSeconds;
          session.candidate = advanceExactSimulationWindow(
            session.candidate,
            exactSimulationSeconds,
            exactWallSeconds,
          );
          macroWallSeconds = 0;
        } else {
          exactSimulationSeconds = Math.max(
            0,
            checkpointEndSimulationSeconds - session.settledSimulationSeconds,
          );
          session.candidate = checkpoint.candidate;
          macroWallSeconds = Math.max(0, targetWallSeconds - checkpointEndWallSeconds);
          session.calibrationCheckpoint = undefined;
        }
      } else {
        session.calibrationCheckpoint = undefined;
      }
    }
    throwIfMacroInterrupted(options);
    refreshTimeWarpPowerSnapshotInPlace(session.candidate);
    const multiplier = Math.max(1, getEffectiveSimulationMultiplier(session.candidate));
    session.actualMultiplier = multiplier;
    const macroSimulationSeconds = macroWallSeconds * multiplier;
    const applied = macroWallSeconds <= 1e-9
      ? { ok: true as const, boundaryCorrections: 0 }
      : session.conservativeOnly
        ? { ok: false as const, boundaryCorrections: 0, failure: session.degradedReason ?? "零校准保守宏观" }
        : applyPureIdleAffineContract(session.candidate, session.contract, macroSimulationSeconds, macroWallSeconds);
    throwIfMacroInterrupted(options);
    if (!applied.ok) {
      // The last complete candidate remains intact because affine application
      // is transactional. Freeze uncertain factory subsystems, advance time
      // and the exact research ledger, and keep the session recoverable.
      session.phase = "conservative";
      session.degradedReason = applied.failure ?? "宏观守恒桶未通过安全校验";
      session.lastValidationReason = `已切换保守宏观：${session.degradedReason}`;
      if (!session.conservativeOnly) session.validationFailures += 1;
      session.candidate.elapsedSeconds += macroSimulationSeconds;
    } else {
      session.phase = "running";
      session.degradedReason = undefined;
      session.boundaryCorrections += applied.boundaryCorrections;
    }
    const macroResearchSeconds = Math.max(0, macroSimulationSeconds - (applied.exactSimulationSeconds ?? 0));
    const research = macroResearchSeconds > 1e-9
      ? advanceResearchMacroInPlace(
        session.candidate,
        session.researchLedger,
        macroResearchSeconds,
        session.researchRemainder,
        session.researchInflowRemainders,
      )
      : { remainder: session.researchRemainder, inflowRemainders: session.researchInflowRemainders,
        completedFiniteTechIds: [], completedInfiniteLevels: [] };
    session.researchRemainder = research.remainder;
    session.researchInflowRemainders = research.inflowRemainders;
    throwIfMacroInterrupted(options);
    if (research.completedFiniteTechIds.length > 0 || research.completedInfiniteLevels.length > 0) {
      session.lastValidationReason = `科研边界完成：有限科技 ${research.completedFiniteTechIds.length} 项，无限科技 ${research.completedInfiniteLevels.length} 级`;
    }
    session.settledWallSeconds = targetWallSeconds;
    session.settledSimulationSeconds += exactSimulationSeconds + macroSimulationSeconds;
    if (applied.exactSimulationSeconds && !session.conservativeOnly) {
      // A finite-resource or transport boundary changed the sustainable tail.
      // Recalibrate once from the exact committed state so future calls do not
      // repeatedly replay an already-crossed boundary.
      try {
        const recalibrated = calibrate(session.candidate);
        session.contract = recalibrated.contract;
        session.researchLedger = recalibrated.researchLedger;
        session.researchRemainder = 0n;
        session.researchInflowRemainders = {};
        session.currentRate = recalibrated.rate;
        session.contractVersion += 1;
        session.calibrationWindowsCompleted += 3;
        session.calibrationCheckpoint = {
          baseWallSeconds: session.settledWallSeconds,
          baseSimulationSeconds: session.settledSimulationSeconds,
          wallSeconds: recalibrated.calibrationWallSeconds,
          simulationSeconds: PURE_IDLE_MACRO_CALIBRATION_SECONDS,
          candidate: recalibrated.calibratedState,
        };
        session.lastValidationReason = "有限资源或物流边界已由普通模拟跨越，后续宏观合同已重建";
      } catch (error) {
        session.lastValidationReason = error instanceof Error
          ? `边界后重校准失败：${error.message}`
          : "边界后重校准失败，下一结算段将继续使用精确保护";
      }
    }
    refreshDysonGenerationSnapshot(session.candidate);
    refreshTimeWarpPowerSnapshotInPlace(session.candidate);
    session.actualMultiplier = Math.max(1, getEffectiveSimulationMultiplier(session.candidate));
    session.computationDurationMs = Math.max(0,
      macroNow() - operationStartedAt);
    if (!session.conservativeOnly && session.mode === "stable" && session.nextValidationAtWallSeconds !== null &&
      session.settledWallSeconds + 1e-9 >= session.nextValidationAtWallSeconds) {
      const crossedValidations = Math.floor(
        (session.settledWallSeconds - session.nextValidationAtWallSeconds) /
        PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS,
      ) + 1;
      runShadowValidation(session, options);
      if (crossedValidations > 1) {
        session.lastValidationReason = `${session.lastValidationReason ?? "影子校验已完成"}；休眠期间 ${crossedValidations - 1} 次历史校验已合并`;
      }
      session.nextValidationAtWallSeconds += crossedValidations * PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS;
    }
  }
  return summarizePureIdleMacroSession(session);
}

/** Worker path: finish deterministic settlement before transferable serialization. */
export function finalizePureIdleMacroCandidate(
  session: PureIdleMacroSession,
  targetWallSeconds: number,
  options: PureIdleMacroOperationOptions = {},
): { state: GameState; summary: PureIdleMacroSummary } {
  throwIfMacroInterrupted(options);
  advancePureIdleMacroSession(session, targetWallSeconds, options);
  session.phase = "finalizing";
  session.candidate.timeWarp = {
    ...session.candidate.timeWarp,
    enabled: false,
    pendingSimulationSeconds: 0,
    pendingWallSeconds: 0,
    effectiveMultiplier: session.candidate.settings.simulationSpeed,
    requiredPowerKw: 0,
    allocatedPowerKw: 0,
  };
  throwIfMacroInterrupted(options);
  const summary = summarizePureIdleMacroSession(session);
  return { state: session.candidate, summary };
}
