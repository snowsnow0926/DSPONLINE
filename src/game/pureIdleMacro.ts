import {
  advanceConstructionAutomationMacroInPlace,
  getEffectiveSimulationMultiplier,
  refreshDysonGenerationSnapshot,
  refreshTimeWarpPowerSnapshotInPlace,
  setPaused,
  settleCompletedResearchBoundaries,
} from "./engine";
import { MATRIX_ITEM_IDS } from "./content";
import { finishIdleRun, settleIdleRun } from "./idleSettlement";
import {
  advanceExactSimulationWindow,
  advancePureIdleRocketMacroLedgerInPlace,
  applyPureIdleAffineContract,
  applyPureIdleLightweightContractInPlace,
  createPureIdleAffineCalibration,
  createPureIdleLightweightCalibration,
  type PureIdleAffineContract,
  type PureIdleRocketMacroLedger,
} from "./offlineApproximation";
import {
  advanceResearchMacroInPlace,
  captureResearchMacroStatus,
  type ResearchMacroLedger,
  type ResearchMacroStatus,
} from "./researchMacro";
import type { GameState, IdleSettlementState, ItemId } from "./types";

export const PURE_IDLE_MACRO_ALGORITHM_VERSION = "pure-idle-macro-v8-multisystem-rocket-ledger";
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
  rocketLedger?: PureIdleRocketMacroLedger;
  /** Per-system fractional launch carries keep bucket segmentation deterministic. */
  rocketLaunchRemaindersBySystem: Record<string, number>;
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
  /** Fractional carry for repeated compact integer counter buckets. */
  conservativeIntegerRemainders: Record<string, number>;
  /** Exact carry for repeated compact decimal inventory buckets. */
  conservativeDecimalRemainders: Record<string, bigint>;
  /** Remaining productive tail before the sampled input/output boundary. */
  conservativeRemainingSimulationSeconds: number | null;
  /** Per-item productive horizons for the lightweight sampled contract. */
  conservativeRemainingSimulationSecondsByItem: Record<string, number>;
  /**
   * Construction is intentionally isolated from the ordinary calibration
   * contract. A Worker-owned calibration can commit its exact ordinary
   * prefix immediately, while this counter preserves the historical ordering
   * by applying construction only at the next authoritative macro boundary.
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
  rocketLedger?: PureIdleRocketMacroLedger;
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
    ...(result.rocketLedger ? { rocketLedger: result.rocketLedger } : {}),
  };
}

/**
 * Quantum-fed construction centers have a deliberately stateful boundary:
 * every five seconds the engine may create a new per-center job or direct
 * material buffer.  The affine pure-idle contract cannot safely invent or
 * remove those map entries, so opt-in direct-feed sessions keep their tail on
 * the ordinary exact engine.  This is a correctness guard for the feature,
 * not a change to the default local-tray pure-idle path.
 */
function hasQuantumFedConstructionWork(state: GameState): boolean {
  if (state.constructionAutomation.quantumSourceEnabled !== true || !state.constructionAutomation.enabled) return false;
  if (!state.entities.some((entity) => entity.buildingId === "construction_center")) return false;
  if (Object.keys(state.constructionAutomation.jobs).length > 0 ||
    Object.keys(state.constructionAutomation.quantumMaterialBuffer ?? {}).length > 0) return true;
  return Object.entries(state.constructionAutomation.targetStock).some(([targetId, amount]) => {
    const target = Math.max(0, Math.floor(amount ?? 0));
    if (target < 1) return false;
    const current = Object.prototype.hasOwnProperty.call(state.portableFleet, targetId)
      ? Math.max(0, Math.floor(state.portableFleet[targetId as keyof typeof state.portableFleet] ?? 0))
      : Math.max(0, Math.floor(state.construction[targetId as keyof typeof state.construction] ?? 0));
    return target > current;
  });
}

const PURE_IDLE_QUANTUM_CONSTRUCTION_EXACT_CHUNK_SECONDS = 900;

