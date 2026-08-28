import {
  getEffectiveSimulationMultiplier,
  refreshDysonGenerationSnapshot,
  refreshTimeWarpPowerSnapshotInPlace,
  setPaused,
  settleCompletedResearchBoundaries,
} from "./engine";
import { MATRIX_ITEM_IDS } from "./content";
import { finishIdleRun, settleIdleRun } from "./idleSettlement";
import {
  advanceConstructionAutomationMacroWithReceiptInPlace,
  advanceExactSimulationWindow,
  advanceExactSimulationWindowWithConstructionReceipt,
  advancePureIdleRocketMacroLedgerInPlace,
  applyPureIdlePowerTailFuelDebitInPlace,
  applyPureIdleAffineContract,
  applyPureIdleLightweightContractInPlace,
  capturePureIdleCombinedConservationCheckpoint,
  creditPureIdleConstructionQuantumReplay,
  createPureIdleAffineCalibration,
  createPureIdleLightweightCalibration,
  validatePureIdleCombinedSettlementConservation,
  type PureIdleAffineContract,
  type PureIdleCombinedConservationCheckpoint,
  type PureIdleConstructionPowerCertificate,
  type PureIdlePowerTailCertificate,
  type PureIdleRocketMacroLedger,
} from "./offlineApproximation";
import {
  advanceResearchMacroInPlace,
  captureResearchMacroStatus,
  type ResearchMacroLedger,
  type ResearchMacroStatus,
} from "./researchMacro";
import {
  advancePureIdleReplicationInPlace,
  getPureIdleReplicationReadiness,
  pureIdleReplicationRatePerSecond,
  PURE_IDLE_REPLICATION_ALGORITHM_VERSION,
  type PureIdleReplicationContract,
} from "./pureIdleReplication";
import { isPureIdleReplicationUnlocked } from "./endgame";
import type { GameState, IdleSettlementState, ItemId } from "./types";

export const PURE_IDLE_MACRO_ALGORITHM_VERSION = "pure-idle-macro-v10-final-conservation-gate";
export const PURE_IDLE_MACRO_BUCKET_WALL_SECONDS = 30;
export const PURE_IDLE_MACRO_VALIDATION_WALL_SECONDS = 10 * 60;
export const PURE_IDLE_MACRO_CALIBRATION_SECONDS = 30;
/**
 * Complex saves use the same 30 simulated seconds as the historical macro
 * path, but retain only a lightweight material sample instead of four generic
 * full-state affine snapshots.
 */
export const PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS = 30;
// The default must cover the three-window lightweight calibration. Device
// classification can raise it further for constrained/low-memory hardware.
export const PURE_IDLE_MACRO_OPERATION_DEADLINE_MS = 90_000;
export const PURE_IDLE_MACRO_LIGHTWEIGHT_ENTITY_THRESHOLD = 3_000;
export const PURE_IDLE_MACRO_LIGHTWEIGHT_BELT_THRESHOLD = 6_000;
const PURE_IDLE_POWER_BOUNDARY_RECALIBRATION_LIMIT = 4;

export type PureIdleMacroMode = "stable" | "extreme" | "replication";
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
  rocketLedger?: PureIdleRocketMacroLedger;
  /** Per-system fractional launch carries keep bucket segmentation deterministic. */
  rocketLaunchRemaindersBySystem: Record<string, number>;
  /** Compact source checkpoint for the final combined material gate. */
  conservationCheckpoint?: PureIdleCombinedConservationCheckpoint;
  /** Player-authorized positive-output snapshot; present only in replication mode. */
  replicationContract?: PureIdleReplicationContract;
  /** Integer fractional carries make segmented replication deterministic. */
  replicationRemainders: Record<string, bigint>;
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
  /** Fractional carry for repeated affine integer counter buckets. */
  conservativeIntegerRemainders: Record<string, number>;
  /** Exact carry for repeated affine decimal inventory buckets. */
  conservativeDecimalRemainders: Record<string, bigint>;
  /** Remaining productive tail before the sampled input/output boundary. */
  conservativeRemainingSimulationSeconds: number | null;
  /** Exact-proven finite fuel bank or closed replenishment proof for all macro domains. */
  powerTail: PureIdlePowerTailCertificate;
  /** Renewable headroom authority bound to the current ordinary contract. */
  constructionPowerCertificate?: PureIdleConstructionPowerCertificate;
  /** Remaining finite power horizon; null means closed/renewable supply. */
  powerRemainingSimulationSeconds: number | null;
  /** Bounded exact re-probes after a local exhaustible power source leaves dispatch. */
  powerBoundaryRecalibrations: number;
  /** Per-item productive horizons for the lightweight sampled contract. */
  conservativeRemainingSimulationSecondsByItem: Record<string, number>;
  /**
   * Construction is intentionally isolated from the ordinary calibration
   * contract. This counter preserves its requested duration for boundary
   * accounting, but the current P0 policy freezes every unmetered domain-only
   * construction tail; receipt-aware exact windows still advance normally.
   */
  pendingConstructionSimulationSeconds: number;
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
  /** Worker-only: the supplied state is already an isolated structured clone. */
  consumeCalibrationState?: boolean;
}

/**
 * Small recovery-record fields required to turn a macro candidate into the
 * exact state that should be persisted when a normal stop completes. These
 * fields travel to the Worker; the UI must not apply them after the envelope
 * has already been serialized.
 */
export interface PureIdleMacroFinalStateOptions {
  startedPaused: boolean;
  baselineIdleSettlement: IdleSettlementState;
  baselineTotalProduced: Partial<Record<ItemId, number>>;
}

