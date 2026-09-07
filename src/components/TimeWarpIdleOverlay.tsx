import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Gauge,
  HardDrive,
  Play,
  Rocket,
  ShieldCheck,
  Square,
  Sun,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { RecoveryDataExportButton } from "./RecoveryDataExportButton";
import { formatQuantityCompact, formatQuantityExact } from "../game/quantityFormat";
import type { PureIdleMacroSummary, PureIdleTerminalSnapshot } from "../game/pureIdleMacro";
import { projectPureIdleTerminalSnapshot } from "../game/pureIdlePresentation";
import type { PureIdleRecoveryRecord, PureIdleStopReason } from "../game/pureIdleRecovery";
import type { SaveGameResult } from "../game/storage";
import type { GameState } from "../game/types";
import type { TimeWarpComputeGovernorState, TimeWarpComputeLimits, TimeWarpThrottleReason } from "../game/timeWarpComputeGovernor";
import { formatPowerKw } from "../game/units";
import "../styles/time-warp-idle.css";

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return hours > 0 ? `${hours}小时 ${minutes}分 ${rest}秒` : `${minutes}分 ${rest}秒`;
}

function signedQuantity(value: number): string {
  const amount = Math.floor(Math.abs(value));
  return `${value >= 0 ? "+" : "-"}${formatQuantityCompact(amount)}`;
}

const THROTTLE_REASON_LABELS: Record<TimeWarpThrottleReason, string> = {
  "warming-up": "正在测量设备性能",
  "requested-limit": "已达到请求倍率",
  "power-limit": "受供电上限限制",
  "compute-limit": "受设备计算能力限制",
  "worker-slow": "Worker 单次计算过慢",
  backlog: "模拟积压，正在切换宏观计算",
  "approximation-active": "宏观近似推进中",
  "approximation-fallback": "本切片已安全回退精确计算",
  "worker-unavailable": "Worker 不可用",
};

function stateSnapshot(game: GameState): PureIdleTerminalSnapshot {
  return {
    dysonGenerationKw: Math.max(0, game.dysonSphere.generationKw) + Math.max(0, game.dysonSwarm.generationKw),
    whiteMatrixProduced: Math.max(0, Math.floor(game.totalProduced.universe_matrix ?? 0)),
    rocketsLaunched: Math.max(0, Math.floor(game.dysonSphere.totalRocketsLaunched)),
    sailsAbsorbed: Math.max(0, Math.floor(game.dysonSphere.totalSailsAbsorbed)),
    structurePoints: Math.max(0, Math.floor(game.dysonSphere.structurePoints)),
    shellSails: Math.max(0, Math.floor(game.dysonSphere.shellSails)),
    sailsInOrbit: Math.max(0, Math.floor(game.dysonSwarm.sailsInOrbit)),
    activityDelivered: Object.fromEntries(Object.entries(game.endgame.constructionActivity.personalDelivered)
      .map(([itemId, amount]) => [itemId, Math.max(0, Math.floor(amount ?? 0))])),
  };
}

function efficiencyLabel(value: number | null, conservativeOnly = false): string {
  if (value !== null) return `${Math.round(value * 100)}%`;
  return conservativeOnly ? "短窗口未测得" : "未运行";
}

function efficiencyTone(value: number | null): string {
  if (value === null) return "idle";
  if (value >= 0.9) return "healthy";
  if (value >= 0.6) return "limited";
  if (value > 0) return "critical";
  return "stopped";
}

const STOP_REASON_LABELS: Record<PureIdleStopReason, string> = {
  "user-stop-requested": "玩家请求停止",
  "background-grace-expired": "后台 5 分钟宽限结束",
  "worker-timeout": "Worker 计算超时",
  "worker-crash": "Worker 崩溃",
  "worker-error": "Worker 运行错误",
  "save-finalized": "主存档已验证提交",
  "user-cancelled": "玩家取消或放弃",
};