function advanceQuantumConstructionExactWindow(
  source: GameState,
  simulationSeconds: number,
  wallSeconds: number,
  options: PureIdleMacroOperationOptions,
): GameState {
  let state = source;
  let remainingSimulation = Math.max(0, simulationSeconds);
  let remainingWall = Math.max(0, wallSeconds);
  while (remainingSimulation > 1e-9 || remainingWall > 1e-9) {
    throwIfMacroInterrupted(options);
    const fraction = remainingSimulation > PURE_IDLE_QUANTUM_CONSTRUCTION_EXACT_CHUNK_SECONDS
      ? PURE_IDLE_QUANTUM_CONSTRUCTION_EXACT_CHUNK_SECONDS / remainingSimulation
      : 1;
    const simulationChunk = remainingSimulation * fraction;
    const wallChunk = remainingWall * fraction;
    state = advanceExactSimulationWindow(state, simulationChunk, wallChunk);
    remainingSimulation = Math.max(0, remainingSimulation - simulationChunk);
    remainingWall = Math.max(0, remainingWall - wallChunk);
  }
  throwIfMacroInterrupted(options);
  return state;
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
    refreshDysonGenerationSnapshot(calibrated.calibratedState);
    measuredRate = rateBetween(
      baseline,
      capturePureIdleTerminalSnapshot(calibrated.calibratedState),
      prefixSeconds,
    );
    const extrapolatesWhiteMatrix = contract.deltas.some((delta) =>
      delta.path[0] === "totalProduced" && delta.path[1] === "universe_matrix");
    currentRate = {
      ...emptyRate,
      whiteMatrixProduced: extrapolatesWhiteMatrix ? measuredRate.whiteMatrixProduced : 0,
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
  const productiveTail = !prefixFailure && contract.deltas.length > 0 && contract.maximumSimulationSeconds !== 0;
  const terminalTailDescription = rocketLedger
    ? `火箭按 ${Object.keys(rocketLedger.launchesBySystemPerWindow).length} 个恒星系的稳定事件账本推进；太阳帆、出口和合同尾段冻结`
    : `${rocketLedgerRejectionReason ?? "火箭样本未形成闭合事件账本"}；戴森发射、太阳帆、出口和合同尾段冻结`;
  const degradedReason = prefixFailure
    ? `${reason}；30 秒轻量校准未完成：${prefixFailure}`
    : productiveTail
      ? `${reason}；已用 3 个 10 秒精确窗口建立轻量外推；普通生产与科研按物料边界推进，建筑制造巨构再按真实库存递归结算；${terminalTailDescription}`
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
    conservativeRemainingSimulationSecondsByItem: productiveTail
      ? { ...(contract.maximumSimulationSecondsByItem ?? {}) }
      : {},
    pendingConstructionSimulationSeconds: options.consumeCalibrationState && !prefixFailure
      ? prefixSeconds
      : 0,
    ...(calibrationCheckpoint ? { calibrationCheckpoint } : {}),
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

export function advancePureIdleMacroSession(
  session: PureIdleMacroSession,
  targetWallSeconds: number,
  options: PureIdleMacroOperationOptions = {},
): PureIdleMacroSummary {
  throwIfMacroInterrupted(options);
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
          );
          macroWallSeconds = 0;
        } else {
          exactSimulationSeconds = Math.max(
            0,
            checkpointEndSimulationSeconds - session.settledSimulationSeconds,
          );
          session.candidate = checkpoint.candidate;
          isolatedConstructionPrefixSeconds = exactSimulationSeconds;
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
    const conservativeMacroSimulationSeconds = session.conservativeOnly
      ? session.conservativeRemainingSimulationSeconds === null
        ? macroSimulationSeconds
        : Math.min(macroSimulationSeconds, Math.max(0, session.conservativeRemainingSimulationSeconds))
      : macroSimulationSeconds;
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
      : macroSimulationSeconds;
    let exactQuantumConstructionTail = false;
    const applied = macroWallSeconds <= 1e-9
      ? { ok: true as const, boundaryCorrections: 0 }
      : !session.conservativeOnly && hasQuantumFedConstructionWork(session.candidate)
        ? (() => {
          const terminalBeforeExact = capturePureIdleTerminalSnapshot(session.candidate);
          // Direct quantum delivery changes jobs and center-local buffers at
          // five-second boundaries. Replay this bounded tail through the
          // authoritative engine instead of extrapolating a stale job map.
          session.candidate = advanceQuantumConstructionExactWindow(
            session.candidate,
            macroSimulationSeconds,
            macroWallSeconds,
            options,
          );
          session.currentRate = rateBetween(
            terminalBeforeExact,
            capturePureIdleTerminalSnapshot(session.candidate),
            macroSimulationSeconds,
          );
          exactQuantumConstructionTail = true;
          return { ok: true as const, boundaryCorrections: 0 };
        })()
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
        : applyPureIdleAffineContract(session.candidate, session.contract, macroSimulationSeconds, macroWallSeconds);
    throwIfMacroInterrupted(options);
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
        session.candidate.elapsedSeconds += macroSimulationSeconds;
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
      }
    }
    const macroResearchSeconds = session.conservativeOnly
      ? applied.ok ? conservativeResearchSimulationSeconds : 0
      : exactQuantumConstructionTail
        ? 0
        : Math.max(0, macroSimulationSeconds - (applied.exactSimulationSeconds ?? 0));
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
    if (session.conservativeOnly) {
      const constructionSeconds = isolatedConstructionPrefixSeconds + macroSimulationSeconds;
      const construction = advanceConstructionAutomationMacroInPlace(session.candidate, constructionSeconds);
      session.pendingConstructionSimulationSeconds = 0;
      if (construction.completed > 0) {
        session.lastValidationReason = `建筑制造巨构按真实库存递归完成 ${construction.completed.toLocaleString("zh-CN")} 件；普通产线仍受轻量物料边界保护`;
      }
    }
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