export function applyPureIdleMacroFinalState(
  candidate: GameState,
  targetWallSeconds: number,
  options: PureIdleMacroFinalStateOptions,
): GameState {
  const idleSettlement = finishIdleRun(settleIdleRun(
    options.baselineIdleSettlement,
    targetWallSeconds,
    options.baselineTotalProduced,
    candidate.totalProduced,
  ));
  const researchSettled = settleCompletedResearchBoundaries(candidate);
  return setPaused({ ...researchSettled, idleSettlement }, options.startedPaused);
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
  supported = true,
  unsupportedReason = "该终局事件尚未纳入可证明宏观账本",
): PureIdleLineStatus {
  const calibrationRatePerMinute = Math.max(0, rate * 60);
  const sustainableRatePerMinute = Math.max(0, currentRate * 60);
  const efficiency = !supported || calibrationRatePerMinute <= 1e-9
    ? null
    : Math.max(0, Math.min(1, sustainableRatePerMinute / calibrationRatePerMinute));
  return {
    id,
    label,
    ...(itemId ? { itemId } : {}),
    calibrationRatePerMinute,
    sustainableRatePerMinute,
    efficiency,
    reason: !supported
      ? unsupportedReason
      : efficiency === null
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
  if (session.mode === "replication") {
    return [
      line("white-matrix", "白矩阵", currentRate.whiteMatrixProduced, currentRate.whiteMatrixProduced,
        0, "universe_matrix", currentRate.whiteMatrixProduced > 1e-9,
        "统计窗口没有白矩阵正向产出"),
      line("dyson-rockets", "小型运载火箭", currentRate.rocketsLaunched, currentRate.rocketsLaunched,
        0, "small_carrier_rocket", currentRate.rocketsLaunched > 1e-9,
        "统计窗口没有火箭发射"),
      line("solar-sails", "太阳帆吸收", currentRate.sailsAbsorbed, currentRate.sailsAbsorbed,
        0, "solar_sail", currentRate.sailsAbsorbed > 1e-9,
        "统计窗口没有太阳帆吸收"),
      line("dyson-structure", "戴森结构点", currentRate.structurePoints, currentRate.structurePoints,
        0, undefined, currentRate.structurePoints > 1e-9,
        "统计窗口没有戴森结构增长"),
    ].map((entry) => ({
      ...entry,
      reason: entry.efficiency === null ? entry.reason : "按已锁定统计产率直接复制",
    }));
  }
  const extrapolatesWhiteMatrix = session.contract.deltas.some((delta) =>
    delta.path[0] === "totalProduced" && delta.path[1] === "universe_matrix") ||
    currentRate.whiteMatrixProduced > 1e-9;
  return [
    line("white-matrix", "白矩阵", session.calibrationRate.whiteMatrixProduced, currentRate.whiteMatrixProduced,
      session.boundaryCorrections, "universe_matrix", extrapolatesWhiteMatrix,
      "白矩阵没有形成可持续供需证书"),
    line("dyson-rockets", "小型运载火箭", session.calibrationRate.rocketsLaunched, currentRate.rocketsLaunched,
      session.boundaryCorrections, "small_carrier_rocket", Boolean(session.rocketLedger),
      "火箭制造与多星系发射没有形成闭合事件账本"),
    line("solar-sails", "太阳帆吸收", session.calibrationRate.sailsAbsorbed, currentRate.sailsAbsorbed,
      session.boundaryCorrections, "solar_sail", false, "太阳帆吸收暂未纳入可证明宏观账本，不计入最低效率"),
    line("dyson-structure", "戴森结构点", session.calibrationRate.structurePoints, currentRate.structurePoints,
      session.boundaryCorrections, undefined, Boolean(session.rocketLedger),
      "戴森结构没有形成闭合火箭事件账本"),
  ];
}

function pureIdleContractProductionRate(contract: PureIdleAffineContract, itemId: ItemId): number {
  const delta = contract.deltas.find((entry) =>
    entry.path[0] === "totalProduced" && entry.path[1] === itemId && entry.kind === "number");
  return delta && contract.calibrationSeconds > 0
    ? Math.max(0, Number(delta.delta) / contract.calibrationSeconds)
    : 0;
}

export function summarizePureIdleMacroSession(session: PureIdleMacroSession): PureIdleMacroSummary {
  const lines = terminalLines(session);
  const running = lines.filter((entry): entry is PureIdleLineStatus & { efficiency: number } => entry.efficiency !== null);
  const minimum = running.length > 0 ? Math.min(...running.map((entry) => entry.efficiency)) : null;
  const limiting = session.mode === "replication"
    ? `按最近 ${Math.floor(session.replicationContract?.windowSeconds ?? 0)} 个模拟秒复制白矩阵、火箭、太阳帆与科研等终局成果；不消耗原料，也不复制普通库存`
    : minimum === null
    ? "终局产线尚未在校准窗口运行"
    : lines.find((entry) => entry.efficiency === minimum)?.reason ?? "供给稳定";
  return {
    phase: session.phase,
    mode: session.mode,
    algorithmVersion: session.mode === "replication"
      ? PURE_IDLE_REPLICATION_ALGORITHM_VERSION
      : PURE_IDLE_MACRO_ALGORITHM_VERSION,
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
  rocketLedger?: PureIdleRocketMacroLedger;
  powerTailCertified: boolean;
  powerTailRejectionReason?: string;
  powerTail: PureIdlePowerTailCertificate;
  constructionPowerCertificate: PureIdleConstructionPowerCertificate;
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
    powerTailCertified: result.powerTailCertified,
    powerTail: result.powerTail,
    constructionPowerCertificate: result.constructionPowerCertificate,
    ...(result.powerTailRejectionReason
      ? { powerTailRejectionReason: result.powerTailRejectionReason }
      : {}),
    ...(result.rocketLedger ? { rocketLedger: result.rocketLedger } : {}),
  };
}

function recalibrateAfterPowerBoundary(
  session: PureIdleMacroSession,
  targetWallSeconds: number,
): "productive" | "frozen" | null {
  if (session.powerBoundaryRecalibrations >= PURE_IDLE_POWER_BOUNDARY_RECALIBRATION_LIMIT) return null;
  // The supply/request rules are evaluated at session start and the resulting
  // actual multiplier is locked with the production snapshot. Re-evaluating it
  // after copied Dyson growth would make identical wall time depend on how the
  // caller happened to split advance requests.
  const multiplier = session.actualMultiplier;
  const calibrationWallSeconds = PURE_IDLE_MACRO_CALIBRATION_SECONDS / multiplier;
  if (session.settledWallSeconds + calibrationWallSeconds > targetWallSeconds + 1e-9) return null;
  const terminalBefore = capturePureIdleTerminalSnapshot(session.candidate);

  if (session.conservativeOnly) {
    const recalibrated = createPureIdleLightweightCalibration(
      session.candidate,
      calibrationWallSeconds,
      { isolateConstructionAutomation: true, consumeState: true },
    );
    if (!recalibrated) throw new Error("供电边界后的 30 秒轻量校准没有形成可用样本");
    session.candidate = recalibrated.calibratedState;
    session.contract = recalibrated.contract;
    session.constructionPowerCertificate = recalibrated.constructionPowerCertificate;
    session.researchLedger = recalibrated.researchLedger;
    if (recalibrated.rocketLedger) session.rocketLedger = recalibrated.rocketLedger;
    else delete session.rocketLedger;
    session.powerTail = recalibrated.powerTail;
    session.powerRemainingSimulationSeconds = recalibrated.powerTailCertified
      ? recalibrated.powerTail.maximumSimulationSeconds
      : 0;
    const productiveTail = recalibrated.powerTailCertified &&
      recalibrated.contract.deltas.length > 0 && recalibrated.contract.maximumSimulationSeconds !== 0;
    session.conservativeRemainingSimulationSeconds = productiveTail
      ? recalibrated.contract.maximumSimulationSeconds ?? null
      : 0;
    session.conservativeRemainingSimulationSecondsByItem = productiveTail
      ? { ...(recalibrated.contract.maximumSimulationSecondsByItem ?? {}) }
      : {};
  } else {
    const recalibrated = calibrate(session.candidate);
    session.candidate = recalibrated.calibratedState;
    session.contract = recalibrated.contract;
    session.constructionPowerCertificate = recalibrated.constructionPowerCertificate;
    session.researchLedger = recalibrated.researchLedger;
    if (recalibrated.rocketLedger) session.rocketLedger = recalibrated.rocketLedger;
    else delete session.rocketLedger;
    session.powerTail = recalibrated.powerTail;
    session.powerRemainingSimulationSeconds = recalibrated.powerTailCertified
      ? recalibrated.powerTail.maximumSimulationSeconds
      : 0;
  }

  session.researchRemainder = 0n;
  session.researchInflowRemainders = {};
  session.rocketLaunchRemaindersBySystem = {};
  session.conservativeIntegerRemainders = {};
  session.conservativeDecimalRemainders = {};
  session.currentRate = rateBetween(
    terminalBefore,
    capturePureIdleTerminalSnapshot(session.candidate),
    PURE_IDLE_MACRO_CALIBRATION_SECONDS,
  );
  session.settledWallSeconds += calibrationWallSeconds;
  session.settledSimulationSeconds += PURE_IDLE_MACRO_CALIBRATION_SECONDS;
  if (session.powerRemainingSimulationSeconds !== 0) {
    // Both recalibration variants consumed a real thirty-second candidate with
    // construction isolated. Carry that exact interval into the next
    // receipt-aware construction bucket instead of silently losing it.
    session.pendingConstructionSimulationSeconds += PURE_IDLE_MACRO_CALIBRATION_SECONDS;
    creditPureIdleConstructionQuantumReplay(
      session.conservationCheckpoint!,
      PURE_IDLE_MACRO_CALIBRATION_SECONDS,
    );
  }
  session.contractVersion += 1;
  session.calibrationWindowsCompleted += 3;
  session.powerBoundaryRecalibrations += 1;
  session.calibrationCheckpoint = undefined;
  refreshDysonGenerationSnapshot(session.candidate);
  refreshTimeWarpPowerSnapshotInPlace(session.candidate);
  session.actualMultiplier = Math.max(1, getEffectiveSimulationMultiplier(session.candidate));
  const conservationFailure = validatePureIdleCombinedSettlementConservation(
    session.conservationCheckpoint!,
    session.candidate,
  );
  if (conservationFailure) throw new Error(`供电边界重校准最终物资守恒失败：${conservationFailure}`);
  const productive = session.powerRemainingSimulationSeconds !== 0 &&
    (session.contract.deltas.length > 0 || Boolean(session.rocketLedger));
  session.lastValidationReason = productive
    ? `局部燃料或储能在第 ${session.powerBoundaryRecalibrations} 个边界耗尽；已用新的 30 秒精确样本重建剩余电网合同`
    : "局部燃料或储能耗尽后的精确样本没有形成可持续尾段；剩余时间只推进时钟";
  return productive ? "productive" : "frozen";
}

/** Consumes an isolated Worker-owned state. The main-thread source is never mutated. */
export function createConservativePureIdleMacroSession(
  state: GameState,
  mode: PureIdleMacroMode,
  reason: string,
  options: Pick<PureIdleMacroOperationOptions, "consumeCalibrationState"> = {},
): PureIdleMacroSession {
  if (!state.timeWarp.enabled || state.paused) throw new Error("纯挂机保守会话要求已启用且未暂停的时间扭曲状态");
  if (state.speedrun?.enabled) throw new Error("速通工厂必须继续使用独立的精确时间规则");
  refreshTimeWarpPowerSnapshotInPlace(state);
  const conservationCheckpoint = capturePureIdleCombinedConservationCheckpoint(state);
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
  let contract: PureIdleAffineContract = {
    deltas: [],
    calibrationSeconds: PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS,
    calibrationWallSeconds: PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS / actualMultiplier,
  };
  let candidate = state;
  let measuredRate = cloneRate(emptyRate);
  let currentRate = cloneRate(emptyRate);
  const prefixSeconds = PURE_IDLE_MACRO_CONSERVATIVE_PREFIX_SECONDS;
  let researchLedger: ResearchMacroLedger = {
    unitsPerWindow: 0n,
    windowSeconds: prefixSeconds,
    observedUnits: 0n,
    inflowPerWindow: {},
  };
  let rocketLedger: PureIdleRocketMacroLedger | undefined;
  let rocketLedgerRejectionReason: string | undefined;
  let powerTailCertified = false;
  let powerTailRejectionReason: string | undefined;
  let powerTail: PureIdlePowerTailCertificate = {
    productiveMultiplier: actualMultiplier,
    fuelDebits: [],
    maximumSimulationSeconds: 0,
    storageDispatchDetected: false,
    rejectionReason: "30 秒供电校准尚未完成",
  };
  let constructionPowerCertificate: PureIdleConstructionPowerCertificate | undefined;
  let calibrationCheckpoint: PureIdleMacroSession["calibrationCheckpoint"];
  let prefixFailure: string | undefined;
  try {
    const calibrated = createPureIdleLightweightCalibration(
      state,
      prefixSeconds / actualMultiplier,
      {
        isolateConstructionAutomation: true,
        consumeState: options.consumeCalibrationState === true,
      },
    );
    if (!calibrated) throw new Error("30 秒轻量校准没有形成可用样本");
    contract = calibrated.contract;
    researchLedger = calibrated.researchLedger;
    rocketLedger = calibrated.rocketLedger;
    rocketLedgerRejectionReason = calibrated.rocketLedgerRejectionReason;
    powerTailCertified = calibrated.powerTailCertified;
    powerTailRejectionReason = calibrated.powerTailRejectionReason;
    powerTail = calibrated.powerTail;
    constructionPowerCertificate = calibrated.constructionPowerCertificate;
    refreshDysonGenerationSnapshot(calibrated.calibratedState);
    measuredRate = rateBetween(
      baseline,
      capturePureIdleTerminalSnapshot(calibrated.calibratedState),
      prefixSeconds,
    );
    currentRate = {
      ...emptyRate,
      whiteMatrixProduced: pureIdleContractProductionRate(contract, "universe_matrix"),
      rocketsLaunched: rocketLedger ? rocketLedger.launchedPerWindow / rocketLedger.calibrationSeconds : 0,
      structurePoints: rocketLedger ? rocketLedger.launchedPerWindow / rocketLedger.calibrationSeconds : 0,
    };
    if (options.consumeCalibrationState) {
      // The Worker request itself is already a structured clone of the
      // durable checkpoint. Keep only its calibrated form and account for the
      // exact prefix as elapsed wall time; the Worker waits for this boundary
      // before publishing the ready response.
      candidate = calibrated.calibratedState;
    } else {
      calibrationCheckpoint = {
        baseWallSeconds: 0,
        baseSimulationSeconds: 0,
        wallSeconds: prefixSeconds / actualMultiplier,
        simulationSeconds: prefixSeconds,
        candidate: calibrated.calibratedState,
      };
    }
  } catch (error) {
    if (options.consumeCalibrationState) throw error;
    // A failed calibration must not turn a recoverable fallback into a failed
    // settlement. Keep time-only behavior and expose the reason instead of
    // fabricating a rate from an incomplete sample.
    prefixFailure = error instanceof Error ? error.message : "30 秒轻量校准失败";
    candidate = state;
  }
  const productiveTail = !prefixFailure && powerTailCertified &&
    contract.deltas.length > 0 && contract.maximumSimulationSeconds !== 0;
  const steadyStateItemCount = Object.keys(contract.steadyStateFactorsByItem ?? {}).length;
  const terminalTailDescription = rocketLedger
    ? `火箭按 ${Object.keys(rocketLedger.launchesBySystemPerWindow).length} 个恒星系的稳定事件账本推进；太阳帆、出口和合同尾段冻结`
    : `${rocketLedgerRejectionReason ?? "火箭样本未形成闭合事件账本"}；戴森发射、太阳帆、出口和合同尾段冻结`;
  const degradedReason = prefixFailure
    ? `${reason}；30 秒轻量校准未完成：${prefixFailure}`
    : !powerTailCertified
      ? `${reason}；${powerTailRejectionReason ?? "燃料或储能供电没有形成闭合证书"}；普通生产、科研、火箭和建筑制造尾段全部冻结`
    : productiveTail
      ? steadyStateItemCount > 0
        ? `${reason}；已用 3 个 10 秒精确窗口为 ${steadyStateItemCount} 类物料建立闭合稳态供需证书；可持续产线不再受物流缓存波动误停，未获证明的缓存产线仍按真实边界停止；建筑制造只使用同电网 30 秒逐秒证明的持续可再生余电，未获联合物料/电力授权的中心尾段冻结；${terminalTailDescription}`
        : `${reason}；已用 3 个 10 秒精确窗口建立轻量外推；普通生产与科研按物料边界推进；建筑制造只使用同电网 30 秒逐秒证明的持续可再生余电，未获联合物料/电力授权的中心尾段冻结；${terminalTailDescription}`
      : `${reason}；已精确结算 ${prefixSeconds} 秒，但样本没有形成可持续普通生产合同，尾段仅推进时间`;
  return {
    mode,
    phase: "conservative",
    candidate,
    contract,
    researchLedger,
    researchRemainder: 0n,
    researchInflowRemainders: {},
    ...(rocketLedger ? { rocketLedger } : {}),
    rocketLaunchRemaindersBySystem: {},
    conservationCheckpoint,
    replicationRemainders: {},
    baseline,
    baselineResearch,
    calibrationRate: cloneRate(measuredRate),
    currentRate,
    settledWallSeconds: options.consumeCalibrationState && !prefixFailure
      ? prefixSeconds / actualMultiplier
      : 0,
    settledSimulationSeconds: options.consumeCalibrationState && !prefixFailure
      ? prefixSeconds
      : 0,
    contractVersion: productiveTail ? 1 : 0,
    validationCount: 0,
    validationFailures: prefixFailure ? 1 : 0,
    lastValidationDurationMs: 0,
    lastValidationDeviation: 1,
    lastValidationReason: `已切换保守宏观：${degradedReason}`,
    nextValidationAtWallSeconds: null,
    boundaryCorrections: 0,
    calibrationWindowsCompleted: prefixFailure ? 0 : 3,
    actualMultiplier,
    degradedReason,
    computationDurationMs: 0,
    conservativeOnly: true,
    conservativeIntegerRemainders: {},
    conservativeDecimalRemainders: {},
    conservativeRemainingSimulationSeconds: productiveTail
      ? contract.maximumSimulationSeconds ?? null
      : 0,
    powerTail,
    ...(constructionPowerCertificate ? { constructionPowerCertificate } : {}),
    powerRemainingSimulationSeconds: powerTailCertified
      ? powerTail.maximumSimulationSeconds
      : 0,
    powerBoundaryRecalibrations: 0,
    conservativeRemainingSimulationSecondsByItem: productiveTail
      ? { ...(contract.maximumSimulationSecondsByItem ?? {}) }
      : {},
    pendingConstructionSimulationSeconds: options.consumeCalibrationState && !prefixFailure
      ? powerTailCertified ? prefixSeconds : 0
      : 0,
    ...(calibrationCheckpoint ? { calibrationCheckpoint } : {}),
  };
}

/**
 * Build the opt-in snapshot session without running exact calibration or
 * scanning the entity/belt graph. All source data already exists in the
 * rolling production history maintained during ordinary play.
 */
export function createReplicationPureIdleMacroSession(state: GameState): PureIdleMacroSession {
  if (!state.timeWarp.enabled || state.paused) throw new Error("产率复制挂机要求已启用且未暂停的时间扭曲状态");
  if (state.speedrun?.enabled) throw new Error("速通工厂不能使用产率复制挂机");
  if (!isPureIdleReplicationUnlocked(state)) throw new Error("产率复制挂机需要五项无限科技总等级大于 200");
  const readiness = getPureIdleReplicationReadiness(state.productionHistory);
  if (!readiness.ok) throw new Error(readiness.reason);
  // FactoryGame evaluates the authoritative power allocation before it writes
  // the durable checkpoint. Rebuilding the simulation lookup here traversed a
  // 70+ MiB endgame factory a second time and left the overlay at “读取中” for
  // minutes. The checkpoint's effective multiplier is the locked session
  // multiplier, so this mode never needs another factory-wide power scan.
  const actualMultiplier = Math.max(1, getEffectiveSimulationMultiplier(state));
  const contract = readiness.contract;
  const total = (record: object): bigint =>
    (Object.values(record) as Array<bigint | undefined>)
      .reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
  const rate: PureIdleRateSnapshot = {
    dysonGenerationKw: 0,
    whiteMatrixProduced: pureIdleReplicationRatePerSecond(contract, contract.materialByItem.universe_matrix),
    rocketsLaunched: pureIdleReplicationRatePerSecond(contract, total(contract.rocketsBySystem)),
    sailsAbsorbed: pureIdleReplicationRatePerSecond(contract, total(contract.sailsBySystem)),
    structurePoints: pureIdleReplicationRatePerSecond(contract, total(contract.rocketsBySystem)),
    shellSails: pureIdleReplicationRatePerSecond(contract, total(contract.sailsBySystem)),
    sailsInOrbit: 0,
    activityDelivered: {},
  };
  const baseline = capturePureIdleTerminalSnapshot(state);
  return {
    mode: "replication",
    phase: "running",
    candidate: state,
    contract: {
      deltas: [],
      calibrationSeconds: contract.windowSeconds,
      calibrationWallSeconds: 0,
    },
    researchLedger: {
      unitsPerWindow: 0n,
      windowSeconds: contract.windowSeconds,
      observedUnits: 0n,
      inflowPerWindow: {},
    },
    researchRemainder: 0n,
    researchInflowRemainders: {},
    rocketLaunchRemaindersBySystem: {},
    replicationContract: contract,
    replicationRemainders: {},
    baseline,
    baselineResearch: captureResearchMacroStatus(state),
    calibrationRate: cloneRate(rate),
    currentRate: cloneRate(rate),
    settledWallSeconds: 0,
    settledSimulationSeconds: 0,
    contractVersion: 1,
    validationCount: 0,
    validationFailures: 0,
    lastValidationDurationMs: 0,
    lastValidationDeviation: 0,
    lastValidationReason: `已直接锁定最近 ${Math.floor(contract.windowSeconds)} 个模拟秒的正向统计产率；未执行额外校准`,
    nextValidationAtWallSeconds: null,
    boundaryCorrections: 0,
    calibrationWindowsCompleted: 0,
    actualMultiplier,
    computationDurationMs: 0,
    conservativeOnly: false,
    conservativeIntegerRemainders: {},
    conservativeDecimalRemainders: {},
    conservativeRemainingSimulationSeconds: null,
    powerTail: {
      productiveMultiplier: actualMultiplier,
      fuelDebits: [],
      maximumSimulationSeconds: null,
      storageDispatchDetected: false,
    },
    powerRemainingSimulationSeconds: null,
    powerBoundaryRecalibrations: 0,
    conservativeRemainingSimulationSecondsByItem: {},
    pendingConstructionSimulationSeconds: 0,
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
  if (mode === "replication") return createReplicationPureIdleMacroSession(state);
  if (options.forceConservativeReason) {
    return createConservativePureIdleMacroSession(state, mode, options.forceConservativeReason, options);
  }
  if (state.entities.length >= PURE_IDLE_MACRO_LIGHTWEIGHT_ENTITY_THRESHOLD ||
    state.belts.length >= PURE_IDLE_MACRO_LIGHTWEIGHT_BELT_THRESHOLD) {
    return createConservativePureIdleMacroSession(
      state,
      mode,
      `终局规模 ${state.entities.length.toLocaleString("zh-CN")} 实体 / ${state.belts.length.toLocaleString("zh-CN")} 线路，自动使用单影子轻量校准`,
      options,
    );
  }
  refreshTimeWarpPowerSnapshotInPlace(state);
  const conservationCheckpoint = capturePureIdleCombinedConservationCheckpoint(state);
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
    ...(calibrated.rocketLedger ? { rocketLedger: calibrated.rocketLedger } : {}),
    rocketLaunchRemaindersBySystem: {},
    conservationCheckpoint,
    replicationRemainders: {},
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
    conservativeIntegerRemainders: {},
    conservativeDecimalRemainders: {},
    conservativeRemainingSimulationSeconds: null,
    powerTail: calibrated.powerTail,
    constructionPowerCertificate: calibrated.constructionPowerCertificate,
    powerRemainingSimulationSeconds: calibrated.powerTail.maximumSimulationSeconds,
    powerBoundaryRecalibrations: 0,
    conservativeRemainingSimulationSecondsByItem: {},
    pendingConstructionSimulationSeconds: 0,
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
    if (next.rocketLedger) session.rocketLedger = next.rocketLedger;
    else delete session.rocketLedger;
    session.rocketLaunchRemaindersBySystem = {};
    session.powerTail = next.powerTail;
    session.powerRemainingSimulationSeconds = next.powerTail.maximumSimulationSeconds;
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
      session.constructionPowerCertificate = next.constructionPowerCertificate;
      session.contractVersion += 1;
      session.lastValidationReason = deviation >= 0.3
        ? "产线变化超过 30%，未来宏观合同已替换"
        : "产线变化超过 15%，未来宏观合同已校正";
    } else {
      // Even a low-drift validation advances to a new exact checkpoint. Keep
      // the ordinary material contract and its joint power proof from the
      // same 30-second sample; mixing either half across checkpoints would
      // leave construction permanently frozen or bind it to stale headroom.
      session.contract = next.contract;
      session.constructionPowerCertificate = next.constructionPowerCertificate;
      session.contractVersion += 1;
      session.lastValidationReason = "产线偏差低于 15%，合同与施工电力证书已同步刷新";
    }
    // Fractional carries belong to the exact affine rates that created them.
    // A refreshed contract must start a new remainder epoch; otherwise a
    // sub-item carry from the previous sample can leak into the first bucket
    // of the replacement contract.
    session.conservativeIntegerRemainders = {};
    session.conservativeDecimalRemainders = {};
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

function advanceClosedRocketDomainInPlace(
  session: PureIdleMacroSession,
  simulationSeconds: number,
): { launched: number; failure?: string } {
  const ledger = session.rocketLedger;
  if (!ledger || simulationSeconds <= 1e-9) return { launched: 0 };
  const result = advancePureIdleRocketMacroLedgerInPlace(
    session.candidate,
    ledger,
    simulationSeconds,
    session.rocketLaunchRemaindersBySystem,
  );
  if (result.failure) return { launched: 0, failure: result.failure };
  session.rocketLaunchRemaindersBySystem = result.remaindersBySystem;
  return { launched: result.launched };
}

function advanceReplicationSession(
  session: PureIdleMacroSession,
  targetWallSeconds: number,
  options: PureIdleMacroOperationOptions,
): PureIdleMacroSummary {
  const contract = session.replicationContract;
  if (!contract) throw new Error("产率复制会话缺少已锁定统计快照");
  if (!Number.isFinite(targetWallSeconds) || targetWallSeconds < session.settledWallSeconds) {
    throw new Error("产率复制目标墙钟时间无效或发生倒退");
  }
  throwIfMacroInterrupted(options);
  if (targetWallSeconds <= session.settledWallSeconds + 1e-9) return summarizePureIdleMacroSession(session);
  const startedAt = macroNow();
  const multiplier = session.actualMultiplier;
  const wallSeconds = targetWallSeconds - session.settledWallSeconds;
  const simulationSeconds = wallSeconds * multiplier;
  const application = advancePureIdleReplicationInPlace(
    session.candidate,
    contract,
    simulationSeconds,
    session.replicationRemainders,
  );
  throwIfMacroInterrupted(options);
  session.candidate.elapsedSeconds += simulationSeconds;
  // Do not let the first ordinary post-idle sample pretend it covered the
  // whole replicated interval. A future snapshot requires fresh normal-play
  // telemetry instead of recursively sampling copied output.
  session.candidate.historyRecordedAt = session.candidate.elapsedSeconds;
  session.settledWallSeconds = targetWallSeconds;
  session.settledSimulationSeconds += simulationSeconds;
  session.actualMultiplier = multiplier;
  session.phase = "running";
  session.lastValidationReason = `统计产率复制：终局材料 ${Object.keys(application.creditedMaterials).length} 类，科研 ${application.creditedResearch.toString()}，火箭 ${application.launchedRockets.toLocaleString("zh-CN")}，壳面帆 ${application.absorbedSails.toLocaleString("zh-CN")}`;
  session.computationDurationMs = Math.max(0, macroNow() - startedAt);
  return summarizePureIdleMacroSession(session);
}

export function advancePureIdleMacroSession(
  session: PureIdleMacroSession,
  targetWallSeconds: number,
  options: PureIdleMacroOperationOptions = {},
): PureIdleMacroSummary {
  throwIfMacroInterrupted(options);
  if (session.mode === "replication") {
    return advanceReplicationSession(session, targetWallSeconds, options);
  }
  if (session.phase === "failed") {
    throw new Error(session.degradedReason ?? "纯挂机候选已被最终物资守恒门禁拒绝");
  }
  if (!Number.isFinite(targetWallSeconds) || targetWallSeconds < session.settledWallSeconds) {
    throw new Error("纯挂机目标墙钟时间无效或发生倒退");
  }
  if (session.settledWallSeconds + 1e-9 < targetWallSeconds ||
    session.pendingConstructionSimulationSeconds > 1e-9) {
    const operationStartedAt = macroNow();
    // Live orchestration calls this at each 30-second boundary. A tab that
    // slept or reloaded can arrive with days of debt; applying one equivalent
    // affine window keeps recovery cost independent of wall-clock duration.
    let exactSimulationSeconds = 0;
    let isolatedConstructionPrefixSeconds = session.pendingConstructionSimulationSeconds;
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
            { isolateConstructionAutomation: true },
          );
          if (session.powerRemainingSimulationSeconds !== 0) {
            isolatedConstructionPrefixSeconds += exactSimulationSeconds;
            if (checkpoint.baseWallSeconds > 1e-9 || checkpoint.baseSimulationSeconds > 1e-9) {
              creditPureIdleConstructionQuantumReplay(session.conservationCheckpoint!, exactSimulationSeconds);
            }
          }
          macroWallSeconds = 0;
        } else {
          exactSimulationSeconds = Math.max(
            0,
            checkpointEndSimulationSeconds - session.settledSimulationSeconds,
          );
          if (session.settledWallSeconds > checkpoint.baseWallSeconds + 1e-9) {
            const exactWallSeconds = checkpointEndWallSeconds - session.settledWallSeconds;
            session.candidate = advanceExactSimulationWindow(
              session.candidate,
              exactSimulationSeconds,
              exactWallSeconds,
              { isolateConstructionAutomation: true },
            );
            if (session.powerRemainingSimulationSeconds !== 0) {
              isolatedConstructionPrefixSeconds += exactSimulationSeconds;
              if (checkpoint.baseWallSeconds > 1e-9 || checkpoint.baseSimulationSeconds > 1e-9) {
                creditPureIdleConstructionQuantumReplay(session.conservationCheckpoint!, exactSimulationSeconds);
              }
            }
          } else {
            session.candidate = checkpoint.candidate;
            isolatedConstructionPrefixSeconds = session.powerRemainingSimulationSeconds === 0
              ? 0
              : exactSimulationSeconds;
            if (isolatedConstructionPrefixSeconds > 1e-9 &&
              (checkpoint.baseWallSeconds > 1e-9 || checkpoint.baseSimulationSeconds > 1e-9)) {
              creditPureIdleConstructionQuantumReplay(
                session.conservationCheckpoint!,
                isolatedConstructionPrefixSeconds,
              );
            }
          }
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
    const powerCreditedMacroSimulationSeconds = session.powerRemainingSimulationSeconds === null
      ? macroSimulationSeconds
      : Math.min(macroSimulationSeconds, Math.max(0, session.powerRemainingSimulationSeconds));
    const conservativeMacroSimulationSeconds = session.conservativeOnly
      ? session.conservativeRemainingSimulationSeconds === null
        ? powerCreditedMacroSimulationSeconds
        : Math.min(powerCreditedMacroSimulationSeconds, Math.max(0, session.conservativeRemainingSimulationSeconds))
      : powerCreditedMacroSimulationSeconds;
    const conservativeSimulationSecondsByItem = session.conservativeOnly
      ? Object.fromEntries(Object.entries(session.conservativeRemainingSimulationSecondsByItem).map(([itemId, remaining]) => [
        itemId,
        Math.min(conservativeMacroSimulationSeconds, Math.max(0, remaining)),
      ]))
      : undefined;
    const conservativeResearchSimulationSeconds = session.conservativeOnly
      ? MATRIX_ITEM_IDS.reduce((seconds, itemId) => {
        const itemSeconds = conservativeSimulationSecondsByItem?.[itemId];
        return itemSeconds === undefined ? seconds : Math.min(seconds, itemSeconds);
      }, conservativeMacroSimulationSeconds)
      : powerCreditedMacroSimulationSeconds;
    const applied = macroWallSeconds <= 1e-9
      ? { ok: true as const, boundaryCorrections: 0 }
      : session.conservativeOnly
        ? session.contract.deltas.length > 0 && conservativeMacroSimulationSeconds > 1e-9
          ? applyPureIdleLightweightContractInPlace(
            session.candidate,
            session.contract,
            conservativeMacroSimulationSeconds,
            multiplier > 0 ? conservativeMacroSimulationSeconds / multiplier : 0,
            {
              skipUnsafeIntegerPaths: true,
              integerRemainders: session.conservativeIntegerRemainders,
              decimalRemainders: session.conservativeDecimalRemainders,
              simulationSecondsByItem: conservativeSimulationSecondsByItem,
            },
          )
          : { ok: true as const, boundaryCorrections: 0 }
        : applyPureIdleAffineContract(
          session.candidate,
          session.contract,
          powerCreditedMacroSimulationSeconds,
          multiplier > 0 ? powerCreditedMacroSimulationSeconds / multiplier : 0,
          {
            constructionCheckpoint: session.conservationCheckpoint!,
            constructionPowerCertificate: session.constructionPowerCertificate,
            integerRemainders: session.conservativeIntegerRemainders,
            decimalRemainders: session.conservativeDecimalRemainders,
          },
        );
    // A complex conservative session promises one bounded 30-second
    // calibration. Re-running that full graph at every finite fuel boundary
    // made a ten-minute idle request cost another minute of CPU. Its power
    // ledger already debits the proven prefix exactly; freeze the unproven tail
    // instead of silently starting more exact calibrations. Small generic
    // affine sessions retain their boundary rebuild behavior.
    const powerBoundaryReached = !session.conservativeOnly && applied.ok &&
      powerCreditedMacroSimulationSeconds + 1e-9 < macroSimulationSeconds &&
      session.powerBoundaryRecalibrations < PURE_IDLE_POWER_BOUNDARY_RECALIBRATION_LIMIT;
    const committedMacroSimulationSeconds = powerBoundaryReached
      ? powerCreditedMacroSimulationSeconds
      : macroSimulationSeconds;
    const deferredPowerBoundaryWallSeconds = powerBoundaryReached && multiplier > 0
      ? (macroSimulationSeconds - powerCreditedMacroSimulationSeconds) / multiplier
      : 0;
    throwIfMacroInterrupted(options);
    if (applied.ok &&
      !(applied.exactSimulationSeconds && applied.exactSimulationSeconds > 0)) {
      const fuelDebitFailure = applyPureIdlePowerTailFuelDebitInPlace(
        session.candidate,
        session.powerTail,
        powerCreditedMacroSimulationSeconds,
      );
      if (fuelDebitFailure) {
        session.phase = "failed";
        session.validationFailures += 1;
        session.degradedReason = `供电燃料宏观扣账失败：${fuelDebitFailure}`;
        session.lastValidationReason = session.degradedReason;
        throw new Error(session.degradedReason);
      }
    }
    if (!applied.ok) {
      // The last complete candidate remains intact because affine application
      // is transactional. Freeze uncertain factory and research subsystems,
      // advance time only, and keep the session recoverable.
      session.phase = "conservative";
      session.degradedReason = applied.failure ?? "宏观守恒桶未通过安全校验";
      session.lastValidationReason = `已切换保守宏观：${session.degradedReason}`;
      if (!session.conservativeOnly) session.validationFailures += 1;
      else {
        session.conservativeRemainingSimulationSeconds = 0;
        for (const itemId of Object.keys(session.conservativeRemainingSimulationSecondsByItem)) {
          session.conservativeRemainingSimulationSecondsByItem[itemId] = 0;
        }
      }
      session.candidate.elapsedSeconds += macroSimulationSeconds;
    } else {
      session.phase = session.conservativeOnly ? "conservative" : "running";
      if (!session.conservativeOnly) session.degradedReason = undefined;
      session.boundaryCorrections += applied.boundaryCorrections;
      // The compact conservative contract intentionally excludes elapsed time
      // (and all transient caches). Advance the high-multiplier clock exactly
      // once after its cumulative counters have been applied.
      if (session.conservativeOnly) {
        session.candidate.elapsedSeconds += committedMacroSimulationSeconds;
        if (session.conservativeRemainingSimulationSeconds !== null) {
          session.conservativeRemainingSimulationSeconds = Math.max(
            0,
            session.conservativeRemainingSimulationSeconds - conservativeMacroSimulationSeconds,
          );
        }
        let exhaustedItems = 0;
        for (const [itemId, creditedSeconds] of Object.entries(conservativeSimulationSecondsByItem ?? {})) {
          const beforeRemaining = session.conservativeRemainingSimulationSecondsByItem[itemId] ?? 0;
          const afterRemaining = Math.max(0, beforeRemaining - creditedSeconds);
          session.conservativeRemainingSimulationSecondsByItem[itemId] = afterRemaining;
          if (beforeRemaining > 1e-9 && afterRemaining <= 1e-9) exhaustedItems += 1;
        }
        const whiteMatrixStopped = (session.conservativeRemainingSimulationSecondsByItem.universe_matrix ?? 1) <= 1e-9;
        if (conservativeMacroSimulationSeconds + 1e-9 < macroSimulationSeconds || whiteMatrixStopped) {
          session.currentRate = {
            dysonGenerationKw: 0,
            whiteMatrixProduced: 0,
            rocketsLaunched: 0,
            sailsAbsorbed: 0,
            structurePoints: 0,
            shellSails: 0,
            sailsInOrbit: 0,
            activityDelivered: {},
          };
        }
        if (conservativeMacroSimulationSeconds + 1e-9 < macroSimulationSeconds) {
          session.lastValidationReason = "30 秒样本的全局安全边界已耗尽；剩余尾段只推进时间";
        } else if (exhaustedItems > 0) {
          session.lastValidationReason = `30 秒样本中 ${exhaustedItems} 类净消耗物料已到边界；相关物料停止外推，其他产线继续`;
        }
        const rocketSimulationSeconds = Math.min(
          conservativeMacroSimulationSeconds,
          Math.max(0, conservativeSimulationSecondsByItem?.small_carrier_rocket ?? conservativeMacroSimulationSeconds),
        );
        const rocketDomain = advanceClosedRocketDomainInPlace(session, rocketSimulationSeconds);
        if (rocketDomain.failure) {
          session.rocketLedger = undefined;
          session.boundaryCorrections += 1;
          session.lastValidationReason = `${rocketDomain.failure}；普通生产与科研合同继续生效`;
        } else if (rocketDomain.launched > 0) {
          const rate = rocketDomain.launched / Math.max(1e-9, rocketSimulationSeconds);
          session.currentRate = {
            ...session.currentRate,
            rocketsLaunched: rate,
            structurePoints: rate,
          };
        } else if (session.rocketLedger && rocketSimulationSeconds <= 1e-9) {
          session.currentRate = {
            ...session.currentRate,
            rocketsLaunched: 0,
            structurePoints: 0,
          };
        }
      } else if (!powerBoundaryReached &&
        powerCreditedMacroSimulationSeconds + 1e-9 < macroSimulationSeconds) {
        // Affine settlement and bounded construction replay advance only the
        // physically powered prefix. The rest of the requested
        // high-multiplier clock remains time-only.
        session.candidate.elapsedSeconds += macroSimulationSeconds - powerCreditedMacroSimulationSeconds;
      }
      if (session.powerRemainingSimulationSeconds !== null) {
        session.powerRemainingSimulationSeconds = Math.max(
          0,
          session.powerRemainingSimulationSeconds - powerCreditedMacroSimulationSeconds,
        );
      }
      if (!powerBoundaryReached &&
        powerCreditedMacroSimulationSeconds + 1e-9 < macroSimulationSeconds) {
        session.currentRate = {
          dysonGenerationKw: 0,
          whiteMatrixProduced: 0,
          rocketsLaunched: 0,
          sailsAbsorbed: 0,
          structurePoints: 0,
          shellSails: 0,
          sailsInOrbit: 0,
          activityDelivered: {},
        };
        session.lastValidationReason = "供电燃料或储能安全时长已耗尽；剩余尾段只推进时间";
      }
    }
    const macroResearchSeconds = session.conservativeOnly
      ? applied.ok ? conservativeResearchSimulationSeconds : 0
      : applied.ok
        ? Math.max(0, powerCreditedMacroSimulationSeconds - (applied.exactSimulationSeconds ?? 0))
        : 0;
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
    if (research.completedFiniteTechIds.length > 0 || research.completedInfiniteLevels.length > 0) {
      // Research can change production/power multipliers inside this same
      // bucket. The 30-second joint power proof predates that boundary, so
      // construction must wait for the next exact recalibration.
      delete session.constructionPowerCertificate;
    }
    throwIfMacroInterrupted(options);
    const constructionSeconds = isolatedConstructionPrefixSeconds +
      (applied.ok
        ? Math.max(0, powerCreditedMacroSimulationSeconds - (applied.exactSimulationSeconds ?? 0))
        : 0);
    const construction = advanceConstructionAutomationMacroWithReceiptInPlace(
      session.candidate,
      constructionSeconds,
      session.conservationCheckpoint!,
      {
        powerCertificate: session.constructionPowerCertificate,
        contract: session.contract,
      },
    );
    session.pendingConstructionSimulationSeconds = 0;
    if (construction.completed > 0) {
      const productionGuard = session.conservativeOnly
        ? Object.keys(session.contract.steadyStateFactorsByItem ?? {}).length > 0
          ? "普通产线继续按闭合稳态证书结算"
          : "普通产线仍受轻量物料边界保护"
        : "普通产线继续按已验证宏观合同结算";
      session.lastValidationReason = `建筑制造巨构按真实库存递归完成 ${construction.completed.toLocaleString("zh-CN")} 件；${productionGuard}`;
    }
    throwIfMacroInterrupted(options);
    if (research.completedFiniteTechIds.length > 0 || research.completedInfiniteLevels.length > 0) {
      session.lastValidationReason = `科研边界完成：有限科技 ${research.completedFiniteTechIds.length} 项，无限科技 ${research.completedInfiniteLevels.length} 级`;
    }
    const combinedConservationFailure = validatePureIdleCombinedSettlementConservation(
      session.conservationCheckpoint!,
      session.candidate,
    );
    if (combinedConservationFailure) {
      // The Worker remains an isolated speculative authority until it emits a
      // finalized envelope. Reject the entire candidate here; the main thread
      // retains its last acknowledged checkpoint and must rebuild the Worker.
      session.phase = "failed";
      session.validationFailures += 1;
      session.degradedReason = `最终物资守恒门禁拒绝候选：${combinedConservationFailure}`;
      session.lastValidationReason = session.degradedReason;
      throw new Error(session.degradedReason);
    }
    session.settledWallSeconds = powerBoundaryReached
      ? targetWallSeconds - deferredPowerBoundaryWallSeconds
      : targetWallSeconds;
    session.settledSimulationSeconds += exactSimulationSeconds + committedMacroSimulationSeconds;
    if (powerBoundaryReached && session.settledWallSeconds + 1e-9 < targetWallSeconds) {
      const recalibration = recalibrateAfterPowerBoundary(session, targetWallSeconds);
      if (recalibration === "productive" && session.settledWallSeconds + 1e-9 < targetWallSeconds) {
        return advancePureIdleMacroSession(session, targetWallSeconds, options);
      }
      const remainingWallSeconds = Math.max(0, targetWallSeconds - session.settledWallSeconds);
      if (remainingWallSeconds > 1e-9) {
        refreshTimeWarpPowerSnapshotInPlace(session.candidate);
        const fallbackMultiplier = Math.max(1, getEffectiveSimulationMultiplier(session.candidate));
        const timeOnlySimulationSeconds = remainingWallSeconds * fallbackMultiplier;
        if (recalibration === null && session.powerBoundaryRecalibrations <
          PURE_IDLE_POWER_BOUNDARY_RECALIBRATION_LIMIT) {
          const terminalBeforeExact = capturePureIdleTerminalSnapshot(session.candidate);
          session.candidate = advanceExactSimulationWindowWithConstructionReceipt(
            session.candidate,
            timeOnlySimulationSeconds,
            remainingWallSeconds,
            session.conservationCheckpoint!,
          );
          session.currentRate = rateBetween(
            terminalBeforeExact,
            capturePureIdleTerminalSnapshot(session.candidate),
            Math.max(1e-9, timeOnlySimulationSeconds),
          );
          session.lastValidationReason =
            "剩余墙钟不足以建立新的 30 秒宏观证书；已通过真实引擎精确推进到请求边界";
        } else {
          session.candidate.elapsedSeconds += timeOnlySimulationSeconds;
          session.currentRate = {
            dysonGenerationKw: 0,
            whiteMatrixProduced: 0,
            rocketsLaunched: 0,
            sailsAbsorbed: 0,
            structurePoints: 0,
            shellSails: 0,
            sailsInOrbit: 0,
            activityDelivered: {},
          };
          if (recalibration === null) {
            session.lastValidationReason =
              `供电边界重校准已达到 ${PURE_IDLE_POWER_BOUNDARY_RECALIBRATION_LIMIT} 次上限；剩余时间只推进时钟`;
          }
        }
        session.settledWallSeconds = targetWallSeconds;
        session.settledSimulationSeconds += timeOnlySimulationSeconds;
        session.actualMultiplier = fallbackMultiplier;
      }
    } else if (applied.exactSimulationSeconds && !session.conservativeOnly) {
      // A finite-resource or transport boundary changed the sustainable tail.
      // Recalibrate once from the exact committed state so future calls do not
      // repeatedly replay an already-crossed boundary.
      try {
        const recalibrated = calibrate(session.candidate);
        session.contract = recalibrated.contract;
        session.constructionPowerCertificate = recalibrated.constructionPowerCertificate;
        session.researchLedger = recalibrated.researchLedger;
        if (recalibrated.rocketLedger) session.rocketLedger = recalibrated.rocketLedger;
        else delete session.rocketLedger;
        session.rocketLaunchRemaindersBySystem = {};
        session.powerTail = recalibrated.powerTail;
        session.powerRemainingSimulationSeconds = recalibrated.powerTail.maximumSimulationSeconds;
        session.researchRemainder = 0n;
        session.researchInflowRemainders = {};
        session.conservativeIntegerRemainders = {};
        session.conservativeDecimalRemainders = {};
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
    const postBoundaryConservationFailure = validatePureIdleCombinedSettlementConservation(
      session.conservationCheckpoint!,
      session.candidate,
    );
    if (postBoundaryConservationFailure) {
      session.phase = "failed";
      session.validationFailures += 1;
      session.degradedReason = `供电边界处理后的最终物资守恒门禁失败：${postBoundaryConservationFailure}`;
      session.lastValidationReason = session.degradedReason;
      throw new Error(session.degradedReason);
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
  if (session.mode !== "replication") {
    const combinedConservationFailure = validatePureIdleCombinedSettlementConservation(
      session.conservationCheckpoint!,
      session.candidate,
    );
    if (combinedConservationFailure) {
      session.phase = "failed";
      session.validationFailures += 1;
      session.degradedReason = `最终物资守恒门禁拒绝候选：${combinedConservationFailure}`;
      session.lastValidationReason = session.degradedReason;
      throw new Error(session.degradedReason);
    }
  }
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