export function TimeWarpIdleOverlay({
  game,
  baselineGame,
  startedAt,
  saveFailure,
  workerActive,
  computeLimits,
  computeState,
  pendingSimulationSeconds,
  macroSummary,
  recovery,
  recoveryStatus,
  onStop,
  onCancelSettlement,
  continueAvailable,
  onRetryRecovery,
  onContinueNormally,
}: {
  game: GameState;
  baselineGame: GameState;
  startedAt: number | null;
  saveFailure: SaveGameResult | null;
  workerActive: boolean;
  computeLimits: TimeWarpComputeLimits;
  computeState: TimeWarpComputeGovernorState;
  pendingSimulationSeconds: number;
  macroSummary: PureIdleMacroSummary | null;
  recovery: PureIdleRecoveryRecord | null;
  recoveryStatus: string;
  onStop: () => Promise<void>;
  onCancelSettlement: () => Promise<void>;
  continueAvailable: boolean;
  onRetryRecovery: () => Promise<void>;
  onContinueNormally: () => Promise<void>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1_000) : 0;
  const uncommittedWallSeconds = Math.max(
    0,
    (recovery?.targetWallSeconds ?? elapsed) - (recovery?.summary?.settledWallSeconds ?? recovery?.settledWallSeconds ?? 0),
  );
  const fallback = useMemo(() => stateSnapshot(game), [game]);
  const persistentBaseline = useMemo(() => stateSnapshot(baselineGame), [baselineGame]);
  const projected = projectPureIdleTerminalSnapshot(macroSummary, fallback, elapsed);
  const baseline = macroSummary?.baseline ?? persistentBaseline;
  const calibrationPending = !macroSummary && !continueAvailable;
  const conservativeOnly = macroSummary?.conservativeOnly === true;
  const replication = macroSummary?.mode === "replication" || recovery?.mode === "replication";
  const modeLabel = replication ? "产率复制模式" : macroSummary?.mode === "extreme" ? "终局极限模式" : "宏观纯挂机";
  const phaseLabel = macroSummary
    ? replication ? "按既有统计产率复制中"
      : macroSummary.phase === "preparing-power" ? "正在准备供电快照"
      : macroSummary.phase === "calibrating" ? "正在执行有界精确校准"
        : macroSummary.phase === "conservative"
          ? macroSummary.conservativeOnly && macroSummary.validationFailures === 0
            ? "稳态宏观结算中"
            : "保守宏观结算中"
          : macroSummary.phase === "research-boundary" ? "正在处理科研边界"
            : macroSummary.phase === "validating" ? "正在后台校验"
              : macroSummary.phase === "finalizing" ? "正在结算并验证存档"
                : macroSummary.phase === "recovering" ? "正在恢复 Worker"
                  : macroSummary.phase === "failed" ? "正在等待安全恢复"
                    : "正常宏观结算中"
    : continueAvailable ? "源存档或恢复日志需要处理" : replication ? "正在读取既有滚动统计" : "正在执行 3 × 10 秒校准";
  const nextValidationSeconds = macroSummary?.nextValidationAtWallSeconds == null
    ? null
    : Math.max(0, macroSummary.nextValidationAtWallSeconds - elapsed);
  const activityRows = (macroSummary ? Object.entries(projected.activityDelivered) : [])
    .filter(([, amount]) => amount > 0)
    .map(([itemId, amount]) => ({ itemId, amount, delta: amount - (baseline.activityDelivered[itemId] ?? 0) }));
  const stop = async () => {
    if (stopping) {
      await onCancelSettlement();
      return;
    }
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  };
  const retryRecovery = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await onRetryRecovery();
    } finally {
      setStopping(false);
    }
  };
  const continueNormally = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await onContinueNormally();
    } finally {
      setStopping(false);
    }
  };
  return (
    <div className="time-warp-idle-overlay" role="dialog" aria-modal="true" aria-label="纯挂机">
      <div className="time-warp-idle-panel">
        <header>
          <div className="time-warp-idle-title"><i><Gauge size={22} /></i><span><small>时间扭曲装置 · {modeLabel}</small><strong>{phaseLabel}</strong></span></div>
          <span className="time-warp-idle-lock"><ShieldCheck size={15} />画布已冻结</span>
        </header>
        <p className="time-warp-idle-lead">{continueAvailable
          ? "当前恢复记录未通过安全校验，未结算候选不会覆盖主存档。"
          : replication
            ? "已锁定开始前最近 60 个模拟秒（不足时 30 秒）的真实终端事件；白矩阵只直传科研，火箭和壳面帆只直结戴森进度。不会向量子仓库、行星托盘、机器缓存或其他玩家库存生成物品；没有接收目标的通道直接停止。"
          : conservativeOnly
            ? macroSummary?.validationFailures
              ? "精确校准未能形成完整证书；系统仅提交已验证前缀，未获证明的尾段保持冻结，主存档不会被不完整候选覆盖。"
              : "终局大存档已通过 3 × 10 秒精确校准建立闭合稳态供需证书；可持续产线长期按高倍率结算，只有依赖一次性缓存或尚未建模的事件会安全停止。"
            : "每 30 秒执行一次有界宏观结算，有限与无限科研由独立整数账本处理。页面进入后台后保留 5 分钟高倍率宽限，超出部分自动切换普通离线结算。"}</p>

        <section className="time-warp-idle-metrics" aria-label="运行摘要">
          <div><Gauge size={17} /><span>实际倍率</span><strong>{macroSummary?.actualMultiplier ?? computeLimits.actualMultiplier}x</strong></div>
          <div><Zap size={17} /><span>请求 / 供电倍率</span><strong>{macroSummary?.requestedMultiplier ?? game.timeWarp.requestedMultiplier}x / {macroSummary?.powerLimitedMultiplier ?? computeLimits.powerLimitedMultiplier}x</strong></div>
          <div><Clock3 size={17} /><span>本次挂机</span><strong>{formatDuration(elapsed)}</strong></div>
          <div><Clock3 size={17} /><span>历史累计挂机</span><strong>{formatDuration(game.idleSettlement.totalIdleTime)}</strong><small>仅统计已验证提交的时间段</small></div>
          <div className={`efficiency-${efficiencyTone(macroSummary?.minimumEfficiency ?? null)}`}><Activity size={17} /><span>{replication ? "统计复制状态" : "关键产线最低效率"}</span><strong>{calibrationPending ? replication ? "读取中" : "校准中" : efficiencyLabel(macroSummary?.minimumEfficiency ?? null, conservativeOnly)}</strong><small>{macroSummary?.limitingReason ?? (replication ? "等待读取现有统计窗口" : conservativeOnly ? "仅显示可验证短窗口；不确定尾段已冻结" : "等待首个验证快照")}</small></div>
          <div><HardDrive size={17} /><span>保存与恢复</span><strong className={saveFailure ? "warning" : "ready"}>{saveFailure ? "需要处理" : "检查点正常"}</strong><small>{recoveryStatus}</small></div>
          <div><ShieldCheck size={17} /><span>{replication ? "统计快照" : "下次真实校验"}</span><strong>{replication ? "启动时锁定" : macroSummary?.mode === "extreme" ? "仅宏观结算" : nextValidationSeconds === null ? "校准后开始" : formatDuration(nextValidationSeconds)}</strong></div>
        </section>

        <section className="time-warp-idle-output" aria-label="终局产出">
          <header><span>终局产出</span><small>累计值与本次挂机增量</small></header>
          <div className="time-warp-terminal-grid">
            <article><Zap size={19} /><span>戴森总发电功率</span><strong>{formatPowerKw(projected.dysonGenerationKw)}</strong><small>{calibrationPending ? "首个验证快照生成中" : "已结算快照 · 30 秒更新"}</small></article>
            <article><Activity size={19} /><span>白矩阵累计上传</span><strong title={formatQuantityExact(projected.whiteMatrixProduced)}>{formatQuantityCompact(projected.whiteMatrixProduced)}</strong><small>{calibrationPending ? "首个验证快照生成中，校准完成后显示增量" : <>本次 {signedQuantity(projected.whiteMatrixProduced - baseline.whiteMatrixProduced)} · {formatQuantityCompact((macroSummary?.ratePerSimulationSecond.whiteMatrixProduced ?? 0) * (macroSummary?.actualMultiplier ?? 1) * 60)}/分钟</>}</small></article>
            <article><Rocket size={19} /><span>小型火箭实际发射</span><strong title={formatQuantityExact(projected.rocketsLaunched)}>{formatQuantityCompact(projected.rocketsLaunched)}</strong><small>{calibrationPending ? "校准完成后显示本次增量" : <>本次 {signedQuantity(projected.rocketsLaunched - baseline.rocketsLaunched)}</>}</small></article>
            <article><Sun size={19} /><span>太阳帆吸收</span><strong title={formatQuantityExact(projected.sailsAbsorbed)}>{formatQuantityCompact(projected.sailsAbsorbed)}</strong><small>{calibrationPending ? "校准完成后显示本次增量" : <>本次 {signedQuantity(projected.sailsAbsorbed - baseline.sailsAbsorbed)}</>}</small></article>
          </div>
          <div className="time-warp-terminal-secondary">
            <span>戴森结构点<strong>{formatQuantityCompact(projected.structurePoints)}</strong><small>{calibrationPending ? "校准后显示" : signedQuantity(projected.structurePoints - baseline.structurePoints)}</small></span>
            <span>当前壳面帆<strong>{formatQuantityCompact(projected.shellSails)}</strong><small>{calibrationPending ? "校准后显示" : signedQuantity(projected.shellSails - baseline.shellSails)}</small></span>
            <span>轨道太阳帆<strong>{formatQuantityCompact(projected.sailsInOrbit)}</strong><small>{calibrationPending ? "校准后显示" : signedQuantity(projected.sailsInOrbit - baseline.sailsInOrbit)}</small></span>
          </div>
          {macroSummary ? <div className="time-warp-activity-output" aria-label="科研结算">
            <strong>科研整数账本</strong>
            <span>{macroSummary.research.label}<b>{macroSummary.research.level !== undefined ? `Lv.${macroSummary.research.level}` : macroSummary.research.kind === "none" ? "待命" : `${((macroSummary.research.completionBasisPoints ?? 0) / 100).toFixed(1)}%`}</b><small>启动时：{macroSummary.baselineResearch.label}</small></span>
          </div> : null}
          {activityRows.length > 0 ? <div className="time-warp-activity-output"><strong>巨构活动实际交付</strong>{activityRows.map((row) => <span key={row.itemId}>{row.itemId}<b>{formatQuantityCompact(row.amount)}</b><small>{signedQuantity(row.delta)}</small></span>)}</div> : null}
        </section>

        {macroSummary?.terminalLines.length ? <section className="time-warp-limit-lines" aria-label="产线效率详情">
          <header><span>{replication ? "复制产线" : "产线效率"}</span><small>{replication ? "按启动时统计产率固定复制" : "按启动校准速率比较"}</small></header>
          {macroSummary.terminalLines.map((line) => <div key={line.id} className={`efficiency-${efficiencyTone(line.efficiency)}`}><span>{line.label}</span><strong>{efficiencyLabel(line.efficiency, conservativeOnly)}</strong><small>{line.reason}{conservativeOnly && line.efficiency === null ? "；不确定尾段已冻结" : ""} · {formatQuantityCompact(line.sustainableRatePerMinute)}/分钟</small></div>)}
        </section> : null}

        <details className="time-warp-idle-diagnostics">
          <summary>查看计算与恢复详情</summary>
          <section className="time-warp-idle-status">
            <div><span>请求倍率</span><strong>{macroSummary?.requestedMultiplier ?? game.timeWarp.requestedMultiplier}x</strong></div>
            <div><span>供电上限</span><strong>{macroSummary?.powerLimitedMultiplier ?? computeLimits.powerLimitedMultiplier}x</strong></div>
            <div><span>精确计算能力</span><strong>约 {computeLimits.computeLimitedMultiplier}x</strong></div>
            <div><span>宏观算法</span><strong>{macroSummary?.algorithmVersion ?? "等待初始化"}</strong></div>
            <div><span>已结算墙钟</span><strong>{macroSummary ? formatDuration(macroSummary.settledWallSeconds) : "等待校准"}</strong></div>
            <div><span>已结算模拟</span><strong>{macroSummary ? formatDuration(macroSummary.settledSimulationSeconds) : "等待校准"}</strong></div>
            <div><span>合同版本</span><strong>{macroSummary?.contractVersion ?? "等待校准"}</strong></div>
            <div><span>影子校验</span><strong>{macroSummary ? `${macroSummary.validationCount} 次 · 失败 ${macroSummary.validationFailures}` : "等待校准"}</strong></div>
            <div><span>边界修正</span><strong>{macroSummary?.boundaryCorrections ?? "等待校准"}</strong></div>
            {!macroSummary ? <><div><span>旧调度积压</span><strong>{pendingSimulationSeconds.toFixed(1)} 秒</strong></div><div><span>旧 Worker 状态</span><strong>{workerActive ? "可用" : "不可用"}</strong></div><div><span>旧调度原因</span><strong>{THROTTLE_REASON_LABELS[computeLimits.reason]}</strong></div><div><span>最近耗时</span><strong>{computeState.sampleCount > 0 ? `${Math.round(computeState.recentWorkerDurationMs)} ms` : "测量中"}</strong></div></> : null}
            {macroSummary?.lastValidationReason ? <div><span>最近校验</span><strong>{macroSummary.lastValidationReason}</strong></div> : null}
            {macroSummary?.degradedReason ? <div><span>降级原因</span><strong>{macroSummary.degradedReason}</strong></div> : null}
            {macroSummary ? <div><span>最近现实耗时</span><strong>{Math.round(macroSummary.computationDurationMs)} ms</strong></div> : null}
            {recovery ? <>
              <div><span>退出 / 恢复原因</span><strong>{recovery.stopReason ? STOP_REASON_LABELS[recovery.stopReason] : "正常运行"}</strong></div>
              <div><span>结算会话</span><strong title={recovery.settlementId}>{recovery.settlementId.slice(-12)}</strong></div>
              <div><span>检查点指纹</span><strong>{recovery.checkpointHash}</strong></div>
              <div><span>冻结结算边界</span><strong>{recovery.targetWallSeconds === undefined ? "未冻结" : formatDuration(recovery.targetWallSeconds)}</strong></div>
              <div><span>提交状态</span><strong>{recovery.committed ? "已验证提交" : "尚未提交"}</strong></div>
              <div><span>Worker 重启</span><strong>{recovery.workerRestartCount} / 2</strong></div>
            </> : null}
          </section>
        </details>

        <footer>
          {saveFailure ? <span className="time-warp-idle-warning" role="alert"><AlertTriangle size={15} />本地存档尚未成功写入，恢复日志仍保留。</span> : continueAvailable ? <span className="time-warp-idle-warning" role="alert"><AlertTriangle size={15} />放弃将不发放约 {formatDuration(uncommittedWallSeconds)} 的未结算收益。</span> : <span><CheckCircle2 size={15} />停止成功并确认主存档后才会清理恢复日志</span>}
          <div className="time-warp-idle-actions">
            {continueAvailable ? <>
              <button className="time-warp-idle-stop" type="button" aria-label="重试恢复纯挂机" disabled={stopping} onClick={() => void retryRecovery()}><ShieldCheck size={16} />{stopping ? "正在重试" : "重试恢复"}</button>
              <button className="time-warp-idle-continue" type="button" aria-label={`放弃约 ${formatDuration(uncommittedWallSeconds)} 未结算时间并继续普通模拟`} disabled={stopping} onClick={() => void continueNormally()}><Play size={16} />放弃未结算并继续</button>
            </> : <button className="time-warp-idle-stop" type="button" aria-label={stopping ? "取消结算并保留原存档" : "停止并结算纯挂机"} onClick={() => void stop()}>{stopping ? <X size={16} /> : <Square size={16} />}{stopping ? "取消并保留原档" : "停止并结算"}</button>}
          </div>
        </footer>
        <RecoveryDataExportButton
          checkpointState={recovery?.state ?? baselineGame}
          recovery={recovery}
          recoveryStatus={recoveryStatus}
        />
      </div>
    </div>
  );
}
